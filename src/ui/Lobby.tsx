import { useEffect, useRef, useState } from 'react';
import type { GameSettings } from '../game';
import type { Alliance } from '../types';
import { START_POSES } from '../config';
import { gameServerUrl, gameServerUrlWith, gameServers, multiServer, selectedServer } from '../net/env';
import { WebSocketTransport } from '../net/transport';
import { LobbyClient, type MatchStart } from '../net/lobbyClient';
import { ServerSession } from '../net/serverSession';
import { ROOM_CAPACITY, type LobbyPlayer } from '../net/protocol';
import type { NetSession } from '../net/session';
import { APP_NAME } from '../seasons';
import { Logo } from './Logo';

interface Props {
  settings: GameSettings;
  onStart: (session: NetSession) => void;
  onCancel: () => void;
}

type Phase = 'entry' | 'connecting' | 'room' | 'error';

/**
 * Multiplayer lobby over the authoritative game server (Phase 0): join a room by
 * code, pick alliance / start pose, ready up, and — when the host starts — the
 * server authors the match and everyone receives `matchStart`, at which point we
 * mint a ServerSession that TAKES OVER the same socket. No WebRTC mesh, no
 * presence: the server is the single source of truth for the roster and host, so
 * one client can never stall the others.
 */
export function Lobby({ settings, onStart, onCancel }: Props) {
  const [phase, setPhase] = useState<Phase>('entry');
  const [code, setCode] = useState('');
  // one-app multi-region: friends must meet on the SAME region for a cross-region
  // room to land them on the same machine. Defaults to the account's picked region.
  const [region, setRegion] = useState(selectedServer()?.region ?? '');
  const [name, setName] = useState(settings.spec.teamName || 'Player');
  const [players, setPlayers] = useState<LobbyPlayer[]>([]);
  const [hostId, setHostId] = useState('');
  const [myId, setMyId] = useState('');
  const [error, setError] = useState('');

  const lobbyRef = useRef<LobbyClient | null>(null);
  const startedRef = useRef(false);

  // tear down on unmount unless a match started (which hands the socket onward)
  useEffect(() => {
    return () => {
      if (!startedRef.current) lobbyRef.current?.dispose();
    };
  }, []);

  // Esc leaves the lobby
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const me = players.find((p) => p.clientId === myId) ?? null;
  const isHost = myId !== '' && myId === hostId;
  const allReady = players.length > 0 && players.every((p) => p.ready);

  function handleStart(m: MatchStart): void {
    const lobby = lobbyRef.current;
    if (!lobby) return;
    startedRef.current = true;
    // pass the identity + room so the session can reclaim its slot on a reconnect
    onStart(new ServerSession(lobby.transport, lobby.isHost(), m, lobby.clientId, code.trim()));
  }

  function join(): void {
    if (!code.trim()) return;
    if (!gameServerUrl()) {
      setError('multiplayer not configured');
      setPhase('error');
      return;
    }
    setPhase('connecting');
    // route both players to the same region so a shared code lands on one machine
    const url = multiServer() && region ? gameServerUrlWith({ region }) : gameServerUrl();
    let transport: WebSocketTransport;
    try {
      transport = new WebSocketTransport(url);
    } catch {
      setError('could not reach the game server');
      setPhase('error');
      return;
    }
    const lobby = new LobbyClient(transport);
    lobbyRef.current = lobby;

    lobby.on('roster', (list, host) => {
      setPlayers(list);
      setHostId(host);
      setMyId(lobby.clientId);
      setPhase((p) => (p === 'connecting' ? 'room' : p));
    });
    lobby.on('matchStart', handleStart);
    lobby.on('error', (msg) => {
      setError(msg);
      setPhase('error');
    });
    lobby.on('closed', () => {
      if (!startedRef.current) {
        setError('lost connection to the game server');
        setPhase('error');
      }
    });

    lobby.join(code.trim(), {
      name,
      teamName: settings.spec.teamName,
      teamNumber: settings.spec.teamNumber,
      alliance: settings.alliance,
      startIndex: settings.startIndex,
      ready: false,
      spec: settings.spec,
      assists: settings.assists,
    });
  }

  const setAlliance = (alliance: Alliance): void => lobbyRef.current?.update({ alliance });
  const setStartPos = (startIndex: number): void => lobbyRef.current?.update({ startIndex });
  const toggleReady = (): void => lobbyRef.current?.update({ ready: !me?.ready });

  if (phase === 'entry' || phase === 'connecting' || phase === 'error') {
    return (
      <div className="ds-console">
        <div className="ds-console-in" style={{ maxWidth: 520 }}>
          <div className="ds-head">
            <button className="ds-back" onClick={onCancel}>
              ← Back
            </button>
            <span className="ds-mark">
              <Logo size={24} />
              {APP_NAME}
            </span>
          </div>
          <div className="ds-title">
            <h1>
              Multi<span className="accent">player</span>
            </h1>
          </div>
          <p className="ds-sub" style={{ marginTop: -10 }}>
            Up to 2v2 · share a room code.
          </p>
          <div className="ds-panelbox">
            <label className="ds-field">
              <span className="cap">Your name</span>
              <input
                className="ds-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={20}
              />
            </label>
            <label className="ds-field">
              <span className="cap">Room code</span>
              <input
                className="ds-input"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="e.g. SCRIM1"
                maxLength={12}
              />
            </label>
            {multiServer() && (
              <label className="ds-field">
                <span className="cap">Region</span>
                <select
                  className="ds-input"
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                >
                  {gameServers().map((s) => (
                    <option key={s.id} value={s.region}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {phase === 'error' && <p className="ds-form-err">⚠ {error}</p>}
            <div className="ds-actions">
              <button className="ds-cta" disabled={phase === 'connecting'} onClick={join}>
                {phase === 'connecting' ? 'CONNECTING…' : 'CREATE / JOIN'}
              </button>
            </div>
            <p className="ds-hint">
              Same code = same room. First one in hosts.
              {multiServer() && ' Both players must pick the same region.'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ds-console">
      <div className="ds-console-in">
        <div className="ds-head">
          <button className="ds-back" onClick={onCancel}>
            ← Leave
          </button>
          <span className="ds-mark">
            <span className="glyph">D</span>
            {APP_NAME}
          </span>
        </div>
        <div className="ds-title">
          <h1>
            Room <span className="accent">{code}</span>
          </h1>
        </div>
        <p className="ds-sub" style={{ marginTop: -10 }}>
          {isHost ? 'You are the host' : 'Waiting for the host to start'} · {players.length}/
          {ROOM_CAPACITY} drivers
        </p>

        <section className="ds-sec">
          <h2>Drivers</h2>
          <div className="ds-players">
            {players.map((p) => {
              const isMe = p.clientId === myId;
              return (
                <div key={p.clientId} className={`ds-player ${p.alliance}`}>
                  <span className="pdot" title={isMe ? 'you' : 'connected'} />
                  <span className="pnm">
                    {p.name}
                    {isMe ? ' (you)' : ''}
                  </span>
                  <span className="ptm">
                    {p.spec.name} · {p.teamNumber || '—'}
                  </span>
                  {p.clientId === hostId && (
                    <span className="ds-chip on" title="Room host">
                      ★ HOST
                    </span>
                  )}
                  <span className={`ds-chip ${p.alliance}`}>{p.alliance.toUpperCase()}</span>
                  <span className="ds-chip">{START_POSES[p.startIndex]?.label ?? '—'}</span>
                  <span className={`ds-chip ${p.ready ? 'on' : 'off'}`}>
                    {p.ready ? 'READY' : 'NOT READY'}
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        <section className="ds-sec">
          <h2>Your alliance</h2>
          <div className="ds-opts two">
            <button
              className={`ds-opt red ${me?.alliance === 'red' ? 'on' : ''}`}
              onClick={() => setAlliance('red')}
            >
              <span className="ot">RED</span>
            </button>
            <button
              className={`ds-opt blue ${me?.alliance === 'blue' ? 'on' : ''}`}
              onClick={() => setAlliance('blue')}
            >
              <span className="ot">BLUE</span>
            </button>
          </div>
        </section>

        <section className="ds-sec">
          <h2>Start position</h2>
          <div className="ds-opts">
            {START_POSES.map((pose, i) => {
              const taken = players.some(
                (p) => p.clientId !== me?.clientId && p.alliance === me?.alliance && p.startIndex === i,
              );
              return (
                <button
                  key={i}
                  className={`ds-opt mini ${me?.startIndex === i ? 'on' : ''}`}
                  disabled={taken}
                  onClick={() => setStartPos(i)}
                >
                  <span className="ot">{pose.label}</span>
                  {taken && <span className="ds-note">taken</span>}
                </button>
              );
            })}
          </div>
        </section>

        <div className="ds-actions">
          <button className={`ds-cta ${me?.ready ? 'ghost' : ''}`} onClick={toggleReady}>
            {me?.ready ? '✓ READY' : 'READY UP'}
          </button>
          {isHost && (
            <button className="ds-cta" disabled={!allReady} onClick={() => lobbyRef.current?.start()}>
              START MATCH ▶
            </button>
          )}
        </div>
        {isHost && !allReady && <p className="ds-hint">START unlocks when everyone is ready.</p>}
      </div>
    </div>
  );
}
