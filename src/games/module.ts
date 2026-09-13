import type { ComponentType } from 'react';
import type {
  Alliance,
  Artifact,
  MobileLayout,
  RobotSpec,
  RobotState,
  StartCat,
  StartPose,
  Vec2,
  World,
} from '../types';
import type { HudSnapshot } from '../game';
import type { GameId, GameSimModule, GameUiSpec } from './types';

/**
 * The FULL (client) game module: the DOM-free `GameSimModule` plus the browser
 * canvas renderers + builder metadata. Kept separate from `./types.ts` so the
 * server (no DOM lib) never imports `CanvasRenderingContext2D`. React types are
 * fine here for the same reason.
 *
 * ---
 * ## UI SLOTS
 *
 * Every `ComponentType` / function field below is OPTIONAL, and every consumer
 * wires it as `mod.X ? <the slot> : <the existing branch, unchanged>`. That shape
 * is the whole point:
 *
 * - DECODE's and Chain Reaction's inline `isDecode` / `hud.game === 'chain'`
 *   branches are NOT refactored. They work, they are the two games people are
 *   playing, and rewriting them to route through the slots would put a behaviour
 *   change inside a commit whose only job is to make room for a third game. A game
 *   that fills no slot behaves exactly as it did.
 * - A THIRD game therefore adds no arm to any of those branches. Before the slots
 *   existed there were ~16 `isDecode` gates in `Menu.tsx` alone, plus the
 *   `GameView` / `MobileControls` / start-editor pairs — every one of which a new
 *   game had to be threaded into by hand, in files two other people are editing
 *   at the same time.
 * - `GameUiSpec` (`ui`, below) is the earlier attempt at this and has never had a
 *   reader. It is left alone deliberately: removing it is a separate change, and
 *   it is not in anybody's way.
 */
export interface GameModule extends GameSimModule {
  /** `screenUp` is world-space "up" for z-lift — CR raises the beams into extruded tubes. */
  drawField(ctx: CanvasRenderingContext2D, world: World, screenUp?: Vec2): void;
  /** extra overlays drawn after the field, before robots (DECODE: ramp strips) */
  drawOverlays?(ctx: CanvasRenderingContext2D, world: World): void;
  /** per-robot sprite. DECODE omits it (the shared `drawRobot` is used); CR provides its
   * own so the archetype launcher + intake design read correctly. `screenUp` lets CR bob the
   * chassis up onto a beam it's crossing. `world` is optional and read-only — CR's rail-turret
   * claw TRACKS a live target, so its sprite needs to see where the loose rings are. */
  drawRobot?(
    ctx: CanvasRenderingContext2D,
    r: RobotState,
    intakeOn: boolean,
    held: Artifact[],
    screenUp?: Vec2,
    world?: World,
  ): void;
  /** scoring-elements renderer, drawn after the robots (DECODE: balls; CR: particles
   * + catalysts + endgame badges). `screenUp` is world-space "up" for z-lift. */
  drawBalls(ctx: CanvasRenderingContext2D, world: World, screenUp: Vec2): void;
  ui: GameUiSpec;

  // ---------------------------------------------------------------- UI slots --

