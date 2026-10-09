/**
 * MODEL-frame parts → the STORED SCENE a bake writes (`bakeMesh.ts` turns it into the GLB): the robot
 * moved to its robot-local origin, split into the static rest and each moving part, in the stored
 * mesh frame. three-free and DOM-free, so the import worker builds it (`bakeModelHere`): at Full
 * detail it is every triangle of the CAD, millions of them, which the main thread must not walk.
 */
import type { ImportedRobot, Vec2 } from '../../types';
import { transformParts, triangleBody, type MeshPart } from '../geometry';
import { ROBOT_TO_STORED_MESH, type MotionPart, type StoredMotion } from '../types';
import type { StoredScene } from './bakeMesh';

const translate = (x: number, y: number, z: number): number[] => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

/** MODEL frame → robot-local (the origin moves to the wheelbase centre) */
export function toRobotLocal(modelParts: readonly MeshPart[], origin: Vec2): MeshPart[] {
  return transformParts(modelParts, translate(-origin.x, -origin.y, 0));
}

/**
 * The triangles `tris` of `p` as a part of their own, compacted (normals and bodies carried), the
 * vertices in the order the triangles first use them. Typed arrays and one stamp array: a JS array
 * per attribute and a `Map` per vertex took seconds on the static rest of a 5.7M-triangle robot.
 */
function subsetPart(p: MeshPart, tris: Uint32Array): MeshPart {
  const nV = p.positions.length / 3;
  const map = new Int32Array(nV).fill(-1);
  const idx = new Uint32Array(tris.length * 3);
  const pos = new Float32Array(Math.min(nV, tris.length * 3) * 3);
  const nrm = p.normals ? new Float32Array(pos.length) : null;
  const body = p.body ? new Uint32Array(pos.length / 3) : null;
  let n = 0;
  let k = 0;
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i];
    for (let c = 0; c < 3; c++) {
      const v = p.indices ? p.indices[3 * t + c] : 3 * t + c;
      let m = map[v];
      if (m < 0) {
        m = map[v] = n++;
        pos[3 * m] = p.positions[3 * v];
        pos[3 * m + 1] = p.positions[3 * v + 1];
        pos[3 * m + 2] = p.positions[3 * v + 2];
        if (nrm) {
          nrm[3 * m] = p.normals![3 * v];
          nrm[3 * m + 1] = p.normals![3 * v + 1];
          nrm[3 * m + 2] = p.normals![3 * v + 2];
        }
        if (body) body[m] = p.body![v];
      }
      idx[k++] = m;
    }
  }
  return {
    positions: pos.slice(0, 3 * n),
    indices: idx,
    normals: nrm ? nrm.slice(0, 3 * n) : null,
    color: p.color,
    name: p.name,
    body: body ? body.slice(0, n) : null,
  };
}

/**
 * Robot-local parts split by moving part: `rest` holds every triangle no moving part owns, and
 * `moving[i]` the triangles of `motion[i]`'s bodies, by colour.
 */
export function splitMoving(robotParts: readonly MeshPart[], motion: readonly { bodies: readonly number[] }[]): { rest: MeshPart[]; moving: MeshPart[][] } {
  const owner = new Map<number, number>();
  motion.forEach((m, i) => {
    for (const b of m.bodies) if (!owner.has(b)) owner.set(b, i);
  });
  const rest: MeshPart[] = [];
  const moving: MeshPart[][] = motion.map(() => []);
  for (const p of robotParts) {
    const n = Math.floor((p.indices ? p.indices.length : p.positions.length / 3) / 3);
    if (!owner.size || !p.body) {
      rest.push(p);
      continue;
    }
    // each triangle's owner (-1: the rest), counted, then the triangles bucketed in order
    const of = new Int32Array(n);
    const counts = new Map<number, number>();
    for (let t = 0; t < n; t++) {
      const o = owner.get(triangleBody(p, t)) ?? -1;
      of[t] = o;
      counts.set(o, (counts.get(o) ?? 0) + 1);
    }
    if (counts.size === 1 && counts.has(-1)) {
      rest.push(p);
      continue;
    }
    const buckets = new Map<number, { tris: Uint32Array; fill: number }>();
    for (const [o, c] of counts) buckets.set(o, { tris: new Uint32Array(c), fill: 0 });
    for (let t = 0; t < n; t++) {
      const b = buckets.get(of[t])!;
      b.tris[b.fill++] = t;
    }
    for (const [o, b] of buckets) (o < 0 ? rest : moving[o]).push(subsetPart(p, b.tris));
  }
  return { rest, moving };
}

const toStoredPoint = (v: readonly number[]): [number, number, number] => {
  const m = ROBOT_TO_STORED_MESH;
  return [m[0] * v[0] + m[4] * v[1] + m[8] * v[2], m[1] * v[0] + m[5] * v[1] + m[9] * v[2], m[2] * v[0] + m[6] * v[1] + m[10] * v[2]];
};
const toStoredDir = (v: readonly number[]): [number, number, number] => {
  const p = toStoredPoint(v);
  const l = Math.hypot(p[0], p[1], p[2]) || 1;
  return [p[0] / l, p[1] / l, p[2] / l];
};

/**
 * The stored scene a bake writes: robot-local creased parts and the moving parts (MODEL frame,
 * shifted here by `origin`), in the stored mesh frame. A turret turns about the placed launcher
 * (`descriptor.mech.shooter`, then `shooter2`), which is where the sim aims it from.
 */
export function storedSceneOf(robotParts: readonly MeshPart[], motion: readonly MotionPart[], origin: Vec2, descriptor: ImportedRobot): StoredScene {
  const { rest, moving } = splitMoving(robotParts, motion);
  const turretAt = [descriptor.mech?.shooter, descriptor.mech?.shooter2];
  let turrets = 0;
  const scene: StoredScene = { rest: transformParts(rest, ROBOT_TO_STORED_MESH), moving: [] };
  const kept: number[] = [];
  motion.forEach((m, i) => {
    if (!moving[i].length) return;
    let pivot = [m.pivot[0] - origin.x, m.pivot[1] - origin.y, m.pivot[2]];
    if (m.role === 'turret') {
      const at = turretAt[turrets++];
      if (at) pivot = [at.x, at.y, pivot[2]];
    }
    const info: StoredMotion = {
      v: 1,
      role: m.role,
      axis: toStoredDir(m.axis),
      radius: m.radius,
      deploy: m.deploy,
      ...(m.corner !== undefined ? { corner: m.corner } : {}),
      id: scene.moving.length,
      ...(m.drive !== undefined ? { drive: m.drive } : {}),
      ...(m.amount !== undefined ? { amount: m.amount } : {}),
    };
    kept[i] = scene.moving.length;
    scene.moving.push({ info, pivot: toStoredPoint(pivot), parent: m.parent, parts: transformParts(moving[i], ROBOT_TO_STORED_MESH) });
  });
  // parents by their index in what was kept (a parent with no triangles drops its riders to the root),
  // and a follow by the kept id of the part it follows
  for (const mv of scene.moving) mv.parent = mv.parent >= 0 && kept[mv.parent] !== undefined ? kept[mv.parent] : -1;
  motion.forEach((m, i) => {
    const at = kept[i];
    const to = m.follows ? kept[m.follows.index] : undefined;
    if (at !== undefined && to !== undefined && m.follows) scene.moving[at].info.follow = { id: to, ratio: m.follows.ratio };
  });
  return scene;
}
