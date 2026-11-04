/**
 * HOLD OR TOGGLE, APPLIED (`ControlBindings.modes`, `MODE_ACTIONS` in `bindings.ts`).
 *
 * DOM-free and clock-free (`now` is passed in), so `npm test` drives both halves on synthetic
 * input. `InputManager.poll` owns one of these per mode action and feeds it the RAW level —
 * keyboard OR pad — once per frame.
 *
 * Two directions, two mechanisms:
 *
 *   ToggleLatch   a HELD action (Intake, Shoot, Place NECTAR, Pass, Reverse intake) played as a
 *                 toggle. Each press flips a latch and the command carries the latch, so the sim
 *                 sees a long hold. Nothing in the sim changes.
 *   HoldFollower  a SIM TOGGLE (Deploy ramp, NECTAR bar, Swap wheel set) played as hold. The sim
 *                 flips its state on each press edge (`debouncedPress`), so "deployed while held"
 *                 cannot be a level on the wire. Instead this presses FOR the player whenever what
 *                 they hold and what the robot is disagree, reading the robot back each frame.
 *
 * Flip front and Park mode are client-side toggles already (`GameController.frameLogic`), so
 * their Hold mode is the raw level and needs neither class.
 */

/**
 * A RELEASE SHORTER THAN THIS IS NOT A RELEASE (ms). The client's twin of the sim's
 * `TOGGLE_DEBOUNCE_S` (2.5 ticks): replay 1dc6eb8f held a toggle through a one-frame dropout and
 * it flipped twice. A latch here would do the same on a trigger hovering at its threshold.
 */
export const RELEASE_DEBOUNCE_MS = 42;

/** HELD → TOGGLE. One latch per action. */
export class ToggleLatch {
  /** what the command carries */
  on = false;
  private down = false;
  /** when the level went low while `down` is still latched; null otherwise */
  private upAt: number | null = null;

  /** feed this frame's raw level; returns the latched state */
  step(level: boolean, now: number): boolean {
    if (level) {
      const released = this.upAt !== null && now - this.upAt >= RELEASE_DEBOUNCE_MS;
      if (!this.down || released) this.on = !this.on;
      this.down = true;
      this.upAt = null;
    } else if (this.down) {
      if (this.upAt === null) this.upAt = now;
      else if (now - this.upAt >= RELEASE_DEBOUNCE_MS) {
        this.down = false;
        this.upAt = null;
      }
    }
    return this.on;
  }

  /** off again (a restart). A button still down stays down, so it is not a fresh press. */
  reset(): void {
    this.on = false;
  }
}

/** what a `HoldFollower` reads off the local robot each frame */
export interface SimToggleState {
  /** the toggled state: ramp deployed, traction wheels down */
  on: boolean;
  /** the sim's own press latch (`bbRampHeld`, `driveModeHeld`): while set, a held bit is not a
   *  new press, so the follower has to let go first */
  latched: boolean;
}

/**
 * SIM TOGGLE → HOLD. The wish is "on while held"; the bit it sends is a press, and only when
 * the wish and the robot disagree.
 *
 * ⚠️ IT PRESSES ONCE PER CHANGE OF WISH, NOT UNTIL THE ROBOT AGREES. The ramp's swing guard
 * reverses a swing that would hit a static (`bbRampReverse`), and a follower that kept pressing
 * would deploy it into the flower again and again for as long as the button stayed down. So a
 * press is ARMED when the held level changes and disarmed the first time the robot matches it;
 * a reversal after that is left alone, exactly as one press of the toggle would leave it.
 *
 * A press the sim will not take yet (pre-match, where the ramp drops every press) stays armed
 * and lands when it can, so holding the ramp through the countdown deploys it at the start.
 */
export class HoldFollower {
  private want = false;
  private armed = false;
  /** when the level went low while `want` is still set; null otherwise */
  private upAt: number | null = null;

  /** feed this frame's raw level and the robot; returns the command bit. With no robot to read
   *  the level passes straight through, which is the old behaviour. */
  step(level: boolean, state: SimToggleState | null, now: number): boolean {
    if (!state) return level;
    // a release shorter than RELEASE_DEBOUNCE_MS is a dropout, and folding the ramp on one would
    // cost a whole swing out and back
    if (level) this.upAt = null;
    else if (this.want && this.upAt === null) this.upAt = now;
    const wish = level || (this.want && this.upAt !== null && now - this.upAt < RELEASE_DEBOUNCE_MS);
    if (wish !== this.want) {
      this.want = wish;
      this.armed = wish !== state.on;
      this.upAt = null;
    }
    if (this.armed && state.on === this.want) this.armed = false;
    // while the sim's latch is still set from the last press, a held bit would only extend it:
    // send nothing until it clears, then the press
    return this.armed && !state.latched;
  }

  reset(): void {
    this.want = false;
    this.armed = false;
  }
}
