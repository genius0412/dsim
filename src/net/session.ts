import type { RobotCommand, World } from '../types';
import type { RobotSetup } from '../sim/spawn';
import { Lockstep, INPUT_DELAY, CHECKSUM_INTERVAL } from './lockstep';
import { worldHash } from './checksum';
import {
  quantizeCommand,
  dequantizeCommand,
  encodeCommandPacket,
  decodeCommandPacket,
  encodeControl,
  decodeControl,
} from './protocol';
import type { RtcMesh } from './mesh';
import type { SupabaseLobby, StartMsg } from './lobby';

/**
 * A running lockstep match: ties the WebRTC mesh (transport) to the Lockstep
 * buffer (timing) and the host's control authority (seed / restart). The
 * GameController consumes ONLY this object — when it is null the solo path is
 * bit-identical to before.
 *
 * Per frame the controller calls `produce(uptoTick, cmd)` to author + transmit
 * its local input for every tick up to `world.tick + delay`, then drains sim
 * steps while `canStep(tick)` holds, feeding `commandsForTick(tick)` to step().
 * Every CHECKSUM_INTERVAL ticks it calls `checkpoint(world)` to exchange and
 * compare production hashes (mismatch ⇒ desync flag ⇒ DESYNC banner).
 */
export interface NetStatus {
  /** name of the robot a stall is waiting on, or null if not stalled */
  waitingFor: string | null;
  desync: boolean;
  peers: number;
}

export class NetSession {
  readonly localRobotId: number;
  readonly setups: RobotSetup[];
  seed: number;

  private ls: Lockstep;
  private inputTick = INPUT_DELAY;
  private readonly robotIds: number[];
  private readonly peerToRobot: Record<string, number>;
  private readonly myHashes = new Map<number, number>();
  /** peerId -> (tick -> hash). PER-PEER: a single shared tick->hash slot let a
   * matching peer's checksum OVERWRITE (and mask) a diverging peer's whenever
   * >2 clients shared the room, so real desyncs went undetected. Keyed by peer
   * so a mismatch with ANY peer is caught. */
  private readonly peerHashes = new Map<string, Map<number, number>>();
  private desync = false;
  private waiting: string | null = null;
  private restartCb: ((seed: number) => void) | null = null;
  /** peers we've received at least one command packet from (⇒ they're ready) */
  private readonly heard = new Set<string>();
  private resendCounter = 0;
  /** robots already scheduled to drop (avoid re-authoring / re-applying a bye) */
  private readonly dropped = new Set<number>();
  /** most recent sim tick fed to produce() — a floor for a drop tick */
  private lastProduceTick = 0;
  /** throttles the WAITING diagnostic log */
  private stallLog = 0;

  constructor(
    private readonly mesh: RtcMesh,
    private readonly lobby: SupabaseLobby,
    start: StartMsg,
    localPeerId: string,
  ) {
    this.setups = start.setups as RobotSetup[];
    this.seed = start.seed;
    this.robotIds = this.setups.map((s) => s.id);
    this.peerToRobot = start.assign;
    this.localRobotId = start.assign[localPeerId];
    this.ls = new Lockstep(this.robotIds, this.localRobotId);

    mesh.on('data', (from, data) => this.onData(from, data));
    // a peer's channel just opened — resend the local inputs we already
    // produced (early broadcasts to a not-yet-open channel were dropped, and
    // lockstep is sequential, so the peer would otherwise stall on that gap)
    mesh.on('connect', (peerId) => this.backfill(peerId));
    // a peer dropping (clean close, or a failed/timed-out link) must degrade the
    // sim IDENTICALLY on every client. So the HOST authors a single drop tick and
    // broadcasts it; nobody substitutes ZERO on their own wall-clock schedule.
    mesh.on('disconnect', (peerId) => this.onPeerGone(peerId));
    mesh.on('failed', (peerId) => this.onPeerGone(peerId));
    lobby.on('restart', (seed) => this.applyRestart(seed));
  }

