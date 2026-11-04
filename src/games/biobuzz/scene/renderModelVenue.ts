import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { ModelVenue } from '../graphics/environments';
import { venueAssetUrl } from '../graphics/venueFiles';

/**
 * A MODELED VENUE (2026-11-04; `ModelVenue`, `graphics/environments.ts`) — a real room as real
 * geometry, loaded from one GLB under `public/venues/` and put in as the venue. A LAZY chunk:
 * `renderScene.ts` reaches it by `import('./renderModelVenue')` only when a modeled row is picked
 * from High up, so neither KTX2Loader nor the Basis transcoder (fetched by KTX2Loader itself, from
 * this build's own assets) is downloaded by anyone else.
 *
 * ⚠️ NOTHING HERE PROJECTS AN IMAGE. The photographed venues (2026-10-10 to 2026-11-04) drew a
 * panorama onto approximate geometry, correct only from its lens, and every camera warped it. A
 * modeled room is its own meshes with their own PBR materials, so it is right from every eye.
 *
 * What the file already is (`scripts/venue-models/build.mjs`): inches, z up, the field's centre at
 * the origin with the room's floor at the procedural ground's height, meshopt geometry, KTX2
 * textures, its lights, cameras and anything that blocked a camera removed. What this file does at
 * load: drops any light or camera the file still carries (the row's `rig` lights the room, as it
 * does the procedural ones), makes every mesh RECEIVE the sun's shadow and cast none (the shadow map
 * covers the field; a room casting into it only costs), and sets the anisotropy row on its textures.
 */

/** a failed file is asked for twice, then not again for five minutes (same rule as the HDRI) */
export const MODEL_MAX_TRIES = 2;
export const MODEL_RETRY_MS = 5 * 60_000;
const failed = new Map<string, { n: number; at: number }>();

/** has `url` failed often enough, recently enough, not to be asked again */
export function modelBlocked(url: string, now = Date.now()): boolean {
  const f = failed.get(url);
  if (!f) return false;
  if (now - f.at >= MODEL_RETRY_MS) {
    failed.delete(url);
    return false;
  }
  return f.n >= MODEL_MAX_TRIES;
}

/** record a failed load of `url` (exported for the RENDER lane) */
export function noteModelFailure(url: string, now = Date.now()): void {
  const f = failed.get(url);
  failed.set(url, { n: (f?.n ?? 0) + 1, at: now });
}

/** every texture slot a glTF material can fill */
const TEXTURE_SLOTS = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'aoMap',
  'emissiveMap',
  'alphaMap',
  'clearcoatMap',
  'clearcoatNormalMap',
  'clearcoatRoughnessMap',
  'sheenColorMap',
  'sheenRoughnessMap',
  'specularIntensityMap',
  'specularColorMap',
  'transmissionMap',
  'thicknessMap',
  'iridescenceMap',
  'iridescenceThicknessMap',
  'anisotropyMap',
] as const;

function materialsOf(mesh: THREE.Mesh): THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

/** every texture the model's materials hold — `disposeObject3D` frees only `map` */
export function modelTexturesOf(root: THREE.Object3D): THREE.Texture[] {
  const out = new Set<THREE.Texture>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of materialsOf(mesh)) {
      for (const slot of TEXTURE_SLOTS) {
        const t = (m as unknown as Record<string, unknown>)[slot];
        if (t && (t as THREE.Texture).isTexture) out.add(t as THREE.Texture);
      }
    }
  });
  return [...out];
}

/** THE LOADED SCENE → THE VENUE GROUP (pure: the RENDER lane runs it on a parsed fixture) */
export function prepareModelVenue(root: THREE.Object3D, anisotropy: number): THREE.Group {
  const drop: THREE.Object3D[] = [];
  root.traverse((o) => {
    if ((o as THREE.Light).isLight || (o as THREE.Camera).isCamera) drop.push(o);
  });
  for (const o of drop) o.removeFromParent();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
  });
  const textures = modelTexturesOf(root);
  for (const t of textures) t.anisotropy = anisotropy;
  const g = new THREE.Group();
  g.name = 'bb-venue-model';
  g.userData.modelVenue = true;
  // what `renderScene.ts` frees with the venue: `disposeObject3D` frees only `map`
  g.userData.textures = textures;
  g.add(root);
  return g;
}

/** one KTX2 loader for the page: it owns the transcoder's worker pool */
let ktx2: KTX2Loader | null = null;
function ktx2For(renderer: THREE.WebGLRenderer): KTX2Loader {
  if (!ktx2) {
    ktx2 = new KTX2Loader();
    ktx2.detectSupport(renderer);
  }
  return ktx2;
}

/** FETCH AND PREPARE one modeled venue. Rejects on any failure and counts it (`modelBlocked`). */
export async function loadModelVenue(model: ModelVenue, renderer: THREE.WebGLRenderer, anisotropy: number): Promise<THREE.Group> {
  const url = venueAssetUrl(model.file);
  if (modelBlocked(url)) throw new Error(`${model.file}: blocked after repeated failures`);
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  loader.setKTX2Loader(ktx2For(renderer));
  let scene: THREE.Group;
  try {
    scene = (await loader.loadAsync(url)).scene;
  } catch (err) {
    noteModelFailure(url);
    throw err;
  }
  return prepareModelVenue(scene, anisotropy);
}
