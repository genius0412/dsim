import { SIM_DT } from '../../config';
import { ReplayPlayer, type Replay } from '../../sim/replay';
import type { Alliance, MatchPhase, World } from '../../types';

/**
 * THE PACE CURVE: what a reference run's score was at each point on the match clock.
 *
 * DOM-free, so `npm test` and the pace worker both run it. A replay is an input log and holds no
 * score, so the curve is made by re-simulating the reference once (`buildPaceCurve`, in the
 * worker) and kept (`store.ts`): a replay never changes, so neither does its curve.
 *
 * ── KEYED BY THE MATCH CLOCK, NOT BY TICK ──────────────────────────────────────────────────
 * A tick is not the same moment in two runs. A replay and a record room count down a 4 s pre-match
 * inside the sim, while solo practice waits on a keypress and starts AUTO whenever the player
 * presses Start. What every run agrees on is the CLOCK: the phase, and how long is left in it. So
 * a point is `(phase, ticks left in the phase)`, folded into one ordered number (`clockKey`), and
 * the live run is looked up by the same pair off its HUD. No game's phase lengths are needed, so
 * a game with different durations works as is.
 *
 * ── THE SCORE IS THE NET ONE ───────────────────────────────────────────────────────────────
 * The alliance total minus the points its own fouls handed the opponent: what a record means
 * (`recordScore`) and what a practice run is saved as. The +/- answers "am I on course to beat
 * that number", so it compares in the units of that number.
 */

/** the reference's score where it changed: `k` ascending clock keys, `s` the score from there on */
export interface PaceCurve {
  k: number[];
  s: number[];
}

/** phases in match order; 'pre' and 'freeplay' have no pace */
const PHASE_RANK: Partial<Record<MatchPhase, number>> = { auto: 1, transition: 2, teleop: 3, post: 4 };
/** room for any phase's tick count inside one key (a phase is minutes, this is 46 hours) */
const SPAN = 10_000_000;

/**
 * One ordered number for a moment on the match clock: later is larger. `timeLeft` counts DOWN
 * inside a phase, so the ticks remaining are subtracted. `post` has no clock (`phaseTimeLeft` is
 * 0 while the field settles), so every post moment shares one key and the curve keeps the last
 * score it saw there, which is the settled final.
 */
export function clockKey(phase: MatchPhase, timeLeft: number): number | null {
  const rank = PHASE_RANK[phase];
  if (rank == null) return null;
  if (phase === 'post') return rank * SPAN;
  return rank * SPAN + (SPAN - 1 - Math.max(0, Math.round(timeLeft / SIM_DT)));
}

/** an alliance's net score in a world (see the header), floored at 0 as `recordScore` is */
export function netScore(world: World, alliance: Alliance): number {
  const opp: Alliance = alliance === 'blue' ? 'red' : 'blue';
  return Math.max(0, world.match.scores[alliance].total - world.match.scores[opp].foulPoints);
}

/**
 * Record a curve as a run plays: one call per tick. A point is kept only where the score
 * changed (or the key repeats in `post`, where the latest value wins), so a whole match is a few
 * hundred numbers, not ten thousand.
 */
export class PaceCurveRecorder {
  readonly curve: PaceCurve = { k: [], s: [] };

  push(phase: MatchPhase, timeLeft: number, score: number): void {
    const key = clockKey(phase, timeLeft);
    if (key == null) return;
    const { k, s } = this.curve;
    const n = k.length;
    if (n > 0 && key < k[n - 1]) return; // the clock never runs backwards; ignore if it seems to
    if (n > 0 && key === k[n - 1]) {
      s[n - 1] = score;
      return;
    }
    if (n > 0 && s[n - 1] === score && phase !== 'post') return;
    k.push(key);
    s.push(score);
  }
}

/**
 * Re-simulate `replay` and return its curve for `alliance`. Synchronous and CPU-heavy (a whole
 * match), so it runs in the pace worker, never on the thread that draws the game. A `'3d'`
 * replay needs `initPhysics3d()` resolved first, exactly as `ReplayPlayer` says.
 */
export function buildPaceCurve(
  replay: Replay,
  alliance: Alliance,
  /** handed the world when the run ends or throws, for a caller that has to release it (3D) */
  done?: (world: World) => void,
): PaceCurve {
  const p = new ReplayPlayer(replay);
  const rec = new PaceCurveRecorder();
  try {
    while (p.stepOnce()) {
      const m = p.world.match;
      rec.push(m.phase, m.phaseTimeLeft, netScore(p.world, alliance));
    }
  } finally {
    // a run that throws mid-match still releases its world: the worker lives for the session
    done?.(p.world);
  }
  return rec.curve;
}

/**
 * The reference's score at a moment on the clock, or null where there is no pace yet (before
 * AUTO, or before the reference scored its first point in the match — which is 0, and reads 0).
 */
export function paceAt(curve: PaceCurve, phase: MatchPhase, timeLeft: number): number | null {
  const key = clockKey(phase, timeLeft);
  if (key == null) return null;
  const { k, s } = curve;
  if (k.length === 0 || key < k[0]) return k.length === 0 ? null : 0;
  // the last change at or before this moment
  let lo = 0;
  let hi = k.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (k[mid] <= key) lo = mid;
    else hi = mid - 1;
  }
  return s[lo];
}

/** a curve read back from storage or a worker message, or null when it is not one */
export function coerceCurve(v: unknown): PaceCurve | null {
  if (typeof v !== 'object' || v === null) return null;
  const { k, s } = v as { k?: unknown; s?: unknown };
  if (!Array.isArray(k) || !Array.isArray(s) || k.length !== s.length) return null;
  if (!k.every((x) => typeof x === 'number') || !s.every((x) => typeof x === 'number')) return null;
  return { k: k as number[], s: s as number[] };
}
