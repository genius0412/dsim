import type { Artifact, RobotCommand, RobotSpec, RobotState, Vec2, World } from '../../types';
import { INTAKE_RAIL_T, SIM_DT } from '../../config';
import type { RobotSolids, SolidShape } from '../../sim/artifactSolids';
import { debouncedPress } from '../../sim/robot';
import { clamp, datan2, dcos, dsin, hyp, rot, wrapAngle } from '../../math';
import { GRAVITY } from '../../config';
import {
  BB3_INTAKE_Z,
  BB_DEFAULT_INTAKE,
  BB_DUMP_APEX_ABOVE,
  BB_DUMP_MAX_DIST,
  BB_DUMP_MIN_DIST,
  BB_DUMP_BUCKET,
  BB_DUMP_RELOAD_S,
  BB_DUMP_SEAT_PITCH,
  BB_FIRE_BURST_MAX,
  BB_FIRE_INTERVAL,
  BB_FLOWERS,
  bbHead,
  BB_INTAKES,
  BB_LAUNCH_LINE_FRAC,
  BB_LAUNCH_SPEED_DEFAULT,
  BB_LAUNCH_SPEED_MAX,
  BB_LAUNCH_Z0,
  BB_PLACE_REACH,
  BB_RAMP_DEPLOY_S,
  BB_RAMP_OUT,
  BB_SIDE_ROLLER_PROTRUDE,
  BB_TURRET_AXLE_Z,
  BB_TURRET_SOLVE_PASSES,
  BB_PLACE_TOL,
  BB_POLLEN_R,
  bbHopperCap,
  BB_HALF_X,
  BB_HALF_Y,
  BB_INTAKE_CENTRE_FRAC,
  BB_INTAKE_CLOSE_BONUS,
  BB_INTAKE_CLOSE_REF,
  BB_INTAKE_CROSS_MAX,
  BB_INTAKE_DRAW_IN,
  BB_INTAKE_GRIP_ACCEL,
  BB_INTAKE_LANE_W,
  BB_INTAKE_LIP,
  BB_INTAKE_PERIOD_MAX,
  BB_INTAKE_PERIOD_MIN,
  BB_INTAKE_SEAT,
  BB_INTAKE_THROAT_FRAC,
  BB_INTAKE_WALL_GRAB,
  bbIntakeReach,
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
  BB_AIM_TOL,
  BB_HOOD_DEFAULT_DEG,
  BB_TURRET_ACCEL,
  BB_TURRET_PITCH_ACCEL,
  BB_TURRET_PITCH_MAX,
  BB_TURRET_PITCH_MIN,
  BB_TURRET_PITCH_SLEW,
  BB_TURRET_SLEW,
} from './config';
import { bbIntakeAccepts, bbIntakeKindOf, bbIsTurreted, bbLauncherOf, bbLiftOf, bbTurretFor } from './mechs';
import { approach } from '../../math';

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
  const reach = bbIntakeReach(spec);
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
  const reach = bbIntakeReach(spec);
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
  const reach = bbIntakeReach(r.spec);
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
// THE ROLLER — what the intake does to a loose element
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ONE MOUTH, MEASURED ALONG ITS OWN AXES — the frame every test below is written in, so the
 * four edges are ONE branch instead of four sign-juggling copies (the bug `bbMouthFrame`
 * already exists to prevent on the drawing side).
 *
 *   `u` = distance OUTWARD from the chassis centre along the edge's normal. The frame face is
 *         at `dist`, the roller line at `uOut`, and the mouth's bite back inside the frame
 *         reaches `uIn`.
 *   `v` = position ACROSS the roller, 0 at the edge's mid-point, `±half` at its ends.
 *
 * Derived from the rect `bbMouths` published, never re-derived from the spec: the drawn mouth
 * IS the capture area, and a second derivation is how those two drift apart.
 */
export interface BbMouthAxes {
  n: Vec2;
  p: Vec2;
  /** the chassis face on this edge (`hl` for an end, `hw` for a flank) — where `BB_PLACE_REACH`
   * and `config.ts`'s FLOWER-opening header measure "a chassis face flush" from, but NOT the
   * archetype "tip line" (`bbFlowerAtIntake` uses `uOut` for that — see its own comment for why
   * the bare frame is the wrong reference in a real match). */
  dist: number;
  uIn: number;
  /** the mouth's own OUTWARD bound — the roller line, and the collision footprint's edge on this
   * mounted side (`bbFootprint`/`footprintExtents` grow it by the same `bbIntakeReach`). This IS
   * the archetype "tip line" `BbFlowerReach.out` is measured from (`u − uOut`): it is where a
   * robot driven flush against a solid on this edge actually rests, which `dist` is not. */
  uOut: number;
  half: number;
}

/** EXPORTED for `play.ts`'s `bbFlowerAtIntake`: the FLOWER gate needs the same per-mouth (n, p,
 * uOut) frame the roller model above uses, so the two cannot end up disagreeing about where a
 * mouth's centreline or tip line is. */
export function mouthAxes(m: LocalRect, hl: number, hw: number): BbMouthAxes {
  const n = EDGE_DIR[m.edge];
  const p = EDGE_PERP[m.edge];
  const uA = m.x0 * n.x + m.y0 * n.y;
  const uB = m.x1 * n.x + m.y1 * n.y;
  const vA = m.x0 * p.x + m.y0 * p.y;
  const vB = m.x1 * p.x + m.y1 * p.y;
  return {
    n,
    p,
    dist: m.edge === 'front' || m.edge === 'back' ? hl : hw,
    uIn: Math.min(uA, uB),
    uOut: Math.max(uA, uB),
    half: Math.abs(vB - vA) / 2,
  };
}

/** one element the rollers have hold of, and the world-frame velocity they want it at. */
export interface BbIntakePull {
  ball: Artifact;
  vel: Vec2;
}

/** what the intake does this tick: which elements it is DRAWING IN, and which have arrived at
 * the throat and may be swallowed (in order — the caller takes them through `capturePollen`,
 * which is what still enforces the hopper cap and G408). */
export interface BbIntakeAct {
  pull: BbIntakePull[];
  take: Artifact[];
}

const NO_ACT: BbIntakeAct = { pull: [], take: [] };

/**
 * THE INTAKE, AS A ROLLER RATHER THAN AS A TRIGGER RECT — the ONE implementation, called by
 * `play.ts` (2D) and `sim3d/elements3d.ts` (3D) so the two backends cannot disagree about what
 * an intake does.
 *
 * ── WHAT IT REPLACED, AND WHY ──────────────────────────────────────────────
 * `interact()` was a one-tick rect test: an element whose centre fell anywhere inside a
 * `bbMouths` rect teleported into the hopper, at unlimited rate, with no pull, no transit and
 * no relative-velocity term. Measured against it, the model below is better on every scenario
 * that was failing and no worse on the ones that were not — the numbers are in this lane's
 * report. The three things it could not do at all:
 *  · an element just OUTSIDE the rect was bulldozed rather than collected (a turn onto a
 *    POLLEN plowed it 59 in and never took it; a strafe past a line plowed 74 in);
 *  · a 3D capture is a body resting on the chassis collider, which in 3D IS the roller line
 *    (`robotExtents`), so the element sat within a hair of the rect's own bound and a strict
 *    test missed it — 35–70 ticks where 2D took 15, and misses at the mouth's lateral edge;
 *  · a hopper with room swallowed a whole pile in ONE tick, which no intake does.
 *
 * ── THE MODEL ──────────────────────────────────────────────────────────────
 *  1. ELIGIBLE: a ground element (a low FLIGHT one too, in 3D) under the roller's reach in z,
 *     of a colour this build takes (`bbIntakeAccepts`), inside a mouth — out to the roller line
 *     plus its own radius plus `BB_INTAKE_LIP` of contact tolerance, and no further. A FULL
 *     hopper returns nothing at all: the element is not pulled, and the chassis pushes it.
 *  2. GRIP: the rollers cannot hold something crossing them sideways faster than
 *     `BB_INTAKE_CROSS_MAX` relative to the robot — it carries on past.
 *  3. PULL: everything gripped is drawn toward the SEAT — its skin flush on the frame face,
 *     `BB_INTAKE_CENTRE_FRAC` of the pull spent walking it toward the throat. This is a
 *     VELOCITY the caller hands to the solve, never a position: the shared solve is still the
 *     only writer of where a ground element is (`docs/biobuzz-contract.md` §1), and this is the
 *     same shape as DECODE's `intakeSuction`, which is applied at the same point in the tick
 *     and for the same reason.
 *  4. SWALLOW: only once it has arrived — inside the throat band AND drawn back to within
 *     `BB_INTAKE_SEAT` of the frame face — which is a short transit rather than a teleport.
 *     An element PINNED on a wall is taken where it lies instead, at the slow end of the
 *     timing, because a funnel cannot centre something a wall is holding (DECODE's
 *     `INTAKE_WALL_GRAB`, and the reason its corner pickups work).
 *  5. CADENCE: one element per `BB_INTAKE_PERIOD_*` through the feed — fast dead centre, slow
 *     at the roller's ends, faster still when the robot is driving INTO it — and as many as the
 *     bar has FEED LANES (`BB_INTAKE_LANE_W`) side by side, so a wide sweeper eats a cluster
 *     two at a time and a narrow one does not.
 *
 * PURE. It reads the world and writes nothing; the caller applies both halves.
 */
