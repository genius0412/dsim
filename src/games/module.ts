import type { ComponentType } from 'react';
import type {
  Alliance,
  Artifact,
  RobotSpec,
  RobotState,
  StartCat,
  StartPose,
  Vec2,
  World,
} from '../types';
import type { HudSnapshot } from '../game';
import type { GameId, GameSimModule, GameUiSpec } from './types';
import type { TutorialSpec } from '../tutorial/types';

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
  /**
   * THE SAME IDEA ON THE 3D OVERLAY PASS — drawn on the 2D canvas that sits above a live scene
   * (`Renderer.drawProjectedOverlay`), where there is no field drawing underneath and the
   * context's transform is SCREEN pixels rather than field inches. BIOBUZZ fills it with the
   * FLOWER contents read-out over the top-down shot (`biobuzz/drawFlowerReadout.ts`).
   *
   * ⚠️ **A SLOT OF ITS OWN, AND NOT A THIRD ARGUMENT ON `drawOverlays`.** That was tried and it
   * is a trap: `drawOverlays` is written in FIELD INCHES, a game that ignores the extra argument
   * keeps compiling, and DECODE's ramp strips were duly drawn — in world coordinates, onto a
   * screen-pixel transform, off the side of the canvas. An OPTIONAL SECOND SLOT cannot do that,
   * because a game that has no 3D view simply does not fill it, which is DECODE and Chain
   * Reaction. Absent ⇒ nothing is drawn, exactly as before this existed.
   */
  drawSceneOverlay?(ctx: CanvasRenderingContext2D, world: World, view: SceneOverlayView): void;
  /** per-robot sprite. DECODE omits it (the shared `drawRobot` is used); CR provides its
   * own so the archetype launcher + intake design read correctly. `screenUp` lets CR bob the
   * chassis up onto a beam it's crossing. `world` is optional and read-only — CR's rail-turret
   * claw TRACKS a live target, so its sprite needs to see where the loose rings are. */
  drawRobot?(
    ctx: CanvasRenderingContext2D,
    r: RobotState,
    intakeOn: boolean,
    held: readonly Artifact[],
    screenUp?: Vec2,
    world?: World,
  ): void;
  /** scoring-elements renderer, drawn after the robots (DECODE: balls; CR: particles
   * + catalysts + endgame badges). `screenUp` is world-space "up" for z-lift.
   *
   * `localRobotId` is the LAST thing drawn over the field, and it is optional for the reason
   * every other slot argument here is: DECODE and Chain Reaction ignore it and are unchanged.
   * BIOBUZZ needs it because its shot path is a per-DRIVER instrument — whose shot it is is not
   * on `World` — and this is the only per-frame hook that is drawn after the robots AND carries
   * `screenUp`, which a path with a height has to have. Absent for a spectator or a replay of
   * somebody else's match. */
  drawBalls(ctx: CanvasRenderingContext2D, world: World, screenUp: Vec2, localRobotId?: number): void;
  ui: GameUiSpec;
  /**
   * THE LAZY 3D SCENE (Day 1 seam, `docs/biobuzz/plan-3d.md` §2.3/§2.5) — absent ⇒ this game
   * has no 3D renderer, which is DECODE and Chain Reaction today. A FUNCTION rather than the
   * factory itself, so the Three.js chunk is only ever `import()`-ed the moment a 3D view is
   * actually mounted: a player who never opens a 3D BIOBUZZ view never downloads it, exactly
   * like `sim3d/engine.ts`'s `initPhysics3d()` on the physics side.
   */
  scene?: () => Promise<GameSceneFactory>;
  /**
   * THE ROBOT PREVIEW'S 3D SCENE (`docs/roadmap.md` item 1) — absent ⇒ this game's builder has
   * only its 2D schematic, which is DECODE and Chain Reaction today.
   *
   * A SECOND loader beside `scene` rather than a field on it, for the reason `scene` is a
   * function at all: a player who never opens the 3D preview never downloads Three.js. It is
   * declared here, and filled in the game's own `index.ts`, so that ALL of a game's dynamic
   * `import()`s of its renderer live in one file — which is the property `scripts/smoke-biobuzz/
   * render.ts` asserts, and the reason a builder component can reach the chunk without an import
   * that would drag it into the main bundle.
   */
  previewScene?: () => Promise<RobotPreviewFactory>;

  // ---------------------------------------------------------------- UI slots --

  /** the game's own builder panel, rendered by `Menu` in place of the per-game
   * inline block. It gets ONE patch callback rather than a settings setter: a
   * builder must not know where a spec is stored. */
  Builder?: ComponentType<GameBuilderProps>;
  /** game-owned rows at the end of the robot page's DRIVING panel (BIOBUZZ: where PASS throws).
   * Same props as `Builder`: they edit the spec through the same patch callback. */
  DrivingRows?: ComponentType<GameBuilderProps>;
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
  /** a line PINNED above the event log's toasts while some live countdown is running (a PIN's
   * clock ticking down, say) — the log itself only ever shows things that already happened, so
   * a running countdown would otherwise have to re-fire as a new toast every tick, and it does
   * not have that shape (BIOBUZZ). The component reads its own condition and renders `null`
   * when there is nothing to pin, exactly like `hudChips`. */
  pinnedNotice?: ComponentType<GameHudProps>;
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
  /**
   * ⚠️ TOUCH BUTTONS ARE NOT A MODULE SLOT ANY MORE. A game's own touch buttons live in
   * `src/games/<id>/mobile.ts` and are read through `src/ui/mobileActions.ts`, whose set is
   * DERIVED from `ACTION_GAMES` and whose coverage `npm test` asserts. As a slot here they
   * were optional, so four BIOBUZZ actions shipped with no way to press them on a phone; as
   * a table keyed by action they cannot be forgotten. The other reason is plainer: this
   * interface pulls in the canvas renderers, and the coverage check has to run headless.
   */
  /** `false` when this game has no auto-fire assist, which hides `Menu`'s Auto fire toggle. The
   * game's sim must also ignore the flag (BIOBUZZ forces it false at spawn). Absent means the
   * toggle is offered, as it is for DECODE and Chain Reaction. */
  offersAutoFire?: boolean;
  /** the game's start-position editor, used in place of the
   * `isDecode ? StartPositionEditor : ChainStartEditor` branch. */
  startEditor?: ComponentType<StartEditorProps>;
  /** the Autonomous section's PREVIEW (`src/ui/AutonomousSetup.tsx`): a Zenith auto drawn on this
   * game's own field. Absent means a game that plays no Zenith autos (`GameSimModule.zenithAutos`). */
  autoPreview?: ComponentType<AutoPreviewProps>;
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
   * Returns DATA, not markup, for the reason `resultsRows` does: the builder owns how a
   * mechanism is printed, and a game contributing one cannot drift it.
   *
   * ⚠️ NO LONGER TILES ON SCREEN (2026-09-22). The hero's chip wall is gone; each entry is now a
   * WORD in `buildWords` (`src/ui/robotLabels.ts`) — `value, sub` — which is the build line under
   * the hero's team and the one line on every robot card. The shape stayed so the vocabulary
   * stayed: `value`/`sub` are still what this game says about its mechanisms, and `label` is
   * what the checks assert those words are about.
   */
  statTiles?(spec: RobotSpec): readonly GameStatTile[];
  /**
   * THE THUMBNAIL ON ONE SAVED-ROBOT CARD — beside the name, in the builder's garage.
   *
   * It is a COMPONENT because what belongs there is a picture the game renders: BIOBUZZ shows a
   * 3D thumbnail of the saved build when the device is on the 3D view (`docs/roadmap.md` item 1)
   * and NOTHING on the 2D one, where the card is its name and build line alone. The choice is the
   * GAME's, not the menu's — the menu does not know what a 3D view is, and a `showThumbnail`
   * boolean threaded through it would be the shared screen learning one game's rendering model.
   *
   * It used to be the card's whole BODY, and on the 3D view the build line was replaced by the
   * picture — so a saved robot whose image had not rendered (a failed context, a software
   * renderer) was a tall empty card with a name in its corner. The line is the card's now, in
   * every game and on both views; this slot only ever adds a picture beside it.
   */
  savedThumb?: ComponentType<GameSavedCardProps>;
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
   * A game fills this and gets its own list and its own match test; the card's line is
   * `buildWords`, which reads the game's `statTiles`. A game that fills nothing is routed
   * through the unchanged branch exactly as before.
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
    // NO `lines` ANY MORE. A preset card printed a tagline, a spec line and a loadout chip, three
    // readings of one robot; it prints `buildWords` now, the same one line a saved robot prints,
    // which already reads this game's `statTiles`.
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
  /**
   * THIS GAME'S TUTORIAL — a scripted solo practice; absent means the game offers none, and
   * every tutorial surface (the Modes card, the Controls entry) hides itself for it.
   *
   * On `GameModule` and not on `GameSimModule`, deliberately. The sim module is defined as
   * "everything the authoritative server and the headless sim need", and a tutorial is neither:
   * no room runs one, no replay contains one, and the server would never read it. What it DOES
   * need is the player's `ControlBindings`, so that every hint names the keys they actually
   * bound — and that is a client fact.
   *
   * `TutorialSpec` is itself DOM-free (`src/tutorial/types.ts`), so the headless TUTORIAL lane
   * imports a game's tutorial module directly and drives the same steps the browser does.
   */
  tutorial?: TutorialSpec;
}

