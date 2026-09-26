/** user-customizable control bindings: keyboard keys per action, gamepad
 * button indices per action, and which stick drives. Escape is reserved
 * (menu / cancel capture) and never bindable. */

import { GAME_IDS, type GameId } from '../games/types';
import { PAD_MENU_BUTTON } from './padNav';

export type KeyAction =
  | 'driveUp'
  | 'driveDown'
  | 'tankRightUp'
  | 'tankRightDown'
  | 'driveLeft'
  | 'driveRight'
  | 'rotateCCW'
  | 'rotateCW'
  | 'intake'
  | 'fire'
  | 'catalyst'
  | 'fling'
  | 'bbPlaceNectar'
  | 'bbPlace'
  | 'bbNectar'
  | 'bbRamp'
  | 'bbPass'
  | 'viewToggle'
  | 'cameraCycle'
  | 'eyeUp'
  | 'eyeDown'
  | 'driveMode'
  | 'flipFront'
  | 'park'
  | 'start'
  | 'restart';

/**
 * THE VIEW KEYS — keyboard only, and not in `PadAction`. They move the CAMERA, not the robot:
 * no `RobotCommand` bit, and the sim never reads them. `graphics/viewKey.ts` listens for them
 * and reads their binds through `setViewBindings`. They were hard-coded there (`t`, `c`, `i`,
 * `o`) and absent from Controls, and `c` also placed POLLEN, so one press did both (owner,
 * 2026-09-24). Only BIOBUZZ has a 3D view, so only BIOBUZZ uses them.
 */
export const VIEW_ACTIONS = ['viewToggle', 'cameraCycle', 'eyeUp', 'eyeDown'] as const;
export type ViewAction = (typeof VIEW_ACTIONS)[number];

export type PadAction =
  | 'fire'
  | 'intake'
  | 'catalyst'
  | 'fling'
  | 'bbPlaceNectar'
  | 'bbPlace'
  | 'bbNectar'
  | 'bbRamp'
  | 'bbPass'
  | 'driveMode'
  | 'flipFront'
  | 'park'
  | 'start'
  | 'restart';

/**
 * A COMBO: several standard-mapping buttons that must ALL be held to fire the action, the
 * way real drive-team code reads `gamepad.dpad_up && gamepad.right_trigger > 0.5`. Stored
 * CANONICAL — ascending, unique, `2..PAD_CHORD_MAX` long — so two combos compare by
 * `chordKey` and a label reads the same wherever it is printed. A single button is NOT a
 * one-long combo: it lives in `PadBindings.buttons`, exactly where it always has.
 */
export type PadChord = number[];

/** the most buttons one combo may hold. Three is what a hand can press together while the
 * other thumb keeps driving; a wider chord is a party trick, not a control. */
export const PAD_CHORD_MAX = 3;

/**
 * THE COMBO WAIT (`PadBindings.chordGraceMs`): how long a button that is also part of a combo
 * is held back before it fires on its own, so the second button of the combo has time to
 * land (`padChords.ts` rule 2). 80 ms is a comfortable margin for a thumb, not a measurement;
 * the slider bounds it because both ends are failures — under ~20 ms the lift fires a shot
 * again for anyone who presses slowly, and past 200 ms Shoot has visible lag for everyone
 * who bound RT into a combo.
 */
export const PAD_CHORD_GRACE_MS = 80;
export const PAD_CHORD_GRACE_MIN_MS = 20;
export const PAD_CHORD_GRACE_MAX_MS = 200;

export interface PadBindings {
  /** which stick translates the robot — the other stick's X axis turns */
  driveStick: 'left' | 'right';
  /** standard-mapping button indices per action */
  buttons: Record<PadAction, number[]>;
  /**
   * combos per action (see `PadChord`). SEPARATE from `buttons` on purpose, and not the
   * obvious `number[][]` in its place: a settings blob is persisted and account-synced
   * VERBATIM, so an older client reading `buttons` full of arrays would reject every pad
   * binding and, on its next save, write the defaults back over them. Kept apart, an older
   * client ignores this field and the singles keep working; only a combo is beyond it.
   */
  combos: Record<PadAction, PadChord[]>;
  /** radial stick deadzone, 0-0.4 (fraction of full travel ignored near center) */
  deadzone: number;
  /** sensitivity curve exponent applied to stick input past the deadzone: 1 =
   * linear, higher = softer/more precise near center, ramping to full at the
   * stick's edge (classic RC/gaming "expo" curve) */
  curve: number;
  /** analog trigger press threshold, 0.1-0.9 (LT/RT register as "held" past this) */
  triggerThreshold: number;
  /** the combo wait in ms, `PAD_CHORD_GRACE_MIN_MS..PAD_CHORD_GRACE_MAX_MS` (see the constant) */
  chordGraceMs: number;
  /**
   * THE IN-MATCH MENU BUTTON, and the two reasons it is a bare field rather than a thirteenth
   * `PadAction`. It is not an action: the sim never reads it, there is no `RobotCommand` bit for
   * it, and `ACTION_GAMES` is keyed on `KeyAction` with `PadAction` a strict subset — so adding
   * one would ripple a UI affordance through the command table. And it is a NEW SIBLING FIELD
   * for the reason `combos` is: an older client ignores it and keeps its old Esc-only exit.
   * Default `PAD_MENU_BUTTON` (15, D-RIGHT), the one index no default bind uses.
   */
  menuButton: number;
  /**
   * Is the pad allowed to drive the MENUS as well as the robot? On by default; the toggle
   * exists for a player who wants a connected pad to be the robot's and nothing else.
   * Validated like every other field, so an older blob without it reads as on.
   */
  navEnabled: boolean;
}

/**
 * ONE GAME'S OVERRIDE of the main map. An action PRESENT here is DESYNCED for that game —
 * its binds in that game are exactly what is written here, and main no longer reaches it.
 * An action ABSENT inherits main, which is the SYNCED state and the default for everything.
 * "Sync back" is the deletion of the entry, and nothing else.
 *
 * `padButtons` and `padCombos` are ONE UNIT: "the binds of Shoot on a pad in BIOBUZZ" is a
 * single thing a player desyncs or syncs, not two, so every writer here writes both and every
 * reader treats either one's presence as "this action is desynced". They are still two FIELDS
 * for the same reason `PadBindings` keeps them apart — see `PadBindings.combos`.
 *
 * Stick role, deadzone, curve, trigger threshold and the combo wait are deliberately NOT here.
 * They are how a player's hand works, not what a button means, and nobody wants a different
 * deadzone per season.
 *
 * ONLY AN OVERRIDABLE ACTION MAY APPEAR HERE (`actionOverridable` — Intake and Shoot today). A
 * SHARED control has one value everywhere, and a SEASON-ONLY action's main bind is already that
 * season's alone, so an override of either is a second store for one value. `mergePerGame`
 * migrates both kinds out of older blobs, and every reader below ignores them.
 */
export interface GameBindingOverride {
  keys?: Partial<Record<KeyAction, string[]>>;
  padButtons?: Partial<Record<PadAction, number[]>>;
  padCombos?: Partial<Record<PadAction, PadChord[]>>;
}

/**
 * THE MOST BINDS ONE ACTION MAY CARRY, per device — keys, or `padBinds` (singles and combos
 * together). The `+` slot could grow a list without bound before this existed, and the settings
 * blob is capped at 64 KB by the server: a player leaning on `+` could have written a blob the
 * account sync then rejected, silently, forever. Eight alternatives for one action is already
 * past anything a drive team uses.
 */
export const BIND_SLOTS_MAX = 8;

export interface ControlBindings {
  /** `KeyboardEvent.key.toLowerCase()` values per action */
  keys: Record<KeyAction, string[]>;
  pad: PadBindings;
  /**
   * PER-GAME OVERRIDES of the map above (see `GameBindingOverride`). A NEW SIBLING FIELD, never
   * a change to the shape of `keys` / `pad.buttons` / `pad.combos` — for exactly the reason
   * `pad.combos` is its own field: a settings blob is persisted and account-synced VERBATIM,
   * and the stable site runs older code against the same accounts. An older client ignores this
   * field entirely and keeps playing on the main map, which is the correct degradation.
   *
   * ABSENT on a blob that has never used the feature, and pruned back to absent when the last
   * override is synced away — so a player who never opens a game scope round-trips byte for
   * byte through the old shape.
   */
  perGame?: Partial<Record<GameId, GameBindingOverride>>;
}

