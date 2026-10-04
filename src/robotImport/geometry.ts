/**
 * ROBOT IMPORT — the measuring half of the importer. DOM-free and three-free, so it runs in the
 * main chunk, in `npm test`, and inside the lazy engine alike.
 *
 * Everything here works on plain typed arrays (`MeshPart`) and reports in the frames named in
 * `docs/area/robot-import.md`: SOURCE (the file's own units and axes), MODEL (inches, +x front,
 * +y left, +z up, floor at z = 0, x/y origin at the footprint's box centre) and ROBOT-LOCAL (the
 * model frame shifted so the origin is the wheelbase centre, plan §3.1).
 *
 * Deterministic on purpose: sorted inputs, first-wins tie breaks, no randomness. The same file
 * measured twice gives the same descriptor, which is what lets a stored `ImportSetup` re-open the
 * editor on exactly the robot that was saved.
 */
import type { ImportedBand, ImportedCut, ImportedEdge, ImportedMech, ImportedRobot, Vec2 } from '../types';
import { applyFolds, deriveMotion, foldKey, planFolds, type FoldPlan } from './motion';
import {
  INCHES_PER_UNIT,
  LENGTH_UNITS,
  UP_AXES,
  type FrontDetection,
  type ImportCheck,
  type ImportMeasurement,
  type ImportSetup,
  type LengthUnit,
  type ModelFormat,
  type QuarterTurns,
  type UpAxis,
  type WheelDetection,
} from './types';

/** the 18-in cube, inches */
export const ROBOT_MAX_IN = 18;
/** every descriptor number is a multiple of this (plan §3.1) */
export const HULL_QUANTUM = 1 / 64;
export const MAX_HULL_VERTS = 16;
export const MAX_BAND_VERTS = 12;
export const MAX_BANDS = 5;
/**
 * `ImportSetup.triBudget` for FULL detail: every triangle the reader makes is kept, previewed, stored
 * and drawn in the match; only the measurement reads a simplified copy (`MEASURE_TRI_BUDGET`).
 * Any budget that is not a positive number reads as Full (`isFullDetail`).
 */
export const FULL_DETAIL = 0;
/** the LIGHT detail, for a slower computer: the stored mesh simplified to this many triangles. At
 *  250k the REV starter bot is its 2.31M-triangle CAD to 0.17 mm (p90), 2.0–2.3 MiB stored
 *  (`docs/area/robot-import.md`, "Budgets") */
export const LIGHT_TRI_BUDGET = 250_000;
/** the detail a fresh setup starts on */
export const DEFAULT_TRI_BUDGET = FULL_DETAIL;
/** what a model kept in full is MEASURED on (the footprint, the wheels, the part finders, picking):
 *  a simplification that keeps every body (`simplifyLists`' `keepBodies`) */
export const MEASURE_TRI_BUDGET = 250_000;
/** does this budget keep every triangle? */
export const isFullDetail = (triBudget: number): boolean => !(triBudget > 0);
/** the extent an FTC robot's largest side is scored against when guessing units */
const TYPICAL_ROBOT_IN = 15;
/** the format's own unit gets this much head start in log space (about a factor of 1.4) */
const UNIT_PRIOR_BONUS = 0.35;
/** floor-contact slab for wheel detection, inches; widened once if it finds too few wheels */
const WHEEL_SLABS_IN = [0.15, 0.5] as const;
/**
 * A FRAME CAN HANG INSIDE THAT SLAB. Offset Robotics' concept robot has its side plates 0.10 in off
 * the floor: at 0.15 their ends were six "wheels" and its mecanum wheels joined a plate's edge, so the
 * four corners were a motor's gearbox and the plates. No four corners, or four that are no rectangle
 * (within `WHEEL_SQUARE_TOL_IN`), are looked for again this close to the floor, and the four found there
 * are used when they are one (Offset: its four mecanum wheels, at 0.03 to 0.08 alike). The tread's lowest
 * vertex can sit 0.05 in up (a 0.5 rad facet on a 1.6 in radius), so not closer.
 */
const WHEEL_THIN_SLAB_IN = 0.08;
/** single-linkage distance for floor contacts, inches: one wheel's patch, never two wheels */
const CONTACT_LINK_IN = 1.0;
/** a contact cluster longer than this is an intake or a skid, not a wheel */
const WHEEL_MAX_PATCH_IN = 3.5;
/** up-axis detection slabs, inches: support points, and flat downward faces */
const UP_SUPPORT_SLAB_IN = 0.5;
const UP_FLAT_SLAB_IN = 0.25;
const UP_PRIOR_BONUS = 0.25;
/** band slicing step, inches */
const BAND_SLICE_IN = 0.5;
/** slices wholly under this height (in) weigh `LOW_WEIGHT` in the band cut (`computeBands`) */
const LOW_BAND_IN = 2.5;
const LOW_WEIGHT = 8;
/** emit bands only when they save this fraction of the single prism's volume */
const BAND_MIN_SAVING = 0.05;
/**
 * How far the bands beside a band of its own stay clear of the plate, inches. The 3D prism's edge is
 * rounded (eroded by `r`, a contact skin of `r`) and catches a plate's edge it passes close under:
 * on goBILDA's BIOBUZZ bot driven straight in, a band ending 0.013 or 0.06 in under the plate held it
 * 0.1 in short of where the plate's own band stops it; 0.09 did not. What lies in that gap is in no
 * band (here the top 0.09 in of the intake's cross bar, which passes under the real plate).
 */
const BAND_OWN_CLEAR_IN = 0.1;
/** a BIOBUZZ FLOWER's middle plate, z inches: `FLOWER_RING_Z.mid` (`fieldDims.gen.ts`, which smoke
 *  holds this equal to; copied so the measure worker does not carry the field's dimensions) */
export const BAND_FLOWER_PLATE_Z: readonly [number, number] = [3.904, 5.254];
const floor64 = (z: number): number => Math.floor(z * 64) / 64;
const ceil64 = (z: number): number => Math.ceil(z * 64) / 64;
/**
 * Heights that are a band of their own: a BIOBUZZ FLOWER's middle plate, the one part of the field
 * a robot's body reaches into, out to the 1/64 grid (`computeBands`), and the gap either side of it
 * that no band holds (`BAND_OWN_CLEAR_IN`).
 */
const BAND_OWN_Z: readonly { band: readonly [number, number]; clear: readonly [number, number] }[] = [
  {
    band: [floor64(BAND_FLOWER_PLATE_Z[0]), ceil64(BAND_FLOWER_PLATE_Z[1])],
    clear: [floor64(BAND_FLOWER_PLATE_Z[0] - BAND_OWN_CLEAR_IN), ceil64(BAND_FLOWER_PLATE_Z[1] + BAND_OWN_CLEAR_IN)],
  },
];
/** a grid slice boundary this close to a `BAND_OWN_Z` end is dropped (no sliver slices), inches */
const BAND_MIN_SLICE_IN = 0.1;
/** only bands reaching above this height carry cuts: below a FLOWER's middle plate nothing on the
 *  field reaches into a robot, and every cut costs the 3D body more convex pieces */
const CUT_FROM_Z = BAND_OWN_Z[0].band[0];
/** lateral bins a band's edge is sampled in for its cuts (`bandCuts`) */
const CUT_BINS = 16;
/** material this far either side of a bin counts in it, inches (well over the 1/64 grid) */
const CUT_V_MARGIN = 0.05;
/**
 * A cut stands this far proud of the measured model, inches. The editor measures a simplified copy
 * (`MEASURE_TRI_BUDGET`) whose surfaces can sit inside the real ones by the simplifier's bound, up
 * to about 0.04 in on an 18-in robot: goBILDA's BIOBUZZ bot's cross bar read 7.64 there against 7.67
 * in the full mesh, which took all of the 1/32 this was.
 */
const CUT_MARGIN_IN = 1 / 16;
/** a bin is cut only where the hull stands at least this far proud of the model, inches */
const CUT_MIN_GAIN_IN = 0.1;
/** one cut ends where the model's edge steps by more than this, inches */
const CUT_STEP_IN = 0.1;
/** at most this many cuts an edge of a band (so an empty corner on one edge cannot crowd out the
 *  recess an intake meets on another), ranked by area to `CUT_VALUE_DEPTH_IN` deep */
export const MAX_EDGE_CUTS = 2;
/** a cut is worth its area to this depth and no deeper, inches: a plate meets a cut's width, and an
 *  empty corner 10 in deep is worth no more to it than one an inch deep */
const CUT_VALUE_DEPTH_IN = 1;

// ---- plain geometry ------------------------------------------------------------------------

/** a mesh with its world transform already applied, SOURCE units and axes */
export interface MeshPart {
  /** xyz triples */
  positions: Float32Array;
  /** triangle corner indices; null = non-indexed (every three vertices are a triangle) */
  indices: Uint32Array | null;
  /** per-vertex unit normals, when computed (the engine creases them after simplifying) */
  normals?: Float32Array | null;
  /** base colour, LINEAR RGB 0..1 (three.js's working colour space, glTF's baseColorFactor) */
  color: [number, number, number];
  name: string;
  /**
   * per-VERTEX body id: which CAD body (a STEP solid, a glTF node instance, a connected piece of an
   * STL) the vertex came from, so a part keeps its identity after the merge by colour. Ids are
   * global to the model. A triangle's body is its first vertex's (the weld never joins two bodies,
   * so the three agree). Absent until a reader or the simplifier sets it (`docs/area/robot-import.md`,
   * "Moving parts").
   */
  body?: Uint32Array | null;
}

/** a triangle's body: its first corner's (`MeshPart.body`) */
export function triangleBody(p: MeshPart, t: number): number {
  if (!p.body) return 0;
  return p.body[p.indices ? p.indices[3 * t] : 3 * t];
}

export function triangleCount(parts: readonly MeshPart[]): number {
  let n = 0;
  for (const p of parts) n += Math.floor((p.indices ? p.indices.length : p.positions.length / 3) / 3);
  return n;
}

/** quantise to 1/64 in; `+ 0` folds −0 into 0 so JSON round trips deep-equal */
export function q64(v: number): number {
  return Math.round(v / HULL_QUANTUM) * HULL_QUANTUM + 0;
}

const cross3 = (ox: number, oy: number, ax: number, ay: number, bx: number, by: number): number =>
  (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);

/**
 * Convex hull of points given as a flat [x0, y0, x1, y1, …] array. Akl–Toussaint prefilter (the
 * octagon of eight extremes discards the interior, which is nearly every vertex of a CAD robot),
 * then Andrew's monotone chain. CCW, no collinear or repeated vertices, starting at the lowest x
 * (then lowest y). Fewer than three distinct non-collinear points return what is left.
 */
