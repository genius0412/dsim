import { useEffect, useRef, useState } from 'react';
import type { GameSettings } from '../game';
import type { GameId } from '../games/types';
import { gameServerUrlWith } from '../net/env';
import { WebSocketTransport } from '../net/transport';
import { LobbyClient, type MatchStart } from '../net/lobbyClient';
import { ServerSession } from '../net/serverSession';
import type { NetSession } from '../net/session';
import type { LobbyPlayer, PlayerIntro, QueueMode } from '../net/protocol';
import { announcePhysicsReady, preloadRoomPhysics } from '../net/roomPhysics';
import { preloadRoomView } from '../net/roomView';
import { fetchCompetition } from '../net/competitions';
import type { CompetitionDetail, CompMatchView } from '../competition/wire';
import { countdown } from '../competition/copy';
import { standardRobotFor } from '../settings';
import { seasonFor } from '../seasons';
import { MatchAudio } from '../audio';
import { MatchStrategy } from './MatchStrategy';
import { ConsoleHead } from './ConsoleHead';
import { inMatch } from './CompParts';

interface Strategy {
  deadline: number;
  mode: QueueMode;
  intros: PlayerIntro[];
  label: string;
}

/**
 * JOINING A CALLED COMPETITION MATCH — the competition's twin of the ranked screen's "match
 * found" half, without the queue.
 *
 * The room is staged (`claimCompetitionRoom`): the first driver to open it builds it from the
 * call, everyone after takes the seat the roster holds for their account, and a reload takes the
 * same seat back (`seatFor` in the join path). So this screen keeps no state of its own worth
 * saving: the competition page says the match is called, this screen opens its room, and the
 * room says everything after that (`strategyStart`, `matchStart`, or an `error`).
 *
 * The robot is the player's last STANDARD robot for the competition's game (`standardRobotFor`):
 * a staged room refuses an imported one at the door, as ranked does. The strategy window is where
 * it can be swapped.
 */
