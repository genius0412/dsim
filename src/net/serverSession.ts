import type { Artifact, GameId, Physics, RobotCommand, RobotSpec } from '../types';
import type { RobotSetup } from '../sim/spawn';
import type { MatchResultInfo, NetSession, NetStatus, RematchVote, Snapshot } from './session';
import type { Transport } from './transport';
import { setServerNotice } from './notice';
import { applyPushedStatus } from './siteStatus';
import { regionLabel, isKnownRegion, selectedServer } from './env';
import {
  CLIENT_CAPS,
  encodeMsg,
  decodeServerMsg,
  type ServerMsg,
  quantizeCommand,
  dequantizeCommand,
  applyBallDelta,
  unslimWorld,
  type EloDelta,
  type MatchDriver,
  type PlayerIntro,
  type RecordRankInfo,
} from './protocol';

/** monotonic wall clock (ms). performance.now() in the browser; Date.now() as a
 * fallback for any non-DOM context. Diagnostics only — never touches the sim. */
const nowMs = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

/** the display label for the server/region a match runs on. Prefer the region the
 * server reported at matchStart; else infer it from a region-coded room code
 * (`iad-…`); else fall back to the picked server's label. Blank ⇒ HUD hides it. */
function deriveServerLabel(reportedRegion: string | undefined, room: string): string {
  if (reportedRegion) return regionLabel(reportedRegion);
  const prefix = /^([a-z]{3})-/.exec(room)?.[1];
  if (prefix && isKnownRegion(prefix)) return regionLabel(prefix);
  return selectedServer()?.label ?? '';
}

/** how often to probe latency. Faster than the old 1 Hz so the ping GRAPH can
 * actually resolve sub-second spikes (the smoothed RTT number can't). ~3 Hz is a
 * trivial number of tiny frames. */
const PING_INTERVAL_MS = 300;
/** window of snapshot inter-arrival gaps kept for the rate + jitter estimate */
const SNAP_WINDOW = 30;
/** raw RTT samples retained for the ping graph (~36 s at PING_INTERVAL_MS) */
const RTT_HISTORY = 120;

/**
 * Client half of the server-authoritative netcode. Constructed AFTER the server
 * sends `matchStart` (so seed/setups/robotId are known), it takes over the
 * transport from the LobbyClient and:
 *   - `sendInput` forwards each tick's quantized command to the server,
 *   - `takeSnapshot` hands the GameController the freshest authoritative world to
 *     reconcile against,
 *   - `matchStart` arriving again (a host restart) fires `onRestart`.
 *
 * A dropped socket flips `waitingFor` to 'server' (the HUD shows reconnecting);
 * prediction means the local robot keeps responding meanwhile.
 */
export class ServerSession implements NetSession {
  /** which game the match plays (from matchStart; DECODE by default). Mutable so a
   * host restart can carry a new game, but never written by consumers. */
  game: GameId;
  /** which physics the ROOM runs on (`matchStart.physics`; absent ⇒ '2d'). Mutable for the
   *  same reason `game` is: a host restart re-authors the match. */
  physics: Physics;
  readonly localRobotId: number;
  /** read-only spectator session (no local robot; input suppressed) */
  readonly spectator: boolean;
  seed: number;
  setups: RobotSetup[];
  ranked: boolean;
  intros: PlayerIntro[];
  /**
   * WHO IS IN EACH SEAT (`matchStart.drivers`; empty against an older server or a room with
   * nobody to name). Public because `App.beginSession` copies it into the rejoin record.
   */
  drivers: MatchDriver[];
  /** `drivers` as a lookup, rebuilt wherever `drivers` is written — see `driverName`. */
  private names = new Map<number, string>();
  /** the Fly region hosting this match (raw, for reconnect routing) */
  readonly region?: string;
  /** per-driver overall-ELO change, arrives shortly after matchResult (ranked) */
  eloResults: EloDelta[] = [];

