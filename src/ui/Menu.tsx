import type { GameSettings } from '../game';
import type { DrivetrainType, IntakeStyle, RobotSpec } from '../types';
import {
  INTAKE_PRESETS,
  ROBOT_MAX_SIZE,
  ROBOT_MIN_WIDTH,
  ROBOT_MIN_MASS,
  ROBOT_MAX_MASS,
  ROBOT_MIN_RPM,
  ROBOT_MAX_RPM,
  ROBOT_PRESETS,
  START_POSES,
} from '../config';
import { driveParams } from '../sim/drivetrain';
import { ControlsSection } from './ControlsSection';

const DRIVETRAIN_LABELS: Record<DrivetrainType, string> = {
  mecanum: 'Mecanum',
  tank: 'Tank',
  swerve: 'Swerve',
  xdrive: 'X-drive',
};

const DRIVETRAIN_BLURBS: Record<DrivetrainType, string> = {
  mecanum: 'Full strafe at 85% — the FTC standard',
  tank: 'No strafe; best straight-line speed and push',
  swerve: 'Full-speed any direction; nimble',
  xdrive: 'Full-speed strafe, slightly slower overall',
};

const INTAKE_LABELS: Record<IntakeStyle, string> = {
  sloped: 'Sloped intake',
  vector: 'Vector wheel intake',
  triangle: 'Triangle intake',
};

const INTAKE_BLURBS: Record<IntakeStyle, string> = {
  sloped: 'Trapezoid mouth in the frame — face the artifact and it rolls up; devours clumps',
  vector:
    'Vertical compliant wheels ahead of the chassis (11.5–14.5") — overhanging a narrower chassis they grab artifacts you strafe into',
  triangle:
    'Stores artifacts in a triangle; long trapezoid mouth devours clumps — slower transfer to the shooter (0.3s)',
};

