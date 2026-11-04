import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { ModelVenue } from '../graphics/environments';
import type { World } from '../../../types';
import { noteVenueFailure, venueAssetUrl, venueBlocked } from '../graphics/venueFiles';

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
  const live = liveScreen(root);
  if (live) {
    textures.push(live.texture);
    g.userData.tick = live.tick;
  }
  // what `renderScene.ts` frees with the venue: `disposeObject3D` frees only `map`
  g.userData.textures = textures;
  g.add(root);
  return g;
}

/** how often the live LED wall redraws, ms: a scoreboard's pace, not the frame rate */
export const LIVE_SCREEN_MS = 250;

/**
 * THE LED WALL OVER OUR FIELD SHOWS OUR MATCH (2026-11-04). A generated venue names that wall's
 * material `screenLive` (`scripts/venue-models/grb/generate.ts`); its baked picture is the idle board.
 * Here a 512 × 288 canvas replaces it as the emissive map and is redrawn every `LIVE_SCREEN_MS` from
 * the world: each alliance's score in its colour, the clock and the phase. Plain shapes and numbers —
 * no logo, no season artwork. Null when the file has no such wall, or there is no DOM (the RENDER lane).
 */
export function liveScreen(root: THREE.Object3D): { texture: THREE.CanvasTexture; tick: (world: World, now: number) => void } | null {
  if (typeof document === 'undefined') return null;
  const mats: THREE.MeshStandardMaterial[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of materialsOf(mesh)) if (m.name === 'screenLive') mats.push(m as THREE.MeshStandardMaterial);
  });
  if (!mats.length) return null;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 288;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  for (const m of mats) {
    m.emissiveMap?.dispose();
    m.emissiveMap = texture;
    m.needsUpdate = true;
  }
  let last = -Infinity;
  let shown = '';
  const tick = (world: World, now: number): void => {
    if (now - last < LIVE_SCREEN_MS) return;
    last = now;
    const sc = world.match.scores;
    const t = Math.max(0, Math.ceil(world.match.phaseTimeLeft ?? 0));
    const clock = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    const phase = String(world.match.phase ?? '').toUpperCase();
    const key = `${sc.red.total}|${sc.blue.total}|${clock}|${phase}`;
    if (key === shown) return;
    shown = key;
    ctx.fillStyle = '#0a0c12';
    ctx.fillRect(0, 0, 512, 288);
    ctx.fillStyle = '#7a1816';
    ctx.fillRect(16, 40, 184, 140);
    ctx.fillStyle = '#16327a';
    ctx.fillRect(312, 40, 184, 140);
    ctx.fillStyle = '#eef0f4';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 96px system-ui, sans-serif';
    ctx.fillText(String(sc.red.total), 108, 112);
    ctx.fillText(String(sc.blue.total), 404, 112);
    ctx.font = '700 48px system-ui, sans-serif';
    ctx.fillText(clock, 256, 104);
    ctx.font = '600 22px system-ui, sans-serif';
    ctx.fillStyle = '#e6c446';
    ctx.fillText(phase, 256, 152);
    texture.needsUpdate = true;
  };
  return { texture, tick };
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

/** FETCH AND PREPARE one modeled venue. Rejects on any failure and counts it (`venueBlocked`). */
export async function loadModelVenue(model: ModelVenue, renderer: THREE.WebGLRenderer, anisotropy: number): Promise<THREE.Group> {
  const url = venueAssetUrl(model.file);
  if (venueBlocked(url, Date.now())) throw new Error(`${model.file}: blocked after repeated failures`);
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  loader.setKTX2Loader(ktx2For(renderer));
  let scene: THREE.Group;
  try {
    scene = (await loader.loadAsync(url)).scene;
  } catch (err) {
    noteVenueFailure(url, Date.now());
    throw err;
  }
  return prepareModelVenue(scene, anisotropy);
}
