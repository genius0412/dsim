/**
 * Simplify a model to a triangle budget with meshoptimizer (three's bundled
 * `meshopt_simplifier.module.js`, which carries its own wasm). Works in any frame and unit:
 * simplification is invariant under rotation and uniform scale, so the engine simplifies ONCE
 * per file, in the source frame, and every later change of units, up axis or yaw re-measures the
 * small result instead of the multi-million-triangle original.
 *
 * Measured 2026-10-03 on the REV and goBILDA starter-bot STEPs against the full CAD
 * (`docs/area/robot-import.md` "Mesh quality"), three rules:
 *  · ⚠️ ONE ERROR BOUND FOR THE WHOLE ROBOT, NEVER A SLOPPY PASS. A per-group share of the budget
 *    with `simplifySloppy` finishing where the bounded pass stalled tore holes through perforated
 *    plates and turned gears into blobs (p90 2.09 mm, max 15.9 mm off the CAD at 84k triangles).
 *  · ⚠️ ONE CALL PER BODY, NOT PER COLOUR. Bodies that touch share positions but never vertices
 *    (`weld` keeps them apart), and in one meshopt call those coincident vertices read as SEAMS it
 *    will not collapse across: the goBILDA kit in one colour stalled until the bound reached 8 % of
 *    its size (p90 44 mm). Each body alone, the same 250k triangles came out at p90 0.45 mm, max
 *    1.9 mm, faster. Bodies under `BATCH_TRIS` share one call per part (a speck has no seam worth
 *    keeping, and a model of 100k specks must not make 100k calls).
 *  · AT A SHAPE CAP, DROP SMALL BODIES BEFORE COARSENING EVERYTHING (`dropSmallBodies`).
 */
import { MeshoptSimplifier } from 'three/examples/jsm/libs/meshopt_simplifier.module.js';
import { triangleCount, type MeshPart } from '../geometry';
import { compact, componentBodies, splitLumps, weld } from './meshOps';

export interface SimplifyReport {
  parts: MeshPart[];
  trisIn: number;
  trisOut: number;
  /** the error bound used, as a fraction of the model's extent (0 when nothing was simplified) */
  error: number;
}

/** the ladder's first bound, as a fraction of the model's extent (~0.02 mm on an 18-in robot) */
const FIRST_BOUND = 4e-5;
/** each rung doubles the bound; this many at most (2^40 × the first is past any model's size) */
const MAX_RUNGS = 40;
/** bisection steps between the last two rungs */
const REFINE_STEPS = 5;
/** the shape error the ladder stops at before it drops small bodies instead, as a fraction of the
 *  model's extent (~0.9 mm on an 18-in robot) */
const SHAPE_BOUND_MAX = 0.002;
/** a body this small (its box's diagonal, as a fraction of the model's extent) may be dropped whole
 *  to meet the budget: a fastener, a bearing, a gear inside a gearbox (~36 mm on an 18-in robot) */
const SMALL_BODY = 0.08;
/** a body with fewer triangles than this shares its part's batch call instead of its own */
const BATCH_TRIS = 64;

/** one simplifier call's worth: a body (or a part's batch of small ones), compacted */
interface Unit {
  /** the part it is put back into (index into the welded parts) */
  part: number;
  positions: Float32Array;
  indices: Uint32Array;
  body: Uint32Array | null;
}

/**
 * A welded part split into `Unit`s, one per body of at least `BATCH_TRIS` triangles and one for the
 * rest. A triangle's body is its first vertex's (a triangle never spans two: `weld` keeps bodies
 * apart, and `componentBodies` numbers whole connected pieces). Vertices are renumbered per unit
 * through one stamp array, so the split is linear in the part, however many bodies it holds.
 */
