import type { GameMode, GameSettings, World } from '../../types';
import type { RobotSetup } from '../../sim/spawn';
import type { GameSimModule, Physics } from '../types';
import {
  BB_HALF_X,
  BB_HALF_Y,
  BB_INITIAL_ACT,
  BB_START_POSE_COUNT,
  BB_VIEW_MARGIN,
  bbAnchorCat,
  bbAnchorName,
  bbDefaultIndex,
  bbRoleLabel,
  bbStowLegal,
} from './config';
import { BIOBUZZ_BOT } from './ai';
import { biobuzzColliders } from './colliders';
import { biobuzzHud } from './hudRobot';
import { bbRobotSolids } from './robot';
import { bbSettled } from './settle';
import { createBiobuzzWorld } from './spawn';
import { bbActiveStartLegal } from './start';
import { biobuzzStep } from './step';

/**
 * BIOBUZZ (FTC 2026-27) — the SIMULATION half of the game module.
 *
 * Everything the authoritative server and the headless smoke need, and nothing a browser
 * owns: the field, the spawn, the tick, the start-anchor count and the HUD slice. The client
 * half (renderers + UI slots) is `./index.ts`.
 *
 * This file is a REGISTRATION, deliberately: every fact below is owned by another file in this
 * directory, and the module only names them. That is what makes the two registries
 * (`src/games/index.ts`, `src/games/sim.ts`) the whole of "adding a game" — see CLAUDE.md's
 * seam section for the four registrations and why all four fail silently when missed.
 *
 * ── `scored` AND `startLegality` ARE BOTH TRUE ───────────────────────────────
 *   • `scored: true` since 2026-09-12 (kickoff evening): `score.ts` scores the whole of
 *     Table 10-2 every tick (TIPS, CELL contents, FLOWER ownership, GARDEN, LEAVE, PARK) and
 *     `scoreTargets()` returns the real openings, so a BIOBUZZ match may reach the record
 *     board, the ranked periods and `persistMatch` — all keyed per game, and all still
 *     ALPHA-ONLY through `channels`. Some inputs are `APPROX` (
 *     `BB_FLOWER_MID_Z`), so numbers on the alpha board before the 2026-09-14 field test
 *     are provisional. Setting this back to `false` is the one-line way to stop persisting.
 *   • `startLegality: true` since the `startLegal` slot landed. It was held down for one
 *     reason, and it was never that the rule was missing: `bbEvalStart` (`./start`) has
 *     assessed G304 since kickoff day — own side, touching the perimeter, clear of every
 *     FLOWER, out of the LOADING ZONE. What blocked it was the READER. `server/room.ts` and
 *     `startSelectionLegal` both called DECODE's `activeStartLegal` directly, so flipping the
 *     flag would have judged a BIOBUZZ pose against DECODE's launch lines and goal triangles
 *     and refused every legal start on this field. Both now ask the module
 *     (`GameSimModule.startLegal`, filled below), so the flag means what it says: a driver
 *     cannot ready up, and a host cannot start, on a pose G304 refuses.
 *
 * `initialAct: 1` (`BB_INITIAL_ACT`) — BIOBUZZ's records and ranked open at Act 1 · Season 1
 * (owner, 2026-09-12). Acts are stored PER GAME (`seasons` is keyed on game, `elo_ratings` on
 * game + act), so the number does not have to differ from another game's: DECODE and Chain
 * Reaction already share an act number in production without touching each other's boards.
 */

/**
 * THE `createWorld` ROUTE FOR PHYSICS (Day 1 seam, `docs/biobuzz/plan-3d.md` §2.1).
 *
 * `GameSimModule.createWorld(mode, seed, setups, settings?)` is the shared seam every game's
 * world-builder is called through — `src/game.ts`'s `makeWorld()` already hands it the FULL
 * `GameSettings` for both a solo build and a multiplayer one, so no signature change was
 * needed to reach `settings.practicePhysics`. `createBiobuzzWorld` itself grew a fifth,
 * trailing, OPTIONAL `physics` argument (defaulting `'2d'`) that the shared interface type
 * does not know about — legal, because a function with an extra optional parameter is still
 * assignable to a shorter function type, so registering this wrapper does not touch
 * `GameSimModule.createWorld`'s signature at all. This wrapper is the one place that reads
 * `settings?.practicePhysics` and forwards it; everything else keeps calling
 * `createBiobuzzWorld` directly (the smoke suite, `scenes.ts`) and keeps getting `'2d'`.
 *
 * Day 2 added the ROOM's route beside it: an explicit fifth `physics` argument on the shared
 * seam (`GameSimModule.createWorld`), sourced from `RoomConfig.physics` on the server and from
 * `matchStart.physics` on every client in the room. It WINS over the settings field, because a
 * room's physics is the room's fact and the settings bag is the player's — a driver whose
 * Practice pick says `'2d'` must still build the `'3d'` world the room they joined is running,
 * or their prediction steps a different game from the server's.
 *
 * So the precedence is: the room's explicit choice, then solo practice's setting, then `'2d'`
 * — which is also what every caller that passes neither (the smoke suite, `scenes.ts`) gets,
 * unchanged.
 */
