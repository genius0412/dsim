import type { Transport } from './transport';
import type { Physics, GameId, RobotCommand, World } from '../types';
import type { RobotSetup } from '../sim/spawn';
import type { Replay, ReplayResult } from '../sim/replay';
import type { EloDelta, MatchDriver, PlayerIntro, RecordKind, RecordRankInfo, RoomKind } from './protocol';

/** the server's authoritative end-of-match payload (score + recorded replay) */
export interface MatchResultInfo {
  kind: RoomKind;
  record?: RecordKind;
  result: ReplayResult;
  replay: Replay;
  /**
   * The server-minted id for this match, present for THE HOST ONLY.
   *
   * It reaches this client as `matchArchive`, a message the room sends to the host's socket
   * and to nobody else (see the protocol note for why possession of the id is the right to
   * file the match). So it is absent for every guest and spectator by design, and absent from
   * an older server that mints none. The only consumer — the LAN upload — skips the match
   * rather than inventing one: an unkeyed row would be re-uploaded as a new match on every
   * retry.
   */
  matchId?: string;
}

/**
 * The entire networking boundary the GameController sees. In solo play the
 * controller holds `null` here and the code path is bit-identical to a
 * single-player game. In multiplayer a `ServerSession` (server-authoritative +
 * client-side prediction) implements this.
 *
 * Reconcile contract: the controller PREDICTS its own robot locally each tick,
 * sending inputs via `sendInput`, and CORRECTS to authoritative `Snapshot`s
 * pulled with `takeSnapshot` (replaying its buffered inputs past `serverTick`).
 * This replaced the old input-delay lockstep (produce/canStep/commandsForTick/
 * checkpoint), whose head-of-line blocking froze every peer on one client's
 * jitter.
 */

/** an authoritative world state from the server */
export interface Snapshot {
  /** the server's sim tick this world is at */
  serverTick: number;
  world: World;
  /** the command each robot ran this tick (by robot id) — the client holds these
   * to PREDICT remote robots forward, so their collisions are actually simulated */
  cmds: Map<number, RobotCommand>;
  /** newest input tick from this client the server had applied (diagnostic) */
  ackInputTick: number;
}

export interface NetStatus {
  /** what a stall is waiting on (null when healthy) — e.g. 'server' while
   * reconnecting; the HUD surfaces it */
  waitingFor: string | null;
  desync: boolean;
  peers: number;
  /** reconnection budget exhausted (server likely restarted) — prompt a refresh */
  failed: boolean;
  // ---- connection-quality diagnostics (null until measured / solo path) -------
  /** smoothed round-trip time to the server in ms (ping → pong) */
  rttMs: number | null;
  /** measured authoritative-snapshot arrival rate in Hz (server sends ~30) */
  snapHz: number | null;
  /** snapshot inter-arrival jitter in ms (mean absolute deviation) — the single
   * best predictor of visible choppiness */
  jitterMs: number | null;
  /** overall smoothness bucket derived from rtt + jitter (drives the HUD colour) */
  quality: 'good' | 'fair' | 'poor' | null;
  /** recent RAW round-trip samples (ms, oldest→newest) for the ping GRAPH — the
   * smoothed `rttMs` hides sub-second spikes, so this raw series is what surfaces
   * them. null until the first pong / solo path. */
  rttHistory: number[] | null;
  /** human-readable label of the server/region hosting the match (e.g. 'US East'),
   * or null on a single-region / unknown deploy. Shown in the HUD. */
  server: string | null;
  /**
   * THE MATCH IS HELD WHILE A SEAT LOADS (`loadHold`, `VIEWREADY_CAP`): seconds left until the
   * room starts anyway, and how many drivers it is still waiting on. Absent/null ⇒ not held.
   */
  hold?: { secs: number; waiting: number } | null;
}

/** the duo-record rematch tally, as the server reports it */
export interface RematchVote {
  votes: number;
  need: number;
  /** is THIS client's vote currently in? */
  mine: boolean;
}

