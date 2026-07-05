import type { Alliance, Artifact, RobotState, Vec2 } from '../types';
import * as C from '../config';
import { classifierRect, goalFaceNormal, goalLineValue, type Rect } from './field';
import { dot, rot, clamp } from '../math';

const ALLIANCES: Alliance[] = ['red', 'blue'];

// ------------------------------------------------------------------ OBB ----

export function robotCorners(r: RobotState): Vec2[] {
  const hl = r.spec.length / 2;
  const hw = r.spec.width / 2;
  const local = [
    { x: hl, y: hw },
    { x: hl, y: -hw },
    { x: -hl, y: -hw },
    { x: -hl, y: hw },
  ];
  return local.map((p) => {
    const w = rot(p, r.heading);
    return { x: w.x + r.pos.x, y: w.y + r.pos.y };
  });
}

/** closest point on the robot's OBB to a world point */
export function closestPointOnRobot(r: RobotState, p: Vec2): Vec2 {
  const local = rot({ x: p.x - r.pos.x, y: p.y - r.pos.y }, -r.heading);
  const cx = clamp(local.x, -r.spec.length / 2, r.spec.length / 2);
  const cy = clamp(local.y, -r.spec.width / 2, r.spec.width / 2);
  const w = rot({ x: cx, y: cy }, r.heading);
  return { x: w.x + r.pos.x, y: w.y + r.pos.y };
}

/** SAT intersection test between the robot's OBB and an axis-aligned rect */
export function robotIntersectsRect(r: RobotState, rect: Rect): boolean {
  const rc = robotCorners(r);
  const rectC = [
    { x: rect.x0, y: rect.y0 },
    { x: rect.x1, y: rect.y0 },
    { x: rect.x1, y: rect.y1 },
    { x: rect.x0, y: rect.y1 },
  ];
  const axes = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    rot({ x: 1, y: 0 }, r.heading),
    rot({ x: 0, y: 1 }, r.heading),
  ];
  for (const ax of axes) {
    let aMin = Infinity;
    let aMax = -Infinity;
    for (const c of rc) {
      const p = c.x * ax.x + c.y * ax.y;
      aMin = Math.min(aMin, p);
      aMax = Math.max(aMax, p);
    }
    let bMin = Infinity;
    let bMax = -Infinity;
    for (const c of rectC) {
      const p = c.x * ax.x + c.y * ax.y;
      bMin = Math.min(bMin, p);
      bMax = Math.max(bMax, p);
    }
    if (aMax < bMin || bMax < aMin) return false;
  }
  return true;
}

/** velocity of a point rigidly attached to the robot */
export function robotPointVelocity(r: RobotState, p: Vec2): Vec2 {
  const rx = p.x - r.pos.x;
  const ry = p.y - r.pos.y;
  return { x: r.vel.x - r.angVel * ry, y: r.vel.y + r.angVel * rx };
}

// ------------------------------------------------- robot vs static field ----

function pushRobot(r: RobotState, nx: number, ny: number, depth: number): void {
  r.pos.x += nx * depth;
  r.pos.y += ny * depth;
  const vn = r.vel.x * nx + r.vel.y * ny;
  if (vn < 0) {
    r.vel.x -= nx * vn;
    r.vel.y -= ny * vn;
  }
}

