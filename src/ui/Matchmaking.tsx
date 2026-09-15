import { useEffect, useRef, useState } from 'react';
import type { GameSettings } from '../game';
import { gameServerUrl, gameServerUrlWith, gameServerHttpUrl, multiServer } from '../net/env';
import { probeHome } from '../net/ping';
import { WebSocketTransport } from '../net/transport';
import { LobbyClient, type MatchStart } from '../net/lobbyClient';
import { ServerSession } from '../net/serverSession';
import type { NetSession } from '../net/session';
import type { LobbyPlayer, PlayerIntro, QueueMode } from '../net/protocol';
import { MatchStrategy } from './MatchStrategy';
import { MatchAudio } from '../audio';
import { DODGE_REASON, type DodgeVerdict } from '../dodge';
import { STANDING_MAX, WINDOW_HOURS, lockRemaining, tierOf } from '../standing';
import { RANKED_JOIN_GRACE_MS, STRATEGY_DURATION_MS } from '../net/protocol';
import { widenHint, queuesFor } from './queueDepth';
import {
  parkQueue, takeQueue, updateQueue, dropQueue, elapsedSeconds,
  type ParkedQueue, type ParkedStrategy,
} from './queueKeeper';
import { useParkedQueue } from './QueueBar';
import { usePresence } from './usePresence';
import { useServerNotice } from '../net/notice';
import { APP_NAME } from '../seasons';
import { Logo } from './Logo';
import { useEscape } from './useEscape';
import { formatLabel, type PendingChallenge } from './challenge';

/**
 * ONE string for the one fact, on both waiting screens.
 *
 * They carried two near-identical 24-word paragraphs saying the same thing in the
 * "don't worry, we'll handle it" register. The fact is worth keeping — that the
 * queue survives leaving the screen is genuinely non-obvious, and a first-time
 * searcher has not yet seen the `QueueBar` that demonstrates it — but a "Tip:"
 * label on the only tip on screen is a label for a category of one.
 */
const BACKGROUND_QUEUE_TIP = (
  <>
    <b>← Back</b> keeps you in the queue.
  </>
);

/**
 * WHAT QUEUEING COMMITS YOU TO, said before you queue.
 *
 * Both ranked clocks are short and strict (`server/room.ts`: connect inside
 * `RANKED_JOIN_GRACE_MS`, ready up inside `STRATEGY_DURATION_MS`, or the match is cancelled
 * for everyone in it and the miss is charged to your account standing as a dodge). Nothing
 * said so until the charge arrived, so the first time a player learned the rule was the
 * screen telling them they had broken it. That is a bad way to publish a rule and it is the
 * complaint this fixes.
 *
 * The numbers are READ from the same constants the server counts on, so the sentence cannot
 * go stale if either window is tuned. It is shown on the queue screen and again while
 * searching, because the second one is where people walk away.
 */
const READY_WINDOW_NOTE = (
  <>
    Once a match is found: <b>{Math.round(RANKED_JOIN_GRACE_MS / 1000)}s</b> to load in, then{' '}
    <b>{Math.round(STRATEGY_DURATION_MS / 1000)}s</b> to ready up. Miss either and the match is
    cancelled and your standing drops.
  </>
);

/**
 * Region-aware ranked matchmaking. We connect to the DESIGNATED matchmaker (a
 * `?mm=1` connection Fly routes to one region), report our home region + access
 * latency, and queue. Matchmaking is region-local first and WIDENS over time (or on
 * "Expand search"). On a match the server sends `matchAssigned` with a region-coded
 * room; we drop this socket and reconnect to `?room=…` (routed to the fair host
 * region) to actually play. On a single-region / no-DB dev server the server instead
 * sends `matchStart` straight back on this socket (handled too). ELO is applied
 * server-side on match end.
 */
/** the pre-match strategy window state, once a paired match opens one */
interface StrategyState {
  lobby: LobbyClient;
  players: LobbyPlayer[];
  myClientId: string;
  deadline: number;
  mode: QueueMode;
  intros: PlayerIntro[];
}

