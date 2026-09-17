/* `crypto.randomUUID` rather than `node:crypto`'s, because this module is bundled for a
   BROWSER as well — the LAN host runs the room in a tab (`docs/lan-webrtc.md`) and a `node:`
   specifier is unresolvable there. The Web Crypto name is the same function and is available
   on Node 19+ and in every browser DSIM supports. */
const randomUUID = (): string => crypto.randomUUID();
import { envVar } from './runtimeEnv';
import * as C from '../src/config';
import { newSettleClock, settleStep, type SettleClock } from '../src/sim/settle';
import { coerceAutoPath, DEFAULT_SPEC, DEFAULT_ASSISTS, type RobotSetup } from '../src/sim/spawn';
import { simModuleFor } from '../src/games/sim';
import { scrubName } from './moderation';
import type { GameId } from '../src/types';
import { physicsReady } from '../src/sim/physicsEngine';
import { ReplayRecorder, worldResult, type Replay, type ReplayResult } from '../src/sim/replay';
import type {
  Alliance,
  Artifact,
  AssistConfig,
  DrivetrainType,
  RobotCommand,
  RobotSpec,
  StartPose,
  World,
} from '../src/types';
import {
  dequantizeCommand,
  sanitizeQCommand,
  encodeMsg,
  quantizeCommand,
  slimWorld,
  roomCapacity,
  DEFAULT_ROOM_CONFIG,
  RANKED_JOIN_GRACE_MS,
  STRATEGY_DURATION_MS,
  type BallDelta,
  type ClientMsg,
  type EloDelta,
  type LiveRoom,
  type LobbyPlayer,
  type PlayerIntro,
  type QCommand,
  type RecordRankInfo,
  type RoomConfig,
  type ServerMsg,
} from '../src/net/protocol';
import { sanitizePlayerPatch } from '../src/net/sanitize';
import type { DodgeKind, DodgeVerdict } from '../src/dodge';
import { chargedForParticipation, judgeParticipation } from '../src/standing';
import { roomPersists } from './channel';
import { eloMode } from './eloMode';
/* TYPE-ONLY, and it has to stay that way: `./ranked` imports `./db/repo`, which imports `pg`.
   A value import here would drag a Postgres driver into the browser bundle — see
   `server/eloMode.ts` and `docs/lan-webrtc.md` §5. */
import type { EloOutcome } from './ranked';
import type { PendingMatch } from './matchTypes';

/** what the room hands the DB layer when a staged ranked pairing dies. The room knows WHO
 *  failed and HOW; the penalty scale and the rolling window live outside it. */
export interface DodgeReport {
  culprits: { userId: string; kind: DodgeKind }[];
  mode: '1v1' | '2v2';
  game: GameId;
  /** every roster member, so the innocent can be told they were not charged */
  rosterUserIds: string[];
  /** the room it died in — recorded on the standing ledger so a moderator reading a
   *  player's history can line an offence up against the match it came from */
  roomCode: string;
}

/**
 * What a finished RANKED match says about the people who played it: who sat it out, who
 * walked away from it, and who simply played it. The room only ever OBSERVES — it counts
 * ticks and classifies them with the pure `judgeParticipation` — so the decision about what
 * any of it costs stays in one place (src/standing.ts) and can be tested without a match.
 */
export interface BehaviourReport {
  offenders: { userId: string; kind: 'afk' | 'leave' }[];
  /**
   * Drivers the referee CARDED in this match, with the colour, so the standing charge can
   * price a red above a yellow. Separate from `offenders` because the two are found
   * differently: an AFK is the server noticing an absence, a card is the sim's own rule
   * engine sanctioning a violation it watched happen.
   */
  carded?: { userId: string; colour: 'yellow' | 'red' }[];
  /** everyone who played it clean, credited toward working a penalty off */
  cleanUserIds: string[];
  mode: '1v1' | '2v2';
  game: GameId;
  roomCode: string;
}

/** what the persistence layer resolves to after a finished match: ranked ELO
 * deltas (versus) or a record run's leaderboard standing (record). */
export interface PersistOutcome {
  elo?: EloOutcome[];
  record?: RecordRankInfo;
  /** the row this match was written as, when it was written. The room keeps it so a MISSCORE
   *  claim filed from the results screen can point at the match a moderator has to open. */
  matchId?: string;
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
/**
 * How far AHEAD of the live tick a buffered input may be stamped.
 *
 * ⚠️ THIS IS A MEMORY BOUND, NOT A GAMEPLAY TUNABLE. `pending` is keyed by the exact tick an
 * input applies to and `frameCommands` only ever deletes keys `<= tick`, so a key the world
 * will never reach is never collected — a client stamping ever-larger ticks at 60 Hz grew the
 * map without limit, and nothing in the room could see it. Found by load testing (see
 * `docs/capacity.md` §7).
 *
 * The value comes from the CLIENT'S OWN CONTRACT: `game.ts` caps prediction at
 * `MAX_PREDICT_LEAD` (40) ticks past the newest authoritative tick and sends `world.tick + 1`,
 * so a legitimate input is never more than ~41 ticks ahead. A stale client sends LOWER ticks,
 * not higher, so lateness cannot push against this bound. 120 is 3× the honest maximum —
 * wide enough that no real client is ever refused, small enough that the map is bounded.
 */
export const MAX_INPUT_LEAD_TICKS = 120;
/**
 * Distinct future ticks held per robot.
 *
 * ⚠️ **THIS CANNOT FIRE TODAY, AND SAYING SO IS THE POINT.** An earlier comment here
 * called it a backstop "for when something is wrong", which reads as a second, independent
 * bound. It is not one: `pending` only ever takes keys in `(w.tick, w.tick + 120]` and
 * `frameCommands` deletes every key the world has reached, so the map holds at most
 * `MAX_INPUT_LEAD_TICKS` entries — 120 — and a duplicate tick overwrites rather than
 * grows. 128 is strictly above that, so the eviction below is UNREACHABLE by construction
 * and `MAX_INPUT_LEAD_TICKS` is the whole of the memory bound.
 *
 * It is kept rather than deleted because it is free and it is the thing that would catch
 * the lead cap being widened, moved, or bypassed by a new buffering path — but a guard
 * nobody can reach is not evidence of anything, so do not read a passing test here as
 * proof that eviction works. `npm test` asserts the RELATIONSHIP (`> MAX_INPUT_LEAD_TICKS`)
 * instead, which is the property that is actually load-bearing.
 */
export const MAX_PENDING_PER_ROBOT = 128;
/** a client whose CONFIRMED snapshot baseline (its piggybacked `ack`) is more than
 * this many ticks behind the live tick is force-resynced with a full keyframe. Wide
 * enough that normal ack round-trip (a few ticks) never trips it — it catches a
 * genuinely wedged/far-behind client (or, later, one that lost a run of unreliable
 * snapshots) rather than letting it drift on deltas keyed to a baseline it no longer
 * has. ~4 s at 60 Hz. */
const ACK_STALE_TICKS = 240;
/**
 * How many recent broadcast frames' CHANGE SETS are retained so a delta can be keyed to an
 * older baseline than the last one sent (see `lossy` in `Client`).
 *
 * Sized to outlast `ACK_STALE_TICKS`: at `SNAPSHOT_INTERVAL` 2 that window is 120 frames, and a
 * client whose ack falls further behind than it is force-resynced with a keyframe anyway — so
 * history running out and the stale-ack resync firing are the SAME event, which is what keeps
 * "no usable baseline" from ever being a state the room has to recover from separately. Each
 * entry is a tick plus the ids that moved on it, so the whole ring is a few thousand ints.
 */
const SNAP_HISTORY_FRAMES = 128;
/** baseline sentinel: "this recipient holds nothing we can diff against, send the whole world".
 *  Safe as a tick value because a world's ticks start at 0 and an ack below 0 is refused. */
const KEYFRAME = -1;
/**
 * Outbound backlog (bytes still queued on the socket) past which a client is SKIPPED for
 * this snapshot instead of being handed another one.
 *
 * A snapshot leaves every 2 ticks whether or not the last one was written, and `ws.send`
 * queues without complaint — so a socket that has stopped draining (a spectator on a phone
 * that walked into a lift, a driver on a dying link) grows an unbounded queue of worlds
 * that are already historical by the time they arrive. Nothing in the room could see that,
 * because the room only ever knows that it CALLED send.
 *
 * Skipping is a COALESCE, not a drop, and that is why `snapPrimed` is cleared with it: the
 * snapshots are DELTAS against the previous broadcast frame, so a client that misses one
 * cannot apply the next. Unpriming makes the next snapshot it does receive a full keyframe
 * of the CURRENT world, which is the only frame worth sending to somebody who has fallen
 * behind anyway. The existing `ACK_STALE_TICKS` resync covers the same failure from the
 * other side (the client's ack falling behind); this one reacts in one frame instead of 240
 * ticks, and, unlike that one, it also stops the memory growing while it waits.
 *
 * 256 KB is ~40 solo snapshots or ~40 2v2 frames uncompressed — far past any normal write
 * burst (a healthy socket's `bufferedAmount` is 0 nearly every time it is read) and well
 * under a figure that would matter per socket at full population.
 */
const SNAP_BACKLOG_BYTES = 256 * 1024;
/** hold a disconnected driver's slot this long for a reconnect before dropping. Long
 * enough to cover a full page reload / navigate-away-and-come-back (the "rejoin your
 * match" flow), not just a transient socket blip. The robot coasts to ZERO meanwhile. */
const RECONNECT_GRACE_MS = 45000;
/** how close to the buzzer a solo record run counts as DECIDED: a driver who leaves inside it
 *  still has the run finished and saved. One second of slack because the client's predicted
 *  clock runs a little ahead of the server's, so "I restarted at 0:00" can land in teleop. */
const RECORD_FINISH_WINDOW_S = 1;
/* BOTH RANKED CLOCKS NOW LIVE IN `src/net/protocol.ts`, and are imported above.
   `RANKED_JOIN_GRACE_MS` is how long a staged match waits for every paired player to
   (re)connect before it cancels as a no-show; `STRATEGY_DURATION_MS` is the pre-match
   window in which drivers see their alliance's builds, re-pick, claim a start pose and
   ready up. The match begins the instant all are ready, and is CANCELLED if anyone has
   not readied by the deadline (user decision: strict, so nobody waits on an idle player).
   They moved because the queue screen states both to the player BEFORE they queue, and a
   rule the client restates from its own copy of the number drifts the first time one of
   them is tuned. */

/** the Fly region this server machine runs in (blank on a single-region / local
 * deploy). Sent to clients at matchStart so the HUD can show "matched on <region>". */
const SERVER_REGION: string = envVar('FLY_REGION') ?? envVar('SERVER_REGION') ?? '';

export interface Client {
  id: string;
  send: (m: ServerMsg) => void;
  /**
   * Send an ALREADY-SERIALIZED message. Optional: a caller that has no socket
   * (every test, and the headless smoke) supplies only `send`, and the room falls
   * back to it.
   *
   * It exists because the room's hot path is a BROADCAST, and encoding is per
   * RECIPIENT. `ws.send(encodeMsg(m))` inside each client's own closure means a
   * 2v2 snapshot — the biggest message the server produces — is stringified FOUR
   * times, once per driver, plus once per spectator, all from the same object.
   * The profile puts protocol encoding at 3.2% of a solo-room machine; that term
   * is linear in the audience while the simulation term is not, so the expensive
   * room is exactly where it is worst. Encoding once and handing everyone the same
   * string removes the multiplier.
   */
  sendRaw?: (s: string) => void;
  /**
   * Bytes this socket has QUEUED but not yet handed to the kernel (`ws.bufferedAmount`).
   * Optional for the same reason `sendRaw` is: a caller with no socket (every test, and
   * the headless smoke) supplies only `send`, and the room then treats the backlog as
   * zero — which is true, because those sends are synchronous array pushes.
   *
   * The room reads it in ONE place, `broadcastSnapshot`, because a snapshot is the only
   * message it produces 30 times a second. A socket that has not drained the last few
   * snapshots cannot be helped by being handed another one: the newest world is the only
   * one worth having, so the frames in between are worth less than the memory they cost.
   */
  backlog?: () => number;
  player: LobbyPlayer;
  /** false while the socket is dropped (within the reconnect grace) */
  connected: boolean;
  /** ms epoch the socket dropped (0 = connected) */
  disconnectAt: number;
  /** the authenticated user id (Neon Auth subject), set once the client proves a
   * session; leaderboard/ELO writes attribute to it. Absent ⇒ anonymous run. */
  userId?: string;
  /**
   * This client's SNAPSHOT LANE CAN DROP FRAMES, so the room may not assume a snapshot it
   * sent was received.
   *
   * Set only by the tab host (`src/lan/hostWorker.ts`), whose guests take snapshots over an
   * unordered `maxRetransmits: 0` DataChannel (`src/net/lanPeer.ts`). A cloud WebSocket is one
   * ordered reliable stream — the previous broadcast either arrived or the socket is gone — so
   * it leaves this unset and keeps the cheaper delta-vs-last-broadcast. See `broadcastSnapshot`
   * for what the flag actually changes.
   */
  lossy?: boolean;
  /** protocol capabilities this client build advertised on join/queue (mixed-version
   * safe: a room opens the strategy window only if EVERY member supports 'strategy') */
  caps?: string[];
  /** release channel this client build reported ('alpha' | 'stable' | …). The first
   * client to join sets the ROOM's channel; alpha rooms are never persisted. */
  channel?: string;
  /** monotonic id of the SOCKET that currently owns this slot, bumped on every
   * (re)attach. A reconnect can arrive before the server has reaped the dropped
   * socket (a partitioned TCP connection lingers for tens of seconds), so the old
   * socket's eventual close must be able to tell it is stale — it carries the conn
   * it was issued and `detach` ignores it if a newer socket has taken over. */
  conn?: number;
  /**
   * A SPECTATOR who is not counted in the visible watcher total.
   *
   * Only ever set by the server after verifying an admin JWT — never from anything
   * a client claims — so an ordinary viewer cannot make themselves invisible. It
   * exists for moderation: watching a suspected cheat play out stops working the
   * moment the count tells them somebody arrived. It changes what players are told
   * about who is watching, so it is disclosed in the privacy policy rather than
   * left as a quiet capability.
   */
  hidden?: boolean;
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
  /** which game was played. Persistence SKIPS unscored games (CR shell) so they
   * never touch ELO/records. Absent ⇒ 'decode'. */
  game?: GameId;
  config: RoomConfig;
  /** true only for matchmade ranked rooms; custom versus rooms persist for the
   * history + replay but do NOT move ELO */
  ranked: boolean;
  /**
   * THE MATCH'S OWN FORMAT, from the room rather than from a head-count of who was still
   * there at the end.
   *
   * `persistVersusMatch` derived it as `eloMode(authed.length)` — 4+ is a 2v2 — which is the
   * survivors and not the format. A 2v2 that ended with three participants (one player gone
   * before the match even began, so neither in `clients` nor in `departed`) was therefore
   * FILED and RATED as a 1v1: the reporter's history shows `RANKED 1V1 · Alex,
   * Lance-14596-36839 vs Mitri`, three names on a 1v1 row, and its −156 landed on the 1v1
   * board. The room has always known better — a staged room carries the queue bucket it was
   * paired in, and every room knows how many robots it fielded.
   *
   * Absent ⇒ the old head-count, which is all a LAN upload or an older caller can offer.
   */
  mode?: '1v1' | '2v2';
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
  // READ-ONLY watchers: receive every broadcast (roster/matchStart/snapshot/result)
  // but hold no robot slot and never count toward capacity/roster/persistence.
  private readonly spectators = new Map<string, Client>();
  private hostId = '';
  /** the seat `reserveHost` named, or '' for every room the cloud runs — see `detach` */
  private reservedHost = '';
  // monotonic connection counter: every add/reattach stamps the owning socket with
  // the next value so a stale old socket's close can be recognised and ignored.
  private connSeq = 0;

