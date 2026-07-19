import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GameId } from '../src/types';
import { BALANCE_VERSION } from '../src/config';
import { dbEnabled } from './db/pool';
import {
  currentSeasonNumber,
  ensureProfile,
  ensureSeason,
  listAnnouncements,
  eloLeaderboard,
  eloUserStanding,
  getGlobalStats,
  getProfile,
  getProfileByUsername,
  getReplay,
  getUserSettings,
  getUserStats,
  listSeasons,
  recordLeaderboard,
  saveUserSettings,
  setHandle,
  setUsername,
  userMatchHistory,
  usernameAvailable,
  UsernameTakenError,
} from './db/repo';
import { verifyAuthToken } from './auth';

/**
 * Public read API for the leaderboards + replay viewer (GET), plus ONE
 * authenticated write: a user editing their own display name (`POST
 * /api/user/handle`, JWT-verified — every other write still goes through the
 * authoritative match loop). Same port as the WS server. CORS-open because the
 * data is public and the client is a different origin (Vercel). Returns
 * empty/404 gracefully when the DB is disabled.
 *
 *   GET  /api/stats                          — site-wide players + games played
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
 *   GET  /api/replay/<id>
 */

/** Public usernames: lowercase letters + digits only, 4–20 chars. Kept in sync
 * with the client's validator (src/net/api.ts `USERNAME_RE`) and the DB's unique
 * index. Returns the normalized (trimmed, lowercased) value or null if invalid. */
const USERNAME_RE = /^[a-z0-9]{4,20}$/;
function normalizeUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const u = raw.trim().toLowerCase();
  return USERNAME_RE.test(u) ? u : null;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '600',
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 512 * 1024) reject(new Error('body too large')); // 512KB cap (settings can carry an auto-path)
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
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
      const available = dbEnabled ? await usernameAvailable(username) : true;
      return json(200, { valid: true, available, username }), true;
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
        settings = JSON.parse(await readBody(req)).settings;
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

    // which GAME's boards/periods to read — DECODE and Chain Reaction each have their own
    // ranked/record boards and Act → Season progression (default DECODE for old clients).
    const game: GameId = url.searchParams.get('game') === 'chain' ? 'chain' : 'decode';
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

    // recent announcements (patch notes / new season / new act) — public, cheap;
    // the client fetches this on load and shows any it hasn't marked seen locally.
    if (url.pathname === '/api/announcements') {
      const rows = dbEnabled ? await listAnnouncements(Math.min(50, limit)) : [];
      return json(200, { announcements: rows }), true;
    }

    if (url.pathname === '/api/stats') {
      const stats = dbEnabled
        ? await getGlobalStats()
        : { users: 0, games: 0, byCategory: { solo: 0, duo: 0, '1v1': 0, '2v2': 0 } };
      return json(200, stats), true;
    }

    // season list for the leaderboard's season picker; `current` is the live one
    if (url.pathname === '/api/seasons') {
      // seed Chain Reaction's first period at Act 1 · Season 1 (DECODE keeps act 0/beta)
      const current = dbEnabled ? await currentSeasonNumber(BALANCE_VERSION, game) : BALANCE_VERSION;
      if (dbEnabled) await ensureSeason(current, game, game === 'chain' ? 1 : 0);
      const seasons = dbEnabled ? await listSeasons(game) : [];
      return json(200, { current, seasons, game }), true;
    }

    if (url.pathname === '/api/records') {
      const mode = url.searchParams.get('mode') === 'duo' ? 'duo' : 'solo';
      const drivetrain = url.searchParams.get('drivetrain') ?? 'overall';
      const rows = dbEnabled
        ? await recordLeaderboard({ mode, drivetrain, balanceVersion: season, limit, game })
        : [];
      return json(200, { season, mode, drivetrain, rows, game }), true;
    }

    if (url.pathname === '/api/elo') {
      const mode = url.searchParams.get('mode') === '2v2' ? '2v2' : '1v1';
      const meId = url.searchParams.get('me');
      const rows = dbEnabled ? await eloLeaderboard({ mode, balanceVersion: season, limit, game }) : [];
      // the viewer's own standing (rank among placed, or games-in-placements),
      // so the board can surface it even when they're off the visible page
      const me =
        dbEnabled && meId
          ? await eloUserStanding({ userId: meId, mode, balanceVersion: season, game })
          : null;
      return json(200, { season, mode, rows, me, game }), true;
    }

    // public match history keyed by USERNAME (the profile page's history list)
    const profMatchesMatch = url.pathname.match(/^\/api\/profile\/([^/]+)\/matches$/);
    if (profMatchesMatch) {
      const username = decodeURIComponent(profMatchesMatch[1]).toLowerCase();
      const profile = dbEnabled ? await getProfileByUsername(username) : null;
      if (!profile) return json(404, { error: 'no such user' }), true;
      const page = await userMatchHistory(profile.userId, historyOpts);
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
      const page = dbEnabled ? await userMatchHistory(userId, historyOpts) : emptyHistory;
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
      const replay = dbEnabled ? await getReplay(replayMatch[1]) : null;
      if (!replay) return json(404, { error: 'not found' }), true;
      return json(200, replay), true;
    }

    return json(404, { error: 'unknown endpoint' }), true;
  } catch (e) {
    console.error('[api] error:', e);
    return json(500, { error: 'internal error' }), true;
  }
}
