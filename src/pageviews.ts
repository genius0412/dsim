/**
 * THE PAGEVIEW AND EVENT BEACON — the client half of DSIM's own analytics, and since the host's
 * analytics script was removed (September 2026) the only one. `server/analytics.ts` receives it
 * and `src/ui/AdminAnalytics.tsx` reads it, next to the product tables.
 *
 * ⚠️ WHAT THIS FILE IS ALLOWED TO SEND, and the reason each line of it is here:
 *
 *   · **No identifier of any kind.** No cookie, no localStorage key, no random nonce held in
 *     a module variable, nothing that could be read back on the next visit. The visitor hash
 *     is computed on the SERVER from a daily-rotating salt and thrown away with it; this file
 *     has no part in it and could not reproduce one.
 *   · **The path, already scrubbed.** The query string is dropped and every id-like segment is
 *     replaced HERE, before the request is made, so a replay id, a username or a room code
 *     never leaves the browser at all. Scrubbing server-side would mean the id arrives, sits
 *     in a TLS-terminated buffer and possibly an access log, and is then deleted — which is a
 *     different promise from the one the privacy page makes.
 *   · **The referrer's HOST.** A full referrer is somebody else's URL with somebody else's
 *     query string on it.
 *   · **A screen BUCKET.** Exact viewport pixels are among the strongest fingerprinting
 *     signals available in a browser, and nobody has ever needed more than "phone, tablet,
 *     laptop, big".
 *   · **The IANA timezone**, which the server maps to a two-letter country and discards. It is
 *     sent rather than the country because a 400-entry zone table has no business in the main
 *     bundle, and it is used rather than a geo-IP lookup because that would mean handing a
 *     visitor's address to a third party the privacy policy does not name.
 *
 * DEVICE, OS, BROWSER AND LANGUAGE ARE DELIBERATELY ABSENT from the payload. The server
 * derives all four from the `User-Agent` and `Accept-Language` headers the request already
 * carries, and stores only the derived enums — so the app never has to state a fingerprint,
 * and the raw strings are never written down.
 *
 * ⚠️ THE ENABLE GATE IS THE SAME ONE ADS AND EVENTS USE, plus one term. `VITE_ANALYTICS=1`
 * AND a configured cloud game server: a self-hosted build, an Electron build running offline,
 * and anybody's local checkout all send nothing, because there is nowhere for it to go and a
 * beacon aimed at a host you do not run is exactly what this project promises not to do.
 * `analyticsAllowed()` is read on EVERY call for the reason its own module gives — it is an
 * opt-OUT, so a second tab switching it off has to stop this one.
 *
 * ⚠️ `navigator.doNotTrack` AND GLOBAL PRIVACY CONTROL ARE HONOURED, for page views and events
 * alike. They cost one expression each, they are the two signals a visitor can send without
 * finding our switch, and ignoring a request you can see is worse than never having offered one.
 *
 * ⚠️ THIS MODULE MUST STAY IMPORTABLE UNDER PLAIN NODE, so `scripts/smoke.ts` can exercise
 * the scrubbers — which are the part with a privacy guarantee riding on them, and therefore
 * the part that must not be "verified by reading". That is why `import.meta.env` is read
 * through a guard and why `./net/env` is reached by DYNAMIC import inside the sender: that
 * module reads Vite env at module scope and throws the moment tsx loads it. Vite keeps it in
 * the main chunk regardless (`net/api.ts` imports it statically), so the dynamic form costs
 * no extra request. Same reasoning as `src/analyticsPref.ts` being its own leaf.
 */
import { analyticsAllowed } from './analyticsPref';
import { normalizePath } from './pathScrub';

// re-exported: `scripts/smoke.ts` tests the scrubbers through this module
export { normalizePath };

/** Vite env, or nothing at all under plain Node — see the header. */
const ENV: Record<string, string | undefined> =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

/** OFF unless explicitly enabled, matching `src/analytics.ts` and the ad gate. */
const ENABLED = (ENV.VITE_ANALYTICS ?? '').trim() === '1';

/** the release channel this build was cut on ('stable' | 'alpha'), as `net/env.ts` reads it */
const CHANNEL = (ENV.VITE_APP_CHANNEL ?? '').trim() || 'stable';

declare const __BUILD_ID__: string;
const BUILD = typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev';

// ---- the scrubbers ----------------------------------------------------------
// Pure, exported, and tested headlessly. Everything below this line that touches the network
// depends on them having already run.

/**
 * The referrer reduced to a bare host, or '' for a direct visit.
 *
 * SAME-ORIGIN IS NOT A REFERRER. Every in-app navigation would otherwise report the site
 * itself as its own top referrer, which is both useless and the only row large enough to hide
 * the real ones under.
 */
export function refHost(referrer: string, selfHost: string): string {
  if (!referrer) return '';
  let host = '';
  try {
    host = new URL(referrer).hostname.toLowerCase();
  } catch {
    return '';
  }
  if (!host || host === selfHost.toLowerCase()) return '';
  return host.replace(/^www\./, '').slice(0, 64);
}

/** viewport width → the four buckets the dashboard groups by */
export function screenBucket(width: number): 'sm' | 'md' | 'lg' | 'xl' {
  if (width < 480) return 'sm';
  if (width < 768) return 'md';
  if (width < 1280) return 'lg';
  return 'xl';
}

/**
 * The three UTM parameters, from a query string, each capped and lowercased.
 *
 * Only these three. `utm_term` and `utm_content` are ad-copy-level detail for campaigns this
 * project does not run, and every extra field is another string a stranger can push into the
 * database through a public endpoint.
 */