  private world: World | null = null;
  /**
   * MATCH GENERATION: bumped every time this room authors a world.
   *
   * A rematch rebuilds at tick 0, so inputs still in flight from the previous match
   * carry tick numbers the new one WILL reach — and would be applied as if fresh.
   * Every input is stamped with the generation it was produced for and dropped if it
   * is stale. This is what makes restarting a live match safe rather than the source
   * of the post-restart drift that got restart disabled in the first place.
   */
  private matchGen = 0;
  /** duo-record rematch votes, by clientId. A TOGGLE per driver — see `voteRematch`. */
  private readonly rematchVotes = new Set<string>();
  // the live match's seed + setups (remembered so a spectator joining mid-match, or a
  // reconnect, can be handed the same `matchStart` the drivers got)
  private matchSeed = 0;
  private matchSetups: RobotSetup[] = [];
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
  /** `serverTick` of the last broadcast snapshot — the baseline a RELIABLE recipient holds */
  private prevSnapTick = -1;
  /** which ball ids changed on each of the last `SNAP_HISTORY_FRAMES` broadcasts, oldest
   *  first. Unioning the entries after a client's acked tick gives the delta that client
   *  needs, which is how a lossy recipient is served without per-client ball copies. */
  private readonly snapChanged: { tick: number; ids: number[] }[] = [];
  /** the newest broadcast tick that has FALLEN OUT of `snapChanged`. An ack at or below it
   *  can no longer be reconstructed from, so that client takes a full keyframe instead. */
  private snapHistoryFrom = -1;
  private readonly snapPrimed = new Set<string>();
  // clientId -> newest snapshot serverTick the client has confirmed APPLIED (its
  // ball baseline, piggybacked on `input`). The happy-path delta is still against
  // the last broadcast; this only drives a self-healing keyframe when a client's
  // CONFIRMED baseline falls > ACK_STALE_TICKS behind (a wedged / far-behind client
  // resyncs from a full frame instead of drifting on deltas it can't apply). It is
  // also the hook the future unreliable (QUIC-datagram) lane keys its delta to.
  private readonly snapAck = new Map<string, number>();
  // the command each robot ran on the latest tick (sent so clients predict remotes)
  private lastFrame = new Map<number, RobotCommand>();
  // recording: captures the input log for this match; finalized once at phase 'post'
  private recorder: ReplayRecorder | null = null;
  private finalized = false;
  /**
   * This match's globally unique id, minted at `finalizeMatch` and sent to THE HOST ALONE.
   * Null until then, and re-minted by a rematch — a rematch is a different match. See
   * `ServerMsg` 'matchArchive' for what it is for and why only the host gets it.
   */
  private matchId: string | null = null;
  // the post-buzzer settle: the match is finalized once nothing left on the field can change
  // the score (see `src/sim/settle.ts`)
  private settle: SettleClock = newSettleClock();
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
  /** the finished match's result is still being persisted, so the ratings a rematch would
   *  introduce are not known yet — see `maybeRematch` */
  private resultPending = false;
  private resultWait: ReturnType<typeof setTimeout> | null = null;
  // set on the HOST machine when this room was staged by the designated matchmaker
  // (region-aware ranked). The roster is authoritative; the match starts once every
  // staged player has (re)connected here, or cancels after RANKED_JOIN_GRACE_MS.
  private pendingMatch: PendingMatch | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  /** reaps held slots when no loop is running to do it — see `armGraceReap` */
  private graceReap: ReturnType<typeof setTimeout> | null = null;
  // ranked lifecycle: 'connecting' while paired players are still arriving, then
  // 'strategy' during the pre-match coordination window, then 'match' once the world
  // is built. Custom rooms skip 'strategy' (connecting → match). `world===null` still
  // means "not in a match" (true for both connecting and strategy).
  private phase: 'connecting' | 'strategy' | 'match' = 'connecting';
  /** a staged ranked match was CANCELLED and the room torn down. The sockets that were in it
   *  still point here (`server/index.ts` never clears a socket's `room`), so everything that
   *  can arrive afterwards — a close, a late ready — must be a no-op. See `cancelPending`. */
  private cancelled = false;
  /** a solo record run whose driver left AFTER it was decided: keep stepping with nobody
   *  connected until `finalizeMatch` saves it, then free the room (`reap`, a clean close) or
   *  hold it for the reconnect grace (a dropped network). See `detach`. */
  private finishing: { reap: boolean } | null = null;
  // release channel of this room, set from the FIRST client to join (or the staged
  // ranked roster). 'alpha' rooms are IN-DEVELOPMENT: their results are never
  // persisted to the leaderboard/ELO DB (see finalizeMatch), and the matchmaker
  // only ever pairs alpha with alpha (server/matchmaking.ts) — mixing channels
  // would desync since each runs a different src/sim.
  private channel = 'stable';
  private strategyDeadline = 0;
  /** the match row this room last wrote, for a misscore claim to point at (see
   *  `resolveScoreReport`). Empty until the result has persisted. */
  private lastMatchId: string | null = null;
  private strategyTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly slotOf = new Map<string, number>(); // clientId -> roster slot (= robotId)

  /** which game this room runs. Ranked comes from the staged PendingMatch, custom
   * from the room config; DECODE by default (old clients). Resolves the sim module
   * (createWorld/step) — a CR room and a DECODE room never share a matchmaking
   * bucket (server/matchmaking.ts), so a room's game is unambiguous. */
  private get game(): GameId {
    return this.pendingMatch?.game ?? this.config.game ?? 'decode';
  }

  /** which game this room runs (public read for the operator snapshot) */
  get gameId(): GameId {
    return this.game;
  }

  /** is a match actually running here (vs. still a lobby)? */
  get hasWorld(): boolean {
    return this.world !== null;
  }

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
    /** called when an authed user's MATCH becomes live in this room, and again when
     * their slot is released (match finalized / dropped / room stopped). The registry
     * uses this to enforce "one live game per user" — a user with a lock here is
     * refused a second join/queue elsewhere (they must rejoin or leave this one). */
    private readonly onUserActive?: (userId: string) => void,
    private readonly onUserInactive?: (userId: string) => void,
    /** invoked when a STAGED ranked pairing dies, with the players at fault. The DB layer
     * applies the escalating penalty and answers with what each player was actually
     * charged, which the room relays so nobody is penalised without being told. DB-agnostic:
     * tests/dev pass nothing and the cancel behaves exactly as it always did. */
    private readonly onDodge?: (d: DodgeReport) => void | Promise<DodgeVerdict[] | void>,
    /** invoked once at the end of a ranked match with who sat it out, who walked away from
     * it, and who played it clean. The DB layer turns that into account-standing changes;
     * the room itself only OBSERVES (it counts ticks), so tests/dev pass nothing and the
     * match behaves exactly as before. */
    private readonly onBehaviour?: (b: BehaviourReport) => void,
  ) {}

  /**
   * PARTICIPATION, counted while the match is actually live.
   *
   * Standing charges for sitting out or walking away have to be grounded in something the
   * server SAW, not in a report or a guess, so the tick loop keeps three counters: how many
   * live ticks there were, how many of them each robot issued a real command on, and how
   * many of them its driver was not connected for. Everything about what those numbers MEAN
   * is decided at finalize (see `behaviourReport`).
   */
  private liveTicks = 0;
  private readonly driveTicks = new Map<number, number>();
  private readonly awayTicks = new Map<number, number>();

  /** authed users whose match is currently live in THIS room (holds their single-
   * game lock). Registered at match begin — and, for a ranked pairing, from the
   * moment it is STAGED (`applyPending`), because a staged match is one the server
   * has already committed them to. Released at finalize / drop / stop. */
  private readonly activeUserIds = new Set<string>();

  /** release every held single-game lock this room owns (idempotent) */
  private releaseActiveUsers(): void {
    for (const uid of this.activeUserIds) this.onUserInactive?.(uid);
    this.activeUserIds.clear();
  }

  /** true if a fresh driver can still join (room not full, not mid-match, and not
   * already locked into the pre-match strategy window) */
  canJoin(): boolean {
    return (
      this.clients.size < roomCapacity(this.config) &&
      this.world === null &&
      this.phase !== 'strategy'
    );
  }

  /**
   * CAN *THIS* ID TAKE A SEAT? — `canJoin` plus the RESERVED HOST.
   *
   * `canJoin` answers for a room whose host is one of the people already in it, which is
   * every room the cloud runs: `add` gives the crown to the first client through the door,
   * so the host is seated by definition and capacity is a single number.
   *
   * A TAB-HOSTED LAN ROOM INVERTS THAT. Its host reserves the crown at open (`reserveHost`)
   * and then joins LAST — they are reading the code out while guests arrive — so the seat
   * they will need is not occupied yet and plain capacity does not know it is spoken for.
   * With four guests admitted the host was refused their own room, or (before any refusal
   * existed at all) seated into an oversized roster that `POST /api/lan` then rejected.
   *
   * The reserved seat is held ONLY until its holder actually arrives, and only for a room
   * that reserved one: with no reservation, or once the host is in `clients`, this is
   * exactly `canJoin`.
   */
  canSeat(id: string): boolean {
    if (!this.canJoin()) return false;
    const hostPending = this.hostId !== '' && id !== this.hostId && !this.clients.has(this.hostId);
    return !hostPending || this.clients.size + 1 < roomCapacity(this.config);
  }

  /**
   * THE SEAT THIS ACCOUNT ALREADY HOLDS HERE, if any — the room's answer to "is this
   * the same person arriving twice?".
   *
   * One account is one driver. Nothing used to ask: the single-game guard in
   * `server/index.ts` compares room CODES, so it passes a second tab joining THE SAME
   * code (`other === code`), and a duplicate userId then took a second seat. In a 1v1
   * ranked room that is the whole room — capacity 2, both seats spent on one person,
   * and the actual opponent refused at the door and no-showed for a match they were
   * standing outside of. In a duo record room it is two robots on one leaderboard row.
   *
   * WHETHER THE HELD SEAT LOOKS CONNECTED IS NOT ASKED, and that is deliberate. It cannot
   * tell a second tab from a fast reconnect: a partitioned TCP connection outlives the
   * client that gave up on it, so a player whose network blipped arrives on a new socket
   * while their old seat still reads `connected` and the server has not heard the close
   * yet. Refusing that player would strand them in a room they are seated in.
   *
   * So the caller takes the seat over either way — the rule `reattach` already settles this
   * conflict by, last socket in wins and the one it displaces is told so. A reconnect gets
   * its seat back, a second tab gets the match and the first tab gets a sentence instead of
   * a silently unplugged session, and neither ends up with two robots.
   */
  seatFor(userId: string): string | null {
    for (const c of this.clients.values()) {
      if (c.userId === userId) return c.id;
    }
    return null;
  }

  /**
   * GIVE UP A HELD SLOT ON PURPOSE — "Abandon" on the you-have-a-game-in-progress card.
   *
   * That button only ever cleared the browser's own record of the match, which was
   * harmless for exactly as long as the server's single-game lock was inert. It is not
   * inert any more (see `stopLoop`), so abandoning and starting something new met a
   * refusal from the server for the rest of the reconnect grace, phrased as advice —
   * "rejoin or leave it first" — about a game the UI had just said was gone. The button
   * has to mean it: this frees the slot and the lock now.
   *
   * Idempotent, and deliberately not fussy about WHERE the caller is: the id is a
   * per-client secret the server minted, and holding it is the same proof of ownership
   * `rejoin` already accepts.
   */
  abandonSlot(clientId: string): boolean {
    const c = this.clients.get(clientId);
    if (!c) return false;
    if (c.userId) {
      this.activeUserIds.delete(c.userId);
      this.onUserInactive?.(c.userId);
    }
    // mid-match this is a departure like any other: the match stays rated and the
    // leaver takes the loss (`departed` is what keeps their result on the board).
    const rid = this.robotOf.get(c.id);
    if (this.world !== null && c.userId && rid !== undefined) {
      this.departed.set(rid, { userId: c.userId, handle: c.player.name, assists: c.player.assists });
    }
    if (rid !== undefined && !this.dropped.has(rid) && this.world) {
      this.dropped.add(rid);
      this.broadcast({ t: 'drop', robotId: rid, tick: this.world.tick });
    }
    this.clients.delete(c.id);
    this.snapPrimed.delete(c.id);
    this.snapAck.delete(c.id);
    this.robotOf.delete(c.id);
    this.ackTick.delete(c.id);
    this.passCrown(c.id);
    this.broadcastRoster();
    this.refreshRematch();
    if (this.clients.size === 0) {
      this.stop();
      this.onEmpty();
    }
    return true;
  }