/** props for `GameModule.Builder` and `GameModule.DrivingRows` */
export interface GameBuilderProps {
  spec: RobotSpec;
  /** apply a PARTIAL spec change (the caller owns storage + coercion) */
  onChange(patch: Partial<RobotSpec>): void;
  game: GameId;
  /**
   * THE ACTIVE SETUP'S ALLIANCE + START, so a per-game builder can answer "where does this
   * robot actually begin" without re-deriving it from `GameSettings` itself (which a DOM-free
   * builder slot never sees). Added for BIOBUZZ's pass-target picker (`DrivingRows`, `bbPassTarget`/
   * `bbPassPreset`, `PassPicker.tsx`): `pastGoal`/`farEnd` are relative to the THROWER, and the
   * thrower's honest position is its configured start anchor, not a guess.
   *
   * Optional and unread by DECODE/Chain Reaction's inline builder branches and by any
   * `Builder` slot that has no use for a start pose — passing them costs a filled game nothing.
   * `startIndex`/`startPose` mirror `GameSettings`' own pair (a set `startPose` overrides the
   * anchor), so a slot that DOES want the start reads the same "custom pose wins" contract the
   * spawner and the start editor already use.
   */
  alliance?: Alliance;
  startIndex?: number;
  startPose?: StartPose | null;
}

