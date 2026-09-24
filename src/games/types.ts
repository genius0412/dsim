import type {
  Alliance,
  Artifact,
  GameMode,
  GameSettings,
  RobotCommand,
  RobotSpec,
  RobotState,
  StartPose,
  World,
} from '../types';
import type { RobotSetup } from '../sim/spawn';
import type { RobotSolids } from '../sim/artifactSolids';
import type { IntakeStyle } from '../types';

/**
 * The GAME-ABSTRACTION seam (DOM-free core types).
 *
 * The simulator hosts more than one FTC-style game (DECODE, Chain Reaction, …).
 * Everything GENERIC — the drivetrain/motor model, the Rapier robot solver,
 * contact-torque square-up, the match phase machine, robot rendering — is shared.
 * Everything GAME-SPECIFIC lives behind a game module.
 *
 * The module is split in two so the SERVER (no DOM) can import the simulation half
 * without dragging in the browser-only renderers:
 * - `GameSimModule` (this file): id/scored/bounds/colliders/createWorld/step —
 *   everything the authoritative server + headless smoke need. NO DOM types.
 * - `GameModule` (`./module.ts`): `GameSimModule` + `drawField`/`drawOverlays`/`ui`
 *   (canvas rendering). Client-only.
 *
 * Design rules:
 * - DECODE's existing `src/sim/*` + `src/render/*` are NOT relocated; the DECODE
 *   module just references them. A new game is a new `src/games/<id>/` tree.
 * - Modules produce PLAIN-NUMBER collider specs (`StaticSpec`) — never Rapier.
 *   `physicsEngine.ts` owns RAPIER and turns specs into bodies.
 * - The shared Rapier robot solve + camera are PARAMETERIZED on a module's
 *   `bounds`/`colliders`, so a game with a different field size just works.
 */

export type GameId = 'decode' | 'chain' | 'biobuzz';

/**
 * EVERY game id, in display order (DECODE first — it is also the fallback).
 *
 * This list, not a hand-written literal, is what every "which games are there"
 * site must read: the route regex, the settings allowlists, the loadout archive
 * loop, the server's untrusted-`game` coercion. Before it existed those sites
 * were two-valued ternaries (`x === 'chain' ? 'chain' : 'decode'`), so a THIRD
 * id silently degraded to DECODE — a player queued for it, got a DECODE room,
 * and nothing anywhere said so.
 */
export const GAME_IDS: readonly GameId[] = ['decode', 'chain', 'biobuzz'] as const;

/** is `x` a known game id? (the allowlist form — use it where an absent/unknown
 * value must stay absent rather than become DECODE) */
export function isGameId(x: unknown): x is GameId {
  return typeof x === 'string' && (GAME_IDS as readonly string[]).includes(x);
}

/**
 * Force an untrusted value to a known game id.
 *
 * The DOWNGRADE form, and the one the wire/URL/query-string sites want: an
 * unknown or missing `game` becomes `fallback` (DECODE by default), which is the
 * repo's single back-compat rule — old worlds, snapshots and replays carry no
 * `game` field at all, and both module resolvers already answer DECODE for them.
 */
export function coerceGameId(x: unknown, fallback: GameId = 'decode'): GameId {
  return isGameId(x) ? x : fallback;
}

/**
 * WHICH PHYSICS BACKEND A WORLD STEPS ON — the shared Rapier 2D solve every game runs today
 * (`'2d'`), or the deterministic Rapier 3D solve BIOBUZZ's Day 1 seam adds (`'3d'`,
 * `docs/biobuzz/plan-3d.md`). Declared here — the DOM-free seam file the server imports —
 * because a room's physics choice is a server/matchmaking fact, not a rendering one.
 *
 * Absent everywhere (a world, a spec, a setting) reads as `'2d'`: the 2D pipeline is
 * PERMANENT and every stored world/snapshot/replay predates this field.
 */
export type Physics = '2d' | '3d';

