/**
 * ROBOT IMPORT — IS A SHARE FILE'S MODEL ONE DSIM WROTE? Pure, DOM-free, no three.
 *
 * A share file is another player's, and it is stored byte for byte as the library's mesh
 * (`ImportEditor` `addShared`), which the 3D scene later hands to three's GLTFLoader on every match
 * that draws the robot. Only its `asset.extras.dsim` block was checked. A CAD goes through the bake,
 * which keeps geometry and colours and drops everything else; a share file did not, so whatever the
 * loader understands was the sender's to use on this device: an image with a `uri` is a request made
 * from this browser each time the robot is drawn, `EXT_mesh_gpu_instancing` draws a mesh half a
 * million times, a meshopt view decodes to the size it claims.
 *
 * AN ALLOWLIST, like the relay's (`src/net/visualCheck.ts` `validateMeshGlb`), and for what both of
 * DSIM's writers produce, since both kinds are in people's libraries: the compressed stored mesh
 * (`engine/storedGlb.ts`: both of its extensions, on buffer views and the fallback buffer only) and
 * the float one saved before it (`engine/floatGlb.ts`, three's GLTFExporter, no extension). Every
 * object's keys are listed, so nothing else has a place to be; `extras` is data the loader copies and
 * never runs, and is not looked into.
 *
 * It does not prove the geometry is sound (the importer's reader does that when the file is added,
 * in a worker); it bounds what the loader may be asked to do. Null when the model is fine, else a
 * short reason.
 */
import { MAX_MESH_BYTES } from './types';

type Json = Record<string, unknown>;

/** the extensions the stored mesh names (`STORED_GLB_EXTENSIONS`; repeated here to stay three-free) */
const EXTENSIONS: readonly string[] = ['EXT_meshopt_compression', 'KHR_mesh_quantization'];
const MESHOPT = 'EXT_meshopt_compression';

const KEYS = {
  top: new Set(['asset', 'scene', 'scenes', 'nodes', 'meshes', 'materials', 'accessors', 'bufferViews', 'buffers', 'extras', 'extensionsUsed', 'extensionsRequired']),
  asset: new Set(['version', 'minVersion', 'generator', 'copyright', 'extras']),
  scene: new Set(['name', 'nodes', 'extras']),
  node: new Set(['name', 'mesh', 'children', 'matrix', 'translation', 'rotation', 'scale', 'extras']),
  mesh: new Set(['name', 'primitives', 'extras']),
  primitive: new Set(['attributes', 'indices', 'material', 'mode', 'extras']),
  material: new Set(['name', 'pbrMetallicRoughness', 'emissiveFactor', 'alphaMode', 'alphaCutoff', 'doubleSided', 'extras']),
  pbr: new Set(['baseColorFactor', 'metallicFactor', 'roughnessFactor', 'extras']),
  accessor: new Set(['bufferView', 'byteOffset', 'componentType', 'normalized', 'count', 'type', 'max', 'min', 'name', 'extras']),
  bufferView: new Set(['buffer', 'byteOffset', 'byteLength', 'byteStride', 'target', 'name', 'extras', 'extensions']),
  buffer: new Set(['byteLength', 'name', 'extras', 'extensions']),
  meshoptView: new Set(['buffer', 'byteOffset', 'byteLength', 'byteStride', 'count', 'mode', 'filter']),
} as const;
const ATTRIBUTES = new Set(['POSITION', 'NORMAL', 'TANGENT', 'COLOR_0', 'TEXCOORD_0', 'TEXCOORD_1', '_BODY']);
/** collections a mesh made of colours never has, each refused when PRESENT, whatever its type */
const REFUSED = ['images', 'textures', 'samplers', 'skins', 'animations', 'cameras'] as const;
const COMPONENTS = new Set<unknown>([5120, 5121, 5122, 5123, 5125, 5126]);
const TYPES = new Set<unknown>(['SCALAR', 'VEC2', 'VEC3', 'VEC4', 'MAT2', 'MAT3', 'MAT4']);
const MESHOPT_MODES = new Set<unknown>(['ATTRIBUTES', 'TRIANGLES', 'INDICES']);
const MESHOPT_FILTERS = new Set<unknown>([undefined, 'NONE', 'OCTAHEDRAL', 'QUATERNION', 'EXPONENTIAL']);

