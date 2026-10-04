/**
 * MOVING PARTS — the geometry behind the importer's moving parts (`docs/area/robot-import.md`,
 * "Moving parts"). DOM-free and three-free: the measurement (`geometry.ts`, in the measure worker
 * too), the editor and the tests all run it.
 *
 * A moving part is a set of CAD BODIES (`MeshPart.body`) with a role. This file turns those bodies
 * into an axis and a pivot (a spinning part's axle, a turret's vertical, a ramp's hinge), finds the
 * drive wheels from the floor contacts, grows a click on one body into everything on its axle, and
 * FOLDS a ramp the file shows deployed, so the footprint that is measured is the starting one.
 */
import type { DrivetrainType, Vec2 } from '../types';
import type { MeshPart } from './geometry';
import { DEFAULT_DEPLOY_DEG, HINGE_ROLES, JOINT_DEFAULT_AMOUNT, JOINT_ROLES, SPIN_ROLES, type MotionGroup, type MotionPart, type MotionRole } from './types';

type V3 = [number, number, number];

const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/**
 * The finders' version (`ImportSetup.motionFinder`). Raise it with any change to what they find, so a
 * draft found by the old ones is looked for again. 1: STEP body ids kept, motors off axles, 6WD
 * middle wheels, the build read from the model (2026-10-04). 2: surgical-tubing spokes and staged
 * spoked rollers, what a wheel's shaft carries, gears meshed with a wheel's, a wheel's axle along x
 * (2026-10-04, Offset Robotics' concept robot). 3: a flywheel's thickness read along its own axle, a turret
 * ring reaching its launcher, box tubes (2026-10-04).
 */
export const MOTION_FINDER = 3;

export const isSpin = (r: MotionRole): boolean => SPIN_ROLES.includes(r);
export const isHinge = (r: MotionRole): boolean => HINGE_ROLES.includes(r);
export const isJoint = (r: MotionRole): boolean => JOINT_ROLES.includes(r);

// ---- per-body statistics ------------------------------------------------------------------------

/**
 * Sums over every vertex of every body: count, the coordinate sums, the box and the second moments,
 * indexed by body id. One pass over the parts; what every fit and every "which bodies are near here"
 * question reads before it looks at a single vertex.
 */
export interface BodyStats {
  /** ids that have at least one vertex, ascending */
  ids: number[];
  n: Float64Array;
  /** x, y, z sums */
  s: Float64Array;
  /** xx, xy, xz, yy, yz, zz sums */
  q: Float64Array;
  min: Float64Array;
  max: Float64Array;
  /**
   * WHERE EACH BODY'S VERTICES ARE: runs of consecutive vertices of one body in one part, numbered in
   * the model's own order (part, then vertex). Body b's runs are `runIdx[runStart[b] .. runStart[b+1])`.
   * A question about a few bodies reads only their vertices, not the whole model: on a 7 M-triangle
   * robot a pass over every vertex is ~40 ms, and the roller search asks dozens of them.
   */
  runStart: Uint32Array;
  runIdx: Uint32Array;
  runPart: Uint32Array;
  runFrom: Uint32Array;
  runTo: Uint32Array;
}

const statsCache = new WeakMap<readonly MeshPart[], BodyStats>();

/** the per-body statistics of `parts` (memoised on the array) */
export function bodyStats(parts: readonly MeshPart[]): BodyStats {
  const hit = statsCache.get(parts);
  if (hit) return hit;
  let top = -1;
  for (const p of parts) if (p.body) for (let i = 0; i < p.body.length; i++) if (p.body[i] > top) top = p.body[i];
  const N = top + 1;
  const n = new Float64Array(N);
  const s = new Float64Array(3 * N);
  const q = new Float64Array(6 * N);
  const min = new Float64Array(3 * N).fill(Infinity);
  const max = new Float64Array(3 * N).fill(-Infinity);
  for (const p of parts) {
    if (!p.body) continue;
    const a = p.positions;
    for (let v = 0; v < p.body.length; v++) {
      const b = p.body[v];
      const x = a[3 * v];
      const y = a[3 * v + 1];
      const z = a[3 * v + 2];
      n[b]++;
      s[3 * b] += x;
      s[3 * b + 1] += y;
      s[3 * b + 2] += z;
      q[6 * b] += x * x;
      q[6 * b + 1] += x * y;
      q[6 * b + 2] += x * z;
      q[6 * b + 3] += y * y;
      q[6 * b + 4] += y * z;
      q[6 * b + 5] += z * z;
      if (x < min[3 * b]) min[3 * b] = x;
      if (y < min[3 * b + 1]) min[3 * b + 1] = y;
      if (z < min[3 * b + 2]) min[3 * b + 2] = z;
      if (x > max[3 * b]) max[3 * b] = x;
      if (y > max[3 * b + 1]) max[3 * b + 1] = y;
      if (z > max[3 * b + 2]) max[3 * b + 2] = z;
    }
  }
  const ids: number[] = [];
  for (let b = 0; b < N; b++) if (n[b] > 0) ids.push(b);
  // the runs: counted, then laid out per body (counting sort), each body's in the model's order
  let runs = 0;
  for (const p of parts) if (p.body) for (let v = 0; v < p.body.length; v++) if (v === 0 || p.body[v] !== p.body[v - 1]) runs++;
  const runPart = new Uint32Array(runs);
  const runFrom = new Uint32Array(runs);
  const runTo = new Uint32Array(runs);
  const perBody = new Uint32Array(N + 1);
  let r = -1;
  parts.forEach((p, pi) => {
    if (!p.body) return;
    for (let v = 0; v < p.body.length; v++) {
      if (v === 0 || p.body[v] !== p.body[v - 1]) {
        r++;
        runPart[r] = pi;
        runFrom[r] = v;
        perBody[p.body[v] + 1]++;
      }
      runTo[r] = v + 1;
    }
  });
  for (let b = 0; b < N; b++) perBody[b + 1] += perBody[b];
  const runIdx = new Uint32Array(runs);
  const fill = perBody.slice(0, N);
  for (let k = 0; k < runs; k++) {
    const b = parts[runPart[k]].body![runFrom[k]];
    runIdx[fill[b]++] = k;
  }
  const out = { ids, n, s, q, min, max, runStart: perBody, runIdx, runPart, runFrom, runTo };
  statsCache.set(parts, out);
  return out;
}

/** a set of bodies' summed statistics: count, centroid, covariance (xx xy xz yy yz zz), box */
/** the centre of a set's box: unlike the vertex mean, it does not lean toward where the mesh is dense
 *  (a fanned cap puts half a cylinder's vertices on one point of its rim) */
const boxCentre = (mo: { min: V3; max: V3 }): V3 => [(mo.min[0] + mo.max[0]) / 2, (mo.min[1] + mo.max[1]) / 2, (mo.min[2] + mo.max[2]) / 2];

function setMoments(st: BodyStats, bodies: Iterable<number>): { n: number; c: V3; cov: number[]; min: V3; max: V3 } {
  let n = 0;
  const S = [0, 0, 0];
  const Q = [0, 0, 0, 0, 0, 0];
  const mn: V3 = [Infinity, Infinity, Infinity];
  const mx: V3 = [-Infinity, -Infinity, -Infinity];
  for (const b of bodies) {
    if (b >= st.n.length || !st.n[b]) continue;
    n += st.n[b];
    for (let k = 0; k < 3; k++) {
      S[k] += st.s[3 * b + k];
      mn[k] = Math.min(mn[k], st.min[3 * b + k]);
      mx[k] = Math.max(mx[k], st.max[3 * b + k]);
    }
    for (let k = 0; k < 6; k++) Q[k] += st.q[6 * b + k];
  }
  if (!n) return { n: 0, c: [0, 0, 0], cov: [0, 0, 0, 0, 0, 0], min: [0, 0, 0], max: [0, 0, 0] };
  const c: V3 = [S[0] / n, S[1] / n, S[2] / n];
  const cov = [
    Q[0] / n - c[0] * c[0],
    Q[1] / n - c[0] * c[1],
    Q[2] / n - c[0] * c[2],
    Q[3] / n - c[1] * c[1],
    Q[4] / n - c[1] * c[2],
    Q[5] / n - c[2] * c[2],
  ];
  return { n, c, cov, min: mn, max: mx };
}

/** eigen-decomposition of a symmetric 3×3 (xx xy xz yy yz zz), Jacobi; values descending */
export function eigenSym3(m: readonly number[]): { values: V3; vectors: [V3, V3, V3] } {
  const a = [
    [m[0], m[1], m[2]],
    [m[1], m[3], m[4]],
    [m[2], m[4], m[5]],
  ];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 32; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-14 * (Math.abs(a[0][0]) + Math.abs(a[1][1]) + Math.abs(a[2][2]) + 1e-30)) break;
    for (const [p, r] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      if (Math.abs(a[p][r]) < 1e-300) continue;
      const theta = (a[r][r] - a[p][p]) / (2 * a[p][r]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p];
        const akr = a[k][r];
        a[k][p] = c * akp - s * akr;
        a[k][r] = s * akp + c * akr;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k];
        const ark = a[r][k];
        a[p][k] = c * apk - s * ark;
        a[r][k] = s * apk + c * ark;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p];
        const vkr = v[k][r];
        v[k][p] = c * vkp - s * vkr;
        v[k][r] = s * vkp + c * vkr;
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[j][j] - a[i][i]);
  return {
    values: order.map((i) => a[i][i]) as V3,
    vectors: order.map((i) => norm([v[0][i], v[1][i], v[2][i]])) as [V3, V3, V3],
  };
}

/** snap a direction to the nearest model axis when it is within `deg` of one */
export function snapAxis(a: V3, deg = 10): V3 {
  const cos = Math.cos((deg * Math.PI) / 180);
  for (let k = 0; k < 3; k++) {
    if (Math.abs(a[k]) >= cos) {
      const out: V3 = [0, 0, 0];
      out[k] = Math.sign(a[k]);
      return out;
    }
  }
  return a;
}

/**
 * THE AXLE OF A ROUND PART from its second moments: a part turned about an axis spreads EQUALLY in
 * the two directions across it, so the axis is the principal direction whose spread differs from
 * the other two — the LONGEST for a roller (a long thin cylinder), the SHORTEST for a wheel or a
 * flywheel (a disc). Snapped to a model axis within 10°, since a robot is built square.
 */
export function roundAxis(cov: readonly number[]): V3 {
  const { values, vectors } = eigenSym3(cov);
  const a = values[0] - values[1] > values[1] - values[2] ? vectors[0] : vectors[2];
  return snapAxis(a);
}

/**
 * THE AXIS A PART IS ROUNDEST ABOUT, of its moments' axle (`roundAxis`) and the three model axes: as
 * wide one way across it as the other, with no corner past that width. The moments alone mislead on a
 * part with fins or a dense patch of mesh (2026-10-04: every full-resolution 48 mm Gecko wheel of
 * goBILDA's BIOBUZZ intake came out turning about a near-vertical axis). The moments' axle wins a tie.
 */
function roundestAxis(parts: readonly MeshPart[], bodies: readonly number[], cov: readonly number[]): V3 {
  const first = roundAxis(cov);
  const cands: V3[] = [first];
  for (const a of [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ] as V3[]) {
    if (Math.abs(dot(a, first)) < 0.999) cands.push(a);
  }
  const frames = cands.map((axis) => {
    const e1 = norm(Math.abs(axis[2]) < 0.9 ? cross(axis, [0, 0, 1]) : cross(axis, [1, 0, 0]));
    return { e1, e2: cross(axis, e1), lo: [Infinity, Infinity], hi: [-Infinity, -Infinity], r: 0 };
  });
  const set = new Set(bodies);
  eachVertex(parts, set, (x, y, z) => {
    for (const f of frames) {
      const u = x * f.e1[0] + y * f.e1[1] + z * f.e1[2];
      const v = x * f.e2[0] + y * f.e2[1] + z * f.e2[2];
      if (u < f.lo[0]) f.lo[0] = u;
      if (u > f.hi[0]) f.hi[0] = u;
      if (v < f.lo[1]) f.lo[1] = v;
      if (v > f.hi[1]) f.hi[1] = v;
    }
  });
  eachVertex(parts, set, (x, y, z) => {
    for (const f of frames) {
      const u = x * f.e1[0] + y * f.e1[1] + z * f.e1[2] - (f.lo[0] + f.hi[0]) / 2;
      const v = x * f.e2[0] + y * f.e2[1] + z * f.e2[2] - (f.lo[1] + f.hi[1]) / 2;
      const r = u * u + v * v;
      if (r > f.r) f.r = r;
    }
  });
  const score = frames.map((f) => {
    const w1 = (f.hi[0] - f.lo[0]) / 2;
    const w2 = (f.hi[1] - f.lo[1]) / 2;
    const w = Math.max(w1, w2, 1e-9);
    return Math.abs(w1 - w2) / w + Math.max(0, Math.sqrt(f.r) / w - 1);
  });
  let best = 0;
  for (let k = 1; k < cands.length; k++) if (score[k] < score[best] - 0.02) best = k;
  // ...but a model axis within 20° of the moments' axle that the part is about as round about (0.03)
  // is the axle: a robot is built square, and a gear's teeth or a set screw lean its moments
  // (goBILDA's 6WD drive gears fit 12° off their shaft, and a click on one took a chain and a gearbox)
  if (best === 0) {
    for (let k = 1; k < cands.length; k++) if (Math.abs(dot(cands[k], first)) >= SQUARE_COS && score[k] <= score[0] + 0.03) return cands[k];
  }
  return cands[best];
}

/** within 20° of a model axis (`roundestAxis`) */
const SQUARE_COS = Math.cos((20 * Math.PI) / 180);

/**
 * visit every vertex of the bodies in `set`: (x, y, z, body), in the model's own order (part, then
 * vertex), reading only those bodies' runs (`BodyStats.runIdx`)
 */
function eachVertex(parts: readonly MeshPart[], set: ReadonlySet<number>, f: (x: number, y: number, z: number, b: number) => void): void {
  if (!set.size) return;
  const st = bodyStats(parts);
  const runs: number[] = [];
  for (const b of set) if (b < st.n.length) for (let k = st.runStart[b]; k < st.runStart[b + 1]; k++) runs.push(st.runIdx[k]);
  // runs are numbered in the model's order, so sorted they visit the vertices as a full pass would
  runs.sort((x, y) => x - y);
  for (const k of runs) {
    const p = parts[st.runPart[k]];
    const a = p.positions;
    const body = p.body!;
    for (let v = st.runFrom[k]; v < st.runTo[k]; v++) f(a[3 * v], a[3 * v + 1], a[3 * v + 2], body[v]);
  }
}

/** a round part's axle: its direction, the point on it mid-way along the part, and its radius */
export function fitRound(parts: readonly MeshPart[], bodies: readonly number[], axisHint?: V3): { axis: V3; pivot: V3; radius: number } | null {
  const st = bodyStats(parts);
  const mo = setMoments(st, bodies);
  if (mo.n < 3) return null;
  const axis = axisHint ?? roundestAxis(parts, bodies, mo.cov);
  // the centre: mid-way along the axis, and across it the middle of the box the part spans in the
  // two directions square to the axis (the centroid of a lopsided hub is off its own axle)
  const e1 = norm(Math.abs(axis[2]) < 0.9 ? cross(axis, [0, 0, 1]) : cross(axis, [1, 0, 0]));
  const e2 = cross(axis, e1);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const set = new Set(bodies);
  eachVertex(parts, set, (x, y, z) => {
    const p: V3 = [x, y, z];
    const d = [dot(p, axis), dot(p, e1), dot(p, e2)];
    for (let k = 0; k < 3; k++) {
      if (d[k] < lo[k]) lo[k] = d[k];
      if (d[k] > hi[k]) hi[k] = d[k];
    }
  });
  const mid = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const pivot = add(add(scale(axis, mid[0]), scale(e1, mid[1])), scale(e2, mid[2]));
  let radius = 0;
  eachVertex(parts, set, (x, y, z) => {
    const r = sub([x, y, z], pivot);
    const along = dot(r, axis);
    const rr = Math.hypot(r[0] - axis[0] * along, r[1] - axis[1] * along, r[2] - axis[2] * along);
    if (rr > radius) radius = rr;
  });
  return { axis, pivot, radius };
}

// ---- picking: a click on one body → everything on its axle ---------------------------------------

/** how far a body's centre may sit off the seed's axle and still be on it, inches */
const COAXIAL_TOL_IN = 0.4;
/** a roller's or flywheel's axle carries nothing wider than this from its line, inches */
const AXLE_RADIUS_IN = 3.25;
/** the parts on one shaft follow each other along it: one more than this past the rest is on another
 *  shaft that only shares the line (the far side of the robot), inches */
const AXLE_GAP_IN = 0.4;
/** a SHAFT: on the axle and no wider than this from its line, inches (a 1/2-in hex is 0.29) */
const SHAFT_R_IN = 0.35;
/** a wheel's shaft is at most this long, inches */
const SHAFT_MAX_IN = 10;

/**
 * The bodies that turn WITH `seed` (a click while picking a spinning part), read off the biggest round
 * part on its line or around it (`leadOnAxle`). A WHEEL is what turns with it in its own cylinder
 * (`wheelBodies`; the other side's wheel is often on the same line); a roller or a flywheel takes its
 * shaft and everything on it (`spinAxle`), never the motor that drives it. The clicked body is always
 * in it, but for a click on a motor's own part, which takes that part alone.
 */
export function coaxialBodies(parts: readonly MeshPart[], seed: number, role: MotionRole): number[] {
  const st = bodyStats(parts);
  // a click on a SPOKE is read off its star's axle
  if (role !== 'wheel') {
    const star = starAxle(parts, seed);
    const hub = star ? bodyOnLine(st, star.pivot, star.axis, new Set()) : -1;
    if (star && hub >= 0) {
      const g = spinAxle(parts, hub, star);
      if (!g.motor) return [...new Set([...g.bodies, seed])].sort((a, b) => a - b);
    }
  }
  const fit = fitRound(parts, [seed]);
  if (!fit) return [seed];
  // a click on a small part of it (its shaft, its hub, a screw) is read off the biggest round part on
  // that part's line: from the shaft alone, the gearbox it runs into looked attached (measured)
  const lead = leadOnAxle(parts, st, seed, fit);
  const lf = lead === seed ? fit : (fitRound(parts, [lead]) ?? fit);
  if (role === 'wheel') {
    // a gear, sprocket or pulley the wheel's shaft carries is read off the wheel itself; its radius is
    // read off the part, so the measured slack (a catalogue wheel's took the frame screws beside Offset
    // Robotics' mecanum wheels, 0.1 in past their rollers)
    const wf = wheelOnLine(parts, st, seed, lf) ?? wheelAround(parts, st, seed) ?? lf;
    const keep = new Set(wheelBodies(parts, st, wf.pivot, wf.axis, wf.radius, new Set(), WHEEL_SLACK_IN.measured));
    keep.add(seed);
    return [...keep].sort((a, b) => a - b);
  }
  const g = spinAxle(parts, seed);
  // a click on the motor itself takes that one part: the player asked for it
  if (g.motor) return [seed];
  if (lead === seed) return g.bodies;
  const h = spinAxle(parts, lead);
  return h.motor ? g.bodies : [...new Set([...h.bodies, seed])].sort((a, b) => a - b);
}

