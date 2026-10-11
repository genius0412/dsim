/**
 * `npm run hive-calibrate` — fit the DYNAMIC HIVE SEE-SAW to the field guide's own load rows.
 *
 * ── WHAT IT IS FITTING ──────────────────────────────────────────────────────────────────────
 * `src/games/biobuzz/sim3d/hive3d.ts` builds each HIVE as a dynamic bar on a revolute joint with
 * three calibrated terms (that file's header has the model). This script stages elements in the
 * up CELL exactly as the Event Field Setup Guide describes — against the back wall, in a line —
 * lets them settle on the real tray under the real solve, and measures the TORQUE they end up
 * applying. It then solves for the values that make the guide's acceptance table come out right:
 *
 *   §12.3, the four OFFICIAL rows          8 POLLEN TIPS · 7 does NOT
 *                                          3 POLLEN + 3 NECTAR TIPS · 2 + 3 does NOT
 *   owner-measured, 2026-09-12 (validation) 1n+7p · 2n+6p · 4n+1p · 5n+0p
 *
 * ⚠️ **STEPS 1-3 ARE A REPORT NOW, NOT A FIT** (2026-09-19). The tray stopped tipping on a torque
 * and started tipping on `BB_TIP_POLLEN`, the published table, because ONE COUNT DOES NOT
 * DETERMINE ONE TORQUE: staged four ways in one cell, 8 POLLEN weigh 4560 to 8051 and 7 POLLEN
 * 4146 to 6769, so the two counts' ranges overlap and no threshold could ever separate them.
 * `sim3d/hive3d.ts`'s header has the whole measurement. So the threshold this script solves no
 * longer decides anything — it MEASURES how far the see-saw's own balance sits from the table,
 * which is the number a re-weighed element set would have to move, and `BB3_HIVE_DETENT` is the
 * tray's PIN rather than the breakaway the load beats.
 *
 * **STEP 4 AND THE BALLAST'S LEVER ARM ARE STILL LIVE.** The ballast is what carries the tray to
 * its far stop once the load has left, and the damping is what makes that take the owner's 4.0 s
 * — neither is a trigger, and neither is touched by the change.
 *
 * ── WHY IT IS A SCRIPT AND NOT A CONSTANT ───────────────────────────────────────────────────
 * A torque is a LEVER ARM, and only the solve knows where a pile of spheres settles on a floor
 * sloping at 30°. Three POLLEN and three NECTAR do not sit where six POLLEN sit. That is also why
 * the manual's own answer is a TABLE: "[3] Pollen + [3] Nectar has less mass than [8] Pollen" and
 * both tip, which no single mass threshold expresses and no hand-computed arm would have found —
 * which is, in the end, the same fact that retired the torque trigger.
 *
 * ── HOW IT SOLVES ───────────────────────────────────────────────────────────────────────────
 * 1. **WEIGH** each row once, on the real tray, with the tray PINNED at its stop so nothing tips
 *    while it is being weighed. One number per row: the settled contents' torque about the pivot.
 * 2. **SOLVE the threshold.** The torque a row would have had to beat, back when torque decided.
 *    The admissible window is `(max torque that must NOT tip, min torque that MUST tip]` and the
 *    threshold is its midpoint, which is the largest margin available on both sides at once.
 * 3. **SWEEP the ballast's LEVER ARM** to split that threshold. At a stop the ballast and the
 *    detent are degenerate — both are terms in one number — so the split is a stated choice and
 *    the script says so rather than pretending to a two-dimensional fit it does not have.
 * 4. **FIT the damping** by bisection on a REAL 8-POLLEN tip, measured stop to stop, against
 *    `BB_TIP_SWING_S` (4.0 s, owner ruling). ⚠️ With the swing PACE switched off: since
 *    2026-10-11 a released tray is driven at the count's pace (`BB3_HIVE_SWING_EASE`), which takes
 *    `BB_TIP_SWING_S` at any damping, so this fits the FREE see-saw an undriven tray still is.
 * 5. **VERIFY** every row through the real `step3d` pipeline — which now has to agree with the
 *    PUBLISHED TABLE on every row, the owner's requirement — and **WRITE** the constants, with
 *    their derivation, into `config.ts`'s generated block.
 *
 * ⚠️ **THE RUN IS NOT BIT-REPRODUCIBLE ACROSS MACHINES.** A run on a Windows box produced DAMPING
 * 4.363 against the committed 4.466 and shifted two derivation figures by one. The committed
 * value measures 4.12 s stop to stop there, inside the HIVE3D lane's ±0.5 s of `BB_TIP_SWING_S`,
 * so it is correct as committed and re-running to "fix" it only moves the block again on the next
 * machine. It also REWRITES `config.ts`, so do not run it while anyone else is editing that file.
 *
 * Deterministic, headless, and NOT in `npm test` — it is a solve that takes a minute, and a red
 * `npm test` has to keep meaning "physics broke".
 */
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initPhysics } from '../src/sim/physicsEngine';
import { initPhysics3d } from '../src/games/biobuzz/sim3d/engine';
import { engineFor, trayTilt } from '../src/games/biobuzz/sim3d/engineImpl';
import { createBiobuzzWorld } from '../src/games/biobuzz/spawn';
import { step3d } from '../src/games/biobuzz/sim3d/step3d';
import { DEFAULT_ASSISTS } from '../src/sim/spawn';
import { BB_DEFAULT_SPEC } from '../src/games/biobuzz/robotConfig';
import {
  __setBallastForCalibration,
  __setHiveDynamicOverrideForTests,
  hiveCellLocalBox,
  hivePivotX,
  hiveTrayComW,
} from '../src/games/biobuzz/sim3d/bodies';
import {
  __setDetentForCalibration,
  __setSwingPaceForCalibration,
  hiveContentsTorque,
  hiveTiltAngle,
} from '../src/games/biobuzz/sim3d/hive3d';
import { rotate2 } from '../src/games/biobuzz/sim3d/math3';
import {
  BB3_ELEMENT_MASS,
  BB3_HIVE_BALLAST,
  BB3_HIVE_PIVOT_Z,
  BB3_HIVE_REST_W,
  BB3_HIVE_STOP_DEG,
  BB3_HIVE_TRAY_MASS,
  BB3_NECTAR_MASS_RATIO,
  BB_HIVE_TILT_DEG,
  BB_NECTAR_R,
  BB_POLLEN_R,
} from '../src/games/biobuzz/config';
import { BB_TIP_SWING_S } from '../src/games/biobuzz/hive';
import { GRAVITY } from '../src/config';
import type { Artifact, World } from '../src/types';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(REPO, 'src', 'games', 'biobuzz', 'config.ts');
const BEGIN = '// ── BEGIN GENERATED: hive-calibrate ';
const END = '// ── END GENERATED: hive-calibrate ';

