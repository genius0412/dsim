import { normalizePath } from '../src/pathScrub';

/**
 * VERCEL WEB ANALYTICS EXPORT → `analytics_imported` ROWS. Pure: no database, no env.
 *
 * Input is the file `scripts/vercel-analytics-export.mjs` writes. Output is one row per
 * (day, dim, val), in the vocabulary the dashboard already speaks, so the imported section can
 * reuse every panel. Values are mapped onto ours where the two disagree only in spelling
 * ("Mac" is `macOS`, "Microsoft Edge" is `Edge`); anything else is kept as the source wrote it.
 *
 * ⚠️ PATHS ARE SCRUBBED HERE. The host recorded raw request paths, so a replay id or a username
 * in `/profile/<name>` is in the export. `normalizePath` is the same function the live beacon runs
 * in the browser, and rows it merges are summed. Summing VISITORS across merged rows can count one
 * visitor twice on a day; that is the only place the import is less exact than its source.
 */

export interface ImportRow {
  day: string;
  dim: string;
  val: string;
  views: number;
  visitors: number;
}

interface VisitRow {
  day: string;
  value: string | null;
  pageviews: number;
  visitors: number;
}

export interface VercelExport {
  source: 'vercel';
  environment?: string;
  firstDay?: string | null;
  lastDay?: string | null;
  visits: { total: { day: string; pageviews: number; visitors: number }[]; by: Record<string, VisitRow[]> };
  events: {
    byName: { day: string; name: string | null; count: number; visitors: number }[];
    byProp: { day: string; name: string; key: string; value: string | null; count: number; visitors: number }[];
  };
}

/** the host's dimension → ours. `route` is absent on purpose: a Vite app reports none. */
const DIM_MAP: Record<string, string> = {
  requestPath: 'path',
  referrerHostname: 'ref',
  country: 'country',
  deviceType: 'device',
  osName: 'os',
  browserName: 'browser',
  utmSource: 'utm_source',
  utmMedium: 'utm_medium',
  utmCampaign: 'utm_campaign',
};

const OS_MAP: Record<string, string> = {
  Mac: 'macOS',
  'Mac OS': 'macOS',
  'Chrome OS': 'ChromeOS',
  'GNU/Linux': 'Linux',
  Ubuntu: 'Linux',
  Fedora: 'Linux',
  Debian: 'Linux',
};

const BROWSER_MAP: Record<string, string> = {
  'Microsoft Edge': 'Edge',
  'Mobile Safari': 'Safari',
  'Chrome Mobile': 'Chrome',
  'Chrome Mobile iOS': 'Chrome',
  'Chrome WebView': 'Chrome',
  'Chrome Headless': 'Chrome',
  'Firefox Mobile': 'Firefox',
  'Firefox iOS': 'Firefox',
  'Samsung Browser': 'Samsung Internet',
  'Opera Mobile': 'Opera',
  'Opera GX': 'Opera',
};

/** the host folds everything past its top-N into this value */
export const OTHERS = 'Others';

function mapValue(dim: string, raw: string | null): string {
  const v = (raw ?? '').trim();
  if (v === OTHERS) return OTHERS;
  switch (dim) {
    case 'path':
      return v ? normalizePath(v) : '/';
    case 'ref':
      return v.toLowerCase().replace(/^www\./, '').slice(0, 64);
    case 'country':
      return /^[A-Za-z]{2}$/.test(v) ? v.toUpperCase() : '';
    case 'device':
      return v.toLowerCase();
    case 'os':
      return OS_MAP[v] ?? v;
    case 'browser':
      return BROWSER_MAP[v] ?? v;
    default:
      return v.toLowerCase().slice(0, 48);
  }
}

/** `val` for an event property row. Names and keys are `[a-z0-9_]`, so `|` cannot collide. */
export function evpropVal(name: string, key: string, value: string): string {
  return `${name}|${key}|${value}`;
}

export function vercelImportRows(file: VercelExport): ImportRow[] {
  if (file?.source !== 'vercel' || !file.visits || !file.events) throw new Error('not a Vercel analytics export');
  const acc = new Map<string, ImportRow>();
  const add = (day: string, dim: string, val: string, views: number, visitors: number): void => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !(views > 0)) return;
    const k = `${day}\u0000${dim}\u0000${val}`;
    const cur = acc.get(k);
    if (cur) {
      cur.views += views;
      cur.visitors += visitors;
    } else acc.set(k, { day, dim, val, views, visitors });
  };

  for (const r of file.visits.total) add(r.day, 'total', '*', r.pageviews, r.visitors);
  for (const [src, rows] of Object.entries(file.visits.by)) {
    const dim = DIM_MAP[src];
    if (!dim) continue;
    for (const r of rows) add(r.day, dim, mapValue(dim, r.value), r.pageviews, r.visitors);
  }
  for (const r of file.events.byName) {
    if (r.name) add(r.day, 'event', r.name, r.count, r.visitors);
  }
  // An empty value is the host's bucket for "this event did not carry the property", not a value.
  for (const r of file.events.byProp) {
    if (r.value) add(r.day, 'evprop', evpropVal(r.name, r.key, String(r.value).slice(0, 32)), r.count, r.visitors);
  }
  return [...acc.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}
