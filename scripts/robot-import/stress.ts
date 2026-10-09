/**
 * A STRESS ROBOT at real-CAD scale, for measuring the importer (lane 9). Not a fixture: the files
 * are 30–250 MB, so they are written to a temp directory and never committed.
 *
 *   npx tsx scripts/robot-import/stress.ts [--out DIR] [--levels s,m,l] [--formats glb,glbflat,stl,step] [--breakdown]
 *
 * What a real FTC export carries and the synthetic fixture robot does not: goBILDA-style
 * U-channel with a hole every 8 mm (each hole is a wall and two rings of triangles), four mecanum
 * wheels of ten rollers each, hundreds of socket-head screws (threads modelled at the larger
 * levels, as some exporters do), hex standoffs, flanged bearings, a #25 chain of a hundred links
 * round two sprockets, a two-stage slide, an intake with spur gears and compliant star wheels,
 * motors, a hub and a battery. Hundreds of parts in a dozen colours.
 *
 * Canonical frame = the importer's robot-local frame: inches, +x front, +y left, +z up, floor at
 * z = 0, origin at the wheelbase centre. The wheels are at (±5.5, ±5.5) and touch the floor at
 * z = 0, so wheel detection has a known answer. Each format uses its own convention:
 *   GLB   metres, +Y up, front +Z (glTF), identical parts SHARED as one mesh under many nodes
 *   STL   millimetres, +Z up, front −Y (CAD), every instance written out (binary)
 *   STEP  millimetres, +Z up, front −Y, AP214 with ANALYTIC faces: cylinders, planes with
 *         circular holes, polygon prisms. occt tessellates it, so its triangle count is occt's.
 *         Threads and roller barrels are plain cylinders there (a STEP export carries cosmetic
 *         threads, not geometry).
 *
 * Levels (triangle counts are printed; the targets are the brief's 0.5 M / 1.5 M / 3–5 M):
 *   s  ≈ 0.5 M   m  ≈ 1.5 M   l  ≈ 4 M
 */
import { mkdirSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGlb } from '../../src/robotImport/shareFile';

type V3 = [number, number, number];
/** column-major 4×4, glTF layout */
type M4 = number[];

// ---- small linear algebra ---------------------------------------------------------------------

