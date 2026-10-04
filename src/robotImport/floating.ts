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
