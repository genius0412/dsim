/**
 * A ROOM WORKER (`SIM_WORKERS`, docs/scaling-multicore.md). Runs real `Room`s — `step()`,
 * Rapier, snapshot build and JSON encode — on its own thread, and talks to the socket thread
 * (`server/roomHost.ts`) only by message.
 *
 * It holds no socket. A client here is a `Client` whose three functions are rebuilt around the
 * socket KEY the socket thread sent with it: `send`/`sendRaw` queue a frame for that key, and
 * `backlog` reads the last byte count the socket thread reported for it. Everything the room
 * says to the outside world — frames, the one-game lock, results to persist — is queued and
 * posted in ONE message per loop turn (`flush`), so a room that snapshots four sockets costs
 * one post, not four.
 *
 * What it deliberately does NOT do is decide anything the in-process room would not have
 * decided: every op is the same `Room` method the socket thread used to call directly, in the
 * same order, so the room's behaviour is the room's.
 */
import { parentPort, threadId, workerData } from 'node:worker_threads';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { Room, type Client, type MatchOutcome, type PersistOutcome, type DodgeReport } from './room';
import { configureVisualBudget } from './importVisuals';
import { encodeMsg, type ServerMsg } from '../src/net/protocol';
import type { DodgeVerdict } from '../src/dodge';
import { initPhysics } from '../src/sim/physicsEngine';
import { initPhysics3d } from '../src/games/biobuzz/sim3d/engine';
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
} from './roomThreads';

const port = parentPort;
if (!port) throw new Error('server/roomWorker.ts is a worker_threads entry, not a module to import');
const tag = `[worker ${threadId}]`;

// the process's imported-robot-visuals budget is one counter per thread in a shared buffer
// (`server/importVisuals.ts`); this thread writes only its own slot
{
  const wd = workerData as { visualBudget?: SharedArrayBuffer; visualSlot?: number } | null;
  configureVisualBudget(wd?.visualBudget, wd?.visualSlot ?? 0);
}

// the same containment the socket thread has: one bad tick must not take every room on this
// thread with it (the Room's own loop already catches closer in)
process.on('uncaughtException', (e) => console.error(`${tag} uncaughtException:`, e));
process.on('unhandledRejection', (e) => console.error(`${tag} unhandledRejection:`, e));

interface Entry {
  room: Room;
  code: string;
  /** newest populating op applied (echoed as `RoomFacts.ack`) */
  ack: number;
  /** every signed-in user ever added here — `seatFor` is asked of each to build `seats` */
  uids: Set<string>;
  /** the last facts sent, serialized, so an unchanged room sends nothing */
  last: string;
  /** requests to the socket thread still awaiting an answer (persist, dodge) */
  calls: number;
  disposing: boolean;
}

const rooms = new Map<number, Entry>();
/** socket key → the `conn` stamp its room issued it (`Room.add` / `Room.reattach`) */
const connOf = new Map<number, number>();
/** socket key → bytes still queued on it, as last reported by the socket thread */
const backlogs = new Map<number, number>();
/** requests to the socket thread, by call id */
const pendingCalls = new Map<number, { rid: number; resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let nextCall = 1;

// ---- the outbox -------------------------------------------------------------

let strs: string[] = [];
let strIndex = new Map<string, number>();
let writes: number[] = [];
let events: Ev[] = [];
/** rooms whose facts may have moved since they were last sent */
const dirty = new Set<number>();
let scheduled = false;

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  // setImmediate, not a microtask: every room whose timer fired in this turn of the loop goes
  // out in the same post, which is the whole point of batching
  setImmediate(flush);
}

