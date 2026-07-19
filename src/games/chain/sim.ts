import type { GameSimModule } from '../types';
import { CHAIN_HALF_Y, CHAIN_VIEW_HALF_X, CHAIN_VIEW_MARGIN } from './config';
import { chainColliders } from './colliders';
import { createChainWorld } from './spawn';
import { chainStep } from './step';

/**
 * Chain Reaction SIMULATION module (DOM-free) — fully playable + SCORED. `scored: true`
 * puts its matches on the ranked/record boards, which are keyed PER GAME (its own Act →
 * Season periods, separate from DECODE). CR start poses are legal by construction (Lab-Area
 * anchors), so `startLegality:false` keeps the server's DECODE-only G304 gate off.
 */
export const CHAIN_SIM: GameSimModule = {
  id: 'chain',
  scored: true,
  startLegality: false,
  // camera bounds include the protruding goals (walls/colliders stay at ±72)
  bounds: { halfX: CHAIN_VIEW_HALF_X, halfY: CHAIN_HALF_Y, viewMargin: CHAIN_VIEW_MARGIN },
  colliders: chainColliders,
  createWorld: createChainWorld,
  step: chainStep,
};
