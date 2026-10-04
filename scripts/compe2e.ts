/**
 * COMPETITIONS END TO END — `npx tsx scripts/compe2e.ts` (about five minutes; not in any suite).
 *
 * The REAL `server/index.ts` on PGlite with a local JWKS (the `adminharness.ts` arrangement), driven
 * over HTTP and WebSockets the way two browsers and an organizer would:
 *   1. an admin creates a 1v1 DECODE competition, two players register, it is published, drawn and
 *      started;
 *   2. Q1 is called; both players open its room, the strategy window carries the competition, they
 *      ready up, the match plays out on the server at real time, and the result lands on the
 *      competition (`played`, with a replay that a stranger can watch);
 *   3. Q2 is called and only one player turns up: the room's grace runs out and the match goes back
 *      on the schedule with a note for the referee, charging nobody's standing;
 *   4. the call bar's read (`/api/competitions/me`) says the match is called while it is;
 *   5. the competition ranks by the Competition Manual (0060), and the played match's row holds
 *      what the room measured (`rankFacts`), in DECODE's keys, per alliance.
 *
 * What `npm run dbtest` cannot reach: the join path's claim, `Room.applyPending` with a competition,
 * the strategy window's `competition` field, the room reporting through `persistMatch` and the
 * dodge report. Nothing here touches a real database or a Fly machine.
 */
import { createServer } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { setPoolForTests, type DbPool } from '../server/db/pool';

const AUTH_PORT = 8796;
const GAME_PORT = 8797;
const ADMIN = 'e2e-admin';
const P1 = 'e2e-p1';
const P2 = 'e2e-p2';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

