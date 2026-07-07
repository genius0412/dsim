import type { GameSettings } from '../types';
import type {
  AppearancePattern,
  Archetype,
  DrivetrainType,
  IntakeStyle,
  RobotSpec,
} from '../types';
import {
  ARCHETYPE_PRESETS,
  DEFAULT_APPEARANCE,
  INTAKE_PRESETS,
  ROBOT_MAX_SIZE,
  ROBOT_MIN_WIDTH,
  ROBOT_MIN_MASS,
  ROBOT_MAX_MASS,
  ROBOT_MIN_RPM,
  ROBOT_MAX_RPM,
  ROBOT_PRESETS,
} from '../config';
import { archetypeOf, clampSpecToArchetype } from '../sim/archetype';
import { driveParams } from '../sim/drivetrain';
import { ControlsSection } from './ControlsSection';
import { RobotPreview } from './RobotPreview';
import { APP_NAME } from '../seasons';

const DRIVETRAIN_LABELS: Record<DrivetrainType, string> = {
  mecanum: 'Mecanum',
  tank: 'Tank',
  swerve: 'Swerve',
  xdrive: 'X-drive',
};

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
  tridexer: 'Tridexer intake',
};

const INTAKE_SHORT: Record<IntakeStyle, string> = {
  sloped: 'Sloped',
  vector: 'Vector',
  triangle: 'Triangle',
  tridexer: 'Tridexer',
};

const INTAKE_BLURBS: Record<IntakeStyle, string> = {
  sloped: 'Face artifacts to scoop them up · eats clumps',
  vector: 'Grabs artifacts you strafe into',
  triangle: 'Long reach, eats clumps · slower transfer',
  tridexer: 'Full-width bar · inhales a whole line at once',
};

const ARCHETYPE_BLURBS: Record<Archetype, string> = {
  standard: '1 turreted shooter · full builder freedom',
  single: '1 fixed shooter · no turret — align the chassis to shoot (hold Auto-align)',
  double: '2 fixed shooters, volley or indexed · no turret · no vector intake',
  spindexer: 'Turreted · Toggle indexing between sorting indexer and fast passthrough',
  tridexer: '3 fixed shooters, volley or indexed · no turret — align to shoot (hold Auto-align)',
  turreted: '3 shooters in a triangle, on a turret · volley or indexed · 18×18 · heavy',
};

const PATTERN_LABELS: Record<AppearancePattern, string> = {
  none: 'Plain',
  stripes: 'Racing stripes',
  diagonal: 'Hazard bands',
  checker: 'Checkerboard',
  split: 'Two-tone split',
};

/** does the current spec exactly match a preset? (value compare — the
 * cosmetic `appearance` is deliberately ignored so a repaint isn't "custom") */
