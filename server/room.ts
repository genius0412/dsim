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
import { serverPhysics } from '../src/games/types';
import { scrubName } from './moderation';
import type { GameId, Physics } from '../src/types';
import { physicsReady } from '../src/sim/physicsEngine';
import { physics3dReady, disposePhysics3dFor } from '../src/games/biobuzz/sim3d/engine';
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
  localizeCommand,
  sanitizeQCommand,
  encodeMsg,
  quantizeCommand,
  slimWorld,
  roomCapacity,
  DEFAULT_ROOM_CONFIG,
  RANKED_JOIN_GRACE_MS,
  READY3D_DEADLINE_MS,
  LOAD_HOLD_MAX_MS,
  STRATEGY_DURATION_MS,
  reportsPhysicsReady,
  reportsViewReady,
  type BallDelta,
  type ClientMsg,
  type EloDelta,
  type LiveRoom,
  type LobbyPlayer,
  type MatchDriver,
  type PlayerIntro,
  type QCommand,
  type RecordRankInfo,
  type RoomConfig,
  type RoomKind,
  type ServerMsg,
} from '../src/net/protocol';
import { sanitizePlayerPatch } from '../src/net/sanitize';
import { stripUnentitledCosmetics } from '../src/cosmetics';
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
 * ⚠️ `ws.bufferedAmount` IS POST-DEFLATE, so this is 256 KB of COMPRESSED arrears, not of
 * frames. Measured off `npm run costprobe`, that is roughly 24 s of a DECODE solo room's wire
 * (10.4 KiB/s) down to about 1.4 s of a CR 2v2's (177 KiB/s) — a wide band, and nothing like
 * the "~40 snapshots uncompressed" this comment used to claim.
 *
 * LEFT AT 256 KB DELIBERATELY. Lowering it looks tempting at the CR end, but a skip UNPRIMES,
 * so recovery is a full keyframe of all 300 CR artifacts — the largest frame the server emits
 * — and a threshold tight enough to fire on ordinary jitter turns into skip → keyframe → skip,
 * which is worse than the arrears it was avoiding. And under `WS_COMPRESS=0` the same number
 * is RAW bytes, where 64 KB would be about one frame of a busy room.
 */
const SNAP_BACKLOG_BYTES = 256 * 1024;

