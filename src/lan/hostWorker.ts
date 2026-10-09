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
import { coerceCaps, decodeClientMsg, encodeMsg, type ClientMsg, type ServerMsg } from '../net/protocol';
import { importAdmission, importIdOf, isImportedSpec } from '../net/imported';
import { sanitizePlayer } from '../net/sanitize';
import { initPhysics } from '../sim/physicsEngine';
import { initPhysics3d } from '../games/biobuzz/sim3d/engine';
import { coerceGameId, serverPhysics, type GameId } from '../games/types';
import { simModuleFor } from '../games/sim';
import { HEALTH_INTERVAL_MS, HOST_SEAT, type HostIn, type HostOut } from './hostProtocol';

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

/** one guest's seat at the room, addressed by its signalling peer id. `game` is the ROOM's, so the
 *  spec is clamped against the same envelope the room builds the robot under. */
function seat(id: string, player: HostIn & { k: 'add' }, game: GameId): Client {
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
    /* ⚠️ SANITISED, LIKE THE CLOUD'S `joinRoom` (`server/index.ts`). This used to spread the guest's
       `join` player straight onto the roster: the comment in `hostRuntime.fromSeat` says "the room
       sanitizes whatever it is given", and `Room.add` does not. Only an `update` patch and the
       spawn (`coerceSetup`) ever clamped it, so until the match started every peer in a tab-hosted
       room saw a guest's raw wire spec, of any size a DataChannel will carry — and an imported
       robot is exactly the field that must not be taken on a guest's say-so. */
    player: { ...sanitizePlayer(player.player, game), clientId: id },
    /* ⚠️ THE LANE THIS SEAT'S SNAPSHOTS TAKE CAN DROP THEM. `isHot` above puts every snapshot
       on the guest's unordered `maxRetransmits: 0` channel, which is the right trade for a
       frame the next one supersedes — but it means the room may NOT assume a snapshot it sent
       was received, and the room's default delta is cut against exactly that assumption. A
       guest that loses one frame would otherwise apply the next on top of a baseline that is
       wrong about whatever moved in the lost one, ack it as fine, and keep that error until
       the match ended. Telling the room makes it key this seat's deltas to the ack instead;
       see `broadcastSnapshot`. A cloud WebSocket sets nothing here and is unaffected. */
    lossy: true,
    connected: true,
    disconnectAt: 0,
    caps: coerceCaps(player.caps),
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
    /* ⚠️ THE `catch` IS NOT DEFENSIVE PADDING. This is the only asynchronous step in the
       Worker's whole life and it loads a wasm module, so it is also the only one that can
       fail — and without a handler it fails as an unhandled rejection, which the page cannot
       see at all: `ready` simply never arrives, `room` stays null, and every frame after that
       hits the `if (!room) return` below. The host still gets a room code (the rendezvous
       claim succeeded) and every guest that connects then waits on a `welcome` nothing will
       ever send. Measured once, diagnosed slowly; it must never be silent again. */
    /* THE 3D PHYSICS IS FETCHED ONLY FOR A 3D ROOM. A tab-hosted room is the one place `Room`
       runs inside a browser and the host is on a laptop at a venue, so a 2D room must never
       pull the ~1.1 MB rapier3d chunk across the venue's Wi-Fi.

       The laziness lives INSIDE `initPhysics3d`, which reaches the package through a dynamic
       `import()`; this branch is simply the only thing in the worker that ever calls it. That
       matters more than it looks: `engine.ts` is already in this worker's module graph
       (`Room` → `simModuleFor` → the BIOBUZZ module → `step.ts` → `step3d` → `engineFor`),
       but `initPhysics3d` itself was TREE-SHAKEN out of it, because nothing on that path
       referenced the one function that contains the `import()`. Naming it here is what puts
       the physics chunk on the worker's map at all — and it is why `worker.format` had to
       become `'es'` (see vite.config.ts): an IIFE worker bundle cannot be code-split, so the
       first dynamic import inside a worker fails the build outright.

       Awaited BESIDE the 2D module rather than after it, inside one promise, because `room`
       must not exist until BOTH are in hand: the host reads the code out and guests start
       arriving the moment `ready` is posted, and a room that can be joined but not stepped is
       the failure this whole `then` was written around. */
    /* ⚠️ ASK THE SAME QUESTION `Room` ASKS, not the config. A LAN room is an ordinary `Room`
       and its physics is decided by the GAME (`serverPhysics`) since the 2026-09-18 ruling —
       a BIOBUZZ room hosted here is 3D whatever the page put in the config. Reading
       `config.physics` meant this branch skipped the chunk for exactly the room that needs it,
       and the first `step3d` then threw inside the worker, which is the silent-`ready` failure
       the comment above is about. */
    const needs3d = serverPhysics(simModuleFor(coerceGameId(m.config?.game))) === '3d';
    void Promise.all([initPhysics(), needs3d ? initPhysics3d() : null]).then(
      () => {
        /* No persistence callbacks — see the header. The room empties itself when the last
           member leaves, and the page decides whether that ends the session. */
        room = new Room(m.code, () => post({ k: 'empty' }), m.config);
        /* The host joins LAST — they are still on the LAN screen reading the code out while
           guests arrive — so the seat is claimed now or a guest gets it. See `reserveHost`. */
        room.reserveHost(HOST_SEAT);
        post({ k: 'ready' });
      },
      (e: unknown) => post({ k: 'failed', reason: e instanceof Error ? e.message : String(e) }),
    );
    return;
  }

  if (!room) return;

  if (m.k === 'add') {
    /* CAPACITY IS ENFORCED HERE, BECAUSE SIGNALLING DOES NOT ENFORCE IT.
       The rendezvous will introduce far more guests than a room has seats for (it knows
       nothing about `roomCapacity`), and this used to seat every one of them: a fifth driver
       joined a 2v2, `matchStart` went out with a roster the protocol has no slots for, and
       the replay upload afterwards refused the oversized match. `canSeat` is the room's own
       answer — capacity, mid-match, the strategy window, and the seat this room's host has
       reserved but not yet taken (they join last; see `reserveHost`). */
    if (!room.canSeat(m.id)) {
      post({ k: 'refused', id: m.id, message: 'Room is full or a match is already in progress.' });
      return;
    }
    /* THE SAME GAME, OR NOT SEATED — the cloud's rule (`joinRoom`, server/index.ts), with the
       cloud's sentence. The rendezvous introduces anyone holding the code; it knows nothing
       about games. Seating a joiner whose client is set to a different game than the room
       runs put a BIOBUZZ lobby in front of a DECODE room: the room judged every start pose
       by DECODE's rules, cleared `ready` each time it was pressed, and nothing said why. */
    if (m.config && coerceGameId(m.config.game) !== room.gameId) {
      post({ k: 'refused', id: m.id, message: 'That code is for a different game mode.' });
      return;
    }
    /* IMPORTED ROBOTS: the same admission rule the cloud's join door asks (`importAdmission`). A LAN
       room is a custom room, so it allows them; what can refuse is a build without the capability
       on either side of one. `Room.add` asks again, but a refusal HERE is the one that tells the
       link to close, as the two above do. */
    const refusal = importAdmission(room.importState(), {
      imported: isImportedSpec(m.player?.spec),
      caps: coerceCaps(m.caps),
      id: importIdOf(m.player?.spec),
    });
    if (refusal) {
      post({ k: 'refused', id: m.id, message: refusal });
      return;
    }
    room.add(seat(m.id, m, room.gameId));
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
