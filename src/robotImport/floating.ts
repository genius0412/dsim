/**
 * PARTS THAT FLOAT APART FROM THE ROBOT (`docs/area/robot-import.md`, "Deleting parts"). DOM-free and
 * three-free. A CAD file can carry a body that is not on the robot at all: a reference cube, a part
 * parked beside the assembly. It inflates the footprint and the size, and it would be stored and
 * drawn with the robot. The editor offers to delete what this finds; it never deletes on its own.
 *
 * The rule is on the bodies' boxes (`bodyStats`): two bodies are joined when their boxes come within
 * `FLOAT_GAP_IN` of each other, the joined group with the most vertices is the robot, and every other
 * group floats. A box is larger than its body, so this only ever errs toward joining: a part it flags
 * is at least `FLOAT_GAP_IN` from every box on the robot. Measured 2026-10-04 on eight real STEP
 * files: the Offset Robotics concept robot's one stray part (a 0.6 in node with its two screws,
 * 9.2 in from the robot) is flagged, and nothing on goBILDA's three, REV's or AndyMark's three starter
 * bots, read at Full or at Light (whose left-out fasteners leave gaps), even with boxes joined only
 * when they come within 0.05 in.
 */
import type { MeshPart } from './geometry';
import { bodyStats } from './motion';
import type { FloatingGroup } from './types';

/** bodies whose boxes come this close are one group, inches */
export const FLOAT_GAP_IN = 0.5;

/** the box gap between bodies `a` and `b` (Euclidean; 0 when they overlap) */
function boxGap(min: Float64Array, max: Float64Array, a: number, b: number): number {
  let s = 0;
  for (let k = 0; k < 3; k++) {
    const d = Math.max(0, min[3 * b + k] - max[3 * a + k], min[3 * a + k] - max[3 * b + k]);
    s += d * d;
  }
  return Math.sqrt(s);
}

/**
 * Every group of bodies that floats apart from the robot, nearest first. `parts` are in inches (the
 * MODEL frame); a model of one body, or with no body ids, has none.
 */
export function findFloatingParts(parts: readonly MeshPart[], gapIn = FLOAT_GAP_IN): FloatingGroup[] {
  const st = bodyStats(parts);
  const ids = st.ids;
  if (ids.length < 2) return [];
  const { min, max } = st;
  // join boxes within the gap: a sweep along x, then a union-find over the bodies
  const order = ids.slice().sort((a, b) => min[3 * a] - min[3 * b] || a - b);
  const parent = new Int32Array(st.n.length);
  for (const b of ids) parent[b] = b;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (x !== r) {
      const n = parent[x];
      parent[x] = r;
      x = n;
    }
    return r;
  };
  for (let i = 0; i < order.length; i++) {
    const a = order[i];
    const reach = max[3 * a] + gapIn;
    for (let j = i + 1; j < order.length; j++) {
      const b = order[j];
      if (min[3 * b] > reach) break;
      const ra = find(a);
      const rb = find(b);
      if (ra === rb || boxGap(min, max, a, b) > gapIn) continue;
      parent[ra] = rb;
    }
  }
  const groups = new Map<number, number[]>();
  for (const b of ids) {
    const r = find(b);
    const g = groups.get(r);
    if (g) g.push(b);
    else groups.set(r, [b]);
  }
  if (groups.size < 2) return [];
  // the robot: the group with the most vertices (the first, ids ascending, on a tie)
  const verts = (g: number[]): number => g.reduce((s, b) => s + st.n[b], 0);
  let robot: number[] = [];
  for (const g of groups.values()) if (verts(g) > verts(robot)) robot = g;
  const out: FloatingGroup[] = [];
  for (const g of groups.values()) {
    if (g === robot) continue;
    let gap = Infinity;
    for (const a of g) for (const b of robot) gap = Math.min(gap, boxGap(min, max, a, b));
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const b of g) {
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], min[3 * b + k]);
        hi[k] = Math.max(hi[k], max[3 * b + k]);
      }
    }
    out.push({ bodies: g.slice().sort((x, y) => x - y), gapIn: gap, size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] });
  }
  return out.sort((x, y) => x.gapIn - y.gapIn || x.bodies[0] - y.bodies[0]);
}

/**
 * PARTS THAT HANG BELOW THE FLOOR THE ROBOT STANDS ON (2026-11-27; `standFloor`, `geometry.ts`): when a
 * small part below the wheels would have been the floor, the floor is raised to the wheels and that part
 * is offered for deleting like a floating part, with the same Keep and Delete (kept, it stays below the
 * floor and the robot still stands on its wheels). `bodies` are what lies below the raised floor; those
 * whose boxes come within `FLOAT_GAP_IN` of each other are one group, as floating parts are. Each group
 * says how far it hangs below the floor (`hangIn`, from the MODEL frame's z = 0) and its gap to the rest
 * of the robot (often 0: it is attached). Deepest first.
 */