/** does the current spec exactly match a preset? (value compare) */
function specMatches(a: RobotSpec, b: RobotSpec): boolean {
  return (
    a.name === b.name &&
    a.teamName === b.teamName &&
    a.teamNumber === b.teamNumber &&
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

function driveStats(spec: RobotSpec): string {
  const p = driveParams(spec);
  return `${p.maxSpeed.toFixed(0)} in/s · ${p.maxTurn.toFixed(1)} rad/s`;
}

interface Props {
  settings: GameSettings;
  onChange: (s: GameSettings) => void;
  onStart: () => void;
  /** open the multiplayer lobby; undefined ⇒ Supabase not configured */
  onMultiplayer?: () => void;
}

export function Menu({ settings, onChange, onStart, onMultiplayer }: Props) {
  const set = (patch: Partial<GameSettings>) => onChange({ ...settings, ...patch });
  const setSpec = (patch: Partial<GameSettings['spec']>) =>
    onChange({ ...settings, spec: { ...settings.spec, ...patch } });
  const setAssist = (patch: Partial<GameSettings['assists']>) =>
    onChange({ ...settings, assists: { ...settings.assists, ...patch } });

  const isSwerve = settings.spec.drivetrain === 'swerve';
  const minMass = isSwerve ? 25 : ROBOT_MIN_MASS;
  const maxRpm = isSwerve ? 500 : ROBOT_MAX_RPM;

  return (
    <div className="menu-root">
      <div className="menu-panel">
        <header className="menu-header">
          <h1>
            DECODE<span className="accent">SIM</span>
          </h1>
          <p className="subtitle">FIRST Tech Challenge 2025–26 · 2D driver practice</p>
        </header>

        <section>
          <h2>Game mode</h2>
          <div className="card-row">
            <button
              className={`card ${settings.mode === 'match' ? 'selected' : ''}`}
              onClick={() => set({ mode: 'match' })}
            >
              <strong>Solo Match</strong>
              <span>30s AUTO · 8s transition · 2:00 TELEOP, full DECODE scoring</span>
            </button>
            <button
              className={`card ${settings.mode === 'free' ? 'selected' : ''}`}
              onClick={() => set({ mode: 'free' })}
            >
              <strong>Free Drive</strong>
              <span>No timer, no launch-zone limits — just practice</span>
            </button>
          </div>
        </section>

        <section>
          <h2>Alliance</h2>
          <div className="card-row">
            <button
              className={`card alliance-red ${settings.alliance === 'red' ? 'selected' : ''}`}
              onClick={() => set({ alliance: 'red' })}
            >
              <strong>RED</strong>
              <span>You stand at the red wall — your goal is cross-court, top-left of your view</span>
            </button>
            <button
              className={`card alliance-blue ${settings.alliance === 'blue' ? 'selected' : ''}`}
              onClick={() => set({ alliance: 'blue' })}
            >
              <strong>BLUE</strong>
              <span>You stand at the blue wall — your goal is cross-court, top-right of your view</span>
            </button>
          </div>
        </section>

        <section>
          <h2>Drive style</h2>
          <div className="card-row">
            <button
              className={`card ${settings.assists.fieldCentric ? 'selected' : ''}`}
              onClick={() => setAssist({ fieldCentric: true })}
            >
              <strong>Field-centric</strong>
              <span>Stick up always drives away from you</span>
            </button>
            <button
              className={`card ${!settings.assists.fieldCentric ? 'selected' : ''}`}
              onClick={() => setAssist({ fieldCentric: false })}
            >
              <strong>Robot-centric</strong>
              <span>Stick up drives toward the robot's front</span>
            </button>
          </div>
        </section>

        <section>
          <h2>Driver assists</h2>
          <div className="card-row">
            <button
              className={`card ${settings.assists.aimAssist ? 'selected' : ''}`}
              onClick={() => setAssist({ aimAssist: !settings.assists.aimAssist })}
            >
              <strong>Aim assist {settings.assists.aimAssist ? 'ON' : 'OFF'}</strong>
              <span>Turret always tracks the firing solution</span>
            </button>
            <button
              className={`card ${settings.assists.autoIntake ? 'selected' : ''}`}
              onClick={() => setAssist({ autoIntake: !settings.assists.autoIntake })}
            >
              <strong>Auto intake {settings.assists.autoIntake ? 'ON' : 'OFF'}</strong>
              <span>Intake runs whenever the hopper has room</span>
            </button>
            <button
              className={`card ${settings.assists.autoFire ? 'selected' : ''}`}
              onClick={() => setAssist({ autoFire: !settings.assists.autoFire })}
            >
              <strong>Auto fire {settings.assists.autoFire ? 'ON' : 'OFF'}</strong>
              <span>Shoots automatically inside the launch zone</span>
            </button>
          </div>
        </section>

        <section>
          <h2>Park mode</h2>
          <div className="spec-row">
            <label>
              Speed cap {settings.parkSpeedPct}%
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={settings.parkSpeedPct}
                onChange={(e) => set({ parkSpeedPct: Number(e.target.value) })}
              />
            </label>
          </div>
          <p className="hint">
            Toggle with P (keyboard) or X (controller) — only in the last 20s of teleop, or
            anytime in Free Drive. Caps drive speed to the percentage above for precise control.
          </p>
        </section>

        <section>
          <h2>Robot</h2>
          <div className="card-row wrap">
            {ROBOT_PRESETS.map((p) => (
              <button
                key={p.name}
                className={`card preset-card ${specMatches(settings.spec, p) ? 'selected' : ''}`}
                onClick={() => set({ spec: { ...p } })}
              >
                <strong>{p.name}</strong>
                <span>
                  {p.teamNumber} · {p.teamName}
                </span>
                <span className="preset-stats">
                  {DRIVETRAIN_LABELS[p.drivetrain]} · {p.massLb} lb · {p.driveRpm} RPM ·{' '}
                  {INTAKE_LABELS[p.intake]}
                  {p.canSort ? ' · sorts' : ''}
                </span>
              </button>
            ))}
          </div>

          <div className="builder">
            <h3>
              {ROBOT_PRESETS.some((p) => specMatches(settings.spec, p))
                ? 'Tweak it (becomes Custom)'
                : 'Custom robot'}
            </h3>
            <div className="spec-row">
              <label>
                Robot name
                <input
                  type="text"
                  maxLength={24}
                  value={settings.spec.name}
                  onChange={(e) => setSpec({ name: e.target.value })}
                />
              </label>
              <label>
                Team name
                <input
                  type="text"
                  maxLength={24}
                  value={settings.spec.teamName}
                  onChange={(e) => setSpec({ teamName: e.target.value })}
                />
              </label>
              <label>
                Team #
                <input
                  type="number"
                  min={0}
                  max={99999}
                  value={settings.spec.teamNumber || ''}
                  onChange={(e) =>
                    setSpec({ teamNumber: Math.max(0, Math.round(Number(e.target.value) || 0)) })
                  }
                />
              </label>
            </div>
            <div className="card-row">
              {(Object.keys(DRIVETRAIN_LABELS) as DrivetrainType[]).map((d) => (
                <button
                  key={d}
                  className={`card mini ${settings.spec.drivetrain === d ? 'selected' : ''}`}
                  onClick={() => setSpec({ drivetrain: d })}
                >
                  <strong>{DRIVETRAIN_LABELS[d]}</strong>
                  <span>{DRIVETRAIN_BLURBS[d]}</span>
                </button>
              ))}
            </div>
            <div className="spec-row">
              <label>
                Length {settings.spec.length}"
                <input
                  type="range"
                  min={INTAKE_PRESETS[settings.spec.intake].minLength}
                  max={INTAKE_PRESETS[settings.spec.intake].maxLength}
                  step={0.5}
                  value={settings.spec.length}
                  onChange={(e) => setSpec({ length: Number(e.target.value) })}
                />
              </label>
              <label>
                Width {settings.spec.width}"
                <input
                  type="range"
                  min={ROBOT_MIN_WIDTH}
                  max={ROBOT_MAX_SIZE}
                  step={0.5}
                  value={settings.spec.width}
                  onChange={(e) => setSpec({ width: Number(e.target.value) })}
                />
              </label>
              <label>
                Mass {settings.spec.massLb} lb
                <input
                  type="range"
                  min={minMass}
                  max={ROBOT_MAX_MASS}
                  step={1}
                  value={settings.spec.massLb}
                  onChange={(e) => setSpec({ massLb: Number(e.target.value) })}
                />
              </label>
            </div>
            <div className="spec-row">
              <label>
                Drive RPM {settings.spec.driveRpm}
                <input
                  type="range"
                  min={ROBOT_MIN_RPM}
                  max={maxRpm}
                  step={5}
                  value={settings.spec.driveRpm}
                  onChange={(e) => setSpec({ driveRpm: Number(e.target.value) })}
                />
              </label>
              <label>
                Flywheel inertia {settings.spec.flywheelInertia.toFixed(2)}
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={settings.spec.flywheelInertia}
                  onChange={(e) => setSpec({ flywheelInertia: Number(e.target.value) })}
                />
              </label>
              <button
                className={`card mini ${settings.spec.canSort ? 'selected' : ''}`}
                onClick={() => setSpec({ canSort: !settings.spec.canSort })}
              >
                <strong>Sorter {settings.spec.canSort ? 'ON' : 'OFF'}</strong>
                <span>Fires the color the motif needs next</span>
              </button>
            </div>
            <p className="hint">
              Heavier shoves harder but accelerates slower · higher RPM = faster top speed, softer
              punch · high flywheel inertia keeps rapid fire fast on long-range shots. Speed/turn:{' '}
              {driveStats(settings.spec)}. Chassis + intake reach ≤ {ROBOT_MAX_SIZE}"; base parking
              counts only the wheels.
            </p>
          </div>

          <div className="card-row">
            {(Object.keys(INTAKE_LABELS) as IntakeStyle[]).map((i) => (
              <button
                key={i}
                className={`card ${settings.spec.intake === i ? 'selected' : ''}`}
                onClick={() => selectIntake(i)}
              >
                <strong>{INTAKE_LABELS[i]}</strong>
                <span>{INTAKE_BLURBS[i]}</span>
              </button>
            ))}
          </div>
        </section>

        <section>
          <h2>Start position</h2>
          <div className="card-row">
            {START_POSES.map((p, i) => (
              <button
                key={p.label}
                className={`card mini ${settings.startIndex === i ? 'selected' : ''}`}
                onClick={() => set({ startIndex: i })}
              >
                <strong>{p.label}</strong>
                <span>launch zone, mirrored to your alliance</span>
              </button>
            ))}
            {settings.mode === 'free' && (
              <button
                className={`card mini ${settings.practiceDummies ? 'selected' : ''}`}
                onClick={() => set({ practiceDummies: !settings.practiceDummies })}
              >
                <strong>Practice dummies {settings.practiceDummies ? 'ON' : 'OFF'}</strong>
                <span>Three idle robots on the field to push against</span>
              </button>
            )}
          </div>
        </section>

        <section>
          <h2>Audio</h2>
          <div className="card-row">
            <button
              className={`card ${settings.audio.sounds ? 'selected' : ''}`}
              onClick={() =>
                set({ audio: { ...settings.audio, sounds: !settings.audio.sounds } })
              }
            >
              <strong>Sounds {settings.audio.sounds ? 'ON' : 'OFF'}</strong>
              <span>Match sounds, countdowns, and voice — everything</span>
            </button>
            <button
              className={`card ${settings.audio.voice ? 'selected' : ''}`}
              onClick={() =>
                set({ audio: { ...settings.audio, voice: !settings.audio.voice } })
              }
            >
              <strong>Voice lines {settings.audio.voice ? 'ON' : 'OFF'}</strong>
              <span>Announcer countdowns; beeps are used when off</span>
            </button>
          </div>
        </section>

        <ControlsSection
          bindings={settings.bindings}
          onChange={(bindings) => set({ bindings })}
        />

        <button className="start-btn" onClick={onStart}>
          ENTER FIELD
        </button>
        {onMultiplayer && (
          <button className="start-btn secondary" onClick={onMultiplayer}>
            ▲ MULTIPLAYER (2v2)
          </button>
        )}
      </div>
    </div>
  );

  function selectIntake(intake: IntakeStyle) {
    // keep chassis length inside the preset's legal range (18in cap etc.)
    const p = INTAKE_PRESETS[intake];
    setSpec({ intake, length: Math.min(Math.max(settings.spec.length, p.minLength), p.maxLength) });
  }
}
