/**
 * THE FLOAT GLB: a stored scene through three's GLTFExporter, no extensions. It is what the relay
 * validator takes (`src/net/visualCheck.ts`), so `liteMesh` writes a room's copy with it; the bake
 * writes the stored mesh compressed (`storedGlb.ts`). DOM-free (the exporter reads its binary back
 * through a `Blob` and a `FileReader`, which a worker has).
 *
 * A module of its own so the import worker fetches GLTFExporter only with `lite.ts`, when a room asks
 * for a lighter mesh, and not with every import.
 */
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { transformParts, type MeshPart } from '../geometry';
import { ROBOT_TO_STORED_MESH } from '../types';
import type { StoredScene } from './bakeMesh';
import { buildMeshGroup, disposeTree } from './meshGroup';

type V3 = [number, number, number];

/** robot-local parts → a float GLB in the stored mesh frame (no moving parts) */
export async function exportGlb(robotParts: readonly MeshPart[]): Promise<ArrayBuffer> {
  return exportGlbStored(transformParts(robotParts, ROBOT_TO_STORED_MESH));
}

/** parts ALREADY in the stored mesh frame → a float GLB (no moving parts) */
export async function exportGlbStored(stored: readonly MeshPart[]): Promise<ArrayBuffer> {
  return exportStoredScene({ rest: [...stored], moving: [] });
}

const translateParts = (parts: readonly MeshPart[], d: V3): MeshPart[] =>
  transformParts(parts, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, d[0], d[1], d[2], 1]);

/** a stored scene → a float GLB: the rest under the root, each moving part a node at its pivot */
export async function exportStoredScene(scene: StoredScene): Promise<ArrayBuffer> {
  const root3 = new THREE.Scene();
  const group = buildMeshGroup(scene.rest, 'dsim_robot');
  root3.add(group);
  const nodes: (THREE.Group | null)[] = scene.moving.map(() => null);
  const make = (i: number, depth = 0): THREE.Group | null => {
    if (nodes[i]) return nodes[i];
    const m = scene.moving[i];
    if (!m || depth > 8) return null;
    const parent = m.parent >= 0 && m.parent !== i ? make(m.parent, depth + 1) : null;
    const node = new THREE.Group();
    node.name = `dsim_motion_${i}_${m.info.role}`;
    const base: V3 = parent ? scene.moving[m.parent].pivot : [0, 0, 0];
    node.position.set(m.pivot[0] - base[0], m.pivot[1] - base[1], m.pivot[2] - base[2]);
    node.userData = { dsim: m.info };
    const meshes = buildMeshGroup(translateParts(m.parts, [-m.pivot[0], -m.pivot[1], -m.pivot[2]]), `dsim_motion_${i}_mesh`);
    for (const c of [...meshes.children]) node.add(c);
    (parent ?? group).add(node);
    nodes[i] = node;
    return node;
  };
  for (let i = 0; i < scene.moving.length; i++) make(i);
  try {
    const out = await new GLTFExporter().parseAsync(root3, { binary: true, onlyVisible: true });
    return out as ArrayBuffer;
  } finally {
    disposeTree(root3);
  }
}