/** props for `GameModule.Preview` — matches `RobotPreview` / `ChainRobotPreview` */
export interface GamePreviewProps {
  spec: RobotSpec;
  /** rendered edge length in px */
  size?: number;
  /** print the `W" wide · L" long` line under a 2D schematic. Absent ⇒ printed. The builder hero
   * turns it off: at its 88px the line was 5px type, and the hero states the size itself. */
  caption?: boolean;
  /**
   * Whose robot this is. A 2D schematic has no use for it (both current ones draw in neutral
   * `ds-*` tokens), but a 3D preview does: the alliance is the chassis outline and the sign
   * panel, so a preview without one would be the only place this game draws a robot with no
   * alliance at all. Absent ⇒ the game's own default.
   */
  alliance?: Alliance;
  /**
   * MAY this host mount a live 3D scene? Opt-IN, and it is a statement about the HOST, not a
   * preference: the builder hero is one preview on screen at a time and can afford a WebGL
   * context, while the 2v2 strategy screen renders FOUR preview cards at once and a context each
   * would put it near the browser's own cap for no gain — that screen wants a picture of a robot,
   * not a turntable. Absent ⇒ no live scene, which is every host that existed before this.
   */
  allow3d?: boolean;
}

/**
 * props for `GameModule.savedThumb` — the thumbnail on one saved-robot card in the builder's garage.
 */
export interface GameSavedCardProps {
  spec: RobotSpec;
  alliance: Alliance;
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
  /** the build has NO such mechanism. The builder's tile still says so, because the slot is a
   * choice there; a robot card's one-line summary leaves it out rather than list an absence. */
  absent?: boolean;
}

/** one results-screen section: a heading and its rows, each `[label, mine, opp]`. */
export type ResultsSection = readonly [string, readonly (readonly [string, number, number])[]];

/**
 * Props every start editor takes. DECODE's `StartPositionEditor` and CR's
 * `ChainStartEditor` already agree on all of these. `onChange` is typed with the
 * NULL (clear the custom pose, fall back to the named anchor) because DECODE
 * accepts it, and a component that only ever handles a real pose still satisfies
 * the slot.
 */