function splitByBody(part: number, w: { positions: Float32Array; indices: Uint32Array; body: Uint32Array | null }): Unit[] {
  const ix = w.indices;
  if (!w.body || !ix.length) return [{ part, positions: w.positions, indices: ix, body: w.body }];
  const body = w.body;
  const triCount = new Map<number, number>();
  for (let t = 0; t < ix.length; t += 3) triCount.set(body[ix[t]], (triCount.get(body[ix[t]]) ?? 0) + 1);
  if (triCount.size === 1) return [{ part, positions: w.positions, indices: ix, body }];
  // the unit each body's triangles go to: its own, or the batch (unit 0)
  const unitOf = new Map<number, number>();
  const sizes = [0];
  for (const [b, n] of triCount) {
    if (n >= BATCH_TRIS) {
      unitOf.set(b, sizes.length);
      sizes.push(n);
    } else {
      unitOf.set(b, 0);
      sizes[0] += n;
    }
  }
  const tris = sizes.map((n) => new Uint32Array(n * 3));
  const fill = sizes.map(() => 0);
  for (let t = 0; t < ix.length; t += 3) {
    const u = unitOf.get(body[ix[t]])!;
    const a = tris[u];
    a[fill[u]++] = ix[t];
    a[fill[u]++] = ix[t + 1];
    a[fill[u]++] = ix[t + 2];
  }
  const nV = w.positions.length / 3;
  const stamp = new Int32Array(nV).fill(-1);
  const remap = new Uint32Array(nV);
  const out: Unit[] = [];
  tris.forEach((src, u) => {
    if (!src.length) return;
    let n = 0;
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      if (stamp[v] !== u) {
        stamp[v] = u;
        remap[v] = n++;
      }
    }
    const positions = new Float32Array(n * 3);
    const ub = new Uint32Array(n);
    const indices = new Uint32Array(src.length);
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      const r = remap[v];
      indices[i] = r;
      positions[3 * r] = w.positions[3 * v];
      positions[3 * r + 1] = w.positions[3 * v + 1];
      positions[3 * r + 2] = w.positions[3 * v + 2];
      ub[r] = body[v];
    }
    out.push({ part, positions, indices, body: ub });
  });
  return out;
}

/** a part's units (their simplified indices) back into one part, unused vertices left out */
function joinUnits(units: readonly Unit[], res: readonly Uint32Array[]): { positions: Float32Array; indices: Uint32Array; body: Uint32Array | null } | null {
  let nV = 0;
  let nI = 0;
  units.forEach((u, i) => {
    if (res[i].length >= 3) {
      nV += u.positions.length / 3;
      nI += res[i].length;
    }
  });
  if (!nI) return null;
  const positions = new Float32Array(nV * 3);
  const indices = new Uint32Array(nI);
  const hasBody = units.every((u) => !!u.body);
  const body = hasBody ? new Uint32Array(nV) : null;
  let vo = 0;
  let io = 0;
  units.forEach((u, i) => {
    const r = res[i];
    if (r.length < 3) return;
    positions.set(u.positions, vo * 3);
    if (body && u.body) body.set(u.body, vo);
    for (let k = 0; k < r.length; k++) indices[io + k] = r[k] + vo;
    io += r.length;
    vo += u.positions.length / 3;
  });
  return compact(positions, indices, body);
}

function extentOf(parts: readonly MeshPart[]): number {
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    const a = p.positions;
    for (let i = 0; i < a.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (a[i + k] < mn[k]) mn[k] = a[i + k];
        if (a[i + k] > mx[k]) mx[k] = a[i + k];
      }
    }
  }
  return Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2], 1e-9);
}

export interface SimplifyOptions {
  /** the caller hands the parts over; each is released once welded */
  consume?: boolean;
  /**
   * also hand back every triangle, welded (`full`): the same parts, vertices, bodies and order the
   * simplified lists come from, so a body id names the same CAD body in both (Full detail)
   */
  keepFull?: boolean;
  /**
   * never take a body away whole (no `Prune`, no `dropSmallBodies`, and a body that collapses anyway
   * comes back unsimplified): the result is the measured stand-in for a `full` model, and a part
   * that is not in it can be neither picked nor found moving, while the full mesh still draws it.
   * The bound climbs instead, and the count may end over `budget`.
   */
  keepBodies?: boolean;
}

