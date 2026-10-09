/**
 * THE VISUALS RELAY — one `Room`'s memory of its imported robots' pictures and meshes, and the
 * pump that streams them to the viewers that ask (docs/area/netcode.md, VISUALS RELAY).
 *
 * ⚠️ MEMORY ONLY, FOR THE LIFE OF THE ROOM. Nothing here is written to a database, a replay row
 * or a disk: a custom room's replay carries a robot's footprint (`RobotSpec.imported`) and nothing
 * of what it looks like, so the bytes cannot outlive the room that held them. `dispose()` frees
 * them, and so does the owner leaving, picking another robot, or the room closing.
 *
 * ⚠️ IT LIVES IN THE ROOM, NOT ON THE SOCKET THREAD, so on a worker room (`SIM_WORKERS`) the bytes,
 * the base64, the GLB validation and the stream timer all run on the worker. The socket thread
 * only writes the frames it would write anyway; the 0.3%-busy-per-client ceiling it already has
 * (docs/area/netcode.md, ROOMS CAN RUN ON WORKER THREADS) is the thing this must not move. The
 * bytes cross the thread boundary twice (the owner's frames in, a viewer's frames out) as the
 * strings the worker's `out()` already batches. And it has to be in the room, because the room
 * is what knows who is seated, which robot each seat holds, and when a seat leaves.
 *
 * Browser-safe (the LAN tab host runs this `Room` in a Worker): no `node:` imports.
 */
import type { Client } from './room';
import type { ClientMsg, ServerMsg } from '../src/net/protocol';
import {
  VISUAL_CHUNK_CHARS,
  VISUAL_ID_RX,
  VISUAL_MAX_BYTES,
  VISUAL_PROCESS_BYTES,
  VISUAL_PUT_STALE_MS,
  VISUAL_REFUSAL_COPY,
  VISUAL_ROOM_BYTES,
  VISUAL_SERVE_CLIENT_BYTES,
  VISUAL_SERVE_ROOM_BYTES,
  VISUAL_SERVE_WINDOW_MS,
  VISUAL_SOURCE_BYTES,
  VISUAL_STREAMS_PER_CLIENT,
  VISUAL_STREAM_TICK_MS,
  VISUAL_SWEEP_EVERY_MS,
  base64ToBytes,
  bytesToBase64,
  hasVisualsCap,
  isVisualKind,
  streamMayWrite,
  visualFrames,
  visualSpan,
  type VisualKind,
  type VisualRefusal,
} from '../src/net/importVisuals';
import { validateVisual } from '../src/net/visualCheck';

// ---- the per-process budget ---------------------------------------------------------------------

/**
 * ⚠️ THE 64 MiB IS PER PROCESS, NOT PER THREAD. A room on a worker is a different JS heap from
 * the socket thread's, so a plain counter in this module would be one budget per thread and the
 * machine could hold 64 MiB × (workers + 1). So the socket thread makes one `SharedArrayBuffer`
 * of per-thread counters (`makeSharedVisualBudget`), hands it to each worker (`workerData`), and
 * a thread's reservation goes in ITS slot: the total is the sum, and a worker that dies has its
 * slot zeroed by the thread that respawns it, so a crash cannot leak budget for the life of the
 * process. The check-then-add is not atomic across threads; two rooms racing may overshoot by
 * one asset each, which is slack, not a leak.
 *
 * ⚠️ AND NO ONE SOURCE MAY HOLD IT ALL (`VISUAL_SOURCE_BYTES`). Without a per-source cap, about 52
 * sockets with imported robots held the whole 64 MiB and every later upload on the machine was
 * refused. A source is an account, else an address (`Client.budgetKey`, hashed at the door), and
 * its bytes are counted in `VISUAL_SOURCE_BUCKETS` buckets per thread in the same buffer (row
 * `slot` after the totals), summed across threads like the total and zeroed with the slot. Two
 * sources that hash to one bucket share a cap: rare, and only ever a refusal, never a leak.
 */
