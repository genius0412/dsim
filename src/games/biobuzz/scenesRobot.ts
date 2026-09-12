import type { RobotSpec, World } from '../../types';
import { BB_HALF_X } from './config';
import { capturePollen } from './elements';
import {
  BB_MOUNT_POSITIONS,
  BB_SCORE_MODES,
  BB_SHOOTER_EDGES,
  type BbMountPos,
  type BbScoreMode,
  isTurreted,
} from './mounts';
import { bbHopperCap } from './robot';
import { bbCmd, bbPollen, bbRow, bbSetup, bbThrottle, bbWorld, type Scene } from './scenes';
import { BB_DEFAULT_SPEC } from './robotConfig';

/**
 * LANE B's SCENES — the ROBOT: what the mechanisms do, and what every build LOOKS LIKE.
 *
 * Two kinds of scene live here, and they answer two different questions.
 *
 * ── MECHANISM SCENES: does the hardware do what it draws? ──────────────────
 * `intake-line` and `launch-wall-bounce`. One drives a running sweeper through a line of
 * POLLEN; the other empties a full hopper at a wall. Between them they cover the two things a
 * BIOBUZZ robot can do to a pollen, and both are aimed at the SAME class of bug: the renderer
 * and the sim deriving the same geometry twice and disagreeing. If the sweeper collects a
 * pollen that never touched the drawn rollers, or a launch leaves from somewhere the turret is
 * not, these cells show it and nothing else does.
 *
 * ── ARCHETYPE SHEETS: does every buildable robot read correctly? ───────────
 * One scene per archetype × launcher mount, each holding the same build at three chassis
 * sizes. That is 26 sheets, which sounds like a lot until you notice it is the complete space
 * of BIOBUZZ builds: four archetypes, nine turret positions for the two turreted ones and four
 * firing edges for the two turretless ones. A sprite bug — a drum drawn on the wrong edge, a
 * corner turret hanging off the frame, a sweeper whose rollers miss its own footprint — lives
 * in exactly one of those combinations and is invisible in the other twenty-five. Enumerating
 * them is what makes the contact sheet a proof rather than a spot check.
 *
 * The gallery draws each sheet's robots TWICE: the in-match canvas sprite and the builder's SVG
 * preview, side by side. They are two renderers reading one geometry (`bbMouths`,
 * `bbFootprint`, `turretLocal`), so any difference between the two pictures is a real
 * divergence — which is the only way to catch it, since neither drawing is wrong on its own.
 */

/** POLLEN ids start at 1 — see the note in `scenesField.ts`. */
const ID0 = 1;

/**
 * The three chassis sizes every archetype sheet shows, as REQUESTED square footprints.
 *
 * 12 and 18 are both outside what BIOBUZZ can build, and that is deliberate: the coercer
 * clamps them to the floor and the ceiling of the legal envelope, so the outer two cells are
 * always "the smallest robot this build can be" and "the largest", whatever the envelope
 * currently is. Hard-coding the resolved numbers instead would silently stop tracking
 * `bbSizeLimits` the day an intake's reach changes.
 *
 * The 18 request currently lands at 15" long, because the sloped intake caps chassis LENGTH at
 * 15 independently of the R102 prism — so the three cells differ mostly in WIDTH. That is a
 * real constraint of the build, not a bug in the sheet, and it is exactly the kind of thing
 * worth seeing in a picture.
 */
const SHEET_SIZES = [12, 15, 18] as const;

/**
 * Where the three sheet robots stand: spread along the field's Y axis, on x = 0.
 *
 * ALONG Y, NOT X, and that is a fact about the CAMERA rather than about the field. Every cell
 * is drawn at the blue drive-station view angle, which maps world +x to SCREEN DOWN and world
 * +y to screen right. Standing them along x — the obvious first choice, and what this was —
 * stacked the sheet vertically, so the three sizes read top-to-bottom and the eye had to
 * travel the long way to compare two chassis. Along y they read left-to-right, smallest first,
 * which is the order `SHEET_SIZES` is written in.
 *
 * 34" apart: the largest legal chassis is 17" wide, so there are ~13" of tile between
 * neighbours and no sweeper can touch the robot beside it — while still keeping all three
 * inside the zoomed window the gallery draws a sheet in.
 */
