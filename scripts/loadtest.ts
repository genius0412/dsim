/**
 * LOAD HARNESS — `npx tsx scripts/loadtest.ts`.
 *
 * N headless clients speaking the REAL wire protocol (`src/net/protocol.ts`) against a
 * REAL server (`npm run server` locally, or `wss://dsim-alpha.fly.dev` once it is
 * deployed). Nothing here re-implements the protocol: every message is built from the
 * exported `ClientMsg`/`ServerMsg` types and every command goes through
 * `quantizeCommand`, so a bot's traffic is byte-for-byte what a browser sends.
 *
 * WHAT IT MEASURES, and why each one is here:
 *   · snapshot inter-arrival p50/p99 + JITTER — the server broadcasts at 30 Hz, so the
 *     gap should sit at 33.3ms. CLAUDE.md's netcode section is explicit that jitter, not
 *     mean rate, is the signal players experience as stutter, so it is the headline.
 *   · RTT p50/p99 from `ping`/`pong` — the same probe the connection-quality HUD uses.
 *   · BYTES/S PER CLIENT — the input to the "is JSON the bottleneck" question. Measured
 *     before anyone proposes a compact encoding.
 *   · RECONCILE DISTANCE — how far the client's prediction had drifted when the
 *     authoritative snapshot landed, computed exactly as `game.ts reconcile` does
 *     (`hypot(predicted - authoritative)` for the local robot). This is the only metric
 *     that needs a real sim, so it is opt-in for a handful of clients (`--predict`):
 *     every predicting bot runs a 60 Hz Rapier step IN THIS PROCESS and would otherwise
 *     make the harness, not the server, the thing being measured.
 *   · DISCONNECTS / errors — a cliff usually announces itself as a drop, not a slowdown.
 *
 * ⚠️ THE HARNESS COMPETES WITH THE SERVER FOR CPU when both run on this laptop. Always
 * read `/api/perf` (polled automatically, printed in the report) rather than trusting the
 * client-side numbers alone: if `cores` is near the box's core count, the machine is
 * saturated and BOTH sides are late. For a clean sweep, run the server on one box and the
 * harness on another, or keep `--predict 0`.
 *
 * ⚠️ THE MATCHMAKER PATH NEEDS REAL ACCOUNTS. `server/index.ts` refuses `queue` without a
 * verified Neon Auth JWT ("Sign in to play ranked"), and there is no dev bypass — so
 * `--path queue` requires `--tokens <file>` (one JWT per line, from a signed-in browser's
 * `getAuthToken()`). Without it the run refuses rather than silently measuring nothing.
 *
 * EXAMPLES
 *   # local baseline: 10 solo record rooms for 60s
 *   npx tsx scripts/loadtest.ts --rooms 10 --shape solo --secs 60
 *   # the sweep step from docs/capacity.md
 *   npx tsx scripts/loadtest.ts --rooms 40 --shape mix --secs 90 --json out/40.json
 *   # against the alpha preview
 *   npx tsx scripts/loadtest.ts --url wss://dsim-alpha.fly.dev --region iad --rooms 20 --secs 90
 */
import { WebSocket } from 'ws';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import {
  quantizeCommand,
  dequantizeCommand,
  localizeCommand,
  applyBallDelta,
  unslimWorld,
  CLIENT_CAPS,
  type ClientMsg,
  type ServerMsg,
  type RoomConfig,
  type LobbyPlayer,
} from '../src/net/protocol';
import { generateRoomCode } from '../src/net/roomCode';
import { DEFAULT_SPEC, DEFAULT_ASSISTS, type RobotSetup } from '../src/sim/spawn';
import { simModuleFor } from '../src/games/sim';
import { initPhysics } from '../src/sim/physicsEngine';
import * as C from '../src/config';
import type { Alliance, Artifact, GameId, RobotCommand, RobotSpec, World } from '../src/types';

// ---- CLI --------------------------------------------------------------------

type Shape = '1v1' | '2v2' | 'solo' | 'duo' | 'mix';
type Path = 'code' | 'queue';

interface Opts {
  url: string;
  http: string;
  rooms: number;
  shape: Shape;
  game: GameId | 'mix';
  path: Path;
  secs: number;
  ramp: number;
  predict: number;
  region: string;
  json: string;
  tokens: string[];
  quiet: boolean;
  idle: boolean;
}

