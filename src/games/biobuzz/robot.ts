import type { Artifact, RobotCommand, RobotSpec, RobotState, Vec2, World } from '../../types';
import { INTAKE_PRESETS, INTAKE_RAIL_T } from '../../config';
import type { RobotSolids, SolidShape } from '../../sim/artifactSolids';
import { clamp, datan2, dcos, dsin, hyp, rot, wrapAngle } from '../../math';
import { GRAVITY } from '../../config';
import {
  BB_DEFAULT_INTAKE,
  BB_DUMP_RELOAD_S,
  BB_FIRE_BURST_MAX,
  BB_FIRE_INTERVAL,
  BB_FLOWERS,
  BB_INTAKES,
  BB_LAUNCH_LINE_FRAC,
  BB_LAUNCH_SPEED_DEFAULT,
  BB_LAUNCH_SPEED_MAX,
  BB_LAUNCH_Z0,
  BB_PLACE_REACH,
  BB_PLACE_TOL,
  BB_POLLEN_R,
  bbHopperCap,
} from './config';
import {
  EDGE_DIR,
  EDGE_PERP,
  MOUNT_DIR,
  type BbEdge,
  bbIntakeEdges,
  bbIntakeMountOf,
  bbShooterEdgeOf,
  edgeGeom,
  mountOrigin,
  turretLocal,
} from './mounts';
import { releasePollen } from './elements';
import type { LocalRect, ScoreTarget, Vec3 } from './state';
import {
  BB_DEG,
  BB_HOOD_DEFAULT_DEG,
  BB_TURRET_PITCH_MAX,
  BB_TURRET_PITCH_MIN,
  BB_TURRET_PITCH_SLEW,
  BB_TURRET_SLEW,
} from './config';
import { bbIsTurreted, bbLauncherOf, bbLiftOf, bbTurretFor } from './mechs';

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
 * or `null` when there is nothing to aim (the launcher is turreted, so it aims itself).
 *
 * A dumper fires over ONE chassis edge, so aiming means turning the whole robot — and the
 * answer is not simply "the bearing to the target", it is that bearing MINUS the edge's own
 * outward angle. Get that subtraction wrong and a broadside launcher aims 90° off, which is
 * exactly the class of bug the single `EDGE_*` table exists to prevent.
 *
 * Read through `bbLauncherOf`, never the flat `scoreMode` mirror. The callers are `bbAimAssist`
 * (`play.ts`), which applies the result as a rotate override while fire is held, and stage 5b,
 * which only calls a dumper ON TARGET once the chassis is within `BB_AIM_TOL` of it.
 */
export function bbAimHeading(r: RobotState, target: ScoreTarget): number | null {
  const launcher = bbLauncherOf(r.spec, BB_HOOD_DEFAULT_DEG);
  if (bbIsTurreted(launcher)) return null; // the turret slews to it; the chassis is free
  const edge = bbShooterEdgeOf({ shooterMount: launcher.mount });
  const bearing = datan2(target.pos.y - r.pos.y, target.pos.x - r.pos.x);
  // heading + EDGE_ANGLE[edge] === bearing  ⇒  heading = bearing − EDGE_ANGLE[edge]
  return wrapAngle(bearing - datan2(EDGE_DIR[edge].y, EDGE_DIR[edge].x));
}

/**
 * WHERE A TURRET IS BOLTED, in world space — the point an element is actually born at, so a
 * back-mounted turret visibly shoots off the back and a corner-mounted one off that corner.
 * The AIM solution and the LAUNCH both read this: solving a lead from the chassis centre while
 * firing from an offset muzzle leaves a systematic miss that grows with the offset.
 *
 * `which` names the turret: 0 is the launcher's `mount` (a DOUBLE turret's POLLEN turret), 1 is
 * a double turret's `mount2` (its NECTAR turret). A build with one turret reads 1 as 0.
 */
