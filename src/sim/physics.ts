import type { Alliance, Artifact, RobotState, Vec2 } from '../types';
import * as C from '../config';
import { classifierRect, goalFaceNormal, goalLineValue, type Rect } from './field';
import { dot, rot, clamp } from '../math';

const ALLIANCES: Alliance[] = ['red', 'blue'];

// ------------------------------------------------------------------ OBB ----

/** collision extents in the robot frame: the intake is a physical part of
 * the robot, so the footprint extends forward by its reach */
export function robotExtents(r: RobotState): { front: number; rear: number; half: number } {
  return {
    front: r.spec.length / 2 + C.INTAKE_PRESETS[r.spec.intake].reach,
    rear: r.spec.length / 2,
    half: r.spec.width / 2,
  };
}

export function robotCorners(r: RobotState): Vec2[] {
  const e = robotExtents(r);
  const local = [
    { x: e.front, y: e.half },
    { x: e.front, y: -e.half },
    { x: -e.rear, y: -e.half },
    { x: -e.rear, y: e.half },
  ];
  return local.map((p) => {
    const w = rot(p, r.heading);
    return { x: w.x + r.pos.x, y: w.y + r.pos.y };
  });
}

/** the four wheel ground-contact points (wheel centers), inset INSIDE the
 * chassis — no intake or turret overhang. Base parking counts ONLY these:
 * what touches the floor is what's "in" the zone. */
export function wheelContacts(r: RobotState): Vec2[] {
  const ix = Math.max(r.spec.length / 2 - C.WHEEL_INSET, 1);
  const iy = Math.max(r.spec.width / 2 - C.WHEEL_INSET, 1);
  const local = [
    { x: ix, y: iy },
    { x: ix, y: -iy },
    { x: -ix, y: -iy },
    { x: -ix, y: iy },
  ];
  return local.map((p) => {
    const w = rot(p, r.heading);
    return { x: w.x + r.pos.x, y: w.y + r.pos.y };
  });
}

