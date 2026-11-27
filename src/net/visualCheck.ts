/**
 * THE VISUALS RELAY'S VALIDATORS: is these bytes a picture or a model the relay will hold, and a
 * viewer will decode? The wire rules they check against (`VISUAL_MAX_BYTES`, `VisualKind`) live in
 * `importVisuals.ts`; read its header for what the relay is.
 *
 * ⚠️ A SEPARATE MODULE ON PURPOSE. The room validates what it is sent (`server/importVisuals.ts`,
 * which the LAN host worker bundles), and a viewer validates it AGAIN before drawing it, but a
 * client only does that when a look actually arrives — and the checks are ~12 KB of minified
 * code. Kept inside `importVisuals.ts` they were in the entry chunk every player downloads,
 * because `api.ts` and `protocol.ts` import that file for a capability string. The client reaches
 * this file by `import()` (`importVisualsClient.ts`), so it is its own lazy chunk; the server
 * imports it directly. Same pure functions, same DOM-free / no-`node:` rule as `importVisuals.ts`.
 */
import { ROBOT_MESH_BOX_IN, ROBOT_MESH_BOX_M } from '../robotImport/types';
import { VISUAL_MAX_BYTES, type VisualKind } from './importVisuals';

// ---- validation: a PNG ----------------------------------------------------------------------

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** the widest side a relayed top picture may declare. The importer bakes 512; a PNG is a
 *  decompression bomb in 256 KiB (65,535 × 65,535 fits), and the viewer decodes it. */
export const VISUAL_TOP_MAX_SIDE = 1024;

/**
 * Is `b` a well-formed PNG of a sane size, as far as its CHUNK STRUCTURE goes? Null when yes, else
 * why not. Signature, an IHDR first with a legal depth/colour type and a side of 1..1024, chunk
 * lengths that tile the file exactly, at least one IDAT, and an IEND that ends it. CRCs are left
 * to the decoder: this is a gate against what must never reach one (a bomb, a polyglot, a
 * truncated file), not a decoder.
 */
export function validateTopPng(b: Uint8Array, maxBytes = VISUAL_MAX_BYTES.top): string | null {
  if (b.length > maxBytes) return 'too large';
  if (b.length < 8 + 25 + 12) return 'too short';
  for (let i = 0; i < 8; i++) if (b[i] !== PNG_SIG[i]) return 'not a PNG';
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let pos = 8;
  let first = true;
  let idat = false;
  while (pos < b.length) {
    if (pos + 12 > b.length) return 'truncated chunk';
    const len = dv.getUint32(pos);
    const next = pos + 12 + len;
    if (len > 0x7fffffff || next > b.length) return 'chunk length';
    let name = '';
    for (let i = 4; i < 8; i++) {
      const c = b[pos + i];
      if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return 'chunk type';
      name += String.fromCharCode(c);
    }
    if (first) {
      if (name !== 'IHDR' || len !== 13) return 'no IHDR';
      const w = dv.getUint32(pos + 8);
      const h = dv.getUint32(pos + 12);
      if (w < 1 || h < 1 || w > VISUAL_TOP_MAX_SIDE || h > VISUAL_TOP_MAX_SIDE) return 'picture size';
      const depth = b[pos + 16];
      const colour = b[pos + 17];
      if (![1, 2, 4, 8, 16].includes(depth) || ![0, 2, 3, 4, 6].includes(colour)) return 'IHDR';
      if (b[pos + 18] !== 0 || b[pos + 19] !== 0 || b[pos + 20] > 1) return 'IHDR';
      first = false;
    } else if (name === 'IHDR') {
      return 'second IHDR';
    }
    if (name === 'IDAT') idat = true;
    if (name === 'IEND') return len === 0 && next === b.length && idat ? null : 'IEND';
    pos = next;
  }
  return 'no IEND';
}

// ---- validation: a GLB ------------------------------------------------------------------------

const GLB_MAGIC = 0x46546c67;
const GLB_JSON = 0x4e4f534a;
const GLB_BIN = 0x004e4942;
const GLB_JSON_MAX = 256 * 1024;
/** a relayed mesh's ceiling. It was the importer's `MAX_TRIANGLES` (now 400k for the compressed stored
 *  mesh); a relayed mesh is `liteMesh`'s float GLB under 1 MiB, about 20k on a real robot, so it stays */
