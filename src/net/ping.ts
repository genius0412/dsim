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
  const url = httpOf(s.url) + '/health';
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