export interface NetSession {
  /** which game the match plays (from matchStart / the first snapshot; DECODE by
   * default). The GameController builds its initial predicted world for this game. */
  readonly game: GameId;
  /**
   * WHICH PHYSICS THE ROOM RUNS ON (`matchStart.physics`; absent ⇒ '2d').
   *
   * The controller builds its predicted world with THIS and not with the player's own
   * settings: a client whose Practice pick says '2d' still has to predict the '3d' world the
   * room is authoritative over, or every snapshot is a correction against a different game.
   * Mutable for the same reason `game` is — a host restart re-authors the match.
   */
  physics: Physics;
  /** the local player's robot id (assigned by the server at match start; -1 when
   * spectating — there is no local robot) */
  readonly localRobotId: number;
  /** read-only SPECTATOR session: no local robot, no input sent — the GameController
   * renders every robot from the authoritative snapshot stream. */
  readonly spectator?: boolean;
  /** the room code + our clientId + hosting region (ServerSession only) — used to
   * persist an "active game" record so the player can REJOIN this same match later */
  readonly room?: string;
  readonly clientId?: string;
  /** the SEAT'S SECRET — what a rejoin/abandon is actually checked against. Persisted with
   * the active-game record so a reclaim survives a reload. */
  readonly seatToken?: string;
  readonly region?: string;
  /** the match seed the world was built from (updated on a host restart) */
  seed: number;
  /** the robot slots in the match (updated on a host restart) */
  setups: RobotSetup[];
  /** ranked matchmaking match? gates the pre-match ELO intro overlay */
  ranked: boolean;
  /**
   * THE MATCH GENERATION THIS SESSION IS PLAYING (`matchStart.gen`; absent ⇒ 0).
   *
   * Here for one reason: the rejoin record is built field by field from a live session, and
   * the server DROPS an input stamped with a stale generation. A record that omitted this
   * came back as generation 0 against a room on 1, every input was discarded, and the robot
   * sat still while the client predicted it moving — see `ActiveGameRef`. Optional because a
   * LAN session has no generation to report.
   */
  readonly gen?: number;
  /** per-driver ELO for the intro overlay (empty unless ranked) */
  intros: PlayerIntro[];
  /**
   * WHO IS IN EACH SEAT (`matchStart.drivers`) — the usernames the in-match labels print.
   *
   * Here for the same reason `gen` above it is: the rejoin record is built field by field
   * from a live session, so a field this type does not name is a field nobody copies. Optional
   * because a solo run and an older server both have nobody to name. It is deliberately NOT in
   * `World`/`RobotState`: a per-tick field ships 30 times a second to every client, and the sim
   * is a deterministic JSON state machine that has no business knowing who is driving.
   */
  drivers?: MatchDriver[];
  /**
   * The username driving `robotId`, or undefined — the renderer's lookup.
   *
   * A FUNCTION rather than the array, because the label pass asks once per remote robot per
   * frame and a linear scan of `drivers` on the render loop is the kind of thing that is free
   * at 4 robots and not free at all once somebody reuses it. The implementation keeps a map.
   */
  driverName?(robotId: number): string | undefined;
  /** per-driver overall-ELO change for the results screen (populated shortly
   * after phase 'post' in ranked matches; empty otherwise) */
  eloResults: EloDelta[];
  /** does this client hold start/restart authority? */
  isHost(): boolean;
  /** host only: ask the server to re-author the match (server picks the seed) */
  requestRestart(): void;
  /** subscribe to server-authored restarts (rebuild the world) */
  onRestart(cb: () => void): void;
  /** send the local command for `tick` (quantized on the wire) */
  sendInput(tick: number, cmd: RobotCommand): void;
  /** REPORT another driver in this match, by robot id. Optional: a solo/record session has
   *  nobody to report, and an older build simply does not offer the button. */
  sendReport?(robotId: number, reason: string, detail: string): void;
  /** file a MISSCORE claim about the match just played — no target, see the protocol note */
  sendScoreReport?(detail: string): void;
  /** pull the freshest unconsumed snapshot, or null if none arrived */
  takeSnapshot(): Snapshot | null;
  /** the server's end-of-match result (score + recorded replay), or null before
   * phase 'post' — drives the Results screen's "recorded / watch replay" */
  getMatchResult(): MatchResultInfo | null;
  /**
   * Be told the moment the server's result lands, rather than polling for it.
   *
   * The results SCREEN polls `getMatchResult` and is right to — it is rendering. This is for
   * the one thing that must happen exactly once per match and cannot be re-derived from a
   * render: keeping a self-hosted match on the host's device (`keepLanRun` in App). Optional,
   * so a solo run (no session at all) and an older session both simply never fire it.
   */
  onMatchResult?(cb: (info: MatchResultInfo) => void): void;
  /** a record run's leaderboard standing (PB / WR / rank), or null until the
   * server's `recordResult` lands after persistence — record runs only */
  getRecordResult?(): RecordRankInfo | null;
  status(): NetStatus;
  /**
   * THIS CLIENT CAN PLAY THE CURRENT MATCH: physics and view are up (`VIEWREADY_CAP`). Called by
   * the controller every frame once that is true; sends once per match generation.
   */
  viewReady?(): void;
  /** is the room holding the match at tick 0 for a loading seat? The controller does not
   *  predict while it is. */
  loadHeld?(): boolean;
  /** the robots a load hold started WITHOUT (its cap ran out), once, for the event log */
  takeLateStart?(): number[] | null;
  /** how many people are watching this match, as the SERVER reports it to players
   *  (hidden admin observers excluded). 0 until the first update arrives. */
  spectatorCount?(): number;
  /** duo-record rematch tally (votes / how many are needed / whether ours is in) */
  rematchVote?(): RematchVote;
  /** toggle our rematch vote — the server restarts only on unanimity */
  setRematch?(on: boolean): void;
  /**
   * ---- BACK TO THE ROOM'S OWN LOBBY -----------------------------------------------
   *
   * A rematch replays the roster frozen at the first start. These three are the other
   * exit from a finished match: the room clears its world, everyone lands back in the
   * lobby they came from, and the NEXT start is built from whoever is in the room then —
   * so a group can re-pick sides, or carry on without the player who left, on the code
   * they already have.
   *
   * All optional: a solo practice run has no session at all, a record run does not
   * recycle, and a build older than the feature simply never offers the control.
   */
  /**
   * GIVE UP THIS SEAT ON THE WAY OUT — one frame, no reply, sent while the socket is still
   * open. The server stops holding this account's single-game lock for the rest of the
   * reconnect grace, which is what a RECORD restart needs: it tears the session down and
   * joins a brand-new room, and the old lock would otherwise still be registered when that
   * join lands. Optional, like the three below — a solo practice run has no session, and an
   * older build simply never sends it.
   */
  abandonSlot?(): void;
  /** host only: ask the server to send this finished room back to its lobby */
  requestLobby?(): void;
  /** the room went back to its lobby; `clientId` is ours on the socket being handed over */
  onLobby?(cb: (clientId: string) => void): void;
  /**
   * Give up the socket WITHOUT closing it, so the lobby can adopt the same connection.
   * The caller must re-point the transport's `onMessage` immediately — see
   * `LobbyClient.resume`.
   */
  release?(): Transport;
  dispose(): void;
}
