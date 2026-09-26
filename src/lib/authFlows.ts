/**
 * AUTH FLOWS — the ONE module that calls Neon Auth's password-reset and
 * email-verification endpoints.
 *
 * ⚠️ WHY IT IS ONE FILE. `@neondatabase/auth` is a BETA SDK (0.4.2-beta, pinned
 * exactly in package.json) wrapping Better Auth, whose client surface is
 * generated from the server's route table — so a method can be renamed by a
 * dependency bump nobody in this repo made. Every call below is therefore made
 * here and nowhere else: an SDK rename is a one-file fix, and the four exported
 * functions are what the UI is written against.
 *
 * THE EXACT SIGNATURES THIS FILE DEPENDS ON, read out of
 * `node_modules/@neondatabase/auth/dist/better-auth-react-adapter-D53HN_n5.d.mts`
 * (line numbers at the version pinned today):
 *
 *   1668  requestPasswordReset({ email: string; redirectTo?: string })
 *           → { status: boolean; message: string }
 *   1545  resetPassword({ newPassword: string; token?: string })
 *           → { status: boolean }
 *   1578  sendVerificationEmail({ email: string; callbackURL?: string })
 *           → { status: boolean }
 *   1562  verifyEmail({ query: { token: string; callbackURL?: string } })
 *           → { status: boolean } | void
 *   1128  emailOtp.verifyEmail({ email: string; otp: string })
 *           → { status: boolean; token: string | null; user }
 *
 * ⚠️ NEON AUTH VERIFIES WITH A CODE, NOT A LINK. `sendVerificationEmail` is the
 * right call to SEND (the SDK's own Supabase adapter resends through it), but
 * the email it produces carries a one-time code, and the SDK's adapter answers a
 * link-style verification with "Magic link verification is not supported. Use
 * email OTP authentication instead." So the code is completed through
 * `emailOtp.verifyEmail`, which `verifyEmailCode` wraps. The token path stays for
 * a project configured to send links; nothing in this build sends one today.
 *
 * ⚠️ `forgetPassword` — which the roadmap named — is NOT a top-level method on
 * this build. The only `forgetPassword` in the .d.mts is `forgetPassword.emailOtp`
 * (line 1207), a one-time-code variant we do not use. The top-level request is
 * `requestPasswordReset`, Better Auth's current name for the same route, and that
 * is what this file calls. Likewise the `emailOtp.*` and `phoneNumber.*` variants
 * are deliberately untouched: they are different flows, not aliases.
 *
 * NOTHING HERE THROWS AT THE UI. Every function answers a discriminated
 * `AuthFlowResult`, so a screen renders a sentence instead of an unhandled
 * rejection. The sentences live here too, beside the code that decides which one
 * applies (the `adminCopy.ts` precedent — five spellings of one failure had
 * accumulated across two files before that).
 *
 * NO DOM AND NO SDK AT MODULE SCOPE. `src/lib/authClient.ts` reads
 * `import.meta.env`, which is a TypeError under plain Node — so the client is
 * resolved by a DYNAMIC import inside each call. That is what lets the headless
 * smoke import this module and exercise the result shapes against a stub client
 * with no network and no bundler. The dynamic import costs nothing at runtime:
 * `authClient` is already in the main chunk (App, Account and AuthPanel import it
 * statically), so this resolves to the module that is loaded either way.
 */
import { inDiscordActivity } from '../net/discordActivity';
import { SITE_URL } from '../seo';

// ---------------------------------------------------------------- the SDK ---

/** Better Fetch's response union — `{data, error: null} | {data: null, error}`.
 *  Declared locally so this file depends on a SHAPE rather than on a type the
 *  beta SDK re-exports from a transitive dependency. */
export interface SdkError {
  code?: string;
  message?: string;
  status?: number;
  statusText?: string;
}
export type SdkResponse<T> = { data: T | null; error: SdkError | null };

/**
 * The four methods this module uses, and nothing else. `authClient` is cast to
 * this — the hand-typed `AuthClient` in `authClient.ts` covers the session and
 * sign-in surface the rest of the app calls directly, and widening it for four
 * methods only this file touches would put the SDK's names back in two places.
 */
