/**
 * THE BAKE: the stored GLB (frame `STORED_MESH_TO_ROBOT`), the 512-px top-down PNG (frame
 * `topImageFrame`) and the 192-px card thumbnail, from the normalised parts (every triangle at Full
 * detail, `NormalisedModel.shownParts`).
 */
import * as THREE from 'three';
import type { ImportedRobot, Vec2 } from '../../types';
import { topImageFrame, triangleCount, type MeshPart } from '../geometry';
import { THUMB_PX, TOP_IMAGE_PX, type MotionPart } from '../types';
import { bakeModelOff } from './importSession';
import { buildMeshGroup, disposeTree } from './meshGroup';

export { exportGlb, exportGlbStored } from './floatGlb';
export { splitMoving, storedSceneOf, toRobotLocal } from './bakeScene';

export interface BakeInput {
  /** MODEL frame (the engine's `normalise` output) */
  modelParts: MeshPart[];
  /** the robot-local origin in the MODEL frame (`measurement.origin`) */
  origin: Vec2;
  /** the descriptor that will be saved; its hull frames the top image */
  descriptor: ImportedRobot;
  /** the moving parts as measured (MODEL frame, starting pose); each becomes a node of its own */
  motion?: MotionPart[];
  onProgress?: (stage: 'mesh' | 'top' | 'thumb') => void;
}

export interface BakeResult {
  mesh: Blob;
  top: Blob;
  thumb: Blob;
  meshBytes: number;
  trisOut: number;
  /** how many times the mesh was simplified again to fit `MAX_MESH_BYTES` */
  refits: number;
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png'));
}

function lights(scene: THREE.Scene, key: THREE.Vector3): void {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x50555c, 1.6));
  const d = new THREE.DirectionalLight(0xffffff, 2.2);
  d.position.copy(key);
  scene.add(d);
}

/** a throwaway renderer with a transparent background, sized `px`² */
function offscreenRenderer(px: number): { renderer: THREE.WebGLRenderer; canvas: HTMLCanvasElement } {
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(px, px, false);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return { renderer, canvas };
}

function freeRenderer(renderer: THREE.WebGLRenderer): void {
  renderer.dispose();
  renderer.forceContextLoss();
}

/**
 * The top-down PNG: orthographic, looking down −z, front (+x) = image up, left (+y) = image left,
 * framed by `topImageFrame(descriptor.hull)` so a renderer can map it back from the hull alone.
 */
export async function renderTop(robotParts: readonly MeshPart[], hull: readonly Vec2[], px = TOP_IMAGE_PX): Promise<Blob> {
  const f = topImageFrame(hull, px);
  const { renderer, canvas } = offscreenRenderer(px);
  const scene = new THREE.Scene();
  const group = buildMeshGroup(robotParts);
  scene.add(group);
  lights(scene, new THREE.Vector3(8, 5, 30));
  const half = f.sideIn / 2;
  const cam = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, 400);
  cam.position.set(f.cx, f.cy, 200);
  cam.up.set(1, 0, 0);
  cam.lookAt(f.cx, f.cy, 0);
  try {
    // link the programs with `KHR_parallel_shader_compile` before drawing, so the link does not
    // block this thread (the same pixels either way)
    await renderer.compileAsync(scene, cam);
    renderer.render(scene, cam);
    return await canvasBlob(canvas);
  } finally {
    disposeTree(group);
    freeRenderer(renderer);
  }
}

/** the card thumbnail: a 3/4 view from front-left-above, transparent */
export async function renderThumb(robotParts: readonly MeshPart[], px = THUMB_PX): Promise<Blob> {
  const { renderer, canvas } = offscreenRenderer(px);
  const scene = new THREE.Scene();
  const group = buildMeshGroup(robotParts);
  scene.add(group);
  lights(scene, new THREE.Vector3(14, 10, 24));
  const sphere = new THREE.Box3().setFromObject(group).getBoundingSphere(new THREE.Sphere());
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 1000);
  const dir = new THREE.Vector3(1, 0.85, 0.75).normalize();
  const dist = (sphere.radius / Math.sin(THREE.MathUtils.degToRad(15))) * 1.02;
  cam.position.copy(sphere.center).addScaledVector(dir, dist);
  cam.up.set(0, 0, 1);
  cam.lookAt(sphere.center);
  try {
    await renderer.compileAsync(scene, cam);
    renderer.render(scene, cam);
    return await canvasBlob(canvas);
  } finally {
    disposeTree(group);
    freeRenderer(renderer);
  }
}

/**
 * Bake all three. The mesh half (the robot-local frame, the split into moving parts, the GLB, and
 * the refit when it comes out over `MAX_MESH_BYTES`) runs in the import worker when one can start
 * (`bakeModelHere`): an export is ~30 ms of synchronous work on 100k triangles and the frame changes
 * and the split walk every triangle, millions at Full detail. The pictures need WebGL and stay here.
 */
export async function bake(input: BakeInput): Promise<BakeResult> {
  input.onProgress?.('mesh');
  const { glb, pictures: robotParts, refits } = await bakeModelOff({
    modelParts: input.modelParts,
    origin: input.origin,
    descriptor: input.descriptor,
    motion: input.motion ?? [],
  });
  input.onProgress?.('top');
  const top = await renderTop(robotParts, input.descriptor.hull);
  input.onProgress?.('thumb');
  const thumb = await renderThumb(robotParts);
  return {
    mesh: new Blob([glb], { type: 'model/gltf-binary' }),
    top,
    thumb,
    meshBytes: glb.byteLength,
    trisOut: triangleCount(robotParts),
    refits,
  };
}