export interface BbIntakeOpts {
  /** may a low FLIGHT element be taken? TRUE in 3D, where a shallow bounce is a real body
   * passing through the mouth; false in 2D, where a flight element is scripted and a ground one
   * is the only thing a roller can meet. */
  lowFlight?: boolean;
  /**
   * ⚠️ WHICH SOLID AN ELEMENT ACTUALLY COMES TO REST AGAINST IN THIS BACKEND — and the two
   * backends genuinely differ, so this is a parameter rather than a constant.
   *
   * 2D: `bbRobotSolids`' chassis box is the bare frame (`hl × hw`), the mouth is OPEN, and an
   * element pressed by the rollers ends up with its skin flush on the frame face — so the
   * throat is at `dist`. 3D: the robot's collider footprint is `robotExtents`, intake reach
   * INCLUDED (`docs/area/biobuzz.md` — a wall-flush start position needed it), so the mouth
   * region is solid and an element can never get nearer than the roller line — the throat is at
   * `uOut`. Seating a 3D element against a face 3 in inside its own collider is un-arrivable,
   * and measured that way nothing was EVER captured in 3D.
   */
  seat?: 'chassis' | 'footprint';
  /**
   * The tick length the grip ramp (`BB_INTAKE_GRIP_ACCEL`) integrates over. Optional and
   * defaulted to `SIM_DT` because neither caller (`play.ts`'s `step2d`, `sim3d/elements3d.ts`'s
   * `step3d`) steps at any other rate today — this exists so a future variable-rate caller (or a
   * lane's own dt-sweep check) does not have to fork the function to pass one in.
   */
  dt?: number;
  /**
   * ⚠️ **HOW FAR PAST THE ROLLER LINE THIS MOUTH REACHES RIGHT NOW** (owner report 2026-09-20:
   * "it just looks like the pollen is passing through the ramp and somehow still getting sucked
   * in by the intake"). Zero for every build but a DEPLOYED, SETTLED `ramp` (`bbRampExtraReach`,
   * below — both callers, `play.ts`'s `step2d` and `sim3d/elements3d.ts`'s `elements3dCapture`,
   * compute it from the SAME predicate so the two backends cannot disagree about which elements
   * the pull reaches). Added to the eligibility bound only (`g.uOut + extraReach + er +
   * BB_INTAKE_LIP`), never to the seat/throat: an element sitting inside the ramp's U or on its
   * crossbar is now ELIGIBLE for the pull, and is drawn the same distance toward the frame face
   * everything else is — it does not get a shorter transit for starting further out.
   */
  extraReach?: number;
}

export function bbIntakeAct(world: World, r: RobotState, opts: BbIntakeOpts = {}): BbIntakeAct {
  const lowFlight = opts.lowFlight ?? false;
  const atRoller = opts.seat === 'footprint';
  const dt = opts.dt ?? SIM_DT;
  const extraReach = opts.extraReach ?? 0;
  const cap = bbHopperCap(r.spec);
  const room = cap - r.hopper.length;
  // A FULL HOPPER DOES NOT PULL. The element is left to the solve and the chassis pushes it,
  // which is what a plugged intake actually does — and `bbRobotSolids` has already made the
  // held elements a physical plug in the mouth.
  if (room <= 0) return NO_ACT;
  const mouths = bbMouths(r.spec);
  if (mouths.length === 0) return NO_ACT;
  const hl = r.spec.length / 2;
  const hw = r.spec.width / 2;
  const axes = mouths.map((m) => mouthAxes(m, hl, hw));
  const velRobot = rot(r.vel, -r.heading);

  interface Cand {
    ball: Artifact;
    v: number;
    half: number;
    seated: boolean;
    period: number;
  }
  const cands: Cand[] = [];
  const pull: BbIntakePull[] = [];

  for (const b of world.balls) {
    const ground = b.state.kind === 'ground';
    if (!ground && !(lowFlight && b.state.kind === 'flight')) continue;
    // too high off the tiles for a sweeper to reach. A 2D ground element is always at z = 0,
    // so this only ever bites in 3D.
    if (b.z > BB3_INTAKE_Z) continue;
    if (!bbIntakeAccepts(r.spec, r.alliance, b.color)) continue;
    const er = b.r ?? BB_POLLEN_R;
    const local = rot({ x: b.pos.x - r.pos.x, y: b.pos.y - r.pos.y }, -r.heading);
    const vLocal = rot(b.vel, -r.heading);

    for (let i = 0; i < axes.length; i++) {
      const g = axes[i];
      const u = local.x * g.n.x + local.y * g.n.y;
      const v = local.x * g.p.x + local.y * g.p.y;
      // INSIDE THE MOUTH, and no further. The outward bound is the roller line plus the
      // element's OWN radius (a NECTAR is 1.8 where a POLLEN is 1.4) plus the contact lip; the
      // inboard and lateral bounds stay the drawn rect's, so no edge can ever swallow something
      // behind or beside the chassis.
      if (!(u > g.uIn && u < g.uOut + extraReach + er + BB_INTAKE_LIP)) continue;
      // ...and LATERALLY, the element's CENTRE has to be UNDER THE BAR — `|v| < half`, the
      // roller's own span and not an inch more.
      //
      // ⚠️ IT USED TO BE `half + er`, AND THAT IS WHERE "IT TOUCHED THE SIDE OF MY INTAKE AND
      // THE ROBOT SPUN" CAME FROM (owner report 2026-09-19, item 7). `bbRobotSolids` puts a
      // SIDE PLATE at each lateral end of the mouth, so an element whose centre is outboard of
      // `half` is on the far side of a solid the roller cannot reach through. The old bound
      // gripped it anyway and commanded it `DRAW_IN * CENTRE_FRAC` (50.4 in/s) straight INTO
      // that plate, every tick, for as long as the intake ran. In 2D the element simply sat
      // there fighting the clamp; in 3D — every server match — it is a real body against a real
      // collider, so the injected momentum was delivered to the chassis at an off-centre point:
      // a free force and a free torque with no command. MEASURED, robot parked, intake held, a
      // POLLEN resting against the plate: heading drifted 0.335 rad (19.2°) in 6.7 s at a steady
      // −0.035 rad/s and the robot walked 1.6 in, dragging the element with it. With the intake
      // OFF the same scene drifts 0.001 rad. An element the bar cannot reach is now just an
      // obstacle, which is what it is.
      //
      // The bound is the mouth's OWN half-span, so it moves with the geometry: the sweeper is
      // `widthFrac` 1.0, which puts it on the chassis sides — exactly where the plates are.
      if (!(Math.abs(v) < g.half)) continue;
      // GRIP: the relative motion across the rollers. Too fast and they spin under it.
      const relU = (vLocal.x - velRobot.x) * g.n.x + (vLocal.y - velRobot.y) * g.n.y;
      const relV = (vLocal.x - velRobot.x) * g.p.x + (vLocal.y - velRobot.y) * g.p.y;
      if (Math.abs(relV) > BB_INTAKE_CROSS_MAX) break;

      // THE FEED THROAT. ⚠️ THE WHOLE ROLLER, in the backend whose mouth is SOLID: with the
      // chassis collider out at `robotExtents` there is no open mouth for a funnel to walk an
      // element across — whatever the roller line is touching is what goes in, and the transit
      // is the cadence. Measured with a `THROAT_FRAC` band in 3D as well, elements near the
      // mouth's lateral edge were deflected by the collider corner before the funnel could
      // centre them and a six-element cluster lost one that the old model took.
      const throatHalf = atRoller ? g.half : g.half * BB_INTAKE_THROAT_FRAC;
      // THE SEAT: skin flush on whichever face this backend lets it reach (see `BbIntakeOpts`).
      const face = atRoller ? g.uOut : g.dist;
      const tu = face + er;
      const tv = clamp(v, -throatHalf, throatHalf);
      const du = tu - u;
      const dv = tv - v;
      const dl = hyp(du, dv);
      // THE ROLLERS MOVE WITH THE ROBOT, so the target is the robot's own velocity plus the
      // draw-in along the seat direction. Without that term an element in the mouth of a
      // driving robot is simply left behind and bulldozed by the frame it is sitting on — which
      // is the whole of the "it should perform better" complaint, measured at 59 in of plow.
      //
      // ⚠️ THE LATERAL TERM IS SCALED AFTER NORMALISING, NOT BEFORE. Scaled before, an element
      // already at the right depth (which in 3D is EVERY element, because it rests on the
      // roller line) had `du ≈ 0`, so the unit vector was all lateral and the funnel fired the
      // full `BB_INTAKE_DRAW_IN` sideways — which then read as an element crossing the rollers
      // at 52 in/s, tripped `BB_INTAKE_CROSS_MAX`, and dropped it out of the mouth on the next
      // tick. Measured: 0/1 captured and 66 in of plow on a POLLEN 0.7 in off the throat.
      const wu = velRobot.x * g.n.x + velRobot.y * g.n.y + (dl > 0.05 ? (du / dl) * BB_INTAKE_DRAW_IN : 0);
      const wv =
        velRobot.x * g.p.x +
        velRobot.y * g.p.y +
        (dl > 0.05 ? (dv / dl) * BB_INTAKE_DRAW_IN * BB_INTAKE_CENTRE_FRAC : 0);
      // ⚠️ THE RAMP IS AN ACCELERATION TIMES `dt`, NOT THE TARGET SPEED ITSELF. This used to pass
      // `BB_INTAKE_DRAW_IN` — a speed — straight in as `approach`'s per-TICK `maxDelta`, which
      // reached the full draw-in speed from rest in exactly one tick (52 in/s ÷ (1/60 s) = 3120
      // in/s² of effective acceleration — an instant-velocity teleport, not a grip). `approach`'s
      // `maxDelta` is a displacement, so a real acceleration cap is `BB_INTAKE_GRIP_ACCEL * dt`:
      // an element now ramps to `wu`/`wv` over several ticks instead of arriving there whole.
      const grip = BB_INTAKE_GRIP_ACCEL * dt;
      const cu = approach(vLocal.x * g.n.x + vLocal.y * g.n.y, wu, grip);
      const cv = approach(vLocal.x * g.p.x + vLocal.y * g.p.y, wv, grip);
      pull.push({
        ball: b,
        vel: rot({ x: cu * g.n.x + cv * g.p.x, y: cu * g.n.y + cv * g.p.y }, r.heading),
      });

      // PINNED: a wall is holding it, so the funnel has nothing to work with — take it where
      // it lies, at the slow end of the timing.
      const wallClear = Math.min(BB_HALF_X - Math.abs(b.pos.x), BB_HALF_Y - Math.abs(b.pos.y));
      const pinned = wallClear <= er + BB_INTAKE_WALL_GRAB;
      const arrived = u < face + er + BB_INTAKE_SEAT;
      const seated = arrived && (Math.abs(v) < throatHalf || pinned);
      const t = pinned ? 1 : clamp(Math.abs(v) / g.half, 0, 1);
      const closing = clamp(-relU / BB_INTAKE_CLOSE_REF, 0, 1);
      const period =
        (BB_INTAKE_PERIOD_MIN + (BB_INTAKE_PERIOD_MAX - BB_INTAKE_PERIOD_MIN) * t) /
        (1 + BB_INTAKE_CLOSE_BONUS * closing);
      cands.push({ ball: b, v, half: g.half, seated, period });
      break; // an element is in at most one mouth: opposite edges cannot both hold it
    }
  }

  const seated = cands.filter((c) => c.seated);
  if (seated.length === 0) return { pull, take: [] };
  // most central first, id as the deterministic tie-break — the same ordering rule DECODE's
  // `updateIntake` sorts its candidates by.
  seated.sort((a, b) => Math.abs(a.v) - Math.abs(b.v) || a.ball.id - b.ball.id);
  if (world.time - r.lastIntakeAt < seated[0].period) return { pull, take: [] };

  const lanes = Math.max(1, Math.floor((2 * seated[0].half) / BB_INTAKE_LANE_W));
  const laneW = (2 * seated[0].half) / lanes;
  const used = new Set<number>();
  const take: Artifact[] = [];
  for (const c of seated) {
    if (take.length >= Math.min(room, lanes)) break;
    const lane = clamp(Math.floor((c.v + c.half) / laneW), 0, lanes - 1);
    if (used.has(lane)) continue; // two elements in one lane queue; they do not both fit
    used.add(lane);
    take.push(c.ball);
  }
  return { pull, take };
}

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