/**
 * WHICH PHYSICS EVERY SERVER-CONNECTED MATCH OF THIS GAME RUNS ON (owner ruling, 2026-09-18).
 *
 * A game that can step `'3d'` runs `'3d'` for everything that reaches the server: record runs,
 * ranked, matchmade, custom rooms, spectators, LAN. Nobody chooses — not the host, not a
 * client's settings, not a query param. The reason is the record board: two solves feeding one
 * board is two boards wearing one hat, and the alternative (split the eras into two seasons)
 * archives everybody's standings over a physics change they did not ask for.
 *
 * A game with no `'3d'` option is `'2d'` and is therefore byte-identical to what it always was,
 * which is DECODE and Chain Reaction.
 *
 * OFFLINE is the exception and is not this function's business: solo practice and free drive
 * still honour `GameSettings.practicePhysics`, because the 2D pipeline is permanent and a
 * low-end machine has to be able to drive. Nothing offline reaches a board.
 *
 * Takes the MODULE rather than a `GameId` so both registries can call it — the server-safe one
 * (`games/sim.ts`) and the client's full one (`games/index.ts`) — without this file importing
 * either and closing a cycle.
 */
export function serverPhysics(mod: Pick<GameSimModule, 'physicsOptions'> | undefined): Physics {
  return mod?.physicsOptions?.includes('3d') ? '3d' : '2d';
}

/** one static cuboid collider, as plain numbers (Rapier-independent). Moved out
 * of physicsEngine.ts so any game module can produce field geometry. */
export interface StaticSpec {
  hx: number;
  hy: number;
  tx: number;
  ty: number;
  rot: number;
}

/** rectangular field half-extents + fit margin — consumed by the camera (fit the
 * field to the viewport) and the ground/robot wall clamps. Inches. */
export interface FieldBounds {
  halfX: number;
  halfY: number;
  viewMargin: number;
}

/** a game's static field geometry plus any per-step dynamic colliders. */
export interface FieldColliders {
  /** perimeter walls + game structures (DECODE: goal-face hypotenuses +
   * classifier channels). CONSTANT numbers → identical colliders each build →
   * determinism preserved. Compute once at module load. */
  statics: StaticSpec[];
  /**
   * The PERIMETER, as a hard containment invariant rather than merely a collider.
   *
   * `solveRobots` uses it to guarantee that a robot which began a tick inside the field cannot
   * be pushed out of it — the same guarantee `clampBallPosToStatics` gives artifacts, and for
   * the same reason: a soft contact against a body that will not yield is not enough on its
   * own. It says nothing about a robot that was ALREADY outside (a seeded pose, a probe on the
   * outflow mouth); containment keeps you in, it does not teleport you in.
   */
  bounds: { halfX: number; halfY: number };
  /** per-step dynamic cuboids (DECODE: the physical gate handles). Omit for a
   * game with no moving field geometry (CR shell). `gateCol` is DECODE's
   * anticipated gate-lift fraction per alliance. */
  dynamic?(world: World, dt: number, gateCol?: Record<'red' | 'blue', number>): StaticSpec[];
}

/** builder/HUD metadata: how the menu + in-match chrome adapt to this game.
 * (DOM-free — just flags/lists; the actual renderers live on `GameModule`.) */
export interface GameUiSpec {
  /** show the full score bar / breakdown / motif HUD (false ⇒ minimal chrome) */
  showScoreHud: boolean;
  /** show the G304 start-position editor (false ⇒ hidden; game has no legality yet) */
  startEditor: boolean;
  /** intake presets offered in the builder for this game */
  intakes: readonly IntakeStyle[];
}

/**
 * The SIMULATION half of a game (DOM-free): everything the authoritative server
 * and the headless sim need. The client's full `GameModule` (./module.ts) extends
 * this with the canvas renderers + builder metadata.
 */
