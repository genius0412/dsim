// THE PRIMARY ROUTER: a host whose only machines are in the game app's primary region, so a
// request sent to it never starts a satellite. It serves nothing itself. Every request and
// every WebSocket upgrade is answered with `fly-replay: app=<TARGET_APP>;region=<TARGET_REGION>`,
// and Fly's proxy hands it to the game app's primary machine.
//
// Why it exists: src/net/primaryHost.ts. Deploy: ./scripts/fly-deploy.sh --router [--alpha].
// Zero dependencies on purpose; the image is node:alpine plus this file.
import { createServer } from 'node:http';

const APP = process.env.TARGET_APP ?? '';
const REGION = process.env.TARGET_REGION ?? 'iad';
const PORT = Number(process.env.PORT ?? 8080);
// both reach a response header, so both are checked once at boot
if (!/^[a-z0-9-]+$/.test(APP) || !/^[a-z]{3}$/.test(REGION)) {
  console.error(`[router] bad TARGET_APP/TARGET_REGION: ${JSON.stringify({ APP, REGION })}`);
  process.exit(1);
}
const REPLAY = `app=${APP};region=${REGION}`;

const server = createServer((req, res) => {
  // the platform health check reaches this machine directly and never follows a replay
  if (req.url === '/_router/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(204, { 'fly-replay': REPLAY });
  res.end();
});

// a socket is replayed the same way; the game app accepts the upgrade, not this process
server.on('upgrade', (_req, socket) => {
  socket.end(`HTTP/1.1 204 No Content\r\nfly-replay: ${REPLAY}\r\nconnection: close\r\n\r\n`);
});

server.listen(PORT, '0.0.0.0', () => console.log(`[router] :${PORT} → ${REPLAY}`));
