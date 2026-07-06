import * as C from '../src/config';
import { START_POSES } from '../src/config';
import { createWorld, type RobotSetup } from '../src/sim/spawn';
import { step } from '../src/sim/world';
import type { Alliance, Artifact, RobotCommand, World } from '../src/types';
import {
  dequantizeCommand,
  slimWorld,
  ROOM_CAPACITY,
  type BallDelta,
  type ClientMsg,
  type LobbyPlayer,
  type QCommand,
  type ServerMsg,
} from '../src/net/protocol';

const ZERO_CMD: RobotCommand = { driveX: 0, driveY: 0, rotate: 0, intake: false, fire: false };
/** send an authoritative snapshot every N ticks (1 = 60 Hz — remote robots stay
 * smooth; Phase 1 delta-encodes to cut bandwidth) */
const SNAPSHOT_INTERVAL = 1;
/** how many ticks to keep re-applying a robot's last command when its next input
 * hasn't arrived (absorbs jitter without freezing); past this it coasts to ZERO */
const HOLD_TICKS = 15;
/** hold a disconnected driver's slot this long for a reconnect before dropping */
const RECONNECT_GRACE_MS = 15000;

export interface Client {
  id: string;
  send: (m: ServerMsg) => void;
  player: LobbyPlayer;
  /** false while the socket is dropped (within the reconnect grace) */
  connected: boolean;
  /** ms epoch the socket dropped (0 = connected) */
  disconnectAt: number;
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
  private readonly lastInputTick = new Map<number, number>(); // robotId -> newest tick seen
  private readonly ackTick = new Map<string, number>(); // clientId -> newest input tick
  private readonly dropped = new Set<number>();
  private loop: ReturnType<typeof setInterval> | null = null;
  // delta-snapshot state: last-sent balls (id -> JSON) + clients holding a baseline
  private prevBalls = new Map<number, string>();
  private readonly snapPrimed = new Set<string>();

  constructor(
    readonly code: string,
    /** called when the room empties, so the registry can drop it */
    private readonly onEmpty: () => void,
  ) {}

  /** true if a fresh driver can still join (room not full, not mid-match) */
  canJoin(): boolean {
    return this.clients.size < ROOM_CAPACITY && this.world === null;
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
    const now = Date.now();
    for (const c of [...this.clients.values()]) {
      if (c.connected || now - c.disconnectAt <= RECONNECT_GRACE_MS) continue;
      const rid = this.robotOf.get(c.id);
      if (rid !== undefined && !this.dropped.has(rid)) {
        this.dropped.add(rid);
        this.broadcast({ t: 'drop', robotId: rid, tick: (this.world as World).tick });
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
      case 'update':
        Object.assign(c.player, msg.patch);
        this.broadcastRoster();
        break;
      case 'start':
        if (id === this.hostId && this.world === null) this.startMatch();
        break;
      case 'restart':
        if (id === this.hostId) this.startMatch();
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
    const w = this.world;
    // drop inputs for ticks already simulated (arrived too late to matter)
    if (w && tick <= w.tick) return;
    let buf = this.pending.get(rid);
    if (!buf) {
      buf = new Map();
      this.pending.set(rid, buf);
    }
    buf.set(tick, dequantizeCommand(q));
    if (tick > (this.lastInputTick.get(rid) ?? -1)) this.lastInputTick.set(rid, tick);
    if (tick > (this.ackTick.get(id) ?? -1)) this.ackTick.set(id, tick);
  }

  private startMatch(): void {
    // build setups from the current roster; keep start poses distinct per alliance
    const roster = [...this.clients.values()];
    const used: Record<Alliance, Set<number>> = { red: new Set(), blue: new Set() };
    const setups: RobotSetup[] = [];
    this.robotOf.clear();
    roster.forEach((c, i) => {
      let si = c.player.startIndex ?? 0;
      while (used[c.player.alliance].has(si)) si = (si + 1) % START_POSES.length;
      used[c.player.alliance].add(si);
      setups.push({
        id: i,
        alliance: c.player.alliance,
        spec: c.player.spec,
        assists: c.player.assists,
        startIndex: si,
      });
      this.robotOf.set(c.id, i);
    });

    const seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
    const world = createWorld('match', seed, setups);
    world.match.preCountdown = C.PRE_COUNTDOWN; // sim-driven pre→auto, same as the client
    this.world = world;
    this.pending.clear();
    this.held.clear();
    this.lastInputTick.clear();
    this.ackTick.clear();
    this.dropped.clear();
    this.prevBalls.clear();
    this.snapPrimed.clear();

    for (const c of roster) {
      c.send({ t: 'matchStart', seed, setups, yourRobotId: this.robotOf.get(c.id) ?? 0 });
    }
    this.startLoop();
  }

  private startLoop(): void {
    this.stop();
    let last = Date.now();
    let acc = 0;
    this.loop = setInterval(() => {
      this.checkGrace(); // finalize any driver whose reconnect grace has lapsed
      if (this.clients.size === 0) return; // room emptied (loop already stopped)
      const now = Date.now();
      acc += (now - last) / 1000;
      last = now;
      if (acc > 0.25) acc = 0.25; // never fast-forward more than a quarter second
      let n = 0;
      while (acc >= C.SIM_DT && n < 8) {
        const w = this.world as World;
        step(w, C.SIM_DT, this.frameCommands(w.tick + 1));
        acc -= C.SIM_DT;
        n++;
        if (w.tick % SNAPSHOT_INTERVAL === 0) this.broadcastSnapshot();
      }
    }, 1000 * C.SIM_DT);
  }

  /** the command each robot runs at `tick`: its buffered input for that exact
   * tick if present (so the server matches the client's prediction), else its
   * last command for up to HOLD_TICKS (jitter tolerance), else ZERO */
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
      } else if (tick - (this.lastInputTick.get(r.id) ?? -1) <= HOLD_TICKS) {
        frame.set(r.id, this.held.get(r.id) ?? ZERO_CMD); // brief gap: hold last
      } else {
        frame.set(r.id, ZERO_CMD); // stale: coast to a stop
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
    for (const c of this.clients.values()) {
      const primed = this.snapPrimed.has(c.id);
      const balls: BallDelta = { order, upd: primed ? changed : w.balls };
      c.send({
        t: 'snapshot',
        serverTick: w.tick,
        w: slim,
        balls,
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
      ackInputTick: this.ackTick.get(c.id) ?? 0,
    });
    this.snapPrimed.add(c.id);
  }

  private broadcast(m: ServerMsg): void {
    for (const c of this.clients.values()) c.send(m);
  }

  private broadcastRoster(): void {
    const players = [...this.clients.values()].map((c) => c.player);
    this.broadcast({ t: 'roster', players, hostId: this.hostId });
  }
}