const I4 = (): M4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a: M4, b: M4): M4 {
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
const tr = (x: number, y: number, z: number): M4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
/** columns: where local x, y, z go */
const basis = (ex: V3, ey: V3, ez: V3, t: V3 = [0, 0, 0]): M4 => [ex[0], ex[1], ex[2], 0, ey[0], ey[1], ey[2], 0, ez[0], ez[1], ez[2], 0, t[0], t[1], t[2], 1];
const rotX = (a: number): M4 => basis([1, 0, 0], [0, Math.cos(a), Math.sin(a)], [0, -Math.sin(a), Math.cos(a)]);
const rotY = (a: number): M4 => basis([Math.cos(a), 0, -Math.sin(a)], [0, 1, 0], [Math.sin(a), 0, Math.cos(a)]);
const rotZ = (a: number): M4 => basis([Math.cos(a), Math.sin(a), 0], [-Math.sin(a), Math.cos(a), 0], [0, 0, 1]);
/** a proper (det +1) frame from local x and z; local y = z � x */
const frame = (ex: V3, ez: V3, t: V3): M4 => basis(ex, [ez[1] * ex[2] - ez[2] * ex[1], ez[2] * ex[0] - ez[0] * ex[2], ez[0] * ex[1] - ez[1] * ex[0]], ez, t);
const apply = (m: M4, v: V3): V3 => [
  m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
  m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
  m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
];
const applyDir = (m: M4, v: V3): V3 => [m[0] * v[0] + m[4] * v[1] + m[8] * v[2], m[1] * v[0] + m[5] * v[1] + m[9] * v[2], m[2] * v[0] + m[6] * v[1] + m[10] * v[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
/** the rigid inverse (rotation transposed) */
function invRigid(m: M4): M4 {
  const r = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
  const t: V3 = [m[12], m[13], m[14]];
  const o = basis([r[0], r[1], r[2]], [r[3], r[4], r[5]], [r[6], r[7], r[8]]);
  const it = applyDir(o, t);
  o[12] = -it[0];
  o[13] = -it[1];
  o[14] = -it[2];
  return o;
}

// ---- meshes (local inches) ----------------------------------------------------------------------

interface Mesh {
  pos: number[];
  idx: number[];
}
const mesh = (): Mesh => ({ pos: [], idx: [] });
const tris = (m: Mesh): number => m.idx.length / 3;

/** append `src` moved by `m` */
function add(dst: Mesh, src: Mesh, m: M4 = I4()): Mesh {
  const base = dst.pos.length / 3;
  for (let i = 0; i < src.pos.length; i += 3) dst.pos.push(...apply(m, [src.pos[i], src.pos[i + 1], src.pos[i + 2]]));
  const flip = det3(m) < 0;
  for (let i = 0; i < src.idx.length; i += 3) {
    if (flip) dst.idx.push(base + src.idx[i], base + src.idx[i + 2], base + src.idx[i + 1]);
    else dst.idx.push(base + src.idx[i], base + src.idx[i + 1], base + src.idx[i + 2]);
  }
  return dst;
}
const det3 = (m: M4): number => m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);

/**
 * Revolve profile STRIPS about local +z; each strip has its own vertices, so a corner between two
 * strips is sharp (the way a CAD exporter splits normals). A point with r = 0 is a single pole.
 * Outward winding for a profile that runs bottom → side → top with the solid on the axis side.
 */
function revolve(strips: [number, number][][], segs: number): Mesh {
  const m = mesh();
  for (const prof of strips) {
    const rows: number[][] = [];
    for (const [r, z] of prof) {
      const row: number[] = [];
      if (r === 0) {
        const id = m.pos.length / 3;
        m.pos.push(0, 0, z);
        for (let k = 0; k <= segs; k++) row.push(id);
      } else {
        for (let k = 0; k < segs; k++) {
          const a = (2 * Math.PI * k) / segs;
          row.push(m.pos.length / 3);
          m.pos.push(r * Math.cos(a), r * Math.sin(a), z);
        }
        row.push(row[0]);
      }
      rows.push(row);
    }
    for (let i = 0; i + 1 < rows.length; i++) {
      const A = rows[i];
      const B = rows[i + 1];
      for (let k = 0; k < segs; k++) {
        const a = A[k];
        const b = A[k + 1];
        const c = B[k + 1];
        const d = B[k];
        if (a !== b) m.idx.push(a, b, c);
        if (c !== d) m.idx.push(a, c, d);
      }
    }
  }
  return m;
}

const cylinder = (r: number, h: number, segs: number): Mesh =>
  revolve([[[0, 0], [r, 0]], [[r, 0], [r, h]], [[r, h], [0, h]]], segs);

const tube = (ro: number, ri: number, h: number, segs: number): Mesh =>
  revolve([[[ri, 0], [ro, 0]], [[ro, 0], [ro, h]], [[ro, h], [ri, h]], [[ri, h], [ri, 0]]], segs);

/** a polygon (CCW, star-shaped about its centroid) extruded along +z by h; flat sides */
function prism(outline: [number, number][], h: number): Mesh {
  const m = mesh();
  const n = outline.length;
  let cx = 0;
  let cy = 0;
  for (const [x, y] of outline) {
    cx += x / n;
    cy += y / n;
  }
  for (const [z, up] of [[0, false], [h, true]] as const) {
    const c = m.pos.length / 3;
    m.pos.push(cx, cy, z);
    for (const [x, y] of outline) m.pos.push(x, y, z);
    for (let k = 0; k < n; k++) {
      const a = c + 1 + k;
      const b = c + 1 + ((k + 1) % n);
      if (up) m.idx.push(c, a, b);
      else m.idx.push(c, b, a);
    }
  }
  for (let k = 0; k < n; k++) {
    const [x0, y0] = outline[k];
    const [x1, y1] = outline[(k + 1) % n];
    const b = m.pos.length / 3;
    m.pos.push(x0, y0, 0, x1, y1, 0, x1, y1, h, x0, y0, h);
    m.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  return m;
}

const rect = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const boxMesh = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Mesh => add(mesh(), prism(rect(x0, y0, x1, y1), z1 - z0), tr(0, 0, z0));

function roundRect(w: number, l: number, r: number, segs: number): [number, number][] {
  const out: [number, number][] = [];
  const c: [number, number, number][] = [[w / 2 - r, l / 2 - r, 0], [-w / 2 + r, l / 2 - r, 1], [-w / 2 + r, -l / 2 + r, 2], [w / 2 - r, -l / 2 + r, 3]];
  for (const [x, y, q] of c) for (let k = 0; k <= segs; k++) {
    const a = (Math.PI / 2) * (q + k / segs);
    out.push([x + r * Math.cos(a), y + r * Math.sin(a)]);
  }
  return out;
}

/** a stadium (chain plate): ends of radius a at x = 0 and x = p */
function stadium(p: number, a: number, segs: number): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 0; k <= segs; k++) {
    const t = -Math.PI / 2 + (Math.PI * k) / segs;
    out.push([p + a * Math.cos(t), a * Math.sin(t)]);
  }
  for (let k = 0; k <= segs; k++) {
    const t = Math.PI / 2 + (Math.PI * k) / segs;
    out.push([a * Math.cos(t), a * Math.sin(t)]);
  }
  return out;
}

/** a spur gear's outline: `teeth` teeth of module `mod`, `flank` points per flank */
function gearOutline(teeth: number, mod: number, flank: number): [number, number][] {
  const rp = (mod * teeth) / 2;
  const ro = rp + mod;
  const rr = rp - 1.25 * mod;
  const out: [number, number][] = [];
  const step = (2 * Math.PI) / teeth;
  for (let t = 0; t < teeth; t++) {
    const a0 = t * step;
    const pts: [number, number][] = [];
    // root, rising flank, tip, falling flank (a tooth narrows toward its tip)
    pts.push([rr, a0], [rr, a0 + step * 0.18]);
    for (let k = 0; k <= flank; k++) {
      const f = k / flank;
      pts.push([rr + (ro - rr) * f, a0 + step * (0.18 + 0.12 * f)]);
    }
    for (let k = 0; k <= flank; k++) {
      const f = 1 - k / flank;
      pts.push([rr + (ro - rr) * f, a0 + step * (0.7 - 0.12 * f)]);
    }
    pts.push([rr, a0 + step * 0.82]);
    for (const [r, a] of pts) out.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return out;
}

function starOutline(arms: number, ro: number, ri: number, perArm: number): [number, number][] {
  const out: [number, number][] = [];
  const n = arms * perArm;
  for (let k = 0; k < n; k++) {
    const a = (2 * Math.PI * k) / n;
    const f = (k % perArm) / perArm;
    const r = ri + (ro - ri) * Math.pow(Math.sin(Math.PI * f), 2);
    out.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return out;
}

/**
 * A plate lx × ly × t on z ∈ [0, t] whose cells of side `cell` each carry a hole of radius `hr`
 * (when `hole(i, j)`): each cell's top and bottom are the ring between its square and its circle
 * (the square sampled at the circle's angles, so a corner lands exactly on a sample when `segs` is
 * a multiple of 8), plus the hole's wall. The margin round the cell grid is plain.
 */
function perforated(lx: number, ly: number, t: number, cell: number, hr: number, segs: number, hole: (i: number, j: number) => boolean = () => true): Mesh {
  const m = mesh();
  const nx = Math.max(1, Math.floor(lx / cell));
  const ny = Math.max(1, Math.floor(ly / cell));
  const ox = (lx - nx * cell) / 2;
  const oy = (ly - ny * cell) / 2;
  const h = cell / 2;
  const quad = (a: V3, b: V3, c: V3, d: V3, up: boolean): void => {
    const i = m.pos.length / 3;
    m.pos.push(...a, ...b, ...c, ...d);
    if (up) m.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
    else m.idx.push(i, i + 2, i + 1, i, i + 3, i + 2);
  };
  // margins (top and bottom) and the outer rim
  for (const [z, up] of [[t, true], [0, false]] as const) {
    quad([0, 0, z], [lx, 0, z], [lx, oy, z], [0, oy, z], up);
    quad([0, ly - oy, z], [lx, ly - oy, z], [lx, ly, z], [0, ly, z], up);
    quad([0, oy, z], [ox, oy, z], [ox, ly - oy, z], [0, ly - oy, z], up);
    quad([lx - ox, oy, z], [lx, oy, z], [lx, ly - oy, z], [lx - ox, ly - oy, z], up);
  }
  quad([0, 0, 0], [lx, 0, 0], [lx, 0, t], [0, 0, t], true);
  quad([lx, 0, 0], [lx, ly, 0], [lx, ly, t], [lx, 0, t], true);
  quad([lx, ly, 0], [0, ly, 0], [0, ly, t], [lx, ly, t], true);
  quad([0, ly, 0], [0, 0, 0], [0, 0, t], [0, ly, t], true);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const cx = ox + (i + 0.5) * cell;
      const cy = oy + (j + 0.5) * cell;
      if (!hole(i, j)) {
        quad([cx - h, cy - h, t], [cx + h, cy - h, t], [cx + h, cy + h, t], [cx - h, cy + h, t], true);
        quad([cx - h, cy - h, 0], [cx + h, cy - h, 0], [cx + h, cy + h, 0], [cx - h, cy + h, 0], false);
        continue;
      }
      for (const [z, up] of [[t, true], [0, false]] as const) {
        const sq = m.pos.length / 3;
        for (let k = 0; k < segs; k++) {
          const a = (2 * Math.PI * k) / segs;
          const s = h / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)));
          m.pos.push(cx + s * Math.cos(a), cy + s * Math.sin(a), z);
        }
        const ci = m.pos.length / 3;
        for (let k = 0; k < segs; k++) {
          const a = (2 * Math.PI * k) / segs;
          m.pos.push(cx + hr * Math.cos(a), cy + hr * Math.sin(a), z);
        }
        for (let k = 0; k < segs; k++) {
          const k1 = (k + 1) % segs;
          // ring between the square (outside) and the circle (inside), facing ±z
          if (up) m.idx.push(sq + k, sq + k1, ci + k1, sq + k, ci + k1, ci + k);
          else m.idx.push(sq + k, ci + k1, sq + k1, sq + k, ci + k, ci + k1);
        }
      }
      // the hole's wall faces the axis
      const w = m.pos.length / 3;
      for (let k = 0; k < segs; k++) {
        const a = (2 * Math.PI * k) / segs;
        m.pos.push(cx + hr * Math.cos(a), cy + hr * Math.sin(a), 0, cx + hr * Math.cos(a), cy + hr * Math.sin(a), t);
      }
      for (let k = 0; k < segs; k++) {
        const k1 = (k + 1) % segs;
        m.idx.push(w + 2 * k, w + 2 * k + 1, w + 2 * k1 + 1, w + 2 * k, w + 2 * k1 + 1, w + 2 * k1);
      }
    }
  }
  return m;
}

