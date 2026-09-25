import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { GameId } from '../src/types';
import { coerceGameId, isGameId, serverPhysics } from '../src/games/types';
import { simModuleFor } from '../src/games/sim';
import { authorizeUrl, exchangeForId, linkConfigured, readState } from './oauthLink';
import { runStarSweep } from './stargazers';
import { BALANCE_VERSION, SIM_DT } from '../src/config';
import { monthsFor, policyFromEnv, whyNoMonths } from './kofi';
import { CHALLENGE_FORMATS } from '../src/net/protocol';
import { sanitizeReplay } from '../src/net/sanitize';
import { moderateName, scrubName } from './moderation';
import { LAN_UPLOADS } from './lanUploads';
import { dbEnabled } from './db/pool';
import {
  acceptFriendRequest,
  actForSeason,
  boardPhysics,
  blockUser,
  cancelFriendRequest,
  cancelRoomInvite,
  currentSeasonNumber,
  declineFriendRequest,
  declineRoomInvite,
  dismissRoomInvite,
  addActivity,
  countPlay,
  ensureProfile,
  listPracticeRuns,
  savePracticeRun,
  listLanRuns,
  saveLanRun,
  LanRunOwnedByAnother,
  type LanParticipant,
  ensureSeason,
  inviteToRoom,
  listAnnouncements,
  listFriends,
  removeFriend,
  searchUsersByName,
  sendFriendRequest,
  setPresenceStatus,
  touchPresence,
  unblockUser,
  type Activity,
  type PresenceStatus,
  eloLeaderboard,
  eloHistoryLeaderboard,
  eloHistoryUserStanding,
  eloUserStanding,
  getGlobalStats,
  getProfile,
  getProfileByUsername,
  getReplay,
  getReplaysPublic,
  isStaffUser,
  replayAccess,
  replayRefusalMessage,
  setReplaysPublic,
  linkProvider,
  providerLinks,
  claimReward,
  revokeStargazer,
  rewardState,
  setEquippedBadges,
  unlinkProvider,
  type LinkProvider,
  getUserSettings,
  getUserStats,
  getSupporter,
  getCosmeticsUnlocks,
  getTermsAcceptance,
  acceptTerms,
  claimKofiPayment,
  recordKofiPayment,
  deleteAccount,
  exportAccount,
  listSeasons,
  recordLeaderboard,
  saveUserSettings,
  setHandle,
  setUsername,
  userMatchHistory,
  usernameAvailable,
  UsernameTakenError,
} from './db/repo';
import {
  analyticsReport,
  classify,
  clientIp,
  countryForTimezone,
  currentSalt,
  dimColumn,
  ensureAnalyticsJobs,
  headerCountry,
  insertEvent,
  insertPageview,
  isBot,
  parseEvent,
  parsePageview,
  primaryLang,
  productReport,
  rateOk,
  visitorHash,
  ADDRESS_LIMIT,
  VISITOR_LIMIT,
} from './analytics';
import { emailGateRefusal, verifyAuthToken } from './auth';
import { LEGAL_VERSION } from '../src/legalText';
import { DEPLOY_REGIONS, interRegionMs } from './regions';

/**
 * Public read API for the leaderboards + replay viewer (GET), plus ONE
 * authenticated write: a user editing their own display name (`POST
 * /api/user/handle`, JWT-verified — every other write still goes through the
 * authoritative match loop). Same port as the WS server. CORS-open because the
 * data is public and the client is a different origin (Vercel). Returns
 * empty/404 gracefully when the DB is disabled.
 *
 *   GET  /api/stats                          — site-wide players + games played
 *   POST /api/played {game, source, mode}    — count one practice / LAN match (public)
 *   GET  /api/records?mode=solo|duo&drivetrain=<dt|overall>&season=<n>&limit=<n>
 *   GET  /api/elo?mode=1v1|2v2&season=<n>&limit=<n>
 *   GET  /api/user/<id>/stats?season=<n>   — one user's ELO+records+W/L+history
 *   GET  /api/user/<id>                     — a user's public profile (handle)
 *   POST /api/user/handle  {handle}         — set your OWN display name (Bearer JWT)
 *   POST /api/user/username {username}       — claim your OWN unique username (Bearer JWT)
 *   GET  /api/username-available?u=<name>    — is a username free + valid-format?
 *   GET  /api/profile/<username>             — public profile by username (handle+id)
 *   GET  /api/profile/<username>/stats?season=<n> — one user's stats, by username
 *   GET  /api/user/settings                  — your synced settings (Bearer JWT)
 *   POST /api/user/settings {settings}       — save your settings (Bearer JWT)
 *   GET  /api/user/privacy                   — your replay-visibility setting (Bearer JWT)
 *   POST /api/user/privacy {replaysPublic}   — set it (Bearer JWT)
 *   GET  /api/user/title                     — RETIRED (0049): always no title, nothing earned
 *   POST /api/user/title {title}             — RETIRED: null is accepted, anything else 403
 *   GET  /api/user/rewards                   — pending rewards + badges + trophy case (JWT)
 *   POST /api/user/rewards/claim {id,equip}  — claim one, and with equip wear it (Bearer JWT)
 *   POST /api/user/badges {badges}           — wear these badges, in order (Bearer JWT)
 *   GET  /api/link/<p>/start                 — the authorize URL for github|discord (JWT)
 *   GET  /api/link/<p>/callback              — the provider's redirect; 302s into /account
 *   POST /api/link/<p>/unlink                — drop the link and its reward (Bearer JWT)
 *   GET  /api/user/export                    — everything we hold about you (Bearer JWT)
 *   GET  /api/replay/<id>                    — 403 when the people in it have not published it
 *
 *   GET  /api/friends                        — friends + requests + presence (Bearer JWT)
 *   POST /api/friends/request  {username}    — send (or auto-accept a reciprocal) request
 *   POST /api/friends/accept   {username}
 *   POST /api/friends/decline  {username}
 *   POST /api/friends/cancel   {username}    — withdraw one you sent
 *   POST /api/friends/remove   {username}
 *   POST /api/friends/block    {username} / /api/friends/unblock {username}
 *   POST /api/friends/status   {status}      — your own online/dnd/invisible
 *   POST /api/friends/invite   {username,room,game,kind,record?,format?} — challenge
 *                                               a friend (must be friends)
 *   POST /api/friends/invite/dismiss {id}    — dismiss/consume an invite sent to you
 *   POST /api/friends/invite/decline {id}    — decline one sent to you (sender is told)
 *   POST /api/friends/invite/cancel  {id}    — withdraw one you sent
 *   GET  /api/users/search?q=<prefix>        — public username-PREFIX search
 *
 *   POST /api/a/pv                           — one cookieless page view (public beacon)
 *   POST /api/a/ev                           — one named event (public beacon)
 *   GET  /api/analytics?from&to&game&grain&f — the traffic dashboard (staff only)
 *   GET  /api/analytics/product?from&to&game — matches, retention, ranked, … (staff only)
 */

/** Public usernames: lowercase letters + digits only, 4–20 chars. Kept in sync
 * with the client's validator (src/net/api.ts `USERNAME_RE`) and the DB's unique
 * index. Returns the normalized (trimmed, lowercased) value or null if invalid.
 *
 * CLAIM-TIME ONLY. Use `lookupUsername` for a name that identifies an EXISTING
 * account — see the note there. */
/** what a client from before titles folded into badges (0049) still reads off the reward
 *  routes. Constant, and never read by this build — see the `/api/user/rewards` note. */
const RETIRED_TITLE_FIELDS = { title: null, earnedTitles: [] as string[] };

const USERNAME_RE = /^[a-z0-9]{4,20}$/;
function normalizeUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const u = raw.trim().toLowerCase();
  return USERNAME_RE.test(u) ? u : null;
}

/** Normalize a username used as a LOOKUP KEY (naming someone else).
 *
 * This deliberately does NOT apply `USERNAME_RE`'s 4-char floor. A claim rule and
 * a lookup rule are different things: some live accounts hold a username that
 * predates today's minimum (e.g. a 3-char one), and running their name through
 * the CLAIM validator rejected it before the DB was ever consulted — so every
 * /api/friends action naming that player failed with a bare 400 "bad request",
 * accept included, with no way for either side to clear it. The public
 * /api/profile/<username> routes always did a plain lowercase-and-look-up, which
 * is why those pages worked for the same account while friends didn't.
 *
 * Bounds only what the DB column could ever hold; the query is parameterized. */
const USERNAME_LOOKUP_RE = /^[a-z0-9]{1,20}$/;
function lookupUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const u = raw.trim().toLowerCase();
  return USERNAME_LOOKUP_RE.test(u) ? u : null;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '600',
};

/**
 * Read a request body, up to `limit` bytes, and STOP at the limit.
 *
 * ⚠️ **REJECTING THE PROMISE DOES NOT STOP THE STREAM.** The previous version called
 * `reject()` on the first chunk that crossed the cap and then went on appending every
 * subsequent chunk to the same string, for as long as the sender cared to keep writing. So the
 * cap bounded what the handler would ACCEPT and bounded nothing at all about what the process
 * would HOLD: a single client could push a request body of any size it liked into the heap of
 * a server that had already refused it, and a handful of them in parallel is an out-of-memory
 * on a machine whose whole job is to be up.
 *
 * So the over-limit path detaches the listeners, drops the bytes it has, and destroys the
 * request. Destroying is what tells the sender to stop rather than merely ignoring them, and
 * the promise settles EXACTLY once either way (`settled`), because a destroy raises `error`
 * and a double-settle would otherwise be the norm rather than the exception.
 */
function readBody(req: IncomingMessage, limit = 512 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    let settled = false;
    const done = (err: Error | null, body = ''): void => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      if (err) reject(err);
      else resolve(body);
    };
    const onData = (c: Buffer | string): void => {
      data += c;
      if (data.length <= limit) return;
      data = ''; // let it go before anything else; the request is over
      done(new Error('body too large'));
      req.destroy();
    };
    const onEnd = (): void => done(null, data);
    const onError = (e: Error): void => done(e);
    const onAborted = (): void => done(new Error('request aborted'));
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

/**
 * THROTTLE FOR `/api/lan`, because it is the one authenticated route that accepts a REPLAY.
 *
 * Everything else here reads a board or writes a field; this one parses a tens-of-KB JSON
 * container, re-validates it through `sanitizeReplay`, moderates every name in the roster
 * (a hosted HTTP call per name) and then writes two rows. A signed-in account looping it is
 * not a leaderboard problem — `lan_runs` cannot reach a board — it is a COST and AVAILABILITY
 * problem: CPU on a machine that is also running match loops, and Neon compute that bills by
 * the wall-clock minute it is kept awake.
 *
 * Two limits, because they answer different questions. The per-account window answers "how
 * often may one person file matches" and is generous against the real workload: a venue plays
 * a match every few minutes and the backlog drains one at a time. The in-flight cap answers
 * "how much of this may be happening at once", across everybody, and is what keeps a burst
 * from turning into memory × concurrency.
 *
 * Deliberately per-ACCOUNT and not per-IP: the route is authenticated before it is reached, a
 * whole venue shares one NAT address, and rate-limiting the venue because one host is chatty
 * would break the feature for the room.
 */
