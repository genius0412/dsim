import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ImportedRobot, RobotSpec, Vec2 } from '../../../types';
import {
  ANY_ID,
  IMPORTED_MESH_TO_ROBOT,
  importedMeshBlob,
  importedMeshVersion,
  subscribeImportedAssets,
} from '../../../render/importedAssets';
import { polyGrow } from '../../../sim/imported';
import { frontArrowSpot } from '../../../render/drawImported';
import { BB_DECK_Z } from '../config';
import { loader } from './renderElementsGlb';
import { readStoredMotion, ROBOT_MESH_BOX_IN, type StoredMotion } from '../../../robotImport/types';
import { finishOf, OLD_FINISH } from '../../../robotImport/finish';

/**
 * BIOBUZZ 3D — AN IMPORTED ROBOT'S OWN PARTS (`docs/robot-import-plan.md` §1 "In a match").
 *
 * `buildRobotGroup` (`renderRobots.ts`) is still the ONE generator, for the match and the builder
 * preview alike: for a spec with `imported` it composes these pieces with its own sign, intake,
 * turret and Box Tube builders (`buildImportedRobot` there). This file holds what is specific to an
 * import and needs nothing of `renderRobots.ts` — so the dependency runs one way.
 *
 *  - THE MESH: the stored GLB (`importedMeshBlob`, frame `IMPORTED_MESH_TO_ROBOT`: glTF metres,
 *    +Y up, +Z front, +X left) parsed ONCE per id by the scene's own GLTFLoader + meshopt decoder,
 *    kept as a TEMPLATE and CLONED per robot (geometry, materials and textures shared, never
 *    disposed by a robot group — `isImportShared`). A small LRU of templates
 *    (`IMPORTED_MESH_TEMPLATE_CAP`), each reference-counted, so a template is freed only when no
 *    robot on any scene still wears it.
 *  - ITS STATE IN THE REBUILD KEY: `importedMeshKey` is `id@meshVersion:hull|mesh`, and it starts
 *    the load the first time it is asked. The match's `sync` and the preview's `setSpec` fold it
 *    into the key they already rebuild on, so the group swaps from the placeholder to the mesh on
 *    the first frame after the parse lands; `onImportedMeshChange` tells the preview, which only
 *    rebuilds when React hands it a spec.
 *  - THE PLACEHOLDER'S GEOMETRY: the hull (or each band) extruded, and the OPEN TOWER above the
 *    deck — `renderRobots.ts`'s own "an FTC robot is not a brick" rule applied to an envelope.
 *
 * ── THE RULES IT KEEPS ──────────────────────────────────────────────────────────────────────
 *  - A ROBOT PART NEVER GLOWS (owner, 2026-09-27): every imported material's emissive is zeroed
 *    at parse, whatever the file asked for.
 *  - THE PHYSICAL-MATERIALS SWAP LEAVES THE MESH ALONE: its meshes carry no `bbFamily`, and
 *    `renderSurfaceRobots.ts` skips an untagged mesh by design. Its own PBR materials are drawn in
 *    both modes; tagging them would park per-import twins in the document-lifetime twin cache.
 *  - It casts shadows and receives none, like every other robot part (`cast`).
 */

/** how many parsed meshes stay resident (a 2v2 room is four; the preview is one more) */
export const IMPORTED_MESH_TEMPLATE_CAP = 6;

interface MeshSlot {
  id: string;
  /** the robot this slot's mesh is for: a slot answers for one DESCRIPTOR, not just an id */
  imp: ImportedRobot;
  state: 'loading' | 'ready' | 'none';
  root: THREE.Group | null;
  /** robot groups currently wearing a clone of `root` */
  users: number;
  /** LRU stamp */
  used: number;
  /** resolves when the load is over (`state` is no longer 'loading'); never rejects */
  settled: Promise<void>;
}

/** keyed `${id}@${importedMeshVersion(id)}#${digest of the descriptor}` (`slotKey`) */
const slots = new Map<string, MeshSlot>();
let stamp = 0;
/** every geometry, material and texture a TEMPLATE owns: a robot group must never free them */
const SHARED = new WeakSet<object>();
const listeners = new Set<(id: string) => void>();

/**
 * ⚠️ A SLOT IS ONE DESCRIPTOR, NOT ONE ID. After the robot is edited on another device the synced
 * spec keeps its id while its hull moves, and this device's library may still hold the OLD model
 * (`render/importedAssets.ts`, "AN OUT-OF-DATE COPY IS NOT DRAWN"). Keyed by id alone, the slot
 * parsed for the old descriptor answered for the new one and the old model was drawn on the new
 * hull; keyed by the descriptor too, the new one loads through `importedMeshBlob(id, imp)`, which
 * refuses the stale copy, and the robot is its placeholder until the model is re-imported.
 */