/** a threaded shaft from z = 0 down to z = −len: a triangle-wave helix on radius r */
function threadedShaft(r: number, depth: number, pitch: number, len: number, segs: number, perPitch: number): Mesh {
  const m = mesh();
  const rings = Math.max(2, Math.round((len / pitch) * perPitch) + 1);
  const rows: number[] = [];
  for (let i = 0; i < rings; i++) {
    const z = -len + (len * i) / (rings - 1);
    rows.push(m.pos.length / 3);
    for (let k = 0; k < segs; k++) {
      const a = (2 * Math.PI * k) / segs;
      const u = (((a / (2 * Math.PI) + z / pitch) % 1) + 1) % 1;
      const rr = r - depth * Math.abs(2 * u - 1);
      m.pos.push(rr * Math.cos(a), rr * Math.sin(a), z);
    }
  }
  for (let i = 0; i + 1 < rings; i++) {
    for (let k = 0; k < segs; k++) {
      const k1 = (k + 1) % segs;
      const a = rows[i] + k;
      const b = rows[i] + k1;
      const c = rows[i + 1] + k1;
      const d = rows[i + 1] + k;
      m.idx.push(a, b, c, a, c, d);
    }
  }
  // the end cap, fanned
  const c = m.pos.length / 3;
  m.pos.push(0, 0, -len);
  for (let k = 0; k < segs; k++) m.idx.push(c, rows[0] + ((k + 1) % segs), rows[0] + k);
  return m;
}

// ---- the level presets --------------------------------------------------------------------------

interface Level {
  name: string;
  /** hole and small-cylinder segments (a multiple of 8) */
  holeSegs: number;
  /** larger round parts */
  roundSegs: number;
  roller: { segs: number; rings: number };
  /** null = plain shafts */
  thread: { segs: number; perPitch: number } | null;
  /** take every n-th channel hole for a screw */
  screwEvery: number;
  gearFlank: number;
  chainSegs: number;
}

export const LEVELS: Record<string, Level> = {
  s: { name: 's', holeSegs: 24, roundSegs: 32, roller: { segs: 32, rings: 12 }, thread: null, screwEvery: 3, gearFlank: 3, chainSegs: 8 },
  m: { name: 'm', holeSegs: 32, roundSegs: 48, roller: { segs: 48, rings: 24 }, thread: { segs: 24, perPitch: 6 }, screwEvery: 3, gearFlank: 5, chainSegs: 12 },
  l: { name: 'l', holeSegs: 48, roundSegs: 96, roller: { segs: 64, rings: 40 }, thread: { segs: 40, perPitch: 8 }, screwEvery: 2, gearFlank: 8, chainSegs: 16 },
};

// ---- the assembly -------------------------------------------------------------------------------

/** sRGB 0..1 */
const C = {
  alu: [0.76, 0.77, 0.79] as V3,
  dark: [0.2, 0.21, 0.23] as V3,
  steel: [0.1, 0.1, 0.11] as V3,
  rubber: [0.05, 0.05, 0.06] as V3,
  motor: [0.13, 0.13, 0.14] as V3,
  hub: [0.15, 0.35, 0.85] as V3,
  battery: [0.85, 0.2, 0.15] as V3,
  printed: [0.95, 0.5, 0.1] as V3,
  green: [0.2, 0.7, 0.3] as V3,
  chain: [0.45, 0.46, 0.48] as V3,
  brass: [0.8, 0.65, 0.3] as V3,
  nylon: [0.92, 0.92, 0.9] as V3,
};

/** one template (a part's geometry), placed by many instances */
interface Template {
  name: string;
  color: V3;
  mesh: Mesh;
  /** the same part as analytic STEP solids, in the part's local frame */
  step: StepSolid[];
}
interface Instance {
  t: Template;
  m: M4;
}

type StepSolid =
  | { kind: 'cyl'; r: number; h: number; at: M4 }
  | { kind: 'prism'; outline: [number, number][]; h: number; at: M4 }
  | { kind: 'plate'; lx: number; ly: number; t: number; holes: [number, number, number][]; at: M4 };

const WHEEL_R = 104 / 25.4 / 2;
const WHEEL_X = 5.5;
const WHEEL_Y = 5.5;