export const VISUAL_MAX_TRIANGLES = 150_000;
/** own-property lookups only: `componentType: "constructor"` must not find `Object` */
const COMPONENT_BYTES = new Map<unknown, number>([[5120, 1], [5121, 1], [5122, 2], [5123, 2], [5125, 4], [5126, 4]]);
const TYPE_COMPONENTS = new Map<unknown, number>([['SCALAR', 1], ['VEC2', 2], ['VEC3', 3], ['VEC4', 4], ['MAT2', 4], ['MAT3', 9], ['MAT4', 16]]);
/** the component types an index accessor may have, and the reader for each */
const INDEX_TYPES = new Set<unknown>([5121, 5123, 5125]);

/**
 * THE glTF EXTENSIONS A RELAYED MESH MAY USE: what our own float exporter writes (`exportStoredScene`,
 * which `liteMesh` uses: three's GLTFExporter on a group of `MeshStandardMaterial` meshes with
 * positions, normals and indices), which is NONE. The STORED mesh is quantised and meshopt-packed
 * (`storedGlb.ts`), and is never relayed as it is: older servers and clients run this same check, so
 * the owner always sends `liteMesh`'s float copy of it. An extension is code the viewer's loader runs on
 * the owner's say-so: `EXT_mesh_gpu_instancing` drew 512 × 500,000 copies of a mesh from a 546 KB
 * file, `EXT_meshopt_compression` allocated `count × byteStride` bytes it was told to. Add a name
 * here only with a check that says what its fields may hold.
 */
export const VISUAL_GLB_EXTENSIONS: readonly string[] = [];

/** the keys each glTF object may carry; anything else is refused (an allowlist, not a denylist) */
const KEYS = {
  top: new Set(['asset', 'scene', 'scenes', 'nodes', 'meshes', 'materials', 'accessors', 'bufferViews', 'buffers', 'extras', 'extensionsUsed', 'extensionsRequired']),
  scene: new Set(['name', 'nodes', 'extras']),
  node: new Set(['name', 'mesh', 'children', 'matrix', 'translation', 'rotation', 'scale', 'extras']),
  mesh: new Set(['name', 'primitives', 'extras']),
  primitive: new Set(['attributes', 'indices', 'material', 'mode', 'extras']),
  material: new Set(['name', 'pbrMetallicRoughness', 'emissiveFactor', 'alphaMode', 'alphaCutoff', 'doubleSided', 'extras']),
  pbr: new Set(['baseColorFactor', 'metallicFactor', 'roughnessFactor', 'extras']),
  accessor: new Set(['bufferView', 'byteOffset', 'componentType', 'normalized', 'count', 'type', 'max', 'min', 'name', 'extras']),
  bufferView: new Set(['buffer', 'byteOffset', 'byteLength', 'byteStride', 'target', 'name', 'extras']),
  buffer: new Set(['byteLength', 'name', 'extras']),
} as const;
/** vertex attributes a primitive may carry (no skinning, no morph targets) — and ONE custom one,
 *  `_BODY`, the importer's per-vertex body id (`MeshPart.body`), checked below to be one unsigned
 *  integer per vertex and nothing else */
const ATTRIBUTES = new Set(['POSITION', 'NORMAL', 'TANGENT', 'COLOR_0', 'TEXCOORD_0', 'TEXCOORD_1', '_BODY']);
/** top-level collections that a mesh made of colours never has, each refused by its own name */
const REFUSED_COLLECTIONS = ['images', 'textures', 'samplers', 'skins', 'animations', 'cameras'] as const;
/** the deepest node a scene may nest (a cycle is infinitely deep) */
export const VISUAL_GLB_MAX_DEPTH = 32;