/** weld every part and bring the whole model under `budget` triangles (one list: `simplifyLists`) */
export async function simplifyParts(
  parts: readonly MeshPart[],
  budget: number,
  onProgress?: (frac: number) => void,
  opts: SimplifyOptions = {},
): Promise<SimplifyReport & { full?: MeshPart[] }> {
  const r = await simplifyLists([parts], budget, onProgress, opts);
  return { parts: r.lists[0], trisIn: r.trisIn, trisOut: r.trisOut, error: r.error, ...(r.full ? { full: r.full[0] } : {}) };
}

/**
 * Weld every part of every list, then bring them all under `budget` triangles with ONE error
 * bound, and hand them back in the same lists (a part simplified to nothing is left out). A
 * stored robot's static body and each of its moving parts are separate lists that must stay
 * separate, and share the bound so none of them is cut harder than the rest.
 *
 * The bound is found by a LADDER: from `FIRST_BOUND`, doubled each rung, each rung run on the last
 * rung's result (so every pass is smaller than the one before), then `REFINE_STEPS` of bisection
 * between the last two rungs. Deviation can add across rungs, to at most about twice the final
 * bound; measured, the same accuracy as a bisection on the original (p90 0.378 vs 0.393 mm) at a
 * third of the time.
 */
export async function simplifyLists(
  lists: readonly (readonly MeshPart[])[],
  budget: number,
  onProgress?: (frac: number) => void,
  opts: SimplifyOptions = {},
): Promise<{ lists: MeshPart[][]; trisIn: number; trisOut: number; error: number; full?: MeshPart[][] }> {
  await MeshoptSimplifier.ready;
  const all = lists.flat();
  const trisIn = triangleCount(all);
  const extent = extentOf(all);
  const eps = extent * 1e-6;
  // progress: welding is the first quarter, the ladder the rest
  let doneTris = 0;
  const report = (f: number): void => onProgress?.(Math.min(1, f));
  // `consume`: the caller hands the parts over (each list a mutable array only it held), and each
  // one's arrays are let go as soon as its welded copy exists, instead of all of them living until
  // the end beside their copies
  const welded: { list: number; part: Pick<MeshPart, 'color' | 'name'>; positions: Float32Array; indices: Uint32Array; body: Uint32Array | null }[] = [];
  lists.forEach((list, li) => {
    const src = list as (MeshPart | null)[];
    for (let i = 0; i < src.length; i++) {
      const p = src[i]!;
      welded.push({ list: li, part: { color: p.color, name: p.name }, ...weld(p, eps) });
      doneTris += triangleCount([p]);
      report((0.25 * doneTris) / Math.max(1, trisIn));
      if (opts.consume) src[i] = null;
    }
  });
  // A MODEL WITH NO BODIES OF ITS OWN (an STL, a PLY, a glTF exported as one mesh, or a reader that
  // gave every vertex one id) gets one per connected piece of the welded mesh, numbered across the
  // parts. Positions and indices are untouched: only `body` is added.
  if (distinctBodies(welded) === 0) {
    let next = 0;
    for (const w of welded) {
      const c = componentBodies(w.positions.length / 3, w.indices, next);
      w.body = c.body;
      next += c.count;
    }
  } else {
    // a body that is several lumps (a reader's one body, or a merged sub-assembly) gets an id per lump,
    // so each can be picked on its own (`splitLumps`)
    // (a part with no ids beside parts with them is a body of its own, numbered past the rest)
    let top = -1;
    for (const w of welded) if (w.body) for (let i = 0; i < w.body.length; i++) if (w.body[i] > top) top = w.body[i];
    for (const w of welded) if (!w.body) w.body = new Uint32Array(w.positions.length / 3).fill(++top);
    splitLumps(welded, extent * 1e-5);
  }
  // ONE CALL PER BODY (the header): the welded parts split into units, put back together at the end
  const units: Unit[] = [];
  welded.forEach((w, i) => {
    units.push(...splitByBody(i, w));
  });
  const count = (r: readonly Uint32Array[]): number => r.reduce((a, x) => a + x.length / 3, 0);
  let cur = units.map((u) => u.indices);
  let res = cur;
  let bound = 0;
  const flags: ('ErrorAbsolute' | 'Prune')[] = opts.keepBodies ? ['ErrorAbsolute'] : ['ErrorAbsolute', 'Prune'];
  if (count(cur) > budget) {
    const run = (src: readonly Uint32Array[], e: number): Uint32Array[] =>
      src.map((ix, i) => (ix.length >= 3 ? (MeshoptSimplifier.simplify(ix, units[i].positions, 3, 0, e, flags)[0] as Uint32Array) : ix));
    // the measured stand-in for a full model (`keepBodies`) starts higher up the ladder: its early
    // rungs walk millions of triangles to take a third of them. goBILDA's BIOBUZZ kit re-opened,
    // 5.65M to 250k: from the first bound, 7 rungs and 5 steps took 5.1 s (rungs 0–2 alone 3.0 s);
    // from 8× it (a power of two under half the reduction asked for), whose first rung still leaves
    // 3.7 times the budget, 4 rungs and 5 steps take 2.4 s, to the same count within 0.1 %
    let e = extent * FIRST_BOUND * (opts.keepBodies ? 2 ** Math.floor(Math.log2(Math.max(1, count(cur) / budget / 2))) : 1);
    let lastE = 0;
    let dropped = false;
    let refine = true;
    const cap = extent * SHAPE_BOUND_MAX;
    for (let rung = 0; ; rung++) {
      res = run(cur, e);
      report(0.25 + 0.6 * Math.min(1, rung / 12));
      if (count(res) <= budget || rung >= MAX_RUNGS) break;
      // AT THE SHAPE CAP, DROP SMALL BODIES BEFORE COARSENING EVERY SURFACE. A part simplifies only
      // so far (a screw keeps a dozen triangles), so thousands of fasteners and gearbox internals
      // put a floor under the count, and the bound would climb until `Prune` took them, cutting
      // every other surface at that error too: measured on the goBILDA kit's face-split read, 0.054
      // of its size (24 mm). Dropped smallest first; a body over `SMALL_BODY` is never dropped, and
      // only if the small ones are not enough does the bound go on climbing.
      if (!dropped && e >= cap && !opts.keepBodies) {
        dropped = true;
        res = dropSmallBodies(units, res, budget, extent * SMALL_BODY);
        if (count(res) <= budget) {
          refine = false; // the rungs below the cap were never under budget without the drop
          break;
        }
      }
      cur = res;
      lastE = e;
      e = e < cap && e * 2 > cap ? cap : e * 2;
    }
    // refine between the last rung over budget and the first under it, on the last result over it
    let lo = Math.max(lastE, extent * FIRST_BOUND * 0.5);
    let hi = e;
    for (let i = 0; i < REFINE_STEPS && lastE > 0 && refine; i++) {
      const mid = Math.sqrt(lo * hi);
      const r = run(cur, mid);
      report(0.85 + (0.15 * (i + 1)) / REFINE_STEPS);
      if (count(r) <= budget) {
        hi = mid;
        res = r;
      } else lo = mid;
    }
    bound = hi;
    // even without `Prune` a sliver collapses to nothing (goBILDA's BIOBUZZ kit: 1,152 of 3,930 bodies,
    // median 0.7 mm across, 50k triangles in all): those come back whole
    if (opts.keepBodies) res = restoreBodies(units, res);
  }
  const out: MeshPart[][] = lists.map(() => []);
  const byPart = new Map<number, number[]>();
  units.forEach((u, i) => {
    const l = byPart.get(u.part);
    if (l) l.push(i);
    else byPart.set(u.part, [i]);
  });
  welded.forEach((w, pi) => {
    const us = byPart.get(pi) ?? [];
    const joined = joinUnits(
      us.map((i) => units[i]),
      us.map((i) => res[i]),
    );
    if (joined) out[w.list].push({ ...joined, color: w.part.color, name: w.part.name });
  });
  // FULL DETAIL: every welded triangle as well, put back together the same way. When nothing was
  // simplified the two are the same arrays.
  let full: MeshPart[][] | undefined;
  if (opts.keepFull) {
    if (res === cur && bound === 0) full = out;
    else {
      full = lists.map(() => []);
      welded.forEach((w, pi) => {
        const us = byPart.get(pi) ?? [];
        const joined = joinUnits(
          us.map((i) => units[i]),
          us.map((i) => units[i].indices),
        );
        if (joined) full![w.list].push({ ...joined, color: w.part.color, name: w.part.name });
      });
    }
  }
  report(1);
  return { lists: out, trisIn, trisOut: count(res), error: bound / extent, ...(full ? { full } : {}) };
}