export function buildRobot(L: Level): { templates: Template[]; instances: Instance[] } {
  const templates: Template[] = [];
  const instances: Instance[] = [];
  const tpl = (name: string, color: V3, m: Mesh, step: StepSolid[]): Template => {
    const t = { name, color, mesh: m, step };
    templates.push(t);
    return t;
  };
  const put = (t: Template, m: M4): void => void instances.push({ t, m });

  // -- U-channel: three perforated plates (web + two flanges), length along local x --
  const CH = 1.5; // 48 mm-ish
  const CT = 0.1;
  const CELL = 0.315; // 8 mm
  const HOLE_R = 0.081; // 4.1 mm hole
  const plateStep = (lx: number, ly: number, at: M4, hole: (i: number, j: number) => boolean = () => true): StepSolid => {
    const nx = Math.floor(lx / CELL);
    const ny = Math.floor(ly / CELL);
    const ox = (lx - nx * CELL) / 2;
    const oy = (ly - ny * CELL) / 2;
    const holes: [number, number, number][] = [];
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) if (hole(i, j)) holes.push([ox + (i + 0.5) * CELL, oy + (j + 0.5) * CELL, HOLE_R]);
    return { kind: 'plate', lx, ly, t: CT, holes, at };
  };
  // a goBILDA pattern: the middle rows of each face, not every cell
  const pattern = (i: number, j: number, ny: number): boolean => j >= 1 && j < ny - 1 && i % 7 !== 3;
  function channel(name: string, len: number): Template {
    const ny = Math.floor(CH / CELL);
    const h = (i: number, j: number): boolean => pattern(i, j, ny);
    const m = mesh();
    // web on z ∈ [0, CT] spanning y ∈ [0, CH]; flanges standing up at y = 0 and y = CH
    const flangeAt = (y: number): M4 => mul(tr(0, y, 0), rotX(Math.PI / 2));
    add(m, perforated(len, CH, CT, CELL, HOLE_R, L.holeSegs, h));
    add(m, perforated(len, CH, CT, CELL, HOLE_R, L.holeSegs, h), flangeAt(CT));
    add(m, perforated(len, CH, CT, CELL, HOLE_R, L.holeSegs, h), flangeAt(CH));
    return tpl(name, C.alu, m, [plateStep(len, CH, I4(), h), plateStep(len, CH, flangeAt(CT), h), plateStep(len, CH, flangeAt(CH), h)]);
  }

  // drive rails: web vertical on the outside, flanges pointing in; x ∈ [−8, 8], z ∈ [1.3, 2.8]
  const rail = channel('drive_rail', 16);
  // local: x along, web plane = local xy, flanges toward +z. World: web in the x-z plane at y = ±7.85.
  // The right rail is the left one MIRRORED (det −1), as a CAD mirror feature exports it.
  put(rail, basis([1, 0, 0], [0, 0, 1], [0, -1, 0], [-8, 7.85, 1.3]));
  put(rail, basis([1, 0, 0], [0, 0, 1], [0, 1, 0], [-8, -7.85, 1.3]));
  // cross channels at x = ±7.2 and 0, web on the bottom (z = 1.3), between the wheels (|y| ≤ 4.6)
  const cross_ = channel('cross_channel', 9.2);
  for (const x of [7.2, 0, -7.2]) put(cross_, basis([0, 1, 0], [-1, 0, 0], [0, 0, 1], [x + CH / 2, -4.6, 1.3]));
  // slide: two stages of vertical channel at the back
  const slide1 = channel('slide_stage1', 13);
  const slide2 = channel('slide_stage2', 13.5);
  put(slide1, basis([0, 0, 1], [0, 1, 0], [-1, 0, 0], [-6.3, -0.75, 2.8]));
  put(slide2, basis([0, 0, 1], [0, 1, 0], [-1, 0, 0], [-6.3 + 0.12, -0.6, 3.4]));

  // deck plate on the rails
  {
    const lx = 11;
    const ly = 12.6;
    const m = perforated(lx, ly, 0.09, 0.5, 0.08, L.holeSegs, (i, j) => (i + j) % 3 !== 0);
    const t = tpl('deck', C.dark, m, [{ kind: 'plate', lx, ly, t: 0.09, holes: [], at: I4() }]);
    put(t, tr(-5, -6.3, 2.8));
  }
  // intake arms: perforated plates standing in the x-z plane at y = ±6
  {
    const lx = 2.0;
    const lz = 3.6;
    const m = perforated(lx, lz, 0.1, CELL, HOLE_R, L.holeSegs, (i, j) => (i + j) % 2 === 0);
    const t = tpl('intake_arm', C.alu, m, [plateStep(lx, lz, I4(), (i, j) => (i + j) % 2 === 0)]);
    put(t, basis([1, 0, 0], [0, 0, 1], [0, -1, 0], [7.6, 6.1, 0.9]));
    put(t, basis([1, 0, 0], [0, 0, 1], [0, -1, 0], [7.6, -6.0, 0.9]));
  }

  // -- mecanum wheels: hub plates, ten rollers, axles --
  {
    const rr = 0.45;
    const len = 1.15;
    const prof: [number, number][] = [];
    for (let i = 0; i <= L.roller.rings; i++) {
      const z = -len / 2 + (len * i) / L.roller.rings;
      prof.push([rr * Math.sqrt(Math.max(0.05, 1 - 0.55 * (2 * z / len) ** 2)), z]);
    }
    const capR = prof[0][0];
    const rollerMesh = revolve([[[0, -len / 2], [capR, -len / 2]], prof, [[capR, len / 2], [0, len / 2]]], L.roller.segs);
    const roller = tpl('mecanum_roller', C.rubber, rollerMesh, [{ kind: 'cyl', r: rr * 0.9, h: len, at: tr(0, 0, -len / 2) }]);
    const hubProfile: [number, number][][] = [[[0, 0], [1.55, 0]], [[1.55, 0], [1.55, 0.12]], [[1.55, 0.12], [0.5, 0.12]], [[0.5, 0.12], [0.5, 0.3]], [[0.5, 0.3], [0, 0.3]]];
    const hubPlate = tpl('mecanum_hub', C.dark, revolve(hubProfile, L.roundSegs), [{ kind: 'cyl', r: 1.55, h: 0.12, at: I4() }]);
    const axle = tpl('wheel_axle', C.steel, cylinder(0.157, 1.6, L.holeSegs), [{ kind: 'cyl', r: 0.157, h: 1.6, at: I4() }]);
    const N = 10;
    for (const sx of [1, -1]) {
      for (const sy of [1, -1]) {
        const cx = sx * WHEEL_X;
        const cy = sy * WHEEL_Y;
        const hand = sx * sy; // the X pattern
        for (let j = 0; j < N; j++) {
          const al = (2 * Math.PI * j) / N;
          const d: V3 = [Math.sin(al), 0, -Math.cos(al)];
          const t: V3 = [Math.cos(al), 0, Math.sin(al)];
          const ax = norm([t[0] * Math.SQRT1_2, hand * Math.SQRT1_2, t[2] * Math.SQRT1_2]);
          const ey = cross(ax, d);
          const c: V3 = [cx + (WHEEL_R - rr) * d[0], cy, WHEEL_R + (WHEEL_R - rr) * d[2]];
          put(roller, basis(d, ey, ax, c));
        }
        // hub plates either side of the rollers (local z → ±y)
        put(hubPlate, basis([1, 0, 0], [0, 0, 1], [0, -1, 0], [cx, cy + 0.72, WHEEL_R]));
        put(hubPlate, basis([1, 0, 0], [0, 0, -1], [0, 1, 0], [cx, cy - 0.72, WHEEL_R]));
        put(axle, frame([1, 0, 0], [0, sy, 0], [cx, cy - sy * 0.8, WHEEL_R]));
      }
    }
  }

  // -- bearings in the rails at the wheel axles --
  {
    const b = tpl('flanged_bearing', C.steel, revolve([[[0.157, 0], [0.3, 0]], [[0.3, 0], [0.3, 0.2]], [[0.3, 0.2], [0.4, 0.2]], [[0.4, 0.2], [0.4, 0.26]], [[0.4, 0.26], [0.157, 0.26]], [[0.157, 0.26], [0.157, 0]]], L.roundSegs), [{ kind: 'cyl', r: 0.4, h: 0.26, at: I4() }]);
    for (const sx of [1, -1]) for (const sy of [1, -1]) put(b, frame([1, 0, 0], [0, -sy, 0], [sx * WHEEL_X, sy * 7.85, WHEEL_R]));
  }

  // -- motors --
  {
    const body = tpl('motor', C.motor, add(add(cylinder(0.74, 2.3, L.roundSegs), boxMesh(-0.75, -0.75, 2.3, 0.75, 0.75, 3.1)), cylinder(0.157, 0.6, L.holeSegs), tr(0, 0, 3.1)), [
      { kind: 'cyl', r: 0.74, h: 2.3, at: I4() },
      { kind: 'prism', outline: rect(-0.75, -0.75, 0.75, 0.75), h: 0.8, at: tr(0, 0, 2.3) },
    ]);
    for (const sx of [1, -1]) for (const sy of [1, -1]) put(body, frame([1, 0, 0], [0, sy, 0], [sx * (WHEEL_X - 0.2), sy * 1.2, WHEEL_R]));
    // the slide motor and the intake motor
    put(body, basis([1, 0, 0], [0, 1, 0], [0, 0, 1], [-4, 3, 2.9]));
    put(body, basis([0, 1, 0], [0, 0, 1], [1, 0, 0], [3.5, -4.5, 3.6]));
  }

  // -- electronics --
  {
    const hubT = tpl('control_hub', C.hub, add(prism(roundRect(4.4, 4.3, 0.25, L.holeSegs / 4), 0.9), boxMesh(1.9, -1.8, 0.9, 2.1, 1.8, 1.0)), [{ kind: 'prism', outline: roundRect(4.4, 4.3, 0.25, 4), h: 0.9, at: I4() }]);
    put(hubT, tr(-1.5, 0, 2.9));
    const bat = tpl('battery', C.battery, prism(roundRect(6.3, 2.2, 0.15, L.holeSegs / 4), 1.4), [{ kind: 'prism', outline: rect(-3.15, -1.1, 3.15, 1.1), h: 1.4, at: I4() }]);
    put(bat, tr(2.2, 3.5, 2.9));
  }

  // -- standoffs under the deck corners and along it --
  {
    const hex: [number, number][] = Array.from({ length: 6 }, (_, k) => [0.14 * Math.cos((Math.PI * k) / 3), 0.14 * Math.sin((Math.PI * k) / 3)]);
    const so = tpl('standoff', C.alu, prism(hex, 1.2), [{ kind: 'prism', outline: hex, h: 1.2, at: I4() }]);
    for (let i = 0; i < 10; i++) for (const y of [-6, -2.25, 2.25, 6]) put(so, tr(-4.6 + i, y, 2.89));
  }

  // -- screws: socket head cap screws in every n-th rail and cross-channel hole --
  {
    const headR = 0.136;
    const headH = 0.157;
    const shaftR = 0.0787;
    const len = 0.47;
    const head = revolve([[[shaftR, 0], [headR, 0]], [[headR, 0], [headR, headH]], [[headR, headH], [0.07, headH]], [[0.07, headH], [0.07, headH - 0.08]], [[0.07, headH - 0.08], [0, headH - 0.08]]], L.holeSegs);
    const shaft = L.thread ? threadedShaft(shaftR, 0.012, 0.0276, len, L.thread.segs, L.thread.perPitch) : add(cylinder(shaftR, len, L.holeSegs), mesh(), I4());
    const screwMesh = add(mesh(), head);
    add(screwMesh, shaft, L.thread ? I4() : tr(0, 0, -len));
    const screwT = tpl('shcs_m4', C.steel, screwMesh, [
      { kind: 'cyl', r: headR, h: headH, at: I4() },
      { kind: 'cyl', r: shaftR, h: len, at: tr(0, 0, -len) },
    ]);
    // a nyloc nut on the far side of every screw: a hex with a bore, and the nylon ring
    const hexR = 0.157;
    const hex: [number, number][] = Array.from({ length: 6 }, (_, k) => [hexR * Math.cos((Math.PI * k) / 3 + Math.PI / 6), hexR * Math.sin((Math.PI * k) / 3 + Math.PI / 6)]);
    const nutMesh = add(add(prism(hex, 0.125), tube(0.13, 0.08, 0.06, L.holeSegs), tr(0, 0, 0.125)), tube(0.0787, 0.07, 0.125, L.holeSegs));
    const nutT = tpl('nyloc_m4', C.steel, nutMesh, [{ kind: 'prism', outline: hex, h: 0.125, at: I4() }]);
    // the nut sits on the shaft, 0.3 in below the head, facing the same way
    const putScrew = (m: M4): void => {
      put(screwT, m);
      put(nutT, mul(m, tr(0, 0, -0.42)));
    };
    // drive rail webs: holes at x along, two rows, pointing in (−y on the left rail)
    let n = 0;
    for (const side of [1, -1]) {
      for (let i = 0; i < 50; i++) {
        if (i % L.screwEvery) continue;
        for (const zz of [0.6, 0.9]) {
          putScrew(frame([1, 0, 0], [0, side, 0], [-8 + 0.2 + i * CELL, side * 7.85, 1.3 + zz]));
          n++;
        }
      }
    }
    // cross channels: two rows on the web, pointing down
    for (const x of [7.2, 0, -7.2]) {
      for (let i = 0; i < 29; i++) {
        if (i % L.screwEvery) continue;
        for (const dx of [-0.35, 0.35]) {
          putScrew(basis([1, 0, 0], [0, -1, 0], [0, 0, -1], [x + dx, -4.45 + i * CELL, 1.3]));
          n++;
        }
      }
    }
    // standoff screws through the deck
    for (let i = 0; i < 10; i++) for (const y of [-6, -2.25, 2.25, 6]) putScrew(tr(-4.6 + i, y, 4.09 + 0.09)), n++;
    // slide stages
    for (let i = 0; i < 40; i++) {
      if (i % L.screwEvery) continue;
      putScrew(basis([0, 1, 0], [0, 0, 1], [1, 0, 0], [-6.3 + 0.12, 0, 3.6 + i * CELL]));
      n++;
    }
    void n;
  }

  // -- chain: #25 round two 15-tooth sprockets on the slide --
  {
    const p = 0.25;
    const N = 15;
    const rp = p / (2 * Math.sin(Math.PI / N));
    const s1: V3 = [-5.2, 0.2, 4];
    const s2: V3 = [-5.2, 0.2, 15.6];
    const sprMesh = add(prism(gearOutline(N, (2 * rp) / N, Math.max(2, L.gearFlank - 1)), 0.11), tube(0.3, 0.157, 0.4, L.holeSegs), tr(0, 0, -0.15));
    const spr = tpl('sprocket_15t', C.steel, sprMesh, [{ kind: 'prism', outline: gearOutline(N, (2 * rp) / N, 1), h: 0.11, at: I4() }]);
    // sprocket plane = x-z, axis along y
    for (const s of [s1, s2]) put(spr, basis([1, 0, 0], [0, 0, 1], [0, -1, 0], [s[0], s[1] + 0.055, s[2]]));
    const plate = stadium(p, 0.11, L.chainSegs);
    const pin = cylinder(0.035, 0.31, L.chainSegs);
    const inner = add(add(add(mesh(), prism(plate, 0.03), tr(0, 0, 0.06)), prism(plate, 0.03), tr(0, 0, -0.09)), cylinder(0.06, 0.12, L.chainSegs), tr(0, 0, -0.06));
    add(inner, cylinder(0.06, 0.12, L.chainSegs), tr(p, 0, -0.06));
    const outer = add(add(add(mesh(), prism(plate, 0.03), tr(0, 0, 0.1)), prism(plate, 0.03), tr(0, 0, -0.13)), pin, tr(0, 0, -0.155));
    add(outer, pin, tr(p, 0, -0.155));
    const innerT = tpl('chain_inner', C.chain, inner, [{ kind: 'prism', outline: stadium(p, 0.11, 4), h: 0.03, at: tr(0, 0, 0.06) }, { kind: 'prism', outline: stadium(p, 0.11, 4), h: 0.03, at: tr(0, 0, -0.09) }]);
    const outerT = tpl('chain_outer', C.chain, outer, [{ kind: 'prism', outline: stadium(p, 0.11, 4), h: 0.03, at: tr(0, 0, 0.1) }, { kind: 'prism', outline: stadium(p, 0.11, 4), h: 0.03, at: tr(0, 0, -0.13) }]);
    // the loop's path in the x-z plane: up the front run, over the top, down the back, under the bottom
    const straight = s2[2] - s1[2];
    const total = 2 * straight + 2 * Math.PI * rp;
    const at = (s: number): V3 => {
      s = ((s % total) + total) % total;
      if (s < straight) return [s1[0] + rp, s1[1], s1[2] + s];
      s -= straight;
      if (s < Math.PI * rp) {
        const a = s / rp;
        return [s2[0] + rp * Math.cos(a), s1[1], s2[2] + rp * Math.sin(a)];
      }
      s -= Math.PI * rp;
      if (s < straight) return [s1[0] - rp, s1[1], s2[2] - s];
      s -= straight;
      const a = Math.PI + s / rp;
      return [s1[0] + rp * Math.cos(a), s1[1], s1[2] + rp * Math.sin(a)];
    };
    const links = Math.floor(total / p);
    for (let i = 0; i < links; i++) {
      const a = at(i * p);
      const b = at(i * p + p);
      const ex = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
      const ez: V3 = [0, 1, 0];
      put(i % 2 ? outerT : innerT, basis(ex, cross(ez, ex), ez, a));
    }
  }

  // -- intake: roller core with star wheels, a gear train on the left arm --
  {
    const core = tpl('intake_core', C.alu, cylinder(0.25, 12, L.roundSegs), [{ kind: 'cyl', r: 0.25, h: 12, at: I4() }]);
    put(core, basis([1, 0, 0], [0, 0, 1], [0, -1, 0], [8.8, 6, 1.2]));
    const star = starOutline(6, 0.7, 0.3, Math.max(4, L.roundSegs / 6));
    const starT = tpl('star_wheel', C.green, prism(star, 0.4), [{ kind: 'prism', outline: starOutline(6, 0.7, 0.3, 4), h: 0.4, at: I4() }]);
    for (let i = 0; i < 9; i++) put(starT, basis([1, 0, 0], [0, 0, 1], [0, -1, 0], [8.8, 5.2 - i * 1.3, 1.2]));
    const gears: [number, number, number][] = [[24, 8.8, 1.2], [36, 8.3, 2.7], [24, 8.6, 4.2]];
    for (const [teeth, x, z] of gears) {
      const outline = gearOutline(teeth, 0.05, L.gearFlank);
      const g = tpl(`gear_${teeth}t`, C.brass, add(prism(outline, 0.2), tube(0.25, 0.157, 0.35, L.holeSegs)), [{ kind: 'prism', outline: gearOutline(teeth, 0.05, 2), h: 0.2, at: I4() }]);
      put(g, basis([1, 0, 0], [0, 0, 1], [0, -1, 0], [x, 6.55, z]));
    }
    // a printed intake guard over the front
    const guard = tpl('intake_guard', C.printed, add(boxMesh(0, -6.2, 0, 0.12, 6.2, 2.4), boxMesh(-1.6, -6.2, 2.3, 0.12, 6.2, 2.42)), [{ kind: 'prism', outline: rect(0, -6.2, 0.12, 6.2), h: 2.4, at: I4() }]);
    put(guard, tr(9.6, 0, 2.6));
  }

  // -- the slide's end bracket and a scoring bucket on top --
  {
    const bucket = tpl('bucket', C.printed, add(add(boxMesh(-1.2, -2.4, 0, 1.2, 2.4, 0.1), boxMesh(-1.2, -2.4, 0, -1.1, 2.4, 1.6)), boxMesh(1.1, -2.4, 0, 1.2, 2.4, 1.6)), [{ kind: 'prism', outline: rect(-1.2, -2.4, 1.2, 2.4), h: 0.1, at: I4() }]);
    put(bucket, tr(-4.8, 0, 15.3));
    const tray = tpl('nylon_skid', C.nylon, boxMesh(-6.5, -0.4, 0, 6.5, 0.4, 0.25), [{ kind: 'prism', outline: rect(-6.5, -0.4, 6.5, 0.4), h: 0.25, at: I4() }]);
    put(tray, tr(0, 3.4, 1.05));
    put(tray, tr(0, -3.4, 1.05));
  }
  return { templates, instances };
}

