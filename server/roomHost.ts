/**
 * MULTI-CORE ROOMS — the socket thread's half (`SIM_WORKERS`, docs/scaling-multicore.md).
 *
 * One Node process runs JavaScript on one thread, so before this every room on a machine shared
 * one core and a bigger VM added nothing but idle cores. With `SIM_WORKERS` set, rooms live in
 * `worker_threads` (`server/roomWorker.ts`), each worker stepping its own rooms, and this thread
 * keeps what must stay single: every socket, the HTTP server, the matchmaker, the database pool,
 * the presence beat and the room-code registry. Routing does not change at all — a room is on
 * the same MACHINE it always was, only on a different thread of it.
 *
 * `SIM_WORKERS` unset or 0 is the old server exactly: `createRoom` returns a plain `Room`, no
 * socket is registered, no worker exists.
 *
 * THE SEAM. `server/index.ts` talks to a room through `RoomHandle`, which `Room` already
 * satisfies. A `RemoteRoom` satisfies it from the other side of a thread:
 *  · WRITES (add, detach, onMessage, …) are posted, in order, to the room's worker.
 *  · The few calls whose RESULT the socket thread acts on (`reattach`, the two report
 *    resolvers, `applyPending`) return a promise; `index.ts` awaits only when handed one, so an
 *    in-process room keeps its synchronous timing.
 *  · Everything index.ts READS synchronously (the join door, `/api/live`, presence, admission
 *    control) comes from a MIRROR the worker pushes whenever it may have changed (`RoomFacts`).
 *    A mirror can be a message behind, so the reads that admit somebody also count the ops this
 *    thread has posted and the worker has not yet acknowledged (`unacked`): an add in flight is a
 *    seat taken, and a room with anything in flight is never abandonable.
 */
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import { Room, type Client } from './room';
import { configureVisualBudget, makeSharedVisualBudget, resetVisualSlot } from './importVisuals';
import { DEFAULT_ROOM_CONFIG, roomCapacity, type ClientMsg, type LiveRoom, type RoomConfig, type ServerMsg } from '../src/net/protocol';
import { serverPhysics } from '../src/games/types';
import { simModuleFor } from '../src/games/sim';
import type { GameId, Physics } from '../src/types';
import type { PendingMatch } from './matchTypes';
import { hasImportCap, importIdOf, isImportedSpec, type ImportRoomState } from '../src/net/imported';
import {
  CB_ACTIVE,
  CB_BEHAVIOUR,
  CB_DODGE,
  CB_INACTIVE,
  CB_RESULT,
  type Batch,
  type ClientData,
  type Ev,
  type Op,
  type RoomFacts,
  type WorkerStats,
} from './roomThreads';

type ReportTarget = ReturnType<Room['resolveReport']>;
type ScoreReportTarget = ReturnType<Room['resolveScoreReport']>;
type RoomArgs = ConstructorParameters<typeof Room>;

/**
 * What `server/index.ts` may do with a room. `Room` satisfies it as it stands (checked below), so
 * the in-process path is the class itself, untouched.
 *
 * Four methods may answer with a promise. Their callers take the value synchronously when it is
 * not one, which keeps an in-process room exactly as it was — see `index.ts`.
 */
export interface RoomHandle {
  readonly code: string;
  readonly config: RoomConfig;
  group: string;
  readonly gameId: GameId;
  readonly physics: Physics;
  readonly soloRecord: boolean;
  canJoin(): boolean;
  lobbySummary(): ReturnType<Room['lobbySummary']>;
  seatFor(userId: string): string | null;
  stagedFor(userId: string): boolean;
  staging(): boolean;
  summary(): LiveRoom | null;
  presenceSnapshot(): ReturnType<Room['presenceSnapshot']>;
  snapGapStats(reset?: boolean): { n: number; sumMs: number; maxMs: number };
  holdsCapacity(): boolean;
  isAbandonable(): boolean;
  spectatorCount(): number;
  /** what the room holds as far as imported robots go — the join, rejoin and spectate doors read it */
  importState(): ImportRoomState;
  add(client: Client): void;
  /** a worker room answers with the socket key the spectator's `detach` must carry */
  addSpectator(client: Client): number | void;
  hideSpectator(id: string): void;
  detach(id: string, conn?: number, clean?: boolean): void;
  reattach(
    id: string,
    send: (m: ServerMsg) => void,
    sendRaw?: (s: string) => void,
    backlog?: () => number,
    token?: string,
    trusted?: boolean,
    /** the returning socket's capabilities, which replace the seat's (see `Room.reattach`) */
    caps?: string[],
  ): number | null | Promise<number | null>;
  onMessage(id: string, msg: ClientMsg): void;
  applyPending(p: PendingMatch): void | Promise<void>;
  maybeStartRanked(): void;
  abandonSlot(clientId: string, token?: string): boolean | void;
  releaseSeatLock(userId: string): boolean | void;
  resolveReport(reporterClientId: string, robotId: number): ReportTarget | Promise<ReportTarget>;
  resolveScoreReport(reporterClientId: string): ScoreReportTarget | Promise<ScoreReportTarget>;
  /** the registry has dropped this room without it emptying (`abandon` in the join path) */
  release?(): void;
}