/**
 * IS TURRET `which` ACTUALLY POINTED AT `sol` RIGHT NOW?
 *
 * A solved arc says a shot EXISTS, not that the hardware has slewed onto it. The hive path
 * never needed this asked out loud — `bbTurretShotEnters` forward-simulates the shot from the
 * turret's CURRENT pose, so a turret still slewing simply misses the cell and does not arm.
 * A PASS has no cell to miss: its gate is “does the arc reach”, which is true the instant the
 * solve succeeds, so without this a pass releases on the first tick of the press and throws
 * wherever the turret happened to be facing. MEASURED before this existed: three passes at a
 * 102-in preset landed 34.8, 64.2 and 78.3 in short of it.
 */
export function bbTurretOnTarget(r: RobotState, sol: { yaw: number; pitch: number }, which: 0 | 1 = 0): boolean {
  const h = which === 1 ? (r.bbTurret2Heading ?? r.turretHeading) : r.turretHeading;
  return Math.abs(wrapAngle(sol.yaw - h)) < BB_AIM_TOL && Math.abs(sol.pitch - turretPitchOf(r, which)) < BB_AIM_TOL;
}

/** the ELEVATION of turret `which` right now (rad) — 0 for a turret this build does not have. */
function turretPitchOf(r: RobotState, which: 0 | 1): number {
  return which === 1 ? (r.bbTurret2Pitch ?? 0) : (r.bbTurretPitch ?? 0);
}

/**
 * ⚠️ **WHAT A POINT BOLTED TO A MOVING ROBOT IS ACTUALLY DOING — `v + ω × r`.**
 *
 * The chassis's own velocity plus the tangential velocity the yaw rate gives a point `p` inches
 * off the chassis centre. In the plane, `ω × r` is `(−ω·ry, ω·rx)`.
 *
 * ⚠️ **AND IT IS WHAT A RELEASED ELEMENT INHERITS** (owner, 2026-09-19: the turret must have "a
 * 'shooting on the move' correction algorithm built in"). Before this, a BIOBUZZ launch left with
 * `speed` along the muzzle's heading and NOTHING from the chassis — a shot fired at 89 in/s of
 * drive flew as if the robot were parked, which is not physics and left a lead correction with
 * nothing to correct. A corner-mounted turret on a spinning chassis really does throw sideways,
 * which is the `ω × r` half and the reason the offset matters rather than only `r.vel`.
 *
 * Chain Reaction has done this since it shipped (`launchToAccel`, `src/games/chain/play.ts`);
 * this is the same model with the muzzle offset and the elevation added.
 *
 * PLANAR, because `RobotState` has no vertical velocity a launch could inherit: a driving robot's
 * `vz` is zero under both physics and the yaw rate is about z, so `ω × r` has no z component.
 */
export function bbPointVel(r: RobotState, p: Vec2): Vec2 {
  const w = r.angVel;
  return { x: r.vel.x - w * (p.y - r.pos.y), y: r.vel.y + w * (p.x - r.pos.x) };
}

/**
 * WHERE turret `which`'s muzzle IS RIGHT NOW, in the plane — its bolt point walked back along its
 * CURRENT heading by the hood lip's own setback at its CURRENT pitch (`bbMuzzleLocal`).
 *
 * Split out of `bbTurretRelease` because the SOLVE needs it too: the lead is the velocity of the
 * point the element actually leaves from, and that point is not the bolt point.
 */
function bbMuzzlePoint(r: RobotState, which: 0 | 1): Vec2 {
  const h = which === 1 ? (r.bbTurret2Heading ?? r.turretHeading) : r.turretHeading;
  const back = bbMuzzleLocal(turretPitchOf(r, which), which).back;
  const o = bbTurretOrigin(r, which);
  return { x: o.x - dcos(h) * back, y: o.y - dsin(h) * back };
}

/**
 * THE RELEASE turret `which` makes RIGHT NOW at `speed`: where the element is born — in the
 * plane AND in height — and the velocity it leaves with, along that turret's current heading and
 * pitch (not its solution — a turret still swinging fires where it points). ONE function because
 * three readers need the same answer: `bbLaunch` releases it, stage 5b runs it forward to ask
 * whether it will score, and `shotPath.ts` draws it.
 *
 * ⚠️ **`origin` IS NOT THE TURRET'S BOLT POINT AND `z` IS NOT A CONSTANT.** The muzzle FOLLOWS
 * THE HOOD (owner, 2026-09-19): the hood lip swings about the flywheel axle, which itself sits
 * `axleX` in FRONT of the turret's rotation axis, so the release starts well ahead of the bolt
 * point and creeps back toward it as the barrel elevates, dropping as it goes. Both halves come
 * out of `bbMuzzleLocal`, which is the one place the dimension chain is read — and it is read
 * with `which`, because a DOUBLE turret's NECTAR head is a bigger machine than its POLLEN one.
 *
 * ⚠️ **`speed` IS THE MUZZLE SPEED AND `vel` IS NOT.** The element leaves the barrel at `speed`
 * RELATIVE TO THE MUZZLE and then carries the muzzle's own velocity with it (`bbPointVel`), so
 * `vel` is the sum. `bbTurretSolution` solves `speed` against a target already displaced by that
 * same inherited velocity, which is what makes the pair agree; a turret still slewing fires the
 * stale pair from a muzzle moving the way it is moving NOW, and misses honestly.
 *
 * ⚠️ WHICH TICK'S VELOCITY: `r.vel`/`r.angVel` as the sim has them at the moment of release.
 * 2D reaches here after `solveRobots` has written this tick's post-contact velocity (stage 5a →
 * 5b → 6 in `play.ts`); 3D reaches here at stage 11, after `readback` (8) has written the step's
 * own answer. Both are therefore the velocity the chassis has where the muzzle IS on this tick,
 * which is the pairing that matters — NOT 3D's `preVels3d`, which is the pre-solve snapshot
 * `squareUpRobotsWalls` and G417 want and is one solve behind the pose.
 */
export function bbTurretRelease(
  r: RobotState,
  which: 0 | 1,
  speed: number,
): { origin: Vec2; z: number; vel: Vec3 } {
  const h = which === 1 ? (r.bbTurret2Heading ?? r.turretHeading) : r.turretHeading;
  const pitch = turretPitchOf(r, which);
  const o = bbMuzzlePoint(r, which);
  const carry = bbPointVel(r, o);
  const vh = dcos(pitch);
  return {
    origin: o,
    z: bbMuzzleZ(r.spec, pitch, which),
    vel: { x: dcos(h) * speed * vh + carry.x, y: dsin(h) * speed * vh + carry.y, z: speed * dsin(pitch) },
  };
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
  /** the cell Aim Assist is on (`bbAimTarget`): the nearer cell of the own HIVE, as if it were up */
  target: ScoreTarget;
  /** solved muzzle speed per turret exit — [0] a turret / a double turret's POLLEN turret,
   * [1] a double turret's NECTAR turret. `undefined` fires at `BB_LAUNCH_SPEED_DEFAULT`. A
   * dumper solves per element (`bbDumpSolution`) and leaves this empty. */
  speed: readonly (number | undefined)[];
  /** WILL LAND per exit (same indexing): the release this exit would make now, run forward through
   * the flight stage (`bbFlightEnters`), enters `target` PRETENDING THAT CELL IS UP AND SETTLED.
   * A dumper additionally has to be within `BB_AIM_TOL` of its aim heading. Only predicted while
   * the driver holds fire; `false` otherwise. This is the whole of Aim Assist's firing gate. */
  lands: readonly boolean[];
  /**
   * ⚠️ **3D ONLY, AND ABSENT EVERYWHERE ELSE** — is this pipeline's dumper a CATAPULT?
   *
   * `true` ⇒ the dump is ONE FLING of the whole bucket on ONE tick, every element leaving with
   * the SAME velocity on a PARALLEL arc (`bbDumpCluster`). `sim3d/elements3d.ts` is the only
   * caller that sets it, and it sets it always.
   *
   * Absent ⇒ the 2D pipeline's CONVERGING dump (`bbDumpSolution`), every element aimed from its
   * own seat at the cell centre. That is free in 2D, where a flight element collides with
   * nothing, and it is what the permanent 2D pipeline has always done — **with this field absent
   * the dumper branch below runs byte-identically to before it existed.**
   *
   * The two differ because the two physics genuinely do: in 3D four converging spheres meet in
   * the opening. `BB_DUMP_BUCKET`'s header in `config.ts` carries the measurement and the history
   * (this used to be `perDump`, a one-element-per-0.3 s POUR that treated the symptom).
   */
  cluster?: boolean;
}