const digests = new WeakMap<ImportedRobot, string>();
function digestOf(imp: ImportedRobot): string {
  let d = digests.get(imp);
  if (d === undefined) {
    const s = JSON.stringify({ ...imp, id: '' });
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    d = (h >>> 0).toString(16);
    digests.set(imp, d);
  }
  return d;
}

function slotKey(imp: ImportedRobot): string {
  return `${imp.id}@${importedMeshVersion(imp.id)}#${digestOf(imp)}`;
}

function notify(id: string): void {
  for (const cb of [...listeners]) {
    try {
      cb(id);
    } catch {
      /* a listener's throw is its own */
    }
  }
}

/** a mesh became ready (or settled on "none") for `id` — the preview rebuilds on it */
export function onImportedMeshChange(cb: (id: string) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// a re-registered draft, a relayed mesh or a new source moves the mesh version, which names a NEW
// slot; the stale one is dropped as soon as nothing wears it, and listeners re-key
subscribeImportedAssets((id) => {
  for (const [k, s] of slots) if ((id === ANY_ID || s.id === id) && k !== slotKey(s.imp)) dropIfUnused(k, s);
  notify(id);
});

function materialsOf(m: THREE.Mesh): THREE.Material[] {
  return Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
}

function texturesOf(mat: THREE.Material): THREE.Texture[] {
  const out: THREE.Texture[] = [];
  for (const v of Object.values(mat as unknown as Record<string, unknown>)) if (v instanceof THREE.Texture) out.push(v);
  return out;
}

/** free everything under a TEMPLATE root (geometries, materials, textures) */
function disposeTemplate(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry?.dispose();
    for (const mat of materialsOf(m)) {
      for (const t of texturesOf(mat)) t.dispose();
      mat.dispose();
    }
  });
}

function dropIfUnused(k: string, s: MeshSlot): void {
  if (s.users > 0 || s.state === 'loading') return;
  if (s.root) disposeTemplate(s.root);
  slots.delete(k);
}

function evict(): void {
  while (slots.size > IMPORTED_MESH_TEMPLATE_CAP) {
    let oldest: [string, MeshSlot] | null = null;
    for (const e of slots) if (e[1].users === 0 && e[1].state !== 'loading' && (!oldest || e[1].used < oldest[1].used)) oldest = e;
    if (!oldest) return; // everything is worn or loading: over the cap until something is released
    dropIfUnused(oldest[0], oldest[1]);
  }
}

/**
 * A quantised or interleaved attribute → plain Float32, values as the loader reads them (dequantised
 * by the node's transform, which stays). The stored mesh is quantised (`robotImport/engine/
 * storedGlb.ts`), and ANGLE on D3D11 draws quantised attributes slower: four robots of 250k
 * triangles took 2.21 ms a frame left quantised and 1.31 ms as float (RTX 4070 Ti, 1080p,
 * 2026-10-03). A float mesh saved before is left as it is.
 */
export function floatAttribute(geo: THREE.BufferGeometry, name: string): void {
  const a = geo.getAttribute(name);
  if (!a) return;
  const inter = (a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute ? (a as THREE.InterleavedBufferAttribute) : null;
  if (!inter && a.array instanceof Float32Array && !a.normalized) return;
  const k = a.itemSize;
  const out = new Float32Array(a.count * k);
  // straight off the typed array, as `getComponent` reads it (three's `denormalize`, value for
  // value): a call per component took ~0.4 s on the main thread for a 5.7M-triangle robot
  const src = inter ? inter.data.array : a.array;
  const stride = inter ? inter.data.stride : k;
  const off = inter ? inter.offset : 0;
  const div = !a.normalized
    ? 0
    : src instanceof Uint8Array
      ? 255
      : src instanceof Int8Array
        ? 127
        : src instanceof Uint16Array
          ? 65535
          : src instanceof Int16Array
            ? 32767
            : src instanceof Uint32Array
              ? 4294967295
              : src instanceof Int32Array
                ? 2147483647
                : 0;
  const signed = src instanceof Int8Array || src instanceof Int16Array || src instanceof Int32Array;
  if (a.normalized && !div) {
    for (let i = 0; i < a.count; i++) for (let c = 0; c < k; c++) out[i * k + c] = a.getComponent(i, c);
  } else {
    for (let i = 0; i < a.count; i++) {
      const s = i * stride + off;
      for (let c = 0; c < k; c++) {
        let v = src[s + c] as number;
        if (div) {
          v /= div;
          if (signed && v < -1) v = -1;
        }
        out[i * k + c] = v;
      }
    }
  }
  geo.setAttribute(name, new THREE.BufferAttribute(out, k));
}

/**
 * A geometry's bounding box and sphere from its POSITIONS, as three's `computeBoundingBox` /
 * `computeBoundingSphere` make them (the box's centre, the farthest vertex from it), straight off the
 * Float32 array `floatAttribute` leaves. GLTFLoader sizes them from the accessor's `min`/`max`
 * without reading the data, so a file that lies there is culled, and measured, as something it is not.
 */
function exactBounds(geo: THREE.BufferGeometry): void {
  const a = geo.getAttribute('position');
  if (!a || !(a.array instanceof Float32Array) || a.itemSize !== 3 || (a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) {
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return;
  }
  const p = a.array;
  const n = a.count * 3;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < n; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
    // a NaN passes no comparison: poison the box so `importedMeshFits` sees it
    if (x !== x || y !== y || z !== z) x0 = NaN;
  }
  geo.boundingBox = new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
  let r2 = 0;
  for (let i = 0; i < n; i += 3) {
    const dx = p[i] - cx, dy = p[i + 1] - cy, dz = p[i + 2] - cz;
    const d = dx * dx + dy * dy + dz * dz;
    if (d > r2) r2 = d;
  }
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, cy, cz), Math.sqrt(r2));
}