// compile-time: the in-process room IS a RoomHandle
const _roomIsHandle = (r: Room): RoomHandle => r;
void _roomIsHandle;

/**
 * How many room workers, from `SIM_WORKERS`: unset/empty/0 = none (rooms in-process, the old
 * server), a number = that many, `auto` = one per core beyond the first, which is left to the
 * socket thread (writes, `permessage-deflate` hand-off, HTTP) — so a one-core machine gets none,
 * because a worker there only adds a hop.
 */
export function simWorkerCount(raw: string | undefined = process.env.SIM_WORKERS, cores = availableParallelism()): number {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '' || v === '0') return 0;
  if (v === 'auto') return cores >= 2 ? cores - 1 : 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`[workers] SIM_WORKERS=${raw} is not a count or "auto"; running rooms in-process`);
    return 0;
  }
  return Math.min(Math.floor(n), 64);
}

// ---- sockets ------------------------------------------------------------------------

/**
 * The sockets a worker can write to, by KEY. A worker never holds a socket; it names one.
 *
 * Keyed by the socket's `send` function because that is the one thing both `add(client)` and
 * `reattach(id, send, …)` are handed — `Room`'s own signatures, which `RoomHandle` keeps. The
 * key never changes for the life of the socket, unlike the client id (`index.ts` adopts the
 * reclaimed id on a rejoin).
 */
interface HostSocket {
  key: number;
  write: (s: string) => void;
  backlog: () => number;
  close: (code: number, reason: string) => void;
  /** the backlog bucket last reported to the worker that writes to it */
  bucket: number;
  slot: Slot | null;
}
const socks = new Map<number, HostSocket>();
const sockBySend = new WeakMap<(m: ServerMsg) => void, number>();
let nextSock = 1;

/** Register a socket so a worker room can write to it. A no-op without workers. */
export function registerSocket(
  send: (m: ServerMsg) => void,
  io: { write: (s: string) => void; backlog: () => number; close: (code: number, reason: string) => void },
): void {
  if (!pool) return;
  const key = nextSock++;
  sockBySend.set(send, key);
  socks.set(key, { key, ...io, bucket: 0, slot: null });
}

/** The socket has closed: frames still on their way to it are dropped, as `ws` would. */
export function unregisterSocket(send: (m: ServerMsg) => void): void {
  const key = sockBySend.get(send);
  if (key === undefined) return;
  const s = socks.get(key);
  socks.delete(key);
  if (s) pool?.unwatch(s);
}

function sockFor(send: (m: ServerMsg) => void): number {
  const key = sockBySend.get(send);
  if (key === undefined) throw new Error('socket not registered with the room workers (registerSocket)');
  return key;
}

function dataOf(c: Client): ClientData {
  const d: Partial<Client> = { ...c };
  delete d.send;
  delete d.sendRaw;
  delete d.backlog;
  return d as ClientData;
}

// ---- a room on a worker ---------------------------------------------------------------

interface Callbacks {
  onResult?: RoomArgs[3];
  onUserActive?: RoomArgs[4];
  onUserInactive?: RoomArgs[5];
  onDodge?: RoomArgs[6];
  onBehaviour?: RoomArgs[7];
}

/** the mirror before the worker has said anything: an empty lobby, which is what a new Room is */
function initialFacts(code: string, config: RoomConfig, capacity: number): RoomFacts {
  return {
    ack: 0,
    lobby: { code, players: 0, capacity, kind: config.kind, game: config.game ?? 'decode', joinable: true, state: 'lobby' },
    cfg: { kind: config.kind, record: config.record, settings: config.settings },
    seats: [],
    staging: false,
    summary: null,
    presence: { players: [], guests: [] },
    holds: true,
    abandonable: true,
    spectators: 0,
    imports: { hasImport: false, capless: false, ids: [] },
  };
}

