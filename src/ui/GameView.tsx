import { Fragment, useEffect, useRef, useState } from 'react';
import { GameController, type GameSettings, type HudSnapshot } from '../game';
import { keyLabel, padButtonLabel } from '../input/bindings';
import { ENDGAME_START, PTS_FOUL_MINOR, PTS_FOUL_MAJOR } from '../config';
import { MobileControls } from './MobileControls';
import type { MatchResultInfo, NetSession } from '../net/session';
import type { Replay } from '../sim/replay';
import type { Alliance, ScoreBreakdown } from '../types';

interface Props {
  settings: GameSettings;
  onExit: () => void;
  /** null in solo; a live lockstep session in multiplayer */
  session?: NetSession | null;
  /** watch the just-played run's replay (server matches only) */
  onWatchReplay?: (replay: Replay) => void;
}

export function GameView({ settings, onExit, session = null, onWatchReplay }: Props) {
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
      {window.matchMedia('(pointer: coarse)').matches && controllerRef.current && (
        <MobileControls inputManager={controllerRef.current.getInputManager()} />
      )}
      {hud && <Hud hud={hud} />}
      <div className="game-buttons">
        <button className="game-btn" onClick={onExit} title="Back to menu (Esc)">
          ◄ MENU
        </button>
        {/* RESET is a LOCAL rebuild — meaningless (and desyncing) in lockstep, so
            solo only. In multiplayer use REMATCH on the results screen (host). */}
        {!session && (
          <button
            className="game-btn"
            onClick={() => controllerRef.current?.restart()}
            title="Restart (R · gamepad Back/Select)"
          >
            ⟲ RESET
          </button>
        )}
      </div>
      {hud?.phase === 'pre' && hud.countdown === null && !session && (
        <div className="overlay">
          <div className="overlay-panel">
            <h2>{hud.alliance.toUpperCase()} ALLIANCE</h2>
            <p>
              MOTIF{' '}
              {hud.motif.map((c, i) => (
                <span key={i} className={`motif-dot ${c}`} />
              ))}
            </p>
            {!window.matchMedia('(pointer: coarse)').matches && (
              <p className="big">
                Press {keyLabel(settings.bindings.keys.start[0] ?? 'enter')} or{' '}
                {padButtonLabel(settings.bindings.pad.buttons.start[0] ?? 9)} to begin the MATCH
              </p>
            )}
            {window.matchMedia('(pointer: coarse)').matches && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', alignItems: 'center' }}>
                <button
                  className="ds-cta"
                  onClick={() => controllerRef.current?.startMatch()}
                >
                  START MATCH
                </button>
                <button
                  className="ds-cta ghost"
                  onClick={onExit}
                >
                  BACK TO MENU
                </button>
              </div>
            )}
            <p className="ds-hint">
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
        <Results
          hud={hud}
          canRematch={!session || session.isHost()}
          onRematch={() => controllerRef.current?.rematch()}
          onExit={onExit}
          matchResult={controllerRef.current?.getMatchResult() ?? null}
          onWatchReplay={onWatchReplay}
        />
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

      {(!window.matchMedia('(pointer: coarse)').matches) && (
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
      )}

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

/** final match results — RED | category | BLUE, like the FTC audience board.
 * Foul rows show the fouls each alliance COMMITTED (its own count) — the POINTS
 * for those go to the OPPONENT's total (see the footnote), so a foul always
 * benefits the fouled alliance. */
function Results({
  hud,
  canRematch,
  onRematch,
  onExit,
  matchResult,
  onWatchReplay,
}: {
  hud: HudSnapshot;
  canRematch: boolean;
  onRematch: () => void;
  onExit: () => void;
  matchResult: MatchResultInfo | null;
  onWatchReplay?: (replay: Replay) => void;
}) {
  const red = hud.alliance === 'red' ? hud.score : hud.oppScore;
  const blue = hud.alliance === 'blue' ? hud.score : hud.oppScore;
  const winner: Alliance | 'tie' =
    red.total > blue.total ? 'red' : blue.total > red.total ? 'blue' : 'tie';

  const f = hud.fouls; // fouls COMMITTED by each alliance
  const val = (get: (s: ScoreBreakdown) => number): [number, number] => [get(red), get(blue)];
  const sections: [string, [string, number, number][]][] = [
    [
      'AUTONOMOUS',
      [
        ['Leave', ...val((s) => s.leave)],
        ['Classified', ...val((s) => s.autoClassified)],
        ['Overflow', ...val((s) => s.autoOverflow)],
        ['Pattern', ...val((s) => s.autoPattern)],
      ],
    ],
    [
      'DRIVER-CONTROLLED',
      [
        ['Classified', ...val((s) => s.teleClassified)],
        ['Overflow', ...val((s) => s.teleOverflow)],
        ['Pattern', ...val((s) => s.telePattern)],
      ],
    ],
    [
      'END OF MATCH',
      [
        ['Depot', ...val((s) => s.depot)],
        ['Base return', ...val((s) => s.base)],
      ],
    ],
    [
      // penalty POINTS awarded to each alliance (from the OPPONENT's fouls) —
      // shown as points, not counts, so the breakdown reconciles with each TOTAL
      'PENALTIES',
      [
        ['Minor', f.blue.minor * PTS_FOUL_MINOR, f.red.minor * PTS_FOUL_MINOR],
        ['Major', f.blue.major * PTS_FOUL_MAJOR, f.red.major * PTS_FOUL_MAJOR],
      ],
    ],
  ];

  return (
    <div className="overlay">
      <div className="overlay-panel results">
        <h2>MATCH RESULTS</h2>
        <div className="results-head">
          <div className={`res-side red ${winner === 'red' ? 'win' : ''}`}>
            <span>RED</span>
            <strong>{red.total}</strong>
          </div>
          <div className="res-verdict">{winner === 'tie' ? 'TIE' : `${winner.toUpperCase()} WINS`}</div>
          <div className={`res-side blue ${winner === 'blue' ? 'win' : ''}`}>
            <span>BLUE</span>
            <strong>{blue.total}</strong>
          </div>
        </div>
        <table className="score-table results-table">
          <thead>
            <tr>
              <th className="rv red">RED</th>
              <th className="cat" />
              <th className="bv blue">BLUE</th>
            </tr>
          </thead>
          <tbody>
            {sections.map(([title, rows]) => (
              <Fragment key={title}>
                <tr className="section-row">
                  <td colSpan={3}>{title}</td>
                </tr>
                {rows.map(([label, rv, bv]) => (
                  <tr key={label}>
                    <td className="rv">{rv}</td>
                    <td className="cat">{label}</td>
                    <td className="bv">{bv}</td>
                  </tr>
                ))}
              </Fragment>
            ))}
            <tr className="total-row">
              <td className="rv">{red.total}</td>
              <td className="cat">TOTAL</td>
              <td className="bv">{blue.total}</td>
            </tr>
          </tbody>
        </table>
        <p className="ds-hint">
          PENALTIES are the points (minor {PTS_FOUL_MINOR} · major {PTS_FOUL_MAJOR}) awarded to each
          alliance for the OPPONENT's fouls — already included in each TOTAL.
        </p>
        {matchResult && (
          <p className="ds-hint" style={{ color: 'var(--ds-accent)' }}>
            {matchResult.kind === 'record'
              ? '✓ Recorded — sign in for it to hit the leaderboard.'
              : '✓ Match recorded.'}
          </p>
        )}
        <div className="overlay-buttons">
          {matchResult && onWatchReplay && (
            <button onClick={() => onWatchReplay(matchResult.replay)}>▶ WATCH REPLAY</button>
          )}
          {canRematch ? (
            <button onClick={onRematch}>REMATCH</button>
          ) : (
            <button disabled title="Only the host can start a rematch">
              WAITING FOR HOST…
            </button>
          )}
          <button onClick={onExit}>MENU</button>
        </div>
      </div>
    </div>
  );
}