/**
 * FIRE, if this mechanism wants to this tick.
 *
 *  • turret      — one element every `BB_FIRE_INTERVAL`, from the turret ring, along
 *                  `turretHeading`. A SINGLE turret only ever holds POLLEN (its intake refuses
 *                  NECTAR — `bbIntakeAccepts`).
 *  • twinturret  — TWO INDIVIDUAL turrets, each with its OWN feed off the shared hopper and
 *                  BOTH FIRING ON THE SAME BEAT. A POLLEN leaves turret 0 (`mount`,
 *                  `turretHeading`, `bbTurretPitch`) and a NECTAR leaves turret 1 (`mount2`,
 *                  `bbTurret2Heading`, `bbTurret2Pitch`), each at its own solved speed.
 *                  ⚠️ IT USED TO ALTERNATE (owner report 2026-09-19, item 5: "double turret
 *                  shooter should start shooting pollen and nectar at the same time"). One LIFO
 *                  `r.hopper` top chose ONE exit per beat, so with two POLLEN and two NECTAR
 *                  loaded the measured release order was NECTAR at tick 0, POLLEN at tick 4,
 *                  NECTAR at 9, POLLEN at 13 — the second turret's first shot always a whole
 *                  cadence interval behind the first's. Worse, the gate read the top element's
 *                  exit ALONE: a NECTAR on top with turret 1 still slewing refused the fire
 *                  outright and the loaded, aimed POLLEN turret sat idle behind it. Each turret
 *                  now takes the LIFO-top element OF ITS OWN KIND, and an exit that is empty or
 *                  off target is simply skipped rather than blocking the other one.
 *  • dumper      — the WHOLE hopper at once, each element thrown from its own point across the
 *                  firing edge along its own CONVERGING arc into the target cell
 *                  (`bbDumpSolution`), then `BB_DUMP_RELOAD_S` to re-arm.
 *
 * ── WHEN IT FIRES — AIM ASSIST (owner, 2026-09-13) ─────────────────────────
 * ONLY ON THE DRIVER'S FIRE BUTTON. BIOBUZZ has no auto-fire: `r.autoFire` is never read here
 * (spawn forces it false), because the auto-fire it replaced fired whenever the real up cell
 * would take a shot and held back once the elements in the air would tip it — sensing no robot
 * has. With aim assist on (always, `coerceAssists`), a held fire is released only when stage 5b
 * says this exit's shot would LAND in the cell the assist is on, pretending that cell is up
 * (`BbShot.lands`). So a turret still slewing waits, a robot out of range does nothing, and a
 * shot at a cell that is actually down — or that tips before the shot arrives — is released and
 * misses, which is what the driver would get on a real field. With aim assist off, fire is fire.
 *
 * CADENCE IS ACCUMULATED, not re-anchored (`fireReadyAt += interval`), so the long-run turret
 * rate is exactly 13/s. The BEAT is shared — one `fireReadyAt`, one wire field, and a shared
 * feed is what a shared hopper physically is — but every exit that is loaded and on target
 * fires on it, so the two turrets of a double start together and each keeps its own 13/s
 * afterwards. The idle guard (clamp forward when the hopper is empty) stops a burst catch-up on
 * refill; `BB_FIRE_BURST_MAX` bounds any that remains. DETERMINISM: no jitter.
 */
export function bbLaunch(world: World, r: RobotState, cmd: RobotCommand, enabled: boolean, shot?: BbShot): void {
  const launcher = bbLauncherOf(r.spec, BB_HOOD_DEFAULT_DEG);
  const dumper = launcher.kind === 'dumper';
  /** the exits this launcher has: both turrets of a double, one for everything else. */
  const exits: readonly (0 | 1)[] = launcher.kind === 'twinturret' ? [0, 1] : [0];
  /**
   * THE LIFO-TOP ELEMENT `which` IS FED, or `undefined` when that exit has nothing to fire.
   *
   * For a single turret and a dumper `bbTurretFor` answers 0 for every colour, so this is the
   * hopper's top and every line below is what it always was. For a DOUBLE it is the top POLLEN
   * for turret 0 and the top NECTAR for turret 1 — two feeds off one hopper, which is what lets
   * both fire on one beat.
   */
  const feed = (which: 0 | 1): (typeof r.hopper)[number] | undefined => {
    for (let i = r.hopper.length - 1; i >= 0; i--) {
      const c = r.hopper[i];
      if (bbTurretFor(launcher, isNectarColour(c)) === which) return c;
    }
    return undefined;
  };
  const lands = (which: number): boolean => !r.aimAssist || (shot?.lands[which] ?? false);
  // ARMED IF *ANY* EXIT IS. A dumper heaves the whole hopper out of exit 0, so it asks about
  // that one; a launcher with two turrets is not blocked by the one that is empty or still
  // slewing.
  const armed = dumper ? lands(0) : exits.some((w) => feed(w) !== undefined && lands(w));
  /* A PASS RELEASES THROUGH THIS SAME PATH. `play.ts` has already pointed the turret at the
     pass point and set `shot.lands` from the arc's REACH, so from here a pass is a shot like
     any other — same cadence, same feed, same LIFO top. Turret-only: `bbPass` is gated on
     `bbIsTurreted` where the shot is predicted, so a dumper never arms on it. */
  const want = enabled && (cmd.fire || (cmd.bbPass && !dumper)) && armed;
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
    // ⚠️ THE CATAPULT'S BUCKET HOLDS `BB_DUMP_BUCKET`; the CONVERGING 2D dump takes the whole
    // hopper, as it always has (`BbShot.cluster`). A build that stores more than the bucket
    // simply flings a bucketful and re-arms on the full reload for the rest.
    const catapult = shot?.cluster ?? false;
    const n = catapult ? Math.min(r.hopper.length, BB_DUMP_BUCKET) : r.hopper.length;
    const fling = catapult && target ? bbDumpCluster(r, target, n) : null;
    const throws = !catapult && target ? bbDumpSolution(r, target, n) : null;
    if (fling) {
      // ONE ARM, ONE VELOCITY: every seat leaves on the same vector, so the bucket's own
      // footprint is what arrives at the opening and the cluster cannot collide with itself.
      // The SEAT's own height travels with it — the bucket is two across and two high.
      for (const st of fling.seats) releasePollen(world, r, fling.vel, target ?? undefined, st.pos, undefined, st.z);
    } else if (throws) {
      // LIFO, each element onto its own converging arc
      for (const t of throws) releasePollen(world, r, t.vel, target ?? undefined, t.origin);
    } else {
      // aim assist off and out of range: straight over the edge, a parallel line, lobbed as far
      // as a dumper throws
      const lob = bbLobThrow(BB_DUMP_MAX_DIST, (target?.z ?? BB_LAUNCH_Z0) - BB_LAUNCH_Z0) ?? { vh: 0, vz: 0 };
      const { origin, dir, perp, half } = launchLine(r, bbShooterEdgeOf({ shooterMount: launcher.mount }));
      for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0 : (i / (n - 1)) * 2 - 1;
        releasePollen(
          world,
          r,
          { x: dir.x * lob.vh, y: dir.y * lob.vh, z: lob.vz },
          undefined,
          { x: origin.x + perp.x * t * half, y: origin.y + perp.y * t * half },
        );
      }
    }
    r.lastFireAt = world.time;
    // A FLING IS ONE MOTION, so the re-arm is the full `BB_DUMP_RELOAD_S` either way. The
    // short "still pouring" re-arm the stagger needed is gone with the stagger.
    r.fireReadyAt = world.time + BB_DUMP_RELOAD_S;
    return;
  }

  // TURRETS: from the ring, along that turret's own heading and pitch, at the speed its arc
  // solution asked for. Speed and elevation travel TOGETHER — `bbSolveShot` returns a matched
  // pair — so a turret still swinging fires the stale pair and misses.
  //
  // EVERY LOADED, ON-TARGET EXIT FIRES ON THE BEAT. `beats` counts BEATS of the cadence clock,
  // not elements: a double turret releases up to two on one beat and that is the point. An exit
  // with nothing of its kind in the hopper, or one still slewing, is SKIPPED — never a `break`,
  // which is what used to stall a loaded turret behind its partner.
  let beats = 0;
  while (r.fireReadyAt <= world.time && beats < BB_FIRE_BURST_MAX) {
    let released = false;
    for (const which of exits) {
      const colour = feed(which);
      if (colour === undefined || !lands(which)) continue;
      const rel = bbTurretRelease(r, which, shot?.speed[which] ?? BB_LAUNCH_SPEED_DEFAULT);
      // THE HEIGHT TRAVELS WITH THE POINT. `rel.z` is the hood lip at this turret's CURRENT
      // pitch, not `BB_LAUNCH_Z0` — a turret at full elevation releases ~2.1 in lower than one
      // at rest.
      releasePollen(world, r, rel.vel, undefined, rel.origin, colour, rel.z);
      released = true;
    }
    if (!released) break; // nothing left either exit can fire: stop, and leave the clock alone
    r.fireReadyAt += BB_FIRE_INTERVAL;
    beats++;
  }
  if (beats > 0) r.lastFireAt = world.time;
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
 * A DUMP IS A LOB (owner, 2026-09-13) — the horizontal and vertical launch speed that throws an
 * element up to `BB_DUMP_APEX_ABOVE` over a target `dh` inches above the release and down onto it
 * `d` inches away, or `null` when `d` is outside the dumper's range (`BB_DUMP_MIN_DIST` ..
 * `BB_DUMP_MAX_DIST`) or the throw would exceed `BB_LAUNCH_SPEED_MAX`.
 *
 *   rise h = dh + apex:   vz = √(2·g·h),   t = vz/g + √(2·apex/g),   vh = d / t
 *
 * The apex is always ABOVE the target, so the element always arrives descending — the thing
 * `hiveAccepts` needs, and the thing a fixed hood only managed past its own apex distance. That is
 * why the minimum is geometry alone and a dumper scores from right under the opening's outer lip.
 *
 * ⚠️ **ITS FLIGHT TIME DOES NOT DEPEND ON `d`** — `t = vz/g + √(2·apex/g)`, and `vz` comes from
 * `dh` alone. That is what makes a dumper's LEAD (`bbLeadTime` below) EXACT in one step where a
 * turret's needs a fixed point: the time is known before the throw is solved.
 */