/** A Zenith auto, already planned for the robot's alliance, as the Autonomous preview draws it. */
export interface AutoPreviewProps {
  spec: RobotSpec;
  alliance: Alliance;
  /** the planned path, one polyline per path step, in the robot's ACTUAL frame (inches) */
  legs: { id: string; points: { x: number; y: number }[] }[];
  /** where the auto starts, and each path step's end, actual frame (heading in radians) */
  poses: { x: number; y: number; heading: number }[];
  /** the path the robot really drove, when a run has been recorded */
  driven?: { x: number; y: number }[];
  /** the leg to emphasise (the step the HUD or the list points at) */
  focus?: string | null;
  size?: number;
}

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
  /**
   * how many saved poses per role this player may keep (`savedStartCap`, the supporter perk).
   * Passed in by the HOST screen rather than read in the editor: the perk comes from the ads
   * context, and `src/ads/adsense.ts` reads `import.meta.env` at load, which a game module's
   * editor must not drag into the headless test suites. Absent ⇒ the free cap.
   */
  maxSaved?: number;
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

// ---------------------------------------------------------------- 3D scene contract --
//
// The CLIENT-SIDE half of the 3D renderer seam (Day 1, `docs/biobuzz/plan-3d.md` §2.3):
// declared additively here so a later renderer lane can fill `GameModule.scene` and a
// later controller lane can drive it, without either waiting on the other. DECODE and
// Chain Reaction register no `scene` and are untouched by any of this.

/**
 * Which camera a 3D scene renders for (`docs/biobuzz/plan-3d.md` §4.3).
 *
 * `driver` is the driver's own station view and `overhead` the fixed orthographic shot (the 2D
 * fit) — the two the controller itself picks between. `chase` and `orbit` are DAY 2 additions
 * and the controller never names them: they are reached through the device's own camera
 * preference (`src/games/biobuzz/graphics/store.ts`), which the scene resolves against the
 * `camera` the frame carries. Adding them here rather than keeping them scene-private is what
 * lets a host (the scene gallery, a replay screen, a later Graphics section) ask for one
 * directly without a second vocabulary for the same four cameras.
 *
 * A scene that cannot honour one falls back rather than throwing — `chase` with no
 * `localRobotId` (a spectator, a replay of someone else's match) has nothing to chase, and
 * BIOBUZZ's scene renders `overhead` instead.
 *
 * `free` (owner, 2026-09-21) is a fifth, MOUSE-DRIVEN camera reached the same way as `chase`/
 * `orbit` — never picked by a controller, only through the device's camera preference or an
 * explicit export choice. Its own state (`src/games/biobuzz/graphics/freeCam.ts`) lives outside
 * `three` entirely, which is what lets it be unit-tested with no GPU.
 */
export type SceneCamera = 'driver' | 'overhead' | 'chase' | 'orbit' | 'free';

/**
 * The HUD's OCCUPIED BANDS over the render surface, in CSS pixels, measured off the live DOM
 * (`GameController.refreshHudInsets`).
 *
 * The 3D canvas fills the whole `.game-viewport`, but the score bar, the breakdown chips, the
 * status chips and the MENU/RESET buttons are absolutely positioned ON TOP of it — so "fit the
 * field to the canvas" frames part of the field underneath chrome that hides it. That is the
 * owner's report of 2026-09-18 ("the scoreboard overlaps the field"). These four numbers are how
 * much of each edge is spoken for; the SAFE RECT the field must fit into is
 * `[left, width − right] × [top, height − bottom]`.
 *
 * ABSENT (or all-zero) READS AS NO CHROME, which is what keeps this additive: a scene written
 * before this existed, or a host that does not measure (the scene gallery, a preview harness),
 * fits to the full canvas exactly as it did.
 *
 * ⚠️ These are bands, NOT a per-element occlusion map. An element in a CORNER reserves a band
 * across the whole edge it is nearest — cheap, stable, and it cannot leave a gap the way a
 * per-element solve would when the HUD relayouts mid-frame.
 */
export interface SceneInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * One frame's render inputs — everything a `GameScene` needs that is not already on `world`.
 * `alpha` is the interpolation fraction between the last two authoritative ticks (the same
 * fixed-timestep smoothing the 2D renderer does); `localRobotId` is absent for a spectator.
 */