const ALLIANCE = 'blue' as const;
const REST_RAD = (BB_HIVE_TILT_DEG * Math.PI) / 180;
const STOP_RAD = (BB3_HIVE_STOP_DEG * Math.PI) / 180;

await initPhysics();
await initPhysics3d();

// EVERY world this script builds is on the DYNAMIC tray, whatever `BB3_HIVE_DYNAMIC` currently
// says — the whole point of the run is to decide what that constant may be.
__setHiveDynamicOverrideForTests(true);

/** a BIOBUZZ 3D world with one robot at its anchor and NO elements — every row stages its own. */
function stage(seed: number): World {
  const w = createBiobuzzWorld(
    'free',
    seed,
    [
      {
        id: 0,
        alliance: 'blue',
        spec: { ...BB_DEFAULT_SPEC },
        assists: { ...DEFAULT_ASSISTS, fieldCentric: false, aimAssist: false },
        startIndex: 0,
      },
    ],
    undefined,
    '3d',
  );
  w.balls.length = 0;
  return w;
}

/**
 * Put `pollen` POLLEN and `nectar` NECTAR into the up CELL the way §12.3 stages them: AGAINST THE
 * BACK WALL, IN A LINE.
 *
 * "Against the back wall" is the INNER end of the cell — the one nearest the pivot, which is also
 * the DOWNHILL end of a floor tilted at 30°, so it is where anything put in the cell ends up
 * anyway. The line runs across the cell's WIDTH (the x axis, which is the hinge axis and
 * therefore level) and wraps outward as it fills. NECTAR go in first because that is the staged
 * configuration the guide's rows are written against: three NECTAR are already in the cell and
 * POLLEN are tossed in on top of them.
 */