export interface AuthFlowsClient {
  requestPasswordReset: (a: { email: string; redirectTo?: string }) => Promise<
    SdkResponse<{ status: boolean; message?: string }>
  >;
  resetPassword: (a: { newPassword: string; token?: string }) => Promise<
    SdkResponse<{ status: boolean }>
  >;
  sendVerificationEmail: (a: { email: string; callbackURL?: string }) => Promise<
    SdkResponse<{ status: boolean }>
  >;
  verifyEmail: (a: { query: { token: string; callbackURL?: string } }) => Promise<
    SdkResponse<{ status: boolean } | void>
  >;
  emailOtp: {
    verifyEmail: (a: { email: string; otp: string }) => Promise<SdkResponse<{ status: boolean }>>;
    sendVerificationOtp: (a: {
      email: string;
      type: 'sign-in' | 'email-verification' | 'forget-password';
    }) => Promise<SdkResponse<{ success: boolean }>>;
    resetPassword: (a: { email: string; otp: string; password: string }) => Promise<
      SdkResponse<{ success: boolean }>
    >;
  };
  listAccounts: () => Promise<SdkResponse<{ providerId: string }[]>>;
}

/** resolved lazily — see the module note. Null when auth is off in this build. */
async function liveClient(): Promise<AuthFlowsClient | null> {
  const { authClient } = await import('./authClient');
  return (authClient as unknown as AuthFlowsClient | null) ?? null;
}

// ------------------------------------------------------------- the result ---

/**
 * Why a flow did not complete. The UI switches on this, never on a message
 * string, so the copy can change without breaking a branch.
 */
export type AuthFlowFailure =
  | 'unavailable' // auth is not configured in this build
  | 'invalid-token' // expired, already spent, or not ours
  | 'invalid-code' // the emailed code was wrong, expired, or tried too often
  | 'invalid-credentials' // the email/password pair was rejected — see `describeAuthError`
  | 'weak-password'
  | 'invalid-email'
  | 'rate-limited'
  | 'network'
  | 'unknown';

export type AuthFlowResult = { ok: true } | { ok: false; reason: AuthFlowFailure; message: string };

/**
 * The shortest password the auth server accepts (Better Auth's default minimum).
 * Checked HERE as well so a too-short password is refused before a round trip
 * that would answer with the same thing a second later.
 */
export const PASSWORD_MIN = 8;

/** one sentence per failure — `Couldn’t <verb>.` plus a concrete next step
 *  (docs/area/ui.md). No "Something went wrong." */
const MESSAGES: Record<AuthFlowFailure, string> = {
  unavailable: 'Accounts are turned off in this build.',
  'invalid-token':
    'That link has expired or has already been used. Request a new one and open it from the newest email.',
  'invalid-code': 'That code is wrong or has expired. Check the newest email, or send a new code.',
  'invalid-credentials': 'That email and password don’t match an account. Check both and try again.',
  'weak-password': `Passwords need at least ${PASSWORD_MIN} characters.`,
  'invalid-email': 'That doesn’t look like an email address.',
  'rate-limited': 'Too many attempts. Wait a minute, then try again.',
  network: 'Couldn’t reach the sign-in service. Check your connection and try again.',
  unknown: 'Couldn’t complete that. Try again in a moment.',
};

/**
 * The site's bare host, for copy that tells somebody where to go ('playdsim.com').
 *
 * Derived from `SITE_URL` rather than typed out, so a domain change moves ONE constant —
 * and exported because the three embed surfaces that name it (`Account`, `FriendsPanel`
 * and the sentence below) would otherwise each carry their own literal. It is deliberately
 * NOT a link: `target="_blank"` is unreliable inside Discord's frame, and an anchor without
 * a target would navigate the activity away from itself.
 */
export const SITE_HOST = SITE_URL.replace(/^https?:\/\/(?:www\.)?/, '');

/**
 * ⚠️ "CHECK YOUR CONNECTION" IS A LIE INSIDE A DISCORD ACTIVITY.
 *
 * The embed is a cross-origin iframe whose CSP admits only Discord's own URL mappings, and
 * the auth host is not one of them — so the sign-in fetch is refused by the BROWSER, before
 * any network is involved, and rejects with a bare `TypeError` carrying no status and no
 * code. That is exactly the shape this module reads as "the transport failed", which is how
 * a player sitting in a working voice call, on a page showing a live player count, was told
 * to check their connection and try again. Retrying cannot work: signing in there is not
 * slow or flaky, it is impossible.
 *
 * The replacement states what is TRUE and what to do instead, and claims no cause it cannot
 * observe — `inDiscordActivity()` says where we are, never why a particular fetch failed.
 * Outside the embed the original sentence is right and is kept.
 */
