/**
 * ROOMS IN WORKER THREADS — the main-thread half of `SIM_WORKERS` (docs/scaling-multicore.md,
 * Option A). OFF BY DEFAULT: with `SIM_WORKERS` unset or 0, `server/index.ts` never constructs a
 * pool and builds `new Room(...)` exactly as it always has.
 *
 * WHY: Node runs JavaScript on one thread, so one server process was one core however large the
 * machine, and ~90% of a busy server is simulation plus snapshot encoding (docs/capacity.md §7b).
 * A `Room` already talks to the world only through callbacks and a `Client`'s three functions, so
 * it can live on another thread with nothing about it changed.
 *
 * WHO OWNS WHAT
 *  - MAIN keeps every socket, HTTP, the matchmaker, the DB pool, presence and the room-code
 *    directory (`index.ts`'s `rooms` map, whose values are `RoomHandle`s here). It WRITES bytes:
 *    each `{ k: 'out', key, s }` from a worker is handed to the socket behind sink `key` as is.
 *  - A WORKER (`server/roomWorker.ts` → `RoomHost`) runs the real `Room`s, their shared 60 Hz
 *    clock, and builds every string a client is sent — snapshots included.
 *
 * THE SEAM, per `index.ts` call:
 *  - writes (`add`, `detach`, `onMessage`, …) are POSTS, batched once per event-loop turn;
 *  - synchronous reads (`canJoin`, `lobbySummary`, `summary`, `presenceSnapshot`, `stagedFor`, …)
 *    are answered from the worker's pushed MIRROR, never awaited. A stale mirror can only REFUSE:
 *    the worker re-checks capacity on `add` (`RoomHost`), and `isAbandonable` answers false while
 *    a mutation main sent is not yet reflected;
 *  - the three calls whose RESULT the join path needs (`reattach`, `applyPending`, the two report
 *    resolvers) return a Promise here and a plain value on a real `Room`, and `index.ts` awaits
 *    only when it was handed a Promise — so the in-process path does not gain a single tick.
 *  - `conn` is a MAIN-minted sink key: `add` sets `client.conn` to it synchronously, exactly as
 *    `Room.add` sets the room's own counter, and the worker maps key → the room's conn on
 *    `detach`, so a superseded socket's late close is still ignored.
 *
 * A WORKER THAT DIES takes only its own rooms: every socket in them is sent an error and closed
 * (the client's own reconnect then learns the match is gone), their locks are released, the
 * directory forgets them, and a replacement worker is started in the same slot.
 */
import { Worker } from 'node:worker_threads';
import { DEFAULT_ROOM_CONFIG, decodeServerMsg, encodeMsg, type ClientMsg, type LiveRoom, type RoomConfig } from '../src/net/protocol';
import { coerceGameId, serverPhysics } from '../src/games/types';
import { simModuleFor } from '../src/games/sim';
import { roomCapacity } from '../src/net/protocol';
import type { GameId, Physics } from '../src/types';
import type { BehaviourReport, Client, DodgeReport, MatchOutcome, PersistOutcome } from './room';
import type { PendingMatch } from './matchTypes';
import type { DodgeVerdict } from '../src/dodge';
import { describeClient, type FromWorker, type LobbySummary, type RoomMirror, type ToWorker } from './roomWire';

/** what `index.ts` may be told about a socket's room from outside the request that attached it */
export interface SinkHooks {
  /** the worker refused this add (capacity raced past the mirror). The error is already sent. */
  onRefused?: () => void;
  /** the room is gone (its worker died). An error frame has already been written. */
  onEvicted?: () => void;
}

type Report = { reporterId: string; reportedId: string };
type ScoreReport = { reporterId: string; matchId: string | null; roomCode: string };

/**
 * EVERYTHING `server/index.ts` DOES WITH A ROOM — implemented by `Room` itself (in-process) and by
 * `RoomHandle` (in a worker). Three methods may return a Promise; see the header.
 */
