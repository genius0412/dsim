import type { Rapier3d } from './engine';
import { datan2, dcos, dsin } from '../../../math';
import {
  BB_FLOWERS,
  BB_FLOWER_MID_HOLE,
  BB_FLOWER_OPEN_R,
  BB_FLOWER_RETRIEVE_Z,
  BB_FLOWER_TOP_Z,
  BB_NECTAR_R,
  BB3_FLOWER_CAGE_SEGMENTS,
  BB3_FLOWER_CAGE_T,
  BB3_FLOWER_NECTAR_SORT_D,
  BB3_FLOWER_RING_SEGMENTS,
} from '../config';

import { cadFlowerRings, type FieldFlowerRing } from './fieldColliders';
import { GROUP_FLOWER_RING, GROUP_FLOWER_SOLID, GROUP_NECTAR_SORTER } from './groups';

/**
 * BIOBUZZ 3D PHYSICS — THE FLOWER TUBE (Day 2, `docs/biobuzz/plan-3d.md` §3.7).
 *
 * A FLOWER is a vertical tube on the perimeter wall: three horizontal PLATES with circular
 * bores, held apart by four HIPS pipes and closed on the wall side by the backstop extrusion.
 * The pipes, the backstop and the brackets have been colliders since Day 1 (`flower_support`
 * hulls, `bodies.ts`). The PLATES were not, and the reason was written next to the rule in
 * `convert.py`: **a convex hull of an annulus fills its own centre hole**, which is exactly the
 * opening an element passes through, so exporting one would have sealed the tube.
 *
 * That is a fact about HULLS. This file stops asking for one: each plate is a
 * RECTANGLE-MINUS-DISC TRIMESH, tessellated here from the eleven numbers `convert.py` measured
 * (`FieldFlowerRing`). The rectangle is the plate's own measured footprint and the disc is its
 * own least-squares bore, so the collider an element meets is the plate the GLB draws.
 *
 * ── WHAT THE REAL BORES DO, WHICH IS NOT WHAT THE 2D MODEL SAYS ─────────────────────────────
 *
 *   plate    band (in)          bore Ø   POLLEN 2.8   NECTAR 3.6
 *   top      20.254 … 21.404    4.171    passes       passes
 *   mid       3.904 …  5.254    3.896    passes       **passes**
 *   lower    −0.199 …  0.354    3.222    passes       STOPPED
 *
 * So a dropped NECTAR falls past BOTH upper plates and comes to rest on the LOWER one; a
 * dropped POLLEN clears all three and rests on the tiles inside the lower bore. The manual's
 * INTENT survives intact — G418's "POLLEN out of the bottom and nothing else" holds, because a
 * nectar clears neither the 3.222 bore nor the 3.550-in retrieval opening — but the ring that
 * delivers it is the BOTTOM one, not the middle one. The 2D pipeline's sorter ruling (owner,
 * 2026-09-12: a nectar seats on the MIDDLE ring) is a gameplay decision and it stands for that
 * model. See `config.ts`'s `BB_FLOWER_MID_HOLE` and `docs/biobuzz/field-cad-audit.md` §11.
 *
 * ⚠️ **AND THEN THE MIDDLE RING GOT A NECTAR LIP (owner, 2026-09-24).** A NECTAR on the tiles
 * sits in the retrieval opening, and a deployed ramp's blade lifted it and dragged it out on the
 * way back — G418.B's "POLLEN only" broken by physics, not by the gate. `buildNectarSorter3d`
 * adds a lip inside the middle bore that only a NECTAR meets (`groups.ts`), so a NECTAR seats
 * on the middle ring as the manual describes and the 2D model always had it. POLLEN is untouched.
 *
 * ── WHY A TRIMESH AND NOT A COMPOUND OF WEDGES ──────────────────────────────────────────────
 * A ring is genuinely non-convex, so it is either one trimesh or a fan of convex boxes. The
 * trimesh is ONE collider per plate with the true bore; a fan is N colliders per plate whose
 * inner faces are chords, i.e. a bore that is polygonal by construction AND N times the
 * broad-phase work. `TriMeshFlags.FIX_INTERNAL_EDGES` is what makes the trimesh behave as a
 * surface rather than as a bag of triangles: without it a sphere rolling across the plate's top
 * face catches on every shared edge it crosses. (The three plates now share ONE trimesh collider;
 * see `buildFlowerTubes3d`.)
 *
 * ⚠️ **A TRIMESH HAS NO INSIDE, SO NO ROBOT MEETS IT.** A chassis box pressed past a plate's outer
 * face was pushed out through the plate's top or bottom face instead: lifted onto the lower plate
 * and left hanging there, or sunk into the tiles under the middle one. A robot meets the middle
 * and top plates as solid boxes (`buildFlowerSolids3d`) and the lower plate not at all;
 * `groups.ts`'s sixth bit has the measurements.
 *
 * ── AND THE CAGE, WHICH IS THE WALL BETWEEN THE TOP TWO PLATES THE CAD HAS NO PART FOR ──────
 * `buildFlowerCage3d` (below) closes the 15-in gap between the mid plate's top face and the top
 * plate's underside with one more prism, its faces on the MIDDLE BORE's own radius. Read
 * `BB3_FLOWER_CAGE_SEGMENTS`'s header in `config.ts` first: it carries the measurement (a POLLEN
 * centre reaching 1.046 in off-axis through the gaps between the four HIPS pipes, and a column
 * arching on it 22 times in 24) and the argument that a wall at an aperture every element in the
 * tube has already passed cannot stop anything. It is a TRIMESH for the same reason the plates
 * are, and it is CIRCUMSCRIBED where they are inscribed — a plate's bore SORTS a 3.6-in nectar
 * from a 3.222-in hole and must never be generous; a cage sorts nothing and must never be mean.
 */