/**
 * The WHEEL on `fit`'s line, for a click on something its shaft carries: the biggest part round about
 * that line that stands on the floor (within 0.35 in of it), within `SHAFT_CARRY_IN` and
 * `LEAD_REACH_IN` of the clicked part along it. Only on a level line, and only bigger than what was
 * clicked: a motor on the line never stands on the floor. Null when there is none.
 */
function wheelOnLine(parts: readonly MeshPart[], st: BodyStats, seed: number, fit: { axis: V3; pivot: V3; radius: number }): { axis: V3; pivot: V3; radius: number } | null {
  const { axis, pivot } = fit;
  if (Math.abs(axis[2]) > 0.2) return null;
  const lo = dot(sub([st.min[3 * seed], st.min[3 * seed + 1], st.min[3 * seed + 2]], pivot), axis);
  const hi = dot(sub([st.max[3 * seed], st.max[3 * seed + 1], st.max[3 * seed + 2]], pivot), axis);
  const reach = Math.max(Math.abs(lo), Math.abs(hi)) + LEAD_REACH_IN + SHAFT_CARRY_IN;
  let best: { axis: V3; pivot: V3; radius: number } | null = null;
  for (const b of st.ids) {
    if (st.min[3 * b + 2] > 0.35) continue;
    const d = sub([(st.min[3 * b] + st.max[3 * b]) / 2, (st.min[3 * b + 1] + st.max[3 * b + 1]) / 2, (st.min[3 * b + 2] + st.max[3 * b + 2]) / 2], pivot);
    const al = dot(d, axis);
    if (Math.abs(al) > reach || Math.hypot(d[0] - axis[0] * al, d[1] - axis[1] * al, d[2] - axis[2] * al) > COAXIAL_TOL_IN) continue;
    const f = axleFits(parts, st, new Set([b]), pivot, axis).get(b)!;
    if (f.rMax <= Math.max(fit.radius, best?.radius ?? 0) || !roundAboutAxle(f)) continue;
    best = { axis, pivot: add(pivot, scale(axis, (f.lo + f.hi) / 2)), radius: f.rMax };
  }
  return best;
}

/**
 * The WHEEL a clicked part lies in when it is on no wheel's line (a mecanum's roller, its pin: their
 * own axles lean 45°): the biggest part standing on the floor, round about a level model axis, whose
 * cylinder (its radius and 0.2 in, its span along the axle) holds the clicked part's centre. On
 * Offset Robotics' mecanum wheels a roller's own line ran into the odometry pod beside the wheel.
 */
function wheelAround(parts: readonly MeshPart[], st: BodyStats, seed: number): { axis: V3; pivot: V3; radius: number } | null {
  const c: V3 = [(st.min[3 * seed] + st.max[3 * seed]) / 2, (st.min[3 * seed + 1] + st.max[3 * seed + 1]) / 2, (st.min[3 * seed + 2] + st.max[3 * seed + 2]) / 2];
  let best: { axis: V3; pivot: V3; radius: number } | null = null;
  for (const b of st.ids) {
    if (st.min[3 * b + 2] > 0.35) continue;
    const h = st.max[3 * b + 2] - st.min[3 * b + 2];
    const bc: V3 = [(st.min[3 * b] + st.max[3 * b]) / 2, (st.min[3 * b + 1] + st.max[3 * b + 1]) / 2, (st.min[3 * b + 2] + st.max[3 * b + 2]) / 2];
    if (h < 1 || Math.hypot(c[0] - bc[0], c[1] - bc[1], c[2] - bc[2]) > h / 2 + 0.5) continue;
    for (const axis of [
      [0, 1, 0],
      [1, 0, 0],
    ] as V3[]) {
      const f = axleFits(parts, st, new Set([b]), bc, axis).get(b)!;
      if (!roundAboutAxle(f) || f.rMax < 0.4 * h || (best && f.rMax <= best.radius)) continue;
      const d = sub(c, bc);
      const al = dot(d, axis);
      if (al < f.lo - WHEEL_HALF_WIDTH_IN || al > f.hi + WHEEL_HALF_WIDTH_IN || Math.hypot(d[0] - axis[0] * al, d[1] - axis[1] * al, d[2] - axis[2] * al) > f.rMax + WHEEL_SLACK_IN.measured) continue;
      best = { axis, pivot: bc, radius: f.rMax };
    }
  }
  return best;
}

/** how far along a clicked part's axle its lead part may be, past its own span, inches */
const LEAD_REACH_IN = 1.5;
/** a small clicked part this far outside a round part's box is still against it (a hub screw), inches */
const LEAD_PAD_IN = 0.3;

/** the biggest part ROUND about `seed`'s axle (`fit`) near it along it, else `seed` itself */
function leadOnAxle(parts: readonly MeshPart[], st: BodyStats, seed: number, fit: { axis: V3; pivot: V3 }): number {
  const { axis, pivot } = fit;
  const lo = dot(sub([st.min[3 * seed], st.min[3 * seed + 1], st.min[3 * seed + 2]], pivot), axis);
  const hi = dot(sub([st.max[3 * seed], st.max[3 * seed + 1], st.max[3 * seed + 2]], pivot), axis);
  const reach = Math.max(Math.abs(lo), Math.abs(hi)) + LEAD_REACH_IN;
  const cand = new Set<number>([seed]);
  for (const b of st.ids) {
    const d = sub([(st.min[3 * b] + st.max[3 * b]) / 2, (st.min[3 * b + 1] + st.max[3 * b + 1]) / 2, (st.min[3 * b + 2] + st.max[3 * b + 2]) / 2], pivot);
    const al = dot(d, axis);
    if (Math.abs(al) <= reach && Math.hypot(d[0] - axis[0] * al, d[1] - axis[1] * al, d[2] - axis[2] * al) <= COAXIAL_TOL_IN) cand.add(b);
  }
  const fits = axleFits(parts, st, cand, pivot, axis);
  let best = seed;
  let top = fits.get(seed)!.rMax;
  for (const [b, f] of fits) if (f.rMax > top + 0.05 && f.off <= COAXIAL_TOL_IN && roundAboutAxle(f)) {
    top = f.rMax;
    best = b;
  }
  // a small part OFF the axle (a screw through a gear, a mecanum's roller) is on no line of its own:
  // its lead is the round part it lies inside, about that part's own axle
  const sc: V3 = [(st.min[3 * seed] + st.max[3 * seed]) / 2, (st.min[3 * seed + 1] + st.max[3 * seed + 1]) / 2, (st.min[3 * seed + 2] + st.max[3 * seed + 2]) / 2];
  const ext = (b: number): number => Math.max(st.max[3 * b] - st.min[3 * b], st.max[3 * b + 1] - st.min[3 * b + 1], st.max[3 * b + 2] - st.min[3 * b + 2]);
  if (ext(seed) >= FASTENER_IN) return best;
  for (const b of st.ids) {
    if (b === seed || ext(b) <= ext(seed) || ![0, 1, 2].every((k) => sc[k] >= st.min[3 * b + k] - LEAD_PAD_IN && sc[k] <= st.max[3 * b + k] + LEAD_PAD_IN)) continue;
    const f = fitRound(parts, [b]);
    if (!f || f.radius <= top + 0.05) continue;
    const ff = axleFits(parts, st, new Set([b, seed]), f.pivot, f.axis);
    const own = ff.get(b)!;
    const s = ff.get(seed)!;
    // inside its radius, and in or against its span (a hub screw stands out of a flywheel's face)
    if (roundAboutAxle(own) && s.hi >= own.lo - 0.05 && s.lo <= own.hi + 0.05 && s.rMax <= own.rMax + 0.05) {
      top = f.radius;
      best = b;
    }
  }
  return best;
}

/**
 * EVERYTHING ON `seed`'s AXLE THAT TURNS WITH IT (a roller, a flywheel, a gear): the shaft and what is
 * on it, as one run along the axle (`AXLE_GAP_IN`). A body larger than a fastener turns with it only
 * when it is ROUND about the axle (2026-10-03, owner: "the auto-detector combines a static channel and
 * a gear into one component": a channel the shaft runs along is centred on it too). A MOTOR on the
 * axle never does (`axleMotors`, 2026-10-04): its can, gearbox, shield and end cap stay, its output
 * shaft turns. Nor do its SPOKES stand still (`spokesAbout`: surgical tubing on hubs). `motor` says the
 * seed is itself part of a motor. `line`: the axle when it is known (a star of spokes'), else the
 * seed's own (`fitRound`). `driven`: the seed is known to turn (it meshes with a wheel's gear), so it
 * is never taken for a motor's part.
 */
export function spinAxle(parts: readonly MeshPart[], seed: number, line?: { axis: V3; pivot: V3 }, driven = false): { bodies: number[]; motor: boolean } {
  const st = bodyStats(parts);
  const fit = line ? { ...line, radius: axleFits(parts, st, new Set([seed]), line.pivot, line.axis).get(seed)!.rMax } : fitRound(parts, [seed]);
  if (!fit) return { bodies: [seed], motor: false };
  const { axis, pivot } = fit;
  const reach = Math.max(AXLE_RADIUS_IN, fit.radius + 0.25);
  const cand = new Set<number>();
  for (const b of st.ids) {
    if (b === seed) continue;
    // on the axle by its BOX centre (a motor can's vertices crowd round its terminals, off its axle)
    const bd = sub([(st.min[3 * b] + st.max[3 * b]) / 2, (st.min[3 * b + 1] + st.max[3 * b + 1]) / 2, (st.min[3 * b + 2] + st.max[3 * b + 2]) / 2], pivot);
    const bal = dot(bd, axis);
    // (whether it turns ABOUT this axle is its roundness about it, below: its own principal axes are
    // no guide for a part as long as it is wide, a gearbox barrel, a shield)
    if (Math.hypot(bd[0] - axis[0] * bal, bd[1] - axis[1] * bal, bd[2] - axis[2] * bal) <= COAXIAL_TOL_IN) cand.add(b);
  }
  const fits = axleFits(parts, st, new Set([seed, ...cand]), pivot, axis);
  // nothing that reaches past the axle's own radius: a side plate the shaft runs through is centred
  // on it too, and it does not turn
  const near = [...cand].filter((b) => fits.get(b)!.rMax <= reach);
  const nearFits = new Map([seed, ...near].map((b) => [b, fits.get(b)!]));
  const sf = fits.get(seed)!;
  // the seed is a motor's own part (its can, gearbox, face, shield, end cap) or inside one (a bearing);
  // a seed known to be DRIVEN (a gear meshed with a wheel's) is never one, however close to the face
  if (axleMotors(nearFits, new Set(driven ? [seed] : [])).some((m) => m.members.has(seed) || (sf.lo >= m.lo - 0.05 && sf.hi <= m.hi + 0.05))) return { bodies: [seed], motor: true };
  const motors = axleMotors(nearFits, attachedTo(nearFits, seed));
  const out = motorExclusions(nearFits, motors, sf.lo, sf.hi);
  // larger than a fastener, it is round about the axle (a gear, a wheel, a spacer) or small (a hub
  // with a square flange): a channel or a pillow block is neither
  const round = near.filter((b) => {
    const f = fits.get(b)!;
    return !out.has(b) && (f.ext < FASTENER_IN || f.rMax <= HUB_R_IN || roundAboutAxle(f));
  });
  const res = alongAxle(fits, seed, round);
  const turning = [...res].map((b) => fits.get(b)!);
  for (const b of insideRotors(parts, st, turning, pivot, axis, (x) => res.has(x) || out.has(x) || fits.has(x))) res.add(b);
  // its SPOKES, which stand out past every round part on it
  const lo = Math.min(...turning.map((f) => f.lo));
  const hi = Math.max(...turning.map((f) => f.hi));
  const rAt = (al: number): number => Math.max(SHAFT_R_IN, ...turning.filter((f) => al >= f.lo - 0.1 && al <= f.hi + 0.1).map((f) => f.rMax));
  for (const b of spokesAbout(parts, st, axis, pivot, lo, hi, rAt, (x) => res.has(x) || out.has(x) || fits.has(x))) res.add(b);
  return { bodies: [...res].sort((a, b) => a - b), motor: false };
}

/**
 * SMALL PARTS INSIDE TURNING ONES: a fastener or a sliver of a gear lying wholly inside one of
 * `turning`'s own cylinder (its span along the axle, its radius) is that part's, however far off the
 * axle it sits (the screws through a gear, a hub's set screw): nothing static can be there. Without
 * this a sliver 0.4 in off the axle was in or out with the triangle count (2026-10-04, AndyMark's
 * gears). Shafts (`SHAFT_R_IN`) hold nothing. `skip`: bodies already decided.
 */
function insideRotors(parts: readonly MeshPart[], st: BodyStats, turning: readonly AxleFit[], pivot: V3, axis: V3, skip: (b: number) => boolean): number[] {
  const rotors = turning.filter((f) => f.rMax > SHAFT_R_IN);
  if (!rotors.length) return [];
  const top = Math.max(...rotors.map((f) => f.rMax));
  const lo = Math.min(...rotors.map((f) => f.lo));
  const hi = Math.max(...rotors.map((f) => f.hi));
  const inner = new Set<number>();
  for (const b of st.ids) {
    if (skip(b)) continue;
    if (Math.max(st.max[3 * b] - st.min[3 * b], st.max[3 * b + 1] - st.min[3 * b + 1], st.max[3 * b + 2] - st.min[3 * b + 2]) >= FASTENER_IN) continue;
    const bd = sub([(st.min[3 * b] + st.max[3 * b]) / 2, (st.min[3 * b + 1] + st.max[3 * b + 1]) / 2, (st.min[3 * b + 2] + st.max[3 * b + 2]) / 2], pivot);
    const bal = dot(bd, axis);
    if (bal >= lo && bal <= hi && Math.hypot(bd[0] - axis[0] * bal, bd[1] - axis[1] * bal, bd[2] - axis[2] * bal) <= top + Math.max(0.05, 0.03 * top)) inner.add(b);
  }
  // the radius with a little slack: a Gecko wheel modelled fin by fin has its fin tips as slivers
  // 0.09 in long that stand ~0.03 in past the round part they belong to, and at 0.02 a side roller
  // kept 20 of its 140 bodies (goBILDA's BIOBUZZ mecanum bot, 2026-10-04)
  const out: number[] = [];
  for (const [b, f] of axleFits(parts, st, inner, pivot, axis)) {
    if (rotors.some((r) => f.lo >= r.lo - 0.05 && f.hi <= r.hi + 0.05 && f.rMax <= r.rMax + Math.max(0.05, 0.03 * r.rMax))) out.push(b);
  }
  return out;
}

// ---- spokes: surgical tubing on a hub ---------------------------------------------------------------

/**
 * A SPOKE is a ROD at least twice as long as it is thick: Offset Robotics' surgical tubing is 0.89 and
 * 1.48 in long on 0.37 in tube (2.4 and 4 to 1). Its long axis is square to its axle (within
 * `SPOKE_SQUARE`, a cosine) and its line runs through the axle (`SPOKE_RADIAL_IN`), from the hub it
 * is pushed into (its inner end within 0.15 in of the hub's radius: 0.30 in on a 0.34 in hex hub) out
 * to at least `SPOKE_REACH_IN`. On their own a mecanum's roller pins (45° to the axle), an omni
 * wheel's (tangent: their line misses the axle by the wheel's radius) and a screw (too short) are not.
 */
const SPOKE_SQUARE = 0.15;
const SPOKE_RADIAL_IN = 0.12;
const SPOKE_ASPECT = 2;
const SPOKE_MIN_LEN_IN = 0.5;
const SPOKE_REACH_IN = 0.8;
/** no spoke's box is longer than this, inches (and a seed's spokes start within this of the axle) */
const SPOKE_MAX_IN = 3;
/** a spoke's two smaller second moments are under this share of the largest: long and thin (a tube
 *  whose vertices sit on its two end rings has (L/2)² against ρ²/2: Offset's tubing 0.09 and 0.03) */
const SPOKE_THIN = 0.25;
/**
 * A STAR: spokes in one plane across the axle (their centres within `STAR_SLICE_IN` along it), at
 * least `STAR_MIN` of them, round it with no gap wider than `STAR_GAP_DEG` (Offset's tubing: six at
 * 60°, every 0.79 in along the shaft). Rotational symmetry is what says they turn together: a lone
 * radial screw, or two, does not make one.
 */
const STAR_SLICE_IN = 0.12;
const STAR_MIN = 3;
const STAR_GAP_DEG = 150;

/** a body's long direction and its length and thickness along and across it, when it is ROD-like */
interface Rod {
  b: number;
  c: V3;
  u: V3;
  len: number;
  rho: number;
}

/** each body's rod measurement, or null when it is no rod (memoised on the parts, like `bodyStats`:
 *  the roller search asks about the same bodies once per edge and per axle) */
const rodCache = new WeakMap<readonly MeshPart[], Map<number, Rod | null>>();

/** of `bodies`, the rods (`SPOKE_THIN`, then measured: `SPOKE_ASPECT`, `SPOKE_MIN_LEN_IN`) square to `axis` */
function rodsSquareTo(parts: readonly MeshPart[], st: BodyStats, bodies: Iterable<number>, axis: V3): Rod[] {
  let cache = rodCache.get(parts);
  if (!cache) rodCache.set(parts, (cache = new Map()));
  const asked: number[] = [];
  const fresh = new Map<number, { r: Rod; lo: number; hi: number }>();
  for (const b of bodies) {
    asked.push(b);
    if (cache.has(b) || fresh.has(b)) continue;
    const ext = Math.max(st.max[3 * b] - st.min[3 * b], st.max[3 * b + 1] - st.min[3 * b + 1], st.max[3 * b + 2] - st.min[3 * b + 2]);
    const mo = ext > SPOKE_MAX_IN || ext < SPOKE_MIN_LEN_IN ? null : setMoments(st, [b]);
    const e = mo && mo.n >= 6 ? eigenSym3(mo.cov) : null;
    if (!mo || !e || !(e.values[0] > 0) || e.values[1] > SPOKE_THIN * e.values[0]) {
      cache.set(b, null);
      continue;
    }
    fresh.set(b, { r: { b, c: boxCentre(mo), u: e.vectors[0], len: 0, rho: 0 }, lo: Infinity, hi: -Infinity });
  }
  // its length along its long axis and its thickness across it: one pass over the new ones' vertices
  if (fresh.size) {
    eachVertex(parts, new Set(fresh.keys()), (x, y, z, b) => {
      const k = fresh.get(b)!;
      const d: V3 = [x - k.r.c[0], y - k.r.c[1], z - k.r.c[2]];
      const t = dot(d, k.r.u);
      if (t < k.lo) k.lo = t;
      if (t > k.hi) k.hi = t;
      const q = Math.hypot(d[0] - k.r.u[0] * t, d[1] - k.r.u[1] * t, d[2] - k.r.u[2] * t);
      if (q > k.r.rho) k.r.rho = q;
    });
    for (const [b, k] of fresh) {
      k.r.len = k.hi - k.lo;
      cache.set(b, k.r.len >= Math.max(SPOKE_MIN_LEN_IN, SPOKE_ASPECT * 2 * k.r.rho) ? k.r : null);
    }
  }
  const out: Rod[] = [];
  for (const b of asked) {
    const r = cache.get(b);
    if (r && Math.abs(dot(r.u, axis)) <= SPOKE_SQUARE) out.push(r);
  }
  return out;
}