export interface RoomLike {
  readonly code: string;
  readonly config: RoomConfig;
  readonly gameId: GameId;
  readonly physics: Physics;
  readonly soloRecord: boolean;
  group: string;
  canJoin(): boolean;
  lobbySummary(): LobbySummary;
  seatFor(userId: string): string | null;
  staging(): boolean;
  stagedFor(userId: string): boolean;
  isAbandonable(): boolean;
  holdsCapacity(): boolean;
  summary(): LiveRoom | null;
  presenceSnapshot(): RoomMirror['presence'];
  spectatorCount(): number;
  snapGapStats(reset?: boolean): { n: number; sumMs: number; maxMs: number };
  add(client: Client, hooks?: SinkHooks): void;
  addSpectator(client: Client, hooks?: SinkHooks): void;
  hideSpectator(id: string): void;
  detach(id: string, conn?: number, clean?: boolean): void;
  reattach(
    id: string,
    send: (m: import('../src/net/protocol').ServerMsg) => void,
    sendRaw?: (s: string) => void,
    backlog?: () => number,
    token?: string,
    trusted?: boolean,
    hooks?: SinkHooks,
  ): number | null | Promise<number | null>;
  onMessage(id: string, msg: ClientMsg): void;
  maybeStartRanked(): void;
  applyPending(p: PendingMatch): void | Promise<void>;
  releaseSeatLock(userId: string): boolean | void;
  abandonSlot(clientId: string, token?: string): boolean | void;
  resolveReport(reporterClientId: string, robotId: number): Report | null | Promise<Report | null>;
  resolveScoreReport(reporterClientId: string): ScoreReport | null | Promise<ScoreReport | null>;
  /** a worker room must be told when main gives it back unfilled; a `Room` has nothing to free */
  dispose?(): void;
}

/** narrow a `RoomLike` result: the in-process answer, or the worker's promise of one */
export const isPromise = <T>(v: T | Promise<T>): v is Promise<T> =>
  typeof (v as { then?: unknown } | null)?.then === 'function';

/** the constructor callbacks `index.ts` hands a room, in `Room`'s own parameter order */
export interface RoomCallbacks {
  onResult?: (o: MatchOutcome) => void | Promise<PersistOutcome | void>;
  onUserActive?: (userId: string) => void;
  onUserInactive?: (userId: string) => void;
  onDodge?: (d: DodgeReport) => void | Promise<DodgeVerdict[] | void>;
  onBehaviour?: (b: BehaviourReport) => void;
}

interface Sink {
  handle: RoomHandle;
  clientId: string;
  sendRaw: (s: string) => void;
  backlog?: () => number;
  hooks?: SinkHooks;
}

export interface Slot {
  index: number;
  worker: Worker;
  handles: Set<RoomHandle>;
  queue: ToWorker[];
  flushQueued: boolean;
  seq: number;
  alive: boolean;
  ready: boolean;
  /** sink keys whose backlog was reported non-zero last time (so a drain to zero is sent too) */
  backlogged: boolean;
}

const LOST = 'The match server hit a problem and this match was lost. Sorry — start a new one.';

export interface PoolOptions {
  /** the worker module; defaults to `./roomWorker.(ts|js)` beside this file */
  workerUrl?: URL;
  /** false skips each worker's JIT warm-up (tests) */
  warm?: boolean;
  /** how often socket backlogs are reported to the workers */
  backlogMs?: number;
  log?: (s: string) => void;
}

export class RoomPool {
  private readonly slots: Slot[] = [];
  private readonly sinks = new Map<number, Sink>();
  private readonly byId = new Map<number, RoomHandle>();
  private readonly replies = new Map<number, { slot: Slot; res: (v: unknown) => void }>();
  private nextKey = 0;
  private nextRoomId = 0;
  private nextReq = 0;
  private closing = false;
  private readonly backlogTimer: ReturnType<typeof setInterval>;
  private readonly url: URL;
  private readonly log: (s: string) => void;
  /** replacements started after a crash (diagnostics and tests) */
  respawns = 0;

  constructor(
    readonly size: number,
    private readonly opts: PoolOptions = {},
  ) {
    this.log = opts.log ?? ((s) => console.log(s));
    this.url =
      opts.workerUrl ??
      // from source, a bootstrap that installs tsx's hooks in the worker; bundled, the worker bundle
      new URL(import.meta.url.endsWith('.ts') ? './roomWorker.dev.mjs' : './roomWorker.js', import.meta.url);
    for (let i = 0; i < size; i++) this.slots.push(this.spawn(i));
    this.backlogTimer = setInterval(() => this.reportBacklogs(), opts.backlogMs ?? 100);
    this.backlogTimer.unref?.();
  }