function fillCell(w: World, pollen: number, nectar: number): number[] {
  const theta = hiveTiltAngle(w, ALLIANCE);
  const side: 1 | -1 = w.biobuzz!.hives[ALLIANCE].up === 'north' ? 1 : -1;
  const box = hiveCellLocalBox(side, ALLIANCE);
  const innerV = side > 0 ? box.vMin : box.vMax;
  const ids: number[] = [];
  let i = 0;
  const put = (isNectar: boolean): void => {
    const r = isNectar ? BB_NECTAR_R : BB_POLLEN_R;
    const perRow = 4;
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    const x = (col - (perRow - 1) / 2) * 4.6;
    const v = innerV + side * (r + 0.2 + row * 3.4);
    const wLocal = box.wMin + r + 0.2;
    const { a: y, b: z } = rotate2(v, wLocal, theta);
    const id = i + 1;
    ids.push(id);
    const el: Artifact = {
      id,
      color: isNectar ? 'blue' : 'yellow',
      state: { kind: 'ground' },
      pos: { x: hivePivotX(ALLIANCE) + x, y },
      vel: { x: 0, y: 0 },
      z: BB3_HIVE_PIVOT_Z + z - r,
      vz: 0,
      r,
    };
    w.balls.push(el);
    i++;
  };
  for (let k = 0; k < nectar; k++) put(true);
  for (let k = 0; k < pollen; k++) put(false);
  return ids;
}

/**
 * The torque a settled row applies to the tray, in the sim's own units (lb·in²/s²). POSITIVE
 * means "pulling the raised cell down", i.e. the quantity the hold has to beat.
 *
 * The tray is PINNED at its stop for the whole settle — re-pinned after every step, whatever the
 * load — so a row that is over the threshold does not tip before it has been weighed. Weighing
 * is independent of the ballast and the detent, which is why it is done once for all candidates.
 */
function weighRow(pollen: number, nectar: number): { torque: number; settled: number } {
  const w = stage(700 + pollen * 13 + nectar);
  fillCell(w, pollen, nectar);
  const e = engineFor(w);
  const body = e.hiveTrays[ALLIANCE];
  const sign = w.biobuzz!.hives[ALLIANCE].up === 'north' ? 1 : -1;
  const half = (sign * REST_RAD) / 2;
  const pinned = { x: Math.sin(half), y: 0, z: 0, w: Math.cos(half) };
  for (let t = 0; t < 240; t++) {
    step3d(w, 1 / 60, new Map());
    body.setRotation(pinned, false);
    body.setAngvel({ x: 0, y: 0, z: 0 }, false);
  }
  const theta = hiveTiltAngle(w, ALLIANCE);
  return {
    torque: -sign * hiveContentsTorque(w, ALLIANCE, theta),
    settled: w.biobuzz!.hives[ALLIANCE].contents.length,
  };
}

/** does a row TIP, with `detent` and this ballast in force? Runs the real pipeline end to end. */
function rowTips(pollen: number, nectar: number, detent: number, ballastW: number): boolean {
  __setDetentForCalibration(detent);
  __setBallastForCalibration({ mass: BB3_HIVE_BALLAST, w: ballastW });
  try {
    const w = stage(700 + pollen * 13 + nectar);
    fillCell(w, pollen, nectar);
    const startUp = w.biobuzz!.hives[ALLIANCE].up;
    for (let t = 0; t < 900; t++) step3d(w, 1 / 60, new Map());
    return w.biobuzz!.hives[ALLIANCE].up !== startUp;
  } finally {
    __setDetentForCalibration(null);
    __setBallastForCalibration(null);
  }
}