export function bbTurretOrigin(r: RobotState, which: 0 | 1 = 0): Vec2 {
  const launcher = bbLauncherOf(r.spec, BB_HOOD_DEFAULT_DEG);
  const pos = which === 1 ? (launcher.mount2 ?? launcher.mount) : launcher.mount;
  const off = rot(turretLocal(r.spec, pos), r.heading);
  return { x: r.pos.x + off.x, y: r.pos.y + off.y };
}

/** the mid-point of a turretless launcher's firing EDGE, in world space, plus that edge's
 * outward direction and the half-span a launch LINE spreads its release points across. */
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

/** is a hopper colour a NECTAR? POLLEN are yellow; NECTAR carry their alliance colour (§9.8). */
function isNectarColour(c: string): boolean {
  return c === 'red' || c === 'blue';
}

/**
 * WHAT STAGE 5b WORKED OUT ABOUT A SHOT, handed to `bbLaunch` in the same tick.
 *
 * Carried as a local, never as a `RobotState` field: it is read one stage after it is written,
 * and a per-tick robot field ships 30 times a second to every client in the room.
 */
export interface BbShot {
  /** the HIVE cell being tracked (`bbPickTarget`), or `null` with nothing on the open side */
  target: ScoreTarget | null;
  /** solved muzzle speed per turret exit — [0] a turret / a double turret's POLLEN turret,
   * [1] a double turret's NECTAR turret. `undefined` fires at `BB_LAUNCH_SPEED_DEFAULT`. A
   * dumper solves per element (`bbDumpSolution`) and leaves this empty. */
  speed: readonly (number | undefined)[];
  /** ON TARGET per exit (same indexing): a turret settled on a REACHABLE HIVE solution within
   * `BB_ON_TARGET_TOL`, or a dumper within `BB_AIM_TOL` of its aim heading with every element
   * inside the accepted band. AUTO-FIRE waits for it; manual fire does not, except a dumper's
   * aim gate. */
  onTarget: readonly boolean[];
}

/**
 * FIRE, if this mechanism wants to this tick.
 *
 *  • turret      — one element every `BB_FIRE_INTERVAL`, from the turret ring, along
 *                  `turretHeading`. A SINGLE turret only ever holds POLLEN (its intake refuses
 *                  NECTAR — `bbIntakeAccepts`).
 *  • twinturret  — TWO INDIVIDUAL turrets on one feed. The next element is the LIFO top of
 *                  `r.hopper`: a POLLEN leaves turret 0 (`mount`, `turretHeading`,
 *                  `bbTurretPitch`) and a NECTAR leaves turret 1 (`mount2`, `bbTurret2Heading`,
 *                  `bbTurret2Pitch`), each at its own solved speed, on the SHARED
 *                  `BB_FIRE_INTERVAL` clock.
 *  • dumper      — the WHOLE hopper at once, each element thrown from its own point across the
 *                  firing edge along its own CONVERGING arc into the target cell
 *                  (`bbDumpSolution`), then `BB_DUMP_RELOAD_S` to re-arm.
 *
 * ── WHEN IT FIRES ───────────────────────────────────────────────────────────
 * MANUAL fire fires. AUTO-FIRE (a full hopper with `autoFire` on) fires only when stage 5b says
 * the next exit is ON TARGET (`BbShot.onTarget`) — every robot is staged full and the presets
 * ship with auto-fire, so an unconditional auto-fire emptied a Box Tube robot's load the moment
 * the match started and it never reached a FLOWER. A DUMPER with aim assist and a target holds
 * even a manual press until it is on target: it throws its whole hopper at once, before the
 * assist has had a tick to steer, and a dump thrown 8° off a 20-in cell is a dump on the floor.
 * With NO target (nothing on the open side) a manual dump still throws, straight over its edge
 * at `BB_LAUNCH_SPEED_DEFAULT` — emptying a hopper somewhere that is not the HIVE is a real
 * thing a driver does.
 *
 * CADENCE IS ACCUMULATED, not re-anchored (`fireReadyAt += interval`), so the long-run turret
 * rate is exactly 13/s. The idle guard (clamp forward when the hopper is empty) stops a burst
 * catch-up on refill; `BB_FIRE_BURST_MAX` bounds any that remains. DETERMINISM: no jitter.
 */