// ---- WHICH GAMES USE WHICH ACTION -------------------------------------------------
// The table that makes a duplicate LEGAL. Two actions conflict only if some game uses BOTH, so
// `catalyst` (Chain Reaction) and `bbPlace` (BIOBUZZ) may share a key or a button in the main
// map — no game ever offers both, so nothing is ambiguous — while `fire`, which every game
// reads, still steals from whatever had its key.
//
// It is a plain table keyed by `GameId` rather than a `GameModule.ui` slot on purpose: it is
// DOM-free, the headless smoke can pin every row, and a game module would have to be imported
// by the input layer to ask. Each row below was checked against the SIM, not against intent —
// which `RobotCommand` bit that game's `step` actually reads:
//   catalyst → `src/games/chain/play.ts` (the claw's grab/place); no other game reads it
//   fling    → `src/games/chain/play.ts` (the catapult throw)
//   bbPlace / bbPlaceNectar → `src/games/biobuzz/play.ts` + `sim3d/elements3d.ts`
//   bbNectar → `src/games/biobuzz/play.ts` (`bbHumanPlayerTick`, shared by the 2D and 3D paths)
//   bbRamp → `src/games/biobuzz/robot.ts` (the `ramp` intake archetype only)
//   intake / fire → all three, through three unrelated sites each
//   driveMode → `src/sim/robot.ts`, which every game's step routes through (`updateRobot`)
//   the drive/rotate/tank actions → every game, through `updateRobot`
// `PadAction` is a strict subset of `KeyAction`, so one table answers for both devices.

const ALL: readonly GameId[] = GAME_IDS;

export const ACTION_GAMES: Readonly<Record<KeyAction, readonly GameId[]>> = {
  driveUp: ALL,
  driveDown: ALL,
  tankRightUp: ALL,
  tankRightDown: ALL,
  driveLeft: ALL,
  driveRight: ALL,
  rotateCCW: ALL,
  rotateCW: ALL,
  intake: ALL,
  fire: ALL,
  catalyst: ['chain'],
  fling: ['chain'],
  bbPlaceNectar: ['biobuzz'],
  bbPlace: ['biobuzz'],
  bbNectar: ['biobuzz'],
  bbRamp: ['biobuzz'],
  bbPass: ['biobuzz'],
  viewToggle: ['biobuzz'],
  cameraCycle: ['biobuzz'],
  eyeUp: ['biobuzz'],
  eyeDown: ['biobuzz'],
  driveMode: ALL,
  flipFront: ALL,
  park: ALL,
  start: ALL,
  restart: ALL,
};

/** does `game` use `action` at all? An action it does not use can never fire in it. */
export function actionUsedBy(action: KeyAction, game: GameId): boolean {
  return ACTION_GAMES[action].includes(game);
}

/** the keyboard actions `game` uses, in `KEY_ACTIONS` order */
export function keyActionsFor(game: GameId): KeyAction[] {
  return KEY_ACTIONS.filter((a) => actionUsedBy(a, game));
}

/** the pad actions `game` uses, in `PAD_ACTIONS` order */
export function padActionsFor(game: GameId): PadAction[] {
  return PAD_ACTIONS.filter((a) => actionUsedBy(a, game));
}

/**
 * DO TWO ACTIONS CONFLICT? Only if some game uses both — which is the whole feature. An action
 * always conflicts with itself (every action belongs to at least one game), which is what lets
 * the assign helpers use this as their one filter.
 */
export function actionsConflict(a: KeyAction, b: KeyAction): boolean {
  return ACTION_GAMES[a].some((g) => actionUsedBy(b, g));
}

// ---- WHAT A SEASON SCOPE MAY CHANGE ------------------------------------------------
// Every action is exactly one of three kinds, and the kind decides where its binds are
// stored and which scope of the Controls screen shows it:
//
//   SHARED       how the robot is DRIVEN and how a MATCH is run. Main only, All games only.
//   SEASON-ONLY  an action exactly one game uses (Catalyst, Place POLLEN…). Main only — main's
//                bind for it already reaches that one game and no other — shown and edited
//                in that season's scope alone.
//   OVERRIDABLE  a mechanism more than one game has (Intake, Shoot). Main is the bind every
//                season starts from (All games); a season may override it (`perGame`).
//
// ⚠️ THIS WAS NOT ALWAYS THE MODEL. `perGame` used to take an override for ANY action a game
// used, so every season scope listed the eight drive keys, the stick sliders and the match
// keys a second time, each with a SYNCED marker and a disabled Sync button (owner,
// 2026-09-22: "Shared settings like drivetrain controls SHOULD BE only shown on global").
// And a season-only action had TWO stores for the one bind it has — main and the override —
// with nothing to tell a player which one they were editing. `mergePerGame` migrates both
// away on load; see the notes there for what that costs and why it is safe.

/**
 * THE SHARED CONTROLS. Every game reads each of these (`ACTION_GAMES` says ALL, and `npm test`
 * holds it to that) and they mean the same thing in every game — the drive keys, the wheel-set
 * swap, flip front, park, start and restart. `park` belongs here because park mode is a SPEED
 * CAP on the drive command (`GameController`, `parkSpeedPct`), a drivetrain control whatever
 * endgame it is used for.
 */
export const SHARED_ACTIONS: readonly KeyAction[] = [
  'driveUp',
  'driveDown',
  'tankRightUp',
  'tankRightDown',
  'driveLeft',
  'driveRight',
  'rotateCCW',
  'rotateCW',
  'driveMode',
  'flipFront',
  'park',
  'start',
  'restart',
];
const SHARED: ReadonlySet<KeyAction> = new Set(SHARED_ACTIONS);

/** is `a` a shared control (the same in every season, never overridden)? */
export function actionIsShared(a: KeyAction): boolean {
  return SHARED.has(a);
}

/** is `a` used by exactly one game? Its main bind is then that game's bind, and nothing else's. */
export function actionIsSeasonOnly(a: KeyAction): boolean {
  return !SHARED.has(a) && ACTION_GAMES[a].length === 1;
}

/** may a season override `a`? Only a mechanism more than one game has — Intake and Shoot today. */
export function actionOverridable(a: KeyAction): boolean {
  return !SHARED.has(a) && ACTION_GAMES[a].length > 1;
}

/** what a season's scope lists: every keyboard action `game` uses that is not shared */
export function seasonKeyActions(game: GameId): KeyAction[] {
  return keyActionsFor(game).filter((a) => !SHARED.has(a));
}

/** the pad twin of `seasonKeyActions` */
export function seasonPadActions(game: GameId): PadAction[] {
  return padActionsFor(game).filter((a) => !SHARED.has(a));
}

export const KEY_ACTIONS: KeyAction[] = [
  'driveUp',
  'driveDown',
  'tankRightUp',
  'tankRightDown',
  'driveLeft',
  'driveRight',
  'rotateCCW',
  'rotateCW',
  'intake',
  'fire',
  'catalyst',
  'fling',
  'bbPlaceNectar',
  'bbPlace',
  'bbNectar',
  'bbRamp',
  'bbPass',
  'viewToggle',
  'cameraCycle',
  'eyeUp',
  'eyeDown',
  'driveMode',
  'flipFront',
  'park',
  'start',
  'restart',
];

export const PAD_ACTIONS: PadAction[] = [
  'fire',
  'intake',
  'catalyst',
  'fling',
  'bbPlaceNectar',
  'bbPlace',
  'bbNectar',
  'bbRamp',
  'bbPass',
  'driveMode',
  'flipFront',
  'park',
  'start',
  'restart',
];

const NO_COMBOS = (): Record<PadAction, PadChord[]> => {
  const out = {} as Record<PadAction, PadChord[]>;
  for (const a of PAD_ACTIONS) out[a] = [];
  return out;
};

