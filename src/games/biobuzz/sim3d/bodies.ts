import type { Rapier3d } from './engine';
import type { Alliance, RobotSpec } from '../../../types';
import { dcos, dsin } from '../../../math';
import {
  BB3_ELEMENT_FRICTION,
  BB3_ELEMENT_MASS,
  BB3_ELEMENT_RESTITUTION,
  BB3_ELEMENT_ROLL_DAMP,
  BB3_FIELD_COLLIDERS,
  BB3_HIVE_ARM,
  BB3_HIVE_CELL,
  BB3_HIVE_BALLAST,
  BB3_HIVE_BALLAST_AT,
  BB3_HIVE_CELL_WALL,
  BB3_HIVE_DAMPING,
  BB3_HIVE_DYNAMIC,
  BB3_HIVE_PIVOT_Z,
  BB3_HIVE_TRAY_MASS,
  BB3_NECTAR_MASS_RATIO,
  BB3_WALL_H,
  BB_FLOWER_TOP_Z,
  BB_HALF_X,
  BB_HALF_Y,
  BB_HIVE_BOTTOM_Z,
  BB_HIVE_TILT_DEG,
  BB_HIVE_X,
  BB_RAMP_ANGLE,
  BB_RAMP_DECK_Z,
  BB_RAMP_FLOOR_Z,
  BB_RAMP_IN,
  BB_RAMP_L,
  BB_RAMP_OUT,
  BB_RAMP_PIVOT_BACK,
  BB_RAMP_PIVOT_Z,
  BB_RAMP_TIP_Z,
  BB_RAMP_WEDGE_THICK,
  BB_SIDE_ROLLER_H,
  BB_SIDE_ROLLER_OUT,
  BB_SIDE_ROLLER_R,
  bbSideRollerY,
  BB_SIDE_ROLLER_Z,
  BB_WALL_T,
} from '../config';
import { biobuzzColliders, BB_WALL_COUNT } from '../colliders';
import { INTAKE_RAIL_T, PHYS_FRICTION } from '../../../config';
import {
  BB3_CHASSIS_TOP_Z,
  BB3_LIFT_EDGE_R,
  BB3_INTAKE_CORNER_CLAMP,
  BB3_INTAKE_CORNER_R,
  BB3_MOUTH_SLOT_Z,
  BB_DECK_Z,
  bbIntakeReach,
  bbMechEnvelopes,
} from '../config';
import { bbMouths, mouthAxes } from '../robot';
import { bbIntakeKindOf } from '../mechs';
import { EDGE_ANGLE, type BbEdge } from '../mounts';
import { cadCellBox, cadStatics, cadTrayHulls, cadTrayRiders } from './fieldColliders';
import { buildFlowerTubes3d } from './flowerTube';
import { GROUP_CHASSIS, GROUP_ELEMENT_BIT, GROUP_RING_BIT, GROUP_NECTAR_BIT, GROUP_RAMP } from './groups';
import { pitchQuatY, quatMul, tiltQuatX, yawQuat, type Quat } from './math3';

/**
 * TEST-ONLY OVERRIDE for `BB3_FIELD_COLLIDERS`, read by every CAD-vs-fallback branch in this
 * file through `useFieldColliders()` below instead of the raw constant. `null` (the default)
 * means "use the constant, as production does"; the SIM3D smoke lane's twelve-probe agreement
 * check (`docs/biobuzz/plan-3d.md` §9) sets it to `false` to build a second, fallback-only
 * engine on the SAME world for comparison, then resets it to `null` — never left set, so a
 * forgotten reset cannot leak into a later check or into production (nothing outside a test
 * calls the setter at all).
 */
let fieldCollidersOverride: boolean | null = null;

/** test-only: force every CAD-vs-fallback branch below to `value` regardless of
 * `BB3_FIELD_COLLIDERS`, or pass `null` to restore the constant. */
export function __setFieldCollidersOverrideForTests(value: boolean | null): void {
  fieldCollidersOverride = value;
}

function useFieldColliders(): boolean {
  return fieldCollidersOverride ?? BB3_FIELD_COLLIDERS;
}

/**
 * THE SAME SHAPE OF OVERRIDE FOR `BB3_HIVE_DYNAMIC`, and it exists for two callers that are not
 * production: `scripts/hive-calibrate.ts`, which has to build a DYNAMIC tray in order to measure
 * the thing that decides whether the constant may be true at all, and the HIVE3D smoke lane,
 * which runs the load table under BOTH trays so the kinematic fallback stays proven whatever the
 * constant says. `null` (the default) means "use the constant, as production does".
 *
 * ⚠️ AN ENGINE BUILT BEFORE THE SWITCH KEEPS THE TRAY IT WAS BUILT WITH — a Rapier body's type is
 * fixed at creation. Set it BEFORE the world's first step, and reset it after; a caller that
 * flips it mid-match gets the tray it started with and no error.
 */
let hiveDynamicOverride: boolean | null = null;

export function __setHiveDynamicOverrideForTests(value: boolean | null): void {
  hiveDynamicOverride = value;
}

/** is the DYNAMIC see-saw in force? The ONE reader — `bodies.ts` builds on it, `engine.ts`
 * branches `applyHiveTilt` on it, `hive3d.ts` picks its bookkeeping pass with it. */
export function useHiveDynamic(): boolean {
  return hiveDynamicOverride ?? BB3_HIVE_DYNAMIC;
}

/**
 * THE FOURTH TEST-ONLY OVERRIDE, AND THE ONE THAT KEEPS A RULE HONEST: build the chassis as the
 * FLOOR-TO-`heightIn` PRISM it was before 2026-09-21 (`chassis3dShapes`' own header).
 *
 * It exists because the SIM3D lane's "no contact in air" rule would otherwise be VACUOUS — a
 * check that passes is worth nothing until the shape it replaced is shown to FAIL it, which is
 * the same discipline `slimFootBars`' invisible-corner rule follows. The lane sets it, measures
 * the owner's own repro and the rule against the old prism, and resets it in a `finally`; nothing
 * in production calls the setter at all. `false` is production.
 */
let legacyPrismOverride = false;

export function __setLegacyPrismForTests(value: boolean): void {
  legacyPrismOverride = value;
}

/**
 * CALIBRATION-ONLY BALLAST OVERRIDE, the third and last of these.
 * `scripts/hive-calibrate.ts` sweeps the ballast's LEVER ARM — how far below the pivot the mass
 * sits — because that is what sets the tray's restoring torque, and the restoring torque is one
 * of the two terms in the threshold the load table has to land between. It cannot do that by
 * rewriting `config.ts` between candidates: the module is already loaded. `null` is production.
 */
let ballastOverride: { mass: number; w: number } | null = null;

export function __setBallastForCalibration(value: { mass: number; w: number } | null): void {
  ballastOverride = value;
}

/**
 * BIOBUZZ 3D PHYSICS -- body and collider specs (Day 1, docs/biobuzz/plan-3d.md section 3).
 *
 * THE Z / HEIGHT CONVENTION, ONE PLACE.
 * World/Artifact numbers are all in the 2D pipeline's own convention, which this port keeps
 * rather than inventing a second one: Artifact.z is the height of the ball's BOTTOM above the
 * tile plane (z = 0 means resting on the floor), matching how play.ts's flight integrator and
 * spawn.ts's staged elements already use it (a resting ground ball is always z = 0; a flown
 * one lands the instant z <= 0). So a Rapier BODY, whose translation is its CENTRE, sits at
 * z_body = b.z + r on the way IN (sync), and readback reverses it: b.z = round4(centre.z - r).
 * RobotState.z is the SAME convention one level up -- the height of the chassis BOTTOM, so a
 * robot driving on the tiles reads z = 0 and the body's centre sits at z + heightIn/2.
 *
 * THE HIVE TRAY'S LOCAL (v, w) FRAME.
 * Each hive is ONE kinematic body, translated once at its pivot (pivotX(a), 0,
 * BB3_HIVE_PIVOT_Z) and never moved again -- only its ROTATION (about the body's local X axis,
 * which stays aligned with world X since the body's own yaw/roll are never touched) changes,
 * via setNextKinematicRotation. Every collider hung off that body is placed in the body's OWN
 * local frame, which Rapier then carries into world space by the body's translation + rotation
 * automatically -- so nothing in this file has to apply rotate2 to PLACE a tray collider; that
 * helper is for the one thing that is NOT automatic, testing a WORLD-SPACE point (an element's
 * position) against a LOCAL-SPACE box (derive.ts's cell-membership test), which has to undo the
 * rotation by hand because the point does not live on the tray body.
 *
 * The local axes: X is world X unchanged (the hinge axis; a cell's WIDTH lives here). Y is v,
 * signed distance from the pivot ALONG the bar -- a cell at v > 0 is north, v < 0 is south,
 * matching BbCellSide. Z is w, height above the tray's OWN floor (the cell interior spans
 * w in [0, BB3_HIVE_CELL.h]) -- so at REST (world X unrotated), a local point (x, v, w) maps to
 * world (pivotX + x, v*cos(theta) - w*sin(theta), BB3_HIVE_PIVOT_Z + v*sin(theta) +
 * w*cos(theta)), exactly rotate2(v, w, theta) for the last two.
 *
 * THE OPENING VS. THE CLEARANCE, TWO FEATURES, ONE RESIDUAL -- RESOLVED BY THE CAD (§8), AND
 * THEN BY THE OWNER'S RULING.
 * The Day 1 analytic CELL BOX (`hiveCellLocalBox`'s fallback branch, still here for when
 * `BB3_FIELD_COLLIDERS` is off or a part is missing) was calibrated to the LAUNCH OPENING and
 * could not ALSO put its down-side floor at the manual's robot-clearance figure of 25.5, because
 * a rigid bar whose up-side opening matches Fig 9-10 does not: the same box mirrored to the down
 * side sat 7 in high. The Day 1 fix was a SEPARATE, EXPLICIT clearance bracket (`HIVE_BRACKET_W`
 * below) solved to read exactly 25.5 in when that cell is down -- flagged APPROX, because a real
 * CAD assembly delivers both figures from ONE shape.
 * It does, and the answer is that the 25.5 was the figure at fault: the CAD's up-cell opening
 * matches the manual to 0.13 in and its down-cell floor is 31.981, which the owner ruled
 * authoritative on 2026-09-18. `BB_HIVE_BOTTOM_Z` is now that number, so the bracket lands where
 * the CAD tray's own floor does and the two paths agree instead of trading one figure for the
 * other. With `BB3_FIELD_COLLIDERS` on, `cadCellBox`/`cadTrayHulls` (`fieldColliders.ts`) ARE
 * that one shape -- the CAD tray's own floor/back/side/ceiling hulls, un-rotated into this same
 * (x, v, w) frame -- and the bracket is dropped outright (see `buildHiveTray3d`).
 */

// ---- STATICS -----------------------------------------------------------------
// floor (always analytic) and walls (always analytic cuboids at the shared BB_HALF_X/Y/
// BB3_WALL_H constants, which ARE the CAD's own measured inner faces since the 2026-09-18
// ruling -- see buildStatics3d's own comment for why the analytic plane and not the CAD's
// stepped wall trimesh), and everything
// else (flower supports) as CAD trimesh statics -- falling back to the 2D field's own
// frame-bar/flower-foot boxes (`biobuzzColliders`, extruded) when the CAD set is off or empty.

/** the 2D field's static count breakdown -- `biobuzzColliders.statics` is built as
 * `[...walls, ...frameBars, ...flowerFeet]` (see `colliders.ts`), and `BB_WALL_COUNT` (4) is
 * exported from there; the frame count (2) is not, so it is named here once rather than as a
 * bare `2` at the slice site. Only used by the fallback branch below. */
const FRAME_COUNT = 2;

/** floor half-thickness (in) -- deliberately thick for the same reason the 2D perimeter walls
 * are: a thin static under a fast-falling sphere can tunnel through in one 1/60s step without
 * CCD, and the floor is the one static every dynamic body rests against every tick. */
const FLOOR_HALF_T = 10;

