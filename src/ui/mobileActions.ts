/**
 * THE TOUCH PAD'S BUTTON SET, and where each button lands.
 *
 * DOM-free and React-free on purpose: `npm test` drives every function here, which is the
 * only way to hold the one property this module exists for —
 *
 * ⚠️ **THE BUTTON SET IS DERIVED FROM `ACTION_GAMES`, NEVER LISTED BY HAND.** The touch layer
 * used to carry a fixed four (intake, shoot, catalyst, throw) plus one slot a game could fill,
 * so every season that added a control added it for the keyboard and the pad and then silently
 * not for touch: BIOBUZZ shipped `bbPlace`, `bbPlaceNectar`, `bbRamp` and `bbPass` with no way
 * to press any of them on a phone, and its own HANDOFF recorded that as debt three times over.
 * `touchCoverageGaps(game)` is the answer: it names every action `ACTION_GAMES` says a game
 * uses that this pad can neither press nor reach another way, and `npm test` asserts it is
 * empty for every game. A season that adds an action now fails the suite until the action is
 * either given a button here or written into `TOUCH_OTHER_ACTIONS` with the reason.
 *
 * ── TWO QUESTIONS, ON TWO CLOCKS ──────────────────────────────────────────────────
 * **Does the button EXIST?** (`present`) Only if a press could ever change something for this
 * build with these assists — both fixed for the whole match, since assists are menu-only. So
 * a claw build has no THROW, and auto intake removes INTAKE: every sim reads the bit as
 * `cmd.intake || r.autoIntake`, so with the assist on the press is provably dead. That
 * REVERSES the 2026-09-21 ruling that an assisted button is ghosted, never hidden (tester
 * feedback 2026-09-23: "intake button shouldn't exist if I have auto intake on"). The worry
 * behind that ruling was a pad with nothing on it; a default DECODE phone now has the sticks
 * and PARK, which is every control on it that does anything.
 * **Can it act RIGHT NOW?** (`ready`, read off `TouchLive` at the 10 Hz HUD poll) If not, it is
 * drawn IDLE — ghosted, in the same place — never removed, because a button that appears and
 * vanishes mid-match moves under a thumb. Shooting with an empty hopper, placing with no FLOWER
 * in reach, anything during the countdown. It still sends its press, exactly as a keyboard
 * would; the sim ignores it.
 * ⚠️ `ready` reads only what changes on a HUMAN timescale. The sub-second cooldowns
 * (`fireReadyAt`, `catalystReadyAt`), BIOBUZZ's per-tick "shot lands" gate and a Chain dumper's
 * alignment are deliberately absent: at a 10 Hz poll they flicker the button while the driver
 * is lining the shot up, which is exactly when they would be looking at it.
 *
 * ── WHY POSITIONS ARE COMPUTED RATHER THAN STORED ─────────────────────────────
 * `GameSettings.mobileLayout` stores a centre per control as a fraction of the viewport, which
 * cannot be right in both orientations at once: the shipped default put SHOOT and INTAKE 0.16
 * apart in x, which is 130 px of a landscape phone (fine) and 60 px of a portrait one — closer
 * than the two buttons' radii, so they OVERLAPPED, and the same default put the DRIVE stick's
 * centre 49 px from the left edge with a 58 px radius, so in portrait it hung off the screen.
 *
 * So the pad ARRANGES ITSELF by default (`packTouchControls`), in px, against the live
 * viewport — two thumb columns that climb the left and right edges from the bottom corners,
 * skipping whatever a stored position already occupies. A stored position is honoured the
 * moment it differs from `DEFAULT_MOBILE_LAYOUT`, i.e. the moment the player has actually
 * dragged that control, so every customised layout keeps working exactly as it did.
 *
 * Only the controls that had a `MobileLayout` key before can be dragged. Giving every derived
 * action one would mean a new field in `src/types.ts` per action and a settings migration per
 * season, which is the coupling this file removes.
 */