export class RemoteRoom implements RoomHandle {
  private facts: RoomFacts;
  private seq = 0;
  /** populating ops posted and not yet reflected in `facts` */
  private readonly unacked: {
    seq: number;
    kind: 'add' | 'spec' | 'reattach' | 'pending';
    uid?: string;
    id?: string;
    /** an `add` that brings an imported robot, and any `add`/`spec`/`reattach` whose client lacks
     *  the cap — counted by `importState` until the worker's mirror has them */
    imp?: boolean;
    nocap?: boolean;
    /** the imported robot's id an `add` brings, for the one-id-per-room rule */
    iid?: string;
  }[] = [];
  private pending: PendingMatch | null = null;
  private tag = '';
  /** keys of the sockets whose `room` is this one */
  private readonly attached = new Set<number>();
  /** accounts this room holds the one-game lock for — released by hand if its worker dies */
  private readonly locks = new Set<string>();
  /** requests to the worker still unanswered */
  private inflight = 0;
  /** the registry no longer holds this room (it emptied, or the join path gave it back) */
  private removed = false;
  private disposeSent = false;
  private gap = { n: 0, sumMs: 0, maxMs: 0 };

  constructor(
    private readonly pool: RoomPool,
    /** the worker this room lives on, and its instance id there — both change only on `revive` */
    public slot: Slot,
    public rid: number,
    readonly code: string,
    private readonly onEmpty: () => void,
    readonly config: RoomConfig,
    private readonly cb: Callbacks,
    private readonly capacity: number,
  ) {
    this.facts = initialFacts(code, config, capacity);
    this.boot();
  }

  private boot(): void {
    const cb = this.cb;
    const cbs =
      (cb.onResult ? CB_RESULT : 0) |
      (cb.onUserActive ? CB_ACTIVE : 0) |
      (cb.onUserInactive ? CB_INACTIVE : 0) |
      (cb.onDodge ? CB_DODGE : 0) |
      (cb.onBehaviour ? CB_BEHAVIOUR : 0);
    this.pool.post(this.slot, { k: 'create', rid: this.rid, code: this.code, config: this.config, group: this.tag, cbs });
  }

  /**
   * SOMEBODY IS JOINING A ROOM THE WORKER HAS ALREADY FORGOTTEN.
   *
   * The join path reads a room out of the registry and then awaits (token, lockdown, profile)
   * before it adds anyone, so a room can empty, or be given back by another joiner's failed
   * attempt, in between. An in-process `Room` simply takes them: an orphan nobody else can reach
   * by code, but a live room. A worker room, once disposed, is gone, and the add would vanish
   * with no welcome — a join that hangs. So it is brought back up as a fresh instance of the same
   * room, which is what the in-process object amounts to.
   */
  private reviveIfForgotten(): void {
    if (!this.disposeSent) return;
    if (!this.pool.rehome(this)) return; // no worker left alive to take it
    this.facts = initialFacts(this.code, this.config, this.capacity);
    this.unacked.length = 0;
    this.pending = null;
    this.disposeSent = false;
    this.boot();
  }

  // ---- read locally: the room's own config plus what this thread staged into it ----

  get gameId(): GameId {
    // Room.game, verbatim
    return this.pending?.game ?? this.config.game ?? 'decode';
  }
  get physics(): Physics {
    return serverPhysics(simModuleFor(this.gameId));
  }
  get soloRecord(): boolean {
    return this.config.kind === 'record' && this.config.record === 'solo';
  }
  get group(): string {
    return this.tag;
  }
  set group(g: string) {
    this.tag = g;
    this.pool.post(this.slot, { k: 'group', rid: this.rid, group: g });
  }
  stagedFor(userId: string): boolean {
    // `pendingMatch` is never cleared in a Room, so the roster this thread staged stays the answer
    return !!this.pending?.roster.some((r) => r.userId === userId);
  }

  // ---- read from the mirror ----