/** one tessellated plate, ready for `RAPIER.ColliderDesc.trimesh`. */
export interface RingMesh {
  vertices: Float32Array;
  indices: Uint32Array;
}

/**
 * Tessellate one plate as a closed, outward-oriented rectangle-minus-disc prism.
 *
 * `BB3_FLOWER_RING_SEGMENTS` rays leave the bore centre at even angles; the four RECTANGLE
 * CORNERS are inserted as extra rays so the outer boundary is the true rectangle rather than a
 * polygon that cuts its corners off. Each ray carries four vertices (inner/outer × bottom/top)
 * and each pair of adjacent rays contributes eight triangles: top face, bottom face, bore wall,
 * outer wall.
 *
 * ⚠️ **THE BORE IS INSCRIBED, SO THE HOLE IS A HAIR SMALL, AND THAT IS THE SAFE DIRECTION.**
 * The polygon's apothem is `r·cos(π/N)`, which at N = 32 is 0.15 % — 0.010 in off the 2.086-in
 * top bore. Circumscribing instead would make every hole 0.010 in WIDE, and a hole that is
 * slightly too generous is the one failure mode this geometry cannot recover from: an element
 * that should have been stopped is through, and nothing puts it back. The clearances it has to
 * preserve are 0.148 in (a NECTAR through the mid bore) and 0.211 in (a POLLEN through the
 * lower bore), both an order of magnitude above the error.
 *
 * Returns `null` for a plate whose bore is not strictly inside its own rectangle — impossible
 * on this field's measurements (the tightest margin is 0.215 in) and a fail-safe rather than a
 * fail-open if a future revision changes that: no collider beats a wrong one.
 */
