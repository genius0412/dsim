/**
 * `npx tsx scripts/spill-video/compare.ts <a.spill.json> [b.spill.json ...] [options]`
 *
 * Compare where TIPPED-HIVE elements came to rest in real match video (the `.spill.json` files
 * `annotate.html` saves) with where DSIM's own 2D tip puts them, and optionally search for spill
 * constants that fit the video better.
 *
 *   --sims N        simulated tips per load (seeds 1..N) for the comparison (default 200)
 *   --load 3n3p     force every simulated cell to hold this: NnMp, nectar + pollen. By default
 *                   each video tip is simulated with ITS OWN load, read from the kinds clicked,
 *                   because a bigger load spreads further and a match mixes loads. When fewer
 *                   elements were seen than any tipping load holds (a partly hidden spill), the
 *                   pollen count is raised to the smallest that tips (BB_TIP_POLLEN): a tip proves
 *                   the cell held at least that much. "Unsure" kinds count as pollen.
 *   --clear-only    use only tips marked visibility "clear" (default: clear + partial)
 *   --fit           coordinate search over BB_SPILL_SPEED [lo, hi], BB_SPILL_FAN and
 *                   BB_SPILL_KICK, scoring each candidate by how far its rest distribution is
 *                   from the video's (two-sample KS distance on distance-from-pivot plus the
 *                   same on the angle off the outboard axis). Prints a suggestion, CHANGES NOTHING.
 *   --json FILE     also write the numbers as JSON
 *   --selftest      no video: fake a "video" of 15 tips from KNOWN spill constants (different
 *                   seeds from the comparison), then run the comparison and the fit, and report
 *                   whether the fit found its way back toward the known constants. Run it after
 *                   changing this script.
 *
 * WHAT IS SIMULATED. The real path: the `hive-tip` gallery scene's staging (an empty 'free' world,
 * RED's up cell loaded), stepped through `biobuzzStep` with no robots until every spilled element
 * is still. So the swing, the release at level, `spillPoses`, the shared artifact solve and the
 * shared rolling friction are all the shipped code. Only with --fit, on the tick the cell spills,
 * each spilled element's velocity is redrawn from the CANDIDATE constants with spillPoses' own
 * formula; the position it left from and everything after is untouched. (The redraw lands one
 * 1/60 s tick after the spill, so a candidate's element has already moved ≤ 1 in: noise, not bias.)
 *
 * 2D PHYSICS ONLY. A 3D-physics tip is a dynamic tray the balls really roll out of, with no
 * spill constants to fit; comparing it is the next step, not this one.
 *
 * FRAME. Everything is measured from the tipping HIVE's PIVOT, in the alliance's own frame:
 * `out` is the distance outboard along the hive axis (always positive for a clean spill),
 * `across` the sideways offset, `r` the straight-line distance, `angle` = atan2(across, out).
 * A spill's outboard side is read from where its elements ended up (the mean y), because the
 * stream camera does not show which cell was up.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Artifact } from '../../src/types';
import * as C from '../../src/config';
import { initPhysics } from '../../src/sim/physicsEngine';
import { bbWorld } from '../../src/games/biobuzz/scenes';
import { biobuzzStep } from '../../src/games/biobuzz/step';
import {
  BB_HALF_X,
  BB_HIVE_CELL_DY,
  BB_HIVE_LEN,
  BB_HIVE_UP_STAGED,
  BB_HIVE_W,
  BB_HIVE_X,
  BB_NECTAR_R,
  BB_POLLEN_R,
  BB_TILE_SEAMS,
  BB_TIP_POLLEN,
} from '../../src/games/biobuzz/config';
import { BB_SPILL_FAN, BB_SPILL_KICK, BB_SPILL_SPEED } from '../../src/games/biobuzz/hive';
import { mulberry32 } from '../../src/competition/rng';

// ─── arguments ──────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (name: string, dflt?: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const valued = new Set(['--sims', '--load', '--json']);
const files = argv.filter((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1] ?? ''));
const SELFTEST = argv.includes('--selftest');
if (files.length === 0 && !SELFTEST) {
  console.error('usage: npx tsx scripts/spill-video/compare.ts <file.spill.json ...> [--sims 200] [--load 3n3p] [--clear-only] [--fit] [--json out.json] | --selftest');
  process.exit(2);
}
const SIMS = Number(opt('sims', '200'));
const CLEAR_ONLY = argv.includes('--clear-only');
const FIT = argv.includes('--fit') || SELFTEST;
const FORCED_LOAD = opt('load');
if (FORCED_LOAD && !/^\d+n\d+p$/i.test(FORCED_LOAD)) {
  console.error(`--load must look like 3n3p (nectar, pollen); got ${FORCED_LOAD}`);
  process.exit(2);
}

// ─── the annotator's field must be the sim's field ─────────────────────────────────────────
/**
 * annotate.html carries its own copy of the field numbers (it is opened from disk, so it cannot
 * import TypeScript). A copy can drift; this is what stops a drifted copy from producing
 * plausible, wrong positions. A drift in the PAGE is a bug in the tool and stops the run; a
 * drift in an old annotation FILE is reported, because its clicks are still good and only its
 * stored field positions would need re-deriving.
 */
