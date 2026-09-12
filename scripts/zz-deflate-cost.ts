/**
 * zz-deflate-cost — what `permessage-deflate` actually costs and saves ON THE WIRE.
 *
 *   npx tsx scripts/zz-deflate-cost.ts
 *   npx tsx scripts/zz-deflate-cost.ts --secs 20 --shapes decode-solo,chain-solo
 *   npx tsx scripts/zz-deflate-cost.ts --url ws://127.0.0.1:8787   (attach, do not spawn)
 *
 * WHY THIS EXISTS AND WHY THE LOAD HARNESS COULD NOT ANSWER IT. `scripts/loadtest.ts`
 * counts bytes in its `message` handler, and ws hands that handler the DECOMPRESSED
 * payload — so its figure is identical with compression on and off, which it says so
 * itself. That is the right number for "how big is a snapshot" and the WRONG number for
 * "what does egress cost", and egress is the cliff we reach first (`docs/capacity.md`
 * §5). The compression table in §6 closed the gap SYNTHETICALLY, by running 300 captured
 * frames through zlib offline. This measures the real thing: the same room, driven the
 * same way, with the extension negotiated or not, counting TCP bytes off the socket.
 *
 * Two runs per shape, differing in ONE thing — whether the client OFFERS the extension in
 * its upgrade, exactly as a browser does and as ws's client by default does not. Nothing
 * server-side changes between them, because nothing has to: permessage-deflate is
 * negotiated per connection (RFC 7692), so the baseline run measures today's wire on the
 * very same binary. That property is also why enabling it needs no `CLIENT_CAPS` gate.
 *
 * ⚠️ BYTES ARE MACHINE-INDEPENDENT, LATENCY IS NOT. Wire bytes, and therefore the egress
 * bill, are as true on this box as on Fly. Nothing about compression LATENCY can be
 * measured here — see `docs/capacity.md` §0. The probe reports the snapshot RATE only as
 * a sanity check that the two runs were driving the same room, never as a latency claim.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import type { Socket } from 'node:net';
import {
  CLIENT_CAPS,
  quantizeCommand,
  type ClientMsg,
  type ServerMsg,
  type RoomConfig,
  type LobbyPlayer,
} from '../src/net/protocol';
import { generateRoomCode } from '../src/net/roomCode';
import * as C from '../src/config';
import { DEFAULT_SPEC, DEFAULT_ASSISTS } from '../src/sim/spawn';
import type { Alliance, GameId, RobotCommand } from '../src/types';

// ---- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const SECS = Number(flag('secs', '15'));
const SETTLE = Number(flag('settle', '6'));
const URL_IN = flag('url', '');
const PORT = Number(flag('port', '8791'));
/** ⚠️ ASSUMED, not confirmed against the Fly plan — the same assumption `capacity.md` §5
 *  flags. Rates vary by region and an allowance is included, so read the dollars as the
 *  RATIO between the two rows rather than as an invoice. */
const USD_PER_GB = Number(flag('usdpergb', '0.02'));
/** Lowest emitted input rate a measurement window may run at before the run is thrown out.
 *  58 rather than 60 so an ordinary GC pause or a scheduling hitch does not fail a good run,
 *  while the ~32 Hz a raw `setInterval(1000/60)` produces on Windows can never pass. */
const DRIVE_HZ_MIN = Number(flag('minhz', '58'));

interface Seat {
  alliance: Alliance;
  startIndex: number;
}
interface Shape {
  id: string;
  game: GameId;
  config: (g: GameId) => RoomConfig;
  seats: Seat[];
}

const SHAPES: Shape[] = [
  {
    id: 'decode-solo',
    game: 'decode',
    config: (game) => ({ kind: 'record', record: 'solo', game }),
    seats: [{ alliance: 'red', startIndex: 0 }],
  },
  {
    id: 'decode-1v1',
    game: 'decode',
    config: (game) => ({ kind: 'versus', game }),
    seats: [
      { alliance: 'red', startIndex: 0 },
      { alliance: 'blue', startIndex: 0 },
    ],
  },
  {
    id: 'decode-2v2',
    game: 'decode',
    config: (game) => ({ kind: 'versus', game }),
    seats: [
      { alliance: 'red', startIndex: 0 },
      { alliance: 'red', startIndex: 1 },
      { alliance: 'blue', startIndex: 0 },
      { alliance: 'blue', startIndex: 1 },
    ],
  },
  {
    id: 'chain-solo',
    game: 'chain',
    config: (game) => ({ kind: 'record', record: 'solo', game }),
    seats: [{ alliance: 'red', startIndex: 0 }],
  },
];
const WANT = flag('shapes', SHAPES.map((s) => s.id).join(',')).split(',');
const SHAPE_LIST = SHAPES.filter((s) => WANT.includes(s.id));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const log = (s: string): void => console.log(s);
const kb = (n: number): string => (n / 1024).toFixed(1);

