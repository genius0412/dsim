/**
 * THE STORED MESH, COMPRESSED: a `StoredScene` → a GLB with quantised attributes
 * (`KHR_mesh_quantization`) packed by meshoptimizer (`EXT_meshopt_compression`). GLTFExporter's float
 * GLB costs 44–48 bytes a triangle, so 4 MB held about 90k; this one costs about 9 at 250k and about
 * 5 on a whole CAD export (Full detail: goBILDA's 5.66M-triangle BIOBUZZ kit is 27 MB;
 * `docs/area/robot-import.md`, "Budgets").
 *
 * It holds what `exportStoredScene` holds: the static robot under the root node `dsim_robot`, each
 * moving part a node at its pivot with `extras.dsim` (`StoredMotion`), a rider under its carrier, one
 * material per colour with its finish (`finishOf`), normals and `_BODY`. Every mesh node carries its
 * own dequantisation (a translation and a uniform scale), so a reader that applies node transforms
 * (`readStoredScene`, `partsFromObject`, `importedMotionNodes`) reads it as it read the float one.
 *
 * Both extensions are REQUIRED and there is no float fallback in the file: the fallback would be the
 * float mesh again, the size this exists to avoid. Every DSIM reader sets three's meshopt decoder (the
 * scene's loader, `parse.ts`, `liteMesh`), and glTF viewers read both extensions.
 *
 * ⚠️ NEVER RELAYED AS IT IS. The room's validator (`src/net/visualCheck.ts`) refuses every extension,
 * and older clients and servers run it too, so a room is always sent `liteMesh`'s float GLB.
 *
 * three-free and DOM-free: the import worker runs it.
 */
import { finishOf } from '../finish';
import type { MeshPart } from '../geometry';
import type { StoredScene } from './bakeMesh';
import { safePartName } from './meshOps';

type Encoder = typeof import('meshoptimizer/encoder').MeshoptEncoder;

/**
 * Position bits per axis, over a mesh's largest side: 26 µm steps on a 43 cm part, against a
 * simplification error of 0.17 mm (p90) at 250k triangles. Measured on the REV and goBILDA kits at
 * 250k (bytes a triangle, read-back error): 16 bits 9.3–10.5 B and 0.006 mm; 14 bits 8.5–9.5 B and
 * 0.022 mm; 12 bits 7.7–8.8 B and 0.09 mm.
 */
export const STORED_POSITION_BITS = 14;
/**
 * Octahedral normal bits per component. 8 bits (one byte each): mean 0.3°, max 1.2° off the float
 * normal; 10 bits in 16-bit storage cost 12 % more for 0.1°. The renders do not tell them apart.
 */
export const STORED_NORMAL_BITS = 8;
/** the extensions every stored GLB names (and requires) */
export const STORED_GLB_EXTENSIONS = ['EXT_meshopt_compression', 'KHR_mesh_quantization'] as const;

let encoder: Promise<Encoder> | null = null;
/** the encoder chunk, fetched on the first write (a failed fetch is tried again next time) */
function loadEncoder(): Promise<Encoder> {
  encoder ??= import('./meshoptEncoder').then(
    async (m) => {
      await m.MeshoptEncoder.ready;
      return m.MeshoptEncoder;
    },
    (e: unknown) => {
      encoder = null;
      throw e;
    },
  );
  return encoder;
}

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

type Json = Record<string, unknown>;

/** area-weighted vertex normals, for a part that arrives without any */
function vertexNormals(pos: Float32Array, idx: Uint32Array): Float32Array {
  const n = new Float32Array(pos.length);
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = 3 * idx[t];
    const b = 3 * idx[t + 1];
    const c = 3 * idx[t + 2];
    const ux = pos[b] - pos[a];
    const uy = pos[b + 1] - pos[a + 1];
    const uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a];
    const vy = pos[c + 1] - pos[a + 1];
    const vz = pos[c + 2] - pos[a + 2];
    const x = uy * vz - uz * vy;
    const y = uz * vx - ux * vz;
    const z = ux * vy - uy * vx;
    for (const v of [a, b, c]) {
      n[v] += x;
      n[v + 1] += y;
      n[v + 2] += z;
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l;
    n[i + 1] /= l;
    n[i + 2] /= l;
  }
  return n;
}

/** what the writer needs to know about the bits, for a measurement that tries others */
export interface StoredGlbOptions {
  positionBits?: number;
  normalBits?: number;
}

/**
 * A stored scene → the compressed stored GLB. The scene is the one `exportStoredScene` takes:
 * stored frame, metres, `rest` absolute and each moving part's positions absolute too (they are
 * written relative to the part's pivot here, as the float writer does).
 */
