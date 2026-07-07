import type { Archetype, RobotSpec } from '../types';
import * as C from '../config';
import { clamp } from '../math';

/** every read of `spec.archetype` goes through here: old saves and old
 * clients on the wire simply omit the field, which means 'standard' */
export function archetypeOf(spec: RobotSpec): Archetype {
  return spec.archetype ?? 'standard';
}

export function hasTurret(spec: RobotSpec): boolean {
  return C.ARCHETYPE_PRESETS[archetypeOf(spec)].turret;
}

/** 3 for the tridexer archetypes (volley fire), 1 for standard */
export function shooterCount(spec: RobotSpec): number {
  return C.ARCHETYPE_PRESETS[archetypeOf(spec)].shooters;
}

/** force a spec legal for its archetype: drivetrain/intake allowlists (first
 * entry = fallback), dimension locks, per-archetype minimum mass, and no
 * sorter on volley archetypes (a volley fires the whole hopper — there is no
 * order to sort). Shared by the settings loader and the builder UI so both
 * sanitize identically. Returns a new spec; the input is not mutated. */
export function clampSpecToArchetype(spec: RobotSpec): RobotSpec {
  const a = C.ARCHETYPE_PRESETS[archetypeOf(spec)];
  const out: RobotSpec = { ...spec };
  if (!a.drivetrains.includes(out.drivetrain)) out.drivetrain = a.drivetrains[0];
  if (!a.intakes.includes(out.intake)) out.intake = a.intakes[0];
  const ip = C.INTAKE_PRESETS[out.intake];
  out.length = clamp(out.length, ip.minLength, ip.maxLength);
  if (a.lockLength !== null) out.length = a.lockLength;
  if (a.lockWidth !== null) out.width = a.lockWidth;
  const minMass = Math.max(a.minMass, out.drivetrain === 'swerve' ? 25 : 0);
  out.massLb = clamp(out.massLb, minMass, C.ROBOT_MAX_MASS);
  if (a.shooters > 1) out.canSort = false;
  return out;
}