export function ringTrimesh(ring: FieldFlowerRing, segments: number = BB3_FLOWER_RING_SEGMENTS): RingMesh | null {
  const [cx, cy] = ring.bore;
  const [x0, x1] = ring.rect.x;
  const [y0, y1] = ring.rect.y;
  const [zLo, zHi] = ring.z;
  const r = ring.hole;
  const margin = Math.min(cx - x0, x1 - cx, cy - y0, y1 - cy);
  if (!(margin > r)) return null;

  // the ray angles: `segments` even steps plus the four corners, sorted, de-duplicated.
  const angles: number[] = [];
  for (let i = 0; i < segments; i++) angles.push((i * 2 * Math.PI) / segments);
  for (const [px, py] of [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ] as const) {
    // `datan2`, never the engine's own inverse trig — `scripts/smoke.ts`'s source guard scans
    // this directory for exactly that, and it is right to: an engine's transcendentals are not
    // required to be correctly-rounded, so two peers can compute different bits from one input.
    //
    // ⚠️ **WRAPPED INTO [0, 2π) FIRST, AND THAT LINE IS THE WHOLE CORRECTNESS OF THIS MESH.**
    // `atan2` answers in (−π, π] while the even steps above are in [0, 2π), so a corner in the
    // third quadrant sorts BEFORE every even step instead of between two of them. The ring then
    // closes from a ray at ~350° back to one at ~−126°, and the two triangles bridging that gap
    // sweep straight across the bore — measured, they put geometry 1.08 in from the tube's axis
    // where the nearest real surface is 2.09, so a POLLEN bounced off the middle of the hole and
    // a NECTAR jammed in the top one. Both looked exactly like "the bore is too small".
    angles.push((datan2(py - cy, px - cx) + 2 * Math.PI) % (2 * Math.PI));
  }
  angles.sort((a, b) => a - b);
  const rays = angles.filter((a, i) => i === 0 || a - angles[i - 1] > 1e-9);

  const verts: number[] = [];
  for (const a of rays) {
    const ux = dcos(a);
    const uy = dsin(a);
    // the outer point: the slab distance from the bore centre to the rectangle along this ray.
    const tx = ux > 0 ? (x1 - cx) / ux : ux < 0 ? (x0 - cx) / ux : Infinity;
    const ty = uy > 0 ? (y1 - cy) / uy : uy < 0 ? (y0 - cy) / uy : Infinity;
    const t = Math.min(tx, ty);
    verts.push(cx + ux * r, cy + uy * r, zLo); // 0 inner bottom
    verts.push(cx + ux * r, cy + uy * r, zHi); // 1 inner top
    verts.push(cx + ux * t, cy + uy * t, zLo); // 2 outer bottom
    verts.push(cx + ux * t, cy + uy * t, zHi); // 3 outer top
  }

  const n = rays.length;
  const idx: number[] = [];
  const IB = (i: number) => 4 * i;
  const IT = (i: number) => 4 * i + 1;
  const OB = (i: number) => 4 * i + 2;
  const OT = (i: number) => 4 * i + 3;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    // top face (+z outward)
    idx.push(IT(i), OT(i), OT(j), IT(i), OT(j), IT(j));
    // bottom face (−z outward): the same quad, wound the other way
    idx.push(IB(i), OB(j), OB(i), IB(i), IB(j), OB(j));
    // the BORE wall, normals pointing INTO the hole
    idx.push(IB(i), IT(i), IT(j), IB(i), IT(j), IB(j));
    // the OUTER wall, normals pointing away from the bore
    idx.push(OB(i), OB(j), OT(j), OB(i), OT(j), OT(i));
  }
  return { vertices: new Float32Array(verts), indices: new Uint32Array(idx) };
}

/**
 * Build every FLOWER into `world3d` — one fixed body per flower, in `BB_FLOWERS` order
 * (determinism: the same build order rule every other static follows). On each body: the three
 * ring plates as ONE trimesh (bottom-to-top), the cage, the nectar sorter, then the two plate
 * SOLIDS a robot meets instead of the trimesh (`buildFlowerSolids3d`).
 *
 * ⚠️ **THE THREE PLATES ARE ONE COLLIDER SO THE COUNT DID NOT MOVE.** Adding the two solids as
 * well as three plate trimeshes made every later collider's handle two higher per flower, which
 * reorders Rapier's pairs; that alone (the solids set to meet nothing) flipped two unrelated,
 * order-sensitive HIVE3D/SIM3D checks. A trimesh's contacts are per triangle either way, so an
 * element meets exactly the same surfaces, and the FLOWER3D lane's fit checks agree.
 *
 * Friction is the same `PHYS_WALL_FRICTION` the supports take; restitution 0, because a plate
 * is the surface an element has to COME TO REST on and a bouncy one turns a placed nectar into
 * a ball rattling down a 21-in tube.
 */
