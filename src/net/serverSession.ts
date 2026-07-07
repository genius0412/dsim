import type { Artifact, RobotCommand, RobotSpec } from '../types';
import type { RobotSetup } from '../sim/spawn';
import type { MatchResultInfo, NetSession, NetStatus, Snapshot } from './session';
import type { Transport } from './transport';
import {
  encodeMsg,
  decodeServerMsg,
  quantizeCommand,
  dequantizeCommand,
  unslimWorld,
  type EloDelta,
  type PlayerIntro,
} from './protocol';

/**
 * Client half of the server-authoritative netcode. Constructed AFTER the server
 * sends `matchStart` (so seed/setups/robotId are known), it takes over the
 * transport from the LobbyClient and:
 *   - `sendInput` forwards each tick's quantized command to the server,
 *   - `takeSnapshot` hands the GameController the freshest authoritative world to
 *     reconcile against,
 *   - `matchStart` arriving again (a host restart) fires `onRestart`.
 *
 * A dropped socket flips `waitingFor` to 'server' (the HUD shows reconnecting);
 * prediction means the local robot keeps responding meanwhile.
 */
export class ServerSession implements NetSession {
  readonly localRobotId: number;
  seed: number;
  setups: RobotSetup[];
  ranked: boolean;
  intros: PlayerIntro[];
  /** per-driver overall-ELO change, arrives shortly after matchResult (ranked) */
  eloResults: EloDelta[] = [];

  private snapshot: Snapshot | null = null;
  private matchResult: MatchResultInfo | null = null;
  private restartCb: (() => void) | null = null;
  private connected = true;
  /** other robots in the match (for the HUD "N players" chip) */
  private readonly otherRobots: number;
  /** running ball baseline the delta-encoded snapshots patch (keyed by id) */
  private readonly baseBalls = new Map<number, Artifact>();

  constructor(
    private readonly transport: Transport,
    private readonly host: boolean,
    start: {
      seed: number;
      setups: RobotSetup[];
      yourRobotId: number;
      ranked?: boolean;
      intros?: PlayerIntro[];
    },
    private readonly clientId: string,
    private readonly room: string,
  ) {
    this.seed = start.seed;
    this.setups = start.setups;
    this.ranked = start.ranked ?? false;
    this.intros = start.intros ?? [];
    this.localRobotId = start.yourRobotId;
    this.otherRobots = Math.max(0, start.setups.length - 1);
    // take over routing + reconnection handling from the LobbyClient
    transport.onMessage((d) => this.onMessage(d));
    transport.onDown(() => {
      this.connected = false; // HUD shows "reconnecting"; prediction keeps running
    });
    transport.onReopen(() => {
      // reclaim our in-match slot on the fresh socket; a snapshot resyncs us
      transport.send(encodeMsg({ t: 'rejoin', room: this.room, clientId: this.clientId }));
    });
    transport.onFail(() => {
      this.connected = false; // retries exhausted; user can leave to the menu
    });
  }

  isHost(): boolean {
    return this.host;
  }

  requestRestart(): void {
    if (this.host) this.transport.send(encodeMsg({ t: 'restart' }));
  }

  onRestart(cb: () => void): void {
    this.restartCb = cb;
  }

  sendInput(tick: number, cmd: RobotCommand): void {
    this.transport.send(encodeMsg({ t: 'input', tick, q: quantizeCommand(cmd) }));
  }

  takeSnapshot(): Snapshot | null {
    const s = this.snapshot;
    this.snapshot = null;
    return s;
  }

  getMatchResult(): MatchResultInfo | null {
    return this.matchResult;
  }

  status(): NetStatus {
    return {
      waitingFor: this.connected ? null : 'server',
      desync: false,
      peers: this.otherRobots,
    };
  }

  dispose(): void {
    this.transport.close();
  }

  /** a robot's static spec, re-injected into slimmed snapshots (from setups) */
  private specById = (id: number): RobotSpec =>
    this.setups.find((s) => s.id === id)?.spec ?? this.setups[0].spec;

  private onMessage(data: string): void {
    const m = decodeServerMsg(data);
    if (m.t === 'snapshot') {
      // patch the ball baseline, then rebuild the array in the authoritative order
      for (const b of m.balls.upd) this.baseBalls.set(b.id, b);
      const keep = new Set(m.balls.order);
      for (const id of this.baseBalls.keys()) if (!keep.has(id)) this.baseBalls.delete(id);
      const balls = m.balls.order
        .map((id) => this.baseBalls.get(id))
        .filter((b): b is Artifact => b !== undefined);
      const world = unslimWorld(m.w, balls, this.specById);
      // each robot's command this tick, so the controller can predict remotes.
      // tolerate an older server that doesn't send cmds (remotes just won't be
      // predicted forward — no crash) so a version mismatch degrades gracefully
      const cmds = new Map<number, RobotCommand>();
      const qc = m.cmds ?? [];
      m.w.robots.forEach((r, i) => {
        if (qc[i]) cmds.set(r.id, dequantizeCommand(qc[i]));
      });
      // keep only the freshest — the controller reconciles to the newest world
      this.snapshot = { serverTick: m.serverTick, world, cmds, ackInputTick: m.ackInputTick };
      this.connected = true; // snapshots flowing ⇒ we're synced
    } else if (m.t === 'matchResult') {
      this.matchResult = { kind: m.kind, record: m.record, result: m.result, replay: m.replay };
    } else if (m.t === 'eloResult') {
      this.eloResults = m.results;
    } else if (m.t === 'matchStart') {
      // a host restart: adopt the new seed/setups and rebuild
      this.seed = m.seed;
      this.setups = m.setups;
      this.ranked = m.ranked ?? false;
      this.intros = m.intros ?? [];
      this.eloResults = [];
      this.snapshot = null;
      this.matchResult = null;
      this.baseBalls.clear();
      this.restartCb?.();
    } else if (m.t === 'rejoined' && !m.ok) {
      // the grace window lapsed — stop reconnecting (HUD stays "reconnecting")
      this.connected = false;
      this.transport.close();
    }
    // 'drop' is reflected in the next snapshot already; nothing to do here
  }
}
