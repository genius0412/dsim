import type { Artifact, RobotCommand } from '../../types';
import { BB_HALF_X, BB_HALF_Y, BB_POLLEN_R } from './config';
import {
  bbCmd,
  bbPile,
  bbPollen,
  bbRow,
  bbSetup,
  bbThrottle,
  bbWorld,
  type Scene,
} from './scenes';
import { BB_DEFAULT_SPEC } from './robotConfig';

/**
 * LANE A's SCENES — the field, the spawn layout, and the POLLEN PHYSICS SET.
 *
 * ── WHAT THIS FILE IS FOR ──────────────────────────────────────────────────
 * The one thing known for certain about BIOBUZZ before Kickoff is the ELEMENT: 3" balls that
 * roll, pile against walls and in corners, and get intaken several at a time. So pollen
 * behaviour is the one part of the game that can be TUNED before the rules exist — and it is
 * exactly the work Claude is worst at unsupervised, because "does that look like a ball" is not
 * a property you can assert. Phase 0.5 hands it to a human with a controller.
 *
 * These scenes are the vocabulary that conversation happens in. Each one isolates ONE thing
 * that can look wrong, so a feedback dump can say `corner-pile@120` and mean something exact
 * instead of "the balls feel weird".
 *
 * ── WHY EVERY LAYOUT IS REGULAR ────────────────────────────────────────────
 * Rows and hex-packed piles, never a random blob. With a random layout you cannot tell a
 * solver artefact from the arrangement you started with, so "did the robot scatter them or did
 * the separator?" becomes unanswerable — and that question is the entire point of the set. The
 * one deliberately random scene is `settle-60`, and it is random precisely because it is
 * checking the scatter itself.
 *
 * ── SIDE-BY-SIDE SOLVERS ───────────────────────────────────────────────────
 * `BB_BALL_SOLVER` (in `config.ts`) picks between CR's bespoke ground integrator and DECODE's
 * Rapier `solveBalls`. Every scene here runs under whichever is selected, so flipping the
 * switch and re-running `shots.cjs` produces the same cells under the other model and the
 * human compares two contact sheets. That is the P0.5 decision procedure, and it is why the
 * scenes are written against the module's public step rather than against either solver.
 */

/** POLLEN ids start at 1, never 0: `emptyBiobuzzState().nextBallId` starts there too, so a
 * scene laying out ids from 1 keeps a launched pollen from aliasing a floor one. */
const ID0 = 1;

/** how far a POLLEN's centre sits from a wall when it is resting against it. */
const AT_WALL_X = BB_HALF_X - BB_POLLEN_R;
const AT_WALL_Y = BB_HALF_Y - BB_POLLEN_R;

/** the impact speeds the three `pile-*` scenes differ by, in in/s: a nudge, a normal cross-field
 * run, and flat out. Named because a feedback dump refers to them by name. */
const PILE_SPEEDS = { slow: 20, med: 50, fast: 80 } as const;

/**
 * The three pile scenes share EVERYTHING but the speed, including their stills — which is the
 * point: the gallery puts `pile-slow@60`, `pile-med@60` and `pile-fast@60` in a row and the
 * difference between the three cells is the difference between the three speeds, and nothing
 * else. Different stills per speed would make them incomparable.
 */
function pileScene(name: keyof typeof PILE_SPEEDS): Scene {
  const speed = PILE_SPEEDS[name];
  return {
    id: `pile-${name}`,
    title: `Drive into a 12-pollen pile at ${speed} in/s`,
    lane: 'field',
    // The robot starts 34" out, facing −x. That is roughly 24" of clear run before its sweeper
    // reaches the pile, which is long enough for the drivetrain to actually REACH 80 in/s —
    // a `pile-fast` that impacts at 55 because it ran out of runway would be a picture of the
    // acceleration model rather than of the collision.
    build: (seed) => bbWorld(seed, [bbSetup(0, 'blue', { x: 34, y: 0, headingDeg: 180 })], bbPile(ID0, 12, 0, 0)),
    // INTAKE OFF, deliberately. This scene is about what a chassis does to a pile it plows
    // into; capturing them would empty the pile and there would be nothing left to look at.
    // `intake-line` (Lane B) is the scene that has the intake running.
    script: () => ({ 0: bbCmd({ driveY: bbThrottle(BB_DEFAULT_SPEC, speed) }) }),
    stills: [0, 30, 60, 120],
  };
}

