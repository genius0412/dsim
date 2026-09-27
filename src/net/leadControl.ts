/**
 * THE PREDICTION LEAD CONTROLLER — how far ahead of the server a predicting client's clock runs.
 *
 * ⚠️ **WITHOUT THIS THE CLIENT NEVER RAN AHEAD AT ALL, AND EVERY INPUT IT SENT WAS LATE.** The
 * reconcile keeps only buffered inputs stamped past the snapshot's tick, so the client's clock
 * came out as `max(its own clock, the newest snapshot's tick)`. A client starts on `matchStart`,
 * a downlink behind the server, so that was a clock sitting about one downlink BEHIND the
 * authority, and input `k` reached the room about a round trip after the room had already stepped
 * tick `k`. The room's exact-tick buffer (`pending`) never hit; every tick was filled from
 * `latest`, a round trip late, and inputs that landed between two server ticks were overwritten
 * before any tick used them. Measured through a real solo record `Room` at 50 ms RTT: **0% of
 * inputs on their tick**, 9–21% never applied, and the "prediction" was the server's robot plus
 * one or two ticks, i.e. about a round trip of input lag with a snap back on every change of
 * stick. The server has always sent the number that says so (`snapshot.ackInputTick`); nothing
 * read it.
 *
 * ⚠️ **AND IT COULD ONLY EVER RATCHET UP.** Nothing lowered the clock, so a server stall longer
 * than its 0.25 s catch-up clamp, or a server running slower than real time, left the client
 * permanently further ahead — until `MAX_PREDICT_LEAD`, where every snapshot replays forty full
 * steps (22 ms p50 for DECODE on a desktop, at 30 Hz) and the robot freezes a tick at a time.
 *
 * WHAT IT MEASURES. At every snapshot: `lead = clientClock − serverTick` (instant, no feedback
 * delay) and `slack = ackInputTick − serverTick` (how far ahead of the room the newest input it
 * had received was). An input is on time iff the lead at send exceeds the UPLINK in ticks, and a
 * lead measured against a received snapshot carries the downlink too, so `lead − slack` is the
 * round trip in ticks, whatever the lead currently is. The target is the WORST of those over a
 * short window plus `LEAD_MARGIN_TICKS` — as small as keeps ~all inputs on time, because the
 * reconcile replays the whole window every snapshot and on a 2D room that is the whole game step.
 *
 * WHAT IT MUST NOT DO — the reason `stepServer` says "we do NOT fast-forward the whole world".
 * Jumping the predicted world forward in a burst re-simulates every ball and remote robot from a
 * stale state in one frame, and on the next snapshot they all snap back ("everything flies"). So
 * this never adds or skips a tick outright: it returns a small RATE the frame loop folds into its
 * accumulator, a few percent faster or slower than real time, and the lead drifts onto the target
 * over a second or two (the pre-match countdown is four seconds, so the first convergence happens
 * while nothing can move). The target is clamped well under `MAX_PREDICT_LEAD`, which stays the
 * hard cap; a snapshot GAP resets the estimate and holds the rate at zero rather than chasing a
 * stall.
 *
 * DOM-free and clock-injected, so the headless smoke run drives the same object `game.ts` does.
 */

/** ticks of lead kept beyond the worst measured round trip: one for the room stepping in whole
 *  fires, one for the client producing its input partway through a frame. */
export const LEAD_MARGIN_TICKS = 1;
/** the largest lead the controller will ever AIM for — well under `MAX_PREDICT_LEAD` (40), which
 *  stays the hard cap. ~400 ms of round trip; past that the link is not one prediction can hide. */
export const LEAD_TARGET_MAX = 24;
/** snapshots the round-trip estimate takes its worst over (~2 s at 30 Hz). */
export const LEAD_WINDOW = 60;
/** fraction of real time per tick of error. 10 ticks off ⇒ 10% — then clamped below. */
export const LEAD_GAIN = 0.01;
/** the fastest the predicted clock may run: 6% over real time, ~3.6 ticks of lead a second. */
export const LEAD_MAX_FAST = 0.06;
/** the slowest: 15% under. Wider than FAST so a client can shed a lead a lagging server left it,
 *  and follow a room running up to 15% slow without climbing onto the hard cap. */
export const LEAD_MAX_SLOW = 0.15;
/** error (ticks) inside which the rate is zero — the lead jitters by ~a tick with frame phase. */
export const LEAD_DEADBAND = 1;
/** a snapshot arriving this long after the last is a STALL, not a sample. */
export const LEAD_GAP_MS = 150;
/** snapshots ignored after a stall, while the burst behind it drains. */
const LEAD_SKIP_AFTER_GAP = 3;

export class LeadController {
  private offsets: number[] = [];
  private ema: number | null = null;
  private lastSnapAt = 0;
  private skip = 0;
  private r = 0;
  /** the last target, for the read-out and the tests (null before the first sample). */
  target: number | null = null;

  /** forget everything — a new match, a rematch, a rebuilt world. */
  reset(): void {
    this.offsets = [];
    this.ema = null;
    this.lastSnapAt = 0;
    this.skip = 0;
    this.r = 0;
    this.target = null;
  }

  /**
   * One snapshot. `clock` is the client's own tick BEFORE the reconcile adopts the snapshot
   * (`world.tick`, or `predictTick` in a 3D room); `ackInputTick` is the snapshot's field, which
   * an older server may not send — a missing one leaves the controller off, i.e. the old clock.
   */
  sample(clock: number, serverTick: number, ackInputTick: unknown, nowMs: number): void {
    const gap = this.lastSnapAt ? nowMs - this.lastSnapAt : 0;
    this.lastSnapAt = nowMs;
    if (typeof ackInputTick !== 'number' || !Number.isFinite(ackInputTick) || ackInputTick <= 0) {
      this.r = 0;
      return;
    }
    if (gap > LEAD_GAP_MS) {
      // a stall: the lead read now is the prediction running on through it, not a round trip
      this.ema = null;
      this.skip = LEAD_SKIP_AFTER_GAP;
      this.r = 0;
      return;
    }
    if (this.skip > 0) {
      this.skip--;
      return;
    }
    // the lead the reconcile LEAVES: a clock behind the snapshot is lifted onto it
    const lead = Math.max(0, clock - serverTick);
    const offset = lead - (ackInputTick - serverTick);
    // an impossible reading (a client clock from before a rebuild, an ack from another match)
    if (!Number.isFinite(offset) || offset < -10 || offset > 120) return;
    this.offsets.push(offset);
    if (this.offsets.length > LEAD_WINDOW) this.offsets.shift();
    let worst = -Infinity;
    for (const o of this.offsets) if (o > worst) worst = o;
    const target = Math.max(0, Math.min(LEAD_TARGET_MAX, worst + LEAD_MARGIN_TICKS));
    this.target = target;
    this.ema = this.ema === null ? lead : this.ema + 0.2 * (lead - this.ema);
    const err = target - this.ema;
    this.r = Math.abs(err) <= LEAD_DEADBAND ? 0 : Math.max(-LEAD_MAX_SLOW, Math.min(LEAD_MAX_FAST, LEAD_GAIN * err));
  }

  /** the rate to fold into the frame accumulator (`acc += dt * (1 + rate)`). Zero while
   *  snapshots are not arriving: a stall is not something to speed up or slow down into. */
  rate(nowMs: number): number {
    if (!this.lastSnapAt || nowMs - this.lastSnapAt > LEAD_GAP_MS) return 0;
    return this.r;
  }
}
