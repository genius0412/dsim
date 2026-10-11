import { useEffect, useRef, useState } from 'react';
import type { GameId } from '../types';
import type { LobbyPlayer, RoomSettings } from '../net/protocol';
import { LobbyClient, type MatchStart } from '../net/lobbyClient';
import { WebSocketTransport } from '../net/transport';
import { gameServerUrlWith, selectedServer } from '../net/env';
import { roomJoinRegion } from '../net/roomRegion';
import { seasonFor } from '../seasons';
import { ConsoleHead } from './ConsoleHead';
import { useEscape } from './useEscape';

/** how long a connect may take before this screen says so; the transport itself retries quietly */
const SLOW_MS = 6000;

/**
 * WATCH A ROOM THAT HAS NOT STARTED (Browse rooms ▸ Watch).
 *
 * The server already lets a spectator attach to a LOBBY (`attachSpectator`: "a LOBBY may be watched"),
 * and sends it every `roster` the room broadcasts, then `matchStart` with `yourRobotId: -1` when the
 * host presses start. `spectateRoom` only ever listened for the last of those, so a click on a lobby
 * did nothing visible. This screen listens for both: it shows who is in the room and how full it is,
 * and hands the socket to a spectator `ServerSession` the moment the match begins (`onMatch`).
 *
 * "Ask to play" is not a message: it is the Join button, enabled only while a seat is free, which
 * leaves this screen and joins as a driver through the ordinary flow. A watcher holds no seat, and
 * nothing here can take one.
 *
 * The socket is closed on unmount unless it was handed to a session: the session TAKES OVER the same
 * transport, so closing it then would end the match the player came to watch.
 */
export function WatchLobby({
  code,
  region,
  game,
  onMatch,
  onJoin,
  onBack,
}: {
  code: string;
  region?: string;
  game: GameId;
  /** the match began: the transport and client to build a spectator session from, and the start frame */
  onMatch: (transport: WebSocketTransport, lobby: LobbyClient, start: MatchStart) => void;
  /** join this room as a driver (only offered while a seat is free) */
  onJoin: () => void;
  onBack: () => void;
}) {
  const [players, setPlayers] = useState<LobbyPlayer[] | null>(null);
  const [settings, setSettings] = useState<RoomSettings | undefined>();
  const [error, setError] = useState('');
  const [slow, setSlow] = useState(false);
  const handedOver = useRef(false);
  const onMatchRef = useRef(onMatch);
  onMatchRef.current = onMatch;
  useEscape(onBack);

  useEffect(() => {
    let transport: WebSocketTransport;
    try {
      const r = roomJoinRegion(region, selectedServer()?.region ?? '');
      transport = new WebSocketTransport(gameServerUrlWith(r ? { room: code, region: r } : { room: code }));
    } catch {
      setError('Couldn’t reach the game server.');
      return;
    }
    const lobby = new LobbyClient(transport);
    lobby.on('roster', (p, _host, s) => {
      setPlayers(p);
      setSettings(s);
      setError('');
    });
    lobby.on('matchStart', (m) => {
      handedOver.current = true;
      onMatchRef.current(transport, lobby, m);
    });
    // `error` is the server's own plain sentence ("That match is no longer live."): the room closed
    // between the list and the click, which is expected and not a fault
    lobby.on('error', (message) => setError(message));
    lobby.spectate(code);
    const slowTimer = window.setTimeout(() => setSlow(true), SLOW_MS);
    return () => {
      window.clearTimeout(slowTimer);
      if (!handedOver.current) transport.close();
    };
  }, [code, region]);

  const capacity = settings ? settings.perAlliance.red + settings.perAlliance.blue : 0;
  const seats = players?.length ?? 0;
  const open = capacity > 0 && seats < capacity;
  const side = (a: 'red' | 'blue'): LobbyPlayer[] => (players ?? []).filter((p) => p.alliance === a);

  return (
    <div className="ds-console">
      <div className="ds-console-in narrow">
        <ConsoleHead
          onBack={onBack}
          title="Watching a room"
          sub={`${seasonFor(game).name} · waiting for the host to start`}
          reserveSub
        />
        <div className="ds-panel ds-panel-body stack">
          {error ? (
            <>
              <p className="ds-form-err">⚠ {error}</p>
              <div className="ds-actions">
                <button className="ds-cta secondary" onClick={onBack}>
                  Back to rooms
                </button>
              </div>
            </>
          ) : players === null ? (
            <p className="ds-loading">{slow ? 'Still connecting…' : 'Connecting…'}</p>
          ) : (
            <>
              <div className="ds-opts two">
                {(['red', 'blue'] as const).map((a) => (
                  <div key={a} className={`ds-watchside ${a}`}>
                    <h2 className="ds-panel-title">{a === 'red' ? 'RED' : 'BLUE'}</h2>
                    {side(a).length === 0 ? (
                      <p className="ds-hint">Open</p>
                    ) : (
                      side(a).map((p) => (
                        <p key={p.clientId} className="ds-watchrow">
                          <b>{p.name}</b>
                          <span className="ds-hint">{p.ready ? 'Ready' : ''}</span>
                        </p>
                      ))
                    )}
                  </div>
                ))}
              </div>
              <p className="ds-hint">
                {capacity > 0 ? `${seats}/${capacity} seats taken. ` : ''}The match opens here by itself when the
                host starts.
              </p>
              <div className="ds-actions">
                {/* a watcher holds no seat; this joins as a driver through the usual flow, and only
                    while there is a seat to take (the server decides, this just does not offer it) */}
                <button className="ds-cta" disabled={!open} onClick={onJoin}>
                  {open ? 'Join this room' : 'Room is full'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
