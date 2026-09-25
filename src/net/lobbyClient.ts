import type { DodgeVerdict } from '../dodge';
import type { GameId, Physics } from '../types';
import type { RobotSetup } from '../sim/spawn';
import type { Transport } from './transport';
import { getAuthToken } from '../lib/authClient';
import { setServerNotice } from './notice';
import { applyPushedStatus } from './siteStatus';
import { appChannel, appBuild } from './env';
import {
  encodeMsg,
  decodeServerMsg,
  type ServerMsg,
  CLIENT_CAPS,
  type LobbyPlayer,
  type MatchDriver,
  type PlayerIntro,
  type PlayerPatch,
  type QueueMode,
  type RoomConfig,
  type ErrorCode,
} from './protocol';

export interface MatchStart {
  seed: number;
  setups: RobotSetup[];
  yourRobotId: number;
  /** which game the match plays (DECODE by default) — passed to the ServerSession */
  game?: GameId;
  /**
   * WHICH PHYSICS THE ROOM RUNS ON (`matchStart.physics`; absent ⇒ `'2d'`).
   *
   * ⚠️ **IT WAS ALWAYS ON THE WIRE AND MISSING FROM THIS TYPE, AND THAT COST A BUG.** The
   * handler forwards the whole server message, so the value was there at runtime — but
   * `App.beginSession` rebuilds this object FIELD BY FIELD for the rejoin record, and a field
   * the type does not name is a field nobody thinks to copy. A rejoin into a 3D room therefore
   * built a 2D world, predicted a different game from the one the server was scoring, and never
   * latched `physicsPending`. Measured in a browser on 2026-09-18.
   */
  physics?: Physics;
  /**
   * THE MATCH GENERATION (`matchStart.gen`; absent ⇒ 0) — and it is on this type for
   * EXACTLY the reason `physics` above it is.
   *
   * ⚠️ **IT WAS ALWAYS ON THE WIRE AND MISSING FROM THIS TYPE, AND IT COST THE SAME BUG
   * TWICE OVER.** `App.beginSession` rebuilds this object field by field for the rejoin
   * record, and a field the type does not name is a field nobody copies — so a rejoin came
   * back stamped generation 0 while the room was on 1, and `Room.onInput` drops a stale
   * generation outright. The returning driver's robot did not respond to a single command:
   * prediction moved it, every snapshot snapped it back. Measured against a local server on
   * 2026-09-19 (0.000 in of travel with the field absent, 38.7 in with it present).
   */
  gen?: number;
  /** ranked rooms only: drives the pre-match ELO intro overlay */
  ranked?: boolean;
  intros?: PlayerIntro[];
  /**
   * WHO IS IN EACH SEAT (`matchStart.drivers`; absent ⇒ nothing known) — the usernames the
   * in-match labels print.
   *
   * ⚠️ **NAMED HERE BECAUSE OF WHAT THIS TYPE IS FOR.** `App.beginSession` rebuilds this object
   * field by field for the rejoin record, and `physics` and `gen` both shipped missing from it
   * for exactly as long as they were missing from this declaration. The symptom is mild for
   * this one — a returning driver's labels fall back to chassis names — but it is the same
   * hole, and the fix is to be in the list.
   */
  drivers?: MatchDriver[];
  /** the Fly region hosting the match (for the "matched on …" HUD chip) */
  region?: string;
}

/**
 * Client-side lobby over the game-server socket. Replaces the old Supabase
 * Realtime presence/signaling lobby: the server is authoritative for the roster
 * and the host, so this is a thin relay — join a room, patch your own state,
 * render the server's roster, and (host) press start. At `matchStart` the
 * caller mints a ServerSession that TAKES OVER this same transport.
 */
type Handlers = {
  roster: (players: LobbyPlayer[], hostId: string) => void;
  matchStart: (m: MatchStart) => void;
  queued: (mode: QueueMode, size: number, need: number) => void;
  /** ranked match found on a `?mm=1` connection: reconnect to `?room=<room>` (the
   * server routes it to `hostRegion`) to actually play */
  matchAssigned: (room: string, hostRegion: string, mode: QueueMode) => void;
  /** ranked pre-match strategy window opened: switch to the strategy screen. Live
   * changes ride the existing `update`/`roster`; a `matchStart` follows on ready. */
  strategyStart: (
    deadline: number,
    yourRobotId: number,
    mode: QueueMode,
    intros: PlayerIntro[],
    /** false ⇒ a CUSTOM room's 3D-readiness window: no ratings, nothing to ready up. Absent
     *  from an older server ⇒ true, which is what every `strategyStart` used to be. */
    ranked: boolean,
  ) => void;
  /** `code` is present only for the reasons a client can ACT on (today: `region_full`).
   *  Absent for everything else, and absent entirely from older servers, so a handler
   *  must stay correct reading `message` alone. */
  error: (message: string, code?: ErrorCode) => void;
  /** a staged RANKED pairing was cancelled and this is what it cost. Arrives just BEFORE
   *  the `error` that tears the screen down, so the UI can show the reason alongside it. */
  dodgeVerdict: (yours: DodgeVerdict | null, others: DodgeVerdict[]) => void;
  /** the ranked queue refused this account: its standing carries a cooldown. `until` is an
   *  epoch ms deadline, so the screen counts it down instead of showing a stale sentence. */
  standingLock: (until: number, score: number, tier: string) => void;
  closed: () => void;
};