export interface GameSimModule {
  id: GameId;
  /** false ⇒ a shell with no scoring: never persist ELO/records, minimal HUD.
   * (Still runs full multiplayer — the schema/protocol are game-keyed already.) */
  scored: boolean;
  /** does this game have start-position LEGALITY (DECODE G304)? The server enforces
   * it only for such games; a game without it (CR shell) skips the legality gate. */
  startLegality: boolean;
  /**
   * The competitive ACT this game's very first period opens in (`ensureSeason`).
   *
   * DECODE keeps act 0 — the beta/pre-season bucket it actually ran in — and every
   * later game starts in its own act. It lives on the MODULE because the two callers
   * (`server/persist.ts` at match end, `/api/seasons` in `server/api.ts`) had it as
   * `game === 'chain' ? 1 : 0`, which silently seeds a third game into DECODE's beta act.
   */
  initialAct: number;
  /**
   * How many NAMED start anchors this game offers, i.e. the legal range of a
   * `startIndex` (`0 .. startPoseCount - 1`).
   *
   * The clamps in `coerceStartIndex` (`src/net/sanitize.ts`), `coerceSetup`
   * (`src/sim/spawn.ts`) and `coerceSettings` all read it. They used DECODE's
   * `START_POSES.length` (5) for every game, which CR (4) survived only because 4 < 5 —
   * a game with FEWER anchors than DECODE would accept an out-of-range index off
   * localStorage or the wire and resolve it to whatever its own spawn does with a
   * miss.
   */
  startPoseCount: number;
  /**
   * Is this CANONICAL start pose legal for a robot of this spec on this alliance?
   *
   * THE PREDICATE, where `startLegality` above is the ENFORCEMENT FLAG — a game may answer
   * this and still not have the server refuse a ready-up on it (Chain Reaction does exactly
   * that: its editor checks G04 live, and the server gate stays off). Absent ⇒ the game has
   * no start rule and every pose is legal.
   *
   * It exists because both readers had grown a hand-written branch over the game id, which is
   * the failure mode CLAUDE.md's seam section names: `startSelectionLegal` was
   * `game === 'chain' ? chainStartLegal(…) : activeStartLegal(…)`, so a THIRD game fell into
   * DECODE's arm and had its poses judged against DECODE's launch lines and goal triangles.
   * That is a worse answer than no answer, and it is what kept BIOBUZZ's `startLegality` down
   * after G304 was already modelled.
   *
   * THE POSE IS CANONICAL, not the one the robot will spawn on: every caller holds what is in
   * `RobotSetup.startPose` / `GameSettings.startPose`, and each game mirrors that onto the
   * actual alliance its own way (DECODE reflects in x, BIOBUZZ rotates 180° about the origin).
   * An implementation that forgets to mirror judges red's pose in blue's frame and is wrong on
   * exactly half the field, silently — so mirror first, then assess.
   *
   * A null/absent pose is the game's named anchor, which every game seats legally by
   * construction: answer `true` rather than making each caller special-case it.
   */
  startLegal?(spec: RobotSpec, a: Alliance, startPose: StartPose | null | undefined): boolean;
  /**
   * SEAT a custom CANONICAL start pose legal for this spec + alliance, returning it canonical.
   *
   * `coerceSetup` calls it at the spawn chokepoint, so no path (localStorage, the wire, a staged
   * match, a replay) spawns an illegal robot. Absent ⇒ the pose is kept as structurally
   * validated and field-clamped, and the game's own spawn may fit it further (BIOBUZZ does).
   * It used to be DECODE's `snapStartToLegal` for any game with `startLegality`, which seated a
   * BIOBUZZ pose against DECODE's field and mirrored it in x.
   */
  startSnap?(spec: RobotSpec, a: Alliance, startPose: StartPose): StartPose;
  /**
   * THE START ROLES, for a game whose roles are not DECODE's CLOSE / FAR table. The shared
   * `StartCat` slots ('close' / 'far') carry whatever a game's two roles are; these say which
   * anchor belongs to which, which anchor a role defaults to, and what the roles and anchors are
   * called on screen. Absent ⇒ DECODE's `START_POSES` table and CLOSE / FAR words.
   *
   * They exist for the same reason `startLegal` does: `startPositions.ts`, the role-swap bar and
   * the lobby/strategy start chips each branched `game === 'chain' ? … : <DECODE>`, so BIOBUZZ got
   * DECODE's anchor categories, DECODE's anchor names and CLOSE / FAR for its TOP / BOTTOM roles.
   * Chain Reaction's existing branches are left as they are.
   */
  startAnchorCategory?(index: number): import('../types').StartCat;
  startDefaultIndex?(cat: import('../types').StartCat): number;
  /** `alliance` matters on a point-symmetric field, where the same role slot is drawn at the top
   * for one alliance and the bottom for the other (BIOBUZZ). */
  startRoleLabel?(cat: import('../types').StartCat | undefined, alliance?: Alliance): string;
  startAnchorName?(index: number, alliance?: Alliance): string;
  /**
   * DOES THIS GAME RUN AUTO PATHS?
   *
   * Only DECODE's step drives path traversal — `initializePathTraversal` /
   * `updatePathTraversal` are called from `src/sim/world.ts` and nowhere else, and Chain
   * Reaction and BIOBUZZ have steps of their own. So a `.pp` path imported while one of
   * those games was selected was accepted by the builder, saved to the library, reported
   * "Auto path ON", rode the wire into the match — and then the robot sat still for the
   * whole autonomous period with nothing anywhere saying why.
   *
   * Two readers, and they are the two ends of that path: the builder hides the section for
   * a game that cannot run one (`MatchSetup`), and the spawn chokepoint drops `autoPath` /
   * `autoPathEnabled` for it (`coerceSetup`) so a path already sitting in localStorage or
   * arriving off the wire never reaches a world, a snapshot or a replay.
   */
  autoPaths: boolean;
  /**
   * DOES THIS GAME PLAY ZENITH AUTOS? (docs/area/autos.md)
   *
   * A Zenith `*.auto.json` is driven by an AUTO SEAT (`src/auto/seat.ts`) that the controller,
   * the room and the LAN host run beside the bots, so no step reads it: this flag is for the main
   * chunk, which must not import the lazy `src/auto/games.ts` registry to ask. Its readers are the
   * spawn chokepoint (`coerceSetup` drops `zenithAuto` for a game without it, as `autoPaths` does
   * for `.pp` paths) and the match setup (it hides the Autonomous section). `npm test` holds it
   * equal to "has an adapter in `src/auto/games.ts`" for every game. Absent = false.
   */
  zenithAutos?: boolean;
  bounds: FieldBounds;
  colliders: FieldColliders;
  /**
   * BUILD THE WORLD. `physics` is the ROOM's (or the replay's) backend choice — see `Physics`.
   *
   * ── WHY IT IS A FIFTH PARAMETER AND NOT A FIELD ON `settings` ──────────────
   * Day 1 routed solo practice's pick through `GameSettings.practicePhysics`, which is right
   * for practice and wrong for everything else: a ROOM is not a practice, and the world an
   * authoritative server builds must not depend on a player-owned settings bag at all (the
   * server holds no `GameSettings`, and a client's copy is whatever that client last saved).
   * A room's physics is decided once at room creation, rides `RoomConfig.physics` and
   * `matchStart.physics`, and reaches the builder HERE — one explicit argument, sourced from
   * the room on both ends, so the server and every client in it build the same world.
   *
   * Absent ⇒ the game decides for itself (BIOBUZZ falls back to `settings.practicePhysics`,
   * then `'2d'`). A game with no `physicsOptions` ignores it entirely, which is DECODE and
   * Chain Reaction — their builders take four parameters and stay assignable to this type.
   */
  createWorld(
    mode: GameMode,
    seed: number,
    setups: RobotSetup[],
    settings?: GameSettings,
    physics?: Physics,
  ): World;
  step(world: World, dt: number, commands: Map<number, RobotCommand>): void;
  /**
   * This game's own HUD slice, read once per HUD poll and carried on
   * `HudSnapshot.gameHud`.
   *
   * DOM-free and on the SIM module on purpose: it is a projection of world state
   * for the local robot, nothing more, and putting it here stops `game.ts` growing
   * a named bag per game (`hud.chain` is exactly that, and it stays — the CR HUD
   * reads it in a dozen places and rewriting those is not this change).
   *
   * Typed `unknown` because only the game's own components consume it: they cast
   * it back to their own shape at the one place they read it. A typed generic
   * would have to be threaded through `HudSnapshot`, `GameView`, and every screen
   * that forwards a snapshot.
   */
  hud?(world: World, robotId: number): unknown;
  /**
   * NOTHING LEFT ON THE FIELD CAN CHANGE THE SCORE — read in phase `post` by the shared settle
   * clock (`src/sim/settle.ts`), which finalizes the match once this has held for
   * `MATCH_SETTLE_HOLD_S` (or at `MATCH_SETTLE_MAX_S`, whatever it says). The server saves the
   * score then, and the results screen reveals only on that saved score.
   *
   * A PURE READ of world state — it decides the tick a match is captured on, so it must answer
   * the same on every machine. Absent ⇒ the field counts as settled at once.
   */
  settled?(world: World): boolean;
  /**
   * WHAT ON THIS GAME'S ROBOT IS SOLID TO A GROUND ARTIFACT — the game-owned override of
   * `robotSolids` (`src/sim/artifactSolids.ts`).
   *
   * ABSENT ⇒ the shared `robotSolids`, which is DECODE's hardware: the chassis box plus the
   * funnel WEDGES of `INTAKE_PRESETS` (sloped / triangle) or the vector preset's flank RAILS,
   * always on the FRONT. DECODE and Chain Reaction leave this empty and their consumers
   * (`src/sim/world.ts`) are untouched, so DECODE's solve is byte-identical.
   *
   * It exists because a second game's intake is not DECODE's intake. BIOBUZZ's sweeper is a
   * roller bar that can be mounted on any edge (`intakeMount`: front / back / side /
   * frontback), so with the shared geometry a BIOBUZZ robot met its POLLEN through a DECODE
   * funnel bolted to its front — wedges where the frame is open, and nothing at all on the
   * edge the sweeper is actually on. The mount already moves the collision footprint
   * (`footprintExtents`) and the capture rects (`bbMouths`); this is the third reader of the
   * same mount, and the last one that was still assuming DECODE.
   *
   * `radius` is the game's own ground-element radius, the one its caller also hands
   * `solveArtifacts` — the held-element circles are the plug in the robot's own mouth and two
   * radii in one solve is the disagreement `artifactSolids.ts` exists to prevent.
   *
   * ONE GEOMETRY AUTHORITY still holds: whatever a game returns here is what its artifact
   * solve collides on, what its pin test would measure against, and what its sprite must draw.
   */
  artifactSolids?(r: RobotState, heldBalls: readonly Artifact[], radius: number): RobotSolids;
  /**
   * WHICH PHYSICS BACKENDS THIS GAME'S UI MAY OFFER, for a room or practice setup — absent ⇒
   * only `'2d'`, which is every game before BIOBUZZ's Day 1 seam. BIOBUZZ fills
   * `['2d', '3d']` once `sim3d/` exists to step the second one; DECODE and Chain Reaction leave
   * this empty rather than advertise a physics their `step` cannot run.
   */
  physicsOptions?: readonly Physics[];
  /**
   * A DETERMINISTIC, SCRIPTED DRIVER this game offers as an AI seat — absent ⇒ none. See
   * `BotDriver` below. Nothing implements this yet; the slot exists so the three Day 1 lanes
   * can build toward it without a later type edit.
   */
  bot?: BotDriver;
}