/** do these angles (radians) go round: at least `STAR_MIN`, no gap over `STAR_GAP_DEG` */
function goesRound(angles: number[]): boolean {
  if (angles.length < STAR_MIN) return false;
  const a = [...angles].sort((x, y) => x - y);
  let gap = a[0] + 2 * Math.PI - a[a.length - 1];
  for (let k = 1; k < a.length; k++) gap = Math.max(gap, a[k] - a[k - 1]);
  return gap < (STAR_GAP_DEG * Math.PI) / 180;
}

/**
 * THE SPOKES ON A KNOWN AXLE (`spinAxle`): rods square to it whose line runs through it, centred
 * along it within [lo − 0.3, hi + 0.3] (what turns there), the inner end within 0.15 in of `rAt` (the
 * radius of what turns at that place), the outer end at least `SPOKE_REACH_IN` out, in stars.
 */
function spokesAbout(parts: readonly MeshPart[], st: BodyStats, axis: V3, pivot: V3, lo: number, hi: number, rAt: (al: number) => number, skip: (b: number) => boolean): number[] {
  const near: number[] = [];
  for (const b of st.ids) {
    if (skip(b)) continue;
    const d = sub([(st.min[3 * b] + st.max[3 * b]) / 2, (st.min[3 * b + 1] + st.max[3 * b + 1]) / 2, (st.min[3 * b + 2] + st.max[3 * b + 2]) / 2], pivot);
    const al = dot(d, axis);
    if (al < lo - 0.3 || al > hi + 0.3) continue;
    const rc = Math.hypot(d[0] - axis[0] * al, d[1] - axis[1] * al, d[2] - axis[2] * al);
    if (rc >= 0.15 && rc <= SPOKE_MAX_IN) near.push(b);
  }
  if (!near.length) return [];
  const e1 = norm(Math.abs(axis[2]) < 0.9 ? cross(axis, [0, 0, 1]) : cross(axis, [1, 0, 0]));
  const e2 = cross(axis, e1);
  const spokes: { b: number; al: number; ang: number }[] = [];
  for (const r of rodsSquareTo(parts, st, near, axis)) {
    const d = sub(r.c, pivot);
    const al = dot(d, axis);
    // its line runs through the axle: the two lines' distance apart
    if (Math.abs(dot(d, norm(cross(axis, r.u)))) > SPOKE_RADIAL_IN) continue;
    const rc = Math.hypot(d[0] - axis[0] * al, d[1] - axis[1] * al, d[2] - axis[2] * al);
    if (rc - r.len / 2 > rAt(al) + 0.15 || rc + r.len / 2 < SPOKE_REACH_IN) continue;
    spokes.push({ b: r.b, al, ang: Math.atan2(dot(d, e2), dot(d, e1)) });
  }
  return starsOf(spokes).flat();
}

/** spokes (along the axle, angle round it) grouped into planes; the planes that are stars */
function starsOf(spokes: { b: number; al: number; ang: number }[]): number[][] {
  const s = [...spokes].sort((x, y) => x.al - y.al || x.b - y.b);
  const out: number[][] = [];
  for (let i = 0; i < s.length; ) {
    let j = i + 1;
    while (j < s.length && s[j].al - s[j - 1].al <= STAR_SLICE_IN) j++;
    const plane = s.slice(i, j);
    if (goesRound(plane.map((p) => p.ang))) out.push(plane.map((p) => p.b));
    i = j;
  }
  return out;
}

/**
 * STARS OF SPOKES ANYWHERE, about axles along `axis` (a model axis: a robot is built square), among
 * bodies `used` does not hold and whose centre `where` allows: the rods square to it, paired where
 * their lines cross behind both inner ends (within 0.8 in: the hub they are pushed into), the crossings
 * that agree (0.2 in) taken as one axle, kept when its rods go round it (`goesRound`). Each star with
 * a point on its axle and its spokes; nearest the start of `axis` first.
 */
