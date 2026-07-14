import type { RobotCommand, World } from '../../types';
import * as C from '../../config';
import { solveRobots } from '../../sim/physicsEngine';
import { updateRobot } from '../../sim/robot';
import { robotsEnabled } from '../../sim/match';
import { chainColliders } from './colliders';

/**
 * Chain Reaction step — the "empty field shell" pipeline.
 *
 * Robots + collisions ONLY: drive (shared drivetrain/motor + power model via
 * `updateRobot`) then Rapier position/velocity + wall containment (`solveRobots`),
 * then the phase/timer machine. DELIBERATELY skips DECODE's `updateRobotActions`
 * (intake/fire/turret), balls, goals/gates, penalties, scoring, and the bespoke
 * square-up (which is coupled to DECODE goal/classifier geometry). When Chain
 * Reaction's rules land, this grows the game's own stages.
 *
 * Deterministic: consumes only the given commands + the world's own state, exactly
 * like DECODE's `step`, so client prediction / server authority / replays hold.
 */

const ZERO_CMD: RobotCommand = {
  driveX: 0,
  driveY: 0,
  rotate: 0,
  leftDrive: 0,
  rightDrive: 0,
  intake: false,
  fire: false,
};

export function chainStep(world: World, dt: number, commands: Map<number, RobotCommand>): void {
  world.time += dt;
  world.tick++;
  world.rrContacts.length = 0;

  const enabled = robotsEnabled(world);
  const actual = new Map<number, RobotCommand>();
  for (const r of world.robots) {
    const cmd = enabled ? (commands.get(r.id) ?? ZERO_CMD) : ZERO_CMD;
    actual.set(r.id, cmd);
    updateRobot(world, r, cmd, dt);
  }

  // Rapier owns robot translation/velocity + wall containment on the CR field.
  solveRobots(world, dt, chainColliders);

  chainStepMatch(world, dt);
}

/**
 * The Chain Reaction phase/timer machine — mirrors `sim/match.ts` `stepMatch`
 * MINUS every DECODE scoring assessment (`assessLeave`/`assessAutoPattern`/
 * `assessMatchEnd`), because the shell has no scoring. Advances the countdown and
 * the auto→transition→teleop→post progression so timers/HUD/audio behave.
 */
function chainStepMatch(world: World, dt: number): void {
  const m = world.match;
  if (m.phase === 'pre') {
    if (m.preCountdown == null) return; // solo: the controller starts the match
    m.preCountdown -= dt;
    if (m.preCountdown <= 0) {
      m.preCountdown = undefined;
      m.phase = 'auto';
      m.phaseTimeLeft = C.AUTO_DURATION;
      world.events.push('AUTO');
    }
    return;
  }
  if (m.phase === 'freeplay' || m.phase === 'post') return;
  m.phaseTimeLeft -= dt;
  if (m.phaseTimeLeft > 0) return;
  switch (m.phase) {
    case 'auto':
      for (const r of world.robots) r.autoPathActive = false;
      m.phase = 'transition';
      m.phaseTimeLeft = C.TRANSITION_DURATION;
      world.events.push('AUTO COMPLETE');
      break;
    case 'transition':
      m.phase = 'teleop';
      m.phaseTimeLeft = C.TELEOP_DURATION;
      world.events.push('TELEOP');
      break;
    case 'teleop':
      m.phase = 'post';
      m.phaseTimeLeft = 0;
      world.events.push('MATCH COMPLETE');
      break;
  }
}