export async function writeStoredGlb(scene: StoredScene, opts: StoredGlbOptions = {}): Promise<ArrayBuffer> {
  const enc = await loadEncoder();
  const posBits = opts.positionBits ?? STORED_POSITION_BITS;
  const nrmBits = opts.normalBits ?? STORED_NORMAL_BITS;
  const nrmStride = nrmBits > 8 ? 8 : 4;
  const qMax = 2 ** posBits - 1;

  const chunks: Uint8Array[] = [];
  let packed = 0; // bytes in buffer 0 (the BIN chunk: compressed)
  let plain = 0; // bytes in buffer 1 (the fallback the decoder fills: never in the file)
  const bufferViews: Json[] = [];
  const accessors: Json[] = [];
  const meshes: Json[] = [];
  const materials: Json[] = [];
  const nodes: Json[] = [];
  const materialOf = new Map<string, number>();

  /** one compressed buffer view; `rawLength` is what it decodes to */
  const view = (data: Uint8Array, count: number, stride: number, mode: 'ATTRIBUTES' | 'TRIANGLES', filter?: 'OCTAHEDRAL'): number => {
    const packedBytes = enc.encodeGltfBuffer(data, count, stride, mode);
    const at = packed;
    chunks.push(packedBytes);
    packed += packedBytes.length;
    const pad = (4 - (packed % 4)) % 4;
    if (pad) {
      chunks.push(new Uint8Array(pad));
      packed += pad;
    }
    const rawLength = count * stride;
    const ext: Json = { buffer: 0, byteOffset: at, byteLength: packedBytes.length, byteStride: stride, count, mode };
    if (filter) ext.filter = filter;
    const v: Json = { buffer: 1, byteOffset: plain, byteLength: rawLength, extensions: { EXT_meshopt_compression: ext } };
    if (mode === 'ATTRIBUTES') {
      v.byteStride = stride;
      v.target = ARRAY_BUFFER;
    } else {
      v.target = ELEMENT_ARRAY_BUFFER;
    }
    plain += rawLength + ((4 - (rawLength % 4)) % 4);
    bufferViews.push(v);
    return bufferViews.length - 1;
  };

  const materialFor = (c: readonly [number, number, number]): number => {
    const key = c.join();
    let m = materialOf.get(key);
    if (m === undefined) {
      const f = finishOf(c);
      m = materials.length;
      materials.push({ name: `colour_${m}`, pbrMetallicRoughness: { baseColorFactor: [c[0], c[1], c[2], 1], metallicFactor: f.metalness, roughnessFactor: f.roughness } });
      materialOf.set(key, m);
    }
    return m;
  };

  /** one part as a mesh node, positions taken relative to `origin`; null when it has no triangle */
  const partNode = (p: MeshPart, i: number, origin: readonly number[]): number | null => {
    const nV = Math.floor(p.positions.length / 3);
    const idx = p.indices ? Uint32Array.from(p.indices) : Uint32Array.from({ length: nV - (nV % 3) }, (_, k) => k);
    if (idx.length < 3 || nV < 3) return null;
    const normals = p.normals && p.normals.length === p.positions.length ? p.normals : vertexNormals(p.positions, idx);
    // vertex order for the codec (and the GPU's cache); `idx` is rewritten in place, unused vertices dropped
    const [remap, n] = enc.reorderMesh(idx, true, true);
    const mn = [Infinity, Infinity, Infinity];
    const mx = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < nV; v++) {
      if (remap[v] === 0xffffffff) continue;
      for (let k = 0; k < 3; k++) {
        const x = p.positions[3 * v + k] - origin[k];
        if (x < mn[k]) mn[k] = x;
        if (x > mx[k]) mx[k] = x;
      }
    }
    // ONE scale for the three axes: the node's transform stays a similarity, so normals need no fix-up
    const step = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2], 1e-9) / qMax;
    const pos = new Uint16Array(n * 4);
    const nrm = new Float32Array(n * 4);
    const body = p.body && p.body.length === nV ? new Uint32Array(n) : null;
    const qmn = [qMax, qMax, qMax];
    const qmx = [0, 0, 0];
    for (let v = 0; v < nV; v++) {
      const o = remap[v];
      if (o === 0xffffffff) continue;
      for (let k = 0; k < 3; k++) {
        const q = Math.min(qMax, Math.max(0, Math.round((p.positions[3 * v + k] - origin[k] - mn[k]) / step)));
        pos[4 * o + k] = q;
        if (q < qmn[k]) qmn[k] = q;
        if (q > qmx[k]) qmx[k] = q;
        nrm[4 * o + k] = normals[3 * v + k];
      }
      if (body) body[o] = p.body![v];
    }
    const attributes: Json = {};
    accessors.push({ bufferView: view(new Uint8Array(pos.buffer), n, 8, 'ATTRIBUTES'), componentType: 5123, count: n, type: 'VEC3', min: qmn, max: qmx });
    attributes.POSITION = accessors.length - 1;
    const oct = enc.encodeFilterOct(nrm, n, nrmStride, nrmBits);
    accessors.push({ bufferView: view(oct, n, nrmStride, 'ATTRIBUTES', 'OCTAHEDRAL'), componentType: nrmStride === 8 ? 5122 : 5120, normalized: true, count: n, type: 'VEC3' });
    attributes.NORMAL = accessors.length - 1;
    if (body) {
      accessors.push({ bufferView: view(new Uint8Array(body.buffer), n, 4, 'ATTRIBUTES'), componentType: 5125, count: n, type: 'SCALAR' });
      attributes._BODY = accessors.length - 1;
    }
    // 16-bit indices below 65,535 vertices (WebGL 2 reads 0xffff as a primitive restart)
    const short = n < 0xffff;
    const ib = short ? new Uint8Array(Uint16Array.from(idx).buffer) : new Uint8Array(idx.buffer);
    accessors.push({ bufferView: view(ib, idx.length, short ? 2 : 4, 'TRIANGLES'), componentType: short ? 5123 : 5125, count: idx.length, type: 'SCALAR' });
    meshes.push({ primitives: [{ attributes, indices: accessors.length - 1, material: materialFor(p.color), mode: 4 }] });
    nodes.push({ name: safePartName(p.name, i), mesh: meshes.length - 1, translation: [mn[0], mn[1], mn[2]], scale: [step, step, step] });
    return nodes.length - 1;
  };

  const meshNodes = (parts: readonly MeshPart[], origin: readonly number[]): number[] =>
    parts.map((p, i) => partNode(p, i, origin)).filter((k): k is number => k !== null);

  // the root and the static robot
  nodes.push({ name: 'dsim_robot' });
  const rootChildren = meshNodes(scene.rest, [0, 0, 0]);
  // each moving part at its pivot (relative to its carrier's), its riders nested in it; a parent that
  // is missing, itself, or more than eight deep drops the part to the root, as the float writer does
  const made = new Map<number, number>();
  const kids = new Map<number, number[]>();
  const make = (i: number, depth = 0): number | null => {
    const done = made.get(i);
    if (done !== undefined) return done;
    const m = scene.moving[i];
    if (!m || depth > 8) return null;
    const parent = m.parent >= 0 && m.parent !== i ? make(m.parent, depth + 1) : null;
    const base = parent !== null ? scene.moving[m.parent].pivot : [0, 0, 0];
    const k = nodes.length;
    nodes.push({ name: `dsim_motion_${i}_${m.info.role}`, translation: [m.pivot[0] - base[0], m.pivot[1] - base[1], m.pivot[2] - base[2]], extras: { dsim: m.info } });
    made.set(i, k);
    kids.set(k, meshNodes(m.parts, m.pivot));
    if (parent !== null) kids.get(parent)!.push(k);
    else rootChildren.push(k);
    return k;
  };
  for (let i = 0; i < scene.moving.length; i++) make(i);
  for (const [k, c] of kids) if (c.length) nodes[k].children = c;
  if (rootChildren.length) nodes[0].children = rootChildren;

  const json: Json = {
    asset: { version: '2.0', generator: 'DSIM importer' },
    extensionsUsed: [...STORED_GLB_EXTENSIONS],
    extensionsRequired: [...STORED_GLB_EXTENSIONS],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes,
    materials,
    meshes,
    accessors,
    bufferViews,
    buffers: [{ byteLength: packed }, { byteLength: plain, extensions: { EXT_meshopt_compression: { fallback: true } } }],
  };
  if (!meshes.length) {
    // nothing to draw: a file with no buffers at all, which every reader takes as an empty robot
    delete json.accessors;
    delete json.bufferViews;
    delete json.buffers;
    delete json.meshes;
    delete json.materials;
  }
  return glb(json, chunks, packed);
}