export const DEFAULT_BINDINGS: ControlBindings = {
  keys: {
    driveUp: ['w'],
    driveDown: ['s'],
    // TANK steers as two sides: `driveUp`/`driveDown` are the LEFT track and these are the
    // RIGHT one. They exist as actions because the right side used to read `arrowup`/
    // `arrowdown` straight off the keyboard — the one pair of controls in the game that
    // ignored the rebinder, so reassigning the arrows left them driving half the chassis AND
    // firing whatever they had been moved to. The defaults are the keys that were hard-coded.
    tankRightUp: ['arrowup'],
    tankRightDown: ['arrowdown'],
    driveLeft: ['a'],
    driveRight: ['d'],
    rotateCCW: ['arrowleft', 'q'],
    rotateCW: ['arrowright', 'e'],
    intake: ['shift', 'k'],
    fire: [' '],
    /**
     * ⚠️ **THE MECHANISM KEYS ARE SHARED ACROSS GAMES, BY ROLE, AND THAT IS THE POINT.**
     * (Owner, 2026-09-22: "the default keybind should have duplicates across games ... we
     * can't have the default keybind not have duplicates. That is unrealistic and unhelpful
     * and we will run out.")
     *
     * `actionsConflict` has always permitted this — two actions collide only if some game uses
     * BOTH, and no session ever offers Chain Reaction's claw alongside BIOBUZZ's Box Tube —
     * and the steal policy's own comment names `catalyst`/`bbPlace` as the example. The
     * defaults simply never used the capability, so every new season had to find another free
     * key and BIOBUZZ ended up on x/z/n/l/t while c and v sat idle in it. That does not scale,
     * and it put the two games' equivalent controls under different fingers for no reason.
     *
     * So a key means a ROLE, and each game fills it:
     *
     *     c   the primary manipulator: PLACE into the structure in reach
     *         chain `catalyst` (claw grab/place) . biobuzz `bbPlace` (pollen into the flower)
     *     v   send it AWAY at range
     *         chain `fling` (catapult throw)     . biobuzz `bbPass` (pass to a partner)
     *     x   biobuzz's SECOND place — nectar, which Chain Reaction has no equivalent of
     *     z   biobuzz `bbRamp`
     *
     * A player who drives both seasons learns one hand. `fire` and `intake` are in every game
     * and still steal from everything, which is unchanged.
     */
    /* ⚠️ THE ORDER OF THESE ENTRIES IS `KEY_ACTIONS` ORDER, NOT READING ORDER, and it is
       load-bearing: `cloneBindings`/`mergeBindings` rebuild the map by iterating `KEY_ACTIONS`,
       and three checks compare the result to this literal with `JSON.stringify` — which is
       order-sensitive. Grouping the shared pairs together here (nicer to read) broke all three.
       The role table above is where the pairing is documented; this list stays canonical. */
    catalyst: ['c'],
    fling: ['v'],
    // BIOBUZZ Box Tube: place a held NECTAR into the FLOWER in reach. Its own key because
    // BIOBUZZ is the one game with TWO place targets; 'x' keeps it adjacent to 'c'.
    bbPlaceNectar: ['x'],
    // ...and POLLEN into the flower shares 'c' with Chain Reaction's claw — both games'
    // primary "place into the structure in reach". See the role table above.
    bbPlace: ['c'],
    // BIOBUZZ HUMAN PLAYER: enter one NECTAR into the alliance's own LOADING ZONE. 'n' for
    // nectar, and deliberately NOT on the c/v/b/x/z mechanism row: this is the one button that
    // does something to the ALLIANCE rather than to the robot, and it is pressed at a cue
    // rather than in the drive rhythm, so it sits away from the cluster a thumb sweeps.
    bbNectar: ['n'],
    // BIOBUZZ, the `ramp` intake: drop / fold the deployable ramp. On 'z' with the mechanism
    // cluster now that sharing c and v freed the row up, not the old 'l' out on its own.
    // NOT 'g', 'h', 'j' or 'y': every one of those is a stock "assumed free key" fixture the
    // bindings smoke lane reuses across independent tests, and a real default there makes an
    // unrelated conflict test grow a stray per-game override.
    bbRamp: ['z'],
    // BIOBUZZ: PASS to your partner — launch the held element at a field POINT rather than at
    // your own hive. Shares 'v' with Chain Reaction's catapult throw; see the role table above.
    bbPass: ['v'],
    // THE VIEW KEYS (`VIEW_ACTIONS`). T flips 2D and 3D, and I / O raise and lower the eye —
    // the keys they always had. The CAMERA moved off C, which is Place POLLEN, onto L: next to
    // I and O, and free in every game. Not U: the bindings smoke lane uses it as a free key.
    viewToggle: ['t'],
    cameraCycle: ['l'],
    eyeUp: ['i'],
    eyeDown: ['o'],
    // BUTTERFLY: drop the other wheel set. 'b' for butterfly; free on the default map.
    driveMode: ['b'],
    flipFront: ['f'],
    park: ['p'],
    start: ['enter'],
    restart: ['r'],
  },
  pad: {
    driveStick: 'left',
    buttons: {
      fire: [7, 0], // RT or A
      intake: [6, 1], // LT or B
      /**
       * ⚠️ **THE SAME ROLE-SHARING THE KEYBOARD DOES, AND ON THE PAD IT FIXES A REAL HOLE.**
       * `bbPass` used to ship **completely unbound** here, with a comment explaining that the
       * standard mapping's 0..15 were all spoken for — while `catalyst` (Chain Reaction only)
       * held LB and `fling` (Chain Reaction only) held L3, two buttons BIOBUZZ never reads.
       * There was no shortage of buttons; the defaults were just refusing to reuse one.
       *
       *     LB (4)   place into the structure: chain `catalyst` . biobuzz `bbPlace`
       *     L3 (10)  send it away:            chain `fling`    . biobuzz `bbPass`
       *
       * That also retires the argument for a default COMBO, which was the other way to reach
       * `bbPass` and is worth NOT doing: `padChords.ts`'s fast path is "no combo bound => the
       * old any-button test, no state", so the first default combo moves EVERY player onto the
       * resolver's stateful path to give one season one button.
       *
       * RS (11) comes free as a result, and is LEFT free — the bindings lane uses it as an
       * "assumed unbound button" fixture in two independent tests.
       */
      /* PAD_ACTIONS ORDER, for the reason the keys list gives. */
      catalyst: [4], // LB
      fling: [10], // L3 (left stick click)
      // D-UP — place a NECTAR. The d-pad because placement is a MOMENTARY press, which can
      // afford to cost the drive thumb its stick.
      bbPlaceNectar: [12],
      bbPlace: [4], // LB — shared with `catalyst`; no game offers both
      // D-LEFT. Its own direction, one step from the two other d-pad actions: two actions on
      // one index is a silent double-fire, not a conflict the rebinder reports.
      bbNectar: [14],
      // D-DOWN — drop / fold the deployable ramp. Also momentary, so the same trade.
      bbRamp: [13],
      bbPass: [10], // L3 — shared with `fling`
      driveMode: [5], // RB — the only unused face/shoulder button
      flipFront: [3], // Y
      park: [2], // X
      start: [9],
      restart: [8], // Back / Select / View
    },
    // NO DEFAULT COMBO. The pad has sixteen buttons and twelve actions, so the default map
    // fits without one; combos are for the player who has run out, or who wants the layout
    // their real drive-team code uses.
    combos: NO_COMBOS(),
    deadzone: 0.12,
    curve: 1,
    triggerThreshold: 0.35,
    chordGraceMs: PAD_CHORD_GRACE_MS,
    menuButton: PAD_MENU_BUTTON,
    navEnabled: true,
  },
};

/**
 * WHERE A NEW ACTION GOES WHEN ITS DEFAULT KEY IS TAKEN in a stored map (`mergeBindings`), tried
 * in order. An action not listed here loads UNBOUND in that case, which is right for a view key
 * (the camera still works on its own) and wrong for a mechanism: an unbound Deploy ramp is a
 * part of the robot the player cannot use, with nothing on screen saying why. G sits by the
 * mechanism row, and no BIOBUZZ action has ever defaulted to it.
 */
const FRESH_FALLBACK_KEYS: Partial<Record<KeyAction, readonly string[]>> = {
  bbRamp: ['g', 'm'],
};

export function cloneBindings(b: ControlBindings): ControlBindings {
  const keys = {} as Record<KeyAction, string[]>;
  for (const a of KEY_ACTIONS) keys[a] = [...b.keys[a]];
  const buttons = {} as Record<PadAction, number[]>;
  const combos = {} as Record<PadAction, PadChord[]>;
  for (const a of PAD_ACTIONS) {
    buttons[a] = [...b.pad.buttons[a]];
    combos[a] = b.pad.combos[a].map((c) => [...c]);
  }
  const out: ControlBindings = {
    keys,
    pad: {
      driveStick: b.pad.driveStick,
      buttons,
      combos,
      deadzone: b.pad.deadzone,
      curve: b.pad.curve,
      triggerThreshold: b.pad.triggerThreshold,
      chordGraceMs: b.pad.chordGraceMs,
      menuButton: b.pad.menuButton,
      navEnabled: b.pad.navEnabled,
    },
  };
  const pg = clonePerGame(b.perGame);
  if (pg) out.perGame = pg;
  return out;
}

/** deep-copy the override map, or `undefined` when there is nothing to copy (which is what
 *  keeps a never-overridden blob identical to the old shape). */
