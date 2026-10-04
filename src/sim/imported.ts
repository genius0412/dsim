import type { ImportedBand, ImportedCut, ImportedEdge, ImportedMech, ImportedRobot, ImportTuning, Vec2 } from '../types';
import { WHEEL_INSET } from '../config';
import { clamp, hyp } from '../math';

/**
 * IMPORTED ROBOTS — the sanitiser and the polygon geometry every imported-robot branch shares
 * (`docs/robot-import-plan.md` §3.1, §4).
 *
 * A LEAF MODULE, on purpose: it imports only `types`, `config` and `math`. `spawn.ts` (the
 * `coerceSpec` chokepoint), `field.ts`, `physics.ts`, `physicsEngine.ts`, `artifactSolids.ts`
 * and the per-game copies all import it, and an import back into any of them would be a cycle
 * around the chokepoint.
 *
 * DETERMINISTIC: no trig at all (the hull is built from exact cross products of 1/64-in grid
 * points), no `Math.random`, no clock. Every coordinate this module stores is a multiple of
 * `IMPORT_QUANTUM`, and with coordinates bounded by `IMPORT_COORD_LIMIT` every product the hull
 * test takes is an exact double, so the hull of a stored hull is that hull, to the bit.
 *
 * Frame: robot-local inches, +x forward, +y left, origin at the wheelbase centre. Every polygon
 * this module returns is CONVEX and COUNTER-CLOCKWISE, starting at its lexicographically lowest
 * vertex (smallest x, then smallest y). The polygon helpers below assume that winding; the
 * standard rectangle from `robotHullLocal` (`field.ts`) is CCW too.
 */

/** the grid every stored coordinate sits on, inches */
export const IMPORT_QUANTUM = 1 / 64;
/** the largest bounding-box side, inches: the FTC starting cube (`ROBOT_MAX_SIZE`) */
export const IMPORT_MAX_EXTENT = 18;
export const IMPORT_MAX_HULL_VERTS = 16;
export const IMPORT_MAX_BAND_VERTS = 12;
/** 5 since 2026-10-04: a band of its own under an intake's overhang and one at a FLOWER's middle
 *  plate (`computeBands`); an older reader keeps the lowest 3 */
export const IMPORT_MAX_BANDS = 5;
export const IMPORT_MAX_INTAKES = 4;
/**
 * Input points read per polygon (the rest are ignored): bounds the work a hostile array costs.
 * The importer writes ≤ 16 hull and ≤ 12 band vertices, so 64 never cuts a real robot. It was 256,
 * and with 16 bands of 256 far-off points one 62 KB `update` cost 70 ms of the room's thread.
 */
export const IMPORT_MAX_INPUT_POINTS = 64;
/**
 * Bands whose POINTS are read (each one a polygon of up to `IMPORT_MAX_INPUT_POINTS`): twice the
 * bands kept, so a band dropped for a degenerate hull does not cost the ones after it, and a list
 * of 16 junk bands costs 6 polygons, not 16.
 */
export const IMPORT_MAX_BAND_INPUTS = 2 * IMPORT_MAX_BANDS;
/** a band's cuts kept (`ImportedBand.cuts`; the importer writes at most 2 an edge), read from the
 *  first twice as many */
export const IMPORT_MAX_BAND_CUTS = 8;
/** any input coordinate is clamped to ±this before anything else (keeps every product exact) */
export const IMPORT_COORD_LIMIT = 10000;
/**
 * SIM-SAFETY FLOORS, NOT RULES. A footprint narrower than this on either axis, or smaller in
 * area, is refused (the robot plays as its parametric fallback). The smallest standard chassis
 * is 10 in wide; these sit well under any real robot and exist so a degenerate sliver never
 * reaches the solver as a collider.
 */
export const IMPORT_MIN_SIDE = 6;
export const IMPORT_MIN_AREA = 24;
/**
 * How far inside the hull the origin (the wheelbase centre, which is also the centre of mass the
 * solver pins) must sit. A hull that does not contain its own origin by this much is recentred on
 * its area centroid; one too thin to contain it even then is refused.
 */
export const IMPORT_ORIGIN_MARGIN = 1;
export const IMPORT_MIN_HEIGHT = 1;
/**
 * The narrowest intake span kept, inches. A sim-safety floor like the two above: each game widens
 * a narrow mouth to its own minimum when it reads the span (`src/sim/importedMech.ts`).
 */
export const IMPORT_MIN_SPAN = 1;

const ID_RE = /^[0-9a-f]{16}$/;
const EDGES: readonly ImportedEdge[] = ['front', 'back', 'left', 'right'];

// ───────────────────────────────────────────────────────────── polygon geometry ──

export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** the axis-aligned bounds of a polygon in its own frame */
export function polyBounds(poly: readonly Vec2[]): Bounds {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, maxX, minY, maxY };
}

/** the bounds of `poly` after rotating it by the angle whose cosine/sine are `c`/`s` (about the
 * polygon's own origin) — the axis-aligned box a turned robot occupies, relative to its centre */
export function rotatedPolyBounds(poly: readonly Vec2[], c: number, s: number): Bounds {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    const x = p.x * c - p.y * s;
    const y = p.x * s + p.y * c;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY };
}

