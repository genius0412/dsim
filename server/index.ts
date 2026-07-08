import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Room, type Client } from './room';
import { decodeClientMsg, encodeMsg, type ClientMsg, type ServerMsg } from '../src/net/protocol';
import { sanitizePlayer } from '../src/net/sanitize';
import { verifyAuthToken } from './auth';
import { initPhysics } from '../src/sim/physicsEngine';
import { migrate } from './db/migrate';
import { persistMatch } from './persist';
import { handleApi } from './api';
import { Matchmaker } from './matchmaking';
import { MATCHMAKER_REGION } from './regions';
import { BALANCE_VERSION } from '../src/config';
import { dbEnabled } from './db/pool';
import {
  currentSeasonNumber,
  purgeSeasonReplays,
  startNewSeason,
  takePendingMatch,
  cleanupStalePending,
  adminListRecords,
  deleteRecordById,
  deleteUserRecords,
  searchProfiles,
  setHandle,
  getProfile,
} from './db/repo';

/**
 * Authoritative DECODE game server (Phase 0). One WebSocket per client; rooms are
 * keyed by lowercased room code. The server imports the SHARED src/sim and runs
 * the match loop inside each Room (see room.ts). Lobby + match live on the same
 * connection, so there is no separate signaling service.
 *
 * Run: `npm run server` (tsx watch) or `npm run server:start`. Configure the
 * client with VITE_GAME_SERVER_URL=ws://localhost:8787. Deploy: see docs/deploy.md
 * (Fly.io). A plain GET /health returns 200 for the platform health check.
 */

const PORT = Number(process.env.PORT ?? 8787);
const rooms = new Map<string, Room>();
const matchmaker = new Matchmaker();

// live presence, surfaced at GET /api/presence (polled by the client so the
// homepage/ranked screens can show who's around WITHOUT anyone holding a standing
// socket — a persistent presence connection from every visitor would keep the
// auto-stopping Fly machine awake 24/7 and defeat the idle-to-zero cost model).
// `online` = open sockets (people actually engaged with multiplayer; solo/free
// players never connect). `signedIn` = DISTINCT authenticated users (deduped by
// userId, so multiple tabs count once).
let onlineCount = 0;
const authedUsers = new Map<string, number>(); // userId -> live socket count

// accounts allowed to use the admin API (their auth-JWT `sub`/userId). Set as a
// Fly secret: ADMIN_USER_IDS="uuid1,uuid2". Empty => admin API is locked to nobody.
const ADMIN_IDS = new Set(
  (process.env.ADMIN_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

// a pending admin notice (scheduled restart / info) broadcast to every client and
// re-sent to anyone who connects while it's still live, so late joiners see it too
let currentNotice: (ServerMsg & { t: 'serverNotice' }) | null = null;
const noticeLive = (): boolean =>
  !!currentNotice && (currentNotice.until === undefined || currentNotice.until > Date.now());

/** broadcast a message to EVERY open socket; returns how many got it */
function broadcastAll(m: ServerMsg): number {
  const payload = encodeMsg(m);
  let n = 0;
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
      n++;
    }
  }
  return n;
}