  private snapshot: Snapshot | null = null;
  /**
   * The archive capability for the match in progress, or null.
   *
   * Arrives as `matchArchive` on THIS socket only, and only if this client is the room's host
   * — it is what lets the host file the match with the cloud, and it is deliberately not
   * broadcast (see the protocol note). Held here rather than passed straight to the result
   * callback because it arrives a frame EARLIER than the result it describes: the server sends
   * it first precisely so it is already in hand when `matchResult` lands.
   */
  private archiveMatchId: string | null = null;
  private matchResult: MatchResultInfo | null = null;
  /** record run's leaderboard standing, arrives shortly after matchResult */
  private recordResult: RecordRankInfo | null = null;
  private restartCb: (() => void) | null = null;
  /** the room went back to its lobby — see `onLobby` */
  private lobbyCb: ((clientId: string) => void) | null = null;
  /** the seat's secret (see protocol.ts `welcome`). Carried in, and refreshed by every
   * `welcome` the server sends — including the one a reattach re-sends — so a reclaimed
   * seat always holds a working credential. */
  seatToken = '';
  /** fired once per `matchResult` — see `onMatchResult` */
  private resultCb: ((info: MatchResultInfo) => void) | null = null;
  private connected = true;
  /** reconnection budget exhausted — the server likely restarted; prompt a refresh */
  private failed = false;
  /** other robots in the match (for the HUD "N players" chip) */
  private readonly otherRobots: number;
  /** human-readable label of the server/region hosting this match (HUD) */
  private readonly serverLabel: string;
  /** running ball baseline the delta-encoded snapshots patch (keyed by id) */
  private readonly baseBalls = new Map<number, Artifact>();
  /** newest authoritative `serverTick` we've APPLIED — the baseline we ACK back to
   * the server, and the guard that discards a stale/duplicate snapshot (a no-op on
   * the ordered WebSocket, required once snapshots can arrive out of order on the
   * unreliable QUIC lane). Reset to -1 on a host restart (new world, tick 0). */
  private appliedTick = -1;
  /**
   * The MATCH GENERATION this session is playing, echoed on every input so the server can
   * drop anything produced for a match a rematch has replaced.
   *
   * PUBLIC because the rejoin record has to carry it: a session rebuilt from a saved
   * `matchStart` that had no generation sends 0, the server drops every input stamped with
   * it, and the returning robot never moves. Written here from the handshake, from a
   * rematch's `matchStart`, and from the `rejoined` that hands a slot back — the server is
   * the authority on it at all three doors.
   */
  gen = 0;
  /** the server refused to hand our held slot back (`rejoined: ok=false`) — the match ended
   *  or the grace lapsed. Distinct from `failed`, which a plain connection loss also sets. */
  private refused = false;

  // ---- connection-quality diagnostics (for the HUD net readout) --------------
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** smoothed round-trip time (EWMA over pong samples), null until the first pong */
  private rttMs: number | null = null;
  /** live watcher count from the server (`spectators`), as players are told it */
  private spectators = 0;
  /** duo-record rematch tally from the server. `mine` is whether OUR vote is in, so
   *  the button renders from the authority rather than an optimistic local guess. */
  private rematch: RematchVote = { votes: 0, need: 0, mine: false };
  /** RAW round-trip samples (oldest→newest) for the ping graph — un-smoothed so a
   * spike shows as a spike */
  private readonly rttSamples: number[] = [];
  /** wall-clock of the previous snapshot, to time inter-arrival gaps */
  private lastSnapAt: number | null = null;
  /**
   * THE ROOM'S LOAD HOLD (`loadHold`): when, on OUR clock, the room will start anyway, and who
   * it is waiting on. Null ⇒ not held. A snapshot past tick 0 also clears it, so a lost release
   * cannot keep this client frozen in front of a running match.
   */
  private hold: { until: number; loading: number[] } | null = null;
  /** robots a released hold started without, until the controller logs them */
  private lateStart: number[] | null = null;
  /** the match generation `viewReady` was last sent for (-1 ⇒ never, or re-send after a rejoin) */
  private viewSentGen = -1;
  /** recent snapshot inter-arrival gaps (ms) — feeds snapHz + jitter */
  private readonly snapGaps: number[] = [];