export function spokeStars(parts: readonly MeshPart[], axis: V3, used: ReadonlySet<number>, where?: (c: V3) => boolean): { pivot: V3; spokes: number[] }[] {
  const st = bodyStats(parts);
  const e1 = norm(Math.abs(axis[2]) < 0.9 ? cross(axis, [0, 0, 1]) : cross(axis, [1, 0, 0]));
  const e2 = cross(axis, e1);
  const pool = st.ids.filter((b) => !used.has(b) && (!where || where(boxCentre({ min: [st.min[3 * b], st.min[3 * b + 1], st.min[3 * b + 2]], max: [st.max[3 * b], st.max[3 * b + 1], st.max[3 * b + 2]] }))));
  const rods = rodsSquareTo(parts, st, pool, axis).map((r) => {
    const v = [dot(r.u, e1), dot(r.u, e2)];
    const l = Math.hypot(v[0], v[1]) || 1;
    return { ...r, al: dot(r.c, axis), p: [dot(r.c, e1), dot(r.c, e2)], v: [v[0] / l, v[1] / l] };
  });
  // pairs in one plane whose lines cross behind both: a candidate axle each
  const cell = 2;
  const grid = new Map<string, number[]>();
  const key = (al: number, x: number, y: number): string => `${Math.round(al / 0.5)},${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  rods.forEach((r, i) => {
    const k = key(r.al, r.p[0], r.p[1]);
    const l = grid.get(k);
    if (l) l.push(i);
    else grid.set(k, [i]);
  });
  const hits: { q: [number, number]; al: number; i: number; j: number }[] = [];
  const behind = (r: (typeof rods)[number], q: [number, number]): boolean => {
    const s = Math.hypot(q[0] - r.p[0], q[1] - r.p[1]);
    return s >= r.len / 2 - 0.3 && s <= r.len / 2 + 0.8;
  };
  rods.forEach((a, i) => {
    const ka = Math.round(a.al / 0.5);
    const cx = Math.floor(a.p[0] / cell);
    const cy = Math.floor(a.p[1] / cell);
    for (let da = -1; da <= 1; da++) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const j of grid.get(`${ka + da},${cx + dx},${cy + dy}`) ?? []) {
        if (j <= i) continue;
        const b = rods[j];
        if (Math.abs(a.al - b.al) > STAR_SLICE_IN) continue;
        const den = a.v[0] * b.v[1] - a.v[1] * b.v[0];
        if (Math.abs(den) < 0.25) continue; // nearly parallel: opposite spokes, or a row of screws
        const s = ((b.p[0] - a.p[0]) * b.v[1] - (b.p[1] - a.p[1]) * b.v[0]) / den;
        const q: [number, number] = [a.p[0] + s * a.v[0], a.p[1] + s * a.v[1]];
        if (behind(a, q) && behind(b, q)) hits.push({ q, al: (a.al + b.al) / 2, i, j });
      }
    }
  });
  // crossings that agree are one axle; its rods are every rod that crosses there
  const taken = new Set<number>();
  const stars: { pivot: V3; spokes: number[]; al: number }[] = [];
  const order = hits.map((_, k) => k).sort((x, y) => hits[x].al - hits[y].al || hits[x].q[0] - hits[y].q[0] || hits[x].q[1] - hits[y].q[1]);
  const seen = new Set<number>();
  for (const k of order) {
    if (seen.has(k)) continue;
    const h = hits[k];
    const members = new Set<number>();
    let qx = 0;
    let qy = 0;
    let al = 0;
    let n = 0;
    for (const m of order) {
      const o = hits[m];
      if (seen.has(m) || Math.abs(o.al - h.al) > STAR_SLICE_IN || Math.hypot(o.q[0] - h.q[0], o.q[1] - h.q[1]) > 0.2) continue;
      seen.add(m);
      members.add(o.i);
      members.add(o.j);
      qx += o.q[0];
      qy += o.q[1];
      al += o.al;
      n++;
    }
    const q = [qx / n, qy / n];
    // every member points at the agreed centre, and they go round it
    const ok = [...members].filter((i) => !taken.has(i) && Math.abs((q[0] - rods[i].p[0]) * rods[i].v[1] - (q[1] - rods[i].p[1]) * rods[i].v[0]) <= SPOKE_RADIAL_IN && Math.hypot(q[0] - rods[i].p[0], q[1] - rods[i].p[1]) + rods[i].len / 2 >= SPOKE_REACH_IN);
    if (!goesRound(ok.map((i) => Math.atan2(rods[i].p[1] - q[1], rods[i].p[0] - q[0])))) continue;
    for (const i of ok) taken.add(i);
    const a = al / n;
    stars.push({ pivot: add(add(scale(e1, q[0]), scale(e2, q[1])), scale(axis, a)), spokes: ok.map((i) => rods[i].b).sort((x, y) => x - y), al: a });
  }
  return stars.sort((x, y) => x.al - y.al || x.spokes[0] - y.spokes[0]).map(({ pivot, spokes }) => ({ pivot, spokes }));
}

/** the body on the line (`pivot`, `axis`) nearest `pivot` along it: a star's hub, else its shaft; -1 when none */
function bodyOnLine(st: BodyStats, pivot: V3, axis: V3, skip: ReadonlySet<number>): number {
  let best = -1;
  let bestD = Infinity;
  for (const b of st.ids) {
    if (skip.has(b)) continue;
    const d = sub([(st.min[3 * b] + st.max[3 * b]) / 2, (st.min[3 * b + 1] + st.max[3 * b + 1]) / 2, (st.min[3 * b + 2] + st.max[3 * b + 2]) / 2], pivot);
    const al = dot(d, axis);
    if (Math.hypot(d[0] - axis[0] * al, d[1] - axis[1] * al, d[2] - axis[2] * al) > COAXIAL_TOL_IN) continue;
    // a body spanning the star's plane (its hub, its shaft) before one beside it
    const lo = dot(sub([st.min[3 * b], st.min[3 * b + 1], st.min[3 * b + 2]], pivot), axis);
    const hi = dot(sub([st.max[3 * b], st.max[3 * b + 1], st.max[3 * b + 2]], pivot), axis);
    const dist = Math.min(lo, hi) <= 0 && Math.max(lo, hi) >= 0 ? 0 : Math.abs(al);
    if (dist < bestD - 1e-9) {
      bestD = dist;
      best = b;
    }
  }
  return bestD <= 1 ? best : -1;
}

/**
 * The axle of the star `seed` is a spoke of (a click on surgical tubing): its own line runs through
 * the axle, so its own round fit is the tube's, and grew the radial line into a stray group. Null when
 * it is in no star.
 */
function starAxle(parts: readonly MeshPart[], seed: number): { axis: V3; pivot: V3 } | null {
  const st = bodyStats(parts);
  const c = boxCentre({ min: [st.min[3 * seed], st.min[3 * seed + 1], st.min[3 * seed + 2]], max: [st.max[3 * seed], st.max[3 * seed + 1], st.max[3 * seed + 2]] });
  for (const axis of [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ] as V3[]) {
    if (!rodsSquareTo(parts, st, [seed], axis).length) continue;
    const star = spokeStars(parts, axis, new Set(), (p) => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) <= SPOKE_MAX_IN).find((s) => s.spokes.includes(seed));
    if (star) return { axis, pivot: star.pivot };
  }
  return null;
}

/** a body no wider than this from the axle that is not round is a hub or a collar, inches */
const HUB_R_IN = 0.7;

/** `seed` and what is ATTACHED to it along the axle: on the axle and overlapping it, or overlapping
 *  something short that does (its hub, the screws in the hub). Never a motor's part, however close the
 *  motor sits. A shaft overlaps everything on it, so it attaches nothing further (nor does anything
 *  longer than the part and an inch: AndyMark's motor shaft has a shoulder, and reached the motor). */
function attachedTo(fits: ReadonlyMap<number, AxleFit>, seed: number): Set<number> {
  const out = new Set([seed]);
  const sf = fits.get(seed)!;
  let lo = sf.lo;
  let hi = sf.hi;
  const short = Math.max(1, hi - lo);
  // a SHAFT runs through everything on it: only what grips it is attached (goBILDA's 6WD pinion's
  // output shaft runs back into its gearbox, and attached the gearbox's face to it)
  const shaft = sf.rMax <= SHAFT_R_IN;
  for (let grew = true; grew; ) {
    grew = false;
    for (const [b, f] of fits) {
      if (out.has(b) || f.off > ON_AXLE_IN || Math.min(f.hi, hi) - Math.max(f.lo, lo) < 0.02) continue;
      if (shaft && f.rMin > sf.rMax + GRIP_IN) continue;
      out.add(b);
      if (f.rMax > SHAFT_R_IN && f.hi - f.lo <= short) {
        lo = Math.min(lo, f.lo);
        hi = Math.max(hi, f.hi);
        grew = true;
      }
    }
  }
  return out;
}

/** `seed` and the bodies of `pool` that follow on from it along the axle, each within `AXLE_GAP_IN` of
 *  the run so far: one shaft's parts, not another shaft's that shares its line */
function alongAxle(fits: ReadonlyMap<number, AxleFit>, seed: number, pool: readonly number[]): Set<number> {
  const out = new Set([seed]);
  let lo = fits.get(seed)!.lo;
  let hi = fits.get(seed)!.hi;
  for (let grew = true; grew; ) {
    grew = false;
    for (const b of pool) {
      if (out.has(b)) continue;
      const f = fits.get(b)!;
      if (f.hi < lo - AXLE_GAP_IN || f.lo > hi + AXLE_GAP_IN) continue;
      out.add(b);
      lo = Math.min(lo, f.lo);
      hi = Math.max(hi, f.hi);
      grew = true;
    }
  }
  return out;
}

// ---- a motor on the axle -------------------------------------------------------------------------

/** a motor's CAN: round, this wide from its axle (goBILDA 5203 and REV HD Hex are 36–38 mm), inches */
const CAN_R_IN: readonly [number, number] = [0.55, 0.95];
/** ...and at least this long, inches */
const CAN_LEN_IN = 1;
/** the gearbox, shield, end cap and mount that stack on it: on the axle, this wide from it, inches */
const MOTOR_PART_R_IN: readonly [number, number] = [0.45, 1.35];
/** a motor's parts follow each other along the axle with gaps under this, inches */
const MOTOR_GAP_IN = 0.3;
/** a motor with its gearbox is this long, inches */
const MOTOR_LEN_IN: readonly [number, number] = [1.6, 7.5];
/** its back end is FREE: nothing round carries the axle on within this of it, inches */
const MOTOR_FREE_IN = 1;
/** a part of a motor that is not round is a plate no thicker than this (a mount, a face), inches */
const MOTOR_PLATE_IN = 0.6;

/** can-shaped: round about the axle, `CAN_R_IN` from it, at least `CAN_LEN_IN` long */
const isCan = (f: AxleFit): boolean => f.off <= ON_AXLE_IN && f.rMax >= CAN_R_IN[0] && f.rMax <= CAN_R_IN[1] && f.hi - f.lo >= CAN_LEN_IN && roundAboutAxle(f);

interface AxleMotor {
  members: Set<number>;
  lo: number;
  hi: number;
  /** its free end: −1 at `lo`, +1 at `hi`, 0 both */
  free: number;
}

/**
 * THE MOTORS ON AN AXLE (2026-10-04, owner: "You are still combining the motor into the wheel";
 * measured on goBILDA's BIOBUZZ bots, the intake motor came with the intake gear and the launcher
 * motor with the flywheel: a 5203 is a dozen round bodies on the shaft's line, can, gearbox barrel,
 * face, bearings, shield, end cap, label). Among `fits`, the bodies centred on the axle:
 *  · a CAN: round, 1.1–1.9 in across (`CAN_R_IN`), at least `CAN_LEN_IN` long, and no shaft runs
 *    through it and out both ends (a roller tube on its shaft fails here);
 *  · grown along the axle through what stacks on it (`MOTOR_PART_R_IN`, gaps under `MOTOR_GAP_IN`;
 *    round, or a plate no thicker than `MOTOR_PLATE_IN`: the channel a motor sits in is neither),
 *    never through `protect` (the part being picked and what is attached to it, `attachedTo`);
 *  · 1.6–7.5 in long in all (`MOTOR_LEN_IN`), with a FREE end: at one end nothing round carries the
 *    axle on within `MOTOR_FREE_IN` (a motor's back is its end cap; a can-sized roller in the middle
 *    of a shaft has a shaft and bearings past both ends);
 *  · and not alone on its axle: more than one part, or touching something (its output shaft).
 * Shafts (`SHAFT_R_IN`) are never a motor's part: its output shaft turns with what it drives.
 */
function axleMotors(fits: ReadonlyMap<number, AxleFit>, protect: ReadonlySet<number>): AxleMotor[] {
  const on = [...fits].filter(([, f]) => f.off <= ON_AXLE_IN);
  const thin = (f: AxleFit): boolean => f.rMax <= SHAFT_R_IN;
  const cans = on
    .filter(([b, f]) => !protect.has(b) && isCan(f) && !on.some(([, t]) => thin(t) && t.lo < f.lo - 0.3 && t.hi > f.hi + 0.3))
    .sort((a, b) => b[1].hi - b[1].lo - (a[1].hi - a[1].lo) || a[0] - b[0]);
  const out: AxleMotor[] = [];
  const used = new Set<number>();
  for (const [cb, cf] of cans) {
    if (used.has(cb)) continue;
    const members = new Set([cb]);
    let lo = cf.lo;
    let hi = cf.hi;
    for (let grew = true; grew; ) {
      grew = false;
      for (const [b, f] of on) {
        if (members.has(b) || protect.has(b) || thin(f) || f.rMax < MOTOR_PART_R_IN[0] || f.rMax > MOTOR_PART_R_IN[1]) continue;
        // round (a gearbox, a shield) or a thin plate (a mount, a face): the channel round the motor
        // is neither, and runs on past it
        if (!roundAboutAxle(f) && f.hi - f.lo > MOTOR_PLATE_IN) continue;
        if (f.hi < lo - MOTOR_GAP_IN || f.lo > hi + MOTOR_GAP_IN) continue;
        members.add(b);
        lo = Math.min(lo, f.lo);
        hi = Math.max(hi, f.hi);
        grew = true;
      }
    }
    if (hi - lo < MOTOR_LEN_IN[0] || hi - lo > MOTOR_LEN_IN[1]) continue;
    const carried = (side: number): boolean =>
      on.some(([b, f]) => !members.has(b) && !thin(f) && f.ext >= 0.3 && roundAboutAxle(f) && (side < 0 ? f.lo < lo - 0.05 && f.hi > lo - MOTOR_FREE_IN : f.hi > hi + 0.05 && f.lo < hi + MOTOR_FREE_IN));
    const atLo = carried(-1);
    const atHi = carried(1);
    if (atLo && atHi) continue;
    // and it is not ALONE on its axle: a motor is a stack of parts, or drives a shaft. A plain
    // cylinder with nothing on its line (a side roller turned by a servo below it) is a roller.
    if (members.size < 2 && !on.some(([b, f]) => !members.has(b) && f.hi >= lo - MOTOR_GAP_IN && f.lo <= hi + MOTOR_GAP_IN)) continue;
    for (const b of members) used.add(b);
    out.push({ members, lo, hi, free: atLo ? 1 : atHi ? -1 : 0 });
  }
  return out;
}

/**
 * What of `fits` belongs to `motors` and so does not turn with a part spanning [lo, hi] along the
 * axle: each motor's members, anything wholly inside its span (its bearings, its own short shafts),
 * and anything past its free end on the far side from the part (an encoder, a connector). A shaft that
 * comes out of the motor toward the part is its output shaft, and turns.
 */
function motorExclusions(fits: ReadonlyMap<number, AxleFit>, motors: readonly AxleMotor[], lo: number, hi: number): Set<number> {
  const out = new Set<number>();
  for (const m of motors) {
    const toward = (lo + hi) / 2 < (m.lo + m.hi) / 2 ? -1 : 1;
    for (const [b, f] of fits) {
      if (m.members.has(b)) {
        out.add(b);
        continue;
      }
      if (f.rMax <= SHAFT_R_IN && (toward < 0 ? f.lo < m.lo - 0.2 : f.hi > m.hi + 0.2)) continue;
      const inside = f.lo >= m.lo - 0.05 && f.hi <= m.hi + 0.05;
      const tail = (m.free === -toward || m.free === 0) && (toward < 0 ? f.lo >= m.hi - 0.05 : f.hi <= m.lo + 0.05);
      if (inside || tail) out.add(b);
    }
  }
  return out;
}

// ---- the drive wheels, from the floor contacts ----------------------------------------------------

/** half a drive wheel's width along its axle, at most, inches (a 104 mm mecanum is 1.8 in wide) */
const WHEEL_HALF_WIDTH_IN = 1.4;
/** a body whose box centre is this close to an axle is ON it (a hub, a spacer, a clamp screw), inches */
const ON_AXLE_IN = 0.35;
/** how far a part on the axle may stand out of the wheel's own width and still turn with it, inches
 *  (a hub through the bore does; a motor, a bearing block or a collar inside the frame does not) */
const HUB_PROUD_IN = 0.6;
/** a body smaller than this (its box's longest side) may be a fastener, inches */
const FASTENER_IN = 1.2;
/** a body on the axle this close to a wheel's width touches it (a screw head on the hub's face), inches */
const TOUCH_IN = 0.05;

interface AxleFit {
  /** its points' span along the axle */
  lo: number;
  hi: number;
  /** the largest distance of its points from the axle */
  rMax: number;
  /** the smallest: a bore's radius, for a part the axle runs through */
  rMin: number;
  /** its box centre's distance from the axle */
  off: number;
  /** its box's longest side */
  ext: number;
  /** its half widths across the axle, in two directions square to it and each other */
  w1: number;
  w2: number;
}

/** where each of `bodies` sits about the axle through `centre` along unit `axis` */
function axleFits(parts: readonly MeshPart[], st: BodyStats, bodies: ReadonlySet<number>, centre: V3, axis: V3): Map<number, AxleFit> {
  const out = new Map<number, AxleFit>();
  for (const b of bodies) {
    const mo = { min: [st.min[3 * b], st.min[3 * b + 1], st.min[3 * b + 2]] as V3, max: [st.max[3 * b], st.max[3 * b + 1], st.max[3 * b + 2]] as V3 };
    const d = sub(boxCentre(mo), centre);
    const rv = sub(d, scale(axis, dot(d, axis)));
    out.set(b, {
      lo: Infinity,
      hi: -Infinity,
      rMax: 0,
      rMin: Infinity,
      off: Math.hypot(rv[0], rv[1], rv[2]),
      ext: Math.max(mo.max[0] - mo.min[0], mo.max[1] - mo.min[1], mo.max[2] - mo.min[2]),
      w1: 0,
      w2: 0,
    });
  }
  const e1 = norm(Math.abs(axis[2]) < 0.9 ? cross(axis, [0, 0, 1]) : cross(axis, [1, 0, 0]));
  const e2 = cross(axis, e1);
  const span = new Map<number, number[]>();
  eachVertex(parts, bodies, (x, y, z, b) => {
    const f = out.get(b)!;
    const r = sub([x, y, z], centre);
    const along = dot(r, axis);
    const rr = Math.hypot(r[0] - axis[0] * along, r[1] - axis[1] * along, r[2] - axis[2] * along);
    if (along < f.lo) f.lo = along;
    if (along > f.hi) f.hi = along;
    if (rr > f.rMax) f.rMax = rr;
    if (rr < f.rMin) f.rMin = rr;
    let sp = span.get(b);
    if (!sp) span.set(b, (sp = [Infinity, -Infinity, Infinity, -Infinity]));
    const u = dot(r, e1);
    const v = dot(r, e2);
    if (u < sp[0]) sp[0] = u;
    if (u > sp[1]) sp[1] = u;
    if (v < sp[2]) sp[2] = v;
    if (v > sp[3]) sp[3] = v;
  });
  for (const [b, sp] of span) {
    const f = out.get(b)!;
    f.w1 = (sp[1] - sp[0]) / 2;
    f.w2 = (sp[3] - sp[2]) / 2;
  }
  return out;
}

/** is a body ROUND about the axle: as wide one way across it as the other, with no corner past the
 *  circle (a gear, a hub, a shaft, a roller pass; a channel or a plate the shaft runs through fails) */
function roundAboutAxle(f: AxleFit): boolean {
  const w = Math.max(f.w1, f.w2);
  if (!(w > 1e-6)) return false;
  const ratio = f.w1 / Math.max(f.w2, 1e-9);
  return ratio >= 0.8 && ratio <= 1.25 && f.rMax <= 1.12 * w;
}

/**
 * WHAT OF `fits` TURNS WITH A WHEEL of radius `R` (2026-10-03, owner: "the motor or the motor
 * cover/shield spins with the wheel sometimes"). The wheel's own WIDTH is the along-axle span of its
 * ring (`wheelRing`). Then:
 *  · a body ON the axle (a hub, a spacer, a clamp screw) must touch that width (`TOUCH_IN`) and stand
 *    out of it by no more than `HUB_PROUD_IN`: a motor, a bearing block, a collar inside the frame do
 *    not turn; its SHAFT does, however far it runs;
 *  · a body OFF the axle must lie within the width (`margin`).
 * A rule that dropped small bodies pointing at the axle (a frame screw beside it, round two) came out:
 * on the seven starter bots it never dropped a screw, only the wheels' own omni pieces and tread nubs,
 * and which of those it dropped changed with the triangle count (2026-10-04).
 * With no outer ring found, every body passes (the cylinder test alone).
 */
export function turnsWithWheel(fits: ReadonlyMap<number, AxleFit>, R: number): Set<number> {
  const keep = new Set<number>();
  const ring = wheelRing(fits, R);
  if (!ring) {
    for (const b of fits.keys()) keep.add(b);
    return keep;
  }
  const { lo, hi } = ring;
  const margin = 0.15;
  for (const [b, f] of fits) {
    if (f.off <= ON_AXLE_IN) {
      // beside the wheel (a shield, a bearing), not touching it (a screw head on its face does)
      if (f.hi < lo - TOUCH_IN || f.lo > hi + TOUCH_IN) continue;
      // its SHAFT turns with it however far it runs (2026-10-04: the owner's list of what a wheel is)
      if (f.rMax <= SHAFT_R_IN && f.hi - f.lo <= SHAFT_MAX_IN) {
        keep.add(b);
        continue;
      }
      if (f.lo < lo - HUB_PROUD_IN || f.hi > hi + HUB_PROUD_IN) continue; // a motor, a long collar
      keep.add(b);
      continue;
    }
    if (f.lo < lo - margin || f.hi > hi + margin) continue;
    keep.add(b);
  }
  return keep;
}

/**
 * A wheel's RING among `fits`: big bodies CENTRED on the axle (a tyre, a rim, a mecanum's side plates),
 * the ones near the largest such radius (a shield or a pulley beside the wheel is centred and big too,
 * and must not widen it), and the span they cover along the axle. Off the axle a body can reach 0.6 R
 * and be a frame screw beside the wheel (measured), so only when nothing centred is that big does the
 * off-axle ring count. Null when there is none.
 */
function wheelRing(fits: ReadonlyMap<number, AxleFit>, R: number): { lo: number; hi: number; bodies: Set<number> } | null {
  for (const centred of [true, false]) {
    let top = 0;
    for (const f of fits.values()) if (f.rMax >= 0.6 * R && (!centred || f.off <= ON_AXLE_IN)) top = Math.max(top, f.rMax);
    let lo = Infinity;
    let hi = -Infinity;
    const bodies = new Set<number>();
    for (const [b, f] of fits) {
      if (f.rMax >= Math.max(0.6 * R, 0.85 * top) && (!centred || f.off <= ON_AXLE_IN)) {
        lo = Math.min(lo, f.lo);
        hi = Math.max(hi, f.hi);
        bodies.add(b);
      }
    }
    if (hi > lo) return { lo, hi, bodies };
  }
  return null;
}

/** how far along a wheel's axle its motor is looked for, inches (the wheel's width and a motor's length) */
const WHEEL_MOTOR_REACH_IN = WHEEL_HALF_WIDTH_IN + MOTOR_LEN_IN[1] + MOTOR_FREE_IN;

/**
 * THE BODIES OF ONE WHEEL of radius `R` about the axle through `centre` along unit `axis`: those wholly
 * inside its own cylinder (a wheel's width along the axle, `R` + `slack` from it: never a frame plate,
 * which runs past it) and its shaft, of which what turns with it (`turnsWithWheel`), less any motor on
 * the axle (`axleMotors`: a gearbox face against the hub stands inside the hub's allowance, and is the
 * motor's). Bodies in `taken` are never used.
 */
function wheelBodies(parts: readonly MeshPart[], st: BodyStats, centre: V3, axis: V3, R: number, taken: ReadonlySet<number>, slack: number = WHEEL_SLACK_IN.catalogue): number[] {
  const near = new Set<number>();
  const reach = R + 0.5;
  for (const b of st.ids) {
    if (taken.has(b)) continue;
    const lo: V3 = [st.min[3 * b], st.min[3 * b + 1], st.min[3 * b + 2]];
    const hi: V3 = [st.max[3 * b], st.max[3 * b + 1], st.max[3 * b + 2]];
    // the wheel's own cylinder, by its box
    if (lo[0] <= centre[0] + reach && hi[0] >= centre[0] - reach && lo[1] <= centre[1] + reach && hi[1] >= centre[1] - reach && lo[2] <= centre[2] + reach && hi[2] >= centre[2] - reach) {
      near.add(b);
      continue;
    }
    // or centred on the axle further along it: a shaft, a motor
    const d = sub(boxCentre({ min: lo, max: hi }), centre);
    const al = dot(d, axis);
    if (Math.abs(al) <= WHEEL_MOTOR_REACH_IN && Math.hypot(d[0] - axis[0] * al, d[1] - axis[1] * al, d[2] - axis[2] * al) <= ON_AXLE_IN + 0.15) near.add(b);
  }
  const fits = axleFits(parts, st, near, centre, axis);
  const pool = new Map<number, AxleFit>();
  for (const [b, f] of fits) {
    const inside = f.rMax <= R + slack && f.lo >= -WHEEL_HALF_WIDTH_IN && f.hi <= WHEEL_HALF_WIDTH_IN;
    const shaft = f.off <= ON_AXLE_IN && f.rMax <= SHAFT_R_IN && f.hi - f.lo <= SHAFT_MAX_IN && f.lo <= WHEEL_HALF_WIDTH_IN && f.hi >= -WHEEL_HALF_WIDTH_IN;
    if (inside || shaft) pool.set(b, f);
  }
  const keep = turnsWithWheel(pool, R);
  const ring = wheelRing(pool, R);
  if (ring) {
    const onAxle = new Map([...fits].filter(([, f]) => f.off <= ON_AXLE_IN));
    // the ring and what overlaps it on the axle (its hub) are never a motor's
    const protect = new Set(ring.bodies);
    for (const [b, f] of onAxle) if (Math.min(f.hi, ring.hi) - Math.max(f.lo, ring.lo) >= 0.02) protect.add(b);
    const motors = axleMotors(onAxle, protect);
    for (const b of motorExclusions(pool, motors, ring.lo, ring.hi)) keep.delete(b);
    // WHAT ITS SHAFT CARRIES past the wheel: a sprocket, a gear, a pulley, a collar
    const motorParts = motorExclusions(onAxle, motors, ring.lo, ring.hi);
    const carried = shaftCarries(fits, keep, ring, R, (b) => taken.has(b) || motorParts.has(b));
    for (const b of carried) keep.add(b);
    // and the screws in them (what lies on the axle was judged above: a bearing's rings beside a
    // collar are not the collar's)
    const turning = carried.map((b) => fits.get(b)!);
    for (const b of insideRotors(parts, st, turning, centre, axis, (x) => keep.has(x) || taken.has(x) || motorParts.has(x) || onAxle.has(x))) keep.add(b);
  }
  return [...keep].sort((a, b) => a - b);
}

/** a part GRIPS a shaft when its bore comes within this of the shaft's own radius, inches */
const GRIP_IN = 0.01;
/** how far along its shaft past the wheel a carried part may be, inches */
const SHAFT_CARRY_IN = 4;
/** a carried part is smaller than the wheel (under this share of its radius) and bigger than a
 *  bearing, a washer or a screw head (`CARRY_R_MIN_IN`: an 8 mm bearing's outer race is 0.30 in from
 *  the axle, goBILDA's collar 0.48, AndyMark's pulley 0.47, goBILDA's 6WD pinion 0.52) */
const CARRY_R_SHARE = 0.85;
const CARRY_R_MIN_IN = 0.4;

/**
 * WHAT A WHEEL'S SHAFT CARRIES past the wheel's own width (2026-10-04, owner: "gears for drivetrain"
 * are not found): on goBILDA's 6WD BIOBUZZ bot the gear the motor drives and the chain sprocket sit
 * 0.5 to 1.4 in inboard of each wheel, across the frame from it, and stood still while it turned;
 * AndyMark's wheels carry their belt pulleys the same way, goBILDA's mecanum its clamping collar. A
 * part ON THE AXLE that GRIPS a shaft of the wheel's (`keep`): its bore within `GRIP_IN` of the
 * shaft's radius, which only a bore shaped to the shaft does (goBILDA's 8 mm REX: the shaft 0.16 in,
 * a gear's and a sprocket's bore 0.14, a bearing's outer race 0.19; AndyMark's 3/8 hex: 0.22, its
 * pulley 0.19), round about the axle or a hub (`HUB_R_IN`: a split collar's halves and their screws),
 * `CARRY_R_MIN_IN` to `CARRY_R_SHARE` of the wheel, within `SHAFT_CARRY_IN` of it, no motor's, and in
 * no HOUSING: a bigger round part around it that is not turning (REV's UltraPlanetary output stage
 * grips the wheel's hex shaft inside its cartridges, and its motor is not found where its encoder sits
 * behind a gap). A bearing's outer race, a pillow block and the frame clear the shaft and stay.
 */
function shaftCarries(fits: ReadonlyMap<number, AxleFit>, keep: ReadonlySet<number>, ring: { lo: number; hi: number }, R: number, skip: (b: number) => boolean): number[] {
  const shafts = [...keep].map((b) => fits.get(b)).filter((f): f is AxleFit => !!f && f.off <= ON_AXLE_IN && f.rMax <= SHAFT_R_IN && f.hi - f.lo >= 0.3);
  if (!shafts.length) return [];
  const onAxle = [...fits].filter(([, f]) => f.off <= ON_AXLE_IN);
  const out: number[] = [];
  for (const [b, f] of onAxle) {
    if (keep.has(b) || skip(b) || f.rMax < CARRY_R_MIN_IN || f.rMax > CARRY_R_SHARE * R) continue;
    if (f.lo > ring.hi + SHAFT_CARRY_IN || f.hi < ring.lo - SHAFT_CARRY_IN) continue;
    if (!shafts.some((s) => f.lo <= s.hi + 0.05 && f.hi >= s.lo - 0.05 && f.rMin <= s.rMax + GRIP_IN)) continue;
    if (!roundAboutAxle(f) && f.rMax > HUB_R_IN) continue;
    const housed = onAxle.some(([h, hf]) => h !== b && !keep.has(h) && hf.rMax > f.rMax + 0.05 && hf.rMin >= f.rMax - 0.05 && Math.min(hf.hi, f.hi) - Math.max(hf.lo, f.lo) >= 0.05 && roundAboutAxle(hf));
    if (!housed) out.push(b);
  }
  return out;
}

// ---- gears that mesh with a wheel's --------------------------------------------------------------

/** a gear is at least this big from its axle, inches (goBILDA's 6WD pinion: 0.52) */
const GEAR_R_MIN_IN = 0.3;
/**
 * TWO GEARS MESH when their outer circles cross by a tooth's depth (twice the addendum): two solids
 * in one plane cannot overlap, teeth can. Measured: goBILDA's 6WD pinion and wheel gear 0.09 in
 * (0.52 + 0.51 in on 0.94 in centres), AndyMark's 40T 20DP pair 0.10 (1.05 + 1.05 on 2.00: 20DP's
 * addendum is 0.05 in). At most `MESH_DEPTH_IN` and `MESH_DEPTH_SHARE` of the smaller gear.
 */
const MESH_DEPTH_IN = 0.25;
const MESH_DEPTH_SHARE = 0.4;

/**
 * GEARS DRIVEN BY THE WHEELS (and gears they drive in turn, two deep: an idler train): for every gear
 * on a wheel group's axle (round about it, under 0.85 of its largest radius: the tyre meshes nothing)
 * each body not in `taken`, round about its own axle parallel to it, in its plane, meshing with it,
 * grown to its own axle (`spinAxle`, never a motor's part: the motor that drives the train stays).
 * Each is a `spin` group geared to its leader (`follows`), the ratio the pitch radii's (the outer
 * radius less half the crossing, the same module), negative: meshed gears turn opposite ways. Leaders
 * are indices into `motion`; the groups returned go after it in order (their own indices follow on).
 */
export function findDriveGears(parts: readonly MeshPart[], motion: readonly MotionGroup[], taken: ReadonlySet<number>): MotionGroup[] {
  const st = bodyStats(parts);
  const used = new Set(taken);
  const out: MotionGroup[] = [];
  const queue = motion.flatMap((g, gi) => (g.role === 'wheel' && g.bodies.length ? [{ gi, bodies: g.bodies, depth: 0 }] : []));
  while (queue.length) {
    const q = queue.shift()!;
    // its axle, from the bodies centred on it (a wheel's hundreds of rollers are not: reading their
    // vertices cost a mecanum bot 0.1 s)
    const hint = q.depth === 0 ? wheelAxisHint(parts, q.bodies) : undefined;
    const box = boxCentre(setMoments(st, q.bodies));
    const centred = hint
      ? q.bodies.filter((b) => {
          const d = sub([(st.min[3 * b] + st.max[3 * b]) / 2, (st.min[3 * b + 1] + st.max[3 * b + 1]) / 2, (st.min[3 * b + 2] + st.max[3 * b + 2]) / 2], box);
          const al = dot(d, hint);
          return Math.hypot(d[0] - hint[0] * al, d[1] - hint[1] * al, d[2] - hint[2] * al) <= ON_AXLE_IN;
        })
      : q.bodies;
    const fit = fitRound(parts, centred.length ? centred : q.bodies, hint);
    if (!fit) continue;
    const { axis, pivot } = fit;
    const fits = axleFits(parts, st, new Set(centred), pivot, axis);
    const top = Math.max(...[...fits.values()].map((f) => f.rMax));
    const gears = [...fits.values()].filter((f) => f.off <= ON_AXLE_IN && f.rMax >= GEAR_R_MIN_IN && roundAboutAxle(f) && (q.depth > 0 || f.rMax < 0.85 * top));
    // along a model axis a body's box says most of it: as wide both ways across the axle, and its
    // circle near this gear's (the vertex passes below are for the few that are)
    const k = axis.findIndex((v) => Math.abs(v) > 0.999);
    for (const gf of gears) {
      for (const b of st.ids) {
        if (used.has(b)) continue;
        const ext = Math.max(st.max[3 * b] - st.min[3 * b], st.max[3 * b + 1] - st.min[3 * b + 1], st.max[3 * b + 2] - st.min[3 * b + 2]);
        if (ext < 2 * GEAR_R_MIN_IN) continue;
        const d = sub([(st.min[3 * b] + st.max[3 * b]) / 2, (st.min[3 * b + 1] + st.max[3 * b + 1]) / 2, (st.min[3 * b + 2] + st.max[3 * b + 2]) / 2], pivot);
        const al = dot(d, axis);
        const rc = Math.hypot(d[0] - axis[0] * al, d[1] - axis[1] * al, d[2] - axis[2] * al);
        if (al < gf.lo - 0.5 || al > gf.hi + 0.5 || rc < 0.5 * gf.rMax || rc > gf.rMax + 3) continue;
        if (k >= 0) {
          const w = [0, 1, 2].filter((j) => j !== k).map((j) => (st.max[3 * b + j] - st.min[3 * b + j]) / 2);
          const cross = gf.rMax + Math.max(w[0], w[1]) - rc;
          if (w[0] < 0.8 * w[1] || w[1] < 0.8 * w[0] || cross < -0.2 || cross > 0.5) continue;
        }
        // round about an axle parallel to it (its own fit can lean: a gear's teeth tilt its moments
        // 10° on goBILDA's 6WD pinion)
        const own = fitRound(parts, [b], axis);
        if (!own) continue;
        const of = axleFits(parts, st, new Set([b]), own.pivot, axis).get(b)!;
        if (of.rMax < GEAR_R_MIN_IN || !roundAboutAxle(of)) continue;
        // in its plane, and the two circles cross by a tooth's depth (neither inside the other)
        const dv = sub(own.pivot, pivot);
        const shift = dot(dv, axis);
        if (Math.min(of.hi + shift, gf.hi) - Math.max(of.lo + shift, gf.lo) < 0.05) continue;
        const dist = Math.hypot(dv[0] - axis[0] * shift, dv[1] - axis[1] * shift, dv[2] - axis[2] * shift);
        const depth = gf.rMax + of.rMax - dist;
        if (dist <= Math.abs(gf.rMax - of.rMax) || depth <= 0.01 || depth > Math.min(MESH_DEPTH_IN, MESH_DEPTH_SHARE * Math.min(gf.rMax, of.rMax))) continue;
        // meshed, it is driven: a pinion 0.16 in off its gearbox face (goBILDA's 6WD) is not the motor's
        const g = spinAxle(parts, b, { axis, pivot: own.pivot }, true);
        if (g.motor) continue;
        const bodies = g.bodies.filter((x) => !used.has(x));
        if (!bodies.includes(b)) continue;
        for (const x of bodies) used.add(x);
        const ratio = -(gf.rMax - depth / 2) / (of.rMax - depth / 2);
        const gi = motion.length + out.length;
        out.push({ role: 'spin', bodies, follows: { group: q.gi, ratio: Math.round(ratio * 100) / 100 }, found: true });
        if (q.depth < 2) queue.push({ gi, bodies, depth: q.depth + 1 });
      }
    }
  }
  return out;
}

/**
 * A WHEEL'S RADIUS from the geometry at its floor contact `w`: the axle height (box centre) of the
 * round bodies standing on the floor there (a tyre, an omni's plate, a mecanum's side plate). The
 * drivetrain's wheel is what the player picked for the sim, often the default, and a 104 mm cylinder
 * on a 72 mm wheel takes in its frame (AndyMark's bot). `fallback` when nothing round stands there.
 */
function wheelRadiusAt(st: BodyStats, w: Vec2, axis: V3, fallback: number): { R: number; measured: boolean } {
  let best = 0;
  const tx = Math.abs(axis[1]);
  const ty = Math.abs(axis[0]);
  for (const b of st.ids) {
    const z0 = st.min[3 * b + 2];
    const z1 = st.max[3 * b + 2];
    if (z0 > 0.35 || z1 - z0 < 1 || z1 - z0 > 8) continue;
    // centred over the contact (a sheet that runs down to the floor there is not: AndyMark's hood)
    if (Math.hypot((st.min[3 * b] + st.max[3 * b]) / 2 - w.x, (st.min[3 * b + 1] + st.max[3 * b + 1]) / 2 - w.y) > 0.6) continue;
    const roll = tx * (st.max[3 * b] - st.min[3 * b]) + ty * (st.max[3 * b + 1] - st.min[3 * b + 1]);
    const wide = ty * (st.max[3 * b] - st.min[3 * b]) + tx * (st.max[3 * b + 1] - st.min[3 * b + 1]);
    if (roll < 0.8 * (z1 - z0) || roll > 1.8 * (z1 - z0) || wide > 2 * WHEEL_HALF_WIDTH_IN + 0.4) continue;
    best = Math.max(best, (z0 + z1) / 2);
  }
  return best >= 0.4 * fallback && best <= 2 * fallback ? { R: best, measured: true } : { R: fallback, measured: false };
}

/**
 * A WHEEL'S AXLE: level, along the model's y (square to its front), else along x when only that way
 * is something round standing at the contact (`wheelRadiusAt`). A model whose CAD front is not the
 * robot's has its axles along x until the player turns it: Offset Robotics' concept robot drives
 * along the CAD's left, its front is assumed, and read along y its wheels took in the motors' gearboxes
 * beside them. Along x its mecanum's side plates stand there (2.83 in tall, 0.30 thick).
 */
/** how many wheel contacts have something round standing there about x only, and about y only */
export function wheelAxleVotes(parts: readonly MeshPart[], wheels: readonly Vec2[]): { x: number; y: number } {
  const st = bodyStats(parts);
  let x = 0;
  let y = 0;
  for (const w of wheels) {
    const ay = wheelRadiusAt(st, w, [0, 1, 0], 2).measured;
    const ax = wheelRadiusAt(st, w, [1, 0, 0], 2).measured;
    if (ax && !ay) x++;
    else if (ay && !ax) y++;
  }
  return { x, y };
}

function wheelAxleAt(st: BodyStats, w: Vec2, fallback: number): V3 {
  if (wheelRadiusAt(st, w, [0, 1, 0], fallback).measured) return [0, 1, 0];
  return wheelRadiusAt(st, w, [1, 0, 0], fallback).measured ? [1, 0, 0] : [0, 1, 0];
}

/** how far past its radius a wheel's parts may reach, inches: its own axle height measured, a tyre's
 *  bulge and the mesh's chords; or the drivetrain's catalogue wheel, which may be the wrong one */
const WHEEL_SLACK_IN = { measured: 0.2, catalogue: 0.35 } as const;

/**
 * THE DRIVE WHEELS: for each wheel contact (MODEL frame, FL FR BL BR), the bodies of the wheel there
 * (`wheelBodies`; its axle square to the robot, radial for an X-drive, at its own radius above the
 * floor, `wheelRadiusAt`). A corner with nothing there is left out. Then any MORE wheels on a side
 * (a 6WD's middle pair, goBILDA's BIOBUZZ bot): a round wheel-sized body standing on the floor on the
 * side's line between its front and back wheels, found the same way, with no corner (it turns at its
 * own place's speed).
 */
export function findWheelGroups(parts: readonly MeshPart[], wheels: readonly Vec2[], drivetrain: DrivetrainType, wheelDiaIn: number): MotionGroup[] {
  const st = bodyStats(parts);
  const R0 = Number.isFinite(wheelDiaIn) && wheelDiaIn > 0.5 ? wheelDiaIn / 2 : 2;
  const cx = wheels.reduce((s, w) => s + w.x, 0) / Math.max(1, wheels.length);
  const cy = wheels.reduce((s, w) => s + w.y, 0) / Math.max(1, wheels.length);
  const taken = new Set<number>();
  const out: MotionGroup[] = [];
  const radii: number[] = [];
  let square = true;
  wheels.forEach((w, corner) => {
    const axis: V3 = drivetrain === 'xdrive' ? norm([w.x - cx, w.y - cy, 0]) : wheelAxleAt(st, w, R0);
    if (axis[1] !== 1) square = false;
    const { R, measured } = wheelRadiusAt(st, w, axis, R0);
    radii[corner] = R;
    const bodies = wheelBodies(parts, st, [w.x, w.y, R], axis, R, taken, measured ? WHEEL_SLACK_IN.measured : WHEEL_SLACK_IN.catalogue);
    if (!bodies.length) return;
    for (const b of bodies) taken.add(b);
    out.push({ role: 'wheel', bodies, corner, found: true });
  });
  if (wheels.length !== 4 || drivetrain === 'xdrive' || drivetrain === 'swerve' || !square) return out;
  for (const [f, k] of [
    [0, 2],
    [1, 3],
  ]) {
    const side = (wheels[f].y + wheels[k].y) / 2;
    const R = (radii[f] + radii[k]) / 2;
    const xLo = Math.min(wheels[f].x, wheels[k].x) + R;
    const xHi = Math.max(wheels[f].x, wheels[k].x) - R;
    const cands = st.ids
      .filter((b) => {
        if (taken.has(b)) return false;
        const z0 = st.min[3 * b + 2];
        const zx = st.max[3 * b + 2] - z0;
        const xx = st.max[3 * b] - st.min[3 * b];
        const yc = (st.min[3 * b + 1] + st.max[3 * b + 1]) / 2;
        const xc = (st.min[3 * b] + st.max[3 * b]) / 2;
        return z0 <= 0.35 && zx >= 1.2 * R && zx <= 2.6 * R && xx >= 0.8 * zx && xx <= 1.25 * zx && Math.abs(yc - side) <= 1 && st.max[3 * b + 1] - st.min[3 * b + 1] <= 2 * WHEEL_HALF_WIDTH_IN && xc >= xLo && xc <= xHi;
      })
      .sort((a, b) => st.max[3 * b + 2] - st.min[3 * b + 2] - (st.max[3 * a + 2] - st.min[3 * a + 2]) || a - b);
    for (const b of cands) {
      if (taken.has(b)) continue;
      const r = (st.min[3 * b + 2] + st.max[3 * b + 2]) / 2;
      const c: V3 = [(st.min[3 * b] + st.max[3 * b]) / 2, (st.min[3 * b + 1] + st.max[3 * b + 1]) / 2, r];
      const bodies = wheelBodies(parts, st, c, [0, 1, 0], r, taken, WHEEL_SLACK_IN.measured);
      if (!bodies.includes(b)) continue;
      for (const x of bodies) taken.add(x);
      out.push({ role: 'wheel', bodies, found: true });
    }
  }
  return out;
}

// ---- the intake rollers, from the intake spans ----------------------------------------------------

/** how far in from the robot's edge an intake roller's axle may sit, inches */
const ROLLER_DEPTH_IN = 4;
/** an intake roller's axle is no higher than this, inches (a folded ramp's far roller is up near it) */
const ROLLER_TOP_IN = 10;
/** a roller group's radius, inches: under it is a bare shaft, over it is not a roller */
const ROLLER_R_MIN_IN = 0.35;
const ROLLER_R_MAX_IN = 2.5;
/** a body that seeds a roller is at least this far across its axle from it, inches (a 3/4-in roller;
 *  under it the nuts, washers and screw heads at a mouth, measured on goBILDA's kits) */
const ROLLER_SEED_R_IN = 0.375;
/** seeds are ranked by size to this, inches: the full mesh and the 250k one differ by a thou, and
 *  another seed on the same axle can see a hub piece just inside or just outside the axle's tolerance */
const SEED_STEP_IN = 0.05;
const seedSize = (r: number): number => Math.round(r / SEED_STEP_IN);
/** a roller bar this long along its axle needs no shaft of its own, inches */
const ROLLER_BAR_IN = 2;
/** two axles within 10° are one direction */
const AXLE_PARALLEL = Math.cos((10 * Math.PI) / 180);

/** `bodies` turn on a shaft (a thin body on the axle through `pivot`) or are a bar `ROLLER_BAR_IN` long */
function onShaft(parts: readonly MeshPart[], bodies: readonly number[], axis: V3, pivot: V3): boolean {
  const fits = axleFits(parts, bodyStats(parts), new Set(bodies), pivot, axis);
  let lo = Infinity;
  let hi = -Infinity;
  for (const f of fits.values()) {
    // a shaft, or the screw a servo-driven wheel is held on by (goBILDA's side rollers)
    if (f.off <= ON_AXLE_IN && f.rMax <= SHAFT_R_IN && f.hi - f.lo >= 0.3) return true;
    if (f.rMax > SHAFT_R_IN) {
      lo = Math.min(lo, f.lo);
      hi = Math.max(hi, f.hi);
    }
  }
  return hi - lo >= ROLLER_BAR_IN;
}

/**
 * THE INTAKE ROLLERS: on each intake span (`ImportedMech.intakes`, MODEL frame), every axle that runs
 * along the edge within `ROLLER_DEPTH_IN` of it, under `ROLLER_TOP_IN`, inside the span. An axle is
 * seeded by a ROUND body along the edge (its cross-section as wide one way as the other, and no
 * corner past the circle: a square tube fails, a hex shaft passes), then grown to everything on it
 * (`coaxialBodies`). Bodies in `taken` (the wheels) are never used. A suggestion: the player removes
 * what is not a roller.
 */
export function findRollerGroups(
  parts: readonly MeshPart[],
  intakes: readonly { edge: 'front' | 'back' | 'left' | 'right'; from: number; to: number }[],
  taken: ReadonlySet<number>,
): MotionGroup[] {
  const st = bodyStats(parts);
  if (!st.ids.length) return [];
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const b of st.ids) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], st.min[3 * b + k]);
      hi[k] = Math.max(hi[k], st.max[3 * b + k]);
    }
  }
  const used = new Set(taken);
  const out: MotionGroup[] = [];
  for (const span of intakes) {
    const along: 0 | 1 = span.edge === 'front' || span.edge === 'back' ? 1 : 0;
    const across = along === 1 ? 0 : 1;
    const outward = span.edge === 'front' || span.edge === 'left' ? 1 : -1;
    const edgeAt = outward > 0 ? hi[across] : lo[across];
    // two ways a roller stands at a mouth: its axle ALONG the edge (a sweeper, a roller bar), or
    // UPRIGHT (side rollers, which pull an element in from beside it). Each is judged round in the
    // plane square to its axle.
    const orients: { axis: V3; d1: number; d2: number }[] = [
      { axis: along === 1 ? [0, 1, 0] : [1, 0, 0], d1: across, d2: 2 },
      { axis: [0, 0, 1], d1: 0, d2: 1 },
    ];
    for (const o of orients) {
      // the axles found on this edge this way (a point on each), for the next stage in
      const lines: V3[] = [];
      // the candidates by their boxes: near the edge, low, within the span, round about the axle's
      // direction (equal spread across it)
      const cand = new Map<number, { c: number[]; h1: number; h2: number; r: number }>();
      for (const b of st.ids) {
        if (used.has(b)) continue;
        const c = [0, 1, 2].map((k) => (st.min[3 * b + k] + st.max[3 * b + k]) / 2);
        if ((edgeAt - c[across]) * outward > ROLLER_DEPTH_IN || c[2] > ROLLER_TOP_IN) continue;
        if (c[along] < Math.min(span.from, span.to) - 1 || c[along] > Math.max(span.from, span.to) + 1) continue;
        const h1 = (st.max[3 * b + o.d1] - st.min[3 * b + o.d1]) / 2;
        const h2 = (st.max[3 * b + o.d2] - st.min[3 * b + o.d2]) / 2;
        if (h1 < 0.05 || h2 < 0.05 || h1 / h2 < 0.85 || h1 / h2 > 1.18) continue;
        // a roller is something to grip with: a nut, a washer or a screw head is round too
        if (Math.max(h1, h2) < ROLLER_SEED_R_IN) continue;
        cand.set(b, { c, h1, h2, r: 0 });
      }
      // and no corner past the circle: ONE pass over the candidates' vertices
      eachVertex(parts, new Set(cand.keys()), (x, y, z, b) => {
        const k = cand.get(b)!;
        const p = [x, y, z];
        const d = Math.hypot(p[o.d1] - k.c[o.d1], p[o.d2] - k.c[o.d2]);
        if (d > k.r) k.r = d;
      });
      // the biggest first: a roller wheel seeds its axle before the hub on it does
      // (sizes to the nearest SEED_STEP_IN, so the same seed leads on any triangle count)
      const order = [...cand].sort((a, b) => seedSize(Math.max(b[1].h1, b[1].h2)) - seedSize(Math.max(a[1].h1, a[1].h2)) || a[0] - b[0]);
      for (const [b, k] of order) {
        if (used.has(b)) continue;
        if (k.r > 1.12 * Math.max(k.h1, k.h2)) continue;
        // its own axle is the orientation's (a square hub's box is round, its axle is anywhere), and it
        // has a thickness along it (a flat face drawn as a surface does not)
        const own = fitRound(parts, [b]);
        if (!own || Math.abs(dot(own.axis, o.axis)) < AXLE_PARALLEL) continue;
        if (Math.abs(o.axis[0]) * (st.max[3 * b] - st.min[3 * b]) + Math.abs(o.axis[1]) * (st.max[3 * b + 1] - st.min[3 * b + 1]) + Math.abs(o.axis[2]) * (st.max[3 * b + 2] - st.min[3 * b + 2]) < 0.1) continue;
        const g = rollerOn(parts, b, o.axis, taken, used);
        if (!g) continue;
        for (const x of g.bodies) used.add(x);
        lines.push(g.pivot);
        out.push({ role: 'roller', bodies: g.bodies, found: true });
      }
      // SPOKED AXLES (surgical tubing on hubs, Offset Robotics' concept robot): a star of spokes is a
      // roller however small its hub. Within `ROLLER_DEPTH_IN` of the edge it seeds one; deeper, it is
      // the intake's NEXT STAGE when its axle is within `ROLLER_STAGE_IN` of a roller found on this edge
      // (Offset's three run 1.9, 5.1 and 7.1 in in from its edge, 3.2 and 2.0 in apart; the six of its
      // transfer stand 8.5 in on, square to the edge, `findSpokedRollers`)
      const stars = spokeStars(parts, o.axis, used, (c) => c[2] <= ROLLER_TOP_IN && c[along] >= Math.min(span.from, span.to) - 1 && c[along] <= Math.max(span.from, span.to) + 1);
      const across2 = (p: V3, q: V3): number => {
        const d = sub(p, q);
        const al = dot(d, o.axis);
        return Math.hypot(d[0] - o.axis[0] * al, d[1] - o.axis[1] * al, d[2] - o.axis[2] * al);
      };
      for (let grew = true; grew; ) {
        grew = false;
        for (const star of stars) {
          if (star.spokes.some((x) => used.has(x))) continue;
          const depth = (edgeAt - star.pivot[across]) * outward;
          if (depth > ROLLER_DEPTH_IN && !lines.some((p) => across2(p, star.pivot) <= ROLLER_STAGE_IN)) continue;
          const hub = bodyOnLine(st, star.pivot, o.axis, used);
          if (hub < 0) continue;
          const g = rollerOn(parts, hub, o.axis, taken, used, { axis: o.axis, pivot: star.pivot });
          if (!g || !star.spokes.every((x) => g.bodies.includes(x))) continue;
          for (const x of g.bodies) used.add(x);
          lines.push(g.pivot);
          out.push({ role: 'roller', bodies: g.bodies, found: true });
          grew = true;
        }
      }
    }
  }
  return out;
}

/** a roller's next stage is within this of it, axle to axle, inches (an element handed on: BIOBUZZ's
 *  POLLEN is 2.8 in across) */
const ROLLER_STAGE_IN = 4;

/**
 * The roller on `seed`'s axle (`spinAxle`, or along `line`), its axle along `axis`: none when the seed
 * is a motor's part (its can, face and end cap are round and can sit at a mouth: goBILDA's BIOBUZZ
 * bots), when the axle carries a drive wheel (`taken`: goBILDA's DECODE bot's front axle), when it is
 * no roller's size (`ROLLER_R_MIN_IN`, `ROLLER_R_MAX_IN`) or turns on no shaft and is not a bar
 * (`onShaft`: goBILDA's round pattern mounts). Its bodies `used` does not hold, and its axle's point.
 */
function rollerOn(parts: readonly MeshPart[], seed: number, axis: V3, taken: ReadonlySet<number>, used: ReadonlySet<number>, line?: { axis: V3; pivot: V3 }): { bodies: number[]; pivot: V3 } | null {
  const g = spinAxle(parts, seed, line);
  if (g.motor || g.bodies.some((x) => taken.has(x))) return null;
  const bodies = g.bodies.filter((x) => !used.has(x));
  const whole = fitRound(parts, bodies, axis);
  if (!whole || whole.radius < ROLLER_R_MIN_IN || whole.radius > ROLLER_R_MAX_IN) return null;
  if (!onShaft(parts, bodies, whole.axis, whole.pivot)) return null;
  return { bodies, pivot: whole.pivot };
}

/**
 * EVERY OTHER SPOKED AXLE (`spokeStars` about the three model axes), among bodies `taken` does not
 * hold: rollers that are not at an intake edge, such as Offset Robotics' six-roller transfer column.
 * Surgical tubing in a star is a roller wherever it is; the intake's own are found first, on their
 * edge (`findRollerGroups`). Role `roller`: it turns while the intake runs.
 */
export function findSpokedRollers(parts: readonly MeshPart[], taken: ReadonlySet<number>): MotionGroup[] {
  const st = bodyStats(parts);
  const used = new Set(taken);
  const out: MotionGroup[] = [];
  for (const axis of [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ] as V3[]) {
    for (const star of spokeStars(parts, axis, used)) {
      if (star.spokes.some((x) => used.has(x))) continue;
      const hub = bodyOnLine(st, star.pivot, axis, used);
      if (hub < 0) continue;
      const g = rollerOn(parts, hub, axis, taken, used, { axis, pivot: star.pivot });
      if (!g || !star.spokes.every((x) => g.bodies.includes(x))) continue;
      for (const x of g.bodies) used.add(x);
      out.push({ role: 'roller', bodies: g.bodies, found: true });
    }
  }
  return out;
}

// ---- flywheels, a turret and a deployed ramp, from the placements ---------------------------------

/** a flywheel's centre is within this of the launcher's placed point, inches */
const FLYWHEEL_REACH_IN = 5;
/** a flywheel's radius, inches */
const FLYWHEEL_R_MIN_IN = 0.6;
const FLYWHEEL_R_MAX_IN = 2.6;

/** the bodies that could be a flywheel: a round DISC (thinner along its axle than across it) with a
 *  level axle and a flywheel's radius, centred where `where` allows; each with its radius and centre */
export function flywheelDiscs(parts: readonly MeshPart[], used: ReadonlySet<number>, where: (c: V3) => boolean): { b: number; r: number; c: V3 }[] {
  const st = bodyStats(parts);
  const cands: { b: number; r: number; c: V3 }[] = [];
  for (const b of st.ids) {
    if (used.has(b)) continue;
    const mo = setMoments(st, [b]);
    const c = boxCentre(mo);
    if (!where(c)) continue;
    const ext = [0, 1, 2].map((k) => mo.max[k] - mo.min[k]);
    const big = Math.max(...ext);
    if (big < 2 * FLYWHEEL_R_MIN_IN || big > 2 * FLYWHEEL_R_MAX_IN) continue;
    const fit = fitRound(parts, [b]);
    if (!fit || Math.abs(fit.axis[2]) > 0.3) continue; // a level axle
    // a disc: thinner along the axle than across, and round across it. The thickness is read along
    // the axle itself: off the box it took a disc's own diameter in when the axle is not along a model
    // axis (Offset's flywheel, on a turret turned 22°: 1.85 in "thick" at a 1.09 radius, 2026-10-04)
    const f = axleFits(parts, st, new Set([b]), fit.pivot, fit.axis).get(b)!;
    if (f.hi - f.lo > fit.radius * 1.2) continue;
    if (!roundAboutAxle(f) || fit.radius < FLYWHEEL_R_MIN_IN) continue;
    cands.push({ b, r: fit.radius, c });
  }
  return cands;
}

/**
 * THE FLYWHEELS: round DISCS (thinner along their axle than across) with a level axle, centred within
 * `FLYWHEEL_REACH_IN` of the launcher's placed point (`at`, MODEL frame: a fixed launcher's lip, a
 * turret's axis at its release height), each grown to its axle (`coaxialBodies`). The two largest
 * axles at most (a double wheel). Bodies in `taken` are never used. A suggestion.
 */
export function findFlywheelGroups(parts: readonly MeshPart[], at: V3, taken: ReadonlySet<number>): MotionGroup[] {
  const used = new Set(taken);
  const cands = flywheelDiscs(parts, used, (c) => Math.hypot(c[0] - at[0], c[1] - at[1], c[2] - at[2]) <= FLYWHEEL_REACH_IN);
  cands.sort((a, b) => seedSize(b.r) - seedSize(a.r) || a.b - b.b);
  const out: MotionGroup[] = [];
  for (const { b } of cands) {
    if (used.has(b) || out.length >= 2) continue;
    const g = spinAxle(parts, b);
    // a gearbox face or an end cap is a round disc too (2026-10-04, goBILDA's BIOBUZZ bots)
    if (g.motor) continue;
    const bodies = g.bodies.filter((x) => !used.has(x));
    for (const x of bodies) used.add(x);
    out.push({ role: 'flywheel', bodies, found: true });
  }
  return out;
}

/**
 * THE TURRET: the largest round body with an UPRIGHT axis, below the launcher's placed point (`at`), whose
 * own radius (or 1.5 in) reaches that point across its axis (a bearing ring, a lazy-susan
 * plate, 1.5 to 6 in across its radius), and everything standing on it: bodies whose box lies within
 * the ring's radius plus 3 in of that axis and starts no lower than the ring's own bottom. A
 * suggestion; null when no such ring is there.
 */
export function findTurretGroup(parts: readonly MeshPart[], at: V3, taken: ReadonlySet<number>): MotionGroup | null {
  return findTurret(parts, at, taken)?.group ?? null;
}

/** `findTurretGroup`, with the ring it found: its centre (on the turret's axis) and radius */
function findTurret(parts: readonly MeshPart[], at: V3, taken: ReadonlySet<number>): { group: MotionGroup; ring: { c: V3; r: number } } | null {
  const st = bodyStats(parts);
  let ring: { b: number; c: V3; r: number; z0: number } | null = null;
  for (const b of st.ids) {
    if (taken.has(b)) continue;
    const mo = setMoments(st, [b]);
    const c = boxCentre(mo);
    if (mo.max[2] > at[2]) continue;
    const wx = (mo.max[0] - mo.min[0]) / 2;
    const wy = (mo.max[1] - mo.min[1]) / 2;
    const h = mo.max[2] - mo.min[2];
    const r = Math.max(wx, wy);
    // the launcher stands on the ring, not always on its axis: Offset's flywheel is 2.1 in off its
    // 3.17-in turret gear's (2026-10-04)
    if (Math.hypot(c[0] - at[0], c[1] - at[1]) > Math.max(1.5, r)) continue;
    if (r < 1.5 || r > 6 || h > r || wx / Math.max(wy, 1e-9) < 0.85 || wx / Math.max(wy, 1e-9) > 1.18) continue;
    const f = axleFits(parts, st, new Set([b]), [c[0], c[1], 0], [0, 0, 1]).get(b)!;
    if (!roundAboutAxle(f)) continue;
    if (!ring || r > ring.r) ring = { b, c, r, z0: mo.min[2] };
  }
  if (!ring) return null;
  const reach = ring.r + 3;
  const bodies: number[] = [];
  for (const b of st.ids) {
    if (taken.has(b)) continue;
    if (st.min[3 * b + 2] < ring.z0 - 0.05) continue;
    let far = 0;
    for (const x of [st.min[3 * b], st.max[3 * b]]) for (const y of [st.min[3 * b + 1], st.max[3 * b + 1]]) far = Math.max(far, Math.hypot(x - ring.c[0], y - ring.c[1]));
    if (far > reach) continue;
    bodies.push(b);
  }
  return bodies.length ? { group: { role: 'turret', bodies: bodies.sort((a, b) => a - b), found: true }, ring: { c: ring.c, r: ring.r } } : null;
}

// ---- what the model is built with, before anything is placed ------------------------------------

/** a launcher's flywheel is centred at least this high, inches: an intake's rollers sit lower */
const LAUNCHER_MIN_Z_IN = 4;

/** the hood is read in bins this wide round the flywheel, degrees */
const HOOD_BIN_DEG = 3;
/** material is the hood where it stands this many element diameters off the wheel: one element,
 *  less what it is squeezed by, and no wider than a loose fit */
const HOOD_GAP_LO = 0.5;
const HOOD_GAP_HI = 1.15;
/** a hood wraps at least this much of the wheel, degrees */
const HOOD_MIN_DEG = 15;
/** bins with nothing in them a hood may skip (a perforated sheet) */
const HOOD_HOLE_BINS = 2;
/** past the squeeze the hood goes on while its surface steps by no more than this a bin, inches */
const HOOD_STEP_IN = 0.5;
/** an exit whose direction rises less than this (sine) is no launch */
const HOOD_MIN_RISE = 0.05;
/** edges are sampled this finely, inches */
const HOOD_SAMPLE_IN = 0.05;
/** the hood is looked for this many element diameters off the wheel (the starter bots release
 *  within 1.5) */
const HOOD_REACH = 2;

/** the shot a launcher's hood gives (`readShot`) */
export interface CadShot {
  /** the way the element leaves the hood, MODEL frame, unit, z up */
  dir: V3;
  /** degrees above level */
  elevDeg: number;
  /** the element's centre where it leaves the hood, MODEL frame */
  release: V3;
}

/**
 * THE SHOT, READ OFF THE HOOD (2026-10-04, owner: "Based on the flywheel, I think it should be able to
 * determine what type of shooter it is and where it is"). A flywheel throws an element along the
 * channel between it and its hood: material one element across off the wheel, less the squeeze
 * (`HOOD_GAP_LO`..`HOOD_GAP_HI` diameters). In a slice through the wheel's tread, square to its level
 * axle, the nearest material is found in `HOOD_BIN_DEG` bins round it; the longest run of bins at
 * the hood's distance is the hood, carried on past the squeeze while its surface runs on smoothly.
 * The element leaves at the run's HIGHER end, along the hood there, and that end must point up: a
 * hood is there to lift (the longest run that does; a turret's ring under the wheel is a flat run). goBILDA's BIOBUZZ bot: a straight sheet over the wheel, 1.9 in off it,
 * rising to the back at 35°. REV's DECODE bot: a hood wrapped one element out round the wheel's
 * underside, throwing forward over the top. Null when the axle is not level, the element size is
 * unknown, or no hood is found (AndyMark's bots, whose round part there is a gear).
 */
export function readShot(parts: readonly MeshPart[], disc: number, elementD: number): CadShot | null {
  if (!(elementD > 0)) return null;
  const fit = fitRound(parts, [disc]);
  if (!fit) return null;
  const a = norm(fit.axis);
  if (Math.abs(a[2]) > 0.3) return null;
  const c = fit.pivot;
  const R = fit.radius;
  const u = norm(cross(a, [0, 0, 1]));
  // the tread: the disc's box along the axle (exact for an axle along a model axis)
  const st = bodyStats(parts);
  const box = setMoments(st, [disc]);
  const s0 = dot(sub(boxCentre(box), c), a);
  const half = Math.max(0.15, (Math.abs(a[0]) * (box.max[0] - box.min[0]) + Math.abs(a[1]) * (box.max[1] - box.min[1]) + Math.abs(a[2]) * (box.max[2] - box.min[2])) / 2);
  // the wheel and what turns with it are not the hood
  const skip = new Set(spinAxle(parts, disc).bodies);
  skip.add(disc);
  const N = Math.round(360 / HOOD_BIN_DEG);
  const rmin = new Float64Array(N).fill(Infinity);
  const rLo = R + 0.15;
  const rHi = R + HOOD_REACH * elementD;
  // only bodies whose box comes within reach of the wheel are walked
  const near = new Uint8Array(st.n.length);
  const reach = rHi + half + Math.abs(s0);
  for (const b of st.ids) {
    let ok = !skip.has(b);
    for (let k = 0; k < 3 && ok; k++) ok = st.min[3 * b + k] <= c[k] + reach && st.max[3 * b + k] >= c[k] - reach;
    if (ok) near[b] = 1;
  }
  const binOf = (pu: number, pv: number): number => {
    let th = Math.atan2(pv, pu);
    if (th < 0) th += 2 * Math.PI;
    return Math.min(N - 1, Math.floor((th * 180) / Math.PI / HOOD_BIN_DEG));
  };
  const put = (pu: number, pv: number): void => {
    const r = Math.hypot(pu, pv);
    if (r < rLo || r > rHi) return;
    const k = binOf(pu, pv);
    if (r < rmin[k]) rmin[k] = r;
  };
  // a triangle clipped to the tread's slab, as (s, u, v) corners
  const clipS = (poly: V3[], keep: (q: V3) => number): V3[] => {
    const out: V3[] = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const dp = keep(p);
      const dq = keep(q);
      if (dp >= 0) out.push(p);
      if ((dp >= 0) !== (dq >= 0)) {
        const t = dp / (dp - dq);
        out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]), p[2] + t * (q[2] - p[2])]);
      }
    }
    return out;
  };
  // (s, u, v) of a triangle's corners: s along the axle from the tread's middle
  const Q = new Float64Array(9);
  for (const p of parts) {
    const P = p.positions;
    const idx = p.indices;
    const n = idx ? idx.length : P.length / 3;
    const B = p.body;
    for (let t = 0; t + 2 < n; t += 3) {
      const i0 = idx ? idx[t] : t;
      if (B && !near[B[i0]]) continue;
      let sLo = Infinity;
      let sHi = -Infinity;
      let uLo = Infinity;
      let uHi = -Infinity;
      let vLo = Infinity;
      let vHi = -Infinity;
      for (let k = 0; k < 3; k++) {
        const v = k === 0 ? i0 : idx ? idx[t + k] : t + k;
        const dx = P[3 * v] - c[0];
        const dy = P[3 * v + 1] - c[1];
        const dz = P[3 * v + 2] - c[2];
        const s = dx * a[0] + dy * a[1] + dz * a[2] - s0;
        const w = dx * u[0] + dy * u[1] + dz * u[2];
        Q[3 * k] = s;
        Q[3 * k + 1] = w;
        Q[3 * k + 2] = dz;
        sLo = Math.min(sLo, s);
        sHi = Math.max(sHi, s);
        uLo = Math.min(uLo, w);
        uHi = Math.max(uHi, w);
        vLo = Math.min(vLo, dz);
        vHi = Math.max(vHi, dz);
      }
      if (sLo > half || sHi < -half || uLo > rHi || uHi < -rHi || vLo > rHi || vHi < -rHi) continue;
      const q: V3[] = [
        [Q[0], Q[1], Q[2]],
        [Q[3], Q[4], Q[5]],
        [Q[6], Q[7], Q[8]],
      ];
      const cl = sLo >= -half && sHi <= half ? q : clipS(clipS(q, (x) => half - x[0]), (x) => x[0] + half);
      for (let i = 0; i < cl.length; i++) {
        const A = cl[i];
        const B = cl[(i + 1) % cl.length];
        const len = Math.hypot(B[1] - A[1], B[2] - A[2]);
        const steps = Math.max(1, Math.ceil(len / HOOD_SAMPLE_IN));
        for (let k = 0; k < steps; k++) put(A[1] + ((B[1] - A[1]) * k) / steps, A[2] + ((B[2] - A[2]) * k) / steps);
      }
    }
  }
  const hood = (k: number): boolean => rmin[k] - R >= HOOD_GAP_LO * elementD && rmin[k] - R <= HOOD_GAP_HI * elementD;
  // the runs of hood bins round the circle, skipping short holes; from a bin that is not hood
  let start = -1;
  for (let k = 0; k < N; k++) if (!hood(k)) start = k;
  if (start < 0) return null; // hood all round: no ends to read
  const runs: [number, number][] = [];
  let run: [number, number] | null = null;
  let miss = 0;
  for (let i = 1; i <= N; i++) {
    const k = (start + i) % N;
    if (hood(k)) {
      run = run ? [run[0], start + i] : [start + i, start + i];
      miss = 0;
    } else if (run && ++miss > HOOD_HOLE_BINS) {
      runs.push(run);
      run = null;
      miss = 0;
    }
  }
  if (run) runs.push(run);
  const at = (i: number): number => rmin[((i % N) + N) % N];
  // the longest run whose exit rises: a turret's ring or a deck under the wheel is a run too, a flat one
  runs.sort((p, q) => q[1] - q[0] - (p[1] - p[0]) || p[0] - q[0]);
  for (const r of runs) {
    if ((r[1] - r[0] + 1) * HOOD_BIN_DEG < HOOD_MIN_DEG) break;
    const shot = shotOff(r);
    if (shot) return shot;
  }
  return null;
  function shotOff(best: [number, number]): CadShot | null {
  // past the squeeze: on while the surface runs on smoothly
  const extend = (i: number, step: 1 | -1, stop: number): number => {
    let last = i;
    for (let j = i + step, holes = 0; Math.abs(j - stop) > 0 && Math.abs(j - i) < N / 2; j += step) {
      const r = at(j);
      if (!Number.isFinite(r)) {
        if (++holes > HOOD_HOLE_BINS) break;
        continue;
      }
      if (Math.abs(r - at(last)) > HOOD_STEP_IN * (Math.abs(j - last))) break;
      last = j;
      holes = 0;
    }
    return last;
  };
  const e0 = extend(best[0], -1, best[1] - N);
  const e1 = extend(best[1], 1, best[0] + N);
  const pt = (i: number): [number, number] => {
    const th = (((((i % N) + N) % N) + 0.5) * HOOD_BIN_DEG * Math.PI) / 180;
    return [at(i) * Math.cos(th), at(i) * Math.sin(th)];
  };
  // the direction off an end: from a finite bin a few in, out to the end
  const outward = (end: number, inward: 1 | -1): [number, number] | null => {
    const span = Math.max(1, Math.min(5, Math.floor((e1 - e0) / 3)));
    for (let k = span; k >= 1; k--) {
      const j = end + inward * k;
      if (!Number.isFinite(at(j))) continue;
      const [x0, y0] = pt(j);
      const [x1, y1] = pt(end);
      const l = Math.hypot(x1 - x0, y1 - y0);
      if (l > 1e-6) return [(x1 - x0) / l, (y1 - y0) / l];
    }
    return null;
  };
  const ends = [
    { p: pt(e0), d: outward(e0, 1) },
    { p: pt(e1), d: outward(e1, -1) },
  ];
  const exit = ends[0].p[1] > ends[1].p[1] ? ends[0] : ends[1];
  if (!exit.d || exit.d[1] < HOOD_MIN_RISE) return null;
  // the element's centre: half a diameter off the hood, toward the wheel
  let nx = -exit.d[1];
  let ny = exit.d[0];
  if (nx * -exit.p[0] + ny * -exit.p[1] < 0) {
    nx = -nx;
    ny = -ny;
  }
  const ru = exit.p[0] + (nx * elementD) / 2;
  const rv = exit.p[1] + (ny * elementD) / 2;
  const release: V3 = add(add(c, scale(a, s0)), add(scale(u, ru), [0, 0, rv]));
  const dir = norm(add(scale(u, exit.d[0]), [0, 0, exit.d[1]]));
  return { dir, elevDeg: (Math.atan2(exit.d[1], Math.abs(exit.d[0])) * 180) / Math.PI, release };
  }
}

/** what the model shows it is built with (`readBuild`) */
export interface CadBuild {
  /** the edge with the most intake rollers, and whether one of them stands upright (side rollers) */
  intake: { edge: 'front' | 'back' | 'left' | 'right'; upright: boolean } | null;
  /**
   * the launcher's largest flywheel (its centre, MODEL frame), whether a turret ring is under it and
   * where that ring's axis is (MODEL frame, at the ring), and the shot its hood gives (`readShot`)
   */
  launcher: { at: V3; turret: boolean; axis?: V3; shot?: CadShot } | null;
  /** the box tubes (`findBoxTubes`): the outer tubes' base, between them (MODEL frame), and how many */
  lift?: { base: V3; count: number } | null;
  /** the model's footprint box, MODEL frame: x0, y0, x1, y1 */
  box?: [number, number, number, number];
}

// ---- box tubes: telescoping slides ----------------------------------------------------------------

/** a box tube's stage is at least this long, inches */
const TUBE_MIN_LEN_IN = 6;
/** ...and no wider across than this, inches */
const TUBE_MAX_ACROSS_IN = 2.5;
/** ...and at least this many times as long as it is wide */
const TUBE_SLENDER = 4;
/** a stage's two sides across agree within this ratio (a square or round tube) */
const TUBE_SQUARE = 0.75;
/** a stage nests in the one round it: centres within this across, inches */
const TUBE_NEST_OFF_IN = 0.25;
/** ...each stage at least this much narrower than the last, inches, and no less than this share of
 *  it (a shaft in a tube is not a stage) */
const TUBE_NEST_STEP_IN = 0.15;
const TUBE_NEST_SHARE = 0.5;
/** ...and the two overlapping along the axis by at least this, inches */
const TUBE_NEST_OVERLAP_IN = 2;
/** a body inside a stage's box, grown by this, rides on it, inches */
const TUBE_RIDE_PAD_IN = 0.25;
/** ...and the box reaches this far past the stage's base end: its bottom insert stands below the tube
 *  (Offset's middle and final inserts, 2026-10-04), inches */
const TUBE_BASE_END_IN = 0.6;

/** one telescoping slide (`findBoxTubes`) */
export interface BoxTube {
  /** the model axis it runs along: 0 x, 1 y, 2 z */
  k: 0 | 1 | 2;
  /** the bodies of each stage, the fixed outer one first */
  stages: number[][];
  /** each stage's tube body, outer first */
  tubes: number[];
  /** the outer tube's base: the middle of its end nearer the floor (or, level, its inner end), MODEL frame */
  base: V3;
  /** how far each moving stage slides out of the one round it, inches (stage 1 first) */
  travel: number[];
}

/**
 * THE BOX TUBES: telescoping slides (2026-10-04, owner on Offset Robotics' concept robot: "boxtubes
 * (plural)" were not detected). A stage is a long, slender body, square or round across
 * (`TUBE_*`); stages NEST: each inside the one round it (centres together across, narrower by a step
 * but not a shaft's worth), both running along the same model axis and overlapping along it. A run
 * of two or more is a slide; its widest stage is fixed, the rest slide. Every other body whose box
 * lies inside a stage's (grown by `TUBE_RIDE_PAD_IN`, and `TUBE_BASE_END_IN` past its base end) rides on
 * the innermost such stage. Offset's
 * robot: two upright slides at its back corners, outer 1.57 in, middle 1.18, final 0.79 across.
 * Bodies in `taken` are left out.
 */
export function findBoxTubes(parts: readonly MeshPart[], taken: ReadonlySet<number>): BoxTube[] {
  const st = bodyStats(parts);
  const lo = (b: number, k: number): number => st.min[3 * b + k];
  const hi = (b: number, k: number): number => st.max[3 * b + k];
  const tubes: { b: number; k: 0 | 1 | 2; across: number; c: [number, number] }[] = [];
  for (const b of st.ids) {
    if (taken.has(b)) continue;
    const ext = [0, 1, 2].map((k) => hi(b, k) - lo(b, k));
    const k = ext.indexOf(Math.max(...ext)) as 0 | 1 | 2;
    const [i, j] = ([0, 1, 2] as const).filter((x) => x !== k);
    const a = Math.max(ext[i], ext[j]);
    if (ext[k] < TUBE_MIN_LEN_IN || a > TUBE_MAX_ACROSS_IN || ext[k] < TUBE_SLENDER * a || Math.min(ext[i], ext[j]) < TUBE_SQUARE * a) continue;
    tubes.push({ b, k, across: a, c: [(lo(b, i) + hi(b, i)) / 2, (lo(b, j) + hi(b, j)) / 2] });
  }
  // the widest first: each tube joins the nest of the narrowest tube it fits in
  tubes.sort((p, q) => q.across - p.across || p.b - q.b);
  const nests: (typeof tubes)[] = [];
  for (const t of tubes) {
    const home = nests.find((n) => {
      const o = n[n.length - 1];
      if (o.k !== t.k) return false;
      if (Math.hypot(o.c[0] - t.c[0], o.c[1] - t.c[1]) > TUBE_NEST_OFF_IN) return false;
      if (o.across - t.across < TUBE_NEST_STEP_IN || t.across < TUBE_NEST_SHARE * o.across) return false;
      return Math.min(hi(o.b, t.k), hi(t.b, t.k)) - Math.max(lo(o.b, t.k), lo(t.b, t.k)) >= TUBE_NEST_OVERLAP_IN;
    });
    if (home) home.push(t);
    else nests.push([t]);
  }
  const out: BoxTube[] = [];
  const all = nests.filter((n) => n.length >= 2);
  const inTube = new Set(all.flatMap((n) => n.map((t) => t.b)));
  const inside = (b: number, s: number, along: number): boolean => {
    for (let k = 0; k < 3; k++) if (lo(b, k) < lo(s, k) - (k === along ? TUBE_BASE_END_IN : TUBE_RIDE_PAD_IN) || hi(b, k) > hi(s, k) + TUBE_RIDE_PAD_IN) return false;
    return true;
  };
  const owned = new Set<number>();
  for (const n of all) {
    const k = n[0].k;
    const stages: number[][] = n.map((t) => [t.b]);
    for (const b of st.ids) {
      if (taken.has(b) || inTube.has(b) || owned.has(b)) continue;
      // the innermost stage whose box holds it
      for (let s = n.length - 1; s >= 0; s--) {
        if (!inside(b, n[s].b, s > 0 ? k : -1)) continue;
        stages[s].push(b);
        owned.add(b);
        break;
      }
    }
    for (const s of stages) s.sort((a, b) => a - b);
    const outer = n[0].b;
    const [i, j] = ([0, 1, 2] as const).filter((x) => x !== k);
    const base: V3 = [0, 0, 0];
    base[i] = (lo(outer, i) + hi(outer, i)) / 2;
    base[j] = (lo(outer, j) + hi(outer, j)) / 2;
    base[k] = lo(outer, k);
    // each moving stage slides out of the one round it by its own length less what stays inside
    const travel = n.slice(1).map((t, s) => Math.max(0, Math.min(hi(t.b, k) - lo(t.b, k), hi(n[s].b, k) - lo(n[s].b, k)) - TUBE_NEST_OVERLAP_IN));
    out.push({ k, stages, tubes: n.map((t) => t.b), base, travel });
  }
  return out;
}

/**
 * A box tube's moving stages as slide groups, numbered from `first` (their index in the setup's
 * motion): each driven by placing (`place`) along the tube's axis, the first stage of the first tube
 * leading and every other stage following it, a stage `s` out by `s` times as far (a cascade: every
 * stage slides its own travel out of the last). The fixed outer stages are not moving parts.
 */
export function boxTubeGroups(tubes: readonly BoxTube[], first: number): MotionGroup[] {
  const out: MotionGroup[] = [];
  if (!tubes.length) return out;
  const lead = first;
  for (const t of tubes) {
    for (let s = 1; s < t.stages.length; s++) {
      const g: MotionGroup = { role: 'slide', bodies: t.stages[s], axis: 'part', axisBody: t.tubes[s], found: true };
      if (out.length === 0) {
        g.drive = 'place';
        g.amount = Math.round(Math.min(...t.travel) * 4) / 4;
      } else g.follows = { group: lead, ratio: s };
      out.push(g);
    }
  }
  return out;
}

/**
 * WHAT THE MODEL IS BUILT WITH, read before anything is placed (2026-10-04, owner on goBILDA's BIOBUZZ
 * mecanum bot: "side rollers are not selected by default, single static shooter is not selected by
 * default, offset boxtube is selected even though I dont have it"). An import started from the
 * player's current robot, so its mechanisms, and the placements every finder searches from, were
 * that robot's. Here the rollers are looked for along all four edges (`findRollerGroups`, wheels in
 * `taken` left out) and the edge with the most is the intake's; one standing upright makes them side
 * rollers. The launcher is the largest flywheel disc (`flywheelDiscs`) centred above
 * `LAUNCHER_MIN_Z_IN` that is not a motor's part, a turret is a ring under it (`findTurretGroup`), and
 * the shot is read off its hood (`readShot`, given the element's diameter, `elementD`). Null where
 * nothing is there.
 */
export function readBuild(parts: readonly MeshPart[], taken: ReadonlySet<number>, elementD = 0): CadBuild {
  const used = new Set(taken);
  let intake: CadBuild['intake'] = null;
  let most = 0;
  for (const edge of ['front', 'back', 'left', 'right'] as const) {
    const groups = findRollerGroups(parts, [{ edge, from: -1e3, to: 1e3 }], used);
    let upright = false;
    for (const g of groups) {
      for (const b of g.bodies) used.add(b);
      const f = fitRound(parts, g.bodies);
      if (f && Math.abs(f.axis[2]) > AXLE_PARALLEL) upright = true;
    }
    if (groups.length > most) {
      most = groups.length;
      intake = { edge, upright };
    }
  }
  let launcher: CadBuild['launcher'] = null;
  const discs = flywheelDiscs(parts, used, (c) => c[2] >= LAUNCHER_MIN_Z_IN).sort((a, b) => seedSize(b.r) - seedSize(a.r) || a.b - b.b);
  for (const d of discs) {
    if (spinAxle(parts, d.b).motor) continue;
    const turret = findTurret(parts, d.c, used);
    const shot = readShot(parts, d.b, elementD);
    launcher = { at: d.c, turret: !!turret, ...(turret ? { axis: turret.ring.c } : {}), ...(shot ? { shot } : {}) };
    break;
  }
  const tubes = findBoxTubes(parts, taken);
  const lift = tubes.length
    ? { base: scale(tubes.reduce((s, t) => add(s, t.base), [0, 0, 0] as V3), 1 / tubes.length), count: tubes.length }
    : null;
  // the footprint the lift's cell is read in: the 2nd to 98th percentile of the bodies' centres, so a
  // stray part off the robot (Offset's floating cube) does not move it
  const st = bodyStats(parts);
  const cx = st.ids.map((b) => (st.min[3 * b] + st.max[3 * b]) / 2).sort((a, b) => a - b);
  const cy = st.ids.map((b) => (st.min[3 * b + 1] + st.max[3 * b + 1]) / 2).sort((a, b) => a - b);
  const pc = (a: number[], f: number): number => (a.length ? a[Math.min(a.length - 1, Math.floor(f * a.length))] : 0);
  return { intake, launcher, lift, box: [pc(cx, 0.02), pc(cy, 0.02), pc(cx, 0.98), pc(cy, 0.98)] };
}

/**
 * A RAMP (or any part) THE FILE SHOWS DEPLOYED, from an intake edge: when the model runs past 18 in
 * outward from its far edge, every body whose box reaches past that line, and the smaller ones mounted
 * on them (`mountedBodies`). The owner's case: a robot imported with its ramp down "says it is too
 * big". `role` is `ramp` on a build with BIOBUZZ's ramp intake, else `fold`. Null when the model fits.
 */
export function findDeployedGroup(
  parts: readonly MeshPart[],
  intakes: readonly { edge: 'front' | 'back' | 'left' | 'right' }[],
  role: 'ramp' | 'fold',
  taken: ReadonlySet<number>,
  maxIn = 18,
): MotionGroup | null {
  const st = bodyStats(parts);
  if (!st.ids.length) return null;
  const lo = [Infinity, Infinity];
  const hi = [-Infinity, -Infinity];
  for (const b of st.ids) for (let k = 0; k < 2; k++) {
    lo[k] = Math.min(lo[k], st.min[3 * b + k]);
    hi[k] = Math.max(hi[k], st.max[3 * b + k]);
  }
  for (const { edge } of intakes) {
    const k = edge === 'front' || edge === 'back' ? 0 : 1;
    const outward = edge === 'front' || edge === 'left' ? 1 : -1;
    if (hi[k] - lo[k] <= maxIn + 0.05) continue;
    const line = outward > 0 ? lo[k] + maxIn : hi[k] - maxIn;
    const past = st.ids.filter((b) => !taken.has(b) && (outward > 0 ? st.max[3 * b + k] > line : st.min[3 * b + k] < line));
    if (!past.length) continue;
    const bodies = new Set(past);
    for (const b of past) for (const x of mountedBodies(parts, b)) if (!taken.has(x)) bodies.add(x);
    return { role, bodies: [...bodies].sort((a, b) => a - b), found: true };
  }
  return null;
}

// ---- folding: a ramp the file shows deployed ------------------------------------------------------

/**
 * How one hinged part is folded for the starting configuration, in the frame it was planned in (the
 * measurement's ROTATED frame: inches, +x front, +z up, not yet centred).
 */
export interface FoldPlan {
  /** index into the setup's `motion` */
  group: number;
  /** every body the fold turns: the part's own and those of the spinning parts riding on it */
  bodies: number[];
  /** the spinning groups that ride on it */
  riders: number[];
  hinge: V3;
  /** the hinge's direction: a POSITIVE turn about it swings the part out and down (deploys it) */
  axis: V3;
  /** radians, file pose → starting pose (≤ 0: folding is a turn up) */
  angle: number;
  /** radians, starting pose → deployed (≥ 0) */
  deploy: number;
}

/** how far past a hinged part's innermost point the hinge's height is read from, inches */
const HINGE_BAND_IN = 0.75;
/** a spinning part whose centre is within this of a hinged part's box rides on it, inches */
const RIDE_PAD_IN = 0.75;

/**
 * THE FOLD of every hinged group (`ramp`, `fold`) in `motion`, planned on `parts` (rotated frame).
 *
 *  · OUTWARD is the horizontal model axis along which the part sits furthest from the rest of the
 *    robot (a front ramp: +x). The HINGE runs square to it and level (along the edge), through the
 *    part's innermost point, at the mean height of the part within `HINGE_BAND_IN` of that point.
 *  · A part the file shows DEPLOYED folds up about it until its farthest point stands straight above
 *    the hinge (or by `foldDeg`), and deploys back to the file's pose; one the file shows FOLDED stays,
 *    and deploys by `deployDeg`.
 *  · A spinning part whose centre is inside the hinged part's box rides on it: a roller on a ramp folds
 *    with the ramp.
 */
export function planFolds(parts: readonly MeshPart[], motion: readonly MotionGroup[]): FoldPlan[] {
  const st = bodyStats(parts);
  const hinged = new Set<number>();
  motion.forEach((g) => {
    if (isHinge(g.role)) for (const b of g.bodies) hinged.add(b);
  });
  const rest = st.ids.filter((b) => !hinged.has(b));
  const restC = setMoments(st, rest).c;
  const plans: FoldPlan[] = [];
  motion.forEach((g, gi) => {
    if (!isHinge(g.role) || !g.bodies.length) return;
    const mo = setMoments(st, g.bodies);
    if (mo.n < 3) return;
    const d = sub(mo.c, restC);
    const u: V3 = Math.abs(d[0]) >= Math.abs(d[1]) ? [Math.sign(d[0]) || 1, 0, 0] : [0, Math.sign(d[1]) || 1, 0];
    const axis: V3 = [-u[1], u[0], 0]; // ẑ × u: a positive turn takes u toward −ẑ
    // riders: spinning groups whose centre is inside this part's box
    const riders: number[] = [];
    const bodies = [...g.bodies];
    motion.forEach((o, oi) => {
      if (oi === gi || !isSpin(o.role) || !o.bodies.length) return;
      const c = boxCentre(setMoments(st, o.bodies));
      const inside = [0, 1, 2].every((k) => c[k] >= mo.min[k] - RIDE_PAD_IN && c[k] <= mo.max[k] + RIDE_PAD_IN);
      if (inside) {
        riders.push(oi);
        bodies.push(...o.bodies);
      }
    });
    // the hinge. Deployed: at the part's innermost point along u, at the height of what is there.
    // Folded (standing up): at its foot, where the lowest band of it is.
    const own = new Set(g.bodies);
    const folded = g.filePose === 'folded';
    let sMin = Infinity;
    let zMin = Infinity;
    eachVertex(parts, own, (x, y, z) => {
      const s = x * u[0] + y * u[1];
      if (s < sMin) sMin = s;
      if (z < zMin) zMin = z;
    });
    let sSum = 0;
    let zSum = 0;
    let n = 0;
    eachVertex(parts, own, (x, y, z) => {
      const s = x * u[0] + y * u[1];
      if (folded ? z <= zMin + HINGE_BAND_IN : s <= sMin + HINGE_BAND_IN) {
        sSum += s;
        zSum += z;
        n++;
      }
    });
    const lateral = sub(mo.c, scale(u, dot(mo.c, u)));
    const sHinge = folded && n ? sSum / n : sMin;
    const hinge: V3 = [lateral[0] + u[0] * sHinge, lateral[1] + u[1] * sHinge, n ? zSum / n : mo.min[2]];
    // the lever: from the hinge to the part's farthest point, in the vertical plane through u
    let far = -1;
    let phi = 0;
    eachVertex(parts, own, (x, y, z) => {
      const du = (x - hinge[0]) * u[0] + (y - hinge[1]) * u[1];
      const dz = z - hinge[2];
      const r2 = du * du + dz * dz;
      if (r2 > far) {
        far = r2;
        phi = Math.atan2(dz, du);
      }
    });
    let angle = 0;
    let deploy = 0;
    const rad = Math.PI / 180;
    if ((g.filePose ?? 'deployed') === 'deployed') {
      if (g.foldDeg !== undefined && Number.isFinite(g.foldDeg)) angle = -Math.max(0, Math.min(180, g.foldDeg)) * rad;
      else if (phi < Math.PI / 2 - 2 * rad) angle = phi - Math.PI / 2;
      deploy = -angle;
    }
    if (deploy < 1e-3) {
      // the file is the starting pose: it deploys by the player's angle, else a quarter turn
      angle = 0;
      const dd = g.deployDeg !== undefined && Number.isFinite(g.deployDeg) ? g.deployDeg : DEFAULT_DEPLOY_DEG;
      deploy = Math.max(0, Math.min(180, dd)) * rad;
    }
    plans.push({ group: gi, bodies: bodies.sort((a, b) => a - b), riders, hinge, axis, angle, deploy });
  });
  return plans;
}

/** turn `p` about the line (`o`, unit `k`) by `c = cos θ`, `s = sin θ` (Rodrigues) */
function turn(p: V3, o: V3, k: V3, c: number, s: number): V3 {
  const v = sub(p, o);
  const kv = dot(k, v);
  const kxv = cross(k, v);
  return [
    o[0] + v[0] * c + kxv[0] * s + k[0] * kv * (1 - c),
    o[1] + v[1] * c + kxv[1] * s + k[1] * kv * (1 - c),
    o[2] + v[2] * c + kxv[2] * s + k[2] * kv * (1 - c),
  ];
}

/**
 * Apply `plans` to `parts` IN PLACE (positions, and normals when there are): each fold turns its
 * bodies about its hinge by its `angle`. The measurement does it in the rotated frame before it
 * centres the model, and `toModelFrame` does the same at the same step, so both get the same floats.
 */
export function applyFolds(parts: readonly MeshPart[], plans: readonly FoldPlan[]): void {
  if (!plans.length) return;
  const of = new Map<number, { plan: FoldPlan; c: number; s: number }>();
  for (const plan of plans) {
    if (Math.abs(plan.angle) < 1e-12) continue;
    const e = { plan, c: Math.cos(plan.angle), s: Math.sin(plan.angle) };
    for (const b of plan.bodies) of.set(b, e);
  }
  if (!of.size) return;
  for (const p of parts) {
    if (!p.body) continue;
    const a = p.positions;
    const nrm = p.normals ?? null;
    for (let v = 0; v < p.body.length; v++) {
      const e = of.get(p.body[v]);
      if (!e) continue;
      const q = turn([a[3 * v], a[3 * v + 1], a[3 * v + 2]], e.plan.hinge, e.plan.axis, e.c, e.s);
      a[3 * v] = q[0];
      a[3 * v + 1] = q[1];
      a[3 * v + 2] = q[2];
      if (nrm) {
        const n = turn([nrm[3 * v], nrm[3 * v + 1], nrm[3 * v + 2]], [0, 0, 0], e.plan.axis, e.c, e.s);
        nrm[3 * v] = n[0];
        nrm[3 * v + 1] = n[1];
        nrm[3 * v + 2] = n[2];
      }
    }
  }
}

/**
 * The setup's moving parts as the STORED MESH has them. It is baked in the starting pose, so a hinged
 * part the file showed deployed is folded in it: saved as `filePose: 'folded'`, deploying by what
 * was measured, so reopening the saved robot does not fold it a second time.
 */
export function motionAsStored(motion: readonly MotionGroup[] | undefined, measured: readonly MotionPart[] | undefined): MotionGroup[] | undefined {
  if (!motion) return undefined;
  return motion.map((g, gi) => {
    if (!isHinge(g.role) || g.filePose === 'folded') return g;
    const p = measured?.find((q) => q.group === gi);
    const { foldDeg: _fold, ...rest } = g;
    void _fold;
    return { ...rest, filePose: 'folded', deployDeg: p ? Math.round((p.deploy * 180) / Math.PI) : DEFAULT_DEPLOY_DEG };
  });
}

/** how far past a picked body's box a smaller body still counts as mounted on it, inches */
const MOUNT_PAD_IN = 0.4;

/**
 * `seed` and the bodies MOUNTED ON it: every smaller body whose box lies inside the seed's, padded by
 * `MOUNT_PAD_IN` (a plate's screws, standoffs and brackets). A click on a ramp's side plate takes its
 * hardware with it.
 */
export function mountedBodies(parts: readonly MeshPart[], seed: number): number[] {
  const st = bodyStats(parts);
  if (seed >= st.n.length || !st.n[seed]) return [seed];
  const lo = [0, 1, 2].map((k) => st.min[3 * seed + k] - MOUNT_PAD_IN);
  const hi = [0, 1, 2].map((k) => st.max[3 * seed + k] + MOUNT_PAD_IN);
  const ext = (b: number): number => Math.max(st.max[3 * b] - st.min[3 * b], st.max[3 * b + 1] - st.min[3 * b + 1], st.max[3 * b + 2] - st.min[3 * b + 2]);
  const own = ext(seed);
  const out = [seed];
  for (const b of st.ids) {
    if (b === seed || ext(b) >= own) continue;
    if ([0, 1, 2].every((k) => st.min[3 * b + k] >= lo[k] && st.max[3 * b + k] <= hi[k])) out.push(b);
  }
  return out.sort((a, b) => a - b);
}

/** the setup keys a fold depends on: what `orientKey` adds so a new fold re-measures */
export function foldKey(motion: readonly MotionGroup[] | undefined): string {
  if (!motion || !motion.some((g) => isHinge(g.role) && g.bodies.length)) return '';
  return JSON.stringify(
    motion.map((g) => (isHinge(g.role) ? [g.role, g.bodies, g.filePose ?? 'deployed', g.foldDeg ?? null, g.deployDeg ?? null] : isSpin(g.role) ? [g.bodies] : [])),
  );
}

// ---- what the measurement reports ----------------------------------------------------------------

/**
 * The moving parts as measured (`MotionPart`): MODEL frame, STARTING pose (`modelParts` is already
 * folded), each with its axis turned so a positive turn is its role's own sense. `plans` are the
 * folds `orientParts` made (rotated frame) and `t` that frame's shift to the model frame.
 */
export function deriveMotion(modelParts: readonly MeshPart[], motion: readonly MotionGroup[], plans: readonly FoldPlan[], t: V3): MotionPart[] {
  const st = bodyStats(modelParts);
  const out: MotionPart[] = [];
  const index = new Map<number, number>(); // setup index → output index
  const rideOn = new Map<number, number>(); // setup index → carrier setup index
  // a part the player put on another (an arm on a slide) rides it, whatever the geometry says
  motion.forEach((g, gi) => {
    if (g.rideOn !== undefined && Number.isInteger(g.rideOn) && g.rideOn !== gi && motion[g.rideOn]?.bodies.length) rideOn.set(gi, g.rideOn);
  });
  for (const p of plans) for (const r of p.riders) if (!rideOn.has(r)) rideOn.set(r, p.group);
  // turrets carry what is inside them (a flywheel on a turret)
  motion.forEach((g, gi) => {
    if (g.role !== 'turret' || !g.bodies.length) return;
    const mo = setMoments(st, g.bodies);
    motion.forEach((o, oi) => {
      if (oi === gi || !isSpin(o.role) || rideOn.has(oi) || !o.bodies.length) return;
      const c = boxCentre(setMoments(st, o.bodies));
      if ([0, 1, 2].every((k) => c[k] >= mo.min[k] - 0.5 && c[k] <= mo.max[k] + 0.5)) rideOn.set(oi, gi);
    });
  });
  motion.forEach((g, gi) => {
    const bodies = g.bodies.filter((b) => b < st.n.length && st.n[b] > 0);
    if (!bodies.length) return;
    let part: MotionPart | null = null;
    if (isJoint(g.role)) {
      part = jointPart(modelParts, st, g, gi, bodies);
      if (!part) return;
    } else if (isHinge(g.role)) {
      const plan = plans.find((p) => p.group === gi);
      if (!plan) return;
      part = { role: g.role, bodies, pivot: add(plan.hinge, t), axis: plan.axis, radius: 0, deploy: plan.deploy, parent: -1, group: gi };
    } else if (g.role === 'turret') {
      const mo = setMoments(st, bodies);
      part = { role: 'turret', bodies, pivot: [(mo.min[0] + mo.max[0]) / 2, (mo.min[1] + mo.max[1]) / 2, mo.min[2]], axis: [0, 0, 1], radius: 0, deploy: 0, parent: -1, group: gi };
    } else {
      const fit = fitRound(modelParts, bodies, g.role === 'wheel' ? wheelAxisHint(modelParts, bodies) : undefined);
      if (!fit) return;
      let axis = fit.axis;
      const t3 = cross(axis, [0, 0, 1]); // a positive turn moves the part's BOTTOM along −t3 and its TOP along +t3
      let sense = 1;
      if (g.role === 'wheel') sense = t3[0] < -1e-9 || (Math.abs(t3[0]) <= 1e-9 && t3[1] < 0) ? -1 : 1;
      else if (g.role === 'roller') sense = Math.abs(axis[2]) > 0.7 ? 1 : t3[0] * fit.pivot[0] + t3[1] * fit.pivot[1] >= 0 ? 1 : -1;
      else if (g.role === 'flywheel') sense = Math.abs(axis[2]) > 0.7 ? 1 : t3[0] >= 0 ? 1 : -1;
      axis = scale(axis, sense);
      part = { role: g.role, bodies, pivot: fit.pivot, axis, radius: fit.radius, deploy: 0, parent: -1, group: gi };
    }
    if (g.flip) part.axis = scale(part.axis, -1);
    if (g.corner !== undefined) part.corner = g.corner;
    index.set(gi, out.length);
    out.push(part);
  });
  // parents, once every part has its index; a chain that comes back on itself is cut where it closes
  for (const [gi, carrier] of rideOn) {
    const i = index.get(gi);
    const c = index.get(carrier);
    if (i !== undefined && c !== undefined) out[i].parent = c;
  }
  out.forEach((p, i) => {
    let at = p.parent;
    for (let n = 0; at >= 0 && n <= out.length; n++) {
      if (at === i) {
        p.parent = -1;
        break;
      }
      at = out[at].parent;
    }
  });
  // gearing: a part that follows another moves as it does, times the ratio (never itself, never a
  // loop: a follow that comes back round is dropped)
  motion.forEach((g, gi) => {
    const i = index.get(gi);
    const f = g.follows;
    if (i === undefined || !f || !Number.isFinite(f.ratio)) return;
    const j = index.get(f.group);
    if (j === undefined || j === i) return;
    out[i].follows = { index: j, ratio: Math.max(-100, Math.min(100, f.ratio)) };
  });
  out.forEach((p, i) => {
    let at = p.follows?.index;
    for (let n = 0; at !== undefined && n <= out.length; n++) {
      if (at === i) {
        delete p.follows;
        break;
      }
      at = out[at].follows?.index;
    }
  });
  // A RATIO IS AGAINST THE LEADER'S OWN SENSE: a part turning about an axle parallel to its leader's
  // is given the leader's direction before its own flip, so −1 turns it the other way (two meshed
  // gears) and +1 the same way (a belt). A round part's axle comes out of `fitRound` either way up,
  // and a ratio's sign changed with it. Within `GEARED_PARALLEL` of parallel it IS parallel, and is
  // fitted again about the leader's axle: a spur gear, a belt or a chain turns about a parallel axle
  // (a bevel square to it), and goBILDA's 6WD pinion and its shaft fit 13° off, which turned it
  // wobbling. Leaders before followers, so a train settles in one pass.
  const flipped = new Map<number, boolean>();
  motion.forEach((g, gi) => {
    const i = index.get(gi);
    if (i !== undefined) flipped.set(i, !!g.flip);
  });
  const done = new Set<number>();
  const align = (i: number, depth: number): void => {
    const f = out[i].follows;
    if (done.has(i) || depth > out.length) return;
    done.add(i);
    if (!f || isHinge(out[i].role) || out[i].role === 'slide') return;
    align(f.index, depth + 1);
    const lead = out[f.index].axis;
    const own = flipped.get(i) ? scale(out[i].axis, -1) : out[i].axis;
    if (Math.abs(dot(own, lead)) < GEARED_PARALLEL) return;
    if (isSpin(out[i].role)) {
      const fit = fitRound(modelParts, out[i].bodies, lead);
      if (fit) {
        out[i].pivot = fit.pivot;
        out[i].radius = fit.radius;
      }
    }
    out[i].axis = flipped.get(i) ? scale(lead, -1) : [...lead];
  };
  out.forEach((_, i) => align(i, 0));
  return out;
}

/** a robot axis as a unit vector (MODEL frame: +x front, +y left, +z up) */
const ROBOT_AXIS: Readonly<Record<'forward' | 'left' | 'up', V3>> = { forward: [1, 0, 0], left: [0, 1, 0], up: [0, 0, 1] };

/** a geared part's axle within this (a cosine, 20°) of its leader's is parallel to it (`deriveMotion`) */
const GEARED_PARALLEL = Math.cos((20 * Math.PI) / 180);

/**
 * A GENERIC JOINT as measured (`spin`, `swing`, `slide`). Its direction is a robot axis, or the picked
 * body's own: its round axle (`fitRound`) for a spin or a swing, its long side for a slide. Where it
 * turns about: a spin, its own axle through its bodies (`fitRound` along that direction); a swing, the
 * picked body's axle when there is one, else the end of the swinging part nearer the robot's middle
 * (an arm pivots at its root); a slide does not turn, and sits at its box's centre.
 */
function jointPart(modelParts: readonly MeshPart[], st: BodyStats, g: MotionGroup, gi: number, bodies: number[]): MotionPart | null {
  const role = g.role as 'spin' | 'swing' | 'slide';
  const amount = g.amount !== undefined && Number.isFinite(g.amount) && g.amount >= 0 ? g.amount : JOINT_DEFAULT_AMOUNT[role];
  const drive = g.drive ?? (role === 'spin' ? 'always' : 'intake');
  const ab = g.axis === 'part' && g.axisBody !== undefined && g.axisBody < st.n.length && st.n[g.axisBody] > 0 ? g.axisBody : null;
  const mo = setMoments(st, bodies);
  let axis: V3 | null = g.axis && g.axis !== 'part' ? ROBOT_AXIS[g.axis] : null;
  let pivot: V3 | null = null;
  if (ab !== null) {
    if (role === 'slide') {
      const v = eigenSym3(setMoments(st, [ab]).cov).vectors[0];
      const k = Math.abs(v[0]) >= Math.abs(v[1]) && Math.abs(v[0]) >= Math.abs(v[2]) ? 0 : Math.abs(v[1]) >= Math.abs(v[2]) ? 1 : 2;
      axis = snapAxis(v[k] < 0 ? scale(v, -1) : v);
    } else {
      const f = fitRound(modelParts, [ab]);
      if (f) {
        axis = f.axis;
        if (role === 'swing') pivot = f.pivot;
      }
    }
  }
  if (role === 'spin') {
    const f = fitRound(modelParts, bodies, axis ?? undefined);
    if (!f) return null;
    return { role, bodies, pivot: f.pivot, axis: axis ?? f.axis, radius: f.radius, deploy: 0, parent: -1, group: gi, drive, amount };
  }
  if (role === 'slide') {
    return { role, bodies, pivot: boxCentre(mo), axis: axis ?? [0, 0, 1], radius: 0, deploy: 0, parent: -1, group: gi, drive, amount };
  }
  // a swing: the hinge line
  const ax = axis ?? ROBOT_AXIS.left;
  if (!pivot) {
    // its long direction square to the hinge, and of its two ends the one nearer the robot's middle
    const v = eigenSym3(mo.cov).vectors;
    let d = v.map((w) => sub(w, scale(ax, dot(w, ax)))).reduce((best, w) => (Math.hypot(w[0], w[1], w[2]) > Math.hypot(best[0], best[1], best[2]) ? w : best));
    const dl = Math.hypot(d[0], d[1], d[2]);
    d = dl > 1e-6 ? scale(d, 1 / dl) : ([1, 0, 0] as V3);
    const c = boxCentre(mo);
    let lo = Infinity;
    let hi = -Infinity;
    eachVertex(modelParts, new Set(bodies), (x, y, z) => {
      const t = dot(sub([x, y, z], c), d);
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    });
    const a = add(c, scale(d, lo));
    const b = add(c, scale(d, hi));
    pivot = Math.hypot(a[0], a[1]) <= Math.hypot(b[0], b[1]) ? a : b;
  }
  return { role, bodies, pivot, axis: ax, radius: 0, deploy: (amount * Math.PI) / 180, parent: -1, group: gi, drive, amount: (amount * Math.PI) / 180 };
}

/** a drive wheel turns about a LEVEL axle: the fit's own direction, laid flat */
function wheelAxisHint(parts: readonly MeshPart[], bodies: readonly number[]): V3 | undefined {
  const st = bodyStats(parts);
  // read it off the wheel's biggest round body (its tyre or a plate): the shaft and the gear on it
  // (a wheel's group has them since 2026-10-04) pull the whole group's moments askew
  let disc = -1;
  let best = 0;
  for (const b of bodies) {
    if (b >= st.n.length || !st.n[b]) continue;
    const e = [0, 1, 2].map((k) => st.max[3 * b + k] - st.min[3 * b + k]).sort((x, y) => x - y);
    if (e[1] < 0.75) continue; // a rod
    const d = Math.hypot(e[0], e[1], e[2]);
    if (d > best) {
      best = d;
      disc = b;
    }
  }
  const mo = setMoments(st, disc >= 0 ? [disc] : bodies);
  if (mo.n < 3) return undefined;
  const a = roundAxis(mo.cov);
  const flat = norm([a[0], a[1], 0]);
  return Math.hypot(a[0], a[1]) > 0.2 ? snapAxis(flat, 12) : undefined;
}

/** every body of `group` and of the groups riding on it (what a pick highlights together) */
export function groupBodies(motion: readonly MotionGroup[], gi: number): number[] {
  return [...(motion[gi]?.bodies ?? [])];
}