// an explicit HTTP server so we can answer GET /health (Fly/Load-balancer probe)
// while the WebSocket upgrade rides the same port
const REGION = process.env.FLY_REGION ?? process.env.SERVER_REGION ?? '';
const httpServer = createServer((req, res) => {
  if (req.method === 'GET' && req.url?.startsWith('/health')) {
    // `?region=<code>` lets the client ping a SPECIFIC region (the picker) or read
    // its home region: on Fly we fly-replay the GET to that region's machine, which
    // answers with its own x-region. Locally (REGION='') we just answer here.
    const want = new URL(req.url, 'http://x').searchParams.get('region');
    const already = !!req.headers['fly-replay-src'];
    if (REGION && want && want !== REGION && !already) {
      res.writeHead(200, {
        'fly-replay': `region=${want}`,
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      });
      res.end();
      return;
    }
    // CORS so the web client (different origin) can time this for the pre-connect
    // ping picker. Includes the region so a client can confirm which one answered.
    res.writeHead(200, {
      'content-type': 'text/plain',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
      ...(REGION ? { 'x-region': REGION } : {}),
    });
    res.end('ok');
    return;
  }
  // ADMIN API — gated by ADMIN_USER_IDS (your account's UUID, via the signed-in
  // JWT); the ADMIN_SECRET query still works for curl. CORS'd for the web app.
  //   GET  /api/admin/status                          -> { isAdmin, userId }
  //   POST /api/admin/announce?seconds=300&msg=…       schedule a restart notice
  //   POST /api/admin/announce?cancel=1                clear a pending notice
  if (req.url?.startsWith('/api/admin/')) {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const u = new URL(req.url, 'http://x');
    void (async () => {
      const auth = req.headers['authorization'];
      const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
      const user = await verifyAuthToken(token);
      const isAdmin = !!user && ADMIN_IDS.has(user.userId);

      if (req.method === 'GET' && u.pathname === '/api/admin/status') {
        res.writeHead(200, { ...cors, 'content-type': 'application/json' });
        res.end(JSON.stringify({ isAdmin, userId: user?.userId ?? null }));
        return;
      }
      if (req.method === 'POST' && u.pathname === '/api/admin/announce') {
        const secretOk =
          !!process.env.ADMIN_SECRET && u.searchParams.get('secret') === process.env.ADMIN_SECRET;
        if (!isAdmin && !secretOk) {
          res.writeHead(403, cors);
          res.end('forbidden');
          return;
        }
        if (u.searchParams.get('cancel')) {
          currentNotice = { t: 'serverNotice', kind: 'info', message: '' }; // empty => clear on client
          const n = broadcastAll(currentNotice);
          currentNotice = null;
          res.writeHead(200, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, cancelled: true, notified: n }));
          return;
        }
        const seconds = Math.max(0, Number(u.searchParams.get('seconds') ?? 300));
        const message = u.searchParams.get('msg') || 'Server restarting for an update';
        currentNotice = { t: 'serverNotice', kind: 'restart', message, until: Date.now() + seconds * 1000 };
        const notified = broadcastAll(currentNotice);
        console.log(`[admin] restart notice in ${seconds}s -> ${notified} clients: "${message}"`);
        res.writeHead(200, { ...cors, 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, notified, until: currentNotice.until }));
        return;
      }
      // SEASONS: archive the live boards and open a fresh season, or purge the
      // replays of an archived season (frees storage; boards stay, watchability
      // drops). Both are admin-gated (JWT admin id OR the ADMIN_SECRET query).
      if (
        req.method === 'POST' &&
        (u.pathname === '/api/admin/season/start' || u.pathname === '/api/admin/season/purge-replays')
      ) {
        const secretOk =
          !!process.env.ADMIN_SECRET && u.searchParams.get('secret') === process.env.ADMIN_SECRET;
        if (!isAdmin && !secretOk) {
          res.writeHead(403, cors);
          res.end('forbidden');
          return;
        }
        if (!dbEnabled) {
          res.writeHead(503, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'DB disabled' }));
          return;
        }
        if (u.pathname === '/api/admin/season/start') {
          const name = u.searchParams.get('name') ?? undefined;
          const season = await startNewSeason(BALANCE_VERSION, name);
          console.log(`[admin] started new season ${season}${name ? ` "${name}"` : ''}`);
          res.writeHead(200, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, season }));
          return;
        }
        // purge-replays: default to every season BEFORE the live one when unspecified
        const seasonArg = u.searchParams.get('season');
        const current = await currentSeasonNumber(BALANCE_VERSION);
        let freed = 0;
        if (seasonArg !== null) {
          const s = Number(seasonArg);
          if (s >= current) {
            res.writeHead(400, { ...cors, 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'refusing to purge the live season' }));
            return;
          }
          freed = await purgeSeasonReplays(s);
        } else {
          for (let s = 1; s < current; s++) freed += await purgeSeasonReplays(s);
        }
        console.log(`[admin] purged ${freed} archived-season replays`);
        res.writeHead(200, { ...cors, 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, freed }));
        return;
      }

      // MODERATION — inspect/delete leaderboard records + rename inappropriate
      // display names. Same admin gate as above (JWT admin id OR ADMIN_SECRET);
      // every action is re-authorized here on the server, never trusting the UI.
      if (
        u.pathname === '/api/admin/records' ||
        u.pathname === '/api/admin/record/delete' ||
        u.pathname === '/api/admin/user/records/clear' ||
        u.pathname === '/api/admin/users' ||
        u.pathname === '/api/admin/user/rename'
      ) {
        const secretOk =
          !!process.env.ADMIN_SECRET && u.searchParams.get('secret') === process.env.ADMIN_SECRET;
        if (!isAdmin && !secretOk) {
          res.writeHead(403, cors);
          res.end('forbidden');
          return;
        }
        if (!dbEnabled) {
          res.writeHead(503, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'DB disabled' }));
          return;
        }
        const jsonOut = (code: number, body: unknown): void => {
          res.writeHead(code, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };

        // GET /api/admin/records?mode=&drivetrain=&limit= — moderation board view
        if (req.method === 'GET' && u.pathname === '/api/admin/records') {
          const mode = u.searchParams.get('mode') === 'duo' ? 'duo' : 'solo';
          const drivetrain = u.searchParams.get('drivetrain') ?? 'overall';
          const limit = Math.min(500, Math.max(1, Number(u.searchParams.get('limit') ?? 100)));
          const season = await currentSeasonNumber(BALANCE_VERSION);
          const rows = await adminListRecords({ mode, drivetrain, balanceVersion: season, limit });
          jsonOut(200, { season, mode, drivetrain, rows });
          return;
        }
        // POST /api/admin/record/delete?id= — remove one run (+ its replay)
        if (req.method === 'POST' && u.pathname === '/api/admin/record/delete') {
          const id = u.searchParams.get('id') ?? '';
          if (!id) {
            jsonOut(400, { ok: false, error: 'missing id' });
            return;
          }
          const deleted = await deleteRecordById(id);
          console.log(`[admin] delete record ${id} -> ${deleted}`);
          jsonOut(deleted ? 200 : 404, { ok: deleted });
          return;
        }
        // POST /api/admin/user/records/clear?userId= — nuke a cheater's runs
        if (req.method === 'POST' && u.pathname === '/api/admin/user/records/clear') {
          const uid = u.searchParams.get('userId') ?? '';
          if (!uid) {
            jsonOut(400, { ok: false, error: 'missing userId' });
            return;
          }
          const removed = await deleteUserRecords(uid);
          console.log(`[admin] cleared ${removed} records for user ${uid}`);
          jsonOut(200, { ok: true, removed });
          return;
        }
        // GET /api/admin/users?q= — find profiles to rename/moderate
        if (req.method === 'GET' && u.pathname === '/api/admin/users') {
          const query = (u.searchParams.get('q') ?? '').trim();
          const users = query ? await searchProfiles(query) : [];
          jsonOut(200, { users });
          return;
        }
        // POST /api/admin/user/rename?userId=&handle= — force a clean display name
        if (req.method === 'POST' && u.pathname === '/api/admin/user/rename') {
          const uid = u.searchParams.get('userId') ?? '';
          const handle = (u.searchParams.get('handle') ?? '').trim();
          if (!uid) {
            jsonOut(400, { ok: false, error: 'missing userId' });
            return;
          }
          if (handle.length < 2 || handle.length > 24) {
            jsonOut(400, { ok: false, error: 'name must be 2–24 characters' });
            return;
          }
          const profile = await getProfile(uid);
          if (!profile) {
            jsonOut(404, { ok: false, error: 'no such user' });
            return;
          }
          await setHandle(uid, handle);
          console.log(`[admin] renamed ${uid}: "${profile.handle}" -> "${handle}"`);
          jsonOut(200, { ok: true, userId: uid, handle });
          return;
        }
        jsonOut(404, { ok: false, error: 'unknown admin route' });
        return;
      }
      res.writeHead(404, cors);
      res.end();
    })().catch((e) => {
      console.error('[admin] handler error:', e);
      if (!res.headersSent) res.writeHead(500, cors);
      res.end();
    });
    return;
  }
  // live presence (served here, not in api.ts, because the counts live on this
  // process: the socket registry + the in-memory matchmaker queues)
  if (req.method === 'GET' && req.url === '/api/presence') {
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    res.end(
      JSON.stringify({
        region: REGION,
        online: onlineCount,
        signedIn: authedUsers.size,
        queues: matchmaker.queueSizes(),
        // include any LIVE admin notice so the client can show the restart banner
        // (and block starting new games) on EVERY page — even disconnected ones
        // like Home/solo where no WebSocket delivers `serverNotice`.
        notice:
          noticeLive() && currentNotice
            ? { kind: currentNotice.kind, message: currentNotice.message, until: currentNotice.until }
            : null,
      }),
    );
    return;
  }
  // public leaderboard / replay read API (GET /api/*)
  if (req.url?.startsWith('/api/')) {
    handleApi(req, res).catch((e) => {
      console.error('[api] handler crash:', e);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    return;
  }
  res.writeHead(426, { 'content-type': 'text/plain' });
  res.end('WebSocket only');
});
// LOW-LATENCY SOCKETS. Disable Nagle's algorithm on every connection: the room
// loop streams a ~20 Hz burst of SMALL delta frames, and Nagle batches small
// writes (waiting on the peer's ACK) — which, against TCP delayed-ACK, injects
// 40–200 ms stalls. That is exactly the symptom seen here: a healthy p50 (~40 ms)
// but a p95/p99 tail of 400–570 ms (periodic spikes / rubberbanding), and the
// classic Fly.io 60 Hz-game report. Nagle is PER-SOCKET (no OS/Dockerfile toggle
// works), so we set TCP_NODELAY on each socket in-process. Covers WS upgrades and
// the small HTTP (health/API) responses too.
httpServer.on('connection', (socket) => socket.setNoDelay(true));

