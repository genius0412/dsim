import type { Artifact, RobotCommand, RobotSpec, RobotState, Vec2, World } from '../../types';
import { INTAKE_PRESETS, INTAKE_RAIL_T } from '../../config';
import type { RobotSolids, SolidShape } from '../../sim/artifactSolids';
import { clamp, datan2, dcos, dsin, hyp, rot, wrapAngle } from '../../math';
import { GRAVITY } from '../../config';
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
  BB_POLLEN_R,
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
import {
  BB_DEG,
  BB_HOOD_DEFAULT_DEG,
  BB_LIFT_DECK_Z,
  BB_LIFT_RATE,
  BB_LIFT_SEAT_TOL,
  BB_LIFT_STOW_EPS,
  BB_TURRET_PITCH_MAX,
  BB_TURRET_PITCH_MIN,
  BB_TURRET_PITCH_SLEW,
  BB_TURRET_SLEW,
  BB_TURRET_SPEED_MAX,
} from './config';
import { bbIsTurreted, bbLauncherOf, bbLiftOf } from './mechs';

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
 * THERE IS A TARGET NOW. This header used to say there was not — that Sections 9 and 10 were
 * Kickoff placeholders, `scoreTargets()` returned `[]`, and a launch therefore LOBBED into the
 * field rather than at anything. Lane A has filled the field in, and `ScoreTarget` carries a
 * `mouth`, so the aim path in this file is live code rather than a written-ahead shape: a
 * turret SOLVES (`bbTurretSolution`), SLEWS onto the solution on both axes (`bbSlewTurret`) and
 * fires the matched speed/elevation pair; a turretless launcher turns its whole chassis
 * (`bbAimHeading`) and lives with the hood it was built with.
 *
 * SCORING is still Lane A's and still absent — `play.ts`'s score pass writes zeroes and the
 * module declares `scored: false` — so a POLLEN that arrives dead centre in a CELL today counts
 * for nothing. Aiming and scoring are separate landings on purpose: this half is robot
 * hardware, and R102 pins the envelope it lives in.
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

/**
 * WHAT ON A BIOBUZZ ROBOT IS SOLID TO A GROUND POLLEN — this game's `GameSimModule.
 * artifactSolids`, and the fourth reader of the ONE mount.
 *
 * The shared `robotSolids` (`src/sim/artifactSolids.ts`) describes DECODE'S HARDWARE: a
 * chassis box plus either the funnel wedges of the sloped/triangle presets or the vector
 * preset's flank rails, always on the FRONT, because in DECODE the intake is always on the
 * front and `INTAKE_PRESETS` is the whole catalogue. A BIOBUZZ robot is a chassis with a
 * SWEEPER BAR on whichever edge(s) `intakeMount` names, so run through the shared geometry it
 * collided with pollen through a funnel it does not have, bolted to an edge its roller is not
 * on — a back sweeper had wedges at the front and open air where the roller is.
 *
 * WHAT IS ACTUALLY SOLID, and nothing beyond it, because the season has no manual yet:
 *  · the CHASSIS box `[-hl, hl] × [-hw, hw]`, always;
 *  · per mounted edge, the sweeper's two SIDE PLATES — thin rails along the lateral edges of
 *    that edge's MOUTH (`bbMouths`, so the drawn mouth and the solid agree), spanning only the
 *    OUTBOARD band between the frame and the roller line. Thickness is the shared
 *    `INTAKE_RAIL_T`: the same plate DECODE's vector preset has, reused rather than invented,
 *    since a BIOBUZZ number here would be a guess with no figure behind it;
 *  · the POLLEN it is carrying, as circles at their storage slots — a full hopper is a
 *    physical plug in the mouth, which is why the radius is the caller's and not DECODE's.
 *
 * THE MOUTH ITSELF IS OPEN, exactly as DECODE's is (product decision #10): a sweeper roller
 * rides above pollen height and a POLLEN rolls in under it to the frame. That is also what
 * makes `interact()`'s capture-before-the-frame-arrives honest — a solid mouth would plow
 * what the roller is supposed to pick up.
 *
 * NOT A PHYSICS CONSTANT IN SIGHT, per `docs/biobuzz-contract.md`: this is hardware geometry
 * (Lane B's, §4), the same class as `bbMouths` and `bbFootprint`. Friction, restitution and
 * mass still belong to the shared solve.
 */
