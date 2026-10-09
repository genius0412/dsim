/**
 * A SYNTHETIC IMPORTED-ROBOT GLB, built byte by byte (no exporter, no DOM): axis-aligned boxes in
 * the STORED frame lane 3 writes (`IMPORTED_MESH_TO_ROBOT`: glTF metres, +Y up, +Z front, +X left).
 * Used by the RENDER lane to drive the real GLTFLoader path and by `scripts/scene-preview` for
 * the imported-robot captures. Boxes are given in ROBOT inches (+x front, +y left, +z up) and
 * converted here, so a fixture reads like the robot it describes.
 */
export interface GlbBox {
  name: string;
  /** robot-local inches */
  min: [number, number, number];
  max: [number, number, number];
  /** linear RGB 0..1 */
  color: [number, number, number];
  metallic?: number;
  roughness?: number;
  /** a GLB may ask for glow; the importer's renderer must refuse it */
  emissive?: [number, number, number];
}

const M_PER_IN = 0.0254;

/** robot inches → glTF metres: gltf.x = robot.y, gltf.y = robot.z, gltf.z = robot.x */
function toGltf(x: number, y: number, z: number): [number, number, number] {
  return [y * M_PER_IN, z * M_PER_IN, x * M_PER_IN];
}

export function buildBoxesGlb(boxes: readonly GlbBox[]): ArrayBuffer {
  const pos: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  const prims: { first: number; count: number; vFirst: number; vCount: number; min: number[]; max: number[] }[] = [];
  for (const b of boxes) {
    const vFirst = pos.length / 3;
    const first = idx.length;
    const [x0, y0, z0] = b.min;
    const [x1, y1, z1] = b.max;
    // six faces, four vertices each (flat normals), in ROBOT axes: [normal, 4 corners CCW from outside]
    const faces: [[number, number, number], [number, number, number][]][] = [
      [[1, 0, 0], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]],
      [[-1, 0, 0], [[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]]],
      [[0, 1, 0], [[x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]]],
      [[0, -1, 0], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]],
      [[0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]],
      [[0, 0, -1], [[x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]]],
    ];
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const [n, quad] of faces) {
      const base = pos.length / 3 - vFirst;
      for (const [x, y, z] of quad) {
        const g = toGltf(x, y, z);
        pos.push(...g);
        g.forEach((v, i) => {
          lo[i] = Math.min(lo[i], v);
          hi[i] = Math.max(hi[i], v);
        });
        // a normal is a direction: the same permutation, no scale
        nrm.push(n[1], n[2], n[0]);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    prims.push({ first, count: idx.length - first, vFirst, vCount: pos.length / 3 - vFirst, min: lo, max: hi });
  }

  // one buffer: positions, normals, then indices (u16 relative to each primitive's own first vertex)
  const posBytes = pos.length * 4;
  const nrmBytes = nrm.length * 4;
  const idxBytes = idx.length * 2;
  const binLen = posBytes + nrmBytes + idxBytes;
  const binPadded = Math.ceil(binLen / 4) * 4;
  const bin = new ArrayBuffer(binPadded);
  new Float32Array(bin, 0, pos.length).set(pos);
  new Float32Array(bin, posBytes, nrm.length).set(nrm);
  new Uint16Array(bin, posBytes + nrmBytes, idx.length).set(idx);

  const json = {
    asset: { version: '2.0', generator: 'dsim-smoke-fixture' },
    scene: 0,
    scenes: [{ nodes: boxes.map((_, i) => i) }],
    nodes: boxes.map((b, i) => ({ name: b.name, mesh: i })),
    meshes: boxes.map((b, i) => ({
      name: b.name,
      primitives: [{ attributes: { POSITION: i * 3, NORMAL: i * 3 + 1 }, indices: i * 3 + 2, material: i }],
    })),
    materials: boxes.map((b) => ({
      name: b.name,
      pbrMetallicRoughness: { baseColorFactor: [...b.color, 1], metallicFactor: b.metallic ?? 0.1, roughnessFactor: b.roughness ?? 0.6 },
      ...(b.emissive ? { emissiveFactor: b.emissive } : {}),
    })),
    accessors: prims.flatMap((p) => [
      { bufferView: 0, byteOffset: p.vFirst * 12, componentType: 5126, count: p.vCount, type: 'VEC3', min: p.min, max: p.max },
      { bufferView: 1, byteOffset: p.vFirst * 12, componentType: 5126, count: p.vCount, type: 'VEC3' },
      { bufferView: 2, byteOffset: p.first * 2, componentType: 5123, count: p.count, type: 'SCALAR' },
    ]),
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes, target: 34962 },
      { buffer: 0, byteOffset: posBytes, byteLength: nrmBytes, target: 34962 },
      { buffer: 0, byteOffset: posBytes + nrmBytes, byteLength: idxBytes, target: 34963 },
    ],
    buffers: [{ byteLength: binPadded }],
  };
  const enc = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadded = Math.ceil(enc.length / 4) * 4;
  const total = 12 + 8 + jsonPadded + 8 + binPadded;
  const out = new ArrayBuffer(total);
  const dv = new DataView(out);
  const u8 = new Uint8Array(out);
  dv.setUint32(0, 0x46546c67, true); // 'glTF'
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonPadded, true);
  dv.setUint32(16, 0x4e4f534a, true); // 'JSON'
  u8.set(enc, 20);
  for (let i = enc.length; i < jsonPadded; i++) u8[20 + i] = 0x20;
  const binAt = 20 + jsonPadded;
  dv.setUint32(binAt, binPadded, true);
  dv.setUint32(binAt + 4, 0x004e4942, true); // 'BIN\0'
  u8.set(new Uint8Array(bin), binAt + 8);
  return out;
}