/**
 * `res` (per part, triangle indices into `welded[i]`) without whole bodies, smallest first by the
 * diagonal of their box, until the count is at most `budget` or every body under `maxSize` is gone.
 */
function dropSmallBodies(
  welded: readonly { positions: Float32Array; body: Uint32Array | null }[],
  res: readonly Uint32Array[],
  budget: number,
  maxSize: number,
): Uint32Array[] {
  // each body's box and triangle count, over every part (a body can span colours)
  const box = new Map<number, number[]>();
  const tris = new Map<number, number>();
  welded.forEach((w, i) => {
    if (!w.body) return;
    const ix = res[i];
    for (let t = 0; t < ix.length; t += 3) {
      const b = w.body[ix[t]];
      tris.set(b, (tris.get(b) ?? 0) + 1);
      let bb = box.get(b);
      if (!bb) box.set(b, (bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]));
      for (let c = 0; c < 3; c++) {
        const v = 3 * ix[t + c];
        for (let k = 0; k < 3; k++) {
          const x = w.positions[v + k];
          if (x < bb[k]) bb[k] = x;
          if (x > bb[k + 3]) bb[k + 3] = x;
        }
      }
    }
  });
  const size = (b: number): number => {
    const bb = box.get(b)!;
    return Math.hypot(bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2]);
  };
  const small = [...box.keys()].filter((b) => size(b) < maxSize).sort((a, b) => size(a) - size(b) || a - b);
  let total = res.reduce((a, x) => a + x.length / 3, 0);
  const drop = new Set<number>();
  for (const b of small) {
    if (total <= budget) break;
    drop.add(b);
    total -= tris.get(b) ?? 0;
  }
  if (!drop.size) return [...res];
  return res.map((ix, i) => {
    const body = welded[i].body;
    if (!body) return ix;
    const keep: number[] = [];
    for (let t = 0; t < ix.length; t += 3) if (!drop.has(body[ix[t]])) keep.push(ix[t], ix[t + 1], ix[t + 2]);
    return keep.length === ix.length ? ix : new Uint32Array(keep);
  });
}

