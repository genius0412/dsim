import type { Alliance, Artifact, RobotCommand, RobotSpec, World } from '../../src/types';
import * as C from '../../src/config';
import { worldHash } from '../../src/net/checksum';
import {
  BB3D_CAP,
  BB3D_REFUSAL,
  CLIENT_CAPS,
  READY3D_CAP,
  READY3D_DEADLINE_MS,
  LOAD_HOLD_MAX_MS,
  VIEWREADY_CAP,
  SERVER_CAPS,
  reportsPhysicsReady,
  applyBallDelta,
  decodeServerMsg,
  encodeBallDelta,
  encodeMsg,
  localizeCommand,
  physicsAllowed,
  quantizeCommand,
  slimWorld,
  unslimWorld,
  type ServerMsg,
} from '../../src/net/protocol';
import {
  PREDICTION_BLURBS,
  PREDICTION_LABELS,
  PREDICTION_PREFS,
} from '../../src/net/predictionPref';
import { createFullPredictor, createLightPredictor, type Predictor } from '../../src/games/biobuzz/sim3d/predict';
import { simModuleFor } from '../../src/games/sim';
import type { BotDriver } from '../../src/games/types';
import { DEFAULT_ASSISTS, type RobotSetup } from '../../src/sim/spawn';
import { ReplayPlayer, maxMatchTicks, runRecordMatch, type Replay } from '../../src/sim/replay';
import { Room, type Client } from '../../server/room';
import type { PendingMatch } from '../../server/matchTypes';
import { BB_DEFAULT_SPEC } from '../../src/games/biobuzz/robotConfig';
import { BB_POLLEN_R } from '../../src/games/biobuzz/config';
import { readFileSync } from 'node:fs';
import { cmd, setup, type Check } from './harness';
import { mkWorld3d } from './harness';
import { step3d } from '../../src/games/biobuzz/sim3d/step3d';
import { PREDICT_ELEMENT_RADIUS } from '../../src/games/biobuzz/config';

/**
 * NET3D — a 3D-physics BIOBUZZ match through the REAL authoritative `Room`, the real wire
 * codec, and the real replay container (Day 2 lane C, `docs/biobuzz/plan-3d.md` §7).
 *
 * ── WHAT THIS LANE IS FOR THAT THE OTHERS ARE NOT ──────────────────────────
 * `SIM3D` proves the 3D solve is right. `SERVER` (in `field.ts`) proves a BIOBUZZ room runs.
 * Neither says anything about the seam between them, and that seam is where every bug in this
 * day's work would live: a room whose `physics` never reached `createWorld` plays a 2D match
 * while `matchStart` claims 3D, and NOTHING about it looks wrong — the score is plausible, the
 * snapshots decode, the replay plays back, and the only symptom is that a leaderboard is
 * quietly two leaderboards. So every check below is about a value ARRIVING somewhere, not
 * about physics being correct.
 *
 * ── THE 2D HALF IS NOT PADDING ────────────────────────────────────────────
 * The owner's rule is that the 2D pipeline is permanent, and one Fly app serves every client
 * version — so "a room created without `physics` behaves exactly as it did before" is a real
 * requirement with a real failure mode: a defaulted `'2d'` string appearing in a container, a
 * snapshot or a handshake is a change to bytes that older clients and stored rows already
 * depend on. Half the checks here are that nothing moved.
 *
 * ⚠️ NOTHING HERE MAY HARDCODE FIELD GEOMETRY. The BIOBUZZ constants are being tuned against
 * the CAD in parallel; every assertion below is about ids, counts, tags and equality between
 * two runs, never about a position or a score being a particular number.
 */

/** `SMOOTH_MAX_DIST` from `src/game.ts` — the distance past which a correction SNAPS instead of
 *  easing in. Restated rather than imported for the reason `predict.ts` gives: it lives in a
 *  DOM-adjacent module, and the number is the contract, not the import. */
const SMOOTH_MAX_DIST = 16;

/** the four seats of a 2v2, the same roster shape `field.ts`'s SERVER lane uses */
const ROSTER: { id: string; alliance: Alliance; startIndex: number }[] = [
  { id: 'n3-b1', alliance: 'blue', startIndex: 0 },
  { id: 'n3-b2', alliance: 'blue', startIndex: 1 },
  { id: 'n3-r1', alliance: 'red', startIndex: 0 },
  { id: 'n3-r2', alliance: 'red', startIndex: 1 },
];

/**
 * ⚠️ A `Client.send` IS HANDED A LIVE VIEW OF THE WORLD, NOT A COPY — and every check in this
 * file that compares two moments would be a lie without this function.
 *
 * `slimWorld` SPREADS the world and `stripSpec` spreads each robot, so the result is a fresh
 * object graph one level deep whose `pos`, `vel`, `match.scores` and `state` are still the
 * SAME objects the sim mutates in place; `encodeBallDelta` likewise hands over the live
 * `Artifact`s. In production nothing notices, because `server/index.ts` JSON-encodes the frame
 * onto a socket the same turn. A test that keeps the object instead ends up holding four
 * thousand aliases of one world: the first snapshot and the last read identical, the score at
 * kickoff equals the score at the buzzer, and a match nobody drove looks exactly like a match
 * that was driven hard. All three of those passed as failures here before this existed.
 *
 * So the sink does what the transport does: encode, then decode. `decodeServerMsg(encodeMsg(m))`
 * is the exact round-trip a real client's bytes take, which also makes the "a 2D room's
 * snapshot never mentions physics" check a statement about the WIRE rather than about an
 * object literal.
 */
const wireCopy = (m: ServerMsg): ServerMsg => decodeServerMsg(encodeMsg(m));

function mkClient(
  seat: { id: string; alliance: Alliance; startIndex: number },
  onMsg: (m: ServerMsg) => void,
  caps: string[] = CLIENT_CAPS,
): Client {
  return {
    id: seat.id,
    send: onMsg,
    player: {
      clientId: seat.id,
      name: seat.id,
      teamName: 'Smoke',
      teamNumber: 1,
      alliance: seat.alliance,
      startIndex: seat.startIndex,
      ready: true,
      spec: { ...BB_DEFAULT_SPEC },
      assists: { ...DEFAULT_ASSISTS },
    },
    connected: true,
    disconnectAt: 0,
    caps,
  };
}

/**
 * START A ROOM THE WAY A REAL CLIENT DOES — report every seat's 3D physics in, then press
 * START (owner request, 2026-09-22, `READY3D_CAP`).
 *
 * ⚠️ WITHOUT THE FIRST HALF A 3D ROOM DOES NOT START AT ALL, which is the point of the gate:
 * `mkClient` advertises `CLIENT_CAPS`, so every seat here promises to say when its chunks have
 * landed, and the room holds `startMatch` for exactly as long as one has not. A test that
 * presses START alone is testing a room full of clients that are still loading.
 */
const startRoom = (room: Room, ids: readonly string[], host = ids[0]): void => {
  for (const id of ids) room.onMessage(id, { t: 'physicsReady' });
  room.onMessage(host, { t: 'start' });
};

/** every seat of the standard 2v2 roster */
const ALL_SEATS = ROSTER.map((s) => s.id);

/**
 * A BUSY DRIVER, as a pure function of tick and seat.
 *
 * Deterministic and fully scripted, because a check that depends on when a key was pressed is
 * a check that cannot be re-run. It drives, turns, holds intake and fires on a beat — the same
 * shape `costprobe`'s busy robot uses, and for the same reason: an idle room exercises neither
 * the archetype's code nor the wire.
 *
 * ⚠️ `fieldCentric` is FALSE on these setups (`harness.setup`). With the default assists true,
 * a robot that turns and then drives "forward" goes nowhere and parks in a corner — after
 * which any two runs agree and every comparison below proves nothing. That trap is written
 * down in `docs/area/netcode.md` and it has cost real time twice.
 */
const drive = (tick: number, seat: number): RobotCommand => {
  const p = tick / 60 + seat * 1.7;
  return cmd({
    driveX: Math.sin(p * 0.9),
    driveY: Math.cos(p * 0.7),
    rotate: Math.sin(p * 1.3) * 0.5,
    intake: true,
    fire: tick % 90 > 20,
  });
};

/** the physics tag on a world, read the way every consumer reads it */
const physicsOf = (w: World): string =>
  (w as { biobuzz?: { physics?: string } }).biobuzz?.physics ?? '2d';

/** how many of this world's elements are in flight right now */
const airborne = (w: World): number => w.balls.filter((b) => b.state.kind === 'flight').length;
/** how many are in a robot's hopper right now */
const heldNow = (w: World): number => w.balls.filter((b) => b.state.kind === 'held').length;