import type { HudSnapshot } from '../game';
import type { GameId } from '../games/types';
import { GAME_IDS } from '../games/types';
import type { KeyAction } from '../input/bindings';
import { KEY_ACTIONS, actionUsedBy } from '../input/bindings';
import type { ArtifactColor, MobileLayout, MobilePos, RobotSpec } from '../types';
import { HOPPER_CAPACITY } from '../config';
import { DEFAULT_MOBILE_LAYOUT } from '../settings';
import { BB_TOUCH } from '../games/biobuzz/mobile';
import type { BiobuzzHud } from '../games/biobuzz/hudRobot';
import { CHAIN_TOUCH } from '../games/chain/mobile';

/** an action the pad HOLDS DOWN — one `VirtualInput` boolean, released on touch end. */
export type TouchHoldField =
  | 'intake'
  | 'fire'
  | 'catalyst'
  | 'fling'
  | 'bbPlaceNectar'
  | 'bbPlace'
  | 'bbNectar'
  | 'bbRamp'
  | 'bbPass'
  | 'driveMode';

/** an action the pad PULSES once per tap (`InputManager.pressVirtual`). Flip and park are
 *  edge-triggered on the manager rather than bits on the command, so they cannot be held. */
export type TouchTapField = 'flipFront' | 'park';

/** what the caller knows about the build: the SPEC and the ASSISTS. Every one of these is fixed
 *  for the match — a property of the robot the player assembled and of the menu, not the tick. */
export interface TouchBuild {
  spec: RobotSpec;
  /** the local robot's assists. One that does an action's whole job REMOVES its button. */
  autoIntake: boolean;
  autoFire: boolean;
  /** FLIP only reverses ROBOT-centric drive (`GameController.frameLogic`); field-centric
   *  translation is in the driver's frame already, so there it does nothing at all. */
  fieldCentric: boolean;
  /** Chain Reaction's drum and dumper only steer a held SHOOT onto the goal with aim assist on */
  aimAssist: boolean;
}

/** what a `present` predicate gets to ask about: the build, and which season it is in. */
export interface TouchCtx extends TouchBuild {
  game: GameId;
}

/**
 * What a `ready` predicate gets to ask about: the slice of the live HUD that decides whether a
 * press would do anything THIS moment. Plain data, built by `touchLiveOf`, so `npm test` can
 * hold every predicate against a synthetic one.
 */
export interface TouchLive {
  /** robots may act (auto, teleop, free drive) — `robotsEnabled`. Outside it every sim swaps
   *  the whole command for ZERO_CMD, so no HELD button does anything. */
  enabled: boolean;
  parked: boolean;
  /** the local robot's hopper, in hopper order. BIOBUZZ: `yellow` is POLLEN, `red`/`blue` NECTAR */
  held: readonly ArtifactColor[];
  /** the hopper's capacity for this build */
  cap: number;
  /** DECODE only fires from a launch zone; true for every other season */
  launchZoneOk: boolean;
  chain?: { carrying: boolean; ringAction: 'pickup' | 'place' | 'fling' | null };
  bb?: { flowerInReach: boolean; nectarOk: boolean };
}

export interface TouchButton {
  /** the `ACTION_GAMES` row this button reaches. It is the identity: `touchCoverageGaps`
   *  matches on it, and no two buttons may carry the same one. */
  action: KeyAction;
  /** HOLD (a command bit) or TAP (a one-shot pulse) */
  hold?: TouchHoldField;
  tap?: TouchTapField;
  /** drawn inside the circle, so at most eight characters */
  label: string;
  /** the full name, for the ARIA label — `KEY_LABELS`' wording in ControlsSection */
  aria: string;
  glyph: string;
  /** style class on `.mobile-btn` */
  cls: string;
  /** the one big button (at most one per game) */
  primary?: boolean;
  /** which thumb owns it: the column it is packed into when it has no stored position */
  side: 'left' | 'right';
  /** the `MobileLayout` key that positions it, for the controls that shipped with one. A
   *  button without one is packed automatically and cannot be dragged. */
  slot?: Exclude<keyof MobileLayout, 'scale'>;
  /** could a press EVER change something for this build with these assists? Absent means
   *  always. Fixed for the match, so a button never appears or vanishes mid-match. */
  present?(ctx: TouchCtx): boolean;
  /** would a press act RIGHT NOW? A button that answers no is drawn IDLE, never removed. A HELD
   *  button is also idle whenever robots are disabled (`touchReady`), so this only has to state
   *  its own condition. Absent means always. */
  ready?(live: TouchLive): boolean;
}

