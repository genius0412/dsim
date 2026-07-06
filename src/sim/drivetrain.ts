import type { RobotSpec } from '../types';
import * as C from '../config';

/** derived per-robot drive parameters. Everything the drivetrain influences
 * comes from the spec: type multipliers × RPM (speed up / accel down) × mass
 * (accel down, shove up — shove lives in the collision code). The reference
 * spec (mecanum, 435 rpm, 30 lb, 18×18) reproduces the original tuned
 * constants exactly: 75 in/s, 7 rad/s, 280 in/s². */
export interface DriveParams {
  maxSpeed: number; // in/s forward
  strafeMult: number;
  maxTurn: number; // rad/s
  accel: number; // in/s^2
  turnAccel: number; // rad/s^2
  saturation: 'sum' | 'tank' | 'vec';
}

const REF_SPEED = C.SPEED_PER_RPM * C.REF_DRIVE_RPM; // 75
const REF_TURN = 7.0; // rad/s of the reference 18x18 chassis
const REF_HALF_DIAG = Math.sqrt(18 * 18 + 18 * 18) / 2;

export function driveParams(spec: RobotSpec): DriveParams {
  const p = C.DRIVETRAIN_PRESETS[spec.drivetrain];
  const maxSpeed = C.SPEED_PER_RPM * spec.driveRpm * p.speedMult;
  const accel =
    C.BASE_DRIVE_ACCEL *
    (C.REF_DRIVE_RPM / spec.driveRpm) *
    (C.REF_MASS_LB / spec.massLb) *
    p.accelMult;
  // rotation tops out at wheel speed / half track diagonal, like a real
  // chassis: faster wheels or a smaller footprint turn quicker
  const halfDiag = Math.sqrt(spec.length * spec.length + spec.width * spec.width) / 2;
  const maxTurn = Math.min(
    REF_TURN * (maxSpeed / REF_SPEED) * (REF_HALF_DIAG / halfDiag),
    C.TURN_MAX_SPEED,
  );
  return {
    maxSpeed,
    strafeMult: p.strafeMult,
    maxTurn,
    accel,
    turnAccel: accel * C.TURN_ACCEL_PER_ACCEL,
    saturation: p.saturation,
  };
}