/**
 * STOP-TO-STOP SWING TIME (s), measured on a tray that is TIPPING FOR REAL: the 8-POLLEN row,
 * the field guide's own calibration load, staged in the up cell and left to do what it does.
 *
 * ⚠️ **AN EMPTY TRAY HAS NO SWING TIME, AND THAT IS NOT A DEFECT IN THE MEASUREMENT.** A see-saw
 * with its mass above the hinge is STABLE at either stop: nudge it and its own weight pushes it
 * back. It crosses only because a load carries it past level, which is the whole mechanism §9.6
 * describes. A first version of this function nudged an EMPTY tray 0.02 rad off its stop and
 * reported "never reached the far stop" at every damping from 0 to 40 — correctly, and it took
 * the measurement to notice.
 *
 * The clock starts when the tray LEAVES its stop (the detent breaking is the start of the swing,
 * not the tick the load landed) and stops at the far stop with the bar at rest — §10.5.1 B's
 * damper contact.
 */
function swingSeconds(damping: number, detent: number, ballastW: number): number {
  __setDetentForCalibration(detent);
  __setBallastForCalibration({ mass: BB3_HIVE_BALLAST, w: ballastW });
  // the FREE see-saw: a paced swing (`hiveSwingPace`) takes BB_TIP_SWING_S at any damping, so the
  // bisection below would run to one end of its range and write that into config.ts
  __setSwingPaceForCalibration(false);
  try {
    const w = stage(778);
    fillCell(w, 8, 0);
    const e = engineFor(w);
    const body = e.hiveTrays[ALLIANCE];
    body.setAngularDamping(damping);
    const sign = w.biobuzz!.hives[ALLIANCE].up === 'north' ? 1 : -1;
    let left = -1;
    for (let t = 0; t < 1800; t++) {
      step3d(w, 1 / 60, new Map());
      const th = trayTilt(body);
      const om = body.angvel().x;
      if (left < 0 && Math.abs(th) < STOP_RAD) left = t;
      if (left >= 0 && Math.abs(th) >= STOP_RAD && Math.sign(th) === -sign && Math.abs(om) < BB3_HIVE_REST_W) {
        return (t - left) / 60;
      }
    }
    return Infinity;
  } finally {
    __setDetentForCalibration(null);
    __setBallastForCalibration(null);
    __setSwingPaceForCalibration(null);
  }
}

// ── 1. WEIGH every row ───────────────────────────────────────────────────────────────────────
type Row = { pollen: number; nectar: number; tip: boolean; source: string };

/** the FOUR rows the calibration MUST satisfy — the Event Field Setup Guide §12.3 acceptance
 * table, the only published statement of what a HIVE tips on. */
const TARGETS: Row[] = [
  { pollen: 7, nectar: 0, tip: false, source: 'field guide §12.3' },
  { pollen: 8, nectar: 0, tip: true, source: 'field guide §12.3' },
  { pollen: 2, nectar: 3, tip: false, source: 'field guide §12.3' },
  { pollen: 3, nectar: 3, tip: true, source: 'field guide §12.3' },
];

/**
 * The owner's own readings off a real HIVE (2026-09-12), printed as VALIDATION and NOT required —
 * and `docs/biobuzz-reference.md` §4.1 says why in as many words: "No single linear weighting fits
 * it: 1n+7p and 2n+6p equal would make a NECTAR worth one POLLEN, and 3n+3p then contradicts it."
 * A torque model with ONE nectar mass cannot reproduce all of these at once, so requiring them
 * would be requiring the impossible. They are here because the SIZE and the SIGN of the misses
 * are the useful output: they say how far a mass model is from the real see-saw's packing, which
 * is the number a future re-measurement or a weighed element set has to move.
 *
 * ⚠️ TWO OF THESE MISSES ARE WHAT RETIRED THE TORQUE TRIGGER (2026-09-19), rather than being an
 * expected limit anyone had to live with. `1p+4n` is the owner's own bug report — the HUD read
 * "0 MORE TO TIP" and the tray did not move — and `6p+1n` / `5p+2n` tipped when the table says
 * they must not, so the shipped see-saw was violating the published rows in BOTH directions at
 * once. Every row below now runs through the table, so the `pipeline` column is expected to hold
 * on all eleven and the `torque` column is the measurement of the gap.
 */
