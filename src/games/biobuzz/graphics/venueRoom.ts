/**
 * THE CLEAR ROOM OF A MODELED VENUE (2026-11-04) — plain numbers, no three.js, shared by the build
 * (`scripts/venue-models/build.ts`) and the RENDER lane.
 *
 * ⚠️ WHY A BOX, AND WHY IT IS ENOUGH. A modeled room is the owner's "real geometry", so it can put
 * anything between a camera and the field: a pillar, a hoop, a hanging lamp, the first row of a
 * stand. The rule that keeps the play visible is geometric, not a list of eyes: the build grows the
 * largest axis-aligned box around the field that no triangle above the floor touches, and the row's
 * `cameraRoom` is that box. A box is convex, so the segment from any eye inside it to any point of
 * the field (also inside it) lies inside it, and nothing can stand on that segment. The orbit and
 * free eyes are HELD inside it (`BbCameras.setRoom`); the driver and chase eyes are not held, so the
 * RENDER lane sweeps every in-match eye (`sweepMatchEyes`) and fails if one stands outside it.
 */


export interface VenueBox {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
}

/** a triangle soup in field inches: positions xyz, and indices (or null for non-indexed) */
export interface VenueTris {
  positions: ArrayLike<number>;
  indices: ArrayLike<number> | null;
}

/** a triangle counts as FLOOR (never an obstacle) when every corner is this close above the floor */
export const VENUE_FLOOR_SLACK_IN = 1;

function triCount(t: VenueTris): number {
  return (t.indices ? t.indices.length : t.positions.length / 3) / 3;
}

/** corner `k` (0–2) of triangle `i`, coordinate `axis` */
function corner(t: VenueTris, i: number, k: number, axis: number): number {
  const v = t.indices ? t.indices[i * 3 + k] : i * 3 + k;
  return t.positions[v * 3 + axis];
}

/** does triangle (a, b, c) touch the box (center `c`, half-extent `h`)? The separating-axis test
 * of Akenine-Möller: the box's three axes, the triangle's normal and the nine edge cross products. */
export function triTouchesBox(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  box: VenueBox,
): boolean {
  const ox = (box.min[0] + box.max[0]) / 2;
  const oy = (box.min[1] + box.max[1]) / 2;
  const oz = (box.min[2] + box.max[2]) / 2;
  const hx = (box.max[0] - box.min[0]) / 2;
  const hy = (box.max[1] - box.min[1]) / 2;
  const hz = (box.max[2] - box.min[2]) / 2;
  const v0 = [ax - ox, ay - oy, az - oz];
  const v1 = [bx - ox, by - oy, bz - oz];
  const v2 = [cx - ox, cy - oy, cz - oz];
  const h = [hx, hy, hz];
  // the box's own axes
  for (let i = 0; i < 3; i++) {
    if (Math.min(v0[i], v1[i], v2[i]) > h[i] || Math.max(v0[i], v1[i], v2[i]) < -h[i]) return false;
  }
  const e = [
    [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]],
    [v2[0] - v1[0], v2[1] - v1[1], v2[2] - v1[2]],
    [v0[0] - v2[0], v0[1] - v2[1], v0[2] - v2[2]],
  ];
  const sep = (x: number, y: number, z: number): boolean => {
    const p0 = v0[0] * x + v0[1] * y + v0[2] * z;
    const p1 = v1[0] * x + v1[1] * y + v1[2] * z;
    const p2 = v2[0] * x + v2[1] * y + v2[2] * z;
    const r = h[0] * Math.abs(x) + h[1] * Math.abs(y) + h[2] * Math.abs(z);
    return Math.min(p0, p1, p2) > r || Math.max(p0, p1, p2) < -r;
  };
  // the nine edge × axis directions
  for (const ed of e) {
    if (sep(0, -ed[2], ed[1]) || sep(ed[2], 0, -ed[0]) || sep(-ed[1], ed[0], 0)) return false;
  }
  // the triangle's plane
  const nx = e[0][1] * e[1][2] - e[0][2] * e[1][1];
  const ny = e[0][2] * e[1][0] - e[0][0] * e[1][2];
  const nz = e[0][0] * e[1][1] - e[0][1] * e[1][0];
  return !sep(nx, ny, nz);
}

/** the indices of the triangles that are obstacles: not floor, i.e. some corner above `floorZ +
 * VENUE_FLOOR_SLACK_IN` */
