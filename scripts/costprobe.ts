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
 * WHAT IT MEASURES, per scenario (DECODE, Chain Reaction and BIOBUZZ, solo + 2v2):
 *   · cores/room       — cpu-seconds per second of match. This is the figure fly.toml's
 *                        sizing block is written against; take it before resizing a VM.
 *   · bytes/snapshot   — the exact `{t:'snapshot'}` frame the server broadcasts.
 *   · KiB/s per CLIENT — the room sends that frame to each client SEPARATELY, so a 2v2
 *                        room's egress is 4x this. Egress is billed; egress IS the bill.
 *                        Reported RAW and on the WIRE: `server/index.ts` runs
 *                        permessage-deflate WITH CONTEXT TAKEOVER, and consecutive 30 Hz
 *                        snapshots are nearly identical to each other, so the window eats
 *                        most of the frame. Egress below is priced on the WIRE column.
 *                        For the wire measured at the TCP layer against the real server
 *                        (which is the authority; this is a zlib model of it), see
 *                        `scripts/zz-deflate-cost.ts`.
 *   · replay KiB       — every persisted match writes one replay row (`server/persist.ts`
 *                        calls `saveReplay` unconditionally), so this is Postgres growth
 *                        per match — the one line here that COMPOUNDS day over day.
 *
 * PLUS, for a scenario that asks for it (`Scenario.fields`), WHAT A NAMED PER-TICK
 * `RobotState` FIELD COSTS — the one number the header above says moves without anyone
 * thinking about the bill. It is measured by re-serializing THE SAME frames with those
 * keys deleted, so it is a difference of one variable and carries none of the confound a
 * separate "robot without the mechanism" scenario would (a robot with no launcher also
 * launches nothing, so its ball delta is a different thing too). BIOBUZZ's `bbTurretPitch`
 * and `bbLiftZ` are priced that way; DECODE and CR name no fields and their frames are
 * byte-identical to what this script measured before the knob existed.
 *
 * WHAT IT IS NOT: a benchmark of Fly's hardware. cores/room is measured on whatever box
 * runs this, so treat the extrapolation as ±30% and confirm against `GET /api/perf`
 * (event-loop lag) on a real machine before sizing anything.
 *
 * THE RATES ARE A SNAPSHOT, stamped below. Re-check them before quoting a number.
 */
import { constants, createDeflateRaw } from 'node:zlib';
import { initPhysics } from '../src/sim/physicsEngine';
import { simModuleFor } from '../src/games/sim';
// `RobotSetup` lives beside the coercer, not in `src/types` — it was imported from there below
// and only ever used behind an `as` cast, so nothing failed and `tsx` (which strips types
// without checking) never looked.
import { DEFAULT_SPEC, PLAYER_ASSISTS, coerceSpec, type RobotSetup } from '../src/sim/spawn';
import { ReplayRecorder, maxMatchTicks } from '../src/sim/replay';
import { slimWorld, encodeBallDelta, quantizeCommand, localizeCommand } from '../src/net/protocol';
import * as C from '../src/config';
// BIOBUZZ's own leaf modules. `coerce.ts` is a dependency of the shared `coerceSpec` and
// imports nothing that reaches back to it, so pulling it (and the constants it already reads)
// into a dev script costs nothing and drags in no DOM. Nothing here is bundled for a client —
// BIOBUZZ is alpha-only and this script is not a product surface.
import { BB_DEFAULT_SPEC } from '../src/games/biobuzz/coerce';
import { BB_HOOD_DEFAULT_DEG, BB_LIFT_MAX_Z } from '../src/games/biobuzz/config';
import type { Artifact, GameId, RobotCommand, RobotSpec, World } from '../src/types';

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
  /**
   * The BUILD this scenario prices, BEFORE coercion. Absent ⇒ the shared `DEFAULT_SPEC`, which
   * is what DECODE and Chain Reaction have always been measured on. It exists for BIOBUZZ,
   * where the mechanism LOADOUT is what decides how many per-tick fields a robot ships.
   */
  spec?: RobotSpec;
  /**
   * Extra command bits this game's mechanisms read, merged over the shared busy-robot command.
   * Absent ⇒ nothing is merged, so DECODE's and CR's frames stay byte-identical to what this
   * script measured before the knob existed — which matters, because a new button bit widens
   * `QCommand.buttons` and would show up as a phantom regression on games that never press it.
   */
  bits?: (tick: number, seat: number) => Partial<RobotCommand>;
  /**
   * PER-TICK `RobotState` FIELDS TO PRICE SEPARATELY, by key. Each snapshot is re-serialized
   * with these deleted and the difference is reported, raw and on the wire — the honest answer
   * to "what did that one-line field cost", which is the question this whole script exists for.
   * A key nothing writes yet costs 0, and that zero is a measurement too: it says the field is
   * declared but never reaches a client.
   */
  fields?: readonly string[];
}

