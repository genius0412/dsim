import type { RobotCommand } from '../types';
import { clamp } from '../math';
import { Keyboard } from './keyboard';
import { GamepadInput } from './gamepad';
import { KEY_ACTIONS, type ControlBindings } from './bindings';
import { installViewKey } from '../games/biobuzz/graphics/viewKey';

export interface VirtualInput {
  driveX: number;
  driveY: number;
  rotate: number;
  leftDrive: number;
  rightDrive: number;
  intake: boolean;
  fire: boolean;
  catalyst: boolean;
  fling: boolean;
  bbPlaceNectar: boolean;
  bbPlace: boolean;
  bbNectar: boolean;
  bbRamp: boolean;
  bbPass: boolean;
  driveMode: boolean;
  flyPreset: boolean;
}

/** merges keyboard + gamepad into one driver command per frame, resolving
 * physical keys/buttons through the user's ControlBindings */
export class InputManager {
  readonly keyboard = new Keyboard();
  private gamepad = new GamepadInput();
  gamepadConnected = false;
  /** edge-triggered "start match / confirm" from either device */
  startPressed = false;
  /** edge-triggered restart from either device */
  restartPressed = false;
  /** edge-triggered "flip robot front" from either device */
  flipPressed = false;
  /** edge-triggered "toggle park mode" from either device */
  parkPressed = false;

  private virtualState: VirtualInput = {
    driveX: 0,
    driveY: 0,
    rotate: 0,
    leftDrive: 0,
    rightDrive: 0,
    intake: false,
    fire: false,
    catalyst: false,
    fling: false,
    bbPlaceNectar: false,
    bbPlace: false,
    bbNectar: false,
    bbRamp: false,
    bbPass: false,
    driveMode: false,
    flyPreset: false,
  };

  constructor(private bindings: ControlBindings) {
    this.applyPreventKeys();
  }

  /**
   * THE FOUR EDGE ACTIONS a virtual control can fire. Flip, park, start and restart are not
   * command bits — they are edges the CONTROLLER reads off this manager once per frame — so
   * `setVirtualInput` cannot express them, and until this existed a touch driver could not
   * flip the front or park at all. `flipFront` and `park` are the two the touch pad draws;
   * `start` and `restart` are on-screen chrome already (the pre-match overlay and RESET), and
   * they are here so nothing has to grow a second mechanism if that ever changes.
   *
   * ⚠️ A TAP IS A LATCH, NOT A FRAME. `poll()` runs once per animation frame and CONSUMES it,
   * so a touch that lands between two frames still counts exactly once — the same reason the
   * pad's chord resolver holds a tap for `PAD_TAP_HOLD_MS` rather than one frame.
   */
  private virtualTaps: Record<'flipFront' | 'park' | 'start' | 'restart', boolean> = {
    flipFront: false,
    park: false,
    start: false,
    restart: false,
  };

  setVirtualInput(update: Partial<VirtualInput>): void {
    Object.assign(this.virtualState, update);
  }

  /** fire one edge action from a virtual control (the touch pad's tap buttons) */
  pressVirtual(action: 'flipFront' | 'park' | 'start' | 'restart'): void {
    this.virtualTaps[action] = true;
  }

  /** read and clear one latch — `poll()`'s consumer, never called anywhere else */
  private takeTap(action: 'flipFront' | 'park' | 'start' | 'restart'): boolean {
    const had = this.virtualTaps[action];
    this.virtualTaps[action] = false;
    return had;
  }

  setBindings(bindings: ControlBindings): void {
    this.bindings = bindings;
    this.applyPreventKeys();
  }

  private applyPreventKeys(): void {
    this.keyboard.setPreventKeys(KEY_ACTIONS.flatMap((a) => this.bindings.keys[a]));
  }

  /**
   * THE 2D ⇄ 3D VIEW KEY rides on this pair, and that is a deliberate placement rather than a
   * convenience (`docs/biobuzz/plan-3d.md` §4.3).
   *
   * `t` has to be live FOR THE WHOLE MATCH, in both views. The 3D scene used to own it and
   * could only ever go 3D → 2D: the listener died with the scene, so from the flat map there
   * was nothing left to press. The obvious home is the controller, but the controller is
   * another lane's file — and this is, in fact, the better home anyway: `attach`/`detach` is
   * exactly "a match is taking the keyboard", which is the window the key should be armed for,
   * and `InputManager` is already the module that owns what the keyboard means here.
   *
   * It is NOT a `KeyAction` in `bindings.ts`, and that is the one thing to be aware of: it does
   * not go through `poll()`, it does not reach a `RobotCommand`, and it is not rebindable. It
   * changes which RENDERER is mounted, which is not a robot input at all — and giving it a
   * binding row would owe a settings migration for a key that does nothing to the robot. `t` is
   * unbound in `DEFAULT_BINDINGS`, which is what makes that safe.
   *
   * `installViewKey` is reference-counted, so a Graphics screen or the touch controls holding
   * it at the same time is fine and the press still counts once.
   */
  private releaseViewKey: (() => void) | null = null;

  attach(): void {
    this.keyboard.attach();
    this.releaseViewKey ??= installViewKey();
  }

  detach(): void {
    this.keyboard.detach();
    this.releaseViewKey?.();
    this.releaseViewKey = null;
  }

