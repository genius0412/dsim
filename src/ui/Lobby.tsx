import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { GameSettings } from '../game';
import type { Alliance, GameSettings as GS, RobotSpec } from '../types';
import { START_POSES } from '../config';
import { CHAIN_START_POSES } from '../games/chain/config';
import { StartPositionEditor } from './StartPositionEditor';
import { savedStartCap } from './startPositions';
import { useAds } from '../ads/AdsProvider';
import { ChainStartEditor } from './ChainStartEditor';
import { moduleFor } from '../games';
import { serverPhysics } from '../games/types';
import { selectStart, switchCategory, saveStart, deleteSavedStart, indexCategory, startSelectionLegal } from './startPositions';
import { useRoleSwap, useDismissable } from './useRoleSwap';
import { RoleSwapBar } from './RoleSwapBar';
import { SupporterBadge } from './SupporterBadge';
import { BadgeMarks } from './BadgeMark';
import { Menu } from './Menu';
import { buildWords, teamLine } from './robotLabels';
import { RobotCard } from './RobotCard';
import { gameServers, lanActive, multiServer, roomServerUrl, roomServerUrlWith, selectedServer } from '../net/env';
import { roomJoinRegion } from '../net/roomRegion';
import { takePendingLanRoom } from '../lan/pending';
import type { ResumedRoom } from './roomReturn';
import { WebSocketTransport, type Transport } from '../net/transport';
import { LobbyClient, type MatchStart } from '../net/lobbyClient';
import { ServerSession } from '../net/serverSession';
import { roomCapacity, type LobbyPlayer, type QueueMode, type RoomConfig, type ErrorCode } from '../net/protocol';
import type { NetSession } from '../net/session';
import { useServerNotice } from '../net/notice';
import { generateRoomCode, normalizeRoomCode, isValidRoomCode, ROOM_CODE_LENGTH } from '../net/roomCode';
import { ConsoleHead } from './ConsoleHead';
import { useEscape } from './useEscape';
import { DISCORD_REGION } from '../net/discordActivity';
import { serverCaps } from '../net/api';
import { activeZenithAuto } from '../auto/library';
import { announcePhysicsReady, preloadRoomPhysics } from '../net/roomPhysics';
import { preloadRoomView } from '../net/roomView';
import { MatchStrategy } from './MatchStrategy';
import { botLabel } from './MatchSetup';
import type { RoomInvite } from '../net/api';
import { FriendsPanel, type RoomInviteTarget } from './FriendsPanel';
import { copyText } from './copyText';

interface Props {
  settings: GameSettings;
  onSettingsChange: (s: GameSettings) => void;
  onStart: (session: NetSession) => void;
  onCancel: () => void;
  /** what this room runs. Default: a versus custom room (2v2). Pass a record/duo
   * config to run this same lobby as a 2v0 co-op record run (opponent-free). */
  config?: RoomConfig;
  /** is SOME account signed in — friends invitations need an account on both ends */
  signedIn?: boolean;
  /** Saved DSIM display name, never the immutable auth-provider name. */
  displayName?: string | null;
  /** Account context forwarded into the persistent room friends panel. */
  myUserId?: string | null;
  onOpenProfile: (username: string) => void;
  onJoinInvite: (invite: RoomInvite) => void;
  onSpectate: (room: string, region?: string) => void;
  /**
   * A LIVE SOCKET COMING BACK FROM A FINISHED MATCH, rather than a code to dial.
   *
   * The host recycled the room: the server cleared its world, kept everyone's seat, and
   * told each client so. This screen adopts that connection instead of joining — see
   * `ResumedRoom`. Consumed once, on mount.
   */
  resume?: ResumedRoom;
  /** a room code to join automatically on mount (a friend's invite, clicked
   * from elsewhere in the app) — calls the exact same `join()` a manual code
   * entry does, just triggered once at mount instead of by a button click. */
  autoJoin?: string;
  /**
   * WHICH MACHINE that room is on (the host's region).
   *
   * A custom room code is bare — no `<region>-` prefix for the proxy to route on — so
   * connecting without this lands on whichever machine is nearest to US. When the two
   * players had picked different servers that machine had no such room and made an empty
   * one with the same code: two lobbies, one code, and no error anywhere. Absent ⇒ an older
   * invite, which falls back to our own pick.
   */
  autoJoinRegion?: string;
  /** fired once `autoJoin` has been consumed, so the caller can clear its
   * one-shot pending state and a later normal visit doesn't re-trigger it */
  onAutoJoinConsumed?: () => void;
  /** running as a Discord Activity — surfaces the in-room name / robot-name editor
   * (the activity auto-join skips the entry screen that normally collects them).
   * Passed from App (captured stably at page load); NOT re-derived here, because
   * SPA navigation strips the `?instance_id=` query the localhost detection reads. */
  discordActivity?: boolean;
  /** the Discord Activity group (instance id) to tag a created room with, so it
   * appears in this activity's lobby browser. '' / undefined ⇒ untagged. */
  group?: string;
  /**
   * A name typed on a screen BEFORE this one (the LAN Play entry card), handed over the
   * same one-shot way `autoJoin` is. Checked ahead of the ordinary `displayName ??
   * settings.spec.teamName` default so it actually takes — writing it into
   * `settings.spec.teamName` instead would silently lose to a signed-in `displayName`.
   */
  initialName?: string;
}

type Phase = 'entry' | 'connecting' | 'room' | 'error';

/**
 * WHAT A NAMELESS SEAT IS CALLED ON THE WIRE — and nothing else.
 *
 * These are the server's own coercion defaults, and they used to be the INITIAL VALUE of
 * the two name boxes. Signed out and auto-joined (every Discord participant: auth is
 * CSP-blocked in the embed, so `displayName` is always null and a fresh `settings.spec`
 * carries `teamName: ''`), that put the literals in the fields — four roster rows reading
 * "Player" driving "My Robot · —", with the one editor that could fix it looking already
 * filled in. They are PLACEHOLDERS now: the box starts empty, and the fallback is applied
 * where it belongs, on the frame that advertises the seat.
 */
const DEFAULT_DRIVER_NAME = 'Player';
const DEFAULT_ROBOT_NAME = 'My Robot';

/** how long a connect may take before this screen says it is still trying. `LobbyClient`
 *  reports nothing between "socket opened" and "retry budget exhausted" (~48 s), so
 *  without this the button simply sat disabled through a server restart that then healed. */
const SLOW_CONNECT_MS = 5000;
/**
 * HOW LONG THE AUTO-JOIN PANEL WAITS BEFORE TRYING A MID-MATCH ROOM AGAIN.
 *
 * The server's `in_progress` refusal is the one that ends by itself, so the screen waits it
 * out instead of handing the player a button and a dead end. A match plus its results screen
 * is minutes long, so this is a poll, not a countdown to anything — 10 s is the same order as
 * the lobby browser's 3 s list poll and costs one socket per attempt.
 */
const IN_PROGRESS_RETRY_S = 10;
/** debounce on writing the Discord identity back to `settings.spec` (see the effect) */
const IDENTITY_SAVE_MS = 500;

/** The lobby is a full-screen surface, so it cannot use AppShell's side panel.
 * Keep the actual room UI and the shared FriendsPanel as siblings here instead.
 * Exported: `LanPanel` bypasses AppShell the same way and reuses this exact wrapper
 * rather than duplicating it. */
export function RoomFriendsLayout({
  children,
  signedIn,
  myUserId,
  onOpenProfile,
  onJoinInvite,
  onSpectate,
  room,
}: {
  children: ReactNode;
  signedIn: boolean;
  myUserId?: string | null;
  onOpenProfile: (username: string) => void;
  onJoinInvite: (invite: RoomInvite) => void;
  onSpectate: (room: string, region?: string) => void;
  room?: RoomInviteTarget;
}) {
  return (
    <div className="ds-room-layout">
      {children}
      <FriendsPanel
        signedIn={signedIn}
        myUserId={myUserId}
        onOpenProfile={onOpenProfile}
        onJoinInvite={onJoinInvite}
        onSpectate={onSpectate}
        room={room}
        allowProfileNavigation={!room}
      />
    </div>
  );
}

