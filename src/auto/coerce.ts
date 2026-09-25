/**
 * THE SPAWN-CHOKEPOINT COERCER for a setup's Zenith auto (`coerceSetup`). MAIN CHUNK: no Zenith
 * import. It bounds the bytes and nothing else — a file is validated by Zenith's own schema in
 * `load.ts`, where a bad one makes the seat report an error and drive nothing, which is the
 * safe answer. What must never happen is an unbounded string riding every snapshot and replay.
 */
import type { ZenithAutoSetup } from './types';

/**
 * 40 KiB of auto text. The largest example in Zenith (`three-tip.auto.json`) is 4 KiB and a
 * thirty-second routine with every step kind is under 20; this is a runaway guard, not a shape.
 * ⚠️ AND IT MUST FIT A WEBSOCKET FRAME: a custom room receives the file in one `zenithAuto`
 * message, and the server reads no frame over 64 KiB (`WS_MAX_PAYLOAD`, `server/index.ts`).
 * 40 + 8 KiB, with JSON escaping the quotes, stays under it with room to spare.
 */
export const ZENITH_AUTO_MAX_BYTES = 40 * 1024;
/** waypoints are a flat name -> pose map; 8 KiB is well over a hundred of them */
export const ZENITH_WAYPOINTS_MAX_BYTES = 8 * 1024;

/** A structurally safe `ZenithAutoSetup`, or undefined for anything else. */
export function coerceZenithAuto(raw: unknown): ZenithAutoSetup | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.auto !== 'string' || r.auto.length === 0 || r.auto.length > ZENITH_AUTO_MAX_BYTES) return undefined;
  const out: ZenithAutoSetup = { auto: r.auto };
  if (typeof r.waypoints === 'string' && r.waypoints.length > 0 && r.waypoints.length <= ZENITH_WAYPOINTS_MAX_BYTES) {
    out.waypoints = r.waypoints;
  }
  return out;
}
