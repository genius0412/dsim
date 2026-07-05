import type { Artifact, RobotCommand, RobotState, World } from '../types';
import * as C from '../config';
import { approach, rot, wrapAngle } from '../math';
import { goalCenter, inLaunchZone, viewAngleOf } from './field';
import { robotCorners } from './physics';
import { robotsEnabled } from './match';

/** launch is legal when ANY part of the robot is inside a launch zone */
export function robotInLaunchZone(r: RobotState): boolean {
  if (inLaunchZone(r.pos, r.alliance)) return true;
  return robotCorners(r).some((c) => inLaunchZone(c, r.alliance));
}

export function turretWorldPos(r: RobotState): { x: number; y: number } {
  const o = rot({ x: C.TURRET_OFFSET, y: 0 }, r.heading);
  return { x: r.pos.x + o.x, y: r.pos.y + o.y };
}

/** exact ballistic solution through the goal opening. The hood angle
 * steepens at close range so a solution exists at every distance. */
function solveShot(d: number): { speed: number; angle: number } {
  const dh = C.GOAL_OPENING_Z - C.LAUNCH_HEIGHT;
  const lineOfSight = Math.atan2(dh, Math.max(d, 0.5));
  const angle = Math.min(
    Math.max(C.LAUNCH_ANGLE, lineOfSight + C.LAUNCH_ANGLE_MARGIN),
    C.LAUNCH_ANGLE_MAX,
  );
  const cos = Math.cos(angle);
  const denom = 2 * cos * cos * (d * Math.tan(angle) - dh);
  const speed =
    denom > 0
      ? Math.min(Math.sqrt((C.GRAVITY * d * d) / denom), C.LAUNCH_MAX_SPEED)
      : C.LAUNCH_MAX_SPEED * 0.3;
  return { speed, angle };
}

/** aim solution that lead-compensates the chassis velocity the ball will
 * inherit, so shooting on the move stays accurate */
export function aimSolution(r: RobotState): { yaw: number; speed: number; angle: number } {
  const tp = turretWorldPos(r);
  const g = goalCenter(r.alliance);
  const wv = { x: r.vel.x * C.SHOT_ROBOT_VEL_INHERIT, y: r.vel.y * C.SHOT_ROBOT_VEL_INHERIT };
  let dx = g.x - tp.x;
  let dy = g.y - tp.y;
  let sol = solveShot(Math.hypot(dx, dy));
  for (let i = 0; i < 3; i++) {
    const t = Math.hypot(dx, dy) / Math.max(sol.speed * Math.cos(sol.angle), 1);
    dx = g.x - tp.x - wv.x * t;
    dy = g.y - tp.y - wv.y * t;
    sol = solveShot(Math.hypot(dx, dy));
  }
  return { yaw: Math.atan2(dy, dx), speed: sol.speed, angle: sol.angle };
}

