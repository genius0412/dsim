import type { FlywheelSpec, RobotCommand, RobotSpec, RobotState } from '../types';
import * as C from '../config';
import { approach, clamp } from '../math';
import { debouncedPress } from './robot';
import { flyExitSpeedAt } from './flywheelSpec';

export { coerceFlywheel, flyExitSpeedAt } from './flywheelSpec';

/**
 * A SETPOINT FLYWHEEL — the speed half of a launcher that does not solve its own speed per shot.
 * Shared by DECODE and BIOBUZZ (`RobotSpec.flywheel`): a kit robot spins one wheel to one encoder
 * velocity (or to a few presets on bumpers) and feeds when the wheel is back up to speed, and
 * that is the same machine in both games.
 *
 * ── THE MODEL ────────────────────────────────────────────────────────────────
 *   · `RobotState.flyRpm` is the wheel's speed. It RAMPS toward the selected setpoint at
 *     `FLY_RAMP_RPM_S` (slower with `flywheelInertia`), and every artifact fed through takes
 *     `FLY_SHOT_DROP` of it away (less with inertia). Whole rpm, so the wire carries it exactly.
 *   · The feeder runs only while `flyRpm ≥ FLY_FEED_MIN_FRAC · setpoint` — the kit OpMode's own
 *     `getVelocity() > LAUNCHER_MIN_VELOCITY` — and takes `feedS` per artifact.
 *   · The artifact leaves at `FLY_EXIT_EFFICIENCY · π · wheel · flyRpm / 60`, the speed the wheel
 *     has when it is FED, not the setpoint: a shot fed the moment the wheel crosses the minimum
 *     leaves a little slower, exactly as the kit's first shot after a spin-up does.
 *
 * ── WHAT IT DOES NOT TOUCH ───────────────────────────────────────────────────
 * Every function here is reached only for a spec that HAS a `flywheel`. A robot without one never
 * carries `flyRpm` / `flyPreset`, so its JSON, its snapshot and `worldHash` are what they were.
 */

/** does this build run a setpoint flywheel? */
export function flyOf(spec: RobotSpec): FlywheelSpec | null {
  return spec.flywheel ?? null;
}

/** the selected preset index, in range */
export function flyPresetIndex(r: RobotState): number {
  const f = r.spec.flywheel;
  if (!f) return 0;
  const i = r.flyPreset ?? 0;
  return i >= 0 && i < f.rpm.length ? i : 0;
}

/** the setpoint the wheel is running to right now, rpm (0 for a build without one) */
export function flySetpoint(r: RobotState): number {
  const f = r.spec.flywheel;
  return f ? f.rpm[flyPresetIndex(r)] : 0;
}

/** the speed the feeder waits for, rpm */
export function flyFeedMin(r: RobotState): number {
  return flySetpoint(r) * C.FLY_FEED_MIN_FRAC;
}

/** is the wheel up to speed — may the feeder run? Always true for a build without a setpoint. */
export function flyReady(r: RobotState): boolean {
  if (!r.spec.flywheel) return true;
  return (r.flyRpm ?? 0) >= flyFeedMin(r);
}

/** has a fixed shooter's feed time run out (`fireReadyAt`, set to `time + feedS` at each feed)?
 * Within `FLY_FEED_TIME_EPS`, so a feed of a whole number of ticks takes exactly that many. Both
 * games' fixed launchers read their feed clock through this. */
export function flyFeedDue(r: RobotState, world: { time: number; simPatch?: number }): boolean {
  // a replay recorded before `SIM_PATCH` 4 keeps the exact comparison it ran
  const eps = C.simPatchAtLeast(world, 4) ? C.FLY_FEED_TIME_EPS : 0;
  return world.time + eps >= r.fireReadyAt;
}

/** the exit speed this robot's wheel gives an artifact fed NOW, in/s */
export function flyExitSpeed(r: RobotState): number {
  const f = r.spec.flywheel;
  if (!f) return 0;
  return flyExitSpeedAt(f.wheelMm, r.flyRpm ?? 0);
}

/** the exit speed at the selected SETPOINT — what aim and the shot preview plan around */
export function flyPlannedSpeed(r: RobotState): number {
  const f = r.spec.flywheel;
  if (!f) return 0;
  return flyExitSpeedAt(f.wheelMm, flySetpoint(r));
}

/** spawn: the wheel is already at its first setpoint (DECODE's rule — no spin-up before the
 * first shot). Writes nothing for a build without a flywheel. */
export function flySeed(r: RobotState): void {
  const f = r.spec.flywheel;
  if (!f) return;
  r.flyRpm = Math.round(f.rpm[0]);
  if (f.mode === 'presets') r.flyPreset = 0;
}

/**
 * ONE TICK OF THE WHEEL: the preset button (a debounced edge, presets builds only, ignored while
 * the robots are disabled) and the ramp toward the selected setpoint. Writes nothing for a build
 * without a flywheel.
 */
export function flyStep(r: RobotState, cmd: RobotCommand | undefined, enabled: boolean, time: number, dt: number): void {
  const f = r.spec.flywheel;
  if (!f) return;
  if (f.mode === 'presets') {
    const p = debouncedPress(r.flyPresetHeld ?? false, r.flyPresetUpAt, enabled && !!cmd?.flyPreset, time);
    r.flyPresetHeld = p.held;
    if (p.upAt === undefined) delete r.flyPresetUpAt;
    else r.flyPresetUpAt = p.upAt;
    if (p.press) r.flyPreset = (flyPresetIndex(r) + 1) % f.rpm.length;
  }
  const spinUp = r.spec.imported?.tune?.spinUp;
  const rate = spinUp !== undefined ? spinUp : C.FLY_RAMP_RPM_S * (1 - C.FLY_RAMP_INERTIA_SLOW * clamp(r.spec.flywheelInertia, 0, 1));
  r.flyRpm = Math.round(approach(r.flyRpm ?? 0, flySetpoint(r), rate * dt));
}

/** an artifact went through: the wheel gives up a fraction of its speed */
export function flyShot(r: RobotState): void {
  if (!r.spec.flywheel) return;
  const cut = 1 - C.FLY_SHOT_DROP_INERTIA_CUT * clamp(r.spec.flywheelInertia, 0, 1);
  const rpm = r.flyRpm ?? 0;
  r.flyRpm = Math.max(0, Math.round(rpm - rpm * C.FLY_SHOT_DROP * cut));
}
