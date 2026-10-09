/**
 * THE AI BENCH — `npm run bench:ai`. Full BIOBUZZ matches with bots at every tier, measured.
 *
 * `aismoke.ts` (`npm run test:ai`) asserts an ORDERING. This one MEASURES: for each tier it plays
 * whole matches, to the buzzer and through the settle window, and reports what a coach would
 * write down watching them — points, tips, scoring cycles, fouls by rule, and the two ways a bot
 * wastes a match without anything on the scoreboard saying so, TIME STUCK and TIME IDLE. It is a
 * measurement, like `costprobe`: nothing fails, and it is not in `npm test` (a 3D match costs
 * seconds, and a red `npm test` must keep meaning "physics broke").
 *
 * ── THE FORMATS ─────────────────────────────────────────────────────────────
 *   solo   one bot (blue) against one IDLE robot. The quiet control: nothing competes for the
 *          elements and nothing leans on the chassis, so this is the number a policy change moves.
 *   2v2    four bots of the SAME tier. Where the interaction lives: shared elements, contact,
 *          fouls, and whether two partners split the field or chase the same POLLEN.
 *   vs     `--vs hard:easy` plays a 2v2 of one tier against another, sides alternating.
 *
 * ── HOW STUCK AND IDLE ARE MEASURED ─────────────────────────────────────────
 * Observationally, off the world and the recorded command, never off the policy's own memory —
 * a bench that asked the bot whether it was stuck would measure the bot's opinion of itself.
 * The match is cut into one-second windows (AUTO and TELEOP only; the transition is nobody's):
 *   STUCK   the command asked for translation (mean stick over the window > 0.25) and the chassis
 *           moved less than 4 in. Pressed into a wall, wedged on a foot, pinned in a pile.
 *   IDLE    not stuck, moved less than 3 in, turned less than 0.15 rad, the hopper did not change
 *           and nothing was fired: standing still to no effect, including waiting on a shot.
 * `maxStuck` is the longest RUN of stuck windows, which is what the smoke floor binds.
 *
 *   npx tsx scripts/aibench.ts                          # 20 seeds, every tier, solo + 2v2, 3D
 *   npx tsx scripts/aibench.ts --seeds 6 --tiers hard   # a quick shape check while iterating
 *   npx tsx scripts/aibench.ts --formats solo --physics 2d
 *   npx tsx scripts/aibench.ts --vs hard:easy --seeds 10
 *   npx tsx scripts/aibench.ts --builds default         # every bot on the stock default build
 *   npx tsx scripts/aibench.ts --builds preset:starterbot --tiers hard   # every bot on one builder card
 *   npx tsx scripts/aibench.ts --json out.json          # every match row, for a diff
 *
 * Parallel across processes (`--jobs`, default min(cores − 1, 12)): each worker is this file with
 * `--worker`, handed a slice of the job list, printing one JSON row per match.
 */
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Physics } from '../src/games/types';
import type { Alliance } from '../src/types';
import type { BotFormat as Format, BotJob as Job, BotRow, MatchRow } from './smoke-biobuzz/botmatch';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);

/** one match, in a worker: physics booted once per process, the measurement shared with the
 * AIPLAY lane (`smoke-biobuzz/botmatch.ts`) so a floor there and a number here are the same thing */
let booted: Set<Physics> | null = null;
async function playOne(job: Job): Promise<MatchRow> {
  booted ??= new Set();
  if (!booted.has('2d')) {
    const { initPhysics } = await import('../src/sim/physicsEngine');
    await initPhysics();
    booted.add('2d');
  }
  if (job.physics === '3d' && !booted.has('3d')) {
    const { initPhysics3d } = await import('../src/games/biobuzz/sim3d/engine');
    await initPhysics3d();
    booted.add('3d');
  }
  const { playBotMatch } = await import('./smoke-biobuzz/botmatch');
  return playBotMatch(job);
}

// ─────────────────────────────────────────────────────────────────────────────
// WORKER / DRIVER
// ─────────────────────────────────────────────────────────────────────────────

interface Args {
  seeds: number;
  seed0: number;
  tiers: string[];
  formats: Format[];
  physics: Physics;
  builds: string;
  vs: [string, string] | null;
  jobs: number;
  json: string | null;
  verbose: boolean;
}