/**
 * THE TILES' RESTITUTION IS A **MULTIPLIER**, NOT A COEFFICIENT — which is what lets an element
 * bounce off the tiles like a hard ball off foam while a chassis resting on the same collider
 * reads exactly zero.
 *
 * ── WHY THE RULE AND NOT THE NUMBER ────────────────────────────────────────
 * Rapier resolves a pair's restitution by taking the HIGHER-PRIORITY of the two colliders' rules
 * (Average 0 < Min 1 < Multiply 2 < Max 3) and applying it to the two values. Under the default
 * AVERAGE the floor's number is shared by everything that rests on it, and the three things that
 * rest on it want three different answers:
 *
 *  · an ELEMENT wants the real pair — `BB3_ELEMENT_RESTITUTION`, a hard plastic ball on foam;
 *  · a CHASSIS wants ZERO, because a robot never leaves the tiles and any rebound there is a
 *    numerical term on top of the drive model, which the SIM3D lane's parity checks measure;
 *  · the element/TRAY pair wants the TRAY's own low number (`TRAY_RESTITUTION_COMBINE`, Min),
 *    and Min has to keep winning or a shot bounces back out of the cell.
 *
 * MULTIPLY gives all three from one line. `e_pair = e_a · e_b`, so with this at **1.0** an
 * element reads its OWN coefficient against the tiles (`0.55 · 1.0`) and a chassis reads
 * `0 · 1.0` = 0 exactly. The tray is untouched: this rule is on the FLOOR, which the tray never
 * meets, and every element/tray pair is still the element's Average against the tray's Min, so
 * Min wins there as it always did. Handing the ELEMENT a Max rule instead would have been the
 * obvious move and is the wrong one: it travels with the element to EVERY pair, Max outranks
 * Min, and it would have taken the cell's own low restitution with it.
 *
 * ⚠️ 1.0 IS NOT "A PERFECTLY ELASTIC FLOOR". Nothing ever reads it as a coefficient; it is the
 * identity of the multiply. Changing the BOUNCE means changing `BB3_ELEMENT_RESTITUTION`.
 *
 * WAS 0.05 under the AVERAGE rule, which made the element/tile pair `(0.45 + 0.05)/2 = 0.25`
 * and a robot/tile pair of 0.025. Measured on a real 8-POLLEN tip: elements arriving at 160 in/s
 * rebounded **1.0–2.1 in**, which on a 30-in drop is not a bounce anybody can see, and the owner
 * reported it as such ("in real life the balls bounce and disperse a lot more after the hive tips
 * and it hits the field tiles", 2026-09-19). See `BB3_ELEMENT_RESTITUTION` for the band it is
 * sized to now and the dispersal the change bought.
 */
const TILE_RESTITUTION = 1.0;

/**
 * ⚠️ **THE TRAY AND ITS OWN FRAME DO NOT COLLIDE**, and under the DYNAMIC see-saw that is the
 * difference between a hive that tips and one that does not.
 *
 * The CAD tray's `bar_<side>` hull IS the Basket Base Tube, which runs THROUGH the pivot, and the
 * frame's own pivot brackets, axle holders, dampers and Blumotion units are wrapped around that
 * same shaft. Their hulls necessarily overlap: that is what a bearing looks like to a convex
 * hull. A KINEMATIC tray does not care — it is not solved — so this cost nothing until Day 2.
 * A DYNAMIC tray is WEDGED: measured, a tray with 8 POLLEN in the up cell and the load beating
 * the hold by 16 % rotated 1.14° and stopped dead, for four hundred ticks, with the detent
 * correctly released the whole time.
 *
 * The physical contact the exclusion removes is not lost: the damper meeting the frame at each
 * end of the swing is exactly what the revolute joint's ±30° LIMITS are, and §10.5.1 B scores
 * the TIP on it. Everything else — robots, elements, the flowers — still meets both.
 *
 * Rapier's rule: two colliders interact iff `(A.memberships & B.filter)` and
 * `(B.memberships & A.filter)` are both non-zero, packed as `(memberships << 16) | filter`.
 * Everything not named here keeps the default `0xFFFF / 0xFFFF` and therefore meets both.
 */
const GROUP_TRAY_BIT = 0x0001;
const GROUP_FRAME_BIT = 0x0002;
/** the hive TRAY's colliders: they meet everything EXCEPT the frame. */
export const GROUP_TRAY = (GROUP_TRAY_BIT << 16) | (0xffff & ~GROUP_FRAME_BIT);
/** the hive FRAME's colliders: they meet everything EXCEPT the tray. */
export const GROUP_FRAME = (GROUP_FRAME_BIT << 16) | (0xffff & ~GROUP_TRAY_BIT);

/**
 * ⚠️ **THE THIRD BIT: AN ELEMENT, AND THE ONE BOX THAT MUST NOT MEET ONE.**
 *
 * The intake mouth is open below `BB3_MOUTH_SLOT_Z` because an ELEMENT has to roll in under the
 * roller — that is the whole reason `chassis3dShapes` is a compound at all, and closing the
 * pocket with geometry was measured and is badly wrong (a six-element cluster 10/18, a strafe
 * past a line 1/4). But nothing ELSE should fit in there, and things did: see
 * `chassis3dPocketShapes`. So the pocket is closed with a FILTER instead of with a shape.
 *
 * | collider          | memberships          | filter                | meets an element? |
 * |-------------------|----------------------|-----------------------|-------------------|
 * | element (ball)    | `ELEMENT` only       | everything            | yes (other balls) |
 * | pocket filler     | everything           | everything but ELEMENT| **no**            |
 * | hive tray         | `TRAY`               | everything but FRAME  | yes               |
 * | hive frame        | `FRAME`              | everything but TRAY   | yes               |
 * | everything else   | `0xFFFF` (default)   | `0xFFFF` (default)    | yes               |
 *
 * ⚠️ **AN ELEMENT'S MEMBERSHIPS ARE NARROWED TO ONE BIT, WHICH IS THE HALF THAT CAN GO WRONG
 * SILENTLY.** Rapier's rule is symmetric — a pair interacts iff `(A.memberships & B.filter)` and
 * `(B.memberships & A.filter)` are BOTH non-zero — so the filler's filter can only exclude
 * elements if an element's memberships are exclusively the element bit. That makes every OTHER
 * collider's filter load-bearing: a filter that stops carrying `ELEMENT` drops elements through
 * the floor, out of the walls, or through the tray, and nothing errors. The two narrowed filters
 * above both still carry it (`~FRAME` and `~TRAY` are not `~ELEMENT`), everything else is
 * `0xFFFF`, and the SIM3D lane's conservation/containment run is what proves it rather than this
 * paragraph.
 */
/** an ELEMENT's collider: it is the ONLY thing carrying this bit, and it meets everything. */
export const GROUP_ELEMENT = (GROUP_ELEMENT_BIT << 16) | 0xffff;
/** the intake POCKET FILLER: ordinary membership, and it meets everything but an element.
 * `>>> 0` because `0xffff << 16` is NEGATIVE as a signed 32-bit int, and `collisionGroups()`
 * reads back unsigned — the value Rapier stores is the same either way, but a check comparing
 * the two would be comparing -5 against 4294967291. */
// ...and NOT a NECTAR either: a NECTAR carries its own bit as well (`groups.ts`, the flower's
// middle-ring lip), and a filter that cleared only the element bit would meet it through that one.
// Nor a FLOWER's ring-plate trimesh: a robot meets the plates as solid boxes (`groups.ts`).
export const GROUP_POCKET = (((0xffff << 16) | (0xffff & ~(GROUP_ELEMENT_BIT | GROUP_NECTAR_BIT | GROUP_RING_BIT))) >>> 0) as number;

/**
 * THE HIVE FRAME IS A REAL COLLIDER AGAIN (2026-09-18 CAD round 2).
 *
 * It was excluded outright before, and the reason was a defect in the EXPORTER, not a property
 * of the geometry: every static used to be a hull of the part's AXIS-ALIGNED BOUNDING BOX, and
 * an AABB of a LEANING part is the whole box it sweeps through. `hive_red_frame_a_frame_leg`
 * measured x ∈ [-24.28, -12.24], z ∈ [0.22, 41.40] -- floor to nearly the pivot, reaching almost
 * to the hive's centreline -- so as a solid it turned "a robot drives under the hive" (G409,
 * `colliders.ts`'s own header) into "a robot cannot enter the space under the hive at all":
 * measured, the parity check's robot stopped dead at x ≈ 1.75. The same defect made
 * `frame_upright`'s AABB a near-full-size box between the base and the pivot, which ejected the
 * staged up-cell nectar at ~700 in/s on tick one.
 *
 * `convert.py` now exports a TRUE convex hull of each part instance's own tessellated surface,
 * so the A-frame leg is the thin diagonal strut it actually is (foot at ±(24.30, 19.07, 0.22),
 * apex at ±(12.26, 0, 41.40)), the Churro braces are 0.37-in tubes, and the space between the
 * two legs -- the drive-under -- is empty because nothing is in it. See
 * `docs/biobuzz/field-cad-audit.md` §4.6.
 *
 * WHICH classes become solids is `PHYSICAL_STATIC_CLASSES` in `fieldColliders.ts`, with the
 * reason for every exclusion written next to it (walls and floor stay analytic at the constants
 * by owner rule; tape/decals/under-tile hardware cannot be touched; a flower RING plate's hull
 * would fill the hole a POLLEN passes through).
 */

/**
 * Build every BIOBUZZ static collider into `world3d`: the floor, the four perimeter walls, the
 * hive frames (legs, feet, foot bars, top corners, crossbar, uprights, dampers, brackets, logo
 * panel) and the four flower supports -- named order, fixed every call (determinism: plan
 * section 2.1's "statics (named, fixed order)").
 */
export function buildStatics3d(
  RAPIER: Rapier3d,
  world3d: InstanceType<Rapier3d['World']>,
  wallFriction: number,
): void {
  const ground = world3d.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, -FLOOR_HALF_T));
  // FRICTION 0, DELIBERATELY. The shared `updateRobot` wrench is already the traction-limited,
  // motor-modelled FINAL force (`docs/area/physics.md`) -- the 2D solve has no floor at all, so
  // that force is the whole story there. This chassis DOES rest on a real floor for vertical
  // support, and a nonzero floor friction would be a SECOND, uncalibrated resistive term on
  // top of the drivetrain model's own answer -- measured, at the old 0.6 it visibly slowed the
  // drive-feel parity check below the 5% band. Elements still get real floor friction: their
  // collider (`engine.ts`) sets a MAX combine rule, so a 0-friction floor does not touch them.
  // MIN COMBINE RULE: with the floor's own friction already 0, MIN(anything, 0) is always 0
  // for a pair that does not itself specify a stronger rule -- exactly the robot's case (its
  // collider sets no rule, i.e. Average, which MIN beats). An element's own collider sets MAX
  // (`engine.ts`), and MAX outranks MIN in Rapier's own precedence, so an element resting on
  // this same floor still reads its own friction, not this 0.
  world3d.createCollider(
    RAPIER.ColliderDesc.cuboid(1000, 1000, FLOOR_HALF_T)
      .setFriction(0)
      .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
      // MULTIPLY, and the value is the identity — see `TILE_RESTITUTION`. Each body that rests
      // here reads its own coefficient against the tiles and a chassis reads zero.
      .setRestitution(TILE_RESTITUTION)
      .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Multiply),
    ground,
  );

  // ---- WALLS: four thick cuboids at the shared constants (BB_HALF_X/Y inner face, BB3_WALL_H
  // height), which ARE the CAD's own measured inner faces now -- `BB_HALF_X/Y` is `FIELD_HALF`
  // from `fieldDims.gen.ts` (owner ruling, 2026-09-18: "the CAD is authoritative for
  // dimensions"). The "stay at 72 for parity" exception this comment used to carry is GONE,
  // because there is nothing left for it to be an exception to: the 2D pipeline, the staging and
  // every gameplay rule are keyed to the same ±70.674 these cuboids are built at, so building
  // from the constants and building from the CAD are the same act.
  //
  // ⚠️ THEY ARE STILL BUILT FROM THE CONSTANTS, NOT FROM `cadWallExtents()`. The CAD's wall
  // TRIMESH is the real panels, links and rails -- a stepped, gappy surface with the glass only
  // 11 in tall -- and what the physics wants is one flat plane per side, tall enough that nothing
  // legal clears it. The constants express that plane; the measurement is what the SIM3D lane
  // checks the plane AGAINST (0.05 in, both pipelines and the GLB), which is the useful direction
  // for that comparison.
  const wallHeight = BB3_WALL_H;
  const wallHalf = wallHeight / 2;
  const wallCentreZ = wallHalf;
  const span = 2 * Math.max(BB_HALF_X, BB_HALF_Y) + 4 * BB_WALL_T; // long enough the four overlap at the corners
  const faces: readonly { readonly inner: number; readonly axis: 'x' | 'y'; readonly sign: 1 | -1 }[] = [
    { inner: BB_HALF_X, axis: 'x', sign: 1 },
    { inner: -BB_HALF_X, axis: 'x', sign: -1 },
    { inner: BB_HALF_Y, axis: 'y', sign: 1 },
    { inner: -BB_HALF_Y, axis: 'y', sign: -1 },
  ];
  for (const f of faces) {
    const centre = f.inner + f.sign * BB_WALL_T;
    const hx = f.axis === 'x' ? BB_WALL_T : span / 2;
    const hy = f.axis === 'x' ? span / 2 : BB_WALL_T;
    const tx = f.axis === 'x' ? centre : 0;
    const ty = f.axis === 'x' ? 0 : centre;
    const body = world3d.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(tx, ty, wallCentreZ));
    // WALL FRICTION MATCHES THE 2D SOLVE'S -- see the historical note this replaced: a
    // hardcoded 0.5 here undershot `PHYS_WALL_FRICTION` (0.65) enough to fail the drive-feel
    // parity checks on a wall-flush start (measured ratio 2.317 before this fix landed).
    world3d.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, wallHalf).setFriction(wallFriction).setRestitution(0),
      body,
    );
  }

  // ---- THE HIVE FRAMES AND THE FLOWER SUPPORTS, as CAD CONVEX HULLS: one fixed body + one
  // `ColliderDesc.convexHull` per named part instance, in the collider file's own array order
  // (determinism). Per INSTANCE, never merged per part TYPE -- one hull over both A-frame legs
  // is a solid wedge filling the gap between them, and that gap is the drive-under.
  const cad = useFieldColliders() ? cadStatics() : [];
  if (cad.length > 0) {
    for (const s of cad) {
      const desc = RAPIER.ColliderDesc.convexHull(new Float32Array(s.points));
      if (!desc) continue; // a degenerate point set -- Rapier returns null rather than throwing
      const body = world3d.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      const built = desc.setFriction(wallFriction).setRestitution(0);
      if (s.class === 'hive_frame') built.setCollisionGroups(GROUP_FRAME);
      world3d.createCollider(built, body);
    }
  } else {
    // legacy Day 1 fallback, used only when `BB3_FIELD_COLLIDERS` is off or the collider file is
    // absent: the 2D field's own frame-bar and flower-foot boxes (`colliders.ts`), extruded.
    const frameBars = biobuzzColliders.statics.slice(BB_WALL_COUNT, BB_WALL_COUNT + FRAME_COUNT);
    for (const s of frameBars) {
      const half = BB3_HIVE_PIVOT_Z / 2; // floor to the pivot
      const body = world3d.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(s.tx, s.ty, half).setRotation(yawQuat(s.rot)),
      );
      world3d.createCollider(
        RAPIER.ColliderDesc.cuboid(s.hx, s.hy, half)
          .setFriction(wallFriction)
          .setRestitution(0)
          .setCollisionGroups(GROUP_FRAME),
        body,
      );
    }
    const flowerFeet = biobuzzColliders.statics.slice(BB_WALL_COUNT + FRAME_COUNT);
    for (const s of flowerFeet) {
      const half = BB_FLOWER_TOP_Z / 2; // floor to the ring's top -- the MEASURED rectangle
      const body = world3d.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(s.tx, s.ty, half).setRotation(yawQuat(s.rot)),
      );
      world3d.createCollider(
        RAPIER.ColliderDesc.cuboid(s.hx, s.hy, half).setFriction(wallFriction).setRestitution(0),
        body,
      );
    }
  }

  // ---- THE FLOWER RING PLATES, as rectangle-minus-disc TRIMESHES (Day 2, §3.7). LAST, after
  // every hull, and that ORDER is load-bearing -- see `buildFlowerTubes3d`'s own comment.
  // They are not in `cadStatics()` and never will be: their class is `flower_ring`, which
  // `convert.py` exports no hull for, because a hull of an annulus fills the bore an element
  // passes through. Nothing here on the FALLBACK path: the Day 1 constants field has no per-ring
  // geometry to build from, and the flower foot box it does build stands in for the whole column.
  if (useFieldColliders()) buildFlowerTubes3d(RAPIER, world3d, wallFriction);
}

