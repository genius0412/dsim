/**
 * ADMIN CONSOLE VERIFICATION HARNESS — `npm run adminharness`.
 *
 * Boots the REAL `server/index.ts` against PGlite with a LOCAL JWKS, so the admin routes, the
 * admin gate and the repo queries under test are the genuine article rather than a mock. Same
 * trick, and the same `setPoolForTests` seam, that `scripts/dbtest.ts` already uses — the
 * difference is that dbtest drives the repo directly while this serves a whole console you can
 * click through. **It touches no real database and no Fly machine**: everything is in memory and
 * bound to localhost, and it is gone when the process is.
 *
 * ⚠️ IT IS IN `scripts/` RATHER THAN IN `scratch/` DELIBERATELY. It was written in gitignored
 * scratch, which meant the admin console — the one surface with no automated UI coverage — could
 * only be verified by whoever still had that file. `.claude/launch.json` carries an
 * `admin-harness` entry pointing at port 5189, and a launch config whose companion is not in the
 * repo is a trap for the next clone.
 *
 * Two servers:
 *   :8798  the fake auth endpoint — `/.well-known/jwks.json` (what server/auth.ts verifies
 *          against) and `/token` (what the client's `getAuthToken()` fetches).
 *   :8799  the real game server, `PORT=8799`, `ADMIN_USER_IDS=harness-owner`.
 *
 * Then, for the client (or `preview_start` the `admin-harness` launch config):
 *       VITE_NEON_AUTH_URL=http://localhost:8798 VITE_GAME_SERVER_URL=ws://localhost:8799
 *       npx vite --port 5189 --strictPort
 */
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { setPoolForTests, type DbPool } from '../server/db/pool';

const ADMIN_ID = 'harness-owner';
const AUTH_PORT = 8798;

function adapt(db: PGlite): DbPool {
  const query = async (text: string, params: unknown[] = []) => {
    if (params.length === 0) {
      const res = await db.exec(text);
      return { rows: (res[res.length - 1]?.rows ?? []) as never[] };
    }
    return (await db.query(text, params)) as { rows: never[] };
  };
  return {
    query: query as DbPool['query'],
    connect: async () => ({ query: query as DbPool['query'], release: () => {} }),
  };
}