const VALIDATION: Row[] = [
  { pollen: 6, nectar: 1, tip: false, source: 'owner 2026-09-12 (1n needs 7p)' },
  { pollen: 7, nectar: 1, tip: true, source: 'owner 2026-09-12' },
  { pollen: 5, nectar: 2, tip: false, source: 'owner 2026-09-12 (2n needs 6p)' },
  { pollen: 6, nectar: 2, tip: true, source: 'owner 2026-09-12' },
  { pollen: 0, nectar: 4, tip: false, source: 'owner 2026-09-12 (4n needs 1p)' },
  { pollen: 1, nectar: 4, tip: true, source: 'owner 2026-09-12' },
  { pollen: 0, nectar: 5, tip: true, source: 'owner 2026-09-12 (5n tips alone)' },
];

console.log(`[hive-calibrate] tray geometry: the cells' mid-height is ${hiveTrayComW(ALLIANCE).toFixed(3)} in ABOVE the pivot`);
console.log(
  `[hive-calibrate] element ${BB3_ELEMENT_MASS} lb, nectar x${BB3_NECTAR_MASS_RATIO}, tray ${BB3_HIVE_TRAY_MASS} lb + ballast ${BB3_HIVE_BALLAST} lb, g ${GRAVITY} in/s^2\n`,
);
console.log('[hive-calibrate] WEIGHING each row on the real tray (pinned at its stop, 4 s to settle):');
const weighed = new Map<string, { torque: number; settled: number }>();
for (const r of [...TARGETS, ...VALIDATION]) {
  const key = `${r.pollen}p+${r.nectar}n`;
  if (weighed.has(key)) continue;
  const m = weighRow(r.pollen, r.nectar);
  weighed.set(key, m);
  console.log(
    `  ${key.padEnd(7)} torque ${m.torque.toFixed(0).padStart(6)}   (${m.settled}/${r.pollen + r.nectar} settled in the cell)`,
  );
}

// ── 2. SOLVE the threshold ───────────────────────────────────────────────────────────────────
const mustTip = TARGETS.filter((r) => r.tip).map((r) => weighed.get(`${r.pollen}p+${r.nectar}n`)!.torque);
const mustNot = TARGETS.filter((r) => !r.tip).map((r) => weighed.get(`${r.pollen}p+${r.nectar}n`)!.torque);
const lo = Math.max(...mustNot);
const hi = Math.min(...mustTip);
/** one POLLEN's worth of torque at the arm these rows actually settle at — the unit the plan's
 * "0.5 element-weights of margin" is written in. MEASURED (8p minus 7p), never assumed. */
const oneElement = weighed.get('8p+0n')!.torque - weighed.get('7p+0n')!.torque;
const feasible = hi > lo;
const threshold = feasible ? (lo + hi) / 2 : lo + 1;
const margin = (hi - lo) / 2 / oneElement;
console.log(`\n[hive-calibrate] one POLLEN is worth ${oneElement.toFixed(0)} of torque at that arm (the 8p row minus the 7p row)`);
console.log(
  `[hive-calibrate] admissible window: (${lo.toFixed(0)}, ${hi.toFixed(0)}]  width ${(hi - lo).toFixed(0)} = ` +
    `${((hi - lo) / oneElement).toFixed(2)} element-weights  →  threshold ${threshold.toFixed(0)}, margin ±${margin.toFixed(2)}`,
);
if (!feasible) console.log('[hive-calibrate] ⚠️ THE WINDOW IS EMPTY — no threshold satisfies all four target rows.');
if (feasible && margin < 0.5) {
  console.log(
    `[hive-calibrate] ⚠️ THE MARGIN IS ${margin.toFixed(2)}, UNDER THE PLAN'S 0.5 ELEMENT-WEIGHTS. It is not a\n` +
      '                choice: the window between "7 POLLEN must not tip" and "3+3 must" is only\n' +
      `                ${((hi - lo) / oneElement).toFixed(2)} element-weights wide at this nectar mass ratio, so half of it is the most\n` +
      '                any threshold can have. Weighing a real element set is what moves it.',
  );
}