  constructor(
    private readonly transport: Transport,
    /**
     * ⚠️ NOT readonly — see the `roster` case in `onMessage`. The crown migrates when the
     * host leaves, and a session that answered its construction-time value for the rest of
     * the room's life would hide the host-only controls from the player who is now host.
     */
    private host: boolean,
    start: {
      seed: number;
      setups: RobotSetup[];
      yourRobotId: number;
      game?: GameId;
      physics?: Physics;
      ranked?: boolean;
      intros?: PlayerIntro[];
      drivers?: MatchDriver[];
      region?: string;
    },
    readonly clientId: string,
    readonly room: string,
    spectator = false,
    seatToken = '',
  ) {
    this.seatToken = seatToken;
    this.spectator = spectator;
    this.game = start.game ?? 'decode';
    this.physics = start.physics ?? '2d';
    this.seed = start.seed;
    this.setups = start.setups;
    this.ranked = start.ranked ?? false;
    this.intros = start.intros ?? [];
    this.drivers = start.drivers ?? [];
    this.rebuildNames();
    this.gen = (start as { gen?: number }).gen ?? 0;
    this.region = start.region;
    this.localRobotId = start.yourRobotId;
    this.otherRobots = Math.max(0, start.setups.length - 1);
    this.serverLabel = deriveServerLabel(start.region, room);
    // take over routing + reconnection handling from the LobbyClient
    transport.onMessage((d) => this.onMessage(d));
    transport.onDown(() => {
      this.connected = false; // HUD shows "reconnecting"; prediction keeps running
    });

    /**
     * ⚠️ A SPECTATOR HAS NO SLOT TO RECLAIM, SO IT MUST NOT CLAIM ONE.
     *
     * `rejoin` asks the room to hand back a held DRIVER slot, and `Room.reattach` looks
     * only in `clients` — a watcher lives in `spectators` and is dropped outright on
     * `detach`. So a spectator whose socket reopened was answered `{rejoined, ok:false}`,
     * which this session treats as a hard failure: it closes the transport and the world
     * freezes behind the "connection lost" panel, on a connection that had just come back.
     *
     * The reopen handshake for a watcher already exists and is CORRECT — `LobbyClient.
     * spectate` re-sends `spectate` (with `caps` and the admin token, so a hidden observer
     * stays hidden) on both open and reopen, and the room answers with `matchStart` plus a
     * keyframe, which is exactly the resync. Registering ours here REPLACED it: `onReopen`
     * is a single slot, not a listener list. So the driver path registers and the spectator
     * path deliberately leaves the lobby's handler in place.
     */
    if (!spectator) {
      transport.onReopen(() => {
        // reclaim our in-match slot on the fresh socket; a snapshot resyncs us
        this.failed = false;
        // re-advertise this build's capabilities: a reclaim arrives on a FRESH socket, and the
        // server gates a `'3d'`-physics room at every door it has.
        transport.send(
          encodeMsg({ t: 'rejoin', room: this.room, clientId: this.clientId, caps: CLIENT_CAPS, seatToken: this.seatToken }),
        );
      });
    }
    transport.onFail(() => {
      this.connected = false; // retries exhausted (the server likely restarted)
      this.failed = true;
    });
    // probe latency continuously while the match is live (a no-op send when the
    // socket is down); each pong updates the smoothed RTT for the HUD. Hot-path
    // lane: a lost ping is simply superseded by the next 300 ms probe — no reason
    // to head-of-line block the control stream behind it.
    this.pingTimer = setInterval(() => {
      transport.send(encodeMsg({ t: 'ping', ts: nowMs() }), { reliable: false });
    }, PING_INTERVAL_MS);
  }

  isHost(): boolean {
    return this.host;
  }

  /** the username driving `robotId`, or undefined — the in-match label's lookup. Undefined
   *  for a seat the server did not name, which the label answers with the chassis name. */
  driverName(robotId: number): string | undefined {
    return this.names.get(robotId);
  }

  private rebuildNames(): void {
    this.names = new Map(this.drivers.map((d) => [d.robotId, d.name]));
  }

  requestRestart(): void {
    if (this.host) this.transport.send(encodeMsg({ t: 'restart' }));
  }

  onRestart(cb: () => void): void {
    this.restartCb = cb;
  }

  /** REPLACES, like every other `on*` here — the app re-registers whenever the callback's
   *  closure changes, and two live handlers would double-keep the match. */
  onMatchResult(cb: (info: MatchResultInfo) => void): void {
    this.resultCb = cb;
  }

  /** report another driver in this match. The server maps `robotId` onto an account from
   *  its OWN roster, so this can only ever name somebody actually in this match. */
  sendReport(robotId: number, reason: string, detail: string): void {
    this.transport.send(encodeMsg({ t: 'report', robotId, reason, detail }));
  }

  /** file a MISSCORE claim about this match — see the protocol note on `reportScore` */
  sendScoreReport(detail: string): void {
    this.transport.send(encodeMsg({ t: 'reportScore', detail }));
  }

