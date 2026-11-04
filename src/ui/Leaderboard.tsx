import { Fragment, useEffect, useRef, useState } from 'react';
import {
  fetchElo,
  fetchRecords,
  fetchSeasons,
  fetchUserStats,
  type EloRow,
  type EloStanding,
  type RecordConfig,
  type RecordRow,
  type SeasonInfo,
} from '../net/api';
import { gameServerConfigured } from '../net/env';
import { periodLabel, seasonFor } from '../seasons';
import { moduleFor } from '../games';
import { serverPhysics } from '../games/types';
import { visibleGameIds } from '../seasonVisibility';
import { DRIVETRAIN_LABELS } from './labelData';
import { SupporterBadge, type StaffRole } from './SupporterBadge';
import { BadgeMarks } from './BadgeMark';
import { RANKED_PLACEMENT } from '../config';
import { RobotSheet, UnsavedSheet } from './RobotSheet';
import { fmtDay } from './fmtDate';
import { LatestRecords } from './LatestRecords';
import { useListTop } from './pageScroll';
import {
  BOARD_KEYS,
  BOARD_LABELS,
  CATEGORIES,
  CATEGORY_LABELS,
  DRIVETRAIN_BOARDS,
  isScoreBoard,
  type BoardQuery,
} from './recordsQuery';
import type { GameId } from '../types';

/** what a server older than 2026-10-03 places at, for both modes (it sends no `minGames`) */
const OLD_SERVER_PLACEMENT = 5;

/** a drivetrain board's name: Overall, or the builder's own label (design review 07-21: one label map) */
const dtName = (b: (typeof DRIVETRAIN_BOARDS)[number]): string => (b === 'overall' ? 'Overall' : DRIVETRAIN_LABELS[b]);

/** a driver's name on a board: display handle + muted @username, clickable to
 * their public profile when they have a username (legacy rows without one render
 * as plain text). Stops propagation so clicking a name never opens the row. */
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
        {/* the badge is a SIBLING of the name, not a child of it: `.lb-name-h` carries the hover
            underline, and a badge is decoration beside a name, not part of it */}
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
      <BadgeMarks badges={badges} />
    </>
  );
}

/** a driver's name as the row prints it */
const nameOf = (handle: string | null, username: string | null): string => handle ?? (username ? `@${username}` : 'Player');

/**
 * WHO DROVE WHAT: each driver's robot as a sheet, with how they drove it. A solo record is one
 * sheet across the panel, which lays itself out as a row at that width. A duo is two equal sheets
 * headed by their drivers (drivers bring their own builds and their own assists, 0064), in the
 * order the row names them; a partner the run kept no robot for still gets a card, so the pair
 * reads as a pair.
 */
function ConfigSummary({ cfg, game, driver, partner }: { cfg: RecordConfig; game: GameId; driver: string; partner: string | null }) {
  const { spec, assists, partnerSpec, partnerAssists } = cfg;
  return (
    <div className={`lb-config${partner ? ' duo' : ''}`}>
      <RobotSheet spec={spec} game={game} assists={assists} driver={partner ? driver : undefined} />
      {partner &&
        (partnerSpec ? (
          <RobotSheet spec={partnerSpec} game={game} assists={partnerAssists} driver={partner} />
        ) : (
          <UnsavedSheet driver={partner} />
        ))}
    </div>
  );
}

/** the viewer's place when it is not among the rows the board returned: a rank and a value, or (on a
 *  ranked ladder) how many matches are left before there is one */
interface FootRow {
  rank: number | null;
  value: number | null;
  /** ranked: matches still to play before placement */
  toPlace?: number;
}

/**
 * THE LEADERBOARDS TAB (`docs/records-redesign.md`). One picker for the board (Solo · Duo · 1v1 ·
 * 2v2), one line of filters, then the rows, so the first row sits under three controls instead of
 * seven. The board is the URL's query (`recordsQuery.ts`); this component reads it and hands every
 * change back through `onQuery`, so the address is always the board on screen.
 *
 * A row is three targets with one job each: the name opens the profile, ▶ plays the replay, and the
 * rest of the row (or Enter on it) opens the robot sheets and the date the run was set. Clicking a
 * row used to play the replay, so a click meant for the robot left the page.
 *
 * GONE, deliberately: the Window control (Today / This week / This month / All time) and the 2D/3D
 * switch only All time had. A day or week board is the season board's top few or empty at this
 * player count, All time mixed balance versions the season boards keep apart, and it was a second
 * time control that hid the period picker. The server still answers `window` for older clients.
 */