export function buildFlowerTubes3d(
  RAPIER: Rapier3d,
  world3d: InstanceType<Rapier3d['World']>,
  friction: number,
): number {
  let built = 0;
  for (let i = 0; i < BB_FLOWERS.length; i++) {
    const rings = cadFlowerRings(i);
    if (rings.length === 0) continue;
    const body = world3d.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const verts: number[] = [];
    const idx: number[] = [];
    for (const ring of rings) {
      const mesh = ringTrimesh(ring);
      if (!mesh) continue;
      const base = verts.length / 3;
      for (const v of mesh.vertices) verts.push(v);
      for (const k of mesh.indices) idx.push(k + base);
    }
    const desc =
      idx.length > 0
        ? RAPIER.ColliderDesc.trimesh(new Float32Array(verts), new Uint32Array(idx), RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES)
        : null;
    if (desc) {
      // the plates meet elements; a deployed RAMP and a robot skip them (`groups.ts`)
      world3d.createCollider(desc.setFriction(friction).setRestitution(0).setCollisionGroups(GROUP_FLOWER_RING), body);
      built++;
    }
    built += buildFlowerCage3d(RAPIER, world3d, body, rings, friction);
    built += buildNectarSorter3d(RAPIER, world3d, body, rings, friction);
    built += buildFlowerSolids3d(RAPIER, world3d, body, rings, friction);
  }
  return built;
}

/**
 * What a ROBOT meets of a FLOWER's plates: the MIDDLE and TOP plates as solid boxes over their own
 * measured footprint and z band, and nothing for the LOWER plate. `GROUP_FLOWER_SOLID` in
 * `groups.ts` has why a robot must not meet the trimesh (it has no inside) and why the lower
 * plate needs no box. Elements and a deployed ramp never meet these. The ramp swing guard's query
 * carries no groups, so it sees them: a swing through a plate's inside is refused, where the
 * trimesh let one through if it touched no triangle.
 */
export function buildFlowerSolids3d(
  RAPIER: Rapier3d,
  world3d: InstanceType<Rapier3d['World']>,
  body: InstanceType<Rapier3d['RigidBody']>,
  rings: readonly FieldFlowerRing[],
  friction: number,
): number {
  let built = 0;
  for (const ring of rings) {
    if (ring.id === 'lower') continue;
    const [x0, x1] = ring.rect.x;
    const [y0, y1] = ring.rect.y;
    const [zLo, zHi] = ring.z;
    if (!(x1 > x0 && y1 > y0 && zHi > zLo)) continue;
    const desc = RAPIER.ColliderDesc.cuboid((x1 - x0) / 2, (y1 - y0) / 2, (zHi - zLo) / 2)
      .setTranslation((x0 + x1) / 2, (y0 + y1) / 2, (zLo + zHi) / 2)
      .setFriction(friction)
      .setRestitution(0)
      .setCollisionGroups(GROUP_FLOWER_SOLID);
    world3d.createCollider(desc, body);
    built++;
  }
  return built;
}

/**
 * THE MIDDLE RING'S NECTAR LIP: an annulus inside the middle plate's own bore, spanning the plate's
 * own z band, from `BB3_FLOWER_NECTAR_SORT_D` out to the CAD bore. It is in
 * `GROUP_NECTAR_SORTER`, so a POLLEN passes through it as if it were not there and a NECTAR comes
 * to rest on it. See the constant for why the real ring needs it, and `groups.ts` for the pairing.
 *
 * INSCRIBED, like the plates and for their reason: it SORTS, so its hole may be a hair small and
 * never a hair large. At `BB3_FLOWER_RING_SEGMENTS` rays the faces sit 0.15 % inside the
 * nominal radius, 0.003 in on a 1.7-in radius.
 */