  private unackedOf(kind: 'add' | 'spec' | 'reattach' | 'pending'): number {
    let n = 0;
    for (const u of this.unacked) if (u.kind === kind) n++;
    return n;
  }
  canJoin(): boolean {
    const l = this.facts.lobby;
    return l.joinable && l.players + this.unackedOf('add') < l.capacity;
  }
  lobbySummary(): ReturnType<Room['lobbySummary']> {
    return this.facts.lobby;
  }
  seatFor(userId: string): string | null {
    for (const [uid, cid] of this.facts.seats) if (uid === userId) return cid;
    // an add still on its way IS a seat: the worker applies it before anything posted after it
    for (const u of this.unacked) if (u.kind === 'add' && u.uid === userId && u.id) return u.id;
    return null;
  }
  staging(): boolean {
    return this.unackedOf('pending') > 0 || this.facts.staging;
  }
  summary(): LiveRoom | null {
    return this.facts.summary;
  }
  presenceSnapshot(): ReturnType<Room['presenceSnapshot']> {
    return this.facts.presence;
  }
  snapGapStats(reset = false): { n: number; sumMs: number; maxMs: number } {
    const g = this.gap;
    if (reset) this.gap = { n: 0, sumMs: 0, maxMs: 0 };
    return { ...g };
  }
  holdsCapacity(): boolean {
    return this.facts.holds;
  }
  isAbandonable(): boolean {
    return this.unacked.length === 0 && this.facts.abandonable;
  }
  spectatorCount(): number {
    return this.facts.spectators + this.unackedOf('spec');
  }
  /**
   * `Room.importState`, from the mirror. `allows` is answered here (config + the roster this thread
   * staged, as `stagedFor` is); the other two are the worker's last word PLUS the seats and
   * watchers posted since, for the reason `canJoin` counts an `add` in flight: two joins inside a
   * millisecond must each see the other. `ids` likewise: the seats' robot ids plus those of the
   * adds in flight. `except` is the room's own concern (a seat re-picking), never the door's.
   */
  importState(): ImportRoomState {
    const ids = [...(this.facts.imports.ids ?? [])];
    for (const u of this.unacked) if (u.iid) ids.push(u.iid);
    return {
      allows: this.config.kind === 'versus' && !this.pending,
      hasImport: this.facts.imports.hasImport || this.unacked.some((u) => u.imp),
      capless: this.facts.imports.capless || this.unacked.some((u) => u.nocap),
      ids,
    };
  }

  // ---- writes ----

  private populate(
    kind: 'add' | 'spec' | 'reattach' | 'pending',
    uid?: string,
    id?: string,
    flags?: { imp?: boolean; nocap?: boolean; iid?: string },
  ): number {
    const seq = ++this.seq;
    this.unacked.push({ seq, kind, uid, id, ...flags });
    return seq;
  }

  private request<T>(make: (call: number) => Op): Promise<T | null> {
    this.inflight++;
    return this.pool.request<T>(this.slot, make).finally(() => {
      this.inflight--;
      this.maybeDispose();
    });
  }

  add(client: Client): void {
    const sock = sockFor(client.send);
    this.reviveIfForgotten();
    const seq = this.populate('add', client.userId, client.id, {
      imp: isImportedSpec(client.player.spec),
      nocap: !hasImportCap(client.caps),
      iid: importIdOf(client.player.spec),
    });
    this.attached.add(sock);
    this.pool.post(this.slot, { k: 'add', rid: this.rid, seq, sock, client: dataOf(client) });
    // what index.ts reads back as this socket's `conn` and hands to `detach`
    client.conn = sock;
  }

  addSpectator(client: Client): number {
    const sock = sockFor(client.send);
    this.reviveIfForgotten();
    const seq = this.populate('spec', undefined, undefined, { nocap: !hasImportCap(client.caps) });
    this.attached.add(sock);
    this.pool.post(this.slot, { k: 'spec', rid: this.rid, seq, sock, client: dataOf(client) });
    return sock;
  }

  hideSpectator(id: string): void {
    this.pool.post(this.slot, { k: 'hide', rid: this.rid, id });
  }

  detach(id: string, conn?: number, clean = false): void {
    // `conn` is this socket's key once it attached here, 0 before
    const sock = conn ?? 0;
    this.pool.post(this.slot, { k: 'detach', rid: this.rid, id, sock, clean });
    if (sock && this.attached.delete(sock)) this.maybeDispose();
  }

