import type { Check } from './harness';
import { mkWorld3d } from './harness';
import { step3d } from '../../src/games/biobuzz/sim3d/step3d';
import { worldHash } from '../../src/net/checksum';
import { engineFor, trayTilt } from '../../src/games/biobuzz/sim3d/engineImpl';
import {
  __setHiveDynamicOverrideForTests,
  hiveCellLocalBox,
  hivePivotX,
  hiveTrayComW,
  hiveTrayMassProps,
  trayHullPoints,
  useHiveDynamic,
} from '../../src/games/biobuzz/sim3d/bodies';
import { cadTrayHulls } from '../../src/games/biobuzz/sim3d/fieldColliders';
import { hiveContentsTorque, hiveHoldTorque, hiveTiltAngle, insideCell } from '../../src/games/biobuzz/sim3d/hive3d';
import { rotate2 } from '../../src/games/biobuzz/sim3d/math3';
import { bbScoreWorld } from '../../src/games/biobuzz/score';
import { bbSettled } from '../../src/games/biobuzz/settle';
import {
  MATCH_SETTLE_HOLD_S,
  MATCH_SETTLE_MAX_S,
  newSettleClock,
  settleStep,
} from '../../src/sim/settle';
import { BALL_REST_SPEED, GRAVITY, SIM_DT } from '../../src/config';
import {
  BB3_CELL_SEAT_DEPTH,
  BB3_HIVE_BALLAST,
  BB3_HIVE_DAMPING,
  BB3_HIVE_DETENT,
  BB3_HIVE_DYNAMIC,
  BB3_HIVE_PIVOT_Z,
  BB3_HIVE_REST_W,
  BB3_HIVE_STOP_DEG,
  BB3_HIVE_TIP_CREEP_W,
  BB3_HIVE_TRAY_MASS,
  BB3_REST_SPEED,
  BB3_TRAY_OUTER_SKIN,
  BB_HALF_X,
  BB_HALF_Y,
  BB_HIVE_OPEN_Z,
  BB_HIVE_TILT_DEG,
  BB_NECTAR_R,
  BB_POLLEN_R,
  BB_TIP_POLLEN,
} from '../../src/games/biobuzz/config';
import { BB_TIP_SWING_S, hiveLoad, hiveTakingSide, hiveWillTip } from '../../src/games/biobuzz/hive';
import { bbKindIndex } from '../../src/games/biobuzz/score';
import type { Alliance, Artifact, World } from '../../src/types';

/**
 * HIVE3D — the DYNAMIC SEE-SAW (Day 2 lane A, `docs/biobuzz/plan-3d.md` §9).
 *
 * The plan's lane spec: "tray angle matches manual heights at ±30°; open-face shot taken, each
 * closed face bounces; table rows 8/0 and 3/3 tip, 7/0 does not; a swing empties the tray and
 * every element lands within 1.0 s; G409 tag with and without a robot under".
 *
 * ⚠️ **THE LOAD TABLE RUNS UNDER BOTH TRAYS, AND THAT IS THE POINT OF THE LANE.** The kinematic
 * tray is the plan's own fallback (§3.6, §11) and a fallback nothing exercises is a fallback that
 * has already rotted. `__setHiveDynamicOverrideForTests` builds a world on either tray from the
 * same fixtures, so both models answer the guide's rows under the same staging.
 *
 * ⚠️ **BUT FLIPPING `BB3_HIVE_DYNAMIC` BACK IS *NOT* "A ONE-WORD CHANGE THAT STAYS PROVEN", AND
 * THIS FILE USED TO SAY IT WAS.** `bb.spill` — G409's entire tag — is written in exactly ONE
 * place, `hive3d.ts`'s `hiveDynamicTick`. The kinematic path never writes it and `contacts3d.ts`
 * returns immediately without it, so the word alone turns G409 off in 3D. The four G409 blocks
 * below ran under `if (BB3_HIVE_DYNAMIC)` and would simply have STOPPED RUNNING, leaving a green
 * lane over a dead rule. They are `withTray(true, …)` now: the dynamic tray is exercised whatever
 * the constant says, which is the only form in which the escape hatch could ever be honest.
 *
 * ⚠️ **AND THE DYNAMIC TRAY TIPS ON `BB_TIP_POLLEN`, NOT ON A TORQUE** (2026-09-19). The lane was
 * 27/27 green with the owner's bug live — "0 MORE TO TIP" and nothing happened on 1 POLLEN + 4
 * NECTAR — because it covered four §12.3 rows at ONE packing and never the two nectar-heavy rows
 * the HUD also promises. The three checks that now make that promise falsifiable are "the HUD
 * promise", "one short", and "packing independence"; see each for its measurement.
 */

const REST_RAD = (BB_HIVE_TILT_DEG * Math.PI) / 180;
const STOP_RAD = (BB3_HIVE_STOP_DEG * Math.PI) / 180;
const A: Alliance = 'blue';

/** run `fn` with the tray model forced either way, and always put the override back. */
function withTray<T>(dynamic: boolean, fn: () => T): T {
  __setHiveDynamicOverrideForTests(dynamic);
  try {
    return fn();
  } finally {
    __setHiveDynamicOverrideForTests(null);
  }
}

/** the world point of a tray-local `(x, v, w)` at tilt `theta` — the same mapping `derive.ts`
 * inverts, so a fixture staged with it is staged where the engine thinks the cell is. */
function cellPoint(alliance: Alliance, theta: number, x: number, v: number, w: number): { x: number; y: number; z: number } {
  const { a: y, b: z } = rotate2(v, w, theta);
  return { x: hivePivotX(alliance) + x, y, z: BB3_HIVE_PIVOT_Z + z };
}

/**
 * HOW A CELL IS LOADED, which is not a detail — it is what hid the owner's bug for a week.
 *
 * `guide` is §12.3's own words and the staging `scripts/hive-calibrate.ts` fits against: against
 * the back wall, four across, rows running OUT along the tray. The other three are the same
 * COUNT at different lever arms, because a real cell is loaded by shots landing where they land:
 *
 *  · `crammed4` / `crammed2` pile the rows UP the back wall (along `w`) instead of running them
 *    out along `v`, which is what a volley into a tilted tray actually does — every element ends
 *    up at the shortest arm there is.
 *  · `line2` runs two across and four deep, the longest arm a cell can give a count.
 */
type Packing = 'guide' | 'crammed4' | 'crammed2' | 'line2';

/** stage `pollen` + `nectar` in the up cell under one of the packings above. `guide` is the
 * default and is byte-identical to what this helper did before the packings existed. */
function fillCell(w: World, pollen: number, nectar: number, packing: Packing = 'guide'): number[] {
  const theta = hiveTiltAngle(w, A);
  const side: 1 | -1 = w.biobuzz!.hives[A].up === 'north' ? 1 : -1;
  const box = hiveCellLocalBox(side, A);
  const innerV = side > 0 ? box.vMin : box.vMax;
  const perRow = packing === 'crammed2' || packing === 'line2' ? 2 : 4;
  const stack = packing === 'crammed4' || packing === 'crammed2';
  const ids: number[] = [];
  let i = 0;
  const put = (isNectar: boolean): void => {
    const r = isNectar ? BB_NECTAR_R : BB_POLLEN_R;
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    const x = (col - (perRow - 1) / 2) * 4.6;
    // `stack` advances rows in `w` (up the back wall) instead of `v` (out along the tray) — same
    // count, shortest arm instead of longest. 2r per layer is balls touching, which is what a
    // pile is; the solve settles the overlap either way.
    const p = stack
      ? cellPoint(A, theta, x, innerV + side * (r + 0.2), box.wMin + r + 0.2 + row * 2 * r)
      : cellPoint(A, theta, x, innerV + side * (r + 0.2 + row * 3.4), box.wMin + r + 0.2);
    ids.push(i + 1);
    w.balls.push({
      id: i + 1,
      color: isNectar ? 'blue' : 'yellow',
      state: { kind: 'ground' },
      pos: { x: p.x, y: p.y },
      vel: { x: 0, y: 0 },
      z: p.z - r,
      vz: 0,
      r,
    } as Artifact);
    i++;
  };
  for (let k = 0; k < nectar; k++) put(true);
  for (let k = 0; k < pollen; k++) put(false);
  return ids;
}

function loaded(seed: number, pollen: number, nectar: number, packing: Packing = 'guide'): { world: World; ids: number[] } {
  const w = mkWorld3d('free', seed);
  w.balls.length = 0;
  return { world: w, ids: fillCell(w, pollen, nectar, packing) };
}

/** the up CELL's own box, on a freshly built world. */
function upBox(w: World): { side: 1 | -1; box: ReturnType<typeof hiveCellLocalBox> } {
  const side: 1 | -1 = w.biobuzz!.hives[A].up === 'north' ? 1 : -1;
  return { side, box: hiveCellLocalBox(side, A) };
}

/** local `w` (height above the tray bar, in the tray's own tilted frame) of a world `(y, z)` —
 * the inverse of `cellPoint`'s rotation, which is how a DEPTH BELOW THE RIM is measured. */
function localW(theta: number, y: number, z: number): number {
  return rotate2(y, z - BB3_HIVE_PIVOT_Z, -theta).b;
}

/**
 * A BALLISTIC ARRIVAL at the up CELL: the launch point and velocity that reach the tray-local
 * point `(0, mid-v, wMin + aimW)` in `flightS` seconds, from `dHoriz` inches outboard of it and
 * `dUp` inches above it. A short flight is a flat turret shot; a long one is a dumper's lob.
 *
 * Built off a world with the SAME SEED the arrival will be stepped in, so the tray it is aimed at
 * is the tray it meets.
 */
function shotInto(seed: number, dHoriz: number, dUp: number, flightS: number, aimW = 2): { start: Vec3; vel: Vec3 } {
  const w = mkWorld3d('free', seed);
  const theta = hiveTiltAngle(w, A);
  const { side, box } = upBox(w);
  const target = cellPoint(A, theta, 0, (box.vMin + box.vMax) / 2, box.wMin + aimW);
  const start = { x: target.x, y: target.y + side * dHoriz, z: target.z + dUp };
  return {
    start,
    vel: {
      x: 0,
      y: (target.y - start.y) / flightS,
      z: (target.z - start.z) / flightS + 0.5 * GRAVITY * flightS,
    },
  };
}

type Vec3 = { x: number; y: number; z: number };

/** what one arrival did: when its centre entered the cell interior, when `contents` first held
 * it, when it first read AT REST, how deep below the rim it ever got, how shallow it came back
 * after being counted, how many ticks it spent inside in one run, and whether it ever DROPPED
 * OUT of `contents` again. Every registration check below is one field of this. */
interface Arrival {
  entered: number;
  counted: number;
  rested: number;
  deepest: number;
  shallowestAfterCount: number;
  runIn: number;
  endIn: boolean;
  drops: number;
  minCellCountAfter: number;
}

function arrive(seed: number, s: Vec3, v: Vec3, ticks = 300): Arrival {
  const w = mkWorld3d('free', seed);
  w.balls.length = 0;
  w.balls.push({
    id: 1,
    color: 'yellow',
    state: { kind: 'flight', target: 'blue' },
    pos: { x: s.x, y: s.y },
    vel: { x: v.x, y: v.y },
    z: s.z - BB_POLLEN_R,
    vz: v.z,
    r: BB_POLLEN_R,
  } as Artifact);
  const rim = upBox(w).box.wMax;
  const out: Arrival = {
    entered: -1,
    counted: -1,
    rested: -1,
    deepest: -Infinity,
    shallowestAfterCount: Infinity,
    runIn: 0,
    endIn: false,
    drops: 0,
    minCellCountAfter: Infinity,
  };
  let run = 0;
  let was = false;
  for (let t = 0; t < ticks; t++) {
    step3d(w, 1 / 60, new Map());
    const b = w.balls.find((x) => x.id === 1);
    if (!b) break;
    const th = trayTilt(engineFor(w).hiveTrays[A]);
    const z = b.z + (b.r ?? BB_POLLEN_R);
    const depth = rim - localW(th, b.pos.y, z);
    const ins = insideCell(b.pos.x, b.pos.y, z, A, 1, th) || insideCell(b.pos.x, b.pos.y, z, A, -1, th);
    if (ins) {
      if (out.entered < 0) out.entered = t;
      out.deepest = Math.max(out.deepest, depth);
    }
    run = ins ? run + 1 : 0;
    out.runIn = Math.max(out.runIn, run);
    out.endIn = ins;
    const now = w.biobuzz!.hives[A].contents.includes(1);
    if (now && out.counted < 0) out.counted = t;
    if (was && !now) out.drops++;
    was = now;
    if (out.counted >= 0) {
      out.shallowestAfterCount = Math.min(out.shallowestAfterCount, depth);
      out.minCellCountAfter = Math.min(out.minCellCountAfter, bbScoreWorld(w)[A].cellCount);
    }
    if (out.rested < 0 && t > 2 && Math.hypot(b.vel.x, b.vel.y, b.vz) < BB3_REST_SPEED) out.rested = t;
  }
  return out;
}