/**
 * A FULLY-EQUIPPED BIOBUZZ ROBOT — a turret AND a vertical extension slide, which is the
 * EXPENSIVE case and therefore the one worth pricing.
 *
 * Both mechanisms write a per-tick `RobotState` field (`bbTurretPitch` from `bbSlewTurret`,
 * `bbLiftZ` from `bbStepLift`), and a field on a robot ships in full on every 30 Hz snapshot to
 * every client in the room — robots are not delta'd, only balls are. A build with neither
 * mechanism is cheaper on the wire and is not what this measurement is for; `fields` below
 * prices the difference exactly, off these same frames, rather than by running a second robot.
 *
 * Built on `BB_DEFAULT_SPEC` (the Sniper demo — already a turret) with the loadout stated
 * explicitly rather than left to `bbLauncherOf`'s migration path, and run through the one
 * coercion chokepoint in `measure` like every other spec here. The lift takes `BB_LIFT_MAX_Z`,
 * R105's height cap: the tallest legal carriage is the one a player builds.
 */
const BB_EQUIPPED: RobotSpec = {
  ...BB_DEFAULT_SPEC,
  bbMech: {
    launcher: { kind: 'turret', mount: 'center', hoodDeg: BB_HOOD_DEFAULT_DEG },
    lift: { kind: 'vslide', mount: 'back', maxZ: BB_LIFT_MAX_Z },
  },
};

/** the two per-tick fields a BIOBUZZ mechanism adds to every robot in every snapshot */
const BB_MECH_FIELDS = ['bbTurretPitch', 'bbLiftZ'] as const;

/**
 * BIOBUZZ command bits. `bbLift` is a HELD level (raise while down), so it is worked on a duty
 * cycle rather than pressed once — a carriage parked at either stop writes a CONSTANT `bbLiftZ`,
 * which the deflate window then hides almost entirely and which would price the field as
 * cheaper than it is. `bbPlace` is an edge and is pressed at the top of each raise.
 */
const bbBits = (tick: number): Partial<RobotCommand> => ({
  bbLift: tick % 240 < 120,
  bbPlace: tick % 240 === 118,
});

const SCENARIOS: Scenario[] = [
  { key: 'decode-solo', game: 'decode', robots: 1, label: 'DECODE solo record run' },
  { key: 'decode-2v2', game: 'decode', robots: 4, label: 'DECODE 2v2 versus' },
  { key: 'chain-solo', game: 'chain', robots: 1, label: 'Chain Reaction solo' },
  { key: 'chain-2v2', game: 'chain', robots: 4, label: 'Chain Reaction 2v2' },
  // BIOBUZZ is `scored: false` and alpha-only, so it reaches no leaderboard and is NOT in the
  // extrapolation below — but a room of it costs exactly what a room of anything else costs,
  // and it is the game currently growing per-tick fields.
  {
    key: 'biobuzz-solo',
    game: 'biobuzz',
    robots: 1,
    label: 'BIOBUZZ solo (turret+lift)',
    spec: BB_EQUIPPED,
    bits: bbBits,
    fields: BB_MECH_FIELDS,
  },
  {
    key: 'biobuzz-2v2',
    game: 'biobuzz',
    robots: 4,
    label: 'BIOBUZZ 2v2 (turret+lift)',
    spec: BB_EQUIPPED,
    bits: bbBits,
    fields: BB_MECH_FIELDS,
  },
];

