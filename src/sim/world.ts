import type { RobotCommand, World } from '../types';
import * as C from '../config';
import {
  collideBallBall,
  collideBallRect,
  collideBallRobot,
  collideBallStatic,
  constrainRobot,
  stepFlightBall,
  stepGroundBall,
} from './physics';
import { classifierRect } from './field';
import { updateIntake, updateRobot } from './robot';
import { checkGoalEntry, updateBasins, updateGates, updateRails } from './goal';
import { updateHumanPlayers } from './humanPlayer';
import { robotsEnabled, stepMatch } from './match';
import { updateProvisionalPattern } from './scoring';

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
  for (const r of world.robots) {
    const cmd = enabled ? (commands.get(r.id) ?? ZERO_CMD) : ZERO_CMD;
    updateRobot(world, r, cmd, dt);
    constrainRobot(r);
    updateIntake(world, r, cmd);
  }

  // ---- balls ---------------------------------------------------------------
  for (const b of world.balls) {
    if (b.state.kind === 'ground') {
      stepGroundBall(b, dt);
      collideBallStatic(b);
    } else if (b.state.kind === 'flight') {
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
  }

  // ball-ball then ball-robot, iterated so pushes propagate through chains
  // (robot -> ball -> wall-pinned ball) instead of tunnelling in one pass
  const active = world.balls.filter(
    (b) => (b.state.kind === 'ground' || b.state.kind === 'flight') && b.z < C.BALL_RADIUS * 4,
  );
  for (let pass = 0; pass < C.BALL_SOLVER_ITERATIONS; pass++) {
    // ball-ball collisions (grounded / low balls only)
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        collideBallBall(active[i], active[j]);
      }
    }
    // ball-robot collisions (skip airborne balls above the robot)
    for (const b of active) {
      if (b.z > 14) continue;
      for (const r of world.robots) collideBallRobot(b, r);
    }
  }

  // stray balls never enter the classifier structures (balls emerging from
  // the gate exit below the channel and roll away)
  for (const b of active) {
    if (b.z > 16) continue;
    collideBallRect(b, classifierRect('red'));
    collideBallRect(b, classifierRect('blue'));
  }

  // final authority: robot/structure pushes can never leave a ball outside
  // the field — re-run the wall constraint after all other collisions
  for (const b of active) collideBallStatic(b);

  // ---- goals: basin jumble, rail flow, gate ---------------------------------
  updateGates(world, dt);
  updateBasins(world, dt);
  updateRails(world, dt);
  updateHumanPlayers(world);

  // ---- match flow ----------------------------------------------------------
  stepMatch(world, dt);
  updateProvisionalPattern(world);
}