  /** GameController subscribes to host-authored restarts (rebuild the world) */
  onRestart(cb: (seed: number) => void): void {
    this.restartCb = cb;
  }

  /** author + transmit local inputs for every tick up to `currentTick + delay`
   * (keeps the pipeline INPUT_DELAY ahead of stepping, no holes) */
  produce(currentTick: number, cmd: RobotCommand): void {
    this.lastProduceTick = currentTick;
    // STARTUP SELF-HEAL: until a connected peer sends us its first packet, keep
    // resending our full history to it (~every 6 frames). Early sends can be
    // lost to channel-open / handler-registration races that the reliable
    // channel can't recover on its own; once the peer replies we stop.
    if (this.resendCounter++ % 6 === 0) {
      for (const peer of this.mesh.connectedPeers()) {
        if (!this.heard.has(peer)) this.backfill(peer);
      }
    }

    const uptoTick = currentTick + INPUT_DELAY;
    if (this.inputTick > uptoTick) return;
    const q = quantizeCommand(cmd);
    const start = this.inputTick;
    const local = dequantizeCommand(q);
    const cmds = [];
    while (this.inputTick <= uptoTick) {
      this.ls.setLocal(this.inputTick, local);
      cmds.push(q);
      this.inputTick++;
    }
    this.mesh.broadcast(encodeCommandPacket(this.localRobotId, start, cmds));
  }

  /** does this client hold restart/seed authority? */
  isHost(): boolean {
    return this.lobby.isHost();
  }

  /** resend all local inputs produced so far to a freshly-connected peer */
  private backfill(peerId: string): void {
    const hist = this.ls.localHistory();
    if (!hist.cmds.length) return;
    const q = hist.cmds.map(quantizeCommand);
    this.mesh.sendTo(peerId, encodeCommandPacket(this.localRobotId, hist.start, q));
  }

  canStep(tick: number): boolean {
    const ok = this.ls.canStep(tick);
    if (!ok) {
      const rid = this.ls.missingAt(tick);
      this.waiting = rid === null ? null : this.robotName(rid);
      // throttled diagnostic: what are we blocked on, and is the transport alive?
      if (this.stallLog++ % 120 === 0) {
        const peerRid = (p: string): number => this.peerToRobot[p];
        console.warn(
          `[net] WAITING tick ${tick} on robot ${rid} (${this.waiting}) | myRobot=${this.localRobotId}` +
            ` | meshPeers=[${this.mesh.connectedPeers().map((p) => `${p.slice(0, 6)}→r${peerRid(p)}`).join(',')}]` +
            ` | heard=[${[...this.heard].map((p) => p.slice(0, 6)).join(',')}]`,
        );
      }
    } else {
      this.waiting = null;
    }
    return ok;
  }

  commandsForTick(tick: number): Map<number, RobotCommand> {
    return this.ls.commandsForTick(tick);
  }

  /** exchange + compare a production checksum at a checksum tick */
  checkpoint(world: World): void {
    if (!Lockstep.isChecksumTick(world.tick)) return;
    const hash = worldHash(world);
    this.myHashes.set(world.tick, hash);
    this.mesh.broadcast(encodeControl({ t: 'checksum', tick: world.tick, hash }));
    this.compareAt(world.tick);
    this.ls.prune(world.tick - INPUT_DELAY * 4);
    // hashes are only useful around the exchange window; drop stale ones so the
    // maps don't grow unbounded over a long match
    this.pruneHashes(world.tick - CHECKSUM_INTERVAL * 8);
  }

  status(): NetStatus {
    return { waitingFor: this.waiting, desync: this.desync, peers: this.mesh.connectedPeers().length };
  }

  /** host-only: rebuild everyone with a fresh seed */
  requestRestart(seed: number): void {
    this.lobby.restartMatch(seed);
    this.applyRestart(seed);
  }

  dispose(): void {
    this.mesh.close();
    void this.lobby.leave();
  }

  // -------------------------------------------------------------- internals --