/** push the robot out of walls, goal faces and classifier structures */
export function constrainRobot(r: RobotState): void {
  const f = C.FIELD_HALF;
  for (let pass = 0; pass < 2; pass++) {
    let corners = robotCorners(r);

    // perimeter walls
    let dxPos = 0;
    let dxNeg = 0;
    let dyPos = 0;
    let dyNeg = 0;
    for (const c of corners) {
      dxPos = Math.max(dxPos, c.x - f);
      dxNeg = Math.max(dxNeg, -f - c.x);
      dyPos = Math.max(dyPos, c.y - f);
      dyNeg = Math.max(dyNeg, -f - c.y);
    }
    if (dxPos > 0) pushRobot(r, -1, 0, dxPos);
    if (dxNeg > 0) pushRobot(r, 1, 0, dxNeg);
    if (dyPos > 0) pushRobot(r, 0, -1, dyPos);
    if (dyNeg > 0) pushRobot(r, 0, 1, dyNeg);

    // goal front faces (diagonal walls in the far corners)
    for (const a of ALLIANCES) {
      let worst = 0;
      for (const c of robotCorners(r)) {
        const gv = goalLineValue(c, a);
        if (gv > worst) worst = gv;
      }
      if (worst > 0) {
        const n = goalFaceNormal(a);
        pushRobot(r, n.x, n.y, worst / Math.SQRT2);
      }
    }

    // classifier ramp structures along the side walls
    for (const a of ALLIANCES) {
      const rect = classifierRect(a);
      corners = robotCorners(r);
      let best: { nx: number; ny: number; depth: number } | null = null;
      for (const c of corners) {
        if (c.x <= rect.x0 || c.x >= rect.x1 || c.y <= rect.y0 || c.y >= rect.y1) continue;
        // smallest push to evict this corner
        const cands: [number, number, number][] = [
          [-1, 0, c.x - rect.x0],
          [1, 0, rect.x1 - c.x],
          [0, -1, c.y - rect.y0],
          [0, 1, rect.y1 - c.y],
        ];
        const m = cands.reduce((p, q) => (q[2] < p[2] ? q : p));
        if (!best || m[2] > best.depth) best = { nx: m[0], ny: m[1], depth: m[2] };
      }
      if (best) pushRobot(r, best.nx, best.ny, best.depth);
    }
  }
}

// ------------------------------------------------------------ ball steps ----

export function stepGroundBall(b: Artifact, dt: number): void {
  b.pos.x += b.vel.x * dt;
  b.pos.y += b.vel.y * dt;
  const speed = Math.hypot(b.vel.x, b.vel.y);
  if (speed > 0) {
    const ns = speed - C.BALL_ROLL_FRICTION * dt;
    if (ns <= 0 || ns < C.BALL_REST_SPEED) {
      b.vel.x = 0;
      b.vel.y = 0;
    } else {
      const k = ns / speed;
      b.vel.x *= k;
      b.vel.y *= k;
    }
  }
}

export function stepFlightBall(b: Artifact, dt: number): void {
  b.pos.x += b.vel.x * dt;
  b.pos.y += b.vel.y * dt;
  b.z += b.vz * dt;
  b.vz -= C.GRAVITY * dt;
}

/** walls + goal faces for balls (ground and low flight) */
export function collideBallStatic(b: Artifact): void {
  const f = C.FIELD_HALF;
  const rr = C.BALL_RADIUS;
  if (b.pos.x > f - rr) {
    b.pos.x = f - rr;
    if (b.vel.x > 0) b.vel.x = -b.vel.x * C.BALL_WALL_RESTITUTION;
  } else if (b.pos.x < -f + rr) {
    b.pos.x = -f + rr;
    if (b.vel.x < 0) b.vel.x = -b.vel.x * C.BALL_WALL_RESTITUTION;
  }
  if (b.pos.y > f - rr) {
    b.pos.y = f - rr;
    if (b.vel.y > 0) b.vel.y = -b.vel.y * C.BALL_WALL_RESTITUTION;
  } else if (b.pos.y < -f + rr) {
    b.pos.y = -f + rr;
    if (b.vel.y < 0) b.vel.y = -b.vel.y * C.BALL_WALL_RESTITUTION;
  }
  // goal faces: solid below the opening lip
  if (b.z < C.GOAL_WALL_TOP) {
    for (const a of ALLIANCES) {
      const gv = goalLineValue(b.pos, a);
      const dist = gv / Math.SQRT2;
      const pen = dist + rr;
      if (pen > 0 && dist < rr * 3) {
        const n = goalFaceNormal(a);
        b.pos.x += n.x * pen;
        b.pos.y += n.y * pen;
        const vn = dot(b.vel, n);
        if (vn < 0) {
          b.vel.x -= n.x * vn * (1 + C.BALL_WALL_RESTITUTION);
          b.vel.y -= n.y * vn * (1 + C.BALL_WALL_RESTITUTION);
        }
      }
    }
  }
}

