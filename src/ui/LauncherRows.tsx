import type { FlywheelSpec, RobotSpec } from '../types';
import {
  DECODE_HOOD_MAX_DEG,
  DECODE_HOOD_MIN_DEG,
  DECODE_KIT_HOOD_DEG,
  FLY_DEFAULT_FEED_S,
  FLY_DEFAULT_RPM,
  FLY_DEFAULT_WHEEL_MM,
  FLY_FEED_S_MAX,
  FLY_FEED_S_MIN,
  FLY_PRESETS_MAX,
  FLY_RPM_MAX,
  FLY_RPM_MIN,
  FLY_WHEEL_MM_MAX,
  FLY_WHEEL_MM_MIN,
} from '../config';
import { flyExitSpeedAt } from '../sim/flywheelSpec';
import { rangeFill } from './rangeFill';

/**
 * THE FIXED-SHOOTER CONTROLS — DECODE's launcher block and the setpoint flywheel both games'
 * builders show (`RobotSpec.launcher` / `hoodDeg` / `flywheel`, `src/sim/fixedShot.ts`,
 * `src/sim/flywheel.ts`). Every slider's envelope is the coercer's own constant, so the builder
 * cannot offer a value the coercer would then rewrite (the `builderMechs.tsx` rule).
 *
 * Every edit is a PATCH for the host's `setSpec`, which re-coerces: a field set to `undefined`
 * is dropped there (`coerceSpec` reads these three off the raw input only), which is how
 * "Turret", "Adjustable" and "Auto" are spelled.
 */

/** the rpm slider's step: whole tens, so a dragged value lands on a number a team would write */
const RPM_STEP = 10;

/** the flywheel a build gets when its speed is first fixed: the kit's own wheel and feed */
function seedFlywheel(mode: FlywheelSpec['mode'], have: FlywheelSpec | undefined, defaultRpm: number): FlywheelSpec {
  const base = have ?? { mode, rpm: [defaultRpm], wheelMm: FLY_DEFAULT_WHEEL_MM, feedS: FLY_DEFAULT_FEED_S };
  if (mode === 'fixed') return { ...base, mode, rpm: [base.rpm[0]] };
  // PRESETS start as two: the setpoint the build had, and one a fifth faster — a near and a far
  const r0 = base.rpm[0];
  const rpm = base.rpm.length > 1 ? [...base.rpm] : [r0, Math.min(FLY_RPM_MAX, Math.round((r0 * 1.2) / RPM_STEP) * RPM_STEP)];
  return { ...base, mode, rpm };
}

/**
 * THE SETPOINT FLYWHEEL'S ROWS: the speed mode, then one slider per setpoint, the wheel and the
 * feeder. `allowAuto` is DECODE's — a solved-speed wheel; BIOBUZZ's fixed launcher always runs
 * at a setpoint. The exit speed each setpoint throws is printed beside it, because that number is
 * what decides the range and the rpm alone does not say it.
 */
export function FlywheelRows({
  spec,
  setSpec,
  allowAuto,
  allowPresets = true,
  defaultRpm = FLY_DEFAULT_RPM,
}: {
  spec: RobotSpec;
  setSpec: (patch: Partial<RobotSpec>) => void;
  allowAuto: boolean;
  /** BIOBUZZ's fixed launcher runs one setpoint (`coerceBiobuzzSpec`), so it offers no presets */
  allowPresets?: boolean;
  defaultRpm?: number;
}) {
  const fly = spec.flywheel;
  const mode: 'auto' | FlywheelSpec['mode'] = fly ? fly.mode : 'auto';
  const modes: readonly { id: 'auto' | FlywheelSpec['mode']; label: string; blurb: string }[] = [
    ...(allowAuto ? [{ id: 'auto' as const, label: 'Auto', blurb: 'Sets its speed for the range' }] : []),
    { id: 'fixed', label: 'One speed', blurb: 'One setpoint, one range' },
    ...(allowPresets ? [{ id: 'presets' as const, label: 'Presets', blurb: 'Step through up to three' }] : []),
  ];
  const pick = (m: 'auto' | FlywheelSpec['mode']) =>
    setSpec({ flywheel: m === 'auto' ? undefined : seedFlywheel(m, fly, defaultRpm) });
  const edit = (patch: Partial<FlywheelSpec>) => fly && setSpec({ flywheel: { ...fly, ...patch } });
  const setRpm = (i: number, v: number) => fly && edit({ rpm: fly.rpm.map((r, k) => (k === i ? v : r)) });
  const setCount = (n: number) => {
    if (!fly) return;
    const rpm = fly.rpm.slice(0, n);
    while (rpm.length < n) rpm.push(Math.min(FLY_RPM_MAX, Math.round((rpm[rpm.length - 1] * 1.2) / RPM_STEP) * RPM_STEP));
    edit({ rpm });
  };
  return (
    <>
      {/* a single mode is a statement, not a choice: no cards for it */}
      {modes.length > 1 && (
      <div className="ds-opts card4">
        {modes.map((m) => (
          <button
            key={m.id}
            className={`ds-opt ${mode === m.id ? 'on' : ''}`}
            aria-pressed={mode === m.id}
            onClick={() => pick(m.id)}
          >
            <span className="ot">{m.label}</span>
            <span className="od">{m.blurb}</span>
          </button>
        ))}
      </div>
      )}
      {fly && fly.mode === 'presets' && (
        <div className="ds-opts two">
          {[2, FLY_PRESETS_MAX].map((n) => (
            <button
              key={n}
              className={`ds-opt mini ${fly.rpm.length === n ? 'on' : ''}`}
              aria-pressed={fly.rpm.length === n}
              onClick={() => setCount(n)}
            >
              <span className="ot">{n} speeds</span>
            </button>
          ))}
        </div>
      )}
      {fly && (
        <div className="ds-fields">
          {fly.rpm.map((r, i) => (
            // ONE setpoint takes the row: "Flywheel speed" and "2411 rpm · 191 in/s" side by side
            // need ~260 px, and in the importer's column a third of the row is less, so both wrapped
            <label className={fly.rpm.length === 1 ? 'ds-field wide' : 'ds-field'} key={i}>
              <span className="cap">
                {fly.mode === 'presets' ? `Speed ${i + 1}` : 'Flywheel speed'}{' '}
                <span className="val">
                  {r} rpm · {Math.round(flyExitSpeedAt(fly.wheelMm, r))} in/s
                </span>
              </span>
              <input
                className="ds-range"
                type="range"
                min={FLY_RPM_MIN}
                max={FLY_RPM_MAX}
                step={RPM_STEP}
                value={r}
                style={rangeFill(r, FLY_RPM_MIN, FLY_RPM_MAX)}
                onChange={(e) => setRpm(i, Number(e.target.value))}
              />
            </label>
          ))}
          <label className="ds-field">
            <span className="cap">
              Flywheel wheel <span className="val">{fly.wheelMm} mm</span>
            </span>
            <input
              className="ds-range"
              type="range"
              min={FLY_WHEEL_MM_MIN}
              max={FLY_WHEEL_MM_MAX}
              step={1}
              value={fly.wheelMm}
              style={rangeFill(fly.wheelMm, FLY_WHEEL_MM_MIN, FLY_WHEEL_MM_MAX)}
              onChange={(e) => edit({ wheelMm: Number(e.target.value) })}
            />
          </label>
          <label className="ds-field">
            <span className="cap">
              Feed per shot <span className="val">{fly.feedS.toFixed(2)} s</span>
            </span>
            <input
              className="ds-range"
              type="range"
              min={FLY_FEED_S_MIN}
              max={FLY_FEED_S_MAX}
              step={0.01}
              value={fly.feedS}
              style={rangeFill(fly.feedS, FLY_FEED_S_MIN, FLY_FEED_S_MAX)}
              onChange={(e) => edit({ feedS: Number(e.target.value) })}
            />
          </label>
        </div>
      )}
    </>
  );
}

