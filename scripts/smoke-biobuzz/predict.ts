import type { Check } from './harness';
import { cmd, mkWorld3d, mkWorld3dPair } from './harness';
import { bbBotBuildByKey } from '../../src/games/biobuzz/ai/builds';
import { step3d } from '../../src/games/biobuzz/sim3d/step3d';
import { disposeEngineFor, rewindEngineTo } from '../../src/games/biobuzz/sim3d/engineImpl';
import {
  createFullPredictor,
  createLightPredictor,
  probeFullReconcileMs,
  type PredictedPose,
  type Predictor,
} from '../../src/games/biobuzz/sim3d/predict';
import {
  BB_HALF_Y,
  BB_POLLEN_R,
  bbHopperCap,
  BB_SIDE_ROLLER_OUT,
  BB_SIDE_ROLLER_R,
  PREDICT_ELEMENT_RADIUS,
  PREDICT_FULL_BUDGET_MS,
  PREDICT_LIGHT_BUDGET_MS,
  PREDICT_MAX_TICKS,
} from '../../src/games/biobuzz/config';
import { SIM_DT } from '../../src/config';
import type { Artifact, RobotCommand, RobotSpec, World } from '../../src/types';

/**
 * PREDICT — the two client-side prediction worlds (Day 2 lane A, `docs/biobuzz/plan-3d.md` §9).
 *
 * The plan's lane spec: "Light and Full prediction worlds converge to the authoritative pose
 * within `SMOOTH_MAX_DIST` after 40 re-stepped ticks on a scripted push".
 *
 * ⚠️ **`SMOOTH_MAX_DIST` IS 16 in AND IT IS A CEILING, NOT A TARGET.** It is the distance past
 * which `game.ts` SNAPS the local robot instead of easing the correction in — so a predictor that
 * merely stayed under it would still be visibly rubber-banding every reconcile. The checks below
 * report the measured error as well as asserting the bound, and the scripted-push numbers are in
 * the log line, because those are what say whether Full is worth its wasm.
 *
 * The constant is NOT imported: it lives in `src/game.ts`, which is Lane C's and DOM-adjacent.
 * It is restated here with its provenance, which is the same thing `PREDICT_MAX_TICKS` does for
 * `MAX_PREDICT_LEAD`.
 */

/** `SMOOTH_MAX_DIST` from `src/game.ts` — "larger corrections snap instead of floating". */
const SMOOTH_MAX_DIST = 16;

const LOCAL = 0;

/** a 2v2-shaped 3D world with the local robot (id 0) on a scripted push into a line of elements
 * against the wall — the plan's own scenario, and the one case where LIGHT is expected to be
 * WRONG and FULL is expected to be right. */
function pushScene(seed: number): World {
  const w = mkWorld3dPair('free', seed);
  w.balls.length = 0;
  const r = w.robots[LOCAL];
  r.hopper.length = 0;
  // park it in the open, facing the +y wall, with a garden-style line of POLLEN between it and
  // the wall: four elements the chassis has to shove the whole way.
  r.pos.x = 0;
  r.pos.y = 20;
  r.heading = Math.PI / 2;
  r.vel.x = 0;
  r.vel.y = 0;
  r.angVel = 0;
  for (let i = 0; i < 4; i++) {
    w.balls.push({
      id: 500 + i,
      color: 'yellow',
      state: { kind: 'ground' },
      pos: { x: -4.5 + i * 3, y: 34 },
      vel: { x: 0, y: 0 },
      z: 0,
      vz: 0,
      r: BB_POLLEN_R,
    } as Artifact);
  }
  return w;
}

/** the authoritative answer: step the REAL pipeline `ticks` times with `c` on the local robot. */
function authoritative(w: World, c: RobotCommand, ticks: number): PredictedPose {
  const cmds = new Map([[LOCAL, c]]);
  for (let i = 0; i < ticks; i++) step3d(w, SIM_DT, cmds);
  const r = w.robots.find((x) => x.id === LOCAL)!;
  return {
    pos: { x: r.pos.x, y: r.pos.y },
    vel: { x: r.vel.x, y: r.vel.y },
    heading: r.heading,
    angVel: r.angVel,
    z: r.z ?? 0,
    vz: r.vz ?? 0,
  };
}

/** re-step `ticks` inputs through a predictor and return its final pose plus the wall time. */
function replay(p: Predictor, c: RobotCommand, ticks: number): { pose: PredictedPose; ms: number } {
  const t0 = performance.now();
  let pose = p.step(c);
  for (let i = 1; i < ticks; i++) pose = p.step(c);
  return { pose, ms: performance.now() - t0 };
}

