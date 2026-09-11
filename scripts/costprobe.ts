/**
 * HOSTING COST PROBE — what one room actually costs, and what that extrapolates to.
 *
 * Run with: npm run costprobe  [-- --ccu=2000 --solo=0.75 --util=0.65 --ticks=3600]
 *
 * WHY THIS IS A SCRIPT rather than a spreadsheet: every number in a hosting estimate for
 * this app is a property of the SIM, and the sim changes. Per-room CPU moved twice during
 * the Rapier port, and the wire bytes move whenever `slimWorld`/`RobotState` grows a field
 * — which happens without anyone thinking about the bill, because a new per-tick field is
 * a one-line change that then ships 30 times a second to every client in the room. So the
 * estimate is MEASURED here, off the real `step()` and the real slim + ball-delta codec
 * `Room.broadcastSnapshot` sends through, and re-measured whenever someone asks.
 *
 * WHAT IT MEASURES, per scenario (DECODE and Chain Reaction, solo + 2v2):
 *   · cores/room       — cpu-seconds per second of match. This is the figure fly.toml's
 *                        sizing block is written against; take it before resizing a VM.
 *   · bytes/snapshot   — the exact `{t:'snapshot'}` frame the server broadcasts.
 *   · KiB/s per CLIENT — the room sends that frame to each client SEPARATELY, so a 2v2
 *                        room's egress is 4x this. Egress is billed; egress IS the bill.
 *   · replay KiB       — every persisted match writes one replay row (`server/persist.ts`
 *                        calls `saveReplay` unconditionally), so this is Postgres growth
 *                        per match — the one line here that COMPOUNDS day over day.
 *
 * WHAT IT IS NOT: a benchmark of Fly's hardware. cores/room is measured on whatever box
 * runs this, so treat the extrapolation as ±30% and confirm against `GET /api/perf`
 * (event-loop lag) on a real machine before sizing anything.
 *
 * THE RATES ARE A SNAPSHOT, stamped below. Re-check them before quoting a number.
 */
import { initPhysics } from '../src/sim/physicsEngine';
import { simModuleFor } from '../src/games/sim';
import { DEFAULT_SPEC, PLAYER_ASSISTS, coerceSpec } from '../src/sim/spawn';
import { ReplayRecorder, maxMatchTicks } from '../src/sim/replay';
import { slimWorld, encodeBallDelta, quantizeCommand, localizeCommand } from '../src/net/protocol';
import * as C from '../src/config';
import type { Artifact, GameId, RobotCommand, RobotSetup, World } from '../src/types';

// ---- published rates (checked 2026-09-11) -----------------------------------
const RATES = {
  /**
   * Fly performance-8x = 8 DEDICATED vCPU + 16GB at $257.54/mo, so this is the
   * per-vCPU-month price. DEDICATED and not shared because a shared vCPU's sustained
   * floor is 6.25% of a core (5ms of every 80ms period) once its burst balance drains
   * — about NINE busy rooms on today's shared-cpu-4x. That is the flap fly.toml warns
   * about, arriving as soon as the machine is actually busy.
   */
  flyVcpuMonth: 257.54 / 8,
  /**
   * Fly egress: $0.02/GB North America + Europe, $0.04 Asia-Pacific/Oceania/South
   * America, $0.12 Africa/India. Blended low here because the app runs iad/sjc/lhr
   * plus syd/nrt; a player base that skews Asia-Pacific pays closer to $0.04.
   */
  flyEgressGb: 0.025,
  /** Neon Scale: $0.222/CU-hour compute, $0.35/GB-month storage. */
  neonCuHour: 0.222,
  neonStorageGbMonth: 0.35,
  /** Vercel Pro: $20/mo, first 1TB Fast Data Transfer included, then $0.15/GB. */
  vercelMonth: 20,
  vercelGb: 0.15,
  vercelIncludedGb: 1000,
} as const;
const DAYS_PER_MONTH = 30.44;

// ---- knobs ------------------------------------------------------------------
const arg = (name: string, dflt: number): number => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  const v = hit ? Number(hit.slice(name.length + 3)) : NaN;
  return Number.isFinite(v) ? v : dflt;
};
/**
 * Concurrent players CONNECTED TO THE GAME SERVER. Free Drive and solo Practice run
 * entirely client-side and cost only presence polling, so they are NOT in this number
 * — which is the single biggest reason a headline "N players" figure can mislead here.
 */
const CCU = arg('ccu', 2000);
/** share of those in solo record rooms (1 player/room); the rest fill 2v2 rooms (4/room).
 * 0.75 is the mix scripts/fly-deploy.sh's sizing note assumes. */
const SOLO_SHARE = Math.min(1, Math.max(0, arg('solo', 0.75)));
/** how hard a dedicated vCPU is run. The room loop is a FIXED 60Hz step that has to finish
 * inside 16.67ms, so it is sized with headroom, never to 100%. */