export class LobbyClient {
  clientId = '';
  /** THE SEAT'S SECRET — sent only to us in `welcome`, never in a roster. It, not
   * `clientId`, is what `rejoin`/`abandon` are checked against (see protocol.ts). Empty
   * against an older server, which simply keeps the pre-token rule. */
  seatToken = '';
  hostId = '';
  players: LobbyPlayer[] = [];
  private readonly handlers: Partial<Handlers> = {};

  constructor(readonly transport: Transport) {
    transport.onMessage((d) => this.onMessage(d));
    // a transient drop auto-reconnects (see below); only a give-up is terminal
    transport.onFail(() => this.handlers.closed?.());
  }

  on<K extends keyof Handlers>(event: K, cb: Handlers[K]): void {
    this.handlers[event] = cb;
  }

  /**
   * Join (or create) a room; (re)sends on open AND on any reconnect. `config` (set only by the
   * room CREATOR) picks versus vs. record-chasing. Attaches the Neon Auth JWT (if signed in) so
   * the server attributes the run.
   *
   * ⚠️ **THE TOKEN IS ATTACHED HERE AND MAY BE REMOVED AGAIN ON THE WAY OUT.** A room is the
   * one thing that can be hosted on somebody's laptop (`roomServerUrl()` in `env.ts`), and a
   * cloud credential handed to a LAN server is a cloud credential its operator has. So the
   * transport strips it from every frame bound for a server the cloud has not vouched for —
   * see `src/net/credentials.ts` for why that check lives at the send boundary rather than at
   * this call site and the two others like it. Do NOT re-derive the rule here.
   */
  join(room: string, player: Omit<LobbyPlayer, 'clientId'>, config?: RoomConfig, group?: string): void {
    const doJoin = async (): Promise<void> => {
      const authToken = (await getAuthToken()) ?? undefined;
      this.transport.send(
        encodeMsg({ t: 'join', room, player, config, authToken, caps: CLIENT_CAPS, channel: appChannel(), group }),
      );
    };
    this.transport.onOpen(() => void doJoin());
    this.transport.onReopen(() => void doJoin());
  }

  /**
   * ADOPT A SOCKET THAT IS ALREADY IN THIS ROOM — the way back from a finished match.
   *
   * When the host recycles a room (`ServerMsg` 't: lobby'), the client hands the LIVE
   * transport from its `ServerSession` to a fresh `LobbyClient` rather than dropping the
   * connection and dialling again. So there is deliberately NO `join` frame here: the
   * server still holds this socket's seat, and joining again would add a second client
   * under the same socket id. The server re-sent our `clientId` with the recycle, and a
   * `roster` follows it, so both halves of the lobby state arrive without asking.
   *
   * ⚠️ `join`'s `transport.onOpen` fires IMMEDIATELY on an already-open socket
   * (`WebSocketTransport.onOpen`), which is exactly the duplicate join this avoids. A
   * REOPEN is different: the seat is gone with the old socket — a lobby departure deletes
   * the client outright rather than holding it like a mid-match one — so coming back from
   * a drop is an ordinary fresh `join`, the same frame `join()` would have sent.
   */
  resume(
    room: string,
    player: Omit<LobbyPlayer, 'clientId'>,
    clientId: string,
    seatToken: string,
    config?: RoomConfig,
    group?: string,
  ): void {
    this.clientId = clientId;
    /**
     * ⚠️ AND THE SEAT'S SECRET, which no `welcome` will re-send on this socket either. Dropped
     * here, the next `ServerSession` was built with an empty token, and from the room's second
     * match on every `rejoin` and `abandon` of this secured seat was refused by the server.
     */
    this.seatToken = seatToken;
    /**
     * ASK FOR THE ROSTER RATHER THAN HOPING WE CAUGHT IT.
     *
     * The room broadcasts one immediately after the recycle, but that frame is in flight
     * while the old `ServerSession` still owns `transport.onMessage` — the App cannot
     * re-point it until React has rendered this screen — so it lands on a handler that
     * throws it away, and the lobby would show an empty room until something else happened
     * to trigger a broadcast. An EMPTY patch is the ask: `sanitizePlayerPatch` reduces it to
     * `{}`, so it changes nothing about us and the server answers with a `roster` anyway.
     */
    this.transport.send(encodeMsg({ t: 'update', patch: {} }));
    this.sendPhysicsReady(); // the socket is already open and already seated
    this.transport.onReopen(() => {
      void (async () => {
        const authToken = (await getAuthToken()) ?? undefined;
        /**
         * ⚠️ THE GROUP RIDES THIS FRAME TOO, OR A DISCORD PLAYER IS EJECTED FROM THEIR OWN
         * ACTIVITY. The server refuses a grouped room to a join that names no group, so a
         * reconnect from a recycled lobby — the wifi blip while everyone picks robots after
         * a match — was answered with "That code belongs to a Discord activity. Open it from
         * the activity to join." while they were sitting inside that exact activity. Worse,
         * if the room had gone (a Fly restart drops everyone at once) the groupless join
         * RE-CREATED it ungrouped, and it never appeared in the activity's lobby list again.
         * The doc above says this should send the same frame `join()` would have; it now does.
         */
        this.transport.send(
          encodeMsg({ t: 'join', room, player, config, authToken, caps: CLIENT_CAPS, channel: appChannel(), group }),
        );
      })();
    });
  }