  reattach(
    id: string,
    send: (m: ServerMsg) => void,
    _sendRaw?: (s: string) => void,
    _backlog?: () => number,
    token?: string,
    trusted = false,
    caps?: string[],
  ): Promise<number | null> {
    // the worker rebuilds all three senders around the socket key, so only `send` is needed
    // here, to find that key
    const sock = sockFor(send);
    // a returning build without the import capability counts as one until the worker has it
    const seq = this.populate('reattach', undefined, undefined, caps ? { nocap: !hasImportCap(caps) } : undefined);
    return this.request<boolean>((call) => ({ k: 'reattach', rid: this.rid, seq, call, id, sock, token, trusted, caps })).then(
      (ok) => {
        if (!ok) return null;
        this.attached.add(sock);
        return sock;
      },
    );
  }

  onMessage(id: string, msg: ClientMsg): void {
    this.pool.post(this.slot, { k: 'msg', rid: this.rid, id, msg });
  }

  applyPending(p: PendingMatch): Promise<void> {
    this.pending = p;
    const seq = this.populate('pending');
    return this.request((call) => ({ k: 'pending', rid: this.rid, seq, call, p })).then(() => undefined);
  }

  maybeStartRanked(): void {
    this.pool.post(this.slot, { k: 'maybeStart', rid: this.rid });
  }

  abandonSlot(clientId: string, token?: string): void {
    this.pool.post(this.slot, { k: 'abandon', rid: this.rid, id: clientId, token });
  }

  releaseSeatLock(userId: string): void {
    this.pool.post(this.slot, { k: 'unlock', rid: this.rid, uid: userId });
  }

  resolveReport(reporterClientId: string, robotId: number): Promise<ReportTarget> {
    return this.request<ReportTarget>((call) => ({ k: 'report', rid: this.rid, call, id: reporterClientId, robotId })).then(
      (v) => v ?? null,
    );
  }

  resolveScoreReport(reporterClientId: string): Promise<ScoreReportTarget> {
    return this.request<ScoreReportTarget>((call) => ({ k: 'scoreReport', rid: this.rid, call, id: reporterClientId })).then(
      (v) => v ?? null,
    );
  }

  release(): void {
    this.removed = true;
    this.maybeDispose();
  }

  // ---- from the worker (RoomPool.onEvent) ----

  applyFacts(rid: number, f: RoomFacts): void {
    if (rid !== this.rid) return; // from the instance before a `revive`
    this.facts = f;
    // follow the room's config (a host can unlock a record room), in place: `config` is shared
    this.config.kind = f.cfg.kind;
    if (f.cfg.record) this.config.record = f.cfg.record;
    else delete this.config.record;
    this.config.settings = f.cfg.settings;
    while (this.unacked.length > 0 && this.unacked[0].seq <= f.ack) this.unacked.shift();
  }

  emptied(): void {
    // a room may report empty more than once; only the first drops it from the registry, so a
    // late second report cannot delete a NEW room that has since taken the same code
    if (this.removed) return;
    this.removed = true;
    this.onEmpty();
    this.maybeDispose();
  }

  lock(uid: string, on: boolean): void {
    if (on) {
      this.locks.add(uid);
      this.cb.onUserActive?.(uid);
    } else {
      this.locks.delete(uid);
      this.cb.onUserInactive?.(uid);
    }
  }

  behaviour(b: Parameters<NonNullable<Callbacks['onBehaviour']>>[0]): void {
    this.cb.onBehaviour?.(b);
  }

  answer(fn: 'result' | 'dodge', arg: unknown): Promise<unknown> {
    // `as never`: the arg is exactly what the worker's Room handed its own callback
    if (fn === 'result') return Promise.resolve(this.cb.onResult?.(arg as never));
    return Promise.resolve(this.cb.onDodge?.(arg as never));
  }

  addGap(rid: number, n: number, sumMs: number, maxMs: number): void {
    if (rid !== this.rid) return;
    this.gap.n += n;
    this.gap.sumMs += sumMs;
    if (maxMs > this.gap.maxMs) this.gap.maxMs = maxMs;
  }

  /**
   * The worker died and took this room with it. What an in-process room would have lost with
   * the whole process, minus everything else on the machine: the players get their socket
   * closed (their client reconnects, finds no room, and is told so), the one-game lock is let
   * go so they can start something else, and the registry forgets the code.
   */
  lost(): void {
    for (const uid of this.locks) this.cb.onUserInactive?.(uid);
    this.locks.clear();
    if (!this.removed) {
      this.removed = true;
      this.onEmpty();
    }
    for (const key of this.attached) socks.get(key)?.close(1011, 'room lost');
    this.attached.clear();
    this.disposeSent = true;
  }

