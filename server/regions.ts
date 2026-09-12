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

/**
 * The regions we actually deploy a machine to (keep in sync with `fly scale`).
 *
 * ⚠️ THIS LIST DRIFTING BEHIND THE FLEET IS A SILENT MATCHMAKING OUTAGE, not a
 * cosmetic staleness. `interRegionMs` answers `RTT_UNKNOWN` for anything it has no
 * row for, and that penalty is `RADIUS_MAX_MS` — so every player whose Anycast
 * landing region is missing here reads as maximally far from everywhere, INCLUDING
 * from the person sitting next to them. Measured with `ord` absent: two players both
 * in Chicago got `spread` 300 against an opening ceiling of 90, so they could not be
 * paired for the first SIX SECONDS, and never at all if either had asked to stay
 * region-local (`noWiden` pins the ceiling at 0). Their match then hosted in `iad`.
 *
 * `ord` had a live machine and was missing from this list. When adding a region to
 * the fleet, add it HERE and to `RTT` in the same change.
 */
export const DEPLOY_REGIONS = ['iad', 'ord', 'sjc', 'lhr', 'syd', 'nrt'] as const;
export type Region = (typeof DEPLOY_REGIONS)[number];

/** the always-on machine that holds the global ranked queue (fly-replay target for
 * `?mm=1` connections). Override per-deploy with MATCHMAKER_REGION. */
export const MATCHMAKER_REGION: string = process.env.MATCHMAKER_REGION ?? 'iad';

/**
 * Static, symmetric inter-region RTT in milliseconds (diagonal = 0). MEASURED
 * 2026-07-08 machine-to-machine over Fly's 6PN mesh (TCP handshake to each region's
 * hallpass), symmetric averages rounded. Re-measure + retune when the region set or
 * Fly's backbone changes (see docs/deploy.md). Only relative ordering matters for
 * host selection, so small drift is harmless.
 */
const RTT: Record<string, Record<string, number>> = {
  iad: { iad: 0, ord: 22, sjc: 85, lhr: 76, syd: 190, nrt: 164, gru: 118, jnb: 228 },
  ord: { ord: 0, iad: 22, sjc: 55, lhr: 95, syd: 195, nrt: 155, gru: 135, jnb: 245 },
  sjc: { sjc: 0, iad: 85, ord: 55, lhr: 133, syd: 148, nrt: 109, gru: 190, jnb: 285 },
  lhr: { lhr: 0, iad: 76, ord: 95, sjc: 133, syd: 251, nrt: 236, gru: 185, jnb: 155 },
  syd: { syd: 0, iad: 190, ord: 195, sjc: 148, lhr: 251, nrt: 114, gru: 315, jnb: 395 },
  nrt: { nrt: 0, iad: 164, ord: 155, sjc: 109, lhr: 236, syd: 114, gru: 265, jnb: 355 },
  // gru (São Paulo) and jnb (Johannesburg) have live machines but are NOT in
  // DEPLOY_REGIONS, deliberately: both run at 512MB, which is under the 1024 the
  // deploy script's own note says Node+Rapier needs, so they should not be chosen to
  // HOST a match yet. They still need rows here — without one their players read as
  // 300ms from everywhere and wait the full six seconds to be matched at all. With a
  // row they are simply far, and pair to a real host on the normal schedule.
  gru: { gru: 0, iad: 118, ord: 135, sjc: 190, lhr: 185, syd: 315, nrt: 265, jnb: 340 },
  jnb: { jnb: 0, iad: 228, ord: 245, sjc: 285, lhr: 155, syd: 395, nrt: 355, gru: 340 },
};

/**
 * ⚠️ THE `ord` / `gru` / `jnb` ROWS ARE ESTIMATED, NOT MEASURED — unlike the five
 * regions above them, which were taken machine-to-machine over Fly's 6PN mesh on the
 * date in the block comment. They are derived for triangle consistency with those
 * measurements (ord→sjc 55 against iad→sjc 85 and iad→ord 22; ord→nrt 155 against
 * sjc→nrt 109 + 55) and from the geography, and they are all well inside the ordering
 * the selection actually depends on. Re-measure them with the same method on the next
 * deploy that can reach the mesh, and delete this note when you do.
 *
 * They are still enormously better than their absence: the fallback for a missing row
 * is `RTT_UNKNOWN`, which equals the widest ceiling the schedule ever reaches, so an
 * unlisted region is not "far", it is "unpairable until the radius saturates".
 */

/** the penalty for a region we have no row for. Deliberately `RADIUS_MAX_MS`-sized so
 * an unrecognised `homeRegion` never looks like a good host — but note the corollary,
 * that it also makes such a player nearly unpairable. See DEPLOY_REGIONS. */
const RTT_UNKNOWN = 300;

/** inter-region RTT (ms). Unknown regions fall back to a large penalty so an
 * unrecognised `homeRegion` never looks like a good host. */
export function interRegionMs(a: string, b: string): number {
  if (a === b) return 0;
  return RTT[a]?.[b] ?? RTT[b]?.[a] ?? RTT_UNKNOWN;
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
