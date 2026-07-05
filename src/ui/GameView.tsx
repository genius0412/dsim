import { useEffect, useRef, useState } from 'react';
import { GameController, type GameSettings, type HudSnapshot } from '../game';

interface Props {
  settings: GameSettings;
  onExit: () => void;
}

export function GameView({ settings, onExit }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<GameController | null>(null);
  const [hud, setHud] = useState<HudSnapshot | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const controller = new GameController(canvas, settings);
    controllerRef.current = controller;
    const hudTimer = window.setInterval(() => setHud(controller.getHud()), 100);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onExit();
      if (e.key.toLowerCase() === 'r') controller.restart();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearInterval(hudTimer);
      window.removeEventListener('keydown', onKey);
      controller.dispose();
      controllerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="game-root">
      <canvas ref={canvasRef} className="game-canvas" />
      {hud && <Hud hud={hud} />}
      {hud?.phase === 'pre' && (
        <div className="overlay">
          <div className="overlay-panel">
            <h2>{hud.alliance.toUpperCase()} ALLIANCE</h2>
            <p>
              MOTIF{' '}
              {hud.motif.map((c, i) => (
                <span key={i} className={`motif-dot ${c}`} />
              ))}
            </p>
            <p className="big">Press ENTER or START to begin the MATCH</p>
            <p className="hint">Esc returns to the menu · R resets</p>
          </div>
        </div>
      )}
      {hud?.phase === 'post' && (
        <div className="overlay">
          <div className="overlay-panel results">
            <h2>MATCH RESULTS</h2>
            <div className={`final-score alliance-${hud.alliance}`}>
              <span>{hud.alliance.toUpperCase()}</span>
              <strong>{hud.score.total}</strong>
            </div>
            <ScoreTable hud={hud} final />
            <div className="overlay-buttons">
              <button onClick={() => controllerRef.current?.restart()}>REMATCH</button>
              <button onClick={onExit}>MENU</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function fmtTime(s: number): string {
  const total = Math.max(0, Math.ceil(s));
  const m = Math.floor(total / 60);
  return `${m}:${String(total % 60).padStart(2, '0')}`;
}

const PHASE_LABEL: Record<string, string> = {
  pre: 'PRE-MATCH',
  auto: 'AUTONOMOUS',
  transition: 'TRANSITION',
  teleop: 'DRIVER-CONTROLLED',
  post: 'FINAL',
  freeplay: 'FREE DRIVE',
};

/** styled after the FTC live scoring audience display: red panel | timer | blue panel */
function Hud({ hud }: { hud: HudSnapshot }) {
  const urgent = hud.timeLeft <= 10 && (hud.phase === 'auto' || hud.phase === 'teleop');
  const warning = hud.timeLeft <= 30 && hud.phase === 'teleop';
  const redScore = hud.alliance === 'red' ? hud.score.total : hud.oppTotal;
  const blueScore = hud.alliance === 'blue' ? hud.score.total : hud.oppTotal;

  return (
    <div className="hud">
      {hud.mode === 'match' ? (
        <div className="scorebar">
          <div className={`score-panel red ${hud.alliance === 'red' ? 'mine' : ''}`}>
            {hud.alliance === 'red' && <span className="you-tag">YOU</span>}
            <span className="panel-score">{redScore}</span>
          </div>
          <div className={`timer-panel ${urgent ? 'urgent' : warning ? 'warning' : ''}`}>
            <span className="timer-phase">{PHASE_LABEL[hud.phase]}</span>
            <span className="timer-time">
              {hud.phase === 'post' ? '0:00' : fmtTime(hud.timeLeft)}
            </span>
            <span className="timer-motif">
              {hud.motif.map((c, i) => (
                <span key={i} className={`motif-dot ${c}`} />
              ))}
            </span>
          </div>
          <div className={`score-panel blue ${hud.alliance === 'blue' ? 'mine' : ''}`}>
            {hud.alliance === 'blue' && <span className="you-tag">YOU</span>}
            <span className="panel-score">{blueScore}</span>
          </div>
        </div>
      ) : (
        <div className="scorebar">
          <div className="timer-panel">
            <span className="timer-phase">FREE DRIVE</span>
            <span className="timer-motif">
              {hud.motif.map((c, i) => (
                <span key={i} className={`motif-dot ${c}`} />
              ))}
            </span>
          </div>
        </div>
      )}

      {hud.mode === 'match' && (
        <div className="breakdown-row">
          {/* artifact COUNTS, not points (points live in the score panels) */}
          <span>CLASSIFIED {hud.classifiedCount}</span>
          <span>OVERFLOW {hud.overflowCount}</span>
          <span>
            PATTERN{' '}
            {(hud.phase === 'post' ? hud.score.telePattern : hud.provisionalPattern) / 2}{' '}
            MATCHED
          </span>
          <span>RAMP {hud.rampCount}/9</span>
        </div>
      )}

      <div className="status-wrap">
        <div className="robot-status">
          <div className="hopper">
            {[0, 1, 2].map((i) => (
              <span key={i} className={`hopper-pip ${hud.hopper[i] ?? 'empty'}`} />
            ))}
          </div>
          <span className={`chip ${hud.inLaunchZone ? 'on' : 'warn'}`}>
            {hud.inLaunchZone ? 'LAUNCH ZONE' : 'NO LAUNCH'}
          </span>
          {hud.gateOpen && <span className="chip on">GATE OPEN</span>}
          <span className="chip">{hud.fieldCentric ? 'FIELD' : 'ROBOT'}</span>
          <span className={`chip ${hud.aimAssist ? 'on' : 'off'}`}>AIM</span>
          <span className={`chip ${hud.autoIntake ? 'on' : 'off'}`}>AUTO-IN</span>
          <span className={`chip ${hud.autoFire ? 'on' : 'off'}`}>AUTO-FIRE</span>
          <span className={`chip ${hud.gamepadConnected ? 'on' : 'off'}`}>🎮</span>
        </div>
      </div>

      <div className="eventlog">
        {hud.toasts.map((t) => (
          <div key={t.id} className="eventlog-line">
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

/** score review table, like the FTC scoring system's match details */
function ScoreTable({ hud, final }: { hud: HudSnapshot; final?: boolean }) {
  const s = hud.score;
  const sections: [string, [string, number][]][] = [
    [
      'AUTO',
      [
        ['Leave', s.leave],
        ['Classified artifacts', s.autoClassified],
        ['Overflow artifacts', s.autoOverflow],
        ['Pattern', s.autoPattern],
      ],
    ],
    [
      'DRIVER-CONTROLLED',
      [
        ['Classified artifacts', s.teleClassified],
        ['Overflow artifacts', s.teleOverflow],
        ['Pattern', final ? s.telePattern : hud.provisionalPattern],
      ],
    ],
    [
      'END OF MATCH',
      [
        ['Depot artifacts', s.depot],
        ['Base return', s.base],
      ],
    ],
  ];
  return (
    <table className="score-table">
      <tbody>
        {sections.map(([title, rows]) => (
          <SectionRows key={title} title={title} rows={rows} />
        ))}
        <tr className="total-row">
          <td>TOTAL</td>
          <td>{s.total}</td>
        </tr>
      </tbody>
    </table>
  );
}

function SectionRows({ title, rows }: { title: string; rows: [string, number][] }) {
  return (
    <>
      <tr className="section-row">
        <td colSpan={2}>{title}</td>
      </tr>
      {rows.map(([label, val]) => (
        <tr key={label}>
          <td>{label}</td>
          <td>{val}</td>
        </tr>
      ))}
    </>
  );
}