  /** the worker may forget this room once nothing here can reach it any more */
  private maybeDispose(): void {
    if (!this.removed || this.disposeSent || this.attached.size > 0 || this.inflight > 0) return;
    this.disposeSent = true;
    this.pool.post(this.slot, { k: 'dispose', rid: this.rid });
  }
}

// ---- the pool --------------------------------------------------------------------

export interface Slot {
  index: number;
  worker: Worker | null;
  queue: Op[];
  flushScheduled: boolean;
  /** physics loaded in the CURRENT worker */
  ready: boolean;
  /** given up on: it could not come up, or kept dying */
  dead: boolean;
  rooms: Set<RemoteRoom>;
  calls: Set<number>;
  stats: WorkerStats | null;
  deaths: number[];
}

/** a worker that dies this many times inside the window is not respawned again */
const MAX_DEATHS = 5;
const DEATH_WINDOW_MS = 10 * 60_000;
/** a socket's backlog is reported in steps this size — see `checkBacklog` */
const BACKLOG_STEP = 16 * 1024;

export class RoomPool {
  private readonly slots: Slot[] = [];
  /** every room a worker still knows, by instance id — kept until the worker says `disposed` */
  private readonly handles = new Map<number, RemoteRoom>();
  private readonly calls = new Map<number, { slot: Slot; resolve: (v: unknown) => void }>();
  private nextRid = 1;
  private nextCall = 1;
  /** sockets with bytes queued, re-read on a timer until they drain (see `checkBacklog`) */
  private readonly watched = new Set<HostSocket>();
  private watchTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * The process's imported-robot-visuals budget (`server/importVisuals.ts`): one counter per
   * thread in one shared buffer, so the 64 MiB limit is the PROCESS's and not each worker's. This
   * thread is slot 0, worker `i` is slot `i + 1`.
   */
  private readonly visualBudget = makeSharedVisualBudget();

  constructor(
    private readonly entry: URL,
    n: number,
  ) {
    configureVisualBudget(this.visualBudget, 0);
    for (let i = 0; i < n; i++) {
      const slot: Slot = {
        index: i,
        worker: null,
        queue: [],
        flushScheduled: false,
        ready: false,
        dead: false,
        rooms: new Set(),
        calls: new Set(),
        stats: null,
        deaths: [],
      };
      this.slots.push(slot);
      this.spawn(slot);
    }
  }

  private spawn(slot: Slot): void {
    const w = new Worker(this.entry, { workerData: { visualBudget: this.visualBudget, visualSlot: slot.index + 1 } });
    slot.worker = w;
    slot.ready = false;
    w.on('message', (b: Batch) => this.onBatch(slot, b));
    w.on('error', (e) => console.error(`[workers] worker ${slot.index} error:`, e));
    w.on('exit', (code) => this.onExit(slot, w, code));
  }

  /**
   * The least-loaded live worker, by rooms it holds. A room stays on the worker it was created
   * on for its whole life: moving a running world between threads would be a serialization of
   * Rapier state for no benefit, since rooms are short and new ones spread the load.
   */
  private pick(): Slot | null {
    let best: Slot | null = null;
    for (const s of this.slots) {
      if (s.dead || !s.worker) continue;
      if (!best || s.rooms.size < best.rooms.size) best = s;
    }
    return best;
  }

  create(args: RoomArgs): RoomHandle {
    const slot = this.pick();
    if (!slot) {
      // every worker is gone: keep serving, on this thread, as the server always did
      return new Room(...args);
    }
    const [code, onEmpty, config, onResult, onUserActive, onUserInactive, onDodge, onBehaviour] = args;
    // `Room`'s own default, for a caller that passed none
    const cfg = config ?? DEFAULT_ROOM_CONFIG;
    const rid = this.nextRid++;
    const cbs = { onResult, onUserActive, onUserInactive, onDodge, onBehaviour };
    const room = new RemoteRoom(this, slot, rid, code, onEmpty, cfg, cbs, roomCapacity(cfg));
    this.handles.set(rid, room);
    slot.rooms.add(room);
    return room;
  }

  /**
   * Give a disposed room a new instance id on a live worker (`RemoteRoom.reviveIfForgotten`).
   * Its old id stays mapped until that worker says `disposed`, so late events from the old
   * instance still reach the same callbacks; `applyFacts` ignores them by id.
   */
  rehome(room: RemoteRoom): boolean {
    const slot = room.slot.worker && !room.slot.dead ? room.slot : this.pick();
    if (!slot) return false;
    if (slot !== room.slot) room.slot.rooms.delete(room);
    room.slot = slot;
    room.rid = this.nextRid++;
    this.handles.set(room.rid, room);
    slot.rooms.add(room);
    return true;
  }

