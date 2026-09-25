import type { Check } from './harness';
import { bbCoerce, cmd, mkWorld, mkWorld3d, mkWorld3dPair, run, run3d, setup } from './harness';
import { createBiobuzzWorld } from '../../src/games/biobuzz/spawn';
import { biobuzzPhysics } from '../../src/games/biobuzz/state';
import { biobuzzStep } from '../../src/games/biobuzz/step';
import { step3d } from '../../src/games/biobuzz/sim3d/step3d';
import { rapier3d } from '../../src/games/biobuzz/sim3d/engine';
import { disposeEngineFor, engineFor, robotBodyOf, syncElements } from '../../src/games/biobuzz/sim3d/engineImpl';
import { cadStatics, cadTrayRefTheta, cadTrayRiders, fieldColliders3d, type FieldStatic } from '../../src/games/biobuzz/sim3d/fieldColliders';
import { hiveCellLocalBox, hivePivotX, hiveTrayRefTheta, __setFieldCollidersOverrideForTests } from '../../src/games/biobuzz/sim3d/bodies';
import { hiveTiltAngle } from '../../src/games/biobuzz/sim3d/hive3d';
import { hyp3, rotate2 } from '../../src/games/biobuzz/sim3d/math3';
import { rot, wrapAngle } from '../../src/math';
import { worldHash } from '../../src/net/checksum';
import { bbScoreWorld } from '../../src/games/biobuzz/score';
import { bbFootprint, bbMouths, bbSolveShot, mouthAxes } from '../../src/games/biobuzz/robot';
import { robotExtents } from '../../src/sim/physics';
import { chassis3dShapes, chassis3dPocketShapes, chassis3dReachShapes, chassis3dPlanEnvelope, __setLegacyPrismForTests, GROUP_POCKET } from '../../src/games/biobuzz/sim3d/bodies';
import { solveShotPath } from '../../src/games/biobuzz/shotPath';
import {
  BB3_CHASSIS_TOP_Z,
  BB3_HEIGHT_MAX,
  BB3_ROUND,
  BB3_HIVE_PIVOT_Z,
  BB3_MOUTH_SLOT_Z,
  BB_INTAKE_PERIOD_MAX,
  BB_FLOWERS,
  FLOWER_MOUTH,
  BB_FLOWER_D,
  BB_FLOWER_OPEN_R,
  BB_FLOWER_TOP_Z,
  BB_FRAME_BAR_IN,
  BB_FRAME_BAR_OUT,
  BB_FRAME_Y,
  BB_DECK_Z,
  BB_DUMP_BUCKET,
  BB_DUMP_RELOAD_S,
  BB_DUMP_SEAT_PITCH,
  BB_GARDEN,
  BB_HALF_X,
  BB_HALF_Y,
  BB_HIVE_BOTTOM_Z,
  BB_HIVE_LOWEST_Z,
  BB_HIVE_CELL_DY,
  BB_HIVE_OPEN_Z,
  BB_HIVE_X,
  BB_PLACE_REACH,
  BB_POLLEN_R,
  BB_RAMP_DECK_Z,
  BB_RAMP_IN,
  BB_RAMP_DEPLOY_S,
  BB_RAMP_OUT,
  BB_RAMP_TIP_Z,
  BB_SIDE_ROLLER_OUT,
  BB_SIDE_ROLLER_R,
  bbSideRollerY,
  BB_START_POSES,
  BB_TAPE,
  BB_TILE_PITCH,
  BB_TIP_POLLEN,
  bbArchetypeWallExtra,
  bbHeightNow,
  bbMechEnvelopes,
  bbIntakeReach,
  FLOWER_RING_Z,
} from '../../src/games/biobuzz/config';
import * as C from '../../src/config';
import { biobuzzColliders, BB_WALL_COUNT } from '../../src/games/biobuzz/colliders';
import { renderDims } from '../field-cad/emit-dims.mjs';
import { readFileSync } from 'node:fs';
import type { Artifact, RobotCommand, RobotSpec, World } from '../../src/types';
// eslint-disable-next-line @typescript-eslint/no-var-requires -- tsx (not tsc) runs this suite;
// `scripts/` is outside tsconfig.json's `include`, so a JSON import here never reaches `tsc`.
import fieldMeasurements from '../../public/models/biobuzz/field-measurements.json';

/**
 * SIM3D -- the Day 1 lane for the 3D physics port (`docs/biobuzz/plan-3d.md`). Checks the
 * seam (physics tag, dispatch), the persistent engine (sync/readback/containment), drive-feel
 * parity against the 2D pipeline, determinism, element conservation, intake capture, launch
 * into the hive, height clearance, the tip, and step cost.
 */

function speedOf(w: World): number {
  const r = w.robots[0];
  return Math.sqrt(r.vel.x * r.vel.x + r.vel.y * r.vel.y);
}

/** run `seconds` of `stepFn` on `w`, sampling robot 0's planar speed every tick; returns the
 * final speed and the first tick (in seconds) at which it reached 95% of the LAST sample. */
function driveProfile(
  w: World,
  c: RobotCommand,
  seconds: number,
  stepFn: (w: World, dt: number, cmds: Map<number, RobotCommand>) => void,
): { topSpeed: number; t95: number } {
  const dt = 1 / 60;
  const n = Math.round(seconds / dt);
  const cmds = new Map([[0, c]]);
  let t95 = seconds;
  let found95 = false;
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    stepFn(w, dt, cmds);
    samples.push(speedOf(w));
  }
  // PEAK, not the last sample: a 2-second straight run can reach the far wall before the
  // window ends, and the resulting collision-slowed final tick is not this robot's top speed.
  const topSpeed = Math.max(...samples);
  for (let i = 0; i < samples.length; i++) {
    if (!found95 && samples[i] >= 0.95 * topSpeed) {
      t95 = i * dt;
      found95 = true;
    }
  }
  return { topSpeed, t95 };
}

function yawRateOf(w: World): number {
  return Math.abs(w.robots[0].angVel);
}

function turnProfile(
  w: World,
  c: RobotCommand,
  seconds: number,
  stepFn: (w: World, dt: number, cmds: Map<number, RobotCommand>) => void,
): { topRate: number } {
  const dt = 1 / 60;
  const n = Math.round(seconds / dt);
  const cmds = new Map([[0, c]]);
  let topRate = 0;
  for (let i = 0; i < n; i++) {
    stepFn(w, dt, cmds);
    topRate = Math.max(topRate, yawRateOf(w));
  }
  return { topRate };
}

/**
 * The world-space centre of a point at local (x, v, w) on hive `alliance`'s tray, at tilt
 * `theta` -- the smoke lane's own placement helper, built from the SAME geometry
 * `sim3d/bodies.ts`/`derive.ts` use, so a scene staged with it is staged where the engine
 * actually thinks the cell is.
 *
 * NO `refTheta` TERM -- `hiveCellLocalBox`'s `vMin..wMax` numbers (0 for the theta-independent
 * algebraic fallback box, `cadCaptureTheta(alliance)` for a CAD box, captured AT that tilt) are
 * now BAKED into the built collider's own geometry by `sim3d/bodies.ts`'s `obliqueBoxCollider`
 * (a per-collider Rapier rotation of `refTheta`, fixed once at creation -- not the live, per-tick
 * `setNextKinematicRotation` the earlier, REJECTED per-collider-rotation attempt used, which is
 * what destabilized a resting element; see that function's own comment), so `world = pivot +
 * Rotate(theta) * (v, w)` holds the same way it always did for the fallback box (`refTheta`
 * always 0) -- see `HiveLocalBox.refTheta`'s own comment. `derive.ts`'s `insideCell` does the
 * matching inverse, also with no `refTheta` term.
 */
function hiveWorldPoint(
  alliance: 'red' | 'blue',
  sideSign: 1 | -1,
  theta: number,
  x: number,
  v: number,
  w: number,
): { x: number; y: number; z: number } {
  const { a: y, b: z } = rotate2(v, w, theta);
  return { x: hivePivotX(alliance) + x, y, z: BB3_HIVE_PIVOT_Z + z };
}

/** an archetype build: the named intake on the named mount, no launcher or lift */
const bbArchSpec = (kind: 'sweeper' | 'siderollers' | 'ramp', mount: 'front' | 'back' | 'side' | 'frontback' = 'front'): Partial<RobotSpec> => ({
  intakeMount: mount,
  bbMech: { launcher: null, lift: null, intake: { kind } } as unknown as RobotSpec['bbMech'],
});

