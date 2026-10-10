/**
 * ROOM WORKERS — `npm run test:workers` (`SIM_WORKERS`, server/roomHost.ts).
 *
 * Two halves, because the change has two halves:
 *
 *  A. THE POOL, IN THIS PROCESS. `server/roomHost.ts` driven directly with fake sockets, for the
 *     things no client can make happen on purpose: a worker dying under a live room, a socket
 *     whose send queue stops draining, a room being forgotten by its worker once nothing can
 *     reach it, and the two answers the socket thread awaits (`reattach`, the report resolvers).
 *
 *  B. THE REAL SERVER, TWICE. `server/index.ts` booted as a child process with `SIM_WORKERS=0`
 *     (every room in-process, the server as it was) and with `SIM_WORKERS=2`, and the SAME
 *     scenarios run against both over real WebSockets: a custom 1v1 from lobby to match, a
 *     spectator, a refused joiner, reports, a dropped socket reclaiming its seat, a lobby that
 *     empties, and a BIOBUZZ 3D record run. Every check has to pass on both, so the worker path
 *     is held to the behaviour of the in-process one rather than to a description of it. Both run
 *     as the alpha deployment (`SERVER_CHANNEL=alpha`, where imported robots ship); a third, with
 *     no channel, is production's import gate (`closedGate`).
 *
 * Kept out of `npm test` for the same reason `test:mm` is: a red `npm test` must keep meaning
 * "physics broke", and this boots two servers and four worker threads.
 */
import { coerceRoomSettings } from '../src/net/protocol';
import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import {
  CLIENT_CAPS,
  quantizeCommand,
  type ClientMsg,
  type LobbyPlayer,
  type RoomConfig,
  type ServerMsg,
} from '../src/net/protocol';
import { DEFAULT_ASSISTS, DEFAULT_SPEC } from '../src/sim/spawn';
import { IMPORT_ID_TAKEN, IMPORT_MEMBER_NEEDS_UPDATE, IMPORT_REFUSED_HERE, IMPORT_REFUSED_RANKED, IMPORT_ROOM_NEEDS_UPDATE, ROBOT_IMPORT_CAP } from '../src/net/imported';
import * as IV from '../src/net/importVisuals';
import { visualBytesInUse } from '../server/importVisuals';
import { IMPORTS_OPEN_HERE } from '../server/channel';
import { glbBytes, pngBytes } from './visualFixtures';
import type { Alliance, RobotCommand } from '../src/types';
import type { Client } from '../server/room';
import {
  createRoom,
  killWorkerForTest,
  registerSocket,
  startRoomWorkers,
  workerOfForTest,
  workerPerf,
  type RoomHandle,
} from '../server/roomHost';

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms: number, step = 20): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(step);
  }
  return pred();
}

function makePlayer(name: string, alliance: Alliance, startIndex: number): Omit<LobbyPlayer, 'clientId'> {
  return {
    name,
    teamName: 'Workers',
    teamNumber: 36596,
    alliance,
    startIndex,
    ready: true,
    spec: { ...DEFAULT_SPEC, name },
    assists: { ...DEFAULT_ASSISTS },
  };
}

/** a minimal imported-robot descriptor — the wire only needs it to be present */
const IMP = {
  v: 1,
  id: '0123456789abcdef',
  heightIn: 12,
  hull: [{ x: -8, y: -8 }, { x: 8, y: -8 }, { x: 8, y: 8 }, { x: -8, y: 8 }],
};

/** a full-throw stick whose direction turns slowly. A straight one pins a DECODE start pose
 *  against its wall (0.1 in on BOTH servers), and one that wanders in magnitude can sit near
 *  zero for the whole window (2.2 in, again on both) — either way the check measures nothing. */
function wander(tSec: number): RobotCommand {
  const a = tSec * 1.1;
  return { driveX: Math.cos(a), driveY: Math.sin(a), rotate: 0, leftDrive: 1, rightDrive: Math.cos(a), intake: false, fire: false };
}

// =============================================================================================
// A. the pool, in this process
// =============================================================================================

/** a socket the pool can write to, that records what it was sent */
function fakeSocket(): {
  send: (m: ServerMsg) => void;
  frames: string[];
  msgs: (t?: string) => ServerMsg[];
  setBacklog: (b: number) => void;
  closedWith: () => number | null;
} {
  const frames: string[] = [];
  let backlog = 0;
  let closed: number | null = null;
  // only the KEY: a room on a worker encodes on the worker and writes through `write`
  const send = (m: ServerMsg): void => void frames.push(JSON.stringify(m));
  registerSocket(send, {
    write: (s) => void frames.push(s),
    backlog: () => backlog,
    close: (code) => {
      closed = code;
    },
  });
  return {
    send,
    frames,
    msgs: (t) => frames.map((f) => JSON.parse(f) as ServerMsg).filter((m) => !t || m.t === t),
    setBacklog: (b) => {
      backlog = b;
    },
    closedWith: () => closed,
  };
}

function clientOn(sock: ReturnType<typeof fakeSocket>, id: string, userId: string, alliance: Alliance, startIndex = 0): Client {
  return {
    id,
    send: sock.send,
    player: { ...makePlayer(id, alliance, startIndex), clientId: id },
    connected: true,
    disconnectAt: 0,
    userId,
    caps: CLIENT_CAPS,
  };
}

const snaps = (s: ReturnType<typeof fakeSocket>): Extract<ServerMsg, { t: 'snapshot' }>[] =>
  s.msgs('snapshot') as Extract<ServerMsg, { t: 'snapshot' }>[];

/** drive one client of an in-process-API room at ~60 Hz off its own snapshots */
function driver(room: RoomHandle, id: string, sock: ReturnType<typeof fakeSocket>, gen: number): () => void {
  let tick = 0;
  const t0 = performance.now();
  const t = setInterval(() => {
    const last = snaps(sock).at(-1);
    tick = Math.max(tick + 1, (last?.serverTick ?? 0) + 1);
    const q = quantizeCommand(wander((performance.now() - t0) / 1000));
    room.onMessage(id, { t: 'input', tick, q, ack: last?.serverTick ?? 0, gen });
  }, 16);
  return () => clearInterval(t);
}

