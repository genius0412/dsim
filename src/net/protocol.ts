import type { Alliance, AssistConfig, RobotCommand, RobotSpec } from '../types';
import { clamp } from '../math';

/**
 * Wire protocol for lockstep multiplayer. Two message classes share one
 * DataChannel and are told apart by JS type (WebRTC delivers ArrayBuffer vs
 * string distinctly):
 *   - COMMAND PACKETS (ArrayBuffer, hot path): a run of per-tick RobotCommands
 *     for one robot, quantized to 4 bytes/tick.
 *   - CONTROL MESSAGES (JSON string, cold path): start / restart / checksum /
 *     bye. Rare, so readability beats bytes.
 *
 * CRITICAL determinism rule: commands are QUANTIZED AT THE PRODUCER, and the
 * producer feeds its OWN local sim the dequantized value (dequantizeCommand ∘
 * quantizeCommand). Every peer decodes the same bytes to the same float, so all
 * sims step bit-identical inputs. Never feed a raw (unquantized) command to the
 * local sim while sending a quantized one to peers.
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

/** the exact command a producer must ALSO step locally (quantize round-trip) */
export function localizeCommand(c: RobotCommand): RobotCommand {
  return dequantizeCommand(quantizeCommand(c));
}

// ---- command packets (binary) ----------------------------------------------

/** [type=1][robotId u8][startTick u32][count u8][ count × (dx,dy,rot,buttons) ] */
export const MSG_CMDS = 1;

export function encodeCommandPacket(
  robotId: number,
  startTick: number,
  cmds: QCommand[],
): ArrayBuffer {
  const buf = new ArrayBuffer(7 + cmds.length * 4);
  const dv = new DataView(buf);
  dv.setUint8(0, MSG_CMDS);
  dv.setUint8(1, robotId);
  dv.setUint32(2, startTick >>> 0);
  dv.setUint8(6, cmds.length);
  let o = 7;
  for (const c of cmds) {
    dv.setInt8(o, c.dx);
    dv.setInt8(o + 1, c.dy);
    dv.setInt8(o + 2, c.rot);
    dv.setUint8(o + 3, c.buttons);
    o += 4;
  }
  return buf;
}

export interface CommandPacket {
  robotId: number;
  startTick: number;
  cmds: QCommand[];
}

export function decodeCommandPacket(buf: ArrayBuffer): CommandPacket {
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== MSG_CMDS) throw new Error('not a command packet');
  const robotId = dv.getUint8(1);
  const startTick = dv.getUint32(2);
  const count = dv.getUint8(6);
  const cmds: QCommand[] = [];
  let o = 7;
  for (let i = 0; i < count; i++) {
    cmds.push({
      dx: dv.getInt8(o),
      dy: dv.getInt8(o + 1),
      rot: dv.getInt8(o + 2),
      buttons: dv.getUint8(o + 3),
    });
    o += 4;
  }
  return { robotId, startTick, cmds };
}

// ---- control messages (JSON) -----------------------------------------------

/** one occupied slot the host assigns at match start */
export interface NetRobotSetup {
  id: number;
  alliance: Alliance;
  spec: RobotSpec;
  assists: AssistConfig;
  startIndex: number;
}

export type ControlMsg =
  | { t: 'start'; seed: number; setups: NetRobotSetup[] }
  | { t: 'restart'; seed: number }
  | { t: 'checksum'; tick: number; hash: number }
  // host-authored: every peer drops `robotId` at exactly `tick` (runs it on ZERO
  // from there), so a disconnect degrades identically for all — not at each
  // peer's own wall-clock moment (which silently desynced)
  | { t: 'bye'; robotId: number; tick: number };

export const encodeControl = (m: ControlMsg): string => JSON.stringify(m);
export const decodeControl = (s: string): ControlMsg => JSON.parse(s) as ControlMsg;
