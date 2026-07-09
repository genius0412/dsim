import * as C from '../src/config';
import { START_POSES } from '../src/config';
import { createWorld, coerceAutoPath, DEFAULT_SPEC, DEFAULT_ASSISTS, type RobotSetup } from '../src/sim/spawn';
import { step } from '../src/sim/world';
import { physicsReady } from '../src/sim/physicsEngine';
import { ReplayRecorder, worldResult, type Replay, type ReplayResult } from '../src/sim/replay';
import type {
  Alliance,
  Artifact,
  AssistConfig,
  DrivetrainType,
  RobotCommand,
  RobotSpec,
  World,
} from '../src/types';
import {
  dequantizeCommand,
  quantizeCommand,
  slimWorld,
  roomCapacity,
  DEFAULT_ROOM_CONFIG,
  type BallDelta,
  type ClientMsg,
  type EloDelta,
  type LobbyPlayer,
  type PlayerIntro,
  type QCommand,
  type RecordRankInfo,
  type RoomConfig,
  type ServerMsg,
} from '../src/net/protocol';
import { sanitizePlayerPatch } from '../src/net/sanitize';
import type { EloOutcome } from './ranked';
import type { PendingMatch } from './matchTypes';

/** what the persistence layer resolves to after a finished match: ranked ELO
 * deltas (versus) or a record run's leaderboard standing (record). */
export interface PersistOutcome {
  elo?: EloOutcome[];
  record?: RecordRankInfo;
}

const ZERO_CMD: RobotCommand = { driveX: 0, driveY: 0, rotate: 0, leftDrive: 0, rightDrive: 0, intake: false, fire: false };
/** send an authoritative snapshot every N ticks. 2 = 30 Hz: the client hard-snaps
 * to each snapshot, so a higher rate means smaller, more frequent corrections =>
 * less visible stutter between them (bumped from 3/20 Hz for smoothness). Sending
 * every tick (1) saturates the event loop + starves the /health probe and bursts
 * snapshots; 30 Hz is the balance. Delta-encoding (Phase 1) keeps each frame small,
 * so the ~50% more frames over 20 Hz is cheap. */
const SNAPSHOT_INTERVAL = 2;
/** how many ticks to keep re-applying a robot's last command when its next input
 * hasn't arrived (absorbs jitter without freezing); past this it coasts to ZERO */
const HOLD_TICKS = 15;
/** hold a disconnected driver's slot this long for a reconnect before dropping */
const RECONNECT_GRACE_MS = 15000;
/** a staged ranked match waits this long for every paired player to (re)connect to
 * the host machine before it gives up and cancels (a no-show ⇒ no rated match) */
const RANKED_JOIN_GRACE_MS = 20000;
/** ranked pre-match STRATEGY window: once everyone has connected, drivers see their
 * alliance's builds, re-pick, claim a close/far start pose, and ready up. The match
 * begins the instant all ready; if anyone hasn't readied by the deadline the match
 * is CANCELLED (user decision — strict, so nobody waits forever on an idle player). */
const STRATEGY_DURATION_MS = 60000;

export interface Client {
  id: string;
  send: (m: ServerMsg) => void;
  player: LobbyPlayer;
  /** false while the socket is dropped (within the reconnect grace) */
  connected: boolean;
  /** ms epoch the socket dropped (0 = connected) */
  disconnectAt: number;
  /** the authenticated user id (Neon Auth subject), set once the client proves a
   * session; leaderboard/ELO writes attribute to it. Absent ⇒ anonymous run. */
  userId?: string;
  /** protocol capabilities this client build advertised on join/queue (mixed-version
   * safe: a room opens the strategy window only if EVERY member supports 'strategy') */
  caps?: string[];
}

/** one driver's outcome in a finished match (for persistence) */
export interface MatchParticipant {
  clientId: string;
  userId?: string;
  handle?: string;
  alliance: Alliance;
  drivetrain: DrivetrainType;
  score: number;
  /** the full robot config this driver used (for record-board display) */
  spec: RobotSpec;
  assists: AssistConfig;
}

/** everything the persistence layer needs when a match reaches phase 'post' */
export interface MatchOutcome {
  config: RoomConfig;
  /** true only for matchmade ranked rooms; custom versus rooms persist for the
   * history + replay but do NOT move ELO */
  ranked: boolean;
  result: ReplayResult;
  replay: Replay;
  participants: MatchParticipant[];
}

/**
 * One room: lobby while `world` is null, then the authoritative match loop. The
 * server runs the SHARED `step()` from src/sim (no fork). It consumes each
 * client's input INDEXED BY TICK (a small jitter buffer) so the command sequence
 * it steps matches exactly what that client predicted — otherwise the client
 * mispredicts and every snapshot yanks its robot back (jitter). A driver that
 * drops mid-match keeps its slot for RECONNECT_GRACE_MS (its robot coasts to
 * ZERO) so it can `reattach`; only if the grace lapses is the robot dropped for
 * good — broadcast so the degrade is identical everywhere and never stalls.
 */
