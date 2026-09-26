import { Fragment, useEffect, useState, type ReactNode } from 'react';
import {
  fetchElo,
  fetchRecords,
  fetchSeasons,
  type Board,
  type EloMode,
  type EloRow,
  type EloStanding,
  type RecordConfig,
  type RecordMode,
  type RecordRow,
  type SeasonInfo,
} from '../net/api';
import { gameServerConfigured } from '../net/env';
import { periodLabel } from '../seasons';
import { moduleFor } from '../games';
import { serverPhysics } from '../games/types';
import { PeriodPicker } from './PeriodPicker';
import { DRIVETRAIN_LABELS } from './labelData';
import { SupporterBadge, type StaffRole } from './SupporterBadge';
import { BadgeMarks } from './BadgeMark';
import { PLACEMENT_GAMES } from '../config';
import {
  CHAIN_MODE_LABELS,
  CHAIN_INTAKE_LABELS,
  CHAIN_INTAKE_MOUNT_LABELS,
  CHAIN_SHOOTER_MOUNT_LABELS,
} from '../games/chain/labels';
import { intakeMountOf, shooterMountOf } from '../games/chain/mounts';
import {
  CHAIN_DEFAULT_SCORE_MODE,
  CHAIN_DEFAULT_INTAKE,
  CHAIN_STORAGE_DEFAULT,
  CHAIN_CLEARANCE_DEFAULT,
} from '../games/chain/config';
import type { DrivetrainType, GameId, IntakeStyle, RobotSpec } from '../types';

type Kind = 'records' | 'ranked';

// RECORD boards are split by drivetrain (+ a cross-drivetrain Overall); the
// picker shows for records only — ranked (rating) is a single board per mode.
// ONE label map (design review 07-21): the pill said "X-Drive" and the Robot chip under it
// "X-drive". Both read the shared builder labels now.
const DT_LABEL: Record<DrivetrainType, string> = DRIVETRAIN_LABELS;
const BOARD_ORDER: DrivetrainType[] = ['mecanum', 'tank', 'swerve', 'xdrive', 'butterfly'];
const BOARDS: { id: Board; label: string }[] = [
  { id: 'overall', label: 'Overall' },
  ...BOARD_ORDER.map((id) => ({ id, label: DT_LABEL[id] })),
];
const INTAKE_LABEL: Record<IntakeStyle, string> = {
  sloped: 'Sloped',
  vector: 'Vector',
  triangle: 'Triangle',
};

/** a driver's name on a board: display handle + muted @username, clickable to
 * their public profile when they have a username (legacy rows without one render
 * as plain text). Stops propagation so clicking a name never triggers the row's
 * watch-replay handler. */
function DriverName({
  handle,
  username,
  supporter,
  role,
  badges,
  onOpenProfile,
}: {
  handle: string | null;
  username: string | null;
  supporter?: boolean;
  role?: StaffRole;
  /** the worn badges and their counters (`badgeCols`, 0048) */
  badges?: unknown;
  onOpenProfile?: (username: string) => void;
}) {
  const label = handle ?? (username ? `@${username}` : 'Player');
  if (username && onOpenProfile) {
    return (
      <button
        className="lb-name"
        onClick={(e) => {
          e.stopPropagation();
          onOpenProfile(username);
        }}
        title={`View @${username}`}
      >
        {/* the badge is a SIBLING of the name, not a child of it. `.lb-name-h`
            carries the hover underline, so a badge inside it got underlined
            along with the name — and a badge is decoration beside a name, not
            part of it. */}
        <span className="lb-name-h">{label}</span>
        <SupporterBadge supporter={supporter} role={role} />
        <BadgeMarks badges={badges} />
        <span className="lb-at">@{username}</span>
      </button>
    );
  }
  return (
    <>
      <span className="lb-name-h">{label}</span>
      <SupporterBadge supporter={supporter} role={role} />
      {/* a row without a username (an anonymous or unclaimed run) still shows whatever
          badges it is wearing */}
      <BadgeMarks badges={badges} />
    </>
  );
}

/** one robot's spec stats (shared by solo + each half of a duo). Game-aware: a
 * Chain Reaction robot shows its CR config (archetype / sweeper mount / hopper /
 * clearance), NOT the DECODE intake-preset + flywheel — those fields are unused in
 * CR and would read as a "weird" random configuration. */