/**
 * Multiplayer lobby over the authoritative game server (Phase 0): join a room by
 * code, pick alliance / start pose, ready up, and — when the host starts — the
 * server authors the match and everyone receives `matchStart`, at which point we
 * mint a ServerSession that TAKES OVER the same socket. No WebRTC mesh, no
 * presence: the server is the single source of truth for the roster and host, so
 * one client can never stall the others.
 */
export function Lobby({
  settings,
  onSettingsChange,
  onStart,
  onCancel,
  config = { kind: 'versus' },
  signedIn = false,
  displayName,
  myUserId,
  onOpenProfile,
  onJoinInvite,
  onSpectate,
  resume,
  autoJoin,
  autoJoinRegion,
  onAutoJoinConsumed,
  discordActivity = false,
  group = '',
  initialName,
}: Props) {
  const isRecord = config.kind === 'record';
  const capacity = roomCapacity(config);
  const [phase, setPhase] = useState<Phase>('entry');
  const [code, setCode] = useState('');
  // entry sub-mode: pick whether you're creating a fresh room or joining a code
  const [entryMode, setEntryMode] = useState<'create' | 'join'>('create');
  /**
   * THIS SCREEN WAS NEVER AN ENTRY FORM FOR THIS VISIT.
   *
   * An auto-join — a Discord activity launch, a friend's invite, a rejoin of a recycled
   * room — has no code to type and no room to create, but it rendered the "Custom room"
   * form anyway: a "Your name" field, a New room / Have a code toggle, and a disabled CTA
   * reading **CREATING…** while it was in fact joining the group's shared lobby. The
   * damage was worst in the ERROR state, where every control came back live and the
   * obvious button — CREATE ROOM — mints a fresh random room AWAY from the group.
   *
   * Seeded from the prop rather than set by the auto-join effect, so the form is not
   * painted for one frame before the effect runs.
   */
  const [autoEntry] = useState(!!autoJoin || !!resume);
  /** the connect is slow enough to need saying so: `SLOW_CONNECT_MS`, or the transport
   *  telling us it dropped and is retrying. */
  const [slowConnect, setSlowConnect] = useState(false);
  /**
   * THE ROOM'S PHYSICS IS NOT A CHOICE ANY MORE (owner ruling, 2026-09-18).
   *
   * There was a 3D/2D picker here, on the create side, because `RoomConfig.physics` was the
   * host's to set. It is not: every server-connected match of a game that can step 3D runs 3D
   * (`serverPhysics`, and `Room.physics` enforces it), so a picker offered a choice the server
   * would overrule and an answer — "2D" — whose runs could reach the record board. The 2D
   * pipeline stays available where it does not reach a board: solo practice and free drive,
   * through `GameSettings.practicePhysics`.
   *
   * `physicsOffered` survives as the predicate for the ONE LINE that replaces it, and for the
   * value below.
   */
  const roomGame = config.game ?? settings.game;
  const physicsOffered = serverPhysics(moduleFor(roomGame)) === '3d';
  /**
   * THE ROOM IS STARTING AND A SEAT IS STILL LOADING ITS 3D PHYSICS (`strategyStart` with
   * `ranked: false` — `Room.enterCustomStart`).
   *
   * Its own state rather than a `Phase`: the phase machine is about getting INTO a room and
   * this is about leaving one for a match, and every `phase === 'room'` branch below would
   * have had to learn about it.
   */
  const [starting, setStarting] = useState<{ deadline: number; mode: QueueMode } | null>(null);
  const [copied, setCopied] = useState(false);
  // One app, several regions: a shared room code only lands two people on the same machine
  // if they connect to the same one. JOINING an invite, that is not a choice — it is
  // wherever the host already is, and offering a picker there was the bug. Creating a room,
  // it is our own pick.
  //
  // THE HOST'S REGION IS AN ARGUMENT TO `join`, NOT JUST THIS SEED. Seeding it here alone
  // was wrong twice over: this screen is often ALREADY MOUNTED when an invite is accepted
  // (its own flyout carries an Accept button), so `useState` never re-read the new value and
  // the join went to whatever server WE had picked; and the flyout's accept path never had
  // the region to begin with. This state is now only the DEFAULT for a room we create, and
  // the value a join actually used, so the picker can show it.
  const [region, setRegion] = useState(autoJoinRegion || selectedServer()?.region || '');
  // the region came from an INVITE, so it is the host's and not ours to change
  const [regionLocked, setRegionLocked] = useState(!!autoJoinRegion);
  const [name, setName] = useState(initialName || (displayName ?? settings.spec.teamName) || '');
  const [players, setPlayers] = useState<LobbyPlayer[]>([]);
  const [hostId, setHostId] = useState('');
  /**
   * BOT SEATS (plan §6). Two independent conditions, and the control needs both:
   *  · the GAME has an AI driver at all (`GameSimModule.bot`), which is a fact about the build;
   *  · the SERVER understands `addBot` (`SERVER_CAPS` `'bots'`), which is a fact about the
   *    deploy. One Fly app serves every client version, so a new client can be talking to a
   *    server that predates the message — and that server IGNORES it rather than refusing, so
   *    an ungated button would be pressed and do nothing at all. Same shape, same reason, as
   *    the rated challenge formats' `'party'` gate.
   * Until the capability read lands this is false, so the button appears a beat late rather
   * than under a cursor already moving toward it.
   */
  const botTiers = moduleFor(roomGame).bot?.tiers;
  const [serverBots, setServerBots] = useState(false);
  useEffect(() => {
    let alive = true;
    void serverCaps().then((c) => {
      if (alive) setServerBots(c.includes('bots'));
    });
    return () => {
      alive = false;
    };
  }, []);
  /** the tier the host's next "Add a bot" seats. Remembered for the session only: it is a
   *  property of the room being set up, not of the account. */
  const [botTier, setBotTier] = useState<string>(() => moduleFor(roomGame).bot?.defaultTier ?? '');
  const [myId, setMyId] = useState('');
  // block starting a custom match while a server restart is scheduled
  const notice = useServerNotice();
  const restartPending =
    !!notice && notice.kind === 'restart' && (notice.until === undefined || notice.until > Date.now());
  const [error, setError] = useState('');
  /**
   * Machine-readable reason for `error`, when the server gave one — the refusals this screen
   * can do something about rather than just read back: `region_full` (pick another region,
   * where there is more than one), `in_progress` (the room is mid-match, so wait it out — see
   * the retry effect) and `game_mismatch` (the room runs another season).
   *
   * ⚠️ CLEARED BY `join()`, not only set here. A stale code outlives the error it explained:
   * a retry that fails for an unrelated reason would otherwise still be captioned "a match is
   * running in this lobby", and the retry effect would keep firing on a refusal that never
   * ends. An older server sends no code at all, so `undefined` must stay the ordinary case.
   */
  const [errorCode, setErrorCode] = useState<ErrorCode | undefined>(undefined);
  /** seconds until the `in_progress` retry below fires; 0 when nothing is scheduled */
  const [retryIn, setRetryIn] = useState(0);
  // the full builder, opened from the room over the top of it (see below)
  const [building, setBuilding] = useState(false);

  const lobbyRef = useRef<LobbyClient | null>(null);
  const startedRef = useRef(false);
  /** the room said no (an `error` frame) — a close that follows is the same event, not a new one */
  const refusedRef = useRef(false);
  /** `phase` for the handlers `wire` registers once, which would otherwise read the render that connected */
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const nameEditedRef = useRef(false);
  // which room code the auto-join effect below has already fired for (value-keyed,
  // not a one-shot boolean, so accepting a DIFFERENT invite while mounted rejoins).
  // Reset in the teardown cleanup — see the auto-join effect for why.
  const autoJoinedRef = useRef<string | null>(null);

  // tear down on unmount unless a match started (which hands the socket onward)
  useEffect(() => {
    return () => {
      if (!startedRef.current) lobbyRef.current?.dispose();
      // The socket is gone, so the guard must clear too: React StrictMode (dev)
      // mount→unmount→remounts this screen, disposing the mid-handshake socket
      // here, and the remount's auto-join must be free to reconnect (a stuck
      // guard left the lobby on "connecting" forever — WS close 1006). Resetting
      // HERE, paired with disposal, means a same-room re-invite while STILL
      // mounted (no unmount, socket alive) keeps its value-keyed guard and is
      // correctly swallowed instead of orphaning the live socket.
      autoJoinedRef.current = null;
    };
  }, []);

  /**
   * FETCH THE 3D PHYSICS WHILE THE PLAYER IS STILL TYPING A ROOM CODE.
   *
   * Every server room of a 3D season holds its start until each seat's chunks have landed
   * (`READY3D_CAP`), so the only thing that keeps that wait at zero is asking for them before
   * the room exists — a code entry screen is one of the few places in this app where a player
   * spends seconds doing nothing else. A no-op for DECODE and Chain Reaction.
   */
  useEffect(() => {
    void preloadRoomPhysics(roomGame);
    preloadRoomView(roomGame);
  }, [roomGame]);

  useEscape(onCancel); // Esc leaves the lobby, same as ← Back

  // The other half of the connecting signal: the FIRST attempt neither drops nor opens for
  // a while (a cold Fly machine, a suspended iframe waking up), and `onDown` above fires
  // only once the attempt has actually failed.
  useEffect(() => {
    if (phase !== 'connecting') return;
    const t = setTimeout(() => setSlowConnect(true), SLOW_CONNECT_MS);
    return () => clearTimeout(t);
  }, [phase]);

  /**
   * WHERE THE "You" CARD SITS IS DECIDED ONCE, AT MOUNT.
   *
   * It belongs ABOVE the roster for somebody who has never named themselves — four rows
   * reading "Player" driving "My Robot · —" are unattributable, and an unprompted editor
   * below them is not read — and below it once they have, where it is a rarely-touched
   * setting. Deciding it per render instead would move a section out from under the cursor
   * on the first keystroke typed into it.
   */
  const [idFirst] = useState(
    () => discordActivity && !(initialName || displayName || settings.spec.teamName),
  );

  // The profile request may resolve after this screen mounts. Adopt the saved
  // DSIM display name while the player is still choosing a room, but never erase
  // a deliberate room-only name edit or mutate identity after joining.
  useEffect(() => {
    if (displayName && phase === 'entry' && !nameEditedRef.current) setName(displayName);
  }, [displayName, phase]);

  const me = players.find((p) => p.clientId === myId) ?? null;
  const isHost = myId !== '' && myId === hostId;
  const allReady = players.length > 0 && players.every((p) => p.ready);
  // my active start pose must be legal for my chassis to ready up (a pose authored
  // for a different-sized robot would otherwise be silently relocated at spawn)
  // DECODE gates on G304, CR on G04 Lab-Area containment.
  const startLegal = !me || startSelectionLegal(settings.game, me.spec, me.alliance, me.startPose);
  // the saved-pose cap a game's own start editor is handed (it cannot read the ads context itself)
  const maxSaved = savedStartCap(useAds().supporter);
  // a duo record run needs BOTH drivers present before it can start (it's 2v0);
  // versus custom rooms can start with fewer (1v1, etc.)
  const enoughPlayers = !isRecord || players.length >= capacity;
  const canStart = allReady && enoughPlayers && !restartPending;

  /**
   * ⚠️ THE ROOM CODE IS AN ARGUMENT, NEVER THE `code` STATE.
   *
   * This handler is registered ONCE, inside `wire`, so it closes over the render that
   * connected — and for a room we CREATED that render had not seen `setCode` yet, because
   * `createRoom` mints the code and joins in the same tick. So `code` read '' and the
   * session was built with no room at all: silently, since everything that needs it is a
   * capability rather than a step. The rejoin record (`beginSession` skips a session with
   * no `room`) and the way back to the room's own lobby both went missing for exactly the
   * player who made the room. Same discipline as `Lobby.join`'s region argument.
   */
  function handleStart(m: MatchStart, roomCode: string): void {
    const lobby = lobbyRef.current;
    if (!lobby) return;
    startedRef.current = true;
    // pass the identity + room so the session can reclaim its slot on a reconnect
    onStart(new ServerSession(lobby.transport, lobby.isHost(), m, lobby.clientId, roomCode, false, lobby.seatToken));
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

  /**
   * Join `roomCode`, on `hostRegion` when the caller knows it.
   *
   * `hostRegion` is WHERE THE ROOM IS and it always wins over our own pick, because a custom
   * room code is bare — unlike a matchmaker-staged `iad-abc123` there is nothing in it for
   * the proxy to route on. Connect without it and Fly's anycast lands us on the machine
   * NEAREST TO US, which has no such room and cheerfully opens an empty one with the same
   * code: two lobbies, one code, both sides waiting, and no error anywhere.
   *
   * Passing it as an ARGUMENT rather than reading the `region` state is the fix: every path
   * that knows the host's region now hands it to the one function that opens the socket, so
   * it cannot be lost by a screen that was already mounted or by a caller that only had the
   * code. Undefined/empty ⇒ we genuinely do not know (an invite from before the region was
   * recorded), and falling back to our own pick is the old behaviour.
   */
  function join(roomCode: string, hostRegion?: string | null): void {
    if (!roomCode) return;
    setCode(roomCode);
    refusedRef.current = false;
    setSlowConnect(false);
    setErrorCode(undefined); // this attempt's refusal is not the last one's — see `errorCode`
    /**
     * A TAB-HOSTED LAN ROOM ARRIVES ALREADY CONNECTED.
     *
     * Every other room here is named by a URL and opened with a `WebSocketTransport`. A WebRTC
     * LAN room has no URL — the handshake happened on the LAN screen and what it produced is a
     * live `Transport` — so the lobby adopts that instead of dialling. Taken (not read), so a
     * remount cannot pick up a connection the player has already left: see `src/lan/pending.ts`.
     *
     * Everything below this point is the ordinary room flow, unchanged. That is the whole
     * point of the seam — the lobby does not know or care that its far end is another laptop.
     */
    const adopted = takePendingLanRoom();
    if (!adopted && !roomServerUrl()) {
      setError('Couldn’t open a custom room: this build has no game server.');
      setPhase('error');
      return;
    }
    setPhase('connecting');
    // route both players to the same region so a shared code lands on one machine.
    // In a Discord Activity, PIN to one fixed region regardless of who is nearest:
    // the `/gs` proxy is anycast, so without this two participants of the same
    // activity in different regions would open two rooms under one code and never
    // meet (see DISCORD_REGION). Otherwise follow the host's region (custom rooms).
    const useRegion = group ? DISCORD_REGION : roomJoinRegion(hostRegion, region);
    if (hostRegion) {
      setRegion(hostRegion);
      setRegionLocked(true);
    }
    // ROOMS are the one thing that may be hosted on a LAN box, so this is the one
    // connect site that follows a LAN connection (`roomServerUrl`, not `gameServerUrl`).
    // A region hint means nothing to a single machine with no proxy, and is harmless.
    let transport: Transport;
    if (adopted) {
      transport = adopted.transport;
    } else {
      // In a Discord Activity, PIN to DISCORD_REGION even without a multi-server
      // picker (the `/gs` proxy is anycast); otherwise only hint a region when a
      // picker is configured.
      const url =
        useRegion && (group || multiServer()) ? roomServerUrlWith({ region: useRegion }) : roomServerUrl();
      try {
        transport = new WebSocketTransport(url);
      } catch {
        setError('Couldn’t reach the game server.');
        setPhase('error');
        return;
      }
    }
    // tag the room with the Discord Activity group (if any) so it shows in this
    // activity's lobby browser. The server only applies it when CREATING the room;
    // an existing room keeps its creator's group.
    wire(transport, roomCode).join(roomCode, myPlayer(), roomConfig(), group || undefined);
  }

  /** the player fields this client advertises — the same on a fresh join and on a resume.
   *  An untyped name becomes the literal HERE, not in the box the player is looking at. */
  function myPlayer(): Omit<LobbyPlayer, 'clientId'> {
    return {
      name: name.trim() || DEFAULT_DRIVER_NAME,
      teamName: settings.spec.teamName,
      teamNumber: settings.spec.teamNumber,
      // record runs are opponent-free (one alliance) — force blue, matching the server
      alliance: isRecord ? 'blue' : settings.alliance,
      startIndex: settings.startIndex,
      startPose: settings.startPose ?? null,
      ready: false,
      spec: settings.spec,
      assists: settings.assists,
    };
  }

  /** carry the selected game so the room builds the right world (defaults to the caller's
   *  config game if it pinned one, else the player's setting) */
  function roomConfig(): RoomConfig {
    return {
      ...config,
      game: config.game ?? settings.game,
      /**
       * ⚠️ STILL SENT, THOUGH THIS SERVER IGNORES IT — and that is the point.
       *
       * A current server decides a room's physics itself (`Room.physics`). An OLDER one does
       * not: it reads this field and defaults it to `'2d'`, so a new client that stopped
       * sending anything would open a silent 2D BIOBUZZ room on a server one deploy behind and
       * put its runs on the board. One Fly app serves every client version, so saying `'3d'`
       * out loud is what makes both servers build the same room.
       *
       * OMITTED for a game with no 3D solve, which keeps a DECODE or Chain Reaction join
       * byte-identical to what it was before Day 2 — `physics: '2d'` and nothing mean the same
       * thing, and nothing is what the wire has always carried.
       */
      physics: physicsOffered ? '3d' : undefined,
    };
  }

  /**
   * Attach this screen to a transport. Split out of `join` so the two ways INTO a room —
   * dialling a code, and adopting the socket a recycled room handed back — share one set of
   * handlers rather than drifting apart. The difference between them is only the frame sent
   * afterwards: `join` for a seat we do not have, `resume` for one we already do.
   */
  function wire(transport: Transport, roomCode: string): LobbyClient {
    const lobby = new LobbyClient(transport);
    lobbyRef.current = lobby;

    /**
     * SAY THAT IT IS STILL TRYING.
     *
     * `LobbyClient` subscribes to `onMessage` and `onFail` only, so between "socket
     * dropped" and "retry budget exhausted" — 40 attempts at 1000–1400 ms, about 48
     * seconds — nothing at all reached this screen and the CTA simply sat disabled. A
     * restart shorter than the budget self-heals, so the COMMON case was an unexplained
     * freeze that then worked, not the terminal error. The in-match `ServerSession` has
     * wired `onDown` for exactly this since Phase 1; the lobby layer never did.
     *
     * `onDown` is free to take here: the lobby layer never registers it, and
     * `ServerSession` replaces it when it takes the socket over — by which point this
     * screen has handed off and unmounted.
     */
    transport.onDown(() => setSlowConnect(true));

    lobby.on('roster', (list, host) => {
      setPlayers(list);
      setHostId(host);
      setMyId(lobby.clientId);
      setSlowConnect(false); // whatever it was, we are talking to the room again
      setError(''); // an in-room refusal (see 'error') is answered by the room moving on
      setPhase((p) => (p === 'connecting' ? 'room' : p));
    });
    lobby.on('matchStart', (m) => handleStart(m, roomCode));
    /**
     * THE ROOM IS STARTING BUT A SEAT IS STILL LOADING (owner request, 2026-09-22).
     *
     * A custom room only ever sends this with `ranked: false` — it opened its own window
     * after the host pressed START. The ranked branch is not reachable from this screen, and
     * ignoring an unexpected one is the right failure: `matchStart` still follows and the
     * lobby is what the player is looking at meanwhile.
     */
    lobby.on('strategyStart', (deadline, _slot, m, _intros, isRanked) => {
      if (!isRanked) setStarting({ deadline, mode: m });
    });
    lobby.on('error', (msg, code) => {
      // ⚠️ ONLY A REFUSAL AT THE DOOR marks the socket refused. In the room it is a message
      // (a START refused on readiness, a restart pending) and the socket stays seated, so a
      // drop later in the room is still a lost connection and must be said as one.
      if (phaseRef.current !== 'room') refusedRef.current = true;
      setError(msg);
      setErrorCode(code);
      /**
       * ⚠️ A REFUSAL WHILE WE ARE ALREADY IN THE ROOM IS A MESSAGE, NOT A SCREEN.
       *
       * `'error'` is terminal here: the room UI only renders at `phase === 'room'` and the
       * roster handler promotes only FROM `'connecting'`, so nothing brings it back. That
       * was survivable while every error arrived at the door — but the server now refuses a
       * START whose roster is not all-ready, and losing that race is ordinary (somebody
       * toggles ready off as the host clicks). Replacing the lobby with an error screen threw
       * the host out of the room they were still seated in, onto a form whose obvious button
       * makes a NEW room away from their friends. In-room refusals stay inline.
       */
      setPhase((p) => (p === 'room' ? p : 'error'));
      // THE REGION IS FULL, NOT BROKEN. This is the one error with a specific action
      // attached — the same code is hostable somewhere else — so the picker has to be
      // reachable to take it. Joining via a host region LOCKS the picker (both players
      // must land on one machine), and leaving it locked here would show someone an
      // instruction they cannot follow.
      if (code === 'region_full') setRegionLocked(false);
    });
    lobby.on('closed', () => {
      /* A REFUSAL IS NOT A LOST CONNECTION. A tab-hosted LAN room sends its `error` frame
         ("Room is full…", "That code is for a different game mode.") and then closes the
         link a beat later — there is nothing else to keep it open for — and this handler
         used to overwrite the sentence that explained the refusal with one that blamed the
         network. The cloud keeps its socket open after a refusal, which is why it never
         showed. The first thing said stands. */
      if (!startedRef.current && !refusedRef.current) {
        setError('Lost connection to the game server.');
        setPhase('error');
      }
    });

    // SAY WHEN THIS SEAT'S 3D CHUNKS LAND. Latched inside the client and re-sent behind every
    // reconnect's join frame, so once here is enough — and it is here rather than beside each
    // `join`/`resume` because `wire` is the one place both of them pass through.
    announcePhysicsReady(lobby, roomGame);
    // THIS PLAYER'S ZENITH AUTO (custom rooms only; docs/area/autos.md): the one on in
    // Configure ▸ Match ▸ Autonomous, sent once the server says it can play it. Latched in the
    // client like the readiness above, so a reconnect re-sends it. A record run never sends one.
    if (!isRecord && moduleFor(roomGame).zenithAutos) {
      void serverCaps().then((caps) => {
        if (!caps.includes('zenithAuto')) return;
        const active = activeZenithAuto(roomGame);
        lobby.setZenithAuto(active ? { auto: active.auto, ...(active.waypoints ? { waypoints: active.waypoints } : {}) } : null);
      });
    }
    return lobby;
  }

  /**
   * COME BACK FROM A FINISHED MATCH INTO THE ROOM WE NEVER LEFT.
   *
   * Straight to `'room'` when the handed-over socket is still open: there is nothing to
   * connect, because it is the one that just played the match. The region is the host's by
   * definition — it is where the room IS — so the picker locks as it does for an invite.
   *
   * ⚠️ AND A PLAIN JOIN WHEN IT IS NOT. The socket can be gone by the time this runs: it is
   * closed on the way out of any lobby that did not start a match, and React's development
   * StrictMode exercises exactly that (mount → cleanup → mount) on this screen's own
   * teardown effect. Re-joining BY CODE is the honest recovery and not a workaround — the
   * room is a lobby again, so `canJoin` is true again, which is the whole point of the
   * recycle. It costs one reconnect and lands in the same place.
   *
   * Deliberately NOT guarded by a ref: a ref survives that simulated unmount, so a guarded
   * effect would skip the second pass and leave the screen holding a closed socket.
   */
  useEffect(() => {
    if (!resume) return;
    setCode(resume.code);
    if (resume.region) {
      setRegion(resume.region);
      setRegionLocked(true);
    }
    if (!resume.transport.isOpen) {
      join(resume.code, resume.region);
      return;
    }
    setPhase('room');
    setMyId(resume.clientId);
    wire(resume.transport, resume.code).resume(resume.code, myPlayer(), resume.clientId, resume.seatToken, roomConfig(), group);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resume]);

  // Auto-join when a friend's invite / Discord Activity carried a room code — the same
  // `join()` a manual code entry calls, just triggered without a button click, and carrying
  // the host's region.
  //
  // Keyed on the CODE, not a one-shot boolean. This screen stays mounted while you accept a
  // second invite from its own flyout, and a `useRef(false)` that was already true swallowed
  // that accept entirely: the click did nothing at all. The guard is reset only when the
  // socket is torn down (the teardown effect above), so a StrictMode remount reconnects but
  // a same-room re-invite while still mounted stays swallowed.
  useEffect(() => {
    if (autoJoin && autoJoinedRef.current !== autoJoin) {
      autoJoinedRef.current = autoJoin;
      join(autoJoin, autoJoinRegion);
      onAutoJoinConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoJoin]);

  /**
   * THE ONE REFUSAL THAT ENDS BY ITSELF — so wait it out instead of asking the player to.
   *
   * `in_progress` means the room is fine and mid-match. Everywhere else that is a shrug and a
   * fresh room code; in a Discord activity it is a wall, because the room code is DERIVED FROM
   * THE INSTANCE and is the same on every re-entry for everybody in the voice channel. The
   * server's signed-out seat hold lapses after 45 s, and a room only becomes joinable again
   * when its host recycles it — which may be minutes after the match, and never if the host is
   * the one who dropped. So a phone that backgrounded the iframe came back to a refusal that,
   * as far as the player could tell, was permanent.
   *
   * The loop is the effect itself, not a timer chain: `join()` moves `phase` to `'connecting'`,
   * which tears this down, and the next refusal moves it back to `'error'`, which re-arms it.
   * That also means it CANNOT spin — the moment the room admits us, or refuses us for any
   * other reason, `errorCode` is no longer `'in_progress'` and nothing re-arms.
   *
   * Auto-join only. A player who typed a code chose this room this second and is looking at a
   * button; one who was placed here by the activity has no button worth pressing.
   */
  useEffect(() => {
    /**
     * ⚠️ THE ACTIVITY ONLY. `autoJoin` is also how a friend's INVITE and a challenge land on
     * this screen on the web, and those players have a code box, a Modes screen and a back
     * button — they do not need a timer re-dialling for as long as the tab is open. In the
     * embed there is nowhere else to go, which is the whole reason this exists.
     */
    if (!group || !autoEntry || phase !== 'error' || errorCode !== 'in_progress') return;
    setRetryIn(IN_PROGRESS_RETRY_S);
    const tick = setInterval(() => setRetryIn((s) => (s > 0 ? s - 1 : 0)), 1000);
    const again = setTimeout(() => {
      // ⚠️ DROP THE REFUSED SOCKET FIRST. `join()` builds a fresh transport and client and
      // only the UNMOUNT disposes the old one, so a timer that fires every 10 s for the
      // length of a match left a live socket behind on each pass — the server holds a
      // refused connection open, so they accumulate against the game server.
      lobbyRef.current?.dispose();
      join(code, autoJoinRegion);
    }, IN_PROGRESS_RETRY_S * 1000);
    return () => {
      clearInterval(tick);
      clearTimeout(again);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group, autoEntry, phase, errorCode, code]);

  const setAlliance = (alliance: Alliance): void => lobbyRef.current?.update({ alliance });
  const toggleReady = (): void => lobbyRef.current?.update({ ready: !me?.ready });

  // Discord-only in-room identity editing: the driver name + robot name are chosen
  // on the entry screen, but an activity auto-join skips it — so let them be edited
  // here too. Local state drives the inputs (no cursor jank from roster round-trips);
  // a short debounce echoes an `update` patch the server sanitizes + re-broadcasts.
  // Echo-only (not persisted to `settings`): this is a per-match name, not a change
  // to the saved robot. Fallbacks match the server's coercion defaults.
  const [robotName, setRobotName] = useState(settings.spec.name === DEFAULT_ROBOT_NAME ? '' : settings.spec.name);
  const nameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const robotTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editName = (next: string): void => {
    nameEditedRef.current = true; // don't let a late displayName adopt clobber it
    setName(next);
    if (nameTimer.current) clearTimeout(nameTimer.current);
    nameTimer.current = setTimeout(() => lobbyRef.current?.update({ name: next.trim() || DEFAULT_DRIVER_NAME }), 300);
  };
  const editRobotName = (next: string): void => {
    setRobotName(next);
    if (robotTimer.current) clearTimeout(robotTimer.current);
    robotTimer.current = setTimeout(() => {
      const base = me?.spec ?? settings.spec;
      lobbyRef.current?.update({ spec: { ...base, name: next.trim() || DEFAULT_ROBOT_NAME } });
    }, 300);
  };
  useEffect(
    () => () => {
      if (nameTimer.current) clearTimeout(nameTimer.current);
      if (robotTimer.current) clearTimeout(robotTimer.current);
    },
    [],
  );

  /**
   * AND IT SURVIVES A RE-ENTRY. The editor above was deliberately echo-only — a per-match
   * name, not a change to the saved robot — and the cost was that leaving and relaunching
   * the activity re-advertised "Player" again, so the one thing that makes a 2v2 roster
   * readable had to be retyped every time. Nobody in an embed is signed in, so
   * `settings.spec` is the only store there is, and it is exactly where the driver name is
   * read back from on the next mount (`displayName ?? settings.spec.teamName`).
   *
   * ONE TIMER FOR BOTH FIELDS. Two independent debounces each wrote the spec from the
   * render they were created in, so a robot name typed while a driver name was still
   * pending would write a spec the name edit had not landed in and drop it.
   *
   * ⚠️ `onSettingsChange` AND `settings` RIDE REFS. The setter is a fresh arrow every
   * render and App re-renders on its own every few seconds (the presence poll), so
   * depending on either would restart this debounce on a render nobody made — the same
   * trap the Controls screen's capture effects document.
   */
  const saveRef = useRef(onSettingsChange);
  saveRef.current = onSettingsChange;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  useEffect(() => {
    if (!discordActivity) return;
    const t = setTimeout(() => {
      const s = settingsRef.current;
      const driver = name.trim();
      const robot = robotName.trim() || DEFAULT_ROBOT_NAME;
      if (driver === s.spec.teamName && robot === s.spec.name) return;
      saveRef.current({ ...s, spec: { ...s.spec, teamName: driver, name: robot } });
    }, IDENTITY_SAVE_MS);
    return () => clearTimeout(t);
  }, [discordActivity, name, robotName]);

  /**
   * RE-PICK, in a custom room exactly as in the ranked strategy window.
   *
   * You bring whatever build you happened to have selected when you opened the
   * lobby, and until now the only way to change it was to leave the room, edit,
   * and re-share the code — which for the host means everybody else loses the
   * room too. Nothing about the server had to change for this: `case 'update'`
   * takes a sanitized `spec` patch from any room, re-clamps it to the build
   * limits, and clears `ready` if the new chassis makes your start pose illegal.
   *
   * Both halves ECHO TO THE SERVER as well as persisting locally: the roster row
   * is what the other drivers see and what the match is built from, so a swap
   * that only touched `settings` would show everyone the old robot and then spawn
   * the new one.
   */
  const pickSpec = (spec: RobotSpec): void => {
    onSettingsChange({ ...settings, spec });
    lobbyRef.current?.update({ spec, assists: settings.assists });
  };

  /** the full builder edits settings.spec live; mirror every change to the server */
  const onBuilderChange = (next: GS): void => {
    onSettingsChange(next);
    lobbyRef.current?.update({ spec: next.spec, assists: next.assists });
  };

  const mySpec = me?.spec ?? settings.spec;
  /** is this saved robot the one this seat is bringing? The chassis fields, as the swap row
   * has always compared them. */
  const isMine = (r: RobotSpec): boolean =>
    r.length === mySpec.length &&
    r.width === mySpec.width &&
    r.intake === mySpec.intake &&
    r.drivetrain === mySpec.drivetrain &&
    r.driveRpm === mySpec.driveRpm &&
    r.massLb === mySpec.massLb;

  // 2v2 ROLE + consent swap: first robot on the alliance = CLOSE, second = FAR;
  // either can propose a swap the other must accept (see useRoleSwap).
  const rs = useRoleSwap(
    players,
    me,
    (patch) => lobbyRef.current?.update(patch),
    settings.game,
    settings.audio.volume,
  );
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
  /**
   * In-room identity editing is DISCORD-ONLY: an activity auto-join skips the entry
   * screen's name field, so it is surfaced here. On web/Electron the entry screen already
   * collects both, so this stays hidden rather than being a redundant editor.
   *
   * Held as a value because it renders in one of TWO places — above the roster while the
   * player is still nameless, below it once they are not. See `idFirst`.
   */
  const youSection = discordActivity ? (
    <section className="ds-sec">
      <h2>You</h2>
      {/* not a restatement of the two labels: it says where the names GO, which is the
          reason to fill them in and the one thing the labels cannot say. */}
      {idFirst && <p className="ds-sub">Everyone else sees these on the roster and over your robot.</p>}
      <div className="ds-idedit">
        <label className="ds-field">
          <span className="cap">Your name</span>
          <input
            className="ds-input"
            value={name}
            onChange={(e) => editName(e.target.value)}
            maxLength={24}
            placeholder={DEFAULT_DRIVER_NAME}
          />
        </label>
        <label className="ds-field">
          <span className="cap">Robot name</span>
          <input
            className="ds-input"
            value={robotName}
            onChange={(e) => editRobotName(e.target.value)}
            maxLength={24}
            placeholder={DEFAULT_ROBOT_NAME}
          />
        </label>
      </div>
    </section>
  ) : null;

  const roomInviteTarget: RoomInviteTarget | undefined =
    phase === 'room'
      ? {
          code,
          game: config.game ?? settings.game,
          kind: config.kind,
          record: config.record,
          region: region || null,
        }
      : undefined;

  // A locked ROLE forces its category: if my active start is in the OTHER category
  // (carried in from single-player settings, or an old role before a swap/rejoin),
  // switch it to this role's remembered/default pick — never leave a FAR robot
  // sitting on a CLOSE spot (or vice-versa). Custom poses are categorized by
  // settings.startCat (what the locked editor writes when you pick one).
  useEffect(() => {
    if (!startRole || !me) return;
    const activeCat = me.startPose ? settings.startCat : indexCategory(me.startIndex, settings.game);
    if (activeCat !== startRole) applyStart(switchCategory(sCat, startRole));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startRole, me?.startIndex, me?.startPose, settings.startCat]);

  /**
   * THE ROOM IS STARTING AND SOMEBODY IS STILL LOADING — take over the screen with the same
   * alliance view ranked uses, minus the ratings a custom room has never had.
   *
   * Above the phase branches, because it outranks all of them: the seat is committed, the
   * host has pressed START, and the lobby's own controls (ready, start, add a bot, leave to
   * entry) would all be acting on a room that is no longer taking instructions.
   *
   * `onLeave` is the ordinary `onCancel` — leaving here is leaving the room, exactly as the
   * ← Back beside it has always been, and unlike ranked it forfeits nothing.
   */
  if (starting && lobbyRef.current) {
    return (
      <MatchStrategy
        lobby={lobbyRef.current}
        players={players}
        myClientId={myId}
        deadline={starting.deadline}
        mode={starting.mode}
        intros={[]}
        settings={settings}
        onSettingsChange={onSettingsChange}
        onLeave={onCancel}
        ranked={false}
      />
    );
  }

  /**
   * JOINING A ROOM SOMEBODY ELSE ALREADY NAMED — the screen an auto-join gets instead of
   * the entry form. Nothing interactive but ← Back, and, when the join is refused, one
   * button that retries THE SAME CODE rather than the CREATE ROOM that used to sit there
   * and mint a fresh room away from the group.
   *
   * Above the `entry` branch, not folded into it: the form's controls (a name field, the
   * New room / Have a code toggle, a region picker) all act on a room that is not being
   * chosen here, and every one of them had to be individually disabled to be honest.
   */
  if (autoEntry && phase !== 'room') {
    const joiningGroup = !!group;
    return (
      <RoomFriendsLayout
        signedIn={signedIn}
        myUserId={myUserId}
        onOpenProfile={onOpenProfile}
        onJoinInvite={onJoinInvite}
        onSpectate={onSpectate}
      >
        <div className="ds-console">
          <div className="ds-console-in narrow">
            <ConsoleHead onBack={onCancel} title={joiningGroup ? 'Discord lobby' : 'Custom room'} />
            <div className="ds-panel ds-panel-body stack">
              {phase === 'error' && errorCode === 'in_progress' ? (
                /* NOT AN ERROR, A QUEUE. The room is running a match and will open again on
                   its own, so this reads as a wait rather than a red line — and the waiting
                   is done for them (see the retry effect). The button is what somebody who
                   just watched the match end presses instead of sitting through the timer. */
                <>
                  <p className="ds-loading">A match is running in this lobby.</p>
                  <p className="ds-hint">
                    {/* the countdown runs only inside the activity (the retry effect); on the
                        web an invite has no timer, and "Trying again in 0s." would sit forever */}
                    You’ll be able to join when it finishes.{joiningGroup && ` Trying again in ${retryIn}s.`}
                  </p>
                  <div className="ds-actions">
                    <button
                      className="ds-cta"
                      onClick={() => {
                        lobbyRef.current?.dispose(); // the refused socket, as the retry effect does
                        join(code, autoJoinRegion);
                      }}
                    >
                      TRY NOW
                    </button>
                  </div>
                </>
              ) : phase === 'error' ? (
                <>
                  <p className="ds-form-err">⚠ {error}</p>
                  {/* The season is the client's own setting, so retrying this code fails
                      identically forever — the way out is the lobby browser, whose rows carry
                      each room's season and switch to it on the way in. ← Back is that door. */}
                  {errorCode === 'game_mismatch' && joiningGroup && (
                    <p className="ds-hint warn">
                      Go back and open this lobby from the list. It switches you to the season the
                      room is playing.
                    </p>
                  )}
                  <div className="ds-actions">
                    <button
                      className="ds-cta"
                      onClick={() => {
                        lobbyRef.current?.dispose();
                        join(code, autoJoinRegion);
                      }}
                    >
                      TRY AGAIN
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="ds-loading">{joiningGroup ? 'Joining the lobby…' : 'Joining the room…'}</p>
                  {slowConnect && (
                    <p className="ds-hint">
                      Still connecting to the game server. It keeps trying for about a minute.
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </RoomFriendsLayout>
    );
  }

  if (phase === 'entry' || phase === 'connecting' || phase === 'error') {
    return (
      <RoomFriendsLayout
        signedIn={signedIn}
        myUserId={myUserId}
        onOpenProfile={onOpenProfile}
        onJoinInvite={onJoinInvite}
        onSpectate={onSpectate}
      >
      <div className="ds-console">
        <div className="ds-console-in narrow">
          <ConsoleHead onBack={onCancel} title={isRecord ? 'Duo record run' : 'Custom room'} />
          <div className="ds-panel ds-panel-body stack">
            {/* THE ROOM LOOKS IDENTICAL EITHER WAY, so this screen has to say which it is.
                It is the last point before a socket is opened, and the consequence — the
                match will not be rated and will not reach a board — is the sort of thing
                that has to be said before, not discovered after. */}
            {lanActive() && (
              <p className="ds-hint warn">This room runs on your LAN server and isn’t ranked.</p>
            )}
            <label className="ds-field">
              <span className="cap">Your name</span>
              <input
                className="ds-input"
                value={name}
                onChange={(e) => {
                  nameEditedRef.current = true;
                  setName(e.target.value);
                }}
                maxLength={20}
                placeholder={DEFAULT_DRIVER_NAME}
              />
            </label>
            {/* no region picker on a LAN server: there is one machine, and offering a
                choice of where to put the room would be offering a choice that does not
                exist. */}
            {multiServer() && !lanActive() && (
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
            <div className="ds-opts two">
              <button
                className={`ds-opt ${entryMode === 'create' ? 'on' : ''}`}
                aria-pressed={entryMode === 'create'}
                onClick={() => setEntryMode('create')}
              >
                <span className="ot">New room</span>
              </button>
              <button
                className={`ds-opt ${entryMode === 'join' ? 'on' : ''}`}
                aria-pressed={entryMode === 'join'}
                onClick={() => setEntryMode('join')}
              >
                <span className="ot">Have a code</span>
              </button>
            </div>
            {/* WHAT IS LEFT OF THE PICKER: a statement, not a control. Every room runs the 3D
                physics, so the thing worth saying is the consequence for a machine that
                struggles with it — practice is where the 2D solve still lives. Shown on the
                create side only; a joiner is not choosing anything. */}
            {entryMode === 'create' && physicsOffered && (
              <p className="ds-hint">
                Online rooms run on the 3D physics, so everyone in the room loads it. Practice
                can still run on the 2D physics.
              </p>
            )}
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
            {phase === 'error' && (
              <>
                <p className="ds-form-err">⚠ {error}</p>
                {/* A FULL REGION IS NOT A FAILED CONNECTION, and saying so is the whole
                    point of the code: the room is fine, this machine is just at its
                    cap, and the fix is one control up the page.

                    ⚠️ GATED ON THE PICKER EXISTING, because it is pointing AT it. On a
                    single-server build — a LAN server, and every Discord activity, where
                    `parseServers()` collapses to one entry and the region is pinned to a
                    constant — "choose another region above" named a control that is not
                    rendered, so the one refusal with an action attached read as the one with
                    an impossible one. The server's own sentence already covers that case. */}
                {errorCode === 'region_full' && multiServer() && (
                  <p className="ds-hint warn">
                    Nothing is wrong with your connection. Choose another region above,
                    then try again. Whoever you are playing with needs to pick the same one.
                  </p>
                )}
                {/* the season is a home-page setting, not a room one, so this screen can only
                    say where it lives — retrying the code in place refuses identically. */}
                {errorCode === 'game_mismatch' && (
                  <p className="ds-hint warn">
                    Change the season on the home page, then join this code again.
                  </p>
                )}
              </>
            )}
            {/* the same signal the auto-join panel gets — a manual create/join froze on a
                disabled CTA for the whole retry budget too. */}
            {phase === 'connecting' && slowConnect && (
              <p className="ds-hint">
                Still connecting to the game server. It keeps trying for about a minute.
              </p>
            )}
            <div className="ds-actions">
              {entryMode === 'create' ? (
                <button className="ds-cta" disabled={phase === 'connecting'} onClick={createRoom}>
                  {phase === 'connecting' ? 'CREATING…' : 'CREATE ROOM'}
                </button>
              ) : (
                <button
                  className="ds-cta"
                  disabled={phase === 'connecting' || code.length !== ROOM_CODE_LENGTH}
                  onClick={joinWithCode}
                >
                  {phase === 'connecting' ? 'JOINING…' : 'JOIN ROOM'}
                </button>
              )}
            </div>
            {multiServer() && !regionLocked && (
              <p className="ds-hint">
                {isRecord
                  ? 'Your partner must pick the same region.'
                  : 'Everyone in the room must pick the same region.'}
              </p>
            )}
          </div>
        </div>
      </div>
      </RoomFriendsLayout>
    );
  }

  // full-builder takeover: the My Robot menu over the room, with a Done button back.
  // It replaces the room's UI, NOT the room — this is a render branch inside `Lobby`,
  // so the socket, the roster and the host's start all keep running behind it, and
  // every edit is mirrored to the server as you make it.
  if (building) {
    return (
      <RoomFriendsLayout
        signedIn={signedIn}
        myUserId={myUserId}
        onOpenProfile={onOpenProfile}
        onJoinInvite={onJoinInvite}
        onSpectate={onSpectate}
        room={roomInviteTarget}
      >
      <div className="ds-console">
        <div className="ds-console-in">
          <ConsoleHead onBack={() => setBuilding(false)} backLabel="← Done" />
          <Menu settings={settings} onChange={onBuilderChange} />
          <div className="ds-actions">
            <button className="ds-cta" onClick={() => setBuilding(false)}>
              DONE
            </button>
          </div>
        </div>
      </div>
      </RoomFriendsLayout>
    );
  }

  return (
    <RoomFriendsLayout
      signedIn={signedIn}
      myUserId={myUserId}
      onOpenProfile={onOpenProfile}
      onJoinInvite={onJoinInvite}
      onSpectate={onSpectate}
      room={roomInviteTarget}
    >
    <div className="ds-console">
      <div className="ds-console-in">
        <ConsoleHead onBack={onCancel} backLabel="← Leave" />
        <div className="ds-title">
          <h1>
            {isRecord ? 'Duo' : 'Room'} {code}
          </h1>
        {/* NOT centred: `.ds-console` is left-aligned throughout — the title, every
            `<h2>`, the roster and the action row all start at x=0 of the column — and
            this line was centred inside its own 64ch cap rather than the column, so it
            landed about a quarter of the way across and lined up with nothing. */}
        <p className="ds-sub ds-sub-row">
          <span>
            {isHost ? 'You are the host' : 'Waiting for the host to start'} · {players.length}/
            {capacity} drivers
          </span>
          <button
            className="ds-chip"
            // through `copyText`, and the tick only on a copy that actually happened:
            // this lobby is reachable over a plain-http LAN origin, where the Clipboard
            // API does not exist and the optional chain used to make this a no-op that
            // still said '✓ Copied'. Same story in a locked-down embed (the Discord
            // Activity iframe) — a blocked copy shows no tick, and the code is still
            // visible in the title.
            onClick={() =>
              copyText(code, (ok) => {
                if (!ok) return;
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              })
            }
          >
            {copied ? '✓ Copied' : 'Copy code'}
          </button>
        </p>
        </div>

        {idFirst && youSection}

        <section className="ds-sec">
          <h2>Drivers</h2>
          <div className="ds-players">
            {players.map((p) => {
              const isMe = p.clientId === myId;
              return (
                <div key={p.clientId} className={`ds-player ${p.alliance}`}>
                  <span className="pdot" />
                  {/* the badge TRAILS the whole name, as it does in `.fr-nameline`,
                      `.lb-name` and the career chip. Between the name and its "(you)"
                      suffix it read as "Alice ♥ (you)". */}
                  <span className="pnm">
                    {p.name}
                    {isMe ? ' (you)' : ''}
                    <SupporterBadge supporter={p.supporter} role={p.role} />
                    <BadgeMarks badges={p.badges} />
                  </span>
                  <span className="ptm">
                    {p.spec.name} · {p.teamNumber || '—'}
                  </span>
                  {/* A BOT SEAT IS NAMED AS ONE, beside the name and not inside it — the same
                      rule the supporter badge follows. Without it a roster row reading
                      "Medium bot · READY" is indistinguishable from a driver who picked that
                      name, and the difference is whether the match rates. */}
                  {p.bot && <span className="ds-chip">BOT</span>}
                  {/* the Zenith auto this driver's robot plays in AUTO (custom rooms) */}
                  {p.autoName && <span className="ds-chip">AUTO · {p.autoName}</span>}
                  {p.clientId === hostId && (
                    <span className="ds-chip on">HOST</span>
                  )}
                  <span className={`ds-chip ${p.alliance}`}>{p.alliance.toUpperCase()}</span>
                  <span className="ds-chip">
                    {p.startPose
                      ? 'CUSTOM'
                      : settings.game === 'chain'
                        ? (CHAIN_START_POSES[p.startIndex]?.name ?? '—')
                        : (moduleFor(settings.game).startAnchorName?.(p.startIndex, p.alliance) ??
                          START_POSES[p.startIndex]?.label ??
                          '—')}
                  </span>
                  <span className={`ds-chip ${p.ready ? 'on' : 'off'}`}>
                    {p.ready ? 'READY' : 'NOT READY'}
                  </span>
                </div>
              );
            })}
          </div>
          {/* ADD A BOT (plan §6) — host only, versus only, and only when both the game and the
              deploy can do it. A record run is excluded on purpose: its replay is leaderboard
              PROOF, and a bot partner in a duo record would be a submission nobody drove. */}
          {isHost && !isRecord && botTiers && botTiers.length > 0 && serverBots && (
            <>
              <div className="ds-opts fill">
                {botTiers.map((t) => (
                  <button
                    key={t}
                    className={`ds-opt mini ${botTier === t ? 'on' : ''}`}
                    aria-pressed={botTier === t}
                    onClick={() => setBotTier(t)}
                  >
                    <span className="ot">{botLabel(t)}</span>
                  </button>
                ))}
                <button
                  className="ds-opt mini"
                  disabled={players.length >= capacity}
                  onClick={() => lobbyRef.current?.addBot(botTier)}
                >
                  <span className="ot">Add a bot</span>
                </button>
                {players.some((p) => p.bot) && (
                  <button
                    className="ds-opt mini"
                    onClick={() => {
                      // the LAST one, which is the one the button just added — removing from the
                      // end is what makes pressing add and remove alternately a no-op
                      const last = [...players].reverse().find((p) => p.bot);
                      if (last) lobbyRef.current?.removeBot(last.clientId);
                    }}
                  >
                    <span className="ot">Remove a bot</span>
                  </button>
                )}
              </div>
              <p className="ds-hint">
                A room with a bot in it is unrated. It is still saved to Match history.
              </p>
            </>
          )}
        </section>

        {!idFirst && youSection}

        {!isRecord && (
          <section className="ds-sec">
            <h2>Your alliance</h2>
            <div className="ds-opts two">
              <button
                className={`ds-opt red ${me?.alliance === 'red' ? 'on' : ''}`}
                aria-pressed={me?.alliance === 'red'}
                onClick={() => setAlliance('red')}
              >
                <span className="ot">RED</span>
              </button>
              <button
                className={`ds-opt blue ${me?.alliance === 'blue' ? 'on' : ''}`}
                aria-pressed={me?.alliance === 'blue'}
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
                game={settings.game}
                alliance={me.alliance}
              />
            )}
            {moduleFor(settings.game).startEditor ? (
              // a game's OWN editor, through the module slot. The two inline
              // branches below are DECODE's and CR's, unchanged.
              (() => {
                const StartEd = moduleFor(settings.game).startEditor!;
                return (
                  <StartEd
                    maxSaved={maxSaved}
                    spec={me.spec}
                    alliance={me.alliance}
                    value={me.startPose}
                    startIndex={me.startIndex ?? 0}
                    category={startRole ?? settings.startCat}
                    saved={settings.savedStartPoses}
                    lockedCategory={startRole}
                    onChange={(startPose) => startPose && applyStart(selectStart(sCat, { index: -1, pose: startPose }))}
                    onPickPreset={(i) => applyStart(selectStart(sCat, { index: i, pose: null }))}
                    onCategory={(c) => applyStart(switchCategory(settings, c))}
                    onSave={(pose) => applyStart(saveStart(sCat, pose))}
                    onDeleteSaved={(c, i) => applyStart(deleteSavedStart(sCat, c, i))}
                  />
                );
              })()
            ) : settings.game === 'chain' ? (
              <ChainStartEditor
                spec={me.spec}
                alliance={me.alliance}
                value={me.startPose}
                startIndex={me.startIndex ?? 0}
                category={startRole ?? settings.startCat}
                saved={settings.savedStartPoses}
                lockedCategory={startRole}
                onChange={(startPose) => applyStart(selectStart(sCat, { index: -1, pose: startPose }))}
                onPickPreset={(i) => applyStart(selectStart(sCat, { index: i, pose: null }))}
                onCategory={(c) => applyStart(switchCategory(settings, c))}
                onSave={(pose) => applyStart(saveStart(sCat, pose))}
                onDeleteSaved={(c, i) => applyStart(deleteSavedStart(sCat, c, i))}
              />
            ) : (
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
            )}
          </section>
        )}

        {/* re-pick: quick-swap a saved robot, or open the full builder. Same section,
            same order and same wording as the ranked strategy window — these are the
            two pre-match screens and a driver should not have to learn each one. */}
        {me && (
          <section className="ds-sec">
            <h2>Your robot</h2>
            {/* WHAT YOU ARE BRINGING, said once. When it is one of your saved robots, the lit
                card below says it; this line is for a build that is not saved, which no card
                can show. It used to print over the lit card too, in a second vocabulary. */}
            {!settings.savedRobots.some(isMine) && (
              <p className="ds-sub">
                {mySpec.name} · {buildWords(mySpec, settings.game).join(' · ')}
              </p>
            )}
            <div className="ds-opts robots">
              {settings.savedRobots.map((r, i) => (
                // the builder's own card (`RobotCard`), so a saved robot reads the same here as
                // it does in Configure: name, team, one build line
                <RobotCard
                  key={i}
                  spec={r}
                  game={settings.game}
                  on={isMine(r)}
                  team={teamLine(r)}
                  onPick={() => pickSpec({ ...r })}
                />
              ))}
              <button className="ds-opt mini" onClick={() => setBuilding(true)}>
                <span className="ot">Edit build</span>
              </button>
            </div>
          </section>
        )}

        <div className="ds-actions">
          <button
            className={`ds-cta ${me?.ready ? 'secondary' : ''}`}
            disabled={!startLegal && !me?.ready}
            onClick={toggleReady}
          >
            {me?.ready ? '✓ READY' : 'READY UP'}
          </button>
          {isHost && (
            <button className="ds-cta" disabled={!canStart} onClick={() => lobbyRef.current?.start()}>
              {isRecord ? 'START RUN' : 'START MATCH'}
            </button>
          )}
        </div>
        {/* a refusal while seated (see the 'error' handler): said here, where the host who
            pressed START is looking, and cleared by the next roster */}
        {error && <p className="ds-form-err">⚠ {error}</p>}
        {!startLegal && (
          <p className="ds-hint">
            ⚠ Your start position isn’t legal for this chassis. Fix it above, or pick a preset, to
            ready up.
          </p>
        )}
        {isHost && !enoughPlayers && (
          <p className="ds-hint">Waiting for your partner to join with the code…</p>
        )}
        {isHost && enoughPlayers && !allReady && (
          <p className="ds-hint">START unlocks when everyone is ready.</p>
        )}
        {isHost && restartPending && (
          <p className="ds-hint">Server is restarting shortly. Starting is paused for a moment.</p>
        )}
      </div>
    </div>
    </RoomFriendsLayout>
  );
}