// ---- HIVE TRAY -----------------------------------------------------------------
// the Day 1 KINEMATIC fallback (`BB3_HIVE_DYNAMIC = false`). One body per hive, translated
// once at the pivot; its ROTATION is set every tick from `hive3d.ts`'s `hiveTiltAngle`.
// Colliders are placed in the body's own LOCAL (x, v, w) frame -- see the file header -- so
// Rapier's own transform carries them into world space; nothing here rotates by hand.

export function hivePivotX(alliance: 'red' | 'blue'): number {
  return alliance === 'red' ? -BB_HIVE_X : BB_HIVE_X;
}

/** an axis-aligned box in the tray's own LOCAL (v, w) plane (x is a separate half-extent,
 * since the box is centred on x = 0 for both cells). */
export interface HiveLocalBox {
  xHalf: number;
  vMin: number;
  vMax: number;
  wMin: number;
  wMax: number;
  /** which tilt angle this box's `vMin..wMax` numbers are true AT — **0 on BOTH paths now**.
   * The algebraic fallback has always been theta-independent by construction; the CAD path is
   * exported UN-TILTED (`convert.py` rotates every tray point by `−captureTheta` about the
   * pivot before writing it), which is the fix for the owner's "balls are on a different plane
   * than the actual bottom of the hive". The field stays in the shape, and
   * `hiveTrayRefTheta`/`applyHiveTilt`/`updateBiobuzzField` keep subtracting it, so that a
   * future field revision exported at some other pose has exactly one place to say so and every
   * consumer already honours it. `world = pivot + Rotate(theta) * (v, w)` holds for these
   * numbers directly. */
  refTheta: number;
}

/**
 * The CELL interior -- the launch opening AND the physical container a resting element sits in,
 * ONE box for both. `sideSign` is `1` (north, `v > 0`) or `-1` (south); `alliance` picks whose
 * tray (the CAD cells are alliance-specific real geometry, not assumed symmetric, even though
 * this STEP's four cells measure identically to 0.001 in).
 *
 * Prefers `cadCellBox` — the interior `convert.py` measured off the cell's own structural facet
 * PLANES (the floor plate's top surface at local w = −1.4682, the gable apex, the side walls,
 * the back plate), which is the same surface the GLB mesh draws. Falls back to the Day 1
 * algebraic box, calibrated to the manual's launch-opening figure alone, when the CAD set is off
 * or has no cell for this side.
 */
export function hiveCellLocalBox(sideSign: 1 | -1, alliance: Alliance): HiveLocalBox {
  if (useFieldColliders()) {
    const cad = cadCellBox(alliance, sideSign);
    if (cad) return cad;
  }
  const half = BB3_HIVE_CELL.d / 2;
  const centre = sideSign * BB3_HIVE_ARM;
  return {
    xHalf: BB3_HIVE_CELL.w / 2,
    vMin: Math.min(centre - half, centre + half),
    vMax: Math.max(centre - half, centre + half),
    wMin: 0,
    wMax: BB3_HIVE_CELL.h,
    refTheta: 0,
  };
}

/**
 * THE TRAY'S REFERENCE ANGLE lives in `./tilt.ts` now and is re-exported here, unchanged, so
 * every caller that reached it through "the bodies module" still does. It moved for the same
 * reason `hiveTiltAngle` did (see `tilt.ts`'s header): `scene/renderField.ts` subtracts it on a
 * frame where no 3D physics is loaded, and importing it from HERE put the CAD collider set and
 * every body builder in the main chunk.
 *
 * It is a constant 0 there rather than a read of `fieldColliders.ts`'s `cadTrayRefTheta`, which
 * is the value the CAD actually carries on both trays; the SIM3D lane asserts the two agree.
 */
export { hiveTrayRefTheta } from './tilt';

/**
 * The DOWN-CLEARANCE bracket for one cell -- a local point `(v, w)` calibrated so that, WHEN
 * THIS CELL IS DOWN (its own rest tilt), the bracket's world z is exactly `BB_HIVE_BOTTOM_Z`
 * (31.981 -- the CAD's, since the 2026-09-18 ruling; it was the manual's 25.5 when this was
 * written). Solved once, algebraically, from the rest-tilt geometry (see the file header): at
 * `theta = BB_HIVE_TILT_DEG` and `v = -BB3_HIVE_ARM` (the DOWN side's own centre, sign already
 * folded in), `BB3_HIVE_PIVOT_Z + v*sin(theta) + w*cos(theta) = BB_HIVE_BOTTOM_Z` solves for
 * `w`. The bracket sits at `v = sideSign * BB3_HIVE_ARM` (its own cell's centre) and this SAME
 * `w`, because both cells are mirror images of one another about the pivot.
 */
export const HIVE_BRACKET_W = (() => {
  const rad = (BB_HIVE_TILT_DEG * Math.PI) / 180;
  // solved for the DOWN side (v = -ARM): PIVOT_Z - ARM*sin(rad) + w*cos(rad) = BOTTOM_Z
  const BOTTOM_Z = BB_HIVE_BOTTOM_Z; // CAD (31.981) -- see `BB_HIVE_BOTTOM_Z` in config.ts
  // dsin/dcos, NOT Math.sin/cos -- this file is scanned by the sim source guard (deterministic
  // trig everywhere the sim can reach), and this constant is computed once at module load, on
  // every peer, so it has to be bit-identical everywhere too.
  const sinT = dsin(rad);
  const cosT = dcos(rad);
  return (BOTTOM_Z - BB3_HIVE_PIVOT_Z + BB3_HIVE_ARM * sinT) / cosT;
})();

/** thickness of the clearance bracket (in) -- APPROX, thin enough not to eat into the up-side
 * opening's own clearance test. */
export const HIVE_BRACKET_T = 1.5;

/**
 * Build one hive's tray body and its colliders (two cells of thin walls: floor, back, two
 * sides). Returns the body so `engine.ts` can key it and drive its rotation every tick.
 *
 * ONE SHAPE, TWO SOURCES. With `BB3_FIELD_COLLIDERS` on this builds the CAD tray's own PLANAR
 * FACET SLABS (`cadTrayHulls`) as `ColliderDesc.convexHull` shapes, directly, with no rotation
 * offset -- they are already in the tray's UN-TILTED pivot-local frame, which is the frame this
 * body's own rotation (`hiveTiltAngle`) is defined in. With it off (or with no hulls in the
 * file) it builds the Day 1 thin-walled box from `hiveCellLocalBox`'s algebraic fallback.
 *
 * ⚠️ WHY FACET SLABS AND NOT ONE HULL PER CAD PART -- the trap this replaces, twice over:
 *  - `Hive Goal Bottom Skin` is an OPEN U CHANNEL (a flat floor at local w = -1.4884 with two
 *    side walls rising to w = 6.33) and `Hive Goal Top Skin` is a GABLE ROOF. A convex hull of
 *    either FILLS the cell: an element would rest ~7.8 in above the floor it is drawn on.
 *  - `Goal Rib` is a perforated hexagonal FRAME plate at each end of the cell. Its hull fills
 *    its own opening -- and at the mouth end that opening IS the cell's aperture, so a shot
 *    could never get in. It is VISUAL-ONLY, exactly like the flower ring plates, and
 *    `convert.py` exports no hull for it.
 * `convert.py` therefore decomposes each shell into PLANAR FACETS and exports one thin oriented
 * box per structural plane -- `cell_<side>_{floor,side_pos,side_neg,roof_pos,roof_neg,back}` --
 * each sitting exactly ON its CAD surface and extruded 1.5 in OUTWARD. The padding is the same
 * anti-tunnelling allowance the hand-built walls used (a 0.25-in wall meeting a 260 in/s sphere
 * is at the edge of what one narrow-phase substep resolves); putting all of it on the outside is
 * the difference between a collider that agrees with the picture and one that does not.
 *  `bar_<side>` (`Basket Base Tube`) is a real solid rod and keeps a whole-part hull.
 *
 * NO CLEARANCE BRACKET, ON EITHER PATH: the Day 1 fallback used one (`HIVE_BRACKET_W`, still
 * exported below and read nowhere here -- kept because the SIM3D lane's measurements check
 * reports it as a historical reference point) precisely because its algebraic box could not put
 * a down cell's floor at the manual's 25.5 and its up cell's opening at the manual's [53.5, 65.6]
 * at the same time. That tension is RESOLVED rather than traded now: the CAD's up-cell opening
 * agrees with the manual to 0.13 in and its down-cell floor is 31.981, so `BB_HIVE_BOTTOM_Z` is
 * the CAD figure and the fallback's bracket lands where the CAD tray's own floor does.
 */
/**
 * THE TRAY'S OWN CENTRE OF MASS, in its local (v, w) frame — `v = 0` by symmetry (two identical
 * cells at ±`BB3_HIVE_ARM`), `w` the mid-height of a cell's own interior.
 *
 * ⚠️ **IT IS ABOVE THE PIVOT, AND THAT IS THE WHOLE OF THE BI-STABILITY.** A see-saw whose mass
 * sits above its hinge has an UNSTABLE equilibrium at level and a stable one at each stop: tip
 * it either way and its own weight carries it the rest of the way. That is what "bi-stable …
 * holds its position until enough POLLEN or NECTAR are LAUNCHED into the upwards-facing CELL"
 * (§9.6) describes, and it is a property of the real tray's shape rather than a term anyone
 * added — the cells are two big boxes standing on a bar. `BB3_HIVE_BALLAST` then TUNES it,
 * exactly as the field guide's ballast washers tune the real one.
 */
export function hiveTrayComW(alliance: Alliance): number {
  const north = hiveCellLocalBox(1, alliance);
  const south = hiveCellLocalBox(-1, alliance);
  return (north.wMin + north.wMax + south.wMin + south.wMax) / 4;
}

/** the tray's total mass and the combined centre of mass of tray + ballast, in the local frame.
 * ONE pair, because Rapier takes one mass and one CoM per body: the ballast is not a second body
 * a joint has to carry, it is a term in this average. */
export function hiveTrayMassProps(alliance: Alliance): { mass: number; comW: number; inertia: number } {
  const ballast = ballastOverride ?? { mass: BB3_HIVE_BALLAST, w: BB3_HIVE_BALLAST_AT[1] };
  const mass = BB3_HIVE_TRAY_MASS + ballast.mass;
  const comW = (BB3_HIVE_TRAY_MASS * hiveTrayComW(alliance) + ballast.mass * ballast.w) / mass;
  // APPROX, and a point-mass model on purpose: the two cells are what the tray's inertia is, and
  // they sit at ±ARM from the axis. `setAdditionalMassProperties` wants the inertia about the
  // CENTRE OF MASS, which is on the axis, so the arm is the whole of it. The y and z entries are
  // the same number and are never exercised — the revolute joint removes both of those freedoms.
  const inertia = mass * BB3_HIVE_ARM * BB3_HIVE_ARM;
  return { mass, comW, inertia };
}

