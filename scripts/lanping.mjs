/**
 * Is the LAN rendezvous actually LIVE on a deployed server?
 *
 *   node scripts/lanping.mjs wss://dsim-alpha.fly.dev [wss://...]
 *
 * A green `fly deploy` says an image shipped. It does not say the feature you deployed FOR
 * is reachable, and the two came apart here on 2026-09-12: alpha was serving 200s on /health
 * from a build that predated the rendezvous entirely. /health cannot tell you - it answers
 * "ok" and nothing else - and there is no version route on the game server, so the only
 * honest check is to speak the protocol.
 *
 * Read-only. A code is CLAIMED on `lanHosting`, and a server with accounts will never answer
 * that to an anonymous socket, so this cannot leave anything registered. The four answers:
 *
 *   lanHosting        deployed, switched on, and this server allows anonymous hosts
 *                     (a LAN-tab server with no accounts - it cannot verify anybody)
 *   lanError auth     deployed and switched ON; a signed-in host would work. EXPECTED on alpha
 *   lanError closed   deployed, but LAN_SIGNALLING is off. EXPECTED on production - LAN ships
 *                     nowhere near it, and this is the gate holding that
 *   (silence)         the deployed build predates the rendezvous
 *
 * Exit code is 0 whenever every target ANSWERED, whatever it said - `closed` on production is
 * the correct answer, not a failure. Only silence and socket errors are non-zero.
 */
import WebSocket from 'ws';

const targets = process.argv.slice(2);
if (!targets.length) {
  console.error('usage: node scripts/lanping.mjs wss://host [wss://host ...]');
  process.exit(2);
}

const CODE = 'ZZTEST';
const TIMEOUT_MS = 12_000;

async function probe(url) {
  return new Promise((resolve) => {
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      resolve({ ok: false, text: `could not open: ${e.message}` });
      return;
    }
    const done = (ok, text) => {
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      resolve({ ok, text });
    };
    const timer = setTimeout(() => done(false, 'no answer in 12s — rendezvous not in this build'), TIMEOUT_MS);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'lanHost', code: CODE })));
    ws.on('message', (raw) => {
      let m;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      // Presence and hello chatter arrives first on a live server; wait for the answer to
      // the question actually asked.
      if (m.t !== 'lanError' && m.t !== 'lanHosting') return;
      clearTimeout(timer);
      done(
        true,
        m.t === 'lanHosting'
          ? 'lanHosting — deployed, ON, and anonymous hosting is allowed here'
          : `lanError ${m.reason} — ${m.message}`,
      );
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      done(false, `socket error: ${e.message}`);
    });
    ws.on('close', () => {
      clearTimeout(timer);
      resolve({ ok: false, text: 'closed without answering — rendezvous not in this build' });
    });
  });
}

let bad = 0;
for (const t of targets) {
  const { ok, text } = await probe(t);
  if (!ok) bad++;
  console.log(`${t}\n  ${ok ? '→' : '!!'} ${text}`);
}
process.exit(bad ? 1 : 0);
