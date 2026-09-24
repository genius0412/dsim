import { initPhysics } from '../../src/sim/physicsEngine';
import { initPhysics3d } from '../../src/games/biobuzz/sim3d/engine';
import { fieldChecks, roomChecks } from './field';
import { rulesChecks } from './rules';
import { robotChecks } from './robot';
import { coreChecks } from './core';
import { sim3dChecks } from './sim3d';
import { hive3dChecks } from './hive3d';
import { flower3dChecks } from './flower3d';
import { predictChecks } from './predict';
import { aiChecks } from './ai';
import { aiPlayChecks } from './aiplay';
import { sponsorChecks } from './sponsor';
import { renderChecks } from './render';
import { tutorialChecks } from './tutorial';
import { net3dChecks } from './net3d';
import { autoChecks } from './autos';
import type { Check } from './harness';

/**
 * THE BIOBUZZ SMOKE ENTRY POINT. Run with: `npx tsx scripts/smoke-biobuzz/index.ts`
 *
 * Five lanes, one process, one exit code. `field.ts` owns the field, the wire, the server and
 * the performance budget; `rules.ts` owns Table 10-2, Section 11 and the HUD slice;
 * `robot.ts` owns the specs and the mechanisms; `core.ts` owns the registry seam. The split is
 * what lets each lane add checks without touching one file, and the shared `check` counter is
 * what lets the whole thing be a single `npm run test:bb`.
 *
 * ── RUNNING LESS THAN ALL OF IT ────────────────────────────────────────────
 *   npx tsx scripts/smoke-biobuzz/index.ts --list
 *   npx tsx scripts/smoke-biobuzz/index.ts --lane rules
 *   npx tsx scripts/smoke-biobuzz/index.ts --lane rules,core
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
  { name: 'SIM3D', fn: sim3dChecks },
  // Day 2 lane A: the DYNAMIC see-saw, the real FLOWER tube, and the two prediction worlds.
  { name: 'HIVE3D', fn: hive3dChecks },
  { name: 'FLOWER3D', fn: flower3dChecks },
  { name: 'PREDICT', fn: predictChecks },
  // Day 3 lane A: the deterministic AI drivers — the seam, determinism under BOTH physics, the
  // read list, the quantized command, R102's stow/deploy, and that a bot can actually score.
  // The STATISTICAL tier-ordering claim is `npm run test:ai`, outside `npm test` (see ai.ts).
  { name: 'AI', fn: aiChecks },
  // the bots PLAY: their roster of robots, and three fixed-seed matches held to a points floor,
  // zero fouls and no stuck run. The statistics are `npm run bench:ai` (see aiplay.ts).
  { name: 'AIPLAY', fn: aiPlayChecks },
  { name: 'FIELD', fn: fieldChecks },
  // Table 10-2 scoring, the Section 11 fouls, the 1:00 cue, the HUD slice. Its own lane
  // because a RULES failure and a PHYSICS failure are different mornings, and because two
  // people add checks to `field.ts` and `rules.ts` at the same time.
  { name: 'RULES', fn: rulesChecks },
  { name: 'SERVER', fn: roomChecks },
  { name: 'ROBOT', fn: robotChecks },
  // app-level, not a game lane — see the header of sponsor.ts for why it rides this suite
  { name: 'SPONSOR', fn: sponsorChecks },
  // the 3D scene chunk's import-boundary rules (Day 1 lane B) — pure source checks, no DOM
  { name: 'RENDER', fn: renderChecks },
  // the SEAM between the 3D solve and everything that carries it: room physics, the cap gate,
  // the wire codec, and the replay container (Day 2 lane C). See net3d.ts's header for why it
  // is its own lane and not more checks in SERVER.
  { name: 'NET3D', fn: net3dChecks },
  // roadmap item 6: the tutorial engine (`src/tutorial/`) and BIOBUZZ's step content. Its own
  // lane because a TUTORIAL failure and a PHYSICS failure are different mornings, and because it
  // is the only lane that drives a staged world to a goal rather than asserting a number.
  { name: 'TUTORIAL', fn: tutorialChecks },
  // Zenith autos driven by an auto seat (docs/area/autos.md): no teleport, arrival, the heading
  // modes, the alliance rule, the commands, replay-without-seat, and the hand-back at the buzzer.
  { name: 'AUTO', fn: autoChecks },
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
// Day 1 seam (`docs/biobuzz/plan-3d.md`): awaited right after the 2D module, same reasoning,
// so a lane can build a `'3d'`-physics world without adding its own boot step. `step3d` still
// throws (Day 1 lane A has not landed), so no lane below steps a `'3d'` world yet.
await initPhysics3d();
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