interface Measured {
  cores: number;
  snapBytes: number;
  downPerClient: number; // bytes/s, raw JSON
  wirePerClient: number; // bytes/s, after permessage-deflate
  upPerClient: number; // bytes/s
  replayKib: number;
  elements: number;
  /** bytes/snapshot attributable to `Scenario.fields`, raw JSON. 0 when none were named. */
  fieldBytes: number;
  /** bytes/s per client attributable to `Scenario.fields`, after permessage-deflate */
  fieldWire: number;
  /** the named fields that were actually PRESENT on a robot at the end of the run. A field
   * nothing writes is absent here, which is why the report prints this rather than `fields`. */
  fieldsSeen: string[];
}

/**
 * What one client's snapshot stream costs ON THE WIRE, modelling the server's
 * permessage-deflate settings: one deflate context per CONNECTION (context takeover —
 * `serverNoContextTakeover: false`, the load-bearing line in `server/index.ts`), level 1,
 * a 15/8 window, and a sync flush at each message boundary, which is what the extension
 * does per RFC 7692. Frames under the server's `threshold` are sent uncompressed.
 *
 * Run AFTER the sim loop, never inside it: zlib runs on the libuv threadpool and
 * `process.cpuUsage()` counts every thread, so compressing inline would land in the
 * cores/room figure and overstate what a room's physics costs.
 */
const THRESHOLD = 1024; // mirrors perMessageDeflate.threshold in server/index.ts
async function wireBytes(frames: string[]): Promise<number> {
  const z = createDeflateRaw({ level: 1, windowBits: 15, memLevel: 8 });
  let total = 0;
  z.on('data', (c: Buffer) => {
    total += c.length;
  });
  for (const f of frames) {
    const buf = Buffer.from(f, 'utf8');
    if (buf.length < THRESHOLD) {
      total += buf.length; // below threshold the server sends it uncompressed
      continue;
    }
    z.write(buf);
    await new Promise<void>((res) => z.flush(constants.Z_SYNC_FLUSH, res));
    // the extension drops each sync-flush block's trailing 00 00 FF FF before framing it
    total -= 4;
  }
  await new Promise<void>((res) => z.end(() => res()));
  return total;
}

/**
 * A busy robot: driving, intaking and firing throughout, and working the catalyst in CR.
 * Not a replay-grade scene — the point is a LOADED room (elements moving, shots in flight,
 * contacts resolving), because an idle room costs neither the CPU nor the bytes that decide
 * the bill. `PLAYER_ASSISTS.fieldCentric` is true, so the drive vector is field-frame.
 */
const command = (tick: number, seat: number, s?: Scenario): RobotCommand => {
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
    // a game's own mechanism buttons, and NOTHING for a scenario that declares none — see
    // `Scenario.bits` for why that matters to the two older games' numbers.
    ...s?.bits?.(tick, seat),
  } as RobotCommand;
};

