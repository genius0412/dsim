import { PAD_ACTIONS, PAD_CHORD_GRACE_MS, PAD_CHORD_MAX, chordKey, padBinds, type PadAction, type PadBindings, type PadChord } from './bindings';

/**
 * WHICH PAD ACTIONS ARE ON, given which buttons are held — the one place a combo means
 * anything. DOM-free and clock-injected (`nowMs`), so `npm test` drives it frame by frame.
 *
 * With no combo bound the answer is the old one: an action is on when any of its buttons is
 * held, on the frame it is pressed, with nothing remembered between frames. That path is
 * taken explicitly, so a player who never bound a combo cannot be touched by the three rules
 * below — every one of which exists only because two binds can share a button.
 *
 * 1. THE LONGEST SATISFIED CHORD WINS. RT + D-UP held masks bare RT (Shoot) and bare D-UP
 *    (Place POLLEN): a combo that also fired everything it is made of would be useless, and
 *    the reason a driver binds one is that the buttons have run out.
 * 2. A PREFIX WAITS. Nobody presses two buttons on the same frame; the first one lands a few
 *    tens of milliseconds early and, alone, it IS bare RT. DECODE's first shot is instant, so
 *    without a wait every lift would fire a shot first. A satisfied chord that is a strict
 *    subset of some bound chord that is NOT yet satisfied is held back for the COMBO WAIT
 *    (`pad.chordGraceMs`, the player's own setting, `PAD_CHORD_GRACE_MS` by default) from the
 *    moment it completed; if the wider chord lands inside that window it fires instead (rule
 *    1), and if not, the prefix fires late by the wait and stays on while held. Only buttons
 *    that are part of some combo pay it.
 * 3. A FIRED COMBO CONSUMES ITS BUTTONS. Letting go of D-UP while RT is still down must not
 *    start shooting: the buttons a fired combo was made of fire nothing ELSE until they are
 *    released and pressed again. The combo itself keeps firing, and re-completing it fires it
 *    again — the consumption blocks a chord only when every button of it was consumed by a
 *    DIFFERENT chord, which is also what stops one finger lifting off a three-chord from
 *    firing the two-chord underneath. It is tested BEFORE rule 2, so a blocked chord is never
 *    also a waiting one (or lifting a finger off a three-chord would fire the two-chord under it
 *    as a tap).
 * 4. A TAP INSIDE THE WAIT STILL COUNTS. Rule 2 defers a prefix; it must not swallow it. A
 *    button that is part of a combo, pressed and released before the wait runs out with no
 *    wider chord having fired, fires ONCE on the frame it is let go — a quick RT tap is still
 *    one shot, and park / flip / start / restart, which are tapped by nature, still work on a
 *    button that also lives in a combo. A tapped COMBO (a two-chord under a three-chord)
 *    consumes whatever of it is still held, per rule 3. The tap is then HELD ASSERTED for
 *    `PAD_TAP_HOLD_MS` (see the constant) — one frame is not long enough for the sim to see it.
 *
 * Two things these rules deliberately do NOT do. Overlapping chords that are not nested —
 * `LB + RT` and `RB + D-UP` both held also satisfies an `RT + D-UP` bound elsewhere — all
 * fire, which is what `&&` on the real gamepad would do too. And masking (rule 1) reads
 * SATISFIED, not fired: with a three-chord bound over a two-chord, pressing the third button's
 * partner while the single is firing silences the single for the length of the wait before the
 * two-chord fires, since the two-chord is satisfied (and waiting) the whole time.
 */
export { PAD_CHORD_GRACE_MS };

/**
 * HOW LONG A RULE-4 TAP STAYS ASSERTED. 34 ms, and the number is a bound, not a feel.
 *
 * `resolve()` runs once per `InputManager.poll()`, which runs once per FRAME; the HELD-level
 * bits it produces (`fire`, `intake`, `catalyst`, `fling`, `bbPlace*`, `bbNectar`, `driveMode`)
 * are read by the SIM, which advances on a fixed 60 Hz accumulator. Above 60 fps most frames
 * step ZERO ticks (`GameController.stepCounts` says so in as many words), and in multiplayer
 * the sim is driven by a jittery `setInterval` at the same period — so a tap asserted for
 * exactly ONE frame lands on a frame that steps nothing roughly two times in three at 165 Hz,
 * and the shot is silently lost. (The EDGE actions — park / flip / start / restart — are read
 * per frame in `frameLogic`, never through the accumulator, and were never affected.)
 *
 * The bound: with a frame period `p` and a sim period `T` = 1/60 s, at most `floor(T/p)` frames
 * in a row step nothing, so the longest gap between two STEPPING frames is `(floor(T/p)+1)·p`,
 * which is at most `T·(1 + 1/floor(T/p))` and is therefore strictly under `2T` = 33.34 ms — its
 * worst case is a display just past 60 Hz, where every other frame can step nothing. Assert the
 * tap for longer than that and at least one stepping frame's poll is guaranteed to see it, at
 * any refresh rate. 34 ms is that floor rounded up.
 *
 * It is a CONTINUOUS window, not a repeat: the action is on from the release frame to the
 * deadline without a gap, so `gamepad.ts`'s `prev*` edge detectors still see exactly one rising
 * edge. It is not a user setting — it is the sim's clock, not a preference.
 */