export const BB_FIELD_SCENES: readonly Scene[] = [
  {
    id: 'field-empty',
    title: 'Empty field — mat, tiles, centre mark, perimeter',
    lane: 'field',
    // THE FIRST CELL IN THE GALLERY, and deliberately the most boring one. Every other picture
    // is drawn on top of this, so if the tile grid is the wrong pitch or the perimeter is
    // inside the play area, every later cell is wrong in a way that is hard to attribute. One
    // cell with nothing in it makes that a five-second check.
    build: (seed) => bbWorld(seed, [], []),
    stills: [0],
  },

  {
    id: 'field-labelled',
    title: 'Field with a 24" pollen ruler on both axes and all four start anchors filled',
    lane: 'field',
    /**
     * THE SCALE REFERENCE.
     *
     * There is nothing to LABEL yet — Sections 9 and 10 are Kickoff placeholders, so BIOBUZZ
     * has no zones, no goals and no scoring elements to name. What this cell is for instead is
     * checking that the drawn field and the sim's coordinates are the same field: POLLEN sit at
     * exact 24" multiples along both axes, so they must land on the drawn tile seams, and one
     * sits hard against each wall and in each corner, so the perimeter must touch them. If the
     * ruler drifts off the seams, the renderer's scale disagrees with the sim's inches.
     *
     * The four robots are here for the same reason: `BB_START_POSES` is canonical for BLUE and
     * RED is the x-mirror, and this is the cell that shows the mirror is a reflection (both
     * alliances face inward) rather than a translation (red facing out of the field).
     *
     * When Kickoff lands, the ACTUAL labelled field replaces this — through the module's
     * renderers, like everything else. There is no gallery-only drawing code, so the callouts
     * for a real zone will be a real overlay the game can draw.
     */
    build: (seed) => {
      const ruler: Artifact[] = [];
      let id = ID0;
      for (const v of [-48, -24, 24, 48]) {
        ruler.push(bbPollen(id++, v, 0)); // along x
        ruler.push(bbPollen(id++, 0, v)); // along y
      }
      // the walls and the corners: four mid-wall and four corner POLLEN, at rest
      for (const s of [1, -1]) {
        ruler.push(bbPollen(id++, s * AT_WALL_X, 0));
        ruler.push(bbPollen(id++, 0, s * AT_WALL_Y));
      }
      for (const sx of [1, -1]) for (const sy of [1, -1]) ruler.push(bbPollen(id++, sx * AT_WALL_X, sy * AT_WALL_Y));
      return bbWorld(
        seed,
        [bbSetup(0, 'blue', 0), bbSetup(1, 'blue', 1), bbSetup(2, 'red', 0), bbSetup(3, 'red', 1)],
        ruler,
      );
    },
    stills: [0],
  },

  {
    id: 'spawn-default',
    title: 'A 2v2 as the game actually spawns it — 60 scattered pollen, untouched',
    lane: 'field',
    // THE ONLY SCENE THAT TOUCHES NOTHING. No hand-placed layout, no script: this is exactly
    // what `createBiobuzzWorld` produces for a real match, which makes it the cell that catches
    // a spawn regression the crafted scenes would hide (a robot spawned inside a pollen, an
    // anchor moved, the scatter count changed).
    build: (seed) =>
      bbWorld(seed, [bbSetup(0, 'blue', 0), bbSetup(1, 'blue', 1), bbSetup(2, 'red', 0), bbSetup(3, 'red', 1)]),
    stills: [0],
  },

  pileScene('slow'),
  pileScene('med'),
  pileScene('fast'),

  {
    id: 'wall-row-sweep',
    title: 'Sweep a 14-pollen row along the top wall',
    lane: 'field',
    /**
     * A row of POLLEN resting against a wall, swept along it lengthwise.
     *
     * THE WALL IS THE HARD CASE. A ball against a wall has nowhere to go along the wall normal,
     * so the separator and the wall clamp fight each other over it — the failure mode is a
     * pollen squeezed THROUGH the wall (containment) or one that never stops vibrating
     * (jitter). Sweeping along the row rather than into it keeps every ball in that pinned
     * state for the whole scene instead of for one tick.
     */
    build: (seed) =>
      bbWorld(
        seed,
        // 8" clear of the wall so the chassis' own +y edge just reaches the row: the sweeper
        // catches them side-on, which is what a real robot cleaning a wall does.
        [bbSetup(0, 'blue', { x: -52, y: BB_HALF_Y - 10, headingDeg: 0 })],
        bbRow(ID0, 14, -40, AT_WALL_Y, 40, AT_WALL_Y),
      ),
    script: () => ({ 0: bbCmd({ driveY: 1 }) }),
    stills: [0, 60, 150, 300],
  },

  {
    id: 'corner-pile',
    title: 'Push 16 pollen into a corner and keep pushing',
    lane: 'field',
    /**
     * THE WORST CASE FOR ANY SEPARATION PASS: two walls at right angles, a robot on the
     * diagonal, and nowhere for a ball to be pushed to.
     *
     * With too little separation the pile compresses into a single overlapping blob; with too
     * much it explodes back past the robot. Both look obviously wrong in one still, which is
     * why this is a scene and not a tolerance in a test.
     */
    build: (seed) =>
      bbWorld(
        seed,
        [bbSetup(0, 'blue', { x: 36, y: 36, headingDeg: 45 })],
        bbPile(ID0, 16, BB_HALF_X - 12, BB_HALF_Y - 12),
      ),
    script: () => ({ 0: bbCmd({ driveY: bbThrottle(BB_DEFAULT_SPEC, 40) }) }),
    stills: [0, 60, 120, 240],
  },

  {
    id: 'pin-wall',
    title: 'Pin one pollen against the wall and hold the throttle down',
    lane: 'field',
    /**
     * ONE POLLEN, ONE WALL, FULL THROTTLE, FOREVER.
     *
     * The narrowest scene in the set and the one that decides the P0.5 solver choice. A ball
     * with a wall behind it and a robot in front of it cannot resolve, so the model has to pick
     * a lie:
     *  • CR's bespoke integrator lets the robot drive on THROUGH it (the ball does not push
     *    back), so the pollen ends up inside the chassis footprint or squirts out sideways.
     *  • DECODE's Rapier path feeds the contact back (`ballRobotFeedback`) and STALLS the
     *    robot on it, which is what actually happens on a real field and also what makes a
     *    driver think their robot is broken.
     * Neither is free. This cell is where a human decides which one BIOBUZZ tells.
     */
    build: (seed) =>
      bbWorld(seed, [bbSetup(0, 'blue', { x: 52, y: 0, headingDeg: 0 })], [bbPollen(ID0, AT_WALL_X, 0)]),
    script: () => ({ 0: bbCmd({ driveY: 1 }) }),
    stills: [0, 45, 120, 300],
  },

  {
    id: 'squeeze-2robots',
    title: 'Two robots close on a single pollen from opposite sides',
    lane: 'field',
    /**
     * THE OTHER UNRESOLVABLE CASE, and the one that cannot be papered over with a wall clamp:
     * a POLLEN between two chassis that are both still driving.
     *
     * A wall is a static collider, so containment can always win by fiat. Two robots are not —
     * whatever the pollen does here is what the model genuinely believes about a ball with no
     * escape, and the honest outcomes are "it pops out to one side" or "both robots stall".
     * Silently DELETING it (which is what an unclamped penetration test eventually does) is the
     * one outcome that must never ship, and this scene is how that gets noticed: smoke asserts
     * count conservation on the same run that draws this picture.
     */
    build: (seed) =>
      bbWorld(
        seed,
        [
          bbSetup(0, 'blue', { x: -22, y: 0, headingDeg: 0 }),
          bbSetup(1, 'red', { x: 22, y: 0, headingDeg: 180 }),
        ],
        [bbPollen(ID0, 0, 0)],
      ),
    script: () => {
      const c: RobotCommand = bbCmd({ driveY: bbThrottle(BB_DEFAULT_SPEC, 35) });
      return { 0: c, 1: c };
    },
    stills: [0, 45, 90, 180],
  },

  {
    id: 'settle-60',
    title: 'The full 60-pollen scatter left completely alone for five seconds',
    lane: 'field',
    /**
     * A NULL TEST, and the most valuable cell in the set for exactly that reason.
     *
     * `scatterPollen` rejection-samples the initial layout, so nothing overlaps at tick 0 and
     * every POLLEN is already at rest. The correct outcome is therefore that NOTHING HAPPENS:
     * `settle-60@0` and `settle-60@300` must be the same picture, pixel for pixel.
     *
     * If they differ, the integrator is generating motion from a resting state — a separation
     * pass with a bias, an epsilon that pushes a touching pair apart, a wall clamp that
     * overshoots. That class of bug is invisible in every other scene, because in all of them
     * something is genuinely moving and a bit of extra drift looks like physics.
     *
     * NO ROBOTS, so there is nothing but the pollen model in the frame.
     */
    build: (seed) => bbWorld(seed, []),
    script: () => ({}),
    stills: [0, 30, 120, 300],
  },
];
