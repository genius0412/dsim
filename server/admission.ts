/**
 * ADMISSION POLICY — the pure half of "may this socket do that", lifted out of `index.ts` so
 * it can be tested without booting a listener (the same reason `routing.ts` exists).
 *
 * Nothing here touches a socket, a room registry or the database. Every function answers from
 * its arguments, which is what lets `scripts/smoke.ts` pin each rule directly.
 */
import type { QueueMode, RecordKind, RoomKind } from '../src/net/protocol';
import { legalRegion } from './routing';

/**
 * WHAT A ROOM CODE MAY LOOK LIKE, after the server lower-cases it.
 *
 * Wide on purpose, because it has to admit EVERY code the product mints, from every client
 * build still in the fleet:
 *  - custom / duo-record / LAN / Discord-activity codes: 6 chars of `ROOM_CODE_ALPHABET`
 *    (`src/net/roomCode.ts`, `roomCodeForInstance`), lower-cased on the way in;
 *  - matchmaker-staged codes: `<region>-<mode><seq><base36>` (`iad-1v112ab3cd`), and the
 *    no-DB fallback `mm-1v1-3` (`server/matchmaking.ts`);
 *  - record runs: `rec-` + base36 (`src/ui/RecordRun.tsx`);
 *  - the load harness's `<region>-<code>` (`scripts/loadtest.ts`).
 * All of those are `[a-z0-9-]`; `.`, `_` and `:` are admitted too because the Discord group
 * token already uses that alphabet and a future code format should not have to widen a gate
 * nobody remembers. What it refuses is the case that was actually reachable: a 60 KB code, or
 * one carrying a newline straight into the `[admit]` log lines and the presence heartbeat.
 */
export const ROOM_CODE_RE = /^[a-z0-9._:-]{1,64}$/;

export function legalRoomCode(code: unknown): code is string {
  return typeof code === 'string' && ROOM_CODE_RE.test(code);
}

/**
 * THE ROOM KIND OFF THE WIRE, forced to the enums.
 *
 * `msg.config` used to be spread into the room as-is. `{kind: 'record'}` with no `record`
 * then made a one-seat room that `persist.ts` filed on the SOLO board (`record ?? 'solo'`)
 * while `Room.soloRecord` read false — so the lock, restart and reap rules for a solo run did
 * not apply to a run that was saved as one. A record room is now always solo or duo, and
 * anything that is not `'record'` is a versus room, which is what the room already treated it
 * as everywhere except the one check that read the raw string.
 */
export function coerceRoomKind(raw: unknown): { kind: RoomKind; record?: RecordKind } {
  const c = (typeof raw === 'object' && raw !== null ? raw : {}) as { kind?: unknown; record?: unknown };
  if (c.kind === 'record') return { kind: 'record', record: c.record === 'duo' ? 'duo' : 'solo' };
  return { kind: 'versus' };
}

/** the queue modes a client may ask for; anything else is refused before it reaches the pool */
export function isQueueMode(m: unknown): m is QueueMode {
  return m === '1v1' || m === '2v2';
}

/**
 * THE CLIENT'S REPORTED ACCESS LATENCY, bounded.
 *
 * It feeds the minimax host pick (`bestHost`), where one player's number can move the host.
 * Unbounded, `accessMs: 1e6` pinned every ranked match that player was in to their own region
 * (the rest of the group's latency stopped mattering), and a non-number turned the estimate
 * into string concatenation. `ACCESS_MS_MAX` is a generous real-world ceiling for the first
 * hop; a lie is now limited to what a genuinely poor connection is already allowed to do.
 */
export const ACCESS_MS_MAX = 150;
export function coerceAccessMs(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  return Math.min(ACCESS_MS_MAX, Math.max(0, raw));
}

/** the client's claimed home region, kept only if it is shaped like a Fly region code */
export function coerceHomeRegion(raw: unknown): string {
  return typeof raw === 'string' && legalRegion(raw) ? raw : '';
}

/**
 * HOW MANY ROOMS THIS NETWORK IS HOSTING that count against its cap.
 *
 * `hostOf` answers the creator's network key for a room (or undefined for one created before
 * the key was recorded, which never counts); `counts` is the room's own answer to whether it
 * is the kind of room the cap is about (`Room.countsTowardHostCap`).
 */
export function hostedBy<R>(
  rooms: Iterable<R>,
  key: string,
  hostOf: (r: R) => string | undefined,
  counts: (r: R) => boolean,
): number {
  let n = 0;
  for (const r of rooms) if (hostOf(r) === key && counts(r)) n++;
  return n;
}

/** where one account is playing, as the cross-region heartbeat reports it (`liveRoomsByUser`) */
export interface RemoteLive {
  room: string;
  region: string;
  soloRecord?: boolean;
}

/**
 * IS THIS ACCOUNT ALREADY IN A LIVE MATCH ON ANOTHER MACHINE?
 *
 * The single-game lock (`userRoom` in `index.ts`) lives in one process's memory, and one Fly
 * app is several machines: a record run goes to the player's selected region, a custom room
 * lives in its host's region, and the ranked queue lives on the matchmaker. So a player in a
 * live versus match on lhr was admitted to a record run on iad — the guard only ever saw its
 * own rooms. The heartbeat every machine writes is the server's own record of who is in which
 * running match, and this reads it.
 *
 * Only a room this machine does NOT host is considered: for a local room the in-memory lock is
 * fresher than a five-second heartbeat and already decides. `yieldSoloRecord` carries today's
 * exemption over: a solo record run never blocks its own owner from joining something else
 * (the queue does not take it, exactly as the local queue guard does not).
 */
export function remoteLiveConflict(
  live: RemoteLive | undefined,
  code: string,
  isLocal: (code: string) => boolean,
  yieldSoloRecord: boolean,
): boolean {
  if (!live) return false;
  const other = live.room.toLowerCase();
  if (other === code) return false; // this very room (a reconnect)
  if (isLocal(other)) return false; // the local lock decides for rooms on this machine
  if (yieldSoloRecord && live.soloRecord) return false;
  return true;
}