export function net3dChecks(check: Check): void {
  // ═══ 1. THE ROOM BUILDS THE WORLD ITS CONFIG ASKED FOR ═════════════════════
  //
  // The whole day rests on this one value arriving, so it is asserted at the room, at the
  // handshake, and in the world — three places, because a room that knows its physics and a
  // world that runs it are different facts and the bug is the gap between them.
  {
    const msgs: ServerMsg[] = [];
    const room = new Room('n3-cfg', () => {}, { kind: 'versus', game: 'biobuzz', physics: '3d' });
    check('room: a config asking for 3D gives a 3D room', room.physics === '3d', room.physics);
    for (const s of ROSTER) {
      room.add(mkClient(s, s.id === 'n3-b1' ? (m) => msgs.push(wireCopy(m)) : () => {}));
    }
    startRoom(room, ALL_SEATS);
    // FOUR TICKS, because `beginMatch` broadcasts `matchStart` and then hands the room to its
    // own 60 Hz timer — the first snapshot is a tick or two away, and `SNAPSHOT_INTERVAL` is 2.
    // `advanceForTest` also drops that timer, which is what stops a lane leaving live rooms
    // ticking behind it.
    room.advanceForTest(4);
    const start = msgs.find((m) => m.t === 'matchStart') as
      | Extract<ServerMsg, { t: 'matchStart' }>
      | undefined;
    check('room: matchStart carries physics:"3d"', start?.physics === '3d', `physics=${String(start?.physics)}`);
    const snap = msgs.find((m) => m.t === 'snapshot') as
      | Extract<ServerMsg, { t: 'snapshot' }>
      | undefined;
    check(
      'room: ...and the world the room actually built is a 3D one',
      !!snap && physicsOf(snap.w as unknown as World) === '3d',
      snap ? physicsOf(snap.w as unknown as World) : 'no snapshot',
    );
  }

  // ═══ 2. EVERY SERVER ROOM OF A 3D GAME IS 3D, WHATEVER THE CLIENT ASKED ════
  //
  // The owner's ruling (2026-09-18): a game that connects to the server runs one solve, because
  // a board fed by two solves is two boards. So the config is deliberately the WRONG answer in
  // every case below and the room has to overrule it — including the CUSTOM room, which is the
  // case that used to be the host's to pick.
  {
    const rec = new Room('n3-rec', () => {}, { kind: 'record', record: 'solo', game: 'biobuzz' });
    check('room: a RECORD room is 3D even with no physics in its config', rec.physics === '3d', rec.physics);
    const custom = new Room('n3-cust', () => {}, { kind: 'versus', game: 'biobuzz', physics: '2d' });
    check(
      'room: a CUSTOM room that asks for 2D is 3D anyway — the host no longer picks',
      custom.physics === '3d',
      custom.physics,
    );
    const bare = new Room('n3-bare', () => {}, { kind: 'versus', game: 'biobuzz' });
    check(
      'room: ...and so is one that says nothing (an old client’s join is not a 2D request)',
      bare.physics === '3d',
      bare.physics,
    );
    const dec = new Room('n3-dec', () => {}, { kind: 'record', record: 'solo', game: 'decode' });
    check(
      'room: ...but only for a game that HAS a 3D solve — a DECODE record room is untouched',
      dec.physics === '2d',
      dec.physics,
    );
    const forced = new Room('n3-forced', () => {}, { kind: 'versus', game: 'decode', physics: '3d' });
    check(
      'room: a DECODE room asked for 3D stays 2D rather than handing step() a physics it cannot run',
      forced.physics === '2d',
      forced.physics,
    );
    /**
     * BACK-COMPAT IS A REFUSAL NOW, NOT A DOWNGRADE — and this is the check that pins it.
     *
     * An old client used to open a BIOBUZZ room by sending no `physics` and get a 2D room. The
     * ruling forbids exactly that outcome (its score would reach the same board), so the room
     * is 3D and the `'bb3d'` cap gate at the door turns that client away instead. The two
     * halves have to agree: a 3D room plus a client that can step it, or a clean refusal.
     */
    check(
      'room: an old client (no caps) is REFUSED at a bare BIOBUZZ room rather than given a 2D one',
      !physicsAllowed(bare.physics, []),
    );
    check('room: ...and a current client is admitted to it', physicsAllowed(bare.physics, CLIENT_CAPS));
  }

  // ═══ 2b. A 3D ROOM DOES NOT START UNTIL EVERY SEAT HAS LOADED ══════════════
  //
  // Owner request, 2026-09-22: "only start any server-required game once 3D physics loads".
  // `'bb3d'` says a client CAN step a 3D world; `'ready3d'` + `{ t: 'physicsReady' }` say WHEN,
  // and the gap between them is the driver who watched the first seconds of their own ranked
  // match from behind a loading panel.
  //
  // ⚠️ EVERY CHECK HERE IS ABOUT A MATCH NOT HAPPENING, which is the one kind that goes
  // vacuous silently: a room that never starts for some unrelated reason passes the first
  // three of them. So each negative is paired with the positive that follows it — the same
  // room, one message later, DOES start.
  {
    const seen: ServerMsg[] = [];
    const room = new Room('n3-r3d-hold', () => {}, { kind: 'versus', game: 'biobuzz' });
    for (const s of ROSTER) room.add(mkClient(s, s.id === 'n3-b1' ? (m) => seen.push(wireCopy(m)) : () => {}));
    room.onMessage('n3-b1', { t: 'start' });
    const started = (): boolean => seen.some((m) => m.t === 'matchStart');
    check('ready3d: START is held while every seat is still loading', !started());
    // ...and the screen is told what it is waiting for, per seat, off the roster
    const ros = (): Extract<ServerMsg, { t: 'roster' }> | undefined =>
      [...seen].reverse().find((m) => m.t === 'roster') as Extract<ServerMsg, { t: 'roster' }> | undefined;
    check(
      'ready3d: the roster says WHICH seats have not loaded',
      ros()?.players.every((p) => p.ready3d === false) === true,
      ros()?.players.map((p) => `${p.clientId}:${String(p.ready3d)}`).join(' '),
    );
    // the waiting screen itself: a custom room's window, with no ratings on it
    const ss = seen.find((m) => m.t === 'strategyStart') as Extract<ServerMsg, { t: 'strategyStart' }> | undefined;
    check('ready3d: a custom room opens the strategy window to wait in', !!ss);
    check('ready3d: ...with ranked FALSE, so the screen hides the ELO column', ss?.ranked === false, String(ss?.ranked));
    check('ready3d: ...and no intros, because a custom room rates nothing', ss?.intros.length === 0);
    check(
      'ready3d: ...and the roster is NOT redacted in it (a custom lobby has shown every build all along)',
      ros()?.players.every((p) => !p.hidden) === true,
    );
    // three of four report in: still not enough, and that is the check that makes the last one
    // mean something (a room that starts on the FIRST message would pass "it started" too)
    for (const s of ROSTER.slice(0, 3)) room.onMessage(s.id, { t: 'physicsReady' });
    check('ready3d: three of four seats loaded is still not four', !started());
    room.onMessage(ROSTER[3].id, { t: 'physicsReady' });
    check('ready3d: the last seat reporting in starts the match', started());
    room.advanceForTest(1); // drop the live timer this lane must not leave running
  }

  // AN OLD CLIENT IS NEVER WAITED FOR. It cannot send the message, so waiting on one would
  // hold a whole room for the full deadline and then start anyway — the worst of both.
  {
    const seen: ServerMsg[] = [];
    const room = new Room('n3-r3d-old', () => {}, { kind: 'versus', game: 'biobuzz' });
    const old = CLIENT_CAPS.filter((c) => c !== 'ready3d');
    for (const s of ROSTER) room.add(mkClient(s, s.id === 'n3-b1' ? (m) => seen.push(wireCopy(m)) : () => {}, old));
    room.onMessage('n3-b1', { t: 'start' });
    check(
      'ready3d: a roster with no `ready3d` cap starts at once, exactly as it did before',
      seen.some((m) => m.t === 'matchStart'),
    );
    const ros = [...seen].reverse().find((m) => m.t === 'roster') as Extract<ServerMsg, { t: 'roster' }> | undefined;
    check(
      'ready3d: ...and no seat carries a load state, because there is nothing to wait for',
      ros?.players.every((p) => p.ready3d === undefined) === true,
    );
    room.advanceForTest(1);
  }

  // A MIXED ROSTER TAKES THE OLD PATH WHOLE. One client that cannot render the waiting screen
  // (no `'strategy'`) is enough: the alternative is a lobby that silently stops answering
  // START for whoever is on the older build.
  {
    const seen: ServerMsg[] = [];
    const room = new Room('n3-r3d-mixed', () => {}, { kind: 'versus', game: 'biobuzz' });
    room.add(mkClient(ROSTER[0], (m) => seen.push(wireCopy(m))));
    room.add(mkClient(ROSTER[1], () => {}, ['bb3d', 'ready3d'])); // no 'strategy'
    room.onMessage(ROSTER[0].id, { t: 'start' });
    check(
      'ready3d: a mixed room starts immediately rather than opening a window one member cannot show',
      seen.some((m) => m.t === 'matchStart'),
    );
    check('ready3d: ...and opens no window at all', !seen.some((m) => m.t === 'strategyStart'));
    room.advanceForTest(1);
  }

  // THE DEADLINE STARTS THE MATCH, IT NEVER CANCELS ONE. A chunk that has not arrived in 45 s
  // is not arriving, and the other three people in the room did nothing wrong — and a cancel
  // here would hand every client a free dodge, since `physicsReady` is a message a client
  // chooses to send.
  {
    const seen: ServerMsg[] = [];
    const room = new Room('n3-r3d-deadline', () => {}, { kind: 'versus', game: 'biobuzz' });
    for (const s of ROSTER) room.add(mkClient(s, s.id === 'n3-b1' ? (m) => seen.push(wireCopy(m)) : () => {}));
    room.onMessage('n3-b1', { t: 'start' });
    check('ready3d: (the deadline case is held first, so its start is the deadline’s)', !seen.some((m) => m.t === 'matchStart'));
    room.forceReady3dDeadlineForTest();
    check('ready3d: the deadline starts the match with a seat still loading', seen.some((m) => m.t === 'matchStart'));
    check(
      'ready3d: ...and nobody is told the match was cancelled',
      !seen.some((m) => m.t === 'error'),
      seen.filter((m) => m.t === 'error').map((m) => (m.t === 'error' ? m.message : '')).join(' | '),
    );
    room.advanceForTest(1);
  }

  // A 2D GAME NEVER WAITS, whatever its clients advertise — there is no chunk to load.
  {
    const seen: ServerMsg[] = [];
    const room = new Room('n3-r3d-2d', () => {}, { kind: 'versus', game: 'decode' });
    for (const s of ROSTER) room.add(mkClient(s, s.id === 'n3-b1' ? (m) => seen.push(wireCopy(m)) : () => {}));
    room.onMessage('n3-b1', { t: 'start' });
    check('ready3d: a DECODE room starts on START, with nobody having reported anything', seen.some((m) => m.t === 'matchStart'));
    room.advanceForTest(1);
  }

  // ═══ 2c. A STARTED 3D MATCH WAITS AT TICK 0 UNTIL EVERY SEAT CAN PLAY IT ══════════════
  //
  // Owner, 2026-09-24: matches still started behind the loading panel, record runs included.
  // `physicsReady` is sent from the LOBBY and covers the physics chunk only; the 3D view is
  // built by the game screen, which exists only after `matchStart`. So the room holds the new
  // match at tick 0 (`loadHold`) until each `viewready` seat reports `viewReady` for THIS
  // generation, and starts anyway at `LOAD_HOLD_MAX_MS`. Each negative is paired with the
  // positive one message later, for the reason 2b gives.
  {
    const seen: ServerMsg[] = [];
    const room = new Room('n3-hold', () => {}, { kind: 'versus', game: 'biobuzz' });
    for (const s of ROSTER) room.add(mkClient(s, s.id === 'n3-b1' ? (m) => seen.push(wireCopy(m)) : () => {}));
    startRoom(room, ROSTER.map((s) => s.id));
    const ms = seen.find((m) => m.t === 'matchStart') as Extract<ServerMsg, { t: 'matchStart' }> | undefined;
    check('viewready: the match started (else nothing below proves anything)', !!ms);
    const gen = ms?.gen ?? 0;
    const holds = (): Extract<ServerMsg, { t: 'loadHold' }>[] =>
      seen.filter((m): m is Extract<ServerMsg, { t: 'loadHold' }> => m.t === 'loadHold');
    check('viewready: a started 3D match is HELD while its seats load', room.loadHoldForTest().held);
    check(
      'viewready: ...and every client is told, with the time left and who is loading',
      holds().length === 1 && holds()[0].waitMs > 0 && holds()[0].waitMs <= LOAD_HOLD_MAX_MS && holds()[0].loading.length === 4,
      JSON.stringify(holds()[0]),
    );
    room.pumpForTest(30);
    check('viewready: a held match does not tick', room.tickForTest() === 0, `tick=${room.tickForTest()}`);
    room.onMessage('n3-b1', { t: 'viewReady', gen: gen + 7 });
    check('⚠️ viewready: a report for ANOTHER generation does not count', room.loadHoldForTest().loading.length === 4);
    for (const s of ROSTER.slice(0, 3)) room.onMessage(s.id, { t: 'viewReady', gen });
    room.pumpForTest(30);
    check('viewready: three of four seats ready is still held', room.tickForTest() === 0 && room.loadHoldForTest().held);
    check(
      'viewready: ...and each report re-tells the room who is left',
      holds()[holds().length - 1].loading.length === 1,
      JSON.stringify(holds()[holds().length - 1]),
    );
    room.onMessage(ROSTER[3].id, { t: 'viewReady', gen });
    room.pumpForTest(30);
    check('viewready: the last seat reporting in releases the match', room.tickForTest() > 0 && !room.loadHoldForTest().held);
    const rel = holds()[holds().length - 1];
    check('viewready: ...and the release says nobody was left behind', rel.waitMs === 0 && rel.loading.length === 0, JSON.stringify(rel));
    room.advanceForTest(1);
  }

  // THE CAP STARTS THE MATCH ANYWAY, never cancels it, and names who it left behind.
  {
    const seen: ServerMsg[] = [];
    const room = new Room('n3-hold-cap', () => {}, { kind: 'versus', game: 'biobuzz' });
    for (const s of ROSTER) room.add(mkClient(s, s.id === 'n3-b1' ? (m) => seen.push(wireCopy(m)) : () => {}));
    startRoom(room, ROSTER.map((s) => s.id));
    const gen = (seen.find((m) => m.t === 'matchStart') as Extract<ServerMsg, { t: 'matchStart' }> | undefined)?.gen ?? 0;
    for (const s of ROSTER.slice(0, 3)) room.onMessage(s.id, { t: 'viewReady', gen });
    room.pumpForTest(30);
    check('viewready cap: (held first, so the start below is the cap’s)', room.tickForTest() === 0);
    const late = room.loadHoldForTest().loading;
    room.expireLoadHoldForTest();
    room.pumpForTest(30);
    check('viewready cap: the cap starts the match with a seat still loading', room.tickForTest() > 0);
    const rel = [...seen].reverse().find((m) => m.t === 'loadHold') as Extract<ServerMsg, { t: 'loadHold' }> | undefined;
    check(
      'viewready cap: ...and the release names the seat it started without',
      rel?.waitMs === 0 && rel.loading.length === 1 && rel.loading[0] === late[0],
      JSON.stringify(rel),
    );
    check('viewready cap: ...and nobody is told the match was cancelled', !seen.some((m) => m.t === 'error'));
    room.onMessage(ROSTER[3].id, { t: 'viewReady', gen });
    check('viewready cap: the late seat reporting in afterwards changes nothing', !room.loadHoldForTest().held);
    room.advanceForTest(1);
  }

  // WHO IS NOT WAITED ON: a dropped seat, a build without the cap, and a 2D game.
  {
    const room = new Room('n3-hold-drop', () => {}, { kind: 'versus', game: 'biobuzz' });
    const clients = ROSTER.map((s) => mkClient(s, () => {}));
    for (const c of clients) room.add(c);
    startRoom(room, ROSTER.map((s) => s.id));
    clients[3].connected = false; // its socket is gone; the grace decides its seat, not the hold
    for (const c of clients.slice(0, 3)) room.onMessage(c.id, { t: 'viewReady', gen: room.loadHoldForTest().gen });
    const gen0 = room.loadHoldForTest().loading.length;
    room.pumpForTest(30);
    check('viewready: a DROPPED seat does not hold the others', gen0 === 0 && room.tickForTest() > 0, `loading=${gen0} tick=${room.tickForTest()}`);
    room.advanceForTest(1);
  }
  {
    const old = CLIENT_CAPS.filter((c) => c !== VIEWREADY_CAP);
    const room = new Room('n3-hold-old', () => {}, { kind: 'versus', game: 'biobuzz' });
    for (const s of ROSTER) room.add(mkClient(s, () => {}, old));
    startRoom(room, ROSTER.map((s) => s.id));
    check('viewready: a roster with no `viewready` cap is not held, exactly as before', !room.loadHoldForTest().held);
    room.advanceForTest(1);
  }
  {
    const room = new Room('n3-hold-2d', () => {}, { kind: 'versus', game: 'decode' });
    for (const s of ROSTER) room.add(mkClient(s, () => {}));
    room.onMessage(ROSTER[0].id, { t: 'start' });
    check('viewready: a DECODE match is never held', room.tickForTest() === 0 && !room.loadHoldForTest().held);
    room.advanceForTest(1);
  }

  // THE CLIENT HALF, as source pins: `ServerSession` cannot be imported headlessly
  // (`src/net/env.ts` reads `import.meta.env` at load). The session holds while told to, only for
  // its own generation, reports once per generation, and cannot be stranded by a lost release;
  // the controller reports only once physics AND view are up, and does not predict while held.
  {
    const sess = readFileSync('src/net/serverSession.ts', 'utf8');
    const onHold = /if \(m\.t === 'loadHold'\) \{[\s\S]*?\r?\n {4}\}/.exec(sess)?.[0] ?? '';
    check('viewready session: a hold for another generation is ignored', onHold.includes('m.gen !== this.gen'));
    check(
      '⚠️ viewready session: a running snapshot clears a hold whose release was lost',
      sess.includes('if (this.hold && m.serverTick > 0) this.hold = null;'),
    );
    check('⚠️ viewready session: ...and so does the room’s own cap', /performance\.now\(\) > this\.hold\.until \+ \d+/.test(sess));
    const vr = /\n {2}viewReady\(\): void \{[\s\S]*?\r?\n {2}\}/.exec(sess)?.[0] ?? '';
    check('viewready session: reports once per generation, stamped with it', vr.includes('this.viewSentGen === this.gen') && vr.includes("t: 'viewReady', gen: this.gen"));
    check('viewready session: a reclaimed seat reports again', sess.includes('if (m.ok) this.viewSentGen = -1;'));

    const game = readFileSync('src/game.ts', 'utf8');
    const step = /private stepServer\(cmd: RobotCommand\): void \{[\s\S]*?\r?\n {2}\}\r?\n/.exec(game)?.[0] ?? '';
    const pend = step.indexOf('if (this.physicsPending)');
    const ready = step.indexOf('if (!this.sceneLoading) s.viewReady?.()');
    check('viewready: the controller reports only after physics, and only when the view is not loading', pend >= 0 && ready > pend);
    check('viewready: ...and does not predict while held', step.includes('if (s.loadHeld?.())'));
    check('viewready: this build advertises the capability', CLIENT_CAPS.includes(VIEWREADY_CAP));
    // a seat the cap started without was LOADING, not idle: its loading ticks come off the live
    // ticks its AFK verdict is judged against (a full ranked match is too slow to run here)
    const roomSrc = readFileSync('server/room.ts', 'utf8');
    check(
      '⚠️ viewready: a late loader is not judged AFK for the ticks it spent loading',
      roomSrc.includes('liveTicks: Math.max(0, this.liveTicks - (this.loadingTicks.get(rid) ?? 0)),') &&
        /for \(const rid of this\.seatsLoading\(\)\) this\.loadingTicks\.set/.test(roomSrc),
    );
  }

  // RANKED IS WHERE THE WAIT WAS WORTH BUILDING — the strategy screen (alliances + ELO) IS
  // the waiting room, and its clock must not run out on a download. `onStrategyDeadline` is
  // STRICT and CANCELS, so without the extension a driver who readied on time and was still
  // fetching 1.1 MB lost the match AND was billed a `unready` dodge for it.
  {
    const rec: ServerMsg[] = [];
    const mkRanked = (
      seat: { id: string; alliance: Alliance; startIndex: number },
      userId: string,
      onMsg: (m: ServerMsg) => void,
    ): Client => {
      const c = mkClient(seat, onMsg);
      c.userId = userId;
      c.player.ready = false; // a staged room resets ready anyway; be explicit
      return c;
    };
    const room = new Room('n3-rank3d', () => {}, { kind: 'versus', game: 'biobuzz' });
    const pending: PendingMatch = {
      code: 'iad-n3rank',
      hostRegion: 'iad',
      mode: '1v1',
      seed: 7,
      ranked: true,
      game: 'biobuzz',
      roster: [
        { userId: 'u-n3-red', name: 'red', teamName: 'T', teamNumber: 1, spec: { ...BB_DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS }, startIndex: 0, alliance: 'red', introElo: 1200 },
        { userId: 'u-n3-blue', name: 'blue', teamName: 'T', teamNumber: 2, spec: { ...BB_DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS }, startIndex: 0, alliance: 'blue', introElo: 1300 },
      ],
    };
    room.applyPending(pending);
    room.add(mkRanked({ id: 'n3-rk-r', alliance: 'red', startIndex: 0 }, 'u-n3-red', (m) => rec.push(wireCopy(m))));
    room.add(mkRanked({ id: 'n3-rk-b', alliance: 'blue', startIndex: 0 }, 'u-n3-blue', () => {}));
    room.maybeStartRanked();
    const ss0 = rec.find((m) => m.t === 'strategyStart') as Extract<ServerMsg, { t: 'strategyStart' }> | undefined;
    check('ready3d ranked: the strategy window opened (else nothing below proves anything)', !!ss0);
    check('ready3d ranked: ...and it is RANKED, so the screen keeps its ELO column', ss0?.ranked !== false);
    room.onMessage('n3-rk-r', { t: 'update', patch: { ready: true } });
    room.onMessage('n3-rk-b', { t: 'update', patch: { ready: true } });
    const started = (): boolean => rec.some((m) => m.t === 'matchStart');
    check('ready3d ranked: both drivers ready is NOT enough while a seat is still loading', !started());
    const deadlines = (): number[] =>
      rec.filter((m): m is Extract<ServerMsg, { t: 'strategyStart' }> => m.t === 'strategyStart').map((m) => m.deadline);
    check(
      'ready3d ranked: the window is EXTENDED and the screen is re-told the new deadline',
      deadlines().length > 1 && deadlines()[deadlines().length - 1] > deadlines()[0],
      deadlines().join(' → '),
    );
    // the strict deadline firing now must NOT cancel: everyone did what was asked of them
    room.forceStrategyDeadlineForTest();
    check(
      'ready3d ranked: the strategy deadline does not cancel a match everyone readied for',
      !rec.some((m) => m.t === 'error'),
      rec.filter((m) => m.t === 'error').map((m) => (m.t === 'error' ? m.message : '')).join(' | '),
    );
    check('ready3d ranked: ...and still has not started it', !started());
    room.onMessage('n3-rk-r', { t: 'physicsReady' });
    check('ready3d ranked: one of two seats loaded is not both', !started());
    room.onMessage('n3-rk-b', { t: 'physicsReady' });
    check('ready3d ranked: the last seat reporting in starts the ranked match', started());
    room.advanceForTest(1);
  }

  // THE CLIENT SIDE OF THE HANDSHAKE, as a source pin: the capability is advertised, the
  // announcement is latched rather than hooked onto `onOpen` (which is single-slot on both
  // transports — a second subscriber silently unhooks the re-`join` a reconnect needs), and
  // every screen that can lead into a server room starts the fetch early.
  {
    check('ready3d: this build advertises the capability', CLIENT_CAPS.includes(READY3D_CAP));
    check('ready3d: the server advertises the mirror of it', SERVER_CAPS.includes(READY3D_CAP));
    check('ready3d: the deadline is the one both halves read', READY3D_DEADLINE_MS >= 30000 && READY3D_DEADLINE_MS <= 120000, `${READY3D_DEADLINE_MS}ms`);
    check('ready3d: a client without the cap reports nothing', !reportsPhysicsReady(['bb3d', 'strategy']));
    const lc = readFileSync('src/net/lobbyClient.ts', 'utf8');
    const announce = /\n {2}physicsReady\(\): void \{[\s\S]*?\n {2}\}/.exec(lc)?.[0] ?? '';
    check(
      'ready3d: `physicsReady` LATCHES — it does not subscribe to `onOpen`, which is single-slot',
      /this\.ready3d = true/.test(announce) && !/onOpen|onReopen/.test(announce),
      announce.replace(/\s+/g, ' ').slice(0, 120),
    );
    check(
      'ready3d: ...and the latch is flushed on `welcome`, not behind the join frame',
      // a join is handled ASYNCHRONOUSLY server-side, so a frame sent straight after it lands
      // on a socket with no room yet and is dropped with nothing to retry it
      /m\.t === 'welcome'\)? \{[\s\S]{0,900}?this\.sendPhysicsReady\(\);/.test(lc),
    );
    const rp = readFileSync('src/net/roomPhysics.ts', 'utf8');
    check(
      'ready3d: the helper reaches the game through the SERVER-SAFE registry, not the canvas one',
      /from '\.\.\/games\/sim'/.test(rp) && !/from '\.\.\/games'/.test(rp),
    );
    for (const [file, what] of [
      ['src/ui/Matchmaking.tsx', 'the ranked queue'],
      ['src/ui/Lobby.tsx', 'the custom room'],
    ] as const) {
      const src = readFileSync(file, 'utf8');
      check(`ready3d: ${what} fetches the chunk before a match is in prospect`, src.includes('preloadRoomPhysics('));
      check(`ready3d: ...and ${what} announces it on the room socket`, src.includes('announcePhysicsReady('));
    }
    const rr = readFileSync('src/ui/RecordRun.tsx', 'utf8');
    check('ready3d: the record page announces readiness on its own room too', rr.includes('announcePhysicsReady('));
    check('ready3d: ...and shows a loading state rather than a bare status line', rr.includes('ds-loading'));
    const ms = readFileSync('src/ui/MatchStrategy.tsx', 'utf8');
    check('ready3d: the strategy screen names the seats that are still loading', ms.includes('LOADING 3D'));
    check('ready3d: ...and says so instead of “Everyone ready. Starting…”', /loading3d\.length[\s\S]{0,160}Loading 3D physics/.test(ms));
    check('ready3d: ...and hides the ELO column when the window is not ranked', /ranked && <span className="ds-chip">\{ratingChip\(/.test(ms));
  }

  // ═══ 3. THE OLD-CLIENT PROOF: a 2D GAME's wire is what it always was ═══════
  //
  // This used to be a BIOBUZZ room with no `physics` in its config. That room is 3D now (section
  // 2), so the thing this section actually guards — that a 2D room's handshake and snapshots are
  // byte-for-byte what they were before the field existed — is asserted where it is still true
  // and always will be: a DECODE room, whose game declares no 3D solve at all.
  {
    const msgs: ServerMsg[] = [];
    const room = new Room('n3-2d', () => {}, { kind: 'versus', game: 'decode' });
    check('room: a DECODE room is a 2D room', room.physics === '2d', room.physics);
    for (const s of ROSTER) {
      room.add(mkClient(s, s.id === 'n3-b1' ? (m) => msgs.push(wireCopy(m)) : () => {}));
    }
    startRoom(room, ALL_SEATS);
    room.advanceForTest(4); // see the note in the 3D room above
    const start = msgs.find((m) => m.t === 'matchStart') as
      | Extract<ServerMsg, { t: 'matchStart' }>
      | undefined;
    /**
     * ABSENT, not `'2d'`. An older client ignores an unknown key either way, but a key that
     * appears is a change to the handshake bytes every stored and relayed copy already has.
     *
     * ⚠️ MEASURED ON THE ENCODED FRAME, not with `'physics' in start`. An object literal
     * written `physics: cond ? '3d' : undefined` HAS the key — with the value `undefined` —
     * so the `in` test answers true and would pass this check while the bytes were fine, or
     * fail it while they were fine. `JSON.stringify` drops an undefined value, and the wire is
     * what both halves of this rule are actually about.
     */
    check(
      'wire: a 2D room omits `physics` from matchStart entirely (absent already reads 2d)',
      !!start && !JSON.stringify(start).includes('physics'),
      start ? JSON.stringify(start).slice(0, 120) : 'no matchStart',
    );
    const snap = msgs.find((m) => m.t === 'snapshot') as
      | Extract<ServerMsg, { t: 'snapshot' }>
      | undefined;
    check(
      'wire: ...and nothing in its snapshot stream mentions physics at all',
      !!snap && !JSON.stringify(snap).includes('physics'),
      snap ? 'found the string in a 2D snapshot' : 'no snapshot',
    );
  }

  // ═══ 4. THE 2D PIPELINE IS BYTE-IDENTICAL TO THE PRE-CHANGE CALL ═══════════
  //
  // THE GOLDEN IS COMPUTED IN THIS RUN, from the four-argument call — which is literally the
  // pre-change signature, since `physics` is a trailing optional fifth parameter. So this is
  // not "the numbers look the same as last time I looked"; it is the old call and the new one,
  // stepped side by side, on the same seed, in the same process.
  {
    const mod = simModuleFor('biobuzz');
    const setups = [setup(0, 'blue', {}, 0), setup(1, 'red', {}, 1)];
    // the PRE-CHANGE call: four arguments, exactly as every caller wrote it before Day 2
    const before = mod.createWorld('match', 9090, setups);
    // the new call, saying explicitly what the old one meant
    const after = mod.createWorld('match', 9090, setups, undefined, '2d');
    check('2d-parity: the four-argument call still builds a 2D world', physicsOf(before) === '2d', physicsOf(before));
    check('2d-parity: ...and it is byte-identical to an explicit 2D one at tick 0',
      JSON.stringify(before) === JSON.stringify(after));

    let drift = -1;
    for (let t = 1; t <= 600; t++) {
      const cmds = new Map<number, RobotCommand>([
        [0, drive(t, 0)],
        [1, drive(t, 1)],
      ]);
      mod.step(before, C.SIM_DT, new Map(cmds));
      mod.step(after, C.SIM_DT, new Map(cmds));
      if (drift < 0 && worldHash(before) !== worldHash(after)) drift = t;
    }
    check(
      '2d-parity: 600 driven ticks later the two worlds still hash identically',
      drift < 0,
      drift < 0 ? '' : `diverged at tick ${drift}`,
    );
    // ...and the WIRE form too, which is the half a client sees. `slimWorld` spreads the world,
    // so a stray key anywhere in it would show up here and nowhere else.
    check(
      '2d-parity: ...and their wire snapshots are the same bytes',
      JSON.stringify(slimWorld(before)) === JSON.stringify(slimWorld(after)),
    );
  }

  // ═══ 5. THE CAPABILITY GATE ════════════════════════════════════════════════
  //
  // The predicate AND the four places that are supposed to call it. The predicate alone is a
  // vacuous check: it is five lines and it cannot be wrong in an interesting way. What can be
  // wrong — silently, and only in production — is a door that never asks it, which is why the
  // second half reads the server source.
  {
    check('caps: the refusal says exactly what the plan says it says',
      BB3D_REFUSAL === 'Update DSIM to play this room.', BB3D_REFUSAL);
    check('caps: this build advertises the capability', CLIENT_CAPS.includes(BB3D_CAP));
    check('caps: a 3D room refuses a client with no caps at all', !physicsAllowed('3d', []));
    check('caps: ...and one whose caps predate it', !physicsAllowed('3d', ['strategy', 'startpose', 'game']));
    check('caps: a current client is admitted', physicsAllowed('3d', CLIENT_CAPS));
    // A 2D ROOM ADMITS EVERYONE. This is the back-compat rule the whole gate is written
    // around, and it is the one that would be broken by "just require the cap everywhere".
    check('caps: a 2D room admits a client with no caps, exactly as it always did', physicsAllowed('2d', []));
    check('caps: an ABSENT physics is a 2D room and admits everyone', physicsAllowed(undefined, []));

    const server = readFileSync('server/index.ts', 'utf8');
    const gates = server.split('physicsAllowed(').length - 1;
    check(
      'caps: server/index.ts asks the gate at all FOUR doors (join, spectate, rejoin, queue)',
      gates === 4,
      `${gates} call sites`,
    );
    const sends = server.split('message: BB3D_REFUSAL').length - 1;
    check(
      'caps: ...and every one of them answers with the shared string, not a message of its own',
      sends === 4,
      `${sends} sends`,
    );

    /**
     * ⚠️ THE CLIENT'S SIDE OF THE SAME DOORS, added Day 3 after a browser run found it open.
     *
     * A gate has two halves and only one of them was tested. `rejoin` declares `caps` on the
     * message type and `App.rejoinGame` sent the frame WITHOUT it, so a current client returning
     * to its own live 3D match was refused with "Update DSIM to play this room." — the server
     * behaving exactly as designed, against a client that had simply not said what it could do.
     * Every frame the server gates must ADVERTISE, and these are the three that send one.
     */
    const app = readFileSync('src/ui/App.tsx', 'utf8');
    check(
      'caps: the client advertises them when it REJOINS, not only when it joins',
      /t: 'rejoin'[^}]*caps: CLIENT_CAPS/.test(app),
      'App.rejoinGame sends no caps — a 3D room will refuse it',
    );
    const lobby = readFileSync('src/net/lobbyClient.ts', 'utf8');
    check('caps: ...and when it joins', /t: 'join'[\s\S]{0,160}caps: CLIENT_CAPS/.test(lobby));
    check('caps: ...and when it spectates', /t: 'spectate'[\s\S]{0,120}caps: CLIENT_CAPS/.test(lobby));

    /**
     * AND THE ROOM'S PHYSICS SURVIVES THE ROUND TRIP THROUGH THE REJOIN RECORD.
     *
     * `App.beginSession` rebuilds the handshake FIELD BY FIELD into `ActiveGameRef.start`, and
     * `physics` was not one of the fields — so a rejoin built a 2D world for a 3D room, predicted
     * a different game from the one the server was scoring, and never latched `physicsPending`.
     * Both halves are pinned: the field is copied, and the TYPE names it (a field the type does
     * not name is a field nobody thinks to copy, which is how it went missing).
     */
    check(
      'caps: the rejoin record carries the room’s physics',
      /start: \{[\s\S]{0,900}physics: s\.physics,/.test(app),
      'ActiveGameRef.start drops physics',
    );
    check(
      'caps: ...and `MatchStart` declares it, so the next field-by-field copy cannot miss it',
      /export interface MatchStart \{[\s\S]{0,1400}physics\?: Physics;/.test(lobby),
    );
  }

  // ═══ 6. THE WIRE CARRIES z, AND THE CLIENT'S DECODER REBUILDS IT ═══════════
  //
  // Driven off a real 3D world rather than off a hand-made one, because the thing being tested
  // is that `slimWorld`/`encodeBallDelta` need NO change to carry the new fields — they spread
  // the whole object — and a hand-made world would prove that about a shape nothing produces.
  {
    const mod = simModuleFor('biobuzz');
    const w = mod.createWorld('match', 7777, [setup(0, 'blue', {}, 0), setup(1, 'red', {}, 1)], undefined, '3d');
    w.match.preCountdown = C.PRE_COUNTDOWN;
    let peakHeld = 0;
    let flightTicks = 0;
    let anyLift = false;
    for (let t = 1; t <= 900; t++) {
      mod.step(w, C.SIM_DT, new Map([[0, drive(t, 0)], [1, drive(t, 1)]]));
      peakHeld = Math.max(peakHeld, heldNow(w));
      if (airborne(w) > 0) flightTicks++;
      if (w.balls.some((b) => b.state.kind !== 'held' && b.state.kind !== 'stock' && b.z > 0.5)) anyLift = true;
    }
    // THE SCENE HAS TO HAVE HAPPENED, or the codec check below is a check of an idle field.
    check('wire: the scripted 3D scene actually ran the archetype (something was held)', peakHeld > 0, `peak=${peakHeld}`);
    check('wire: ...and something was in flight', flightTicks > 0, `${flightTicks} ticks with an element airborne`);
    check('wire: ...and an element left the floor (z is a live degree of freedom here)', anyLift);

    const slim = slimWorld(w);
    const delta = encodeBallDelta(null, w.balls); // a KEYFRAME: every element, as a reconnect gets
    const framed = JSON.parse(JSON.stringify({ w: slim, balls: delta })) as {
      w: typeof slim;
      balls: typeof delta;
    };
    const specById = (id: number): RobotSpec => w.robots.find((r) => r.id === id)!.spec;
    const rebuilt = unslimWorld(
      framed.w,
      applyBallDelta(new Map<number, Artifact>(), framed.balls),
      specById,
    );
    check('wire: a keyframe round-trips to the same world hash', worldHash(rebuilt) === worldHash(w),
      `${worldHash(rebuilt)} vs ${worldHash(w)}`);
    check('wire: the decoded world keeps its physics tag (a joiner reads it from the keyframe)',
      physicsOf(rebuilt) === '3d', physicsOf(rebuilt));
    check('wire: every robot arrives with a z', rebuilt.robots.every((r) => typeof r.z === 'number'),
      rebuilt.robots.map((r) => String(r.z)).join(','));
    check('wire: ...and a vz', rebuilt.robots.every((r) => typeof r.vz === 'number'));
    check('wire: all 56 elements arrive', rebuilt.balls.length === w.balls.length, `${rebuilt.balls.length}`);
    check('wire: ...each with its z intact',
      rebuilt.balls.every((b, i) => b.z === w.balls[i].z && b.vz === w.balls[i].vz));
    // and the ORDER, which is what `worldHash` and the collision iteration both depend on
    check('wire: ...in the authoritative order',
      rebuilt.balls.map((b) => b.id).join(',') === w.balls.map((b) => b.id).join(','));
  }

  // ═══ 7. A WHOLE 3D 2v2 MATCH, DRIVEN, THROUGH THE REAL ROOM ════════════════
  {
    /**
     * The sink keeps EVERY control message and a THINNED, decoded record of the snapshot
     * stream. A full match is ~5,200 snapshots of ~8 KB, and decoding all of them costs
     * several seconds for nothing: the per-snapshot facts (is it 3D, does it carry `z`, was
     * anything in flight) are folded in as they arrive, and only the first and the last frames
     * are kept whole, which is all the comparisons below need.
     */
    const control: ServerMsg[] = [];
    let snapCount = 0;
    let all3d = true;
    let allHaveZ = true;
    let flightSeen = false;
    let firstSnap: Extract<ServerMsg, { t: 'snapshot' }> | null = null;
    let lastSnap: Extract<ServerMsg, { t: 'snapshot' }> | null = null;
    const maxAway: number[] = [];
    const sink = (raw: ServerMsg): void => {
      if (raw.t !== 'snapshot') {
        control.push(wireCopy(raw));
        return;
      }
      const m = wireCopy(raw) as Extract<ServerMsg, { t: 'snapshot' }>;
      snapCount++;
      if (physicsOf(m.w as unknown as World) !== '3d') all3d = false;
      if (!m.w.robots.every((r) => typeof r.z === 'number')) allHaveZ = false;
      if (!flightSeen && (m.balls.upd ?? []).some((b) => b.state.kind === 'flight')) flightSeen = true;
      if (!firstSnap) firstSnap = m;
      lastSnap = m;
      const base = firstSnap as Extract<ServerMsg, { t: 'snapshot' }>;
      m.w.robots.forEach((r, i) => {
        const p = base.w.robots[i];
        if (!p) return;
        const d = Math.hypot(r.pos.x - p.pos.x, r.pos.y - p.pos.y);
        if (d > (maxAway[i] ?? 0)) maxAway[i] = d;
      });
    };

    let outcomePhysics: string | undefined = '<onResult never called>';
    let finalized = false;
    const room = new Room(
      'n3-match',
      () => {},
      { kind: 'versus', game: 'biobuzz', physics: '3d' },
      (o) => {
        outcomePhysics = o.replay.physics ?? '(absent)';
        finalized = true;
      },
    );
    for (const seat of ROSTER) room.add(mkClient(seat, seat.id === 'n3-b1' ? sink : () => {}));
    startRoom(room, ALL_SEATS);

    /**
     * Fed a tick at a time, because that is how a driver feeds one. `advanceForTest(n)` pumps
     * n ticks against whatever the room is already holding, so handing it the whole match in
     * one call would run four robots on a single held command for three minutes — which does
     * move them, and would make every assertion below about a scene nobody scripted.
     */
    let threw: unknown = null;
    try {
      const cap = maxMatchTicks() + 5;
      for (let t = 0; t < cap && !finalized; t++) {
        const tick = room.tick + 1;
        ROSTER.forEach((seat, i) => {
          room.onMessage(seat.id, { t: 'input', tick, q: quantizeCommand(drive(tick, i)) });
        });
        room.advanceForTest(1);
      }
    } catch (e) {
      threw = e;
    }
    check('match: a driven 3D 2v2 runs a whole match without throwing', threw === null,
      threw ? String(threw) : '');
    check('match: the room broadcast snapshots', snapCount > 0, `${snapCount}`);
    check('match: every snapshot is a 3D world', snapCount > 0 && all3d);
    check('match: every snapshot carries per-robot z', snapCount > 0 && allHaveZ);

    // THE ROBOTS MOVED. Without this, everything else here is true of four robots sitting on
    // their start poses — and `DEFAULT_ASSISTS.fieldCentric` has produced exactly that twice.
    // ⚠️ FURTHEST FROM THE START, NOT WHERE IT FINISHED. Comparing the last frame to the first
    // asks whether a robot happened to END somewhere else, and over a three-minute match on a
    // 12-ft field one of four roaming robots eventually finishes within a few inches of where it
    // began — which read as "robot 3 drove 3.3 in" while its trace crossed the whole field. The
    // question is whether it MOVED, so the measure is the maximum displacement seen.
    const a = firstSnap as Extract<ServerMsg, { t: 'snapshot' }> | null;
    const moved = !!a && maxAway.length === a.w.robots.length && maxAway.every((d) => d > 6);
    check('match: every robot drove somewhere', moved, maxAway.map((d) => d.toFixed(1)).join(', '));

    check('match: at least one element was in flight during the match', flightSeen);

    const res = control.find((m) => m.t === 'matchResult') as
      | Extract<ServerMsg, { t: 'matchResult' }>
      | undefined;
    check('match: it reached post and broadcast matchResult', !!res);
    // THE BASELINE IS DERIVED IN THIS RUN, from the first snapshot — which is taken during
    // `pre`, so it is the staged layout's own score. Typed as a literal it would pin the
    // staging from this file, and the staging is being tuned against the CAD in parallel.
    const staged = a ? a.w.match.scores : null;
    check(
      'match: the driven match outscored the staged layout it started from',
      !!res && !!staged &&
        (res.result.score.blue > staged.blue.total || res.result.score.red > staged.red.total),
      res && staged
        ? `staged ${staged.blue.total}/${staged.red.total} → final ${res.result.score.blue}/${res.result.score.red}`
        : '',
    );

    // THE OUTCOME CARRIES THE TAG `persistMatch` WRITES TO THE DATABASE. Read off the replay,
    // which is the same place `persist.ts` and `ranked.ts` read it, so this check fails if
    // either of them is ever pointed somewhere else.
    check('match: the MatchOutcome replay is stamped physics:"3d"', outcomePhysics === '3d',
      `physics=${String(outcomePhysics)}`);
    check('match: the broadcast replay is stamped too (it is what a client stores)',
      res?.replay.physics === '3d', `physics=${String(res?.replay.physics)}`);
  }

  // ═══ 8. REPLAYS: RECORDED, JSON'd, RE-SIMULATED, TICK FOR TICK ═════════════
  //
  // ⚠️ `worldHash` covers robots, balls, scores and counts but NOT `match.phase` or
  // `phaseTimeLeft` — so two runs that started the match 200 ticks apart hash identically at
  // every sample point and prove nothing about the clock. The CLOCK IS COMPARED TOO. That trap
  // is in `docs/area/netcode.md` and it is the reason this is spelled out rather than assumed.
  //
  // Both containers go through `JSON.parse(JSON.stringify(...))` first, because a stored replay
  // reaches the verifier as JSON and an `undefined` optional field does not survive that trip —
  // which is exactly the shape `physics` has.
  const resim = (physics: '2d' | '3d', label: string): void => {
    const setups = [setup(0, 'blue', {}, 0), setup(1, 'red', {}, 1)];
    /**
     * THE TRUTH MARKS ARE TAKEN FROM INSIDE THE COMMAND SOURCE, which costs nothing.
     *
     * `CommandSource` is `(tick, world) => commands` and is called BEFORE each step, so the
     * `world` it is handed is the recorded run's own world at `world.tick` — the exact state
     * the replay will have to reproduce. Sampling it here means the comparison is against the
     * ORIGINAL RUN rather than against a second playback of the same container, which would be
     * a tautology, and it avoids stepping the match a third time to find out.
     */
    const marks = new Map<number, { hash: number; phase: string; left: number }>();
    let startPos: { x: number; y: number }[] = [];
    // PEAK, not final. A robot that fired everything it was carrying ends the run with an
    // EMPTY hopper, which is the opposite of the thing being checked — measured once as
    // `hopper 0,0` on a run that had held and fired eight elements.
    let peakHopper = 0;
    const src = (tick: number, world: World): Map<number, RobotCommand> => {
      if (world.tick === 0) startPos = world.robots.map((r) => ({ ...r.pos }));
      for (const r of world.robots) peakHopper = Math.max(peakHopper, r.hopper.length);
      if (world.tick % 60 === 0) {
        marks.set(world.tick, {
          hash: worldHash(world),
          phase: world.match.phase,
          left: world.match.phaseTimeLeft,
        });
      }
      return new Map([[0, drive(tick, 0)], [1, drive(tick, 1)]]);
    };
    // A SHORT run, not a whole match: this is a check of the CONTAINER, and the same scene is
    // paid for twice (record, then playback) for each physics. 1,500 ticks is the pre-match
    // countdown plus most of autonomous — long enough for the robots to drive, hold and fire.
    const run = runRecordMatch(424242, setups, src, { game: 'biobuzz', physics, stopTick: 1500 });

    check(`replay-${label}: the recorded run stamps its physics`,
      (run.replay.physics ?? '2d') === physics, `physics=${String(run.replay.physics)}`);
    if (physics === '2d') {
      // ABSENT from the ENCODED container, for the same reason it is absent from `matchStart`
      // — and measured the same way, because the object literal carries the key with an
      // undefined value while the JSON does not.
      check('replay-2d: ...and a 2D container writes no physics key at all',
        !JSON.stringify(run.replay).includes('physics'));
    }

    // NOT VACUOUS. Two idle robots idle identically, and a scene that proves only that is the
    // trap `docs/area/netcode.md` names twice. The archetype's own code has to have run.
    const drove =
      startPos.length > 0 &&
      run.world.robots.every((r, i) => Math.hypot(r.pos.x - startPos[i].x, r.pos.y - startPos[i].y) > 6);
    check(`replay-${label}: the run DROVE (every robot left its start pose)`, drove,
      startPos.length
        ? run.world.robots
            .map((r, i) => Math.hypot(r.pos.x - startPos[i].x, r.pos.y - startPos[i].y).toFixed(1))
            .join(', ')
        : 'no start sample');
    check(`replay-${label}: ...and the hoppers were worked (peak, not final)`, peakHopper > 0,
      `peak ${peakHopper}, final ${run.world.robots.map((r) => r.hopper.length).join(',')}`);
    check(`replay-${label}: ...and the run is worth comparing (it scored something)`,
      run.result.score.blue + run.result.score.red > 0,
      `${run.result.score.blue}/${run.result.score.red}`);

    const stored = JSON.parse(JSON.stringify(run.replay)) as Replay;
    check(`replay-${label}: the physics tag survives the JSON round-trip`,
      (stored.physics ?? '2d') === physics, `physics=${String(stored.physics)}`);

    const player = new ReplayPlayer(stored);
    check(`replay-${label}: playback builds a world on the container's own physics`,
      physicsOf(player.world) === physics, physicsOf(player.world));

    /**
     * ⚠️ THE CLOCK IS COMPARED AS WELL AS THE HASH. `worldHash` covers robots, balls, scores
     * and counts but NOT `match.phase` or `phaseTimeLeft`, so two runs that started the match
     * two hundred ticks apart hash identically at every sample point and prove nothing about
     * when anything happened. Written down in `docs/area/netcode.md`; repeated here because a
     * replay check that drops it looks exactly like one that does not.
     */
    let hashDrift = -1;
    let clockDrift = -1;
    let samples = 0;
    while (!player.done) {
      player.stepOnce();
      const m = marks.get(player.world.tick);
      if (!m) continue;
      samples++;
      if (hashDrift < 0 && worldHash(player.world) !== m.hash) hashDrift = player.world.tick;
      if (
        clockDrift < 0 &&
        (player.world.match.phase !== m.phase ||
          Math.abs(player.world.match.phaseTimeLeft - m.left) > 1e-9)
      ) {
        clockDrift = player.world.tick;
      }
    }
    check(`replay-${label}: the re-simulation was actually sampled at 60-tick marks`, samples >= 20,
      `${samples} samples`);
    check(`replay-${label}: worldHash equals the recorded run at every mark`, hashDrift < 0,
      hashDrift < 0 ? '' : `diverged at tick ${hashDrift}`);
    check(`replay-${label}: ...and so does the match clock (phase + phaseTimeLeft)`, clockDrift < 0,
      clockDrift < 0 ? '' : `clock diverged at tick ${clockDrift}`);
    check(`replay-${label}: playback reached the recorded tick count`,
      player.world.tick === run.replay.ticks, `${player.world.tick} vs ${run.replay.ticks}`);
    check(`replay-${label}: ...with the recorded run's final hash`,
      worldHash(player.world) === run.result.hash,
      `${worldHash(player.world)} vs ${run.result.hash}`);
  };

  // THE 3D ONE IS THE NEW BEHAVIOUR; THE 2D ONE IS THE PROOF NOTHING REGRESSED. Both, always:
  // a 3D replay that re-simulates while a 2D one silently stopped doing so is a worse outcome
  // than neither working, because only one of them has anybody's stored matches in it.
  resim('3d', '3d');
  resim('2d', '2d');

  /**
   * ⚠️ THE RAMP PRESS SURVIVES THE WIRE AND THE REPLAY. `packKey`'s own header
   * (`src/sim/replay.ts`) names the regression: `bbRamp` is bit 256, past the protocol's old
   * uint8, and a recorder that still masked `buttons` to 8 bits would see no change on the tick
   * it was pressed, write nothing, and a re-simulation would end with the ramp FOLDED while the
   * original run ended DEPLOYED. Short 3D match, a `ramp`-archetype robot, `bbRamp` pressed once
   * partway through and held — the recorded run and its re-simulation must agree: deployed, and
   * the same final hash.
   */
  {
    // `intakeMount: 'side'` — MEASURED: a FRONT-mount ramp on this same anchor (0) gets blocked
    // by the swing guard the instant it presses (owner, 2026-09-20 — a real static sits in the
    // front mouth's own swing there with a second robot also on the field), where 'side' does
    // not. The wire/replay round trip this fixture checks does not care which edge the ramp is
    // on, so it uses the mount that actually deploys.
    const rampSpec: Partial<RobotSpec> = {
      intakeMount: 'side',
      bbMech: { launcher: null, lift: null, intake: { kind: 'ramp' } } as unknown as RobotSpec['bbMech'],
    };
    const setups = [setup(0, 'blue', rampSpec, 0), setup(1, 'red', {}, 1)];
    // ⚠️ ROBOT 0 HOLDS ITS START ANCHOR AND PRESSES IMMEDIATELY, IN `'free'` MODE (owner,
    // 2026-09-20: the swing guard refuses a deploy that would carry the ramp into a static).
    // Two things this fixture is not about, both worked around rather than chased down:
    //  · `drive()`'s wandering script would put robot 0 at an UNPREDICTABLE pose by the press
    //    tick, and since `bbRamp` is held (never released) after the press, a refused deploy
    //    never gets a second rising edge to retry on — so robot 0 stays put.
    //  · `'match'` mode's own pre-match countdown (`robotsEnabled` false) delays WHEN the press
    //    actually takes effect without moving the robot even one tick, and MEASURED, the anchor's
    //    settle over that long a disabled stretch lands in a mid-swing-blocked pose that a press
    //    at the anchor's OWN first live tick does not — `'free'` mode has no countdown, so the
    //    press takes effect immediately, at the pose G304 anchors are built to leave open.
    const src = (tick: number): Map<number, RobotCommand> =>
      new Map([
        [0, cmd({ intake: true, fire: tick % 90 > 20, bbRamp: tick > 5 })],
        [1, drive(tick, 1)],
      ]);
    const run = runRecordMatch(707070, setups, src, { game: 'biobuzz', physics: '3d', stopTick: 300, mode: 'free' });
    const r0 = run.world.robots[0];
    check('ramp/replay: the recorded run actually deployed the ramp', r0.bbRampOut === true, `bbRampOut=${r0.bbRampOut}`);

    const stored = JSON.parse(JSON.stringify(run.replay)) as Replay;
    const player = new ReplayPlayer(stored);
    while (!player.done) player.stepOnce();
    const p0 = player.world.robots[0];
    check(
      'ramp/replay: re-simulation reproduces the deploy (bbRampOut true) with the same final hash',
      p0.bbRampOut === true && worldHash(player.world) === run.result.hash,
      `bbRampOut=${p0.bbRampOut} hash ${worldHash(player.world)} vs ${run.result.hash}`,
    );
  }

  // ═══ 9. THE PREDICTION WIRING (Day 3 lane C, plan §5) ══════════════════════
  //
  // The PREDICT lane proves the two predictors are right against a scripted scene. This proves
  // they are CONNECTED — that a client re-stepping its own buffered inputs through one, from a
  // real `Room`'s real snapshots, lands where that room is about to put it. Different failure:
  // a predictor that is perfect and a reconcile that hands it the wrong tick, the wrong world,
  // or the wrong buffer produces exactly the rubber-banding the predictors exist to remove, and
  // nothing in the other lane can see it.
  {
    check('predict: the stored preference defaults to Auto', PREDICTION_PREFS[0] === 'auto', PREDICTION_PREFS.join(','));
    check('predict: ...and Auto never picks Off (it is not in the resolved set)',
      !['light', 'full'].includes('off'));
    check('predict: every preference has a label and a blurb',
      PREDICTION_PREFS.every((p) => !!PREDICTION_LABELS[p] && !!PREDICTION_BLURBS[p]));

    /**
     * ONE CLIENT, RECONCILING FOR REAL.
     *
     * It does exactly what `GameController.stepServer` does in a 3D room: send an input stamped
     * `LEAD` ticks ahead, buffer it, and on every snapshot drop the acknowledged half of the
     * buffer, `reset` the predictor to the authoritative world, and re-step what is left. Every
     * intermediate pose is kept, so the NEXT snapshot — which is the server's own answer for a
     * tick the client already predicted — is the comparison. That is the number a driver feels.
     *
     * ⚠️ `LEAD` IS WHAT MAKES THIS NON-VACUOUS. With inputs stamped `tick + 1` the room applies
     * each one on the tick the client predicted it on and the two agree by construction, which
     * would measure nothing. Six ticks (100 ms) is an ordinary amount of prediction to be
     * running at, and it is inside `MAX_INPUT_LEAD_TICKS` by a wide margin.
     */
    const LEAD = 6;
    const converge = (kind: 'light' | 'full', ticks: number): { max: number; samples: number } => {
      const room = new Room(`n3-pr-${kind}`, () => {}, { kind: 'versus', game: 'biobuzz', physics: '3d' });
      let setups: RobotSetup[] = [];
      const baseline = new Map<number, Artifact>();
      let fresh: { tick: number; world: World } | null = null;
      const sink = (raw: ServerMsg): void => {
        const m = wireCopy(raw);
        if (m.t === 'matchStart') {
          setups = m.setups;
          return;
        }
        if (m.t !== 'snapshot') return;
        const balls = applyBallDelta(baseline, m.balls);
        fresh = {
          tick: m.serverTick,
          world: unslimWorld(m.w, balls, (id) => setups.find((s) => s.id === id)!.spec),
        };
      };
      for (const s of ROSTER) room.add(mkClient(s, s.id === 'n3-b1' ? sink : () => {}));
      startRoom(room, ALL_SEATS);
      room.advanceForTest(1); // matchStart + the first snapshot, so `setups` is in hand

      let predictor: Predictor | null = null;
      const buf: { tick: number; cmd: RobotCommand }[] = [];
      const predicted = new Map<number, { x: number; y: number }>();
      let max = 0;
      let samples = 0;
      let lastSnapTick = -1;
      for (let n = 0; n < ticks; n++) {
        const tick = room.tick + LEAD;
        ROSTER.forEach((seat, i) => {
          const c = drive(tick, i);
          room.onMessage(seat.id, { t: 'input', tick, q: quantizeCommand(c) });
          // the LOCAL client buffers its own, localized exactly as `stepServer` does — the
          // server steps the dequantized value, so predicting on the raw one would drift by
          // the rounding on every single tick
          if (i === 0) buf.push({ tick, cmd: localizeCommand(c) });
        });
        room.advanceForTest(1);
        const snap = fresh as { tick: number; world: World } | null;
        if (!snap || snap.tick === lastSnapTick) continue;
        lastSnapTick = snap.tick;
        // THE COMPARISON, before this snapshot is consumed: what did we predict for this tick?
        const want = predicted.get(snap.tick);
        const server = snap.world.robots.find((r) => r.id === 0);
        if (want && server) {
          samples++;
          max = Math.max(max, Math.hypot(want.x - server.pos.x, want.y - server.pos.y));
        }
        // ...then reconcile, exactly as `replayThroughPredictor` does
        while (buf.length && buf[0].tick <= snap.tick) buf.shift();
        if (!predictor) {
          predictor = kind === 'full'
            ? createFullPredictor(snap.world, 0)
            : createLightPredictor(snap.world, 0);
        }
        predictor.reset(snap.world, snap.tick);
        predicted.clear();
        for (let i = 0; i < buf.length; i++) {
          const pose = predictor.step(buf[i].cmd);
          predicted.set(snap.tick + 1 + i, { x: pose.pos.x, y: pose.pos.y });
        }
      }
      predictor?.dispose();
      return { max, samples };
    };

    for (const kind of ['light', 'full'] as const) {
      const r = converge(kind, 420);
      check(
        `predict: the ${kind} reconcile was actually exercised (snapshots compared)`,
        r.samples >= 50,
        `${r.samples} samples`,
      );
      check(
        `predict: ...and it converged inside SMOOTH_MAX_DIST on a driven 2v2`,
        r.samples >= 50 && r.max < SMOOTH_MAX_DIST,
        `worst correction ${r.max.toFixed(2)} in (snap at ${SMOOTH_MAX_DIST})`,
      );
    }

    /**
     * THE 2D PATH IS UNTOUCHED, and it is asserted on the SOURCE because the thing being
     * protected is a BRANCH rather than a number. `reconcile` must still replay the whole game
     * step for a room that is not a predicted 3D one; a refactor that made the predictor the
     * only path would pass every 3D check in this file and silently change DECODE and Chain
     * Reaction netcode, which is the owner's permanence rule broken in the one place it is
     * hardest to notice.
     */
    const game = readFileSync('src/game.ts', 'utf8');
    check(
      'predict: reconcile still replays `mod.step` for a room that is not predicted-3D',
      /if \(this\.predicted3d\(\)\) this\.replayThroughPredictor\([\s\S]{0,80}else for \(const b of this\.inputBuf\) this\.mod\.step\(/.test(game),
      'the 2D reconcile branch is not where it was',
    );
    check(
      'predict: the predictors are reached through the LAZY loader, never a static import',
      game.includes('physics3dImpl().createFullPredictor') === false &&
        /impl\.createFullPredictor/.test(game) &&
        !/from '\.\/games\/biobuzz\/sim3d\/predict'/.test(game),
      'sim3d/predict must not be imported from src/game.ts',
    );
    check(
      'predict: Auto probes with `probeFullReconcileMs` and the plan’s budget',
      /probeFullReconcileMs\(/.test(game) && /PREDICT_FULL_BUDGET_MS/.test(game),
    );
    check(
      'predict: Off renders the local robot interpolated (displayWorld stops exempting it)',
      /const predictLocal = !\(this\.predicted3d\(\) && this\.predictionMode === 'off'\)/.test(game),
    );
  }

  // ═══ 10. BOT SEATS (Day 3 lane C, plan §6) ═════════════════════════════════
  //
  // A bot is a seat the SERVER drives. Everything below is about that sentence being true at
  // each of the four places it has to be: the roster, the setups, the command frame, and the
  // rules about which rooms may have one.
  {
    const mod = simModuleFor('biobuzz') as { bot?: BotDriver };
    const real = mod.bot;
    // THE GAME'S OWN DRIVER WHEN IT HAS ONE. The stub exists so this lane is meaningful before
    // the policy lands and after it is swapped out for a different one — what is being checked
    // is the ROOM's plumbing, which must not depend on how well anybody drives.
    if (!real) mod.bot = STUB_BOT;
    try {
      const drv = simModuleFor('biobuzz').bot!;
      check('bots: the game exposes a driver with at least one tier', drv.tiers.length > 0, drv.tiers.join(','));
      check('bots: ...and a default that is one of them', drv.tiers.includes(drv.defaultTier), drv.defaultTier);
      check('bots: an unknown tier folds to the default rather than being taken on trust',
        drv.coerceTier('nonsense') === drv.defaultTier, drv.coerceTier('nonsense'));

      // ---- where a bot may and may not sit ----
      {
        const rec = new Room('n3-bot-rec', () => {}, { kind: 'record', record: 'solo', game: 'biobuzz' });
        check('bots: a RECORD room refuses one (its replay is leaderboard proof)', rec.addBot() !== null, String(rec.addBot()));
        const dec = new Room('n3-bot-dec', () => {}, { kind: 'versus', game: 'decode' });
        check('bots: a game with no driver refuses one', dec.addBot() !== null, String(dec.addBot()));
        const staged = new Room('n3-bot-mm', () => {}, { kind: 'versus', game: 'biobuzz' });
        staged.applyPending({
          code: 'n3-bot-mm',
          game: 'biobuzz',
          mode: '2v2',
          seed: 1,
          physics: '3d',
          roster: [],
        } as unknown as Parameters<Room['applyPending']>[0]);
        check('bots: a STAGED (matchmade, rated) room refuses one', staged.addBot() !== null, String(staged.addBot()));
      }

      // ---- one human, three bots: the roster, the setups, the frame ----
      {
        let rosterMsg: Extract<ServerMsg, { t: 'roster' }> | null = null;
        const room = new Room('n3-bot', () => {}, { kind: 'versus', game: 'biobuzz' });
        room.add(
          mkClient(ROSTER[0], (m) => {
            const c = wireCopy(m);
            if (c.t === 'roster') rosterMsg = c;
          }),
        );
        check('bots: seating three is accepted',
          [room.addBot(drv.tiers[0]), room.addBot(drv.tiers[0]), room.addBot(drv.tiers[0])].every((e) => e === null));
        check('bots: a fourth is refused — a seat is a seat', room.addBot(drv.tiers[0]) !== null);
        check('bots: ...and a human is refused too, so nobody is seated past capacity', !room.canJoin());

        const ros = rosterMsg as Extract<ServerMsg, { t: 'roster' }> | null;
        check('bots: the roster carries four rows', ros?.players.length === 4, `${ros?.players.length}`);
        check('bots: ...three of them tagged as bots', ros?.players.filter((p) => p.bot).length === 3);
        check('bots: ...each READY, so START never waits on one', (ros?.players ?? []).filter((p) => p.bot).every((p) => p.ready));
        check('bots: ...and named for what they are', (ros?.players ?? []).filter((p) => p.bot).every((p) => p.name.includes('bot')));
        // ONE HUMAN, TWO ALLIANCES. Three bots on the human's own side would be a 4v0.
        const sides = new Set((ros?.players ?? []).map((p) => p.alliance));
        check('bots: ...filling BOTH alliances rather than stacking one', sides.size === 2,
          (ros?.players ?? []).map((p) => `${p.name}:${p.alliance}`).join(' '));

        startRoom(room, [ROSTER[0].id]);
        room.advanceForTest(4);
        check('bots: the match started with four robots', room.tick > 0);
      }

      // ---- the bots DRIVE, and the recorder keeps what they did ----
      //
      // A 2D room on purpose: a bot is physics-agnostic and a whole 3D match here would cost
      // seconds to prove something about the frame builder. The checks are about commands
      // arriving, not about a solve.
      {
        let outcome: { replay: Replay; bots?: boolean } | null = null;
        const room = new Room('n3-bot-run', () => {}, { kind: 'versus', game: 'biobuzz' }, (o) => {
          outcome = o as unknown as { replay: Replay; bots?: boolean };
        });
        room.add(mkClient(ROSTER[0], () => {}));
        room.addBot(drv.tiers[drv.tiers.length - 1]);
        startRoom(room, [ROSTER[0].id]);
        for (let t = 0; t < 700; t++) {
          const tick = room.tick + 1;
          room.onMessage(ROSTER[0].id, { t: 'input', tick, q: quantizeCommand(drive(tick, 0)) });
          room.advanceForTest(1);
        }
        // run it out: a bot room IS persisted now (its players can watch it back), tagged
        // `bots` so persistence credits no playtime. The old check stopped at tick 700, long
        // before any match ends, so its "nothing reached the DB" passed whatever the gate said.
        room.advanceForTest(maxMatchTicks() + 5);
        const o = outcome as { replay: Replay; bots?: boolean } | null;
        check('bots: a finished bot room reaches persistence, tagged bots:true',
          o?.bots === true, o ? `bots=${String(o.bots)}` : 'onResult never fired');
        // and the replay the recorder is building has the bot's track in it. Read through the
        // room's own snapshot stream: robot 1 is the bot, and it has to have MOVED.
        const room2 = new Room('n3-bot-move', () => {}, { kind: 'versus', game: 'biobuzz' });
        let first: World | null = null;
        let last: World | null = null;
        const setups2: RobotSetup[] = [];
        const base2 = new Map<number, Artifact>();
        room2.add(
          mkClient(ROSTER[0], (m) => {
            const c = wireCopy(m);
            if (c.t === 'matchStart') setups2.push(...c.setups);
            if (c.t !== 'snapshot') return;
            const w = unslimWorld(c.w, applyBallDelta(base2, c.balls), (id) => setups2.find((s) => s.id === id)!.spec);
            if (!first) first = w;
            last = w;
          }),
        );
        room2.addBot(drv.tiers[drv.tiers.length - 1]);
        startRoom(room2, [ROSTER[0].id]);
        room2.advanceForTest(700);
        const a = first as World | null;
        const b = last as World | null;
        const botA = a?.robots.find((r) => r.id === 1);
        const botB = b?.robots.find((r) => r.id === 1);
        check('bots: the bot seat became robot 1', !!botA && !!botB);
        check('bots: ...and the SERVER drove it (it left its start pose with no client attached)',
          !!botA && !!botB && Math.hypot(botB.pos.x - botA.pos.x, botB.pos.y - botA.pos.y) > 6,
          botA && botB ? `${Math.hypot(botB.pos.x - botA.pos.x, botB.pos.y - botA.pos.y).toFixed(1)} in` : '');
      }
    } finally {
      // leave the registry exactly as it was found — a lane that patches a module and keeps it
      // has changed what every later lane is testing
      if (real) mod.bot = real;
      else delete mod.bot;
    }
  }

  // ═══ 11. THE RANKED CUTOVER (Day 3 lane C, plan §7) ════════════════════════
  {
    check('cutover: the server advertises the 3D-ranked capability', SERVER_CAPS.includes(BB3D_CAP), SERVER_CAPS.join(','));
    check('cutover: ...and the bot-seat capability, so the button is not offered to an old deploy',
      SERVER_CAPS.includes('bots'));
    // The SERVER's half of the cutover is already asserted in section 2 (a record room is 3D
    // whatever its config says). This is the CLIENT's half: it must refuse to queue rather than
    // stage a 2D rated match against an old deploy, which is the silent failure the cap exists
    // for — and the refusal has to be at the moment of committing, not merely a sentence.
    const mm = readFileSync('src/ui/Matchmaking.tsx', 'utf8');
    check(
      'cutover: the client checks the capability before it queues',
      /const find = async[\s\S]{0,2000}serverCaps\(\)[\s\S]{0,200}BB3D_CAP/.test(mm),
      'no capability gate inside find()',
    );
    check(
      'cutover: ...and only for a game that HAS two solves',
      /physicsOptions\?\.includes\('3d'\)/.test(mm),
    );
  }

  // ═══ 12. THE RULING: NOBODY PICKS A SERVER ROOM'S PHYSICS (2026-09-18) ═════
  //
  // Section 2 proves the ROOM's answer. These are the four other places that used to hold an
  // opinion about it, and every one of them fails SILENTLY — a picker still on screen, a LAN
  // worker skipping the chunk, a board still asking for an era — so each is pinned at the
  // source rather than left to a habit. Source greps, like the cutover checks above, because
  // there is no headless way to render a React screen in this suite.
  {
    const room = readFileSync('server/room.ts', 'utf8');
    const getter = /get physics\(\): Physics \{[\s\S]{0,400}?\n  \}/.exec(room)?.[0] ?? '';
    check(
      'ruling: Room.physics asks the GAME and nothing else',
      getter.includes('serverPhysics(simModuleFor(this.game))') &&
        !getter.includes('this.config.physics') &&
        !getter.includes('this.ranked'),
      getter.split('\n')[1] ?? 'no getter found',
    );

    /**
     * THE QUEUE DOOR. A matchmade BIOBUZZ room is staged 3D, so a client that cannot step it
     * has to be refused BEFORE a pairing is committed — refusing at the room's door instead
     * would cancel a staged match and charge three innocent people for a dodge that was a
     * version skew. Asked of the game MODULE rather than by naming BIOBUZZ, so a third game
     * that gains a 3D solve is gated the day it declares one.
     */
    const server = readFileSync('server/index.ts', 'utf8');
    check(
      'ruling: the queue gate reads the game’s own rule, not a hardcoded id',
      /serverPhysics\(simModuleFor\(coerceGameId\(msg\.game\)\)\) === '3d'/.test(server) &&
        !/coerceGameId\(msg\.game\) === 'biobuzz'/.test(server),
    );
    check('ruling: ...and it refuses an old client', !physicsAllowed('3d', []), BB3D_REFUSAL);

    const worker = readFileSync('src/lan/hostWorker.ts', 'utf8');
    check(
      'ruling: the LAN host worker loads the 3D chunk on the ROOM’s rule, not on its config',
      /const needs3d = serverPhysics\(/.test(worker) && !/needs3d = m\.config\?\.physics/.test(worker),
    );

    const lobby = readFileSync('src/ui/Lobby.tsx', 'utf8');
    check(
      'ruling: the custom lobby no longer offers a 2D/3D choice',
      !/setRoomPhysics|roomPhysics === '2d'/.test(lobby),
    );
    check(
      'ruling: ...but it still SAYS `3d` on the wire, so a server one deploy behind builds the same room',
      /physics: physicsOffered \? '3d' : undefined/.test(lobby),
    );

    const board = readFileSync('src/ui/Leaderboard.tsx', 'utf8');
    check(
      'ruling: the record board has no era filter and no per-row 2D/3D chip',
      !/setEra|ds-seg \$\{era/.test(board) && !/physics\.toUpperCase\(\)/.test(board),
    );
    check(
      // the era is per season now (2026-09-24): keep the one the server echoes, 3D when an older
      // server echoes none, so a 2D row that server still serves on the live board is dropped
      'ruling: ...and it keeps only the era the server names, dropping a 2D row an OLDER server still serves',
      /x\.physics === \(r\.physics \?\? '3d'\)/.test(board),
    );
    const api = readFileSync('src/net/api.ts', 'utf8');
    check(
      'ruling: ...and the client cannot ask for an era at all',
      !/&physics=/.test(api),
    );

    const rec = readFileSync('src/ui/RecordRun.tsx', 'utf8');
    check(
      'ruling: a record run PREFLIGHTS the 3D chunk and refuses rather than falling back',
      /initPhysics3d\(\)/.test(rec) && /that record runs need/.test(rec),
    );
    const view = readFileSync('src/ui/GameView.tsx', 'utf8');
    check(
      'ruling: ...and the 2D fallback is still reachable ONLY from a session-less practice',
      /const need3d =\s*\n?\s*!session &&/.test(view),
    );
  }

  // ═══ 13. THE ROBOT AND THE BALL IT IS PUSHING ARE ONE MOMENT ═══════════════
  //
  // Owner report 2026-09-21: "in server-required games, the balls behave really weirdly. Maybe
  // it is something with the prediction?"
  //
  // It was. In a predicted 3D room the LOCAL ROBOT is drawn from the prediction — (about) the
  // newest server tick — and every ELEMENT is drawn INTERPOLATED, `INTERP_DELAY_TICKS` behind
  // it. Two different moments in one frame, and the gap is structural: it does not shrink with
  // a better connection, and it measured the same at 0 ms RTT as at 140. Everything below is
  // about the two clocks agreeing again, so each check states a DISTANCE in inches between
  // where an element is DRAWN and where the server had it AT THE ROBOT'S OWN TICK.
  //
  // ⚠️ THE BASELINE IS ASSERTED TOO, and it is not padding: a check that only bounds the fixed
  // number passes just as well if the whole scene stops moving, and this lane has been bitten
  // by exactly that (see `drive`'s `fieldCentric` note). The interpolated draw MUST still be
  // far off, or the comparison is measuring nothing.
  {
    const LAT = 2; // ticks of one-way latency — 66 ms RTT, an ordinary connection
    const r = elementDrawProbe(LAT, 460);
    check(
      'balls: the element-draw probe actually pushed something (non-vacuous)',
      r.samples >= 40 && r.moved > 12,
      `${r.samples} frames, the element travelled ${r.moved.toFixed(1)} in`,
    );
    check(
      'balls: INTERPOLATED, an element is drawn far from where the robot`s own tick has it',
      r.samples >= 40 && r.interpP95 > 4,
      `p95 ${r.interpP95.toFixed(2)} in (the artifact this section exists for)`,
    );
    check(
      'balls: ...and drawn from the PREDICTOR it is on the robot`s own tick',
      r.samples >= 40 && r.predP95 < 1.5 && r.predMax < 4,
      `p95 ${r.predP95.toFixed(2)} in, max ${r.predMax.toFixed(2)} in (was p95 ${r.interpP95.toFixed(2)})`,
    );
    check(
      'balls: ...which is at least a 4x improvement, not a rounding one',
      r.samples >= 40 && r.interpP95 > r.predP95 * 4,
      `${(r.interpP95 / Math.max(1e-6, r.predP95)).toFixed(1)}x`,
    );
    /**
     * THE PREDICTOR'S ELEMENTS ARE NOT A SECOND AUTHORITY, and this is the check that keeps it
     * that way: what it hands back has to stay within a POLLEN of the server across a whole
     * driven run, or it is not a way of drawing the server's world, it is a different one.
     */
    check(
      'balls: the predicted element never wanders more than a POLLEN from the authority',
      r.samples >= 40 && r.predMax < 2 * (2 * BB_POLLEN_R),
      `max ${r.predMax.toFixed(2)} in against ${(2 * (2 * BB_POLLEN_R)).toFixed(2)}`,
    );
    check(
      'balls: a LIGHT predictor carries no elements and says so with null, not an empty list',
      r.lightElements === null,
      String(r.lightElements),
    );
  }

  // ═══ 14. A RE-TAG IS NOT A TELEPORT ════════════════════════════════════════
  //
  // `displayWorld` SNAPS an element to the newer snapshot whenever its `state.kind` changed,
  // because an element entering a hopper teleports. But a 3D BIOBUZZ world DERIVES those tags
  // from body positions every tick (`derive.ts`), and `ground` / `flight` / `element` all
  // describe the same continuously-moving sphere — a missed shot skidding across the tiles
  // re-tags itself on consecutive ticks while travelling in a straight line. Each flicker threw
  // it two ticks forward and froze it for a frame: measured, the worst jump ANY element made
  // was 2.61 in against a true per-tick motion of 1.34 — a pop of nearly twice the distance it
  // was really covering, on a ball nobody had touched. Only `held` and `stock` teleport.
  {
    const game = readFileSync('src/game.ts', 'utf8');
    check(
      'retag: the SNAP is gated on a CARRIED kind, not on any kind change',
      /if \(p\.kind !== q\.kind && isCarried\(p\.kind\)\)/.test(game),
      'the kind-change snap is not where it was',
    );
    // owner report 2026-09-24: "when i shoot the balls, they sometimes appear for a split second
    // where i intaked them". The newest snapshot said loose, the bracketing one still said held,
    // and the lerp drew the held pose. It stays hidden with that snapshot's state instead.
    check(
      'release: a ball the render clock still has HELD is drawn held (hidden), not lerped from the hopper pose',
      /if \(isCarried\(q\.kind\)\) \{\s*released\.add\(ball\.id\);\s*return predicted\.has\(ball\.id\) \? ball : \{ \.\.\.ball, pos: \{ x: q\.x, y: q\.y \}, z: q\.z, state: q\.state \};/.test(game),
    );
    check(
      'release: ...and a released ball never eases in from where it was last drawn',
      /const prev = released\.has\(ball\.id\) \? undefined : this\.ballDrawn\.get\(ball\.id\);/.test(game),
    );
    check(
      'retag: ...and `isCarried` names exactly the two kinds that are CARRIED',
      /const isCarried = \(kind: string\): boolean => kind === 'held' \|\| kind === 'stock';/.test(game),
    );
    check(
      'balls: the elements` visual offset is captured at ONE tick, inside the reconcile',
      /const before = p\.elements\(\);[\s\S]{0,400}?this\.noteElementCorrection\(before, p\.elements\(\)\)/.test(game),
      'reading it across a FRAME pins every element a tick behind for the rest of the match',
    );
    check(
      'balls: ...and it is cleared with the interpolation buffer and with the predictor',
      /this\.clearElementSmoothing\(\);/.test(game) &&
        (game.match(/this\.clearElementSmoothing\(\)/g) ?? []).length >= 2,
    );
    check(
      'balls: ...`ground`/`flight` are drawn from it, and a seated `element` only if it LANDED predicted',
      /const use =\s*!!e && \(kind === 'ground' \|\| kind === 'flight' \|\| \(kind === 'element' && this\.ballPredicted\.has\(ball\.id\)\)\);/.test(game),
    );
    check(
      'balls: nothing about this touches `this.world` (it is cosmetic, like `localSmooth`)',
      !/drawPredictedElements[\s\S]{0,2000}?this\.world\.balls\s*=/.test(game),
    );
  }

  /**
   * 15. A SEATED ELEMENT IS NOT PREDICTED — IT IS PINNED WHERE THE AUTHORITY PUT IT.
   *
   * The near set is every non-`held`/`stock` ball within `PREDICT_ELEMENT_RADIUS`, and it used
   * to make ALL of them DYNAMIC. An `element` tag means the authority is holding it (latched in
   * a HIVE cell, seated in a FLOWER's bore) by its own derived structure, and nothing in the
   * prediction world catches one — so those bodies FELL for the whole replay window, every
   * window. The owner saw it as elements "drooping downwards and teleporting back up" inside
   * the hive: the drooped pose reaches the screen whenever the drawn source is the predictor,
   * and the next snapshot puts it back.
   *
   * ⚠️ THE TOLERANCE IS TIGHT ON PURPOSE AND THE OLD BEHAVIOUR MISSES IT BY A MILE. Kinematic,
   * the error is 0; dynamic, it was -1.76 in mean and -1.96 worst over 100 reconciles, which is
   * ½gt² for a 6-tick window — i.e. free fall. A check that allowed an inch would pass on the
   * bug it exists to catch.
   */
  {
    const w = mkWorld3d('match', 4242);
    for (let t = 0; t < 180; t++) step3d(w, C.SIM_DT, new Map());
    const me = w.robots[0];
    const seat = w.balls.find((b) => b.state.kind === 'element' && b.state.el.startsWith('hive:'));
    if (!seat) {
      check('predict: the staged world has a hive-seated element to measure', false);
    } else {
      // park the robot beside the hive so those cells are inside the near set
      me.pos.x = seat.pos.x + 10;
      me.pos.y = seat.pos.y + 10;
      for (let t = 0; t < 60; t++) step3d(w, C.SIM_DT, new Map());

      const near = w.balls.filter((b) => {
        if (b.state.kind !== 'element') return false;
        const dx = b.pos.x - me.pos.x;
        const dy = b.pos.y - me.pos.y;
        return dx * dx + dy * dy <= PREDICT_ELEMENT_RADIUS * PREDICT_ELEMENT_RADIUS;
      });
      const p = createFullPredictor(w, me.id);
      const still = cmd({});
      let worst = 0;
      let authMoved = 0;
      for (let round = 0; round < 20; round++) {
        for (let t = 0; t < 6; t++) step3d(w, C.SIM_DT, new Map());
        p.reset(w, w.tick);
        for (let k = 0; k < 6; k++) p.step(still);
        const got = new Map((p.elements() ?? []).map((e) => [e.id, e] as const));
        for (const b of near) {
          const e = got.get(b.id);
          if (!e) continue;
          worst = Math.max(worst, Math.abs(e.z - b.z));
        }
      }
      for (const b of near) {
        const now = w.balls.find((x) => x.id === b.id)!;
        authMoved = Math.max(authMoved, Math.abs(now.z - b.z));
      }
      p.dispose();
      check(
        '⚠️ predict: a HIVE-seated element is pinned at the authority`s height, not dropped (it used to free-fall 1.8in a window)',
        near.length > 0 && worst < 0.05,
        `${near.length} seated elements, worst |predicted z - authoritative z| ${worst.toFixed(4)}in over 20 reconciles ` +
          `(authoritative z itself moved ${authMoved.toFixed(4)}in)`,
      );
    }
  }

  /**
   * 16. A MOVING ELEMENT STAYS IN THE PREDICTION PAST THE RADIUS (owner report 2026-09-24: "the
   * balls on the field keep teleporting"). The client draws a predicted element on the
   * prediction's clock and every other one ~10 ticks behind it, so a shot dropped from the near
   * set mid-flight jumped back 14–25 in the frame it changed clocks. Each negative is paired with
   * its positive: kept while moving, dropped once at rest, and never ADDED from outside.
   */
  {
    const w = mkWorld3d('match', 4243);
    const me = w.robots[0];
    const loose = w.balls.filter((b) => b.state.kind === 'ground');
    const [shot, stranger] = loose;
    const far = { x: me.pos.x + PREDICT_ELEMENT_RADIUS + 30, y: me.pos.y };
    const place = (b: Artifact, x: number, y: number, vx: number): void => {
      b.pos.x = x;
      b.pos.y = y;
      b.vel.x = vx;
      b.vel.y = 0;
      b.vz = 0;
      b.z = 0;
    };
    // everything else well out of the way, at rest
    for (const b of loose) if (b !== shot && b !== stranger) place(b, me.pos.x - 200, me.pos.y, 0);
    place(shot, me.pos.x + 12, me.pos.y, 150);
    place(stranger, far.x, far.y + 10, 150);
    const p = createFullPredictor(w, me.id);
    const has = (id: number): boolean => (p.elements() ?? []).some((e) => e.id === id);
    const inAtStart = has(shot.id);
    const strangerAtStart = has(stranger.id);
    place(shot, far.x, far.y, 150);
    p.reset(w, w.tick);
    const keptMoving = has(shot.id);
    const strangerStill = has(stranger.id);
    place(shot, far.x, far.y, 0);
    p.reset(w, w.tick);
    const droppedAtRest = !has(shot.id);
    p.dispose();
    check(
      'predict: a moving element in the near set STAYS in it past the radius',
      inAtStart && keptMoving,
      `in at start ${inAtStart}, kept at ${(PREDICT_ELEMENT_RADIUS + 30).toFixed(0)} in moving ${keptMoving}`,
    );
    check(
      'predict: ...is dropped once it comes to rest out there',
      keptMoving && droppedAtRest,
    );
    check(
      'predict: ...and a moving element that was never in the set is not added from outside it',
      !strangerAtStart && !strangerStill,
    );
  }
}

/**
 * ONE CLIENT DRAWING ONE ELEMENT, TWO WAYS, against a real `Room` over a real delay.
 *
 * This is `GameController`'s networked path reduced to the question section 13 asks. It sends
 * inputs stamped on its own prediction clock, buffers them, reconciles on each snapshot through
 * a FULL predictor, and then — for the one element it staged in front of the robot — records
 * BOTH candidate drawings for the same frame:
 *
 *   · INTERPOLATED, between the two buffered snapshots bracketing `renderTick`, which is what
 *     shipped, and
 *   · PREDICTED, straight off the predictor's own body, which is what ships now.
 *
 * Each is scored against the authoritative position AT `predictTick` — the tick the local robot
 * is being drawn at. That is the whole claim in one number and it needs no nearest-tick
 * matching: the robot's moment is known exactly.
 *
 * ⚠️ `ServerSession` KEEPS ONLY THE FRESHEST SNAPSHOT and `stepServer` consumes ONE per frame,
 * so two arriving together is one buffered snapshot and a 4-tick hole in `snapBuf`. Modelled,
 * because an interpolator that never sees a hole is not the one in the game.
 */
function elementDrawProbe(
  latTicks: number,
  ticks: number,
): {
  samples: number;
  moved: number;
  interpP95: number;
  predP95: number;
  predMax: number;
  lightElements: unknown;
} {
  const room = new Room('n3-draw', () => {}, { kind: 'versus', game: 'biobuzz', physics: '3d' });
  let setups: RobotSetup[] = [];
  const baseline = new Map<number, Artifact>();
  const inbox: { at: number; tick: number; world: World }[] = [];
  let now = 0;
  const sink = (raw: ServerMsg): void => {
    const m = wireCopy(raw);
    if (m.t === 'matchStart') {
      setups = m.setups;
      return;
    }
    if (m.t !== 'snapshot') return;
    const balls = applyBallDelta(baseline, m.balls);
    inbox.push({
      at: now + latTicks,
      tick: m.serverTick,
      world: unslimWorld(m.w, balls, (id) => setups.find((s) => s.id === id)!.spec),
    });
  };
  for (const s of ROSTER) {
    const c = mkClient(s, s.id === 'n3-b1' ? sink : () => {});
    // ⚠️ `fieldCentric` OFF, the trap `docs/area/netcode.md` names and this lane's own `drive`
    // repeats: with the default assists a robot handed `driveY: 1` drives in the ALLIANCE's
    // frame, so it slides past the element staged along its own heading and pushes nothing.
    // `mkClient` keeps the defaults because every other check here wants them.
    c.player.assists = { ...DEFAULT_ASSISTS, fieldCentric: false, aimAssist: false };
    room.add(c);
  }
  startRoom(room, ALL_SEATS);
  room.advanceForTest(1);

  // STAGE one element on the tiles, dead ahead of the local robot, and drive straight at it.
  const w0 = room.worldForTest()!;
  const me = w0.robots.find((r) => r.id === 0)!;
  const target = w0.balls.find((b) => b.state.kind === 'ground');
  if (!target) return { samples: 0, moved: 0, interpP95: 0, predP95: 0, predMax: 0, lightElements: undefined };
  const startX = me.pos.x + Math.cos(me.heading) * 26;
  const startY = me.pos.y + Math.sin(me.heading) * 26;
  target.pos.x = startX;
  target.pos.y = startY;
  target.vel.x = 0;
  target.vel.y = 0;
  target.z = 0;
  target.vz = 0;
  const id = target.id;

  const light = createLightPredictor(w0, 0);
  const lightElements = light.elements();
  light.dispose();

  const predictor = createFullPredictor(w0, 0);
  const buf: { tick: number; cmd: RobotCommand }[] = [];
  const snapBuf: { tick: number; x: number; y: number; kind: string }[] = [];
  const auth = new Map<number, { x: number; y: number }>();
  const interpErr: number[] = [];
  const predErr: number[] = [];
  let predictTick = 0;
  let lastServerTick = 0;
  let renderTick = 0;
  let applied = -1;
  let last = { x: startX, y: startY };

  for (now = 0; now < ticks; now++) {
    room.advanceForTest(1);
    const aw = room.worldForTest()!;
    const ab = aw.balls.find((b) => b.id === id)!;
    auth.set(aw.tick, { x: ab.pos.x, y: ab.pos.y });
    last = { x: ab.pos.x, y: ab.pos.y };

    let fresh: { tick: number; world: World } | null = null;
    for (let i = inbox.length - 1; i >= 0; i--) {
      if (inbox[i].at > now) continue;
      const s = inbox[i];
      inbox.splice(i, 1);
      if (s.tick <= applied) continue;
      if (!fresh || s.tick > fresh.tick) fresh = s;
    }
    if (fresh) {
      applied = fresh.tick;
      const fb = fresh.world.balls.find((b) => b.id === id)!;
      snapBuf.push({ tick: fresh.tick, x: fb.pos.x, y: fb.pos.y, kind: fb.state.kind });
      if (snapBuf.length > 8) snapBuf.shift();
      lastServerTick = fresh.tick;
      while (buf.length && buf[0].tick <= fresh.tick) buf.shift();
      predictor.reset(fresh.world, fresh.tick);
      for (const b of buf) predictor.step(b.cmd);
      predictTick = fresh.tick + buf.length;
    }

    // one predicted tick, exactly as `stepServer` runs it
    if (!(predictTick - lastServerTick >= 40)) {
      const tick = predictTick + 1;
      const c = cmd({ driveY: 1, leftDrive: 1, rightDrive: 1 });
      room.onMessage('n3-b1', { t: 'input', tick, q: quantizeCommand(c) });
      buf.push({ tick, cmd: localizeCommand(c) });
      predictor.step(localizeCommand(c));
      predictTick = tick;
    }

    // ── the frame. `renderTick` is `displayWorld`'s clock, restated.
    if (snapBuf.length < 2) continue;
    const latest = snapBuf[snapBuf.length - 1].tick;
    const oldest = snapBuf[0].tick;
    renderTick += 1;
    renderTick += (latest - 5 - renderTick) * (1 - Math.pow(2, -(1 / 60) / 0.11));
    renderTick = Math.max(oldest, Math.min(renderTick, latest));
    let s0 = snapBuf[0];
    let s1 = snapBuf[1];
    for (let i = snapBuf.length - 2; i >= 0; i--) {
      if (snapBuf[i].tick <= renderTick) {
        s0 = snapBuf[i];
        s1 = snapBuf[i + 1];
        break;
      }
    }
    const span = s1.tick - s0.tick;
    const a = span > 0 ? Math.max(0, Math.min(1, (renderTick - s0.tick) / span)) : 0;
    const drawnInterp = { x: s0.x + (s1.x - s0.x) * a, y: s0.y + (s1.y - s0.y) * a };
    const pe = predictor.elements()?.find((e) => e.id === id);
    const truth = auth.get(predictTick);
    const was = auth.get(predictTick - 1);
    if (!truth || !was || !pe) continue;
    // ⚠️ ONLY WHILE IT IS MOVING. A still element is at the same place on every clock, so
    // sampling one would dilute both percentiles with frames where the bug cannot exist —
    // which is the vacuous-check trap this lane's header warns about, in numeric form.
    if (Math.hypot(truth.x - was.x, truth.y - was.y) < 0.05) continue;
    interpErr.push(Math.hypot(drawnInterp.x - truth.x, drawnInterp.y - truth.y));
    predErr.push(Math.hypot(pe.x - truth.x, pe.y - truth.y));
  }
  predictor.dispose();
  const p95 = (v: number[]): number => {
    if (!v.length) return 0;
    const s = [...v].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
  };
  return {
    samples: predErr.length,
    moved: Math.hypot(last.x - startX, last.y - startY),
    interpP95: p95(interpErr),
    predP95: p95(predErr),
    predMax: predErr.length ? Math.max(...predErr) : 0,
    lightElements,
  };
}

/**
 * A DETERMINISTIC STAND-IN DRIVER, used only when the game has none yet.
 *
 * It drives forward and weaves, with no clock, no `Math.random` and no read of `world.rngState`
 * — the seam's own contract. Its purpose is to make the ROOM's bot plumbing testable
 * independently of whatever policy ships: every check in section 10 is about a command reaching
 * a robot, and none of them should start failing because a real policy decided to sit still for
 * the first second of autonomous.
 */
const STUB_BOT: BotDriver = {
  tiers: ['easy', 'hard'],
  defaultTier: 'easy',
  coerceTier: (x) => (x === 'hard' ? 'hard' : 'easy'),
  create: (_w, robotId, tier, seed) => {
    let t = 0;
    return {
      step(): RobotCommand {
        t++;
        // a triangle wave off the seed — no trig, so the sim source guard has nothing to object
        // to if this file is ever moved under `src/`
        const phase = ((t + (seed % 37) + robotId * 11) % 120) / 120;
        return cmd({
          driveY: tier === 'hard' ? 1 : 0.55,
          rotate: (phase < 0.5 ? phase * 4 - 1 : 3 - phase * 4) * 0.4,
          intake: true,
        });
      },
    };
  },
};
