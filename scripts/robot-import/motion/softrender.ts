/**
 * A tiny software rasteriser for probe pictures: orthographic, z-buffered, flat-shaded triangles,
 * coloured per body, written as PNG with node's zlib. No GPU, no window.
 */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import type { MeshPart } from '../../../src/robotImport/geometry';

type V3 = [number, number, number];
const crossV = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normV = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export interface View {
  /** direction the camera looks along */
  dir: V3;
  up: V3;
  centre: V3;
  /** half the visible width, model units */
  half: number;
  w: number;
  h: number;
  /** clip: only triangles whose centroid depth (along dir, from centre) is within [near, far] */
  near?: number;
  far?: number;
}

/** colour per body: [r,g,b] 0..1, or null to draw in the part's own colour dimmed */
export type BodyColour = (body: number) => V3 | null;

export class Canvas {
  w: number;
  h: number;
  rgb: Uint8Array;
  z: Float32Array;
  constructor(w: number, h: number, bg: V3 = [1, 1, 1]) {
    this.w = w;
    this.h = h;
    this.rgb = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      this.rgb[3 * i] = bg[0] * 255;
      this.rgb[3 * i + 1] = bg[1] * 255;
      this.rgb[3 * i + 2] = bg[2] * 255;
    }
    this.z = new Float32Array(w * h).fill(Infinity);
  }

  draw(parts: readonly MeshPart[], v: View, colour: BodyColour, ox = 0, oy = 0, vw = this.w, vh = this.h): void {
    const d = normV(v.dir);
    const r = normV(crossV(d, v.up));
    const u = crossV(r, d);
    const s = vw / (2 * v.half);
    const cx = ox + vw / 2;
    const cy = oy + vh / 2;
    const near = v.near ?? -Infinity;
    const far = v.far ?? Infinity;
    const W = this.w;
    const P = new Float64Array(9);
    for (const p of parts) {
      const a = p.positions;
      const ix = p.indices;
      const nT = ix ? ix.length / 3 : a.length / 9;
      for (let t = 0; t < nT; t++) {
        let col: V3 | null = null;
        const i0 = ix ? ix[3 * t] : 3 * t;
        const b = p.body ? p.body[i0] : 0;
        col = colour(b);
        let base: V3;
        if (col) base = col;
        else base = [0.55 + 0.35 * p.color[0], 0.55 + 0.35 * p.color[1], 0.55 + 0.35 * p.color[2]];
        let dsum = 0;
        for (let k = 0; k < 3; k++) {
          const vi = ix ? ix[3 * t + k] : 3 * t + k;
          const x = a[3 * vi] - v.centre[0];
          const y = a[3 * vi + 1] - v.centre[1];
          const z = a[3 * vi + 2] - v.centre[2];
          P[3 * k] = cx + (x * r[0] + y * r[1] + z * r[2]) * s;
          P[3 * k + 1] = cy - (x * u[0] + y * u[1] + z * u[2]) * s;
          P[3 * k + 2] = x * d[0] + y * d[1] + z * d[2];
          dsum += P[3 * k + 2];
        }
        const dm = dsum / 3;
        if (dm < near || dm > far) continue;
        // face normal in view terms → shade
        const e1x = P[3] - P[0], e1y = P[4] - P[1];
        const e2x = P[6] - P[0], e2y = P[7] - P[1];
        const area = e1x * e2y - e1y * e2x;
        if (Math.abs(area) < 1e-9) continue;
        // world normal for shading
        const va = ix ? ix[3 * t] : 3 * t;
        const vb = ix ? ix[3 * t + 1] : 3 * t + 1;
        const vc = ix ? ix[3 * t + 2] : 3 * t + 2;
        const n = normV(crossV([a[3 * vb] - a[3 * va], a[3 * vb + 1] - a[3 * va + 1], a[3 * vb + 2] - a[3 * va + 2]], [a[3 * vc] - a[3 * va], a[3 * vc + 1] - a[3 * va + 1], a[3 * vc + 2] - a[3 * va + 2]]));
        const lit = 0.35 + 0.65 * Math.abs(n[0] * d[0] + n[1] * d[1] + n[2] * d[2]);
        const R = Math.min(255, base[0] * lit * 255);
        const G = Math.min(255, base[1] * lit * 255);
        const B = Math.min(255, base[2] * lit * 255);
        const minX = Math.max(ox, Math.floor(Math.min(P[0], P[3], P[6])));
        const maxX = Math.min(ox + vw - 1, Math.ceil(Math.max(P[0], P[3], P[6])));
        const minY = Math.max(oy, Math.floor(Math.min(P[1], P[4], P[7])));
        const maxY = Math.min(oy + vh - 1, Math.ceil(Math.max(P[1], P[4], P[7])));
        if (minX > maxX || minY > maxY) continue;
        const inv = 1 / area;
        for (let py = minY; py <= maxY; py++) {
          for (let px = minX; px <= maxX; px++) {
            const qx = px + 0.5;
            const qy = py + 0.5;
            const w0 = ((P[3] - qx) * (P[7] - qy) - (P[4] - qy) * (P[6] - qx)) * inv;
            const w1 = ((P[6] - qx) * (P[1] - qy) - (P[7] - qy) * (P[0] - qx)) * inv;
            const w2 = 1 - w0 - w1;
            if (w0 < 0 || w1 < 0 || w2 < 0) continue;
            const z = w0 * P[2] + w1 * P[5] + w2 * P[8];
            const o = py * W + px;
            if (z >= this.z[o]) continue;
            this.z[o] = z;
            this.rgb[3 * o] = R;
            this.rgb[3 * o + 1] = G;
            this.rgb[3 * o + 2] = B;
          }
        }
      }
    }
  }

  /** a filled rectangle (labels' backgrounds, separators) */
  rect(x: number, y: number, w: number, h: number, c: V3): void {
    for (let py = Math.max(0, y); py < Math.min(this.h, y + h); py++)
      for (let px = Math.max(0, x); px < Math.min(this.w, x + w); px++) {
        const o = py * this.w + px;
        this.rgb[3 * o] = c[0] * 255;
        this.rgb[3 * o + 1] = c[1] * 255;
        this.rgb[3 * o + 2] = c[2] * 255;
      }
  }

  png(file: string): void {
    const { w, h } = this;
    const raw = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) {
      raw[y * (w * 3 + 1)] = 0;
      Buffer.from(this.rgb.buffer, this.rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
    }
    const chunk = (type: string, data: Buffer): Buffer => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(td) >>> 0);
      return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]));
  }
}

let table: Int32Array | null = null;
function crc32(b: Buffer): number {
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < b.length; i++) c = table[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}