/** a season's touch table */
export interface GameTouch {
  /** its own buttons, in thumb order */
  buttons: readonly TouchButton[];
  /**
   * Does holding SHOOT do something AUTO FIRE does not, on this build? Where it does, auto fire
   * does not make the button redundant and it stays. Chain Reaction's drum and dumper, with aim
   * assist on, turn the chassis onto the goal only while the BUTTON is held (`chainAimAssist`);
   * auto fire only fires once the driver has lined it up. Absent means never.
   */
  manualFireCounts?(ctx: TouchCtx): boolean;
}

/**
 * The buttons every game gets. Order is thumb order — nearest the corner first — and SHOOT and
 * INTAKE stay at the front because they are the actions a driver presses most.
 */
export const SHARED_TOUCH_BUTTONS: readonly TouchButton[] = [
  {
    action: 'fire',
    hold: 'fire',
    label: 'SHOOT',
    aria: 'Shoot',
    glyph: '◎',
    cls: 'shoot',
    primary: true,
    side: 'right',
    slot: 'shoot',
    // every sim reads `cmd.fire || r.autoFire`, so under auto fire the press adds nothing —
    // unless this season's build does something with the button that auto fire does not
    present: (c) => !c.autoFire || (GAME_TOUCH[c.game].manualFireCounts?.(c) ?? false),
    ready: (l) => l.held.length > 0 && l.launchZoneOk,
  },
  {
    action: 'intake',
    hold: 'intake',
    label: 'INTAKE',
    aria: 'Intake',
    glyph: '▼',
    cls: 'intake',
    side: 'left',
    slot: 'intake',
    // `cmd.intake || r.autoIntake` in all three sims (2D and 3D), with no reverse or outtake
    present: (c) => !c.autoIntake,
    ready: (l) => l.held.length < l.cap,
  },
  {
    action: 'flipFront',
    tap: 'flipFront',
    label: 'FLIP',
    aria: 'Flip front',
    glyph: '↻',
    cls: 'flip',
    side: 'left',
    present: (c) => !c.fieldCentric,
  },
  {
    action: 'driveMode',
    hold: 'driveMode',
    label: 'WHEELS',
    aria: 'Swap wheel set',
    glyph: '⇄',
    cls: 'drivemode',
    side: 'left',
    // BUTTERFLY only — every other drivetrain ignores the bit (`src/sim/robot.ts`)
    present: (c) => c.spec.drivetrain === 'butterfly',
  },
  {
    action: 'park',
    tap: 'park',
    label: 'PARK',
    aria: 'Toggle park mode',
    glyph: '■',
    cls: 'park',
    side: 'left',
    // turning park ON waits for the robot to be able to move; turning it OFF always works
    ready: (l) => l.parked || l.enabled,
  },
];

/** the per-game tables, one per season. A new game is a compile error until it has a row. */
const GAME_TOUCH: Record<GameId, GameTouch> = {
  // DECODE's only actions are the shared ones — its artifacts are intaken and shot, and the
  // gate, basin and rail are field mechanisms the driver pushes with the chassis. Its turret
  // tracks on its own, so a held SHOOT never steers.
  decode: { buttons: [] },
  chain: CHAIN_TOUCH,
  biobuzz: BB_TOUCH,
};

/**
 * The actions this pad deliberately does NOT give a button, with the surface that reaches each
 * one instead. `touchCoverageGaps` reads it, so an entry here is a signed statement rather than
 * an omission.
 */
export const TOUCH_OTHER_ACTIONS: Readonly<Record<string, string>> = {
  // the two virtual sticks ARE these eight
  driveUp: 'drive stick',
  driveDown: 'drive stick',
  driveLeft: 'drive stick',
  driveRight: 'drive stick',
  tankRightUp: 'drive stick',
  tankRightDown: 'drive stick',
  rotateCCW: 'turn stick',
  rotateCW: 'turn stick',
  // both are already on-screen chrome on a coarse pointer: START MATCH is a button in the
  // pre-match overlay panel (`GameView`), RESET is one of the two top-left `.game-btn`s.
  start: 'pre-match overlay button',
  restart: 'RESET button',
  // the 3D view keys (`VIEW_ACTIONS`) move the camera, not the robot. The view toggle is the
  // 2D/3D chip on the touch overlay (`MobileControls`); the camera and its eye height are set in
  // Configure ▸ Graphics (Camera, Your height), which a finger reaches between matches.
  viewToggle: '2D / 3D chip',
  cameraCycle: 'Graphics ▸ Camera',
  eyeUp: 'Graphics ▸ Your height',
  eyeDown: 'Graphics ▸ Your height',
};

