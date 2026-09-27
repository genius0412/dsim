/**
 * THE WORKER HALF OF `SIM_WORKERS`: the real `Room`s, hosted behind a message port.
 *
 * A `RoomHost` owns every room its worker thread was given and speaks `server/roomWire.ts` to the
 * main thread. It is deliberately THIN — the rooms are the same `server/room.ts` the in-process
 * server runs, driven through the same public methods in the same order; this file only turns
 * main's messages into those calls and the rooms' callbacks back into messages:
 *
 *  - A `Client` arrives as plain data plus a SINK KEY. The host rebuilds its three socket
 *    functions around that key: `send`/`sendRaw` queue the already-encoded string for main to
 *    write (`encodeMsg`, exactly what main's own `send` would have produced, so the bytes on the
 *    socket are unchanged), and `backlog` reads the last value main reported for that socket.
 *  - The persistence callbacks (`onResult`, `onDodge`) become requests main answers after it has
 *    done the DB work, so the room's own `.then` — the record/ELO reveal — runs as it always did.
 *    The lock and behaviour callbacks become fire-and-forget events.
 *  - After anything that can change what main reads synchronously, and every 250 ms regardless,
 *    each room's MIRROR (`RoomMirror`) is rebuilt and posted if it changed.
 *
 * Every outgoing item goes through ONE queue, flushed once per microtask checkpoint: a clock turn
 * is one synchronous callback, so a turn's snapshots for every room leave in a single post.
 */
import { Room, type Client } from './room';
import { encodeMsg } from '../src/net/protocol';
import type { ClientDesc, DodgeVerdict, FromWorker, PersistOutcome, RoomMirror, ToWorker } from './roomWire';

interface Entry {
  id: number;
  room: Room;
  /** sink key → the room's own `conn` for that socket, so main can detach by key */
  keyConn: Map<number, number>;
  /** every account ever seated here, for the mirror's `seats` */
  uids: Set<string>;
  last: string;
  lastAt: number;
}

/** the mirror minus the fields that change every tick — what "changed" is measured on */
const shape = (m: RoomMirror): string => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { ack, tick, snapGap, ...rest } = m;
  return JSON.stringify(rest);
};

export class RoomHost {
  private readonly rooms = new Map<number, Entry>();
  private backlogs = new Map<number, number>();
  private readonly waiting = new Map<number, (v: unknown) => void>();
  private outbox: FromWorker[] = [];
  private flushQueued = false;
  private ack = 0;
  private reqSeq = 0;

  constructor(private readonly post: (batch: FromWorker[]) => void) {}

  /** how many rooms this worker holds (diagnostics) */
  get size(): number {
    return this.rooms.size;
  }

  emit(m: FromWorker): void {
    this.outbox.push(m);
    if (!this.flushQueued) {
      this.flushQueued = true;
      queueMicrotask(() => this.flush());
    }
  }

  private flush(): void {
    this.flushQueued = false;
    if (this.outbox.length === 0) return;
    const b = this.outbox;
    this.outbox = [];
    this.post(b);
  }

  /** a request the room is waiting on; main answers with `reply` */
  private call(m: FromWorker & { req: number }): Promise<unknown> {
    return new Promise((res) => {
      this.waiting.set(m.req, res);
      this.emit(m);
    });
  }

  /** one batch from main, handled in order */
  receive(batch: ToWorker[]): void {
    const touched = new Set<Entry>();
    for (const m of batch) {
      try {
        this.one(m, touched);
      } catch (e) {
        // the same containment the room loop has: one bad message must not take the worker,
        // and every room on it, down with it
        console.error(`[worker] ${m.k} failed:`, e);
      }
      if ('seq' in m) this.ack = m.seq;
    }
    for (const e of touched) if (this.rooms.has(e.id)) this.pushMirror(e, false);
  }

  /** every room's mirror, if it changed (and at least once a second) — the low-rate refresh */
  refreshMirrors(): void {
    for (const e of this.rooms.values()) this.pushMirror(e, false);
  }

