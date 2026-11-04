/**
 * GEOMETRY KIT FOR THE GENERATED VENUES (2026-11-04): triangle soups in the FIELD frame (inches, z up,
 * `layout.ts`), with flat normals and box-projected UVs, built into per-material batches or into
 * reusable PARTS that are placed many times (the build turns a part placed often into one GPU-instanced
 * draw). Nothing here knows glTF: `generate.ts` writes it out.
 */

export type V3 = [number, number, number];

/** one material's triangles */
export class Geo {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  /** inches per UV unit for box-projected UVs (0: the material has no texture; UVs stay 0) */
  constructor(public uvIn = 0) {}

  get tris(): number {
    return this.idx.length / 3;
  }

  private vtx(p: V3, n: V3): number {
    const i = this.pos.length / 3;
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(n[0], n[1], n[2]);
    if (this.uvIn > 0) {
      // box projection on the dominant normal axis
      const ax = Math.abs(n[0]);
      const ay = Math.abs(n[1]);
      const az = Math.abs(n[2]);
      let u: number;
      let v: number;
      if (az >= ax && az >= ay) {
        u = p[0];
        v = p[1];
      } else if (ax >= ay) {
        u = p[1];
        v = p[2];
      } else {
        u = p[0];
        v = p[2];
      }
      this.uv.push(u / this.uvIn, v / this.uvIn);
    } else this.uv.push(0, 0);
    return i;
  }

  /** a planar polygon (convex, in order), one flat normal; `flip` reverses the winding */
  poly(pts: V3[], flip = false): void {
    const a = pts[0];
    let n: V3 = [0, 0, 0];
    for (let k = 1; k + 1 < pts.length; k++) {
      const b = pts[k];
      const c = pts[k + 1];
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      n = [n[0] + uy * vz - uz * vy, n[1] + uz * vx - ux * vz, n[2] + ux * vy - uy * vx];
    }
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    n = [n[0] / l, n[1] / l, n[2] / l];
    if (flip) n = [-n[0], -n[1], -n[2]];
    const base = pts.map((p) => this.vtx(p, n));
    for (let k = 1; k + 1 < base.length; k++) {
      if (flip) this.idx.push(base[0], base[k + 1], base[k]);
      else this.idx.push(base[0], base[k], base[k + 1]);
    }
  }

  /** append another soup, moved by `m` (a 3×4 row-major affine: x' = m0 x + m1 y + m2 z + m3, …) */
  append(o: Geo, m: number[] | null = null): void {
    const base = this.pos.length / 3;
    for (let i = 0; i < o.pos.length; i += 3) {
      const x = o.pos[i], y = o.pos[i + 1], z = o.pos[i + 2];
      const nx = o.nrm[i], ny = o.nrm[i + 1], nz = o.nrm[i + 2];
      if (m) {
        this.pos.push(m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]);
        this.nrm.push(m[0] * nx + m[1] * ny + m[2] * nz, m[4] * nx + m[5] * ny + m[6] * nz, m[8] * nx + m[9] * ny + m[10] * nz);
      } else {
        this.pos.push(x, y, z);
        this.nrm.push(nx, ny, nz);
      }
    }
    for (let i = 0; i < o.uv.length; i++) this.uv.push(o.uv[i]);
    for (const k of o.idx) this.idx.push(base + k);
  }

  bounds(minZ = -Infinity): { min: V3; max: V3 } | null {
    const min: V3 = [Infinity, Infinity, Infinity];
    const max: V3 = [-Infinity, -Infinity, -Infinity];
    let any = false;
    for (let i = 0; i < this.pos.length; i += 3) {
      if (this.pos[i + 2] < minZ) continue;
      any = true;
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], this.pos[i + k]);
        max[k] = Math.max(max[k], this.pos[i + k]);
      }
    }
    return any ? { min, max } : null;
  }
}

/** an axis-aligned box; `open` names faces to leave out ('-z' the bottom, etc.) */
export function box(g: Geo, lo: V3, hi: V3, open: readonly string[] = []): void {
  const [x0, y0, z0] = lo;
  const [x1, y1, z1] = hi;
  if (!open.includes('+z')) g.poly([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]);
  if (!open.includes('-z')) g.poly([[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]]);
  if (!open.includes('-y')) g.poly([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]);
  if (!open.includes('+y')) g.poly([[x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]]);
  if (!open.includes('-x')) g.poly([[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]]);
  if (!open.includes('+x')) g.poly([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]);
}

function sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
function addv(a: V3, b: V3, s = 1): V3 {
  return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
}

/** two unit vectors square to `d` and to each other */
function frame(d: V3): [V3, V3] {
  const up: V3 = Math.abs(d[2]) > 0.95 ? [1, 0, 0] : [0, 0, 1];
  const s = norm(cross(d, up));
  const t = norm(cross(s, d));
  return [s, t];
}