export function bbLobThrow(d: number, dh: number): { vh: number; vz: number } | null {
  if (!(d >= BB_DUMP_MIN_DIST) || d > BB_DUMP_MAX_DIST) return null;
  const rise = dh + BB_DUMP_APEX_ABOVE;
  if (!(rise > 0)) return null;
  const vz = Math.sqrt(2 * GRAVITY * rise);
  const vh = d / (vz / GRAVITY + Math.sqrt((2 * BB_DUMP_APEX_ABOVE) / GRAVITY));
  if (hyp(vh, vz) > BB_LAUNCH_SPEED_MAX) return null;
  return { vh, vz };
}

/** how long a lob to a target `dh` inches above the release spends in the air — see
 * `bbLobThrow`, whose answer this is the closed form of. 0 when there is no lob to make. */
function bbLobTime(dh: number): number {
  const rise = dh + BB_DUMP_APEX_ABOVE;
  if (!(rise > 0)) return 0;
  return Math.sqrt(2 * GRAVITY * rise) / GRAVITY + Math.sqrt((2 * BB_DUMP_APEX_ABOVE) / GRAVITY);
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
 * ── THE RANGE ───────────────────────────────────────────────────────────────
 * Each element is thrown from the actual release height `BB_LAUNCH_Z0` (that is where
 * `releasePollen` puts it) as a LOB (`bbLobThrow`). It has a throw only inside the dumper's range,
 * `BB_DUMP_MIN_DIST`..`BB_DUMP_MAX_DIST` from its own release point; outside it there is no dump to
 * solve, and Aim Assist does not let the dump go.
 */
export function bbDumpSolution(r: RobotState, target: ScoreTarget, n: number): BbThrow[] | null {
  const launcher = bbLauncherOf(r.spec, BB_HOOD_DEFAULT_DEG);
  if (launcher.kind !== 'dumper') return null;
  const dh = target.z - BB_LAUNCH_Z0;
  const { origin, perp, half } = launchLine(r, bbShooterEdgeOf({ shooterMount: launcher.mount }));
  // THE TRAY MOVES WITH THE ROBOT TOO (owner, 2026-09-19). Same model as the turret's: the throw
  // inherits the release point's velocity, so it is solved against a target displaced by
  // `−v·t`. A lob's flight time is a closed form in `dh` alone (`bbLobTime`), so a dumper's lead
  // is EXACT in one step — no fixed point, and with the robot parked every term below is the one
  // that was here before (`x − 0 === x`).
  const tf = bbLobTime(dh);
  const out: BbThrow[] = [];
  const count = Math.max(1, n);
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : (i / (count - 1)) * 2 - 1;
    const o = { x: origin.x + perp.x * t * half, y: origin.y + perp.y * t * half };
    const v = bbPointVel(r, o);
    const dx = target.pos.x - v.x * tf - o.x;
    const dy = target.pos.y - v.y * tf - o.y;
    const d = hyp(dx, dy);
    const lob = bbLobThrow(d, dh);
    if (!lob) return null;
    out.push({ origin: o, vel: { x: (dx / d) * lob.vh + v.x, y: (dy / d) * lob.vh + v.y, z: lob.vz } });
  }
  return out;
}

/**
 * ⚠️ **THE CATAPULT — ONE ARM, ONE VELOCITY, THE WHOLE BUCKET** (owner, 2026-09-19: "a dumper
 * should not shoot one at a time. It holds four in a small 'hopper' and it would fling it like a
 * catapult"). `n` seats' release points and the ONE velocity every one of them leaves with, or
 * `null` when this build is not a dumper or the cluster has no accepted arc.
 *
 * ── WHY IT IS A SECOND FUNCTION AND NOT A FLAG ON `bbDumpSolution` ──────────
 * `bbDumpSolution` CONVERGES: each element is aimed from its own seat at the cell centre, which
 * removes the chassis-heading error and is free in 2D, where a flight element collides with
 * nothing at all. In 3D every one of them is a real sphere, and four spheres converging on one
 * point meet in the opening — measured 3/28 on the tutorial grid, which is why 3D used to POUR
 * one element every 0.3 s instead (`BB_DUMP_BUCKET`'s header has the whole history). The 2D
 * pipeline is permanent, so `bbDumpSolution` stays exactly what it is and 2D goes on calling it;
 * **this is the 3D pipeline's solve**, and the two differ because the two physics genuinely do.
 *
 * ── THE GEOMETRY: TWO ACROSS AND TWO HIGH, ON THE END OF AN ARM ─────────────
 * The seats are a 2x2 at `BB_DUMP_SEAT_PITCH` — two side by side ACROSS the firing edge and two
 * STACKED above them, which is how four balls sit in a bucket and not how four balls sit in a
 * trough. Two consequences, both load-bearing:
 *  · the cluster's PLAN footprint is `pitch` wide and NOTHING deep, so what has to fit the cell
 *    opening is 4 + 3.6 = 7.6 in against a 10.18-in short axis at ANY approach bearing. A 2x2
 *    laid flat is 5.66 in across its diagonal and only just fits at 45°;
 *  · the upper pair rides exactly `pitch` above the lower pair for the WHOLE flight (same
 *    velocity, same gravity), so the pair that lands second lands on top of the pair that landed
 *    first — which is what a flung bucket does.
 * The bucket sits ON the firing edge's own COLLISION FOOTPRINT — the frame face for an edge with
 * no sweeper, which is exactly the line every dump has released from since the dumper shipped.
 * ⚠️ IT WAS TRIED FURTHER OUT, on the grounds that a release point inside the chassis is one
 * `birthClear` has to march out along the arc. It is a straight loss: every inch of arm is an
 * inch nearer the HIVE, and what kills a close-range lob is the structure it has to clear on the
 * way up. MEASURED on the 28-pose grid, elements in the CELL out of 112 — arm 0: **70**, 1: 64,
 * 2.5: 57, 4: 49.
 *
 * The throw is solved from the CENTROID of the seats used (in x, y AND z), and every element gets
 * that ONE velocity — so the cluster's relative offsets are preserved exactly, it cannot collide
 * with itself, and its footprint at the opening is its footprint in the bucket. The rigid arm's
 * outboard seats would really leave a touch faster; that spread is NOT modelled, because the only
 * thing it could buy is a cluster that spreads on the way, and spreading is the failure this
 * function exists to avoid.
 *
 * The inherited velocity (shooting on the move) is read ONCE at the centroid for the same reason —
 * a per-seat `ω × r` would make the cluster converge or diverge under a spinning chassis.
 */
export function bbDumpCluster(
  r: RobotState,
  target: ScoreTarget,
  n: number,
): { seats: { pos: Vec2; z: number }[]; vel: Vec3 } | null {
  const launcher = bbLauncherOf(r.spec, BB_HOOD_DEFAULT_DEG);
  if (launcher.kind !== 'dumper') return null;
  const count = clamp(Math.trunc(n), 1, BB_DUMP_BUCKET);
  const edge = bbShooterEdgeOf({ shooterMount: launcher.mount });
  const { origin, dir, perp } = launchLine(r, edge);
  const s = BB_DUMP_SEAT_PITCH;
  // THE BUCKET SITS ON THE FIRING EDGE'S OWN COLLISION FOOTPRINT. `launchLine`'s origin is the
  // FRAME FACE, which for an edge with no sweeper on it is the same point — i.e. exactly the
  // release line every dump has always used — and for an edge that does carry one it is pushed
  // out past the roller, so the bucket is never born inside the intake's plates.
  const f = bbFootprint(r.spec);
  const out =
    (edge === 'front' ? f.front : edge === 'back' ? f.rear : f.half) -
    (edge === 'front' || edge === 'back' ? r.spec.length / 2 : r.spec.width / 2);
  const seats: { pos: Vec2; z: number }[] = [];
  let cx = 0;
  let cy = 0;
  for (let k = 0; k < count; k++) {
    const dv = (k % 2 === 0 ? -s : s) / 2;
    const z = BB_LAUNCH_Z0 + (k < 2 ? 0 : s);
    const pos = { x: origin.x + dir.x * out + perp.x * dv, y: origin.y + dir.y * out + perp.y * dv };
    seats.push({ pos, z });
    cx += pos.x;
    cy += pos.y;
  }
  cx /= count;
  cy /= count;
  // ⚠️ SOLVED FROM THE BOTTOM ROW'S HEIGHT, NOT THE BUCKET'S MID-HEIGHT. The bottom row then flies
  // EXACTLY the arc a single-element dump has always flown, and the top row rides `pitch` above it
  // — which is the safe direction, since what a close-range lob clips is the structure BELOW the
  // opening. Solved from the mid-height instead, the bottom row sits `pitch/2` under that arc and
  // the grid below loses two rows (measured 18/28 poses against 20/28).
  const dh = target.z - BB_LAUNCH_Z0;
  const tf = bbLobTime(dh);
  const v = bbPointVel(r, { x: cx, y: cy });
  const dx = target.pos.x - v.x * tf - cx;
  const dy = target.pos.y - v.y * tf - cy;
  const d = hyp(dx, dy);
  const lob = bbLobThrow(d, dh);
  if (!lob) return null;
  return { seats, vel: { x: (dx / d) * lob.vh + v.x, y: (dy / d) * lob.vh + v.y, z: lob.vz } };
}

