import { Fragment, useEffect, useRef, useState } from 'react';
import {
  GameController,
  type GameSettings,
  type HudSnapshot,
  type IntroPlayer,
  type EloResultRow,
} from '../game';
import { keyLabel, padButtonLabel } from '../input/bindings';
import { ENDGAME_START, PTS_FOUL_MINOR, PTS_FOUL_MAJOR } from '../config';
import { MobileControls } from './MobileControls';
import type { MatchResultInfo, NetSession, NetStatus } from '../net/session';
import type { RecordRankInfo } from '../net/protocol';
import type { Replay } from '../sim/replay';
import type { Alliance, DrivetrainType, ScoreBreakdown } from '../types';

/** top-right connection-quality readout (multiplayer only): a coloured signal dot
 * + live RTT / snapshot-rate / jitter, so a laggy player can see AT A GLANCE whether
 * it's their link (high ping/jitter) or the game. Colour tracks `net.quality`; the
 * tooltip spells the three numbers out. */
function NetQuality({ net }: { net: NetStatus }) {
  const q = net.quality; // 'good' | 'fair' | 'poor' | null (measuring)
  const cls = q === 'good' ? 'on' : q === 'fair' ? 'warn' : q === 'poor' ? 'off' : '';
  const dot = q === 'good' ? '#3ad17a' : q === 'fair' ? '#e5b567' : q === 'poor' ? '#e5636b' : '#93a1ad';
  const label =
    q === 'good' ? 'SMOOTH' : q === 'fair' ? 'OK' : q === 'poor' ? 'CHOPPY' : 'MEASURING';
  const ping = net.rttMs === null ? '—' : `${net.rttMs}ms`;
  const hz = net.snapHz === null ? '—' : `${net.snapHz}Hz`;
  const jit = net.jitterMs === null ? '—' : `±${net.jitterMs}ms`;
  const title =
    `Connection: ${label.toLowerCase()}\n` +
    `Round-trip ping: ${ping} (you ↔ server)\n` +
    `Server updates: ${hz} (target 30)\n` +
    `Jitter: ${jit} (unevenness — the main cause of choppiness)`;
  return (
    <span className={`chip net-quality ${cls}`} title={title}>
      <span className="net-dot" style={{ background: dot, boxShadow: `0 0 6px ${dot}` }} />
      {ping} · {hz} · {jit}
    </span>
  );
}

const DT_LABEL: Record<DrivetrainType, string> = {
  mecanum: 'Mecanum',
  tank: 'Tank',
  swerve: 'Swerve',
  xdrive: 'X-Drive',
};

/** count an integer from `from` to `target` over `duration` ms once `active` flips
 * true (ease-out cubic). Used for the results score reveal (from 0) and the ELO
 * change (from the old rating, so the delta ticks in). */
