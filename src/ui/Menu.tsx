import type { GameSettings, AutoPathData, PathLine, SequenceItem, PathPoint, Vec2 } from '../types';
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
import { RobotPreview } from './RobotPreview';
import { APP_NAME, CURRENT_SEASON } from '../seasons';

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

const INTAKE_SHORT: Record<IntakeStyle, string> = {
  sloped: 'Sloped',
  vector: 'Vector',
  triangle: 'Triangle',
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

interface Props {
  settings: GameSettings;
  onChange: (s: GameSettings) => void;
  onStart: () => void;
  /** open the multiplayer lobby; undefined ⇒ Supabase not configured */
  onMultiplayer?: () => void;
  /** return to Home (Phase 3 shell); undefined ⇒ standalone menu (no back) */
  onBack?: () => void;
}

export function Menu({ settings, onChange, onStart, onMultiplayer, onBack }: Props) {
  const set = (patch: Partial<GameSettings>) => onChange({ ...settings, ...patch });
  const setSpec = (patch: Partial<GameSettings['spec']>) =>
    onChange({ ...settings, spec: { ...settings.spec, ...patch } });
  const setAssist = (patch: Partial<GameSettings['assists']>) =>
    onChange({ ...settings, assists: { ...settings.assists, ...patch } });

  // Helper to get error message from unknown error type
  function getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  // Basic toast notification (can be replaced with a more sophisticated UI component)
  function showToast(message: string, type: 'success' | 'error' | 'warning' | 'info' = 'info') {
    alert(`${type.toUpperCase()}: ${message}`);
  }

  // --- Coordinate Transformation for .pp files ---
  const PP_FIELD_SIZE = 141.5;
  const PP_CENTER_OFFSET = PP_FIELD_SIZE / 2; // 70.75
  const SIM_FIELD_SIZE = 144; // From -72 to 72
  const SCALE_FACTOR = SIM_FIELD_SIZE / PP_FIELD_SIZE; // 144 / 141.5

  function transformPpCoordinate(coord: Vec2): Vec2 {
    return {
      x: (coord.x - PP_CENTER_OFFSET) * SCALE_FACTOR,
      y: (coord.y - PP_CENTER_OFFSET) * SCALE_FACTOR,
    };
  }

  function transformPathPoint(pathPoint: PathPoint): PathPoint {
    const transformed = transformPpCoordinate(pathPoint);
    return { ...pathPoint, x: transformed.x, y: transformed.y };
  }
  // --- End Coordinate Transformation ---

  // Normalize lines to ensure ids and wait fields exist
  function normalizeLines(input: PathLine[] = []): PathLine[] {
    return (input || []).map((line) => ({
      ...line,
      id: line.id || `line-${Math.random().toString(36).slice(2)}`,
      waitBeforeMs: Math.max(
        0,
        Number(line.waitBeforeMs ?? (line as any).waitBefore?.durationMs ?? 0),
      ),
      waitAfterMs: Math.max(
        0,
        Number(line.waitAfterMs ?? (line as any).waitAfter?.durationMs ?? 0),
      ),
      waitBeforeName:
        line.waitBeforeName ?? (line as any).waitBefore?.name ?? '',
      waitAfterName: line.waitAfterName ?? (line as any).waitAfter?.name ?? '',
      // Apply transformation to endPoint
      endPoint: transformPathPoint(line.endPoint),
      // Apply transformation to controlPoints
      controlPoints: line.controlPoints?.map(cp => transformPpCoordinate(cp)),
    }));
  }

  // Normalize sequence data, falling back to path-only sequence if waits are missing
  function deriveSequence(data: any, normalizedLines: PathLine[]): SequenceItem[] {
    if (Array.isArray(data?.sequence) && data.sequence.length) {
      return data.sequence as SequenceItem[];
    }

    return normalizedLines.map((ln) => ({
      kind: 'path',
      lineId: ln.id!,
    }));
  }

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    if (!file.name.endsWith('.pp')) {
      showToast('Please select a .pp file.', 'error');
      event.target.value = ''; // Clear the input
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const data = JSON.parse(content);

        // Validate the loaded data
        if (!data.startPoint || !data.lines) {
          throw new Error('Invalid file format: missing required fields (startPoint or lines)');
        }

        // Apply transformation to startPoint
        const transformedStartPoint = transformPathPoint(data.startPoint);
        const normalizedLines = normalizeLines(data.lines || []);

        const autoPathData: AutoPathData = {
          fileName: file.name,
          startPoint: transformedStartPoint,
          lines: normalizedLines,
          shapes: data.shapes?.map((s: any) => ({
            ...s,
            // Assuming shapes also need transformation if they have position data
            // This part might need further refinement based on actual shape structure
            points: s.points?.map((p: Vec2) => transformPpCoordinate(p)),
            x: s.x !== undefined ? transformPpCoordinate({x: s.x, y: 0}).x : undefined,
            y: s.y !== undefined ? transformPpCoordinate({x: 0, y: s.y}).y : undefined,
          })) || [],
          sequence: deriveSequence(data, normalizedLines),
          version: data.version,
          timestamp: data.timestamp,
        };

        set({ autoPath: autoPathData, autoPathEnabled: true });
        showToast(`Loaded auto path: ${file.name}`, 'success');
      } catch (error) {
        const errMsg = getErrorMessage(error);
        const message = errMsg.includes('Invalid file format')
          ? 'Invalid file format. This may not be a valid Pedro Pathing file.'
          : `Error loading file: ${errMsg}`;
        showToast(message, 'error');
        set({ autoPath: null, autoPathEnabled: false }); // Clear any partial state
      } finally {
        event.target.value = ''; // Clear the input to allow re-uploading the same file
      }
    };
    reader.onerror = () => {
      showToast(`Failed to read file: ${reader.error?.message}`, 'error');
      event.target.value = '';
    };
    reader.readAsText(file);
  };

  const clearAutoPath = () => {
    set({ autoPath: null, autoPathEnabled: false });
    showToast('Auto path cleared.', 'info');
  };

  const spec = settings.spec;
  const isSwerve = spec.drivetrain === 'swerve';
  const minMass = isSwerve ? 25 : ROBOT_MIN_MASS;
  const maxRpm = isSwerve ? 500 : ROBOT_MAX_RPM;
  const dp = driveParams(spec);
  const isCustom = !ROBOT_PRESETS.some((p) => specMatches(spec, p));

  function selectIntake(intake: IntakeStyle) {
    // keep chassis length inside the preset's legal range (18in cap etc.)
    const p = INTAKE_PRESETS[intake];
    setSpec({ intake, length: Math.min(Math.max(spec.length, p.minLength), p.maxLength) });
  }

  return (
    <div className="ds-console">
      <div className="ds-console-in">
        <div className="ds-head">
          {onBack && (
            <button className="ds-back" onClick={onBack}>
              ← Home
            </button>
          )}
          <span className="ds-mark">
            <span className="glyph">D</span>
            {APP_NAME}
          </span>
          <span className="ds-head-spacer" />
          <span className="ds-season" title={CURRENT_SEASON.blurb}>
            <span className="dot" />
            <span className="nm">{CURRENT_SEASON.name}</span>
            <span className="yr">{CURRENT_SEASON.years}</span>
          </span>
        </div>

        <div className="ds-title">
          <h1>
            My <span className="accent">Robot</span>
          </h1>
        </div>

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
          <h2>{isCustom ? 'Customize' : 'Tweak it (becomes Custom)'}</h2>
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
                  min={INTAKE_PRESETS[spec.intake].minLength}
                  max={INTAKE_PRESETS[spec.intake].maxLength}
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
                  min={ROBOT_MIN_WIDTH}
                  max={ROBOT_MAX_SIZE}
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
                onClick={() => setSpec({ canSort: !spec.canSort })}
              >
                <span className="ot">Sorter {spec.canSort ? 'ON' : 'OFF'}</span>
                <span className="od">Fires the color the motif needs next</span>
              </button>
            </div>

            <p className="ds-hint">
              Heavier shoves harder but accelerates slower · higher RPM = faster top speed, softer
              punch · high flywheel inertia keeps rapid fire fast on long-range shots. Chassis +
              intake reach ≤ {ROBOT_MAX_SIZE}"; base parking counts only the wheels.
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

        {/* ---------- match setup ---------- */}
        <section className="ds-sec">
          <h2>Game mode</h2>
          <div className="ds-opts two">
            <button
              className={`ds-opt ${settings.mode === 'match' ? 'on' : ''}`}
              onClick={() => set({ mode: 'match' })}
            >
              <span className="ot">Solo Match</span>
              <span className="od">30s AUTO · 8s transition · 2:00 TELEOP, full DECODE scoring</span>
            </button>
            <button
              className={`ds-opt ${settings.mode === 'free' ? 'on' : ''}`}
              onClick={() => set({ mode: 'free' })}
            >
              <span className="ot">Free Drive</span>
              <span className="od">No timer, no launch-zone limits — just practice</span>
            </button>
          </div>
        </section>

        <section className="ds-sec">
          <h2>Alliance</h2>
          <div className="ds-opts two">
            <button
              className={`ds-opt red ${settings.alliance === 'red' ? 'on' : ''}`}
              onClick={() => set({ alliance: 'red' })}
            >
              <span className="ot">RED</span>
              <span className="od">You stand at the red wall — your goal is cross-court, top-left of your view</span>
            </button>
            <button
              className={`ds-opt blue ${settings.alliance === 'blue' ? 'on' : ''}`}
              onClick={() => set({ alliance: 'blue' })}
            >
              <span className="ot">BLUE</span>
              <span className="od">You stand at the blue wall — your goal is cross-court, top-right of your view</span>
            </button>
          </div>
        </section>

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
              <span className="od">Turret always tracks the firing solution</span>
            </button>
            <button
              className={`ds-opt ${settings.assists.autoIntake ? 'on' : ''}`}
              onClick={() => setAssist({ autoIntake: !settings.assists.autoIntake })}
            >
              <span className="ot">Auto intake {settings.assists.autoIntake ? 'ON' : 'OFF'}</span>
              <span className="od">Intake runs whenever the hopper has room</span>
            </button>
            <button
              className={`ds-opt ${settings.assists.autoFire ? 'on' : ''}`}
              onClick={() => setAssist({ autoFire: !settings.assists.autoFire })}
            >
              <span className="ot">Auto fire {settings.assists.autoFire ? 'ON' : 'OFF'}</span>
              <span className="od">Shoots automatically inside the launch zone</span>
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
              Toggle with P (keyboard) or X (controller) — only in the last 20s of teleop, or
              anytime in Free Drive. Caps drive speed to the percentage above for precise control.
            </p>
          </div>
        </section>

        <section className="ds-sec">
          <h2>Start position</h2>
          <div className="ds-opts">
            {START_POSES.map((p, i) => (
              <button
                key={p.label}
                className={`ds-opt mini ${settings.startIndex === i ? 'on' : ''}`}
                onClick={() => set({ startIndex: i })}
              >
                <span className="ot">{p.label}</span>
                <span className="od">launch zone, mirrored to your alliance</span>
              </button>
            ))}
            {settings.mode === 'free' && (
              <button
                className={`ds-opt mini ${settings.practiceDummies ? 'on' : ''}`}
                onClick={() => set({ practiceDummies: !settings.practiceDummies })}
              >
                <span className="ot">Practice dummies {settings.practiceDummies ? 'ON' : 'OFF'}</span>
                <span className="od">Three idle robots on the field to push against</span>
              </button>
            )}
          </div>
        </section>

        <section className="ds-sec">
          <h2>Auto path</h2>
          <div className="ds-opts">
            <label className="ds-opt" style={{ cursor: 'pointer' }}>
              <span className="ot">Import .pp file</span>
              <span className="od">{settings.autoPath ? settings.autoPath.fileName : 'No file selected'}</span>
              <input type="file" accept=".pp" onChange={handleFileChange} style={{ display: 'none' }} />
            </label>
            {settings.autoPath && (
              <button className="ds-opt" onClick={clearAutoPath}>
                <span className="ot">Clear path</span>
                <span className="od">Remove the loaded auto path</span>
              </button>
            )}
            <button
              className={`ds-opt ${settings.autoPathEnabled ? 'on' : ''}`}
              onClick={() => set({ autoPathEnabled: !settings.autoPathEnabled })}
              disabled={!settings.autoPath}
            >
              <span className="ot">Auto path {settings.autoPathEnabled ? 'ON' : 'OFF'}</span>
              <span className="od">Follow the imported path during auto</span>
            </button>
          </div>
          <p className="ds-hint">
            Build and export a <code>.pp</code> path at{' '}
            <a
              href="https://visualizer.pedropathing.com"
              target="_blank"
              rel="noreferrer"
              style={{ color: 'var(--ds-accent)' }}
            >
              visualizer.pedropathing.com
            </a>
            , then import it here.
            {settings.autoPath &&
              ` Loaded: ${settings.autoPath.fileName} (Version: ${settings.autoPath.version || 'N/A'}).`}
          </p>
        </section>

        <ControlsSection bindings={settings.bindings} onChange={(bindings) => set({ bindings })} />

        <div className="ds-actions" style={{ marginTop: 4 }}>
          <button className="ds-cta" onClick={onStart}>
            ENTER FIELD
          </button>
          {onMultiplayer && (
            <button className="ds-cta ghost" onClick={onMultiplayer}>
              ▲ MULTIPLAYER (2v2)
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
