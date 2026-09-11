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
 * ── WHY `scored` AND `startLegality` ARE BOTH FALSE ────────────────────────
 * Not as a stub, but as the truth about a pre-Kickoff game. Sections 7-11 of the V0 manual
 * (Game Details, Scoring, ARENA) are one-line placeholders reading "updated with the Kickoff
 * Competition Manual release on September 12, 2026", so:
 *   • `scored: false` — `scoreTargets()` is empty and `play.ts`'s score pass writes zeroes, so
 *     nothing here may reach a leaderboard, a record board or an ELO. `persistMatch` reads
 *     this flag off the SERVER-SAFE registry and skips the write entirely.
 *   • `startLegality: false` — there is no published G304 analogue, so the two anchors are a
 *     convenience rather than a rule, and the server's legality gate stays off. The anchors
 *     are `APPROX` and say so at their definition.
 * Both flip in one commit the day the manual lands. Nothing else about the module changes.
 *
 * `initialAct: 2` — DECODE opened in act 0 (its beta bucket) and Chain Reaction in act 1, so
 * this game's first ranked period opens in act 2. Distinct per game is asserted by the smoke
 * suite: a shared act would file two games' first season into one bucket.
 */
export const BIOBUZZ_SIM: GameSimModule = {
  id: 'biobuzz',
  scored: false,
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