/**
 * A local polygon placed at a pose. `c`/`s` are the heading's `dcos`/`dsin`, taken by the caller
 * once; the arithmetic is `rot()`'s exactly, so a polygon placed here and one placed through
 * `rot()` agree to the bit.
 */
export function polyAtPose(poly: readonly Vec2[], pos: Vec2, c: number, s: number): Vec2[] {
  return poly.map((p) => ({ x: p.x * c - p.y * s + pos.x, y: p.x * s + p.y * c + pos.y }));
}

function cross(o: Vec2, a: Vec2, b: Vec2): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** signed area, positive for a CCW polygon (shoelace) */
export function polyArea(poly: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** the area centroid of a CCW polygon (always inside a convex one) */
export function polyCentroid(poly: readonly Vec2[]): Vec2 {
  let cx = 0;
  let cy = 0;
  let a2 = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const k = p.x * q.y - q.x * p.y;
    a2 += k;
    cx += (p.x + q.x) * k;
    cy += (p.y + q.y) * k;
  }
  if (Math.abs(a2) < 1e-12) return { x: 0, y: 0 };
  return { x: cx / (3 * a2), y: cy / (3 * a2) };
}

/**
 * The polar second moment of area of a CCW polygon about the ORIGIN, ∬(x² + y²) dA, in in⁴.
 * `m · J / A` is the rotational inertia of a uniform lamina of mass `m` in that shape about the
 * origin — which is where the solver pins an imported robot's centre of mass.
 */
export function polySecondMoment(poly: readonly Vec2[]): number {
  let ix = 0;
  let iy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const k = p.x * q.y - q.x * p.y;
    ix += k * (p.y * p.y + p.y * q.y + q.y * q.y);
    iy += k * (p.x * p.x + p.x * q.x + q.x * q.x);
  }
  return (ix + iy) / 12;
}

/**
 * The convex hull, by Andrew's monotone chain: CCW, no repeated and no collinear vertices,
 * starting at the lexicographically lowest point. Fewer than three points come back when the
 * input is degenerate (all coincident or collinear). Exact for 1/64-in grid points.
 */
export function convexHull(points: readonly Vec2[]): Vec2[] {
  const pts = points.map((p) => ({ x: p.x, y: p.y })).sort((a, b) => a.x - b.x || a.y - b.y);
  const u: Vec2[] = [];
  for (const p of pts) {
    const last = u[u.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) u.push(p);
  }
  if (u.length < 3) return u;
  const lower: Vec2[] = [];
  for (const p of u) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = u.length - 1; i >= 0; i--) {
    const p = u[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Cut a convex hull down to `max` vertices by repeatedly dropping the vertex whose removal loses
 * the least area (ties: the lowest index), then re-canonicalise. The result is a subset of the
 * input's vertices, so it is still convex, still on the grid, and inside the original — the
 * collider can only ever be a hair smaller than the shape, never bigger.
 */
export function reduceHull(hull: readonly Vec2[], max: number): Vec2[] {
  const p = hull.slice();
  while (p.length > max && p.length > 3) {
    const n = p.length;
    let best = 0;
    let bestA = Infinity;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(cross(p[(i - 1 + n) % n], p[i], p[(i + 1) % n]));
      if (a < bestA) {
        bestA = a;
        best = i;
      }
    }
    p.splice(best, 1);
  }
  return convexHull(p);
}

/**
 * The polygon's distinct edge directions as unit OUTWARD normals (CCW winding), each axis listed
 * once: an edge parallel to one already listed (a rectangle's far side) adds nothing to a
 * separating-axis test and would double-weight the corner blend in `physics.ts`.
 */
export function polyAxes(poly: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const l = hyp(ex, ey);
    if (l < 1e-9) continue;
    const n = { x: ey / l, y: -ex / l };
    if (out.some((m) => Math.abs(m.x * n.y - m.y * n.x) < 1e-12)) continue;
    out.push(n);
  }
  return out;
}

function project(poly: readonly Vec2[], ax: Vec2): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of poly) {
    const d = p.x * ax.x + p.y * ax.y;
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return [lo, hi];
}

/**
 * THE ONE SEPARATING-AXIS TEST every imported-robot contact routes through: over the unit edge
 * normals of both convex polygons (plus any `extra` unit axes), the LARGEST separation.
 *
 * `gap > 0` ⇒ disjoint, by at least that much along `n`; `gap <= 0` ⇒ overlapping, `-gap` being
 * the penetration depth along the least-overlapping axis. `n` points from `a` toward `b`. For two
 * convex polygons the edge normals are the complete axis set, so this is exact as an overlap test;
 * as a distance it is a lower bound (exact when the closest features include an edge), which is
 * what a "within slop" contact test wants.
 */
