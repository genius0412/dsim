import type { RobotState } from '../types';
import * as C from '../config';
import { clamp } from '../math';
import { driveParams } from './drivetrain';

/**
 * TURNING THE CHASSIS ONTO AN AIM — the rotate command a FIXED launcher's aim assist steers with,
 * shared by DECODE (`decodeFixedAimAssist`) and BIOBUZZ (`bbAimAssist`, the fixed kind only). A
 * BIOBUZZ dumper keeps its own P-controller; nothing else calls this.
 *
 * The command is a SPIN RATE, worked out from what this chassis can do (`driveParams`, slowed by
 * last tick's power draw as `updateRobot` slows it):
 *
 *   ω* = sign(err) · min( maxTurn,  √(2·a·|err|),  FIXED_AIM_SETTLE_RATE · |err| )
 *
 *   · `maxTurn` — the chassis cannot spin faster;
 *   · `√(2·a·|err|)` — the fastest spin it can still stop from inside the error that is left, `a`
 *     being `FIXED_AIM_DECEL_FRAC` of its braking authority (`MOTOR_BRAKE_MULT · turnAccel`), so it
 *     brakes onto the aim instead of past it;
 *   · `K·|err|` — the last stage, a first-order close of a quarter of the error per 60-Hz tick, which
 *     reaches zero without crossing it.
 * `motorStep` then moves the chassis's own angular velocity toward ω* under its torque and braking
 * limits, so a robot that is already spinning is braked onto the profile, not handed a new speed.
 *
 * WHY NOT THE OLD ONE. It was `clamp(4.5 · err, −1, 1)` with a dead band at the release tolerance:
 * a loop gain of 4.5·maxTurn = 27–54 /s, a half to nine-tenths of the error per tick before any
 * motor lag, no account of how hard the chassis can brake, and a dead band that parked it on the
 * EDGE of the release window. Measured: the DECODE kit parked 0.045 rad off; a swerve turning 30°
 * crossed to 0.16 rad (9°) the other side, 90° to 0.32. See `docs/area/decode.md`, "Fixed shooters".
 *
 * Returns the `rotate` value, −1..1 (`targetOmega = rotate · maxTurn`, the tank side drives at the
 * same rate). Deterministic: arithmetic only.
 */
export function fixedAimTurn(r: RobotState, err: number): number {
  const dp = driveParams(r.spec, r.butterflyTank);
  const slow = 1 - clamp(r.powerDraw ?? 0, 0, 1);
  const maxTurn = dp.maxTurn * slow;
  if (!(maxTurn > 0) || !Number.isFinite(err)) return 0;
  const a = dp.turnAccel * slow * C.MOTOR_BRAKE_MULT * C.FIXED_AIM_DECEL_FRAC;
  const e = Math.abs(err);
  // an import's practice tuning may cap the aim's turn below the chassis's (`ImportTuning.aimTurn`)
  const cap = r.spec.imported?.tune?.aimTurn;
  const top = cap !== undefined ? Math.min(maxTurn, ((cap * Math.PI) / 180) * slow) : maxTurn;
  const w = Math.min(top, Math.sqrt(2 * Math.max(a, 0) * e), C.FIXED_AIM_SETTLE_RATE * e);
  return clamp((Math.sign(err) * w) / maxTurn, -1, 1);
}
