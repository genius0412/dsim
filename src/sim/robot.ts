import type { Artifact, ArtifactColor, RobotCommand, RobotState, World } from '../types';
import * as C from '../config';
import { approach, rot, wrapAngle, hyp, dsin, dcos, dtan, datan2 } from '../math';
import { classifierRect, goalCenter, inLaunchZone, viewAngleOf } from './field';
import { driveParams } from './drivetrain';
import { robotCorners } from './physics';
import { robotsEnabled } from './match';

/** launch is legal when ANY part of the robot is inside a launch zone */
export function robotInLaunchZone(r: RobotState): boolean {
  if (inLaunchZone(r.pos, r.alliance)) return true;
  return robotCorners(r).some((c) => inLaunchZone(c, r.alliance));
}

export function turretWorldPos(r: RobotState): { x: number; y: number } {
  const o = rot({ x: r.spec.length * C.TURRET_OFFSET_FRAC, y: 0 }, r.heading);
  return { x: r.pos.x + o.x, y: r.pos.y + o.y };
}

/** exact ballistic solution through the goal opening. The hood angle
 * steepens at close range so a solution exists at every distance. */
function solveShot(d: number): { speed: number; angle: number } {
  const dh = C.GOAL_OPENING_Z - C.LAUNCH_HEIGHT;
  const lineOfSight = datan2(dh, Math.max(d, 0.5));
  const angle = Math.min(
    Math.max(C.LAUNCH_ANGLE, lineOfSight + C.LAUNCH_ANGLE_MARGIN),
    C.LAUNCH_ANGLE_MAX,
  );
  const cos = dcos(angle);
  const denom = 2 * cos * cos * (d * dtan(angle) - dh);
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
  let sol = solveShot(hyp(dx, dy));
  for (let i = 0; i < 3; i++) {
    const t = hyp(dx, dy) / Math.max(sol.speed * dcos(sol.angle), 1);
    dx = g.x - tp.x - wv.x * t;
    dy = g.y - tp.y - wv.y * t;
    sol = solveShot(hyp(dx, dy));
  }
  return { yaw: datan2(dy, dx), speed: sol.speed, angle: sol.angle };
}

export function updateRobot(world: World, r: RobotState, cmd: RobotCommand, dt: number): void {
  // ---- drive: driver frame -> robot frame -------------------------------
  const dp = driveParams(r.spec);
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
  if (dp.strafeMult === 0) robotVec.y = 0; // tank: strafe input is dead
  // wheel power budget: combined demands share the same wheels, and the
  // shape of the budget depends on the drivetrain (see DRIVETRAIN_PRESETS)
  const demand =
    dp.saturation === 'vec'
      ? hyp(robotVec.x, robotVec.y) + Math.abs(cmd.rotate)
      : Math.abs(robotVec.x) + Math.abs(robotVec.y) + Math.abs(cmd.rotate);
  const div = Math.max(1, demand);
  const targetFwd = (robotVec.x / div) * dp.maxSpeed;
  const targetStrafe = (robotVec.y / div) * dp.maxSpeed * dp.strafeMult;
  const targetOmega = (cmd.rotate / div) * dp.maxTurn;

  // accel-clamped approach in the robot frame
  const velRobot = rot(r.vel, -r.heading);
  velRobot.x = approach(velRobot.x, targetFwd, dp.accel * dt);
  velRobot.y = approach(velRobot.y, targetStrafe, dp.accel * dt);
  r.vel = rot(velRobot, r.heading);
  r.angVel = approach(r.angVel, targetOmega, dp.turnAccel * dt);

  // Swerve wobble: occasional slight heading jumps when moving forward
  if (dp.saturation === 'vec') {
    const fwdSpeed = rot(r.vel, -r.heading).x;
    const speedRatio = fwdSpeed / dp.maxSpeed;
    const phase = r.id * 1.23;
    const freq = Math.PI; // 0.5 Hz
    const now = Math.sin((world.time + phase) * freq);
    const prev = Math.sin((world.time - dt + phase) * freq);
    if (now > 0.99 && prev <= 0.99) {
      const sign = Math.sin((world.time + phase) * 47 * Math.PI) > 0 ? 1 : -1;
      r.heading += sign * 0.04 * speedRatio;
    }
  }

  // Rapier (solveRobots) integrates POSITION from r.vel and resolves collisions
  // this same tick; heading is integrated here (rotation is locked in Rapier and
  // the bespoke square-up nudge owns it).
  r.heading = wrapAngle(r.heading + r.angVel * dt);

  // ---- turret: aim assist tracks the firing solution exactly -------------
  if (r.aimAssist) {
    r.turretHeading = aimSolution(r).yaw;
  }

  // ---- fire: no spin-up before the FIRST shot; between shots the cadence
  // is the intake transfer interval plus flywheel recovery after energetic
  // (long-range) shots — see fireReadyAt set in fire() -----------------------
  if (
    robotsEnabled(world) && // no firing before AUTO starts / between periods
    r.hopper.length > 0 &&
    world.time >= r.fireReadyAt
  ) {
    // any part of the robot inside a launch zone is enough; refusals are
    // shown by the HUD launch-zone indicator, not popups
    const zoneOk = world.mode === 'free' || robotInLaunchZone(r);
    if (zoneOk && (cmd.fire || r.autoFire)) fire(world, r);
  }
}

