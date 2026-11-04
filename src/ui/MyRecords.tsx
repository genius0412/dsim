import { useCallback, useEffect, useState } from 'react';
import type { GameId } from '../types';
import type { Replay } from '../sim/replay';
import { fetchSeasons, fetchUserMatches, fetchUserStats, type MatchHistoryOpts, type SeasonInfo, type UserStats } from '../net/api';
import { gameServerConfigured } from '../net/env';
import { authEnabled, authClient } from '../lib/authClient';
import { periodLabel } from '../seasons';
import { RANKED_PLACEMENT } from '../config';
import { AuthPanel } from './AuthPanel';
import { MatchHistory, type TypeFilter } from './MatchHistory';
import { PracticeReplays } from './PracticeReplays';
import { LanReplays } from './LanReplays';
import { useLanEnabled } from './useLanEnabled';
import type { BoardKey } from './recordsQuery';

/** what the history list can show: the server's four kinds, and the two lists this device keeps */
type HistoryType = TypeFilter | 'practice' | 'lan';
const HISTORY_TYPES: { id: HistoryType; label: string; lan?: true }[] = [
  { id: 'all', label: 'All' },
  { id: 'solo', label: 'Solo runs' },
  { id: 'duo', label: 'Duo runs' },
  { id: 'ranked', label: 'Ranked' },
  { id: 'custom', label: 'Custom' },
  { id: 'practice', label: 'Practice' },
  { id: 'lan', label: 'LAN', lan: true },
];

export interface MyRecordsNav {
  game?: GameId;
  onWatch?: (replayId: string) => void;
  /** watch a replay only this DEVICE holds (a practice run, a hosted LAN match) */
  onWatchLocal?: (replay: Replay) => void;
  onOpenProfile?: (username: string) => void;
  /** a tile: that board on Leaderboards, at your row */
  onBoard: (board: BoardKey) => void;
  /** Account, at the standing and messages that used to sit on this page */
  onStanding: () => void;
}

/**
 * MY RECORDS (`/records/career`, `docs/records-redesign.md`). Two things: where you stand (four tiles,
 * each one a door to that board at your row) and what you played (one list, by type). It was nine
 * panels; the rest went where they are about:
 *
 *  - account standing, Messages and Your reports → Account (`Standing and messages` here is one click
 *    to them, and the notice pop-up already announces a new one);
 *  - the Practice replays panel → a type of this list, and so are LAN matches when you have hosted;
 *  - games played, playtime → the public profile, where the account is described;
 *  - awards → Achievements;
 *  - your name chip and Share → the profile, which is where somebody else sees you;
 *  - the Result filter and the page-size select → nothing (20 a page; a loss is one click on a row).
 *
 * The public profile still renders `CareerView`, so nothing about how others see you changed.
 */
export function MyRecords(nav: MyRecordsNav) {
  if (!authEnabled) {
    return (
      <>
        <div className="ds-panel">
          <div className="ds-empty">
            <div className="big">Accounts are off in this build</div>
            This build has no sign-in, so your rating, records and match history aren’t saved. Solo practice and free drive still work.
          </div>
        </div>
        <PracticeReplays signedIn={false} game={nav.game} onWatchLocal={nav.onWatchLocal} />
        <LanReplays signedIn={false} game={nav.game} onWatchLocal={nav.onWatchLocal} />
      </>
    );
  }
  return <MyRecordsSignedIn nav={nav} />;
}

function MyRecordsSignedIn({ nav }: { nav: MyRecordsNav }) {
  const session = authClient!.useSession();
  const user = session.data?.user;
  const userId = user?.id;
  const configured = gameServerConfigured();
  const [authOpen, setAuthOpen] = useState(false);

  if (session.isPending) {
    return (
      <div className="ds-panel">
        <div className="ds-loading">Loading…</div>
      </div>
    );
  }

  /* SIGNED OUT STILL HAS PRACTICE REPLAYS: Solo practice keeps its runs on the device whether or not
     anyone is signed in, and a page that showed only a sign-in prompt would hold runs nobody could open. */
  if (!user || !userId) {
    return (
      <>
        <div className="ds-panel">
          <div className="ds-empty">
            <div className="big">Sign in to see your records</div>
            Track your bests, ratings and match history.
          </div>
          <div className="ds-panel-body row">
            <span className="ds-head-spacer" />
            <button className="ds-btn primary" onClick={() => setAuthOpen(true)}>
              Sign in
            </button>
          </div>
          {authOpen && <AuthPanel onClose={() => setAuthOpen(false)} />}
        </div>
        <PracticeReplays signedIn={false} game={nav.game} onWatchLocal={nav.onWatchLocal} />
        <LanReplays signedIn={false} game={nav.game} onWatchLocal={nav.onWatchLocal} />
      </>
    );
  }

  if (!configured) {
    return (
      <>
        <div className="ds-panel">
          <div className="ds-empty">
            <div className="big">Records are online-only</div>
            This build isn’t connected to a game server. Solo practice and free drive still work.
          </div>
        </div>
        <PracticeReplays signedIn={false} game={nav.game} onWatchLocal={nav.onWatchLocal} />
        <LanReplays signedIn={false} game={nav.game} onWatchLocal={nav.onWatchLocal} />
      </>
    );
  }

  return <MyRecordsBody nav={nav} userId={userId} />;
}

