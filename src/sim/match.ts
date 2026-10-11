import type { World } from '../types';
import * as C from '../config';
import { assessAutoPattern, assessLeave, assessMatchEnd } from './scoring';

/**
 * HAS A MATCH CLOCK RUN OUT? Within `C.PHASE_TIME_EPS` of zero counts as out.
 *
 * The clocks count down by subtracting `dt` (1/60) every tick, and 1/60 is not exact in binary:
 * after 1800 subtractions from 30 the remainder is +4e-13, not 0, so a plain `> 0` test gave
 * AUTO 1801 ticks, the transition 481 and DRIVER-CONTROLLED 7201 — every phase one tick long,
 * and the countdown the same. The accumulated error over a whole phase is ~1e-11, the tolerance
 * is 1e-6, and a tick is 1.7e-2, so this ends each phase on exactly `duration × 60` ticks.
 * Every game's phase machine reads it (DECODE here, Chain Reaction and BIOBUZZ in their own
 * `step.ts`).
 */
export function clockExpired(left: number): boolean {
  return left <= C.PHASE_TIME_EPS;
}

/** is this an AUTO-ONLY run (`World.runLength`)? AUTO ends the match: AUTO → post, no transition. */
export function autoOnly(world: { runLength?: 'auto' }): boolean {
  return world.runLength === 'auto';
}

/** begin the match (pre -> auto) */
export function startMatch(world: World): void {
  if (world.match.phase !== 'pre') return;
  world.match.phase = 'auto';
  world.match.phaseTimeLeft = C.AUTO_DURATION;
  world.events.push('AUTO');
}

export function stepMatch(world: World, dt: number): void {
  const m = world.match;
  // sim-driven pre-match countdown (multiplayer): transition pre→auto here,
  // inside step(), so it lands on the same tick for every lockstep peer
  if (m.phase === 'pre') {
    if (m.preCountdown == null) return; // solo: the controller starts the match
    m.preCountdown -= dt;
    if (clockExpired(m.preCountdown)) {
      m.preCountdown = undefined;
      m.phase = 'auto';
      m.phaseTimeLeft = C.AUTO_DURATION;
      world.events.push('AUTO');
    }
    return;
  }
  if (m.phase === 'freeplay') return;
  // Rules C/D/F: TELEOP PATTERN, DEPOT and BASE are assessed once all robots and
  // artifacts have come to rest after the MATCH. The sim keeps stepping through the
  // post-match settle window (solo controller + server), so recompute the (idempotent)
  // resting-position scores every tick rather than snapshotting on the buzzer tick —
  // a ball still draining the ramp or a depot ball still rolling is folded in as it
  // stops, and the value naturally locks once motion ceases.
  if (m.phase === 'post') {
    if (autoOnly(world)) assessAutoPattern(world); // only the AUTO lines exist; no BASE / DEPOT / TELEOP PATTERN
    else assessMatchEnd(world);
    return;
  }
  m.phaseTimeLeft -= dt;
  // Rule B: AUTO PATTERN is assessed when artifacts come to rest after AUTO or at
  // TELEOP start, whichever first — track the settling classifier stack every
  // transition tick; the final value is locked when TELEOP begins (below).
  if (m.phase === 'transition') assessAutoPattern(world);
  if (!clockExpired(m.phaseTimeLeft)) return;
  switch (m.phase) {
    case 'auto':
      assessLeave(world); // Rule E: LEAVE assessed at the end of AUTO
      assessAutoPattern(world); // seed; refreshed each transition tick
      for (const r of world.robots) { r.autoPathActive = false; }
      if (autoOnly(world)) {
        // AUTO-ONLY: straight to post. The settle is the post window (`post` keeps assessing AUTO PATTERN)
        m.phase = 'post';
        m.phaseTimeLeft = 0;
        world.events.push('AUTO COMPLETE', 'MATCH COMPLETE');
        break;
      }
      m.phase = 'transition';
      m.phaseTimeLeft = C.TRANSITION_DURATION;
      world.events.push('AUTO COMPLETE');
      break;
    case 'transition':
      assessAutoPattern(world); // Rule B: lock the final AUTO PATTERN at TELEOP start
      for (const a of ['red', 'blue'] as const) {
        const pts = world.match.scores[a].autoPattern;
        if (pts > 0 && world.robots.some((r) => r.alliance === a)) {
          world.events.push(`AUTO PATTERN +${pts}`);
        }
      }
      m.phase = 'teleop';
      m.phaseTimeLeft = C.TELEOP_DURATION;
      world.events.push('DRIVER-CONTROLLED');
      break;
    case 'teleop':
      m.phase = 'post';
      m.phaseTimeLeft = 0;
      assessMatchEnd(world); // Rules C/D/F: initial; refreshed each post tick
      world.events.push('MATCH COMPLETE');
      break;
  }
}

/** may the robots move right now? */
export function robotsEnabled(world: World): boolean {
  const p = world.match.phase;
  return p === 'auto' || p === 'teleop' || p === 'freeplay';
}
