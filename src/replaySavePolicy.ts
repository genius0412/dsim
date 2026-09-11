import { SIM_DT } from './config';

/**
 * WHEN A SOLO PRACTICE RUN IS WORTH KEEPING.
 *
 * Practice used to be kept at exactly one moment: `phase === 'post'`, i.e. a full 2:30 match
 * played to the end. Every other way out of a run threw it away — RESET/REMATCH said so out
 * loud ("an unfinished match is not a replay of anything") and leaving the game screen dropped
 * it silently, without even the comment. So the mode people spend most of their time in kept a
 * replay only if they sat through the whole match, which is not how practice is used: you drive
 * a cycle, see the thing you wanted to see, and reset.
 *
 * The replaced reasoning was not wrong about anything except its conclusion. An unfinished run
 * really is not a replay of a MATCH — but it is an exact, re-simulable recording of what the
 * driver actually did, which is the whole value of a practice replay, and `{seed, setups,
 * commands}` reproduces a partial run as faithfully as a whole one.
 *
 * WHY THERE IS A FLOOR AT ALL. The other half of "save unfinished runs" is that starting and
 * instantly resetting is a normal thing to do — lining up a start pose, restarting because the
 * countdown caught you looking away — and each of those would otherwise become a stored replay.
 * The device keeps `MAX_LOCAL_RUNS` (10) and the account keeps 10, oldest pruned first, so a
 * handful of junk runs is not a disk problem, it is a way to lose the runs you wanted by
 * pushing them off the end of the list. 15 s is long enough that nothing accidental reaches it
 * and short enough that a single scoring cycle does.
 *
 * WHY IT COUNTS DRIVEN TICKS AND NOT WALL TIME OR RECORDED TICKS. The recorder opens at tick 0
 * of a rebuilt world, which is `PRE_COUNTDOWN` (4 s) BEFORE the robots are released, so a raw
 * recorded-tick count would let a 12 s run over the line on the strength of a countdown nobody
 * drove through. Driven ticks are the ticks the sim actually let the robot move on
 * (`robotsEnabled`), so the floor means 15 s of DRIVING in every phase layout and needs no
 * assumption about how long the countdown is.
 *
 * This module is a LEAF and holds no state: the decision is a pure function of the run, so it
 * is checkable in `npm test` without a DOM, a clock, or a controller. Everything that decides
 * whether a practice replay survives goes HERE — the point of the file is that there is one
 * answer to the question and not one per exit path.
 */

/** the floor, in seconds of DRIVING (not wall time, not recorded ticks) */
export const PRACTICE_SAVE_MIN_S = 15;

/** the same floor in sim ticks, which is the unit the controller counts in */
export const PRACTICE_SAVE_MIN_TICKS = Math.round(PRACTICE_SAVE_MIN_S / SIM_DT);

/**
 * Why a run was kept or dropped. Carried out of the decision rather than being reduced to a
 * boolean at the call site so the reason can be logged, shown, or asserted — "too-short" and
 * "nothing-driven" are different events, and a UI that wants to say "runs under 15 s are not
 * kept" needs to know which one it is looking at.
 */
export type PracticeSaveReason =
  /** the match reached `post` — a whole run, kept regardless of length */
  | 'completed'
  /** abandoned, but past the floor */
  | 'long-enough'
  /** abandoned before the floor */
  | 'too-short'
  /** the robots were never released, so there is nothing in the log to watch */
  | 'nothing-driven';

export interface PracticeSaveInput {
  /** sim ticks on which the robots were actually enabled while recording */
  drivenTicks: number;
  /** did the match reach its own end (`phase === 'post'`) rather than being abandoned? */
  completed: boolean;
}

export interface PracticeSaveDecision {
  keep: boolean;
  reason: PracticeSaveReason;
  /** `drivenTicks` in seconds, for copy and logging */
  drivenSeconds: number;
}

export function practiceSaveDecision(input: PracticeSaveInput): PracticeSaveDecision {
  const drivenTicks = Number.isFinite(input.drivenTicks) ? Math.max(0, Math.floor(input.drivenTicks)) : 0;
  const drivenSeconds = drivenTicks * SIM_DT;
  // FIRST, because it is the one case that is not about length: quitting during the countdown
  // records a log in which nothing ever moved, and a completed match cannot land here.
  if (drivenTicks <= 0) return { keep: false, reason: 'nothing-driven', drivenSeconds };
  if (input.completed) return { keep: true, reason: 'completed', drivenSeconds };
  if (drivenTicks >= PRACTICE_SAVE_MIN_TICKS) return { keep: true, reason: 'long-enough', drivenSeconds };
  return { keep: false, reason: 'too-short', drivenSeconds };
}