async function main(): Promise<void> {
  // ---- the fake auth endpoint, first: the game server builds its JWKS set at import time
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), alg: 'RS256', use: 'sig', kid: 'harness' };
  const token = await new SignJWT({ name: 'Harness Owner', email_verified: true })
    .setProtectedHeader({ alg: 'RS256', kid: 'harness' })
    .setSubject(ADMIN_ID)
    .setIssuedAt()
    .setExpirationTime('12h')
    .sign(privateKey);

  // ECHO the requested headers: with `allow-credentials`, `*` is not permitted, and the
  // Neon Auth SDK sends `x-neon-client-info`, which a fixed list does not cover.
  const cors = (req: { headers: Record<string, unknown> }) => ({
    'access-control-allow-origin': (req.headers.origin as string) ?? '*',
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers':
      (req.headers['access-control-request-headers'] as string) ?? 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  });
  createServer((req, res) => {
    const h = cors(req as never);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, h);
      res.end();
      return;
    }
    if (req.url?.startsWith('/.well-known/jwks.json')) {
      res.writeHead(200, { ...h, 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (req.url?.startsWith('/token')) {
      res.writeHead(200, { ...h, 'content-type': 'application/json' });
      res.end(JSON.stringify({ token }));
      return;
    }
    // the SDK probes a session route on mount. Better Auth answers `get-session` with the
    // session object at the TOP level (`{ user, session }`), not wrapped in `data`.
    console.log('[harness/auth]', req.method, req.url);
    if (req.url?.includes('session')) {
      res.writeHead(200, { ...h, 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          user: { id: ADMIN_ID, name: 'Harness Owner', email: 'owner@example.test', emailVerified: true },
          session: { id: 'harness-session', userId: ADMIN_ID, expiresAt: new Date(Date.now() + 864e5).toISOString() },
        }),
      );
      return;
    }
    res.writeHead(200, { ...h, 'content-type': 'application/json' });
    res.end('{}');
  }).listen(AUTH_PORT, () => console.log(`[harness] auth on :${AUTH_PORT}`));

  // ---- the database
  const db = new PGlite();
  await db.waitReady;
  setPoolForTests(adapt(db));

  process.env.PORT = '8799';
  process.env.ADMIN_USER_IDS = ADMIN_ID;
  process.env.OWNER_USER_ID = ADMIN_ID;
  process.env.NEON_AUTH_JWKS_URL = `http://localhost:${AUTH_PORT}/.well-known/jwks.json`;
  process.env.NEON_AUTH_URL = `http://localhost:${AUTH_PORT}`;
  process.env.REGION = 'iad';
  process.env.FLY_MACHINE_ID = 'harness-machine';

  const { migrate } = await import('../server/db/migrate');
  await migrate();
  const repo = await import('../server/db/repo');
  await seed(repo, db);

  // ---- the real server
  await import('../server/index');
  console.log(`[harness] game server on :8799 — admin is ${ADMIN_ID}`);

  // keep the seeded lhr heartbeat inside `adminPresence`'s 20s freshness window
  setInterval(() => {
    void db.query(`update presence set updated_at = now() where machine = 'lhr-machine'`);
  }, 5000);

  // ---- LIVE SESSIONS on THIS machine, which is the path "(no profile)" came from.
  // Two authed sockets: the owner, and an account that has authenticated but has no
  // `profiles` row yet — the state the old label could not tell from a failed lookup.
  const { WebSocket } = await import('ws');
  const sign = (sub: string, name: string): Promise<string> =>
    new SignJWT({ name })
      .setProtectedHeader({ alg: 'RS256', kid: 'harness' })
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime('12h')
      .sign(privateKey);
  const join = async (sub: string, name: string, room: string): Promise<void> => {
    const t = await sign(sub, name);
    const ws = new WebSocket('ws://localhost:8799');
    ws.on('open', () =>
      ws.send(
        JSON.stringify({ t: 'join', room, player: { name, alliance: 'red', ready: false }, authToken: t }),
      ),
    );
    ws.on('error', (e: unknown) => console.warn('[harness] socket:', e));
  };
  setTimeout(() => {
    void join(ADMIN_ID, 'Harness Owner', 'probe1');
    void join('brand-new-signup-0a91', 'Player', 'probe2');
    void join('u-margaret', 'Margaret Hamilton', 'probe1');
  }, 1500);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function seed(repo: any, db: PGlite): Promise<void> {
  await repo.ensureProfile(ADMIN_ID, 'Harness Owner');
  await repo.setUsername(ADMIN_ID, 'harnessowner');

  const people: [string, string, string | null][] = [
    ['u-ada', 'Ada Lovelace', 'ada'],
    ['u-grace', 'Grace Hopper', 'grace'],
    ['u-alan', 'Alan Turing', 'alan'],
    ['u-katherine', 'Katherine Johnson', null], // no username yet — the second label case
    ['u-margaret', 'Margaret Hamilton', 'margaret'],
    ['u-annie', 'Annie Easley', 'annie'],
  ];
  for (const [id, handle, username] of people) {
    await repo.ensureProfile(id, handle);
    if (username) await repo.setUsername(id, username);
  }
  await repo.grantSupporter('u-grace', 3, 'admin', 'by harness: contributor');

  // reports, both directions
  await repo.submitReport({ reportedId: 'u-alan', reporterId: 'u-ada', reason: 'cheating', roomCode: 'iad-9f2a', detail: 'drove through the wall twice' });
  await repo.submitReport({ reportedId: 'u-alan', reporterId: 'u-grace', reason: 'throwing', roomCode: 'iad-9f2a' });
  await repo.submitReport({ reportedId: 'u-alan', reporterId: 'u-margaret', reason: 'afk', roomCode: 'iad-3c11' });
  await repo.submitReport({ reportedId: 'u-annie', reporterId: 'u-alan', reason: 'name', roomCode: '' });
  await repo.submitScoreReport({ reporterId: 'u-ada', roomCode: 'iad-9f2a', detail: 'the classifier counted my last three artifacts twice' });

  // standing: something for the ledger to show
  await repo.writeStandingEvent(
    'u-alan',
    { kind: 'dodge', points: 12, scoreBefore: 100, scoreAfter: 88, tierAfter: 'watch', cooldownMin: 5, ratingCharge: 0, rung: 1 },
    { game: 'decode', mode: '1v1', roomCode: 'iad-9f2a' },
  );
  await repo.writeStandingEvent(
    'u-alan',
    { kind: 'leave', points: 24, scoreBefore: 88, scoreAfter: 64, tierAfter: 'watch', cooldownMin: 30, ratingCharge: 8, rung: 2 },
    { game: 'decode', mode: '1v1', roomCode: 'iad-3c11' },
  );

  // records + matches, so the boards and the drill-downs have rows
  const SEASON = 4;
  for (const [i, [id]] of people.entries()) {
    const replay = await repo.saveReplay(
      { format: 2, balanceVersion: SEASON, sim: 3, game: 'decode', mode: 'match', seed: 100 + i, ticks: 9000, setups: [], tracks: {} },
      SEASON,
      'decode',
    );
    await repo.submitRecord({
      userId: id,
      handle: people[i][1],
      score: 180 - i * 11,
      mode: 'solo',
      drivetrain: ['mecanum', 'tank', 'swerve', 'xdrive', 'mecanum', 'tank'][i],
      balanceVersion: SEASON,
      replayId: replay,
      game: 'decode',
      config: null,
    }).catch(() => {});
    const mid = await repo.saveMatch('1v1', SEASON, replay, true, 'decode');
    await repo.addMatchParticipant({ matchId: mid, userId: id, alliance: 'red', drivetrain: 'mecanum', score: 120 - i * 7, won: i % 2 === 0, ratingBefore: 1500, ratingAfter: 1512 });
    await repo.addMatchParticipant({ matchId: mid, userId: 'u-alan', alliance: 'blue', drivetrain: 'tank', score: 90, won: i % 2 !== 0, ratingBefore: 1500, ratingAfter: 1488 });
  }

  // a heartbeat from a SECOND region, so the Live table has rows the local snapshot does not
  await db.query(
    `insert into presence (machine, region, online, players, guests, anon, rooms, updated_at)
     values ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb, now())
     on conflict (machine) do update set updated_at = now()`,
    [
      'lhr-machine', 'lhr', 4,
      JSON.stringify([
        { userId: 'u-ada', act: 'match', room: 'lhr-7b21', game: 'decode', sessions: 1 },
        { userId: 'u-grace', act: 'menu', queue: '1v1', queuedS: 47, queueGame: 'chain', sessions: 2 },
        // ⚠️ THE CASE THE BUG WAS ABOUT: a signed-in session whose account has no profile row.
        { userId: 'brand-new-signup-0a91', act: 'menu', sessions: 1 },
      ]),
      JSON.stringify([{ id: 'sock-4f2b8c11', act: 'lobby', room: 'lhr-7b21' }]),
      JSON.stringify({ total: 1, inMatch: 0, inLobby: 1, idle: 0 }),
      JSON.stringify([{ room: 'lhr-7b21', region: 'lhr', game: 'decode', mode: '1v1', ranked: true, phase: 'teleop', score: { red: 42, blue: 38 }, spectators: 2, players: [{ name: 'Ada Lovelace' }, { name: 'Alan Turing' }] }]),
    ],
  );

  await seedAnalytics(db);

  // a few audit rows so the tab is not empty on first paint
  await repo.writeAudit({ adminId: ADMIN_ID, action: 'user.rename', targetUser: 'u-annie', detail: { from: 'xXslurXx', to: 'Annie Easley' }, note: 'name policy' });
  await repo.writeAudit({ adminId: ADMIN_ID, action: 'supporter.grant', targetUser: 'u-grace', detail: { months: 3 }, note: 'contributor' });
  await repo.writeAudit({ adminId: ADMIN_ID, action: 'season.start', detail: { game: 'decode', season: 1, label: 'Act 1 · Season 1' } });
  await repo.writeAudit({ adminId: 'secret', action: 'notice.restart', detail: { seconds: 300, notified: 12 }, note: 'Scheduled server update' });
  await repo.writeAudit({ adminId: ADMIN_ID, action: 'record.delete', targetUser: 'u-alan', targetId: 'rec-0f21', note: 'impossible score' });
  await repo.addAdminNote('u-alan', ADMIN_ID, 'Third report this week. Team says it is a shared laptop.');
  console.log('[harness] seeded');
}