/**
 * HOW MANY TIMES A BUDGET IS MEASURED, AND WHY THE BUDGET READS THE MINIMUM.
 *
 * A reconcile is deterministic work: the same world and the same inputs execute the same
 * instructions every time. Everything else that lands in a wall-clock reading (another process
 * on the core, an interrupt, a GC pause from the previous lane) is ADDED to it, never taken away,
 * so the fastest of many readings is the best estimate of what the reconcile itself costs. That
 * is the number the budget is written against. A slower reconcile raises every reading, the
 * minimum included, so a real regression still fails.
 *
 * Thirty readings of a 4 ms reconcile cost ~0.15 s. It was the best of FIVE on `Date.now()`
 * (1 ms steps), which is too few to reliably catch one clean reading.
 *
 * ⚠️ **THE MINIMUM REMOVES INTERRUPTIONS, NOT A SLOWER CORE.** With 18 test processes on 16
 * physical cores (a busy hyperthread sibling, lower all-core clocks) every reading is slower, the
 * fastest one included: 6.3-7.4 ms here against 4.0 idle (2026-09-25). That is why these checks
 * run in the PERF lane, which `npm test` runs alone after the other shards (`predictPerfChecks`).
 *
 * Not CPU time: `process.cpuUsage()` on Windows advances in 15.6 ms steps (measured: every
 * nonzero delta is 15000 or 16000 us), longer than the thing being timed, and it counts the GC
 * and worker threads too.
 */
const TIMING_REPS = 30;

const dist = (a: PredictedPose, b: PredictedPose): number => Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);

/** the local robot 30 in from the +y wall, facing it, with an archetype's reach hardware on. */
const archWallScene = (seed: number, archSpec: Partial<RobotSpec>): World => {
  const w = mkWorld3dPair('free', seed, archSpec);
  w.balls.length = 0;
  const r = w.robots[LOCAL];
  r.hopper.length = 0;
  r.pos.x = 0;
  r.pos.y = BB_HALF_Y - 30;
  r.heading = Math.PI / 2; // 'front' mount faces +y, straight at the wall
  r.vel = { x: 0, y: 0 };
  r.angVel = 0;
  return w;
};
const SIDEROLLER_SPEC: Partial<RobotSpec> = {
  intakeMount: 'front',
  bbMech: { launcher: null, lift: null, intake: { kind: 'siderollers' } } as unknown as RobotSpec['bbMech'],
};
const RAMP_SPEC: Partial<RobotSpec> = {
  intakeMount: 'front',
  bbMech: { launcher: null, lift: null, intake: { kind: 'ramp' } } as unknown as RobotSpec['bbMech'],
};

