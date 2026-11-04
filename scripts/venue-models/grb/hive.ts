/**
 * THE NEIGHBOURS' HIVES, POSED AS OUR FIELD POSES ITS OWN (owner, 2026-11-04: "The hive is a bistable
 * mechanism. One side HAS to be up instead of being balanced").
 *
 * `field.glb` stores each TRAY level, in its pivot-local UN-TILTED frame (`hiveTrayRefTheta` is 0), and
 * the live renderer turns it about its pivot's x axis by `hiveTiltAngle − hiveTrayRefTheta`, which at
 * rest is ±`BB_HIVE_TILT_DEG` against one stop or the other (`renderField.ts`, `updateBiobuzzField`).
 * A copy of the file without that turn shows both trays level, a balance no real hive holds.
 *
 * Not only the tray rides. The CAD pipeline files each alliance's four tray braces and six-part pivot
 * rocker under the static FRAME nodes, baked at the capture pose; `renderFieldGlb.ts`'s
 * `reparentTrayBraces` lifts them onto the tray at load, un-tilting each by its alliance's
 * `captureTheta`. This does the same with the same selectors and constants, and takes the angle from
 * the sim's own `hiveTiltAngle`, so a neighbour's hive is ours at a stop.
 */
import { cadCaptureTheta, fieldColliders3d } from '../../../src/games/biobuzz/sim3d/fieldColliders';
import { hiveTiltAngle, hiveTrayRefTheta } from '../../../src/games/biobuzz/sim3d/tilt';
import { BB_HIVE_TILT_DEG } from '../../../src/games/biobuzz/config';

/** `renderFieldGlb.ts`'s selector constants, with their measurements there */
const BRACE_HIGH_Z = 46;
const BRACE_MIN_ABS_Y = 11.5;
const BRACE_MIN_Z = 36;
const ROCKER_HALF_SPAN_IN = 1.25;
const HIVE_FRAME_NODES = ['hive_red/frame', 'hive_blue/frame', 'hive_shared/frame'];
/** the stop, in radians: what the RENDER lane holds every neighbour's tray to */
export const HIVE_STOP_RAD = (BB_HIVE_TILT_DEG * Math.PI) / 180;

export type HiveSide = 'red' | 'blue';
export const HIVE_SIDES: readonly HiveSide[] = ['red', 'blue'];

function isTrayBracePoint(y: number, z: number): boolean {
  return z >= BRACE_HIGH_Z || (Math.abs(y) >= BRACE_MIN_ABS_Y && z >= BRACE_MIN_Z);
}

/** world → pivot-local un-tilted: `Rot_x(−captureTheta)·(p − pivot)` */
function toPivotLocal(a: HiveSide, x: number, y: number, z: number): [number, number, number] {
  const pv = fieldColliders3d().trays[a].pivot;
  const t = -cadCaptureTheta(a);
  const dy = y - pv[1];
  const dz = z - pv[2];
  return [x - pv[0], Math.cos(t) * dy - Math.sin(t) * dz, Math.sin(t) * dy + Math.cos(t) * dz];
}

/**
 * Splits the riding parts out of the hive frames of `src` (dequantized, inches, z up), as the renderer
 * does: the rocker by whole welded component within `ROCKER_HALF_SPAN_IN` of a pivot's x, the braces
 * by triangle centroid. Kept triangles stay where they are; riding ones go to one new mesh per
 * alliance, pivot-local and un-tilted, one primitive per material. Returns those meshes and how many
 * triangles each took.
 */
