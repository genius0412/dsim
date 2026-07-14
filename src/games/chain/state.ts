import type { Alliance, Vec2 } from '../../types';
import type { Rect } from '../../sim/field';
import {
  CHAIN_HALF_X,
  CHAIN_HALF_Y,
  CHAIN_HOOK_Y,
  CHAIN_LAB,
  CHAIN_RINGSTAND_XY,
} from './config';

/**
 * Chain Reaction runtime state — everything CR-specific lives here on `world.chain`
 * so the shared `World` type needs only one optional field. Plain JSON (catalysts /
 * counters / per-robot endgame), so determinism, snapshots, and replays hold.
 */

export type EndgameState = 'none' | 'parked' | 'ascended';

export interface ChainCatalyst {
  id: number;
  pos: Vec2;
  /** robot id currently carrying it (max 1 per robot), else null */
  carriedBy: number | null;
  /** the hook it is seated on (scored ⇒ contributes a multiplier), else null */
  hook: { alliance: Alliance; index: number } | null;
}

export interface ChainState {
  catalysts: ChainCatalyst[];
  /** particles scored per alliance (count) */
  scored: Record<Alliance, number>;
  /** points earned from particles (multiplier folded in AT score time) */
  particlePoints: Record<Alliance, number>;
  /** endgame status per robot id (park 5 / ascend 20) */
  endgame: Record<number, EndgameState>;
  /** last catalyst-button state per robot id (for edge-triggered pick/place) */
  catalystHeld: Record<number, boolean>;
  /** monotonic ball-id allocator (deterministic — no module global). Set past the
   * initial particle ids at spawn; `updateChain` increments it for reject/flight balls. */
  nextBallId: number;
}

export function emptyChainState(): ChainState {
  return {
    catalysts: [],
    scored: { red: 0, blue: 0 },
    particlePoints: { red: 0, blue: 0 },
    endgame: {},
    catalystHeld: {},
    nextBallId: 1,
  };
}

// ── geometry ────────────────────────────────────────────────────────────────

/** the x sign of an alliance's accelerator/side wall: red LEFT (−1), blue RIGHT (+1) */
export function accelSide(a: Alliance): -1 | 1 {
  return a === 'red' ? -1 : 1;
}

/** the accelerator mouth CENTER (on the side wall) an alliance launches into */
export function accelMouth(a: Alliance): Vec2 {
  return { x: accelSide(a) * CHAIN_HALF_X, y: 0 };
}

/** the two hook positions on an alliance's accelerator wall (index 0 = +y, 1 = −y) */
export function hookPos(a: Alliance, index: number): Vec2 {
  return { x: accelSide(a) * CHAIN_HALF_X, y: (index === 0 ? 1 : -1) * CHAIN_HOOK_Y };
}

/** all four Ring-Stand corner positions */
export function ringStands(): Vec2[] {
  return [
    { x: -CHAIN_RINGSTAND_XY, y: CHAIN_RINGSTAND_XY },
    { x: CHAIN_RINGSTAND_XY, y: CHAIN_RINGSTAND_XY },
    { x: -CHAIN_RINGSTAND_XY, y: -CHAIN_RINGSTAND_XY },
    { x: CHAIN_RINGSTAND_XY, y: -CHAIN_RINGSTAND_XY },
  ];
}

/** the Lab-Area corner squares OWNED by an alliance (its two side corners). APPROX. */
export function labAreas(a: Alliance): Rect[] {
  const s = accelSide(a); // red squares on x<0, blue on x>0
  const x0 = s < 0 ? -CHAIN_HALF_X : CHAIN_HALF_X - CHAIN_LAB;
  const x1 = s < 0 ? -CHAIN_HALF_X + CHAIN_LAB : CHAIN_HALF_X;
  return [
    { x0, y0: CHAIN_HALF_Y - CHAIN_LAB, x1, y1: CHAIN_HALF_Y },
    { x0, y0: -CHAIN_HALF_Y, x1, y1: -CHAIN_HALF_Y + CHAIN_LAB },
  ];
}

/** points-per-particle for an alliance = 1 + (# catalysts seated on its hooks) */
export function accelMultiplier(state: ChainState, a: Alliance): number {
  let mult = 1;
  for (const c of state.catalysts) if (c.hook && c.hook.alliance === a) mult++;
  return mult;
}