/** the same steering the load harness drives with, so a room here costs what a room there
 *  costs. An idle robot skips the ball solve, the shot and the possession clocks, and so
 *  also skips most of what a snapshot has to describe. */
function driverCommand(seed: number, t: number): RobotCommand {
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

function makePlayer(name: string, alliance: Alliance, startIndex: number): Omit<LobbyPlayer, 'clientId'> {
  return {
    name,
    teamName: 'DeflateProbe',
    teamNumber: 36596,
    alliance,
    startIndex,
    ready: true,
    spec: { ...DEFAULT_SPEC, name },
    assists: { ...DEFAULT_ASSISTS },
  };
}

interface Sample {
  down: number;
  up: number;
  app: number;
  snaps: number;
}

class Probe {
  ws: WebSocket | null = null;
  sock: Socket | null = null;
  clientId = '';
  isHost = false;
  inMatch = false;
  serverTick = 0;
  sendTick = 0;
  gen = 0;
  snapshots = 0;
  /** payload bytes ws hands us — DECOMPRESSED, i.e. what `loadtest.ts` reports */
  appBytes = 0;
  extensions = '';
  private mark = { read: 0, written: 0, app: 0, snaps: 0 };

  constructor(
    readonly room: string,
    readonly config: RoomConfig,
    readonly player: Omit<LobbyPlayer, 'clientId'>,
    readonly seed: number,
    readonly offerDeflate: boolean,
  ) {}

  open(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // THE ONE VARIABLE BETWEEN THE TWO RUNS.
      const ws = new WebSocket(url, { perMessageDeflate: this.offerDeflate });
      this.ws = ws;
      // the raw TCP socket is the only place the real wire is visible. `bytesRead` is
      // cumulative for the connection and includes WebSocket framing, so it is the
      // egress number; the decompressed `appBytes` beside it is what the old harness saw.
      ws.on('upgrade', (res) => {
        this.sock = res.socket as Socket;
        this.extensions = String(res.headers['sec-websocket-extensions'] ?? '');
      });
      ws.on('open', () => {
        this.send({
          t: 'join',
          room: this.room,
          player: this.player,
          config: this.config,
          caps: CLIENT_CAPS,
        });
        resolve();
      });
      ws.on('message', (d: Buffer) => this.onMessage(d));
      ws.on('error', (e: Error) => reject(e));
    });
  }

  private send(m: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private onMessage(data: Buffer): void {
    this.appBytes += data.length;
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
      case 'matchStart':
        this.inMatch = true;
        this.gen = m.gen ?? 0;
        break;
      case 'snapshot':
        this.snapshots++;
        this.serverTick = m.serverTick;
        if (this.sendTick < m.serverTick) this.sendTick = m.serverTick;
        break;
      case 'matchResult':
        // a results screen stops producing snapshots, which would silently dilute the
        // window — the host re-authors the match, exactly as the load harness does
        this.inMatch = false;
        if (this.isHost) setTimeout(() => this.send({ t: 'restart' }), 400);
        break;
      default:
        break;
    }
  }

  ready(): void {
    this.send({ t: 'update', patch: { ready: true } });
  }

  start(): void {
    this.send({ t: 'start' });
  }

  tick(tSec: number): void {
    if (!this.inMatch) return;
    this.sendTick++;
    this.send({
      t: 'input',
      tick: this.sendTick,
      q: quantizeCommand(driverCommand(this.seed, tSec)),
      ack: this.serverTick,
      gen: this.gen,
    });
  }

  markStart(): void {
    this.mark = {
      read: this.sock?.bytesRead ?? 0,
      written: this.sock?.bytesWritten ?? 0,
      app: this.appBytes,
      snaps: this.snapshots,
    };
  }

  measure(elapsed: number): Sample {
    return {
      down: ((this.sock?.bytesRead ?? 0) - this.mark.read) / elapsed,
      up: ((this.sock?.bytesWritten ?? 0) - this.mark.written) / elapsed,
      app: (this.appBytes - this.mark.app) / elapsed,
      snaps: (this.snapshots - this.mark.snaps) / elapsed,
    };
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      /* closing an already dead socket is fine */
    }
  }
}

