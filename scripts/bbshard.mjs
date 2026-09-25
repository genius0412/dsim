/**
 * `scripts/bbshard.mjs` — the BIOBUZZ suite, SHARDED BY LANE.
 *
 * `scripts/smoke-biobuzz/index.ts` runs its fourteen lanes in one process, one after another: 69 s
 * on 2026-09-20, and the longest thing in `npm test` (the shared suite beside it is 39 s because
 * `smokeshard.mjs` already splits it across cores). The lanes are INDEPENDENT BY CONSTRUCTION —
 * `--lane a,b` has always run any subset on its own, and every session runs partial lanes all day
 * — so this packs them longest-first into a few processes and runs those at once. No lane file
 * changes, no check changes: a serial `npm run test:bb` prints the same check names and outcomes.
 *
 * ── WHAT KEEPS IT HONEST ────────────────────────────────────────────────────────────────────
 *  · THE LANE LIST IS ASKED FOR, NOT TYPED: `index.ts --list` is run first, so a new lane is
 *    picked up the day it is registered. One missing from `COST` below is costed at the median —
 *    it packs a little worse, it is never skipped.
 *  · EVERY LANE RUNS IN EXACTLY ONE SHARD, asserted before anything is spawned.
 *  · A shard that dies without printing its summary line is a FAILURE, not a zero.
 *  · The total is the SUM of the shards' own `N CHECKS` lines and is printed in the same words
 *    the serial runner uses, so `3322 CHECKS, ALL PASS` still means what it meant.
 *
 * ── THE PERF LANE RUNS ALONE ────────────────────────────────────────────────────────────────
 * `SOLO` lanes are never packed. They run one at a time AFTER the parallel shards have exited,
 * because they hold the absolute wall-clock budgets (`index.ts`, the PERF lane), and a budget
 * measured while 17 other test processes share the cores measures the load: the FULL reconcile
 * read 9-11 ms against its 8 ms budget on nearly every `npm test`, and costs 4.0 ms alone.
 * `--gate` holds them until STDIN CLOSES, which is how `test-all.mjs` makes them wait for the
 * shared suite as well; it is for that caller, and on a terminal it waits for Ctrl-D/Ctrl-Z.
 *
 * Zero dependencies; children are spawned through `process.execPath` with tsx's own cli, the way
 * `smokeshard.mjs` and `test-all.mjs` do it (no shell, no `.cmd` shim, no quoting).
 *
 *   node scripts/bbshard.mjs                 # all lanes, sharded
 *   node scripts/bbshard.mjs --shards=4      # narrower
 *   node scripts/bbshard.mjs --quiet         # FAIL lines and summaries only
 *   node scripts/bbshard.mjs --gate          # hold the SOLO lanes until stdin closes
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TSX = resolve(ROOT, 'node_modules/tsx/dist/cli.mjs');
const INDEX = resolve(ROOT, 'scripts/smoke-biobuzz/index.ts');

const arg = (name, dflt) => {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : 'true';
};
const QUIET = arg('quiet', 'false') === 'true';
const GATE = arg('gate', 'false') === 'true';

/** lanes that run with the machine to themselves, after everything else — see the header */
const SOLO = new Set(['perf']);

/** measured lane seconds (2026-09-20, serial run). Only the ORDER matters to the packing, so a
 *  stale number costs a slightly worse pack and nothing else. Re-read them off the footer of
 *  `npm run test:bb` when a lane's weight changes a lot. */
const COST = {
  sim3d: 13.8, net3d: 12.7, ai: 11.3, aiplay: 10.7, field: 8.1, hive3d: 6.1, server: 4.7, flower3d: 4.2,
  tutorial: 2.9, robot: 2.6, rules: 1.5, render: 0.9, predict: 0.3, core: 0.1, sponsor: 0.1,
  perf: 2.5, // SOLO: never packed, so its cost only matters to the median above
};

// ---- the lanes that exist, from the suite itself --------------------------------------------
const listed = spawnSync(process.execPath, [TSX, INDEX, '--list'], { cwd: ROOT, encoding: 'utf8' });
if (listed.status !== 0) {
  console.error('[bbshard] could not list lanes:', listed.stderr || listed.error?.message);
  process.exit(2);
}
const lanes = listed.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
if (lanes.length === 0) {
  console.error('[bbshard] the suite listed no lanes');
  process.exit(2);
}
const knownCosts = lanes.map((l) => COST[l]).filter((v) => typeof v === 'number').sort((a, b) => a - b);
const median = knownCosts.length ? knownCosts[Math.floor(knownCosts.length / 2)] : 1;
const costOf = (l) => COST[l] ?? median;

