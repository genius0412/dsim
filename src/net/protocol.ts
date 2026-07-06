import type {
  Alliance,
  Artifact,
  AssistConfig,
  RobotCommand,
  RobotSpec,
  RobotState,
  World,
} from '../types';
import type { RobotSetup } from '../sim/spawn';
import { clamp } from '../math';

/**
 * Wire protocol for the SERVER-AUTHORITATIVE netcode (Phase 0). All messages are
 * JSON over a single WebSocket per client — binary/delta encoding is a Phase 1
 * optimization. Two directions:
 *   - ClientMsg (browser → server): lobby ops + per-tick `input`.
 *   - ServerMsg (server → browser): roster, `matchStart`, `snapshot`, `drop`.
 *
 * Determinism note (narrower than the old lockstep rule): the server is the sole
 * authority, so cross-machine float determinism is NOT required. What IS required
 * is that the value the client PREDICTS with matches the value the server steps:
 * the client quantizes its command (`quantizeCommand`) before sending AND predicts
 * on the round-tripped value (`localizeCommand`); the server dequantizes the same
 * bytes. Never predict on a raw command while sending a quantized one.
 */

/** a RobotCommand packed into 3 signed axes + a button bitfield (4 bytes) */
export interface QCommand {
  dx: number; // int8, -127..127  (driveX * 127)
  dy: number; // int8
  rot: number; // int8
  buttons: number; // uint8 bitfield: bit0 intake, bit1 fire
}

const BTN_INTAKE = 1;
const BTN_FIRE = 2;

export function quantizeCommand(c: RobotCommand): QCommand {
  return {
    dx: Math.round(clamp(c.driveX, -1, 1) * 127),
    dy: Math.round(clamp(c.driveY, -1, 1) * 127),
    rot: Math.round(clamp(c.rotate, -1, 1) * 127),
    buttons: (c.intake ? BTN_INTAKE : 0) | (c.fire ? BTN_FIRE : 0),
  };
}

export function dequantizeCommand(q: QCommand): RobotCommand {
  return {
    driveX: q.dx / 127,
    driveY: q.dy / 127,
    rotate: q.rot / 127,
    intake: (q.buttons & BTN_INTAKE) !== 0,
    fire: (q.buttons & BTN_FIRE) !== 0,
  };
}

/** the exact command the client must PREDICT with (quantize round-trip), so its
 * local sim matches what the server computes from the same wire bytes */
export function localizeCommand(c: RobotCommand): RobotCommand {
  return dequantizeCommand(quantizeCommand(c));
}

// ---- lobby model ------------------------------------------------------------

/** max drivers per room (2v2) */
export const ROOM_CAPACITY = 4;

/** a driver in a room (server-authoritative — no presence/mesh bookkeeping) */
export interface LobbyPlayer {
  clientId: string;
  name: string;
  teamName: string;
  teamNumber: number;
  alliance: Alliance;
  /** index into START_POSES (mirrored per alliance) */
  startIndex: number;
  ready: boolean;
  spec: RobotSpec;
  assists: AssistConfig;
}

/** fields a client may change about itself while in the room */
export type PlayerPatch = Partial<
  Pick<
    LobbyPlayer,
    'name' | 'teamName' | 'teamNumber' | 'alliance' | 'startIndex' | 'ready' | 'spec' | 'assists'
  >
>;

// ---- client → server --------------------------------------------------------

export type ClientMsg =
  | { t: 'join'; room: string; player: Omit<LobbyPlayer, 'clientId'> }
  // reclaim an in-match slot after a transient socket drop (within the grace
  // window) — the server rebinds the robot to the new connection and resyncs
  | { t: 'rejoin'; room: string; clientId: string }
  | { t: 'update'; patch: PlayerPatch }
  | { t: 'start' } // host only: build + broadcast the match world
  | { t: 'restart' } // host only: re-author the match with a fresh seed
  | { t: 'input'; tick: number; q: QCommand };

