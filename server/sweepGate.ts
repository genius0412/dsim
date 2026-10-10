/**
 * WHEN TO SWEEP A RATE-LIMIT MAP.
 *
 * The limiters in `server/api.ts` and `server/analytics.ts` used to walk their whole map on
 * EVERY request to drop expired rows. That keeps the map small, but it makes each request cost
 * O(rows) on the one event loop that also runs every match on the machine — and the rows are
 * the thing an abuser controls (the analytics limiter keys on user-agent × address, so varying
 * one header mints rows at will). Sweeping at most once per `everyMs` keeps the map to "rows
 * seen in the last window plus one interval" and makes a request O(1).
 *
 * Correctness does not depend on the sweep: every limiter treats an expired row as absent when
 * it reads one, so a row that outlives its window by an interval is never counted against
 * anybody.
 */
export function sweepGate(everyMs: number): (now: number) => boolean {
  let next = 0;
  return (now: number): boolean => {
    if (now < next) return false;
    next = now + everyMs;
    return true;
  };
}

/** how often the request-path rate limiters sweep their maps */
export const RATE_SWEEP_EVERY_MS = 5_000;