interface FieldJson { half: number; seams: number[]; hiveX: number; cellDY: number; cellW: number; hiveLen: number }
const here = dirname(fileURLToPath(import.meta.url));
function fieldDrift(f: FieldJson): string[] {
  const bad: string[] = [];
  const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
  if (!near(f.half, BB_HALF_X, 0.01)) bad.push(`half ${f.half} vs ${BB_HALF_X}`);
  if (!near(f.hiveX, BB_HIVE_X, 0.01)) bad.push(`hiveX ${f.hiveX} vs ${BB_HIVE_X}`);
  if (!near(f.cellDY, BB_HIVE_CELL_DY, 0.01)) bad.push(`cellDY ${f.cellDY} vs ${BB_HIVE_CELL_DY.toFixed(3)}`);
  if (!near(f.cellW, BB_HIVE_W, 0.01)) bad.push(`cellW ${f.cellW} vs ${BB_HIVE_W}`);
  if (!near(f.hiveLen, BB_HIVE_LEN, 0.01)) bad.push(`hiveLen ${f.hiveLen} vs ${BB_HIVE_LEN.toFixed(3)}`);
  if (f.seams.length !== BB_TILE_SEAMS.length || f.seams.some((s, i) => !near(s, BB_TILE_SEAMS[i], 0.01))) {
    bad.push(`seams [${f.seams.join(', ')}] vs [${BB_TILE_SEAMS.join(', ')}]`);
  }
  return bad;
}
{
  const html = readFileSync(join(here, 'annotate.html'), 'utf8');
  const m = /<script type="application\/json" id="field-json">([\s\S]*?)<\/script>/.exec(html);
  const drift = m ? fieldDrift(JSON.parse(m[1]) as FieldJson) : ['no field-json block'];
  if (drift.length) {
    console.error(`annotate.html's field numbers no longer match the sim. Update its field-json block:\n  ${drift.join('\n  ')}`);
    process.exit(1);
  }
}

// ─── measured ───────────────────────────────────────────────────────────────────────────────
interface Rest { out: number; across: number; r: number; angle: number }
function restOf(x: number, y: number, px: number, sign: number): Rest {
  const out = sign * y;
  const across = x - px;
  return { out, across, r: Math.hypot(out, across), angle: (Math.atan2(across, out) * 180) / Math.PI };
}
interface Ball { x: number | null; y: number | null; kind: string }
interface Tip { t: number; alliance: 'red' | 'blue'; visibility: string; disturbed: boolean; balls: Ball[] }
interface SpillFile { clip?: { name: string }; field?: FieldJson; calibration?: { rmsPx: number | null }; tips: Tip[] }

const measured: Rest[] = [];
const perTip: number[] = [];
/** each usable video tip's load key, NnMp, in the same order as `perTip` */
const tipLoads: string[] = [];
let skipped = 0;