  /** call once per animation frame; returns the merged command */
  poll(): RobotCommand {
    const k = this.keyboard;
    const keys = this.bindings.keys;
    const g = this.gamepad.sample(this.bindings.pad);
    this.gamepadConnected = g.connected;

    const heldAny = (list: string[]): boolean => list.some((key) => k.held(key));
    const pressedAny = (list: string[]): boolean =>
      list.reduce((hit, key) => k.justPressed(key) || hit, false);

    const kx = (heldAny(keys.driveRight) ? 1 : 0) - (heldAny(keys.driveLeft) ? 1 : 0);
    const ky = (heldAny(keys.driveUp) ? 1 : 0) - (heldAny(keys.driveDown) ? 1 : 0);
    const krot = (heldAny(keys.rotateCCW) ? 1 : 0) - (heldAny(keys.rotateCW) ? 1 : 0);

    // Tank drive specific keyboard mapping: the LEFT track shares the forward/back actions,
    // the RIGHT track has two of its own. Both sides go through `bindings`, or the right one
    // is the only control in the game a player cannot rebind.
    const kLeft = (heldAny(keys.driveUp) ? 1 : 0) - (heldAny(keys.driveDown) ? 1 : 0);
    const kRight = (heldAny(keys.tankRightUp) ? 1 : 0) - (heldAny(keys.tankRightDown) ? 1 : 0);

    // the virtual latch is read LAST and unconditionally, so a `||` short-circuit can never
    // leave one set to be spent on a later frame
    const vStart = this.takeTap('start');
    const vRestart = this.takeTap('restart');
    const vFlip = this.takeTap('flipFront');
    const vPark = this.takeTap('park');
    this.startPressed = pressedAny(keys.start) || g.start || vStart;
    this.restartPressed = pressedAny(keys.restart) || g.restart || vRestart;
    this.flipPressed = pressedAny(keys.flipFront) || g.flipFront || vFlip;
    this.parkPressed = pressedAny(keys.park) || g.park || vPark;

    const cmd: RobotCommand = {
      driveX: clamp(kx + g.driveX + this.virtualState.driveX, -1, 1),
      driveY: clamp(ky + g.driveY + this.virtualState.driveY, -1, 1),
      rotate: clamp(krot + g.rotate + this.virtualState.rotate, -1, 1),
      leftDrive: clamp(kLeft + g.leftY + this.virtualState.leftDrive, -1, 1),
      rightDrive: clamp(kRight + g.rightY + this.virtualState.rightDrive, -1, 1),
      intake: heldAny(keys.intake) || g.intake || this.virtualState.intake,
      fire: heldAny(keys.fire) || g.fire || this.virtualState.fire,
      // Chain Reaction ring pick-up/place — held; the sim edge-triggers it
      catalyst: heldAny(keys.catalyst) || g.catalyst || this.virtualState.catalyst,
      // CATAPULT throw — held; the sim edge-triggers it (same contract as `catalyst`)
      fling: heldAny(keys.fling) || g.fling || this.virtualState.fling,
      // BIOBUZZ vertical slide — genuinely held: the carriage rises while the button is down
      // and drives back to stowed when it is released.
      bbPlaceNectar: heldAny(keys.bbPlaceNectar) || g.bbPlaceNectar || this.virtualState.bbPlaceNectar,
      // BIOBUZZ place-into-a-FLOWER — held here even though the sim acts once per press, the
      // same contract as `catalyst` and `fling` (see `driveMode` below for why).
      bbPlace: heldAny(keys.bbPlace) || g.bbPlace || this.virtualState.bbPlace,
      // BIOBUZZ HUMAN PLAYER — held here, edge-detected in the sim, same contract as the three
      // above. Sim-side is the only place the edge can live: this is an ALLIANCE action that
      // either robot may trigger, so the press has to be reconciled and replayed like any
      // other command bit rather than latched on one client.
      bbNectar: heldAny(keys.bbNectar) || g.bbNectar || this.virtualState.bbNectar,
      // BIOBUZZ `ramp` intake — held here, edge-triggered in the sim off `bbRampHeld`, same
      // contract as `driveMode` below (a replayed input can't double-toggle a client-side edge).
      bbRamp: heldAny(keys.bbRamp) || g.bbRamp || this.virtualState.bbRamp,
      /* BIOBUZZ pass — held, and UNLIKE the ramp above it is NOT edge-triggered. This comment
         used to claim it was, "off `bbPassHeld`, exactly as the ramp above is: a held button
         passes once, not once per tick" — and `bbPassHeld` does not exist anywhere
         (`bbRampHeld` is real, on `RobotState`, which is what made the sentence read as true).
         A held pass fires CONTINUOUSLY at the launcher's own cadence, exactly like a held
         `fire` (`robot.ts`'s `bbLaunch`). That is the right behaviour — the cadence is what
         stops a burst, and a driver emptying a hopper to a partner should not have to tap —
         but a comment describing the opposite would send whoever reads it next looking for a
         latch that was never written. */
      bbPass: heldAny(keys.bbPass) || g.bbPass || this.virtualState.bbPass,
      // BUTTERFLY wheel-set swap — also passed HELD, edge-triggered in the sim. Doing the
      // edge sim-side (not here) keeps it deterministic under prediction + reconcile:
      // a replayed input can't double-toggle the way a client-side edge flag would.
      driveMode: heldAny(keys.driveMode) || g.driveMode || this.virtualState.driveMode,
      // a SETPOINT FLYWHEEL's preset step — held here, edge-triggered (debounced) in the sim, the
      // `driveMode` contract
      flyPreset: heldAny(keys.flyPreset) || g.flyPreset || this.virtualState.flyPreset,
    };
    k.endFrame();
    return cmd;
  }
}