/** step a staged cell until its up side swaps, up to `ticks`. Returns the tick it tipped on, or
 * -1 — the one question every table check below is asking. */
function tipTick(world: World, ticks = 600): number {
  const startUp = world.biobuzz!.hives[A].up;
  for (let t = 0; t < ticks; t++) {
    step3d(world, 1 / 60, new Map());
    if (world.biobuzz!.hives[A].up !== startUp) return t;
  }
  return -1;
}

export function hive3dChecks(check: Check): void {
  // ---- the model, reported ------------------------------------------------------------------
  {
    const props = hiveTrayMassProps(A);
    console.log(
      `[smoke-bb hive3d] tray: ${BB3_HIVE_TRAY_MASS} lb + ${BB3_HIVE_BALLAST} lb ballast, cells ${hiveTrayComW(A).toFixed(2)} above the pivot, ` +
        `net CoM ${props.comW.toFixed(3)}, inertia ${props.inertia.toFixed(0)}; detent ${BB3_HIVE_DETENT}, damping ${BB3_HIVE_DAMPING}`,
    );
    check(
      `the DYNAMIC see-saw is the shipped tray (BB3_HIVE_DYNAMIC ${BB3_HIVE_DYNAMIC})`,
      BB3_HIVE_DYNAMIC === useHiveDynamic(),
      `constant ${BB3_HIVE_DYNAMIC}, reader ${useHiveDynamic()}`,
    );
    /**
     * THE BI-STABILITY IS THE TRAY'S SHAPE, ASSERTED DIRECTLY. Its centre of mass has to be ABOVE
     * the pivot or the whole mechanism is a different one: a see-saw with its mass below the
     * hinge hangs level and has no stable stops at all, so nothing would hold a loaded cell up
     * and §9.6's "bi-stable" would be a term the sim does not have.
     */
    check(
      'bi-stable by construction: the tray + ballast centre of mass is ABOVE the pivot',
      props.comW > 0,
      `net comW ${props.comW.toFixed(3)} (cells ${hiveTrayComW(A).toFixed(3)}, ballast pulls it down)`,
    );
  }

  // ---- the manual's own heights at ±30° -----------------------------------------------------
  //
  // Fig 9-10 prints the up-CELL opening at 53.5 … 65.6 above the tiles and the CAD measures
  // 53.375 … 65.497 (`BB_HIVE_OPEN_Z`, the generated figure). That is a statement about the TRAY
  // AT ITS STOP, so it is a statement about this angle — and it is the check that says the
  // dynamic body is seated where the kinematic one was rather than merely near it.
  for (const dynamic of [true, false]) {
    withTray(dynamic, () => {
      const w = mkWorld3d('free', dynamic ? 810 : 811);
      step3d(w, 1 / 60, new Map());
      const theta = hiveTiltAngle(w, A);
      const side: 1 | -1 = w.biobuzz!.hives[A].up === 'north' ? 1 : -1;
      const box = hiveCellLocalBox(side, A);
      const mouthV = side > 0 ? box.vMax : box.vMin;
      const lo = cellPoint(A, theta, 0, mouthV, box.wMin).z;
      const hi = cellPoint(A, theta, 0, mouthV, box.wMax).z;
      const label = dynamic ? 'dynamic' : 'kinematic';
      check(
        `[${label}] the tray rests at ${BB_HIVE_TILT_DEG}deg`,
        Math.abs(Math.abs(theta) - REST_RAD) < 2e-3,
        `theta ${((theta * 180) / Math.PI).toFixed(3)}deg`,
      );
      check(
        `[${label}] the up-CELL mouth is at the manual's own heights (BB_HIVE_OPEN_Z)`,
        Math.abs(lo - BB_HIVE_OPEN_Z[0]) < 0.1 && Math.abs(hi - BB_HIVE_OPEN_Z[1]) < 0.1,
        `mouth ${lo.toFixed(3)}..${hi.toFixed(3)} vs ${BB_HIVE_OPEN_Z[0]}..${BB_HIVE_OPEN_Z[1]}`,
      );
    });
  }

  // ---- the load table, under BOTH trays -----------------------------------------------------
  //
  // The dynamic tray does not read `BB_TIP_POLLEN` at all — it tips when the load out-torques
  // the hold — so this is the check that says the two models AGREE on the field guide's §12.3
  // acceptance rows. Under the kinematic tray it is the table itself being read.
  {
    const rows: readonly [number, number, boolean][] = [
      [7, 0, false],
      [8, 0, true],
      [2, 3, false],
      [3, 3, true],
    ];
    for (const dynamic of [true, false]) {
      withTray(dynamic, () => {
        const label = dynamic ? 'dynamic' : 'kinematic';
        for (const [pollen, nectar, expect] of rows) {
          const { world } = loaded(820 + pollen * 7 + nectar + (dynamic ? 0 : 100), pollen, nectar);
          const startUp = world.biobuzz!.hives[A].up;
          for (let t = 0; t < 900; t++) step3d(world, 1 / 60, new Map());
          const tipped = world.biobuzz!.hives[A].up !== startUp;
          check(
            `[${label}] load table: ${pollen}p+${nectar}n ${expect ? 'TIPS' : 'does NOT tip'} (field guide §12.3)`,
            tipped === expect,
            `tipped=${tipped}`,
          );
        }
      });
    }
  }

  // ---- THE HUD'S PROMISE, STATED AS A CHECK --------------------------------------------------
  //
  // ⚠️ **THIS IS THE OWNER'S BUG** (2026-09-19: "0 more to tip" and nothing happens). `hud.ts`
  // computes `needed = BB_TIP_POLLEN[min(nectar, 5)] − pollen` off `hives[a].contents` and
  // `HudSlots.tsx` prints it; the tray has to agree on EVERY row of that table, not on the four
  // §12.3 rows above. It did not: on 1 POLLEN + 4 NECTAR the HUD read 0 more and the load weighed
  // 5701 against a hold of 5915, so the tray sat on its stop for the rest of the match. Both
  // numbers come from one list and one predicate now (`hiveWillTip`), which is what makes this
  // check pass by construction rather than by calibration — and the reason it stays is that it
  // is the check which fails the moment anything reintroduces a second opinion.
  {
    for (const dynamic of [true, false]) {
      withTray(dynamic, () => {
        const label = dynamic ? 'dynamic' : 'kinematic';
        for (let n = 0; n < BB_TIP_POLLEN.length; n++) {
          const p = BB_TIP_POLLEN[n];
          const t = tipTick(loaded(900 + n * 2 + (dynamic ? 0 : 1), p, n).world);
          check(
            `[${label}] the HUD promise: ${p}p+${n}n reads "0 MORE TO TIP" and TIPS`,
            t >= 0,
            `tipped at tick ${t}`,
          );
        }
      });
    }
  }

  // ---- and the other side of the same table: one element short must NOT tip ------------------
  //
  // Half a promise is not one. Two of these rows TIPPED on the torque trigger — 6p+1n and 5p+2n,
  // which are `scripts/hive-calibrate.ts`'s own MISS rows — so the shipped tray was violating
  // §12.3 in BOTH directions at once while this lane read green.
  {
    for (const dynamic of [true, false]) {
      withTray(dynamic, () => {
        const label = dynamic ? 'dynamic' : 'kinematic';
        for (let n = 0; n < BB_TIP_POLLEN.length; n++) {
          const p = BB_TIP_POLLEN[n] - 1;
          if (p < 0) continue; // the 0p+5n row has no "one short" — five NECTAR tip on their own
          const t = tipTick(loaded(930 + n * 2 + (dynamic ? 0 : 1), p, n).world);
          check(
            `[${label}] one short of the table: ${p}p+${n}n does NOT tip`,
            t < 0,
            `tipped at tick ${t}`,
          );
        }
      });
    }
  }

  // ---- PACKING INDEPENDENCE, which is what actually hid the bug ------------------------------
  //
  // ⚠️ **ONE COUNT DOES NOT DETERMINE ONE TORQUE, AND THAT IS WHY THE TABLE HAS TO BE THE
  // TRIGGER.** A real cell is loaded by shots landing where they land; "in a line against the
  // back wall" is a STAGING INSTRUCTION in the field guide, not a physical law. Staged four ways
  // at one count, the same 8 POLLEN weigh anywhere from a pile at the back wall to a two-wide
  // line reaching down the tray, and the ranges for 8 and for 7 OVERLAP — so no `BB3_HIVE_DETENT`
  // could ever have separated them. The console line below is that measurement; the checks are
  // that the table wins over it in both directions.
  {
    const packings: readonly Packing[] = ['guide', 'crammed4', 'crammed2', 'line2'];
    const report = (pollen: number, nectar: number): string =>
      packings
        .map((pk) => {
          // 15 ticks is long enough for a staged pile to settle against the tray. The reading
          // taken is the LAST tick the tray was still AT ITS STOP, which is what makes this a
          // measurement of the LOAD rather than of the trigger's timing.
          //
          // ⚠️ It used to be "the torque at tick 15", on the argument that the pin could not have
          // lifted by then (the 8-POLLEN breakaway was ~tick 29). That argument died with the
          // registration fix (2026-09-19): membership is geometry now, a STAGED pile is over
          // threshold on tick one, and the 8-POLLEN rows broke away at tick 13 — so tick 15 was
          // reading a tray that had been swinging for two ticks, and the printed numbers moved
          // (8 POLLEN guide 5656 → 6648) for a reason that has nothing to do with the load.
          const w = loaded(960 + pollen * 7 + nectar, pollen, nectar, pk).world;
          let atStop = 0;
          for (let t = 0; t < 15; t++) {
            step3d(w, 1 / 60, new Map());
            const th = hiveTiltAngle(w, A);
            if (Math.abs(th) >= STOP_RAD) atStop = Math.abs(hiveContentsTorque(w, A, th));
          }
          return `${pk} ${atStop.toFixed(0)}`;
        })
        .join(' · ');
    withTray(true, () => {
      console.log(`[smoke-bb hive3d] 8 POLLEN torque by packing: ${report(8, 0)}`);
      console.log(`[smoke-bb hive3d] 7 POLLEN torque by packing: ${report(7, 0)}`);
      // the owner's own row, for the record: at threshold by the table, under the hold by torque
      console.log(`[smoke-bb hive3d] 1p+4n (the reported bug) torque by packing: ${report(1, 4)}`);
      for (const pk of packings) {
        const t = tipTick(loaded(980 + packings.indexOf(pk), 8, 0, pk).world);
        check(
          `[dynamic] packing independence: 8 POLLEN packed "${pk}" still TIPS`,
          t >= 0,
          `tipped at tick ${t}`,
        );
      }
      for (const pk of packings) {
        const t = tipTick(loaded(990 + packings.indexOf(pk), 7, 0, pk).world);
        check(
          `[dynamic] packing independence: 7 POLLEN packed "${pk}" does NOT tip`,
          t < 0,
          `tipped at tick ${t}`,
        );
      }
    });
  }

  // ---- the swing: 4.0 s stop to stop, and the tray empties within 1.0 s ---------------------
  withTray(true, () => {
    const { world, ids } = loaded(840, 8, 0);
    const e = engineFor(world);
    const body = e.hiveTrays[A];
    const sign = world.biobuzz!.hives[A].up === 'north' ? 1 : -1;
    let left = -1;
    let arrived = -1;
    let emptied = -1;
    /** per element: the tick it stopped being inside a cell, and the tick it first reached the
     * tiles at rest. `landed − leftCell` is the FALL, which is what the plan's 1.0 s is about. */
    const leftCell = new Map<number, number>();
    const landed = new Map<number, number>();
    for (let t = 0; t < 900; t++) {
      step3d(world, 1 / 60, new Map());
      const th = trayTilt(body);
      const om = body.angvel().x;
      if (left < 0 && Math.abs(th) < STOP_RAD) left = t;
      if (left >= 0 && arrived < 0 && Math.abs(th) >= STOP_RAD && Math.sign(th) === -sign && Math.abs(om) < BB3_HIVE_REST_W) {
        arrived = t;
      }
      let stillIn = 0;
      for (const id of ids) {
        const b = world.balls.find((x) => x.id === id);
        if (!b) continue;
        const z = b.z + (b.r ?? BB_POLLEN_R);
        if (insideCell(b.pos.x, b.pos.y, z, A, 1, th) || insideCell(b.pos.x, b.pos.y, z, A, -1, th)) {
          stillIn++;
          continue;
        }
        if (!leftCell.has(id)) leftCell.set(id, t);
        // ⚠️ FIRST TOUCH, NOT FIRST SETTLE. This used to also require `|vz| < 2`, which on the
        // old dead tiles was the same tick and since the bounce landed (owner item 21, e 0.25 →
        // 0.57) is not: an element that touches down at 160 in/s now leaves again at 90 and does
        // not have `|vz| < 2` near the floor until it has finished bouncing, ~0.9 s later. The
        // check below is about the FALL — see its own header — so it measures the fall.
        if (!landed.has(id) && b.z <= 0.25) landed.set(id, t);
      }
      if (emptied < 0 && stillIn === 0) emptied = t;
    }
    const swing = (arrived - left) / 60;
    const falls = ids.map((id) => ((landed.get(id) ?? 1e9) - (leftCell.get(id) ?? 0)) / 60);
    const worstFall = Math.max(...falls);
    console.log(
      `[smoke-bb hive3d] 8-POLLEN tip: broke away at tick ${left}, cell empty at ${emptied} ` +
        `(${((emptied - left) / 60).toFixed(2)}s later), far stop at ${arrived} (swing ${swing.toFixed(2)}s); ` +
        `falls ${falls.map((f) => f.toFixed(2)).join(', ')}s`,
    );
    check(
      `the swing is stop-to-stop in about BB_TIP_SWING_S (${BB_TIP_SWING_S}s), the owner's ruling`,
      arrived > left && Math.abs(swing - BB_TIP_SWING_S) < 0.5,
      `measured ${swing.toFixed(2)}s (left the stop at tick ${left}, arrived at ${arrived})`,
    );
    /**
     * ⚠️ **"EVERY ELEMENT LANDS WITHIN 1.0 s" IS ABOUT THE FALL, NOT ABOUT THE SWING**, and the
     * measurement is what settles which reading the sentence can carry. The tray takes 4.0 s stop
     * to stop by the owner's own ruling and does not pass LEVEL until 2.0 s in, so no element can
     * be on the tiles a second after the tip STARTS — that reading would contradict a ruling this
     * same lane checks two lines up. What is measurable, and what the sentence is about, is the
     * interval between an element leaving the cell and reaching the tiles: a ~30-in fall, about
     * 0.4 s, with 1.0 s the generous bound.
     *
     * MEASURED, and worth writing down because it surprised: the cell is not empty until 3.45 s
     * after the breakaway — 1.45 s after level. The tray floor's friction is 0.6 and its tilt is
     * 30°, and `atan(0.6)` is 30.96°, so the pile sits almost exactly at its own sliding threshold
     * as the tray passes level; what gets the elements out is ROLLING, which has no such
     * threshold, and rolling out of an 11.75-in cell takes a moment. That is a real hive's
     * behaviour rather than a defect: a tray does not fling its load, it lets it run out.
     */
    check(
      'a swing empties the cell, and every element LANDS within 1.0 s of leaving it',
      emptied >= 0 && Number.isFinite(worstFall) && worstFall <= 1.0,
      `worst fall ${worstFall.toFixed(2)}s; the cell emptied ${((emptied - left) / 60).toFixed(2)}s after breakaway`,
    );
    const stillListed = ids.filter((id) => world.biobuzz!.hives[A].contents.includes(id));
    check('after the swing the cell reads empty', stillListed.length === 0, `${stillListed.length} still listed`);
  });

  // ---- THE SPILL DISPERSES, AND IT STILL COMES TO REST (owner item 21, 2026-09-19) ----------
  /**
   * "In real life, the balls bounce and disperse a lot more after the hive tips and it hits the
   * field tiles."
   *
   * The lever is the element/TILE restitution — `BB3_ELEMENT_RESTITUTION` plus the floor's
   * MULTIPLY rule (`sim3d/bodies.ts` `TILE_RESTITUTION`), which is what lets an element carry the
   * real pair while a chassis still reads zero on the same collider. Both of those headers carry
   * the derivation; what is asserted here is the OUTCOME on a real tip, in both directions:
   *
   *  · a FLOOR, so a future change that deadens the tiles again puts the pile back under the hive
   *    and this fails. ON THIS EXACT FIXTURE the pile's 90th-percentile radius about its own
   *    centroid is **17.8 in at the old e 0.25 and 22.9 in at e 0.57** — the floor of 20 sits
   *    between them, and reverting either constant turns this check red. It is ONE fixture and
   *    the landing is chaotic, so the number is a ratchet rather than a tolerance: across four
   *    packings the mean went 29.7 → 33.4 in and individual packings moved both ways.
   *  · a CEILING on both the spread and the SETTLE, because a bouncier world is one that can stop
   *    settling. Every scoring instant §10.5 assesses waits for "all at rest", so an unbounded
   *    settle is a score that never lands. Measured here: **6.60 s before, 6.62 s after**, from
   *    the tick the tray is staged — the bounce cost 0.02 s, because the 4.0 s swing dominates.
   *    Worst over four packings 9.17 s before / 9.00 s after. Nothing left the field either way
   *    (`containmentFixes`, pinned by the SIM3D lane, is 0).
   */
  withTray(true, () => {
    const { world, ids } = loaded(845, 8, 0);
    const pivotX = hivePivotX(A);
    let restAt = -1;
    const TICKS = 1200; // 20 s — comfortably past the 4.0 s swing plus the roll
    for (let t = 0; t < TICKS; t++) {
      step3d(world, 1 / 60, new Map());
      const bs = ids.map((id) => world.balls.find((b) => b.id === id)).filter((b): b is Artifact => !!b);
      const moving = bs.filter((b) => Math.hypot(b.vel.x, b.vel.y) > 1 || Math.abs(b.vz) > 1 || b.z > 0.5);
      if (moving.length === 0 && world.biobuzz!.hives[A].tips > 0) {
        if (restAt < 0) restAt = t;
      } else {
        restAt = -1;
      }
    }
    const bs = ids.map((id) => world.balls.find((b) => b.id === id)).filter((b): b is Artifact => !!b);
    const cx = bs.reduce((s, b) => s + b.pos.x, 0) / bs.length;
    const cy = bs.reduce((s, b) => s + b.pos.y, 0) / bs.length;
    const rc = bs.map((b) => Math.hypot(b.pos.x - cx, b.pos.y - cy)).sort((a, b) => a - b);
    const r90 = rc[Math.ceil(0.9 * rc.length) - 1];
    const fromCell = bs.map((b) => Math.hypot(b.pos.x - pivotX, b.pos.y)).sort((a, b) => a - b);
    const nearest = fromCell[0];
    const farthest = fromCell[fromCell.length - 1];
    const inField = bs.every((b) => Math.abs(b.pos.x) <= BB_HALF_X && Math.abs(b.pos.y) <= BB_HALF_Y);
    console.log(
      `[smoke-bb hive3d] spill dispersal: pile r90 ${r90.toFixed(1)}in about its centroid, ` +
        `${nearest.toFixed(1)}..${farthest.toFixed(1)}in from the pivot, everything at rest at ${(restAt / 60).toFixed(2)}s`,
    );
    check(
      'the spill DISPERSES — the pile is 20..60 in wide, not a heap under the hive',
      r90 >= 20 && r90 <= 60,
      `90th-percentile radius ${r90.toFixed(1)}in (17.8 at the old dead tiles)`,
    );
    check(
      'the spill still comes to REST, inside the field, within 12 s',
      restAt >= 0 && restAt / 60 <= 12 && inField,
      `rest at ${restAt < 0 ? 'never' : `${(restAt / 60).toFixed(2)}s`}, in field ${inField}`,
    );
  });

  // ---- the trigger is the TABLE, and the torque is only the measurement ----------------------
  //
  // This check used to read "the detent is a TORQUE BALANCE: 7 POLLEN pull less than the hold",
  // and it would have gone on passing over a rule that no longer exists. The console line is kept
  // exactly as it was, because it is still the useful measurement — and it is now the EVIDENCE
  // THAT THE TWO DISAGREE: at the guide's own staging 7p pulls ~5647 and 8p ~7284 against a hold
  // of ~5915, which looks like a clean separation until the packing check above moves both
  // numbers across each other. What is asserted instead is the OUTCOME the table promises: the
  // under-threshold tray has not left its stop, and the over-threshold one has.
  withTray(true, () => {
    const under = loaded(850, 7, 0).world;
    const over = loaded(851, 8, 0).world;
    for (let t = 0; t < 120; t++) {
      step3d(under, 1 / 60, new Map());
      step3d(over, 1 / 60, new Map());
    }
    const thU = hiveTiltAngle(under, A);
    const thO = hiveTiltAngle(over, A);
    const pullU = Math.abs(hiveContentsTorque(under, A, thU));
    const holdU = hiveHoldTorque(A, thU);
    console.log(
      `[smoke-bb hive3d] 7p pulls ${pullU.toFixed(0)} against a hold of ${holdU.toFixed(0)}; 8p pulls ` +
        `${Math.abs(hiveContentsTorque(over, A, thO)).toFixed(0)}`,
    );
    check(
      'the trigger is the TABLE: 7 POLLEN leave the tray pinned at its stop and 8 POLLEN lift it',
      Math.abs(Math.abs(thU) - REST_RAD) < 2e-3 && Math.abs(thO) < REST_RAD,
      `under ${((thU * 180) / Math.PI).toFixed(2)}deg, over ${((thO * 180) / Math.PI).toFixed(2)}deg ` +
        `(pull ${pullU.toFixed(0)} vs hold ${holdU.toFixed(0)})`,
    );
  });

  // ═══ REGISTRATION: WHEN DOES A CELL COUNT WHAT LANDS IN IT? ════════════════════════════════
  //
  // ⚠️ **THE OWNER'S SECOND HIVE REPORT** (2026-09-19, the day after "it says 0 more to tip and it
  // does not tip"): "there is a lot of delay registering when the balls land in the hive, which
  // means when it needs to tip, there is a significant amount of lengthened tipping time due to
  // the registration time."
  //
  // `sim3d/derive.ts` used to call an element part of a CELL only once it had read under
  // `BB3_REST_SPEED` for `BB3_REST_TICKS` CONSECUTIVE ticks — and `contents` is what the tip
  // trigger, the HUD's "N MORE TO TIP" and §10.5 C's count all read. MEASURED over 1,500
  // randomized arrivals, from the tick an element's centre entered the cell interior to the tick
  // `contents` held it: **mean 95 ticks (1.59 s), p50 75, p90 205, max 264 — and 8 of 75 landings
  // never registered at all** inside five seconds. Six of those ticks were the gate; the rest was
  // the element's own settling, which a see-saw does not wait for.
  //
  // Membership is GEOMETRY now (inside the interior, `BB3_CELL_SEAT_DEPTH` below the cell's open
  // rim) and the blocks below are what make that falsifiable in BOTH directions. The lane had
  // nothing here at all: every fixture above stages elements already at rest inside the cell, so
  // the registration path was the one path this file never ran.

  // ---- 1. a shot that lands is counted AS IT ARRIVES, not when it stops moving ---------------
  //
  // Four arrivals a real driver produces, each aimed into the up CELL. Two assertions per shot,
  // and the second is the one that cannot be satisfied by a shorter timer: `counted` must come
  // BEFORE `rested`, so any rest requirement reintroduced anywhere in the path fails here rather
  // than merely making the lane slower.
  {
    const SHOTS: readonly [string, number, number, number][] = [
      // label, inches outboard, inches above, flight seconds
      ['flat turret', 55, 4, 0.3],
      ['mid turret', 45, 12, 0.45],
      ['steep turret', 30, 25, 0.6],
      ["dumper's lob", 14, 30, 0.7],
    ];
    for (const [label, dH, dUp, T] of SHOTS) {
      const seed = 1210 + Math.round(dH);
      const s = shotInto(seed, dH, dUp, T);
      const a = arrive(seed, s.start, s.vel);
      console.log(
        `[smoke-bb hive3d] arrival "${label}": entered the cell at tick ${a.entered}, counted at ${a.counted} ` +
          `(${a.counted - a.entered} ticks later), first read at rest at ${a.rested}`,
      );
      check(
        `registration: a "${label}" shot is in hives.${A}.contents within 2 ticks of entering the cell`,
        a.entered >= 0 && a.counted >= 0 && a.counted - a.entered <= 2,
        `entered ${a.entered}, counted ${a.counted}`,
      );
      check(
        `registration: a "${label}" shot is counted BEFORE it comes to rest (no rest gate)`,
        a.counted >= 0 && a.rested >= 0 && a.counted < a.rested,
        `counted ${a.counted}, first at rest ${a.rested} — the rest gate made this 54/28/34 ticks late`,
      );
    }
  }

  // ---- 2. a lob that SKIMS the open rim is never counted -------------------------------------
  //
  // ⚠️ **THIS IS THE CASE THE REST GATE WAS REALLY BUYING, AND THE ONLY ONE.** Its comment said
  // "'in the cell' has to mean 'landed in it', and a shot crossing the mouth is not yet in it".
  // Measured, nothing crosses the MOUTH and comes back: a box with one opening keeps what
  // properly enters it. What does happen is a shot arcing over the hive whose centre dips under
  // the open TOP of the cell for a few ticks on its way past — of 209 arrivals that put a centre
  // inside the interior, 92 left again and every one of them stayed within **2.75 in** of the rim.
  //
  // The fixture is the deepest of those 92, taken verbatim from the sweep: a lob released 53 in
  // out and 39 in up, arriving over the up cell at 171 in/s. It spends 19 consecutive ticks with
  // its centre inside the interior — so this check bites: the plain interior box counts it, and
  // `BB3_CELL_SEAT_DEPTH` is the whole of what does not.
  {
    const a = arrive(1240, { x: 29.183, y: 53.23, z: 38.869 }, { x: -16.86, y: -79.575, z: 149.588 });
    console.log(
      `[smoke-bb hive3d] the rim-skimming lob: ${a.runIn} consecutive ticks with its centre inside the interior, ` +
        `deepest ${a.deepest.toFixed(2)} in below the rim (seat depth ${BB3_CELL_SEAT_DEPTH}), ended inside ${a.endIn}`,
    );
    check(
      'the rim-skimming lob really does enter the interior box — otherwise this check tests nothing',
      a.entered >= 0 && a.runIn >= 8 && !a.endIn,
      `entered ${a.entered}, longest run inside ${a.runIn}, ended inside ${a.endIn}`,
    );
    check(
      'registration: a shot that skims the open rim and carries on is NEVER counted',
      a.counted < 0,
      `counted at tick ${a.counted}; it reached ${a.deepest.toFixed(2)} in below the rim against a seat depth of ${BB3_CELL_SEAT_DEPTH}`,
    );
  }

  // ---- 3. and the count does NOT flicker while a counted element is still bouncing -----------
  //
  // The price of counting on entry is that an element can bounce back out of the entry band while
  // it settles — measured on the flat turret shot, which is counted on tick 18 and then comes back
  // to within **3.02 in** of the rim, inside the 3.5 the entry test asks for. `derive.ts` holds it
  // with a LATCH off `b.state` (plain world JSON, so a peer rebuilding its engine agrees): the
  // depth is earned once and then the element belongs to the cell for as long as it is anywhere
  // inside the interior.
  //
  // ⚠️ **THE HYSTERESIS IS HERE AND NOT AT THE SCORE**, deliberately. `contents` is ONE list with
  // one meaning, read by the tip trigger, the HUD and §10.5 C, and that is exactly the arrangement
  // the 2026-09-19 tip fix was for — a second opinion held at the score would put the HUD's "0 MORE
  // TO TIP" and the tray back into disagreement, which is the bug before last.
  {
    const s = shotInto(1250, 55, 4, 0.3);
    const a = arrive(1250, s.start, s.vel);
    console.log(
      `[smoke-bb hive3d] after being counted at tick ${a.counted} the flat shot bounces back to ` +
        `${a.shallowestAfterCount.toFixed(2)} in below the rim (entry needs ${BB3_CELL_SEAT_DEPTH}) and drops out ${a.drops} times`,
    );
    check(
      'the bounce fixture really does come back above the entry depth — otherwise this tests nothing',
      a.counted >= 0 && a.shallowestAfterCount < BB3_CELL_SEAT_DEPTH,
      `shallowest after counting ${a.shallowestAfterCount.toFixed(2)} in vs a seat depth of ${BB3_CELL_SEAT_DEPTH}`,
    );
    check(
      'no flicker: a counted element never drops out of the cell while it is still bouncing in it',
      a.drops === 0,
      `${a.drops} drops out of hives.${A}.contents`,
    );
    check(
      "no flicker: the SCORE's cellCount never dips once the element is counted",
      a.minCellCountAfter >= 1,
      `lowest cellCount after registration ${a.minCellCountAfter}`,
    );
  }

  // ---- 4. the entry depth sits between the two populations it separates ----------------------
  //
  // `BB3_CELL_SEAT_DEPTH` is the only tuned number in the membership test and it is a WINDOW, not
  // a threshold: too shallow and a rim-skimming lob scores, too deep and an element resting on top
  // of a pile is never counted. Both bounds are re-measured here, from the same fixtures, so
  // moving the cell box, an element radius or the tray's restitution fails this rather than
  // silently eating one of the two margins.
  {
    const skim = arrive(1260, { x: 29.183, y: 53.23, z: 38.869 }, { x: -16.86, y: -79.575, z: 149.588 }).deepest;
    // the shallowest a really-landed element rests: an 8-POLLEN pile crammed UP the back wall,
    // which is the tallest staging the packings produce
    const w = loaded(1261, 8, 0, 'crammed4').world;
    for (let t = 0; t < 120; t++) step3d(w, 1 / 60, new Map());
    const th = hiveTiltAngle(w, A);
    const rim = upBox(w).box.wMax;
    let rest = Infinity;
    for (const b of w.balls) {
      if (!w.biobuzz!.hives[A].contents.includes(b.id)) continue;
      rest = Math.min(rest, rim - localW(th, b.pos.y, b.z + (b.r ?? BB_POLLEN_R)));
    }
    console.log(
      `[smoke-bb hive3d] seat-depth window: deepest rim skim ${skim.toFixed(2)} in < BB3_CELL_SEAT_DEPTH ` +
        `${BB3_CELL_SEAT_DEPTH} < shallowest resting element ${rest.toFixed(2)} in`,
    );
    check(
      'BB3_CELL_SEAT_DEPTH is deeper than any shot that skims the rim, and shallower than the highest a load rests',
      skim < BB3_CELL_SEAT_DEPTH && BB3_CELL_SEAT_DEPTH < rest,
      `skim ${skim.toFixed(2)} / constant ${BB3_CELL_SEAT_DEPTH} / rest ${rest.toFixed(2)}`,
    );
  }

  // ---- 5. and the TIP follows the registration, which is the owner's actual complaint --------
  //
  // A cell one element short of `BB_TIP_POLLEN`, and the eighth arrives. The number that matters
  // is from the tick that element's centre enters the cell to the tick the tray leaves its stop:
  // **48-76 ticks (0.8-1.3 s) under the rest gate**, and it is a RATCHET here, because "the tip
  // takes too long" is the report and nothing else in the lane measures it. `hiveDetentHold` reads
  // last tick's `contents`, so one tick of it is structural; the rest is the tray's own rotation
  // out of `BB3_HIVE_STOP_DEG`, which is physics and not latency.
  withTray(true, () => {
    for (const [label, dH, dUp, T] of [
      ['mid turret', 45, 12, 0.45],
      ["dumper's lob", 14, 30, 0.7],
    ] as [string, number, number, number][]) {
      const seed = 1270 + Math.round(dH);
      const s = shotInto(seed, dH, dUp, T);
      const w = loaded(seed, BB_TIP_POLLEN[0] - 1, 0).world;
      for (let t = 0; t < 40; t++) step3d(w, 1 / 60, new Map()); // let the staged load settle
      w.balls.push({
        id: 99,
        color: 'yellow',
        state: { kind: 'flight', target: 'blue' },
        pos: { x: s.start.x, y: s.start.y },
        vel: { x: s.vel.x, y: s.vel.y },
        z: s.start.z - BB_POLLEN_R,
        vz: s.vel.z,
        r: BB_POLLEN_R,
      } as Artifact);
      let entered = -1;
      let broke = -1;
      for (let t = 0; t < 600 && broke < 0; t++) {
        step3d(w, 1 / 60, new Map());
        const b = w.balls.find((x) => x.id === 99);
        const th = trayTilt(engineFor(w).hiveTrays[A]);
        if (b && entered < 0) {
          const z = b.z + (b.r ?? BB_POLLEN_R);
          if (insideCell(b.pos.x, b.pos.y, z, A, 1, th) || insideCell(b.pos.x, b.pos.y, z, A, -1, th)) entered = t;
        }
        if (entered >= 0 && Math.abs(th) < STOP_RAD) broke = t;
      }
      console.log(
        `[smoke-bb hive3d] the ${BB_TIP_POLLEN[0]}th POLLEN ("${label}"): entered at tick ${entered}, ` +
          `the tray left its stop at ${broke} — ${broke - entered} ticks (${(((broke - entered) / 60) * 1000).toFixed(0)} ms)`,
      );
      check(
        `the TIP starts within 20 ticks of the last element entering the cell ("${label}")`,
        entered >= 0 && broke > entered && broke - entered <= 20,
        `entered ${entered}, broke away ${broke} (${broke - entered} ticks; it was 48-76 under the rest gate)`,
      );
    }
  });

  // ---- 6. and it is a pure function of the JSON: one seed, two runs, the same history --------
  //
  // The membership LATCH lives in `b.state` rather than in an engine-local map precisely so this
  // holds across a rebuilt engine; what is asserted here is the weaker and more basic half, that
  // the whole registration path is deterministic at all. The hash is the per-tick `contents` list,
  // not just the endpoint, so a run that arrives at the same place by a different route fails.
  {
    const hashes: string[] = [];
    for (let run = 0; run < 2; run++) {
      const s = shotInto(1280, 45, 12, 0.45);
      const w = loaded(1280, 4, 1).world;
      for (let t = 0; t < 30; t++) step3d(w, 1 / 60, new Map());
      w.balls.push({
        id: 99,
        color: 'yellow',
        state: { kind: 'flight', target: 'blue' },
        pos: { x: s.start.x, y: s.start.y },
        vel: { x: s.vel.x, y: s.vel.y },
        z: s.start.z - BB_POLLEN_R,
        vz: s.vel.z,
        r: BB_POLLEN_R,
      } as Artifact);
      const history: string[] = [];
      for (let t = 0; t < 180; t++) {
        step3d(w, 1 / 60, new Map());
        history.push(w.biobuzz!.hives[A].contents.join(','));
      }
      hashes.push(history.join('|'));
    }
    check(
      'determinism: two runs of one seed produce the identical tick-by-tick contents history',
      hashes[0] === hashes[1],
      `${hashes[0].length} vs ${hashes[1].length} chars of history`,
    );
  }

  // ---- the mouth takes a shot; the closed faces bounce ---------------------------------------
  //
  // The CELL is open at its OUTER end only (owner ruling 2026-09-12): a LAUNCH has to arrive over
  // that lip travelling toward the pivot. Under the 3D tray there is no capture predicate at all
  // — the cell is a box with one side missing — so this is a check that the BOX is the right way
  // round, which nothing else asserts.
  {
    function shoot(from: 'mouth' | 'back' | 'side', seed: number): boolean {
      const w = mkWorld3d('free', seed);
      w.balls.length = 0;
      const theta = hiveTiltAngle(w, A);
      const side: 1 | -1 = w.biobuzz!.hives[A].up === 'north' ? 1 : -1;
      const box = hiveCellLocalBox(side, A);
      const mouthV = side > 0 ? box.vMax : box.vMin;
      const mid = (box.wMin + box.wMax) / 2;
      // start just OUTSIDE the chosen face and aim through the cell's centre
      const start =
        from === 'mouth'
          ? cellPoint(A, theta, 0, mouthV + side * 6, mid)
          : from === 'back'
            ? cellPoint(A, theta, 0, (side > 0 ? box.vMin : box.vMax) - side * 6, mid)
            : cellPoint(A, theta, box.xHalf + 6, (box.vMin + box.vMax) / 2, mid);
      const aim = cellPoint(A, theta, 0, (box.vMin + box.vMax) / 2, box.wMin + BB_POLLEN_R);
      const dx = aim.x - start.x;
      const dy = aim.y - start.y;
      const dz = aim.z - start.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const speed = 120;
      w.balls.push({
        id: 1,
        color: 'yellow',
        state: { kind: 'flight', target: 'blue' },
        pos: { x: start.x, y: start.y },
        vel: { x: (dx / d) * speed, y: (dy / d) * speed },
        z: start.z - BB_POLLEN_R,
        vz: (dz / d) * speed,
        r: BB_POLLEN_R,
      } as Artifact);
      for (let t = 0; t < 300; t++) step3d(w, 1 / 60, new Map());
      return w.biobuzz!.hives[A].contents.includes(1);
    }
    check('a shot through the OPEN mouth is taken', shoot('mouth', 860), 'shot from outboard, aimed inboard');
    check('a shot at the CLOSED back bounces off', !shoot('back', 861), 'shot from the pivot side');
    check('a shot at a CLOSED side bounces off', !shoot('side', 862), 'shot from across the hive axis');
  }

  // ---- G409: the spill tag, with and without a robot under -----------------------------------
  //
  // ⚠️ `withTray(true, …)` RATHER THAN `if (BB3_HIVE_DYNAMIC)`, and the difference is the whole
  // rule: `bb.spill` is written only on the dynamic path, so the constant flipping to `false`
  // would have taken these four checks out of the run at the same moment it took G409 out of the
  // game. See the file header.
  withTray(true, () => {
    /** run a tip and report whether anything was tagged, how many G409 lines were written, and
     * the LOWEST z any element reached while it was still tagged (the tag's reach: see the
     * "survives the fall" check below). */
    function tipWithRobot(under: boolean, seed: number): { tagged: number; g409: number; lowestTagged: number } {
      const { world } = loaded(seed, 8, 0);
      if (under) {
        /**
         * Park the robot under the mouth of the cell that IS UP — which is the cell about to go
         * DOWN, and therefore where its contents come out. The reference's words are "outboard of
         * the down cell", which names the same place from the other end of the swing; taking them
         * literally at STAGING time parks the robot under the wrong cell and nothing is ever
         * caught. Measured: zero G409 lines with all eight elements correctly tagged.
         */
        const theta = hiveTiltAngle(world, A);
        const upSide: 1 | -1 = world.biobuzz!.hives[A].up === 'north' ? 1 : -1;
        const box = hiveCellLocalBox(upSide, A);
        const mouthV = upSide > 0 ? box.vMax : box.vMin;
        const p = cellPoint(A, theta, 0, mouthV, box.wMin);
        const r = world.robots[0];
        r.pos.x = p.x;
        r.pos.y = p.y;
        r.heading = 0;
        r.vel.x = 0;
        r.vel.y = 0;
      } else {
        world.robots[0].pos.x = 0;
        world.robots[0].pos.y = 60;
      }
      let tagged = 0;
      let lowestTagged = Infinity;
      const before = world.events.length;
      for (let t = 0; t < 600; t++) {
        step3d(world, 1 / 60, new Map());
        const spill = world.biobuzz!.spill ?? {};
        const n = Object.keys(spill).length;
        if (n > tagged) tagged = n;
        for (const b of world.balls) if (spill[b.id] !== undefined && b.z < lowestTagged) lowestTagged = b.z;
      }
      const g409 = world.events.slice(before).filter((e) => e.includes('G409')).length;
      return { tagged, g409, lowestTagged };
    }
    const away = tipWithRobot(false, 870);
    const beneath = tipWithRobot(true, 871);
    console.log(
      `[smoke-bb hive3d] G409: robot away → ${away.tagged} tagged / ${away.g409} lines; robot under → ${beneath.tagged} tagged / ${beneath.g409} lines`,
    );
    check(
      'G409: a tipping cell tags its contents as spilling',
      away.tagged >= 8 && beneath.tagged >= 8,
      `away ${away.tagged}, under ${beneath.tagged} (8 staged)`,
    );
    check(
      'G409: with NO robot under the hive nothing is billed',
      away.g409 === 0,
      `${away.g409} lines with the robot parked 60in away`,
    );
    check(
      'G409: a robot under the down CELL catches the spill and is billed',
      beneath.g409 > 0,
      `${beneath.g409} lines`,
    );
    /**
     * ⚠️ **THE TAG HAS TO OUTLIVE THE TRAY, AND IT DID NOT.** `contacts3d.ts` expires a spill
     * tag when the element comes to rest — but an element still sitting in the cell it is
     * leaving reads AT REST twice over: the tag is written on the tick the detent breaks, while
     * the load is still stacked against the back wall at a dead stop, and `groundRoll3d`'s
     * off-floor snap then pins anything that dips under `BB3_REST_SPEED` mid-swing to exactly
     * zero in the WORLD frame while the tray rotates under it. Measured on seed 871: all eight
     * tags written on tick 13, all eight deleted by tick 16, elements still 48 in up — G409 was
     * unbillable by a robot parked anywhere, which is what the check above was really reporting.
     * The fix is that TRAY CONTACT holds the moment open, and THIS is the check that pins it:
     * with no robot to catch anything the tag may only die on the TILES, so a tagged element
     * has to have got all the way down. The 46-in reading is the failure mode, not a near miss.
     */
    check(
      'G409: the spill tag outlives the TRAY — it dies on the tiles, not in the cell',
      away.lowestTagged < 1,
      `lowest z reached while still tagged ${away.lowestTagged.toFixed(2)} (cell floor is ~46)`,
    );
    const { world: w2 } = loaded(872, 8, 0);
    for (let t = 0; t < 900; t++) step3d(w2, 1 / 60, new Map());
    check(
      'G409: the spill map is empty again once the elements are on the tiles',
      w2.biobuzz!.spill === undefined || Object.keys(w2.biobuzz!.spill).length === 0,
      `${Object.keys(w2.biobuzz!.spill ?? {}).length} still tagged`,
    );
  });

  // ---- determinism: the dynamic tray is a pure function of the JSON ---------------------------
  withTray(true, () => {
    const angles: string[] = [];
    for (let run = 0; run < 2; run++) {
      const { world } = loaded(880, 8, 0);
      for (let t = 0; t < 300; t++) step3d(world, 1 / 60, new Map());
      angles.push(
        `${world.biobuzz!.hives[A].angle}|${world.biobuzz!.hives[A].angVel}|${world.biobuzz!.hives[A].tips}|${world.biobuzz!.hives[A].up}`,
      );
    }
    check('determinism: two identical tips produce the identical tray state', angles[0] === angles[1], `${angles[0]} vs ${angles[1]}`);
  });

  /**
   * ---- THE DOWN CELL IS NOT PART OF THE UP CELL'S LOAD (owner report 2026-09-20) -------------
   *
   * "The hive tips with nothing inside sometimes. Could be when balls are shot towards the hive
   * that is actively moving upwards." `sim3d/derive.ts` tagged BOTH cells into
   * `hives[a].contents`, and `contents` is what lifts the tip pin, what `hud.ts` prints "N MORE
   * TO TIP" from, and what Table 10-2 pays 2 each for "remaining in an UPWARD-FACING CELL". So a
   * miss dropping past the structure — the down cell's outer face is open at every height, and a
   * shot crossing it is inside the interior for a handful of ticks — was one more toward the up
   * cell's tip. The cell that counts is the one `hiveTakingSide` names, and this is what says so.
   *
   * The numbers below are the repro, measured against the old code: 7 POLLEN in the up cell (ONE
   * SHORT of the table) plus ONE element in the down cell lifted the pin, and the free see-saw
   * then went over on the seven, at tick 330 — where 7 alone never moves at all. Over 40
   * randomized volleys at a staged tray, 3 counted ids sat outside the up cell over 6 tips and 2
   * of those tips began under-seated.
   */
  withTray(true, () => {
    /** stage `n` elements on the floor of ONE named cell, at the tray's settled tilt. */
    const fillSide = (w: World, side: 1 | -1, n: number, nectar: boolean, idBase: number): number[] => {
      const theta = hiveTiltAngle(w, A);
      const box = hiveCellLocalBox(side, A);
      const innerV = side > 0 ? box.vMin : box.vMax;
      const ids: number[] = [];
      for (let i = 0; i < n; i++) {
        const r = nectar ? BB_NECTAR_R : BB_POLLEN_R;
        const p = cellPoint(A, theta, ((i % 4) - 1.5) * 4.6, innerV + side * (r + 0.3 + Math.floor(i / 4) * 3.4), box.wMin + r + 0.4);
        ids.push(idBase + i);
        w.balls.push({
          id: idBase + i,
          color: nectar ? 'blue' : 'yellow',
          state: { kind: 'ground' },
          pos: { x: p.x, y: p.y },
          vel: { x: 0, y: 0 },
          z: p.z - r,
          vz: 0,
          r,
        } as Artifact);
      }
      return ids;
    };
    /** stage `up` in the up cell and `down` in the down one; run; report what happened. */
    const staged = (seed: number, up: number, down: number, nectarDown: boolean, ticks = 700) => {
      const w = mkWorld3d('free', seed);
      w.balls.length = 0;
      const { side } = upBox(w);
      fillSide(w, side, up, false, 1);
      const downIds = fillSide(w, (-side) as 1 | -1, down, nectarDown, 50);
      const startUp = w.biobuzz!.hives[A].up;
      const tagsIn = (): number =>
        downIds.filter((id) => {
          const b = w.balls.find((x) => x.id === id);
          return b !== undefined && b.state.kind === 'element' && b.state.el === `hive:${A}`;
        }).length;
      let peak = 0;
      let tipAt = -1;
      let tagged = 0;
      for (let t = 0; t < ticks; t++) {
        step3d(w, 1 / 60, new Map());
        // the TAG is read on tick 1, while the staged element is still in the down cell: the
        // down cell's floor runs downhill to its open mouth, so it rolls out of its own accord.
        if (t === 0) tagged = tagsIn();
        peak = Math.max(peak, w.biobuzz!.hives[A].contents.length);
        if (tipAt < 0 && w.biobuzz!.hives[A].up !== startUp) tipAt = t;
      }
      return { world: w, peak, tipAt, tagged, cellCount: bbScoreWorld(w)[A].cellCount };
    };

    const short = staged(890, 7, 1, false);
    check(
      'the DOWN cell is not part of the UP cell\'s load: 7 POLLEN up + 1 in the down cell does NOT tip',
      short.tipAt < 0 && short.peak === 7,
      `tipped at t${short.tipAt}, peak contents ${short.peak} (the up cell holds 7)`,
    );
    // the control, same staging minus the down-cell element: the table is still the table.
    const full = staged(891, 8, 1, false);
    check(
      'and the table still governs: 8 POLLEN up (plus 1 in the down cell) tips',
      full.tipAt >= 0,
      `tipped at t${full.tipAt}, peak contents ${full.peak}`,
    );
    // ⚠️ the TAG is a different question from the LOAD and it did not move: an element in the
    // down cell is in the HIVE, not loose on the tiles, or the AI would drive at it forever.
    check(
      'an element in the DOWN cell is still TAGGED `hive:<alliance>` — only the LOAD narrowed',
      short.tagged === 1,
      `${short.tagged} of 1 still tagged`,
    );
    // Table 10-2 pays for what is "remaining in an UPWARD-FACING CELL"; the down cell is not one.
    check(
      'Table 10-2: a DOWN-cell element is not scored as remaining in an upward-facing CELL',
      short.cellCount === 7,
      `cellCount ${short.cellCount}, expected the 7 that are up`,
    );

    /**
     * THE SWEEP, which is the form the bug was actually found in: randomized volleys at random
     * points of either cell, at 90–260 in/s, against a tray staged empty / one short / at the
     * table. At every tick the tray LEAVES ITS STOP — the instant the pin let go — every id in
     * `contents` has to be inside the cell that is up, and seated (`BB3_CELL_SEAT_DEPTH`).
     */
    const mulberry = (a: number) => () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let tips = 0;
    let elsewhere = 0;
    let underSeated = 0;
    for (let s = 0; s < 28; s++) {
      const rng = mulberry(9300 + s);
      const w = mkWorld3d('free', 9300 + s);
      w.balls.length = 0;
      const { side } = upBox(w);
      const stage = rng();
      fillSide(w, side, stage < 0.34 ? 0 : stage < 0.67 ? 7 : 8, false, 1);
      const engine = engineFor(w);
      let was = true;
      let prev = { contents: [] as number[], up: w.biobuzz!.hives[A].up, theta: 0 };
      const volley = 2 + Math.floor(rng() * 10);
      const firstAt = Math.floor(rng() * 220);
      const gap = 2 + Math.floor(rng() * 14);
      let fired = 0;
      let nextId = 100;
      for (let t = 0; t < 420; t++) {
        if (fired < volley && t >= firstAt && (t - firstAt) % gap === 0) {
          const aimSide: 1 | -1 = rng() < 0.5 ? 1 : -1;
          const box = hiveCellLocalBox(aimSide, A);
          const target = cellPoint(
            A,
            aimSide > 0 ? REST_RAD : -REST_RAD,
            (rng() * 2 - 1) * box.xHalf * 1.4,
            box.vMin + rng() * (box.vMax - box.vMin),
            box.wMin + rng() * (box.wMax - box.wMin) * 1.3,
          );
          const az = (rng() * 2 - 1) * 0.5;
          const el = rng() * 1.2 - 0.1;
          const d = { x: Math.sin(az), y: -aimSide * Math.cos(az) * Math.cos(el), z: Math.sin(el) };
          const n = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z);
          const speed = 90 + rng() * 170;
          const dist = 15 + rng() * 45;
          const nectar = rng() < 0.4;
          const r = nectar ? BB_NECTAR_R : BB_POLLEN_R;
          w.balls.push({
            id: nextId++,
            color: nectar ? 'blue' : 'yellow',
            state: { kind: 'flight', target: 'blue' },
            pos: { x: target.x - (d.x / n) * dist, y: target.y - (d.y / n) * dist },
            vel: { x: (d.x / n) * speed, y: (d.y / n) * speed },
            z: target.z - (d.z / n) * dist - r,
            vz: (d.z / n) * speed,
            r,
          } as Artifact);
          fired++;
        }
        step3d(w, 1 / 60, new Map());
        const th = trayTilt(engine.hiveTrays[A]);
        const now = Math.abs(th) >= STOP_RAD;
        if (was && !now) {
          tips++;
          const upSide: 1 | -1 = prev.up === 'north' ? 1 : -1;
          const box = hiveCellLocalBox(upSide, A);
          let seated = 0;
          for (const id of prev.contents) {
            const b = w.balls.find((x) => x.id === id);
            if (!b) {
              elsewhere++;
              continue;
            }
            const z = b.z + (b.r ?? BB_POLLEN_R);
            if (!insideCell(b.pos.x, b.pos.y, z, A, upSide, prev.theta)) elsewhere++;
            else if (box.wMax - localW(prev.theta, b.pos.y, z) >= BB3_CELL_SEAT_DEPTH) seated++;
          }
          const load = hiveLoad(prev.contents, bbKindIndex(w));
          if (!hiveWillTip({ pollen: seated, nectar: 0 }) && seated < load.pollen + load.nectar) underSeated++;
        }
        was = now;
        prev = { contents: [...w.biobuzz!.hives[A].contents], up: w.biobuzz!.hives[A].up, theta: th };
      }
    }
    console.log(`[smoke-bb hive3d] volley sweep: 28 runs, ${tips} tips began, ${elsewhere} counted elements were not in the up cell`);
    check(
      'volley sweep: no tip begins on an element that is not in the CELL THAT IS UP',
      elsewhere === 0,
      `${elsewhere} such ids over ${tips} tips (3 ids over 6 tips, 2 of them under-seated, before the load narrowed to the taking cell)`,
    );
    check(
      'volley sweep: every tip that began had its load SEATED in the up cell',
      underSeated === 0,
      `${underSeated} of ${tips} tips began under-seated`,
    );
  });

  commitChecks(check);
  settleChecks(check);
}