function RobotSpecSummary({ spec, game }: { spec: RobotSpec; game?: GameId }) {
  const isChain = game === 'chain';
  // a game that owns its config sentence (the module's `labels.configSummary`
  // slot) prints THAT instead of tiles naming fields it may not have
  const own = moduleFor(game).labels?.configSummary;
  const stat = (value: ReactNode, label: string, small = false) => (
    <div className="ds-stat">
      {/* `small` is the TEXT variant of a stat value (a drivetrain name, an
          archetype) — a type step, so it is a class, not an inline size. */}
      <span className={`sv${small ? ' sm' : ''}`}>{value}</span>
      <span className="sl">{label}</span>
    </div>
  );

  const chainMode = spec.scoreMode ?? CHAIN_DEFAULT_SCORE_MODE;
  // a turret is top-mounted, so its mount is meaningless — only name it for drum/dumper
  const sMount = shooterMountOf(spec);
  const archetype =
    CHAIN_MODE_LABELS[chainMode] +
    (chainMode !== 'turret' && sMount !== 'front' ? ` · ${CHAIN_SHOOTER_MOUNT_LABELS[sMount].toLowerCase()}` : '');
  const sweeper = `${CHAIN_INTAKE_LABELS[spec.chainIntake ?? CHAIN_DEFAULT_INTAKE]} · ${CHAIN_INTAKE_MOUNT_LABELS[intakeMountOf(spec)]}`;

  return (
    <>
      <div className="lb-config-name">
        {spec.name}
        {spec.teamNumber ? ` · #${spec.teamNumber}` : ''}
        {spec.teamName ? ` · ${spec.teamName}` : ''}
      </div>
      <div className="ds-stats">
        {stat(DT_LABEL[spec.drivetrain], 'drivetrain', true)}
        {stat(spec.massLb, 'lb mass')}
        {stat(spec.driveRpm, 'drive rpm')}
        {own ? (
          stat(own(spec), 'config', true)
        ) : isChain ? (
          <>
            {stat(archetype, 'archetype', true)}
            {stat(sweeper, 'intake', true)}
            {stat(Math.round(spec.ballStorage ?? CHAIN_STORAGE_DEFAULT), 'hopper')}
            {stat(`${(spec.groundClearance ?? CHAIN_CLEARANCE_DEFAULT).toFixed(1)}"`, 'clearance')}
          </>
        ) : (
          <>
            {stat(`${INTAKE_LABEL[spec.intake]}${spec.canSort ? ' +sort' : ''}`, 'intake', true)}
            {stat(spec.flywheelInertia.toFixed(2), 'flywheel')}
          </>
        )}
        {stat(`${spec.length}×${spec.width}"`, 'size')}
      </div>
    </>
  );
}

/** the robot config a record was set with — each driver's spec stats + the
 * owner's assists. A duo shows BOTH robots (drivers bring their own builds). */
function ConfigSummary({ cfg, game }: { cfg: RecordConfig; game?: GameId }) {
  const { spec, assists, partnerSpec } = cfg;
  const chip = (label: string, on: boolean) => (
    <span className={`ds-chip ${on ? 'on' : 'off'}`}>{label}</span>
  );
  return (
    <div className="lb-config">
      <RobotSpecSummary spec={spec} game={game} />
      {partnerSpec && <RobotSpecSummary spec={partnerSpec} game={game} />}
      <div className="lb-config-assists">
        {chip(assists.fieldCentric ? 'Field-centric' : 'Robot-centric', true)}
        {chip('Aim assist', assists.aimAssist)}
        {chip('Auto intake', assists.autoIntake)}
        {chip('Auto fire', assists.autoFire)}
      </div>
    </div>
  );
}

/** the signed-in viewer's own standing on the selected ranked board: their rank
 * once PLACED, or a "matches until placement" progress line while still in
 * placements. Only placed players appear in the table above, so this is the one
 * place a not-yet-placed (or off-page) player sees where they stand. */
function MyStanding({ me }: { me: EloStanding }) {
  const placed = me.rank != null;
  if (placed) {
    return (
      <div className="lb-standing placed">
        <span className="lb-standing-rank">#{me.rank}</span>
        <span className="lb-standing-text">
          Your rating · <strong>{me.rating}</strong>
        </span>
      </div>
    );
  }
  const remaining = Math.max(0, PLACEMENT_GAMES - me.games);
  return (
    <div className="lb-standing placing">
      <span className="lb-standing-badge">?</span>
      <div className="lb-standing-col">
        <span className="lb-standing-text">
          <strong>{remaining}</strong> {remaining === 1 ? 'match' : 'matches'} until placement
        </span>
        <span className="lb-standing-sub">
          {me.games}/{PLACEMENT_GAMES} placement matches played
        </span>
        <span className="lb-standing-bar" aria-hidden>
          <span style={{ width: `${Math.min(100, (me.games / PLACEMENT_GAMES) * 100)}%` }} />
        </span>
      </div>
    </div>
  );
}