export function buildHiveTray3d(
  RAPIER: Rapier3d,
  world3d: InstanceType<Rapier3d['World']>,
  alliance: Alliance,
  startTheta: number,
): { body: InstanceType<Rapier3d['RigidBody']>; joint: InstanceType<Rapier3d['ImpulseJoint']> | null } {
  const px = hivePivotX(alliance);
  /**
   * ── THE DYNAMIC SEE-SAW (plan §3.6), behind `BB3_HIVE_DYNAMIC` ────────────────────────────
   * One DYNAMIC body at the pivot on a REVOLUTE JOINT about the tray's own x axis, limited to
   * ±`BB_HIVE_TILT_DEG` (the damper stops, §9.6 / Fig 9-9). The second body the joint needs is a
   * FIXED anchor at the same point — Rapier has no "joint to the world", and an anchor body with
   * no collider costs nothing.
   *
   * ⚠️ `JointData.limits` DOES NOT CLAMP — the limits have to be set on the JOINT INSTANCE that
   * `createImpulseJoint` hands back (`setLimits`, documented in `docs/area/biobuzz.md` as a
   * shipped bug and re-confirmed by the Day 0 spike). Nothing else in this file can express the
   * stops, so a silently-unlimited joint is a tray that spins.
   *
   * With `BB3_HIVE_DYNAMIC` off this is the Day 1 KINEMATIC body, swung by the shared timer, and
   * the joint is `null`.
   */
  if (useHiveDynamic()) {
    /**
     * ⚠️ **THE MASS GOES ON THE DESC, NOT ON THE BODY**, and this is a shipped-once bug with a
     * very quiet signature. `RigidBody.setAdditionalMassProperties` called BEFORE the colliders
     * exist is discarded by the mass recomputation `createCollider` triggers, so the tray came
     * out with `body.mass() === 0` — a massless dynamic body, which gravity cannot accelerate
     * and a joint simply drags. Measured: with 8 POLLEN in the up cell and the load out-torquing
     * the hold by 16 %, the tray moved 1.14° and stopped, every row of the load table read NO
     * TIP, and the damping bisection reported "never reached the far stop" at every value from 0
     * to 60. Everything looked like a detent that would not release, and the detent was fine.
     *
     * `RigidBodyDesc.setAdditionalMassProperties` is carried into the body at creation and
     * survives every later collider, which is why the desc is the documented place for it.
     */
    const props = hiveTrayMassProps(alliance);
    const body = world3d.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(px, 0, BB3_HIVE_PIVOT_Z)
        .setRotation(tiltQuatX(startTheta))
        .setAngularDamping(BB3_HIVE_DAMPING)
        .setCcdEnabled(false)
        .setAdditionalMassProperties(
          props.mass,
          { x: 0, y: 0, z: props.comW },
          { x: props.inertia, y: props.inertia, z: props.inertia },
          { x: 0, y: 0, z: 0, w: 1 },
        ),
    );
    buildTrayColliders(RAPIER, world3d, body, alliance);
    const anchor = world3d.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(px, 0, BB3_HIVE_PIVOT_Z),
    );
    const data = RAPIER.JointData.revolute({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
    const joint = world3d.createImpulseJoint(data, anchor, body, true);
    const lim = (BB_HIVE_TILT_DEG * Math.PI) / 180;
    const unit = joint as unknown as { setLimits?: (min: number, max: number) => void };
    if (typeof unit.setLimits === 'function') unit.setLimits(-lim, lim);
    return { body, joint };
  }

  const body = world3d.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(px, 0, BB3_HIVE_PIVOT_Z)
      .setRotation({ x: 0, y: 0, z: 0, w: 1 }),
  );
  buildTrayColliders(RAPIER, world3d, body, alliance);
  return { body, joint: null };
}

function buildTrayColliders(
  RAPIER: Rapier3d,
  world3d: InstanceType<Rapier3d['World']>,
  body: InstanceType<Rapier3d['RigidBody']>,
  alliance: Alliance,
): void {
  // rotation is set through `setNextKinematicRotation` immediately after creation (engine.ts),
  // not baked into the desc, so the very first sync's "did the pose change outside the solve"
  // check has a real previous value to compare against.

  // COLLISION half-thickness is a hair thicker than the DOCUMENTED `BB3_HIVE_CELL_WALL` --
  // a 0.25-in wall meeting a 260 in/s sphere for CCD to catch is right at the edge of what a
  // single narrow-phase substep reliably resolves (measured: a bare 0.25in wall let a
  // full-speed shot straight through, wall and cell interior both, out the open far end).
  // The wall reads as 0.25in everywhere else in the sim (docs, the config constant, the
  // DERIVE containment box, which is unaffected -- see `hiveCellLocalBox`); only the
  // COLLIDER'S OWN skin is padded, which is a standard mitigation for a thin fast contact and
  // not a change to the hive's modelled geometry.
  const wallHalf = Math.max(BB3_HIVE_CELL_WALL / 2, 0.75);
  // TRAY-WALL RESTITUTION IS GOVERNED BY THE TRAY, NOT AVERAGED WITH THE ELEMENT'S OWN 0.45 --
  // `Min` combine (owner playtest fix, "balls spill out too easily"): every tray collider below
  // sets a LOW restitution and `CoefficientCombineRule.Min`, so `min(elementRestitution 0.45,
  // trayRestitution)` -- the LOWER number -- governs every element/tray contact, the same
  // direction `engine.ts`'s floor already takes for FRICTION (a `Min` rule there keeps a
  // 0-friction floor from fighting the drivetrain model). Before this fix no restitution combine
  // rule was set on any tray collider, so Rapier's own default (`Average`) applied: an element
  // landing on the 0.2-restitution floor bounced at `(0.45+0.2)/2 = 0.325`, which, combined with
  // the flat-floor bug of the same pass, was enough height and roll time for a resting element to
  // wander back out the always-open mouth.
  const TRAY_RESTITUTION_COMBINE = RAPIER.CoefficientCombineRule.Min;

  /**
   * ⚠️ EVERY TRAY COLLIDER CARRIES **ZERO DENSITY**, and that matters only under the DYNAMIC
   * tray -- where it matters completely. A Rapier collider's default density is 1, so twelve
   * facet slabs and a bar would hand this body several hundred pounds of mass on top of the
   * `BB3_HIVE_TRAY_MASS` the calibration was run against, from a number nobody chose. The mass
   * comes ENTIRELY from `setAdditionalMassProperties` (`hiveTrayMassProps`), the same discipline
   * `syncRobot` follows for a chassis. Harmless on the kinematic path, where mass is ignored.
   */
  const zeroDensity = <T extends { setDensity(d: number): T; setCollisionGroups(g: number): T }>(d: T): T =>
    d.setDensity(0).setCollisionGroups(GROUP_TRAY);

  /** per-hull surface, by the class `convert.py` stamped on it. The FLOOR is the one an element
   * rests on and rolls along, so it keeps the higher friction; the BACK is a dead stop (a POLLEN
   * meeting a padded cell wall, not a superball -- measured: at 0.2 restitution a shot that
   * reached the back wall bounced and rolled for 3+ seconds, long enough to drift back out the
   * open mouth it came in through). */
  const trayFriction = (name: string): number => (name.includes('_floor') ? 0.6 : 0.5);
  const trayRestitution = (name: string): number => (name.includes('_back') ? 0 : 0.15);

  const hulls = useFieldColliders() ? cadTrayHulls(alliance) : [];
  if (hulls.length > 0) {
    // THE CAD PATH: each hull is already a thin oriented slab sitting on its own CAD surface, in
    // this body's own un-tilted local frame. Straight to `convexHull`, no translation, no
    // rotation, no re-boxing -- which is the whole point: the collider the element rests on and
    // the triangle the GLB draws are the same plane.
    for (const h of hulls) {
      const desc = RAPIER.ColliderDesc.convexHull(new Float32Array(h.points));
      if (!desc) continue; // degenerate point set -- Rapier returns null rather than throwing
      world3d.createCollider(
        zeroDensity(desc)
          .setFriction(trayFriction(h.name))
          .setRestitution(trayRestitution(h.name))
          .setRestitutionCombineRule(TRAY_RESTITUTION_COMBINE),
        body,
      );
    }
    // THE PARTS BOLTED TO THE TRAY THAT THE EXPORTER FILED UNDER THE FRAME (`cadTrayRiders`): the
    // cross-braces and the pivot hardware. Same body, same zero density, so the see-saw's mass
    // and calibration do not move; they simply tip with the tray now, as they are drawn.
    for (const h of cadTrayRiders(alliance)) {
      const desc = RAPIER.ColliderDesc.convexHull(new Float32Array(h.points));
      if (!desc) continue;
      world3d.createCollider(
        zeroDensity(desc).setFriction(0.5).setRestitution(0.15).setRestitutionCombineRule(TRAY_RESTITUTION_COMBINE),
        body,
      );
    }
    return;
  }

  // THE FALLBACK PATH (CAD off, or an empty collider file): the Day 1 thin-walled box per cell --
  // floor, back, two sides, outer face open (the launch mouth / spill exit).
  for (const sideSign of [1, -1] as const) {
    const box = hiveCellLocalBox(sideSign, alliance);
    const cuboid = (xLo: number, xHi: number, vLo: number, vHi: number, wLo: number, wHi: number) =>
      zeroDensity(
        RAPIER.ColliderDesc.cuboid((xHi - xLo) / 2, (vHi - vLo) / 2, (wHi - wLo) / 2).setTranslation(
          (xLo + xHi) / 2,
          (vLo + vHi) / 2,
          (wLo + wHi) / 2,
        ),
      );
    world3d.createCollider(
      cuboid(-box.xHalf, box.xHalf, box.vMin, box.vMax, box.wMin, box.wMin + 2 * wallHalf)
        .setFriction(0.6)
        .setRestitution(0.15)
        .setRestitutionCombineRule(TRAY_RESTITUTION_COMBINE),
      body,
    );
    const innerV = sideSign > 0 ? box.vMin : box.vMax;
    const backA = innerV;
    const backB = innerV - sideSign * 2 * wallHalf;
    world3d.createCollider(
      cuboid(-box.xHalf, box.xHalf, Math.min(backA, backB), Math.max(backA, backB), box.wMin, box.wMax)
        .setFriction(0.5)
        .setRestitution(0)
        .setRestitutionCombineRule(TRAY_RESTITUTION_COMBINE),
      body,
    );
    for (const s of [1, -1] as const) {
      const xA = s * box.xHalf;
      const xB = s * (box.xHalf - 2 * wallHalf);
      world3d.createCollider(
        cuboid(Math.min(xA, xB), Math.max(xA, xB), box.vMin, box.vMax, box.wMin, box.wMax)
          .setFriction(0.5)
          .setRestitution(0.15)
          .setRestitutionCombineRule(TRAY_RESTITUTION_COMBINE),
        body,
      );
    }
  }
}

// ---- ROBOTS -----------------------------------------------------------------
// a dynamic COMPOUND, yaw-only: the bare frame `length x width x heightIn` plus the sweeper's
// side arms out to `bbIntakeReach`. See `chassis3dShapes`.

export function robotHeightIn(spec: RobotSpec): number {
  return spec.heightIn ?? 18;
}

/** one box of the chassis compound, in the robot frame (+x forward, +y left, z measured from
 * the chassis mid-height). */
export interface Chassis3dShape {
  cx: number;
  cy: number;
  /** box centre in z, relative to the CHASSIS mid-height (the body's own origin) */
  cz: number;
  hx: number;
  hy: number;
  hz: number;
  /**
   * this box's rotation, applied as `ColliderDesc.setRotation` in the body's own frame; absent
   * means axis-aligned (identity), true of every shape but the ramp's two rails
   * (`chassis3dReachShapes`). A bare "rotate about Y" scalar cannot say this box's tilt for a
   * FLANK mount, whose outward axis is world Y and whose tilt is therefore about world X — so
   * this is the fully composed quaternion (`quatMul(yawQuat(edge), pitchQuatY(angle))`),
   * computed once where the edge is known so a collider builder never has to re-derive it.
   */
  rot?: Quat;
  /**
   * ⚠️ **TRUE FOR THE RAMP'S CROSSBAR/RAILS AND FOR THE SIDE ROLLERS, ABSENT FOR EVERYTHING ELSE
   * `chassis3dReachShapes` BUILDS** (owner report 2026-09-20, ramp: "The pollen should be getting
   * intaked from the deployable ramp BECAUSE it collides with the ramp and slides down towards
   * the intake"; owner ruling 2026-09-20, side rollers: "it should also be colliding with
   * everything. It is a physical thing"). Both are hardware a POLLEN actually meets — a ramp is a
   * physical U-frame it rides down, a side roller is a real compliant wheel it presses against —
   * so both get the DEFAULT collision groups (meets an element too) in `reachColliderDesc`,
   * rather than `GROUP_POCKET` (statics/walls/robots only, same as the pocket filler). The ramp's
   * boxes also pick up the chassis boxes' own edge break (`chassisBoxDesc`) instead of a bare
   * square cuboid, so a ball meeting the bar behaves like meeting the frame rather than catching
   * a knife corner; a side roller's CYLINDER (see `shape` below) has no edges to break.
   */
  elementSolid?: boolean;
  /** a deployed RAMP's blade or rail: built in `GROUP_RAMP`, so it meets everything EXCEPT a
   * FLOWER's ring plates (`groups.ts` — the speculative-contact hop). */
  ramp?: boolean;
  /**
   * ⚠️ **A SIDE ROLLER IS A CYLINDER, EVERYTHING ELSE IS A BOX** (owner ruling 2026-09-20: "it
   * should be a collider... colliding with everything"). Absent (or `'box'`) means the existing
   * `cuboid(hx, hy, hz)`/`chassisBoxDesc` shape; `'cylinder'` means `hx` is the wheel's RADIUS
   * (`hy` unused, kept equal to `hx` so a caller that still reads it as a box degrades sanely)
   * and `hz` its half-height, with the axis rotated onto world Z regardless of `rot` — a
   * vertical-axis wheel's own axis never changes with the mount edge, unlike the ramp's tilted
   * rails, so `reachColliderDesc` composes the fixed Y→Z rotation with `rot` rather than folding
   * it in here.
   */
  shape?: 'box' | 'cylinder' | 'round';
}