export function updateRobot(world: World, r: RobotState, cmd: RobotCommand, dt: number): void {
  // ---- drive: driver frame -> robot frame -------------------------------
  const viewAngle = viewAngleOf(r.alliance);
  // driver stick vector: +y = away from driver (screen up), +x = driver right.
  // screen -> world undoes the camera rotation
  const stick = { x: cmd.driveX, y: cmd.driveY };
  let robotVec: { x: number; y: number };
  if (r.fieldCentric) {
    const fieldVec = rot(stick, -viewAngle);
    robotVec = rot(fieldVec, -r.heading);
  } else {
    // robot-centric: stick up = robot forward (+x robot), stick right = strafe right (-y robot)
    robotVec = { x: stick.y, y: -stick.x };
  }
  // mecanum power budget: combined demands share the same wheels
  const demand = Math.abs(robotVec.x) + Math.abs(robotVec.y) + Math.abs(cmd.rotate);
  const div = Math.max(1, demand);
  const targetFwd = (robotVec.x / div) * C.DRIVE_MAX_SPEED;
  const targetStrafe = (robotVec.y / div) * C.DRIVE_MAX_SPEED * C.STRAFE_MULT;
  const targetOmega = (cmd.rotate / div) * C.TURN_MAX_SPEED;

  // accel-clamped approach in the robot frame
  const velRobot = rot(r.vel, -r.heading);
  velRobot.x = approach(velRobot.x, targetFwd, C.DRIVE_ACCEL * dt);
  velRobot.y = approach(velRobot.y, targetStrafe, C.DRIVE_ACCEL * dt);
  r.vel = rot(velRobot, r.heading);
  r.angVel = approach(r.angVel, targetOmega, C.TURN_ACCEL * dt);

  r.pos.x += r.vel.x * dt;
  r.pos.y += r.vel.y * dt;
  r.heading = wrapAngle(r.heading + r.angVel * dt);

  // ---- turret: aim assist tracks the firing solution exactly -------------
  if (r.aimAssist) {
    r.turretHeading = aimSolution(r).yaw;
  }

  // ---- fire: no spin-up model — cadence-limited only ---------------------
  if (
    robotsEnabled(world) && // no firing before AUTO starts / between periods
    r.hopper.length > 0 &&
    world.time - r.lastFireAt >= C.MIN_FIRE_INTERVAL
  ) {
    // any part of the robot inside a launch zone is enough; refusals are
    // shown by the HUD launch-zone indicator, not popups
    const zoneOk = world.mode === 'free' || robotInLaunchZone(r);
    if (zoneOk && (cmd.fire || r.autoFire)) fire(world, r);
  }
}

function fire(world: World, r: RobotState): void {
  const color = r.hopper.shift()!;
  r.lastFireAt = world.time;

  const tp = turretWorldPos(r);
  // exact solution, no dispersion — the shooter never misses. The ball
  // leaves along the turret's CURRENT heading (aim assist keeps it on the
  // lead-compensated solution).
  const { speed, angle } = aimSolution(r);
  const yaw = r.turretHeading;
  const cos = Math.cos(angle);

  const ball: Artifact = {
    id: world.balls.reduce((m, b) => Math.max(m, b.id), 0) + 1,
    color,
    state: { kind: 'flight', target: r.alliance },
    pos: { x: tp.x, y: tp.y },
    vel: {
      x: Math.cos(yaw) * speed * cos + r.vel.x * C.SHOT_ROBOT_VEL_INHERIT,
      y: Math.sin(yaw) * speed * cos + r.vel.y * C.SHOT_ROBOT_VEL_INHERIT,
    },
    z: C.LAUNCH_HEIGHT,
    vz: speed * Math.sin(angle),
  };
  world.balls.push(ball);
}

/** capture ground balls touching the intake region into the hopper */
export function updateIntake(world: World, r: RobotState, cmd: RobotCommand): void {
  if (!robotsEnabled(world)) return;
  const running = cmd.intake || r.autoIntake;
  if (!running || r.hopper.length >= C.HOPPER_CAPACITY) return;
  const preset = C.INTAKE_PRESETS[r.spec.intake];
  if (world.time - r.lastIntakeAt < preset.perBall) return;
  const hl = r.spec.length / 2;
  for (const b of world.balls) {
    if (b.state.kind !== 'ground' || b.z > 6) continue;
    // ball position in robot frame; capture extends slightly past the intake
    // face so balls being pushed by it get swallowed
    const local = rot({ x: b.pos.x - r.pos.x, y: b.pos.y - r.pos.y }, -r.heading);
    const inReach = local.x > hl - 2 && local.x < hl + preset.reach + C.BALL_RADIUS + 1;
    const inWidth = Math.abs(local.y) < preset.halfWidth + C.BALL_RADIUS * 0.5;
    if (inReach && inWidth) {
      r.hopper.push(b.color);
      r.lastIntakeAt = world.time;
      world.balls.splice(world.balls.indexOf(b), 1);
      break;
    }
  }
}