export function polySatGap(
  a: readonly Vec2[],
  b: readonly Vec2[],
  extra: readonly Vec2[] = [],
): { gap: number; nx: number; ny: number } {
  let best = -Infinity;
  let bx = 1;
  let by = 0;
  const axes = [...polyAxes(a), ...polyAxes(b), ...extra];
  for (const ax of axes) {
    const [a0, a1] = project(a, ax);
    const [b0, b1] = project(b, ax);
    // separation along +ax (b ahead of a) and along -ax (a ahead of b)
    const fwd = b0 - a1;
    const back = a0 - b1;
    if (fwd >= back) {
      if (fwd > best) {
        best = fwd;
        bx = ax.x;
        by = ax.y;
      }
    } else if (back > best) {
      best = back;
      bx = -ax.x;
      by = -ax.y;
    }
  }
  return { gap: best, nx: bx, ny: by };
}

/** do two convex polygons overlap (touching counts)? — `robotIntersectsRect`'s semantics */
export function polysOverlap(a: readonly Vec2[], b: readonly Vec2[]): boolean {
  for (const ax of [...polyAxes(a), ...polyAxes(b)]) {
    const [a0, a1] = project(a, ax);
    const [b0, b1] = project(b, ax);
    if (a1 < b0 || b1 < a0) return false;
  }
  return true;
}

function pointSegment(p: Vec2, a: Vec2, b: Vec2): { d: number; x: number; y: number; t: number } {
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const l2 = ex * ex + ey * ey;
  const t = l2 > 0 ? clamp(((p.x - a.x) * ex + (p.y - a.y) * ey) / l2, 0, 1) : 0;
  const x = a.x + ex * t;
  const y = a.y + ey * t;
  return { d: hyp(p.x - x, p.y - y), x, y, t };
}

/**
 * The Euclidean distance between two convex polygons, 0 when they overlap or touch. For two
 * disjoint convex polygons the closest pair always includes a VERTEX of one of them, so the
 * minimum over every vertex of each to every edge of the other is exact (`bbFootprintGap`'s
 * argument, unchanged).
 */
export function polyGap(a: readonly Vec2[], b: readonly Vec2[]): number {
  if (polysOverlap(a, b)) return 0;
  let best = Infinity;
  for (const [pts, poly] of [
    [a, b],
    [b, a],
  ] as const) {
    for (const p of pts) {
      for (let i = 0; i < poly.length; i++) {
        const d = pointSegment(p, poly[i], poly[(i + 1) % poly.length]).d;
        if (d < best) best = d;
      }
    }
  }
  return best;
}

export interface PolyFeature {
  /** the point is inside (or on) the polygon */
  inside: boolean;
  /** signed depth: + the distance in from the nearest edge, − the distance out to the polygon */
  depth: number;
  /** the closest point ON the boundary (inside: on the nearest edge's line) */
  cp: Vec2;
  /** unit outward normal of the nearest feature (outside: from the polygon toward the point) */
  nx: number;
  ny: number;
  /** outside, and nearest to a VERTEX rather than to the inside of an edge — a convex corner */
  vertex: boolean;
}

/** where a point sits against a CCW convex polygon: inside or out, how far, and off what */
export function polyFeature(poly: readonly Vec2[], p: Vec2): PolyFeature {
  const n = poly.length;
  let inside = true;
  let bestSd = -Infinity;
  let bnx = 1;
  let bny = 0;
  let bcx = p.x;
  let bcy = p.y;
  let near = Infinity;
  let qx = p.x;
  let qy = p.y;
  let qt = 0.5;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const el = hyp(ex, ey);
    if (el < 1e-9) continue;
    const onx = ey / el;
    const ony = -ex / el;
    const sd = (p.x - a.x) * onx + (p.y - a.y) * ony;
    if (sd > 0) inside = false;
    if (sd > bestSd) {
      bestSd = sd;
      bnx = onx;
      bny = ony;
      bcx = p.x - onx * sd;
      bcy = p.y - ony * sd;
    }
    const s = pointSegment(p, a, b);
    if (s.d < near) {
      near = s.d;
      qx = s.x;
      qy = s.y;
      qt = s.t;
    }
  }
  if (inside) return { inside, depth: -bestSd, cp: { x: bcx, y: bcy }, nx: bnx, ny: bny, vertex: false };
  if (near < 1e-12) return { inside: true, depth: 0, cp: { x: qx, y: qy }, nx: bnx, ny: bny, vertex: false };
  return {
    inside,
    depth: -near,
    cp: { x: qx, y: qy },
    nx: (p.x - qx) / near,
    ny: (p.y - qy) / near,
    vertex: qt <= 0 || qt >= 1,
  };
}

/** signed depth of a point in a CCW convex polygon: + inside, − outside (exact distance) */
export function polyPointDepth(poly: readonly Vec2[], p: Vec2): number {
  return polyFeature(poly, p).depth;
}

/**
 * The polygon GROWN by `pad` (> 0: the Minkowski sum with a ±pad square in the polygon's own
 * frame, which for a rectangle is exactly the rectangle grown by pad on every side) or SHRUNK by
 * `-pad` (< 0: every edge moved in by |pad|, i.e. the erosion; empty when nothing is left).
 * `evalStartPose`'s "touching" and "penetrating" tests, for an imported hull.
 */