export function hullOfXY(xy: ArrayLike<number>, count = Math.floor(xy.length / 2)): Vec2[] {
  if (count === 0) return [];
  // the eight extremes, first occurrence wins
  const ext = [0, 0, 0, 0, 0, 0, 0, 0];
  const key = (i: number, k: number): number => {
    const x = xy[2 * i];
    const y = xy[2 * i + 1];
    switch (k) {
      case 0: return -x;
      case 1: return x;
      case 2: return -y;
      case 3: return y;
      case 4: return -(x + y);
      case 5: return x + y;
      case 6: return -(x - y);
      default: return x - y;
    }
  };
  for (let i = 1; i < count; i++) {
    for (let k = 0; k < 8; k++) if (key(i, k) > key(ext[k], k)) ext[k] = i;
  }
  let candidates: number[];
  if (count > 64) {
    const octPts: number[] = [];
    for (const i of ext) octPts.push(xy[2 * i], xy[2 * i + 1]);
    const oct = monotoneChain(octPts, 8);
    if (oct.length >= 3) {
      candidates = [];
      const eps = 1e-9;
      for (let i = 0; i < count; i++) {
        const x = xy[2 * i];
        const y = xy[2 * i + 1];
        let inside = true;
        for (let e = 0; e < oct.length; e++) {
          const a = oct[e];
          const b = oct[(e + 1) % oct.length];
          if (cross3(a.x, a.y, b.x, b.y, x, y) <= eps) {
            inside = false;
            break;
          }
        }
        if (!inside) candidates.push(i);
      }
    } else {
      candidates = Array.from({ length: count }, (_, i) => i);
    }
  } else {
    candidates = Array.from({ length: count }, (_, i) => i);
  }
  const pts: number[] = [];
  for (const i of candidates) pts.push(xy[2 * i], xy[2 * i + 1]);
  return monotoneChain(pts, candidates.length);
}

function monotoneChain(flat: number[], n: number): Vec2[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  idx.sort((a, b) => flat[2 * a] - flat[2 * b] || flat[2 * a + 1] - flat[2 * b + 1]);
  // drop exact duplicates
  const p: Vec2[] = [];
  for (const i of idx) {
    const x = flat[2 * i];
    const y = flat[2 * i + 1];
    const last = p[p.length - 1];
    if (!last || last.x !== x || last.y !== y) p.push({ x, y });
  }
  if (p.length < 3) return p;
  const lower: Vec2[] = [];
  for (const pt of p) {
    while (lower.length >= 2 && cross3(lower[lower.length - 2].x, lower[lower.length - 2].y, lower[lower.length - 1].x, lower[lower.length - 1].y, pt.x, pt.y) <= 0) lower.pop();
    lower.push(pt);
  }
  const upper: Vec2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const pt = p[i];
    while (upper.length >= 2 && cross3(upper[upper.length - 2].x, upper[upper.length - 2].y, upper[upper.length - 1].x, upper[upper.length - 1].y, pt.x, pt.y) <= 0) upper.pop();
    upper.push(pt);
  }
  lower.pop();
  upper.pop();
  const out = lower.concat(upper);
  return out.length >= 3 ? out : p.slice(0, Math.min(p.length, 2));
}

/** convex hull of a point list (same rules as `hullOfXY`) */
export function convexHull(points: readonly Vec2[]): Vec2[] {
  const flat: number[] = [];
  for (const p of points) if (Number.isFinite(p.x) && Number.isFinite(p.y)) flat.push(p.x, p.y);
  return hullOfXY(flat);
}

/** signed area, positive for CCW */
export function polygonArea(poly: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const r = poly[(i + 1) % poly.length];
    a += p.x * r.y - r.x * p.y;
  }
  return a / 2;
}

export function bbox(points: readonly Vec2[]): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, maxX, minY, maxY };
}

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = a.x + t * dx - p.x;
  const ey = a.y + t * dy - p.y;
  return Math.sqrt(ex * ex + ey * ey);
}

/**
 * How far INSIDE a CCW convex polygon a point is (negative = outside, by roughly that much).
 * The minimum over edges of the signed distance to the edge's line.
 */
export function insetDepth(p: Vec2, poly: readonly Vec2[]): number {
  if (poly.length < 3) return -Infinity;
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) continue;
    const s = cross3(a.x, a.y, b.x, b.y, p.x, p.y) / len;
    if (s < d) d = s;
  }
  return d;
}

/** the nearest point of a CCW convex polygon (the point itself when inside) */
export function clampIntoConvex(p: Vec2, poly: readonly Vec2[]): Vec2 {
  if (poly.length < 3 || insetDepth(p, poly) >= 0) return { x: p.x, y: p.y };
  let best = { x: poly[0].x, y: poly[0].y };
  let bestD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const c = { x: a.x + t * dx, y: a.y + t * dy };
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/** distance from a point to a polygon's boundary (0 on it) */
function distToBoundary(p: Vec2, poly: readonly Vec2[]): number {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) d = Math.min(d, distToSegment(p, poly[i], poly[(i + 1) % poly.length]));
  return d;
}

/** greedy removal of the cheapest vertex — fast, but only a local optimum; the pre-pass */
function greedyReduce(hull: readonly Vec2[], cap: number): Vec2[] {
  const n = hull.length;
  const prev = Array.from({ length: n }, (_, i) => (i + n - 1) % n);
  const next = Array.from({ length: n }, (_, i) => (i + 1) % n);
  const alive = new Array<boolean>(n).fill(true);
  const spanDev = (a: number, b: number): number => {
    let d = 0;
    for (let k = (a + 1) % n; k !== b; k = (k + 1) % n) d = Math.max(d, distToSegment(hull[k], hull[a], hull[b]));
    return d;
  };
  const cost = Array.from({ length: n }, (_, i) => spanDev(prev[i], next[i]));
  for (let left = n; left > cap; left--) {
    let best = -1;
    for (let i = 0; i < n; i++) if (alive[i] && (best < 0 || cost[i] < cost[best])) best = i;
    alive[best] = false;
    const a = prev[best];
    const b = next[best];
    next[a] = b;
    prev[b] = a;
    cost[a] = spanDev(prev[a], next[a]);
    cost[b] = spanDev(prev[b], next[b]);
  }
  return hull.filter((_, i) => alive[i]);
}

/** above this many hull vertices the greedy pass thins first, so the exact search stays cheap */
const REDUCE_EXACT_MAX = 192;

/**
 * Reduce a CCW convex hull to at most `maxVerts` vertices, minimising the largest deviation.
 * The result is an INNER approximation — a subset of the hull's vertices, so still convex — and
 * `deviation` is the largest distance from any input vertex to it, measured, not bounded.
 *
 * MIN-MAX, NOT GREEDY. Removing the cheapest vertex one at a time gets stuck: a 64-gon circle cut
 * to 16 comes out with one gap of 5 and one of 3 (0.26 in) where even spacing gives 0.17, and no
 * single-vertex move fixes it. So: binary-search the tolerance ε; for each ε precompute every
 * vertex's farthest reach (the last vertex whose chord keeps all skipped vertices within ε), and
 * walk the reaches from every start; the fewest steps that close the loop is the vertex count ε
 * needs. A hull longer than `REDUCE_EXACT_MAX` is thinned greedily first (its deviation then is
 * a few thousandths of an inch).
 */
export function reduceHull(hull: readonly Vec2[], maxVerts: number): { hull: Vec2[]; deviation: number } {
  const cap = Math.max(3, Math.floor(maxVerts));
  if (hull.length <= cap) return { hull: hull.map((p) => ({ x: p.x, y: p.y })), deviation: 0 };
  const H = hull.length > REDUCE_EXACT_MAX ? greedyReduce(hull, REDUCE_EXACT_MAX) : hull.slice();
  const n = H.length;
  // dev[i][s] = deviation of the chord i → i+s (s = 1..n-1) over the vertices it skips
  const devFrom = (i: number, maxS: number): Float64Array => {
    const out = new Float64Array(maxS + 1);
    for (let s = 2; s <= maxS; s++) {
      const j = (i + s) % n;
      let d = 0;
      for (let k = 1; k < s; k++) d = Math.max(d, distToSegment(H[(i + k) % n], H[i], H[j]));
      out[s] = d;
    }
    return out;
  };
  const maxSpan = Math.min(n - 1, Math.ceil(n / cap) * 3 + 2);
  const dev = Array.from({ length: n }, (_, i) => devFrom(i, maxSpan));
  // how many vertices tolerance eps needs, and from which start
  const solve = (eps: number): { count: number; start: number } => {
    const reach = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 1;
      while (s < maxSpan && dev[i][s + 1] <= eps) s++;
      reach[i] = s;
    }
    let best = { count: Infinity, start: 0 };
    for (let st = 0; st < n; st++) {
      let at = 0;
      let count = 0;
      while (at < n && count < best.count) {
        const cur = (st + at) % n;
        const left = n - at;
        // close the loop as soon as the start is within reach
        if (left <= maxSpan && dev[cur][left] <= eps) {
          at = n;
        } else {
          at += reach[cur];
        }
        count++;
      }
      if (at >= n && count < best.count) best = { count, start: st };
    }
    return best;
  };
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) for (let s = 2; s <= maxSpan; s++) hi = Math.max(hi, dev[i][s]);
  if (solve(hi).count > cap) {
    // the chord window was too short to reach `cap` (a very uneven hull): fall back to greedy
    const g = greedyReduce(H, cap);
    let deviation = 0;
    for (const p of hull) deviation = Math.max(deviation, distToBoundary(p, g));
    return { hull: g, deviation };
  }
  for (let iter = 0; iter < 48 && hi - lo > 1e-7; iter++) {
    const mid = (lo + hi) / 2;
    if (solve(mid).count <= cap) hi = mid;
    else lo = mid;
  }
  const { start } = solve(hi);
  const idx: number[] = [];
  {
    const reach = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 1;
      while (s < maxSpan && dev[i][s + 1] <= hi) s++;
      reach[i] = s;
    }
    let at = 0;
    while (at < n) {
      const cur = (start + at) % n;
      idx.push(cur);
      const left = n - at;
      at = left <= maxSpan && dev[cur][left] <= hi ? n : at + reach[cur];
    }
  }
  idx.sort((a, b) => a - b);
  const out = idx.map((i) => ({ x: H[i].x, y: H[i].y }));
  let deviation = 0;
  for (const p of hull) deviation = Math.max(deviation, distToBoundary(p, out));
  return { hull: out, deviation };
}

/** quantise every vertex to 1/64 in, then re-hull (quantising can make a vertex collinear) */
export function quantiseHull(hull: readonly Vec2[]): Vec2[] {
  return convexHull(hull.map((p) => ({ x: q64(p.x), y: q64(p.y) })));
}

/** reduce, then quantise; the deviation includes the quantisation */
export function finishHull(raw: readonly Vec2[], maxVerts: number): { hull: Vec2[]; deviation: number } {
  const r = reduceHull(raw, maxVerts);
  let out = quantiseHull(r.hull);
  // quantising never adds a vertex, but a pathological input could leave fewer than three
  if (out.length < 3) out = r.hull.map((p) => ({ x: q64(p.x), y: q64(p.y) }));
  let deviation = 0;
  for (const p of raw) if (insetDepth(p, out) < 0) deviation = Math.max(deviation, distToBoundary(p, out));
  return { hull: out, deviation: Math.max(deviation, r.deviation) };
}

// ---- units, up axis, front --------------------------------------------------------------

/** the unit each format is in when the file does not say */
export function formatDefaultUnit(format: ModelFormat): LengthUnit {
  return format === 'glb' || format === 'gltf' ? 'm' : 'mm';
}

/** glTF is +Y up by spec; CAD and print formats are almost always +Z up */
export function formatDefaultUp(format: ModelFormat): UpAxis {
  return format === 'glb' || format === 'gltf' ? '+y' : '+z';
}

/**
 * Guess the unit from the model's largest extent (in source units). Each candidate is scored by
 * how far, in log space, the robot it implies is from a typical 15-in FTC robot; the format's own
 * unit gets `UNIT_PRIOR_BONUS` off. Lowest wins, ties in `LENGTH_UNITS` order.
 */