/**
 * WHERE A RELAYED MESH MAY BE: every drawn vertex, through its node's transforms, inside this box of
 * the STORED MESH FRAME (glTF metres, +Y up, the origin on the floor at the wheelbase centre:
 * `docs/area/robot-import.md` "Frames"). Measured 2026-11-26 on every mesh the importer bakes from
 * `scripts/fixtures/robot-import/` (GLB, STL, OBJ, PLY, 3MF, at Full and Light, as the float stored
 * mesh and as `liteMesh`'s copy), the synthetic robot with seven moving parts, and the 0.47 M-triangle
 * stress robot: x −0.20..0.20, y 0..0.43, z −0.20..0.25. So a metre either side and two up leave
 * five times that, while a node scale of 10⁶ or a vertex at 10³⁰ (a wall, or a field-sized sheet, in
 * every viewer's camera) is refused. ⚠️ THE VIEWER HOLDS A MESH TO THIS SAME BOX (`importedMeshFits`,
 * `renderImported.ts`, through `VISUAL_MESH_BOX_ROBOT_IN`) and the editor's Review blocks a model that
 * leaves it: a viewer stricter than the relay drew a placeholder for a model the room stored and served
 * (merge audit RI-01). The box itself is `ROBOT_MESH_BOX_M` (`robotImport/types.ts`, main-safe), so
 * the viewer need not load this file.
 */
export const VISUAL_MESH_BOX: { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] } = ROBOT_MESH_BOX_M;
/** the same box in robot-local inches (+x front, +y left, +z up): what the viewer and Review test */
export const VISUAL_MESH_BOX_ROBOT_IN = ROBOT_MESH_BOX_IN;
/**
 * DRAW CALLS: the primitives each node that draws a mesh draws, summed. One mesh of 64 primitives
 * drawn by 512 nodes was 32,768 draw calls (twice that with shadows) in a 42 KB file. The importer
 * writes one primitive per colour and per moving part's colour: 1 to 14 on the measured meshes
 * above, 10 on the stress robot's relay copy; 64 moving parts in 16 colours would be 1,024.
 */
export const VISUAL_MAX_DRAWN_PRIMITIVES = 1024;
/** the distinct POSITION values read, summed over accessors: three per triangle at the triangle cap.
 *  Accessors may alias one buffer view, so without it 4,096 of them could each read 87k vertices */
export const VISUAL_MAX_POSITIONS = 3 * VISUAL_MAX_TRIANGLES;
/** a node's scale, per axis (a matrix column's length): the exporter writes 1; 0 makes three's
 *  decomposition divide by zero */
const NODE_SCALE_MIN = 1e-6;
const NODE_SCALE_MAX = 1e6;
/** how far a rotation may be from unit length, and a matrix's columns from square to each other:
 *  three composes a rotation as it is given, so a quaternion of length 100 scales by 10⁴ */
const NODE_UNIT_TOL = 1e-3;

type Json = Record<string, unknown>;
const isObj = (x: unknown): x is Json => typeof x === 'object' && x !== null && !Array.isArray(x);
const isCount = (x: unknown, max: number): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 && x <= max;
const keysOk = (o: Json, allowed: ReadonlySet<string>): boolean => Object.keys(o).every((k) => allowed.has(k));
const finiteList = (x: unknown, len: number): boolean => Array.isArray(x) && x.length === len && x.every((v) => typeof v === 'number' && Number.isFinite(v));
const finiteNum = (x: unknown): boolean => typeof x === 'number' && Number.isFinite(x);

/**
 * A node's local transform as a column-major 4×4, or null when three would not draw it as the file
 * says: a matrix AND a translation, rotation or scale (three takes the matrix and drops the rest), a
 * matrix that is not a rotation and a scale (three DECOMPOSES it, so a shear or a projective row is
 * not what is drawn), a rotation that is not unit length, or a scale per axis outside
 * [`NODE_SCALE_MIN`, `NODE_SCALE_MAX`]. The values are already known to be finite.
 */