export function polyGrow(poly: readonly Vec2[], pad: number): Vec2[] {
  if (pad === 0) return poly.map((p) => ({ x: p.x, y: p.y }));
  if (pad > 0) {
    const pts: Vec2[] = [];
    for (const p of poly) {
      pts.push({ x: p.x + pad, y: p.y + pad }, { x: p.x + pad, y: p.y - pad });
      pts.push({ x: p.x - pad, y: p.y + pad }, { x: p.x - pad, y: p.y - pad });
    }
    return convexHull(pts);
  }
  const inset = -pad;
  let out: Vec2[] = poly.map((p) => ({ x: p.x, y: p.y }));
  for (let i = 0; i < poly.length && out.length > 0; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const el = hyp(ex, ey);
    if (el < 1e-9) continue;
    const nx = ey / el;
    const ny = -ex / el;
    // keep the half-plane (p − a)·n <= −inset (Sutherland–Hodgman against one line)
    const f = (p: Vec2) => (p.x - a.x) * nx + (p.y - a.y) * ny + inset;
    const next: Vec2[] = [];
    for (let j = 0; j < out.length; j++) {
      const p = out[j];
      const q = out[(j + 1) % out.length];
      const fp = f(p);
      const fq = f(q);
      if (fp <= 0) next.push(p);
      if (fp * fq < 0) {
        const t = fp / (fp - fq);
        next.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
      }
    }
    out = next;
  }
  return out.length >= 3 ? out : [];
}

// ─────────────────────────────────────────────────────────── the robot readers ──

/**
 * An imported robot's footprint extents, `footprintExtents`' shape: the hull's bounding box, as
 * the distance ahead of the origin (`front`), behind it (`rear`) and the larger of the two flanks
 * (`half`, so the box stays symmetric left-right like every standard extents box). A BOUND for
 * callers that only need one — collision, contact and start legality read the hull itself.
 *
 * NO INTAKE REACH IS ADDED: the hull is the whole robot seen from above, intake included.
 */
export function importedExtents(imp: ImportedRobot): { front: number; rear: number; half: number } {
  const b = polyBounds(imp.hull);
  return { front: b.maxX, rear: -b.minX, half: Math.max(-b.minY, b.maxY) };
}

/** a candidate this far past an edge's line (either side) is classified without `polyFeature` */
const PULL_EPS = 1e-6;
/** how far snapping a candidate to the 1/64-in grid can move it along a unit normal (√2/128 ≈
 *  0.011), with room to spare: the margin a skipped candidate must clear */
const PULL_SNAP_MARGIN = 1 / 32;
const PULL_EXACT_MARGIN = 1e-4;

/**
 * Walk `p` toward the origin until it is inside `hull` (the origin is, by `IMPORT_ORIGIN_MARGIN`).
 * 1/64 of the way at a time (`k = 1 − j/64`, j = 0…64), optionally snapping each candidate to the
 * grid; deterministic, and a point already inside comes back unchanged.
 *
 * ⚠️ THE ANSWER IS THE 65-STEP WALK'S, BIT FOR BIT; ONLY ITS COST CHANGED. The walk called
 * `polyFeature` (two square roots per edge) on every candidate, up to 65 times, so a hostile band
 * list cost 70 ms per message. Now:
 *  1. The edges' unit normals and offsets are taken once, with `polyFeature`'s own arithmetic and
 *     its own skipped zero-length edges.
 *  2. The walk STARTS at the first candidate that could be inside. Candidate `k` is past edge i by
 *     `k·(p·nᵢ) − dᵢ`, give or take the snap, so every `k` above `min (dᵢ + margin)/(p·nᵢ)` is
 *     outside by more than snapping can undo: exactly a candidate the walk would have rejected.
 *  3. Each candidate is classified by its largest edge excess. Clearly out (> ε) or clearly in
 *     (< −ε) is `polyFeature`'s verdict without calling it; only a candidate within ε of an edge
 *     line goes to `polyPointDepth`, the walk's exact test.
 * Smoke pins the equivalence against the old walk over random hulls and points.
 */
export function pullInside(hull: readonly Vec2[], p: Vec2, snap: boolean): Vec2 {
  const n = hull.length;
  const nx: number[] = [];
  const ny: number[] = [];
  const d: number[] = [];
  let originClear = true;
  for (let i = 0; i < n; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % n];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const el = hyp(ex, ey);
    if (el < 1e-9) continue;
    const onx = ey / el;
    const ony = -ex / el;
    const di = a.x * onx + a.y * ony;
    nx.push(onx);
    ny.push(ony);
    d.push(di);
    if (!(di > 1e-3)) originClear = false;
  }
  let start = 0;
  if (originClear) {
    const m = snap ? PULL_SNAP_MARGIN : PULL_EXACT_MARGIN;
    let K = Infinity;
    for (let i = 0; i < d.length; i++) {
      const pn = p.x * nx[i] + p.y * ny[i];
      if (pn > 0) K = Math.min(K, (d[i] + m) / pn);
    }
    // one candidate earlier than the bound, so rounding in `64·(1 − K)` can only start it sooner
    if (K < 1) start = clamp(Math.floor(64 * (1 - K)) - 1, 0, 64);
  }
  for (let j = start; j <= 64; j++) {
    const k = 1 - j / 64;
    const c = snap ? { x: q(p.x * k), y: q(p.y * k) } : { x: p.x * k, y: p.y * k };
    let v = -Infinity;
    for (let i = 0; i < d.length; i++) {
      const e = c.x * nx[i] + c.y * ny[i] - d[i];
      if (e > v) v = e;
    }
    if (v > PULL_EPS) continue;
    if (v < -PULL_EPS || polyPointDepth(hull, c) >= 0) return c;
  }
  return { x: 0, y: 0 };
}