function useCountUp(target: number, active: boolean, duration = 900, from = 0): number {
  const [val, setVal] = useState(from);
  useEffect(() => {
    if (!active) {
      setVal(from);
      return;
    }
    let raf = 0;
    let t0 = 0;
    const tick = (t: number): void => {
      if (!t0) t0 = t;
      const p = Math.min(1, (t - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setVal(Math.round(from + (target - from) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, active, duration, from]);
  return active ? val : from;
}

interface Props {
  settings: GameSettings;
  onExit: () => void;
  /** null in solo; a live lockstep session in multiplayer */
  session?: NetSession | null;
  /** watch the just-played run's replay (server matches only) */
  onWatchReplay?: (replay: Replay) => void;
  /** whether the player is signed in — drives the record results "sign in to
   * save & rank" prompt vs the live PB / WR / rank line */
  signedIn?: boolean;
}

export function GameView({ settings, onExit, session = null, onWatchReplay, signedIn = false }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<GameController | null>(null);
  const [hud, setHud] = useState<HudSnapshot | null>(null);
  const [intro, setIntro] = useState<IntroPlayer[] | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const controller = new GameController(canvas, settings, session);
    controllerRef.current = controller;
    setIntro(controller.getIntro()); // ranked matches only; null otherwise
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
      {hud?.net && (hud.net.failed || hud.net.waitingFor === 'server') && (
        <div className="net-overlay">
          <div className="net-overlay-card">
            {hud.net.failed ? (
              <>
                <h3>Connection lost</h3>
                <p>The server may have restarted. Refresh the page to reconnect.</p>
                <div className="overlay-buttons">
                  <button onClick={() => window.location.reload()}>REFRESH</button>
                  <button onClick={onExit}>MENU</button>
                </div>
              </>
            ) : (
              <>
                <div className="net-spinner" />
                <h3>Reconnecting…</h3>
                <p>Restoring your connection — your run keeps going.</p>
              </>
            )}
          </div>
        </div>
      )}
      {hud && <Hud hud={hud} />}
      <div className="game-buttons">
        <button className="game-btn" onClick={onExit} title="Menu (Esc)">
          ◄ MENU
        </button>
        {/* RESET is a LOCAL rebuild — meaningless (and desyncing) in lockstep, so
            solo only. In multiplayer use REMATCH on the results screen (host). */}
        {!session && (
          <button
            className="game-btn"
            onClick={() => controllerRef.current?.restart()}
            title="Restart"
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
                {padButtonLabel(settings.bindings.pad.buttons.start[0] ?? 9)} to start
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
              Esc · menu &nbsp;·&nbsp; {keyLabel(settings.bindings.keys.restart[0] ?? '?')} · restart
            </p>
          </div>
        </div>
      )}
      {intro && hud?.phase === 'pre' && (
        <RankedIntro players={intro} viewAlliance={hud.alliance} />
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
          revealAt={hud.resultRevealAt}
          ranked={!!session?.ranked}
          eloResults={controllerRef.current?.getEloResults() ?? null}
          canRematch={!session || session.isHost()}
          onRematch={() => controllerRef.current?.rematch()}
          onExit={onExit}
          matchResult={controllerRef.current?.getMatchResult() ?? null}
          recordResult={controllerRef.current?.getRecordResult() ?? null}
          signedIn={signedIn}
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
            {hud.net && !hud.net.waitingFor && <NetQuality net={hud.net} />}
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

/** one driver card in the ranked intro (team/name, drivetrain badge, count-up ELO) */
function IntroCard({ p, index }: { p: IntroPlayer; index: number }) {
  const elo = useCountUp(p.elo ?? 0, true, 1100);
  return (
    <div
      className={`intro-card ${p.alliance} ${p.isLocal ? 'you' : ''}`}
      style={{ animationDelay: `${0.15 + index * 0.12}s` }}
    >
      <div className="intro-card-head">
        <span className="intro-team">{p.teamNumber ? `#${p.teamNumber}` : '—'}</span>
        {p.isLocal && <span className="intro-you">YOU</span>}
      </div>
      <div className="intro-name">{p.name || 'Unnamed'}</div>
      <div className="intro-sub">{p.teamName || 'No team'}</div>
      <div className="intro-meta">
        <span className="intro-dt">{DT_LABEL[p.drivetrain]}</span>
        <span className="intro-elo">{p.elo === null ? 'UNRANKED' : elo}</span>
      </div>
    </div>
  );
}

/** ranked pre-match intro: RED vs BLUE cards fly in from their sides, drivetrains
 * shown, ELO counting up. Runs during the ~4s pre-match countdown (the "MATCH
 * BEGINS IN" / 3-2-1 digits render on top). */
function RankedIntro({
  players,
  viewAlliance,
}: {
  players: IntroPlayer[];
  viewAlliance: Alliance;
}) {
  const red = players.filter((p) => p.alliance === 'red');
  const blue = players.filter((p) => p.alliance === 'blue');
  // put the local player's alliance on the left so it reads as "us vs them"
  const [left, leftName, right, rightName] =
    viewAlliance === 'blue'
      ? ([blue, 'BLUE', red, 'RED'] as const)
      : ([red, 'RED', blue, 'BLUE'] as const);
  return (
    <div className="intro-overlay">
      <div className="intro-eyebrow">RANKED MATCH</div>
      <div className="intro-cols">
        <div className="intro-col">
          <div className={`intro-side-label ${leftName.toLowerCase()}`}>{leftName}</div>
          {left.map((p, i) => (
            <IntroCard key={p.robotId} p={p} index={i} />
          ))}
        </div>
        <div className="intro-vs">VS</div>
        <div className="intro-col right">
          <div className={`intro-side-label ${rightName.toLowerCase()}`}>{rightName}</div>
          {right.map((p, i) => (
            <IntroCard key={p.robotId} p={p} index={i} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** one driver's ELO change row. Rows reveal in a stagger; the rating rolls from
 * `before` up/down to `after` while the delta chip slams in and pulses. */
function EloRow({ r, index }: { r: EloResultRow; index: number }) {
  const delta = r.after - r.before;
  // stagger each row, then run the count-up (and the CSS pop keys off `.in`)
  const [live, setLive] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setLive(true), 120 + index * 260);
    return () => window.clearTimeout(id);
  }, [index]);
  const after = useCountUp(r.after, live, 1100, r.before);
  const dir = delta >= 0 ? 'up' : 'down';
  return (
    <div className={`elo-row ${r.alliance} ${r.isLocal ? 'you' : ''} ${live ? 'in' : ''}`}>
      <span className="elo-name">
        {r.name}
        {r.isLocal && <span className="elo-you">YOU</span>}
        {r.provisional && (
          <span className="elo-prov" title="Provisional — your rating is still settling">
            ?
          </span>
        )}
      </span>
      <span className="elo-nums">
        <span className="elo-before">{r.before}</span>
        <span className="elo-arrow">→</span>
        <span className={`elo-after ${live ? dir : ''}`}>
          {after}
          {r.provisional && <span className="elo-prov-mark">?</span>}
        </span>
        <span className={`elo-delta ${dir} ${live ? 'pop' : ''}`}>
          <span className="elo-delta-caret">{delta >= 0 ? '▲' : '▼'}</span>
          {delta >= 0 ? `+${delta}` : delta}
        </span>
      </span>
    </div>
  );
}

/** ranked ELO change section on the results screen. `rows` is null until the
 * server's scored eloResult lands (a beat after the score), so we show a short
 * "Updating ELO…" placeholder — but never hang: if nothing arrives within a few
 * seconds (e.g. a match that couldn't be rated), fall back to a clear message. */
function EloResults({ rows }: { rows: EloResultRow[] | null }) {
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (rows !== null) return;
    const id = window.setTimeout(() => setTimedOut(true), 9000);
    return () => window.clearTimeout(id);
  }, [rows]);
  return (
    <div className="elo-block">
      <div className="elo-head">RANKED · ELO</div>
      {rows === null ? (
        <p className="ds-hint elo-wait">{timedOut ? 'No rating change this match.' : 'Updating ELO…'}</p>
      ) : (
        rows.map((r, i) => <EloRow key={r.robotId} r={r} index={i} />)
      )}
    </div>
  );
}

/** final match results — RED | category | BLUE, like the FTC audience board.
 * Foul rows show the fouls each alliance COMMITTED (its own count) — the POINTS
 * for those go to the OPPONENT's total (see the footnote), so a foul always
 * benefits the fouled alliance. */
function Results({
  hud,
  revealAt,
  ranked,
  eloResults,
  canRematch,
  onRematch,
  onExit,
  matchResult,
  recordResult,
  signedIn,
  onWatchReplay,
}: {
  hud: HudSnapshot;
  /** performance.now() ms the whoosh fires — the reveal (count-up + winner slam)
   * lands here; null ⇒ reveal immediately */
  revealAt: number | null;
  /** ranked match? shows the ELO-change section */
  ranked: boolean;
  /** per-driver ELO changes, or null until the server's eloResult lands */
  eloResults: EloResultRow[] | null;
  canRematch: boolean;
  onRematch: () => void;
  onExit: () => void;
  matchResult: MatchResultInfo | null;
  /** record run's leaderboard standing, or null until the server's recordResult
   * lands (or forever if anonymous) */
  recordResult: RecordRankInfo | null;
  signedIn: boolean;
  onWatchReplay?: (replay: Replay) => void;
}) {
  const red = hud.alliance === 'red' ? hud.score : hud.oppScore;
  const blue = hud.alliance === 'blue' ? hud.score : hud.oppScore;
  const winner: Alliance | 'tie' =
    red.total > blue.total ? 'red' : blue.total > red.total ? 'blue' : 'tie';

  // RECORD runs are opponent-free score attacks: no winner, and the player's own
  // fouls (which are "awarded" to the empty opposing alliance) SUBTRACT from the
  // net score shown + saved.
  const isRecord = matchResult?.kind === 'record';
  const mine = hud.score; // the player's own breakdown
  const penaltyPts = hud.oppScore.foulPoints; // points the player's fouls handed the empty opponent
  const netScore = Math.max(0, mine.total - penaltyPts);

  // hold the reveal until the whoosh fires, then count up + slam the winner
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (revealAt === null) {
      setRevealed(true);
      return;
    }
    const delay = Math.max(0, revealAt - performance.now());
    const id = window.setTimeout(() => setRevealed(true), delay);
    return () => window.clearTimeout(id);
  }, [revealAt]);
  const redTotal = useCountUp(red.total, revealed, 900);
  const blueTotal = useCountUp(blue.total, revealed, 900);
  const netTotal = useCountUp(netScore, revealed, 900);

  if (isRecord) {
    return (
      <RecordResults
        hud={hud}
        mine={mine}
        penaltyPts={penaltyPts}
        netScore={netScore}
        netTotal={netTotal}
        revealed={revealed}
        recordResult={recordResult}
        signedIn={signedIn}
        matchResult={matchResult}
        canRematch={canRematch}
        onRematch={onRematch}
        onExit={onExit}
        onWatchReplay={onWatchReplay}
      />
    );
  }

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
      <div className={`overlay-panel results ${revealed ? 'revealed' : 'tallying'}`}>
        <h2>{revealed ? 'MATCH RESULTS' : 'FINAL SCORE'}</h2>
        <div className={`results-head ${revealed ? 'reveal' : ''}`}>
          <div className={`res-side red ${revealed && winner === 'red' ? 'win' : ''}`}>
            <span>RED</span>
            <strong>{revealed ? redTotal : '—'}</strong>
          </div>
          <div className="res-verdict">
            {revealed ? (winner === 'tie' ? 'TIE' : `${winner.toUpperCase()} WINS`) : '···'}
          </div>
          <div className={`res-side blue ${revealed && winner === 'blue' ? 'win' : ''}`}>
            <span>BLUE</span>
            <strong>{revealed ? blueTotal : '—'}</strong>
          </div>
        </div>
        {!revealed && <p className="ds-hint results-wait">Tallying the score…</p>}
        {revealed && (
          <>
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
        {ranked && <EloResults rows={eloResults} />}
        <p className="ds-hint">
          Penalty points ({PTS_FOUL_MINOR} minor · {PTS_FOUL_MAJOR} major) come from the opponent's
          fouls and are already in each total.
        </p>
        {matchResult && (
          <p className="ds-hint" style={{ color: 'var(--ds-accent)' }}>
            {matchResult.kind === 'record'
              ? '✓ Recorded — sign in to save it to the leaderboard.'
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
          </>
        )}
      </div>
    </div>
  );
}

const DRIVETRAIN_LABEL: Record<string, string> = {
  mecanum: 'Mecanum',
  xdrive: 'X-Drive',
  tank: 'Tank',
  swerve: 'Swerve',
};
const prettyDrivetrain = (d: string): string => DRIVETRAIN_LABEL[d] ?? d;

/** the PB / WR / rank line on a record run's results screen. Null info ⇒ either
 * the run is still being scored (signed in) or it was anonymous (prompt to sign
 * in — anonymous runs are never persisted, so no rank exists). */
function RecordStanding({ info, signedIn }: { info: RecordRankInfo | null; signedIn: boolean }) {
  if (!info) {
    return signedIn ? (
      <p className="ds-hint record-standing pending">Saving · computing your rank…</p>
    ) : (
      <p className="record-standing signin">Sign in to save this run &amp; see your rank →</p>
    );
  }
  const cat = `${info.mode === 'duo' ? 'Duo' : 'Solo'} · ${prettyDrivetrain(info.drivetrain)}`;
  if (info.isWR) {
    return (
      <div className="record-standing wr">
        <strong>🏆 WORLD RECORD</strong>
        <span>{cat} · #1 of {info.total}</span>
      </div>
    );
  }
  if (info.isPB) {
    return (
      <div className="record-standing pb">
        <strong>★ NEW PERSONAL BEST</strong>
        <span>{cat} · #{info.rank} of {info.total}</span>
      </div>
    );
  }
  return (
    <div className="record-standing rank">
      <strong>#{info.rank}</strong>
      <span>of {info.total} · {cat}</span>
    </div>
  );
}

/** opponent-free record-run results: one net score (own penalties subtracted),
 * a PB / WR / rank line, and a single-column breakdown. No opponent, no winner. */
function RecordResults({
  hud,
  mine,
  penaltyPts,
  netScore,
  netTotal,
  revealed,
  recordResult,
  signedIn,
  matchResult,
  canRematch,
  onRematch,
  onExit,
  onWatchReplay,
}: {
  hud: HudSnapshot;
  mine: ScoreBreakdown;
  penaltyPts: number;
  netScore: number;
  netTotal: number;
  revealed: boolean;
  recordResult: RecordRankInfo | null;
  signedIn: boolean;
  matchResult: MatchResultInfo | null;
  canRematch: boolean;
  onRematch: () => void;
  onExit: () => void;
  onWatchReplay?: (replay: Replay) => void;
}) {
  const f = hud.fouls[hud.alliance]; // fouls the PLAYER committed
  const sections: [string, [string, number][]][] = [
    ['AUTONOMOUS', [
      ['Leave', mine.leave],
      ['Classified', mine.autoClassified],
      ['Overflow', mine.autoOverflow],
      ['Pattern', mine.autoPattern],
    ]],
    ['DRIVER-CONTROLLED', [
      ['Classified', mine.teleClassified],
      ['Overflow', mine.teleOverflow],
      ['Pattern', mine.telePattern],
    ]],
    ['END OF MATCH', [
      ['Depot', mine.depot],
      ['Base return', mine.base],
    ]],
  ];

  return (
    <div className="overlay">
      <div className={`overlay-panel results record ${revealed ? 'revealed' : 'tallying'}`}>
        <h2>{revealed ? 'RUN COMPLETE' : 'FINAL SCORE'}</h2>
        <div className={`record-scoreline ${revealed ? 'reveal' : ''}`}>
          <strong className="record-total">{revealed ? netTotal : '—'}</strong>
          <span className="record-total-label">POINTS</span>
        </div>
        {!revealed && <p className="ds-hint results-wait">Tallying the score…</p>}
        {revealed && (
          <>
            <RecordStanding info={recordResult} signedIn={signedIn} />
            <table className="score-table results-table record-table">
              <tbody>
                {sections.map(([title, rows]) => (
                  <Fragment key={title}>
                    <tr className="section-row"><td colSpan={2}>{title}</td></tr>
                    {rows.map(([label, v]) => (
                      <tr key={label}>
                        <td className="cat">{label}</td>
                        <td className="bv">{v}</td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
                <tr className="section-row"><td colSpan={2}>PENALTIES</td></tr>
                <tr className="penalty-row">
                  <td className="cat">
                    Fouls committed ({f.minor} minor · {f.major} major)
                  </td>
                  <td className="bv">{penaltyPts > 0 ? `−${penaltyPts}` : 0}</td>
                </tr>
                <tr className="total-row">
                  <td className="cat">NET SCORE</td>
                  <td className="bv">{netScore}</td>
                </tr>
              </tbody>
            </table>
            <p className="ds-hint">
              Your own fouls ({PTS_FOUL_MINOR} pt minor · {PTS_FOUL_MAJOR} pt major) subtract from
              your score.
            </p>
            <div className="overlay-buttons">
              {matchResult && onWatchReplay && (
                <button onClick={() => onWatchReplay(matchResult.replay)}>▶ WATCH REPLAY</button>
              )}
              {canRematch ? (
                <button onClick={onRematch}>RUN AGAIN</button>
              ) : (
                <button disabled>WAITING FOR HOST…</button>
              )}
              <button onClick={onExit}>MENU</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