// perMessageDeflate off: compression buffers/among-frames context adds latency +
// memory for our tiny JSON frames and buys little on already-delta'd snapshots.
// noServer: we intercept the upgrade ourselves (below) to do region routing.
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

// ---- region routing (fly-replay) --------------------------------------------
// One Fly app, one machine per region. A WebSocket upgrade carries a routing hint
// in its query string; if it belongs to a DIFFERENT region we answer the upgrade
// with a `fly-replay` header instead of accepting it, and Fly's proxy replays the
// whole upgrade to the target region's machine (which then holds the connection).
// Hints:  ?mm=1 → the designated matchmaker region;  ?room=<region>-<code> → that
// room's host region;  ?region=<code> → an explicit pick.
// Only active on Fly (FLY_REGION set); locally REGION='' so we always accept here.
function routeTarget(url: URL): string | null {
  if (url.searchParams.get('mm') === '1') return MATCHMAKER_REGION;
  const region = url.searchParams.get('region');
  if (region) return region;
  const room = url.searchParams.get('room');
  if (room) {
    const dash = room.indexOf('-');
    if (dash > 0) return room.slice(0, dash); // region-coded `<region>-<code>`
  }
  return null;
}

httpServer.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    const target = routeTarget(url);
    // `fly-replay-src` is set by Fly after it has already replayed once — never
    // replay again (loop guard); accept locally as a graceful fallback.
    const alreadyReplayed = !!req.headers['fly-replay-src'];
    if (REGION && target && target !== REGION && !alreadyReplayed) {
      socket.write(
        'HTTP/1.1 200 OK\r\n' +
          `fly-replay: region=${target}\r\n` +
          'content-length: 0\r\n' +
          'connection: close\r\n\r\n',
      );
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } catch {
    socket.destroy();
  }
});