function createBiobuzzSimWorld(
  mode: GameMode,
  seed: number,
  setups: RobotSetup[],
  settings?: GameSettings,
  physics?: Physics,
): World {
  return createBiobuzzWorld(
    mode,
    seed,
    setups,
    settings,
    physics ?? settings?.practicePhysics ?? '2d',
  );
}
export const BIOBUZZ_SIM: GameSimModule = {
  id: 'biobuzz',
  scored: true,
  startLegality: true,
  initialAct: BB_INITIAL_ACT,
  // the legal range of a `startIndex` — read by `coerceStartIndex`, `coerceSetup`,
  // `coerceSettings` and the server's per-alliance de-conflict loop, none of which may use
  // DECODE's five anchors for a game that has two
  startPoseCount: BB_START_POSE_COUNT,
  // G304 off `bbEvalStart`, AND R102 off `bbStowLegal`. It MIRRORS the canonical pose onto the
  // alliance first — this field is point-symmetric, so red's version of a stored pose is a 180°
  // rotation of it and not an x-reflection; see `bbActiveStartLegal`.
  //
  // ── WHY THE HEIGHT CLAUSE IS HERE AND NOT IN `bbEvalStart` ──────────────────
  // G304 is five clauses about a POSE and `start.ts` assesses exactly those. R102 is a clause
  // about the BUILD — "STARTING CONFIGURATION is limited to an 18-inch cube" — and it is true or
  // false before a pose exists at all, which is why it is ANDed at the registration rather than
  // smuggled into a pose evaluator that would then have to return it for `startPose === null`
  // too. Both readers of this slot (the server's ready-up gate, `startSelectionLegal`) get one
  // answer to "may this robot start", which is what they actually ask.
  startLegal: (spec, a, startPose) => bbStowLegal(spec) && bbActiveStartLegal(spec, a, startPose),
  // start ROLES are TOP / BOTTOM (which end of the field a robot starts at), like Chain
  // Reaction's, not DECODE's CLOSE / FAR — read by the shared start-position helpers, the
  // role-swap bar and the lobby/strategy start chips
  startAnchorCategory: bbAnchorCat,
  startDefaultIndex: bbDefaultIndex,
  startRoleLabel: bbRoleLabel,
  startAnchorName: bbAnchorName,
  // BIOBUZZ's step never calls `updatePathTraversal`, so an imported `.pp` path would be inert
  autoPaths: false,
  // Zenith `*.auto.json` autos, driven by an auto seat (docs/area/autos.md)
  zenithAutos: true,
  bounds: { halfX: BB_HALF_X, halfY: BB_HALF_Y, viewMargin: BB_VIEW_MARGIN },
  colliders: biobuzzColliders,
  createWorld: createBiobuzzSimWorld,
  step: biobuzzStep,
  // this game's UI may offer either physics (Day 1 seam) — DECODE and Chain Reaction leave
  // this absent, which reads as '2d' only.
  physicsOptions: ['2d', '3d'],
  // `{ field: { scored }, robot: { hopper, cap, mode } | null }` — the contract's §5 slice.
  // DOM-free, because the authoritative server computes it for its clients too.
  hud: biobuzzHud,
  // THIS GAME'S OWN ARTIFACT-SOLID GEOMETRY. Absent on DECODE and CR, which get the shared
  // `robotSolids` unchanged; filled here because a BIOBUZZ sweeper is a roller bar on any
  // edge and DECODE's front funnel is not a description of it. See `bbRobotSolids`.
  artifactSolids: bbRobotSolids,
  // the match is finalized only once nothing left on the field can score (§10.5 A/C) — a tip
  // swing that the buzzer caught finishes and pays before anything is saved. See `bbSettled`.
  settled: bbSettled,
  // THE AI SEAT (Day 3, plan §6). DECODE and Chain Reaction leave this absent, which is what
  // "this game offers no bot" means at every reader. See `src/games/biobuzz/ai/index.ts` for the
  // driving contract, and `BotDriver` for why there is a `create` and no `drive`.
  bot: BIOBUZZ_BOT,
};
