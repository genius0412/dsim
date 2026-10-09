/**
 * Files → parts, for the formats a WORKER can read: GLB, glTF, STL, OBJ (+ MTL), PLY and 3MF. The
 * import worker (`importWorker.ts`) runs these off the main thread; `load.ts` runs them on it as the
 * fallback. STEP is read by occt in its own workers. 3MF is three's loader, which needs a
 * `DOMParser`: a worker has none, so it gets `miniDom.ts`'s for the length of the parse.
 *
 * Every parser ends in the same place: `MeshPart`s in the SOURCE frame (world transforms applied,
 * the file's own units and axes). Textures are stripped before parsing: the importer keeps colours
 * only, and decoding a 4K texture to throw it away is the slowest part of loading many glTF files.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { triangleCount, type MeshPart } from '../geometry';
import type { LengthUnit, ModelFormat } from '../types';
import { ImportError, abortError } from './importError';
import { colourGroups, mergeByColour, splitByVertexColour } from './meshOps';

export type LoadStage = 'read' | 'unzip' | 'parse' | 'step-wasm' | 'step-index' | 'step-parse' | 'convert';
/** a stage, and how far through it (0..1) when that is known */
export type LoadProgress = (stage: LoadStage, frac?: number) => void;

export interface LoadedModel {
  /** the primary file's name */
  name: string;
  format: ModelFormat;
  /** bytes of every file that was used */
  bytes: number;
  /** the unit the file declares (STEP: occt converts to mm; 3MF: its `unit`), else null */
  fileUnit: LengthUnit | null;
  /** SOURCE frame, merged by colour */
  parts: MeshPart[];
  trisIn: number;
  /** plain notes about what was dropped or assumed */
  notes: string[];
}

/** what a parser hands back before the parts are merged */
export interface ParsedFiles {
  parts: MeshPart[];
  bytes: number;
  notes: string[];
  fileUnit: LengthUnit | null;
  /** set when the format knows its own count (STEP); else counted before merging */
  trisIn?: number;
  /** the parts are already merged by colour (the glTF reader does it as it reads) */
  merged?: boolean;
}

/** the formats `parseFiles` reads (and so the import worker can) */
export const WORKER_FORMATS: readonly ModelFormat[] = ['glb', 'gltf', 'stl', 'obj', 'ply', '3mf'];

/** the GLTFLoader's meshopt decoder, handed in: the main chunk shares the one three.js already
 *  loads, the worker fetches it only for a file that needs it */
export type DecoderSource = () => Promise<unknown>;

export const extOf = (name: string): string => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();
const baseName = (path: string): string => decodeURIComponent(path.split(/[\\/]/).pop() ?? path).toLowerCase();

/** sRGB-ish neutral grey for formats with no colour at all, as linear */
export const DEFAULT_LINEAR: [number, number, number] = [0.42, 0.43, 0.45];

/**
 * Read one of `WORKER_FORMATS`. Throws `ImportError` with a sentence for the player; any other
 * failure is reported as `corrupt`, as `loadModel` always has.
 */
