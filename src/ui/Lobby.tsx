import { useEffect, useRef, useState } from 'react';
import type { GameSettings } from '../game';
import type { Alliance } from '../types';
import { START_POSES } from '../config';
import { gameServerUrl } from '../net/env';
import { WebSocketTransport } from '../net/transport';
import { LobbyClient, type MatchStart } from '../net/lobbyClient';
import { ServerSession } from '../net/serverSession';
import { ROOM_CAPACITY, type LobbyPlayer } from '../net/protocol';
import type { NetSession } from '../net/session';

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
    let transport: WebSocketTransport;
    try {
      transport = new WebSocketTransport(gameServerUrl());
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
      <div className="menu-root">
        <div className="menu-panel lobby-entry">
          <header className="menu-header">
            <h1>
              MULTI<span className="accent">PLAYER</span>
            </h1>
            <p className="subtitle">Up to 2v2 · share a room code with your drivers</p>
          </header>
          <section>
            <label className="field">
              <span>Your name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={20} />
            </label>
            <label className="field">
              <span>Room code</span>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="e.g. DECODE1"
                maxLength={12}
              />
            </label>
            {phase === 'error' && <p className="lobby-error">⚠ {error}</p>}
            <div className="lobby-actions">
              <button className="start-btn" disabled={phase === 'connecting'} onClick={join}>
                {phase === 'connecting' ? 'CONNECTING…' : 'CREATE / JOIN'}
              </button>
              <button className="game-btn" onClick={onCancel}>
                ◄ BACK
              </button>
            </div>
            <p className="hint">
              Anyone who enters the same code lands in the same room. First one in hosts.
            </p>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="menu-root">
      <div className="menu-panel">
        <header className="menu-header">
          <h1>
            ROOM <span className="accent">{code}</span>
          </h1>
          <p className="subtitle">
            {isHost ? 'You are the host' : 'Waiting for the host to start'} · {players.length}/
            {ROOM_CAPACITY} drivers
          </p>
        </header>

        <section>
          <h2>Drivers</h2>
          <div className="lobby-players">
            {players.map((p) => {
              const isMe = p.clientId === myId;
              return (
                <div key={p.clientId} className={`lobby-player ${p.alliance}`}>
                  <span className="lobby-dot" data-linked={true} title={isMe ? 'you' : 'connected'} />
                  <span className="lobby-name">
                    {p.name}
                    {isMe ? ' (you)' : ''}
                  </span>
                  <span className="lobby-team">
                    {p.spec.name} · {p.teamNumber || '—'}
                  </span>
                  {p.clientId === hostId && (
                    <span className="chip on" title="Room host">
                      ★ HOST
                    </span>
                  )}
                  <span className={`chip ${p.alliance}`}>{p.alliance.toUpperCase()}</span>
                  <span className="chip">{START_POSES[p.startIndex]?.label ?? '—'}</span>
                  <span className={`chip ${p.ready ? 'on' : 'off'}`}>
                    {p.ready ? 'READY' : 'NOT READY'}
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        <section>
          <h2>Your alliance</h2>
          <div className="card-row">
            <button
              className={`card ${me?.alliance === 'red' ? 'selected' : ''}`}
              onClick={() => setAlliance('red')}
            >
              RED
            </button>
            <button
              className={`card ${me?.alliance === 'blue' ? 'selected' : ''}`}
              onClick={() => setAlliance('blue')}
            >
              BLUE
            </button>
          </div>
        </section>

        <section>
          <h2>Start position</h2>
          <div className="card-row">
            {START_POSES.map((pose, i) => {
              const taken = players.some(
                (p) => p.clientId !== me?.clientId && p.alliance === me?.alliance && p.startIndex === i,
              );
              return (
                <button
                  key={i}
                  className={`card ${me?.startIndex === i ? 'selected' : ''}`}
                  disabled={taken}
                  onClick={() => setStartPos(i)}
                >
                  {pose.label}
                  {taken && <span className="card-note">taken</span>}
                </button>
              );
            })}
          </div>
        </section>

        <div className="lobby-actions">
          <button className={`start-btn ${me?.ready ? 'secondary' : ''}`} onClick={toggleReady}>
            {me?.ready ? '✓ READY — click to unready' : 'READY UP'}
          </button>
          {isHost && (
            <button
              className="start-btn"
              disabled={!allReady}
              onClick={() => lobbyRef.current?.start()}
            >
              START MATCH ▶
            </button>
          )}
          <button className="game-btn" onClick={onCancel}>
            ◄ LEAVE
          </button>
        </div>
        {isHost && !allReady && <p className="hint">START unlocks once every driver is ready.</p>}
      </div>
    </div>
  );
}
