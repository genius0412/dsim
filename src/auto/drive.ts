/**
 * PEDRO POWERS -> STICKS: the one place a follower's robot-frame power triple becomes a
 * `RobotCommand`, by inverting `updateRobot` (`src/sim/robot.ts`) exactly, the way the BIOBUZZ
 * bot's `command()` does for a wanted direction.
 *
 * Pedro writes `forward`, `strafe` (to the robot's LEFT) and `turn` (counter-clockwise), and its
 * mecanum normalisation divides by `max(1, |f| + |s| + |t|)`, which is DSIM's `sum` saturation
 * to the letter. A robot-centric stick is `{ x: -strafe, y: forward }` (stick right is strafe
 * right, `updateRobot`'s `robotVec = { x: stick.y, y: -stick.x }`), `rotate` is the turn, and
 * power 1 is the drivetrain's own top speed — so the follower drives DSIM's chassis through its
 * motor model, traction and power draw, never around them.
 *
 * Field-centric drivers are inverted through the heading and the alliance's view angle, the
 * same way `updateRobot` applies them. Quantization is the caller's (`localizeCommand`), as for
 * every command the recorder stores.
 *
 * ── A TANK STEERS INTO THE MOTION PEDRO ASKS FOR ──────────────────────────────────────────────
 * Zenith's follower is Pedro's MECANUM follower and nothing else (its robot schema has no
 * drivetrain kind, and `createLiveRun` hands back a holonomic triple), so on a robot that
 * cannot strafe the lateral part of every request, the path's cross-track correction included,
 * used to be DROPPED. A tank facing a little off its path then had no way back onto it: the
 * follower kept asking for sideways motion, the robot sat still, and the step never ended
 * (measured: StarterBot on garden-cycle stalled on the first leg, ~96 in short, for all 30 s).
 *
 * `nonHolonomic` turns the request into what a differential drive CAN do, the way a pure
 * pursuit does: the requested direction of travel (the angle of forward and strafe) becomes a
 * heading error, the chassis turns into it at the robot file's heading gain, and forward power
 * is scaled by cos² of that error, so the robot mostly turns while it faces away and mostly
 * drives once it faces the way it should go. A request pointing behind the robot is driven in
 * REVERSE (the tail is steered instead of the nose), which is what `tangentReversed` legs and a
 * small overshoot both want. When the request is small (a hold at the end of a path, a turn in
 * place) Pedro's own turn is blended back in, so a held end heading is still held.
 *
 * Still only sticks: this writes no pose and no heading, and it is a pure function of its
 * inputs, so it is deterministic (the `d*` trig wrappers, no `hypot`).
 */
import { driveParams } from '../sim/drivetrain';
import { viewAngleOf } from '../sim/field';
import { clamp, datan2, dcos, hyp, rot } from '../math';
import type { RobotCommand, RobotState } from '../types';
import type { AutoButtons } from './types';

export interface DrivePowerTriple {
  forward: number;
  strafe: number;
  turn: number;
}

/** Pedro's heading gain in the robot file (power per rad of heading error), used to steer a tank. */
const TANK_STEER_GAIN = 2.5239;
/** Below this requested translation power a tank blends back to Pedro's own turn (holds, turns in place). */
const TANK_BLEND_POWER = 0.2;

/**
 * A holonomic request as a tank can drive it: `forward` along the nose (negative = reverse) and
 * `turn` (CCW), both in the follower's power units. Pure; exported for the AUTO lane.
 */
export function nonHolonomic(p: DrivePowerTriple): { forward: number; turn: number } {
  const mag = hyp(p.forward, p.strafe);
  if (mag < 1e-9) return { forward: 0, turn: p.turn };
  // the direction of travel in the robot frame (+ = to the left, i.e. a CCW turn toward it)
  const travel = datan2(p.strafe, p.forward);
  const reverse = travel > Math.PI / 2 || travel < -Math.PI / 2;
  // the heading error of the END that leads: the nose forwards, the tail in reverse
  const err = reverse ? (travel > 0 ? travel - Math.PI : travel + Math.PI) : travel;
  const c = dcos(err);
  const forward = (reverse ? -1 : 1) * mag * c * c;
  const steer = clamp(TANK_STEER_GAIN * err, -1, 1);
  const w = clamp(mag / TANK_BLEND_POWER, 0, 1);
  return { forward, turn: w * steer + (1 - w) * p.turn };
}

export function powersToCommand(r: RobotState, p: DrivePowerTriple, buttons: AutoButtons): RobotCommand {
  const dp = driveParams(r.spec, r.butterflyTank);
  const f = Number.isFinite(p.forward) ? p.forward : 0;
  const s = Number.isFinite(p.strafe) ? p.strafe : 0;
  const t = Number.isFinite(p.turn) ? p.turn : 0;
  // `bbRamp` rides only while pressed, so a command that never presses it is the one it always was
  const base = { intake: buttons.intake, fire: buttons.fire, ...(buttons.bbRamp ? { bbRamp: true } : {}) };
  if (dp.saturation === 'tank') {
    // `updateRobot`'s tank: forward = (ld + rd) / 2, turn = (rd - ld) / 2, in units of full
    // speed and full turn. A tank cannot strafe, so the request is steered (`nonHolonomic`), and
    // the pair is scaled down together so neither side clips and the arc keeps its shape.
    const d = nonHolonomic({ forward: f, strafe: s, turn: t });
    const div = Math.max(1, Math.abs(d.forward) + Math.abs(d.turn));
    return {
      driveX: 0,
      driveY: 0,
      rotate: 0,
      leftDrive: clamp((d.forward - d.turn) / div, -1, 1),
      rightDrive: clamp((d.forward + d.turn) / div, -1, 1),
      ...base,
    };
  }
  if (dp.strafeMult === 0) {
    // a drivetrain that takes sticks but cannot strafe (`updateRobot` zeroes the lateral axis):
    // steered the same way, through the forward stick and the turn
    const d = nonHolonomic({ forward: f, strafe: s, turn: t });
    const stick = r.fieldCentric ? rot(rot({ x: d.forward, y: 0 }, r.heading), viewAngleOf(r.alliance)) : { x: 0, y: d.forward };
    return { driveX: clamp(stick.x, -1, 1), driveY: clamp(stick.y, -1, 1), rotate: clamp(d.turn, -1, 1), leftDrive: 0, rightDrive: 0, ...base };
  }
  // the robot-frame drive vector updateRobot would build (+x forward, +y left)
  const robotVec = { x: f, y: s };
  let stick: { x: number; y: number };
  if (r.fieldCentric) stick = rot(rot(robotVec, r.heading), viewAngleOf(r.alliance));
  else stick = { x: -robotVec.y, y: robotVec.x };
  // Sticks are clamped to [-1, 1] as a controller's are; updateRobot's own saturation then
  // divides by the combined demand, so a clamped axis is the only thing that can change the
  // direction, and Pedro's powers are already inside the budget whenever it matters.
  return {
    driveX: clamp(stick.x, -1, 1),
    driveY: clamp(stick.y, -1, 1),
    rotate: clamp(t, -1, 1),
    leftDrive: 0,
    rightDrive: 0,
    ...base,
  };
}