/**
 * A frame for one socket. A string the room has already handed another socket this turn is
 * sent once — the room encodes a broadcast once (`Client.sendRaw`) and so passes the SAME
 * string to every recipient.
 *
 * A snapshot skips both of those. Each recipient's copy is its own string (it ends in that
 * client's `ackInputTick`), so there is nothing to share and hashing a few KB per frame for a
 * lookup that never hits is waste. And it does not mark the room dirty: it is 30 Hz and changes
 * nothing the socket thread mirrors except the live score and clock, which the once-a-second
 * sweep refreshes. Anything else a room says (roster, matchStart, results…) is a state change.
 *
 * A `visualChunk` is the same: one viewer's 33 KB slice of a robot's picture, unique to its
 * recipient, so hashing it is waste, and it changes nothing the socket thread mirrors.
 */
function out(rid: number, sock: number, s: string): void {
  let i: number | undefined;
  if (s.startsWith('{"t":"snapshot"') || s.startsWith('{"t":"visualChunk"')) {
    i = strs.push(s) - 1;
  } else {
    i = strIndex.get(s);
    if (i === undefined) {
      i = strs.push(s) - 1;
      strIndex.set(s, i);
    }
    dirty.add(rid);
  }
  writes.push(sock, i);
  schedule();
}

function emit(e: Ev): void {
  events.push(e);
  schedule();
}

function flush(): void {
  scheduled = false;
  for (const rid of dirty) pushFacts(rid);
  dirty.clear();
  if (writes.length === 0 && events.length === 0) return;
  const batch: Batch = { s: strs, w: writes, e: events };
  strs = [];
  strIndex = new Map();
  writes = [];
  events = [];
  port!.postMessage(batch);
}

function pushFacts(rid: number): void {
  const e = rooms.get(rid);
  if (!e) return;
  const r = e.room;
  const seats: [string, string][] = [];
  for (const uid of e.uids) {
    const cid = r.seatFor(uid);
    if (cid) seats.push([uid, cid]);
    else e.uids.delete(uid); // a seat, once gone, is not reclaimed by account
  }
  const imp = r.importState();
  const f: RoomFacts = {
    ack: e.ack,
    lobby: r.lobbySummary(),
    cfg: r.cfgFacts(),
    seats,
    staging: r.staging(),
    summary: r.summary(),
    presence: r.presenceSnapshot(),
    holds: r.holdsCapacity(),
    abandonable: r.isAbandonable(),
    spectators: r.spectatorCount(),
    hostCap: r.countsTowardHostCap(),
    plainLobby: r.isPlainLobby(),
    imports: { hasImport: imp.hasImport, capless: imp.capless, ids: [...(imp.ids ?? [])] },
  };
  const s = JSON.stringify(f);
  if (s === e.last) return;
  e.last = s;
  events.push({ k: 'facts', rid, f });
}

// ---- requests to the socket thread -------------------------------------------

function call(rid: number, fn: 'result' | 'dodge', arg: unknown): Promise<unknown> {
  const id = nextCall++;
  const e = rooms.get(rid) ?? disposing.get(rid);
  if (e) e.calls++;
  emit({ k: 'call', rid, call: id, fn, arg });
  return new Promise((resolve, reject) => pendingCalls.set(id, { rid, resolve, reject }));
}

function settleCall(id: number, value: unknown, error?: string): void {
  const p = pendingCalls.get(id);
  if (!p) return;
  pendingCalls.delete(id);
  if (error !== undefined) p.reject(new Error(error));
  else p.resolve(value);
  const e = disposing.get(p.rid) ?? rooms.get(p.rid);
  if (e && --e.calls === 0 && e.disposing) finishDispose(p.rid);
}

/**
 * Rooms the socket thread has let go of while a request was still out. The `Room` object lives
 * on through the promise the request holds (a result being written after everybody left), so
 * `disposed` waits until the answer is back, and then a little longer: whatever the room does
 * with the answer runs in a continuation after it, and may still report (a behaviour report
 * after a result, say). The socket thread keeps its end until `disposed` arrives.
 */
