import type { RobotCommand, RobotSpec, RobotState, Vec2, World } from '../../types';
import { INTAKE_PRESETS } from '../../config';
import { datan2, dcos, dsin, rot, wrapAngle } from '../../math';
import {
  BB_DEFAULT_INTAKE,
  BB_DEFAULT_SCORE_MODE,
  BB_DRUM_INTERVAL,
  BB_DRUM_MAX,
  BB_DRUM_SPEED,
  BB_FIRE_INTERVAL,
  BB_INTAKES,
  BB_LAUNCH_LINE_FRAC,
  BB_LAUNCH_Z0,
  BB_TWIN_FIRE_MULT,
  bbHopperCap,
} from './config';
import {
  EDGE_DIR,
  EDGE_PERP,
  type BbEdge,
  type BbScoreMode,
  bbIntakeEdges,
  bbIntakeMountOf,
  bbShooterEdgeOf,
  edgeGeom,
  isTurreted,
  mountOrigin,
  turretLocal,
} from './mounts';
import { releasePollen } from './elements';
import type { LocalRect, ScoreTarget } from './state';

/**
 * BIOBUZZ ROBOT GEOMETRY — the Lane B contract surface (`docs/biobuzz-contract.md` §4).
 *
 * Every question of the form "where does this robot capture / collide / launch" is answered
 * HERE and only here. The sim reads it, the canvas sprite reads it, and the builder's SVG
 * preview reads it, which is the invariant the whole file exists to protect:
 *
 *     THE DRAWN MOUTHS ARE THE CAPTURE AREAS.
 *
 * In Chain Reaction that was learned the hard way — the renderer and the capture test each
 * derived the intake band from the spec independently, and they disagreed by an inch, so
 * balls were swallowed from outside the visible roller. One geometry, three readers.
 *
 * SHELL SCOPE. There is no target to aim at: Sections 9 and 10 of the V0 manual are Kickoff
 * placeholders, so `scoreTargets()` returns `[]` and `bbAimHeading` has nothing to solve
 * against. What IS real here is the mechanism geometry — mouths, footprint, hopper, launch
 * origins and the four archetypes' firing behaviour — because that is robot hardware and R102
 * pins the envelope it lives in. A launch therefore LOBS into the field rather than at
 * anything, which is exactly what an unscored shell should do.
 */

// ─────────────────────────────────────────────────────────────────────────────
// CAPTURE + COLLISION GEOMETRY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The intake MOUTHS in the robot-local frame — one axis-aligned rect per mounted edge, so
 * `frontback` and `side` are simply two rects.
 *
 * Each mouth reaches OUT to the collision extent of its edge (`bbFootprint`, which the same
 * mount drives) and takes a shallow `depth` bite back INSIDE the frame. That bite is the whole
 * trick: a POLLEN sitting at the roller is captured BEFORE the frame would plow it, so driving
 * into a pile collects instead of scattering.
 *  • END edges (front/back) span the chassis WIDTH: `widthFrac`·chassis + `overhang`
 *  • FLANK edges (left/right) span the chassis LENGTH
 */
export function bbMouths(spec: RobotSpec): LocalRect[] {
  const it = BB_INTAKES[BB_DEFAULT_INTAKE];
  const reach = INTAKE_PRESETS[spec.intake].reach;
  const hl = spec.length / 2;
  const hw = spec.width / 2;
  const endHalf = hw * it.widthFrac + it.overhang; // mouth half-width across an END edge
  // a flank roller bites `depth` into the frame; never past the centreline on a narrow chassis
  const flankInner = Math.max(0.5, hw - it.depth);

  return bbIntakeEdges(bbIntakeMountOf(spec)).map((edge): LocalRect => {
    switch (edge) {
      case 'front':
        return { edge, x0: hl - it.depth, x1: hl + reach, y0: -endHalf, y1: endHalf };
      case 'back':
        return { edge, x0: -hl - reach, x1: -hl + it.depth, y0: -endHalf, y1: endHalf };
      case 'left':
        return { edge, x0: -hl, x1: hl, y0: flankInner, y1: hw + reach };
      case 'right':
        return { edge, x0: -hl, x1: hl, y0: -hw - reach, y1: -flankInner };
    }
  });
}

/**
 * The robot's COLLISION FOOTPRINT — chassis plus whatever the sweeper sticks out, per edge.
 *
 * This must agree with the shared `footprintExtents` (`src/sim/field.ts`), which is what
 * Rapier actually collides on. It does, and not by luck: BIOBUZZ rides the shared
 * `intakeMount` field, and `footprintExtents` already grows the box from that same mount by
 * the same intake reach. Keeping a BIOBUZZ-named accessor anyway is what lets the sprite and
 * the preview ask this game for its own footprint instead of reaching into `sim/field.ts`,
 * and it is the seam the plan's escape hatch needs on the day BIOBUZZ grows a mechanism
 * whose collision box is not a rectangle.
 */