export function CompMatchPlay({
  slug,
  settings,
  signedIn,
  onSettingsChange,
  onSelectGame,
  onStart,
  onBack,
  onSignIn,
}: {
  slug: string;
  settings: GameSettings;
  signedIn: boolean;
  onSettingsChange: (s: GameSettings) => void;
  onSelectGame: (g: GameId) => void;
  onStart: (s: NetSession) => void;
  onBack: () => void;
  onSignIn: () => void;
}) {
  const [detail, setDetail] = useState<CompetitionDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [players, setPlayers] = useState<LobbyPlayer[]>([]);
  const [myId, setMyId] = useState('');
  const [strategy, setStrategy] = useState<Strategy | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const lobbyRef = useRef<LobbyClient | null>(null);
  const startedRef = useRef(false);
  const joinedCode = useRef<string | null>(null);

  // the competition, re-read every few seconds until the room has taken over: a call can be
  // cancelled or re-issued (a new room code) while this screen is open
  useEffect(() => {
    let alive = true;
    const load = (): void => {
      fetchCompetition(slug)
        .then((d) => alive && setDetail(d))
        .catch((e: unknown) => alive && setErr(e instanceof Error ? e.message : 'Couldn’t load the competition.'));
    };
    load();
    const t = window.setInterval(() => {
      if (!startedRef.current && !lobbyRef.current) load();
    }, 4000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [slug]);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const comp = detail?.competition ?? null;
  const entryId = detail?.viewer.entryId ?? null;
  const called: CompMatchView | null =
    detail?.matches.find((m) => m.status === 'called' && m.roomCode && inMatch(m, entryId)) ?? null;
  const wrongGame = !!comp && comp.game !== settings.game;
  const skew = detail ? detail.now - Date.now() : 0;

  // the chunks a 3D room needs, fetched while the player reads this screen
  useEffect(() => {
    if (!comp) return;
    void preloadRoomPhysics(comp.game).catch(() => {});
    preloadRoomView(comp.game);
  }, [comp?.game]); // eslint-disable-line react-hooks/exhaustive-deps

  // the room's socket, opened once per call (a re-call is a new code and a new room)
  useEffect(() => {
    if (!called?.roomCode || wrongGame || !signedIn || startedRef.current) return;
    if (joinedCode.current === called.roomCode) return;
    lobbyRef.current?.dispose();
    joinedCode.current = called.roomCode;
    const room = called.roomCode;
    const label = called.label;
    let transport: WebSocketTransport;
    try {
      transport = new WebSocketTransport(gameServerUrlWith({ room }));
    } catch {
      setErr('Couldn’t reach the match server.');
      return;
    }
    const lobby = new LobbyClient(transport);
    lobbyRef.current = lobby;
    lobby.on('roster', (ps) => {
      setPlayers(ps);
      setMyId(lobby.clientId);
    });
    lobby.on('strategyStart', (deadline, _robot, mode, intros) => {
      chime();
      setStrategy({ deadline, mode, intros, label });
      setPlayers(lobby.players);
      setMyId(lobby.clientId);
    });
    lobby.on('matchStart', (m: MatchStart) => {
      startedRef.current = true;
      onStart(new ServerSession(lobby.transport, lobby.isHost(), m, lobby.clientId, room, false, lobby.seatToken));
    });
    lobby.on('error', (msg) => {
      setStrategy(null);
      setErr(msg);
      lobby.retire(10_000);
      lobbyRef.current = null;
    });
    lobby.on('closed', () => {
      if (startedRef.current) return;
      setStrategy(null);
      setErr('Lost connection to the match server.');
      lobbyRef.current = null;
    });
    const spec = standardRobotFor(settings);
    lobby.join(room, {
      name: spec.teamName || 'Player',
      teamName: spec.teamName,
      teamNumber: spec.teamNumber,
      alliance: 'red', // the staged roster decides
      startIndex: settings.startIndex,
      startPose: settings.startPose ?? null,
      ready: false,
      spec,
      assists: spec === settings.spec ? settings.assists : (spec.assists ?? settings.assists),
    });
    lobby.watchStagedStart();
    announcePhysicsReady(lobby, settings.game);
    // THE SOCKET LIVES AS LONG AS THIS EFFECT. Leaving the screen before the match starts closes
    // it (the room holds the seat for its reconnect grace, so coming back takes it again), and so
    // does a new call. Here and not in a separate unmount effect: React's development double mount
    // runs every cleanup once, and a socket closed there with the "already joined" mark left set
    // was never opened again ("0 of 2 here", for good).
    return () => {
      if (startedRef.current) return;
      lobby.dispose();
      if (lobbyRef.current === lobby) lobbyRef.current = null;
      joinedCode.current = null;
    };
    // the join belongs to this call; settings changes re-pick in the window, not here
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [called?.roomCode, wrongGame, signedIn]);

  const audioRef = useRef<MatchAudio | null>(null);
  const chime = (): void => {
    audioRef.current ??= new MatchAudio();
    audioRef.current.masterVolume = settings.audio.volume.master;
    audioRef.current.alertVolume = settings.audio.volume.alert;
    audioRef.current.sfxMatchFound();
  };

  if (strategy && lobbyRef.current && comp) {
    return (
      <MatchStrategy
        lobby={lobbyRef.current}
        players={players}
        myClientId={myId || lobbyRef.current.clientId}
        deadline={strategy.deadline}
        mode={strategy.mode}
        intros={strategy.intros}
        settings={settings}
        onSettingsChange={onSettingsChange}
        competition={{ name: comp.name, label: strategy.label }}
        onLeave={() => {
          if (!window.confirm('Leave this match?\n\nIf you don’t come back before it starts, your alliance may forfeit it.')) return;
          lobbyRef.current?.dispose();
          lobbyRef.current = null;
          onBack();
        }}
      />
    );
  }

  // WHO the room is waiting for, from the schedule: a staged room sends no roster until its
  // strategy window opens, so there is no live count to show
  const nameOf = (id: number): string => detail?.entries.find((e) => e.id === id)?.name ?? `#${id}`;
  let body: JSX.Element;
  if (!signedIn) {
    body = (
      <>
        <p className="ds-hint">Sign in with the account you entered with.</p>
        <div className="ds-actions">
          <button className="ds-btn primary" onClick={onSignIn}>
            Sign in
          </button>
        </div>
      </>
    );
  } else if (err) {
    body = (
      <>
        <p className="ds-hint err" role="alert">
          {err}
        </p>
        <div className="ds-actions">
          <button className="ds-btn" onClick={onBack}>
            Back to the competition
          </button>
        </div>
      </>
    );
  } else if (!detail) {
    body = <p className="ds-loading">Loading…</p>;
  } else if (wrongGame && comp) {
    body = (
      <>
        <p className="ds-hint">
          This competition plays {seasonFor(comp.game).name}. Switch to it to join with your {seasonFor(comp.game).name} robot.
        </p>
        <div className="ds-actions">
          <button className="ds-btn primary" onClick={() => onSelectGame(comp.game)}>
            Switch to {seasonFor(comp.game).name}
          </button>
        </div>
      </>
    );
  } else if (!called) {
    body = (
      <>
        <p className="ds-hint">None of your matches is called right now.</p>
        <div className="ds-actions">
          <button className="ds-btn" onClick={onBack}>
            Back to the competition
          </button>
        </div>
      </>
    );
  } else {
    const left = called.graceEndsAt ? called.graceEndsAt - (now + skew) : null;
    body = (
      <>
        <p className="ds-loading" role="status">
          Waiting for every driver to join.
        </p>
        <p className="ds-hint">
          <span className="ds-comp-side red">{called.red.map((s) => nameOf(s.entry)).join(' & ')}</span>
          <span className="ds-muted"> vs </span>
          <span className="ds-comp-side blue">{called.blue.map((s) => nameOf(s.entry)).join(' & ')}</span>
        </p>
        {left !== null && left > 0 && <p className="ds-hint">The call waits {countdown(left)} more. The strategy window opens when everyone is here.</p>}
      </>
    );
  }

  return (
    <div className="ds-console">
      <div className="ds-console-in narrow">
        <ConsoleHead
          onBack={() => {
            lobbyRef.current?.dispose();
            lobbyRef.current = null;
            onBack();
          }}
          title={called ? `${comp?.name ?? 'Competition'} · ${called.label}` : (comp?.name ?? 'Competition')}
          sub={comp ? seasonFor(comp.game).name : ''}
          reserveSub
        />
        <div className="ds-panel ds-panel-body stack">{body}</div>
      </div>
    </div>
  );
}