const UTIL = arg('util', 0.65);
/** minutes from one match start to the next, per player: 2:38 of match plus countdown,
 * results and lobby. Drives matches/day, hence replay storage growth. */
const CYCLE_MIN = arg('cycle', 4);
/** ticks measured per scenario; a whole match by default */
const TICKS = Math.max(60, Math.round(arg('ticks', maxMatchTicks())));

interface Scenario {
  key: string;
  game: GameId;
  robots: number;
  label: string;
}
const SCENARIOS: Scenario[] = [
  { key: 'decode-solo', game: 'decode', robots: 1, label: 'DECODE solo record run' },
  { key: 'decode-2v2', game: 'decode', robots: 4, label: 'DECODE 2v2 versus' },
  { key: 'chain-solo', game: 'chain', robots: 1, label: 'Chain Reaction solo' },
  { key: 'chain-2v2', game: 'chain', robots: 4, label: 'Chain Reaction 2v2' },
];

interface Measured {
  cores: number;
  snapBytes: number;
  downPerClient: number; // bytes/s
  upPerClient: number; // bytes/s
  replayKib: number;
  elements: number;
}

/**
 * A busy robot: driving, intaking and firing throughout, and working the catalyst in CR.
 * Not a replay-grade scene — the point is a LOADED room (elements moving, shots in flight,
 * contacts resolving), because an idle room costs neither the CPU nor the bytes that decide
 * the bill. `PLAYER_ASSISTS.fieldCentric` is true, so the drive vector is field-frame.
 */
const command = (tick: number, seat: number): RobotCommand => {
  const p = tick / 60 + seat * 1.7;
  return {
    driveX: Math.sin(p * 0.9),
    driveY: Math.cos(p * 0.7),
    rotate: Math.sin(p * 1.3) * 0.5,
    intake: true,
    fire: tick % 90 > 20,
    flipFront: false,
    park: false,
    ld: 0,
    rd: 0,
    catalyst: tick % 300 < 30,
    fling: false,
  } as RobotCommand;
};

function measure(s: Scenario): Measured {
  const mod = simModuleFor(s.game);
  const setups: RobotSetup[] = [];
  for (let i = 0; i < s.robots; i++) {
    setups.push({
      id: i + 1,
      alliance: i % 2 === 0 ? 'red' : 'blue',
      spec: coerceSpec({ ...DEFAULT_SPEC }, DEFAULT_SPEC, s.game),
      assists: { ...PLAYER_ASSISTS },
      startIndex: Math.floor(i / 2),
      human: true,
    } as RobotSetup);
  }
  const world = mod.createWorld('match', 424242, setups) as World;
  world.match.preCountdown = C.PRE_COUNTDOWN;
  const rec = new ReplayRecorder(424242, setups, 'match', s.game);

  let baseline: Map<number, Artifact> | null = null;
  let snapBytes = 0;
  let snaps = 0;
  let upBytes = 0;
  const cpu0 = process.cpuUsage();
  for (let t = 0; t < TICKS; t++) {
    const local = new Map<number, RobotCommand>();
    // localizeCommand: exactly what the server decodes off the wire, so the sim consumes
    // the QUANTIZED value here too (the same reason solo practice localizes — replay.ts)
    for (const [seat, st] of setups.entries()) local.set(st.id, localizeCommand(command(world.tick + 1, seat)));
    mod.step(world, C.SIM_DT, local);
    rec.record(world.tick, local);
    // SNAPSHOT_INTERVAL is 2 in server/room.ts, i.e. 30Hz
    if (world.tick % 2 === 0) {
      const delta = encodeBallDelta(baseline, world.balls);
      snapBytes += Buffer.byteLength(
        JSON.stringify({
          t: 'snapshot',
          serverTick: world.tick,
          w: slimWorld(world),
          balls: delta,
          cmds: world.robots.map((r) => quantizeCommand(local.get(r.id) ?? command(world.tick, 0))),
          ackInputTick: world.tick,
        }),
        'utf8',
      );
      snaps++;
      baseline = new Map(world.balls.map((b) => [b.id, b] as const));
    }
    // each client sends its own command every tick
    upBytes += Buffer.byteLength(
      JSON.stringify({ t: 'input', tick: world.tick, cmd: quantizeCommand(command(world.tick, 0)) }),
      'utf8',
    );
  }
  const cpu = process.cpuUsage(cpu0);
  const wallS = TICKS * C.SIM_DT;
  return {
    cores: (cpu.user + cpu.system) / 1e6 / wallS,
    snapBytes: snapBytes / snaps,
    downPerClient: snapBytes / wallS,
    upPerClient: upBytes / wallS,
    replayKib: JSON.stringify(rec.finish()).length / 1024,
    elements: world.balls.length,
  };
}

// ---- report -----------------------------------------------------------------
const n = (v: number, d = 2): string =>
  v.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
const i = (v: number): string => Math.round(v).toLocaleString('en-US');