function fire(world: World, r: RobotState): void {
  // canSort: pick the hopper color that fills the next unfilled motif slot
  // on this alliance's ramp; everyone else fires FIFO
  let color: ArtifactColor;
  if (r.spec.canSort) {
    const retained = world.balls.filter(
      (b) =>
        b.state.kind === 'rail' &&
        b.state.goal === r.alliance &&
        !b.state.overflow &&
        !b.state.pending,
    ).length;
    const want = world.motif[retained % 3];
    const idx = r.hopper.indexOf(want);
    color = idx >= 0 ? r.hopper.splice(idx, 1)[0] : r.hopper.shift()!;
  } else {
    color = r.hopper.shift()!;
  }
  r.lastFireAt = world.time;

  const tp = turretWorldPos(r);
  // exact solution, no dispersion — the shooter never misses. The ball
  // leaves along the turret's CURRENT heading (aim assist keeps it on the
  // lead-compensated solution).
  const { speed, angle } = aimSolution(r);
  const yaw = r.turretHeading;
  const cos = dcos(angle);

  // flywheel recovery: an energetic shot drains the wheel; a LOW-inertia
  // flywheel needs extra time to spin back up before the next shot. Close
  // shots (below FLYWHEEL_CLOSE_SPEED) recover within the transfer cadence.
  const shotNorm = Math.max(
    0,
    Math.min(1, (speed - C.FLYWHEEL_CLOSE_SPEED) / (C.LAUNCH_MAX_SPEED - C.FLYWHEEL_CLOSE_SPEED)),
  );
  const recovery = C.FLYWHEEL_RECOVERY_MAX * shotNorm * shotNorm * (1 - r.spec.flywheelInertia);
  const sortPenalty = r.spec.canSort ? C.SORT_FIRE_PENALTY : 0;
  r.fireReadyAt = world.time + C.INTAKE_PRESETS[r.spec.intake].fireInterval + recovery + sortPenalty;

  const ball: Artifact = {
    id: world.balls.reduce((m, b) => Math.max(m, b.id), 0) + 1,
    color,
    state: { kind: 'flight', target: r.alliance },
    pos: { x: tp.x, y: tp.y },
    vel: {
      x: dcos(yaw) * speed * cos + r.vel.x * C.SHOT_ROBOT_VEL_INHERIT,
      y: dsin(yaw) * speed * cos + r.vel.y * C.SHOT_ROBOT_VEL_INHERIT,
    },
    z: C.LAUNCH_HEIGHT,
    vz: speed * dsin(angle),
  };
  world.balls.push(ball);
}