const LAN_WINDOW_MS = 60_000;
const LAN_MAX_PER_WINDOW = 30;
/** BUCKETED, so `/api/practice` can share the implementation without sharing the budget —
 * a player draining a practice backlog must not spend a LAN host's allowance, or vice versa. */
const LAN_MAX_IN_FLIGHT = 4;
let lanInFlight = 0;
const lanRate = new Map<string, { n: number; until: number }>();

function uploadRateOk(bucket: string, userId: string): boolean {
  const key = `${bucket}:${userId}`;
  const now = Date.now();
  // Sweep on the way past, so an idle server does not keep a map of everyone who ever posted.
  // UNCONDITIONAL, and that is the point: gating the sweep on `size > 1000` made the map grow
  // to 1000 before anything was ever collected, and 1001 DISTINCT accounts inside one window is
  // exactly the case where no entry is expired yet and the sweep frees nothing anyway. Sweeping
  // every call keeps the map to "accounts seen in the last minute", which is small enough that
  // the O(n) walk is cheaper than the branch was worth.
  for (const [k, v] of lanRate) if (v.until <= now) lanRate.delete(k);
  const hit = lanRate.get(key);
  if (!hit || hit.until <= now) {
    lanRate.set(key, { n: 1, until: now + LAN_WINDOW_MS });
    return true;
  }
  hit.n++;
  return hit.n <= LAN_MAX_PER_WINDOW;
}

/**
 * ONE DATA EXPORT PER MINUTE PER ACCOUNT (`GET /api/user/export`).
 *
 * Built to the shape of `lanRateOk` above rather than a generic limiter, because the two
 * limits are the same kind of thing — an authenticated route whose real cost is database
 * compute, bounded per ACCOUNT — and one more four-line function is cheaper to read than an
 * abstraction over two call sites.
 *
 * `EXPORT_WINDOW_MS` is the whole limit: there is no burst allowance, because there is no
 * legitimate reason to ask twice in a minute. The map is swept on the way past for the same
 * reason the LAN one is, so an idle server does not keep a row per account that ever exported.
 */
const EXPORT_WINDOW_MS = 60_000;
const exportRate = new Map<string, number>();

function exportRateOk(userId: string): boolean {
  const now = Date.now();
  // unconditional, for the reason spelled out in `lanRateOk`: a size-gated sweep never runs
  // until 1000 rows have accumulated, and the one burst that would justify it — 1001 distinct
  // accounts inside a single window — is the burst in which nothing has expired to sweep.
  for (const [k, t] of exportRate) if (t <= now) exportRate.delete(k);
  const until = exportRate.get(userId);
  if (until && until > now) return false;
  exportRate.set(userId, now + EXPORT_WINDOW_MS);
  return true;
}

/**
 * THROTTLE FOR `POST /api/played`, the public match-count report. Keyed by a HASH of the
 * address, so the limiter never holds a raw IP (the analytics rule, `server/analytics.ts`).
 * A practice match takes minutes, so 30 in ten minutes is a room full of players behind one
 * NAT, not one player.
 */
const PLAYED_WINDOW_MS = 10 * 60_000;
const PLAYED_MAX_PER_WINDOW = 30;
const playedRate = new Map<string, { n: number; until: number }>();

function playedRateOk(ip: string): boolean {
  const key = createHash('sha256').update(ip).digest('hex').slice(0, 16);
  const now = Date.now();
  // swept on the way past, unconditionally — see `uploadRateOk`
  for (const [k, v] of playedRate) if (v.until <= now) playedRate.delete(k);
  const hit = playedRate.get(key);
  if (!hit) {
    playedRate.set(key, { n: 1, until: now + PLAYED_WINDOW_MS });
    return true;
  }
  hit.n++;
  return hit.n <= PLAYED_MAX_PER_WINDOW;
}

/** the Bearer token from an Authorization header, if it looks like one */
function bearer(req: IncomingMessage): string | undefined {
  const auth = req.headers['authorization'];
  return typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
}

/**
 * OPTIONAL auth, for a PUBLIC route whose answer narrows when it knows who is asking — the
 * replay gate and the match history it feeds (migration 0038). A token that is absent,
 * expired or bogus is anonymous, exactly as if none had been sent; nothing 401s.
 *
 * ⚠️ It short-circuits on a missing header rather than letting `verifyAuthToken(undefined)`
 * answer null, because that function LOGS on the way out. These are the routes a signed-out
 * leaderboard visitor hits, and a line per replay view is the log bill the friends-poll
 * silence was won back from.
 */
async function viewerId(req: IncomingMessage): Promise<string | null> {
  const token = bearer(req);
  if (!token) return null;
  return (await verifyAuthToken(token))?.userId ?? null;
}

/**
 * The body half of `POST /api/lan`, lifted out so the route can wrap it in the in-flight cap
 * without the `finally` swallowing the shape of the handler.
 *
 * Everything here is UNTRUSTED input from a client that played on a server the cloud has no
 * reason to believe: the id is shape-checked, the replay goes through `sanitizeReplay`, the
 * score is clamped and every name in the roster is moderated.
 */
async function saveLanUpload(
  req: IncomingMessage,
  json: (code: number, body: unknown) => void,
  user: { userId: string; handle: string },
  game: GameId,
): Promise<boolean> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req)) as Record<string, unknown>;
  } catch {
    return json(400, { error: 'bad request' }), true;
  }

  // the match id is the row's identity and its idempotence key, so it has to be a
  // plausible id and not an arbitrary string a client can use to squat on the table
  const matchId = typeof body.matchId === 'string' ? body.matchId.trim() : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(matchId)) {
    return json(400, { error: 'missing or malformed matchId' }), true;
  }

  const replay = sanitizeReplay(body.replay, game);
  if (!replay) return json(400, { error: 'not a playable replay' }), true;

  const clamp = (v: unknown): number =>
    Math.max(0, Math.min(9999, Math.round(typeof v === 'number' && Number.isFinite(v) ? v : 0)));
  const rawScore = (body.score ?? {}) as Record<string, unknown>;
  const score = { red: clamp(rawScore.red), blue: clamp(rawScore.blue) };

  // THE ROSTER IS DISPLAY TEXT AND NOTHING ELSE. It is rendered beside the match in the
  // host's own archive, so it goes through the same name moderation every other
  // user-supplied name does, and it carries no user ids — see the migration for why
  // attributing a LAN match to an account on this server's say-so is not on the table.
  const rawRoster = Array.isArray(body.participants) ? body.participants.slice(0, 8) : [];
  /**
   * CONCURRENTLY, because `scrubName` is a round trip to a hosted moderation API with its own
   * timeout (`MODERATION_TIMEOUT_MS`, 4s). Awaited one at a time inside the loop this used to
   * be, a full roster was up to 16 sequential calls — eight players, a name and a team name
   * each — so one upload's worst case was the timeout SIXTEEN times over while the request sat
   * open. The names are independent of each other and the service is the same one either way;
   * nothing here needed to be sequential. `Promise.all` preserves roster order, and the
   * in-process decision cache still short-circuits repeats.
   */
  const participants: LanParticipant[] = (
    await Promise.all(
      rawRoster.map(async (raw): Promise<LanParticipant | null> => {
        if (!raw || typeof raw !== 'object') return null;
        const p = raw as Record<string, unknown>;
        const teamNumber = typeof p.teamNumber === 'number' && Number.isFinite(p.teamNumber)
          ? Math.max(0, Math.min(999999, Math.round(p.teamNumber)))
          : undefined;
        const [name, teamName] = await Promise.all([
          scrubName(typeof p.name === 'string' ? p.name : '', 'Player'),
          typeof p.teamName === 'string' ? scrubName(p.teamName, 'Team') : Promise.resolve(undefined),
        ]);
        return {
          name,
          teamName,
          teamNumber,
          alliance: p.alliance === 'blue' ? 'blue' : 'red',
          drivetrain: typeof p.drivetrain === 'string' ? p.drivetrain.slice(0, 24) : undefined,
        };
      }),
    )
  ).filter((p): p is LanParticipant => p !== null);

  await ensureProfile(user.userId, user.handle);
  const season = await currentSeasonNumber(BALANCE_VERSION, replay.game as GameId);
  try {
    const run = await saveLanRun(
      user.userId,
      matchId,
      replay,
      score,
      participants,
      season,
      replay.game as GameId,
    );
    return json(200, { run }), true;
  } catch (e) {
    /**
     * SOMEBODY ELSE ALREADY FILED THIS MATCH. 409, said out loud, rather than the silent 200
     * the old code gave: the id used to be broadcast to the whole room with the result, so any
     * player or spectator could file the host's match under their own account, and the host's
     * own upload was then answered with a stranger's row and marked as done. The id is a
     * host-only capability now (`matchArchive`), so reaching this is either a leaked one or a
     * genuine collision — and either way the uploader has to be told it did not get the match
     * rather than left believing it did.
     */
    if (e instanceof LanRunOwnedByAnother) {
      return json(409, { error: 'that match was already saved by the host who ran it' }), true;
    }
    throw e;
  }
}

/**
 * ANALYTICS — the public beacon (`POST /api/a/pv`, `/api/a/ev`) and the admin read
 * (`GET /api/analytics`, `/api/analytics/product`).
 *
 * ⚠️ THE TWO HALVES HAVE OPPOSITE THREAT MODELS and are in one function so that stays
 * visible. The beacon is the only unauthenticated WRITE this server accepts and it answers 204
 * to everything — a refusal that says WHY would tell a script which of the four limits it
 * tripped, and there is nothing a real client could do with the answer anyway. The read is
 * staff-only and says so plainly, because an admin who is signed in wrong needs to know.
 *
 * ⚠️ `isStaffUser` IS THE GATE, not a second copy of `ADMIN_IDS`. `profiles.role` is the
 * projection of `ADMIN_USER_IDS` that exists so exactly this kind of question can be answered
 * in SQL (`docs/area/accounts.md`), it is reconciled at every boot, and the sweep is symmetric
 * — an id removed from the env loses the dashboard with everything else. A second env read
 * here would be a second thing to keep in step.
 */