  sendInput(tick: number, cmd: RobotCommand): void {
    if (this.spectator) return; // a spectator controls nothing
    // Hot-path lane: inputs are sent every tick and the server holds-last, so a
    // dropped input is superseded by the next one within ~16 ms. Sending it
    // unreliable is exactly what stops one lost/late input from stalling the
    // whole stream behind it (the head-of-line win we're after).
    // Piggyback the snapshot ACK (newest applied serverTick) so the server knows
    // which baseline we hold — free here, drivers send input every tick.
    const ack = this.appliedTick >= 0 ? this.appliedTick : undefined;
    this.transport.send(encodeMsg({ t: 'input', tick, q: quantizeCommand(cmd), ack, gen: this.gen }), {
      reliable: false,
    });
  }

  takeSnapshot(): Snapshot | null {
    const s = this.snapshot;
    this.snapshot = null;
    return s;
  }

  getMatchResult(): MatchResultInfo | null {
    return this.matchResult;
  }

  getRecordResult(): RecordRankInfo | null {
    return this.recordResult;
  }

  spectatorCount(): number {
    return this.spectators;
  }

  /**
   * DID THE SERVER REFUSE TO GIVE THIS SEAT BACK? — the one failure a rejoin can recover
   * from, and the reason it is told apart from an ordinary drop.
   *
   * `failed` covers both, so a caller reading it alone cannot tell "the match you saved is
   * gone" (go back to the menu and forget it) from "the connection died mid-match" (stay
   * put, the player is in a real game). The Home rejoin card needs the first.
   */
  slotRefused(): boolean {
    return this.refused;
  }

  rematchVote(): RematchVote {
    return this.rematch;
  }

  /** toggle OUR rematch vote. The server counts; nothing restarts until every
   *  connected driver has one in. */
  setRematch(on: boolean): void {
    this.transport.send(encodeMsg({ t: 'rematch', on }));
  }

  status(): NetStatus {
    // snapshot rate + jitter from the recent inter-arrival gaps (mean + mean-abs-dev)
    let snapHz: number | null = null;
    let jitterMs: number | null = null;
    if (this.snapGaps.length >= 3) {
      const mean = this.snapGaps.reduce((a, b) => a + b, 0) / this.snapGaps.length;
      if (mean > 0) snapHz = Math.round(1000 / mean);
      jitterMs = Math.round(
        this.snapGaps.reduce((a, b) => a + Math.abs(b - mean), 0) / this.snapGaps.length,
      );
    }
    const rttMs = this.rttMs === null ? null : Math.round(this.rttMs);
    // smoothness bucket: jitter dominates the visual feel, latency is secondary.
    // reconnecting ⇒ always poor; unmeasured ⇒ null (HUD shows "measuring…")
    let quality: NetStatus['quality'] = null;
    if (!this.connected) {
      quality = 'poor';
    } else if (rttMs !== null && jitterMs !== null) {
      if (rttMs < 90 && jitterMs < 12) quality = 'good';
      else if (rttMs < 180 && jitterMs < 28) quality = 'fair';
      else quality = 'poor';
    }
    return {
      waitingFor: this.connected ? null : 'server',
      desync: false,
      peers: this.otherRobots,
      failed: this.failed,
      rttMs,
      snapHz,
      jitterMs,
      quality,
      rttHistory: this.rttSamples.length ? this.rttSamples.slice() : null,
      server: this.serverLabel || null,
      hold: this.holdStatus(),
    };
  }

  /** the hold as the HUD shows it: seconds to the cap, and the OTHER drivers still loading */
  private holdStatus(): NetStatus['hold'] {
    if (!this.loadHeld() || !this.hold) return null;
    return {
      secs: Math.ceil(Math.max(0, this.hold.until - performance.now()) / 1000),
      waiting: this.hold.loading.filter((r) => r !== this.localRobotId).length,
    };
  }

  viewReady(): void {
    if (this.spectator || this.viewSentGen === this.gen || !this.connected) return;
    this.viewSentGen = this.gen;
    this.transport.send(encodeMsg({ t: 'viewReady', gen: this.gen }));
  }

  loadHeld(): boolean {
    if (!this.hold) return false;
    // the room's cap is the room's; a release we never heard about must not hold us past it
    if (performance.now() > this.hold.until + 2000) this.hold = null;
    return this.hold !== null;
  }

  takeLateStart(): number[] | null {
    const late = this.lateStart;
    this.lateStart = null;
    return late;
  }

  dispose(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.transport.close();
  }

  /**
   * GIVE THE SOCKET UP WITHOUT CLOSING IT — the way out of a recycled room.
   *
   * `dispose` ends the connection because every other exit from a match really is an
   * exit. Going back to the room's own lobby is not: the server still holds this seat,
   * and dropping the socket would make the player re-join the room they never left (and
   * lose it outright if the room filled in between). So this stops everything the session
   * owns — the ping probe, and it is the caller's job to re-point `transport.onMessage`
   * at a `LobbyClient` immediately — and leaves the connection standing.
   */
  release(): Transport {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    return this.transport;
  }