export async function parseFiles(
  file: File,
  files: readonly File[],
  format: ModelFormat,
  onProgress: LoadProgress | undefined,
  decoder: DecoderSource,
  signal?: AbortSignal,
): Promise<ParsedFiles> {
  try {
    switch (format) {
      case 'glb':
      case 'gltf': {
        const r = await loadGltf(file, files, format, onProgress, decoder);
        return { parts: r.parts, bytes: r.bytes, notes: r.notes, fileUnit: null, merged: r.merged };
      }
      case 'stl': {
        const welded = await parseBinaryStlWelded(file, onProgress, signal);
        if (welded) return { parts: [welded], bytes: file.size, notes: [], fileUnit: null };
        onProgress?.('parse');
        const geo = new STLLoader().parse(await file.arrayBuffer());
        const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(...DEFAULT_LINEAR) }));
        return { parts: partsFromObject(mesh, true), bytes: file.size, notes: [], fileUnit: null };
      }
      case 'obj': {
        onProgress?.('parse');
        const notes: string[] = [];
        let bytes = file.size;
        const objText = await file.text();
        const loader = new OBJLoader();
        const mtls = files.filter((f) => extOf(f.name) === 'mtl');
        if (mtls.length) {
          // texture maps are dropped before parsing so MTLLoader never fetches them
          const text = (await Promise.all(mtls.map((f) => f.text()))).join('\n').replace(/^\s*(map_|bump|disp|decal|refl)\S*.*$/gim, '');
          const mats = new MTLLoader().parse(text, '');
          mats.preload();
          loader.setMaterials(mats);
          bytes += mtls.reduce((s, f) => s + f.size, 0);
        } else if (/^\s*mtllib\s+/m.test(objText)) {
          notes.push('The .obj names a material file that wasn’t dropped with it, so it is one colour. Drop the .mtl together with the .obj to keep its colours.');
        }
        return { parts: partsFromObject(loader.parse(objText), false), bytes, notes, fileUnit: null };
      }
      case 'ply': {
        onProgress?.('parse');
        const geo = new PLYLoader().parse(await file.arrayBuffer());
        if (!geo.getIndex() && (geo.getAttribute('position')?.count ?? 0) % 3 !== 0) {
          throw new ImportError('empty', `${file.name} has points but no faces. Export it as a mesh and try again.`);
        }
        const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(...DEFAULT_LINEAR) }));
        return { parts: partsFromObject(mesh, true), bytes: file.size, notes: [], fileUnit: null };
      }
      case '3mf': {
        onProgress?.('parse');
        const buf = await file.arrayBuffer();
        const { parseThreeMf, threeMfUnit } = await import('./threeMf');
        const fileUnit = threeMfUnit(new Uint8Array(buf));
        return { parts: parseThreeMf(buf), bytes: file.size, notes: [], fileUnit };
      }
      default:
        throw new Error(`${format} is not read here`);
    }
  } catch (e) {
    if (e instanceof ImportError || (e instanceof Error && e.name === 'AbortError')) throw e;
    throw new ImportError('corrupt', `Couldn’t read ${file.name}: it looks damaged or isn’t really ${format.toUpperCase()} (${e instanceof Error ? e.message : 'unknown error'}). Export it again and retry.`);
  }
}

/**
 * The common end of every load: drop parts too small to be a triangle, merge by colour, and refuse
 * a model with no triangles. `trisIn` is the format's own count when it has one (STEP), else the
 * parts' count before merging.
 */
export function assembleLoaded(name: string, format: ModelFormat, parsed: ParsedFiles): LoadedModel {
  const trisIn = parsed.trisIn || triangleCount(parsed.parts);
  const kept = parsed.parts.filter((p) => p.positions.length >= 9);
  const parts = parsed.merged ? kept : mergeByColour(kept);
  if (triangleCount(parts) === 0) {
    throw new ImportError('empty', `Couldn’t find any triangles in ${name}. Export the robot as a solid or a mesh and try again.`);
  }
  return { name, format, bytes: parsed.bytes, fileUnit: parsed.fileUnit, parts, trisIn, notes: parsed.notes };
}

// ---- binary STL, streamed and welded -------------------------------------------------------

/** triangles read per slice of the file: 3.2 MB at a time, so a 200 MB STL never sits in memory */
const STL_SLICE_TRIS = 65536;

/**
 * A plain binary STL read IN SLICES straight into an indexed mesh, merging vertices whose three
 * float32 coordinates are bit-for-bit equal (non-finite ones never merge). Null when the file is
 * not that (ASCII, a length that disagrees with its triangle count, or per-face colours), and the
 * caller falls back to three's loader.
 *
 * The result is the part three's STLLoader + `partsFromObject` would give AFTER the engine's weld
 * has merged exact duplicates — and the weld merges the same classes either way, keeping each
 * class's first vertex — so what comes out of `simplifyParts` is identical, bit for bit. What it
 * saves is the un-indexed copy (36 bytes a triangle), STLLoader's normals (36 more) and the identity
 * index (12): about 1 GB on a 4M-triangle export.
 */