async function partA(): Promise<void> {
  console.log('\n== A. the pool, in this process ==');
  // ⚠️ THE WORKERS' ENV SAYS THE OPPOSITE OF THIS THREAD'S IMPORT GATE (read when `channel.ts`
  // loaded). A worker copies the env when it spawns, so a worker room that read its own would
  // disagree with `RemoteRoom.importState()`; the "imports across the thread" checks catch that.
  if (IMPORTS_OPEN_HERE) {
    delete process.env.ROBOT_IMPORT;
    process.env.SERVER_CHANNEL = 'stable';
  } else process.env.ROBOT_IMPORT = '1';
  check('A: SIM_WORKERS=2 starts two workers', startRoomWorkers(2) === 2);
  const ready = await until(() => (workerPerf() ?? []).every((w) => w.ready), 30_000);
  check('A: both workers load both physics backends', ready);

  // ---- a solo record run on a worker --------------------------------------------------------
  const events: string[] = [];
  let emptied = 0;
  const solo = createRoom(
    'wt-solo',
    () => {
      emptied++;
    },
    { kind: 'record', record: 'solo', game: 'decode' },
    undefined,
    (uid) => events.push(`on:${uid}`),
    (uid) => events.push(`off:${uid}`),
  );
  check('A: a new room lands on a worker', workerOfForTest(solo) >= 0);
  const s1 = fakeSocket();
  const c1 = clientOn(s1, 'a1', 'u-a', 'blue');
  solo.add(c1);
  check('A: add hands index.ts a socket key as its conn', typeof c1.conn === 'number' && c1.conn > 0);
  // before the worker has said anything: the add in flight must already count
  check('A: an add in flight is a seat (seatFor)', solo.seatFor('u-a') === 'a1');
  check('A: an add in flight fills a one-seat room (canJoin)', !solo.canJoin());
  check('A: a room with an add in flight is not abandonable', !solo.isAbandonable());
  const welcomed = await until(() => s1.msgs('welcome').length > 0, 5000);
  check('A: the worker room welcomes the client through the socket thread', welcomed);
  await until(() => solo.lobbySummary().players === 1, 2000);
  check('A: the mirror catches up (lobby players 1)', solo.lobbySummary().players === 1);
  check('A: seatFor from the mirror', solo.seatFor('u-a') === 'a1');

  solo.onMessage('a1', { t: 'start' });
  const started = await until(() => s1.msgs('matchStart').length > 0, 5000);
  check('A: start → matchStart', started);
  const ms = s1.msgs('matchStart')[0] as Extract<ServerMsg, { t: 'matchStart' }> | undefined;
  const stop = driver(solo, 'a1', s1, ms?.gen ?? 0);
  // robots are disabled through the pre-match countdown, so movement is measured from the
  // first live tick
  await until(() => snaps(s1).some((m) => m.w.match.phase !== 'pre'), 10_000, 50);
  const liveFrom = snaps(s1).findIndex((m) => m.w.match.phase !== 'pre');
  await sleep(1500);
  const ss = snaps(s1).slice(Math.max(0, liveFrom));
  const posOf = (m: Extract<ServerMsg, { t: 'snapshot' }> | undefined) => m?.w.robots.find((r) => r.id === ms?.yourRobotId)?.pos;
  const p0 = posOf(ss[0]);
  let moved = 0;
  for (const m of ss) {
    const p = posOf(m);
    if (p0 && p) moved = Math.max(moved, Math.hypot(p.x - p0.x, p.y - p0.y));
  }
  check('A: snapshots stream (≥ 20 in 1.5 s)', ss.length >= 20, `${ss.length}`);
  check('A: inputs reach the worker room (robot moved)', moved > 1, `${moved.toFixed(1)} in`);
  check('A: the one-game lock reaches the socket thread', events.includes('on:u-a'), events.join(','));
  await until(() => solo.summary() !== null, 2000);
  check('A: a live summary is mirrored (Watch Live)', solo.summary()?.kind === 'record');
  check('A: presence is mirrored', solo.presenceSnapshot().players.some((p) => p.userId === 'u-a' && p.act === 'match'));

  // ---- a host unlocks a duo-record room: the socket thread's copy of the config follows ------
  {
    const duoCfg = { kind: 'record' as const, record: 'duo' as const, game: 'decode' as const, settings: coerceRoomSettings('record', 'duo', {}) };
    const duo = createRoom('wt-duo', () => {}, duoCfg);
    const ds = fakeSocket();
    const cd = clientOn(ds, 'd1', 'u-d1', 'blue');
    duo.add(cd);
    await until(() => duo.lobbySummary().players === 1, 3000);
    check('A: a duo record room mirrors its locked config', duo.config.kind === 'record' && duo.lobbySummary().capacity === 2);
    duo.onMessage('d1', { t: 'unlockRoom' });
    const unlocked = await until(() => duo.config.kind === 'versus', 3000);
    check('A: unlocking a worker room updates the socket thread copy of the config (kind, record, settings)',
      unlocked && duo.config.record === undefined && duo.config.settings?.preset === 'custom' && !duo.soloRecord);
    duo.onMessage('d1', { t: 'roomSettings', patch: { perAlliance: { red: 2, blue: 2 } } });
    const grown = await until(() => duo.lobbySummary().capacity === 4, 3000);
    check('A: a settings change on a worker room reaches the capacity the join door reads', grown);
    duo.detach('d1', cd.conn, true); // leave, so the room empties and later room counts stay true
    await sleep(300);
  }

  // ---- a socket that stops draining is skipped, then resumes --------------------------------
  s1.setBacklog(300 * 1024);
  await sleep(250);
  const before = snaps(s1).length;
  await sleep(500);
  const during = snaps(s1).length - before;
  s1.setBacklog(0);
  await sleep(250);
  const after0 = snaps(s1).length;
  await sleep(500);
  const resumed = snaps(s1).length - after0;
  check('A: a backed-up socket is skipped (Client.backlog crosses the thread)', during === 0, `${during} snapshots while backed up`);
  check('A: ...and resumes once it drains', resumed >= 8, `${resumed} in 500 ms`);
  stop();

  // ---- the worker dies under the room --------------------------------------------------------
  const idx = workerOfForTest(solo);
  await killWorkerForTest(idx);
  const lostOk = await until(() => s1.closedWith() === 1011, 3000);
  check('A: a lost worker closes its rooms’ sockets (1011)', lostOk, String(s1.closedWith()));
  check('A: ...drops the room from the registry (onEmpty)', emptied === 1);
  check('A: ...and lets the one-game lock go', events.includes('off:u-a'), events.join(','));
  const back = await until(() => !!workerPerf()?.[idx]?.ready, 30_000);
  check('A: the dead worker is respawned', back);

  // ---- a room after the respawn; lobby leave; dispose -----------------------------------------
  let emptied2 = 0;
  const lobby = createRoom(
    'wt-lobby',
    () => {
      emptied2++;
    },
    { kind: 'versus', game: 'decode' },
  );
  const s2 = fakeSocket();
  const c2 = clientOn(s2, 'b1', 'u-b', 'red');
  lobby.add(c2);
  check('A: a room works after a respawn', await until(() => s2.msgs('welcome').length > 0, 5000));
  const w = workerOfForTest(lobby);
  await until(() => lobby.lobbySummary().players === 1, 2000);
  lobby.detach('b1', c2.conn, true);
  check('A: the last one out of a lobby empties it', await until(() => emptied2 === 1, 3000));
  const disposed = await until(() => (workerPerf()?.[w]?.rooms ?? -1) === 0, 10_000, 100);
  check('A: an emptied room is forgotten by its worker', disposed, `worker ${w} rooms ${workerPerf()?.[w]?.rooms}`);
  // a joiner that read the room out of the registry before it emptied adds itself now: an
  // in-process Room would take them, so a forgotten worker room must come back, not swallow it
  const s3 = fakeSocket();
  const c3 = clientOn(s3, 'b2', 'u-c', 'red');
  lobby.add(c3);
  check('A: a late joiner revives a forgotten room (welcomed, not left hanging)', await until(() => s3.msgs('welcome').length > 0, 5000));
  check('A: ...which counts on a worker again', await until(() => (workerPerf() ?? []).some((x) => x.rooms > 0), 2000));
  lobby.detach('b2', c3.conn, true);
  const gone = await until(() => (workerPerf() ?? []).every((x) => x.rooms === 0), 10_000, 100);
  check('A: ...and is forgotten again when it empties', gone, JSON.stringify(workerPerf()?.map((x) => x.rooms)));

  // ---- imported robots across the thread (docs/area/netcode.md, IMPORTED ROBOTS) ---------------
  // The join, rejoin and spectate doors ask `importState()` of the room, and for a room on a
  // worker that is a MIRROR a message behind plus whatever has been posted since — the same
  // arrangement `canJoin` counts an add in flight for. The worker's own Room refuses the rest.
  {
    const imp = createRoom('wt-imp', () => {}, { kind: 'versus', game: 'decode', imports: true });
    const si = fakeSocket();
    const ci = clientOn(si, 'i1', 'u-i', 'red');
    ci.player.spec = { ...ci.player.spec, imported: IMP } as typeof ci.player.spec;
    check('A: a custom room on a worker allows imported robots (answered on the socket thread)', imp.importState().allows);
    imp.add(ci);
    check('A: an imported robot still in flight already counts', imp.importState().hasImport);
    await until(() => si.msgs('welcome').length > 0, 5000);
    await until(() => imp.lobbySummary().players === 1, 2000);
    check('A: ...and so does the mirror once the worker has applied it', imp.importState().hasImport && !imp.importState().capless);
    check('A: ...and its robot id rides the mirror (one id per room)', (imp.importState().ids ?? []).includes(IMP.id));
    const sd = fakeSocket();
    const cd = clientOn(sd, 'd1', 'u-d', 'blue');
    cd.player.spec = { ...cd.player.spec, imported: IMP } as typeof cd.player.spec;
    imp.add(cd);
    check('A: a second seat with the same robot id, in flight, already shows its id', (imp.importState().ids ?? []).filter((x) => x === IMP.id).length === 2);
    await sleep(400);
    check(
      'A: the worker room refuses a second seat with the same robot id, with the sentence, and does not seat it',
      sd.msgs('welcome').length === 0 && sd.msgs('error').some((m) => (m as { message?: string }).message === IMPORT_ID_TAKEN),
    );
    const so = fakeSocket();
    const co = clientOn(so, 'o1', 'u-o', 'blue');
    co.caps = [];
    imp.add(co);
    check('A: a seat without the cap, in flight, counts as one (capless)', imp.importState().capless);
    await sleep(400);
    check(
      'A: the worker room refuses that seat beside an imported robot, with the sentence, and does not seat it',
      so.msgs('welcome').length === 0 && so.msgs('error').some((m) => (m as { message?: string }).message === IMPORT_ROOM_NEEDS_UPDATE),
    );
    check('A: ...and the mirror settles back to no seat without the cap', await until(() => !imp.importState().capless, 3000));
    const rec = createRoom('wt-imp-rec', () => {}, { kind: 'record', record: 'solo', game: 'decode', imports: true });
    check('A: a record room on a worker does not allow imported robots', !rec.importState().allows);
  }

  // ---- where the importer ships: `RoomConfig.imports`, decided on THIS thread ---------------------
  // Each room is joined by `add`, past the door, so what seats or refuses is the worker's own Room.
  {
    const here = IMPORTS_OPEN_HERE;
    const impClient = (sock: ReturnType<typeof fakeSocket>, id: string, alliance: Alliance): Client => {
      const c = clientOn(sock, id, `u-${id}`, alliance);
      c.player.spec = { ...c.player.spec, imported: IMP } as typeof c.player.spec;
      return c;
    };
    const answered = (sock: ReturnType<typeof fakeSocket>): Promise<boolean> =>
      until(() => sock.msgs('welcome').length > 0 || sock.msgs('error').length > 0, 5000);
    const refusedHere = (sock: ReturnType<typeof fakeSocket>): boolean =>
      sock.msgs('welcome').length === 0 && sock.msgs('error').some((m) => (m as { message?: string }).message === IMPORT_REFUSED_HERE);

    const dflt = createRoom('wt-gate', () => {}, { kind: 'versus', game: 'decode' });
    check(
      `A: a worker room built with no \`imports\` takes this thread's gate (${here ? 'open' : 'closed'}), not the worker's env`,
      dflt.importState().allows === here && dflt.config.imports === here,
    );
    const sg = fakeSocket();
    dflt.add(impClient(sg, 'g1', 'red'));
    await answered(sg);
    check(
      "A: ⚠️ ...and the worker's Room agrees: it seats or refuses an imported robot by that same answer",
      here ? sg.msgs('welcome').length > 0 : refusedHere(sg),
      JSON.stringify(sg.msgs('error')),
    );

    const shut = createRoom('wt-shut', () => {}, { kind: 'versus', game: 'decode', imports: false });
    check('A: a room closed by its config does not allow imported robots (the socket thread)', !shut.importState().allows);
    const ss = fakeSocket();
    shut.add(impClient(ss, 's1', 'red'));
    await answered(ss);
    check('A: ...the worker refuses one with the sentence, and does not seat it', refusedHere(ss), JSON.stringify(ss.msgs('error')));
    const sp = fakeSocket();
    shut.add(clientOn(sp, 's2', 'u-s2', 'red'));
    await answered(sp);
    check('A: ...and seats a standard robot', sp.msgs('welcome').length > 0);
    shut.onMessage('s2', { t: 'visualPut', kind: 'top', id: IMP.id, total: 12, seq: 0, data: IV.bytesToBase64(new Uint8Array(12).fill(7)) });
    const rr = await until(() => sp.msgs('visualRefused').length > 0, 3000);
    check(
      'A: ...and its look relay refuses an upload with the room reason',
      rr && (sp.msgs('visualRefused')[0] as { reason?: string }).reason === 'room',
      JSON.stringify(sp.msgs('visualRefused')),
    );

    const op = createRoom('wt-open', () => {}, { kind: 'versus', game: 'decode', imports: true });
    const so2 = fakeSocket();
    op.add(impClient(so2, 'o1', 'red'));
    await answered(so2);
    check('A: the same room opened by its config allows them on both threads', op.importState().allows && so2.msgs('welcome').length > 0);
  }

  // ---- reattach and the report resolvers answer across the thread ----------------------------
  const vs = createRoom('wt-vs', () => {}, { kind: 'versus', game: 'decode' });
  const sx = fakeSocket();
  const sy = fakeSocket();
  const cx = clientOn(sx, 'x1', 'u-x', 'red');
  const cy = clientOn(sy, 'y1', 'u-y', 'blue');
  vs.add(cx);
  vs.add(cy);
  await until(() => sy.msgs('welcome').length > 0, 5000);
  const tokenY = (sy.msgs('welcome')[0] as Extract<ServerMsg, { t: 'welcome' }> | undefined)?.seatToken ?? '';
  vs.onMessage('x1', { t: 'start' });
  await until(() => sy.msgs('matchStart').length > 0, 5000);
  const yRobot = (sy.msgs('matchStart')[0] as Extract<ServerMsg, { t: 'matchStart' }> | undefined)?.yourRobotId ?? -1;
  const rep = await vs.resolveReport('x1', yRobot);
  check('A: resolveReport answers across the thread', rep?.reporterId === 'u-x' && rep?.reportedId === 'u-y', JSON.stringify(rep));
  const srep = await vs.resolveScoreReport('x1');
  check('A: resolveScoreReport answers across the thread', srep?.reporterId === 'u-x' && srep?.roomCode === 'wt-vs', JSON.stringify(srep));
  vs.detach('y1', cy.conn, false); // a network drop mid-match: the seat is held
  await sleep(100);
  const sz = fakeSocket();
  const refused = await vs.reattach('y1', sz.send, undefined, undefined, 'not-the-token');
  check('A: reattach with the wrong seat token is refused', refused === null);
  const nc = await vs.reattach('y1', sz.send, undefined, undefined, tokenY);
  check('A: reattach with the seat token answers with the new socket key', typeof nc === 'number' && nc > 0, String(nc));
  const rj = await until(() => sz.msgs('rejoined').some((m) => (m as { ok: boolean }).ok), 3000);
  check('A: the reclaimed seat is told on its new socket', rj);
  check('A: ...and gets a snapshot there', await until(() => snaps(sz).length > 0, 3000));

  // ---- the visuals relay across the thread (docs/area/netcode.md, VISUALS RELAY) ------------------
  // The relay lives IN the worker's room: the bytes, their validation and the stream timer run on
  // the worker, and the socket thread only writes the frames. What this proves is the part a
  // headless Room cannot: frames crossing the batch boundary intact, the socket's backlog
  // (a mirror, in steps of 16 KiB) pacing the worker's stream, and the process budget being ONE
  // counter that the socket thread can read although a worker wrote it.
  {
    const png = pngBytes(128, 128, { noise: true, seed: 5 }); // 3 chunks
    const mesh = glbBytes({ tris: 6000 }); // 216 KB, 9 chunks
    const room = createRoom('wt-vis', () => {}, { kind: 'versus', game: 'decode', imports: true });
    const so = fakeSocket();
    const sv = fakeSocket();
    const co = clientOn(so, 'vo', 'u-vo', 'red');
    co.player.spec = { ...co.player.spec, imported: IMP } as typeof co.player.spec;
    const cv = clientOn(sv, 'vv', 'u-vv', 'blue');
    room.add(co);
    room.add(cv);
    await until(() => so.msgs('welcome').length > 0 && sv.msgs('welcome').length > 0, 5000);
    const base = visualBytesInUse();
    const put = (kind: IV.VisualKind, bytes: Uint8Array): void => {
      for (let seq = 0; seq < IV.visualFrames(bytes.length); seq++) {
        const sp = IV.visualSpan(bytes.length, seq);
        room.onMessage('vo', { t: 'visualPut', kind, id: IMP.id, total: bytes.length, seq, data: IV.bytesToBase64(bytes, sp.start, sp.end) });
      }
    };
    const got = (sock: ReturnType<typeof fakeSocket>, kind: IV.VisualKind): Uint8Array => {
      const cs = (sock.msgs('visualChunk') as Extract<ServerMsg, { t: 'visualChunk' }>[]).filter((m) => m.kind === kind);
      const out = new Uint8Array(cs[0]?.total ?? 0);
      for (const c of cs) out.set(IV.base64ToBytes(c.data) ?? new Uint8Array(0), IV.visualSpan(c.total, c.seq).start);
      return out;
    };
    const eq = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.length > 0 && a.every((x, i) => x === b[i]);
    put('top', png);
    check('A: the owner’s upload is announced to the other seat across the thread', await until(() => sv.msgs('visualReady').length === 1, 3000));
    check('A: ...and to the owner', so.msgs('visualReady').length === 1);
    check('A: ⚠️ the process budget is one shared counter: the socket thread reads what the worker reserved', await until(() => visualBytesInUse() - base === png.length, 2000), String(visualBytesInUse() - base));
    room.onMessage('vv', { t: 'visualGet', owner: 'vo', id: IMP.id, kind: 'top' });
    check('A: a request is streamed from the worker, in order, identical', await until(() => got(sv, 'top').length === png.length && sv.msgs('visualChunk').length === 3, 3000) && eq(got(sv, 'top'), png));
    check('A: the owner, who did not ask, was sent no chunk', so.msgs('visualChunk').length === 0);
    // pacing by the socket's backlog: it is mirrored in 16 KiB steps and re-read by the pool
    sv.setBacklog(64 * 1024);
    put('mesh', mesh); // a write to the viewer's socket, which is what makes the pool read its backlog
    await until(() => sv.msgs('visualReady').length === 2, 3000);
    await sleep(150);
    room.onMessage('vv', { t: 'visualGet', owner: 'vo', id: IMP.id, kind: 'mesh' });
    await sleep(400);
    check('A: ⚠️ a viewer whose socket is backed up is handed no chunk, however long it waits', sv.msgs('visualChunk').filter((m) => (m as { kind?: string }).kind === 'mesh').length === 0);
    sv.setBacklog(0);
    check('A: ...and the stream resumes the moment it drains, and arrives identical', await until(() => eq(got(sv, 'mesh'), mesh) && sv.msgs('visualChunk').length === 3 + 9, 5000), String(sv.msgs('visualChunk').length));
    // the owner leaves the lobby: the worker frees, the shared counter shows it
    room.detach('vo', co.conn, true);
    check('A: the owner leaving frees the assets, and the budget with them (seen from the socket thread)', await until(() => visualBytesInUse() === base, 3000), String(visualBytesInUse() - base));
    // a worker that dies with assets in its rooms must not leak the process budget
    const sx2 = fakeSocket();
    const room2 = createRoom('wt-vis2', () => {}, { kind: 'versus', game: 'decode', imports: true });
    const cx2 = clientOn(sx2, 'vx', 'u-vx', 'red');
    cx2.player.spec = { ...cx2.player.spec, imported: IMP } as typeof cx2.player.spec;
    room2.add(cx2);
    await until(() => sx2.msgs('welcome').length > 0, 5000);
    const w2 = workerOfForTest(room2);
    for (let seq = 0; seq < IV.visualFrames(png.length); seq++) {
      const sp = IV.visualSpan(png.length, seq);
      room2.onMessage('vx', { t: 'visualPut', kind: 'top', id: IMP.id, total: png.length, seq, data: IV.bytesToBase64(png, sp.start, sp.end) });
    }
    check('A: a second room on a worker holds a picture', await until(() => visualBytesInUse() - base === png.length, 3000));
    await killWorkerForTest(w2);
    check('A: ⚠️ a worker that dies with a picture in one of its rooms gives the bytes back (the pool zeroes its slot)', await until(() => visualBytesInUse() === base, 5000), String(visualBytesInUse() - base));
    await until(() => !!workerPerf()?.[w2]?.ready, 30_000);
  }
}