export function buildNectarSorter3d(
  RAPIER: Rapier3d,
  world3d: InstanceType<Rapier3d['World']>,
  body: InstanceType<Rapier3d['RigidBody']>,
  rings: readonly FieldFlowerRing[],
  friction: number,
): number {
  const mid = rings.find((r) => r.id === 'mid');
  if (!mid) return 0;
  const [cx, cy] = mid.bore;
  const [zLo, zHi] = mid.z;
  const rIn = BB3_FLOWER_NECTAR_SORT_D / 2;
  const rOut = mid.hole;
  // no lip at all rather than an inside-out one, if the CAD bore ever shrinks past the sorter
  if (!(rOut > rIn)) return 0;
  const n = BB3_FLOWER_RING_SEGMENTS;
  const verts: number[] = [];
  for (let k = 0; k < n; k++) {
    // `dsin`/`dcos` only — the source guard scans this directory.
    const a = (k * 2 * Math.PI) / n;
    const ux = dcos(a);
    const uy = dsin(a);
    verts.push(cx + ux * rIn, cy + uy * rIn, zLo); // 0 inner bottom
    verts.push(cx + ux * rIn, cy + uy * rIn, zHi); // 1 inner top
    verts.push(cx + ux * rOut, cy + uy * rOut, zLo); // 2 outer bottom
    verts.push(cx + ux * rOut, cy + uy * rOut, zHi); // 3 outer top
  }
  const idx: number[] = [];
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    const IB = (q: number) => 4 * q;
    const IT = (q: number) => 4 * q + 1;
    const OB = (q: number) => 4 * q + 2;
    const OT = (q: number) => 4 * q + 3;
    idx.push(IT(k), OT(k), OT(j), IT(k), OT(j), IT(j)); // top face (+z outward)
    idx.push(IB(k), OB(j), OB(k), IB(k), IB(j), OB(j)); // bottom face (−z outward)
    idx.push(IB(k), IT(k), IT(j), IB(k), IT(j), IB(j)); // the inner wall, normals INTO the tube
    idx.push(OB(k), OB(j), OT(j), OB(k), OT(j), OT(k)); // the outer wall, against the plate
  }
  const desc = RAPIER.ColliderDesc.trimesh(
    new Float32Array(verts),
    new Uint32Array(idx),
    RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES,
  );
  if (!desc) return 0;
  world3d.createCollider(
    desc.setFriction(friction).setRestitution(0).setCollisionGroups(GROUP_NECTAR_SORTER),
    body,
  );
  return 1;
}

/** the CAGE's own radius (in) — the MIDDLE plate's bore, which is the tightest aperture every
 * element above it has already been through. A derived number, not a typed dimension: change the
 * CAD's middle bore and the cage follows it. */
export const FLOWER_CAGE_R = BB_FLOWER_MID_HOLE / 2;

/**
 * The z band the cage spans: the MID plate's top face up to the TOP plate's underside — exactly
 * the open run between two real plates, and nothing else. It deliberately does NOT reach into
 * either plate's own z range: the plates' bores are the sorters (3.896 passes a NECTAR by
 * 0.148 in, 3.222 stops one), and a cage overlapping them would re-decide a sort it has no
 * business in.
 */
export function flowerCageBand(rings: readonly FieldFlowerRing[]): readonly [number, number] | null {
  const mid = rings.find((r) => r.id === 'mid');
  const top = rings.find((r) => r.id === 'top');
  if (!mid || !top) return null;
  const zLo = mid.z[1];
  const zHi = top.z[0];
  return zHi - zLo > 2 * BB3_FLOWER_CAGE_T ? [zLo, zHi] : null;
}