export async function parseBinaryStlWelded(file: File, onProgress?: LoadProgress, signal?: AbortSignal): Promise<MeshPart | null> {
  if (file.size < 84) return null;
  const head = new DataView(await file.slice(0, 84).arrayBuffer());
  const n = head.getUint32(80, true);
  if (84 + n * 50 !== file.size) return null;
  // VisCAM / SolidView colour STL ("COLOR=" in the header): three's loader reads the face colours
  for (let i = 0; i < 70; i++) {
    if (head.getUint32(i, false) === 0x434f4c4f && head.getUint8(i + 4) === 0x52 && head.getUint8(i + 5) === 0x3d) return null;
  }
  const indices = new Uint32Array(n * 3);
  let pos = new Float32Array(Math.max(9, Math.ceil(n * 0.6) * 3));
  let bits = new Uint32Array(pos.buffer);
  let count = 0;
  let cap = 1 << 10;
  while (cap < n * 1.2) cap <<= 1;
  let table = new Int32Array(cap).fill(-1);
  const f32 = new Float32Array(3);
  const u32 = new Uint32Array(f32.buffer);
  const rehash = (): void => {
    cap <<= 1;
    table = new Int32Array(cap).fill(-1);
    for (let v = 0; v < count; v++) {
      const a = bits[3 * v];
      const b = bits[3 * v + 1];
      const c = bits[3 * v + 2];
      if (!finite3(pos[3 * v], pos[3 * v + 1], pos[3 * v + 2])) continue;
      let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) & (cap - 1);
      while (table[h] >= 0) h = (h + 1) & (cap - 1);
      table[h] = v;
    }
  };
  onProgress?.('read', 0);
  for (let t0 = 0; t0 < n; t0 += STL_SLICE_TRIS) {
    if (signal?.aborted) throw abortError();
    const t1 = Math.min(n, t0 + STL_SLICE_TRIS);
    const dv = new DataView(await file.slice(84 + t0 * 50, 84 + t1 * 50).arrayBuffer());
    for (let t = t0; t < t1; t++) {
      const o = (t - t0) * 50 + 12;
      for (let k = 0; k < 3; k++) {
        // what `partsFromObject`'s identity matrix makes of a vertex: `+ 0` folds −0 into +0, and
        // one non-finite coordinate makes all three NaN (0 × NaN in the other rows)
        const x = dv.getFloat32(o + 12 * k, true);
        const y = dv.getFloat32(o + 12 * k + 4, true);
        const z = dv.getFloat32(o + 12 * k + 8, true);
        const finite = finite3(x, y, z);
        f32[0] = finite ? x + 0 : NaN;
        f32[1] = finite ? y + 0 : NaN;
        f32[2] = finite ? z + 0 : NaN;
        let id = -1;
        if (finite) {
          const a = u32[0];
          const b = u32[1];
          const c = u32[2];
          let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) & (cap - 1);
          for (;;) {
            const slot = table[h];
            if (slot < 0) break;
            if (bits[3 * slot] === a && bits[3 * slot + 1] === b && bits[3 * slot + 2] === c) {
              id = slot;
              break;
            }
            h = (h + 1) & (cap - 1);
          }
          if (id < 0) {
            id = count;
            table[h] = id;
          }
        } else {
          id = count;
        }
        if (id === count) {
          if (3 * count + 3 > pos.length) {
            const grown = new Float32Array(pos.length * 2);
            grown.set(pos);
            pos = grown;
            bits = new Uint32Array(pos.buffer);
          }
          pos[3 * count] = f32[0];
          pos[3 * count + 1] = f32[1];
          pos[3 * count + 2] = f32[2];
          count++;
          if (count * 2 > cap) rehash();
        }
        indices[3 * t + k] = id;
      }
    }
    onProgress?.('read', t1 / n);
  }
  return { positions: pos.slice(0, count * 3), indices, color: [DEFAULT_LINEAR[0], DEFAULT_LINEAR[1], DEFAULT_LINEAR[2]], name: 'part' };
}