export function bbRobotSolids(
  r: RobotState,
  heldBalls: readonly Artifact[],
  radius: number = BB_POLLEN_R,
): RobotSolids {
  const hl = r.spec.length / 2;
  const hw = r.spec.width / 2;
  const reach = INTAKE_PRESETS[r.spec.intake].reach;
  // never thicker than the frame it is bolted to — a degenerate or inverted box is a collider
  // Rapier cannot hull
  const t = Math.max(1e-3, Math.min(INTAKE_RAIL_T, hw / 2, hl / 2));
  const structure: SolidShape[] = [];
  if (reach > 1e-6) {
    for (const m of bbMouths(r.spec)) {
      if (m.edge === 'front' || m.edge === 'back') {
        // the band from the frame out to the roller line, on this end
        const cx = (m.edge === 'front' ? 1 : -1) * (hl + reach / 2);
        for (const s of [1, -1]) {
          const outer = s > 0 ? m.y1 : m.y0; // the mouth's own lateral edge
          structure.push({ kind: 'box', cx, cy: outer - (s * t) / 2, hx: reach / 2, hy: t / 2 });
        }
      } else {
        const cy = (m.edge === 'left' ? 1 : -1) * (hw + reach / 2);
        for (const s of [1, -1]) {
          const outer = s > 0 ? m.x1 : m.x0; // ±hl, the ends of a flank mouth
          structure.push({ kind: 'box', cx: outer - (s * t) / 2, cy, hx: t / 2, hy: reach / 2 });
        }
      }
    }
  }
  const held: SolidShape[] = [];
  for (const b of heldBalls) {
    if (b.state.kind !== 'held' || b.state.robot !== r.id) continue;
    held.push({ kind: 'circle', cx: b.state.lx, cy: b.state.ly, r: radius });
  }
  return { chassis: { kind: 'box', cx: 0, cy: 0, hx: hl, hy: hw }, structure, held };
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
 * The caller is `bbAimAssist` (`play.ts`), which picks the target with `bbPickTarget` and
 * applies the result as a rotate override while the fire button is held.
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
export function bbLaunch(
  world: World,
  r: RobotState,
  cmd: RobotCommand,
  enabled: boolean,
  /**
   * A TURRET'S SOLVED MUZZLE SPEED for the target it is currently tracking (`bbTurretSolution`
   * `.speed`), or `undefined` when there is nothing to track.
   *
   * PASSED IN RATHER THAN SOLVED HERE for two reasons, and both matter. It would be a CYCLE to
   * solve it here — choosing the target needs `scoreTargets`, which lives in Lane A's
   * `elements.ts`, and `play.ts` already imports this file. And it would be WIRE COST to carry
   * it on `RobotState`: a per-tick field ships 30 times a second to every client in the room,
   * and this number is only ever read one stage after it is computed, in the same tick.
   *
   * A TURRETLESS launcher ignores it completely — a hood is fixed hardware at a fixed speed,
   * which is the trade the archetype is sold on. `undefined` falls back to `BB_DRUM_SPEED`, so
   * a turret with no target still fires (at its stale elevation, into nothing in particular),
   * exactly as it did before it could aim.
   */
  muzzle?: number,
): void {
  // A BUILD WITH NO LAUNCHER CANNOT FIRE, and that is now a real build rather than an
  // impossible one — Studica's published StarterBot is a drivetrain and an intake. Returning
  // before the idle guard is deliberate: there is no cadence clock to hold for hardware that
  // does not exist.
  const launcher = bbLauncherOf(r.spec, BB_HOOD_DEFAULT_DEG);
  if (!launcher) return;
  const mode = launcher.kind;
  const want = enabled && (cmd.fire || (r.autoFire && r.hopper.length >= bbHopperCap(r.spec)));
  if (!want || r.hopper.length === 0) {
    // IDLE GUARD: hold the cadence clock at "now" while there is nothing to fire, so a robot
    // that sat empty for ten seconds does not empty its hopper in one tick on refill.
    if (r.fireReadyAt < world.time) r.fireReadyAt = world.time;
    return;
  }

  /**
   * THE LAUNCH VELOCITY, DECOMPOSED BY ELEVATION — and the end of a units bug.
   *
   * Every launch used to hand `releasePollen` a velocity whose `z` was `BB_LAUNCH_Z0`, a
   * constant documented as a launch HEIGHT in inches. So every POLLEN left at 10 in/s upward
   * and apexed 0.13 in: there was no arc in this game at all, and a launcher could not have
   * reached an elevated CELL if one had existed. The height is now used only as a height (by
   * `elements.ts`, which always did) and the vertical speed comes from an ANGLE.
   *
   * A TURRET uses the elevation it has actually slewed to, so a shot fired mid-correction
   * leaves on the wrong arc exactly as one fired mid-yaw leaves on the wrong bearing — the
   * pitch axis is a physical state, not a promise. A TURRETLESS launcher uses its built HOOD,
   * which is fixed hardware and the reason the hood is a build dial.
   */
  // RADIANS. `bbTurretPitch` is already one (it is the pitch twin of `turretHeading`); the
  // hood is the one angle stored in degrees, so it converts here at the boundary — see BB_DEG.
  const elev = bbIsTurreted(launcher) ? (r.bbTurretPitch ?? 0) : launcher.hoodDeg * BB_DEG;
  const vh = dcos(elev); // horizontal fraction of the launch speed
  const vv = dsin(elev); // vertical fraction

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
          x: dir.x * speed * vh + perp.x * t * 12,
          y: dir.y * speed * vh + perp.y * t * 12,
          z: speed * vv,
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
      // −1..+1 across the launch line, so the burst comes out as a parallel row rather than
      // a stack. `span` is typed `number` rather than left as the literal: a `BB_DRUM_MAX` of
      // 1 is a legal retune and the guard against dividing by its zero span has to survive
      // TypeScript narrowing the constant to the value it happens to have today.
      const span: number = BB_DRUM_MAX - 1;
      const t = span > 0 ? (fired / span) * 2 - 1 : 0;
      releasePollen(
        world,
        r,
        { x: dir.x * BB_DRUM_SPEED * vh, y: dir.y * BB_DRUM_SPEED * vh, z: BB_DRUM_SPEED * vv },
        undefined,
        { x: origin.x + perp.x * t * half, y: origin.y + perp.y * t * half },
      );
      r.fireReadyAt += BB_DRUM_INTERVAL;
      fired++;
    }
    if (fired > 0) r.lastFireAt = world.time;
    return;
  }

  // TURRET / TWIN TURRET: from the ring, along the turret's own heading, at the speed its arc
  // solution asked for. Speed and elevation travel TOGETHER — `bbSolveShot` returns a matched
  // pair and the angle is only right at its speed — so a turret that has slewed onto a distant
  // CELL also spun up for it, and one still swinging fires the stale pair and misses.
  const speed = muzzle ?? BB_DRUM_SPEED;
  const interval = mode === 'twinturret' ? BB_FIRE_INTERVAL / BB_TWIN_FIRE_MULT : BB_FIRE_INTERVAL;
  let fired = 0;
  while (r.fireReadyAt <= world.time && r.hopper.length > 0 && fired < BB_DRUM_MAX) {
    const o = bbTurretOrigin(r);
    const h = r.turretHeading;
    releasePollen(
      world,
      r,
      { x: dcos(h) * speed * vh, y: dsin(h) * speed * vh, z: speed * vv },
      undefined,
      o,
    );
    r.fireReadyAt += interval;
    fired++;
  }
  if (fired > 0) r.lastFireAt = world.time;
}


