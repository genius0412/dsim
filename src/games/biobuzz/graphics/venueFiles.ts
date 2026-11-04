import { venueFileBytes } from './environments';
import type { GraphicsSettings, GraphicsTier } from './settings';

/**
 * A MODELED VENUE IS DRAWN FROM HIGH UP (2026-11-04): the High, Ultra and Extreme columns with the
 * high mesh detail. Low and Medium keep the row's procedural `venue`, which costs no download. DOM-
 * free and three-free so the scene, the idle warm and the RENDER lane all ask the same question.
 */
export function bbModelDetail(s: Pick<GraphicsSettings, 'meshDetail'>, tier: GraphicsTier): boolean {
  return (tier === 'high' || tier === 'ultra' || tier === 'extreme') && s.meshDetail === 'high';
}

/** a failed venue file is asked for twice, then not again for five minutes (same rule as the HDRI) */
export const VENUE_MAX_TRIES = 2;
export const VENUE_RETRY_MS = 5 * 60_000;
const failed = new Map<string, { n: number; at: number }>();

/** has `url` failed often enough, recently enough, not to be asked again. `now` is the caller's
 * clock (this directory reads none: the source guard keeps `graphics/` clock-free) */
export function venueBlocked(url: string, now: number): boolean {
  const f = failed.get(url);
  if (!f) return false;
  if (now - f.at >= VENUE_RETRY_MS) {
    failed.delete(url);
    return false;
  }
  return f.n >= VENUE_MAX_TRIES;
}

/** record a failed load of `url` at `now` */
export function noteVenueFailure(url: string, now: number): void {
  const f = failed.get(url);
  failed.set(url, { n: (f?.n ?? 0) + 1, at: now });
}

/** a `public/` path → a URL, through Vite's base (the Electron build's is `./`, under which a bare
 * `/venues/…` resolves at the filesystem root and 404s silently), versioned by the file's size from
 * its row (`venueFileBytes`), because `/venues` is served immutable */
export function venueAssetUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const env = (import.meta as { env?: { BASE_URL?: string } }).env;
  const base = (env?.BASE_URL ?? '/').replace(/\/+$/, '');
  const v = venueFileBytes(path);
  return `${base}/${path.replace(/^\/+/, '')}${v === undefined ? '' : `?v=${v}`}`;
}
