import type { PadBindings } from './bindings';
import { PadChordResolver } from './padChords';
import { applyPadMask, clearPadMask } from './padNav';

/** deadzone + sensitivity curve: below `deadzone` reads as dead center; past
 * it, the remaining travel is rescaled to 0-1 and raised to `curve` (1 =
 * linear, higher = softer near center / more precise low-speed control,
 * still reaching full deflection at the stick's edge — the classic RC/gaming
 * "expo" curve), then given back the original sign. */
const shape = (v: number, deadzone: number, curve: number): number => {
  const av = Math.abs(v);
  if (av < deadzone) return 0;
  const scaled = (av - deadzone) / (1 - deadzone);
  return Math.sign(v) * Math.pow(scaled, curve);
};

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
 * user's PadBindings: the drive stick translates, the other stick's X turns.
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
      const b = pad.buttons[i];
      if (b && (b.pressed || b.value > bindings.triggerThreshold)) raw.push(i);
    }
    /* THE MASK, before the resolver sees anything. A button spent on opening or closing the
       in-match menu is dead until it is released, so the press that got the player out of the
       menu cannot also fire a shot on the way back in — `padNav.ts` says why. */
    const held = applyPadMask(raw);
    this.lostAt = 0;
    const on = this.chords.resolve(held, bindings, now);
    const ax = (i: number): number => shape(pad.axes[i] ?? 0, bindings.deadzone, bindings.curve);
    // left stick = axes 0/1, right stick = axes 2/3
    const drive = bindings.driveStick === 'left' ? [0, 1] : [2, 3];
    const rotAxis = bindings.driveStick === 'left' ? 2 : 0;
    const sampleOut: GamepadSample = {
      connected: true,
      driveX: ax(drive[0]),
      driveY: -ax(drive[1]),
      rotate: -ax(rotAxis),
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
