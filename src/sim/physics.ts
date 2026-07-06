import type { Alliance, Artifact, RobotState, Vec2 } from '../types';
import * as C from '../config';
import { classifierRect, goalFaceNormal, goalLineValue, type Rect } from './field';
import { dot, rot, clamp, hyp, datan2 } from '../math';
import { driveParams } from './drivetrain';

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
  applyContactTorque(r, nx, ny, press, contacts, squareTo);
}

/** the contact-torque response shared by wall and robot-robot contacts:
 * pushing harder squares up faster (pressure-scaled), the correction never
 * steps past flush, and fast off-axis hits convert speed into visible spin */
function applyContactTorque(
  r: RobotState,
  nx: number,
  ny: number,
  press: number,
  contacts: { c: Vec2; d: number }[],
  squareTo: boolean,
): void {
  let torque = 0;
  for (const { c, d } of contacts) {
    const lx = c.x - r.pos.x;
    const ly = c.y - r.pos.y;
    const lever = hyp(lx, ly);
    if (lever < 1e-6) continue;
    torque += ((lx * ny - ly * nx) / lever) * (Math.min(d, 2) + C.CONTACT_BIAS);
  }
  const gain = 1 + press * C.CONTACT_PRESS_GAIN;
  const rate = Math.min(C.CONTACT_ALIGN_RATE * gain, C.CONTACT_ALIGN_RATE_MAX);
  // never step PAST flush: cap the correction at the remaining tilt (the
  // chassis is square, so flush poses repeat every 90°). Without this cap the
  // torque bias overshoots each tick and the heading buzzes at the wall.
  let flushErr = Infinity;
  if (squareTo) {
    const q = Math.PI / 2;
    let rel = r.heading - datan2(ny, nx);
    rel -= Math.round(rel / q) * q;
    flushErr = Math.abs(rel);
  }
  const cap = Math.min(rate, flushErr);
  const align = clamp(torque * 0.1 * gain, -cap, cap);
  if (align !== 0) {
    const maxTurn = driveParams(r.spec).maxTurn;
    r.heading += align;
    if (r.angVel * align < 0) {
      // bleed angular velocity that fights the contact
      r.angVel *= 0.9;
    } else if (flushErr > 0.05) {
      // a fast off-axis impact converts speed into visible spin — scaled by
      // the actual torque so a dead-center (torque≈0) contact adds nothing,
      // and gated near flush so it can't re-excite a settled robot
      r.angVel = clamp(r.angVel + torque * press * C.CONTACT_IMPACT_SPIN, -maxTurn, maxTurn);
    }
  }
}

/** how deep a world point sits inside the robot's OBB (incl. intake);
 * negative = outside */
function pointDepthInRobot(r: RobotState, p: Vec2): number {
  const e = robotExtents(r);
  const local = rot({ x: p.x - r.pos.x, y: p.y - r.pos.y }, -r.heading);
  const dx = Math.min(local.x + e.rear, e.front - local.x);
  const dy = Math.min(local.y + e.half, e.half - local.y);
  return Math.min(dx, dy);
}

/** OBB-vs-OBB robot collision (SAT over both robots' axes). Near-inelastic
 * shoving with MASS-weighted resolution: the heavier robot yields less, both
 * chassis get the contact-torque response (bumpers square up against each
 * other). Registers the contact pair into `out` (for the penalty engine). */