function clonePerGame(
  pg: ControlBindings['perGame'],
): ControlBindings['perGame'] | undefined {
  if (!pg) return undefined;
  const out: Partial<Record<GameId, GameBindingOverride>> = {};
  let any = false;
  for (const g of GAME_IDS) {
    const ov = pg[g];
    if (!ov) continue;
    const copy: GameBindingOverride = {};
    if (ov.keys) {
      const keys: Partial<Record<KeyAction, string[]>> = {};
      for (const a of KEY_ACTIONS) if (ov.keys[a]) keys[a] = [...ov.keys[a]!];
      if (Object.keys(keys).length) copy.keys = keys;
    }
    if (ov.padButtons) {
      const bt: Partial<Record<PadAction, number[]>> = {};
      for (const a of PAD_ACTIONS) if (ov.padButtons[a]) bt[a] = [...ov.padButtons[a]!];
      if (Object.keys(bt).length) copy.padButtons = bt;
    }
    if (ov.padCombos) {
      const cb: Partial<Record<PadAction, PadChord[]>> = {};
      for (const a of PAD_ACTIONS) if (ov.padCombos[a]) cb[a] = ov.padCombos[a]!.map((c) => [...c]);
      if (Object.keys(cb).length) copy.padCombos = cb;
    }
    if (copy.keys || copy.padButtons || copy.padCombos) {
      out[g] = copy;
      any = true;
    }
  }
  return any ? out : undefined;
}

const isButtonIndex = (i: unknown): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) < 32;

/**
 * A combo from untrusted input — a stored blob, or the capture screen's own set — in its
 * canonical form, or `null` for anything that is not two to `PAD_CHORD_MAX` distinct buttons.
 * Duplicates are folded BEFORE the length test, so `[7, 7]` is a single and not a combo.
 */
export function normalizeChord(raw: unknown): PadChord | null {
  if (!Array.isArray(raw) || !raw.every(isButtonIndex)) return null;
  const sorted = [...new Set(raw as number[])].sort((a, b) => a - b);
  if (sorted.length < 2 || sorted.length > PAD_CHORD_MAX) return null;
  return sorted;
}

/** identity of a chord — what "the same combo" means to the steal policy */
export function chordKey(c: PadChord): string {
  return c.join('+');
}

/**
 * EVERYTHING that fires an action, singles first and then combos, each as a chord — the one
 * view the resolver, the labels and the tutorial hints read, so none of them has to know that
 * singles and combos are stored apart. A slot index on the controls screen indexes THIS list.
 */
export function padBinds(pad: PadBindings, action: PadAction): PadChord[] {
  return [...pad.buttons[action].map((i) => [i]), ...pad.combos[action]];
}

/** validate a possibly-stale/corrupt saved value field by field; anything
 * that doesn't check out falls back to the default for that action */
export function mergeBindings(saved: unknown): ControlBindings {
  const out = cloneBindings(DEFAULT_BINDINGS);
  if (typeof saved !== 'object' || saved === null) return out;
  const s = saved as { keys?: unknown; pad?: unknown };
  if (typeof s.keys === 'object' && s.keys !== null) {
    const keys = s.keys as Record<string, unknown>;
    const fresh: KeyAction[] = [];
    for (const a of KEY_ACTIONS) {
      const v = keys[a];
      if (Array.isArray(v) && v.every((k) => typeof k === 'string' && k !== 'escape')) {
        out.keys[a] = v.map((k: string) => k.toLowerCase()).slice(0, BIND_SLOTS_MAX);
      } else if (!(a in keys)) {
        fresh.push(a);
      }
    }
    /* ⚠️ THE RAMP'S CASUALTIES, REPAIRED (2026-09-26). Maps saved 2026-09-12..19 carry Place
       POLLEN on its OLD default Z and no Deploy ramp at all, so the rule below gave the ramp no
       key: Z was taken, and nothing else was offered. Pads were never touched, which is why
       only keyboard players reported "the ramp never deploys". Any save since then wrote that
       `[]` back, so the blob no longer looks older than the ramp. A stored empty ramp beside
       Place POLLEN still on exactly ['z'] is that casualty, not a choice, and is re-treated as
       new here. A player on today's map who unbinds the ramp has Place POLLEN on C, and keeps
       their empty row. */
    if (
      !fresh.includes('bbRamp') &&
      out.keys.bbRamp.length === 0 &&
      out.keys.bbPlace.length === 1 &&
      out.keys.bbPlace[0] === 'z'
    ) {
      out.keys.bbRamp = [...DEFAULT_BINDINGS.keys.bbRamp];
      fresh.push('bbRamp');
    }
    // AN ACTION NEWER THAN THE BLOB takes its default only where no bind the player MADE holds
    // it. BIOBUZZ's Deploy ramp used to default to L, the camera's key now: a player still on
    // that map keeps L on the ramp, and the camera starts unbound (a red dot on BIOBUZZ).
    // ...unless it names a `FRESH_FALLBACK_KEYS` entry: a mechanism with no key is a dead robot
    // part, so it takes the first free fallback instead of loading unbound.
    const takenFor = (a: KeyAction, k: string, skipFresh: boolean): boolean =>
      KEY_ACTIONS.some(
        (o) => o !== a && !(skipFresh && fresh.includes(o)) && actionsConflict(o, a) && out.keys[o].includes(k),
      );
    for (const a of fresh) {
      out.keys[a] = out.keys[a].filter((k) => !takenFor(a, k, true));
    }
    for (const a of fresh) {
      if (out.keys[a].length > 0) continue;
      const k = FRESH_FALLBACK_KEYS[a]?.find((f) => !takenFor(a, f, false));
      if (k !== undefined) out.keys[a] = [k];
    }
  }
  if (typeof s.pad === 'object' && s.pad !== null) {
    const pad = s.pad as {
      driveStick?: unknown;
      buttons?: unknown;
      combos?: unknown;
      deadzone?: unknown;
      curve?: unknown;
      triggerThreshold?: unknown;
      chordGraceMs?: unknown;
      menuButton?: unknown;
      navEnabled?: unknown;
    };
    if (isButtonIndex(pad.menuButton)) out.pad.menuButton = pad.menuButton;
    if (typeof pad.navEnabled === 'boolean') out.pad.navEnabled = pad.navEnabled;
    if (pad.driveStick === 'left' || pad.driveStick === 'right') {
      out.pad.driveStick = pad.driveStick;
    }
    if (typeof pad.buttons === 'object' && pad.buttons !== null) {
      const buttons = pad.buttons as Record<string, unknown>;
      for (const a of PAD_ACTIONS) {
        const v = buttons[a];
        if (Array.isArray(v) && v.every(isButtonIndex)) {
          out.pad.buttons[a] = v as number[];
        }
      }
    }
    // Combos are validated ENTRY BY ENTRY rather than list-or-nothing like the singles: a
    // list is a list of independent choices, and one corrupt chord should not take a player's
    // other combos with it. A list that is not a list keeps the default (none).
    if (typeof pad.combos === 'object' && pad.combos !== null) {
      const combos = pad.combos as Record<string, unknown>;
      for (const a of PAD_ACTIONS) {
        const v = combos[a];
        if (!Array.isArray(v)) continue;
        const seen = new Set<string>();
        const clean: PadChord[] = [];
        for (const raw of v) {
          const c = normalizeChord(raw);
          if (!c || seen.has(chordKey(c))) continue;
          seen.add(chordKey(c));
          clean.push(c);
        }
        out.pad.combos[a] = clean;
      }
    }
    if (typeof pad.deadzone === 'number' && Number.isFinite(pad.deadzone)) {
      out.pad.deadzone = Math.min(0.4, Math.max(0, pad.deadzone));
    }
    if (typeof pad.curve === 'number' && Number.isFinite(pad.curve)) {
      out.pad.curve = Math.min(3, Math.max(1, pad.curve));
    }
    if (typeof pad.triggerThreshold === 'number' && Number.isFinite(pad.triggerThreshold)) {
      out.pad.triggerThreshold = Math.min(0.9, Math.max(0.1, pad.triggerThreshold));
    }
    if (typeof pad.chordGraceMs === 'number' && Number.isFinite(pad.chordGraceMs)) {
      out.pad.chordGraceMs = Math.min(PAD_CHORD_GRACE_MAX_MS, Math.max(PAD_CHORD_GRACE_MIN_MS, pad.chordGraceMs));
    }
    // the per-action cap (`BIND_SLOTS_MAX`) is on the COMBINED list a player sees, so it is
    // applied once both halves are loaded. Combos go first because a single is the plainer bind.
    for (const a of PAD_ACTIONS) {
      const over = out.pad.buttons[a].length + out.pad.combos[a].length - BIND_SLOTS_MAX;
      if (over <= 0) continue;
      out.pad.combos[a] = out.pad.combos[a].slice(0, Math.max(0, out.pad.combos[a].length - over));
      out.pad.buttons[a] = out.pad.buttons[a].slice(0, BIND_SLOTS_MAX - out.pad.combos[a].length);
    }
  }
  const pg = mergePerGame((saved as { perGame?: unknown }).perGame, out);
  if (pg) out.perGame = pg;
  return out;
}