// =============================================================================================
// B. the real server, twice
// =============================================================================================

class Sock {
  private ws!: WebSocket;
  readonly log: ServerMsg[] = [];
  clientId = '';
  seatToken = '';
  robotId = -1;
  gen = 0;
  serverTick = 0;
  snapshots = 0;
  ack = 0;
  firstPos: { x: number; y: number } | null = null;
  /** furthest the robot has been from `firstPos` */
  maxMoved = 0;
  private drive: ReturnType<typeof setInterval> | null = null;
  private sendTick = 0;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly url: string,
    /** do the 3D loading handshake (`physicsReady` on welcome, `viewReady` on matchStart) */
    private readonly threeD = false,
  ) {}

  open(): Promise<this> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.on('open', () => resolve(this));
      this.ws.on('error', reject);
      this.ws.on('message', (d) => this.onMsg(String(d)));
    });
  }

  private onMsg(s: string): void {
    const m = JSON.parse(s) as ServerMsg;
    this.log.push(m);
    if (m.t === 'welcome') {
      this.clientId = m.clientId;
      if (m.seatToken) this.seatToken = m.seatToken;
      if (this.threeD) this.send({ t: 'physicsReady' });
    } else if (m.t === 'matchStart') {
      this.robotId = m.yourRobotId;
      this.gen = m.gen ?? 0;
      if (this.threeD) this.send({ t: 'viewReady', gen: this.gen });
    } else if (m.t === 'snapshot') {
      this.snapshots++;
      this.serverTick = m.serverTick;
      this.ack = m.ackInputTick;
      const r = m.w.robots.find((x) => x.id === this.robotId);
      // movement counts from the first LIVE tick: robots are disabled through the countdown
      if (r && m.w.match.phase !== 'pre') {
        this.firstPos ??= { x: r.pos.x, y: r.pos.y };
        this.maxMoved = Math.max(this.maxMoved, Math.hypot(r.pos.x - this.firstPos.x, r.pos.y - this.firstPos.y));
      }
    }
    for (const l of this.listeners) l();
  }

  send(m: ClientMsg): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  join(room: string, config: RoomConfig, name: string, alliance: Alliance, startIndex = 0): void {
    this.send({ t: 'join', room, config, player: makePlayer(name, alliance, startIndex), caps: CLIENT_CAPS });
  }

  /** the first message of type `t` (from `from` on) matching `pred`, or null on timeout */
  until<T extends ServerMsg['t']>(
    t: T,
    pred: (m: Extract<ServerMsg, { t: T }>) => boolean = () => true,
    ms = 8000,
    from = 0,
  ): Promise<Extract<ServerMsg, { t: T }> | null> {
    const find = (): Extract<ServerMsg, { t: T }> | null => {
      for (let i = from; i < this.log.length; i++) {
        const m = this.log[i];
        if (m.t === t && pred(m as Extract<ServerMsg, { t: T }>)) return m as Extract<ServerMsg, { t: T }>;
      }
      return null;
    };
    const hit = find();
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve) => {
      const l = (): void => {
        const h = find();
        if (!h) return;
        this.listeners.delete(l);
        clearTimeout(timer);
        resolve(h);
      };
      const timer = setTimeout(() => {
        this.listeners.delete(l);
        resolve(null);
      }, ms);
      this.listeners.add(l);
    });
  }

  startDriving(): void {
    this.stopDriving();
    // every driver starts the same path from its own t = 0, so both servers see the same stick
    const t0 = performance.now();
    this.drive = setInterval(() => {
      this.sendTick = Math.max(this.sendTick + 1, this.serverTick + 1);
      const q = quantizeCommand(wander((performance.now() - t0) / 1000));
      this.send({ t: 'input', tick: this.sendTick, q, ack: this.serverTick, gen: this.gen });
    }, 16);
  }

  stopDriving(): void {
    if (this.drive) clearInterval(this.drive);
    this.drive = null;
  }

  moved(): number {
    return this.maxMoved;
  }

  /** a clean close (1000): the client leaving on purpose */
  close(): void {
    this.stopDriving();
    this.ws.close(1000);
  }

  /** the network going away: no close frame, the server sees 1006 */
  drop(): void {
    this.stopDriving();
    this.ws.terminate();
  }
}

