import type { IncomingMessage, ServerResponse } from 'node:http';
import { BALANCE_VERSION } from '../src/config';
import { dbEnabled } from './db/pool';
import { eloLeaderboard, getReplay, recordLeaderboard } from './db/repo';

/**
 * Public read API for the leaderboards + replay viewer (GET only; all writes go
 * through the authoritative match loop, never HTTP). Same port as the WS server.
 * CORS-open because the data is public and the client is a different origin
 * (Vercel). Returns empty/404 gracefully when the DB is disabled.
 *
 *   GET /api/records?mode=solo|duo&drivetrain=<dt|overall>&season=<n>&limit=<n>
 *   GET /api/elo?mode=1v1|2v2&drivetrain=<dt|overall>&season=<n>&limit=<n>
 *   GET /api/replay/<id>
 */
export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return false;

  const json = (code: number, body: unknown): void => {
    res.writeHead(code, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(body));
  };

  try {
    const season = Number(url.searchParams.get('season') ?? BALANCE_VERSION);
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 100)));

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
