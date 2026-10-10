import { PAD_TRIGGERS, livePad, type PadBindings } from './bindings';
import { PadChordResolver } from './padChords';
import { applyPadMask, clearPadMask } from './padNav';

/** deadzone + sensitivity curve for ONE axis: below `deadzone` reads as dead center; past
 * it, the remaining travel is rescaled to 0-1 and raised to `curve` (1 =
 * linear, higher = softer near center / more precise low-speed control,
 * still reaching full deflection at the stick's edge — the classic RC/gaming
 * "expo" curve), then given back the original sign. Used where only one axis of a stick is
 * read (the turn axis, the two tank sticks). */
export const shape = (v: number, deadzone: number, curve: number): number => {
  const av = Math.abs(v);
  if (av < deadzone) return 0;
  const scaled = Math.min(1, (av - deadzone) / (1 - deadzone));
  return Math.sign(v) * Math.pow(scaled, curve);
};

/**
 * THE SAME DEADZONE AND CURVE, applied to a WHOLE STICK — RADIALLY, as `PadBindings.deadzone`
 * has always been documented ("radial stick deadzone").
 *
 * It was applied per AXIS, which is a cross-shaped deadzone: the small component of any
 * near-cardinal push fell inside it and was zeroed, so a stick pushed a few degrees off straight
 * ahead drove dead straight — the default 0.12 swallowed every angle under ~7° at full throw.
 * Here the MAGNITUDE is shaped and the direction is kept exactly, so every angle is reachable.
 * A square-gated stick's corners read past 1; the magnitude is capped at 1 so a corner gives a
 * unit vector rather than more than full speed on each axis.
 */
export function shapeStick(x: number, y: number, deadzone: number, curve: number): [number, number] {
  const m = Math.hypot(x, y);
  if (m <= deadzone || m === 0) return [0, 0];
  const scaled = Math.pow(Math.min(1, (Math.min(1, m) - deadzone) / (1 - deadzone)), curve);
  const k = scaled / m;
  return [x * k, y * k];
}

/** the standard mapping's two ANALOG triggers — the buttons `triggerThreshold` governs */
const TRIGGERS = new Set(PAD_TRIGGERS);

/** how far a trigger is pulled, 0..1. A trigger that reports no value (a digital one reads 0
 *  while down) counts as fully pulled, for the reason `padButtonDown` gives. */
export function triggerTravel(b: { pressed: boolean; value: number } | null | undefined): number {
  if (!b) return 0;
  return b.pressed && b.value === 0 ? 1 : Math.min(1, Math.max(0, b.value));
}

/**
 * IS THIS BUTTON DOWN? For a TRIGGER, that is the player's threshold and nothing else.
 *
 * It was `pressed || value > threshold`, and Chrome reports an analog trigger `pressed` from
 * about 0.12 of its travel — so the setting could only make triggers MORE sensitive, and
 * raising it did nothing at all. `pressed` is kept for a trigger that reports no value (a
 * digital one reads 0 there while down), and for every other button, where a digital press is
 * the whole story.
 */
export function padButtonDown(
  b: { pressed: boolean; value: number } | null | undefined,
  index: number,
  threshold: number,
): boolean {
  if (!b) return false;
  if (TRIGGERS.has(index)) return b.value > threshold || (b.pressed && b.value === 0);
  return b.pressed || b.value > threshold;
}

export interface GamepadSample {
  connected: boolean;
  driveX: number;
  driveY: number;
  rotate: number;
  leftY: number; // raw left stick Y (inverted)
  rightY: number; // raw right stick Y (inverted)
  fire: boolean;
  intake: boolean;
  catalyst: boolean;
  fling: boolean;
  bbPlaceNectar: boolean;
  bbPlace: boolean;
  bbNectar: boolean;
  bbRamp: boolean;
  bbPass: boolean;
  driveMode: boolean;
  flipFront: boolean;
  park: boolean;
  start: boolean;
  restart: boolean;
}

const EMPTY: GamepadSample = {
  connected: false,
  driveX: 0,
  driveY: 0,
  rotate: 0,
  leftY: 0,
  rightY: 0,
  fire: false,
  intake: false,
  catalyst: false,
  fling: false,
  bbPlaceNectar: false,
  bbPlace: false,
  bbNectar: false,
  bbRamp: false,
  bbPass: false,
  driveMode: false,
  flipFront: false,
  park: false,
  start: false,
  restart: false,
};

/** standard-mapping gamepad. Stick roles and button assignments come from the
 * user's PadBindings: the drive stick translates, the other stick's X turns (or the
 * triggers do, with `turnWith: 'triggers'`).
 * Which BUTTONS mean which ACTION — singles and combos alike — is the chord
 * resolver's answer (`padChords.ts`); this class only reads the hardware. */
