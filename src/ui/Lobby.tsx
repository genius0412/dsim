import { useEffect, useRef, useState } from 'react';
import type { GameSettings } from '../game';
import type { Alliance } from '../types';
import { START_POSES } from '../config';
import { SupabaseLobby, ROOM_CAPACITY, type LobbyPlayer, type StartMsg } from '../net/lobby';
import { RtcMesh } from '../net/mesh';
import { NetSession } from '../net/session';
import type { NetRobotSetup } from '../net/protocol';

interface Props {
  settings: GameSettings;
  onStart: (session: NetSession) => void;
  onCancel: () => void;
}

type Phase = 'entry' | 'connecting' | 'room' | 'error';

/**
 * Multiplayer lobby: join a room by code (Supabase Realtime), open a WebRTC
 * mesh to everyone present, ready-up, and — when the host hits START — mint a
 * NetSession that the App hands to the game. Empty slots simply spawn no robot.
 */
export function Lobby({ settings, onStart, onCancel }: Props) {
  const [phase, setPhase] = useState<Phase>('entry');
  const [code, setCode] = useState('');
  const [name, setName] = useState(settings.spec.teamName || 'Player');
  const [players, setPlayers] = useState<LobbyPlayer[]>([]);
  const [connected, setConnected] = useState<string[]>([]);
  const [error, setError] = useState('');

  const lobbyRef = useRef<SupabaseLobby | null>(null);
  const meshRef = useRef<RtcMesh | null>(null);
  const startedRef = useRef(false);

  // tear down on unmount unless a match started (which hands ownership onward).
  // Also leave on pagehide so a tab refresh/close drops our presence instead of
  // leaving a ghost that pollutes the room + the mesh.
  useEffect(() => {
    const onHide = (): void => {
      if (!startedRef.current) void lobbyRef.current?.leave();
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      if (!startedRef.current) {
        meshRef.current?.close();
        void lobbyRef.current?.leave();
      }
    };
  }, []);

  const me = players.find((p) => p.peerId === lobbyRef.current?.peerId) ?? null;
  const isHost = lobbyRef.current?.isHost() ?? false;
  const allReady = players.length > 0 && players.every((p) => p.ready);

  async function join(): Promise<void> {
    if (!code.trim()) return;
    setPhase('connecting');
    const lobby = new SupabaseLobby({
      name,
      teamName: settings.spec.teamName,
      teamNumber: settings.spec.teamNumber,
      alliance: settings.alliance,
      startIndex: settings.startIndex,
      ready: false,
      spec: settings.spec,
      assists: settings.assists,
    });
    lobbyRef.current = lobby;
    const mesh = new RtcMesh(lobby, lobby.peerId);
    meshRef.current = mesh;
    mesh.on('connect', () => setConnected(mesh.connectedPeers()));
    mesh.on('disconnect', () => setConnected(mesh.connectedPeers()));

    const leaveWith = (msg: string): void => {
      setError(msg);
      setPhase('error');
      mesh.close();
      void lobby.leave();
    };

    lobby.on('players', (list) => {
      setPlayers(list);
      // cap the room: the first ROOM_CAPACITY by join time keep their seats;
      // a later joiner over the cap bounces itself (deterministic on every client)
      const order = [...list].sort(
        (a, b) => a.joinedAt - b.joinedAt || (a.peerId < b.peerId ? -1 : 1),
      );
      if (order.findIndex((p) => p.peerId === lobby.peerId) >= ROOM_CAPACITY) {
        leaveWith(`Room is full (max ${ROOM_CAPACITY} drivers).`);
        return;
      }
      mesh.connect(list.map((p) => p.peerId)); // open links to everyone present
    });
    lobby.on('start', (msg) => handleStart(msg));
    lobby.on('kicked', () => leaveWith('You were removed from the room by the host.'));

    try {
      await lobby.join(code.trim());
      setPhase('room');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to join');
      setPhase('error');
    }
  }

  function handleStart(msg: StartMsg): void {
    const mesh = meshRef.current;
    const lobby = lobbyRef.current;
    if (!mesh || !lobby) return;
    startedRef.current = true;
    onStart(new NetSession(mesh, lobby, msg, lobby.peerId));
  }

  function hostStart(): void {
    const lobby = lobbyRef.current;
    if (!lobby) return;
    // honor each driver's chosen start position, but keep them DISTINCT within
    // an alliance (bump to the next free pose) so robots never spawn overlapping
    const used: Record<Alliance, Set<number>> = { red: new Set(), blue: new Set() };
    const setups: NetRobotSetup[] = [];
    const assign: Record<string, number> = {};
    lobby.getPlayers().forEach((p, i) => {
      let si = p.startIndex ?? 0;
      while (used[p.alliance].has(si)) si = (si + 1) % START_POSES.length;
      used[p.alliance].add(si);
      setups.push({ id: i, alliance: p.alliance, spec: p.spec, assists: p.assists, startIndex: si });
      assign[p.peerId] = i;
    });
    const seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
    const msg: StartMsg = { seed, setups, assign };
    lobby.startMatch(msg);
    handleStart(msg); // broadcasts don't echo to self
  }

  const setAlliance = (alliance: Alliance): void =>
    void lobbyRef.current?.updateSelf({ alliance });
  const setStartPos = (startIndex: number): void =>
    void lobbyRef.current?.updateSelf({ startIndex });
  const toggleReady = (): void =>
    void lobbyRef.current?.updateSelf({ ready: !me?.ready });
  const kick = (peerId: string): void => lobbyRef.current?.kick(peerId);

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
            {isHost ? 'You are the host' : 'Waiting for the host to start'} ·{' '}
            {players.length}/{ROOM_CAPACITY} drivers · {connected.length + 1} linked
          </p>
        </header>

        <section>
          <h2>Drivers</h2>
          <div className="lobby-players">
            {players.map((p) => {
              const isMe = p.peerId === lobbyRef.current?.peerId;
              return (
                <div key={p.peerId} className={`lobby-player ${p.alliance}`}>
                  <span className="lobby-dot" data-linked={isMe || connected.includes(p.peerId)} />
                  <span className="lobby-name">
                    {p.name}
                    {isMe ? ' (you)' : ''}
                  </span>
                  <span className="lobby-team">
                    {p.spec.name} · {p.teamNumber || '—'}
                  </span>
                  <span className={`chip ${p.alliance}`}>{p.alliance.toUpperCase()}</span>
                  <span className="chip">{START_POSES[p.startIndex]?.label ?? '—'}</span>
                  <span className={`chip ${p.ready ? 'on' : 'off'}`}>{p.ready ? 'READY' : 'NOT READY'}</span>
                  {isHost && !isMe && (
                    <button className="lobby-kick" title="Remove from room" onClick={() => kick(p.peerId)}>
                      ✕
                    </button>
                  )}
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
                (p) => p.peerId !== me?.peerId && p.alliance === me?.alliance && p.startIndex === i,
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
            <button className="start-btn" disabled={!allReady} onClick={hostStart}>
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
