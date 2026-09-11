import type { Alliance, Artifact, RobotCommand, RobotState, World } from '../../types';
import * as C from '../../config';
import { clamp, rot, wrapAngle } from '../../math';
import { solveArtifacts, type SweepFrom } from '../../sim/physicsEngine';
import { stepGroundBall } from '../../sim/physics';
import { robotSolids, type RobotSolids } from '../../sim/artifactSolids';
import {
  BB_AIM_GAIN,
  BB_AIM_TOL,
  BB_HALF_X,
  BB_HALF_Y,
  BB_POLLEN_R,
  BB_POLLEN_WALL_REST,
} from './config';
import { biobuzzColliders } from './colliders';
import { capturePollen, scoreTargets } from './elements';
import { bbAimHeading, bbLaunch, bbMouths } from './robot';
import { rectContains, type BiobuzzState } from './state';

/**
 * BIOBUZZ GAMEPLAY TICK — POLLEN physics and the intake/launch loop.
 *
 * This is the shell's only real gameplay: pollen roll, settle, get collected, and get thrown
 * back out. There is no scoring, because Section 10 of the V0 manual is a Kickoff placeholder
 * (`scored: false` on the sim module says so at the seam). What there IS, and what has to be
 * right before anything is built on top of it, is a POLLEN model that CONSERVES COUNT and
 * NEVER LEAKS OUT OF THE FIELD under every input a driver can produce.
 *
 * ── THERE IS ONE SOLVER, AND IT IS NOT IN THIS FILE ────────────────────────
 * GROUND POLLEN are solved by the SHARED artifact solve, `solveArtifacts`
 * (`src/sim/physicsEngine.ts`), with `BB_POLLEN_R` as the radius. Each ground POLLEN is a real
 * Rapier body that sees every static this game's `colliders` declares plus every robot's
 * artifact-solid geometry (`robotSolids`, built at the same radius), with each chassis an
 * IMMOVABLE SWEEP from its pose at the start of the tick to where the robot solve left it.
 *
 * NOTHING IN THIS DIRECTORY INTEGRATES, SEPARATES, CLAMPS OR EVICTS A GROUND POLLEN, and that
 * is a decision rather than an omission. The repo OWNER owns artifact physics and reworked it
 * on `alpha` around one rule: **every element ends the tick somewhere it is allowed to be, with
 * ONE POSITION AUTHORITY per element.** Some forty bespoke position-writing passes used to take
 * turns in DECODE, and every "the balls go on top of the robot" report was two of them
 * disagreeing. A second ball integrator living here would be exactly that failure, imported
 * into a new game on purpose — and it would also have to be re-derived every time the owner
 * moves the shared solve, which he is doing. So BIOBUZZ passes a RADIUS and nothing else.
 *
 * There used to be a `BB_BALL_SOLVER` switch with a second, bespoke arm here (CR's
 * friction/rest-speed integrator, a spatial-hash separation pass, an explicit wall clamp with
 * restitution) built so Phase 0.5 could compare the two. It is GONE, and the comparison it
 * was for is not the question any more: the question was "which model feels like pollen", and
 * the answer to "who owns ball physics" settles it first. `docs/biobuzz-plan.md` Phase 0.5 and
 * `docs/biobuzz/feedback/000-solver-observations.md` record what the shared solver actually
 * does with a 1.5" element.
 *
 * The two DECODE-only exemption sets `solveArtifacts` takes are EMPTY here, and both are facts
 * about this game rather than stubs:
 *   · `claimed` names the artifacts an intake has hold of but has not yet taken. BIOBUZZ has
 *     no such state: `interact()` either captures a POLLEN outright this tick
 *     (`capturePollen` → `state.kind === 'held'`) or leaves it to the solver.
 *   · `doorway` names the artifact a gate is expelling, and BIOBUZZ has no gates.
 *
 * TWO THINGS ARE STILL THIS FILE'S. FLIGHT pollen, because the shared solve only looks at
 * ground elements — the ballistic step below is the only writer of a flying POLLEN's position
 * and competes with nothing. And the PERIMETER INVARIANT for ground pollen
 * (`clampPollenToWalls`), because the solve does not hold it: measured, removing that pass put
 * a POLLEN 2.02" through the wall in `wall-row-sweep`. DECODE holds the same invariant the same
 * way, inside its round loop. See that function's own note.
 */

