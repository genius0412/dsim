import { createAuthClient } from '@neondatabase/auth';
import { BetterAuthReactAdapter } from '@neondatabase/auth/react/adapters';

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
}
export interface AuthClient {
  useSession: () => { isPending: boolean; data: { user: NeonAuthUser } | null };
  getSession: () => Promise<{ data: { user: NeonAuthUser } | null }>;
  signIn: {
    email: (c: { email: string; password: string }) => Promise<unknown>;
    social: (o: { provider: string; callbackURL?: string }) => Promise<unknown>;
  };
  signUp: { email: (c: { email: string; password: string; name: string }) => Promise<unknown> };
  signOut: () => Promise<unknown>;
  getJWTToken?: () => Promise<string | null>;
}

export const authClient: AuthClient | null = url
  ? (createAuthClient(url, { adapter: BetterAuthReactAdapter() }) as unknown as AuthClient)
  : null;

/** the JWT the SERVER verifies to attribute a match to this user (null if signed
 * out or auth is off) */
export async function getAuthToken(): Promise<string | null> {
  if (!url) {
    console.log('[auth] getAuthToken: auth disabled (VITE_NEON_AUTH_URL unset)');
    return null;
  }
  // The SDK's getJWTToken() posts to a wrong route on this Neon Auth build
  // (`/get-j-w-t-token` → 404). The Better Auth JWT plugin serves a fresh JWT at
  // `GET ${authURL}/token` using the session cookie, so fetch that directly. The
  // server verifies it against the same JWKS (EdDSA).
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/token`, { credentials: 'include' });
    if (!res.ok) {
      console.log(`[auth] getAuthToken: /token → ${res.status} (signed out or CORS?)`);
      return null;
    }
    const data = (await res.json()) as { token?: string };
    const token = data.token ?? null;
    console.log(`[auth] getAuthToken: token=${token ? `yes(len ${token.length})` : 'null'}`);
    return token;
  } catch (e) {
    console.log('[auth] getAuthToken failed:', e);
    return null;
  }
}
