import { useEffect, useState, type ReactNode } from 'react';
import type { GameId } from '../types';
import type { RecentRecord } from '../net/protocol';
import { fetchRecentRecords } from '../net/api';
import { gameServerConfigured } from '../net/env';
import { MOCK_FEED, mockFeedOn } from './recordsFeedMock';
import { LATEST_ROWS, feedAgo } from './recordsFeed';
import { onUserActive, userIdle } from './userActivity';
import { useMediaQuery } from './useMediaQuery';

/** wide enough for the board and a column beside it; below, the list is a closed disclosure under the board */
const WIDE = '(min-width: 1200px)';

/**
 * LATEST RECORDS (`GET /api/records/recent?window=season`): the season's new No.1s and top-3 scores,
 * newest first, beside the board from 1200px and in a closed disclosure under it below that. It was
 * the Records hub's main panel, with a Today / This week / This month / This season picker; the hub
 * and the picker are gone (`docs/records-redesign.md`), so it reads the season and shows the latest.
 *
 * Slow-moving by nature (a record is a rare event), so it reads on mount and when the game changes,
 * and again when somebody comes back to an idle tab: no timer, for the reason `RoomBrowser` documents
 * (a poll left open keeps an auto-stopping machine awake). `?mock=1` on a DEV build fills it from
 * `recordsFeedMock.ts`.
 */
export function LatestRecords({
  game,
  onOpenProfile,
  onWatch,
}: {
  game: GameId;
  onOpenProfile?: (username: string) => void;
  onWatch?: (replayId: string) => void;
}) {
  const wide = useMediaQuery(WIDE);
  const [rows, setRows] = useState<RecentRecord[] | null>(null);
  const [error, setError] = useState(false);
  const [now, setNow] = useState(() => Date.now());
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
    setRows(null);
    const load = (): void => {
      if (userIdle()) return;
      fetchRecentRecords('season', game)
        .then((r) => {
          if (!alive) return;
          setRows(r.rows);
          setNow(Date.now());
          setError(false);
        })
        .catch((e: unknown) => {
          if (!alive) return;
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
  }, [configured, mock, game]);

  // a build with no server has no records to list, and a column saying so says nothing the board does not
  if (!configured) return null;

  const body: ReactNode = error ? (
    <div className="ds-empty">
      <div className="big">Couldn’t load the latest records</div>
      Check your connection, then reopen this page.
    </div>
  ) : rows === null ? (
    <div className="ds-loading">Loading…</div>
  ) : rows.length === 0 ? (
    <div className="ds-empty">
      <div className="big">No new records this season</div>
      A run shows up here when it takes a top-three place.
    </div>
  ) : (
    <ul className="rb-latest-list">
      {rows.slice(0, LATEST_ROWS).map((r) => (
        <li key={`${r.userId}:${r.mode}:${r.createdAt}`} className="rb-latest-row">
          <span className={`rf-rank r${r.rank}`}>No.{r.rank}</span>
          <span className="rb-latest-what">
            {r.mode === 'duo' ? 'Duo' : 'Solo'} · <b>{r.score}</b>
          </span>
          <span className="rf-when">{feedAgo(r.createdAt, now)}</span>
          <span className="rb-latest-who">
            <button className="ds-linkbtn rf-name" onClick={() => onOpenProfile?.(r.username)}>
              {r.handle}
            </button>
            {r.partnerUsername && r.partnerHandle ? (
              <>
                {' & '}
                <button className="ds-linkbtn rf-name" onClick={() => onOpenProfile?.(r.partnerUsername as string)}>
                  {r.partnerHandle}
                </button>
              </>
            ) : null}
          </span>
          {r.replayId && onWatch ? (
            <button
              className="ds-btn small ghost rb-watch"
              aria-label={`Watch ${r.handle}’s ${r.score}`}
              title="Watch replay"
              onClick={() => onWatch(r.replayId as string)}
            >
              <span aria-hidden="true">▶</span>
            </button>
          ) : (
            <span className="rb-watch-none" aria-hidden="true" />
          )}
        </li>
      ))}
    </ul>
  );

  return wide ? (
    <aside className="ds-panel rb-latest" aria-label="Latest records">
      <div className="ds-panel-h">
        <h2 className="ds-panel-title">Latest records</h2>
      </div>
      {body}
    </aside>
  ) : (
    <details className="ds-panel rb-latest">
      <summary className="ds-panel-h">
        <h2 className="ds-panel-title">Latest records</h2>
      </summary>
      {body}
    </details>
  );
}