  private socketFns(key: number, hasRaw: boolean, hasBacklog: boolean): Pick<Client, 'send' | 'sendRaw' | 'backlog'> {
    return {
      send: (m) => this.emit({ k: 'out', key, s: encodeMsg(m) }),
      sendRaw: hasRaw ? (s) => this.emit({ k: 'out', key, s }) : undefined,
      backlog: hasBacklog ? () => this.backlogs.get(key) ?? 0 : undefined,
    };
  }

  private client(desc: ClientDesc, key: number): Client {
    const { hasRaw, hasBacklog, ...rest } = desc;
    return { ...rest, ...this.socketFns(key, hasRaw, hasBacklog) };
  }

  private mirror(e: Entry): RoomMirror {
    const r = e.room;
    const seats: Record<string, string> = {};
    for (const uid of e.uids) {
      const s = r.seatFor(uid);
      if (s) seats[uid] = s;
    }
    return {
      ack: this.ack,
      config: r.config,
      gameId: r.gameId,
      physics: r.physics,
      staging: r.staging(),
      canJoin: r.canJoin(),
      lobby: r.lobbySummary(),
      abandonable: r.isAbandonable(),
      summary: r.summary(),
      presence: r.presenceSnapshot(),
      holdsCapacity: r.holdsCapacity(),
      spectators: r.spectatorCount(),
      hasWorld: r.hasWorld,
      tick: r.tick,
      seats,
      snapGap: r.snapGapStats(false),
    };
  }

  private pushMirror(e: Entry, force: boolean): RoomMirror {
    const m = this.mirror(e);
    const s = shape(m);
    const now = Date.now();
    if (force || s !== e.last || now - e.lastAt >= 1000) {
      e.last = s;
      e.lastAt = now;
      this.emit({ k: 'mirror', roomId: e.id, m });
    }
    return m;
  }