// ---- writers ------------------------------------------------------------------------------------

const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
/** canonical inches → glTF metres, +Y up, front +Z, +X left (a proper rotation × 0.0254) */
const GLTF_FRAME: M4 = basis([0, 0, 0.0254], [0.0254, 0, 0], [0, 0.0254, 0]);
/** canonical inches → CAD millimetres, +Z up, front −Y */
const CAD_FRAME: M4 = basis([0, -25.4, 0], [25.4, 0, 0], [0, 0, 25.4]);

export function countTriangles(inst: readonly Instance[]): number {
  return inst.reduce((s, i) => s + tris(i.t.mesh), 0);
}

/**
 * Every part as the importer's `MeshPart` (what an STL-style loader hands the engine before merging),
 * in the CAD frame (millimetres, +Z up, front −Y), linear colour. For `npm test`, which measures the
 * small level in memory instead of reading a file.
 */
export function flatParts(robot: { instances: Instance[] }): { positions: Float32Array; indices: Uint32Array; color: [number, number, number]; name: string }[] {
  return robot.instances.map((inst) => {
    const M = mul(CAD_FRAME, inst.m);
    const m = inst.t.mesh;
    const positions = new Float32Array(m.pos.length);
    for (let i = 0; i < m.pos.length; i += 3) positions.set(apply(M, [m.pos[i], m.pos[i + 1], m.pos[i + 2]]), i);
    const indices = Uint32Array.from(m.idx);
    if (det3(M) < 0) for (let k = 0; k < indices.length; k += 3) [indices[k + 1], indices[k + 2]] = [indices[k + 2], indices[k + 1]];
    return { positions, indices, color: [lin(inst.t.color[0]), lin(inst.t.color[1]), lin(inst.t.color[2])], name: inst.t.name };
  });
}