/** every button `game` could show, in thumb order — the shared ones interleaved with its own
 *  so the two columns stay ordered by how often a driver reaches for them. */
export function touchButtonsFor(game: GameId): TouchButton[] {
  const shared = SHARED_TOUCH_BUTTONS.filter((b) => actionUsedBy(b.action, game));
  const own = GAME_TOUCH[game].buttons;
  // the game's own mechanisms sit between SHOOT/INTAKE and the three utilities:
  // they are what the season is about, and PARK/FLIP/WHEELS are pressed a handful of times.
  const utility = new Set<KeyAction>(['flipFront', 'driveMode', 'park']);
  return [
    ...shared.filter((b) => !utility.has(b.action)),
    ...own,
    ...shared.filter((b) => utility.has(b.action)),
  ];
}

/** the buttons actually drawn for this build and these assists. `present` is the only filter:
 *  a button that cannot act YET is drawn idle (`touchReady`), never dropped. */
export function visibleTouchButtons(game: GameId, build: TouchBuild): TouchButton[] {
  const ctx: TouchCtx = { ...build, game };
  return touchButtonsFor(game).filter((b) => !b.present || b.present(ctx));
}

/** would a press on `b` act right now? A HELD button needs the robots enabled as well as its
 *  own condition; a TAP is handled by the controller, which decides for itself (PARK says). */
export function touchReady(b: TouchButton, live: TouchLive): boolean {
  if (b.hold !== undefined && !live.enabled) return false;
  return b.ready?.(live) ?? true;
}

/**
 * The `TouchLive` slice of one HUD snapshot. A season's own half is ABSENT for another season,
 * and every game predicate treats absent as "ready": a button wrongly drawn live costs a press
 * that does nothing, which is the state before this existed; one wrongly drawn idle tells the
 * driver a working control is broken.
 */
export function touchLiveOf(hud: HudSnapshot): TouchLive {
  const bb = hud.game === 'biobuzz' ? (hud.gameHud as BiobuzzHud | undefined) : undefined;
  return {
    // `canPark` IS `robotsEnabled` (`GameController.canPark`)
    enabled: hud.canPark,
    parked: hud.parked,
    held: hud.hopper,
    cap: hud.chain?.storage ?? bb?.robot?.cap ?? HOPPER_CAPACITY,
    // `inLaunchZone` is DECODE geometry; another season's robot is never "in" one
    launchZoneOk: hud.game === 'decode' ? hud.inLaunchZone : true,
    chain: hud.chain && { carrying: hud.chain.carrying, ringAction: hud.chain.ringAction },
    bb: bb && {
      flowerInReach: bb.robot?.flowerInReach ?? false,
      nectarOk: bb.field.nectarWhy[hud.alliance] === 'ok',
    },
  };
}

/**
 * ⚠️ THE ANTI-DRIFT CHECK. Every action `game` uses, that has neither a button nor an entry in
 * `TOUCH_OTHER_ACTIONS`. `npm test` asserts this is empty for every game in `GAME_IDS`.
 */
export function touchCoverageGaps(game: GameId): KeyAction[] {
  const covered = new Set<KeyAction>(touchButtonsFor(game).map((b) => b.action));
  return KEY_ACTIONS.filter(
    (a) => actionUsedBy(a, game) && !covered.has(a) && TOUCH_OTHER_ACTIONS[a] === undefined,
  );
}

/** every button declared anywhere, for the tests that check the table itself */
export function allTouchButtons(): TouchButton[] {
  return GAME_IDS.flatMap((g) => GAME_TOUCH[g].buttons).concat(SHARED_TOUCH_BUTTONS);
}

// ── GEOMETRY ─────────────────────────────────────────────────────────────────────────
// px at scale 1. The joystick pair is unchanged; the secondary button grew from 62 to 64 so
// that the smallest layout scale the settings allow (0.7) still leaves a 44 px target, which
// is the smallest a finger hits reliably.