/** objects of one kind a file may list; the largest robot read so far has a few thousand parts */
const MAX_ITEMS = 200_000;
/**
 * Triangles the scene may be asked to draw. Full detail keeps every triangle of the CAD: the largest
 * kit read so far is 7.36M (goBILDA's DECODE bot with its fasteners, `docs/area/robot-import.md`).
 * ⚠️ THE CAP IS WHAT THE BYTE CAP ADMITS, NOT A GUESS AT A ROBOT (merge audit RI-05). A bake over
 * `MAX_MESH_BYTES` (128 MiB) is simplified until it fits, so what DSIM writes is bounded by BYTES, and
 * the stored mesh is 4.6 to 5.0 bytes a triangle on the vendors' kits at Full (REV, goBILDA) and 6.5 on
 * the dense stress robot (`stress.ts`, measured 2026-11-26: 1.55M triangles in 9.62 MiB): the byte cap
 * fills at 27 to 29M triangles on the kits and 20.7M on the stress robot, so the 20M this was, from "about
 * 14M" at 9 bytes, would have refused a file the editor itself saved and exported (a STEP near its 1 GB
 * cap). A quarter of the byte cap is 33.5M: no mesh of up to 128 MiB at 4 bytes a triangle or more can
 * pass it, and it still bounds what a stranger's file can ask the reader to draw (it was 50M).
 */
export const SHARE_MAX_TRIANGLES = Math.floor(MAX_MESH_BYTES / 4);
/**
 * Vertices the readers may be asked to copy, counted per primitive that draws (a POSITION accessor
 * named by several primitives is read once for each: the importer's reader flattens every one).
 * Both writers store only the corners of their triangles (`creasedNormals` makes a vertex per
 * corner it keeps), so a stored mesh has at most 3 a triangle, and every fixture's stored and float
 * mesh 1.22 (440 for 360, measured). Without this a primitive of one triangle could name a POSITION
 * accessor of millions, a thousand times.
 */
export const SHARE_MAX_VERTICES = 60_000_000;
/**
 * Bytes a compressed mesh may decode to: 1 GiB, and never more than 64 times the file plus 16 MiB.
 * The stored mesh decodes to about 8 times its size (27 MB to roughly 210 MB at 5.66M triangles).
 */
export const shareDecodeCap = (fileBytes: number): number => Math.min(1024 ** 3, 16 * 1024 ** 2 + 64 * fileBytes);
/** the deepest a node may nest; the writers stop at a root, eight carriers and a part */
const MAX_DEPTH = 32;

const isObj = (x: unknown): x is Json => typeof x === 'object' && x !== null && !Array.isArray(x);
const isCount = (x: unknown, max: number): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 && x <= max;
const keysOk = (o: Json, allowed: ReadonlySet<string>): boolean => Object.keys(o).every((k) => allowed.has(k));
const finiteList = (x: unknown, len: number): boolean => Array.isArray(x) && x.length === len && x.every((v) => typeof v === 'number' && Number.isFinite(v));
const list = (x: unknown): unknown[] | null => (x === undefined ? [] : Array.isArray(x) && x.length <= MAX_ITEMS ? x : null);
/** exactly `{ EXT_meshopt_compression: {…} }`, or null */
const meshoptOf = (ext: unknown): Json | null => (isObj(ext) && Object.keys(ext).length === 1 && isObj(ext[MESHOPT]) ? ext[MESHOPT] : null);

/**
 * `json` is the GLB's JSON chunk, `binBytes` the length of its BIN chunk (0 with none) and
 * `fileBytes` the whole file's.
 */