// ─────────────────────────────────────────────────────────────────────────────
// THE ARC — solving a launch against a target that has a HEIGHT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The minimum-speed ballistic solution to a target `d` inches away and `dh` inches ABOVE the
 * muzzle. Returns the launch speed and the elevation, both of which a launcher then has to be
 * able to produce.
 *
 * ── WHY THIS IS NOT `src/sim/robot.ts`'s `solveShot` ────────────────────────
 * DECODE's solver is the same mathematics and a good one — always solvable, smooth in
 * distance, no clamp singularity — but its height difference is a CONSTANT
 * (`GOAL_OPENING_Z - LAUNCH_HEIGHT`), because DECODE has exactly one goal. BIOBUZZ has two
 * target heights that differ by nearly 3x: a FLOWER's top ring at 21.5 in and a HIVE up-CELL
 * opening at 53.5-65.6 in. A solver with a baked-in `dh` can only ever be right about one of
 * them. So `dh` is a parameter, and that single change is what the whole pitch axis rests on.
 *
 * It lives HERE rather than being generalised in `src/sim/` because nothing BIOBUZZ may go
 * into the shared tree (the same rule Chain Reaction follows). The duplication is four lines
 * of arithmetic and the alternative is a BIOBUZZ concept in DECODE's file.
 *
 *   v_min^2 = g * (dh + sqrt(d^2 + dh^2)),   angle = atan2(dh + sqrt(d^2 + dh^2), d)
 *
 * The elevation sweeps toward vertical as `d` goes to zero (a near-straight lob into something
 * directly overhead) and toward 45 deg far out, which is the physically right shape and is why
 * a solution exists at every distance instead of running out at close range.
 */