  private spawn(index: number): Slot {
    const worker = new Worker(this.url, { workerData: { warm: this.opts.warm !== false } });
    const slot: Slot = { index, worker, handles: new Set(), queue: [], flushQueued: false, seq: 0, alive: true, ready: false, backlogged: false };
    worker.on('message', (batch: FromWorker[]) => this.receive(slot, batch));
    worker.on('error', (e) => this.log(`[workers] worker ${index} threw: ${e instanceof Error ? e.stack : String(e)}`));
    worker.on('exit', (code) => this.lost(slot, code));
    return slot;
  }

  /** resolves once every worker has loaded physics (and warmed, unless told not to) */
  ready(): Promise<void> {
    return new Promise((res) => {
      const check = (): void => {
        if (this.slots.every((s) => s.ready)) res();
        else setTimeout(check, 20);
      };
      check();
    });
  }

  /** rooms per worker, for `/api/perf` */
  load(): number[] {
    return this.slots.map((s) => s.handles.size);
  }

  /** `new Room(...)`'s twin: same arguments, same order, a handle to a room in the least-loaded worker */
  createRoom(
    code: string,
    onEmpty: () => void,
    config: RoomConfig = DEFAULT_ROOM_CONFIG,
    onResult?: RoomCallbacks['onResult'],
    onUserActive?: RoomCallbacks['onUserActive'],
    onUserInactive?: RoomCallbacks['onUserInactive'],
    onDodge?: RoomCallbacks['onDodge'],
    onBehaviour?: RoomCallbacks['onBehaviour'],
  ): RoomHandle {
    const live = this.slots.filter((s) => s.alive);
    const slot = live.reduce((a, b) => (b.handles.size < a.handles.size ? b : a), live[0] ?? this.slots[0]);
    const roomId = ++this.nextRoomId;
    const h = new RoomHandle(this, slot, roomId, code, config, onEmpty, { onResult, onUserActive, onUserInactive, onDodge, onBehaviour });
    slot.handles.add(h);
    this.byId.set(roomId, h);
    this.post(slot, {
      k: 'create',
      seq: 0,
      roomId,
      code,
      config,
      group: '',
      has: { result: !!onResult, active: !!onUserActive, inactive: !!onUserInactive, dodge: !!onDodge, behaviour: !!onBehaviour },
    });
    return h;
  }

  /** @internal queue a message for a worker; stamps the sequence number main-side */
  post(slot: Slot, m: ToWorker): number {
    if (!slot.alive) return 0;
    if ('seq' in m) m.seq = ++slot.seq;
    slot.queue.push(m);
    if (!slot.flushQueued) {
      slot.flushQueued = true;
      // ONE post per event-loop turn: every socket's input that arrived in this poll phase
      // travels together
      setImmediate(() => {
        slot.flushQueued = false;
        if (!slot.alive || slot.queue.length === 0) return;
        const b = slot.queue;
        slot.queue = [];
        slot.worker.postMessage(b);
      });
    }
    return 'seq' in m ? m.seq : 0;
  }

  /** @internal a request/response to a worker */
  request<T>(slot: Slot, build: (req: number) => ToWorker, fallback: T): Promise<T> {
    if (!slot.alive) return Promise.resolve(fallback);
    const req = ++this.nextReq;
    return new Promise<T>((res) => {
      this.replies.set(req, { slot, res: (v) => res(v as T) });
      this.post(slot, build(req));
    });
  }

  /** @internal */
  newKey(): number {
    return ++this.nextKey;
  }

  /** @internal */
  addSink(key: number, sink: Sink): void {
    this.sinks.set(key, sink);
  }

  /** @internal */
  dropSink(key: number): void {
    this.sinks.delete(key);
  }

  private receive(slot: Slot, batch: FromWorker[]): void {
    for (const m of batch) {
      try {
        this.one(slot, m);
      } catch (e) {
        this.log(`[workers] ${m.k} from worker ${slot.index} failed: ${e instanceof Error ? e.stack : String(e)}`);
      }
    }
  }