function localMatrix(nd: Json): Float64Array | null {
  const m = new Float64Array(16);
  if (nd.matrix !== undefined) {
    if (nd.translation !== undefined || nd.rotation !== undefined || nd.scale !== undefined) return null;
    const a = nd.matrix as number[];
    for (let i = 0; i < 16; i++) m[i] = a[i];
    if (Math.abs(m[3]) > 1e-6 || Math.abs(m[7]) > 1e-6 || Math.abs(m[11]) > 1e-6 || Math.abs(m[15] - 1) > 1e-6) return null;
    const len = [0, 1, 2].map((c) => Math.hypot(m[4 * c], m[4 * c + 1], m[4 * c + 2]));
    if (len.some((l) => !(l >= NODE_SCALE_MIN && l <= NODE_SCALE_MAX))) return null;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      const dot = m[4 * p] * m[4 * q] + m[4 * p + 1] * m[4 * q + 1] + m[4 * p + 2] * m[4 * q + 2];
      if (Math.abs(dot) > NODE_UNIT_TOL * len[p] * len[q]) return null;
    }
    return m;
  }
  const [tx, ty, tz] = (nd.translation as number[] | undefined) ?? [0, 0, 0];
  const [x, y, z, w] = (nd.rotation as number[] | undefined) ?? [0, 0, 0, 1];
  const [sx, sy, sz] = (nd.scale as number[] | undefined) ?? [1, 1, 1];
  if (Math.abs(Math.hypot(x, y, z, w) - 1) > NODE_UNIT_TOL) return null;
  for (const s of [sx, sy, sz]) if (!(Math.abs(s) >= NODE_SCALE_MIN && Math.abs(s) <= NODE_SCALE_MAX)) return null;
  // three's Matrix4.compose, term for term
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  m.set([(1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0, (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0, (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0, tx, ty, tz, 1]);
  return m;
}

/** `a × b` (column-major 4×4, affine), into a new array */
function mulAffine(a: Float64Array, b: Float64Array): Float64Array {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 3; r++) o[4 * c + r] = a[r] * b[4 * c] + a[4 + r] * b[4 * c + 1] + a[8 + r] * b[4 * c + 2] + (c === 3 ? a[12 + r] : 0);
  }
  o[15] = 1;
  return o;
}

/**
 * Walk the whole JSON once (iterative, node-capped): is there a `uri` anywhere, and an `extensions`
 * object naming anything not in `VISUAL_GLB_EXTENSIONS`?
 */
function scanJson(root: unknown): { uri: boolean; extension: boolean } | 'huge' {
  const stack: unknown[] = [root];
  let seen = 0;
  let uri = false;
  let extension = false;
  while (stack.length) {
    const x = stack.pop();
    if (typeof x !== 'object' || x === null) continue;
    if (++seen > 100_000) return 'huge';
    if (Array.isArray(x)) {
      for (const v of x) stack.push(v);
    } else {
      for (const k of Object.keys(x)) {
        const v = (x as Json)[k];
        if (k === 'uri') uri = true;
        if (k === 'extensions' && (!isObj(v) || Object.keys(v).some((e) => !VISUAL_GLB_EXTENSIONS.includes(e)))) extension = true;
        stack.push(v);
      }
    }
  }
  return { uri, extension };
}

/**
 * Is `b` a binary glTF a viewer may load? Null when yes, else why not. AN ALLOWLIST: the file may
 * hold what our importer writes and nothing else, because the viewer hands it to three's
 * GLTFLoader, and every feature that loader has is something an owner could aim at every other
 * player's browser.
 *
 * ⚠️ EVERYTHING MUST BE IN THE FILE. A `uri` anywhere (a buffer, an image, a data URI) is refused
 * outright, because the viewer's loader would FETCH it: a relayed mesh that names a URL is a request
 * the room's owner made from every viewer's browser.
 *
 * ⚠️ AND NOTHING ELSE MAY RUN. No extension at all (`VISUAL_GLB_EXTENSIONS`), required or not, on
 * any object: GPU instancing multiplied a mesh by half a million, meshopt decoding allocated what
 * it was told. No images, textures, samplers, skins, animations or cameras, refused when PRESENT,
 * whatever their type: an `images` object `{"0": …}` passed an `Array.isArray` test and the loader
 * indexed it anyway, decoding a picture from the BIN chunk. Every object's keys are allowlisted.
 *
 * The rest is a bounds check, so the loader never reads past what it was given: the header and
 * chunk lengths tile the file, buffer views sit inside the one BIN buffer, accessors (of a known
 * component type and shape, looked up as OWN properties) inside their views, every attribute has
 * as many entries as the positions and every index value names one of them, the node graph is a
 * forest no deeper than `VISUAL_GLB_MAX_DEPTH`, and the triangle count, taken per NODE that draws a
 * mesh (512 nodes drawing one 150k mesh are 77M triangles), is the importer's own ceiling.
 *
 * ⚠️ AND IT MUST BE ROBOT-SIZED, OPAQUE AND FEW DRAW CALLS (merge audit 2026-11, M-IMP-TRUST-01). A
 * file that passed everything above still put a wall in every viewer's camera (a node scale of 10⁶,
 * vertices at 10³⁰), NaN vertices, 32,768 draw calls, or 150,000 copies of a 200 m translucent
 * triangle. So every POSITION value is read (finite, inside its accessor's `min`/`max`), each node's
 * transform is composed down from its root as three would draw it (`localMatrix`), every drawn
 * vertex must land inside `VISUAL_MESH_BOX`, a material is opaque, and the primitives drawn are at
 * most `VISUAL_MAX_DRAWN_PRIMITIVES`. The work is bounded by the file, not by what it claims:
 * index values are counted against the triangle cap BEFORE they are read, positions are read once
 * per accessor up to `VISUAL_MAX_POSITIONS`, nothing recurses, and nothing is allocated by a count
 * the file states past the 512 nodes and 4,096 accessors already capped. The viewer then holds the
 * parsed mesh to this same box and caps its surface area, which is what bounds overdraw
 * (`importedMeshFits`, `renderImported.ts`).
 */