/** a geometry's surface area in its own units², off its (Float32, non-interleaved) positions */
function surfaceArea(geo: THREE.BufferGeometry): number {
  const a = geo.getAttribute('position');
  if (!a || !(a.array instanceof Float32Array) || a.itemSize !== 3 || (a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) return Infinity;
  const p = a.array;
  const idx = geo.getIndex()?.array;
  const tris = idx ? Math.floor(idx.length / 3) : Math.floor(a.count / 3);
  let sum = 0;
  for (let t = 0; t < tris; t++) {
    const i = (idx ? idx[3 * t] : 3 * t) * 3;
    const j = (idx ? idx[3 * t + 1] : 3 * t + 1) * 3;
    const k = (idx ? idx[3 * t + 2] : 3 * t + 2) * 3;
    const ux = p[j] - p[i], uy = p[j + 1] - p[i + 1], uz = p[j + 2] - p[i + 2];
    const vx = p[k] - p[i], vy = p[k + 1] - p[i + 1], vz = p[k + 2] - p[i + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    sum += Math.sqrt(cx * cx + cy * cy + cz * cz);
  }
  return sum / 2;
}

/**
 * THE MOST SURFACE A MESH MAY DRAW, m². It is what bounds OVERDRAW: 150,000 copies of one large
 * triangle inside the box below shade the robot's whole screen area 150,000 times a frame. A mesh's
 * area is its CAD's own surface, not its tessellation's: measured on the stress robots (every screw
 * thread, gear tooth and chain link; `scripts/robot-import/stress.ts`) it is 1.49 m² at 0.47 M
 * triangles, 1.49 at 1.55 M and 1.54 at 3.85 M, so finer detail adds almost none. The fixtures are
 * 0.85 m², the robot with moving parts 1.05, the stress robot's relay copy 1.25. The vendors' own
 * STEP files are not in the repo to measure; by count, 11,000 bodies (goBILDA's BIOBUZZ bot at Full)
 * of 10 cm² each is 11 m². The whole box below (2 m × 2 m × 2.5 m) as plain walls is 28 m². 100 m²
 * is sixty-odd times the stress robot, nine times that estimate and over three times the walled box.
 */
export const IMPORTED_MESH_MAX_AREA_M2 = 100;
const IN_PER_M = 1 / 0.0254;
/** float slack on the box, inches: the relay composes a node chain and then the point, this composes the
 *  matrices first, so a vertex exactly at the limit can differ by a rounding (1e-14) either way */
const BOX_SLACK_IN = 1e-6;

/**
 * ⚠️ DOES THIS PARSED MESH FIT? (merge audit 2026-11, M-IMP-TRUST-01, defence in depth). A relayed
 * mesh is validated by the room and by this viewer (`validateMeshGlb`), but a LAN host or an older
 * room runs an older check, and a share file a stranger made is drawn from this device's library
 * without one. So the template itself is measured, in the robot frame (`prepareImportedMesh` put it
 * there, and `exactBounds` sized each geometry from its data): its box must be finite and inside
 * `ROBOT_MESH_BOX_IN`, THE SAME BOX THE RELAY'S VALIDATOR ENFORCES (`VISUAL_MESH_BOX`; about ±39 in sideways,
 * 20 below the floor, 79 up), and its surface no more than `IMPORTED_MESH_MAX_AREA_M2`. One that does not
 * is not drawn: the robot is its placeholder.
 *
 * ⚠️ NEVER STRICTER THAN THE RELAY (RI-01). A box tied to the robot's own hull refused the model of a
 * robot with a deployed ramp or a tall lift left out of the footprint (`ImportSetup.apart`) that the
 * room had accepted, stored and served, so every screen drew a placeholder, the owner's drive included.
 * The editor's Review blocks a model that leaves the box (`meshReach`), so a saved robot fits.
 *
 * The area is each geometry's own times its node's largest axis scale squared (three composes every
 * node from a rotation and a scale, so that is exact for a mesh with no skew under it). `_imp` is the
 * robot the slot answers for; the box does not depend on it.
 */
export function importedMeshFits(root: THREE.Object3D, _imp: ImportedRobot): boolean {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const part = new THREE.Box3();
  let area = 0;
  let ok = true;
  root.traverse((o) => {
    // what the importer never writes, and what would move or multiply vertices past the box below:
    // instances (GPU instancing), skinning, morph targets, points, lines and sprites
    const x = o as THREE.Object3D & { isInstancedMesh?: boolean; isSkinnedMesh?: boolean; isPoints?: boolean; isLine?: boolean; isSprite?: boolean };
    if (x.isInstancedMesh || x.isSkinnedMesh || x.isPoints || x.isLine || x.isSprite) ok = false;
    const m = o as THREE.Mesh;
    if (!ok || !m.isMesh || !m.geometry) return;
    if (Object.keys(m.geometry.morphAttributes).length) ok = false;
    if (!m.geometry.boundingBox) exactBounds(m.geometry);
    part.copy(m.geometry.boundingBox!).applyMatrix4(m.matrixWorld);
    const s = m.matrixWorld.getMaxScaleOnAxis();
    const a = surfaceArea(m.geometry) * s * s;
    if (![part.min.x, part.min.y, part.min.z, part.max.x, part.max.y, part.max.z, a].every(Number.isFinite)) ok = false;
    box.union(part);
    area += a;
  });
  if (!ok || box.isEmpty()) return false;
  const { min: lo, max: hi } = ROBOT_MESH_BOX_IN;
  return (
    box.min.x >= lo[0] - BOX_SLACK_IN && box.max.x <= hi[0] + BOX_SLACK_IN &&
    box.min.y >= lo[1] - BOX_SLACK_IN && box.max.y <= hi[1] + BOX_SLACK_IN &&
    box.min.z >= lo[2] - BOX_SLACK_IN && box.max.z <= hi[2] + BOX_SLACK_IN &&
    area <= IMPORTED_MESH_MAX_AREA_M2 * IN_PER_M * IN_PER_M
  );
}

/**
 * A parsed glTF scene → a TEMPLATE in the robot frame: wrapped in one node carrying
 * `IMPORTED_MESH_TO_ROBOT` (inches, +x front, +z up), positions and normals as plain Float32,
 * normals computed where the file has none, bounds sized from the positions, opaque, no emissive
 * anywhere, every resource registered as shared. Whether it may be drawn is `importedMeshFits`.
 */
export function prepareImportedMesh(scene: THREE.Object3D): THREE.Group {
  const root = new THREE.Group();
  root.name = 'bb-import-mesh';
  root.matrixAutoUpdate = false;
  root.matrix.fromArray(IMPORTED_MESH_TO_ROBOT as number[]);
  root.add(scene);
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = true;
    // self-shadowing is what gives a robot its depth (an arm over the chassis, the frame over the
    // wheels); without it the model read as a flat cut-out (2026-10-03, "Mesh quality")
    m.receiveShadow = true;
    floatAttribute(m.geometry, 'position');
    floatAttribute(m.geometry, 'normal');
    // the body ids are the editor's (picking parts); here they would only be uploaded and never read
    m.geometry.deleteAttribute('_body');
    if (!m.geometry.getAttribute('normal')) m.geometry.computeVertexNormals();
    exactBounds(m.geometry);
    SHARED.add(m.geometry);
    for (const mat of materialsOf(m)) {
      // ⚠️ A ROBOT PART NEVER GLOWS — whatever the CAD exporter wrote
      const e = mat as THREE.MeshStandardMaterial;
      if (e.emissive) e.emissive.setRGB(0, 0, 0);
      // ...and is OPAQUE: the importer writes nothing else, and a blended material writes no depth,
      // so every layer of it is shaded (the relay refuses one; a share file is not relayed)
      e.transparent = false;
      e.opacity = 1;
      e.depthWrite = true;
      e.alphaTest = 0;
      // a mesh stored before finishes existed (every part matte plastic) gets its colour's finish
      if (e.isMeshStandardMaterial && Math.abs(e.metalness - OLD_FINISH.metalness) < 1e-3 && Math.abs(e.roughness - OLD_FINISH.roughness) < 1e-3) {
        Object.assign(e, finishOf([e.color.r, e.color.g, e.color.b]));
      }
      if ('emissiveMap' in e) e.emissiveMap = null;
      SHARED.add(mat);
      for (const t of texturesOf(mat)) SHARED.add(t);
    }
  });
  root.updateMatrixWorld(true);
  return root;
}

