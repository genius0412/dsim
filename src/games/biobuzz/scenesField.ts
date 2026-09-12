import type { RobotCommand } from '../../types';
import { BB_FRAME_X, BB_HALF_X, BB_HALF_Y, BB_POLLEN_R } from './config';
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
 * ── ONE SOLVER, AND THESE SCENES ARE THE EVIDENCE ABOUT IT ─────────────────
 * There was a `BB_BALL_SOLVER` switch these scenes were meant to be shot under twice, once per
 * ball model, for a human to compare. That is settled: ground POLLEN ride the SHARED artifact
 * solve at `BB_POLLEN_R` and BIOBUZZ owns no ball physics at all (see `play.ts`'s header).
 * What the scenes are for now is EVIDENCE about what that solve does with a 1.5" element —
 * `docs/biobuzz/feedback/000-solver-observations.md` is written from them, cell by cell — which
 * is also why they are written against the module's public step rather than against a solver.
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
    title: 'The manual field — zones, hive structure, flowers, tags and callouts',
    lane: 'field',
    /**
     * THE FIELD, AS THE MANUAL DRAWS IT. The cell a human checks the geometry on.
     *
     * Section 9 landed, so this cell stopped being a scale reference and became the field. It
     * is deliberately EMPTY of robots and of floor POLLEN: everything visible is drawn from a
     * constant in `config.ts`, so anything that looks wrong here is a wrong number rather than
     * a scene that placed something oddly. The old 24" pollen ruler is gone because the drawing
     * now carries its own — the tile letters run along the walls and the four FLOWERS sit on
     * the ±24 seams, so a renderer whose scale disagrees with the sim's inches shows it in the
     * geometry itself instead of in a row of balls laid over it.
     *
     * WHAT TO LOOK AT, in the order the layout is easy to get wrong:
     *   1. RED LZ on the LEFT wall at y > 0, and RED GARDEN in the audience-LEFT corner. The
     *      layout is point-symmetric, not mirrored (`bbMirror`), and an x-mirror of it is
     *      internally consistent and wrong — this cell is the only thing that catches it.
     *   2. The four FLOWERS on the ±24 tile seams, one per wall, point-symmetric.
     *   3. The HIVE pair centred, red at −x, blue at +x, and the STAGED tilt: red's SOUTH cell
     *      up, blue's NORTH cell up (§10.3.1, Fig 10-2). The down cell is drawn foreshortened.
     *   4. The AprilTag id groups against Figs 9-15…9-17. A published tag id is the one thing
     *      here that pins the drawing to the real field.
     */
    build: (seed) => {
      const world = bbWorld(seed, [], []);
      const bb = world.biobuzz;
      if (bb) {
        bb.labels = true;
        // STAGING, AS DRAWING INPUT ONLY. `emptyBiobuzzState` gives the staged TILT; these are
        // the staged CONTENTS (§10.3.1: 3 NECTAR in each up-CELL, 4 POLLEN in each FLOWER), and
        // they are bare ids with no matching `world.balls` entry because nothing places real
        // elements yet — `spawn.ts` does that in a later pass and these lines come out then.
        // They exist so the cell shows the content count and the stack badge rendering at all.
        bb.hives.red.contents = [901, 902, 903];
        bb.hives.blue.contents = [911, 912, 913];
        bb.flowers.forEach((f, i) => {
          f.stack = [921 + i * 4, 922 + i * 4, 923 + i * 4, 924 + i * 4];
        });
      }
      return world;
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

  // ── THE V1 FIELD ──────────────────────────────────────────────────────────

  {
    id: 'staging',
    title: 'The staged field: 40 POLLEN and 16 NECTAR in their Fig 10-2 places',
    lane: 'field',
    /**
     * THE CELL THE WHOLE FIELD LANE IS CHECKED AGAINST — the real spawn, four robots, nothing
     * swapped out. `bbWorld` is given no POLLEN argument, so `stageBiobuzz` runs untouched and
     * this is literally what a match begins as.
     *
     * What to look at, in the order the manual describes it (§10.3.1, Fig 10-2):
     *  • the two GARDEN rows, four POLLEN each, against the audience wall from the red corner
     *    and against the rear wall from the blue corner — DIAGONALLY opposite, not reflected.
     *  • the four robots, each backed against its own alliance's side wall and clear of its
     *    own LOADING ZONE, red's pair the 180 degree rotation of blue's.
     *  • what is NOT drawn: the 16 POLLEN in the FLOWER stacks, the 6 NECTAR in the up-CELLs
     *    and the 10 in the human players' hands are all in `world.balls` and all in states the
     *    ball renderer skips, so an element drawn loose ON a flower or a hive is a bug in
     *    `draw.ts`, and 40 loose yellow circles here would mean the stacks never formed.
     */
    build: (seed) =>
      bbWorld(seed, [
        bbSetup(0, 'blue', 0),
        bbSetup(1, 'blue', 1),
        bbSetup(2, 'red', 0),
        bbSetup(3, 'red', 1),
      ]),
    script: () => ({}),
    stills: [0],
  },

  {
    id: 'under-hive',
    title: 'A robot parked between the HIVE frame bars, where G409 says it may drive',
    lane: 'field',
    /**
     * THE SPACE UNDER THE HIVES IS DRIVABLE AND MUST STAY THAT WAY.
     *
     * The frame's base bars are the only part of the HIVE Structure on the tiles; everything
     * else is 25.5 in up (Fig 9-10) and G409 assumes robots pass underneath. So a robot at the
     * origin is BETWEEN the two bars, touching neither, and must sit there perfectly still
     * under a null command.
     *
     * The failure this catches is a frame collider drawn too wide or placed at the wrong x:
     * the robot would begin the scene intersecting a bar and be shoved sideways, and the still
     * at tick 120 would not match the one at tick 0. It is the `settle-60` argument applied to
     * the new geometry — a null test is the only kind that can prove an absence.
     */
    build: (seed) => bbWorld(seed, [bbSetup(0, 'blue', { x: 0, y: 0, headingDeg: 180 })], []),
    script: () => ({}),
    stills: [0, 120],
  },

  {
    id: 'frame-push',
    title: 'Driving a robot into a HIVE frame base bar for one second',
    lane: 'field',
    /**
     * THE BAR IS SOLID, and this is the cell that says so.
     *
     * The robot starts a little inside the +x bar and drives straight at it for 60 ticks. The
     * bar is 1.5 in of extrusion — thin enough that a fast body could tunnel through it in one
     * 1/60 s step if the solve ever stopped sweeping — so what the last still has to show is a
     * robot STOPPED against the bar, on the near side of it, and not a robot standing in the
     * middle of the HIVE Structure.
     *
     * Deliberately the modest 35 in/s of the other contact scenes rather than a full-throttle
     * run: at this speed a correct solve stops the robot dead, so any penetration in the
     * picture is geometry or sweeping, not a legitimately hard hit.
     */
    build: (seed) =>
      bbWorld(
        seed,
        [bbSetup(0, 'blue', { x: BB_FRAME_X - 18, y: 0, headingDeg: 0 })],
        [],
      ),
    script: () => ({ 0: bbCmd({ driveY: bbThrottle(BB_DEFAULT_SPEC, 35) }) }),
    stills: [0, 30, 60],
  },
];