  private onData(from: string, data: ArrayBuffer | string): void {
    if (typeof data === 'string') {
      const msg = decodeControl(data);
      if (msg.t === 'checksum') {
        let hashes = this.peerHashes.get(from);
        if (!hashes) {
          hashes = new Map();
          this.peerHashes.set(from, hashes);
        }
        hashes.set(msg.tick, msg.hash);
        this.compareAt(msg.tick);
      } else if (msg.t === 'restart') {
        this.applyRestart(msg.seed);
      } else if (msg.t === 'bye') {
        this.applyDrop(msg.robotId, msg.tick);
      }
      return;
    }
    const pkt = decodeCommandPacket(data);
    if (!this.heard.has(from)) {
      this.heard.add(from); // this peer is receiving/sending — stop resending to it
      console.info(`[net] first packet from ${from.slice(0, 6)} → robot ${pkt.robotId} @tick ${pkt.startTick}`);
    }
    for (let i = 0; i < pkt.cmds.length; i++) {
      this.ls.receiveRemote(pkt.robotId, pkt.startTick + i, dequantizeCommand(pkt.cmds[i]));
    }
  }

  /** a peer's link ended (clean disconnect or failed/timeout). Only the HOST
   * turns this into a deterministic drop: it picks ONE tick — just past the
   * departing robot's last known input, and never before the current sim
   * frontier — and broadcasts it so every peer (incl. the host) drops the robot
   * at the SAME tick. Non-hosts wait for that bye rather than ZEROing on their
   * own clock (which silently desynced). */
  private onPeerGone(peerId: string): void {
    const rid = this.peerToRobot[peerId];
    if (rid === undefined || rid === this.localRobotId || this.dropped.has(rid)) return;
    if (!this.lobby.isHost()) return; // only the host authors the drop tick
    const dropTick = Math.max(this.ls.lastTickFor(rid) + 1, this.lastProduceTick + INPUT_DELAY);
    this.mesh.broadcast(encodeControl({ t: 'bye', robotId: rid, tick: dropTick }));
    this.applyDrop(rid, dropTick);
  }

  /** schedule a robot to run on ZERO from `tick` onward (idempotent) */
  private applyDrop(robotId: number, tick: number): void {
    if (this.dropped.has(robotId)) return;
    this.dropped.add(robotId);
    this.ls.dropAt(robotId, tick);
    console.info(`[net] robot ${robotId} dropped at tick ${tick}`);
  }

  /** flag a desync if our hash for `tick` disagrees with ANY peer that has
   * reported one. Sticky, and records + logs the FIRST diverging tick so a live
   * test can pinpoint where the sims forked. */
  private compareAt(tick: number): void {
    const mine = this.myHashes.get(tick);
    if (mine === undefined) return;
    for (const [peer, hashes] of this.peerHashes) {
      const theirs = hashes.get(tick);
      if (theirs !== undefined && theirs !== mine && !this.desync) {
        this.desync = true;
        console.warn(
          `[net] DESYNC at tick ${tick}: local=${mine >>> 0} peer ${peer.slice(0, 6)}=${theirs >>> 0}`,
        );
      }
    }
  }

  /** drop hashes older than `before` from both sides (bounded memory) */
  private pruneHashes(before: number): void {
    for (const t of this.myHashes.keys()) if (t < before) this.myHashes.delete(t);
    for (const hashes of this.peerHashes.values()) {
      for (const t of hashes.keys()) if (t < before) hashes.delete(t);
    }
  }

  private applyRestart(seed: number): void {
    this.seed = seed;
    this.ls = new Lockstep(this.robotIds, this.localRobotId);
    this.inputTick = INPUT_DELAY;
    this.myHashes.clear();
    this.peerHashes.clear();
    this.heard.clear(); // re-sync the startup handshake for the new match
    this.dropped.clear(); // a fresh match: previously-dropped robots are back
    this.lastProduceTick = 0;
    this.desync = false;
    this.waiting = null;
    this.restartCb?.(seed);
  }

  private robotName(robotId: number): string {
    return this.setups.find((s) => s.id === robotId)?.spec.name ?? `Robot ${robotId}`;
  }
}