function vertexNormals(m: Mesh): Float32Array {
  const n = new Float32Array(m.pos.length);
  for (let i = 0; i < m.idx.length; i += 3) {
    const a = m.idx[i] * 3;
    const b = m.idx[i + 1] * 3;
    const c = m.idx[i + 2] * 3;
    const u: V3 = [m.pos[b] - m.pos[a], m.pos[b + 1] - m.pos[a + 1], m.pos[b + 2] - m.pos[a + 2]];
    const v: V3 = [m.pos[c] - m.pos[a], m.pos[c + 1] - m.pos[a + 1], m.pos[c + 2] - m.pos[a + 2]];
    const f = cross(u, v);
    for (const o of [a, b, c]) for (let k = 0; k < 3; k++) n[o + k] += f[k];
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l;
    n[i + 1] /= l;
    n[i + 2] /= l;
  }
  return n;
}

/** GLB: one mesh per template (positions in metres, glTF axes, with normals), one node per instance */
export function writeGlb(templates: Template[], instances: Instance[]): Uint8Array {
  const F = GLTF_FRAME;
  // F = 0.0254·P with P a rotation: P is F/0.0254, and a node's matrix is P·T·Pᵀ with T's
  // translation in metres
  const P = F.map((v, i) => (i < 12 ? v / 0.0254 : v));
  const Pt = invRigid(P);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const views: unknown[] = [];
  const accessors: unknown[] = [];
  const pushView = (bytes: Uint8Array, target: number): number => {
    const pad = (4 - (offset % 4)) % 4;
    if (pad) {
      chunks.push(new Uint8Array(pad));
      offset += pad;
    }
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, target });
    chunks.push(bytes);
    offset += bytes.byteLength;
    return views.length - 1;
  };
  const colourIndex = new Map<string, number>();
  const materials: unknown[] = [];
  const meshes: unknown[] = [];
  const meshOf = new Map<Template, number>();
  for (const t of templates) {
    const key = t.color.join(',');
    let mat = colourIndex.get(key);
    if (mat === undefined) {
      mat = materials.length;
      colourIndex.set(key, mat);
      materials.push({ name: `c${mat}`, pbrMetallicRoughness: { baseColorFactor: [lin(t.color[0]), lin(t.color[1]), lin(t.color[2]), 1], metallicFactor: 0.2, roughnessFactor: 0.5 } });
    }
    const nV = t.mesh.pos.length / 3;
    const pos = new Float32Array(t.mesh.pos.length);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < nV; i++) {
      const v = apply(F, [t.mesh.pos[3 * i], t.mesh.pos[3 * i + 1], t.mesh.pos[3 * i + 2]]);
      pos.set(v, 3 * i);
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], pos[3 * i + k]);
        max[k] = Math.max(max[k], pos[3 * i + k]);
      }
    }
    const nrm0 = vertexNormals(t.mesh);
    const nrm = new Float32Array(nrm0.length);
    for (let i = 0; i < nV; i++) nrm.set(norm(applyDir(P, [nrm0[3 * i], nrm0[3 * i + 1], nrm0[3 * i + 2]])), 3 * i);
    const big = nV > 65535;
    const idx = big ? Uint32Array.from(t.mesh.idx) : Uint16Array.from(t.mesh.idx);
    const vp = pushView(new Uint8Array(pos.buffer), 34962);
    accessors.push({ bufferView: vp, componentType: 5126, count: nV, type: 'VEC3', min, max });
    const vn = pushView(new Uint8Array(nrm.buffer), 34962);
    accessors.push({ bufferView: vn, componentType: 5126, count: nV, type: 'VEC3' });
    const vi = pushView(new Uint8Array(idx.buffer), 34963);
    accessors.push({ bufferView: vi, componentType: big ? 5125 : 5123, count: idx.length, type: 'SCALAR' });
    meshOf.set(t, meshes.length);
    meshes.push({ name: t.name, primitives: [{ attributes: { POSITION: accessors.length - 3, NORMAL: accessors.length - 2 }, indices: accessors.length - 1, material: mat }] });
  }
  const nodes = instances.map((inst, i) => {
    const G = mul(mul(P, inst.m), Pt);
    for (let k = 12; k < 15; k++) G[k] *= 0.0254;
    return { name: `${inst.t.name}_${i}`, mesh: meshOf.get(inst.t), matrix: G.map((v) => Math.round(v * 1e9) / 1e9) };
  });
  const bin = new Uint8Array(offset);
  let at = 0;
  for (const c of chunks) {
    bin.set(c, at);
    at += c.length;
  }
  const json = {
    asset: { version: '2.0', generator: 'dsim robot-import stress' },
    scene: 0,
    scenes: [{ nodes: [nodes.length] }],
    nodes: [...nodes, { name: 'robot', children: nodes.map((_, i) => i) }],
    meshes,
    materials,
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: offset }],
  };
  return buildGlb(json, bin);
}

