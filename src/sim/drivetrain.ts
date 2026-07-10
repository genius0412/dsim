import type { DrivetrainType, IntakeStyle, RobotSpec } from '../types';
import * as C from '../config';
import { clamp, approach } from '../math';

/** derived per-robot drive parameters. Everything the drivetrain influences
 * comes from the spec: type multipliers × RPM (speed up / accel down) × mass
 * (accel down, shove up — shove lives in the collision code). The BASE calibration
 * (SPEED_PER_RPM / BASE_DRIVE_ACCEL) is 75 in/s, 7 rad/s, 280 in/s² at mult=1; each
 * drivetrain rides above/below it (e.g. mecanum ×1.02 speed / ×1.06 accel). */
export interface DriveParams {
  maxSpeed: number; // in/s forward
  strafeMult: number;
  maxTurn: number; // rad/s
  accel: number; // in/s^2
  turnAccel: number; // rad/s^2
  saturation: 'sum' | 'tank' | 'vec';
}

const REF_SPEED = C.SPEED_PER_RPM * C.REF_DRIVE_RPM; // 75
const REF_TURN = 8.5; // rad/s of the reference (DEFAULT 15×18) chassis
// anchored to the DEFAULT chassis (15 long incl. intake budget × 18 wide) so the
// default robot still turns at 8.5 rad/s; smaller footprints turn quicker
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
    REF_TURN * (maxSpeed / REF_SPEED) * (REF_HALF_DIAG / halfDiag) * p.turnMult,
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

/** advance a velocity toward `target` for one tick using a DC-motor torque–speed
 * curve: available (stall) accel falls ~linearly from full at rest to
 * MOTOR_MIN_TORQUE_FRAC near the free speed `vFree`, so speed approaches the top
 * asymptotically instead of a constant ramp. Braking (target opposes v) pulls
 * harder (MOTOR_BRAKE_MULT). `MOTOR_TORQUE_CURVE` 0 ⇒ the old constant accel.
 * Deterministic (pure arithmetic); shared by fwd / strafe / turn. */
export function motorStep(v: number, target: number, aStall: number, vFree: number, dt: number): number {
  const err = target - v;
  if (err === 0) return v;
  const braking = v !== 0 && Math.sign(err) !== Math.sign(v);
  let frac: number;
  if (braking) {
    frac = C.MOTOR_BRAKE_MULT;
  } else {
    const s = vFree > 0 ? Math.min(Math.abs(v) / vFree, 1) : 0;
    frac = Math.max(1 - C.MOTOR_TORQUE_CURVE * s, C.MOTOR_MIN_TORQUE_FRAC);
  }
  return approach(v, target, aStall * frac * dt);
}

/** dev/tuning table: the resulting free speed / strafe / stall accel / push for
 * each drivetrain at the reference RPM+mass. Printed by the smoke suite so a
 * balance edit's effect is visible at a glance. */
export function driveSummary(): { dt: DrivetrainType; fwd: number; strafe: number; accel: number; push: number }[] {
  return (Object.keys(C.DRIVETRAIN_PRESETS) as DrivetrainType[]).map((dt) => {
    const p = C.DRIVETRAIN_PRESETS[dt];
    const fwd = C.SPEED_PER_RPM * C.REF_DRIVE_RPM * p.speedMult;
    return { dt, fwd, strafe: fwd * p.strafeMult, accel: C.BASE_DRIVE_ACCEL * p.accelMult, push: p.pushMult };
  });
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
