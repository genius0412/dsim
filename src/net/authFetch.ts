/**
 * THE AUTHENTICATED-REQUEST RULES, as pure functions — a LEAF module on purpose.
 *
 * `api.ts` and `authClient.ts` both read `import.meta.env` at load, which does not exist
 * outside the Vite build, so the headless smoke run cannot import either of them. The rules
 * that decide whether an account's data is read, retried or overwritten fail SILENTLY when they
 * are wrong, so they live here, take their I/O as arguments, and are tested directly.
 */

/** where a Bearer token comes from — `getAuthToken`'s shape; `force` skips the cache */
export type TokenSource = (force?: boolean) => Promise<string | null>;

/**
 * Send a request with `token`, and on a 401 send it ONCE more with a force-refreshed one.
 *
 * The token is cached in memory until it nears expiry (see `getAuthToken`), and the one case a
 * cache cannot predict is a session revoked server-side: the token is unexpired but no longer
 * accepted, and a 401 is exactly that signal. `authedJson` has always retried once on it; the
 * helpers that called `fetch` themselves never did, so a revoked session stayed broken on every
 * one of them — the settings sync, the practice upload, the admin console — until the cached
 * token finally expired on its own.
 *
 * ONCE, so a genuinely signed-out client fails fast rather than looping. When the refresh
 * yields nothing new (signed out, or the same token back) the original response is returned
 * as-is, so every caller keeps the status handling it already had.
 */
export async function sendWithTokenRetry<R extends { status: number }>(
  token: string,
  getToken: TokenSource,
  send: (token: string) => Promise<R>,
): Promise<R> {
  const res = await send(token);
  if (res.status !== 401) return res;
  const fresh = await getToken(true).catch(() => null);
  if (!fresh || fresh === token) return res;
  return send(fresh);
}

/** the parts of a `Response` the settings read looks at — structural, so a test can fake it */
export interface JsonResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/**
 * THE ACCOUNT'S SYNCED SETTINGS, OR `null` ONLY WHEN THE ACCOUNT GENUINELY HAS NONE.
 *
 * ⚠️ `null` IS A LICENCE TO OVERWRITE. `AccountSync` answers it by SEEDING the account from
 * this device's local settings, so it must mean "never saved" and nothing else. It used to
 * mean any of three things — no token, any non-OK status, and never saved — so a sign-in on a
 * fresh device while the game server was cold-booting (a 502 is routine: it auto-stops when
 * idle), or while the token fetch hiccuped, POSTed that device's defaults over the account's
 * real bindings, robots and starts.
 *
 * So everything that is not a successful answer THROWS: no response at all (no token while a
 * session exists is a transient, not a verdict), and any non-OK status. `AccountSync`'s catch
 * already lets a later render retry.
 */
export async function readAccountSettings(res: JsonResponse | null): Promise<unknown | null> {
  if (!res) throw new Error('Couldn’t read your account settings: no sign-in token yet.');
  if (!res.ok) throw new Error(`Couldn’t read your account settings (status ${res.status}).`);
  const data = (await res.json().catch(() => ({}))) as { settings?: unknown } | null;
  return data?.settings ?? null;
}

/** `exp` (ms) from a JWT payload, WITHOUT verifying it: the server checks the signature, the
 *  client only needs to know when to ask for a new one. */
export function jwtExpiryMs(jwt: string): number | null {
  try {
    const part = jwt.split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))) as {
      exp?: unknown;
    };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null; // unreadable ⇒ fall back to the short TTL, never fail a request
  }
}

/** renew this far ahead of `exp` so a token cannot expire in flight */
export const TOKEN_REFRESH_SKEW_MS = 60_000;
/**
 * only for a token with no readable `exp`: how long it is SERVED from the cache. The refresh skew
 * is added on top when it is stored, because the freshness test subtracts it — with the two
 * equal (both 60 s) and nothing added, such a token expired the instant it was cached and every
 * call went back to `/token`.
 */
export const TOKEN_FALLBACK_TTL_MS = 60_000;

export interface TokenCache {
  get(force?: boolean): Promise<string | null>;
  clear(): void;
}

/**
 * The in-memory JWT cache behind `getAuthToken`, with the two things it lacked.
 *
 * 1. **ONE FETCH AT A TIME.** At boot the admin check, the profile, the friends poll, the
 *    settings sync and the practice flush all miss an empty cache in the same tick, and each
 *    used to fire its own `/token` request — which Neon Auth answers by reading four tables out
 *    of the game's own Postgres. Concurrent callers now share the one in flight.
 * 2. **AN IDENTITY EPOCH.** `clear()` is called when the identity changes (sign-in, sign-out,
 *    an account switch). A fetch that STARTED before that and resolves after it is the previous
 *    identity's answer; caching it sent every later request — the settings save included — as
 *    the previous account until the token expired. Such a result still goes back to the caller
 *    that asked for it (its request was made under the old identity), but it is never cached,
 *    and nobody asking after the change joins it.
 *
 * `fetchToken` resolves the token, or null for a definite "no session"; it THROWS for a network
 * failure, which leaves the cache untouched rather than recording a miss.
 */
export function createTokenCache(
  fetchToken: () => Promise<string | null>,
  now: () => number = () => Date.now(),
): TokenCache {
  let cached: { token: string; expiresAtMs: number } | null = null;
  let epoch = 0;
  let inflight: { epoch: number; promise: Promise<string | null> } | null = null;

  const get = (force = false): Promise<string | null> => {
    if (!force && cached && now() < cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS) {
      return Promise.resolve(cached.token);
    }
    // a fetch already on the wire for THIS identity is as fresh as a new one would be
    if (inflight && inflight.epoch === epoch) return inflight.promise;
    const mine = epoch;
    const promise = fetchToken().then(
      (token) => {
        if (mine === epoch) {
          cached = token
            ? { token, expiresAtMs: jwtExpiryMs(token) ?? now() + TOKEN_FALLBACK_TTL_MS + TOKEN_REFRESH_SKEW_MS }
            : null;
        }
        return token;
      },
      () => null,
    );
    const entry = { epoch: mine, promise };
    inflight = entry;
    void promise.then(() => {
      if (inflight === entry) inflight = null;
    });
    return promise;
  };

  return {
    get,
    clear: () => {
      cached = null;
      epoch++;
      inflight = null;
    },
  };
}
