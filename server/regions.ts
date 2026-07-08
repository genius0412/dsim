/**
 * Region topology for multi-region matchmaking (one Fly app, one machine per
 * region). This module is server infra — NOT `src/sim` — so wall-clock and plain
 * data are fine here; nothing in it feeds the deterministic step().
 *
 * The matchmaker never pings regions itself. Each client reports its `homeRegion`
 * (the region Fly's Anycast routed it to, read from the `/health` `x-region`
 * header) plus one measured `accessMs` (RTT to that home machine). We estimate the
 * client's latency to any OTHER region as `accessMs + INTER_REGION_MS[home][r]`,
 * using a static inter-region RTT matrix. The fair host for a group is the region
 * that MINIMISES the worst player's latency (minimax) — i.e. roughly "in the
 * middle", so nobody eats the whole cross-region penalty.
 */

/** the regions we actually deploy a machine to (keep in sync with `fly scale`) */
export const DEPLOY_REGIONS = ['iad', 'sjc', 'lhr', 'syd', 'nrt'] as const;
export type Region = (typeof DEPLOY_REGIONS)[number];

/** the always-on machine that holds the global ranked queue (fly-replay target for
 * `?mm=1` connections). Override per-deploy with MATCHMAKER_REGION. */
export const MATCHMAKER_REGION: string = process.env.MATCHMAKER_REGION ?? 'iad';

/**
 * Static, symmetric inter-region RTT estimates in milliseconds (diagonal = 0).
 * SEED VALUES — ballpark public-internet round trips between Fly regions; calibrate
 * from real `/health` pings after the multi-region deploy and tune here. Only the
 * relative ordering matters for host selection, so rough is fine to start.
 */
const RTT: Record<string, Record<string, number>> = {
  iad: { iad: 0, sjc: 60, lhr: 80, syd: 220, nrt: 150 },
  sjc: { sjc: 0, iad: 60, lhr: 140, syd: 160, nrt: 100 },
  lhr: { lhr: 0, iad: 80, sjc: 140, syd: 250, nrt: 230 },
  syd: { syd: 0, iad: 220, sjc: 160, lhr: 250, nrt: 110 },
  nrt: { nrt: 0, iad: 150, sjc: 100, lhr: 230, syd: 110 },
};

/** inter-region RTT (ms). Unknown regions fall back to a large penalty so an
 * unrecognised `homeRegion` never looks like a good host. */
export function interRegionMs(a: string, b: string): number {
  if (a === b) return 0;
  return RTT[a]?.[b] ?? RTT[b]?.[a] ?? 300;
}

/** one participant's reported network position */
export interface PingInfo {
  homeRegion: string;
  accessMs: number;
}

/** estimated RTT from a participant to a candidate host region */
export function estimatePing(p: PingInfo, r: string): number {
  return p.accessMs + interRegionMs(p.homeRegion, r);
}

/**
 * The fair host region for a group: the deployed region that minimises the WORST
 * participant's estimated ping (minimax → the geographic "middle"), so nobody eats
 * the whole cross-region penalty. Returns:
 *  - `hostRegion`: where to run the authoritative match.
 *  - `cost`: the worst participant's estimated ping AT that host (fairness metric).
 *  - `spread`: the worst participant's INTER-REGION component at that host — 0 when
 *    everyone shares the host's region. This is what the search-radius gate uses, so
 *    the gate is about "how far cross-region we'll reach", independent of any one
 *    player's own local connection quality (which is baked into `accessMs`).
 * Ties break on the lower total ping (kinder overall), then region order (determinism).
 */
export function bestHost(group: PingInfo[]): { hostRegion: string; cost: number; spread: number } {
  let best: { hostRegion: string; cost: number; spread: number; sum: number } | null = null;
  for (const r of DEPLOY_REGIONS) {
    let worst = 0;
    let spread = 0;
    let sum = 0;
    for (const p of group) {
      const ms = estimatePing(p, r);
      if (ms > worst) worst = ms;
      const inter = interRegionMs(p.homeRegion, r);
      if (inter > spread) spread = inter;
      sum += ms;
    }
    if (!best || worst < best.cost || (worst === best.cost && sum < best.sum)) {
      best = { hostRegion: r, cost: worst, spread, sum };
    }
  }
  return best
    ? { hostRegion: best.hostRegion, cost: best.cost, spread: best.spread }
    : { hostRegion: MATCHMAKER_REGION, cost: 0, spread: 0 };
}