/**
 * HOW LONG A PAD MAY VANISH BEFORE IT COUNTS AS UNPLUGGED (ms). `getGamepads()` can report no
 * connected pad for a single frame (seen on Bluetooth pads), and returning the empty sample
 * then released every held button at once: replay 1dc6eb8f has one all-zero input frame in the
 * middle of a held press, and the ramp toggled twice on it. Within the grace the last sample is
 * held, with its one-shot actions cleared so they cannot fire again.
 */
const PAD_DROPOUT_GRACE_MS = 100;

export class GamepadInput {
  private last: GamepadSample | null = null;
  private lostAt = 0;
  private prevStart = false;
  private prevRestart = false;
  private prevFlip = false;
  private prevPark = false;
  private chords = new PadChordResolver();
  /** `livePad(bindings)`, kept until the bindings object changes: it copies the lists when the
   *  triggers turn, and this runs every frame */
  private liveFrom: PadBindings | null = null;
  private live: PadBindings | null = null;

  sample(bindings: PadBindings): GamepadSample {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = Array.from(pads).find((p) => p && p.connected) ?? null;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (!pad) {
      if (this.last) {
        if (this.lostAt === 0) this.lostAt = now;
        if (now - this.lostAt < PAD_DROPOUT_GRACE_MS) {
          return { ...this.last, flipFront: false, park: false, start: false, restart: false };
        }
      }
      this.last = null;
      this.lostAt = 0;
      this.prevStart = false;
      this.prevRestart = false;
      this.prevFlip = false;
      this.prevPark = false;
      this.chords.reset();
      clearPadMask();
      return { ...EMPTY };
    }
    const raw: number[] = [];
    for (let i = 0; i < pad.buttons.length; i++) {
      if (padButtonDown(pad.buttons[i], i, bindings.triggerThreshold)) raw.push(i);
    }
    /* THE MASK, before the resolver sees anything. A button spent on opening or closing the
       in-match menu is dead until it is released, so the press that got the player out of the
       menu cannot also fire a shot on the way back in — `padNav.ts` says why. */
    const held = applyPadMask(raw);
    this.lostAt = 0;
    // with the triggers turning, the resolver plays a map with every bind on LT / RT dropped
    if (this.liveFrom !== bindings) {
      this.liveFrom = bindings;
      this.live = livePad(bindings);
    }
    const on = this.chords.resolve(held, this.live ?? bindings, now);
    const ax = (i: number): number => shape(pad.axes[i] ?? 0, bindings.deadzone, bindings.curve);
    // left stick = axes 0/1, right stick = axes 2/3
    const drive = bindings.driveStick === 'left' ? [0, 1] : [2, 3];
    const rotAxis = bindings.driveStick === 'left' ? 2 : 0;
    // the TRANSLATION stick is shaped as one 2D vector (radial deadzone); the turn axis and the
    // tank sticks are single axes and keep the 1D shape
    const [dx, dy] = shapeStick(pad.axes[drive[0]] ?? 0, pad.axes[drive[1]] ?? 0, bindings.deadzone, bindings.curve);
    // TURN WITH TRIGGERS: LT turns left (+, counter-clockwise, as `rotateCCW`), RT right. The
    // other stick then turns nothing, so a thumb resting on it cannot fight the triggers.
    const trig = (i: number): number => shape(triggerTravel(pad.buttons[i]), bindings.deadzone, bindings.curve);
    const rotate = bindings.turnWith === 'triggers' ? trig(PAD_TRIGGERS[0]) - trig(PAD_TRIGGERS[1]) : -ax(rotAxis);
    const sampleOut: GamepadSample = {
      connected: true,
      driveX: dx,
      driveY: -dy,
      rotate,
      leftY: -ax(1),
      rightY: -ax(3),
      fire: on.fire,
      intake: on.intake,
      catalyst: on.catalyst,
      fling: on.fling,
      bbPlaceNectar: on.bbPlaceNectar,
      bbPlace: on.bbPlace,
      bbNectar: on.bbNectar,
      bbRamp: on.bbRamp,
      bbPass: on.bbPass,
      driveMode: on.driveMode,
      flipFront: on.flipFront && !this.prevFlip,
      park: on.park && !this.prevPark,
      start: on.start && !this.prevStart,
      restart: on.restart && !this.prevRestart,
    };
    this.prevStart = on.start;
    this.prevRestart = on.restart;
    this.prevFlip = on.flipFront;
    this.prevPark = on.park;
    this.last = sampleOut;
    return sampleOut;
  }
}