/** `importedWheels`' hull-derived default, per descriptor object (see there) */
const defaultWheels = new WeakMap<ImportedRobot, Vec2[]>();

/**
 * The four wheel contact points, FL, FR, BL, BR (the plan's order and `moduleAngles`'), robot
 * local. The stated ones when the import carries them; otherwise the STANDARD rectangle default —
 * corners of the hull's bounding box inset by `WHEEL_INSET` (floored at 1 in, as `wheelLocals`
 * does) — each walked inside the hull if the box corner is outside it (a pointed nose).
 *
 * ORDER: FL, FR, BL, BR, which is `WHEEL_CORNERS` (`config.ts`): `wheelLocals` returns these as they
 * are, and `wheelContacts` walks them in `WHEEL_PERIMETER` order.
 */
export function importedWheels(imp: ImportedRobot): Vec2[] {
  if (imp.wheels && imp.wheels.length === 4) return imp.wheels.map((w) => ({ x: w.x, y: w.y }));
  // the default is a pure function of the (immutable) descriptor and is read several times a
  // tick — `driveParams` alone is asked for it repeatedly — so it is computed once per object
  let w = defaultWheels.get(imp);
  if (!w) {
    const b = polyBounds(imp.hull);
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const ix = Math.max((b.maxX - b.minX) / 2 - WHEEL_INSET, 1);
    const iy = Math.max((b.maxY - b.minY) / 2 - WHEEL_INSET, 1);
    w = [
      { x: cx + ix, y: cy + iy },
      { x: cx + ix, y: cy - iy },
      { x: cx - ix, y: cy + iy },
      { x: cx - ix, y: cy - iy },
    ].map((p) => pullInside(imp.hull, p, false));
    defaultWheels.set(imp, w);
  }
  return w.map((p) => ({ x: p.x, y: p.y }));
}

/**
 * The half-diagonal `driveParams` turns at, for an imported robot, read off its WHEELBASE: the
 * mean wheel offset from the origin on each axis, grown back out by `WHEEL_INSET`. That is the
 * standard robot's own relation inverted (its wheels sit `WHEEL_INSET` inside a chassis whose
 * half-diagonal it turns at), so wheels exactly where a standard chassis would put them turn it
 * exactly as fast as that chassis, and a wider or longer wheelbase turns it slower.
 */
export function importedHalfDiag(imp: ImportedRobot): number {
  const w = importedWheels(imp);
  let ax = 0;
  let ay = 0;
  for (const p of w) {
    ax += Math.abs(p.x);
    ay += Math.abs(p.y);
  }
  return hyp(ax / w.length + WHEEL_INSET, ay / w.length + WHEEL_INSET);
}

/**
 * Rotational inertia of an imported robot of collider mass `m` about its origin (the centre of
 * mass the solver pins): a uniform lamina in the hull's shape, `m · J / A`. The polygon twin of
 * the standard robot's `m(L² + W²)/12`.
 */
export function importedInertia(m: number, imp: ImportedRobot): number {
  const a = polyArea(imp.hull);
  return a > 0 ? (m * polySecondMoment(imp.hull)) / a : 0;
}

// ─────────────────────────────────────────────────────────────── the sanitiser ──