// ── 3. SWEEP THE BALLAST LEVER ARM to split the threshold ────────────────────────────────────
// The threshold is `|restoring at the stop| + DETENT`, and the restoring term is
// `M g comW sin(30°)` with `comW` a mass-weighted average that the ballast's DEPTH moves. So the
// sweep is over that depth: every candidate that puts the restoring torque under the threshold
// is admissible, and the detent takes up the remainder.
const SPLIT = 0.5;
const comTray = hiveTrayComW(ALLIANCE);
const massTotal = BB3_HIVE_TRAY_MASS + BB3_HIVE_BALLAST;
const restoringAt = (wBallast: number): number =>
  massTotal * GRAVITY * ((BB3_HIVE_TRAY_MASS * comTray + BB3_HIVE_BALLAST * wBallast) / massTotal) * Math.sin(REST_RAD);
const sweep: { w: number; restoring: number; detent: number }[] = [];
for (let wB = -24; wB <= 0.0001; wB += 0.25) {
  const restoring = restoringAt(wB);
  if (restoring <= 0) continue; // a tray whose CoM has reached the pivot is no longer bi-stable
  if (restoring > threshold) continue;
  sweep.push({ w: Math.round(wB * 100) / 100, restoring, detent: threshold - restoring });
}
console.log(
  `\n[hive-calibrate] ballast lever-arm sweep: w ∈ [-24, 0] step 0.25 → ${sweep.length} admissible ` +
    `(restoring torque in (0, ${threshold.toFixed(0)}])`,
);
if (sweep.length === 0) throw new Error('[hive-calibrate] no admissible ballast depth — widen the sweep or re-weigh');
let best = sweep[0];
let bestErr = Infinity;
for (const c of sweep) {
  const err = Math.abs(c.restoring / threshold - SPLIT);
  if (err < bestErr) {
    bestErr = err;
    best = c;
  }
}
const ballastW = best.w;
const detent = Math.round(best.detent);
const splitPct = (best.restoring / threshold) * 100;
console.log(
  `[hive-calibrate] chosen ballast w ${ballastW} in below the pivot → restoring ${best.restoring.toFixed(0)} ` +
    `(${splitPct.toFixed(0)}% of the threshold), DETENT ${detent}`,
);
console.log(
  '[hive-calibrate] NOTE: at a STOP the ballast and the detent are DEGENERATE — both are terms in\n' +
    '                ONE threshold, so the split above is a stated choice, not a fit. The ballast is\n' +
    '                what is NOT degenerate during the SWING: it is the torque that carries the tray\n' +
    '                to its far stop once the load has left, which is what the damping is fitted to.',
);

// ── 4. FIT the damping to the 4.0 s swing ────────────────────────────────────────────────────
console.log(`\n[hive-calibrate] fitting the damping to BB_TIP_SWING_S = ${BB_TIP_SWING_S}s (bisection, 8-POLLEN load):`);
let dLo = 0;
let dHi = 60;
for (let i = 0; i < 14; i++) {
  const mid = (dLo + dHi) / 2;
  const t = swingSeconds(mid, detent, ballastW);
  if (!Number.isFinite(t) || t > BB_TIP_SWING_S) dHi = mid;
  else dLo = mid;
  if (i % 4 === 3) {
    console.log(`  damping ${mid.toFixed(3)} → ${Number.isFinite(t) ? `${t.toFixed(2)}s` : 'never reached the far stop'}`);
  }
}
const damping = Math.round(((dLo + dHi) / 2) * 1000) / 1000;
const measured = swingSeconds(damping, detent, ballastW);
console.log(
  `  chosen damping ${damping} → stop-to-stop ${Number.isFinite(measured) ? `${measured.toFixed(2)}s` : 'NEVER REACHED THE FAR STOP'} (target ${BB_TIP_SWING_S})`,
);

