/**
 * THE JULY DESKTOP BUNDLE'S ONE WAY BACK (2026-11-16).
 *
 * The v0.1.3 installer (2026-07-24) bundled client build 11cba15, and its shell opened that copy
 * instead of the live site on any network where Node's `https` could not reach www.playdsim.com
 * (a proxy, TLS inspection). That copy has no BIOBUZZ and can never change. Shells from 0.2 update
 * themselves (`electron/main.cjs`), but a player stuck on that copy has no way to hear about them,
 * except this: it still polls `/api/presence` and shows `notice` as a banner. So the presence
 * handler answers it with one, and only it.
 *
 * RECOGNISED BY HOW A `file://` PAGE FETCHES, measured in Electron 43: `Sec-Fetch-Site:
 * cross-site` and `Sec-Fetch-Mode: cors` with NO `Origin`. A web page cannot send that: a
 * cross-site CORS request from an https page always carries `Origin`, the live site inside the
 * desktop app included. Discord's desktop client is Electron too, but an Activity's requests are
 * SAME-origin through Discord's proxy, so they fail the first test. Every bundled copy built since
 * names its build (`bundle=`, `fetchPresence` in src/net/api.ts) and is left alone, so a current
 * shell running its offline copy while the server is reachable is not told to reinstall.
 *
 * A live admin notice always wins (the caller only asks when there is none).
 */
import type { IncomingHttpHeaders } from 'node:http';

export const DESKTOP_REINSTALL_MESSAGE =
  'This desktop app is out of date and is missing BIOBUZZ. Get the current version at playdsim.com/download.';

const header = (h: IncomingHttpHeaders, name: string): string => {
  const v = h[name];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
};

export function desktopBundleNotice(
  headers: IncomingHttpHeaders,
  params: URLSearchParams,
): { kind: 'info'; message: string } | null {
  if (params.has('bundle')) return null;
  if (header(headers, 'origin') !== '') return null;
  if (header(headers, 'sec-fetch-site') !== 'cross-site' || header(headers, 'sec-fetch-mode') !== 'cors') return null;
  if (!/\bElectron\//.test(header(headers, 'user-agent'))) return null;
  return { kind: 'info', message: DESKTOP_REINSTALL_MESSAGE };
}