export const TOUCH_JOY_R = 58;
export const TOUCH_JOY_MAX_RADIUS = 52;
export const TOUCH_BTN_PRIMARY = 82;
export const TOUCH_BTN_SECONDARY = 64;
/** breathing room between two controls, and between a control and the viewport edge */
const TOUCH_GAP = 8;
/**
 * WHAT THE TOP STRIP ALREADY OWNS, per side, measured on a phone-width viewport: the left is
 * the MENU/RESET stack with the sponsor mark under it and the event log below that; the right
 * is the status chip row (58 px). Two numbers rather than one because a landscape phone is
 * 360 px tall and the difference is a whole row of buttons.
 * The left stack was 102 px until the caps took a 36 px touch floor and a 12 px gap (design
 * review 18-16): 6 + 36 + 12 + 36 + 12 + 26 (the sponsor chip) = 128, plus the one gap. A
 * 360 px-tall landscape phone still fits three rows of secondary buttons under it.
 */
const TOUCH_TOP_RESERVE = { left: 136, right: 76 } as const;
/** the smallest circle a finger hits reliably — the floor the secondary button size is set by */
const TOUCH_MIN_TARGET = 44;
/** the score bar is bottom-CENTRE, so only the safe-area strip is owed at the two corners */
const TOUCH_BOTTOM_RESERVE = 8;
/** how far inboard the thumb columns may march before giving up. Four is what a 360 px-tall
 *  landscape phone needs for the widest build BIOBUZZ can assemble (ten buttons). */
const TOUCH_COLUMNS_MAX = 4;
/**
 * ⚠️ A THUMB'S SIDE IS THE OUTER 40% OF THE WIDTH, AND NOTHING FURTHER IN. Without this the
 * packer walked a portrait phone's columns to 214 px of 390 — the middle of the screen, over
 * the score bar, and the one place on a phone neither thumb reaches without regripping. It is
 * what makes the same code give a landscape phone four columns and a portrait one two.
 */
const TOUCH_SIDE_FRACTION = 0.4;

export interface Viewport {
  w: number;
  h: number;
}

/** a placed control: CENTRE in px, and the diameter of its circle */
export interface PlacedControl {
  x: number;
  y: number;
  size: number;
}

export interface PlacedTouchButton extends PlacedControl {
  button: TouchButton;
  /** is this the player's own stored position (draggable), or one this module chose? */
  stored: boolean;
}

export interface PackedTouchControls {
  drive: PlacedControl;
  turn: PlacedControl;
  buttons: PlacedTouchButton[];
}

const px = (p: MobilePos, vp: Viewport): { x: number; y: number } => ({ x: p.x * vp.w, y: p.y * vp.h });

/** has the player moved this control off the shipped default? That, and nothing else, is what
 *  turns a stored fraction back on — see the file header. */
function moved(layout: MobileLayout, key: Exclude<keyof MobileLayout, 'scale'>): boolean {
  const a = layout[key];
  const b = DEFAULT_MOBILE_LAYOUT[key];
  return a.x !== b.x || a.y !== b.y;
}

const overlaps = (a: PlacedControl, b: PlacedControl): boolean =>
  Math.hypot(a.x - b.x, a.y - b.y) < (a.size + b.size) / 2 + TOUCH_GAP;

/** keep the whole circle on screen, clear of the top strip */
function clampOn(c: PlacedControl, vp: Viewport): PlacedControl {
  const r = c.size / 2;
  return {
    size: c.size,
    x: Math.max(r + TOUCH_GAP, Math.min(vp.w - r - TOUCH_GAP, c.x)),
    y: Math.max(TOUCH_TOP_RESERVE.left + r, Math.min(vp.h - TOUCH_BOTTOM_RESERVE - r, c.y)),
  };
}

/**
 * The candidate centres for one thumb, in the order a thumb reaches them.
 *
 * ⚠️ ROW-MAJOR, BOTTOM ROW FIRST — outward column to inward within each row, then up a row.
 * Column-major was the first attempt and it is wrong in landscape, measured: a 360 px-tall
 * phone has the stick blocking the two lowest cells of the outer columns, so the FIRST button
 * placed — SHOOT, the one pressed most — climbed to the top-right corner of the screen, as far
 * from the driving thumb as the viewport allows. Filling each row before climbing puts it
 * beside the stick instead, which is where a thumb already is.
 */
