import type { FieldColliders, StaticSpec } from '../types';
import { CHAIN_HALF_X, CHAIN_HALF_Y, CHAIN_WALL_T } from './config';

/**
 * Chain Reaction static field geometry: just the four perimeter walls (inner
 * faces exactly at ±CHAIN_HALF). No goals/structures yet — the shell is an empty
 * rectangle. `solveRobots` consumes this exactly like DECODE's colliders, so the
 * robot is wall-contained on the CR field. No `dynamic` colliders (no gates).
 */
const WALL_LX = CHAIN_HALF_X + 20; // overlap the corners
const WALL_LY = CHAIN_HALF_Y + 20;

const walls: StaticSpec[] = [
  { hx: CHAIN_WALL_T, hy: WALL_LY, tx: CHAIN_HALF_X + CHAIN_WALL_T, ty: 0, rot: 0 },
  { hx: CHAIN_WALL_T, hy: WALL_LY, tx: -CHAIN_HALF_X - CHAIN_WALL_T, ty: 0, rot: 0 },
  { hx: WALL_LX, hy: CHAIN_WALL_T, tx: 0, ty: CHAIN_HALF_Y + CHAIN_WALL_T, rot: 0 },
  { hx: WALL_LX, hy: CHAIN_WALL_T, tx: 0, ty: -CHAIN_HALF_Y - CHAIN_WALL_T, rot: 0 },
];

export const chainColliders: FieldColliders = { statics: walls };