export function authUnreachableMessage(): string {
  return inDiscordActivity()
    ? `Accounts aren’t available inside Discord. Open ${SITE_HOST} in a browser to sign in.`
    : MESSAGES.network;
}

const fail = (reason: AuthFlowFailure): AuthFlowResult => ({
  ok: false,
  reason,
  // the REASON is unchanged (the UI switches on it, never on the string) — only the
  // sentence differs, because in the embed that failure has a different remedy
  message: reason === 'network' ? authUnreachableMessage() : MESSAGES[reason],
});

/**
 * An SDK error → one of ours.
 *
 * ⚠️ TWO CODE VOCABULARIES REACH THIS, and it has to speak both. Better Auth
 * answers with SCREAMING_SNAKE (`INVALID_TOKEN`, `PASSWORD_TOO_SHORT`), and the
 * Neon adapter re-labels what it THROWS with its own lower_snake set (`bad_jwt`,
 * `weak_password`, `email_address_invalid`, `over_request_rate_limit` — see
 * `BETTER_AUTH_ERROR_MAP` in the SDK's `better-auth-helpers`). Upper-casing first
 * makes one set of substring tests cover both; the HTTP status is the fallback for
 * a failure carrying no code at all. Matching on the MESSAGE would break the first
 * time either upstream reworded one of its own sentences.
 *
 * ORDER MATTERS: `over_email_send_rate_limit` contains EMAIL, so rate limiting is
 * tested before the address.
 */
export function classifySdkError(error: SdkError | null | undefined): AuthFlowFailure {
  if (!error) return 'unknown';
  const code = (error.code ?? '').toUpperCase();
  if (code.includes('TOKEN') || code.includes('JWT') || code.includes('EXPIRED')) {
    return 'invalid-token';
  }
  if (code.includes('PASSWORD')) return 'weak-password';
  if (code.includes('RATE_LIMIT')) return 'rate-limited';
  if (code.includes('EMAIL') && !code.includes('VERIF')) return 'invalid-email';
  const status = error.status ?? 0;
  if (status === 429) return 'rate-limited';
  // 400/401/403 on any of these four routes means the TOKEN is what was rejected:
  // the address is never checked (see the enumeration note below) and the caller
  // supplies nothing else the server could object to.
  if (status === 400 || status === 401 || status === 403) return 'invalid-token';
  if (status >= 500 || status === 0) return 'network';
  return 'unknown';
}

/**
 * ⚠️ A FAILED CALL ARRIVES AS A THROW, NOT AS `{ error }` — which is why this
 * exists, and it is not a formality.
 *
 * The Neon adapter installs its own `customFetchImpl`, and that function THROWS a
 * normalized `AuthApiError` on any non-2xx response rather than letting Better
 * Fetch's `throw: false` hand the error back on the result. So the `{data, error}`
 * union the .d.mts advertises is real but, on this build, `error` is essentially
 * never populated: every expired token and every weak password comes out of a
 * `catch`. Treating a throw as "the network failed" — which the first cut of this
 * file did, and which the browser pass caught — told somebody holding an expired
 * reset link to check their connection.
 *
 * Returns the error in the shape `classifySdkError` reads, or null when the throw
 * carries no status and no code, which is what a genuine transport failure looks
 * like.
 */
export function thrownAsSdkError(e: unknown): SdkError | null {
  if (!e || typeof e !== 'object') return null;
  const o = e as { status?: unknown; code?: unknown; message?: unknown };
  const status = typeof o.status === 'number' ? o.status : undefined;
  const code = typeof o.code === 'string' ? o.code : undefined;
  if (status === undefined && code === undefined) return null;
  return { status, code, message: typeof o.message === 'string' ? o.message : undefined };
}

/**
 * THE SENTENCE FOR A THROW OFF THE SESSION SURFACE — `signIn.email`, `signUp.email`,
 * `signIn.social`. The UI calls those on `authClient` directly (they are not one of
 * the four flows this module wraps), but they come out of the same adapter and throw
 * the same normalized `AuthApiError`, so they get the same treatment. `AuthPanel` was
 * printing `err.message` raw, which is how "Failed to fetch" reached a sign-in form.
 *
 * ⚠️ IT IS NOT `classifySdkError`, AND THE DIFFERENCE IS ONE LINE OF ITS DOC COMMENT:
 * there, a bare 400/401/403 means THE TOKEN was rejected, because those four routes
 * take nothing else the server could object to. On a sign-in the caller supplies an
 * email and a password, so the same status means the CREDENTIALS were rejected —
 * routing it through the other function would answer a mistyped password with "that
 * link has expired". Everything that is genuinely route-independent (the rate-limit
 * and transport rules, and both upstream code vocabularies) is shared.
 *
 * `fallback` is the CALLER'S sentence for `unknown`, because only the caller knows
 * which action failed ("Couldn’t sign in." vs "Couldn’t create the account."), and
 * naming the action is the house rule (docs/area/ui.md).
 */