const disposing = new Map<number, Entry>();
const DISPOSE_SETTLE_MS = 5_000;
function finishDispose(rid: number): void {
  setTimeout(() => {
    const e = disposing.get(rid);
    if (!e || e.calls > 0) return;
    disposing.delete(rid);
    emit({ k: 'disposed', rid });
  }, DISPOSE_SETTLE_MS).unref();
}

// ---- building rooms and clients ----------------------------------------------

function senders(rid: number, sock: number): Pick<Client, 'send' | 'sendRaw' | 'backlog'> {
  return {
    // the same bytes the socket thread's own `send` produced: `write(encodeMsg(m))`
    send: (m: ServerMsg) => out(rid, sock, encodeMsg(m)),
    sendRaw: (s: string) => out(rid, sock, s),
    backlog: () => backlogs.get(sock) ?? 0,
  };
}

function makeClient(rid: number, sock: number, data: ClientData): Client {
  return { ...data, ...senders(rid, sock) };
}

function create(op: Extract<Op, { k: 'create' }>): void {
  const { rid, cbs } = op;
  const room = new Room(
    op.code,
    () => emit({ k: 'empty', rid }),
    // the socket thread's answer, never this thread's env: absent reads as closed
    { ...op.config, imports: op.config.imports === true },
    cbs & CB_RESULT ? (o: MatchOutcome) => call(rid, 'result', o) as Promise<PersistOutcome | void> : undefined,
    cbs & CB_ACTIVE ? (uid: string) => emit({ k: 'lock', rid, uid, on: true }) : undefined,
    cbs & CB_INACTIVE ? (uid: string) => emit({ k: 'lock', rid, uid, on: false }) : undefined,
    cbs & CB_DODGE ? (d: DodgeReport) => call(rid, 'dodge', d) as Promise<DodgeVerdict[] | void> : undefined,
    cbs & CB_BEHAVIOUR ? (b) => emit({ k: 'behaviour', rid, b }) : undefined,
  );
  room.group = op.group;
  rooms.set(rid, { room, code: op.code, ack: 0, uids: new Set(), last: '', calls: 0, disposing: false });
  dirty.add(rid);
}

function reply(id: number, value: unknown): void {
  emit({ k: 'reply', call: id, value });
}

// ---- ops ----------------------------------------------------------------------

function handle(op: Op): void {
  switch (op.k) {
    case 'create':
      create(op);
      return;
    case 'backlog':
      if (op.bytes > 0) backlogs.set(op.sock, op.bytes);
      else backlogs.delete(op.sock);
      return;
    case 'reply':
      settleCall(op.call, op.value, op.error);
      return;
    case 'perfReset':
      lag.reset();
      return;
    case 'dispose': {
      const e = rooms.get(op.rid);
      if (!e) return;
      rooms.delete(op.rid);
      e.disposing = true;
      disposing.set(op.rid, e);
      if (e.calls === 0) finishDispose(op.rid);
      return;
    }
    case 'detach':
      // the stamp is looked up whether or not the room still exists, so the map cannot leak
      {
        const conn = op.sock ? (connOf.get(op.sock) ?? 0) : 0;
        if (op.sock) {
          connOf.delete(op.sock);
          backlogs.delete(op.sock);
        }
        const e = rooms.get(op.rid);
        if (!e) return;
        e.room.detach(op.id, conn, op.clean);
        dirty.add(op.rid);
      }
      return;
  }
  const e = rooms.get(op.rid);
  if (!e) {
    // a request must always be answered, or the socket thread awaits it forever
    if ('call' in op) reply(op.call, null);
    return;
  }
  const r = e.room;
  switch (op.k) {
    case 'group':
      r.group = op.group;
      break;
    case 'add': {
      e.ack = op.seq;
      const c = makeClient(op.rid, op.sock, op.client);
      r.add(c);
      if (c.conn !== undefined) connOf.set(op.sock, c.conn);
      if (c.userId) e.uids.add(c.userId);
      break;
    }
    case 'spec':
      e.ack = op.seq;
      r.addSpectator(makeClient(op.rid, op.sock, op.client));
      break;
    case 'hide':
      r.hideSpectator(op.id);
      break;
    case 'reattach': {
      e.ack = op.seq;
      const s = senders(op.rid, op.sock);
      const nc = r.reattach(op.id, s.send, s.sendRaw, s.backlog, op.token, op.trusted, op.caps);
      if (nc !== null) connOf.set(op.sock, nc);
      reply(op.call, nc !== null);
      break;
    }
    case 'msg':
      // the socket thread's key for the socket this arrived on, as the room's own `conn` stamp
      r.onMessage(op.id, op.msg, op.sock ? connOf.get(op.sock) : undefined);
      // an input is 60 Hz per driver and moves nothing the socket thread mirrors
      if (op.msg.t === 'input') return;
      break;
    case 'pending':
      e.ack = op.seq;
      r.applyPending(op.p);
      reply(op.call, true);
      break;
    case 'maybeStart':
      r.maybeStartRanked();
      break;
    case 'abandon':
      r.abandonSlot(op.id, op.token);
      break;
    case 'closeIdle':
      r.closeIdleLobby(op.message);
      break;
    case 'unlock':
      r.releaseSeatLock(op.uid);
      break;
    case 'report':
      reply(op.call, r.resolveReport(op.id, op.robotId));
      return;
    case 'scoreReport':
      reply(op.call, r.resolveScoreReport(op.id));
      return;
  }
  dirty.add(op.rid);
  schedule();
}