export function bbFootprint(spec: RobotSpec): { front: number; rear: number; half: number } {
  const reach = INTAKE_PRESETS[spec.intake].reach;
  const mount = bbIntakeMountOf(spec);
  const ends = mount === 'front' || mount === 'frontback';
  const rear = mount === 'back' || mount === 'frontback';
  return {
    front: spec.length / 2 + (ends ? reach : 0),
    rear: spec.length / 2 + (rear ? reach : 0),
    half: spec.width / 2 + (mount === 'side' ? reach : 0),
  };
}

/** the robot's active hopper capacity in POLLEN. Re-exported under the contract name; the
 * derivation lives in `config.ts` so `elements.ts` can ask without importing this file (which
 * imports `elements.ts` for the release path — a cycle nobody needs). */
export { bbHopperCap };

// ─────────────────────────────────────────────────────────────────────────────
// AIM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The heading a TURRETLESS robot must turn to in order to point its firing edge at `target`,
 * or `null` when there is nothing to aim (the archetype is turreted, so it aims itself).
 *
 * A turretless drum or dumper fires along ONE chassis edge, so aiming means turning the whole
 * robot — and the answer is not simply "the bearing to the target", it is that bearing MINUS
 * the edge's own outward angle. Get that subtraction wrong and a broadside launcher aims 90°
 * off, which is exactly the class of bug the single `EDGE_*` table exists to prevent.
 *
 * SHELL: `scoreTargets()` is empty, so nothing in the shell calls this with a real target.
 * It is written and exported now because Lane A's aim-assist hook is a call to it, and a
 * function that shows up after its caller is a refactor instead of a fill-in.
 */
export function bbAimHeading(r: RobotState, target: ScoreTarget): number | null {
  const mode = (r.spec.scoreMode ?? BB_DEFAULT_SCORE_MODE) as BbScoreMode;
  if (isTurreted(mode)) return null; // the turret slews to it; the chassis is free
  const edge = bbShooterEdgeOf(r.spec);
  const bearing = datan2(target.pos.y - r.pos.y, target.pos.x - r.pos.x);
  // heading + EDGE_ANGLE[edge] === bearing  ⇒  heading = bearing − EDGE_ANGLE[edge]
  return wrapAngle(bearing - datan2(EDGE_DIR[edge].y, EDGE_DIR[edge].x));
}

/** WHERE THE TURRET IS BOLTED, in world space — the point a POLLEN is actually born at, so a
 * back-mounted turret visibly shoots off the back and a corner-mounted one off that corner.
 * The pivot rotates with the chassis, so the local offset is rotated into the world frame.
 * The AIM solution and the LAUNCH both read this: solving a lead from the chassis centre
 * while firing from an offset muzzle leaves a systematic miss that grows with the offset. */
export function bbTurretOrigin(r: RobotState): Vec2 {
  const off = rot(turretLocal(r.spec), r.heading);
  return { x: r.pos.x + off.x, y: r.pos.y + off.y };
}

/** the mid-point of a turretless launcher's firing EDGE, in world space, plus that edge's
 * outward direction and the half-span a parallel launch LINE spreads across. */