  /** the game's own builder panel, rendered by `Menu` in place of the per-game
   * inline block. It gets ONE patch callback rather than a settings setter: a
   * builder must not know where a spec is stored. */
  Builder?: ComponentType<GameBuilderProps>;
  /** the robot schematic (the builder hero + the pre-match strategy card). One
   * component per game on purpose — work on one game's mechanisms must never
   * change how another game's robot looks. */
  Preview?: ComponentType<GamePreviewProps>;
  /** extra chips in the live HUD's `.robot-status` row (hopper, mechanism state,
   * action prompts). Rendered INSIDE the existing row, so it inherits the chip
   * styles and the touch-layout suppression. */
  hudChips?: ComponentType<GameHudProps>;
  /** the whole bottom red|timer|blue bar, for a game that needs a different one.
   * Absent means the shared bar, which is what both current games use. */
  scoreBar?: ComponentType<GameHudProps>;
  /**
   * The score BREAKDOWN sections for the results screens.
   *
   * Rows are ALLIANCE-RELATIVE (`[label, mine, opp]`, "mine" being `hud.alliance`)
   * because the two screens want different things from the same numbers: the versus
   * results print red | blue, and a solo record run has no opponent column at all.
   * Only the game knows which of its own numbers is which, so it hands over the pair
   * and each screen arranges it.
   */
  resultsRows?(hud: HudSnapshot): readonly ResultsSection[];
  /** extra touch action buttons. Each one's POSITION comes from
   * `GameSettings.mobileLayout`, so a genuinely new action needs a key there too. */
  mobileButtons?: readonly GameMobileButton[];
  /** the game's start-position editor, used in place of the
   * `isDecode ? StartPositionEditor : ChainStartEditor` branch. */
  startEditor?: ComponentType<StartEditorProps>;
  /** display strings a non-game screen needs. `configSummary` is the ONE line that
   * says what a build is — printed by the leaderboard, the lobby roster and the
   * strategy screen. */
  labels?: {
    configSummary(spec: RobotSpec): string;
  };
  /**
   * The PER-GAME tiles in the builder hero's stat grid — the summary of what
   * MECHANISMS this build carries, beside the shared speed / mass / drivetrain tiles.
   *
   * ── WHY THIS IS A SLOT, AND A SIBLING OF `labels` RATHER THAN A MEMBER OF IT ──
   * `Menu.tsx` picked these tiles with `isDecode ? <intake tile> : <scoring + catalyst
   * tiles>` — the same two-valued shape `presets` was built to replace, and with the
   * same result: a third game did not fall back to "no per-game tile", it fell into the
   * CHAIN arm. BIOBUZZ therefore advertised a "Claw arm · CATALYST" chip, a Chain
   * Reaction mechanism, off a field (`catalystType`) its own coercer DELETES — so the
   * tile was printing `CHAIN_CATALYST_LABELS[CHAIN_DEFAULT_CATALYST]`, a default label
   * for a field the spec does not have. Confident, populated, and about another game.
   *
   * It is a SIBLING of `labels` because the slot table is a map from slot to CONSUMER,
   * and these have different ones: `labels.configSummary` is a SENTENCE for screens that
   * are not the builder (`robotLabels.buildSummary` → the leaderboard, the lobby roster,
   * the strategy card), while this is the builder hero's own tile grid and its shape is
   * structured, not a line. Folding a tile list into a bag named `labels` would turn that
   * bag into a catch-all with two unrelated readers, which is the point at which a slot
   * stops saying where it is rendered. A game that wants both still writes them off ONE
   * vocabulary module, which is what keeps the two from describing a robot differently.
   *
   * Returns DATA, not markup, for the reason `presets.lines` and `resultsRows` do: the
   * `.ds-stat` tile (and its CSS) has one owner, and a game contributing a tile cannot
   * drift it.
   */
  statTiles?(spec: RobotSpec): readonly GameStatTile[];
  /**
   * The game's PRESET ROBOTS — the cards the builder's `Presets` section offers.
   *
   * ── WHY THIS IS A SLOT ──────────────────────────────────────────────────
   * `Menu.tsx` picked the list with `isDecode ? ROBOT_PRESETS : CHAIN_PRESETS`, and the
   * card BODY under each name with a second two-valued branch. A third game therefore
   * did not fall back to "no presets" — it fell into the CHAIN arm and was offered
   * Chain Reaction's robots, described in Chain Reaction's words. Not a missing feature:
   * a wrong one, and invisible, because the section still rendered nine plausible cards.
   *
   * A game fills this and gets its own list, its own match test and its own card body;
   * a game that does not is routed through the unchanged branch exactly as before.
   *
   * `matches` is a BUILD comparison and deliberately not a deep equality: the player's
   * name / team / number are theirs and are copied across when a card is applied, so a
   * card must still read as selected afterwards. Each game supplies its own because
   * each game's build is a different set of fields — DECODE ignores the mount fields,
   * Chain Reaction ignores flywheel inertia.
   */
  presets?: {
    /** the shipped builds, in display order. */
    list: readonly RobotSpec[];
    /** does `spec` carry this preset's BUILD? Identity fields are excluded — see above. */
    matches(spec: RobotSpec, preset: RobotSpec): boolean;
    /** the detail lines under the preset's name. `meta` is the build; `zone` is the
     * one-line "what it is for", rendered with the same emphasis DECODE gives its
     * optimised-range line. Absent `zone` simply renders nothing. */
    lines(preset: RobotSpec): { meta: string; zone?: string };
    /** how many LEADING entries are real, documented robots rather than archetype
     * demos. The builder rules off after them so a player can tell "this is a real
     * team's robot" from "this is what a drum shooter feels like". Absent ⇒ all demos.
     * Mirrors Chain Reaction's `CHAIN_REAL_PRESETS`. */
    realCount?: number;
  };
  /**
   * DEV-ONLY routes this game mounts under `/<id>/...` (the BIOBUZZ scene gallery).
   *
   * Rendered only on the ALPHA channel: they are development instruments, they draw
   * through the real renderers with no auth or session behind them, and a stable
   * build must not carry a URL that opens one.
   */
  devRoutes?: readonly GameDevRoute[];
}