const finite3 = (x: number, y: number, z: number): boolean => Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);

// ---- glTF -------------------------------------------------------------------------------

const MAGIC = 0x46546c67;

/** split a GLB into its JSON and the bytes after the JSON chunk */
function splitGlb(buf: ArrayBuffer): { json: Record<string, unknown>; rest: Uint8Array } {
  const dv = new DataView(buf);
  if (buf.byteLength < 20 || dv.getUint32(0, true) !== MAGIC) throw new Error('not a binary glTF');
  if (dv.getUint32(4, true) !== 2) throw new Error('only glTF 2.0 is supported');
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen))) as Record<string, unknown>;
  return { json, rest: new Uint8Array(buf, 20 + jsonLen) };
}

function joinGlb(json: Record<string, unknown>, rest: Uint8Array): ArrayBuffer {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jl = (text.length + 3) & ~3;
  const total = 20 + jl + rest.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jl, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + jl);
  out.set(rest, 20 + jl);
  return out.buffer;
}

const TEXTURE_EXTENSIONS = ['KHR_texture_basisu', 'EXT_texture_webp', 'EXT_texture_avif', 'KHR_texture_transform', 'MSFT_texture_dds'];

/** remove images, textures and every material's texture slots (colours stay); true when it removed any */
function stripTextures(json: Record<string, unknown>): boolean {
  const before = JSON.stringify(json);
  delete json.images;
  delete json.textures;
  delete json.samplers;
  const mats = json.materials as Record<string, unknown>[] | undefined;
  for (const m of mats ?? []) {
    delete m.normalTexture;
    delete m.occlusionTexture;
    delete m.emissiveTexture;
    const pbr = m.pbrMetallicRoughness as Record<string, unknown> | undefined;
    if (pbr) {
      delete pbr.baseColorTexture;
      delete pbr.metallicRoughnessTexture;
    }
    // extension material slots (clearcoat, sheen …) may name textures too; the importer keeps none
    delete m.extensions;
  }
  for (const key of ['extensionsUsed', 'extensionsRequired'] as const) {
    const list = json[key] as string[] | undefined;
    if (list) json[key] = list.filter((e) => !TEXTURE_EXTENSIONS.includes(e) && !e.startsWith('KHR_materials_'));
  }
  return JSON.stringify(json) !== before;
}

async function loadGltf(
  file: File,
  files: readonly File[],
  format: 'glb' | 'gltf',
  onProgress: LoadProgress | undefined,
  decoder: DecoderSource,
): Promise<{ parts: MeshPart[]; bytes: number; notes: string[]; merged: boolean }> {
  // the file's bytes and the loader's buffer views live only inside `gltfScene`: once it returns,
  // nothing holds them, and the merge below writes into arrays of their own
  const { scene, bytes } = await gltfScene(file, files, format, onProgress, decoder);
  const merged = mergedPartsFromObject(scene);
  return { parts: merged ?? partsFromObject(scene, false), bytes, notes: [], merged: !!merged };
}

async function gltfScene(
  file: File,
  files: readonly File[],
  format: 'glb' | 'gltf',
  onProgress: LoadProgress | undefined,
  decoder: DecoderSource,
): Promise<{ scene: THREE.Object3D; bytes: number }> {
  let bytes = file.size;
  const loader = new GLTFLoader();
  let glb: ArrayBuffer;
  let json: Record<string, unknown>;
  if (format === 'glb') {
    const buf = await file.arrayBuffer();
    const split = splitGlb(buf);
    json = split.json;
    checkDraco(json);
    // a CAD export usually has no textures: then the file is parsed as it is, rather than copied
    // whole (80 MB at 3.9 M triangles) to carry an unchanged JSON
    glb = stripTextures(json) ? joinGlb(json, split.rest) : buf;
  } else {
    json = JSON.parse(await file.text()) as Record<string, unknown>;
    checkDraco(json);
    stripTextures(json);
    const r = await packGltf(json, files, file.name);
    bytes += r.bytes;
    glb = r.glb;
  }
  const used = (json.extensionsUsed as string[] | undefined) ?? [];
  if (used.includes('EXT_meshopt_compression') || used.includes('KHR_meshopt_compression')) {
    loader.setMeshoptDecoder((await decoder()) as Parameters<GLTFLoader['setMeshoptDecoder']>[0]);
  }
  onProgress?.('parse');
  const gltf = await loader.parseAsync(glb, '');
  return { scene: gltf.scene, bytes };
}