/**
 * ⚠️ **THE MUZZLE — THE ONE FUNCTION THE PICTURE AND THE PHYSICS BOTH READ.**
 *
 * Where the hood lip is at elevation `pitch`, in the TURRET FRAME (origin on the turret's
 * ROTATION AXIS): `z` off the tiles, and `back` how far BEHIND that axis the lip sits along the
 * turret's own heading. The lip rides the element's path circle about the FLYWHEEL AXLE, and the
 * axle is `axleX` FORWARD of the rotation axis, so it is one rotation of `pathR` less that
 * offset:
 *
 *     back = pathR · sin p − axleX        z = BB_TURRET_AXLE_Z + pathR · cos p
 *
 * ⚠️ **`back` IS NORMALLY NEGATIVE, AND THAT IS THE CHANGE.** `axleX = pathR` (the element comes
 * up the rotation axis and pinches there), so the lip is a full `pathR` FORWARD of the axis at
 * rest and creeps back toward it as the hood elevates — it never gets behind it. POLLEN: (−2.517,
 * 9.635) level, (−0.038, 7.554) at the 80° cap. NECTAR is a bigger head and a higher one:
 * (−2.917, 10.035) and (−0.044, 7.624).
 *
 * ⚠️ **AND `which` PICKS THE HEAD.** Turret 0 throws POLLEN on every build and turret 1 is the
 * DOUBLE turret's NECTAR exit; a 3.6-in element wants a bigger hood, a wider channel and a
 * further-forward axle than a 2.8-in one (`BbHeadDims`, `config.ts`), so the two muzzles differ.
 *
 * ⚠️ **IT LIVES HERE, NOT IN THE RENDERER.** Nothing outside `scene/` may import from `scene/`,
 * so a formula that lived there could only ever have had one reader — which is exactly how the
 * shooter reached a sixth review pass with the drawing and the ballistics disagreeing. The 3D
 * scene builds `bb-turret-pitch` about the AXLE and reads this for the muzzle; the sim releases
 * here and solves against here. Same rule as `shotPath.ts`: ONE PREDICTOR, TWO DRAWINGS.
 *
 * Deterministic trig (`dsin`/`dcos`), because this is sim code on the release path.
 */
export function bbMuzzleLocal(pitch: number, which: 0 | 1 = 0): { back: number; z: number } {
  const h = bbHead(which);
  const p = clamp(pitch, BB_TURRET_PITCH_MIN, BB_TURRET_PITCH_MAX);
  return { back: h.pathR * dsin(p) - h.axleX, z: BB_TURRET_AXLE_Z + h.pathR * dcos(p) };
}

/**
 * how high above the tiles this build's element leaves the mechanism at elevation `pitch` (in).
 *
 * ⚠️ IT IS THE RELEASE HEIGHT, AND THE RELEASE READS IT. `releasePollen` (`elements.ts`) is
 * handed this for a turret shot, so the height the arc was solved from and the height the element
 * is actually born at cannot drift: the turret once solved from 2 in above the release and every
 * turret shot arrived 2 in low, which is the bug this function exists to make impossible.
 *
 * ⚠️ **A DUMPER HAS NO HOOD, SO ITS RELEASE IS STILL FLAT.** `BB_LAUNCH_Z0` is a tipping tray's
 * lip, it does not swing about a flywheel axle, and the turret's change must not leak into it —
 * `bbLobThrow`, `bbDumpSolution` and `bbLaunch`'s dumper branch all still use `BB_LAUNCH_Z0`
 * directly, and this returns it unchanged for a turretless build whatever `pitch` says.
 *
 * `pitch` defaults to the rest pose (`BB_TURRET_PITCH_MIN`), which is the muzzle a caller with no
 * elevation in hand means; `which` defaults to the POLLEN turret, which every turreted build has.
 */
export function bbMuzzleZ(spec: RobotSpec, pitch: number = BB_TURRET_PITCH_MIN, which: 0 | 1 = 0): number {
  if (!bbIsTurreted(bbLauncherOf(spec, BB_HOOD_DEFAULT_DEG))) return BB_LAUNCH_Z0;
  return bbMuzzleLocal(pitch, which).z;
}

/**
 * THE WHOLE TURRET SOLUTION — yaw, elevation and muzzle speed — to put an element into `target`
 * from turret `which`, or `null` when this build has no such turret (a dumper, or turret 1 on a
 * single turret).
 *
 * ⚠️ ALL THREE, TOGETHER, BECAUSE THE ARC IS ONE ANSWER AND NOT THREE. `bbSolveShot` returns a
 * MATCHED (speed, angle) pair. The pitch is clamped into the barrel's real envelope and the speed
 * into `BB_LAUNCH_SPEED_MAX`, so a solution the hardware cannot reach comes back as the nearest
 * one it can — which then MISSES, honestly — and says so in `reachable`, which stage 5b reads before
 * running Aim Assist's landing prediction.
 *
 * ── ⚠️ AND IT IS A FIXED POINT, BECAUSE THE MUZZLE FOLLOWS THE HOOD ─────────
 * The elevation moves the release (`bbMuzzleLocal`: lower, and further back along the heading),
 * and the release moves the elevation the arc asks for. That circularity is the hardware's, not
 * a modelling choice, so the solve iterates it: start level, solve, re-read the muzzle at the
 * pitch that came out, solve again. `BB_TURRET_SOLVE_PASSES` passes, ALWAYS — no early exit and
 * no tolerance, because a trip count that depends on a float comparison is a trip count that can
 * differ between a client's prediction and the server's authority. The map converges
 * geometrically (the release moves by well under an inch for a degree of pitch at the ranges a
 * HIVE shot lives at): MEASURED over 7,688 field poses, a fifth pass moves the pitch by at most
 * 1.76e-9 rad.
 *
 * MEASURED CONSEQUENCE, over the whole 2-in field grid at both cells: scoreable cells go
 * 1359 → 1382 (north) and 1417 → 1439 (south), pitch-capped cells 255 → 211, nothing is
 * speed-capped, and the worst required muzzle speed rises from 253.26 to 256.37 against a 260
 * cap. The release is ~2.1 in lower at hive elevations, which costs a little speed and unblocks
 * more of the field than it loses — the owner authorised the outcome change knowingly.
 *
 * ── ⚠️ AND IT LEADS, BECAUSE THE MUZZLE IS MOVING ───────────────────────────
 * (owner, 2026-09-19: "animate the turret properly so that it has a 'shooting on the move'
 * correction algorithm built in".) A release inherits the muzzle's own velocity now
 * (`bbTurretRelease` / `bbPointVel`), so the element's world velocity is `speed·û + v` and the
 * only way to put it in the cell is to solve the plain ballistic problem against a VIRTUAL target
 * displaced by `−v · t_flight`:
 *
 *     s·û·t − ½g t² ẑ = (T − muzzle) − v·t     ⇒     solve to T' = T − v·t, fire at s along û, +v
 *
 * That is exact, and it is exactly what the identity above says. `t` is a function of the
 * solution, so it is a second fixed point over the first — FOLDED INTO THE SAME
 * `BB_TURRET_SOLVE_PASSES` loop, with the flight time of pass `i` feeding pass `i+1`. No early
 * exit, no tolerance, same reason as the muzzle's.
 *
 * ⚠️ **A PARKED ROBOT IS BYTE-IDENTICAL.** Every lead term is `v · t` with `v` exactly zero, and
 * `x − 0 === x` in IEEE, so a stopped robot runs the same floats through the same four passes and
 * the field's scoreable-cell counts above do not move. The ROBOT lane pins it.
 *
 * ⚠️ **THE SEED PASS COSTS ONE EXTRA `bbSolveShot` AND BUYS A FACTOR OF FOUR.** The loop's first
 * pass needs a flight time before it has a solution; starting it at zero (no lead at all) leaves
 * three refinements to walk ~53 in of displacement down, and the contraction factor `|v|·dt/dd'`
 * is only ~0.2–0.3 at HIVE ranges. A no-lead solve at the level muzzle, used ONLY to estimate
 * `t`, starts the loop 4x closer — and it cannot disturb the byte-identity above, because
 * whatever it estimates is multiplied by a zero velocity.
 *
 * MEASURED residual — the distance from the cell centre to where the solved shot actually lands
 * with the turret exactly on its own solution, over 2,567 reachable pose-headings (a 6-in field
 * grid by eight headings) at the drivetrain's top speed of 89 in/s: **mean 0.140 in, p50 0.124,
 * p99 0.305, worst 1.749**, against a 20.14 x 10.18-in opening. The same poses with the pre-lead
 * solve — solved parked, fired at 89 in/s — miss by **mean 53.22 in, worst 63.58**, i.e. the lead
 * is not a refinement of the old answer, it is the difference between scoring and not.
 */