export class Room {
  private readonly clients = new Map<string, Client>();
  private hostId = '';

  private world: World | null = null;
  private readonly robotOf = new Map<string, number>(); // clientId -> robotId
  // per robot: future inputs keyed by the tick they apply to (consumed in order)
  private readonly pending = new Map<number, Map<number, RobotCommand>>();
  private readonly held = new Map<number, RobotCommand>(); // robotId -> last applied cmd
  // for LENIENT input: the freshest command a client sent (by tick) + when we last
  // heard from it, so a slightly-late input still moves the robot instead of being
  // dropped (which froze laggy players at spawn)
  private readonly latest = new Map<number, RobotCommand>();
  private readonly latestTick = new Map<number, number>();
  private readonly lastRecvTick = new Map<number, number>();
  private readonly ackTick = new Map<string, number>(); // clientId -> newest input tick
  private readonly dropped = new Set<number>();
  private loop: ReturnType<typeof setInterval> | null = null;
  // delta-snapshot state: last-sent balls (id -> JSON) + clients holding a baseline
  private prevBalls = new Map<number, string>();
  private readonly snapPrimed = new Set<string>();
  // the command each robot ran on the latest tick (sent so clients predict remotes)
  private lastFrame = new Map<number, RobotCommand>();
  // recording: captures the input log for this match; finalized once at phase 'post'
  private recorder: ReplayRecorder | null = null;
  private finalized = false;
  // world.time at which phase 'post' began, to hold the settle window before
  // finalizing (null until the match ends)
  private postSince: number | null = null;
  // authed players who LEFT mid-match (robotId -> identity). Their robot stays in
  // the world coasting at ZERO, but their client object is gone once grace lapses,
  // so they'd drop out of the finalize roster and the match would become unratable
  // (one alliance). Retaining them keeps an abandoned ranked match RATED: the
  // player who stayed wins on score + gains rating; the leaver takes the loss.
  private departed = new Map<number, { userId: string; handle: string; assists: AssistConfig }>();
  // ranked matchmaking rooms carry each driver's ELO so the client can play a
  // pre-match intro; set by the Matchmaker before the match starts (keyed by the
  // robot id assigned in startMatch = the client's add-order index)
  private ranked = false;
  private intros: PlayerIntro[] = [];
  // set on the HOST machine when this room was staged by the designated matchmaker
  // (region-aware ranked). The roster is authoritative; the match starts once every
  // staged player has (re)connected here, or cancels after RANKED_JOIN_GRACE_MS.
  private pendingMatch: PendingMatch | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  // ranked lifecycle: 'connecting' while paired players are still arriving, then
  // 'strategy' during the pre-match coordination window, then 'match' once the world
  // is built. Custom rooms skip 'strategy' (connecting → match). `world===null` still
  // means "not in a match" (true for both connecting and strategy).
  private phase: 'connecting' | 'strategy' | 'match' = 'connecting';
  private strategyDeadline = 0;
  private strategyTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly slotOf = new Map<string, number>(); // clientId -> roster slot (= robotId)

  constructor(
    readonly code: string,
    /** called when the room empties, so the registry can drop it */
    private readonly onEmpty: () => void,
    /** what this room runs (versus PvP vs. record-chasing); set at creation */
    readonly config: RoomConfig = DEFAULT_ROOM_CONFIG,
    /** invoked once at phase 'post' with the authoritative outcome, so the DB
     * layer can persist it. DB-agnostic: tests/dev pass nothing. May resolve to
     * the per-player overall-ELO changes (ranked), which the room then broadcasts
     * as `eloResult` for the results screen. */
    private readonly onResult?: (o: MatchOutcome) => void | Promise<PersistOutcome | void>,
  ) {}

  /** true if a fresh driver can still join (room not full, not mid-match, and not
   * already locked into the pre-match strategy window) */
  canJoin(): boolean {
    return (
      this.clients.size < roomCapacity(this.config) &&
      this.world === null &&
      this.phase !== 'strategy'
    );
  }

  /** authoritative sim tick (0 before the match starts) */
  get tick(): number {
    return this.world?.tick ?? 0;
  }

  add(client: Client): void {
    this.clients.set(client.id, client);
    if (!this.hostId) this.hostId = client.id;
    client.send({ t: 'welcome', clientId: client.id });
    this.broadcastRoster();
  }

