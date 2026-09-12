import type { FieldColliders, StaticSpec } from '../types';
import {
  BB_FLOWER_FOOT_R,
  BB_FLOWERS,
  BB_FRAME_BAR,
  BB_FRAME_X,
  BB_FRAME_Y,
  BB_HALF_X,
  BB_HALF_Y,
  BB_WALL_T,
} from './config';

/**
 * BIOBUZZ static field geometry — the four perimeter walls, the HIVE Structure's two base bars,
 * and the four FLOWER feet. Those are the only things a robot or a ground element can hit.
 *
 * Everything else on the field is either tape (no collider) or above the tiles: the HIVE cells
 * hang at 25.5 in and up (§9.6.1, Fig 9-10) and G409 assumes robots drive UNDER them, and a
 * FLOWER's rings start at 3.98 in — only its foot is in the way of a bumper.
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
 * THE HIVE FRAME'S TWO BASE BARS (§9.6.1, Fig 9-8).
 *
 * The frame is two triangular structures joined at the apex; what touches the tiles is a bar
 * under each triangle, running along y at the frame's x extreme (`BB_FRAME_X` = ±24.73) and
 * spanning the foot spread (`BB_FRAME_Y` = ±19.5). The triangles themselves lean inward and
 * upward out of a robot's way, so the bar is the whole collider: a robot crossing the field
 * along x hits a bar, and a robot between the bars is under the hives and free to move.
 *
 * Thickness is the extrusion (`BB_FRAME_BAR` 1.5 in), taken as the bar's FULL width, so the
 * half-extent along x is half of it and the bar's centreline sits on the leg line.
 */
const frameBars: StaticSpec[] = [
  { hx: BB_FRAME_BAR / 2, hy: BB_FRAME_Y, tx: BB_FRAME_X, ty: 0, rot: 0 }, // +x leg
  { hx: BB_FRAME_BAR / 2, hy: BB_FRAME_Y, tx: -BB_FRAME_X, ty: 0, rot: 0 }, // -x leg
];

/**
 * THE FOUR FLOWER FEET (§9.7, Fig 9-12).
 *
 * APPROX — SHAPE: the foot is a ~5 in rounded square of ring plates, carried in config as the
 * circle `BB_FLOWER_FOOT_R` (2.6 in). `StaticSpec` is rect-only (`hx`/`hy`/`tx`/`ty`/`rot`, no
 * radius member), so each foot is declared as the square that CIRCUMSCRIBES that circle —
 * half-extents `BB_FLOWER_FOOT_R` on both axes, axis-aligned. Same footprint to within the
 * corners, which err toward keeping robots slightly further off the FLOWER than the real ring
 * plate would. If `StaticSpec` ever grows a circle variant this becomes one.
 *
 * The feet sit against the wall by construction: `BB_FLOWERS` already carries the `BB_FLOWER_D`
 * stand-off, so no offset is applied here.
 */
const flowerFeet: StaticSpec[] = BB_FLOWERS.map((f) => ({
  hx: BB_FLOWER_FOOT_R,
  hy: BB_FLOWER_FOOT_R,
  tx: f.x,
  ty: f.y,
  rot: 0,
}));

/**
 * `bounds` is the PERIMETER as a hard containment INVARIANT, not merely as a collider.
 * `solveRobots` reads it to guarantee that a robot which began a tick inside the field cannot
 * be pushed out of it — a soft contact against an immovable body is not enough on its own
 * when two robots pin a third against the wall. UNCHANGED by the frame and the flowers:
 * every new solid is inside the walls, so the containment box and the camera do not move.
 *
 * No `dynamic` entry: the HIVE cells rotate, but they rotate 25.5 in ABOVE the tiles and never
 * become a ground collider, and an empty callback costs a per-step allocation for nothing.
 */
export const biobuzzColliders: FieldColliders = {
  statics: [...walls, ...frameBars, ...flowerFeet],
  bounds: { halfX: BB_HALF_X, halfY: BB_HALF_Y },
};

/** the wall count, exported so `smoke-biobuzz` asserts the number it expects rather than
 * hard-coding 4 in the test and in the field. */
export const BB_WALL_COUNT = walls.length;

/** every static the field declares — walls + frame bars + flower feet. Smoke asserts this
 * against the pieces it knows about, so a solid added without a check fails the count. */
export const BB_SOLID_COUNT = biobuzzColliders.statics.length;