/**
 * A `.gltf` and the `.bin` files dropped with it → one GLB in memory, so nothing is fetched by
 * URL (no object URLs to manage, and a missing file is named before parsing starts). Every
 * external buffer is appended to the GLB's BIN chunk on an 8-byte boundary — keeping every
 * accessor's alignment — and its buffer views re-pointed; data-URI buffers stay as they are.
 */
async function packGltf(json: Record<string, unknown>, files: readonly File[], gltfName: string): Promise<{ glb: ArrayBuffer; bytes: number }> {
  const byName = new Map(files.map((f) => [f.name.toLowerCase(), f]));
  const buffers = (json.buffers as { uri?: string; byteLength: number }[] | undefined) ?? [];
  const chunks: Uint8Array[] = [];
  const offsetOf = new Map<number, number>();
  let binLen = 0;
  let bytes = 0;
  for (let i = 0; i < buffers.length; i++) {
    const uri = buffers[i].uri;
    if (!uri || uri.startsWith('data:')) continue;
    const f = byName.get(baseName(uri));
    if (!f) throw new ImportError('missing-file', `Couldn’t find ${baseName(uri)}, which ${gltfName} needs. Drop it together with the .gltf.`);
    const data = new Uint8Array(await f.arrayBuffer());
    const at = (binLen + 7) & ~7;
    if (at > binLen) chunks.push(new Uint8Array(at - binLen));
    chunks.push(data);
    offsetOf.set(i, at);
    binLen = at + data.length;
    bytes += f.size;
  }
  if (!offsetOf.size) return { glb: joinGlb(json, new Uint8Array(0)), bytes };
  // the merged BIN becomes buffer 0; the remaining (data-URI) buffers follow it
  const keep = buffers.map((_, i) => i).filter((i) => !offsetOf.has(i));
  const newIndex = new Map<number, number>(keep.map((i, k) => [i, k + 1]));
  json.buffers = [{ byteLength: binLen }, ...keep.map((i) => buffers[i])];
  for (const v of (json.bufferViews as { buffer: number; byteOffset?: number }[] | undefined) ?? []) {
    const off = offsetOf.get(v.buffer);
    if (off !== undefined) {
      v.byteOffset = (v.byteOffset ?? 0) + off;
      v.buffer = 0;
    } else {
      v.buffer = newIndex.get(v.buffer) ?? v.buffer;
    }
  }
  const padded = (binLen + 3) & ~3;
  const bin = new Uint8Array(8 + padded);
  const dv = new DataView(bin.buffer);
  dv.setUint32(0, padded, true);
  dv.setUint32(4, 0x004e4942, true);
  let at = 8;
  for (const c of chunks) {
    bin.set(c, at);
    at += c.length;
  }
  return { glb: joinGlb(json, bin), bytes };
}

function checkDraco(json: Record<string, unknown>): void {
  const req = (json.extensionsRequired as string[] | undefined) ?? [];
  if (req.includes('KHR_draco_mesh_compression')) {
    throw new ImportError('draco', 'This glTF uses Draco compression, which the importer doesn’t read. Export it again without Draco (meshopt compression is fine).');
  }
}

// ---- three.js object → parts ---------------------------------------------------------

/**
 * Every mesh under `root`, world transform applied, split by material group and (when
 * `useVertexColours`, or the material asks for them) by vertex colour. Flips the winding of a
 * mirrored instance.
 *
 * Positions are read straight from the attribute's array when it is a plain, non-normalised one
 * (every CAD export), with `Vector3.applyMatrix4`'s own arithmetic in its own order, so the floats
 * are the ones it would give; a quantised or interleaved attribute goes through `getX/getY/getZ`
 * (the trap `renderElementsGlb.ts` records). Indices are one typed-array copy. Together about four
 * times faster than a `Vector3` and a callback per element, on millions of vertices.
 */