/**
 * Validate a stored `perGame` ENTRY BY ENTRY against an already-validated main map, the same
 * way combos are: one bad row must not cost a player the rest of their overrides. Unknown game
 * ids, unknown actions, and actions the game does not USE are dropped outright — an override
 * for `catalyst` under BIOBUZZ can never fire, so keeping it would only be a trap for the
 * conflict rules. Every list goes through the same validators as main and the same cap.
 *
 * ── THE MIGRATION (2026-09-22) — only OVERRIDABLE actions survive as overrides ─────────────
 * Blobs written before the three kinds existed (see `SHARED_ACTIONS`) can carry an override of
 * any action a game uses. This is where they are brought into the model, on every load, so it
 * is idempotent and there is no version field to get wrong:
 *
 *  1. A SEASON-ONLY override is FOLDED INTO MAIN. Lossless: main's bind for such an action
 *     reaches that one game and no other, so the game plays exactly what it played before, and
 *     the player now finds that bind in the one place the screen shows it. `main` is MUTATED —
 *     the caller hands in the map it is building.
 *  2. A SHARED override is DROPPED — that game drives on the shared keys again. It is the one
 *     lossy step, and the one that cannot be otherwise: a shared control has a single value by
 *     definition, and which game's override would win is not a question with an answer. It
 *     only ever existed on the alpha channel, for three days, and the usual way one got there
 *     was not a choice at all: a season-scope rebind that STOLE a drive key desynced the drive
 *     action as its victim.
 *  3. …which is why step 2 is followed by a SCRUB of that game. The drive key the victim lost
 *     is back on the drive action, and the action that took it would now share it — W
 *     driving forward AND shooting. The season's own action gives it up, by the same rule as a
 *     main edit colliding with an override: the bind the whole app shares wins. It reads as
 *     UNBOUND in that season's scope, which is honest and one click to fix. A game that had no
 *     shared override is not scrubbed, so an ordinary blob is untouched by any of this.
 */
function mergePerGame(saved: unknown, main: ControlBindings): ControlBindings['perGame'] | undefined {
  if (typeof saved !== 'object' || saved === null) return undefined;
  const pg = saved as Record<string, unknown>;
  const out: Partial<Record<GameId, GameBindingOverride>> = {};
  let any = false;
  for (const g of GAME_IDS) {
    const raw = pg[g];
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as { keys?: unknown; padButtons?: unknown; padCombos?: unknown };
    const ov: GameBindingOverride = {};
    let droppedShared = false;

    if (typeof r.keys === 'object' && r.keys !== null) {
      const src = r.keys as Record<string, unknown>;
      const keys: Partial<Record<KeyAction, string[]>> = {};
      for (const a of KEY_ACTIONS) {
        if (!actionUsedBy(a, g)) continue;
        const v = src[a];
        if (Array.isArray(v) && v.every((k) => typeof k === 'string' && k !== 'escape')) {
          const list = (v as string[]).map((k) => k.toLowerCase()).slice(0, BIND_SLOTS_MAX);
          if (actionIsShared(a)) droppedShared = true; // step 2
          else if (actionIsSeasonOnly(a)) main.keys[a] = list; // step 1
          else keys[a] = list;
        }
      }
      if (Object.keys(keys).length) ov.keys = keys;
    }

    // PAD: the two halves are one unit, so an action named by EITHER of them is desynced and
    // BOTH halves are written — the missing one taken from main, once, and frozen there.
    const btSrc = typeof r.padButtons === 'object' && r.padButtons !== null ? (r.padButtons as Record<string, unknown>) : {};
    const cbSrc = typeof r.padCombos === 'object' && r.padCombos !== null ? (r.padCombos as Record<string, unknown>) : {};
    const buttons: Partial<Record<PadAction, number[]>> = {};
    const combos: Partial<Record<PadAction, PadChord[]>> = {};
    for (const a of PAD_ACTIONS) {
      if (!actionUsedBy(a, g)) continue;
      const rawBt = btSrc[a];
      const rawCb = cbSrc[a];
      if (rawBt === undefined && rawCb === undefined) continue;
      const bt = Array.isArray(rawBt) && rawBt.every(isButtonIndex) ? (rawBt as number[]) : [...main.pad.buttons[a]];
      const cb: PadChord[] = [];
      if (Array.isArray(rawCb)) {
        const seen = new Set<string>();
        for (const c of rawCb) {
          const n = normalizeChord(c);
          if (!n || seen.has(chordKey(n))) continue;
          seen.add(chordKey(n));
          cb.push(n);
        }
      } else {
        cb.push(...main.pad.combos[a].map((c) => [...c]));
      }
      const over = bt.length + cb.length - BIND_SLOTS_MAX;
      const keptCb = over > 0 ? cb.slice(0, Math.max(0, cb.length - over)) : cb;
      const keptBt = over > 0 ? bt.slice(0, BIND_SLOTS_MAX - keptCb.length) : bt;
      if (actionIsShared(a)) {
        droppedShared = true; // step 2
      } else if (actionIsSeasonOnly(a)) {
        main.pad.buttons[a] = keptBt; // step 1 — the unit folds whole, singles and combos
        main.pad.combos[a] = keptCb;
      } else {
        buttons[a] = keptBt;
        combos[a] = keptCb;
      }
    }
    if (Object.keys(buttons).length) {
      ov.padButtons = buttons;
      ov.padCombos = combos;
    }

    if (droppedShared) scrubSharedFromSeason(main, ov, g); // step 3

    if (ov.keys || ov.padButtons) {
      out[g] = ov;
      any = true;
    }
  }
  return any ? out : undefined;
}

/**
 * Take every bind a SHARED action holds in `main` off `game`'s own actions — its overrides,
 * and the main lists of its season-only actions (which reach no other game). The migration's
 * step 3; see `mergePerGame`. Exact like every other steal: a single scrubs singles, a combo
 * scrubs the identical combo. Lists are filtered, never deleted, so a desynced action stays
 * desynced — as UNBOUND if it gave up its only bind.
 */
function scrubSharedFromSeason(main: ControlBindings, ov: GameBindingOverride, game: GameId): void {
  const keys = new Set<string>();
  for (const s of SHARED_ACTIONS) for (const k of main.keys[s]) keys.add(k);
  const singles = new Set<number>();
  const combos = new Set<string>();
  for (const s of PAD_ACTIONS) {
    if (!actionIsShared(s)) continue;
    for (const i of main.pad.buttons[s]) singles.add(i);
    for (const c of main.pad.combos[s]) combos.add(chordKey(c));
  }
  for (const a of seasonKeyActions(game)) {
    const v = ov.keys?.[a];
    if (v) ov.keys![a] = v.filter((k) => !keys.has(k));
    else if (actionIsSeasonOnly(a)) main.keys[a] = main.keys[a].filter((k) => !keys.has(k));
  }
  for (const a of seasonPadActions(game)) {
    const bt = ov.padButtons?.[a];
    if (bt) {
      ov.padButtons![a] = bt.filter((i) => !singles.has(i));
      ov.padCombos![a] = (ov.padCombos?.[a] ?? []).filter((c) => !combos.has(chordKey(c)));
    } else if (actionIsSeasonOnly(a)) {
      main.pad.buttons[a] = main.pad.buttons[a].filter((i) => !singles.has(i));
      main.pad.combos[a] = main.pad.combos[a].filter((c) => !combos.has(chordKey(c)));
    }
  }
}

// ---- THE EFFECTIVE MAP ------------------------------------------------------------
// What a game actually plays on: main, with that game's overrides applied, and every action
// the game does not use EMPTIED. Emptying is not cosmetic — it is what stops a Chain Reaction
// catalyst bind firing, masking or consuming inside BIOBUZZ's chord resolver, which reads a
// `PadBindings` and has no idea what a game is.

/** is `action`'s keyboard bind desynced (overridden) in `game`? Never, for an action that may
 *  not be overridden — see `actionOverridable`. */