/** snap to the grid; `+ 0` folds a −0 into 0 so a coerced value deep-equals its recoercion */
function q(v: number): number {
  return Math.round(v / IMPORT_QUANTUM) * IMPORT_QUANTUM + 0;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function readPoints(raw: unknown, cap: number): Vec2[] {
  if (!Array.isArray(raw)) return [];
  const out: Vec2[] = [];
  for (const it of raw.slice(0, cap)) {
    if (typeof it !== 'object' || it === null) continue;
    const x = num((it as Record<string, unknown>).x);
    const y = num((it as Record<string, unknown>).y);
    if (x === null || y === null) continue;
    out.push({ x: clamp(x, -IMPORT_COORD_LIMIT, IMPORT_COORD_LIMIT), y: clamp(y, -IMPORT_COORD_LIMIT, IMPORT_COORD_LIMIT) });
  }
  return out;
}

/** FL, FR, BL, BR from any order: the two furthest forward are the front pair, and in each pair
 * the one further left comes first. A function of the SET, so re-sorting a sorted list is a no-op. */
function sortWheels(w: Vec2[]): Vec2[] {
  const byX = w.slice().sort((a, b) => b.x - a.x || b.y - a.y);
  const pair = (p: Vec2[]) => p.sort((a, b) => b.y - a.y || b.x - a.x);
  const front = pair(byX.slice(0, 2));
  const rear = pair(byX.slice(2));
  return [front[0], front[1], rear[0], rear[1]];
}

interface Frame {
  /** the uniform scale applied (1 unless the bounding box was over the cube) */
  s: number;
  /** the translation applied after it (0 unless the hull was recentred) */
  tx: number;
  ty: number;
}

/** a raw (x, y) in the input frame → the coerced frame, on the grid */
function place(f: Frame, x: number, y: number): Vec2 {
  return { x: q(x * f.s) + f.tx, y: q(y * f.s) + f.ty };
}

/**
 * A band's cuts: a known edge and three finite numbers each, `from < to`, placed in the coerced
 * frame (the span on y for an end edge and x for a flank, `at` on the other axis) and snapped.
 * The first `IMPORT_MAX_BAND_CUTS` valid ones of the first twice as many, in input order. No range
 * beyond the coordinate limit: the game clamps a cut into the mouth it trims when it reads it.
 */
function readCuts(raw: unknown, f: Frame): ImportedCut[] {
  if (!Array.isArray(raw)) return [];
  const out: ImportedCut[] = [];
  const L = IMPORT_COORD_LIMIT;
  for (const it of raw.slice(0, 2 * IMPORT_MAX_BAND_CUTS)) {
    if (out.length >= IMPORT_MAX_BAND_CUTS) break;
    if (typeof it !== 'object' || it === null) continue;
    const r = it as Record<string, unknown>;
    const edge = r.edge as ImportedEdge;
    if (!EDGES.includes(edge)) continue;
    const a = num(r.from);
    const b = num(r.to);
    const at = num(r.at);
    if (a === null || b === null || at === null) continue;
    const end = edge === 'front' || edge === 'back';
    const span = (v: number): number => q(clamp(v, -L, L) * f.s) + (end ? f.ty : f.tx);
    const from = span(Math.min(a, b));
    const to = span(Math.max(a, b));
    if (!(to > from)) continue;
    out.push({ edge, from, to, at: q(clamp(at, -L, L) * f.s) + (end ? f.tx : f.ty) });
  }
  return out;
}

/**
 * A mechanism point, game-blind: x/y placed in the coerced frame and moved to the NEAREST point
 * inside the hull (every mechanism is part of the robot in its starting configuration — a REACH
 * point such as BIOBUZZ's Box Tube target is computed by the game from this base, never stored),
 * z snapped and clamped to `[0, heightIn]`. On the grid and inside, so a second pass keeps it.
 */
function coercePoint3(
  raw: unknown,
  f: Frame,
  hull: readonly Vec2[],
  heightIn: number,
): { x: number; y: number; z: number } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const x = num(r.x);
  const y = num(r.y);
  const z = num(r.z);
  if (x === null || y === null || z === null) return undefined;
  const L = IMPORT_COORD_LIMIT;
  let p = place(f, clamp(x, -L, L), clamp(y, -L, L));
  if (polyPointDepth(hull, p) < 0) {
    // the nearest boundary point, snapped — which can land a hair outside — then walked in
    const cp = polyFeature(hull, p).cp;
    p = pullInside(hull, { x: q(cp.x), y: q(cp.y) }, true);
  }
  return { x: p.x, y: p.y, z: clamp(q(clamp(z, -L, L) * f.s), 0, heightIn) };
}

/** whole degrees wrapped to (−180, 180]; −180 reads as 180, so a value has one spelling */
function wrapDeg180(d: number): number {
  const a = ((d % 360) + 360) % 360;
  return a > 180 ? a - 360 : a;
}

function coerceMech(raw: unknown, f: Frame, b: Bounds, hull: readonly Vec2[], heightIn: number): ImportedMech | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const m = raw as Record<string, unknown>;
  const out: ImportedMech = {};
  const shooter = coercePoint3(m.shooter, f, hull, heightIn);
  if (shooter) out.shooter = shooter;
  // a turretless launcher's FACING, kept only beside the point it fires from: whole degrees,
  // wrapped to (−180, 180] (a uniform scale and a recentring do not turn it)
  const yaw = num(m.shooterYawDeg);
  if (shooter && yaw !== null) out.shooterYawDeg = wrapDeg180(Math.round(clamp(yaw, -1e6, 1e6)));
  const shooter2 = coercePoint3(m.shooter2, f, hull, heightIn);
  if (shooter2) out.shooter2 = shooter2;
  if (Array.isArray(m.intakes)) {
    const list: NonNullable<ImportedMech['intakes']> = [];
    for (const it of m.intakes.slice(0, 16)) {
      if (list.length >= IMPORT_MAX_INTAKES) break;
      if (typeof it !== 'object' || it === null) continue;
      const r = it as Record<string, unknown>;
      const edge = r.edge as ImportedEdge;
      if (!EDGES.includes(edge)) continue;
      // ONE SPAN PER EDGE — the first valid one wins
      if (list.some((e) => e.edge === edge)) continue;
      const from = num(r.from);
      const to = num(r.to);
      if (from === null || to === null) continue;
      // the span runs ACROSS an end edge (y) and ALONG a flank (x)
      const lateral = edge === 'front' || edge === 'back';
      const off = lateral ? f.ty : f.tx;
      const lo = lateral ? b.minY : b.minX;
      const hi = lateral ? b.maxY : b.maxX;
      const L = IMPORT_COORD_LIMIT;
      let a = clamp(q(clamp(from, -L, L) * f.s) + off, lo, hi);
      let c = clamp(q(clamp(to, -L, L) * f.s) + off, lo, hi);
      if (a > c) [a, c] = [c, a];
      if (!(c - a >= IMPORT_MIN_SPAN)) continue;
      list.push({ edge, from: a, to: c });
    }
    // a function of the SET, so re-sorting a sorted list is a no-op
    list.sort((p, s) => EDGES.indexOf(p.edge) - EDGES.indexOf(s.edge));
    if (list.length > 0) out.intakes = list;
  }
  const place3 = coercePoint3(m.place, f, hull, heightIn);
  if (place3) out.place = place3;
  return out.shooter || out.shooter2 || out.intakes || out.place ? out : undefined;
}