export const VISUAL_BUDGET_SLOTS = 65;
export const VISUAL_SOURCE_BUCKETS = 256;
/** Int32 cells: the per-thread totals, then one row of source buckets per thread */
const BUDGET_CELLS = VISUAL_BUDGET_SLOTS * (1 + VISUAL_SOURCE_BUCKETS);

let cells: Int32Array<ArrayBufferLike> = new Int32Array(new ArrayBuffer(4 * BUDGET_CELLS));
let mySlot = 0;

const bucketCell = (slot: number, bucket: number): number => VISUAL_BUDGET_SLOTS + slot * VISUAL_SOURCE_BUCKETS + bucket;
const bucketOf = (key: number): number => (key >>> 0) % VISUAL_SOURCE_BUCKETS;

/**
 * A source's budget key: FNV-1a over `u:<account>` or `ip:<address>`, as an unsigned 32-bit
 * number. Only this hash crosses into a room (and onto a worker), never the address.
 */
export function visualSourceKey(source: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    h ^= source.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** one SharedArrayBuffer for the whole process, or undefined where the platform has none */
export function makeSharedVisualBudget(): SharedArrayBuffer | undefined {
  return typeof SharedArrayBuffer === 'undefined' ? undefined : new SharedArrayBuffer(4 * BUDGET_CELLS);
}

/** point this thread at the process's counters, and say which slot is its own. A buffer too
 *  small to hold the source rows (a caller that wants a private counter) gets a private one. */
export function configureVisualBudget(buf: SharedArrayBuffer | ArrayBuffer | undefined, slot: number): void {
  if (!buf || slot < 0 || slot >= VISUAL_BUDGET_SLOTS) return;
  cells = new Int32Array(buf.byteLength >= 4 * BUDGET_CELLS ? buf : new ArrayBuffer(4 * BUDGET_CELLS));
  mySlot = slot;
}

/** a thread died: its rooms are gone with it, so its bytes are too (its total and its sources) */
export function resetVisualSlot(buf: SharedArrayBuffer | undefined, slot: number): void {
  if (!buf || slot < 0 || slot >= VISUAL_BUDGET_SLOTS) return;
  const c = new Int32Array(buf);
  Atomics.store(c, slot, 0);
  if (c.length >= BUDGET_CELLS) for (let b = 0; b < VISUAL_SOURCE_BUCKETS; b++) Atomics.store(c, bucketCell(slot, b), 0);
}

/** bytes in use across the process, as this thread sees it */
export function visualBytesInUse(): number {
  let n = 0;
  for (let i = 0; i < VISUAL_BUDGET_SLOTS; i++) n += Atomics.load(cells, i);
  return n;
}

/** bytes one source holds across the process */
export function visualSourceBytesInUse(key: number): number {
  const b = bucketOf(key);
  let n = 0;
  for (let s = 0; s < VISUAL_BUDGET_SLOTS; s++) n += Atomics.load(cells, bucketCell(s, b));
  return n;
}

export interface VisualBudget {
  /** `key`: the source paying (`visualSourceKey`) */
  reserve(bytes: number, key: number): boolean;
  release(bytes: number, key: number): void;
}

/** the process budget (`limit` and `perSource` are for tests) */
export function processVisualBudget(limit = VISUAL_PROCESS_BYTES, perSource = VISUAL_SOURCE_BYTES): VisualBudget {
  return {
    reserve(bytes, key) {
      if (visualBytesInUse() + bytes > limit) return false;
      if (visualSourceBytesInUse(key) + bytes > perSource) return false;
      Atomics.add(cells, mySlot, bytes);
      Atomics.add(cells, bucketCell(mySlot, bucketOf(key)), bytes);
      return true;
    },
    release(bytes, key) {
      Atomics.add(cells, mySlot, -bytes);
      Atomics.add(cells, bucketCell(mySlot, bucketOf(key)), -bytes);
    },
  };
}

/** a budget of its own, for a check that must not touch the process's */
export function localVisualBudget(limit: number, perSource = Infinity): VisualBudget & { used(): number; usedBy(key: number): number } {
  let used = 0;
  const by = new Map<number, number>();
  return {
    reserve(bytes, key) {
      if (used + bytes > limit || (by.get(key) ?? 0) + bytes > perSource) return false;
      used += bytes;
      by.set(key, (by.get(key) ?? 0) + bytes);
      return true;
    },
    release(bytes, key) {
      used -= bytes;
      by.set(key, (by.get(key) ?? 0) - bytes);
    },
    used: () => used,
    usedBy: (key) => by.get(key) ?? 0,
  };
}

/** a client's budget key: the door's hash of its account or address, else its client id's */
export const budgetKeyOf = (c: Pick<Client, 'id' | 'budgetKey'>): number =>
  typeof c.budgetKey === 'number' && Number.isFinite(c.budgetKey) ? c.budgetKey >>> 0 : visualSourceKey(`c:${c.id}`);

/**
 * Bytes charged inside the last `VISUAL_SERVE_WINDOW_MS`. The serve caps are RATES: a total over
 * the room's life (as they were) ran out after about nine viewer sessions in a busy room, and
 * then no newcomer ever saw a robot's look again.
 */
class RollingBytes {
  private readonly q: { at: number; bytes: number }[] = [];
  private sum = 0;
  total(now: number): number {
    while (this.q.length && now - this.q[0].at >= VISUAL_SERVE_WINDOW_MS) this.sum -= this.q.shift()!.bytes;
    return this.sum;
  }
  charge(now: number, bytes: number): void {
    this.q.push({ at: now, bytes });
    this.sum += bytes;
  }
}

// ---- the relay ------------------------------------------------------------------------------------

/** what a relay needs to know about its room */
export interface RelayHost {
  /** may an imported robot play here at all? (`Room.allowsImportedRobots`) */
  allows(): boolean;
  /** a seat or a watcher, by client id */
  find(id: string): Client | undefined;
  /** the robot id (`spec.imported.id`) a SEAT holds right now, if it holds an imported robot */
  importId(id: string): string | undefined;
  /** every seat and every watcher: who is told an asset is ready */
  recipients(): Iterable<Client>;
  /** a match is being played, so a viewer's stream is held to a slower pace */
  live(): boolean;
}

interface Asset {
  id: string;
  kind: VisualKind;
  total: number;
  /** the source its reservation was charged to (`budgetKeyOf` the owner) */
  key: number;
  buf: Uint8Array;
  got: number;
  /** the next `seq` expected while the upload is open */
  next: number;
  ready: boolean;
  touched: number;
}
interface Owner {
  /** the robot id this owner's assets are for */
  id: string;
  /** the READY assets, the ones served */
  top?: Asset;
  mesh?: Asset;
  /**
   * An upload in progress, per kind. ⚠️ IT IS NOT THE READY ONE: a re-upload (a reconnect sends the
   * look again) used to replace the ready asset at its first frame, so a junk or interrupted one left
   * the viewers with nothing where they had a good look. The ready one is served until the new one
   * VALIDATES, and only then replaced.
   */
  up?: Partial<Record<VisualKind, Asset>>;
}
interface Stream {
  owner: string;
  asset: Asset;
  seq: number;
}
interface Outbox {
  list: Stream[];
  lastAt: number;
}

type Raw = Record<string, unknown>;

export class VisualRelay {
  private readonly owners = new Map<string, Owner>();
  private reserved = 0;
  private readonly streams = new Map<string, Outbox>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** sweeps half-sent uploads while any is open (`sweepStale`) */
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Bytes this room has been asked to send in the last minute, per viewer SOURCE and in all (a
   * request is charged in full). Per source, not per client id: a watcher that leaves and comes
   * back is a new client id with the same account or address.
   */
  private readonly served = new Map<number, RollingBytes>();
  private readonly servedRoom = new RollingBytes();
  private disposed = false;

  constructor(
    private readonly host: RelayHost,
    private readonly budget: VisualBudget = processVisualBudget(),
    /** the relay's clock (a check moves it) */
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /** `visualPut` / `visualGet` from a seat or a watcher. A client without the capability is
   *  ignored, and is never answered: it cannot have meant to send either. */
  onMessage(id: string, msg: ClientMsg): void {
    if (this.disposed) return;
    const c = this.host.find(id);
    if (!c || !hasVisualsCap(c.caps)) return;
    if (msg.t === 'visualPut') this.put(c, msg as unknown as Raw);
    else if (msg.t === 'visualGet') this.get(c, msg as unknown as Raw);
  }

  // ---- the owner's upload ----------------------------------------------------------------

  private put(c: Client, raw: Raw): void {
    const kind = raw.kind;
    if (!isVisualKind(kind)) return;
    const id = typeof raw.id === 'string' && VISUAL_ID_RX.test(raw.id) ? raw.id : '';
    const refuse = (reason: VisualRefusal): void =>
      c.send({ t: 'visualRefused', op: 'put', owner: c.id, id, kind, reason, message: VISUAL_REFUSAL_COPY[reason] });
    if (!this.host.allows()) return refuse('room');
    const cur = this.host.importId(c.id);
    if (!cur || cur !== id) return refuse('id');
    const total = raw.total;
    const seq = raw.seq;
    if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 1 || total > VISUAL_MAX_BYTES[kind]) return refuse('size');
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0 || seq >= visualFrames(total)) return refuse('seq');
    const now = this.clock();
    this.sweep(now);
    const held = this.owners.get(c.id);
    if (held && held.id !== cur) this.freeOwner(c.id);

    if (seq === 0) {
      // a new upload of this kind replaces one still on its way; a READY one is kept, and served,
      // until this one validates (`Owner.up`)
      this.freeUpload(c.id, kind);
      for (const [other, o] of this.owners) if (other !== c.id && o.id === id) return refuse('dup');
      const key = budgetKeyOf(c);
      // the room's cap counts what the room will hold once this replaces the ready one, so a re-upload
      // is not refused for the asset it replaces; while it travels the room holds both (one asset over)
      const replaces = this.owners.get(c.id)?.[kind]?.total ?? 0;
      if (this.reserved - replaces + total > VISUAL_ROOM_BYTES || !this.budget.reserve(total, key)) return refuse('budget');
      this.reserved += total;
      let o = this.owners.get(c.id);
      if (!o) this.owners.set(c.id, (o = { id }));
      (o.up ??= {})[kind] = { id, kind, total, key, buf: new Uint8Array(total), got: 0, next: 0, ready: false, touched: now };
      this.ensureSweep();
    }
    const o = this.owners.get(c.id);
    const a = o?.up?.[kind];
    // a chunk after the asset completed (a duplicate frame) is not worth losing a good asset over
    if (!a && o?.[kind]?.ready && seq > 0) return;
    if (!o || !a || a.id !== id || a.total !== total || a.next !== seq) {
      this.freeUpload(c.id, kind);
      return refuse('seq');
    }
    const data = raw.data;
    const bytes = typeof data === 'string' && data.length <= VISUAL_CHUNK_CHARS ? base64ToBytes(data) : null;
    const span = visualSpan(total, seq);
    if (!bytes || bytes.length !== span.end - span.start) {
      this.freeUpload(c.id, kind);
      return refuse('size');
    }
    a.buf.set(bytes, span.start);
    a.got += bytes.length;
    a.next++;
    a.touched = now;
    if (a.got < total) return;
    if (validateVisual(kind, a.buf)) {
      // junk: refused, and the last good look stays
      this.freeUpload(c.id, kind);
      return refuse('format');
    }
    // it validated: now it replaces the last good one (whose streams end with it)
    delete o.up![kind];
    this.freeAsset(c.id, kind);
    a.ready = true;
    o[kind] = a;
    this.owners.set(c.id, o);
    this.announce(c.id, a);
  }

  /** tell everyone who takes part (the owner included) that `a` can be asked for */
  private announce(owner: string, a: Asset): void {
    const msg: ServerMsg = { t: 'visualReady', owner, id: a.id, kind: a.kind, bytes: a.total };
    let raw: string | null = null;
    for (const r of this.host.recipients()) {
      if (!hasVisualsCap(r.caps)) continue;
      if (r.sendRaw) r.sendRaw((raw ??= JSON.stringify(msg)));
      else r.send(msg);
    }
  }

  /** a client has just attached (joined, spectated, reclaimed a seat): say what is ready */
  greet(c: Client): void {
    if (this.disposed || !hasVisualsCap(c.caps) || !this.host.allows()) return;
    for (const [owner, o] of this.owners) {
      for (const kind of ['top', 'mesh'] as const) {
        const a = o[kind];
        if (a?.ready) c.send({ t: 'visualReady', owner, id: a.id, kind, bytes: a.total });
      }
    }
  }

  // ---- a viewer's download ---------------------------------------------------------------

  private get(c: Client, raw: Raw): void {
    const kind = raw.kind;
    if (!isVisualKind(kind)) return;
    const id = typeof raw.id === 'string' && VISUAL_ID_RX.test(raw.id) ? raw.id : '';
    const owner = typeof raw.owner === 'string' && raw.owner.length <= 64 ? raw.owner : '';
    const refuse = (reason: VisualRefusal): void =>
      c.send({ t: 'visualRefused', op: 'get', owner, id, kind, reason, message: VISUAL_REFUSAL_COPY[reason] });
    if (!this.host.allows()) return refuse('room');
    const o = this.owners.get(owner);
    const a = o?.[kind];
    if (!o || !a || !a.ready || o.id !== id || owner === c.id || this.host.importId(owner) !== id) return refuse('none');
    const box = this.streams.get(c.id);
    if (box?.list.some((s) => s.owner === owner && s.asset === a)) return; // already on its way
    if ((box?.list.length ?? 0) >= VISUAL_STREAMS_PER_CLIENT) return refuse('busy');
    const now = this.clock();
    const key = budgetKeyOf(c);
    let mine = this.served.get(key);
    if (!mine) this.served.set(key, (mine = new RollingBytes()));
    if (mine.total(now) + a.total > VISUAL_SERVE_CLIENT_BYTES || this.servedRoom.total(now) + a.total > VISUAL_SERVE_ROOM_BYTES) return refuse('busy');
    mine.charge(now, a.total);
    this.servedRoom.charge(now, a.total);
    // forget the windows that have emptied (a busy room meets many viewers)
    for (const [k, w] of this.served) if (w !== mine && w.total(now) === 0) this.served.delete(k);
    const out = box ?? { list: [], lastAt: 0 };
    out.list.push({ owner, asset: a, seq: 0 });
    this.streams.set(c.id, out);
    this.ensureTimer();
  }

  /** run the stale-upload sweep on a timer while an upload is open, so a stalled one is freed
   *  even when nobody else uploads in this room */
  private ensureSweep(): void {
    if (this.sweepTimer || this.disposed) return;
    this.sweepTimer = setInterval(() => this.sweepStale(), VISUAL_SWEEP_EVERY_MS);
    (this.sweepTimer as { unref?: () => void }).unref?.();
  }

  /** the timer's work: drop uploads gone quiet, and stop when none is open */
  sweepStale(now = this.clock()): void {
    this.sweep(now);
    let open = false;
    for (const o of this.owners.values()) if (o.up?.top || o.up?.mesh) open = true;
    if (!open && this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.pump(), VISUAL_STREAM_TICK_MS);
    // a timer must never be what keeps a process (or a test) alive
    (this.timer as { unref?: () => void }).unref?.();
  }

  private live(s: Stream): boolean {
    const o = this.owners.get(s.owner);
    return !!o && o[s.asset.kind] === s.asset && s.asset.ready;
  }

  /** one chunk per viewer per pump, paced by the socket's own backlog (`streamMayWrite`) */
  private pump(): void {
    const now = this.clock();
    const liveMatch = this.host.live();
    const allowed = this.host.allows();
    for (const [rid, box] of this.streams) {
      const c = this.host.find(rid);
      if (!c || !allowed) {
        this.streams.delete(rid);
        continue;
      }
      for (let i = box.list.length - 1; i >= 0; i--) if (!this.live(box.list[i])) box.list.splice(i, 1);
      if (!box.list.length) {
        this.streams.delete(rid);
        continue;
      }
      // a held seat (its socket dropped inside the reconnect grace) waits for its new one
      if (c.connected === false) continue;
      if (!streamMayWrite({ backlog: c.backlog ? c.backlog() : undefined, now, lastAt: box.lastAt, live: liveMatch })) continue;
      const s = box.list[0];
      const a = s.asset;
      const span = visualSpan(a.total, s.seq);
      const msg: ServerMsg = {
        t: 'visualChunk',
        owner: s.owner,
        id: a.id,
        kind: a.kind,
        total: a.total,
        seq: s.seq,
        data: bytesToBase64(a.buf, span.start, span.end),
      };
      if (c.sendRaw) c.sendRaw(JSON.stringify(msg));
      else c.send(msg);
      box.lastAt = now;
      s.seq++;
      box.list.shift();
      if (s.seq < visualFrames(a.total)) box.list.push(s); // round-robin across this viewer's streams
      if (!box.list.length) this.streams.delete(rid);
    }
    if (!this.streams.size && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ---- freeing -----------------------------------------------------------------------------

  /** an owner with nothing ready and nothing on its way is forgotten */
  private tidy(owner: string, o: Owner): void {
    if (!o.top && !o.mesh && !o.up?.top && !o.up?.mesh) this.owners.delete(owner);
  }

  /** free the READY asset of a kind */
  private freeAsset(owner: string, kind: VisualKind): void {
    const o = this.owners.get(owner);
    const a = o?.[kind];
    if (!o || !a) return;
    delete o[kind];
    this.reserved -= a.total;
    this.budget.release(a.total, a.key);
    this.tidy(owner, o);
  }

  /** free the upload of a kind still on its way (the ready one, if any, stays) */
  private freeUpload(owner: string, kind: VisualKind): void {
    const o = this.owners.get(owner);
    const a = o?.up?.[kind];
    if (!o || !a) return;
    delete o.up![kind];
    this.reserved -= a.total;
    this.budget.release(a.total, a.key);
    this.tidy(owner, o);
  }

  /** the owner has left, or a seat's robot is no longer the one its assets were for */
  freeOwner(owner: string): void {
    this.freeUpload(owner, 'top');
    this.freeUpload(owner, 'mesh');
    this.freeAsset(owner, 'top');
    this.freeAsset(owner, 'mesh');
  }

  /** a seat's spec changed: its assets stay only while it holds the robot they are for */
  specChanged(seat: string): void {
    const o = this.owners.get(seat);
    if (o && this.host.importId(seat) !== o.id) this.freeOwner(seat);
  }

  /** every seat, after a change that may have stripped imports (`Room.beginMatch`) */
  reconcile(): void {
    for (const seat of [...this.owners.keys()]) this.specChanged(seat);
  }

  /** a viewer is gone: its streams go with it. Its serve window does NOT: it belongs to its
   *  source, and a source that leaves and comes back is the same source. */
  dropRecipient(id: string): void {
    this.streams.delete(id);
  }

  /** an upload that went quiet is not worth the bytes it reserved (the ready look, if any, stays) */
  private sweep(now: number): void {
    for (const [owner, o] of this.owners) {
      for (const kind of ['top', 'mesh'] as const) {
        const a = o.up?.[kind];
        if (a && now - a.touched > VISUAL_PUT_STALE_MS) this.freeUpload(owner, kind);
      }
    }
  }

  /** the room is closing: give everything back */
  dispose(): void {
    this.disposed = true;
    for (const owner of [...this.owners.keys()]) this.freeOwner(owner);
    this.streams.clear();
    this.served.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** what this relay holds, for a check */
  stats(): { reserved: number; owners: number; streams: number; ready: number; servedRoom: number; sweeping: boolean } {
    let ready = 0;
    for (const o of this.owners.values()) for (const k of ['top', 'mesh'] as const) if (o[k]?.ready) ready++;
    return {
      reserved: this.reserved,
      owners: this.owners.size,
      streams: this.streams.size,
      ready,
      servedRoom: this.servedRoom.total(this.clock()),
      sweeping: this.sweepTimer !== null,
    };
  }
}
