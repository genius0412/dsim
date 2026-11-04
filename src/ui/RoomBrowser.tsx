import { useEffect, useState } from 'react';
import type { ListedRoom } from '../net/protocol';
import { fetchListedRooms } from '../net/api';
import { gameServerConfigured, gameServers, lanActive, multiServer, selectedServer } from '../net/env';
import { isValidRoomCode, normalizeRoomCode, ROOM_CODE_LENGTH } from '../net/roomCode';
import { seasonFor } from '../seasons';
import { onUserActive, userIdle } from './userActivity';
import { WatchLive } from './WatchLive';

/**
 * "Browse rooms" — the Public rooms hosted right now, in every region. A row joins that room the
 * same way typing its code does (`onJoin`); a Private room never appears here, and a room whose
 * host is not signed in is never Public in the first place (`Room.listing`).
 *
 * A row is ONE control and there is no Watch beside it: joining a room with no free seat, or one
 * already in its match, lands the player in it as a spectator (`Lobby`), so the row says which it
 * will be. This page is also the one place a code is typed to join a room, because the New room
 * dialog only creates one.
 *
 * Polls `GET /api/rooms` every few seconds. An unlisted room can take about that long to leave the
 * list, and a code that was already seen stays valid, which the page says rather than implies.
 */
export function RoomBrowser({
  onJoin,
  onJoinCode,
  onHost,
  onWatchLive,
  signedIn,
}: {
  /** join a listed room: its code, its season and the region that hosts it */
  onJoin: (room: string, game: ListedRoom['game'], region?: string) => void;
  /** join a room by a typed code, on the region the player picked (absent on a one-server build) */
  onJoinCode: (room: string, region?: string) => void;
  /** open the create dialog for a new room that is Private (false) or Public (true) */
  onHost: (listed: boolean) => void;
  /** spectate a live match or a room by code (the former Watch live screen) */
  onWatchLive: (roomCode: string, region?: string) => void;
  /** a Public room needs an account: the server lists a room only while its host is signed in */
  signedIn: boolean;
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

  /** what the row does when pressed: take a seat, or watch from outside the room's seats */
  const goLabel = (r: ListedRoom): string => (r.state !== 'match' && r.joinable ? 'Join →' : 'Spectate →');
  const stateNote = (r: ListedRoom): string => (r.state === 'match' ? ' · In a match' : r.joinable ? '' : ' · Full');

  return (
    <>
      <h1 className="ds-h1">Browse rooms</h1>
      {/* ONE panel, four bodies: the container never appears and disappears, only its contents */}
      <div className="ds-panel">
        <div className="ds-panel-h">
          <h2 className="ds-panel-title">Public rooms</h2>
          <div className="ds-panel-acts">
            <button className="ds-btn small" onClick={() => onHost(false)}>
              Private room
            </button>
            <button
              className="ds-btn small"
              disabled={!signedIn}
              title={signedIn ? undefined : 'Sign in to host a public room'}
              onClick={() => onHost(true)}
            >
              Public room
            </button>
          </div>
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
              <button key={r.room} className="ds-lobby-row" onClick={() => onJoin(r.room, r.game, r.region)}>
                <span className="ll-code">{r.host}</span>
                <span className="ll-game">
                  {seasonFor(r.game).name}
                  {stateNote(r)}
                </span>
                <span className="ll-count">
                  {r.seats}/{r.capacity}
                </span>
                <span className="ll-go">{goLabel(r)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {configured && <JoinByCode onJoinCode={onJoinCode} />}
      <WatchLive onWatch={onWatchLive} />
      {configured && (
        <p className="ds-hint">
          A room that goes Private can take a few seconds to leave this list, and a code you have already seen
          still works.
        </p>
      )}
    </>
  );
}

/**
 * Join a room by the code its host shared: the only place one is typed. A custom room's code is
 * bare, so the region has to be the host's or the join lands on a machine with no such room and
 * opens an empty one under the same code (`roomJoinRegion`); a one-server build has nothing to pick.
 */
function JoinByCode({ onJoinCode }: { onJoinCode: (room: string, region?: string) => void }) {
  const [code, setCode] = useState('');
  const [region, setRegion] = useState(selectedServer()?.region ?? '');
  const picker = multiServer() && !lanActive();
  const ready = isValidRoomCode(code);
  const go = (): void => {
    if (ready) onJoinCode(code, picker ? region : undefined);
  };
  return (
    <div className="ds-panel">
      <div className="ds-panel-h">
        <h2 className="ds-panel-title">Join with a code</h2>
      </div>
      <div className="ds-panel-body stack">
        <div className="ds-watchcode">
          <input
            className="ds-input"
            value={code}
            onChange={(e) => setCode(normalizeRoomCode(e.target.value))}
            onKeyDown={(e) => e.key === 'Enter' && go()}
            placeholder={'X'.repeat(ROOM_CODE_LENGTH)}
            maxLength={ROOM_CODE_LENGTH}
            spellCheck={false}
            autoCapitalize="characters"
            aria-label="Room code"
          />
          <button className="ds-btn" disabled={!ready} onClick={go}>
            Join room
          </button>
        </div>
        {picker && (
          <>
            <label className="ds-field">
              <span className="cap">Region</span>
              <select className="ds-input" value={region} onChange={(e) => setRegion(e.target.value)}>
                {gameServers().map((s) => (
                  <option key={s.id} value={s.region}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="ds-hint">Pick the region the host chose.</p>
          </>
        )}
      </div>
    </div>
  );
}