function parseArgs(argv: string[]): Opts {
  const get = (k: string, d?: string): string | undefined => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
  };
  const has = (k: string): boolean => argv.includes(`--${k}`);
  const url = (get('url', 'ws://localhost:8787') as string).replace(/\/$/, '');
  // the HTTP origin for /api/perf is the same host with the ws scheme swapped
  const http = get('perf') ?? url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
  const tokensFile = get('tokens');
  let tokens: string[] = [];
  if (tokensFile) {
    tokens = readFileSync(tokensFile, 'utf8')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith('#'));
  }
  return {
    url,
    http,
    rooms: Number(get('rooms', '10')),
    shape: (get('shape', 'mix') as Shape),
    game: (get('game', 'decode') as GameId | 'mix'),
    path: (get('path', 'code') as Path),
    secs: Number(get('secs', '60')),
    ramp: Number(get('ramp', '10')),
    predict: Number(get('predict', '2')),
    region: get('region', '') as string,
    json: get('json', '') as string,
    tokens,
    quiet: has('quiet'),
    idle: has('idle'),
  };
}

// ---- stats helpers ----------------------------------------------------------

/** p-th percentile of a sample (nearest-rank on a sorted copy). Returns 0 when empty
 *  so a client that never received anything reports 0 rather than NaN — an absent
 *  sample is already visible as a zero `count` beside it. */
function pct(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
/** MEAN ABSOLUTE DEVIATION, the same jitter definition `serverSession.ts` reports to the
 *  HUD — deliberately not stddev, so the number the harness prints and the number a player
 *  sees on the dot are the same statistic. */
const jitterOf = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return mean(xs.map((x) => Math.abs(x - m)));
};
const r2 = (n: number): number => Math.round(n * 100) / 100;

// ---- one virtual client -----------------------------------------------------

/** a bot's synthetic driver: a wandering stick + periodic buttons.
 *
 * NOT a parked robot. An idle robot is the cheapest possible tick — no drive solve, no
 * intake scan, no shot — so a capacity number measured with parked bots is a number the
 * real game never sees. Each bot gets its own phase offsets so a room full of them does
 * not move in lockstep (which would also be unrealistically cheap: identical robots
 * collide identically). */
const ZERO_DRIVE: RobotCommand = {
  driveX: 0, driveY: 0, rotate: 0, leftDrive: 0, rightDrive: 0,
  intake: false, fire: false, catalyst: false, fling: false, driveMode: false,
};

function driverCommand(seed: number, t: number, idle: boolean): RobotCommand {
  // `--idle` parks every robot. It is a CONTROL, not a mode anyone should quote a
  // capacity from: the difference between this and the driving bot is the cost of the
  // ball solve, the intake scan, the shot and the possession clocks, i.e. of the game
  // actually being played. It exists to explain a per-room number measured elsewhere.
  if (idle) return ZERO_DRIVE;
  const a = seed * 0.7391;
  return {
    driveX: Math.sin(t * 0.9 + a) * 0.8,
    driveY: Math.cos(t * 0.6 + a * 2) * 0.8,
    rotate: Math.sin(t * 0.35 + a * 3) * 0.6,
    leftDrive: Math.sin(t * 0.9 + a) * 0.8,
    rightDrive: Math.cos(t * 0.9 + a) * 0.8,
    intake: Math.sin(t * 0.5 + a) > 0,
    fire: Math.sin(t * 0.23 + a * 5) > 0.7,
    catalyst: Math.sin(t * 0.17 + a * 7) > 0.85,
    fling: false,
    driveMode: false,
  };
}

interface ClientStats {
  snapGaps: number[];
  rtts: number[];
  reconcile: number[];
  bytesIn: number;
  msgsIn: number;
  snapshots: number;
  disconnects: number;
  errors: string[];
  joinedAt: number;
  matchStartAt: number;
}

