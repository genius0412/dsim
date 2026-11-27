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
/**
 * THE REAL LIMIT, AS THE WIRE SEES IT. The file is JSON carried inside a JSON string, so every `"`
 * costs two bytes and a non-Latin character two or three. The server reads no frame over 64 KiB
 * (`WS_MAX_PAYLOAD`), and one `{ t: 'zenithAuto' }` frame carries the auto AND its waypoints, so
 * this is the budget for the two together: UTF-8 bytes of each as a JSON string, plus the
 * envelope, which is under 1 KiB. `ZENITH_AUTO_MAX_BYTES` (UTF-16 units) is only the old runaway
 * guard and stays as it was, so nothing accepted before the wire measure existed is refused for
 * its text alone: a compact auto is 25 to 30% quote characters, which is about 50 KiB here at the
 * 40 KiB text cap. Only a file that cannot fit a frame (40,000 quotes are 80 KB) is refused.
 */
export const ZENITH_AUTO_WIRE_MAX_BYTES = 63 * 1024;
const wireBytes = (s: string): number => new TextEncoder().encode(JSON.stringify(s)).length;
/** waypoints are a flat name -> pose map; 8 KiB is well over a hundred of them */
export const ZENITH_WAYPOINTS_MAX_BYTES = 8 * 1024;
/** What an auto (and its waypoints) cost in one `zenithAuto` frame, envelope not counted. */
export function zenithAutoWireBytes(auto: string, waypoints?: string): number {
  return wireBytes(auto) + (waypoints ? wireBytes(waypoints) : 0);
}

/** A structurally safe `ZenithAutoSetup`, or undefined for anything else. */
export function coerceZenithAuto(raw: unknown): ZenithAutoSetup | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.auto !== 'string' || r.auto.length === 0 || r.auto.length > ZENITH_AUTO_MAX_BYTES) return undefined;
  if (wireBytes(r.auto) > ZENITH_AUTO_WIRE_MAX_BYTES) return undefined;
  const out: ZenithAutoSetup = { auto: r.auto };
  // waypoints past their own bound, or past the frame together with the auto, are dropped
  // (`autoTooLarge` in library.ts says so before a save when it is given them)
  if (
    typeof r.waypoints === 'string' &&
    r.waypoints.length > 0 &&
    r.waypoints.length <= ZENITH_WAYPOINTS_MAX_BYTES &&
    zenithAutoWireBytes(r.auto, r.waypoints) <= ZENITH_AUTO_WIRE_MAX_BYTES
  ) {
    out.waypoints = r.waypoints;
  }
  return out;
}
