/**
 * THE SPAWN-CHOKEPOINT COERCER for a setup's Zenith auto (`coerceSetup`). MAIN CHUNK: no Zenith
 * import. It bounds the bytes and nothing else — a file is validated by Zenith's own schema in
 * `load.ts`, where a bad one makes the seat report an error and drive nothing, which is the
 * safe answer. What must never happen is an unbounded string riding every snapshot and replay.
 */
import type { ZenithAutoSetup } from './types';

/**
 * 64 KiB of auto text. The largest example in Zenith (`three-tip.auto.json`) is 4 KiB and a
 * thirty-second routine with every step kind is under 20; this is a runaway guard, not a shape.
 */
export const ZENITH_AUTO_MAX_BYTES = 64 * 1024;
/** waypoints are a flat name -> pose map; 16 KiB is several hundred of them */
export const ZENITH_WAYPOINTS_MAX_BYTES = 16 * 1024;

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
