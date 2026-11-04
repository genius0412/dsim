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