/**
 * THE TIP IS COMMITTED (owner, 2026-09-20: "people are still reporting hive not tipping in some
 * cases") — the fast subset of `scratch/hivemiss.ts`, the 420-scenario volley fuzzer that found
 * the two causes. Every check here is one of its worst seeds, distilled to the mechanism so it
 * runs in a fraction of a second instead of a second and a half.
 *
 * THE CONFUSION MATRIX the fuzzer reports, same 420 seeds either side (a scenario is ARMED when
 * an independent geometric count — centre inside the taking cell's interior, no seat-depth rule —
 * satisfies `BB_TIP_POLLEN`):
 *
 *   before  386 armed → 382 tipped, **5 MISSED** (no tip within 8 s), 8 runs left in the TRAP
 *   after   386 armed → 386 tipped,   0 missed,                       0 trapped
 *   phantom breakaways 0 → 0; 120 miss-rain runs, 0 tips and 0 breakaways either side
 *   pin lift, from the threshold element entering: mean 1.0 ticks, p95 1, BOTH — the 2026-09-19
 *     geometry membership already owns that half and nothing here touched it
 *   swing stop-to-stop: mean 176.8 → 174.7 ticks, p95 264 → 251 (the creep only rescues; at the
 *     0.25 rad/s first tried it was 150.3/193 and the 4 s ruling check above FAILED at 3.12 s)
 *   spill dispersal, the "does it fling anything" control: 3895 → 3935 tagged, mean 61.0 → 61.1
 *     in from the pivot, max 106.9 → 106.9, 0 elements lost
 */