export function detectUnits(maxExtent: number, prior: LengthUnit | null): { unit: LengthUnit; scores: Record<LengthUnit, number> } {
  const scores = {} as Record<LengthUnit, number>;
  let unit: LengthUnit = prior ?? 'mm';
  let best = Infinity;
  for (const u of LENGTH_UNITS) {
    const inches = maxExtent * INCHES_PER_UNIT[u];
    const s = inches > 0 ? Math.abs(Math.log(inches / TYPICAL_ROBOT_IN)) - (u === prior ? UNIT_PRIOR_BONUS : 0) : Infinity;
    scores[u] = s;
    if (s < best) {
      best = s;
      unit = u;
    }
  }
  return { unit, scores };
}

type V3 = [number, number, number];
const AXIS_VEC: Record<UpAxis, V3> = {
  '+x': [1, 0, 0],
  '-x': [-1, 0, 0],
  '+y': [0, 1, 0],
  '-y': [0, -1, 0],
  '+z': [0, 0, 1],
  '-z': [0, 0, -1],
};

/**
 * The source axis that becomes FRONT when nobody has said: the CAD front view. A Z-up CAD file
 * is drawn facing −Y (the Front view looks along +Y), a Y-up file (glTF, by spec) faces +Z.
 */
export function defaultFront(up: UpAxis): UpAxis {
  switch (up) {
    case '+z': return '-y';
    case '-z': return '+y';
    case '+y': return '+z';
    case '-y': return '-z';
    default: return '-y';
  }
}

const crossV = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * The 3×3 rotation (rows) taking SOURCE axes to the model frame for this up axis and yaw: row 0 is
 * the source vector that becomes +x (front), row 1 +y (left = up × front), row 2 +z (up). Integer
 * entries only, so it is exact.
 */
export function orientation(up: UpAxis, yaw: QuarterTurns): [V3, V3, V3] {
  const U = AXIS_VEC[up];
  const F = AXIS_VEC[defaultFront(up)];
  const L = crossV(U, F);
  // yaw q quarter turns CCW about +z: x' = cos·x − sin·y, y' = sin·x + cos·y
  const c = [1, 0, -1, 0][yaw];
  const s = [0, 1, 0, -1][yaw];
  const rx: V3 = [c * F[0] - s * L[0], c * F[1] - s * L[1], c * F[2] - s * L[2]];
  const ry: V3 = [s * F[0] + c * L[0], s * F[1] + c * L[1], s * F[2] + c * L[2]];
  return [rx, ry, [U[0], U[1], U[2]]];
}

export interface UpDetection {
  up: UpAxis;
  scores: Record<UpAxis, number>;
  /** best minus second best */
  margin: number;
}

/**
 * Which source axis is UP, from the geometry. A robot stands on its wheels, so the right "down"
 * has floor contacts that spread across the footprint, a centre of mass inside that support
 * polygon, and almost no flat, downward-facing area at the very bottom; a robot lying on a side
 * plate fails the last two. Each signed axis is scored on those three, the format default gets
 * `UP_PRIOR_BONUS`, and the best wins.
 */
export function detectUp(parts: readonly MeshPart[], inchesPerUnit: number, prior: UpAxis): UpDetection {
  // AABB, surface centroid
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    const a = p.positions;
    for (let i = 0; i < a.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = a[i + k] * inchesPerUnit;
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
  }
  const scores = {} as Record<UpAxis, number>;
  if (!Number.isFinite(min[0])) {
    for (const u of UP_AXES) scores[u] = u === prior ? 1 : 0;
    return { up: prior, scores, margin: 1 };
  }
  let areaSum = 0;
  const com: V3 = [0, 0, 0];
  // flat downward area per direction (index: axis*2 + (sign<0 ? 1 : 0))
  const flat = [0, 0, 0, 0, 0, 0];
  forEachTriangle(parts, (ax, ay, az, bx, by, bz, cx, cy, cz) => {
    const A: V3 = [ax * inchesPerUnit, ay * inchesPerUnit, az * inchesPerUnit];
    const B: V3 = [bx * inchesPerUnit, by * inchesPerUnit, bz * inchesPerUnit];
    const C: V3 = [cx * inchesPerUnit, cy * inchesPerUnit, cz * inchesPerUnit];
    const n = crossV([B[0] - A[0], B[1] - A[1], B[2] - A[2]], [C[0] - A[0], C[1] - A[1], C[2] - A[2]]);
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len === 0) return;
    const area = len / 2;
    areaSum += area;
    for (let k = 0; k < 3; k++) com[k] += area * (A[k] + B[k] + C[k]) / 3;
    for (let k = 0; k < 3; k++) {
      const nk = n[k] / len;
      // facing DOWN for "up = +k" means normal ≈ −k; for "up = −k", ≈ +k. Winding varies between
      // exporters, so a face counts whichever way it is wound.
      if (Math.abs(nk) < 0.95) continue;
      const lo = Math.min(A[k], B[k], C[k]);
      const hi = Math.max(A[k], B[k], C[k]);
      if (hi <= min[k] + UP_FLAT_SLAB_IN) flat[k * 2] += area;
      if (lo >= max[k] - UP_FLAT_SLAB_IN) flat[k * 2 + 1] += area;
    }
  });
  if (areaSum > 0) for (let k = 0; k < 3; k++) com[k] /= areaSum;
  else for (let k = 0; k < 3; k++) com[k] = (min[k] + max[k]) / 2;

  for (const up of UP_AXES) {
    const k = up[1] === 'x' ? 0 : up[1] === 'y' ? 1 : 2;
    const neg = up[0] === '-';
    const u = (k + 1) % 3;
    const v = (k + 2) % 3;
    const footArea = Math.max((max[u] - min[u]) * (max[v] - min[v]), 1e-9);
    const support: number[] = [];
    for (const p of parts) {
      const a = p.positions;
      for (let i = 0; i < a.length; i += 3) {
        const h = a[i + k] * inchesPerUnit;
        if (neg ? h >= max[k] - UP_SUPPORT_SLAB_IN : h <= min[k] + UP_SUPPORT_SLAB_IN) {
          support.push(a[i + u] * inchesPerUnit, a[i + v] * inchesPerUnit);
        }
      }
    }
    const sh = hullOfXY(support);
    const spread = sh.length >= 3 ? Math.min(1, Math.abs(polygonArea(sh)) / footArea) : 0;
    const comP = { x: com[u], y: com[v] };
    let stab = 0;
    if (sh.length >= 3) {
      // the hull is CCW in (u, v); depth is positive inside
      const d = insetDepth(comP, sh);
      const scale = Math.sqrt(footArea);
      stab = d >= 0 ? 0.5 + Math.min(0.2, (2 * d) / scale) : Math.max(-0.3, (2 * d) / scale);
    } else {
      stab = -0.3;
    }
    const flatFrac = Math.min(0.5, flat[k * 2 + (neg ? 1 : 0)] / footArea);
    scores[up] = spread + stab - 2 * flatFrac + (up === prior ? UP_PRIOR_BONUS : 0);
  }
  let best: UpAxis = prior;
  for (const u of UP_AXES) if (scores[u] > scores[best]) best = u;
  let second = -Infinity;
  for (const u of UP_AXES) if (u !== best && scores[u] > second) second = scores[u];
  return { up: best, scores, margin: scores[best] - second };
}

/** call `fn` with the source coordinates of every triangle's three corners */
export function forEachTriangle(
  parts: readonly MeshPart[],
  fn: (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number) => void,
): void {
  for (const p of parts) {
    const a = p.positions;
    const idx = p.indices;
    const n = idx ? idx.length : a.length / 3;
    for (let t = 0; t + 2 < n; t += 3) {
      const i = (idx ? idx[t] : t) * 3;
      const j = (idx ? idx[t + 1] : t + 1) * 3;
      const l = (idx ? idx[t + 2] : t + 2) * 3;
      fn(a[i], a[i + 1], a[i + 2], a[j], a[j + 1], a[j + 2], a[l], a[l + 1], a[l + 2]);
    }
  }
}

// ---- wheels ------------------------------------------------------------------------------

interface Cluster {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  n: number;
}

/**
 * Single-linkage clusters of floor-contact points (flat [x, y, …], MODEL frame). Two points join
 * when they are within `link` of each other OR a mesh edge runs between them inside the contact
 * slab (`edges`, pairs of point indices): a wheel's contact line is one edge between two cap
 * vertices a wheel-width apart, and an intake roller's is one edge a robot-width long, so edges
 * are what keep the first one wheel and make the second one long. Points are snapped to a
 * 0.05-in grid and deduplicated first. The partition does not depend on input order; clusters
 * are returned sorted by (minX, minY), so labels do not either.
 */
export function clusterContacts(xy: ArrayLike<number>, edges: ArrayLike<number> = [], link = CONTACT_LINK_IN): Cluster[] {
  const snap = 0.05;
  const seen = new Map<string, number>();
  const pts: number[] = [];
  const dedup = new Int32Array(Math.floor(xy.length / 2));
  for (let i = 0; i + 1 < xy.length; i += 2) {
    const sx = Math.round(xy[i] / snap);
    const sy = Math.round(xy[i + 1] / snap);
    const key = `${sx},${sy}`;
    let d = seen.get(key);
    if (d === undefined) {
      d = pts.length / 2;
      seen.set(key, d);
      pts.push(sx * snap, sy * snap);
    }
    dedup[i / 2] = d;
  }
  const n = pts.length / 2;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let e = 0; e + 1 < edges.length; e += 2) {
    const a = dedup[edges[e]];
    const b = dedup[edges[e + 1]];
    if (a === undefined || b === undefined) continue;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
  const cells = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const key = `${Math.floor(pts[2 * i] / link)},${Math.floor(pts[2 * i + 1] / link)}`;
    let c = cells.get(key);
    if (!c) cells.set(key, (c = []));
    c.push(i);
  }
  const l2 = link * link;
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(pts[2 * i] / link);
    const cy = Math.floor(pts[2 * i + 1] / link);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const c = cells.get(`${cx + dx},${cy + dy}`);
        if (!c) continue;
        for (const j of c) {
          if (j <= i) continue;
          const ex = pts[2 * i] - pts[2 * j];
          const ey = pts[2 * i + 1] - pts[2 * j + 1];
          if (ex * ex + ey * ey <= l2) {
            const ri = find(i);
            const rj = find(j);
            if (ri !== rj) parent[Math.max(ri, rj)] = Math.min(ri, rj);
          }
        }
      }
    }
  }
  const byRoot = new Map<number, Cluster>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const x = pts[2 * i];
    const y = pts[2 * i + 1];
    const c = byRoot.get(r);
    if (!c) byRoot.set(r, { minX: x, maxX: x, minY: y, maxY: y, n: 1 });
    else {
      c.minX = Math.min(c.minX, x);
      c.maxX = Math.max(c.maxX, x);
      c.minY = Math.min(c.minY, y);
      c.maxY = Math.max(c.maxY, y);
      c.n++;
    }
  }
  return [...byRoot.values()].sort((a, b) => a.minX - b.minX || a.minY - b.minY);
}

const clusterCentre = (c: Cluster): Vec2 => ({ x: (c.minX + c.maxX) / 2, y: (c.minY + c.maxY) / 2 });

/**
 * Every vertex at or below `slab` (MODEL frame, so the floor is z = 0), as flat [x, y, …], and
 * every triangle edge with both ends in that set, as pairs of indices into it.
 */