/** the load a seen tip is simulated with (see --load in the header) */
function loadKey(nectar: number, pollen: number): string {
  if (FORCED_LOAD) return FORCED_LOAD.toLowerCase();
  const need = BB_TIP_POLLEN[Math.min(nectar, BB_TIP_POLLEN.length - 1)];
  return `${nectar}n${Math.max(pollen, need)}p`;
}
for (const f of files) {
  const d = JSON.parse(readFileSync(f, 'utf8')) as SpillFile;
  if (d.field) {
    const drift = fieldDrift(d.field);
    if (drift.length) console.warn(`! ${f} was annotated against a different field (${drift.join('; ')}); its positions are used as saved.`);
  }
  const rms = d.calibration?.rmsPx;
  console.log(`${f}: ${d.tips.length} tips, calibration RMS ${rms == null ? 'none' : rms.toFixed(1) + ' px'}`);
  for (const tip of d.tips) {
    const balls = tip.balls.filter((b): b is Ball & { x: number; y: number } => b.x != null && b.y != null);
    const ok = !tip.disturbed && balls.length > 0 && (tip.visibility === 'clear' || (!CLEAR_ONLY && tip.visibility === 'partial'));
    if (!ok) { skipped++; continue; }
    const px = tip.alliance === 'red' ? -BB_HIVE_X : BB_HIVE_X;
    const meanY = balls.reduce((s, b) => s + b.y, 0) / balls.length;
    const sign = meanY >= 0 ? 1 : -1;
    for (const b of balls) measured.push(restOf(b.x, b.y, px, sign));
    perTip.push(balls.length);
    const nectar = balls.filter((b) => b.kind === 'nectar').length;
    tipLoads.push(loadKey(nectar, balls.length - nectar));
  }
}

// ─── simulated ──────────────────────────────────────────────────────────────────────────────
interface Spill { speed: readonly [number, number]; fan: number; kick: number }
const SHIPPED: Spill = { speed: [BB_SPILL_SPEED[0], BB_SPILL_SPEED[1]], fan: BB_SPILL_FAN, kick: BB_SPILL_KICK };

/** The `hive-tip` gallery scene's staging (scenesField.ts), with a chosen load (NnMp). */
function tipWorld(seed: number, key: string) {
  const m = /^(\d+)n(\d+)p$/.exec(key);
  if (!m) throw new Error(`bad load ${key}`);
  const LOAD: ('nectar' | 'pollen')[] = [
    ...Array<'nectar'>(Number(m[1])).fill('nectar'),
    ...Array<'pollen'>(Number(m[2])).fill('pollen'),
  ];
  const world = bbWorld(seed, [], []);
  const bb = world.biobuzz;
  if (!bb) throw new Error('not a BIOBUZZ world');
  const cy = (BB_HIVE_UP_STAGED.red === 'north' ? 1 : -1) * BB_HIVE_CELL_DY;
  world.balls = LOAD.map((k, slot): Artifact => ({
    id: 900 + slot,
    color: k === 'pollen' ? 'yellow' : 'red',
    r: k === 'pollen' ? BB_POLLEN_R : BB_NECTAR_R,
    state: { kind: 'element', el: 'hive:red', slot },
    pos: { x: -BB_HIVE_X, y: cy },
    vel: { x: 0, y: 0 },
    z: 0,
    vz: 0,
  }) as Artifact);
  bb.hives.red.contents = world.balls.map((b) => b.id);
  bb.nextBallId = 900 + LOAD.length;
  return world;
}

