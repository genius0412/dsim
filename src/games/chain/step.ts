import type { RobotCommand, World } from '../../types';
import * as C from '../../config';
import { solveRobots } from '../../sim/physicsEngine';
import { updateRobot } from '../../sim/robot';
import { robotsEnabled } from '../../sim/match';
import { chainColliders } from './colliders';
import { updateChain } from './play';

/**
 * Chain Reaction step — a playable match.
 *
 * Pipeline: resolve driver commands → drive (shared drivetrain/motor) → Rapier
 * position/velocity + wall containment → CR gameplay (`updateChain`: particles,
 * intake, shooter, accelerator scoring/recycle, catalysts, endgame) → phase/timer
 * machine. Deterministic (commands + `world.rngState` only), so client prediction /
 * server authority / replays hold. DELIBERATELY skips DECODE's updateRobotActions,
 * goals/gates, penalties, and DECODE scoring — CR owns all of that in `updateChain`.
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

  // CR gameplay (particles / shooter / scoring / catalysts / endgame)
  if (world.chain) updateChain(world, dt, actual, enabled);

  chainStepMatch(world, dt);
}

/**
 * The Chain Reaction phase/timer machine — 30 s auto, 120 s teleop (last 20 s = end
 * game), then post. Scoring is continuous in `updateChain`, so this only advances the
 * countdown + phase progression (no per-phase assessment).
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
