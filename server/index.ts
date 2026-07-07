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

// an explicit HTTP server so we can answer GET /health (Fly/Load-balancer probe)
// while the WebSocket upgrade rides the same port
const httpServer = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
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
const wss = new WebSocketServer({ server: httpServer });

// resilience: a game server must never let one stray error kill every room. Log
// loudly and keep listening (the ws / room handlers already catch closer in).
wss.on('error', (e) => console.error('[server] websocket server error:', e));
httpServer.on('error', (e) => console.error('[server] http server error:', e));
process.on('uncaughtException', (e) => console.error('[server] uncaughtException:', e));
process.on('unhandledRejection', (e) => console.error('[server] unhandledRejection:', e));

wss.on('connection', (ws: WebSocket) => {
  let id: string = randomUUID(); // reassigned to the reclaimed clientId on a rejoin
  let room: Room | null = null;
  const send = (m: ServerMsg): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(encodeMsg(m));
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