/** One simulated tip to rest. `override` redraws the spill velocities from candidate constants. */
function simTip(seed: number, key: string, override?: Spill): Rest[] {
  const world = tipWorld(seed, key);
  const rng = mulberry32(seed * 7919 + 17);
  let spilled = false;
  const maxTicks = 14 * 60;
  for (let t = 0; t < maxTicks; t++) {
    const nEv = world.events.length;
    biobuzzStep(world, C.SIM_DT, new Map());
    if (!spilled && world.events.slice(nEv).some((e) => e.includes('HIVE SPILLS'))) {
      spilled = true;
      if (override) {
        for (const b of world.balls) {
          if (b.state.kind !== 'ground') continue;
          const sign = b.pos.y >= 0 ? 1 : -1;
          // spillPoses' formula (hive.ts), with the candidate's numbers
          const speed = override.speed[0] + rng() * (override.speed[1] - override.speed[0]);
          const a = (rng() * 2 - 1) * override.fan * (Math.PI / 180);
          const ka = rng() * 2 * Math.PI;
          const kv = rng() * override.kick;
          b.vel = { x: speed * Math.sin(a) + kv * Math.cos(ka), y: sign * speed * Math.cos(a) + kv * Math.sin(ka) };
        }
      }
    }
    if (spilled && world.balls.every((b) => b.state.kind === 'ground' && Math.hypot(b.vel.x, b.vel.y) < 0.25)) break;
  }
  if (!spilled) throw new Error(`load ${key} did not tip in the sim (check BB_TIP_POLLEN)`);
  const ground = world.balls.filter((b) => b.state.kind === 'ground');
  const meanY = ground.reduce((s, b) => s + b.pos.y, 0) / Math.max(1, ground.length);
  const sign = meanY >= 0 ? 1 : -1;
  return ground.map((b) => restOf(b.pos.x, b.pos.y, -BB_HIVE_X, sign));
}
/** Simulated tips for every load the video needs: load key -> n tips, one array per tip. */
type Pools = Map<string, Rest[][]>;
function simPools(n: number, override?: Spill): Pools {
  const pools: Pools = new Map();
  for (const key of new Set(tipLoads)) {
    const tips: Rest[][] = [];
    for (let s = 1; s <= n; s++) tips.push(simTip(s, key, override));
    pools.set(key, tips);
  }
  return pools;
}
/** The simulated distribution the video is compared with: each video tip's own load pool, once. */
function reference(pools: Pools): Rest[] {
  return tipLoads.flatMap((k) => (pools.get(k) ?? []).flat());
}

