/**
 * THE STORED MESH: parts → a GLB in the stored mesh frame (`STORED_MESH_TO_ROBOT`), held to
 * `MAX_MESH_BYTES`. DOM-free, so `bake` runs it in the import worker and keeps only the two pictures,
 * which need WebGL, on the main thread. The bake writes it compressed (`storedGlb.ts`); the float
 * writer (`floatGlb.ts`) is what a room is sent (`liteMesh`), since the relay's validator takes no
 * extension.
 *
 * MOVING PARTS ARE NODES OF THEIR OWN (`docs/area/robot-import.md`, "Moving parts"): each is a group
 * translated to its pivot, its meshes relative to it, and `extras.dsim` (`StoredMotion`) saying what
 * it does and about which axis. A part that rides on another (a roller on a ramp) is that part's
 * child. Everything else is the static rest, one mesh per colour, as it always was.
 */
import * as THREE from 'three';
import type { ImportedRobot, Vec2 } from '../../types';
import { transformParts, triangleCount, type MeshPart } from '../geometry';
import { MAX_MESH_BYTES, ROBOT_TO_STORED_MESH, STORED_MESH_TO_ROBOT, readStoredMotion, type MotionPart, type StoredMotion } from '../types';
import { storedSceneOf, toRobotLocal } from './bakeScene';
import { creaseParts } from './meshGroup';
import { partsFromObject } from './parse';
import { simplifyLists } from './simplify';
import { writeStoredGlb } from './storedGlb';

type V3 = [number, number, number];

/** a stored mesh's scene, STORED frame, positions absolute (a moving part's are not yet relative) */
export interface StoredScene {
  rest: MeshPart[];
  moving: {
    info: StoredMotion;
    /** a point on the axis, stored frame (metres) */
    pivot: V3;
    /** the moving part this one rides on, by index into `moving`, or -1 */
    parent: number;
    parts: MeshPart[];
  }[];
}

/**
 * A stored GLB's scene graph → its `StoredScene` (positions absolute, stored frame): every node with
 * a `userData.dsim` is a moving part, owning the meshes under it down to the next one; the rest is the
 * static robot. The reverse of `exportStoredScene`.
 */
export function readStoredScene(root: THREE.Object3D): StoredScene {
  root.updateMatrixWorld(true);
  const nodes: { o: THREE.Object3D; info: StoredMotion }[] = [];
  root.traverse((o) => {
    const info = readStoredMotion((o.userData as { dsim?: unknown } | undefined)?.dsim);
    if (info) nodes.push({ o, info });
  });
  const at = new Map(nodes.map((n, i) => [n.o, i]));
  const owner = (o: THREE.Object3D): number => {
    for (let p = o.parent; p; p = p.parent) {
      const i = at.get(p);
      if (i !== undefined) return i;
    }
    return -1;
  };
  const v = new THREE.Vector3();
  const scene: StoredScene = {
    rest: [],
    moving: nodes.map((n) => {
      n.o.getWorldPosition(v);
      return { info: n.info, pivot: [v.x, v.y, v.z] as V3, parent: owner(n.o), parts: [] as MeshPart[] };
    }),
  };
  root.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh) return;
    const i = owner(o);
    const parts = partsFromObject(o, false).filter((p) => p.positions.length >= 9);
    (i < 0 ? scene.rest : scene.moving[i].parts).push(...parts);
  });
  return scene;
}

/** every part of a scene, rest first then each moving part's, in order */
export function sceneParts(scene: StoredScene): MeshPart[] {
  return [...scene.rest, ...scene.moving.flatMap((m) => m.parts)];
}

/**
 * A stored scene → the stored GLB, compressed (`writeStoredGlb`: quantised, meshopt-packed, about 9
 * bytes a triangle). When it comes out larger than `MAX_MESH_BYTES`, the triangle budget drops in
 * proportion (with 10 % to spare) and every part list is simplified again, each to its share, up to
 * four times. Returns the GLB and the scene it holds (the pictures are rendered from that, so they
 * show what is stored).
 */
export async function bakeSceneHere(scene: StoredScene): Promise<{ glb: ArrayBuffer; scene: StoredScene; refits: number }> {
  let cur = scene;
  let glb = await writeStoredGlb(cur);
  let refits = 0;
  while (glb.byteLength > MAX_MESH_BYTES && refits < 4) {
    const tris = triangleCount(sceneParts(cur));
    const ratio = Math.max(2000 / Math.max(1, tris), (MAX_MESH_BYTES * 0.9) / glb.byteLength);
    // one error bound over the robot and its moving parts (`simplifyLists`), each kept apart
    const strip = (parts: MeshPart[]): MeshPart[] => parts.map((p) => ({ ...p, normals: null }));
    const s = await simplifyLists([strip(cur.rest), ...cur.moving.map((m) => strip(m.parts))], Math.floor(tris * ratio));
    cur = { rest: creaseParts(s.lists[0]), moving: cur.moving.map((m, i) => ({ ...m, parts: creaseParts(s.lists[i + 1]) })) };
    glb = await writeStoredGlb(cur);
    refits++;
  }
  return { glb, scene: cur, refits };
}

/** what the bake's mesh half needs (`bake.ts`'s `BakeInput` less the pictures) */
export interface BakeModelInput {
  /** MODEL frame, with normals */
  modelParts: MeshPart[];
  /** the robot-local origin in the MODEL frame */
  origin: Vec2;
  descriptor: ImportedRobot;
  /** the moving parts as measured (MODEL frame, starting pose) */
  motion: MotionPart[];
}

/**
 * THE BAKE'S MESH HALF: MODEL-frame parts → robot-local, creased, split into the stored scene, written
 * (`bakeSceneHere`). Returns the GLB and the parts the two pictures are drawn from: the stored scene
 * back in the robot frame (every part where it starts), so they show what is stored.
 */
export async function bakeModelHere(input: BakeModelInput): Promise<{ glb: ArrayBuffer; pictures: MeshPart[]; refits: number }> {
  const creased = creaseParts(toRobotLocal(input.modelParts, input.origin));
  const { glb, scene, refits } = await bakeSceneHere(storedSceneOf(creased, input.motion, input.origin, input.descriptor));
  return { glb, pictures: transformParts(sceneParts(scene), STORED_MESH_TO_ROBOT), refits };
}

/** robot-local creased parts with no moving parts → the stored GLB (the old single-group bake) */
export async function bakeMeshHere(robotParts: MeshPart[]): Promise<{ glb: ArrayBuffer; parts: MeshPart[]; refits: number }> {
  const r = await bakeSceneHere({ rest: transformParts(robotParts, ROBOT_TO_STORED_MESH), moving: [] });
  return { glb: r.glb, parts: r.refits ? transformParts(r.scene.rest, STORED_MESH_TO_ROBOT) : robotParts, refits: r.refits };
}
