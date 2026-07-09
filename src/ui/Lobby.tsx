import { useEffect, useRef, useState } from 'react';
import type { GameSettings } from '../game';
import type { Alliance, GameSettings as GS } from '../types';
import { START_POSES } from '../config';
import { StartPositionEditor } from './StartPositionEditor';
import { selectStart, switchCategory, saveStart, deleteSavedStart } from './startPositions';
import { useRoleSwap, useDismissable } from './useRoleSwap';
import { RoleSwapBar } from './RoleSwapBar';
import { gameServerUrl, gameServerUrlWith, gameServers, multiServer, selectedServer } from '../net/env';
import { WebSocketTransport } from '../net/transport';
import { LobbyClient, type MatchStart } from '../net/lobbyClient';
import { ServerSession } from '../net/serverSession';
import { roomCapacity, type LobbyPlayer, type RoomConfig } from '../net/protocol';
import type { NetSession } from '../net/session';
import { useServerNotice } from '../net/notice';
import { generateRoomCode, normalizeRoomCode, isValidRoomCode, ROOM_CODE_LENGTH } from '../net/roomCode';
import { APP_NAME } from '../seasons';
import { Logo } from './Logo';

interface Props {
  settings: GameSettings;
  onSettingsChange: (s: GameSettings) => void;
  onStart: (session: NetSession) => void;
  onCancel: () => void;
  /** what this room runs. Default: a versus custom room (2v2). Pass a record/duo
   * config to run this same lobby as a 2v0 co-op record run (opponent-free). */
  config?: RoomConfig;
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
export function Lobby({ settings, onSettingsChange, onStart, onCancel, config = { kind: 'versus' } }: Props) {
  const isRecord = config.kind === 'record';
  const capacity = roomCapacity(config);
  const [phase, setPhase] = useState<Phase>('entry');
  const [code, setCode] = useState('');
  // entry sub-mode: pick whether you're creating a fresh room or joining a code
  const [entryMode, setEntryMode] = useState<'create' | 'join'>('create');
  const [copied, setCopied] = useState(false);
  // one-app multi-region: friends must meet on the SAME region for a cross-region
  // room to land them on the same machine. Defaults to the account's picked region.
  const [region, setRegion] = useState(selectedServer()?.region ?? '');
  const [name, setName] = useState(settings.spec.teamName || 'Player');
  const [players, setPlayers] = useState<LobbyPlayer[]>([]);
  const [hostId, setHostId] = useState('');
  const [myId, setMyId] = useState('');
  // block starting a custom match while a server restart is scheduled
  const notice = useServerNotice();
  const restartPending =
    !!notice && notice.kind === 'restart' && (notice.until === undefined || notice.until > Date.now());
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
  // a duo record run needs BOTH drivers present before it can start (it's 2v0);
  // versus custom rooms can start with fewer (1v1, etc.)
  const enoughPlayers = !isRecord || players.length >= capacity;
  const canStart = allReady && enoughPlayers && !restartPending;

  function handleStart(m: MatchStart): void {
    const lobby = lobbyRef.current;
    if (!lobby) return;
    startedRef.current = true;
    // pass the identity + room so the session can reclaim its slot on a reconnect
    onStart(new ServerSession(lobby.transport, lobby.isHost(), m, lobby.clientId, code.trim()));
  }

  /** create a brand-new room with a freshly generated code (you host it) */
  function createRoom(): void {
    join(generateRoomCode());
  }

  /** join an existing room by its shared code */
  function joinWithCode(): void {
    const c = normalizeRoomCode(code);
    if (!isValidRoomCode(c)) {
      setError(`Enter a valid ${ROOM_CODE_LENGTH}-character room code.`);
      setPhase('error');
      return;
    }
    join(c);
  }

  function join(roomCode: string): void {
    if (!roomCode) return;
    setCode(roomCode);
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

    lobby.join(
      roomCode,
      {
        name,
        teamName: settings.spec.teamName,
        teamNumber: settings.spec.teamNumber,
        // record runs are opponent-free (one alliance) — force blue, matching the server
        alliance: isRecord ? 'blue' : settings.alliance,
        startIndex: settings.startIndex,
        startPose: settings.startPose ?? null,
        ready: false,
        spec: settings.spec,
        assists: settings.assists,
      },
      config,
    );
  }

  const setAlliance = (alliance: Alliance): void => lobbyRef.current?.update({ alliance });
  const toggleReady = (): void => lobbyRef.current?.update({ ready: !me?.ready });

  // 2v2 ROLE + consent swap: first robot on the alliance = CLOSE, second = FAR;
  // either can propose a swap the other must accept (see useRoleSwap).
  const rs = useRoleSwap(players, me, (patch) => lobbyRef.current?.update(patch));
  const startRole = rs.role;
  const [swapDismissed, dismissSwap] = useDismissable(rs.incoming);

  // route a settings patch: ACTIVE start (startIndex/startPose) → the roster,
  // library/memory (startCat/startMemory/savedStartPoses) → local settings.
  const applyStart = (patch: Partial<GS>): void => {
    const roster: Record<string, unknown> = {};
    if ('startIndex' in patch) roster.startIndex = patch.startIndex;
    if ('startPose' in patch) roster.startPose = patch.startPose ?? null;
    if (Object.keys(roster).length) lobbyRef.current?.update(roster);
    const keys: (keyof GS)[] = ['startCat', 'startMemory', 'savedStartPoses'];
    if (keys.some((k) => k in patch)) onSettingsChange({ ...settings, ...patch });
  };
  // settings with the category forced to the locked role (so the helpers write
  // memory/library into the right bucket even though the tabs are hidden)
  const sCat: GS = { ...settings, startCat: startRole ?? settings.startCat };

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
              {isRecord ? (
                <>Duo <span className="accent">Record</span></>
              ) : (
                <>Multi<span className="accent">player</span></>
              )}
            </h1>
          </div>
          <p className="ds-sub" style={{ marginTop: -10 }}>
            {isRecord
              ? '2v0 co-op score attack · same drivetrain · share a room code.'
              : 'Up to 2v2 · share a room code.'}
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
            <div className="ds-opts two" style={{ marginTop: 4 }}>
              <button
                className={`ds-opt ${entryMode === 'create' ? 'on' : ''}`}
                onClick={() => setEntryMode('create')}
              >
                <span className="ot">Create room</span>
                <span className="od">Get a code to share</span>
              </button>
              <button
                className={`ds-opt ${entryMode === 'join' ? 'on' : ''}`}
                onClick={() => setEntryMode('join')}
              >
                <span className="ot">Join room</span>
                <span className="od">Enter a friend’s code</span>
              </button>
            </div>
            {entryMode === 'join' && (
              <label className="ds-field">
                <span className="cap">Room code</span>
                <input
                  className="ds-input"
                  value={code}
                  onChange={(e) => setCode(normalizeRoomCode(e.target.value))}
                  onKeyDown={(e) => e.key === 'Enter' && joinWithCode()}
                  placeholder={`${ROOM_CODE_LENGTH} characters`}
                  maxLength={ROOM_CODE_LENGTH}
                  autoFocus
                />
              </label>
            )}
            {phase === 'error' && <p className="ds-form-err">⚠ {error}</p>}
            <div className="ds-actions">
              {entryMode === 'create' ? (
                <button className="ds-cta" disabled={phase === 'connecting'} onClick={createRoom}>
                  {phase === 'connecting' ? 'CREATING…' : 'CREATE ROOM ▶'}
                </button>
              ) : (
                <button
                  className="ds-cta"
                  disabled={phase === 'connecting' || code.length !== ROOM_CODE_LENGTH}
                  onClick={joinWithCode}
                >
                  {phase === 'connecting' ? 'JOINING…' : 'JOIN ▶'}
                </button>
              )}
            </div>
            <p className="ds-hint">
              {isRecord
                ? 'Both drivers must be on the SAME drivetrain (the board is split by drivetrain).'
                : 'Codes are auto-generated — share yours with your friends.'}
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
            {isRecord ? 'Duo' : 'Room'} <span className="accent">{code}</span>
          </h1>
        </div>
        <p className="ds-sub" style={{ marginTop: -10, display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap' }}>
          <span>
            {isHost ? 'You are the host' : 'Waiting for the host to start'} · {players.length}/
            {capacity} drivers
          </span>
          <button
            className="ds-chip"
            title="Copy the room code to share"
            style={{ cursor: 'pointer' }}
            onClick={() => {
              void navigator.clipboard?.writeText(code);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? '✓ Copied' : '⧉ Copy code'}
          </button>
        </p>

        <section className="ds-sec">
          <h2>Drivers</h2>
          <div className="ds-players">
            {players.map((p) => {
              const isMe = p.clientId === myId;
              return (
                <div key={p.clientId} className={`ds-player ${p.alliance}`}>
                  <span className="pdot" />
                  <span className="pnm">
                    {p.name}
                    {isMe ? ' (you)' : ''}
                  </span>
                  <span className="ptm">
                    {p.spec.name} · {p.teamNumber || '—'}
                  </span>
                  {p.clientId === hostId && (
                    <span className="ds-chip on">★ HOST</span>
                  )}
                  <span className={`ds-chip ${p.alliance}`}>{p.alliance.toUpperCase()}</span>
                  <span className="ds-chip">{p.startPose ? 'CUSTOM' : (START_POSES[p.startIndex]?.label ?? '—')}</span>
                  <span className={`ds-chip ${p.ready ? 'on' : 'off'}`}>
                    {p.ready ? 'READY' : 'NOT READY'}
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        {!isRecord && (
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
        )}

        {me && (
          <section className="ds-sec">
            <h2>Start position</h2>
            {rs.canSwap && (
              <RoleSwapBar
                role={startRole}
                partnerName={rs.partner?.name ?? 'Partner'}
                rs={rs}
                dismissed={swapDismissed}
                onDismiss={dismissSwap}
              />
            )}
            <StartPositionEditor
              spec={me.spec}
              alliance={me.alliance}
              value={me.startPose}
              startIndex={me.startIndex}
              category={startRole ?? settings.startCat}
              saved={settings.savedStartPoses}
              lockedCategory={startRole}
              onChange={(startPose) => startPose && applyStart(selectStart(sCat, { index: -1, pose: startPose }))}
              onPickPreset={(i) => applyStart(selectStart(sCat, { index: i, pose: null }))}
              onCategory={(c) => applyStart(switchCategory(settings, c))}
              onSave={(pose) => applyStart(saveStart(sCat, pose))}
              onDeleteSaved={(c, i) => applyStart(deleteSavedStart(sCat, c, i))}
            />
          </section>
        )}

        <div className="ds-actions">
          <button className={`ds-cta ${me?.ready ? 'ghost' : ''}`} onClick={toggleReady}>
            {me?.ready ? '✓ READY' : 'READY UP'}
          </button>
          {isHost && (
            <button className="ds-cta" disabled={!canStart} onClick={() => lobbyRef.current?.start()}>
              {isRecord ? 'START RUN ▶' : 'START MATCH ▶'}
            </button>
          )}
        </div>
        {isHost && !enoughPlayers && (
          <p className="ds-hint">Waiting for your partner to join with the code…</p>
        )}
        {isHost && enoughPlayers && !allReady && (
          <p className="ds-hint">START unlocks when everyone is ready.</p>
        )}
        {isHost && restartPending && (
          <p className="ds-hint">Server is restarting shortly — starting is paused for a moment.</p>
        )}
      </div>
    </div>
  );
}
