/**
 * Chain Reaction (presented by goBILDA) — field + element constants.
 *
 * The 2026 Unofficial-FTC CAD-competition game. Values from the competition manual
 * (`cm.pdf` — its page streams are corrupt/unrenderable, so the numbers here come
 * from the manual PAGES the user supplied as images + explicit dimensions). mm are
 * converted to the sim's INCH world via `mm()` (÷25.4).
 *
 * Field: standard FTC 12'×12' (144") soft-tile field, origin at center, +x =
 * audience right, +y away from the audience. RED alliance = LEFT (columns A–C, from
 * the audience), BLUE = RIGHT (columns D–F).
 *
 * ── Terminology (manual §2–4) ──────────────────────────────────────────────
 *  • ACCELERATOR — the alliance goal: launch PARTICLES into it (1 pt each). Sits
 *    OUTSIDE each alliance's side wall (red left, blue right).
 *  • PARTICLE — a 3"-OD wiffle ball (300 of them). Launchable from ANYWHERE.
 *
 * ── Automation (manual §3.1) — particles are NEVER consumed ─────────────────
 *  The ACCELERATOR has an auto-score + REJECT system: a launched particle is
 *  counted (scores) then LAUNCHED BACK onto the field. Pre-match it distributes all
 *  300 particles across the field (randomization); during teleop it keeps
 *  re-distributing scored particles back out. So the field always holds ~300
 *  particles. The HOOK has its own auto-score confirming a Catalyst is seated and
 *  applying the +1 pt/particle bonus. (Implement this recycle loop when particles
 *  land — a particle entering the accelerator scores + respawns onto the field.)
 *  • CATALYST — a 6"-OD purple ring (4 of them). Placed on a HOOK ⇒ +1 pt/particle.
 *  • HOOK — on the accelerator wall (this file's `CHAIN_HOOK_Y`); holds a Catalyst.
 *  • RING STAND — a 22.5" vertical steel pole at the field corners; robots ASCEND
 *    (endgame, 20 pt) / DESCEND (auto, 20 pt) it.
 *  • LAB AREA — each alliance's start/park zone (leave 5 pt auto / park 5 pt endgame).
 *  • PARTICLE ZONE — the center diamond of white tape (neutral, unprotected).
 *
 * STILL A SHELL: robots are drivable + wall-contained and the ACCELERATORS, HOOKS,
 * RING STANDS and PARTICLE ZONE are placed/drawn. Scoring/particles/catalysts and
 * the Lab-Area / column-grid geometry are NOT implemented yet (exact field-zone
 * coordinates for the Particle Zone, Lab Areas, and Ring-Stand positions are still
 * needed — approximations below are FLAGGED).
 */

import type { ChainIntakeStyle, ChainScoreMode, RobotSpec } from '../../types';

/** millimetres → inches (the sim's world unit) */
export const mm = (v: number): number => v / 25.4;

/** field half-extents (inches). Square 12'×12', walls at ±72 (like DECODE). */
export const CHAIN_HALF_X = 72;
export const CHAIN_HALF_Y = 72;

/** perimeter-wall build params (inner faces exactly at ±half) */
export const CHAIN_WALL_T = 10; // half-thickness, well outside the field

/**
 * ACCELERATORS — the alliance goals, OUTSIDE each side wall (red left x<0, blue
 * right x>0), directly adjacent and centered in y. `DEPTH` = protrusion out of the
 * wall (x); `WIDTH` = extent along the wall (y). Manual: 697.49752mm × 1393.65mm.
 */
export const CHAIN_ACCEL_DEPTH = mm(697.49752); // 27.4605" out of the wall (x)
export const CHAIN_ACCEL_WIDTH = mm(1393.65); // 54.8681" along the wall (y)
export const CHAIN_ACCEL_HALF_Y = CHAIN_ACCEL_WIDTH / 2; // 27.4341"