/**
 * THE CONTAINMENT INVARIANT — put a POLLEN back inside the perimeter, bouncing it off the wall
 * it reached.
 *
 * THE SOLVE DOES NOT HOLD THE PERIMETER FOR ARTIFACTS ON ITS OWN, and that was MEASURED here
 * rather than assumed: with this pass removed, `wall-row-sweep` put a POLLEN **2.02" past the
 * wall plane** (tick 105) and `pile-fast` 1.52", on a 1.5" element. DECODE holds the same
 * invariant the same way — `src/sim/world.ts` runs `clampBallPosToStatics` on every ground
 * artifact INSIDE its round loop — so a containment clamp is part of the sanctioned design,
 * not a competing authority: the solve decides where an artifact goes and this only acts where
 * the solve had no answer to give.
 *
 * WHY THE SOLVE CANNOT WIN THAT SQUEEZE, and it is worth writing down because it is not the
 * radius: BIOBUZZ does not run the PIN half of DECODE's round loop (`pinnedArtifacts` →
 * `PinnedCircle` → re-run `solveRobots`). Nothing tells the robot solve that a POLLEN against
 * a wall is a wall, so the chassis drives on through the space the POLLEN is in and the POLLEN
 * has nowhere to be. That is the first item in `docs/biobuzz/feedback/000-solver-observations.md`
 * "For the owner", and it is NOT fixed here — porting the round loop is shared-physics work.
 *
 * ⚠️ THE BOUNCE TERM IS A KNOWN DISAGREEMENT WITH THE SHARED SOLVE, also for the owner. DECODE
 * does not reverse the velocity at its clamp, it REMOVES the component pointing into the wall
 * (`fieldPushback` beside the clamp in `world.ts`), having measured that a reversal reads as an
 * impact on the next tick and bounces artifact and robot apart. This reverses it, scaled by
 * `BB_POLLEN_WALL_REST`. It is left exactly as it was because re-deriving it here would be a
 * BIOBUZZ copy of shared physics, which is the thing this file just stopped doing.
 */
function clampPollenToWalls(b: Artifact): void {
  const lim = BB_HALF_X - BB_POLLEN_R;
  const limY = BB_HALF_Y - BB_POLLEN_R;
  if (b.pos.x > lim) {
    b.pos.x = lim;
    if (b.vel.x > 0) b.vel.x = -b.vel.x * BB_POLLEN_WALL_REST;
  } else if (b.pos.x < -lim) {
    b.pos.x = -lim;
    if (b.vel.x < 0) b.vel.x = -b.vel.x * BB_POLLEN_WALL_REST;
  }
  if (b.pos.y > limY) {
    b.pos.y = limY;
    if (b.vel.y > 0) b.vel.y = -b.vel.y * BB_POLLEN_WALL_REST;
  } else if (b.pos.y < -limY) {
    b.pos.y = -limY;
    if (b.vel.y < 0) b.vel.y = -b.vel.y * BB_POLLEN_WALL_REST;
  }
}

/** put a POLLEN back on the tile at `pos`, dead stopped. The single landing path, so a lob, a
 * dump and an eviction all come to rest the same way. */
function land(b: Artifact, x: number, y: number): void {
  b.state = { kind: 'ground' };
  b.pos = { x, y };
  b.vel = { x: 0, y: 0 };
  b.z = 0;
  b.vz = 0;
}