/** the GLB container: header, the JSON chunk padded with spaces, the BIN chunk */
function glb(json: Json, chunks: readonly Uint8Array[], binBytes: number): ArrayBuffer {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = (text.length + 3) & ~3;
  const binLen = (binBytes + 3) & ~3;
  const total = 12 + 8 + jsonLen + (binBytes ? 8 + binLen : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, CHUNK_JSON, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + jsonLen);
  if (binBytes) {
    let at = 20 + jsonLen;
    dv.setUint32(at, binLen, true);
    dv.setUint32(at + 4, CHUNK_BIN, true);
    at += 8;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
  }
  return out.buffer;
}

/** does this GLB's JSON name an extension (the compressed stored mesh does; a float one names none)? */
export function glbUsesExtensions(glbBytes: ArrayBuffer | Uint8Array): boolean {
  const b = glbBytes instanceof Uint8Array ? glbBytes : new Uint8Array(glbBytes);
  if (b.length < 20) return false;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(0, true) !== GLB_MAGIC) return false;
  const len = dv.getUint32(12, true);
  if (20 + len > b.length) return false;
  try {
    const j = JSON.parse(new TextDecoder().decode(b.subarray(20, 20 + len))) as Json;
    return Array.isArray(j.extensionsUsed) && j.extensionsUsed.length > 0;
  } catch {
    return false;
  }
}