  /** a socket dropped. In the lobby that's an outright leave; mid-match the slot
   * is HELD for the reconnect grace (the robot coasts to ZERO meanwhile). */
  detach(id: string): void {
    const c = this.clients.get(id);
    if (!c) return;
    if (this.world === null) {
      // a drop during the ranked strategy window can't be rated one-sided and the
      // reconnect path (a fresh `join`) can't reclaim a held pre-match slot — so a
      // pre-match departure CANCELS the staged match (both drivers requeue). Full
      // strategy-phase reconnection is deferred (see docs/netcodeplan.md).
      if (this.pendingMatch && this.phase === 'strategy') {
        this.cancelPending('Match cancelled — a player disconnected.');
        return;
      }
      this.clients.delete(id);
      this.snapPrimed.delete(id);
      if (this.hostId === id) this.hostId = this.clients.keys().next().value ?? '';
      this.robotOf.delete(id);
      this.broadcastRoster();
      if (this.clients.size === 0) {
        this.stop();
        this.onEmpty();
      }
    } else {
      c.connected = false;
      c.disconnectAt = Date.now();
      this.broadcastRoster();
    }
  }

  /** reclaim a held slot on a fresh socket (within the grace). Returns false if
   * unknown or the slot was already finalized/dropped. */
  reattach(id: string, send: (m: ServerMsg) => void): boolean {
    const c = this.clients.get(id);
    if (!c || c.connected) return false;
    c.send = send;
    c.connected = true;
    c.disconnectAt = 0;
    this.snapPrimed.delete(id); // lost its baseline — force a full keyframe
    send({ t: 'welcome', clientId: id });
    send({ t: 'rejoined', ok: true });
    if (this.world) this.sendSnapshotTo(c); // immediate full resync (re-primes)
    this.broadcastRoster();
    return true;
  }

  /** finalize any disconnected driver whose grace has lapsed: drop its robot to
   * ZERO for good (broadcast) and free the slot */
  private checkGrace(): void {
    // hot path: this runs every tick (60 Hz). Disconnects are rare, so avoid the
    // array-spread allocation + Date.now() unless a slot is actually being held.
    let anyDown = false;
    for (const c of this.clients.values()) {
      if (!c.connected) {
        anyDown = true;
        break;
      }
    }
    if (!anyDown) return;
    const now = Date.now();
    for (const c of [...this.clients.values()]) {
      if (c.connected || now - c.disconnectAt <= RECONNECT_GRACE_MS) continue;
      const rid = this.robotOf.get(c.id);
      if (rid !== undefined && !this.dropped.has(rid)) {
        this.dropped.add(rid);
        this.broadcast({ t: 'drop', robotId: rid, tick: (this.world as World).tick });
      }
      // mid-match departure of an authed player: retain them so the match is still
      // rated (abandonment = a rated loss for them, a win for whoever stayed)
      if (this.world !== null && c.userId && rid !== undefined) {
        this.departed.set(rid, { userId: c.userId, handle: c.player.name, assists: c.player.assists });
      }
      this.clients.delete(c.id);
      this.snapPrimed.delete(c.id);
      this.robotOf.delete(c.id);
      this.ackTick.delete(c.id);
    }
    if (this.clients.size === 0) {
      this.stop();
      this.onEmpty();
    }
  }

  onMessage(id: string, msg: ClientMsg): void {
    const c = this.clients.get(id);
    if (!c) return;
    switch (msg.t) {
      case 'update': {
        // sanitize the patch against this player's current config: a spoofed
        // spec/size/assist patch is clamped to legal ranges before it applies
        const patch = sanitizePlayerPatch(msg.patch, c.player);
        // in the ranked strategy window, alliance is server-authoritative (staged by
        // the matchmaker) — a client may re-pick its spec / pose / ready, never its
        // side, or two partners could stack one alliance.
        if (this.pendingMatch && this.phase === 'strategy') delete patch.alliance;
        Object.assign(c.player, patch);
        this.broadcastRoster();
        if (this.phase === 'strategy') this.maybeBeginRanked();
        break;
      }
      case 'start':
        // physics WASM may still be loading in the first moment after boot; refuse
        // rather than throw inside step() (which would kill the tick loop)
        if (id === this.hostId && this.world === null) {
          if (physicsReady()) this.startMatch();
          else c.send({ t: 'error', message: 'Server is starting up — try again in a moment.' });
        }
        break;
      case 'restart':
        if (id === this.hostId && physicsReady()) this.startMatch();
        break;
      case 'input':
        this.onInput(id, msg.tick, msg.q);
        break;
      case 'join':
        break; // join is handled at the connection layer
    }
  }