export function floorContacts(modelParts: readonly MeshPart[], slab: number): { xy: number[]; edges: number[] } {
  const xy: number[] = [];
  const edges: number[] = [];
  for (const p of modelParts) {
    const a = p.positions;
    const nV = a.length / 3;
    const local = new Int32Array(nV).fill(-1);
    for (let i = 0; i < nV; i++) {
      if (a[3 * i + 2] <= slab) {
        local[i] = xy.length / 2;
        xy.push(a[3 * i], a[3 * i + 1]);
      }
    }
    const idx = p.indices;
    const n = idx ? idx.length : nV;
    for (let t = 0; t + 2 < n; t += 3) {
      const v = [idx ? idx[t] : t, idx ? idx[t + 1] : t + 1, idx ? idx[t + 2] : t + 2];
      for (let k = 0; k < 3; k++) {
        const s = local[v[k]];
        const e = local[v[(k + 1) % 3]];
        if (s >= 0 && e >= 0) edges.push(s, e);
      }
    }
  }
  return { xy, edges };
}

/**
 * Four wheel contacts (FL, FR, BL, BR) from floor-contact points, MODEL frame. Clusters longer
 * than `WHEEL_MAX_PATCH_IN` are not wheels. With four or more wheel clusters the four CORNER ones
 * are used — the extremes of ±x ± y after normalising by the layout's half-extents, so a 6-wheel
 * tank keeps its outer four. Fewer than four, or corners that are not a front-left / front-right /
 * back-left / back-right layout, fail with a reason.
 */
export function detectWheels(contactXY: ArrayLike<number>, edges: ArrayLike<number> = []): WheelDetection {
  const clusters = clusterContacts(contactXY, edges);
  const contacts = clusters.map(clusterCentre);
  const wheels = clusters.filter((c) => Math.max(c.maxX - c.minX, c.maxY - c.minY) <= WHEEL_MAX_PATCH_IN).map(clusterCentre);
  const long = clusters.length - wheels.length;
  const longNote = long > 0 ? ` ${long} long floor contact${long === 1 ? '' : 's'} (an intake or a skid) ${long === 1 ? 'was' : 'were'} left out.` : '';
  if (wheels.length < 4) {
    return {
      wheels: null,
      contacts,
      note:
        wheels.length === 0
          ? `Couldn’t find any wheels touching the floor.${longNote} Drag the wheel markers onto the wheels.`
          : `Found ${wheels.length} wheel${wheels.length === 1 ? '' : 's'} touching the floor, not four.${longNote} Drag the wheel markers onto the wheels.`,
    };
  }
  const b = bbox(wheels);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const sx = Math.max((b.maxX - b.minX) / 2, 0.5);
  const sy = Math.max((b.maxY - b.minY) / 2, 0.5);
  const pick = (fx: number, fy: number): number => {
    let best = 0;
    let bestS = -Infinity;
    wheels.forEach((w, i) => {
      const s = (fx * (w.x - cx)) / sx + (fy * (w.y - cy)) / sy;
      if (s > bestS + 1e-9) {
        bestS = s;
        best = i;
      }
    });
    return best;
  };
  const ids = [pick(1, 1), pick(1, -1), pick(-1, 1), pick(-1, -1)];
  const [fl, fr, bl, br] = ids.map((i) => wheels[i]);
  const distinct = new Set(ids).size === 4;
  const layoutOk = distinct && fl.x > bl.x + 1 && fr.x > br.x + 1 && fl.y > fr.y + 1 && bl.y > br.y + 1;
  if (!layoutOk) {
    return {
      wheels: null,
      contacts,
      note: `The ${wheels.length} floor contacts don’t form front-left, front-right, back-left and back-right wheels. Drag the wheel markers onto the wheels.`,
    };
  }
  const extra = wheels.length - 4;
  return {
    wheels: [fl, fr, bl, br],
    contacts,
    note:
      (extra > 0 ? `Found ${wheels.length} wheels touching the floor; used the four corner ones.` : 'Found four wheels touching the floor.') +
      longNote,
  };
}

/**
 * THE FOUR LINES of a rectangle of wheels (FL FR BL BR, MODEL frame): the front and back axles
 * (x) and the left and right sides (y). Each line is the mean of the two wheels on it, so a
 * rectangle gives its own lines back exactly ((a + a) / 2 is a in floating point).
 */
export interface WheelLines {
  front: number;
  back: number;
  left: number;
  right: number;
}

export function wheelLines(w: readonly Vec2[]): WheelLines {
  return { front: (w[0].x + w[1].x) / 2, back: (w[2].x + w[3].x) / 2, left: (w[0].y + w[2].y) / 2, right: (w[1].y + w[3].y) / 2 };
}

/** FL FR BL BR on the four lines */
export function linesToWheels(l: WheelLines): Vec2[] {
  return [
    { x: l.front, y: l.left },
    { x: l.front, y: l.right },
    { x: l.back, y: l.left },
    { x: l.back, y: l.right },
  ];
}

/** the rectangle through four wheels' averaged lines (an exact rectangle comes back unchanged) */
export const squareWheels = (w: readonly Vec2[]): Vec2[] => linesToWheels(wheelLines(w));

/** detected wheels this close to a rectangle are lined up into one: each line's two wheels within it, inches */
export const WHEEL_SQUARE_TOL_IN = 0.75;

/** is each line's pair of wheels within `tol` of each other (0: an exact rectangle)? */
export function isRectangle(w: readonly Vec2[], tol = 0): boolean {
  return (
    w.length === 4 &&
    Math.abs(w[0].x - w[1].x) <= tol &&
    Math.abs(w[2].x - w[3].x) <= tol &&
    Math.abs(w[0].y - w[2].y) <= tol &&
    Math.abs(w[1].y - w[3].y) <= tol
  );
}

// ---- front -------------------------------------------------------------------------------

/** the confidence at which the front is DETECTED rather than assumed (`FrontDetection`) */
export const FRONT_MIN_CONFIDENCE = 0.6;
/** how high an intake reaches, inches: the cue looks at geometry no higher than this */
const FRONT_LOW_IN = 3;
/** the outermost slab of that low geometry whose width coverage is measured, inches */
const FRONT_EDGE_SLAB_IN = 1.5;
/** the weights of the three votes: an intake is the strongest cue there is, mass the weakest */
const FRONT_WEIGHTS = { intake: 1, wheels: 0.5, mass: 0.35 } as const;
const COVER_BINS = 24;

/** a vote in [−1, 1] from a signed measure: nothing inside `dead`, all of it at `dead + full` */
const vote = (v: number, dead: number, full: number): number => Math.sign(v) * Math.min(1, Math.max(0, (Math.abs(v) - dead) / full));

/**
 * WHICH WAY THE ROBOT FACES, from its MODEL-frame geometry at yaw `yaw` (`FrontDetection` has the
 * rules). Each cue votes along +x and +y (a negative vote is the other way):
 *
 * - INTAKE: geometry no higher than `FRONT_LOW_IN` reaches past the outermost wheel further at one
 *   end than at the other (by more than ¾ in, all of the vote at 2¼ in), and its outermost
 *   `FRONT_EDGE_SLAB_IN` covers most of the robot's width there. An intake roller does; a frame's
 *   cross member reaches about as far at both ends.
 * - WHEELS: the wheelbase centre sits back from the footprint's centre (½ in dead band), leaving
 *   the long overhang at the front.
 * - MASS: the surface area's centre sits toward the back (5 % of the half-length dead band).
 *
 * The strongest axis wins; the confidence is its weighted vote less the other axis's, so a robot
 * whose cues point two ways, or nowhere, is assumed to face its CAD front.
 */
export function detectFront(modelParts: readonly MeshPart[], wheels: readonly Vec2[] | null, height: number, yaw: QuarterTurns): FrontDetection {
  const none: FrontDetection = { yaw: 0, confidence: 0, detected: false, cue: null };
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  let area = 0;
  let ax = 0;
  let ay = 0;
  const zLow = Math.min(FRONT_LOW_IN, height * 0.25);
  // low geometry's reach in the four directions: +x, −x, +y, −y
  const reach = [-Infinity, -Infinity, -Infinity, -Infinity];
  const each = (fn: (a: Float32Array, i0: number, i1: number, i2: number) => void): void => {
    for (const p of modelParts) {
      const a = p.positions;
      const idx = p.indices;
      const n = idx ? idx.length : a.length / 3;
      for (let t = 0; t + 2 < n; t += 3) fn(a, idx ? idx[t] : t, idx ? idx[t + 1] : t + 1, idx ? idx[t + 2] : t + 2);
    }
  };
  each((a, i, j, k) => {
    const ix = 3 * i;
    const jx = 3 * j;
    const kx = 3 * k;
    const ux = a[jx] - a[ix];
    const uy = a[jx + 1] - a[ix + 1];
    const uz = a[jx + 2] - a[ix + 2];
    const vx = a[kx] - a[ix];
    const vy = a[kx + 1] - a[ix + 1];
    const vz = a[kx + 2] - a[ix + 2];
    const s = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    if (!Number.isFinite(s)) return;
    area += s;
    ax += (s * (a[ix] + a[jx] + a[kx])) / 3;
    ay += (s * (a[ix + 1] + a[jx + 1] + a[kx + 1])) / 3;
    for (const q of [ix, jx, kx]) {
      if (a[q] < x0) x0 = a[q];
      if (a[q] > x1) x1 = a[q];
      if (a[q + 1] < y0) y0 = a[q + 1];
      if (a[q + 1] > y1) y1 = a[q + 1];
    }
    if (a[ix + 2] > zLow || a[jx + 2] > zLow || a[kx + 2] > zLow) return;
    reach[0] = Math.max(reach[0], a[ix], a[jx], a[kx]);
    reach[1] = Math.max(reach[1], -a[ix], -a[jx], -a[kx]);
    reach[2] = Math.max(reach[2], a[ix + 1], a[jx + 1], a[kx + 1]);
    reach[3] = Math.max(reach[3], -a[ix + 1], -a[jx + 1], -a[kx + 1]);
  });
  if (!(area > 0) || !(x1 > x0) || !(y1 > y0)) return none;
  // how much of the width the outermost slab of low geometry covers, per direction
  const cover = [new Uint8Array(COVER_BINS), new Uint8Array(COVER_BINS), new Uint8Array(COVER_BINS), new Uint8Array(COVER_BINS)];
  const mark = (bins: Uint8Array, lo: number, hi: number, from: number, to: number): void => {
    const w = (to - from) / COVER_BINS;
    const b0 = Math.max(0, Math.floor((lo - from) / w));
    const b1 = Math.min(COVER_BINS - 1, Math.floor((hi - from) / w));
    for (let b = b0; b <= b1; b++) bins[b] = 1;
  };
  each((a, i, j, k) => {
    const ix = 3 * i;
    const jx = 3 * j;
    const kx = 3 * k;
    if (a[ix + 2] > zLow || a[jx + 2] > zLow || a[kx + 2] > zLow) return;
    const xs = [a[ix], a[jx], a[kx]];
    const ys = [a[ix + 1], a[jx + 1], a[kx + 1]];
    const mxX = Math.max(...xs);
    const mnX = Math.min(...xs);
    const mxY = Math.max(...ys);
    const mnY = Math.min(...ys);
    if (mxX >= reach[0] - FRONT_EDGE_SLAB_IN) mark(cover[0], mnY, mxY, y0, y1);
    if (-mnX >= reach[1] - FRONT_EDGE_SLAB_IN) mark(cover[1], mnY, mxY, y0, y1);
    if (mxY >= reach[2] - FRONT_EDGE_SLAB_IN) mark(cover[2], mnX, mxX, x0, x1);
    if (-mnY >= reach[3] - FRONT_EDGE_SLAB_IN) mark(cover[3], mnX, mxX, x0, x1);
  });
  const coverage = cover.map((b) => b.reduce((s, v) => s + v, 0) / COVER_BINS);
  const fx = (x0 + x1) / 2;
  const fy = (y0 + y1) / 2;
  // [x, y] votes per cue
  const intake = [0, 0];
  const wheel = [0, 0];
  if (wheels && wheels.length >= 4) {
    const wx1 = Math.max(...wheels.map((w) => w.x));
    const wx0 = Math.min(...wheels.map((w) => w.x));
    const wy1 = Math.max(...wheels.map((w) => w.y));
    const wy0 = Math.min(...wheels.map((w) => w.y));
    // reach past the outermost wheel at each end, and the cover of the end that reaches further
    const axis = (pos: number, neg: number, wPos: number, wNeg: number, cPos: number, cNeg: number): number => {
      if (!Number.isFinite(pos) || !Number.isFinite(neg)) return 0;
      const d = pos - wPos - (neg + wNeg);
      const c = d > 0 ? cPos : cNeg;
      return vote(d, 0.75, 1.5) * Math.min(1, Math.max(0, (c - 0.3) / 0.4));
    };
    intake[0] = axis(reach[0], reach[1], wx1, wx0, coverage[0], coverage[1]);
    intake[1] = axis(reach[2], reach[3], wy1, wy0, coverage[2], coverage[3]);
    wheel[0] = -vote((wx0 + wx1) / 2 - fx, 0.5, 1.5);
    wheel[1] = -vote((wy0 + wy1) / 2 - fy, 0.5, 1.5);
  }
  const mass = [-vote((ax / area - fx) / ((x1 - x0) / 2), 0.05, 0.15), -vote((ay / area - fy) / ((y1 - y0) / 2), 0.05, 0.15)];
  const S = [0, 1].map((k) => FRONT_WEIGHTS.intake * intake[k] + FRONT_WEIGHTS.wheels * wheel[k] + FRONT_WEIGHTS.mass * mass[k]);
  const major = Math.abs(S[0]) >= Math.abs(S[1]) ? 0 : 1;
  const confidence = Math.min(1, Math.max(0, Math.abs(S[major]) - Math.abs(S[1 - major])));
  if (S[major] === 0) return none;
  // the direction, as the turn that brings it to +x: +x 0, −y 1, −x 2, +y 3
  const turn: QuarterTurns = major === 0 ? (S[0] > 0 ? 0 : 2) : S[1] > 0 ? 3 : 1;
  const parts = { intake: FRONT_WEIGHTS.intake * intake[major], wheels: FRONT_WEIGHTS.wheels * wheel[major], mass: FRONT_WEIGHTS.mass * mass[major] };
  const sign = Math.sign(S[major]);
  const cue = (Object.keys(parts) as (keyof typeof parts)[]).reduce((best, k) => (parts[k] * sign > parts[best] * sign ? k : best), 'intake' as keyof typeof parts);
  const detected = confidence >= FRONT_MIN_CONFIDENCE;
  return { yaw: detected ? (((yaw + turn) % 4) as QuarterTurns) : 0, confidence: Math.round(confidence * 1000) / 1000, detected, cue: parts[cue] * sign > 0 ? cue : null };
}