export interface SceneFrame {
  alpha: number;
  viewAngle: number;
  camera: SceneCamera;
  localRobotId?: number;
  /**
   * The LOCAL PLAYER's own start category (`close`/`far`) — the same field the HUD and the
   * start editor read, carried here so a scene can resolve a TOP/BOTTOM drive-station role for
   * `localRobotId` without a second lookup (BIOBUZZ's height-accurate driver camera,
   * `docs/area/biobuzz.md`'s "BIOBUZZ 3D" section: `graphics/driverEye.ts`). It is a fact about
   * THIS CLIENT's own settings, not the network, so it means nothing without `localRobotId`
   * alongside it and every other game ignores it. Absent for a spectator, same as
   * `localRobotId`.
   */
  localStartCat?: StartCat;
  width: number;
  height: number;
  dpr: number;
  /**
   * The HUD's occupied bands (see `SceneInsets`) — absent ⇒ none, fit to the whole canvas.
   *
   * The OBJECT IS REUSED across frames by the controller (zero per-frame allocation at 144 Hz),
   * so a scene must read the four numbers during `render` and never retain the reference.
   */
  insets?: SceneInsets;
}

/**
 * A persistent 3D scene over one canvas, owned by the controller for as long as a 3D view is
 * mounted. The renderer lane fills an implementation (Three.js); the controller lane calls
 * `render`/`resize`/`dispose` from its own loop. It reads `World`, it never writes it.
 */
/**
 * WHAT A GAME'S `drawOverlays` IS TOLD WHEN IT IS CALLED OVER A LIVE 3D SCENE (2026-09-21).
 *
 * The 2D canvas sits above the WebGL one and keeps drawing the cheap overlays
 * (`Renderer.drawProjectedOverlay`). On that pass the context's transform is the plain DPR scale
 * — CSS PIXELS, not field inches — and there is no field drawing underneath, so a game that
 * wants to put something over the 3D shot needs three things it cannot work out for itself:
 * WHICH camera is live (a read-out that belongs on a top-down shot is nonsense on a driver's),
 * the `viewAngle` the shot is oriented by, and `project`.
 *
 * `project` is `GameScene.project`, already bound to its scene — the caller passes it on rather
 * than handing over the scene, so a game module never holds a reference to a renderer it does
 * not own.
 */
export interface SceneOverlayView {
  /** the camera the scene actually RENDERED this frame — the resolved one, after the device's
   * own camera preference has been applied over what the host asked for. */
  camera: SceneCamera;
  /** the frame's view angle (`SceneFrame.viewAngle`) — which alliance's wall is at the bottom. */
  viewAngle: number;
  /** the canvas's device pixel ratio, already applied to the context's transform. A caller that
   * wants to compose its own transform (a projected affine, say) has to re-apply it. */
  dpr: number;
  /** `GameScene.project`, bound: field inches + height → CSS pixels on this canvas. */
  project(x: number, y: number, z: number, out: { x: number; y: number; visible: boolean }): void;
}

export interface GameScene {
  readonly element: HTMLCanvasElement;
  render(world: World, frame: SceneFrame): void;
  resize(width: number, height: number, dpr: number): void;
  dispose(): void;
  /**
   * PROJECT a field point through the scene's ACTIVE camera, into CSS pixels on the 2D overlay
   * canvas above it (Day 2, `docs/biobuzz/plan-3d.md` §4.7).
   *
   * The 2D canvas stays mounted over a live scene and keeps drawing the cheap overlays — the
   * name/team labels, an auto path, the replay burn-in — but its own `Camera` is the TOP-DOWN
   * one, so in a 3D view every one of those lands where the robot would have been on the flat
   * map: metres away from the robot on screen, and with no notion of "behind the camera" at
   * all. This is the one number the overlay pass cannot work out for itself, because only the
   * scene knows the live camera, its `setViewOffset` window and which of its four cameras is
   * currently active.
   *
   * `x`/`y` are field inches, `z` is height above the tiles (the same frame `World` uses).
   * `out` is written IN PLACE and is the caller's own object, reused across every label in a
   * frame — a projection that allocated a vector per call would allocate one per robot per
   * frame at up to 144 Hz. `visible` is false when the point is behind the camera or outside
   * the frustum, and `x`/`y` are then meaningless (the caller skips the draw).
   *
   * OPTIONAL, so this stays additive: a scene that does not implement it leaves the overlay
   * drawing exactly what it drew before, through the 2D camera.
   */
  project?(x: number, y: number, z: number, out: { x: number; y: number; visible: boolean }): void;
  /**
   * WHICH camera the last `render` actually used — the RESOLVED one (the device's camera
   * preference applied over the host's pick), not what the host asked for.
   *
   * The overlay pass needs it and cannot derive it: `SceneFrame.camera` is the host's REQUEST,
   * and on an interactive scene the player's own preference wins over it (`resolveSceneCamera`),
   * so a caller reading the frame would be told `overhead` while a driver camera was on screen.
   *
   * OPTIONAL, like `project`. A scene that does not report one is read as `'driver'`, which is
   * the answer that draws the LEAST: an overlay placed for the wrong camera is worse than one
   * that is missing, and every scene before this existed drew none of them.
   */
  readonly camera?: SceneCamera;
}

