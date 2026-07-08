import type { LobbyPlayer, PlayerPatch } from './protocol';
import { coerceSpec, coerceAssists, coerceAutoPath, DEFAULT_SPEC, DEFAULT_ASSISTS } from '../sim/spawn';
import { START_POSES } from '../config';
import { clamp } from '../math';

/**
 * SERVER-SIDE untrusted-input sanitization for the lobby model. Everything a
 * client sends about its own robot (`join` player, `update` patch, ranked
 * `queue` player) is spoofable via devtools — people have edited the wire spec
 * to spawn oversized / malformed robots. The server must NEVER trust it: these
 * helpers force every field into a legal shape BEFORE it is stored on the room's
 * roster (which then feeds `createWorld`). The heavy lifting (spec/assist/auto
 * ranges) is the SAME `coerceSpec`/`coerceAssists`/`coerceAutoPath` the client
 * uses, so a client's own prediction matches what the server spawns.
 */

function coerceName(raw: unknown, fallback: string): string {
  return typeof raw === 'string' && raw.trim() ? raw.slice(0, 24) : fallback;
}

function coerceStartIndex(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw)
    ? clamp(Math.round(raw), 0, START_POSES.length - 1)
    : 0;
}

/** sanitize a full lobby player (join / queue). `clientId` is assigned by the
 * server, never taken from the wire. */
export function sanitizePlayer(raw: unknown): Omit<LobbyPlayer, 'clientId'> {
  const p = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const spec = coerceSpec(p.spec, DEFAULT_SPEC);
  const autoPath = coerceAutoPath(p.autoPath);
  return {
    name: coerceName(p.name, 'Driver'),
    // team name/number live on the spec AND the top-level player; keep them in
    // sync with the (already-clamped) spec so the roster can't disagree with it
    teamName: spec.teamName,
    teamNumber: spec.teamNumber,
    alliance: p.alliance === 'red' || p.alliance === 'blue' ? p.alliance : 'blue',
    startIndex: coerceStartIndex(p.startIndex),
    ready: p.ready === true,
    spec,
    assists: coerceAssists(p.assists, DEFAULT_ASSISTS),
    autoPath: autoPath ?? undefined,
    autoPathEnabled: autoPath ? p.autoPathEnabled === true : false,
  };
}

/** sanitize an in-room `update` patch: only keys actually present are returned,
 * each coerced to a legal value. A malformed patch yields an empty patch (no-op)
 * rather than corrupting the stored player. `current` is the player's existing
 * spec/assists so a partial spec patch clamps against the right baseline. */
export function sanitizePlayerPatch(raw: unknown, current: LobbyPlayer): PlayerPatch {
  if (typeof raw !== 'object' || raw === null) return {};
  const p = raw as Record<string, unknown>;
  const out: PlayerPatch = {};
  if ('name' in p) out.name = coerceName(p.name, current.name);
  if ('alliance' in p && (p.alliance === 'red' || p.alliance === 'blue')) out.alliance = p.alliance;
  if ('startIndex' in p) out.startIndex = coerceStartIndex(p.startIndex);
  if ('ready' in p) out.ready = p.ready === true;
  if ('assists' in p) out.assists = coerceAssists(p.assists, current.assists);
  if ('spec' in p) {
    const spec = coerceSpec(p.spec, current.spec);
    out.spec = spec;
    // keep the top-level team fields consistent with the clamped spec
    out.teamName = spec.teamName;
    out.teamNumber = spec.teamNumber;
  } else {
    if ('teamName' in p) out.teamName = coerceName(p.teamName, current.teamName);
    if ('teamNumber' in p && typeof p.teamNumber === 'number' && Number.isFinite(p.teamNumber)) {
      out.teamNumber = clamp(Math.round(p.teamNumber), 0, 99999);
    }
  }
  if ('autoPath' in p) {
    const autoPath = coerceAutoPath(p.autoPath);
    out.autoPath = autoPath ?? undefined;
    out.autoPathEnabled = autoPath ? p.autoPathEnabled === true : false;
  } else if ('autoPathEnabled' in p) {
    // only meaningful with a path already stored
    out.autoPathEnabled = current.autoPath ? p.autoPathEnabled === true : false;
  }
  return out;
}