  private onInput(id: string, tick: number, q: QCommand): void {
    const rid = this.robotOf.get(id);
    if (rid === undefined || this.dropped.has(rid)) return;
    const cmd = dequantizeCommand(q);
    // track the freshest command by tick (even if it's now in the past) — this is
    // what a late input still contributes, so the robot keeps moving
    if (tick > (this.latestTick.get(rid) ?? -1)) {
      this.latestTick.set(rid, tick);
      this.latest.set(rid, cmd);
    }
    if (this.world) this.lastRecvTick.set(rid, this.world.tick); // liveness
    // ALSO buffer FUTURE inputs by exact tick — an on-time client's robot then
    // matches its own prediction exactly (smooth); a late one falls back to latest
    const w = this.world;
    if (!w || tick > w.tick) {
      let buf = this.pending.get(rid);
      if (!buf) {
        buf = new Map();
        this.pending.set(rid, buf);
      }
      buf.set(tick, cmd);
    }
    if (tick > (this.ackTick.get(id) ?? -1)) this.ackTick.set(id, tick);
  }

  private startMatch(): void {
    const record = this.config.kind === 'record';
    // record runs are OPPONENT-FREE co-op: every robot on one alliance (blue).
    // duo additionally requires both robots the SAME drivetrain (the board is
    // segmented by drivetrain) — refuse to start a mismatched duo.
    if (record && this.config.record === 'duo') {
      const dts = new Set([...this.clients.values()].map((c) => c.player.spec.drivetrain));
      if (this.clients.size >= 2 && dts.size > 1) {
        this.broadcast({
          t: 'error',
          message: 'Duo record runs need both robots on the same drivetrain.',
        });
        return;
      }
    }
    // build setups from the current roster; keep start poses distinct per alliance
    const roster = [...this.clients.values()];
    const used: Record<Alliance, Set<number>> = { red: new Set(), blue: new Set() };
    const setups: RobotSetup[] = [];
    this.robotOf.clear();
    roster.forEach((c, i) => {
      const alliance: Alliance = record ? 'blue' : c.player.alliance;
      let si = c.player.startIndex ?? 0;
      // find an unused pose, but stop after a full cycle: with more robots on one
      // alliance than there are START_POSES (ROOM_CAPACITY 4 > 3 poses — e.g. a
      // custom 4-on-one room), every pose is taken and an unbounded `while` would
      // spin forever, hanging the tick loop / health probe until Fly kills the box.
      // Reuse a pose instead (the physics solver pushes the overlap apart).
      for (let n = 0; n < START_POSES.length && used[alliance].has(si); n++) {
        si = (si + 1) % START_POSES.length;
      }
      used[alliance].add(si);
      setups.push({
        id: i,
        alliance,
        spec: c.player.spec,
        assists: c.player.assists,
        startIndex: si,
        autoPath: c.player.autoPath, // Include autoPath
        autoPathEnabled: c.player.autoPathEnabled, // Include autoPathEnabled
      });
      this.robotOf.set(c.id, i);
    });

    const seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
    this.beginMatch(setups, seed);
  }

  /** shared world-init + `matchStart` broadcast + loop, for the host-handshake,
   * matchmaker, and ranked-from-pending paths. The caller must have built `setups`
   * and populated `robotOf` first. */
  private beginMatch(setups: RobotSetup[], seed: number): void {
    this.phase = 'match';
    const world = createWorld('match', seed, setups);
    world.match.preCountdown = C.PRE_COUNTDOWN; // sim-driven pre→auto, same as the client
    this.world = world;
    this.pending.clear();
    this.held.clear();
    this.latest.clear();
    this.latestTick.clear();
    this.lastRecvTick.clear();
    this.ackTick.clear();
    this.dropped.clear();
    this.prevBalls.clear();
    this.snapPrimed.clear();
    // start recording the input log; finalized once at phase 'post'
    this.recorder = new ReplayRecorder(seed, setups, 'match');
    this.finalized = false;
    this.postSince = null;
    this.departed.clear();

    for (const c of this.clients.values()) {
      c.send({
        t: 'matchStart',
        seed,
        setups,
        yourRobotId: this.robotOf.get(c.id) ?? 0,
        ranked: this.ranked,
        intros: this.ranked ? this.intros : undefined,
      });
    }
    this.startLoop();
  }

  // ---- region-aware ranked: host-side build from a staged roster --------------