/**
 * HOOKS — on each accelerator wall at y = ±688.09375mm (both walls, both signs ⇒
 * four hooks total). A CATALYST placed on a hook multiplies that accelerator's
 * particle points. Manual value.
 */
export const CHAIN_HOOK_Y = mm(688.09375); // ±27.0903" along the wall

/**
 * ELEMENT specs (manual §4). Used when particles/catalysts are added.
 */
export const CHAIN_PARTICLE_R = 3 / 2; // 3" OD ball → 1.5" radius (300 on field)
export const CHAIN_CATALYST_OD = 6; // 6" OD ring, 1" thick (4 total)
export const CHAIN_RINGSTAND_H = 22.5; // vertical climb pole height (context only)
export const CHAIN_PARTICLE_COUNT = 300;
export const CHAIN_CATALYST_COUNT = 4;

/**
 * SCORING (manual §3) — for when scoring lands. Particle 1 pt; each Catalyst on a
 * hook adds +1 pt per particle scored in that accelerator; Ring-Stand descend 20 pt
 * (auto) / ascend 20 pt (endgame); Lab-Area leave 5 pt (auto) / park 5 pt (endgame).
 */
export const CHAIN_PTS = {
  particle: 1,
  catalystPerParticle: 1,
  ringStandDescend: 20,
  ringStandAscend: 20,
  labLeave: 5,
  labPark: 5,
} as const;

/** match timing (manual §2): 30 s auto, 120 s teleop, last 20 s = end game. */
export const CHAIN_AUTO_S = 30;
export const CHAIN_TELEOP_S = 120;
export const CHAIN_ENDGAME_S = 20;

/**
 * RING STANDS — vertical climb poles VERY CLOSE to each field corner (the purple-
 * ringed posts in the render). Small inset from the corner (per the user); refine
 * with exact manual coordinates. Four total: (±(72−inset), ±(72−inset)).
 */
export const CHAIN_RINGSTAND_INSET = 5; // APPROX — "very close to each corner"
export const CHAIN_RINGSTAND_XY = CHAIN_HALF_X - CHAIN_RINGSTAND_INSET; // 67"

/**
 * APPROXIMATE — the central PARTICLE ZONE, a diamond of white tape (rotated square,
 * centered). Measured proportionally off the reference render; REFINE with exact
 * manual dims. `_R` is its half-diagonal in inches.
 */
export const CHAIN_DIAMOND_R = 38;

/**
 * BEAMS — four 1"-tall tubes (difficult terrain) around the center. To drive over a
 * beam a robot needs `groundClearance ≥ CHAIN_BEAM_HEIGHT`, AND its drivetrain must be
 * able to climb (traction wheels do; omni/x-drive can't). More clearance eases the
 * crossing but RAISES the center of gravity → a handling penalty (`crossBeams`/CoG).
 * Positions APPROXIMATE (a ring around the particle zone) pending exact manual dims.
 */
export const CHAIN_BEAM_HEIGHT = 1; // inches (tube height)
/** across-beam speed (in/s) at which MOMENTUM lets a robot power over with ~no slowdown */
export const CHAIN_BEAM_MOMENTUM_REF = 55;
/** ground-clearance slider (inches). Default just meets a 1" beam (0 margin). */
export const CHAIN_CLEARANCE_MIN = 0.5;
export const CHAIN_CLEARANCE_MAX = 3;
export const CHAIN_CLEARANCE_DEFAULT = 1;
/** max fraction of drive authority lost at full clearance (raised center of gravity) */
export const CHAIN_COG_PENALTY = 0.16;

/** extra fit margin around the field when the camera scales it to the viewport.
 * Small because the camera bounds are widened to include the protruding goals. */
export const CHAIN_VIEW_MARGIN = 8;

/** the outer x half-extent the CAMERA must show so the protruding accelerators are
 * on screen (the WALLS/colliders stay at ±CHAIN_HALF_X — this is view-only). */