export function partsFromObject(root: THREE.Object3D, useVertexColours: boolean): MeshPart[] {
  root.updateMatrixWorld(true);
  const out: MeshPart[] = [];
  const v = new THREE.Vector3();
  const tmp = new THREE.Matrix4();
  // BODIES (`MeshPart.body`): one per mesh instance, in traversal order — or, in a mesh the importer
  // stored itself, the ids it wrote (`_body`, `bodyIdsOf`)
  let nextBody = 0;
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || (obj as THREE.Points).isPoints || (obj as THREE.Line).isLine) return;
    const geo = mesh.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute('position');
    if (!pos || pos.count < 3) return;
    const index = geo.getIndex();
    const inst = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh) : null;
    const instances = inst ? inst.count : 1;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const colorAttr = geo.getAttribute('color');
    const plain = !(pos as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute && !pos.normalized && pos.itemSize === 3;
    const src = plain ? (pos as THREE.BufferAttribute).array : null;
    const full = index ? Uint32Array.from(index.array as ArrayLike<number>) : null;
    const stored = bodyIdsOf(geo);
    for (let n = 0; n < instances; n++) {
      const bodyId = nextBody++;
      const m = new THREE.Matrix4().copy(mesh.matrixWorld);
      if (inst) {
        inst.getMatrixAt(n, tmp);
        m.multiply(tmp);
      }
      const flip = m.determinant() < 0;
      const positions = new Float32Array(pos.count * 3);
      transformInto(pos, src, m, positions, 0, v);
      const nIdx = full ? full.length : pos.count;
      const groups = geo.groups.length && materials.length > 1 ? geo.groups : [{ start: 0, count: nIdx, materialIndex: 0 }];
      for (const g of groups) {
        const end = Math.min(nIdx, g.start + g.count);
        const len = Math.max(0, end - g.start);
        const size = len - (len % 3);
        let idx: Uint32Array;
        if (full) idx = full.slice(g.start, g.start + size);
        else {
          idx = new Uint32Array(size);
          for (let k = 0; k < size; k++) idx[k] = g.start + k;
        }
        if (flip) for (let k = 0; k + 2 < idx.length; k += 3) [idx[k + 1], idx[k + 2]] = [idx[k + 2], idx[k + 1]];
        const mat = materials[g.materialIndex ?? 0] ?? materials[0];
        const c = (mat as THREE.MeshStandardMaterial | undefined)?.color;
        const part: MeshPart = {
          positions,
          indices: idx,
          color: c ? [c.r, c.g, c.b] : [DEFAULT_LINEAR[0], DEFAULT_LINEAR[1], DEFAULT_LINEAR[2]],
          name: mesh.name || obj.parent?.name || 'part',
          body: stored ? stored.slice() : new Uint32Array(pos.count).fill(bodyId),
        };
        if (colorAttr && (useVertexColours || (mat as THREE.MeshStandardMaterial | undefined)?.vertexColors)) {
          const cols = new Float32Array(colorAttr.count * 3);
          for (let i = 0; i < colorAttr.count; i++) {
            cols[3 * i] = colorAttr.getX(i);
            cols[3 * i + 1] = colorAttr.getY(i);
            cols[3 * i + 2] = colorAttr.getZ(i);
          }
          out.push(...splitByVertexColour(part, cols));
        } else {
          out.push(part);
        }
      }
    }
  });
  return out;
}

/**
 * The body ids a mesh the importer stored carries (`_BODY` in the GLB, which GLTFLoader names
 * `_body`; `meshGroup.ts` writes it), as a fresh array, or null for any other mesh.
 */
function bodyIdsOf(geo: THREE.BufferGeometry): Uint32Array | null {
  const a = geo.getAttribute('_body');
  const pos = geo.getAttribute('position');
  if (!a || !pos || a.count !== pos.count || a.itemSize !== 1) return null;
  const out = new Uint32Array(a.count);
  for (let i = 0; i < a.count; i++) out[i] = Math.max(0, Math.round(a.getX(i)));
  return out;
}