// resilience: a game server must never let one stray error kill every room. Log
// loudly and keep listening (the ws / room handlers already catch closer in).
wss.on('error', (e) => console.error('[server] websocket server error:', e));
httpServer.on('error', (e) => console.error('[server] http server error:', e));
process.on('uncaughtException', (e) => console.error('[server] uncaughtException:', e));
process.on('unhandledRejection', (e) => console.error('[server] unhandledRejection:', e));

wss.on('connection', (ws: WebSocket) => {
  let id: string = randomUUID(); // reassigned to the reclaimed clientId on a rejoin
  let room: Room | null = null;
  onlineCount++;
  // the authed user this socket belongs to (set once its JWT verifies), so the
  // signed-in tally can be decremented cleanly on close
  let authedUserId: string | null = null;
  const markAuthed = (userId: string): void => {
    if (authedUserId) return; // count each connection's user exactly once
    authedUserId = userId;
    authedUsers.set(userId, (authedUsers.get(userId) ?? 0) + 1);
  };
  const send = (m: ServerMsg): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(encodeMsg(m));
  };
  // a late joiner during a pending restart still gets the countdown banner
  if (noticeLive() && currentNotice) send(currentNotice);

  // Join (or create) a room. Async because a region-coded code may name a ranked
  // match the designated matchmaker STAGED in Postgres: the first joiner claims it
  // (atomic delete-returning) and makes the room authoritative from that roster, and
  // we verify identity BEFORE adding so a ranked room can map each driver to a roster
  // slot by user id. The registry slot is claimed synchronously (before any await) so
  // a racing second joiner finds the same room instead of creating a duplicate.
  const joinRoom = async (msg: Extract<ClientMsg, { t: 'join' }>): Promise<void> => {
    const code = msg.room.toLowerCase();
    let r = rooms.get(code);
    let created = false;
    if (!r) {
      r = new Room(code, () => rooms.delete(code), msg.config, persistMatch);
      rooms.set(code, r);
      created = true;
    }
    if (created && dbEnabled) {
      const pending = await takePendingMatch(code).catch(() => null);
      if (pending) r.applyPending(pending);
    }
    let user: Awaited<ReturnType<typeof verifyAuthToken>> = null;
    if (msg.authToken) user = await verifyAuthToken(msg.authToken).catch(() => null);
    if (room) return; // a concurrent frame already placed this socket
    if (!r.canJoin()) {
      send({ t: 'error', message: 'Room is full or a match is already in progress.' });
      return;
    }
    room = r;
    const client: Client = {
      id,
      send,
      // NEVER trust the wire spec: sanitize the whole player to legal ranges
      // before it lands on the roster (a spoofed devtools spec is clamped here)
      player: { ...sanitizePlayer(msg.player), clientId: id },
      connected: true,
      disconnectAt: 0,
    };
    if (user) {
      client.userId = user.userId;
      client.player.name = user.handle;
      markAuthed(user.userId);
    }
    room.add(client);
    room.maybeStartRanked(); // no-op unless a staged ranked room is now fully present
  };

  ws.on('message', (data: unknown) => {
    let msg;
    try {
      msg = decodeClientMsg(String(data));
    } catch {
      return; // ignore malformed frames
    }
    // never let a bad message take down the process (and every other room)
    try {
      if (msg.t === 'ping') {
        // latency probe — echo the client's timestamp straight back so it can
        // measure RTT for the connection-quality HUD (answered in lobby OR match)
        send({ t: 'pong', ts: msg.ts });
        return;
      }
      if (msg.t === 'join') {
        if (room) return; // already in a room on this connection
        void joinRoom(msg).catch((e) => console.error(`[server] join error from ${id}:`, e));
      } else if (msg.t === 'rejoin') {
        if (room) return;
        const r = rooms.get(msg.room.toLowerCase());
        if (r && r.reattach(msg.clientId, send)) {
          id = msg.clientId; // adopt the reclaimed identity on this socket
          room = r;
        } else {
          send({ t: 'rejoined', ok: false });
        }
      } else if (msg.t === 'queue') {
        if (room) return; // already in a room/match
        // ranked REQUIRES a verified account (ELO/leaderboard only make sense with
        // an identity). Anonymous players can still use custom rooms, just not
        // ranked. Verify the JWT, then enqueue; on a match the matchmaker sets our
        // `room` so subsequent input routes there.
        verifyAuthToken(msg.authToken).then((u) => {
          if (!u) {
            send({ t: 'error', message: 'Sign in to play ranked.' });
            return;
          }
          markAuthed(u.userId);
          matchmaker.enqueue({
            id,
            send,
            // sanitize the ranked player's spec/assists too (same clamp as join)
            player: { ...sanitizePlayer(msg.player), name: u.handle ?? msg.player.name },
            userId: u.userId,
            mode: msg.mode,
            // the client's home region (Fly's x-region for its connection) + measured
            // access latency; the matchmaker estimates cross-region ping from these to
            // pick a fair host. Falls back to THIS instance's region if omitted.
            homeRegion: msg.homeRegion || REGION,
            accessMs: msg.accessMs ?? 0,
            noWiden: msg.noWiden ?? false,
            enqueuedAt: 0, // stamped by enqueue()
            expandBumps: 0,
            onRoom: (r) => {
              room = r; // dev/no-DB local fallback only
            },
          });
        });
      } else if (msg.t === 'expandSearch') {
        matchmaker.expand(id);
      } else if (msg.t === 'leaveQueue') {
        matchmaker.remove(id);
      } else if (room) {
        room.onMessage(id, msg);
      }
    } catch (e) {
      console.error(`[server] error handling ${msg.t} from ${id}:`, e);
    }
  });

  ws.on('close', () => {
    onlineCount--;
    if (authedUserId) {
      const n = (authedUsers.get(authedUserId) ?? 1) - 1;
      if (n <= 0) authedUsers.delete(authedUserId);
      else authedUsers.set(authedUserId, n);
    }
    matchmaker.remove(id); // drop from any ranked queue
    room?.detach(id); // lobby ⇒ leave; mid-match ⇒ hold the slot for a reconnect
  });

  ws.on('error', () => {
    /* a close event follows; teardown happens there */
  });
});