export function bbLaunch(world: World, r: RobotState, cmd: RobotCommand, enabled: boolean, shot?: BbShot): void {
  const launcher = bbLauncherOf(r.spec, BB_HOOD_DEFAULT_DEG);
  const dumper = launcher.kind === 'dumper';
  const top = r.hopper.length > 0 ? r.hopper[r.hopper.length - 1] : undefined;
  const nextExit = dumper || top === undefined ? 0 : bbTurretFor(launcher, isNectarColour(top));
  const onTarget = shot?.onTarget[nextExit] ?? false;
  const full = r.hopper.length >= bbHopperCap(r.spec);
  const want = enabled && (cmd.fire || (r.autoFire && full && onTarget));
  if (!want || r.hopper.length === 0) {
    // IDLE GUARD: hold the cadence clock at "now" while there is nothing to fire, so a robot
    // that sat empty for ten seconds does not empty its hopper in one tick on refill.
    if (r.fireReadyAt < world.time) r.fireReadyAt = world.time;
    return;
  }

  if (dumper) {
    // RE-ARM, and the aim gate. Respecting `fireReadyAt` is what stops a held fire button
    // re-dumping on every capture.
    if (r.fireReadyAt > world.time) return;
    const target = shot?.target ?? null;
    if (r.aimAssist && target && !onTarget) return;
    const n = r.hopper.length;
    const throws = target ? bbDumpSolution(r, target, n) : null;
    if (throws) {
      // LIFO, each element onto its own converging arc
      for (const t of throws) releasePollen(world, r, t.vel, target ?? undefined, t.origin);
    } else {
      // no target (or aim assist off and out of band): straight over the edge, a parallel line
      const elev = launcher.hoodDeg * BB_DEG;
      const speed = BB_LAUNCH_SPEED_DEFAULT;
      const { origin, dir, perp, half } = launchLine(r, bbShooterEdgeOf({ shooterMount: launcher.mount }));
      for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0 : (i / (n - 1)) * 2 - 1;
        releasePollen(
          world,
          r,
          { x: dir.x * speed * dcos(elev), y: dir.y * speed * dcos(elev), z: speed * dsin(elev) },
          undefined,
          { x: origin.x + perp.x * t * half, y: origin.y + perp.y * t * half },
        );
      }
    }
    r.lastFireAt = world.time;
    r.fireReadyAt = world.time + BB_DUMP_RELOAD_S;
    return;
  }

  // TURRETS: from the ring, along that turret's own heading and pitch, at the speed its arc
  // solution asked for. Speed and elevation travel TOGETHER — `bbSolveShot` returns a matched
  // pair — so a turret still swinging fires the stale pair and misses.
  let fired = 0;
  while (r.fireReadyAt <= world.time && r.hopper.length > 0 && fired < BB_FIRE_BURST_MAX) {
    const colour = r.hopper[r.hopper.length - 1];
    const which = bbTurretFor(launcher, isNectarColour(colour));
    const o = bbTurretOrigin(r, which);
    const h = which === 1 ? (r.bbTurret2Heading ?? r.turretHeading) : r.turretHeading;
    const pitch = which === 1 ? (r.bbTurret2Pitch ?? 0) : (r.bbTurretPitch ?? 0);
    const speed = shot?.speed[which] ?? BB_LAUNCH_SPEED_DEFAULT;
    const vh = dcos(pitch);
    const vv = dsin(pitch);
    releasePollen(world, r, { x: dcos(h) * speed * vh, y: dsin(h) * speed * vh, z: speed * vv }, undefined, o, colour);
    r.fireReadyAt += BB_FIRE_INTERVAL;
    fired++;
  }
  if (fired > 0) r.lastFireAt = world.time;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ARC — solving a launch against a target that has a HEIGHT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The minimum-speed ballistic solution to a target `d` inches away and `dh` inches ABOVE the
 * muzzle. Returns the launch speed and the elevation, both of which a turret then has to be
 * able to produce.
 *
 * DECODE's `solveShot` is the same mathematics with a CONSTANT height difference (one goal);
 * `dh` is a parameter here, and nothing BIOBUZZ may go into the shared tree.
 *
 *   v_min^2 = g * (dh + sqrt(d^2 + dh^2)),   angle = atan2(dh + sqrt(d^2 + dh^2), d)
 */