// ---- pack: longest first into the emptiest shard ---------------------------------------------
// Six by default: past the three heavy lanes (each a shard of its own) more processes only buy
// more tsx boots. Never more shards than lanes, never more than the box has cores to spare.
const packed = lanes.filter((l) => !SOLO.has(l));
const SHARDS = Math.max(1, Math.min(packed.length, Number(arg('shards', String(Math.min(6, Math.max(1, cpus().length - 1)))))));
const shards = Array.from({ length: SHARDS }, () => ({ lanes: [], cost: 0 }));
for (const l of [...packed].sort((a, b) => costOf(b) - costOf(a))) {
  const s = shards.reduce((m, x) => (x.cost < m.cost ? x : m));
  s.lanes.push(l);
  s.cost += costOf(l);
}
const solo = lanes.filter((l) => SOLO.has(l)).map((l) => ({ lanes: [l], cost: costOf(l) }));
const placed = [...shards, ...solo].flatMap((s) => s.lanes).sort();
if (placed.length !== lanes.length || placed.some((l, i) => l !== [...lanes].sort()[i])) {
  console.error('[bbshard] packing lost or duplicated a lane — refusing to run');
  process.exit(2);
}

// ---- run them all at once, buffering so the output reads lane by lane ------------------------
const t0 = Date.now();
const runShard = (s) =>
  new Promise((done) => {
    const child = spawn(process.execPath, [TSX, INDEX, '--lane', s.lanes.join(',')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => done({ ...s, code: code === null ? 1 : code, out, ms: Date.now() - t0 }));
    child.on('error', (e) => done({ ...s, code: 1, out: `${out}\n[bbshard] could not start: ${e.message}`, ms: Date.now() - t0 }));
  });
const results = await Promise.all(shards.filter((s) => s.lanes.length > 0).map(runShard));
if (solo.length > 0 && GATE) {
  await new Promise((go) => {
    process.stdin.on('end', go);
    process.stdin.on('error', go);
    process.stdin.resume();
  });
}
for (const s of solo) results.push(await runShard(s));

// ---- report -----------------------------------------------------------------------------------
let ran = 0;
let failures = 0;
let broken = 0;
for (const r of results) {
  const lines = r.out.split(/\r?\n/);
  const all = lines.map((l) => /^(\d+) CHECKS, ALL PASS$/.exec(l)).find(Boolean);
  const some = lines.map((l) => /^(\d+) FAILURES of (\d+) checks$/.exec(l)).find(Boolean);
  if (all) ran += Number(all[1]);
  else if (some) {
    failures += Number(some[1]);
    ran += Number(some[2]);
  } else broken++;
  // "ALL PASS" printed and a non-zero exit is a process that died on the way out: not a pass
  if (all && r.code !== 0) broken++;
  for (const l of lines) {
    // the per-shard verdict and the "lanes not run" note describe the SHARD, not the suite
    if (/^PARTIAL RUN — /.test(l) || /^\d+ CHECKS, ALL PASS$/.test(l) || /^\d+ FAILURES of \d+ checks$/.test(l)) continue;
    if (QUIET && !/^FAIL {2}/.test(l) && !/ · {2}boot /.test(l)) continue;
    if (l.length > 0 || !QUIET) console.log(l);
  }
  if (!all && !some) console.log(`FAIL  [bbshard] the shard running ${r.lanes.join(',')} ended (exit ${r.code}) without a summary line`);
}
const wall = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n[bbshard] ${lanes.length} lanes in ${results.length} shards · wall ${wall}s · ${results.map((r) => `${r.lanes.join('+')} ${(r.ms / 1000).toFixed(1)}s`).join('  ·  ')}`);
const bad = failures + broken;
console.log(bad === 0 ? `\n${ran} CHECKS, ALL PASS` : `\n${bad} FAILURES of ${ran} checks`);
process.exit(bad === 0 ? 0 : 1);
