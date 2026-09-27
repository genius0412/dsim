import type { RobotCommand, World } from '../../types';
import * as C from '../../config';
import { solveRobots, type SweepFrom } from '../../sim/physicsEngine';
import { squareUpRobotsWalls } from '../../sim/physics';
import { updateRobot, type DriveWrench } from '../../sim/robot';
import { clockExpired, robotsEnabled } from '../../sim/match';
import { BB_FLOWER_UNLOCK_S, BB_HALF_X, BB_HALF_Y } from './config';
import { biobuzzColliders } from './colliders';
import { bbAimAssist, updateBiobuzz } from './play';
import { updateBiobuzzPenalties } from './penalties';
import { BB_WALL, bbApplyScore, bbLeftNow, bbParkedNow, bbScoreWorld, bbWallsTouched } from './score';
import { biobuzzPhysics } from './state';
import { step3d } from './sim3d/step3d';

/**
 * BIOBUZZ step — a playable, unscored match.
 *
 * ── THE PIPELINE ORDER, WHICH IS THE CONTRACT ──────────────────────────────
 * Lane A owns this order. Lane B adds nothing to this file: a mechanism hooks in through the
 * elements API (`bbLaunch`, called from `updateBiobuzz`), never by inserting a stage here.
 * The numbered stages, and why each sits where it does:
 *
 *   0. SWEEP ORIGIN       — every robot's pose BEFORE anything moves it, handed to the
 *                           gameplay stage. The Rapier pollen solver sweeps each chassis from
 *                           there to where (5) left it, so it has to be captured before (3)
 *                           and (5) — `src/sim/world.ts` captures `sweepFrom` at exactly the
 *                           same point, for exactly the same reason.
 *   1. RESOLVE COMMANDS   — a disabled robot (pre-match, transition, post) gets ZERO_CMD
 *                           rather than its driver's stick, so a held button cannot act
 *                           across a phase boundary.
 *   2. AIM HOOK           — a turretless launcher's fire button STEERS THE CHASSIS, so the
 *                           rotate override has to replace the command BEFORE the drivetrain
 *                           model sees it. Applied after (1) so a disabled robot cannot aim.
 *   3. DRIVETRAIN         — `updateRobot`, the shared motor/traction model, returning the
 *                           drive as a WRENCH per robot for the solver to apply.
 *   4. CLEAR rrContacts   — DELIBERATELY AFTER (3), NOT at the top of the tick. `updateRobot`
 *                           reads LAST tick's contacts to tell a robot being LEANED ON from
 *                           one that is stopping itself; clearing first would delete exactly
 *                           the information it needs.
 *   5. RAPIER SOLVE       — `solveRobots` owns robot translation, velocity and the hard wall
 *                           containment invariant, on BIOBUZZ's own colliders.
 *   6. WALL SQUARE-UP     — the contact-torque pass that squares a tilted chassis flush
 *                           against a wall. After the solve, because it corrects the solve's
 *                           result using the pre-solve velocities the solve returned.
 *   7. PENALTIES          — BEFORE gameplay, so a foul awarded this tick folds into the
 *                           alliance total that (8) writes. It reads last tick's game state:
 *                           one deterministic tick of lag, and invisible.
 *                           AFTER (5) and (6) rather than before them, which G421 PINNING
 *                           makes load-bearing: the pin clock measures how far the victim
 *                           ACTUALLY got this tick, so it has to read the post-solve pose. It
 *                           takes `dt` and the APPLIED commands for the same rule — a pin is
 *                           billed in seconds, and "is the pinner driving into its victim?"
 *                           has to be the question the drivetrain answered in (3).
 *   8. GAMEPLAY           — `updateBiobuzz`: pollen physics, intake, launch. (See its own
 *                           header for the order INSIDE it.)
 *   9. PHASE MACHINE      — the countdown and phase progression. It also fires the two
 *                           ASSESSMENT INSTANTS (Table 10-2): LEAVE and AUTO PARK latch as
 *                           AUTO ends, TELEOP PARK as the MATCH ends. They live here because
 *                           an instant is a phase boundary and nowhere else in the pipeline
 *                           knows one is happening.
 *  10. SCORE             — `bbScoreWorld` + `bbApplyScore`, recomputed from scratch every
 *                           tick (Chain Reaction's pattern, and `score.ts` argues it). LAST,
 *                           so it sees this tick's gameplay, this tick's fouls AND this tick's
 *                           latches — a TIP that completes on the buzzer tick still scores.
 *
 * DELIBERATELY ABSENT, and each for a reason rather than an oversight: DECODE's
 * `updateRobotActions`, goals and gates (BIOBUZZ has no known field mechanism), and Chain
 * Reaction's beam terrain and centre-of-gravity scaling (a BIOBUZZ robot has no
 * `groundClearance` dial, because there is no published terrain for one to matter on — see
 * `robotConfig.ts`, which strips the field).
 *
 * DETERMINISM: this reads only the commands and `world.rngState`. No clock, no DOM, no
 * `Math.random`. That is what lets client prediction, server authority and replay agree.
 */

