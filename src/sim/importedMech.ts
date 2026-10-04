import type { ImportedEdge, ImportedRobot, RobotSpec, Vec2 } from '../types';
import * as C from '../config';
import { clamp } from '../math';
import { convexHull, polyArea, polyBounds, polyFeature, type Bounds } from './imported';

/**
 * MECHANISMS ON AN IMPORTED ROBOT — where its intake mouths, launcher and placer are, read off the
 * hull and `imported.mech` (`docs/robot-import-plan.md` §3.1, `docs/area/physics.md` "Imported
 * robots: mechanisms").
 *
 * The shared half: the half-plane clipping, the mouth resolver every game uses, the carve that
 * opens a mouth in the hull for the artifact solids, the placer ray, and DECODE's own mouth (DECODE
 * lives in `src/sim`). Each game's file reads these where it reads its own geometry, and EVERY
 * reader is behind `spec.imported`, so a standard robot never reaches this module.
 *
 * DOM-free, and imports only `types`, `config`, `math` and the `imported.ts` leaf, so a game's own
 * `config.ts` (which cannot import its `robot.ts`) may use it. NO TRIG: edge normals are exact
 * integer vectors, and everything else is +, −, ×, ÷ and `Math.sqrt`. NO CACHE: every answer is a
 * pure function of the spec, cheap enough (a ≤ 16-vertex hull, a handful of half-planes) to
 * recompute where it is read.
 */

// ─────────────────────────────────────────────────────────── polygon clipping ──

/** keep the part of a convex polygon where `n·p ≤ c` (Sutherland–Hodgman, one line); [] when
 *  less than a triangle is left. The output starts where the input does, so a polygon the line
 *  does not cut comes back vertex for vertex. */
export function clipHalf(poly: readonly Vec2[], nx: number, ny: number, c: number): Vec2[] {
  const out: Vec2[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    const fp = p.x * nx + p.y * ny - c;
    const fq = q.x * nx + q.y * ny - c;
    if (fp <= 0) out.push({ x: p.x, y: p.y });
    if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) {
      const t = fp / (fp - fq);
      out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    }
  }
  return out.length >= 3 ? out : [];
}

/** the intersection of two convex CCW polygons: `subject` clipped by each edge of `clip` */
export function clipConvex(subject: readonly Vec2[], clip: readonly Vec2[]): Vec2[] {
  let out: Vec2[] = subject.map((p) => ({ x: p.x, y: p.y }));
  for (let i = 0; i < clip.length && out.length > 0; i++) {
    const a = clip[i];
    const b = clip[(i + 1) % clip.length];
    // outward normal of a CCW edge is (ey, −ex); inside is n·p ≤ n·a
    const nx = b.y - a.y;
    const ny = -(b.x - a.x);
    if (nx === 0 && ny === 0) continue;
    out = clipHalf(out, nx, ny, nx * a.x + ny * a.y);
  }
  return out;
}

/** the largest `n·p` over a polygon */
export function supportAlong(poly: readonly Vec2[], n: Vec2): number {
  let s = -Infinity;
  for (const p of poly) s = Math.max(s, p.x * n.x + p.y * n.y);
  return s;
}

/** the polygon's cross-section on the line `n·x = u`, as the interval of `p·x` along it, or null
 *  when the line misses it */
export function chordAt(poly: readonly Vec2[], n: Vec2, p: Vec2, u: number): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  const k = poly.length;
  for (let i = 0; i < k; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % k];
    const ua = a.x * n.x + a.y * n.y - u;
    const ub = b.x * n.x + b.y * n.y - u;
    if (ua === 0) {
      const v = a.x * p.x + a.y * p.y;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    if ((ua < 0 && ub > 0) || (ua > 0 && ub < 0)) {
      const t = ua / (ua - ub);
      const v = (a.x + (b.x - a.x) * t) * p.x + (a.y + (b.y - a.y) * t) * p.y;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  return hi >= lo ? [lo, hi] : null;
}

/** where a ray from `o` along `d` leaves a convex CCW polygon (`o` itself when it never does) */
export function rayExit(poly: readonly Vec2[], o: Vec2, d: Vec2): Vec2 {
  let best = Infinity;
  const k = poly.length;
  for (let i = 0; i < k; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % k];
    const nx = b.y - a.y;
    const ny = -(b.x - a.x);
    const nd = nx * d.x + ny * d.y;
    if (nd <= 0) continue; // the ray runs along or into this edge's inside
    const t = (nx * (a.x - o.x) + ny * (a.y - o.y)) / nd;
    if (t >= 0 && t < best) best = t;
  }
  if (!(best < Infinity)) return { x: o.x, y: o.y };
  return { x: o.x + d.x * best, y: o.y + d.y * best };
}

