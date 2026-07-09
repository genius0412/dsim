import type { DrivetrainType, IntakeStyle, RobotSpec } from '../types';
import * as C from '../config';
import { clamp } from '../math';

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
const REF_TURN = 7.0; // rad/s of the reference (DEFAULT 15×18) chassis
// anchored to the DEFAULT chassis (15 long incl. intake budget × 18 wide) so the
// default robot still turns at 7 rad/s; smaller footprints turn quicker
const REF_HALF_DIAG = Math.sqrt(15 * 15 + 18 * 18) / 2;

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

/** the wheel-RPM range this drivetrain allows (torque-biased drivetrains cap
 * lower). Consumed by the builder sliders + settings validation. */
// ---- the loadout limit functions (SINGLE SOURCE shared by coerceSpec + the UI
// sliders). Each range is derived ONLY from the field(s) it depends on, so the
// builder's dependency order is explicit: intake → length/width, drivetrain →
// rpm, inertia → 0..1, then drivetrain×inertia → mass. ------------------------

/** chassis LENGTH range (in) — determined by the intake preset (its reach counts
 * toward the 18" cube, so each preset bakes in maxLength = 18 − reach). */
export function lengthLimits(intake: IntakeStyle): { min: number; max: number } {
  const p = C.INTAKE_PRESETS[intake];
  return { min: p.minLength, max: p.maxLength };
}

/** chassis WIDTH range (in). The intake extends the robot's LENGTH, not its
 * width, so the width envelope is the 18" cube — the same for every intake.
 * Kept intake-parameterized so this stays the one place width policy lives. */
export function widthLimits(_intake: IntakeStyle): { min: number; max: number } {
  return { min: C.ROBOT_MIN_WIDTH, max: C.ROBOT_MAX_SIZE };
}

export function rpmLimits(dt: DrivetrainType): { min: number; max: number } {
  const L = C.DRIVETRAIN_LIMITS[dt];
  return { min: L.minRpm, max: L.maxRpm };
}

/** the mass range this drivetrain allows, with the floor RAISED by flywheel
 * inertia (a bigger flywheel weighs more). At inertia 1 the floor climbs by
 * INERTIA_MASS_FLOOR, clamped to the drivetrain's max. */
export function massLimits(
  dt: DrivetrainType,
  flywheelInertia: number,
): { min: number; max: number } {
  const L = C.DRIVETRAIN_LIMITS[dt];
  const min = clamp(L.minMass + C.INERTIA_MASS_FLOOR * flywheelInertia, L.minMass, L.maxMass);
  return { min, max: L.maxMass };
}