// ─── statistics ─────────────────────────────────────────────────────────────────────────────
function q(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
/** two-sample Kolmogorov–Smirnov distance: the largest gap between the two CDFs, 0..1 */
function ks(a: number[], b: number[]): number {
  const A = [...a].sort((x, y) => x - y), B = [...b].sort((x, y) => x - y);
  let i = 0, j = 0, d = 0;
  while (i < A.length && j < B.length) {
    const v = Math.min(A[i], B[j]);
    while (i < A.length && A[i] <= v) i++;
    while (j < B.length && B[j] <= v) j++;
    d = Math.max(d, Math.abs(i / A.length - j / B.length));
  }
  return d;
}
const absAngle = (rs: Rest[]) => rs.map((r) => Math.abs(r.angle));
function score(sim: Rest[]): number {
  return ks(measured.map((r) => r.r), sim.map((r) => r.r)) + ks(absAngle(measured), absAngle(sim));
}
function summary(rs: Rest[]) {
  const r = rs.map((x) => x.r), a = absAngle(rs), out = rs.map((x) => x.out), ac = rs.map((x) => x.across);
  return {
    n: rs.length,
    r_p10: q(r, 0.1), r_median: q(r, 0.5), r_p90: q(r, 0.9), r_max: Math.max(...r),
    out_median: q(out, 0.5),
    across_p10: q(ac, 0.1), across_p90: q(ac, 0.9),
    angle_abs_median: q(a, 0.5), angle_abs_p90: q(a, 0.9),
    inboard_share: rs.filter((x) => x.out < 0).length / rs.length,
  };
}

// ─── run ────────────────────────────────────────────────────────────────────────────────────
await initPhysics();

/** --selftest's hidden truth: deliberately far from the shipped constants. */
const TRUTH: Spill = { speed: [44, 76], fan: 22, kick: 6 };
if (SELFTEST) {
  for (let s = 5001; s <= 5015; s++) {
    const tip = simTip(s, '3n3p', TRUTH);
    measured.push(...tip);
    perTip.push(tip.length);
    tipLoads.push('3n3p');
  }
  console.log(`selftest: a fake video of 15 tips from BB_SPILL_SPEED [${TRUTH.speed.join(', ')}], FAN ${TRUTH.fan}, KICK ${TRUTH.kick}`);
}
if (measured.length === 0) {
  console.error('No usable tips (each needs balls, a calibration, and not hidden / not disturbed).');
  process.exit(1);
}
const t0 = Date.now();
const shippedPools = simPools(SIMS);
const shipped = reference(shippedPools);
const msPerTip = (Date.now() - t0) / (SIMS * shippedPools.size);
const loadMix = [...new Set(tipLoads)].map((k) => `${k} x${tipLoads.filter((x) => x === k).length}`).join(', ');

/**
 * HOW BIG A GAP IS NOISE. The textbook KS threshold assumes every element is independent, and
 * the six elements of one tip are not (they leave together and knock into each other), so it
 * calls ordinary tip-to-tip luck a real difference. Instead: draw as many SIMULATED tips as the
 * video has, whole tips at a time, 400 times, and see how far such a sample strays from the full
 * simulated distribution. A video gap above the 95th percentile of that is a real difference
 * (or a measurement error), not a small sample.
 */
function noiseP95(metric: (rs: Rest[]) => number[]): number {
  // Both sides are samples: the video's few tips AND the simulated reference. So each draw is two
  // independent resamples of whole simulated tips, one the video's size and one the reference's.
  // Each video tip draws from its own load's pool, so a mixed-load video is resampled as one.
  const rng = mulberry32(12345);
  const draw = (perVideoTip: number) => {
    const pick: Rest[] = [];
    for (const k of tipLoads) {
      const pool = shippedPools.get(k) ?? [];
      const n = perVideoTip > 0 ? perVideoTip : pool.length;
      for (let i = 0; i < n; i++) pick.push(...pool[Math.floor(rng() * pool.length)]);
    }
    return metric(pick);
  };
  const ds: number[] = [];
  for (let k = 0; k < 400; k++) ds.push(ks(draw(1), draw(0)));
  return q(ds, 0.95);
}
const distOf = (rs: Rest[]) => rs.map((r) => r.r);

const rows: [string, (s: ReturnType<typeof summary>) => string][] = [
  ['elements', (s) => String(s.n)],
  ['distance from pivot p10 (in)', (s) => s.r_p10.toFixed(1)],
  ['distance from pivot median (in)', (s) => s.r_median.toFixed(1)],
  ['distance from pivot p90 (in)', (s) => s.r_p90.toFixed(1)],
  ['distance from pivot max (in)', (s) => s.r_max.toFixed(1)],
  ['outboard median (in)', (s) => s.out_median.toFixed(1)],
  ['across p10 .. p90 (in)', (s) => `${s.across_p10.toFixed(1)} .. ${s.across_p90.toFixed(1)}`],
  ['|angle off outboard| median (deg)', (s) => s.angle_abs_median.toFixed(1)],
  ['|angle off outboard| p90 (deg)', (s) => s.angle_abs_p90.toFixed(1)],
  ['came to rest inboard of the pivot', (s) => `${(100 * s.inboard_share).toFixed(0)}%`],
];
const cols: { name: string; s: ReturnType<typeof summary> }[] = [
  { name: 'video', s: summary(measured) },
  { name: `sim (shipped)`, s: summary(shipped) },
];

let best: { spill: Spill; score: number } | null = null;
if (FIT) {
  const N = Math.min(SIMS, 40);
  const evalSpill = (sp: Spill) => score(reference(simPools(N, sp)));
  best = { spill: SHIPPED, score: evalSpill(SHIPPED) };
  console.log(`\nfit: ${N} tips per load per candidate, ~${((msPerTip * N * shippedPools.size) / 1000).toFixed(1)} s each. start: score ${best.score.toFixed(3)}`);
  const steps = { lo: [-15, -8, -4, 4, 8, 15], hi: [-20, -10, -5, 5, 10, 20], fan: [-20, -10, -5, 5, 10, 20], kick: [-8, -4, 4, 8] };
  for (let round = 0; round < 3; round++) {
    let moved = false;
    for (const key of ['lo', 'hi', 'fan', 'kick'] as const) {
      for (const dlt of steps[key]) {
        const cur = best.spill;
        const cand: Spill = {
          speed: [cur.speed[0] + (key === 'lo' ? dlt : 0), cur.speed[1] + (key === 'hi' ? dlt : 0)],
          fan: cur.fan + (key === 'fan' ? dlt : 0),
          kick: cur.kick + (key === 'kick' ? dlt : 0),
        };
        if (cand.speed[0] < 5 || cand.speed[1] <= cand.speed[0] || cand.fan < 0 || cand.fan > 90 || cand.kick < 0) continue;
        const sc = evalSpill(cand);
        if (sc < best.score - 0.005) {
          best = { spill: cand, score: sc };
          moved = true;
          console.log(`  speed [${cand.speed.join(', ')}] fan ${cand.fan} kick ${cand.kick}  ->  score ${sc.toFixed(3)}`);
        }
      }
    }
    if (!moved) break;
  }
  cols.push({ name: 'sim (best fit)', s: summary(reference(simPools(SIMS, best.spill))) });
}

console.log(`\nvideo: ${perTip.length} tips, ${measured.length} elements (${skipped} tips skipped: hidden, disturbed or empty)` +
  `; elements per tip ${q(perTip, 0.5)} median, ${Math.min(...perTip)}-${Math.max(...perTip)}`);
console.log(`sim: ${SIMS} tips per load (${loadMix}), 2D physics, shipped BB_SPILL_SPEED [${SHIPPED.speed.join(', ')}] in/s, FAN ${SHIPPED.fan} deg, KICK ${SHIPPED.kick} in/s\n`);
const w0 = Math.max(...rows.map((r) => r[0].length)) + 2;
console.log(''.padEnd(w0) + cols.map((c) => c.name.padStart(26)).join(''));
for (const [label, f] of rows) console.log(label.padEnd(w0) + cols.map((c) => f(c.s).padStart(26)).join(''));
console.log('');
/**
 * Below ten tips a verdict is a coin with a few sides: one unusually far spill moves the whole
 * video distribution. Tested: a synthetic clip of TWO tips straight from the shipped sim, both
 * of which happened to spill long, read as a "difference" at 0.40 against 0.34. So the gap is
 * still printed, but the word is withheld until there is enough video to mean it.
 */
const MIN_TIPS = 10;
const verdict = (d: number, p95: number) =>
  `${d.toFixed(3)} (noise up to ${p95.toFixed(3)}: ` +
  (perTip.length < MIN_TIPS ? `too few tips to judge, ${perTip.length} of ${MIN_TIPS})` : `${d > p95 ? 'REAL DIFFERENCE' : 'consistent'})`);
console.log('KS distance between video and shipped sim (0 = identical; noise = 95th percentile for this many tips):');
console.log(`  distance from pivot  ${verdict(ks(distOf(measured), distOf(shipped)), noiseP95(distOf))}`);
console.log(`  |angle off outboard| ${verdict(ks(absAngle(measured), absAngle(shipped)), noiseP95(absAngle))}`);
if (best) {
  console.log(`\nbest fit: BB_SPILL_SPEED [${best.spill.speed.join(', ')}], BB_SPILL_FAN ${best.spill.fan}, BB_SPILL_KICK ${best.spill.kick}` +
    ` (score ${best.score.toFixed(3)}). A suggestion only: the constants live in src/games/biobuzz/hive.ts and nothing was changed.`);
}

if (SELFTEST && best) {
  const err = (a: number, b: number) => Math.abs(a - b);
  const before = err(SHIPPED.speed[0], TRUTH.speed[0]) + err(SHIPPED.speed[1], TRUTH.speed[1]) + err(SHIPPED.fan, TRUTH.fan) + err(SHIPPED.kick, TRUTH.kick);
  const after = err(best.spill.speed[0], TRUTH.speed[0]) + err(best.spill.speed[1], TRUTH.speed[1]) + err(best.spill.fan, TRUTH.fan) + err(best.spill.kick, TRUTH.kick);
  console.log(`\nselftest: total distance from the truth went ${before} -> ${after} (speed lo+hi + fan + kick, in their own units).`);
  if (after >= before) { console.log('selftest FAILED: the fit did not move toward the truth.'); process.exitCode = 1; }
  else console.log('selftest passed: the fit moved toward the truth.');
}

const jsonOut = opt('json');
if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ files, loads: tipLoads, sims: SIMS, shipped: SHIPPED, columns: cols, best, measured }, null, 2) + '\n');
  console.log(`wrote ${jsonOut}`);
}