/**
 * TRAFFIC, so the Analytics tab has something to draw. Fourteen days of raw pageviews and
 * events across every dimension the dashboard breaks down by, plus concurrency samples — the
 * beacon only ever writes `now`, so history has to be inserted.
 */
async function seedAnalytics(db: PGlite): Promise<void> {
  const PATHS = ['/', '/decode', '/decode/records', '/chain', '/support', '/download', '/account'];
  const REFS = ['', 'google.com', 'reddit.com', 'youtube.com', 'discord.com'];
  const COUNTRIES = ['US', 'GB', 'DE', 'CA', '', 'IN'];
  const DEVICES = ['desktop', 'mobile', 'tablet'];
  const OSES = ['Windows', 'macOS', 'Android', 'iOS', 'Linux'];
  const BROWSERS = ['Chrome', 'Safari', 'Firefox', 'Edge'];
  const SCREENS = ['sm', 'md', 'lg', 'xl'];
  const LANGS = ['en', 'de', 'es', ''];
  const GAMES = ['decode', 'chain', 'biobuzz', ''];
  const UTM_S = ['', 'twitter', 'newsletter', 'reddit'];
  const EVENTS = ['support_view', 'sponsor_shown', 'sponsor_shown', 'sponsor_dwell', 'sponsor_click', 'desktop_download', 'support_claim_fail', 'player_joined'];
  const PLACEMENTS = ['home', 'footer', 'game', 'download'];
  const propsFor = (name: string): Record<string, string> =>
    name === 'sponsor_shown' || name === 'sponsor_click'
      ? { placement: pick(PLACEMENTS) }
      : name === 'sponsor_dwell'
        ? { placement: pick(PLACEMENTS), dwell: pick(['<5s', '5-15s', '15-60s', '1-5m', '5m+']) }
        : name === 'desktop_download'
          ? { os: pick(['windows', 'mac', 'linux']) }
          : name === 'support_claim_fail'
            ? { reason: pick(['taken', 'expired']) }
            : {};

  let seed = 42;
  const rnd = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];

  const pvRows: unknown[][] = [];
  const evRows: unknown[][] = [];
  for (let d = 13; d >= 0; d--) {
    const sessions = 18 + Math.floor(rnd() * 30);
    for (let s = 0; s < sessions; s++) {
      const visitor = `v${d}-${s.toString(16).padStart(4, '0')}`;
      const country = pick(COUNTRIES);
      const device = pick(DEVICES);
      const os = pick(OSES);
      const browser = pick(BROWSERS);
      const screen = pick(SCREENS);
      const lang = pick(LANGS);
      const ref = pick(REFS);
      const utm = pick(UTM_S);
      const surface = rnd() < 0.12 ? 'electron' : 'web';
      const channel = rnd() < 0.2 ? 'alpha' : 'stable';
      const views = 1 + Math.floor(rnd() * 5);
      const start = Date.now() - d * 86_400_000 + Math.floor(rnd() * 20) * 3_600_000;
      for (let v = 0; v < views; v++) {
        const at = new Date(start + v * 90_000).toISOString();
        pvRows.push([at, visitor, pick(PATHS), pick(GAMES), ref, utm, utm ? 'social' : '', utm ? 'launch' : '', country, device, os, browser, screen, lang, surface, channel, '9162190']);
      }
      if (rnd() < 0.5) {
        const name = pick(EVENTS);
        evRows.push([
          new Date(start + 60_000).toISOString(), visitor, name, pick(GAMES), pick(PATHS),
          JSON.stringify(propsFor(name)),
        ]);
      }
    }
    for (const region of ['iad', 'lhr']) {
      for (let h = 0; h < 24; h += 4) {
        await db.query(
          `insert into analytics_concurrency (at, region, online, authed, rooms, q1v1, q2v2)
           values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing`,
          [new Date(Date.now() - d * 86_400_000 + h * 3_600_000).toISOString(), region,
            5 + Math.floor(rnd() * 40), 3 + Math.floor(rnd() * 20), Math.floor(rnd() * 8), Math.floor(rnd() * 4), Math.floor(rnd() * 3)],
        );
      }
    }
  }
  for (const r of pvRows) {
    await db.query(
      `insert into analytics_pageviews (at, visitor, path, game, ref_host, utm_source, utm_medium, utm_campaign, country, device, os, browser, screen, lang, surface, channel, build)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      r,
    );
  }
  for (const r of evRows) {
    await db.query(`insert into analytics_events (at, visitor, name, game, path, props) values ($1,$2,$3,$4,$5,$6::jsonb)`, r);
  }
  console.log(`[harness] seeded analytics: ${pvRows.length} pageviews, ${evRows.length} events`);

  // The imported history: a local Vercel export if one was made
  // (`scripts/vercel-analytics-export.mjs`, gitignored under scratch/), else a small made-up one.
  // The made-up one runs from 20 days ago to 6 days ago, so it OVERLAPS the first-party days
  // above (13 days ago on) the way the real one does: the dashboard reads it for the days before
  // our own count and ignores the rest, and a 30-day range shows the boundary.
  const { vercelImportRows } = await import('../server/analyticsImport');
  const { replaceImportedAnalytics } = await import('../server/db/repo');
  const local = 'scratch/vercel-analytics-production.json';
  let rows;
  if (existsSync(local)) {
    rows = vercelImportRows(JSON.parse(readFileSync(local, 'utf8')));
  } else {
    const days = Array.from({ length: 15 }, (_, i) => new Date(Date.now() - (20 - i) * 86_400_000).toISOString().slice(0, 10));
    // Each breakdown splits the day's total, with the host's "Others" remainder where it had one.
    const split = (day: string, total: number, vals: string[], others = false) => {
      const shares = vals.map(() => 1 + rnd() * 3);
      const sum = shares.reduce((a, b) => a + b, 0) * (others ? 1.1 : 1);
      const out = vals.map((value, i) => ({ day, value, pageviews: Math.round((total * shares[i]) / sum), visitors: Math.max(1, Math.round((total * shares[i]) / sum / 3)) }));
      if (others) out.push({ day, value: 'Others', pageviews: total - out.reduce((a, r) => a + r.pageviews, 0), visitors: 2 });
      return out;
    };
    const totals = days.map((day) => ({ day, pageviews: 120 + Math.floor(rnd() * 100), visitors: 40 + Math.floor(rnd() * 25) }));
    const by = (vals: string[], others = false) => totals.flatMap((t) => split(t.day, t.pageviews, vals, others));
    rows = vercelImportRows({
      source: 'vercel',
      visits: {
        total: totals,
        by: {
          requestPath: by(PATHS, true),
          referrerHostname: by(['', 'google.com', 'reddit.com', 'discord.com']),
          country: by(['US', 'GB', 'DE', 'CA', 'RO'], true),
          deviceType: by(['Desktop', 'Mobile']),
          osName: by(['Windows', 'Mac', 'Chrome OS', 'iOS']),
          browserName: by(['Chrome', 'Microsoft Edge', 'Mobile Safari', 'Firefox']),
        },
      },
      events: {
        byName: days.flatMap((day) => [
          { day, name: 'sponsor_shown', count: 40, visitors: 20 },
          { day, name: 'sponsor_click', count: 2, visitors: 2 },
          { day, name: 'player_joined', count: 3, visitors: 3 },
        ]),
        byProp: days.flatMap((day) => [
          ...PLACEMENTS.map((p) => ({ day, name: 'sponsor_shown', key: 'placement', value: p, count: 10, visitors: 6 })),
          { day, name: 'sponsor_click', key: 'placement', value: 'home', count: 2, visitors: 2 },
        ]),
      },
    });
  }
  const res = await replaceImportedAnalytics('vercel', rows);
  console.log(`[harness] imported Vercel history: ${res.inserted} rows, ${res.firstDay} → ${res.lastDay}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