export function shareModelRefusal(json: Json, binBytes: number, fileBytes: number): string | null {
  for (const key of REFUSED) if (json[key] !== undefined) return key;
  for (const k of Object.keys(json)) if (!KEYS.top.has(k)) return `unexpected ${k.slice(0, 32)}`;
  if (!isObj(json.asset) || !keysOk(json.asset, KEYS.asset)) return 'asset';
  for (const key of ['extensionsUsed', 'extensionsRequired'] as const) {
    const v = json[key];
    if (v !== undefined && (!Array.isArray(v) || v.some((e) => !EXTENSIONS.includes(e as string)))) return 'extension';
  }

  // ---- buffers: the BIN chunk, and the fallback a meshopt decoder fills (never in the file)
  const buffers = list(json.buffers);
  if (!buffers || buffers.length > 2) return 'buffers';
  const bufLen: number[] = [];
  for (let i = 0; i < buffers.length; i++) {
    const bf = buffers[i];
    // no `uri`: everything is in the file, so nothing is fetched
    if (!isObj(bf) || !keysOk(bf, KEYS.buffer)) return 'buffer';
    if (i === 0) {
      if (bf.extensions !== undefined || !isCount(bf.byteLength, binBytes)) return 'buffer is not in the file';
    } else {
      const m = meshoptOf(bf.extensions);
      if (!m || m.fallback !== true || Object.keys(m).length !== 1 || !isCount(bf.byteLength, shareDecodeCap(fileBytes))) return 'buffer';
    }
    bufLen.push(bf.byteLength as number);
  }

  // ---- buffer views: plain ones sit in the BIN chunk; a compressed one says what it decodes to
  const views = list(json.bufferViews);
  if (!views) return 'bufferViews';
  let decoded = 0;
  for (const v of views) {
    if (!isObj(v) || !keysOk(v, KEYS.bufferView) || !isCount(v.buffer, buffers.length - 1)) return 'bufferView';
    const len = v.byteLength;
    const off = v.byteOffset === undefined ? 0 : v.byteOffset;
    if (!isCount(len, bufLen[v.buffer]) || !isCount(off, bufLen[v.buffer]) || off + len > bufLen[v.buffer]) return 'bufferView range';
    if (v.byteStride !== undefined && !isCount(v.byteStride, 252)) return 'bufferView stride';
    if (v.extensions === undefined) {
      // an uncompressed view of the fallback buffer would read bytes that are not there
      if (v.buffer !== 0) return 'bufferView';
      continue;
    }
    const m = meshoptOf(v.extensions);
    if (!m || !keysOk(m, KEYS.meshoptView) || m.buffer !== 0 || v.buffer !== 1) return 'compressed bufferView';
    const mOff = m.byteOffset === undefined ? 0 : m.byteOffset;
    if (!isCount(m.byteLength, bufLen[0]) || !isCount(mOff, bufLen[0]) || mOff + m.byteLength > bufLen[0]) return 'compressed bufferView range';
    if (!isCount(m.byteStride, 256) || m.byteStride < 1 || !isCount(m.count, 2 ** 31)) return 'compressed bufferView';
    if (!MESHOPT_MODES.has(m.mode) || !MESHOPT_FILTERS.has(m.filter)) return 'compressed bufferView';
    // the decoder allocates count × stride: it must be the view it is decoded into, no more
    if (m.count * m.byteStride !== len) return 'compressed bufferView size';
    decoded += len;
    if (decoded > shareDecodeCap(fileBytes)) return 'decodes to too much';
  }

  const accessors = list(json.accessors);
  if (!accessors) return 'accessors';
  const accCount: number[] = [];
  for (const a of accessors) {
    if (!isObj(a) || !keysOk(a, KEYS.accessor)) return 'accessor';
    if (!COMPONENTS.has(a.componentType) || !TYPES.has(a.type) || !isCount(a.count, 2 ** 31)) return 'accessor';
    if (!isCount(a.bufferView, views.length - 1)) return 'accessor has no buffer view';
    if (a.byteOffset !== undefined && !isCount(a.byteOffset, 2 ** 31)) return 'accessor offset';
    if (a.normalized !== undefined && typeof a.normalized !== 'boolean') return 'accessor';
    accCount.push(a.count);
  }

  const materials = list(json.materials);
  if (!materials) return 'materials';
  for (const m of materials) {
    if (!isObj(m)) return 'material';
    if (Object.keys(m).some((k) => /Texture$/.test(k))) return 'textures';
    if (!keysOk(m, KEYS.material)) return 'material';
    if (m.pbrMetallicRoughness !== undefined) {
      const p = m.pbrMetallicRoughness;
      if (!isObj(p)) return 'material';
      if (Object.keys(p).some((k) => /Texture$/.test(k))) return 'textures';
      if (!keysOk(p, KEYS.pbr)) return 'material';
    }
  }

  const meshes = list(json.meshes);
  if (!meshes) return 'meshes';
  const meshTris: number[] = [];
  const meshVerts: number[] = [];
  for (const m of meshes) {
    if (!isObj(m) || !keysOk(m, KEYS.mesh) || !Array.isArray(m.primitives) || m.primitives.length > 4096) return 'mesh';
    let t = 0;
    let vs = 0;
    for (const p of m.primitives as unknown[]) {
      if (!isObj(p) || !keysOk(p, KEYS.primitive) || !isObj(p.attributes)) return 'primitive';
      if (p.mode !== undefined && p.mode !== 4) return 'primitive mode';
      if (!isCount(p.attributes.POSITION, accessors.length - 1)) return 'primitive has no positions';
      for (const k of Object.keys(p.attributes)) {
        if (!ATTRIBUTES.has(k) || !isCount(p.attributes[k], accessors.length - 1)) return 'primitive attribute';
      }
      if (p.material !== undefined && !isCount(p.material, materials.length - 1)) return 'primitive material';
      if (p.indices !== undefined && !isCount(p.indices, accessors.length - 1)) return 'primitive indices';
      t += Math.floor(accCount[p.indices === undefined ? p.attributes.POSITION : p.indices] / 3);
      vs += accCount[p.attributes.POSITION];
    }
    meshTris.push(t);
    meshVerts.push(vs);
  }

  // ---- the node graph: a forest, not too deep, each mesh drawn by one node at most
  const nodes = list(json.nodes);
  if (!nodes) return 'nodes';
  const parent = new Int32Array(nodes.length).fill(-1);
  // ⚠️ A MESH DRAWN BY TWO NODES IS REFUSED (2026-11-26). The importer's reader flattens every node
  // that draws (`mergedPartsFromObject`), so one mesh under a thousand nodes was a thousand copies:
  // a 1 MB file asked for 50M triangles and about 0.9 GiB of arrays (M-IMP-ENGINE-03). Both
  // writers give every node its own mesh (`storedGlb.ts` one per part, `floatGlb.ts` one geometry
  // per part), so no file DSIM wrote has one drawn twice.
  const drawnBy = new Uint8Array(meshes.length);
  let drawn = 0;
  let drawnVerts = 0;
  for (let i = 0; i < nodes.length; i++) {
    const nd = nodes[i];
    // no `extensions` (instancing), `camera`, `skin` or `weights`: none is in the list
    if (!isObj(nd) || !keysOk(nd, KEYS.node)) return 'node';
    if (nd.mesh !== undefined) {
      if (!isCount(nd.mesh, meshes.length - 1)) return 'node';
      if (drawnBy[nd.mesh]) return 'mesh reused';
      drawnBy[nd.mesh] = 1;
      drawn += meshTris[nd.mesh];
      if (drawn > SHARE_MAX_TRIANGLES) return 'too many triangles';
      drawnVerts += meshVerts[nd.mesh];
      if (drawnVerts > SHARE_MAX_VERTICES) return 'too many vertices';
    }
    if (nd.matrix !== undefined && !finiteList(nd.matrix, 16)) return 'node transform';
    if (nd.translation !== undefined && !finiteList(nd.translation, 3)) return 'node transform';
    if (nd.rotation !== undefined && !finiteList(nd.rotation, 4)) return 'node transform';
    if (nd.scale !== undefined && !finiteList(nd.scale, 3)) return 'node transform';
    if (nd.children !== undefined) {
      if (!Array.isArray(nd.children)) return 'node';
      for (const c of nd.children) {
        // one parent each, and never itself
        if (!isCount(c, nodes.length - 1) || c === i || parent[c] !== -1) return 'node graph';
        parent[c] = i;
      }
    }
  }
  // with one parent each a walk up either ends or loops, and a loop is infinitely deep
  for (let i = 0; i < nodes.length; i++) {
    let d = 0;
    for (let p = parent[i]; p !== -1; p = parent[p]) if (++d > MAX_DEPTH) return 'node graph';
  }

  const scenes = list(json.scenes);
  if (!scenes || scenes.length > 8) return 'scenes';
  for (const sc of scenes) {
    if (!isObj(sc) || !keysOk(sc, KEYS.scene)) return 'scene';
    if (sc.nodes === undefined) continue;
    if (!Array.isArray(sc.nodes)) return 'scene';
    // a scene's roots are roots, each listed once
    const seen = new Set<number>();
    for (const r of sc.nodes) {
      if (!isCount(r, nodes.length - 1) || parent[r] !== -1 || seen.has(r)) return 'scene';
      seen.add(r);
    }
  }
  if (json.scene !== undefined && !isCount(json.scene, scenes.length - 1)) return 'scene';
  return null;
}