/**
 * ONE SEATED BOT — the object a caller holds for one robot for one match.
 *
 * ⚠️ **THE MEMORY LIVES HERE, AND NEVER ON THE `World`** (`docs/biobuzz/plan-3d.md` §6). A bot
 * has hysteresis: it re-decides on a cadence, holds the decision in between, and remembers
 * what it was doing so it does not oscillate between two equally good targets every tick. All
 * of that is STATE, and the one place it must not be is `world` — a world is snapshotted,
 * delta-encoded to every client 30 times a second, reconciled, and replayed, so a bot field on
 * it would be wire cost on every tick, a thing a reconcile could rewind, and a thing a replay
 * would have to carry to play back. The caller owns the bot; the world stays exactly as wide as
 * it was.
 *
 * `step` returns the command for ONE tick and is called ONCE per tick per seat, by whoever owns
 * the seat: `GameController` in solo practice, `Room` on the server, the host worker on LAN.
 * **The command is RECORDED like a human driver's** — the replay recorder records every setup's
 * command per tick (`docs/area/netcode.md`), so a bot seat's command rides the same array and a
 * replay of a match with a bot in it re-simulates without needing the bot at all.
 *
 * `dispose` releases anything the bot allocated. Optional, because a policy that is pure state
 * has nothing to release; a caller must still call it when the match ends.
 */
