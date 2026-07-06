import { useEffect, useRef, useState } from 'react';
import { GameController, type GameSettings, type HudSnapshot } from '../game';
import { keyLabel, padButtonLabel } from '../input/bindings';
import { ENDGAME_START } from '../config';
import type { NetSession } from '../net/session';

interface Props {
  settings: GameSettings;
  onExit: () => void;
  /** null in solo; a live lockstep session in multiplayer */
  session?: NetSession | null;
}

export function GameView({ settings, onExit, session = null }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<GameController | null>(null);
  const [hud, setHud] = useState<HudSnapshot | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const controller = new GameController(canvas, settings, session);
    controllerRef.current = controller;
    const hudTimer = window.setInterval(() => setHud(controller.getHud()), 100);
    const onKey = (e: KeyboardEvent) => {
      // Escape is reserved (never rebindable); restart is handled by the
      // InputManager through the user's bindings
      if (e.key === 'Escape') onExit();
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
      <div className="game-buttons">
        <button className="game-btn" onClick={onExit} title="Back to menu (Esc)">
          ◄ MENU
        </button>
        <button
          className="game-btn"
          onClick={() => controllerRef.current?.restart()}
          title="Restart (R · gamepad Back/Select)"
        >
          ⟲ RESET
        </button>
      </div>
      {hud?.phase === 'pre' && hud.countdown === null && (
        <div className="overlay">
          <div className="overlay-panel">
            <h2>{hud.alliance.toUpperCase()} ALLIANCE</h2>
            <p>
              MOTIF{' '}
              {hud.motif.map((c, i) => (
                <span key={i} className={`motif-dot ${c}`} />
              ))}
            </p>
            <p className="big">
              Press {keyLabel(settings.bindings.keys.start[0] ?? 'enter')} or{' '}
              {padButtonLabel(settings.bindings.pad.buttons.start[0] ?? 9)} to begin the MATCH
            </p>
            <p className="hint">
              Esc returns to the menu · {keyLabel(settings.bindings.keys.restart[0] ?? '?')} or{' '}
              {padButtonLabel(settings.bindings.pad.buttons.restart[0] ?? 8)} restarts
            </p>
          </div>
        </div>
      )}
      {hud?.phase === 'pre' && hud.countdown !== null && (
        <div
          className={hud.countdown > 3 ? 'countdown-text' : 'countdown-num'}
          key={hud.countdown}
        >
          {hud.countdown > 3 ? 'MATCH BEGINS IN' : hud.countdown}
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
            <ScoreTable hud={hud} />
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
  const endgame = hud.timeLeft <= ENDGAME_START && hud.phase === 'teleop';
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
          <div className={`timer-panel ${urgent ? 'urgent' : endgame ? 'warning' : ''}`}>
            <span className="timer-phase">{endgame ? 'END GAME' : PHASE_LABEL[hud.phase]}</span>
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
          {/* artifact COUNTS, not points (points live in the score panels).
              PATTERN shows only BANKED points — it is assessed solely at the
              end of AUTO and the end of the match, never live. */}
          <span>CLASSIFIED {hud.classifiedCount}</span>
          <span>OVERFLOW {hud.overflowCount}</span>
          <span>
            PATTERN{' '}
            {hud.score.autoPattern + (hud.phase === 'post' ? hud.score.telePattern : 0)} PTS
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
          {hud.mode === 'match' &&
            (hud.fouls[hud.alliance].minor > 0 || hud.fouls[hud.alliance].major > 0) && (
              <span className="chip warn">
                FOULS {hud.fouls[hud.alliance].minor}m {hud.fouls[hud.alliance].major}M
              </span>
            )}
          <span className="chip">{hud.fieldCentric ? 'FIELD' : 'ROBOT'}</span>
          {hud.frontFlipped && <span className="chip warn">REVERSED</span>}
          <span className={`chip ${hud.aimAssist ? 'on' : 'off'}`}>AIM</span>
          <span className={`chip ${hud.autoIntake ? 'on' : 'off'}`}>AUTO-IN</span>
          <span className={`chip ${hud.autoFire ? 'on' : 'off'}`}>AUTO-FIRE</span>
          <span className={`chip ${hud.gamepadConnected ? 'on' : 'off'}`}>🎮</span>
          {hud.net && (
            <span className={`chip ${hud.net.peers > 0 ? 'on' : 'warn'}`}>
              NET {hud.net.peers + 1}P
            </span>
          )}
          {hud.net?.waitingFor && (
            <span className="chip warn">WAITING · {hud.net.waitingFor}</span>
          )}
          {hud.net?.desync && <span className="chip off">⚠ DESYNC</span>}
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
function ScoreTable({ hud }: { hud: HudSnapshot }) {
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
        ['Pattern', s.telePattern],
      ],
    ],
    [
      'END OF MATCH',
      [
        ['Depot artifacts', s.depot],
        ['Base return', s.base],
      ],
    ],
    [
      'PENALTIES',
      [['Opponent fouls', s.foulPoints]],
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