function MyRecordsBody({ nav, userId }: { nav: MyRecordsNav; userId: string }) {
  const game = nav.game;
  const lanOn = useLanEnabled();
  const [seasons, setSeasons] = useState<SeasonInfo[]>([]);
  const [current, setCurrent] = useState<number | null>(null);
  const [season, setSeason] = useState<number | null>(null); // null = the live period
  // a period belongs to ONE game: switching game drops the selection before anything fetches with it
  const [periodGame, setPeriodGame] = useState(game);
  if (periodGame !== game) {
    setPeriodGame(game);
    setSeason(null);
    setSeasons([]);
    setCurrent(null);
  }
  const [stats, setStats] = useState<UserStats | null>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  const [type, setType] = useState<HistoryType>('all');

  useEffect(() => {
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
  }, [game]);

  useEffect(() => {
    let alive = true;
    setStatus('loading');
    fetchUserStats(userId, season ?? undefined, game)
      .then((s) => {
        if (!alive) return;
        setStats(s);
        setStatus('ok');
      })
      .catch((e: unknown) => {
        if (!alive) return;
        console.warn('[my records] stats failed', e);
        setStatus('error');
      });
    return () => {
      alive = false;
    };
  }, [userId, season, game]);

  const fetchPage = useCallback((opts: MatchHistoryOpts) => fetchUserMatches(userId, { ...opts, game }), [userId, game]);

  const viewing = season ?? current;
  const info = seasons.find((s) => s.season === viewing);
  const archived = viewing != null && current != null && viewing < current;

  const solo = stats?.records.find((r) => r.mode === 'solo');
  const duo = stats?.records.find((r) => r.mode === 'duo');
  const elo1 = stats?.elo.find((e) => e.mode === '1v1');
  const elo2 = stats?.elo.find((e) => e.mode === '2v2');
  const best = (r: typeof solo): [string, string] =>
    !r || r.best == null ? ['—', 'No run yet'] : [String(r.best), r.rank ? `No.${r.rank}` : 'Unranked'];
  const rating = (e: typeof elo1, mode: '1v1' | '2v2'): [string, string] =>
    !e || e.games === 0
      ? ['—', 'No matches yet']
      : e.rank != null
        ? [String(e.rating), `No.${e.rank} · ${e.games} games`]
        : e.games < RANKED_PLACEMENT[mode]
          ? [String(e.rating), `Placing · ${e.games} of ${RANKED_PLACEMENT[mode]}`]
          : [String(e.rating), `Unranked · ${e.games} games`];
  const tiles: { board: BoardKey; label: string; v: [string, string] }[] = [
    { board: 'solo', label: 'Solo best', v: best(solo) },
    { board: 'duo', label: 'Duo best', v: best(duo) },
    { board: '1v1', label: '1v1 rating', v: rating(elo1, '1v1') },
    { board: '2v2', label: '2v2 rating', v: rating(elo2, '2v2') },
  ];

  /* ONE HEADER for whichever list the type picks, so switching to Practice swaps the rows and nothing
     around them */
  const head = (
    <>
      <h2 className="ds-panel-title">History</h2>
      <select className="ds-select" aria-label="Show" value={type} onChange={(e) => setType(e.target.value as HistoryType)}>
        {HISTORY_TYPES.filter((t) => !t.lan || lanOn).map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
      <span className="ds-head-spacer" />
      {stats && stats.match.played > 0 && (
        <span className="rb-wl">
          Ranked <b>{stats.match.wins}–{stats.match.losses}</b>
        </span>
      )}
    </>
  );

  return (
    <>
      <div className="ds-panel">
        <div className="ds-panel-h">
          {/* the period is the select's to name; the title says what the tiles are */}
          <h2 className="ds-panel-title">Standings</h2>
          {archived && <span className="ds-badge">Final</span>}
          <span className="ds-head-spacer" />
          {seasons.length > 1 && (
            <select
              className="ds-select"
              aria-label="Period"
              value={viewing ?? ''}
              onChange={(e) => {
                const n = Number(e.target.value);
                setSeason(current != null && n === current ? null : n);
              }}
            >
              {seasons.map((x) => (
                <option key={x.season} value={x.season}>
                  {periodLabel(x)}
                </option>
              ))}
            </select>
          )}
          <button className="ds-btn small ghost" onClick={nav.onStanding}>
            Standing and messages
          </button>
        </div>
        {status === 'error' ? (
          <div className="ds-empty">
            <div className="big">Couldn’t load your records</div>
            Check your connection and reload the page.
          </div>
        ) : (
          <div className="ds-panel-body">
            {/* each tile is a door: that board, opened at your row. Dashes while loading, so the panel
                is the same height before and after the numbers land. */}
            <div className="rb-tiles">
              {tiles.map((t) => (
                <button key={t.board} className="rb-tile" onClick={() => nav.onBoard(t.board)} aria-label={`${t.label}: ${t.v[0]}, ${t.v[1]}. Open the ${t.board} board`}>
                  <span className="sv">{status === 'ok' ? t.v[0] : '—'}</span>
                  <span className="sl">{t.label}</span>
                  <span className="sl sub">{status === 'ok' ? t.v[1] : ' '}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {type === 'practice' ? (
        <PracticeReplays signedIn game={game} onWatchId={nav.onWatch} onWatchLocal={nav.onWatchLocal} head={head} />
      ) : type === 'lan' ? (
        <LanReplays signedIn game={game} onWatchId={nav.onWatch} onWatchLocal={nav.onWatchLocal} head={head} />
      ) : (
        <MatchHistory
          fetchPage={fetchPage}
          season={season}
          seasonLabel={info ? periodLabel(info) : 'this period'}
          onWatch={nav.onWatch}
          onOpenProfile={nav.onOpenProfile}
          head={head}
          type={type}
          slim
        />
      )}
    </>
  );
}
