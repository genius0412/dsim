import { createRemoteJWKSet, jwtVerify } from 'jose';

/**
 * Server-side Neon Auth (Better Auth) session verification. The client sends the
 * JWT from `getAuthToken()` on `join`; we verify its signature against Neon Auth's
 * JWKS and read the subject as the user id. SECURE BY DEFAULT: a missing/invalid
 * token ⇒ null ⇒ the run is anonymous (dropped by persistMatch), never trusted.
 *
 * Config (server env — set as Fly secrets, NOT VITE_):
 *   NEON_AUTH_URL   the same base as the client's VITE_NEON_AUTH_URL
 *   NEON_AUTH_JWKS_URL  (optional) override the JWKS endpoint if Neon's differs
 *     from the Better Auth default `${NEON_AUTH_URL}/jwks`.
 *
 * NOTE (beta): the exact JWKS path + claim names should be confirmed against a
 * live token once (log a decoded token). Until the JWKS URL resolves, verify()
 * returns null and everything degrades to anonymous — no crash, no bad writes.
 */

const AUTH_URL = process.env.NEON_AUTH_URL;
// Neon Auth (Better Auth) publishes its JWKS at `${authURL}/.well-known/jwks.json`
// (EdDSA/Ed25519 keys) — verified against the live endpoint. Override with
// NEON_AUTH_JWKS_URL if it ever moves.
const JWKS_URL =
  process.env.NEON_AUTH_JWKS_URL ??
  (AUTH_URL ? `${AUTH_URL.replace(/\/$/, '')}/.well-known/jwks.json` : undefined);

export const authConfigured = !!JWKS_URL;

const jwks = JWKS_URL ? createRemoteJWKSet(new URL(JWKS_URL)) : null;

console.log(
  `[auth] ${authConfigured ? `JWKS ${JWKS_URL}` : 'NEON_AUTH_URL unset — all runs anonymous'}`,
);

export interface AuthedUser {
  userId: string;
  handle: string;
}

/** verify a client-supplied JWT → {userId, handle}, or null if absent/invalid */
export async function verifyAuthToken(token: string | undefined): Promise<AuthedUser | null> {
  if (!token) {
    console.log('[auth] verify: no token on join ⇒ anonymous');
    return null;
  }
  if (!jwks) {
    console.log('[auth] verify: JWKS not configured ⇒ anonymous');
    return null;
  }
  try {
    const { payload } = await jwtVerify(token, jwks);
    const userId = typeof payload.sub === 'string' ? payload.sub : undefined;
    if (!userId) {
      console.log('[auth] verify: token has no `sub` claim; claims=', Object.keys(payload).join(','));
      return null;
    }
    const name = payload.name ?? payload.email ?? undefined;
    console.log(`[auth] verify OK: user=${userId}`);
    return { userId, handle: typeof name === 'string' && name ? name : 'Player' };
  } catch (e) {
    // expired / bad signature / unreachable-or-wrong JWKS ⇒ anonymous. Log why.
    console.log('[auth] verify FAILED:', e instanceof Error ? e.message : e);
    return null;
  }
}