  private one(m: ToWorker, touched: Set<Entry>): void {
    if (m.k === 'reply') {
      const res = this.waiting.get(m.req);
      this.waiting.delete(m.req);
      res?.(m.value);
      return;
    }
    if (m.k === 'backlog') {
      this.backlogs = new Map(m.vals);
      return;
    }
    if (m.k === 'create') {
      const roomId = m.roomId;
      const room: Room = new Room(
        m.code,
        () => {
          this.rooms.delete(roomId);
          this.emit({ k: 'empty', roomId });
        },
        m.config,
        m.has.result ? (o) => this.call({ k: 'result', roomId, req: ++this.reqSeq, o }) as Promise<PersistOutcome | void> : undefined,
        m.has.active ? (uid) => this.emit({ k: 'active', roomId, uid }) : undefined,
        m.has.inactive ? (uid) => this.emit({ k: 'inactive', roomId, uid }) : undefined,
        m.has.dodge ? (d) => this.call({ k: 'dodge', roomId, req: ++this.reqSeq, d }) as Promise<DodgeVerdict[] | void> : undefined,
        m.has.behaviour ? (b) => this.emit({ k: 'behaviour', roomId, b }) : undefined,
      );
      room.group = m.group;
      const e: Entry = { id: roomId, room, keyConn: new Map(), uids: new Set(), last: '', lastAt: 0 };
      this.rooms.set(roomId, e);
      touched.add(e);
      return;
    }
    const e = this.rooms.get(m.roomId);
    if (!e) {
      // the room emptied (or was disposed) while this was in flight. Anything main is waiting
      // on still gets an answer — a reattach to a room that is gone is a failed reattach.
      if ('req' in m && typeof m.req === 'number') this.emit({ k: 'reply', req: m.req, value: null });
      return;
    }
    const room = e.room;
    switch (m.k) {
      case 'add': {
        const c = this.client(m.client, m.key);
        /**
         * THE CAPACITY CHECK, AGAIN, WHERE IT CANNOT BE STALE. Main asked `canJoin` of a MIRROR,
         * which can be a few milliseconds behind a joiner who was admitted in the meantime —
         * so the room itself has the last word, and a stale mirror can at worst turn into this
         * refusal, never into a second driver past capacity. Same sentences as the door.
         */
        if (!room.canJoin()) {
          const state = room.lobbySummary().state;
          const busy = state === 'match' || state === 'strategy';
          c.send({
            t: 'error',
            ...(busy ? { code: 'in_progress' as const } : {}),
            message: busy ? 'A match is already running in this room. You can join when it finishes.' : 'This room is full.',
          });
          this.emit({ k: 'refused', roomId: e.id, key: m.key });
          touched.add(e);
          return;
        }
        room.add(c);
        if (c.conn !== undefined) e.keyConn.set(m.key, c.conn);
        if (c.userId) e.uids.add(c.userId);
        touched.add(e);
        return;
      }
      case 'spectate':
        room.addSpectator(this.client(m.client, m.key));
        touched.add(e);
        return;
      case 'reattach': {
        const f = this.socketFns(m.key, m.hasRaw, m.hasBacklog);
        const nc = room.reattach(m.id, f.send, f.sendRaw, f.backlog, m.token, m.trusted);
        if (nc !== null) e.keyConn.set(m.key, nc);
        this.emit({ k: 'reply', req: m.req, value: nc !== null });
        touched.add(e);
        return;
      }
      case 'detach': {
        /**
         * The room's own conn for this socket. KEPT after use, not deleted: a socket can be
         * "closed" twice from main's side (a drop, then the superseded socket's late close after a
         * reattach), and the second must still read as STALE. A key the room never gave a conn to
         * (a spectator, a refused add) is -1, which matches no seat; 0 means main had no key at all.
         */
        const conn = m.key === 0 ? undefined : (e.keyConn.get(m.key) ?? -1);
        room.detach(m.id, conn, m.clean);
        touched.add(e);
        return;
      }
      case 'msg':
        room.onMessage(m.id, m.msg);
        // the hot path changes nothing main reads; everything else might (ready, update, start…)
        if (m.msg.t !== 'input' && m.msg.t !== 'ping') touched.add(e);
        return;
      case 'applyPending': {
        room.applyPending(m.pending);
        for (const r of m.pending.roster) if (r.userId) e.uids.add(r.userId);
        // the FRESH mirror rides ahead of the reply, so main's awaited read sees the staged room
        this.pushMirror(e, true);
        this.emit({ k: 'reply', req: m.req, value: true });
        return;
      }
      case 'resolveReport':
        this.emit({ k: 'reply', req: m.req, value: room.resolveReport(m.id, m.robotId) });
        return;
      case 'resolveScoreReport':
        this.emit({ k: 'reply', req: m.req, value: room.resolveScoreReport(m.id) });
        return;
      case 'do':
        if (m.op === 'maybeStartRanked') room.maybeStartRanked();
        else if (m.op === 'releaseSeatLock') room.releaseSeatLock(m.a ?? '');
        else if (m.op === 'abandonSlot') room.abandonSlot(m.a ?? '', m.b);
        else if (m.op === 'hideSpectator') room.hideSpectator(m.a ?? '');
        else if (m.op === 'resetSnapGap') room.snapGapStats(true);
        else if (m.op === 'setGroup') room.group = m.a ?? '';
        touched.add(e);
        return;
      case 'dispose':
        // main gave back a room nobody ever filled (`abandon` in the join path): it holds no
        // client, no spectator and no staged match (`isAbandonable`), so there is nothing to stop
        this.rooms.delete(e.id);
        return;
      case 'testAdvance': {
        const w = room.worldForTest();
        if (m.toPost && w) {
          w.match.phase = 'post';
          w.match.phaseTimeLeft = 0;
          w.match.preCountdown = undefined;
        }
        room.advanceForTest(m.ticks);
        if (this.rooms.has(e.id)) this.pushMirror(e, true);
        this.emit({ k: 'reply', req: m.req, value: true });
        return;
      }
    }
  }
}
