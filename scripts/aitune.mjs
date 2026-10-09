/**
 * THE AI TUNER — `npm run tune:ai`. A (1+λ) evolution strategy over `BB_AI_WEIGHTS`
 * (`src/games/biobuzz/ai/tuning.ts`), measured the only way a 2v2 bot can honestly be measured:
 * HEAD TO HEAD against the incumbent weights, on the roster builds, 3D.
 *
 *   npm run tune:ai -- --gens 40 [--lambda 6] [--seeds 24] [--confirm 72] [--start w.json]
 *
 * Each generation mutates 2–4 weights of the incumbent λ times and plays every candidate against it
 * on `--seeds` seeds, TWICE per seed with the sides swapped (same robots, same seats — build and
 * seat luck cancel inside the pair, which halves the standard error). The best candidate, if clearly
 * ahead, is re-played on `--confirm` FRESH seeds and accepted on that confirmation ALONE: the screen
 * is biased upward by picking the best of λ. Accepted weights go to `aitune.best.json` in the
 * working directory and every generation to `--log` (JSONL). Nothing is written to the source: an
 * accepted set is copied into `BB_AI_WEIGHTS` by hand, then re-measured with `npm run bench:ai`.
 *
 * Cost: a 3D 2v2 is ~7 s of CPU, so a generation (6 × 48 matches, plus a confirmation) is ~3–5
 * minutes on 12 cores. It is a measurement tool like `costprobe`, not a test.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, appendFileSync, mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 ? process.argv[i + 1] : d;
};
const GENS = +arg('gens', 40);
const LAMBDA = +arg('lambda', 6);
const SEEDS = +arg('seeds', 24);
const CONFIRM = +arg('confirm', 72);
const PROCS = +arg('procs', 12);
const LOG = arg('log', 'aitune.log.jsonl');

// the incumbent is the SHIPPED table, read from the source, so the tuner cannot drift from it
const { BB_AI_WEIGHTS } = await import('../src/games/biobuzz/ai/tuning.ts');
const DEF = { ...BB_AI_WEIGHTS };
// [kind, step, lo, hi]: 'mul' log-normal, 'add' additive, 'addi' additive integer
const SPEC = {
  turretD0: ['add', 2, 24, 40], turretD1: ['add', 2, 40, 56], dumpD0: ['add', 2, 24, 36], dumpD1: ['add', 2, 34, 46],
  turnW: ['mul'], legLast: ['mul'], legOther: ['mul'], cluster: ['mul'], overRoom: ['mul'], nectar: ['mul'],
  partner: ['mul'], opponent: ['mul'], switchFrac: ['add', 0.1, 0.3, 1], switchAbs: ['mul'], brake: ['add', 0.08, 0.3, 1.0],
  robotClear: ['add', 2, 0, 14], robotPush: ['mul'], robotTan: ['mul'], maxClosing: ['add', 3, 0, 30],
  stall: ['addi', 4, 8, 40], herd: ['addi', 2, 6, 24], parkMargin: ['add', 0.4, 0.4, 4], tourMargin: ['add', 2, -2, 15],
};

for (const k of Object.keys(DEF)) if (!SPEC[k]) throw new Error(`[aitune] BB_AI_WEIGHTS.${k} has no mutation SPEC — add one`);
for (const k of Object.keys(SPEC)) if (!(k in DEF)) throw new Error(`[aitune] SPEC.${k} is not a BB_AI_WEIGHTS field`);

let rng = (0x2545f491 ^ Date.now()) | 0;
const rand = () => {
  rng ^= rng << 13;
  rng ^= rng >>> 17;
  rng ^= rng << 5;
  return ((rng >>> 0) % 1e9) / 1e9;
};
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

function mutate(w) {
  const out = { ...w };
  const keys = Object.keys(SPEC);
  const n = 2 + Math.floor(rand() * 3);
  for (let i = 0; i < n; i++) {
    const k = keys[Math.floor(rand() * keys.length)];
    const [kind, step, lo, hi] = SPEC[k];
    let v = out[k];
    if (kind === 'mul') v = v * Math.exp(0.3 * gauss());
    else v = v + step * gauss() * 1.2;
    if (kind === 'addi') v = Math.round(v);
    if (lo !== undefined) v = Math.min(hi, Math.max(lo, v));
    out[k] = +v.toFixed(3);
  }
  if (out.turretD1 < out.turretD0 + 8) out.turretD1 = out.turretD0 + 8;
  if (out.dumpD1 < out.dumpD0 + 6) out.dumpD1 = out.dumpD0 + 6;
  return out;
}

let seedBase = +arg('seed0', 20000);

async function play(jobs) {
  const dir = mkdtempSync(join(tmpdir(), 'bbopt-'));
  const per = Math.ceil(jobs.length / PROCS);
  const out = [];
  await Promise.all(
    Array.from({ length: PROCS }, (_, p) =>
      new Promise((res) => {
        const slice = jobs.slice(p * per, (p + 1) * per);
        if (!slice.length) return res();
        const f = join(dir, `j${p}.json`);
        writeFileSync(f, JSON.stringify(slice));
        const ch = spawn(process.execPath, ['--import', 'tsx', 'scripts/aitune-worker.ts', f], { stdio: ['ignore', 'pipe', 'ignore'] });
        let buf = '';
        ch.stdout.on('data', (d) => (buf += d));
        ch.on('close', () => {
          for (const l of buf.split('\n')) if (l.startsWith('{')) out.push(JSON.parse(l));
          res();
        });
      }),
    ),
  );
  return out;
}

function pairedJobs(key, wa, wb, n) {
  const jobs = [];
  for (let s = 0; s < n; s++) {
    const seed = seedBase + s;
    jobs.push({ key, wa, wb, seed, aSide: 'blue' }, { key, wa, wb, seed, aSide: 'red' });
  }
  return jobs;
}

function stats(rows) {
  const by = {};
  for (const r of rows) (by[r.seed] ??= []).push(r.a - r.b);
  const d = Object.values(by).map((v) => v.reduce((a, b) => a + b, 0) / v.length);
  const n = d.length;
  const m = d.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(d.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, n - 1));
  return { m, se: sd / Math.sqrt(n), n };
}

const start = arg('start', '');
let best = start && existsSync(start) ? JSON.parse(readFileSync(start, 'utf8')) : { ...DEF };
appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), start: best }) + '\n');
for (let g = 0; g < GENS; g++) {
  const cands = Array.from({ length: LAMBDA }, () => mutate(best));
  const rows = await play(cands.flatMap((w, i) => pairedJobs(i, w, best, SEEDS)));
  seedBase += SEEDS;
  const res = cands.map((w, i) => ({ w, ...stats(rows.filter((r) => r.key === i)) })).sort((a, b) => b.m - a.m);
  const top = res[0];
  const line = { gen: g, top: { m: +top.m.toFixed(1), se: +top.se.toFixed(1) }, all: res.map((r) => +r.m.toFixed(1)), cand: top.w };
  if (top.m > 1.5 * top.se && top.m > 3) {
    const c2 = stats(await play(pairedJobs(0, top.w, best, CONFIRM)));
    seedBase += CONFIRM;
    line.confirm = { m: +c2.m.toFixed(1), se: +c2.se.toFixed(1) };
    // accept on the CONFIRMATION alone: the screen is biased upward by picking the best of λ
    if (c2.m > 2 * c2.se && c2.m > 1.5) {
      best = top.w;
      line.accepted = true;
      writeFileSync('aitune.best.json', JSON.stringify(best, null, 2));
    }
  }
  appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...line }) + '\n');
  console.log(JSON.stringify({ gen: g, top: line.top, confirm: line.confirm, accepted: !!line.accepted }));
}