interface Server {
  label: string;
  url: string;
  http: string;
  proc: ChildProcess;
  log: string[];
}

/** `channel`: the server's `SERVER_CHANNEL`. 'alpha' is the deployment the importer ships to; '' is
 *  production, which sets none. Neither gets `ROBOT_IMPORT`, so each reads its gate as deployed. */
async function boot(label: string, port: number, workers: number, channel = 'alpha'): Promise<Server> {
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), SIM_WORKERS: String(workers) };
  // nothing here may reach a real database, identity provider or region router
  for (const k of ['DATABASE_URL', 'NEON_AUTH_URL', 'FLY_REGION', 'SERVER_REGION', 'MAX_ROOMS', 'FLY_MACHINE_ID']) delete env[k];
  for (const k of ['ROBOT_IMPORT', 'SERVER_CHANNEL', 'LAN_MODE']) delete env[k];
  if (channel) env.SERVER_CHANNEL = channel;
  const proc = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log: string[] = [];
  proc.stdout!.on('data', (d) => log.push(String(d)));
  proc.stderr!.on('data', (d) => log.push(String(d)));
  const s: Server = { label, url: `ws://127.0.0.1:${port}`, http: `http://127.0.0.1:${port}`, proc, log };
  const up = await until(() => log.join('').includes('physics ready'), 60_000, 100);
  if (!up) throw new Error(`${label} did not boot:\n${log.join('')}`);
  if (workers > 0) {
    const end = Date.now() + 60_000;
    while (Date.now() < end) {
      const p = await perf(s);
      if ((p.workers ?? []).length === workers && p.workers!.every((w) => w.ready)) break;
      await sleep(200);
    }
  }
  return s;
}