export function hangingParts(parts: readonly MeshPart[], bodies: readonly number[], gapIn = FLOAT_GAP_IN): FloatingGroup[] {
  const st = bodyStats(parts);
  const below = bodies.filter((b) => b < st.n.length && st.n[b] > 0);
  if (!below.length) return [];
  const { min, max } = st;
  const set = new Set(below);
  const parent = new Map<number, number>(below.map((b) => [b, b]));
  const find = (x: number): number => {
    while (parent.get(x)! !== x) x = parent.get(x)!;
    return x;
  };
  for (let i = 0; i < below.length; i++) {
    for (let j = i + 1; j < below.length; j++) {
      if (boxGap(min, max, below[i], below[j]) > gapIn) continue;
      const a = find(below[i]);
      const b = find(below[j]);
      if (a !== b) parent.set(Math.max(a, b), Math.min(a, b));
    }
  }
  const groups = new Map<number, number[]>();
  for (const b of below) {
    const r = find(b);
    const g = groups.get(r);
    if (g) g.push(b);
    else groups.set(r, [b]);
  }
  const rest = st.ids.filter((b) => !set.has(b));
  const out: FloatingGroup[] = [];
  for (const g of groups.values()) {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const b of g) {
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], min[3 * b + k]);
        hi[k] = Math.max(hi[k], max[3 * b + k]);
      }
    }
    let gap = Infinity;
    for (const a of g) for (const b of rest) gap = Math.min(gap, boxGap(min, max, a, b));
    out.push({ bodies: g.slice().sort((x, y) => x - y), gapIn: Number.isFinite(gap) ? gap : 0, size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]], hangIn: Math.max(0, -lo[2]) });
  }
  return out.sort((x, y) => (y.hangIn ?? 0) - (x.hangIn ?? 0) || x.bodies[0] - y.bodies[0]);
}

/**
 * A BODY THAT IS A GAME BALL (2026-11-27): teams model the season's balls in their robot, sitting in
 * the hopper, so the robot always looks loaded. Such a body is offered for deleting like a floating
 * part (nothing goes without a click). It must be ONE body, as close to a sphere as a mesh of one is,
 * and as big as one of `diameters` (the games' own balls, inches; `GAME_BALL_DIAMETERS_IN` in
 * `measureSession.ts`):
 *  · its box is within `PIECE_CUBE` of a cube, and its mean side within `PIECE_D_SHARE` (or
 *    `PIECE_D_MIN_IN`) of a diameter;
 *  · every vertex lies between `PIECE_R_IN` and `PIECE_R_OUT` of that side from the box's centre
 *    (a hollow ball's inner wall included), and some lie on the shell in each of the eight octants.
 * Names never reach the measurement, so they play no part. The vertex test is what keeps a wheel out:
 * a wheel as wide as it is tall has a near-cubic box, but its hub and bore sit far inside the shell
 * (measured on real team assemblies, 2026-11-27).
 */
const PIECE_CUBE = 1.06;
const PIECE_D_SHARE = 0.05;
const PIECE_D_MIN_IN = 0.1;
const PIECE_R_IN = 0.4;
const PIECE_R_OUT = 0.54;

export function findGamePieces(parts: readonly MeshPart[], diameters: readonly number[]): FloatingGroup[] {
  const ds = diameters.filter((d) => Number.isFinite(d) && d > 0);
  if (!ds.length) return [];
  const st = bodyStats(parts);
  const cands = new Map<number, { c: number[]; side: number; d: number; lo: number; hi: number; oct: number }>();
  for (const b of st.ids) {
    const e = [0, 1, 2].map((k) => st.max[3 * b + k] - st.min[3 * b + k]);
    if (!(Math.min(...e) > 0) || Math.max(...e) / Math.min(...e) > PIECE_CUBE) continue;
    const side = (e[0] + e[1] + e[2]) / 3;
    let d = 0;
    for (const x of ds) if (Math.abs(side - x) <= Math.max(PIECE_D_SHARE * x, PIECE_D_MIN_IN) && (!d || Math.abs(side - x) < Math.abs(side - d))) d = x;
    if (!d) continue;
    cands.set(b, { c: [0, 1, 2].map((k) => (st.min[3 * b + k] + st.max[3 * b + k]) / 2), side, d, lo: Infinity, hi: 0, oct: 0 });
  }
  if (!cands.size) return [];
  for (const p of parts) {
    if (!p.body) continue;
    const a = p.positions;
    for (let i = 0; i < p.body.length; i++) {
      const f = cands.get(p.body[i]);
      if (!f) continue;
      const dx = a[3 * i] - f.c[0];
      const dy = a[3 * i + 1] - f.c[1];
      const dz = a[3 * i + 2] - f.c[2];
      const r = Math.hypot(dx, dy, dz);
      if (r < f.lo) f.lo = r;
      if (r > f.hi) f.hi = r;
      if (r >= 0.45 * f.side) f.oct |= 1 << ((dx > 0 ? 1 : 0) + (dy > 0 ? 2 : 0) + (dz > 0 ? 4 : 0));
    }
  }
  const out: FloatingGroup[] = [];
  for (const [b, f] of cands) {
    if (f.lo < PIECE_R_IN * f.side || f.hi > PIECE_R_OUT * f.side || f.oct !== 0xff) continue;
    out.push({ bodies: [b], gapIn: 0, size: [0, 1, 2].map((k) => st.max[3 * b + k] - st.min[3 * b + k]) as [number, number, number], pieceIn: f.d });
  }
  return out.sort((x, y) => x.bodies[0] - y.bodies[0]);
}