/** a zero command for a disabled or driverless robot. A module-level constant rather than a
 * fresh object per robot per tick, and never mutated. */
const ZERO_CMD: RobotCommand = {
  driveX: 0,
  driveY: 0,
  rotate: 0,
  leftDrive: 0,
  rightDrive: 0,
  intake: false,
  fire: false,
};

/**
 * THE 2D PIPELINE — everything above this function's header describes it, and it is
 * UNTOUCHED (Day 1 seam, `docs/biobuzz/plan-3d.md`). `biobuzzStep` below is now the exported
 * entry point every caller uses; it dispatches here for a `'2d'`-physics world (absent physics
 * included, which is every world before this seam existed) and to `sim3d/step3d.ts`'s `step3d`
 * for a `'3d'` one.
 */
function step2d(world: World, dt: number, commands: Map<number, RobotCommand>): void {
  world.time += dt;
  world.tick++;

  const enabled = robotsEnabled(world);
  // the commands as ACTUALLY APPLIED (post aim-override). Gameplay reads these, not the raw
  // input, so the intake/fire state the mechanisms see is the state the drivetrain saw.
  const actual = new Map<number, RobotCommand>();
  const drive = new Map<number, DriveWrench>();
  // 0. WHERE EACH ROBOT'S MOTION BEGAN THIS TICK. Captured before the drivetrain and the
  // solve, because by the time gameplay runs `r.pos` is where the robot ENDED — and the
  // Rapier pollen arm needs both poses to sweep the chassis between them instead of
  // spawning it already overlapping whatever it drove into.
  const from = new Map<number, SweepFrom>();
  for (const r of world.robots) from.set(r.id, { x: r.pos.x, y: r.pos.y, heading: r.heading });
  for (const r of world.robots) {
    let cmd = enabled ? (commands.get(r.id) ?? ZERO_CMD) : ZERO_CMD;
    // 2. AIM HOOK — holding fire on a DUMPER turns the whole robot onto the cell Aim Assist is on
    // (`bbAimAssist`), and `bbLaunch` dumps once it is lined up and the dump would land — the
    // same feel as Chain Reaction's dumper. Null when this build aims some other way (a turret
    // slews itself).
    //
    // ⚠️ A TANK TURNS ONLY FROM ITS SIDE DRIVES. The shared drive model takes a tank's yaw from
    // `rightDrive − leftDrive` and ignores `rotate` (`src/sim/robot.ts`), so overriding `rotate`
    // alone left a tank dumper — the StarterBot — facing wherever the driver left it. The turn is
    // written into both: `rotate` for every other drivetrain (`omega = rotate · maxTurn`), and the
    // side drives as the driver's own forward (their mean) ∓ the turn (`omega = (rd − ld) ·
    // maxTurn / 2`, the same rate), with the forward trimmed so the turn always gets its share.
    const aim = bbAimAssist(world, r, cmd, enabled);
    if (aim !== null) {
      const fwd = ((cmd.leftDrive ?? 0) + (cmd.rightDrive ?? 0)) / 2;
      const room = 1 - Math.abs(aim);
      const f = Math.max(-room, Math.min(room, fwd));
      cmd = { ...cmd, rotate: aim, leftDrive: f - aim, rightDrive: f + aim };
    }
    actual.set(r.id, cmd);
    // 3. DRIVETRAIN
    drive.set(r.id, updateRobot(world, r, cmd, dt));
  }

  // 4. see the note above — this is not a misplaced reset.
  world.rrContacts.length = 0;
  // 5. Rapier owns robot translation/velocity + wall containment on the BIOBUZZ field.
  const preVels = solveRobots(world, dt, biobuzzColliders, undefined, drive);
  // 6. square a tilted chassis flush against the walls (and other robots).
  squareUpRobotsWalls(world, preVels, BB_HALF_X, BB_HALF_Y);

  // 7. penalties, then 8. gameplay — both guarded on the state bag, because a snapshot from
  // a build that predates this game arrives without it.
  if (world.biobuzz) updateBiobuzzPenalties(world, dt, actual);
  if (world.biobuzz) updateBiobuzz(world, dt, actual, enabled, from);

  // 9.
  biobuzzStepMatch(world, dt);

  // 10. THE SCORE, from scratch, every tick. See `score.ts` for why it is recomputed rather
  // than accumulated, and why it runs after the phase machine rather than before it.
  if (world.biobuzz) bbApplyScore(world, bbScoreWorld(world));
}

