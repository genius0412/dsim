import * as C from '../config';
import type { World } from '../types';

/**
 * THE SNAPSHOT'S CLOCKS, PUT BACK TO THE SERVER'S EXACT VALUES.
 *
 * The server rounds every non-integer on the wire to 3 decimals (`round3`, `server/wire.ts`). The
 * sim compares clocks every tick — `world.time >= r.fireReadyAt`, a countdown reaching 0 — so a
 * client stepping on from rounded clocks can decide a shot, or the start of AUTO, a tick away from
 * where the room decides it, and the same shot comes out at a slightly different `world.time`.
 * Once the client ran a round trip ahead (`leadControl.ts`), every snapshot in that window
 * re-decided the shot: measured through a real `Room` at 66 ms, each shot was cued 1.7–2.2 times
 * (owner: "spams the shooting sound a ton"), and a predicted shot left a tick early and jumped back.
 *
 * These clocks are rebuilt the way the sim builds them, so they come back bit for bit:
 * `world.time` adds `SIM_DT` once per tick from 0; `lastFireAt` and `lastIntakeAt` are
 * `world.time` at some tick; `preCountdown` and `phaseTimeLeft` subtract `SIM_DT` once per tick
 * from a known start. A value further from its rebuilt one than the rounding could have moved it
 * is left alone, so a clock set any other way is never touched. `fireReadyAt` is `time + interval`
 * for arbitrary intervals and cannot be rebuilt; it stays rounded (a rare one-tick flip remains).
 */

/** 3-decimal rounding moves a value at most 0.0005; the rest is headroom */
const WIRE_TOL = 0.0006;
/** an hour of ticks. A snapshot can come from another player's browser on LAN, so a tick is
 *  untrusted and must not size the cache below; no match is a fraction of this long. */
const MAX_TICK = 60 * 60 * 60;

const times: number[] = [0];
/** `world.time` at tick `n` (0..MAX_TICK), exactly as the sim accumulated it */
export function timeAtTick(n: number): number {
  while (times.length <= n) times.push(times[times.length - 1] + C.SIM_DT);
  return times[n];
}

const countdowns = new Map<number, number[]>();
/** a clock that started at `start` after `k` ticks of `-= SIM_DT` */
function countdownAt(start: number, k: number): number {
  let seq = countdowns.get(start);
  if (!seq) countdowns.set(start, (seq = [start]));
  while (seq.length <= k) seq.push(seq[seq.length - 1] - C.SIM_DT);
  return seq[k];
}

/** `v` is `world.time` at some tick no later than `now` */
function onTickGrid(v: number, now: number): number {
  if (!(v > 0)) return v; // the -10 spawn sentinel, and anything not a clock reading
  const n = Math.round(v / C.SIM_DT);
  if (n > now) return v;
  const t = timeAtTick(n);
  return Math.abs(t - v) <= WIRE_TOL ? t : v;
}

function fromStart(start: number, v: number): number {
  const k = Math.round((start - v) / C.SIM_DT);
  if (k < 0 || k > Math.ceil(start / C.SIM_DT) + 1) return v;
  const t = countdownAt(start, k);
  return Math.abs(t - v) <= WIRE_TOL ? t : v;
}

const PHASE_START: Partial<Record<World['match']['phase'], number>> = {
  auto: C.AUTO_DURATION,
  transition: C.TRANSITION_DURATION,
  teleop: C.TELEOP_DURATION,
};

/** undo the wire's rounding on `w`'s clocks, in place (see the header) */
export function restoreWireClocks(w: World): void {
  if (!Number.isSafeInteger(w.tick) || w.tick < 0 || w.tick > MAX_TICK) return;
  const t = timeAtTick(w.tick);
  if (Math.abs(t - w.time) <= WIRE_TOL) w.time = t;
  const m = w.match;
  if (m?.phase === 'pre' && typeof m.preCountdown === 'number') m.preCountdown = fromStart(C.PRE_COUNTDOWN, m.preCountdown);
  const start = m ? PHASE_START[m.phase] : undefined;
  if (start !== undefined && typeof m.phaseTimeLeft === 'number') m.phaseTimeLeft = fromStart(start, m.phaseTimeLeft);
  for (const r of w.robots) {
    r.lastFireAt = onTickGrid(r.lastFireAt, w.tick);
    r.lastIntakeAt = onTickGrid(r.lastIntakeAt, w.tick);
  }
}
