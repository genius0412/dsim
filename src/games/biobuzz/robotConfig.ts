import type { RobotSpec } from '../../types';
import { massLimits } from '../../sim/drivetrain';
import { coerceSpec } from '../../sim/spawn';
import { BB_DEFAULT_SPEC } from './coerce';
import {
  BB_HOOD_MAX_DEG,
  BB_HOOD_MIN_DEG,
  BB_LIFT_MAX_Z,
  BB_LIFT_MIN_Z,
  BB_STORAGE_MIN,
  bbMassFloorBump,
  bbSizeLimits,
  bbStorageMax,
} from './config';

/**
 * BIOBUZZ robot DIALS — the defaults and the sanitizing clamps.
 *
 * ── WHAT IS LEFT IN HERE ────────────────────────────────────────────────────
 * The DIAL RANGES the builder renders, and the named `bbCoerceSpec` wrapper. The clamps
 * themselves moved to the leaf `./coerce`, because `src/sim/spawn.ts`'s `coerceSpec` now runs
 * them as its `game === 'biobuzz'` arm and so cannot import a file that imports it back.
 * There is exactly ONE coercion chokepoint again, which is what `coerceSpec`'s header
 * promises and what the shell could not have until the arm landed.
 *
 * ── FIELD REUSE ─────────────────────────────────────────────────────────────
 * The shell rides the EXISTING shared mechanism fields (`intake`, `intakeMount`,
 * `shooterMount`, `scoreMode`, `ballStorage`) rather than minting `bb*` twins — see the header
 * of `mounts.ts` for why (the load-bearing reason is `footprintExtents`). So this coercer has
 * no `bb*`-prefixed fields to clamp yet; it clamps the shared fields THROUGH the BIOBUZZ
 * limits, which is the same guarantee under a different spelling. The moment Lane B adds a
 * genuinely new field, it is clamped here and nowhere else.
 */

/**
 * `BB_DEFAULT_SPEC` and `coerceBiobuzzSpec` live in the LEAF `./coerce`, re-exported here so
 * every existing importer is unchanged. They had to move: `src/sim/spawn.ts`'s
 * `game === 'biobuzz'` arm CALLS the coercer, which makes it a dependency of the shared
 * chokepoint, and this file imports `coerceSpec` from that chokepoint. See `./coerce`'s header.
 */
export { BB_DEFAULT_SPEC, coerceBiobuzzSpec } from './coerce';

/**
 * THE ONE COERCION A BIOBUZZ SPEC GETS — and it is now just the shared chokepoint.
 *
 * This function used to be a COMPOSITION with a repair in the middle: the shared pass, then
 * the raw mount fields RE-ARMED, then this game's own pass. The re-arming existed because
 * `coerceSpec` reset `intakeMount` and `shooterMount` to the Chain Reaction defaults for any
 * game it did not recognise — correct for DECODE, where those two fields move the collision
 * footprint, and destructive for BIOBUZZ, which was one of those games until the arm landed.
 * The visible cost was total: every turretless build spawned with a FRONT drum whatever edge
 * the player picked, and every turret spawned bolted to the front whatever the nine positions
 * offered, so the gallery's 26 archetype sheets rendered as 26 copies of two pictures.
 *
 * `src/sim/spawn.ts` now has the arm (it skips the mount reset for this game and finishes by
 * running `coerceBiobuzzSpec`), so there is nothing left to compose and nothing left to repair
 * — which is the point: ONE chokepoint, not two passes with a patch between them.
 *
 * It is kept as a NAME rather than inlined at its ~20 call sites because "the full coercion a
 * BIOBUZZ spec gets" is worth being able to say, and because `BB_DEFAULT_SPEC` as the default
 * base is the fact each of those call sites actually wants.
 */
export function bbCoerceSpec(raw: unknown, base: RobotSpec = BB_DEFAULT_SPEC): RobotSpec {
  return coerceSpec(raw, base, 'biobuzz');
}

/**
 * The DIAL RANGES the builder renders, as one object.
 *
 * Derived from the same functions the coercer uses rather than from parallel constants — a
 * slider whose bounds came from anywhere else is a slider that can offer a value the
 * chokepoint then clamps, which reads to the player as the control snapping back.
 *
 * `lift` and `hood` are the odd two out: `coerceBbMech` (`./coerce.ts`) clamps
 * `BbLiftSpec.maxZ` and `BbLauncherSpec.hoodDeg` against the bare constants
 * `BB_LIFT_MIN_Z`/`BB_LIFT_MAX_Z` and `BB_HOOD_MIN_DEG`/`BB_HOOD_MAX_DEG` — neither range
 * depends on the chassis the way size/mass/storage do, so there is no per-spec function to
 * call through. Routing them through this same object anyway (rather than importing the
 * constants straight into `Builder.tsx`) keeps the promise in one place: every BIOBUZZ slider
 * bound lives here, so a future mechanism that DOES make one of these spec-dependent is a
 * change to this function and not a hunt through the builder for a stray import.
 */
export function bbDials(spec: RobotSpec): {
  length: { min: number; max: number };
  width: { min: number; max: number };
  mass: { min: number; max: number };
  storage: { min: number; max: number };
  lift: { min: number; max: number };
  hood: { min: number; max: number };
} {
  const size = bbSizeLimits(spec);
  const mass = massLimits(spec.drivetrain, spec.flywheelInertia, bbMassFloorBump(spec));
  return {
    length: { min: size.minLength, max: Math.max(size.minLength, size.maxLength) },
    width: { min: size.minWidth, max: Math.max(size.minWidth, size.maxWidth) },
    mass,
    storage: { min: BB_STORAGE_MIN, max: bbStorageMax(spec) },
    lift: { min: BB_LIFT_MIN_Z, max: BB_LIFT_MAX_Z },
    hood: { min: BB_HOOD_MIN_DEG, max: BB_HOOD_MAX_DEG },
  };
}
