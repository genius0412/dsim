import type { GameSettings } from '../types';
import type { DrivetrainType, IntakeStyle, RobotSpec } from '../types';
import { MAX_SAVED_ROBOTS, ROBOT_MAX_SIZE, ROBOT_PRESETS } from '../config';
import { driveParams, lengthLimits, massLimits, rpmLimits, widthLimits } from '../sim/drivetrain';
import { coerceSpec } from '../sim/spawn';
import { RobotPreview } from './RobotPreview';
import { DRIVETRAIN_LABELS, INTAKE_SHORT } from './robotLabels';
import { APP_NAME } from '../seasons';

const DRIVETRAIN_BLURBS: Record<DrivetrainType, string> = {
  mecanum: '85% strafe · FTC standard',
  tank: 'No strafe · best push',
  swerve: 'Full-speed any direction',
  xdrive: 'Full-speed strafe',
};

const INTAKE_LABELS: Record<IntakeStyle, string> = {
  sloped: 'Sloped intake',
  vector: 'Vector wheel intake',
  triangle: 'Triangle intake',
};

/** the shooting range a flywheel inertia is tuned for: a LOW-inertia wheel spins
 * up fast for close rapid-fire, a HIGH-inertia wheel holds speed to sustain long
 * shots (matches the flywheel-recovery cadence model). */
function optimizedZone(inertia: number): string {
  if (inertia <= 0.4) return 'Close range';
  if (inertia <= 0.7) return 'Mid range';
  return 'Long range';
}

const INTAKE_BLURBS: Record<IntakeStyle, string> = {
  sloped: 'Face artifacts to scoop them up · eats clumps',
  vector: 'Grabs artifacts you strafe into',
  triangle: 'Long reach, eats clumps · slower transfer',
};

/** does the current spec exactly match a preset? (value compare) */
/** a preset match is about the BUILD only — name/team/number are the player's
 * own identity, never copied from (or compared against) a preset. */
function specMatches(a: RobotSpec, b: RobotSpec): boolean {
  return (
    a.length === b.length &&
    a.width === b.width &&
    a.intake === b.intake &&
    a.massLb === b.massLb &&
    a.drivetrain === b.drivetrain &&
    a.driveRpm === b.driveRpm &&
    a.flywheelInertia === b.flywheelInertia &&
    a.canSort === b.canSort
  );
}

interface Props {
  settings: GameSettings;
  onChange: (s: GameSettings) => void;
}

/**
 * My Robot — the robot loadout builder. Renders as shell content (inside the
 * AppShell top bar, like Home/Stats/Download). ROBOT-only by design: presets,
 * the custom builder, intake, and driver-preference tuning (drive style,
 * assists, park). Key/gamepad CONTROLS + the server region live in Account
 * settings (app-wide, not per-robot). Match configuration (game mode, alliance,
 * start position, auto path) lives on Home in `MatchSetup`, and matches are
 * started from Home — there is deliberately no "start match" here.
 */
