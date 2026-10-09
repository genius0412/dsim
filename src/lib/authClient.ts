import { createAuthClient } from '@neondatabase/auth';
import { BetterAuthReactAdapter } from '@neondatabase/auth/react/adapters';
import { createTokenCache } from '../net/authFetch';

/**
 * Neon Auth (Better Auth) client. One env var — `VITE_NEON_AUTH_URL` (the hosted
 * auth endpoint from the Neon dashboard → Auth tab). Absent ⇒ auth disabled and
 * the app runs exactly as before (solo/anonymous). The server attributes a run by
 * verifying the JWT from `getAuthToken()` (see server/auth.ts), so identity is
 * server-verified, not client-asserted.
 */

const url = import.meta.env.VITE_NEON_AUTH_URL as string | undefined;

export const authEnabled = !!url;

/** the beta SDK's typed surface varies by adapter; the React adapter adds
 * `useSession`. A loose local type keeps our call sites honest without depending
 * on the beta d.ts shape. */
export interface NeonAuthUser {
  id: string;
  name?: string;
  email?: string;
  /**
   * Has this address been confirmed by opening the link in the verification
   * email? Better Auth carries it on the session user, and a Google sign-in
   * arrives already true — the provider vouched for the address.
   *
   * OPTIONAL because it is only as present as the SDK makes it: an older adapter,
   * or a session shape that changes under us, has to read as “not told” rather
   * than as “not verified”. Every caller here treats `undefined` as verified for
   * exactly that reason — the banner is a client-side nudge, and the gate that
   * actually bites is the server's, off the JWT (see server/auth.ts).
   */
  emailVerified?: boolean;
}
export interface AuthClient {
  useSession: () => { isPending: boolean; data: { user: NeonAuthUser } | null };
  getSession: () => Promise<{ data: { user: NeonAuthUser } | null }>;
  signIn: {
    email: (c: { email: string; password: string }) => Promise<unknown>;
    /** `disableRedirect` returns the provider URL instead of navigating to it (the desktop pop-up) */
    social: (o: { provider: string; callbackURL?: string; disableRedirect?: boolean }) => Promise<unknown>;
  };
  signUp: { email: (c: { email: string; password: string; name: string }) => Promise<unknown> };
  signOut: () => Promise<unknown>;
  getJWTToken?: () => Promise<string | null>;
}

export const authClient: AuthClient | null = url
  ? (createAuthClient(url, { adapter: BetterAuthReactAdapter() }) as unknown as AuthClient)
  : null;

/**
 * The live JWT, cached in memory until it is nearly expired.
 *
 * Every authenticated call used to fetch a brand-new token first, and Neon Auth
 * serves `/token` by reading `session`, `user`, `jwks` and `project_config` out of
 * the SAME Postgres the game uses. With the friends panel polling on a timer that
 * came to roughly ten token fetches a minute per signed-in tab, each one a fresh
 * set of database reads for a token the previous request had already proved good.
 * On an otherwise empty site it was the largest single source of database traffic,
 * and it put a network round trip in front of every authenticated request.
 *
 * A JWT is a bearer credential with an expiry; reusing it until then is the whole
 * point of one. `exp` is read off the token rather than assumed, so this tracks
 * whatever lifetime Neon Auth issues without hardcoding it.
 */
/**
 * The cache itself — dedupe of concurrent fetches, and the identity epoch that keeps a token
 * fetched before a sign-out from being cached after it — lives in `createTokenCache`
 * (`src/net/authFetch.ts`), a leaf module the headless smoke run can import. This file reads
 * `import.meta.env` at load and cannot be.
 */
const tokens = createTokenCache(fetchToken);

/** one `/token` round trip. Null for a definite "no session"; THROWS for a network failure,
 *  which the cache treats as "leave what you have" rather than as a miss. */
async function fetchToken(): Promise<string | null> {
  if (!url) return null;
  // The SDK's getJWTToken() posts to a wrong route on this Neon Auth build
  // (`/get-j-w-t-token` → 404). The Better Auth JWT plugin serves a fresh JWT at
  // `GET ${authURL}/token` using the session cookie, so fetch that directly. The
  // server verifies it against the same JWKS (EdDSA).
  let res: Response;
  try {
    res = await fetch(`${url.replace(/\/$/, '')}/token`, { credentials: 'include' });
  } catch (e) {
    console.log('[auth] getAuthToken failed:', e);
    throw e;
  }
  if (!res.ok) {
    console.log(`[auth] getAuthToken: /token → ${res.status} (signed out or CORS?)`);
    return null;
  }
  const data = (await res.json().catch(() => ({}))) as { token?: string };
  return data.token ?? null;
}

/**
 * Drop the cached token. Called on sign-in and sign-out (the identity changed) and
 * on a 401 from our own API — a session revoked server-side leaves the cached token
 * stale even though it has not expired, and only a fresh fetch can discover that.
 * It also bumps the cache's identity epoch, so a `/token` fetch already in flight for
 * whoever was here before cannot land in the cache afterwards.
 */
export function clearAuthToken(): void {
  tokens.clear();
}

/** the JWT the SERVER verifies to attribute a match to this user (null if signed
 * out or auth is off). `force` bypasses the cache, for a retry after a 401. */
export async function getAuthToken(force = false): Promise<string | null> {
  if (!url) return null;
  return tokens.get(force);
}