  post(slot: Slot, op: Op): void {
    if (!slot.worker) return;
    slot.queue.push(op);
    if (slot.flushScheduled) return;
    slot.flushScheduled = true;
    // one post per worker per turn of the loop: every input that arrived on every socket in this
    // turn goes in the same message
    setImmediate(() => {
      slot.flushScheduled = false;
      const ops = slot.queue;
      slot.queue = [];
      if (ops.length && slot.worker) slot.worker.postMessage(ops);
    });
  }

  request<T>(slot: Slot, make: (call: number) => Op): Promise<T | null> {
    if (!slot.worker) return Promise.resolve(null);
    const id = this.nextCall++;
    return new Promise<T | null>((resolve) => {
      this.calls.set(id, { slot, resolve: resolve as (v: unknown) => void });
      slot.calls.add(id);
      this.post(slot, make(id));
    });
  }

  private onBatch(slot: Slot, b: Batch): void {
    let touched: HostSocket[] | null = null;
    for (let i = 0; i < b.w.length; i += 2) {
      const s = socks.get(b.w[i]);
      if (!s) continue; // closed since the worker wrote it
      s.write(b.s[b.w[i + 1]]);
      (touched ??= []).push(s);
    }
    if (touched) for (const s of touched) this.checkBacklog(s, slot);
    for (const e of b.e) {
      try {
        this.onEvent(slot, e);
      } catch (err) {
        console.error(`[workers] event ${e.k} from worker ${slot.index} failed:`, err);
      }
    }
  }

  private onEvent(slot: Slot, e: Ev): void {
    switch (e.k) {
      case 'ready':
        slot.ready = true;
        return;
      case 'facts':
        this.handles.get(e.rid)?.applyFacts(e.rid, e.f);
        return;
      case 'empty':
        this.handles.get(e.rid)?.emptied();
        return;
      case 'lock':
        this.handles.get(e.rid)?.lock(e.uid, e.on);
        return;
      case 'behaviour':
        this.handles.get(e.rid)?.behaviour(e.b);
        return;
      case 'call': {
        const h = this.handles.get(e.rid);
        const done = (value: unknown, error?: string): void =>
          this.post(slot, error === undefined ? { k: 'reply', call: e.call, value } : { k: 'reply', call: e.call, error });
        if (!h) {
          console.warn(`[workers] ${e.fn} for a room this thread no longer knows (worker ${slot.index}); dropped`);
          done(undefined);
          return;
        }
        h.answer(e.fn, e.arg).then(
          (v) => done(v),
          (err) => done(undefined, err instanceof Error ? err.message : String(err)),
        );
        return;
      }
      case 'reply': {
        const c = this.calls.get(e.call);
        if (!c) return;
        this.calls.delete(e.call);
        c.slot.calls.delete(e.call);
        c.resolve(e.value);
        return;
      }
      case 'disposed': {
        const h = this.handles.get(e.rid);
        this.handles.delete(e.rid);
        // a revived room answers to a new id (possibly on this same worker) and stays counted
        if (h && h.rid === e.rid) slot.rooms.delete(h);
        return;
      }
      case 'gaps':
        for (const [rid, n, sumMs, maxMs] of e.list) this.handles.get(rid)?.addGap(rid, n, sumMs, maxMs);
        return;
      case 'stats':
        slot.stats = e.s;
        return;
    }
  }

  /**
   * `Client.backlog` for a worker room. The room reads it once per snapshot to skip a socket
   * that has stopped draining (`SNAP_BACKLOG_BYTES`); the worker cannot read `ws.bufferedAmount`,
   * so this thread tells it — only when the figure moves by a whole step, which a healthy
   * socket never does (a frame is a few KB). A socket with bytes queued is re-read on a timer
   * too, because a room that is skipping it writes nothing, and without the timer nothing
   * would ever report it drained.
   */
  private checkBacklog(s: HostSocket, slot: Slot): void {
    const bytes = s.backlog();
    const bucket = Math.floor(bytes / BACKLOG_STEP);
    s.slot = slot;
    if (bucket === s.bucket) return;
    s.bucket = bucket;
    this.post(slot, { k: 'backlog', sock: s.key, bytes: bucket === 0 ? 0 : bytes });
    if (bucket > 0) this.watch(s);
    else this.unwatch(s);
  }