// ── 5. VERIFY every row through the real pipeline ────────────────────────────────────────────
console.log('\n[hive-calibrate] verifying every row through the real step3d pipeline:');
let failures = 0;
let misses = 0;
const report: string[] = [];
for (const rows of [TARGETS, VALIDATION]) {
  for (const r of rows) {
    const key = `${r.pollen}p+${r.nectar}n`;
    const torque = weighed.get(key)!.torque;
    /**
     * TWO ANSWERS PER ROW, AND THE WHOLE POINT IS THAT THEY DIFFER.
     *
     *  · `got` is the SHIPPED pipeline's, which since 2026-09-19 is `BB_TIP_POLLEN` — the
     *    published table, read off the same `contents` the HUD counts. It must equal the row, on
     *    every row, or the driver's "N MORE TO TIP" is lying again; that is a FAIL.
     *  · `torqueSays` is what the fitted see-saw ALONE would have done, and a disagreement is a
     *    MISS: the measurement of how far a one-nectar-mass torque model sits from the table.
     *    It is expected on some rows and it is no longer a defect, because it no longer decides
     *    anything — see the header.
     */
    const got = rowTips(r.pollen, r.nectar, detent, ballastW);
    const torqueSays = torque > threshold;
    const ok = got === r.tip;
    if (!ok) failures++;
    else if (torqueSays !== r.tip) misses++;
    const m = (r.tip ? torque - threshold : threshold - torque) / oneElement;
    const line =
      `${ok ? (torqueSays === r.tip ? 'OK  ' : 'MISS') : 'FAIL'} ${key.padEnd(7)} expect ${r.tip ? 'TIP   ' : 'NO TIP'} ` +
      `pipeline ${got ? 'TIP   ' : 'NO TIP'} torque ${torqueSays ? 'TIP   ' : 'NO TIP'}` +
      ` margin ${m >= 0 ? '+' : ''}${m.toFixed(2)} element-weights  [${r.source}]`;
    console.log(`  ${line}`);
    report.push(line);
  }
}

// ── 6. WRITE the generated block ─────────────────────────────────────────────────────────────
const dynamic = failures === 0 && Number.isFinite(measured);
const src = readFileSync(CONFIG, 'utf8');
const b = src.indexOf(BEGIN);
const e = src.indexOf(END);
if (b < 0 || e < 0) throw new Error(`[hive-calibrate] markers not found in ${CONFIG}`);
/**
 * The index of the newline that ends the END marker's own line.
 *
 * ⚠️ `indexOf` returns −1 when that line is the LAST in the file with no trailing newline, and
 * `src.slice(-1 + 1)` is then `src.slice(0)` — the WHOLE FILE, appended after the block. That is
 * not a subtle failure mode: the first run of this script wrote a second complete copy of
 * `config.ts` underneath its own generated block, and `tsx` refused to parse the result on the
 * next run. The generated block IS at the end of the file, so this is the normal case, not an
 * edge one.
 */