export function utmOf(search: string): { s: string; m: string; c: string } {
  const clean = (v: string | null): string => (v ?? '').trim().toLowerCase().slice(0, 48);
  try {
    const p = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
    return { s: clean(p.get('utm_source')), m: clean(p.get('utm_medium')), c: clean(p.get('utm_campaign')) };
  } catch {
    return { s: '', m: '', c: '' };
  }
}

// ---- the live half ----------------------------------------------------------

/**
 * THE CAMPAIGN THE SESSION ARRIVED ON, captured at MODULE LOAD.
 *
 * `App`'s mount effect rewrites the address bar to a canonical path with no query on it, so
 * by the time any component renders there is nothing left to read. Exactly the reason
 * `src/ui/entryToken.ts` exists, for exactly the same window.
 */
const ENTRY_UTM = typeof window !== 'undefined' ? utmOf(window.location.search) : { s: '', m: '', c: '' };

/**
 * DOES THE VISITOR'S BROWSER ALREADY SAY NO?
 *
 * `doNotTrack` is unreliable as a spec and is being removed from browsers; Global Privacy
 * Control is the one with legal force behind it in several US states. Both are read, neither
 * is trusted to exist, and either one answering yes is a no.
 */
function browserOptOut(): boolean {
  if (typeof navigator === 'undefined') return true;
  const nav = navigator as Navigator & { doNotTrack?: string; globalPrivacyControl?: boolean; msDoNotTrack?: string };
  if (nav.globalPrivacyControl === true) return true;
  const dnt = nav.doNotTrack ?? nav.msDoNotTrack ?? (typeof window !== 'undefined' ? (window as unknown as { doNotTrack?: string }).doNotTrack : undefined);
  return dnt === '1' || dnt === 'yes';
}

/** every gate, in the order that makes the cheapest one decide first */
function allowed(): boolean {
  if (!ENABLED) return false;
  if (typeof window === 'undefined') return false;
  if (browserOptOut()) return false;
  return analyticsAllowed();
}

/**
 * The last path sent, so a re-render cannot double-count one navigation.
 *
 * ⚠️ THIS IS NOT A VISITOR ID and must never become one. It is a string holding the previous
 * PATH — no random component, nothing derived from the device, nothing persisted, and it is
 * gone when the tab closes. React 18's StrictMode runs every effect twice in development and
 * the route effect this hangs off legitimately re-fires when the game changes under the same
 * path, so without it the top-pages table would be wrong by a factor that varies per build.
 */
let lastPath = '';

/** POST, preferring `sendBeacon` so a navigation away cannot cancel the request. */
function post(path: '/api/a/pv' | '/api/a/ev', body: unknown): void {
  void (async () => {
    try {
      const { gameServerHttpUrl } = await import('./net/env');
      const base = gameServerHttpUrl();
      if (!base) return; // no cloud configured — a LAN or offline build sends nothing
      const url = base + path;
      const json = JSON.stringify(body);
      // `sendBeacon` survives the unload a click on an outbound link causes, which is the one
      // event a click-through metric most needs to record. `text/plain` rather than
      // `application/json` on purpose: a JSON content type makes the beacon a CORS PREFLIGHTED
      // request, and a preflight cannot be sent during unload — the browser drops the whole
      // thing. The server parses the body itself and never trusts the header.
      if (navigator.sendBeacon?.(url, new Blob([json], { type: 'text/plain;charset=UTF-8' }))) return;
      await fetch(url, { method: 'POST', body: json, keepalive: true, mode: 'cors' });
    } catch {
      /* measurement must never be able to break the page it is only watching */
    }
  })();
}

/**
 * RECORD ONE PAGE VIEW. Called from `App`'s route effect, beside the one that keeps the
 * document title pointed at the current screen — the same place, because they answer the same
 * question about when a route becomes the current one.
 *
 * `game` is passed in rather than parsed back out of the path: the caller already knows it,
 * and a route with no game prefix (`/privacy`, `/download`) genuinely has none.
 */
export function trackPageview(path: string, game: string): void {
  if (!allowed()) return;
  const p = normalizePath(path);
  if (p === lastPath) return;
  lastPath = p;
  let tz = '';
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    /* an engine with no zone data simply contributes no country */
  }
  post('/api/a/pv', {
    p,
    g: game.slice(0, 16),
    r: refHost(document.referrer, window.location.hostname),
    s: ENTRY_UTM.s,
    m: ENTRY_UTM.m,
    c: ENTRY_UTM.c,
    w: screenBucket(window.innerWidth || 1280),
    z: tz.slice(0, 48),
    // `file:` is the Electron shell running its bundled offline copy; the desktop app
    // normally loads the live site, so this is the honest test of which one is on screen.
    x: window.location.protocol === 'file:' ? 'electron' : 'web',
    ch: CHANNEL,
    b: BUILD.slice(0, 16),
  });
}

/**
 * RECORD ONE NAMED EVENT — the events `src/analytics.ts` declares, so the funnel sits beside
 * the traffic that produced it.
 *
 * It takes the name as a plain string rather than importing `AnalyticsEvent`, because that
 * type lives in a module this one must not import (it reads Vite env at module scope, which
 * is the whole reason `analyticsPref.ts` was split out of it). The call site has the type.
 */
export function trackEventBeacon(name: string, props?: Record<string, string | number | boolean>): void {
  if (!allowed()) return;
  post('/api/a/ev', {
    n: name.slice(0, 40),
    p: lastPath,
    d: props ?? {},
  });
}