/**
 * A FIXED HOOD's angle slider — DECODE's top-level `hoodDeg`, or a BIOBUZZ fixed launcher's
 * `bbMech.launcher.hoodDeg`; the caller says which and what its range is.
 */
export function HoodSlider({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (deg: number) => void;
}) {
  return (
    <div className="ds-fields">
      <label className="ds-field">
        <span className="cap">
          Hood angle <span className="val">{value}°</span>
        </span>
        <input
          className="ds-range"
          type="range"
          min={min}
          max={max}
          step={1}
          value={value}
          style={rangeFill(value, min, max)}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </label>
    </div>
  );
}

/**
 * DECODE's LAUNCHER block: how it aims (turret or bolted to the chassis), its hood (adjustable or
 * one angle) and its flywheel (solved, one setpoint or presets). The defaults are today's robot —
 * a turret with an adjustable hood and a solved speed — so a player who never opens this block
 * builds exactly what every DECODE robot was.
 */
export function DecodeLauncherRows({
  spec,
  setSpec,
}: {
  spec: RobotSpec;
  setSpec: (patch: Partial<RobotSpec>) => void;
}) {
  const fixed = spec.launcher === 'fixed';
  const hoodFixed = spec.hoodDeg !== undefined;
  return (
    <>
      <div className="ds-opts card4">
        <button className={`ds-opt ${!fixed ? 'on' : ''}`} aria-pressed={!fixed} onClick={() => setSpec({ launcher: undefined })}>
          <span className="ot">Turret</span>
          <span className="od">Aims itself</span>
        </button>
        <button className={`ds-opt ${fixed ? 'on' : ''}`} aria-pressed={fixed} onClick={() => setSpec({ launcher: 'fixed' })}>
          <span className="ot">Fixed</span>
          <span className="od">Turn the robot to aim</span>
        </button>
      </div>
      <div className="ds-opts card4">
        <button
          className={`ds-opt ${!hoodFixed ? 'on' : ''}`}
          aria-pressed={!hoodFixed}
          onClick={() => setSpec({ hoodDeg: undefined })}
        >
          <span className="ot">Adjustable hood</span>
          <span className="od">Sets its angle for the range</span>
        </button>
        <button
          className={`ds-opt ${hoodFixed ? 'on' : ''}`}
          aria-pressed={hoodFixed}
          onClick={() => setSpec({ hoodDeg: spec.hoodDeg ?? DECODE_KIT_HOOD_DEG })}
        >
          <span className="ot">Fixed hood</span>
          <span className="od">One angle, built in</span>
        </button>
      </div>
      {hoodFixed && (
        <HoodSlider
          value={spec.hoodDeg ?? DECODE_KIT_HOOD_DEG}
          min={DECODE_HOOD_MIN_DEG}
          max={DECODE_HOOD_MAX_DEG}
          onChange={(hoodDeg) => setSpec({ hoodDeg })}
        />
      )}
      <FlywheelRows spec={spec} setSpec={setSpec} allowAuto />
    </>
  );
}