  /** SPECTATE a live match read-only. (Re)sends on open + reconnect. `matchStart`
   * arrives with yourRobotId -1 → build a spectator ServerSession from it. */
  spectate(room: string): void {
    const doSpectate = async (): Promise<void> => {
      // The token is sent for ONE purpose: if the server verifies it as an admin,
      // this watcher is left out of the visible spectator count (moderation — see
      // Room.hideSpectator). For everyone else it changes nothing at all, so it is
      // attached unconditionally rather than gated on the client believing it is
      // an admin, which would just be a claim the server has to re-check anyway.
      // As on `join`, the transport removes it again if this socket is not going to a
      // server the cloud vouches for (`src/net/credentials.ts`). A LAN server has no
      // admins to recognise, so nothing is lost by its absence there.
      const authToken = (await getAuthToken()) ?? undefined;
      this.transport.send(encodeMsg({ t: 'spectate', room, caps: CLIENT_CAPS, authToken }));
    };
    this.transport.onOpen(() => void doSpectate());
    this.transport.onReopen(() => void doSpectate());
  }

  /** change our own alliance / start pose / ready / spec */
  update(patch: PlayerPatch): void {
    this.transport.send(encodeMsg({ t: 'update', patch }));
  }

  /** host only: begin the match */
  start(): void {
    this.transport.send(encodeMsg({ t: 'start' }));
  }

  /**
   * TELL THE ROOM THIS CLIENT'S 3D PHYSICS CHUNK IS LOADED (`READY3D_CAP`).
   *
   * `announcePhysicsReady` (`roomPhysics.ts`) is the only caller — it is what knows whether
   * this room's game has a 3D solve at all. Fire-and-forget and idempotent: an older server
   * ignores the message and starts the match as it always did, so there is no `serverCaps()`
   * gate and no reply to wait for.
   *
   * ⚠️ **IT LATCHES RATHER THAN HOOKING `onOpen`/`onReopen`, AND IT HAS TO.** Those are
   * SINGLE-SLOT on both transports (`transport.ts`, `lanPeer.ts`) — a second registration
   * REPLACES the first — so a second subscriber here would silently unhook the re-`join` that
   * a reconnect depends on, and the symptom would be a returning client with no seat.
   *
   * The latch is flushed from `welcome` instead (and from `resume`, whose socket is already
   * seated), which is both the right ORDER and the right EVENT — see the note there.
   */
  physicsReady(): void {
    if (this.ready3d) return;
    this.ready3d = true;
    if (this.seated) this.sendPhysicsReady();
  }

  /** the latch `physicsReady()` sets, and whether the server has confirmed a seat on this
   *  socket yet (`welcome`, or a `resume` onto one it already holds) */
  private ready3d = false;
  private seated = false;

  /** announce readiness now that there is a seat to announce it to — see `physicsReady` */
  private sendPhysicsReady(): void {
    this.seated = true;
    if (this.ready3d) this.transport.send(encodeMsg({ t: 'physicsReady' }));
  }

  /**
   * HOST ONLY: seat an AI driver on an empty slot, or give one back (plan §6).
   *
   * Fire-and-forget, like `update` and `start`: the server answers with a fresh `roster`, so the
   * caller never tracks this optimistically. A refusal (a full room, a ranked room, a game with
   * no driver) arrives as an ordinary `error`.
   *
   * ⚠️ The CALLER gates on `serverCaps()` containing `'bots'` — an older server ignores an
   * unknown message rather than refusing it, so an ungated button would silently do nothing.
   */
  addBot(tier?: string): void {
    this.transport.send(encodeMsg({ t: 'addBot', tier }));
  }