export function describeAuthError(e: unknown, fallback: string): string {
  const err = thrownAsSdkError(e);
  // no status and no code ⇒ the transport failed, the same judgement `run` makes — and
  // inside the embed that is the CSP refusing the host, which has its own sentence
  if (!err) return authUnreachableMessage();
  const code = (err.code ?? '').toUpperCase();
  const status = err.status ?? 0;
  // ORDER, as in `classifySdkError`: `over_email_send_rate_limit` contains EMAIL.
  if (code.includes('RATE_LIMIT') || status === 429) return MESSAGES['rate-limited'];
  if (code.includes('PASSWORD_TOO_SHORT') || code.includes('WEAK_PASSWORD')) {
    return MESSAGES['weak-password'];
  }
  if (code.includes('EMAIL') && !code.includes('VERIF') && !code.includes('EXIST')) {
    return MESSAGES['invalid-email'];
  }
  if (status >= 500 || status === 0) return authUnreachableMessage();
  // ⚠️ AN ALREADY-TAKEN ADDRESS IS A 400 TOO, and it is not a wrong password — so it takes
  // the caller's sentence rather than the credential one. It gets no sentence of its own
  // here on purpose: "an account already uses that email" is the enumeration disclosure the
  // note above refuses to write, and adding it is a product decision, not an audit fix.
  if (code.includes('EXIST') || code.includes('ALREADY')) return fallback;
  if (status === 400 || status === 401 || status === 403) return MESSAGES['invalid-credentials'];
  return fallback;
}

/**
 * ⚠️ "THERE IS NO ACCOUNT WITH THAT ADDRESS" IS NOT SOMETHING WE MAY SAY.
 *
 * Better Auth answers the reset request with success whether or not the address is
 * known, which is the correct behaviour — but a deployment, a plugin or a later
 * version could answer `USER_NOT_FOUND` instead, and that turns an unauthenticated
 * form into an account-enumeration oracle: feed it a list, read which addresses
 * error, and you know who has an account here. So the one flow that takes a bare
 * email swallows exactly that answer and reports success.
 */
const ACCOUNT_EXISTENCE = (e: SdkError): boolean =>
  /USER_NOT_FOUND|USER_EMAIL_NOT_FOUND|ACCOUNT_NOT_FOUND/.test((e.code ?? '').toUpperCase());

/** call an SDK method and answer a result — never a throw, never a rejection.
 *  `okDespite` names the failures this particular flow must report as success. */
async function run<T>(
  call: () => Promise<SdkResponse<T>>,
  okDespite?: (e: SdkError) => boolean,
): Promise<AuthFlowResult> {
  let err: SdkError | null;
  try {
    const res = await call();
    err = res?.error ?? null;
    if (!err) return { ok: true };
  } catch (e) {
    err = thrownAsSdkError(e);
    if (!err) return fail('network'); // no status, no code ⇒ the transport failed
  }
  if (okDespite?.(err)) return { ok: true };
  return fail(classifySdkError(err));
}

// ------------------------------------------------------------- the URLs -----

/** the app's own routes the auth server sends people back to */
export const RESET_PATH = '/account/reset';
export const VERIFY_PATH = '/account/verify';

/**
 * An absolute URL for one of this app's routes — the link inside an email, and the
 * two legal documents the terms gate links out to.
 *
 * ORIGIN-RELATIVE where there is an origin, so a Vercel preview deployment sends
 * people back to that preview rather than to production. Under Electron the
 * document is `file://`, where an origin is meaningless in an email — so the
 * desktop app points at the live site, which is where the desktop shell loads
 * from anyway whenever it is online.
 */
export function appUrl(path: string): string {
  const loc = typeof window === 'undefined' ? null : window.location;
  const origin = loc && /^https?:$/.test(loc.protocol) ? loc.origin : SITE_URL;
  return origin + path;
}