const SHEET_Y = [-34, 0, 34] as const;

/**
 * Every sheet robot faces SCREEN UP (heading 180° = world −x = up in the blue view).
 *
 * So the canvas sprite and the builder's SVG preview point the same way. The preview draws the
 * chassis front at the TOP of its viewBox — that is baked into its frame transform — and a
 * sheet whose sprites faced the other way asked the reader to mentally flip one of the two
 * pictures they are being shown side by side, which is exactly the comparison the sheet exists
 * to make easy.
 */
const SHEET_HEADING_DEG = 180;

/**
 * One archetype sheet: the same build at three sizes, standing still, facing +x.
 *
 * ── WHY `build` REACHES INTO THE WORLD AFTERWARDS ──────────────────────────
 * It points every robot's turret STRAIGHT AHEAD. `turretHeading` is a world-frame angle, and
 * `makeBiobuzzRobot` aims a fresh turret at the field CENTRE (there being no target to aim at
 * in the shell), so three robots standing at three different places would each spawn with a
 * different turret angle — and the sheet's whole job is that the three cells differ ONLY by
 * chassis size. Aligning it to the chassis heading rather than to zero is what keeps a turret
 * from pointing sideways out of a robot that is facing up the screen. Setting it here is world
 * CONSTRUCTION, which a scene owns; it is not a step-time mutation, which a `script` is
 * forbidden from doing.
 */
function archetypeScene(mode: BbScoreMode, mount: BbMountPos): Scene {
  return {
    id: `archetype-${mode}-${mount}`,
    title: `${mode} · ${mount} launcher · front sweeper · smallest / 15" / largest legal chassis`,
    lane: 'robot',
    build: (seed): World => {
      // INTAKE MOUNT FIXED AT FRONT across every sheet. The sweeper mount is varied by its own
      // dimension of the space and crossing the two would be 104 sheets; front is the mount
      // every archetype is normally built with, so it is the one that has to read perfectly.
      const spec = (size: number): Partial<RobotSpec> => ({
        scoreMode: mode,
        shooterMount: mount,
        intakeMount: 'front',
        length: size,
        width: size,
      });
      const world = bbWorld(
        seed,
        SHEET_SIZES.map((size, i) =>
          bbSetup(i, 'blue', { x: 0, y: SHEET_Y[i], headingDeg: SHEET_HEADING_DEG }, spec(size)),
        ),
        [], // no POLLEN: a sheet is about the robot, and loose balls would obscure the sweeper
      );
      for (const r of world.robots) r.turretHeading = r.heading;
      return world;
    },
    // ONE STILL, at tick 0. Nothing moves in a sheet, so a second still would be the same
    // picture at the cost of another screenshot — and `shots.cjs` shoots every cell twice
    // already (one per theme).
    stills: [0],
  };
}

/** every archetype × every mount it can actually be built with: the nine chassis positions for
 * a turret (it aims itself, so its mount is where it is bolted) and the four firing edges for a
 * turretless drum or dumper (its launch line spans a whole side, so a corner is not a build). */
const ARCHETYPE_SHEETS: readonly Scene[] = BB_SCORE_MODES.flatMap((mode) =>
  (isTurreted(mode) ? BB_MOUNT_POSITIONS : BB_SHOOTER_EDGES).map((mount) => archetypeScene(mode, mount)),
);

