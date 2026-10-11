import { useEffect, useState } from 'react';
import type { ListedRoom } from '../net/protocol';
import { fetchListedRooms } from '../net/api';
import { gameServerConfigured } from '../net/env';
import { seasonFor } from '../seasons';
import { onUserActive, userIdle } from './userActivity';

/**
 * "Browse rooms" — the Public rooms hosted right now, in every region. A row joins that room the
 * same way typing its code does (`onJoin`); a Private room never appears here, and a room whose
 * host is not signed in is never Public in the first place (`Room.listing`).
 *
 * Polls `GET /api/rooms` every few seconds. An unlisted room can take about that long to leave the
 * list, and a code that was already seen stays valid, which the page says rather than implies.
 */
export function RoomBrowser({
  onJoin,
  onWatch,
  onHost,
}: {
  /** join a listed room: its code, its season and the region that hosts it */
  onJoin: (room: string, game: ListedRoom['game'], region?: string) => void;
  /** watch a room without a seat: its lobby until the host starts, then the match */
  onWatch: (room: string, game: ListedRoom['game'], region?: string) => void;
  /** open the Public/Private choice for a new room */
  onHost: () => void;
}) {
  const [rooms, setRooms] = useState<ListedRoom[] | null>(null);
  const [error, setError] = useState(false);
  const configured = gameServerConfigured();

  useEffect(() => {
    if (!configured) return;
    let alive = true;
    const load = (): void => {
      // AN UNATTENDED PAGE DOES NOT POLL (userActivity.ts): a poll left open in a background tab
      // otherwise keeps the auto-stopping Fly machine awake for as long as the tab lives
      if (userIdle()) return;
      fetchListedRooms()
        .then((r) => {
          if (!alive) return;
          setRooms(r.rooms);
          setError(false);
        })
        .catch((e: unknown) => {
          if (!alive) return;
          // the raw reason goes to the console; the poll below is already the retry
          console.warn('[rooms] /api/rooms failed', e);
          setError(true);
        });
    };
    load();
    const t = window.setInterval(load, 4000);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') load();
    };
    document.addEventListener('visibilitychange', onVisible);
    const unwake = onUserActive(load);
    return () => {
      alive = false;
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
      unwake();
    };
  }, [configured]);

  const stateLabel = (r: ListedRoom): string =>
    r.state === 'match' ? 'In a match' : r.joinable ? 'Join →' : 'Full';

  return (
    <>
      <h1 className="ds-h1">Browse rooms</h1>
      {/* ONE panel, four bodies: the container never appears and disappears, only its contents */}
      <div className="ds-panel">
        <div className="ds-panel-h">
          <h2 className="ds-panel-title">Public rooms</h2>
          <button className="ds-btn small" onClick={onHost}>
            Host a room
          </button>
        </div>
        {!configured ? (
          <div className="ds-empty">
            <div className="big">Rooms are unavailable</div>
            This build has no game server, and rooms run on it.
          </div>
        ) : error ? (
          <div className="ds-empty">
            <div className="big">Couldn’t reach the game server</div>
            Trying again every few seconds.
          </div>
        ) : rooms === null ? (
          <div className="ds-loading">Loading rooms…</div>
        ) : rooms.length === 0 ? (
          <div className="ds-empty">
            <div className="big">No open rooms right now</div>
            Host one and it shows up here for anyone to join.
          </div>
        ) : (
          <div className="ds-panel-body ds-lobbies">
            {rooms.map((r) => (
              // a row is TWO controls side by side (a button cannot hold a button): the row joins as a
              // driver while a seat is free, and Watch is always there
              <div key={r.room} className="ds-lobby-line">
                <button
                  className="ds-lobby-row"
                  disabled={!r.joinable}
                  onClick={() => onJoin(r.room, r.game, r.region)}
                >
                  <span className="ll-code">{r.host}</span>
                  <span className="ll-game">{seasonFor(r.game).name}</span>
                  <span className="ll-count">
                    {r.seats}/{r.capacity}
                  </span>
                  <span className="ll-go">{stateLabel(r)}</span>
                </button>
                <button className="ds-btn" onClick={() => onWatch(r.room, r.game, r.region)}>
                  Watch
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      {configured && (
        <p className="ds-hint">
          A room that goes Private can take a few seconds to leave this list, and a code you have already seen
          still works.
        </p>
      )}
    </>
  );
}