export function bbSolveShot(d: number, dh: number): { speed: number; angle: number } {
  const dd = Math.max(d, 0.5);
  const reach = hyp(dd, dh);
  return { speed: Math.sqrt(GRAVITY * (dh + reach)), angle: datan2(dh + reach, dd) };
}

/**
 * THE SPEED A FIXED HOOD NEEDS to pass through a point `d` inches downrange and `dh` inches above
 * the release, or `null` when no speed at that elevation gets there.
 *
 *   v² = g·d² / (2·cos²θ·(d·tanθ − dh))  =  g·d² / (2·cosθ·(d·sinθ − dh·cosθ))
 *
 * written in the second form so there is no `tan` (and no division by `cos` near vertical), and
 * with `dcos`/`dsin` because this is sim code (the smoke source scan bans engine trig here). No
 * solution when the hood is too flat to rise `dh` over `d` at any speed or `d` is not downrange.
 */
export function bbHoodSpeed(d: number, dh: number, hoodRad: number): number | null {
  const c = dcos(hoodRad);
  const s = dsin(hoodRad);
  const denom = 2 * c * (d * s - dh * c);
  if (!(d > 0) || !(denom > 0)) return null;
  return Math.sqrt((GRAVITY * d * d) / denom);
}

/**
 * does a hood-`hoodRad` arc through (`d`, `dh`) arrive there DESCENDING? True when the apex is
 * short of `d`: `d·sinθ > 2·dh·cosθ`. The up-CELL only accepts a descending element
 * (`hiveAccepts`), so a dump that would reach the opening still climbing is not a shot.
 */
export function bbHoodDescends(d: number, dh: number, hoodRad: number): boolean {
  return d * dsin(hoodRad) > 2 * dh * dcos(hoodRad);
}

/** one element's throw out of a dump: where it leaves and the velocity it leaves with. */
export interface BbThrow {
  origin: Vec2;
  vel: Vec3;
}

/**
 * THE DUMP, SOLVED — `n` release points spread across the dumper's firing edge, each with its
 * own velocity CONVERGING on `target`'s centre, or `null` when this build is not a dumper or ANY
 * element has no accepted arc.
 *
 * ── WHY CONVERGE, NOT A PARALLEL LINE ───────────────────────────────────────
 * The cell's accept footprint is 20 in wide and the release points span up to ~16 in, but an
 * element thrown parallel to the chassis heading also carries that heading's error, and the
 * lateral tolerance left at range is only a couple of inches. Aiming each element from its OWN
 * release point at the cell centre removes both.
 *
 * ── THE BAND ────────────────────────────────────────────────────────────────
 * Each element is solved from the actual release height `BB_LAUNCH_Z0` (that is where
 * `releasePollen` puts it) at the built hood. It is ACCEPTED only when the hood has a solution
 * (`bbHoodSpeed`), that solution is within `BB_LAUNCH_SPEED_MAX`, and it arrives descending
 * (`bbHoodDescends`). Outside the band there is no dump to solve, and stage 5b does not call the
 * dumper on target.
 */
export function bbDumpSolution(r: RobotState, target: ScoreTarget, n: number): BbThrow[] | null {
  const launcher = bbLauncherOf(r.spec, BB_HOOD_DEFAULT_DEG);
  if (launcher.kind !== 'dumper') return null;
  const hood = launcher.hoodDeg * BB_DEG;
  const c = dcos(hood);
  const s = dsin(hood);
  const dh = target.z - BB_LAUNCH_Z0;
  const { origin, perp, half } = launchLine(r, bbShooterEdgeOf({ shooterMount: launcher.mount }));
  const out: BbThrow[] = [];
  const count = Math.max(1, n);
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : (i / (count - 1)) * 2 - 1;
    const o = { x: origin.x + perp.x * t * half, y: origin.y + perp.y * t * half };
    const dx = target.pos.x - o.x;
    const dy = target.pos.y - o.y;
    const d = hyp(dx, dy);
    const v = bbHoodSpeed(d, dh, hood);
    if (v === null || v > BB_LAUNCH_SPEED_MAX || !bbHoodDescends(d, dh, hood)) return null;
    out.push({ origin: o, vel: { x: (dx / d) * v * c, y: (dy / d) * v * c, z: v * s } });
  }
  return out;
}

