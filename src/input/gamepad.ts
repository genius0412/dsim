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
  start: boolean;
  restart: boolean;
}

/** standard-mapping gamepad: left stick translate, right stick X rotate,
 * RT/A fire, LT/B intake, Start begins the match, Back/Select restarts */
export class GamepadInput {
  private prevStart = false;
  private prevRestart = false;

  sample(): GamepadSample {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = Array.from(pads).find((p) => p && p.connected) ?? null;
    if (!pad) {
      this.prevStart = false;
      this.prevRestart = false;
      return {
        connected: false,
        driveX: 0,
        driveY: 0,
        rotate: 0,
        fire: false,
        intake: false,
        start: false,
        restart: false,
      };
    }
    const btn = (i: number): boolean =>
      pad.buttons[i] ? pad.buttons[i].pressed || pad.buttons[i].value > 0.35 : false;
    const startNow = btn(9);
    const restartNow = btn(8); // Back / Select / View
    const sampleOut: GamepadSample = {
      connected: true,
      driveX: dz(pad.axes[0] ?? 0),
      driveY: -dz(pad.axes[1] ?? 0),
      rotate: -dz(pad.axes[2] ?? 0),
      fire: btn(7) || btn(0), // RT or A
      intake: btn(6) || btn(1), // LT or B
      start: startNow && !this.prevStart,
      restart: restartNow && !this.prevRestart,
    };
    this.prevStart = startNow;
    this.prevRestart = restartNow;
    return sampleOut;
  }
}