export function keyDesynced(b: ControlBindings, game: GameId, action: KeyAction): boolean {
  return actionOverridable(action) && b.perGame?.[game]?.keys?.[action] !== undefined;
}

/** is `action`'s pad bind desynced in `game`? Singles and combos are one unit, so either half
 *  being present is the answer. */
export function padDesynced(b: ControlBindings, game: GameId, action: PadAction): boolean {
  if (!actionOverridable(action)) return false;
  const ov = b.perGame?.[game];
  return ov?.padButtons?.[action] !== undefined || ov?.padCombos?.[action] !== undefined;
}

/** does `game` override anything at all? */
export function gameHasOverrides(b: ControlBindings, game: GameId): boolean {
  return KEY_ACTIONS.some((a) => keyDesynced(b, game, a)) || PAD_ACTIONS.some((a) => padDesynced(b, game, a));
}

/**
 * THE ONE RESOLVER. A plain main-shaped `ControlBindings` for `game`, with `perGame` stripped —
 * it is already applied, and a second application would be a bug looking for somewhere to
 * happen. Everything that reads a binding to DRIVE or to NAME a control reads this, never
 * `settings.bindings`: `InputManager`, the start overlay, and the tutorial hints.
 */
export function effectiveBindings(b: ControlBindings, game: GameId): ControlBindings {
  const out = cloneBindings(b);
  delete out.perGame;
  const ov = b.perGame?.[game];
  for (const a of KEY_ACTIONS) {
    if (!actionUsedBy(a, game)) {
      out.keys[a] = [];
      continue;
    }
    const v = keyDesynced(b, game, a) ? ov?.keys?.[a] : undefined;
    if (v) out.keys[a] = [...v];
  }
  for (const a of PAD_ACTIONS) {
    if (!actionUsedBy(a, game)) {
      out.pad.buttons[a] = [];
      out.pad.combos[a] = [];
      continue;
    }
    if (!padDesynced(b, game, a)) continue;
    out.pad.buttons[a] = [...(ov?.padButtons?.[a] ?? b.pad.buttons[a])];
    out.pad.combos[a] = (ov?.padCombos?.[a] ?? b.pad.combos[a]).map((c) => [...c]);
  }
  return out;
}

// ---- editing ----------------------------------------------------------------------
// The controls screen's own operations, kept DOM-free here so `npm test` can pin the steal
// policy: a rebound key or button is taken from whatever CONFLICTING action had it, and the
// slot it is dropped on is replaced. STEALING IS EXACT — a single steals that single and
// touches no combo; a combo steals the identical combo and touches no single. RT can be Shoot
// and half of a lift combo at once, which is the whole reason combos exist.
//
// TWO ACTIONS CONFLICT ONLY IF SOME GAME USES BOTH (`actionsConflict`). In the MAIN map that
// makes `catalyst` (Chain Reaction) and `bbPlace` (BIOBUZZ) able to share a key or a button —
// no session ever offers both, so the duplicate is not one. `fire` is in every game and still
// steals from everything.
//
// THE GAME-SCOPE EDITS ARE THE SAME FUNCTIONS, APPLIED TO THE EFFECTIVE MAP. That is not a
// shortcut, it is the definition: inside game G the steal scope is G's effective map, and in
// that map every action G does not use is already empty, so the very same filter reaches
// exactly the actions G uses. See `editInGame`.

/** the number of binds `action` carries on a device — the list `BIND_SLOTS_MAX` caps */
const atCap = (list: readonly unknown[]): boolean => list.length >= BIND_SLOTS_MAX;

/** put `key` on `action` at `slot` (past the end appends), taking it from every CONFLICTING
 *  action. An append past `BIND_SLOTS_MAX` is refused rather than silently dropped later. */
export function assignKey(b: ControlBindings, action: KeyAction, slot: number, key: string): ControlBindings {
  if (slot >= b.keys[action].length && atCap(b.keys[action])) return cloneBindings(b);
  const next = cloneBindings(b);
  for (const a of KEY_ACTIONS) {
    if (!actionsConflict(a, action)) continue;
    next.keys[a] = next.keys[a].filter((k) => k !== key);
  }
  // filtering above may have shortened this list, so re-clamp the slot to it
  const list = next.keys[action];
  if (slot < list.length) list[slot] = key;
  else list.push(key);
  return scrubKeyFromOverrides(next, action, key);
}

/**
 * MAIN-EDIT vs OVERRIDE — the one collision the two scopes can produce, and its rule.
 *
 * A main edit steals `key` from every conflicting action IN MAIN, but an action that is
 * DESYNCED in game G does not read main there: it could keep `key` in its override while
 * `action` — synced in G, so inheriting main — now also has it. Inside G that is a genuine
 * duplicate, of exactly the kind the whole steal policy exists to prevent, arrived at without
 * anyone editing G.
 *
 * THE OVERRIDE LOSES THE BIND. It is the simplest rule and the predictable one: the edit the
 * player just made is the one that survives, everywhere, and a main edit never silently fails
 * to take effect. The alternative (main loses) would mean an edit under "All games" quietly
 * doing nothing because of a season the player is not looking at.
 *
 * Only games where `action` is SYNCED are touched — where it is desynced, main's new bind
 * never reaches that game's effective map and there is nothing to collide with.
 */
function scrubKeyFromOverrides(b: ControlBindings, action: KeyAction, key: string): ControlBindings {
  if (!b.perGame) return b;
  const next = cloneBindings(b);
  for (const g of GAME_IDS) {
    const ov = next.perGame?.[g];
    if (!ov?.keys) continue;
    if (!actionUsedBy(action, g) || keyDesynced(next, g, action)) continue;
    for (const other of keyActionsFor(g)) {
      if (other === action) continue;
      const v = ov.keys[other];
      if (!v || !v.includes(key)) continue;
      ov.keys[other] = v.filter((k) => k !== key);
    }
  }
  return prunePerGame(next);
}

/** the pad twin of `scrubKeyFromOverrides`. Exactness is kept: a single scrubs that single out
 *  of `padButtons` and leaves every combo alone; a combo scrubs the identical combo. */
function scrubPadFromOverrides(b: ControlBindings, action: PadAction, chord: PadChord): ControlBindings {
  if (!b.perGame) return b;
  const next = cloneBindings(b);
  const single = chord.length === 1 ? chord[0] : null;
  const key = single === null ? chordKey(chord) : null;
  for (const g of GAME_IDS) {
    const ov = next.perGame?.[g];
    if (!ov) continue;
    if (!actionUsedBy(action, g) || padDesynced(next, g, action)) continue;
    for (const other of padActionsFor(g)) {
      if (other === action) continue;
      if (single !== null && ov.padButtons?.[other]) {
        ov.padButtons[other] = ov.padButtons[other]!.filter((i) => i !== single);
      }
      if (key !== null && ov.padCombos?.[other]) {
        ov.padCombos[other] = ov.padCombos[other]!.filter((c) => chordKey(c) !== key);
      }
    }
  }
  return prunePerGame(next);
}

/** drop empty override objects, and `perGame` itself once the last one goes — so a blob that
 *  has been synced all the way back is byte-identical to one that never had an override. */
function prunePerGame(b: ControlBindings): ControlBindings {
  const pg = clonePerGame(b.perGame);
  if (pg) b.perGame = pg;
  else delete b.perGame;
  return b;
}

/** drop the key at `slot` from `action`; a slot that does not exist is a no-op */
export function removeKey(b: ControlBindings, action: KeyAction, slot: number): ControlBindings {
  const next = cloneBindings(b);
  next.keys[action].splice(slot, 1);
  return next;
}

/**
 * put `chord` (a single as `[i]`, or a combo) on `action` at `slot`, taking it from every
 * other action. `slot` indexes `padBinds(action)` — singles then combos — and the bind that
 * was there is replaced, moving between the two lists when the kind changes.
 */