/**
 * Close one FLOWER's open span with a fan of tangent slabs — see `BB3_FLOWER_CAGE_SEGMENTS` in
 * `config.ts` for the measurement that made this necessary and for why a wall here stops nothing.
 *
 * ⚠️ **ONE TRIMESH PRISM, NOT A FAN OF CUBOIDS, AND WHAT SEPARATES THEM IS THE TAIL.** The fan
 * was the obvious build (a ring is non-convex, so it is a trimesh or N boxes — see this file's
 * header for why the PLATES chose the trimesh) and it shipped 12 colliders per flower, 48 across
 * the field. On the MEDIAN the two are the same: three interleaved rounds of `step3d` on a 2v2
 * room read the fan at 0.394 / 0.401 / 0.402 ms and the prism at 0.374 / 0.381 / 0.371, against
 * 0.333 / 0.331 / 0.330 with no cage at all — both about +13 %.
 *
 * The AI lane's `bot-driven 2v2 step3d p95 <= 1.5ms` is where they part: the fan measured
 * **1.86 and 1.95 ms — a hard FAIL** — and the prism 1.248 and 1.436 against 1.220 and 1.352
 * with no cage. 48 static proxies near four flowers produce expensive OUTLIER ticks that the
 * median never shows; the narrow phase sees the same walls either way, so the 4 proxies are free.
 * ⚠️ **Measure the p95, not the median, if this is ever rebuilt.**
 *
 * Closed and outward-oriented, laid out exactly like `ringTrimesh`'s: four vertices per ray
 * (inner/outer × bottom/top), eight triangles per pair of adjacent rays. `FIX_INTERNAL_EDGES`
 * for the same reason the plates take it — without it a sphere sliding down the wall catches on
 * every shared edge it crosses.
 */
/** the cage polygon's VERTEX radius — `FLOWER_CAGE_R / cos(π/N)`, so its FACES land on
 * `FLOWER_CAGE_R` exactly. The cage's furthest point from the tube axis is `cageVertexR() +
 * BB3_FLOWER_CAGE_T`, and that is the number that has to stay inside the HIPS pipes. */
export function cageVertexR(n: number = BB3_FLOWER_CAGE_SEGMENTS): number {
  return FLOWER_CAGE_R / dcos(Math.PI / n);
}

export function buildFlowerCage3d(
  RAPIER: Rapier3d,
  world3d: InstanceType<Rapier3d['World']>,
  body: InstanceType<Rapier3d['RigidBody']>,
  rings: readonly FieldFlowerRing[],
  friction: number,
): number {
  const band = flowerCageBand(rings);
  if (!band) return 0;
  const [zLo, zHi] = band;
  const mid = rings.find((r) => r.id === 'mid');
  if (!mid) return 0;
  const [cx, cy] = mid.bore;
  const n = BB3_FLOWER_CAGE_SEGMENTS;
  const t = BB3_FLOWER_CAGE_T;
  // BUILD NOTHING rather than a degenerate prism: fewer than three rays has no interior, and
  // `cageVertexR` divides by `cos(π/N)`, which is not a number at N = 0. The same fail-safe
  // `ringTrimesh` takes — no collider beats a wrong one — and it is also what makes the constant
  // a clean A/B switch when somebody measures what the cage costs.
  if (!(n >= 3) || !(t > 0)) return 0;
  // ⚠️ **CIRCUMSCRIBED, WHICH IS THE OPPOSITE OF `ringTrimesh`'S RULE, AND ON PURPOSE.** A plate's
  // bore is INSCRIBED because it SORTS — a hole a hair too generous lets through something that
  // should have been stopped, and nothing puts it back. The cage sorts nothing; what it must not
  // do is be TIGHTER than the aperture it claims to be, because a NECTAR has only 0.148 in of
  // slack through the middle bore and an inscribed polygon would eat 0.066 of it (and 0.111 of
  // that is the nectar's own scatter). So the vertices sit at `R / cos(π/N)` and the FACES sit at
  // exactly `FLOWER_CAGE_R`. `cageVertexR` is the same number the FLOWER3D lane clears against
  // the pipes.
  const vr = cageVertexR();
  const verts: number[] = [];
  for (let k = 0; k < n; k++) {
    // `dsin`/`dcos` only — the source guard scans this directory.
    const a = (k * 2 * Math.PI) / n;
    const ux = dcos(a);
    const uy = dsin(a);
    verts.push(cx + ux * vr, cy + uy * vr, zLo); // 0 inner bottom
    verts.push(cx + ux * vr, cy + uy * vr, zHi); // 1 inner top
    verts.push(cx + ux * (vr + t), cy + uy * (vr + t), zLo); // 2 outer bottom
    verts.push(cx + ux * (vr + t), cy + uy * (vr + t), zHi); // 3 outer top
  }
  const idx: number[] = [];
  const IB = (k: number) => 4 * k;
  const IT = (k: number) => 4 * k + 1;
  const OB = (k: number) => 4 * k + 2;
  const OT = (k: number) => 4 * k + 3;
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    idx.push(IT(k), OT(k), OT(j), IT(k), OT(j), IT(j)); // top face (+z outward)
    idx.push(IB(k), OB(j), OB(k), IB(k), IB(j), OB(j)); // bottom face (−z outward)
    idx.push(IB(k), IT(k), IT(j), IB(k), IT(j), IB(j)); // the inner wall, normals INTO the tube
    idx.push(OB(k), OB(j), OT(j), OB(k), OT(j), OT(k)); // the outer wall, normals away
  }
  const desc = RAPIER.ColliderDesc.trimesh(
    new Float32Array(verts),
    new Uint32Array(idx),
    RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES,
  );
  if (!desc) return 0;
  world3d.createCollider(desc.setFriction(friction).setRestitution(0), body);
  return 1;
}

