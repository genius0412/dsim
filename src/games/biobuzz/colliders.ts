import type { FieldColliders, StaticSpec } from '../types';
import {
  BB_FLOWER_D,
  BB_FLOWER_FOOT,
  BB_FLOWERS,
  BB_FRAME_BAR_IN,
  BB_FRAME_BAR_OUT,
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
 * under each triangle, running along y at the frame's x extreme (inner edge on the ±24 seam, `BB_FRAME_BAR_IN`..`BB_FRAME_BAR_OUT`) and
 * spanning the foot spread (`BB_FRAME_Y` = ±19.5). The triangles themselves lean inward and
 * upward out of a robot's way, so the bar is the whole collider: a robot crossing the field
 * along x hits a bar, and a robot between the bars is under the hives and free to move.
 *
 * Thickness is the extrusion (1 in, measured), taken as the bar's FULL width, so the
 * half-extent along x is half of it and the bar's centreline sits on the leg line.
 */
const frameBars: StaticSpec[] = [
  { hx: (BB_FRAME_BAR_OUT - BB_FRAME_BAR_IN) / 2, hy: BB_FRAME_Y, tx: (BB_FRAME_BAR_IN + BB_FRAME_BAR_OUT) / 2, ty: 0, rot: 0 }, // +x leg
  { hx: (BB_FRAME_BAR_OUT - BB_FRAME_BAR_IN) / 2, hy: BB_FRAME_Y, tx: -(BB_FRAME_BAR_IN + BB_FRAME_BAR_OUT) / 2, ty: 0, rot: 0 }, // -x leg
];

/**
 * THE FOUR FLOWER FEET (§9.7, Fig 9-12) — MEASURED (owner CAD, 2026-09-12; reference §2.3).
 *
 * The foot is a RECTANGLE FLUSH TO THE WALL: `BB_FLOWER_FOOT.along` (6 in) along the wall by
 * `BB_FLOWER_FOOT.deep` (4.9 in) into the field, with the ring opening inside it `BB_FLOWER_D`
 * off the wall. `BB_FLOWERS` carries the RING centre, so the foot is rebuilt from the wall:
 * back up `BB_FLOWER_D` to the wall face, then run `deep` inward — the same construction
 * `drawField.ts` uses, so the drawn foot and the collided foot are one rectangle.
 */
const INWARD: Record<(typeof BB_FLOWERS)[number]['wall'], { x: number; y: number }> = {
  left: { x: 1, y: 0 },
  rear: { x: 0, y: -1 },
  right: { x: -1, y: 0 },
  audience: { x: 0, y: 1 },
};

const flowerFeet: StaticSpec[] = BB_FLOWERS.map((f) => {
  const n = INWARD[f.wall];
  const wx = f.x - n.x * BB_FLOWER_D; // the wall face behind the ring
  const wy = f.y - n.y * BB_FLOWER_D;
  const half = BB_FLOWER_FOOT.along / 2;
  const deep = BB_FLOWER_FOOT.deep / 2;
  return {
    hx: n.x === 0 ? half : deep,
    hy: n.y === 0 ? half : deep,
    tx: wx + n.x * deep,
    ty: wy + n.y * deep,
    rot: 0,
  };
});

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