function adapt(db: PGlite): DbPool {
  const query = async (text: string, params: unknown[] = []) => {
    if (params.length === 0) {
      const res = await db.exec(text);
      return { rows: (res[res.length - 1]?.rows ?? []) as never[] };
    }
    return (await db.query(text, params)) as { rows: never[] };
  };
  return { query: query as DbPool['query'], connect: async () => ({ query: query as DbPool['query'], release: () => {} }) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), alg: 'RS256', use: 'sig', kid: 'e2e' };
  createServer((req, res) => {
    if (req.url?.startsWith('/.well-known/jwks.json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.writeHead(404);
    res.end();
  }).listen(AUTH_PORT);
  const sign = (sub: string, name: string): Promise<string> =>
    new SignJWT({ name, email_verified: true }).setProtectedHeader({ alg: 'RS256', kid: 'e2e' }).setSubject(sub).setIssuedAt().setExpirationTime('2h').sign(privateKey);

  const db = new PGlite();
  await db.waitReady;
  setPoolForTests(adapt(db));
  process.env.PORT = String(GAME_PORT);
  process.env.ADMIN_USER_IDS = ADMIN;
  process.env.NEON_AUTH_JWKS_URL = `http://localhost:${AUTH_PORT}/.well-known/jwks.json`;
  process.env.NEON_AUTH_URL = `http://localhost:${AUTH_PORT}`;
  process.env.FLY_MACHINE_ID = 'e2e-machine';
  const { migrate } = await import('../server/db/migrate');
  await migrate();
  const repo = await import('../server/db/repo');
  for (const [id, handle, username] of [[ADMIN, 'Organizer', 'organizer'], [P1, 'Ada', 'ada'], [P2, 'Grace', 'grace']] as const) {
    await repo.ensureProfile(id, handle);
    await repo.setUsername(id, username);
  }
  await import('../server/index');
  await sleep(1500);

  const base = `http://localhost:${GAME_PORT}`;
  const tok = { admin: await sign(ADMIN, 'Organizer'), p1: await sign(P1, 'Ada'), p2: await sign(P2, 'Grace') };
  const api = async (method: 'GET' | 'POST', path: string, who: keyof typeof tok | null, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${tok[who]}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  // ---- 1. create, register, publish, draw, start
  const made = await api('POST', '/api/competitions', 'admin', {
    name: 'End To End Open',
    game: 'decode',
    format: '1v1',
    capacity: 4,
    settings: {
      quals: { kind: 'roundRobin', matchesPerEntry: 2 },
      rp: { scheme: 'cm', level: 'event', thresholds: {} },
      playoffs: { enabled: false },
      checkIn: false,
      run: { joinGraceSec: 60, noShow: 'hold' },
    },
  });
  check('e2e: an admin creates a competition over HTTP', made.status === 200 && !!made.body.slug, JSON.stringify(made));
  const slug = made.body.slug as string;
  const c = (action: string, who: keyof typeof tok, body: unknown = {}) => api('POST', `/api/competitions/${slug}/${action}`, who, body);
  const pub = await c('status', 'admin', { to: 'published' });
  check('e2e: published', pub.status === 200, JSON.stringify(pub.body));
  const r1 = await c('register', 'p1');
  const r2 = await c('register', 'p2');
  check('e2e: two players register', r1.status === 200 && r2.status === 200 && r1.body.status === 'registered', JSON.stringify([r1.body, r2.body]));
  const anon = await api('POST', `/api/competitions/${slug}/register`, null, {});
  check('e2e: registering signed out is a 401', anon.status === 401);
  const notAdmin = await c('status', 'p1', { to: 'qualification' });
  check('e2e: a player cannot run the competition', notAdmin.status === 403);
  const start = await c('status', 'admin', { to: 'qualification' });
  check('e2e: qualifications start (the round robin is drawn on the way)', start.status === 200, JSON.stringify(start.body));
  let d = (await api('GET', `/api/competitions/${slug}`, 'admin')).body;
  check('e2e: two entries, two cycles: two qualification matches', d.matches?.length === 2, JSON.stringify(d.matches?.map((m: { label: string }) => m.label)));
  const q1 = d.matches[0];

  // ---- 2. call Q1, both join, play it out
  const call = await c('match', 'admin', { action: 'call', match: q1.id });
  check('e2e: Q1 is called', call.status === 200 && call.body.called === true, JSON.stringify(call.body));
  d = (await api('GET', `/api/competitions/${slug}`, 'p1')).body;
  const called = d.matches.find((m: { id: number }) => m.id === q1.id);
  check('e2e: the called match carries a competition room code', /^[a-z]{3}-cm[0-9a-z]{8}$/.test(called.roomCode ?? ''), called.roomCode);
  const me = (await api('GET', '/api/competitions/me', 'p1')).body;
  check('e2e: the call bar’s read says the match is called', me.competitions?.[0]?.called?.roomCode === called.roomCode, JSON.stringify(me));

  const { WebSocket } = await import('ws');
  const { DEFAULT_SPEC, DEFAULT_ASSISTS } = await import('../src/sim/spawn');
  type Seat = { ws: InstanceType<typeof WebSocket>; got: Map<string, any[]> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const open = (who: 'p1' | 'p2', room: string): Promise<Seat> =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://localhost:${GAME_PORT}/?room=${room}`);
      const got = new Map<string, any[]>(); // eslint-disable-line @typescript-eslint/no-explicit-any
      ws.on('message', (raw: Buffer) => {
        let m: { t?: string };
        try {
          m = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (!m.t || m.t === 'snapshot') return;
        const list = got.get(m.t) ?? [];
        list.push(m);
        got.set(m.t, list);
        // ready up the moment the strategy window opens
        if (m.t === 'strategyStart') ws.send(JSON.stringify({ t: 'update', patch: { ready: true } }));
      });
      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            t: 'join',
            room,
            authToken: tok[who],
            caps: ['strategy', 'startpose', 'game', 'seat'],
            player: { name: who === 'p1' ? 'Ada' : 'Grace', teamName: '', teamNumber: 0, alliance: 'red', startIndex: 0, ready: false, spec: DEFAULT_SPEC, assists: DEFAULT_ASSISTS },
          }),
        );
        resolve({ ws, got });
      });
    });
  // the first driver arrives, leaves (a reload, a trip back to the page) and comes back: the room
  // must hold the seat while it waits, not empty itself and leave the call claimed with no room
  const early = await open('p1', called.roomCode);
  await sleep(1500);
  early.ws.close();
  await sleep(1500);
  const a = await open('p1', called.roomCode);
  const b = await open('p2', called.roomCode);
  const waitFor = async (s: Seat, t: string, ms: number): Promise<any> => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const got = s.got.get(t);
      if (got?.length) return got[got.length - 1];
      await sleep(200);
    }
    return null;
  };
  const strat = await waitFor(a, 'strategyStart', 15_000);
  check('e2e: the strategy window opens, and says which competition and match', strat?.competition?.slug === slug && strat?.competition?.label === 'Q1', JSON.stringify(strat));
  const ms = await waitFor(a, 'matchStart', 30_000);
  check('e2e: everyone ready starts the match', !!ms, ms ? `robots ${ms.setups?.length}` : 'no matchStart');
  await sleep(4000);
  d = (await api('GET', `/api/competitions/${slug}`, null)).body;
  const liveRow = d.matches.find((m: { id: number }) => m.id === q1.id);
  check('e2e: while it plays, the page shows Q1 live', !!liveRow?.live, JSON.stringify(liveRow?.live));
  const live = (await api('GET', '/api/live', null)).body;
  check('e2e: Watch Live lists it, labelled with the competition', (live.rooms ?? []).some((r: { competition?: { label: string } }) => r.competition?.label === 'Q1'), JSON.stringify(live.rooms?.map((r: { room: string }) => r.room)));
  console.log('… waiting for the match to play out on the server (about 2:45)');
  const result = await waitFor(a, 'matchResult', 240_000);
  check('e2e: the match finishes', !!result, result ? JSON.stringify(result.result?.score) : 'no matchResult');
  let doneRow: { status?: string; result?: { source?: string }; replayId?: string } | undefined;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    d = (await api('GET', `/api/competitions/${slug}`, null)).body;
    doneRow = d.matches.find((m: { id: number }) => m.id === q1.id);
    if (doneRow?.status === 'done') break;
  }
  check('e2e: Q1 is done on the competition, as a played result', doneRow?.status === 'done' && doneRow?.result?.source === 'played', JSON.stringify(doneRow?.result));
  check('e2e: ...with the replay archived', !!doneRow?.replayId, String(doneRow?.replayId));
  if (doneRow?.replayId) {
    const rep = await api('GET', `/api/replay/${doneRow.replayId}`, null);
    check('e2e: a stranger can watch a competition replay', rep.status === 200, String(rep.status));
  }
  check('e2e: rankings exist after the first result', Array.isArray(d.rankings) && d.rankings.length === 2, JSON.stringify(d.rankings?.map((r: { rank: number; rp: number }) => [r.rank, r.rp])));
  // what the room measured rides in with the result (0060): every DECODE measure, per alliance,
  // as a whole number. The values are whatever two idle robots scored; the shape is the point.
  const measured = (await db.query<{ facts: Record<string, Record<string, unknown>> | null }>(
    `select facts from competition_matches where id = $1`,
    [q1.id],
  )).rows[0]?.facts;
  const DECODE_KEYS = ['artifacts', 'auto', 'base', 'movement', 'pattern', 'patternAward'];
  const shaped = (s: Record<string, unknown> | undefined): boolean =>
    !!s && Object.keys(s).sort().join() === DECODE_KEYS.join() && Object.values(s).every((v) => typeof v === 'number' && Number.isInteger(v) && v >= 0);
  check('e2e: the played match’s row holds what the game measured, per alliance, in DECODE’s keys',
    !!measured && Object.keys(measured).sort().join() === 'blue,red' && shaped(measured.red) && shaped(measured.blue), JSON.stringify(measured));
  const rpRow = d.matches.find((m: { id: number }) => m.id === q1.id);
  check('e2e: ...and the page ranks by the manual: Q1’s RP are read from it, and MOVEMENT is out of a 1v1’s reach',
    d.ranking?.scheme === 'cm' && JSON.stringify(d.unreachable) === '["movement"]' &&
      typeof rpRow?.rp?.alliance?.red?.total === 'number' && typeof rpRow?.rp?.alliance?.blue?.total === 'number',
    JSON.stringify({ scheme: d.ranking?.scheme, unreachable: d.unreachable, rp: rpRow?.rp }));
  a.ws.close();
  b.ws.close();
  await sleep(1000);

  // ---- 3. Q2: only one player comes
  const q2 = d.matches.find((m: { id: number }) => m.id !== q1.id);
  const call2 = await c('match', 'admin', { action: 'call', match: q2.id });
  check('e2e: Q2 is called', call2.status === 200 && call2.body.called === true, JSON.stringify(call2.body));
  d = (await api('GET', `/api/competitions/${slug}`, 'p1')).body;
  const code2 = d.matches.find((m: { id: number }) => m.id === q2.id)?.roomCode;
  const lone = await open('p1', code2);
  console.log('… waiting out the 60 s grace for the driver who never comes');
  const err = await waitFor(lone, 'error', 90_000);
  check('e2e: the lone driver is told the match did not start', !!err && /didn’t start/.test(err.message ?? ''), JSON.stringify(err));
  let back: { status?: string; callNote?: string } | undefined;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    d = (await api('GET', `/api/competitions/${slug}`, 'admin')).body;
    back = d.matches.find((m: { id: number }) => m.id === q2.id);
    if (back?.status === 'scheduled') break;
  }
  check('e2e: Q2 is back on the schedule with a note for the referee', back?.status === 'scheduled' && /did not connect/.test(back?.callNote ?? ''), JSON.stringify(back));
  const standing = await db.query<{ n: number }>(`select count(*)::int as n from standing_events`);
  check('e2e: nobody’s standing was charged for it', standing.rows[0].n === 0, String(standing.rows[0].n));
  lone.ws.close();

  // ---- 4. a referee forfeit, then finish
  const ff = await c('match', 'admin', { action: 'forfeit', match: q2.id, winner: 'blue' });
  check('e2e: a referee forfeits Q2', ff.status === 200, JSON.stringify(ff.body));
  const fin = await c('status', 'admin', { to: 'selection' });
  check('e2e: ending qualifications without playoffs completes it', fin.status === 200, JSON.stringify(fin.body));
  d = (await api('GET', `/api/competitions/${slug}`, null)).body;
  check('e2e: completed, with placements', d.competition.status === 'completed' && d.entries.every((e: { placement: number | null }) => e.placement !== null), JSON.stringify(d.entries.map((e: { name: string; placement: number }) => [e.name, e.placement])));

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
