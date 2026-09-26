import { createRemoteJWKSet, jwtVerify } from 'jose';
import { LAN_MODE } from './lanMode';
import { authEmailVerified } from './db/repo';

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

// Build the JWKS set defensively: a malformed NEON_AUTH_URL would make `new URL()`
// THROW at module load — and since this module is imported before `httpServer.listen()`,
// that throw crashes the whole process at boot (nothing binds → Fly reports "app not
// listening on 0.0.0.0:8080"). Degrade to anonymous instead of taking the server down.
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
// A LAN SERVER NEVER HANDLES ANYBODY'S CREDENTIALS — it is somebody's laptop, and a cloud
// session token handed to it is a cloud session token its operator now has. So it does not
// even build a verifier: every client on a self-hosted server is anonymous, which is the only
// thing it could usefully be on a server with no accounts and no database. The client half of
// the same rule strips the token before it is ever sent (`src/net/transport.ts`); this half is
// what makes the guarantee true of the SERVER rather than of the clients that happen to
// connect to it. See server/lanMode.ts.
if (JWKS_URL && !LAN_MODE) {
  try {
    jwks = createRemoteJWKSet(new URL(JWKS_URL));
  } catch (e) {
    console.error(`[auth] invalid NEON_AUTH_URL/JWKS_URL (${JWKS_URL}) — all runs anonymous:`, e);
  }
}
export const authConfigured = !!jwks;

console.log(
  LAN_MODE
    ? '[auth] LAN_MODE=1 — a self-hosted server verifies nothing; every client is anonymous'
    : `[auth] ${authConfigured ? `JWKS ${JWKS_URL}` : 'auth not configured — all runs anonymous'}`,
);

export interface AuthedUser {
  userId: string;
  handle: string;
  /**
   * Has this account confirmed its email address?
   *
   * THREE-VALUED ON PURPOSE. `true`/`false` are what the token (or the session
   * endpoint) said; `null` means nobody told us, which is a different thing from
   * "no" and is treated as a pass — see `emailGateRefusal`.
   */
  emailVerified: boolean | null;
}

/**
 * ---- THE VERIFIED-EMAIL GATE -------------------------------------------------
 *
 * OFF BY DEFAULT, and that is a deploy-order decision rather than timidity.
 * Verification has never existed here, so EVERY email/password account on the
 * live site is currently unverified — turning the gate on in the same push that
 * introduces it would refuse ranked to all of them at once, and the "resend"
 * button they would be sent to cannot help until the sender domain is configured
 * in the Neon Auth dashboard (an owner action; docs/deploy.md §4 has the steps).
 * So: ship the flows, let people verify, then set the secret.
 *
 *   REQUIRE_VERIFIED_EMAIL=1   refuse ranked + record/practice persistence to an
 *                              account whose address is not verified.
 *
 * Google sign-ins arrive verified — the provider vouched for the address — so the
 * gate only ever bites email/password accounts.
 */
const REQUIRE_VERIFIED = process.env.REQUIRE_VERIFIED_EMAIL === '1';

/** the one sentence, so the four refusal sites cannot drift apart */
export const VERIFY_EMAIL_REFUSAL =
  'Verify your email to play ranked. Enter the code we emailed you on your Profile page.';

/**
 * May this user do the things that need a verified address? The ONE predicate —
 * extend it rather than adding a second "is this account allowed" check anywhere.
 *
 * ⚠️ `null` (we were not told) COUNTS AS VERIFIED. The claim is optional on a beta
 * SDK's token, and the session fallback below can fail for reasons that have
 * nothing to do with the account. A gate whose unknown case is "refuse" would lock
 * every player out of ranked the first time an upstream stopped sending a field —
 * silently, and with no way for anyone to fix it from the client. The failure this
 * direction is one unverified account playing ranked; the other direction is the
 * whole feature going dark.
 */
export function emailGateRefusal(user: AuthedUser): string | null {
  if (!REQUIRE_VERIFIED) return null;
  return user.emailVerified === false ? VERIFY_EMAIL_REFUSAL : null;
}

/**
 * IS THE ADDRESS VERIFIED, WHEN THE TOKEN DID NOT SAY?
 *
 * Better Auth's JWT plugin signs whatever its `definePayload` returns, so whether
 * `email_verified` is on the token is a property of the Neon Auth project's
 * configuration rather than of this code. Both spellings are read off the payload
 * first (`email_verified` is the OIDC one, `emailVerified` the Better Auth field
 * name) and this is the fallback for a deployment whose tokens carry neither: Neon
 * Auth's own `neon_auth."user"` row first (`authEmailVerified`), then `/get-session`.
 *
 * ONE FETCH PER TOKEN, EVER. A token is a bearer credential with an hour of life
 * and the friends poll re-verifies it roughly twice a minute per open tab, so an
 * un-cached lookup here would put a second round trip in front of every
 * authenticated request — the exact cost `getAuthToken`'s cache exists to remove
 * on the client. The answer is memoized against the token STRING, including the
 * "could not tell" answer, so a failing endpoint is asked once and not once a
 * second. A player who verifies gets a NEW token (the client drops its cached one on
 * success), so a cached `false` never outlives the state it described in that tab. Entries die with the token; the map is bounded so a long-lived machine
 * cannot accumulate them.
 */