export const PAD_TAP_HOLD_MS = 34;

interface Bind {
  action: PadAction;
  chord: PadChord;
  key: string;
}

const isSubset = (a: PadChord, b: PadChord): boolean => a.every((i) => b.includes(i));
const isStrictSubset = (a: PadChord, b: PadChord): boolean => a.length < b.length && isSubset(a, b);

export type PadActive = Record<PadAction, boolean>;

const noneActive = (): PadActive => {
  const out = {} as PadActive;
  for (const a of PAD_ACTIONS) out[a] = false;
  return out;
};

export class PadChordResolver {
  /** when each held button went down — the clock rule 2 measures from */
  private downSince = new Map<number, number>();
  /** which fired combo each held button belongs to, until it is released (rule 3) */
  private consumedBy = new Map<number, string>();
  /** the chords rule 2 held back on the previous frame — a release before the wait ran out
   *  is a TAP (rule 4) */
  private waiting = new Map<string, Bind>();
  /** rule 4's LATCH: for each action whose tap fired, the wall time it stops being asserted
   *  (`PAD_TAP_HOLD_MS` past the release). Empty whenever no tap is live, which is what keeps
   *  the no-combo fast path stateless. */
  private tapUntil = new Map<PadAction, number>();

  /** forget everything held — on a disconnect, so nothing is consumed or timed across it */
  reset(): void {
    this.downSince.clear();
    this.consumedBy.clear();
    this.waiting.clear();
    this.tapUntil.clear();
  }

  resolve(heldButtons: Iterable<number>, pad: PadBindings, nowMs: number): PadActive {
    const held = new Set(heldButtons);
    const out = noneActive();

    // THE FAST PATH — no combo anywhere: the plain any-button test, and no state kept.
    let anyCombo = false;
    for (const a of PAD_ACTIONS) if (pad.combos[a].length > 0) { anyCombo = true; break; }
    if (!anyCombo) {
      this.reset();
      for (const a of PAD_ACTIONS) out[a] = pad.buttons[a].some((i) => held.has(i));
      return out;
    }

    for (const i of held) if (!this.downSince.has(i)) this.downSince.set(i, nowMs);
    for (const i of [...this.downSince.keys()]) if (!held.has(i)) this.downSince.delete(i);
    for (const i of [...this.consumedBy.keys()]) if (!held.has(i)) this.consumedBy.delete(i);

    const binds: Bind[] = [];
    for (const action of PAD_ACTIONS) {
      for (const chord of padBinds(pad, action)) binds.push({ action, chord, key: chordKey(chord) });
    }
    const allHeld = (c: PadChord): boolean => c.every((i) => held.has(i));
    const grace = pad.chordGraceMs ?? PAD_CHORD_GRACE_MS;
    // rule 4: what was waiting last frame and has been let go fires now, once
    const taps = [...this.waiting.values()].filter((b) => !allHeld(b.chord));
    this.waiting.clear();
    const satisfied = binds.filter((b) => allHeld(b.chord));
    const fired: Bind[] = [];
    for (const b of satisfied) {
      // rule 1
      if (satisfied.some((o) => isStrictSubset(b.chord, o.chord))) continue;
      // rule 3 (before rule 2, so a blocked chord never becomes a waiting one)
      const blocked = b.chord.every((i) => {
        const by = this.consumedBy.get(i);
        return by !== undefined && by !== b.key;
      });
      if (blocked) continue;
      // rule 2
      const completedAt = Math.max(...b.chord.map((i) => this.downSince.get(i) ?? nowMs));
      const widerPending = binds.some(
        (o) => isStrictSubset(b.chord, o.chord) && !allHeld(o.chord),
      );
      if (widerPending && nowMs - completedAt < grace) {
        this.waiting.set(b.key, b);
        continue;
      }
      fired.push(b);
    }
    for (const b of taps) {
      if (fired.some((f) => f.key === b.key)) continue;
      fired.push(b);
      // rule 4's latch — see `PAD_TAP_HOLD_MS`. `max` so a second tap inside a live latch
      // extends it rather than cutting it short.
      this.tapUntil.set(b.action, Math.max(this.tapUntil.get(b.action) ?? 0, nowMs + PAD_TAP_HOLD_MS));
    }
    for (const b of fired) {
      out[b.action] = true;
      // only what is still held can be consumed; a released button's entry is already gone
      if (b.chord.length > 1) for (const i of b.chord) if (held.has(i)) this.consumedBy.set(i, b.key);
    }
    // A LIVE TAP OUTLASTS ITS FRAME. Consumption (rule 3) is deliberately NOT re-applied here:
    // it was settled on the frame the tap fired, off the buttons that were still down then.
    for (const [a, until] of [...this.tapUntil]) {
      if (nowMs >= until) this.tapUntil.delete(a);
      else out[a] = true;
    }
    return out;
  }
}