// bind 0.0.0.0 explicitly — Fly (and most platforms) route to the app there, NOT
// localhost/127.0.0.1 (a bind to localhost is unreachable ⇒ 502 / "not listening").
// LISTEN FIRST so GET /health answers within the platform's boot window, THEN load
// the Rapier WASM: loading it before listen() left nothing bound to the port during
// the (sub-second, but real on a shared CPU) WASM init, so Fly saw "app not listening
// on 8080" and flapped the machine. A match can't start until physicsReady() (guarded
// in room.ts), so serving /health ahead of physics is safe.
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] DECODE game server listening on 0.0.0.0:${PORT}`);
});
initPhysics()
  .then(() => console.log('[server] Rapier physics ready — matches enabled'))
  .catch((e) => {
    console.error('[server] failed to init physics:', e);
    process.exit(1);
  });

// apply DB migrations at boot (off the hot path; no-ops without DATABASE_URL). A
// DB failure must NOT take the game server down — records just won't persist.
migrate()
  .then(() => console.log('[server] database ready'))
  .catch((e) => console.error('[server] migration failed (records disabled):', e));

// reap staged ranked matches nobody claimed (both clients vanished after assign).
// Only meaningful on the matchmaker/host machines; harmless elsewhere.
if (dbEnabled) {
  const reaper = setInterval(() => {
    cleanupStalePending(60_000).catch((e) => console.error('[server] pending cleanup:', e));
  }, 60_000);
  reaper.unref();
}