async function load(imp: ImportedRobot, k: string, s: MeshSlot): Promise<void> {
  const id = imp.id;
  try {
    // with the descriptor: a library copy made for another version of this robot answers null
    const blob = await importedMeshBlob(id, imp);
    if (!blob) {
      s.state = 'none';
    } else {
      const buf = await blob.arrayBuffer();
      const gltf = await loader().parseAsync(buf, '');
      if (slots.get(k) !== s) {
        // superseded while parsing: nothing will ever wear it
        disposeTemplate(gltf.scene);
        return;
      }
      const root = prepareImportedMesh(gltf.scene);
      if (importedMeshFits(root, imp)) {
        s.root = root;
        s.state = 'ready';
      } else {
        // not robot-sized, not finite, or too much surface: the placeholder, never the file
        console.warn(`[import] the 3D model of ${id} does not fit its robot; drawing its outline`);
        disposeTemplate(root);
        s.state = 'none';
      }
    }
  } catch {
    s.state = 'none';
  }
  evict();
  notify(id);
}

function ensureSlot(imp: ImportedRobot): MeshSlot {
  const k = slotKey(imp);
  let s = slots.get(k);
  if (!s) {
    s = { id: imp.id, imp, state: 'loading', root: null, users: 0, used: 0, settled: Promise.resolve() };
    slots.set(k, s);
    s.settled = load(imp, k, s);
    evict();
  }
  s.used = ++stamp;
  return s;
}