// ---- server → client --------------------------------------------------------

export type ServerMsg =
  | { t: 'welcome'; clientId: string }
  | { t: 'roster'; players: LobbyPlayer[]; hostId: string }
  | { t: 'error'; message: string }
  // reply to a 'rejoin': ok ⇒ slot reclaimed (a snapshot follows); !ok ⇒ the
  // grace window lapsed / slot is gone, stop trying
  | { t: 'rejoined'; ok: boolean }
  | { t: 'matchStart'; seed: number; setups: RobotSetup[]; yourRobotId: number }
  // authoritative world at `serverTick`, slimmed (spec-stripped robots) with the
  // balls delta-encoded; the client reassembles a full World via `unslimWorld`.
  // `cmds[i]` is the command robot `w.robots[i]` ran this tick — the client holds
  // it to PREDICT that robot forward (so remote collisions are actually simulated,
  // not faked at render time). `ackInputTick` is the newest input tick from THIS
  // client the server folded in (diagnostic — the client reconciles off `serverTick`).
  | {
      t: 'snapshot';
      serverTick: number;
      w: SlimWorld;
      balls: BallDelta;
      cmds: QCommand[];
      ackInputTick: number;
    }
  // a robot left: the server runs it on ZERO from `tick`; snapshots already
  // reflect this, so it is informational (drives the HUD)
  | { t: 'drop'; robotId: number; tick: number };

export const encodeMsg = (m: ClientMsg | ServerMsg): string => JSON.stringify(m);
export const decodeClientMsg = (s: string): ClientMsg => JSON.parse(s) as ClientMsg;
export const decodeServerMsg = (s: string): ServerMsg => JSON.parse(s) as ServerMsg;

// ---- snapshot slimming + ball delta -----------------------------------------

/**
 * Wire snapshots drop bandwidth two ways without any determinism risk:
 *  1. STRIP the static `spec` from each robot — it never changes after
 *     matchStart, so the client re-injects it from `setups` (worldHash ignores
 *     spec, so parity is unaffected).
 *  2. DELTA the balls — send the authoritative id ORDER every frame (cheap, a
 *     few dozen ints) but only the DATA for balls that changed since the last
 *     snapshot. The client rebuilds the array in the sent order from its
 *     baseline, so it is byte-identical to the server's `world.balls`.
 *
 * Sending the order every frame is what keeps it deterministic: array position
 * drives collision/scoring iteration + `worldHash`, so it must match exactly.
 * (Over the reliable+ordered WebSocket no ack is needed — the client's baseline
 * is always the previous snapshot. A reconnect re-primes with a full keyframe.)
 */
export type SlimWorld = Omit<World, 'balls' | 'robots'> & {
  robots: Omit<RobotState, 'spec'>[];
};

/** the authoritative ball id ORDER + full data for only the changed balls */
export interface BallDelta {
  order: number[];
  upd: Artifact[];
}

function stripSpec(r: RobotState): Omit<RobotState, 'spec'> {
  const c: Partial<RobotState> = { ...r };
  delete c.spec;
  return c as Omit<RobotState, 'spec'>;
}

/** world for the wire: balls removed, robots stripped of their static spec */
export function slimWorld(world: World): SlimWorld {
  const { robots, ...rest } = world; // `rest` still carries balls
  const slim = { ...rest, robots: robots.map(stripSpec) };
  delete (slim as { balls?: unknown }).balls;
  return slim as SlimWorld;
}

/** rebuild a full World from a slim world + reconstructed ball array, re-injecting
 * each robot's spec by id */
export function unslimWorld(
  w: SlimWorld,
  balls: Artifact[],
  specById: (id: number) => RobotSpec,
): World {
  return {
    ...w,
    robots: w.robots.map((r) => ({ ...r, spec: specById(r.id) })),
    balls,
  };
}
