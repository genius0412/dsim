/**
 * THE AUTHORITATIVE ROOM, RUNNING IN A HOST'S TAB.
 *
 * This is the half of `docs/lan-webrtc.md` that makes a browser a server. It imports the SAME
 * `server/room.ts` the cloud runs — not a reimplementation, not a subset — which is why step 1
 * of that document was spent making that file bundle for a browser rather than writing a second
 * room and hoping the two stayed in step.
 *
 * ## Why a Worker and not the page
 *
 * `Room` drives itself with `setInterval` at 60 Hz, and a hidden page cannot hold that. MEASURED
 * side by side in one hidden tab for 7 minutes (`docs/lan-webrtc.md` §6): the PAGE thread ran at
 * 59 Hz for the first half-minute, fell to **1–2 Hz**, and past the five-minute mark dropped to
 * **one tick per minute** under Chrome's intensive throttling. The WORKER held **60.08 Hz for
 * the whole run**, worst 15-second window 50.4 Hz. So a host who switches tabs does not degrade
 * the match, they stop it — and would have no way of knowing, because from their side nothing
 * happened.
 *
 * ⚠️ **THE LOOP CANNOT MOVE BACK TO THE PAGE.** That is not a preference about thread hygiene
 * (though it is also that — it keeps 60 Hz off the thread rendering the host's own view); it is
 * the difference between hosting working and hosting not working.
 *
 * A Worker is throttled LESS, which is not the same as never, so this file MEASURES itself and
 * reports (`health`) rather than assuming. The page turns that into something the host can see.
 * ⚠️ And a short sample proves nothing here: a 5-second A/B run before this one had the page
 * thread AHEAD, because the whole window sat inside the un-throttled grace period.
 *
 * ## What this room is not allowed to do
 *
 * Nothing here persists. The `Room` constructor takes its database callbacks as optional
 * arguments and this passes NONE of them, which is the same shape every test uses — so a
 * tab-hosted match cannot write a leaderboard row, move ELO, or charge standing even by
 * accident. That is not a policy this file enforces; it is a thing it cannot reach. The match's
 * one durable output is the replay the PAGE uploads afterwards (`POST /api/lan`), under the
 * host's own account, exactly as the desktop-app LAN path already does.
 */
import { Room, type Client } from '../../server/room';
import { decodeClientMsg, encodeMsg, type ClientMsg, type ServerMsg } from '../net/protocol';
import { initPhysics } from '../sim/physicsEngine';
import { HEALTH_INTERVAL_MS, type HostIn, type HostOut } from './hostProtocol';

const post = (m: HostOut): void => {
  (self as unknown as { postMessage: (m: HostOut) => void }).postMessage(m);
};

/**
 * Which frames take the unreliable lane.
 *
 * The room hands out already-encoded strings, so the lane has to be decided from the encoded
 * form. Sniffing the discriminator off the front of the JSON is ugly but it is O(1) and it
 * avoids parsing a snapshot on the host's thread purely to learn what it already is.
 *
 * `snapshot` and `pong` are the hot path: the next one supersedes a lost one, so a retransmit
 * buys nothing. EVERYTHING ELSE IS CONTROL, by default and on purpose — an unknown frame is
 * treated as one that matters, because losing a `matchStart` is unrecoverable and losing a
 * snapshot is not.
 */
const HOT = /^\{"t":"(snapshot|pong)"/;
const isHot = (raw: string): boolean => HOT.test(raw);

let room: Room | null = null;
/** everyone currently attached, so a `close` can detach them deterministically */
const members = new Set<string>();

/** one guest's seat at the room, addressed by its signalling peer id */
function seat(id: string, player: HostIn & { k: 'add' }): Client {
  const sendRaw = (raw: string): void => post({ k: 'send', id, raw, reliable: !isHot(raw) });
  return {
    id,
    send: (m: ServerMsg) => sendRaw(encodeMsg(m)),
    sendRaw,
    /* A DataChannel's own `bufferedAmount` lives on the page, a thread away, so the room cannot
       read it synchronously the way it reads `ws.bufferedAmount`. Reporting zero means the room
       never coalesces snapshots for a slow peer — which is the pre-existing behaviour for every
       socket-less caller (tests, the headless smoke) and is defensible on a LAN, where the link
       is not the bottleneck. If a real backlog ever shows up on venue Wi-Fi, the fix is for the
       page to push `bufferedAmount` across on the health tick, not to block this thread. */
    player: { ...player.player, clientId: id },
    connected: true,
    disconnectAt: 0,
    caps: player.caps ?? [],
    channel: player.channel,
    userId: player.userId,
  };
}

/** 60 Hz is what the room asks its own loop for; `health` reports what it actually got. */
let ticks = 0;
const countTick = (): void => {
  ticks++;
};

self.addEventListener('message', (e: MessageEvent) => {
  const m = e.data as HostIn;

  if (m.k === 'open') {
    void initPhysics().then(() => {
      /* No persistence callbacks — see the header. The room empties itself when the last
         member leaves, and the page decides whether that ends the session. */
      room = new Room(m.code, () => post({ k: 'empty' }), m.config);
      post({ k: 'ready' });
    });
    return;
  }

  if (!room) return;

  if (m.k === 'add') {
    room.add(seat(m.id, m));
    members.add(m.id);
    return;
  }

  if (m.k === 'msg') {
    let msg: ClientMsg;
    try {
      msg = decodeClientMsg(m.raw);
    } catch {
      return; // a malformed frame from a peer is ignored, exactly as the server ignores one
    }
    countTick();
    room.onMessage(m.id, msg);
    return;
  }

  if (m.k === 'drop') {
    members.delete(m.id);
    room.detach(m.id);
    return;
  }

  if (m.k === 'close') {
    for (const id of members) room.detach(id);
    members.clear();
    room = null;
  }
});

/**
 * The self-measurement.
 *
 * `tickHz` is inbound frames per second, which on a live match tracks the loop: every driver
 * sends input at the tick rate, so a room that has stopped stepping is a room that has stopped
 * hearing from anyone. `behind` is how far the interval actually drifted from the wall clock —
 * the direct read on throttling, and the number that goes non-zero the moment a browser decides
 * this context is not worth scheduling.
 */
let lastHealth = Date.now();
let lastTicks = 0;
setInterval(() => {
  const now = Date.now();
  const dt = now - lastHealth;
  const drift = dt - HEALTH_INTERVAL_MS;
  post({
    k: 'health',
    tickHz: dt > 0 ? ((ticks - lastTicks) * 1000) / dt : 0,
    behind: Math.max(0, drift),
  });
  lastHealth = now;
  lastTicks = ticks;
}, HEALTH_INTERVAL_MS);