  /** stage this room as the host for a matchmaker-paired ranked match. The roster
   * (specs/alliances/seed) is authoritative; the match begins once every staged
   * player reconnects (`maybeStartRanked`) or cancels after the join grace. */
  applyPending(p: PendingMatch): void {
    this.pendingMatch = p;
    this.ranked = true;
    this.intros = p.roster.map((r, i) => ({ id: i, elo: r.introElo }));
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => this.cancelPending(), RANKED_JOIN_GRACE_MS);
    if (this.pendingTimer.unref) this.pendingTimer.unref();
    this.maybeStartRanked(); // in case everyone is already here
  }

  /** the room code this room was staged under (null if not a staged ranked room) */
  pendingCode(): string | null {
    return this.pendingMatch?.code ?? null;
  }

  /** start the staged match once every roster member (by verified user id) is
   * connected. Called after each client's identity resolves. */
  maybeStartRanked(): void {
    const p = this.pendingMatch;
    if (!p || this.world !== null || this.phase !== 'connecting') return;
    const present = new Set(
      [...this.clients.values()].filter((c) => c.connected && c.userId).map((c) => c.userId),
    );
    const allHere = p.roster.every((r) => r.userId && present.has(r.userId));
    if (!allHere) return;
    // everyone's here: stop waiting for connections.
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    // MIXED-VERSION SAFETY: open the pre-match strategy window only if EVERY connected
    // client understands it. If any is an OLD build (didn't advertise the 'strategy'
    // cap), start immediately with the STAGED specs — the pre-strategy behavior — so
    // one server can serve alpha/beta/main clients at once without stranding anyone.
    const allSupport = [...this.clients.values()].every(
      (c) => c.connected && c.caps?.includes('strategy'),
    );
    if (allSupport) this.enterStrategy();
    else this.startRankedImmediate();
  }

  /** legacy ranked start (no strategy window): build setups straight from the STAGED
   * roster and begin. Used when any paired client is an old build that can't render
   * the strategy screen. Old clients can't re-pick, so the staged spec is what they
   * queued with — correct. */
  private startRankedImmediate(): void {
    const p = this.pendingMatch;
    if (!p || this.world !== null || this.phase !== 'connecting') return;
    if (!physicsReady()) {
      setTimeout(() => this.startRankedImmediate(), 200); // WASM still loading; retry
      return;
    }
    const byUser = new Map<string, Client>();
    for (const c of this.clients.values()) if (c.userId) byUser.set(c.userId, c);
    const setups: RobotSetup[] = [];
    this.robotOf.clear();
    p.roster.forEach((r, i) => {
      // the staged autoPath is a serialized string (and in practice unset); coerce it
      // to the AutoPathData shape RobotSetup expects (createWorld re-coerces anyway).
      const autoPath = coerceAutoPath(r.autoPath) ?? undefined;
      setups.push({
        id: i,
        alliance: r.alliance,
        spec: r.spec,
        assists: r.assists,
        startIndex: r.startIndex,
        autoPath,
        autoPathEnabled: autoPath ? r.autoPathEnabled === true : false,
      });
      const c = r.userId ? byUser.get(r.userId) : undefined;
      if (c) this.robotOf.set(c.id, i);
    });
    this.beginMatch(setups, p.seed);
  }

  /** open the pre-match STRATEGY window: seed each client's authoritative identity
   * (alliance + default pose from the staged roster), reset ready, arm the strict
   * deadline, and switch every client to the strategy screen. Spec/assists stay as
   * the client supplied on join — that's the re-pick baseline. */
  private enterStrategy(): void {
    const p = this.pendingMatch;
    if (!p || this.world !== null || this.phase !== 'connecting') return;
    const byUser = new Map<string, Client>();
    for (const c of this.clients.values()) if (c.userId) byUser.set(c.userId, c);
    this.slotOf.clear();
    p.roster.forEach((r, i) => {
      const c = r.userId ? byUser.get(r.userId) : undefined;
      if (!c) return;
      this.slotOf.set(c.id, i); // roster index = robotId
      c.player.alliance = r.alliance; // authoritative (client can't change it)
      c.player.startIndex = r.startIndex; // default claim; the driver may re-pick
      c.player.ready = false;
    });
    this.phase = 'strategy';
    this.strategyDeadline = Date.now() + STRATEGY_DURATION_MS;
    this.strategyTimer = setTimeout(() => this.onStrategyDeadline(), STRATEGY_DURATION_MS);
    if (this.strategyTimer.unref) this.strategyTimer.unref();
    for (const c of this.clients.values()) {
      c.send({
        t: 'strategyStart',
        deadline: this.strategyDeadline,
        yourRobotId: this.slotOf.get(c.id) ?? 0,
        mode: p.mode,
        intros: this.intros,
      });
    }
    this.broadcastRoster(); // redacted per-recipient (opponent builds hidden)
  }

  /** start as soon as every connected driver has readied up */
  private maybeBeginRanked(): void {
    const p = this.pendingMatch;
    if (!p || this.phase !== 'strategy' || this.world !== null) return;
    const connected = [...this.clients.values()].filter((c) => c.connected);
    if (connected.length === p.roster.length && connected.every((c) => c.player.ready)) {
      this.beginRanked();
    }
  }

  /** the strategy deadline fired: STRICT — start only if everyone readied in time,
   * otherwise cancel the match (nobody waits forever on an idle player). */
  private onStrategyDeadline(): void {
    this.strategyTimer = null;
    const p = this.pendingMatch;
    if (!p || this.phase !== 'strategy' || this.world !== null) return;
    const connected = [...this.clients.values()].filter((c) => c.connected);
    if (connected.length === p.roster.length && connected.every((c) => c.player.ready)) {
      this.beginRanked();
    } else {
      this.cancelPending('Match cancelled — not everyone readied up in time.');
    }
  }

  /** build the authoritative setups from the LIVE (re-picked) roster and start the
   * match. Alliance/seed stay authoritative from the staged `PendingMatch`; the spec
   * is taken live (already clamped by `sanitizePlayerPatch`/`coerceSpec`, and again
   * by `createWorld`→`coerceSetup`). A missing/dropped slot ⇒ cancel (unratable). */
  private beginRanked(): void {
    const p = this.pendingMatch;
    if (!p || this.world !== null || this.phase !== 'strategy') return;
    if (!physicsReady()) {
      setTimeout(() => this.beginRanked(), 200); // WASM still loading; retry shortly
      return;
    }
    if (this.strategyTimer) {
      clearTimeout(this.strategyTimer);
      this.strategyTimer = null;
    }
    const byUser = new Map<string, Client>();
    for (const c of this.clients.values()) if (c.connected && c.userId) byUser.set(c.userId, c);
    if (!p.roster.every((r) => r.userId && byUser.has(r.userId))) {
      this.cancelPending('Match cancelled — an opponent disconnected.');
      return;
    }
    // roster index = robotId; keep start poses distinct per alliance as an AFK fallback
    const used: Record<Alliance, Set<number>> = { red: new Set(), blue: new Set() };
    const setups: RobotSetup[] = [];
    this.robotOf.clear();
    p.roster.forEach((r, i) => {
      const c = byUser.get(r.userId as string) as Client;
      let si = c.player.startIndex ?? 0;
      for (let n = 0; n < START_POSES.length && used[r.alliance].has(si); n++) {
        si = (si + 1) % START_POSES.length;
      }
      used[r.alliance].add(si);
      setups.push({
        id: i,
        alliance: r.alliance, // authoritative (from the staged roster)
        spec: c.player.spec, // LIVE re-picked build
        assists: c.player.assists,
        startIndex: si,
        autoPath: c.player.autoPath,
        autoPathEnabled: c.player.autoPathEnabled,
      });
      this.robotOf.set(c.id, i);
    });
    this.beginMatch(setups, p.seed);
  }

  /** a staged ranked match no player (or not everyone) showed up for: tell whoever
   * did connect and tear the room down (no rated match runs). */
  private cancelPending(message = 'Match cancelled — an opponent did not connect.'): void {
    if (this.world !== null) return; // already started
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (this.strategyTimer) {
      clearTimeout(this.strategyTimer);
      this.strategyTimer = null;
    }
    this.broadcast({ t: 'error', message });
    this.stop();
    this.onEmpty();
  }

  private startLoop(): void {
    this.stop();
    let last = Date.now();
    let acc = 0;
    this.loop = setInterval(() => {
      // a throw here would otherwise kill the whole process (every room) and Fly
      // would report "app not listening" — contain it to this tick instead
      try {
        this.checkGrace(); // finalize any driver whose reconnect grace has lapsed
        if (this.clients.size === 0) return; // room emptied (loop already stopped)
        const now = Date.now();
        acc += (now - last) / 1000;
        last = now;
        if (acc > 0.25) acc = 0.25; // never fast-forward more than a quarter second
        let n = 0;
        while (acc >= C.SIM_DT && n < 8 && !this.finalized) {
          this.stepOnce();
          acc -= C.SIM_DT;
          n++;
        }
      } catch (e) {
        console.error(`[room ${this.code}] tick error at tick ${this.world?.tick}:`, e);
      }
    }, 1000 * C.SIM_DT);
  }

  /** advance the authoritative sim exactly one tick: build the per-robot command
   * frame, step, RECORD it (the replay input log), snapshot on cadence, and
   * finalize at match end. Both the real-time loop and `advanceForTest` go
   * through here, so recording is identical live and headless. */
  private stepOnce(): void {
    const w = this.world as World;
    this.lastFrame = this.frameCommands(w.tick + 1);
    step(w, C.SIM_DT, this.lastFrame);
    this.recorder?.record(w.tick, this.lastFrame);
    if (w.tick % SNAPSHOT_INTERVAL === 0) this.broadcastSnapshot();
    // Don't finalize the instant the match ends: balls are still flowing down the
    // ramp/through the gate and scoring for a beat. Keep stepping (and recording)
    // through a settle window so the authoritative score we save is the SETTLED
    // one the client reveals at the whoosh — not an early undercount.
    if (w.match.phase === 'post' && !this.finalized) {
      if (this.postSince === null) this.postSince = w.time;
      if (w.time - this.postSince >= C.MATCH_SETTLE_S) this.finalizeMatch();
    }
  }

  /** the match reached phase 'post': broadcast the SERVER's authoritative score +
   * the recorded replay (the leaderboard submission), then stop the loop but keep
   * clients connected for the results screen. Idempotent (fires once). Phase 3's
   * DB layer persists `result`/`replay` from here. */
  private finalizeMatch(): void {
    if (this.finalized || !this.world || !this.recorder) return;
    this.finalized = true;
    const w = this.world;
    const replay: Replay = this.recorder.finish();
    const result = worldResult(w);
    this.broadcast({ t: 'matchResult', kind: this.config.kind, record: this.config.record, result, replay });
    // hand the authoritative outcome to the persistence layer (off the hot path)
    if (this.onResult) {
      const participants: MatchParticipant[] = [];
      // capture userId → robotId so the async ELO result can be re-keyed to robots
      const robotByUser = new Map<string, number>();
      for (const c of this.clients.values()) {
        const rid = this.robotOf.get(c.id);
        const robot = rid !== undefined ? w.robots.find((r) => r.id === rid) : undefined;
        if (!robot) continue;
        if (c.userId) robotByUser.set(c.userId, robot.id);
        participants.push({
          clientId: c.id,
          userId: c.userId,
          handle: c.player.name,
          alliance: robot.alliance,
          drivetrain: robot.spec.drivetrain,
          score: w.match.scores[robot.alliance].total,
          spec: robot.spec,
          assists: c.player.assists,
        });
      }
      // include authed players who LEFT mid-match (their robot is still in the
      // world at zero) so an abandoned ranked match is still rated
      for (const [rid, d] of this.departed) {
        if (robotByUser.has(d.userId)) continue; // reconnected / still present
        const robot = w.robots.find((r) => r.id === rid);
        if (!robot) continue;
        robotByUser.set(d.userId, robot.id);
        participants.push({
          clientId: '',
          userId: d.userId,
          handle: d.handle,
          alliance: robot.alliance,
          drivetrain: robot.spec.drivetrain,
          score: w.match.scores[robot.alliance].total,
          spec: robot.spec,
          assists: d.assists,
        });
      }
      const ret = this.onResult({ config: this.config, ranked: this.ranked, result, replay, participants });
      // resolves once persisted (async DB write): versus → per-driver ELO deltas;
      // record → the run's leaderboard standing. Broadcast so the results screen
      // can reveal the ELO change (versus) or the PB / WR / rank line (record).
      if (ret && typeof (ret as Promise<unknown>).then === 'function') {
        void (ret as Promise<PersistOutcome | void>)
          .then((out) => {
            if (!out || this.clients.size === 0) return;
            if (out.record) {
              this.broadcast({ t: 'recordResult', info: out.record });
            }
            if (out.elo && out.elo.length) {
              const results: EloDelta[] = [];
              for (const e of out.elo) {
                const robotId = robotByUser.get(e.userId);
                if (robotId !== undefined) {
                  results.push({ robotId, before: e.before, after: e.after, rd: e.rd, games: e.games });
                }
              }
              if (results.length) this.broadcast({ t: 'eloResult', results });
            }
          })
          .catch((err) => console.error('[room] result broadcast failed:', err));
      }
    }
    this.stop();
  }

  /** TEST / TOOL SEAM: drive an already-started match deterministically with NO
   * timers, up to `maxTicks` or match end. Production drives `stepOnce` from the
   * setInterval loop; this lets smoke/tools run a full room match reproducibly. */
  advanceForTest(maxTicks: number): void {
    this.stop(); // drop the real-time timer — the test pumps synchronously
    for (let i = 0; i < maxTicks && this.world && !this.finalized; i++) this.stepOnce();
  }

  /** the command each robot runs at `tick`: its buffered input for that EXACT tick
   * if present (on-time client ⇒ matches its prediction, smooth); else its MOST
   * RECENT command while it's still actively sending (late client ⇒ keeps moving
   * instead of freezing); else ZERO once it's gone quiet for HOLD_TICKS */
  private frameCommands(tick: number): Map<number, RobotCommand> {
    const w = this.world as World;
    const frame = new Map<number, RobotCommand>();
    for (const r of w.robots) {
      if (this.dropped.has(r.id)) {
        frame.set(r.id, ZERO_CMD);
        continue;
      }
      const buf = this.pending.get(r.id);
      const c = buf?.get(tick);
      if (c !== undefined) {
        this.held.set(r.id, c);
        frame.set(r.id, c);
      } else if (w.tick - (this.lastRecvTick.get(r.id) ?? -HOLD_TICKS - 1) <= HOLD_TICKS) {
        // no exact input for this tick, but the client is live ⇒ apply its latest
        const latest = this.latest.get(r.id) ?? this.held.get(r.id) ?? ZERO_CMD;
        this.held.set(r.id, latest);
        frame.set(r.id, latest);
      } else {
        frame.set(r.id, ZERO_CMD); // client went quiet: coast to a stop
      }
      // consumed / past inputs will never be needed again
      if (buf) for (const t of buf.keys()) if (t <= tick) buf.delete(t);
    }
    return frame;
  }

  private stop(): void {
    if (this.loop) {
      clearInterval(this.loop);
      this.loop = null;
    }
  }

  private broadcastSnapshot(): void {
    const w = this.world as World;
    // recompute the ball snapshot once; each client gets a delta (if primed with
    // a baseline) or a full keyframe (the balls that changed = all of them)
    const cur = new Map<number, string>();
    for (const b of w.balls) cur.set(b.id, JSON.stringify(b));
    const changed: Artifact[] = [];
    for (const b of w.balls) if (cur.get(b.id) !== this.prevBalls.get(b.id)) changed.push(b);
    const order = w.balls.map((b) => b.id);
    const slim = slimWorld(w);
    const cmds = this.frameCmds(w);
    for (const c of this.clients.values()) {
      const primed = this.snapPrimed.has(c.id);
      const balls: BallDelta = { order, upd: primed ? changed : w.balls };
      c.send({
        t: 'snapshot',
        serverTick: w.tick,
        w: slim,
        balls,
        cmds,
        ackInputTick: this.ackTick.get(c.id) ?? 0,
      });
      if (!primed) this.snapPrimed.add(c.id);
    }
    this.prevBalls = cur;
  }

  /** full keyframe to one client (reattach resync): all balls, primes the client */
  private sendSnapshotTo(c: Client): void {
    const w = this.world as World;
    c.send({
      t: 'snapshot',
      serverTick: w.tick,
      w: slimWorld(w),
      balls: { order: w.balls.map((b) => b.id), upd: w.balls },
      cmds: this.frameCmds(w),
      ackInputTick: this.ackTick.get(c.id) ?? 0,
    });
    this.snapPrimed.add(c.id);
  }

  /** each robot's last-run command, aligned with `world.robots` order */
  private frameCmds(w: World): QCommand[] {
    return w.robots.map((r) => quantizeCommand(this.lastFrame.get(r.id) ?? ZERO_CMD));
  }

  private broadcast(m: ServerMsg): void {
    for (const c of this.clients.values()) c.send(m);
  }

  private broadcastRoster(): void {
    // a STAGED ranked room must never reveal opponent builds before the redacted
    // strategy roster: while still 'connecting' its clients self-report alliance
    // 'red' (a placeholder), so alliance-based redaction can't work yet — simply
    // withhold the roster until `enterStrategy` sends the redacted one. (The
    // matchmaking client shows no roster while connecting anyway.)
    if (this.pendingMatch && this.phase === 'connecting') return;
    // outside the strategy window everyone sees the same roster (custom lobby / not
    // yet staged): the full build reveal is fine there.
    if (this.phase !== 'strategy') {
      const players = [...this.clients.values()].map((c) => c.player);
      this.broadcast({ t: 'roster', players, hostId: this.hostId });
      return;
    }
    // strategy window: ALLIANCE-ONLY reveal. Each recipient sees its own alliance's
    // builds in full (with the roster `slot` so cards can find ELO), but OPPONENT
    // cards are redacted to name/team/ELO — their spec/assists are neutralized so a
    // client (even via devtools) can't counter-pick the opponent's build pre-match.
    // Opponent detail is revealed only at matchStart (its `setups` carry full specs).
    const all = [...this.clients.values()];
    for (const c of all) {
      const mine = c.player.alliance;
      const players: LobbyPlayer[] = all.map((o) => {
        const slot = this.slotOf.get(o.id);
        if (o.id === c.id || o.player.alliance === mine) return { ...o.player, slot };
        return {
          clientId: o.player.clientId,
          name: o.player.name,
          teamName: o.player.teamName,
          teamNumber: o.player.teamNumber,
          alliance: o.player.alliance,
          startIndex: 0,
          ready: o.player.ready,
          spec: DEFAULT_SPEC,
          assists: DEFAULT_ASSISTS,
          slot,
          hidden: true,
        };
      });
      c.send({ t: 'roster', players, hostId: this.hostId });
    }
  }

  /** TEST SEAM: fire the strategy deadline synchronously (no real timer). */
  forceStrategyDeadlineForTest(): void {
    this.onStrategyDeadline();
  }
}