/** the collider desc for a chassis MECHANISM shape: a cylinder (a turret's swept disc), a
 * ROUNDED box (a Box Tube tower — `BbMechEnvelope.narrow`), or the edge-broken box everything
 * else is. The authority and the FULL predictor both build through this. */
export function chassisMechDesc(RAPIER: Rapier3d, s: Chassis3dShape): InstanceType<Rapier3d['ColliderDesc']> {
  if (s.shape === 'cylinder') return RAPIER.ColliderDesc.cylinder(s.hz, s.hx).setRotation(CYL_AXIS_Z);
  if (s.shape === 'round') {
    const r = Math.min(BB3_LIFT_EDGE_R, s.hx / 2, s.hy / 2, s.hz / 2);
    return RAPIER.ColliderDesc.roundCuboid(s.hx - r, s.hy - r, s.hz - r, r);
  }
  return chassisBoxDesc(RAPIER, s.hx, s.hy, s.hz);
}

/**
 * ⚠️ **THE 3D CHASSIS IS A COMPOUND WITH AN OPEN INTAKE MOUTH** — the bare frame plus the
 * sweeper's two SIDE ARMS per mounted edge, and it is the SAME shape list `bbRobotSolids`
 * (`robot.ts`) hands the 2D artifact solve. Derived from `bbMouths` here too, so the drawn
 * mouth, the 2D collision geometry and the 3D collider cannot drift apart.
 *
 * IT USED TO BE ONE `robotExtents` CUBOID, which is the 2D SOLVE's footprint — correct for
 * robot-vs-wall and robot-vs-robot (that is the bug it was introduced to fix; see the note in
 * `addChassisCollider`) and wrong for an ELEMENT, because it fills the mouth with solid. With a
 * closed mouth an element can never get nearer than the roller line, so `bbIntakeAct` had
 * nothing to draw it in ACROSS: measured on the intake lane's scenario set, a six-element
 * cluster gave 10/18 and a strafe past a line 1/4, and every element near the mouth's lateral
 * edge was deflected by the collider corner before the funnel reached it.
 *
 * ⚠️ **THE ARM TIPS END EXACTLY WHERE `robotExtents` ENDED** (`hl + reach` on a mounted end,
 * `hw + reach` on a mounted flank), so flat-wall contact distance, a wall-flush start position
 * and start legality do not move — they are what the single cuboid existed for. What changes is
 * only the POCKET between the arms, which is now open to an element and closed to nothing else:
 * a wall, another chassis and the HIVE underside all still meet the same outermost surfaces at
 * the same distances and the same height.
 *
 * MASS AND INERTIA ARE UNTOUCHED: every collider is built at density 0 and the body's mass
 * properties are set explicitly each tick (`syncRobot`), so drive parity with 2D is not a
 * function of how many boxes the compound has.
 */
/** the compound's own plan envelope (`hl`/`hw` grown by `bbIntakeReach` on each MOUNTED edge),
 * which is `robotExtents` by construction — see `chassis3dShapes`' own note on why a mechanism
 * shape is clamped into it. */
export function chassis3dPlanEnvelope(spec: RobotSpec): { front: number; back: number; left: number; right: number } {
  const hl = spec.length / 2;
  const hw = spec.width / 2;
  const ex = { front: hl, back: hl, left: hw, right: hw };
  const reach = bbIntakeReach(spec);
  if (reach > 1e-6) for (const m of bbMouths(spec)) ex[m.edge] = (m.edge === 'front' || m.edge === 'back' ? hl : hw) + reach;
  return ex;
}

/**
 * THE TALL SHAPES — one per STANDING mechanism this build draws (`bbMechEnvelopes`, `config.ts`,
 * whose header carries the drawn measurements and what `heightIn` means now), each from the deck
 * to that mechanism's own drawn top and over its own drawn footprint, CLAMPED into `ex`.
 *
 * Exported because BOTH chassis builders take it: this file's compound and the FULL PREDICTOR's
 * otherwise-single cuboid (`predict.ts` `fitChassis`). The predictor is allowed to differ about
 * the MOUTH POCKET and is NOT allowed to differ about the height profile — the whole point of
 * the profile is which contacts happen at all, and a predictor that thinks it is 14 in tall
 * everywhere predicts the catch the owner reported while the authority slides past it.
 */
export function chassis3dMechShapes(
  spec: RobotSpec,
  heightIn: number,
  ex: { front: number; back: number; left: number; right: number } = chassis3dPlanEnvelope(spec),
): Chassis3dShape[] {
  const half = heightIn / 2;
  const out: Chassis3dShape[] = [];
  for (const e of bbMechEnvelopes(spec, heightIn)) {
    // a mechanism stands on the deck unless it says otherwise (the Box Tube's column stands on
    // its own base box); a solid a low declared height has capped away entirely builds nothing
    if (e.bottom !== undefined && e.top <= e.bottom + 1e-6) continue;
    const lo = e.bottom ?? Math.min(BB_DECK_Z, e.top - 0.1);
    const hz = Math.max(1e-3, (e.top - lo) / 2);
    const cz = -half + lo + hz;
    if (e.r !== undefined) {
      const r = Math.max(1e-3, Math.min(e.r, ex.front - e.cx, ex.back + e.cx, ex.left - e.cy, ex.right + e.cy));
      out.push({ cx: e.cx, cy: e.cy, cz, hx: r, hy: r, hz, shape: 'cylinder' });
    } else {
      const x0 = Math.max(e.cx - (e.hx ?? 0), -ex.back);
      const x1 = Math.min(e.cx + (e.hx ?? 0), ex.front);
      const y0 = Math.max(e.cy - (e.hy ?? 0), -ex.right);
      const y1 = Math.min(e.cy + (e.hy ?? 0), ex.left);
      const box: Chassis3dShape = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, cz, hx: Math.max(1e-3, (x1 - x0) / 2), hy: Math.max(1e-3, (y1 - y0) / 2), hz };
      if (e.narrow) box.shape = 'round';
      out.push(box);
    }
  }
  return out;
}

export function chassis3dShapes(spec: RobotSpec, heightIn: number): Chassis3dShape[] {
  const hl = spec.length / 2;
  const hw = spec.width / 2;
  const half = heightIn / 2;
  /**
   * ⚠️ **THE LOW BODY STOPS AT THE DRAWN CHASSIS, NOT AT `heightIn`** — the fix for the owner's
   * invisible corner (`BB3_CHASSIS_TOP_Z`'s own header in `config.ts` has the repro and the
   * measurement). The box is still centred on the chassis mid-height's own origin (`cz` is
   * measured from `heightIn/2` above the floor and nothing about the BODY's bookkeeping moves:
   * `syncRobot` still translates to `z + heightIn/2` and `readback` still subtracts
   * `builtHeight/2`), so its BOTTOM is still exactly the chassis floor at `-half` and only its
   * TOP came down.
   */
  const bodyTop = legacyPrismOverride ? heightIn : Math.min(BB3_CHASSIS_TOP_Z, heightIn);
  const bodyHz = bodyTop / 2;
  const bodyCz = -half + bodyHz;
  const out: Chassis3dShape[] = [{ cx: 0, cy: 0, cz: bodyCz, hx: hl, hy: hw, hz: bodyHz }];
  const reach = bbIntakeReach(spec);
  /**
   * THE COMPOUND'S OWN PLAN ENVELOPE — `hl`/`hw` grown by `reach` on each MOUNTED edge, which is
   * `robotExtents` by construction (it is the same arithmetic the arms below are built to).
   *
   * ⚠️ **A MECHANISM SHAPE MAY NOT GROW IT.** The drawn turret head overhangs its own rail by up
   * to 1.45 in on an EDGE or CORNER mount whose edge carries no intake reach — genuinely drawn,
   * and still not allowed to be solid there: `robotExtents` is the 2D solve's footprint, the
   * wall-flush START POSITIONS are seated on it, `startLegal` judges it and the 2D/3D parity
   * checks pin it, so a chassis that got 1.45 in wider in 3D alone would spawn inside a wall.
   * The head is therefore CLAMPED INTO the envelope (a cylinder by its radius, a dumper's box by
   * its faces) and the overhang is a DRAWN PART OUTSIDE THE COLLIDER — the harmless direction,
   * the same call the mid-throw dumper bucket makes (`BB3_DUMPER_TOP_Z`).
   */
  const ex = chassis3dPlanEnvelope(spec);
  // ...and one TALL shape per STANDING mechanism, over that mechanism's own drawn footprint.
  // They go in `chassis3dShapes` rather than beside the pocket filler because this list is WHAT
  // AN ELEMENT MEETS and a turret/dumper is solid to one — which is also what the floor-to-roof
  // prism they replace was.
  if (!legacyPrismOverride) out.push(...chassis3dMechShapes(spec, heightIn, ex));
  if (reach <= 1e-6) return out;
  // never thicker than the frame it is bolted to — `bbRobotSolids`' own clamp, for the same
  // reason (a degenerate or inverted box is a collider Rapier cannot build).
  const t = Math.max(1e-3, Math.min(INTAKE_RAIL_T, hw / 2, hl / 2));
  /**
   * ⚠️ **THE POCKET IS OPEN ONLY BELOW ELEMENT HEIGHT, AND THE LINTEL ABOVE IT IS WHAT KEEPS
   * EVERY OTHER CONTACT WHERE IT WAS.** The mouth is an OVER-BUMPER intake: the roller bar spans
   * it at roller height and an element rolls in UNDER the bar — which is exactly what
   * `bbRobotSolids` says in 2D ("THE MOUTH ITSELF IS OPEN... a POLLEN rolls in under it").
   *
   * Leaving the pocket open all the way up was measured and is wrong in a way that has nothing
   * to do with elements: with only two thin arms out front, the FRAME face sits `reach` further
   * back than the old cuboid's did, so a robot driving at a low field static reached 3 in past
   * where it used to stop, caught the static's top edge on its frame's bottom edge and CLIMBED
   * it — parked 2.14 in in the air, stalled, for the rest of the match (scenario `f turn onto a
   * ball`, 3D: captured at tick 24 before, never after).
   *
   * With the lintel, anything taller than `BB3_MOUTH_SLOT_Z` — a wall, another robot, the HIVE
   * structure, a FLOWER — meets the same outermost surface at the same distance as the single
   * `robotExtents` cuboid did, and only an ELEMENT fits through the slot.
   */
  // ⚠️ THE LINTEL NOW ENDS AT THE DRAWN CHASSIS TOO — it spans the slot to `bodyTop`, not the
  // slot to `heightIn`. Its job is unchanged (only an ELEMENT fits through the mouth's pocket;
  // a wall, a robot, the HIVE and a FLOWER all meet it at the arm tips' own distance) because
  // everything it has to stop is met by the LOW BODY at exactly the same plan extent.
  const slot = Math.min(BB3_MOUTH_SLOT_Z, bodyTop - 0.1);
  const lintelHz = Math.max(1e-3, (bodyTop - slot) / 2);
  const lintelCz = -half + slot + lintelHz;
  for (const m of bbMouths(spec)) {
    if (m.edge === 'front' || m.edge === 'back') {
      const cx = (m.edge === 'front' ? 1 : -1) * (hl + reach / 2);
      for (const s of [1, -1]) {
        const outer = s > 0 ? m.y1 : m.y0;
        out.push({ cx, cy: outer - (s * t) / 2, cz: bodyCz, hx: reach / 2, hy: t / 2, hz: bodyHz });
      }
      out.push({ cx, cy: (m.y0 + m.y1) / 2, cz: lintelCz, hx: reach / 2, hy: (m.y1 - m.y0) / 2, hz: lintelHz });
    } else {
      const cy = (m.edge === 'left' ? 1 : -1) * (hw + reach / 2);
      for (const s of [1, -1]) {
        const outer = s > 0 ? m.x1 : m.x0;
        out.push({ cx: outer - (s * t) / 2, cy, cz: bodyCz, hx: t / 2, hy: reach / 2, hz: bodyHz });
      }
      out.push({ cx: (m.x0 + m.x1) / 2, cy, cz: lintelCz, hx: (m.x1 - m.x0) / 2, hy: reach / 2, hz: lintelHz });
    }
  }
  return out;
}

