import type { PadBindings } from './bindings';

const DEADZONE = 0.12;

const dz = (v: number): number =>
  Math.abs(v) < DEADZONE ? 0 : (v - Math.sign(v) * DEADZONE) / (1 - DEADZONE);

export interface GamepadSample {
  connected: boolean;
  driveX: number;
  driveY: number;
  rotate: number;
  fire: boolean;
  intake: boolean;
  flipFront: boolean;
  start: boolean;
  restart: boolean;
}

const EMPTY: GamepadSample = {
  connected: false,
  driveX: 0,
  driveY: 0,
  rotate: 0,
  fire: false,
  intake: false,
  flipFront: false,
  start: false,
  restart: false,
};

/** standard-mapping gamepad. Stick roles and button assignments come from the
 * user's PadBindings: the drive stick translates, the other stick's X turns. */
export class GamepadInput {
  private prevStart = false;
  private prevRestart = false;
  private prevFlip = false;

  sample(bindings: PadBindings): GamepadSample {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = Array.from(pads).find((p) => p && p.connected) ?? null;
    if (!pad) {
      this.prevStart = false;
      this.prevRestart = false;
      this.prevFlip = false;
      return { ...EMPTY };
    }
    const btn = (i: number): boolean =>
      pad.buttons[i] ? pad.buttons[i].pressed || pad.buttons[i].value > 0.35 : false;
    const anyBtn = (idxs: number[]): boolean => idxs.some(btn);
    const ax = (i: number): number => dz(pad.axes[i] ?? 0);
    // left stick = axes 0/1, right stick = axes 2/3
    const drive = bindings.driveStick === 'left' ? [0, 1] : [2, 3];
    const rotAxis = bindings.driveStick === 'left' ? 2 : 0;
    const startNow = anyBtn(bindings.buttons.start);
    const restartNow = anyBtn(bindings.buttons.restart);
    const flipNow = anyBtn(bindings.buttons.flipFront);
    const sampleOut: GamepadSample = {
      connected: true,
      driveX: ax(drive[0]),
      driveY: -ax(drive[1]),
      rotate: -ax(rotAxis),
      fire: anyBtn(bindings.buttons.fire),
      intake: anyBtn(bindings.buttons.intake),
      flipFront: flipNow && !this.prevFlip,
      start: startNow && !this.prevStart,
      restart: restartNow && !this.prevRestart,
    };
    this.prevStart = startNow;
    this.prevRestart = restartNow;
    this.prevFlip = flipNow;
    return sampleOut;
  }
}