/**
 * Resolves once every import among `specs` has its mesh SETTLED — parsed, or known not to be on
 * this device — starting any load not yet asked for (`GameScene.assetsSettled`). The replay export
 * draws its frames in one synchronous burst, so a parse that lands mid-export used to leave the
 * first frames on the placeholder (integration review 2026-10-02).
 */
export function importedMeshesSettled(specs: readonly RobotSpec[]): Promise<void> {
  return Promise.all(specs.map((sp) => (sp.imported ? ensureSlot(sp.imported).settled : undefined))).then(() => undefined);
}

/**
 * THE MESH HALF OF THE REBUILD KEY — `''` for a standard robot, else `id@version:hull` until the
 * mesh is parsed and `…:mesh` after. Asking STARTS the load, so the first frame that sees an
 * import is the one that fetches it. Main-chunk keys (`bbSpecKey`) do not carry it: it is per
 * device, like the wheel tier.
 */
export function importedMeshKey(spec: RobotSpec): string {
  const imp = spec.imported;
  if (!imp) return '';
  const s = ensureSlot(imp);
  return `${slotKey(imp)}:${s.state === 'ready' ? 'mesh' : 'hull'}`;
}

/**
 * A clone of the import's parsed mesh, in the robot frame, or `null` while it is not ready (or
 * not on this device). The clone shares the template's resources; `releaseImportedMesh` (called by
 * `disposeRobotGroup`) hands the reference back.
 */
export function cloneImportedMesh(spec: RobotSpec): THREE.Group | null {
  const imp = spec.imported;
  if (!imp) return null;
  const s = ensureSlot(imp);
  if (s.state !== 'ready' || !s.root) return null;
  const g = s.root.clone(true);
  g.userData.importSlot = slotKey(imp);
  s.users++;
  return g;
}

/** hand back every template reference held under `group` (idempotent) */
export function releaseImportedMesh(group: THREE.Object3D): void {
  group.traverse((o) => {
    const k = o.userData.importSlot as string | undefined;
    if (!k) return;
    delete o.userData.importSlot;
    const s = slots.get(k);
    if (s && s.users > 0) s.users--;
  });
  for (const [k, s] of slots) if (k !== slotKey(s.imp)) dropIfUnused(k, s);
  evict();
}

/** is this geometry / material / texture owned by a mesh TEMPLATE (never a robot group's to free)? */
export function isImportShared(o: object): boolean {
  return SHARED.has(o);
}

/** TEST ONLY: the resident templates, as `[key, state, users]` */
export function importedMeshSlots(): [string, string, number][] {
  return [...slots].map(([k, s]) => [k, s.state, s.users]);
}

/** TEST ONLY: install a parsed scene as `spec`'s ready template without a blob or a loader */
export function installImportedMeshForTests(spec: RobotSpec, scene: THREE.Object3D): void {
  const imp = spec.imported;
  if (!imp) return;
  const k = slotKey(imp);
  const old = slots.get(k);
  if (old?.root) disposeTemplate(old.root);
  slots.set(k, { id: imp.id, imp, state: 'ready', root: prepareImportedMesh(scene), users: old?.users ?? 0, used: ++stamp, settled: Promise.resolve() });
  notify(imp.id);
}