export function Leaderboard({
  myUserId,
  game,
  query,
  onQuery,
  onGame,
  onWatch,
  onOpenProfile,
}: {
  myUserId?: string | null;
  game: GameId;
  query: BoardQuery;
  /** a filter changed: the new board (written to the address in place) */
  onQuery: (q: BoardQuery) => void;
  /** another game's boards (the address's game prefix changes, as `/chain/records` does) */
  onGame: (g: GameId) => void;
  onWatch?: (replayId: string) => void;
  onOpenProfile?: (username: string) => void;
}) {
  const { board, cat, dt, season } = query;
  const score = isScoreBoard(board);
  /**
   * ONE PHYSICS PER BOARD (owner ruling, 2026-09-18): every server-connected match of a game that can
   * step 3D runs 3D, so the board is the 3D board and the server filters it. `threeD` filters an
   * older server's mixed response down to the era the server names.
   */
  const threeD = serverPhysics(moduleFor(game)) === '3d';

  const [rows, setRows] = useState<(RecordRow | EloRow)[]>([]);
  const [me, setMe] = useState<EloStanding | null>(null);
  /** the viewer's own best on a score board, for the foot row (Overall · Total only: `fetchUserStats`) */
  const [myBest, setMyBest] = useState<{ best: number | null; rank: number | null } | null>(null);
  const [minGames, setMinGames] = useState<number>(RANKED_PLACEMENT['1v1']);
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  // the server answered but cannot rank by this category (an older deploy)
  const [unsupported, setUnsupported] = useState(false);
  /** bumped by Try again: re-runs the fetch effect */
  const [retry, setRetry] = useState(0);
  const [openRow, setOpenRow] = useState<string | null>(null);
  /** a phone keeps the filter line behind one summary button */
  const [filtersOpen, setFiltersOpen] = useState(false);

  // the periods of THIS game: a period number from another game is never offered or sent
  const [seasons, setSeasons] = useState<SeasonInfo[]>([]);
  const [current, setCurrent] = useState<number | null>(null);
  const [periodGame, setPeriodGame] = useState(game);
  if (periodGame !== game) {
    setPeriodGame(game);
    setSeasons([]);
    setCurrent(null);
  }

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

  // a different KIND of board (score vs ranked, or another game) has other columns: its rows are not
  // a stale view of this one, so they go rather than fading under the new header
  useEffect(() => {
    setRows([]);
    setMe(null);
    setOpenRow(null);
  }, [score, game]);

  useEffect(() => {
    if (!configured) {
      setStatus('error');
      if (import.meta.env.DEV) console.warn('[leaderboard] VITE_GAME_SERVER_URL is not set');
      return;
    }
    let alive = true;
    // the previous rows STAY while this is in flight (see `refetching`)
    setStatus('loading');
    const s = season ?? undefined;
    const req = score
      ? fetchRecords(board, dt, s, game, { category: cat }).then((r) => ({
          /**
           * ⚠️ AN OLDER SERVER IGNORES `category` AND ANSWERS THE TOTAL BOARD. A current server echoes
           * it, so a missing or different echo means "not available here yet" and the board is left
           * empty with a sentence rather than showing Total under an Auto label.
           */
          unsupported: cat !== 'total' && r.category !== cat,
          rows: cat !== 'total' && r.category !== cat ? [] : threeD ? r.rows.filter((x) => !x.physics || x.physics === (r.physics ?? '3d')) : r.rows,
          me: null as EloStanding | null,
          minGames: undefined as number | undefined,
        }))
      : fetchElo(board, s, myUserId, game).then((r) => ({ ...r, unsupported: false }));
    req
      .then((r) => {
        if (!alive) return;
        setRows(r.rows);
        setUnsupported(r.unsupported);
        setMe(r.me);
        setMinGames(typeof r.minGames === 'number' ? r.minGames : OLD_SERVER_PLACEMENT);
        setStatus('ok');
      })
      .catch((e: unknown) => {
        if (!alive) return;
        console.warn('[leaderboard] load failed:', e);
        setStatus('error');
      });
    return () => {
      alive = false;
    };
  }, [board, cat, dt, season, score, threeD, configured, myUserId, game, retry]);

  // YOUR BEST on a score board, for the foot row when you are not among the rows. Only Overall · Total
  // has it: `fetchUserStats` ranks the overall season best, and `/api/records` sends no viewer row.
  const footable = score && cat === 'total' && dt === 'overall' && !!myUserId && configured;
  useEffect(() => {
    setMyBest(null);
    if (!footable) return;
    let alive = true;
    fetchUserStats(myUserId as string, season ?? undefined, game)
      .then((st) => {
        if (!alive) return;
        const r = st.records.find((x) => x.mode === board);
        setMyBest(r ? { best: r.best, rank: r.rank } : null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [footable, myUserId, season, game, board]);

  const isMine = (r: RecordRow | EloRow): boolean =>
    !!myUserId && (r.userId === myUserId || (score && (r as RecordRow).partnerId === myUserId));
  const listed = rows.some(isMine);
  const foot: FootRow | null =
    status !== 'ok' || listed
      ? null
      : score
        ? myBest && myBest.best != null
          ? { rank: myBest.rank, value: myBest.best }
          : null
        : me
          ? me.rank != null
            ? { rank: me.rank, value: me.rating }
            : { rank: null, value: null, toPlace: Math.max(0, minGames - me.games) }
          : null;

  // A BOARD PICK OR A FILTER CHANGES THE ROWS IN PLACE (`pageScroll.ts`, rule 4): the page stays, unless
  // the board's top is above the visible area, when it comes back to just under the bar
  const boardRef = useRef<HTMLDivElement>(null);
  useListTop(`${game}|${board}|${cat}|${dt}|${season ?? ''}`, boardRef);

  // OPEN AT YOUR ROW (My records' tiles link with `me=1`): once, when the board lands, then the flag
  // leaves the address so a reload does not scroll again
  const tableRef = useRef<HTMLTableElement>(null);
  useEffect(() => {
    if (!query.me || status !== 'ok') return;
    const el = tableRef.current?.querySelector('.lb-you, .rb-foot');
    el?.scrollIntoView({ block: 'center' });
    onQuery({ ...query, me: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.me, status, rows]);

  /* A FILTER CHANGE KEEPS THE TABLE UP (design review 07-16): the old rows stay, faded and
     `aria-busy`, and `.ds-loading` is the FIRST load's only. */
  const refetching = status === 'loading' && rows.length > 0;
  const viewing = season ?? current;
  const archived = viewing != null && current != null && viewing < current;
  const games = visibleGameIds();
  const set = (patch: Partial<BoardQuery>): void => onQuery({ ...query, ...patch, me: false });
  const viewingInfo = seasons.find((x) => x.season === viewing);
  // the phone's filter button says what the line is set to, most-changed first (it ellipsizes from the end)
  const summary = [
    score ? CATEGORY_LABELS[cat] : null,
    score ? dtName(dt) : null,
    viewingInfo ? `${periodLabel(viewingInfo)}${archived ? ' (final)' : ''}` : null,
    games.length > 1 ? seasonFor(game).name : null,
  ]
    .filter(Boolean)
    .join(' · ');
  /** both tables are four columns: #, who, the value, and the replay (score) or games (ranked) */
  const cols = 4;

  return (
    <div className="rb-layout">
      <div ref={boardRef} className="ds-panel rb-board">
        <div className="rb-controls">
          <div className="ds-segs rb-boards" role="group" aria-label="Board">
            {BOARD_KEYS.map((b) => (
              <button key={b} className={`ds-seg${board === b ? ' on' : ''}`} aria-pressed={board === b} onClick={() => set({ board: b })}>
                {BOARD_LABELS[b]}
              </button>
            ))}
          </div>
          {/* a phone keeps the line behind this; the label is what the line is set to */}
          <button
            className="ds-btn small rb-filter-toggle"
            aria-expanded={filtersOpen}
            aria-controls="rb-filters"
            onClick={() => setFiltersOpen((o) => !o)}
          >
            <span className="rb-filter-sum">{summary || 'Filters'}</span>
            <span aria-hidden="true">{filtersOpen ? '▴' : '▾'}</span>
          </button>
          <div id="rb-filters" className={`rb-filters${filtersOpen ? ' open' : ''}`}>
            {games.length > 1 && (
              <select className="ds-select" aria-label="Game" value={game} onChange={(e) => onGame(e.target.value as GameId)}>
                {games.map((g) => (
                  <option key={g} value={g}>
                    {seasonFor(g).name}
                  </option>
                ))}
              </select>
            )}
            {score && (
              <select className="ds-select" aria-label="Ranked by" value={cat} onChange={(e) => set({ cat: e.target.value as BoardQuery['cat'] })}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
            )}
            {score && (
              <select className="ds-select" aria-label="Drivetrain" value={dt} onChange={(e) => set({ dt: e.target.value as BoardQuery['dt'] })}>
                {DRIVETRAIN_BOARDS.map((d) => (
                  <option key={d} value={d}>
                    {dtName(d)}
                  </option>
                ))}
              </select>
            )}
            {seasons.length > 1 && (
              <select
                className="ds-select"
                aria-label="Period"
                value={viewing ?? ''}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  set({ season: current != null && n === current ? null : n });
                }}
              >
                {/* the newest is the live one; a past one says Final beside the select */}
                {seasons.map((x) => (
                  <option key={x.season} value={x.season}>
                    {periodLabel(x)}
                  </option>
                ))}
              </select>
            )}
            {archived && <span className="ds-badge">Final</span>}
          </div>
        </div>

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
            <div className="big">{score ? (unsupported ? 'Not available yet' : 'No entries yet') : 'No placed players yet'}</div>
            {score && unsupported
              ? 'This server can’t rank by period yet. Try again after the next update.'
              : score
                ? cat === 'total'
                  ? 'Be the first to set a score on this board.'
                  : cat === 'auto'
                    ? 'No Auto scores yet. Run “Auto only” from Practice settings, then start a Solo record, to post here.'
                    : 'No TeleOp scores yet. Runs set from now on are split by period and appear here.'
                : `Players appear here after ${minGames} ranked matches.`}
          </div>
        )}
        {/* the table also stands for an EMPTY board when you have a place on it (a ranked ladder nobody has
            placed on yet, with your placement progress): the foot row alone, under the empty state */}
        {(status === 'ok' || refetching) && (rows.length > 0 || foot) && (
          <table ref={tableRef} className={`ds-table rb-table${score ? ' rec' : ' elo'}`} aria-busy={refetching}>
            <thead>
              <tr>
                <th className="rk">#</th>
                <th>{score ? 'Driver' : 'Player'}</th>
                {!score && <th className="num rb-games">Games</th>}
                <th className="sc">{score ? 'Score' : 'Rating'}</th>
                {score && (
                  <th className="rb-play">
                    <span className="ds-sr">Replay</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const rec = r as RecordRow;
                // a duo board lists PAIRS, so one person can be on it twice (A+B, A+C)
                const rowKey = score && rec.partnerId ? `${r.userId}+${rec.partnerId}` : r.userId;
                const isOpen = score && openRow === rowKey;
                const mine = isMine(r);
                const toggle = (): void => setOpenRow(isOpen ? null : rowKey);
                return (
                  <Fragment key={rowKey}>
                    <tr
                      className={`${score ? 'ds-clickable rb-row' : ''}${mine ? ' lb-you' : ''}`}
                      tabIndex={score ? 0 : undefined}
                      aria-expanded={score ? isOpen : undefined}
                      onClick={score ? toggle : undefined}
                      onKeyDown={
                        score
                          ? (e) => {
                              if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
                              e.preventDefault();
                              toggle();
                            }
                          : undefined
                      }
                    >
                      {/* the server's rank, which a tie shares; the row number from an older server */}
                      <td className="rk">{(score && rec.rank) || i + 1}</td>
                      <td className="rb-who">
                        <span className="lb-drivers">
                          <DriverName handle={r.handle} username={r.username} supporter={r.supporter} role={r.role} badges={r.badges} onOpenProfile={onOpenProfile} />
                          {score && rec.partnerId && (
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
                            </>
                          )}
                        </span>
                      </td>
                      {!score && <td className="num rb-games">{(r as EloRow).games}</td>}
                      <td className="sc">{score ? rec.score : (r as EloRow).rating}</td>
                      {score && (
                        <td className="rb-play">
                          {/* the button is the keyboard and pointer path to the replay; it stops the
                              click so it does not also open the row */}
                          {rec.replayId && onWatch && (
                            <button
                              className="ds-btn small ghost rb-watch"
                              aria-label={`Watch the replay, score ${rec.score}`}
                              title="Watch replay"
                              onClick={(e) => {
                                e.stopPropagation();
                                onWatch(rec.replayId!);
                              }}
                            >
                              <span aria-hidden="true">▶</span>
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                    {isOpen && (
                      <tr className="lb-detail">
                        <td colSpan={cols}>
                          <p className="rb-detail-meta">Set {fmtDay(rec.createdAt)}</p>
                          {rec.config ? (
                            <ConfigSummary
                              cfg={rec.config}
                              game={moduleFor(game).id}
                              driver={nameOf(r.handle, r.username)}
                              partner={rec.partnerId ? nameOf(rec.partnerHandle, rec.partnerUsername) : null}
                            />
                          ) : (
                            <p className="rb-detail-meta">This run kept no robot.</p>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
            {foot && (
              <tfoot>
                <tr className="rb-foot lb-you">
                  <td className="rk">{foot.rank ?? '–'}</td>
                  <td className="rb-who">
                    {foot.toPlace != null ? (
                      <>
                        You · <b>{foot.toPlace}</b> {foot.toPlace === 1 ? 'match' : 'matches'} until placement
                      </>
                    ) : (
                      'You'
                    )}
                  </td>
                  {!score && <td className="num rb-games">{me?.games ?? ''}</td>}
                  <td className="sc">{foot.value ?? '–'}</td>
                  {score && <td className="rb-play" />}
                </tr>
              </tfoot>
            )}
          </table>
        )}
      </div>
      <LatestRecords game={game} onOpenProfile={onOpenProfile} onWatch={onWatch} />
    </div>
  );
}
