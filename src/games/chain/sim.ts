import type { GameSimModule } from '../types';
import { CHAIN_HALF_Y, CHAIN_VIEW_HALF_X, CHAIN_VIEW_MARGIN } from './config';
import { chainColliders } from './colliders';
import { createChainWorld } from './spawn';
import { chainStep } from './step';

/**
 * Chain Reaction SIMULATION module (DOM-free) — the empty-field shell. Drivable +
 * wall-contained + networked, but NOT scored yet (`scored: false` keeps its 0-0
 * matches off the ELO/record boards). No start legality yet (`startLegality:false`,
 * so the server skips the G304 gate). Real geometry/intakes/rules land later.
 */
export const CHAIN_SIM: GameSimModule = {
  id: 'chain',
  scored: false,
  startLegality: false,
  // camera bounds include the protruding goals (walls/colliders stay at ±72)
  bounds: { halfX: CHAIN_VIEW_HALF_X, halfY: CHAIN_HALF_Y, viewMargin: CHAIN_VIEW_MARGIN },
  colliders: chainColliders,
  createWorld: createChainWorld,
  step: chainStep,
};