// ---- height bands ------------------------------------------------------------------------

/**
 * Up to five stacked convex prisms for 3D collision. Triangles are clipped into
 * `BAND_SLICE_IN` slices, each slice hulled, and the slices split into contiguous bands by DP on
 * the volume each band's hull wastes over the slices inside it, where waste under `LOW_BAND_IN`
 * counts `LOW_WEIGHT` times. Each `BAND_OWN_Z` range is one slice no band holds with anything
 * else, and the clearance either side of it is in no band. Returned only when they save at least `BAND_MIN_SAVING` of the one-prism
 * volume; MODEL frame. Each band carries its cuts (`bandCuts`).
 *
 * ⚠️ THE FLOOR IS WHERE FIELD ELEMENTS MEET A ROBOT (2026-10-04, owner on goBILDA's BIOBUZZ bot: "I
 * know i can get closer into the flower but it blocks me"). Its lowest band ran from the tiles to 5 in
 * and out to its side rollers, 2.7 in past the drive wheels, while under 1 in nothing stands past the
 * wheels: a FLOWER's lower plate (0.354 in up) slides under the real robot and stopped on the band.
 * Unweighted, that slab is too little volume for the DP to cut off even with more bands; weighted, it
 * is a band of its own (0–1 in, the front at the wheels), and the fourth band keeps the rest as it was.
 *
 * ⚠️ AND A FLOWER'S MIDDLE PLATE IS A BAND OF ITS OWN (the same complaint, what was left of it). The
 * bot's frame between its side rollers reaches 7.69 in at the plate's heights, but its intake's cross
 * bar just under the plate reaches 7.81 and whatever it carries above reaches 8.0; a band shared with
 * either kept the plate 0.2–0.4 in further out than the real robot stops.
 */
/** the tallest model bands are computed for (the 18-in cube with room for a units guess near it) */
const BAND_MAX_HEIGHT_IN = ROBOT_MAX_IN * 1.5;

export function computeBands(modelParts: readonly MeshPart[], heightIn: number, maxBands = MAX_BANDS): ImportedBand[] | null {
  // ONLY FOR A ROBOT-SIZED MODEL. The DP below is cubic in the slice count, and a model read in the
  // wrong units (an mm export taken as inches is 380 in tall: 762 slices) took 42 s on the main
  // thread, freezing the editor on one Units click. Such a model is blocked as oversize anyway,
  // and bands are never saved for it.
  if (!(heightIn > BAND_SLICE_IN * 2) || heightIn > BAND_MAX_HEIGHT_IN) return null;
  // the slice boundaries: the grid, less what falls in or beside an own range's clearance, plus the
  // clearance's ends and the band's own
  const own = BAND_OWN_Z.filter((o) => o.clear[0] > BAND_MIN_SLICE_IN && o.band[0] < heightIn - BAND_MIN_SLICE_IN);
  const zs: number[] = [];
  for (let k = 0; k * BAND_SLICE_IN < heightIn - 1e-9; k++) {
    const z = k * BAND_SLICE_IN;
    if (own.some((o) => z > o.clear[0] - BAND_MIN_SLICE_IN && z < o.clear[1] + BAND_MIN_SLICE_IN)) continue;
    zs.push(z);
  }
  for (const o of own) for (const z of [o.clear[0], o.band[0], o.band[1], o.clear[1]]) if (z < heightIn - BAND_MIN_SLICE_IN) zs.push(z);
  zs.sort((p, q) => p - q);
  zs.push(heightIn);
  const S = zs.length - 1;
  // a band may not hold an own range's slice with any other, and no band holds a clearance slice
  const ownSlice = zs.slice(0, S).map((z) => own.some((o) => z === o.band[0]));
  const gapSlice = zs.slice(0, S).map((z) => own.some((o) => z === o.clear[0] || z === o.band[1]));
  const slicePts: number[][] = Array.from({ length: S }, () => []);
  const sliceZ = (s: number): number => zs[s];
  // the slice holding height z (the last whose start is at or under it)
  const sliceOf = (z: number): number => {
    let lo = 0;
    let hi = S - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (zs[mid] <= z) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const clipAdd = (P: V3[], s: number): void => {
    const c = clipZ(P, sliceZ(s), sliceZ(s + 1));
    const dst = slicePts[s];
    for (const p of c) dst.push(p[0], p[1]);
  };
  forEachTriangle(modelParts, (ax, ay, az, bx, by, bz, cx, cy, cz) => {
    const lo = Math.min(az, bz, cz);
    const hi = Math.max(az, bz, cz);
    const s0 = sliceOf(lo);
    const s1 = sliceOf(hi);
    if (s0 === s1) {
      slicePts[s0].push(ax, ay, bx, by, cx, cy);
      return;
    }
    const P: V3[] = [[ax, ay, az], [bx, by, bz], [cx, cy, cz]];
    for (let s = s0; s <= s1; s++) clipAdd(P, s);
  });
  const sliceHull = slicePts.map((pts) => hullOfXY(pts));
  const sliceArea = sliceHull.map((h) => (h.length >= 3 ? Math.abs(polygonArea(h)) : 0));
  const sliceH = Array.from({ length: S }, (_, s) => sliceZ(s + 1) - sliceZ(s));
  // what is wasted near the floor counts LOW_WEIGHT times: that is where a FLOWER's plates, an
  // element on the tiles and another robot's frame meet this one, and an intake's overhang above the
  // floor is empty there however little volume it is (`LOW_BAND_IN`)
  const sliceW = Array.from({ length: S }, (_, s) => (sliceZ(s + 1) <= LOW_BAND_IN + 1e-9 ? LOW_WEIGHT : 1));
  const filled = sliceArea.reduce((acc, a, s) => acc + a * sliceH[s] * sliceW[s], 0);
  // hull area of slices i..j, memoised
  const memo = new Map<number, number>();
  const unionArea = (i: number, j: number): number => {
    const key = i * (S + 1) + j;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const pts: number[] = [];
    for (let s = i; s <= j; s++) for (const p of sliceHull[s]) pts.push(p.x, p.y);
    const h = hullOfXY(pts);
    const a = h.length >= 3 ? Math.abs(polygonArea(h)) : 0;
    memo.set(key, a);
    return a;
  };
  const wh = (i: number, j: number): number => {
    let t = 0;
    for (let s = i; s <= j; s++) t += sliceH[s] * sliceW[s];
    return t;
  };
  // a band holding an own slice holds nothing else, and none holds a clearance slice
  const bandCost = (i: number, j: number): number => {
    for (let s = i; s <= j; s++) if (gapSlice[s] || (j > i && ownSlice[s])) return Infinity;
    return unionArea(i, j) * wh(i, j);
  };
  // DP[k][j] = min total prism volume covering slices 0..j with k bands (a clearance slice is
  // covered by nothing: the bands before it carry over)
  const K = Math.max(1, Math.min(MAX_BANDS, maxBands));
  const dp: number[][] = Array.from({ length: K + 1 }, () => new Array<number>(S).fill(Infinity));
  const cut: number[][] = Array.from({ length: K + 1 }, () => new Array<number>(S).fill(-1));
  for (let j = 0; j < S; j++) dp[1][j] = gapSlice[j] && j > 0 ? dp[1][j - 1] : bandCost(0, j);
  for (let k = 2; k <= K; k++) {
    for (let j = 0; j < S; j++) {
      if (gapSlice[j]) {
        if (j > 0) dp[k][j] = dp[k][j - 1];
        continue;
      }
      for (let i = 1; i <= j; i++) {
        const c = dp[k - 1][i - 1] + bandCost(i, j);
        if (c < dp[k][j] - 1e-9) {
          dp[k][j] = c;
          cut[k][j] = i;
        }
      }
    }
  }
  // the one prism, held apart from nothing: what bands are measured against
  const single = unionArea(0, S - 1) * wh(0, S - 1);
  // the fewest bands that keep each own slice apart, then more while each pays its way
  let bestK = 1;
  while (bestK < K && !Number.isFinite(dp[bestK][S - 1])) bestK++;
  if (!Number.isFinite(dp[bestK][S - 1])) return null;
  for (let k = bestK + 1; k <= K; k++) if (dp[k][S - 1] < dp[bestK][S - 1] - BAND_MIN_SAVING * single * 0.4) bestK = k;
  if (bestK === 1 || single - dp[bestK][S - 1] < BAND_MIN_SAVING * single || single <= filled) return null;
  const ranges: [number, number][] = [];
  let j = S - 1;
  for (let k = bestK; k >= 1; ) {
    if (gapSlice[j]) {
      j--;
      continue;
    }
    const i = k === 1 ? 0 : cut[k][j];
    ranges.unshift([i, j]);
    j = i - 1;
    k--;
  }
  const bands: ImportedBand[] = [];
  for (const [i, jj] of ranges) {
    const pts: Vec2[] = [];
    for (let s = i; s <= jj; s++) pts.push(...sliceHull[s]);
    const h = convexHull(pts);
    if (h.length < 3) continue;
    const { hull } = finishHull(h, MAX_BAND_VERTS);
    if (hull.length < 3) continue;
    bands.push({ z0: q64(sliceZ(i)), z1: q64(sliceZ(jj + 1)), hull });
  }
  if (bands.length < 2) return null;
  bandCuts(modelParts, bands);
  return bands;
}

/** `poly` with z in [z0, z1] (Sutherland–Hodgman) */
function clipZ(poly: V3[], z0: number, z1: number): V3[] {
  const clip = (pts: V3[], keep: (p: V3) => number): V3[] => {
    const out: V3[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const da = keep(a);
      const db = keep(b);
      if (da >= 0) out.push(a);
      if ((da >= 0) !== (db >= 0)) {
        const t = da / (da - db);
        out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])]);
      }
    }
    return out;
  };
  return clip(clip(poly, (p) => p[2] - z0), (p) => z1 - p[2]);
}