function readArgs(argv: string[]): Args {
  const out: Args = {
    seeds: 20,
    seed0: 7000,
    tiers: ['easy', 'medium', 'hard'],
    formats: ['solo', '2v2'],
    physics: '3d',
    builds: 'bot',
    vs: null,
    jobs: Math.max(1, Math.min(12, cpus().length - 1)),
    json: null,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--verbose') { out.verbose = true; continue; }
    const eq = a.indexOf('=');
    const name = eq >= 0 ? a.slice(0, eq) : a;
    const value = eq >= 0 ? a.slice(eq + 1) : argv[++i];
    if (name === '--seeds') out.seeds = Math.max(1, Math.round(Number(value)));
    else if (name === '--seed0') out.seed0 = Math.round(Number(value));
    else if (name === '--tiers') out.tiers = value.split(',');
    else if (name === '--formats') out.formats = value.split(',') as Format[];
    else if (name === '--physics') out.physics = value === '2d' ? '2d' : '3d';
    else if (name === '--builds') out.builds = value;
    else if (name === '--vs') {
      const [x, y] = value.split(':');
      out.vs = [x, y];
      out.formats = ['vs'];
    } else if (name === '--jobs') out.jobs = Math.max(1, Math.round(Number(value)));
    else if (name === '--json') out.json = value;
    else {
      console.error(`[aibench] unknown flag ${name}`);
      process.exit(2);
    }
  }
  return out;
}

if (process.argv.includes('--worker')) {
  // A WORKER: jobs arrive as one JSON array on argv, results leave as one JSON line each.
  const jobs = JSON.parse(Buffer.from(process.argv[process.argv.indexOf('--worker') + 1], 'base64').toString()) as Job[];
  for (const j of jobs) {
    const row = await playOne(j);
    process.stdout.write(`@@ROW ${JSON.stringify(row)}\n`);
  }
  process.exit(0);
}

const args = readArgs(process.argv.slice(2));
const jobs: Job[] = [];
for (const format of args.formats) {
  for (let s = 0; s < args.seeds; s++) {
    const seed = args.seed0 + s;
    if (format === 'vs' && args.vs) {
      // sides alternate, so neither the side nor the anchor carries the result
      const [x, y] = args.vs;
      jobs.push({ format, blue: s % 2 === 0 ? x : y, red: s % 2 === 0 ? y : x, seed, physics: args.physics, builds: args.builds });
      continue;
    }
    for (const tier of args.tiers) {
      jobs.push({ format, blue: tier, red: format === 'solo' ? 'idle' : tier, seed, physics: args.physics, builds: args.builds });
    }
  }
}

