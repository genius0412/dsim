import { httpOf, type GameServer } from './env';

/**
 * Pre-connection latency probe for the server picker. Times each server's
 * `/health` endpoint over HTTP so a player can rank regions by ping BEFORE they
 * join a room (the in-match ping/pong in serverSession only exists once a match
 * is live, against one already-chosen server). Requires `/health` to send CORS.
 */

export type PingQuality = 'good' | 'fair' | 'poor' | 'down';

/** best of a few /health round-trips in ms, or null if unreachable */
export async function pingServer(
  s: GameServer,
  samples = 3,
  timeoutMs = 3000,
): Promise<number | null> {
  // `?region` lets a one-app multi-region deploy (shared base URL) actually measure
  // THIS region via fly-replay; separate-URL deploys ignore the harmless hint.
  const url = httpOf(s.url) + '/health' + (s.region ? `?region=${encodeURIComponent(s.region)}` : '');
  let best: number | null = null;
  for (let i = 0; i < samples; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const t0 = performance.now();
    try {
      const res = await fetch(url, { cache: 'no-store', signal: ctl.signal });
      if (res.ok) {
        await res.text().catch(() => {});
        const rtt = performance.now() - t0;
        if (best === null || rtt < best) best = rtt;
      }
    } catch {
      /* unreachable / aborted — leave best as-is */
    } finally {
      clearTimeout(timer);
    }
  }
  return best;
}

/** the client's own network position, for the ranked matchmaker: which region Fly's
 * Anycast routed us to (the `/health` `x-region` header) + our measured RTT there.
 * The matchmaker estimates our latency to every other region from these two values,
 * so we never have to ping each region separately (which CORS/`fly-prefer-region`
 * would make painful). `region` is '' if the server didn't send `x-region`. */
export interface HomeProbe {
  region: string;
  accessMs: number;
}

/** probe the connected server (over HTTP) for our home region + access latency.
 * `httpBase` is `gameServerHttpUrl()`. Returns null if the server is unreachable. */
export async function probeHome(
  httpBase: string,
  samples = 3,
  timeoutMs = 3000,
): Promise<HomeProbe | null> {
  const url = httpBase + '/health';
  let best: number | null = null;
  let region = '';
  for (let i = 0; i < samples; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const t0 = performance.now();
    try {
      const res = await fetch(url, { cache: 'no-store', signal: ctl.signal });
      if (res.ok) {
        await res.text().catch(() => {});
        const rtt = performance.now() - t0;
        if (best === null || rtt < best) {
          best = rtt;
          region = res.headers.get('x-region') ?? region;
        }
      }
    } catch {
      /* unreachable / aborted */
    } finally {
      clearTimeout(timer);
    }
  }
  return best === null ? null : { region, accessMs: best };
}

export function pingQuality(ms: number | null): PingQuality {
  if (ms === null) return 'down';
  if (ms < 80) return 'good';
  if (ms < 180) return 'fair';
  return 'poor';
}

/** ping every server in parallel → { [id]: ms | null } */
export async function pingAll(servers: GameServer[]): Promise<Record<string, number | null>> {
  const entries = await Promise.all(
    servers.map(async (s) => [s.id, await pingServer(s)] as const),
  );
  return Object.fromEntries(entries);
}

/** the id of the reachable server with the lowest ping, or null if all down */
export function fastestServer(pings: Record<string, number | null>): string | null {
  let bestId: string | null = null;
  let bestMs = Infinity;
  for (const [id, ms] of Object.entries(pings)) {
    if (ms !== null && ms < bestMs) {
      bestMs = ms;
      bestId = id;
    }
  }
  return bestId;
}