// ──────────────────────────────────────────────────────────── the moving parts ──

/**
 * ONE MOVING PART OF AN IMPORTED MESH (`docs/area/robot-import.md`, "Moving parts"): a node of the
 * stored GLB with `extras.dsim`, translated to its pivot, so turning it about its own `axis` (stored
 * mesh frame, which is the node's parent's frame when nothing above it has turned) turns it about the
 * part's own axle or hinge. `angle` is the renderer's running total for a spinning part.
 */
export interface ImportedMotionNode {
  node: THREE.Object3D;
  info: StoredMotion;
  axis: THREE.Vector3;
  /** the pivot and the axis in the ROBOT frame (inches, +x front), for a wheel's ground speed */
  at: { x: number; y: number };
  axisRobot: { x: number; y: number; z: number };
  /** the running value: a turn's angle (rad), a slide's travel (in) */
  angle: number;
  /** where the node sits at rest (its parent's frame), and stored-mesh units per inch: a slide moves
   *  it along `axis` from there */
  rest: THREE.Vector3;
  perInch: number;
}

/**
 * The moving parts of a CLONED import mesh (`cloneImportedMesh`), in the order they were stored.
 * Each node's pose is set from its role by `renderRobots.ts`'s sync; a mesh with none gives [].
 */
export function importedMotionNodes(mesh: THREE.Object3D): ImportedMotionNode[] {
  const out: ImportedMotionNode[] = [];
  mesh.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
  const toRobot = new THREE.Matrix4().fromArray(IMPORTED_MESH_TO_ROBOT as number[]);
  mesh.traverse((o) => {
    const info = readStoredMotion((o.userData as { dsim?: unknown }).dsim);
    if (!info) return;
    // the pivot in the robot frame: the node's world position relative to the mesh root, which IS
    // the robot frame (the root carries `IMPORTED_MESH_TO_ROBOT`)
    const p = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld).applyMatrix4(inv);
    const a = new THREE.Vector3(...info.axis).applyMatrix4(new THREE.Matrix4().extractRotation(toRobot)).normalize();
    out.push({ node: o, info, axis: new THREE.Vector3(...info.axis), at: { x: p.x, y: p.y }, axisRobot: { x: a.x, y: a.y, z: a.z }, angle: 0, rest: o.position.clone(), perInch });
  });
  // ⚠️ A SLIDE DOES NOT FOLLOW A PART THAT TURNS WITHOUT END (merge audit RI-06). A follower's travel is its
  // leader's running value times the ratio, and a wheel, roller, flywheel or `spin` adds to its value for
  // as long as the robot runs, so a relayed mesh whose slide followed one (the ratio is capped at ±100,
  // the product was not) carried that part further every frame, across the field and the camera. A turn
  // is periodic and harmless; a travel is not. Its `follow` is dropped, which leaves the slide to its own
  // drive and amount. Followed through a chain (a slide following a slide following a spin).
  const byId = new Map<number, ImportedMotionNode>();
  for (const m of out) if (m.info.id !== undefined) byId.set(m.info.id, m);
  const endless = (m: ImportedMotionNode, seen: Set<ImportedMotionNode>): boolean => {
    if (UNBOUNDED_ROLES.has(m.info.role)) return true;
    const lead = m.info.follow ? byId.get(m.info.follow.id) : undefined;
    if (!lead || seen.has(lead)) return false;
    seen.add(lead);
    return endless(lead, seen);
  };
  // decided for every slide first, then dropped, so the answer does not depend on the order they are stored in
  const drop = out.filter((m) => m.info.role === 'slide' && m.info.follow && endless(m, new Set([m])));
  for (const m of drop) delete m.info.follow;
  return out;
}

/** the roles whose running value only ever grows while the robot runs (a spinning part's angle) */
const UNBOUNDED_ROLES: ReadonlySet<string> = new Set(['wheel', 'roller', 'flywheel', 'spin']);

/** stored-mesh units per robot inch (`IMPORTED_MESH_TO_ROBOT` scales stored units to inches) */
const perInch = 1 / new THREE.Vector3().setFromMatrixColumn(new THREE.Matrix4().fromArray(IMPORTED_MESH_TO_ROBOT as number[]), 0).length();

// ──────────────────────────────────────────────────────────── the placeholder ──