class Bot {
  readonly stats: ClientStats = {
    snapGaps: [],
    rtts: [],
    reconcile: [],
    bytesIn: 0,
    msgsIn: 0,
    snapshots: 0,
    disconnects: 0,
    errors: [],
    joinedAt: 0,
    matchStartAt: 0,
  };
  private ws: WebSocket | null = null;
  clientId = '';
  isHost = false;
  inMatch = false;
  closed = false;
  /** newest authoritative tick, and the tick this bot stamps its next input with.
   *  Resynced off every snapshot: an input stamped far in the future is BUFFERED by
   *  `Room.onInput` in a per-robot pending map that is only pruned once the world
   *  reaches that tick, so a bot that free-runs its own counter would grow the
   *  server's memory instead of loading it. */
  private serverTick = 0;
  private sendTick = 0;
  private gen = 0;
  private robotId = -1;
  private lastSnapAt = 0;

  // --- prediction (only for `--predict` bots) ---
  private predicting = false;
  private world: World | null = null;
  private game: GameId = 'decode';
  private specs = new Map<number, RobotSpec>();
  private baseBalls = new Map<number, Artifact>();
  private remoteCmds = new Map<number, RobotCommand>();
  private inputBuf: { tick: number; cmd: RobotCommand }[] = [];

  constructor(
    readonly label: string,
    private readonly url: string,
    private readonly room: string,
    private readonly config: RoomConfig,
    private readonly player: Omit<LobbyPlayer, 'clientId'>,
    private readonly seed: number,
    private readonly idle: boolean,
    private readonly authToken?: string,
  ) {}

  enablePrediction(): void {
    this.predicting = true;
  }

