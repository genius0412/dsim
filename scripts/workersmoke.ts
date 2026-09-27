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
 *     is held to the behaviour of the in-process one rather than to a description of it.
 *
 * Kept out of `npm test` for the same reason `test:mm` is: a red `npm test` must keep meaning
 * "physics broke", and this boots two servers and four worker threads.
 */
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
  const t = setInterval(() => {
    const last = snaps(sock).at(-1);
    tick = Math.max(tick + 1, (last?.serverTick ?? 0) + 1);
    room.onMessage(id, { t: 'input', tick, q: quantizeCommand(wander(performance.now() / 1000)), ack: last?.serverTick ?? 0, gen });
  }, 16);
  return () => clearInterval(t);
}

async function partA(): Promise<void> {
  console.log('\n== A. the pool, in this process ==');
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
    this.drive = setInterval(() => {
      this.sendTick = Math.max(this.sendTick + 1, this.serverTick + 1);
      const q = quantizeCommand(wander(performance.now() / 1000));
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

async function boot(label: string, port: number, workers: number): Promise<Server> {
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), SIM_WORKERS: String(workers) };
  // nothing here may reach a real database, identity provider or region router
  for (const k of ['DATABASE_URL', 'NEON_AUTH_URL', 'FLY_REGION', 'SERVER_REGION', 'MAX_ROOMS', 'FLY_MACHINE_ID']) delete env[k];
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
  await sleep(1500);
  check(L('...streams snapshots (≥ 20 in 1.5 s)'), R.snapshots - n3 >= 20, `${R.snapshots - n3}`);
  check(L('...and drives'), R.moved() > 2, `${R.moved().toFixed(1)} in`);
  const capRun = (await perf(s)).capRooms;
  R.close();
  let capAfter = capRun;
  for (let i = 0; i < 30; i++) {
    capAfter = (await perf(s)).capRooms;
    if (capAfter === capRun - 1) break;
    await sleep(100);
  }
  check(L('a solo record run is reaped on a clean close'), capAfter === capRun - 1, `${capRun} → ${capAfter}`);
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
  const servers = await Promise.all([boot('in-process', base, 0), boot('2 workers', base + 1, 2)]);
  try {
    for (const s of servers) await scenarios(s);
    await spread(servers[1]);
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