interface Perf {
  rooms: number;
  capRooms: number;
  workers?: { worker: number; ready: boolean; rooms: number }[];
}
async function perf(s: Server): Promise<Perf> {
  const r = await fetch(`${s.http}/api/perf`);
  return (await r.json()) as Perf;
}

let codeSeq = 0;
const newCode = (): string => `wt${Date.now().toString(36).slice(-4)}${codeSeq++}`;

async function scenarios(s: Server): Promise<void> {
  const L = (name: string): string => `B[${s.label}]: ${name}`;
  const open = (threeD = false): Promise<Sock> => new Sock(s.url, threeD).open();
  const cap0 = (await perf(s)).capRooms;

  // ---- a custom 1v1, lobby to match ------------------------------------------------------------
  const code = newCode();
  const versus: RoomConfig = { kind: 'versus', game: 'decode' };
  const A = await open();
  A.join(code, versus, 'A', 'red');
  check(L('the host is welcomed'), !!(await A.until('welcome')));
  const B = await open();
  B.join(code, versus, 'B', 'blue');
  check(L('the roster reaches both seats'), !!(await A.until('roster', (m) => m.players.length === 2)));
  check(L('a joiner with another season is refused by name'), await (async () => {
    const X = await open();
    X.join(code, { kind: 'versus', game: 'chain' }, 'X', 'red');
    const e = await X.until('error');
    X.close();
    return e?.code === 'game_mismatch';
  })());
  A.send({ t: 'start' });
  const msA = await A.until('matchStart');
  const msB = await B.until('matchStart');
  check(L('start → matchStart on both seats'), !!msA && !!msB);
  A.startDriving();
  B.startDriving();
  await until(() => A.firstPos !== null, 10_000, 50);
  await sleep(2500);
  check(L('snapshots stream (≥ 20 in 1.5 s)'), A.snapshots >= 20 && B.snapshots >= 20, `${A.snapshots}/${B.snapshots}`);
  // an idle robot moves ≤ 0.1 in; a driven one that starts against a wall can manage only a few
  const movedAB = Math.max(A.moved(), B.moved());
  check(L('inputs are applied (a robot moved, ackInputTick moving)'), movedAB > 1 && A.ack > 0, `${movedAB.toFixed(1)} in, ack ${A.ack}`);
  const p1 = await perf(s);
  check(L('/api/perf counts the live match'), p1.rooms >= 1 && p1.capRooms === cap0 + 1, `rooms ${p1.rooms} cap ${p1.capRooms}`);

  const S = await open();
  S.send({ t: 'spectate', room: code, caps: CLIENT_CAPS });
  const sms = await S.until('matchStart');
  check(L('a spectator gets the match with robot -1'), sms?.yourRobotId === -1);
  check(L('...and snapshots'), !!(await S.until('snapshot')));
  check(L('the seats are told somebody is watching'), !!(await A.until('spectators', (m) => m.n === 1)));

  const D = await open();
  D.join(code, versus, 'D', 'red');
  const busy = await D.until('error');
  check(L('a joiner at a running match is told it is in progress'), busy?.code === 'in_progress', busy?.message);
  D.close();

  const mark = A.log.length;
  A.send({ t: 'report', robotId: msB?.yourRobotId ?? 1, reason: 'afk' });
  check(L('a player report is answered'), !!(await A.until('reported', () => true, 5000, mark)));
  const mark2 = A.log.length;
  A.send({ t: 'reportScore', detail: 'test' });
  check(L('a misscore report is answered'), !!(await A.until('reported', () => true, 5000, mark2)));

  // the network drops B; B comes back on a new socket with its seat token
  const bId = B.clientId;
  const bToken = B.seatToken;
  B.drop();
  await sleep(300);
  const Bw = await open();
  Bw.send({ t: 'rejoin', room: code, clientId: bId, caps: CLIENT_CAPS, seatToken: 'wrong' });
  const nope = await Bw.until('rejoined');
  check(L('a rejoin with the wrong seat token is refused'), nope?.ok === false);
  Bw.close();
  const B2 = await open();
  B2.send({ t: 'rejoin', room: code, clientId: bId, caps: CLIENT_CAPS, seatToken: bToken });
  const rj = await B2.until('rejoined');
  check(L('a rejoin with the seat token reclaims the seat, on the live generation'), rj?.ok === true && rj.gen === msB?.gen, JSON.stringify(rj));
  B2.robotId = msB?.yourRobotId ?? -1;
  B2.gen = msB?.gen ?? 0;
  check(L('...and resyncs with a snapshot'), !!(await B2.until('snapshot')));
  B2.startDriving();
  const n0 = B2.snapshots;
  await sleep(600);
  check(L('...and keeps streaming'), B2.snapshots - n0 >= 10, `${B2.snapshots - n0}`);
  A.close();
  B2.close();
  S.close();

  // ---- a lobby that empties is gone -------------------------------------------------------------
  const code2 = newCode();
  const E = await open();
  E.join(code2, versus, 'E', 'red');
  await E.until('welcome');
  const F = await open();
  F.join(code2, versus, 'F', 'blue');
  await E.until('roster', (m) => m.players.length === 2);
  const capMid = (await perf(s)).capRooms;
  F.close();
  check(L('a lobby leave shrinks the roster'), !!(await E.until('roster', (m) => m.players.length === 1, 5000, E.log.length)));
  E.close();
  let capEnd = capMid;
  for (let i = 0; i < 30; i++) {
    capEnd = (await perf(s)).capRooms;
    if (capEnd === capMid - 1) break;
    await sleep(100);
  }
  check(L('the last one out takes the room with them'), capEnd === capMid - 1, `${capMid} → ${capEnd}`);

  // ---- a BIOBUZZ 3D record run --------------------------------------------------------------------
  const code3 = newCode();
  const R = await open(true);
  R.join(code3, { kind: 'record', record: 'solo', game: 'biobuzz' }, 'R', 'blue');
  await R.until('welcome');
  await sleep(200); // let `physicsReady` land ahead of the start
  R.send({ t: 'start' });
  const ms3 = await R.until('matchStart', () => true, 15_000);
  check(L('a BIOBUZZ record run starts in 3D'), ms3?.physics === '3d', JSON.stringify(ms3?.physics));
  R.startDriving();
  await until(() => R.firstPos !== null, 20_000, 50);
  const n3 = R.snapshots;
  await sleep(2500);
  check(L('...streams snapshots (≥ 20 in 2.5 s)'), R.snapshots - n3 >= 20, `${R.snapshots - n3}`);
  check(L('...and drives'), R.moved() > 1, `${R.moved().toFixed(1)} in`);
  const capRun = (await perf(s)).capRooms;
  R.close();
  let capAfter = capRun;
  for (let i = 0; i < 30; i++) {
    capAfter = (await perf(s)).capRooms;
    if (capAfter === capRun - 1) break;
    await sleep(100);
  }
  check(L('a solo record run is reaped on a clean close'), capAfter === capRun - 1, `${capRun} → ${capAfter}`);

  // ---- imported robots at the real doors (docs/area/netcode.md, IMPORTED ROBOTS) -----------------
  // Read off what the client SENT, so the first two do not depend on `coerceSpec` carrying the field.
  const impP = (name: string, alliance: Alliance) => ({ ...makePlayer(name, alliance, 0), spec: { ...DEFAULT_SPEC, name, imported: IMP } as typeof DEFAULT_SPEC });
  const stdP = (name: string, alliance: Alliance) => makePlayer(name, alliance, 0);
  {
    // these servers run as the alpha deployment does, where the importer ships (`closedGate` is production)
    const caps = (((await (await fetch(`${s.http}/api/presence`)).json()) as { caps?: string[] }).caps ?? []);
    check(L('the alpha server advertises robotImport and importVisuals on /api/presence'), caps.includes(ROBOT_IMPORT_CAP) && caps.includes(IV.IMPORT_VISUALS_CAP), caps.join(','));
    check(L('...and its boot line says the gate is open'), s.log.join('').includes('imports=open'));
  }
  {
    const X = await open();
    X.send({ t: 'join', room: newCode(), config: { kind: 'record', record: 'solo', game: 'decode' }, player: impP('X', 'blue'), caps: CLIENT_CAPS });
    const e = await X.until('error');
    check(L('a record room refuses an imported robot at the door, with the sentence'), e?.message === IMPORT_REFUSED_HERE, e?.message);
    X.close();
    const Q = await open();
    Q.send({ t: 'queue', mode: '1v1', player: impP('Q', 'red'), homeRegion: '', accessMs: 0, caps: CLIENT_CAPS, game: 'decode' });
    const qe = await Q.until('error');
    check(L('the ranked queue refuses an imported robot before any queue attempt exists'), qe?.message === IMPORT_REFUSED_RANKED, qe?.message);
    Q.close();
  }
  {
    // a seat without the cap is in first, and an import is not added beside it. Read off what the
    // newcomer SENT, so it does not depend on `coerceSpec` carrying the field.
    const room2 = newCode();
    const K = await open();
    K.send({ t: 'join', room: room2, config: versus, player: stdP('K', 'red'), caps: [] });
    await K.until('welcome');
    await K.until('roster', (m) => m.players.length === 1);
    const M = await open();
    M.send({ t: 'join', room: room2, config: versus, player: impP('M', 'blue'), caps: CLIENT_CAPS });
    const me = await M.until('error');
    check(L('an imported robot is not added to a room with a seat that lacks the cap'), me?.message === IMPORT_MEMBER_NEEDS_UPDATE, me?.message);
    M.close();
    K.close();
  }
  // the rest read the roster the room holds, which is what `coerceSpec` kept
  {
    const room = newCode();
    const P = await open();
    P.send({ t: 'join', room, config: versus, player: impP('P', 'red'), caps: CLIENT_CAPS });
    check(L('a custom room seats an imported robot (client with the cap)'), !!(await P.until('welcome')));
    await P.until('roster', (m) => m.players.length === 1);
    const O = await open();
    O.send({ t: 'join', room, config: versus, player: stdP('O', 'blue'), caps: [] });
    const oe = await O.until('error');
    check(L('...and turns away a build without the cap, with the sentence, at the door'), oe?.message === IMPORT_ROOM_NEEDS_UPDATE, oe?.message);
    O.close();
    const W = await open();
    W.send({ t: 'spectate', room, caps: [] });
    const we = await W.until('error');
    check(L('...and a watcher without it'), we?.message === IMPORT_ROOM_NEEDS_UPDATE, we?.message);
    W.close();
    const G = await open();
    G.send({ t: 'join', room, config: versus, player: stdP('G', 'blue'), caps: CLIENT_CAPS });
    check(L('...while a build with it is seated'), !!(await G.until('welcome')));
    const H = await open();
    H.send({ t: 'join', room, config: versus, player: impP('H', 'blue'), caps: CLIENT_CAPS });
    const he = await H.until('error');
    check(L('...and a second imported robot with the SAME robot id is turned away at the door (one id per room)'), he?.message === IMPORT_ID_TAKEN, he?.message);
    H.close();
    // A HOSTILE UPDATE COSTS NOTHING (review 2026-10-01): 16 bands of 256 far-off points, 62 KB, cost
    // 70 ms of the room's thread each. Sixty of them, then a rename: the rename must come straight back.
    const far = Array.from({ length: 256 }, () => ({ x: 99, y: 0 }));
    const hostile = { ...DEFAULT_SPEC, imported: { ...IMP, id: 'fedcba9876543210', bands: Array.from({ length: 16 }, () => ({ z0: 0, z1: 5, hull: far })) } };
    const mark = G.log.length;
    const t0 = Date.now();
    for (let i = 0; i < 60; i++) G.send({ t: 'update', patch: { spec: hostile } });
    G.send({ t: 'update', patch: { name: 'Gx' } });
    const renamed = await G.until('roster', (m) => m.players.some((p) => p.name === 'Gx'), 10_000, mark);
    const dt = Date.now() - t0;
    check(L('⚠️ sixty hostile 62 KB updates do not stall the room: a rename right behind them comes back in under 1.5 s (it was over 4 s of one thread)'), !!renamed && dt < 1500, `${dt} ms`);
    P.close();
    G.close();
  }
  {
    // A RETURNING SOCKET'S BUILD IS THE ONE THAT PLAYS (review 2026-10-01): a seat reclaimed by a
    // build without the import cap reads as one from then on, on both server shapes
    const room3 = newCode();
    const K2 = await open();
    K2.send({ t: 'join', room: room3, config: versus, player: stdP('K2', 'red'), caps: CLIENT_CAPS });
    await K2.until('welcome');
    const L2 = await open();
    L2.send({ t: 'join', room: room3, config: versus, player: stdP('L2', 'blue'), caps: CLIENT_CAPS });
    await L2.until('welcome');
    await L2.until('roster', (m) => m.players.length === 2);
    const K3 = await open();
    K3.send({ t: 'rejoin', room: room3, clientId: K2.clientId, caps: ['strategy', 'seat'], seatToken: K2.seatToken });
    const rj = await K3.until('rejoined');
    check(L('a seat reclaimed by a build without the import cap is let back into a room with no import'), rj?.ok === true);
    const mark = L2.log.length;
    L2.send({ t: 'update', patch: { spec: { ...DEFAULT_SPEC, imported: IMP } } });
    const le = await L2.until('error', () => true, 3000, mark);
    check(L('⚠️ ...and the room now knows that build: an imported robot is not added beside it (the seat kept its join’s caps before)'), le?.message === IMPORT_MEMBER_NEEDS_UPDATE, le?.message);
    K3.close();
    K2.close();
    L2.close();
  }

  await visuals(s);
}