/**
 * SANITISE AN IMPORTED-ROBOT DESCRIPTOR (`docs/robot-import-plan.md` §3.1) — untrusted input from
 * localStorage, an account blob, the wire or a replay — into a canonical one, or `undefined`
 * when nothing usable is left (the robot then plays as its parametric fallback).
 *
 * THE ORDER, and every step is a fold rather than a rejection unless it says otherwise:
 *   1. `v` must be 1 and `id` 16 lowercase hex characters, `heightIn` a finite number — else
 *      undefined (a future version or a garbage record is not something to guess at).
 *   2. HULL: the first `IMPORT_MAX_INPUT_POINTS` finite points, clamped to ±`IMPORT_COORD_LIMIT`,
 *      snapped to 1/64 in, convex-hulled (monotone chain, CCW), cut to 16 vertices by least area
 *      lost. Fewer than 3 vertices ⇒ undefined.
 *   3. SCALE: a bounding box over 18 in on either axis scales the WHOLE robot uniformly about
 *      the origin (x, y and z: a model imported in the wrong units is wrong in all three), to a
 *      hair under 18 so the re-snapped hull cannot round back over it.
 *   4. ORIGIN: the origin must sit `IMPORT_ORIGIN_MARGIN` inside the hull — it is the centre of
 *      mass the solver pins. Otherwise everything is translated so the hull's area centroid
 *      (snapped) is the origin; still not inside by the margin ⇒ undefined (a sliver).
 *   5. SIZE FLOORS: each bounding-box side ≥ `IMPORT_MIN_SIDE`, area ≥ `IMPORT_MIN_AREA`, else
 *      undefined.
 *   6. HEIGHT: snapped, clamped to [`IMPORT_MIN_HEIGHT`, 18].
 *   7. WHEELS: exactly four finite points, else dropped. Each is walked inside the hull if it is
 *      outside; a set with no spread (RMS radius under 1 in) is dropped; then sorted FL, FR, BL, BR.
 *   8. BANDS: up to 5 valid ones, in input order, then sorted by (z0, z1). z0/z1 snapped and
 *      clamped to [0, heightIn], z0 < z1 or the band is dropped; its points are walked inside the
 *      hull, hulled and cut to 12 vertices, < 3 ⇒ the band is dropped. Points are read for at most
 *      `IMPORT_MAX_BAND_INPUTS` bands (the work bound; a list that needs more is junk). Its cuts
 *      as `readCuts` says; none valid ⇒ no `cuts` field.
 *   9. MECH, game-blind: shooter / shooter2 / place snapped and moved to the nearest point INSIDE
 *      the hull, z into [0, heightIn]; `shooterYawDeg` whole degrees wrapped to (−180, 180], kept
 *      only beside a shooter; intakes need a known edge, the span clamped to that edge's
 *      side of the box, reordered so from < to, at least `IMPORT_MIN_SPAN` wide, ONE per edge (the
 *      first valid wins), sorted front, back, left, right. A mech with nothing left is dropped.
 *      Each game's own ranges are applied where it READS them (`importedMech.ts`).
 *
 * IDEMPOTENT: `coerceImported(coerceImported(x))` deep-equals `coerceImported(x)`. Every stored
 * number is on the grid and inside its range, the hull of a stored hull is itself, a stored
 * origin is inside by the margin, and every reorder is a function of the set — so the second
 * pass changes nothing. Smoke proves it over a hostile matrix.
 */
