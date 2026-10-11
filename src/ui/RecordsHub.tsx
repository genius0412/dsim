import { useEffect, useState } from 'react';
import type { GameId } from '../types';
import type { RecentRecord } from '../net/protocol';
import { fetchRecentRecords } from '../net/api';
import { MOCK_FEED, mockFeedOn } from './recordsFeedMock';
import { gameServerConfigured } from '../net/env';
import { FEED_WINDOWS, feedAgo, feedVerb, type FeedWindow } from './recordsFeed';
import { RECORDS_PAGES, type RecordsPageKey } from './recordsPages';
import { UserSearchBar } from './UserSearchBar';
import { onUserActive, userIdle } from './userActivity';

/**
 * THE RECORDS HUB (`/records`): where Records opens. Not a board for one category, but a way in:
 * a player search, a link to every page of Records (`RECORDS_PAGES`), and a feed of the new No.1s
 * and top-3 scores of the season, over a time frame you pick.
 *
 * The feed is `GET /api/records/recent`. It is slow-moving by nature (a record is a rare event), so
 * it reads on mount and when the frame or the game changes, and again when somebody comes back to
 * an idle tab: no timer, for the reason `RoomBrowser` documents (a poll left open keeps an
 * auto-stopping machine awake).
 */
export function RecordsHub({
  game,
  onPage,
  onOpenProfile,
  onWatch,
}: {
  game?: GameId;
  onPage: (page: RecordsPageKey) => void;
  onOpenProfile: (username: string) => void;
  onWatch: (replayId: string) => void;
}) {
  const [win, setWin] = useState<FeedWindow>('week');
  const [rows, setRows] = useState<RecentRecord[] | null>(null);
  const [error, setError] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // `?mock=1` on a DEV build only: realistic rows so the page can be reviewed with no server
  const mock = mockFeedOn();
  const configured = gameServerConfigured() || mock;

  useEffect(() => {
    if (!configured) return;
    if (mock) {
      setRows(MOCK_FEED);
      setNow(Date.now());
      return;
    }
    let alive = true;
    setRows(null); // a new frame or game is a new list: say loading rather than show the old one
    const load = (): void => {
      if (userIdle()) return;
      fetchRecentRecords(win, game)
        .then((r) => {
          if (!alive) return;
          setRows(r.rows);
          setNow(Date.now());
          setError(false);
        })
        .catch((e: unknown) => {
          if (!alive) return;
          // the raw reason goes to the console; the screen says what to do
          console.warn('[records] /api/records/recent failed', e);
          setError(true);
        });
    };
    load();
    const unwake = onUserActive(load);
    return () => {
      alive = false;
      unwake();
    };
  }, [configured, mock, win, game]);

  return (
    <>
      <h1 className="ds-h1">Records</h1>

      <UserSearchBar onOpenProfile={onOpenProfile} />

      {/* a link to every page, from the registry: adding a page adds its card here */}
      <nav className="ds-opts three ds-hub-pages" aria-label="Records pages">
        {RECORDS_PAGES.map((p) => (
          <button key={p.key} className="ds-opt" onClick={() => onPage(p.key)}>
            <span className="ot">{p.label}</span>
            <span className="od">{p.hint}</span>
          </button>
        ))}
      </nav>

      {/* ONE panel, four bodies: the container never appears and disappears, only its contents */}
      <div className="ds-panel">
        <div className="ds-panel-h">
          <h2 className="ds-panel-title">Recent records</h2>
          <div className="ds-segs" role="group" aria-label="Time frame">
            {FEED_WINDOWS.map((w) => (
              <button
                key={w.key}
                className={`ds-seg${win === w.key ? ' on' : ''}`}
                aria-pressed={win === w.key}
                onClick={() => setWin(w.key)}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>
        {!configured ? (
          <div className="ds-empty">
            <div className="big">The feed is unavailable</div>
            This build has no game server, and records are kept on it.
          </div>
        ) : error ? (
          <div className="ds-empty">
            <div className="big">Couldn’t load recent records</div>
            Check your connection, then pick a time frame again.
          </div>
        ) : rows === null ? (
          <div className="ds-loading">Loading recent records…</div>
        ) : rows.length === 0 ? (
          <div className="ds-empty">
            <div className="big">No new records in this time frame</div>
            A run shows up here when it takes a top-three place.
          </div>
        ) : (
          <ul className="ds-feed">
            {rows.map((r) => (
              <li key={`${r.userId}:${r.mode}:${r.createdAt}`} className="ds-feed-row">
                <span className={`rf-rank r${r.rank}`}>No.{r.rank}</span>
                <span className="rf-text">
                  <button className="ds-linkbtn rf-name" onClick={() => onOpenProfile(r.username)}>
                    {r.handle}
                  </button>
                  {r.partnerUsername && r.partnerHandle ? (
                    <>
                      {' & '}
                      <button className="ds-linkbtn rf-name" onClick={() => onOpenProfile(r.partnerUsername as string)}>
                        {r.partnerHandle}
                      </button>
                    </>
                  ) : null}{' '}
                  {feedVerb(r)}
                </span>
                <span className="rf-when">{feedAgo(r.createdAt, now)}</span>
                {r.replayId ? (
                  <button className="ds-btn small" onClick={() => onWatch(r.replayId as string)}>
                    Watch
                  </button>
                ) : (
                  <span className="rf-nowatch" aria-hidden="true" />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