export interface BotSeat {
  step(world: World): RobotCommand;
  dispose?(): void;
}

/**
 * A DETERMINISTIC, SCRIPTED DRIVER — an AI seat a room or solo practice can fill instead of a
 * human player.
 *
 * DOM-free and on the SIM module for the same reason `hud` is: the authoritative server needs
 * to run it too, for a room with an empty seat. `tiers` names the DIFFICULTY LEVELS this
 * game's bot offers as opaque strings, so a game can add or rename one without a shared type
 * edit. A driver must read only `world` — the same determinism contract as the rest of
 * `src/sim/` and `src/games/<id>/`: no DOM, no clock, no `Math.random` — and it must NOT read
 * `world.rngState` either, because a bot drawing from the world's own seeded chain would move
 * every later draw in the match (a spill's scatter, a human player's jitter) and a client
 * predicting a tick without the bot would diverge from the server that ran it.
 *
 * ── `create`, NOT `drive` ──────────────────────────────────────────────────
 * `drive(world, id, tier)` — one-shot, memoryless — is still declared, and it is OPTIONAL and
 * deprecated. A driver with hysteresis cannot answer it honestly: it would have to re-decide
 * every tick, which is a different policy from the one `create` runs, so a server calling one
 * and a client predicting with the other would disagree about what the bot did. BIOBUZZ does
 * not implement it; a caller that reaches for it gets a compile error pointing here.
 */
