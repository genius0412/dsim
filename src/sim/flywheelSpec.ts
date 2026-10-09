import type { FlywheelSpec } from '../types';
import * as C from '../config';
import { clamp } from '../math';

/**
 * THE SETPOINT FLYWHEEL'S SHAPE — its coercer and its exit-speed law, and nothing that touches a
 * `RobotState`. A LEAF (types, config, math), so `games/biobuzz/coerce.ts`, which `coerceSpec`
 * itself depends on, can read it without an import cycle. The wheel's per-tick model is
 * `flywheel.ts`.
 */

/** the artifact's exit speed off a wheel of `wheelMm` turning `rpm`, in/s, capped at `FLY_EXIT_MAX` */
export function flyExitSpeedAt(wheelMm: number, rpm: number): number {
  return Math.min(C.FLY_EXIT_EFFICIENCY * Math.PI * (wheelMm / 25.4) * (rpm / 60), C.FLY_EXIT_MAX);
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * THE COERCER for `RobotSpec.flywheel` — shape only, game-blind, IDEMPOTENT. `undefined` for
 * anything that is not a usable flywheel (absent, wrong type, an unknown mode, no finite setpoint),
 * which is the solved-speed launcher every robot had before this existed.
 *
 * Setpoints are whole rpm in `FLY_RPM_MIN..FLY_RPM_MAX` (non-finite entries dropped), one for
 * `fixed` and one to `FLY_PRESETS_MAX` for `presets`; the wheel is whole millimetres; the feed is
 * rounded to 0.01 s. A `presets` list of one stays a `presets` build (the button just does nothing),
 * so the mode a player picked is never rewritten under them.
 */
export function coerceFlywheel(raw: unknown): FlywheelSpec | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const f = raw as Record<string, unknown>;
  const mode = f.mode === 'fixed' || f.mode === 'presets' ? f.mode : null;
  if (!mode) return undefined;
  const list = Array.isArray(f.rpm) ? f.rpm.slice(0, 8).filter(finite) : [];
  const want = mode === 'fixed' ? 1 : C.FLY_PRESETS_MAX;
  const rpm = list.slice(0, want).map((v) => Math.round(clamp(v, C.FLY_RPM_MIN, C.FLY_RPM_MAX)));
  if (rpm.length === 0) return undefined;
  const wheelMm = Math.round(
    clamp(finite(f.wheelMm) ? f.wheelMm : C.FLY_DEFAULT_WHEEL_MM, C.FLY_WHEEL_MM_MIN, C.FLY_WHEEL_MM_MAX),
  );
  const feedS =
    Math.round(clamp(finite(f.feedS) ? f.feedS : C.FLY_DEFAULT_FEED_S, C.FLY_FEED_S_MIN, C.FLY_FEED_S_MAX) * 100) / 100;
  return { mode, rpm, wheelMm, feedS };
}

/** do two specs carry the same setpoint flywheel (both absent counts)? For the preset cards'
 * match test, which compares BUILDS. */
export function flywheelEq(a: FlywheelSpec | undefined, b: FlywheelSpec | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.mode === b.mode &&
    a.wheelMm === b.wheelMm &&
    a.feedS === b.feedS &&
    a.rpm.length === b.rpm.length &&
    a.rpm.every((r, i) => r === b.rpm[i])
  );
}
