import type { FieldColliders, StaticSpec } from '../types';
import { BB_HALF_X, BB_HALF_Y, BB_WALL_T } from './config';

/**
 * BIOBUZZ static field geometry — FOUR PERIMETER WALLS AND NOTHING ELSE.
 *
 * That is not a placeholder for lack of effort; it is what the manual says. Section 9 (ARENA)
 * of the V0 pre-season manual is one page reading "This section will be updated with the
 * Kickoff Competition Manual release on September 12, 2026", so any goal, ramp, truss or zone
 * collider added here today would be a guess dressed as geometry. The walls are safe because
 * every FTC field has had them at ±72".
 *
 * Each wall is a cuboid whose INNER face sits exactly on ±`BB_HALF_*`, with its body entirely
 * OUTSIDE the play area. They are deliberately thick (`BB_WALL_T` half-extent): a thin static
 * can be tunnelled through by a fast robot inside a single 1/60 s step, and the cheapest fix
 * for that is depth rather than substepping. The side walls are grown along y (and the end
 * walls along x) past the corner so the four overlap — a mitred corner leaves a notch a
 * bumper can catch on.
 *
 * These are CONSTANT numbers, computed once at module load, which is a determinism
 * requirement: `solveRobots` rebuilds its Rapier world each step from this array, so a
 * collider set that differed between two builds of the same seed would diverge the hash.
 */
const WALL_LX = BB_HALF_X + 20;
const WALL_LY = BB_HALF_Y + 20;
const walls: StaticSpec[] = [
  { hx: BB_WALL_T, hy: WALL_LY, tx: BB_HALF_X + BB_WALL_T, ty: 0, rot: 0 }, // +x
  { hx: BB_WALL_T, hy: WALL_LY, tx: -BB_HALF_X - BB_WALL_T, ty: 0, rot: 0 }, // -x
  { hx: WALL_LX, hy: BB_WALL_T, tx: 0, ty: BB_HALF_Y + BB_WALL_T, rot: 0 }, // +y
  { hx: WALL_LX, hy: BB_WALL_T, tx: 0, ty: -BB_HALF_Y - BB_WALL_T, rot: 0 }, // -y
];

/**
 * `bounds` is the PERIMETER as a hard containment INVARIANT, not merely as a collider.
 * `solveRobots` reads it to guarantee that a robot which began a tick inside the field cannot
 * be pushed out of it — a soft contact against an immovable body is not enough on its own
 * when two robots pin a third against the wall. No `dynamic` entry: BIOBUZZ has no known
 * moving field geometry, and an empty callback costs a per-step allocation for nothing.
 */
export const biobuzzColliders: FieldColliders = {
  statics: walls,
  bounds: { halfX: BB_HALF_X, halfY: BB_HALF_Y },
};

/** the wall count, exported so `smoke-biobuzz` asserts the number it expects rather than
 * hard-coding 4 in the test and in the field. */
export const BB_WALL_COUNT = walls.length;
