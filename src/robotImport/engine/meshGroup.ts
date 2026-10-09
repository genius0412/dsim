/**
 * Parts → a three.js group, and back out to the GPU's bin. Shared by the bake (GLB export and
 * the two pictures) and the editor preview, so what the player previews is what is stored.
 */
import * as THREE from 'three';
import type { MeshPart } from '../geometry';
import { finishOf } from '../finish';
import { safePartName } from './meshOps';

// three-free, so the import worker creases without three.js; re-exported for the bake and preview
export { CREASE_DEG, creaseParts } from './meshOps';

/** one BufferGeometry: position, normal, and the narrowest index type that fits */
export function geometryOf(p: MeshPart): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
  if (p.normals) g.setAttribute('normal', new THREE.BufferAttribute(p.normals, 3));
  if (p.indices) {
    const nV = p.positions.length / 3;
    g.setIndex(new THREE.BufferAttribute(nV < 65536 ? Uint16Array.from(p.indices) : p.indices, 1));
  }
  // the body ids (`MeshPart.body`), as a custom attribute: GLTFExporter writes it `_BODY` and the
  // loader reads it back as `_body` (`parse.ts`, `bodyIdsOf`), so a stored robot keeps its parts
  if (p.body && p.body.length === p.positions.length / 3) {
    let max = 0;
    for (let i = 0; i < p.body.length; i++) if (p.body[i] > max) max = p.body[i];
    g.setAttribute('_body', new THREE.BufferAttribute(max < 65536 ? Uint16Array.from(p.body) : p.body, 1));
  }
  if (!p.normals) g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** parts → a group of meshes, one standard material per part colour */
export function buildMeshGroup(parts: readonly MeshPart[], name = 'robot'): THREE.Group {
  const group = new THREE.Group();
  group.name = name;
  parts.forEach((p, i) => {
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(p.color[0], p.color[1], p.color[2]),
      ...finishOf(p.color),
      name: `colour_${i}`,
    });
    const mesh = new THREE.Mesh(geometryOf(p), mat);
    mesh.name = safePartName(p.name, i);
    group.add(mesh);
  });
  return group;
}

/** dispose every geometry and material under `root` */
export function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
    for (const mat of mats) {
      for (const v of Object.values(mat)) if (v && (v as THREE.Texture).isTexture) (v as THREE.Texture).dispose();
      mat.dispose();
    }
  });
}