function candidates(side: 'left' | 'right', size: number, vp: Viewport, stick: PlacedControl): PlacedControl[] {
  const r = size / 2;
  const pitch = size + TOUCH_GAP;
  const out: PlacedControl[] = [];
  const bottom = vp.h - TOUCH_BOTTOM_RESERVE - r;
  const top = TOUCH_TOP_RESERVE[side] + r;
  const cols = Math.max(2, Math.min(TOUCH_COLUMNS_MAX, Math.floor((vp.w * TOUCH_SIDE_FRACTION) / pitch)));
  for (let y = bottom; y >= top; y -= pitch) {
    for (let col = 0; col < cols; col++) {
      const off = r + TOUCH_GAP + col * pitch;
      const c = { x: side === 'right' ? vp.w - off : off, y, size };
      // the stick's own cells are the one place a button may never go: the base FLOATS to the
      // finger, so a button under it is pressed by the thumb that meant to drive.
      if (overlaps(c, stick)) continue;
      out.push(c);
    }
  }
  return out;
}

/**
 * The overflow column: the outer edge of a thumb's own side, from just under the top strip
 * downwards. `clampOn` pulls every slot onto the screen, so a viewport too short for a whole
 * step still yields one — the caller is never handed an empty list.
 */
function lastResortColumn(side: 'left' | 'right', size: number, vp: Viewport): PlacedControl[] {
  const x = side === 'left' ? 0 : vp.w;
  const step = size + TOUCH_GAP;
  const top = TOUCH_TOP_RESERVE.left + size / 2;
  const bottom = Math.max(top, vp.h - TOUCH_BOTTOM_RESERVE - size / 2);
  const out: PlacedControl[] = [];
  for (let y = top; y <= bottom; y += step) out.push(clampOn({ x, y, size }, vp));
  return out;
}

/**
 * Where every control goes, this frame. Pure: the same layout, viewport and button list give
 * the same answer, which is what makes the arrangement testable without a browser.
 */