/**
 * HOW LONG ONE BUTTON IS HELD, ALONE, BEFORE LETTING GO OF IT REMOVES THE SLOT instead of binding
 * it. A pad capture takes every button that goes down and pad navigation stands down while it is
 * armed, so without this a controller-only player could neither remove a bind nor back out of a
 * capture: Esc, Backspace and the `×` cap are keyboard and pointer only. One second is well past
 * a press, and a second button joining turns the hold back into a combo.
 */
export const PAD_HOLD_REMOVE_MS = 1000;

export type PadCaptureStep =
  | { t: 'idle' }
  /** the chord grew — the buttons in the order they went down */
  | { t: 'chord'; chord: number[] }
  /** one button alone has been held past `PAD_HOLD_REMOVE_MS`; every frame until it is let go */
  | { t: 'hold'; button: number }
  /** bind this chord (press order) */
  | { t: 'commit'; chord: number[] }
  /** a hold was let go: remove the armed slot, or cancel a slot that holds nothing */
  | { t: 'remove' };

const IDLE: PadCaptureStep = { t: 'idle' };

/**
 * ONE PAD CAPTURE, frame by frame. DOM-free and clock-injected like the resolver above, so
 * `npm test` drives it; `ControlsSection` feeds it the held set from `navigator.getGamepads()`.
 *
 * Everything that goes down AFTER the capture starts, and is still down, is the chord. It
 * COMMITS when any of those buttons is released or the instant it reaches `PAD_CHORD_MAX` —
 * committing on release rather than press is what lets a second button join. Whatever was held
 * on the first frame (the A that armed the slot) is ignored until it is let go.
 */
export class PadCapture {
  private alreadyDown = new Set<number>();
  private chord: number[] = [];
  private first = true;
  private done = false;
  /** when the chord's first button went down — the clock the hold measures from */
  private since = 0;

  /** start over after a refused bind: whatever is still held is ignored until released */
  rearm(): void {
    this.chord = [];
    this.first = true;
    this.done = false;
  }

  step(down: ReadonlySet<number>, nowMs: number): PadCaptureStep {
    if (this.done) return IDLE;
    if (this.first) {
      for (const i of down) this.alreadyDown.add(i);
      this.first = false;
      return IDLE;
    }
    for (const i of [...this.alreadyDown]) if (!down.has(i)) this.alreadyDown.delete(i);
    const held = (): boolean => this.chord.length === 1 && nowMs - this.since >= PAD_HOLD_REMOVE_MS;
    if (this.chord.length > 0 && this.chord.some((i) => !down.has(i))) {
      this.done = true;
      return held() ? { t: 'remove' } : { t: 'commit', chord: [...this.chord] };
    }
    const before = this.chord.length;
    for (const i of down) {
      if (this.alreadyDown.has(i) || this.chord.includes(i)) continue;
      if (this.chord.length === 0) this.since = nowMs;
      this.chord.push(i);
    }
    if (this.chord.length >= PAD_CHORD_MAX) {
      this.done = true;
      return { t: 'commit', chord: this.chord.slice(0, PAD_CHORD_MAX) };
    }
    if (held()) return { t: 'hold', button: this.chord[0] };
    return this.chord.length !== before ? { t: 'chord', chord: [...this.chord] } : IDLE;
  }
}