export function predictChecks(check: Check): void {
  // ---- a DISABLED robot does not move, in either predictor --------------------------------------
  //
  // Owner, 2026-09-20: "in a server-required game, the robot can move slightly VISUALLY". `step3d`
  // hands a disabled robot a zero command; the predictors re-stepped the raw stick, so holding a
  // direction through the countdown, the auto→teleop transition or the buzzer slid the LOCAL robot
  // on screen until the next snapshot pulled it back. Both must now sit exactly where they were.
  {
    const drive = cmd({ driveY: 1, driveX: 1, rotate: 1, leftDrive: 1, rightDrive: -1 });
    for (const phase of ['pre', 'transition', 'post'] as const) {
      for (const kind of ['light', 'full'] as const) {
        const w = pushScene(1000);
        w.balls.length = 0;
        w.match.phase = phase;
        const p = kind === 'light' ? createLightPredictor(w, LOCAL) : createFullPredictor(w, LOCAL);
        p.reset(w, w.tick);
        const start = { x: w.robots[LOCAL].pos.x, y: w.robots[LOCAL].pos.y, h: w.robots[LOCAL].heading };
        const { pose } = replay(p, drive, PREDICT_MAX_TICKS);
        const moved = Math.hypot(pose.pos.x - start.x, pose.pos.y - start.y);
        const turned = Math.abs(pose.heading - start.h);
        check(
          `a DISABLED robot (${phase}) does not move under full stick in the ${kind.toUpperCase()} predictor`,
          moved < 1e-3 && turned < 1e-3,
          `moved ${moved.toFixed(4)}in, turned ${turned.toFixed(4)}rad over ${PREDICT_MAX_TICKS} ticks`,
        );
        p.dispose();
      }
    }
  }

  // ---- open floor: both predictors should be EXACT, because nothing is touching ---------------
  //
  // This is the case Light exists for, and it is the one where "converges to the authoritative
  // pose" means agreement rather than tolerance: with no contacts the real solve IS the drive
  // model integrated, which is precisely what Light computes. A failure here is the drive model
  // drifting between the two, which no tolerance should hide.
  {
    const drive = cmd({ driveY: 1, leftDrive: 1, rightDrive: 1 });
    const truth = pushScene(1000);
    truth.balls.length = 0; // open floor: nothing to hit
    const lightWorld = pushScene(1000);
    lightWorld.balls.length = 0;
    const fullWorld = pushScene(1000);
    fullWorld.balls.length = 0;

    const light = createLightPredictor(lightWorld, LOCAL);
    const full = createFullPredictor(fullWorld, LOCAL);
    light.reset(lightWorld, lightWorld.tick);
    full.reset(fullWorld, fullWorld.tick);
    const lr = replay(light, drive, PREDICT_MAX_TICKS);
    const fr = replay(full, drive, PREDICT_MAX_TICKS);
    const auth = authoritative(truth, drive, PREDICT_MAX_TICKS);
    const dl = dist(lr.pose, auth);
    const df = dist(fr.pose, auth);
    console.log(
      `[smoke-bb predict] open floor, ${PREDICT_MAX_TICKS} ticks: light off by ${dl.toFixed(3)}in (${lr.ms.toFixed(1)}ms), ` +
        `full off by ${df.toFixed(3)}in (${fr.ms.toFixed(1)}ms); the robot travelled ${Math.hypot(auth.pos.x, auth.pos.y - 20).toFixed(1)}in`,
    );
    check(
      `open floor: LIGHT lands on the authoritative pose (under ${SMOOTH_MAX_DIST}in, the snap threshold)`,
      dl < SMOOTH_MAX_DIST,
      `${dl.toFixed(3)}in after ${PREDICT_MAX_TICKS} re-stepped ticks`,
    );
    /**
     * ⚠️ **LIGHT IS NOT EXACT ON OPEN FLOOR, AND THE MEASUREMENT IS WHY THIS CHECK IS A RATIO.**
     * It integrates the SAME wrench with the same mass and inertia the real body gets, in the
     * same order (`v += F/m·dt` then `p += v·dt`) — `updateRobot`'s own `wantX/wantY/wantW` are
     * that formula, so the drive model agrees to the last digit. What it does not have is the
     * floor: the real chassis is a body resting on a collider, and Rapier's contact solve moves
     * it a fraction of an inch per tick that no forceless integrator reproduces. Measured, that
     * is 1.7 % of the distance travelled over a 40-tick window — a sixth of an inch per foot.
     *
     * The bound is a FRACTION rather than an absolute for the obvious reason: the error scales
     * with how far the robot went, and a predictor asked to re-step a slow window would pass an
     * absolute bound it had not earned.
     */
    const travelled = Math.hypot(auth.pos.x, auth.pos.y - 20);
    check(
      'open floor: LIGHT tracks the real solve to within 3% of the distance travelled',
      dl < 0.03 * travelled,
      `${dl.toFixed(3)}in over ${travelled.toFixed(1)}in = ${((dl / travelled) * 100).toFixed(2)}%`,
    );
    check(
      `open floor: FULL lands on the authoritative pose (under ${SMOOTH_MAX_DIST}in)`,
      df < SMOOTH_MAX_DIST,
      `${df.toFixed(3)}in`,
    );
    light.dispose();
    full.dispose();
  }

  // ---- the scripted push: a line of elements against the wall --------------------------------
  {
    const drive = cmd({ driveY: 1, leftDrive: 1, rightDrive: 1 });
    const truth = pushScene(1001);
    const lightWorld = pushScene(1001);
    const fullWorld = pushScene(1001);
    const light = createLightPredictor(lightWorld, LOCAL);
    const full = createFullPredictor(fullWorld, LOCAL);
    light.reset(lightWorld, lightWorld.tick);
    full.reset(fullWorld, fullWorld.tick);
    const lr = replay(light, drive, PREDICT_MAX_TICKS);
    const fr = replay(full, drive, PREDICT_MAX_TICKS);
    const auth = authoritative(truth, drive, PREDICT_MAX_TICKS);
    const dl = dist(lr.pose, auth);
    const df = dist(fr.pose, auth);
    console.log(
      `[smoke-bb predict] scripted push (4 POLLEN into the +y wall), ${PREDICT_MAX_TICKS} ticks: ` +
        `light off by ${dl.toFixed(3)}in (${lr.ms.toFixed(1)}ms), full off by ${df.toFixed(3)}in (${fr.ms.toFixed(1)}ms)`,
    );
    check(
      `scripted push: LIGHT converges within SMOOTH_MAX_DIST (${SMOOTH_MAX_DIST}in) so the correction EASES, never snaps`,
      dl < SMOOTH_MAX_DIST,
      `${dl.toFixed(3)}in`,
    );
    check(
      `scripted push: FULL converges within SMOOTH_MAX_DIST (${SMOOTH_MAX_DIST}in)`,
      df < SMOOTH_MAX_DIST,
      `${df.toFixed(3)}in`,
    );
    /**
     * AND FULL HAS TO BE BETTER THAN LIGHT HERE, OR IT IS NOT WORTH ITS WASM. That is the whole
     * of the Prediction setting's argument: Light is exact on open floor and approximate in
     * contact, Full carries the contact. If this ever reverses, the setting is offering a choice
     * that costs 1.09 MB and buys nothing, and THAT is the finding — not a tolerance to widen.
     */
    check(
      'scripted push: FULL is closer than LIGHT — the contact is what it is for',
      df <= dl,
      `full ${df.toFixed(3)}in vs light ${dl.toFixed(3)}in`,
    );
    light.dispose();
    full.dispose();
  }

  // ---- what FULL carries, and what it leaves out -----------------------------------------------
  {
    const w = pushScene(1003);
    // one element inside the radius and one well outside it
    w.balls.push({
      id: 900,
      color: 'yellow',
      state: { kind: 'ground' },
      pos: { x: 0, y: 20 + PREDICT_ELEMENT_RADIUS + 20 },
      vel: { x: 0, y: 0 },
      z: 0,
      vz: 0,
      r: BB_POLLEN_R,
    } as Artifact);
    const full = createFullPredictor(w, LOCAL);
    full.reset(w, w.tick);
    // the far element cannot reach the robot inside the window, which is the whole argument for
    // the radius; assert the predictor still produces a finite pose with it present.
    const pose = full.step(cmd({ driveY: 1, leftDrive: 1, rightDrive: 1 }));
    check(
      'FULL carries only the near elements and still returns a finite pose',
      Number.isFinite(pose.pos.x) && Number.isFinite(pose.pos.y) && Number.isFinite(pose.heading),
      `pose (${pose.pos.x.toFixed(2)}, ${pose.pos.y.toFixed(2)}) heading ${pose.heading.toFixed(3)}`,
    );
    full.dispose();
  }

  // ---- determinism, and the no-side-effects contract -------------------------------------------
  {
    const drive = cmd({ driveY: 1, rotate: 0.4, leftDrive: 0.6, rightDrive: 1 });
    const runs: string[] = [];
    for (let i = 0; i < 2; i++) {
      const w = pushScene(1004);
      const p = createFullPredictor(w, LOCAL);
      p.reset(w, w.tick);
      const { pose } = replay(p, drive, PREDICT_MAX_TICKS);
      p.dispose();
      runs.push(`${pose.pos.x}|${pose.pos.y}|${pose.heading}|${pose.vel.x}|${pose.vel.y}|${pose.angVel}`);
    }
    check('determinism: two identical FULL reconciles produce the identical pose', runs[0] === runs[1], `${runs[0]} vs ${runs[1]}`);

    const lruns: string[] = [];
    for (let i = 0; i < 2; i++) {
      const w = pushScene(1005);
      const p = createLightPredictor(w, LOCAL);
      p.reset(w, w.tick);
      const { pose } = replay(p, drive, PREDICT_MAX_TICKS);
      p.dispose();
      lruns.push(`${pose.pos.x}|${pose.pos.y}|${pose.heading}|${pose.angVel}`);
    }
    check('determinism: two identical LIGHT reconciles produce the identical pose', lruns[0] === lruns[1], `${lruns[0]} vs ${lruns[1]}`);

    /**
     * ⚠️ **A PREDICTOR MUST NOT WRITE TO THE WORLD IT WAS RESET FROM.** It is a CLIENT's opinion
     * about the near future, and the world it reads is the one the server owns; a predictor that
     * mutated it would be writing that opinion into the authoritative state, which is the exact
     * shape of a client-authority bug. Both predictors clone the local robot and hand the clone a
     * scratch world for that reason, and this is the check that says so rather than the comment.
     */
    const w = pushScene(1006);
    const before = JSON.stringify({
      robots: w.robots.map((r) => [r.id, r.pos.x, r.pos.y, r.heading, r.vel.x, r.vel.y, r.angVel, r.powerDraw]),
      balls: w.balls.map((b) => [b.id, b.pos.x, b.pos.y, b.z]),
      tick: w.tick,
      time: w.time,
    });
    const light = createLightPredictor(w, LOCAL);
    const full = createFullPredictor(w, LOCAL);
    replay(light, drive, PREDICT_MAX_TICKS);
    replay(full, drive, PREDICT_MAX_TICKS);
    light.dispose();
    full.dispose();
    const after = JSON.stringify({
      robots: w.robots.map((r) => [r.id, r.pos.x, r.pos.y, r.heading, r.vel.x, r.vel.y, r.angVel, r.powerDraw]),
      balls: w.balls.map((b) => [b.id, b.pos.x, b.pos.y, b.z]),
      tick: w.tick,
      time: w.time,
    });
    check('neither predictor writes to the authoritative world it was reset from', before === after, 'robot and element state compared before/after');
  }

  // =============================================================================================
  // ARCHETYPE REACH HARDWARE, PREDICTED (owner, 2026-09-20: "It should be a collider.") — both
  // predictors now build the SAME reach shapes the authority does (`chassis3dReachShapes`,
  // `reachColliderDesc`, `bodies.ts`), re-fit at the same settle edge — a side roller's wheel in
  // the DEFAULT collision group (meets an element too, since 2026-09-20's "it should also be
  // colliding with everything"), a ramp's crossbar/rails likewise. Without this a driver with
  // side rollers or a deployed ramp would rubber-band ~1.9in / ~2.17in at every wall the
  // authority stands them off from and the predictor does not.
  // =============================================================================================
  // (f) FULL agrees with the authority on the wall standoff, for both a side-roller build and a
  // DEPLOYED ramp — the LIGHT predictor is not part of this claim (it has no colliders at all;
  // that is the trade `createLightPredictor`'s own header documents).
  //
  // ⚠️ THE RAMP'S OWN TOLERANCE WIDENED WITH ITS REACH (owner, 2026-09-20: "the ramp might need
  // to reach further out" — `BB_RAMP_L`/`BB_RAMP_ANGLE` lengthened, `BB_RAMP_OUT` 2.17 → ≈3.02).
  // The predictor/authority divergence scales with how much extra geometry is sticking out past
  // the bare footprint, so a longer ramp measures a bigger gap for the same reason a bigger
  // side-roller stand-off would: MEASURED at the new length, 1.43 in (was ~0.42 at the old 2.17).
  //
  // ⚠️ SIDE ROLLERS WIDENED TOO, 2026-09-20 (owner: the wheel is now a bigger, SOLID cylinder —
  // `BB_SIDE_ROLLER_R` 1.0 → 1.5, and `chassis3dReachShapes`/`reachColliderDesc` build it as
  // `ColliderDesc.cylinder` in the DEFAULT collision group rather than a `GROUP_POCKET` box).
  // A round collider makes LINE contact against a flat wall where a box made FACE contact, and
  // the two independently-stepped Rapier worlds (authority vs the FULL predictor) resolve that
  // contact a little differently each — MEASURED: 1.777in (was well under 1in as a box). 1.9in
  // covers it with a small margin, the same shape as the ramp's own widening above.
  for (const [label, spec, deploy, tol] of [
    ['SIDE ROLLERS', SIDEROLLER_SPEC, false, 1.9],
    ['a DEPLOYED RAMP', RAMP_SPEC, true, 1.6],
  ] as const) {
    const drive = cmd({ driveY: 1, leftDrive: 1, rightDrive: 1 });
    const truth = archWallScene(9200, spec);
    const predWorld = archWallScene(9200, spec);
    if (deploy) {
      truth.robots[LOCAL].bbRampOut = true;
      truth.robots[LOCAL].bbRampAt = -10; // long since settled
      predWorld.robots[LOCAL].bbRampOut = true;
      predWorld.robots[LOCAL].bbRampAt = -10;
    }
    const auth = authoritative(truth, drive, PREDICT_MAX_TICKS);
    const full = createFullPredictor(predWorld, LOCAL);
    full.reset(predWorld, predWorld.tick);
    const fr = replay(full, drive, PREDICT_MAX_TICKS);
    full.dispose();
    const df = dist(fr.pose, auth);
    // the bare footprint's own standoff (no archetype) for scale, so a FAILURE reads as "close to
    // the archetype's own extra" (predictor missing the reach hardware) rather than a mystery
    // number — `BB_SIDE_ROLLER_OUT + BB_SIDE_ROLLER_R` is the side-roller figure either way (the
    // ramp's own extra, `BB_RAMP_OUT`, is smaller, so this is the conservative one to print).
    console.log(
      `[smoke-bb predict] wall standoff, ${label}: authority (${auth.pos.x.toFixed(3)}, ${auth.pos.y.toFixed(3)}) vs ` +
        `FULL (${fr.pose.pos.x.toFixed(3)}, ${fr.pose.pos.y.toFixed(3)}) — off by ${df.toFixed(3)}in ` +
        `(the archetype's own extra reach is ${(BB_SIDE_ROLLER_OUT + BB_SIDE_ROLLER_R).toFixed(2)}in)`,
    );
    check(
      `wall standoff: FULL agrees with the authority within ${tol}in for ${label} (both carry the reach hardware now)`,
      df < tol,
      `off by ${df.toFixed(3)}in`,
    );
  }

  /**
   * A FULL HOPPER INTO A WALL ROW OF POLLEN DOES NOT LIFT THE PREDICTED ROBOT (owner, 2026-09-24:
   * "When my robot is full of balls (intake stopped) and I drive into a row of pollen that are
   * against the field wall, my whole robot jumps upwards").
   *
   * The authority lets that row into the mouth pocket and never leaves the tiles. The predictor's
   * chassis was one solid cuboid, so the pinned row was in front of a solid face and the solver
   * lifted the chassis over it: 0.94–1.04 in at a 6-tick lead, 2.08–2.23 at 20, on the three
   * builds below, every reconcile. Each is paired with the authority's own height on the same run,
   * so the check cannot pass on a robot that never reached the row.
   */
  {
    const wallY = -BB_HALF_Y;
    const rows: string[] = [];
    let ok = true;
    for (const key of ['harvester', 'pollinator', 'sidewinder']) {
      const w = mkWorld3d('free', 4400, bbBotBuildByKey(key));
      w.balls.length = 0;
      for (let k = 0; k < 7; k++) {
        w.balls.push({
          id: 100 + k,
          color: 'yellow',
          state: { kind: 'ground' },
          pos: { x: -44 + (k - 3) * 2 * BB_POLLEN_R, y: wallY + BB_POLLEN_R + 0.02 },
          vel: { x: 0, y: 0 },
          z: 0,
          vz: 0,
          r: BB_POLLEN_R,
        } as Artifact);
      }
      const r = w.robots[0];
      r.hopper.length = 0;
      for (let k = 0; k < bbHopperCap(r.spec); k++) r.hopper.push('yellow');
      r.pos = { x: -44, y: wallY + 30 };
      const side = r.spec.intakeMount === 'side';
      r.heading = side ? Math.PI : -Math.PI / 2;
      const c = side ? cmd({ driveX: -1, intake: true }) : cmd({ driveY: 1, leftDrive: 1, rightDrive: 1, intake: true });
      const p = createFullPredictor(w, 0);
      let pred = 0;
      let auth = 0;
      let reached = Infinity;
      for (let t = 0; t < 240; t++) {
        step3d(w, SIM_DT, new Map([[0, c]]));
        auth = Math.max(auth, r.z ?? 0);
        reached = Math.min(reached, r.pos.y - wallY);
        if (t % 4 === 0) {
          p.reset(w, w.tick);
          let pose = p.step(c);
          for (let k = 1; k < 20; k++) pose = p.step(c);
          pred = Math.max(pred, pose.z);
        }
      }
      p.dispose();
      if (!(pred < 0.1 && auth < 0.1 && reached < 16)) ok = false;
      rows.push(`${key}: predicted max z ${pred.toFixed(2)}, authority ${auth.toFixed(2)}, got within ${reached.toFixed(1)} in of the wall`);
    }
    check('⚠️ predict: a full hopper driven into a wall row of POLLEN does not lift the predicted robot', ok, rows.join(' · '));
  }

  /**
   * THE OTHER ROBOTS RIDE THEIR HELD COMMANDS (2026-09-27). Once the client runs a round trip
   * ahead, an opponent frozen at the snapshot pose is a wall a round trip out of date, so both
   * predictors now step it on the command the server last said it ran. Checked against the real
   * `step3d` with the same two commands, and against the old frozen guess so the check is not
   * vacuous (the opponent has to actually go somewhere).
   */
  {
    const mk = (): World => {
      const w = mkWorld3dPair('free', 777);
      w.balls.length = 0;
      const [a, b] = w.robots;
      a.pos.x = -40; a.pos.y = -30; a.heading = 0;
      b.pos.x = -10; b.pos.y = 30; b.heading = Math.PI / 2;
      for (const r of [a, b]) { r.vel.x = 0; r.vel.y = 0; r.angVel = 0; r.hopper.length = 0; }
      return w;
    };
    const cLocal = cmd({ driveY: 0.6, leftDrive: 0.6, rightDrive: 0.6 });
    const cRemote = cmd({ driveX: 0.8, driveY: 0.8, leftDrive: 1, rightDrive: 1 });
    const TICKS = 24;
    const auth = mk();
    const start = { ...auth.robots[1].pos };
    const both = new Map([[0, cLocal], [1, cRemote]]);
    for (let i = 0; i < TICKS; i++) step3d(auth, SIM_DT, both);
    const truth = auth.robots[1];
    const travelled = Math.hypot(truth.pos.x - start.x, truth.pos.y - start.y);
    const rows: string[] = [];
    let ok = travelled > 5;
    for (const kind of ['full', 'light'] as const) {
      const w = mk();
      const p = kind === 'full' ? createFullPredictor(w, LOCAL) : createLightPredictor(w, LOCAL);
      for (let i = 0; i < TICKS; i++) p.step(cLocal, new Map([[1, cRemote]]));
      const got = (p.robots() ?? []).find((r) => r.id === 1);
      p.dispose();
      const err = got ? Math.hypot(got.x - truth.pos.x, got.y - truth.pos.y) : Infinity;
      if (!(err < 1.5)) ok = false;
      rows.push(`${kind}: remote off by ${err.toFixed(2)} in`);
    }
    check('predict: FULL and LIGHT step a remote robot on its held command, to within 1.5 in of step3d',
      ok, `it travelled ${travelled.toFixed(1)} in (a frozen guess would be off by that much) · ${rows.join(' · ')}`);
  }

  /** LIGHT has no solver, so it separates two robots' footprints itself (`separateLight`). */
  {
    const w = mkWorld3dPair('free', 778);
    w.balls.length = 0;
    const [a, b] = w.robots;
    a.pos.x = 0; a.pos.y = 0; a.heading = 0;
    b.pos.x = 10; b.pos.y = 0; b.heading = 0; // ~5 in of overlap for an 18 in chassis
    for (const r of [a, b]) { r.vel.x = 0; r.vel.y = 0; r.angVel = 0; }
    const p = createLightPredictor(w, LOCAL);
    const pose = p.step(cmd({}), new Map());
    const other = (p.robots() ?? []).find((r) => r.id === 1);
    p.dispose();
    const gap = other ? other.x - pose.pos.x : 0;
    check('predict: LIGHT pushes two overlapping robots apart instead of driving through',
      gap > 12, `centres ${gap.toFixed(2)} in apart after one tick (started 10)`);
  }

  /**
   * FULL PREDICTS EVERYTHING by running the real `step3d` on the client, on ONE persistent engine
   * REWOUND onto each snapshot (`rewindEngineTo`) — a rebuild is 15–40 ms and a snapshot lands 30
   * times a second. The rewind has to reproduce what the server does from that snapshot: here a
   * world is run on past a snapshot (the truth), then its engine is rewound onto the snapshot and
   * the same inputs replayed. Measured when written: robots within 0.06 in, elements within
   * 1.07 in, the HIVE trays exact — and a FRESH engine built from the same snapshot does worse on
   * elements (0.45–4.4 in), because it loses the bodies' sleep and contact history.
   */
  {
    const clone = (w: World): World => JSON.parse(JSON.stringify(w)) as World;
    const cmdsAt = (t: number) => new Map([0, 1].map((id) => [id, cmd({ driveX: Math.sin(t / 40 + id) * 0.8, driveY: Math.cos(t / 55 + id) * 0.8, intake: true, fire: t % 90 < 20 })]));
    const W = mkWorld3dPair('match', 11);
    W.match.phase = 'teleop';
    W.match.phaseTimeLeft = 110;
    let t = 0;
    for (; t < 400; t++) step3d(W, SIM_DT, cmdsAt(t));
    let rob = 0, ball = 0, hive = 0, travelled = 0, allOk = true;
    let live = W;
    for (let trial = 0; trial < 4; trial++) {
      for (let i = 0; i < 37; i++, t++) step3d(live, SIM_DT, cmdsAt(t));
      const snap = clone(live);
      const k = t;
      const before = live.robots.map((r) => ({ ...r.pos }));
      for (let i = 0; i < 12; i++) step3d(live, SIM_DT, cmdsAt(k + i));
      const truth = clone(live);
      live.robots.forEach((r, i) => { travelled = Math.max(travelled, Math.hypot(r.pos.x - before[i].x, r.pos.y - before[i].y)); });
      const S = clone(snap);
      allOk = rewindEngineTo(live, S) && allOk;
      for (let i = 0; i < 12; i++) step3d(S, SIM_DT, cmdsAt(k + i));
      for (const r of truth.robots) { const q = S.robots.find((x) => x.id === r.id)!; rob = Math.max(rob, Math.hypot(r.pos.x - q.pos.x, r.pos.y - q.pos.y)); }
      for (const b of truth.balls) { const q = S.balls.find((x) => x.id === b.id)!; ball = Math.max(ball, Math.hypot(b.pos.x - q.pos.x, b.pos.y - q.pos.y, b.z - q.z)); }
      for (const a of ['red', 'blue'] as const) hive = Math.max(hive, Math.abs((truth.biobuzz!.hives[a].angle ?? 0) - (S.biobuzz!.hives[a].angle ?? 0)));
      live = S; // carry on from the rewound world, as the client does
      t = k + 12;
    }
    disposeEngineFor(live);
    check('⚠️ world predict: a rewound engine replays a snapshot the way the server ran it (robots < 0.2 in, elements < 2 in, trays exact)',
      allOk && travelled > 3 && rob < 0.2 && ball < 2 && hive < 1e-4,
      `robots ${rob.toFixed(4)} in, elements ${ball.toFixed(3)} in, trays ${hive.toExponential(1)} rad, robots travelled ${travelled.toFixed(1)} in per window`);
    const A = mkWorld3dPair('match', 12);
    step3d(A, SIM_DT, new Map());
    const B = clone(A);
    B.robots.pop();
    check('world predict: a rewind onto a different robot set refuses (engineFor rebuilds instead)', !rewindEngineTo(A, B));
    disposeEngineFor(B);
  }
}

