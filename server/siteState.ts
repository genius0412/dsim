import { dbEnabled } from './db/pool';
import {
  accessGroupsOf,
  createBanner,
  deleteBanner,
  endBanner,
  endRestartBanners,
  getMaintenance,
  listBanners,
  listOpenBanners,
  lockdownPasses,
  maintenanceBiting,
  updateBanner,
  type AccessGroup,
  type BannerInput,
  type BannerRow,
  type MaintenanceWindow,
} from './db/repo';
import { ADMIN_IDS } from './staff';
import type { ServerMsg, SiteAccess, SiteBanner, SiteLockdown, SiteStatus } from '../src/net/protocol';

/**
 * THE SITE GATE AND THE BANNERS — one machine's cached view of two database rows' worth of
 * state that every machine must agree on (migrations 0023/0051 and 0052).
 *
 * Read on a timer, never per request: the lockdown is consulted on every join, queue and API
 * write, and banners on every status poll. Ten seconds of staleness is the price, and it is
 * paid only by the OTHER machines — the one that handled an admin write refreshes at once.
 * `server/index.ts` runs the timer and pushes a change to its own sockets.
 *
 * A DB READ THAT FAILS KEEPS THE LAST KNOWN STATE. A hiccup must neither lock everyone out nor
 * silently unlock a closed site.
 */

const TTL_MS = 10_000;

// ---------------------------------------------------------------- lockdown ----

const OFF: MaintenanceWindow = {
  active: false,
  startsAt: null,
  endsAt: null,
  message: '',
  scope: 'matches',
  redirectUrl: null,
  redirectLabel: null,
  bypass: [],
};
let lock: MaintenanceWindow = OFF;
let lockAt = 0;

export async function refreshLockdown(force = false): Promise<MaintenanceWindow> {
  if (!dbEnabled) return lock;
  if (!force && Date.now() - lockAt < TTL_MS) return lock;
  try {
    lock = await getMaintenance();
    lockAt = Date.now();
  } catch (e) {
    console.error('[lockdown] read failed, keeping last known state:', e);
  }
  return lock;
}

/** the cached window (refreshed by `refreshLockdown`) */
export const currentLockdown = (): MaintenanceWindow => lock;

/** the lockdown as clients see it: null when none is armed or it has ended */
export function publicLockdown(now = Date.now()): SiteLockdown | null {
  const w = lock;
  if (!w.active) return null;
  if (w.endsAt && now >= w.endsAt) return null;
  return {
    scope: w.scope === 'site' ? 'site' : 'matches',
    message: w.message,
    redirectUrl: w.redirectUrl ?? null,
    redirectLabel: w.redirectLabel ?? null,
    startsAt: w.startsAt,
    endsAt: w.endsAt,
    biting: maintenanceBiting(w, now),
    bypass: w.bypass ?? [],
  };
}

// ------------------------------------------------------------ access groups ----

const ACCESS_TTL_MS = 30_000;
const access = new Map<string, { groups: AccessGroup[]; at: number }>();

/** is this account an admin, and which groups is it in? Cached 30 s per account. */
export async function accessOf(userId: string): Promise<{ admin: boolean; groups: AccessGroup[] }> {
  const admin = ADMIN_IDS.has(userId);
  if (!dbEnabled) return { admin, groups: [] };
  const hit = access.get(userId);
  if (hit && Date.now() - hit.at < ACCESS_TTL_MS) return { admin, groups: hit.groups };
  try {
    const groups = await accessGroupsOf(userId);
    access.set(userId, { groups, at: Date.now() });
    // bounded by the accounts a machine sees before it auto-stops; trimmed crudely past that
    if (access.size > 5000) access.clear();
    return { admin, groups };
  } catch (e) {
    console.error('[access] read failed:', e);
    return { admin, groups: hit?.groups ?? [] };
  }
}

/** drop one account's cached groups (this machine granted or revoked something) */
export const forgetAccess = (userId: string): void => {
  access.delete(userId);
};

export async function siteAccess(userId: string, now = Date.now()): Promise<SiteAccess> {
  const who = await accessOf(userId);
  return { userId, admin: who.admin, groups: who.groups, passes: lockdownPasses(lock, who, now) };
}

/**
 * WHAT A CALLER IS REFUSED, if anything. `match` is anything that starts a match (join, queue,
 * a room start, LAN hosting) and is refused under EITHER scope; `site` is everything else a
 * closed site refuses (spectating, LAN joins, API writes, uploads) and only under `site`.
 * Returns the sentence to show, or null to let it through.
 */
export type GateAction = 'match' | 'site';
export async function lockdownRefusal(
  userId: string | null | undefined,
  action: GateAction,
  now = Date.now(),
): Promise<string | null> {
  const w = await refreshLockdown(); // TTL-cached
  if (!maintenanceBiting(w, now)) return null;
  if (action === 'site' && w.scope !== 'site') return null;
  const who = userId ? await accessOf(userId) : { admin: false, groups: [] as AccessGroup[] };
  if (lockdownPasses(w, who, now)) return null;
  return lockoutMessage(w, now);
}

/** the sentence a refused caller reads */
export function lockoutMessage(w: MaintenanceWindow = lock, now = Date.now()): string {
  const site = w.scope === 'site';
  const base = w.message?.trim() || (site ? 'DSIM is closed right now.' : 'DSIM is down for maintenance.');
  if (!w.endsAt) return site ? base : `${base} Please try again shortly.`;
  const mins = Math.max(1, Math.round((w.endsAt - now) / 60000));
  return `${base} Back in about ${mins} minute${mins === 1 ? '' : 's'}.`;
}

// ------------------------------------------------------------------ banners ----