export const BB_ROBOT_SCENES: readonly Scene[] = [
  {
    id: 'intake-line',
    title: 'Drive a running sweeper along a line of 10 pollen at 45 in/s',
    lane: 'robot',
    /**
     * THE CAPTURE INVARIANT, as a picture: THE DRAWN MOUTHS ARE THE CAPTURE AREAS.
     *
     * A line rather than a pile, and spaced 7" apart, so each POLLEN is captured as a SEPARATE
     * event a still can be attributed to. In a pile you see the count drop and cannot tell
     * whether the mouth grabbed from where it is drawn or from an inch outside it; in a line
     * you can see the exact ball that vanished and where the robot was when it did.
     *
     * It also runs the hopper to its CAP. The default build's cap is well under ten, so the
     * back half of the line must be plowed rather than collected — and a robot that keeps
     * eating past its cap is a bug this scene shows for free.
     *
     * Held POLLEN stay in `world.balls` as `kind: 'held'` (unlike Chain Reaction, which drops
     * them), so the count in this scene is constant from the first tick to the last and the
     * renderer's decision not to draw a held pollen is the only reason the line looks shorter.
     */
    build: (seed) =>
      bbWorld(seed, [bbSetup(0, 'blue', { x: -50, y: 0, headingDeg: 0 })], bbRow(ID0, 10, -30, 0, 33, 0)),
    script: () => ({ 0: bbCmd({ driveY: bbThrottle(BB_DEFAULT_SPEC, 45), intake: true }) }),
    stills: [0, 45, 120, 240],
  },

  {
    id: 'launch-wall-bounce',
    title: 'A dumper empties a full hopper at the wall',
    lane: 'robot',
    /**
     * A FULL HOPPER, FIRED AT A WALL FROM 20", and then left alone to see what comes back.
     *
     * Three things are being looked at, and the wall is what makes all three legible:
     *  • WHERE THE POLLEN LEAVE FROM. A dumper fans its whole load across its firing edge in
     *    one tick, so the launch line is drawn in POLLEN — if the sprite's release lip and
     *    `bbLaunch`'s launch line disagree, the fan starts in the wrong place and you can see
     *    it without measuring anything.
     *  • THE BALLISTIC ARC. Flight POLLEN carry a `z` and a shadow; a lob that lands short of
     *    the wall or clips through it is the arc and the landing test at once.
     *  • THE BOUNCE. `BB_POLLEN_WALL_REST` is an APPROX guess, and a restitution guess is only
     *    ever judged by watching it. Too high and the field never settles; too low and pollen
     *    die on contact. The last still is 3 seconds after the shot for exactly that reason.
     *
     * THE HOPPER IS LOADED THROUGH `capturePollen`, not by writing `r.hopper`. It is the real
     * capture path, so the loaded state is a state the game can actually reach — and the cap
     * check inside it means this scene cannot lie about how much a build carries.
     */
    build: (seed): World => {
      const world = bbWorld(seed, [bbSetup(0, 'blue', { x: BB_HALF_X - 20, y: 0, headingDeg: 0 }, {
        scoreMode: 'dumper',
        shooterMount: 'front',
        intakeMount: 'back', // ...so the dumper's edge is clear, as a real dumper build is
      })], []);
      const r = world.robots[0];
      // Load to capacity. Each POLLEN is created AT the robot and immediately captured, which
      // is the same two steps a real collection is, minus the driving.
      const cap = bbHopperCap(r.spec);
      for (let i = 0; i < cap; i++) {
        const ball = bbPollen(ID0 + i, r.pos.x, r.pos.y);
        world.balls.push(ball);
        capturePollen(world, r, ball);
      }
      if (world.biobuzz) world.biobuzz.nextBallId = ID0 + cap;
      return world;
    },
    // FIRE HELD FROM TICK 0, then released at tick 30 so the second half of the scene is
    // pollen doing what pollen do rather than a launcher still firing. A dumper empties in one
    // tick anyway; holding the button is what a driver does and costs nothing.
    script: (_world, tick) => ({ 0: bbCmd({ fire: tick < 30 }) }),
    stills: [0, 20, 45, 90, 240],
  },

  ...ARCHETYPE_SHEETS,
];