export function bbSolveShot(d: number, dh: number): { speed: number; angle: number } {
  const dd = Math.max(d, 0.5);
  const reach = hyp(dd, dh);
  return { speed: Math.sqrt(GRAVITY * (dh + reach)), angle: datan2(dh + reach, dd) };
}

/** how high above the tiles this build's muzzle sits (in).
 *
 * A TURRET rides on top of the deck and a turretless launcher fires over a chassis edge, so
 * they are not the same height — and the difference matters to the arc, because `dh` is
 * measured from the MUZZLE and not from the floor. APPROX both. */
export function bbMuzzleZ(spec: RobotSpec): number {
  return bbIsTurreted(bbLauncherOf(spec, BB_HOOD_DEFAULT_DEG)) ? BB_LAUNCH_Z0 + 2 : BB_LAUNCH_Z0;
}

/**
 * THE WHOLE TURRET SOLUTION — yaw, elevation and muzzle speed — to put a POLLEN into `target`,
 * or `null` when this build has no turret to aim.
 *
 * ⚠️ **ALL THREE, TOGETHER, BECAUSE THE ARC IS ONE ANSWER AND NOT THREE.** `bbSolveShot`
 * returns a MATCHED (speed, angle) pair — it is the minimum-speed trajectory, so the angle is
 * only correct at that speed. Taking the angle and firing it at some other fixed speed is not
 * an approximation of the solution, it is a different shot: a CELL 47 in above the muzzle at
 * 40 in of range wants 206 in/s at 70°, and the same 70° at `BB_DRUM_SPEED`'s 175 falls short
 * of the HIVE entirely. `docs/biobuzz/plan-mechanisms.md` names this — "the §3 aim signature
 * must gain speed+angle" — and this is that signature.
 *
 * ⚠️ THE HIVE OPENING IS A BAND, NOT A POINT — 53.5 to 65.6 in — so there is a RANGE of
 * solutions that score and this aims at its middle. Deliberate for now (the middle is the most
 * forgiving of a moving chassis) but it is the part most likely to want revisiting: a
 * min/max acceptable pitch would let a robot take the flatter, faster solution when it has one.
 *
 * ANGLES ARE RADIANS, like everything in the sim that is not the hood (see `BB_DEG`). The
 * pitch is clamped into the barrel's real envelope, so a solution the hardware cannot reach
 * comes back as the nearest one it can — which then MISSES, honestly, rather than being
 * reported as unreachable and silently skipped.
 */
export function bbTurretSolution(
  r: RobotState,
  target: ScoreTarget,
): { yaw: number; pitch: number; speed: number } | null {
  if (!bbIsTurreted(bbLauncherOf(r.spec, BB_HOOD_DEFAULT_DEG))) return null;
  // FROM THE MUZZLE, NOT THE CHASSIS CENTRE — the same reason `bbTurretOrigin` exists: solving
  // an arc from the centre while firing from an offset ring leaves a systematic miss that
  // grows with the offset.
  const o = bbTurretOrigin(r);
  const dx = target.pos.x - o.x;
  const dy = target.pos.y - o.y;
  const sol = bbSolveShot(hyp(dx, dy), target.z - bbMuzzleZ(r.spec));
  return {
    yaw: datan2(dy, dx),
    pitch: clamp(sol.angle, BB_TURRET_PITCH_MIN, BB_TURRET_PITCH_MAX),
    // A FLYWHEEL HAS A TOP SPEED. Uncapped, a turret reaches every opening on the field from
    // everywhere and the only thing that could ever make it miss is the slew — which makes
    // RANGE a free parameter and the pitch envelope decorative. `BB_TURRET_SPEED_MAX` is sized
    // so the cap is NOT normally what bites (see its comment); a shot that needs more than it
    // leaves slow and falls short, which is a miss the driver can see and drive out of.
    speed: Math.min(sol.speed, BB_TURRET_SPEED_MAX),
  };
}

