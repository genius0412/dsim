/**
 * PACK THE VENUE ROOM MESHES — stage 4, after `meshes.py` (see `scripts/venues/README.md`).
 *
 * Reads `scratch/venues-layers/<id>/mesh-<part>-{pos,idx}.npy` and writes `public/venues/<id>-room.glb`:
 * the four parts (`bg-lo`, `bg-hi`, `fg-lo`, `fg-hi`) simplified within `ERROR_IN` inches with their
 * borders locked (a room part meets its other half along the lens height, and a piece of furniture
 * keeps its silhouette), positions quantised to 16 bits over each part's largest side with the
 * dequantisation on the node (`KHR_mesh_quantization`), packed by meshoptimizer
 * (`EXT_meshopt_compression`) — the stored-robot GLB's format (`src/robotImport/engine/storedGlb.ts`),
 * which the scene's GLTFLoader already decodes. Positions only: the renderer looks the photograph up
 * along the ray from the lens, so a mesh needs no UVs and no normals.
 *
 *   npx tsx scripts/venues/pack.ts [--only quad]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MeshoptEncoder } from 'meshoptimizer/encoder';
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VENUES = ['school-hall', 'events-hall', 'hangar', 'court', 'quad'];
const PARTS = ['bg-lo', 'bg-hi', 'fg-lo', 'fg-hi'] as const;
/** how far a simplified surface may stand from the depth it came from, inches: the room is 200–900 in
 * out and its flat floor and walls collapse to a few triangles; furniture keeps a quarter-inch */
const ERROR_IN: Record<(typeof PARTS)[number], number> = { 'bg-lo': 0.5, 'bg-hi': 0.75, 'fg-lo': 0.25, 'fg-hi': 0.25 };
const POSITION_BITS = 16;

/** a little-endian .npy (version 1 or 2, C order) as its typed array */
function readNpy(path: string): Float32Array | Uint32Array {
  const buf = readFileSync(path);
  if (buf.readUInt32BE(0) !== 0x934e554d) throw new Error(`${path}: not an .npy`);
  const major = buf[6];
  const headerLen = major === 1 ? buf.readUInt16LE(8) : buf.readUInt32LE(8);
  const start = major === 1 ? 10 : 12;
  const header = buf.toString('latin1', start, start + headerLen);
  const descr = /'descr':\s*'([^']+)'/.exec(header)?.[1];
  if (/True/.test(/'fortran_order':\s*(\w+)/.exec(header)?.[1] ?? '')) throw new Error(`${path}: Fortran order`);
  const body = buf.subarray(start + headerLen);
  const copy = new Uint8Array(body.length);
  copy.set(body);
  if (descr === '<f4') return new Float32Array(copy.buffer);
  if (descr === '<u4') return new Uint32Array(copy.buffer);
  throw new Error(`${path}: dtype ${descr}`);
}

type Json = Record<string, unknown>;