export function coerceImported(raw: unknown): ImportedRobot | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return undefined;
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return undefined;
  const h0 = num(r.heightIn);
  if (h0 === null) return undefined;

  // 2) the hull, on the grid
  let hull = reduceHull(convexHull(readPoints(r.hull, IMPORT_MAX_INPUT_POINTS).map((p) => ({ x: q(p.x), y: q(p.y) }))), IMPORT_MAX_HULL_VERTS);
  if (hull.length < 3) return undefined;

  // 3) uniform scale, if over the cube
  const f: Frame = { s: 1, tx: 0, ty: 0 };
  for (let pass = 0; pass < 8; pass++) {
    const b = polyBounds(hull);
    const ext = Math.max(b.maxX - b.minX, b.maxY - b.minY);
    if (ext <= IMPORT_MAX_EXTENT) break;
    const k = (IMPORT_MAX_EXTENT - IMPORT_QUANTUM) / ext;
    f.s *= k;
    hull = convexHull(hull.map((p) => ({ x: q(p.x * k), y: q(p.y * k) })));
    if (hull.length < 3) return undefined;
  }
  {
    const b = polyBounds(hull);
    if (Math.max(b.maxX - b.minX, b.maxY - b.minY) > IMPORT_MAX_EXTENT) return undefined;
  }

  // 4) the origin inside, by the margin
  const O = { x: 0, y: 0 };
  if (polyPointDepth(hull, O) < IMPORT_ORIGIN_MARGIN) {
    const c = polyCentroid(hull);
    f.tx = 0 - q(c.x);
    f.ty = 0 - q(c.y);
    hull = convexHull(hull.map((p) => ({ x: p.x + f.tx + 0, y: p.y + f.ty + 0 })));
    if (hull.length < 3 || polyPointDepth(hull, O) < IMPORT_ORIGIN_MARGIN) return undefined;
  }

  // 5) the sim-safety floors
  const bb = polyBounds(hull);
  if (bb.maxX - bb.minX < IMPORT_MIN_SIDE || bb.maxY - bb.minY < IMPORT_MIN_SIDE) return undefined;
  if (polyArea(hull) < IMPORT_MIN_AREA) return undefined;

  // 6) height
  const heightIn = clamp(q(clamp(h0, -IMPORT_COORD_LIMIT, IMPORT_COORD_LIMIT) * f.s), IMPORT_MIN_HEIGHT, IMPORT_MAX_EXTENT);

  const out: ImportedRobot = { v: 1, id: r.id, hull, heightIn };

  // 7) wheels
  if (Array.isArray(r.wheels) && r.wheels.length === 4) {
    const w = readPoints(r.wheels, 4);
    if (w.length === 4) {
      const placed = w.map((p) => pullInside(hull, place(f, p.x, p.y), true));
      const spread = placed.reduce((a, p) => a + p.x * p.x + p.y * p.y, 0) / 4;
      if (spread >= 1) out.wheels = sortWheels(placed);
    }
  }

  // 8) bands
  if (Array.isArray(r.bands)) {
    const list: ImportedBand[] = [];
    let read = 0;
    for (const raw of r.bands.slice(0, 16)) {
      if (list.length >= IMPORT_MAX_BANDS || read >= IMPORT_MAX_BAND_INPUTS) break;
      if (typeof raw !== 'object' || raw === null) continue;
      const br = raw as Record<string, unknown>;
      const z0r = num(br.z0);
      const z1r = num(br.z1);
      if (z0r === null || z1r === null) continue;
      const L = IMPORT_COORD_LIMIT;
      const z0 = clamp(q(clamp(z0r, -L, L) * f.s), 0, heightIn);
      const z1 = clamp(q(clamp(z1r, -L, L) * f.s), 0, heightIn);
      if (!(z1 > z0)) continue;
      read++;
      const pts = readPoints(br.hull, IMPORT_MAX_INPUT_POINTS).map((p) => pullInside(hull, place(f, p.x, p.y), true));
      const bh = reduceHull(convexHull(pts), IMPORT_MAX_BAND_VERTS);
      if (bh.length < 3) continue;
      const cuts = readCuts(br.cuts, f);
      list.push(cuts.length > 0 ? { z0, z1, hull: bh, cuts } : { z0, z1, hull: bh });
    }
    list.sort((a, b) => a.z0 - b.z0 || a.z1 - b.z1);
    if (list.length > 0) out.bands = list;
  }

  // 9) mechanisms
  const mech = coerceMech(r.mech, f, bb, hull, heightIn);
  if (mech) out.mech = mech;

  // 10) practice tuning
  const tune = coerceTune(r.tune);
  if (tune) out.tune = tune;
  return out;
}

/** each practice-tuning field's range and step (`ImportTuning`), game-blind: a game reads only the
 *  ones its robot has */
export const IMPORT_TUNE: Readonly<Record<keyof ImportTuning, { min: number; max: number; step: number }>> = {
  topSpeed: { min: 20, max: 130, step: 0.5 },
  accel: { min: 60, max: 1500, step: 5 },
  turnRate: { min: 60, max: 685, step: 5 },
  aimTurn: { min: 30, max: 685, step: 5 },
  shotInterval: { min: 0.03, max: 2, step: 0.01 },
  spinUp: { min: 500, max: 20000, step: 100 },
  intakeTime: { min: 0.25, max: 4, step: 0.05 },
  reload: { min: 0.1, max: 3, step: 0.05 },
  turretSlew: { min: 60, max: 1145, step: 5 },
  rampDeployS: { min: 0.05, max: 1.5, step: 0.05 },
};

/** `raw` as practice tuning: each known field clamped and put on its step (so coercing twice is
 *  coercing once), unknown ones dropped; undefined when nothing is left */
export function coerceTune(raw: unknown): ImportTuning | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: ImportTuning = {};
  let any = false;
  for (const k of Object.keys(IMPORT_TUNE) as (keyof ImportTuning)[]) {
    const v = num(r[k]);
    if (v === null) continue;
    const L = IMPORT_TUNE[k];
    out[k] = Number(clamp(Math.round(clamp(v, L.min, L.max) / L.step) * L.step, L.min, L.max).toFixed(4));
    any = true;
  }
  return any ? out : undefined;
}
