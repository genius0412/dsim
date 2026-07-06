import type { RobotCommand, World } from '../types';
import type { RobotSetup } from '../sim/spawn';
import { Lockstep, INPUT_DELAY } from './lockstep';
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
  private readonly peerHashes = new Map<number, number>();
  private desync = false;
  private waiting: string | null = null;
  private restartCb: ((seed: number) => void) | null = null;

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

    mesh.on('data', (_from, data) => this.onData(data));
    // a peer's channel just opened — resend the local inputs we already
    // produced (early broadcasts to a not-yet-open channel were dropped, and
    // lockstep is sequential, so the peer would otherwise stall on that gap)
    mesh.on('connect', (peerId) => this.backfill(peerId));
    mesh.on('disconnect', (peerId) => {
      const rid = this.peerToRobot[peerId];
      if (rid !== undefined) this.ls.markDisconnected(rid);
    });
    lobby.on('restart', (seed) => this.applyRestart(seed));
  }

  /** GameController subscribes to host-authored restarts (rebuild the world) */
  onRestart(cb: (seed: number) => void): void {
    this.restartCb = cb;
  }

  /** author + transmit local inputs for every tick up to `currentTick + delay`
   * (keeps the pipeline INPUT_DELAY ahead of stepping, no holes) */
  produce(currentTick: number, cmd: RobotCommand): void {
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
    this.compare(world.tick);
    this.ls.prune(world.tick - INPUT_DELAY * 4);
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

  private onData(data: ArrayBuffer | string): void {
    if (typeof data === 'string') {
      const msg = decodeControl(data);
      if (msg.t === 'checksum') {
        this.peerHashes.set(msg.tick, msg.hash);
        this.compare(msg.tick);
      } else if (msg.t === 'restart') {
        this.applyRestart(msg.seed);
      }
      return;
    }
    const pkt = decodeCommandPacket(data);
    for (let i = 0; i < pkt.cmds.length; i++) {
      this.ls.receiveRemote(pkt.robotId, pkt.startTick + i, dequantizeCommand(pkt.cmds[i]));
    }
  }

  private compare(tick: number): void {
    const mine = this.myHashes.get(tick);
    const theirs = this.peerHashes.get(tick);
    if (mine !== undefined && theirs !== undefined && mine !== theirs) this.desync = true;
  }

  private applyRestart(seed: number): void {
    this.seed = seed;
    this.ls = new Lockstep(this.robotIds, this.localRobotId);
    this.inputTick = INPUT_DELAY;
    this.myHashes.clear();
    this.peerHashes.clear();
    this.desync = false;
    this.waiting = null;
    this.restartCb?.(seed);
  }

  private robotName(robotId: number): string {
    return this.setups.find((s) => s.id === robotId)?.spec.name ?? `Robot ${robotId}`;
  }
}
