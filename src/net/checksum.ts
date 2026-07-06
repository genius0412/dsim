import type { Alliance, World } from '../types';

/**
 * Deterministic production checksum of a World, for detecting lockstep DESYNC.
 * FNV-1a (32-bit) over the load-bearing state, with floats ROUNDED to 1e-3 so
 * the hash tolerates nothing but tolerates the same values everywhere — the
 * rounding lives ONLY here, never in the sim. Iteration order is fixed
 * (robots/balls in array order, alliances red then blue), which is identical
 * across peers because every peer builds the world from the same seed + setups.
 *
 * Peers exchange {tick, hash} every CHECKSUM_INTERVAL ticks; a mismatch at the
 * same tick means the sims have diverged.
 */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function worldHash(world: World): number {
  let h = FNV_OFFSET;
  const mix = (n: number): void => {
    h ^= n | 0;
    h = Math.imul(h, FNV_PRIME);
  };
  const q = (f: number): number => Math.round(f * 1000) | 0; // 1e-3 precision

  mix(world.tick);
  mix(world.rngState);
  for (const r of world.robots) {
    mix(r.id);
    mix(q(r.pos.x));
    mix(q(r.pos.y));
    mix(q(r.heading));
    mix(q(r.turretHeading));
  }
  for (const b of world.balls) {
    mix(b.id);
    mix(q(b.pos.x));
    mix(q(b.pos.y));
    mix(q(b.z));
  }
  for (const a of ['red', 'blue'] as Alliance[]) {
    mix(world.match.scores[a].total);
    mix(world.goals[a].classifiedCount);
    mix(world.goals[a].overflowCount);
  }
  return h >>> 0;
}
