/**
 * WHAT IS KEEPING THIS SATELLITE AWAKE — one log line a minute, on auto-stopping machines only.
 *
 * A satellite stops a few minutes after its last request, so a client that sends one request
 * every couple of minutes keeps it running all day. After the primary router (`router/`) moved
 * the menu polls to iad, satellites still ran 12-22 h a day, and nothing could say why: the
 * server logged no requests and Fly's metrics carry no path. This tallies the plain HTTP
 * requests a satellite answers (WebSocket upgrades are match traffic and are not counted) and
 * prints them grouped by method, path and the page they came from:
 *
 *   [wake] 14 req/60s: GET /api/presence ← www.playdsim.com browser ×9 · GET /health ← - curl ×5
 *
 * Nothing is kept per client: no address, no account, no full user agent. The page host is the
 * `Origin` (or `Referer`) header, which says WHICH BUILD sent it — the live site, a preview
 * deployment, the Discord activity — and that is the question this answers.
 *
 * A leaf module so `npm test` can check the grouping without booting a server.
 */

/** collapse a path to its route: query dropped, id-like segments replaced, at most 3 deep */
export function wakeRoute(url: string): string {
  const path = (url.split('?')[0] || '/').slice(0, 200);
  const segs = path
    .split('/')
    .filter(Boolean)
    .slice(0, 3)
    .map((s) => (s.length >= 8 && /\d/.test(s) ? ':id' : s.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 32)));
  return '/' + segs.join('/');
}

/** the host of the page that made the request, or '-' */
export function wakeSource(origin: string | undefined, referer: string | undefined): string {
  for (const raw of [origin, referer]) {
    if (!raw || raw === 'null') continue;
    try {
      return new URL(raw).host.slice(0, 64) || '-';
    } catch {
      /* not a URL — try the next header */
    }
  }
  return '-';
}

/** browser / curl / node / … — the first product token, never the full user agent */
export function wakeAgent(ua: string | undefined): string {
  if (!ua) return '-';
  if (ua.startsWith('Mozilla/')) return 'browser';
  return (ua.split(/[/\s]/)[0] || '-').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 20) || '-';
}

/** counts requests by `METHOD route ← source agent` and drains them into one line */
export class WakeTally {
  private counts = new Map<string, number>();
  private total = 0;

  add(method: string, url: string, origin?: string, referer?: string, ua?: string): void {
    const key = `${method} ${wakeRoute(url)} ← ${wakeSource(origin, referer)} ${wakeAgent(ua)}`;
    // a bounded table: a scan of random paths must not grow it without limit
    if (!this.counts.has(key) && this.counts.size >= 200) return void this.total++;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    this.total++;
  }

  /** the summary line for the window, or null if nothing arrived; resets the tally */
  drain(windowS: number): string | null {
    if (this.total === 0) return null;
    const top = [...this.counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    const line = `[wake] ${this.total} req/${windowS}s: ` + top.map(([k, n]) => `${k} ×${n}`).join(' · ');
    this.counts.clear();
    this.total = 0;
    return line;
  }
}
