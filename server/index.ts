import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Room } from './room';
import { decodeClientMsg, encodeMsg, type ServerMsg } from '../src/net/protocol';

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

// an explicit HTTP server so we can answer GET /health (Fly/Load-balancer probe)
// while the WebSocket upgrade rides the same port
const httpServer = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(426, { 'content-type': 'text/plain' });
  res.end('WebSocket only');
});
const wss = new WebSocketServer({ server: httpServer });

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
    if (msg.t === 'join') {
      if (room) return; // already in a room on this connection
      const code = msg.room.toLowerCase();
      let r = rooms.get(code);
      if (!r) {
        r = new Room(code, () => rooms.delete(code));
        rooms.set(code, r);
      }
      if (!r.canJoin()) {
        send({ t: 'error', message: 'Room is full or a match is already in progress.' });
        return;
      }
      room = r;
      room.add({ id, send, player: { ...msg.player, clientId: id }, connected: true, disconnectAt: 0 });
    } else if (msg.t === 'rejoin') {
      if (room) return;
      const r = rooms.get(msg.room.toLowerCase());
      if (r && r.reattach(msg.clientId, send)) {
        id = msg.clientId; // adopt the reclaimed identity on this socket
        room = r;
      } else {
        send({ t: 'rejoined', ok: false });
      }
    } else if (room) {
      room.onMessage(id, msg);
    }
  });

  ws.on('close', () => {
    room?.detach(id); // lobby ⇒ leave; mid-match ⇒ hold the slot for a reconnect
  });

  ws.on('error', () => {
    /* a close event follows; teardown happens there */
  });
});

httpServer.listen(PORT, () => {
  console.log(`[server] DECODE game server listening on ws://localhost:${PORT}`);
});
