import type { GameMode, GameSettings, RobotCommand, World } from '../types';
import type { RobotSetup } from '../sim/spawn';
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
  bounds: FieldBounds;
  colliders: FieldColliders;
  createWorld(mode: GameMode, seed: number, setups: RobotSetup[], settings?: GameSettings): World;
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
}