/**
 * THE VISUALS RELAY AT THE REAL DOOR (docs/area/netcode.md, VISUALS RELAY), on both server shapes:
 * an owner uploads a picture and a mesh as paced frames over a real WebSocket, a seat and a watcher
 * ask, and what they receive is byte-identical — through `ws`, the 64 KiB frame cap, the uncompressed
 * `visualChunk` write, and (on two workers) the batch boundary. A client without the capability is
 * sent nothing, and a record room refuses.
 */
async function visuals(s: Server): Promise<void> {
  const L = (name: string): string => `B[${s.label}]: ${name}`;
  const versus: RoomConfig = { kind: 'versus', game: 'decode' };
  const impP = (name: string, alliance: Alliance) => ({ ...makePlayer(name, alliance, 0), spec: { ...DEFAULT_SPEC, name, imported: IMP } as typeof DEFAULT_SPEC });
  const png = pngBytes(128, 128, { noise: true, seed: 8 }); // 3 chunks
  const mesh = glbBytes({ tris: 29_000 }); // ~1 MiB, 43 chunks: the largest asset the relay takes
  const noVisuals = CLIENT_CAPS.filter((c) => c !== IV.IMPORT_VISUALS_CAP);
  const room = newCode();
  const O = await new Sock(s.url).open();
  O.send({ t: 'join', room, config: versus, player: impP('O', 'red'), caps: CLIENT_CAPS });
  await O.until('welcome');
  const V = await new Sock(s.url).open();
  V.send({ t: 'join', room, config: versus, player: makePlayer('V', 'blue', 0), caps: CLIENT_CAPS });
  await V.until('welcome');
  const X = await new Sock(s.url).open();
  X.send({ t: 'join', room, config: versus, player: makePlayer('X', 'blue', 1), caps: noVisuals });
  await X.until('welcome');
  const put = async (sock: Sock, kind: IV.VisualKind, bytes: Uint8Array): Promise<void> => {
    for (let seq = 0; seq < IV.visualFrames(bytes.length); seq++) {
      const sp = IV.visualSpan(bytes.length, seq);
      sock.send({ t: 'visualPut', kind, id: IMP.id, total: bytes.length, seq, data: IV.bytesToBase64(bytes, sp.start, sp.end) });
      await sleep(IV.VISUAL_UPLOAD_GAP_MS / 3); // the real client paces at the gap; a third of it keeps this fast and far under 240/s
    }
  };
  const got = (sock: Sock, kind: IV.VisualKind): Uint8Array => {
    const cs = sock.log.filter((m) => m.t === 'visualChunk' && m.kind === kind) as Extract<ServerMsg, { t: 'visualChunk' }>[];
    const out = new Uint8Array(cs[0]?.total ?? 0);
    for (const c of cs) out.set(IV.base64ToBytes(c.data) ?? new Uint8Array(0), IV.visualSpan(c.total, c.seq).start);
    return out;
  };
  const eq = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.length > 0 && a.every((x, i) => x === b[i]);
  const ownerId = O.clientId;

  await put(O, 'top', png);
  const rdy = await V.until('visualReady', (m) => m.kind === 'top');
  check(L('an upload over a real socket is announced to the other seat'), rdy?.owner === ownerId && rdy.id === IMP.id && rdy.bytes === png.length, JSON.stringify(rdy));
  check(L('...and to the owner'), !!(await O.until('visualReady', (m) => m.kind === 'top')));
  await sleep(150);
  check(L('⚠️ a build without the capability is sent nothing at all'), !X.log.some((m) => m.t.startsWith('visual')));
  V.send({ t: 'visualGet', owner: ownerId, id: IMP.id, kind: 'top' });
  await V.until('visualChunk', (m) => m.seq === 2);
  check(L('a request is answered with the picture, byte for byte'), eq(got(V, 'top'), png));
  X.send({ t: 'visualGet', owner: ownerId, id: IMP.id, kind: 'top' });
  await sleep(200);
  check(L('...and a request from the build without the capability is ignored, unanswered'), !X.log.some((m) => m.t.startsWith('visual')));

  await put(O, 'mesh', mesh);
  check(L('a 1 MiB mesh (43 frames) is accepted'), !!(await V.until('visualReady', (m) => m.kind === 'mesh', 8000)));
  const S = await new Sock(s.url).open();
  S.send({ t: 'spectate', room, caps: CLIENT_CAPS });
  await S.until('welcome');
  check(L('a watcher who arrives later is told what is ready'), !!(await S.until('visualReady', (m) => m.kind === 'mesh')) && !!(await S.until('visualReady', (m) => m.kind === 'top')));
  S.send({ t: 'visualGet', owner: ownerId, id: IMP.id, kind: 'mesh' });
  V.send({ t: 'visualGet', owner: ownerId, id: IMP.id, kind: 'mesh' });
  await S.until('visualChunk', (m) => m.kind === 'mesh' && m.seq === 42, 15_000);
  await V.until('visualChunk', (m) => m.kind === 'mesh' && m.seq === 42, 15_000);
  check(L('⚠️ two viewers stream the full 1 MiB mesh at once, each byte for byte (a watcher, and a seat)'), eq(got(S, 'mesh'), mesh) && eq(got(V, 'mesh'), mesh));
  check(L('...in order, with no chunk repeated'), (V.log.filter((m) => m.t === 'visualChunk' && m.kind === 'mesh') as Extract<ServerMsg, { t: 'visualChunk' }>[]).every((m, i) => m.seq === i));

  // a bad upload is refused at the door
  const mark = O.log.length;
  O.send({ t: 'visualPut', kind: 'top', id: IMP.id, total: 12, seq: 0, data: IV.bytesToBase64(new Uint8Array(12).fill(7)) });
  const refusal = await O.until('visualRefused', () => true, 3000, mark);
  check(L('bytes that are not a picture are refused with the format reason'), refusal?.op === 'put' && refusal.reason === 'format');

  // the owner leaves: what it held is gone
  O.close();
  await V.until('roster', (m) => m.players.length === 2, 5000, V.log.length);
  const m2 = V.log.length;
  V.send({ t: 'visualGet', owner: ownerId, id: IMP.id, kind: 'top' });
  const none = await V.until('visualRefused', () => true, 3000, m2);
  check(L('once the owner has left, a request for its picture is refused (none): the viewer keeps the outline'), none?.reason === 'none', JSON.stringify(none));

  // a record room refuses an upload outright
  const R = await new Sock(s.url).open();
  R.join(newCode(), { kind: 'record', record: 'solo', game: 'decode' }, 'R', 'blue');
  await R.until('welcome');
  const m3 = R.log.length;
  R.send({ t: 'visualPut', kind: 'top', id: IMP.id, total: 12, seq: 0, data: IV.bytesToBase64(new Uint8Array(12).fill(7)) });
  const rr = await R.until('visualRefused', () => true, 3000, m3);
  check(L('a record room refuses an upload, with the room reason'), rr?.reason === 'room', JSON.stringify(rr));
  for (const k of [V, X, S, R]) k.close();
}

