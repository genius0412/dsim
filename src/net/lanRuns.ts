import type { GameId } from '../types';
import type { Replay } from '../sim/replay';
import type { LanParticipant } from './api';

/**
 * SELF-HOSTED (LAN) MATCHES, kept on the HOST's device until the cloud has them.
 *
 * The twin of `practiceRuns.ts`, and deliberately built to the same shape — an index plus one
 * body per run, a cap, and a backlog the app drains whenever it can — because the two solve
 * the same problem from opposite ends. A practice run is stored locally because there is no
 * server watching it; a LAN match is stored locally because the server that WAS watching it is
 * a laptop with no database, and the only machine that can get the match to the cloud is a
 * client.
 *
 * THIS DEVICE IS THE HOST'S. Only the host keeps and uploads a LAN match (the owner's call:
 * "whoever is hosting the match from the computer"), which is why there is no dedup problem
 * here — one uploader, one row. `matchId` still matters, because the HOST's own upload is
 * offered more than once: a timeout that actually succeeded, a reinstall, two tabs. The cloud
 * makes that free; see `lan_runs.match_id`, which is UNIQUE.
 *
 * WHY A BACKLOG AND NOT A POST. A venue's wifi is bad at precisely the wrong moment — the end
 * of a match, on a network with forty phones on it — and the host is required to be signed in
 * but is NOT required to be online at the final whistle. Uploading once and giving up would
 * lose matches for reasons that have nothing to do with the match.
 */

const KEY = 'decodesim.lanruns.v1';
const bodyKey = (id: string): string => `${KEY}.${id}`;

/**
 * How many self-hosted matches this device keeps.
 *
 * Higher than practice's 10 for the reason the server's `LAN_KEEP` is 40: a team scrimmaging
 * at a venue plays matches back to back all afternoon, and this cap is what decides how much
 * of an unlucky afternoon (a whole day offline) can still be recovered later. It is bounded
 * the same way — a match-length replay is tens of KB against a ~5 MB quota — so 40 is a few
 * hundred KB to low MB, and the quota path below gives ground before the browser does.
 */
export const MAX_LOCAL_LAN_RUNS = 40;

/** what the host's own list shows — everything except the input log itself */
export interface LanRunMeta {
  /** local id; also the key of the stored body */
  id: string;
  /** the SERVER-MINTED id for this match. The upload's identity and its idempotence key. */
  matchId: string;
  /** epoch ms the match finished */
  at: number;
  game: GameId;
  /** final score per alliance, as the LAN server reported it */
  score: { red: number; blue: number };
  /** who was in it, by NAME — see the migration for why there are no user ids here */
  participants: LanParticipant[];
  ticks: number;
  balanceVersion: number;
  /** SIM_VERSION when recorded — `replayRefusal` compares this to decide playability */
  sim: number;
  /** the cloud's id once this match has been uploaded; absent ⇒ local only */
  remoteId?: string;
  /** the cloud refused this match PERMANENTLY (409 — another account filed the same match id
   *  — or 400). Kept on the device and shown in the host's list; simply never offered to the
   *  backlog again, because retrying it would block every match queued behind it. */
  refused?: boolean;
}

const readIndex = (): LanRunMeta[] => {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as LanRunMeta[];
    return Array.isArray(list)
      ? list.filter((m) => m && typeof m.id === 'string' && typeof m.matchId === 'string')
      : [];
  } catch {
    // storage unavailable, or an index this build cannot read. Losing the local copies is
    // bad but not fatal — anything already uploaded is on the account.
    return [];
  }
};

const writeIndex = (list: LanRunMeta[]): void => {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* nothing to do — the bodies are already written or already gone */
  }
};

const dropBody = (id: string): void => {
  try {
    localStorage.removeItem(bodyKey(id));
  } catch {
    /* ignore */
  }
};

/** this device's self-hosted matches, newest first */
export function listLocalLanRuns(): LanRunMeta[] {
  return readIndex().sort((a, b) => b.at - a.at);
}

/** the stored input log for a match, or null if the body is gone (quota eviction, cleared
 *  site data, or a match that only exists on the account) */