/** how high above the tiles this build's element leaves the robot, for the arc solve (in).
 *
 * ⚠️ IT IS THE RELEASE HEIGHT, FOR EVERY LAUNCHER. `releasePollen` (`elements.ts`) puts every
 * launched element at `BB_LAUNCH_Z0`, turret or dumper, so that is the height the solve has to
 * start from. The turret used to solve from `BB_LAUNCH_Z0 + 2` ("the turret rides on the deck")
 * while the element was still born at `BB_LAUNCH_Z0` — every turret shot was aimed for a muzzle
 * two inches above where it actually left, and arrived two inches low. Raising a turret's muzzle
 * is a change to the RELEASE (pass the height through `releasePollen`), never to this solve
 * alone. `spec` stays so that change has somewhere to go. */
export function bbMuzzleZ(spec: RobotSpec): number {
  void spec;
  return BB_LAUNCH_Z0;
}

/**
 * THE WHOLE TURRET SOLUTION — yaw, elevation and muzzle speed — to put an element into `target`
 * from turret `which`, or `null` when this build has no such turret (a dumper, or turret 1 on a
 * single turret).
 *
 * ⚠️ ALL THREE, TOGETHER, BECAUSE THE ARC IS ONE ANSWER AND NOT THREE. `bbSolveShot` returns a
 * MATCHED (speed, angle) pair. The pitch is clamped into the barrel's real envelope and the speed
 * into `BB_LAUNCH_SPEED_MAX`, so a solution the hardware cannot reach comes back as the nearest
 * one it can — which then MISSES, honestly — and says so in `reachable`, which is what AUTO-FIRE
 * reads before calling the turret on target.
 */
export function bbTurretSolution(
  r: RobotState,
  target: ScoreTarget,
  which: 0 | 1 = 0,
): { yaw: number; pitch: number; speed: number; reachable: boolean } | null {
  const launcher = bbLauncherOf(r.spec, BB_HOOD_DEFAULT_DEG);
  if (!bbIsTurreted(launcher)) return null;
  if (which === 1 && launcher.kind !== 'twinturret') return null;
  // FROM THE MUZZLE, NOT THE CHASSIS CENTRE — see `bbTurretOrigin`.
  const o = bbTurretOrigin(r, which);
  const dx = target.pos.x - o.x;
  const dy = target.pos.y - o.y;
  const sol = bbSolveShot(hyp(dx, dy), target.z - bbMuzzleZ(r.spec));
  const pitch = clamp(sol.angle, BB_TURRET_PITCH_MIN, BB_TURRET_PITCH_MAX);
  return {
    yaw: datan2(dy, dx),
    pitch,
    speed: Math.min(sol.speed, BB_LAUNCH_SPEED_MAX),
    reachable: sol.speed <= BB_LAUNCH_SPEED_MAX && pitch === sol.angle,
  };
}

/** The ELEVATION turret 0 must be at to put an element into `target`, in RADIANS, or `null` when
 * this build has no turret to elevate. The pitch half of `bbTurretSolution`. */
export function bbAimPitch(r: RobotState, target: ScoreTarget): number | null {
  return bbTurretSolution(r, target)?.pitch ?? null;
}

/**
 * Ease turret `which`'s yaw and pitch toward a solution, one tick's worth. BOTH AXES SLEW, and
 * neither snaps; pitch is deliberately the slower axis. Turret 1 (a double turret's NECTAR
 * turret) writes `bbTurret2Heading` / `bbTurret2Pitch`, so only a caller that has a second
 * turret should name it.
 */