/**
 * What a HOST can tell a scene at construction (Day 3, additive — every field is optional and a
 * factory called with no options behaves exactly as it did before this existed).
 *
 * There are three hosts and they want different things: the live game view wants a scene that
 * takes the keyboard and reports quality changes into the match's event log; a replay export
 * wants a fixed quality and no input at all; the gallery wants a still.
 */
export interface SceneOptions {
  /**
   * ONE LINE for the player, from the renderer.
   *
   * The scene has no access to `world.events` — it takes a `World` and never writes it, which
   * is the contract that keeps a renderer out of the simulation — but §4.6 asks for an
   * event-log line in three situations it is the only thing that can detect: Auto picking a
   * preset, the in-match slip rule lowering one, and a software renderer or a failed HDRI
   * sending the view back to 2D. So it hands the line OUT and the host decides where a line
   * goes. Absent ⇒ the scene stays silent (and still logs a real failure to the console).
   */
  onQualityEvent?(line: string): void;
  /**
   * FIX the quality tier, ignoring (and not subscribing to) the device's own graphics
   * preference. A video export is the case this exists for: §4.7 fixes exports at High so the
   * file does not come out at whatever the machine that made it happened to be set to, and so
   * that a settings change mid-encode cannot change the resolution of a video halfway through.
   */
  quality?: 'low' | 'medium' | 'high' | 'ultra';
  /**
   * `false` for a scene nobody is driving — an export, a still, a thumbnail. It binds no keys
   * and no pointer handlers, which matters because those are WINDOW-level: an off-screen export
   * scene that installed the view key would have the player's `t` press swap a view they cannot
   * see while their video encoded.
   */
  interactive?: boolean;
}

/** builds a `GameScene` inside `host` (the DOM node the controller mounts it in). May be
 * async because a real implementation loads the Three.js chunk + HDRI on first use.
 *
 * `options` is ADDITIVE (Day 3): an existing caller passing only `host` is unchanged. */
export type GameSceneFactory = (host: HTMLElement, options?: SceneOptions) => GameScene | Promise<GameScene>;

/**
 * What a HOST can tell a ROBOT PREVIEW scene at construction. Same additive rule as
 * `SceneOptions`: a factory called with only `host` behaves as it did before any of this existed.
 */
export interface RobotPreviewOptions {
  /** FIX the quality tier, ignoring the device's graphics preference — a cached thumbnail must
   * not change because a settings screen was opened somewhere else. */
  quality?: 'low' | 'medium' | 'high' | 'ultra';
  /** `false` binds no pointer handlers: a scene nobody is driving (a thumbnail). */
  interactive?: boolean;
  /** `false` runs no frame loop at all — the scene draws only when `capture()` asks it to. */
  animate?: boolean;
  /** the WebGL context was lost and the scene has disposed itself; the host shows its fallback */
  onContextLost?: () => void;
}

/**
 * A persistent preview of ONE robot over one canvas, owned by the component that mounted it.
 *
 * It takes a SPEC, never a `World`: a builder has no match, and the point of the seam is that the
 * same generator draws the same robot in both places (`scene/renderPreview.ts`'s header).
 */
export interface RobotPreviewScene {
  readonly element: HTMLCanvasElement;
  /** show this build. Cheap to call on every render — an unchanged build rebuilds nothing. */
  setSpec(spec: RobotSpec, alliance: Alliance): void;
  /** fix or release the quality tier (`null` follows the device preference again). */
  setQuality(tier: 'low' | 'medium' | 'high' | 'ultra' | null): void;
  resize(width: number, height: number, dpr: number): void;
  /** ONE frame at `size`x`size` CSS pixels, synchronously, as a PNG data URL. */
  capture(size: number): string;
  /** resolves once the first build's shaders are compiled off the main thread */
  ready(): Promise<void>;
  dispose(): void;
}

/** builds a `RobotPreviewScene` inside `host`. Synchronous: unlike the match scene it loads no
 * GLB, so once the chunk is here there is nothing left to await. */
export type RobotPreviewFactory = (host: HTMLElement, options?: RobotPreviewOptions) => RobotPreviewScene;
