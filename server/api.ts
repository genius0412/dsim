import type { IncomingMessage, ServerResponse } from 'node:http';
import { BALANCE_VERSION } from '../src/config';
import { dbEnabled } from './db/pool';
import {
  ensureProfile,
  eloLeaderboard,
  getGlobalStats,
  getProfile,
  getReplay,
  getUserSettings,
  getUserStats,
  recordLeaderboard,
  saveUserSettings,
  setHandle,
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
 *   GET  /api/elo?mode=1v1|2v2&drivetrain=<dt|overall>&season=<n>&limit=<n>
 *   GET  /api/user/<id>/stats?season=<n>   — one user's ELO+records+W/L+history
 *   GET  /api/user/<id>                     — a user's public profile (handle)
 *   POST /api/user/handle  {handle}         — set your OWN display name (Bearer JWT)
 *   GET  /api/user/settings                  — your synced settings (Bearer JWT)
 *   POST /api/user/settings {settings}       — save your settings (Bearer JWT)
 *   GET  /api/replay/<id>
 */

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

    const season = Number(url.searchParams.get('season') ?? BALANCE_VERSION);
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 100)));

    if (url.pathname === '/api/stats') {
      const stats = dbEnabled
        ? await getGlobalStats()
        : { users: 0, games: 0, byCategory: { solo: 0, duo: 0, '1v1': 0, '2v2': 0 } };
      return json(200, stats), true;
    }

    if (url.pathname === '/api/records') {
      const mode = url.searchParams.get('mode') === 'duo' ? 'duo' : 'solo';
      const drivetrain = url.searchParams.get('drivetrain') ?? 'overall';
      const rows = dbEnabled
        ? await recordLeaderboard({ mode, drivetrain, balanceVersion: season, limit })
        : [];
      return json(200, { season, mode, drivetrain, rows }), true;
    }

    if (url.pathname === '/api/elo') {
      const mode = url.searchParams.get('mode') === '2v2' ? '2v2' : '1v1';
      const drivetrain = url.searchParams.get('drivetrain') ?? 'overall';
      const rows = dbEnabled
        ? await eloLeaderboard({ mode, drivetrain, balanceVersion: season, limit })
        : [];
      return json(200, { season, mode, drivetrain, rows }), true;
    }

    const statsMatch = url.pathname.match(/^\/api\/user\/([^/]+)\/stats$/);
    if (statsMatch) {
      const userId = decodeURIComponent(statsMatch[1]);
      const stats = dbEnabled ? await getUserStats(userId, season) : null;
      if (!stats) return json(200, { season, userId, elo: [], records: [], match: { played: 0, wins: 0, losses: 0 }, recent: [], handle: null }), true;
      return json(200, stats), true;
    }

    const profileMatch = url.pathname.match(/^\/api\/user\/([^/]+)$/);
    if (profileMatch) {
      const userId = decodeURIComponent(profileMatch[1]);
      const profile = dbEnabled ? await getProfile(userId) : null;
      return json(200, profile ?? { userId, handle: null }), true;
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
