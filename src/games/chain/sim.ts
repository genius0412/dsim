import { movingFaster, robotsAtRest } from '../../sim/settle';
import type { World } from '../../types';
import type { GameSimModule } from '../types';
import {
  CHAIN_HALF_Y,
  CHAIN_PART_REST_SPEED,
  CHAIN_START_POSES,
  CHAIN_VIEW_HALF_X,
  CHAIN_VIEW_MARGIN,
} from './config';
import { chainColliders } from './colliders';
import { chainStartLegal } from './state';
import { createChainWorld } from './spawn';
import { chainStep } from './step';
import { chainRankFacts } from './rankFacts';

/**
 * Chain Reaction SIMULATION module (DOM-free) — fully playable + SCORED. `scored: true`
 * puts its matches on the ranked/record boards, which are keyed PER GAME (its own Act →
 * Season periods, separate from DECODE). CR start poses are legal by construction (Lab-Area
 * anchors), so `startLegality:false` keeps the server's DECODE-only G304 gate off.
 */
/**
 * Chain Reaction: nothing left that can change the score (`GameSimModule.settled`).
 *   · no particle in FLIGHT — an unscored one can still enter an accelerator (`play.ts` has no
 *     phase gate on that), and a scored one being ejected lands as ground. `staged` particles
 *     are the pre-match load held inside a goal and never move again after the buzzer;
 *   · every GROUND particle at rest;
 *   · every ROBOT at rest — ASCEND and PARK are derived from where a robot sits, every tick.
 */
export function chainSettled(world: World): boolean {
  for (const b of world.balls) {
    const s = b.state;
    if (s.kind === 'flight' && !s.staged) return false;
    if (s.kind === 'ground' && movingFaster(b.vel, CHAIN_PART_REST_SPEED)) return false;
  }
  return robotsAtRest(world);
}

export const CHAIN_SIM: GameSimModule = {
  id: 'chain',
  scored: true,
  startLegality: false,
  initialAct: 1, // CR's periods start at Act 1 · Season 1 (DECODE keeps act 0)
  startPoseCount: CHAIN_START_POSES.length,
  // G04. The FLAG above stays false and this is filled anyway — they are different questions:
  // the flag is whether the SERVER refuses a ready-up, and this is whether the EDITOR paints
  // the ring red. CR has always answered the second and never wanted the first.
  // The pose is assessed in the canonical frame it is stored in (the Lab Areas as a pair). The
  // ALLIANCE matters only for an IMPORT: red's footprint is the x-reflection of the canonical
  // one, which for a hull that is not symmetric left-right is the hull FLIPPED, so red is judged
  // on that (`chainStartExtents`). A standard robot's answer does not depend on it.
  // No pose = an anchor, which the spawn fits for an import (`spawn.ts`), so it is legal.
  startLegal: (spec, a, pose) =>
    !pose || chainStartLegal(spec, { x: pose.x, y: pose.y }, pose.headingDeg, a),
  // CR's step never calls `updatePathTraversal`, so an imported `.pp` path would be inert
  autoPaths: false,
  // camera bounds include the protruding goals (walls/colliders stay at ±72)
  bounds: { halfX: CHAIN_VIEW_HALF_X, halfY: CHAIN_HALF_Y, viewMargin: CHAIN_VIEW_MARGIN },
  colliders: chainColliders,
  createWorld: createChainWorld,
  step: chainStep,
  settled: chainSettled,
  // a competition's ranking-point measures: AUTO as AUTO ends, ASCENT at the end
  rankFacts: chainRankFacts,
};
