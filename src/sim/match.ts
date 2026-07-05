import type { World } from '../types';
import * as C from '../config';
import { assessEndOfAuto, assessMatchEnd } from './scoring';

/** begin the match (pre -> auto) */
export function startMatch(world: World): void {
  if (world.match.phase !== 'pre') return;
  world.match.phase = 'auto';
  world.match.phaseTimeLeft = C.AUTO_DURATION;
  world.events.push('AUTO');
}

export function stepMatch(world: World, dt: number): void {
  const m = world.match;
  if (m.phase === 'freeplay' || m.phase === 'pre' || m.phase === 'post') return;
  m.phaseTimeLeft -= dt;
  if (m.phaseTimeLeft > 0) return;
  switch (m.phase) {
    case 'auto':
      assessEndOfAuto(world);
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
      assessMatchEnd(world);
      world.events.push('MATCH COMPLETE');
      break;
  }
}

/** may the robots move right now? */
export function robotsEnabled(world: World): boolean {
  const p = world.match.phase;
  return p === 'auto' || p === 'teleop' || p === 'freeplay';
}