/**
 * `pos` moved by `m` into `out` from `at`: straight from the array when it is plain (`src`), with
 * `Vector3.applyMatrix4`'s arithmetic in its order, else through `getX/getY/getZ`. The one place
 * both readers below do it, so their floats are the same.
 */
function transformInto(
  pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  src: ArrayLike<number> | null,
  m: THREE.Matrix4,
  out: Float32Array,
  at: number,
  v: THREE.Vector3,
): void {
  if (src) {
    const e = m.elements;
    for (let i = 0, j = 0; i < pos.count; i++, j += 3) {
      const x = src[j];
      const y = src[j + 1];
      const z = src[j + 2];
      const w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
      out[at + j] = (e[0] * x + e[4] * y + e[8] * z + e[12]) * w;
      out[at + j + 1] = (e[1] * x + e[5] * y + e[9] * z + e[13]) * w;
      out[at + j + 2] = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w;
    }
  } else {
    for (let i = 0; i < pos.count; i++) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m);
      out[at + 3 * i] = v.x;
      out[at + 3 * i + 1] = v.y;
      out[at + 3 * i + 2] = v.z;
    }
  }
}

/**
 * `mergeByColour(partsFromObject(root, false))`, bit for bit, without the copy in between: the
 * colours are grouped first (`colourGroups`), every group's arrays are allocated at their final
 * size, and each mesh instance is written straight into its group. A geometry's arrays are let go
 * the moment its last instance is written, so the scene, the parts and the merged parts are never
 * all in memory at once. That copy is what kept a GLB's peak where it was when its reading moved
 * into the import worker (`docs/area/robot-import.md`, Workers).
 *
 * Null when a mesh asks for vertex colours (its parts split by colour first): the caller then takes
 * the two-step path.
 */