function commitChecks(check: Check): void {
  /* ── CLASS 3, THE ONE PLAYERS SEE: the RISING cell's load turns the swing around ──────────
     Fuzz seed 9039, distilled. A 4P3N cell broke away on tick 204, spilled at level on 299,
     reached −24.2° — five degrees short of the far stop — and was pushed back to its OWN stop by
     1 POLLEN + 3 NECTAR that had landed in the rising cell in the meantime. `hiveTakingSide`
     hands over at the release, so that load is the documented mechanic ("a driver who keeps
     firing into a tipping tray"), and a free see-saw loses to it: the balls dumped on the floor
     and NO TIP was scored. Here the same thing is staged directly — a threshold cell, and the
     moment the bar passes level, four elements seated in the tray that is coming up. */
  {
    const { world: w } = loaded(4101, 8, 0);
    const engine = engineFor(w);
    let released = -1;
    let tip = -1;
    let filled = false;
    for (let t = 0; t < 420 && tip < 0; t++) {
      step3d(w, 1 / 60, new Map());
      const hive = w.biobuzz!.hives[A];
      if (hive.released && released < 0) released = t;
      if (released >= 0 && !filled) {
        // the RISING cell, at the tilt it is at right now — the cell `hiveTakingSide` now names.
        const theta = trayTilt(engine.hiveTrays[A]);
        const side: 1 | -1 = hiveTakingSide(hive) === 'north' ? 1 : -1;
        const box = hiveCellLocalBox(side, A);
        const innerV = side > 0 ? box.vMin : box.vMax;
        for (let k = 0; k < 4; k++) {
          const r = k < 3 ? BB_NECTAR_R : BB_POLLEN_R;
          const p = cellPoint(A, theta, (k - 1.5) * 4.6, innerV + side * (r + 0.4), box.wMin + r + 0.4);
          w.balls.push({
            id: 400 + k,
            color: k < 3 ? 'blue' : 'yellow',
            state: { kind: 'ground' },
            pos: { x: p.x, y: p.y },
            vel: { x: 0, y: 0 },
            z: p.z - r,
            vz: 0,
            r,
          } as Artifact);
        }
        filled = true;
      }
      if (w.biobuzz!.hives[A].tips > 0) tip = t;
    }
    check(
      'a tip the table called for reaches the far stop even as the RISING cell fills (seed 9039)',
      tip >= 0,
      `released t${released}, tipped t${tip} (free see-saw: reversed at −24.2° and returned to its own stop)`,
    );
  }

  /* ── CLASS 4, THE STATE TRAP: a swing that ends back on its own stop ──────────────────────
     Reached in 8 of 420 fuzz runs BEFORE the drive, and it is the failure the owner would have
     reported as permanent: `tipping`/`released` could only be cleared at the FAR stop, so a tray
     that came back sat with `released` latched, `hiveTakingSide` named `otherSide(up)` for the
     rest of the match, and `contents` — the pin's list, the HUD's list, §10.5 C's list — was
     derived from the DOWN cell. The up cell could then be filled to the brim and nothing would
     happen. Staged here by putting a settled, EMPTY tray into exactly that state. */
  {
    const w = mkWorld3d('free', 4102);
    w.balls.length = 0;
    step3d(w, 1 / 60, new Map()); // one tick so the tray is pinned and `contents` is derived
    const before = w.biobuzz!.hives[A];
    w.biobuzz!.hives[A] = { ...before, tipping: 3, released: true };
    check(
      'the trap is real: a stale mid-swing state names the DOWN cell',
      hiveTakingSide(w.biobuzz!.hives[A]) !== before.up,
      `up ${before.up}, taking ${hiveTakingSide(w.biobuzz!.hives[A])}`,
    );
    for (let t = 0; t < 30; t++) step3d(w, 1 / 60, new Map());
    const after = w.biobuzz!.hives[A];
    check(
      'a swing that ends back on its own stop resets to SETTLED, so the taking cell is the up one',
      after.tipping === 0 && after.released === false && hiveTakingSide(after) === after.up,
      `tipping ${after.tipping}, released ${after.released}, up ${after.up}, taking ${hiveTakingSide(after)}`,
    );
    check(
      'and the reset scores NO tip — an empty tray that never left its stop owes nothing',
      after.tips === before.tips && Math.abs(hiveTiltAngle(w, A)) >= STOP_RAD,
      `tips ${before.tips} → ${after.tips}, tilt ${((hiveTiltAngle(w, A) * 180) / Math.PI).toFixed(2)}°`,
    );
  }

  /* ── THE CREEP IS A FLOOR, NOT A CAP ──────────────────────────────────────────────────────
     `hiveSwingRate`'s mechanic — more load, faster swing — has to survive a commit that works by
     holding a MINIMUM rate. A cell at twice its threshold must still beat one at threshold, and
     the 8-POLLEN reference swing two hundred lines up (4.12 s free, 4.08 s with this) is the
     other half of the same statement: at 0.25 rad/s, the first value tried, it was 3.12 s and
     that check failed. */
  {
    const atThreshold = tipTick(loaded(4103, 8, 0).world);
    const heavy = tipTick(loaded(4104, 16, 0).world);
    check(
      'the anti-stall is a FLOOR: a 16-POLLEN cell still swings faster than an 8-POLLEN one',
      heavy > 0 && atThreshold > 0 && heavy <= atThreshold,
      `16P ${heavy} ticks vs 8P ${atThreshold} (the anti-stall creep is ${BB3_HIVE_TIP_CREEP_W} rad/s and never binds on either)`,
    );
    check(
      'and a threshold cell is still inside the published swing',
      atThreshold > 0 && atThreshold <= Math.round((BB_TIP_SWING_S + 0.4) * 60),
      `${atThreshold} ticks against ${Math.round(BB_TIP_SWING_S * 60)} nominal`,
    );
  }

  /* ── NO PHANTOM: a GRAZE RAIN over a cell that never reaches a row ────────────────────────
     The other half of the matrix. Shots skim the up cell's open top and drop past the structure;
     nothing is ever allowed to stay, so no row is ever satisfied and the tray must not move.
     (The DOWN-cell block above is the 2026-09-20 repro proper; this is the continuous version.) */
  {
    const w = mkWorld3d('free', 4105);
    w.balls.length = 0;
    const engine = engineFor(w);
    const theta0 = hiveTiltAngle(w, A);
    const { side, box } = upBox(w);
    let id = 700;
    let breakaways = 0;
    let was = true;
    for (let t = 0; t < 240; t++) {
      if (t % 8 === 0) {
        // across the open top, outbound-to-inbound, at the rim rather than into the cell
        const p = cellPoint(A, theta0, ((id % 3) - 1) * 5, (box.vMin + box.vMax) / 2, box.wMax - 0.5);
        w.balls.push({
          id: id++,
          color: id % 2 === 0 ? 'yellow' : 'blue',
          state: { kind: 'flight', target: A },
          pos: { x: p.x, y: p.y + side * 30 },
          vel: { x: 0, y: -side * 150 },
          z: p.z - BB_POLLEN_R + 6,
          vz: -20,
          r: id % 2 === 0 ? BB_POLLEN_R : BB_NECTAR_R,
        } as Artifact);
      }
      step3d(w, 1 / 60, new Map());
      if (t % 10 === 0) {
        for (const b of w.balls) if (b.state.kind === 'element') b.state = { kind: 'held', robot: 99 };
        w.balls = w.balls.filter((b) => b.state.kind !== 'held');
      }
      const now = Math.abs(trayTilt(engine.hiveTrays[A])) >= STOP_RAD;
      if (was && !now) breakaways++;
      was = now;
    }
    check(
      'graze rain: 30 arrivals over an up cell that never reaches a row move the tray NOT AT ALL',
      breakaways === 0 && w.biobuzz!.hives[A].tips === 0 && engine.containmentFixes === 0,
      `${breakaways} breakaways, ${w.biobuzz!.hives[A].tips} tips, ${engine.containmentFixes} containment fixes`,
    );
  }
}