export function Matchmaking({
  settings,
  signedIn,
  onStart,
  onCancel,
  onSignIn,
  onSettingsChange,
  challenge,
  onChallengeConsumed,
}: {
  settings: GameSettings;
  signedIn: boolean;
  onStart: (s: NetSession) => void;
  onCancel: () => void;
  onSignIn: () => void;
  onSettingsChange: (s: GameSettings) => void;
  /** arrived here from a RATED "play a friend" challenge: queue under its token
   * immediately instead of showing the mode picker */
  challenge?: PendingChallenge;
  /** one-shot: clear it so a later ordinary visit to /ranked is an ordinary queue */
  onChallengeConsumed?: () => void;
}) {
  // a challenge dictates the bucket — you agreed on a format, there is nothing
  // left to pick
  const [mode, setMode] = useState<QueueMode>(challenge?.mode ?? '1v1');
  const [noWiden, setNoWiden] = useState(false);
  // Live queue depths, refreshed while on this screen. `full` because THIS is the
  // screen where the number decides something: you read "3 waiting in 1v1" and
  // queue on the strength of it, so it gets an uncached read rather than the
  // ambient chip's up-to-a-minute-old one.
  const presence = usePresence(8000, true);
  // depth for THIS game only — see the note where it renders
  const depth = queuesFor(presence, settings.game) ?? { '1v1': 0, '2v2': 0 };
  // block queueing while a server restart is scheduled (you'd only get dropped)
  const notice = useServerNotice();
  const restartPending =
    !!notice && notice.kind === 'restart' && (notice.until === undefined || notice.until > Date.now());
  const [searching, setSearching] = useState(false);
  const [queue, setQueue] = useState({ size: 0, need: 2 });
  /** manual EXPAND SEARCH presses this search — shown so the button visibly does
   *  something. The server keeps its own count (`expandBumps`); this is only the
   *  local echo of it, and it is reset with every new search. */
  const [bumps, setBumps] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  /** what a cancelled ranked pairing cost — shown next to the cancellation itself, because
   *  a rating drop the player is not told about is the thing that makes a penalty feel
   *  arbitrary. `null` for a player who was NOT at fault, which is worth saying out loud. */
  const [dodge, setDodge] = useState<{ yours: DodgeVerdict | null; others: DodgeVerdict[] } | null>(null);
  // the ranked queue refused us on ACCOUNT STANDING (a live clock, so `tick` re-renders it)
  const [lock, setLock] = useState<{ until: number; score: number } | null>(null);
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (!lock || lock.until <= tick) return;
    const id = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [lock, tick]);
  // set once a paired match opens its pre-match strategy window (see MatchStrategy)
  const [strategy, setStrategy] = useState<StrategyState | null>(null);

  const lobbyRef = useRef<LobbyClient | null>(null);
  // The unmount cleanup runs with the closure from the FIRST render, so anything it
  // needs has to be a ref rather than state — these mirror `searching`/`mode`/`queue`
  // purely so `teardown` reads what is true NOW instead of what was true on mount.
  const searchingRef = useRef(false);
  const modeRef = useRef<QueueMode>(challenge?.mode ?? '1v1');
  const queueRef = useRef({ size: 0, need: 2 });
  const gameRef = useRef(settings.game);
  const startedAtRef = useRef(0);
  const startedRef = useRef(false);
  const assigningRef = useRef(false); // reconnecting from matchmaker → host
  // The challenge is captured ONCE, in a ref. App clears its copy the moment this
  // screen consumes it (so /ranked doesn't resurrect it on a later visit), and a
  // prop that vanishes mid-search would otherwise silently turn a private
  // challenge into an open queue entry on any reconnect.
  const challengeRef = useRef<PendingChallenge | null>(challenge ?? null);
  /**
   * WHAT THIS SCREEN KNOWS ABOUT A MATCH THAT HAS ALREADY BEEN FOUND.
   *
   * `teardown` runs from the FIRST render's closure and used to hand the keeper a brand-new
   * search — `found: false`, every payload `null` — however far things had actually got. So an
   * unmount anywhere between "match found" and "match playing" threw the match away: the
   * events that carried it fire exactly once and are then gone, the staged room went on
   * holding a seat nobody arrived at, and the player was billed a dodge for a match their own
   * client had quietly forgotten. Reported as "instead of being sent to the match prep menu, I
   * was sent to the queuing menu, and I was unable to ready up, which dropped my standing".
   *
   * These are what a re-park hands back instead. Refs and not state for the usual reason: the
   * unmount cleanup reads what is true NOW, not what was true on the first render.
   */
  const foundRef = useRef(false);
  const assignedRoomRef = useRef<string | null>(null);
  const strategyRef = useRef<ParkedStrategy | null>(null);
  /** `lobbyRef` holds the MATCH ROOM's socket (our seat), not the matchmaker's */
  const joinedRef = useRef(false);
  /** the CURRENT player info, for the sockets that outlive this render. A parked socket joins
   *  its room after the screen is gone, and it must join with the robot the player queued
   *  with rather than whatever the first render happened to see. */
  const playerInfoRef = useRef<() => Omit<LobbyPlayer, 'clientId'>>(() => ({}) as never);
  /** a match has been found and is not playing yet — the screen says so instead of going on
   *  claiming to be searching, which is the state the report above describes */
  const [found, setFound] = useState(false);

  // Esc backs out, same as ← Back — but NOT once a match has paired: MatchStrategy
  // owns the screen then, and its ← Leave forfeits. A stray Esc must not do that.
  useEscape(onCancel, !strategy);

  /** the parked shape, built from what is true RIGHT NOW. Everything about a match already
   *  found travels with it — see `foundRef` for what the alternative cost. */
  const parkedState = (lobby: LobbyClient, joined: boolean): ParkedQueue => ({
    lobby,
    mode: challengeRef.current?.mode ?? modeRef.current,
    // the game this search was QUEUED for, not the one the player wanders into
    game: challengeRef.current?.game ?? gameRef.current,
    // a private challenge stays a private challenge across a park/adopt
    challenge: challengeRef.current,
    since: startedAtRef.current,
    size: queueRef.current.size,
    need: queueRef.current.need,
    assignedRoom: assignedRoomRef.current,
    start: null, // a started match never reaches here: `startedRef` returns above
    strategy: strategyRef.current,
    found: foundRef.current,
    joined,
    error: null,
  });

  const teardown = (): void => {
    const lobby = lobbyRef.current;
    lobbyRef.current = null;
    if (startedRef.current || !lobby) return;
    // BACKGROUND QUEUE: a search in flight is handed to the keeper instead of being
    // dropped, so leaving this screen no longer cancels it. Only the LIFETIME
    // changes here — the socket, the queue message and the match hand-off are all
    // untouched, which is what keeps the blast radius small on a path that costs
    // real ELO when it goes wrong.
    //
    // A match that has already STARTED is the one case that tears down for real: the
    // session owns the transport from then on.
    if (joinedRef.current) {
      /**
       * A SEAT IN A STAGED ROOM IS NOT A SOCKET TO THROW AWAY. This used to dispose it —
       * "parking it would leave a socket nobody is going to come back for" — which was true
       * before the takeover existed and is exactly backwards now: closing it during
       * `connecting` or the strategy window is a DISCONNECT, i.e. a cancelled match and a
       * dodge charged to this player. Parked, the seat is held, the room's clocks run
       * normally, and whatever the room sends next brings a screen back to it.
       */
      wireRoomLobby(lobby, assignedRoomRef.current ?? '', false);
      parkQueue(parkedState(lobby, true));
      return;
    }
    if (searchingRef.current && !assigningRef.current) {
      // REBIND to keeper-owned handlers: the ones registered below close over this
      // component's state, and calling them after unmount would write into a tree
      // that is gone. `on()` replaces, so this is a straight hand-over.
      //
      // Each "found" handler RECORDS ITS PAYLOAD, not just the fact of it. These
      // events fire exactly once; the screen that adopts the socket arrives after
      // they are gone, so anything dropped here is unrecoverable and the player
      // waits forever on a match that has already started.
      lobby.on('queued', (_m, size, need) => updateQueue({ size, need }));
      /**
       * ⚠️ AN ASSIGNMENT IS ACTED ON WHERE IT ARRIVES, NOT RECORDED FOR LATER.
       *
       * It used to be written into the keeper and the JOIN left to whichever screen the
       * takeover managed to mount — with `RANKED_JOIN_GRACE_MS` already running. Every hitch
       * between the two spent that budget (a React tree tearing down a live practice match, a
       * navigation landing elsewhere, an exception anywhere in the chain), and running it out
       * is a cancelled match and a dodge on this player's standing for one they were never
       * connected to. `parkAssignedRoom` takes the seat immediately; the screen that comes
       * back has only the prep window left to show.
       */
      lobby.on('matchAssigned', (room) => {
        matchFound();
        parkAssignedRoom(lobby, room);
      });
      lobby.on('matchStart', (m) => {
        matchFound();
        updateQueue({ start: m, found: true });
      });
      lobby.on('strategyStart', (deadline, yourRobotId, m, intros) => {
        matchFound();
        updateQueue({
          strategy: { deadline, yourRobotId, mode: m, intros, players: lobby.players, myClientId: lobby.clientId },
          found: true,
        });
      });
      lobby.on('error', (msg) => updateQueue({ error: msg }));
      lobby.on('closed', () => updateQueue({ error: 'Lost connection to the game server.' }));
      parkQueue(parkedState(lobby, false));
      return;
    }
    lobby.leaveQueue();
    lobby.dispose();
  };
  useEffect(() => teardown, []); // cleanup on unmount

  useEffect(() => {
    searchingRef.current = searching;
  }, [searching]);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);
  useEffect(() => {
    gameRef.current = settings.game;
  }, [settings.game]);

  // The stopwatch is DERIVED from when the search actually began, never counted up
  // from when this screen mounted. Adopting a parked queue re-enters this effect,
  // and a local counter restarted at 0 there — so leaving and coming back reset a
  // wait the player had genuinely been sitting through. `startedAtRef` is the
  // keeper's `since` on that path, so the two agree by construction.
  useEffect(() => {
    if (!searching) return;
    // 0 is the ref's "no search has started" value, not a 1970 timestamp
    const paint = (): void =>
      setElapsed(startedAtRef.current ? elapsedSeconds(startedAtRef.current) : 0);
    paint(); // show the real figure now, not a second from now
    const iv = window.setInterval(paint, 1000);
    return () => window.clearInterval(iv);
  }, [searching]);

  /**
   * ADOPT a search that was running while this screen was away.
   *
   * Runs BEFORE the challenge auto-queue below, and returning true suppresses it:
   * a parked queue means we are already in the bucket, and queueing again would put
   * a second entry in for the same player.
   */
  const adoptParked = (): boolean => {
    const p = takeQueue();
    if (!p) return false;
    const lobby = p.lobby;
    lobbyRef.current = lobby;
    setMode(p.mode);
    modeRef.current = p.mode;
    // a parked private challenge is still a private challenge on the way back in
    challengeRef.current = p.challenge;
    setQueue({ size: p.size, need: p.need });
    queueRef.current = { size: p.size, need: p.need };
    startedAtRef.current = p.since;
    setSearching(true);
    searchingRef.current = true;
    if (p.error) setError(p.error);
    // whatever the search had already achieved comes back with it
    foundRef.current = p.found;
    setFound(p.found);
    assignedRoomRef.current = p.assignedRoom;
    strategyRef.current = p.strategy;
    if (p.joined) {
      /**
       * THE SEAT IS ALREADY TAKEN — this socket is IN the match room, not in the queue
       * (`ParkedQueue.joined`). Re-point its events at this screen and nothing else: joining
       * again would seat a second client under one user, and the events that matter from here
       * are the room's own.
       */
      assigningRef.current = true;
      joinedRef.current = true;
      wireRoomLobby(lobby, p.assignedRoom ?? '', true);
    } else {
      // take the handlers back off the keeper
      lobby.on('queued', (_m, size, need) => setQueue({ size, need }));
      wireStrategy(lobby);
      lobby.on('matchStart', (m: MatchStart) => {
        startedRef.current = true;
        matchFound();
        onStart(new ServerSession(lobby.transport, lobby.isHost(), m, lobby.clientId, 'ranked'));
      });
      lobby.on('matchAssigned', (room) => {
        matchFound();
        joinAssignedMatch(room);
      });
      lobby.on('dodgeVerdict', (yours, others) => setDodge({ yours, others }));
      lobby.on('standingLock', (until, score) => { setLock({ until, score }); setSearching(false); });
      lobby.on('error', (msg) => strategyCancelled(msg));
      lobby.on('closed', () => {
        if (!startedRef.current && !assigningRef.current)
          setError('Lost connection to the game server.');
      });
    }
    // REPLAY whatever landed WHILE PARKED. These events have already fired and will
    // not fire again for the handlers just registered above, so acting on the
    // recorded payload is the only way the adopted screen ever learns about them.
    // Ordered most-progressed first: a match that has actually STARTED supersedes
    // the strategy window that preceded it, which supersedes a bare assignment.
    if (p.start) {
      startedRef.current = true;
      // the room code when the match is running in one, `'ranked'` on the single-region path
      onStart(
        new ServerSession(lobby.transport, lobby.isHost(), p.start, lobby.clientId, p.assignedRoom ?? 'ranked'),
      );
    } else if (p.strategy) {
      const s = p.strategy;
      setStrategy({
        lobby,
        players: s.players.length ? s.players : lobby.players,
        myClientId: s.myClientId || lobby.clientId,
        deadline: s.deadline,
        mode: s.mode,
        intros: s.intros,
      });
    } else if (p.assignedRoom && !p.joined) {
      // an assignment recorded by a build that parked before taking the seat
      joinAssignedMatch(p.assignedRoom);
    }
    return true;
  };

  // Arriving from a challenge, there is nothing to choose and nothing to confirm —
  // both sides already agreed on the format, and whoever gets here first is
  // waiting on the other. So queue on mount rather than showing a FIND MATCH
  // button they'd have to press to start waiting.
  useEffect(() => {
    if (adoptParked()) return; // already in the queue — do not enter it twice
    if (!challengeRef.current || !signedIn) return;
    onChallengeConsumed?.();
    void find();
    // mount only: `find` closes over state that is stable for this screen's life,
    // and re-running would double-queue
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * ADOPTION IS NOT A MOUNT EVENT — it is "a parked search exists and nothing here owns it".
   *
   * App's takeover says `if (screenRef.current === 'matchmaking') return; // already there; it
   * will adopt`, and with a mount-only adopt that was simply untrue: a screen that is already
   * up never mounts again, so a search parked while it is showing would sit in the keeper
   * forever with a match found and nobody acting on it. Watching the store costs one
   * subscription and makes the takeover's assumption true.
   *
   * It cannot double-queue: `takeQueue` hands a search back exactly once, and the challenge
   * auto-queue stays where it is, in the mount effect.
   */
  const parked = useParkedQueue();
  useEffect(() => {
    if (!parked || lobbyRef.current) return; // nothing to adopt / this screen has its own socket
    adoptParked();
    // `adoptParked` reads refs and setters, all stable for this screen's life
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parked]);

  /** "your match is ready" chime. Its own MatchAudio because the game controller is
   *  not up yet on this screen, and a ref-guard so a search fires it exactly once —
   *  `matchAssigned` and `strategyStart` are both "found" signals and on the
   *  single-region path both can arrive. */
  const alertRef = useRef<MatchAudio | null>(null);
  const alertedRef = useRef(false);
  const matchFound = (): void => {
    if (alertedRef.current) return;
    alertedRef.current = true;
    alertRef.current ??= new MatchAudio();
    const a = alertRef.current;
    a.masterVolume = settings.audio.volume.master;
    a.alertVolume = settings.audio.volume.alert;
    a.sfxMatchFound();
  };

  const playerInfo = (): Omit<LobbyPlayer, 'clientId'> => ({
    name: settings.spec.teamName || 'Player',
    teamName: settings.spec.teamName,
    teamNumber: settings.spec.teamNumber,
    alliance: 'red' as const, // matchmaking assigns the real alliance
    startIndex: settings.startIndex,
    startPose: settings.startPose ?? null,
    ready: false, // the pre-match strategy screen owns readiness now
    spec: settings.spec,
    assists: settings.assists,
  });
  // the sockets that outlive this render read it from here, so it is refreshed every render
  // rather than frozen into whichever closure happened to create them.
  playerInfoRef.current = playerInfo;

  /** attach the pre-match strategy handlers to a lobby socket (dev mm-socket path
   * AND the production reconnected host-room path both open a strategy window). */
  const wireStrategy = (lobby: LobbyClient): void => {
    lobby.on('roster', (players) =>
      setStrategy((s) => (s ? { ...s, players, myClientId: lobby.clientId } : s)),
    );
    lobby.on('strategyStart', (deadline, yourRobotId, m, intros) => {
      // REMEMBERED, not just rendered: if this screen goes away before the window closes, the
      // re-park has to be able to put it back up (`foundRef`). A prep window the client forgot
      // is a match the player cannot ready up for and is then billed for missing.
      foundRef.current = true;
      setFound(true);
      strategyRef.current = {
        deadline, yourRobotId, mode: m, intros, players: lobby.players, myClientId: lobby.clientId,
      };
      setStrategy({
        lobby,
        players: lobby.players,
        myClientId: lobby.clientId,
        deadline,
        mode: m,
        intros,
      });
    });
  };

  /**
   * EVERY EVENT A MATCH-ROOM SOCKET CAN RAISE, wired either to THIS SCREEN or to the KEEPER.
   *
   * One function for both because the two must not drift: the parked half exists precisely so
   * that a room socket with nobody watching still behaves — it holds the seat, records the prep
   * window, and lets the takeover bring a screen to it. A handler present in one list and
   * missing from the other is a signal that is silently lost on whichever side forgot it, and
   * every signal here decides whether a rated match happens.
   */
  const wireRoomLobby = (lobby: LobbyClient, room: string, live: boolean): void => {
    if (live) {
      wireStrategy(lobby);
      lobby.on('matchStart', (m: MatchStart) => {
        startedRef.current = true;
        onStart(new ServerSession(lobby.transport, lobby.isHost(), m, lobby.clientId, room));
      });
      lobby.on('dodgeVerdict', (yours, others) => setDodge({ yours, others }));
      lobby.on('standingLock', (until, score) => { setLock({ until, score }); setSearching(false); });
      lobby.on('error', (msg) => strategyCancelled(msg));
      lobby.on('closed', () => {
        if (!startedRef.current) strategyCancelled('Lost connection to the match server.');
      });
      return;
    }
    // PARKED: record what arrives and let the takeover act on it. `found` is what wakes it.
    //
    // ⚠️ EVERY event this screen wired LIVE is re-registered here, including the three that
    // have nothing to do while parked. `on()` REPLACES, so an event left alone keeps the live
    // handler — which is a closure over a tree that no longer exists. `dodgeVerdict` is the
    // one real loss: a match cancelled while parked still reports its `error`, which the queue
    // bar shows, but not the itemised "what it cost you" notice, because the keeper has no slot
    // to carry one.
    lobby.on('roster', () => {});
    lobby.on('dodgeVerdict', () => {});
    lobby.on('standingLock', () => {});
    lobby.on('strategyStart', (deadline, yourRobotId, m, intros) => {
      matchFound();
      updateQueue({
        strategy: { deadline, yourRobotId, mode: m, intros, players: lobby.players, myClientId: lobby.clientId },
        found: true,
      });
    });
    lobby.on('matchStart', (m) => {
      matchFound();
      updateQueue({ start: m, found: true });
    });
    lobby.on('error', (msg) => updateQueue({ error: msg }));
    lobby.on('closed', () => updateQueue({ error: 'Lost connection to the match server.' }));
  };

  /**
   * OPEN THE ASSIGNED ROOM AND TAKE THE SEAT.
   *
   * `gameServerUrlWith({ room })` is region-coded (`fly-replay` routes on the code), so this
   * lands on the host machine wherever the player is. `live` says whether a screen is watching
   * — see `wireRoomLobby`.
   */
  const openAssignedRoom = (room: string, live: boolean): LobbyClient | null => {
    let transport: WebSocketTransport;
    try {
      transport = new WebSocketTransport(gameServerUrlWith({ room }));
    } catch {
      return null;
    }
    const lobby = new LobbyClient(transport);
    wireRoomLobby(lobby, room, live);
    lobby.join(room, playerInfoRef.current());
    return lobby;
  };

  /**
   * THE SAME JOIN, WITH NOBODY WATCHING — called from the PARKED `matchAssigned` handler.
   *
   * ⚠️ The matchmaker socket is disposed here rather than left open, and that is not just
   * tidiness: `LobbyClient.queue` re-sends its queue frame on EVERY reconnect
   * (`transport.onReopen`), so a parked matchmaker socket that blips would put the player back
   * in the pool while the room they have already been staged into is waiting for them.
   */
  const parkAssignedRoom = (mm: LobbyClient, room: string): void => {
    const lobby = openAssignedRoom(room, false);
    mm.dispose();
    if (!lobby) {
      updateQueue({ assignedRoom: room, found: true, error: 'Couldn’t reach the match server.' });
      return;
    }
    updateQueue({ lobby, assignedRoom: room, joined: true, found: true });
  };

  /** a cancel/close arrived (deadline lapsed, opponent left): drop the strategy
   * screen back to the queue with the reason shown. */
  const strategyCancelled = (msg: string): void => {
    // THE MATCH IS OVER — forget it. A socket still marked as a seat in a staged room would be
    // parked on the way out (`teardown`) and the takeover would drag the player back into a
    // room that no longer wants them.
    clearFound();
    setStrategy(null);
    setSearching(false);
    setError(msg);
  };

  /** forget a found match: nothing left to hand back, nothing left to come back to. */
  const clearFound = (): void => {
    foundRef.current = false;
    joinedRef.current = false;
    assigningRef.current = false;
    assignedRoomRef.current = null;
    strategyRef.current = null;
    setFound(false);
  };

  /** "30 minutes" / "2 hours" / "7 days" — a lock length in the biggest unit that stays exact */
  const minutesText = (min: number): string => {
    if (min < 60) return `${min} minute${min === 1 ? '' : 's'}`;
    if (min < 60 * 24) {
      const h = Math.round(min / 60);
      return `${h} hour${h === 1 ? '' : 's'}`;
    }
    const d = Math.round(min / (60 * 24));
    return `${d} day${d === 1 ? '' : 's'}`;
  };

  /** the cancellation notice: WHY it died and what it cost you. Rendered next to every
   *  error slot, so it appears wherever the cancel surfaces. */
  const dodgeNote = (): JSX.Element | null => {
    if (!dodge) return null;
    const y = dodge.yours;
    if (y?.kind) {
      const st = y.standing;
      const nth =
        y.count === 1 ? 'first' : y.count === 2 ? 'second' : y.count === 3 ? 'third' : `${y.count}th`;
      return (
        <div className="ds-dodge charged">
          {/* STANDING, not rating — and the number is the headline because it is the thing
              that actually changed. A dodge only ever reaches the rating after a warning and
              two cooldowns have been ignored, and when it does, it is said plainly. */}
          <b>
            {st ? `−${st.points} standing · ${st.scoreBefore} → ${st.scoreAfter}` : 'Match cancelled'}
            {st && st.ratingCharge > 0 && ` · −${st.ratingCharge} rating`}
          </b>
          <span>
            You {DODGE_REASON[y.kind]}. That is your {nth} in {WINDOW_HOURS.dodge} hours
            {st && st.cooldownMin > 0
              ? `. Ranked is locked for ${minutesText(st.cooldownMin)}.`
              : '.'}
          </span>
          {/* TELL THEM WHAT THE NEXT ONE COSTS. Both systems this is patterned on publish the
              next rung rather than letting a player discover it by hitting it, and the whole
              point of an escalating ladder is that it can be seen coming. */}
          {st && st.nextCooldownMin > st.cooldownMin && (
            <span>The next one locks it for {minutesText(st.nextCooldownMin)}.</span>
          )}
          {st && (
            <span className="ds-muted">
              Account standing: {tierOf(st.scoreAfter).name.toLowerCase()}. Finishing matches earns it back.
            </span>
          )}
        </div>
      );
    }
    const who = dodge.others.filter((o) => o.kind).length;
    return (
      <div className="ds-dodge clear">
        <b>Nothing was charged to you</b>
        <span>
          {who > 0
            ? `${who === 1 ? 'A player' : `${who} players`} didn’t make it to the match. You were ready, so this one is on them.`
            : 'The match was cancelled before it started.'}
        </span>
      </div>
    );
  };

  /** RANKED IS LOCKED: the queue refused this account because its standing carries a
   *  cooldown. Its own notice rather than an error string — a lock has a clock, so it counts
   *  down and the button comes back on its own. */
  const lockNote = (): JSX.Element | null => {
    if (!lock || lock.until <= tick) return null;
    return (
      <div className="ds-dodge charged">
        <b>Ranked is locked for {lockRemaining(lock.until, tick)}</b>
        <span>
          Your account standing is {tierOf(lock.score).name.toLowerCase()} ({lock.score}/{STANDING_MAX}).{' '}
          {tierOf(lock.score).blurb}
        </span>
        {/* "finishing matches earns it back" is `dodgeNote`'s line, and the two
            notices can stand one above the other in the same panel. Said once, in
            one wording, by whichever one is up. */}
        <span className="ds-muted">Custom rooms and solo practice are unaffected.</span>
      </div>
    );
  };

  const find = async (): Promise<void> => {
    if (!gameServerUrl()) {
      setError('The game server isn’t configured.');
      return;
    }
    if (restartPending) {
      setError('Server is restarting shortly - try again in a minute.');
      return;
    }
    setError('');
    setElapsed(0);
    setBumps(0);
    alertedRef.current = false;
    clearFound(); // a new search knows nothing about the last one
    startedAtRef.current = Date.now();
    setSearching(true);
    searchingRef.current = true;
    // measure our home region + access latency (best-effort — the matchmaker falls
    // back to its own region if we can't report one)
    const home = await probeHome(gameServerHttpUrl());
    let transport: WebSocketTransport;
    try {
      transport = new WebSocketTransport(gameServerUrlWith({ mm: '1' }));
    } catch {
      setError('Couldn’t reach the game server.');
      setSearching(false);
      return;
    }
    const lobby = new LobbyClient(transport);
    lobbyRef.current = lobby;
    lobby.on('queued', (_m, size, need) => setQueue({ size, need }));
    // dev / single-region / no-DB: the strategy window + match run on this same socket
    wireStrategy(lobby);
    lobby.on('matchStart', (m: MatchStart) => {
      startedRef.current = true;
      matchFound();
      onStart(new ServerSession(transport, lobby.isHost(), m, lobby.clientId, 'ranked'));
    });
    // normal path: reconnect to the assigned host region to play
    lobby.on('matchAssigned', (room) => {
      matchFound();
      joinAssignedMatch(room);
    });
    lobby.on('dodgeVerdict', (yours, others) => setDodge({ yours, others }));
    lobby.on('standingLock', (until, score) => { setLock({ until, score }); setSearching(false); });
    lobby.on('error', (msg) => strategyCancelled(msg));
    lobby.on('closed', () => {
      if (!startedRef.current && !assigningRef.current)
        setError('Lost connection to the game server.');
    });
    lobby.queue(
      // a challenge fixes the bucket, and it must win over `mode` state: the auto-
      // start below fires from a mount effect, where a setState in the same tick
      // would not have landed yet
      challengeRef.current?.mode ?? mode,
      playerInfo(),
      home?.region ?? '',
      home?.accessMs ?? 0,
      noWiden,
      // THE CHALLENGE'S GAME, not the one this client happens to be sitting in.
      // The matchmaker buckets by game (a CR queuer must never pair into a DECODE
      // room), and a challenge is accepted from wherever the recipient already is
      // — so queueing under `settings.game` put the two halves of one challenge in
      // two different buckets whenever the friends were on different games. The
      // closed pair then waits for each other forever: `findMatch` requires a
      // single bucket, so it can never stage, and neither side is ever told why.
      challengeRef.current?.game ?? settings.game,
      challengeRef.current
        ? {
            token: challengeRef.current.token,
            format: challengeRef.current.format,
            partyOnly: challengeRef.current.partyOnly,
          }
        : undefined,
    );
  };

  /** a ranked match was assigned: drop the matchmaker socket and open a fresh one to
   * the region-coded room (fly-replay routes it to the fair host region). */
  const joinAssignedMatch = (room: string): void => {
    assigningRef.current = true;
    foundRef.current = true;
    setFound(true);
    assignedRoomRef.current = room;
    lobbyRef.current?.dispose(); // the matchmaker socket's whole job is done
    const lobby = openAssignedRoom(room, true);
    if (!lobby) {
      setError('Couldn’t reach the match server.');
      return;
    }
    joinedRef.current = true;
    lobbyRef.current = lobby;
  };

  /**
   * Widen one step NOW rather than waiting for the next automatic one.
   *
   * The server call was already here; what was missing was any sign it happened.
   * The button fired `expandSearch()` and nothing on screen moved — no counter, no
   * text change — so it read as dead, and the natural response is to press it
   * repeatedly. Tracking the presses locally is enough to say so out loud.
   */
  const expand = (): void => {
    if (!lobbyRef.current) return;
    lobbyRef.current.expandSearch();
    setBumps((n) => n + 1);
  };

  const cancel = (): void => {
    // explicit cancel is NOT a park: pressing cancel means leave the queue, so drop
    // the search here rather than letting `teardown` hand it to the keeper. `clearFound`
    // first, or a socket holding a seat would be parked instead of dropped.
    searchingRef.current = false;
    clearFound();
    teardown();
    dropQueue();
    setSearching(false);
    // dropping out of a challenge leaves you on the ordinary ranked screen, not in
    // a state where FIND MATCH would silently re-enter the private queue
    challengeRef.current = null;
  };

  /** the console scaffold every full-screen setup surface shares (Lobby, Record
   * Run, MatchStrategy) — back control + brand mark, then a titled panel. */
  const page = (title: JSX.Element, sub: string, body: JSX.Element): JSX.Element => (
    <div className="ds-console">
      <div className="ds-console-in narrow">
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
          <h1>{title}</h1>
        </div>
        {/* ALWAYS rendered, with a non-breaking space when there is nothing to say.
            `sub` is '' on every state except searching, so pressing FIND MATCH used to
            add a line to the header block and push the panel down with it. Every sub
            this page passes is a single line, so one reserved line is exactly right. */}
        <p className="ds-sub ds-sub-tight">{sub || ' '}</p>
        <div className="ds-panelbox">{body}</div>
      </div>
    </div>
  );

  // ranked requires an account (ELO / leaderboard). Custom rooms stay open to
  // everyone — the server also rejects an anonymous queue as a backstop.
  if (!signedIn) {
    return page(
      <>
        Ranked <span className="accent">Match</span>
      </>,
      '',
      <>
        <p className="ds-hint">
          Ranked needs an account. Custom Rooms are open to everyone.
        </p>
        <div className="ds-actions">
          <button className="ds-cta" onClick={onSignIn}>
            SIGN IN ▶
          </button>
        </div>
      </>,
    );
  }

  // a paired match opened its pre-match strategy window: take over the whole screen
  if (strategy) {
    return (
      <MatchStrategy
        lobby={strategy.lobby}
        players={strategy.players}
        myClientId={strategy.myClientId}
        deadline={strategy.deadline}
        mode={strategy.mode}
        intros={strategy.intros}
        settings={settings}
        onSettingsChange={onSettingsChange}
        onLeave={() => {
          // LEAVING IS LEAVING. Forget the match FIRST: otherwise `teardown` parks the seat
          // (it is a live room socket now) and the takeover drags the player straight back
          // into the window they just walked out of.
          searchingRef.current = false;
          clearFound();
          teardown();
          dropQueue();
          setStrategy(null);
          setSearching(false);
        }}
      />
    );
  }

  /**
   * A MATCH HAS BEEN FOUND AND IS NOT PLAYING YET — a different fact from searching, and it has
   * to look like one.
   *
   * With only "Finding a match…" to fall back on, every way of ending up here without a prep
   * window looked identical to still being in the queue — which is the report this screen state
   * comes from: "instead of being sent to the match prep menu, I was sent to the queuing menu".
   * A player who can see that a match was found knows the 20-second clocks are running and that
   * leaving now costs standing.
   */
  if (found) {
    return page(
      <>
        Match <span className="accent">found</span>
      </>,
      `${mode.toUpperCase()} · loading into the match`,
      <>
        <p className="ds-hint">{READY_WINDOW_NOTE}</p>
        {error && <p className="ds-form-err">⚠ {error}</p>}
        {dodgeNote()}
        {lockNote()}
      </>,
    );
  }

  if (searching) {
    const ch = challengeRef.current;
    // A challenge is not a search — you are waiting for one named person, and the
    // region-widening controls have nothing to widen toward (a closed party skips
    // the radius entirely, server-side). Saying "finding a match" here would
    // describe something that isn't happening.
    if (ch) {
      return page(
        <>
          Waiting for <span className="accent">@{ch.opponent}</span>
        </>,
        // a closed pair has no queue to report a depth for; a premade genuinely is
        // in the open 2v2 pool once both have accepted, so show it
        ch.partyOnly
          ? `${formatLabel(ch.format)} · ${elapsed}s`
          : `${formatLabel(ch.format)} · ${queue.size}/${queue.need} in queue · ${elapsed}s`,
        <>
          {/* the rated line is gone: the sub two rows above already reads "Rated 1v1 ·
              14s", and "they start the moment they accept" is what "Waiting for @name"
              means. The premade line stays — being put on the SAME alliance is the one
              thing here the title does not say. */}
          {!ch.partyOnly && (
            <p className="ds-hint">You queue together as a team once they accept.</p>
          )}
          {/* the wait here is somebody else's response time, so it is the screen
              MOST worth telling people they can leave */}
          <p className="ds-tip">{BACKGROUND_QUEUE_TIP}</p>
          {error && <p className="ds-form-err">⚠ {error}</p>}
          {dodgeNote()}
          {lockNote()}
          <div className="ds-actions">
            <button className="ds-cta ghost" onClick={cancel}>
              CANCEL
            </button>
          </div>
        </>,
      );
    }
    return page(
      <>
        Finding a <span className="accent">match…</span>
      </>,
      `${mode.toUpperCase()} · ${queue.size}/${queue.need} in queue · ${elapsed}s`,
      <>
        {/* region-local first; widen automatically as you wait, or on demand */}
        {!noWiden && multiServer() && (
          <p className="ds-hint">
            {widenHint(bumps, elapsed)}
          </p>
        )}
        <p className="ds-tip">{BACKGROUND_QUEUE_TIP}</p>
        <p className="ds-hint">{READY_WINDOW_NOTE}</p>
        {error && <p className="ds-form-err">⚠ {error}</p>}
        {dodgeNote()}
        {lockNote()}
        <div className="ds-actions">
          {!noWiden && multiServer() && (
            // the label stays a VERB. `expandLabel` turned it into "EXPANDED ×2" past
            // the first press — a past-tense status that no longer says what pressing
            // it does, and a second statement of a count `widenHint` already carries.
            <button className="ds-cta ghost" onClick={expand}>
              EXPAND SEARCH
            </button>
          )}
          <button className="ds-cta ghost" onClick={cancel}>
            CANCEL
          </button>
        </div>
      </>,
    );
  }

  return page(
    <>
      Ranked <span className="accent">Match</span>
    </>,
    '',
    <>
      <div className="ds-opts two">
        <button className={`ds-opt ${mode === '1v1' ? 'on' : ''}`} onClick={() => setMode('1v1')}>
          <span className="ot">1v1</span>
        </button>
        <button className={`ds-opt ${mode === '2v2' ? 'on' : ''}`} onClick={() => setMode('2v2')}>
          <span className="ot">2v2</span>
        </button>
      </div>
      {/* the mode picker's CAPTION, not a third row: at the panelbox's plain gap it
          sat exactly equidistant from the tiles it describes and the unrelated region
          toggle below, so it belonged to neither. */}
      <p className="ds-hint ds-hint-caption">
        {presence ? (
          <>
            {/* THIS GAME's depth. A combined count named people you cannot be paired
                with — the matchmaker buckets by game — which made the number an
                argument for queueing into a pool that, for you, was empty. */}
            {/* ALL THREE numbers bold and inked, off `.ds-hint b` — one of three
                parallel numbers in a sentence styled and the other two not read as
                formatting that gave up halfway through. */}
            <b>{depth[mode]}</b> waiting in {mode.toUpperCase()} ·{' '}
            <b>{depth[mode === '1v1' ? '2v2' : '1v1']}</b> in{' '}
            {(mode === '1v1' ? '2v2' : '1v1').toUpperCase()} · <b>{presence.online}</b> online
          </>
        ) : (
          'Checking who’s online…'
        )}
      </p>
      {multiServer() && (
        <div className="ds-opts">
          <button className={`ds-opt ${noWiden ? 'on' : ''}`} onClick={() => setNoWiden(!noWiden)}>
            <span className="ot">Only my region {noWiden ? 'ON' : 'OFF'}</span>
          </button>
        </div>
      )}
      <p className="ds-hint">{READY_WINDOW_NOTE}</p>
      {error && <p className="ds-form-err">⚠ {error}</p>}
      {dodgeNote()}
      {lockNote()}
      {restartPending && (
        <p className="ds-form-err">⚠ Server is restarting shortly - queueing is paused for a moment.</p>
      )}
      <div className="ds-actions">
        <button className="ds-cta" disabled={restartPending} onClick={() => void find()}>
          FIND MATCH ▶
        </button>
      </div>
    </>,
  );
}
