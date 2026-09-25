import type { AccessGroup, SiteAccess, SiteBanner, SiteLockdown } from './protocol';
import { ACCESS_GROUP_LABEL } from './protocol';

/**
 * THE SITE GATE'S RULES, pure: no React, no `import.meta.env`, no network. `siteStatus.ts`
 * binds them to this build; `scripts/smoke.ts` pins them.
 */

type GateInput = { lockdown: SiteLockdown | null; access: SiteAccess | null | undefined };


/** a site lockdown is in force right now */
export const siteClosedByServer = (l: SiteLockdown | null | undefined): boolean =>
  !!l && l.scope === 'site' && l.biting;

/** does this account have alpha-style access at all (admin, or any group)? */
export const hasGroupAccess = (a: SiteAccess | null | undefined): boolean =>
  !!a && (a.admin || a.groups.length > 0);

/**
 * IS THE APP CLOSED FOR THIS VIEWER? Pure, so smoke pins it.
 *
 *  - a biting SITE lockdown closes it unless the server says this account passes;
 *  - a build baked closed closes it unless the server confirms the account is an admin or in
 *    a group (every group means alpha access), and stays closed while that cannot be asked;
 *  - otherwise it is open, including when the server cannot be reached (fail open).
 */
export function isClosed(s: GateInput, buildClosed: boolean): boolean {
  if (siteClosedByServer(s.lockdown)) return !s.access?.passes;
  if (buildClosed) return !hasGroupAccess(s.access);
  return false;
}

/**
 * THE "YOU ARE BYPASSING" LINE for an admin or group member who is let past something that
 * stops everyone else: a site lockdown, a baked-closed build, or a biting matches lockdown.
 * Null when there is nothing being bypassed.
 */
export function bypassLine(s: GateInput, buildClosed: boolean, channel: string): string | null {
  const a = s.access;
  if (!a || isClosed(s, buildClosed)) return null;
  const biting = !!s.lockdown?.biting;
  if (!biting && !buildClosed) return null;
  if (biting && !a.passes) return null;
  const as = a.admin ? 'an admin' : a.groups.length ? groupPhrase(a.groups) : null;
  if (!as) return null;
  if (siteClosedByServer(s.lockdown) || buildClosed) {
    return `${channel === 'alpha' ? 'Alpha' : 'DSIM'} is closed to players. You’re in as ${as}.`;
  }
  return `New matches are paused for players. You can still start them as ${as}.`;
}

function groupPhrase(groups: AccessGroup[]): string {
  const g = groups[0];
  const label = ACCESS_GROUP_LABEL[g].toLowerCase();
  return `a${/^[aeiou]/.test(label) ? 'n' : ''} ${label}`;
}

// ----------------------------------------------------------------------- banners ----

/** importance, most first. A restart outranks everything; the bypass line is its own row. */
export const BANNER_RANK: Record<SiteBanner['kind'], number> = {
  restart: 0,
  warning: 1,
  'known-bug': 2,
  info: 3,
};

/**
 * The banners THIS viewer should see, most important first: scoped to their game and channel,
 * not dismissed at this revision. A restart cannot be dismissed. Pure, so smoke pins it.
 */
export function visibleBanners(
  banners: SiteBanner[],
  opts: { game: string; channel: string; dismissed: Record<string, number>; now?: number },
): SiteBanner[] {
  const now = opts.now ?? Date.now();
  return banners
    .filter((b) => !b.game || b.game === opts.game)
    .filter((b) => !b.channel || b.channel === opts.channel)
    .filter((b) => !b.startsAt || b.startsAt <= now)
    .filter((b) => b.kind === 'restart' || !b.endsAt || b.endsAt > now)
    .filter((b) => b.kind === 'restart' || opts.dismissed[String(b.id)] !== b.revision)
    .sort((a, b) => BANNER_RANK[a.kind] - BANNER_RANK[b.kind] || b.id - a.id);
}