  open(): Promise<void> {
    return new Promise((resolve) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.on('open', () => {
        this.send({
          t: 'join',
          room: this.room,
          player: this.player,
          config: this.config,
          caps: CLIENT_CAPS,
          ...(this.authToken ? { authToken: this.authToken } : {}),
        });
        this.stats.joinedAt = Date.now();
        resolve();
      });
      ws.on('message', (data: Buffer) => this.onMessage(data));
      ws.on('close', () => {
        this.ws = null;
        if (!this.closed) this.stats.disconnects++;
      });
      ws.on('error', (e: Error) => {
        if (!this.closed) this.stats.errors.push(e.message);
      });
    });
  }

  private send(m: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private onMessage(data: Buffer): void {
    this.stats.bytesIn += data.length;
    this.stats.msgsIn++;
    let m: ServerMsg;
    try {
      m = JSON.parse(data.toString()) as ServerMsg;
    } catch {
      return;
    }
    switch (m.t) {
      case 'welcome':
        this.clientId = m.clientId;
        break;
      case 'roster':
        this.isHost = m.hostId === this.clientId;
        break;
      case 'error':
        this.stats.errors.push(m.message);
        break;
      case 'pong':
        this.stats.rtts.push(performance.now() - m.ts);
        break;
      case 'matchStart':
        this.inMatch = true;
        this.gen = m.gen ?? 0;
        this.robotId = m.yourRobotId;
        this.game = m.game ?? 'decode';
        this.stats.matchStartAt = Date.now();
        this.specs.clear();
        for (const s of m.setups as RobotSetup[]) this.specs.set(s.id, s.spec);
        // a fresh match is a fresh baseline: the next snapshot is a keyframe
        this.baseBalls.clear();
        this.world = null;
        this.inputBuf = [];
        this.remoteCmds.clear();
        break;
      case 'snapshot': {
        const now = performance.now();
        if (this.lastSnapAt > 0) this.stats.snapGaps.push(now - this.lastSnapAt);
        this.lastSnapAt = now;
        this.stats.snapshots++;
        this.serverTick = m.serverTick;
        if (this.sendTick < m.serverTick) this.sendTick = m.serverTick;
        if (this.predicting) this.reconcile(m);
        break;
      }
      case 'matchResult':
        // keep the load going: the host re-authors the match with a fresh seed rather
        // than leaving the room parked on a results screen for the rest of the window
        this.inMatch = false;
        this.lastSnapAt = 0;
        if (this.isHost) setTimeout(() => this.send({ t: 'restart' }), 500);
        break;
      default:
        break;
    }
  }

  /** mirrors `game.ts reconcile`: adopt the authoritative world, drop the inputs it
   *  already folded in, replay the rest, and record how far the prediction had drifted */
  private reconcile(m: Extract<ServerMsg, { t: 'snapshot' }>): void {
    const balls = applyBallDelta(this.baseBalls, m.balls);
    const world = unslimWorld(m.w, balls, (id) => this.specs.get(id) ?? DEFAULT_SPEC);
    const pre = this.world?.robots.find((r) => r.id === this.robotId);
    const preX = pre?.pos.x ?? 0;
    const preY = pre?.pos.y ?? 0;
    this.world = world;
    // `cmds[i]` is the command robot `w.robots[i]` ran this tick (protocol.ts) — held so
    // remote robots are PREDICTED forward and actually collide, as game.ts does
    this.remoteCmds = new Map(m.cmds.map((q, i) => [world.robots[i]?.id ?? i, dequantizeCommand(q)]));
    this.inputBuf = this.inputBuf.filter((b) => b.tick > m.serverTick);
    const mod = simModuleFor(this.game);
    for (const b of this.inputBuf) mod.step(world, C.SIM_DT, this.cmdMap(b.cmd));
    const post = world.robots.find((r) => r.id === this.robotId);
    if (pre && post) this.stats.reconcile.push(Math.hypot(preX - post.pos.x, preY - post.pos.y));
  }

  private cmdMap(local: RobotCommand): Map<number, RobotCommand> {
    const m = new Map(this.remoteCmds);
    if (this.robotId >= 0) m.set(this.robotId, local);
    return m;
  }

  /** one 60 Hz driver tick: send the input a browser would send, and (if predicting)
   *  step the local world with it exactly as `stepServer` does */
  tick(tSec: number): void {
    if (!this.inMatch) return;
    const cmd = driverCommand(this.seed, tSec, this.idle);
    this.sendTick++;
    this.send({
      t: 'input',
      tick: this.sendTick,
      q: quantizeCommand(cmd),
      ack: this.serverTick,
      gen: this.gen,
    });
    if (this.predicting && this.world) {
      const local = localizeCommand(cmd);
      this.inputBuf.push({ tick: this.sendTick, cmd: local });
      simModuleFor(this.game).step(this.world, C.SIM_DT, this.cmdMap(local));
      if (this.inputBuf.length > 600) this.inputBuf.splice(0, this.inputBuf.length - 600);
    }
  }

  ping(): void {
    // the server echoes `ts` verbatim, so it can be ANY clock — use the monotonic one.
    // Date.now() is wall-clock and is both coarser and liable to step under NTP.
    this.send({ t: 'ping', ts: performance.now() });
  }

  start(): void {
    this.send({ t: 'start' });
  }

  ready(): void {
    this.send({ t: 'update', patch: { ready: true } });
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}

// ---- room plan --------------------------------------------------------------

interface RoomPlan {
  code: string;
  config: RoomConfig;
  seats: { alliance: Alliance; startIndex: number }[];
}

/** the seat layout for a room shape. `mix` follows the repo's stated real-world split
 *  (docs/deploy.md + fly-deploy.sh: "~75% of games are solo record runs"), so a `mix`
 *  sweep loads the server the way the season actually will rather than the way a
 *  2v2-only test would. */
function planRooms(o: Opts): RoomPlan[] {
  const plans: RoomPlan[] = [];
  const shapeFor = (i: number): Exclude<Shape, 'mix'> => {
    if (o.shape !== 'mix') return o.shape;
    const r = i % 8;
    if (r < 6) return 'solo'; // 75%
    if (r === 6) return '1v1';
    return '2v2';
  };
  for (let i = 0; i < o.rooms; i++) {
    const shape = shapeFor(i);
    const game: GameId = o.game === 'mix' ? (i % 4 === 3 ? 'chain' : 'decode') : o.game;
    const bare = generateRoomCode();
    const code = o.region ? `${o.region}-${bare}` : bare;
    if (shape === 'solo') {
      plans.push({ code, config: { kind: 'record', record: 'solo', game }, seats: [{ alliance: 'red', startIndex: 0 }] });
    } else if (shape === 'duo') {
      plans.push({
        code,
        config: { kind: 'record', record: 'duo', game },
        seats: [{ alliance: 'red', startIndex: 0 }, { alliance: 'red', startIndex: 1 }],
      });
    } else if (shape === '1v1') {
      plans.push({
        code,
        config: { kind: 'versus', game },
        seats: [{ alliance: 'red', startIndex: 0 }, { alliance: 'blue', startIndex: 0 }],
      });
    } else {
      plans.push({
        code,
        config: { kind: 'versus', game },
        seats: [
          { alliance: 'red', startIndex: 0 },
          { alliance: 'red', startIndex: 1 },
          { alliance: 'blue', startIndex: 0 },
          { alliance: 'blue', startIndex: 1 },
        ],
      });
    }
  }
  return plans;
}

function makePlayer(name: string, alliance: Alliance, startIndex: number): Omit<LobbyPlayer, 'clientId'> {
  return {
    name,
    teamName: 'LoadTest',
    teamNumber: 36596,
    alliance,
    startIndex,
    ready: true,
    spec: { ...DEFAULT_SPEC, name },
    assists: { ...DEFAULT_ASSISTS },
  };
}

// ---- /api/perf --------------------------------------------------------------

interface PerfSample {
  region?: string;
  machine?: string;
  cores?: number;
  rooms?: number;
  players?: number;
  rssMb?: number;
  heapMb?: { used: number; total: number; limit: number };
  windowS?: number;
  loopLagMs?: { mean: number; p50: number; p99: number; max: number };
}

async function perf(http: string, reset = false): Promise<PerfSample | null> {
  try {
    const res = await fetch(`${http}/api/perf${reset ? '?reset=1' : ''}`);
    if (!res.ok) return null;
    return (await res.json()) as PerfSample;
  } catch {
    return null;
  }
}

// ---- run --------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  const log = (s: string): void => {
    if (!o.quiet) console.log(s);
  };

  if (o.path === 'queue' && o.tokens.length === 0) {
    console.error(
      'ERROR: --path queue needs --tokens <file>.\n' +
        '  `server/index.ts` refuses a `queue` message without a verified Neon Auth JWT\n' +
        '  ("Sign in to play ranked") and there is no dev bypass, so a token-less matchmaker\n' +
        '  run would measure nothing but the refusal. Supply one JWT per line (copy from a\n' +
        "  signed-in browser's getAuthToken()), or test the matchmaker with real humans —\n" +
        '  see docs/launch-load-test.md.',
    );
    process.exit(2);
  }
  if (o.path === 'queue') {
    console.error('ERROR: --path queue is not implemented yet (step 2 of the load plan). Use --path code.');
    process.exit(2);
  }

  if (o.predict > 0) {
    log('[loadtest] loading Rapier (predicting clients run the real sim) …');
    await initPhysics();
  }

  const plans = planRooms(o);
  const totalSeats = plans.reduce((n, p) => n + p.seats.length, 0);
  log(
    `[loadtest] ${plans.length} rooms / ${totalSeats} clients · shape=${o.shape} game=${o.game} ` +
      `· ${o.secs}s window · ramp ${o.ramp}s · predict ${o.predict}${o.idle ? ' · IDLE robots (control run)' : ''} · ${o.url}`,
  );

  const bots: Bot[] = [];
  const roomBots: Bot[][] = [];
  let seed = 0;
  let predictLeft = o.predict;
  for (const p of plans) {
    const group: Bot[] = [];
    for (let s = 0; s < p.seats.length; s++) {
      const seat = p.seats[s];
      // the ws URL carries the ROUTING hint only (`?room=`); the room code itself
      // travels in the `join` message, exactly as the browser does it
      const url = `${o.url}/?room=${encodeURIComponent(p.code)}`;
      const b = new Bot(
        `${p.code}#${s}`,
        url,
        p.code,
        p.config,
        makePlayer(`Bot-${seed}`, seat.alliance, seat.startIndex),
        seed,
        o.idle,
      );
      if (predictLeft > 0 && s === 0) {
        b.enablePrediction();
        predictLeft--;
      }
      seed++;
      group.push(b);
      bots.push(b);
    }
    roomBots.push(group);
  }

  // RAMP the joins. A thundering herd is its own (interesting) test, but it is not the
  // steady-state capacity question — and a simultaneous 250-room create would measure
  // the join path, not the tick loop. Ramp separately when that is the question.
  const stepMs = plans.length > 1 ? (o.ramp * 1000) / plans.length : 0;
  for (let i = 0; i < roomBots.length; i++) {
    const group = roomBots[i];
    for (const b of group) await b.open();
    // the host is whoever the server made host (first in) — it drives `start`
    await sleep(60);
    for (const b of group) b.ready();
    await sleep(40);
    const host = group.find((b) => b.isHost) ?? group[0];
    host.start();
    if (stepMs > 0) await sleep(stepMs);
  }

  // let every room actually reach `matchStart` before the measurement window opens
  await sleep(2000);
  const started = bots.filter((b) => b.stats.matchStartAt > 0).length;
  log(`[loadtest] ${started}/${bots.length} clients in a match; measuring for ${o.secs}s …`);

  // HARNESS EVENT-LOOP LAG — the check that makes every other number admissible.
  //
  // This process parses every snapshot for every bot and sends every input. If ITS loop
  // falls behind, it drains the sockets late, the server's send buffers back up, and the
  // measured "server is slow" is really "the measuring instrument is slow" — a mistake that
  // looks exactly like a server cliff and would put a wrong number in docs/capacity.md.
  // Same histogram and same 1ms resolution as the server's own probe, so the two are
  // directly comparable: a run whose harness lag is in the server's league proves nothing
  // and must be re-run with the load split across more harness processes.
  const harnessLag = monitorEventLoopDelay({ resolution: 1 });
  harnessLag.enable();

  const perfBefore = await perf(o.http, true); // zero the lag histogram: scope it to THIS window
  const t0 = Date.now();
  // clear the arrival-gap history collected during the ramp — those gaps include the
  // join/start transient and would pollute the steady-state percentiles
  for (const b of bots) {
    b.stats.snapGaps.length = 0;
    b.stats.rtts.length = 0;
    b.stats.reconcile.length = 0;
    b.stats.bytesIn = 0;
    b.stats.msgsIn = 0;
    b.stats.snapshots = 0;
  }

  // ONE ticker for every bot, with an accumulator — not a timer per client. N independent
  // intervals drift apart and the harness would manufacture its own input jitter on top of
  // whatever the server has.
  //
  // ⚠️ THE INTERVAL IS 5ms, NOT 16.67ms, AND THAT IS A WINDOWS FIX. Windows' default timer
  // granularity is 15.625ms and Node does not raise it, so `setInterval(16.67)` actually
  // fires every ~31ms — MEASURED on the dev box at 34.5 Hz, i.e. half the intended rate, so
  // every bot would send input at 30 Hz while claiming 60. A 5ms request rounds up to one
  // 15.6ms tick (measured 63.8 Hz), which is above 60, so the accumulator below emits a
  // true 60 Hz. On Linux the request is honoured as ~5ms and the accumulator does the same
  // job. `tickFires`/`ticksEmitted` are reported so a run that still fell short is visible
  // rather than silently under-loading the server.
  let last = performance.now();
  let acc = 0;
  let tSec = 0;
  let tickFires = 0;
  let ticksEmitted = 0;
  const ticker = setInterval(() => {
    const now = performance.now();
    acc += (now - last) / 1000;
    last = now;
    tickFires++;
    if (acc > 0.25) acc = 0.25;
    let n = 0;
    while (acc >= C.SIM_DT && n < 8) {
      tSec += C.SIM_DT;
      for (const b of bots) b.tick(tSec);
      ticksEmitted++;
      acc -= C.SIM_DT;
      n++;
    }
  }, 5);
  const pinger = setInterval(() => {
    for (const b of bots) b.ping();
  }, 1000);

  await sleep(o.secs * 1000);
  clearInterval(ticker);
  clearInterval(pinger);
  const elapsed = (Date.now() - t0) / 1000;
  const perfAfter = await perf(o.http);
  for (const b of bots) b.close();
  await sleep(300);

  // ---- report ----
  const allGaps = bots.flatMap((b) => b.stats.snapGaps);
  const allRtt = bots.flatMap((b) => b.stats.rtts);
  const allRec = bots.flatMap((b) => b.stats.reconcile);
  const perClientJitter = bots.map((b) => jitterOf(b.stats.snapGaps)).filter((x) => x > 0);
  const bytesPerClientPerSec = bots.map((b) => b.stats.bytesIn / elapsed);
  const drops = bots.reduce((n, b) => n + b.stats.disconnects, 0);
  const errs = new Map<string, number>();
  for (const b of bots) for (const e of b.stats.errors) errs.set(e, (errs.get(e) ?? 0) + 1);

  const summary = {
    at: new Date().toISOString(),
    opts: { ...o, tokens: o.tokens.length },
    rooms: plans.length,
    clients: bots.length,
    clientsInMatch: bots.filter((b) => b.stats.matchStartAt > 0).length,
    windowS: r2(elapsed),
    snapshotGapMs: {
      p50: r2(pct(allGaps, 50)),
      p99: r2(pct(allGaps, 99)),
      mean: r2(mean(allGaps)),
      jitterMeanAbsDev: r2(mean(perClientJitter)),
      worstClientJitter: r2(Math.max(0, ...perClientJitter)),
      samples: allGaps.length,
    },
    rttMs: { p50: r2(pct(allRtt, 50)), p99: r2(pct(allRtt, 99)), samples: allRtt.length },
    reconcileIn: { p50: r2(pct(allRec, 50)), p99: r2(pct(allRec, 99)), samples: allRec.length },
    bytesPerClientPerSec: {
      mean: Math.round(mean(bytesPerClientPerSec)),
      p99: Math.round(pct(bytesPerClientPerSec, 99)),
    },
    totalKbPerSec: r2(bytesPerClientPerSec.reduce((a, b) => a + b, 0) / 1024),
    disconnects: drops,
    // HARNESS SELF-CHECK: did this process actually pace 60 Hz? `inputHz` well under 60
    // means the harness under-loaded the server and the capacity number is optimistic.
    harness: {
      tickFires,
      ticksEmitted,
      inputHz: r2(ticksEmitted / elapsed),
      predictingClients: o.predict,
      loopLagMs: {
        p50: r2(harnessLag.percentile(50) / 1e6),
        p99: r2(harnessLag.percentile(99) / 1e6),
        max: r2(harnessLag.max / 1e6),
      },
    },
    errors: [...errs.entries()].map(([message, n]) => ({ message, n })),
    perfBefore,
    perfAfter,
  };

  const line = (k: string, v: string): string => `  ${k.padEnd(28)} ${v}`;
  console.log('');
  console.log(`LOADTEST — ${plans.length} rooms, ${bots.length} clients, ${r2(elapsed)}s`);
  console.log(line('snapshot gap p50/p99', `${summary.snapshotGapMs.p50} / ${summary.snapshotGapMs.p99} ms   (target 33.3)`));
  console.log(line('snapshot jitter (mean)', `${summary.snapshotGapMs.jitterMeanAbsDev} ms   worst client ${summary.snapshotGapMs.worstClientJitter} ms`));
  console.log(line('RTT p50/p99', `${summary.rttMs.p50} / ${summary.rttMs.p99} ms`));
  console.log(line('reconcile p50/p99', `${summary.reconcileIn.p50} / ${summary.reconcileIn.p99} in   (${summary.reconcileIn.samples} samples)`));
  console.log(line('bytes/s per client', `${summary.bytesPerClientPerSec.mean} mean, ${summary.bytesPerClientPerSec.p99} p99`));
  console.log(line('total downstream', `${summary.totalKbPerSec} KB/s`));
  console.log(line('disconnects', String(drops)));
  console.log(line('harness input rate', `${summary.harness.inputHz} Hz (target 60 — below it the server was under-loaded)`));
  console.log(
    line(
      'harness loop lag',
      `p50 ${summary.harness.loopLagMs.p50} p99 ${summary.harness.loopLagMs.p99} max ${summary.harness.loopLagMs.max} ms` +
        `  (if this is in the server's league, the HARNESS is the bottleneck — split the load)`,
    ),
  );
  if (summary.errors.length) {
    for (const e of summary.errors) console.log(line('server error', `${e.n}× ${e.message}`));
  }
  if (perfAfter) {
    console.log(
      line(
        'server /api/perf',
        `cores ${perfAfter.cores} · rooms ${perfAfter.rooms} · players ${perfAfter.players} · ` +
          `rss ${perfAfter.rssMb}MB · loopLag p50 ${perfAfter.loopLagMs?.p50} p99 ${perfAfter.loopLagMs?.p99} max ${perfAfter.loopLagMs?.max} ms`,
      ),
    );
    console.log(line('', `(budget is 16.67 ms — p99 approaching it means the tick loop is late)`));
  } else {
    console.log(line('server /api/perf', 'unreachable — pass --perf <http origin> if it is not derivable from --url'));
  }
  console.log('');

  if (o.json) {
    mkdirSync(dirname(o.json), { recursive: true });
    writeFileSync(o.json, JSON.stringify(summary, null, 2));
    log(`[loadtest] wrote ${o.json}`);
  }
  process.exit(0);
}

void main();