function launchLine(r: RobotState, edge: BbEdge): { origin: Vec2; dir: Vec2; perp: Vec2; half: number } {
  const g = edgeGeom(r.spec, edge);
  const local = mountOrigin(r.spec, edge);
  const o = rot(local, r.heading);
  return {
    origin: { x: r.pos.x + o.x, y: r.pos.y + o.y },
    dir: rot(EDGE_DIR[edge], r.heading),
    perp: rot(EDGE_PERP[edge], r.heading),
    half: g.span * BB_LAUNCH_LINE_FRAC,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LAUNCH
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FIRE, if this mechanism wants to this tick.
 *
 * The four archetypes differ in exactly one thing — the CADENCE and the SHAPE of what leaves
 * the robot — and this is where that difference lives:
 *
 *  • turret      — one POLLEN every `BB_FIRE_INTERVAL`, from the turret ring, along
 *                  `turretHeading` (the turret slews there at a finite rate, so a turreted
 *                  robot spawns already pointed rather than spending auto swinging round).
 *  • twinturret  — the same, `BB_TWIN_FIRE_MULT` faster: two barrels, one aim solution.
 *  • drum        — a chassis-wide flywheel drum streaming up to `BB_DRUM_MAX` pockets at
 *                  `BB_DRUM_INTERVAL`, in a PARALLEL LINE across the firing edge.
 *  • dumper      — the WHOLE hopper at once, fanned across the firing edge. No cadence at
 *                  all: that is the trade, a huge burst you then have to go and refill.
 *
 * CADENCE IS ACCUMULATED, not re-anchored: `fireReadyAt += interval` rather than
 * `= world.time + interval`, so the sub-tick remainder carries and the long-run rate is
 * exactly 13/s instead of quantizing to the 12 or 15 a per-tick re-anchor would give. The
 * idle guard (clamp forward when the hopper is empty) is what stops a burst catch-up the
 * moment it refills.
 *
 * DETERMINISM: no jitter. CR's drum randomized its interval off the world RNG for a more
 * organic stream; the shell deliberately does not, because a scene's hash is a determinism
 * test and an RNG draw whose count depends on how long a button was held makes that test
 * about the input rather than the physics. Lane B can add jitter behind the same world RNG
 * the scatter uses once the scenes are green without it.
 */
export function bbLaunch(world: World, r: RobotState, cmd: RobotCommand, enabled: boolean): void {
  const mode = (r.spec.scoreMode ?? BB_DEFAULT_SCORE_MODE) as BbScoreMode;
  const want = enabled && (cmd.fire || (r.autoFire && r.hopper.length >= bbHopperCap(r.spec)));
  if (!want || r.hopper.length === 0) {
    // IDLE GUARD: hold the cadence clock at "now" while there is nothing to fire, so a robot
    // that sat empty for ten seconds does not empty its hopper in one tick on refill.
    if (r.fireReadyAt < world.time) r.fireReadyAt = world.time;
    return;
  }

  if (mode === 'dumper') {
    // THE WHOLE HOPPER, in one fan across the firing edge. Fired back-to-front so the POLLEN
    // are laid down in a line rather than all from one point.
    const edge = bbShooterEdgeOf(r.spec);
    const { origin, dir, perp, half } = launchLine(r, edge);
    const n = r.hopper.length;
    for (let i = 0; i < n; i++) {
      // spread across the edge: i=0 at one end, i=n-1 at the other (a single POLLEN goes
      // dead centre rather than to an arbitrary end)
      const t = n === 1 ? 0 : (i / (n - 1)) * 2 - 1;
      const speed = BB_DRUM_SPEED * 0.55; // a dump is a heave, not a shot. APPROX.
      releasePollen(
        world,
        r,
        {
          x: dir.x * speed + perp.x * t * 12,
          y: dir.y * speed + perp.y * t * 12,
          z: BB_LAUNCH_Z0,
        },
        undefined,
        { x: origin.x + perp.x * t * half, y: origin.y + perp.y * t * half },
      );
    }
    r.lastFireAt = world.time;
    r.fireReadyAt = world.time + BB_FIRE_INTERVAL;
    return;
  }

  if (mode === 'drum') {
    const edge = bbShooterEdgeOf(r.spec);
    const { origin, dir, perp, half } = launchLine(r, edge);
    let fired = 0;
    while (r.fireReadyAt <= world.time && r.hopper.length > 0 && fired < BB_DRUM_MAX) {
      const t = BB_DRUM_MAX === 1 ? 0 : (fired / (BB_DRUM_MAX - 1)) * 2 - 1;
      releasePollen(
        world,
        r,
        { x: dir.x * BB_DRUM_SPEED, y: dir.y * BB_DRUM_SPEED, z: BB_LAUNCH_Z0 },
        undefined,
        { x: origin.x + perp.x * t * half, y: origin.y + perp.y * t * half },
      );
      r.fireReadyAt += BB_DRUM_INTERVAL;
      fired++;
    }
    if (fired > 0) r.lastFireAt = world.time;
    return;
  }

  // TURRET / TWIN TURRET: from the ring, along the turret's own heading.
  const interval = mode === 'twinturret' ? BB_FIRE_INTERVAL / BB_TWIN_FIRE_MULT : BB_FIRE_INTERVAL;
  let fired = 0;
  while (r.fireReadyAt <= world.time && r.hopper.length > 0 && fired < BB_DRUM_MAX) {
    const o = bbTurretOrigin(r);
    const h = r.turretHeading;
    releasePollen(
      world,
      r,
      { x: dcos(h) * BB_DRUM_SPEED, y: dsin(h) * BB_DRUM_SPEED, z: BB_LAUNCH_Z0 },
      undefined,
      o,
    );
    r.fireReadyAt += interval;
    fired++;
  }
  if (fired > 0) r.lastFireAt = world.time;
}