/** closest point on the robot's OBB (incl. intake) to a world point */
export function closestPointOnRobot(r: RobotState, p: Vec2): Vec2 {
  const e = robotExtents(r);
  const local = rot({ x: p.x - r.pos.x, y: p.y - r.pos.y }, -r.heading);
  const cx = clamp(local.x, -e.rear, e.front);
  const cy = clamp(local.y, -e.half, e.half);
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

/** rigid-contact response: push the robot out along the normal AND apply the
 * summed contact torque, so driving tilted into a wall squares the chassis
 * up flush against it. Torque sums over all touching corners — a flush face
 * has symmetric contacts that cancel, so it is stable. */
function pushRobotAt(
  r: RobotState,
  nx: number,
  ny: number,
  depth: number,
  contacts: { c: Vec2; d: number }[],
  // squaring against a flat face caps rotation at the remaining tilt; point
  // contacts (a pinned ball) instead pivot the chassis freely
  squareTo = true,
): void {
  r.pos.x += nx * depth;
  r.pos.y += ny * depth;
  const vn = r.vel.x * nx + r.vel.y * ny;
  // how hard the robot is driving into the contact (in/s), before the kill
  const press = vn < 0 ? -vn : 0;
  if (vn < 0) {
    r.vel.x -= nx * vn;
    r.vel.y -= ny * vn;
  }
  let torque = 0;
  for (const { c, d } of contacts) {
    const lx = c.x - r.pos.x;
    const ly = c.y - r.pos.y;
    const lever = Math.hypot(lx, ly);
    if (lever < 1e-6) continue;
    torque += ((lx * ny - ly * nx) / lever) * (Math.min(d, 2) + C.CONTACT_BIAS);
  }
  // pushing harder squares up faster: alignment scales with contact pressure,
  // so a full-speed hit swings the robot hard and a steady shove against the
  // wall keeps it turning briskly instead of inching around
  const gain = 1 + press * C.CONTACT_PRESS_GAIN;
  const rate = Math.min(C.CONTACT_ALIGN_RATE * gain, C.CONTACT_ALIGN_RATE_MAX);
  // never step PAST flush: cap the correction at the remaining tilt (the
  // chassis is square, so flush poses repeat every 90°). Without this cap the
  // torque bias overshoots each tick and the heading buzzes at the wall.
  let flushErr = Infinity;
  if (squareTo) {
    const q = Math.PI / 2;
    let rel = r.heading - Math.atan2(ny, nx);
    rel -= Math.round(rel / q) * q;
    flushErr = Math.abs(rel);
  }
  const cap = Math.min(rate, flushErr);
  const align = clamp(torque * 0.1 * gain, -cap, cap);
  if (align !== 0) {
    r.heading += align;
    if (r.angVel * align < 0) {
      // bleed angular velocity that fights the contact
      r.angVel *= 0.9;
    } else if (flushErr > 0.05) {
      // a fast off-axis impact converts speed into visible spin — scaled by
      // the actual torque so a dead-center (torque≈0) contact adds nothing,
      // and gated near flush so it can't re-excite a settled robot
      r.angVel = clamp(
        r.angVel + torque * press * C.CONTACT_IMPACT_SPIN,
        -C.TURN_MAX_SPEED,
        C.TURN_MAX_SPEED,
      );
    }
  }
}

/** push the robot out of walls, goal faces and classifier structures */
export function constrainRobot(r: RobotState): void {
  const f = C.FIELD_HALF;
  for (let pass = 0; pass < 3; pass++) {
    let corners = robotCorners(r);

    // perimeter walls: all touching corners contribute contact torque
    const walls: [number, number, (c: Vec2) => number][] = [
      [-1, 0, (c) => c.x - f],
      [1, 0, (c) => -f - c.x],
      [0, -1, (c) => c.y - f],
      [0, 1, (c) => -f - c.y],
    ];
    for (const [nx, ny, depthOf] of walls) {
      let depth = 0;
      const contacts: { c: Vec2; d: number }[] = [];
      for (const c of corners) {
        const d = depthOf(c);
        if (d > -0.05) contacts.push({ c, d: Math.max(d, 0) });
        if (d > depth) depth = d;
      }
      if (depth > 0) pushRobotAt(r, nx, ny, depth, contacts);
    }

    // goal front faces (diagonal walls in the far corners)
    for (const a of ALLIANCES) {
      let worst = 0;
      const contacts: { c: Vec2; d: number }[] = [];
      for (const c of robotCorners(r)) {
        const d = goalLineValue(c, a) / Math.SQRT2;
        if (d > -0.05) contacts.push({ c, d: Math.max(d, 0) });
        if (d > worst) worst = d;
      }
      if (worst > 0) {
        const n = goalFaceNormal(a);
        pushRobotAt(r, n.x, n.y, worst, contacts);
      }
    }

    // classifier ramp structures along the side walls
    for (const a of ALLIANCES) {
      const rect = classifierRect(a);
      corners = robotCorners(r);
      let best: { nx: number; ny: number; depth: number; contact: Vec2 } | null = null;
      for (const c of corners) {
        if (c.x <= rect.x0 || c.x >= rect.x1 || c.y <= rect.y0 || c.y >= rect.y1) continue;
        // smallest push to evict this corner — but never TOWARD a field wall
        // (the channel's outer edge IS the wall): that push just wedges the
        // wheel between wall and structure and the two constraints fight
        // forever, leaving the robot stuck
        const lim = C.FIELD_HALF - 0.05;
        const cands = (
          [
            [-1, 0, c.x - rect.x0],
            [1, 0, rect.x1 - c.x],
            [0, -1, c.y - rect.y0],
            [0, 1, rect.y1 - c.y],
          ] as [number, number, number][]
        ).filter(([nx, ny, d]) => {
          const px = c.x + nx * d;
          const py = c.y + ny * d;
          return Math.abs(px) < lim && Math.abs(py) < lim;
        });
        if (cands.length === 0) continue;
        const m = cands.reduce((p, q) => (q[2] < p[2] ? q : p));
        if (!best || m[2] > best.depth) {
          best = { nx: m[0], ny: m[1], depth: m[2], contact: c };
        }
      }
      if (best) {
        pushRobotAt(r, best.nx, best.ny, best.depth, [{ c: best.contact, d: best.depth }]);
      }
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

/** position-only clamp against walls and goal faces: where a pushed ball is
 * actually allowed to end up. The difference between the requested and the
 * clamped position is the part of a push the field refused. */
function clampBallPosToStatics(p: Vec2): Vec2 {
  const f = C.FIELD_HALF - C.BALL_RADIUS;
  const out = { x: clamp(p.x, -f, f), y: clamp(p.y, -f, f) };
  for (const a of ALLIANCES) {
    const dist = goalLineValue(out, a) / Math.SQRT2;
    const pen = dist + C.BALL_RADIUS;
    if (pen > 0 && dist < C.BALL_RADIUS * 3) {
      const n = goalFaceNormal(a);
      out.x += n.x * pen;
      out.y += n.y * pen;
    }
  }
  return out;
}

/** push a ground ball out of a robot chassis, inheriting surface velocity.
 * A ball squeezed between the chassis and a wall is incompressible: the part
 * of the push the wall refuses transmits back onto the ROBOT (positional
 * pushback + normal velocity kill + contact torque), so the robot stalls
 * against a pinned ball instead of grinding it through. Off-center balls keep
 * the tangential part of the push and squirt out sideways. */
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
  const tx = b.pos.x + nx * pen;
  const ty = b.pos.y + ny * pen;
  const c = clampBallPosToStatics({ x: tx, y: ty });
  b.pos.x = c.x;
  b.pos.y = c.y;
  const bx = tx - c.x; // push refused by the field, pointing into the wall
  const by = ty - c.y;
  const blocked = Math.hypot(bx, by);
  if (blocked > C.BALL_PIN_SLOP) {
    const inx = bx / blocked; // direction of the refused push (into the wall)
    const iny = by / blocked;
    // only the robot's OWN drive transmits through a pinned ball — a foam
    // ball arriving under its own momentum (e.g. gate outflow) can't shove
    // the chassis; it just stops against it and the flow stacks up behind
    const drivingIn = r.vel.x * inx + r.vel.y * iny;
    if (drivingIn > C.BALL_PIN_PUSH_MIN_SPEED) {
      pushRobotAt(r, -inx, -iny, blocked, [{ c: cp, d: blocked }], false);
    }
  }
  const sv = robotPointVelocity(r, cp);
  const rvx = b.vel.x - sv.x;
  const rvy = b.vel.y - sv.y;
  const vn = rvx * nx + rvy * ny;
  if (vn < 0) {
    b.vel.x -= nx * vn * (1 + C.BALL_ROBOT_RESTITUTION);
    b.vel.y -= ny * vn * (1 + C.BALL_ROBOT_RESTITUTION);
  }
}

/** solid rect for balls: bounces approaching balls off the faces, and evicts
 * a ball that ends up inside through the nearest edge */
export function collideBallRect(b: Artifact, rect: Rect, restitution = C.BALL_WALL_RESTITUTION): void {
  const inside =
    b.pos.x > rect.x0 && b.pos.x < rect.x1 && b.pos.y > rect.y0 && b.pos.y < rect.y1;
  if (inside) {
    // never evict through a field wall (e.g. the classifier channel's outer
    // edge IS the wall — a squeezed ball must exit into the field)
    const lim = C.FIELD_HALF - C.BALL_RADIUS;
    const exits: [number, number, number][] = (
      [
        [-1, 0, b.pos.x - rect.x0],
        [1, 0, rect.x1 - b.pos.x],
        [0, -1, b.pos.y - rect.y0],
        [0, 1, rect.y1 - b.pos.y],
      ] as [number, number, number][]
    ).filter(([nx, ny, d]) => {
      const px = b.pos.x + nx * (d + C.BALL_RADIUS);
      const py = b.pos.y + ny * (d + C.BALL_RADIUS);
      return Math.abs(px) <= lim && Math.abs(py) <= lim;
    });
    if (exits.length === 0) return;
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