const nl = src.indexOf('\n', e);
const endLine = nl < 0 ? src.length - 1 : nl;
const block = [
  `${BEGIN}─────────────────────────────────────────────────────────`,
  '// Written by `npm run hive-calibrate`. DO NOT HAND-EDIT the four values below — edit the',
  '// sweep, or the targets, and re-run. Everything outside these two markers is hand-written.',
  '//',
  '// DERIVATION. Every row was WEIGHED on the real tray — staged against the back wall in a line',
  '//   per the field guide, four seconds to settle, the tray pinned at its stop so nothing tipped',
  "//   while it was being weighed — and its settled contents' torque about the pivot read off the",
  `//   bodies. One POLLEN is worth ${oneElement.toFixed(0)} of torque at the arm those rows settle at (8p minus 7p).`,
  `//   The rows that must NOT tip topped out at ${lo.toFixed(0)}; the rows that MUST tip bottomed out at ${hi.toFixed(0)};`,
  `//   the threshold is that window's midpoint, ${threshold.toFixed(0)}, i.e. ±${margin.toFixed(2)} element-weights of margin.`,
  '//   At a stop the ballast and the detent are DEGENERATE (both are terms in that one threshold),',
  `//   so the lever arm was swept over w ∈ [-24, 0] and a ${splitPct.toFixed(0)}/${(100 - splitPct).toFixed(0)} split taken: restoring`,
  `//   ${best.restoring.toFixed(0)}, detent ${detent}. The damping was fitted by bisection against a REAL 8-POLLEN`,
  `//   tip, stop to stop, at ${Number.isFinite(measured) ? `${measured.toFixed(2)}s` : 'never'} against BB_TIP_SWING_S ${BB_TIP_SWING_S}s.`,
  '//   Rows, twice over: `pipeline` is what the shipped tray does (BB_TIP_POLLEN, the published',
  '//   table) and `torque` is what this fitted see-saw alone would have done. MISS = the two',
  '//   disagree, which is the measurement, not a defect — the table is the trigger. FAIL = the',
  '//   pipeline disagrees with the published row, which would be the HUD lying to the driver:',
  ...report.map((l) => `//     ${l}`),
  `export const BB3_HIVE_BALLAST = ${BB3_HIVE_BALLAST};`,
  `export const BB3_HIVE_BALLAST_AT: readonly [number, number] = [0, ${ballastW}];`,
  `export const BB3_HIVE_DETENT = ${detent};`,
  `export const BB3_HIVE_DAMPING = ${damping};`,
  `${END}───────────────────────────────────────────────────────────`,
].join('\n');
writeFileSync(CONFIG, `${src.slice(0, b)}${block}\n${src.slice(endLine + 1)}`, 'utf8');

console.log('\n[hive-calibrate] ── SUMMARY ────────────────────────────────────────────────────');
console.log(
  `[hive-calibrate] BB3_HIVE_BALLAST ${BB3_HIVE_BALLAST} lb at w ${ballastW} (tray ${BB3_HIVE_TRAY_MASS} lb APPROX, cells ${comTray.toFixed(2)} above the pivot)`,
);
console.log(`[hive-calibrate] BB3_HIVE_DETENT  ${detent}`);
console.log(
  `[hive-calibrate] BB3_HIVE_DAMPING ${damping}  (stop-to-stop ${Number.isFinite(measured) ? `${measured.toFixed(2)}s` : 'never'}, target ${BB_TIP_SWING_S}s)`,
);
const allRows = TARGETS.length + VALIDATION.length;
// the GATE: the shipped tray has to answer every published row the way the row reads, because
// that is what `hud.ts` promises the driver in "N MORE TO TIP".
console.log(`[hive-calibrate] pipeline vs the table: ${allRows - failures}/${allRows} rows hold — the owner's requirement`);
// the MEASUREMENT: how far this fitted see-saw's own torque sits from the same table. Counted
// only over rows the pipeline got right, so a FAIL is never also reported as a MISS.
console.log(
  `[hive-calibrate] torque model vs the table: ${allRows - failures - misses}/${allRows} agree, margin ±${margin.toFixed(2)} ` +
    'element-weights (one nectar mass cannot reach all of them, and no longer has to)',
);
console.log(
  `[hive-calibrate] BB3_HIVE_DYNAMIC should be ${dynamic ? 'TRUE' : 'FALSE'} ` +
    `(${dynamic ? 'every target row holds and the swing lands' : 'plan §3.6 fallback: keep the kinematic tray'})`,
);
console.log('[hive-calibrate] config.ts generated block rewritten.');
process.exit(0);