/** binary STL in millimetres, Z up, every instance written out; streamed to `file` */
export function writeStl(instances: Instance[], file: string): number {
  const total = countTriangles(instances);
  const fd = openSync(file, 'w');
  const head = Buffer.alloc(84);
  head.write('dsim robot-import stress, millimetres, Z up'.padEnd(80, ' '), 0, 'latin1');
  head.writeUInt32LE(total, 80);
  writeSync(fd, head);
  let bytes = 84;
  for (const inst of instances) {
    const M = mul(CAD_FRAME, inst.m);
    const m = inst.t.mesh;
    const w = Buffer.alloc((m.idx.length / 3) * 50);
    const P: number[] = [];
    for (let i = 0; i < m.pos.length; i += 3) P.push(...apply(M, [m.pos[i], m.pos[i + 1], m.pos[i + 2]]));
    let o = 0;
    for (let i = 0; i < m.idx.length; i += 3) {
      const a = m.idx[i] * 3;
      const b = m.idx[i + 1] * 3;
      const c = m.idx[i + 2] * 3;
      const n = norm(cross([P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]]));
      for (let k = 0; k < 3; k++) w.writeFloatLE(n[k], o + 4 * k);
      for (const [j, v] of [a, b, c].entries()) for (let k = 0; k < 3; k++) w.writeFloatLE(P[v + k], o + 12 + 12 * j + 4 * k);
      o += 50;
    }
    writeSync(fd, w);
    bytes += w.length;
  }
  closeSync(fd);
  return bytes;
}

/**
 * AP214 STEP with analytic faces: every instance's `step` solids, flattened (no assembly
 * structure), each MANIFOLD_SOLID_BREP with a STYLED_ITEM colour. Cylinders are three faces
 * (two planes and a CYLINDRICAL_SURFACE with a seam); a plate's holes are inner bounds on its two
 * planes plus a reversed cylindrical wall each; prisms are planar faces.
 */