/**
 * ⚠️ **THE POCKET FILLER — WHAT MAKES THE HITBOX A RECTANGLE TO EVERYTHING BUT AN ELEMENT.**
 * Owner report, 2026-09-19: *"The intake plates stick out further than the intake rollers so the
 * hitboxes are weird. All you probably need to do is shrink the intake plate or add a bracing
 * across the two intake plates in the front to make the whole thing just have a rectangular
 * hitbox."* This is that bracing, in the solve. It is deliberately NOT part of
 * `chassis3dShapes`, because that list is **what an ELEMENT meets** — `birthClear` and the
 * mouth-is-open check read it, and both would be wrong if the filler were in it.
 *
 * ⚠️ **THE COMPOUND IS A FORK, AND A FORK CATCHES THINGS A BOX DOES NOT.** Arms + lintel leave
 * exactly one hole in the outer prism: between the arm tips, in front of the frame face, floor to
 * `BB3_MOUTH_SLOT_Z`. Everything taller meets the lintel, so the hole is invisible to a wall, a
 * FLOWER column or another robot (`BB3_HEIGHT_MIN` is 12 in). What fits is an element — and the
 * EIGHT hive A-frame base bars and feet, 2.13–2.15 in tall against a 3.6-in slot. Measured
 * driving at the blue frame bar's low-y end over 9 lateral offsets x 5 approach angles: 3D put
 * the arm tips **5.67 in** past the bar's near face — the bar is 1.98 in wide, so the chassis
 * drove clean OVER a bar it is supposed to stop at — and took **141°** of yaw doing it, against
 * the 2D pipeline's 1.99 in and 18°. 2D never had this bug and that is not luck: its
 * robot-vs-static collider is the single `robotExtents` box (`solveRobots`, `physicsEngine.ts`),
 * i.e. a rectangle, which is also why it tolerated five times the corner graze.
 *
 * The filler spans arm to arm, the frame face out to the arm tips, the chassis floor up to the
 * lintel — so frame + arms + lintel + filler is ONE rectangular prism to a static, a wall and
 * another robot, and an element still sees the open pocket it needs. Density 0 like the rest,
 * and no new constant: every dimension is `bbMouths` and `BB3_MOUTH_SLOT_Z`, already the
 * authority for the mouth.
 *
 * ⚠️ **IT COSTS ~5 % OF A 2v2 `step3d`, AND THAT COST IS CONTACTS, NOT BOOKKEEPING.** Measured
 * over 8 PAIRED alternating rounds: without it 0.763 ms, with it 0.800 (**1.049x**). Two extra
 * colliders per robot in a group that meets NOTHING measure 0.960x, i.e. an extra collider is
 * free — what this one buys is real manifolds against the low statics the fork used to drive
 * through. Two ways of getting it back were measured and BOTH REJECTED: giving the tile plane
 * its own group bit and filtering it out of the filler does nothing (1.098x on the noisier
 * four-round run, i.e. no effect), and lifting the box 0.15 in off the tiles measures 1.030x —
 * a 1.9-point difference inside the run-to-run spread, bought by re-opening the hole to
 * anything under 0.15 in tall when the shortest static a robot can reach is **0.240 in**. The
 * room-tick A/B sees none of it: paired against a 2v2 Chain Reaction room, 1.445 before and
 * 1.434 after.
 */
export function chassis3dPocketShapes(spec: RobotSpec, heightIn: number): Chassis3dShape[] {
  const reach = bbIntakeReach(spec);
  if (reach <= 1e-6) return [];
  const hl = spec.length / 2;
  const hw = spec.width / 2;
  const half = heightIn / 2;
  const slot = Math.min(BB3_MOUTH_SLOT_Z, heightIn - 0.1);
  // the pocket floor is the chassis floor; its ceiling is the lintel's own underside, so the two
  // meet exactly and the prism has no seam an edge can be generated on.
  const cz = -half + slot / 2;
  const hz = slot / 2;
  const out: Chassis3dShape[] = [];
  for (const m of bbMouths(spec)) {
    if (m.edge === 'front' || m.edge === 'back') {
      const cx = (m.edge === 'front' ? 1 : -1) * (hl + reach / 2);
      out.push({ cx, cy: (m.y0 + m.y1) / 2, cz, hx: reach / 2, hy: (m.y1 - m.y0) / 2, hz });
    } else {
      const cy = (m.edge === 'left' ? 1 : -1) * (hw + reach / 2);
      out.push({ cx: (m.x0 + m.x1) / 2, cy, cz, hx: (m.x1 - m.x0) / 2, hy: reach / 2, hz });
    }
  }
  return out;
}

/**
 * DUPLICATED from `scene/renderRobots.ts`'s `BB_PLATE_T` (0.22, the outer chassis plate's own
 * thickness) — `sim3d/` may not import `scene/` (the lazy-chunk boundary the RENDER lane
 * enforces: the physics chunk must not drag `three` in), so the physics side keeps its own copy
 * of the one number the drawn ramp rails' inboard offset is built from
 * (`BB_INTAKE_ARM_INSET = BB_PLATE_T + 0.06`, the clearance a side arm bolts inboard of the
 * frame by). The RENDER lane's own check asserts the two agree rather than trusting the copy.
 */
const BB_PLATE_T_DUP = 0.22;
const BB_INTAKE_ARM_INSET_DUP = BB_PLATE_T_DUP + 0.06;

/** the ramp's rails sit inboard of the intake's own side arms, same formula as
 * `scene/renderRobots.ts`'s `railY` (see `BB_INTAKE_ARM_INSET_DUP`'s own comment). `half` is the
 * mouth's own half-width (`mouthAxes(...).half`). */
function rampRailY(half: number): number {
  return half - BB_INTAKE_ARM_INSET_DUP - INTAKE_RAIL_T - 0.15;
}

/**
 * ⚠️ **THE ARCHETYPE REACH HARDWARE, SOLID** (owner, 2026-09-20: "It should be a collider.").
 * `chassis3dShapes` is what an ELEMENT meets and stays untouched by this; this is what a WALL,
 * another ROBOT and a FLOWER's low-plate opening meet instead — the same hardware
 * `bbFlowerReachOf` already credits for reaching a FLOWER's retrieval opening (`config.ts`'s
 * "ROBOT — intake ARCHETYPES"), now standing the chassis off a wall the same way it stands off a
 * POLLEN. `sweeper` returns nothing: its roller never passes the plate edge and has no reach to
 * make solid (`bbFlowerReachOf('sweeper', …)` is `null`, always).
 *
 * Per mouth, placed via `mouthAxes` — the SAME (n outward, p lateral, uOut tip-line) frame
 * `bbFlowerAtIntake` gates against, so a flank mount gets exactly the rotated placement an end
 * mount gets without a second derivation: a point at `(u, v)` in that frame is `u·n + v·p` in the
 * robot frame, and because `n`/`p` are always exact ±1/0 world-axis vectors, the same formula also
 * picks which of a box's own `hx`/`hy` is "along the mouth's outward axis" — `0.15·|n.x| +
 * railY·|p.x|` reads as `0.15` on an end mount (`n.x = ±1`) and `railY` on a flank one, with no
 * per-edge branch.
 *
 *  · `siderollers` — two boxes standing in for the vertical-axis wheels (hx = hy = R, so the
 *    axis-aligned box is rotation-invariant about z and needs no `rot`) at
 *    `u = uOut + BB_SIDE_ROLLER_OUT`, `v = ±bbSideRollerY(axes.half)` (owner, 2026-09-20: "situated
 *    on the edges of the robot, not near the center" — the mouth's OWN half-width, not a fixed
 *    offset, so the wheel sits at the mouth's own edge on every chassis size), centred at
 *    `BB_SIDE_ROLLER_Z`.
 *  · `ramp`, only once `rampReady` (`bbRampSettled`) — the WEDGE (two boxes now, `rampWedgeSegment`
 *    below: leading-edge→crest at `BB_RAMP_WEDGE_RISE_ANGLE`, crest→drop at
 *    `-BB_RAMP_WEDGE_DROP_ANGLE`) plus the two rails, neither axis-aligned: both tilt in the
 *    (outward, up) plane — world (X, Z) for an end mount, world (Y, Z) for a flank one. One
 *    quaternion expresses both: yaw the mount's own edge onto the world axes, then pitch about
 *    the (now correctly placed) lateral axis (`quatMul(yawQuat(EDGE_ANGLE[edge]),
 *    pitchQuatY(angle))`) — derived and verified against the four edges by hand (front: pure Y
 *    pitch; the others: the composed quaternion maps the mouth-local outward+up plane onto the
 *    correct world plane in every case), computed once per box where the edge is known.
 */

/**
 * one box of the ramp, from `(u0, z0)` to `(u1, z1)` in the mouth frame — shared by
 * `chassis3dReachShapes` (the settled, `rampReady` collider) below. `angle` is the `pitchQuatY`
 * argument that makes the box's own long axis run between the two points; the sign is part of the
 * CALLER's own derivation (`config.ts`'s "THE DEPLOYABLE RAMP" works all three out), not
 * re-derived here, so this stays a plain box-between-two-points helper with no trig of its own.
 *
 * ⚠️ **THE TWO POINTS ARE THE TOP SURFACE, AND THE BOX HANGS BELOW THEM.** It used to CENTRE the
 * box on the line, which is the same thing as saying the ramp's real lowest point is
 * `2·thick·cos(angle)` under the number `config.ts` names — and that is precisely what jammed the
 * first wedge on the FLOWER's lower ring plate (0.3067 against a 0.354 plate top; the
 * `intersectionsWithShape` run that named the collider is in that section's header). Hanging the
 * box below its own profile line makes `BB_RAMP_LEAD_Z`/`BB_RAMP_CREST_Z`/`BB_RAMP_DECK_Z` mean
 * what they say — the surface a POLLEN rides on — and puts the ramp's underside where
 * `BB_RAMP_FLOOR_Z` says, which is the number that has to clear the plate.
 */
function rampWedgeSegment(
  place: (u: number, v: number) => { cx: number; cy: number },
  edge: BbEdge,
  half: number,
  railY: number,
  u0: number,
  z0: number,
  u1: number,
  z1: number,
  angle: number,
): Chassis3dShape {
  const hx = Math.sqrt((u1 - u0) * (u1 - u0) + (z1 - z0) * (z1 - z0)) / 2;
  // the "down" perpendicular of the segment, one half-thickness of it: the box's own centre sits
  // there, so its TOP face lands on the (u0,z0)–(u1,z1) line exactly.
  const du = (u1 - u0) / (2 * hx);
  const dz = (z1 - z0) / (2 * hx);
  const mid = place((u0 + u1) / 2 + BB_RAMP_WEDGE_THICK * dz, 0);
  return {
    cx: mid.cx,
    cy: mid.cy,
    cz: (z0 + z1) / 2 - BB_RAMP_WEDGE_THICK * du - half,
    hx,
    hy: railY,
    hz: BB_RAMP_WEDGE_THICK,
    rot: quatMul(yawQuat(EDGE_ANGLE[edge]), pitchQuatY(angle)),
    elementSolid: true,
    ramp: true,
  };
}

export function chassis3dReachShapes(spec: RobotSpec, heightIn: number, rampReady: boolean): Chassis3dShape[] {
  const kind = bbIntakeKindOf(spec);
  if (kind === 'sweeper') return [];
  const hl = spec.length / 2;
  const hw = spec.width / 2;
  const half = heightIn / 2;
  const out: Chassis3dShape[] = [];
  for (const m of bbMouths(spec)) {
    const axes = mouthAxes(m, hl, hw);
    const { n, p, uOut } = axes;
    const place = (u: number, v: number): { cx: number; cy: number } => ({
      cx: u * n.x + v * p.x,
      cy: u * n.y + v * p.y,
    });
    if (kind === 'siderollers') {
      const wheelY = bbSideRollerY(axes.half);
      for (const s of [1, -1] as const) {
        const { cx, cy } = place(uOut + BB_SIDE_ROLLER_OUT, s * wheelY);
        out.push({
          cx,
          cy,
          cz: BB_SIDE_ROLLER_Z - half,
          hx: BB_SIDE_ROLLER_R,
          hy: BB_SIDE_ROLLER_R,
          hz: BB_SIDE_ROLLER_H / 2,
          shape: 'cylinder',
          elementSolid: true,
        });
      }
    } else if (kind === 'ramp' && rampReady) {
      const railY = rampRailY(axes.half);
      // the PLOW: three boxes, rail-to-rail wide (`railY`) — the LIP→CREST rise, the CREST→DROP
      // fall, and the level DECK that carries a lifted POLLEN the rest of the way to the mouth.
      // See `config.ts`'s "THE DEPLOYABLE RAMP" for the four named points (`uOut` + each is a
      // mouth-frame `u`), why the boxes hang BELOW them, and why this is not a `convexHull`.
      // `rampWedgeSegment` composes the SAME `pitchQuatY` the rails use, at each segment's own
      // angle rather than the rail's.
      out.push(
        rampWedgeSegment(place, m.edge, half, railY, uOut + BB_RAMP_IN, BB_RAMP_DECK_Z, uOut + BB_RAMP_OUT, BB_RAMP_DECK_Z, 0),
      );
      // the two rails: midpoint between the pivot (u = uOut − BB_RAMP_PIVOT_BACK, z
      // BB_RAMP_PIVOT_Z) and the tip — now the wedge's own LEADING EDGE (u = uOut + BB_RAMP_OUT,
      // z BB_RAMP_TIP_Z, which `config.ts` solves to equal `BB_RAMP_LEAD_Z`) — tilted about the
      // mouth's own lateral axis to connect the two.
      const uMid = uOut + (BB_RAMP_OUT - BB_RAMP_PIVOT_BACK) / 2;
      const zMid = (BB_RAMP_PIVOT_Z + BB_RAMP_TIP_Z) / 2;
      const rot = quatMul(yawQuat(EDGE_ANGLE[m.edge]), pitchQuatY(BB_RAMP_ANGLE));
      for (const s of [1, -1] as const) {
        const rail = place(uMid, s * railY);
        out.push({
          cx: rail.cx,
          cy: rail.cy,
          cz: zMid - half,
          hx: BB_RAMP_L / 2,
          hy: 0.125,
          hz: 0.25,
          rot,
          elementSolid: true,
          ramp: true,
        });
      }
    }
  }
  return out;
}