interface Result {
  shape: string;
  offer: boolean;
  negotiated: string;
  down: number;
  up: number;
  app: number;
  snaps: number;
  clients: number;
}

async function runShape(url: string, shape: Shape, offer: boolean): Promise<Result> {
  const code = generateRoomCode();
  const probes = shape.seats.map(
    (s, i) => new Probe(code, shape.config(shape.game), makePlayer(`P${i}`, s.alliance, s.startIndex), i, offer),
  );
  for (const p of probes) {
    await p.open(url);
    await sleep(150);
  }
  await sleep(400);
  for (const p of probes) p.ready();
  await sleep(400);
  (probes.find((p) => p.isHost) ?? probes[0]).start();

  // nothing is counted until the match is actually running
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !probes.every((p) => p.inMatch)) await sleep(100);
  if (!probes.every((p) => p.inMatch)) {
    for (const p of probes) p.close();
    throw new Error(`${shape.id}: match never started`);
  }

  // Drive at 60 Hz throughout, but open the window SETTLE seconds in, so the keyframe
  // re-prime and the countdown fall outside it and steady state is what gets priced.
  //
  // ⚠️ THE INTERVAL IS 5ms WITH AN ACCUMULATOR, NOT `setInterval(1000/60)`, AND THAT IS A
  // WINDOWS FIX — the same one `scripts/loadtest.ts` documents at its own ticker. Windows'
  // default timer granularity is 15.625ms and Node does not raise it, so a 16.67ms request
  // rounds UP to two ticks (~31ms) and the probe drives at ~32 Hz while reporting a 60 Hz
  // room. That silently halves the upstream rate, halves how often the server has a fresh
  // command to fold into a snapshot, and prices a room nobody is playing. A 5ms request
  // rounds up to ONE 15.6ms tick, which is above 60 Hz, so the accumulator below can emit a
  // true 60. On Linux the 5ms is honoured and the accumulator does the same job.
  //
  // And it is ASSERTED rather than reported, because this probe exists to produce numbers
  // somebody will quote in a capacity document: a run that under-drove is not a slightly
  // soft measurement, it is a measurement of a different thing, and it must not be able to
  // print a table. Only the ticks inside the MEASUREMENT window are counted — the settle
  // period is allowed to be ragged while the match starts.
  let last = Date.now();
  let acc = 0;
  let tSec = 0;
  let emitted = 0;
  let counting = false;
  const driver = setInterval(() => {
    const now = Date.now();
    acc += (now - last) / 1000;
    last = now;
    if (acc > 0.25) acc = 0.25; // never fast-forward more than a quarter second
    let n = 0;
    while (acc >= C.SIM_DT && n < 8) {
      tSec += C.SIM_DT;
      for (const p of probes) p.tick(tSec);
      if (counting) emitted++;
      acc -= C.SIM_DT;
      n++;
    }
  }, 5);

  await sleep(SETTLE * 1000);
  for (const p of probes) p.markStart();
  const wStart = Date.now();
  counting = true;
  await sleep(SECS * 1000);
  const elapsed = (Date.now() - wStart) / 1000;
  counting = false;
  clearInterval(driver);
  const hz = emitted / elapsed;
  if (hz < DRIVE_HZ_MIN) {
    for (const p of probes) p.close();
    throw new Error(
      `${shape.id}: the driver only reached ${hz.toFixed(1)} Hz (need >= ${DRIVE_HZ_MIN}). ` +
        'The room was under-driven, so these bytes price a quieter match than the one claimed. ' +
        'Check the platform timer granularity before trusting any earlier run.',
    );
  }

  const ms = probes.map((p) => p.measure(elapsed));
  const negotiated = probes[0].extensions;
  for (const p of probes) p.close();
  await sleep(600);

  const avg = (f: (m: Sample) => number): number => ms.reduce((a, m) => a + f(m), 0) / ms.length;
  return {
    shape: shape.id,
    offer,
    negotiated,
    down: avg((m) => m.down),
    up: avg((m) => m.up),
    app: avg((m) => m.app),
    snaps: avg((m) => m.snaps),
    clients: probes.length,
  };
}

async function waitHealth(base: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(400);
  }
  return false;
}