export function loadLanReplay(id: string): Replay | null {
  try {
    const raw = localStorage.getItem(bodyKey(id));
    return raw ? (JSON.parse(raw) as Replay) : null;
  } catch {
    return null;
  }
}

export function deleteLocalLanRun(id: string): void {
  dropBody(id);
  writeIndex(readIndex().filter((m) => m.id !== id));
}

/**
 * Keep a finished self-hosted match on this device, evicting the oldest past the cap.
 *
 * Returns the metadata (so the caller can upload it), or null when nothing could be stored.
 *
 * IDEMPOTENT ON `matchId`, like the server it will be uploaded to. `matchResult` is a
 * broadcast, and a client that reconnects into the results screen can see it twice; storing
 * the same match twice would put a duplicate in the host's list AND make the backlog upload
 * it twice for the cloud to reject. An already-stored match returns its existing row.
 *
 * A QUOTA FAILURE EVICTS AND RETRIES, on the same reasoning as `savePracticeRun`: the cap is
 * a policy about how many matches are worth keeping, the quota is a hard limit shared with
 * everything else on the origin, and the newest match is the one that just happened.
 */
export function saveLanRunLocal(
  matchId: string,
  replay: Replay,
  score: { red: number; blue: number },
  participants: LanParticipant[],
): LanRunMeta | null {
  const existing = readIndex().find((m) => m.matchId === matchId);
  if (existing) return existing;

  const id = `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const meta: LanRunMeta = {
    id,
    matchId,
    at: Date.now(),
    game: replay.game ?? 'decode',
    score,
    participants,
    ticks: replay.ticks,
    balanceVersion: replay.balanceVersion,
    sim: replay.sim ?? 0,
  };

  const body = JSON.stringify(replay);
  let index = readIndex().sort((a, b) => b.at - a.at);
  // evict down to the cap BEFORE writing, so the common path writes once
  for (const old of index.slice(MAX_LOCAL_LAN_RUNS - 1)) dropBody(old.id);
  index = index.slice(0, MAX_LOCAL_LAN_RUNS - 1);

  for (;;) {
    try {
      localStorage.setItem(bodyKey(id), body);
      break;
    } catch {
      const oldest = index.pop();
      if (!oldest) return null; // nothing left to give back
      dropBody(oldest.id);
    }
  }

  writeIndex([meta, ...index]);
  return meta;
}

/**
 * Matches this device has that the CLOUD does not, oldest first.
 *
 * Oldest first so a flush uploads them in the order they were played, which is the order the
 * server's own prune assumes when it drops the oldest past `LAN_KEEP`. Upload them
 * SEQUENTIALLY and stop on the first failure (see `flushLanRuns`): a venue's connection
 * fails for every request at once, and hammering it with forty parallel POSTs of a
 * tens-of-KB replay is the worst thing to do on the network that just dropped one.
 */
export function pendingLanUploads(): LanRunMeta[] {
  return readIndex()
    .filter((m) => !m.remoteId && !m.refused)
    .sort((a, b) => a.at - b.at);
}

/** record that the cloud now holds this match too (so the backlog stops offering it) */
export function markLanUploaded(id: string, remoteId: string): void {
  const index = readIndex();
  const hit = index.find((m) => m.id === id);
  if (!hit) return;
  hit.remoteId = remoteId;
  writeIndex(index);
}

/**
 * Retire a match the cloud will never take — today, a 409 saying another account already
 * filed this match id, or a 400 saying the body is not acceptable.
 *
 * The match STAYS ON THE DEVICE and stays in the host's local list; only the backlog stops
 * offering it. That is the point: `pendingLanUploads` is drained in order and stops on the
 * first failure (a venue's connection fails for every request at once, so carrying on is the
 * wrong instinct), which means one permanently-refused item would sit at the head of the queue
 * and block every later match from ever uploading. Dropping the replay instead would throw
 * away the only copy of a match on the say-so of one HTTP status.
 */
export function markLanRefused(id: string): void {
  const index = readIndex();
  const hit = index.find((m) => m.id === id);
  if (!hit) return;
  hit.refused = true;
  writeIndex(index);
}