export function validateMeshGlb(b: Uint8Array, maxBytes = VISUAL_MAX_BYTES.mesh): string | null {
  if (b.length > maxBytes) return 'too large';
  if (b.length < 12 + 8 + 2) return 'too short';
  if (b.length % 4 !== 0) return 'not 4-byte aligned';
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(0, true) !== GLB_MAGIC) return 'not a GLB';
  if (dv.getUint32(4, true) !== 2) return 'not glTF 2';
  if (dv.getUint32(8, true) !== b.length) return 'GLB length';
  let off = 12;
  let n = 0;
  let json: unknown;
  let binLen = -1;
  let binAt = 0;
  while (off < b.length) {
    if (off + 8 > b.length) return 'truncated chunk';
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    const start = off + 8;
    if (len % 4 !== 0 || start + len > b.length) return 'chunk length';
    if (n === 0) {
      if (type !== GLB_JSON) return 'first chunk is not JSON';
      if (len > GLB_JSON_MAX) return 'JSON too large';
      try {
        json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(start, start + len)));
      } catch {
        return 'JSON';
      }
    } else if (n === 1 && type === GLB_BIN) {
      binLen = len;
      binAt = start;
    } else {
      return 'unexpected chunk';
    }
    n++;
    off = start + len;
  }
  if (!isObj(json)) return 'JSON';
  const scan = scanJson(json);
  if (scan === 'huge') return 'JSON too large';
  if (scan.uri) return 'external reference';
  const g = json;
  for (const key of REFUSED_COLLECTIONS) if (g[key] !== undefined) return key;
  if (g.extensionsRequired !== undefined && (!Array.isArray(g.extensionsRequired) || g.extensionsRequired.length)) return 'required extension';
  if (g.extensionsUsed !== undefined && (!Array.isArray(g.extensionsUsed) || g.extensionsUsed.some((e) => !VISUAL_GLB_EXTENSIONS.includes(e as string)))) return 'extension';
  if (scan.extension) return 'extension';
  for (const k of Object.keys(g)) if (!KEYS.top.has(k)) return `unexpected ${k.slice(0, 32)}`;
  if (!isObj(g.asset)) return 'asset';
  for (const [key, max] of [['nodes', 512], ['meshes', 512], ['materials', 256], ['accessors', 4096], ['bufferViews', 4096], ['scenes', 8]] as const) {
    const v = g[key];
    if (v !== undefined && (!Array.isArray(v) || v.length > max)) return `${key}`;
  }
  const buffers = (g.buffers ?? []) as unknown[];
  if (!Array.isArray(buffers) || buffers.length > 1) return 'buffers';
  let bufLen = 0;
  if (buffers.length === 1) {
    const bf = buffers[0];
    if (!isObj(bf) || !keysOk(bf, KEYS.buffer) || !isCount(bf.byteLength, b.length)) return 'buffer';
    if (binLen < 0 || bf.byteLength > binLen) return 'buffer is not in the file';
    bufLen = bf.byteLength;
  }
  const views = (g.bufferViews ?? []) as unknown[];
  const viewLen: number[] = [];
  const viewOff: number[] = [];
  const viewStride: number[] = [];
  for (const v of views) {
    if (!isObj(v) || !keysOk(v, KEYS.bufferView) || v.buffer !== 0 || !isCount(v.byteLength, bufLen)) return 'bufferView';
    const o = v.byteOffset === undefined ? 0 : v.byteOffset;
    if (!isCount(o, bufLen) || o + v.byteLength > bufLen) return 'bufferView range';
    if (v.byteStride !== undefined && !(isCount(v.byteStride, 252) && v.byteStride >= 4 && v.byteStride % 4 === 0)) return 'bufferView stride';
    viewLen.push(v.byteLength);
    viewOff.push(o);
    viewStride.push((v.byteStride as number | undefined) ?? 0);
  }
  const accessors = (g.accessors ?? []) as unknown[];
  const acc: { count: number; comp: number; ctype: number; per: number; view: number; at: number; stride: number; min?: number[]; max?: number[] }[] = [];
  for (const a of accessors) {
    if (!isObj(a) || !keysOk(a, KEYS.accessor)) return 'accessor';
    const comp = COMPONENT_BYTES.get(a.componentType);
    const per = TYPE_COMPONENTS.get(a.type);
    if (comp === undefined || per === undefined || !isCount(a.count, 500_000) || a.count < 1) return 'accessor';
    if (a.normalized !== undefined && typeof a.normalized !== 'boolean') return 'accessor';
    if ((a.min !== undefined && !finiteList(a.min, per)) || (a.max !== undefined && !finiteList(a.max, per))) return 'accessor bounds';
    if (!isCount(a.bufferView, views.length - 1)) return 'accessor has no buffer view';
    const at = a.byteOffset === undefined ? 0 : a.byteOffset;
    if (!isCount(at, bufLen) || at % comp !== 0 || (viewOff[a.bufferView] + at) % comp !== 0) return 'accessor offset';
    const elem = comp * per;
    const stride = viewStride[a.bufferView] || elem;
    if (stride < elem) return 'accessor stride';
    if (at + (a.count - 1) * stride + elem > viewLen[a.bufferView]) return 'accessor range';
    acc.push({ count: a.count, comp, ctype: a.componentType as number, per, view: a.bufferView, at, stride, min: a.min as number[] | undefined, max: a.max as number[] | undefined });
  }
  const materials = (g.materials ?? []) as unknown[];
  for (const m of materials) {
    if (!isObj(m)) return 'material';
    if (Object.keys(m).some((k) => /Texture$/.test(k))) return 'textures';
    if (!keysOk(m, KEYS.material)) return 'material';
    // ⚠️ OPAQUE ONLY: the importer writes opaque materials (`buildMeshGroup`), and BLEND turns off the
    // depth write, so 150,000 copies of one translucent triangle are each shaded over everything
    if (m.alphaMode !== undefined && m.alphaMode !== 'OPAQUE') return 'material blending';
    if (m.doubleSided !== undefined && typeof m.doubleSided !== 'boolean') return 'material';
    if ((m.alphaCutoff !== undefined && !finiteNum(m.alphaCutoff)) || (m.emissiveFactor !== undefined && !finiteList(m.emissiveFactor, 3))) return 'material';
    if (m.pbrMetallicRoughness !== undefined) {
      const p = m.pbrMetallicRoughness;
      if (!isObj(p)) return 'material';
      if (Object.keys(p).some((k) => /Texture$/.test(k))) return 'textures';
      if (!keysOk(p, KEYS.pbr)) return 'material';
      if (p.baseColorFactor !== undefined && !finiteList(p.baseColorFactor, 4)) return 'material';
      if ((p.metallicFactor !== undefined && !finiteNum(p.metallicFactor)) || (p.roughnessFactor !== undefined && !finiteNum(p.roughnessFactor))) return 'material';
    }
  }
  /** the index values of accessor `i`, each checked against `n` vertices */
  const indicesInRange = (i: number, n: number): boolean => {
    const a = acc[i];
    const base = binAt + viewOff[a.view] + a.at;
    for (let k = 0; k < a.count; k++) {
      const at = base + k * a.stride;
      const v = a.ctype === 5121 ? b[at] : a.ctype === 5123 ? dv.getUint16(at, true) : dv.getUint32(at, true);
      if (v >= n) return false;
    }
    return true;
  };
  const meshes = (g.meshes ?? []) as unknown[];
  const meshTris: number[] = [];
  /** each mesh's primitives (its draw calls) and their POSITION accessors */
  const meshPos: number[][] = [];
  let tris = 0;
  let prims = 0;
  for (const m of meshes) {
    const posOf: number[] = [];
    meshPos.push(posOf);
    if (!isObj(m) || !keysOk(m, KEYS.mesh) || !Array.isArray(m.primitives) || m.primitives.length > 64) return 'mesh';
    let t = 0;
    for (const p of m.primitives as unknown[]) {
      if (!isObj(p) || !keysOk(p, KEYS.primitive) || !isObj(p.attributes)) return 'primitive';
      if (p.mode !== undefined && p.mode !== 4) return 'primitive mode';
      const pos = p.attributes.POSITION;
      if (!isCount(pos, accessors.length - 1)) return 'primitive has no positions';
      if (acc[pos].per !== 3 || acc[pos].ctype !== 5126) return 'primitive positions';
      const nv = acc[pos].count;
      for (const k of Object.keys(p.attributes)) {
        if (!ATTRIBUTES.has(k)) return 'primitive attribute';
        const ai = p.attributes[k];
        if (!isCount(ai, accessors.length - 1)) return 'primitive attribute';
        // every attribute names a value per vertex: one short of the positions is a read past it
        if (acc[ai].count !== nv) return 'primitive attribute count';
        if (k === '_BODY' && (acc[ai].per !== 1 || (acc[ai].ctype !== 5123 && acc[ai].ctype !== 5125))) return 'primitive attribute';
      }
      if (p.material !== undefined && !isCount(p.material, materials.length - 1)) return 'primitive material';
      if (p.indices !== undefined) {
        if (!isCount(p.indices, accessors.length - 1)) return 'primitive indices';
        const ia = acc[p.indices];
        // glTF gives an index buffer no stride, and three would read one as interleaved
        if (ia.per !== 1 || !INDEX_TYPES.has(ia.ctype) || ia.count % 3 !== 0 || viewStride[ia.view]) return 'primitive indices';
        // ⚠️ COUNTED BEFORE THEY ARE READ: thousands of primitives may name ONE index accessor of
        // 450,000 values, and reading it for each held the room's thread 5.1 s on a 694 KB file
        if (tris + t + ia.count / 3 > VISUAL_MAX_TRIANGLES) return 'too many triangles';
        if (!indicesInRange(p.indices, nv)) return 'index out of range';
        t += ia.count / 3;
      } else {
        t += Math.floor(nv / 3);
        if (tris + t > VISUAL_MAX_TRIANGLES) return 'too many triangles';
      }
      posOf.push(pos);
      prims++;
    }
    meshTris.push(t);
    tris += t;
  }
  if (!prims) return 'no geometry';
  if (tris > VISUAL_MAX_TRIANGLES) return 'too many triangles';
  // ---- the node graph: a forest, not too deep, and its triangles counted per node that draws
  const nodes = (g.nodes ?? []) as unknown[];
  const parent = new Int32Array(nodes.length).fill(-1);
  const local: Float64Array[] = [];
  let drawn = 0;
  let drawCalls = 0;
  for (let i = 0; i < nodes.length; i++) {
    const nd = nodes[i];
    if (!isObj(nd) || !keysOk(nd, KEYS.node)) return 'node';
    if (nd.mesh !== undefined) {
      if (!isCount(nd.mesh, meshes.length - 1)) return 'node';
      drawn += meshTris[nd.mesh];
      drawCalls += meshPos[nd.mesh].length;
    }
    if (nd.matrix !== undefined && !finiteList(nd.matrix, 16)) return 'node transform';
    if (nd.translation !== undefined && !finiteList(nd.translation, 3)) return 'node transform';
    if (nd.rotation !== undefined && !finiteList(nd.rotation, 4)) return 'node transform';
    if (nd.scale !== undefined && !finiteList(nd.scale, 3)) return 'node transform';
    const lm = localMatrix(nd);
    if (!lm) return 'node transform';
    local.push(lm);
    if (nd.children !== undefined) {
      if (!Array.isArray(nd.children)) return 'node';
      for (const c of nd.children) {
        // one parent each, and never itself: the graph glTF calls a forest
        if (!isCount(c, nodes.length - 1) || c === i || parent[c] !== -1) return 'node graph';
        parent[c] = i;
      }
    }
  }
  // a node more than VISUAL_GLB_MAX_DEPTH parents deep is too deep, and one on a cycle is
  // infinitely deep (with one parent each, a walk up either ends or loops)
  const depth = new Int32Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    let d = 0;
    for (let p = parent[i]; p !== -1; p = parent[p]) if (++d > VISUAL_GLB_MAX_DEPTH) return 'node graph';
    depth[i] = d;
  }
  if (drawn > VISUAL_MAX_TRIANGLES) return 'too many triangles';
  if (drawCalls > VISUAL_MAX_DRAWN_PRIMITIVES) return 'too many draw calls';
  // ---- the positions: every value read, finite, and inside what the accessor declares --------------
  /** per POSITION accessor: its box [minX, minY, minZ, maxX, maxY, maxZ], read once */
  const posBox = new Map<number, Float64Array>();
  let posRead = 0;
  for (const list of meshPos) {
    for (const ai of list) {
      if (posBox.has(ai)) continue;
      const a = acc[ai];
      posRead += a.count;
      if (posRead > VISUAL_MAX_POSITIONS) return 'too many vertices';
      const box = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
      const base = binAt + viewOff[a.view] + a.at;
      for (let k = 0; k < a.count; k++) {
        const at = base + k * a.stride;
        for (let c = 0; c < 3; c++) {
          const v = dv.getFloat32(at + 4 * c, true);
          if (!Number.isFinite(v)) return 'position not finite';
          if (v < box[c]) box[c] = v;
          if (v > box[c + 3]) box[c + 3] = v;
        }
      }
      // three sizes its culling volumes from `min`/`max` without reading the data, so they must hold
      // it (to a float32's rounding: an exporter may print the double it computed them in)
      const slack = (x: number): number => 1e-5 * (1 + Math.abs(x));
      if (a.min && [0, 1, 2].some((c) => box[c] < a.min![c] - slack(a.min![c]))) return 'accessor bounds';
      if (a.max && [0, 1, 2].some((c) => box[c + 3] > a.max![c] + slack(a.max![c]))) return 'accessor bounds';
      posBox.set(ai, box);
    }
  }
  // ---- where it is drawn: each node's transform composed down from its root, every drawn box inside
  // VISUAL_MESH_BOX (the box's eight corners, so a rotation can only make it stricter) ----------------
  const order = Array.from({ length: nodes.length }, (_, i) => i).sort((a, b) => depth[a] - depth[b]);
  const world: Float64Array[] = new Array(nodes.length);
  const { min: lo, max: hi } = VISUAL_MESH_BOX;
  for (const i of order) {
    world[i] = parent[i] === -1 ? local[i] : mulAffine(world[parent[i]], local[i]);
    const W = world[i];
    if (!W.every(Number.isFinite)) return 'node transform';
    const mi = (nodes[i] as Json).mesh;
    if (mi === undefined) continue;
    for (const ai of meshPos[mi as number]) {
      const b = posBox.get(ai)!;
      for (let corner = 0; corner < 8; corner++) {
        const x = corner & 1 ? b[3] : b[0];
        const y = corner & 2 ? b[4] : b[1];
        const z = corner & 4 ? b[5] : b[2];
        for (let r = 0; r < 3; r++) {
          const v = W[r] * x + W[4 + r] * y + W[8 + r] * z + W[12 + r];
          if (!(v >= lo[r] && v <= hi[r])) return 'outside the robot box';
        }
      }
    }
  }
  const scenes = (g.scenes ?? []) as unknown[];
  for (const sc of scenes) {
    if (!isObj(sc) || !keysOk(sc, KEYS.scene)) return 'scene';
    if (sc.nodes !== undefined) {
      if (!Array.isArray(sc.nodes)) return 'scene';
      // a scene's roots are roots, each listed once
      const seen = new Set<number>();
      for (const r of sc.nodes) {
        if (!isCount(r, nodes.length - 1) || parent[r] !== -1 || seen.has(r)) return 'scene';
        seen.add(r);
      }
    }
  }
  if (g.scene !== undefined && !isCount(g.scene, scenes.length - 1)) return 'scene';
  return null;
}

/** the validator for a kind */
export function validateVisual(kind: VisualKind, b: Uint8Array): string | null {
  return kind === 'top' ? validateTopPng(b) : validateMeshGlb(b);
}