/** capture ground balls at the intake mouth into the hopper.
 * Capture happens when a compliant wheel is DIRECTLY ABOVE the artifact: the
 * wheel line sits at the tip of the intake's reach, and a ball within its
 * band gets swallowed (a pushed ball rides at wheelLine + BALL_RADIUS —
 * inside the band). Side intake is ruled out GEOMETRICALLY, not by a flag:
 * unless the preset's wheels overhang the chassis (vector), the mouth is
 * clamped inside the frame and the chassis flanks encompass the intake. */
export function updateIntake(world: World, r: RobotState, cmd: RobotCommand): void {
  if (!robotsEnabled(world)) return;
  const running = cmd.intake || r.autoIntake;
  if (!running || r.hopper.length >= C.HOPPER_CAPACITY) return;
  const preset = C.INTAKE_PRESETS[r.spec.intake];
  const hl = r.spec.length / 2;
  const mouthHalf = preset.overhang
    ? preset.halfWidth
    : Math.min(preset.halfWidth, r.spec.width / 2 - 0.75);
  const wheelLine = hl + preset.reach;
  const velRobot = rot(r.vel, -r.heading);

  // the intake can't reach INTO the classifier: if the mouth is at/inside a
  // classifier structure (e.g. the robot pressed parallel against it), no
  // capture — you can't vacuum balls through the ramp wall
  const mouthX = r.pos.x + dcos(r.heading) * wheelLine;
  const mouthY = r.pos.y + dsin(r.heading) * wheelLine;
  for (const a of ['red', 'blue'] as const) {
    const rect = classifierRect(a);
    if (
      mouthX > rect.x0 - 0.5 &&
      mouthX < rect.x1 + 0.5 &&
      mouthY > rect.y0 &&
      mouthY < rect.y1
    ) {
      return;
    }
  }

  // every ball currently at the mouth (or under an overhanging wheel)
  const candidates: Artifact[] = [];
  for (const b of world.balls) {
    if (b.state.kind !== 'ground' || b.z > 6) continue;
    const local = rot({ x: b.pos.x - r.pos.x, y: b.pos.y - r.pos.y }, -r.heading);
    const inReach = Math.abs(local.x - wheelLine) < C.BALL_RADIUS + C.INTAKE_CAPTURE_BAND;
    const inWidth = Math.abs(local.y) < mouthHalf + C.BALL_RADIUS * 0.25;
    // flank capture: only where the wheel span actually OVERHANGS the chassis
    // can a ball the robot strafes into end up under a wheel. Compare spans
    // directly (not penetration depth — the robot moves before the ball's
    // collision pass each tick, so a depth test sees a phantom overlap)
    const sideTouch =
      mouthHalf > r.spec.width / 2 + 0.5 &&
      local.x > hl - 2 &&
      local.x < wheelLine + C.BALL_RADIUS &&
      Math.abs(local.y) > r.spec.width / 2 - 0.5 &&
      Math.abs(local.y) < r.spec.width / 2 + C.BALL_RADIUS + 0.6 &&
      velRobot.y * Math.sign(local.y) > C.INTAKE_SIDE_MIN_STRAFE;
    if ((inReach && inWidth) || sideTouch) candidates.push(b);
  }
  if (candidates.length === 0) return;

  // a clump feeding the mouth swallows continuously — sloped and triangle
  // are extremely efficient at eating clumps; vector keeps its steady pace
  const interval = candidates.length >= 2 ? preset.clumpPerBall : preset.perBall;
  if (world.time - r.lastIntakeAt < interval) return;
  const b = candidates[0];
  r.hopper.push(b.color);
  r.lastIntakeAt = world.time;
  world.balls.splice(world.balls.indexOf(b), 1);
}