async function measure(s: Scenario): Promise<Measured> {
  const mod = simModuleFor(s.game);
  // ONE coercion chokepoint, for every scenario's build alike — a spec that reached the sim
  // without it would not be a spec the server could ever be sent, so the bytes would be a
  // measurement of something that cannot happen.
  const base = s.spec ?? DEFAULT_SPEC;
  const setups: RobotSetup[] = [];
  for (let i = 0; i < s.robots; i++) {
    setups.push({
      id: i + 1,
      alliance: i % 2 === 0 ? 'red' : 'blue',
      // a FRESH object per robot, as it always was: nothing downstream should mutate a spec,
      // but four setups sharing one is a class of aliasing bug a measurement must not invent.
      spec: coerceSpec({ ...base }, base, s.game),
      assists: { ...PLAYER_ASSISTS },
      startIndex: Math.floor(i / 2),
      human: true,
    } as RobotSetup);
  }
  const world = mod.createWorld('match', 424242, setups) as World;
  world.match.preCountdown = C.PRE_COUNTDOWN;
  const rec = new ReplayRecorder(424242, setups, 'match', s.game);

  let baseline: Map<number, Artifact> | null = null;
  /** every snapshot frame, deflated after the CPU window closes (see `wireBytes`) */
  const frames: string[] = [];
  /** the SAME frames with `s.fields` deleted off each robot — the counterfactual stream. Empty
   * (and never built) when the scenario names no fields, so nothing changes for DECODE/CR. */
  const bare: string[] = [];
  const priced = s.fields ?? [];
  const fieldsSeen = new Set<string>();
  let snapBytes = 0;
  let bareBytes = 0;
  let snaps = 0;
  let upBytes = 0;
  const cpu0 = process.cpuUsage();
  for (let t = 0; t < TICKS; t++) {
    const local = new Map<number, RobotCommand>();
    // localizeCommand: exactly what the server decodes off the wire, so the sim consumes
    // the QUANTIZED value here too (the same reason solo practice localizes — replay.ts)
    for (const [seat, st] of setups.entries()) local.set(st.id, localizeCommand(command(world.tick + 1, seat, s)));
    mod.step(world, C.SIM_DT, local);
    rec.record(world.tick, local);
    // SNAPSHOT_INTERVAL is 2 in server/room.ts, i.e. 30Hz
    if (world.tick % 2 === 0) {
      const delta = encodeBallDelta(baseline, world.balls);
      // held separately from the stringify so the field pricing below can re-serialize the
      // EXACT same object with two keys removed — a difference of one variable, not of a scene
      const slim = slimWorld(world);
      const payload = {
        t: 'snapshot',
        serverTick: world.tick,
        w: slim,
        balls: delta,
        cmds: world.robots.map((r) => quantizeCommand(local.get(r.id) ?? command(world.tick, 0, s))),
        ackInputTick: world.tick,
      };
      const frame = JSON.stringify(payload);
      frames.push(frame);
      snapBytes += Buffer.byteLength(frame, 'utf8');
      snaps++;
      if (priced.length) {
        // `slimWorld` already copied each robot (`stripSpec` spreads it), so deleting here
        // cannot touch the live world. Do it AFTER the real frame is serialized.
        for (const r of slim.robots) {
          const bag = r as unknown as Record<string, unknown>;
          for (const f of priced) {
            if (bag[f] !== undefined) fieldsSeen.add(f);
            delete bag[f];
          }
        }
        const stripped = JSON.stringify(payload);
        bare.push(stripped);
        bareBytes += Buffer.byteLength(stripped, 'utf8');
      }
      baseline = new Map(world.balls.map((b) => [b.id, b] as const));
    }
    // each client sends its own command every tick
    upBytes += Buffer.byteLength(
      JSON.stringify({ t: 'input', tick: world.tick, cmd: quantizeCommand(command(world.tick, 0, s)) }),
      'utf8',
    );
  }
  const cpu = process.cpuUsage(cpu0);
  const wallS = TICKS * C.SIM_DT;
  const wire = await wireBytes(frames);
  // a SECOND full-stream deflate, from a fresh context, so the two are comparable: the field's
  // wire cost is what the window could NOT hide, and that is only visible across whole streams.
  const bareWire = bare.length ? await wireBytes(bare) : wire;
  return {
    cores: (cpu.user + cpu.system) / 1e6 / wallS,
    snapBytes: snapBytes / snaps,
    downPerClient: snapBytes / wallS,
    wirePerClient: wire / wallS,
    upPerClient: upBytes / wallS,
    replayKib: JSON.stringify(rec.finish()).length / 1024,
    elements: world.balls.length,
    fieldBytes: priced.length ? (snapBytes - bareBytes) / snaps : 0,
    fieldWire: (wire - bareWire) / wallS,
    fieldsSeen: priced.filter((f) => fieldsSeen.has(f)),
  };
}

// ---- report -----------------------------------------------------------------
const n = (v: number, d = 2): string =>
  v.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
const i = (v: number): string => Math.round(v).toLocaleString('en-US');

await initPhysics();

console.log(`\nMEASURED — ${TICKS} ticks (${n(TICKS * C.SIM_DT, 0)}s of match) per scenario, this machine\n`);
console.log('  scenario                    cores/room   B/snap    raw/client   wire/client   up/client    replay');
const results = new Map<string, Measured>();
for (const s of SCENARIOS) {
  const m = await measure(s);
  results.set(s.key, m);
  console.log(
    `  ${s.label.padEnd(26)}${n(m.cores, 4).padStart(10)}   ${i(m.snapBytes).padStart(6)}   ` +
      `${`${n(m.downPerClient / 1024, 1)} KiB/s`.padStart(11)}   ${`${n(m.wirePerClient / 1024, 1)} KiB/s`.padStart(11)}   ` +
      `${`${n(m.upPerClient / 1024, 1)} KiB/s`.padStart(9)}   ${`${i(m.replayKib)} KiB`.padStart(8)}`,
  );
}
console.log(
  `\n  A room sends its frame to EACH client separately, so a 2v2 room's egress is 4x the\n` +
    `  WIRE column. RAW is what a new per-tick field costs before the deflate window hides it.\n` +
    `  Ground elements at the end: ` +
    SCENARIOS.map((s) => `${s.key} ${results.get(s.key)!.elements}`).join(', '),
);