export function assignPadBind(b: ControlBindings, action: PadAction, slot: number, chord: PadChord): ControlBindings {
  const have = padBinds(b.pad, action);
  if (slot >= have.length && atCap(have)) return cloneBindings(b);
  const next = removePadBind(b, action, slot);
  const combo = chord.length > 1 ? normalizeChord(chord) : null;
  if (chord.length > 1 && !combo) return cloneBindings(b);
  if (combo) {
    const key = chordKey(combo);
    for (const a of PAD_ACTIONS) {
      if (!actionsConflict(a, action)) continue;
      next.pad.combos[a] = next.pad.combos[a].filter((c) => chordKey(c) !== key);
    }
    const singles = next.pad.buttons[action].length;
    const at = Math.min(Math.max(0, slot - singles), next.pad.combos[action].length);
    next.pad.combos[action].splice(at, 0, combo);
  } else {
    const idx = chord[0];
    if (!isButtonIndex(idx)) return cloneBindings(b);
    for (const a of PAD_ACTIONS) {
      if (!actionsConflict(a, action)) continue;
      next.pad.buttons[a] = next.pad.buttons[a].filter((i) => i !== idx);
    }
    const at = Math.min(slot, next.pad.buttons[action].length);
    next.pad.buttons[action].splice(at, 0, idx);
  }
  return scrubPadFromOverrides(next, action, combo ?? chord);
}

/** drop the bind at `slot` of `padBinds(action)`; a slot that does not exist is a no-op */
export function removePadBind(b: ControlBindings, action: PadAction, slot: number): ControlBindings {
  const next = cloneBindings(b);
  const singles = next.pad.buttons[action].length;
  if (slot < singles) next.pad.buttons[action].splice(slot, 1);
  else next.pad.combos[action].splice(slot - singles, 1);
  return next;
}

// ---- editing INSIDE ONE GAME'S SCOPE ------------------------------------------------
// Every one of these is the SAME main-shaped editor run against the game's EFFECTIVE map, and
// then diffed back. Three properties fall out of doing it that way rather than writing a second
// steal policy:
//
//  · THE STEAL SCOPE IS AUTOMATICALLY RIGHT. In the effective map every action the game does
//    not use is already empty, so `assignKey`'s filter reaches exactly the actions the game
//    uses and nothing else. Binding X to A in game G takes X off every other action G uses.
//  · EACH ACTION IS WRITTEN WHERE IT LIVES. An OVERRIDABLE action (Intake, Shoot) goes to G's
//    override, and a victim of the steal among them is DESYNCED in G to record its loss — the
//    only honest way to say "this action has different binds here", undone by Sync like any
//    other. A SEASON-ONLY action goes to main, because main's bind for it reaches G alone.
//  · A SHARED CONTROL IS NEVER TOUCHED. It has one value in every game, so a season scope may
//    not take a key from one: the edit is REFUSED (`sharedKeyHolder` / `sharedPadHolder` say
//    which control holds it, for the screen to tell the player) instead of stealing a drive key
//    in one season, or in all of them from a screen that says it is editing one.

// ---- CONFLICTS: ASKED BEFORE AN EDIT, SO NOTHING IS STOLEN ------------------------------
// The screen asks these BEFORE it assigns, and refuses a bind that is already taken, rather
// than letting `assignKey` take it from the other action (owner, 2026-09-24: binding a key
// that another function uses "shouldn't unbind the other one"). The steal code in the assign
// helpers is still there, and still pinned by `npm test`, but it only runs once one of these
// has said the bind is free, so there is nothing left for it to take.

/** who already holds a bind. `game` is the season whose override holds it, or null for main. */
export interface BindConflict {
  action: KeyAction;
  game: GameId | null;
}

/**
 * THE ACTION ALREADY ON `key`, as seen from where `action` is being edited — `game` null is All
 * games, the main map. Main is checked against every action that shares a game with `action`
 * (`actionsConflict`), and then against each season's effective map where `action` is synced,
 * which is how a main bind would collide with a season's own Intake or Shoot. Inside one season,
 * its effective map is the whole answer. The same action on another slot is not a conflict.
 */
export function keyConflict(
  b: ControlBindings,
  game: GameId | null,
  action: KeyAction,
  key: string,
): BindConflict | null {
  const inGame = (g: GameId): BindConflict | null => {
    const eff = effectiveBindings(b, g);
    const a = keyActionsFor(g).find((o) => o !== action && eff.keys[o].includes(key));
    return a ? { action: a, game: g } : null;
  };
  if (game) return inGame(game);
  const main = KEY_ACTIONS.find((o) => o !== action && actionsConflict(o, action) && b.keys[o].includes(key));
  if (main) return { action: main, game: null };
  for (const g of GAME_IDS) {
    if (!actionUsedBy(action, g) || keyDesynced(b, g, action)) continue;
    const c = inGame(g);
    if (c) return c;
  }
  return null;
}

/** the pad twin of `keyConflict`, EXACT like every pad rule: a single is held by that single, a
 *  combo by the identical combo, and RT on Shoot does not conflict with an RT + D-UP combo. */
export function padConflict(
  b: ControlBindings,
  game: GameId | null,
  action: PadAction,
  chord: PadChord,
): BindConflict | null {
  const combo = chord.length > 1 ? normalizeChord(chord) : null;
  const holds = (pad: PadBindings, a: PadAction): boolean =>
    combo ? pad.combos[a].some((c) => chordKey(c) === chordKey(combo)) : pad.buttons[a].includes(chord[0]);
  const inGame = (g: GameId): BindConflict | null => {
    const eff = effectiveBindings(b, g);
    const a = padActionsFor(g).find((o) => o !== action && holds(eff.pad, o));
    return a ? { action: a, game: g } : null;
  };
  if (game) return inGame(game);
  const main = PAD_ACTIONS.find((o) => o !== action && actionsConflict(o, action) && holds(b.pad, o));
  if (main) return { action: main, game: null };
  for (const g of GAME_IDS) {
    if (!actionUsedBy(action, g) || padDesynced(b, g, action)) continue;
    const c = inGame(g);
    if (c) return c;
  }
  return null;
}

/** the SHARED control that holds `key` in main, if any — what a season scope may not take */
export function sharedKeyHolder(b: ControlBindings, key: string): KeyAction | null {
  return SHARED_ACTIONS.find((s) => b.keys[s].includes(key)) ?? null;
}

/** the SHARED control that holds `chord` in main, if any. Exact, like every steal: a single
 *  is held by a single, a combo by the identical combo. */
export function sharedPadHolder(b: ControlBindings, chord: PadChord): PadAction | null {
  const combo = chord.length > 1 ? normalizeChord(chord) : null;
  for (const a of PAD_ACTIONS) {
    if (!actionIsShared(a)) continue;
    if (combo ? b.pad.combos[a].some((c) => chordKey(c) === chordKey(combo)) : b.pad.buttons[a].includes(chord[0])) {
      return a;
    }
  }
  return null;
}

/** run `edit` on `game`'s effective map and write each changed action back where it lives. */
function editInGame(
  b: ControlBindings,
  game: GameId,
  edit: (eff: ControlBindings) => ControlBindings,
): ControlBindings {
  const before = effectiveBindings(b, game);
  const after = edit(before);
  const next = cloneBindings(b);
  const ov: GameBindingOverride = next.perGame?.[game] ?? {};
  const same = (x: readonly unknown[], y: readonly unknown[]): boolean => JSON.stringify(x) === JSON.stringify(y);
  for (const a of seasonKeyActions(game)) {
    const moved = !same(after.keys[a], before.keys[a]);
    if (actionIsSeasonOnly(a)) {
      if (moved) next.keys[a] = [...after.keys[a]];
      continue;
    }
    // an action that was ALREADY desynced stays desynced even if this edit did not move it —
    // the player said "these are mine here", and only Sync takes that back.
    if (moved || keyDesynced(b, game, a)) (ov.keys ??= {})[a] = [...after.keys[a]];
  }
  for (const a of seasonPadActions(game)) {
    const moved = !same(after.pad.buttons[a], before.pad.buttons[a]) || !same(after.pad.combos[a], before.pad.combos[a]);
    if (actionIsSeasonOnly(a)) {
      if (moved) {
        next.pad.buttons[a] = [...after.pad.buttons[a]];
        next.pad.combos[a] = after.pad.combos[a].map((c) => [...c]);
      }
      continue;
    }
    if (moved || padDesynced(b, game, a)) {
      (ov.padButtons ??= {})[a] = [...after.pad.buttons[a]];
      (ov.padCombos ??= {})[a] = after.pad.combos[a].map((c) => [...c]);
    }
  }
  next.perGame = { ...next.perGame, [game]: ov };
  return prunePerGame(next);
}

/** put `key` on `action` at `slot` within `game` only, taking it from whatever other action of
 *  that game had it. REFUSED (an unchanged copy) for a shared control, and for a key a shared
 *  control holds. */
export function assignKeyInGame(
  b: ControlBindings,
  game: GameId,
  action: KeyAction,
  slot: number,
  key: string,
): ControlBindings {
  if (!actionUsedBy(action, game) || actionIsShared(action) || sharedKeyHolder(b, key)) return cloneBindings(b);
  return editInGame(b, game, (eff) => assignKey(eff, action, slot, key));
}

