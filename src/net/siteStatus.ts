import { useSyncExternalStore } from 'react';
import type { SiteAccess, SiteBanner, SiteLockdown, SiteStatus } from './protocol';
import { isClosed as rulesIsClosed, bypassLine as rulesBypassLine } from './siteRules';
import { appChannel, gameServerConfigured, gameServerHttpUrl } from './env';
import { authEnabled, getAuthToken } from '../lib/authClient';
import { setServerNotice } from './notice';

/**
 * THE SITE STATUS ON THIS CLIENT: the lockdown, the banners, and whether the signed-in account
 * gets past the lockdown. One store, fed by `GET /api/status` (at boot, then on a timer from
 * `NoticePoller`) and by the `siteStatus` socket push.
 *
 * ── FIRST LOAD ────────────────────────────────────────────────────────────────────────────
 * `main.tsx` calls `loadSiteStatus()` before React mounts and waits for it up to
 * `BOOT_WAIT_MS` beside the physics init, so a closed site shows the closed screen instead of
 * the menus. On a warm server the answer lands before physics is ready and costs nothing.
 *
 * ── FAIL OPEN ─────────────────────────────────────────────────────────────────────────────
 * An unreachable server OPENS the app. Free drive and practice work offline, and an outage
 * must not read as "DSIM is closed"; the server refuses writes on its own if it is up and
 * closed. The one exception is a build baked closed (`VITE_SITE_LOCKDOWN=1`, the alpha site):
 * that one starts closed and only the server can open it, by confirming the account.
 */

/** the alpha site is baked closed: `VITE_SITE_LOCKDOWN=1` on its Vercel project */
export const BUILD_CLOSED: boolean =
  ((import.meta.env.VITE_SITE_LOCKDOWN as string | undefined) ?? '').trim() === '1';

/** how long first paint waits for the status when the build is not baked closed */
export const BOOT_WAIT_MS = 800;

export interface SiteState {
  /** an answer (or a failure) has come back at least once */
  loaded: boolean;
  /** the last read reached the server */
  reachable: boolean;
  /** the server predates `/api/status` (a 404): lockdown screens stay off */
  unsupported: boolean;
  lockdown: SiteLockdown | null;
  banners: SiteBanner[];
  /** undefined = not asked; null = asked, and the token was missing or invalid */
  access: SiteAccess | null | undefined;
  /** a token check is in flight */
  checking: boolean;
  /** server clock minus ours, so a countdown is right on a wrong clock */
  skew: number;
}

let state: SiteState = {
  loaded: false,
  reachable: false,
  unsupported: false,
  lockdown: null,
  banners: [],
  access: undefined,
  checking: false,
  skew: 0,
};
const subs = new Set<() => void>();
const set = (patch: Partial<SiteState>): void => {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
};
export const getSiteState = (): SiteState => state;
export function useSiteState(): SiteState {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    getSiteState,
    getSiteState,
  );
}

// ------------------------------------------------------------------ the decision ----
// The rules themselves are in `siteRules.ts` (a leaf, so smoke can import them); these bind
// the build's own flag and channel.

export { siteClosedByServer, hasGroupAccess, visibleBanners, BANNER_RANK } from './siteRules';

export function isClosed(s: Pick<SiteState, 'lockdown' | 'access'>, buildClosed = BUILD_CLOSED): boolean {
  return rulesIsClosed(s, buildClosed);
}
export function bypassLine(s: Pick<SiteState, 'lockdown' | 'access'>, buildClosed = BUILD_CLOSED): string | null {
  return rulesBypassLine(s, buildClosed, appChannel());
}

// ---------------------------------------------------------------------- fetching ----

let inflight: Promise<void> | null = null;
let lastReadAt = 0;
/** ms since the last completed read (the poller skips a tick right after the boot read) */
export const siteStatusAge = (): number => Date.now() - lastReadAt;

/**
 * Read `/api/status`. The token rides along only when it could change the answer: a lockdown
 * is armed, or the build is baked closed. Everyone else stays anonymous, which keeps the
 * common poll free of an auth round trip.
 */
export function loadSiteStatus(opts: { forceToken?: boolean } = {}): Promise<void> {
  if (!gameServerConfigured()) {
    set({ loaded: true, reachable: false });
    return Promise.resolve();
  }
  if (inflight && !opts.forceToken) return inflight;
  const p: Promise<void> = readStatus(!!opts.forceToken).finally(() => {
    lastReadAt = Date.now();
    if (inflight === p) inflight = null;
  });
  inflight = p;
  return p;
}

async function readStatus(forceToken: boolean): Promise<void> {
  const base = gameServerHttpUrl();
  const wantToken = authEnabled && (forceToken || BUILD_CLOSED || !!state.lockdown || state.access !== undefined);
  let token: string | null = null;
  if (wantToken) {
    set({ checking: true });
    token = await getAuthToken(forceToken).catch(() => null);
  }
  try {
    const res = await fetch(base + '/api/status', {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      cache: 'no-store',
    });
    if (res.status === 404) {
      set({ loaded: true, reachable: true, unsupported: true, checking: false });
      return;
    }
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = (await res.json()) as SiteStatus;
    applyStatus(body, wantToken ? (token ? (body.access ?? null) : null) : undefined);
    // the restart countdown also feeds the start guard (`App`), exactly as the presence poll did
    setServerNotice(body.notice ?? null);
    // the anonymous read found a lockdown the account might pass: ask again, with the token
    if (!wantToken && authEnabled && body.lockdown) await readStatus(false);
  } catch (e) {
    console.warn('[site] status read failed:', e);
    set({ loaded: true, reachable: false, checking: false });
  }
}

function applyStatus(body: SiteStatus, access: SiteAccess | null | undefined): void {
  set({
    loaded: true,
    reachable: true,
    unsupported: false,
    lockdown: body.lockdown ?? null,
    banners: Array.isArray(body.banners) ? body.banners : [],
    ...(access !== undefined ? { access } : {}),
    checking: false,
    skew: typeof body.now === 'number' ? body.now - Date.now() : state.skew,
  });
}

/**
 * A `siteStatus` push from the socket. The access answer is kept; if a lockdown has just
 * appeared, the account is asked about it once.
 */
export function applyPushedStatus(lockdown: SiteLockdown | null, banners: SiteBanner[]): void {
  const newlyArmed = !!lockdown && !state.lockdown;
  set({ lockdown, banners: Array.isArray(banners) ? banners : [], loaded: true, reachable: true });
  if (newlyArmed && authEnabled && state.access === undefined) void loadSiteStatus();
}

/** the account changed (signed in or out): ask again with a fresh token */
export function recheckAccess(): Promise<void> {
  set({ access: undefined });
  return loadSiteStatus({ forceToken: true });
}