async function handleAnalytics(
  req: IncomingMessage,
  url: URL,
  json: (code: number, body: unknown) => void,
): Promise<boolean> {
  const p = url.pathname;

  // ---- ingest ------------------------------------------------------------
  if (req.method === 'POST' && (p === '/api/a/pv' || p === '/api/a/ev')) {
    // 202 WHATEVER HAPPENS: no database, a bot, over a limit, or a body that is not a beacon
    // all look identical from outside. `sendBeacon` discards the response, a real client has
    // nothing it could do with a reason, and a probe should not be able to learn which of the
    // four limits it tripped. "Accepted" is also the honest status — the row is written after
    // the response on every path that writes one.
    const done = (): boolean => (json(202, {}), true);
    if (!dbEnabled) return done();
    const ua = (req.headers['user-agent'] as string | undefined) ?? '';
    if (isBot(ua)) return done();

    let body: unknown;
    try {
      // 4 KiB, not the 512 KiB default. A beacon is a few hundred bytes and the cap is the
      // first thing standing between a public POST and somebody's idea of a fun afternoon.
      body = JSON.parse(await readBody(req, 4096));
    } catch {
      return done();
    }

    const salt = await currentSalt();
    const ip = clientIp(req);
    // The HOST HEADER, not `url.host` — `handleApi` parses the request against a fixed
    // `http://localhost` base, so that would be the same constant for every deployment and the
    // `site` term in the hash would do nothing at all.
    const site = (req.headers.host ?? '').slice(0, 64);
    const visitor = visitorHash(salt, ip, ua, site);
    // The per-ADDRESS key is a hash under the same rotating salt, so the limiter never becomes
    // the one place raw addresses are kept. `ip:` keeps the two key spaces apart.
    const addr = 'ip:' + visitorHash(salt, ip, '', site);
    if (!rateOk(visitor, VISITOR_LIMIT) || !rateOk(addr, ADDRESS_LIMIT)) return done();

    ensureAnalyticsJobs();
    if (p === '/api/a/ev') {
      const ev = parseEvent(body);
      if (ev) await insertEvent(ev, visitor);
      return done();
    }
    const pv = parsePageview(body);
    if (!pv) return done();
    const { device, os, browser } = classify(ua);
    await insertPageview(pv, {
      visitor,
      // The header when the edge gives us one, the browser's coarse timezone otherwise. The
      // timezone string is used for this line and then dropped; it is never a column.
      country: headerCountry(req) || countryForTimezone(pv.timezone),
      device,
      os,
      browser,
      lang: primaryLang(req.headers['accept-language']),
    });
    return done();
  }

  // ---- the dashboard -----------------------------------------------------
  if (req.method !== 'GET') return json(405, { error: 'method not allowed' }), true;
  const user = await verifyAuthToken(bearer(req));
  if (!user || !dbEnabled || !(await isStaffUser(user.userId))) {
    return json(403, { error: 'forbidden' }), true;
  }

  // A range is two instants and both are clamped: an unbounded `from` is a full-table scan on
  // a route somebody will leave open in a tab with auto-refresh on.
  const now = Date.now();
  const at = (key: string, fallback: number): Date => {
    const raw = Date.parse(url.searchParams.get(key) ?? '');
    return new Date(Number.isFinite(raw) ? Math.min(Math.max(raw, now - 730 * 86_400_000), now + 86_400_000) : fallback);
  };
  const to = at('to', now);
  const from = at('from', to.getTime() - 7 * 86_400_000);
  if (from >= to) return json(400, { error: 'empty range' }), true;
  const game = url.searchParams.get('game') ?? '*';
  const grain = url.searchParams.get('grain') === 'hour' ? 'hour' : 'day';

  if (p === '/api/analytics/product') {
    return json(200, await productReport(from, to, game)), true;
  }
  if (p !== '/api/analytics') return json(404, { error: 'unknown endpoint' }), true;

  // `f=<dim>:<value>`, repeatable — the click-to-filter chips. Capped at six: the panel cannot
  // produce more, and an URL that could would be a way to ask for an arbitrarily long `where`.
  const filters = url.searchParams
    .getAll('f')
    .slice(0, 6)
    .map((raw) => {
      const i = raw.indexOf(':');
      return i < 0 ? { dim: raw, val: '' } : { dim: raw.slice(0, i), val: raw.slice(i + 1).slice(0, 128) };
    })
    .filter((f) => dimColumn(f.dim) !== null);

  return json(200, await analyticsReport({ from, to, game, filters, grain })), true;
}