// WIRE PRECISION (`round3`) lives in `server/wire.ts` — a LEAF module, because this file is
// in an import cycle: a `const` exported from here reads back `undefined` in a module that
// imports it without also pulling in `Room`, which is exactly what `scripts/costprobe.ts`
// does. Re-exported so the server-side call sites below read naturally.
export { round3 } from './wire';
import { round3 } from './wire';
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
  /** THE SEAT'S SECRET — see the `welcome` note in protocol.ts. Minted here, sent only to
   * its owner, never broadcast. */
  seatToken?: string;
  /** did this seat's client advertise `'seat'`? Only then is the token REQUIRED to reclaim
   * it. An older client has no token to send, and refusing its own reconnect would be a
   * worse bug than the one this closes — it ages out as clients update. */
  seatSecured?: boolean;
  /**
   * This client has said its 3D physics chunk is loaded (`{ t: 'physicsReady' }`).
   *
   * Only ever consulted for a client that advertised `READY3D_CAP` — see `seatWaiting3d`,
   * the one reader. Deliberately NOT cleared on a drop: the chunk is loaded in that tab
   * whether or not its socket is, and a reattach re-sends the message regardless, so
   * clearing it could only hold a returning driver up for something already done.
   */
  ready3d?: boolean;
  /**
   * The match generation this client last reported `viewReady` for (`VIEWREADY_CAP`): its
   * physics and its view are up and it can play that match. Kept across a drop like `ready3d`.
   * Only read for a client that advertised the capability — see `seatsLoading`.
   */
  viewGen?: number;
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
  /**
   * This account's EARNED cosmetic unlocks (`profiles.cosmetics`), resolved once at join
   * alongside `player.supporter`/`player.role` — see the note there. Server-only: unlike
   * `supporter`/`role` it never rides on `LobbyPlayer` (nothing broadcasts it, nothing
   * needs to), it exists only so the `update` handler's entitlement strip
   * (`stripUnentitledCosmetics`) doesn't need a database round trip on every spec re-pick.
   * `[]` for a guest or when the lookup found nothing.
   */
  earnedCosmetics?: string[];
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
  /** a bot was seated: the match and replay are kept, playtime is not credited */
  bots?: boolean;
  /** the room was opened from a Discord Activity (`Room.group` set) — counted as its own
   *  source in `play_counts`, folded into Custom on the homepage */
  discord?: boolean;
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
  /**
   * WHO IS IN EACH SEAT, frozen at `beginMatch` — the `drivers` list every `matchStart` for
   * this match carries (see `MatchDriver`).
   *
   * FROZEN, not derived per send, and that is the whole reason it is a field. `robotOf` is
   * torn down as people leave (`detach`, the grace sweep, `onMessage`'s leave), so a spectator
   * who opens the match after a driver has dropped would be handed a `matchStart` that cannot
   * name the robot still sitting on the field — and the label would fall back to a chassis
   * name mid-match, for the one robot whose driver is the interesting question.
   */
  private matchDrivers: MatchDriver[] = [];
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
  /**
   * ⚠️ THE 3D READINESS WINDOW — the epoch ms past which a `'3d'` room stops waiting for a
   * seat's physics chunk and STARTS ANYWAY (`READY3D_DEADLINE_MS` from the moment the room
   * first wanted to start). 0 ⇒ nothing is waiting.
   *
   * It is a SECOND clock, beside `strategyDeadline`, and they mean opposite things on
   * expiry: the strategy deadline is strict and cancels a ranked pairing nobody readied for;
   * this one is generous and starts the match regardless. Conflating them would either cancel
   * matches over a slow download or give a client a free dodge by never reporting in — see
   * `READY3D_DEADLINE_MS`.
   */
  private ready3dDeadline = 0;
  private ready3dTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * ⚠️ THE LOAD HOLD — the epoch ms until which a started `'3d'` match stays at tick 0 while
   * seats load their view (`VIEWREADY_CAP`). 0 ⇒ not holding. Set in `beginMatch`, released by
   * the tick loop when every seat has reported or the cap passes (`loadHeld`). Like
   * `ready3dDeadline` it STARTS the match on expiry and never cancels it.
   */
  private holdUntil = 0;
  /** when the hold last told the room where it stood, so a lost `loadHold` is re-sent */
  private holdSaidAt = 0;
  /**
   * Live ticks each robot spent with its driver still loading, after the hold ran out. They
   * are taken off that robot's `liveTicks` in the behaviour report: a driver whose view took
   * too long was not idle, and must not be charged as AFK for it.
   */
  private readonly loadingTicks = new Map<number, number>();
  /** a CUSTOM room whose host pressed START while a seat was still loading its 3D chunk: the
   *  room is in `phase === 'strategy'` with no `pendingMatch`, waiting to build the world it
   *  was already asked for. See `startMatch`. */
  private customStart = false;
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

  /**
   * WHICH PHYSICS THIS ROOM'S WORLD RUNS ON — decided once, here, and read by everything:
   * the cap gate at the door, `matchStart`, and `createWorld`.
   *
   * ONE RULE (owner ruling, 2026-09-18): **a game that can step `'3d'` runs `'3d'` here,
   * always.** Every room is a server-connected match — record, ranked, matchmade, custom,
   * spectated, LAN-hosted — and the ruling is that those all run the one solve. `RoomConfig.
   * physics` is therefore no longer read at all: it was the host's pick for a CUSTOM room, and
   * a host who could pick 2D could put a run on the board that nothing else on it was produced
   * by. `serverPhysics` is the shared predicate (`src/games/types.ts`) so the room, the
   * matchmaker, the board queries and the LAN worker cannot drift.
   *
   * A game with no `'3d'` option is `'2d'` — DECODE and Chain Reaction, byte-identical to what
   * they were before this field existed, including the wire (a 2D room still omits `physics`
   * from `matchStart` entirely).
   *
   * ⚠️ BACK-COMPAT IS NOW A REFUSAL, NOT A DOWNGRADE. An old client that opens a BIOBUZZ room
   * without `physics` used to get a 2D room; it now gets a 3D one it cannot step, so the
   * `'bb3d'` cap gate at the door (`physicsAllowed`, server/index.ts) turns it away with
   * `BB3D_REFUSAL`. That is the intended failure: a silent 2D room is the one outcome the
   * ruling forbids. ⚠️ **SO DEPLOY ORDER MATTERS**: BIOBUZZ is public on the stable channel, and
   * every production client built before the `'bb3d'` cap existed is refused from every BIOBUZZ
   * room until it reloads. Ship and verify the CLIENT (Vercel) FIRST, then the server (Fly); a
   * tab held open across the deploy is refused with `BB3D_REFUSAL` until the version gate
   * reloads it.
   */
  get physics(): Physics {
    return serverPhysics(simModuleFor(this.game));
  }

  /** is a match actually running here (vs. still a lobby)? */
  get hasWorld(): boolean {
    return this.world !== null;
  }

  /**
   * MAY THIS ROOM STEP YET? — the ONE readiness predicate, asked by every path that builds a
   * world (`start`, `startRankedImmediate`, `beginRanked`).
   *
   * ⚠️ `physicsReady()` ALONE IS A CHECK OF THE WRONG MODULE FOR A 3D ROOM. The two wasm
   * backends load independently at boot, and a `'3d'` room's first tick is `step3d`, which
   * THROWS `3D physics not initialised` if `initPhysics3d()` has not resolved. That throw
   * happens INSIDE the tick loop — i.e. after the match has been announced and the dodge
   * accounting has run — so the failure is a killed interval and a room full of people
   * watching a frozen field, not a "try again in a moment". The ranked paths had only the 2D
   * half, which was harmless while every game was `'2d'` and is not now that BIOBUZZ is.
   */
  private physicsReadyForRoom(): boolean {
    return physicsReady() && (this.physics !== '3d' || physics3dReady());
  }

  /**
   * IS A SEAT STILL LOADING THE 3D PHYSICS THIS ROOM WILL RUN? — the gate every start path
   * asks after `physicsReadyForRoom`, which is the same question about the SERVER's own copy.
   *
   * Owner request, 2026-09-22: "only start any server-required game once 3D physics loads".
   * A client's Rapier 3D wasm and `sim3d/` barrel are lazy chunks; until they land the driver
   * cannot be given a controller at all (`game.ts` asserts it) and sits behind the loading
   * panel watching a match that is already running — in ranked, one that is already
   * accounting them away.
   *
   * THREE THINGS COUNT AS READY, and each one is a real seat somewhere:
   *  · a client that never advertised `READY3D_CAP` — an older build that will never send the
   *    message. Waiting on one holds a whole room for the full deadline for nothing.
   *  · a DROPPED client. Its seat is held for the grace and nothing is going to arrive on a
   *    socket that is gone; the ranked paths have their own answer for a missing driver.
   *  · a BOT. It has no chunk to load and the server's own physics is up before any tick.
   *
   * ⚠️ AND IT IS FALSE OUTRIGHT PAST `ready3dDeadline`, which is what makes this a WAIT and
   * not a REFUSAL. See `READY3D_DEADLINE_MS`.
   *
   * ⚠️ IT ARMS THAT CLOCK ITSELF, on the first call that would have waited — which is exactly
   * "the first moment this room wanted to start". Every caller is a start path, and a deadline
   * re-stamped by each of them (three start paths, plus a 200 ms poll inside two of them)
   * would never expire at all, which is the one failure the deadline exists to prevent.
   */
  private seatWaiting3d(): boolean {
    if (this.physics !== '3d') return false;
    let waiting = false;
    for (const c of this.clients.values()) {
      if (c.connected && reportsPhysicsReady(c.caps) && !c.ready3d) waiting = true;
    }
    if (!waiting) return false;
    if (!this.ready3dDeadline) this.ready3dDeadline = Date.now() + READY3D_DEADLINE_MS;
    return Date.now() < this.ready3dDeadline;
  }

  /**
   * ARM a timer for the 3D readiness deadline (idempotent).
   *
   * Only the paths with NOTHING ELSE POLLING need it — the ranked strategy window and the
   * custom room's own window. `startMatch`'s and `startRankedImmediate`'s 200 ms retries are
   * their own clock and re-ask `seatWaiting3d` on their own.
   */
  private armReady3d(onDeadline: () => void): void {
    if (this.ready3dTimer) return;
    const wait = Math.max(0, this.ready3dDeadline - Date.now());
    this.ready3dTimer = setTimeout(() => {
      this.ready3dTimer = null;
      onDeadline();
    }, wait);
    if (this.ready3dTimer.unref) this.ready3dTimer.unref();
  }

  /** stop waiting: the match is starting (or the room is going away). */
  private clearReady3d(): void {
    if (this.ready3dTimer) {
      clearTimeout(this.ready3dTimer);
      this.ready3dTimer = null;
    }
  }

  // ─────────────────────────────────────────────────────────── BOT SEATS (plan §6) ──
  //
  // An AI driver occupying a roster slot nobody is connected to. The SERVER drives it, on the
  // authoritative loop, for the same reason the server drives everything else: a bot whose
  // commands were produced by one client would be a client deciding what a robot in everyone's
  // match does, and a reconcile would fight it every snapshot. It is one more entry in
  // `frameCommands`, which is exactly what a bot is.
  //
  // ⚠️ **A BOT SEAT MAKES THE ROOM UNRATED, AND IT IS STRUCTURALLY IMPOSSIBLE IN A ROOM THAT
  // WOULD RATE.** Two independent statements, because one of them can be got wrong quietly:
  //   · `addBot` REFUSES a staged/matchmade room, a record room and a live match outright, so
  //     there is no path by which a rated result is produced against an AI.
  //   · a room that has ever seated a bot reports `bots: true` to persistence, which still
  //     writes the `matches` row and the replay (so its players can watch it back from their
  //     history) but credits NO playtime: `user_activity` is what `docs/area/accounts.md` says
  //     nothing competitive may read, and a match against three bots is not playtime.

  /** one seated bot: a synthetic roster row plus the tier it plays at. */
  private readonly bots: { id: string; tier: string; alliance: Alliance; startIndex: number }[] = [];
  /** MONOTONIC, never `bots.length`. A bot id is a roster `clientId`, and the roster is keyed by
   *  it — so numbering from the array length mints a DUPLICATE the moment anybody removes a seat
   *  and adds another (remove bot-1, add ⇒ a second `bot-1-CODE`). Two rows with one id is a
   *  roster the client cannot key, and `removeBot`'s `findIndex` would only ever reach the older
   *  of the pair, so the newer one could not be taken back out. This counter only goes up. */
  private botSeq = 0;
  /** live AI drivers for the match in flight, keyed by robot id. Built in `beginMatch`,
   *  disposed in `stop`. Empty in every room with no bot seat, which is nearly all of them. */
  private readonly botDrivers = new Map<number, { step(w: World): RobotCommand; dispose?(): void }>();
  /** the tier each bot ROBOT plays at, resolved at `startMatch` when seats become robot ids. */
  private readonly botTiers = new Map<number, string>();
  /** a bot has been seated here at some point — latched, so removing one before START does not
   *  quietly make the room count as playtime again after the roster was already built around it. */
  private botsEverSeated = false;

  /** how many seats are spoken for: connected drivers plus bots. */
  private get seatsTaken(): number {
    return this.clients.size + this.bots.length;
  }

  /** this game's AI driver, or undefined for a game that has none (DECODE, Chain Reaction,
   *  and BIOBUZZ until its policy lands). Read through the module, never imported, so a game
   *  gains bots by filling the slot and this file does not change. */
  private get botDriver(): NonNullable<ReturnType<typeof simModuleFor>['bot']> | undefined {
    return simModuleFor(this.game).bot;
  }

  /**
   * SEAT A BOT (host only). Returns an error sentence, or null on success.
   *
   * The alliance is the EMPTIER one, so pressing the button three times in an empty 2v2 fills
   * one partner and two opponents rather than stacking a side — which is what "fill the empty
   * seats of the chosen format" means in a room where the format is the capacity.
   */
  addBot(tier?: string): string | null {
    const drv = this.botDriver;
    if (!drv) return 'This game has no AI drivers yet.';
    if (this.pendingMatch || this.ranked) return 'A ranked match cannot have bots in it.';
    if (this.config.kind === 'record') return 'A record run cannot have bots in it.';
    if (this.world !== null || this.phase === 'match') return 'The match has already started.';
    if (this.seatsTaken >= roomCapacity(this.config)) return 'The room is full.';
    const red = this.sideCount('red');
    const blue = this.sideCount('blue');
    const alliance: Alliance = red <= blue ? 'red' : 'blue';
    const anchors = simModuleFor(this.game).startPoseCount;
    // the first anchor nobody on that alliance has claimed; past the anchors it wraps, exactly
    // as `startMatch` de-conflicts a human roster (the solver pushes an overlap apart)
    const used = new Set<number>();
    for (const c of this.clients.values()) if (c.player.alliance === alliance) used.add(c.player.startIndex ?? 0);
    for (const b of this.bots) if (b.alliance === alliance) used.add(b.startIndex);
    let startIndex = 0;
    for (let i = 0; i < anchors; i++) {
      if (!used.has(i)) {
        startIndex = i;
        break;
      }
    }
    this.bots.push({ id: `bot-${++this.botSeq}-${this.code}`, tier: drv.coerceTier(tier), alliance, startIndex });
    this.botsEverSeated = true;
    this.broadcastRoster();
    return null;
  }

  /** give a bot seat back (host only). Silent no-op for an id that is not a bot seat — a
   *  double-click on a row that is already gone is not an error worth a sentence. */
  removeBot(seat: string): void {
    if (this.world !== null || this.phase === 'match') return;
    const i = this.bots.findIndex((b) => b.id === seat);
    if (i < 0) return;
    this.bots.splice(i, 1);
    this.broadcastRoster();
  }

  private sideCount(a: Alliance): number {
    let n = 0;
    for (const c of this.clients.values()) if (c.player.alliance === a) n++;
    for (const b of this.bots) if (b.alliance === a) n++;
    return n;
  }

  /** the roster row a bot seat is broadcast as — a `LobbyPlayer` like any other, with `bot`
   *  naming its tier. Rebuilt per broadcast rather than stored, so a spec/assist default
   *  changing under it is never stale. */
  private botPlayer(b: { id: string; tier: string; alliance: Alliance; startIndex: number }): LobbyPlayer {
    return {
      clientId: b.id,
      // NAMED FOR WHAT IT IS, in the roster and in the match. `spec.name` is what the in-match
      // label and the results screen print, so a bot that borrowed a human-looking default name
      // would be indistinguishable from a driver who left.
      name: `${b.tier} bot`,
      teamName: 'AI',
      teamNumber: 0,
      alliance: b.alliance,
      startIndex: b.startIndex,
      ready: true, // a bot is never not ready; START must not wait on one
      spec: { ...DEFAULT_SPEC, name: `${b.tier} bot`, teamName: 'AI', teamNumber: 0 },
      assists: { ...DEFAULT_ASSISTS },
      bot: b.tier,
    };
  }

  /**
   * WHO IS DRIVING WHAT, off the seating `beginMatch`'s caller has just laid out.
   *
   * Sorted by robot id so the list reads the same on every send and a diff of two handshakes
   * is about the seating rather than about Map iteration order. A seat with neither a client
   * nor a tier — a staged ranked slot whose player never connected — is simply absent, and the
   * label falls back to that build's own name, which is the only thing the room knows about it.
   */
  private seatedDrivers(): MatchDriver[] {
    const out: MatchDriver[] = [];
    for (const c of this.clients.values()) {
      const rid = this.robotOf.get(c.id);
      // `player.name` and not `spec.name`: the person, not the chassis. Already moderated —
      // `sanitizePlayer` scrubs it at join, so nothing here is a second gate on it.
      // The badge fields come off the SAME player object the roster broadcasts, resolved once
      // at join: the results roster names the same people the lobby did, so it must not read
      // them from anywhere else and arrive at a different answer.
      if (rid !== undefined)
        out.push({
          robotId: rid,
          name: c.player.name,
          supporter: c.player.supporter,
          role: c.player.role,
        });
    }
    // A BOT IS A DRIVER, named as its roster row is. `botPlayer` builds the same string, but
    // off `bots` — the LOBBY list, keyed by seat id and carrying no robot id. `botTiers` is the
    // seating `startMatch` actually laid out, so it is the only one that can answer this.
    for (const [rid, tier] of this.botTiers) out.push({ robotId: rid, name: `${tier} bot` });
    return out.sort((a, b) => a.robotId - b.robotId);
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

  /** optional grouping tag (the Discord Activity instance id) so the Discord lobby
   * browser can list only the rooms from one activity. Set once by the creator in
   * `joinRoom`; '' = ungrouped (every web/LAN room). */
  group = '';

  /** true if a fresh driver can still join (room not full, not mid-match, and not
   * already locked into the pre-match strategy window) */
  canJoin(): boolean {
    return (
      // BOTS COUNT. A seat filled by an AI is a seat, and a human admitted past capacity would
      // be built a setup the roster has no room for — the same oversized-roster failure the LAN
      // host's `canSeat` was written for. The host gives a bot back to make room for a person.
      this.seatsTaken < roomCapacity(this.config) &&
      this.world === null &&
      this.phase !== 'strategy'
    );
  }

  /** A joinable-lobby view for the Discord lobby browser. Non-null ONLY while this
   * room is an open lobby (accepting drivers, not started) — so the browser lists
   * exactly the rooms a new arrival could walk into. Deliberately minimal: no player
   * names (a lobby list is public within an activity; the roster is seen on join). */
  lobbySummary(): {
    code: string;
    players: number;
    capacity: number;
    kind: RoomKind;
    game: GameId;
    joinable: boolean;
    state: 'lobby' | 'strategy' | 'match' | 'full';
  } {
    /**
     * ⚠️ EVERY ROOM IN THE GROUP GETS A ROW, INCLUDING ONE NOBODY CAN JOIN.
     *
     * This used to return null the moment `canJoin()` was false, so a room vanished from
     * `/api/lobbies` the instant a match started in it — and the browser reads absence as
     * NON-EXISTENCE. The result was the activity telling a latecomer "Nobody has opened the
     * main lobby yet" about the room four of their friends were playing in, with the Join
     * button enabled, labelled with the VIEWER's season rather than the room's, and a server
     * refusal as the only feedback. It lasted the whole match and the whole results screen,
     * because a room only becomes a lobby again when the host recycles it.
     *
     * The caller decides what to show; this says what is true.
     *
     * `players` counts SEATS, not sockets. A bot is a seat — `canJoin` has always counted
     * them — so reporting `clients.size` made a host plus two bots read as "1/4" with room
     * to spare, and the one game with bots is now the activity's default season.
     */
    const state: 'lobby' | 'strategy' | 'match' | 'full' =
      this.world !== null ? 'match'
      : this.phase === 'strategy' ? 'strategy'
      : this.seatsTaken >= roomCapacity(this.config) ? 'full'
      : 'lobby';
    return {
      code: this.code,
      players: this.seatsTaken,
      capacity: roomCapacity(this.config),
      kind: this.config.kind,
      game: this.config.game ?? 'decode',
      joinable: this.canJoin(),
      state,
    };
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
    return !hostPending || this.seatsTaken + 1 < roomCapacity(this.config);
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
  /**
   * IS THIS FRAME FROM THE SEAT'S OWNER? — the check `rejoin` and `abandon` were missing.
   *
   * The old rule was "knowing the client id is proof", and the comment that said so was
   * wrong: `broadcastRoster` puts every driver's id on the wire and `broadcast` fans it out
   * to spectators too, so the credential was published to anyone who could watch. A seat
   * minted for a client that advertises `'seat'` therefore requires its TOKEN, which is sent
   * only to its owner in `welcome` and appears in no broadcast.
   *
   * A seat WITHOUT `seatSecured` is an older client's: it has no token to send, so it keeps
   * the old rule rather than being locked out of its own reconnect. That window closes as
   * clients update, and the version gate makes that fast.
   */
  private seatOwner(c: Client, token?: string): boolean {
    if (!c.seatSecured) return true;
    return !!c.seatToken && token === c.seatToken;
  }

  abandonSlot(clientId: string, token?: string): boolean {
    const c = this.clients.get(clientId);
    if (!c) return false;
    if (!this.seatOwner(c, token)) return false;
    if (c.userId) {
      this.activeUserIds.delete(c.userId);
      this.onUserInactive?.(c.userId);
    }
    /**
     * ⚠️ A DECIDED SOLO RUN IS NOT A SLOT TO GIVE UP — IT IS A SCORE TO WRITE.
     *
     * `detach` already knows this: a solo record room inside `inFinishWindow` is kept alive
     * by `finishing` until the field settles and `finalizeMatch` writes the PB, because the
     * loop FREEZES a room nobody is connected to. This frame bypasses detach entirely and
     * deletes the client outright — so pressing RESTART or Abandon in the seconds after the
     * buzzer took the room down before its own score was saved, which is the unsaved-PB bug
     * (`f1fc93a`) coming back through a door that did not exist when it was fixed.
     *
     * The LOCK is already gone above, which is the whole of what the caller needs: they are
     * starting another run and this one can no longer be in their way. The seat is left for
     * the close that is about to follow, where detach does the right thing with it.
     */
    // ...and the same holds for every room, for the reason `detach` gives: a decided match is
    // saved whoever walked away from it, so the seat is left for the close that follows.
    if (this.inFinishWindow()) {
      this.broadcastRoster();
      return true;
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
    if (!client.seatToken) client.seatToken = randomUUID();
    client.seatSecured = !!client.caps?.includes('seat');
    this.clients.set(client.id, client);
    if (!this.hostId) this.hostId = client.id;
    client.send({ t: 'welcome', clientId: client.id, seatToken: client.seatToken });
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
    // ONE CHECK PER SEAT AT A TIME. The in-room name editor patches on every KEYSTROKE, so
    // a rename that goes through `update` would otherwise cost one provider round trip per
    // character typed. A patch that lands while a check is running is remembered instead,
    // and re-run once against the CURRENT names — so the value that ends up on the roster is
    // always the value that was checked, at one call per round trip rather than per keystroke.
    if (this.modInFlight.has(client.id)) {
      this.modQueued.add(client.id);
      return;
    }
    this.modInFlight.add(client.id);
    void (async () => {
      const p = client.player;
      /**
       * ⚠️ WHAT WAS CHECKED, so a verdict is only ever written over the value it is about.
       * A keystroke that lands mid-check moves a name on ("abc" → "abcd"); writing the verdict
       * on "abc" back over it put the STALE name on the roster, and the queued re-check then
       * passed that stale name. A field that moved since is left alone — the re-check owns it.
       */
      const was = { name: p.name, teamName: p.teamName, specName: p.spec.name, specTeam: p.spec.teamName };
      try {
        const [name, teamName, specName, specTeam] = await Promise.all([
          scrubName(was.name, 'Driver'),
          scrubName(was.teamName, ''),
          scrubName(was.specName, DEFAULT_SPEC.name),
          scrubName(was.specTeam, ''),
        ]);
        if (!this.clients.has(client.id)) return; // left before the check returned
        let changed = false;
        if (p.name === was.name && name !== p.name) {
          p.name = name;
          changed = true;
        }
        if (p.teamName === was.teamName && teamName !== p.teamName) {
          p.teamName = teamName;
          changed = true;
        }
        const nextSpecName = p.spec.name === was.specName ? specName : p.spec.name;
        const nextSpecTeam = p.spec.teamName === was.specTeam ? specTeam : p.spec.teamName;
        if (nextSpecName !== p.spec.name || nextSpecTeam !== p.spec.teamName) {
          p.spec = { ...p.spec, name: nextSpecName, teamName: nextSpecTeam };
          changed = true;
        }
        if (!changed) return; // all clean (or moderation disabled), or every field moved on
        this.broadcastRoster();
      } finally {
        this.modInFlight.delete(client.id);
        // a patch arrived mid-flight: the names on the roster now are not the ones that were
        // checked, so check the ones that are
        if (this.modQueued.delete(client.id) && this.clients.has(client.id)) this.moderatePlayerNames(client);
      }
    })();
  }

  /** seats with a moderation check in flight, and seats whose names moved while one ran. */
  private modInFlight = new Set<string>();
  private modQueued = new Set<string>();

  /** the free-text names a roster carries, as one string: the cheap "did this patch change
   *  anything moderation cares about" test. ` ` separates the fields so text cannot slide
   *  between two of them and hash the same. */
  private static nameFingerprint(p: LobbyPlayer): string {
    return [p.name, p.teamName ?? '', p.spec.name ?? '', p.spec.teamName ?? ''].join(' ');
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
      // OMITTED for a 2D room, never sent as `'2d'`: an older client ignores an unknown key
      // either way, but leaving it off keeps a 2D room's handshake byte-identical to the one
      // this server sent before Day 2, which is the property the NET3D lane asserts.
      physics: this.physics === '3d' ? '3d' : undefined,
      ranked: this.ranked,
      intros: this.ranked ? this.intros : undefined,
      // OMITTED when there is nobody to name, for the reason `physics` above is: an empty
      // array is a key an older server never sent, and a client reads absent and empty the
      // same way (fall back to the chassis name).
      drivers: this.matchDrivers.length ? this.matchDrivers : undefined,
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
    // BOTS ARE ON THE CARD. A spectator opening a 1v3 would otherwise be shown one driver and
    // four robots, which reads as three people who left rather than as three seats nobody took.
    const players = [...this.clients.values()]
      .map((c) => ({
        name: c.player.name,
        teamName: c.player.spec.teamName || undefined,
        teamNumber: c.player.spec.teamNumber || undefined,
        alliance: c.player.alliance,
      }))
      .concat(
        this.bots.map((b) => ({
          name: `${b.tier} bot`,
          teamName: 'AI' as string | undefined,
          teamNumber: undefined,
          alliance: b.alliance,
        })),
      );
    return {
      room: this.pendingCode() ?? this.code,
      game: this.game,
      // the BUCKET this match's size makes it, bots included — a 1v3 is a 2v2 room, and calling
      // it a 1v1 because only one socket is attached would put it in the wrong card
      mode: record ? (this.config.record ?? 'solo') : eloMode(this.seatsTaken),
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
      } else if (this.customStart) {
        // the seat we were holding the start for has left: it cannot report in any more, so
        // re-ask rather than waiting out a deadline for somebody who is gone
        this.beginCustomStart();
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
      //
      // ⚠️ AND IT IS EVERY ROOM, NOT ONLY A SOLO RUN (2026-09-24). A custom game, a game against
      // bots, a duo run and a ranked match were all lost the same way when the LAST connected
      // driver left in the seconds between the buzzer and the field settling: no replay, no
      // history row, no ELO. Reported as "some replays are not saving". The results screen only
      // appears once the field settles (up to `MATCH_SETTLE_MAX_S`), so pressing MENU at the
      // buzzer is an ordinary thing to do, and in a bot game the leaver is the only human. With
      // somebody still connected the loop keeps running anyway, so this only matters for the
      // last one out.
      if (this.inFinishWindow() && !this.anyConnected()) {
        this.finishing = { reap: clean };
        if (soloRecord) {
          this.broadcastRoster();
          return;
        }
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
    token?: string,
    trusted = false,
  ): number | null {
    const c = this.clients.get(id);
    if (!c) return null;
    /**
     * The seat's own secret, not the id that rides in every roster — see `seatOwner`.
     *
     * ⚠️ `trusted` IS FOR A CALLER THAT ALREADY PROVED MORE THAN THE TOKEN PROVES. The
     * account reclaim in `server/index.ts` is the only one: it found this seat by the
     * VERIFIED user id off a signed auth token, which is a strictly stronger claim than
     * "holds the seat's secret" — the token only ever answers "is this the same browser".
     * Without the bypass that path silently returned null for every seat a current client
     * had taken, so a signed-in player reloading during the ranked strategy window was
     * refused their own rated match, and a custom-lobby reconnect took a SECOND seat
     * instead of reclaiming its own. Caught in review, not in testing, because the two
     * behavioural tests for it build clients that advertise no caps.
     */
    if (!trusted && !this.seatOwner(c, token)) return null;
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
    send({ t: 'welcome', clientId: id, seatToken: c.seatToken });
    // SAY WHICH MATCH THE SLOT IS IN. A client returning through the Home rejoin card
    // built its session from a SAVED matchStart, so its generation is whatever that
    // record held — and an input stamped with a stale one is dropped by `onInput`, which
    // reads on screen as a robot that will not move. The room is the authority on this,
    // so it answers with it rather than hoping the client's copy is current.
    send({ t: 'rejoined', ok: true, gen: this.matchGen });
    if (this.world) this.sendSnapshotTo(c); // immediate full resync (re-primes)
    if (this.holdUntil) this.sayHold(); // a seat back inside the load hold must hold too
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
    if (!this.world && this.phase === 'strategy') {
      const p = this.pendingMatch;
      send({
        t: 'strategyStart',
        // a CUSTOM room's window (`enterCustomStart`) has no strategy clock of its own — the
        // number it counts down to is the 3D readiness deadline
        deadline: p ? this.strategyDeadline : this.ready3dDeadline,
        yourRobotId: this.slotOf.get(c.id) ?? 0,
        mode: p?.mode ?? (this.seatsTaken > 2 ? '2v2' : '1v1'),
        intros: p ? this.intros : [],
        game: this.game,
        ...(p ? {} : { ranked: false }),
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
        // ENTITLEMENT STRIP (docs/cosmetics-plan.md §3.3), AFTER the shape clamp above and
        // BEFORE it lands on the roster: a re-pick is the other live point (besides join)
        // where a client DECLARES a spec, and `sanitizePlayerPatch` only shape-validated it
        // (`coerceSpec` inside it never checks entitlement — see that function's header).
        // `c.player.supporter`/`c.earnedCosmetics` were resolved once at join; never a DB
        // read per patch. Never runs over replay re-simulation or `createWorld` — neither
        // reaches this handler.
        if (patch.spec) {
          patch.spec = stripUnentitledCosmetics(patch.spec, !!c.player.supporter, c.earnedCosmetics ?? []);
        }
        // in the ranked strategy window, alliance is server-authoritative (staged by
        // the matchmaker) — a client may re-pick its spec / pose / ready, never its
        // side, or two partners could stack one alliance.
        if (this.pendingMatch && this.phase === 'strategy') delete patch.alliance;
        const namesBefore = Room.nameFingerprint(c.player);
        Object.assign(c.player, patch);
        /**
         * ⚠️ A RENAME IS MODERATED TOO — ONLY THE JOIN USED TO BE.
         *
         * `add` runs `moderatePlayerNames`; this path ran `sanitizePlayerPatch` and nothing
         * else, and that is LENGTH coercion (`coerceName`) — no word list, no provider. So a
         * player could arrive clean and then rename to anything at all, live, onto every
         * roster and every in-match label in the room.
         *
         * It is worst exactly where the backstops are gone: the live in-room name editor is
         * the Discord activity's, everybody in an embed is SIGNED OUT, and `resolveReport`
         * needs a signed-in filer — so nobody in that room could even report it.
         *
         * Gated on the names having actually MOVED, so a ready toggle, a pose edit or a spec
         * swap costs nothing; the editor's keystroke stream is coalesced inside
         * `moderatePlayerNames` rather than billed a provider call per character.
         */
        if (Room.nameFingerprint(c.player) !== namesBefore) this.moderatePlayerNames(c);
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
      /**
       * THIS SEAT'S 3D PHYSICS CHUNK HAS LANDED (owner request, 2026-09-22).
       *
       * Latched, never cleared, and it re-runs whichever start the room is holding — the
       * ranked strategy window, a custom room's own window, or nothing at all, which is the
       * case in every 2D room and every room already playing. `broadcastRoster` first, so the
       * screens showing "Loading 3D physics…" on this seat drop the chip even when this was
       * not the last seat and nothing starts.
       */
      case 'physicsReady':
        if (c.ready3d) break; // idempotent: a reconnect re-sends it
        c.ready3d = true;
        this.broadcastRoster();
        if (this.phase === 'strategy') {
          if (this.pendingMatch) this.maybeBeginRanked();
          else if (this.customStart) this.beginCustomStart();
        }
        break;
      /**
       * THIS SEAT CAN PLAY THE CURRENT MATCH (`VIEWREADY_CAP`). Only a report for THIS
       * generation counts: one still in flight from before a rematch must not release the new
       * match's hold. The tick loop does the releasing; this only tells the room who is left.
       */
      case 'viewReady':
        if (typeof msg.gen !== 'number' || msg.gen !== this.matchGen || c.viewGen === msg.gen) break;
        c.viewGen = msg.gen;
        if (this.holdUntil) this.sayHold();
        break;
      case 'start':
        // physics WASM may still be loading in the first moment after boot; refuse
        // rather than throw inside step() (which would kill the tick loop)
        if (id === this.hostId && this.world === null && this.phase === 'connecting') {
          /**
           * ⚠️ EVERYBODY ELSE HAS TO HAVE READIED, AND ONLY THE CLIENT USED TO CHECK.
           *
           * `Lobby` disables START until `players.every(p => p.ready)` and the server took the
           * frame on the host's word — so a `join` landing in the same instant as the click
           * (the window is one roster broadcast's round trip) committed somebody who had seen
           * NOTHING: default alliance, default chassis, default start pose, straight into a
           * match. Same window for a seat that just dropped, whose ready `detach` clears.
           *
           * The gate is the client's own, stated authoritatively — so it refuses nothing an
           * up-to-date lobby would have let you press, and it is the HOST's own seat that is
           * exempt: a solo record run (`RecordRun`) opens its room and sends `start` straight
           * off the first roster without ever readying, on every build in the fleet. Bots are
           * not in `this.clients` and a spectator never was.
           */
          const unready = [...this.clients.values()].some((o) => o.id !== this.hostId && !o.player.ready);
          if (unready) {
            c.send({ t: 'error', message: 'Everyone has to be ready before the match can start.' });
            break;
          }
          if (this.physicsReadyForRoom()) this.startMatch();
          else c.send({ t: 'error', message: 'Server is starting up - try again in a moment.' });
        }
        break;
      case 'addBot': {
        // HOST ONLY, like `start` and `lobby`: the roster is shared state and one guest must
        // not seat an AI into everybody else's match.
        if (id !== this.hostId) break;
        const err = this.addBot(typeof msg.tier === 'string' ? msg.tier : undefined);
        if (err) c.send({ t: 'error', message: err });
        break;
      }
      case 'removeBot':
        if (id !== this.hostId) break;
        if (typeof msg.seat === 'string') this.removeBot(msg.seat);
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
    /**
     * A SEAT IS STILL LOADING THE 3D PHYSICS THIS ROOM RUNS — hold the start and say so
     * (owner request, 2026-09-22). The validation above runs FIRST, because an illegal start
     * pose is something the driver has to go and fix and should not be told about after a
     * 45-second wait.
     *
     * ⚠️ **EVERY MEMBER MUST SUPPORT BOTH CAPABILITIES, OR THE OLD IMMEDIATE START STANDS.**
     * `'strategy'` is what lets a client render the waiting screen at all — one that cannot
     * would sit on a lobby that silently stopped responding to START — and `READY3D_CAP` is
     * what makes the wait finite, since a client that never reports in can only be waited out
     * to the deadline. With a mixed roster the room starts exactly as it did before this
     * existed, which is the same discipline `maybeStartRanked` applies to the ranked window.
     *
     * A RECORD room takes this path too: it is one seat, `RecordRun` has already awaited the
     * chunk before dialling, and the wait is therefore normally zero — but the gate is here as
     * the backstop the client's own preflight is checked against.
     */
    const canWait = [...this.clients.values()].every(
      (c) => c.connected && c.caps?.includes('strategy') && reportsPhysicsReady(c.caps),
    );
    if (canWait && this.seatWaiting3d()) {
      this.enterCustomStart();
      return;
    }
    // record runs are OPPONENT-FREE co-op: every robot on one alliance (blue).
    // Each driver brings their OWN build, so a duo may mix drivetrains — a mixed
    // pair just keys the record board's OVERALL bucket (decided at persist time).
    // So there is no drivetrain gate here.
    // build setups from the current roster; keep start poses distinct per alliance
    /**
     * HUMANS FIRST, THEN BOTS — the same order `broadcastRoster` sends, so a lobby row and the
     * robot id it becomes agree. A bot is a `LobbyPlayer` from here on and takes every line
     * below unchanged: its spec, its assists and its start index are as real as anyone's, and
     * the only thing that distinguishes it is that `botTiers` remembers the tier so `beginMatch`
     * can seat a driver on the robot id.
     */
    const roster: { key: string; player: LobbyPlayer; tier: string | null }[] = [
      ...[...this.clients.values()].map((c) => ({ key: c.id, player: c.player, tier: null })),
      ...this.bots.map((b) => ({ key: b.id, player: this.botPlayer(b), tier: b.tier })),
    ];
    const used: Record<Alliance, Set<number>> = { red: new Set(), blue: new Set() };
    const anchors = simModuleFor(this.game).startPoseCount;
    const setups: RobotSetup[] = [];
    this.robotOf.clear();
    this.botTiers.clear();
    // THE SEED IS DRAWN BEFORE THE SEATS ARE LAID OUT, because a bot's ROBOT is a function of it
    // (`BotDriver.build`, deterministic in the match seed and the seat) — the same inputs the
    // client's solo practice seats its bots from, so a room and a practice run of one seed field
    // the same line-up. A rematch reuses `matchSetups`, so it keeps the robots it had.
    const seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
    const drv = this.botDriver;
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
        spec: (c.tier !== null ? drv?.build?.({ seed, robotId: i, tier: c.tier, alliance }) : undefined) ?? c.player.spec,
        assists: c.player.assists,
        startIndex: si,
        // a custom pose overrides the de-conflicted startIndex; createWorld snaps
        // it G304-legal. Old clients omit it → the preset is used.
        startPose: c.player.startPose ?? undefined,
      });
      // A BOT HAS NO SOCKET, so it takes no `robotOf` entry: that map is what `onInput` resolves
      // a client id through, and a bot must never be a thing an input can be addressed to.
      if (c.tier === null) this.robotOf.set(c.key, i);
      else this.botTiers.set(i, c.tier);
    });

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
    /**
     * NAME THE SEATS HERE, once, for the same reason the seed and the setups are remembered
     * here: this is the ONE place all three start paths and every rematch funnel through, and
     * every `matchStart` for this match — the drivers', a spectator's, a rematch's — is sent
     * from the same three fields. The caller has just populated `robotOf`/`botTiers`, which is
     * the contract this method already states.
     */
    this.matchDrivers = this.seatedDrivers();
    // THE ROOM'S physics, not a setting: the server holds no `GameSettings`, so the fifth
    // argument is the only route a room's choice has into the builder. `undefined` for the
    // settings bag is what every server-side build already passed.
    const world = simModuleFor(this.game).createWorld('match', seed, setups, undefined, this.physics);
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
    // STAMPED WITH THE ROOM'S PHYSICS. A replay is an input log, so a `'3d'` match replayed
    // against `step2d` is a different game from the one that was played — see `Replay.physics`.
    this.recorder = new ReplayRecorder(seed, setups, 'match', this.game, this.physics);
    /**
     * SEAT THE AI DRIVERS, one per bot robot, seeded `(matchSeed, seat)` exactly as plan §6
     * asks. Every peer that ever re-runs this match — a re-simulation, a second server, the
     * verifier — gets the same driver for the same robot of the same match, and two seats of
     * one match get different ones. The mix is Knuth's odd constant so adjacent robot ids do
     * not produce adjacent seeds, which a bare `seed + rid` would.
     *
     * It does NOT matter for replay fidelity: the recorder stores every setup's COMMAND, so a
     * replay of a match with bots in it re-simulates from the log without needing a bot at all.
     * The seeding matters for the LIVE match, where two seats must not play identically.
     */
    this.botDrivers.clear();
    const drv = this.botDriver;
    if (drv) {
      for (const [rid, tier] of this.botTiers) {
        this.botDrivers.set(rid, drv.create(world, rid, tier, (seed ^ ((rid + 1) * 0x9e3779b1)) >>> 0));
      }
    }
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
    this.beginLoadHold();
    this.startLoop();
  }

  // ─────────────────────────────────────────────────────────── THE LOAD HOLD ──
  //
  // Owner, 2026-09-24: server matches still started while a driver's 3D physics and view were
  // loading, record runs included. The start gate above (`seatWaiting3d`) only covers the
  // physics chunk, which can load in the lobby; the VIEW cannot, because the game screen that
  // owns it is built from `matchStart`. So a `'3d'` match now waits at tick 0 after
  // `matchStart` until every seat says it can play, or `LOAD_HOLD_MAX_MS` passes.

  /** robots whose driver is connected, reports `viewReady`, and has not yet for this match */
  private seatsLoading(): number[] {
    const out: number[] = [];
    for (const c of this.clients.values()) {
      if (!c.connected || !reportsViewReady(c.caps) || c.viewGen === this.matchGen) continue;
      const rid = this.robotOf.get(c.id);
      if (rid !== undefined) out.push(rid);
    }
    return out;
  }

  /** start holding a match that has just begun, if it is a `'3d'` one and anyone is loading */
  private beginLoadHold(): void {
    this.holdUntil = 0;
    this.loadingTicks.clear();
    if (this.physics !== '3d' || this.seatsLoading().length === 0) return;
    this.holdUntil = Date.now() + LOAD_HOLD_MAX_MS;
    this.sayHold();
  }

  /** tell every client and spectator where the hold stands (`waitMs: 0` ⇒ released) */
  private sayHold(released = false): void {
    this.holdSaidAt = Date.now();
    this.broadcast({
      t: 'loadHold',
      gen: this.matchGen,
      waitMs: released ? 0 : Math.max(1, this.holdUntil - this.holdSaidAt),
      loading: this.seatsLoading(),
    });
  }

  /**
   * IS THE MATCH HELD THIS TICK? Releases the hold, and says so, when every seat has reported
   * or the cap has passed. On a cap release the late seats are named in the log and in the
   * release message; their clients join the running match when they finish loading.
   */
  private loadHeld(): boolean {
    if (!this.holdUntil) return false;
    const loading = this.seatsLoading();
    const now = Date.now();
    if (loading.length > 0 && now < this.holdUntil) {
      if (now - this.holdSaidAt >= 1000) this.sayHold(); // a lost message must not strand anyone
      return true;
    }
    if (loading.length > 0) {
      console.warn(
        `[room ${this.code}] load hold ran out after ${LOAD_HOLD_MAX_MS} ms; starting without robot(s) ${loading.join(', ')}`,
      );
    }
    this.sayHold(true);
    this.holdUntil = 0;
    return false;
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
    // `cancelled` leaves the phase where it was, so a retry loop that only checked the phase
    // could still build a world for a pairing the room has already torn down and billed
    if (!p || this.world !== null || this.phase !== 'connecting' || this.cancelled) return;
    // BOTH backends (see `physicsReadyForRoom`): a ranked BIOBUZZ room steps `step3d`.
    // And the CLIENTS' 3D chunks (`seatWaiting3d`) — this path is the mixed-version one, so
    // there is no strategy screen to wait on, but a seat that did advertise `READY3D_CAP` is
    // still worth the (deadline-bounded) wait. The 200 ms poll is its own clock.
    if (!this.physicsReadyForRoom() || this.seatWaiting3d()) {
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

  /**
   * A CUSTOM ROOM'S OWN WAITING WINDOW — the host has pressed START, every driver has already
   * readied, and the only thing left is a seat's 3D physics chunk (owner request, 2026-09-22).
   *
   * It reuses `phase === 'strategy'` and the `strategyStart` message, which is what puts the
   * alliance screen up on every client, but it is NOT the ranked window and the three
   * differences are all deliberate: nobody is asked to ready a second time (they already did,
   * or the host could not have pressed START), no ELO travels (`ranked: false`, `intros: []`),
   * and the roster is NOT redacted — a custom lobby has shown every build all along, so hiding
   * them for the last two seconds would be a reveal running backwards.
   *
   * The seats are numbered in `clients` order, which is exactly the order `startMatch` builds
   * its setups in, so a card's slot is the robot id it becomes.
   */
  private enterCustomStart(): void {
    if (this.world !== null || this.phase !== 'connecting') return;
    this.phase = 'strategy';
    this.customStart = true;
    this.slotOf.clear();
    [...this.clients.values()].forEach((c, i) => this.slotOf.set(c.id, i));
    this.armReady3d(() => this.beginCustomStart());
    const seats = this.seatsTaken;
    for (const c of this.clients.values()) {
      c.send({
        t: 'strategyStart',
        deadline: this.ready3dDeadline,
        yourRobotId: this.slotOf.get(c.id) ?? 0,
        // a label only, and the screen does not print it for an unranked window — a custom
        // room's shape is its roster, which the same message's roster already carries
        mode: seats > 2 ? '2v2' : '1v1',
        intros: [],
        game: this.game,
        ranked: false,
      });
    }
    this.broadcastRoster();
  }

  /** every seat has reported in (or the deadline lapsed): build the match the host already
   *  asked for. Re-entrant and idempotent — `physicsReady`, a departure and the deadline
   *  timer all call it, and whichever arrives first wins. */
  private beginCustomStart(): void {
    if (!this.customStart || this.world !== null || this.phase !== 'strategy') return;
    if (this.seatWaiting3d()) return;
    // the SERVER's own wasm, exactly as the `start` handler checks it — a cold boot can still
    // be finishing while the clients are long since ready
    if (!this.physicsReadyForRoom()) {
      setTimeout(() => this.beginCustomStart(), 200);
      return;
    }
    this.clearReady3d();
    this.customStart = false;
    this.phase = 'connecting'; // `startMatch` builds from here and sets 'match' itself
    this.startMatch();
  }

  /**
   * ⚠️ **THE STRATEGY COUNTDOWN MUST NOT RUN OUT ON A DOWNLOAD** (owner request, 2026-09-22).
   *
   * Everyone has readied, so the strict deadline has been satisfied — and the only thing left
   * is a seat's 3D chunk, which is not a decision anybody made and must not be charged as one.
   * `onStrategyDeadline` is STRICT and CANCELS, which for this case would bill a `unready`
   * dodge to a player who pressed the button on time.
   *
   * So the window is pushed out to `ready3dDeadline` (the same 45 s cap the rest of this
   * handshake runs on, measured from the first moment this room wanted to start — so the
   * extension is bounded and cannot be re-triggered into a loop), and a fresh `strategyStart`
   * carries the new number: the screen's countdown is a promise about when the match cancels,
   * and one that keeps ticking past a deadline nobody is going to enforce is a lie the driver
   * can read. Returns true when it extended.
   */
  private extendStrategyForReady3d(): boolean {
    if (!this.seatWaiting3d()) return false;
    if (this.strategyDeadline >= this.ready3dDeadline) return true; // already extended
    this.strategyDeadline = this.ready3dDeadline;
    if (this.strategyTimer) clearTimeout(this.strategyTimer);
    this.strategyTimer = setTimeout(
      () => this.onStrategyDeadline(),
      Math.max(0, this.strategyDeadline - Date.now()),
    );
    if (this.strategyTimer.unref) this.strategyTimer.unref();
    const p = this.pendingMatch;
    for (const c of this.clients.values()) {
      if (!c.connected) continue;
      c.send({
        t: 'strategyStart',
        deadline: this.strategyDeadline,
        yourRobotId: this.slotOf.get(c.id) ?? 0,
        mode: p?.mode ?? '1v1',
        intros: this.intros,
        game: this.game,
      });
    }
    return true;
  }

  /** start as soon as every connected driver has readied up */
  private maybeBeginRanked(): void {
    const p = this.pendingMatch;
    if (!p || this.phase !== 'strategy' || this.world !== null) return;
    const connected = [...this.clients.values()].filter((c) => c.connected);
    if (connected.length === p.roster.length && connected.every((c) => c.player.ready)) {
      if (this.extendStrategyForReady3d()) return;
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
      // a seat still loading its 3D chunk buys the window more time, once, up to the same
      // 45 s cap — see `extendStrategyForReady3d`
      if (this.extendStrategyForReady3d()) return;
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
    if (!p || this.world !== null || this.phase !== 'strategy' || this.cancelled) return;
    // BOTH backends (see `physicsReadyForRoom`): a ranked BIOBUZZ room steps `step3d`.
    // And every SEAT's own 3D chunk (`seatWaiting3d`) — this is the last gate before a world
    // exists, so it is the one that has to hold even if a caller forgot to ask.
    if (!this.physicsReadyForRoom() || this.seatWaiting3d()) {
      setTimeout(() => this.beginRanked(), 200); // still loading; retry shortly
      return;
    }
    this.clearReady3d();
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
    this.clearReady3d();
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

  /**
   * HOW EVENLY THIS ROOM IS ACTUALLY SENDING SNAPSHOTS.
   *
   * The gap between broadcasts is already measured with real percentiles — by
   * `scripts/loadtest.ts`, which emits `snapshotGapMs {p50, p99, jitterMeanAbsDev}` and is read
   * by `loadsummary.ts` at a 45 ms health line. Every published jitter number came from that
   * harness. The ONE thing it cannot do is answer the question in PRODUCTION, with no harness
   * attached and real players in the room — and jitter, not RTT, is the signal behind every
   * "it feels laggy" report (see CONNECTION-QUALITY HUD). That, and only that, is the
   * justification. `cores` stays structurally blind to shedding either way.
   *
   * ⚠️ PLAIN NUMBERS, NOT `perf_hooks`. This module is bundled for the BROWSER —
   * `src/lan/hostWorker.ts` imports `Room` — so a `node:` import does not resolve here. Same
   * constraint that makes `randomUUID` the Web Crypto one.
   * ⚠️ NAMED `snapSendGapMs` on the wire, not `snapshotGapMs`: `scripts/loadsummary.ts` already
   * reads a CLIENT-SIDE `snapshotGapMs` out of the same JSON and the two must not collide.
   * ⚠️ NO lateness RATE. loadsummary's 45 ms line is a threshold on the MEDIAN, so the count,
   * the running sum and the max are the whole useful set; a `late` counter would need a
   * threshold constant nobody reads.
   * ⚠️ PER BROADCAST, NOT PER RECIPIENT. Recorded once in `broadcastSnapshot`, on the ROOM
   * plane — the snapshot plane is ~99.8% shared work and nothing per-client may move onto it
   * (see the SHARED PREFIX comment there).
   */
  private snapGap = { n: 0, sumMs: 0, maxMs: 0 };
  private lastSnapAt = 0;

  /** this room's snapshot-spacing accumulator, for `/api/perf`. `reset` starts a fresh window. */
  snapGapStats(reset = false): { n: number; sumMs: number; maxMs: number } {
    const out = { ...this.snapGap };
    if (reset) this.snapGap = { n: 0, sumMs: 0, maxMs: 0 };
    return out;
  }

  private startLoop(): void {
    this.stopLoop(); // NOT `stop()` — the locks `startMatch` just took must survive this
    let last = Date.now();
    let acc = 0;
    // ⚠️ RESET THE SPACING CLOCK HERE, not only in the ghost-freeze branch below. `beginMatch`
    // is this method's only caller and it runs on EVERY REMATCH, so without this the results
    // screen plus the whole rematch-vote window lands in `maxMs` and stays there for the life
    // of the machine — one number that makes every reading after it a lie.
    this.lastSnapAt = 0;
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
          this.lastSnapAt = 0; // a ghost freeze is not a late snapshot — see `snapGap`
          return;
        }
        // THE LOAD HOLD: the match exists at tick 0 but does not run until every seat can
        // play it (or the cap passes). Same clock reset as the freeze above.
        if (this.loadHeld()) {
          last = Date.now();
          acc = 0;
          this.lastSnapAt = 0;
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
          !!c.bbPlaceNectar || !!c.bbPlace || !!c.bbNectar || !!c.bbRamp || !!c.bbPass);
      if (moving) this.driveTicks.set(r.id, (this.driveTicks.get(r.id) ?? 0) + 1);
      // AWAY is measured from the socket, not from the sticks: a driver whose client is
      // gone is a different thing from one who is present and idle, and only the first is
      // "left the match".
      const away = this.departed.has(r.id) || !this.driverConnected(r.id);
      if (away) this.awayTicks.set(r.id, (this.awayTicks.get(r.id) ?? 0) + 1);
    }
    // a driver the load hold started without is loading, not idle — see `loadingTicks`
    if (this.physics === '3d') {
      for (const rid of this.seatsLoading()) this.loadingTicks.set(rid, (this.loadingTicks.get(rid) ?? 0) + 1);
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
        bots: this.botsEverSeated,
        discord: this.group !== '',
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
        liveTicks: Math.max(0, this.liveTicks - (this.loadingTicks.get(rid) ?? 0)),
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
    // the 3D readiness wait belongs to ONE start, so the next one gets a fresh budget rather
    // than inheriting an expired clock from the match that just finished
    this.clearReady3d();
    this.ready3dDeadline = 0;
    this.customStart = false;
    this.matchSeed = 0;
    this.matchSetups = [];
    this.matchDrivers = [];
    this.robotOf.clear();
    // the SEATS survive a recycle — the host set up a 1v3 and the room going back to its lobby
    // is not a reason to take their opponents away — but the per-match tier map and the live
    // drivers do not (`stop()` above disposed those).
    this.botTiers.clear();
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
    this.loadingTicks.clear();
    this.holdUntil = 0;
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
    // never sends a `join`, and so never gets a `welcome` of its own. So does the seat's
    // SECRET, for the same reason: without it the adopting lobby holds an empty token, and
    // from the room's second match on every `rejoin`/`abandon` of a secured seat is refused.
    // `c.send` reaches only this seat's owner, so this is not a broadcast.
    for (const c of this.clients.values()) c.send({ t: 'lobby', clientId: c.id, seatToken: c.seatToken });
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
      if (this.clients.size === 0 || this.frozenForNobody() || this.loadHeld()) return;
      if (this.stepOnce()) this.broadcastSnapshot();
    }
  }

  /** TEST SEAM: is a started match being held for a loading seat? */
  loadHoldForTest(): { held: boolean; loading: number[]; gen: number } {
    return { held: this.holdUntil !== 0, loading: this.seatsLoading(), gen: this.matchGen };
  }

  /** TEST SEAM: run the load hold's cap out now. The real one is `LOAD_HOLD_MAX_MS` away. */
  expireLoadHoldForTest(): void {
    if (this.holdUntil) this.holdUntil = Date.now() - 1;
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
      /**
       * A BOT SEAT IS DRIVEN HERE, and this is the only place it is driven.
       *
       * BEFORE the step, once per tick, on the authoritative loop — so its command lands in
       * `lastFrame`, is RECORDED by the replay recorder beside every human's, rides the
       * snapshot's `cmds` array so clients predict it forward like any other remote, and counts
       * toward participation like any other robot. There is no second path and no special case
       * downstream; a bot differs from a driver only in where its command came from.
       *
       * It is checked before `dropped` because a bot cannot drop: nothing holds a socket for it.
       */
      const bot = this.botDrivers.get(r.id);
      if (bot) {
        /**
         * ⚠️ **LOCALIZED, LIKE EVERY OTHER COMMAND THAT REACHES A STEP.** A human's command
         * arrives off the wire already on the quantized lattice (`dequantizeCommand` of what
         * was sent), and `ReplayRecorder.record` quantizes whatever it is handed — so a RAW
         * bot command would be simulated at full precision and RECORDED rounded, and the
         * replay would diverge from the run by the rounding, every tick. Same trap solo
         * practice hit and the same fix (`docs/area/netcode.md`, `stepSolo`).
         */
        frame.set(r.id, localizeCommand(bot.step(w)));
        continue;
      }
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
    this.holdUntil = 0; // a hold belongs to the match that is ending
    this.clearReady3d(); // nothing left to wait for; an unref'd timer still holds a closure
    // free the match's Rapier 3D world. The engine map is a WeakMap keyed on the World, so
    // dropping the World drops the only handle without calling free(), and wasm linear memory
    // never shrinks — a server that has run a few hundred 3D matches would hold every one.
    // No-op for a 2D room and for a process that never loaded the chunk.
    if (this.world) disposePhysics3dFor(this.world);
    // an AI driver may hold allocations of its own; the contract says the CALLER disposes.
    for (const b of this.botDrivers.values()) {
      try {
        b.dispose?.();
      } catch (e) {
        console.warn(`[room ${this.code}] bot dispose threw:`, e);
      }
    }
    this.botDrivers.clear();
    // room is going away — free any single-game locks it still holds (e.g. a match
    // abandoned before finalize) so those users aren't stuck unable to start again
    this.releaseActiveUsers();
  }

  private broadcastSnapshot(): void {
    const w = this.world as World;
    // SPACING, measured once per broadcast on the ROOM plane — see `snapGap`. A first send
    // (or the first after a freeze / a rematch) has no predecessor and is not a sample.
    const nowMs = Date.now();
    if (this.lastSnapAt !== 0) {
      const gap = nowMs - this.lastSnapAt;
      this.snapGap.n++;
      this.snapGap.sumMs += gap;
      if (gap > this.snapGap.maxMs) this.snapGap.maxMs = gap;
    }
    this.lastSnapAt = nowMs;
    // recompute the ball snapshot once; each client gets a delta (if primed with
    // a baseline) or a full keyframe (the balls that changed = all of them)
    // ⚠️ THE DIFF KEY IS ROUNDED TOO, not just the frame. Rounding only the frame leaves the
    // key comparing full-precision floats, so the ~70 CR particles that are stationary to
    // within a thousandth of an inch still read as CHANGED and are re-sent every frame — which
    // is precisely the 54% the rounding was supposed to save. (A bandwidth property, not a
    // correctness one: over-sending desyncs nobody.)
    const cur = new Map<number, string>();
    for (const b of w.balls) cur.set(b.id, JSON.stringify(b, round3));
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
      const whole = JSON.stringify({ t: 'snapshot', serverTick: w.tick, w: slim, balls, cmds }, round3);
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
    const msg: ServerMsg = {
      t: 'snapshot',
      serverTick: w.tick,
      w: slimWorld(w),
      balls: { order: w.balls.map((b) => b.id), upd: w.balls },
      cmds: this.frameCmds(w),
      ackInputTick: this.ackTick.get(c.id) ?? 0,
    };
    // ROUNDED LIKE EVERY OTHER SNAPSHOT — and this is the one that most needs it: it is the
    // LARGEST frame the server emits (`upd` is every ball, all 300 of them in CR), and it goes
    // out on the reattach path, which is a real client on a real socket rather than a test.
    if (c.sendRaw) c.sendRaw(JSON.stringify(msg, round3));
    else c.send(msg);
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

  /**
   * ONE CLIENT'S ROSTER ROW — its own `player`, plus the fields the ROOM knows about it and
   * the client does not.
   *
   * Today that is `ready3d` alone: whether this seat's 3D chunk has landed is a fact the
   * server collects (`{ t: 'physicsReady' }`) and the screens have to show, and it must not be
   * settable from a `PlayerPatch` — a seat that could declare itself loaded would skip the
   * wait for everyone. Same discipline as `supporter` and `role` beside it.
   *
   * ⚠️ SET ONLY WHERE THERE IS SOMETHING TO WAIT FOR: a 2D room, or a client that never
   * advertised `READY3D_CAP`, leaves the key ABSENT rather than sending `false`. A `false`
   * there would put a "Loading 3D physics…" chip on every DECODE lobby row for a wait that
   * does not exist and will never end.
   */
  private rosterPlayer(c: Client): LobbyPlayer {
    if (this.physics !== '3d' || !reportsPhysicsReady(c.caps)) return c.player;
    return { ...c.player, ready3d: !!c.ready3d };
  }

  private broadcastRoster(): void {
    // a STAGED ranked room must never reveal opponent builds before the redacted
    // strategy roster: while still 'connecting' its clients self-report alliance
    // 'red' (a placeholder), so alliance-based redaction can't work yet — simply
    // withhold the roster until `enterStrategy` sends the redacted one. (The
    // matchmaking client shows no roster while connecting anyway.)
    if (this.pendingMatch && this.phase === 'connecting') return;
    // outside the STAGED RANKED strategy window everyone sees the same roster (custom lobby,
    // not yet staged, or a custom room's own 3D-readiness window): the full build reveal is
    // fine there. ⚠️ The redaction below is keyed on `pendingMatch` as well as the phase —
    // `enterCustomStart` reuses this phase for a room whose builds have been on screen since
    // everyone joined, and hiding them for the last two seconds before the match would be the
    // pre-match reveal running backwards.
    if (this.phase !== 'strategy' || !this.pendingMatch) {
      // BOT SEATS RIDE THE SAME ROSTER, after the humans — the order the setups are built in
      // (`startMatch`), so a lobby row and a robot id line up. An old client renders them as
      // ordinary drivers, which is what they are; see `LobbyPlayer.bot`.
      const players = [...this.clients.values()]
        .map((c) => this.rosterPlayer(c))
        .concat(this.bots.map((b) => this.botPlayer(b)));
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
        if (o.id === c.id || o.player.alliance === mine) return { ...this.rosterPlayer(o), slot };
        return {
          clientId: o.player.clientId,
          name: o.player.name,
          teamName: o.player.teamName,
          teamNumber: o.player.teamNumber,
          alliance: o.player.alliance,
          startIndex: 0,
          ready: o.player.ready,
          // NOT redacted, and it is the one field here that is about the MATCH rather than
          // about the build: a screen that hid an opponent's load state would show three
          // ready cards and a window that will not close, which is the confusion this whole
          // handshake exists to remove. It reveals nothing counter-pickable.
          ...(this.physics === '3d' && reportsPhysicsReady(o.caps) ? { ready3d: !!o.ready3d } : {}),
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

  /**
   * TEST SEAM: expire the 3D READINESS window synchronously, then re-ask whichever start is
   * holding on it. The real one is `READY3D_DEADLINE_MS` away, which no test can wait out.
   *
   * It moves the CLOCK rather than calling a start path directly, so what runs afterwards is
   * the same code the live timer runs into — a seam that reached past `seatWaiting3d` would
   * prove the timer fires and nothing about the gate it is supposed to release.
   */
  forceReady3dDeadlineForTest(): void {
    this.ready3dDeadline = Date.now() - 1;
    this.clearReady3d();
    if (this.phase === 'strategy') {
      if (this.pendingMatch) this.maybeBeginRanked();
      else if (this.customStart) this.beginCustomStart();
    }
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