import type { GameSimModule } from '../types';
import { BB_HALF_X, BB_HALF_Y, BB_START_POSE_COUNT, BB_VIEW_MARGIN } from './config';
import { biobuzzColliders } from './colliders';
import { biobuzzHud } from './hudRobot';
import { bbRobotSolids } from './robot';
import { createBiobuzzWorld } from './spawn';
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
 * ── `scored` IS TRUE, `startLegality` IS STILL FALSE ─────────────────────────
 *   • `scored: true` since 2026-09-12 (kickoff evening): `score.ts` scores the whole of
 *     Table 10-2 every tick (TIPS, CELL contents, FLOWER ownership, GARDEN, LEAVE, PARK) and
 *     `scoreTargets()` returns the real openings, so a BIOBUZZ match may reach the record
 *     board, the ranked periods and `persistMatch` — all keyed per game, and all still
 *     ALPHA-ONLY through `channels`. Several inputs are `APPROX` (`BB_TIP_POLLEN[0]`,
 *     `BB_FRAME_RAM_SPEED`), so numbers on the alpha board before the 2026-09-14 field test
 *     are provisional. Setting this back to `false` is the one-line way to stop persisting.
 *   • `startLegality: false` — and NOT because the rule is missing any more. G304 published
 *     with the rest of the V1 manual and `bbEvalStart` (`./start`) assesses it: own side,
 *     touching the perimeter, clear of every FLOWER, out of the LOADING ZONE. The flag stays
 *     down because of what READS it: `server/room.ts` gates a ready-up on `activeStartLegal`,
 *     which is DECODE's `evalStartPose` and is NOT dispatched through this module, so flipping
 *     it would have a BIOBUZZ pose judged against DECODE's launch lines and goal triangles —
 *     a worse answer than no answer, and one that would refuse every legal start on this
 *     field. It flips the day that gate asks the module; `bbEvalStart` is ready for it, and
 *     `spawn.ts` and `elements.ts`'s `evalStart` already call it.
 *
 * `initialAct: 2` — DECODE opened in act 0 (its beta bucket) and Chain Reaction in act 1, so
 * this game's first ranked period opens in act 2. Distinct per game is asserted by the smoke
 * suite: a shared act would file two games' first season into one bucket.
 */
export const BIOBUZZ_SIM: GameSimModule = {
  id: 'biobuzz',
  scored: true,
  startLegality: false,
  initialAct: 2,
  // the legal range of a `startIndex` — read by `coerceStartIndex`, `coerceSetup`,
  // `coerceSettings` and the server's per-alliance de-conflict loop, none of which may use
  // DECODE's five anchors for a game that has two
  startPoseCount: BB_START_POSE_COUNT,
  bounds: { halfX: BB_HALF_X, halfY: BB_HALF_Y, viewMargin: BB_VIEW_MARGIN },
  colliders: biobuzzColliders,
  createWorld: createBiobuzzWorld,
  step: biobuzzStep,
  // `{ field: { scored }, robot: { hopper, cap, mode } | null }` — the contract's §5 slice.
  // DOM-free, because the authoritative server computes it for its clients too.
  hud: biobuzzHud,
  // THIS GAME'S OWN ARTIFACT-SOLID GEOMETRY. Absent on DECODE and CR, which get the shared
  // `robotSolids` unchanged; filled here because a BIOBUZZ sweeper is a roller bar on any
  // edge and DECODE's front funnel is not a description of it. See `bbRobotSolids`.
  artifactSolids: bbRobotSolids,
};