// ------------------------------------------------------------ the flows -----

/** a very loose address check — the auth server is the authority, this only
 *  avoids a round trip for something that is obviously not one */
const looksLikeEmail = (s: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

/**
 * (1) "I forgot my password" — send the reset email.
 *
 * ⚠️ ALWAYS ANSWERS `ok` FOR A WELL-FORMED ADDRESS THE SERVER ACCEPTED. Whether
 * an account exists is not something this is allowed to reveal: a form that says
 * "no account with that email" is an account-enumeration oracle, and this one is
 * unauthenticated. The caller shows the neutral "if an account exists, we sent a
 * link" line; the auth server behaves the same way and answers `status: true`
 * either way.
 */
export async function requestPasswordReset(email: string): Promise<AuthFlowResult> {
  if (!looksLikeEmail(email)) return fail('invalid-email');
  const client = await liveClient();
  if (!client) return fail('unavailable');
  return run(
    () =>
      client.requestPasswordReset({
        email: email.trim(),
        redirectTo: appUrl(RESET_PATH),
      }),
    ACCOUNT_EXISTENCE,
  );
}

/** (2) set the new password, using the token from the emailed link. */
export async function completePasswordReset(
  token: string,
  newPassword: string,
): Promise<AuthFlowResult> {
  if (!token.trim()) return fail('invalid-token');
  if (newPassword.length < PASSWORD_MIN) return fail('weak-password');
  const client = await liveClient();
  if (!client) return fail('unavailable');
  return run(() => client.resetPassword({ newPassword, token: token.trim() }));
}

/**
 * (3) send (or re-send) the verification email for an address.
 *
 * ⚠️ TAKES THE ADDRESS, unlike the zero-argument name the roadmap sketched: the
 * SDK's `sendVerificationEmail` requires `email`, and the caller always has it —
 * it is the signed-in session's own address, or the one just typed into the
 * sign-up form. Reading it back out of `getSession()` here would be a second
 * round trip to learn something the caller already knows.
 */
export async function requestEmailVerification(email: string): Promise<AuthFlowResult> {
  if (!looksLikeEmail(email)) return fail('invalid-email');
  const client = await liveClient();
  if (!client) return fail('unavailable');
  return run(() =>
    client.sendVerificationEmail({
      email: email.trim(),
      callbackURL: appUrl(VERIFY_PATH),
    }),
  );
}

/**
 * A typed code, as the server wants it: digits and letters only. People paste
 * "123 456" or "123-456" out of a mail client, and a space is not worth a
 * round trip that answers INVALID_OTP.
 */
export const normalizeCode = (code: string): string => code.replace(/[^0-9A-Za-z]/g, '');

/** the code's length, when the email's format is the Better Auth default. Only a
 *  hint for the input's `maxLength`; the server decides what a valid code is. */
export const CODE_MAX = 12;

/**
 * (5) complete verification with the code from the email — see the module note:
 * this is the one Neon Auth sends.
 *
 * A 400 or 403 here means the CODE was refused (Better Auth answers INVALID_OTP,
 * OTP_EXPIRED, or TOO_MANY_ATTEMPTS, and after the last one the code is gone),
 * so `invalid-token` is re-labelled `invalid-code`, whose sentence says to send a
 * new one rather than to open a link.
 */
export async function verifyEmailCode(email: string, code: string): Promise<AuthFlowResult> {
  const client = await liveClient();
  if (!client) return fail('unavailable');
  return codeFlow(client, email, code);
}

async function codeFlow(client: AuthFlowsClient, email: string, code: string): Promise<AuthFlowResult> {
  const otp = normalizeCode(code);
  if (!otp) return fail('invalid-code');
  if (!looksLikeEmail(email)) return fail('invalid-email');
  const r = await run(() => client.emailOtp.verifyEmail({ email: email.trim(), otp }));
  return !r.ok && r.reason === 'invalid-token' ? fail('invalid-code') : r;
}

/**
 * (6) SET OR CHANGE A PASSWORD BY CODE — Profile ▸ Account's Password row.
 *
 * This is how an account that signed in with GOOGLE gets a password, so it can sign
 * in either way. Better Auth's `/email-otp/reset-password` CREATES the `credential`
 * account when the user has none, and updates it when they do; the client-callable
 * `setPassword` does not exist (it is server-scoped). The code also proves the inbox,
 * and the route marks the address verified as a side effect.
 *
 * The code path rather than `requestPasswordReset`'s link, because the code is what
 * this Neon Auth project is known to deliver (the verification email is one).
 */
export async function requestPasswordCode(email: string): Promise<AuthFlowResult> {
  if (!looksLikeEmail(email)) return fail('invalid-email');
  const client = await liveClient();
  if (!client) return fail('unavailable');
  return sendPasswordCodeFlow(client, email);
}

async function sendPasswordCodeFlow(client: AuthFlowsClient, email: string): Promise<AuthFlowResult> {
  return run(
    () => client.emailOtp.sendVerificationOtp({ email: email.trim(), type: 'forget-password' }),
    ACCOUNT_EXISTENCE,
  );
}

export async function setPasswordWithCode(
  email: string,
  code: string,
  password: string,
): Promise<AuthFlowResult> {
  const client = await liveClient();
  if (!client) return fail('unavailable');
  return setPasswordFlow(client, email, code, password);
}

async function setPasswordFlow(
  client: AuthFlowsClient,
  email: string,
  code: string,
  password: string,
): Promise<AuthFlowResult> {
  const otp = normalizeCode(code);
  if (!otp) return fail('invalid-code');
  if (password.length < PASSWORD_MIN) return fail('weak-password');
  if (!looksLikeEmail(email)) return fail('invalid-email');
  const r = await run(() => client.emailOtp.resetPassword({ email: email.trim(), otp, password }));
  return !r.ok && r.reason === 'invalid-token' ? fail('invalid-code') : r;
}

/**
 * Does this account have a password login? `true` / `false` from the account list
 * (`credential` is Better Auth's provider id for email + password), `null` when the
 * list could not be read — the row then offers the neutral "Set or change" wording
 * rather than telling somebody with a password that they have none.
 */
export async function hasPasswordLogin(): Promise<boolean | null> {
  const client = await liveClient();
  if (!client) return null;
  return passwordLoginFlow(client);
}

async function passwordLoginFlow(client: AuthFlowsClient): Promise<boolean | null> {
  try {
    const res = await client.listAccounts();
    const list = res?.data;
    if (res?.error || !Array.isArray(list)) return null;
    return list.some((a) => a?.providerId === 'credential');
  } catch {
    return null;
  }
}

/** (4) complete verification from the emailed link's token. */
export async function completeEmailVerification(token: string): Promise<AuthFlowResult> {
  if (!token.trim()) return fail('invalid-token');
  const client = await liveClient();
  if (!client) return fail('unavailable');
  return run(() => client.verifyEmail({ query: { token: token.trim() } }));
}

// ------------------------------------------------------------ test seam -----

/**
 * Run the flows against a STUB client instead of the real one.
 *
 * Exported for `scripts/smoke.ts`, which asserts the RESULT SHAPES — that a
 * rejected token comes back `{ok: false, reason: 'invalid-token'}` rather than
 * throwing — with no network and no bundler. Production code never calls it, and
 * each entry is the body of its public twin with the client passed in rather than
 * resolved, so the classification and the guards under test are the shipped ones.
 */
export const authFlowsForTesting = {
  classifySdkError,
  thrownAsSdkError,
  async passwordReset(client: AuthFlowsClient, email: string): Promise<AuthFlowResult> {
    if (!looksLikeEmail(email)) return fail('invalid-email');
    return run(
      () => client.requestPasswordReset({ email, redirectTo: RESET_PATH }),
      ACCOUNT_EXISTENCE,
    );
  },
  async completeReset(client: AuthFlowsClient, token: string, pw: string): Promise<AuthFlowResult> {
    if (!token.trim()) return fail('invalid-token');
    if (pw.length < PASSWORD_MIN) return fail('weak-password');
    return run(() => client.resetPassword({ newPassword: pw, token }));
  },
  async sendVerification(client: AuthFlowsClient, email: string): Promise<AuthFlowResult> {
    if (!looksLikeEmail(email)) return fail('invalid-email');
    return run(() => client.sendVerificationEmail({ email, callbackURL: VERIFY_PATH }));
  },
  async completeVerification(client: AuthFlowsClient, token: string): Promise<AuthFlowResult> {
    if (!token.trim()) return fail('invalid-token');
    return run(() => client.verifyEmail({ query: { token } }));
  },
  verifyCode: codeFlow,
  sendPasswordCode: sendPasswordCodeFlow,
  setPassword: setPasswordFlow,
  hasPassword: passwordLoginFlow,
};