  private one(slot: Slot, m: FromWorker): void {
    switch (m.k) {
      case 'out': {
        this.sinks.get(m.key)?.sendRaw(m.s);
        return;
      }
      case 'mirror':
        this.byId.get(m.roomId)?.applyMirror(m.m);
        return;
      case 'reply': {
        const r = this.replies.get(m.req);
        this.replies.delete(m.req);
        r?.res(m.value);
        return;
      }
      case 'empty': {
        const h = this.byId.get(m.roomId);
        if (h) this.forget(h, false);
        return;
      }
      case 'refused': {
        const s = this.sinks.get(m.key);
        this.sinks.delete(m.key);
        s?.hooks?.onRefused?.();
        return;
      }
      case 'active': {
        const h = this.byId.get(m.roomId);
        h?.activeUids.add(m.uid);
        h?.cb.onUserActive?.(m.uid);
        return;
      }
      case 'inactive': {
        const h = this.byId.get(m.roomId);
        h?.activeUids.delete(m.uid);
        h?.cb.onUserInactive?.(m.uid);
        return;
      }
      case 'behaviour':
        this.byId.get(m.roomId)?.cb.onBehaviour?.(m.b);
        return;
      case 'result':
      case 'dodge': {
        const h = this.byId.get(m.roomId);
        const fn = m.k === 'result' ? () => h?.cb.onResult?.(m.o) : () => h?.cb.onDodge?.(m.d);
        let out: unknown;
        try {
          out = fn();
        } catch (e) {
          this.log(`[workers] ${m.k} callback threw: ${String(e)}`);
        }
        void Promise.resolve(out)
          .catch((e) => {
            this.log(`[workers] ${m.k} callback failed: ${String(e)}`);
            return undefined;
          })
          .then((value) => this.post(slot, { k: 'reply', req: m.req, value }));
        return;
      }
      case 'ready':
        slot.ready = true;
        if (m.warm) this.log(`[workers] worker ${slot.index} ready (warm-up ${m.warm.ticks} ticks in ${m.warm.ms} ms)`);
        return;
    }
  }

  /** a room is gone: out of the directory (the room's own `onEmpty`), its sinks with it */
  private forget(h: RoomHandle, lost: boolean): void {
    if (!this.byId.has(h.roomId)) return;
    this.byId.delete(h.roomId);
    h.slot.handles.delete(h);
    for (const [key, s] of this.sinks) {
      if (s.handle !== h) continue;
      this.sinks.delete(key);
      if (lost) {
        try {
          s.sendRaw(encodeMsg({ t: 'error', message: LOST }));
        } catch {
          /* the socket is already gone */
        }
        s.hooks?.onEvicted?.();
      }
    }
    if (lost) {
      // the dead room cannot release its own single-game locks any more
      for (const uid of h.activeUids) h.cb.onUserInactive?.(uid);
      h.activeUids.clear();
    }
    h.onEmpty();
  }

  /** @internal main handed a never-filled room back (`abandon` in the join path) */
  dispose(h: RoomHandle): void {
    this.post(h.slot, { k: 'dispose', seq: 0, roomId: h.roomId });
    if (!this.byId.has(h.roomId)) return;
    this.byId.delete(h.roomId);
    h.slot.handles.delete(h);
  }

  private lost(slot: Slot, code: number): void {
    slot.alive = false;
    if (this.closing) return;
    this.log(`[workers] worker ${slot.index} exited (code ${code}); its ${slot.handles.size} room(s) are lost, starting a replacement`);
    for (const h of [...slot.handles]) this.forget(h, true);
    // anything main was waiting on from THAT worker is answered "no"
    for (const [req, r] of this.replies) {
      if (r.slot !== slot) continue;
      this.replies.delete(req);
      r.res(null);
    }
    this.respawns++;
    this.slots[slot.index] = this.spawn(slot.index);
  }

  private reportBacklogs(): void {
    const per = new Map<Slot, [number, number][]>();
    for (const [key, s] of this.sinks) {
      const b = s.backlog?.() ?? 0;
      if (b <= 0) continue;
      const slot = s.handle.slot;
      let arr = per.get(slot);
      if (!arr) per.set(slot, (arr = []));
      arr.push([key, b]);
    }
    for (const slot of this.slots) {
      const vals = per.get(slot) ?? [];
      if (vals.length === 0 && !slot.backlogged) continue;
      slot.backlogged = vals.length > 0;
      this.post(slot, { k: 'backlog', vals });
    }
  }

  /** stop every worker (tests, shutdown) */
  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.backlogTimer);
    await Promise.all(this.slots.map((s) => s.worker.terminate()));
  }

  /** TEST SEAM: kill a worker the way a crash would */
  crashWorkerForTest(index: number): Promise<number> {
    return this.slots[index].worker.terminate();
  }

  /** TEST SEAM: pump a room's match synchronously inside its worker (`Room.advanceForTest`) */
  advanceForTest(h: RoomHandle, ticks: number, toPost = false): Promise<unknown> {
    return this.request(h.slot, (req) => ({ k: 'testAdvance', seq: 0, roomId: h.roomId, req, ticks, toPost }), null);
  }

  /** TEST SEAM: which worker a handle lives in */
  workerOf(h: RoomHandle): number {
    return h.slot.index;
  }
}