/** each edge's outward normal and the axis its span runs along: `IMPORT_EDGE_N`/`IMPORT_EDGE_P`
 *  (`src/sim/importedMech.ts`, which smoke holds these equal to; copied so the measure worker
 *  does not pull in the game config) */
export const BAND_CUT_EDGES: readonly { edge: ImportedEdge; n: Vec2; p: Vec2 }[] = [
  { edge: 'front', n: { x: 1, y: 0 }, p: { x: 0, y: 1 } },
  { edge: 'back', n: { x: -1, y: 0 }, p: { x: 0, y: -1 } },
  { edge: 'left', n: { x: 0, y: 1 }, p: { x: -1, y: 0 } },
  { edge: 'right', n: { x: 0, y: -1 }, p: { x: 1, y: 0 } },
];

/** the largest `u` of polygon (`us`, `vs`) inside `a ≤ v ≤ b`; −∞ when it misses the slab */
function maxUInSlab(us: ArrayLike<number>, vs: ArrayLike<number>, n: number, a: number, b: number): number {
  let best = -Infinity;
  for (let i = 0; i < n; i++) {
    const u0 = us[i];
    const v0 = vs[i];
    if (v0 >= a && v0 <= b && u0 > best) best = u0;
    const j = i + 1 === n ? 0 : i + 1;
    const v1 = vs[j];
    if (v1 === v0) continue;
    for (const c of [a, b]) {
      if ((v0 - c) * (v1 - c) < 0) {
        const u = u0 + ((c - v0) / (v1 - v0)) * (us[j] - u0);
        if (u > best) best = u;
      }
    }
  }
  return best;
}

/**
 * A BAND'S CUTS: where its convex hull stands proud of the model, edge by edge. Each edge is
 * sampled in `CUT_BINS` bins across the hull; a bin's model edge is the furthest any triangle,
 * clipped to the band's heights, reaches inside it (± `CUT_V_MARGIN`), and runs of bins the hull
 * overstates by `CUT_MIN_GAIN_IN` become cuts at the run's furthest model edge plus
 * `CUT_MARGIN_IN`. So a cut only ever removes empty space. At most `MAX_EDGE_CUTS` an edge, and
 * only on bands reaching `CUT_FROM_Z`. MODEL frame, unquantised.
 *
 * Why (2026-10-04, owner on goBILDA's BIOBUZZ bot: "I know i can get closer into the flower but it
 * blocks me"): its two side rollers stand 2 in proud of the frame between them, the band's hull
 * bridges the gap, and a FLOWER's middle plate, which reaches into that gap on the real robot,
 * stopped on the bridge.
 */
function bandCuts(modelParts: readonly MeshPart[], bands: ImportedBand[]): void {
  const B = bands.length;
  const E = BAND_CUT_EDGES.length;
  const lo = new Float64Array(B * E);
  const w = new Float64Array(B * E);
  const prof = new Float64Array(B * E * CUT_BINS).fill(-Infinity);
  for (let bi = 0; bi < B; bi++) {
    for (let ei = 0; ei < E; ei++) {
      const p = BAND_CUT_EDGES[ei].p;
      let a = Infinity;
      let b = -Infinity;
      for (const q of bands[bi].hull) {
        const v = q.x * p.x + q.y * p.y;
        a = Math.min(a, v);
        b = Math.max(b, v);
      }
      lo[bi * E + ei] = a;
      w[bi * E + ei] = (b - a) / CUT_BINS;
    }
  }
  const us = new Float64Array(8);
  const vs = new Float64Array(8);
  forEachTriangle(modelParts, (ax, ay, az, bx, by, bz, cx, cy, cz) => {
    const zl = Math.min(az, bz, cz);
    const zh = Math.max(az, bz, cz);
    for (let bi = 0; bi < B; bi++) {
      const band = bands[bi];
      if (zh < band.z0 || zl > band.z1) continue;
      const tri: V3[] = [[ax, ay, az], [bx, by, bz], [cx, cy, cz]];
      const poly = zl < band.z0 || zh > band.z1 ? clipZ(tri, band.z0, band.z1) : tri;
      const n = Math.min(8, poly.length);
      if (n === 0) continue;
      for (let ei = 0; ei < E; ei++) {
        const k = bi * E + ei;
        const W = w[k];
        if (!(W > 0)) continue;
        const { n: N, p: P } = BAND_CUT_EDGES[ei];
        let vmin = Infinity;
        let vmax = -Infinity;
        let umax = -Infinity;
        for (let i = 0; i < n; i++) {
          const [x, y] = poly[i];
          us[i] = x * N.x + y * N.y;
          vs[i] = x * P.x + y * P.y;
          vmin = Math.min(vmin, vs[i]);
          vmax = Math.max(vmax, vs[i]);
          umax = Math.max(umax, us[i]);
        }
        const k0 = Math.max(0, Math.floor((vmin - CUT_V_MARGIN - lo[k]) / W));
        const k1 = Math.min(CUT_BINS - 1, Math.floor((vmax + CUT_V_MARGIN - lo[k]) / W));
        for (let bin = k0; bin <= k1; bin++) {
          const at = k * CUT_BINS + bin;
          if (umax <= prof[at]) continue;
          const a = lo[k] + bin * W - CUT_V_MARGIN;
          const b = lo[k] + (bin + 1) * W + CUT_V_MARGIN;
          prof[at] = vmin >= a && vmax <= b ? umax : Math.max(prof[at], maxUInSlab(us, vs, n, a, b));
        }
      }
    }
  });
  for (let bi = 0; bi < B; bi++) {
    const band = bands[bi];
    if (!(band.z1 > CUT_FROM_Z)) continue;
    const kept: ImportedCut[] = [];
    for (let ei = 0; ei < E; ei++) {
      const found: { cut: ImportedCut; value: number }[] = [];
      const k = bi * E + ei;
      const W = w[k];
      if (!(W > 0)) continue;
      const { edge, n: N, p: P } = BAND_CUT_EDGES[ei];
      const hu = band.hull.map((q) => q.x * N.x + q.y * N.y);
      const hv = band.hull.map((q) => q.x * P.x + q.y * P.y);
      const uMin = Math.min(...hu);
      const sup: number[] = [];
      const edgeAt: number[] = [];
      for (let bin = 0; bin < CUT_BINS; bin++) {
        sup.push(maxUInSlab(hu, hv, hu.length, lo[k] + bin * W, lo[k] + (bin + 1) * W));
        const m = prof[k * CUT_BINS + bin];
        edgeAt.push(m === -Infinity ? uMin : m);
      }
      const ok = (bin: number): boolean => sup[bin] - (edgeAt[bin] + CUT_MARGIN_IN) >= CUT_MIN_GAIN_IN;
      for (let i = 0; i < CUT_BINS; ) {
        if (!ok(i)) {
          i++;
          continue;
        }
        let j = i;
        let line = edgeAt[i];
        while (j + 1 < CUT_BINS && ok(j + 1) && Math.abs(edgeAt[j + 1] - edgeAt[j]) <= CUT_STEP_IN) {
          j++;
          line = Math.max(line, edgeAt[j]);
        }
        line += CUT_MARGIN_IN;
        let value = 0;
        for (let t = i; t <= j; t++) value += Math.min(Math.max(sup[t] - line, 0), CUT_VALUE_DEPTH_IN) * W;
        const v0 = lo[k] + i * W;
        const v1 = lo[k] + (j + 1) * W;
        // the span convention of `ImportedMech.intakes` (`vToSpan`): from < to on the robot's axis
        const span = edge === 'front' || edge === 'right' ? { from: v0, to: v1 } : { from: -v1, to: -v0 };
        if (value > 0) found.push({ cut: { edge, ...span, at: line * (N.x + N.y) }, value });
        i = j + 1;
      }
      found.sort((a, b) => b.value - a.value);
      for (const f of found.slice(0, MAX_EDGE_CUTS).sort((a, b) => a.cut.from - b.cut.from)) kept.push(f.cut);
    }
    if (kept.length > 0) band.cuts = kept;
  }
}

/** a cut in another frame: shifted by −`o`, then scaled by `s`, on the 1/64 grid */
export function moveCut(c: ImportedCut, o: Vec2, s = 1): ImportedCut {
  const endEdge = c.edge === 'front' || c.edge === 'back';
  const oa = endEdge ? o.x : o.y;
  const os = endEdge ? o.y : o.x;
  return { edge: c.edge, from: q64((c.from - os) * s), to: q64((c.to - os) * s), at: q64((c.at - oa) * s) };
}

// ---- the whole measurement -----------------------------------------------------------------

/** a column-major 4×4 from a 3×3 (rows) linear part and a translation */
function mat4(rows: [V3, V3, V3], t: V3): number[] {
  return [
    rows[0][0], rows[1][0], rows[2][0], 0,
    rows[0][1], rows[1][1], rows[2][1], 0,
    rows[0][2], rows[1][2], rows[2][2], 0,
    t[0], t[1], t[2], 1,
  ];
}

/**
 * Apply a column-major 4×4 to every part's positions (new arrays; indices shared). Normals are
 * carried through the linear part and renormalised — exact for the similarity transforms the
 * importer uses (rotation × uniform scale).
 */
export function transformParts(parts: readonly MeshPart[], m: readonly number[]): MeshPart[] {
  return parts.map((p) => {
    const a = p.positions;
    const out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i += 3) {
      const x = a[i];
      const y = a[i + 1];
      const z = a[i + 2];
      out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
      out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    }
    let normals: Float32Array | null = null;
    if (p.normals) {
      const n = p.normals;
      normals = new Float32Array(n.length);
      for (let i = 0; i < n.length; i += 3) {
        const x = m[0] * n[i] + m[4] * n[i + 1] + m[8] * n[i + 2];
        const y = m[1] * n[i] + m[5] * n[i + 1] + m[9] * n[i + 2];
        const z = m[2] * n[i] + m[6] * n[i + 1] + m[10] * n[i + 2];
        const l = Math.hypot(x, y, z) || 1;
        normals[i] = x / l;
        normals[i + 1] = y / l;
        normals[i + 2] = z / l;
      }
    }
    return { positions: out, indices: p.indices, normals, color: p.color, name: p.name, body: p.body ?? null };
  });
}