const verifiedByToken = new Map<string, boolean | null>();
const VERIFIED_CACHE_MAX = 2000;
// ONE FETCH PER TOKEN HAS TO MEAN ONE FETCH WHILE THE FIRST IS STILL OPEN, TOO. The answer
// cache above is only written when the fetch RESOLVES, so a tab that reconnects and fires its
// join plus a friends poll plus a profile read at once would open one `/get-session` round trip
// EACH — the thundering herd the cache was supposed to remove. Concurrent callers for the same
// token string share the in-flight promise instead; the entry is dropped once it settles, and
// from then on the resolved answer is served out of `verifiedByToken`.
const verifiedInFlight = new Map<string, Promise<boolean | null>>();

async function verifiedFromStore(token: string, userId: string): Promise<boolean | null> {
  const hit = verifiedByToken.get(token);
  if (hit !== undefined) return hit;
  const flying = verifiedInFlight.get(token);
  if (flying) return flying;
  const pending = (async (): Promise<boolean | null> => {
    // NEON AUTH'S OWN TABLE FIRST. It lives in the database this server already uses, and
    // it is the row the verification code flips, so it needs no guess about what the
    // project's JWT carries. The session endpoint is the fallback for a deployment whose
    // database does not hold it (no DATABASE_URL, or auth on a different project).
    let answer: boolean | null = await authEmailVerified(userId);
    if (answer === null && AUTH_URL) {
      try {
        const res = await fetch(`${AUTH_URL.replace(/\/$/, '')}/get-session`, {
          headers: { authorization: `Bearer ${token}` },
          // A HUNG UPSTREAM MUST NOT HANG THE JOIN. Without a deadline this `await` is however
          // long the platform's socket timeout is (minutes), and it sits in front of the join
          // handshake — an auth endpoint that stops answering would stall every sign-in rather
          // than degrade one field. An abort lands in the catch below, which is the fail-open
          // "not told" answer, so the timeout costs the gate nothing it was not already
          // prepared for.
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) {
          const body = (await res.json()) as { user?: { emailVerified?: unknown } } | null;
          const v = body?.user?.emailVerified;
          if (typeof v === 'boolean') answer = v;
        }
      } catch {
        // network, CORS, a route that does not exist on this build, our own 2 s abort — all of
        // them mean "not told", which the gate reads as verified. Never fatal.
      }
    }
    // FIFO eviction: a Map iterates in insertion order, so the oldest key is first.
    if (verifiedByToken.size >= VERIFIED_CACHE_MAX) {
      const oldest = verifiedByToken.keys().next().value;
      if (oldest !== undefined) verifiedByToken.delete(oldest);
    }
    verifiedByToken.set(token, answer);
    return answer;
  })();
  verifiedInFlight.set(token, pending);
  try {
    return await pending;
  } finally {
    // the answer is in `verifiedByToken` by now, so later callers hit the cache, not this map
    verifiedInFlight.delete(token);
  }
}


/** verify a client-supplied JWT → {userId, handle, emailVerified}, or null if
 *  absent/invalid. `emailVerified` is null when neither the token nor the session
 *  endpoint would say (see `verifiedFromStore`). */
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
    // BOTH SPELLINGS: `email_verified` is the OIDC claim name, `emailVerified` is
    // Better Auth’s own field, and which one a Neon Auth project signs is its
    // configuration rather than ours. Anything that is not a boolean is "not told".
    const claim = payload.email_verified ?? payload.emailVerified;
    // AND ONLY ASK THE SESSION ENDPOINT WHEN THE ANSWER CAN CHANGE A DECISION. With the gate
    // off — which is every deployment until the owner sets the secret — `null` and `false` lead
    // to the same place (`emailGateRefusal` returns null first thing), so a round trip on the
    // join path buys nothing at all. `null` is already the honest value for "not told".
    const emailVerified =
      typeof claim === 'boolean' ? claim : REQUIRE_VERIFIED ? await verifiedFromStore(token, userId) : null;
    // Deliberately NOT logged. The friends read doubles as the presence heartbeat, so
    // every signed-in browser tab re-verifies roughly twice a minute for as long as it
    // is open — a success line here meant an idle server with two users online emitted
    // thousands of identical lines a day, which is both the bulk of the log bill and the
    // noise that buries the failures below (the ones that actually explain a player being
    // silently signed out). Failures and misconfiguration still log; success is the
    // uninteresting case and is now silent.
    return {
      userId,
      handle: typeof name === 'string' && name ? name : 'Player',
      emailVerified,
    };
  } catch (e) {
    // expired / bad signature / unreachable-or-wrong JWKS ⇒ anonymous. Log why.
    console.log('[auth] verify FAILED:', e instanceof Error ? e.message : e);
    return null;
  }
}
