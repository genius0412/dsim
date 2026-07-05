import type { GameSettings } from '../game';
import type { IntakeStyle } from '../types';
import { INTAKE_PRESETS, ROBOT_MAX_SIZE, ROBOT_MIN_SIZE } from '../config';

interface Props {
  settings: GameSettings;
  onChange: (s: GameSettings) => void;
  onStart: () => void;
}

export function Menu({ settings, onChange, onStart }: Props) {
  const set = (patch: Partial<GameSettings>) => onChange({ ...settings, ...patch });
  const setSpec = (patch: Partial<GameSettings['spec']>) =>
    onChange({ ...settings, spec: { ...settings.spec, ...patch } });
  const setAssist = (patch: Partial<GameSettings['assists']>) =>
    onChange({ ...settings, assists: { ...settings.assists, ...patch } });

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
          <h2>Robot</h2>
          <div className="spec-row">
            <label>
              Length {settings.spec.length}"
              <input
                type="range"
                min={ROBOT_MIN_SIZE}
                max={maxLength(settings.spec.intake)}
                step={0.5}
                value={settings.spec.length}
                onChange={(e) => setSpec({ length: Number(e.target.value) })}
              />
            </label>
            <label>
              Width {settings.spec.width}"
              <input
                type="range"
                min={ROBOT_MIN_SIZE}
                max={ROBOT_MAX_SIZE}
                step={0.5}
                value={settings.spec.width}
                onChange={(e) => setSpec({ width: Number(e.target.value) })}
              />
            </label>
          </div>
          <div className="card-row">
            <button
              className={`card ${settings.spec.intake === 'compact' ? 'selected' : ''}`}
              onClick={() => selectIntake('compact')}
            >
              <strong>Compact intake</strong>
              <span>Flush with the chassis — face the artifact, but swallows fast</span>
            </button>
            <button
              className={`card ${settings.spec.intake === 'extended' ? 'selected' : ''}`}
              onClick={() => selectIntake('extended')}
            >
              <strong>Extended intake</strong>
              <span>Protrudes ahead (18" cap enforced) — sweep artifacts while strafing, slower per ball</span>
            </button>
          </div>
          <p className="hint">
            FTC sizing: chassis plus intake reach may not exceed {ROBOT_MAX_SIZE}".
          </p>
        </section>

        <section className="controls-section">
          <h2>Controls</h2>
          <div className="controls-grid">
            <span>Drive / strafe</span>
            <span>WASD · left stick</span>
            <span>Turn</span>
            <span>Q E / ◄ ► · right stick</span>
            <span>Intake (hold)</span>
            <span>Shift or K · LT / B</span>
            <span>Shoot</span>
            <span>Space · RT / A</span>
            <span>Start match</span>
            <span>Enter · Start</span>
            <span>Restart / menu</span>
            <span>R / Esc</span>
          </div>
        </section>

        <button className="start-btn" onClick={onStart}>
          ENTER FIELD
        </button>
      </div>
    </div>
  );

  function selectIntake(intake: IntakeStyle) {
    // keep chassis length legal: chassis + intake reach must fit the 18in cap
    const maxLen = maxLength(intake);
    setSpec({ intake, length: Math.min(settings.spec.length, maxLen) });
  }
}

function maxLength(intake: IntakeStyle): number {
  return ROBOT_MAX_SIZE - (intake === 'extended' ? INTAKE_PRESETS.extended.reach : 0);
}
