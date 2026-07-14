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
 * system launches it BACK onto the field (visible) — speed + upward arc + spread. */
export const CHAIN_EJECT_SPEED = 110; // in/s back into the field
export const CHAIN_EJECT_VZ = 55; // in/s upward arc on the way out
export const CHAIN_EJECT_SPREAD = 90; // in/s random lateral spread

/** intake: a front capture zone. A ground particle inside it (with hopper room) is
 * absorbed into the robot's hopper. */
export const CHAIN_INTAKE_REACH = 5; // in front of the intake mouth
export const CHAIN_INTAKE_HALF = 8; // half-width of the capture zone

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