/**
 * ⚠️ **THE RAMP MID-SWING, AT WHATEVER ANGLE `e` NAMES** (owner, 2026-09-20: "if it collides with
 * the flower or any non-moving solid thing as it is being deployed, it should fold back up...
 * same with un-deploying"). `chassis3dReachShapes`'s ramp branch is this function's `e = 1`
 * special case — folded (`e = 0`) contributes nothing there because a folded ramp is not solid to
 * anything, but a SWINGING one still has to be tested against statics on the way through, so this
 * builds the same two rails and crossbar at ANY progress `e` in `[0, 1]` (`bbRampSwingProgress`),
 * for `bbRampSwingStep3d`'s own collision query alone — it is never added to a body, only used to
 * ask Rapier "does a shape like this one overlap a static right here".
 *
 * ONE PIVOT, ONE SWEEP ANGLE. The rail direction is `φ(e) = e·(π/2 + BB_RAMP_ANGLE)` measured
 * from STRAIGHT UP (`φ = 0`, the folded pose — the rails stand round the barrel) toward the
 * deployed direction (`φ = π/2 + BB_RAMP_ANGLE`, outward and `BB_RAMP_ANGLE` below level) — a
 * pivot-relative polar sweep, not a linear interpolation of the two endpoints, because the rail
 * is a RIGID rod of fixed length `BB_RAMP_L` rotating about a fixed pivot, not a point sliding in
 * a straight line between two poses. **Verified to reduce EXACTLY to `chassis3dReachShapes`'s own
 * numbers at `e = 1`**: `sin(φ) = cos(BB_RAMP_ANGLE)`, `cos(φ) = −sin(BB_RAMP_ANGLE)` there, which
 * algebraically collapse this function's `tipU`/`tipZ`/`midU`/`midZ` to that function's
 * `uOut + BB_RAMP_OUT`/`BB_RAMP_TIP_Z`/`uMid`/`zMid` term for term.
 *
 * ⚠️ **THE WEDGE IS ONE CONSERVATIVE BOUNDING BOX AT EVERY `e`, NOT TWO TILTED ONES** — a second
 * simplification, replacing the old "kept AXIS-ALIGNED" one now that the crossbar is a wedge with
 * its own two-segment shape. Reproducing the wedge's exact tilt mid-swing would need the rise/drop
 * angles composed with the rail's own swinging tilt — two more quaternions for a guard that only
 * has to catch an overlap, not model one. Instead this walks the SAME "tip" point the old crossbar
 * tracked — now the ramp's own LIP, which is the rail's tip by construction (`config.ts`'s "THE
 * DEPLOYABLE RAMP") — and wraps it in a box sized to the ramp's full SETTLED extent: back to the
 * deck's inboard end (`BB_RAMP_OUT − BB_RAMP_IN` behind the tip) and from the ramp's own
 * underside (`BB_RAMP_FLOOR_Z`) up to the crest. A box that size, carried rigidly with the tip through the
 * whole swing, is a SUPERSET of the true wedge at every `e` in the (outward, up) plane the swing
 * moves in (the true wedge's own extent is never larger than its settled one, only differently
 * oriented within it), so a reversal can fire slightly early but never miss a real overlap.
 * **Verified to reduce EXACTLY to `chassis3dReachShapes`'s own footprint at `e = 1`**: the box's
 * own outward face sits at the tip (the leading edge), matching the wedge's own outermost point.
 */
export function bbRampSwingShapes(spec: RobotSpec, heightIn: number, e: number): Chassis3dShape[] {
  if (bbIntakeKindOf(spec) !== 'ramp') return [];
  const hl = spec.length / 2;
  const hw = spec.width / 2;
  const half = heightIn / 2;
  const out: Chassis3dShape[] = [];
  const phi = e * (Math.PI / 2 + BB_RAMP_ANGLE);
  const sinPhi = dsin(phi);
  const cosPhi = dcos(phi);
  // the wedge's own settled footprint, relative to its leading edge (the tip): how far back the
  // deck's inboard end sits, the z band the blade occupies, and that band's own centre offset
  // from the tip's settled height (`BB_RAMP_DECK_Z`) — a CONSTANT added to the swinging `tipZ`
  // below, so the box tracks the fold/deploy motion rather than sitting at one fixed z.
  const wedgeBackU = BB_RAMP_OUT - BB_RAMP_IN;
  const wedgeZLo = BB_RAMP_FLOOR_Z;
  const wedgeZHi = BB_RAMP_DECK_Z;
  const wedgeZOffset = (wedgeZLo + wedgeZHi) / 2 - BB_RAMP_DECK_Z;
  for (const m of bbMouths(spec)) {
    const axes = mouthAxes(m, hl, hw);
    const { n, p, uOut } = axes;
    const place = (u: number, v: number): { cx: number; cy: number } => ({ cx: u * n.x + v * p.x, cy: u * n.y + v * p.y });
    const pivotU = uOut - BB_RAMP_PIVOT_BACK;
    const tipU = pivotU + BB_RAMP_L * sinPhi;
    const tipZ = BB_RAMP_PIVOT_Z + BB_RAMP_L * cosPhi;
    const midU = pivotU + (BB_RAMP_L / 2) * sinPhi;
    const midZ = BB_RAMP_PIVOT_Z + (BB_RAMP_L / 2) * cosPhi;
    const railY = rampRailY(axes.half);
    const rot = quatMul(yawQuat(EDGE_ANGLE[m.edge]), pitchQuatY(phi - Math.PI / 2));
    for (const s of [1, -1] as const) {
      const rail = place(midU, s * railY);
      out.push({ cx: rail.cx, cy: rail.cy, cz: midZ - half, hx: BB_RAMP_L / 2, hy: 0.125, hz: 0.25, rot });
    }
    const boxU = tipU - wedgeBackU / 2;
    const boxZ = tipZ + wedgeZOffset;
    const wedge = place(boxU, 0);
    out.push({
      cx: wedge.cx,
      cy: wedge.cy,
      cz: boxZ - half,
      hx: (wedgeBackU / 2) * Math.abs(n.x) + railY * Math.abs(p.x),
      hy: (wedgeBackU / 2) * Math.abs(n.y) + railY * Math.abs(p.y),
      hz: (wedgeZHi - wedgeZLo) / 2,
    });
  }
  return out;
}

/**
 * ⚠️ **DOES THE RAMP, MID-SWING AT `e`, TOUCH A STATIC?** (owner, 2026-09-20 — the swing-guard
 * rule; see `bbRampSwingShapes`'s own header). A free-floating Rapier shape-intersection query —
 * NOT a collider on any body, so it costs nothing on ticks that are not mid-swing and never
 * appears in a contact manifold — for each of `bbRampSwingShapes`' boxes, placed in WORLD space
 * off the robot's OWN JSON pose (`pos`/`heading`/`z`; this runs at stage 11, after readback, so
 * that pose is the step's own final answer) rather than a re-read of the Rapier body.
 *
 * `filterPredicate` is `collider.parent()?.isFixed()`, which is exactly "STATICS ONLY" per the
 * owner's own wording: walls, the flower plates/supports and the hive FRAME are fixed bodies
 * (`buildStatics3d`); the hive TRAY (kinematic or dynamic), every robot and every element are
 * not, and none of them should be able to block a swing — a ramp folding past another robot is
 * a foul question (`bbRobotSolids`/robot-robot contact), not this guard's.
 */
export function rampSwingBlocked(
  RAPIER: Rapier3d,
  world3d: InstanceType<Rapier3d['World']>,
  spec: RobotSpec,
  heightIn: number,
  pos: { x: number; y: number },
  chassisBottomZ: number,
  heading: number,
  e: number,
  blockHandles: ReadonlySet<number> = new Set(),
): boolean {
  const shapes = bbRampSwingShapes(spec, heightIn, e);
  if (shapes.length === 0) return false;
  const bodyRot = yawQuat(heading);
  const cosH = dcos(heading);
  const sinH = dsin(heading);
  /**
   * ⚠️ WHAT STOPS A SWING: A FIXED BODY, **OR ANOTHER ROBOT**.
   *
   * It used to be `isFixed()` alone — the guard was written to the owner's first wording ("any
   * non-moving solid thing"), and a chassis is not fixed, so the query looked straight through
   * one. Owner, 2026-09-21: "I am able to deploy the ramp into another robot and phase." The
   * deploy was allowed with the blade already inside the other machine, and the solver then had
   * two overlapping solids to separate from the inside, which reads as phasing.
   *
   * `blockHandles` is the OTHER robots' body handles, passed by the caller — never this robot's
   * own, whose chassis the blade shares a body with and would hit on every single tick, and
   * never an ELEMENT's, because sweeping POLLEN is the entire job of the ramp. That makes the
   * rule exactly "solid world, plus other people's robots" and nothing wider.
   */
  const isStatic = (c: { parent(): { isFixed(): boolean; handle: number } | null }): boolean => {
    const p = c.parent();
    if (!p) return false;
    return p.isFixed() || blockHandles.has(p.handle);
  };
  for (const s of shapes) {
    const shapePos = {
      x: pos.x + s.cx * cosH - s.cy * sinH,
      y: pos.y + s.cx * sinH + s.cy * cosH,
      z: chassisBottomZ + heightIn / 2 + s.cz,
    };
    const shapeRot = s.rot ? quatMul(bodyRot, s.rot) : bodyRot;
    const shape = new RAPIER.Cuboid(s.hx, s.hy, s.hz);
    let hit = false;
    world3d.intersectionsWithShape(
      shapePos,
      shapeRot,
      shape,
      () => {
        hit = true;
        return true; // keep scanning; only the boolean matters
      },
      undefined,
      undefined,
      undefined,
      undefined,
      isStatic,
    );
    if (hit) return true;
  }
  return false;
}

/**
 * ⚠️ **THE ONE CHASSIS-COLLIDER BUILDER FOR THE AUTHORITY.** `engineImpl.ts`'s `syncRobot` calls
 * it twice — at body creation and again at the R102 deploy edge — and nothing else builds the
 * compound. It lives here rather than in `engineImpl.ts` so the shape is one function away from
 * `chassis3dShapes`, which is also what `bbRobotSolids` (2D) draws from.
 *
 * The FULL PREDICTOR (`predict.ts`) does NOT call it, on purpose and by measurement: it keeps
 * one `robotExtents` cuboid, because the compound doubled its forty-tick reconcile past
 * `PREDICT_FULL_BUDGET_MS` (see the note above `makeRobotBody` there). It shares only
 * `clearChassis3dColliders` below, for the same deploy-edge re-fit.
 *
 * `heightIn` is the caller's, and it is `bbHeightNow(world, spec)` — never
 * `robotHeightIn(spec)`, which is the deployed height whatever the phase says. A collider
 * cannot be resized in place, so a caller that survives the deploy edge re-builds (see
 * `Engine3d.robotHeights` for why the height built has to be RECORDED, not recomputed).
 *
 * Every box is DENSITY 0: mass and inertia are written explicitly by whoever owns the body, so
 * the compound's box count can never move drive feel.
 *
 * `rampReady` is `bbRampSettled(r, world.time)` — SEE `chassis3dReachShapes`'s own header for
 * the archetype reach hardware this now adds, in `GROUP_POCKET` alongside the pocket filler.
 */
