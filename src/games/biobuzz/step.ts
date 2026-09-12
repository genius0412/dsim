import type { RobotCommand, World } from '../../types';
import * as C from '../../config';
import { solveRobots, type SweepFrom } from '../../sim/physicsEngine';
import { squareUpRobotsWalls } from '../../sim/physics';
import { updateRobot, type DriveWrench } from '../../sim/robot';
import { robotsEnabled } from '../../sim/match';
import { BB_HALF_X, BB_HALF_Y } from './config';
import { biobuzzColliders } from './colliders';
import { bbAimAssist, updateBiobuzz } from './play';
import { updateBiobuzzPenalties } from './penalties';

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
 *   8. GAMEPLAY           — `updateBiobuzz`: pollen physics, intake, launch. (See its own
 *                           header for the order INSIDE it.)
 *   9. PHASE MACHINE      — the countdown and phase progression, last, so every stage above
 *                           ran under one consistent phase.
 *
 * DELIBERATELY ABSENT, and each for a reason rather than an oversight: DECODE's
 * `updateRobotActions`, goals and gates (BIOBUZZ has no known field mechanism); DECODE's
 * scoring (`scored: false`); and Chain Reaction's beam terrain and centre-of-gravity scaling
 * (a BIOBUZZ robot has no `groundClearance` dial, because there is no published terrain for
 * one to matter on — see `robotConfig.ts`, which strips the field).
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

export function biobuzzStep(world: World, dt: number, commands: Map<number, RobotCommand>): void {
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
    // 2. AIM HOOK — turretless launchers turn the whole robot to face their target while the
    // fire button is held. Null when this build aims some other way (a turret slews itself)
    // or when there is nothing to aim at, which in the shell is always: `scoreTargets()` is
    // empty until Section 9 exists.
    const aim = bbAimAssist(world, r, cmd, enabled);
    if (aim !== null) cmd = { ...cmd, rotate: aim };
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
  if (world.biobuzz) updateBiobuzzPenalties(world);
  if (world.biobuzz) updateBiobuzz(world, dt, actual, enabled, from);

  // 9.
  biobuzzStepMatch(world, dt);
}

/**
 * The BIOBUZZ phase/timer machine — auto, transition, teleop, post, using the SHARED phase
 * durations.
 *
 * Shared rather than per-game on purpose: match lengths are set by the Tournament section
 * (Section 13), which IS published in the V0 manual and is unchanged from DECODE. If Kickoff
 * moves them, they move for every game at once, which is what a shared constant is for.
 *
 * Scoring is continuous in `updateBiobuzz`, so this only advances the countdown and the phase
 * progression — there is no per-phase assessment to run.
 */
function biobuzzStepMatch(world: World, dt: number): void {
  const m = world.match;
  if (m.phase === 'pre') {
    if (m.preCountdown == null) return; // solo: the controller starts the match
    m.preCountdown -= dt;
    if (m.preCountdown <= 0) {
      m.preCountdown = undefined;
      m.phase = 'auto';
      m.phaseTimeLeft = C.AUTO_DURATION;
      world.events.push('AUTO');
    }
    return;
  }
  if (m.phase === 'freeplay' || m.phase === 'post') return;
  m.phaseTimeLeft -= dt;
  if (m.phaseTimeLeft > 0) return;
  switch (m.phase) {
    case 'auto':
      for (const r of world.robots) r.autoPathActive = false;
      m.phase = 'transition';
      m.phaseTimeLeft = C.TRANSITION_DURATION;
      world.events.push('AUTO COMPLETE');
      break;
    case 'transition':
      m.phase = 'teleop';
      m.phaseTimeLeft = C.TELEOP_DURATION;
      world.events.push('TELEOP');
      break;
    case 'teleop':
      m.phase = 'post';
      m.phaseTimeLeft = 0;
      world.events.push('MATCH COMPLETE');
      break;
  }
}