export function sim3dChecks(check: Check): void {
  // ---- seam: physics tag + dispatch ------------------------------------------------------
  {
    const setups = [setup(0, 'blue')];
    const w2dA = createBiobuzzWorld('free', 7, setups);
    const w2dB = createBiobuzzWorld('free', 7, setups, undefined, '2d');
    check(
      'seam: createBiobuzzWorld with 4 args and an explicit 2d tag give identical JSON',
      JSON.stringify(w2dA) === JSON.stringify(w2dB),
    );
    const w3d = createBiobuzzWorld('free', 7, setups, undefined, '3d');
    check('seam: a 3d world carries the physics tag', w3d.biobuzz?.physics === '3d');
    check('seam: biobuzzPhysics reads it back', biobuzzPhysics(w3d) === '3d' && biobuzzPhysics(w2dA) === '2d');
    let threw = false;
    try {
      biobuzzStep(w3d, 1 / 60, new Map());
    } catch {
      threw = true;
    }
    check('seam: stepping a 3d world does not throw', !threw);
    for (const r of w3d.robots) check(`seam: robot ${r.id} reads z === 0 after one tick`, (r.z ?? -1) === 0);
    const badPos = w3d.balls.filter((b) => !Number.isFinite(b.pos.x) || !Number.isFinite(b.pos.y) || !Number.isFinite(b.z));
    check('seam: every element has a finite position after one tick', badPos.length === 0, `${badPos.length} non-finite`);
  }
  // ---- heightIn seam: coerceSpec must carry heightIn across into the biobuzz clamp --------
  //
  // `src/sim/spawn.ts`'s `coerceSpec` copies `bbMech` into `coerceBiobuzzSpec`'s input but,
  // before this lane's fix, had no matching line for `heightIn` -- so a spec's `heightIn` was
  // silently dropped for every real caller (settings load, server ingress, `createWorld`)
  // before the biobuzz clamp (`coerceBiobuzzSpec`, `BB3_HEIGHT_MIN`..`BB3_HEIGHT_MAX`) ever
  // saw it. `bbCoerce` is the exact chokepoint a real spec goes through.
  {
    const kept = bbCoerce({ heightIn: 16 });
    check('heightIn: 16 (in range) survives coerceSpec into the biobuzz clamp', kept.heightIn === 16, `got ${kept.heightIn}`);
    const clamped = bbCoerce({ heightIn: 29 });
    check(
      `heightIn: 29 (over BB3_HEIGHT_MAX) clamps to ${BB3_HEIGHT_MAX}`,
      clamped.heightIn === BB3_HEIGHT_MAX,
      `got ${clamped.heightIn}`,
    );
    const absent = bbCoerce({});
    check(
      'heightIn: absent stays absent (BB3_HEIGHT_DEFAULT applies downstream)',
      absent.heightIn === undefined,
      `got ${absent.heightIn}`,
    );
  }

  // ---- drive-feel parity: 2D vs 3D, same spec ---------------------------------------------
  //
  // BOTH fixtures below relocate robot 0 to the OPEN FIELD CENTRE before measuring. The
  // staged BIOBUZZ start position (`mkWorld`/`mkWorld3d`'s default) sits FLUSH against a wall
  // by design (a real start position), and a robot's `robotExtents` footprint touching a wall
  // AT TICK 0 puts a wall-contact friction term into tick 0's answer that has nothing to do
  // with the shared drivetrain model this check exists to compare. Measured (this lane's final
  // report): at the staged position, one second of `rotate: 1` gave 2D 0.298 rad/s against 3D
  // 0.298-9 rad/s depending on how closely the two engines' own wall-contact solvers agreed --
  // moved off the wall, the SAME command gives 2D 9.6495 rad/s against 3D 9.6496 (ratio
  // 1.0000), and the forward case's t95 matches to the tick (0.333s both). Rapier2D and
  // Rapier3D are separate solvers and are not required to agree on CONTACT friction bit for
  // bit -- the drivetrain model they are both fed (`updateRobot`, shared, untouched) is what
  // this check is actually for, and it is exact once nothing is touching a wall at tick 0.
  // `driveProfile`'s own PEAK-sampling already tolerates a wall hit LATER in the window (its
  // header comment says so); only the STARTING contact was the problem.
  function clearOfWalls(w: World): void {
    const r = w.robots[0];
    r.pos.x = 0;
    r.pos.y = 0;
    r.heading = 0;
    r.vel = { x: 0, y: 0 };
    r.angVel = 0;
  }
  {
    const spec = {};
    const w2d = mkWorld('free', 2, spec);
    const w3d = mkWorld3d('free', 2, spec);
    clearOfWalls(w2d);
    clearOfWalls(w3d);
    const forward = cmd({ driveY: 1 });
    const p2d = driveProfile(w2d, forward, 2, biobuzzStep);
    const p3d = driveProfile(w3d, forward, 2, step3d);
    const speedRatio = p2d.topSpeed > 0 ? p3d.topSpeed / p2d.topSpeed : 1;
    check(
      'drive-feel: top speed within 5% of the 2D pipeline',
      Math.abs(speedRatio - 1) <= 0.05,
      `2d=${p2d.topSpeed.toFixed(2)} 3d=${p3d.topSpeed.toFixed(2)} ratio=${speedRatio.toFixed(3)}`,
    );
    const t95Diff = Math.abs(p3d.t95 - p2d.t95);
    check(
      'drive-feel: time-to-95%-of-top-speed within 5% or 2 ticks of the 2D pipeline',
      t95Diff <= Math.max(2 / 60, 0.05 * p2d.t95),
      `2d=${p2d.t95.toFixed(3)}s 3d=${p3d.t95.toFixed(3)}s`,
    );
  }
  {
    const spec = {};
    const w2d = mkWorld('free', 3, spec);
    const w3d = mkWorld3d('free', 3, spec);
    clearOfWalls(w2d);
    clearOfWalls(w3d);
    const turn = cmd({ rotate: 1 });
    const r2d = turnProfile(w2d, turn, 1, biobuzzStep);
    const r3d = turnProfile(w3d, turn, 1, step3d);
    const rateRatio = r2d.topRate > 0 ? r3d.topRate / r2d.topRate : 1;
    check(
      'drive-feel: yaw rate within 5% of the 2D pipeline (pure rotate)',
      Math.abs(rateRatio - 1) <= 0.05,
      `2d=${r2d.topRate.toFixed(3)} 3d=${r3d.topRate.toFixed(3)} ratio=${rateRatio.toFixed(3)}`,
    );
  }

  // ---- two-run determinism: a scripted 600-tick sequence -----------------------------------
  {
    function scripted(t: number): RobotCommand {
      // drive, turn, intake, fire, place, nectar -- a varied but fully deterministic script,
      // keyed off the tick number alone (no RNG at the call site).
      const phase = Math.floor(t / 60) % 6;
      const base = cmd({});
      if (phase === 0) return { ...base, driveY: 1 };
      if (phase === 1) return { ...base, rotate: 1 };
      if (phase === 2) return { ...base, driveY: 1, intake: true };
      if (phase === 3) return { ...base, fire: true };
      if (phase === 4) return { ...base, bbPlace: true, bbPlaceNectar: true };
      return { ...base, bbNectar: true, driveX: 1 };
    }
    const wa = mkWorld3d('free', 11);
    const wb = mkWorld3d('free', 11);
    const hashesA: number[] = [];
    const hashesB: number[] = [];
    for (let t = 0; t < 600; t++) {
      const c = scripted(t);
      step3d(wa, 1 / 60, new Map([[0, c]]));
      step3d(wb, 1 / 60, new Map([[0, c]]));
      if (t % 60 === 0) {
        hashesA.push(worldHash(wa));
        hashesB.push(worldHash(wb));
      }
    }
    check(
      'determinism: two fresh 3D worlds, same seed and script, hash equal every 60 ticks',
      hashesA.every((h, i) => h === hashesB[i]),
      `${JSON.stringify(hashesA)} vs ${JSON.stringify(hashesB)}`,
    );
    check(
      'determinism: two fresh 3D worlds, same seed and script, final JSON identical',
      JSON.stringify(wa) === JSON.stringify(wb),
    );
  }

  // ---- conservation: 56 elements, no duplicate ids, over 1200 ticks of driving -------------
  {
    const w = mkWorld3d('free', 21);
    let ok = true;
    let detail = '';
    const drive = cmd({ driveY: 1, driveX: 0.3 });
    for (let t = 0; t < 1200 && ok; t++) {
      // sweep through the garden lines every few seconds by alternating drive direction
      const phase = Math.floor(t / 180) % 2;
      step3d(w, 1 / 60, new Map([[0, phase === 0 ? drive : cmd({ driveY: -1, driveX: -0.3 })]]));
      if (w.balls.length !== 56) {
        ok = false;
        detail = `tick ${t}: ${w.balls.length} balls`;
        break;
      }
      const ids = new Set(w.balls.map((b) => b.id));
      if (ids.size !== w.balls.length) {
        ok = false;
        detail = `tick ${t}: duplicate id in ${JSON.stringify(w.balls.map((b) => b.id))}`;
      }
    }
    check('conservation: 56 elements, no duplicate ids, over 1200 ticks of driving', ok, detail);
  }

  // ---- containment: nothing outside the perimeter or below the tiles, over 3600 ticks ------
  {
    const w = mkWorld3d('free', 22);
    let ok = true;
    let detail = '';
    for (let t = 0; t < 3600 && ok; t++) {
      // ram the garden lines and the walls: alternate corner-to-corner diagonals
      const phase = Math.floor(t / 300) % 4;
      const c =
        phase === 0
          ? cmd({ driveY: 1, driveX: 1 })
          : phase === 1
            ? cmd({ driveY: -1, driveX: 1 })
            : phase === 2
              ? cmd({ driveY: -1, driveX: -1 })
              : cmd({ driveY: 1, driveX: -1 });
      step3d(w, 1 / 60, new Map([[0, c]]));
      for (const b of w.balls) {
        if (b.state.kind === 'held' || b.state.kind === 'stock') continue;
        if (!Number.isFinite(b.pos.x) || !Number.isFinite(b.pos.y) || !Number.isFinite(b.z)) {
          ok = false;
          detail = `tick ${t}: ball ${b.id} non-finite`;
          break;
        }
        if (Math.abs(b.pos.x) > BB_HALF_X + 0.01 || Math.abs(b.pos.y) > BB_HALF_Y + 0.01) {
          ok = false;
          detail = `tick ${t}: ball ${b.id} outside perimeter at (${b.pos.x.toFixed(2)},${b.pos.y.toFixed(2)})`;
          break;
        }
        if (b.z < -0.5) {
          ok = false;
          detail = `tick ${t}: ball ${b.id} below the tiles at z=${b.z.toFixed(2)}`;
          break;
        }
      }
      for (const r of w.robots) {
        if (Math.abs(r.pos.x) > BB_HALF_X + 0.01 || Math.abs(r.pos.y) > BB_HALF_Y + 0.01) {
          ok = false;
          detail = `tick ${t}: robot ${r.id} outside perimeter`;
          break;
        }
      }
    }
    check('containment: nothing outside the perimeter or below the tiles, over 3600 ticks', ok, detail);
    const engine = engineFor(w);
    // walls are ALWAYS built at the shared BB_HALF_X/Y constants now (owner correction -- see
    // `buildStatics3d`'s own comment), so the staged loading-zone pollen (placed 1.4in clear of
    // that SAME constant) never start embedded, and this invariant holds with no safety net.
    check(
      'containment: containmentFixes stayed 0 -- the invariant held without the safety net',
      engine.containmentFixes === 0,
      `${engine.containmentFixes} fixes`,
    );
  }

  // ---- a resting element stays at rest ------------------------------------------------------
  {
    /**
     * WHAT "AT REST" MEANS UNDER A SOFT-CONTACT SOLVER, and why the tick count kept moving.
     *
     * A garden row settles into a COLUMN pressed against the audience wall — on this seed,
     * elements 29/26/30 end up at y 28.47 / 31.26 / 34.06, i.e. 2.79 in apart against a 2.80-in
     * diameter, so the column is a few thou interpenetrated. Their VELOCITY is exactly zero from
     * the moment the roll law snaps it (measured: `vel` and `vz` are hard 0 at tick 900 and stay
     * 0), and they are not translating under any dynamics. What is left is Rapier resolving that
     * residual overlap, ~2e-6 in per tick, in the POSITION channel only — invisible to every
     * gameplay predicate and to `bbSettled`, but not to an exact position compare.
     *
     * It DECAYS, and that is the load-bearing fact. Worst drift over consecutive 600-tick
     * windows, seed 23: 3.91e-2 → 4.20e-3 → 8.0e-4 → 2.0e-4 → 1.0e-4 → EXACTLY 0 from tick 3600.
     * So 900 settle ticks (the old number, raised from 600 once already when the CAD wall's
     * inner face moved ~1.33 in inward) does not buy stillness, it buys a smaller number: at 900
     * ball 26 still relaxes 4.3e-3 in y over the next 600 ticks. Chasing it with a third magic
     * constant is a treadmill, so the pair below asserts the two things that are actually true:
     * relaxation CONVERGES (the check after this one), and once it has converged the field is
     * BIT-STILL — not within a tolerance, not a single unit of the 1e-4 position quantum.
     */
    const w = mkWorld3d('free', 23);
    for (let t = 0; t < 3600; t++) step3d(w, 1 / 60, new Map());
    const ground = w.balls.filter((b) => b.state.kind === 'ground');
    const before = new Map(ground.map((b) => [b.id, { x: b.pos.x, y: b.pos.y, z: b.z }]));
    for (let t = 0; t < 600; t++) step3d(w, 1 / 60, new Map());
    let ok = true;
    let detail = '';
    let moving = '';
    for (const b of w.balls) {
      if (b.state.kind !== 'ground') continue;
      const was = before.get(b.id);
      if (!was) continue; // was not ground before settling; not part of this check
      // AND ITS VELOCITY IS EXACTLY ZERO, which is the statement `bbSettled` and the HUD read.
      if (b.vel.x !== 0 || b.vel.y !== 0 || b.vz !== 0) {
        moving = `ball ${b.id} vel (${b.vel.x},${b.vel.y},${b.vz})`;
        break;
      }
      if (was.x !== b.pos.x || was.y !== b.pos.y || was.z !== b.z) {
        ok = false;
        detail = `ball ${b.id} moved from (${was.x},${was.y},${was.z}) to (${b.pos.x},${b.pos.y},${b.z})`;
        break;
      }
    }
    check(
      'a settled resting element is BIT-still for 600 further ticks, and its velocity is exactly zero',
      ok && moving === '',
      detail || moving,
    );
  }

  // ---- and the relaxation that gets it there decays, rather than creeping forever -----------
  {
    /**
     * THE CHECK THAT DOES NOT NEED A MAGIC TICK COUNT. Contact-overlap relaxation is allowed —
     * it is how a soft solver un-jams a packed column — but it has to DIE OUT. A creep that
     * held its rate, or grew, is the signature of a jitter loop or a pair of colliders fighting
     * each other, and the fixed-tolerance check above cannot tell that apart from "needs a few
     * hundred more ticks". So: worst per-axis drift over consecutive 600-tick windows must at
     * least HALVE each window while it is still above the 1e-3 tolerance, and once under it may
     * never climb back. Measured ratios on seed 23: 0.107, 0.190, 0.250, 0.500, 0.
     *
     * ALL-ZERO IS A PASS, AND SINCE 2026-09-19 IT IS THE EXPECTED READING. Those ratios were
     * measured while a resting element could never sleep (the zeroing writes in `groundRoll3d`
     * and `syncElement` woke it every tick), so a packed line went on relaxing at the 1e-4 level
     * for thousands of ticks. It sleeps now once its rounded position has stopped moving, so by
     * the first window there is nothing left to decay — which is the strongest form of "it dies
     * out", not a scenario that stopped measuring anything. The old `drifts[0] > 0` guard read
     * that as a failure.
     */
    const w = mkWorld3d('free', 23);
    const take = (): Map<number, { x: number; y: number; z: number }> =>
      new Map(w.balls.filter((b) => b.state.kind === 'ground').map((b) => [b.id, { x: b.pos.x, y: b.pos.y, z: b.z }]));
    for (let t = 0; t < 600; t++) step3d(w, 1 / 60, new Map());
    let snap = take();
    const drifts: number[] = [];
    for (let win = 0; win < 5; win++) {
      for (let t = 0; t < 600; t++) step3d(w, 1 / 60, new Map());
      let worst = 0;
      for (const b of w.balls) {
        if (b.state.kind !== 'ground') continue;
        const was = snap.get(b.id);
        if (!was) continue;
        worst = Math.max(worst, Math.abs(was.x - b.pos.x), Math.abs(was.y - b.pos.y), Math.abs(was.z - b.z));
      }
      drifts.push(worst);
      snap = take();
    }
    let ok = true;
    for (let i = 1; i < drifts.length; i++) {
      const prev = drifts[i - 1];
      const now = drifts[i];
      if (prev > 1e-3 ? now > prev / 2 : now > 1e-3) ok = false;
    }
    check(
      'the residual contact relaxation DECAYS — each 600-tick window drifts at most half the last',
      ok,
      `worst drift per window: ${drifts.map((d) => d.toExponential(2)).join(' -> ')}`,
    );
  }

  // ---- CCD: a 260 in/s shot does not tunnel a 0.25-in cell wall ----------------------------
  {
    const w = mkWorld3d('free', 24);
    const theta = Math.PI / 6; // the rest tilt, BB_HIVE_TILT_DEG in radians (blue up = north)
    const box = hiveCellLocalBox(1, 'blue');
    const wCentre = (box.wMin + box.wMax) / 2;
    // START CLEAR OF THE BACK SLAB, NOT TOUCHING IT. The wall this fires at is the cell's BACK
    // plate, whose collider is a 1.5-in slab extruded from the CAD plane AWAY from the cell -- so
    // it occupies the 1.5 in of `v` immediately BEHIND `box.vMin`, which is where the old
    // `box.vMin - 3` start point put the 1.5-in-radius element: overlapping the slab on tick
    // zero, which is a deep-contact test, not a tunnelling test. Backing off by another two radii
    // gives a genuine clear sweep INTO the wall at 260 in/s (4.33 in per tick against a 1.5-in
    // slab), which is what this check is for.
    const startV = box.vMin - 3 - 2 * BB_POLLEN_R;
    const start = hiveWorldPoint('blue', 1, theta, 0, startV, wCentre);
    const velDir = rotate2(260, 0, theta);
    const id = Math.max(...w.balls.map((b) => b.id)) + 1;
    const shot: Artifact = {
      id,
      color: 'yellow',
      state: { kind: 'ground' },
      pos: { x: start.x, y: start.y },
      vel: { x: 0, y: velDir.a },
      z: start.z - BB_POLLEN_R,
      vz: velDir.b,
    };
    w.balls.push(shot);
    for (let t = 0; t < 8; t++) step3d(w, 1 / 60, new Map());
    const after = w.balls.find((b) => b.id === id)!;
    const dy = after.pos.y - 0;
    const dz = after.z + BB_POLLEN_R - BB3_HIVE_PIVOT_Z;
    const local = rotate2(dy, dz, -theta);
    check(
      'CCD: a 260 in/s shot into a 0.25-in cell wall does not tunnel through it',
      local.a <= box.vMin + 1,
      `local v=${local.a.toFixed(3)} (wall near face at v=${box.vMin.toFixed(3)})`,
    );
  }

  // ---- intake: a robot driven onto a garden pollen with intake held captures it -------------
  {
    const w = mkWorld3d('free', 25);
    const target = w.balls.find((b) => b.state.kind === 'ground');
    if (!target) {
      check('intake: a staged ground pollen exists to test capture against', false);
    } else {
      const r = w.robots[0];
      const hl = r.spec.length / 2;
      // relocate the staged garden ball to a safe, wall-clear interior spot first -- every
      // staged `ground` element sits within a pollen radius of a wall (that is what a GARDEN
      // is), and placing the robot's own chassis behind it (further from field centre, to put
      // the ball in front of the mouth) would put the chassis THROUGH the perimeter wall,
      // which explodes on the very first physics step (measured: a ~450 in/s spurious first-
      // tick velocity from the wall-penetration recovery).
      target.pos.x = 0;
      target.pos.y = 0;
      target.z = 0;
      target.vel = { x: 0, y: 0 };
      target.vz = 0;
      // put the ball ON THE ROLLER LINE -- resting against the front of the robot's own
      // collider, which in 3D is `robotExtents` (intake reach INCLUDED), so this is the
      // nearest an element can physically get. It used to be dropped at `hl + 1`, i.e. 2 in
      // INSIDE that collider, which the old instant-capture rule swallowed before the
      // penetration recovery could fire; the roller model draws it in from where it can
      // actually be instead (`bbIntakeAct`).
      r.heading = 0;
      r.pos.x = target.pos.x - (bbFootprint(r.spec).front + BB_POLLEN_R + 0.2);
      r.pos.y = target.pos.y;
      void hl;
      // EMPTY THE HOPPER FIRST -- a freshly-staged robot already carries its 4 preloaded
      // POLLEN (section 10.3.4), which is exactly `bbHopperCap`'s ceiling for this build, so
      // capture would otherwise refuse for a reason this check is not testing.
      for (const b of w.balls) {
        if (b.state.kind === 'held' && b.state.robot === r.id) b.state = { kind: 'ground' };
      }
      r.hopper = [];
      const hopperBefore = r.hopper.length;
      const engine = engineFor(w);
      const bodiesBefore = engine.elements.size;
      let capturedAtTick = -1;
      // ONE FEED CADENCE, not a fixed dwell: an intake passes one element every
      // `BB_INTAKE_PERIOD_MIN`..`_MAX` (`bbIntakeAct`), so the budget is the slow end of that
      // plus a few ticks of transit rather than a fixed dwell, which no longer exists as a
      // capture rule.
      const maxTicks = Math.ceil(BB_INTAKE_PERIOD_MAX * 60) + 6;
      for (let t = 0; t < maxTicks; t++) {
        step3d(w, 1 / 60, new Map([[0, cmd({ intake: true })]]));
        const now = w.balls.find((b) => b.id === target.id)!;
        if (now.state.kind === 'held') {
          capturedAtTick = t;
          break;
        }
      }
      check(
        `intake: captures within ${maxTicks} ticks of overlap`,
        capturedAtTick >= 0,
        capturedAtTick >= 0 ? `tick ${capturedAtTick}` : 'never captured',
      );
      const rAfter = w.robots[0];
      check('intake: hopper length increased by one', rAfter.hopper.length === hopperBefore + 1, `${hopperBefore} -> ${rAfter.hopper.length}`);
      const ballAfter = w.balls.find((b) => b.id === target.id)!;
      check('intake: the captured ball reads state held', ballAfter.state.kind === 'held');
      // the body removal itself happens on the NEXT tick's sync (it reconciles the JSON
      // state change made by THIS tick's gameplay stage), so one more tick has to run before
      // the engine's own body count reflects it.
      step3d(w, 1 / 60, new Map([[0, cmd({ intake: true })]]));
      const engineAfter = engineFor(w);
      check(
        "intake: the engine's element body count dropped by one",
        engineAfter.elements.size === bodiesBefore - (capturedAtTick >= 0 ? 1 : 0),
        `${bodiesBefore} -> ${engineAfter.elements.size}`,
      );
    }
  }

  // ---- the SIDE of the intake is an obstacle, not a mouth (owner item 7, 2026-09-19) --------
  /**
   * "If the side of the intake comes in contact with a pollen very gently, then a very weird
   * behavior happens where the pollen and the robot are stuck together and the robot turns by
   * itself."
   *
   * ⚠️ THIS IS THE LANE THE BUG LIVED IN. `bbIntakeAct`'s lateral window was `half + er`, so an
   * element whose CENTRE sat up to one radius OUTBOARD of the roller's end — on the far side of
   * the side plate `bbRobotSolids` makes solid — was gripped and commanded `DRAW_IN ·
   * CENTRE_FRAC` (50.4 in/s) straight INTO that plate, every tick. In 2D a ground element cannot
   * push a robot, so it merely sat there; here it is a real dynamic body against a real collider,
   * and that injected momentum was delivered to the chassis at an OFF-CENTRE point. MEASURED,
   * robot parked, no command but the intake: heading drifted **0.335 rad (19.2°) in 6.7 s** at a
   * steady −0.035 rad/s, the chassis walked 1.6 in, and the element was dragged 5.1 in along with
   * it. The same scene with the intake OFF drifted 0.001 rad, which is what this check pins to.
   *
   * The sweep covers the whole band an element can rest in against the plate, because the failure
   * was at every offset in it. It also BACKS AWAY at the end: a gripped element followed the robot.
   */
  {
    for (const frac of [0.3, 0.6, 0.9] as const) {
      const w = mkWorld3d('free', 26);
      const r = w.robots[0];
      for (const b of w.balls) {
        if (b.state.kind === 'held' && b.state.robot === r.id) b.state = { kind: 'ground' };
      }
      r.hopper = [];
      r.pos = { x: 0, y: -30 };
      r.heading = 0;
      r.vel = { x: 0, y: 0 };
      r.angVel = 0;
      const m = bbMouths(r.spec).find((x) => x.edge === 'front') ?? bbMouths(r.spec)[0];
      const reach = bbFootprint(r.spec).front - r.spec.length / 2;
      const ball: Artifact = {
        id: 9100 + Math.round(frac * 10),
        color: 'yellow',
        state: { kind: 'ground' },
        pos: { x: r.pos.x + r.spec.length / 2 + reach / 2, y: r.pos.y + m.y1 + BB_POLLEN_R * frac },
        vel: { x: 0, y: 0 },
        z: 0,
        vz: 0,
      };
      w.balls.push(ball);
      const h0 = r.heading;
      let worstDrift = 0;
      for (let t = 0; t < 400; t++) {
        step3d(w, 1 / 60, new Map([[0, cmd({ intake: true })]]));
        worstDrift = Math.max(worstDrift, Math.abs(wrapAngle(r.heading - h0)));
      }
      const stuck = ball.state.kind !== 'ground';
      for (let t = 0; t < 90; t++) step3d(w, 1 / 60, new Map([[0, cmd({ driveY: -0.5 })]]));
      const sep = Math.hypot(ball.pos.x - r.pos.x, ball.pos.y - r.pos.y);
      check(
        `intake side: a POLLEN against the side plate (+${frac}r outboard) is pushed, not gripped — no free yaw`,
        !stuck && worstDrift < 0.01 && sep > 40,
        `state=${ball.state.kind} worst drift ${worstDrift.toFixed(5)} rad (was 0.335 before the fix) · separation ${sep.toFixed(1)}in`,
      );
    }
  }

  // ---- rolling resistance, the rest snap, and the honest tag for an element on structure ---
  /**
   * `groundRoll3d` (`engineImpl.ts`) + `derive.ts`'s tagging. Three behaviours, each a bug that
   * held the post-match settle clock open or put an element permanently out of play.
   */
  {
    const roll = (phys: '2d' | '3d', v0: number): { d: number; s: number } => {
      const w = phys === '3d' ? mkWorld3d('free', 31) : mkWorld('free', 31);
      w.balls.length = 0;
      w.robots[0].hopper.length = 0;
      w.robots[0].pos = { x: 0, y: 60 };
      w.robots[0].vel = { x: 0, y: 0 };
      const b: Artifact = { id: 991, color: 'yellow', r: BB_POLLEN_R, state: { kind: 'ground' }, pos: { x: -60, y: -40 }, vel: { x: v0, y: 0 }, z: 0, vz: 0 };
      w.balls.push(b);
      let t = 0;
      for (; t < 1200; t++) {
        biobuzzStep(w, 1 / 60, new Map());
        if (Math.hypot(b.vel.x, b.vel.y) === 0) break;
      }
      return { d: b.pos.x + 60, s: t / 60 };
    };
    let worst = 0;
    let detail = '';
    for (const v0 of [20, 40, 60]) {
      const a = roll('2d', v0);
      const c = roll('3d', v0);
      const err = Math.abs(c.d - a.d) / a.d;
      if (err > worst) worst = err;
      detail += `${v0}: 2D ${a.d.toFixed(1)}in/${a.s.toFixed(2)}s vs 3D ${c.d.toFixed(1)}in/${c.s.toFixed(2)}s  `;
      // AND IT STOPS. Exponential damping never reaches zero; the 2D rest snap does, and so
      // must this — a ground element still creeping is what held the settle clock open for 8 s.
      check(`roll 3d: an element launched at ${v0} in/s comes to a HARD stop`, c.s < 20, `${c.s.toFixed(2)}s`);
    }
    check('roll 3d: the 3D roll-out matches the 2D pipeline within 15%', worst < 0.15, `worst ${(worst * 100).toFixed(1)}% — ${detail}`);

    // AT REST ON STRUCTURE IS `ground`, NOT `flight` FOREVER. `capturePollen` and the AI's
    // element scan both read `ground` only, so the old tag put such an element out of play.
    {
      const w = mkWorld3d('free', 31);
      w.balls.length = 0;
      w.robots[0].hopper.length = 0;
      w.robots[0].pos = { x: 0, y: -60 };
      const b: Artifact = { id: 992, color: 'yellow', r: BB_POLLEN_R, state: { kind: 'flight', target: 'blue' }, pos: { x: 12.3, y: -5.6 }, vel: { x: 0, y: 0 }, z: 60, vz: 0 };
      w.balls.push(b);
      run3d(w, new Map(), 5);
      check(
        'roll 3d: an element at rest ON the HIVE frame reads ground (not flight forever), and is in no cell',
        b.state.kind === 'ground' && b.z > 1 && Math.hypot(b.vel.x, b.vel.y) === 0 &&
          !w.biobuzz!.hives.blue.contents.includes(b.id) && !w.biobuzz!.hives.red.contents.includes(b.id),
        `state=${b.state.kind} z=${b.z.toFixed(2)} |v|=${Math.hypot(b.vel.x, b.vel.y).toFixed(3)}`,
      );
    }

    // ...AND AN ELEMENT AT REST INSIDE A CELL STILL COUNTS. The scoring half of the same rule:
    // membership waits for rest, so anything that breaks the rest test loses the points.
    {
      const w = mkWorld3d('free', 31);
      w.balls.length = 0;
      w.robots[0].hopper.length = 0;
      w.robots[0].pos = { x: 0, y: -60 };
      const up = w.biobuzz!.hives.blue.up;
      const sign: 1 | -1 = up === 'north' ? 1 : -1;
      const theta = hiveTiltAngle(w, 'blue');
      const box = hiveCellLocalBox(sign, 'blue');
      const p = hiveWorldPoint('blue', sign, theta, 0, (box.vMin + box.vMax) / 2, box.wMin + 2);
      const b: Artifact = { id: 993, color: 'yellow', r: BB_POLLEN_R, state: { kind: 'flight', target: 'blue' }, pos: { x: p.x, y: p.y }, vel: { x: 0, y: 0 }, z: p.z - BB_POLLEN_R + 2, vz: 0 };
      w.balls.push(b);
      run3d(w, new Map(), 3);
      check(
        'roll 3d: an element at rest INSIDE a cell is counted in that hive contents list',
        b.state.kind === 'element' && w.biobuzz!.hives.blue.contents.includes(b.id),
        `state=${b.state.kind} contents=${JSON.stringify(w.biobuzz!.hives.blue.contents)}`,
      );
    }

    // ...AND NOTHING FREEZES IN MID-AIR. The snap's discriminator is CONTACT, not speed: an
    // element at the apex of a lob is slower than any rest threshold for a tick.
    {
      const w = mkWorld3d('free', 31);
      w.balls.length = 0;
      w.robots[0].hopper.length = 0;
      w.robots[0].pos = { x: 0, y: -60 };
      const b: Artifact = { id: 994, color: 'yellow', r: BB_POLLEN_R, state: { kind: 'flight', target: 'blue' }, pos: { x: -40, y: 30 }, vel: { x: 0, y: 0 }, z: 30, vz: 0 };
      w.balls.push(b);
      run3d(w, new Map(), 2);
      check('roll 3d: an element dropped from 30 in reaches the tiles (the rest snap never freezes one in the air)', b.z < 0.5, `z=${b.z.toFixed(2)}`);
    }
  }

  // ---- the ROLLER intake, under 3D physics (`bbIntakeAct`, the SAME model 2D runs) ---------
  /**
   * The three cases the 2D lane pins, re-run here because the 3D pipeline reaches the model
   * from a different place (`elements3d.ts`, after readback) and against a chassis collider
   * that is `robotExtents` rather than the bare frame — which is exactly the difference
   * `BbIntakeOpts.seat` exists for, and the one that made every 3D capture un-arrivable when
   * it was missing.
   */
  {
    const stage = (seed: number, x: number, y: number) => {
      const w = mkWorld3d('free', seed);
      const r = w.robots[0];
      for (const b of w.balls) if (b.state.kind === 'held' && b.state.robot === r.id) b.state = { kind: 'stock', alliance: r.alliance };
      r.hopper = [];
      r.pos = { x, y };
      r.heading = 0;
      r.vel = { x: 0, y: 0 };
      r.angVel = 0;
      r.autoIntake = false;
      r.autoFire = false;
      return { w, r };
    };
    const pollen = (w: World, x: number, y: number): Artifact => {
      const id = w.balls.reduce((m, b) => Math.max(m, b.id), 0) + 1;
      const b: Artifact = { id, color: 'yellow', r: BB_POLLEN_R, state: { kind: 'ground' }, pos: { x, y }, vel: { x: 0, y: 0 }, z: 0, vz: 0 };
      w.balls.push(b);
      return b;
    };

    // THE COMPOUND'S OUTER PLAN ENVELOPE IS STILL `robotExtents`. This is the whole safety
    // argument for opening the mouth: the arm tips and the lintel end exactly where the single
    // cuboid ended, so wall contact, the wall-flush start pose and start legality cannot have
    // moved — and since 2026-09-21 it is also the bound a MECHANISM shape is clamped into
    // (`chassis3dMechShapes`), so a drawn turret head that overhangs its own rail is drawn
    // outside the collider rather than solid outside the footprint.
    //
    // ⚠️ THE **TOP** IS NO LONGER `h/2` — that was the floor-to-`heightIn` prism, i.e. the
    // owner's invisible corner. It is the DRAWN profile now: the low body to
    // `BB3_CHASSIS_TOP_Z`, and each standing mechanism to its own drawn top.
    {
      let bad = '';
      for (const mount of ['front', 'back', 'side', 'frontback'] as const) {
        const w = mkWorld3d('free', 71, { intakeMount: mount });
        const r = w.robots[0];
        const h = 18;
        const boxes = chassis3dShapes(r.spec, h);
        const fe = robotExtents(r);
        const front = Math.max(...boxes.map((b) => b.cx + b.hx));
        const rear = -Math.min(...boxes.map((b) => b.cx - b.hx));
        const half = Math.max(...boxes.map((b) => Math.max(b.cy + b.hy, -(b.cy - b.hy))));
        const top = Math.max(...boxes.map((b) => b.cz + b.hz));
        const bottom = Math.min(...boxes.map((b) => b.cz - b.hz));
        const drawnTop = Math.max(BB3_CHASSIS_TOP_Z, ...bbMechEnvelopes(r.spec, h).map((e) => e.top));
        const ok =
          front <= fe.front + 1e-9 &&
          rear <= fe.rear + 1e-9 &&
          half <= fe.half + 1e-9 &&
          Math.abs(Math.max(...boxes.filter((b) => b.shape !== 'cylinder').map((b) => b.cx + b.hx)) - fe.front) < 1e-9 &&
          Math.abs(top + h / 2 - drawnTop) < 1e-9 &&
          Math.abs(bottom + h / 2) < 1e-9;
        if (!ok && !bad) bad = `${mount}: ${front}/${rear}/${half} vs ${fe.front}/${fe.rear}/${fe.half}, z ${bottom}..${top} drawnTop ${drawnTop}`;
      }
      check('roller 3d: the chassis compound stays inside robotExtents in PLAN and tops out at the DRAWN profile, not at heightIn', bad === '', bad);
    }

    // ...AND THE POCKET IS OPEN ONLY UNDER AN ELEMENT. Nothing covers the mouth below the slot;
    // above it the lintel does, which is what keeps a wall, a robot and the HIVE where they were.
    {
      const w = mkWorld3d('free', 72, { intakeMount: 'front' });
      const r = w.robots[0];
      const boxes = chassis3dShapes(r.spec, 18);
      const probe = (x: number, z: number): boolean =>
        boxes.some((b) => Math.abs(x - b.cx) < b.hx && Math.abs(0 - b.cy) < b.hy && Math.abs(z - b.cz) < b.hz);
      const inMouth = r.spec.length / 2 + 1;
      const low = probe(inMouth, -9 + BB3_MOUTH_SLOT_Z / 2);
      const high = probe(inMouth, -9 + BB3_MOUTH_SLOT_Z + 1);
      check(
        'roller 3d: the mouth pocket is OPEN below one element height and CLOSED above it',
        !low && high,
        `low=${low} high=${high} slot=${BB3_MOUTH_SLOT_Z}`,
      );
    }

    /**
     * THE EDGE BREAK (`BB3_INTAKE_CORNER_R`). Every box of the compound is shrunk by `r` and
     * carries a CONTACT SKIN of `r`, so the outer surface is where it was and only the edges
     * pull in. Three things are pinned because each can go wrong in silence: the box must stay
     * a plain CUBOID (a `roundCuboid` is the obvious substitute and costs a quarter of the room
     * budget — `chassisBoxDesc`'s header has the A/B), the SKIN must actually be on each
     * collider (a shrunken box with no skin is a chassis 0.25 in small in every direction), and
     * the COUNT must match `chassis3dShapes` (a core half-extent driven non-positive is a
     * collider Rapier refuses to build, and the robot would drive with a missing arm).
     */
    {
      const RAPIER = rapier3d();
      const w = mkWorld3d('free', 73, { intakeMount: 'frontback' });
      step3d(w, 1 / 60, new Map());
      const body = robotBodyOf(engineFor(w), 0)!;
      const h = bbHeightNow(w, w.robots[0].spec);
      const shapes = chassis3dShapes(w.robots[0].spec, h);
      const pockets = chassis3dPocketShapes(w.robots[0].spec, h);
      const all = [...shapes, ...pockets];
      let bad = '';
      for (let i = 0; i < body.numColliders(); i++) {
        const col = body.collider(i);
        const s = all[i];
        const isPocket = i >= shapes.length;
        const r = col.contactSkin();
        // a MECHANISM shape is a CYLINDER (a turret sweeps a disc) — it has no edges to break and
        // no `halfExtents`, so it is checked for its own radius/half-height instead.
        if (s.shape === 'cylinder') {
          const cyl = col.shape as unknown as { radius: number; halfHeight: number };
          if (col.shapeType() !== RAPIER.ShapeType.Cylinder) bad = `#${i} mech shapeType ${col.shapeType()}`;
          else if (Math.abs(cyl.radius - s.hx) > 1e-9 || Math.abs(cyl.halfHeight - s.hz) > 1e-9) bad = `#${i} cylinder ${cyl.radius}/${cyl.halfHeight} vs ${s.hx}/${s.hz}`;
          continue;
        }
        const half = (col.shape as unknown as { halfExtents: { x: number; y: number; z: number } }).halfExtents;
        const outer = [half.x + r - s.hx, half.y + r - s.hy, half.z + r - s.hz];
        if (col.shapeType() !== RAPIER.ShapeType.Cuboid) bad = `#${i} shapeType ${col.shapeType()}`;
        else if (isPocket && col.collisionGroups() !== GROUP_POCKET) bad = `#${i} pocket groups ${col.collisionGroups().toString(16)}`;
        else if (!isPocket && r <= 0) bad = `#${i} no contact skin`;
        else if (outer.some((d) => Math.abs(d) > 1e-9)) bad = `#${i} outer surface off by [${outer.join(', ')}]`;
      }
      check(
        'corner 3d: every chassis box is a cuboid at its stated outer surface, edge-broken, and the pocket fillers carry the element filter',
        body.numColliders() === all.length && pockets.length === bbMouths(w.robots[0].spec).length && bad === '',
        `colliders=${body.numColliders()} shapes=${shapes.length}+${pockets.length} mouths=${bbMouths(w.robots[0].spec).length} ${bad}`,
      );
      disposeEngineFor(w);
    }

    /**
     * ⚠️ **THE FRONT FACE IS ONE CONTINUOUS RECTANGLE** (owner, 2026-09-19: "a bracing in the
     * front then, to make the collision hitbox a long rectangle across in the front"). Above
     * `BB3_MOUTH_SLOT_Z` that is the LINTEL; below it, the element-transparent POCKET FILLER.
     * Both end on the arm tips' own plane, and the filler's top is the lintel's underside to the
     * last bit — a step or a gap between them is a lip a corner could find, and it would be
     * invisible to every other check here.
     */
    {
      const spec = mkWorld3d('free', 77, { intakeMount: 'front' }).robots[0].spec;
      const h = 18;
      const solid = [...chassis3dShapes(spec, h), ...chassis3dPocketShapes(spec, h)];
      const m = bbMouths(spec)[0];
      const tip = spec.length / 2 + bbIntakeReach(spec);
      let bad = '';
      // walk the whole front face: every (y, z) just inside the tip plane must be covered, from
      // the tiles to the DRAWN chassis top (it used to run to `h` — the prism, see above)
      for (let y = m.y0 + 0.05; y <= m.y1 - 0.05 && !bad; y += 0.25) {
        for (let z = 0.05; z <= BB3_CHASSIS_TOP_Z - 0.05 && !bad; z += 0.1) {
          const hit = solid.some(
            (b) =>
              Math.abs(tip - 0.05 - b.cx) < b.hx && Math.abs(y - b.cy) < b.hy && Math.abs(z - h / 2 - b.cz) < b.hz,
          );
          if (!hit) bad = `hole at y=${y.toFixed(2)} z=${z.toFixed(2)}`;
        }
      }
      // ...and nothing sticks out past the tip plane
      const out = Math.max(...solid.map((b) => b.cx + b.hx));
      check(
        'corner 3d: the collider front face is one unbroken rectangle across the whole mouth, floor to full height',
        bad === '' && Math.abs(out - tip) < 1e-9,
        `${bad} outermost ${out} vs tip ${tip}`,
      );
    }

    /**
     * ⚠️ **THE EDGE BREAK MOVES NO FLAT FACE** — the invariant the whole approach rests on. A
     * robot driven square into a wall at heading 0 and at pi/2 rests where it always did, so a
     * wall-flush start position and `startLegal` cannot have moved either. Pinned as ABSOLUTE
     * distances rather than as a before/after diff, so a later change to the wall or to the
     * footprint fails here too. Both were measured at 10.5008/10.5006 in on the default spec
     * (outermost solid `hl + reach` = 10.5); the window is +-0.06 in, the brief's tolerance.
     */
    {
      const bad: string[] = [];
      for (const heading of [0, Math.PI / 2]) {
        const w = mkWorld3d('free', 74);
        const r = w.robots[0];
        r.heading = heading;
        r.pos.x = heading === 0 ? BB_HALF_X - 30 : 0;
        r.pos.y = heading === 0 ? 0 : BB_HALF_Y - 30;
        run3d(w, new Map([[0, cmd({ driveY: 1, leftDrive: 1, rightDrive: 1 })]]), 4);
        const gap = heading === 0 ? BB_HALF_X - r.pos.x : BB_HALF_Y - r.pos.y;
        const want = r.spec.length / 2 + bbIntakeReach(r.spec);
        if (Math.abs(gap - want) > 0.06) bad.push(`h=${heading.toFixed(2)} gap ${gap.toFixed(4)} want ${want.toFixed(4)}`);
        disposeEngineFor(w);
      }
      check('corner 3d: flat-wall rest distance is the outermost solid, both headings', bad.length === 0, bad.join(' | '));
    }

    /**
     * ⚠️ **THE OWNER'S CORNER CATCH** ("I can get stuck on a corner"). Driving at full stick
     * past the LEFT FLOWER's support column with the flank 0.35 in past the column's field-side
     * face, the robot used to lose the corner and yaw about it: **0.32 of a free run** and 107
     * degrees of yaw with square chassis corners, against **1.00 and 0 degrees** with the edge
     * break. Measured at 0.35 because that is inside the band the break bought (it slid past to
     * 0.2 in before, to 0.4 in now) — a margin on each side, not the threshold itself.
     *
     * ⚠️ It is NOT the intake compound: a single `robotExtents` cuboid caught at the same 0.2
     * in to two decimals. See `BB3_INTAKE_CORNER_R`'s header for the four things that were
     * measured and ruled out on the way, so nobody re-runs them.
     */
    {
      const FACE_X = -65.83; // the column's field-side face, `cadStatics()`
      const POST_Y0 = -25.62; // its low-y end
      const DRIVE = cmd({ driveY: 1, leftDrive: 1, rightDrive: 1 });
      /**
       * ⚠️ THE DRIVETRAIN IS PINNED, because this scene is about the EDGE BREAK and not about the
       * drive model, and the default preset stopped being a swerve on 2026-09-22 (the Pollinator).
       * MEASURED both ways on the same rig, one field, one column, one 0.35-in graze: SWERVE slides
       * by at 1.00 of a free run and 0 degrees of yaw; MECANUM hooks at 0.30 and 94 degrees, and
       * the width and the intake mount change neither answer (1.00 / 0 at width 16.5, 17 and
       * FRONT+BACK on swerve; 0.30 / 94 on all three with mecanum). So the break's band is a
       * drivetrain fact this check never claimed to cover — the mecanum case is an OPEN finding
       * for this lane, not something the preset list can fix.
       */
      const graze = (overlap: number | null): { frac: number; yaw: number } => {
        const w = mkWorld3d('free', 75, { drivetrain: 'swerve' });
        const r = w.robots[0];
        r.heading = Math.PI / 2;
        r.pos.x = overlap === null ? -40 : FACE_X + r.spec.width / 2 - overlap;
        r.pos.y = POST_Y0 - (r.spec.length / 2 + bbIntakeReach(r.spec)) - 16;
        const y0 = r.pos.y;
        const h0 = r.heading;
        run3d(w, new Map([[0, DRIVE]]), 3);
        const out = { frac: r.pos.y - y0, yaw: Math.abs(((r.heading - h0) * 180) / Math.PI) };
        disposeEngineFor(w);
        return out;
      };
      const free = graze(null).frac;
      const hit = graze(0.35);
      const frac = hit.frac / free;
      check(
        'corner 3d: a 0.35in graze past a FLOWER column slides by instead of hooking the corner',
        frac > 0.9 && hit.yaw < 10,
        `travelled ${frac.toFixed(2)} of a free run (${free.toFixed(1)}in), yaw ${hit.yaw.toFixed(0)} degrees`,
      );
    }

    /**
     * ...AND THE LINTEL STILL STOPS THE CLIMB. The reason the mouth pocket is closed above
     * `BB3_MOUTH_SLOT_Z` is that two thin arms let a robot catch a low static's top edge on its
     * frame's bottom edge and ride up it (parked 2.14 in in the air, stalled). The HIVE FRAME's
     * base bar is 2.15 in tall and is exactly that static; rounding the edges must not have
     * turned it back into a ramp.
     */
    {
      const w = mkWorld3d('free', 76);
      const r = w.robots[0];
      r.heading = 0;
      r.pos.x = BB_FRAME_BAR_IN - 30;
      r.pos.y = 8;
      let maxZ = 0;
      const m = new Map([[0, cmd({ driveY: 1, leftDrive: 1, rightDrive: 1 })]]);
      for (let t = 0; t < 240; t++) {
        step3d(w, 1 / 60, m);
        maxZ = Math.max(maxZ, r.z ?? 0);
      }
      check('corner 3d: a robot driven at the HIVE frame bar does not climb it', maxZ < 0.1, `max z ${maxZ.toFixed(4)}`);
      disposeEngineFor(w);
    }

    {
      const { w } = stage(61, BB_HALF_X - bbFootprint(mkWorld3d('free', 61).robots[0].spec).front - 16, -30);
      const b = pollen(w, BB_HALF_X - BB_POLLEN_R, -30);
      run3d(w, new Map([[0, cmd({ driveY: 0.7, intake: true })]]), 3);
      check('roller 3d: a POLLEN pinned on a wall is captured, not wedged', b.state.kind === 'held', `state=${b.state.kind}`);
    }

    {
      const { w, r } = stage(62, -40, -30);
      const hl = r.spec.length / 2;
      const hw = r.spec.width / 2;
      const beside = pollen(w, -40, -30 + hw + BB_POLLEN_R + 1.5);
      const behind = pollen(w, -40 - (bbFootprint(r.spec).rear + BB_POLLEN_R + 1.5), -30);
      void hl;
      run3d(w, new Map([[0, cmd({ intake: true })]]), 2);
      check(
        'roller 3d: a parked robot takes nothing from beside or behind its mouths',
        beside.state.kind === 'ground' && behind.state.kind === 'ground' && r.hopper.length === 0,
        `beside=${beside.state.kind} behind=${behind.state.kind} hopper=${r.hopper.length}`,
      );
    }

    {
      const { w, r } = stage(63, -40, -30);
      const cap = r.hopper.length;
      void cap;
      const b0 = pollen(w, -40 + bbFootprint(r.spec).front + BB_POLLEN_R + 0.2, -30);
      // fill the hopper to its cap through the real capture path, then meet one more
      run3d(w, new Map([[0, cmd({ intake: true })]]), 0.5);
      const filler: Artifact[] = [];
      while (r.hopper.length < 4) {
        const f = pollen(w, -40 + bbFootprint(r.spec).front + BB_POLLEN_R + 0.2, -30);
        filler.push(f);
        run3d(w, new Map([[0, cmd({ intake: true })]]), 0.5);
        if (filler.length > 6) break;
      }
      const extra = pollen(w, -40 + bbFootprint(r.spec).front + BB_POLLEN_R + 0.2, -30);
      const x0 = extra.pos.x;
      run3d(w, new Map([[0, cmd({ driveY: 0.6, intake: true })]]), 0.8);
      // NOT `=== 'ground'`: `derive.ts` tags a bouncing element `flight`, and a bulldozed one
      // bounces. What this asserts is that it was never TAKEN, and that it was shoved.
      check(
        'roller 3d: a FULL hopper refuses — the extra POLLEN is pushed, not pulled in',
        b0.state.kind === 'held' && r.hopper.length === 4 && extra.state.kind !== 'held' && extra.pos.x - x0 > 3,
        `first=${b0.state.kind} hopper=${r.hopper.length} extra=${extra.state.kind} pushed=${(extra.pos.x - x0).toFixed(1)}in`,
      );
    }
  }

  // ---- launch into the hive: own cell scores for the owner; the other alliance's for it -----
  //
  // `speed`/`xOffset` are additive parameters (both default to the ORIGINAL fixed values, so
  // every existing call site below is byte-identical) -- the retention lane further down reuses
  // this exact, already-correct entry geometry (staged just outside the mouth, moving inboard
  // along the tray's own v axis) at DISTANCE-SCALED entry speeds instead of re-deriving a
  // full-field ballistic approach, which measurably runs into two things outside this lane's
  // scope: a straight shot from far across the x axis crosses the OPPONENT alliance's own hive
  // frame, and the cell's closed back wall (full height) stops anything approaching from behind
  // the pivot well short of the aim point even on a steep arc -- both real, but ROBOT-AIMING
  // questions (`robot.ts`'s own turret geometry), not hive-tray ones.
  function fireIntoCell(w: World, alliance: 'red' | 'blue', color: Artifact['color'], speed = 55, xOffset = 0): number {
    // the REAL tilt for THIS alliance's hive -- red's up cell is `south` at staging, which is
    // `theta = -rest`, not `+rest`; a hardcoded sign-agnostic angle here was the bug that sent
    // an earlier version of this shot falling to the tiles well short of the cell (see this
    // lane's final report).
    const theta = hiveTiltAngle(w, alliance);
    const sideSign: 1 | -1 = w.biobuzz!.hives[alliance].up === 'north' ? 1 : -1;
    const box = hiveCellLocalBox(sideSign, alliance);
    const wCentre = (box.wMin + box.wMax) / 2;
    const startV = sideSign > 0 ? box.vMax + 2 : box.vMin - 2;
    const start = hiveWorldPoint(alliance, sideSign, theta, xOffset, startV, wCentre);
    const inward = rotate2(-sideSign * speed, 0, theta);
    const id = Math.max(...w.balls.map((b) => b.id)) + 1;
    const shot: Artifact = {
      id,
      color,
      state: { kind: 'flight', target: alliance },
      pos: { x: start.x, y: start.y },
      vel: { x: 0, y: inward.a },
      z: start.z - BB_POLLEN_R,
      vz: inward.b,
    };
    w.balls.push(shot);
    return id;
  }
  {
    const w = mkWorld3d('free', 26);
    const id = fireIntoCell(w, 'blue', 'yellow'); // blue's own up cell (north)
    for (let t = 0; t < 300; t++) step3d(w, 1 / 60, new Map());
    const settled = w.balls.find((b) => b.id === id)!;
    check(
      "launch: an element fired into the alliance's own up cell is in hives.blue.contents after settling",
      w.biobuzz!.hives.blue.contents.includes(id),
      `state=${JSON.stringify(settled.state)} contents=${JSON.stringify(w.biobuzz!.hives.blue.contents)}`,
    );
    const score = bbScoreWorld(w);
    check('launch: bbScoreWorld counts it toward blue (cellCount)', score.blue.cellCount >= 1, `cellCount=${score.blue.cellCount}`);
  }
  {
    const w = mkWorld3dPair('free', 27);
    // red's up cell is its SOUTH side (BB_HIVE_UP_STAGED.red === 'south')
    const id = fireIntoCell(w, 'red', 'yellow'); // red's own up cell (south)
    for (let t = 0; t < 300; t++) step3d(w, 1 / 60, new Map());
    check(
      "launch: an element resting in the OPPONENT's up cell counts for the opponent (realism, then the rulebook)",
      w.biobuzz!.hives.red.contents.includes(id),
      `contents=${JSON.stringify(w.biobuzz!.hives.red.contents)}`,
    );
  }

  // ---- LANE C: A ROBOT'S OWN SOLVED SHOT LANDS IN THE CELL, UNDER 3D PHYSICS -----------------
  //
  // The two checks above stage an element at the mouth on purpose, to keep the tray's own
  // geometry separate from robot aiming. THESE close the other half: no injected artifact, no
  // hand-built velocity -- a real turret build parked on the field, left to aim ITSELF (no button
  // held), then fire held. Owner playtest feedback 2026-09-18 item 4 was "the shooter is not
  // automatically aiming"; this is the 3D end of the measurement that answered it.
  //
  // ONE element in the hopper, deliberately: a full hopper tips the cell and empties it, and a
  // check reading `contents` would then see nothing and call a perfect volley a miss.
  {
    const TURRET_C = { bbMech: { launcher: { kind: 'turret' as const, mount: 'center' as const, hoodDeg: 75 }, lift: null } };
    // out along +y from blue's north cell, which is the side that cell OPENS on
    for (const [x, y] of [[BB_HIVE_X, 53.4], [BB_HIVE_X, 38.4], [BB_HIVE_X + 25, 48.4], [-30, 55]] as const) {
      const w = createBiobuzzWorld('free', 41, [setup(0, 'blue', TURRET_C)], undefined, '3d');
      const r = w.robots[0];
      r.pos.x = x;
      r.pos.y = y;
      r.heading = 0.7;
      r.vel = { x: 0, y: 0 };
      r.hopper.length = 1;
      const shot = r.hopper.length;
      const idle = new Map([[0, cmd({})]]);
      for (let t = 0; t < 90; t++) step3d(w, 1 / 60, idle); // the turret slews onto its solution
      // WHAT THE DRIVER IS SHOWN, on the tick before the trigger (items 5 + 6). The path is
      // predicted with the 2D ballistic model; the flight below is RAPIER 3D. The two agreeing is
      // what makes the preview honest in the 3D view, and it is not free — so it is measured here
      // rather than assumed, in the same worlds that measure the shot.
      const preview = solveShotPath(w, r);
      const fire = new Map([[0, cmd({ fire: true })]]);
      for (let t = 0; t < 60; t++) step3d(w, 1 / 60, fire);
      for (let t = 0; t < 240; t++) step3d(w, 1 / 60, idle); // ...and the flight lands
      const cell = w.biobuzz!.hives.blue;
      const landed = shot === 1 && r.hopper.length === 0 && cell.contents.length >= 4;
      check(
        `aim: a self-aimed turret shot from (${x.toFixed(1)}, ${y}) lands in the own CELL under 3D physics`,
        landed,
        `hopper=${r.hopper.length} contents=${JSON.stringify(cell.contents)} up=${cell.up} tipping=${cell.tipping.toFixed(2)}`,
      );
      check(
        `shot path: ...and the preview promised that shot from (${x.toFixed(1)}, ${y})`,
        preview === landed,
        `preview=${preview} landed=${landed}`,
      );
    }
  }

  // ---- PATH <=> GATE: ONE VERDICT, BY CONSTRUCTION -------------------------------------------
  //
  // ⚠️ Owner, 2026-09-19: "the dotted lines still appear when the shot is not able to be made."
  // The picture and the trigger used to be two different predicates in 3D — the drawn path ran the
  // ballistic landing check and `elements3dAimAndLaunch` gated on ALIGNMENT — so each could say
  // yes while the other said no. They are `bbTurretShotEnters` / `bbDumpShotEnters` (`play.ts`)
  // now, and this sweeps for the one direction that matters: a path DRAWN while the fire gate
  // would refuse to release is a promise about a shot that never happens.
  {
    const TURRET_C = { bbMech: { launcher: { kind: 'turret' as const, mount: 'center' as const, hoodDeg: 75 }, lift: null } };
    let drawn = 0;
    let drawnNoRelease = 0;
    let cases = 0;
    for (const [x, y] of [[BB_HIVE_X, 50], [BB_HIVE_X + 22, 44], [-28, 52], [40, 36], [-55, 30], [BB_HIVE_X, 12]] as const) {
      for (const [vx, vy, wz] of [[0, 0, 0], [55, 0, 0], [-35, 35, 0], [0, 0, 2.2]] as const) {
        for (const up of ['north', 'south'] as const) {
          cases++;
          const w = createBiobuzzWorld('free', 42, [setup(0, 'blue', TURRET_C)], undefined, '3d');
          const r = w.robots[0];
          w.biobuzz!.hives.blue.up = up;
          const idle = new Map([[0, cmd({})]]);
          const hold = (): void => {
            r.pos = { x, y };
            r.heading = 0.4;
            r.vel = { x: vx, y: vy };
            r.angVel = wz;
          };
          hold();
          r.hopper.length = 1;
          for (let t = 0; t < 80; t++) {
            step3d(w, 1 / 60, idle);
            hold(); // the POSE is held; the turret is left to slew
          }
          const path = solveShotPath(w, r);
          const before = r.hopper.length;
          step3d(w, 1 / 60, new Map([[0, cmd({ fire: true })]]));
          const released = r.hopper.length < before;
          if (path) {
            drawn++;
            if (!released) drawnNoRelease++;
          }
        }
      }
    }
    check(
      'shot path: over the pose/velocity/hive grid, a DRAWN path always means the gate fires',
      drawn > 6 && drawnNoRelease === 0,
      `${drawn} drawn of ${cases}, ${drawnNoRelease} with no release`,
    );
  }

  // ---- LANE D: A DUMPER SCORES UNDER 3D PHYSICS ----------------------------------------------
  //
  // ⚠️ **THIS LANE HAD NO DUMPER COVERAGE AT ALL, WHICH IS WHY A DUMPER THAT COULD NOT SCORE
  // SHIPPED.** Every check above fires a TURRET, or stages an element at the cell mouth by hand.
  // A dumper fails in two ways neither of those can see, and both were live in 3D — which is
  // every server-connected match:
  //
  //   (a) its release point is INSIDE its own chassis. `launchLine` releases at
  //       `mountOrigin('back')` (x = −7.50 on a 15-in frame) at `BB_LAUNCH_Z0` = 10, which on the
  //       default `frontback` mount straddles the frame box AND the back mouth lintel — a closed
  //       3-in pocket. A 2D flight element collides with nothing, so 2D never noticed; in 3D all
  //       four elements rose ~2 in, jammed, and rode the chassis. `syncElement`'s `birthClear`
  //       fixes it, along the element's own arc so the solved trajectory survives.
  //   (b) `bbDumpSolution` converges EVERY element on ONE cell-centre point, so a simultaneous
  //       dump is a four-way pile-up in the opening. 3D used to answer that with a STAGGER — one
  //       element every 0.3 s — and the owner replaced the machine instead (2026-09-19): a dumper
  //       is a CATAPULT, one arm, one velocity, the whole bucket in one motion, so the four fly
  //       PARALLEL and keep the bucket's own footprint all the way into the opening
  //       (`bbDumpCluster`, `BB_DUMP_BUCKET`).
  //
  // Measured on the 28-pose tutorial grid (`shoot`, dx 0/3/6/9 in, dy 14..38 in off the cell):
  // 0/28 with the bug, 20/28 staggered, and the catapult is re-measured in this lane's report.
  // The poses that miss are the two closest rows, where the lob clips the HIVE underside; that is
  // the 2026-09-18 CAD ruling's own documented consequence and not this bug, so this lane stands
  // the robot back.
  {
    const DUMPER = { bbMech: { launcher: { kind: 'dumper' as const, mount: 'back' as const, hoodDeg: 45 }, lift: null } };
    /** the element's clearance from every chassis solid of every robot, in inches; < 0 is inside. */
    function chassisGap(w: World, b: Artifact): number {
      let worst = Infinity;
      const radius = b.r ?? BB_POLLEN_R;
      for (const rob of w.robots) {
        const h = rob.spec.heightIn ?? 18;
        const l = rot({ x: b.pos.x - rob.pos.x, y: b.pos.y - rob.pos.y }, -rob.heading);
        const lz = b.z + radius - ((rob.z ?? 0) + h / 2);
        for (const s of chassis3dShapes(rob.spec, h)) {
          const dx = Math.max(Math.abs(l.x - s.cx) - s.hx, 0);
          const dy = Math.max(Math.abs(l.y - s.cy) - s.hy, 0);
          const dz = Math.max(Math.abs(lz - s.cz) - s.hz, 0);
          worst = Math.min(worst, Math.sqrt(dx * dx + dy * dy + dz * dz) - radius);
        }
      }
      return worst;
    }

    // Parked on the open side of blue's up (north) CELL, back edge to the hive, hopper full.
    // Three standoffs across the range the grid says a dumper owns.
    //
    // ⚠️ **26 IN IS THE NEAR END, AND IT IS A MEASUREMENT.** Swept over the 28-pose grid, the
    // catapult puts elements in the CELL from 22 in out (20 poses of 28, the same poses the old
    // stagger reached) but only lands its WHOLE bucket from 26 (16 poses, 70 of 112 elements).
    // At 22 the bottom row's arc clips the HIVE structure below the opening while the top row
    // goes over it — the 2026-09-18 CAD ruling's own documented close-range consequence, pinned
    // on its own below rather than smoothed away here.
    for (const dy of [26, 30, 38]) {
      const w = createBiobuzzWorld('free', 44, [setup(0, 'blue', DUMPER)], undefined, '3d');
      const r = w.robots[0];
      r.pos = { x: BB_HIVE_X, y: BB_HIVE_CELL_DY + dy };
      r.heading = Math.PI / 2; // back edge (−x robot) faces the hive
      r.vel = { x: 0, y: 0 };
      r.angVel = 0;
      const load = r.hopper.length;
      // ONLY THIS ROBOT'S OWN LOAD is measured. `world.balls` also carries the field's elements
      // and the SPILL a tipping cell drops, and both pass through `flight` next to the chassis —
      // counting those would make every number here about somebody else's element.
      const mine = new Set(
        w.balls.filter((b) => b.state.kind === 'held' && b.state.robot === 0).map((b) => b.id),
      );
      const fire = new Map([[0, cmd({ fire: true })]]);
      const born = new Set<number>();
      const pending = new Set<number>();
      const peak = new Map<number, number>();
      let minGap = Infinity;
      let bestPollen = 0;
      const releaseTicks: number[] = [];
      const flungVels: { x: number; y: number; z: number }[] = [];
      let minPair = Infinity;
      let rearm = 0;
      let hopper = load;
      for (let t = 0; t < 420; t++) {
        step3d(w, 1 / 60, fire);
        if (r.hopper.length < hopper) {
          releaseTicks.push(t);
          rearm = r.fireReadyAt - w.time;
          for (const b of w.balls) {
            if (b.state.kind === 'flight' && mine.has(b.id) && !born.has(b.id)) {
              flungVels.push({ x: b.vel.x, y: b.vel.y, z: b.vz ?? 0 });
            }
          }
          hopper = r.hopper.length;
        }
        // the cluster must never close up on itself — measured while it is still IN THE AIR,
        // i.e. above the top of the opening band. Past that they are landing in a box and a pile
        // of four in one cell is the point.
        {
          const air = w.balls.filter(
            (b) => b.state.kind === 'flight' && mine.has(b.id) && (b.z ?? 0) > BB_HIVE_OPEN_Z[1],
          );
          for (let i = 0; i < air.length; i++) {
            for (let j = i + 1; j < air.length; j++) {
              minPair = Math.min(minPair, hyp3(air[i].pos.x - air[j].pos.x, air[i].pos.y - air[j].pos.y, (air[i].z ?? 0) - (air[j].z ?? 0)));
            }
          }
        }
        for (const b of w.balls) {
          if (b.state.kind !== 'flight' || !mine.has(b.id)) continue;
          // ⚠️ MEASURED ONE TICK LATE, ON PURPOSE. `bbLaunch` runs in the GAMEPLAY stage at the
          // end of a tick, so the tick an element first reads `flight` is the tick its JSON was
          // written and BEFORE any body exists for it; `birthClear` runs in the NEXT tick's sync.
          // Sampling the release tick would measure the raw muzzle point, which is inside the
          // chassis by construction and is the thing being fixed rather than the thing to assert.
          if (pending.has(b.id)) {
            minGap = Math.min(minGap, chassisGap(w, b));
            pending.delete(b.id);
          } else if (!born.has(b.id)) pending.add(b.id);
          born.add(b.id);
          peak.set(b.id, Math.max(peak.get(b.id) ?? 0, b.z));
        }
        // LIVE, not at the end: the CELL empties itself when it tips, so a run that scored
        // perfectly reads zero afterwards.
        const kinds = new Map(w.balls.map((b) => [b.id, b.color]));
        bestPollen = Math.max(
          bestPollen,
          w.biobuzz!.hives.blue.contents.filter((id) => kinds.get(id) === 'yellow').length,
        );
      }
      const cell = w.biobuzz!.hives.blue;
      check(
        `dump 3d: a dumper parked ${dy} in off its own CELL empties its hopper`,
        load >= 1 && r.hopper.length === 0 && born.size === load,
        `load=${load} hopper=${r.hopper.length} flew=${born.size}`,
      );
      check(
        `dump 3d: ...and every element is BORN CLEAR of the chassis that threw it (${dy} in)`,
        minGap > 0,
        `worst gap ${minGap === Infinity ? 'n/a' : `${minGap.toFixed(2)}in`}`,
      );
      // THE BUG'S OWN SIGNATURE, and the reason this is a height and not a score: an element born
      // in the pocket apexed at z ≈ 12 and rode the chassis. Reaching the bottom of the opening
      // band means it genuinely flew.
      const apex = Math.min(...[...peak.values()]);
      check(
        `dump 3d: ...and every one of them reaches the CELL opening band (${dy} in)`,
        apex >= BB_HIVE_OPEN_Z[0],
        `lowest apex ${apex.toFixed(1)}in, band starts ${BB_HIVE_OPEN_Z[0].toFixed(1)}in`,
      );
      // ⚠️ ONE FLING, ONE TICK. `r.hopper.length` drops by the whole bucket on a single tick, so
      // a catapult shows up here as ONE entry in `releaseTicks` where the old stagger showed
      // `load` of them 18 ticks apart.
      check(
        `dump 3d: ...flung in ONE motion, not poured (${dy} in)`,
        releaseTicks.length === 1,
        `release ticks=${JSON.stringify(releaseTicks)} load=${load}`,
      );
      // ONE ARM, ONE VELOCITY — which is what makes the cluster unable to collide with itself.
      check(
        `dump 3d: ...every seat leaves on the SAME velocity (${dy} in)`,
        flungVels.length === load &&
          flungVels.every((v) => Math.abs(v.x - flungVels[0].x) < 1e-9 && Math.abs(v.y - flungVels[0].y) < 1e-9 && Math.abs(v.z - flungVels[0].z) < 1e-9),
        `n=${flungVels.length} spread=${flungVels.map((v) => hyp3(v.x - flungVels[0].x, v.y - flungVels[0].y, v.z - flungVels[0].z).toFixed(4)).join('/')}`,
      );
      // ...and no pair of them ever touches on the way. Sum of radii is the bar; the seats are
      // `BB_DUMP_SEAT_PITCH` apart and parallel arcs preserve that exactly.
      check(
        `dump 3d: ...no two elements of the cluster ever touch (${dy} in)`,
        minPair === Infinity || minPair >= BB_DUMP_SEAT_PITCH - 1e-3,
        `closest pair ${minPair === Infinity ? 'n/a' : minPair.toFixed(3)}in, seats ${BB_DUMP_SEAT_PITCH}in`,
      );
      check(
        `dump 3d: ...and the bucket holds at most ${BB_DUMP_BUCKET} (${dy} in)`,
        load <= BB_DUMP_BUCKET,
        `load=${load}`,
      );
      check(
        `dump 3d: ...and re-arms on the full BB_DUMP_RELOAD_S (${dy} in)`,
        Math.abs(rearm - BB_DUMP_RELOAD_S) < 1e-6,
        `${rearm.toFixed(4)}s vs ${BB_DUMP_RELOAD_S}`,
      );
      check(
        `dump 3d: ...and POLLEN lands in blue's own CELL (${dy} in)`,
        bestPollen > 0,
        `most POLLEN held at once=${bestPollen} tips=${cell.tips}`,
      );
    }

    /**
     * ⚠️ THE CLOSE-RANGE LIMIT, STATED AS A NUMBER RATHER THAN AVOIDED. A bucket is 4 in tall, so
     * close in the bottom row cannot clear what the top row clears. This is the honest edge of the
     * catapult's range and it is asserted so that a change which moves it shows up here.
     *
     * ⚠️ **IT MOVED FROM 22 IN TO 24 ON 2026-09-21, AND THE CHECK DID ITS JOB.** The chassis stopped
     * being a floor-to-`heightIn` prism (`chassis3dShapes`), so a lobbed element no longer meets an
     * invisible roof on its way up or lands on one coming down, and a four-ball volley's own
     * in-flight collisions resolve differently at the range where the volley is marginal anyway.
     * MEASURED, same seed, by distance from the cell (`scratch/dumprange.ts`), scored of 4:
     * 18:0/0 · 20:0/0 · **22:1→0** · **24:2→3** · 26:4/4 · 28…42:4/4 either side — the release
     * point is IDENTICAL (10.69 in out, z 14.00, i.e. `birthClear` marches the same distance), so
     * the close edge shifted one step and everything from 26 in out is untouched. The TURRET, which
     * is what the shooter accuracy checks measure, is unchanged-to-better: 72→73, 68→70 and 68→68
     * of 80 over the three-archetype stand sweep (`scratch/shotsweep.ts`), nothing ever unlaunched.
     */
    {
      // ⚠️ THE INTAKE MOUNT IS PINNED TO WHAT THE RANGE TABLE WAS MEASURED ON. The dumper fires
      // over the BACK edge, so a sweeper bolted there is in front of the release — and the table
      // above was taken on a FRONT+BACK build, which was the default preset until 2026-09-22.
      // MEASURED on the new default's front-only sweeper, same seed and stand: 4 of 4 clear at
      // 24 in, i.e. the close limit is a build fact and this fixture states its build rather than
      // inheriting one. (Nothing else moves it: swerve/mecanum and width 16.5/17 all score 4.)
      const w = createBiobuzzWorld('free', 44, [setup(0, 'blue', { ...DUMPER, intakeMount: 'frontback' })], undefined, '3d');
      const r = w.robots[0];
      r.pos = { x: BB_HIVE_X, y: BB_HIVE_CELL_DY + 24 };
      r.heading = Math.PI / 2;
      r.vel = { x: 0, y: 0 };
      r.angVel = 0;
      const mine = new Set(
        w.balls.filter((b) => b.state.kind === 'held' && b.state.robot === 0).map((b) => b.id),
      );
      const load = r.hopper.length;
      const fire = new Map([[0, cmd({ fire: true })]]);
      let best = 0;
      for (let t = 0; t < 300; t++) {
        step3d(w, 1 / 60, fire);
        best = Math.max(best, w.biobuzz!.hives.blue.contents.filter((id) => mine.has(id)).length);
      }
      check(
        'dump 3d: at 24 in the TOP row scores and the BOTTOM row clips — the documented close limit',
        load === 4 && best > 0 && best < load,
        `load=${load} scored=${best}`,
      );
    }

    // ⚠️ THE 2D PIPELINE IS PERMANENT, AND `BbShot.cluster` IS WHAT COULD HAVE BROKEN IT. Nothing
    // in 2D sets the field, so the dumper branch must still throw the WHOLE hopper on ONE tick
    // along its CONVERGING arcs. A shared `launchClearance()` was tried for (a) and reverted for
    // exactly this reason (it took 3D to 3/28 and 2D to 24/28), so the claim is asserted rather
    // than remembered.
    {
      const w = createBiobuzzWorld('free', 44, [setup(0, 'blue', DUMPER)], undefined, '2d');
      const r = w.robots[0];
      r.pos = { x: BB_HIVE_X, y: BB_HIVE_CELL_DY + 30 };
      r.heading = Math.PI / 2;
      r.vel = { x: 0, y: 0 };
      const load = r.hopper.length;
      check('dump 2d: the fixture is really the 2D pipeline', biobuzzPhysics(w) === '2d', biobuzzPhysics(w));
      biobuzzStep(w, 1 / 60, new Map([[0, cmd({ fire: true })]]));
      check(
        'dump 2d: with no cluster flag the WHOLE hopper still leaves on one tick',
        load >= 2 && r.hopper.length === 0,
        `load=${load} → ${r.hopper.length}`,
      );
    }
  }

  // ---- BIRTH CLEARANCE: THE FIELD, AND A CAPTURE-AND-FIRE ON ONE TICK -------------------------
  //
  // Two owner reports, 2026-09-19, and one root shape: a body created or teleported INSIDE a
  // solid, which Rapier's penetration recovery then throws out along whatever normal it finds.
  //
  //   (a) "launching balls from a corner or against a wall sometimes shoots the balls in a
  //       completely different incorrect direction". `birthClear` escapes a chassis by marching
  //       FORWARD along the arc, and it knew about robots only — so a release that started inside
  //       the thrower and pointed at a wall was marched STRAIGHT INTO the wall. Measured with the
  //       field clamp disabled, on a robot flush at each wall with the turret yawed into it: the
  //       birth point ended 2.9-3.8 in past the wall's inner face, and five ticks later the
  //       element was DEAD (|v| = 0, buried) or 136-176° off the heading it was fired at.
  //   (b) "similar incorrect launches happen with the intake collision too — like when I'm
  //       intaking as I'm shooting". Capture and launch run in that order inside ONE gameplay
  //       stage, and `capturePollen` does not remove the body, so an element picked up and fired
  //       on the same tick reached `flight` still owning its ground body — and the guard ran on
  //       body CREATION, so it was skipped and the body was teleported to the muzzle, 7.3 in
  //       inside the chassis. Measured with the guard disabled: a DUMPER's lob apexed at 10.8 in
  //       instead of 63.2, which is `birthClear`'s own 0/28 tutorial-grid failure, back.
  //
  // ⚠️ THE WALL CASE NEEDS MANUAL AIM TO REACH AT ALL, and that is worth knowing before anyone
  // "simplifies" these scenes: Aim Assist only releases a shot its landing gate says will enter
  // the CELL, so no aim-gated shot is ever fired at a wall from point blank. 576 real aim-gated
  // shots flush against all four walls and in all four corners found no birth inside any static
  // (worst turn 8.5°, which is gravity). The manual-aim path is what a driver with the assist off
  // would have, and it is the one that reaches the geometry.
  {
    const TURRET_R = { bbMech: { launcher: { kind: 'turret' as const, mount: 'right' as const, hoodDeg: 75 }, lift: null } };
    const TURRET_M = { bbMech: { launcher: { kind: 'turret' as const, mount: 'center' as const, hoodDeg: 75 }, lift: null } };
    const DUMPER_B = { bbMech: { launcher: { kind: 'dumper' as const, mount: 'back' as const, hoodDeg: 45 }, lift: null } };
    /** LAUNCHED, not merely tagged `flight`: `releasePollen` is the only writer that stamps `by`,
     * and `derive.ts` calls every bouncing ground element `flight` without one. */
    const isLaunched = (b: Artifact): boolean => b.state.kind === 'flight' && b.state.by !== undefined;
    const turnDeg = (a: { x: number; y: number; z: number }, c: { x: number; y: number; z: number }): number => {
      const da = Math.hypot(a.x, a.y, a.z);
      const dc = Math.hypot(c.x, c.y, c.z);
      if (da < 1e-9 || dc < 1e-9) return 180;
      return (Math.acos(Math.min(1, Math.max(-1, (a.x * c.x + a.y * c.y + a.z * c.z) / (da * dc)))) * 180) / Math.PI;
    };
    /** how far INSIDE a chassis solid the element's centre sits (in); 0 = clear. `bbHeightNow`,
     * not `spec.heightIn`: R102's stow is what the collider was actually built to. */
    const chassisDepth = (w: World, b: Artifact): number => {
      const rad = b.r ?? BB_POLLEN_R;
      let worst = 0;
      for (const rob of w.robots) {
        const h = bbHeightNow(w, rob.spec);
        const l = rot({ x: b.pos.x - rob.pos.x, y: b.pos.y - rob.pos.y }, -rob.heading);
        const lz = b.z + rad - ((rob.z ?? 0) + h / 2);
        for (const s of chassis3dShapes(rob.spec, h)) {
          const dx = Math.max(Math.abs(l.x - s.cx) - s.hx, 0);
          const dy = Math.max(Math.abs(l.y - s.cy) - s.hy, 0);
          const dz = Math.max(Math.abs(lz - s.cz) - s.hz, 0);
          worst = Math.max(worst, rad - Math.hypot(dx, dy, dz));
        }
      }
      return worst;
    };
    /** how far the element's sphere reaches PAST a perimeter wall's inner face (in); 0 = inside. */
    const outsideBy = (b: Artifact): number => {
      const rad = b.r ?? BB_POLLEN_R;
      return Math.max(0, Math.abs(b.pos.x) + rad - BB_HALF_X, Math.abs(b.pos.y) + rad - BB_HALF_Y);
    };

    /**
     * Step until this robot fires, then hand back the element AS THE SYNC LEAVES IT.
     *
     * ⚠️ IT SYNCS THE ENGINE ITSELF RATHER THAN STEPPING AGAIN. `releasePollen` writes the launch
     * JSON in the gameplay stage at the END of a tick and `birthClear` runs in the NEXT tick's
     * sync (stage 5) — so a check that stepped once more would be looking at the element a whole
     * solve later, with the nudge already flown off. `syncElements` is that stage, called on its
     * own; the step that follows it in the loop above is what the physical assertions then use.
     */
    const fireAndSync = (
      w: World,
      c: RobotCommand,
      ticks: number,
      before?: () => void,
    ): {
      shot: Artifact | null;
      v0: { x: number; y: number; z: number };
      pos0: { x: number; y: number; z: number };
      bodyAtLaunch: unknown;
    } => {
      const cmds = new Map([[0, c]]);
      const had = new Map<number, boolean>();
      for (const b of w.balls) had.set(b.id, isLaunched(b));
      for (let t = 0; t < ticks; t++) {
        before?.();
        step3d(w, 1 / 60, cmds);
        for (const b of w.balls) {
          const now = isLaunched(b);
          const was = had.get(b.id) ?? false;
          had.set(b.id, now);
          if (!now || was) continue;
          const v0 = { x: b.vel.x, y: b.vel.y, z: b.vz };
          const pos0 = { x: b.pos.x, y: b.pos.y, z: b.z };
          const bodyAtLaunch = engineFor(w).elements.get(b.id);
          syncElements(w, engineFor(w));
          return { shot: b, v0, pos0, bodyAtLaunch };
        }
      }
      return { shot: null, v0: { x: 0, y: 0, z: 0 }, pos0: { x: 0, y: 0, z: 0 }, bodyAtLaunch: undefined };
    };

    // (a) POINT BLANK INTO EACH WALL AND TWO CORNERS, ON MANUAL AIM.
    const flush = BB_HALF_X - bbFootprint(bbCoerce({})).half; // a FLANK is flush at its half-width
    for (const [nm, px, py, heading, yaw] of [
      ['+x', flush, 0, Math.PI / 2, 0],
      ['-x', -flush, 0, -Math.PI / 2, Math.PI],
      ['+y', 0, flush, 0, Math.PI / 2],
      ['-y', 0, -flush, 0, -Math.PI / 2],
      ['+x+y corner', flush, flush, Math.PI / 2, Math.PI / 4],
      ['-x-y corner', -flush, -flush, -Math.PI / 2, (-3 * Math.PI) / 4],
    ] as const) {
      for (const pitch of [0, 0.9]) {
        const w = createBiobuzzWorld('free', 41, [setup(0, 'blue', TURRET_R)], undefined, '3d');
        const r = w.robots[0];
        r.pos = { x: px, y: py };
        r.heading = heading;
        r.vel = { x: 0, y: 0 };
        r.angVel = 0;
        r.hopper.length = 2;
        const { shot, v0 } = fireAndSync(w, cmd({ fire: true }), 90, () => {
          // MANUAL AIM, re-asserted every tick: `coerceAssists` forces the flag on (the menu
          // toggle is gone), so a test sets it on the spawned robot — its own comment says so —
          // and stage 5b slews the turret back toward the hive on every tick, so the yaw and
          // pitch have to be re-held or this stops being a shot at the wall.
          r.aimAssist = false;
          r.turretHeading = yaw;
          r.bbTurretPitch = pitch;
        });
        check(`wall birth: a point-blank shot into the ${nm} wall fires (pitch ${pitch})`, shot !== null);
        if (!shot) continue;
        check(
          `wall birth: ...and is born INSIDE the field, not in the wall (${nm}, pitch ${pitch})`,
          outsideBy(shot) <= 0,
          `past the face by ${outsideBy(shot).toFixed(2)}in at (${shot.pos.x.toFixed(1)}, ${shot.pos.y.toFixed(1)})`,
        );
        // THE VELOCITY IS THE SHOT'S OWN. A static is escaped by MOVING the birth point, never by
        // rewriting the solved velocity — that is what makes the next step an honest wall bounce
        // at the speed it was fired at. (`vz` may be advanced by the arc march, and only by it:
        // `g·dt` over at most `BB3_LAUNCH_CLEAR_MAX` of path.)
        check(
          `wall birth: ...with the planar velocity it was solved with (${nm}, pitch ${pitch})`,
          Math.abs(shot.vel.x - v0.x) < 1e-9 && Math.abs(shot.vel.y - v0.y) < 1e-9 && shot.vz <= v0.z + 1e-9,
          `v0=(${v0.x.toFixed(1)}, ${v0.y.toFixed(1)}, ${v0.z.toFixed(1)}) born=(${shot.vel.x.toFixed(1)}, ${shot.vel.y.toFixed(1)}, ${shot.vz.toFixed(1)})`,
        );
      }
    }

    // (b) OUT OF A CORNER, aim-gated — the production path, and the regression guard for the
    //     whole area: a corner shot must leave along the arc it was solved onto.
    {
      const w = createBiobuzzWorld('free', 41, [setup(0, 'blue', TURRET_M)], undefined, '3d');
      const r = w.robots[0];
      r.pos = { x: -flush, y: -flush };
      r.heading = Math.PI / 4;
      r.vel = { x: 0, y: 0 };
      r.hopper.length = 2;
      for (let t = 0; t < 120; t++) step3d(w, 1 / 60, new Map([[0, cmd({})]])); // the turret slews on
      const { shot, v0 } = fireAndSync(w, cmd({ fire: true }), 120);
      check('corner: a robot parked in a corner fires at its own CELL', shot !== null);
      if (shot) {
        const id = shot.id;
        for (let t = 0; t < 5; t++) step3d(w, 1 / 60, new Map());
        const b = w.balls.find((x) => x.id === id)!;
        const turn = turnDeg(v0, { x: b.vel.x, y: b.vel.y, z: b.vz });
        check('corner: ...and the element leaves along the heading it was fired at', turn < 12, `${turn.toFixed(1)}deg in 5 ticks`);
        check(
          'corner: ...without gaining speed on the way out',
          Math.hypot(b.vel.x, b.vel.y, b.vz) <= Math.hypot(v0.x, v0.y, v0.z) + 1,
          `${Math.hypot(b.vel.x, b.vel.y, b.vz).toFixed(0)} vs ${Math.hypot(v0.x, v0.y, v0.z).toFixed(0)} in/s`,
        );
      }
    }

    // (c) CAPTURE AND FIRE ON ONE TICK, for both archetypes.
    for (const [kind, spec] of [
      ['dumper', DUMPER_B],
      ['turret', TURRET_M],
    ] as const) {
      const w = createBiobuzzWorld('free', 44, [setup(0, 'blue', spec)], undefined, '3d');
      const r = w.robots[0];
      r.pos = { x: BB_HIVE_X, y: BB_HIVE_CELL_DY + 26 };
      r.heading = Math.PI / 2; // the dumper's back edge — its firing edge — faces the cell
      r.vel = { x: 0, y: 0 };
      r.angVel = 0;
      // EMPTY THE HOPPER, held elements and all: the only element this robot can fire is one it
      // picks up, so the launch is forced to take the element captured on that same tick.
      for (let i = w.balls.length - 1; i >= 0; i--) {
        const st = w.balls[i].state;
        if (st.kind === 'held' && st.robot === 0) w.balls.splice(i, 1);
      }
      r.hopper.length = 0;
      for (let t = 0; t < 120; t++) step3d(w, 1 / 60, new Map([[0, cmd({})]]));
      // one POLLEN sitting in the intake mouth
      const mouth = bbMouths(r.spec).find((m) => m.edge === 'front')!;
      const lp = rot({ x: (mouth.x0 + mouth.x1) / 2, y: 0 }, r.heading);
      const fedId = Math.max(...w.balls.map((b) => b.id)) + 1;
      w.balls.push({
        id: fedId,
        color: 'yellow',
        state: { kind: 'ground' },
        pos: { x: r.pos.x + lp.x, y: r.pos.y + lp.y },
        z: 0,
        vel: { x: 0, y: 0 },
        vz: 0,
      });
      const { shot, v0, pos0, bodyAtLaunch } = fireAndSync(w, cmd({ intake: true, fire: true }), 120, () => {
        // HOLD THE CADENCE CLOCK OPEN so the capture tick is also a fire tick. It is the state
        // the launcher is in every `BB_FIRE_INTERVAL` anyway; without it whether the two land on
        // the same tick is a coin flip on phase, which is exactly why the bug read as "sometimes".
        r.fireReadyAt = w.time;
      });
      check(`capture+fire (${kind}): the element picked up this tick is the one fired`, shot !== null && shot.id === fedId, `shot=${shot?.id ?? 'none'} fed=${fedId}`);
      if (!shot) continue;
      check(
        `capture+fire (${kind}): ...its ground body does not survive into its own flight`,
        bodyAtLaunch !== undefined && engineFor(w).elements.get(fedId) !== bodyAtLaunch,
        bodyAtLaunch === undefined ? 'no body at launch — the scene is not testing the gap' : 'the sync rebuilt the body',
      );
      check(
        `capture+fire (${kind}): ...and it is born CLEAR of the chassis that threw it`,
        chassisDepth(w, shot) <= 0,
        `${chassisDepth(w, shot).toFixed(2)}in inside, moved ${Math.hypot(shot.pos.x - pos0.x, shot.pos.y - pos0.y, shot.z - pos0.z).toFixed(2)}in`,
      );
      for (let t = 0; t < 5; t++) step3d(w, 1 / 60, new Map());
      const flown = w.balls.find((x) => x.id === fedId)!;
      const turn = turnDeg(v0, { x: flown.vel.x, y: flown.vel.y, z: flown.vz });
      check(`capture+fire (${kind}): ...and leaves along the arc it was fired on`, turn < 12, `${turn.toFixed(1)}deg in 5 ticks`);
      let apex = flown.z;
      for (let t = 0; t < 120; t++) {
        step3d(w, 1 / 60, new Map());
        const bb = w.balls.find((x) => x.id === fedId);
        if (bb) apex = Math.max(apex, bb.z);
      }
      // THE SIGNATURE, and the one a dumper fails loudest: an element born inside the chassis
      // rides it at z ~ 11 instead of flying. Same landmark `dump 3d` uses.
      check(
        `capture+fire (${kind}): ...and reaches the CELL opening band`,
        apex >= BB_HIVE_OPEN_Z[0],
        `apex ${apex.toFixed(1)}in, band starts ${BB_HIVE_OPEN_Z[0].toFixed(1)}in`,
      );
    }
  }

  // ---- height clearance under the down cell, against the CAD's OWN measured clearance --------
  {
    const theta = Math.PI / 6;
    // the reference landmark is the CAD tray's OWN floor hull for the down cell (whatever local
    // height the one rigid CAD shape actually puts it at), not the Day 1 algebraic bracket
    // calibrated to 25.5in by hand -- see `hiveCellLocalBox`'s and `buildHiveTray3d`'s comments
    // on dropping that bracket once the CAD hulls give the real clearance.
    //
    // THE WORST-CASE (LOWEST) CORNER ALONG THE DOWN CELL'S OWN v-SPAN, not its midpoint -- a
    // robot driving THROUGH the down cell crosses the whole span, so the binding obstruction is
    // whichever end sits lower, and a robot's actual headroom is set by the LOWER of the two,
    // not their average. It measures 31.98, which is `BB_HIVE_BOTTOM_Z` itself: since the
    // 2026-09-18 ruling that constant IS the CAD's own down-cell floor, so the landmark and the
    // constant are the same number by construction rather than by coincidence.
    const downBox = hiveCellLocalBox(-1, 'blue');
    const cornerOuter = hiveWorldPoint('blue', -1, theta, 0, downBox.vMin, downBox.wMin);
    const cornerInner = hiveWorldPoint('blue', -1, theta, 0, downBox.vMax, downBox.wMin);
    const bracket = cornerOuter.z <= cornerInner.z ? cornerOuter : cornerInner;
    // ⚠️ THIS USED TO BE A DISAGREEMENT AND IS NOT ANY MORE. The CAD's down-cell clearance
    // (bracket.z) did not match the manual's BB_HIVE_BOTTOM_Z of 25.5, and the gap was the story:
    // one rigid tilting bar cannot put the up-cell opening at BB_HIVE_OPEN_Z and the down-cell
    // floor at 25.5 at the same time on this hive's own measured dimensions. The owner ruled the
    // CAD authoritative on 2026-09-18, so BB_HIVE_BOTTOM_Z IS 31.981 and the two agree. The
    // MEASUREMENTS check below asserts that strictly; this test asserts what the built collider
    // does about robots.
    //
    // ⚠️ THIS NUMBER HAS MOVED BEFORE, WHEN `obliqueBoxCollider` (`sim3d/bodies.ts`) FIXED
    // THE HIVE-TILT BUG THE OWNER PLAYTEST REPORTED ("visually tilted more than where the balls
    // end up", "spill out too easily"): the CAD box's `vMin..wMax` are captured AT the tray's
    // OWN tilt, and the PRE-FIX code built an axis-aligned collider straight from them with NO
    // rotation baked in, which is exactly flat (untilted) in world space the instant the body's
    // own kinematic rotation is 0 -- which is AT REST, the one moment the tilt matters most. That
    // bug flattened BOTH cells: the up cell's floor read the same world z at its inner and outer
    // edge (no slope to hold a landed element against the divider -- the actual GAMEPLAY bug),
    // and the down cell's clearance came out ~32in, comfortably over `BB3_HEIGHT_MAX` (29),
    // purely because the true CAD tilt was never applied to it either. The fix makes BOTH cells
    // genuinely tilted at rest. What the correctly-tilted CAD tray then says is 31.98 -- ABOVE
    // BB3_HEIGHT_MAX (29) -- so a legal max-height robot DOES clear the down cell, which is what
    // G409's drive-under assumes and what the measurements check asserts against the lowest hive
    // structure of any kind (the Goal Rib, 30.65). The third check below is the non-vacuity
    // proof: at 34.98in the same robot IS stopped, so the collider is real and not a no-op.
    function driveAtBracket(heightIn: number): number {
      const w = mkWorld3d('free', 28);
      const r = w.robots[0];
      // set directly on the coerced spec, bypassing `coerceSpec` -- this test wants an exact
      // heightIn without depending on `BB3_HEIGHT_MIN`/`MAX` clamping it, and `coerceSpec`'s
      // own heightIn carry-across (the fix for the `heightIn` seam bug this lane's final
      // report describes) is exercised separately by the `heightIn:` checks above.
      r.spec = { ...r.spec, heightIn };
      // ⚠️ 30, NOT 40, AND THE FLOWER IS WHY (Day 2 lane A). `bracket.y` is −17.79, so a 40-in
      // run-up starts the robot at y = −57.79 — and its collider is `robotExtents` (the 2D
      // solve's footprint, intake reach included, 12 in behind the centre), so its rear corner
      // sat at y = −69.79, INSIDE flower F4's own on-tile footprint (x 20.42…26.37,
      // y −70.64…−65.63). It always did: the pipes' hulls were already touching it at tick 0,
      // and this check passed anyway because a vertical hull is something a robot slides along.
      // The ring PLATES are horizontal, so the same overlap became a 0.354-in step the robot
      // CLIMBED — measured, z rose to 0.337 in ten ticks and the run never recovered, stopping
      // 5.5 in short of the hive. The obstacle is real and correctly placed (the plate rect IS
      // `BB_FLOWER_FOOT`, the same box the 2D collider set uses); the START POSE was the bug.
      // 30 in of run-up clears F4 by 3.8 in and still reaches 80 in/s well before the hive.
      const startY = bracket.y - 30;
      r.pos.x = bracket.x;
      r.pos.y = startY;
      r.heading = Math.atan2(bracket.y - startY, bracket.x - r.pos.x);
      r.vel.x = 0;
      r.vel.y = 0;
      const forward = cmd({ driveY: 1 });
      for (let t = 0; t < 180; t++) step3d(w, 1 / 60, new Map([[0, forward]]));
      return w.robots[0].pos.y;
    }
    const y18 = driveAtBracket(18);
    const y29 = driveAtBracket(29);
    // a height comfortably PAST the CAD's own measured clearance (bracket.z - the pivot height,
    // in `hiveCellLocalBox`'s frame this is just `bracket.z` itself since chassis bottom sits at
    // z 0) -- an illegal height for a real robot, but the point of this check is proving the
    // collider is a REAL, working obstruction, not testing a legal build.
    /**
     * ⚠️ **THE NON-VACUITY PROOF IS A SHAPE QUERY NOW, NOT A 34.98-IN ROBOT** (2026-09-21, the
     * ONE rule that depended on the chassis being a floor-to-`heightIn` PRISM). It used to drive
     * an illegally tall robot at the tray and assert it was stopped — which worked only because
     * `heightIn` extruded the whole footprint. The compound tops out at the DRAWN robot now
     * (`chassis3dShapes`), so no build of any declared height is 32 in tall anywhere and nothing
     * a robot can do proves this collider exists.
     *
     * So the proof is made directly and is STRONGER for it: a chassis-sized box placed at the
     * bracket, spanning the band the old prism's roof reached, overlaps a FIXED collider — the
     * same free shape query `bbRampSwingStep3d` uses for its own guard. If the tray ever stopped
     * being solid there, this fails, and it no longer depends on a robot shape that does not
     * exist. The drive-under checks above stay exactly as they were.
     */
    const legacyRoof = bracket.z + 3;
    check(
      'height: an 18-in robot drives past the down-cell clearance point',
      y18 > bracket.y + 5,
      `18in final y=${y18.toFixed(2)}, bracket y=${bracket.y.toFixed(2)}`,
    );
    check(
      'height: a 29-in (R105.A max) robot CLEARS the down cell -- the CAD tray puts its floor at ' +
        `BB_HIVE_BOTTOM_Z ${BB_HIVE_BOTTOM_Z}, above R105.A's 29`,
      y29 > bracket.y + 5,
      `29in final y=${y29.toFixed(2)}, bracket y=${bracket.y.toFixed(2)}, clearance z=${bracket.z.toFixed(2)}`,
    );
    {
      const RAPIER = rapier3d();
      const w = mkWorld3d('free', 28);
      step3d(w, 1 / 60, new Map());
      const e = engineFor(w);
      const spec = w.robots[0].spec;
      const box = new RAPIER.Cuboid(spec.length / 2, spec.width / 2, 1.5);
      const anyFixedAt = (z: number): boolean => {
        let hit = false;
        e.world3d.intersectionsWithShape(
          { x: bracket.x, y: bracket.y, z },
          { x: 0, y: 0, z: 0, w: 1 },
          box,
          () => {
            hit = true;
            return false;
          },
        );
        return hit;
      };
      // ...and the CONTROL: the same box at the height a legal robot's own drawn roof reaches
      // finds nothing, which is the drive-under the two checks above measure.
      const hit = anyFixedAt(legacyRoof - 1.5);
      const clear = anyFixedAt(29 - 1.5);
      check(
        'height: the down-cell clearance collider is REAL — a chassis-sized box at the old prism roof overlaps it, and the same box at R105.A’s 29 in does not',
        hit && !clear,
        `at ${legacyRoof.toFixed(2)}in hit=${hit}, at 29in hit=${clear}`,
      );
      disposeEngineFor(w);
    }
  }

  // ---- tip: a preloaded up cell trips the shared timer, the tray swings, contents empty ----
  {
    const w = mkWorld3d('free', 29);
    const theta = Math.PI / 6;
    let nextId = Math.max(...w.balls.map((b) => b.id)) + 1;
    const placedIds: number[] = [];
    const n = BB_TIP_POLLEN[0] + 1; // one over the 0-nectar threshold (8) -- guaranteed to tip
    for (let i = 0; i < n; i++) {
      const box = hiveCellLocalBox(1, 'blue');
      const v = box.vMin + 2 + (i % 4) * 2.2;
      const x = -6 + Math.floor(i / 4) * 4;
      const w0 = box.wMin + BB_POLLEN_R + 0.3;
      const p = hiveWorldPoint('blue', 1, theta, x, v, w0);
      const id = nextId++;
      placedIds.push(id);
      w.balls.push({
        id,
        color: 'yellow',
        state: { kind: 'ground' },
        pos: { x: p.x, y: p.y },
        vel: { x: 0, y: 0 },
        z: p.z - BB_POLLEN_R,
        vz: 0,
      });
    }
    // let the pile settle and derive tag it into the cell (BB3_REST_TICKS worth, generously).
    let tipTick = -1;
    for (let t = 0; t < 600 && tipTick < 0; t++) {
      step3d(w, 1 / 60, new Map());
      if (w.biobuzz!.hives.blue.tipping > 0 || w.biobuzz!.hives.blue.up !== 'north') tipTick = t;
    }
    check('tip: the shared timer trips once the up cell is loaded past its threshold', tipTick >= 0, `never tripped by tick 600`);
    // run past the whole swing (4s = 240 ticks) plus slack, then check every placed id has left
    // the cell and the tray flipped.
    for (let t = 0; t < 300; t++) step3d(w, 1 / 60, new Map());
    check('tip: the tray completed its swing (up flipped to south)', w.biobuzz!.hives.blue.up === 'south');
    const stillIn = placedIds.filter((id) => w.biobuzz!.hives.blue.contents.includes(id));
    check('tip: every previously-contained element left the cell', stillIn.length === 0, `${stillIn.length} still listed: ${JSON.stringify(stillIn)}`);
    check('tip: the up cell reads empty after the swing', w.biobuzz!.hives.blue.contents.length === 0);
    check('tip: element count is unchanged (56 + the ones this check added)', w.balls.length === 56 + n);
  }

  // ---- rest-pose: the tray's tilt convention, per alliance -- the hive-tilt fix itself --------
  //
  // The owner's playtest reported two hive bugs: the SCENE visually tilts more than where balls
  // end up, and landed elements spill out too easily. Both traced to ONE bug in the CAD-collider
  // path: `hiveCellLocalBox`'s `vMin..wMax` are captured AT the tray's own tilt (`refTheta`), and
  // the PRE-FIX code built an axis-aligned collider straight from those numbers with no further
  // rotation baked in -- exactly FLAT (untilted) in world space the instant the body's own
  // kinematic rotation (`hiveTiltAngle - hiveTrayRefTheta`) is 0, which is AT REST, the one moment
  // the tilt matters most. `obliqueBoxCollider` (`sim3d/bodies.ts`) fixes it by baking `refTheta`
  // into the collider's own geometry (a FIXED Rapier collider-local rotation, set once at
  // creation -- never a live `setNextKinematicRotation` on the collider itself, which is the
  // documented, measured source of an earlier attempt's kinematic instability). These checks
  // assert the fixed geometry directly, so a regression here fails loudly rather than only
  // showing up as a gameplay symptom three steps removed. Worked example, both alliances, per
  // `BB_HIVE_UP_STAGED`: red's up cell is `south` (theta = -30deg at rest), blue's is `north`
  // (theta = +30deg) -- `hiveTiltAngle`'s own JSDoc carries the same two cases.
  for (const a of ['red', 'blue'] as const) {
    const w = mkWorld3d('free', a === 'red' ? 460 : 461);
    step3d(w, 1 / 60, new Map()); // one tick: builds the engine and runs applyHiveTilt once
    const theta = hiveTiltAngle(w, a);
    const refTheta = hiveTrayRefTheta(a);
    const rest = (a === 'red' ? -1 : 1) * (Math.PI / 6); // BB_HIVE_UP_STAGED: red south up, blue north up
    // ⚠️ AND THE CAD'S OWN `refTheta` IS READ HERE, not only the constant. `hiveTrayRefTheta`
    // lives in the LIGHT `sim3d/tilt.ts` now (the 3D scene subtracts it on a frame where no 3D
    // physics is loaded, so it may not touch the CAD collider set) and returns a plain 0. That is
    // only true as long as the export really is un-tilted, which is what `cadTrayRefTheta` says —
    // so this check is what keeps the two in step. A future field revision exported at some other
    // pose fails HERE, loudly, instead of silently drawing the tray at double its tilt.
    check(
      `rest-pose: ${a}'s exported tray needs NO reference-angle correction (refTheta === 0)`,
      refTheta === 0 && cadTrayRefTheta(a) === refTheta,
      `refTheta=${refTheta} cad=${cadTrayRefTheta(a)}`,
    );
    check(
      `rest-pose: ${a}'s hive body rotation IS the absolute tilt at rest (CAD colliders on; up='${w.biobuzz!.hives[a].up}')`,
      // 1e-4, NOT 1e-9, SINCE DAY 2, AND THE TOLERANCE IS THE POINT RATHER THAN A CONCESSION.
      // Under the DYNAMIC tray `hiveTiltAngle` no longer computes an angle, it READS ONE BACK:
      // `hives[a].angle`, written by the readback at `BB3_ROUND` like every other solved number,
      // because "the JSON is the truth" is what makes a snapshot, a replay and a prediction world
      // seat the tray identically. A rounded number cannot agree to 1e-9 with an exact one, and
      // demanding that it does would be demanding that the tray's pose NOT be serialised.
      // (On the kinematic path the value is still the timer's own exact formula and the residual
      // is 0, so this tolerance costs that path nothing.)
      Math.abs(theta - refTheta - rest) <= BB3_ROUND,
      `theta - refTheta=${(theta - refTheta).toFixed(6)} expected=${rest.toFixed(6)}`,
    );
    const upSide: 1 | -1 = w.biobuzz!.hives[a].up === 'north' ? 1 : -1;
    const box = hiveCellLocalBox(upSide, a);
    // the OUTER (open/mouth) end of the cell is whichever v-extreme sits farther from the pivot
    const outerV = Math.abs(box.vMax) > Math.abs(box.vMin) ? box.vMax : box.vMin;
    const innerV = outerV === box.vMax ? box.vMin : box.vMax;
    const outerZ = BB3_HIVE_PIVOT_Z + rotate2(outerV, box.wMin, theta).b;
    const innerZ = BB3_HIVE_PIVOT_Z + rotate2(innerV, box.wMin, theta).b;
    check(
      `rest-pose: ${a}'s up cell (${w.biobuzz!.hives[a].up}) floor slopes DOWN toward the divider -- the open (mouth) edge reads HIGHER than the inner (divider) wall base`,
      outerZ > innerZ,
      `outer(mouth) z=${outerZ.toFixed(2)} inner(divider) z=${innerZ.toFixed(2)}`,
    );
  }

  // ---- retention: realistic shots at typical distances stay in the up cell ------------------
  //
  // A shot fired along `fireIntoCell`'s own (already-correct) entry geometry, at the entry speed
  // a REAL turret shot would carry from `d` inches out (`bbSolveShot`, `robot.ts`, zero elevation
  // gain: `sqrt(g*d)`) -- see `fireIntoCell`'s own header for why a full-field ballistic
  // reproduction from an actual muzzle position is a ROBOT-AIMING question (crosses the opponent's
  // hive frame; the cell's own closed back wall stops an approach from behind the pivot), not a
  // hive-tray one, and is deliberately not what this measures. Retention under ~90% at any of
  // these distances is the owner-reported "spills out too easily" bug; the fix
  // (`obliqueBoxCollider`'s true incline, the tray's restitution now governing under a `Min`
  // combine rule) measures 100% at all three.
  for (const d of [24, 48, 72]) {
    const speed = bbSolveShot(d, 0).speed;
    let retained = 0;
    const total = 20;
    for (let shot = 0; shot < total; shot++) {
      const w = mkWorld3d('free', 470 + shot);
      w.balls.length = 0; // isolate: only this one shot's element exists
      const xJitter = ((shot % 5) - 2) * 3; // deterministic spread across the mouth's own width
      const id = fireIntoCell(w, 'blue', 'yellow', speed, xJitter);
      for (let t = 0; t < 300; t++) step3d(w, 1 / 60, new Map());
      if (w.biobuzz!.hives.blue.contents.includes(id)) retained++;
    }
    check(
      `retention: a ${d}in shot (entry speed ${speed.toFixed(0)}in/s) into the own up cell stays put -- >= 90% of ${total}`,
      retained / total >= 0.9,
      `${retained}/${total} retained`,
    );
  }

  // ---- load table: what tips and what doesn't, and no spill before the tip ------------------
  //
  // The manual's own load table (Event Field Setup Guide §12.3, `config.ts`'s `BB_TIP_POLLEN`):
  // 8 pollen tips, 7 does not; 3 pollen + 3 nectar tips, 3 + 2 does not. Each row runs 10s (600
  // ticks) so a tipping tray completes its whole swing and a non-tipping one proves it never
  // starts one -- this is the OTHER half of the owner's "spills out too easily" report: a load
  // UNDER the table's threshold must not spill either, which the pre-fix flat floor (no downhill
  // slope holding anything against the divider) put at real risk.
  {
    function loadCell(pollen: number, nectar: number): { tipped: boolean; stillIn: number; tripLoad: string } {
      const w = mkWorld3d('free', 480 + pollen * 10 + nectar);
      w.balls.length = 0; // isolate: only this row's elements exist
      const alliance = 'blue' as const;
      const theta = hiveTiltAngle(w, alliance);
      const sideSign: 1 | -1 = w.biobuzz!.hives[alliance].up === 'north' ? 1 : -1;
      const box = hiveCellLocalBox(sideSign, alliance);
      const n = pollen + nectar;
      const cols = 4;
      const wLocal = box.wMin + BB_POLLEN_R + 0.5; // one row, a small (x, v) grid; physics stacks
      const ids: number[] = [];
      for (let i = 0; i < n; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = (col - (cols - 1) / 2) * 4;
        const v = box.vMin + 2 + row * 3;
        const p = hiveWorldPoint(alliance, sideSign, theta, x, v, wLocal);
        const id = i + 1;
        ids.push(id);
        const el: Artifact = {
          id,
          color: i < pollen ? 'yellow' : 'blue',
          state: { kind: 'ground' },
          pos: { x: p.x, y: p.y },
          vel: { x: 0, y: 0 },
          z: p.z - BB_POLLEN_R,
          vz: 0,
        };
        w.balls.push(el);
      }
      const startUp = w.biobuzz!.hives[alliance].up;
      let tripLoad = '';
      for (let t = 0; t < 600; t++) {
        step3d(w, 1 / 60, new Map());
        if (tripLoad === '' && w.biobuzz!.hives[alliance].tipping > 0) {
          tripLoad = `${w.biobuzz!.hives[alliance].contents.length} elements`;
        }
      }
      const tipped = w.biobuzz!.hives[alliance].up !== startUp;
      const stillIn = ids.filter((id) => w.biobuzz!.hives[alliance].contents.includes(id)).length;
      return { tipped, stillIn, tripLoad };
    }

    const rows: readonly [number, number, boolean][] = [
      [3, 0, false],
      [7, 0, false],
      [8, 0, true],
      [3, 2, false],
      [3, 3, true],
    ];
    for (const [pollen, nectar, expectTip] of rows) {
      const r = loadCell(pollen, nectar);
      const label = `${pollen}p+${nectar}n`;
      console.log(`[smoke-bb sim3d] load table: ${label} tipped=${r.tipped} trip-load=${r.tripLoad || 'n/a'}`);
      check(`load table: ${label} ${expectTip ? 'TIPS' : 'does NOT tip'} (manual, BB_TIP_POLLEN)`, r.tipped === expectTip, `tipped=${r.tipped}`);
      if (expectTip) {
        check(`load table: ${label} -- every element left the (now down) cell within the swing`, r.stillIn === 0, `${r.stillIn} still in`);
      } else {
        check(
          `load table: ${label} -- every element stayed for 10s, nothing spilled, tray did not move`,
          r.stillIn === pollen + nectar,
          `${r.stillIn}/${pollen + nectar} stayed`,
        );
      }
    }
  }

  // ---- kinematic inertness: a resting element is not kicked by an unchanged tray rotation ----
  //
  // `applyHiveTilt` (`engine.ts`) calls `setNextKinematicRotation` every tick, unconditionally,
  // including on a settled tray whose angle has not changed since the last tick. A resting
  // element's velocity must stay EXACTLY 0 through that -- confirming Rapier is inert on a
  // repeated, unchanged kinematic target rather than re-waking or perturbing the body underneath.
  {
    const w = mkWorld3d('free', 490);
    w.balls.length = 0;
    const alliance = 'blue' as const;
    const theta = hiveTiltAngle(w, alliance);
    const sideSign: 1 | -1 = w.biobuzz!.hives[alliance].up === 'north' ? 1 : -1;
    const box = hiveCellLocalBox(sideSign, alliance);
    const wLocal = box.wMin + BB_POLLEN_R + 0.5;
    const ids = [1, 2, 3];
    for (const [i, id] of ids.entries()) {
      const p = hiveWorldPoint(alliance, sideSign, theta, (i - 1) * 4, box.vMin + 2, wLocal);
      const el: Artifact = {
        id,
        color: 'yellow',
        state: { kind: 'ground' },
        pos: { x: p.x, y: p.y },
        vel: { x: 0, y: 0 },
        z: p.z - BB_POLLEN_R,
        vz: 0,
      };
      w.balls.push(el);
    }
    for (let t = 0; t < 60; t++) step3d(w, 1 / 60, new Map()); // settle + tag into the cell
    const settledIn = ids.filter((id) => w.biobuzz!.hives[alliance].contents.includes(id)).length;
    let maxSpeed = 0;
    for (let t = 0; t < 600; t++) {
      step3d(w, 1 / 60, new Map());
      for (const id of ids) {
        const b = w.balls.find((x) => x.id === id);
        if (!b) continue;
        const speed = Math.sqrt(b.vel.x * b.vel.x + b.vel.y * b.vel.y + b.vz * b.vz);
        if (speed > maxSpeed) maxSpeed = speed;
      }
    }
    check('kinematic inertness: 3 staged elements settle into the up cell', settledIn === 3, `${settledIn}/3`);
    check(
      'kinematic inertness: a resting element stays at exactly 0 velocity over 600 further ticks of an unchanged tray target',
      maxSpeed === 0,
      `max speed observed ${maxSpeed}`,
    );
  }

  // ---- twelve-probe agreement: the CAD colliders vs the Day 1 fallback, same world ---------
  //
  // `__setFieldCollidersOverrideForTests` (`sim3d/bodies.ts`) forces every CAD-vs-fallback
  // branch in `buildStatics3d`/`hiveCellLocalBox` to one side regardless of `BB3_FIELD_
  // COLLIDERS`, so two engines can be built from the SAME staged world -- one CAD, one
  // fallback -- and compared directly. `world3d.projectPoint(p, false)` gives the nearest
  // collider surface REGARDLESS of which side of it `p` sits on, so "distance to nearest
  // static" is well-defined even for a probe that ends up just inside one engine's geometry.
  {
    function builtEngine(cadOn: boolean, seed: number) {
      __setFieldCollidersOverrideForTests(cadOn);
      try {
        const w = mkWorld3d('free', seed);
        step3d(w, 1 / 60, new Map()); // settle the kinematic tray's REAL rotation once
        return engineFor(w);
      } finally {
        __setFieldCollidersOverrideForTests(null); // never left set -- see that function's header
      }
    }
    const cad = builtEngine(true, 40);
    const fallback = builtEngine(false, 41);

    function nearestDist(e: ReturnType<typeof builtEngine>, p: { x: number; y: number; z: number }): number {
      const proj = e.world3d.projectPoint(p, false);
      if (!proj) return Infinity;
      const dx = p.x - proj.point.x;
      const dy = p.y - proj.point.y;
      const dz = p.z - proj.point.z;
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    const barX = (BB_FRAME_BAR_IN + BB_FRAME_BAR_OUT) / 2;
    // the fallback's own predicted position for blue's up-cell floor/back wall (theta = the
    // rest tilt, up = north at staging) -- the FIXED probe point both engines are measured
    // against; see the header on why the tray pair gets its own wide tolerance below.
    const trayTheta = Math.PI / 6;
    const fbFloorLocal = rotate2(15.44, 0, trayTheta); // BB3_HIVE_ARM, w = 0 (fallback wMin)
    const fbBackLocal = rotate2(9.42, 7, trayTheta); // near the fallback box's inner v, mid w

    const probes: { name: string; point: { x: number; y: number; z: number }; tol: number }[] = [
      // walls are now ALWAYS built at the shared constants regardless of `BB3_FIELD_COLLIDERS`
      // (owner correction, `buildStatics3d`'s own comment), so the CAD and fallback engines
      // build the IDENTICAL wall colliders here -- back to the default 0.5in tolerance.
      { name: 'wall:left', point: { x: -BB_HALF_X + 2, y: 0, z: 6 }, tol: 0.5 },
      { name: 'wall:right', point: { x: BB_HALF_X - 2, y: 0, z: 6 }, tol: 0.5 },
      { name: 'wall:rear', point: { x: 0, y: BB_HALF_Y - 2, z: 6 }, tol: 0.5 },
      { name: 'wall:audience', point: { x: 0, y: -BB_HALF_Y + 2, z: 6 }, tol: 0.5 },
      { name: 'floor:centre', point: { x: 0, y: 0, z: 3 }, tol: 0.5 },
      // ⚠️ THE THREE FRAME PROBES AND THE F1 FOOT ARE RE-BASED ON THE NEW GEOMETRY, with a wide,
      // NAMED tolerance, for the same reason the two tray probes already had one: the CAD path is
      // SUPPOSED to differ here now. The fallback still builds the 2D field's single frame-BAR box
      // (one slab from the floor to the pivot across the whole `BB_FRAME_BAR_IN..OUT` span); the
      // CAD path builds the real parts -- two diagonal A-frame legs, a foot bar, two feet, the
      // Churro braces -- which do not fill that span, because the space between them is the
      // drive-under G409 assumes. A tight tolerance here would fail on exactly the correction this
      // pass makes. Measured deltas at the time of writing: 2.375 / 1.286 / 2.375 in.
      { name: 'frame:red-bar@y0 (CAD real legs vs fallback slab -- see header)', point: { x: -barX, y: 0, z: 5 }, tol: 4.0 },
      { name: 'frame:red-bar@y15 (CAD real legs vs fallback slab -- see header)', point: { x: -barX, y: 15, z: 5 }, tol: 4.0 },
      { name: 'frame:blue-bar@y0 (CAD real legs vs fallback slab -- see header)', point: { x: barX, y: 0, z: 5 }, tol: 4.0 },
      {
        name: 'tray:blue-up-floor (CAD intentionally differs -- see header)',
        point: { x: BB_HIVE_X, y: fbFloorLocal.a, z: BB3_HIVE_PIVOT_Z + fbFloorLocal.b },
        tol: 9.0,
      },
      {
        name: 'tray:blue-up-back (CAD intentionally differs -- see header)',
        point: { x: BB_HIVE_X, y: fbBackLocal.a, z: BB3_HIVE_PIVOT_Z + fbBackLocal.b },
        tol: 9.0,
      },
      // the flower feet: the CAD path now carries a true hull per SUPPORT PART (four HIPS pipes, a
      // backstop, two peanut supports, two brackets) instead of one AABB per part TYPE, and the
      // bore itself sits ~1.4in from `BB_FLOWERS` (the field-size open finding, audit §7), so a
      // sub-inch agreement with the fallback's single foot box is not the right bar. Measured
      // delta at the time of writing: 0.759 in at F1, 0.000 at F3.
      { name: 'flower:F1-foot (CAD per-part hulls vs fallback foot box)', point: { x: BB_FLOWERS[0].x - BB_FLOWER_D + 2, y: BB_FLOWERS[0].y, z: 1 }, tol: 1.5 },
      { name: 'flower:F3-foot (CAD per-part hulls vs fallback foot box)', point: { x: BB_FLOWERS[2].x - BB_FLOWER_D - 2, y: BB_FLOWERS[2].y, z: 1 }, tol: 1.5 },
    ];
    check('twelve-probe agreement: exactly twelve probes defined', probes.length === 12, `${probes.length}`);

    const rows = probes.map((p) => {
      const dCad = nearestDist(cad, p.point);
      const dFallback = nearestDist(fallback, p.point);
      const delta = Math.abs(dCad - dFallback);
      return { ...p, dCad, dFallback, delta };
    });
    console.log('[smoke-bb sim3d] twelve-probe agreement (CAD vs Day 1 fallback):');
    for (const r of rows) {
      console.log(
        `  ${r.name.padEnd(48)} cad=${r.dCad.toFixed(3)}in fallback=${r.dFallback.toFixed(3)}in delta=${r.delta.toFixed(3)}in (tol ${r.tol}in)`,
      );
    }
    for (const r of rows) {
      check(
        `twelve-probe: ${r.name} agrees within ${r.tol}in`,
        r.delta <= r.tol,
        `cad=${r.dCad.toFixed(3)} fallback=${r.dFallback.toFixed(3)} delta=${r.delta.toFixed(3)}`,
      );
    }
    // WALL PROBES ARE BACK AT THE DEFAULT 0.5in TOLERANCE: the 3D physics wall collider is now
    // ALWAYS built at the shared BB_HALF_X/Y constants regardless of `BB3_FIELD_COLLIDERS`
    // (owner correction -- `buildStatics3d`'s own comment), so the CAD and fallback engines
    // agree exactly here. The CAD's own MEASURED wall trimesh (~70.674in vs the constants' 72)
    // is a separate, printed-only open finding in the measurements-vs-config check below; it was
    // never a candidate for the 3D collider itself, which every other system is keyed to 72 for.
    //
    // ⚠️ THE TWO TRAY PROBES USE A 9.0in TOLERANCE, NOT 0.5in, ON PURPOSE: the CAD tray is
    // SUPPOSED to differ from the Day 1 algebraic box here -- that difference is the entire
    // point of this switch-over (the file header on `hiveCellLocalBox`/`buildHiveTray3d`: the
    // Day 1 box's up-cell opening bottom read ~55in against the manual's 53.5, and its down-cell
    // floor read ~32in against 25.5, both APPROX; the CAD's own equivalents read 47.05 and
    // 31.96 -- see the measurements check). A TIGHT tolerance here would either fail on the
    // intended correction or (worse) silently pass because both sides happened to be close by
    // coincidence; a wide, named, printed tolerance is the honest version of this probe pair.
  }

  // ---- measurements vs config, and the ONE-GEOMETRY check ----------------------------------
  //
  // Two different jobs in one block. (1) Assert that every geometry constant IS what the CAD
  // measures -- owner ruling, 2026-09-18: "the CAD is authoritative for dimensions". (2) Assert
  // that the PICTURE and the PHYSICS are the same geometry -- the owner's "the balls are on a
  // different plane than the actual bottom of the hive", turned into a check.
  //
  // WARNING: THESE ROWS WERE WIDE, PRINT-ONLY AND LABELLED "OPEN FINDING", AND ARE NOT ANY MORE.
  // The field size (+-70.674, not 72), the tile pitch (23.528, not 24), the four flower bores and
  // the down-cell floor (31.981, not 25.5) were all reported under tolerances between 0.6 and 7
  // inches while the owner decided what to do about them. The ruling moved the constants, so the
  // tolerance is `TOL` below -- tight enough that a re-run of `npm run field-cad` which moves any
  // of them and does NOT regenerate `fieldDims.gen.ts` fails here.
  //
  // Nothing was loosened to make this pass: the deltas these rows measure went to 0.000, because
  // `config.ts` now reads the generated file the measurements themselves produce.
  {
    const m = fieldMeasurements;
    /** the one tolerance every CAD-vs-config row is held to now (in). Not zero, because the
     * generated file rounds to 1e-3 and `config.ts` projects some of it through a cosine. */
    const TOL = 0.25;
    function checkClose(name: string, actual: number, expected: number, tol: number): void {
      const delta = Math.abs(actual - expected);
      check(`measurements: ${name}`, delta <= tol, `CAD=${actual.toFixed(3)} config=${expected.toFixed(3)} delta=${delta.toFixed(3)} (tol ${tol})`);
    }

    checkClose('hive pivot z', m.hive.pivotZ, BB3_HIVE_PIVOT_Z, TOL);
    for (const a of ['red', 'blue'] as const) {
      const t = m.hive.trays[a];
      checkClose(`${a} tray capture tilt is exactly the manual's 30deg`, Math.abs(t.captureThetaDeg), 30, 0.01);
      // A WRONG CAPTURE ANGLE READS AS A THICK SHEET. `Hive Goal Back Skin` is a flat 0.020-in
      // plate; un-tilting the tray by the right angle leaves it 0.020 in thick in the local `v`
      // axis, and by any other angle spreads it over inches. This is the one number that proves
      // the whole tray export is in the frame it claims to be.
      check(
        `measurements: ${a} tray back-skin residual thickness proves the un-tilt (a wrong angle reads THICK)`,
        t.backSkinThicknessIn !== null && t.backSkinThicknessIn <= 0.1,
        `thickness=${t.backSkinThicknessIn}in`,
      );
      checkClose(`${a} pivot x`, Math.abs(t.pivot[0]), BB_HIVE_X, TOL);
    }

    // THE UP-CELL OPENING -- the CAD and the MANUAL agree here to 0.13 in ([53.375, 65.497]
    // against Fig 9-10's [53.5, 65.6]), so the ruling moved this constant by a tenth of an inch
    // and CONFIRMED the figure rather than overturning it. The earlier "[47.05, 68.85], OPEN
    // FINDING" reading was an artifact of the collider export treating a WORLD-frame AABB as a
    // tray-LOCAL extent (`docs/biobuzz/field-cad-audit.md` section 4.4) and is long closed.
    for (const a of ['red', 'blue'] as const) {
      const open = m.hive.openingZ[a];
      checkClose(`${a} up-cell opening BOTTOM vs BB_HIVE_OPEN_Z[0]`, open[0], BB_HIVE_OPEN_Z[0], TOL);
      checkClose(`${a} up-cell opening TOP vs BB_HIVE_OPEN_Z[1]`, open[1], BB_HIVE_OPEN_Z[1], TOL);
    }

    // THE DOWN-CELL CLEARANCE -- the one figure where the CAD and the manual genuinely disagree,
    // and the one the owner ruled on. `BB_HIVE_BOTTOM_Z` IS the CAD's 31.981 now; Fig 9-10's 25.5
    // is 6.48 in low, and it has to be, because one rigid bar at 30 degrees cannot put the up
    // mouth where the manual says AND the down floor where the manual says on this tray's own
    // measured dimensions. Strict from here: a CAD revision that moves it fails loudly.
    for (const a of ['red', 'blue'] as const) {
      checkClose(`${a} down-cell clearance vs BB_HIVE_BOTTOM_Z`, m.hive.downCellFloorZ[a], BB_HIVE_BOTTOM_Z, TOL);
    }
    // ...and the LOWEST structure of any kind, which is what G409's drive-under actually needs.
    // ASSERTED, not merely printed: the whole reason the 25.5 could be let go is that a legal
    // 29-in robot still clears the real assembly, and that is a claim, so it is a check.
    const lowest = m.hive.lowestStructureZAtRest;
    checkClose('lowest hive structure at rest vs BB_HIVE_LOWEST_Z', lowest.z, BB_HIVE_LOWEST_Z, TOL);
    check(
      'measurements: a legal 29-in robot clears the LOWEST hive structure at rest (G409 drive-under survives the taller hive)',
      lowest.z > BB3_HEIGHT_MAX,
      `lowest=${lowest.z.toFixed(3)}in ("${lowest.part}") vs BB3_HEIGHT_MAX ${BB3_HEIGHT_MAX}`,
    );

    // THE FIELD SIZE. Real FTC soft tiles are 23.528 in on centre, not 24, so the perimeter closes
    // on 141.35 in inside the walls and not 144, and a flower on the real seam sits 1.5 in from
    // where a 24-in tile would put it. That was three "OPEN FINDING" rows under 0.6-to-2-inch
    // tolerances; it is one ruling and a set of strict rows now. All FOUR faces, not just the
    // right one: the generated `FIELD_HALF` is their mean, so checking one face would not catch
    // a future field that is no longer square.
    for (const [name, cad] of [
      ['left', m.walls.innerFace.left],
      ['right', m.walls.innerFace.right],
      ['rear', m.walls.innerFace.rear],
      ['audience', m.walls.innerFace.audience],
    ] as const) {
      const cfg = name === 'left' || name === 'right' ? BB_HALF_X : BB_HALF_Y;
      checkClose(`${name} wall inner face vs BB_HALF_*`, Math.abs(cad), cfg, TOL);
    }
    checkClose('tile pitch vs BB_TILE_PITCH', m.tiles.pitch, BB_TILE_PITCH, TOL);
    check(
      'measurements: BIOBUZZ does NOT draw the shared C.TILE -- 24 is DECODE and CR nominal tile, and this field is not built on it',
      Math.abs(BB_TILE_PITCH - C.TILE) > 0.4,
      `BB_TILE_PITCH=${BB_TILE_PITCH} C.TILE=${C.TILE}`,
    );
    for (const f of m.flowers) {
      const cfg = BB_FLOWERS.find((x) => x.id === f.id)!;
      const c = f.bore.top.centre;
      const dist = Math.hypot(c[0] - cfg.x, c[1] - cfg.y);
      check(
        `measurements: flower ${f.id} TOP-RING BORE centre IS its BB_FLOWERS position`,
        dist <= TOL,
        `CAD bore=(${c[0].toFixed(3)},${c[1].toFixed(3)}) d=${f.bore.top.diameter.toFixed(3)} rms=${f.bore.top.rms.toFixed(4)} config=(${cfg.x},${cfg.y}) dist=${dist.toFixed(3)}`,
      );
      // the stand-off from the flower's OWN wall is the figure `BB_FLOWER_D` actually names.
      const wallFaceAbs = Math.abs(m.walls.innerFace.right);
      const standoff = Math.min(Math.abs(wallFaceAbs - Math.abs(c[0])), Math.abs(wallFaceAbs - Math.abs(c[1])));
      checkClose(`flower ${f.id} bore stand-off from the CAD wall vs BB_FLOWER_D`, standoff, BB_FLOWER_D, TOL);
      checkClose(`flower ${f.id} top-ring bore RADIUS vs BB_FLOWER_OPEN_R`, f.bore.top.diameter / 2, BB_FLOWER_OPEN_R, TOL);
      // WARNING: THE ONE ROW STILL WIDE, AND NAMED FOR IT. `extent.z[1]` is the flower's HIGHEST
      // point, which is the purple BACKSTOP at 22.654 -- not the top RING plate, whose own z band
      // the measurements file does not carry (the audit measures it by hand at 20.254...21.404,
      // section 6). `BB_FLOWER_TOP_Z` is therefore still the manual's 21.5, flagged in
      // `config.ts`, and this row asserts only that the two stay consistent with a ~1.2-in
      // backstop standing over the ring. Emitting the per-ring bands is a `convert.py` change.
      checkClose(
        `flower ${f.id} assembly top (the BACKSTOP) stands over BB_FLOWER_TOP_Z -- NOT a ring measurement, see the note`,
        f.extent.z[1],
        BB_FLOWER_TOP_Z,
        1.5,
      );
    }

    // TAPE: every strip is 1.000 in wide, and there is no other width on this field.
    check(
      'measurements: every CAD gaffer tape strip is 1.000in wide (the documented width, and the only one)',
      m.tape.widthsIn.length === 1 && Math.abs(m.tape.widthsIn[0] - 1) < 0.01,
      `widths=${JSON.stringify(m.tape.widthsIn)} across ${m.tape.parts.length} parts`,
    );
    check('measurements: the CAD carries all 16 tape strips', m.tape.parts.length === 16, `${m.tape.parts.length}`);
    // ...and every one of them stays CLEAR of the wall it borders. This is the owner's rule --
    // "zones bounded with the wall usually do not have tape on the wall" -- asserted against the
    // CAD rather than trusted: no on-tile strip may reach the wall's inner face.
    const wallFace = Math.abs(m.walls.innerFace.right);
    const onTile = m.tape.parts.filter((t) => t.plane === 'tiles');
    const touching = onTile.filter(
      (t) => Math.max(Math.abs(t.x[0]), Math.abs(t.x[1]), Math.abs(t.y[0]), Math.abs(t.y[1])) >= wallFace - 1e-3,
    );
    check(
      'measurements: no on-tile tape strip runs onto a perimeter wall (the wall-bounded edge carries none)',
      touching.length === 0,
      `${touching.length} of ${onTile.length} strips reach x/y ${wallFace.toFixed(3)}: ${touching.map((t) => t.part).join(', ')}`,
    );
  }

  // ---- ONE FIELD: the 2D wall colliders, the 3D wall colliders and the CAD all coincide ------
  //
  // The 2D and the 3D pipelines are two independent solvers over one field, and until the
  // 2026-09-18 ruling they DISAGREED about where that field's edge was on purpose -- the 3D walls
  // were pinned to the constants' 72 "for parity with the 2D pipeline and the staging" while the
  // CAD measured 70.674, and the gap was reported rather than fixed. It is fixed, and this is the
  // check that says so: three independently-reached numbers per side, 0.05 in apart.
  //
  //   1. the 2D collider set (`biobuzzColliders.statics`, the first `BB_WALL_COUNT` boxes), read
  //      as `|tx| - hx` -- the inner face of the cuboid the 2D solve actually pushes against;
  //   2. the 3D collider set, read by PROJECTING a point 2 in inside each wall onto the nearest
  //      surface in a REAL built engine -- not by re-reading the constant the builder read, which
  //      would prove nothing about the builder;
  //   3. `field-measurements.json`'s `walls.innerFace`, which is the CAD, and therefore the GLB:
  //      the `walls` node the scene draws is the tessellation of these same faces.
  {
    const wallEngine = (() => {
      const w = mkWorld3d('free', 71);
      step3d(w, 1 / 60, new Map());
      return engineFor(w);
    })();
    const faces = [
      { name: 'right', axis: 'x' as const, sign: 1, cad: fieldMeasurements.walls.innerFace.right, cfg: BB_HALF_X },
      { name: 'left', axis: 'x' as const, sign: -1, cad: fieldMeasurements.walls.innerFace.left, cfg: -BB_HALF_X },
      { name: 'rear', axis: 'y' as const, sign: 1, cad: fieldMeasurements.walls.innerFace.rear, cfg: BB_HALF_Y },
      { name: 'audience', axis: 'y' as const, sign: -1, cad: fieldMeasurements.walls.innerFace.audience, cfg: -BB_HALF_Y },
    ];
    const TOL_FIELD = 0.05;
    for (const f of faces) {
      // (1) the 2D box whose inner face is nearest this side
      const boxes = biobuzzColliders.statics.slice(0, BB_WALL_COUNT);
      let face2d = NaN;
      for (const b of boxes) {
        const centre = f.axis === 'x' ? b.tx : b.ty;
        const half = f.axis === 'x' ? b.hx : b.hy;
        if (Math.sign(centre) !== f.sign || centre === 0) continue;
        const inner = centre - f.sign * half;
        if (Number.isNaN(face2d) || Math.abs(inner - f.cfg) < Math.abs(face2d - f.cfg)) face2d = inner;
      }
      // (2) the 3D collider, measured rather than assumed
      const probe = {
        x: f.axis === 'x' ? f.cfg - f.sign * 2 : 0,
        y: f.axis === 'y' ? f.cfg - f.sign * 2 : 0,
        z: 6,
      };
      const proj = wallEngine.world3d.projectPoint(probe, false);
      const face3d = proj ? (f.axis === 'x' ? proj.point.x : proj.point.y) : NaN;
      const spread = Math.max(
        Math.abs(face2d - f.cad),
        Math.abs(face3d - f.cad),
        Math.abs(face2d - face3d),
      );
      check(
        `one field: the ${f.name} wall is the same plane in the 2D colliders, the 3D colliders and the CAD (within ${TOL_FIELD}in)`,
        spread <= TOL_FIELD,
        `2D=${face2d.toFixed(3)} 3D=${face3d.toFixed(3)} CAD/GLB=${f.cad.toFixed(3)} spread=${spread.toFixed(4)}`,
      );
    }
  }

  // ---- ONE FIELD, PART TWO: the tape the renderers draw IS the CAD's own 16 strips -----------
  //
  // `BB_TAPE` is generated from `field-measurements.json`, so this is not a re-derivation -- it
  // is a check that the generated table still describes the SAME rectangles the measurements do,
  // which is what catches a hand-edit of the gen file or a mis-classification in the emitter (the
  // strips are grouped by the nominal length in their STEP part names, and a future field that
  // renames a part would silently drop one into the wrong zone).
  //
  // The renderers are covered separately, by source: both of them draw `BB_TAPE` rather than an
  // outline of `BB_LZ`/`BB_GARDEN`, which is what the owner's "zones bounded with the wall don't
  // have tape on the wall" actually required.
  {
    const onTile = fieldMeasurements.tape.parts.filter((t) => t.plane === 'tiles');
    const drawn = [
      ...BB_TAPE.loadingZone.red,
      ...BB_TAPE.loadingZone.blue,
      ...BB_TAPE.garden.red,
      ...BB_TAPE.garden.blue,
    ];
    check(
      'one field: the drawn tape is exactly the CAD\'s on-tile strip count',
      drawn.length === onTile.length,
      `drawn=${drawn.length} cad=${onTile.length}`,
    );
    let worst = 0;
    let worstName = '';
    for (const t of onTile) {
      let best = Infinity;
      for (const d of drawn) {
        const e = Math.max(
          Math.abs(d.x0 - t.x[0]),
          Math.abs(d.x1 - t.x[1]),
          Math.abs(d.y0 - t.y[0]),
          Math.abs(d.y1 - t.y[1]),
        );
        if (e < best) best = e;
      }
      if (best > worst) {
        worst = best;
        worstName = t.part;
      }
    }
    check(
      'one field: every CAD on-tile tape strip has a drawn rectangle at the same place (within 0.002in, the gen file\'s own rounding)',
      worst <= 0.002,
      `worst ${worst.toFixed(4)}in on "${worstName}"`,
    );
    // ...and the strips stop clear of the wall, which is the rule the whole tape fix is about.
    const wallFaceAbs = Math.abs(fieldMeasurements.walls.innerFace.right);
    const touching = drawn.filter(
      (d) => Math.max(Math.abs(d.x0), Math.abs(d.x1), Math.abs(d.y0), Math.abs(d.y1)) >= wallFaceAbs - 1e-3,
    );
    check(
      'one field: no DRAWN tape strip runs onto a perimeter wall',
      touching.length === 0,
      `${touching.length} of ${drawn.length} reach ${wallFaceAbs.toFixed(3)}`,
    );
  }

  // ---- THE GENERATED FILE IS THE MEASUREMENTS, still --------------------------------------
  //
  // `src/games/biobuzz/fieldDims.gen.ts` is what `config.ts` reads, and it is written by
  // `npm run field-cad`, which is a heavyweight pipeline nobody runs on a whim: a STEP download,
  // a CadQuery venv and a glTF toolchain. So the file in the repo could drift from the JSON in
  // the repo in either direction -- a measurements re-run committed without the emitter, or a
  // hand-edit of the generated constants -- and NOTHING else would notice, because every other
  // check in this file reads the generated file for both sides of its comparison.
  //
  // RE-RENDER AND DIFF, character for character. The emitter is deterministic (its header stamps
  // the pinned STEP's identity and the sha256 of the measurements file, never a clock), so this
  // is exact.
  //
  // LINE ENDINGS ARE NORMALISED FIRST, and that is not a loosened comparison. This repo has no
  // `.gitattributes` and `core.autocrlf` is true on Windows, so a FRESH CLONE gets the committed
  // file back with CRLF while `emit-dims.mjs` writes LF -- the file is identical and every line
  // would differ. The check is about the CONTENT the emitter produced; the checkout's EOL policy
  // is git's business.
  {
    const genPath = 'src/games/biobuzz/fieldDims.gen.ts';
    const lf = (t: string): string => t.split('\r\n').join('\n');
    const onDisk = lf(readFileSync(genPath, 'utf8'));
    const rendered = lf(renderDims(readFileSync('public/models/biobuzz/field-measurements.json', 'utf8')));
    let firstDiff = -1;
    for (let i = 0; i < Math.max(onDisk.length, rendered.length); i++) {
      if (onDisk[i] !== rendered[i]) {
        firstDiff = i;
        break;
      }
    }
    check(
      'fieldDims.gen.ts is exactly what emit-dims.mjs renders from field-measurements.json (run `npm run field-cad` if this fails)',
      firstDiff === -1,
      firstDiff === -1
        ? `${onDisk.length} bytes`
        : `first difference at byte ${firstDiff}: disk ${JSON.stringify(onDisk.slice(firstDiff, firstDiff + 60))} vs rendered ${JSON.stringify(rendered.slice(firstDiff, firstDiff + 60))}`,
    );
  }

  // ---- ONE GEOMETRY: the drawn tray floor and the collider tray floor are the same plane -----
  //
  // THE OWNER'S FIRST SENTENCE, AS A CHECK. `field-measurements.json`'s `hive.trays[a].cells` is
  // measured off the tray skins' own PLANAR FACETS -- i.e. the surface the GLB mesh draws -- and
  // `field-colliders.json`'s `cell_<side>_floor` hull is what Rapier stands an element on. Two
  // independent derivations in two files; if they part company, the picture and the physics are
  // telling a driver different things, which is exactly what shipped twice.
  {
    const m = fieldMeasurements;
    const fc = fieldColliders3d();
    for (const a of ['red', 'blue'] as const) {
      for (const side of ['north', 'south'] as const) {
        const meshW = m.hive.trays[a].cells[side].wMin;
        const hull = fc.trays[a].hulls.find((h) => h.name === `cell_${side}_floor`);
        if (!hull) {
          check(`one-geometry: ${a}/${side} has a floor hull to compare against`, false);
          continue;
        }
        // the floor slab is extruded DOWNWARD from its own CAD plane, so its MAX w is the
        // load-bearing surface.
        let colliderW = -Infinity;
        for (let i = 2; i < hull.points.length; i += 3) colliderW = Math.max(colliderW, hull.points[i]);
        check(
          `one-geometry: ${a}/${side} drawn floor plane and collider floor plane coincide within 0.25in`,
          Math.abs(meshW - colliderW) <= 0.25,
          `mesh w=${meshW.toFixed(4)} collider w=${colliderW.toFixed(4)} delta=${Math.abs(meshW - colliderW).toFixed(4)}`,
        );
      }
    }
  }

  // ---- ...and a resting element sits exactly one radius above that plane ---------------------
  {
    for (const a of ['red', 'blue'] as const) {
      const w = mkWorld3dPair('free', a === 'red' ? 512 : 513);
      w.balls.length = 0;
      const theta = hiveTiltAngle(w, a);
      const sideSign: 1 | -1 = w.biobuzz!.hives[a].up === 'north' ? 1 : -1;
      const box = hiveCellLocalBox(sideSign, a);
      const vMid = (box.vMin + box.vMax) / 2;
      const drop = hiveWorldPoint(a, sideSign, theta, 0, vMid, box.wMin + BB_POLLEN_R + 3);
      const id = 900;
      const dropped: Artifact = {
        id,
        color: 'yellow',
        state: { kind: 'ground' },
        pos: { x: drop.x, y: drop.y },
        z: drop.z - BB_POLLEN_R,
        vel: { x: 0, y: 0 },
        vz: 0,
      };
      w.balls.push(dropped);
      for (let t = 0; t < 240; t++) step3d(w, 1 / 60, new Map());
      const b = w.balls.find((x) => x.id === id)!;
      // back into the tray's own frame and read the height above the floor plane
      const local = rotate2(b.pos.y, b.z + BB_POLLEN_R - BB3_HIVE_PIVOT_Z, -theta);
      const above = local.b - box.wMin;
      check(
        `one-geometry: a settled element's centre sits one radius (${BB_POLLEN_R}in) above ${a}'s drawn cell floor`,
        Math.abs(above - BB_POLLEN_R) <= 0.25,
        `centre is ${above.toFixed(3)}in above the floor plane (w=${box.wMin.toFixed(3)}), world z=${b.z.toFixed(3)}`,
      );
    }
  }

  // ---- contact stiffness: the seat in a hive cell, and the rebound off the tiles -----------
  //
  // TWO OWNER REPORTS, ONE CAUSE AND ONE NEAR-MISS (2026-09-19).
  //
  // 1. "Elements mesh with the bottom of the HIVE." They do: a soft contact sags `g/(2*pi*f)^2`
  //    at rest, and this world used to build with the shared `PHYS_CONTACT_FREQ` (12 Hz), which
  //    is DECODE's robot-shove stiffness. MEASURED here, worst penetration of a settled element
  //    into the cell floor plane after 900 ticks: 12 Hz -> 0.127in (3 elements) / 0.135in (5),
  //    20 -> 0.056 / 0.062, 25 -> 0.043 / 0.047, 30 -> 0.035 / 0.039, 45 -> 0.025 / 0.028. The
  //    world now takes `BB3_CONTACT_FREQ`.
  //    THE TOLERANCE IS 0.06in, and it is picked to sit in the gap rather than beside a number:
  //    it passes 25 Hz as well as the 30 Hz in the constant (so a re-tune inside the evidenced
  //    band does not fail here), and it fails 12 Hz by more than 2x -- which is the regression
  //    this check exists for, someone re-sharing the chassis constant with this world. For
  //    scale, 0.06in is 4% of a POLLEN's 1.4in radius; the cell floor skin is what the owner is
  //    looking at, so the bound is on what shows, not on what the solver would like.
  //
  // 2. "Make the balls bounce very slightly more from the field tiles." Two things were wrong.
  //    The tiles had restitution 0, so the element/tile pair averaged to e = 0.223 (measured: a
  //    24in drop rebounded 1.19in); `TILE_RESTITUTION` (`sim3d/bodies.ts`) makes that 0.25. And
  //    `groundRoll3d`'s planar rest snap was taking `vz` with it, so an element landing with NO
  //    planar speed -- a lob dropped straight down -- had its rebound zeroed on the tick it was
  //    earned and did not bounce AT ALL. Both halves are asserted, because either one alone
  //    still leaves the owner's report half-true.
  for (const a of ['blue', 'red'] as const) {
    for (const n of [3, 5]) {
      const w = mkWorld3d('free', 490);
      w.balls.length = 0;
      const theta = hiveTiltAngle(w, a);
      const sideSign: 1 | -1 = w.biobuzz!.hives[a].up === 'north' ? 1 : -1;
      const box = hiveCellLocalBox(sideSign, a);
      const wLocal = box.wMin + BB_POLLEN_R + 0.5;
      const ids: number[] = [];
      for (let i = 0; i < n; i++) {
        const p = hiveWorldPoint(a, sideSign, theta, (i - (n - 1) / 2) * 3.2, box.vMin + 2 + (i % 2) * 2.4, wLocal);
        const el: Artifact = {
          id: i + 1,
          color: 'yellow',
          state: { kind: 'ground' },
          pos: { x: p.x, y: p.y },
          vel: { x: 0, y: 0 },
          z: p.z - BB_POLLEN_R,
          vz: 0,
        };
        ids.push(el.id);
        w.balls.push(el);
      }
      for (let t = 0; t < 900; t++) step3d(w, 1 / 60, new Map());
      let worst = -Infinity;
      for (const id of ids) {
        const b = w.balls.find((x) => x.id === id)!;
        const r = b.r ?? BB_POLLEN_R;
        // the element's centre, back in the tray's own (v, w) frame: a centre below the cell
        // floor plane (`box.wMin`) by more than one radius is a sphere sunk into that floor.
        const local = rotate2(b.pos.y, b.z + r - BB3_HIVE_PIVOT_Z, -theta);
        worst = Math.max(worst, box.wMin + r - local.b);
      }
      const inCell = ids.filter((id) => w.biobuzz!.hives[a].contents.includes(id)).length;
      check(
        `contact stiffness: ${n} elements settled in ${a}'s up cell all stayed in it`,
        inCell === n,
        `${inCell}/${n} contained`,
      );
      check(
        `contact stiffness: a settled element rests ON ${a}'s cell floor, not in it (<= 0.06in)`,
        worst <= 0.06,
        `worst penetration ${worst.toFixed(4)}in -- 0.035in at BB3_CONTACT_FREQ 30, 0.127in at the shared 12`,
      );
    }
  }
  {
    /** drop a POLLEN from `dropZ` (bottom height, in) with planar speed `vx`; return the height
     * its BOTTOM reaches after the first bounce, or 0 if it never left the tiles. */
    const reboundApex = (vx: number, dropZ: number): number => {
      const w = mkWorld3d('free', 31);
      w.balls.length = 0;
      w.balls.push({
        id: 900,
        color: 'yellow',
        state: { kind: 'ground' },
        // the open garden corner: clear of the flowers, the hive and both start boxes.
        pos: { x: -40, y: -30 },
        vel: { x: vx, y: 0 },
        z: dropZ,
        vz: 0,
      });
      let apex = 0;
      let rebounding = false;
      for (let t = 0; t < 400; t++) {
        step3d(w, 1 / 60, new Map());
        const b = w.balls[0];
        if (!rebounding) {
          if (b.vz > 0.5) rebounding = true; // the tiles have just handed it back some speed
        } else {
          apex = Math.max(apex, b.z);
          if (b.vz <= 0 && b.z <= 0.05) break; // back down -- one bounce is all this measures
        }
      }
      return apex;
    };
    // A 24in drop arrives at 141in/s. The rebound HEIGHT is e^2 * drop, so this band is really a
    // band on e: 6.9..9.0in is e 0.536..0.612, the hard-plastic-ball-on-foam-tile band, around
    // the measured 7.68in (e 0.566).
    //
    // ⚠️ IT WAS 1.30-1.70in (e ~= 0.25) UNTIL 2026-09-19, and that is the owner's item 21: "in
    // real life the balls bounce and disperse a lot more after the hive tips and it hits the
    // field tiles". At e 0.25 a POLLEN arriving off the tray at 160in/s rebounded 1.0-2.1in --
    // not a bounce anybody can see. The lever is `BB3_ELEMENT_RESTITUTION` and the floor's
    // MULTIPLY rule (`sim3d/bodies.ts` `TILE_RESTITUTION`), which is what lets the element carry
    // the real pair while a chassis still reads zero against the same collider; both ends of
    // that are measured in those two headers.
    //
    // It still fails HIGH if anyone gives the ELEMENT a MAX combine rule, which is the tempting
    // one-word version and the wrong one: MAX outranks the tray's MIN, so it would take the
    // cell's own low restitution with it and a shot would bounce back out.
    const drift = reboundApex(20, 24);
    check(
      'tiles: a POLLEN dropped 24in with planar drift rebounds 6.9-9.0in (e ~= 0.57, foam tile)',
      drift >= 6.9 && drift <= 9.0,
      `apex ${drift.toFixed(4)}in, e=${Math.sqrt(Math.max(drift, 0) / 24).toFixed(3)}`,
    );
    // THE SAME BALL, STRAIGHT DOWN. Before `groundRoll3d` stopped taking `vz` with the planar
    // rest snap this was 0.0000in -- not a small bounce, none -- because a vertical drop has no
    // planar speed for the snap to spare. The two numbers must agree: the tiles cannot care
    // whether the ball happened to be moving sideways as well.
    const straight = reboundApex(0, 24);
    check(
      'tiles: a POLLEN dropped STRAIGHT DOWN bounces the same as one with drift (the rest snap does not eat vz)',
      straight >= 6.9 && straight <= 9.0 && Math.abs(straight - drift) <= 0.05,
      `straight ${straight.toFixed(4)}in vs drift ${drift.toFixed(4)}in`,
    );
  }
  {
    // THE TWO WORLDS ARE BUILT THE SAME. `sim3d/predict.ts` hand-copies `buildEngine`'s four
    // integration parameters into its own Rapier world, and nothing at runtime notices when only
    // one of them moves -- the symptom is a client whose predicted contacts solve at a different
    // stiffness from the authority's, i.e. a reconcile snap on every landed shot, in every
    // server-connected match. Asserted at the SOURCE because the predictor does not expose its
    // world, and this is the cheap guard that would have caught the copy going stale.
    const params = (src: string): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const m of src.matchAll(/integrationParameters\.(\w+)\s*=\s*([^;]+);/g)) out[m[1]] = m[2].trim();
      return out;
    };
    const engineSrc = params(readFileSync('src/games/biobuzz/sim3d/engineImpl.ts', 'utf8'));
    const predictSrc = params(readFileSync('src/games/biobuzz/sim3d/predict.ts', 'utf8'));
    const keys = ['lengthUnit', 'numSolverIterations', 'contact_natural_frequency', 'normalizedAllowedLinearError'];
    const mismatched = keys.filter((k) => engineSrc[k] === undefined || engineSrc[k] !== predictSrc[k]);
    check(
      'predict: the predictor world is built with the same four integration parameters as the authority',
      mismatched.length === 0,
      mismatched.map((k) => `${k}: engine=${engineSrc[k]} predict=${predictSrc[k]}`).join('; '),
    );
    check(
      "predict: both worlds take BIOBUZZ's own contact stiffness, not the shared robot one",
      engineSrc.contact_natural_frequency === 'BB3_CONTACT_FREQ',
      `engine=${engineSrc.contact_natural_frequency}`,
    );
  }

  // ---- the HIVE's foot bar is a FLANGE box, not a full-width slab: a chassis still slides its
  // whole length, and the wide floor beside it is no longer an invisible wall ------------------
  //
  // Owner, 2026-09-20 (first report): "when I strafe across while my front is flat with the
  // support beam, I get stuck on a corner that does not exist". The exporter's bar + two buried
  // feet left an internal edge 0.11 in behind the bar's face; a pressed chassis sits 0.09 in in,
  // and its leading corner stopped dead on the foot's side face (mecanum, 0.8 push / 0.5 strafe,
  // stuck at y 9.14). Owner, SAME DAY (second report), on the fix for the first: "balls are able
  // to get stuck on top of the biobuzz panel" / "an invisible wall/bump wherever the drawn bar is
  // lower than 2.15 in" — the full-width box built for the first fix swallowed a floor that is
  // really only 0.02-0.10 in tall across 1.32 of its 1.98-in width. `slimFootBars`
  // (`fieldColliders.ts`) narrows the bar to just its measured 0.66-in back flange and leaves the
  // two frame feet UNFOLDED (their own hulls, not merged) — see that function's header for the
  // full measurement and why the feet can stay separate without reopening the first bug.
  {
    const statics = cadStatics();
    const bars = statics.filter((s) => s.name.endsWith('_sheet_metal_foot_bar'));
    const feet = statics.filter((s) => /_frame_foot_[ab]$/.test(s.name));
    // ⚠️ THE PIECES ARE NO LONGER SQUARE BOXES (2026-09-21, the invisible-corner fix below): each
    // is one hull that follows the assembly's own two ramps upward. What this check is really
    // about survives unchanged and is read off the BASE SECTION, the rect each piece still carries
    // at the tiles: the flange is 0.66 in wide, a foot is wider, and the two TOUCH at one x and
    // never overlap (overlapping them is what froze a strafing chassis, see `slimFootBars`).
    const baseXs = (b: FieldStatic) => {
      let z0 = Infinity;
      for (let i = 2; i < b.points.length; i += 3) z0 = Math.min(z0, b.points[i]);
      const xs = new Set<number>();
      for (let i = 0; i < b.points.length; i += 3) if (b.points[i + 2] <= z0 + 1e-9) xs.add(b.points[i]);
      return [...xs].sort((a, c) => a - c);
    };
    const boxy = bars.every((b) => baseXs(b).length === 2) && feet.every((f) => baseXs(f).length === 2);
    const flangeWidth = bars.map((b) => {
      const xs = baseXs(b);
      return xs[1] - xs[0];
    });
    const feetTouchFlange = feet.every((f) => {
      const bar = bars.find((b) => f.name.startsWith(b.name.replace(/sheet_metal_foot_bar$/, '')));
      if (!bar) return false;
      const fx = baseXs(f);
      const bx = baseXs(bar);
      const shared = fx.filter((x) => bx.includes(x));
      const barOuter = bx.find((x) => !shared.includes(x));
      return fx.length === 2 && shared.length === 1 && !fx.includes(barOuter!);
    });
    check(
      'foot bar 3d: each bar is a narrow FLANGE (0.66 in) at the tiles, and the two feet are their own WIDER pieces touching it, not folded away and not overlapping it',
      bars.length === 2 && feet.length === 4 && boxy && feetTouchFlange && flangeWidth.every((w) => Math.abs(w - 0.66) < 1e-6),
      `${bars.length} bars, ${feet.length} feet, base rects ${boxy}, widths ${flangeWidth.map((w) => w.toFixed(3)).join(',')}`,
    );

    const FACE = 24.73;
    let worst = '';
    let slowest = Infinity;
    for (const bar of [1, -1]) {
      for (const dir of [1, -1]) {
        for (const dt of ['mecanum', 'swerve'] as const) {
          const w = mkWorld3dPair('free', 7, { drivetrain: dt });
          w.balls.length = 0;
          w.robots[1].pos.x = -60 * bar;
          w.robots[1].pos.y = 60;
          const r = w.robots[0];
          r.fieldCentric = false;
          r.heading = bar === 1 ? Math.PI : 0;
          r.vel.x = r.vel.y = 0;
          r.angVel = 0;
          const fe = robotExtents(r);
          r.pos.x = bar * (FACE + fe.front + 0.2);
          r.pos.y = -9 * dir;
          // front pressed INTO the bar, strafing along it, robot-centric
          const c = cmd({ driveY: 0.8, driveX: dir * bar * 0.5 });
          let lastY = r.pos.y;
          let slow = Infinity;
          for (let t = 0; t < 400 && Math.abs(r.pos.y) < 22; t++) {
            step3d(w, C.SIM_DT, new Map([[0, c]]));
            const v = Math.abs(r.pos.y - lastY) / C.SIM_DT;
            lastY = r.pos.y;
            if (t > 40 && v < slow) slow = v;
          }
          if (slow < slowest) slowest = slow;
          if (Math.abs(r.pos.y) < 22) worst += `${dt} bar ${bar} dir ${dir} stopped at y ${r.pos.y.toFixed(2)}; `;
          disposeEngineFor(w);
        }
      }
    }
    check(
      'foot bar 3d: a chassis pressed flat against either foot bar strafes its whole length, both ways, without stopping',
      worst === '' && slowest > 3,
      worst || `slowest slide ${slowest.toFixed(1)} in/s`,
    );
  }

  // ---- the WIDE FLOOR beside the flange is no longer an invisible wall (owner, 2026-09-20,
  // second report on the very fix above: "balls are able to get stuck on top of the biobuzz
  // panel with seemingly nothing actually holding it up" / "an invisible wall/bump wherever the
  // drawn bar is lower than 2.15 in"). Measured off the shipped GLB (`scratch/footbar-*.ts`, kept
  // out of the repo's build): the true floor there is 0.02-0.10 in for 1.32 of the bar's 1.98-in
  // width, over 33.5 of its 38.94-in length -- everywhere except the ~0.66-in flange strip
  // `slimFootBars` still boxes and the two feet's own ~2.3-in-tall ends. -------------------------
  {
    // (a) a chassis driven from the field-centre side (the low floor) crosses the OLD box's
    // inner face at x -22.75 without slowing, and only stops at the FLANGE's own inner face (x
    // near -24.07 for red / 24.07 for blue) -- proof the wide invisible wall is gone and the
    // flange that is actually drawn is still solid. Tracked by the robot's own FRONT FACE (centre
    // + `fe.front`, which includes reach hardware, easily 10+ in) -- the depth a bare centre
    // reads is not where contact happens.
    let crossFail = '';
    for (const bar of [1, -1] as const) {
      for (const dt of ['mecanum', 'swerve'] as const) {
        const w = mkWorld3dPair('free', 81, { drivetrain: dt });
        w.balls.length = 0;
        w.robots[1].pos.x = -60 * bar;
        w.robots[1].pos.y = 60;
        const r = w.robots[0];
        r.fieldCentric = false;
        r.heading = bar === 1 ? 0 : Math.PI; // facing OUTWARD, from the field-centre side toward the bar
        const fe = robotExtents(r);
        r.pos.x = bar * (10 - fe.front); // FRONT face starts at depth 10, well clear of the hive
        r.pos.y = 0; // dead centre of the low span -- 17.2 in clear of either foot
        r.vel.x = r.vel.y = 0;
        r.angVel = 0;
        const c = cmd({ driveY: 0.6 });
        let crossedOldFace = false;
        let minSpeedAfterCross = Infinity;
        let lastX = r.pos.x;
        for (let t = 0; t < 240; t++) {
          step3d(w, C.SIM_DT, new Map([[0, c]]));
          const frontDepth = bar * r.pos.x + fe.front; // the FRONT face's own depth toward the bar
          if (frontDepth > 22.9) crossedOldFace = true; // past the OLD box's inner face (|x|=22.75)
          if (crossedOldFace && frontDepth < 24.0) {
            const v = Math.abs(r.pos.x - lastX) / C.SIM_DT;
            if (v < minSpeedAfterCross) minSpeedAfterCross = v;
          }
          lastX = r.pos.x;
        }
        const finalDepth = bar * r.pos.x + fe.front;
        if (!crossedOldFace) crossFail += `${dt} bar ${bar}: never reached the old inner face (stuck at front depth ${finalDepth.toFixed(2)}); `;
        else if (minSpeedAfterCross < 3) crossFail += `${dt} bar ${bar}: stalled crossing the floor (min speed ${minSpeedAfterCross.toFixed(1)} in/s at front depth ${finalDepth.toFixed(2)}); `;
        else if (finalDepth > 24.9) crossFail += `${dt} bar ${bar}: drove THROUGH the flange to front depth ${finalDepth.toFixed(2)} -- flange is not solid; `;
        disposeEngineFor(w);
      }
    }
    check(
      "foot bar 3d: a chassis driven in from the field-centre side crosses the wide floor without stalling, and still stops at the drawn flange",
      crossFail === '',
      crossFail,
    );

    // (b) a ground POLLEN rolled across the same floor at several y (away from both feet) is not
    // deflected by anything -- it crosses at a steady speed, the way it would roll over a <0.1-in
    // seam.
    let rollFail = '';
    for (const y of [0, 8, -8]) {
      const w = mkWorld3dPair('free', 82);
      w.balls.length = 0;
      w.robots[0].pos = { x: 60, y: 60 };
      w.robots[1].pos = { x: 60, y: -60 };
      const v0 = 20;
      // starts just INSIDE the flange's own inner face (-24.07), i.e. already on the floor --
      // the flange itself is real, drawn structure and rolling a ball into IT is not this test.
      const b: Artifact = { id: 991, color: 'yellow', r: BB_POLLEN_R, state: { kind: 'ground' }, pos: { x: -23.9, y }, vel: { x: v0, y: 0 }, z: 0, vz: 0 };
      w.balls.push(b);
      let minSpeed = Infinity;
      for (let t = 0; t < 180; t++) {
        step3d(w, C.SIM_DT, new Map());
        const speed = Math.hypot(b.vel.x, b.vel.y);
        if (b.pos.x > -23 && b.pos.x < -21 && speed < minSpeed) minSpeed = speed;
      }
      if (!(b.pos.x > -19)) rollFail += `y=${y}: pollen stopped short at x=${b.pos.x.toFixed(2)} (started at -23.9, v0=${v0}); `;
      else if (minSpeed < v0 * 0.5) rollFail += `y=${y}: pollen lost more than half its speed crossing the floor (${minSpeed.toFixed(1)} vs v0 ${v0}); `;
      disposeEngineFor(w);
    }
    check(
      'foot bar 3d: a ground POLLEN rolled across the wide floor is not deflected -- nothing invisible for it to bounce off',
      rollFail === '',
      rollFail,
    );

    // (c) no safety-net containment fix was needed to do either of the above -- the invariant
    // holds structurally, not because a fallback quietly caught an embedded body.
    {
      const w = mkWorld3dPair('free', 83);
      w.balls.length = 0;
      w.robots[1].pos.x = -60;
      w.robots[1].pos.y = 60;
      const r = w.robots[0];
      r.fieldCentric = false;
      r.heading = Math.PI;
      // the FRONT EDGE spawned 0.83 in INSIDE where the old full-width box used to be solid
      // (x −24.73 … −22.75), 0.17 in short of the flange. This used to centre the robot at
      // −23.6, which put the whole chassis across the flange: it was lifted onto the bar
      // (z 2.15) and the check still passed, because it never read z.
      const x0 = -23.9 + robotExtents(r).front;
      r.pos.x = x0;
      r.pos.y = 0;
      r.vel.x = r.vel.y = 0;
      r.angVel = 0;
      for (let t = 0; t < 30; t++) step3d(w, C.SIM_DT, new Map([[0, cmd({})]]));
      const engine = engineFor(w);
      check(
        'foot bar 3d: a chassis spawned where the old box used to be solid needs no containment fix -- the floor is genuinely open',
        engine.containmentFixes === 0 && Math.abs(r.pos.x - x0) < 1 && Math.abs(r.z ?? 0) < 0.1,
        `containmentFixes=${engine.containmentFixes}, drifted to x=${r.pos.x.toFixed(2)} from ${x0.toFixed(2)}, z=${(r.z ?? 0).toFixed(3)}`,
      );
      disposeEngineFor(w);
    }
  }

  // ---- THE INVISIBLE CORNER (owner, 2026-09-21, fifth report: "this invisible corner in the
  // centre structure is STILL not fixed") -------------------------------------------------------
  //
  // The 2026-09-20 pass above narrowed the bar ACROSS its width and left it square in the other
  // two directions. Measured off the shipped GLB at 0.02 in (`scratch/footprofile2.ts`, and
  // `scratch/hivetop.ts` is the per-cell collider-top-vs-drawn-top table): the drawn assembly is
  // 0.24 in tall at the bar's own outer face and rises at 3.44 in per in to its 2.15-in plateau,
  // and it ENDS IN A RAMP -- 0.16 in at either end of the bar, rising at 2.144 in per in to full
  // height 0.92 in in. The flange box and both foot boxes ran square to both, so the outer 0.5 in
  // of each bar stood up to 1.91 in above the drawn bar for its whole 38.9-in length and each of
  // the centre structure's FOUR OUTER CORNERS carried a 1.94-in-tall block over a chamfer.
  //
  // A chassis is a floor-to-roof prism and is stopped by a 0.16-in lip exactly as by a 2.15-in
  // one, which is why the 2026-09-20 driving probes came back clean and the report survived them.
  // What it moved was everything with a HEIGHT. Hence the three shapes of check here: the RULE
  // (no piece stands above the drawn profile), the ELEMENT (nothing rests on the corner), and the
  // ROBOT (every stop position is exactly where it was -- the fix must move no robot at all).
  {
    // the measurement, stated here rather than imported, so the builder's own constants and this
    // profile have to AGREE instead of being one number read twice
    const DRAWN_NOSE_X = 0.24;
    const DRAWN_RISE_X = 3.44;
    const DRAWN_NOSE_Y = 0.16;
    const DRAWN_RISE_Y = 2.144;
    const DRAWN_TOP = 2.15;
    /** the drawn assembly's own top height at a point, in the bar's own frame: `dx` is the depth
     *  inward from the bar's true outer face, `dy` the depth inward from the nearer bar END. */
    const drawnTop = (dx: number, dy: number): number =>
      Math.min(DRAWN_TOP, DRAWN_NOSE_X + DRAWN_RISE_X * dx, DRAWN_NOSE_Y + DRAWN_RISE_Y * dy);

    const all = cadStatics();
    const rawBars = fieldColliders3d().statics.filter((s) => s.name.endsWith('_sheet_metal_foot_bar'));
    const aabb = (s: FieldStatic) => {
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < s.points.length; i += 3)
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k], s.points[i + k]);
          hi[k] = Math.max(hi[k], s.points[i + k]);
        }
      return { lo, hi };
    };
    // per bar: its true outer face and its own y extent, read off the RAW export (not off the
    // built pieces), so this check never learns its geometry from the thing it is checking
    const barOf = (name: string) => rawBars.find((b) => name.startsWith(b.name.replace(/sheet_metal_foot_bar$/, '')));

    /**
     * How far above the drawn assembly a piece stands, worst over the whole SOLID — and testing
     * its hull's VERTICES is enough to know that, not a sample of them: over a piece's own domain
     * `drawnTop` is a min of linear functions, i.e. CONCAVE, so if every vertex sits under it then
     * by Jensen every convex combination of them does too.
     */
    const riseOf = (s: FieldStatic): number => {
      const bar = barOf(s.name);
      if (!bar) return NaN;
      const b = aabb(bar);
      const outer = Math.abs(b.lo[0]) > Math.abs(b.hi[0]) ? b.lo[0] : b.hi[0];
      let worst = -Infinity;
      for (let i = 0; i < s.points.length; i += 3) {
        const dy = Math.min(Math.abs(s.points[i + 1] - b.lo[1]), Math.abs(s.points[i + 1] - b.hi[1]));
        worst = Math.max(worst, s.points[i + 2] - drawnTop(Math.abs(s.points[i] - outer), dy));
      }
      return worst;
    };

    const pieces = all.filter((s) => /_sheet_metal_foot_bar|_frame_foot_[ab]/.test(s.name));
    let worstRise = -Infinity;
    let worstName = '';
    for (const s of pieces) {
      const r = riseOf(s);
      if (r > worstRise) { worstRise = r; worstName = s.name; }
    }
    // TOL is the LIP's own allowance: the lip carries the part's full plan extent at
    // `FOOT_BAR_LIP_Z`, and the drawn nose at the very corner is 0.08 in, so a tenth is the
    // honest floor for a stack of vertical-faced boxes.
    const TOL = 0.1;
    check(
      'hive corner 3d: no centre-structure collider stands more than 0.1 in above the DRAWN assembly anywhere on its own footprint',
      Number.isFinite(worstRise) && worstRise <= TOL,
      `worst +${worstRise.toFixed(3)} in on ${worstName} (${pieces.length} pieces)`,
    );
    // ...and the shape this replaced fails that rule by two inches, so the check is not vacuous
    {
      let oldWorst = -Infinity;
      for (const bar of rawBars) {
        const b = aabb(bar);
        const outer = Math.abs(b.lo[0]) > Math.abs(b.hi[0]) ? b.lo[0] : b.hi[0];
        const inner = outer === b.lo[0] ? b.hi[0] : b.lo[0];
        for (let i = 0; i <= 20; i++)
          for (let j = 0; j <= 20; j++) {
            const x = outer + ((inner - outer) * i) / 20;
            const y = b.lo[1] + ((b.hi[1] - b.lo[1]) * j) / 20;
            const dy = Math.min(Math.abs(y - b.lo[1]), Math.abs(y - b.hi[1]));
            oldWorst = Math.max(oldWorst, b.hi[2] - drawnTop(Math.abs(x - outer), dy));
          }
      }
      check(
        'hive corner 3d: ...and the square-ended box it replaced stood ~2 in above it, so that rule is not vacuous',
        oldWorst > 1.8,
        `old worst +${oldWorst.toFixed(3)} in`,
      );
    }
    // ...AND IT IS STILL SIX PIECES, which is the other half of the fix. A collider COUNT is not
    // a local change -- every handle made after it shifts and Rapier's islands reorder -- and
    // MEASURED, the receding-box stack that was tried first flipped one edge-of-envelope case
    // 60 in away (the ramp ground-capture sweep's -7.65 offset) at 3, 4, 5 and 6 steps alike,
    // while these same six pieces with entirely different heights left it untouched.
    {
      let bad = '';
      const barPieces = all.filter((s) => s.name.endsWith('_sheet_metal_foot_bar'));
      const footPieces = all.filter((s) => /_frame_foot_[ab]$/.test(s.name));
      if (barPieces.length !== 2 || footPieces.length !== 4) bad += `${barPieces.length} bars + ${footPieces.length} feet, want 2 + 4; `;
      if (all.filter((s) => /_sheet_metal_foot_bar|_frame_foot_[ab]/.test(s.name)).length !== 6) bad += 'extra foot-bar pieces exist; ';
      // the bottom of every piece still carries the part's OWN full plan extent, which is the one
      // thing a floor-to-roof chassis can touch and is why the fix moves no robot at all
      for (const s of [...barPieces, ...footPieces]) {
        const p = aabb(s);
        let lo = [Infinity, Infinity];
        let hi = [-Infinity, -Infinity];
        for (let i = 0; i < s.points.length; i += 3) {
          if (s.points[i + 2] > p.lo[2] + 1e-9) continue; // the base section only
          lo = [Math.min(lo[0], s.points[i]), Math.min(lo[1], s.points[i + 1])];
          hi = [Math.max(hi[0], s.points[i]), Math.max(hi[1], s.points[i + 1])];
        }
        if (Math.abs(lo[0] - p.lo[0]) > 1e-9 || Math.abs(hi[0] - p.hi[0]) > 1e-9) bad += `${s.name}: base section lost x extent; `;
        if (Math.abs(lo[1] - p.lo[1]) > 1e-9 || Math.abs(hi[1] - p.hi[1]) > 1e-9) bad += `${s.name}: base section lost y extent; `;
      }
      check('hive corner 3d: still SIX foot-bar pieces, each one hull carrying its part full plan extent at the tiles', bad === '', bad);
    }

    // THE ELEMENT: a POLLEN set down where the old block's top was is on the tiles at the same
    // instant, at all four outer corners. 0.3 s, because free fall from 2.14 in is 0.105 s and
    // `groundRoll3d`'s ledge VIBRATION gets 30 ticks to shake a ball off a narrow hull -- reading
    // later would measure the workaround instead of the geometry. Pictures:
    // `scratch/shots/hivecorner-{before,after}-*-ball.png`.
    {
      let bad = '';
      for (const sx of [1, -1] as const)
        for (const sy of [1, -1] as const) {
          const w = mkWorld3dPair('free', 314);
          w.balls.length = 0;
          w.robots[0].pos = { x: 60, y: 60 };
          w.robots[1].pos = { x: 60, y: -60 };
          const b: Artifact = {
            id: 953, color: 'yellow', r: BB_POLLEN_R, state: { kind: 'ground' },
            pos: { x: sx * 23.74, y: sy * 19.25 }, vel: { x: 0, y: 0 }, z: 2.14, vz: 0,
          };
          w.balls.push(b);
          for (let t = 0; t < 18; t++) step3d(w, C.SIM_DT, new Map());
          if (b.z > 0.12) bad += `corner (${sx * 24.73}, ${sy * 19.47}): POLLEN still at z=${b.z.toFixed(2)}; `;
          disposeEngineFor(w);
        }
      check('hive corner 3d: a POLLEN set on any of the four outer corners falls -- nothing invisible holds it up', bad === '', bad);
    }

    // THE ROBOT: every stop position is unchanged, and each is ON drawn structure. Driving IN
    // from an alliance side stops on the bar's own outer face; driving OUT from under the hive
    // stops on the flange's inner face at mid-span and on the frame foot's at a corner.
    {
      const FACE_OUT = 24.73; // the bar's true outer face, both alliances
      const FACE_MID = 24.07; // the flange's inner face
      const FACE_END = 22.75; // the frame foot's inner face, near either end
      let bad = '';
      for (const bar of [1, -1] as const)
        for (const [label, y, want, outward] of [
          ['outer mid-span', 0, FACE_OUT, false],
          ['outer corner', 18.4, FACE_OUT, false],
          ['inner mid-span', 0, FACE_MID, true],
          ['inner corner', 18.4, FACE_END, true],
        ] as const) {
          const w = mkWorld3dPair('free', 12, { drivetrain: 'mecanum' });
          w.balls.length = 0;
          w.robots[1].pos.x = -62 * bar;
          w.robots[1].pos.y = 62;
          const r = w.robots[0];
          r.fieldCentric = false;
          // REAR-first, so the leading face is bare chassis (the `front` mount's reach is behind)
          r.heading = outward === (bar > 0) ? Math.PI : 0;
          r.pos.x = outward ? 0 : bar * 40;
          r.pos.y = bar * y;
          r.vel.x = r.vel.y = 0;
          r.angVel = 0;
          const cm = new Map([[0, cmd({ driveY: -1 })]]);
          for (let t = 0; t < 240; t++) step3d(w, C.SIM_DT, cm);
          const stop = outward ? Math.abs(r.pos.x) + robotExtents(r).rear : Math.abs(r.pos.x) - robotExtents(r).rear;
          if (Math.abs(stop - want) > 0.45) bad += `bar ${bar > 0 ? '+' : '-'} ${label}: stopped with its face at ${stop.toFixed(2)}, drawn structure is at ${want}; `;
          disposeEngineFor(w);
        }
      check(
        'hive corner 3d: a chassis still stops exactly on the drawn structure from every side -- the corner fix moved no robot',
        bad === '',
        bad,
      );
    }

    // AND THE 2D PIPELINE HAS NO INVISIBLE CORNER BY CONSTRUCTION: its two frame bars ARE the
    // rects `drawField.ts` fills (one construction, read twice), so there is nothing to slim.
    {
      const bars = biobuzzColliders.statics.slice(BB_WALL_COUNT, BB_WALL_COUNT + 2);
      const w = (BB_FRAME_BAR_OUT - BB_FRAME_BAR_IN) / 2;
      const mid = (BB_FRAME_BAR_IN + BB_FRAME_BAR_OUT) / 2;
      const drawnOk = bars.every(
        (s) => Math.abs(s.hx - w) < 1e-9 && Math.abs(Math.abs(s.tx) - mid) < 1e-9 && Math.abs(s.hy - BB_FRAME_Y) < 1e-9 && s.rot === 0,
      );
      check(
        '2D centre structure: each frame-bar collider IS the rect drawField fills, so the 2D hive has no invisible corner to slim',
        bars.length === 2 && drawnOk,
        bars.map((s) => `hx=${s.hx} hy=${s.hy} tx=${s.tx}`).join(' | '),
      );
      let bad = '';
      for (const bar of [1, -1] as const)
        for (const [label, y, want, outward] of [
          ['outer mid-span', 0, BB_FRAME_BAR_OUT, false],
          ['outer corner', 18.4, BB_FRAME_BAR_OUT, false],
          ['inner corner', 18.4, BB_FRAME_BAR_IN, true],
        ] as const) {
          const wd = mkWorld('free', 12, { drivetrain: 'mecanum' });
          wd.balls.length = 0;
          const r = wd.robots[0];
          r.fieldCentric = false;
          r.heading = outward === (bar > 0) ? Math.PI : 0;
          r.pos.x = outward ? 0 : bar * 40;
          r.pos.y = bar * y;
          r.vel.x = r.vel.y = 0;
          r.angVel = 0;
          const cm = new Map([[0, cmd({ driveY: -1 })]]);
          for (let t = 0; t < 240; t++) biobuzzStep(wd, C.SIM_DT, cm);
          const stop = outward ? Math.abs(r.pos.x) + robotExtents(r).rear : Math.abs(r.pos.x) - robotExtents(r).rear;
          if (Math.abs(stop - want) > 0.45) bad += `bar ${bar > 0 ? '+' : '-'} ${label}: stopped with its face at ${stop.toFixed(2)} against a drawn face at ${want}; `;
        }
      check('2D centre structure: a chassis stops flush on the drawn frame bar from either side, mid-span and at a corner', bad === '', bad);
    }
  }

  // ---- THE INVISIBLE ROBOT (owner, 2026-09-21, SIXTH report of the invisible corner: "try
  // putting the front of the robot against the center of the horizontal beam, and strafe, from
  // under the hive. You will suddenly turn because you hit something invisible.")
  //
  // Five passes looked at the FIELD. The invisible thing was the ROBOT: `chassis3dShapes` built
  // the frame, both intake arms, the lintel and the pocket filler at the FULL `heightIn` across
  // the whole footprint — a floor-to-roof prism — where the DRAWN robot is a 5.3-in chassis with
  // a turret standing up only where it is mounted. The compound is the drawn profile now, and
  // these are the three checks that bind it: the RULE (no contact happens in air), the REPRO
  // (the owner's own manoeuvre, swept), and the ELEMENT (a POLLEN that lands on the real deck).
  {
    /** distance from a robot-frame point to the DRAWN robot solid — the low prism over the whole
     * plan envelope up to `BB3_CHASSIS_TOP_Z`, plus each standing mechanism's own drawn solid
     * (`bbMechEnvelopes`). Zero inside any of them. This is the number the rule bounds.
     *
     * ⚠️ A MOVING PART IS ITS SWEPT ENVELOPE, and that is the definition, not a fudge: the
     * compound is built once per deploy edge while the turret yaws every tick, so the disc a head
     * sweeps IS its drawn geometry — the same bargain `bbRampSwingShapes` already makes. */
    const over1 = (v: number, lo: number, hi: number): number => Math.max(0, Math.max(lo - v, v - hi));
    const clamp1 = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
    /**
     * ⚠️ **THE METRIC IS THE HEIGHT ABOVE THE DRAWN SILHOUETTE, AND THE PLAN POINT IS CLAMPED
     * INTO THE FOOTPRINT FIRST.** This rule is about HEIGHT — it exists because a chassis was
     * solid 8.8 in above anything drawn — and a contact point does not sit on the collider's own
     * face: the edge break (`chassisBoxDesc`) shrinks each box and gives it a CONTACT SKIN, and
     * Rapier's speculative margin looks ahead of the surface, so a point on a flat wall sits up
     * to 0.38 in outside the plan envelope at an arm tip's corner (MEASURED, 171,217 contacts,
     * `scratch/aircontact.ts` — a LATERAL artefact with zero height component). Clamping into the
     * envelope keeps that out of a number it has nothing to do with; `PLAN_GUARD` below still
     * bounds it so a genuine lateral blow-up cannot hide here.
     */
    const airAbove = (spec: RobotSpec, h: number, x: number, y: number, z: number): number => {
      const ex = chassis3dPlanEnvelope(spec);
      const cx = clamp1(x, -ex.back, ex.front);
      const cy = clamp1(y, -ex.right, ex.left);
      let top = BB3_CHASSIS_TOP_Z;
      for (const e of bbMechEnvelopes(spec, h)) {
        const inside =
          e.r !== undefined
            ? Math.hypot(cx - e.cx, cy - e.cy) <= e.r
            : Math.abs(cx - e.cx) <= (e.hx ?? 0) && Math.abs(cy - e.cy) <= (e.hy ?? 0);
        if (inside) top = Math.max(top, e.top);
      }
      return z - top;
    };
    /** how far outside the PLAN envelope a contact point may sit — the lateral half of the same
     * skin/speculative allowance, bounded so it cannot grow unnoticed. */
    const planOut = (spec: RobotSpec, x: number, y: number): number => {
      const ex = chassis3dPlanEnvelope(spec);
      return Math.hypot(over1(x, -ex.back, ex.front), over1(y, -ex.right, ex.left));
    };
    /** the worst active contact-in-air on robot 0 right now, against a FIXED collider: how far
     * ABOVE the drawn silhouette it is, and how far outside the plan envelope. */
    const worstAir = (w: World): { air: number; out: number } => {
      const e = engineFor(w);
      const r = w.robots[0];
      const body = robotBodyOf(e, r.id);
      if (!body) return 0;
      const h = bbHeightNow(w, r.spec);
      const ch = Math.cos(-r.heading);
      const sh = Math.sin(-r.heading);
      let air = 0;
      let out = 0;
      for (let i = 0; i < body.numColliders(); i++) {
        e.world3d.contactPairsWith(body.collider(i), (o) => {
          const par = o.parent();
          if (!par || !par.isFixed()) return;
          const he = (o as unknown as { halfExtents?: () => { x: number } }).halfExtents?.();
          if (he && he.x > 500) return; // the tile plane itself
          e.world3d.contactPair(body.collider(i), o, (m) => {
            const mm = m as unknown as { numSolverContacts(): number; solverContactPoint(i: number): { x: number; y: number; z: number } | null };
            for (let k = 0; k < mm.numSolverContacts(); k++) {
              const p = mm.solverContactPoint(k);
              if (!p) continue;
              const dx = p.x - r.pos.x;
              const dy = p.y - r.pos.y;
              const lx = dx * ch - dy * sh;
              const ly = dx * sh + dy * ch;
              air = Math.max(air, airAbove(r.spec, h, lx, ly, p.z - (r.z ?? 0)));
              out = Math.max(out, planOut(r.spec, lx, ly));
            }
          });
        });
      }
      return { air, out };
    };

    /**
     * ── THE RULE: NO CONTACT HAPPENS IN AIR ────────────────────────────────────────────────
     * Drive and strafe through a grid of poses around the centre structure, at a FLOWER and at a
     * wall, and require every active chassis/static contact point to lie within `AIR_TOL` of the
     * DRAWN robot.
     *
     * ⚠️ **THE TOLERANCE IS 0.3 IN AND IT IS BUILT, NOT PICKED.** A solver contact point is not
     * on the collider's own face: `chassisBoxDesc` shrinks each box by `BB3_INTAKE_CORNER_R` and
     * gives it a CONTACT SKIN of the same (0.15), Rapier's speculative margin looks ahead of the
     * surface, and `BB3_CHASSIS_TOP_Z` itself sits 0.04 in over the tallest drawn chassis part.
     * 0.3 covers all three with room and is an order of magnitude under what this is looking for.
     * MEASURED over 171,217 sampled contacts across five builds (`scratch/aircontact.ts`): worst
     * **0.377** in against the *plan* envelope at an arm tip's outboard corner near the tiles —
     * a lateral skin artefact, not a height one — and the same sweep restricted to the poses this
     * check runs reads well inside 0.3.
     */
    const AIR_TOL = 0.3;
    /** the LATERAL half of the same allowance — measured worst 0.377, bounded here. */
    const PLAN_GUARD = 0.45;
    {
      let worst = -1e9;
      let worstOut = 0;
      let where = '';
      const STARTS: [number, number, number][] = [
        [34, -12, Math.PI], [34, 0, Math.PI], [34, 12, Math.PI],
        [-34, -12, 0], [-34, 0, 0], [-34, 12, 0],
        [0, 34, -Math.PI / 2], [0, -34, Math.PI / 2],
        [-47, -17, Math.PI], [47, 17, 0],
        [55, 0, 0], [0, 55, Math.PI / 2],
      ];
      for (const [sx, sy, hdg] of STARTS)
        for (const c of [{ driveY: 1 }, { driveY: 1, driveX: 1 }, { driveY: 0.5, driveX: -1 }]) {
          const w = mkWorld3d('free', 93, { intakeMount: 'front' });
          w.balls.length = 0;
          const r = w.robots[0];
          r.fieldCentric = false;
          r.pos = { x: sx, y: sy };
          r.heading = hdg;
          r.vel = { x: 0, y: 0 };
          r.angVel = 0;
          const cm = new Map([[0, cmd({ leftDrive: 1, rightDrive: 1, ...c })]]);
          for (let t = 0; t < 150; t++) {
            step3d(w, C.SIM_DT, cm);
            if (t % 5 === 0) {
              const { air, out } = worstAir(w);
              worstOut = Math.max(worstOut, out);
              if (air > worst) {
                worst = air;
                where = `(${sx},${sy}) ${JSON.stringify(c)} t=${t}`;
              }
            }
          }
          disposeEngineFor(w);
        }
      check(
        `invisible robot: no chassis/static contact happens more than ${AIR_TOL} in above the DRAWN robot, anywhere round the centre structure, the flowers or the walls`,
        worst <= AIR_TOL && worstOut <= PLAN_GUARD,
        `worst ${worst.toFixed(3)} in above at ${where}; worst ${worstOut.toFixed(3)} in outside the plan envelope`,
      );
    }

    /**
     * ── AND THE PRISM IT REPLACED FAILS THE SAME RULE, SO THE RULE IS NOT VACUOUS ──────────
     * `__setLegacyPrismForTests` rebuilds the chassis as the floor-to-`heightIn` box it was; the
     * owner's own manoeuvre then puts a contact 8.5 in above anything drawn.
     */
    {
      const run = (legacy: boolean): { air: number; travel: number; yaw: number } => {
        __setLegacyPrismForTests(legacy);
        try {
          const w = mkWorld3d('free', 11, { drivetrain: 'mecanum', intakeMount: 'front', heightIn: 14 });
          w.balls.length = 0;
          const r = w.robots[0];
          r.fieldCentric = false;
          r.pos = { x: 8, y: 0 };
          r.heading = 0;
          r.vel = { x: 0, y: 0 };
          r.angVel = 0;
          for (let t = 0; t < 90; t++) step3d(w, C.SIM_DT, new Map([[0, cmd({ driveY: 1, leftDrive: 1, rightDrive: 1 })]]));
          const h0 = r.heading;
          const y0 = r.pos.y;
          let travel = -1;
          let air = -1e9;
          const cm = new Map([[0, cmd({ driveY: 0.5, driveX: -1, leftDrive: 0.5, rightDrive: 0.5 })]]);
          for (let t = 0; t < 300; t++) {
            step3d(w, C.SIM_DT, cm);
            air = Math.max(air, worstAir(w).air);
            if (travel < 0 && Math.abs(r.heading - h0) > Math.PI / 180) travel = Math.abs(r.pos.y - y0);
          }
          const out = { air, travel: travel < 0 ? Math.abs(r.pos.y - y0) : travel, yaw: Math.abs((r.heading - h0) * 180) / Math.PI };
          disposeEngineFor(w);
          return out;
        } finally {
          __setLegacyPrismForTests(false);
        }
      };
      const legacy = run(true);
      const now = run(false);
      check(
        'invisible robot: the owner repro — strafing along the hive foot bar from under the hive, the chassis now touches only DRAWN structure, where the prism caught air',
        legacy.air > 3 && now.air <= AIR_TOL && now.travel > legacy.travel,
        `prism air ${legacy.air.toFixed(2)} in / travel ${legacy.travel.toFixed(2)} in ; drawn air ${now.air.toFixed(3)} in / travel ${now.travel.toFixed(2)} in`,
      );
    }

    /**
     * ── THE ELEMENT: A POLLEN CAN LAND ON THE REAL DECK NOW ───────────────────────────────
     * With the prism it landed on an invisible roof at `heightIn`. On the drawn deck it RESTS
     * (a deck is genuinely broad and flat — `groundRoll3d` keeps a `Cuboid` contact BROAD), it is
     * never tagged and never captured (its bottom sits at `BB3_CHASSIS_TOP_Z` 5.3, above
     * `BB3_INTAKE_Z` 5, and it is inside the frame rather than in a mouth rect), it is conserved,
     * and it falls the moment the robot drives out from under it. A POLLEN perched on the
     * TURRET's swept disc is a different answer on purpose: a cylinder is NARROW to `groundRoll3d`
     * now, so it vibrates off the way it does off any other round part.
     */
    {
      const drop = (dx: number, dy: number, drive: boolean): { z: number; kind: string; n: number; captured: boolean } => {
        const w = mkWorld3d('free', 94, { intakeMount: 'front' });
        w.balls.length = 0;
        const r = w.robots[0];
        r.fieldCentric = false;
        r.pos = { x: 0, y: -30 };
        r.heading = 0;
        r.vel = { x: 0, y: 0 };
        r.angVel = 0;
        const id = 9001;
        w.balls.push({
          id,
          pos: { x: r.pos.x + dx, y: r.pos.y + dy },
          vel: { x: 0, y: 0 },
          z: BB3_CHASSIS_TOP_Z + 2,
          vz: 0,
          r: BB_POLLEN_R,
          color: 'yellow',
          state: { kind: 'ground' },
        } as unknown as Artifact);
        const still = new Map([[0, cmd({})]]);
        const fwd = new Map([[0, cmd({ driveY: 1, leftDrive: 1, rightDrive: 1, intake: true })]]);
        let captured = false;
        for (let t = 0; t < 420; t++) {
          step3d(w, C.SIM_DT, t < 90 || !drive ? still : fwd);
          if (r.hopper.includes(id)) captured = true;
        }
        const b = w.balls.find((x) => x.id === id)!;
        const out = { z: b.z, kind: b.state.kind, n: w.balls.length, captured };
        disposeEngineFor(w);
        return out;
      };
      const deck = drop(6.2, 6.8, false);
      const deckAway = drop(6.2, 6.8, true);
      const turret = drop(-1.5, 1.2, false);
      check(
        'invisible robot: a POLLEN set down on the drawn DECK rests on it, is never captured or tagged, is conserved, and falls when the robot drives away',
        Math.abs(deck.z - BB3_CHASSIS_TOP_Z) < 0.1 &&
          deck.kind === 'ground' &&
          !deck.captured &&
          deck.n === 1 &&
          deckAway.z < 0.1 &&
          deckAway.n === 1 &&
          !deckAway.captured,
        `still z=${deck.z.toFixed(2)} ${deck.kind} captured=${deck.captured}; drove away z=${deckAway.z.toFixed(2)} captured=${deckAway.captured}`,
      );
      check(
        'invisible robot: a POLLEN perched on the TURRET’s swept disc vibrates off it — a cylinder is a round part, not a shelf',
        turret.z < 0.1 && turret.n === 1,
        `z=${turret.z.toFixed(2)} kind=${turret.kind}`,
      );
    }

    /**
     * ── THE BOX TUBE TOWER IS SOLID, AND IT IS NOT A SHELF (2026-09-22) ─────────────────────
     * The stowed tower stands 7 in above the deck, so it is two collider boxes
     * (`bbBoxTubeEnvelopes`). As square boxes they were a SHELF: a POLLEN dropped on the 1.3-in
     * top balanced at z 11.68 for the whole run. They are ROUNDED boxes now, which `groundRoll3d`
     * counts as narrow, so the ball rolls off — and at no tick is it inside the column.
     */
    {
      const LIFT = {
        intakeMount: 'front',
        bbMech: { launcher: { kind: 'turret', mount: 'center', hoodDeg: 75 }, lift: { kind: 'vslide', mount: 'back' }, intake: { kind: 'sweeper' } },
      } as unknown as Partial<RobotSpec>;
      let perched = 0;
      let inside = 0;
      let lost = 0;
      let top = 0;
      for (const [dx, dy] of [[0, 0], [0.3, 0.2], [-0.4, -0.3], [0, -0.7]] as const) {
        const w = mkWorld3d('free', 94, LIFT);
        w.balls.length = 0;
        const r = w.robots[0];
        r.fieldCentric = false;
        r.pos = { x: 0, y: -30 };
        r.heading = 0;
        r.vel = { x: 0, y: 0 };
        r.angVel = 0;
        const col = bbMechEnvelopes(r.spec, bbHeightNow(w, r.spec)).find((e) => e.what === 'liftColumn')!;
        top = col.top;
        w.balls.push({
          id: 9002,
          pos: { x: r.pos.x + col.cx + dx, y: r.pos.y + col.cy + dy },
          vel: { x: 0, y: 0 },
          z: col.top + 1.5,
          vz: 0,
          r: BB_POLLEN_R,
          color: 'yellow',
          state: { kind: 'ground' },
        } as unknown as Artifact);
        const still = new Map([[0, cmd({})]]);
        for (let t = 0; t < 420; t++) {
          step3d(w, C.SIM_DT, still);
          const b = w.balls[0];
          const lx = b.pos.x - r.pos.x - col.cx;
          const ly = b.pos.y - r.pos.y - col.cy;
          if (b && Math.abs(lx) < (col.hx ?? 0) && Math.abs(ly) < (col.hy ?? 0) && b.z + BB_POLLEN_R < col.top - 0.3 && b.z > (col.bottom ?? 0)) inside++;
        }
        if (w.balls.length !== 1) lost++;
        else if (w.balls[0].z > BB3_CHASSIS_TOP_Z + 0.5) perched++;
        disposeEngineFor(w);
      }
      check(
        'box tube 3d: a POLLEN dropped on the stowed tower never passes into it, and rolls off rather than balancing on its top',
        inside === 0 && perched === 0 && lost === 0,
        `${perched} of 4 still perched above the deck, ${inside} ticks inside the column, ${lost} lost (column top ${top.toFixed(2)})`,
      );
    }
  }

  // ---- the parts bolted to the TRAY tip with it in the physics too ---------------------------
  //
  // The exporter files the Churro cross-braces and the pivot hardware under the static frame; the
  // renderer carries them on the tilting group. As fixed statics they stayed at the STEP's
  // captured pose, so after a tip an element could strike a brace drawn 20 in away.
  {
    const rider = /_(10_5in_churro_lite|goal_pivot_bracket|pivot_damper_holder|blumotion_970a_damper)(_\d+)?$/;
    const left = cadStatics().filter((st) => rider.test(st.name));
    let bad = '';
    for (const a of ['red', 'blue'] as const) {
      const riders = cadTrayRiders(a);
      if (riders.length !== 10) bad += `${a}: ${riders.length} riders; `;
      // mirror-symmetric about the pivot in the TRAY's frame is what "bolted to the tray" means:
      // the four braces sit at the same |v| and the same w, which they do not in the world frame
      const braces = riders
        .filter((h) => h.name.includes('churro'))
        .map((h) => {
          let v = 0;
          let wz = 0;
          for (let i = 0; i < h.points.length; i += 3) {
            v += h.points[i + 1];
            wz += h.points[i + 2];
          }
          const n = h.points.length / 3;
          return { v: v / n, w: wz / n };
        });
      const v0 = Math.abs(braces[0]?.v ?? 0);
      const w0 = braces[0]?.w ?? 0;
      if (braces.length !== 4 || braces.some((b) => Math.abs(Math.abs(b.v) - v0) > 0.05 || Math.abs(b.w - w0) > 0.05)) {
        bad += `${a}: braces ${braces.map((b) => `${b.v.toFixed(2)}/${b.w.toFixed(2)}`).join(' ')}; `;
      }
    }
    check(
      'tray riders 3d: the cross-braces and pivot hardware are on the tray body, un-tilted and mirror-symmetric, and none is left a fixed static',
      left.length === 0 && bad === '',
      bad || `${left.length} left static`,
    );
  }

  // =============================================================================================
  // ARCHETYPE REACH HARDWARE IS SOLID (owner, 2026-09-20: "It should be a collider.") ------------
  // `chassis3dReachShapes` (`bodies.ts`) puts a settled ramp's crossbar/rails AND (owner ruling,
  // 2026-09-20: "it should also be colliding with everything") a side roller's own wheel into the
  // DEFAULT collision group (meets an ELEMENT too, as a solid CYLINDER now) in the authority AND
  // both predictors — see that function's own header for the geometry and
  // `docs/area/biobuzz.md`'s rewritten bullet for the summary.
  // =============================================================================================
  // (`bbArchSpec`, module scope: the PERF lane's archetype fixture builds with it too)

  // (a) A side-roller robot driven into a wall stops with the WHEEL BOXES' faces on the wall —
  // frame + `bbIntakeReach` + `BB_SIDE_ROLLER_OUT` + `BB_SIDE_ROLLER_R` off — and a `sweeper`
  // build in the same rig still goes flush at the bare footprint, unaffected.
  {
    const driveIntoWall = (kind: 'sweeper' | 'siderollers'): number => {
      const w = mkWorld3d('free', 8100, bbArchSpec(kind, 'front'));
      w.balls.length = 0;
      const r = w.robots[0];
      // start CLOSE to the +x wall and drive further in — the same rig the "flat-wall rest
      // distance" check above uses, so nothing in the middle of the field (the HIVE, a FLOWER
      // support) is crossed on the way.
      r.pos = { x: BB_HALF_X - 30, y: 0 };
      r.heading = 0;
      r.vel = { x: 0, y: 0 };
      r.angVel = 0;
      run3d(w, new Map([[0, cmd({ driveY: 1, leftDrive: 1, rightDrive: 1 })]]), 4);
      const gap = BB_HALF_X - w.robots[0].pos.x;
      disposeEngineFor(w);
      return gap;
    };
    const sweeperGap = driveIntoWall('sweeper');
    const sideGap = driveIntoWall('siderollers');
    const spec = bbCoerce({ ...bbArchSpec('siderollers', 'front') });
    const wantSweeper = bbFootprint(bbCoerce(bbArchSpec('sweeper', 'front'))).front;
    const wantSide = bbFootprint(spec).front + BB_SIDE_ROLLER_OUT + BB_SIDE_ROLLER_R;
    console.log(
      `[smoke-bb sim3d] wall standoff: sweeper ${sweeperGap.toFixed(4)} (want ${wantSweeper.toFixed(4)}) · ` +
        `siderollers ${sideGap.toFixed(4)} (want ${wantSide.toFixed(4)}, extra ${(sideGap - sweeperGap).toFixed(4)} of a wanted ${(wantSide - wantSweeper).toFixed(4)})`,
    );
    check(
      'archetype 3d: a SWEEPER driven flat into a wall still stops flush at the bare footprint',
      Math.abs(sweeperGap - wantSweeper) < 0.1,
      `gap ${sweeperGap.toFixed(4)} vs ${wantSweeper.toFixed(4)}`,
    );
    check(
      'archetype 3d: SIDE ROLLERS driven flat into a wall stand the chassis off by the wheel boxes, not the bare footprint',
      Math.abs(sideGap - wantSide) < 0.1,
      `gap ${sideGap.toFixed(4)} vs ${wantSide.toFixed(4)} (bare footprint would be ${wantSweeper.toFixed(4)})`,
    );
  }

  // (c) A ground POLLEN still enters the mouth BETWEEN the side rollers and is captured — the
  // wheels straddle it (`config.ts`'s own geometry note); they do not close the mouth.
  {
    const capture = (kind: 'sweeper' | 'siderollers'): boolean => {
      const w = mkWorld3d('free', 8110, bbArchSpec(kind, 'front'));
      const r = w.robots[0];
      for (const b of w.balls) if (b.state.kind === 'held' && b.state.robot === r.id) b.state = { kind: 'stock', alliance: r.alliance };
      r.hopper = [];
      r.autoIntake = false;
      r.autoFire = false;
      r.pos = { x: -8, y: 0 };
      r.heading = 0;
      r.vel = { x: 0, y: 0 };
      r.angVel = 0;
      w.balls.length = 0;
      w.balls.push({ id: 9001, color: 'yellow', r: BB_POLLEN_R, state: { kind: 'ground' }, pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 }, z: 0, vz: 0 });
      run3d(w, new Map([[0, cmd({ driveY: 1, leftDrive: 1, rightDrive: 1, intake: true })]]), 3);
      const took = r.hopper.length > 0;
      disposeEngineFor(w);
      return took;
    };
    check(
      'archetype 3d: a ground POLLEN driven straight at the mouth is still CAPTURED with a SWEEPER',
      capture('sweeper'),
    );
    check(
      'archetype 3d: a ground POLLEN driven straight at the mouth is still CAPTURED between the SIDE ROLLERS',
      capture('siderollers'),
    );
  }

  // (c2) HEAD-ON WHEEL PROBE (owner ruling 2026-09-20: "it should also be colliding with
  // everything ... a physical thing" — a POLLEN meeting a wheel head-on is pushed/deflected,
  // never tunnels, the same "never crosses" claim the ramp's own bar probe makes).
  {
    const w = mkWorld3d('free', 8115, bbArchSpec('siderollers', 'front'));
    w.balls.length = 0;
    const r = w.robots[0];
    r.pos = { x: -40, y: 0 };
    r.heading = 0;
    r.vel = { x: 0, y: 0 };
    r.angVel = 0;
    const ax = mouthAxes(bbMouths(r.spec)[0], r.spec.length / 2, r.spec.width / 2);
    const wy = bbSideRollerY(ax.half);
    // heading 0: n = (1,0), p = (0,1), so the wheel's LOCAL (u, v) offset is a plain (x, y) one
    const wheelX = r.pos.x + ax.uOut + BB_SIDE_ROLLER_OUT;
    const wheelY = r.pos.y + wy;
    w.balls.push({
      id: 9101,
      color: 'yellow',
      r: BB_POLLEN_R,
      state: { kind: 'ground' },
      pos: { x: wheelX + 15, y: wheelY },
      vel: { x: -30, y: 0 },
      z: 0,
      vz: 0,
    });
    for (let t = 0; t < 180; t++) step3d(w, 1 / 60, new Map());
    const ball = w.balls.find((b) => b.id === 9101)!;
    const crossed = ball.pos.x < wheelX - BB_SIDE_ROLLER_R - 0.5;
    console.log(
      `[smoke-bb sim3d] side-roller wheel probe: fired from (${(wheelX + 15).toFixed(2)},${wheelY.toFixed(2)}) at 30in/s toward the wheel at ` +
        `(${wheelX.toFixed(2)},${wheelY.toFixed(2)}), ended at (${ball.pos.x.toFixed(2)},${ball.pos.y.toFixed(2)})`,
    );
    check(
      'archetype 3d: a 30 in/s ground POLLEN fired head-on at a SIDE-ROLLER wheel is deflected, never crosses it',
      !crossed,
      `final x=${ball.pos.x.toFixed(2)} wheel x=${wheelX.toFixed(2)} crossed=${crossed}`,
    );
    disposeEngineFor(w);
  }

  // (c2b) THE WEDGE PROBE — a ball fired at the deployed ramp's plane never crosses it EXCEPT
  // over the crest (the whole point of a wedge over a flat crossbar): fired LOW (below the crest,
  // at the leading edge's own height) it must stop/deflect; fired ABOVE the crest's own height —
  // clear of the mid plate ceiling in open field, where there is nothing else to hit — it passes
  // straight through open air over the top, which is not a tunnel, it is the wedge simply not
  // being that tall.
  {
    const probeAt = (fireZ: number): { crossed: boolean; finalX: number; wallX: number } => {
      const w = mkWorld3d('free', 8118, bbArchSpec('ramp', 'front'));
      w.balls.length = 0;
      const r = w.robots[0];
      r.pos = { x: -40, y: 0 };
      r.heading = 0;
      r.vel = { x: 0, y: 0 };
      r.angVel = 0;
      step3d(w, 1 / 60, new Map([[0, cmd({ bbRamp: true })]]));
      const deploySteps = Math.round(BB_RAMP_DEPLOY_S / (1 / 60)) + 2;
      for (let t = 0; t < deploySteps; t++) step3d(w, 1 / 60, new Map());
      const ax = mouthAxes(bbMouths(r.spec)[0], r.spec.length / 2, r.spec.width / 2);
      const wallX = r.pos.x + ax.uOut + (BB_RAMP_OUT + BB_RAMP_IN) / 2; // the blade's own mid-span
      w.balls.push({
        id: 9102,
        color: 'yellow',
        r: BB_POLLEN_R,
        state: { kind: 'ground' },
        pos: { x: wallX + 15, y: 0 },
        vel: { x: -30, y: 0 },
        z: fireZ - BB_POLLEN_R,
        vz: 0,
      });
      for (let t = 0; t < 180; t++) step3d(w, 1 / 60, new Map());
      const ball = w.balls.find((b) => b.id === 9102)!;
      disposeEngineFor(w);
      return { crossed: ball.pos.x < wallX - 1, finalX: ball.pos.x, wallX };
    };
    // low: fired with its CENTRE at the blade's own deck height — squarely into its solid
    // body, not skimming over it.
    const low = probeAt(BB_RAMP_DECK_Z);
    check(
      'archetype 3d: a 30 in/s ground POLLEN fired at the deployed BLADE (low, at the deck\'s own height) never crosses it',
      !low.crossed,
      `final x=${low.finalX.toFixed(2)} blade x=${low.wallX.toFixed(2)} crossed=${low.crossed}`,
    );
  }

  // (c3) CAPTURE-RATE SWEEP vs the SWEEPER build, over lateral offsets across the mouth — a
  // POLLEN lined up on a wheel is deflected by the now-solid cylinder; off a wheel it is captured
  // exactly like a SWEEPER (the wheels straddle the open pocket, they do not close the mouth).
  {
    const probeSpec = bbCoerce(bbArchSpec('sweeper', 'front'));
    const half = mouthAxes(bbMouths(probeSpec)[0], probeSpec.length / 2, probeSpec.width / 2).half;
    const wy = bbSideRollerY(half);
    const offsets = [-half * 0.7, -wy, -wy * 0.5, 0, wy * 0.5, wy, half * 0.7];
    const runCapture = (kind: 'sweeper' | 'siderollers', offsetY: number): boolean => {
      const w = mkWorld3d('free', 8117, bbArchSpec(kind, 'front'));
      const r = w.robots[0];
      for (const b of w.balls) if (b.state.kind === 'held' && b.state.robot === r.id) b.state = { kind: 'stock', alliance: r.alliance };
      r.hopper = [];
      r.autoIntake = false;
      r.autoFire = false;
      r.pos = { x: -8, y: 0 };
      r.heading = 0;
      r.vel = { x: 0, y: 0 };
      r.angVel = 0;
      w.balls.length = 0;
      w.balls.push({ id: 9102, color: 'yellow', r: BB_POLLEN_R, state: { kind: 'ground' }, pos: { x: 0, y: offsetY }, vel: { x: 0, y: 0 }, z: 0, vz: 0 });
      run3d(w, new Map([[0, cmd({ driveY: 1, leftDrive: 1, rightDrive: 1, intake: true })]]), 3);
      const took = r.hopper.length > 0;
      disposeEngineFor(w);
      return took;
    };
    const rows = offsets.map((off) => ({ off, sweeper: runCapture('sweeper', off), side: runCapture('siderollers', off) }));
    console.log(
      `[smoke-bb sim3d] capture-rate sweep (offset: sweeper/siderollers): ` +
        rows.map((r) => `${r.off.toFixed(2)}: ${r.sweeper ? 'Y' : 'n'}/${r.side ? 'Y' : 'n'}`).join('  '),
    );
    const offWheel = rows.filter((r) => Math.abs(Math.abs(r.off) - wy) > BB_SIDE_ROLLER_R + 1);
    check(
      'archetype 3d: a SWEEPER captures a ground POLLEN across the whole tested mouth width',
      rows.every((r) => r.sweeper),
      JSON.stringify(rows),
    );
    check(
      'archetype 3d: SIDE ROLLERS capture an OFF-WHEEL offset exactly like a SWEEPER does',
      offWheel.every((r) => r.side === r.sweeper),
      JSON.stringify(rows),
    );
  }

  // (c4) THE RAMP'S OWN GROUND-CAPTURE SWEEP — the blade is a solid deck across the whole mouth
  // now (`config.ts`'s "THE DEPLOYABLE RAMP": one level box, `BB_RAMP_IN` .. `BB_RAMP_OUT`), so a
  // POLLEN on open tiles has to ride OVER it to be taken. It still is, at every offset the sweeper
  // takes one at; and with the intake OFF the blade PUSHES it rather than swallowing it.
  {
    const probeSpec = bbCoerce(bbArchSpec('sweeper', 'front'));
    const half = mouthAxes(bbMouths(probeSpec)[0], probeSpec.length / 2, probeSpec.width / 2).half;
    const offsets = [-0.9, -0.7, -0.5, -0.25, -0.1, 0.1, 0.25, 0.5, 0.7, 0.9].map((f) => f * half);
    const runRamp = (offsetY: number, intake: boolean): { took: boolean; moved: number } => {
      const w = mkWorld3d('match', 8119, bbArchSpec('ramp', 'front'));
      w.match.phase = 'teleop';
      w.match.phaseTimeLeft = 90;
      const r = w.robots[0];
      for (const b of w.balls) if (b.state.kind === 'held' && b.state.robot === r.id) b.state = { kind: 'stock', alliance: r.alliance };
      r.hopper = [];
      r.autoIntake = false;
      r.autoFire = false;
      // OUT IN THE OPEN, clear of the HIVE: the swing guard REVERSES a deploy that would carry
      // the ramp into a fixed static, and the hive frame stands over the field's own centre.
      r.pos = { x: -50, y: 34 };
      r.heading = 0;
      r.vel = { x: 0, y: 0 };
      r.angVel = 0;
      w.balls.length = 0;
      // deploy and settle the ramp IN THE OPEN before driving (the swing guard's own rule)
      step3d(w, 1 / 60, new Map());
      step3d(w, 1 / 60, new Map([[0, cmd({ bbRamp: true })]]));
      for (let t = 0; t < Math.round(BB_RAMP_DEPLOY_S * 60) + 3; t++) step3d(w, 1 / 60, new Map());
      const x0 = -38;
      w.balls.push({ id: 9103, color: 'yellow', r: BB_POLLEN_R, state: { kind: 'ground' }, pos: { x: x0, y: 34 + offsetY }, vel: { x: 0, y: 0 }, z: 0, vz: 0 });
      run3d(w, new Map([[0, cmd({ driveY: 1, leftDrive: 1, rightDrive: 1, intake })]]), 3);
      const took = r.hopper.length > 0;
      const ball = w.balls.find((b) => b.id === 9103);
      const moved = ball ? ball.pos.x - x0 : 0;
      if (offsetY > 0 && offsetY < 1) console.log();
      disposeEngineFor(w);
      return { took, moved };
    };
    const on = offsets.map((off) => ({ off, ...runRamp(off, true) }));
    const off = offsets.map((o) => ({ off: o, ...runRamp(o, false) }));
    console.log(
      `[smoke-bb sim3d] ramp ground-capture sweep (offset: intake on / off-pushed in): ` +
        on.map((r, i) => `${r.off.toFixed(2)}: ${r.took ? 'Y' : 'n'}/${off[i].moved.toFixed(1)}`).join('  '),
    );
    check(
      'archetype 3d: a deployed RAMP still takes a ground POLLEN over its own deck, at every offset across the mouth',
      on.every((r) => r.took),
      JSON.stringify(on.map((r) => [r.off.toFixed(2), r.took])),
    );
    check(
      'archetype 3d: with the intake OFF the deployed RAMP PUSHES a ground POLLEN instead of taking it',
      off.every((r) => !r.took && r.moved > 2),
      JSON.stringify(off.map((r) => [r.off.toFixed(2), r.took, r.moved.toFixed(2)])),
    );
  }

  // (c1) A RAMP ROBOT CANNOT FREEZE ITSELF ON A STATIC (replay 1dc6eb8f, 2026-09-25: frozen from
  // 1:50 to the buzzer). Both jams are the same contact: the thin deck held VERTICALLY by a fixed
  // body, so the solver pushes the chassis into the tiles and friction holds it there.
  {
    const spec = { ...bbArchSpec('ramp', 'frontback'), length: 15, width: 17 };
    const drive = (w: World, c: Partial<RobotCommand>, n: number): void => {
      for (let i = 0; i < n; i++) step3d(w, 1 / 60, new Map([[0, cmd(c)]]));
    };
    const staged = (x: number, y: number, heading: number): World => {
      const w = mkWorld3d('match', 8140, spec);
      w.match.phase = 'teleop';
      w.match.phaseTimeLeft = 90;
      w.balls.length = 0;
      const r = w.robots[0];
      r.pos = { x, y };
      r.heading = heading;
      r.vel = { x: 0, y: 0 };
      r.angVel = 0;
      r.autoIntake = false;
      r.autoFire = false;
      drive(w, {}, 1);
      drive(w, { bbRamp: true }, 1);
      drive(w, {}, 25);
      return w;
    };
    // (i) the replay's own sequence, staged: a FOLD pressed just short of a wall at full speed.
    // The fold's overshoot hits the wall and reverses to a deploy; the old guard stopped testing
    // there, the robot closed 2.4 in with no ramp collider, and the ramp settled inside the wall.
    {
      const w = staged(-44, 0, Math.PI / 2);
      const r = w.robots[0];
      const ready = !!r.bbRampOut && !r.bbRampBlocked;
      const back = { driveY: -1, leftDrive: -1, rightDrive: -1 };
      drive(w, back, 40);
      r.pos = { x: -44, y: -52 };
      drive(w, back, 1);
      drive(w, { ...back, bbRamp: true }, 6);
      drive(w, back, 40);
      const y0 = r.pos.y;
      drive(w, { driveY: 1, leftDrive: 1, rightDrive: 1 }, 60);
      check(
        'ramp jam: a fold pressed at speed just short of a wall does not freeze the robot there',
        ready && r.pos.y - y0 > 3 && (r.z ?? 0) > -0.05,
        `ready=${ready} moved=${(r.pos.y - y0).toFixed(2)} z=${(r.z ?? 0).toFixed(3)} out=${r.bbRampOut}`,
      );
      disposeEngineFor(w);
    }
    // (ii) a SETTLED ramp whose deck ends up across a hive foot bar (the chassis clears the bar;
    // only the 0.4-in blade meets it). 7 of 400 random drives froze this way before the fix.
    {
      const probe = bbCoerce(spec);
      const uOut = mouthAxes(bbMouths(probe).find((m) => m.edge === 'front')!, probe.length / 2, probe.width / 2).uOut;
      const deckMid = uOut + (BB_RAMP_IN + BB_RAMP_OUT) / 2;
      const barX = -24.4; // the red foot bar's centreline (x −24.73 … −24.07)
      const w = staged(-44, 34, Math.PI);
      const r = w.robots[0];
      const ready = !!r.bbRampOut && !r.bbRampBlocked;
      r.pos = { x: barX + deckMid, y: 0 };
      drive(w, {}, 5);
      const x0 = r.pos.x;
      let minZ = 0;
      for (let i = 0; i < 60; i++) {
        drive(w, { driveY: -1, leftDrive: -1, rightDrive: -1 }, 1);
        minZ = Math.min(minZ, r.z ?? 0);
      }
      check(
        'ramp jam: a settled ramp across a hive foot bar folds and the robot drives away',
        ready && r.bbRampOut === false && r.pos.x - x0 > 3 && (r.z ?? 0) > -0.05,
        `ready=${ready} out=${r.bbRampOut} moved=${(r.pos.x - x0).toFixed(2)} z=${(r.z ?? 0).toFixed(3)} minZ=${minZ.toFixed(3)}`,
      );
      disposeEngineFor(w);
    }
  }

  // (c1b) A CHASSIS PLACED INSIDE THE HIVE FRAME. The solver's shallowest way out of a 2.15-in
  // foot bar was UP: the robot was lifted onto the bar with the A-frame leg between its frame box
  // and an intake arm, and never moved again (8/400 random placements, `scratch/rampstuck.ts`).
  // `fitChassisOut` sets it down beside the frame instead. Poses are the stuck placements.
  {
    const spec = bbArchSpec('sweeper', 'front');
    const drive = (w: World, c: Partial<RobotCommand>, n: number): void => {
      for (let i = 0; i < n; i++) step3d(w, 1 / 60, new Map([[0, cmd(c)]]));
    };
    const staged = (x: number, y: number, headingDeg: number): World => {
      const w = mkWorld3d('free', 8100, spec);
      w.balls.length = 0;
      const r = w.robots[0];
      r.pos = { x, y };
      r.heading = (headingDeg * Math.PI) / 180;
      r.vel = { x: 0, y: 0 };
      r.angVel = 0;
      r.autoIntake = false;
      r.autoFire = false;
      return w;
    };
    const poses: [number, number, number][] = [[-22.2, 15.4, 92], [29.9, 21.5, 233], [-24.4, 10, 45], [16, -22.3, 0], [-30.1, -11.7, 0]];
    let bad = '';
    for (const [x, y, h] of poses) {
      const w = staged(x, y, h);
      const r = w.robots[0];
      drive(w, {}, 30);
      const z0 = r.z ?? 0;
      const x0 = r.pos.x;
      const y0 = r.pos.y;
      let maxD = 0;
      for (const c of [{ driveY: 1, leftDrive: 1, rightDrive: 1 }, { driveY: -1, leftDrive: -1, rightDrive: -1 }, { driveX: 1 }, { driveX: -1 }]) {
        for (let k = 0; k < 40; k++) {
          drive(w, c, 1);
          maxD = Math.max(maxD, Math.hypot(r.pos.x - x0, r.pos.y - y0));
        }
      }
      if (Math.abs(z0) > 0.1 || maxD < 12) bad += `(${x},${y},${h}°): z=${z0.toFixed(2)} moved ${maxD.toFixed(2)}; `;
      disposeEngineFor(w);
    }
    check('hive frame: a chassis placed inside the frame is set down on the tiles beside it and drives away', bad === '', bad);

    // ...and a chassis PARKED against the bar is left where the solver put it: a re-sync of its
    // own pose must not move it. Driven flat into the flange's outer face from open field.
    {
      const w = staged(-45, 0, 0);
      const r = w.robots[0];
      drive(w, { driveY: 1, leftDrive: 1, rightDrive: 1 }, 180);
      drive(w, {}, 30);
      const x0 = r.pos.x;
      r.pos = { x: x0 + 0.001, y: r.pos.y }; // a pose edit: forces the teleport path
      drive(w, {}, 1);
      const front = x0 + robotExtents(r).front;
      check(
        'hive frame: a chassis parked against the foot bar is not moved when its pose is re-synced',
        Math.abs(r.pos.x - x0) < 0.05 && front > -25 && Math.abs(r.z ?? 0) < 0.1,
        `parked x=${x0.toFixed(3)} (front edge ${front.toFixed(2)}, flange face −24.73) → ${r.pos.x.toFixed(3)} z=${(r.z ?? 0).toFixed(3)}`,
      );
      disposeEngineFor(w);
    }
  }

  // (c2) THE RAMP EDGE NEVER MOVES THE CHASSIS (owner report 2026-09-21: "deploying the ramp is
  // lowering the entire robot into the ground"). Clearing the WHOLE compound at the settle edge
  // dropped the floor contacts: three ticks of free fall, 0.28 in under the tiles, and no
  // recovery while standing still. Only the reach hardware may be swapped.
  {
    for (const mount of ['front', 'back', 'frontback'] as const) {
      const w = mkWorld3d('match', 8121, bbArchSpec('ramp', mount));
      w.match.phase = 'teleop';
      w.match.phaseTimeLeft = 90;
      w.balls.length = 0;
      const r = w.robots[0];
      r.pos = { x: -50, y: 34 };
      r.heading = 0;
      r.vel = { x: 0, y: 0 };
      r.angVel = 0;
      for (let t = 0; t < 40; t++) step3d(w, 1 / 60, new Map());
      const z0 = r.z ?? 0;
      let worst = 0;
      const watch = (n: number): void => {
        for (let t = 0; t < n; t++) {
          step3d(w, 1 / 60, new Map());
          worst = Math.max(worst, Math.abs((r.z ?? 0) - z0), Math.abs(r.vz ?? 0));
        }
      };
      step3d(w, 1 / 60, new Map([[0, cmd({ bbRamp: true })]]));
      watch(Math.round(BB_RAMP_DEPLOY_S * 60) + 30);
      const settled = r.bbRampOut === true;
      step3d(w, 1 / 60, new Map([[0, cmd({ bbRamp: true })]]));
      watch(Math.round(BB_RAMP_DEPLOY_S * 60) + 30);
      check(
        `archetype 3d: a ${mount} RAMP deploying and folding never moves the chassis in z`,
        settled && r.bbRampOut === false && worst < 0.01,
        `deployed=${settled} folded=${r.bbRampOut === false} worst |dz|,|vz| = ${worst.toFixed(4)}`,
      );
      disposeEngineFor(w);
    }
  }
  // (c3) A DEPLOYED RAMP DRIVEN INTO A FLOWER DOES NOT HOP THE ROBOT (owner report 2026-09-21: "it
  // kinda gets caught on the bottom aluminum part of the flower and makes the whole robot jump
  // upwards"). `sim3d/groups.ts` has the cause — a speculative edge-edge contact between the blade
  // and the lower ring plate it rides 0.046 in over. Measured before: up to 0.23 in at vz 10 in/s.
  {
    let worstZ = 0;
    let worstVz = 0;
    let took = 0;
    const runs: [number, number, number][] = [[0, 0.5, 0], [0, 0.5, 2], [1, 1, -2], [2, 0.5, 4], [3, 1, 0]];
    for (const [fi, stick, lat] of runs) {
      const w = mkWorld3d('match', 8130 + fi, bbArchSpec('ramp', 'front'));
      w.match.phase = 'teleop';
      w.match.phaseTimeLeft = 90;
      w.balls.length = 0;
      const f = BB_FLOWERS[fi];
      w.balls.push({ id: 9300, color: 'yellow', r: BB_POLLEN_R, state: { kind: 'element', el: `flower:${fi}`, slot: 0 }, pos: { x: f.x, y: f.y }, vel: { x: 0, y: 0 }, z: 0, vz: 0 } as unknown as World['balls'][number]);
      const r = w.robots[0];
      r.hopper = [];
      const n = FLOWER_MOUTH[f.wall];
      const standoff = bbFootprint(r.spec).front + 16;
      r.pos = { x: f.x + n.x * standoff - n.y * lat, y: f.y + n.y * standoff + n.x * lat };
      r.heading = Math.atan2(-n.y, -n.x);
      r.vel = { x: 0, y: 0 };
      r.angVel = 0;
      for (let t = 0; t < 30; t++) step3d(w, 1 / 60, new Map());
      step3d(w, 1 / 60, new Map([[0, cmd({ bbRamp: true })]]));
      for (let t = 0; t < Math.round(BB_RAMP_DEPLOY_S * 60) + 3; t++) step3d(w, 1 / 60, new Map());
      for (let t = 0; t < 150; t++) {
        step3d(w, 1 / 60, new Map([[0, cmd({ driveY: stick, leftDrive: stick, rightDrive: stick, intake: true })]]));
        worstZ = Math.max(worstZ, Math.abs(r.z ?? 0));
        worstVz = Math.max(worstVz, Math.abs(r.vz ?? 0));
      }
      if (r.hopper.length > 0) took++;
      disposeEngineFor(w);
    }
    check(
      'archetype 3d: a deployed RAMP driven into a FLOWER never lifts the chassis off the tiles',
      worstZ < 0.02 && worstVz < 1,
      `worst |z| ${worstZ.toFixed(4)} in, worst |vz| ${worstVz.toFixed(3)} in/s over ${runs.length} drive-ins`,
    );
    check('archetype 3d: ...and those same drive-ins still take the POLLEN (the lane-centred ones)', took >= 3, `${took}/${runs.length}`);
  }
  // (d) The RAMP's collider count changes at exactly two edges: the SETTLE (`BB_RAMP_DEPLOY_S`
  // after the press) and the FOLD (immediately on the next press) — and at no other tick.
  {
    const w = mkWorld3d('match', 8120, bbArchSpec('ramp', 'front'));
    w.balls.length = 0;
    w.match.phase = 'teleop';
    w.match.phaseTimeLeft = 90;
    const r = w.robots[0];
    const countOf = (): number => robotBodyOf(engineFor(w), 0)!.numColliders();
    step3d(w, 1 / 60, new Map()); // build the engine, folded
    const foldedCount = countOf();
    const deploySteps = Math.round(BB_RAMP_DEPLOY_S / (1 / 60));
    let pressChanges: number[] = [];
    // PRESS 1: fold -> deploy, settling `deploySteps` ticks after the press
    step3d(w, 1 / 60, new Map([[0, cmd({ bbRamp: true })]]));
    let prev = countOf();
    for (let t = 1; t <= deploySteps + 3; t++) {
      step3d(w, 1 / 60, new Map());
      const now = countOf();
      if (now !== prev) pressChanges.push(t);
      prev = now;
    }
    const deployedCount = countOf();
    // a FOLDED ramp adds no reach collider at all — same count as the same mount's own sweeper
    // build (`chassis3dShapes` + `chassis3dPocketShapes` only; `chassis3dReachShapes` is empty
    // for `sweeper` always and for `ramp` until `rampReady`).
    const sweeperCount = (() => {
      const sw = mkWorld3d('free', 8121, bbArchSpec('sweeper', 'front'));
      step3d(sw, 1 / 60, new Map());
      const n = robotBodyOf(engineFor(sw), 0)!.numColliders();
      disposeEngineFor(sw);
      return n;
    })();
    check(
      'archetype 3d: a FOLDED ramp adds NO reach colliders — the same count as the same mount\'s SWEEPER build',
      foldedCount === sweeperCount,
      `folded ramp=${foldedCount} sweeper=${sweeperCount}`,
    );
    check(
      'archetype 3d: the ramp collider count changes at exactly the SETTLE tick and no other, deploying',
      pressChanges.length === 1 && pressChanges[0] === deploySteps && deployedCount > foldedCount,
      `changes at ticks ${JSON.stringify(pressChanges)} (want [${deploySteps}]), folded=${foldedCount} deployed=${deployedCount}`,
    );
    // FOLD: `bbRampStep` flips `bbRampOut` false DURING the press tick's own gameplay stage,
    // which runs AFTER that same tick's `syncRobot` (the collider is built from the world JSON
    // as it stood at the START of the tick) — so the rebuild itself lands on the NEXT tick's
    // sync, the same one-tick lag the deploy edge shows (measured above: the change lands at
    // tick `deploySteps` counted from the FIRST tick after the deploy press, not on the press
    // tick itself). No SETTLE delay is still true: unlike deploy, nothing has to wait out
    // `BB_RAMP_DEPLOY_S` on the way back in.
    step3d(w, 1 / 60, new Map([[0, cmd({ bbRamp: true })]])); // the fold press itself
    const pressTickCount = countOf();
    step3d(w, 1 / 60, new Map()); // the next sync, where the rebuild actually lands
    const foldTickCount = countOf();
    check(
      'archetype 3d: the ramp collider count drops back to the folded count on the fold press\'s very next sync, no settle delay',
      pressTickCount === deployedCount && foldTickCount === foldedCount,
      `deployed=${deployedCount} pressTick=${pressTickCount} nextTick=${foldTickCount} folded=${foldedCount}`,
    );
  }

  // (e) determinism: two fresh 3D worlds, same seed, a script that PRESSES THE RAMP, hash equal.
  {
    function rampScript(t: number): RobotCommand {
      const phase = Math.floor(t / 40) % 5;
      const base = cmd({});
      if (phase === 0) return { ...base, driveY: 1 };
      if (phase === 1) return { ...base, bbRamp: t % 40 === 0 };
      if (phase === 2) return { ...base, driveY: 1, intake: true };
      if (phase === 3) return { ...base, bbRamp: t % 40 === 0 };
      return { ...base, rotate: 1 };
    }
    const wa = mkWorld3d('free', 8130, bbArchSpec('ramp', 'front'));
    const wb = mkWorld3d('free', 8130, bbArchSpec('ramp', 'front'));
    wa.match.phase = wb.match.phase = 'freeplay';
    const hashesA: number[] = [];
    const hashesB: number[] = [];
    for (let t = 0; t < 240; t++) {
      const c = rampScript(t);
      step3d(wa, 1 / 60, new Map([[0, c]]));
      step3d(wb, 1 / 60, new Map([[0, c]]));
      if (t % 40 === 0) {
        hashesA.push(worldHash(wa));
        hashesB.push(worldHash(wb));
      }
    }
    /**
     * ⚠️ A RAMP DOES NOT DEPLOY THROUGH ANOTHER ROBOT (owner, 2026-09-21: “I am able to
     * deploy the ramp into another robot and phase”).
     *
     * The swing guard was written to the first wording of the rule — “any non-moving solid
     * thing” — so its query filtered on `isFixed()`, and a chassis is not fixed. The blade
     * went straight through one, and the solver was then handed two overlapping solids to
     * separate from the inside, which is what reads as phasing.
     *
     * Nose to nose along +x. MEASURED at the fix: blocked at 16..24 in of centre separation,
     * deploys normally at 26 and beyond. Both ends are asserted, so the check cannot pass by
     * simply refusing every swing — which is the failure mode a guard that is too eager has.
     * With the other robots left out of the block set (the old behaviour) the near case
     * deploys at every gap down to 16, so this is not vacuous.
     */
    {
      const swing = (gap: number): { out: boolean; blocked: boolean } => {
        const w = mkWorld3dPair('free', 11, { bbMech: { intake: { kind: 'ramp' } } } as never, {});
        const a = w.robots[0];
        const b = w.robots[1];
        a.heading = 0;
        b.heading = Math.PI;
        a.pos.x = 0;
        a.pos.y = 0;
        b.pos.x = gap;
        b.pos.y = 0;
        for (let t = 0; t < 30; t++) step3d(w, 1 / 60, new Map());
        for (let t = 0; t < 6; t++) step3d(w, 1 / 60, new Map([[a.id, cmd({ bbRamp: true })]]));
        for (let t = 0; t < 180; t++) step3d(w, 1 / 60, new Map([[a.id, cmd({})]]));
        return { out: a.bbRampOut === true, blocked: a.bbRampBlocked === true };
      };
      const near = swing(18);
      const far = swing(40);
      check(
        '⚠️ ramp 3d: a swing into ANOTHER ROBOT is refused and folds back, and a clear swing still deploys',
        !near.out && near.blocked && far.out && !far.blocked,
        `18in apart -> deployed ${near.out} blocked ${near.blocked}; 40in apart -> deployed ${far.out} blocked ${far.blocked}`,
      );
    }

    check(
      'archetype 3d: determinism holds with a RAMP press in the script — hash equal every 40 ticks',
      // `rampScript` presses twice (phase 1 deploys, phase 3 folds), so `bbRampAt` being stamped
      // at all is the proof a press actually landed — the script's own design folds it again
      // before the run ends, which is deliberate (it is the FOLD edge that is one tick's lag from
      // the DEPLOY edge above, and this check wants both exercised, not a specific end state).
      hashesA.every((h, i) => h === hashesB[i]) && wa.robots[0].bbRampAt !== undefined,
      `${JSON.stringify(hashesA)} vs ${JSON.stringify(hashesB)}, bbRampAt=${wa.robots[0].bbRampAt} bbRampOut=${wa.robots[0].bbRampOut}`,
    );
    check(
      'archetype 3d: determinism holds with a RAMP press in the script — final JSON identical',
      JSON.stringify(wa) === JSON.stringify(wb),
    );
  }

  // (e2) determinism: two fresh 3D worlds, same seed, a script that RETRIEVES OFF A FLOWER WITH
  // SIDE ROLLERS, hash equal — the physical two-step release (owner ruling 2026-09-20) is a NEW
  // code path relative to the old direct-capture one, so it gets its own determinism claim rather
  // than relying on the ramp's. HELD AT THE ANALYTIC FLUSH POSE, not driven in: a real drive-in
  // picks up owner-documented, seed-sensitive yaw/lateral drift off the asymmetric wheel contact
  // (`BB_SIDE_ROLLER_CONTACT_TOL`'s own header — MEASURED 18-23° across runs), which is the right
  // thing for the retrieval-rate SWEEP to characterize and the wrong thing to depend on on for a
  // determinism check whose only claim is "the same script produces the same bytes twice".
  {
    const sideRetrieveScript = (): RobotCommand => cmd({ intake: true });
    const buildSideRetrieveWorld = (seed: number): World => {
      const w = mkWorld3d('free', seed, bbArchSpec('siderollers', 'front'));
      w.balls.length = 0;
      const f = BB_FLOWERS[0];
      const r = w.robots[0];
      const half = mouthAxes(bbMouths(r.spec)[0], r.spec.length / 2, r.spec.width / 2).half;
      const wy = bbSideRollerY(half);
      r.pos = { x: f.x + BB_PLACE_REACH + bbFootprint(r.spec).front, y: f.y - wy };
      r.heading = Math.PI;
      r.vel = { x: 0, y: 0 };
      r.angVel = 0;
      r.hopper = [];
      for (const b of w.balls) if (b.state.kind === 'held' && b.state.robot === r.id) b.state = { kind: 'stock', alliance: r.alliance };
      // DROPPED at the top ring one at a time and settled, exactly like `flower3d.ts`'s own
      // `placeFill` — a hand-stacked initial pose (elements a hair apart in z) overlaps by nearly
      // a full diameter and the first tick's contact resolution flings the whole column, which is
      // why the earlier draft of this fixture never actually retrieved anything.
      let id = 9200;
      for (let k = 0; k < 4; k++) {
        w.balls.push({ id, color: 'yellow', r: BB_POLLEN_R, state: { kind: 'element', el: 'flower:0', slot: 0 }, pos: { x: f.x, y: f.y }, vel: { x: 0, y: 0 }, z: FLOWER_RING_Z.top[0] - BB_POLLEN_R, vz: 0 });
        id++;
        for (let t = 0; t < 60; t++) step3d(w, 1 / 60, new Map());
      }
      return w;
    };
    const wa = buildSideRetrieveWorld(8140);
    const wb = buildSideRetrieveWorld(8140);
    const hashesA: number[] = [];
    const hashesB: number[] = [];
    for (let t = 0; t < 400; t++) {
      const c = sideRetrieveScript();
      step3d(wa, 1 / 60, new Map([[0, c]]));
      step3d(wb, 1 / 60, new Map([[0, c]]));
      if (t % 40 === 0) {
        hashesA.push(worldHash(wa));
        hashesB.push(worldHash(wb));
      }
    }
    console.log(
      `[smoke-bb sim3d] side-roller retrieval determinism: hopper A=${wa.robots[0].hopper.length} B=${wb.robots[0].hopper.length}, ` +
        `stack A=${wa.biobuzz!.flowers[0].stack.length} B=${wb.biobuzz!.flowers[0].stack.length}`,
    );
    check(
      'archetype 3d: determinism holds with a SIDE-ROLLER flower retrieval in the script — hash equal every 40 ticks, and a retrieval actually happened',
      hashesA.every((h, i) => h === hashesB[i]) && wa.robots[0].hopper.length > 0,
      `${JSON.stringify(hashesA)} vs ${JSON.stringify(hashesB)}, hopperA=${wa.robots[0].hopper.length}`,
    );
    check(
      'archetype 3d: determinism holds with a SIDE-ROLLER flower retrieval in the script — final JSON identical',
      JSON.stringify(wa) === JSON.stringify(wb),
    );
  }

  // (e3) determinism: the RAMP's own retrieval — the BLADE plus its DRIVEN LIP
  // (`rampRollerDrive`, `flowerRetrieve3d`'s ramp branch), a NEW code path relative to (e)'s bare
  // deploy/fold script above (which never drives at a flower at all). The script empties a
  // two-POLLEN column out of the tube (`stack` 0 either side), so the roller, the release, the
  // re-tag and the intake's own extended pull are all in the hashed bytes, twice. HELD AT THE
  // ANALYTIC FLUSH
  // POSE, same reasoning as (e2): a real drive-in's own standoff is what the flower3d lane's own
  // sweep characterizes, and the wrong thing to depend on for "the same script produces the same
  // bytes twice".
  {
    const rampRetrieveScript = (deployed: boolean): RobotCommand => cmd({ intake: true, bbRamp: !deployed });
    const buildRampRetrieveWorld = (seed: number): World => {
      const w = mkWorld3d('free', seed, bbArchSpec('ramp', 'front'));
      w.balls.length = 0;
      const f = BB_FLOWERS[0];
      const r = w.robots[0];
      const flushPose = (): void => {
        r.pos = { x: f.x + BB_PLACE_REACH + bbFootprint(r.spec).front, y: f.y };
        r.heading = Math.PI;
        r.vel = { x: 0, y: 0 };
        r.angVel = 0;
      };
      // ⚠️ DEPLOY IN THE OPEN, THEN MOVE FLUSH — pressing the ramp while ALREADY parked flush is
      // exactly the swing guard's own refusal case ("a deploy FLUSH ON THE FLOWER'S FOOT reverses
      // back to folded rather than settling deployed"), which left `bbRampSettled` false forever
      // and this fixture's `reach` permanently null — MEASURED (`scratch/ramp_flush_debug.ts`):
      // the branch never fired once across 500 ticks. Same fix `robot.ts`'s own
      // `openPark`-then-`flush` fixtures already use for this exact mechanic.
      // ⚠️ INFIELD of F1, not `f.x - 100`: F1 is on the LEFT wall, so that point is 100 in outside
      // the field, and the containment net clamped the robot back in ON TOP of F1 — it deployed
      // wherever the plates happened to eject it, and that ejection also knocked the column off
      // the axis. Found 2026-09-25 when robots stopped meeting the ring trimesh and the swing
      // guard, seeing the solid plates, refused that deploy. Deployed in the open, the teleport
      // flush lands the blade on a CENTRED column (chassis lifted to z 2.1, nothing retrieved,
      // old and new physics alike), so the column is dropped in AFTER the robot is held flush:
      // it falls onto the blade the way a placed column does.
      r.pos = { x: f.x + 40, y: f.y };
      r.heading = Math.PI;
      r.vel = { x: 0, y: 0 };
      r.angVel = 0;
      r.hopper = [];
      for (const b of w.balls) if (b.state.kind === 'held' && b.state.robot === r.id) b.state = { kind: 'stock', alliance: r.alliance };
      step3d(w, 1 / 60, new Map([[0, cmd({ bbRamp: true })]])); // press the ramp out, still in the open
      const deploySteps = Math.round(BB_RAMP_DEPLOY_S / (1 / 60)) + 2;
      for (let t = 0; t < deploySteps; t++) step3d(w, 1 / 60, new Map());
      let id = 9300;
      for (let k = 0; k < 2; k++) {
        w.balls.push({ id, color: 'yellow', r: BB_POLLEN_R, state: { kind: 'element', el: 'flower:0', slot: 0 }, pos: { x: f.x, y: f.y }, vel: { x: 0, y: 0 }, z: FLOWER_RING_Z.top[0] - BB_POLLEN_R, vz: 0 });
        id++;
        for (let t = 0; t < 60; t++) {
          flushPose(); // NOW flush, ramp already settled, held there while the column drops
          step3d(w, 1 / 60, new Map());
        }
      }
      flushPose();
      return w;
    };
    const wa = buildRampRetrieveWorld(8150);
    const wb = buildRampRetrieveWorld(8150);
    const flushPose = (w: World): void => {
      // held at the analytic flush pose every tick, same discipline `robot.ts`'s own `holdTicks`
      // follows for the ramp — the blade's own contact force (MEASURED, `scratch/rampx.ts`)
      // nudges an un-held chassis enough over ~30 ticks to drop the mouth gate for good, which
      // would make this determinism claim vacuous (nothing left for `hopper.length > 0` to find).
      const f = BB_FLOWERS[0];
      const r = w.robots[0];
      r.pos = { x: f.x + BB_PLACE_REACH + bbFootprint(r.spec).front, y: f.y };
      r.heading = Math.PI;
      r.vel = { x: 0, y: 0 };
      r.angVel = 0;
    };
    const hashesA: number[] = [];
    const hashesB: number[] = [];
    for (let t = 0; t < 500; t++) {
      const c = rampRetrieveScript(true);
      flushPose(wa);
      flushPose(wb);
      step3d(wa, 1 / 60, new Map([[0, c]]));
      step3d(wb, 1 / 60, new Map([[0, c]]));
      if (t % 40 === 0) {
        hashesA.push(worldHash(wa));
        hashesB.push(worldHash(wb));
      }
    }
    console.log(
      `[smoke-bb sim3d] ramp retrieval determinism: hopper A=${wa.robots[0].hopper.length} B=${wb.robots[0].hopper.length}, ` +
        `stack A=${wa.biobuzz!.flowers[0].stack.length} B=${wb.biobuzz!.flowers[0].stack.length}`,
    );
    check(
      'archetype 3d: determinism holds with a RAMP flower retrieval (wedge + stall fallback) in the script — hash equal every 40 ticks, and a retrieval actually happened',
      hashesA.every((h, i) => h === hashesB[i]) && wa.robots[0].hopper.length > 0,
      `${JSON.stringify(hashesA)} vs ${JSON.stringify(hashesB)}, hopperA=${wa.robots[0].hopper.length}`,
    );
    check(
      'archetype 3d: determinism holds with a RAMP flower retrieval in the script — final JSON identical',
      JSON.stringify(wa) === JSON.stringify(wb),
    );
  }

  // (h) THE WALL-FLUSH START, MEASURED (plan item 4). Every real anchor x both alliances x the
  // four intake mounts, for `siderollers` — the one archetype that is ALWAYS solid, including at
  // spawn (a folded `ramp` contributes no collider until it deploys, well after the pre-match
  // countdown, so it never reaches this at all). The fix is at the SPAWN side
  // (`spawn.ts`'s `bb3dStartFootprint`): the archetype's own extra protrusion
  // (`bbArchetypeWallExtra`) is folded into the containment clamp `bbFitPose` already runs, so the
  // anchor is placed with ZERO protrusion in the first place rather than popped out by the solver.
  {
    let worst = 0;
    let worstDetail = '';
    for (const alliance of ['red', 'blue'] as const) {
      for (let idx = 0; idx < BB_START_POSES.length; idx++) {
        for (const mount of ['front', 'back', 'side', 'frontback'] as const) {
          const spec = bbCoerce(bbArchSpec('siderollers', mount));
          const w = createBiobuzzWorld(
            'match',
            1,
            [{ id: 0, alliance, spec, assists: { fieldCentric: false, aimAssist: false, autoIntake: false, autoFire: false, autoPathEnabled: false }, startIndex: idx }],
            undefined,
            '3d',
          );
          const r0 = w.robots[0];
          const h = bbHeightNow(w, r0.spec);
          const shapes = chassis3dReachShapes(r0.spec, h, false);
          for (const s of shapes) {
            for (const sx of [-1, 1] as const) {
              for (const sy of [-1, 1] as const) {
                const l = rot({ x: s.cx + sx * s.hx, y: s.cy + sy * s.hy }, r0.heading);
                const px = r0.pos.x + l.x;
                const py = r0.pos.y + l.y;
                const over = Math.max(px - BB_HALF_X, -BB_HALF_X - px, py - BB_HALF_Y, -BB_HALF_Y - py);
                if (over > worst) {
                  worst = over;
                  worstDetail = `${alliance} idx=${idx} mount=${mount}`;
                }
              }
            }
          }
        }
      }
    }
    console.log(`[smoke-bb sim3d] wall-flush start (siderollers), worst protrusion over 32 (alliance x anchor x mount) combos: ${worst.toFixed(4)}in (${worstDetail || 'n/a'})`);
    check(
      'archetype 3d: a SIDE-ROLLER build spawns with the archetype hardware never past the wall, on every real anchor x mount x alliance',
      worst <= 1e-6,
      `worst protrusion ${worst.toFixed(4)}in at ${worstDetail}`,
    );
  }

  // ...and that pose is a REST POSE, not just a geometric fit: physics does not move it, over a
  // real settle window, and — MEASURED, before the spawn fix, at the OLD `BB_SIDE_ROLLER_OUT`
  // (1.9, wheel reach 2.65in) — it used to be worse than slow: a `siderollers` build embedded
  // 2.65in in the wall never settled AT ALL (300 ticks / 5s, zero drift on every axis), because
  // the wheel box's own escape-through-the-floor distance (its OWN height) was SHORTER than its
  // escape-sideways distance, so Rapier's own SAT pick sent the correction into the floor, where
  // it cancelled against the floor collider every tick. The wheels are tucked in now (reach
  // 1.9in, `BB_SIDE_ROLLER_OUT` 0.9 + `BB_SIDE_ROLLER_R` 1.0) but the spawn-side fix below does
  // not depend on which escape direction is shorter, so this check still holds.
  {
    const spec = bbCoerce(bbArchSpec('siderollers', 'back'));
    const w = createBiobuzzWorld(
      'match',
      1,
      [{ id: 0, alliance: 'red' as const, spec, assists: { fieldCentric: false, aimAssist: false, autoIntake: false, autoFire: false, autoPathEnabled: false }, startIndex: 0 }],
      undefined,
      '3d',
    );
    const start = { x: w.robots[0].pos.x, y: w.robots[0].pos.y, h: w.robots[0].heading };
    for (let t = 0; t < 90; t++) step3d(w, 1 / 60, new Map());
    const r = w.robots[0];
    const drift = Math.hypot(r.pos.x - start.x, r.pos.y - start.y);
    const yawDrift = Math.abs(wrapAngle(r.heading - start.h)) * (180 / Math.PI);
    console.log(`[smoke-bb sim3d] wall-flush start settle (90 ticks, siderollers/back/idx0/red): drift ${drift.toFixed(5)}in, yaw ${yawDrift.toFixed(3)}deg`);
    check(
      'archetype 3d: the wall-flush start settles at REST — deterministic, no pop, no yaw, nothing moves once auto starts',
      drift < 0.05 && yawDrift < 0.5,
      `drift ${drift.toFixed(5)}in yaw ${yawDrift.toFixed(3)}deg`,
    );
    disposeEngineFor(w);
  }
}