/**
 * THE BIOBUZZ TICK — the dispatch seam (Day 1, `docs/biobuzz/plan-3d.md`). Every existing
 * caller (the client, the server, the smoke suite) imports THIS name unchanged; it reads the
 * world's own physics tag once and hands the tick to the pipeline that actually understands
 * it. A `'2d'` world (including every world from before this seam existed, which carries no
 * tag at all) is byte-identical to what `biobuzzStep` always did.
 */
export function biobuzzStep(world: World, dt: number, commands: Map<number, RobotCommand>): void {
  if (biobuzzPhysics(world) === '3d') {
    step3d(world, dt, commands);
  } else {
    step2d(world, dt, commands);
  }
}

/**
 * LATCH one assessment instant (Table 10-2) — which achievements are true RIGHT NOW, frozen.
 *
 * LEAVE and PARK are the only lines in the table assessed at a MOMENT rather than continuously
 * ("end of AUTO", "end of MATCH"), and a robot that drives back to the wall afterwards keeps
 * its points. So the truth of each predicate is recorded here and `score.ts` reads the record
 * from then on. The predicates themselves are `score.ts`'s, called rather than re-spelled: the
 * provisional value a driver watches during AUTO and the value that ends up on the results
 * screen have to be the same test, or the score changes at the buzzer for no visible reason.
 *
 * `passive` robots — free-drive practice dummies — are skipped. They have no alliance in any
 * meaningful sense and latching them would put 3 points on whichever colour they were spawned
 * as.
 */
function bbAssess(world: World, at: 'auto' | 'match'): void {
  const bb = world.biobuzz;
  if (!bb) return;
  for (const r of world.robots) {
    if (r.passive) continue;
    if (at === 'auto') {
      bb.leave[r.id] = bbLeftNow(r, bb.startWalls[r.id] ?? BB_WALL.all);
      bb.parkAuto[r.id] = bbParkedNow(r);
    } else {
      bb.parkTele[r.id] = bbParkedNow(r);
    }
  }
}