const freshMirror = (code: string, config: RoomConfig): RoomMirror => {
  const gameId = coerceGameId(config.game);
  return {
    ack: 0,
    config,
    gameId,
    physics: serverPhysics(simModuleFor(gameId)),
    staging: false,
    canJoin: roomCapacity(config) > 0,
    lobby: { code, players: 0, capacity: roomCapacity(config), kind: config.kind, game: config.game ?? 'decode', joinable: true, state: 'lobby' },
    abandonable: true,
    summary: null,
    presence: { players: [], guests: [] },
    holdsCapacity: true,
    spectators: 0,
    hasWorld: false,
    tick: 0,
    seats: {},
    snapGap: { n: 0, sumMs: 0, maxMs: 0 },
  };
};

/** a room that lives in a worker, as `index.ts` sees it — see `RoomLike` */
export class RoomHandle implements RoomLike {
  private m: RoomMirror;
  /** seq of the last post that can make `isAbandonable` false (an add, a spectator, a reattach) */
  private lastSeat = 0;
  /** seqs of spectator adds not yet reflected in a mirror */
  private spectatorSeqs: number[] = [];
  private readonly spectatorKeys = new Map<string, number>();
  private pending: PendingMatch | null = null;
  private groupTag = '';
  /** @internal accounts this room holds a single-game lock for (released for it if it dies) */
  readonly activeUids = new Set<string>();

  constructor(
    private readonly pool: RoomPool,
    /** @internal */ readonly slot: Slot,
    /** @internal */ readonly roomId: number,
    readonly code: string,
    config: RoomConfig,
    /** @internal */ readonly onEmpty: () => void,
    /** @internal */ readonly cb: RoomCallbacks,
  ) {
    this.m = freshMirror(code, config);
  }

  /** @internal */
  applyMirror(m: RoomMirror): void {
    this.m = m;
    this.spectatorSeqs = this.spectatorSeqs.filter((s) => s > m.ack);
  }

  private post(m: ToWorker): number {
    return this.pool.post(this.slot, m);
  }

  get config(): RoomConfig {
    return this.m.config;
  }
  get gameId(): GameId {
    return this.m.gameId;
  }
  get physics(): Physics {
    return this.m.physics;
  }
  get soloRecord(): boolean {
    return this.m.config.kind === 'record' && this.m.config.record === 'solo';
  }
  get group(): string {
    return this.groupTag;
  }
  set group(g: string) {
    this.groupTag = g;
    this.post({ k: 'do', seq: 0, roomId: this.roomId, op: 'setGroup', a: g });
  }
  get tick(): number {
    return this.m.tick;
  }
  get hasWorld(): boolean {
    return this.m.hasWorld;
  }
  canJoin(): boolean {
    return this.m.canJoin;
  }
  lobbySummary(): LobbySummary {
    return { ...this.m.lobby };
  }
  seatFor(userId: string): string | null {
    return this.m.seats[userId] ?? null;
  }
  staging(): boolean {
    return this.m.staging;
  }
  /** exact, not mirrored: main handed the worker this roster itself (`applyPending`) */
  stagedFor(userId: string): boolean {
    return !!this.pending?.roster.some((r) => r.userId === userId);
  }
  isAbandonable(): boolean {
    // a mirror built before our own latest seat-taking post cannot vouch for an empty room
    return this.m.ack >= this.lastSeat && this.m.abandonable && this.pending === null;
  }
  holdsCapacity(): boolean {
    return this.m.holdsCapacity;
  }
  summary(): LiveRoom | null {
    return this.m.summary;
  }
  presenceSnapshot(): RoomMirror['presence'] {
    return this.m.presence;
  }
  spectatorCount(): number {
    return this.m.spectators + this.spectatorSeqs.length;
  }
  snapGapStats(reset = false): { n: number; sumMs: number; maxMs: number } {
    const g = { ...this.m.snapGap };
    if (reset) {
      this.post({ k: 'do', seq: 0, roomId: this.roomId, op: 'resetSnapGap' });
      this.m = { ...this.m, snapGap: { n: 0, sumMs: 0, maxMs: 0 } };
    }
    return g;
  }