/**
 * ⚠️ THE IMPORT'S HEIGHT IS READ HERE, AND `renderRobots.ts` STILL READS NONE. For a standard robot
 * `heightIn` is a declared COLLIDER extent and the generator is forbidden to draw it (the RENDER
 * lane's "the generator reads no height at all"). An import's `heightIn` is different in kind: it
 * is the MEASURED top of real hardware, and a placeholder that stopped at the deck would show a
 * remote player a robot half the height of the one they are about to hit. So the envelope is
 * drawn — as an open tower, never a solid — and the reads stay in this file.
 */

/** the placeholder's deck: the standard robot's (`BB_DECK_Z`), unless the import is lower */
export function importedDeckZ(imp: ImportedRobot): number {
  return Math.min(BB_DECK_Z, imp.heightIn);
}

/** one piece of a placeholder body: a solid prism to the deck, or the open tower above it */
export interface ImportedBodyPart {
  kind: 'hull' | 'tower';
  /** which prism of `bands` (0 for the hull itself) */
  index: number;
  geometry: THREE.BufferGeometry;
}

/**
 * THE PLACEHOLDER BODY: each prism (`bands`, or the hull to `heightIn` when there are none) SOLID
 * from 0.5 in to the deck, and OPEN above it. Geometry only; `renderRobots.ts` puts the chassis
 * fill on the solids and the structural dark on the towers, and tags both.
 */
export function importedBodyGeometries(imp: ImportedRobot): ImportedBodyPart[] {
  const deckZ = importedDeckZ(imp);
  const prisms = imp.bands && imp.bands.length > 0 ? imp.bands : [{ z0: 0, z1: imp.heightIn, hull: imp.hull }];
  const out: ImportedBodyPart[] = [];
  prisms.forEach((b, index) => {
    const z0 = Math.max(0.5, b.z0);
    const z1 = Math.min(deckZ, b.z1);
    if (z1 - z0 > 0.05) out.push({ kind: 'hull', index, geometry: hullPrismGeometry(b.hull, z0, z1) });
    const tower = openTowerGeometry(b.hull, Math.max(deckZ, b.z0), b.z1, 0.4, b.z0 > deckZ);
    if (tower) out.push({ kind: 'tower', index, geometry: tower });
  });
  return out;
}

/** the hull extruded from `z0` to `z1`, robot frame (+z up) */
export function hullPrismGeometry(hull: readonly Vec2[], z0: number, z1: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(hull.map((p) => new THREE.Vector2(p.x, p.y)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.01, z1 - z0), bevelEnabled: false, steps: 1, curveSegments: 1 });
  geo.translate(0, 0, z0);
  return geo;
}

/** a box `len` long along the segment a→b at height `z` (its top at z), `t` square in section */
function railAlong(a: Vec2, b: Vec2, z: number, t: number): THREE.BufferGeometry {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const g = new THREE.BoxGeometry(Math.max(0.01, len), t, t);
  g.rotateZ(Math.atan2(b.y - a.y, b.x - a.x));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, z - t / 2);
  return g;
}

/**
 * THE OPEN TOWER over `poly` from `z0` to `z1`: an upright at each vertex (inset so it stands
 * inside the hull) and a top rail along every edge — plus a bottom rail when `base` (a band that
 * starts above the deck). One merged geometry. This is how the standard robot shows a declared
 * height it has no solid parts for, and the placeholder borrows it for the part of an import's
 * envelope above the deck: the volume a remote player collides with, without a brick.
 */
export function openTowerGeometry(poly: readonly Vec2[], z0: number, z1: number, t = 0.4, base = false): THREE.BufferGeometry | null {
  if (z1 - z0 < 0.5 || poly.length < 3) return null;
  // inset by a FULL member width: a t-square post centred there reaches at most 0.71·t from its
  // centre, so no corner of a post or a rail end passes the hull, even at an acute vertex
  const inner = polyGrow(poly, -t);
  const ring = inner.length >= 3 ? inner : poly;
  const parts: THREE.BufferGeometry[] = [];
  for (const p of ring) {
    const g = new THREE.BoxGeometry(t, t, z1 - z0);
    g.translate(p.x, p.y, (z0 + z1) / 2);
    parts.push(g);
  }
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    parts.push(railAlong(a, b, z1, t));
    if (base) parts.push(railAlong(a, b, z0 + t, t));
  }
  const merged = mergeGeometries(parts.map((g) => g.toNonIndexed()), false);
  for (const g of parts) g.dispose();
  return merged;
}

/**
 * WHICH END IS THE FRONT, on an import's placeholder — `bbFrontMarks`' language on the hull: a
 * near-white bar along the edge(s) facing forward, standing on the deck, and the deck arrow at the
 * centroid pointing +x. Geometry only; `renderRobots.ts` puts its own (non-emissive) material on.
 */
