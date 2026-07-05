import type { RobotCommand } from '../types';
import { clamp } from '../math';
import { Keyboard } from './keyboard';
import { GamepadInput } from './gamepad';

/** merges keyboard + gamepad into one driver command per frame */
export class InputManager {
  readonly keyboard = new Keyboard();
  private gamepad = new GamepadInput();
  gamepadConnected = false;
  /** edge-triggered "start match / confirm" from either device */
  startPressed = false;

  attach(): void {
    this.keyboard.attach();
  }

  detach(): void {
    this.keyboard.detach();
  }

  /** call once per animation frame; returns the merged command */
  poll(): RobotCommand {
    const k = this.keyboard;
    const g = this.gamepad.sample();
    this.gamepadConnected = g.connected;

    const kx = (k.held('d') ? 1 : 0) - (k.held('a') ? 1 : 0);
    const ky = (k.held('w') ? 1 : 0) - (k.held('s') ? 1 : 0);
    const krot =
      (k.held('arrowleft') || k.held('q') ? 1 : 0) -
      (k.held('arrowright') || k.held('e') ? 1 : 0);

    this.startPressed = k.justPressed('enter') || g.start;

    const cmd: RobotCommand = {
      driveX: clamp(kx + g.driveX, -1, 1),
      driveY: clamp(ky + g.driveY, -1, 1),
      rotate: clamp(krot + g.rotate, -1, 1),
      intake: k.held('shift') || k.held('k') || g.intake,
      fire: k.held(' ') || g.fire,
    };
    k.endFrame();
    return cmd;
  }
}