export function collideRobots(
  a: RobotState,
  b: RobotState,
  out: { a: number; b: number }[] | null,
): void {
  const ca = robotCorners(a);
  const cb = robotCorners(b);
  const axes = [
    rot({ x: 1, y: 0 }, a.heading),
    rot({ x: 0, y: 1 }, a.heading),
    rot({ x: 1, y: 0 }, b.heading),
    rot({ x: 0, y: 1 }, b.heading),
  ];
  let minPen = Infinity;
  let minAxis: Vec2 | null = null;
  for (const ax of axes) {
    let aMin = Infinity;
    let aMax = -Infinity;
    for (const c of ca) {
      const p = c.x * ax.x + c.y * ax.y;
      aMin = Math.min(aMin, p);
      aMax = Math.max(aMax, p);
    }
    let bMin = Infinity;
    let bMax = -Infinity;
    for (const c of cb) {
      const p = c.x * ax.x + c.y * ax.y;
      bMin = Math.min(bMin, p);
      bMax = Math.max(bMax, p);
    }
    const overlap = Math.min(aMax, bMax) - Math.max(aMin, bMin);
    if (overlap <= 0) return; // separated
    if (overlap < minPen) {
      minPen = overlap;
      minAxis = ax;
    }
  }
  if (!minAxis) return;
  // normal oriented a -> b
  let nx = minAxis.x;
  let ny = minAxis.y;
  if ((b.pos.x - a.pos.x) * nx + (b.pos.y - a.pos.y) * ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  if (out) out.push(a.id < b.id ? { a: a.id, b: b.id } : { a: b.id, b: a.id });

  // mass-weighted positional split: the heavier robot yields less
  const ma = a.spec.massLb;
  const mb = b.spec.massLb;
  const wa = mb / (ma + mb);
  const wb = ma / (ma + mb);
  a.pos.x -= nx * minPen * wa;
  a.pos.y -= ny * minPen * wa;
  b.pos.x += nx * minPen * wb;
  b.pos.y += ny * minPen * wb;

  // per-robot pressure into the contact (for the torque response), then a
  // near-inelastic normal impulse: closing velocity dies, masses decide who
  // gets moved
  const pressA = Math.max(0, a.vel.x * nx + a.vel.y * ny);
  const pressB = Math.max(0, -(b.vel.x * nx + b.vel.y * ny));
  const rvn = (b.vel.x - a.vel.x) * nx + (b.vel.y - a.vel.y) * ny;
  if (rvn < 0) {
    // impulse for restitution 0 split by mass
    a.vel.x += nx * rvn * wa;
    a.vel.y += ny * rvn * wa;
    b.vel.x -= nx * rvn * wb;
    b.vel.y -= ny * rvn * wb;
  }

  // contact manifold: every corner of one chassis inside the other
  const contacts: { c: Vec2; d: number }[] = [];
  for (const c of cb) {
    const d = pointDepthInRobot(a, c);
    if (d > -0.05) contacts.push({ c, d: Math.max(d, 0) });
  }
  for (const c of ca) {
    const d = pointDepthInRobot(b, c);
    if (d > -0.05) contacts.push({ c, d: Math.max(d, 0) });
  }
  applyContactTorque(a, -nx, -ny, pressA, contacts, true);
  applyContactTorque(b, nx, ny, pressB, contacts, true);
}

/** push the robot out of walls, goal faces and classifier structures */
/** minimum-translation-vector to separate the robot OBB (intake included) from
 * an axis-aligned rect, oriented to push the robot AWAY from the rect. null if
 * already separated. SAT over the rect's axes + the robot's two axes. */
function classifierMTV(r: RobotState, rect: Rect): { nx: number; ny: number; depth: number } | null {
  const corners = robotCorners(r);
  const rc = [
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
  let minOv = Infinity;
  let ax = { x: 0, y: 0 };
  for (const axis of axes) {
    let aMin = Infinity;
    let aMax = -Infinity;
    for (const c of corners) {
      const p = c.x * axis.x + c.y * axis.y;
      if (p < aMin) aMin = p;
      if (p > aMax) aMax = p;
    }
    let bMin = Infinity;
    let bMax = -Infinity;
    for (const c of rc) {
      const p = c.x * axis.x + c.y * axis.y;
      if (p < bMin) bMin = p;
      if (p > bMax) bMax = p;
    }
    const ov = Math.min(aMax, bMax) - Math.max(aMin, bMin);
    if (ov <= 0) return null; // a separating axis exists ⇒ no overlap
    if (ov < minOv) {
      minOv = ov;
      ax = axis;
    }
  }
  // orient the normal away from the rect (toward the robot center)
  const cx = (rect.x0 + rect.x1) / 2;
  const cy = (rect.y0 + rect.y1) / 2;
  let nx = ax.x;
  let ny = ax.y;
  if ((r.pos.x - cx) * nx + (r.pos.y - cy) * ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  return { nx, ny, depth: minOv };
}

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
        const d = goalLineValue(c, a); // perpendicular distance behind the face
        if (d > -0.05) contacts.push({ c, d: Math.max(d, 0) });
        if (d > worst) worst = d;
      }
      if (worst > 0) {
        const n = goalFaceNormal(a);
        pushRobotAt(r, n.x, n.y, worst, contacts);
      }
    }

    // classifier ramp structures along the side walls. Evict via the true
    // minimum-translation-vector of the robot OBB (intake INCLUDED) vs the
    // channel rect, so ramming a CORNER pushes out the right way and the intake
    // never stays clipped — with contact torque so a ram squares the chassis up.
    // The channel's outer edge IS the field wall, so a push whose normal points
    // (predominantly) toward that wall is skipped — the wall constraint handles
    // it — to avoid a wall-vs-structure fight.
    for (const a of ALLIANCES) {
      const rect = classifierRect(a);
      const mtv = classifierMTV(r, rect);
      if (!mtv) continue;
      const wallDir = rect.x0 <= -C.FIELD_HALF + 0.01 ? -1 : 1; // toward the side wall
      if (mtv.nx * wallDir > 0.5) continue; // predominantly wall-ward — let the wall win
      const contacts = robotCorners(r)
        .filter((c) => c.x > rect.x0 && c.x < rect.x1 && c.y > rect.y0 && c.y < rect.y1)
        .map((c) => ({ c, d: mtv.depth }));
      pushRobotAt(r, mtv.nx, mtv.ny, mtv.depth, contacts, contacts.length > 1);
    }
  }
}

// ------------------------------------------------------------ ball steps ----

export function stepGroundBall(b: Artifact, dt: number): void {
  b.pos.x += b.vel.x * dt;
  b.pos.y += b.vel.y * dt;
  const speed = hyp(b.vel.x, b.vel.y);
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
      const dist = gv; // perpendicular distance behind the face
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
    const dist = goalLineValue(out, a); // perpendicular distance behind the face
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
    const ol = hyp(ox, oy) || 1;
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
  const blocked = hyp(bx, by);
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