/**
 * PRODUCTION'S IMPORT GATE, AT THE REAL DOORS: a server with no `SERVER_CHANNEL` (fly.toml sets
 * none) on two workers. The importer ships to alpha only (owner, 2026-10-10), so this server says
 * nothing about imports on `/api/presence` and every custom room it builds refuses them; the same
 * steps on the alpha servers above are the paired acceptances.
 */
async function closedGate(s: Server): Promise<void> {
  const L = (name: string): string => `B[${s.label}]: ${name}`;
  const versus: RoomConfig = { kind: 'versus', game: 'decode' };
  const impP = (name: string, alliance: Alliance) => ({ ...makePlayer(name, alliance, 0), spec: { ...DEFAULT_SPEC, name, imported: IMP } as typeof DEFAULT_SPEC });
  const caps = (((await (await fetch(`${s.http}/api/presence`)).json()) as { caps?: string[] }).caps ?? []);
  check(L('⚠️ /api/presence advertises neither robotImport nor importVisuals'), !caps.includes(ROBOT_IMPORT_CAP) && !caps.includes(IV.IMPORT_VISUALS_CAP) && caps.includes('rooms2'), caps.join(','));
  check(L('the boot line says the gate is closed'), s.log.join('').includes('imports=closed'));
  const open = (): Promise<Sock> => new Sock(s.url).open();
  const room = newCode();
  const P = await open();
  P.send({ t: 'join', room, config: { ...versus, imports: true } as RoomConfig, player: impP('P', 'red'), caps: CLIENT_CAPS });
  const pe = await P.until('error');
  check(L('⚠️ a custom room refuses an imported robot at the door, with the sentence (a client cannot open it with `imports`)'), pe?.message === IMPORT_REFUSED_HERE, pe?.message);
  P.close();
  const G = await open();
  G.send({ t: 'join', room, config: versus, player: makePlayer('G', 'red', 0), caps: CLIENT_CAPS });
  check(L('...and seats a standard robot'), !!(await G.until('welcome')));
  const mark = G.log.length;
  G.send({ t: 'update', patch: { spec: { ...DEFAULT_SPEC, imported: IMP } as typeof DEFAULT_SPEC } });
  const ge = await G.until('error', () => true, 3000, mark);
  check(L('...refuses an update that brings an import'), ge?.message === IMPORT_REFUSED_HERE, ge?.message);
  const m2 = G.log.length;
  G.send({ t: 'visualPut', kind: 'top', id: IMP.id, total: 12, seq: 0, data: IV.bytesToBase64(new Uint8Array(12).fill(7)) });
  const vr = await G.until('visualRefused', () => true, 3000, m2);
  check(L('...and its look relay refuses an upload with the room reason'), vr?.reason === 'room', JSON.stringify(vr));
  G.close();
}

