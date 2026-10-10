/**
 * BIOBUZZ scoring-element CAD loader — the PERFORATED POLLEN and NECTAR.
 *
 * `public/models/biobuzz/elements.glb` holds one mesh per kind, extracted from the SAME pinned
 * FIRST field STEP the field GLBs come from (`scripts/field-cad/elements.py` +
 * `elements.mjs`, `npm run element-cad`; the README beside the asset has the source and the
 * licence note both files ship under). `convert.py` deliberately drops the staged elements
 * because they are not field STRUCTURE — this is the other half of that decision.
 *
 * WHAT THE CAD SOLID IS, measured off the B-rep rather than guessed: an outer sphere, an inner
 * sphere and 26 radial bores in a 1/4/8/8/4/1 latitude stack. POLLEN r 1.400 in, wall 0.070,
 * bores ⌀0.440; NECTAR r 1.810 in, wall 0.085, bores ⌀0.635.
 *
 * ⚠️ **THE HOLES ARE SEEN FROM THE INSIDE, SO THE WINDING IS THE WHOLE ASSET.** A ball is
 * looked THROUGH: its inner sphere and all 26 bore walls face the camera through the holes on
 * the near side. `elements.py` applies each CAD face's own `TopAbs_REVERSED` orientation before
 * emitting a triangle — which `convert.py` does not, and which is why `renderFieldGlb.ts` needs
 * a `fixGroundBeamWinding` pass on the field asset — so every triangle here faces away from the
 * material and the ordinary single-sided material renders correctly from both sides of the
 * shell. No `DoubleSide`: it would double the shadow-pass cost and light the cavity's back wall
 * as if it were an outer surface.
 *
 * ⚠️ **`geometry.applyMatrix4` IS THE WRONG WAY TO BAKE THIS.** `meshopt` stores POSITION as a
 * NORMALIZED `Int16Array` (`KHR_mesh_quantization`) with the scale on the node; `applyMatrix4`
 * writes transformed floats straight back into that Int16 array, which silently truncates every
 * coordinate — measured on this very asset, it turned two clean shells at r 1.33/1.40 into a
 * smear of radii from 0.60 to 1.40. Positions are read through `getX/getY/getZ` (which
 * de-normalize) into a fresh `Float32Array` instead. Same trap `computeCreasedNormals` records
 * for its own attribute copies.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BB_NECTAR_R, BB_POLLEN_R } from '../config';
import { CREASE_ANGLE_DEG, computeCreasedNormals } from './renderFieldGlb';

/** the file's own mesh names — `elements.mjs` writes exactly these two. */
const MESH_NAMES = { pollen: 'pollen', nectar: 'nectar' } as const;

export interface BbElementGeometries {
  pollen: THREE.BufferGeometry;
  nectar: THREE.BufferGeometry;
}

/**
 * How far the loaded mesh's own outer radius may sit from the config constant before the asset
 * is REFUSED and the sphere fallback stands.
 *
 * It is 0.02 in and not zero because the CAD and `config.ts` genuinely disagree about NECTAR:
 * the STEP says 1.810 in, `BB_NECTAR_R` says 1.800. The CAD is authoritative for DIMENSIONS
 * (owner ruling 2026-09-18) but that radius is also a SIM number — it is the sphere Rapier
 * solves, the reach every flower/hive/intake tolerance was measured against — so moving it is a
 * physics change somebody has to decide, not something a renderer may do on its own.
 *
 * DECIDED (owner, 2026-09-21): "Keep the sim ... As long as it is consistent." So the SIM's
 * radius is the one radius. `bake` scales the accepted mesh uniformly onto the config constant
 * (NECTAR × 0.9945; POLLEN × 1.0000), which makes the perforated ball, the sphere fallback, the
 * 2D sprite and the body Rapier solves all the same size at every graphics tier. The CAD's own
 * figure stays REPORTED in `public/models/biobuzz/elements-measurements.json`.
 */
export const ELEMENT_RADIUS_TOL_IN = 0.02;

let sharedLoader: GLTFLoader | null = null;
/** the scene chunk's ONE GLTFLoader (meshopt decoder attached) — the elements here, an imported
 * robot's mesh in `renderImported.ts` */
export function loader(): GLTFLoader {
  if (!sharedLoader) {
    sharedLoader = new GLTFLoader();
    sharedLoader.setMeshoptDecoder(MeshoptDecoder);
  }
  return sharedLoader;
}

/**
 * `models/biobuzz` → the `elements.glb` URL, through Vite's `import.meta.env.BASE_URL`. Written
 * here rather than shared with `renderFieldGlb.ts`'s `resolveGlbUrl` because that one bakes
 * `field`/`field-low` into its own filename rule; the reason both need a BASE_URL at all is the
 * Electron build's relative `./` base (`vite.config.ts`), under which a bare `/models/...`
 * resolves at the filesystem root and 404s silently.
 */