export const CHAIN_VIEW_HALF_X = CHAIN_HALF_X + CHAIN_ACCEL_DEPTH; // 99.46"

// ─────────────────────────────────────────────────────────────────────────────
// GAMEPLAY tuning (the playable model). The manual fixes the ELEMENT sizes/scoring
// above; these are sim feel/perf knobs chosen for a fun, smooth, deterministic game.
// ─────────────────────────────────────────────────────────────────────────────

/** how many particles the sim actually simulates. The real game has 300; bespoke
 * (non-Rapier) particle physics scales to it at 60 Hz. Conserved: ground + flight +
 * in-hoppers === this, always. */
export const CHAIN_PARTICLE_SIM = 300;

/** ground-particle physics (bespoke integrator + a spatial-hash separation pass so
 * particles never overlap — see `separateParticles`; scales to 300 cheaply) */
export const CHAIN_PART_FRICTION = 42; // in/s² rolling decay
export const CHAIN_PART_REST_SPEED = 1.5; // snap to rest below this
export const CHAIN_PART_WALL_REST = 0.35; // wall bounce restitution
export const CHAIN_PART_SEP_ITERS = 2; // overlap-resolution passes per tick

/** accelerator REJECT: a scored particle enters the accelerator, then the auto-score
 * system launches it BACK onto the field (visible). Tuned to land further out with
 * lots of variance — power (±), arc (±), and lateral spread all randomize per ball. */
export const CHAIN_EJECT_SPEED = 135; // in/s back into the field (base; ×0.75–1.45)
export const CHAIN_EJECT_VZ = 80; // in/s upward arc on the way out (base; ×0.75–1.45)
export const CHAIN_EJECT_SPREAD = 150; // in/s random lateral spread

/**
 * INTAKE DESIGNS (`RobotSpec.chainIntake`). CR robots collect the 3" Particles with a
 * WIDE under-frame mechanism (unlike DECODE's single-file mouth); the design trades
 * capture WIDTH (how many at once) against forward REACH (precision / picking singles).
 * The capture band is measured off the ACTUAL CHASSIS (length/2 × width/2) so it stays
 * roughly the size of the robot: width = chassis half-width × `widthFrac` (+`overhang`
 * inches for the one deployed sweeper), from `backFrac` of the chassis (behind the
 * front, particles driven partly under) forward to a SMALL `reach` past the front edge.
 * All in inches on a ~14–18" chassis. Consumed in `interact` (play.ts).
 */
export interface ChainIntakeGeom {
  widthFrac: number; // capture half-width as a fraction of the chassis half-width
  overhang: number; // extra capture half-width past the frame (deployed intake), inches
  reach: number; // capture band reaching ahead of the CHASSIS front edge, inches
  backFrac: number; // fraction of the chassis half-length (from the front) that captures
}
export const CHAIN_INTAKES: Record<ChainIntakeStyle, ChainIntakeGeom> = {
  // full-width surface roller — grabs the chassis width with a tight front bite (all-rounder)
  roller: { widthFrac: 1.0, overhang: 0, reach: 3, backFrac: 0.4 },
  // narrow funnel — a bit more forward reach, fewer at once (precise single picks)
  funnel: { widthFrac: 0.55, overhang: 0, reach: 6, backFrac: 0.25 },
  // widest active sweeper — a small overhang past the frame, deepest gulp (max volume/pass)
  sweeper: { widthFrac: 1.0, overhang: 2, reach: 4, backFrac: 0.55 },
};
export const CHAIN_INTAKE_STYLES = ['roller', 'funnel', 'sweeper'] as const;
export const CHAIN_DEFAULT_INTAKE: ChainIntakeStyle = 'roller';