  private watch(s: HostSocket): void {
    this.watched.add(s);
    if (this.watchTimer) return;
    this.watchTimer = setInterval(() => {
      for (const w of this.watched) if (w.slot) this.checkBacklog(w, w.slot);
    }, 50);
    this.watchTimer.unref();
  }

  unwatch(s: HostSocket): void {
    this.watched.delete(s);
    if (this.watched.size === 0 && this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
  }

  private onExit(slot: Slot, w: Worker, code: number): void {
    if (slot.worker !== w) return;
    const wasReady = slot.ready;
    slot.worker = null;
    slot.ready = false;
    slot.queue = [];
    slot.flushScheduled = false;
    slot.stats = null;
    // its rooms died with it, and so did their pictures: hand the bytes back to the budget
    resetVisualSlot(this.visualBudget, slot.index + 1);
    console.error(`[workers] worker ${slot.index} exited (code ${code}); ${slot.rooms.size} room(s) lost`);
    for (const id of slot.calls) {
      const c = this.calls.get(id);
      this.calls.delete(id);
      c?.resolve(null);
    }
    slot.calls.clear();
    for (const r of slot.rooms) {
      this.handles.delete(r.rid);
      r.lost();
    }
    slot.rooms.clear();
    const now = Date.now();
    slot.deaths = slot.deaths.filter((t) => now - t < DEATH_WINDOW_MS);
    slot.deaths.push(now);
    // a worker that never loaded its physics will not load it next time either, and one that
    // keeps dying is taking rooms down with it each time: stop feeding it rooms
    if (!wasReady || slot.deaths.length >= MAX_DEATHS) {
      slot.dead = true;
      console.error(`[workers] worker ${slot.index} not respawned (${wasReady ? 'died too often' : 'never became ready'})`);
      return;
    }
    this.spawn(slot);
  }

  perf(): { worker: number; alive: boolean; ready: boolean; rooms: number; stats: WorkerStats | null }[] {
    return this.slots.map((s) => ({ worker: s.index, alive: !!s.worker, ready: s.ready, rooms: s.rooms.size, stats: s.stats }));
  }

  resetPerf(): void {
    for (const s of this.slots) this.post(s, { k: 'perfReset' });
  }

  /** TEST SEAM: end worker `i` the way a crash would (`npm run test:workers`). */
  async killForTest(i: number): Promise<void> {
    await this.slots[i]?.worker?.terminate();
  }
}

// ---- the module's one pool ----------------------------------------------------------------

let pool: RoomPool | null = null;

/**
 * Where the worker entry is: beside this file, as `.ts` under tsx (`npm run server`) and as
 * `.js` in the production bundle (the Dockerfile builds `roomWorker.js` next to `index.js`). A
 * bundle that did not build it — the single-file LAN build (`server:bundle`) — has none, and
 * runs rooms in-process rather than failing.
 */
function workerEntry(): URL | null {
  const self = import.meta.url;
  const entry = new URL(self.endsWith('.ts') ? './roomWorker.ts' : './roomWorker.js', self);
  return existsSync(fileURLToPath(entry)) ? entry : null;
}

/** Start `n` room workers. Returns how many were started (0 = rooms stay in-process). */
export function startRoomWorkers(n: number): number {
  if (n <= 0 || pool) return pool ? pool.perf().length : 0;
  const entry = workerEntry();
  if (!entry) {
    console.warn(`[workers] SIM_WORKERS=${n} but no room worker was built beside this server; running rooms in-process`);
    return 0;
  }
  pool = new RoomPool(entry, n);
  return n;
}

/** A new room: on a worker when there are workers, in-process otherwise. Same arguments as `new Room`. */
export function createRoom(...args: RoomArgs): RoomHandle {
  return pool ? pool.create(args) : new Room(...args);
}

/** per-worker load for `/api/perf`, or undefined without workers */
export function workerPerf(): ReturnType<RoomPool['perf']> | undefined {
  return pool?.perf();
}

export function resetWorkerPerf(): void {
  pool?.resetPerf();
}

/** TEST SEAM: kill room worker `i` as a crash would. */
export function killWorkerForTest(i: number): Promise<void> {
  return pool ? pool.killForTest(i) : Promise.resolve();
}

/** TEST SEAM: which worker a room was placed on (-1 = in-process). */
export function workerOfForTest(r: RoomHandle): number {
  return r instanceof RemoteRoom ? r.slot.index : -1;
}