export function bbSlewTurret(
  r: RobotState,
  wantYaw: number | null,
  wantPitch: number | null,
  dt: number,
  which: 0 | 1 = 0,
): void {
  const yawStep = BB_TURRET_SLEW * dt; // rad/s * s
  const pitchStep = BB_TURRET_PITCH_SLEW * dt;
  if (which === 1) {
    if (wantYaw !== null) {
      const now = r.bbTurret2Heading ?? r.turretHeading;
      r.bbTurret2Heading = wrapAngle(now + clamp(wrapAngle(wantYaw - now), -yawStep, yawStep));
    }
    if (wantPitch !== null) {
      const now = r.bbTurret2Pitch ?? 0;
      r.bbTurret2Pitch = clamp(now + clamp(wantPitch - now, -pitchStep, pitchStep), BB_TURRET_PITCH_MIN, BB_TURRET_PITCH_MAX);
    }
    return;
  }
  if (wantYaw !== null) {
    const err = wrapAngle(wantYaw - r.turretHeading);
    r.turretHeading = wrapAngle(r.turretHeading + clamp(err, -yawStep, yawStep));
  }
  if (wantPitch !== null) {
    const now = r.bbTurretPitch ?? 0;
    r.bbTurretPitch = clamp(now + clamp(wantPitch - now, -pitchStep, pitchStep), BB_TURRET_PITCH_MIN, BB_TURRET_PITCH_MAX);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE BOX TUBE — proximity placement into a FLOWER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE PLACEMENT POINT, in the robot frame — the ONE geometry for "where does this robot place
 * into a FLOWER". The sim's reach test reads it, and the sprite and the builder preview are to
 * draw their marker at it, so the marker can never sit somewhere placement does not act from.
 * (Drawing note: the marker lies OUTSIDE the collision footprint by construction, so a sprite
 * must draw it outside its footprint clip, and the preview's viewBox must grow to include it.)
 *
 * `null` without a Box Tube. Otherwise the tube's mount origin PUSHED OUT to the collision
 * footprint on that side (`bbFootprint`, so a sweeper on the same edge counts — the robot cannot
 * get its frame any closer to a FLOWER than its sweeper allows), plus `BB_PLACE_REACH` along
 * `MOUNT_DIR` (a corner mount reaches along the diagonal). An axis the mount does not touch keeps
 * the mount origin's coordinate (0 for an edge mid-point). `center` is never a tube mount.
 */
export function bbPlacePointLocal(spec: RobotSpec): Vec2 | null {
  const lift = bbLiftOf(spec);
  if (!lift) return null;
  const d = MOUNT_DIR[lift.mount];
  const f = bbFootprint(spec);
  const o = mountOrigin(spec, lift.mount);
  const x = d.x > 0 ? f.front : d.x < 0 ? -f.rear : o.x;
  const y = d.y > 0 ? f.half : d.y < 0 ? -f.half : o.y;
  return { x: x + d.x * BB_PLACE_REACH, y: y + d.y * BB_PLACE_REACH };
}

/** `bbPlacePointLocal` in world space, or `null` without a Box Tube. */
export function bbPlacePoint(r: RobotState): Vec2 | null {
  const local = bbPlacePointLocal(r.spec);
  if (!local) return null;
  const off = rot(local, r.heading);
  return { x: r.pos.x + off.x, y: r.pos.y + off.y };
}

/**
 * The index (into `BB_FLOWERS`) of the FLOWER ring nearest this robot's placement point, if one
 * is within `BB_PLACE_TOL` — else `null`. Always `null` for a build with no Box Tube, and in a
 * world that is not a BIOBUZZ match (no `world.biobuzz` bag, so no FLOWER state to place into).
 */
export function bbFlowerInReach(world: World, r: RobotState): number | null {
  if (!world.biobuzz) return null;
  const p = bbPlacePoint(r);
  if (!p) return null;
  let best: number | null = null;
  let bestD = BB_PLACE_TOL * BB_PLACE_TOL;
  for (let i = 0; i < BB_FLOWERS.length; i++) {
    const f = BB_FLOWERS[i];
    const d = (f.x - p.x) ** 2 + (f.y - p.y) ** 2;
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