export function bbTurretSolution(
  r: RobotState,
  target: ScoreTarget,
  which: 0 | 1 = 0,
): { yaw: number; pitch: number; speed: number; reachable: boolean } | null {
  const launcher = bbLauncherOf(r.spec, BB_HOOD_DEFAULT_DEG);
  if (!bbIsTurreted(launcher)) return null;
  if (which === 1 && launcher.kind !== 'twinturret') return null;
  // FROM THE TURRET'S BOLT POINT, NOT THE CHASSIS CENTRE — see `bbTurretOrigin`. The muzzle's own
  // SETBACK from that point is the `back` term inside the loop, and it grows with elevation.
  const o = bbTurretOrigin(r, which);
  // THE VELOCITY THE RELEASE WILL CARRY, read at the muzzle the turret has RIGHT NOW — the same
  // point `bbTurretRelease` releases from, so the solve and the shot lead by the same vector.
  const v = bbPointVel(r, bbMuzzlePoint(r, which));
  const dh0 = target.z - bbMuzzleZ(r.spec, BB_TURRET_PITCH_MIN, which);
  const back0 = bbMuzzleLocal(BB_TURRET_PITCH_MIN, which).back;
  // the SEED — a no-lead solve at the level muzzle, read for its FLIGHT TIME only.
  let d = hyp(target.pos.x - o.x, target.pos.y - o.y) + back0;
  let t = flightTime(bbSolveShot(d, dh0), d);

  // PASS 1 starts from the LEVEL muzzle and every later pass re-reads it at the pitch the
  // previous one produced. It used to skip the `back` term on the first pass, on the grounds
  // that a level lip sat exactly over the bolt point; it does not any more — the lip is a full
  // `axleX` in FRONT of the rotation axis at rest — so the first pass reads the muzzle like the
  // rest and the loop is one shape.
  let pitch = BB_TURRET_PITCH_MIN;
  let dx = target.pos.x - v.x * t - o.x;
  let dy = target.pos.y - v.y * t - o.y;
  d = hyp(dx, dy) + back0;
  let sol = bbSolveShot(d, dh0);
  for (let i = 1; i < BB_TURRET_SOLVE_PASSES; i++) {
    pitch = clamp(sol.angle, BB_TURRET_PITCH_MIN, BB_TURRET_PITCH_MAX);
    const m = bbMuzzleLocal(pitch, which);
    t = flightTime(sol, d);
    dx = target.pos.x - v.x * t - o.x;
    dy = target.pos.y - v.y * t - o.y;
    d = hyp(dx, dy) + m.back;
    sol = bbSolveShot(d, target.z - bbMuzzleZ(r.spec, pitch, which));
  }
  pitch = clamp(sol.angle, BB_TURRET_PITCH_MIN, BB_TURRET_PITCH_MAX);
  return {
    yaw: datan2(dy, dx),
    pitch,
    speed: Math.min(sol.speed, BB_LAUNCH_SPEED_MAX),
    reachable: sol.speed <= BB_LAUNCH_SPEED_MAX && pitch === sol.angle,
  };
}

/**
 * How long a `bbSolveShot` answer spends in the air covering `d` inches of ground — `d /
 * (speed · cos angle)`, the horizontal leg of its own arc.
 *
 * BOUNDED, because it is fed straight back into a lead displacement: a near-vertical solution has
 * `cos angle → 0`, and an unbounded flight time there would throw the virtual target off the
 * field. The bound is the four seconds `bbFlightEnters` integrates for, which is already past any
 * arc a legal launch speed can make; a non-finite or negative answer reads as 0, which is "no
 * lead", the honest fallback.
 */
function flightTime(sol: { speed: number; angle: number }, d: number): number {
  const vh = sol.speed * dcos(sol.angle);
  if (!(vh > 1e-6)) return 0;
  const t = d / vh;
  return t > 0 ? Math.min(t, 4) : 0;
}

/** The ELEVATION turret 0 must be at to put an element into `target`, in RADIANS, or `null` when
 * this build has no turret to elevate. The pitch half of `bbTurretSolution`. */
export function bbAimPitch(r: RobotState, target: ScoreTarget): number | null {
  return bbTurretSolution(r, target)?.pitch ?? null;
}

/**
 * ⚠️ **ONE AXIS OF THE TURRET, MOVED LIKE A MECHANISM RATHER THAN LIKE A CLAMP** — a rate AND
 * acceleration limited step that decelerates into its target and does not overshoot or ring.
 *
 * ── WHY A RATE CLAMP IS NOT AN ANIMATION ────────────────────────────────────
 * `angle += clamp(err, ±W·dt)` reaches full speed in ONE tick and stops dead in ONE tick. On
 * screen that is a barrel that snaps into a constant sweep and freezes — which is the owner's
 * "animate the turret properly" (2026-09-19), and it is not a picture problem: the yaw and pitch
 * ARE sim state and the renderer only draws them, so the only way to animate the mechanism is to
 * move the mechanism properly.
 *
 * ── THE PROFILE, AND WHY IT IS THE DISCRETE ONE ─────────────────────────────
 * Bang-bang with a stopping distance: carry the most speed from which the remaining error can
 * still be killed at `maxAcc`. Written continuously (`v ≤ √(2A|e|)`) that CHATTERS at 60 Hz —
 * inside `2A·dt²` (0.033 rad at the shipped cap, i.e. 1.9°) one tick's step overshoots, the error
 * flips sign and the barrel buzzes. So the cap is the exact DISCRETE one: decelerating from
 * `n` ticks' worth of speed covers `A·dt²·n(n+1)/2`, so
 *
 *     n_max = (√(1 + 8|e|/(A·dt²)) − 1) / 2       v_cap = min(W, A·dt·n_max)
 *
 * lands exactly on the target with the velocity reaching exactly zero, every change inside
 * `A·dt`, at any `|e|`. No tolerance, no snap, no oscillation — and no float-dependent branch,
 * so a client's prediction and the server's authority take the same path.
 *
 * ── ⚠️ `base` IS THE THING THE MOUNT IS TURNING AT, AND IT IS NOT FEED-FORWARD ──
 * `turretHeading` is a WORLD angle (`bbTurretRelease` fires along `dcos(h)` directly; the 3D
 * scene draws `heading − r.heading`). A real turret on a rotating base holds a world bearing by
 * COUNTER-ROTATING, and its motor only has `W` to spend: so the reachable world rate is the
 * window `[base − W, base + W]` centred on the chassis's own yaw rate, not `[−W, W]`. A robot
 * spinning at 3 rad/s can still hold a bearing for free (0 is inside [−4, 10]) and a robot
 * spinning FASTER than the turret can counter is DRAGGED, at exactly the difference. The pitch
 * axis passes `base = 0`: chassis yaw does not tilt a barrel.
 *
 * Returns the new angle and the new rate; the caller stores both.
 */
function slewAxis(
  cur: number,
  want: number,
  vel: number,
  maxRate: number,
  maxAcc: number,
  base: number,
  dt: number,
  wrap: boolean,
): { at: number; vel: number } {
  const e = wrap ? wrapAngle(want - cur) : want - cur;
  // ⚠️ `q` IS ONE TICK'S WORTH OF ACCELERATION EXPRESSED AS A DISTANCE, and the whole profile is
  // written in units of it: `E` is the remaining error in those units and `u` is the velocity, in
  // ticks' worth of acceleration, that this tick may END at.
  //
  // Braking at full `maxAcc` from `u`, the velocities that follow are `u−1, u−2, …` down to zero,
  // so the distance from here to a standstill is `q·((f+1)u − f(f+1)/2)` with `f = floor(u)`.
  // That is PIECEWISE LINEAR in `u`, and the closed form below inverts it: `f` is the largest
  // whole number of braking ticks that fits inside `E`, and `u` is the interpolation inside that
  // piece. ⚠️ The smooth `√(2E)` version of this is WRONG for `u < 1` and it overshoots — it
  // charges `u(u+1)/2` for a stop that really costs `u`, so a turret one tick from its target
  // stepped past it and then rang for hundreds of ticks at ±0.14°. Measured, and it is the reason
  // this is not the two-line formula it looks like it should be.
  const q = maxAcc * dt * dt;
  const E = Math.abs(e) / q;
  const f = Math.floor((Math.sqrt(1 + 8 * E) - 1) / 2);
  const u = Math.min(f + 1, (E + (f * (f + 1)) / 2) / (f + 1));
  const cap = Math.min(maxRate, maxAcc * dt * u);
  // the world rate we WANT this tick, pulled into the motor's own window (see `base` above)
  const step = maxAcc * dt;
  const w = clamp(clamp(e >= 0 ? cap : -cap, base - maxRate, base + maxRate) - vel, -step, step) + vel;
  // QUANTIZED to 1e-4 rad/s, the grain the 3D readback already rounds to — 0.0014% of the yaw rate,
  // and what keeps four floats per robot per 30 Hz snapshot from being 17 digits each
  // (`RobotState.bbTurretYawVel`). TOWARD ZERO, never to nearest: rounding up would put the tick's
  // step above the cap the profile just proved is safe, which is an overshoot by a rounding error.
  const v2 = Math.trunc(w * 1e4) / 1e4;
  // ...and the last grain lands exactly. Under one quantum the truncated rate is zero, so without
  // this the axis would sit forever a micro-radian short of its target (measured 1.3e-6 rad) and
  // "the turret is on its solution" would never be exactly true.
  if (v2 === 0 && Math.abs(e) <= 1e-4 * dt) return { at: want, vel: 0 };
  const at = cur + v2 * dt;
  return { at: wrap ? wrapAngle(at) : at, vel: v2 };
}

/**
 * Ease turret `which`'s yaw and pitch toward a solution, one tick's worth. BOTH AXES SLEW, and
 * neither snaps; pitch is deliberately the slower axis. Turret 1 (a double turret's NECTAR
 * turret) writes `bbTurret2Heading` / `bbTurret2Pitch`, so only a caller that has a second
 * turret should name it.
 *
 * ⚠️ **IT IS A RATE AND AN ACCELERATION NOW** (`slewAxis` above, owner 2026-09-19). The per-axis
 * angular VELOCITY is carried on `RobotState` (`bbTurretYawVel` and friends, optional, absent
 * reads 0), because an acceleration limit constrains the change of a velocity and a velocity that
 * is not carried is not a velocity. The pitch axis is clamped into the barrel's envelope AFTER
 * the profile, and a clamp that bites kills the rate with it — a barrel resting on its stop is
 * not still elevating.
 */