export function Menu({ settings, onChange }: Props) {
  const set = (patch: Partial<GameSettings>) => onChange({ ...settings, ...patch });
  // any spec edit RE-CLAMPS all coupled values (mass floor moves with drivetrain +
  // flywheel inertia; rpm ceiling with drivetrain; length with the intake preset)
  const setSpec = (patch: Partial<GameSettings['spec']>) => {
    // STRICT: every edit runs through the SAME canonical validator as load / save /
    // server / spawn (coerceSpec), so the live spec can never hold an out-of-range
    // size, mass, speed, or inertia — length is clamped per intake preset, width to
    // the 18" cube, mass to the drivetrain×inertia floor/ceiling, rpm to the
    // drivetrain range, inertia to 0..1. Identity TEXT (name/team) is kept as typed;
    // it is length-capped on save, not mid-keystroke.
    const merged = { ...settings.spec, ...patch };
    const next: GameSettings['spec'] = {
      ...coerceSpec(merged),
      name: merged.name,
      teamName: merged.teamName,
    };
    onChange({ ...settings, spec: next });
  };
  const setAssist = (patch: Partial<GameSettings['assists']>) =>
    onChange({ ...settings, assists: { ...settings.assists, ...patch } });

  const spec = settings.spec;
  // slider envelopes come from the SAME limit functions coerceSpec clamps with,
  // in the same dependency order (intake → size, drivetrain → rpm, drivetrain ×
  // inertia → mass), so the UI and the validator can never disagree
  const { min: minLength, max: maxLength } = lengthLimits(spec.intake);
  const { min: minWidth, max: maxWidth } = widthLimits(spec.intake);
  const { min: minRpm, max: maxRpm } = rpmLimits(spec.drivetrain);
  const { min: minMass, max: maxMass } = massLimits(spec.drivetrain, spec.flywheelInertia);
  const dp = driveParams(spec);
  const isCustom = !ROBOT_PRESETS.some((p) => specMatches(spec, p));

  // ---- the player's SAVED robot library (their own full robots, up to 3) ----
  const savedRobots = settings.savedRobots;
  // a saved slot is the active one when the whole robot matches (identity + build)
  const sameRobot = (a: RobotSpec, b: RobotSpec): boolean =>
    specMatches(a, b) &&
    a.name === b.name &&
    a.teamName === b.teamName &&
    a.teamNumber === b.teamNumber;
  const alreadySaved = savedRobots.some((r) => sameRobot(spec, r));
  const saveCurrentRobot = (): void => {
    if (savedRobots.length >= MAX_SAVED_ROBOTS || alreadySaved) return;
    set({ savedRobots: [...savedRobots, { ...spec }] });
  };
  const deleteSavedRobot = (i: number): void =>
    set({ savedRobots: savedRobots.filter((_, j) => j !== i) });

  function selectIntake(intake: IntakeStyle) {
    // setSpec re-clamps chassis length into the new preset's range (18in cube)
    setSpec({ intake });
  }

  return (
    <>
      <p className="ds-eyebrow">{APP_NAME} · Loadout</p>
      <h1 className="ds-h1">My Robot</h1>
      <p className="ds-sub">Pick a preset or build your own. Match options live on Home.</p>

      <div className="ds-robot">
        {/* ---------- robot hero ---------- */}
        <div className="ds-hero">
          <div className="ds-hero-view">
            <RobotPreview spec={spec} />
          </div>
          <div className="ds-hero-info">
            <div>
              <div className="ds-hero-name">
                {spec.name || 'Unnamed'}
                {isCustom && <span className="cust">CUSTOM</span>}
              </div>
              <div className="ds-hero-team">
                {spec.teamName || 'No team'}
                {spec.teamNumber ? ` · #${spec.teamNumber}` : ''}
              </div>
            </div>
            <div className="ds-stats">
              <div className="ds-stat">
                <span className="sv">{dp.maxSpeed.toFixed(0)}</span>
                <span className="sl">in/s top</span>
              </div>
              <div className="ds-stat">
                <span className="sv">{dp.accel.toFixed(0)}</span>
                <span className="sl">in/s² accel</span>
              </div>
              <div className="ds-stat">
                <span className="sv">{dp.maxTurn.toFixed(1)}</span>
                <span className="sl">rad/s turn</span>
              </div>
              <div className="ds-stat">
                <span className="sv">{dp.turnAccel.toFixed(1)}</span>
                <span className="sl">rad/s² ang. accel</span>
              </div>
              <div className="ds-stat">
                <span className="sv">{spec.massLb}</span>
                <span className="sl">lb mass</span>
              </div>
              <div className="ds-stat">
                <span className="sv">{spec.driveRpm}</span>
                <span className="sl">drive rpm</span>
              </div>
              <div className="ds-stat">
                <span className="sv" style={{ fontSize: 13 }}>
                  {DRIVETRAIN_LABELS[spec.drivetrain]}
                </span>
                <span className="sl">drivetrain</span>
              </div>
              <div className="ds-stat">
                <span className="sv" style={{ fontSize: 13 }}>
                  {INTAKE_SHORT[spec.intake]}
                  {spec.canSort ? ' +sort' : ''}
                </span>
                <span className="sl">intake</span>
              </div>
            </div>
          </div>
        </div>

        {/* ---------- saved robots (the player's own garage) ---------- */}
        <section className="ds-sec">
          <h2>
            Saved robots <span className="ds-count">{savedRobots.length}/{MAX_SAVED_ROBOTS}</span>
          </h2>
          <div className="ds-opts">
            {savedRobots.map((r, i) => (
              <div
                key={i}
                className={`ds-opt ${sameRobot(spec, r) ? 'on' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => set({ spec: { ...r } })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') set({ spec: { ...r } });
                }}
              >
                <button
                  className="ds-opt-del"
                  title="Delete this robot"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteSavedRobot(i);
                  }}
                >
                  ✕
                </button>
                <span className="ot">{r.name || 'Unnamed'}</span>
                <span className="od">
                  {r.teamNumber ? `${r.teamNumber} · ` : ''}
                  {r.teamName || 'No team'}
                </span>
                <span className="om">
                  {DRIVETRAIN_LABELS[r.drivetrain]} · {r.massLb} lb · {r.driveRpm} RPM ·{' '}
                  {INTAKE_SHORT[r.intake]} · {r.flywheelInertia} inertia
                  {r.canSort ? ' · sorts' : ''}
                </span>
              </div>
            ))}
            {savedRobots.length < MAX_SAVED_ROBOTS && (
              <button
                className="ds-opt ds-opt-add"
                onClick={saveCurrentRobot}
                disabled={alreadySaved}
                title={alreadySaved ? 'This robot is already saved' : 'Save the current robot'}
              >
                <span className="ot">＋ Save current</span>
                <span className="od">
                  {alreadySaved
                    ? 'Already in your garage'
                    : `${spec.name || 'Unnamed'} → slot ${savedRobots.length + 1}`}
                </span>
              </button>
            )}
          </div>
        </section>

        {/* ---------- presets ---------- */}
        <section className="ds-sec">
          <h2>Presets</h2>
          <div className="ds-opts">
            {ROBOT_PRESETS.map((p) => (
              <button
                key={p.name}
                className={`ds-opt ${specMatches(spec, p) ? 'on' : ''}`}
                onClick={() =>
                  // copy the BUILD only — keep the player's own name/team/number
                  set({
                    spec: {
                      ...p,
                      name: spec.name,
                      teamName: spec.teamName,
                      teamNumber: spec.teamNumber,
                    },
                  })
                }
              >
                <span className="ot">{p.name}</span>
                <span className="od">
                  {p.teamNumber} · {p.teamName}
                </span>
                <span className="om">
                  {DRIVETRAIN_LABELS[p.drivetrain]} · {p.massLb} lb · {p.driveRpm} RPM ·{' '}
                  {INTAKE_SHORT[p.intake]} · {p.flywheelInertia} inertia
                  {p.canSort ? ' · sorts' : ''}
                </span>
                <span className="oz">🎯 {optimizedZone(p.flywheelInertia)}</span>
              </button>
            ))}
          </div>
        </section>

        {/* ---------- builder ---------- */}
        <section className="ds-sec">
          <h2>Customize</h2>
          <div className="ds-panelbox">
            <div className="ds-fields">
              <label className="ds-field">
                <span className="cap">Robot name</span>
                <input
                  className="ds-input"
                  type="text"
                  maxLength={24}
                  value={spec.name}
                  onChange={(e) => setSpec({ name: e.target.value })}
                />
              </label>
              <label className="ds-field">
                <span className="cap">Team name</span>
                <input
                  className="ds-input"
                  type="text"
                  maxLength={48}
                  value={spec.teamName}
                  onChange={(e) => setSpec({ teamName: e.target.value })}
                />
              </label>
              <label className="ds-field" style={{ flex: '0 1 110px' }}>
                <span className="cap">Team #</span>
                <input
                  className="ds-input"
                  type="number"
                  min={0}
                  max={99999}
                  value={spec.teamNumber || ''}
                  onChange={(e) =>
                    setSpec({ teamNumber: Math.max(0, Math.round(Number(e.target.value) || 0)) })
                  }
                />
              </label>
            </div>

            <div className="ds-opts four">
              {(Object.keys(DRIVETRAIN_LABELS) as DrivetrainType[]).map((d) => (
                <button
                  key={d}
                  className={`ds-opt mini ${spec.drivetrain === d ? 'on' : ''}`}
                  onClick={() => setSpec({ drivetrain: d })}
                >
                  <span className="ot">{DRIVETRAIN_LABELS[d]}</span>
                  <span className="od">{DRIVETRAIN_BLURBS[d]}</span>
                </button>
              ))}
            </div>

            <div className="ds-fields">
              <label className="ds-field">
                <span className="cap">
                  Length <span className="val">{spec.length}"</span>
                </span>
                <input
                  className="ds-range"
                  type="range"
                  min={minLength}
                  max={maxLength}
                  step={0.5}
                  value={spec.length}
                  onChange={(e) => setSpec({ length: Number(e.target.value) })}
                />
              </label>
              <label className="ds-field">
                <span className="cap">
                  Width <span className="val">{spec.width}"</span>
                </span>
                <input
                  className="ds-range"
                  type="range"
                  min={minWidth}
                  max={maxWidth}
                  step={0.5}
                  value={spec.width}
                  onChange={(e) => setSpec({ width: Number(e.target.value) })}
                />
              </label>
              <label className="ds-field">
                <span className="cap">
                  Mass <span className="val">{spec.massLb} lb</span>
                </span>
                <input
                  className="ds-range"
                  type="range"
                  min={minMass}
                  max={maxMass}
                  step={1}
                  value={spec.massLb}
                  onChange={(e) => setSpec({ massLb: Number(e.target.value) })}
                />
              </label>
            </div>

            <div className="ds-fields">
              <label className="ds-field">
                <span className="cap">
                  Drive RPM <span className="val">{spec.driveRpm}</span>
                </span>
                <input
                  className="ds-range"
                  type="range"
                  min={minRpm}
                  max={maxRpm}
                  step={5}
                  value={spec.driveRpm}
                  onChange={(e) => setSpec({ driveRpm: Number(e.target.value) })}
                />
              </label>
              <label className="ds-field">
                <span className="cap">
                  Flywheel inertia <span className="val">{spec.flywheelInertia.toFixed(2)}</span>
                </span>
                <input
                  className="ds-range"
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={spec.flywheelInertia}
                  // a bigger flywheel weighs more: setSpec raises the mass floor
                  // and pulls mass up with it so the loadout stays legal
                  onChange={(e) => setSpec({ flywheelInertia: Number(e.target.value) })}
                />
              </label>
              <button
                className={`ds-opt mini ${spec.canSort ? 'on' : ''}`}
                style={{ flex: '1 1 150px' }}
                onClick={() => setSpec({ canSort: !spec.canSort })}
              >
                <span className="ot">Sorter {spec.canSort ? 'ON' : 'OFF'}</span>
                <span className="od">Fires the color the motif needs</span>
              </button>
            </div>

            <p className="ds-hint">
              Heavier = more push, slower accel · higher RPM = faster top speed · more flywheel
              inertia keeps long shots rapid. Chassis + intake ≤ {ROBOT_MAX_SIZE}".
            </p>
          </div>

          <div className="ds-opts">
            {(Object.keys(INTAKE_LABELS) as IntakeStyle[]).map((i) => (
              <button
                key={i}
                className={`ds-opt ${spec.intake === i ? 'on' : ''}`}
                onClick={() => selectIntake(i)}
              >
                <span className="ot">{INTAKE_LABELS[i]}</span>
                <span className="od">{INTAKE_BLURBS[i]}</span>
              </button>
            ))}
          </div>
        </section>

        {/* ---------- driver preferences ---------- */}
        <section className="ds-sec">
          <h2>Drive style</h2>
          <div className="ds-opts two">
            <button
              className={`ds-opt ${settings.assists.fieldCentric ? 'on' : ''}`}
              onClick={() => setAssist({ fieldCentric: true })}
            >
              <span className="ot">Field-centric</span>
              <span className="od">Stick up always drives away from you</span>
            </button>
            <button
              className={`ds-opt ${!settings.assists.fieldCentric ? 'on' : ''}`}
              onClick={() => setAssist({ fieldCentric: false })}
            >
              <span className="ot">Robot-centric</span>
              <span className="od">Stick up drives toward the robot's front</span>
            </button>
          </div>
          {spec.drivetrain === 'tank' && (
            <div className="ds-opts two" style={{ marginTop: 12 }}>
              <button
                className={`ds-opt ${settings.tankControlMode === 'traditional' ? 'on' : ''}`}
                onClick={() => set({ tankControlMode: 'traditional' })}
              >
                <span className="ot">Traditional Tank</span>
                <span className="od">L-stick/W-S: Left · R-stick/Arrows: Right</span>
              </button>
              <button
                className={`ds-opt ${settings.tankControlMode === 'normal' ? 'on' : ''}`}
                onClick={() => set({ tankControlMode: 'normal' })}
              >
                <span className="ot">Normal Tank</span>
                <span className="od">L-stick/W-S: Fwd/Back · R-stick/Arrows: Turn</span>
              </button>
            </div>
          )}
        </section>

        <section className="ds-sec">
          <h2>Driver assists</h2>
          <div className="ds-opts">
            <button
              className={`ds-opt ${settings.assists.aimAssist ? 'on' : ''}`}
              onClick={() => setAssist({ aimAssist: !settings.assists.aimAssist })}
            >
              <span className="ot">Aim assist {settings.assists.aimAssist ? 'ON' : 'OFF'}</span>
              <span className="od">Turret auto-tracks the goal</span>
            </button>
            <button
              className={`ds-opt ${settings.assists.autoIntake ? 'on' : ''}`}
              onClick={() => setAssist({ autoIntake: !settings.assists.autoIntake })}
            >
              <span className="ot">Auto intake {settings.assists.autoIntake ? 'ON' : 'OFF'}</span>
              <span className="od">Runs when the hopper has room</span>
            </button>
            <button
              className={`ds-opt ${settings.assists.autoFire ? 'on' : ''}`}
              onClick={() => setAssist({ autoFire: !settings.assists.autoFire })}
            >
              <span className="ot">Auto fire {settings.assists.autoFire ? 'ON' : 'OFF'}</span>
              <span className="od">Fires inside the launch zone</span>
            </button>
          </div>
        </section>

        <section className="ds-sec">
          <h2>Park mode</h2>
          <div className="ds-panelbox">
            <label className="ds-field">
              <span className="cap">
                Speed cap <span className="val">{settings.parkSpeedPct}%</span>
              </span>
              <input
                className="ds-range"
                type="range"
                min={0}
                max={100}
                step={5}
                value={settings.parkSpeedPct}
                onChange={(e) => set({ parkSpeedPct: Number(e.target.value) })}
              />
            </label>
            <p className="ds-hint">
              Toggle with P or controller X. Caps drive speed for precise control — endgame only, or
              anytime in Free Drive.
            </p>
          </div>
        </section>
      </div>
    </>
  );
}
