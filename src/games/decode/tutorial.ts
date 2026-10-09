import type { Alliance, RobotState, World } from '../../types';
import type { TutorialSpec, TutorialStep } from '../../tutorial/types';
import { control, driveHint, say } from '../../tutorial/hints';
import { baseZone, driverSide, footprintExtents, loadZone } from '../../sim/field';
import { decodeImportMouth } from '../../sim/importedMech';
import { BALL_RADIUS } from '../../config';
import { robotInLaunchZone } from '../../sim/robot';
import { wheelContacts } from '../../sim/physics';

/**
 * THE DECODE TUTORIAL — four steps: drive, intake, score, return. A robot with NO intake gets a
 * LOAD step (drive into the loading zone, the human player loads it) in the intake step's place.
 *
 * The short equivalent of BIOBUZZ's (`src/games/biobuzz/tutorial.ts`), and that file's header is
 * the one to read first: the rule that shapes every `stage` here is that a step's situation goes
 * into a world AT CONSTRUCTION, at tick 0, never into one that is already running, because solo
 * practice is recorded and a replay rebuilds from `{seed, setups, commands}` alone.
 *
 * ── WHY FOUR AND NOT SIX ──────────────────────────────────────────────────────
 * DECODE's driver loop is intake → launch → return, and the three things a new driver needs to
 * be told are that launching is only legal inside a LAUNCH ZONE, that the intake is a held
 * button, and that going home at the end is worth points. The gate, the classifier channel, the
 * motif and the pattern are all worth knowing and none of them is a first lesson — they are
 * things a driver meets in their second match, not in their first four minutes.
 *
 * ── THE FIELD MIRRORS IN X, IT IS NOT POINT-SYMMETRIC ─────────────────────────
 * The opposite of BIOBUZZ (whose poses are canonical-and-mirrored about the origin). DECODE's
 * halves are a REFLECTION in x, so a pose here is written with `driverSide(alliance)` as its x
 * sign and its y untouched — and `robotInLaunchZone` is the same test for both alliances,
 * because the big launch triangle spans the whole far half rather than belonging to a side.
 */

/** is any wheel contact patch inside `zone`? `inRect` is not exported from `field.ts`, and a
 *  plain rect test is not worth widening its surface for. */
function wheelsIn(r: RobotState, zone: { x0: number; x1: number; y0: number; y1: number }): number {
  return wheelContacts(r).filter((c) => c.x > zone.x0 && c.x < zone.x1 && c.y > zone.y0 && c.y < zone.y1)
    .length;
}

/** the robot this tutorial is about, or null in a world that has lost it. */
function me(world: World, robotId: number): RobotState | null {
  return world.robots.find((r) => r.id === robotId) ?? null;
}

/**
 * Seat the robot at `(driverSide · x, y)` facing `heading`.
 *
 * Velocity is zeroed — this runs at tick 0 on a world nothing has stepped, and a staged robot
 * that is already moving is a robot the player did not put in motion.
 */
function place(world: World, robotId: number, x: number, y: number, heading: number): void {
  const r = world.robots.find((q) => q.id === robotId);
  if (!r) return;
  const d = driverSide(r.alliance);
  r.pos = { x: d * x, y };
  // the heading mirrors with the field: a reflection in x maps a bearing to π − itself
  r.heading = d === 1 ? heading : Math.PI - heading;
  r.vel = { x: 0, y: 0 };
  r.angVel = 0;
}

/**
 * DROP one held ARTIFACT onto the tiles in front of the robot, so the hopper has a slot and the
 * intake step has something to drive at.
 *
 * `world.balls` keeps the element — dropping it is a STATE change, not a deletion, for the same
 * reason BIOBUZZ's staging says so: the ball array is what a conservation check counts, and a
 * tutorial that made an artifact disappear would be the only thing in the repo that does.
 */
function dropOneAhead(world: World, r: RobotState, ahead: number, lateral = 0): void {
  const ball = [...world.balls]
    .reverse()
    .find((b) => b.state.kind === 'held' && b.state.robot === r.id);
  if (!ball) return;
  ball.state = { kind: 'ground' };
  // straight out of the mouth, in the robot's own frame. `dcos`/`dsin` are not needed: the pose
  // this is called from faces +y in the blue frame, so the offset is along y and mirrors with it,
  // and the robot's LEFT (`lateral`, an import's mouth centre) is −x.
  ball.pos = { x: r.pos.x - lateral, y: r.pos.y + ahead };
  ball.z = 0;
  ball.vel = { x: 0, y: 0 };
  ball.vz = 0;
  const at = r.hopper.lastIndexOf(ball.color);
  if (at >= 0) r.hopper.splice(at, 1);
  else r.hopper.pop();
}

/**
 * PUT one held ARTIFACT on the floor in the middle of the robot's own LOADING ZONE — the hand-loading
 * step's twin of `dropOneAhead`: a robot with NO intake gets it back from its human player
 * (`handLoad`, `humanPlayer.ts`), who takes from the box or the zone's floor. A state change, not a
 * deletion, for `dropOneAhead`'s reason.
 */