function packVenue(venue: string): { bytes: number; tris: Record<string, number> } {
  const src = join(ROOT, 'scratch', 'venues-layers', venue);
  const chunks: Uint8Array[] = [];
  let packed = 0;
  let plain = 0;
  const bufferViews: Json[] = [];
  const accessors: Json[] = [];
  const meshes: Json[] = [];
  const nodes: Json[] = [];
  const tris: Record<string, number> = {};
  const qMax = 2 ** POSITION_BITS - 1;

  const view = (data: Uint8Array, count: number, stride: number, mode: 'ATTRIBUTES' | 'TRIANGLES'): number => {
    const bytes = MeshoptEncoder.encodeGltfBuffer(data, count, stride, mode);
    const at = packed;
    chunks.push(bytes);
    packed += bytes.length;
    const pad = (4 - (packed % 4)) % 4;
    if (pad) {
      chunks.push(new Uint8Array(pad));
      packed += pad;
    }
    const rawLength = count * stride;
    const v: Json = {
      buffer: 1,
      byteOffset: plain,
      byteLength: rawLength,
      extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: at, byteLength: bytes.length, byteStride: stride, count, mode } },
    };
    if (mode === 'ATTRIBUTES') {
      v.byteStride = stride;
      v.target = 34962;
    } else v.target = 34963;
    plain += rawLength + ((4 - (rawLength % 4)) % 4);
    bufferViews.push(v);
    return bufferViews.length - 1;
  };

  for (const part of PARTS) {
    const pos = readNpy(join(src, `mesh-${part}-pos.npy`)) as Float32Array;
    const raw = readNpy(join(src, `mesh-${part}-idx.npy`)) as Uint32Array;
    if (raw.length < 3) continue;
    const [simple] = MeshoptSimplifier.simplify(raw, pos, 3, 0, ERROR_IN[part], ['LockBorder', 'ErrorAbsolute']);
    const idx = Uint32Array.from(simple);
    const [remap, n] = MeshoptEncoder.reorderMesh(idx, true, true);
    const mn = [Infinity, Infinity, Infinity];
    const mx = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < remap.length; v++) {
      if (remap[v] === 0xffffffff) continue;
      for (let k = 0; k < 3; k++) {
        mn[k] = Math.min(mn[k], pos[3 * v + k]);
        mx[k] = Math.max(mx[k], pos[3 * v + k]);
      }
    }
    const step = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2], 1e-6) / qMax;
    const q = new Uint16Array(n * 4);
    const qmn = [qMax, qMax, qMax];
    const qmx = [0, 0, 0];
    for (let v = 0; v < remap.length; v++) {
      const o = remap[v];
      if (o === 0xffffffff) continue;
      for (let k = 0; k < 3; k++) {
        const x = Math.min(qMax, Math.max(0, Math.round((pos[3 * v + k] - mn[k]) / step)));
        q[4 * o + k] = x;
        qmn[k] = Math.min(qmn[k], x);
        qmx[k] = Math.max(qmx[k], x);
      }
    }
    accessors.push({ bufferView: view(new Uint8Array(q.buffer), n, 8, 'ATTRIBUTES'), componentType: 5123, count: n, type: 'VEC3', min: qmn, max: qmx });
    const position = accessors.length - 1;
    const short = n < 0xffff;
    const ib = short ? new Uint8Array(Uint16Array.from(idx).buffer) : new Uint8Array(idx.buffer);
    accessors.push({ bufferView: view(ib, idx.length, short ? 2 : 4, 'TRIANGLES'), componentType: short ? 5123 : 5125, count: idx.length, type: 'SCALAR' });
    meshes.push({ name: part, primitives: [{ attributes: { POSITION: position }, indices: accessors.length - 1, mode: 4 }] });
    nodes.push({ name: part, mesh: meshes.length - 1, translation: mn, scale: [step, step, step] });
    tris[part] = idx.length / 3;
  }

  const extensions = ['EXT_meshopt_compression', 'KHR_mesh_quantization'];
  const json: Json = {
    asset: { version: '2.0', generator: 'DSIM scripts/venues/pack.ts' },
    extensionsUsed: extensions,
    extensionsRequired: extensions,
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i), extras: { dsimVenue: { venue, version: 1 } } }],
    nodes,
    meshes,
    accessors,
    bufferViews,
    buffers: [{ byteLength: packed }, { byteLength: plain, extensions: { EXT_meshopt_compression: { fallback: true } } }],
  };
  const out = glb(json, chunks, packed);
  writeFileSync(join(ROOT, 'public', 'venues', `${venue}-room.glb`), out);
  return { bytes: out.length, tris };
}

/** the GLB container: header, the JSON chunk padded with spaces, the BIN chunk */
function glb(json: Json, chunks: readonly Uint8Array[], binBytes: number): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = (text.length + 3) & ~3;
  const binLen = (binBytes + 3) & ~3;
  const total = 12 + 8 + jsonLen + 8 + binLen;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + jsonLen);
  let at = 20 + jsonLen;
  dv.setUint32(at, binLen, true);
  dv.setUint32(at + 4, 0x004e4942, true);
  at += 8;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

async function main(): Promise<void> {
  await MeshoptEncoder.ready;
  await MeshoptSimplifier.ready;
  const i = process.argv.indexOf('--only');
  const only = i >= 0 ? process.argv[i + 1].split(',') : VENUES;
  for (const v of only) console.log(v, JSON.stringify(packVenue(v)));
}

void main();