/**
 * The ELEVATION a turret must be at to put a POLLEN into `target`, in RADIANS, or `null` when
 * this build has no turret to elevate. The pitch half of `bbTurretSolution`.
 */
export function bbAimPitch(r: RobotState, target: ScoreTarget): number | null {
  return bbTurretSolution(r, target)?.pitch ?? null;
}

/**
 * Ease the turret's yaw and pitch toward a solution, one tick's worth.
 *
 * BOTH AXES SLEW, and neither snaps. `BB_TURRET_SLEW` existed as a constant with no consumer
 * — the turret was written up as slewing and was in fact frozen at whatever `spawn` pointed it
 * at — so this is the loop that was described but never built. Pitch is deliberately the
 * slower axis: elevation carries the barrel's weight where yaw turns a ring, and a turret that
 * re-elevated instantly between a 21.5 in FLOWER and a 59 in CELL would make the two targets
 * feel identical, which is the one thing the axis exists to prevent.
 */
export function bbSlewTurret(r: RobotState, wantYaw: number | null, wantPitch: number | null, dt: number): void {
  if (wantYaw !== null) {
    const err = wrapAngle(wantYaw - r.turretHeading);
    const step = BB_TURRET_SLEW * dt; // rad/s * s — both sides of the clamp are radians
    r.turretHeading = wrapAngle(r.turretHeading + clamp(err, -step, step));
  }
  if (wantPitch !== null) {
    const now = r.bbTurretPitch ?? 0;
    const step = BB_TURRET_PITCH_SLEW * dt;
    r.bbTurretPitch = clamp(now + clamp(wantPitch - now, -step, step), BB_TURRET_PITCH_MIN, BB_TURRET_PITCH_MAX);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE VERTICAL EXTENSION SLIDE
// ─────────────────────────────────────────────────────────────────────────────

/** where the carriage is right now (in above the tiles), stowed height included. A build with
 * no lift reads as the deck, so a caller never has to special-case its absence. */
export function bbLiftHeight(r: RobotState): number {
  return bbLiftOf(r.spec) ? BB_LIFT_DECK_Z + (r.bbLiftZ ?? 0) : BB_LIFT_DECK_Z;
}

/** is the carriage stowed? The sprite and the HUD both ask, and a shared epsilon is what stops
 * them disagreeing by a hundredth of an inch about whether the mast is down. */
export function bbLiftStowed(r: RobotState): boolean {
  return (r.bbLiftZ ?? 0) <= BB_LIFT_STOW_EPS;
}

/**
 * Drive the carriage for one tick: HELD raises, released lowers, and it stops at its own
 * `maxZ`.
 *
 * A LEVEL rather than an edge trigger, because a slide is a position you hold it at and not a
 * deed that completes — the same reason `intake` is a level. Travel is finite
 * (`BB_LIFT_RATE`), so the height is a physical state like the turret's angles rather than a
 * teleport, and a driver who wants to place has to commit the time.
 */
export function bbStepLift(r: RobotState, cmd: RobotCommand, dt: number): void {
  const lift = bbLiftOf(r.spec);
  if (!lift) return;
  const now = r.bbLiftZ ?? 0;
  const want = cmd.bbLift ? lift.maxZ - BB_LIFT_DECK_Z : 0;
  const step = BB_LIFT_RATE * dt;
  r.bbLiftZ = clamp(now + clamp(want - now, -step, step), 0, Math.max(0, lift.maxZ - BB_LIFT_DECK_Z));
}

/**
 * Is the carriage lined up with `target` well enough to place into it?
 *
 * HEIGHT ONLY — the horizontal question is the caller's, because "am I next to the FLOWER" is
 * a reach test the game owns and "is my carriage at ring height" is the mechanism's. R105 is
 * what makes this ever fail interestingly: a 29 in robot can reach a 21.5 in FLOWER ring and
 * can NEVER reach a 53.5 in HIVE CELL, so a lift aimed at a HIVE returns false at every
 * height, from the arithmetic rather than from a rule written by hand.
 */
export function bbLiftSeated(r: RobotState, target: ScoreTarget): boolean {
  return Math.abs(bbLiftHeight(r) - target.z) <= BB_LIFT_SEAT_TOL;
}