/**
 * Resolve one ground POLLEN against one robot: CAPTURE IT, OR LEAVE IT ALONE.
 *
 * Capture and nothing else. There used to be a PLOW branch here — if the POLLEN was inside the
 * footprint and not collected, this pushed it out along the minimum-penetration axis by the
 * whole penetration depth and gave it the robot's speed. That was a SECOND POSITION WRITER for
 * a ground pollen, fighting the shared solve for the same element on the same tick, which is
 * the one thing the artifact rework on `alpha` forbids. It is gone. The chassis, the intake
 * structure and the held pollen are all colliders in `solveArtifacts` (via `robotSolids`), so
 * everything the plow was reaching for — a pollen shoved ahead of a driving frame, a pollen
 * squeezed against a wall popping out sideways — is the solve's own answer, computed from the
 * chassis sweep rather than from a normal guessed off a box.
 *
 * A POLLEN AT THE ROLLER IS STILL COLLECTED BEFORE THE FRAME REACHES IT, because this runs
 * BEFORE the solve in `updateBiobuzz`'s stage order. Driving into a pile collects it instead of
 * scattering it, which is the single biggest difference between an intake that feels real and
 * one that feels like a bulldozer.
 */
function interact(
  world: World,
  b: Artifact,
  rob: RobotState,
  cmd: RobotCommand | undefined,
  enabled: boolean,
): 'collected' | 'none' {
  const intakeActive = enabled && (rob.autoIntake || (cmd?.intake ?? false));
  if (!intakeActive) return 'none';
  const local = rot({ x: b.pos.x - rob.pos.x, y: b.pos.y - rob.pos.y }, -rob.heading);
  // ANY mounted edge grabs: one mouth for front/back, two for `side` (both flanks) and
  // `frontback` (both ends). `capturePollen` is what enforces the hopper cap, so a full robot
  // simply leaves the POLLEN on the floor for the solve to push around.
  for (const m of bbMouths(rob.spec)) {
    if (rectContains(m, local.x, local.y, BB_POLLEN_R) && capturePollen(world, rob, b)) return 'collected';
  }
  return 'none';
}

/**
 * The BIOBUZZ gameplay tick.
 *
 * ORDER IS THE CONTRACT (and `step.ts` documents the pipeline this sits inside):
 *   1. HELD pollen ride their robot — position only, no physics.
 *   2. FLIGHT pollen integrate ballistically and LAND.
 *   3. GROUND pollen: the shared rolling-friction/rest-snap pass (`stepGroundBall`, velocity
 *      only), then the robots — CAPTURE only, nothing is moved here.
 *   4. the SHARED artifact solve runs, at `BB_POLLEN_R` — the ONE position authority for a
 *      ground pollen: no integration, no separation pass and no eviction. Then the perimeter
 *      invariant, which the solve does not hold on its own (see `clampPollenToWalls`).
 *   5. LAUNCHERS fire, which is what creates tick-N+1's flight pollen.
 *   6. the score/endgame pass — a no-op in the shell, kept so its shape is fixed.
 *
 * Launching LAST is deliberate: a POLLEN released this tick should not be integrated,
 * collected and re-collected within the same tick, and firing at the end gives it exactly one
 * clean tick of flight before anything looks at it.
 */