function specMatches(a: RobotSpec, b: RobotSpec): boolean {
  return (
    archetypeOf(a) === archetypeOf(b) &&
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

interface Props {
  settings: GameSettings;
  onChange: (s: GameSettings) => void;
}

/**
 * My Robot — the robot loadout builder. Renders as shell content (inside the
 * AppShell top bar, like Home/Stats/Download). ROBOT-only by design: presets,
 * the custom builder, intake, and driver-preference tuning (drive style,
 * assists, park, controls). Match configuration (game mode, alliance, start
 * position, auto path) lives on Home in `MatchSetup`, and matches are started
 * from Home — there is deliberately no "start match" here.
 */
export function Menu({ settings, onChange }: Props) {
  const set = (patch: Partial<GameSettings>) => onChange({ ...settings, ...patch });
  const setSpec = (patch: Partial<GameSettings['spec']>) =>
    onChange({ ...settings, spec: { ...settings.spec, ...patch } });
  const setAssist = (patch: Partial<GameSettings['assists']>) =>
    onChange({ ...settings, assists: { ...settings.assists, ...patch } });

  const spec = settings.spec;
  const arch = ARCHETYPE_PRESETS[archetypeOf(spec)];
  const volley = arch.shooters > 1;
  const noSorter = volley || arch.builtinSort;
  const isSwerve = spec.drivetrain === 'swerve';
  const minMass = Math.max(arch.minMass, isSwerve ? 25 : ROBOT_MIN_MASS);
  const maxRpm = isSwerve ? 500 : ROBOT_MAX_RPM;
  const dp = driveParams(spec);
  const isCustom = !ROBOT_PRESETS.some((p) => specMatches(spec, p));
  const appearance = spec.appearance ?? DEFAULT_APPEARANCE;

  function selectArchetype(archetype: Archetype) {
    // re-clamp the whole spec into the archetype's build rules (drivetrain/
    // intake allowlists, dimension locks, minimum mass, no sorter on volley)
    set({ spec: clampSpecToArchetype({ ...spec, archetype }) });
  }

  function selectIntake(intake: IntakeStyle) {
    // keep chassis length inside the preset's legal range (18in cap etc.),
    // unless the archetype locks the length outright
    const p = INTAKE_PRESETS[intake];
    const length =
      arch.lockLength ?? Math.min(Math.max(spec.length, p.minLength), p.maxLength);
    setSpec({ intake, length });
  }

  function setAppearance(patch: Partial<typeof appearance>) {
    setSpec({ appearance: { ...appearance, ...patch } });
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
                <span className="sv">{dp.maxTurn.toFixed(1)}</span>
                <span className="sl">rad/s turn</span>
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

        {/* ---------- presets ---------- */}
        <section className="ds-sec">
          <h2>Presets</h2>
          <div className="ds-opts">
            {ROBOT_PRESETS.map((p) => (
              <button
                key={p.name}
                className={`ds-opt ${specMatches(spec, p) ? 'on' : ''}`}
                onClick={() => set({ spec: { ...p } })}
              >
                <span className="ot">{p.name}</span>
                <span className="od">
                  {p.teamNumber} · {p.teamName}
                </span>
                <span className="om">
                  {archetypeOf(p) !== 'standard' ? `${ARCHETYPE_PRESETS[archetypeOf(p)].label} · ` : ''}
                  {DRIVETRAIN_LABELS[p.drivetrain]} · {p.massLb} lb · {p.driveRpm} RPM ·{' '}
                  {INTAKE_SHORT[p.intake]}
                  {p.canSort ? ' · sorts' : ''}
                </span>
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
                  maxLength={24}
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

            <div className="ds-opts">
              {(Object.keys(ARCHETYPE_PRESETS) as Archetype[]).map((a) => (
                <button
                  key={a}
                  className={`ds-opt ${archetypeOf(spec) === a ? 'on' : ''}`}
                  onClick={() => selectArchetype(a)}
                >
                  <span className="ot">{ARCHETYPE_PRESETS[a].label}</span>
                  <span className="od">{ARCHETYPE_BLURBS[a]}</span>
                </button>
              ))}
            </div>

            <div className="ds-opts four">
              {(Object.keys(DRIVETRAIN_LABELS) as DrivetrainType[]).map((d) => {
                const allowed = arch.drivetrains.includes(d);
                return (
                  <button
                    key={d}
                    className={`ds-opt mini ${spec.drivetrain === d ? 'on' : ''}`}
                    disabled={!allowed}
                    onClick={() => setSpec(clampSpecToArchetype({ ...spec, drivetrain: d }))}
                  >
                    <span className="ot">{DRIVETRAIN_LABELS[d]}</span>
                    <span className="od">
                      {allowed ? DRIVETRAIN_BLURBS[d] : `Not on a ${arch.label}`}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="ds-fields">
              <label className="ds-field">
                <span className="cap">
                  Length{' '}
                  <span className="val">
                    {spec.length}"{arch.lockLength !== null ? ' (locked)' : ''}
                  </span>
                </span>
                <input
                  className="ds-range"
                  type="range"
                  min={INTAKE_PRESETS[spec.intake].minLength}
                  max={INTAKE_PRESETS[spec.intake].maxLength}
                  step={0.5}
                  value={spec.length}
                  disabled={arch.lockLength !== null}
                  onChange={(e) => setSpec({ length: Number(e.target.value) })}
                />
              </label>
              <label className="ds-field">
                <span className="cap">
                  Width{' '}
                  <span className="val">
                    {spec.width}"{arch.lockWidth !== null ? ' (locked)' : ''}
                  </span>
                </span>
                <input
                  className="ds-range"
                  type="range"
                  min={ROBOT_MIN_WIDTH}
                  max={ROBOT_MAX_SIZE}
                  step={0.5}
                  value={spec.width}
                  disabled={arch.lockWidth !== null}
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
                  max={ROBOT_MAX_MASS}
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
                  min={ROBOT_MIN_RPM}
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
                  onChange={(e) => setSpec({ flywheelInertia: Number(e.target.value) })}
                />
              </label>
              <button
                className={`ds-opt mini ${spec.canSort ? 'on' : ''}`}
                style={{ flex: '1 1 150px' }}
                disabled={noSorter}
                onClick={() => setSpec({ canSort: !spec.canSort })}
              >
                <span className="ot">Sorter {noSorter ? 'N/A' : spec.canSort ? 'ON' : 'OFF'}</span>
                <span className="od">
                  {arch.builtinSort
                    ? 'Built into the spindexer — toggle indexing in-game (I)'
                    : volley
                      ? 'A volley fires the whole hopper — nothing to sort'
                      : 'Fires the color the motif needs'}
                </span>
              </button>
            </div>

            <p className="ds-hint">
              Heavier = more push, slower accel · higher RPM = faster top speed · more flywheel
              inertia keeps long shots rapid. Chassis + intake ≤ {ROBOT_MAX_SIZE}".
            </p>
          </div>

          <div className="ds-opts">
            {(Object.keys(INTAKE_LABELS) as IntakeStyle[]).map((i) => {
              const allowed = arch.intakes.includes(i);
              return (
                <button
                  key={i}
                  className={`ds-opt ${spec.intake === i ? 'on' : ''}`}
                  disabled={!allowed}
                  onClick={() => selectIntake(i)}
                >
                  <span className="ot">{INTAKE_LABELS[i]}</span>
                  <span className="od">
                    {allowed ? INTAKE_BLURBS[i] : `Not on a ${arch.label}`}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* ---------- appearance ---------- */}
        <section className="ds-sec">
          <h2>Appearance</h2>
          <div className="ds-panelbox">
            <div className="ds-fields">
              <label className="ds-field" style={{ flex: '0 1 140px' }}>
                <span className="cap">Body color</span>
                <input
                  className="ds-input ds-color"
                  type="color"
                  value={appearance.body}
                  onChange={(e) => setAppearance({ body: e.target.value })}
                />
              </label>
              <label className="ds-field" style={{ flex: '0 1 140px' }}>
                <span className="cap">Accent color</span>
                <input
                  className="ds-input ds-color"
                  type="color"
                  value={appearance.accent}
                  onChange={(e) => setAppearance({ accent: e.target.value })}
                />
              </label>
              <label className="ds-field" style={{ flex: '0 1 140px' }}>
                <span className="cap">Wheel color</span>
                <input
                  className="ds-input ds-color"
                  type="color"
                  value={appearance.wheels ?? '#111318'}
                  onChange={(e) => setAppearance({ wheels: e.target.value })}
                />
              </label>
            </div>
            <div className="ds-opts">
              {(Object.keys(PATTERN_LABELS) as AppearancePattern[]).map((p) => (
                <button
                  key={p}
                  className={`ds-opt mini ${appearance.pattern === p ? 'on' : ''}`}
                  onClick={() => setAppearance({ pattern: p })}
                >
                  <span className="ot">{PATTERN_LABELS[p]}</span>
                </button>
              ))}
              <button
                className="ds-opt mini"
                onClick={() => setSpec({ appearance: undefined })}
              >
                <span className="ot">Reset paint</span>
                <span className="od">Back to the classic look</span>
              </button>
            </div>
            <p className="ds-hint">
              Paint is cosmetic only. Your bumper outline stays alliance-colored so everyone can
              tell red from blue.
            </p>
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

        <ControlsSection bindings={settings.bindings} onChange={(bindings) => set({ bindings })} />
      </div>
    </>
  );
}