export function splitRidingParts(src: any): { mesh: Record<HiveSide, any>; tris: Record<HiveSide, number> } {
  const pivX = { red: fieldColliders3d().trays.red.pivot[0], blue: fieldColliders3d().trays.blue.pivot[0] };
  const mesh: Record<HiveSide, any> = { red: src.createMesh('hive_red/tray-ride'), blue: src.createMesh('hive_blue/tray-ride') };
  const count: Record<HiveSide, number> = { red: 0, blue: 0 };
  const buffer = src.getRoot().listBuffers()[0];
  for (const node of src.getRoot().listNodes()) {
    if (!HIVE_FRAME_NODES.includes(node.getName()) || !node.getMesh()) continue;
    const m = node.getWorldMatrix();
    for (const prim of node.getMesh().listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      const idx = prim.getIndices();
      const nv = pos.getCount();
      const w = new Float64Array(nv * 3);
      const v = [0, 0, 0];
      for (let i = 0; i < nv; i++) {
        pos.getElement(i, v);
        w[i * 3] = m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12];
        w[i * 3 + 1] = m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13];
        w[i * 3 + 2] = m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14];
      }
      const tri: number[] = idx ? Array.from({ length: idx.getCount() }, (_, i) => idx.getScalar(i)) : Array.from({ length: nv }, (_, i) => i);
      // whole parts, welded by EXACT position (the renderer's `weldedComponents`)
      const parent = Int32Array.from({ length: nv }, (_, i) => i);
      const find = (i: number): number => {
        while (parent[i] !== i) i = parent[i] = parent[parent[i]];
        return i;
      };
      const join = (a: number, b: number) => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent[rb] = ra;
      };
      const site = new Map<string, number>();
      for (let i = 0; i < nv; i++) {
        const k = `${w[i * 3]},${w[i * 3 + 1]},${w[i * 3 + 2]}`;
        const s = site.get(k);
        if (s === undefined) site.set(k, i);
        else join(s, i);
      }
      for (let i = 0; i < tri.length; i += 3) {
        join(tri[i], tri[i + 1]);
        join(tri[i], tri[i + 2]);
      }
      const span = new Map<number, [number, number]>();
      for (let i = 0; i < nv; i++) {
        const r = find(i);
        const s = span.get(r);
        if (s) {
          s[0] = Math.min(s[0], w[i * 3]);
          s[1] = Math.max(s[1], w[i * 3]);
        } else span.set(r, [w[i * 3], w[i * 3]]);
      }
      const keep: number[] = [];
      const out: Record<HiveSide, number[]> = { red: [], blue: [] };
      for (let i = 0; i < tri.length; i += 3) {
        const s = span.get(find(tri[i]))!;
        let side: HiveSide | null = null;
        for (const a of HIVE_SIDES) if (Math.max(Math.abs(s[0] - pivX[a]), Math.abs(s[1] - pivX[a])) <= ROCKER_HALF_SPAN_IN) side = a;
        if (!side) {
          const c = [0, 1, 2].map((d) => (w[tri[i] * 3 + d] + w[tri[i + 1] * 3 + d] + w[tri[i + 2] * 3 + d]) / 3);
          if (isTrayBracePoint(c[1], c[2])) side = Math.abs(c[0] - pivX.red) < Math.abs(c[0] - pivX.blue) ? 'red' : 'blue';
        }
        if (side) out[side].push(tri[i], tri[i + 1], tri[i + 2]);
        else keep.push(tri[i], tri[i + 1], tri[i + 2]);
      }
      if (keep.length === tri.length) continue;
      prim.setIndices(src.createAccessor().setType('SCALAR').setArray(new Uint32Array(keep)).setBuffer(buffer));
      for (const a of HIVE_SIDES) {
        if (!out[a].length) continue;
        // re-index the riding triangles over their own vertices, pivot-local
        const remap = new Map<number, number>();
        const p: number[] = [];
        const ix = out[a].map((o) => {
          let r = remap.get(o);
          if (r === undefined) {
            r = remap.size;
            remap.set(o, r);
            p.push(...toPivotLocal(a, w[o * 3], w[o * 3 + 1], w[o * 3 + 2]));
          }
          return r;
        });
        mesh[a].addPrimitive(
          src
            .createPrimitive()
            .setAttribute('POSITION', src.createAccessor().setType('VEC3').setArray(new Float32Array(p)).setBuffer(buffer))
            .setIndices(src.createAccessor().setType('SCALAR').setArray(new Uint32Array(ix)).setBuffer(buffer))
            .setMaterial(prim.getMaterial()),
        );
        count[a] += ix.length / 3;
      }
    }
  }
  return { mesh, tris: count };
}

/** the tray pivot, in the field frame (inches, z up) */
export function trayPivot(a: HiveSide): [number, number, number] {
  const p = fieldColliders3d().trays[a].pivot;
  return [p[0], p[1], p[2]];
}

/** a tray node's matrix re-expressed under its pivot: `T(−pivot)·world` (column-major) */
export function trayUnderPivot(a: HiveSide, world: readonly number[]): number[] {
  const pv = trayPivot(a);
  const out = world.slice();
  out[12] -= pv[0];
  out[13] -= pv[1];
  out[14] -= pv[2];
  return out;
}

/** which side is up, seeded per field and alliance (FNV-1a), so the hall shows a mix */
export function hiveUpFor(label: string, a: HiveSide): 'north' | 'south' {
  let h = 0x811c9dc5;
  for (const ch of `${label}:${a}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  h ^= h >>> 15;
  return (h >>> 0) % 2 === 0 ? 'north' : 'south';
}

/** the tray's rotation about its pivot's x, exactly as `updateBiobuzzField` computes it at rest */
export function trayRestAngle(label: string, a: HiveSide): number {
  const world = { biobuzz: { hives: { [a]: { up: hiveUpFor(label, a), tipping: 0 } } } } as never;
  return hiveTiltAngle(world, a) - hiveTrayRefTheta(a);
}