/**
 * THE SETTLE CLOCK OVER A 3D TRAY (`src/games/biobuzz/settle.ts`), and it is a HIVE3D question
 * because both of the bugs it pins are about what a CELL does to an element's TAG.
 *
 * `bbSettled` used to ask about motion only for `flight` and `ground`. That was harmless while
 * an element bouncing in a cell stayed `flight` all the way down; since membership became
 * GEOMETRY (`BB3_CELL_SEAT_DEPTH`) it is `element` from the tick its centre is seated, so the
 * motion test skipped it and the clock could close on a moving tray. The opposite failure is on
 * record too — refusing on a TAG held the clock to the 10 s cap on a still field — so every
 * check here comes in a pair: the moving thing holds, the parked thing does not.
 */
function settleChecks(check: Check): void {
  /* ── a ball still BOUNCING in a CELL holds the clock open ────────────────
     Staged by hand, one tick into the world so `derive.ts` has seated it and tagged it
     `element`, then given a real upward bounce. Under the old test this read "settled" at
     83 in/s, and the settle clock is when the match is CALLED — §10.5 A's TIP is assessed at
     that instant, so a tip one bounce away could be missed. */
  {
    const w = mkWorld3d('match', 901);
    w.balls.length = 0;
    const theta = hiveTiltAngle(w, A);
    const box = upBox(w).box;
    const p = cellPoint(A, theta, 0, (box.vMin + box.vMax) / 2, box.wMin + 4.5);
    w.balls.push({
      id: 1,
      color: 'yellow',
      state: { kind: 'ground' },
      pos: { x: p.x, y: p.y },
      vel: { x: 0, y: 0 },
      z: p.z - BB_POLLEN_R,
      vz: 0,
      r: BB_POLLEN_R,
    } as Artifact);
    step3d(w, 1 / 60, new Map());
    const seated = w.balls[0].state.kind === 'element';
    w.balls[0].vz = 90;
    step3d(w, 1 / 60, new Map());
    const b = w.balls[0];
    check(
      'SETTLE (3D): a ball bouncing INSIDE a cell is tagged `element` and still holds the clock open',
      seated && b.state.kind === 'element' && !bbSettled(w),
      `tag ${b.state.kind}${b.state.kind === 'element' ? ':' + b.state.el : ''}, vz ${b.vz.toFixed(2)}, settled ${bbSettled(w)}`,
    );
  }

  /* ── a LOADED TRAY at rest settles, promptly ─────────────────────────────
     The other half of the pair. Seven POLLEN is one short of the tip table, so the tray stays
     on its stop with a full cell — and `derive.ts`'s rest snap holds every one of them at
     exactly zero, which is what makes the motion test safe to run on an `element` tag at all.
     Measured with the snap live: maxV 0.0000 and max|vz| 0.0000 over 400 further ticks, in the
     guide packing and crammed against the back wall alike. */
  for (const packing of ['guide', 'crammed4'] as const) {
    const { world } = loaded(902, BB_TIP_POLLEN[0] - 1, 0, packing);
    for (let t = 0; t < 240; t++) step3d(world, 1 / 60, new Map());
    let worst = 0;
    let tagged = 0;
    for (let t = 0; t < 120; t++) {
      step3d(world, 1 / 60, new Map());
      for (const b of world.balls) {
        if (b.state.kind !== 'element') continue;
        worst = Math.max(worst, Math.hypot(b.vel.x, b.vel.y), Math.abs(b.vz));
      }
    }
    for (const b of world.balls) if (b.state.kind === 'element') tagged++;
    check(
      `SETTLE (3D): a loaded tray at rest is SETTLED — ${packing} packing, and nothing in the cell jitters`,
      tagged === BB_TIP_POLLEN[0] - 1 && worst === 0 && bbSettled(world),
      `${tagged} tagged \`element\`, worst |v| over 120 further ticks ${worst.toFixed(4)} (threshold ${BALL_REST_SPEED}), settled ${bbSettled(world)}`,
    );
  }

  /* ── PARKED ELEMENTS ON THE STRUCTURE FINALIZE, AND NOWHERE NEAR THE CAP ──
     The 2026-09-18 report, re-pinned against the settle CLOCK rather than the predicate: eight
     elements dropped onto the hive and left to come to rest used to hold the clock for the
     whole `MATCH_SETTLE_MAX_S`. Asserted as a tick count, because "settled" on one tick is not
     the thing that was broken — the clock closing is. */
  {
    const w = mkWorld3d('match', 903);
    w.balls.length = 0;
    for (let k = 0; k < 8; k++) {
      w.balls.push({
        id: k + 1,
        color: 'yellow',
        state: { kind: 'flight', target: A },
        pos: { x: hivePivotX(A) + (k % 3) * 2.6, y: Math.floor(k / 3) * 2.6 },
        vel: { x: 0, y: 0 },
        z: 60 + k * 3.2,
        vz: 0,
        r: BB_POLLEN_R,
      } as Artifact);
    }
    for (let t = 0; t < 420; t++) step3d(w, 1 / 60, new Map());
    w.match.phase = 'post';
    const clock = newSettleClock();
    const capTicks = Math.round(MATCH_SETTLE_MAX_S / SIM_DT);
    let at = -1;
    for (let t = 0; t < capTicks + 5 && at < 0; t++) {
      step3d(w, 1 / 60, new Map());
      if (settleStep(clock, w, bbSettled)) at = t + 1;
    }
    const holdTicks = Math.round(MATCH_SETTLE_HOLD_S / SIM_DT);
    check(
      'SETTLE (3D): a field of elements parked on the HIVE finalizes on the HOLD, not on the cap',
      at > 0 && at < holdTicks * 4,
      `finalized ${at} ticks after the buzzer (hold ${holdTicks}, cap ${capTicks})`,
    );
  }

  /**
   * ⚠️ **A PERCH ON A NARROW HULL SHAKES LOOSE (owner report 2026-09-20: "balls are able to get
   * stuck on top of the biobuzz panel with seemingly nothing actually holding it up").**
   *
   * `scratch/rain-probe.ts` (not committed) rained POLLEN/NECTAR over every physical hive-frame
   * and flower-support CAD hull at a 1-in grid, both zero and lateral drop velocity, 600 ticks
   * each: BEFORE `groundRoll3d`'s narrow-hull carve-out, 132/1404 drops ended at rest, elevated,
   * untagged (`state.kind === 'ground'`, bottom > 0.5in) — most of them on the ACM PANEL (the
   * owner's "biobuzz panel", 3–5/90), the base-level foot bar (20/90, the single worst offender)
   * and the A-frame leg/top-corner/axle-holder cluster (10–15/90 each) — every one of them a CAD
   * hull the ledge survey (`scratch/ledge-table.ts`) measured narrower than a POLLEN (2.8in) or
   * with no flat top at all. AFTER: 59/1404, every hive-frame structure at 0/90 in this grid
   * except two exact-coordinate hull-intersection corners (the A-frame leg/top-corner/axle-holder
   * joint) the vibration cannot punch through — a true multi-hull cage, not a magnitude problem
   * (retested at 2×–3× the shipped kick with no change) — left as a follow-up collider reshape.
   * The three checks below pin the regression at three of the worst measured points; see
   * `docs/area/biobuzz.md` for the full before/after table.
   */
  {
    const drop = (x: number, y: number, topZ: number, ticksMax: number): { onTiles: number | null; z: number } => {
      const w = mkWorld3d('free', 1);
      w.balls.length = 0;
      w.balls.push({
        id: 1,
        color: 'yellow',
        state: { kind: 'flight', target: 'red' },
        pos: { x, y },
        vel: { x: 0, y: 0 },
        z: topZ + 6,
        vz: 0,
        r: BB_POLLEN_R,
      } as Artifact);
      const commands = new Map();
      let onTiles: number | null = null;
      for (let t = 0; t < ticksMax; t++) {
        step3d(w, 1 / 60, commands);
        const b = w.balls[0];
        if (onTiles === null && b.z <= 0.05 && b.state.kind === 'ground') onTiles = t;
      }
      return { onTiles, z: w.balls[0].z };
    };
    const FIVE_S = 300;
    // hive_shared_frame_acm_panel — the owner's own "biobuzz panel" — centre of its top edge.
    {
      const r = drop(0, 2.9, 40.02, FIVE_S);
      check(
        'HIVE3D (3D): a POLLEN dropped on the ACM PANEL top edge reaches the tiles within 5s',
        r.onTiles !== null,
        `onTiles=${r.onTiles}, finalZ=${r.z.toFixed(3)}`,
      );
    }
    // hive_*_frame_sheet_metal_foot_bar — the base curb, the single worst offender pre-fix
    // (20/90 in the rain probe).
    {
      const r = drop(23.7, 0, 2.15, FIVE_S);
      check(
        'HIVE3D (3D): a POLLEN dropped on the hive foot bar reaches the tiles within 5s',
        r.onTiles !== null,
        `onTiles=${r.onTiles}, finalZ=${r.z.toFixed(3)}`,
      );
    }
    // hive_shared_frame_a_frame_top_bar — the 1-in-wide ridge along the very top of the A-frame.
    {
      const r = drop(0, 0, 41.95, FIVE_S);
      check(
        'HIVE3D (3D): a POLLEN dropped on the A-frame top bar reaches the tiles within 5s',
        r.onTiles !== null,
        `onTiles=${r.onTiles}, finalZ=${r.z.toFixed(3)}`,
      );
    }
  }

  /**
   * ⚠️ **NOTHING LOOSE STAYS ON THE HIVE'S PIVOT BEAM** (found capturing the 3D reel, 2026-10-01: in
   * a 3-bot practice match a POLLEN sat on the blue HIVE between the cups from 11 s to the buzzer,
   * another on red's for 18 s, reading `flight` at zero velocity and then `ground` at z ≈ 40–45).
   *
   * The perch: a POLLEN on the tray's centre bar between the pivot and a cell's back wall rolls down
   * the UP side's bar into the pivot and stops on the two `goal_pivot_bracket` plates (1.07 in
   * apart) against the damper holder — a CRADLE, stable sideways, where the 2–5 in/s vibration
   * cannot lift it over a rail and gave up after 30 ticks. MEASURED (`scratch/barprobe.ts`, a ball
   * staged on the bar top at tray-local x −0.6..0.6, |v| 4..9, both alliances, both tray poses):
   * POLLEN 38/480 perched for good before the shed, 0/480 after; NECTAR 0/480 after.
   *
   * Each scene stages the ball ON the bar, so it needs no drop to find the perch. A ball counts as
   * off the beam on the tiles (`ground`, bottom at the floor) or counted into a cell (`element`).
   * The STALLED-FLIGHT clause is the second half of the report: an element tagged `flight` that is
   * off the tiles and has moved under `STALL_DIST` in the last `STALL_WINDOW` ticks is not flying,
   * something is holding it up. Speed alone cannot see it — the vibration keeps a perched ball
   * above `BB3_REST_SPEED` half the time — so it is read off displacement, and the old rule is run
   * through the same counter to show the counter can fail.
   */
  {
    const BAR_TOP_W = -1.71; // `bar_north` / `bar_south` top face, tray-local (field-colliders.json)
    const OFF_BY = 300; // ticks — 5 s; measured 148–164 (printed in each detail)
    const STALL_MAX = 60;
    const STALL_WINDOW = 30;
    const STALL_DIST = 1;
    const onBeam = (al: Alliance, up: 'north' | 'south', x: number, v: number, patch?: number) => {
      const w = mkWorld3d('free', 1);
      if (patch !== undefined) w.simPatch = patch;
      w.balls.length = 0;
      const hive = w.biobuzz!.hives[al];
      hive.up = up;
      delete hive.angle;
      const theta = hiveTiltAngle(w, al);
      const p = rotate2(v, BAR_TOP_W + BB_POLLEN_R + 0.05, theta);
      w.balls.push({
        id: 1,
        color: 'yellow',
        state: { kind: 'flight', target: 'red' },
        pos: { x: hivePivotX(al) + x, y: p.a },
        vel: { x: 0, y: 0 },
        z: BB3_HIVE_PIVOT_Z + p.b - BB_POLLEN_R,
        vz: 0,
        r: BB_POLLEN_R,
      } as Artifact);
      let off: number | null = null;
      let stalled = 0;
      const trail: { x: number; y: number; z: number }[] = [];
      for (let t = 0; t < OFF_BY && off === null; t++) {
        step3d(w, 1 / 60, new Map());
        const b = w.balls[0];
        trail.push({ x: b.pos.x, y: b.pos.y, z: b.z });
        const then = trail.length > STALL_WINDOW ? trail[trail.length - 1 - STALL_WINDOW] : null;
        if (then && b.state.kind === 'flight' && b.z > 0.5 && Math.hypot(b.pos.x - then.x, b.pos.y - then.y, b.z - then.z) < STALL_DIST) stalled++;
        if (b.state.kind === 'element' || (b.state.kind === 'ground' && b.z <= 0.05)) off = t;
      }
      const b = w.balls[0];
      return { off, stalled, kind: b.state.kind, pos: `(${b.pos.x.toFixed(2)}, ${b.pos.y.toFixed(2)}, z ${b.z.toFixed(2)})` };
    };
    // the three measured perches: blue's north bar and south bar (one per tray pose), and red's.
    const scenes = [
      ['blue', 'north', 0.3, 5.5],
      ['blue', 'south', 0, -5],
      ['red', 'south', 0, -5],
    ] as const;
    for (const [al, up, x, v] of scenes) {
      const now = onBeam(al, up, x, v);
      check(
        `HIVE3D (3D): a POLLEN on ${al}'s pivot beam (up ${up}, v ${v}) leaves it — tiles or a cell within ${OFF_BY} ticks`,
        now.off !== null,
        `off at ${now.off}, ended ${now.kind} at ${now.pos}`,
      );
      check(
        `HIVE3D (3D): ...and it spends at most ${STALL_MAX} ticks tagged \`flight\` while going nowhere (${al}, up ${up})`,
        now.stalled <= STALL_MAX,
        `stalled-flight ticks ${now.stalled}`,
      );
      // ...and a replay recorded before `SIM_PATCH` 5 still freezes it there, which is also what
      // keeps the two checks above from being vacuous.
      const old = onBeam(al, up, x, v, 2);
      check(
        `HIVE3D (3D): ...under SIM_PATCH 2 (an older replay) the same POLLEN still stays on the beam, stalled in \`flight\` past ${STALL_MAX} ticks (${al}, up ${up})`,
        old.off === null && old.kind !== 'element' && old.stalled > STALL_MAX,
        `off at ${old.off}, ended ${old.kind} at ${old.pos}, stalled-flight ticks ${old.stalled}`,
      );
    }
    // DETERMINISM THROUGH A SHED: the hop's direction is the vibration's hash of (id, tick,
    // rngState), so two runs of the same perch agree at every sampled tick.
    const hashes = (): string[] => {
      const w = mkWorld3d('free', 1);
      w.balls.length = 0;
      const p = rotate2(5, BAR_TOP_W + BB_POLLEN_R + 0.05, hiveTiltAngle(w, 'blue'));
      w.balls.push({
        id: 1,
        color: 'yellow',
        state: { kind: 'flight', target: 'red' },
        pos: { x: hivePivotX('blue') + 0.3, y: p.a },
        vel: { x: 0, y: 0 },
        z: BB3_HIVE_PIVOT_Z + p.b - BB_POLLEN_R,
        vz: 0,
        r: BB_POLLEN_R,
      } as Artifact);
      const out: string[] = [];
      for (let t = 0; t < 300; t++) {
        step3d(w, 1 / 60, new Map());
        if (t % 30 === 0) out.push(worldHash(w));
      }
      return out;
    };
    const h1 = hashes();
    const h2 = hashes();
    check(
      'HIVE3D (3D): two runs of a pivot-beam shed agree at every sampled tick (worldHash)',
      h1.length === h2.length && h1.every((h, i) => h === h2[i]),
      `${h1.length} samples, first mismatch ${h1.findIndex((h, i) => h !== h2[i])}`,
    );
  }

  /**
   * ⚠️ **A NECTAR BEHIND THE HIVE FALLS THROUGH TO THE TILES** (owner report 2026-09-27: "nectar
   * get stuck on top of the main beam that connects two CELLs and does not fall off").
   *
   * The drawn gap between the DOWN cell's closed end and the ACM panel below the pivot is 4.2 in,
   * and a NECTAR is 3.6. The exporter pads every tray slab 1.5 in outward, which put the back
   * slab's bottom edge, then the floor slab's bottom corner, 3.3 in from the panel: a NECTAR sat in
   * that V on two narrow hulls, the vibration gave up after 30 ticks and froze it. A POLLEN (2.8)
   * fell through. MEASURED, NECTAR on a 2-in grid over both hives: 110/675 stuck before, 0/675
   * after; POLLEN over the blue tray on a 1-in grid 22/625 → 0/625. The drop points are where the
   * old tray held them, one per hive (the trays rest on opposite stops, so the wedges mirror).
   */
  {
    const dropNectar = (x: number, y: number, patch?: number): { onTiles: number | null; z: number } => {
      const w = mkWorld3d('free', 1);
      if (patch !== undefined) w.simPatch = patch;
      w.balls.length = 0;
      w.balls.push({
        id: 1,
        color: 'blue',
        state: { kind: 'flight', target: 'blue' },
        pos: { x, y },
        vel: { x: 0, y: 0 },
        z: 60,
        vz: 0,
        r: BB_NECTAR_R,
      } as Artifact);
      let onTiles: number | null = null;
      for (let t = 0; t < 600 && onTiles === null; t++) {
        step3d(w, 1 / 60, new Map());
        const b = w.balls[0];
        if (b.z <= 0.05 && b.state.kind === 'ground') onTiles = t;
      }
      return { onTiles, z: w.balls[0].z };
    };
    for (const [a, x, y] of [['blue', 7.7, -4.2], ['red', -7.7, 4.2]] as const) {
      const now = dropNectar(x, y);
      check(
        `HIVE3D (3D): a NECTAR dropped behind ${a}'s DOWN cell falls past the ACM panel to the tiles`,
        now.onTiles !== null,
        `onTiles=${now.onTiles}, finalZ=${now.z.toFixed(3)}`,
      );
      // ...and a replay recorded before `SIM_PATCH` 2 still wedges it, on the tray it was played
      // on. This is also what keeps the check above from being vacuous.
      const old = dropNectar(x, y, 1);
      check(
        `HIVE3D (3D): ...under SIM_PATCH 1 (an older replay) the same NECTAR still wedges there (${a})`,
        old.onTiles === null && old.z > 30,
        `onTiles=${old.onTiles}, finalZ=${old.z.toFixed(3)}`,
      );
    }
    // THE RULE, on the collider set itself: a floor or back slab stands exactly
    // `BB3_TRAY_OUTER_SKIN` out past its CAD face and keeps the face; every other hull is as exported.
    let worst = 0;
    let touched = 0;
    let untouchedMoved = 0;
    for (const al of ['red', 'blue'] as const) {
      for (const h of cadTrayHulls(al)) {
        const built = trayHullPoints(h.name, h.points, BB3_TRAY_OUTER_SKIN);
        const m = /^cell_(north|south)_(back|floor)$/.exec(h.name);
        if (!m) {
          if (built.some((v, i) => v !== h.points[i])) untouchedMoved++;
          continue;
        }
        touched++;
        const axis = m[2] === 'back' ? 1 : 2;
        const span = (pts: readonly number[]): [number, number] => {
          let lo = Infinity;
          let hi = -Infinity;
          for (let i = axis; i < pts.length; i += 3) {
            lo = Math.min(lo, pts[i]);
            hi = Math.max(hi, pts[i]);
          }
          return [lo, hi];
        };
        const [lo0, hi0] = span(h.points);
        const [lo1, hi1] = span(built);
        // the CAD face is the one nearer the cell: |v| larger for a back, w larger for a floor
        const faceHi = axis === 2 || m[1] === 'north';
        const face0 = faceHi ? hi0 : lo0;
        const face1 = faceHi ? hi1 : lo1;
        worst = Math.max(worst, Math.abs(face1 - face0), Math.abs(hi1 - lo1 - BB3_TRAY_OUTER_SKIN));
      }
    }
    check(
      'HIVE3D (3D): every cell floor and back collider keeps its CAD face and stands BB3_TRAY_OUTER_SKIN outside it; no other tray hull moves',
      touched === 8 && worst < 1e-9 && untouchedMoved === 0,
      `slabs=${touched} worst=${worst.toExponential(2)} other hulls moved=${untouchedMoved}`,
    );
  }

  /**
   * AND THE CARVE-OUT DOES NOT TOUCH A LEGITIMATE LOAD. The whole narrow-hull branch is gated on
   * `state.kind !== 'element'` (`groundRoll3d`), so an element the geometry has already counted
   * into a CELL must never reach it — this is the same fixture the "loaded tray at rest" check
   * above uses, just read for POSITION drift rather than velocity.
   *
   * `DRIFT_TOL` is NOT "zero" — MEASURED, a loaded cell drifts up to 0.0435in over 600 ticks on
   * the unpatched rest-snap too (ordinary contact-solve position bias, the same order as the
   * "0.068in of overlap at 12Hz" / "0.127in sink" noise floors documented elsewhere in this
   * file's header), nothing to do with the vibration. A LEAKED nudge would not look like that: it
   * re-applies every ~6 ticks (`BB3_REST_TICKS`) at 2–5 in/s, so 100 leaked kicks over 600 ticks
   * would move the element inches, not hundredths — `DRIFT_TOL` sits an order of magnitude above
   * the measured noise floor and two orders below one real kick.
   */
  {
    const DRIFT_TOL = 0.1;
    const { world } = loaded(904, BB_TIP_POLLEN[0] - 1, 0, 'guide');
    for (let t = 0; t < 240; t++) step3d(world, 1 / 60, new Map());
    const before = world.balls.map((b) => ({ id: b.id, x: b.pos.x, y: b.pos.y }));
    for (let t = 0; t < 600; t++) step3d(world, 1 / 60, new Map());
    const after = new Map(world.balls.map((b) => [b.id, b]));
    let worstDrift = 0;
    let stillTagged = 0;
    for (const b0 of before) {
      const b1 = after.get(b0.id);
      if (!b1) continue;
      if (b1.state.kind === 'element') stillTagged++;
      worstDrift = Math.max(worstDrift, Math.hypot(b1.pos.x - b0.x, b1.pos.y - b0.y));
    }
    check(
      'HIVE3D (3D): an element already settled in an UP cell is not nudged — drift stays at the ordinary contact-solve noise floor over 600 further ticks',
      worstDrift < DRIFT_TOL && stillTagged === before.length,
      `worst drift ${worstDrift.toFixed(6)}in (tol ${DRIFT_TOL}), ${stillTagged}/${before.length} still tagged \`element\``,
    );
  }

  /**
   * DETERMINISM WITH A PERCHED BALL. The vibration is a hash of `(id, tick, world.rngState)` —
   * pure, and `world.rngState` is read only, never advanced — so two independent runs of the
   * exact same perch must land on the exact same `worldHash` at every tick, the same as any
   * other authority state.
   */
  {
    const runOnce = (): string[] => {
      const w = mkWorld3d('free', 1);
      w.balls.length = 0;
      w.balls.push({
        id: 1,
        color: 'yellow',
        state: { kind: 'flight', target: 'red' },
        pos: { x: 0, y: 2.9 },
        vel: { x: 0, y: 0 },
        z: 46.02,
        vz: 0,
        r: BB_POLLEN_R,
      } as Artifact);
      const commands = new Map();
      const hashes: string[] = [];
      for (let t = 0; t < 300; t++) {
        step3d(w, 1 / 60, commands);
        if (t % 30 === 0) hashes.push(worldHash(w));
      }
      return hashes;
    };
    const a = runOnce();
    const b = runOnce();
    check(
      'HIVE3D (3D): two runs of a perched-ball scene agree at every sampled tick (worldHash)',
      a.length === b.length && a.every((h, i) => h === b[i]),
      `${a.length} samples, first mismatch ${a.findIndex((h, i) => h !== b[i])}`,
    );
  }
}
