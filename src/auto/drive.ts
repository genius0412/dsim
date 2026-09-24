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
 * same way `updateRobot` applies them; a tank gets its two side drives. Quantization is the
 * caller's (`localizeCommand`), as for every command the recorder stores.
 */
import { driveParams } from '../sim/drivetrain';
import { viewAngleOf } from '../sim/field';
import { clamp, rot } from '../math';
import type { RobotCommand, RobotState } from '../types';
import type { AutoButtons } from './types';

export interface DrivePowerTriple {
  forward: number;
  strafe: number;
  turn: number;
}

export function powersToCommand(r: RobotState, p: DrivePowerTriple, buttons: AutoButtons): RobotCommand {
  const dp = driveParams(r.spec, r.butterflyTank);
  const f = Number.isFinite(p.forward) ? p.forward : 0;
  const s = Number.isFinite(p.strafe) ? p.strafe : 0;
  const t = Number.isFinite(p.turn) ? p.turn : 0;
  const base = { intake: buttons.intake, fire: buttons.fire };
  if (dp.saturation === 'tank') {
    // `updateRobot`'s tank: forward = (ld + rd) / 2, turn = (rd - ld) / 2, in units of full
    // speed and full turn. A tank cannot strafe, so Pedro's strafe is dropped, and the pair is
    // scaled down together so neither side clips and the arc keeps its shape.
    const div = Math.max(1, Math.abs(f) + Math.abs(t));
    return {
      driveX: 0,
      driveY: 0,
      rotate: 0,
      leftDrive: clamp((f - t) / div, -1, 1),
      rightDrive: clamp((f + t) / div, -1, 1),
      ...base,
    };
  }
  // the robot-frame drive vector updateRobot would build (+x forward, +y left)
  const robotVec = { x: f, y: dp.strafeMult === 0 ? 0 : s };
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
