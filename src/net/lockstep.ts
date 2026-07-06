import type { RobotCommand } from '../types';
import { localizeCommand } from './protocol';

/**
 * Input-delay lockstep buffer (transport-agnostic — no WebRTC here so it stays
 * unit-testable). Every peer runs the same deterministic sim and steps tick T
 * only once EVERY connected robot's command for T is known.
 *
 * Scheme: the command sampled at the current tick is scheduled for tick
 * `now + INPUT_DELAY` (so ~66 ms of buffer absorbs jitter) and sent to peers
 * immediately. Ticks [0, INPUT_DELAY) are pre-seeded with ZERO so the match can
 * start without waiting. A disconnected robot is dropped from the wait-set and
 * its command becomes ZERO for every future tick (the sim already substitutes a
 * ZERO_CMD robot). `canStep(T)` gates the fixed-timestep drain in the game loop.
 */

export const INPUT_DELAY = 8; // ticks @120 Hz ≈ 66 ms (tunable 4–12)
export const CHECKSUM_INTERVAL = 120; // ticks (1 s) between checksum exchanges

const ZERO_CMD: RobotCommand = {
  driveX: 0,
  driveY: 0,
  rotate: 0,
  intake: false,
  fire: false,
};

export class Lockstep {
  /** robotId -> (tick -> command). Local commands are stored dequantized
   * (localizeCommand); remote commands arrive already dequantized. */
  private readonly buf = new Map<number, Map<number, RobotCommand>>();
  /** robots we still wait on each tick (shrinks on disconnect) */
  private readonly waiting = new Set<number>();
  /** robotId -> the tick FROM WHICH it is dropped: at/after it the robot is no
   * longer required and runs on ZERO. Ticks BEFORE it still require the real
   * buffered command, so a peer missing them stalls (safe) rather than silently
   * diverging. Set deterministically (host-broadcast drop tick), so every peer
   * substitutes ZERO from the exact same tick. */
  private readonly dropTicks = new Map<number, number>();

  constructor(
    robotIds: number[],
    readonly localRobotId: number,
    readonly delay: number = INPUT_DELAY,
  ) {
    for (const id of robotIds) {
      const m = new Map<number, RobotCommand>();
      for (let t = 0; t < delay; t++) m.set(t, ZERO_CMD); // pre-seed the pipeline
      this.buf.set(id, m);
      this.waiting.add(id);
    }
  }

  /** store the local command at an EXACT future tick (localized so it matches
   * what peers decode from the same bytes). Returns the localized command. */
  setLocal(tick: number, cmd: RobotCommand): RobotCommand {
    const local = localizeCommand(cmd);
    this.buf.get(this.localRobotId)?.set(tick, local);
    return local;
  }

  /** schedule the local command for `now + delay`; returns the landing tick and
   * the (quantized-round-tripped) command the caller must also transmit */
  submitLocal(now: number, cmd: RobotCommand): { tick: number; cmd: RobotCommand } {
    const tick = now + this.delay;
    return { tick, cmd: this.setLocal(tick, cmd) };
  }

  /** the local player's produced commands from the first post-seed tick — used
   * to BACKFILL a peer whose DataChannel opened after we began producing (early
   * broadcasts to a not-yet-open channel are dropped, so resend on connect) */
  localHistory(): { start: number; cmds: RobotCommand[] } {
    const m = this.buf.get(this.localRobotId);
    if (!m) return { start: this.delay, cmds: [] };
    const ticks = [...m.keys()].filter((t) => t >= this.delay).sort((a, b) => a - b);
    return { start: ticks[0] ?? this.delay, cmds: ticks.map((t) => m.get(t) as RobotCommand) };
  }

  /** is this robot dropped as of `tick`? (dropped ⇒ not required, runs ZERO) */
  private droppedAt(id: number, tick: number): boolean {
    const drop = this.dropTicks.get(id);
    return drop !== undefined && tick >= drop;
  }

  /** the first still-required robot missing a command for `tick` (what a stall
   * is waiting on), or null if `tick` is ready */
  missingAt(tick: number): number | null {
    for (const id of this.waiting) {
      if (this.droppedAt(id, tick)) continue;
      if (!this.buf.get(id)?.has(tick)) return id;
    }
    return null;
  }

  /** store a peer's command for one robot at one tick (already dequantized) */
  receiveRemote(robotId: number, tick: number, cmd: RobotCommand): void {
    this.buf.get(robotId)?.set(tick, cmd);
  }

  /** the highest tick buffered for a robot, or -1 if none — the host uses this
   * to choose a drop tick just past a departing robot's last known input */
  lastTickFor(robotId: number): number {
    const m = this.buf.get(robotId);
    if (!m) return -1;
    let max = -1;
    for (const t of m.keys()) if (t > max) max = t;
    return max;
  }

  /** drop a robot from `tick` onward: it stops being required and runs on ZERO
   * there. Deterministic across peers when `tick` is the same everywhere (that's
   * the host-broadcast drop tick). Idempotent to the EARLIEST drop tick. */
  dropAt(robotId: number, tick: number): void {
    const cur = this.dropTicks.get(robotId);
    this.dropTicks.set(robotId, cur === undefined ? tick : Math.min(cur, tick));
  }

  /** a robot left with no coordinated tick: run it on ZERO from the very start
   * (immediate). Used by the solo/degenerate path and unit tests. */
  markDisconnected(robotId: number): void {
    this.dropAt(robotId, 0);
  }

  /** true once every still-required robot has a command for `tick` */
  canStep(tick: number): boolean {
    for (const id of this.waiting) {
      if (this.droppedAt(id, tick)) continue;
      if (!this.buf.get(id)?.has(tick)) return false;
    }
    return true;
  }

  /** the command map to hand step() for `tick` (dropped/missing ⇒ ZERO) */
  commandsForTick(tick: number): Map<number, RobotCommand> {
    const out = new Map<number, RobotCommand>();
    for (const [id, m] of this.buf) {
      out.set(id, this.droppedAt(id, tick) ? ZERO_CMD : (m.get(tick) ?? ZERO_CMD));
    }
    return out;
  }

  /** drop commands older than `beforeTick` to bound memory */
  prune(beforeTick: number): void {
    for (const m of this.buf.values()) {
      for (const t of m.keys()) if (t < beforeTick) m.delete(t);
    }
  }

  /** should peers exchange a checksum at this tick? */
  static isChecksumTick(tick: number): boolean {
    return tick > 0 && tick % CHECKSUM_INTERVAL === 0;
  }
}