/**
 * The absolute step budgets, run in the PERF lane (`index.ts`), which `npm test` runs on its own
 * after every other shard: a budget in milliseconds says what the step costs on an idle machine.
 */
export function sim3dPerfChecks(check: Check): void {
  // ---- perf: 2v2 (4 robots), median/p95 step3d cost ----------------------------------------
  {
    const w = createBiobuzzWorld(
      'free',
      31,
      [setup(0, 'blue', {}, 0), setup(1, 'blue', {}, 1), setup(2, 'red', {}, 0), setup(3, 'red', {}, 1)],
      undefined,
      '3d',
    );
    const cmds = new Map([
      [0, cmd({ driveY: 1, intake: true })],
      [1, cmd({ rotate: 1, fire: true })],
      [2, cmd({ driveY: -1, intake: true })],
      [3, cmd({ driveX: 1, fire: true })],
    ]);
    for (let t = 0; t < 60; t++) step3d(w, 1 / 60, cmds); // warm-up, excluded
    const times: number[] = [];
    for (let t = 0; t < 600; t++) {
      const t0 = Date.now();
      step3d(w, 1 / 60, cmds);
      times.push(Date.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    const p95 = times[Math.floor(times.length * 0.95)];
    console.log(`[smoke-bb sim3d] step3d 2v2: median ${median}ms, p95 ${p95}ms (Date.now() resolution -- see detail on failure)`);
    check(
      'perf: 2v2 step3d median <= 1.5ms',
      median <= 1.5,
      `median=${median}ms p95=${p95}ms (${times.length} samples)`,
    );
  }

  // ---- perf: 2v2 with the ARCHETYPE reach hardware live on every robot (siderollers + a
  // deployed ramp), median/p95 step3d cost -- the same budget, now with the extra colliders.
  {
    const w = createBiobuzzWorld(
      'free',
      32,
      [
        setup(0, 'blue', bbArchSpec('siderollers', 'front'), 0),
        setup(1, 'blue', bbArchSpec('ramp', 'back'), 1),
        setup(2, 'red', bbArchSpec('siderollers', 'side'), 0),
        setup(3, 'red', bbArchSpec('ramp', 'frontback'), 1),
      ],
      undefined,
      '3d',
    );
    // MOVE OFF THE START ANCHORS FIRST — they are wall-flush by design (G304), and the swing
    // guard (owner, 2026-09-20: a deploy that would carry the ramp into a static reverses) is
    // RIGHT to refuse a deploy on the ramp-mounted edge's own wall. This fixture only wants the
    // reach colliders live for a cost measurement, so give both ramp builds open field first.
    w.robots[1].pos = { x: -20, y: 20 };
    w.robots[1].heading = 0;
    w.robots[3].pos = { x: 20, y: -20 };
    w.robots[3].heading = 0;
    // deploy both ramps and let them settle before timing
    step3d(w, 1 / 60, new Map([[1, cmd({ bbRamp: true })], [3, cmd({ bbRamp: true })]]));
    for (let t = 0; t < 30; t++) step3d(w, 1 / 60, new Map());
    check(
      'archetype 3d perf fixture: both ramp builds are actually deployed before timing',
      w.robots[1].bbRampOut === true && w.robots[3].bbRampOut === true,
      `r1=${w.robots[1].bbRampOut} r3=${w.robots[3].bbRampOut}`,
    );
    const cmds = new Map([
      [0, cmd({ driveY: 1, intake: true })],
      [1, cmd({ rotate: 1, fire: true })],
      [2, cmd({ driveY: -1, intake: true })],
      [3, cmd({ driveX: 1, fire: true })],
    ]);
    for (let t = 0; t < 60; t++) step3d(w, 1 / 60, cmds); // warm-up, excluded
    const times: number[] = [];
    for (let t = 0; t < 600; t++) {
      const t0 = Date.now();
      step3d(w, 1 / 60, cmds);
      times.push(Date.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    const p95 = times[Math.floor(times.length * 0.95)];
    console.log(`[smoke-bb sim3d] step3d 2v2 (archetype hardware live): median ${median}ms, p95 ${p95}ms`);
    check(
      'perf: 2v2 step3d median <= 1.5ms with the archetype reach hardware live on every robot',
      median <= 1.5,
      `median=${median}ms p95=${p95}ms (${times.length} samples)`,
    );
  }
}