export function packTouchControls(
  buttons: readonly TouchButton[],
  layout: MobileLayout,
  vp: Viewport,
): PackedTouchControls {
  const scale = layout.scale;
  const joy = TOUCH_JOY_R * 2 * scale;
  // the sticks: the stored fraction once dragged, otherwise the bottom corners, which is where
  // a thumb already is. Clamped either way — a landscape-tuned fraction put the default drive
  // base's left edge off a portrait screen.
  const corner = (side: 'left' | 'right'): PlacedControl => ({
    size: joy,
    x: side === 'left' ? joy / 2 + TOUCH_GAP : vp.w - joy / 2 - TOUCH_GAP,
    y: vp.h - TOUCH_BOTTOM_RESERVE - joy / 2,
  });
  const drive = clampOn(moved(layout, 'drive') ? { ...px(layout.drive, vp), size: joy } : corner('left'), vp);
  const turn = clampOn(moved(layout, 'turn') ? { ...px(layout.turn, vp), size: joy } : corner('right'), vp);

  /**
   * ⚠️ IN LANDSCAPE THE HUD IS IN THE GUTTERS, WHICH IS WHERE THE THUMBS ARE.
   *
   * `styles.css`'s `(orientation: landscape) and (pointer: coarse)` block moves the score bar
   * into the LEFT gutter as a vertical stack and the breakdown chips into the RIGHT one, both
   * centred on the height — the field is square, so those columns are the only spare room and
   * the chrome above and below it moves there. A button packed into the same cell sits on the
   * score, which is the one read-out a driver glances at without looking away from the robot.
   * Two obstacles, sized to those two blocks (a ~72 px stack and a 120 px chip column).
   */
  const gutters: PlacedControl[] =
    vp.w > vp.h
      ? [
          { x: TOUCH_GAP + 36, y: vp.h / 2, size: 150 },
          { x: vp.w - TOUCH_GAP - 60, y: vp.h / 2, size: 150 },
        ]
      : [];
  const taken: PlacedControl[] = [drive, turn, ...gutters];
  const out: PlacedTouchButton[] = [];
  const auto: TouchButton[] = [];

  // PASS 1 — everything the player has dragged keeps exactly where they put it, and becomes an
  // obstacle for pass 2. Doing it in this order is what stops an arranged button landing on a
  // placed one, whichever way round the two appear in the list.
  for (const b of buttons) {
    const size = (b.primary ? TOUCH_BTN_PRIMARY : TOUCH_BTN_SECONDARY) * scale;
    if (b.slot && moved(layout, b.slot)) {
      const p = clampOn({ ...px(layout[b.slot], vp), size }, vp);
      taken.push(p);
      out.push({ ...p, button: b, stored: true });
    } else {
      auto.push(b);
    }
  }

  // PASS 2 — the rest climb their own thumb's columns. A side with no room left falls back to
  // the other one before it gives up, so a short landscape phone stacks rather than drops: a
  // button that is not on screen is the bug this whole module exists to stop.
  // ⚠️ AND THEN IT SHRINKS, NEVER CENTRES (design review 18-21). With no free cell at full
  // size it tries again smaller, and with none at any size it goes down a thumb's outer edge —
  // still under the thumb. The old last resort was the middle of the screen, which on a field
  // is on top of the robot.
  for (const b of auto) {
    const full = (b.primary ? TOUCH_BTN_PRIMARY : TOUCH_BTN_SECONDARY) * scale;
    const other = b.side === 'left' ? 'right' : 'left';
    let p: PlacedControl | undefined;
    // ⚠️ 82 → 64 → 44, NOT 82 → 44. The ladder used to drop the primary straight to the floor,
    // so EVERY landscape viewport narrower than 675 px — an iPhone SE/8 class phone held
    // sideways is 667 — rendered SHOOT, the button pressed most, at 29% of its intended area
    // and as the SMALLEST circle on a pad whose secondaries were all 64. A 64 px cell fits
    // wherever a secondary fits, so the middle rung is the one that almost always lands.
    const sizes = [...new Set([TOUCH_BTN_PRIMARY * scale, TOUCH_BTN_SECONDARY * scale, TOUCH_MIN_TARGET])].filter(
      (s) => s <= full && s >= TOUCH_MIN_TARGET,
    );
    for (const size of sizes.length ? sizes : [full]) {
      const cands = [
        ...candidates(b.side, size, vp, b.side === 'left' ? drive : turn),
        ...candidates(other, size, vp, other === 'left' ? drive : turn),
      ];
      p = cands.find((c) => !taken.some((t) => overlaps(c, t)));
      if (p) break;
    }
    // ⚠️ THE LAST RESORT USED TO IGNORE `taken` ALTOGETHER and just step down the edge, so a
    // ten-button BIOBUZZ pad on a short landscape phone stacked its overflow straight through
    // the gutter score column and into the DRIVE base — and `.mobile-btn` sits ABOVE the touch
    // layer, so the thumb reaching to drive pressed PARK instead. Score every slot of its own
    // edge and then the other one, exactly as the candidate search falls back, and take the
    // cheapest. A STICK outranks every other obstacle by three orders of magnitude, because a
    // gutter chip merely sits under a button while a stick has its press STOLEN — and among
    // equals the first wins, so this stays a pure function. Each placement joins `taken`, which
    // is what stops the second and third overflow landing on the first.
    if (!p) {
      const size = Math.min(full, TOUCH_MIN_TARGET);
      const col = [...lastResortColumn(b.side, size, vp), ...lastResortColumn(other, size, vp)];
      const cost = (c: PlacedControl): number =>
        ([drive, turn].some((s) => overlaps(c, s)) ? 1e3 : 0) + taken.filter((t) => overlaps(c, t)).length;
      p = col.reduce((best, c) => (cost(c) < cost(best) ? c : best), col[0]);
    }
    taken.push(p);
    out.push({ ...p, button: b, stored: false });
  }

  // back into the caller's order, so the DOM order matches the declared thumb order
  const order = new Map(buttons.map((b, i) => [b.action, i]));
  out.sort((a, b) => (order.get(a.button.action) ?? 0) - (order.get(b.button.action) ?? 0));
  return { drive, turn, buttons: out };
}