/** props for `GameModule.Builder` */
export interface GameBuilderProps {
  spec: RobotSpec;
  /** apply a PARTIAL spec change (the caller owns storage + coercion) */
  onChange(patch: Partial<RobotSpec>): void;
  game: GameId;
}

/** props for `GameModule.Preview` — matches `RobotPreview` / `ChainRobotPreview` */
export interface GamePreviewProps {
  spec: RobotSpec;
  /** rendered edge length in px */
  size?: number;
}

/** props for the live-HUD slots (`hudChips`, `scoreBar`) */
export interface GameHudProps {
  hud: HudSnapshot;
}

/**
 * One tile in the builder hero's stat grid (`GameModule.statTiles`).
 *
 * `label` and `sub` are written in SENTENCE CASE and rendered uppercase by `.ds-stat .sl`
 * — the caption is a category, not a heading, so the CSS owns the casing and a caller
 * that shouted its own would be the only one on the row that did.
 */
export interface GameStatTile {
  /** the tile's value. A WORD here rather than a number — the consumer renders it with
   * the repo's `.sv.sm` bare-word modifier, same as the drivetrain tile beside it. */
  value: string;
  /** the caption under the value ("launcher"). */
  label: string;
  /** an optional SECOND caption line, for a fact the value has no room for: where the
   * mechanism is mounted, what it is dialled to. Absent renders nothing. */
  sub?: string;
}

/** one results-screen section: a heading and its rows, each `[label, mine, opp]`. */
export type ResultsSection = readonly [string, readonly (readonly [string, number, number])[]];

/** which `RobotCommand` action a touch button holds down. A genuinely new game
 * action needs a protocol bit as well — see the netcode section of CLAUDE.md. */
export type MobileActionField = 'intake' | 'fire' | 'catalyst' | 'fling' | 'bbNectar';

/** one extra touch action button contributed by a game */
export interface GameMobileButton {
  /** which `mobileLayout` entry positions it (the editor drags THAT key) */
  name: keyof MobileLayout;
  /** ARIA label — never drawn (it does not fit inside an 82px circle) */
  label: string;
  /** the drawn glyph */
  glyph: string;
  /** style class on the button */
  cls: string;
  /** the big primary button (at most one per game) */
  primary: boolean;
  field: MobileActionField;
  /**
   * Does THIS build have the mechanism right now? Absent means always.
   *
   * It reads `HudSnapshot.gameHud` — the game's own HUD slice — rather than the
   * spec, because that is the shape the live HUD already carries to the touch
   * layer (CR's inline `hasFling` prop is the same fact by hand). A button that
   * does nothing is worse than no button on a phone-sized screen.
   */
  present?(gameHud: unknown): boolean;
}

/**
 * Props every start editor takes. DECODE's `StartPositionEditor` and CR's
 * `ChainStartEditor` already agree on all of these. `onChange` is typed with the
 * NULL (clear the custom pose, fall back to the named anchor) because DECODE
 * accepts it, and a component that only ever handles a real pose still satisfies
 * the slot.
 */
export interface StartEditorProps {
  spec: RobotSpec;
  alliance: Alliance;
  /** the active CUSTOM pose (canonical frame), or null to use the `startIndex` anchor */
  value: StartPose | null | undefined;
  startIndex: number;
  category: StartCat;
  saved: { close: StartPose[]; far: StartPose[] };
  /** a 2v2 role: fixes the category and hides the tabs */
  lockedCategory?: StartCat;
  onChange: (pose: StartPose | null) => void;
  /** the parent MUST set `startIndex` AND clear `startPose` in ONE update */
  onPickPreset: (i: number) => void;
  onCategory: (cat: StartCat) => void;
  onSave: (pose: StartPose) => void;
  onDeleteSaved: (cat: StartCat, i: number) => void;
  size?: number;
}

/** one alpha-only dev route mounted under this game's URL prefix */
export interface GameDevRoute {
  /**
   * The path UNDER the game prefix, leading slash included: `/gallery`.
   *
   * A trailing `/*` matches the base AND every path beneath it (`/gallery/*` takes
   * `/gallery` and `/gallery/pile-fast`), for an instrument that routes its own
   * sub-paths — the component reads the remainder off `window.location` itself.
   * `devRouteFor` in `App.tsx` is the matcher.
   */
  path: string;
  Component: ComponentType;
}