async function spread(s: Server): Promise<void> {
  const before = (await perf(s)).workers ?? [];
  const socks: Sock[] = [];
  for (let i = 0; i < 4; i++) {
    const x = await new Sock(s.url).open();
    x.join(newCode(), { kind: 'versus', game: 'decode' }, `P${i}`, 'red');
    await x.until('welcome');
    socks.push(x);
  }
  await sleep(300);
  const after = (await perf(s)).workers ?? [];
  // a new room goes to the worker holding the FEWEST, so four new rooms even out whatever was
  // already there (a match still inside its reconnect grace, say) rather than adding two each
  const counts = after.map((w) => w.rooms);
  check(
    `B[${s.label}]: new rooms go to the least-loaded worker`,
    counts.length === 2 && Math.abs(counts[0] - counts[1]) <= 1,
    `${JSON.stringify(before.map((w) => w.rooms))} → ${JSON.stringify(counts)}`,
  );
  for (const x of socks) x.close();
}

async function partB(): Promise<void> {
  console.log('\n== B. the real server, in-process and on two workers ==');
  const base = 18_700 + Math.floor(Math.random() * 500);
  const servers = await Promise.all([boot('in-process', base, 0), boot('2 workers', base + 1, 2), boot('production gate, 2 workers', base + 2, 2, '')]);
  try {
    for (const s of servers.slice(0, 2)) await scenarios(s);
    await spread(servers[1]);
    await closedGate(servers[2]);
    for (const s of servers) {
      const errors = s.log.join('').split('\n').filter((l) => /error|exception|failed/i.test(l) && !/deprecated/i.test(l));
      check(`B[${s.label}]: the server logged no errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
    }
  } finally {
    for (const s of servers) s.proc.kill();
  }
}

async function main(): Promise<void> {
  const only = process.argv[2];
  if (only !== 'B') await partA();
  if (only !== 'A') await partB();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