function resolveUrl(base: string): string {
  if (/^https?:\/\//i.test(base)) return base.endsWith('.glb') ? base : `${base.replace(/\/+$/, '')}/elements.glb`;
  const trimmed = base
    .replace(/\/?elements\.glb$/i, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  const baseUrl = (import.meta.env.BASE_URL ?? '/').replace(/\/+$/, '');
  return `${baseUrl}/${trimmed}/elements.glb`.replace(/\/{2,}/g, '/');
}

/** ⚠️ NOT `getObjectByName` — GLTFLoader sanitizes node names and keeps the original in
 * `userData.name`, the same rule `renderFieldGlb.ts`'s `findByOriginalName` records. */
function findMesh(root: THREE.Object3D, name: string): THREE.Mesh {
  let hit: THREE.Mesh | null = null;
  root.traverse((obj) => {
    if (hit) return;
    if ((obj as THREE.Mesh).isMesh && (obj.userData?.name === name || obj.name === name)) hit = obj as THREE.Mesh;
  });
  if (!hit) throw new Error(`renderElementsGlb: elements.glb is missing the "${name}" mesh`);
  return hit;
}

/**
 * One loaded mesh → a world-scale, origin-centred geometry with creased normals.
 *
 * The asset carries no NORMAL attribute (the same convention both field GLBs ship under, and
 * for the same reason: flat per-triangle normals stop a simplifier collapsing anything).
 * `computeCreasedNormals` at 40° is exactly right for this shape — a facet-to-facet angle on
 * either sphere is ~12°, so the shells shade smooth, while a bore wall meets the outer sphere at
 * very nearly 90°, so every hole keeps a hard rim.
 */
function bake(mesh: THREE.Mesh, expectedR: number, kind: string): THREE.BufferGeometry {
  mesh.updateWorldMatrix(true, false);
  const src = mesh.geometry;
  const pos = src.getAttribute('position');
  const index = src.getIndex();
  if (!pos || !index) throw new Error(`renderElementsGlb: "${kind}" has no indexed position attribute`);

  const out = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  let rmax = 0;
  for (let i = 0; i < pos.count; i++) {
    // see this file's header: getX/getY/getZ, never `applyMatrix4` on the quantized attribute
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mesh.matrixWorld);
    out[i * 3] = v.x;
    out[i * 3 + 1] = v.y;
    out[i * 3 + 2] = v.z;
    rmax = Math.max(rmax, v.length());
  }
  if (Math.abs(rmax - expectedR) > ELEMENT_RADIUS_TOL_IN) {
    throw new Error(`renderElementsGlb: "${kind}" outer radius ${rmax.toFixed(4)} in is not ${expectedR} ± ${ELEMENT_RADIUS_TOL_IN}`);
  }
  // ONE RADIUS: draw the ball at exactly the size the sim solves (see `ELEMENT_RADIUS_TOL_IN`).
  const fit = expectedR / rmax;
  for (let i = 0; i < out.length; i++) out[i] *= fit;

  const idx = new Uint32Array(index.count);
  for (let i = 0; i < index.count; i++) idx[i] = index.getX(i);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(out, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  computeCreasedNormals(geo, CREASE_ANGLE_DEG);
  geo.computeBoundingSphere();
  geo.name = `bb-${kind}-cad`;
  return geo;
}

/**
 * Fetch and bake both element geometries. REJECTS on any failure (404, offline, a decode error,
 * a mesh whose radius does not match the config constant) — `renderElements.ts` keeps its sphere
 * geometry until this resolves and keeps it forever if it does not, so nothing here needs a
 * fallback of its own.
 *
 * Cached at module scope: the live scene and the replay-export scene both ask for it, and a
 * second scene mounted in the same tab must not re-fetch 22 KB and re-run the crease pass.
 */
let pending: Promise<BbElementGeometries> | null = null;

export function loadElementGeometries(base = 'models/biobuzz'): Promise<BbElementGeometries> {
  if (!pending) {
    pending = new Promise<BbElementGeometries>((resolve, reject) => {
      loader().load(
        resolveUrl(base),
        (gltf) => {
          try {
            resolve({
              pollen: bake(findMesh(gltf.scene, MESH_NAMES.pollen), BB_POLLEN_R, 'pollen'),
              nectar: bake(findMesh(gltf.scene, MESH_NAMES.nectar), BB_NECTAR_R, 'nectar'),
            });
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        },
        undefined,
        (err) => reject(err instanceof Error ? err : new Error('elements.glb failed to load')),
      );
    }).catch((err: unknown) => {
      // a failed fetch must not poison the cache: the Graphics section's own re-pick is the
      // retry, and an offline first load followed by a reconnect should be able to succeed.
      pending = null;
      throw err;
    });
  }
  return pending;
}