/**
 * THE BUDGETS: every check here compares a wall-clock reading against an absolute number of
 * milliseconds, so it runs in the PERF lane (`index.ts`), not in this one. `npm test` runs that
 * lane on its own after every other shard has finished (`bbshard.mjs`, `test-all.mjs`), because a
 * budget is a claim about what the work costs on an otherwise idle machine, and under 18
 * processes the core itself runs slower: the minimum of 30 readings still read 6.3-7.4 ms there
 * for a reconcile that costs 4.0 ms alone. `TIMING_REPS` handles the rest (other programs,
 * interrupts, GC).
 */
export function predictPerfChecks(check: Check): void {
  // ---- the budgets ---------------------------------------------------------------------------
  //
  // MEASURED ON THIS MACHINE, and reported whatever they say. `PREDICT_FULL_BUDGET_MS` is a
  // DECISION threshold that Auto evaluates on the player's own device during the countdown, so a
  // dev box passing it is not a promise about a phone — it is the floor under which the constant
  // is a sane default at all.
  {
    const w = pushScene(1002);
    const drive = cmd({ driveY: 1, leftDrive: 1, rightDrive: 1 });
    const light = createLightPredictor(w, LOCAL);
    let lightMs = Infinity;
    for (let i = 0; i < TIMING_REPS; i++) {
      light.reset(w, w.tick);
      lightMs = Math.min(lightMs, replay(light, drive, PREDICT_MAX_TICKS).ms);
    }
    light.dispose();
    const full = createFullPredictor(w, LOCAL);
    let fullMs = Infinity;
    for (let i = 0; i < TIMING_REPS; i++) {
      full.reset(w, w.tick);
      fullMs = Math.min(fullMs, replay(full, drive, PREDICT_MAX_TICKS).ms);
    }
    full.dispose();
    const probe = probeFullReconcileMs(w, LOCAL, () => performance.now());
    console.log(
      `[smoke-bb predict] budgets, best of ${TIMING_REPS}: LIGHT ${lightMs.toFixed(2)}ms (budget ${PREDICT_LIGHT_BUDGET_MS}), ` +
        `FULL ${fullMs.toFixed(2)}ms (budget ${PREDICT_FULL_BUDGET_MS}); probeFullReconcileMs reports ${probe.toFixed(1)}ms`,
    );
    check(
      `LIGHT reconciles ${PREDICT_MAX_TICKS} ticks inside ${PREDICT_LIGHT_BUDGET_MS}ms`,
      lightMs <= PREDICT_LIGHT_BUDGET_MS,
      `${lightMs.toFixed(2)}ms`,
    );
    check(
      `FULL reconciles ${PREDICT_MAX_TICKS} ticks inside PREDICT_FULL_BUDGET_MS (${PREDICT_FULL_BUDGET_MS}ms)`,
      fullMs <= PREDICT_FULL_BUDGET_MS,
      `${fullMs.toFixed(2)}ms on this machine (best of ${TIMING_REPS})`,
    );
    check(
      'the Auto probe measures the same thing the budget is written against',
      Number.isFinite(probe) && probe <= PREDICT_FULL_BUDGET_MS * 3,
      `probe ${probe.toFixed(1)}ms vs a direct replay of ${fullMs.toFixed(2)}ms`,
    );
  }

  // the reconcile-cost delta the reach hardware buys, measured directly against the SAME
  // 40-tick budget the mouth-pocket compound was rejected over (`predict.ts`'s own note above
  // `makeRobotBody`) — a handful of small boxes is a different trade from a whole compound.
  {
    const baseline = pushScene(9210); // the file's own default-spec fixture, no archetype
    let baselineMs = Infinity;
    for (let i = 0; i < TIMING_REPS; i++) baselineMs = Math.min(baselineMs, probeFullReconcileMs(baseline, LOCAL, () => performance.now()));
    const sideWorld = archWallScene(9211, SIDEROLLER_SPEC);
    let sideMs = Infinity;
    for (let i = 0; i < TIMING_REPS; i++) sideMs = Math.min(sideMs, probeFullReconcileMs(sideWorld, LOCAL, () => performance.now()));
    const rampWorld = archWallScene(9212, RAMP_SPEC);
    rampWorld.robots[LOCAL].bbRampOut = true;
    rampWorld.robots[LOCAL].bbRampAt = -10;
    let rampMs = Infinity;
    for (let i = 0; i < TIMING_REPS; i++) rampMs = Math.min(rampMs, probeFullReconcileMs(rampWorld, LOCAL, () => performance.now()));
    console.log(
      `[smoke-bb predict] FULL reconcile cost, best of ${TIMING_REPS}, ${PREDICT_MAX_TICKS} ticks: ` +
        `no archetype (baseline) ${baselineMs.toFixed(1)}ms · SIDE ROLLERS ${sideMs.toFixed(1)}ms · DEPLOYED RAMP ${rampMs.toFixed(1)}ms · ` +
        `budget ${PREDICT_FULL_BUDGET_MS}ms`,
    );
    check(
      `FULL still reconciles inside PREDICT_FULL_BUDGET_MS with SIDE ROLLERS live`,
      sideMs <= PREDICT_FULL_BUDGET_MS,
      `${sideMs.toFixed(1)}ms vs budget ${PREDICT_FULL_BUDGET_MS}ms (baseline ${baselineMs.toFixed(1)}ms)`,
    );
    check(
      `FULL still reconciles inside PREDICT_FULL_BUDGET_MS with a DEPLOYED RAMP live`,
      rampMs <= PREDICT_FULL_BUDGET_MS,
      `${rampMs.toFixed(1)}ms vs budget ${PREDICT_FULL_BUDGET_MS}ms (baseline ${baselineMs.toFixed(1)}ms)`,
    );
  }
}