/** a rectangular member from `a` to `b`, `w` wide (horizontal, square to it) and `h` deep */
export function beam(g: Geo, a: V3, b: V3, w: number, h: number, caps = true): void {
  const d = norm(sub(b, a));
  const [s, t] = frame(d);
  const c = (p: V3, i: number, j: number): V3 => addv(addv(p, s, (i * w) / 2), t, (j * h) / 2);
  const A = [c(a, -1, -1), c(a, 1, -1), c(a, 1, 1), c(a, -1, 1)];
  const B = [c(b, -1, -1), c(b, 1, -1), c(b, 1, 1), c(b, -1, 1)];
  for (let k = 0; k < 4; k++) {
    const k1 = (k + 1) % 4;
    g.poly([A[k], A[k1], B[k1], B[k]], true);
  }
  if (caps) {
    g.poly([A[0], A[1], A[2], A[3]]);
    g.poly([B[3], B[2], B[1], B[0]]);
  }
}

/** a round member from `a` to `b`, radius `r`, `seg` sides */
export function cyl(g: Geo, a: V3, b: V3, r: number, seg = 12, caps = true): void {
  const d = norm(sub(b, a));
  const [s, t] = frame(d);
  const ring = (p: V3) =>
    Array.from({ length: seg }, (_, k) => {
      const th = (k / seg) * Math.PI * 2;
      return addv(addv(p, s, Math.cos(th) * r), t, Math.sin(th) * r);
    });
  const A = ring(a);
  const B = ring(b);
  for (let k = 0; k < seg; k++) {
    const k1 = (k + 1) % seg;
    g.poly([A[k], A[k1], B[k1], B[k]], true);
  }
  if (caps) {
    // a ring in order winds to −d (s × t = −d): as-is at `a`, reversed at `b`
    g.poly(A);
    g.poly([...B].reverse());
  }
}

/** a flat disc at `c` facing `n` */
export function disc(g: Geo, c: V3, n: V3, r: number, seg = 16): void {
  const [s, t] = frame(norm(n));
  const pts = Array.from({ length: seg }, (_, k) => {
    const th = (k / seg) * Math.PI * 2;
    return addv(addv(c, s, Math.cos(th) * r), t, Math.sin(th) * r);
  });
  // `frame` gives s × t = −n for this winding; reverse so the face looks along n
  const nn = norm(n);
  const test = cross(sub(pts[1], pts[0]), sub(pts[2], pts[0]));
  g.poly(test[0] * nn[0] + test[1] * nn[1] + test[2] * nn[2] >= 0 ? pts : pts.reverse());
}

/** a lat-long ellipsoid (radii `r`) at `c`, a HEAD facing +y: the faces over the crown and down the
 * back (−y) go into `hair`, the face and the lower front into `skin` */
export function ellipsoid(hair: Geo, skin: Geo, c: V3, r: V3, seg = 10, rings = 7): void {
  const p = (i: number, j: number): V3 => {
    const th = (i / rings) * Math.PI;
    const ph = (j / seg) * Math.PI * 2;
    return [c[0] + r[0] * Math.sin(th) * Math.cos(ph), c[1] + r[1] * Math.sin(th) * Math.sin(ph), c[2] + r[2] * Math.cos(th)];
  };
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < seg; j++) {
      const a = p(i, j), b = p(i + 1, j), d = p(i + 1, j + 1), e = p(i, j + 1);
      const dz = ((a[2] + b[2] + d[2]) / 3 - c[2]) / r[2];
      const dy = ((a[1] + b[1] + d[1]) / 3 - c[1]) / r[1];
      const g = dz > 0.45 || (dz > -0.35 && dy < 0.15) ? hair : skin;
      if (i === 0) g.poly([a, b, d]);
      else if (i === rings - 1) g.poly([a, b, e]);
      else g.poly([a, b, d, e]);
    }
  }
}

/**
 * PIPE-AND-DRAPE fabric along a straight run: a pleated sheet (alternating ±`depth`/2 every half
 * pleat), from `z0` to `z1`. One-sided triangles; the material is double-sided.
 */
export function drapeSheet(g: Geo, x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, pleat = 7, depth = 1.6): void {
  const L = Math.hypot(x1 - x0, y1 - y0);
  if (L < 1) return;
  const ux = (x1 - x0) / L;
  const uy = (y1 - y0) / L;
  const nx = -uy;
  const ny = ux;
  const n = Math.max(2, Math.round(L / (pleat / 2)));
  let prev: V3 | null = null;
  for (let i = 0; i <= n; i++) {
    const s = (i / n) * L;
    const off = (i % 2 ? 0.5 : -0.5) * depth;
    const p: V3 = [x0 + ux * s + nx * off, y0 + uy * s + ny * off, z0];
    if (prev) g.poly([prev, p, [p[0], p[1], z1], [prev[0], prev[1], z1]]);
    prev = p;
  }
}

/** a 3×4 affine for a turn `rot` about z then a move */
export function placeM(x: number, y: number, z: number, rot = 0): number[] {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return [c, -s, 0, x, s, c, 0, y, 0, 0, 1, z];
}
