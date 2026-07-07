import type { RobotCommand, World } from '../types';
import * as C from '../config';
import {
  clampGroundBall,
  collideBallBall,
  collideBallRect,
  collideBallRobot,
  collideBallStatic,
  squareUpRobots,
  stepFlightBall,
  stepGroundBall,
} from './physics';
import { solveBalls, solveRobots } from './physicsEngine';
import { classifierRect } from './field';
import { updateIntake, updateRobot } from './robot';
import { checkGoalEntry, updateBasins, updateGates, updateRails } from './goal';
import { updateHumanPlayers } from './humanPlayer';
import { robotsEnabled, stepMatch } from './match';
import { updateProvisionalPattern } from './scoring';
import { updatePenalties } from './penalties';

const ZERO_CMD: RobotCommand = {
  driveX: 0,
  driveY: 0,
  rotate: 0,
  intake: false,
  fire: false,
};

/** advance the world by one fixed timestep. Deterministic: consumes only the
 * given commands and the world's own seeded PRNG. */
export function step(world: World, dt: number, commands: Map<number, RobotCommand>): void {
  world.time += dt;
  world.tick++;

  // ---- robots ------------------------------------------------------------
  const enabled = robotsEnabled(world);
  world.rrContacts.length = 0;
  for (const r of world.robots) {
    const cmd = enabled ? (commands.get(r.id) ?? ZERO_CMD) : ZERO_CMD;
    updateRobot(world, r, cmd, dt);
  }
  // robot translation + velocity: resolved by Rapier (walls, goal faces,
  // classifier channels, mass-weighted robot-robot shoving, velocity-kill). The
  // bespoke square-up pass then rotates tilted chassis flush and records the
  // robot-robot contacts (rrContacts) the penalty engine consumes.
  const preVels = solveRobots(world, dt);
  squareUpRobots(world, preVels);
  for (const r of world.robots) {
    const cmd = enabled ? (commands.get(r.id) ?? ZERO_CMD) : ZERO_CMD;
    updateIntake(world, r, cmd);
  }
  // ---- penalties: rrContacts + final robot poses are settled for this tick -
  updatePenalties(world, dt, commands);

  // ---- balls ---------------------------------------------------------------
  // GROUND balls: rolling friction (velocity only) → Rapier solve (ball↔ball,
  // ball↔wall, ball↔goal-face, ball↔classifier) → bespoke ball↔robot (pin
  // feedback / outflow-no-shove, kept scripted for feel) → hard field clamp.
  for (const b of world.balls) {
    if (b.state.kind === 'ground') stepGroundBall(b, dt);
  }
  solveBalls(world, dt);
  // ball↔robot stays bespoke (see solveRobots): the pin stall + outflow-no-shove
  // are deliberately non-physical. Iterated so a robot→ball→(wall/ball) chain
  // converges instead of tunnelling in a single pass.
  for (let pass = 0; pass < C.BALL_SOLVER_ITERATIONS; pass++) {
    for (const b of world.balls) {
      if (b.state.kind !== 'ground') continue;
      for (const r of world.robots) collideBallRobot(b, r);
    }
  }
  // hard field clamp: Rapier's soft contacts (and the bespoke ball↔robot push)
  // can leave a ~0.2in penetration, so snap ground balls back inside the walls /
  // goal faces (containment is tolerance-tight).
  for (const b of world.balls) {
    if (b.state.kind === 'ground') clampGroundBall(b);
  }

  // ---- balls: FLIGHT (ground balls resolved above) -------------------------
  // Flight stays bespoke: ballistic arc + z axis (Rapier 2D has no z), goal-face
  // bounce below the lip, and the ground-bounce landing transition. A ball that
  // lands becomes 'ground' and joins the ground solve next tick.
  for (const b of world.balls) {
    if (b.state.kind !== 'flight') continue;
    const prevZ = b.z;
    stepFlightBall(b, dt);
    if (checkGoalEntry(world, b, prevZ)) continue;
    if (b.z < C.GOAL_WALL_TOP) collideBallStatic(b);
    if (b.z <= 0 && b.vz < 0) {
      b.z = 0;
      b.vz = -b.vz * C.BALL_GROUND_RESTITUTION;
      b.vel.x *= C.BALL_BOUNCE_H_RETAIN;
      b.vel.y *= C.BALL_BOUNCE_H_RETAIN;
      if (b.vz < 20) {
        b.vz = 0;
        b.state = { kind: 'ground' };
      }
    }
  }

  // low flight balls collide bespoke with robots + other low flight balls (rare
  // — the shooter never misses, so a shot is almost never near a robot in the
  // plane). Ground balls are Rapier bodies and handled there; a flight↔ground
  // cross-collision is the accepted deferral of the ground-only slice.
  const activeFlight = world.balls.filter(
    (b) => b.state.kind === 'flight' && b.z < C.BALL_RADIUS * 4,
  );
  for (let pass = 0; pass < C.BALL_SOLVER_ITERATIONS; pass++) {
    for (let i = 0; i < activeFlight.length; i++) {
      for (let j = i + 1; j < activeFlight.length; j++) {
        collideBallBall(activeFlight[i], activeFlight[j]);
      }
    }
    for (const b of activeFlight) {
      if (b.z > 14) continue;
      for (const r of world.robots) collideBallRobot(b, r);
    }
  }
  for (const b of activeFlight) {
    if (b.z > 16) continue;
    collideBallRect(b, classifierRect('red'));
    collideBallRect(b, classifierRect('blue'));
  }
  for (const b of activeFlight) collideBallStatic(b);

  // ---- goals: basin jumble, rail flow, gate ---------------------------------
  updateGates(world, dt);
  updateBasins(world, dt);
  updateRails(world, dt);
  updateHumanPlayers(world);

  // ---- match flow ----------------------------------------------------------
  stepMatch(world, dt);
  updateProvisionalPattern(world);
}