/**
 * The open set (not ended; scheduled ones included, filtered by start at read time).
 *
 * WITHOUT A DATABASE (local dev, a LAN box) the set lives here in memory, which is exactly
 * what a one-machine deployment needs; the restart countdown worked that way before.
 */
let banners: BannerRow[] = [];
let bannersAt = 0;
let memId = 0;

export async function refreshBanners(force = false): Promise<BannerRow[]> {
  if (!dbEnabled) {
    const now = Date.now();
    banners = banners.filter((b) => !b.endsAt || b.endsAt + RESTART_GRACE_MS > now);
    return banners;
  }
  if (!force && Date.now() - bannersAt < TTL_MS) return banners;
  try {
    banners = await listOpenBanners();
    bannersAt = Date.now();
  } catch (e) {
    console.error('[banners] read failed, keeping last known set:', e);
  }
  return banners;
}

const toPublic = (b: BannerRow): SiteBanner => ({
  id: b.id,
  kind: b.kind,
  message: b.message,
  startsAt: b.startsAt,
  endsAt: b.endsAt,
  game: b.game,
  channel: b.channel,
  revision: b.revision,
});

/**
 * A RESTART COUNTDOWN OUTLIVES ITS `until` BY 20 s, the "restarting now…" beat clients have
 * always shown (and the only thing a zero-second announce shows at all). Ending or cancelling
 * one backdates it past the grace so it goes at once.
 */
export const RESTART_GRACE_MS = 20_000;
const isLive = (b: BannerRow, now: number): boolean =>
  (!b.startsAt || b.startsAt <= now) &&
  (!b.endsAt || b.endsAt + (b.kind === 'restart' ? RESTART_GRACE_MS : 0) > now);

/** the banners showing right now: started and not ended */
export function liveBanners(now = Date.now()): SiteBanner[] {
  return banners.filter((b) => isLive(b, now)).map(toPublic);
}

/**
 * THE RESTART COUNTDOWN IN THE SHAPE OLDER CLIENTS READ (`serverNotice`, and `notice` on
 * `/api/presence`). The newest live restart banner, or null.
 */
export function legacyNotice(now = Date.now()): (ServerMsg & { t: 'serverNotice' }) | null {
  const r = banners
    .filter((b) => b.kind === 'restart' && isLive(b, now))
    .sort((a, b) => b.id - a.id)[0];
  return r ? { t: 'serverNotice', kind: 'restart', message: r.message, until: r.endsAt ?? undefined } : null;
}

/** the `/api/status` body, minus `access` (added per caller) */
export function siteStatus(now = Date.now()): SiteStatus {
  const n = legacyNotice(now);
  return {
    lockdown: publicLockdown(now),
    banners: liveBanners(now),
    notice: n ? { kind: n.kind, message: n.message, until: n.until } : null,
    now,
  };
}

/**
 * A fingerprint of what clients are shown, so the push loop sends only on a CHANGE. Revision
 * and times are in it (an edit or an extension must reach people), the clock is not.
 */
export function statusSignature(now = Date.now()): string {
  const s = siteStatus(now);
  return JSON.stringify([s.lockdown, s.banners.map((b) => [b.id, b.revision, b.endsAt])]);
}

/** the console's list: the database's recent history, or the in-memory set without one */
export async function adminBannerList(): Promise<BannerRow[]> {
  if (!dbEnabled) return [...banners].sort((a, b) => b.id - a.id);
  return listBanners();
}

// writes. Each refreshes this machine's cache at once; the others follow within TTL_MS.
export async function addBanner(b: BannerInput, by: string): Promise<BannerRow> {
  if (!dbEnabled) {
    const now = Date.now();
    const row: BannerRow = { ...b, id: ++memId, revision: 1, createdBy: by, createdAt: now, updatedAt: now };
    banners.push(row);
    return row;
  }
  const row = await createBanner(b, by);
  await refreshBanners(true);
  return row;
}

export async function editBanner(id: number, b: BannerInput): Promise<BannerRow | null> {
  if (!dbEnabled) {
    const i = banners.findIndex((x) => x.id === id);
    if (i < 0) return null;
    banners[i] = { ...banners[i], ...b, revision: banners[i].revision + 1, updatedAt: Date.now() };
    return banners[i];
  }
  const row = await updateBanner(id, b);
  await refreshBanners(true);
  return row;
}

export async function endBannerNow(id: number): Promise<boolean> {
  if (!dbEnabled) {
    const b = banners.find((x) => x.id === id);
    if (!b) return false;
    b.endsAt = Date.now() - 60_000;
    return true;
  }
  const ok = await endBanner(id);
  await refreshBanners(true);
  return ok;
}

export async function removeBanner(id: number): Promise<boolean> {
  if (!dbEnabled) {
    const n = banners.length;
    banners = banners.filter((x) => x.id !== id);
    return banners.length < n;
  }
  const ok = await deleteBanner(id);
  await refreshBanners(true);
  return ok;
}

/** a restart countdown replaces any open one; `seconds` from now */
export async function announceRestart(message: string, seconds: number, by: string): Promise<BannerRow> {
  await cancelRestart();
  const now = Date.now();
  return addBanner(
    { kind: 'restart', message, startsAt: null, endsAt: now + seconds * 1000, game: null, channel: null },
    by,
  );
}

export async function cancelRestart(): Promise<number> {
  if (!dbEnabled) {
    const now = Date.now();
    let n = 0;
    for (const b of banners) {
      if (b.kind === 'restart' && (!b.endsAt || b.endsAt + RESTART_GRACE_MS > now)) {
        b.endsAt = now - 60_000;
        n++;
      }
    }
    return n;
  }
  const n = await endRestartBanners();
  await refreshBanners(true);
  return n;
}
