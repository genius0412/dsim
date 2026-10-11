import type { World } from '../types';

/**
 * A FRESH artifact id — never one a ball in this match has already had.
 *
 * Ids used to be `max(id) + 1` over the balls on the field at the moment of asking, which
 * reuses an id the moment the ball holding the maximum leaves. `humanPlayers` does exactly that
 * inside one call: it collects the stray with the highest id into the box and can then place a
 * new artifact at a grab slot, which got the SAME id. Everything keyed by artifact id then
 * carried over to a different physical ball — the penalty engine's per-(robot, artifact)
 * `ballHold` / `ballAnchor` / `ballCarry` (swept earlier in the tick, while the old ball was
 * still there, so a new ball arrived with the old one's carried distance and hold time),
 * `world.pinnedArtifacts`, and the snapshot codec's per-id delta.
 *
 * `world.nextBallId` is a high-water mark, set by `createWorld` past every spawned ball and only
 * ever raised. A world without it (an older snapshot or replay world) falls back to the old
 * rule, and from then on carries the mark.
 */
export function allocBallId(world: World): number {
  let max = 0;
  for (const b of world.balls) if (b.id > max) max = b.id;
  const id = Math.max(world.nextBallId ?? 0, max + 1);
  world.nextBallId = id + 1;
  return id;
}
