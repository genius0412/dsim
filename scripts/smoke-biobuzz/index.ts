import { initPhysics } from '../../src/sim/physicsEngine';
import { fieldChecks, roomChecks } from './field';
import { robotChecks } from './robot';
import { coreChecks } from './core';
import type { Check } from './harness';

/**
 * THE BIOBUZZ SMOKE ENTRY POINT. Run with: `npx tsx scripts/smoke-biobuzz/index.ts`
 *
 * Four lanes, one process, one exit code. `field.ts` owns the field, the wire, the server and
 * the performance budget; `robot.ts` owns the specs and the mechanisms; `core.ts` owns the
 * registry seam. The split is what lets both lanes add checks without touching one file, and
 * the shared `check` counter is what lets the whole thing be a single `npm run test:bb`.
 *
 * ── RUNNING LESS THAN ALL OF IT ────────────────────────────────────────────
 *   npx tsx scripts/smoke-biobuzz/index.ts --list
 *   npx tsx scripts/smoke-biobuzz/index.ts --lane field
 *   npx tsx scripts/smoke-biobuzz/index.ts --lane field,core
 *   npx tsx scripts/smoke-biobuzz/index.ts --grep pollen
 *
 * The whole suite is a physics run, so it costs real seconds and the cost is not evenly
 * spread — the footer prints each lane's own time so the expensive one is visible rather than
 * guessed at. `--lane` is the one that actually saves time: a lane not selected never RUNS.
 *
 * **`--grep` FILTERS THE REPORT, NOT THE WORK**, and the footer says so: a check's cost is in
 * the scene that was stepped before `check()` was ever called, and those scenes are ordinary
 * statements in a lane function, not addressable units. It is for reading the output of a lane
 * you are iterating on, and it is the honest version of a filter this suite can offer.
 *
 * ⚠️ **A FILTER MUST NEVER HIDE A FAILURE.** `--grep` suppresses PASSING lines only; a FAIL
 * prints whatever the filter says, and the failure count always covers every check that ran.
 * A filtered run that reported green while something was red would be worse than no filter at
 * all — the entire value of running a subset is that you still trust the exit code.
 *
 * An UNKNOWN flag is an ERROR, not an ignored word. `--lane feild` silently running the whole
 * suite is the failure mode where you think you measured something and did not.
 *
 * ── WHY `initPhysics` IS AWAITED HERE AND NOWHERE ELSE ─────────────────────
 * `solveRobots` needs the Rapier WASM module resolved before the first step, and
 * `@dimforge/rapier2d-compat` resolves it asynchronously. The browser gets this from
 * `main.tsx`, which awaits it before rendering; the server gets it at boot. A headless script
 * has neither, so it awaits at the top — top-level, once, before any world is built. Every
 * check below is synchronous precisely so this is the only await in the suite and there is no
 * ordering question about it.
 *
 * A THROW anywhere below is a suite-level failure, not a check failure. That is why each lane
 * is called inside its own try: one lane throwing must still let the others run and report,
 * because "BIOBUZZ mechanisms are fine, the perf harness blew up" is a different morning from
 * "everything is broken".
 */

const LANES: { name: string; fn: (c: Check) => void }[] = [
  { name: 'CORE', fn: coreChecks },
  { name: 'FIELD', fn: fieldChecks },
  { name: 'SERVER', fn: roomChecks },
  { name: 'ROBOT', fn: robotChecks },
];

const KNOWN_FLAGS = ['--lane', '--grep', '--list', '--help'];

function die(msg: string): never {
  console.error(`[smoke-bb] ${msg}`);
  console.error(`[smoke-bb] lanes: ${LANES.map((l) => l.name.toLowerCase()).join(', ')}`);
  console.error('[smoke-bb] usage: smoke-biobuzz [--lane a,b] [--grep <substring>] [--list]');
  process.exit(2);
}

/** `--x v` or `--x=v`. An UNKNOWN flag and a flag with no value are both errors — see above. */
function readArgs(argv: string[]): { lanes?: string; grep?: string; list: boolean } {
  const out: { lanes?: string; grep?: string; list: boolean } = { list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const name = eq >= 0 ? a.slice(0, eq) : a;
    if (!name.startsWith('--')) die(`unexpected argument ${JSON.stringify(a)}`);
    if (!KNOWN_FLAGS.includes(name)) die(`unknown flag ${name}`);
    if (name === '--list') { out.list = true; continue; }
    if (name === '--help') die('usage');
    const value = eq >= 0 ? a.slice(eq + 1) : argv[++i];
    if (!value || value.startsWith('--')) die(`${name} needs a value`);
    if (name === '--lane') out.lanes = value;
    else out.grep = value;
  }
  return out;
}

const args = readArgs(process.argv.slice(2));

if (args.list) {
  for (const l of LANES) console.log(l.name.toLowerCase());
  process.exit(0);
}

/** every named lane must EXIST — a typo that quietly ran everything is the whole trap. */
const selected = (() => {
  if (!args.lanes) return LANES;
  const want = args.lanes.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (want.length === 0) die('--lane needs at least one lane name');
  for (const w of want) if (!LANES.some((l) => l.name === w)) die(`no such lane ${JSON.stringify(w)}`);
  return LANES.filter((l) => want.includes(l.name));
})();

const grep = args.grep ? args.grep.toLowerCase() : '';

const bootStart = Date.now();
await initPhysics();
const bootMs = Date.now() - bootStart;

let failures = 0;
let ran = 0;
let hidden = 0;
const check: Check = (name, ok, detail = '') => {
  ran++;
  if (!ok) failures++;
  // a FAIL always prints; only passing lines can be filtered away.
  if (ok && grep && !name.toLowerCase().includes(grep)) { hidden++; return; }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/** run one lane, counting a throw as a failure rather than as an aborted suite. */
function lane(name: string, fn: (c: Check) => void): number {
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 60 - name.length))}`);
  const t0 = Date.now();
  try {
    fn(check);
  } catch (e) {
    check(`${name}: the lane ran to completion`, false, e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e));
  }
  return Date.now() - t0;
}

const timings = selected.map((l) => ({ name: l.name, ms: lane(l.name, l.fn) }));

const laneTotal = timings.reduce((a, t) => a + t.ms, 0);
const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
console.log(
  `\n${timings.map((t) => `${t.name} ${s(t.ms)}`).join('  ·  ')}` +
    `  ·  boot ${s(bootMs)}  ·  lanes ${s(laneTotal)}`,
);
if (selected.length < LANES.length) {
  const skipped = LANES.filter((l) => !selected.includes(l)).map((l) => l.name.toLowerCase());
  console.log(`PARTIAL RUN — lanes not run: ${skipped.join(', ')}`);
}
if (hidden > 0) console.log(`${hidden} passing checks hidden by --grep (they still RAN and still counted)`);
console.log(failures === 0 ? `\n${ran} CHECKS, ALL PASS` : `\n${failures} FAILURES of ${ran} checks`);
process.exit(failures === 0 ? 0 : 1);