function dropInLoadingZone(world: World, r: RobotState): void {
  const ball = [...world.balls]
    .reverse()
    .find((b) => b.state.kind === 'held' && b.state.robot === r.id);
  if (!ball) return;
  const z = loadZone(r.alliance as Alliance);
  ball.state = { kind: 'ground' };
  ball.pos = { x: (z.x0 + z.x1) / 2, y: (z.y0 + z.y1) / 2 };
  ball.z = 0;
  ball.vel = { x: 0, y: 0 };
  ball.vz = 0;
  const at = r.hopper.lastIndexOf(ball.color);
  if (at >= 0) r.hopper.splice(at, 1);
  else r.hopper.pop();
}

/** how many artifacts this robot's hopper holds when the field is staged (G304.G's preload). */
const PRELOAD = 3;

const steps: TutorialStep[] = [
  // ── 1. DRIVE ────────────────────────────────────────────────────────────────
  // Staged on the audience half, below both diagonals, so the robot is NOT in a launch zone —
  // which the spawn anchors all are (they sit in the goal corner by design, and a step staged
  // there would already be complete).
  {
    id: 'drive',
    title: 'Drive into your launch zone',
    hint: (c) => say`${driveHint(c)}. You can only shoot from inside a launch zone.`,
    stage: (w, id) => place(w, id, 34, -22, Math.PI / 2),
    done: (w, id) => {
      const r = me(w, id);
      return !!r && robotInLaunchZone(r);
    },
  },

  // ── 2. INTAKE ───────────────────────────────────────────────────────────────
  // One preload is put on the tiles a short drive ahead and its hopper slot freed, so the step is
  // "fill the hopper back up" — a full hopper is the state the driver has to recognise anyway,
  // because the intake stops taking at three.
  {
    id: 'intake',
    // a robot with NO intake is loaded by hand instead (the step below)
    applies: (spec) => spec.intake !== 'none',
    title: 'Pick up an artifact',
    hint: (c) =>
      say`Drive onto the artifact with ${control(c, 'intake', 'intake')} held. The hopper holds three.`,
    stage: (w, id) => {
      place(w, id, 34, -22, Math.PI / 2);
      const r = me(w, id);
      // 14 in clears every standard chassis; an IMPORT's front is its hull's, up to 18 in long and
      // off-centre, so it is dropped a radius and 2 in past that, in line with its mouth
      if (r) dropOneAhead(w, r, r.spec.imported ? footprintExtents(r.spec).front + BALL_RADIUS + 2 : 14, r.spec.imported ? decodeImportMouth(r.spec).yc : 0);
    },
    done: (w, id) => {
      const r = me(w, id);
      return !!r && r.hopper.length >= PRELOAD;
    },
  },

  // ── 2. LOAD (a robot with NO intake) ────────────────────────────────────────
  // The kit robot has no intake: the human player drops artifacts into it while any part of it is
  // in its LOADING ZONE (G432). One preload goes onto the zone's floor, and the robot is staged a
  // short drive out along the audience wall, facing the zone and clear of the spike marks and the
  // base, so the step is "drive in and wait for the human".
  {
    id: 'load',
    applies: (spec) => spec.intake === 'none',
    title: 'Get loaded by your human player',
    hint: () => say`Stop in the loading zone in your corner. Your human player loads you there. The hopper holds three.`,
    stage: (w, id) => {
      place(w, id, 34, -60, 0);
      const r = me(w, id);
      if (r) dropInLoadingZone(w, r);
    },
    done: (w, id) => {
      const r = me(w, id);
      return !!r && r.hopper.length >= PRELOAD;
    },
  },

  // ── 3. SCORE ────────────────────────────────────────────────────────────────
  // Inside the big launch triangle, facing the goal, with the preload intact. The turret tracks
  // on its own (Aim Assist is always on, `docs/area/ui.md`), so what is being taught is the RANGE
  // and the zone, not the aim.
  {
    id: 'score',
    title: 'Score in your goal',
    hint: (c) => say`Hold ${control(c, 'fire', 'fire')}. The turret aims for you.`,
    stage: (w, id) => place(w, id, 30, 12, Math.PI / 2),
    done: (w, id) => {
      const r = me(w, id);
      return !!r && w.goals[r.alliance].classifiedCount > 0;
    },
    nudgeS: 60,
  },

  // ── 4. RETURN ───────────────────────────────────────────────────────────────
  // BASE is an 18 × 18 square on the driver side (`baseZone`), and only the WHEEL contact patches
  // count — intake and turret overhang neither earn nor spoil the credit (`assessMatchEnd`). One
  // wheel in is the partial return; this step asks for that rather than for all four, because the
  // lesson is where BASE is.
  {
    id: 'return',
    title: 'Return to your base',
    hint: (c) =>
      // same as BIOBUZZ's park step: no on-screen PARK button, so the clause goes on touch.
      say`${driveHint(c)}. Get a wheel inside the base square. All four is worth more.${c.touch ? '' : say` ${control(c, 'park', 'park')} caps your speed.`}`,
    stage: (w, id) => place(w, id, 22, 6, -Math.PI / 2),
    done: (w, id) => {
      const r = me(w, id);
      return !!r && wheelsIn(r, baseZone(r.alliance as Alliance)) > 0;
    },
  },
];

export const DECODE_TUTORIAL: TutorialSpec = {
  game: 'decode',
  steps,
};
