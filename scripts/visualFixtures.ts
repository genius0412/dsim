/**
 * FIXTURES for the visuals relay's checks (`scripts/smoke.ts` "visuals/…", `scripts/workersmoke.ts`):
 * a real PNG (proper CRCs, a deflated IDAT) and a real binary glTF (one buffer in the BIN chunk, no
 * URI, no images), each buildable at a chosen size, plus hooks to break them one way at a time.
 * Plain Node (`node:zlib`); nothing here is imported by the app.
 */
import { deflateSync } from 'node:zlib';

/** CRC-32 of `buf` (PNG's, over a chunk's type and data) */
export function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

const u32be = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/** one PNG chunk: length, type, data, CRC */
export function pngChunk(type: string, data: Uint8Array = new Uint8Array(0)): Uint8Array {
  const body = new Uint8Array(4 + data.length);
  body.set(ascii(type), 0);
  body.set(data, 4);
  return Uint8Array.from([...u32be(data.length), ...body, ...u32be(crc32(body))]);
}

/** a tiny deterministic generator, so a fixture is the same bytes every run */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PngOpts {
  /** fill the picture with noise (incompressible, so the file is about w·h·4 bytes) */
  noise?: boolean;
  seed?: number;
}

/** a valid RGBA PNG, w × h */
export function pngBytes(w = 8, h = 8, o: PngOpts = {}): Uint8Array {
  const rnd = prng(o.seed ?? 1);
  const raw = new Uint8Array(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 4);
    for (let x = 0; x < w * 4; x++) raw[row + 1 + x] = o.noise ? Math.floor(rnd() * 256) : (x * 7 + y) & 255;
  }
  const ihdr = Uint8Array.from([...u32be(w), ...u32be(h), 8, 6, 0, 0, 0]);
  const parts = [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND')];
  return concat(parts);
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** a GLB from a JSON object and a BIN payload, padded and length-stamped as the spec says */
export function glbFrom(json: unknown, bin: Uint8Array | null): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jl = (text.length + 3) & ~3;
  const bl = bin ? (bin.length + 3) & ~3 : 0;
  const total = 12 + 8 + jl + (bin ? 8 + bl : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jl, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + jl);
  if (bin) {
    dv.setUint32(20 + jl, bl, true);
    dv.setUint32(24 + jl, 0x004e4942, true);
    out.set(bin, 28 + jl);
  }
  return out;
}

export interface GlbOpts {
  /** triangles (3 float vertices each, not indexed): 36 bytes apiece */
  tris?: number;
  /** edit the glTF JSON before it is written, to break one rule */
  edit?: (json: Record<string, any>) => void;
}

/** a valid mesh GLB: one mesh, one material, positions in the BIN chunk, nothing external */
export function glbBytes(o: GlbOpts = {}): Uint8Array {
  const tris = o.tris ?? 1;
  const count = tris * 3;
  const bin = new Uint8Array(count * 12);
  const f = new Float32Array(bin.buffer);
  const rnd = prng(7);
  for (let i = 0; i < f.length; i++) f[i] = rnd();
  const json: Record<string, any> = {
    asset: { version: '2.0', generator: 'dsim-test' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'dsim_robot' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.5, 0.2, 0.1, 1], metallicFactor: 0.05, roughnessFactor: 0.55 } }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length, target: 34962 }],
    accessors: [{ bufferView: 0, componentType: 5126, count, type: 'VEC3' }],
  };
  o.edit?.(json);
  return glbFrom(json, bin);
}