  /**
   * FREE THIS USER'S SINGLE-GAME LOCK HERE, AND TOUCH NOTHING ELSE.
   *
   * `abandonSlot` is the other way out and it is much heavier: it deletes the client,
   * drops its robot, and takes the whole room down once the last seat goes. That is right
   * for "I have left this match", and WRONG for the one case this exists for — a solo
   * RECORD run whose owner has pressed restart. Two things have to be true at once there:
   * they can start a new run immediately (the lock cannot outlive their interest in the
   * old one), and the run they just walked away from still SAVES if it was already decided
   * (`finishing` — a score is written when the field settles after the buzzer, with nobody
   * watching). Killing the room would serve the first and quietly break the second, which
   * is the bug `f1fc93a` fixed and which must not come back by another door.
   *
   * So: the lock goes, the room stays. The held slot is still held and is reaped by its own
   * grace exactly as before, so nothing about the reconnect path changes either.
   */
  releaseSeatLock(userId: string): boolean {
    if (!this.activeUserIds.has(userId)) return false;
    this.activeUserIds.delete(userId);
    this.onUserInactive?.(userId);
    return true;
  }

  /** is this a SOLO record run — one driver, no opponent, no rating? The single-game lock
   *  treats these differently, because a room with nobody else in it can only ever be in
   *  its own owner's way (see `releaseSeatLock` and the join guard). */
  get soloRecord(): boolean {
    return this.config.kind === 'record' && this.config.record === 'solo';
  }

  /** authoritative sim tick (0 before the match starts) */
  get tick(): number {
    return this.world?.tick ?? 0;
  }

  /**
   * Name this room's HOST before anybody has joined.
   *
   * `add` gives the crown to the first client through the door, which is right for every room
   * the cloud runs — the person who made it is the person who dialled first. A LAN room hosted
   * in a browser tab inverts that: the room exists the moment its host clicks START HOSTING,
   * the host then reads the code out and joins LAST, and the crown had gone to a guest. So the
   * tab-hosted room reserves the seat its host will arrive on (`HOST_SEAT`, `hostWorker.ts`).
   *
   * Reserving only ever CLAIMS AN EMPTY SLOT — it cannot take the room off somebody who
   * already holds it — and nothing in the cloud path calls it.
   */
  reserveHost(id: string): void {
    if (!this.hostId) this.hostId = id;
    // remembered so `detach` can tell a reserved host stepping out from a cloud host leaving
    if (this.hostId === id) this.reservedHost = id;
  }

  add(client: Client): void {
    // the first client to land defines the room's release channel (custom/record
    // rooms are single-channel by construction — the matchmaker segregates ranked)
    if (this.clients.size === 0 && client.channel) this.channel = client.channel;
    client.conn = ++this.connSeq;
    this.clients.set(client.id, client);
    if (!this.hostId) this.hostId = client.id;
    client.send({ t: 'welcome', clientId: client.id });
    this.broadcastRoster();
    this.moderatePlayerNames(client);
  }

  /**
   * Fire-and-forget hosted moderation of a newly-joined player's free-text names,
   * off the join path (the hosted call is async and must never block the roster).
   * If a name is flagged it is reset to a safe default and the roster re-broadcast,
   * so an opponent never sees an inappropriate live team/robot name. Authed players'
   * `name` is already the moderated handle (server/index.ts); this covers `teamName`,
   * the robot `spec` name/team, and an anonymous player's chosen name. Best-effort:
   * the durable record is scrubbed again at persist time regardless.
   */
  private moderatePlayerNames(client: Client): void {
    void (async () => {
      const p = client.player;
      const [name, teamName, specName, specTeam] = await Promise.all([
        scrubName(p.name, 'Driver'),
        scrubName(p.teamName, ''),
        scrubName(p.spec.name, DEFAULT_SPEC.name),
        scrubName(p.spec.teamName, ''),
      ]);
      if (!this.clients.has(client.id)) return; // left before the check returned
      if (name === p.name && teamName === p.teamName && specName === p.spec.name && specTeam === p.spec.teamName) {
        return; // all clean (or moderation disabled) — nothing to do
      }
      p.name = name;
      p.teamName = teamName;
      p.spec = { ...p.spec, name: specName, teamName: specTeam };
      this.broadcastRoster();
    })();
  }

  /** true when this room's results must NOT be written to the leaderboard/ELO DB — an
   *  in-development build talking to the PRODUCTION server. On the alpha deployment, whose
   *  database is its own, alpha results persist normally (see server/channel.ts). */
  private get unpersisted(): boolean {
    return !roomPersists(this.channel);
  }

  /** add a read-only SPECTATOR. It receives the current `matchStart` (with a sentinel
   * robot id of -1) + a live snapshot immediately, then every broadcast. Never joins
   * the roster / capacity / persistence, and its messages are ignored. */
  addSpectator(client: Client): void {
    this.spectators.set(client.id, client);
    client.send({ t: 'welcome', clientId: client.id });
    if (this.world && this.phase === 'match') {
      client.send(this.matchStartMsg(-1));
      this.sendSnapshotTo(client);
    }
    this.broadcastRoster();
    this.broadcastSpectators();
  }

  /**
   * Tell the room how many people are watching — edge-triggered, and only when the
   * number players can SEE actually moved. A hidden admin joining or leaving is a
   * no-op by construction rather than by a separate code path, which is what keeps
   * "invisible" honest: there is no message to notice the absence of.
   */
  private lastSpecCount = -1;
  private broadcastSpectators(): void {
    const n = this.visibleSpectators();
    if (n === this.lastSpecCount) return;
    this.lastSpecCount = n;
    this.broadcast({ t: 'spectators', n });
  }

  /** the matchStart payload for a client. `yourRobotId` = -1 for a spectator (no slot). */
  private matchStartMsg(yourRobotId: number): ServerMsg {
    return {
      t: 'matchStart',
      seed: this.matchSeed,
      setups: this.matchSetups,
      yourRobotId,
      game: this.game,
      ranked: this.ranked,
      intros: this.ranked ? this.intros : undefined,
      gen: this.matchGen,
      region: SERVER_REGION || undefined,
    };
  }

  /**
   * A one-line summary of this room if a match is RUNNING in it, else null.
   *
   * This describes the room; it does not decide who may see it. Every live room
   * qualifies — ranked, custom and record alike — and the two consumers narrow it
   * themselves: public `/api/live` keeps ranked only, the admin view keeps
   * everything. Filtering here instead would have made "show the operator every
   * game" impossible without a second, near-identical method drifting alongside
   * this one.
   */
  summary(): LiveRoom | null {
    const w = this.world;
    if (!w || this.phase !== 'match') return null;
    // `this.phase` is set to 'match' when the match STARTS and is never set back,
    // so it does not mean "still playing" — a finished room sits in it until the
    // room is torn down. Without this check "Watch Live" kept listing games that
    // had already ended (and it is not spectatable: the world is over).
    if (w.match.phase === 'post') return null;
    const record = this.config.kind === 'record';
    const players = [...this.clients.values()].map((c) => ({
      name: c.player.name,
      teamName: c.player.spec.teamName || undefined,
      teamNumber: c.player.spec.teamNumber || undefined,
      alliance: c.player.alliance,
    }));
    return {
      room: this.pendingCode() ?? this.code,
      game: this.game,
      mode: record ? (this.config.record ?? 'solo') : eloMode(this.clients.size),
      phase: w.match.phase,
      timeLeft: Math.max(0, Math.round(w.match.phaseTimeLeft)),
      ranked: this.ranked,
      players,
      score: { red: w.match.scores.red.total, blue: w.match.scores.blue.total },
      spectators: this.visibleSpectators(),
      kind: record ? 'record' : 'versus',
      region: SERVER_REGION || undefined,
    };
  }

  /** Mark an already-attached spectator as a hidden observer and correct the count.
   *  Called ONLY from the server's own admin-JWT verification (see the `spectate`
   *  handler) — there is no path from a client message to this. */
  hideSpectator(id: string): void {
    const s = this.spectators.get(id);
    if (!s || s.hidden) return;
    s.hidden = true;
    this.broadcastSpectators();
  }

  /** watchers as PLAYERS are told about them: hidden admin observers excluded.
   *  One definition, used by the Watch Live card and the in-match readout, so the
   *  two can never disagree about whether somebody is being counted. */
  visibleSpectators(): number {
    let n = 0;
    for (const s of this.spectators.values()) if (!s.hidden) n++;
    return n;
  }

  /** EVERY attached spectator, hidden observers included — the admission-control
   *  figure, as distinct from `visibleSpectators()`, which is the number players are
   *  shown. A hidden admin is invisible on screen but still costs a snapshot stream,
   *  and a cap that could not see them would not be a cap. */
  spectatorCount(): number {
    return this.spectators.size;
  }

  /**
   * Nobody is here and nothing is owed — safe for the connection layer to drop this room
   * out of the registry.
   *
   * It exists for the async join path: the registry slot is claimed SYNCHRONOUSLY (so a
   * racing second joiner finds the same room instead of creating a duplicate) but the
   * joiner is only added several `await`s later, and any of the paths in between can
   * abandon the attempt — including the socket simply closing, which reaches a `room` that
   * is still null and so runs no teardown at all. Without a guard that room is counted
   * against `MAX_ROOMS` forever.
   *
   * A STAGED ranked room is NOT abandonable even with zero clients: `takePendingMatch`
   * has already consumed the row from Postgres (atomic delete-returning), so deleting the
   * room here would strand the other three players, whose own joins would create a fresh
   * room that can no longer claim the match. It reaps itself instead — `applyPending` arms
   * `RANKED_JOIN_GRACE_MS`, and `cancelPending` calls `onEmpty()`.
   */
  isAbandonable(): boolean {
    return this.clients.size === 0 && this.spectators.size === 0 && this.pendingMatch === null;
  }

  /**
   * Operator snapshot of who is in this room, for the cross-region presence beat.
   *
   * Signed-in drivers are listed by ACCOUNT ID and nothing else — the caller joins
   * the handle at read time, so no names are copied into the heartbeat. Anonymous
   * drivers are listed by their per-socket CONNECTION ID: not an IP, not a
   * fingerprint, not stored anywhere else, and gone when the socket closes. It
   * tells one live guest apart from another, which is what an operator needs to
   * answer "is that session idle or in a lobby", and cannot follow anyone between
   * sessions. Spectators are excluded entirely; they are watchers, and the visible
   * count already reports them.
   */
  presenceSnapshot(): {
    players: { userId: string; act: 'lobby' | 'match' }[];
    guests: { id: string; act: 'lobby' | 'match' }[];
  } {
    const act: 'lobby' | 'match' = this.world !== null ? 'match' : 'lobby';
    const players: { userId: string; act: 'lobby' | 'match' }[] = [];
    const guests: { id: string; act: 'lobby' | 'match' }[] = [];
    for (const c of this.clients.values()) {
      if (!c.connected) continue;
      if (c.userId) players.push({ userId: c.userId, act });
      else guests.push({ id: c.id, act });
    }
    return { players, guests };
  }

  /** a socket dropped. In the lobby that's an outright leave; mid-match the slot
   * is HELD for the reconnect grace (the robot coasts to ZERO meanwhile).
   *
   * `clean` is true when the CLIENT closed the socket on purpose (WebSocket close code
   * 1000/1005 — `transport.close()`), as opposed to a network drop (1006). See below. */
  detach(id: string, conn?: number, clean = false): void {
    // a spectator socket closing — just drop it (no roster/grace/persistence impact)
    if (this.spectators.has(id)) {
      this.spectators.delete(id);
      this.snapPrimed.delete(id);
      this.snapAck.delete(id);
      this.broadcastRoster();
      this.broadcastSpectators();
      return;
    }
    const c = this.clients.get(id);
    if (!c) return;
    // a STALE socket closing after a newer one already reclaimed this slot (fast
    // reconnect, old TCP not yet reaped): ignore it, or we'd mark a live player
    // disconnected and eventually grace-drop their robot mid-match.
    if (conn !== undefined && c.conn !== undefined && conn !== c.conn) return;
    if (this.world === null) {
      // a drop during the ranked strategy window can't be rated one-sided and the
      // reconnect path (a fresh `join`) can't reclaim a held pre-match slot — so a
      // pre-match departure CANCELS the staged match (both drivers requeue). Full
      // strategy-phase reconnection is deferred (see docs/netcodeplan.md).
      if (this.pendingMatch && this.phase === 'strategy') {
        /**
         * ⚠️ A RELOAD IS NOT A BAIL — IT IS THE COMMONEST WAY TO REACH THIS LINE.
         *
         * This used to cancel the match on the first closed socket, full stop, which made
         * refreshing the tab during the strategy window an instant, unrecoverable charge:
         * the match died, the player was billed a bail, and the three people who did
         * nothing wrong lost their queue time. Reported as "all I did was wait ... you
         * should probably tell the user to Not refresh" — and telling them is the smaller
         * half of the answer, because a reload is also what a phone does when it reclaims
         * a backgrounded tab, and no copy prevents that.
         *
         * So the SEAT IS HELD instead. The staged roster is the server's record of who
         * belongs here, `reattach` hands the slot back on the same client id (which is
         * what `slotOf` is keyed by), and a player who gets back inside the window plays
         * the match they were assigned. Nothing is charged for a trip they completed.
         *
         * THE WAIT IS ALREADY BOUNDED and needs no timer of its own: `onStrategyDeadline`
         * fires at `strategyDeadline` regardless, `maybeBeginRanked` will not start a
         * match with an empty seat, and `absentRoster` counts a held-but-disconnected
         * client as absent — so somebody who never comes back is charged at the deadline
         * exactly as a no-show, which is what they are.
         *
         * A CLEAN close (1000/1005) is still an immediate bail, and that distinction is
         * the whole point: `transport.close()` is the player pressing Back, i.e. a person
         * who has decided to leave. Making the others wait out the deadline for someone
         * who told us they are gone would be the same unfairness pointed the other way.
         * A reload is 1001 and a dropped network 1006 — neither is a decision.
         */
        if (clean) {
          // STRATEGY BAIL: this socket's user is the one who left. Charged cause-blind — from
          // here a closed tab and a pulled cable are the same event, and pretending otherwise
          // would just advertise which one is cheaper (see src/dodge.ts).
          this.cancelPending(
            'Match cancelled - a player disconnected.',
            c.userId ? [{ userId: c.userId, kind: 'bail' as DodgeKind }] : [],
          );
          return;
        }
        c.connected = false;
        c.disconnectAt = Date.now();
        c.player.ready = false; // a seat nobody is sitting in has not readied
        this.broadcastRoster();
        return;
      }
      this.clients.delete(id);
      this.snapPrimed.delete(id);
      this.snapAck.delete(id);
      this.passCrown(id);
      this.robotOf.delete(id);
      this.broadcastRoster();
      this.refreshRematch(); // the tally is against CONNECTED drivers
      if (this.clients.size === 0) {
        this.stop();
        this.onEmpty();
      }
    } else {
      c.connected = false;
      c.disconnectAt = Date.now();
      // ⚠️ A SOLO RECORD RUN THE PLAYER CLOSED ON PURPOSE IS OVER — DO NOT HOLD IT.
      // Restarting a record run is a full teardown: the client disposes its session (a
      // CLEAN close) and opens a brand-new `rec-` room. Holding the old one for the
      // reconnect grace kept it SIMULATING for 45 s with nobody who could ever come back
      // to it, so a player restarting every few seconds occupied several rooms at once —
      // on launch day (2026-09-13, BIOBUZZ public) iad sat at 24/24 with 8-12 real runs
      // and refused new ones as `region_full` ("Couldn’t start"). A network drop is not
      // clean (1006) and keeps its grace; so does every room with a second driver in it.
      const soloRecord = this.config.kind === 'record' && this.config.record === 'solo';
      // ⚠️ A RUN THAT IS ALREADY DECIDED IS FINISHED AND SAVED, WITH NOBODY WATCHING. The score
      // is final once the field settles after the buzzer, and that is when `finalizeMatch` writes
      // the PB / leaderboard row. A player who pressed restart or Back in that window used to
      // lose the run outright: the loop FREEZES a room with no connected driver (the ghost-room
      // guard in `startLoop`), so the match never reached finalize and the room died unsaved
      // — reported as "record runs are not updating their personal best or the leaderboard".
      if (soloRecord && this.inFinishWindow()) {
        this.finishing = { reap: clean };
        this.broadcastRoster();
        return;
      }
      if (clean && soloRecord) {
        c.disconnectAt = -Infinity;
        this.checkGrace();
        return;
      }
      /**
       * A HOST WHO LEAVES A FINISHED MATCH TAKES THE ROOM WITH THEM UNLESS THE CROWN MOVES.
       *
       * Their slot is still HELD — the match is over but they may well reconnect to read the
       * results, and reattaching is keyed to the client id, not to who is host. The CROWN is
       * a different question: `start` and `lobby` are host-only, so while `hostId` names a
       * disconnected client nobody left in the room can do either, and they wait out a
       * 45-second grace before the reaper frees them. Only once the score is final, because
       * before that the host is a driver who may be coming straight back mid-match.
       */
      if (this.finalized) this.passCrown(id);
      this.broadcastRoster();
      /**
       * A partner who drops must not leave the run un-restartable: their vote is no longer
       * required, so a rematch the other driver already asked for lands.
       *
       * ⚠️ WHICH IS ALSO HOW THE GHOST MATCH GOT MADE. Pressing REMATCH while both players are
       * still reading the results is the most ordinary thing in the world, and this line meant
       * that the OTHER player then leaving — to go and practise, say — was itself the trigger:
       * their drop made the standing vote unanimous and the match restarted around the chassis
       * they had just walked away from. `maybeRematch` now also asks whether every SEAT is
       * still held (`rematchSeatsHeld`), which is the half this could never supply.
       */
      this.refreshRematch();
      // ⚠️ THE GRACE IS ONLY EVER CHECKED BY THE LOOP, AND A FINISHED MATCH HAS NO LOOP.
      // `finalizeMatch` stops it and keeps the room for the results screen, so a player who
      // closed the tab from there was held forever: never reaped, the room never deleted.
      // Every finished match somebody walked away from leaked one room, and the always-warm
      // primary (which never auto-stops to clear them) filled `MAX_ROOMS` with rooms that
      // had nobody in them and refused every new room in the region (2026-09-13, 24/24
      // with `/api/perf` reading 0 live). So with no loop running, reap on a timer instead.
      if (!this.loop) this.armGraceReap();
    }
  }