// ---- what a named per-tick RobotState field costs ---------------------------
// Printed only for the scenarios that asked. This is the one number the header calls out as
// moving without anyone noticing: robots are NOT delta'd (only balls are), so every field on
// every robot ships in full, 30 times a second, to every client in the room.
const pricedScenarios = SCENARIOS.filter((s) => (s.fields?.length ?? 0) > 0);
if (pricedScenarios.length) {
  console.log(`\nPER-TICK ROBOTSTATE FIELDS — the same frames, re-serialized without them\n`);
  for (const s of pricedScenarios) {
    const m = results.get(s.key)!;
    const missing = (s.fields ?? []).filter((f) => !m.fieldsSeen.includes(f));
    const share = m.snapBytes > 0 ? (m.fieldBytes / m.snapBytes) * 100 : 0;
    console.log(
      `  ${s.label.padEnd(26)}${`+${i(m.fieldBytes)} B/snap`.padStart(13)} (${n(share, 1)}% of the frame), ` +
        `${`+${n(m.fieldWire / 1024, 2)} KiB/s`.padStart(13)} per client on the wire`,
    );
    console.log(
      `  ${' '.repeat(26)}  written: ${m.fieldsSeen.join(', ') || '(none)'}` +
        (missing.length ? `   ·   declared but NEVER WRITTEN: ${missing.join(', ')}` : ''),
    );
  }
  console.log(
    `\n  A field listed as declared-but-never-written costs nothing today because nothing in the\n` +
      `  step pipeline sets it — that is a fact about the sim, not about the wire, and it starts\n` +
      `  costing the moment something does. Multiply the wire figure by the room's client count\n` +
      `  (4 in a 2v2) for the room's share of egress.`,
  );
}

// Extrapolated on DECODE, the default scored game. Chain Reaction's columns are printed
// above for comparison — its 300 particles make it the pessimistic case for bandwidth.
// BIOBUZZ is deliberately NOT extrapolated: it is `scored: false` and alpha-channel only, so
// there is no population of it to extrapolate FROM. Its per-room columns are the useful half
// and they are printed above; when it becomes a playable season, give it a share here.
const solo = results.get('decode-solo')!;
const v2 = results.get('decode-2v2')!;
const nSolo = CCU * SOLO_SHARE;
const nV2 = CCU * (1 - SOLO_SHARE);
const rooms = nSolo + nV2 / 4;
const cores = nSolo * solo.cores + (nV2 / 4) * v2.cores;
const egressBs = nSolo * solo.wirePerClient + nV2 * v2.wirePerClient;
const egressGbDay = (egressBs * 86400) / 1e9;
const rawGbDay = ((nSolo * solo.downPerClient + nV2 * v2.downPerClient) * 86400) / 1e9;
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
console.log(
  `  egress         ${n(egressBs / 1e6, 1)} MB/s = ${i(egressGbDay)} GB/day on the wire ` +
    `(${i(rawGbDay)} GB/day raw, i.e. deflate is saving $${i((rawGbDay - egressGbDay) * RATES.flyEgressGb)}/day)`,
);
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
  `  Egress is ${n(flyEgress / flyCompute, 1)}x compute on the wire; uncompressed it would be ` +
    `${n((rawGbDay * RATES.flyEgressGb) / flyCompute, 1)}x. permessage-deflate\n` +
    `  (server/index.ts, with context takeover) is what makes this shape affordable — the wire\n` +
    `  column is a zlib MODEL of it and runs optimistic against the TCP-level measurement in\n` +
    `  scripts/zz-deflate-cost.ts, which is the authority. Take the raw column as the ceiling.\n`,
);