export function mergedPartsFromObject(root: THREE.Object3D, maxParts = 48): MeshPart[] | null {
  root.updateMatrixWorld(true);
  type Item = { mesh: THREE.Mesh; inst: number; start: number; size: number; posLen: number; color: [number, number, number]; name: string; body: number };
  const items: Item[] = [];
  const uses = new Map<THREE.BufferGeometry, number>();
  const tmp = new THREE.Matrix4();
  let splits = false;
  // one body per mesh instance, numbered as `partsFromObject` numbers them
  let nextBody = 0;
  const storedIds = new Map<THREE.BufferGeometry, Uint32Array | null>();
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || (obj as THREE.Points).isPoints || (obj as THREE.Line).isLine) return;
    const geo = mesh.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute('position');
    if (!pos || pos.count < 3) return;
    const index = geo.getIndex();
    const instances = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count : 1;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const nIdx = index ? index.count : pos.count;
    const groups = geo.groups.length && materials.length > 1 ? geo.groups : [{ start: 0, count: nIdx, materialIndex: 0 }];
    if (!storedIds.has(geo)) storedIds.set(geo, bodyIdsOf(geo));
    for (let n = 0; n < instances; n++) {
      const bodyId = nextBody++;
      for (const g of groups) {
        const end = Math.min(nIdx, g.start + g.count);
        const len = Math.max(0, end - g.start);
        const mat = materials[g.materialIndex ?? 0] ?? materials[0];
        if (geo.getAttribute('color') && (mat as THREE.MeshStandardMaterial | undefined)?.vertexColors) splits = true;
        const c = (mat as THREE.MeshStandardMaterial | undefined)?.color;
        items.push({
          mesh,
          inst: n,
          start: g.start,
          size: len - (len % 3),
          color: c ? [c.r, c.g, c.b] : [DEFAULT_LINEAR[0], DEFAULT_LINEAR[1], DEFAULT_LINEAR[2]],
          name: mesh.name || obj.parent?.name || 'part',
          posLen: pos.count * 3,
          body: bodyId,
        });
        uses.set(geo, (uses.get(geo) ?? 0) + 1);
      }
    }
  });
  if (splits) return null;
  const groups = colourGroups(
    items.map((it) => it.color),
    maxParts,
  );
  // each item's group and its offsets there, in the order `concatParts` appends them
  const groupOf = new Int32Array(items.length);
  const posAt = new Float64Array(items.length);
  const idxAt = new Float64Array(items.length);
  const out = groups.map((g, gi) => {
    let nPos = 0;
    let nIdx = 0;
    for (const i of g) {
      groupOf[i] = gi;
      posAt[i] = nPos;
      idxAt[i] = nIdx;
      nPos += items[i].posLen;
      nIdx += items[i].size;
    }
    return { positions: new Float32Array(nPos), indices: new Uint32Array(nIdx - (nIdx % 3)), body: new Uint32Array(nPos / 3) };
  });
  const v = new THREE.Vector3();
  // one instance's positions serve each of its groups, as they do in `partsFromObject`
  let last: { mesh: THREE.Mesh; inst: number; at: number; group: number } | null = null;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const geo = it.mesh.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute('position');
    const index = geo.getIndex();
    const m = new THREE.Matrix4().copy(it.mesh.matrixWorld);
    if ((it.mesh as THREE.InstancedMesh).isInstancedMesh) {
      (it.mesh as THREE.InstancedMesh).getMatrixAt(it.inst, tmp);
      m.multiply(tmp);
    }
    const flip = m.determinant() < 0;
    const dst = out[groupOf[i]];
    const at = posAt[i];
    // the instance's body ids: the stored mesh's own, else the instance's one id
    const ids = storedIds.get(geo);
    if (ids) dst.body.set(ids, at / 3);
    else dst.body.fill(it.body, at / 3, at / 3 + pos.count);
    if (last && last.mesh === it.mesh && last.inst === it.inst && last.group === groupOf[i]) {
      dst.positions.copyWithin(at, last.at, last.at + pos.count * 3);
    } else if (last && last.mesh === it.mesh && last.inst === it.inst) {
      dst.positions.set(out[last.group].positions.subarray(last.at, last.at + pos.count * 3), at);
    } else {
      const plain = !(pos as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute && !pos.normalized && pos.itemSize === 3;
      transformInto(pos, plain ? (pos as THREE.BufferAttribute).array : null, m, dst.positions, at, v);
      last = { mesh: it.mesh, inst: it.inst, at, group: groupOf[i] };
    }
    const base = at / 3;
    const ia = index ? index.array : null;
    let o = idxAt[i];
    for (let k = 0; k < it.size; k += 3) {
      const a = ia ? ia[it.start + k] : it.start + k;
      const b = ia ? ia[it.start + k + 1] : it.start + k + 1;
      const c = ia ? ia[it.start + k + 2] : it.start + k + 2;
      dst.indices[o++] = a + base;
      dst.indices[o++] = (flip ? c : b) + base;
      dst.indices[o++] = (flip ? b : c) + base;
    }
    // the last use of this geometry: let its arrays go (the merged copy is all that is kept)
    const left = (uses.get(geo) ?? 1) - 1;
    uses.set(geo, left);
    if (left === 0) {
      for (const name of Object.keys(geo.attributes)) geo.deleteAttribute(name);
      geo.setIndex(null);
    }
  }
  return groups.map((g, gi) => {
    if (g.length === 1) return { positions: out[gi].positions, indices: out[gi].indices, color: items[g[0]].color, name: items[g[0]].name, body: out[gi].body };
    // the area-weighted colour, summed in `concatParts`'s order with its weights
    const col = [0, 0, 0];
    let w = 0;
    for (const i of g) {
      const weight = Math.max(1, items[i].posLen);
      for (let k = 0; k < 3; k++) col[k] += items[i].color[k] * weight;
      w += weight;
    }
    return { positions: out[gi].positions, indices: out[gi].indices, color: [col[0] / w, col[1] / w, col[2] / w], name: items[g[0]].name, body: out[gi].body };
  });
}