export function updateBiobuzz(
  world: World,
  dt: number,
  cmds: Map<number, RobotCommand>,
  enabled: boolean,
  /** each robot's pose at the START of this tick (`step.ts`, stage 0) — the artifact solve
   *  sweeps the chassis from there. Absent ⇒ no sweep, which is what a direct caller gets. */
  from?: ReadonlyMap<number, SweepFrom>,
): void {
  const bb = world.biobuzz as BiobuzzState | undefined;
  if (!bb) return; // an old snapshot from before this game existed; nothing to do

  const byId = new Map<number, RobotState>();
  for (const r of world.robots) byId.set(r.id, r);

  // ── 1. HELD: ride the robot ────────────────────────────────────────────────
  // A held POLLEN stays in `world.balls` (see `capturePollen`) so the count is conserved in
  // ONE place. It has no physics — it is inside the hopper — but its position has to track
  // the robot or the renderer would draw it where the robot used to be.
  for (const b of world.balls) {
    if (b.state.kind !== 'held') continue;
    const rob = byId.get(b.state.robot);
    if (!rob) {
      // its robot is gone (a mid-match leave). Drop it on the tile rather than deleting it:
      // deleting would break conservation, and a POLLEN that falls out of a departing robot
      // is what would physically happen.
      land(b, b.pos.x, b.pos.y);
      continue;
    }
    const off = rot({ x: b.state.lx, y: b.state.ly }, rob.heading);
    b.pos = { x: rob.pos.x + off.x, y: rob.pos.y + off.y };
  }

  // ── 2. FLIGHT: ballistic, then land ────────────────────────────────────────
  for (const b of world.balls) {
    if (b.state.kind !== 'flight') continue;
    b.pos.x += b.vel.x * dt;
    b.pos.y += b.vel.y * dt;
    b.z += b.vz * dt;
    b.vz -= C.GRAVITY * dt;
    // a POLLEN thrown at the wall lands against it rather than through it
    clampPollenToWalls(b);
    if (b.z <= 0) land(b, b.pos.x, b.pos.y);
  }

  // ── 3. GROUND: roll, then meet the robots ─────────────────────────────────
  /**
   * ROLLING RESISTANCE AND THE REST SNAP ARE THE SHARED CORE'S — `stepGroundBall`
   * (`src/sim/physics.ts`), the same call `src/sim/world.ts` makes at the same point in the
   * tick, with the same `BALL_ROLL_FRICTION` / `BALL_REST_SPEED`. It is VELOCITY ONLY and moves
   * nothing, so it is not a second position authority: it sets the speed the solve below starts
   * from, which is exactly the contract its own comment states.
   *
   * It is NOT optional and it is NOT cosmetic. `solveArtifacts` runs in a plane with no
   * gravity, so there is no floor contact for Rapier to bleed speed through — a POLLEN it has
   * pushed keeps that speed forever. Measured with this call missing: five seconds after the
   * robot stopped, `pile-slow`'s pile was still travelling at 18.98 in/s and `wall-row-sweep`'s
   * row at 19.54, and nothing in any scene ever came to rest.
   *
   * BIOBUZZ's own `BB_POLLEN_FRICTION` (42) and `BB_POLLEN_REST_SPEED` (1.5) are deleted rather
   * than passed in. The shared numbers (32 / 2) are tuned for a 5" artifact and a 3" POLLEN may
   * well want different ones — but that is a shared-constant question for the repo owner, and a
   * BIOBUZZ copy of them is the two-descriptions-of-one-contact bug in another costume. See
   * `docs/biobuzz/feedback/000-solver-observations.md`.
   */
  for (const b of world.balls) if (b.state.kind === 'ground') stepGroundBall(b, dt);

  // CAPTURE. Nothing here moves a POLLEN — stage 4 is the one position authority, and this runs
  // first so a POLLEN at the roller is taken before the frame reaches it.
  for (const b of world.balls) {
    if (b.state.kind !== 'ground') continue;
    for (const rob of world.robots) {
      if (interact(world, b, rob, cmds.get(rob.id), enabled) === 'collected') break;
    }
  }

  // ── 4. SOLVE ──────────────────────────────────────────────────────────────
  /**
   * THE SHARED ARTIFACT SOLVE, AT THE POLLEN RADIUS, AND IT IS THE ONLY WRITER OF A GROUND
   * POLLEN'S POSITION. No integrator above it, no separation pass and no eviction after it: the
   * perimeter, every robot's chassis, its intake structure and the pollen it is holding are all
   * colliders in this one solve, so there is nothing left to take turns with. The only pass
   * after it is the perimeter invariant, which it does not hold on its own.
   *
   * It reads `world.balls` itself and only touches GROUND pollen, which is why it runs after
   * the capture pass rather than before it — a POLLEN taken this tick is already `held` and is
   * out of the solve by the time it runs.
   *
   * Driven the way `src/sim/world.ts` drives it: the robot solids are built ONCE from the held
   * pollen at `BB_POLLEN_R` (a full hopper is a physical plug in the mouth, and the plug has to
   * be the size of a POLLEN), the two DECODE-only exemption sets are empty (see this file's
   * header), and each chassis is swept from the pose `step.ts` captured before the drivetrain
   * ran to where the robot solve put it. With no `from` — a caller that steps `updateBiobuzz`
   * directly without the surrounding step — `solveArtifacts` falls back to the END pose per
   * robot, i.e. no sweep, and a chassis then spawns already overlapping whatever it drove into.
   */
  const heldBalls = world.balls.filter((b) => b.state.kind === 'held');
  const solids = new Map<number, RobotSolids>();
  for (const rob of world.robots) solids.set(rob.id, robotSolids(rob, heldBalls, BB_POLLEN_R));
  solveArtifacts(world, dt, biobuzzColliders, NO_IDS, NO_IDS, solids, from ?? NO_SWEEP, BB_POLLEN_R);
  // ...then the perimeter invariant, which the solve does not hold on its own — see
  // `clampPollenToWalls`, where the measured penetration without this is written down.
  for (const b of world.balls) if (b.state.kind === 'ground') clampPollenToWalls(b);

  // ── 5. LAUNCH ─────────────────────────────────────────────────────────────
  for (const rob of world.robots) {
    if (rob.passive) continue; // a practice dummy has no mechanisms to run
    bbLaunch(world, rob, cmds.get(rob.id) ?? ZERO_CMD, enabled);
  }

  // ── 6. SCORE + ENDGAME ────────────────────────────────────────────────────
  // A NO-OP, on purpose. `scoreTargets()` is empty and `scored: false`, so nothing can be
  // scored and no match of this game reaches a leaderboard. The pass exists — and writes the
  // zeroes explicitly — so that the shape Lane A fills in is already wired to the HUD, the
  // results rows and `worldHash`, and so a stale non-zero value from a snapshot of some
  // future version cannot survive into a shell world.
  for (const rob of world.robots) bb.endgame[rob.id] = 'none';
  for (const a of ['red', 'blue'] as Alliance[]) {
    bb.scored[a] = 0;
    bb.points[a] = 0;
    world.match.scores[a].total = world.match.scores[a].foulPoints;
  }
}