  private sink(clientId: string, send: (m: import('../src/net/protocol').ServerMsg) => void, sendRaw?: (s: string) => void, backlog?: () => number, hooks?: SinkHooks): number {
    const key = this.pool.newKey();
    this.pool.addSink(key, {
      handle: this,
      clientId,
      sendRaw: sendRaw ?? ((s) => send(decodeServerMsg(s))),
      backlog,
      hooks,
    });
    return key;
  }

  add(client: Client, hooks?: SinkHooks): void {
    const key = this.sink(client.id, client.send, client.sendRaw, client.backlog, hooks);
    // what `Room.add` does to the caller's object: `index.ts` reads it back as its `conn`
    client.conn = key;
    this.lastSeat = this.post({ k: 'add', seq: 0, roomId: this.roomId, key, client: describeClient(client) });
  }

  addSpectator(client: Client, hooks?: SinkHooks): void {
    const key = this.sink(client.id, client.send, client.sendRaw, client.backlog, hooks);
    this.spectatorKeys.set(client.id, key);
    const seq = this.post({ k: 'spectate', seq: 0, roomId: this.roomId, key, client: describeClient(client) });
    this.lastSeat = seq;
    this.spectatorSeqs.push(seq);
  }

  hideSpectator(id: string): void {
    this.post({ k: 'do', seq: 0, roomId: this.roomId, op: 'hideSpectator', a: id });
  }

  detach(id: string, conn?: number, clean = false): void {
    const key = conn || this.spectatorKeys.get(id) || 0;
    this.spectatorKeys.delete(id);
    this.post({ k: 'detach', seq: 0, roomId: this.roomId, id, key, clean });
    if (key) this.pool.dropSink(key);
  }

  reattach(
    id: string,
    send: (m: import('../src/net/protocol').ServerMsg) => void,
    sendRaw?: (s: string) => void,
    backlog?: () => number,
    token?: string,
    trusted = false,
    hooks?: SinkHooks,
  ): Promise<number | null> {
    const key = this.sink(id, send, sendRaw, backlog, hooks);
    return this.pool
      .request<boolean | null>(
        this.slot,
        (req) => {
          const m: ToWorker = { k: 'reattach', seq: 0, roomId: this.roomId, req, key, id, hasRaw: !!sendRaw, hasBacklog: !!backlog, token, trusted };
          return m;
        },
        null,
      )
      .then((ok) => {
        if (ok) return key;
        this.pool.dropSink(key);
        return null;
      });
  }

  onMessage(id: string, msg: ClientMsg): void {
    this.post({ k: 'msg', seq: 0, roomId: this.roomId, id, msg });
  }

  maybeStartRanked(): void {
    this.post({ k: 'do', seq: 0, roomId: this.roomId, op: 'maybeStartRanked' });
  }

  applyPending(p: PendingMatch): Promise<void> {
    this.pending = p;
    return this.pool
      .request(this.slot, (req) => ({ k: 'applyPending', seq: 0, roomId: this.roomId, req, pending: p }), null)
      .then(() => undefined);
  }

  releaseSeatLock(userId: string): void {
    this.post({ k: 'do', seq: 0, roomId: this.roomId, op: 'releaseSeatLock', a: userId });
  }

  abandonSlot(clientId: string, token?: string): void {
    this.post({ k: 'do', seq: 0, roomId: this.roomId, op: 'abandonSlot', a: clientId, b: token });
  }

  resolveReport(reporterClientId: string, robotId: number): Promise<Report | null> {
    return this.pool.request(this.slot, (req) => ({ k: 'resolveReport', seq: 0, roomId: this.roomId, req, id: reporterClientId, robotId }), null);
  }

  resolveScoreReport(reporterClientId: string): Promise<ScoreReport | null> {
    return this.pool.request(this.slot, (req) => ({ k: 'resolveScoreReport', seq: 0, roomId: this.roomId, req, id: reporterClientId }), null);
  }

  /** hand a never-filled room back to its worker (the join path's `abandon`) */
  dispose(): void {
    this.pool.dispose(this);
  }
}

/** `SIM_WORKERS`, clamped: 0 (off, the default) … 16. Anything unparseable is 0. */
export function simWorkers(env: string | undefined): number {
  const n = Number.parseInt((env ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(16, n) : 0;
}
