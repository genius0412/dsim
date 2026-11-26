/**
 * WHICH RAW AXIS IS EACH STICK AXIS, for a pad the browser gives no standard mapping.
 *
 * `Gamepad.mapping === 'standard'` promises left stick on axes 0 / 1 and right stick on 2 / 3.
 * A pad the browser does not know (`mapping === ''`: generic USB pads, PlayStation and Switch
 * pads in Firefox, most pads on Linux) reports its axes in the device's own order. The right
 * stick is then often on 3 / 4 or 2 / 5 with a trigger on 2, and a trigger axis rests at -1, so
 * reading "turn" on axis 2 spun the robot for as long as the pad was connected, or never turned
 * it. Buttons could always be rebound by index; the sticks could not.
 *
 * `PadStickMap` is the player's answer, captured by pushing each stick (`StickCapture`). It is
 * applied ONLY to a pad that is not standard: a standard pad is always read on 0..3, so a map
 * stored on the account cannot break the Xbox pad the same player uses on another machine.
 * DOM-free: `npm test` drives the reader, the coercer and the capture on synthetic axes.
 */

/** the four stick axes, in the standard mapping's order */
export const STICK_ROLES = ['lx', 'ly', 'rx', 'ry'] as const;
/** the highest raw axis index a map may name */
export const PAD_AXIS_MAX = 15;

export interface PadStickMap {
  /** the raw axis for left X, left Y, right X, right Y: four different indices */
  axes: [number, number, number, number];
  /** true where the raw axis runs the other way (stick right and stick down read positive) */
  flip: [boolean, boolean, boolean, boolean];
}

const isAxis = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= PAD_AXIS_MAX;

/** a stored map, validated; `undefined` for anything else AND for the standard order, which
 *  needs no map (so a blob that never used the field round-trips without it) */
export function coerceStickMap(v: unknown): PadStickMap | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as { axes?: unknown; flip?: unknown };
  if (!Array.isArray(o.axes) || o.axes.length !== 4 || !o.axes.every(isAxis) || new Set(o.axes).size !== 4) return undefined;
  const f: unknown[] = Array.isArray(o.flip) ? o.flip : [];
  const axes = [o.axes[0], o.axes[1], o.axes[2], o.axes[3]] as PadStickMap['axes'];
  const flip = [f[0] === true, f[1] === true, f[2] === true, f[3] === true] as PadStickMap['flip'];
  if (axes.every((a, i) => a === i) && flip.every((x) => !x)) return undefined;
  return { axes, flip };
}

export function sameStickMap(a: PadStickMap | undefined, b: PadStickMap | undefined): boolean {
  if (!a || !b) return a === b;
  return a.axes.every((x, i) => x === b.axes[i]) && a.flip.every((x, i) => x === b.flip[i]);
}

/** left X, left Y, right X, right Y as the standard mapping would give them */
export function sticksOf(
  pad: { readonly mapping?: string; readonly axes: ArrayLike<number> },
  map: PadStickMap | undefined,
): [number, number, number, number] {
  const a = pad.axes;
  if (!map || pad.mapping === 'standard') return [a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0];
  const at = (i: number): number => {
    const v = a[map.axes[i]] ?? 0;
    return map.flip[i] ? -v : v;
  };
  return [at(0), at(1), at(2), at(3)];
}

/** how far an axis must move from where it rested for the capture to take it */
export const STICK_CAPTURE_PUSH = 0.6;
/** ...and how close to rest it must come back before the next push is read */
export const STICK_CAPTURE_REST = 0.25;

export type StickCaptureStep =
  /** waiting for the push that role `role` (an index into `STICK_ROLES`) asks for */
  | { t: 'push'; role: number }
  /** all four taken; `map` is `undefined` when they came out in the standard order */
  | { t: 'done'; map: PadStickMap | undefined };

/**
 * THE CAPTURE: four pushes, in `STICK_ROLES` order (left stick right, left stick down, right
 * stick right, right stick down). Each step takes the ONE axis that moved `STICK_CAPTURE_PUSH`
 * from where it sat when the capture started; a diagonal push (a second axis moving more than
 * 0.6 of the first) is not taken, and neither is an axis an earlier step took. Measured from the
 * starting values, not from zero, so a trigger axis resting at -1 is never mistaken for a push.
 * The next push is read once the axis just taken is back within `STICK_CAPTURE_REST`.
 */
export class StickCapture {
  private base: number[] | null = null;
  private axes: number[] = [];
  private flip: boolean[] = [];
  /** the axis just taken, until it is back at rest */
  private settling = -1;

  step(axes: ArrayLike<number>): StickCaptureStep {
    if (!this.base) {
      this.base = Array.from(axes);
      return { t: 'push', role: 0 };
    }
    const base = this.base;
    const moved = (i: number): number => (axes[i] ?? 0) - (base[i] ?? 0);
    const waiting: StickCaptureStep = { t: 'push', role: this.axes.length };
    if (this.settling >= 0) {
      if (Math.abs(moved(this.settling)) >= STICK_CAPTURE_REST) return waiting;
      this.settling = -1;
    }
    let best = -1;
    let bestMag = 0;
    let second = 0;
    const n = Math.min(axes.length, PAD_AXIS_MAX + 1);
    for (let i = 0; i < n; i++) {
      if (this.axes.includes(i)) continue;
      const m = Math.abs(moved(i));
      if (m > bestMag) {
        second = bestMag;
        bestMag = m;
        best = i;
      } else if (m > second) second = m;
    }
    if (best < 0 || bestMag < STICK_CAPTURE_PUSH || second > bestMag * 0.6) return waiting;
    this.axes.push(best);
    this.flip.push(moved(best) < 0);
    this.settling = best;
    if (this.axes.length < 4) return { t: 'push', role: this.axes.length };
    return { t: 'done', map: coerceStickMap({ axes: this.axes, flip: this.flip }) };
  }
}