/**
 * THE AIM HOOK — the rotate override a turretless launcher gets while its fire button is held,
 * or `null` to leave the driver's rotate command alone.
 *
 * A drum or a dumper fires along one chassis EDGE, so "aim" means "turn the robot", and the
 * override has to replace the command before the drivetrain model runs (see `step.ts`, stage
 * 2). A turret aims itself and never gets an override — steering the chassis for a turret
 * would fight the driver for no benefit.
 *
 * SHELL: ALWAYS NULL, because `scoreTargets()` is empty. The path is written and wired anyway
 * — a P-controller on the heading error, dead-banded by `BB_AIM_TOL` so a robot already lined
 * up does not oscillate — because the alternative is that the first target Section 9 publishes
 * needs a new stage in the pipeline rather than a return value here.
 */
export function bbAimAssist(
  world: World,
  r: RobotState,
  cmd: RobotCommand,
  enabled: boolean,
): number | null {
  if (!enabled || !cmd.fire || !r.aimAssist) return null;
  const targets = scoreTargets(world, r.alliance);
  if (targets.length === 0) return null;
  // nearest target: with one goal this is trivially it, and with several it is the one a
  // driver holding fire means. Chosen by squared distance — no sqrt needed for a comparison.
  let best = targets[0];
  let bestD = Infinity;
  for (const t of targets) {
    const dx = t.pos.x - r.pos.x;
    const dy = t.pos.y - r.pos.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  const want = bbAimHeading(r, best);
  if (want === null) return null; // turreted: the turret does this
  const err = wrapAngle(want - r.heading);
  if (Math.abs(err) < BB_AIM_TOL) return 0; // lined up — hold still rather than hunt
  return clamp(err * BB_AIM_GAIN, -1, 1);
}

/** the two DECODE-only exemption sets `solveArtifacts` takes, empty for BIOBUZZ and shared
 * rather than re-allocated per tick. See this file's header for why each is empty. */
const NO_IDS: ReadonlySet<number> = new Set<number>();
/** no sweep origin: `solveArtifacts` falls back to each robot's END pose. */
const NO_SWEEP: ReadonlyMap<number, SweepFrom> = new Map<number, SweepFrom>();

/** a zero command, for a robot with no driver this tick (a dummy, a dropped peer). Frozen so
 * a mechanism that mutated it could not silently affect the next robot. */
const ZERO_CMD: RobotCommand = Object.freeze({
  driveX: 0,
  driveY: 0,
  rotate: 0,
  leftDrive: 0,
  rightDrive: 0,
  intake: false,
  fire: false,
});