/**
 * Ranked + record leaderboards. Segmented by board type (records / ranked),
 * mode, and drivetrain, read live from the server's public API. Empty and error
 * states are first-class (the boards start empty and fill as matches are played).
 */
export function Leaderboard({
  myUserId,
  game,
  onWatch,
  onOpenProfile,
}: {
  myUserId?: string | null;
  game?: GameId;
  onWatch?: (replayId: string) => void;
  onOpenProfile?: (username: string) => void;
}) {
  const [kind, setKind] = useState<Kind>('records');
  const [recMode, setRecMode] = useState<RecordMode>('solo');
  const [eloMode, setEloMode] = useState<EloMode>('1v1');
  const [board, setBoard] = useState<Board>('overall'); // record boards only
  /**
   * THE ERA FILTER IS GONE (owner ruling, 2026-09-18), and so is the 2D/3D chip per row.
   *
   * There was an All / 3D / 2D segmented control here, because the two eras shared this board.
   * They do not share it: every server-connected match of a game that can step 3D runs 3D
   * (`serverPhysics`), so this board is the 3D board and the server filters it (`boardPhysics`
   * in server/db/repo.ts) — a client-side picker could only ask for a second board that nothing
   * new can ever be added to.
   *
   * ── WHAT HAPPENED TO THE 2D ROWS ──────────────────────────────────────────────────────────
   * Nothing. They keep their row, their replay and their place in the player's own match
   * history; a season was NOT reset over this (the owner's standing rule), and the column
   * migration 0039 added is what makes hiding them possible without wiping anything.
   *
   * `threeD` is what `twoEras` became: it filters an older server's mixed response down to the
   * rows this board is actually made of (see the `physics` filter below).
   */
  const threeD = serverPhysics(moduleFor(game)) === '3d';

  const [rows, setRows] = useState<(RecordRow | EloRow)[]>([]);
  const [me, setMe] = useState<EloStanding | null>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  /** bumped by Try again: re-runs the fetch effect */
  const [retry, setRetry] = useState(0);
  const [openRow, setOpenRow] = useState<string | null>(null);

  // seasons: null selection = the live season (server default)
  const [seasons, setSeasons] = useState<SeasonInfo[]>([]);
  const [current, setCurrent] = useState<number | null>(null);
  const [season, setSeason] = useState<number | null>(null);

  const configured = gameServerConfigured();

  useEffect(() => {
    if (!configured) return;
    let alive = true;
    fetchSeasons(game)
      .then((r) => {
        if (!alive) return;
        setSeasons(r.seasons);
        setCurrent(r.current);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [configured, game]);

  // a different BOARD (records vs ELO, or another game) has other columns: its rows are
  // not a stale view of this one, so they go rather than fading under the new header
  useEffect(() => {
    setRows([]);
    setMe(null);
  }, [kind, game]);

  useEffect(() => {
    if (!configured) {
      setStatus('error');
      // an unconfigured build (dev, self-host): the env-var name is a developer's next step,
      // never a player's (design review 07-04 / 19-03)
      if (import.meta.env.DEV) console.warn('[leaderboard] VITE_GAME_SERVER_URL is not set');
      return;
    }
    let alive = true;
    // the previous rows and standing STAY while this is in flight (see `refetching`)
    setStatus('loading');
    const s = season ?? undefined;
    const req =
      kind === 'records'
        ? fetchRecords(recMode, board, s, game).then((r) => ({
            /**
             * TOLERATING AN OLDER SERVER. One Fly app serves every client version and the
             * reverse is just as true — this page can be talking to a deploy that predates
             * the ruling and still returns both eras. Such a response is filtered HERE, where
             * the field is present; a row that carries no `physics` at all is older still and
             * is kept, because dropping it would blank the board for a game whose rows are all
             * 2D anyway (DECODE, Chain Reaction) and for pre-0039 rows that are what they are.
             *
             * The era kept is the one the server ECHOES, because it is per season now: an
             * archived season is the solve it was played on (BIOBUZZ Act 1 is 2D). A server that
             * echoes nothing predates the ruling; its board is the 3D one.
             */
            rows: threeD
              ? r.rows.filter((x) => !x.physics || x.physics === (r.physics ?? '3d'))
              : r.rows,
            me: null as EloStanding | null,
          }))
        : fetchElo(eloMode, s, myUserId, game);
    req
      .then(({ rows, me }) => {
        if (!alive) return;
        setRows(rows);
        setMe(me);
        setStatus('ok');
      })
      .catch((e: unknown) => {
        if (!alive) return;
        // the raw text ("Failed to fetch", "HTTP 502") is for the console, not the board
        console.warn('[leaderboard] load failed:', e);
        setStatus('error');
      });
    return () => {
      alive = false;
    };
  }, [kind, recMode, eloMode, board, threeD, season, configured, myUserId, game, retry]);

  const isRecords = kind === 'records';
  /* A FILTER CHANGE KEEPS THE TABLE UP (design review 07-16). Blanking it for a 30px
     "Loading…" collapsed the panel on every seg click and page turn; the old rows stay,
     faded and `aria-busy`, and `.ds-loading` is the FIRST load's only. */
  const refetching = status === 'loading' && rows.length > 0;
  const valueLabel = isRecords ? 'Score' : 'Rating';
  const viewing = season ?? current;
  const viewingSeason = seasons.find((s) => s.season === viewing);
  const seasonLabel = viewingSeason ? periodLabel(viewingSeason) : 'Current period';
  const isArchived = viewing != null && current != null && viewing < current;

  return (
    <>
      {/* the page heading is owned by the Records host; the period heading is the same
          one Career prints (07-08) */}
      <h2 className="ds-h2 ds-period-head">
        {seasonLabel}
        {isArchived ? ' · final' : ''}
      </h2>

      <PeriodPicker seasons={seasons} current={current} value={season} onChange={setSeason} label="Period" />

      <div className="ds-panel">
        <div className="ds-panel-h">
          <div className="ds-segs">
            <button className={`ds-seg ${isRecords ? 'on' : ''}`} aria-pressed={isRecords} onClick={() => setKind('records')}>
              High scores
            </button>
            <button className={`ds-seg ${!isRecords ? 'on' : ''}`} aria-pressed={!isRecords} onClick={() => setKind('ranked')}>
              Ranked
            </button>
          </div>
          <div className="ds-segs">
            {isRecords ? (
              <>
                <button className={`ds-seg ${recMode === 'solo' ? 'on' : ''}`} aria-pressed={recMode === 'solo'} onClick={() => setRecMode('solo')}>
                  Solo
                </button>
                <button className={`ds-seg ${recMode === 'duo' ? 'on' : ''}`} aria-pressed={recMode === 'duo'} onClick={() => setRecMode('duo')}>
                  Duo
                </button>
              </>
            ) : (
              <>
                <button className={`ds-seg ${eloMode === '1v1' ? 'on' : ''}`} aria-pressed={eloMode === '1v1'} onClick={() => setEloMode('1v1')}>
                  1v1
                </button>
                <button className={`ds-seg ${eloMode === '2v2' ? 'on' : ''}`} aria-pressed={eloMode === '2v2'} onClick={() => setEloMode('2v2')}>
                  2v2
                </button>
              </>
            )}
          </div>
        </div>

        {isRecords && (
          <div className="ds-panel-h">
            <span className="ds-panel-title">Drivetrain</span>
            {/* `.even` — six entries never fit a phone, so this one wraps into an even grid
                rather than a ragged 4 + 2. See the rule in shell.css for why not a scroller. */}
            <div className="ds-segs even">
              {BOARDS.map((b) => (
                <button key={b.id} className={`ds-seg ${board === b.id ? 'on' : ''}`} aria-pressed={board === b.id} onClick={() => setBoard(b.id)}>
                  {b.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* not while refetching: the standing sits outside the faded rows and would name the old mode */}
        {!isRecords && status === 'ok' && me && <MyStanding me={me} />}

        {status === 'loading' && !refetching && <div className="ds-loading">Loading…</div>}
        {status === 'error' &&
          (configured ? (
            <>
              <div className="ds-empty">
                <div className="big">Couldn’t load the board</div>
                Check your connection and try again.
              </div>
              <div className="ds-panel-body row">
                <span className="ds-head-spacer" />
                <button className="ds-btn" onClick={() => setRetry((n) => n + 1)}>
                  Try again
                </button>
              </div>
            </>
          ) : (
            <div className="ds-empty">
              <div className="big">Leaderboards are online-only</div>
              This build isn’t connected to a game server. Solo practice and free drive still work.
            </div>
          ))}
        {status === 'ok' && rows.length === 0 && (
          <div className="ds-empty">
            <div className="big">{isRecords ? 'No entries yet' : 'No placed players yet'}</div>
            {isRecords
              ? 'Be the first to set a score on this board.'
              : `Players appear here after ${PLACEMENT_GAMES} ranked matches.`}
          </div>
        )}
        {(status === 'ok' || refetching) && rows.length > 0 && (
          /* SCROLL WRAPPER. `.ds-panel` is `overflow: hidden` for its rounded corners,
             which on a phone did not shrink this table — it CUT it, ~200px of it, with
             no way to scroll to the Score column and driver @usernames sliced mid-word.
             The one table scroller (`.ds-table-scroll`), so every table degrades
             identically; on a phone `.lb-table` pins the value column to the right. */
          <div className="ds-table-scroll tall" aria-busy={refetching}>
          <table className={`ds-table lb-table${isRecords ? ' rec' : ''}`}>
            <thead>
              <tr>
                <th className="rk">#</th>
                <th>Driver</th>
                {isRecords && <th>Robot</th>}
                {!isRecords && <th className="r">Games</th>}
                <th className="r lb-val">{valueLabel}</th>
                {isRecords && (
                  <th className="lb-watch">
                    <span className="ds-sr">Replay</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const rec = r as RecordRow;
                const watchable = isRecords && !!rec.replayId && !!onWatch;
                const cfg = isRecords ? rec.config : null;
                const isOpen = openRow === r.userId;
                const isMe = !!myUserId && r.userId === myUserId;
                return (
                  <Fragment key={r.userId}>
                    <tr
                      className={`${watchable ? 'ds-clickable' : ''}${isMe ? ' lb-you' : ''}`}
                      onClick={watchable ? () => onWatch!(rec.replayId!) : undefined}
                      title={watchable ? 'Watch replay' : undefined}
                    >
                      <td className="rk">{i + 1}</td>
                      <td>
                        <span className="lb-drivers">
                          <DriverName
                            handle={r.handle}
                            username={r.username}
                            supporter={r.supporter}
                            role={r.role}
                            badges={r.badges}
                            onOpenProfile={onOpenProfile}
                          />
                          {isRecords && rec.partnerId && (
                            <>
                              <span className="lb-amp">+</span>
                              <DriverName
                                handle={rec.partnerHandle}
                                username={rec.partnerUsername}
                                supporter={rec.partnerSupporter}
                                role={rec.partnerRole}
                                badges={rec.partnerBadges}
                                onOpenProfile={onOpenProfile}
                              />
                              <span className="ds-dt lb-duo-tag">DUO</span>
                            </>
                          )}
                          {isMe && <span className="ds-badge accent">YOU</span>}
                          {/* NO ERA CHIP. There was a 2D/3D tag here while the two eras shared
                              this board; every row on it is now 3D, and a chip whose value never
                              varies is furniture beside a name that has two real ones. */}
                        </span>
                      </td>
                      {isRecords && (
                        <td>
                          {cfg ? (
                            <button
                              className="lb-robot"
                              aria-expanded={isOpen}
                              aria-controls={`lb-detail-${r.userId}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                setOpenRow(isOpen ? null : r.userId);
                              }}
                            >
                              {DT_LABEL[cfg.spec.drivetrain]}
                              {cfg.partnerSpec && ` + ${DT_LABEL[cfg.partnerSpec.drivetrain]}`}
                              <span className="tw" aria-hidden="true">{isOpen ? '▴' : '▾'}</span>
                            </button>
                          ) : (
                            <span className="ds-muted">—</span>
                          )}
                        </td>
                      )}
                      {!isRecords && <td className="num">{(r as EloRow).games}</td>}
                      <td className="sc lb-val">{isRecords ? rec.score : (r as EloRow).rating}</td>
                      {/* its OWN column, as in match history: sharing the score cell put the
                          right-aligned Score header over the button, not the number */}
                      {isRecords && (
                        <td className="lb-watch">
                          {/* the button is the keyboard path; the row click is a mouse convenience,
                              so the button stops propagation or it would open the replay twice */}
                          {watchable && (
                            <button
                              className="ds-btn ghost mh-watch"
                              aria-label={`Watch replay, score ${rec.score}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                onWatch!(rec.replayId!);
                              }}
                            >
                              Watch
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                    {isRecords && isOpen && cfg && (
                      <tr className="lb-detail" id={`lb-detail-${r.userId}`}>
                        <td colSpan={5}>
                          <ConfigSummary cfg={cfg} game={game} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </>
  );
}