/**
 * A plausible imported robot: a low chassis plate, four wheels, a tall tower at the back, a
 * turret block on top and an intake box on the nose — inside the hull `IMPORT_FIXTURE_HULL` and
 * under `IMPORT_FIXTURE_HEIGHT`. One deliberately emissive part (the "LED"), which must render dark.
 */
export const IMPORT_FIXTURE_HULL = [
  { x: -8, y: -8 },
  { x: 5, y: -8 },
  { x: 10, y: -4 },
  { x: 10, y: 4 },
  { x: 5, y: 8 },
  { x: -8, y: 8 },
];
export const IMPORT_FIXTURE_HEIGHT = 14;

export const IMPORT_FIXTURE_BOXES: GlbBox[] = [
  { name: 'chassis', min: [-7.8, -7.8, 1.2], max: [4.8, 7.8, 3.2], color: [0.08, 0.1, 0.14], metallic: 0.6, roughness: 0.4 },
  { name: 'nose', min: [4.8, -3.8, 0.4], max: [9.8, 3.8, 3.0], color: [0.55, 0.57, 0.6], metallic: 0.9, roughness: 0.35 },
  { name: 'wheel-fl', min: [2.0, 5.3, 0], max: [6.0, 7.3, 4.0], color: [0.02, 0.02, 0.02], roughness: 0.9 },
  { name: 'wheel-fr', min: [2.0, -7.3, 0], max: [6.0, -5.3, 4.0], color: [0.02, 0.02, 0.02], roughness: 0.9 },
  { name: 'wheel-bl', min: [-7.0, 5.3, 0], max: [-3.0, 7.3, 4.0], color: [0.02, 0.02, 0.02], roughness: 0.9 },
  { name: 'wheel-br', min: [-7.0, -7.3, 0], max: [-3.0, -5.3, 4.0], color: [0.02, 0.02, 0.02], roughness: 0.9 },
  { name: 'tower', min: [-7.5, -2.0, 3.2], max: [-4.5, 2.0, 14.0], color: [0.75, 0.76, 0.78], metallic: 0.9, roughness: 0.3 },
  { name: 'turret', min: [-2.5, -2.5, 3.2], max: [2.5, 2.5, 7.5], color: [0.18, 0.2, 0.24], metallic: 0.5, roughness: 0.45 },
  { name: 'led', min: [9.3, -1.0, 2.6], max: [9.8, 1.0, 3.0], color: [0.9, 0.1, 0.1], emissive: [1, 0, 0] },
];
