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
  // bumped on every mesh link event so per-peer connection status re-renders
  const [, setLinkVer] = useState(0);

  const lobbyRef = useRef<SupabaseLobby | null>(null);
  const meshRef = useRef<RtcMesh | null>(null);
  const startedRef = useRef(false);
  /** last meshReady value we published, so we only re-track on a real change */
  const reportedRef = useRef<boolean | null>(null);

  // tear down on unmount unless a match started (which hands ownership onward).
  // Also leave on pagehide so a tab refresh/close drops our presence instead of
  // leaving a ghost that pollutes the room + the mesh.
  useEffect(() => {
    const onHide = (): void => {
      if (!startedRef.current) void lobbyRef.current?.leave();
    };
    window.addEventListener('pagehide', onHide);
    // heartbeat: every client re-broadcasts its presence periodically, so anyone
    // whose roster drifted out of sync reconverges within one interval (Supabase
    // presence can silently miss an update; this keeps everyone honest)
    const heartbeat = setInterval(() => void lobbyRef.current?.resync(), 3000);
    return () => {
      window.removeEventListener('pagehide', onHide);
      clearInterval(heartbeat);
      if (!startedRef.current) {
        meshRef.current?.close();
        void lobbyRef.current?.leave();
      }
    };
  }, []);

  // Esc leaves the lobby (⇒ unmount ⇒ leave() untracks + announces our exit)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const myPeerId = lobbyRef.current?.peerId;
  const me = players.find((p) => p.peerId === myPeerId) ?? null;
  const isHost = lobbyRef.current?.isHost() ?? false;
  const hostId = lobbyRef.current?.hostId() ?? null;
  const allReady = players.length > 0 && players.every((p) => p.ready);
  const linkOf = (id: string): 'open' | 'connecting' | 'failed' | 'none' =>
    id === myPeerId ? 'open' : (meshRef.current?.linkStatus(id) ?? 'none');
  const others = players.filter((p) => p.peerId !== myPeerId);
  // MY view: an OPEN DataChannel to every other in-room driver
  const allConnected = others.every((p) => linkOf(p.peerId) === 'open');
  const failedPeers = others.filter((p) => linkOf(p.peerId) === 'failed');
  // FULL-MESH gate: the match starts only when EVERY driver reports they see
  // everyone (each p.meshReady). If A↔B is up but B↔C isn't, B reports false, so
  // START stays locked — no one begins a match that would freeze at WAITING.
  const everyoneConnected = players.length > 0 && players.every((p) => p.meshReady);

  // publish OUR connectivity so the host can gate START on the full mesh (only
  // re-track when it actually flips, to avoid a presence-update storm)
  useEffect(() => {
    if (phase !== 'room') return;
    if (reportedRef.current === allConnected) return;
    reportedRef.current = allConnected;
    void lobbyRef.current?.updateSelf({ meshReady: allConnected });
  }, [allConnected, phase]);

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
      meshReady: false,
      spec: settings.spec,
      assists: settings.assists,
    });
    lobbyRef.current = lobby;
    const mesh = new RtcMesh(lobby, lobby.peerId);
    meshRef.current = mesh;
    const bump = (): void => setLinkVer((v) => v + 1);
    mesh.on('connect', () => {
      setConnected(mesh.connectedPeers());
      bump();
    });
    mesh.on('disconnect', () => {
      setConnected(mesh.connectedPeers());
      bump();
    });
    mesh.on('failed', bump); // a peer couldn't connect — re-render its status dot

    const leaveWith = (msg: string): void => {
      setError(msg);
      setPhase('error');
      mesh.close();
      void lobby.leave();
    };

    lobby.on('players', (list) => {
      // deterministic room membership: the first ROOM_CAPACITY by join time
      // (peerId tiebreak). Every client computes this SAME split from the same
      // presence snapshot, so once presence converges the rosters AGREE — and
      // never exceed the cap. (Rendering the raw uncapped list is what made
      // clients disagree on the count and show "more than 4".)
      const order = [...list].sort(
        (a, b) => a.joinedAt - b.joinedAt || (a.peerId < b.peerId ? -1 : 1),
      );
      const keep = order.slice(0, ROOM_CAPACITY);
      const excess = order.slice(ROOM_CAPACITY);
      // a later joiner over the cap bounces itself...
      if (excess.some((p) => p.peerId === lobby.peerId)) {
        leaveWith(`Room is full (max ${ROOM_CAPACITY} drivers).`);
        return;
      }
      // ...and the host kicks the excess as a backstop (deterministic order)
      if (lobby.isHost()) excess.forEach((p) => lobby.kick(p.peerId));
      setPlayers(keep); // show ONLY the in-room drivers — same set for everyone
      mesh.connect(keep.map((p) => p.peerId)); // only link the in-room drivers
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
    // build ONLY the in-room drivers — the SAME deterministic cap as the roster
    // — so a ghost/overflow presence never spawns a phantom robot that no one
    // drives (its missing commands would stall every peer's lockstep)
    const roster = [...lobby.getPlayers()]
      .sort((a, b) => a.joinedAt - b.joinedAt || (a.peerId < b.peerId ? -1 : 1))
      .slice(0, ROOM_CAPACITY);
    // honor each driver's chosen start position, but keep them DISTINCT within
    // an alliance (bump to the next free pose) so robots never spawn overlapping
    const used: Record<Alliance, Set<number>> = { red: new Set(), blue: new Set() };
    const setups: NetRobotSetup[] = [];
    const assign: Record<string, number> = {};
    roster.forEach((p, i) => {
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
  const refresh = (): void => void lobbyRef.current?.resync();

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
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h2>Drivers</h2>
            <button className="game-btn" onClick={refresh} title="Re-sync the roster if it looks out of date">
              ⟳ REFRESH
            </button>
          </div>
          <div className="lobby-players">
            {players.map((p) => {
              const isMe = p.peerId === lobbyRef.current?.peerId;
              const link = linkOf(p.peerId);
              return (
                <div key={p.peerId} className={`lobby-player ${p.alliance}`}>
                  <span
                    className="lobby-dot"
                    data-linked={link === 'open'}
                    title={isMe ? 'you' : `connection: ${link}`}
                  />
                  <span className="lobby-name">
                    {p.name}
                    {isMe ? ' (you)' : ''}
                  </span>
                  <span className="lobby-team">
                    {p.spec.name} · {p.teamNumber || '—'}
                  </span>
                  {p.peerId === hostId && <span className="chip on" title="Room host">★ HOST</span>}
                  <span className={`chip ${p.alliance}`}>{p.alliance.toUpperCase()}</span>
                  <span className="chip">{START_POSES[p.startIndex]?.label ?? '—'}</span>
                  {!isMe && link !== 'open' && (
                    <span className={`chip ${link === 'failed' ? 'off' : 'warn'}`}>
                      {link === 'failed' ? 'NO CONNECT' : 'CONNECTING…'}
                    </span>
                  )}
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
            <button
              className="start-btn"
              disabled={!allReady || !everyoneConnected}
              onClick={hostStart}
            >
              START MATCH ▶
            </button>
          )}
          <button className="game-btn" onClick={onCancel}>
            ◄ LEAVE
          </button>
        </div>
        {isHost && !allReady && <p className="hint">START unlocks once every driver is ready.</p>}
        {isHost && allReady && !everyoneConnected && (
          <p className="hint">
            {failedPeers.length > 0
              ? `⚠ Couldn't connect to ${failedPeers.map((p) => p.name).join(', ')} — check network/TURN, or kick to start without them.`
              : `Waiting for a full mesh — every driver must be linked to every other. Not yet connected: ${
                  players
                    .filter((p) => !p.meshReady)
                    .map((p) => p.name)
                    .join(', ') || '…'
                }`}
          </p>
        )}
      </div>
    </div>
  );
}
