import type { RobotCommand, World } from '../types';
import * as C from '../config';
import {
  collideBallBall,
  collideBallRect,
  collideBallRobot,
  collideBallStatic,
  squareUpRobots,
  stepFlightBall,
  stepGroundBall,
} from './physics';
import { solveRobots } from './physicsEngine';
import { classifierRect } from './field';
import { updateRobot, updateRobotActions } from './robot'; // Updated import
import { checkGoalEntry, updateBasins, updateGates, updateRails } from './goal';
import { updateHumanPlayers } from './humanPlayer';
import { robotsEnabled, stepMatch } from './match';
import { updateProvisionalPattern } from './scoring';
import { updatePenalties } from './penalties';
import { initializePathTraversal, updatePathTraversal } from './pathTraversal';

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

  const enabled = robotsEnabled(world);
  world.rrContacts.length = 0;

  // Create a map for the actual commands being executed by each robot this tick
  const actualCommands = new Map<number, RobotCommand>();

  for (const r of world.robots) {
    let currentCmd = enabled ? (commands.get(r.id) ?? ZERO_CMD) : ZERO_CMD;

    // Auto pathing logic: if active, override driver commands
    if (world.match.phase === 'auto' && r.autoPathActive) {
      // Use r.autoPath directly, which is already mirrored if necessary
      if (r.autoPath) {
        // Initialize auto path once at the very beginning of the auto phase
        if (world.match.phaseTimeLeft >= C.AUTO_DURATION - C.SIM_DT && r.pathSequenceIndex === 0 && r.pathSegmentProgress === 0 && r.pathWaitTimer === 0) {
          initializePathTraversal(r);
        }
        // Update robot's position and heading directly via path traversal
        // Capture the command returned by updatePathTraversal, which now includes intake/fire states.
        currentCmd = updatePathTraversal(r, world, dt);
        // Zero out velocity and angular velocity for path-following robots
        // so physics engine doesn't try to move them based on old velocities.
        r.vel = { x: 0, y: 0 };
        r.angVel = 0;
      } else {
        // If autoPathActive was true but no path data found in robot, deactivate
        r.autoPathActive = false;
      }
    }
    actualCommands.set(r.id, currentCmd);
  }

  // ---- robots (movement) -------------------------------------------------
  for (const r of world.robots) {
    // Only call updateRobot for robots NOT on an auto path.
    // Robots on auto path have their pos/heading set by updatePathTraversal
    // and their velocities zeroed out.
    if (!r.autoPathActive) {
      updateRobot(world, r, actualCommands.get(r.id) ?? ZERO_CMD, dt);
    }
  }

  // robot translation + velocity: resolved by Rapier (walls, goal faces,
  // classifier channels, mass-weighted robot-robot shoving, velocity-kill). The
  // bespoke square-up pass then rotates tilted chassis flush and records the
  // robot-robot contacts (rrContacts) the penalty engine consumes.
  // This will run for all robots. For autoPathActive robots, since their velocities
  // were zeroed, they should ideally not move much due to physics, unless pushed.
  const preVels = solveRobots(world, dt);
  squareUpRobots(world, preVels);

  // ---- robots (actions: intake/fire/turret) ------------------------------
  for (const r of world.robots) {
    updateRobotActions(world, r, actualCommands.get(r.id) ?? ZERO_CMD, dt);
  }

  // ---- penalties: rrContacts + final robot poses are settled for this tick -
  updatePenalties(world, dt, actualCommands);

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