export function writeStep(instances: Instance[]): string {
  const lines: string[] = [];
  let id = 0;
  const e = (s: string): number => {
    lines.push(`#${++id}=${s};`);
    return id;
  };
  const f = (v: number): string => {
    const r = Math.round(v * 1e5) / 1e5;
    const s = String(r === 0 ? 0 : r);
    return s.includes('.') || s.includes('e') ? s : `${s}.`;
  };
  const pt = (v: V3): number => e(`CARTESIAN_POINT('',(${f(v[0])},${f(v[1])},${f(v[2])}))`);
  const dirCache = new Map<string, number>();
  const dir = (v: V3): number => {
    const n = norm(v);
    const key = n.map((x) => f(x)).join(',');
    let d = dirCache.get(key);
    if (d === undefined) dirCache.set(key, (d = e(`DIRECTION('',(${key}))`)));
    return d;
  };
  const place = (o: V3, z: V3, x: V3): number => e(`AXIS2_PLACEMENT_3D('',#${pt(o)},#${dir(z)},#${dir(x)})`);
  const appCtx = e("APPLICATION_CONTEXT('automotive design')");
  e(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${appCtx})`);
  const prodCtx = e(`PRODUCT_CONTEXT('',#${appCtx},'mechanical')`);
  const prod = e(`PRODUCT('stress robot','stress robot','',(#${prodCtx}))`);
  const pdf = e(`PRODUCT_DEFINITION_FORMATION('','',#${prod})`);
  const pdc = e(`PRODUCT_DEFINITION_CONTEXT('part definition',#${appCtx},'design')`);
  const pd = e(`PRODUCT_DEFINITION('design','',#${pdf},#${pdc})`);
  const pds = e(`PRODUCT_DEFINITION_SHAPE('','',#${pd})`);
  const lenU = e('(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))');
  const angU = e('(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))');
  const solU = e('(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())');
  const unc = e(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),#${lenU},'distance_accuracy_value','confusion accuracy')`);
  const ctx = e(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${unc}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lenU},#${angU},#${solU}))REPRESENTATION_CONTEXT('Context #1','3D Context with UNIT and UNCERTAINTY'))`);
  const origin = place([0, 0, 0], [0, 0, 1], [1, 0, 0]);
  const solids: number[] = [];
  const styled: number[] = [];
  const styleOf = new Map<string, number>();
  const style = (c: V3): number => {
    const key = c.join(',');
    let s = styleOf.get(key);
    if (s === undefined) {
      const col = e(`COLOUR_RGB('',${f(c[0])},${f(c[1])},${f(c[2])})`);
      const fac = e(`FILL_AREA_STYLE_COLOUR('',#${col})`);
      const fas = e(`FILL_AREA_STYLE('',(#${fac}))`);
      const ssf = e(`SURFACE_STYLE_FILL_AREA(#${fas})`);
      const sss = e(`SURFACE_SIDE_STYLE('',(#${ssf}))`);
      const ssu = e(`SURFACE_STYLE_USAGE(.BOTH.,#${sss})`);
      styleOf.set(key, (s = e(`PRESENTATION_STYLE_ASSIGNMENT((#${ssu}))`)));
    }
    return s;
  };
  const oe = (edge: number, same: boolean): number => e(`ORIENTED_EDGE('',*,*,#${edge},${same ? '.T.' : '.F.'})`);
  const loop = (edges: number[]): number => e(`EDGE_LOOP('',(${edges.map((x) => `#${x}`).join(',')}))`);
  /** a full circle edge (closed on one vertex) about `axis` through `c`, starting toward `ref` */
  const circleEdge = (c: V3, axis: V3, ref: V3, r: number): { edge: number; vertex: number; at: number } => {
    const pl = place(c, axis, ref);
    const circ = e(`CIRCLE('',#${pl},${f(r)})`);
    const p0: V3 = [c[0] + r * ref[0], c[1] + r * ref[1], c[2] + r * ref[2]];
    const vtx = e(`VERTEX_POINT('',#${pt(p0)})`);
    return { edge: e(`EDGE_CURVE('',#${vtx},#${vtx},#${circ},.T.)`), vertex: vtx, at: pl };
  };
  const lineEdge = (va: number, a: V3, vb: number, b: V3): number => {
    const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const vec = e(`VECTOR('',#${dir(d)},${f(Math.hypot(d[0], d[1], d[2]))})`);
    const ln = e(`LINE('',#${pt(a)},#${vec})`);
    return e(`EDGE_CURVE('',#${va},#${vb},#${ln},.T.)`);
  };
  const planeFace = (o: V3, n: V3, ref: V3, outer: number, inner: number[]): number => {
    const pl = e(`PLANE('',#${place(o, n, ref)})`);
    const bounds = [e(`FACE_OUTER_BOUND('',#${outer},.T.)`), ...inner.map((l) => e(`FACE_BOUND('',#${l},.T.)`))];
    return e(`ADVANCED_FACE('',(${bounds.map((b) => `#${b}`).join(',')}),#${pl},.T.)`);
  };
  const finish = (faces: number[], name: string, colour: V3): void => {
    const shell = e(`CLOSED_SHELL('',(${faces.map((x) => `#${x}`).join(',')}))`);
    const solid = e(`MANIFOLD_SOLID_BREP('${name}',#${shell})`);
    solids.push(solid);
    styled.push(e(`STYLED_ITEM('color',(#${style(colour)}),#${solid})`));
  };

  /** a cylinder of radius r and height h along `ax` from `c` (all CAD mm) */
  const cylinderSolid = (c: V3, ax: V3, ref: V3, r: number, h: number): number[] => {
    const top: V3 = [c[0] + h * ax[0], c[1] + h * ax[1], c[2] + h * ax[2]];
    const b = circleEdge(c, ax, ref, r);
    const t = circleEdge(top, ax, ref, r);
    const p0: V3 = [c[0] + r * ref[0], c[1] + r * ref[1], c[2] + r * ref[2]];
    const p1: V3 = [top[0] + r * ref[0], top[1] + r * ref[1], top[2] + r * ref[2]];
    const seam = lineEdge(b.vertex, p0, t.vertex, p1);
    const surf = e(`CYLINDRICAL_SURFACE('',#${b.at},${f(r)})`);
    const side = e(`ADVANCED_FACE('',(#${e(`FACE_OUTER_BOUND('',#${loop([oe(b.edge, true), oe(seam, true), oe(t.edge, false), oe(seam, false)])},.T.)`)}),#${surf},.T.)`);
    const topF = planeFace(top, ax, ref, loop([oe(t.edge, true)]), []);
    const botF = planeFace(c, [-ax[0], -ax[1], -ax[2]], ref, loop([oe(b.edge, false)]), []);
    return [side, topF, botF];
  };

  /** planar solid from a bottom polygon (CCW about +n) and an extrusion vector along n */
  const prismSolid = (base: V3[], ext: V3, holes: { c: V3; r: number }[] = [], refDir: V3 = [1, 0, 0]): number[] => {
    const n = base.length;
    const all = [...base, ...base.map((v): V3 => [v[0] + ext[0], v[1] + ext[1], v[2] + ext[2]])];
    const vp = all.map((v) => e(`VERTEX_POINT('',#${pt(v)})`));
    const edges = new Map<string, number>();
    const edge = (a: number, b: number): { ec: number; same: boolean } => {
      const s = Math.min(a, b);
      const t = Math.max(a, b);
      const key = `${s},${t}`;
      let ec = edges.get(key);
      if (ec === undefined) edges.set(key, (ec = lineEdge(vp[s], all[s], vp[t], all[t])));
      return { ec, same: a === s };
    };
    const face = (lp: number[], nrm: V3, inner: number[] = []): number => {
      const P = lp.map((k) => all[k]);
      const ref: V3 = norm([P[1][0] - P[0][0], P[1][1] - P[0][1], P[1][2] - P[0][2]]);
      const oes = lp.map((k, i) => {
        const { ec, same } = edge(k, lp[(i + 1) % lp.length]);
        return oe(ec, same);
      });
      return planeFace(P[0], nrm, ref, loop(oes), inner);
    };
    const up = norm(ext);
    const down: V3 = [-up[0], -up[1], -up[2]];
    // holes: a circle on each cap, a reversed cylindrical wall
    const topInner: number[] = [];
    const botInner: number[] = [];
    const walls: number[] = [];
    for (const h of holes) {
      const top: V3 = [h.c[0] + ext[0], h.c[1] + ext[1], h.c[2] + ext[2]];
      const b = circleEdge(h.c, up, refDir, h.r);
      const t = circleEdge(top, up, refDir, h.r);
      const p0: V3 = [h.c[0] + h.r * refDir[0], h.c[1] + h.r * refDir[1], h.c[2] + h.r * refDir[2]];
      const p1: V3 = [top[0] + h.r * refDir[0], top[1] + h.r * refDir[1], top[2] + h.r * refDir[2]];
      const seam = lineEdge(b.vertex, p0, t.vertex, p1);
      const surf = e(`CYLINDRICAL_SURFACE('',#${b.at},${f(h.r)})`);
      walls.push(e(`ADVANCED_FACE('',(#${e(`FACE_OUTER_BOUND('',#${loop([oe(b.edge, false), oe(seam, true), oe(t.edge, true), oe(seam, false)])},.T.)`)}),#${surf},.F.)`));
      topInner.push(loop([oe(t.edge, false)]));
      botInner.push(loop([oe(b.edge, true)]));
    }
    const faces: number[] = [];
    faces.push(face(Array.from({ length: n }, (_, k) => n + k), up, topInner));
    faces.push(face(Array.from({ length: n }, (_, k) => (n - k) % n), down, botInner));
    for (let k = 0; k < n; k++) {
      const a = all[k];
      const b = all[(k + 1) % n];
      const side = norm(cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], up));
      faces.push(face([k, (k + 1) % n, n + ((k + 1) % n), n + k], side));
    }
    return [...faces, ...walls];
  };

  for (const inst of instances) {
    for (const s of inst.t.step) {
      const M = mul(CAD_FRAME, mul(inst.m, s.at));
      const ex = norm(applyDir(M, [1, 0, 0]));
      const ez = norm(applyDir(M, [0, 0, 1]));
      // the outline is CCW about local +z; a mirrored instance (det < 0) turns it CW about M·z
      const ccw = <T,>(a: T[]): T[] => (det3(M) < 0 ? a.slice().reverse() : a);
      if (s.kind === 'cyl') {
        finish(cylinderSolid(apply(M, [0, 0, 0]), ez, ex, s.r * 25.4, s.h * 25.4), inst.t.name, inst.t.color);
      } else if (s.kind === 'prism') {
        const base = ccw(s.outline.map(([x, y]) => apply(M, [x, y, 0])));
        finish(prismSolid(base, applyDir(M, [0, 0, s.h])), inst.t.name, inst.t.color);
      } else {
        const base = ccw(rect(0, 0, s.lx, s.ly).map(([x, y]) => apply(M, [x, y, 0])));
        const holes = s.holes.map(([x, y, r]) => ({ c: apply(M, [x, y, 0]), r: r * 25.4 }));
        finish(prismSolid(base, applyDir(M, [0, 0, s.t]), holes, ex), inst.t.name, inst.t.color);
      }
    }
  }
  const rep = e(`ADVANCED_BREP_SHAPE_REPRESENTATION('',(#${origin},${solids.map((s) => `#${s}`).join(',')}),#${ctx})`);
  e(`SHAPE_DEFINITION_REPRESENTATION(#${pds},#${rep})`);
  e(`MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',(${styled.map((s) => `#${s}`).join(',')}),#${ctx})`);
  return ['ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION(('dsim robot-import stress'),'2;1');", "FILE_NAME('stress.step','2026-10-01T00:00:00',(''),(''),'dsim','dsim','');", "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));", 'ENDSEC;', 'DATA;', ...lines, 'ENDSEC;', 'END-ISO-10303-21;', ''].join('\n');
}

// ---- CLI ------------------------------------------------------------------------------------------

if (process.argv[1] && /stress\.ts$/.test(process.argv[1])) {
  const arg = (name: string, fallback: string): string => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
  };
  const out = arg('out', process.env.DSIM_STRESS_OUT || join(tmpdir(), 'dsim-robot-stress'));
  const levels = arg('levels', 's,m,l').split(',');
  const formats = arg('formats', 'glb,glbflat,stl,step').split(',');
  mkdirSync(out, { recursive: true });
  for (const lv of levels) {
    const L = LEVELS[lv];
    if (!L) throw new Error(`unknown level ${lv}`);
    const { templates, instances } = buildRobot(L);
    const n = countTriangles(instances);
    console.log(`level ${lv}: ${templates.length} part meshes, ${instances.length} parts, ${n.toLocaleString('en-US')} triangles`);
    if (process.argv.includes('--breakdown')) {
      for (const t of templates) {
        const k = instances.filter((i) => i.t === t).length;
        console.log(`  ${t.name.padEnd(18)} ${String(tris(t.mesh)).padStart(8)} × ${String(k).padStart(4)} = ${(tris(t.mesh) * k).toLocaleString('en-US')}`);
      }
    }
    if (formats.includes('glb')) {
      const glb = writeGlb(templates, instances);
      writeFileSync(join(out, `stress-${lv}.glb`), glb);
      console.log(`  stress-${lv}.glb  ${(glb.byteLength / 1048576).toFixed(1)} MB`);
    }
    if (formats.includes('glbflat')) {
      // every part its own mesh, vertices already in place (an exporter that shares nothing)
      const flatT: Template[] = instances.map((i, k) => ({ ...i.t, name: `${i.t.name}_${k}`, mesh: add(mesh(), i.t.mesh, i.m) }));
      const glb = writeGlb(flatT, flatT.map((t) => ({ t, m: I4() })));
      writeFileSync(join(out, `stress-${lv}-flat.glb`), glb);
      console.log(`  stress-${lv}-flat.glb  ${(glb.byteLength / 1048576).toFixed(1)} MB`);
    }
    if (formats.includes('stl')) {
      const bytes = writeStl(instances, join(out, `stress-${lv}.stl`));
      console.log(`  stress-${lv}.stl  ${(bytes / 1048576).toFixed(1)} MB`);
    }
    if (formats.includes('step')) {
      const text = writeStep(instances);
      writeFileSync(join(out, `stress-${lv}.step`), text);
      console.log(`  stress-${lv}.step ${(text.length / 1048576).toFixed(1)} MB`);
    }
  }
  console.log(`written to ${out}`);
}