  /**
   * Give up this seat without waiting for anything back (`abandon` is answered with
   * nothing by design). Sent on the socket the session already owns, so it is ordered
   * ahead of anything the next connection does — which is the whole point, since the
   * caller is usually about to `dispose()` and open a new room immediately.
   */
  abandonSlot(): void {
    if (!this.room || !this.clientId) return;
    this.transport.send(
      encodeMsg({ t: 'abandon', room: this.room, clientId: this.clientId, seatToken: this.seatToken }),
    );
  }

  /** host only: ask the server to send this finished room back to its lobby. */
  requestLobby(): void {
    this.transport.send(encodeMsg({ t: 'lobby' }));
  }

  /** the room went back to its lobby; `clientId` is ours, re-sent because the lobby that
   *  adopts this socket never sends a `join` and so never gets a `welcome`. */
  onLobby(cb: (clientId: string) => void): void {
    this.lobbyCb = cb;
  }

  /** a robot's static spec, re-injected into slimmed snapshots (from setups) */
  private specById = (id: number): RobotSpec =>
    this.setups.find((s) => s.id === id)?.spec ?? this.setups[0].spec;

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
    if (m.t === 'loadHold') {
      if (m.gen !== this.gen) return; // a hold for a match this session is no longer playing
      if (m.waitMs > 0) {
        this.hold = { until: performance.now() + m.waitMs, loading: m.loading };
      } else {
        this.hold = null;
        this.lateStart = m.loading.length ? m.loading : null;
      }
      return;
    }
    if (m.t === 'snapshot') {
      if (this.hold && m.serverTick > 0) this.hold = null;
      // discard a stale/duplicate snapshot: the client reconciles to the NEWEST
      // authoritative world, and a delta is keyed to a baseline at-or-before this
      // one, so applying an older frame after a newer one would regress the balls.
      // A no-op on the ordered WebSocket (ticks arrive monotonic); the guard the
      // out-of-order QUIC-datagram lane will need.
      if (m.serverTick <= this.appliedTick) return;
      // patch the running ball baseline + rebuild the array in the authoritative
      // order (shared codec so it can't drift from the server's encoder)
      const balls = applyBallDelta(this.baseBalls, m.balls);
      const world = unslimWorld(m.w, balls, this.specById);
      // each robot's command this tick, so the controller can predict remotes.
      // tolerate an older server that doesn't send cmds (remotes just won't be
      // predicted forward — no crash) so a version mismatch degrades gracefully
      const cmds = new Map<number, RobotCommand>();
      const qc = m.cmds ?? [];
      m.w.robots.forEach((r, i) => {
        if (qc[i]) cmds.set(r.id, dequantizeCommand(qc[i]));
      });
      // keep only the freshest — the controller reconciles to the newest world
      this.snapshot = { serverTick: m.serverTick, world, cmds, ackInputTick: m.ackInputTick };
      this.appliedTick = m.serverTick; // this is now our baseline; ACK it on next input
      this.connected = true; // snapshots flowing ⇒ we're synced
      // time the gap since the last snapshot for the rate + jitter readout. A huge
      // gap (backgrounded tab / a reconnect keyframe) is discarded so it can't
      // poison the jitter estimate — start a fresh window instead.
      const t = nowMs();
      if (this.lastSnapAt !== null) {
        const gap = t - this.lastSnapAt;
        if (gap < 1000) {
          this.snapGaps.push(gap);
          if (this.snapGaps.length > SNAP_WINDOW) this.snapGaps.shift();
        } else {
          this.snapGaps.length = 0;
        }
      }
      this.lastSnapAt = t;
    } else if (m.t === 'pong') {
      // round-trip sample → exponentially-weighted moving average (favour recent)
      const sample = nowMs() - m.ts;
      this.rttMs = this.rttMs === null ? sample : this.rttMs * 0.6 + sample * 0.4;
      // also keep the RAW sample for the ping graph (spikes the EWMA would smooth away)
      this.rttSamples.push(sample);
      if (this.rttSamples.length > RTT_HISTORY) this.rttSamples.shift();
    } else if (m.t === 'spectators') {
      this.spectators = m.n;
    } else if (m.t === 'rematch') {
      this.rematch = { votes: m.votes, need: m.need, mine: m.you };
    } else if (m.t === 'matchArchive') {
      this.archiveMatchId = m.matchId;
    } else if (m.t === 'matchResult') {
      this.matchResult = {
        kind: m.kind,
        record: m.record,
        result: m.result,
        replay: m.replay,
        // present only for the host, and only from a server that mints one
        matchId: this.archiveMatchId ?? undefined,
      };
      this.resultCb?.(this.matchResult);
    } else if (m.t === 'eloResult') {
      this.eloResults = m.results;
    } else if (m.t === 'recordResult') {
      this.recordResult = m.info;
    } else if (m.t === 'serverNotice') {
      setServerNotice(m.message ? { kind: m.kind, message: m.message, until: m.until } : null);
    } else if (m.t === 'siteStatus') {
      applyPushedStatus(m.lockdown ?? null, m.banners ?? []);
    } else if (m.t === 'matchStart') {
      // a host restart: adopt the new seed/setups/game and rebuild
      this.seed = m.seed;
      this.setups = m.setups;
      if (m.game) this.game = m.game;
      // ALWAYS re-read, never `if (m.physics)`: a restart may take a room from '3d' back to
      // absent, and a stale '3d' here would have the client predict a pipeline the server is
      // no longer running. Absent means '2d', so read it as such.
      this.physics = m.physics ?? '2d';
      this.gen = m.gen ?? 0;
      this.rematch = { votes: 0, need: 0, mine: false }; // a new match, a clean tally
      this.ranked = m.ranked ?? false;
      this.intros = m.intros ?? [];
      // ALWAYS re-read, for the reason `physics` two statements up is: a recycled room can
      // start a match with a different set of people in it, and a stale name would label the
      // new driver with the old one's.
      this.drivers = m.drivers ?? [];
      this.rebuildNames();
      this.eloResults = [];
      this.snapshot = null;
      this.matchResult = null;
      // a rematch is a DIFFERENT match and the server mints it a new id; carrying the old
      // capability forward would file the new match under the previous one's row
      this.archiveMatchId = null;
      this.recordResult = null;
      this.baseBalls.clear();
      this.appliedTick = -1; // fresh world starts at tick 0; don't reject its snapshots
      this.hold = null; // a rematch is held (or not) on its own terms; the room will say
      this.lateStart = null;
      this.restartCb?.();
    } else if (m.t === 'roster') {
      // THE ONLY THING THIS SESSION WANTS FROM A ROSTER: who holds the crown. The room
      // broadcasts one whenever somebody leaves, and a host who leaves passes it on
      // (`Room.passCrown`) — so without this the player who INHERITED the room would be
      // shown no host controls and the room would look stuck to everyone in it.
      this.host = m.hostId !== '' && m.hostId === this.clientId;
    } else if (m.t === 'welcome') {
      // a reattach re-sends this; keep the seat credential current (see the field note)
      if (m.seatToken) this.seatToken = m.seatToken;
    } else if (m.t === 'lobby') {
      /**
       * THE ROOM IS A LOBBY AGAIN. The match this session was built around no longer
       * exists server-side, so there is nothing left here to reconcile, predict or render
       * — the App hands the socket to a `LobbyClient` and shows the room. Marked
       * disconnected first so anything still reading this session in the same frame sees
       * a session that is over rather than one that is merely quiet.
       */
      this.connected = false;
      // the recycle re-states the seat's secret (a current server); the App hands it on
      if (m.seatToken) this.seatToken = m.seatToken;
      this.lobbyCb?.(m.clientId);
    } else if (m.t === 'rejoined') {
      if (!m.ok) {
        // the grace window lapsed / the match is gone — the held slot can't be
        // reclaimed. Surface it as a hard failure so the HUD shows the "connection
        // lost" panel (MENU/refresh) instead of spinning "reconnecting" forever.
        this.connected = false;
        this.failed = true;
        this.refused = true;
        this.transport.close();
      } else if (typeof m.gen === 'number') {
        /**
         * ADOPT THE ROOM'S GENERATION. A session rebuilt from a SAVED `matchStart` holds
         * whatever that record carried, which is a generation behind the moment the room
         * has rematched — and an input stamped with a stale one is dropped by the server,
         * so the robot stops responding entirely. The room states it on the way back in;
         * an older server sends nothing and we keep what we had.
         */
        this.gen = m.gen;
      }
      // a reclaimed seat says it can play again, in case the report was lost with the socket
      if (m.ok) this.viewSentGen = -1;
    }
    // 'drop' is reflected in the next snapshot already; nothing to do here
  }
}