export function bbSlewTurret(
  r: RobotState,
  wantYaw: number | null,
  wantPitch: number | null,
  dt: number,
  which: 0 | 1 = 0,
): void {
  if (wantYaw !== null) {
    const now = which === 1 ? (r.bbTurret2Heading ?? r.turretHeading) : r.turretHeading;
    const was = (which === 1 ? r.bbTurret2YawVel : r.bbTurretYawVel) ?? 0;
    // the CHASSIS's own yaw rate is the base the turret ring is bolted to — see `slewAxis`
    const s = slewAxis(now, wantYaw, was, BB_TURRET_SLEW, BB_TURRET_ACCEL, r.angVel, dt, true);
    if (which === 1) {
      r.bbTurret2Heading = s.at;
      r.bbTurret2YawVel = s.vel;
    } else {
      r.turretHeading = s.at;
      r.bbTurretYawVel = s.vel;
    }
  }
  if (wantPitch !== null) {
    const now = (which === 1 ? r.bbTurret2Pitch : r.bbTurretPitch) ?? 0;
    const was = (which === 1 ? r.bbTurret2PitchVel : r.bbTurretPitchVel) ?? 0;
    const s = slewAxis(now, wantPitch, was, BB_TURRET_PITCH_SLEW, BB_TURRET_PITCH_ACCEL, 0, dt, false);
    const at = clamp(s.at, BB_TURRET_PITCH_MIN, BB_TURRET_PITCH_MAX);
    // A BARREL ON ITS STOP IS NOT STILL MOVING. Without this the rate keeps its sign against the
    // clamp, and the tick the target comes back inside the envelope the profile starts from a
    // velocity the axis never had.
    const vel = at === s.at ? s.vel : 0;
    if (which === 1) {
      r.bbTurret2Pitch = at;
      r.bbTurret2PitchVel = vel;
    } else {
      r.bbTurretPitch = at;
      r.bbTurretPitchVel = vel;
    }
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

// ─────────────────────────────────────────────────────────────────────────────
// THE RAMP TOGGLE (`ramp` intake only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * DEPLOY / FOLD the `ramp` intake's U-frame — the one caller of `RobotCommand.bbRamp`, called
 * from both pipelines at the same place the turret slew runs (`play.ts` stage 5b,
 * `sim3d/elements3d.ts`'s `elements3dAimAndLaunch`), with the same `enabled` those passes gate
 * driver control on.
 *
 * EDGE-TRIGGERED like `driveMode` (`src/sim/robot.ts:100`) — a held button flips the ramp once,
 * not every tick — but with its OWN latch (`bbRampHeld`) rather than reusing `driveModeHeld`,
 * because a butterfly-drivetrain ramp build would otherwise fold its ramp every time it swapped
 * wheel sets.
 *
 * ⚠️ **A NON-RAMP BUILD WRITES NO FIELD AT ALL.** `bbIntakeKindOf(r.spec) !== 'ramp'` returns
 * before touching `r` — `bbRampOut`/`bbRampAt`/`bbRampHeld` all stay `undefined`, which is what
 * keeps the 2D pipeline byte-identical for every spec that existed before this archetype did
 * (`npm test` hashes worlds). `enabled` false (pre-match, a phase transition, post-match) drops
 * the press on the floor the same way drive/intake/fire do, rather than letting it queue.
 *
 * ⚠️ **DEBOUNCED: A RELEASE SHORTER THAN `TOGGLE_DEBOUNCE_S` IS NOT A RELEASE** (`debouncedPress`). Replay
 * 1dc6eb8f (2026-09-25) held the ramp button through two one-tick dropouts — one a whole input
 * frame of zeros, a gamepad read that came back empty — and each flipped the ramp twice. The
 * driver saw it deploy and fold for no reason. The latch now stays set through a short gap;
 * `bbRampUpAt` is when the button went up, so the latch clears only once the gap is long
 * enough. The fastest real re-press in that replay's mashing was 3 ticks.
 */
export function bbRampStep(r: RobotState, cmd: RobotCommand | undefined, enabled: boolean, time: number): void {
  if (bbIntakeKindOf(r.spec) !== 'ramp') return;
  const e = debouncedPress(r.bbRampHeld ?? false, r.bbRampUpAt, enabled && (cmd?.bbRamp ?? false), time);
  if (e.press) {
    r.bbRampOut = !(r.bbRampOut ?? false);
    r.bbRampAt = time;
    // A FRESH PRESS RE-ARMS THE SWING GUARD (owner, 2026-09-20: a swing that would carry the
    // ramp into a static reverses, and — once reversed — does not test again for the REST of
    // that one swing, because it is retracing a path already proven clear). This new press is a
    // DIFFERENT swing, so it gets to test again.
    r.bbRampBlocked = false;
  }
  r.bbRampHeld = e.held;
  if (e.upAt !== undefined || r.bbRampUpAt !== undefined) r.bbRampUpAt = e.upAt;
}

/**
 * THE RAMP'S DEPLOY FRACTION RIGHT NOW, `e` in `[0, 1]` — 0 folded, 1 fully deployed — the ONE
 * eased curve both the sim's swing-collision guard (`bbRampSwingShapes`, `bodies.ts`) and the
 * renderer's own ease use, so the physics box and the drawn ramp cannot show two different poses
 * for the same tick. `null` when there is no swing in flight (settled either way, or never
 * toggled) — the caller's cue to skip the guard's own (Rapier or 2D-rect) query entirely.
 *
 * The curve is the standard smoothstep `t²(3−2t)` over `t = (time − bbRampAt) / BB_RAMP_DEPLOY_S`
 * — DEPLOYING (`bbRampOut` true) sweeps `e` from 0 to 1, FOLDING sweeps it from 1 to 0 (`1 − e`),
 * so a fold started at any point along a deploy retraces the SAME angle curve backward rather
 * than snapping.
 */
export function bbRampSwingProgress(r: RobotState, time: number): number | null {
  if (bbIntakeKindOf(r.spec) !== 'ramp') return null;
  const at = r.bbRampAt;
  if (at === undefined) return null;
  const elapsed = time - at;
  if (elapsed < 0 || elapsed >= BB_RAMP_DEPLOY_S) return null; // settled, either way
  const t = clamp(elapsed / BB_RAMP_DEPLOY_S, 0, 1);
  const e = t * t * (3 - 2 * t);
  return r.bbRampOut ? e : 1 - e;
}

/**
 * REVERSE A BLOCKED SWING (owner, 2026-09-20: "if it collides with the flower or any non-moving
 * solid thing as it is being deployed, it should fold back up... same with un-deploying"). Flips
 * `bbRampOut` and re-stamps `bbRampAt` so the SAME smoothstep curve (`bbRampSwingProgress`) picks
 * up from exactly the CURRENT angle running the other way — symmetric, so no visible or physical
 * snap — and sets the oscillation guard so this one swing is not tested again (it can only ever
 * retrace ground already proven clear). `elapsed` is the caller's own `time − (the OLD bbRampAt)`,
 * from just before this call flips it.
 */
export function bbRampReverse(r: RobotState, time: number, elapsed: number): void {
  r.bbRampOut = !r.bbRampOut;
  r.bbRampAt = time - (BB_RAMP_DEPLOY_S - elapsed);
  r.bbRampBlocked = true;
}

/**
 * Is the ramp not merely OUT but SETTLED — `BB_RAMP_DEPLOY_S` past its last toggle, the swing
 * time a servo-driven U-frame actually takes? The ONE reader is `bbFlowerReachOf`'s caller
 * (`play.ts`'s `retrieveFromFlower`, `sim3d/flower3d.ts`'s `flowerRetrieve3d`): a ramp mid-swing
 * reaches nothing, exactly like a folded one.
 *
 * Absent `bbRampAt` (the ramp has never been toggled) reads as SETTLED rather than unsettled —
 * there is no swing in flight to wait out, which matters only for `bbRampOut` written some other
 * way (a staged scene, a future spawn default) with no matching stamp.
 */
export function bbRampSettled(r: RobotState, time: number): boolean {
  return !!r.bbRampOut && time - (r.bbRampAt ?? -Infinity) >= BB_RAMP_DEPLOY_S;
}

/**
 * `BbIntakeOpts.extraReach` FOR THIS ROBOT RIGHT NOW — the ONE predicate both `bbIntakeAct`
 * callers (`play.ts`'s `step2d`, `sim3d/elements3d.ts`'s `elements3dCapture`) compute it from, so
 * 2D and 3D cannot disagree about how far a deployed ramp's own pull reaches (owner report
 * 2026-09-20, ramp intake) or a side roller's (owner ruling 2026-09-20: "it should also be
 * colliding with everything... a physical thing" — a physical release needs the pull to reach out
 * to where it lands, see `flowerRetrieve3d`'s side-roller branch). A DEPLOYED, SETTLED `ramp`
 * reaches `BB_RAMP_OUT`, the crossbar's own reach past the roller line (`uOut`) — a folded or
 * still-swinging ramp has no reach hardware out there to pull an element off of, exactly the same
 * gate `bbFlowerReachOf`'s caller already uses. `siderollers` always reaches
 * `BB_SIDE_ROLLER_PROTRUDE`, the wheel's own FRONT past the roller line (`chassis3dReachShapes`'s own
 * placement) — there is no fold/settle state for a wheel that is always mounted. Every other build
 * is zero.
 */
export function bbIntakeExtraReach(r: RobotState, time: number): number {
  const kind = bbIntakeKindOf(r.spec);
  if (kind === 'ramp') return bbRampSettled(r, time) ? BB_RAMP_OUT : 0;
  if (kind === 'siderollers') return BB_SIDE_ROLLER_PROTRUDE;
  return 0;
}