// ---------------------------------------------------------------------------------------------
// MEMBERSHIP — which FLOWER's tube an element is in, for `derive.ts`
// ---------------------------------------------------------------------------------------------

/**
 * How far ABOVE `BB_FLOWER_TOP_Z` an element's CENTRE may sit and still be read as "in the
 * tube". Fig 10-5's case D/H is a NECTAR held on the BACKSTOP above the top ring, partially
 * inside the scoring volume and therefore scoring — so a band that stopped at the top plate
 * would drop exactly the case the figure exists to name. One nectar DIAMETER is the height a
 * nectar resting on top of a full column reaches.
 */
export const FLOWER_TUBE_TOP_MARGIN = 2 * BB_NECTAR_R;

/** the bottom of the tube's membership band — the lower plate's own underside, so an element
 * resting on the TILES inside the lower bore (which is what a POLLEN does: the bore is 3.222
 * and a pollen is 2.8) is still in the flower rather than loose on the floor. */
export const FLOWER_TUBE_BOTTOM_Z = -1;

/**
 * Which FLOWER's tube contains the point `(x, y, zCentre)`, or `null`.
 *
 * The test is the BORE, not the plate: an element is in the tube when it is within the top
 * plate's own bore radius of the flower's axis and its centre is between the lower plate's
 * underside and one nectar-diameter above the top plate. `BB_FLOWER_OPEN_R` (the top bore) is
 * the widest of the three, so an element passing any plate is inside this cylinder by
 * construction, and an element on the TILES beside the flower is 2.6 in outside it.
 *
 * Deliberately NOT a read of the physics contact set: membership is a question about WHERE a
 * body is, the same way `derive.ts`'s cell test is, and a contact-based answer would flicker on
 * the tick an element is in free fall between two plates.
 */
export function flowerTubeOf(x: number, y: number, zCentre: number): number | null {
  if (zCentre < FLOWER_TUBE_BOTTOM_Z || zCentre > BB_FLOWER_TOP_Z + FLOWER_TUBE_TOP_MARGIN) return null;
  for (let i = 0; i < BB_FLOWERS.length; i++) {
    const f = BB_FLOWERS[i];
    const dx = x - f.x;
    const dy = y - f.y;
    if (dx * dx + dy * dy <= BB_FLOWER_OPEN_R * BB_FLOWER_OPEN_R) return i;
  }
  return null;
}

/** is this element's centre inside the RETRIEVAL OPENING's own z band (`BB_FLOWER_RETRIEVE_Z`,
 * 0.354 … 3.904)? G418.B's bottom-pop takes the lowest POLLEN, and "lowest" has to mean "low
 * enough to actually be at the opening" once the column is a physical stack. */
export function flowerAtRetrieval(zCentre: number): boolean {
  return zCentre >= BB_FLOWER_RETRIEVE_Z[0] && zCentre <= BB_FLOWER_RETRIEVE_Z[1];
}