/** a fresh `ImportSetup` with everything on auto (the drive defaults are the sim's reference) */
export function defaultImportSetup(drive?: Partial<ImportSetup['drive']>): ImportSetup {
  return {
    v: 1,
    units: 'auto',
    up: 'auto',
    yaw: 0,
    hullMaxVerts: MAX_HULL_VERTS,
    wheels: null,
    bands: true,
    triBudget: DEFAULT_TRI_BUDGET,
    drive: {
      drivetrain: 'mecanum',
      motor: { kind: 'gobilda', ratio: '19.2' },
      externalRatio: 1,
      wheel: { kind: 'catalogue', id: 'gobilda-gripforce-104' },
      massLb: 30,
      ...drive,
    },
  };
}

export interface MeasureOptions {
  format: ModelFormat;
  /** the unit the file itself declares (STEP via occt, 3MF's `unit`), when it does */
  fileUnit?: LengthUnit | null;
}

const UNIT_WORD: Record<LengthUnit, string> = { mm: 'millimetres', cm: 'centimetres', m: 'metres', in: 'inches', ft: 'feet' };
const fmtIn = (v: number): string => (Math.round(v * 10) / 10).toFixed(1);

/**
 * THE HEAVY HALF OF A MEASUREMENT: everything that depends on the parts and on the setup's units,
 * up axis, yaw and band switch, and on nothing else in it. A wheel dragged, a drivetrain picked or
 * a hull cap changed leaves all of this as it was, so the engine keeps one per orientation and
 * re-runs only `finishMeasure`. Plain JSON, so a worker can compute it and post it back.
 */
export interface OrientedMeasure {
  units: LengthUnit;
  unitsDetected: boolean;
  up: UpAxis;
  upDetected: boolean;
  upMargin: number;
  yaw: QuarterTurns;
  /** source → MODEL frame, column-major 4×4 */
  sourceToModel: number[];
  empty: boolean;
  trisIn: number;
  size: { length: number; width: number; height: number };
  /** the footprint's convex hull before reduction, MODEL frame */
  rawHull: Vec2[];
  /** what wheel detection found (a manual override is applied in `finishMeasure`) */
  wheels: WheelDetection;
  /** which way the geometry says the robot faces (`detectFront`), as a yaw from the CAD front */
  front: FrontDetection;
  /** bands in the MODEL frame, before the shift to the wheelbase centre; null = none or not asked */
  bandsModel: ImportedBand[] | null;
  /** the hinged moving parts folded for the starting configuration, as planned (rotated frame:
   *  after the linear part of `sourceToModel`, before its shift). `toModelFrame` re-applies them. */
  folds: FoldPlan[];
}

/** what `orientParts` depends on in a setup: equal keys, equal `OrientedMeasure` */
export function orientKey(setup: ImportSetup): string {
  // a FOLD changes the footprint, so a hinged moving part (and what rides on it) is part of the key;
  // a spinning part alone is not (it moves nothing the heavy half measures)
  const f = foldKey(setup.motion);
  return `${setup.units}|${setup.up}|${setup.yaw}|${setup.bands ? 1 : 0}${f ? `|${f}` : ''}`;
}

/**
 * SOURCE → MODEL frame exactly as `orientParts` does it: the linear part first (stored to float32),
 * then the translation added in place. Doing it as one affine step would round once instead of
 * twice and give positions a float32 ulp away, so the engine rebuilds the model frame on the main
 * thread from a worker's `sourceToModel` with THIS, and gets the same arrays bit for bit.
 */
export function toModelFrame(parts: readonly MeshPart[], sourceToModel: readonly number[], folds: readonly FoldPlan[] = []): MeshPart[] {
  const m = sourceToModel;
  const linear = [m[0], m[1], m[2], 0, m[4], m[5], m[6], 0, m[8], m[9], m[10], 0, 0, 0, 0, 1];
  const t = [m[12], m[13], m[14]];
  const rotated = transformParts(parts, linear);
  // the folds at the same step `orientParts` makes them: after the linear part, before the shift
  applyFolds(rotated, folds);
  return rotated.map((p) => {
    const a = p.positions;
    for (let i = 0; i < a.length; i += 3) {
      a[i] += t[0];
      a[i + 1] += t[1];
      a[i + 2] += t[2];
    }
    return p;
  });
}

/**
 * Measure a model: detect (or apply) units, up axis and yaw, put it in the MODEL frame, and
 * measure the footprint hull, height, floor contacts, wheels, wheelbase centre and height bands.
 * Returns the measurement and the parts in the MODEL frame (for the engine to simplify and bake).
 * `orientParts` then `finishMeasure`, so a caller that keeps the first can re-run only the second.
 */
export function measureParts(
  parts: readonly MeshPart[],
  setup: ImportSetup,
  opts: MeasureOptions,
): { measurement: ImportMeasurement; modelParts: MeshPart[] } {
  const { oriented, modelParts } = orientParts(parts, setup, opts);
  return { measurement: withMotion(finishMeasure(oriented, setup), modelParts, setup, oriented), modelParts };
}

/**
 * The moving parts on a finished measurement (`MotionPart`, MODEL frame, starting pose), when the
 * setup has any. Light: reads only the moving bodies' vertices. `measureParts` and the engine's
 * cached measurer both call it, so the two agree field for field.
 */
export function withMotion(measurement: ImportMeasurement, modelParts: readonly MeshPart[], setup: ImportSetup, o: OrientedMeasure): ImportMeasurement {
  if (!setup.motion || o.empty) return measurement;
  const t: [number, number, number] = [o.sourceToModel[12], o.sourceToModel[13], o.sourceToModel[14]];
  measurement.motion = deriveMotion(modelParts, setup.motion, o.folds, t);
  return measurement;
}

/** the heavy half (`OrientedMeasure`), and the parts in the MODEL frame it was measured on */
export function orientParts(
  parts: readonly MeshPart[],
  setup: ImportSetup,
  opts: MeasureOptions,
): { oriented: OrientedMeasure; modelParts: MeshPart[] } {
  const trisIn = triangleCount(parts);
  // source AABB
  let maxExtent = 0;
  {
    const mn = [Infinity, Infinity, Infinity];
    const mx = [-Infinity, -Infinity, -Infinity];
    for (const p of parts) {
      const a = p.positions;
      for (let i = 0; i < a.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          const v = a[i + k];
          if (!Number.isFinite(v)) continue;
          if (v < mn[k]) mn[k] = v;
          if (v > mx[k]) mx[k] = v;
        }
      }
    }
    for (let k = 0; k < 3; k++) if (mx[k] > mn[k]) maxExtent = Math.max(maxExtent, mx[k] - mn[k]);
  }
  const unitPrior = opts.fileUnit ?? formatDefaultUnit(opts.format);
  const unitsDetected = setup.units === 'auto' && !opts.fileUnit;
  const units: LengthUnit =
    setup.units !== 'auto' ? setup.units : opts.fileUnit ? opts.fileUnit : detectUnits(maxExtent, unitPrior).unit;
  const k = INCHES_PER_UNIT[units];
  const upPrior = formatDefaultUp(opts.format);
  let up: UpAxis;
  let upMargin = 1;
  if (setup.up !== 'auto') up = setup.up;
  else {
    const d = detectUp(parts, k, upPrior);
    up = d.up;
    upMargin = d.margin;
  }
  const yaw = setup.yaw;
  const R = orientation(up, yaw);
  const rows: [V3, V3, V3] = [
    [R[0][0] * k, R[0][1] * k, R[0][2] * k],
    [R[1][0] * k, R[1][1] * k, R[1][2] * k],
    [R[2][0] * k, R[2][1] * k, R[2][2] * k],
  ];
  const rotated = transformParts(parts, mat4(rows, [0, 0, 0]));
  // HINGED MOVING PARTS THE FILE SHOWS DEPLOYED ARE FOLDED HERE, before anything is measured: the box,
  // the centring, the footprint, the floor contacts and the bands are all of the STARTING pose
  // (`motion.ts`, `planFolds`)
  const folds = setup.motion && setup.motion.length ? planFolds(rotated, setup.motion) : [];
  applyFolds(rotated, folds);
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (const p of rotated) {
    const a = p.positions;
    for (let i = 0; i < a.length; i += 3) {
      for (let j = 0; j < 3; j++) {
        const v = a[i + j];
        if (v < mn[j]) mn[j] = v;
        if (v > mx[j]) mx[j] = v;
      }
    }
  }
  const empty = trisIn === 0 || !Number.isFinite(mn[0]);
  const t: V3 = empty ? [0, 0, 0] : [-(mn[0] + mx[0]) / 2, -(mn[1] + mx[1]) / 2, -mn[2]];
  const sourceToModel = mat4(rows, t);
  const modelParts = rotated.map((p) => {
    const a = p.positions;
    for (let i = 0; i < a.length; i += 3) {
      a[i] += t[0];
      a[i + 1] += t[1];
      a[i + 2] += t[2];
    }
    return p;
  });
  const size = empty
    ? { length: 0, width: 0, height: 0 }
    : { length: mx[0] - mn[0], width: mx[1] - mn[1], height: mx[2] - mn[2] };

  // footprint: hull of per-part hulls
  const hullPts: Vec2[] = [];
  for (const p of modelParts) {
    const a = p.positions;
    const xy = new Float64Array((a.length / 3) * 2);
    for (let i = 0, j = 0; i < a.length; i += 3, j += 2) {
      xy[j] = a[i];
      xy[j + 1] = a[i + 1];
    }
    hullPts.push(...hullOfXY(xy));
  }
  const rawHull = convexHull(hullPts);

  // floor contacts → wheels
  let wheels: WheelDetection = { wheels: null, contacts: [], note: 'Couldn’t find any wheels touching the floor. Drag the wheel markers onto the wheels.' };
  if (!empty) {
    for (const slab of WHEEL_SLABS_IN) {
      const { xy, edges } = floorContacts(modelParts, slab);
      const d = detectWheels(xy, edges);
      if (slab === WHEEL_SLABS_IN[0] || d.wheels) wheels = d;
      if (d.wheels) break;
    }
    if (!wheels.wheels || !isRectangle(wheels.wheels, WHEEL_SQUARE_TOL_IN)) {
      const { xy, edges } = floorContacts(modelParts, WHEEL_THIN_SLAB_IN);
      const d = detectWheels(xy, edges);
      if (d.wheels && isRectangle(d.wheels, WHEEL_SQUARE_TOL_IN)) wheels = d;
    }
  }
  const bandsModel = setup.bands && !empty ? computeBands(modelParts, size.height) : null;
  const front: FrontDetection = empty ? { yaw: 0, confidence: 0, detected: false, cue: null } : detectFront(modelParts, wheels.wheels, size.height, yaw);
  return {
    oriented: {
      units,
      unitsDetected,
      up,
      upDetected: setup.up === 'auto',
      upMargin,
      yaw,
      sourceToModel,
      empty,
      trisIn,
      size,
      rawHull,
      wheels,
      front,
      bandsModel,
      folds,
    },
    modelParts,
  };
}