port.on('message', (ops: Op[]) => {
  for (const op of ops) {
    try {
      handle(op);
    } catch (err) {
      console.error(`${tag} op ${op.k} failed:`, err);
      if ('call' in op && op.k !== 'reply') reply(op.call, null);
      if ('rid' in op) dirty.add(op.rid);
    }
  }
  schedule();
});

// ---- the once-a-second sweep ----------------------------------------------------

/**
 * Everything that changes without a broadcast: the live clock and score on the Watch Live card,
 * a grace that lapsed quietly, and the snapshot-spacing samples `/api/perf` sums. Plus this
 * thread's own load, which is the number that says whether the workers are keeping up — the
 * socket thread's `loopLagMs` no longer measures the simulation once rooms live here.
 */
const lag = monitorEventLoopDelay({ resolution: 1 });
lag.enable();
let eluMark = performance.eventLoopUtilization();
const ms = (ns: number): number => Math.round((ns / 1e6) * 100) / 100;
setInterval(() => {
  const gaps: [number, number, number, number][] = [];
  for (const [rid, e] of rooms) {
    dirty.add(rid);
    const g = e.room.snapGapStats(true);
    if (g.n > 0) gaps.push([rid, g.n, g.sumMs, g.maxMs]);
  }
  if (gaps.length) emit({ k: 'gaps', list: gaps });
  const elu = performance.eventLoopUtilization(eluMark);
  eluMark = performance.eventLoopUtilization();
  emit({
    k: 'stats',
    s: {
      rooms: rooms.size,
      lag: { mean: ms(lag.mean), p50: ms(lag.percentile(50)), p99: ms(lag.percentile(99)), max: ms(lag.max) },
      busy: Math.round(elu.utilization * 1000) / 1000,
    },
  });
}, 1000).unref();

// ---- boot ----------------------------------------------------------------------

/* Both physics backends, as the socket thread loads them (server/index.ts): a Room refuses to
   start a match its thread cannot step (`physicsReadyForRoom`), so rooms may be created here
   before this resolves. A thread that cannot load them is no use to anybody — it exits, and
   the socket thread stops giving it rooms. */
Promise.all([initPhysics(), initPhysics3d()])
  .then(() => emit({ k: 'ready' }))
  .catch((err) => {
    console.error(`${tag} failed to init physics:`, err);
    process.exit(1);
  });