export function collideBallBall(a: Artifact, b: Artifact): void {
  const dx = b.pos.x - a.pos.x;
  const dy = b.pos.y - a.pos.y;
  const d2 = dx * dx + dy * dy;
  const minD = C.BALL_RADIUS * 2;
  if (d2 >= minD * minD || d2 < 1e-9) return;
  const d = Math.sqrt(d2);
  const nx = dx / d;
  const ny = dy / d;
  const overlap = minD - d;
  a.pos.x -= (nx * overlap) / 2;
  a.pos.y -= (ny * overlap) / 2;
  b.pos.x += (nx * overlap) / 2;
  b.pos.y += (ny * overlap) / 2;
  const rvx = b.vel.x - a.vel.x;
  const rvy = b.vel.y - a.vel.y;
  const vn = rvx * nx + rvy * ny;
  if (vn < 0) {
    const j = (-(1 + C.BALL_BALL_RESTITUTION) * vn) / 2; // equal masses
    a.vel.x -= j * nx;
    a.vel.y -= j * ny;
    b.vel.x += j * nx;
    b.vel.y += j * ny;
  }
}

/** push a ground ball out of a robot chassis, inheriting surface velocity */
export function collideBallRobot(b: Artifact, r: RobotState): void {
  const cp = closestPointOnRobot(r, b.pos);
  const dx = b.pos.x - cp.x;
  const dy = b.pos.y - cp.y;
  const d2 = dx * dx + dy * dy;
  if (d2 >= C.BALL_RADIUS * C.BALL_RADIUS) return;
  let nx: number;
  let ny: number;
  let pen: number;
  if (d2 > 1e-9) {
    const d = Math.sqrt(d2);
    nx = dx / d;
    ny = dy / d;
    pen = C.BALL_RADIUS - d;
  } else {
    // ball center inside the OBB: push out along the vector from robot center
    const ox = b.pos.x - r.pos.x;
    const oy = b.pos.y - r.pos.y;
    const ol = Math.hypot(ox, oy) || 1;
    nx = ox / ol;
    ny = oy / ol;
    pen = C.BALL_RADIUS + 2;
  }
  b.pos.x += nx * pen;
  b.pos.y += ny * pen;
  const sv = robotPointVelocity(r, cp);
  const rvx = b.vel.x - sv.x;
  const rvy = b.vel.y - sv.y;
  const vn = rvx * nx + rvy * ny;
  if (vn < 0) {
    b.vel.x -= nx * vn * 1.4;
    b.vel.y -= ny * vn * 1.4;
  }
}

/** solid rect for balls: bounces approaching balls off the faces, and evicts
 * a ball that ends up inside through the nearest edge */
export function collideBallRect(b: Artifact, rect: Rect, restitution = C.BALL_WALL_RESTITUTION): void {
  const inside =
    b.pos.x > rect.x0 && b.pos.x < rect.x1 && b.pos.y > rect.y0 && b.pos.y < rect.y1;
  if (inside) {
    const exits: [number, number, number][] = [
      [-1, 0, b.pos.x - rect.x0],
      [1, 0, rect.x1 - b.pos.x],
      [0, -1, b.pos.y - rect.y0],
      [0, 1, rect.y1 - b.pos.y],
    ];
    const [nx, ny, d] = exits.reduce((p, q) => (q[2] < p[2] ? q : p));
    b.pos.x += nx * (d + C.BALL_RADIUS);
    b.pos.y += ny * (d + C.BALL_RADIUS);
    const vn = b.vel.x * nx + b.vel.y * ny;
    if (vn < 0) {
      b.vel.x -= nx * vn * (1 + restitution);
      b.vel.y -= ny * vn * (1 + restitution);
    }
    return;
  }
  const cx = clamp(b.pos.x, rect.x0, rect.x1);
  const cy = clamp(b.pos.y, rect.y0, rect.y1);
  const dx = b.pos.x - cx;
  const dy = b.pos.y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 >= C.BALL_RADIUS * C.BALL_RADIUS || d2 < 1e-9) return;
  const d = Math.sqrt(d2);
  const nx = dx / d;
  const ny = dy / d;
  const pen = C.BALL_RADIUS - d;
  b.pos.x += nx * pen;
  b.pos.y += ny * pen;
  const vn = b.vel.x * nx + b.vel.y * ny;
  if (vn < 0) {
    b.vel.x -= nx * vn * (1 + restitution);
    b.vel.y -= ny * vn * (1 + restitution);
  }
}