/**
 * The BIOBUZZ phase/timer machine — auto, transition, teleop, post, using the SHARED phase
 * durations.
 *
 * Shared rather than per-game because the numbers are the same: V1 §10.1/§10.4 give a 30-second
 * AUTO, an 8-second transition and a 2-minute TELEOP, which is exactly the shared
 * `AUTO_DURATION` / `TRANSITION_DURATION` / `TELEOP_DURATION` DECODE already runs. A later
 * manual revision that moved them for BIOBUZZ alone would need a per-game slot, not an edit here.
 *
 * BIOBUZZ adds two things to the shared shape, and both are cues in the manual's own sense:
 *
 *  • **THE 1:00 NECTAR CUE** (§10.4, Table 9-1 p79, G410). FLOWER ownership unlocks with 60 s
 *    of TELEOP left: before it, a NECTAR entering a FLOWER is a MAJOR per nectar. It is
 *    announced on the field by an audio cue, so the sim announces it as an EVENT — the same
 *    channel the phase changes use, which is what puts it in the toast row and in a replay.
 *  • **THE TWO ASSESSMENT INSTANTS** — LEAVE and AUTO PARK at the end of AUTO, TELEOP PARK at
 *    the end of the MATCH (`bbAssess`).
 *
 * The cue is detected as a CROSSING of the countdown rather than from a stored flag: the
 * threshold is above `phaseTimeLeft` before the decrement and at or below it after, which is
 * true on exactly one tick and needs nothing remembered. A flag would be a third thing that
 * can disagree with the clock, and the clock is already authoritative for the rule itself
 * (`bbNectarLocked` reads `phaseTimeLeft`, not the flag).
 */
export function biobuzzStepMatch(world: World, dt: number): void {
  const m = world.match;
  if (m.phase === 'pre') {
    // WHICH WALLS EACH ROBOT IS STARTING AGAINST, re-read every tick until the match begins.
    // LEAVE is measured against these (`bbLeftNow`), start poses are free-placed in this game,
    // and a pose can still change while the field is frozen — so the last `pre` tick is the
    // one that counts. `spawn.ts` seeds the same masks, for a world that is started with no
    // `pre` tick at all (`startMatch` straight off `createWorld`, which is the headless path).
    if (world.biobuzz) {
      for (const r of world.robots) world.biobuzz.startWalls[r.id] = bbWallsTouched(r);
    }
    if (m.preCountdown == null) return; // solo: the controller starts the match
    m.preCountdown -= dt;
    if (clockExpired(m.preCountdown)) {
      m.preCountdown = undefined;
      m.phase = 'auto';
      m.phaseTimeLeft = C.AUTO_DURATION;
      world.events.push('AUTO');
    }
    return;
  }
  if (m.phase === 'freeplay' || m.phase === 'post') return;
  const before = m.phaseTimeLeft;
  m.phaseTimeLeft -= dt;
  // the 1:00 cue: the one tick the countdown crosses the unlock threshold. `before >` and
  // `after <=` bracket it, so it fires exactly once and never on a tick that merely sits at
  // the boundary.
  if (m.phase === 'teleop' && before > BB_FLOWER_UNLOCK_S && m.phaseTimeLeft <= BB_FLOWER_UNLOCK_S) {
    world.events.push('FLOWER OWNERSHIP UNLOCKED');
  }
  if (!clockExpired(m.phaseTimeLeft)) return; // see `clockExpired`: exact phase lengths
  switch (m.phase) {
    case 'auto':
      for (const r of world.robots) r.autoPathActive = false;
      // LEAVE and AUTO PARK, assessed at this instant and latched (Table 10-2). Before the
      // phase flips, so the predicates see the field as it was when the buzzer went.
      bbAssess(world, 'auto');
      m.phase = 'transition';
      m.phaseTimeLeft = C.TRANSITION_DURATION;
      world.events.push('AUTO COMPLETE');
      break;
    case 'transition':
      m.phase = 'teleop';
      m.phaseTimeLeft = C.TELEOP_DURATION;
      // DRIVER-CONTROLLED, not TELEOP. `world.events` is one of the three surfaces the
      // terminology ruling names (with the live HUD and the burned-in video overlay), and
      // `src/sim/match.ts:64` already says it for the other games. A season pushing its own
      // word here puts two names for one phase into the same event log.
      world.events.push('DRIVER-CONTROLLED');
      break;
    case 'teleop':
      // TELEOP PARK, the second of the two assessments. Same instant rule as AUTO's.
      bbAssess(world, 'match');
      m.phase = 'post';
      m.phaseTimeLeft = 0;
      world.events.push('MATCH COMPLETE');
      break;
  }
}