/**
 * THE LIGHT HALF: the hull cut to the setup's cap, the wheels in force (a manual override, else the
 * detected ones), the wheelbase centre, the bands shifted onto it, and the checks. Tens of
 * microseconds to a few milliseconds, whatever the model's size: this is what a wheel drag re-runs.
 * Reads `o` and never writes it, so one `OrientedMeasure` serves every later edit.
 */
export function finishMeasure(o: OrientedMeasure, setup: ImportSetup): ImportMeasurement {
  const { units, size, empty, rawHull, wheels, upMargin, front } = o;
  const checks: ImportCheck[] = [];
  const maxVerts = Math.max(3, Math.min(MAX_HULL_VERTS, Math.floor(setup.hullMaxVerts) || MAX_HULL_VERTS));
  const { hull, deviation } = rawHull.length >= 3 ? finishHull(rawHull, maxVerts) : { hull: [] as Vec2[], deviation: 0 };
  const manual = Array.isArray(setup.wheels) && setup.wheels.length === 4 && setup.wheels.every((w) => Number.isFinite(w?.x) && Number.isFinite(w?.y));
  // DETECTED wheels in a rectangle layout are lined up into one: always when the player picked
  // `rect`, and when the layout is not set yet only if they are nearly one already (otherwise the
  // editor opens them in `free`, as found). Placed wheels are never moved here. An exact rectangle
  // comes back bit for bit, so a robot detected square measures as it did.
  const det = wheels.wheels;
  const square = !manual && !!det && setup.wheelLayout !== 'free' && (setup.wheelLayout === 'rect' || isRectangle(det, WHEEL_SQUARE_TOL_IN));
  const squared = square && det ? squareWheels(det) : null;
  const moved = !!squared && !isRectangle(det!);
  const wheelsUsed = manual ? setup.wheels!.map((w) => ({ x: w.x, y: w.y })) : (squared ?? det);
  const wheelSource: ImportMeasurement['wheelSource'] = manual ? 'manual' : det ? 'detected' : 'none';
  // the note says so when the found wheels were moved; `o` itself is never written
  const wheelInfo: WheelDetection = moved ? { ...wheels, note: `${wheels.note} Lined them up as a rectangle.` } : wheels;
  const origin = wheelsUsed
    ? {
        x: q64(wheelsUsed.reduce((s, w) => s + w.x, 0) / 4),
        y: q64(wheelsUsed.reduce((s, w) => s + w.y, 0) / 4),
      }
    : { x: 0, y: 0 };
  const heightIn = size.height;
  let bands: ImportedBand[] | undefined;
  if (setup.bands && !empty) {
    const b = o.bandsModel;
    if (b) {
      bands = b.map((band) => ({
        z0: band.z0,
        z1: band.z1,
        hull: quantiseHull(band.hull.map((p) => ({ x: p.x - origin.x, y: p.y - origin.y }))),
        ...(band.cuts ? { cuts: band.cuts.map((c) => moveCut(c, origin)) } : {}),
      }));
    }
  }

  // ---- checks (copy: docs/area/ui.md — sentence case, Couldn’t … + a next step) ----
  if (empty) {
    checks.push({ code: 'empty', level: 'block', message: 'Couldn’t find any triangles in this file. Export the robot as a solid or mesh and try again.' });
  } else {
    const over = (['length', 'width', 'height'] as const).filter((d) => size[d] > ROBOT_MAX_IN + HULL_QUANTUM);
    if (over.length) {
      const worst = Math.max(size.length, size.width, size.height);
      checks.push({
        code: 'oversize',
        level: 'block',
        message: `The robot is ${fmtIn(size.length)} × ${fmtIn(size.width)} × ${fmtIn(size.height)} in; ${over.join(' and ')} ${over.length === 1 ? 'is' : 'are'} over 18 in. Check the units. A ramp or arm the file shows deployed can be marked under Mechanisms, Moving parts, and it is measured folded.`,
      });
      // a units hint when a different unit would make it robot-sized
      const alt = detectUnits(worst / INCHES_PER_UNIT[units], null).unit;
      if (alt !== units && (worst > 40 || worst < 4)) {
        checks.push({
          code: 'units-suspect',
          level: 'warn',
          message: `${fmtIn(worst)} in is not robot-sized. If the file is in ${UNIT_WORD[alt]}, set Units to ${alt}.`,
        });
      }
    } else if (Math.max(size.length, size.width, size.height) < 4) {
      const worst = Math.max(size.length, size.width, size.height);
      const alt = detectUnits(worst / INCHES_PER_UNIT[units], null).unit;
      checks.push({
        code: 'units-suspect',
        level: 'warn',
        message: `The robot is only ${fmtIn(worst)} in across.${alt !== units ? ` If the file is in ${UNIT_WORD[alt]}, set Units to ${alt}.` : ' Check the units.'}`,
      });
    }
    if (setup.up === 'auto' && upMargin < 0.15) {
      checks.push({ code: 'up-uncertain', level: 'info', message: 'Couldn’t be sure which way is up. Check that the robot stands on its wheels in the preview.' });
    }
    if (wheelSource === 'none') {
      const few = wheels.contacts.length;
      checks.push({
        code: few <= 1 ? 'no-floor' : 'few-wheels',
        level: 'warn',
        message: few <= 1 ? 'Only one part of the robot touches the floor. Check the up axis, or drag the wheel markers onto the wheels.' : wheels.note,
      });
    } else if (wheelSource === 'detected' && /corner ones/.test(wheels.note)) {
      checks.push({ code: 'wheels-picked', level: 'info', message: wheelInfo.note });
    }
    if (wheelsUsed && hull.length >= 3) {
      const off = wheelsUsed.filter((w) => insetDepth(w, hull) < -0.05).length;
      if (off) {
        checks.push({
          code: 'wheels-off-hull',
          level: 'block',
          message: `${off === 1 ? 'A wheel is' : `${off} wheels are`} outside the robot’s footprint. Drag ${off === 1 ? 'it' : 'them'} back onto the robot.`,
        });
      }
    }
    if (deviation > 0.25) {
      checks.push({
        code: 'hull-simplified',
        level: 'info',
        message: `The footprint outline is up to ${fmtIn(deviation)} in inside the model at its roundest corner.`,
      });
    }
  }

  return {
    units,
    unitsDetected: o.unitsDetected,
    up: o.up,
    upDetected: o.upDetected,
    upMargin,
    yaw: o.yaw,
    sourceToModel: o.sourceToModel,
    size,
    hull,
    hullRawVerts: rawHull.length,
    hullDeviation: deviation,
    wheels: wheelInfo,
    front,
    wheelsUsed,
    wheelSource,
    ...(moved ? { wheelsSquared: true as const } : {}),
    origin,
    heightIn,
    bands,
    trisIn: o.trisIn,
    checks,
  };
}

// ---- frames and the descriptor -------------------------------------------------------------

export const modelToRobot = (p: Vec2, origin: Vec2): Vec2 => ({ x: p.x - origin.x, y: p.y - origin.y });
export const robotToModel = (p: Vec2, origin: Vec2): Vec2 => ({ x: p.x + origin.x, y: p.y + origin.y });

/** shift mechanism placements from the MODEL frame to robot-local (spans along their edge) */
export function mechModelToRobot(mech: ImportedMech, origin: Vec2): ImportedMech {
  const out: ImportedMech = {};
  if (mech.shooter) out.shooter = { x: q64(mech.shooter.x - origin.x), y: q64(mech.shooter.y - origin.y), z: q64(mech.shooter.z) };
  // a direction: a shift of origin does not turn it
  if (mech.shooterYawDeg !== undefined) out.shooterYawDeg = mech.shooterYawDeg;
  if (mech.shooter2) out.shooter2 = { x: q64(mech.shooter2.x - origin.x), y: q64(mech.shooter2.y - origin.y), z: q64(mech.shooter2.z) };
  if (mech.place) out.place = { x: q64(mech.place.x - origin.x), y: q64(mech.place.y - origin.y), z: q64(mech.place.z) };
  if (mech.intakes) {
    out.intakes = mech.intakes.map((m) => {
      const lateral = m.edge === 'front' || m.edge === 'back' ? origin.y : origin.x;
      const a = q64(m.from - lateral);
      const b = q64(m.to - lateral);
      return { edge: m.edge as ImportedEdge, from: Math.min(a, b), to: Math.max(a, b) };
    });
  }
  return out;
}

/**
 * THE CONTRACT SHAPE (plan §3.1) from a measurement. Robot-local inches, quantised to 1/64,
 * hull re-hulled after the shift (so `coerceImported` finds it already canonical), wheels clamped
 * into the hull, heights clamped to (0, 18]. A footprint over 18 in is scaled uniformly about the
 * origin exactly as the coercer would; the `oversize` check is what tells the player.
 */
export function buildDescriptor(input: { id: string; measurement: ImportMeasurement; mech?: ImportedMech | null }): ImportedRobot {
  const m = input.measurement;
  const o = m.origin;
  let hull = quantiseHull(m.hull.map((p) => modelToRobot(p, o)));
  const b = bbox(hull);
  const span = Math.max(b.maxX - b.minX, b.maxY - b.minY);
  let scale = 1;
  if (span > ROBOT_MAX_IN) {
    scale = ROBOT_MAX_IN / span;
    hull = quantiseHull(hull.map((p) => ({ x: p.x * scale, y: p.y * scale })));
    // quantising can round a side back over by 1/64; shrink until it fits
    while (Math.max(bbox(hull).maxX - bbox(hull).minX, bbox(hull).maxY - bbox(hull).minY) > ROBOT_MAX_IN) {
      hull = quantiseHull(hull.map((p) => ({ x: p.x * (1 - 1 / 1024), y: p.y * (1 - 1 / 1024) })));
    }
  }
  const heightIn = Math.min(ROBOT_MAX_IN, Math.max(HULL_QUANTUM, q64(m.heightIn)));
  const out: ImportedRobot = { v: 1, id: input.id, hull, heightIn };
  if (m.wheelsUsed) {
    out.wheels = m.wheelsUsed.map((w) => {
      const r = modelToRobot(w, o);
      const c = clampIntoConvex({ x: r.x * scale, y: r.y * scale }, hull);
      return { x: q64(c.x), y: q64(c.y) };
    });
  }
  if (m.bands && m.bands.length) {
    out.bands = m.bands.map((band) => ({
      z0: Math.min(heightIn, q64(band.z0)),
      z1: Math.min(heightIn, q64(band.z1)),
      hull: scale === 1 ? band.hull.map((p) => ({ x: p.x, y: p.y })) : quantiseHull(band.hull.map((p) => ({ x: p.x * scale, y: p.y * scale }))),
      ...(band.cuts?.length ? { cuts: band.cuts.map((c) => moveCut(c, { x: 0, y: 0 }, scale)) } : {}),
    })).filter((band) => band.z1 > band.z0 && band.hull.length >= 3);
    if (!out.bands.length) delete out.bands;
  }
  if (input.mech) {
    const mech = mechModelToRobot(input.mech, o);
    if (mech.shooter || mech.shooter2 || mech.place || mech.intakes?.length) out.mech = mech;
  }
  return out;
}

// ---- the top image's frame: `./topFrame.ts` (a leaf, so the renderers read it without
// pulling this module into the main chunk) ----------------------------------------------------

export { robotToTopPixel, topImageFrame, topPixelToRobot, type TopImageFrame } from './topFrame';