/** a piece too small to be a collider: dropped BEFORE either solve or the pin test sees it, so a
 *  sliver Rapier refuses to hull can never be solid to `shapePenetration` and absent from a solve */
export const IMPORT_PIECE_MIN_AREA = 0.05;

function keep(poly: Vec2[]): Vec2[] | null {
  return poly.length >= 3 && polyArea(poly) >= IMPORT_PIECE_MIN_AREA ? poly : null;
}

// ─────────────────────────────────────────────────────────────── edge frames ──

/** the outward normal of each bounding-box edge, as exact integers */
export const IMPORT_EDGE_N: Record<ImportedEdge, Vec2> = {
  front: { x: 1, y: 0 },
  back: { x: -1, y: 0 },
  left: { x: 0, y: 1 },
  right: { x: 0, y: -1 },
};
/** its left-hand perpendicular — the `v` axis a mouth's span is measured along (BIOBUZZ's and
 *  Chain Reaction's `EDGE_PERP`, which these must equal) */
export const IMPORT_EDGE_P: Record<ImportedEdge, Vec2> = {
  front: { x: 0, y: 1 },
  back: { x: 0, y: -1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

/** a stored span (`from..to` along y for an end edge, x for a flank) as an interval of `v` */
export function spanToV(edge: ImportedEdge, from: number, to: number): [number, number] {
  return edge === 'front' || edge === 'right' ? [from, to] : [-to, -from];
}
/** ...and back */
export function vToSpan(edge: ImportedEdge, v0: number, v1: number): { from: number; to: number } {
  return edge === 'front' || edge === 'right' ? { from: v0, to: v1 } : { from: -v1, to: -v0 };
}

export function importBounds(imp: ImportedRobot): Bounds {
  return polyBounds(imp.hull);
}

// ─────────────────────────────────────────────────────────────── the mouths ──

/**
 * ONE INTAKE MOUTH on an imported robot, in its own edge frame: `u` outward along `n`, `v` across
 * along `p`, both robot-local. `uOut` is the roller line (where the hull ends inside the span,
 * less the archetype's protruding hardware), `face` the chassis face the preset's reach puts
 * behind it, `uIn` how far the capture rect bites back into the frame, and the span is
 * `vc ± half`.
 */
export interface ImportMouth {
  edge: ImportedEdge;
  n: Vec2;
  p: Vec2;
  uOut: number;
  face: number;
  uIn: number;
  vc: number;
  half: number;
  /** the hull is narrower at the face line than the game's narrowest mouth (validation: block) */
  cramped: boolean;
  /** a placed span was moved, narrowed or widened to fit (validation: warn) */
  clamped: boolean;
  /** came from a `mech.intakes` entry, not the default */
  placed: boolean;
}

export interface MouthGeom {
  /** roller line to chassis face, inches (the preset's `reach`) */
  reach: number;
  /** how far the capture rect bites behind the face (0 for DECODE, whose grab is the nip) */
  depth: number;
  /** archetype hardware standing past the roller line inside the CAD hull (BIOBUZZ side rollers) */
  protrude: number;
  minHalf: number;
  maxHalf: number;
  /** a default (unplaced) mouth's half-width about the face chord's middle; absent = the whole chord */
  defaultHalf?: number;
}

/**
 * Resolve the mouth on `edge`: the placed span (`mech.intakes`) or the default, fitted to the hull.
 * EXACTLY TWO PASSES, NO TOLERANCE (the BIOBUZZ turret solve's rule — a trip count decided by a
 * float comparison can differ between a client's prediction and the server): the roller line is
 * the hull's support inside the strip, the face sits `reach` behind it, and the span is fitted to
 * the hull's chord on the face line; then once more with the fitted span. The final roller line is
 * read off the final span.
 */
export function resolveImportMouth(imp: ImportedRobot, edge: ImportedEdge, g: MouthGeom): ImportMouth {
  const H = imp.hull;
  const n = IMPORT_EDGE_N[edge];
  const p = IMPORT_EDGE_P[edge];
  const entry = imp.mech?.intakes?.find((e) => e.edge === edge);
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const q of H) {
    const v = q.x * p.x + q.y * p.y;
    vMin = Math.min(vMin, v);
    vMax = Math.max(vMax, v);
  }
  let [a, b] = entry ? spanToV(edge, entry.from, entry.to) : [vMin, vMax];
  let cramped = false;
  const rollerLine = (lo: number, hi: number): number => {
    const strip = clipHalf(clipHalf(H, p.x, p.y, hi), -p.x, -p.y, -lo);
    return (strip.length > 0 ? supportAlong(strip, n) : supportAlong(H, n)) - g.protrude;
  };
  for (let pass = 0; pass < 2; pass++) {
    const face = rollerLine(a, b) - g.reach;
    const chord = chordAt(H, n, p, face) ?? [vMin, vMax];
    let lo = a;
    let hi = b;
    if (!entry && g.defaultHalf !== undefined && pass === 0) {
      const mid = (chord[0] + chord[1]) / 2;
      lo = mid - g.defaultHalf;
      hi = mid + g.defaultHalf;
    }
    lo = Math.max(lo, chord[0]);
    hi = Math.min(hi, chord[1]);
    if (!(hi > lo)) {
      lo = chord[0];
      hi = chord[1];
    }
    let half = (hi - lo) / 2;
    let vc = (hi + lo) / 2;
    if (half > g.maxHalf) half = g.maxHalf;
    cramped = false;
    if (half < g.minHalf) {
      const ch = (chord[1] - chord[0]) / 2;
      if (ch < g.minHalf) {
        half = ch;
        vc = (chord[0] + chord[1]) / 2;
        cramped = true;
      } else {
        half = g.minHalf;
        vc = clamp(vc, chord[0] + half, chord[1] - half);
      }
    }
    a = vc - half;
    b = vc + half;
  }
  const uOut = rollerLine(a, b);
  const face = uOut - g.reach;
  let clamped = false;
  if (entry) {
    const [e0, e1] = spanToV(edge, entry.from, entry.to);
    clamped = Math.abs(e0 - a) > 1e-6 || Math.abs(e1 - b) > 1e-6;
  }
  return {
    edge,
    n,
    p,
    uOut,
    face,
    // never past the robot's own centreline (`bbMouths`' flank rule, applied to every edge)
    uIn: Math.max(0.5, face - g.depth),
    vc: (a + b) / 2,
    half: (b - a) / 2,
    cramped,
    clamped,
    placed: !!entry,
  };
}

/** a mouth as the axis-aligned robot-local rect BIOBUZZ's and Chain Reaction's mouths are */
export function importMouthRect(m: ImportMouth): { x0: number; x1: number; y0: number; y1: number } {
  const v0 = m.vc - m.half;
  const v1 = m.vc + m.half;
  switch (m.edge) {
    case 'front':
      return { x0: m.uIn, x1: m.uOut, y0: v0, y1: v1 };
    case 'back':
      return { x0: -m.uOut, x1: -m.uIn, y0: -v1, y1: -v0 };
    case 'left':
      return { x0: -v1, x1: -v0, y0: m.uIn, y1: m.uOut };
    default:
      return { x0: v0, x1: v1, y0: -m.uOut, y1: -m.uIn };
  }
}

// ──────────────────────────────────────────────────────────────── the carve ──

/**
 * THE HULL WITH ITS MOUTHS OPEN — what on an imported robot is solid to a ground element.
 *
 * `chassis` is the hull behind every mouth's face (one convex polygon: the hull cut by one
 * half-plane per mouth); per mouth and side, the SIDE PLATE merged with whatever hull flanks the
 * mouth — the hull beyond the face, outboard of `half − t` from the mouth's centre. What is left
 * between the plates, in front of the face, is the open mouth (product decision #10: a roller rides
 * above element height and an element rolls in under it). For a hull that is a standard footprint
 * rectangle with the standard span this is exactly the standard chassis box and plates.
 */
export function carveImportPlates(
  hull: readonly Vec2[],
  mouths: readonly ImportMouth[],
  t: number,
): { chassis: Vec2[]; structure: Vec2[][] } {
  let chassis: Vec2[] = hull.map((p) => ({ x: p.x, y: p.y }));
  for (const m of mouths) chassis = clipHalf(chassis, m.n.x, m.n.y, m.face);
  const structure: Vec2[][] = [];
  for (const m of mouths) {
    const beyond = clipHalf(hull, -m.n.x, -m.n.y, -m.face);
    if (beyond.length === 0) continue;
    for (const s of [1, -1]) {
      // s·(p·x) ≥ s·vc + half − t
      const piece = keep(clipHalf(beyond, -s * m.p.x, -s * m.p.y, -(s * m.vc + m.half - t)));
      if (piece) structure.push(piece);
    }
  }
  return { chassis: keep(chassis) ?? hull.map((p) => ({ x: p.x, y: p.y })), structure };
}

// ──────────────────────────────────────────────────────────────── DECODE ──

/** DECODE's mouth on an imported robot (front edge only — its intake faces forward) */
export interface DecodeImportMouth {
  m: ImportMouth;
  /** the chassis face (`hl` on a standard robot) */
  face: number;
  /** the roller line (`hl + reach`) */
  tip: number;
  /** the mouth's lateral centre (0 on a standard robot) */
  yc: number;
  /** the roller axle (`intakeAxleX`) */
  axle: number;
  /** the preset's mouth with this robot's width */
  mouth: C.IntakeMouth;
}

/** DECODE mouth widths an import may have: a funnel keeps its throat plus 1.5 in, up to 9 */
export function decodeMouthHalfRange(intake: keyof typeof C.INTAKE_PRESETS): { min: number; max: number } {
  const m = C.INTAKE_PRESETS[intake].mouth;
  return m.wedge ? { min: m.throatHalf + 1.5, max: 9 } : { min: 5, max: 9 };
}

/**
 * The DECODE intake on an imported robot. The PRESET still owns the depth — reach, roller, nip,
 * lid, cadences, the lip — because every one of those was calibrated against it; the import moves
 * the mouth to where the hull ends inside its span and gives it that span's width (clamped to
 * `decodeMouthHalfRange`). A default mouth is the preset's own width (the vector row: the whole
 * chord) about the face chord's middle.
 */
export function decodeImportMouth(spec: RobotSpec): DecodeImportMouth {
  const imp = spec.imported!;
  const preset = C.INTAKE_PRESETS[spec.intake];
  const range = decodeMouthHalfRange(spec.intake);
  const m = resolveImportMouth(imp, 'front', {
    reach: preset.reach,
    depth: 0,
    protrude: 0,
    minHalf: range.min,
    maxHalf: range.max,
    defaultHalf: preset.mouth.wedge ? preset.mouth.mouthHalf : undefined,
  });
  const base = C.intakeMouth(spec);
  const mh = m.half;
  const th = Math.min(base.throatHalf, mh);
  const tip = m.uOut;
  const face = m.face;
  return {
    m,
    face,
    tip,
    yc: m.vc,
    axle: Math.max(face, tip - C.intakeRollerDia(spec) / 2),
    mouth: { ...base, mouthHalf: mh, throatHalf: th },
  };
}

/**
 * WHERE AN IMPORT'S DECODE INTAKE GRABS, robot-local, for the renderers: fore-aft the roller NIP
 * about this mouth's axle (`intakeNip` — the band `updateIntake` captures in, `axle − back` to
 * `axle + front`), across the mouth's own span (`yc ± mouthHalf`). Read only by drawing code; the
 * capture itself reads the same two terms where it always has.
 */
export function decodeImportGrabRect(spec: RobotSpec): { edge: 'front'; x0: number; x1: number; y0: number; y1: number } {
  const d = decodeImportMouth(spec);
  const nip = C.intakeNip(spec);
  return { edge: 'front', x0: d.axle - nip.back, x1: d.axle + nip.front, y0: d.yc - d.mouth.mouthHalf, y1: d.yc + d.mouth.mouthHalf };
}

/**
 * DECODE's artifact solids on an imported robot: the hull behind the face, and per side the
 * standard funnel wedge (sloped/triangle) or the hull flanking the mouth with its rail (vector).
 *
 * THE WEDGE is the standard quad `(face, yc±th) → (tip+lip, yc±mh') → (axle, yc±W) → (face, yc±W)`
 * (`W` = the hull's lateral reach beyond the mouth's centre on that side), clipped by the hull
 * grown forward by the lip — the lip pokes `INTAKE_LIP` past the roller line on a standard robot
 * too, outside the footprint, and it must survive the clip. Forward of the axle and outboard of
 * the mouth is OPEN, as on a standard robot (the opener blocks ride above ball height).
 */
export function decodeImportSolids(spec: RobotSpec): { chassis: Vec2[]; structure: Vec2[][] } {
  const imp = spec.imported!;
  // NO INTAKE: no mouth carves the hull, so the whole hull is chassis
  if (C.noIntake(spec)) return { chassis: imp.hull.map((p) => ({ x: p.x, y: p.y })), structure: [] };
  const d = decodeImportMouth(spec);
  if (!d.mouth.wedge) return carveImportPlates(imp.hull, [d.m], Math.min(C.INTAKE_RAIL_T, d.m.half));
  let chassis = clipHalf(imp.hull, 1, 0, d.face);
  if (chassis.length === 0) chassis = imp.hull.map((p) => ({ x: p.x, y: p.y }));
  const lip = C.INTAKE_LIP;
  const grown = convexHull([...imp.hull, ...imp.hull.map((p) => ({ x: p.x + lip, y: p.y }))]);
  const preset = C.INTAKE_PRESETS[spec.intake];
  const mh = d.mouth.mouthHalf;
  const th = d.mouth.throatHalf;
  const slope = (mh - th) / Math.max(preset.reach, 1e-6);
  const structure: Vec2[][] = [];
  for (const s of [1, -1]) {
    let W = 0;
    for (const q of imp.hull) W = Math.max(W, s * (q.y - d.yc));
    if (W <= th) continue;
    const mh2 = Math.min(mh + lip * slope, W);
    const pts: Vec2[] = [
      { x: d.face, y: d.yc + s * th },
      { x: d.tip + lip, y: d.yc + s * mh2 },
      { x: d.axle, y: d.yc + s * W },
      { x: d.face, y: d.yc + s * W },
    ];
    const quad = s > 0 ? pts : pts.reverse();
    const piece = keep(clipConvex(quad, grown));
    if (piece) structure.push(piece);
  }
  return { chassis: keep(chassis) ?? chassis, structure };
}

/** the polygon an imported robot's CHASSIS is to an artifact (`pointDepthInChassis`,
 *  `chassisCorners`) — DECODE's carve: the hull behind the intake face */
export function importChassisPoly(spec: RobotSpec): Vec2[] {
  return decodeImportSolids(spec).chassis;
}

/** DECODE's held-artifact slot on an import: the standard arrangement behind THIS mouth's roller
 *  line and on its centreline, each slot kept a radius inside the hull's rear on that line */
export function decodeImportHeldSlot(spec: RobotSpec, slot: number, side: number): Vec2 {
  const R = C.BALL_RADIUS;
  if (C.noIntake(spec)) {
    // NO INTAKE: the standard line of three on the robot's own centreline, the front one's skin at
    // the hull's front there; a hull too short for three 5-in balls packs them closer, never out
    // of its rear
    const ch = chordAt(spec.imported!.hull, { x: 0, y: 1 }, { x: 1, y: 0 }, 0) ?? [-R, R];
    const sp = clamp((ch[1] - ch[0] - 2 * R) / 2, 0, 2 * R);
    return { x: ch[1] - R - (2 - Math.min(Math.max(slot, 0), 2)) * sp, y: 0 };
  }
  const d = decodeImportMouth(spec);
  const back = chordAt(spec.imported!.hull, { x: 0, y: 1 }, { x: 1, y: 0 }, d.yc);
  const xMin = back ? back[0] + R : -Infinity;
  if (spec.intake === 'triangle') {
    if (slot <= 0) return { x: Math.max(d.face - 6, xMin), y: d.yc };
    return { x: Math.max(d.face, xMin), y: d.yc + (side || -1) * 2.7 };
  }
  const front = d.tip - R;
  const xs = [front - 4 * R, front - 2 * R, front];
  return { x: Math.max(xs[Math.min(Math.max(slot, 0), 2)], xMin), y: d.yc };
}

/** the lowest an import's DECODE shot may leave from: flight artifacts under `4R` run through the
 *  robot contact pass (`world.ts`), so a lower release would be pushed out of its own hull */
export const DECODE_IMPORT_LAUNCH_MIN = 4 * C.BALL_RADIUS + 0.5;

/** where an imported DECODE robot's turret is, robot-local: the placed shooter, else the standard
 *  rule (a sixth of the length behind the centre) on the hull's bounding box */
export function decodeImportTurret(spec: RobotSpec): Vec2 {
  const imp = spec.imported!;
  if (imp.mech?.shooter) return { x: imp.mech.shooter.x, y: imp.mech.shooter.y };
  const b = polyBounds(imp.hull);
  return { x: (b.minX + b.maxX) / 2 + (b.maxX - b.minX) * C.TURRET_OFFSET_FRAC, y: (b.minY + b.maxY) / 2 };
}

/** an imported DECODE robot's launch height */
export function decodeImportLaunchZ(spec: RobotSpec): number {
  const z = spec.imported!.mech?.shooter?.z;
  return z === undefined ? C.LAUNCH_HEIGHT : clamp(z, DECODE_IMPORT_LAUNCH_MIN, 18);
}

// ──────────────────────────────────────────────────────────────── placers ──

/**
 * Where a placer on an import REACHES: from its base (`mech.place`, else the hull's bounding-box
 * centre) along `dir` to where that ray leaves the hull, then `reach` further. A placer measured
 * from the hull's edge keeps the standard calibration ("flush on the foot = dead centre" for the
 * BIOBUZZ Box Tube), because the hull's edge is what meets the field.
 */
export function importPlaceExit(imp: ImportedRobot, dir: Vec2): Vec2 {
  const b = polyBounds(imp.hull);
  const base = imp.mech?.place ? { x: imp.mech.place.x, y: imp.mech.place.y } : { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  return rayExit(imp.hull, base, dir);
}

export function importPlacePoint(imp: ImportedRobot, dir: Vec2, reach: number): Vec2 {
  const e = importPlaceExit(imp, dir);
  return { x: e.x + dir.x * reach, y: e.y + dir.y * reach };
}

/** the hull's half-chord through `o` along `along`, measured to its NEARER end (a launch line or a
 *  rail centred on `o` stays inside the hull both ways) */
export function importHalfChordThrough(imp: ImportedRobot, o: Vec2, along: Vec2): number {
  const a = rayExit(imp.hull, o, along);
  const b = rayExit(imp.hull, o, { x: -along.x, y: -along.y });
  const da = (a.x - o.x) * along.x + (a.y - o.y) * along.y;
  const db = -((b.x - o.x) * along.x + (b.y - o.y) * along.y);
  return Math.max(0, Math.min(da, db));
}

/** signed depth of a robot-local point in the hull (+ inside) */
export function importDepth(imp: ImportedRobot, p: Vec2): number {
  return polyFeature(imp.hull, p).depth;
}