/**
 * SCORING ARCHETYPES (`RobotSpec.scoreMode`) — the robot's expansion/scoring mechanism.
 * turret aims its own turret; drum + dumper are TURRETLESS chassis-wide launchers, so the
 * robot AIMS BY TURNING to face the goal (the fire button steers it) and fires a PARALLEL
 * LINE of Particles across its width. The tall Accelerator opening HANGS over the field, so
 * these can score from a stand-off distance (not point-blank).
 *  • turret — indexes + launches ONE Particle per `CHAIN_FIRE_INTERVAL` from anywhere.
 *  • drum   — a chassis-wide flywheel drum: fires up to `CHAIN_DRUM_MAX` (6 = 18/3) at once
 *    in a UNIFORM parallel line from ANY range; a burst every `CHAIN_DRUM_INTERVAL` (the
 *    drum re-indexes — realistically slower than a turret).
 *  • dumper — a chassis-wide catapult: flings the WHOLE hopper at once from LIMITED range
 *    (`CHAIN_DUMP_RANGE`); balls stored on opposite sides leave at DIFFERENT speeds
 *    (`CHAIN_DUMP_SIDE_VAR`) ⇒ real scatter (< 100% accuracy).
 */
export const CHAIN_SCORE_MODES = ['turret', 'drum', 'dumper'] as const;
export const CHAIN_DEFAULT_SCORE_MODE: ChainScoreMode = 'turret';

// turretless-launcher aiming (drum + dumper turn the whole robot to face the goal)
export const CHAIN_AIM_TOL = 0.14; // rad heading error under which a turned shooter fires
export const CHAIN_AIM_GAIN = 4.5; // P-gain turning the robot toward the goal while firing
export const CHAIN_LAUNCH_LINE_FRAC = 0.92; // fraction of the chassis width the line spans
export const CHAIN_LAUNCH_Z0 = 10; // in — launch height (into the tall, over-field opening)

// DRUM: uniform-velocity flywheel, up to 6 at once, any range, slower burst cadence
export const CHAIN_DRUM_MAX = 6; // max Particles per burst (18"/3" = 6 fit the drum)
export const CHAIN_DRUM_INTERVAL = 0.55; // s between bursts (drum re-index)
export const CHAIN_DRUM_SPEED = 175; // in/s uniform horizontal launch

// DUMPER: whole-hopper catapult, limited (but not point-blank) range, side-var scatter
export const CHAIN_DUMP_RANGE = 56; // in — the tall opening hangs over the field: stand off
export const CHAIN_DUMP_INTERVAL = 0.8; // s recovery between full dumps
export const CHAIN_DUMP_SPEED = 150; // in/s base horizontal launch
export const CHAIN_DUMP_SIDE_VAR = 0.16; // ± speed variance across the catapult width (scatter)

// GOAL FUNNEL: a scored Particle bounces/funnels DOWN inside the tall goal for this long
// before the wall-side launcher (spanning the whole goal width) flings it back onto the field
export const CHAIN_FUNNEL_S = 0.55; // s dwell inside the goal before re-launch
export const CHAIN_FUNNEL_FALL = 45; // in/s the Particle settles to the goal floor
export const CHAIN_FUNNEL_DRIFT = 40; // in/s drift toward the wall-side launcher

// MISSED shot: a Particle that misses the opening is retrieved by a HUMAN and thrown back
// into the field (FOR NOW — this rule may change) — tossed inward from the wall it hit
export const CHAIN_THROWBACK_SPEED = 72; // in/s inward toss (lands mid-field after friction)
export const CHAIN_THROWBACK_SPREAD = 45; // in/s lateral spread on the throw-in

/**
 * BALL STORAGE (a per-robot builder slider, `RobotSpec.ballStorage`). Range grounded
 * in the dimensions: the chassis is up to 24" and a Particle is 3" OD ⇒ 8 balls per
 * row; a practical multi-row internal magazine tops out around 30. Min 1.
 */
export const CHAIN_STORAGE_MIN = 1;
export const CHAIN_STORAGE_MAX = 30;
export const CHAIN_STORAGE_DEFAULT = 8;