/** drop the key at `slot` of `action` within `game` only */
export function removeKeyInGame(b: ControlBindings, game: GameId, action: KeyAction, slot: number): ControlBindings {
  if (!actionUsedBy(action, game) || actionIsShared(action)) return cloneBindings(b);
  return editInGame(b, game, (eff) => removeKey(eff, action, slot));
}

/** put `chord` on `action` at `slot` within `game` only — refused like `assignKeyInGame` */
export function assignPadBindInGame(
  b: ControlBindings,
  game: GameId,
  action: PadAction,
  slot: number,
  chord: PadChord,
): ControlBindings {
  if (!actionUsedBy(action, game) || actionIsShared(action) || sharedPadHolder(b, chord)) return cloneBindings(b);
  return editInGame(b, game, (eff) => assignPadBind(eff, action, slot, chord));
}

/** drop the bind at `slot` of `action` within `game` only */
export function removePadBindInGame(b: ControlBindings, game: GameId, action: PadAction, slot: number): ControlBindings {
  if (!actionUsedBy(action, game) || actionIsShared(action)) return cloneBindings(b);
  return editInGame(b, game, (eff) => removePadBind(eff, action, slot));
}

/**
 * SYNC BACK one keyboard action in one game: delete its override, so it inherits main again.
 *
 * ⚠️ AND THE BINDS IT COMES BACK TO WIN. While it was desynced, another of the game's actions may
 * have taken one of main's keys for it (a season-scope rebind of Place POLLEN onto J, with Shoot
 * on J in All games). Deleting the override alone would put J on both in that game — the
 * duplicate the steal policy exists to prevent, arrived at by pressing Sync. So the game's other
 * actions give those keys up, by the rule a main edit already follows against an override: the
 * bind every season shares is the one that survives.
 */
export function syncKeyInGame(b: ControlBindings, game: GameId, action: KeyAction): ControlBindings {
  if (!keyDesynced(b, game, action)) return cloneBindings(b);
  const next = cloneBindings(b);
  delete next.perGame![game]!.keys![action];
  const back = new Set(next.keys[action]);
  for (const o of seasonKeyActions(game)) {
    if (o === action || back.size === 0) continue;
    const own = next.perGame?.[game]?.keys;
    if (keyDesynced(next, game, o) && own) own[o] = own[o]!.filter((k) => !back.has(k));
    else if (actionIsSeasonOnly(o)) next.keys[o] = next.keys[o].filter((k) => !back.has(k));
  }
  return prunePerGame(next);
}

/** SYNC BACK one pad action in one game. Singles and combos go together — they are one unit —
 *  and the binds it comes back to win, exactly as `syncKeyInGame` says. */
export function syncPadInGame(b: ControlBindings, game: GameId, action: PadAction): ControlBindings {
  if (!padDesynced(b, game, action)) return cloneBindings(b);
  const next = cloneBindings(b);
  delete next.perGame?.[game]?.padButtons?.[action];
  delete next.perGame?.[game]?.padCombos?.[action];
  const singles = new Set(next.pad.buttons[action]);
  const combos = new Set(next.pad.combos[action].map(chordKey));
  for (const o of seasonPadActions(game)) {
    if (o === action) continue;
    const ov = next.perGame?.[game];
    if (padDesynced(next, game, o) && ov) {
      if (ov.padButtons?.[o]) ov.padButtons[o] = ov.padButtons[o]!.filter((i) => !singles.has(i));
      if (ov.padCombos?.[o]) ov.padCombos[o] = ov.padCombos[o]!.filter((c) => !combos.has(chordKey(c)));
    } else if (actionIsSeasonOnly(o)) {
      next.pad.buttons[o] = next.pad.buttons[o].filter((i) => !singles.has(i));
      next.pad.combos[o] = next.pad.combos[o].filter((c) => !combos.has(chordKey(c)));
    }
  }
  return prunePerGame(next);
}

/** SYNC BACK every override in one game, one action at a time so each one's binds win. */
export function syncGame(b: ControlBindings, game: GameId): ControlBindings {
  let next = cloneBindings(b);
  for (const a of seasonKeyActions(game)) next = syncKeyInGame(next, game, a);
  for (const a of seasonPadActions(game)) next = syncPadInGame(next, game, a);
  return prunePerGame(next);
}

/**
 * RESET ONE SEASON: its overrides synced away (so Intake and Shoot follow All games again) and
 * its season-only actions back on their defaults — minus any default a bind the whole app shares
 * now holds in that game. A player who moved Drive forward onto C has made C a drive key
 * everywhere, and resetting BIOBUZZ must not put Place POLLEN back on top of it. Nothing outside
 * this one season moves: the shared controls, the other seasons, and main's Intake and Shoot.
 */
export function resetGame(b: ControlBindings, game: GameId): ControlBindings {
  const next = syncGame(b, game);
  const eff = effectiveBindings(next, game);
  const keys = new Set<string>();
  const singles = new Set<number>();
  const combos = new Set<string>();
  for (const a of keyActionsFor(game)) if (!actionIsSeasonOnly(a)) for (const k of eff.keys[a]) keys.add(k);
  for (const a of padActionsFor(game)) {
    if (actionIsSeasonOnly(a)) continue;
    for (const i of eff.pad.buttons[a]) singles.add(i);
    for (const c of eff.pad.combos[a]) combos.add(chordKey(c));
  }
  for (const a of seasonKeyActions(game)) {
    if (actionIsSeasonOnly(a)) next.keys[a] = DEFAULT_BINDINGS.keys[a].filter((k) => !keys.has(k));
  }
  for (const a of seasonPadActions(game)) {
    if (!actionIsSeasonOnly(a)) continue;
    next.pad.buttons[a] = DEFAULT_BINDINGS.pad.buttons[a].filter((i) => !singles.has(i));
    next.pad.combos[a] = DEFAULT_BINDINGS.pad.combos[a].filter((c) => !combos.has(chordKey(c))).map((c) => [...c]);
  }
  return next;
}

/**
 * The season's own actions that have NO bind on one device or the other in that game. A main
 * edit can take a key from an action the All games scope does not list (put Shoot on C and
 * Catalyst and Place POLLEN both lose it), so the screen marks the season that needs a look
 * rather than leaving the player to find out in a match.
 */
export function seasonUnbound(b: ControlBindings, game: GameId): KeyAction[] {
  const eff = effectiveBindings(b, game);
  const pad = new Set<KeyAction>(seasonPadActions(game));
  return seasonKeyActions(game).filter(
    (a) => eff.keys[a].length === 0 || (pad.has(a) && padBinds(eff.pad, a as PadAction).length === 0),
  );
}

/** display label for a bound key */
export function keyLabel(k: string): string {
  const special: Record<string, string> = {
    ' ': 'SPACE',
    // ←→↑↓, not ◄►▲▼: the geometric triangles render at about half the cap height in the mono
    // face, visibly smaller than the letter caps beside them (design review 04-11)
    arrowleft: '←',
    arrowright: '→',
    arrowup: '↑',
    arrowdown: '↓',
    shift: 'SHIFT',
    control: 'CTRL',
    alt: 'ALT',
    enter: 'ENTER',
    tab: 'TAB',
    backspace: 'BKSP',
  };
  return special[k] ?? k.toUpperCase();
}

/** the SPOKEN name of a bound key — a keycap's accessible name. An arrow glyph is announced by
 *  its Unicode name ("leftwards arrow") and BKSP as letters, so those few are spelled out. */
export function keyName(k: string): string {
  const spoken: Record<string, string> = {
    arrowleft: 'Left arrow',
    arrowright: 'Right arrow',
    arrowup: 'Up arrow',
    arrowdown: 'Down arrow',
    backspace: 'Backspace',
    control: 'Control',
  };
  return spoken[k] ?? keyLabel(k);
}

const PAD_BUTTON_LABELS = [
  'A',
  'B',
  'X',
  'Y',
  'LB',
  'RB',
  'LT',
  'RT',
  'BACK',
  'START',
  'LS',
  'RS',
  'D-UP',
  'D-DOWN',
  'D-LEFT',
  'D-RIGHT',
];

/** display label for a standard-mapping gamepad button index */
export function padButtonLabel(i: number): string {
  return PAD_BUTTON_LABELS[i] ?? `B${i}`;
}

/** display label for one bind: a single's face label, or a combo's buttons joined by `+` */
export function padBindLabel(c: PadChord): string {
  return c.map(padButtonLabel).join(' + ');
}