export interface BotDriver {
  readonly tiers: readonly string[];
  /** the tier a UI should preselect and an absent/unknown wire value folds to. */
  readonly defaultTier: string;
  /** force an untrusted tier (localStorage, the wire, a URL) onto `tiers`. */
  coerceTier(x: unknown): string;
  /**
   * SEAT a bot on `robotId`. `seed` is the caller's: the plan's §6 rule is `(matchSeed, seat)`,
   * so every peer that seats the same bot on the same robot of the same match gets the same
   * driver, and two seats of one match get different ones.
   *
   * `world` is the world at seat time — a policy may read the field it is about to play on
   * (which alliance, which spec) but must not keep a reference that outlives the match.
   */
  create(world: World, robotId: number, tier: string, seed: number): BotSeat;
  /**
   * THE ROBOT a bot seat drives, or absent for "the caller's default". A pure function of its
   * arguments — `seed` is the match seed where the caller has one (solo practice, `Room` at
   * START), `robotId` the seat — so every peer that seats the same bot builds the same robot.
   * The result is an ordinary `RobotSpec` that has already passed the game's coercer; it rides
   * the match's setups like a driver's, so a replay needs no bot to rebuild it.
   */
  build?(opts: { seed: number; robotId: number; tier: string; alliance: Alliance }): RobotSpec;
  /** @deprecated memoryless one-shot — see above. Prefer `create`. */
  drive?(world: World, robotId: number, tier: string): RobotCommand;
}