/** `res` with every body of each unit that simplified away put back as it was (`keepBodies`) */
function restoreBodies(units: readonly Unit[], res: readonly Uint32Array[]): Uint32Array[] {
  return res.map((ix, i) => {
    const u = units[i];
    if (ix === u.indices || !u.body) return ix;
    const body = u.body;
    const have = new Set<number>();
    for (let t = 0; t < ix.length; t += 3) have.add(body[ix[t]]);
    const src = u.indices;
    let extra = 0;
    for (let t = 0; t < src.length; t += 3) if (!have.has(body[src[t]])) extra += 3;
    if (!extra) return ix;
    const out = new Uint32Array(ix.length + extra);
    out.set(ix);
    let k = ix.length;
    for (let t = 0; t < src.length; t += 3) {
      if (have.has(body[src[t]])) continue;
      out[k++] = src[t];
      out[k++] = src[t + 1];
      out[k++] = src[t + 2];
    }
    return out;
  });
}

/** how many different body ids the welded parts carry (0 when none carries any) */
function distinctBodies(welded: readonly { body: Uint32Array | null }[]): number {
  let first = -1;
  for (const w of welded) {
    if (!w.body) continue;
    for (let i = 0; i < w.body.length; i++) {
      if (first < 0) first = w.body[i];
      else if (w.body[i] !== first) return 2;
    }
  }
  return first < 0 ? 0 : 1;
}