export function obstacleTris(t: VenueTris, floorZ: number): number[] {
  const out: number[] = [];
  const top = floorZ + VENUE_FLOOR_SLACK_IN;
  for (let i = 0, n = triCount(t); i < n; i++) {
    if (corner(t, i, 0, 2) > top || corner(t, i, 1, 2) > top || corner(t, i, 2, 2) > top) out.push(i);
  }
  return out;
}

/** the obstacle triangles (from `obstacleTris`) that touch `box`, at most `limit` of them */
export function trisInBox(t: VenueTris, obstacles: readonly number[], box: VenueBox, limit = Infinity): number[] {
  const out: number[] = [];
  for (const i of obstacles) {
    const ax = corner(t, i, 0, 0), ay = corner(t, i, 0, 1), az = corner(t, i, 0, 2);
    const bx = corner(t, i, 1, 0), by = corner(t, i, 1, 1), bz = corner(t, i, 1, 2);
    const cx = corner(t, i, 2, 0), cy = corner(t, i, 2, 1), cz = corner(t, i, 2, 2);
    // cheap reject on the triangle's own bounds first: almost every triangle fails here
    if (Math.max(ax, bx, cx) < box.min[0] || Math.min(ax, bx, cx) > box.max[0]) continue;
    if (Math.max(ay, by, cy) < box.min[1] || Math.min(ay, by, cy) > box.max[1]) continue;
    if (Math.max(az, bz, cz) < box.min[2] || Math.min(az, bz, cz) > box.max[2]) continue;
    if (triTouchesBox(ax, ay, az, bx, by, bz, cx, cy, cz, box)) {
      out.push(i);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/**
 * GROW THE CLEAR BOX: from `seed` (which must itself be clear), push each of its five open faces
 * (the ceiling, then the four walls; the floor stays at the seed's) outward toward `limit` for as long
 * as no obstacle touches the box, each face by bisection to `tolIn`, round-robin until none moves. The
 * result is the box the cameras may stand in. Deterministic: same soup, same box.
 */
export function growClearBox(t: VenueTris, obstacles: readonly number[], seed: VenueBox, limit: VenueBox, tolIn = 1): VenueBox {
  const min = [...seed.min] as [number, number, number];
  const max = [...seed.max] as [number, number, number];
  const clear = (): boolean => trisInBox(t, obstacles, { min, max }, 1).length === 0;
  if (!clear()) throw new Error('growClearBox: the seed box is not clear');
  // the faces that grow: +z, then −x, +x, −y, +y (the floor is where the seed puts it). THE CEILING
  // GOES FIRST: the growth is greedy, so the face that moves first takes the most. Walls first ran a
  // gym's box out to its hoops and a hangar's out under its eaves, and each one's rim or roof slope
  // then capped the ceiling at the menu eye's height; a high ceiling is what the orbit and free eyes
  // look down on the field from
  const faces: readonly { axis: 0 | 1 | 2; up: boolean }[] = [
    { axis: 2, up: true },
    { axis: 0, up: false },
    { axis: 0, up: true },
    { axis: 1, up: false },
    { axis: 1, up: true },
  ];
  for (let round = 0; round < 8; round++) {
    let moved = false;
    for (const f of faces) {
      const arr = f.up ? max : min;
      const from = arr[f.axis];
      const to = f.up ? limit.max[f.axis] : limit.min[f.axis];
      if (Math.abs(to - from) <= tolIn) continue;
      arr[f.axis] = to;
      if (clear()) {
        moved = true;
        continue;
      }
      let ok = from;
      let bad = to;
      while (Math.abs(bad - ok) > tolIn) {
        const mid = (ok + bad) / 2;
        arr[f.axis] = mid;
        if (clear()) ok = mid;
        else bad = mid;
      }
      arr[f.axis] = ok;
      if (Math.abs(ok - from) > tolIn / 2) moved = true;
    }
    if (!moved) break;
  }
  return { min, max };
}

/** `box` shrunk by `margin` on its four walls and its ceiling (the floor stays) — the room the
 * orbit and free eyes are held in, so a near-plane never reaches the geometry beyond it */
export function insetCameraRoom(box: VenueBox, margin: number): VenueBox {
  return {
    min: [box.min[0] + margin, box.min[1] + margin, box.min[2]],
    max: [box.max[0] - margin, box.max[1] - margin, box.max[2] - margin],
  };
}

/** is the point inside the box (closed) */
export function inVenueBox(p: readonly number[], box: VenueBox): boolean {
  return p[0] >= box.min[0] && p[0] <= box.max[0] && p[1] >= box.min[1] && p[1] <= box.max[1] && p[2] >= box.min[2] && p[2] <= box.max[2];
}