  /** run `checkGrace` once the grace has lapsed, for a room whose loop is not running */
  private armGraceReap(): void {
    if (this.graceReap) clearTimeout(this.graceReap);
    this.graceReap = setTimeout(() => {
      this.graceReap = null;
      // a rematch restarted the loop meanwhile: it owns the check again
      if (this.loop) return;
      this.checkGrace();
      // someone is still inside their own grace (they dropped later) — look again
      if (this.clients.size > 0 && ![...this.clients.values()].every((x) => x.connected)) {
        this.armGraceReap();
      }
    }, RECONNECT_GRACE_MS + 1000);
    if (this.graceReap.unref) this.graceReap.unref();
  }

  /** reclaim a held slot on a fresh socket. Returns the new owning-connection id on
   * success, or null if the slot is gone for good (grace lapsed → the client was
   * deleted, so its robot can no longer be reclaimed). A rejoin carrying the right
   * clientId PROVES ownership, so we take over even if the slot still shows
   * `connected` — a fast reconnect routinely beats the reaping of the dropped socket
   * (a partitioned TCP connection lingers), and refusing it stranded the player on a
   * "connection lost" screen. The old socket is orphaned (its `send` is replaced) and
   * its later close is ignored via the conn stamp. */
  reattach(
    id: string,
    send: (m: ServerMsg) => void,
    sendRaw?: (s: string) => void,
    backlog?: () => number,
  ): number | null {
    const c = this.clients.get(id);
    if (!c) return null;
    /**
     * TELL THE SOCKET THIS ONE IS REPLACING, while it still has a sender.
     *
     * The usual loser here is a dead TCP connection and hears nothing, which is fine. The
     * one that matters is a LIVE one: the same match open in a second tab, both tabs
     * holding the same client id out of localStorage, both offering Rejoin. The second to
     * press it takes the slot — `conn` makes sure of that — and the first was then left on
     * a session that had been silently unplugged: it had already been told `rejoined: true`,
     * it never receives another frame, and it renders a match frozen at the last snapshot
     * with no way to tell that anything happened. One frame on the way out is the whole fix.
     */
    if (c.connected) {
      c.send({
        t: 'error',
        message: 'This match was opened in another tab - that tab has it now.',
      });
    }
    c.send = send;
    /**
     * ⚠️ EVERY SENDER ON THIS CLIENT BELONGS TO THE NEW SOCKET, NOT JUST `send`.
     *
     * Only `send` used to be replaced here, which was correct for exactly as long as it was
     * the only one. Since the encode-once change the hot path is `sendRaw`, and the room's
     * BROADCASTS and SNAPSHOTS go through it — so a reattached client kept a closure over
     * the socket it had just lost. That closure checks `readyState === OPEN` and therefore
     * fails SILENTLY: the reconnecting player receives `welcome`, `rejoined` and the one
     * keyframe `sendSnapshotTo` writes (all `send`) and then nothing ever again, on a socket
     * that is open and healthy. Assigning `undefined` when a caller supplies none is the
     * right answer too — the room falls back to `send`, which is what a socketless test
     * client has always done.
     */
    c.sendRaw = sendRaw;
    c.backlog = backlog;
    c.connected = true;
    c.disconnectAt = 0;
    c.conn = ++this.connSeq; // this socket now owns the slot (stale old close ignored)
    this.snapPrimed.delete(id); // lost its baseline — force a full keyframe
    this.snapAck.delete(id); // drop its stale pre-drop ack so it doesn't re-keyframe
    send({ t: 'welcome', clientId: id });
    send({ t: 'rejoined', ok: true });
    if (this.world) this.sendSnapshotTo(c); // immediate full resync (re-primes)
    /**
     * A SEAT RECLAIMED INSIDE THE STRATEGY WINDOW HAS TO BE TOLD WHAT IT CAME BACK TO.
     *
     * There is no world yet, so the snapshot above is not the resync — `strategyStart` is.
     * It carries the robot id (`slotOf`, keyed by CLIENT id, which is exactly why the
     * reclaim reuses the held client rather than seating a fresh one) and the DEADLINE,
     * which is the number the returning player most needs: it did not pause while they
     * were away, and a client that had to guess would show them a full window and let
     * them run out of a clock that was already half gone.
     */
    if (!this.world && this.pendingMatch && this.phase === 'strategy') {
      send({
        t: 'strategyStart',
        deadline: this.strategyDeadline,
        yourRobotId: this.slotOf.get(c.id) ?? 0,
        mode: this.pendingMatch.mode,
        intros: this.intros,
        game: this.game,
      });
    }
    this.broadcastRoster();
    this.refreshRematch(); // they are required again, and get the current tally
    return c.conn;
  }

  /** finalize any disconnected driver whose grace has lapsed: drop its robot to
   * ZERO for good (broadcast) and free the slot */
  /** is ANY client currently holding a live socket? A room where every slot is held by a
   *  dropped client is a ghost — see the freeze in `startLoop`. */
  private anyConnected(): boolean {
    for (const c of this.clients.values()) if (c.connected) return true;
    return false;
  }

