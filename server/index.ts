import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Room, type Client } from './room';
import { decodeClientMsg, encodeMsg, type ServerMsg } from '../src/net/protocol';
import { verifyAuthToken } from './auth';
import { initPhysics } from '../src/sim/physicsEngine';
import { migrate } from './db/migrate';
import { persistMatch } from './persist';
import { handleApi } from './api';
import { Matchmaker } from './matchmaking';

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
const httpServer = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
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
        online: onlineCount,
        signedIn: authedUsers.size,
        queues: matchmaker.queueSizes(),
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
const wss = new WebSocketServer({ server: httpServer, perMessageDeflate: false });

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
        const code = msg.room.toLowerCase();
        let r = rooms.get(code);
        if (!r) {
          // the CREATOR's join sets the room kind (versus vs. record); later
          // joiners inherit it. Absent ⇒ the default PvP room. `persistOutcome`
          // writes the verified score + replay to Neon at match end (no-op when
          // the DB is unconfigured).
          r = new Room(code, () => rooms.delete(code), msg.config, persistMatch);
          rooms.set(code, r);
        }
        if (!r.canJoin()) {
          send({ t: 'error', message: 'Room is full or a match is already in progress.' });
          return;
        }
        room = r;
        const client: Client = {
          id,
          send,
          player: { ...msg.player, clientId: id },
          connected: true,
          disconnectAt: 0,
        };
        room.add(client);
        // verify the Neon Auth JWT out-of-band; on success attribute the slot to
        // the real user (well before match start). Invalid/absent ⇒ anonymous.
        if (msg.authToken) {
          verifyAuthToken(msg.authToken)
            .then((u) => {
              if (u) {
                client.userId = u.userId;
                client.player.name = u.handle;
                markAuthed(u.userId);
              }
            })
            .catch(() => {});
        }
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
            player: { ...msg.player, name: u.handle ?? msg.player.name },
            userId: u.userId,
            mode: msg.mode,
            onRoom: (r) => {
              room = r;
            },
          });
        });
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
