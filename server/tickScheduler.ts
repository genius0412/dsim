/**
 * THE ONE 60 Hz CLOCK every live room in this process steps from.
 *
 * Each `Room` used to own a `setInterval(…, 1000/60)` and a `Date.now()` accumulator. Measured on
 * Linux (`docs/capacity.md`, "Loop timing"), that interval fires every ~16.3 ms, not 16.67, so the
 * accumulator hands some fires 0 steps and others 2 — and because a snapshot goes out on every
 * even tick, **7.7% of a single idle room's snapshot gaps were 16 or 48 ms instead of 33**, a
 * beat the client reads as jitter. With N rooms there were N unsynchronised timers, all landing
 * their broadcast on the same even ticks.
 *
 * One self-correcting deadline fixes both. The loop sleeps with `setTimeout` until the next
 * `performance.now()` deadline, runs every due tick, and advances the deadline by exactly one
 * tick per step — so the long-run rate is exact and the spacing does not drift. Rooms are
 * split across two SNAPSHOT PARITIES (odd rooms broadcast on odd ticks), so a machine's encode
 * work is spread over both halves of the 30 Hz cycle instead of piling onto one.
 * Measured: 1 room 7.7% → 0% of gaps off by more than 8 ms; 10 DECODE rooms 10.9% → 3.4%.
 *
 * The catch-up rules are the old per-room ones, applied once for the process: at most
 * `MAX_STEPS_PER_TURN` (8) ticks per turn, and debt beyond `MAX_DEBT_MS` (a quarter second) is
 * DROPPED rather than fast-forwarded — an overloaded machine sheds simulation time, it does not
 * burst. Each room still coalesces a multi-step turn into ONE broadcast (`Room.runTurn`).
 *
 * ⚠️ NO `node:` IMPORT, NO `process`. `server/room.ts` is bundled for a browser tab too (the LAN
 * host runs it in a dedicated Worker, `src/lan/hostWorker.ts`), where `setTimeout` and
 * `performance` are the same globals. A Worker is throttled less than a page, not never, which
 * is why the catch-up rules matter there too.
 */
import { SIM_DT } from '../src/config';

const DT_MS = 1000 * SIM_DT;
/** never run more than this many ticks in one turn (the old per-room `n < 8`) */
export const MAX_STEPS_PER_TURN = 8;
/** debt past this is forgiven, not simulated (the old per-room `acc > 0.25` clamp) */
export const MAX_DEBT_MS = 250;

/** one member's turn: `steps` ticks are due (1 normally, more after a stall) */
export type Turn = (steps: number) => void;

const members = new Map<Turn, 0 | 1>();
const parityCount: [number, number] = [0, 0];
let timer: ReturnType<typeof setTimeout> | null = null;
/** true while `turn` is running the members — a join from inside a turn must not re-arm */
let inTurn = false;
/** `performance.now()` at which the next tick is due */
let next = 0;

/**
 * Put a room on the clock. Returns its SNAPSHOT PARITY — 0 or 1, whichever is currently less
 * used — so a room with parity p broadcasts on ticks where `(tick + p) % 2 === 0`. The parity is
 * the room's for as long as it stays on the clock (one match).
 */
export function joinClock(turn: Turn): 0 | 1 {
  const had = members.get(turn);
  if (had !== undefined) return had;
  const parity: 0 | 1 = parityCount[0] <= parityCount[1] ? 0 : 1;
  parityCount[parity]++;
  members.set(turn, parity);
  if (timer === null && !inTurn) {
    next = performance.now() + DT_MS;
    arm();
  }
  return parity;
}

/** Take a room off the clock. The clock stops when nobody is on it — an idle machine sleeps. */
export function leaveClock(turn: Turn): void {
  const parity = members.get(turn);
  if (parity === undefined) return;
  members.delete(turn);
  parityCount[parity]--;
  if (members.size === 0 && timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

/** how many rooms are on the clock (diagnostics and tests) */
export function clockMembers(): number {
  return members.size;
}

function arm(): void {
  timer = setTimeout(turn, Math.max(0, next - performance.now()));
}

function turn(): void {
  timer = null;
  const now = performance.now();
  if (now - next > MAX_DEBT_MS) next = now - MAX_DEBT_MS; // never fast-forward more than 1/4 s
  let steps = 0;
  while (now >= next && steps < MAX_STEPS_PER_TURN) {
    steps++;
    next += DT_MS;
  }
  if (steps > 0) {
    inTurn = true;
    // a COPY: a turn can take its own room off the clock (a match that finalizes) or, in
    // principle, start another — neither may disturb who else steps this turn
    for (const t of [...members.keys()]) {
      if (!members.has(t)) continue; // left during an earlier member's turn
      try {
        t(steps);
      } catch (e) {
        // `Room.runTurn` contains its own; this is the backstop that keeps one bad member
        // from stopping the clock for every other room on the machine
        console.error('[clock] turn threw:', e);
      }
    }
    inTurn = false;
  }
  // an early wake (timer granularity is 1 ms) ran nothing and simply sleeps again
  if (members.size > 0 && timer === null) arm();
}