export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return false;

  const json = (code: number, body: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS });
    res.end(JSON.stringify(body));
  };

  // CORS preflight for the authenticated POST
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return true;
  }

  try {
    // ---- analytics: the public beacon, and the admin read -------------------
    // FIRST in the chain because it is the most frequent request this server answers and the
    // cheapest to refuse. See `server/analytics.ts` for what is and is not recorded.
    if (url.pathname.startsWith('/api/a/') || url.pathname.startsWith('/api/analytics')) {
      return await handleAnalytics(req, url, json);
    }

    // ---- authenticated write: set your own display name --------------------
    if (req.method === 'POST' && url.pathname === '/api/user/handle') {
      const auth = req.headers['authorization'];
      const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
      const user = await verifyAuthToken(token);
      if (!user) return json(401, { error: 'sign in required' }), true;
      let handle: unknown;
      try {
        handle = JSON.parse(await readBody(req)).handle;
      } catch {
        return json(400, { error: 'bad request' }), true;
      }
      const clean = typeof handle === 'string' ? handle.trim() : '';
      if (clean.length < 2 || clean.length > 24) {
        return json(400, { error: 'name must be 2–24 characters' }), true;
      }
      // authoritative content moderation via the hosted service (the client shows a
      // hint from the same check, but any client value is spoofable — the server is
      // the authority). Fails open on an outage; the admin console is the backstop.
      if (!(await moderateName(clean)).allowed) {
        return json(400, { error: 'That name isn’t allowed. Please choose another.' }), true;
      }
      if (dbEnabled) {
        await ensureProfile(user.userId, clean);
        await setHandle(user.userId, clean);
      }
      return json(200, { userId: user.userId, handle: clean }), true;
    }

    // ---- authenticated write: claim your own unique username ----------------
    if (req.method === 'POST' && url.pathname === '/api/user/username') {
      const auth = req.headers['authorization'];
      const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
      const user = await verifyAuthToken(token);
      if (!user) return json(401, { error: 'sign in required' }), true;
      let raw: unknown;
      try {
        raw = JSON.parse(await readBody(req)).username;
      } catch {
        return json(400, { error: 'bad request' }), true;
      }
      const username = normalizeUsername(raw);
      if (!username) {
        return json(400, { error: '4–20 characters, lowercase letters and numbers only' }), true;
      }
      // authoritative content moderation (fails open on an outage; admin is backstop)
      if (!(await moderateName(username)).allowed) {
        return json(400, { error: 'That username isn’t allowed. Please choose another.' }), true;
      }
      if (dbEnabled) {
        await ensureProfile(user.userId, user.handle);
        try {
          await setUsername(user.userId, username);
        } catch (e) {
          if (e instanceof UsernameTakenError) {
            return json(409, { error: 'That username is taken.' }), true;
          }
          throw e;
        }
      }
      return json(200, { userId: user.userId, username }), true;
    }

    // ---- public: is a username free to claim? (format + uniqueness) ---------
    if (req.method === 'GET' && url.pathname === '/api/username-available') {
      const username = normalizeUsername(url.searchParams.get('u'));
      if (!username) return json(200, { valid: false, available: false }), true;
      // a blocked name is never claimable — surface it as invalid with a reason so
      // the client can show the "not allowed" hint (vs. a plain format error)
      if (!(await moderateName(username)).allowed) {
        return json(200, { valid: false, available: false, reason: 'inappropriate' }), true;
      }
      const available = dbEnabled ? await usernameAvailable(username) : true;
      return json(200, { valid: true, available, username }), true;
    }

    /**
     * ---- per-account PRIVACY (read + write your own) ------------------------
     *
     * Its own route rather than a field in `/api/user/settings`, and that is the point of it.
     * That blob is client-shaped, client-validated and opaque to the server — nothing in SQL
     * reads it — so a privacy bit living there could be enforced only by the client being
     * asked about it, which is not enforcement. This is a real column
     * (`profiles.replays_public`, 0038) that `replayAccess` and `userMatchHistory` join
     * against, and it is written here from the token's own subject and never from the body.
     */
    if (url.pathname === '/api/user/privacy' && (req.method === 'GET' || req.method === 'POST')) {
      const user = await verifyAuthToken(bearer(req));
      if (!user) return json(401, { error: 'sign in required' }), true;
      if (!dbEnabled) return json(200, { replaysPublic: false }), true;

      if (req.method === 'GET') {
        return json(200, { replaysPublic: await getReplaysPublic(user.userId) }), true;
      }
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      } catch {
        return json(400, { error: 'bad json' }), true;
      }
      if (typeof body.replaysPublic !== 'boolean') {
        return json(400, { error: 'replaysPublic must be true or false' }), true;
      }
      await ensureProfile(user.userId, user.handle);
      await setReplaysPublic(user.userId, body.replaysPublic);
      return json(200, { replaysPublic: body.replaysPublic }), true;
    }

    /**
     * TITLES ARE RETIRED (0049): they folded into badges, and `profiles.title` is always null.
     *
     * ⚠️ THE ROUTE STAYS, because the one Fly app serves every client version and a client
     * from before the fold still calls it: GET answers "no title, nothing earned" (its picker
     * then renders nothing), and POST accepts `null` (clearing is always true) and refuses
     * anything else, the same 403 an unearned title always got. Delete it once no client
     * older than 0049 can reach the server.
     */
    if (url.pathname === '/api/user/title' && (req.method === 'GET' || req.method === 'POST')) {
      const user = await verifyAuthToken(bearer(req));
      if (!user) return json(401, { error: 'sign in required' }), true;
      if (req.method === 'GET') return json(200, { title: null, earned: [] }), true;
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      } catch {
        return json(400, { error: 'bad json' }), true;
      }
      if (body.title !== null) return json(403, { error: 'Titles are now badges. Pick one under Profile, Appearance.' }), true;
      return json(200, { title: null }), true;
    }

    /**
     * THE REWARD LEDGER (0048). GET is everything the claim dialog and the appearance page
     * read at once — pending grants, badge counts, what is worn, the trophy case. POST claim
     * takes one grant and, with `equip`, wears it.
     *
     * ⚠️ NEW ROUTES, NOT NEW FIELDS ON OLD ONES, so every older client keeps working exactly as
     * it did: it never asks for pending rewards, so it never sees one. An older SERVER answers
     * 404 here, which the client reads as "nothing pending" — so no capability flag is needed
     * either way.
     *
     * ⚠️ BOTH ANSWERS STILL CARRY `title: null` AND `earnedTitles: []` (`RETIRED_TITLE_FIELDS`)
     * for a client from before titles folded into badges (0049), which reads
     * `earnedTitles.includes(…)` without a guard. This build ignores both.
     */
    if (url.pathname === '/api/user/rewards' && req.method === 'GET') {
      const user = await verifyAuthToken(bearer(req));
      if (!user) return json(401, { error: 'sign in required' }), true;
      if (!dbEnabled) return json(200, { pending: [], badges: {}, equippedBadges: [], ...RETIRED_TITLE_FIELDS }), true;
      await ensureProfile(user.userId, user.handle);
      return json(200, { ...(await rewardState(user.userId)), ...RETIRED_TITLE_FIELDS }), true;
    }
    if (url.pathname === '/api/user/rewards/claim' && req.method === 'POST') {
      const user = await verifyAuthToken(bearer(req));
      if (!user) return json(401, { error: 'sign in required' }), true;
      if (!dbEnabled) return json(503, { error: 'Rewards need the database.' }), true;
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      } catch {
        return json(400, { error: 'bad json' }), true;
      }
      // a UUID, checked BEFORE the query — the column is `uuid`, and a malformed string there
      // is a Postgres error rather than a clean "no such reward"
      const id = typeof body.id === 'string' && /^[0-9a-f-]{36}$/i.test(body.id) ? body.id : null;
      if (!id) return json(400, { error: 'id must be a reward id' }), true;
      const state = await claimReward(user.userId, id, body.equip === true);
      if (!state) return json(404, { error: 'That reward is not yours to claim.' }), true;
      return json(200, { ...state, ...RETIRED_TITLE_FIELDS }), true;
    }
    /** WEAR these badges, in this order. The server decides what is held (`setEquippedBadges`):
     *  a badge beside a name is a claim to have won it, so a client may not assert one. */
    if (url.pathname === '/api/user/badges' && req.method === 'POST') {
      const user = await verifyAuthToken(bearer(req));
      if (!user) return json(401, { error: 'sign in required' }), true;
      if (!dbEnabled) return json(503, { error: 'Badges need the database.' }), true;
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      } catch {
        return json(400, { error: 'bad json' }), true;
      }
      const ids = Array.isArray(body.badges) && body.badges.every((b) => typeof b === 'string') ? (body.badges as string[]) : null;
      if (!ids) return json(400, { error: 'badges must be a list of badge ids' }), true;
      const worn = await setEquippedBadges(user.userId, ids);
      if (!worn) return json(403, { error: 'You have not earned one of those badges.' }), true;
      return json(200, { equippedBadges: worn }), true;
    }

    /** what this account has linked, and which providers the server can actually offer. */
    if (url.pathname === '/api/user/links' && req.method === 'GET') {
      const user = await verifyAuthToken(bearer(req));
      if (!user) return json(401, { error: 'sign in required' }), true;
      const available = (['github', 'discord'] as LinkProvider[]).filter(linkConfigured);
      const linked = dbEnabled ? (await providerLinks(user.userId)).map((l) => l.provider) : [];
      return json(200, { linked, available }), true;
    }

    /**
     * LINKING AN EXTERNAL ACCOUNT — start, callback, unlink. `server/oauthLink.ts` holds the
     * flow and says why the SERVER does the code exchange rather than trusting a client to
     * name its own GitHub id.
     *
     * ⚠️ THE CALLBACK IS A BROWSER REDIRECT, NOT AN API CALL, so it cannot carry a Bearer
     * token — which is exactly what the signed `state` is for: it carries the DSIM user id
     * across the round trip, HMAC'd with a per-boot key and expiring in ten minutes. It also
     * answers with a 302 back into the app rather than JSON, because a person is looking at
     * it.
     */
    /**
     * THE PUBLIC ORIGIN THIS REQUEST ARRIVED ON — what the provider must redirect back to,
     * and it has to MATCH the authorize call exactly or the exchange is rejected.
     *
     * `PUBLIC_ORIGIN` wins when set, because behind Fly and the Discord `/gs` proxy the Host
     * header is not necessarily the address a browser used. Otherwise it is derived from the
     * forwarded proto + host, which is right for an ordinary deploy and for localhost.
     */
    const publicOrigin = (r: typeof req): string => {
      const env = process.env.PUBLIC_ORIGIN;
      if (env) return env.replace(/\/$/, '');
      const xf = r.headers['x-forwarded-proto'];
      const proto = (Array.isArray(xf) ? xf[0] : xf)?.split(',')[0] ?? 'https';
      const host = r.headers.host ?? 'localhost';
      return `${proto}://${host}`;
    };
    const linkMatch = url.pathname.match(/^\/api\/link\/(github|discord)\/(start|callback|unlink)$/);
    if (linkMatch) {
      const provider = linkMatch[1] as LinkProvider;
      const action = linkMatch[2];
      const origin = publicOrigin(req);

      if (action === 'start') {
        const user = await verifyAuthToken(bearer(req));
        if (!user) return json(401, { error: 'sign in required' }), true;
        const to = authorizeUrl(provider, origin, user.userId);
        if (!to) return json(503, { error: 'That provider is not configured on this server.' }), true;
        return json(200, { url: to }), true;
      }

      if (action === 'unlink') {
        const user = await verifyAuthToken(bearer(req));
        if (!user) return json(401, { error: 'sign in required' }), true;
        if (!dbEnabled) return json(200, { unlinked: false }), true;
        const ok = await unlinkProvider(user.userId, provider);
        /* ⚠️ UNLINKING TAKES THE REWARD WITH IT. Leaving the badge on an account that no
           longer proves it starred is a dangling claim — and it is also the farm: unlink, keep
           the decal, relink elsewhere. The 0047 row survives, so the PAIR still cannot earn
           again. */
        if (ok && provider === 'github') {
          /* ⚠️ THE WHOLE REWARD, THROUGH THE ONE REVOKE PATH (`revokeStargazer`): the ledger
             grant (pending or claimed), the badge and decal it delivered, and the worn badge. Half a
             reward is a state no later sweep repairs — the sweep only looks at accounts that
             still have a LIVE link, and this one no longer does. */
          await revokeStargazer(user.userId, 'github unlinked');
        }
        return json(200, { unlinked: ok }), true;
      }

      // ---- callback ----
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      /**
       * ⚠️ **THE CALLBACK LANDS ON THE GAME SERVER, WHICH DOES NOT SERVE THE APP**, so a
       * relative `/account` 302 is a 404 on every real deploy. Fly runs this process alone;
       * the SPA is on Vercel at a different origin, and the only path that serves the client
       * from here is the LAN self-host (`SERVE_CLIENT`).
       *
       * So the bounce goes to `APP_ORIGIN` when it is set, and stays relative when it is not
       * — which is right for the LAN case and for `npm run dev`, where the two ARE the same
       * origin. It is an env var rather than something the client hands to `/start`: the
       * client could name any origin, and a server that redirects wherever it is told is an
       * open redirect whatever else is signed around it.
       */
      const appOrigin = (process.env.APP_ORIGIN ?? '').replace(/\/$/, '');
      const back = (q: string): true => {
        res.writeHead(302, { location: `${appOrigin}/account?link=${q}`, 'cache-control': 'no-store' });
        res.end();
        return true;
      };
      if (!code || !state) return back('error');
      const who = readState(state);
      if (!who || who.provider !== provider) return back('error');
      const providerUserId = await exchangeForId(provider, code, origin);
      if (!providerUserId) return back('error');
      if (!dbEnabled) return back('error');
      await ensureProfile(who.userId, '');
      const linked = await linkProvider(who.userId, provider, providerUserId);
      /**
       * ⚠️ **SWEEP RIGHT NOW, BEFORE THE REDIRECT. A REWARD THAT ARRIVES IN AN HOUR IS
       * INDISTINGUISHABLE FROM ONE THAT IS BROKEN**, and that is exactly how it read: the
       * only thing that granted anything was `setInterval(…, 1 h)` in `server/index.ts`, so
       * a person who linked saw their GitHub connected and NOTHING else, with no way to tell
       * whether it had worked. Worse, the interval is created at boot, so every deploy pushed
       * the first fire back another hour — on a day with several deploys it may never have
       * run at all. (It had not: the live log had no `[rewards]` line.)
       *
       * So the link itself grants. It costs ONE GitHub request — the sweep reads the repo's
       * stargazers, not the person, so it is the same single request whatever the reason for
       * running it — and it means the page the callback bounces to can state what was earned
       * as fact instead of asking somebody to come back later.
       *
       * ⚠️ AND IT CANNOT FAIL THE LINK. The link is already committed at this point; a
       * GitHub outage, a bad token or a thrown query must not turn a successful link into
       * `?link=error` and send somebody round the OAuth loop again to fix something that is
       * not broken. The sweep's own fail-safe already declines to act on a list it does not
       * trust, so the worst case here is that the hourly pass picks it up — which is the
       * behaviour that existed before this block.
       */
      if (linked && provider === 'github') {
        try {
          await runStarSweep(process.env.GITHUB_STAR_REPO ?? 'genius0412/dsim', process.env.GITHUB_TOKEN, fetch, 'link');
        } catch (e) {
          console.error('[rewards] the on-link star sweep failed; the hourly pass will retry:', e);
        }
      }
      // `false` means that external account already belongs to a DIFFERENT DSIM account —
      // the 0047 anti-farm. It is a refusal the person needs to see, not a silent no-op.
      return back(linked ? 'ok' : 'taken');
    }

    // ---- per-account settings (read + write your own) ----------------------
    if (url.pathname === '/api/user/settings' && (req.method === 'GET' || req.method === 'POST')) {
      const auth = req.headers['authorization'];
      const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
      const user = await verifyAuthToken(token);
      if (!user) return json(401, { error: 'sign in required' }), true;

      if (req.method === 'GET') {
        const settings = dbEnabled ? await getUserSettings(user.userId) : null;
        return json(200, { settings }), true;
      }
      // POST: save the whole settings blob
      let settings: unknown;
      try {
        // 64 KB, not `readBody`'s 512 KB default. This blob is keybinds, toggles and a colour
        // or two — a few KB at the outside — and it is stored per account, so the default cap
        // let a signed-in client park half a megabyte of anything in Postgres under the name
        // "settings". The limit is the shape of the data, not the shape of the transport.
        settings = JSON.parse(await readBody(req, 64 * 1024)).settings;
      } catch {
        return json(400, { error: 'bad request' }), true;
      }
      if (typeof settings !== 'object' || settings === null) {
        return json(400, { error: 'settings must be an object' }), true;
      }
      if (dbEnabled) {
        await ensureProfile(user.userId, user.handle);
        await saveUserSettings(user.userId, settings);
      }
      return json(200, { ok: true }), true;
    }

    /**
     * ---- TERMS ACCEPTANCE (write your own) ---------------------------------
     *
     * ⚠️ THE VERSION IS NOT IN THE BODY. It is the server's own `LEGAL_VERSION`,
     * derived from the legal text this deployment is serving — so a client cannot
     * claim to have accepted a revision that does not exist, and cannot pre-accept
     * the NEXT one to opt out of the gate forever. There is nothing for the caller
     * to send, which is why the route takes no body at all.
     *
     * The account is identified from the token's own subject, like every other write
     * here. `ensureProfile` first, because an OAuth account can reach this before
     * anything else has created its row — accepting the terms is plausibly the very
     * first authenticated thing a new sign-up does.
     */
    if (url.pathname === '/api/user/accept-terms' && req.method === 'POST') {
      const user = await verifyAuthToken(bearer(req));
      if (!user) return json(401, { error: 'sign in required' }), true;
      if (!dbEnabled) {
        return json(503, { error: 'recording an acceptance needs the database' }), true;
      }
      // ALREADY ON THIS REVISION ⇒ ANSWER FROM THE ROW, WRITE NOTHING. The client's gate calls
      // this on mount whenever its cached answer is stale, and `acceptTerms` is an UPDATE that
      // overwrites `terms_accepted_at` with `now()` — so a re-post was silently MOVING the
      // recorded consent date forward, which is the one field a dispute would read. It also put
      // two writes (ensureProfile + the update) on a route that had nothing to record. The read
      // is a single-row lookup by primary key; the response shape is byte-identical.
      const prior = await getTermsAcceptance(user.userId);
      if (prior.version === LEGAL_VERSION) {
        return json(200, { termsVersion: prior.version, termsAcceptedAt: prior.acceptedAt }), true;
      }
      await ensureProfile(user.userId, user.handle);
      const a = await acceptTerms(user.userId, LEGAL_VERSION);
      return json(200, { termsVersion: a.version, termsAcceptedAt: a.acceptedAt }), true;
    }

    // ---- supporter entitlements --------------------------------------------
    // Read your OWN entitlement. The client uses this only to decide whether to
    // draw ads and perk UI; every perk that actually matters is enforced
    // server-side, so a lie here buys nothing.
    if (url.pathname === '/api/user/entitlements' && req.method === 'GET') {
      const user = await verifyAuthToken(bearer(req));
      if (!user) return json(401, { error: 'sign in required' }), true;
      if (!dbEnabled) {
        return (
          json(200, {
            supporter: false,
            supporterUntil: null,
            autoRenews: false,
            // NULL, not the current version: with no database nothing was recorded, and
            // saying otherwise would tell the gate an acceptance exists that does not.
            // (A local dev server without Postgres therefore shows the dialog, and its
            // Accept answers 503 — correct, and visible, rather than quietly fine.)
            termsVersion: null,
            // no database ⇒ nothing was ever granted, same "not asked = false" rule as
            // every other field on this no-db branch.
            unlockedCosmetics: [],
          }),
          true
        );
      }
      // the price is served alongside the entitlement so the Donate page can state
      // it without a second round trip, and so it can never drift from the number
      // the grant policy actually charges (see server/kofi.ts).
      const policy = policyFromEnv();
      return (
        json(200, {
          ...(await getSupporter(user.userId)),
          price: { amount: policy.monthlyPrice, currency: policy.currency },
          /**
           * THE ACCEPTED TERMS RIDE ALONG HERE rather than on a route of their own.
           * This is the one call the client already makes once per signed-in session
           * for its own account, and the gate needs the answer at exactly that moment;
           * a second route would be a second round trip on every load to learn one
           * string. A second single-row lookup by primary key on the same table is the
           * cheaper half of that trade.
           *
           * It is kept OUT of `getSupporter`'s own return: that function is the
           * supporter predicate the ad gate, the cosmetics and the badge all read, and
           * an unrelated legal field inside it would invite somebody to fold a terms
           * check into a paid-perk decision.
           */
          termsVersion: (await getTermsAcceptance(user.userId)).version,
          // EARNED, permanent unlocks (`profiles.cosmetics`, migration 0044) — separate
          // from the `supporter` fields above on purpose (docs/cosmetics-plan.md §3.2/
          // §3.7): the client uses this only to decide which picker rows to show as
          // owned rather than locked. Never trusted back — the server independently
          // strips on join/update (`stripUnentitledCosmetics`) regardless of what this
          // endpoint ever said.
          unlockedCosmetics: await getCosmeticsUnlocks(user.userId),
        }),
        true
      );
    }

    /**
     * ---- authenticated: SOLO PRACTICE replays (own account only) ------------
     *
     * The one write a CLIENT makes to this database, and it is only safe because of where it
     * can go. Solo practice runs offline on the local sim — that is the mode — so there is no
     * authoritative loop to record it and nothing to check its score against. It therefore
     * lands in `practice_runs`, which is unreachable from `record_leaderboard` (a view over
     * `records`), so nothing written here can move a board, a PB, a rank or an ELO. See
     * migration 0032 and `sanitizeReplay`, which forces the container into a shape
     * `createWorld` can safely spawn.
     *
     * OWNER-ONLY, both ways: the list is keyed on the token's own subject and there is no
     * route that reads somebody else's. These are unverified offline runs, and putting them on
     * a PUBLIC profile beside real, server-witnessed results is exactly the confusion the
     * separate table exists to prevent.
     */
    if (url.pathname === '/api/practice' && (req.method === 'GET' || req.method === 'POST')) {
      const user = await verifyAuthToken(bearer(req));
      if (!user) return json(401, { error: 'sign in required' }), true;
      if (!dbEnabled) return json(503, { error: 'practice replays need the database' }), true;
      const game: GameId = coerceGameId(url.searchParams.get('game'));

      if (req.method === 'GET') {
        return json(200, { runs: await listPracticeRuns(user.userId, game) }), true;
      }
      // ⚠️ THE POST IS RATE-LIMITED BECAUSE IT REACHES A HOSTED THIRD-PARTY API. `saveReplay`
      // runs every setup's robot/team name through `scrubSpecNames` (the names are drawn ON THE
      // FIELD, so they are public in the viewer and burned into exported video), and the
      // decision cache only absorbs REPEATED text — a client posting a fresh name each time
      // bills one moderation call per upload, with the account's own token on it. Its `/api/lan`
      // sibling has carried this limiter from the start for exactly the same reason; practice
      // only joined the moderated paths in Sept 2026 and inherited no throttle with it.
      // Its own budget, not LAN's: draining a practice backlog must not lock out a LAN host.
      if (!uploadRateOk('practice', user.userId)) {
        return json(429, { error: 'too many practice uploads — try again in a minute' }), true;
      }

      /**
       * PERSISTENCE, not play. Practice itself runs on the local sim and is open to
       * everyone including signed-out visitors; what needs a confirmed address is
       * WRITING a run to an account, because that row carries a score and a replay
       * under somebody’s name. The GET above is deliberately outside this gate: an
       * unverified account must still be able to read back what it saved before the
       * gate was switched on.
       */
      {
        const refusal = emailGateRefusal(user);
        // its own sentence: the shared one says "to play ranked", and this is a practice save
        if (refusal) {
          return (
            json(403, {
              error: 'Verify your email to save practice runs. Enter the code we emailed you on your Profile page.',
              code: 'email_unverified',
            }),
            true
          );
        }
      }
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      } catch {
        return json(400, { error: 'bad request' }), true;
      }
      const replay = sanitizeReplay(body.replay, game);
      if (!replay) return json(400, { error: 'not a playable replay' }), true;
      // clamped, not trusted — a number this server did not compute should not be able to
      // render as anything but a plausible score
      const raw = typeof body.score === 'number' && Number.isFinite(body.score) ? body.score : 0;
      const score = Math.max(0, Math.min(9999, Math.round(raw)));
      /**
       * THE VIEW IS SANITIZED TO THE ENUM; THE PHYSICS IS NOT TAKEN FROM THE BODY AT ALL.
       *
       * `view` is a cosmetic fact only the client can know (which renderer was on this
       * screen), so it is accepted — forced to '2d' | '3d', absent otherwise, because it is a
       * column and not free text. `physics` is NOT read from `body`: `sanitizeReplay` already
       * carried it off the container, and the container is what a re-simulation will actually
       * run. Taking it from a second place would let a client file a 2D run tagged as a 3D
       * one, which is the only tag here anybody would have a reason to lie about.
       */
      const view = body.view === '2d' || body.view === '3d' ? body.view : undefined;
      await ensureProfile(user.userId, user.handle);
      const season = await currentSeasonNumber(BALANCE_VERSION, replay.game as GameId);
      const run = await savePracticeRun(user.userId, replay, score, season, replay.game as GameId, view);
      /**
       * PLAYTIME + GAMES PLAYED. Practice is playing the game — it is the mode most people
       * spend most of their time in — and a "games played" that ignored it read as broken
       * (Career even carried a note saying solo practice could not be counted). Measured the
       * same way `persist.ts` measures a server match: from the replay's TICK COUNT, not a
       * wall clock and not a duration the client stated separately.
       *
       * ⚠️ This is the one activity write whose input is CLIENT-REPORTED, so the number is no
       * longer purely server-witnessed. `sanitizeReplay` bounds each POST to at most one
       * match's worth of ticks, so a single run cannot inflate it — but nothing stops a
       * determined client from posting runs it never played. That is accepted deliberately:
       * games-played is a vanity counter that reaches no board, no rank and no ELO, and the
       * alternative is a playtime that omits the primary mode. Do NOT let anything
       * competitive start reading `user_activity`.
       */
      await addActivity([user.userId], replay.ticks * SIM_DT, replay.game as GameId).catch(
        (e: unknown) => console.error('[api] practice activity write failed:', e),
      );
      return json(200, { run }), true;
    }

    /**
     * SELF-HOSTED / LAN MATCHES — the host's own archive of games their server ran.
     *
     * Authenticated as the HOST, deliberately, and that single fact is what keeps this
     * endpoint from needing to trust the LAN server at all. The alternative considered was
     * having the LAN server upload on everyone's behalf, which would mean collecting each
     * player's auth token and handing it to a machine the cloud has no reason to trust. Here
     * the only credential involved is the host's own, used by the host's own client.
     *
     * Everything in the body is UNTRUSTED, including the score, because the server that
     * produced it is one its operator could have patched. That is survivable only because of
     * where the row can go: `lan_runs` is not reachable from `record_leaderboard`, so nothing
     * posted here can move a board, a PB, a rank or an ELO. See migration 0033.
     *
     * ⚠️ NO `addActivity` CALL, unlike `/api/practice`. A practice run is at least bounded by
     * the poster's own sim; a LAN match is bounded by nothing, so crediting games-played from
     * one would make that counter forgeable by anybody willing to run a script against this
     * endpoint. The data-collection goal is served by the replay itself, which is the thing
     * that was actually asked for.
     */
    // NOT MOUNTED unless this deployment accepts LAN matches (server/lanUploads.ts). Falling
    // through rather than returning a 503 is deliberate: an environment holding LAN back
    // should look like one where the feature does not exist, not like one where it is
    // temporarily broken. The route 404s with everything else the router does not know.
    if (LAN_UPLOADS && url.pathname === '/api/lan' && (req.method === 'GET' || req.method === 'POST')) {
      const user = await verifyAuthToken(bearer(req));
      if (!user) return json(401, { error: 'sign in required' }), true;
      if (!dbEnabled) return json(503, { error: 'saving LAN matches needs the database' }), true;
      if (!uploadRateOk('lan', user.userId)) {
        return json(429, { error: 'too many LAN uploads — try again in a minute' }), true;
      }
      // THE ALLOWLIST, not a two-valued ternary. This read `=== 'chain' ? 'chain' : 'decode'`,
      // which is the exact shape `coerceGameId` exists to replace: a THIRD id degraded to
      // DECODE silently, so a BIOBUZZ host's LAN match was listed and filed under DECODE.
      const game: GameId = coerceGameId(url.searchParams.get('game'));

      if (req.method === 'GET') {
        return json(200, { runs: await listLanRuns(user.userId, game) }), true;
      }

      // the in-flight cap covers the POST only: it is the one that holds a replay in memory
      // while it parses, sanitizes and moderates it. Refused with 503 + Retry-After rather
      // than 429, because this is the SERVER being busy and not this account being greedy, and
      // the backlog drain should come back for it rather than give up on the match.
      if (lanInFlight >= LAN_MAX_IN_FLIGHT) {
        res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '5', ...CORS });
        res.end(JSON.stringify({ error: 'busy — try again shortly' }));
        return true;
      }
      lanInFlight++;
      try {
        return await saveLanUpload(req, json, user, game);
      } finally {
        lanInFlight--;
      }
    }

    // Price + tier facts for a SIGNED-OUT visitor. Same numbers, no auth, no DB —
    // the Donate page has to state a price before anyone signs in.
    if (url.pathname === '/api/pricing' && req.method === 'GET') {
      const policy = policyFromEnv();
      return (
        json(200, {
          price: { amount: policy.monthlyPrice, currency: policy.currency },
          maxMonths: policy.maxMonths,
        }),
        true
      );
    }

    // Claim a Ko-fi payment against this account.
    //
    // Ko-fi identifies buyers by the email they paid with, which need not match
    // the Neon Auth email (and often will not — a student paying through a
    // parent's PayPal is the common case). Rather than guess, the webhook parks
    // the payment and the buyer pastes the transaction id Ko-fi showed them.
    // `claimKofiPayment` does the whole thing in one transaction so two accounts
    // cannot claim the same payment.
    if (url.pathname === '/api/user/claim-kofi' && req.method === 'POST') {
      const user = await verifyAuthToken(bearer(req));
      if (!user) return json(401, { error: 'sign in required' }), true;
      if (!dbEnabled) return json(503, { error: 'payments unavailable' }), true;

      let txn: unknown;
      try {
        txn = JSON.parse(await readBody(req)).transactionId;
      } catch {
        return json(400, { error: 'bad request' }), true;
      }
      if (typeof txn !== 'string' || !txn.trim()) {
        return json(400, { error: 'transaction id required' }), true;
      }
      await ensureProfile(user.userId, user.handle);
      const r = await claimKofiPayment(user.userId, txn.trim());
      if (r.outcome === 'not-found') {
        return (
          json(404, {
            error: "We can't find that transaction. Ko-fi payments can take a minute to arrive - try again shortly.",
          }),
          true
        );
      }
      if (r.outcome === 'already-claimed') {
        return json(409, { error: 'That payment has already been claimed.' }), true;
      }
      // Below the tier: say exactly WHY, with the real numbers. A bare "no" on a
      // payment someone genuinely made is the worst possible support experience,
      // and the payment stays unclaimed so an admin can still comp it.
      if (r.outcome === 'below-tier') {
        return (
          json(400, {
            error: r.payment
              ? whyNoMonths(
                  {
                    kind: r.payment.kind,
                    amount: r.payment.amount,
                    currency: r.payment.currency,
                    isSubscription: r.payment.isSubscription,
                    tierName: r.payment.tierName,
                  },
                  policyFromEnv(),
                )
              : "That payment doesn't meet the membership tier.",
          }),
          true
        );
      }
      if (r.outcome === 'email-taken') {
        return (
          json(409, {
            error:
              'That payment came from a Ko-fi account already linked to a different DSIM account. One membership covers one account - email us if this is wrong.',
          }),
          true
        );
      }
      if (r.outcome === 'refunded') {
        return json(409, { error: 'That payment was refunded.' }), true;
      }
      return (
        json(200, { ok: true, supporterUntil: r.until ?? null, months: r.months ?? 0 }),
        true
      );
    }

    /**
     * ---- DATA PORTABILITY: everything we hold about you, as one file ---------
     *
     * The other half of the promise `/api/user/delete` keeps. The privacy policy claims a
     * right of portability for anyone under UK/EU-comparable law, and until this existed the
     * only way to exercise it was to email a person and wait — which is a promise, not a
     * feature.
     *
     * RATE LIMITED TO ONE PER MINUTE PER ACCOUNT, and that limit is about cost rather than
     * abuse. This is the most expensive read in the whole API: seventeen queries, several of
     * them unbounded scans of the caller's own history, on Neon compute that bills by the
     * wall-clock minute it is kept awake. One per minute is far more than a human downloading
     * a file needs and far less than a loop could spend. Per ACCOUNT, not per IP, for the same
     * reason `/api/lan` is: the route is authenticated before it is reached, and a school's
     * whole network shares one address.
     *
     * A 404 for an account with no profile row. That is the honest answer for a DELETED
     * account — the token can outlive the row it named, and an empty document with a 200 on it
     * would read as "we hold nothing about you", which is a claim rather than a fact.
     */
    if (url.pathname === '/api/user/export' && req.method === 'GET') {
      const user = await verifyAuthToken(bearer(req));
      if (!user) return json(401, { error: 'sign in required' }), true;
      if (!dbEnabled) return json(503, { error: 'an export needs the database' }), true;
      if (!exportRateOk(user.userId)) {
        return (
          json(429, {
            error: 'One export a minute. Try again shortly — the file you already asked for is the same one.',
          }),
          true
        );
      }
      const data = await exportAccount(user.userId);
      if (!data) return json(404, { error: 'no account data' }), true;
      return json(200, data), true;
    }

    // ---- delete your own account -------------------------------------------
    // The privacy policy promises deletion on request, so it is a route, not an
    // inbox commitment. Destructive and irreversible, hence the typed
    // confirmation: the body must carry `confirm: 'DELETE'`, which no accidental
    // fetch or replayed request will ever contain.
    //
    // Auth deliberately does NOT include the Neon Auth identity itself — that
    // lives in the provider and is deleted from the account settings there. This
    // removes everything DSIM stores; the policy says so in the same words.
    if (url.pathname === '/api/user/delete' && req.method === 'POST') {
      const user = await verifyAuthToken(bearer(req));
      if (!user) return json(401, { error: 'sign in required' }), true;
      if (!dbEnabled) return json(503, { error: 'unavailable' }), true;
      let confirm: unknown;
      try {
        confirm = JSON.parse(await readBody(req)).confirm;
      } catch {
        return json(400, { error: 'bad request' }), true;
      }
      if (confirm !== 'DELETE') return json(400, { error: 'confirmation required' }), true;
      const gone = await deleteAccount(user.userId);
      console.log(`[api] account deleted: ${user.userId} -> ${gone}`);
      return json(200, { ok: true, deleted: gone }), true;
    }

    // ---- Ko-fi webhook ------------------------------------------------------
    // NOT an authenticated route: Ko-fi has no user JWT, so `verifyAuthToken` is
    // deliberately absent. Authenticity rests entirely on the shared
    // verification token Ko-fi sends in the payload, compared against
    // KOFI_VERIFICATION_TOKEN. With that env unset the endpoint is CLOSED rather
    // than open — an unauthenticated grant path is worse than no grant path.
    //
    // Ko-fi posts application/x-www-form-urlencoded with a single `data` field
    // holding the JSON, which is why this does not just JSON.parse the body.
    if (url.pathname === '/api/kofi/webhook' && req.method === 'POST') {
      const secret = process.env.KOFI_VERIFICATION_TOKEN;
      if (!secret) return json(503, { error: 'not configured' }), true;

      let payload: {
        verification_token?: string;
        message_id?: string;
        type?: string;
        email?: string;
        kofi_transaction_id?: string;
        amount?: string;
        currency?: string;
        is_subscription_payment?: boolean;
        tier_name?: string;
      };
      try {
        const body = await readBody(req);
        const raw = new URLSearchParams(body).get('data');
        payload = JSON.parse(raw ?? body);
      } catch {
        return json(400, { error: 'bad request' }), true;
      }

      // Constant-time-ish compare is overkill for a webhook token, but bail on a
      // mismatch before touching the DB either way.
      // Token check comes BEFORE the dbEnabled guard on purpose: an
      // unauthenticated caller should not be able to probe whether the database
      // is up, and it keeps the auth decision independent of deploy state.
      if (payload.verification_token !== secret) {
        return json(401, { error: 'bad token' }), true;
      }
      if (!payload.message_id) return json(400, { error: 'missing message_id' }), true;
      if (!dbEnabled) return json(503, { error: 'db unavailable' }), true;

      // What the payment is WORTH is decided here, once, and stored on the row —
      // not recomputed at claim time against env that may since have changed.
      const event = {
        kind: payload.type ?? 'Donation',
        amount: payload.amount ?? null,
        currency: payload.currency ?? null,
        isSubscription: !!payload.is_subscription_payment,
        tierName: payload.tier_name ?? null,
      };
      const months = monthsFor(event, policyFromEnv());

      // `fresh` is false when Ko-fi retried an event we already stored — the
      // insert's primary key is the idempotency guard, so a retry cannot grant a
      // second month. Always answer 200 so Ko-fi stops retrying.
      //
      // `autoGrantedTo` is set when the payer's email is already linked to an
      // account: that is the RENEWAL path, and it is why a monthly membership no
      // longer needs the buyer to paste a new transaction id every 30 days.
      const r = await recordKofiPayment({
        ...event,
        messageId: payload.message_id,
        email: payload.email ?? null,
        transactionId: payload.kofi_transaction_id ?? null,
        months,
      });
      if (r.autoGrantedTo) {
        console.log(
          `[kofi] auto-renewed ${r.autoGrantedTo} +${months}mo -> ${r.until} (${payload.message_id})`,
        );
      } else if (r.fresh) {
        console.log(
          `[kofi] parked ${payload.message_id} (${event.kind}, ${event.amount ?? '?'} ${event.currency ?? '?'}, ${months}mo) - awaiting claim`,
        );
      }
      return (
        json(200, { ok: true, recorded: r.fresh, granted: !!r.autoGrantedTo, months }),
        true
      );
    }

    // ---- friends ------------------------------------------------------------
    // Friendship is MUTUAL CONSENT and presence is behavioural data about a real
    // person, so every rule here is enforced server-side. Two invariants hold
    // across this whole block:
    //
    //  1. The acting user is ALWAYS `user.userId` from the verified JWT. No
    //     endpoint accepts an actor/userId parameter naming who is acting —
    //     otherwise anyone could forge another account's presence or consent.
    //  2. The wire carries USERNAMES, not user ids. `userId` is the auth
    //     provider's `sub`, which also authorises match writes; keeping it off
    //     these responses means a leaked friends list doesn't hand out a set of
    //     valid `sub` values. (/api/profile/<username> returns one today —
    //     pre-existing, but don't widen it.)
    //
    // CORS is `*` here as elsewhere, which stays safe ONLY because auth is a
    // Bearer token JS must attach explicitly: a wildcard ACAO can't be combined
    // with credentials, so a hostile page can't make an authed cross-origin call
    // for a victim. If auth ever moves to a cookie, every route below becomes
    // CSRF-able and needs SameSite + an origin check the same day.
    if (url.pathname === '/api/friends' || url.pathname.startsWith('/api/friends/')) {
      const user = await verifyAuthToken(bearer(req));
      if (!user) return json(401, { error: 'sign in required' }), true;
      if (!dbEnabled) {
        return json(200, { friends: [], incoming: [], outgoing: [], blocked: [], invites: [], sent: [], status: null }), true;
      }

      // the friends READ doubles as the presence heartbeat: the poll that
      // refreshes everyone else's status already proves the caller is here, so a
      // separate ping endpoint would double the request rate against a
      // scale-to-zero machine to say something this request already said.
      if (req.method === 'GET' && url.pathname === '/api/friends') {
        // the heartbeat also carries WHAT the caller is doing, so friends can see
        // "In a match"/"In a lobby". Both are coarse + validated to a small set;
        // an old client that sends neither simply records a plain 'online' beat.
        const a = url.searchParams.get('a');
        const activity: Activity | null = a === 'menu' || a === 'lobby' || a === 'match' ? a : null;
        const g = url.searchParams.get('g');
        const activityGame: GameId | null = isGameId(g) ? g : null;
        await ensureProfile(user.userId, user.handle);
        await touchPresence(user.userId, activity, activityGame);
        return json(200, await listFriends(user.userId)), true;
      }

      if (req.method !== 'POST') return json(405, { error: 'method not allowed' }), true;

      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      } catch {
        return json(400, { error: 'bad request' }), true;
      }
      await ensureProfile(user.userId, user.handle);

      // set your OWN presence status (the only friends POST not naming someone else)
      if (url.pathname === '/api/friends/status') {
        const s = body.status;
        const status: PresenceStatus | null =
          s === 'online' || s === 'dnd' || s === 'invisible' ? s : null;
        await setPresenceStatus(user.userId, status);
        return json(200, { status }), true;
      }

      // The three challenge-lifecycle routes act on an invite BY ID rather than by
      // naming a player, so they sit above the username-resolution block below.
      // Each is scoped to the side that owns that view of the row: dismiss and
      // decline to the recipient, cancel to the sender. Neither side can reach
      // into the other's.
      if (
        url.pathname === '/api/friends/invite/dismiss' ||
        url.pathname === '/api/friends/invite/decline' ||
        url.pathname === '/api/friends/invite/cancel'
      ) {
        const id = typeof body.id === 'string' ? body.id : null;
        if (!id) return json(400, { error: 'bad request' }), true;
        const ok =
          url.pathname === '/api/friends/invite/cancel'
            ? await cancelRoomInvite(user.userId, id)
            : url.pathname === '/api/friends/invite/decline'
              ? await declineRoomInvite(user.userId, id)
              : await dismissRoomInvite(user.userId, id);
        if (!ok) return json(404, { error: 'no such invite' }), true;
        return json(200, { ok: true }), true;
      }

      // every remaining route names another player by username. This is a LOOKUP,
      // not a claim — see `lookupUsername` (a claim-time validator here made every
      // action against a legacy short username fail with an opaque 400).
      const username = lookupUsername(body.username);
      if (!username) return json(400, { error: 'No player named.' }), true;
      const target = await getProfileByUsername(username);
      if (!target) return json(404, { error: 'no such user' }), true;
      if (target.userId === user.userId) {
        return json(400, { error: "That's you." }), true;
      }
      const other = target.userId;

      switch (url.pathname) {
        case '/api/friends/request': {
          // The recipient accepts by naming the SENDER by username, so a sender
          // who has none would plant a row nobody can ever act on. The username
          // gate normally guarantees one; this covers the accounts that slipped
          // past it (a failed profile fetch there deliberately doesn't trap the
          // user, which leaves exactly this hole).
          const me = await getProfile(user.userId);
          if (!me?.username) return json(400, { error: 'Pick a username first.' }), true;
          const outcome = await sendFriendRequest(user.userId, other);
          // 'blocked' deliberately reports the same generic failure as any other
          // refusal: a distinct message would let someone confirm they've been
          // blocked, which is exactly what the block exists to withhold.
          if (outcome === 'blocked') return json(409, { error: "Couldn't send that request." }), true;
          if (outcome === 'already-friends') return json(409, { error: 'Already friends.' }), true;
          if (outcome === 'duplicate') return json(409, { error: 'Request already sent.' }), true;
          return json(200, { outcome }), true;
        }
        case '/api/friends/accept': {
          const ok = await acceptFriendRequest(user.userId, other);
          // no pending request from that person ⇒ 404, never a silent success
          if (!ok) return json(404, { error: 'No pending request from that player.' }), true;
          return json(200, { ok: true }), true;
        }
        case '/api/friends/decline': {
          const ok = await declineFriendRequest(user.userId, other);
          if (!ok) return json(404, { error: 'No pending request from that player.' }), true;
          return json(200, { ok: true }), true;
        }
        case '/api/friends/cancel': {
          const ok = await cancelFriendRequest(user.userId, other);
          if (!ok) return json(404, { error: 'No pending request to that player.' }), true;
          return json(200, { ok: true }), true;
        }
        case '/api/friends/remove': {
          const ok = await removeFriend(user.userId, other);
          if (!ok) return json(404, { error: 'Not friends with that player.' }), true;
          return json(200, { ok: true }), true;
        }
        case '/api/friends/block':
          await blockUser(user.userId, other);
          return json(200, { ok: true }), true;
        case '/api/friends/unblock':
          await unblockUser(user.userId, other);
          return json(200, { ok: true }), true;
        // "come join my room" — scoped to an existing friendship (see
        // inviteToRoom), not a new trust relationship of its own.
        case '/api/friends/invite': {
          const room = typeof body.room === 'string' ? body.room.trim() : '';
          if (!room || room.length > 40 || !/^[a-z0-9-]+$/i.test(room)) {
            return json(400, { error: 'bad request' }), true;
          }
          const game: GameId = coerceGameId(body.game);
          const kind = body.kind === 'record' ? 'record' : 'versus';
          const record = body.record === 'duo' || body.record === 'solo' ? (body.record as string) : null;
          // The format is what the challenge OFFERED, and for the rated formats it
          // is load-bearing rather than cosmetic: the matchmaker only honours a
          // party token that a challenge of the matching format actually created
          // (`challengeParty`). Validated against the allowlist here so a client
          // can't invent one.
          const format = (CHALLENGE_FORMATS as readonly string[]).includes(body.format as string)
            ? (body.format as string)
            : null;
          // WHERE the sender is hosting. A custom room code carries no region for the
          // proxy to route on, so without this the recipient's socket lands on whichever
          // machine is nearest to them — a different room with the same code. Validated as
          // a region code rather than trusted verbatim: it goes into a routing hint.
          const region =
            typeof body.region === 'string' && /^[a-z]{2,4}$/.test(body.region) ? body.region : null;
          const outcome = await inviteToRoom(user.userId, other, room, game, kind, record, format, region);
          if (outcome === 'not-friends') return json(409, { error: 'Not friends with that player.' }), true;
          return json(200, { ok: true }), true;
        }
        default:
          return json(404, { error: 'unknown endpoint' }), true;
      }
    }

    // ---- public: username-PREFIX search (the "add a friend" box) ------------
    // Public because it returns only what /api/profile/<username> already does one at
    // a time. Matches the @username OR the DISPLAY NAME — people search for the name
    // they can see, and the name they can see on a leaderboard row is the handle.
    // The handle arm is a WORD prefix, not a free substring, so this stays a lookup
    // rather than a "list every name containing these two letters" probe; see
    // `searchUsersByName`. Presence never appears here; it is friends-only, in
    // /api/friends.
    if (req.method === 'GET' && url.pathname === '/api/users/search') {
      const raw = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      if (raw.length < 2) return json(200, { users: [] }), true;
      const users = dbEnabled ? await searchUsersByName(raw, 20) : [];
      return json(200, { users }), true;
    }

    // which GAME's boards/periods to read — DECODE and Chain Reaction each have their own
    // ranked/record boards and Act → Season progression (default DECODE for old clients).
    const game: GameId = coerceGameId(url.searchParams.get('game'));
    // default board view = the live season FOR THIS GAME (which may be admin-advanced past
    // the code's BALANCE_VERSION); an explicit ?season= picks an archived one.
    const seasonParam = url.searchParams.get('season');
    const season =
      seasonParam !== null
        ? Number(seasonParam)
        : dbEnabled
          ? await currentSeasonNumber(BALANCE_VERSION, game)
          : BALANCE_VERSION;
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 100)));
    // paginated match-history opts (repo clamps limit to [1,100], default 25)
    const historyOpts = {
      balanceVersion: season,
      game,
      offset: Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0),
      limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
      type: url.searchParams.get('type') ?? undefined,
      result: url.searchParams.get('result') ?? undefined,
    };
    const emptyHistory = { rows: [], total: 0, offset: historyOpts.offset, limit: historyOpts.limit ?? 25 };
    /** the same opts plus WHO IS READING, which decides whether each versus row carries its
     * `replayId` (migration 0038). Resolved per route rather than folded into `historyOpts`
     * above: that object is built for every `/api/*` GET, and verifying a JWT for a
     * leaderboard poll that will never look at a replay is work for nothing. */
    const historyOptsFor = async (
      r: IncomingMessage,
    ): Promise<typeof historyOpts & { viewerId: string | null; viewerIsStaff: boolean }> => {
      const vid = await viewerId(r);
      return {
        ...historyOpts,
        viewerId: vid,
        viewerIsStaff: !!vid && dbEnabled && (await isStaffUser(vid)),
      };
    };

    // recent announcements (patch notes / new season / new act) — public, cheap;
    // the client fetches this on load and shows any it hasn't marked seen locally.
    if (url.pathname === '/api/announcements') {
      const rows = dbEnabled ? await listAnnouncements(Math.min(50, limit)) : [];
      return json(200, { announcements: rows }), true;
    }

    // Region topology for the client's server picker. The picker used to MEASURE
    // every region by fly-replaying a /health probe to each one — which, with
    // `auto_start_machines`, BOOTED every idle region on each visit and defeated
    // auto-stop (the satellites are only cheap while stopped). The matchmaker has
    // always avoided this (see server/regions.ts): one probe of your OWN region
    // plus a static RTT matrix estimates the rest. This endpoint hands the client
    // that same matrix so the picker can do it too — no wakes, one source of truth.
    if (url.pathname === '/api/regions') {
      const rtt: Record<string, Record<string, number>> = {};
      for (const a of DEPLOY_REGIONS) {
        rtt[a] = {};
        for (const b of DEPLOY_REGIONS) rtt[a][b] = interRegionMs(a, b);
      }
      return json(200, { regions: DEPLOY_REGIONS, rtt }), true;
    }

    if (url.pathname === '/api/stats') {
      const stats = dbEnabled
        ? await getGlobalStats()
        : { users: 0, games: 0, byCategory: { solo: 0, duo: 0, '1v1': 0, '2v2': 0, custom: 0 }, detail: [] };
      return json(200, stats), true;
    }

    /**
     * A MATCH THE CLOUD DID NOT RUN, reported by the client that played it: solo practice (the
     * local sim) and a LAN match (sent by its host alone). Server rooms count themselves in
     * `persistMatch`. Public, because practice is played signed out; so the answer is always
     * 204 and a refused or throttled report is dropped without saying why.
     *
     * The count is client-reported and reaches nothing but the homepage counter. The limit
     * per address bounds how far one machine can move it; a school behind one NAT playing
     * practice all afternoon stays well inside it.
     */
    if (req.method === 'POST' && url.pathname === '/api/played') {
      const done = (): true => (res.writeHead(204, CORS), res.end(), true);
      if (!dbEnabled || !playedRateOk(clientIp(req))) return done();
      let body: { game?: unknown; source?: unknown; mode?: unknown };
      try {
        body = JSON.parse(await readBody(req, 512));
      } catch {
        return done();
      }
      if (!isGameId(body.game)) return done();
      const source = body.source === 'practice' || body.source === 'lan' ? body.source : null;
      if (!source) return done();
      // practice is one driver by construction; a LAN match is a versus room
      const mode = source === 'practice' ? 'solo' : body.mode === '2v2' ? '2v2' : '1v1';
      await countPlay(body.game, source, mode).catch((e: unknown) => console.error('[played] count failed:', e));
      return done();
    }

    // season list for the leaderboard's season picker; `current` is the live one
    if (url.pathname === '/api/seasons') {
      // each game's first period opens in its OWN act (DECODE keeps act 0/beta) — the
      // module owns that number, so a third game does not land in DECODE's bucket
      const current = dbEnabled ? await currentSeasonNumber(BALANCE_VERSION, game) : BALANCE_VERSION;
      if (dbEnabled) await ensureSeason(current, game, simModuleFor(game).initialAct);
      const seasons = dbEnabled ? await listSeasons(game) : [];
      return json(200, { current, seasons, game }), true;
    }

    if (url.pathname === '/api/records') {
      const mode = url.searchParams.get('mode') === 'duo' ? 'duo' : 'solo';
      const drivetrain = url.searchParams.get('drivetrain') ?? 'overall';
      /**
       * ⚠️ THE `physics` QUERY PARAMETER IS IGNORED (owner ruling, 2026-09-18).
       *
       * It briefly existed as an era picker — All / 3D / 2D — back when the two eras shared
       * this board. They do not: every server-connected match of a game that can step 3D is a
       * 3D match, so the board is the 3D board and `recordLeaderboard` decides that itself
       * (`boardPhysics` in repo.ts). Accepting the parameter would leave a URL anyone can type
       * that returns a second, unadvertised board of runs nothing new can be added to, and the
       * response would have to explain which one it was.
       *
       * READ AND DROPPED rather than deleted, so an older client that still appends
       * `&physics=2d` gets the live board instead of an error — and `physics` is echoed back
       * as what the board actually IS, not as what was asked for, so such a client's chip and
       * its rows cannot disagree.
       *
       * What the board IS depends on the season (2026-09-24): the live one is the live solve,
       * an archived one is the solve it was played on — BIOBUZZ Act 1 is a 2D board. The client
       * keeps the rows of the era echoed here.
       */
      const rows = dbEnabled
        ? await recordLeaderboard({ mode, drivetrain, balanceVersion: season, limit, game })
        : [];
      const physics =
        (dbEnabled ? await boardPhysics(game, season) : undefined) ?? serverPhysics(simModuleFor(game));
      return json(200, { season, mode, drivetrain, physics, rows, game }), true;
    }

    if (url.pathname === '/api/elo') {
      const mode = url.searchParams.get('mode') === '2v2' ? '2v2' : '1v1';
      const meId = url.searchParams.get('me');
      // The LIVE season reads the per-ACT board (elo_ratings — every currently-placed player);
      // an ARCHIVED season reads the per-season SNAPSHOT (elo_history — ratings frozen at that
      // season's end, so it shows the historical standings, not the moved-on live rating).
      const current = dbEnabled ? await currentSeasonNumber(BALANCE_VERSION, game) : season;
      const isLive = season >= current;
      let rows: Awaited<ReturnType<typeof eloLeaderboard>> = [];
      let me: Awaited<ReturnType<typeof eloUserStanding>> = null;
      if (dbEnabled && isLive) {
        const act = await actForSeason(season, game);
        rows = await eloLeaderboard({ mode, act, limit, game });
        me = meId ? await eloUserStanding({ userId: meId, mode, act, game }) : null;
      } else if (dbEnabled) {
        rows = await eloHistoryLeaderboard({ mode, balanceVersion: season, limit, game });
        me = meId ? await eloHistoryUserStanding({ userId: meId, mode, balanceVersion: season, game }) : null;
      }
      return json(200, { season, mode, rows, me, game, historical: !isLive }), true;
    }

    // public match history keyed by USERNAME (the profile page's history list)
    const profMatchesMatch = url.pathname.match(/^\/api\/profile\/([^/]+)\/matches$/);
    if (profMatchesMatch) {
      const username = decodeURIComponent(profMatchesMatch[1]).toLowerCase();
      const profile = dbEnabled ? await getProfileByUsername(username) : null;
      if (!profile) return json(404, { error: 'no such user' }), true;
      const page = await userMatchHistory(profile.userId, await historyOptsFor(req));
      return json(200, page), true;
    }

    // public profile + stats keyed by USERNAME (the /profile/<username> page)
    const profStatsMatch = url.pathname.match(/^\/api\/profile\/([^/]+)\/stats$/);
    if (profStatsMatch) {
      const username = decodeURIComponent(profStatsMatch[1]).toLowerCase();
      const profile = dbEnabled ? await getProfileByUsername(username) : null;
      if (!profile) return json(404, { error: 'no such user' }), true;
      const stats = await getUserStats(profile.userId, season, game);
      return json(200, stats), true;
    }
    const profMatch = url.pathname.match(/^\/api\/profile\/([^/]+)$/);
    if (profMatch) {
      const username = decodeURIComponent(profMatch[1]).toLowerCase();
      const profile = dbEnabled ? await getProfileByUsername(username) : null;
      if (!profile) return json(404, { error: 'no such user' }), true;
      return json(200, profile), true;
    }

    const matchesMatch = url.pathname.match(/^\/api\/user\/([^/]+)\/matches$/);
    if (matchesMatch) {
      const userId = decodeURIComponent(matchesMatch[1]);
      const page = dbEnabled
        ? await userMatchHistory(userId, await historyOptsFor(req))
        : emptyHistory;
      return json(200, page), true;
    }

    const statsMatch = url.pathname.match(/^\/api\/user\/([^/]+)\/stats$/);
    if (statsMatch) {
      const userId = decodeURIComponent(statsMatch[1]);
      const stats = dbEnabled ? await getUserStats(userId, season, game) : null;
      if (!stats) return json(200, { season, userId, elo: [], records: [], match: { played: 0, wins: 0, losses: 0 }, recent: [], handle: null, username: null }), true;
      return json(200, stats), true;
    }

    const profileMatch = url.pathname.match(/^\/api\/user\/([^/]+)$/);
    if (profileMatch) {
      const userId = decodeURIComponent(profileMatch[1]);
      const profile = dbEnabled ? await getProfile(userId) : null;
      return json(200, profile ?? { userId, handle: null, username: null }), true;
    }

    const replayMatch = url.pathname.match(/^\/api\/replay\/([\w-]+)$/);
    if (replayMatch) {
      if (!dbEnabled) return json(404, { error: 'not found' }), true;
      // THE GATE RUNS BEFORE THE READ (migration 0038). `getReplay` pulls two jsonb blobs
      // the size of a whole match, and a refused viewer should never cost that — nor should
      // a private replay be loaded into this process to be thrown away.
      const access = await replayAccess(replayMatch[1], await viewerId(req));
      if (access.access === 'missing') return json(404, { error: 'not found' }), true;
      if (access.access === 'private') {
        return (
          json(403, {
            error: 'private',
            // WHICH refusal it is, in words — the same discipline `replayRefusal` follows for
            // a version mismatch. A private match, somebody else's practice run and a
            // self-hosted event are three different answers, and a client that printed one
            // sentence for all of them would be wrong about two.
            message: replayRefusalMessage(access.kind),
          }),
          true
        );
      }
      const replay = await getReplay(replayMatch[1]);
      if (!replay) return json(404, { error: 'not found' }), true;
      return json(200, replay), true;
    }

    return json(404, { error: 'unknown endpoint' }), true;
  } catch (e) {
    console.error('[api] error:', e);
    return json(500, { error: 'internal error' }), true;
  }
}