export function addChassis3dColliders(
  RAPIER: Rapier3d,
  world3d: InstanceType<Rapier3d['World']>,
  body: InstanceType<Rapier3d['RigidBody']>,
  spec: RobotSpec,
  heightIn: number,
  rampReady: boolean,
): void {
  for (const s of chassis3dShapes(spec, heightIn)) {
    // a MECHANISM shape may be a CYLINDER (a turret sweeps a disc — `bbMechEnvelopes`); every
    // other box keeps the edge break exactly as it was. Groups/friction/restitution unchanged,
    // so a mechanism is solid to the same set the prism it replaces was.
    const desc = chassisMechDesc(RAPIER, s);
    world3d.createCollider(
      desc.setTranslation(s.cx, s.cy, s.cz).setDensity(0).setFriction(PHYS_FRICTION).setRestitution(0).setCollisionGroups(GROUP_CHASSIS),
      body,
    );
  }
  /**
   * ...and the POCKET FILLER, which is the same chassis to everything that is not an element.
   *
   * ⚠️ **IT TAKES THE EDGE BREAK TOO, AND THE FIRST CUT OF THIS DID NOT.** Its outer vertical
   * edges look redundant — they are coincident in (x, y) with the lintel's, which is already
   * broken — but they are the ONLY ones at the height of a low static, and a low static is the
   * whole reason this box exists. Shipped square, it handed the flower's 0.35-in base plate
   * (z -0.20..0.35, reaching 0.19 in further infield than the column above it) a knife corner,
   * and the column graze that the break had lifted to 0.4 in fell straight back to 0.2.
   */
  for (const s of chassis3dPocketShapes(spec, heightIn)) {
    world3d.createCollider(
      chassisBoxDesc(RAPIER, s.hx, s.hy, s.hz)
        .setTranslation(s.cx, s.cy, s.cz)
        .setDensity(0)
        .setFriction(PHYS_FRICTION)
        .setRestitution(0)
        .setCollisionGroups(GROUP_POCKET),
      body,
    );
  }
  // ...and the ARCHETYPE REACH HARDWARE (side rollers / a settled ramp) — solid now, and (owner
  // ruling 2026-09-20) an ELEMENT meets both: a POLLEN is pushed/deflected off a side roller's
  // cylinder or a ramp's bar, never tunnels through either.
  for (const s of chassis3dReachShapes(spec, heightIn, rampReady)) {
    world3d.createCollider(reachColliderDesc(RAPIER, s), body);
  }
}

/** the fixed rotation that stands a Rapier `Cylinder` up on world Z — Rapier's own cylinder is
 * built along its LOCAL Y axis (`Cylinder.halfHeight`'s own doc: "along the y axis"), and a side
 * roller is a VERTICAL-axis wheel, so its collider needs the same +90° turn about X every time
 * (`Y → Z`: rotating about X by 90° sends `(0,1,0)` to `(0,0,1)`). Module-level so it is computed
 * once — `tiltQuatX` runs the shared deterministic `dsin`/`dcos`, so this is bit-identical on
 * every peer, the same discipline `HIVE_BRACKET_W` above follows for its own load-once constant. */
export const CYL_AXIS_Z: Quat = tiltQuatX(Math.PI / 2);

/** build ONE reach-hardware collider from a `Chassis3dShape` — shared by the authority
 * (`addChassis3dColliders`, above) and the FULL predictor (`predict.ts`'s `fitChassis`), so the
 * shape choice, the rotation composition (`chassis3dReachShapes`'s `rot`) and the
 * group/friction/restitution are written in exactly one place.
 *
 * ⚠️ **`shape` PICKS THE GEOMETRY, `elementSolid` PICKS THE GROUP** (owner report 2026-09-20,
 * ramp: "The pollen should be getting intaked from the deployable ramp BECAUSE it collides with
 * the ramp... Right now, it just looks like the pollen is passing through the ramp"; owner
 * ruling 2026-09-20, side rollers: "it should also be colliding with everything. It is a
 * physical thing"). Both the ramp's crossbar/rails and the side rollers now set `elementSolid`,
 * so both get the DEFAULT collision groups (meets an element too, same as every other chassis
 * box) instead of `GROUP_POCKET` (statics/walls/robots only, same as the pocket filler) —
 * friction/restitution stay `PHYS_FRICTION`/0, the same as the chassis boxes, so those two never
 * moved. A BOX (the ramp) also picks up `chassisBoxDesc`'s contact-skin edge break, so a ball
 * meeting the bar behaves like meeting the frame rather than catching a knife corner; a CYLINDER
 * (a side roller) has no edges to break and is built directly as `ColliderDesc.cylinder`, with
 * its axis composed onto world Z (`CYL_AXIS_Z`) ahead of any `rot` the caller supplies — none do
 * today, since a solid of revolution about its own axis is yaw-invariant, but composing rather
 * than assuming keeps this correct if a future mount needs both. */
export function reachColliderDesc(RAPIER: Rapier3d, s: Chassis3dShape): InstanceType<Rapier3d['ColliderDesc']> {
  let desc: InstanceType<Rapier3d['ColliderDesc']>;
  let rot: Quat | undefined = s.rot;
  if (s.shape === 'cylinder') {
    desc = RAPIER.ColliderDesc.cylinder(s.hz, s.hx);
    rot = s.rot ? quatMul(s.rot, CYL_AXIS_Z) : CYL_AXIS_Z;
  } else {
    desc = s.elementSolid ? chassisBoxDesc(RAPIER, s.hx, s.hy, s.hz) : RAPIER.ColliderDesc.cuboid(s.hx, s.hy, s.hz);
  }
  desc.setTranslation(s.cx, s.cy, s.cz);
  if (rot) desc.setRotation(rot);
  desc.setDensity(0).setFriction(PHYS_FRICTION).setRestitution(0);
  /**
   * ⚠️ **A FREE ROLLER'S WALL FRICTION WAS TRIED HERE AND MEASURED WORTHLESS — DO NOT RE-ADD IT
   * WITHOUT A NEW MEASUREMENT** (2026-09-21). The theory was sound and the mechanism is real: a
   * side-roller build lines ONE wheel up on a FLOWER's opening, which puts the OTHER wheel on the
   * wall beside it, and that contact does happen (probed at the settle, penetration 0.036 in). A
   * free-spinning compliant wheel should roll along a wall rather than grab it, so the cylinders
   * were given `friction 0` with `CoefficientCombineRule.Min` — the tile plane's own trick a few
   * hundred lines up, which reads 0 against a wall/static/robot (all Average) while an ELEMENT's
   * MAX still outranks it, so a POLLEN is carried exactly as before.
   *
   * MEASURED, 540 real drive-ins either way: **324/540 both**, not one run flipped; the settle
   * moved 0.002 in and one tick. The yaw that swings the gripping wheel out of reach is a NORMAL
   * force off the flower's own plate — the chassis prism meets the rim over only one side of its
   * width — not a friction moment, so no friction coefficient can touch it. Reverted rather than
   * kept, because it is not free: the wheel is the first thing another ROBOT meets head-on into
   * the intake, and that contact would have gone frictionless on no evidence at all.
   */
  if (!s.elementSolid) desc.setCollisionGroups(GROUP_POCKET);
  else if (s.ramp) desc.setCollisionGroups(GROUP_RAMP);
  else desc.setCollisionGroups(GROUP_CHASSIS);
  return desc;
}

/**
 * ⚠️ **ONE CHASSIS BOX, WITH ITS EDGES BROKEN** — `BB3_INTAKE_CORNER_R`, whose header carries
 * the measurement. The box is SHRUNK by `r` on every axis and given a CONTACT SKIN of `r`,
 * which Rapier defines as "as if the collider was enlarged with a skin of width
 * `skin_thickness` around it": the Minkowski sum of the smaller box with a ball, so the six
 * FLAT FACES land back in exactly the planes a bare `cuboid(hx, hy, hz)` put them in and only
 * the EDGES pull in (0.037 in at a vertical corner, 0.053 at a vertex — both inside the
 * solver's own resting penetration). Flat-wall rest distance, a wall-flush start and
 * `startLegal` therefore cannot move, and what it buys is the graze: the overlap a driver
 * slides past a field static's corner with goes 0.2 in to 0.4 in.
 *
 * ⚠️ **IT IS A SKIN AND NOT A `roundCuboid` FOR ONE REASON, AND THE REASON IS THE ROOM
 * BUDGET.** The two measure the SAME graze threshold to 0.1 in, and a round cuboid is the
 * obvious shape — but it is a different narrow phase, and every box in this compound rests on
 * the tile plane every tick of every match. A/B'd four paired rounds against a 2v2 Chain
 * Reaction room (`perf: a 2v2 BIOBUZZ ROOM tick costs <= 1.2x ...`, `field.ts`), alternating
 * the order and with an A/A control: square 0.848, **`roundCuboid` 1.065**, **contact skin
 * 0.867**. The round shape spent a quarter of the whole room budget to buy what the skin buys
 * for nothing, and that check already reads 1.20-1.42 on a loaded box.
 *
 * ⚠️ **THE SHAPE IS THE SMALLER BOX; ONLY CONTACTS SEE THE SKIN.** Nothing may read a robot
 * collider's own geometry and treat it as the chassis. Nothing does: `birthClear` and the
 * containment net build from `chassis3dShapes` (the analytic boxes) and the only collider
 * queries in `sim3d/` are CONTACT queries, which the skin covers.
 *
 * It lives here rather than inline because BOTH chassis builders take it — this file's compound
 * and the FULL PREDICTOR's single `robotExtents` cuboid (`predict.ts` `fitChassis`), which has
 * to break the same edges or it would predict a catch the authority does not have.
 *
 * `r` is CLAMPED per box (`BB3_INTAKE_CORNER_CLAMP`) because the core is the box shrunk by `r`
 * on every axis and the intake arm is only `INTAKE_RAIL_T` thick; a non-positive core is a
 * collider Rapier refuses to build. A box too thin for any radius at all falls back to the
 * plain cuboid, so this is a strict generalization.
 */
export function chassisBoxDesc(
  RAPIER: Rapier3d,
  hx: number,
  hy: number,
  hz: number,
): InstanceType<Rapier3d['ColliderDesc']> {
  const r = Math.min(BB3_INTAKE_CORNER_R, BB3_INTAKE_CORNER_CLAMP * Math.min(hx, hy, hz));
  if (r <= 1e-6) return RAPIER.ColliderDesc.cuboid(hx, hy, hz);
  return RAPIER.ColliderDesc.cuboid(hx - r, hy - r, hz - r).setContactSkin(r);
}

/** drop every collider off a chassis body so it can be re-built at a new height. Shared by the
 * authority (`addChassis3dColliders`) and the predictor (its own cuboid): the deploy edge happens
 * in both, and a loop that counts DOWN is the only one that is safe while the collider list
 * shrinks under it. */
export function clearChassis3dColliders(
  world3d: InstanceType<Rapier3d['World']>,
  body: InstanceType<Rapier3d['RigidBody']>,
): void {
  for (let i = body.numColliders() - 1; i >= 0; i--) {
    world3d.removeCollider(body.collider(i), false);
  }
}

/**
 * SWAP ONLY THE REACH HARDWARE — the ramp's SETTLE/FOLD edge. The first `keep` colliders (the
 * chassis itself, in creation order) are left alone and everything after them is dropped and
 * rebuilt for `rampReady`.
 *
 * ⚠️ **NEVER CLEAR THE WHOLE COMPOUND FOR A RAMP EDGE.** That shipped, and the robot sank into
 * the tiles every time the ramp came down (owner report 2026-09-21). MEASURED: a chassis whose
 * every collider is replaced has NO floor contact for three ticks — it free-falls (vz −6.4,
 * −12.9, −19.3 in/s), lands 0.28 in under the floor, and the solver's bounded correction then
 * walks it back at ~0.001 in a tick, i.e. never while it stands still. The floor contacts belong
 * to the boxes that REST on the floor, and none of those change at a ramp edge.
 */
export function swapChassis3dReachColliders(
  RAPIER: Rapier3d,
  world3d: InstanceType<Rapier3d['World']>,
  body: InstanceType<Rapier3d['RigidBody']>,
  keep: number,
  spec: RobotSpec,
  heightIn: number,
  rampReady: boolean,
): void {
  for (let i = body.numColliders() - 1; i >= keep; i--) {
    world3d.removeCollider(body.collider(i), false);
  }
  for (const s of chassis3dReachShapes(spec, heightIn, rampReady)) {
    world3d.createCollider(reachColliderDesc(RAPIER, s), body);
  }
}

/** how many colliders of the authority's compound are the chassis itself (`addChassis3dColliders`
 * builds them FIRST, the reach hardware after) — `swapChassis3dReachColliders`'s `keep`. */
export function chassis3dBaseColliderCount(spec: RobotSpec, heightIn: number): number {
  return chassis3dShapes(spec, heightIn).length + chassis3dPocketShapes(spec, heightIn).length;
}

// ---- ELEMENTS -----------------------------------------------------------------
// a dynamic sphere per element that wants a body at all — ground, flight, hive cell AND flower.
// The Day 1 sentence here said a flower-parked element was FIXED instead; that has been false
// since Day 2 gave the flowers real tubes, `wantsDynamicBody` (`engineImpl.ts`) returns true for
// every `element`, and the stale claim cost one investigation an afternoon of disproving it.

export function elementMass(isNectar: boolean): number {
  return BB3_ELEMENT_MASS * (isNectar ? BB3_NECTAR_MASS_RATIO : 1);
}

export const ELEMENT_FRICTION = BB3_ELEMENT_FRICTION;
export const ELEMENT_RESTITUTION = BB3_ELEMENT_RESTITUTION;
export const ELEMENT_ROLL_DAMP = BB3_ELEMENT_ROLL_DAMP;