await initPhysics();

console.log(`\nMEASURED — ${TICKS} ticks (${n(TICKS * C.SIM_DT, 0)}s of match) per scenario, this machine\n`);
console.log('  scenario                    cores/room   B/snap   down/client   up/client     replay');
const results = new Map<string, Measured>();
for (const s of SCENARIOS) {
  const m = measure(s);
  results.set(s.key, m);
  console.log(
    `  ${s.label.padEnd(26)}${n(m.cores, 4).padStart(10)}   ${i(m.snapBytes).padStart(6)}   ` +
      `${`${n(m.downPerClient / 1024, 1)} KiB/s`.padStart(11)}   ${`${n(m.upPerClient / 1024, 1)} KiB/s`.padStart(9)}   ` +
      `${`${i(m.replayKib)} KiB`.padStart(8)}`,
  );
}
console.log(
  `\n  A room sends its frame to EACH client separately, so a 2v2 room's egress is 4x the\n` +
    `  per-client column. Ground elements at the end: ` +
    SCENARIOS.map((s) => `${s.key} ${results.get(s.key)!.elements}`).join(', '),
);

// Extrapolated on DECODE, the default scored game. Chain Reaction's columns are printed
// above for comparison — its 300 particles make it the pessimistic case for bandwidth.
const solo = results.get('decode-solo')!;
const v2 = results.get('decode-2v2')!;
const nSolo = CCU * SOLO_SHARE;
const nV2 = CCU * (1 - SOLO_SHARE);
const rooms = nSolo + nV2 / 4;
const cores = nSolo * solo.cores + (nV2 / 4) * v2.cores;
const egressBs = nSolo * solo.downPerClient + nV2 * v2.downPerClient;
const egressGbDay = (egressBs * 86400) / 1e9;
const vcpu = cores / UTIL;

const flyCompute = vcpu * (RATES.flyVcpuMonth / DAYS_PER_MONTH);
const flyEgress = egressGbDay * RATES.flyEgressGb;
const matchesDay = rooms * (1440 / CYCLE_MIN);
const replayGbDay = ((nSolo * solo.replayKib + (nV2 / 4) * v2.replayKib) * (1440 / CYCLE_MIN) * 1024) / 1e9;
const neonCompute = 6 * 24 * RATES.neonCuHour; // ~6 CU sustained at this write rate
const neonStorage = (replayGbDay * RATES.neonStorageGbMonth) / DAYS_PER_MONTH;
// client bundle ~1MB gzipped on a cold load, ~1h sessions, ~40% of loads uncached
const vercelGbDay = CCU * 24 * 0.4 * 0.001;
const vercelDay =
  RATES.vercelMonth / DAYS_PER_MONTH +
  Math.max(0, vercelGbDay - RATES.vercelIncludedGb / DAYS_PER_MONTH) * RATES.vercelGb;
const total = flyCompute + flyEgress + neonCompute + neonStorage + vercelDay;
const peakDay = flyCompute + 0.4 * (flyEgress + neonStorage + vercelDay) + 0.6 * neonCompute;

console.log(`\nEXTRAPOLATED — ${i(CCU)} concurrent SERVER-CONNECTED players, ${n(SOLO_SHARE * 100, 0)}% in solo record runs\n`);
console.log(`  rooms          ${i(nSolo)} solo + ${i(nV2 / 4)} 2v2 = ${i(rooms)}`);
console.log(`  sim load       ${n(cores, 1)} cores -> ${i(vcpu)} dedicated vCPU at ${n(UTIL * 100, 0)}% utilisation`);
console.log(`  egress         ${n(egressBs / 1e6, 1)} MB/s = ${i(egressGbDay)} GB/day`);
console.log(`  matches        ${i(matchesDay)}/day -> ${i(replayGbDay)} GB/day of replay rows\n`);
console.log(`  Fly compute    $${i(flyCompute)}/day`);
console.log(`  Fly egress     $${i(flyEgress)}/day`);
console.log(`  Neon compute   $${i(neonCompute)}/day`);
console.log(
  `  Neon storage   $${n(neonStorage, 2)}/day today — but it COMPOUNDS: ` +
    `$${i(replayGbDay * 30 * RATES.neonStorageGbMonth)}/mo by the end of a month like this one`,
);
console.log(`  Vercel         $${i(vercelDay)}/day`);
console.log(`  ${'-'.repeat(46)}`);
console.log(`  TOTAL          $${i(total)}/day, sustained 24h`);
console.log(`                 $${i(peakDay)}/day if ${i(CCU)} is the PEAK and the day averages 40% of it\n`);
console.log(
  `  Egress is ${n(flyEgress / flyCompute, 1)}x compute, because a snapshot is the full world as JSON at\n` +
    `  30Hz. Halving the snapshot rate, or a binary codec, moves the bill further than any\n` +
    `  machine size does — re-run this after either.\n`,
);