  /**
   * THE CROWN PASSES TO WHOEVER IS LEFT — unless it was RESERVED. A cloud host who leaves is
   * gone; whoever is still here should be able to start. A tab-hosted room's host
   * (`reserveHost`) is different: the room lives in THEIR tab, and stepping out to the LAN
   * screen and back is an ordinary thing for them to do. Handing the crown to a guest
   * meanwhile meant the host came back to their own room as a guest of it, and `canSeat`
   * stopped holding their seat. The reservation outlives the visit.
   *
   * ⚠️ THIS ALSO RUNS FROM `checkGrace`, and that is a fix, not a tidy-up. Migration used to
   * live in `detach`'s LOBBY branch alone, so a host who left DURING or AFTER a match was
   * never replaced: their slot is held, then reaped by the grace, and `hostId` went on
   * naming a client that is no longer in the map. Every host-only control — `start`, and now
   * `lobby` — was dead for everyone left in the room, which is exactly the "we had to make a
   * new room" case. Prefer a CONNECTED successor: after a reap the map can still hold other
   * slots whose own grace has not lapsed, and handing the crown to one of those would just
   * move the dead end.
   */
  private passCrown(id: string): void {
    if (this.hostId === id && this.reservedHost !== id) {
      const rest = [...this.clients.values()];
      this.hostId = (rest.find((c) => c.connected) ?? rest[0])?.id ?? '';
    }
  }

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
      // their grace lapsed — free their single-game lock so they can start fresh
      if (c.userId) {
        this.activeUserIds.delete(c.userId);
        this.onUserInactive?.(c.userId);
      }
      this.clients.delete(c.id);
      this.snapPrimed.delete(c.id);
      this.snapAck.delete(c.id);
      this.robotOf.delete(c.id);
      this.ackTick.delete(c.id);
      this.passCrown(c.id);
    }
    if (this.clients.size === 0) {
      this.stop();
      this.onEmpty();
    }
  }

  /**
   * Is this player's CANONICAL start pose legal for this game? — the ONE place the server
   * asks, so the ready gate and the start gate cannot answer differently.
   *
   * TWO FACTS, not one. `startLegality` is whether this game wants the server to ENFORCE a
   * start rule at all, and `startLegal` is the rule. A game that answers the second and not
   * the first (Chain Reaction, whose editor checks G04 live) is deliberately waved through
   * here. Both used to read DECODE's `activeStartLegal` directly, which judged every other
   * game's poses against DECODE's launch lines and goal triangles — see the slot's own note.
   *
   * ⚠️ A `server/` change: it needs a deploy to take effect for live rooms.
   */
  private startPoseLegal(
    spec: RobotSpec,
    a: Alliance,
    startPose: StartPose | null | undefined,
  ): boolean {
    const mod = simModuleFor(this.game);
    if (!mod.startLegality || !mod.startLegal) return true;
    return mod.startLegal(spec, a, startPose);
  }

  onMessage(id: string, msg: ClientMsg): void {
    const c = this.clients.get(id);
    if (!c) return;
    // a late message into a cancelled room (a ready landing after the deadline) must not
    // begin a match nobody is registered for — see `cancelled`
    if (this.cancelled) return;
    switch (msg.t) {
      case 'update': {
        // sanitize the patch against this player's current config: a spoofed
        // spec/size/assist patch is clamped to legal ranges before it applies
        const patch = sanitizePlayerPatch(msg.patch, c.player, this.game);
        // in the ranked strategy window, alliance is server-authoritative (staged by
        // the matchmaker) — a client may re-pick its spec / pose / ready, never its
        // side, or two partners could stack one alliance.
        if (this.pendingMatch && this.phase === 'strategy') delete patch.alliance;
        Object.assign(c.player, patch);
        // AUTHORITATIVE ready gate: a player can't be ready with a start pose that's
        // illegal for their (possibly just-swapped) chassis — otherwise createWorld
        // would silently relocate their robot at spawn. Runs on every patch (ready
        // toggle, spec swap, pose edit), so any state that leaves an illegal pose
        // clears ready. Closes the host-start + ranked auto-start paths against a
        // stale/spoofed ready.
        if (
          c.player.ready &&
          !this.startPoseLegal(c.player.spec, c.player.alliance, c.player.startPose)
        ) {
          c.player.ready = false;
        }
        this.broadcastRoster();
        if (this.phase === 'strategy') this.maybeBeginRanked();
        break;
      }
      case 'start':
        // physics WASM may still be loading in the first moment after boot; refuse
        // rather than throw inside step() (which would kill the tick loop)
        if (id === this.hostId && this.world === null) {
          if (physicsReady()) this.startMatch();
          else c.send({ t: 'error', message: 'Server is starting up - try again in a moment.' });
        }
        break;
      case 'rematch':
        this.voteRematch(id, msg.on === true);
        break;
      case 'lobby':
        // host only, exactly like `start` — the room is shared state and one player must
        // not tear the results screen out from under the rest of it.
        if (id === this.hostId) this.returnToLobby();
        break;
      case 'restart':
        // Rematch/restart is DISABLED for multiplayer: re-authoring a live match for
        // everyone caused post-restart desync (stuck/jitter). Ignored for ALL clients
        // (incl. older builds that still show a host REMATCH button) — players return
        // to the lobby to start a fresh match instead.
        break;
      case 'input':
        this.onInput(id, msg.tick, msg.q, msg.ack, msg.gen);
        break;
      case 'join':
        break; // join is handled at the connection layer
    }
  }

  private onInput(id: string, tick: number, q: unknown, ack?: number, gen?: number): void {
    // STALE GENERATION: an input produced for a match this room has already replaced.
    // Dropping it is the whole reason a rematch can rebuild in place — see `matchGen`.
    // Absent (older client) ⇒ accepted, exactly as before.
    if (gen !== undefined && gen !== this.matchGen) return;
    // Record the client's confirmed snapshot baseline (piggybacked ack). Kept even
    // for a dropped/spectating robot below — it's transport bookkeeping, not a command.
    //
    // ⚠️ THE ACK IS NOW LOAD-BEARING, NOT JUST A HEALTH SIGNAL: for a `lossy` client it KEYS
    // the delta, so a value the world has not reached would pin the baseline ahead of the
    // world and every subsequent delta would come out empty — the client would be told
    // nothing ever changed again. It is still monotonic (an ack cannot go backwards), and it
    // is refused outright unless it names a tick that actually happened.
    if (
      typeof ack === 'number' &&
      Number.isSafeInteger(ack) &&
      ack >= 0 &&
      this.world !== null &&
      ack <= this.world.tick &&
      ack > (this.snapAck.get(id) ?? -1)
    ) {
      this.snapAck.set(id, ack);
    }
    const rid = this.robotOf.get(id);
    if (rid === undefined || this.dropped.has(rid)) return;
    // REFUSE AN IMPOSSIBLE FUTURE TICK OUTRIGHT. Rejected here rather than at the buffer
    // below because `latestTick` is a high-water mark: one input stamped 1e9 would leave
    // every subsequent honest input looking stale, and that robot would stop responding to
    // its own driver. LATE inputs (tick <= w.tick) are legitimate and pass through — the
    // `latest` path exists for them.
    // A TICK IS A COUNT OF SIM STEPS, so the only legal values are safe non-negative
    // integers. `Number.isInteger` alone admitted two kinds of nonsense: a NEGATIVE tick
    // (which no world ever reaches, so it can only ever be noise), and an UNSAFE one like
    // 1e21 (an integer by the language's reckoning, but arithmetic on it stops being
    // exact, so every comparison below silently stops meaning what it reads as). Neither
    // is exploitable today — the high-water comparisons happen to ignore a negative, and
    // the lead cap happens to catch 1e21 whenever a world exists — but both of those are
    // accidents of order downstream, not decisions, and `latestTick`/`ackTick` are
    // high-water marks that cannot be lowered once poisoned. Reject at the door instead.
    if (!Number.isSafeInteger(tick) || tick < 0) return;
    if (this.world && tick - this.world.tick > MAX_INPUT_LEAD_TICKS) return;
    // AND THE PAYLOAD ITSELF, for the same reason the tick above is checked here: `q` is
    // typed `QCommand` by the wire types and is in fact whatever `JSON.parse` produced.
    // `dequantizeCommand` would turn a missing axis into NaN and an out-of-range one into a
    // track speed no motor can reach, inside the world every OTHER member of this room is
    // being sent as authority. Refused before `latest`, `pending` or liveness see it.
    const safe = sanitizeQCommand(q);
    if (!safe) return;
    const cmd = dequantizeCommand(safe);
    // track the freshest command by tick (even if it's now in the past) — this is
    // what a late input still contributes, so the robot keeps moving
    if (tick > (this.latestTick.get(rid) ?? -1)) {
      this.latestTick.set(rid, tick);
      this.latest.set(rid, cmd);
    }
    if (this.world) this.lastRecvTick.set(rid, this.world.tick); // liveness
    // ALSO buffer FUTURE inputs by exact tick — an on-time client's robot then
    // matches its own prediction exactly (smooth); a late one falls back to latest.
    // Only while a world exists: `startMatch` clears `pending`, so anything buffered
    // before then is discarded regardless, and buffering against no reference tick is
    // the one case `MAX_INPUT_LEAD_TICKS` could not bound.
    const w = this.world;
    if (w && tick > w.tick && tick - w.tick <= MAX_INPUT_LEAD_TICKS) {
      let buf = this.pending.get(rid);
      if (!buf) {
        buf = new Map();
        this.pending.set(rid, buf);
      }
      buf.set(tick, cmd);
      // backstop — drop oldest-first so the freshest prediction is what survives
      if (buf.size > MAX_PENDING_PER_ROBOT) {
        for (const t of [...buf.keys()].sort((a, b) => a - b).slice(0, buf.size - MAX_PENDING_PER_ROBOT)) {
          buf.delete(t);
        }
      }
    }
    if (tick > (this.ackTick.get(id) ?? -1)) this.ackTick.set(id, tick);
  }

  private startMatch(): void {
    const record = this.config.kind === 'record';
    // A DUO record credits BOTH drivers on the leaderboard (primary + partner), but
    // the partner is only persisted if they're signed in (persist.ts filters to
    // authed participants). A guest partner would silently save as a one-name run,
    // so refuse to start a duo record until every driver is authenticated.
    if (record && this.config.record === 'duo') {
      const guest = [...this.clients.values()].find((c) => !c.userId);
      if (guest) {
        this.broadcast({
          t: 'error',
          message: 'Both drivers must be signed in to save a Duo record run.',
        });
        return;
      }
    }
    // Refuse to start if any driver's start pose is illegal for their chassis — we
    // block-and-warn rather than let createWorld silently relocate the robot. The
    // ready gate (case 'update') already prevents this in normal flow; this also
    // closes the host-start path, which is NOT gated on all-ready server-side.
    // start-pose legality is a DECODE (G304) concept — only enforce it for a game
    // that has a start editor (CR has none yet).
    {
      for (const c of this.clients.values()) {
        const a: Alliance = record ? 'blue' : c.player.alliance;
        if (!this.startPoseLegal(c.player.spec, a, c.player.startPose)) {
          this.broadcast({
            t: 'error',
            message: 'A driver’s start position is invalid for their chassis - fix it to start.',
          });
          return;
        }
      }
    }
    // record runs are OPPONENT-FREE co-op: every robot on one alliance (blue).
    // Each driver brings their OWN build, so a duo may mix drivetrains — a mixed
    // pair just keys the record board's OVERALL bucket (decided at persist time).
    // So there is no drivetrain gate here.
    // build setups from the current roster; keep start poses distinct per alliance
    const roster = [...this.clients.values()];
    const used: Record<Alliance, Set<number>> = { red: new Set(), blue: new Set() };
    const anchors = simModuleFor(this.game).startPoseCount;
    const setups: RobotSetup[] = [];
    this.robotOf.clear();
    roster.forEach((c, i) => {
      const alliance: Alliance = record ? 'blue' : c.player.alliance;
      let si = c.player.startIndex ?? 0;
      // find an unused pose, but stop after a full cycle: with more robots on one
      // alliance than there are ANCHORS (ROOM_CAPACITY 4 > BIOBUZZ's 2 — e.g. a
      // custom 4-on-one room), every pose is taken and an unbounded `while` would
      // spin forever, hanging the tick loop / health probe until Fly kills the box.
      // Reuse a pose instead (the physics solver pushes the overlap apart).
      //
      // THE COUNT IS THIS ROOM'S GAME'S, not DECODE's five. It used to read the DECODE
      // anchor list directly, which for a game with FEWER anchors hands out an index that
      // game cannot resolve: a 4-robot BIOBUZZ alliance got 0/1/2/3 against TWO anchors, and
      // 2 and 3 then fell to whatever its spawn does with a miss. `startPoseCount` is on the
      // module precisely so every clamp reads one number (`coerceStartIndex`, `coerceSetup`
      // and `coerceSettings` already do). Read once per call: a registry lookup, not a field.
      for (let n = 0; n < anchors && used[alliance].has(si); n++) {
        si = (si + 1) % anchors;
      }
      used[alliance].add(si);
      setups.push({
        id: i,
        alliance,
        spec: c.player.spec,
        assists: c.player.assists,
        startIndex: si,
        // a custom pose overrides the de-conflicted startIndex; createWorld snaps
        // it G304-legal. Old clients omit it → the preset is used.
        startPose: c.player.startPose ?? undefined,
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
    // Autonomous does NOT run in server-authoritative matches yet — an auto path
    // isn't reconciled against the server's authority, so it would desync. Strip
    // it from EVERY setup here (the one chokepoint all match paths funnel through),
    // regardless of what a client advertised. Local session-less practice, which
    // never reaches Room, keeps running auto client-side.
    setups = setups.map((s) => ({ ...s, autoPath: undefined, autoPathEnabled: false }));
    this.phase = 'match';
    this.matchGen++; // any input stamped with an older generation is now stale
    this.rematchVotes.clear();
    this.matchSeed = seed; // remembered so a spectator joining mid-match gets matchStart
    this.matchSetups = setups;
    const world = simModuleFor(this.game).createWorld('match', seed, setups);
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
    this.prevSnapTick = -1;
    this.snapChanged.length = 0;
    this.snapHistoryFrom = -1;
    this.snapPrimed.clear();
    this.snapAck.clear();
    // start recording the input log; finalized once at phase 'post'. Stamp the game so
    // the replay re-sims through the right module (CR vs DECODE).
    this.recorder = new ReplayRecorder(seed, setups, 'match', this.game);
    this.finalized = false;
    this.settle = newSettleClock();
    this.departed.clear();

    // register each authed driver's single-game lock: while this match is live they
    // can't start a second game elsewhere (they'd have to rejoin or leave this one)
    for (const c of this.clients.values()) {
      if (c.userId) {
        this.activeUserIds.add(c.userId);
        this.onUserActive?.(c.userId);
      }
    }

    for (const c of this.clients.values()) c.send(this.matchStartMsg(this.robotOf.get(c.id) ?? 0));
    // the votes were cleared above — SAY so, or both clients carry the old full
    // tally into the new run and the button reads "2/2" on a run nobody voted for.
    //
    // EVERY ROOM, and this was the last record-only gate left over from when the
    // vote was co-op's alone. It is also the ONLY place a client is told the tally
    // at the start of a match — `refreshRematch` fires on a leave or a reattach,
    // never on an ordinary join — so a custom room's drivers sat at `need: 0`, and
    // both the HUD button and the results-screen one hide below `need > 1`.
    // Reported as "rematch button does not appear in a custom game".
    this.broadcastRematch();
    // spectators already watching a lobby/strategy room get the match start too (yourRobotId -1)
    for (const c of this.spectators.values()) c.send(this.matchStartMsg(-1));
    this.startLoop();
  }

  // ---- region-aware ranked: host-side build from a staged roster --------------

  /** stage this room as the host for a matchmaker-paired ranked match. The roster
   * (specs/alliances/seed) is authoritative; the match begins once every staged
   * player reconnects (`maybeStartRanked`) or cancels after the join grace. */
  applyPending(p: PendingMatch): void {
    this.pendingMatch = p;
    this.ranked = true;
    // the matchmaker groups a single channel; carry it so an alpha ranked match
    // is segregated + unpersisted just like custom/record alpha rooms
    if (p.channel) this.channel = p.channel;
    this.intros = p.roster.map((r, i) => ({ id: i, elo: r.introElo }));
    /**
     * THE LOCK IS TAKEN HERE, NOT AT `startMatch` — a staged match is a commitment.
     *
     * The single-game lock used to be registered only when the world was built, so
     * between the assignment and the first tick a paired player held no lock at all:
     * `activeElsewhere` answered false and the ranked queue let them straight back in
     * (`server/index.ts`, the `queue` handler). Refresh the tab while "Match found" is
     * up and that is exactly what happens — the reload loses the room (the queue keeper
     * is in memory), FIND MATCH re-enters the pool, and the room they abandoned still
     * bills them a no-show when the grace lapses. Reported as "you should not be able
     * to re-enter queue if you're entering a match".
     *
     * Registered from the ROSTER rather than from `this.clients`: the whole point is
     * that it must hold for a player who has not connected here yet. `stop()` releases
     * it, and `cancelPending` stops the room, so a cancelled staging frees it too.
     */
    for (const r of p.roster) {
      if (!r.userId) continue;
      this.activeUserIds.add(r.userId);
      this.onUserActive?.(r.userId);
    }
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    // NO-SHOW: whoever is still missing when the grace lapses is the one who dodged. The
    // players who DID connect are innocent and are charged nothing.
    this.pendingTimer = setTimeout(
      () =>
        this.cancelPending(
          'Match cancelled - an opponent did not connect.',
          this.absentRoster().map((userId) => ({ userId, kind: 'noshow' as DodgeKind })),
        ),
      RANKED_JOIN_GRACE_MS,
    );
    if (this.pendingTimer.unref) this.pendingTimer.unref();
    this.maybeStartRanked(); // in case everyone is already here
  }

  /** the room code this room was staged under (null if not a staged ranked room) */
  pendingCode(): string | null {
    return this.pendingMatch?.code ?? null;
  }

  /**
   * A STAGED PAIRING THAT HAS NOT BEGUN — the window between the matchmaker assigning
   * this room and `startMatch` building its world (`connecting`, then `strategy`).
   *
   * `pendingMatch` is never cleared, so it alone cannot answer this: it stays set for
   * the life of the room and reads true for a match that has been running for a minute.
   * The world is what separates "loading in" from "playing", and the queue guard needs
   * the difference to say the right sentence.
   */
  staging(): boolean {
    return this.pendingMatch !== null && this.world === null && !this.cancelled;
  }

  /**
   * Is this user NAMED on the staged roster the matchmaker wrote for this room?
   *
   * The one-live-game guard reads it to tell a game somebody CHOSE to start from
   * one the SERVER committed them to. A staged ranked match is not a second game
   * they went and opened — it is the match they are already in, and this roster is
   * the server's own record of that, so it outranks a stale slot they are still
   * holding elsewhere. Without it, being matched out of a backgrounded queue while
   * mid-run was an automatic forfeit: the run's slot is held for the reconnect
   * grace, and the ranked join it blocks is the one that pays ELO.
   */
  stagedFor(userId: string): boolean {
    return !!this.pendingMatch?.roster.some((r) => r.userId === userId);
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
        game: this.game,
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
      // NEVER READIED: the players who sat out the window. Anyone who readied is innocent —
      // they did everything asked of them and still lost the match.
      this.cancelPending(
        'Match cancelled - not everyone readied up in time.',
        [
          ...[...this.clients.values()]
            .filter((c) => c.connected && c.userId && !c.player.ready)
            .map((c) => ({ userId: c.userId as string, kind: 'unready' as DodgeKind })),
          ...this.absentRoster().map((userId) => ({ userId, kind: 'noshow' as DodgeKind })),
        ],
      );
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
      this.cancelPending(
        'Match cancelled - an opponent disconnected.',
        this.absentRoster().map((userId) => ({ userId, kind: 'bail' as DodgeKind })),
      );
      return;
    }
    // roster index = robotId; keep start poses distinct per alliance as an AFK fallback
    const used: Record<Alliance, Set<number>> = { red: new Set(), blue: new Set() };
    const anchors = simModuleFor(this.game).startPoseCount;
    const setups: RobotSetup[] = [];
    this.robotOf.clear();
    p.roster.forEach((r, i) => {
      const c = byUser.get(r.userId as string) as Client;
      let si = c.player.startIndex ?? 0;
      // this room's game's anchor count, not DECODE's five - see the same loop above
      for (let n = 0; n < anchors && used[r.alliance].has(si); n++) {
        si = (si + 1) % anchors;
      }
      used[r.alliance].add(si);
      setups.push({
        id: i,
        alliance: r.alliance, // authoritative (from the staged roster)
        spec: c.player.spec, // LIVE re-picked build
        assists: c.player.assists,
        startIndex: si,
        startPose: c.player.startPose ?? undefined, // LIVE re-picked custom pose
        autoPath: c.player.autoPath,
        autoPathEnabled: c.player.autoPathEnabled,
      });
      this.robotOf.set(c.id, i);
    });
    this.beginMatch(setups, p.seed);
  }

  /** a staged ranked match no player (or not everyone) showed up for: tell whoever
   * did connect and tear the room down (no rated match runs). */
  private cancelPending(
    message = 'Match cancelled - an opponent did not connect.',
    culprits: { userId: string; kind: DodgeKind }[] = [],
  ): void {
    if (this.world !== null) return; // already started
    // ⚠️ ONCE. The room is gone after this, but its sockets are not: each still routes its
    // close to `detach`, and `pendingMatch`/`phase` still read as an open strategy window, so
    // the first player to leave the cancelled screen used to cancel it AGAIN — billed as a
    // STRATEGY BAIL. The innocent player was told "Nothing was charged to you" by the first
    // verdict and then lost standing to the second, which went to a socket already closing.
    if (this.cancelled) return;
    this.cancelled = true;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (this.strategyTimer) {
      clearTimeout(this.strategyTimer);
      this.strategyTimer = null;
    }
    const p = this.pendingMatch;
    /**
     * BILL THE DODGE before tearing the room down.
     *
     * A cancelled ranked pairing costs three other people their next few minutes, and until
     * now it cost the person who caused it nothing. The culprits are worked out at each
     * cancel site (who never connected / who dropped / who never readied) rather than here,
     * because only the caller knows which of the three failures happened.
     *
     * Everyone still connected is TOLD the verdict — the penalised so a rating drop is never
     * unexplained, and the innocent so they know the cancel was not charged to them. The
     * sockets are still open at this point; `stop()` below closes them, so this has to fire
     * first and the verdict is relayed from the async reply.
     */
    if (p && this.ranked && culprits.length && this.onDodge) {
      const listeners = [...this.clients.values()].filter((c) => c.connected);
      void Promise.resolve(
        this.onDodge({
          culprits,
          mode: p.mode,
          game: this.game,
          rosterUserIds: p.roster.map((r) => r.userId).filter((u): u is string => !!u),
          roomCode: this.code,
        }),
      )
        .then((verdicts) => {
          if (!verdicts?.length) return;
          for (const c of listeners) {
            if (!c.userId) continue;
            const mine = verdicts.find((v) => v.userId === c.userId) ?? null;
            c.send({ t: 'dodgeVerdict', message, yours: mine, others: verdicts.filter((v) => v.userId !== c.userId && v.kind) });
          }
        })
        .catch((e) => console.error('[dodge] penalty failed:', e));
    }
    this.broadcast({ t: 'error', message });
    this.stop();
    this.onEmpty();
  }

  /** roster members who are NOT currently connected here — the no-show set. */
  private absentRoster(): string[] {
    const p = this.pendingMatch;
    if (!p) return [];
    const present = new Set(
      [...this.clients.values()].filter((c) => c.connected && c.userId).map((c) => c.userId),
    );
    return p.roster.map((r) => r.userId).filter((u): u is string => !!u && !present.has(u));
  }

  private startLoop(): void {
    this.stopLoop(); // NOT `stop()` — the locks `startMatch` just took must survive this
    let last = Date.now();
    let acc = 0;
    this.loop = setInterval(() => {
      // a throw here would otherwise kill the whole process (every room) and Fly
      // would report "app not listening" — contain it to this tick instead
      try {
        this.checkGrace(); // finalize any driver whose reconnect grace has lapsed
        if (this.clients.size === 0) return; // room emptied (loop already stopped)
        // GHOST ROOM: every driver has dropped but none has been gone long enough for
        // `checkGrace` to reap them, so the slots are still held and the room keeps
        // stepping Rapier at 60 Hz for nobody. Measured under load: 19 rooms burning
        // 0.906 cores with 0 players (docs/capacity.md §7).
        //
        // Freezing loses NOTHING, which is the part worth knowing before changing it: a
        // match nobody returns to is never finalized at all — when the last grace lapses
        // `checkGrace` calls `onEmpty()` and the room is deleted, with no `finalizeMatch`
        // on that path. So these ticks can only ever be thrown away.
        //
        // And when somebody DOES come back, resuming where they left is the better
        // outcome anyway. It is what makes a whole-region restart survivable: today both
        // sides of a ranked match return to a world that ran 45 s without either of them,
        // which is unplayable and effectively a double forfeit.
        //
        // `last`/`acc` are reset so the resume does not fast-forward the frozen
        // wall-clock — without that, the catch-up clamp would burn 0.25 s of sim in one
        // turn the moment the first player reconnects.
        //
        // ⚠️ SO THE MATCH CLOCK PAUSES; IT DOES NOT JUMP. `phaseTimeLeft` is counted down
        // by `stepMatch`, i.e. per TICK, and no tick runs while this is frozen — a 45 s
        // region blip costs the match no game time at all, on purpose (that is the whole
        // "survivable restart" argument above). Two consequences that are POLICY and not
        // accidents, stated here because neither is visible from the code:
        //   · the resume is triggered by ANY ONE driver reconnecting, so in a 2v2 the
        //     clock restarts for all four the moment the first of them is back, while the
        //     other three are still inside their reconnect grace;
        //   · a match therefore takes longer in wall-clock time than its own clock says,
        //     which anything reading `Date.now()` around a match (the grace timers, the
        //     post-match settle) does not see.
        // `checkGrace` deliberately keeps running on the WALL clock through the freeze, so
        // a player who never comes back is still reaped on schedule.
        if (this.frozenForNobody()) {
          last = Date.now();
          acc = 0;
          return;
        }
        const now = Date.now();
        acc += (now - last) / 1000;
        last = now;
        if (acc > 0.25) acc = 0.25; // never fast-forward more than a quarter second
        let n = 0;
        let due = false;
        while (acc >= C.SIM_DT && n < 8 && !this.finalized) {
          if (this.stepOnce()) due = true;
          acc -= C.SIM_DT;
          n++;
        }
        // COALESCE snapshots: send AT MOST ONE per timer fire, at the newest tick.
        // When a scheduling hitch / GC pause delays this timer, the loop catches up
        // several ticks in one turn — and the old "broadcast inside stepOnce on every
        // interval crossing" then flushed a BURST of snapshots back-to-back down the
        // same socket. The client received them with ~0 ms spacing followed by a gap,
        // which reads as snapshot jitter → the exact stutter/rubberband being chased
        // (CPU is idle; it's timing, not load). One send per fire keeps outbound
        // spacing even and hands the client a single freshest world to reconcile to.
        if (due && !this.finalized) this.broadcastSnapshot();
      } catch (e) {
        console.error(`[room ${this.code}] tick error at tick ${this.world?.tick}:`, e);
      }
    }, 1000 * C.SIM_DT);
  }

  /**
   * Count one tick of participation (see the counters above).
   *
   * ONLY live phases count. `pre` is the countdown nobody drives through, `post` is the
   * results screen, and a `freeplay` room is not a match at all — including any of them
   * would let a long countdown make an honest driver look absent.
   *
   * "Drove" is deliberately generous: any stick off centre, or any button. The question this
   * answers is "was a person there", not "did they play well", and a driver parked in their
   * base spinning the intake is playing badly, which is not an offence.
   */
  private countParticipation(w: World): void {
    const phase = w.match.phase;
    if (phase !== 'auto' && phase !== 'teleop' && phase !== 'transition') return;
    this.liveTicks++;
    for (const r of w.robots) {
      const c = this.lastFrame?.get(r.id);
      const moving =
        !!c &&
        (Math.abs(c.driveX) > 0.05 || Math.abs(c.driveY) > 0.05 || Math.abs(c.rotate) > 0.05 ||
          Math.abs(c.leftDrive) > 0.05 || Math.abs(c.rightDrive) > 0.05 ||
          c.intake || c.fire || !!c.catalyst || !!c.fling || !!c.driveMode ||
          !!c.bbPlaceNectar || !!c.bbPlace || !!c.bbNectar);
      if (moving) this.driveTicks.set(r.id, (this.driveTicks.get(r.id) ?? 0) + 1);
      // AWAY is measured from the socket, not from the sticks: a driver whose client is
      // gone is a different thing from one who is present and idle, and only the first is
      // "left the match".
      const away = this.departed.has(r.id) || !this.driverConnected(r.id);
      if (away) this.awayTicks.set(r.id, (this.awayTicks.get(r.id) ?? 0) + 1);
    }
  }

  /** is the client driving this robot currently connected? (a reconnecting driver inside
   *  their grace window still counts as away for these ticks — they were, in fact, away) */
  private driverConnected(robotId: number): boolean {
    for (const c of this.clients.values()) {
      if (this.robotOf.get(c.id) === robotId) return c.connected;
    }
    return false;
  }

  /** advance the authoritative sim exactly one tick: build the per-robot command
   * frame, step, RECORD it (the replay input log), snapshot on cadence, and
   * finalize at match end. Both the real-time loop and `advanceForTest` go
   * through here, so recording is identical live and headless. Returns whether this
   * tick is a snapshot-cadence tick; the caller coalesces a catch-up burst into ONE
   * broadcast (see startLoop) so a delayed timer never floods the socket. */
  private stepOnce(): boolean {
    const w = this.world as World;
    this.lastFrame = this.frameCommands(w.tick + 1);
    simModuleFor(this.game).step(w, C.SIM_DT, this.lastFrame);
    this.recorder?.record(w.tick, this.lastFrame);
    this.countParticipation(w);
    const due = w.tick % SNAPSHOT_INTERVAL === 0;
    // FINALIZE WHEN THE FIELD HAS SETTLED, NOT ON A TIMER. The buzzer ends driving, not
    // scoring: an artifact can still be in the air or on the ramp, a hive can still be tipping.
    // Keep stepping (and recording) until the game says nothing left can change the score, so
    // the number saved is the settled one — and the results screen reveals only on it.
    if (!this.finalized && settleStep(this.settle, w, simModuleFor(this.game).settled)) {
      this.finalizeMatch();
    }
    return due;
  }

  /** the match reached phase 'post': broadcast the SERVER's authoritative score +
   * the recorded replay (the leaderboard submission), then stop the loop but keep
   * clients connected for the results screen. Idempotent (fires once). Phase 3's
   * DB layer persists `result`/`replay` from here. */
  private finalizeMatch(): void {
    if (this.finalized || !this.world || !this.recorder) return;
    this.finalized = true;
    // the match is DECIDED — free every single-game lock so players can immediately
    // start a fresh game (the room lingers in 'post' only for the results screen)
    this.releaseActiveUsers();
    const w = this.world;
    const replay: Replay = this.recorder.finish();
    const result = worldResult(w);
    // MINT THE MATCH ID HERE, at the one moment a match becomes a thing that happened.
    // Every recipient of this broadcast gets the same id, which is what lets a
    // self-hosted match be uploaded by a client without the cloud having to guess
    // whether two uploads are one match or two (docs/lan-selfhost.md). Minted at
    // finalize rather than at start because a match nobody finishes is never
    // uploaded, and a rematch is a different match.
    this.matchId = randomUUID();
    // THE ID GOES TO THE HOST, THE RESULT GOES TO THE ROOM. Possession of the match id is the
    // right to file this match in the cloud archive (the cloud cannot verify who hosted a
    // self-hosted match — it was not there), so broadcasting it handed that right to every
    // driver and every spectator and let whoever uploaded first take the row under their own
    // account. Sent FIRST, on the same ordered socket, so the host has it before the result it
    // belongs to. See the 'matchArchive' note in `src/net/protocol.ts`.
    this.clients.get(this.hostId)?.send({ t: 'matchArchive', matchId: this.matchId });
    this.broadcast({
      t: 'matchResult',
      kind: this.config.kind,
      record: this.config.record,
      result,
      replay,
    });
    // hand the authoritative outcome to the persistence layer (off the hot path).
    // ALPHA (in-development) rooms are NEVER persisted: the results screen + replay
    // still work from the broadcast above, but no leaderboard/ELO/record DB write
    // happens (and no recordResult/eloResult follows — the client shows "not saved").
    if (this.onResult && !this.unpersisted) {
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
      this.reportBehaviour(participants);
      const ret = this.onResult({
        game: this.game,
        config: this.config,
        ranked: this.ranked,
        // the format this match WAS, not the number of people left holding a controller at the
        // end of it: the queue bucket when the matchmaker staged this room, else the roster it
        // actually fielded. See `MatchOutcome.mode`.
        mode: this.pendingMatch?.mode ?? (this.matchSetups.length ? eloMode(this.matchSetups.length) : undefined),
        result,
        replay,
        participants,
      });
      // resolves once persisted (async DB write): versus → per-driver ELO deltas;
      // record → the run's leaderboard standing. Broadcast so the results screen
      // can reveal the ELO change (versus) or the PB / WR / rank line (record).
      if (ret && typeof (ret as Promise<unknown>).then === 'function') {
        // A REMATCH WAITS FOR THIS. The rematch's `matchStart` re-sends `this.intros`, and
        // those are the ratings from when the pairing was STAGED — so a rematch voted through
        // before this lands introduced every driver at their pre-match rating. Capped, so a
        // slow or failed write can delay a rematch but never block it.
        this.resultPending = true;
        if (this.resultWait) clearTimeout(this.resultWait);
        const settle = (): void => {
          if (!this.resultPending) return;
          this.resultPending = false;
          if (this.resultWait) clearTimeout(this.resultWait);
          this.resultWait = null;
          this.maybeRematch();
        };
        this.resultWait = setTimeout(settle, 5000);
        if (this.resultWait.unref) this.resultWait.unref();
        void (ret as Promise<PersistOutcome | void>)
          .then((out) => {
            if (!out) return;
            if (out.matchId) this.lastMatchId = out.matchId;
            // THE INTRO RATINGS FOLLOW THE RESULT. `intros` is set once from the staged
            // roster and re-sent on every rematch's `matchStart`; without this the rematch
            // showed each driver the rating from BEFORE the match they just played. Done
            // before the empty-room return, since nothing is sent from here.
            if (out.elo && out.elo.length && this.intros.length) {
              const afterByRobot = new Map<number, number>();
              for (const e of out.elo) {
                const robotId = robotByUser.get(e.userId);
                if (robotId !== undefined) afterByRobot.set(robotId, e.after);
              }
              this.intros = this.intros.map((i) => ({ ...i, elo: afterByRobot.get(i.id) ?? i.elo }));
            }
            if (this.clients.size === 0) return;
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
          .catch((err) => console.error('[room] result broadcast failed:', err))
          .finally(settle);
      }
    }
    this.stop();
    // the driver left once the run was decided (see `finishing`): it is saved now, so free the
    // room — at once for a deliberate close, after the reconnect grace for a dropped network
    const f = this.finishing;
    this.finishing = null;
    if (f) {
      if (f.reap) {
        for (const x of this.clients.values()) if (!x.connected) x.disconnectAt = -Infinity;
        this.checkGrace();
      } else {
        this.armGraceReap();
      }
    }
  }

  /**
   * Turn this match's participation counters into a behaviour report.
   *
   * RANKED ONLY. A custom room is people messing about with friends; standing exists to
   * protect the ranked queue, and charging someone for going to make a cup of tea during a
   * private practice match would be indefensible.
   *
   * The MODE comes from the roster size rather than the queue that made the room, because
   * this is only ever read back as context on a ledger row.
   */
  private reportBehaviour(participants: MatchParticipant[]): void {
    if (!this.onBehaviour || !this.ranked || this.unpersisted) return;
    const mode: '1v1' | '2v2' = participants.length > 2 ? '2v2' : '1v1';
    const offenders: { userId: string; kind: 'afk' | 'leave' }[] = [];
    const cleanUserIds: string[] = [];
    for (const p of participants) {
      if (!p.userId) continue;
      const rid = this.robotOf.get(p.clientId) ?? this.robotIdOfUser(p.userId);
      if (rid === undefined) continue;
      const kind = judgeParticipation({
        liveTicks: this.liveTicks,
        driveTicks: this.driveTicks.get(rid) ?? 0,
        awayTicks: this.awayTicks.get(rid) ?? 0,
      });
      if (!kind) cleanUserIds.push(p.userId);
      else if (chargedForParticipation(kind, mode)) offenders.push({ userId: p.userId, kind });
      // else: an EXCUSED 1v1 leaver — neither charged nor credited as clean
    }
    /**
     * CARDS travel with the behaviour report, from the world the match was played in.
     *
     * `world.penalties.carded` is keyed by ROBOT id and holds the colour each carded robot
     * currently shows — a second card escalates the same robot to red rather than adding a
     * row, which is exactly the shape a standing charge wants: one event per carded driver,
     * priced by what they ended the match holding.
     */
    const carded: { userId: string; colour: 'yellow' | 'red' }[] = [];
    const held = this.world?.penalties.carded ?? {};
    for (const p of participants) {
      if (!p.userId) continue;
      const rid = this.robotOf.get(p.clientId) ?? this.robotIdOfUser(p.userId);
      if (rid === undefined) continue;
      const colour = held[rid];
      if (colour === 'yellow' || colour === 'red') carded.push({ userId: p.userId, colour });
    }
    if (!offenders.length && !cleanUserIds.length && !carded.length) return;
    this.onBehaviour({
      offenders,
      carded,
      cleanUserIds,
      mode,
      game: this.game,
      roomCode: this.code,
    });
  }

  /** the robot a DEPARTED user was driving (their client is gone, so `robotOf` cannot
   *  answer) — without this, walking out would erase the evidence of walking out */
  private robotIdOfUser(userId: string): number | undefined {
    for (const [rid, d] of this.departed) if (d.userId === userId) return rid;
    return undefined;
  }

  /**
   * REMATCH: a vote, not a command — in EVERY room.
   *
   * A match belongs to everyone in it, so nobody may restart it out from under the
   * rest — mid-match OR from the results screen. Each driver toggles their own vote,
   * the count is broadcast so the room can see "2/4", and the match restarts only
   * once every CONNECTED driver has said yes.
   *
   * This used to be record-only, on the reasoning that "everyone agrees" is a
   * meaningful gate for co-op and a coercion surface in a versus match. Unanimity is
   * what answers that: nobody is restarted against their will, and declining costs a
   * player nothing — they simply do not press it. Rooms that want a rematch were
   * otherwise made to leave and re-queue for each other.
   *
   * ⚠️ RANKED CONSEQUENCE, deliberately not decided here. `beginMatch` clears
   * `finalized`, and `this.ranked` is a ROOM flag, so a rematch in a matchmade room
   * produces a SECOND rated match without going back through the matchmaker. Rated
   * friend games are already farmable by a colluding pair and deliberately
   * unmitigated (see CLAUDE.md), but a button makes it cheaper than a re-queue. If
   * that becomes a problem the one-line fix is to clear `this.ranked` in
   * `maybeRematch`, which keeps the feature everywhere and makes the rematch
   * unrated.
   */
  private voteRematch(id: string, on: boolean): void {
    if (!this.clients.has(id)) return; // spectators do not get a vote
    if (on) this.rematchVotes.add(id);
    else this.rematchVotes.delete(id);
    this.broadcastRematch();
    this.maybeRematch();
  }

  /** everyone still connected has to agree, and the tally is against that same
   *  number — a partner who drops mid-vote must not leave the run un-restartable */
  private connectedDrivers(): string[] {
    return [...this.clients.values()].filter((c) => c.connected).map((c) => c.id);
  }

  private broadcastRematch(): void {
    const ids = this.connectedDrivers();
    const votes = ids.filter((i) => this.rematchVotes.has(i)).length;
    /**
     * `need` IS THE NUMBER OF DRIVERS THE REMATCH ACTUALLY TAKES — the roster it would field,
     * not just whoever is still here.
     *
     * With a seat empty the tally read "1/1" and pressing it did nothing, which is the worst
     * possible way to say "this cannot happen": the one remaining driver saw a complete vote
     * and a dead button. Counting the seats says it out loud — "1/2", and the missing driver is
     * visibly missing from the roster. `matchSetups` is empty before the first match and after
     * a recycle, where the connected count is the only answer there is (and a one-driver record
     * room must keep reporting 1, or the client grows a 1/1 ballot where it shows a button).
     */
    const need = Math.max(ids.length, this.matchSetups.length);
    for (const c of this.clients.values()) {
      c.send({ t: 'rematch', votes, need, you: this.rematchVotes.has(c.id) });
    }
  }

  /**
   * IS EVERY SEAT THE REMATCH WOULD FIELD STILL HELD BY A CONNECTED DRIVER?
   *
   * A rematch REPLAYS `matchSetups` frozen at the first start, so it cannot drop a robot whose
   * driver has gone — `returnToLobby` says so in as many words about its own cleanup: the next
   * match "would spawn a robot with no driver, which is the exact failure a rematch has today".
   * This is that failure. The vote was gated on CONNECTED drivers alone, so the one player left
   * at the results screen was unanimous by themselves and could start a match against an empty
   * chassis — a RATED one, because `this.ranked` is a room flag and `beginMatch` clears
   * `finalized`.
   *
   * Reported (ranked, 2026-09-14): "I play a game, I win it and after a few minutes of just
   * training my elo goes down and another match appears in my history which I never played. On
   * replay, the enemy bot appears and moves but mine simply doesn't move at all." Their client
   * was still in `clients` on its reconnect grace when the rematch began, so `checkGrace` reaped
   * it mid-match into `departed` — which exists so an ABANDONED match still rates — and the
   * ghost was rated, filed in their history and charged to their ELO. In the 2v2 case it also
   * came out with three participants, which `eloMode` then called a 1v1.
   *
   * The SEAT is the thing to test, not the vote: a driver who is in the room but not connected
   * is not going to drive. Same answer for a duo record run — a co-op score attempt with a dead
   * partner is not a run anyone wants on the board.
   */
  private rematchSeatsHeld(): boolean {
    const held = new Set<number>();
    for (const c of this.clients.values()) {
      if (!c.connected) continue;
      const rid = this.robotOf.get(c.id);
      if (rid !== undefined) held.add(rid);
    }
    return this.matchSetups.every((s) => held.has(s.id));
  }

  private maybeRematch(): void {
    const ids = this.connectedDrivers();
    if (ids.length === 0) return;
    if (!ids.every((i) => this.rematchVotes.has(i))) return;
    if (!this.matchSetups.length) return;
    // ...and every SEAT it would field still has somebody in it (see `rematchSeatsHeld`)
    if (!this.rematchSeatsHeld()) return;
    // the last match's ratings are still being written: start once they are in (the
    // persist's `settle` calls back here), so the rematch introduces the updated ones
    if (this.resultPending) return;
    // a FRESH seed: a rematch is a new run at a new motif, not a replay of the old
    // one. `beginMatch` does the whole reset (world, buffers, recorder, generation)
    // through exactly the path a first start takes, so there is no second, subtly
    // different restart routine to keep in step with it.
    const seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
    this.beginMatch(this.matchSetups, seed);
  }

  /** a driver left or came back: the tally is against CONNECTED drivers, so it has
   *  to be recomputed (and may now be unanimous) */
  private refreshRematch(): void {
    for (const id of [...this.rematchVotes]) {
      if (!this.clients.has(id)) this.rematchVotes.delete(id);
    }
    this.broadcastRematch();
    this.maybeRematch();
  }

  /**
   * ---- RECYCLING A FINISHED ROOM ------------------------------------------------------
   *
   * A room used to be single-use. `this.world` was set once and never cleared, so
   * `canJoin` (which requires `world === null`) refused every later joiner and the `start`
   * gate refused every later match — the room lived on as a husk that admitted nobody and
   * started nothing until its last socket closed. The only way on to a second game was
   * `maybeRematch`, and a rematch REPLAYS `matchSetups` frozen at the first start: it cannot
   * take a new player, cannot drop one who left (their robot respawns driverless, because
   * `robotOf` was deleted with them), and cannot see an alliance anyone changed afterwards.
   * So "someone left, we want to re-pick sides and play a full game" meant minting a new
   * code and everybody re-joining it. `case 'restart'` even says players "return to the
   * lobby to start a fresh match instead" — this is that lobby.
   *
   * Recycling clears the world and puts the room back in `'connecting'`, which is the
   * ordinary pre-match lobby state. Nothing downstream needs a new mode: `canJoin` opens
   * again on its own, and `startMatch` ALREADY rebuilds setups and `robotOf` from whoever is
   * in `clients` at the moment it runs. Re-picking sides, seats, robots and the roster all
   * fall out of that one reset.
   */

  /**
   * May this room go back to its lobby at all?
   *
   * - RANKED / STAGED rooms never recycle. A matchmaker-staged room's roster is the pairing;
   *   recycling it would hand a rated room a roster nobody was matched into. Those players
   *   re-queue. (`ranked` also covers a rematch inside a staged room.)
   * - A SOLO RECORD run already has its own teardown — the client disposes the session and
   *   opens a fresh `rec-` room — and `finishing` exists to keep a decided run alive with
   *   nobody connected. Leave that path alone.
   * - EVERY MEMBER must advertise the 'recycle' capability, the same discipline the strategy
   *   window uses. One Fly app serves every client build, and a client that ignores
   *   `t: 'lobby'` would sit on a results screen for a match the room no longer has.
   */
  private canRecycle(): boolean {
    if (this.ranked || this.pendingMatch) return false;
    // VERSUS ONLY. A record run is a co-op score attempt against a leaderboard, and its
    // restart is already a full teardown into a fresh `rec-` room; there is no side to
    // re-pick and nothing here it is short of. Keeping the door shut means no client
    // surface exists for it either.
    if (this.config.kind !== 'versus') return false;
    return [...this.clients.values()].every((c) => c.caps?.includes('recycle'));
  }

  /**
   * Host asked to go back to the lobby. Refused while the match is still being played or
   * still being WRITTEN: `finalized` is the score being final, and `resultPending` is the
   * ELO/leaderboard write still in flight — tearing the world down under either would lose
   * the result that was the point of playing.
   */
  private returnToLobby(): void {
    if (this.world === null) return; // already a lobby
    if (!this.finalized || this.resultPending) return;
    if (!this.canRecycle()) return;

    this.stop(); // kills the tick loop AND releases every single-game lock
    if (this.graceReap) {
      clearTimeout(this.graceReap);
      this.graceReap = null;
    }

    /**
     * A HELD SLOT IS NOT WORTH HOLDING FOR A MATCH THAT IS OVER. `detach` keeps a
     * disconnected driver's seat for the reconnect grace so they can rejoin the run they
     * dropped out of; that run has finished. Keeping them would spend a slot on somebody
     * with nothing to come back to, and `startMatch` builds its setups from `clients` — so
     * the next match would spawn a robot with no driver, which is the exact failure a
     * rematch has today.
     */
    for (const c of [...this.clients.values()]) {
      if (c.connected) continue;
      this.clients.delete(c.id);
      this.snapPrimed.delete(c.id);
      this.snapAck.delete(c.id);
      this.ackTick.delete(c.id);
      this.passCrown(c.id);
    }

    this.world = null;
    this.phase = 'connecting';
    this.matchSeed = 0;
    this.matchSetups = [];
    this.robotOf.clear();
    this.rematchVotes.clear();
    this.recorder = null;
    this.finalized = false;
    this.matchId = null; // `lastMatchId` is kept: a misscore claim still points at the game just played
    this.settle = newSettleClock();
    this.departed.clear();
    this.finishing = null;
    this.dropped.clear();
    this.pending.clear();
    this.held.clear();
    this.latest.clear();
    this.latestTick.clear();
    this.lastRecvTick.clear();
    this.ackTick.clear();
    this.prevBalls = new Map();
    this.snapPrimed.clear();
    this.snapAck.clear();
    this.lastFrame = new Map();
    this.liveTicks = 0;
    this.driveTicks.clear();
    this.awayTicks.clear();
    // `matchGen` is deliberately NOT reset — it must stay monotonic, or an input still in
    // flight from the match just finished would be accepted by the next one as fresh.

    /**
     * NOBODY CARRIES A READY INTO THE NEXT GAME. Ready is an agreement to start THIS match
     * with THIS roster; the roster is about to change (that is the whole feature), and a
     * player who walked away from their keyboard after the buzzer must not be counted as
     * having agreed to the next one.
     */
    for (const c of this.clients.values()) c.player.ready = false;

    // `clientId` rides along because the client that adopts this socket back into a lobby
    // never sends a `join`, and so never gets a `welcome` of its own.
    for (const c of this.clients.values()) c.send({ t: 'lobby', clientId: c.id });
    for (const c of this.spectators.values()) c.send({ t: 'lobby', clientId: c.id });
    this.broadcastRoster();
    this.broadcastRematch();

    // the last driver may have closed their tab on the results screen; with the world gone
    // there is no loop and no grace reaper left to notice an empty room.
    if (this.clients.size === 0) this.onEmpty();
  }

  /** TEST SEAM: the live world, read-only. Lets a test assert what an input
   *  actually DID rather than only that the server accepted the frame. */
  worldForTest(): World | null {
    return this.world;
  }

  /** TEST / TOOL SEAM: drive an already-started match deterministically with NO
   * timers, up to `maxTicks` or match end. Production drives `stepOnce` from the
   * setInterval loop; this lets smoke/tools run a full room match reproducibly. */
  advanceForTest(maxTicks: number): void {
    this.stopLoop(); // drop the real-time timer — the test pumps synchronously
    for (let i = 0; i < maxTicks && this.world && !this.finalized; i++) {
      if (this.stepOnce()) this.broadcastSnapshot();
    }
  }

  /** TEST SEAM: pump the way the REAL loop does — grace reaping and the ghost-room freeze
   *  included. `advanceForTest` steps unconditionally, so it cannot see a room that the live
   *  loop would have frozen, which is exactly how an unsaved buzzer restart went unnoticed. */
  pumpForTest(maxTicks: number): void {
    this.stopLoop();
    for (let i = 0; i < maxTicks && this.world && !this.finalized; i++) {
      this.checkGrace();
      if (this.clients.size === 0 || this.frozenForNobody()) return;
      if (this.stepOnce()) this.broadcastSnapshot();
    }
  }

  /** the ghost-room freeze (`startLoop`): nobody connected, and nothing still owed to anyone */
  private frozenForNobody(): boolean {
    return !this.anyConnected() && this.finishing === null;
  }

  /** is this match decided, or within `RECORD_FINISH_WINDOW_S` of it, and not yet saved? */
  private inFinishWindow(): boolean {
    const w = this.world;
    if (!w || this.finalized) return false;
    const m = w.match;
    return m.phase === 'post' || (m.phase === 'teleop' && m.phaseTimeLeft <= RECORD_FINISH_WINDOW_S);
  }

  /** TEST SEAM: how many future inputs are buffered, in total and for the worst robot.
   * `pending` growth is invisible from outside the room — it costs memory and nothing
   * else — so the bound on it can only be asserted through a seam like this. */
  pendingSizeForTest(): { total: number; max: number } {
    let total = 0;
    let max = 0;
    for (const buf of this.pending.values()) {
      total += buf.size;
      if (buf.size > max) max = buf.size;
    }
    return { total, max };
  }

  /** TEST SEAM: the live tick, for asserting what counts as a legal input lead. */
  tickForTest(): number {
    return this.world?.tick ?? -1;
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

  /**
   * DROP THE TICK TIMER AND NOTHING ELSE.
   *
   * Split out of `stop()` because the two callers want different things and conflating
   * them made the single-game lock inert for every match ever played. `startMatch`
   * registers each driver's lock and then calls `startLoop`, which opens with a `stop()`
   * to clear any previous timer — and `stop()` releases the locks. So the lock was taken
   * and given back in the same call, and "one live game per user" never held for longer
   * than a few statements. The test seams (`advanceForTest`, `pumpForTest`) did the same
   * thing and hid it: the smoke check for "released at finalize" was already true before
   * the match ran a tick.
   *
   * Anything that means "this match is over / this room is going away" still wants
   * `stop()`. Anything that means "I am about to drive the ticks myself" wants this.
   */
  private stopLoop(): void {
    if (this.loop) {
      clearInterval(this.loop);
      this.loop = null;
    }
  }

  private stop(): void {
    this.stopLoop();
    // room is going away — free any single-game locks it still holds (e.g. a match
    // abandoned before finalize) so those users aren't stuck unable to start again
    this.releaseActiveUsers();
  }

  private broadcastSnapshot(): void {
    const w = this.world as World;
    // recompute the ball snapshot once; each client gets a delta (if primed with
    // a baseline) or a full keyframe (the balls that changed = all of them)
    const cur = new Map<number, string>();
    for (const b of w.balls) cur.set(b.id, JSON.stringify(b));
    const changedIds: number[] = [];
    for (const b of w.balls) if (cur.get(b.id) !== this.prevBalls.get(b.id)) changedIds.push(b.id);
    // Push THIS frame's change set before anything reads the history, so a delta keyed to an
    // older baseline includes what moved on this very tick as well as everything in between.
    this.snapChanged.push({ tick: w.tick, ids: changedIds });
    while (this.snapChanged.length > SNAP_HISTORY_FRAMES) {
      // whatever falls off the end is no longer reconstructible from: an ack at or below the
      // evicted frame's tick can only be served a keyframe. See SNAP_HISTORY_FRAMES.
      this.snapHistoryFrom = (this.snapChanged.shift() as { tick: number }).tick;
    }
    const order = w.balls.map((b) => b.id);
    const slim = slimWorld(w);
    const cmds = this.frameCmds(w);
    // THE SHARED PREFIX. Everything above this line is identical for every recipient;
    // the ONLY per-client fields in a snapshot are `ackInputTick` (that client's own
    // input acknowledgement) and, for a client that is not yet primed, the full ball
    // list instead of the delta. So the expensive part is stringified at most twice —
    // once for primed recipients, once for unprimed — and each client's own tail is
    // appended as a few characters. In a 2v2 with spectators that is the difference
    // between one encode and six of the largest message the server sends.
    //
    // Priming is a first-frame condition: after a recipient's first snapshot it stays
    // primed until its ack goes stale, so in steady state `unprimed` is never built.
    //
    // The cache is keyed by BASELINE TICK because that is now the only thing that varies:
    // every reliable recipient shares one baseline (the previous broadcast) and so shares one
    // encode, `KEYFRAME` is a second, and lossy recipients add one per DISTINCT acked tick —
    // on a LAN that is one or two, since guests ack the same frames within a tick of each
    // other. It is bounded by the audience either way, and equals the old two in the cloud.
    const bodies = new Map<number, string>();
    /** every ball that has changed since broadcast tick `base`, carrying its CURRENT data */
    const updSince = (base: number): Artifact[] => {
      const ids = new Set<number>();
      for (let i = this.snapChanged.length - 1; i >= 0; i--) {
        const e = this.snapChanged[i];
        if (e.tick <= base) break;
        for (const id of e.ids) ids.add(id);
      }
      // walk `w.balls` rather than the id set so `upd` keeps the world's own ordering, which
      // is what every delta has always carried
      return w.balls.filter((b) => ids.has(b.id));
    };
    const bodyFor = (base: number): string => {
      const cached = bodies.get(base);
      if (cached !== undefined) return cached;
      const balls: BallDelta = { order, upd: base === KEYFRAME ? w.balls : updSince(base) };
      // JSON.stringify rather than encodeMsg: this is deliberately a PARTIAL snapshot,
      // missing the one required field each recipient supplies for itself.
      const whole = JSON.stringify({ t: 'snapshot', serverTick: w.tick, w: slim, balls, cmds });
      // drop the closing brace so the per-client tail can be appended. `whole` always
      // has at least one key, so it is never the degenerate `{}`.
      const body = whole.slice(0, -1);
      bodies.set(base, body);
      return body;
    };
    const sendTo = (c: Client): void => {
      // BACKED UP: this socket has not drained what it already owes. Queueing another
      // snapshot on top only makes the arrears worse, and a delta keyed to a frame it may
      // never read is worthless — so skip it and unprime, which turns the next snapshot it
      // does get into a full keyframe of the world as it is THEN. See SNAP_BACKLOG_BYTES.
      if (c.backlog && c.backlog() > SNAP_BACKLOG_BYTES) {
        this.snapPrimed.delete(c.id);
        return;
      }
      // A client whose CONFIRMED baseline (its ack) has fallen too far behind can't
      // apply an incremental delta — drop it back to unprimed so it gets a full
      // keyframe and resyncs. Normal ack lag (a few ticks) never trips this.
      const ack = this.snapAck.get(c.id);
      if (ack !== undefined && w.tick - ack > ACK_STALE_TICKS) this.snapPrimed.delete(c.id);
      /**
       * WHICH BASELINE THIS RECIPIENT IS KNOWN TO HOLD — the thing a delta must be keyed to.
       *
       * On an ordered reliable lane that is the PREVIOUS BROADCAST: it arrived or the socket
       * is gone, so the cheapest correct delta is the one against `prevBalls`.
       *
       * ⚠️ ON A LOSSY LANE IT IS NOT, AND ASSUMING IT WAS CORRUPTED LAN GUESTS SILENTLY. A tab
       * host's guests take snapshots over an unordered `maxRetransmits: 0` DataChannel, so
       * frame N can simply vanish. The guest then applies N+1 — which says nothing about the
       * ball that moved on N, because the server already counted that ball as sent — on top of
       * a baseline that is wrong about it, and ACKS N+1 perfectly happily. NOTHING HEALED
       * THAT: the ack is FRESH, so the `ACK_STALE_TICKS` resync never fires, and a ball that
       * moved during the lost frame and then came to rest never appears in a delta again. It
       * stays in the wrong place, on that one guest's screen, for the rest of the match.
       *
       * So a lossy recipient's delta is keyed to what it has CONFIRMED rather than to what was
       * last sent. That is a SUPERSET of the happy-path delta and it is self-correcting by
       * construction: `upd` carries each ball's CURRENT data, so applying a delta cut against
       * an older baseline to a client that has since moved ahead is still exactly right, and
       * every frame the ack fails to advance widens the window instead of losing a frame out
       * of it. The cost is the widened window itself, and only while a guest is losing frames.
       */
      const base = c.lossy ? (ack ?? KEYFRAME) : this.prevSnapTick;
      // `snapHistoryFrom` and the stale-ack unprime above are the same cutoff from two sides —
      // see SNAP_HISTORY_FRAMES — so this is belt-and-braces, not a second policy.
      const primed = this.snapPrimed.has(c.id) && base >= 0 && base >= this.snapHistoryFrom;
      const from = primed ? base : KEYFRAME;
      const ackInputTick = this.ackTick.get(c.id) ?? 0;
      if (c.sendRaw) {
        c.sendRaw(`${bodyFor(from)},"ackInputTick":${ackInputTick}}`);
      } else {
        const balls: BallDelta = { order, upd: from === KEYFRAME ? w.balls : updSince(from) };
        c.send({ t: 'snapshot', serverTick: w.tick, w: slim, balls, cmds, ackInputTick });
      }
      this.snapPrimed.add(c.id);
    };
    for (const c of this.clients.values()) sendTo(c);
    for (const s of this.spectators.values()) sendTo(s); // read-only watchers get the same stream
    this.prevBalls = cur;
    this.prevSnapTick = w.tick;
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
    // encode ONCE for the whole audience — see `Client.sendRaw`. Lazily, because a
    // room whose every recipient is a plain `send` (tests, headless smoke) should not
    // pay for a string nobody reads.
    let raw: string | null = null;
    const to = (c: Client): void => {
      if (!c.sendRaw) return c.send(m);
      if (raw === null) raw = encodeMsg(m);
      c.sendRaw(raw);
    };
    for (const c of this.clients.values()) to(c);
    for (const s of this.spectators.values()) to(s);
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

  /**
   * Resolve a REPORT from one of this room's clients.
   *
   * The reporter names a ROBOT ID, never a user id — the client is never told who its
   * opponents are (see `PlayerIntro`, which carries only a robot id and an ELO), and this
   * keeps it that way. It also makes the report un-spoofable in the way that matters: a
   * client can only report somebody who is actually in the match it is actually in, because
   * the mapping from robot id to account happens here, on the server, from this room's own
   * roster.
   *
   * Returns null when the report is not actionable — an unknown robot, an anonymous target,
   * or a player reporting themselves. All three are silently dropped rather than answered
   * with an error: none of them is something the reporting player can fix, and a failure
   * message would only tell a prober what does and does not exist.
   */
  resolveReport(reporterClientId: string, robotId: number): { reporterId: string; reportedId: string } | null {
    const reporter = this.clients.get(reporterClientId);
    if (!reporter?.userId) return null; // must be signed in to report
    let reportedId: string | undefined;
    for (const c of this.clients.values()) {
      if (this.robotOf.get(c.id) === robotId) reportedId = c.userId;
    }
    if (!reportedId || reportedId === reporter.userId) return null;
    return { reporterId: reporter.userId, reportedId };
  }

  /**
   * A MISSCORE claim from one of this room's players.
   *
   * Unlike `resolveReport` there is no target to resolve — the claim is about the RESULT, so
   * all this has to answer is who is filing it and which match they are looking at. Signed in
   * only, for the same reason reports are: an anonymous claim cannot be smited for being
   * false, and a queue that cannot cost the filer anything is a queue that fills with noise.
   */
  resolveScoreReport(reporterClientId: string): {
    reporterId: string;
    matchId: string | null;
    roomCode: string;
  } | null {
    const reporter = this.clients.get(reporterClientId);
    if (!reporter?.userId) return null;
    return { reporterId: reporter.userId, matchId: this.lastMatchId, roomCode: this.code };
  }

  /** TEST SEAM: fire the strategy deadline synchronously (no real timer). */
  forceStrategyDeadlineForTest(): void {
    this.onStrategyDeadline();
  }

  /** TEST SEAM: fire the ranked JOIN GRACE synchronously — the no-show path, which is
   *  otherwise only reachable by waiting out RANKED_JOIN_GRACE_MS. */
  forceJoinGraceForTest(): void {
    this.cancelPending(
      'Match cancelled - an opponent did not connect.',
      this.absentRoster().map((userId) => ({ userId, kind: 'noshow' as DodgeKind })),
    );
  }
}