export function importedFrontMarkGeometries(
  hull: readonly Vec2[],
  deckZ: number,
  barH: number,
  arrowT: number,
  /** turret rings the arrow must not sit under — the 2D sprite's rule (`frontArrowSpot`) */
  avoid: readonly { x: number; y: number; r: number }[] = [],
): {
  bar: THREE.BufferGeometry | null;
  arrow: THREE.BufferGeometry;
} {
  const bars: THREE.BufferGeometry[] = [];
  let best: { a: Vec2; b: Vec2; nx: number; ny: number } | null = null;
  const facing: { a: Vec2; b: Vec2; nx: number; ny: number }[] = [];
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const el = Math.hypot(b.x - a.x, b.y - a.y);
    if (el < 1e-6) continue;
    const e = { a, b, nx: (b.y - a.y) / el, ny: -(b.x - a.x) / el };
    if (!best || e.nx > best.nx) best = e;
    if (e.nx > Math.SQRT1_2) facing.push(e);
  }
  if (facing.length === 0 && best) facing.push(best);
  const depth = 0.6;
  for (const e of facing) {
    // the bar's centre line runs half its depth inside the edge, so it never passes the hull
    const len = Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y);
    const g = new THREE.BoxGeometry(len, depth, barH);
    g.rotateZ(Math.atan2(e.b.y - e.a.y, e.b.x - e.a.x));
    g.translate((e.a.x + e.b.x) / 2 - (e.nx * depth) / 2, (e.a.y + e.b.y) / 2 - (e.ny * depth) / 2, deckZ + barH / 2);
    bars.push(g.toNonIndexed());
  }
  const a = frontArrowSpot(hull, avoid);
  const tri = new THREE.Shape([
    new THREE.Vector2(a.x + a.len / 2, a.y),
    new THREE.Vector2(a.x - a.len / 2, a.y + a.half),
    new THREE.Vector2(a.x - a.len / 2, a.y - a.half),
  ]);
  const arrow = new THREE.ExtrudeGeometry(tri, { depth: arrowT, bevelEnabled: false, steps: 1 });
  arrow.translate(0, 0, deckZ);
  const bar = bars.length ? mergeGeometries(bars, false) : null;
  for (const g of bars) g.dispose();
  return { bar, arrow };
}

/**
 * THE TURRET'S AIM, for a launcher the robot's own mesh cannot point — built on the SIM'S MUZZLE.
 * A YAW node (`head`) at the turret axis (`turretLocal`), the fixed AXLE node `axleX` forward at the
 * flywheel axle's height (`bbImportTurretAxleZ`), the PITCH node at its origin, and under it a
 * small hub `pathR` above the axle with a slim sight running forward from it. `sync` poses `head`
 * by `turretHeading` and `pitch` by `bbTurretPitch` (rotation.y = −pitch), exactly as it poses a
 * standard turret, and those two rotations put the hub at
 *     axis + yaw(axleX − pathR·sin p, 0, axleZ + pathR·cos p)
 * — `bbMuzzleLocal(p, which, axleZ)`, the point the sim releases from, at every pitch. Deliberately
 * a sight, not a second launcher: the mesh already has one.
 */
export function buildAimSight(
  material: THREE.Material,
  at: Vec2,
  axleZ: number,
  head3: { axleX: number; pathR: number },
): {
  node: THREE.Group;
  head: THREE.Group;
  pitch: THREE.Group;
  hub: THREE.Mesh;
  meshes: THREE.Mesh[];
} {
  const node = new THREE.Group();
  node.name = 'bb-import-aim';
  node.position.set(at.x, at.y, 0);
  const head = new THREE.Group();
  head.name = 'bb-turret-head';
  const axle = new THREE.Group();
  axle.name = 'bb-turret-axle';
  axle.position.set(head3.axleX, 0, axleZ);
  const pitch = new THREE.Group();
  pitch.name = 'bb-turret-pitch';
  node.add(head);
  head.add(axle);
  axle.add(pitch);
  // a short HUB at the muzzle, not a hoop: a floating ring read as a marker, not as hardware
  // (looked at, 2026-10-01 — the first pass had a torus at the turret radius)
  const hubGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.45, 16);
  const hub = new THREE.Mesh(hubGeo, material); // the cylinder's axis (+y) is the axle's own
  hub.name = 'bb-import-aim-hub';
  hub.position.set(0, 0, head3.pathR);
  pitch.add(hub);
  const len = 3.2;
  const rodGeo = new THREE.CylinderGeometry(0.14, 0.2, len, 10);
  rodGeo.rotateZ(-Math.PI / 2); // the cylinder's axis (+y) onto +x
  rodGeo.translate(len / 2, 0, head3.pathR);
  const rod = new THREE.Mesh(rodGeo, material);
  rod.name = 'bb-import-aim-sight';
  pitch.add(rod);
  return { node, head, pitch, hub, meshes: [hub, rod] };
}
