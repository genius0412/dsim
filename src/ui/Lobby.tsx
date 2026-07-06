import { useEffect, useRef, useState } from 'react';
import type { GameSettings } from '../game';
import type { Alliance } from '../types';
import { SupabaseLobby, type LobbyPlayer, type StartMsg } from '../net/lobby';
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

  // tear down on unmount unless a match started (which hands ownership onward)
  useEffect(() => {
    return () => {
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

    lobby.on('players', (list) => {
      setPlayers(list);
      mesh.connect(list.map((p) => p.peerId)); // open links to everyone present
    });
    lobby.on('start', (msg) => handleStart(msg));

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
    const perAlliance: Record<Alliance, number> = { red: 0, blue: 0 };
    const setups: NetRobotSetup[] = [];
    const assign: Record<string, number> = {};
    lobby.getPlayers().forEach((p, i) => {
      setups.push({
        id: i,
        alliance: p.alliance,
        spec: p.spec,
        assists: p.assists,
        startIndex: perAlliance[p.alliance]++, // 0,1 per alliance → distinct poses
      });
      assign[p.peerId] = i;
    });
    const seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
    const msg: StartMsg = { seed, setups, assign };
    lobby.startMatch(msg);
    handleStart(msg); // broadcasts don't echo to self
  }

  const setAlliance = (alliance: Alliance): void =>
    void lobbyRef.current?.updateSelf({ alliance });
  const toggleReady = (): void =>
    void lobbyRef.current?.updateSelf({ ready: !me?.ready });

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
            {connected.length + 1}/{players.length} peers linked
          </p>
        </header>

        <section>
          <h2>Drivers</h2>
          <div className="lobby-players">
            {players.map((p) => (
              <div key={p.peerId} className={`lobby-player ${p.alliance}`}>
                <span className="lobby-dot" data-linked={p.peerId === lobbyRef.current?.peerId || connected.includes(p.peerId)} />
                <span className="lobby-name">
                  {p.name}
                  {p.peerId === lobbyRef.current?.peerId ? ' (you)' : ''}
                </span>
                <span className="lobby-team">
                  {p.spec.name} · {p.teamNumber || '—'}
                </span>
                <span className={`chip ${p.alliance}`}>{p.alliance.toUpperCase()}</span>
                <span className={`chip ${p.ready ? 'on' : 'off'}`}>{p.ready ? 'READY' : 'NOT READY'}</span>
              </div>
            ))}
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