const t0 = Date.now();
const width = Math.min(args.jobs, jobs.length);
const slices: Job[][] = Array.from({ length: width }, () => []);
jobs.forEach((j, i) => slices[i % width].push(j));
const tsxBin = resolve(ROOT, 'node_modules/tsx/dist/cli.mjs');
const results: MatchRow[] = [];
await Promise.all(
  slices.map(
    (slice) =>
      new Promise<void>((done) => {
        const payload = Buffer.from(JSON.stringify(slice)).toString('base64');
        const child = spawn(process.execPath, [tsxBin, SELF, '--worker', payload], {
          cwd: ROOT,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let buf = '';
        child.stdout.on('data', (d: Buffer) => {
          buf += d.toString();
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (line.startsWith('@@ROW ')) {
              const row = JSON.parse(line.slice(6)) as MatchRow;
              results.push(row);
              if (args.verbose) {
                const j = row.job;
                console.log(
                  `  ${j.format} ${j.blue}/${j.red} seed ${j.seed}: blue ${row.alliances.blue.total} red ${row.alliances.red.total} (${(row.ms / 1000).toFixed(1)}s)`,
                );
              }
            } else if (args.verbose && line.trim()) console.log(`  [worker] ${line}`);
          }
        });
        child.stderr.on('data', (d: Buffer) => process.stderr.write(d));
        child.on('close', () => done());
      }),
  ),
);

// ─────────────────────────────────────────────────────────────────────────────
// REPORT
// ─────────────────────────────────────────────────────────────────────────────

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const f1 = (x: number): string => x.toFixed(1);

function report(label: string, rows: MatchRow[], side: (r: MatchRow) => Alliance[], botFilter: (b: BotRow) => boolean): void {
  if (rows.length === 0) return;
  const al = rows.flatMap((r) => side(r).map((a) => r.alliances[a]));
  const pts = al.map((a) => a.total);
  const bots = rows.flatMap((r) => r.bots.filter(botFilter));
  const foulCount: Record<string, number> = {};
  let foulPtsGiven = 0;
  for (const r of rows) {
    for (const a of side(r)) {
      for (const [k, v] of Object.entries(r.fouls[a])) foulCount[k] = (foulCount[k] ?? 0) + v;
      foulPtsGiven += r.alliances[a === 'red' ? 'blue' : 'red'].foulPts;
    }
  }
  const nAl = al.length;
  const sorted = [...pts].sort((a, b) => a - b);
  console.log(
    `${label.padEnd(18)} pts ${f1(mean(pts)).padStart(6)} (min ${sorted[0]}, med ${sorted[Math.floor(sorted.length / 2)]}, max ${sorted[sorted.length - 1]})` +
      `  tips ${f1(mean(al.map((a) => a.tips)))}  cell ${f1(mean(al.map((a) => a.cellPts)))}` +
      `  flower ${f1(mean(al.map((a) => a.flowerPts)))}  garden ${f1(mean(al.map((a) => a.gardenPts)))}  end ${f1(mean(al.map((a) => a.endPts)))}`,
  );
  console.log(
    `${''.padEnd(18)} per bot: cycles ${f1(mean(bots.map((b) => b.cycles)))}  fired ${f1(mean(bots.map((b) => b.fired)))}` +
      `  collected ${f1(mean(bots.map((b) => b.collected)))}  dist ${f1(mean(bots.map((b) => b.distIn)) / 12)} ft` +
      `  stuck ${f1(mean(bots.map((b) => b.stuckS)))}s (max run ${Math.max(0, ...bots.map((b) => b.maxStuckS))}s)` +
      `  idle ${f1(mean(bots.map((b) => b.idleS)))}s`,
  );
  const fl = Object.entries(foulCount)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${(v / nAl).toFixed(2)}`)
    .join(', ');
  console.log(
    `${''.padEnd(18)} fouls committed per alliance: ${(foulPtsGiven / nAl).toFixed(1)} pts${fl ? `  [${fl}]` : ''}` +
      `  warnings ${f1(mean(rows.flatMap((r) => side(r).map((a) => r.warnings[a]))))}`,
  );
}

console.log(
  `[aibench] ${jobs.length} matches · ${args.physics} · builds=${args.builds} · seeds ${args.seed0}..${args.seed0 + args.seeds - 1} · ${width} workers\n`,
);
for (const format of args.formats) {
  if (format === 'vs' && args.vs) {
    const [x, y] = args.vs;
    const rows = results.filter((r) => r.job.format === 'vs');
    let wins = 0;
    let losses = 0;
    let margin = 0;
    for (const r of rows) {
      const xSide: Alliance = r.job.blue === x ? 'blue' : 'red';
      const ySide: Alliance = xSide === 'blue' ? 'red' : 'blue';
      const d = r.alliances[xSide].total - r.alliances[ySide].total;
      margin += d;
      if (d > 0) wins++;
      else if (d < 0) losses++;
    }
    report(`vs ${x}`, rows, (r) => [r.job.blue === x ? 'blue' : 'red'], (b) => b.tier === x);
    report(`vs ${y}`, rows, (r) => [r.job.blue === y ? 'blue' : 'red'], (b) => b.tier === y);
    console.log(`  ${x} vs ${y}: ${wins}W ${losses}L ${rows.length - wins - losses}D, mean margin ${f1(margin / Math.max(1, rows.length))}\n`);
    continue;
  }
  for (const tier of args.tiers) {
    const rows = results.filter((r) => r.job.format === format && r.job.blue === tier);
    report(`${format} ${tier}`, rows, (r) => (format === 'solo' ? ['blue'] : ['blue', 'red']), () => true);
  }
  console.log('');
}
const builds = new Map<string, number>();
for (const r of results) for (const b of r.bots) builds.set(b.build, (builds.get(b.build) ?? 0) + 1);
console.log(`builds seen: ${[...builds.entries()].map(([k, v]) => `${k} ×${v}`).join(' · ')}`);
const totalMs = results.reduce((a, r) => a + r.ms, 0);
console.log(
  `${results.length} matches in ${((Date.now() - t0) / 1000).toFixed(1)}s wall (${(totalMs / Math.max(1, results.length) / 1000).toFixed(2)}s per match)`,
);
if (args.json) {
  writeFileSync(args.json, JSON.stringify(results, null, 1));
  console.log(`rows written to ${args.json}`);
}