  removeBot(seat: string): void {
    this.transport.send(encodeMsg({ t: 'removeBot', seat }));
  }

  /** enter the ranked queue on this `?mm=1` connection. On a match the server sends
   * `matchAssigned` (reconnect to the host region). (Re)sends on open + reconnect,
   * with the auth JWT. `homeRegion`/`accessMs` are the client's network position (so
   * the matchmaker can pick a fair host); `noWiden` ⇒ never widen past my region. */
  queue(
    mode: QueueMode,
    player: Omit<LobbyPlayer, 'clientId'>,
    homeRegion: string,
    accessMs: number,
    noWiden?: boolean,
    game?: GameId,
    /** "play a friend": queue under a challenge token so the server pairs us with
     * the person we challenged instead of the open pool (see ui/challenge.ts) */
    party?: { token: string; format: string; partyOnly: boolean },
  ): void {
    const doQueue = async (): Promise<void> => {
      const authToken = (await getAuthToken()) ?? undefined;
      this.transport.send(
        encodeMsg({
          t: 'queue', mode, player, authToken, homeRegion, accessMs, noWiden, game,
          caps: CLIENT_CAPS, channel: appChannel(), build: appBuild(),
          party: party?.token, partyFormat: party?.format, partyOnly: party?.partyOnly,
        }),
      );
    };
    this.transport.onOpen(() => void doQueue());
    this.transport.onReopen(() => void doQueue());
  }

  /** widen the search radius now (impatient player) */
  expandSearch(): void {
    this.transport.send(encodeMsg({ t: 'expandSearch' }));
  }

  leaveQueue(): void {
    this.transport.send(encodeMsg({ t: 'leaveQueue' }));
  }

  isHost(): boolean {
    return this.clientId !== '' && this.clientId === this.hostId;
  }

  dispose(): void {
    this.transport.close();
  }

  private onMessage(data: string): void {
    // ⚠️ A FRAME IS UNTRUSTED INPUT, AND ON LAN IT COMES FROM ANOTHER PLAYER'S BROWSER
    // (`DataChannelTransport`), not from our own server. `decodeServerMsg` is a bare
    // `JSON.parse`, so malformed bytes throw — and the `null` literal parses FINE and then
    // throws on `.t`, outside any try around the parse alone. Drop the frame either way.
    let m: ServerMsg;
    try {
      m = decodeServerMsg(data);
    } catch {
      return;
    }
    if (!m || typeof (m as { t?: unknown }).t !== 'string') return;
    if (m.t === 'welcome') {
      this.clientId = m.clientId;
      if (m.seatToken) this.seatToken = m.seatToken;
      /* ⚠️ **THE SEAT EXISTS NOW, AND NOT ONE FRAME EARLIER.** `physicsReady` is routed
         through the socket's ROOM (`server/index.ts`), and a `join` is handled ASYNCHRONOUSLY
         — token verification, a suspension read, sometimes a staged-match lookup — so a frame
         sent straight after the join arrives while that socket still has no room and is
         DROPPED, with nothing to retry it. The room would then wait out its whole 45-second
         deadline for a client that loaded on time. `welcome` is the server saying the seat is
         taken, and it is re-sent on every reattach, which is exactly the two moments this has
         to fire. */
      this.sendPhysicsReady();
    } else if (m.t === 'lobby') {
      // a recycle that landed on a lobby rather than a session (the host recycled while
      // we were still coming back). The id is ours either way — take it, and the seat's
      // secret with it when the server sends one (an older server does not).
      this.clientId = m.clientId;
      if (m.seatToken) this.seatToken = m.seatToken;
    } else if (m.t === 'roster') {
      this.players = m.players;
      this.hostId = m.hostId;
      this.handlers.roster?.(m.players, m.hostId);
    } else if (m.t === 'matchStart') {
      this.handlers.matchStart?.(m);
    } else if (m.t === 'queued') {
      this.handlers.queued?.(m.mode, m.size, m.need);
    } else if (m.t === 'matchAssigned') {
      this.handlers.matchAssigned?.(m.room, m.hostRegion, m.mode);
    } else if (m.t === 'strategyStart') {
      this.handlers.strategyStart?.(m.deadline, m.yourRobotId, m.mode, m.intros, m.ranked !== false);
    } else if (m.t === 'error') {
      this.handlers.error?.(m.message, m.code);
    } else if (m.t === 'dodgeVerdict') {
      this.handlers.dodgeVerdict?.(m.yours, m.others);
    } else if (m.t === 'standingLock') {
      this.handlers.standingLock?.(m.until, m.score, m.tier);
    } else if (m.t === 'serverNotice') {
      setServerNotice(m.message ? { kind: m.kind, message: m.message, until: m.until } : null);
    } else if (m.t === 'siteStatus') {
      applyPushedStatus(m.lockdown ?? null, m.banners ?? []);
    }
  }
}