/** shooter: launch a held particle toward this robot's own accelerator. Auto-aimed
 * at the mouth center, so (like DECODE's shooter) it reliably scores — arcade feel. */
export const CHAIN_FIRE_INTERVAL = 0.05; // s between shots (rapid fire)
export const CHAIN_SHOT_SPEED = 150; // in/s horizontal toward the mouth
export const CHAIN_SHOT_VZ = 70; // in/s initial upward (visual arc)

/** catalysts: auto-pick a nearby free catalyst (if not already carrying one); seat it
 * on a hook when carried near one. */
export const CHAIN_CATALYST_PICK_R = 9; // pick-up radius (to robot center)
export const CHAIN_HOOK_PLACE_R = 12; // seat-on-hook radius (carried catalyst → hook)

/** endgame: park fully inside a Lab-Area corner square (5 pt) / ascend within this
 * radius of a Ring Stand (20 pt). Lab squares are 24" at each field corner; an
 * alliance owns the two on its side (red x<0, blue x>0). APPROX — refine with manual. */
export const CHAIN_LAB = 24; // corner square size (in)
export const CHAIN_ASCEND_R = 9; // ascend proximity to a ring stand (in)

/**
 * CHAIN REACTION ROBOT PRESETS — archetype cards for the CR builder (parallel to
 * DECODE's `ROBOT_PRESETS`). Each is a full, legal `RobotSpec` bundling a scoring
 * archetype + intake design + a matched drivetrain/mass/rpm/storage/clearance loadout,
 * so a single click sets a coherent playstyle. All numbers are within the shared
 * coerceSpec ranges (so applying one is a no-op through the coercer and the card
 * highlights as selected). `name`/`teamName` describe the archetype (no team number).
 */
export const CHAIN_PRESETS: readonly RobotSpec[] = [
  {
    // long-range precision: turret shoots from anywhere, funnel picks singles, swerve
    // + clearance to roam over the beams
    name: 'Sniper', teamName: 'Turret · score from anywhere', teamNumber: 0,
    length: 14.5, width: 17, intake: 'sloped', massLb: 24, drivetrain: 'swerve',
    driveRpm: 500, flywheelInertia: 0.2, canSort: false,
    ballStorage: 10, groundClearance: 1.8, scoreMode: 'turret', chainIntake: 'funnel',
  },
  {
    // volume hauler: dumps a huge load at the wall, widest sweeper, tank push + big
    // storage + high clearance to bulldoze over the beams
    name: 'Hauler', teamName: 'Dumper · haul & unload', teamNumber: 0,
    length: 15, width: 18, intake: 'sloped', massLb: 38, drivetrain: 'tank',
    driveRpm: 340, flywheelInertia: 0.2, canSort: false,
    ballStorage: 28, groundClearance: 2.2, scoreMode: 'dumper', chainIntake: 'sweeper',
  },
  {
    // the volume shooter: a chassis-wide drum firing 6 at once from anywhere, light mecanum
    name: 'Drummer', teamName: 'Drum · fire 6 at once, any range', teamNumber: 0,
    length: 14.5, width: 17, intake: 'sloped', massLb: 25, drivetrain: 'mecanum',
    driveRpm: 470, flywheelInertia: 0.3, canSort: false,
    ballStorage: 14, groundClearance: 1.4, scoreMode: 'drum', chainIntake: 'roller',
  },
  {
    // fast wall-runner: a quick x-drive dumper that shuttles particles to its own
    // accelerator; low clearance keeps it off the beams (works its own quadrant)
    name: 'Skimmer', teamName: 'Dumper · fast wall runs', teamNumber: 0,
    length: 14.5, width: 16, intake: 'sloped', massLb: 22, drivetrain: 'xdrive',
    driveRpm: 520, flywheelInertia: 0.1, canSort: false,
    ballStorage: 20, groundClearance: 1.0, scoreMode: 'dumper', chainIntake: 'roller',
  },
] as const;