/** `shell: true` on Windows puts a cmd.exe between us and node, and `kill()` reaps only
 *  the shell — leaving the server holding the port for the next run. Kill the TREE. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

async function main(): Promise<void> {
  let child: ChildProcess | null = null;
  let url = URL_IN;
  if (!url) {
    log(`[probe] spawning the real server on :${PORT}`);
    child = spawn('npx', ['tsx', 'server/index.ts'], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: 'ignore',
      shell: true,
    });
    url = `ws://127.0.0.1:${PORT}`;
    if (!(await waitHealth(`http://127.0.0.1:${PORT}`, 90_000))) {
      killTree(child);
      throw new Error('server did not come up');
    }
  }
  log(`[probe] ${url} · ${SECS}s window after ${SETTLE}s settle · shapes: ${SHAPE_LIST.map((s) => s.id).join(', ')}`);

  const results: Result[] = [];
  try {
    for (const shape of SHAPE_LIST) {
      for (const offer of [false, true]) {
        const r = await runShape(url, shape, offer);
        results.push(r);
        log(
          `  ${r.shape.padEnd(12)} offer=${offer ? 'yes' : 'no '} ext="${r.negotiated || 'none'}" ` +
            `down=${kb(r.down)} KB/s  up=${kb(r.up)} KB/s  app=${kb(r.app)} KB/s  snaps=${r.snaps.toFixed(1)}/s`,
        );
      }
    }
  } finally {
    if (child) killTree(child);
  }

  // ---- report ---------------------------------------------------------------
  log('\n## Wire bytes per client, downstream, steady state\n');
  log('| shape | today (no extension) | with permessage-deflate | saving | app layer (unchanged) |');
  log('|---|---|---|---|---|');
  for (const shape of SHAPE_LIST) {
    const off = results.find((r) => r.shape === shape.id && !r.offer);
    const on = results.find((r) => r.shape === shape.id && r.offer);
    if (!off || !on) continue;
    const pct = ((1 - on.down / off.down) * 100).toFixed(0);
    log(`| ${shape.id} | ${kb(off.down)} KB/s | **${kb(on.down)} KB/s** | **-${pct}%** | ${kb(off.app)} KB/s |`);
  }

  // the measurement is only worth anything if the extension was really in play
  const missing = results.filter((r) => r.offer && !/permessage-deflate/.test(r.negotiated));
  const leaked = results.filter((r) => !r.offer && /permessage-deflate/.test(r.negotiated));
  log('');
  log(
    missing.length === 0
      ? '[ok] the extension NEGOTIATED on every offering run'
      : `[FAIL] offered but not negotiated on: ${missing.map((r) => r.shape).join(', ')}`,
  );
  log(
    leaked.length === 0
      ? '[ok] and was absent on every baseline run'
      : `[FAIL] negotiated on a baseline run: ${leaked.map((r) => r.shape).join(', ')}`,
  );

  // weighted 1,000-concurrent egress on the repo's stated real shape split
  // (6/8 solo, 1/8 1v1, 1/8 2v2 BY ROOM, which is 12 players per 8 rooms)
  const pick = (id: string, offer: boolean): number =>
    results.find((r) => r.shape === id && r.offer === offer)?.down ?? NaN;
  const weights: Array<[string, number]> = [
    ['decode-solo', 6 / 12],
    ['decode-1v1', 2 / 12],
    ['decode-2v2', 4 / 12],
  ];
  if (weights.every(([id]) => SHAPE_LIST.some((s) => s.id === id))) {
    log('\n## 1,000 concurrent, weighted 6/8 solo · 1/8 1v1 · 1/8 2v2 by room\n');
    log(`| | per client | 1,000 clients | per hour | 3-hour peak @ $${USD_PER_GB}/GB | 24 h |`);
    log('|---|---|---|---|---|---|');
    for (const offer of [false, true]) {
      const per = weights.reduce((a, [id, w]) => a + pick(id, offer) * w, 0);
      const gbPerHour = (per * 1000 * 3600) / 1e9;
      log(
        `| ${offer ? '**with deflate**' : 'today'} | ${kb(per)} KB/s | ${((per * 1000) / 1e6).toFixed(0)} MB/s | ` +
          `${gbPerHour.toFixed(0)} GB | **$${(gbPerHour * 3 * USD_PER_GB).toFixed(2)}** | $${(gbPerHour * 24 * USD_PER_GB).toFixed(0)} |`,
      );
    }
  }
  const chainOff = pick('chain-solo', false);
  if (Number.isFinite(chainOff)) {
    log(
      `\nWorst single room measured: chain-solo at ${kb(chainOff)} KB/s uncompressed, ` +
        `${kb(pick('chain-solo', true))} KB/s compressed.`,
    );
  }

  await sleep(300);
  process.exit(0);
}

main().catch((e) => {
  console.error('[probe] failed:', e);
  process.exit(1);
});
