/**
 * A SYNTHETIC FTC ROBOT for the importer's checks, fixtures and harness. Plain arrays, no three.
 *
 * Canonical frame = the importer's robot-local frame: inches, +x front, +y left, +z up, floor at
 * z = 0, origin at the wheelbase centre. Every solid is a convex PRISM (a CCW polygon extruded
 * along an axis), so the same definition triangulates for the mesh formats and writes as an exact
 * B-rep for STEP.
 *
 * The default robot: a 16 × 14 in frame (x ±8, y ±7) on four 104 mm wheels at (±5.5, ±5.5), a
 * tower behind centre to 15 in, and a front intake roller reaching x = 10 whose bottom is 0.5 in
 * off the floor, and a flag on the LEFT rail only (y to 7.5) so a mirrored import shows. Footprint
 * box 18 × 14.5 (x −8..10, y −7..7.5), height 15. `sixWheel` adds a middle wheel each side.
 */
export type V3 = [number, number, number];

export interface Prism {
  name: string;
  /** sRGB 0..1 */
  color: V3;
  /** polygon corners in 3D, CCW seen from the tip of `extrude` */
  base: V3[];
  extrude: V3;
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** an axis-aligned box as a prism along +z */
export function box(name: string, color: V3, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Prism {
  return { name, color, base: [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], extrude: [0, 0, z1 - z0] };
}

/** a cylinder whose axis runs along +y, from y0 to y1, as an n-gon prism (a vertex at the bottom) */
export function cylY(name: string, color: V3, cx: number, cz: number, r: number, y0: number, y1: number, n = 16): Prism {
  // u = +z, v = +x, u × v = +y: angle φ from the bottom vertex, CCW about +y in (u, v)
  const pts: V3[] = [];
  for (let k = 0; k < n; k++) {
    const phi = (2 * Math.PI * k) / n;
    const u = -r * Math.cos(phi); // starts at −r (bottom)
    const v = r * Math.sin(phi);
    pts.push([cx + v, y0, cz + u]);
  }
  // orientation: (u, v) = (z, x); CCW about +y means the signed area in (u, v) is positive
  let area = 0;
  for (let k = 0; k < n; k++) {
    const a = pts[k];
    const b = pts[(k + 1) % n];
    area += (a[2] - cz) * (b[0] - cx) - (b[2] - cz) * (a[0] - cx);
  }
  return { name, color, base: area > 0 ? pts : pts.slice().reverse(), extrude: [0, y1 - y0, 0] };
}

/** a cylinder whose axis runs up +z, from z0 to z1, as an n-gon prism (a side roller standing up) */
export function cylZ(name: string, color: V3, cx: number, cy: number, r: number, z0: number, z1: number, n = 16): Prism {
  const pts: V3[] = [];
  for (let k = 0; k < n; k++) {
    const phi = (2 * Math.PI * k) / n;
    pts.push([cx + r * Math.cos(phi), cy + r * Math.sin(phi), z0]);
  }
  return { name, color, base: pts, extrude: [0, 0, z1 - z0] };
}

export const WHEEL_R = 104 / 25.4 / 2;

export function synthRobot(opts: { sixWheel?: boolean; segments?: number } = {}): Prism[] {
  const n = opts.segments ?? 16;
  const dark: V3 = [0.18, 0.19, 0.21];
  const rubber: V3 = [0.06, 0.06, 0.07];
  const alu: V3 = [0.72, 0.73, 0.75];
  const orange: V3 = [0.95, 0.55, 0.1];
  const green: V3 = [0.2, 0.7, 0.3];
  const blue: V3 = [0.15, 0.35, 0.9];
  const out: Prism[] = [
    box('belly', alu, -8, 8, -6.3, 6.3, 1.2, 1.7),
    box('rail_left', dark, -8, 8, 6.3, 7, 0.8, 4.5),
    box('rail_right', dark, -8, 8, -7, -6.3, 0.8, 4.5),
    box('tower', orange, -4, 0, -3, 3, 1.7, 15),
    cylY('intake', green, 9, 1.5, 1.0, -6, 6, n),
    // LEFT-SIDE ONLY, so handedness is testable: a mirrored import puts it on the right
    box('flag', blue, 2, 6, 6.3, 7.5, 4.5, 6),
  ];
  const xs = opts.sixWheel ? [5.5, 0, -5.5] : [5.5, -5.5];
  for (const x of xs) {
    for (const y of [5.5, -5.5]) out.push(cylY(`wheel_${x}_${y}`, rubber, x, WHEEL_R, WHEEL_R, y - 0.75, y + 0.75, n));
  }
  return out;
}

/** triangles of a prism, outward-wound: caps fanned, sides as quads */
export function prismTriangles(p: Prism): V3[][] {
  const n = p.base.length;
  const top = p.base.map((v) => add(v, p.extrude));
  const tris: V3[][] = [];
  for (let k = 1; k + 1 < n; k++) {
    tris.push([top[0], top[k], top[k + 1]]); // top: CCW from the tip
    tris.push([p.base[0], p.base[k + 1], p.base[k]]); // bottom: reversed
  }
  for (let k = 0; k < n; k++) {
    const a = p.base[k];
    const b = p.base[(k + 1) % n];
    const c = top[(k + 1) % n];
    const d = top[k];
    tris.push([a, b, c], [a, c, d]);
  }
  return tris;
}

/** the robot as importer `MeshPart`-shaped data (linear colour), through `map` (a file frame) */
export function synthParts(prisms: Prism[], map: (v: V3) => V3 = (v) => v): { positions: Float32Array; indices: null; color: [number, number, number]; name: string }[] {
  const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return prisms.map((p) => {
    const tris = prismTriangles(p);
    const pos = new Float32Array(tris.length * 9);
    tris.forEach((t, i) => t.forEach((v, j) => pos.set(map(v), i * 9 + j * 3)));
    return { positions: pos, indices: null, color: [lin(p.color[0]), lin(p.color[1]), lin(p.color[2])], name: p.name };
  });
}

/** canonical inches → a file frame. The four the fixtures use: */
export const FRAMES = {
  /** glTF: metres, +Y up, front +Z, +X left */
  gltf: (v: V3): V3 => [v[1] * 0.0254, v[2] * 0.0254, v[0] * 0.0254],
  /** CAD Z-up, front −Y (X = robot left), millimetres */
  cadMm: (v: V3): V3 => [v[1] * 25.4, -v[0] * 25.4, v[2] * 25.4],
  /** CAD Z-up, front −Y, centimetres */
  cadCm: (v: V3): V3 => [v[1] * 2.54, -v[0] * 2.54, v[2] * 2.54],
  /** Y-up, front +Z, inches (an OBJ from a Y-up tool) */
  yUpIn: (v: V3): V3 => [v[1], v[2], v[0]],
};
