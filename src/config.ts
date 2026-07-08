import type { RobotSpec } from './types';

/**
 * Single source of truth for all field geometry, physics constants, and
 * scoring values. Units: inches, seconds, radians. Field frame: origin at
 * field center, +x = audience's right, +y = away from the audience.
 *
 * Layout verified against the DECODE Competition Manual Section 9 figures:
 * Red Wall = left (x=-72), Blue Wall = right (x=+72); BLUE goal far-LEFT
 * corner, RED goal far-RIGHT corner (cross-court from their drive teams).
 * See src/sim/field.ts for the geometry helpers.
 */

export const FIELD_HALF = 72; // 144 x 144 in field
export const TILE = 24;
export const TAPE_W = 1;

// ---------------------------------------------------------------- match ----
export const AUTO_DURATION = 30;
export const TRANSITION_DURATION = 8;
export const TELEOP_DURATION = 120;
/** END GAME: the final stretch of TELEOP (warning cue + HUD urgency) */
export const ENDGAME_START = 20; // s left in teleop
/** announcer countdown after pressing start ("Match begins in" + 3,2,1) */
export const PRE_COUNTDOWN = 4;
/** delay from match end (phase 'post') to the "match_result" fanfare/whoosh.
 * The results screen holds its score reveal until this exact moment so the
 * count-up + winner slam land on the whoosh. Shared by the audio (game.ts) and
 * the reveal animation (GameView). */
export const MATCH_RESULT_REVEAL_MS = 2800;
/** seconds the SERVER keeps stepping the sim in phase 'post' before it captures
 * the authoritative final score + saves the record — long enough for balls still
 * flowing down the ramp/gate to settle and score. Matched to the reveal delay so
 * the number saved to the leaderboard is exactly the one shown at the whoosh. */
export const MATCH_SETTLE_S = MATCH_RESULT_REVEAL_MS / 1000;

// --------------------------------------------------------------- season ----
/** Balance / season version. Leaderboards (Phase 3) are keyed to this: it is
 * bumped DELIBERATELY on a gameplay-affecting balance change (any physics or
 * scoring constant below that would move a record's score), which starts a
 * fresh ranked season and archives the previous one. Every record + replay is
 * stamped with the value in effect when it was set, because a deterministic
 * input-log replay only re-simulates to the same score under the exact sim
 * build that produced it. Do NOT auto-derive this from a file hash — that would
 * reset every season on a trivial, non-gameplay edit. See docs/netcodeplan.md
 * Phase 3 + the phase3-leaderboards spec. */
export const BALANCE_VERSION = 1;

/** Ranked PLACEMENT: a player is "in placements" until they've completed this
 * many ranked games on a board (counted per mode × drivetrain, incl. Overall).
 * Until placed they are HIDDEN from the leaderboard and shown a "?" plus an
 * "N matches until placement" line. This REPLACES the old RD-based provisional
 * flag (`rd > 110`), which stayed set far too long in a young pool: Glicko RD
 * shrinks only slowly when opponents are themselves uncertain, so players kept
 * the "?" for dozens of games. RD is still used INTERNALLY by Glicko-2 to size
 * how hard each result swings the rating — it just no longer drives the UI. */
export const PLACEMENT_GAMES = 10;

// -------------------------------------------------------------- scoring ----
export const PTS_LEAVE = 3;
export const PTS_CLASSIFIED = 3;
export const PTS_OVERFLOW = 1;
export const PTS_DEPOT = 1;
export const PTS_PATTERN = 2; // per ramp slot matching the motif
export const PTS_BASE_PARTIAL = 5;
export const PTS_BASE_FULL = 10;

// --------------------------------------------------------------- fouls -----
/** Section 11 penalties, awarded TO the OPPOSING (victim) alliance */
export const PTS_FOUL_MINOR = 5;
export const PTS_FOUL_MAJOR = 15;
/** G422 pinning: hold an opponent for this long (s) while it is trying to move
 * and hasn't escaped PIN_ESCAPE_DIST from where the pin began -> foul */
export const PIN_SECONDS = 3;
export const PIN_ESCAPE_DIST = 24; // in — getting this far away ends the pin
/** pinned robot counts as "prevented from moving" below this actual speed */
export const PIN_STUCK_SPEED = 8; // in/s
/** the PINNED robot must be trapped against a field boundary with the pinner on
 * the open-field side: its leading corner (straight away from the pinner) sits
 * within this slop of the perimeter. This breaks the symmetry of a wall shove —
 * without it BOTH robots look "slow + commanding" and the victim was wrongly
 * fouled too. */
export const PIN_WALL_SLOP = 3; // in
/** A foul fires on the rising edge of its condition and does NOT re-fire while
 * the condition holds — continuous contact in a foul zone is ONE foul, not a
 * stream. It re-arms only after the condition has been CLEAR for this long, so
 * a jittery SAT contact that flickers off for a tick or two never re-fouls, but
 * genuinely leaving a zone and coming back does. Kept short so re-entry still
 * feels immediate. */
export const PENALTY_CLEAR = 1.0; // s

// ------------------------------------------------------------ artifacts ----
export const BALL_RADIUS = 2.5; // 5 in diameter
export const BALL_ROLL_FRICTION = 30; // in/s^2 — a touch of "mass" over the legacy
// 25, but the clump push-drag (BALL_PUSH_DRAG) carries the harder-to-push feel
/** fraction of the robot's into-the-ball speed bled off per ball contact each
 * solver pass — small per ball, but a big CLUMP is cumulatively a little heavier
 * to push (the drivetrain meets resistance, accelerates into it slower) */
export const BALL_PUSH_DRAG = 0.01;
export const BALL_REST_SPEED = 2; // in/s, snap to rest below this
export const BALL_WALL_RESTITUTION = 0.5;
export const BALL_BALL_RESTITUTION = 0.55;
export const BALL_GROUND_RESTITUTION = 0.45; // vertical bounce
export const BALL_BOUNCE_H_RETAIN = 0.8; // horizontal speed kept on ground bounce
export const GRAVITY = 386; // in/s^2
/** light foam ball off a heavy chassis: nearly inelastic — the ball inherits
 * the chassis surface speed but gains almost no extra bounce */
export const BALL_ROBOT_RESTITUTION = 0.05;
/** ground-ball mass (lb) for the Rapier ball solve (`solveBalls`). Balls only
 * meet other balls (equal mass ⇒ value cancels) and the immovable static field
 * there — ball↔robot is the bespoke `collideBallRobot` pass, NOT Rapier, because
 * the pin stall + "outflow can't shove a parked robot" feel (product decision #7)
 * is deliberately non-physical. So this is essentially a numerical scale; a light
 * foam-ball value is kept for physical honesty. Ball restitution combines with
 * `CoefficientCombineRule.Min`, so ball↔static = min(BALL_BALL_RESTITUTION,
 * BALL_WALL_RESTITUTION) = BALL_WALL_RESTITUTION and ball↔ball = BALL_BALL_REST. */
export const BALL_MASS = 0.2; // lb
/** a robot push refused by a wall beyond this distance means the ball is
 * PINNED — the constraint transmits back and stalls the robot */
export const BALL_PIN_SLOP = 0.05; // in
/** the pin only pushes the robot back when the robot itself drives into it
 * faster than this — balls arriving under their own momentum just stop */
export const BALL_PIN_PUSH_MIN_SPEED = 0.5; // in/s
/** ball-ball + ball-robot passes per tick, so robot -> ball -> pinned-ball
 * chains converge instead of tunnelling */
export const BALL_SOLVER_ITERATIONS = 2;

// ------------------------------------------------- robot contact torque ----
/** per-tick angular correction cap from a single contact group (rad), at rest */
export const CONTACT_ALIGN_RATE = 0.03;
/** contact bias: keeps torque alive under light steady pressure so the wall
 * finishes squaring the chassis instead of stalling at a small angle */
export const CONTACT_BIAS = 0.2;
/** alignment speedup per in/s the robot pushes into the contact — holding
 * forward against a wall turns briskly, a fast hit swings hard */
export const CONTACT_PRESS_GAIN = 0.4;
/** hard cap on per-tick alignment under pressure (rad) */
export const CONTACT_ALIGN_RATE_MAX = 0.12;
/** spin injected per (contact torque × in/s of impact speed) — a fast angled
 * hit visibly converts momentum into rotation; dead-center hits add nothing */
export const CONTACT_IMPACT_SPIN = 0.12;
/** touch tolerance (in) for the post-Rapier square-up pass: Rapier resolves
 * translation and leaves a chassis resting AT a face (near-zero penetration),
 * so the bespoke torque nudge treats a contact within this band as touching */
export const CONTACT_TOUCH_EPS = 0.5;
/** Rapier length scale: the world is in INCHES, not meters. Rapier scales its
 * internal penetration/prediction tolerances by this so contacts resolve firmly
 * at our scale (a typical object — robot/ball — is ~10 in). */
export const PHYS_LENGTH_UNIT = 10;
/** Rapier constraint solver iterations per step — high enough that a full-speed
 * pin is fully separated each tick (no penetration accumulation / axis flip) */
export const PHYS_SOLVER_ITERS = 8;
/** Rapier contact stiffness (Hz): LOW = soft contacts, so a body starting deep
 * in a wall (e.g. intake reach) is bled out gently over several ticks instead of
 * ejected with a huge recovery velocity (solver explosion). */
export const PHYS_CONTACT_FREQ = 8;
/** normalized allowed penetration error (× lengthUnit ⇒ inches): a little slack
 * so shallow resting contacts aren't fought every tick */
export const PHYS_ALLOWED_ERROR = 0.01;
/** friction between chassis and walls / other chassis — resists a pinned robot
 * sliding out of a squeeze (the old model squared-and-held; 0 let it squirt) */
export const PHYS_FRICTION = 0.7;
/** BALL contact stiffness (Hz) for the ball solve — stiffer than the robot world
 * (8 Hz), which let two grounded balls sit visibly overlapping for many ticks.
 * Tuned to 25: separates a resting overlapping clump within ~0.5s (as clean as a
 * much higher value) WITHOUT the explosive ejection a very stiff contact (≥60 Hz)
 * gives the tightly-packed column draining out of the gate — at 120 Hz those exit
 * balls shot out at ~2× their intended speed. 25 keeps gate outflow at the natural
 * exit velocity while still killing resting overlap. */
export const PHYS_BALL_CONTACT_FREQ = 25;
/** BALL allowed penetration (× lengthUnit ⇒ inches): tight, so resting balls
 * settle touching rather than at the ~0.1in slop the robot value leaves. */
export const PHYS_BALL_ALLOWED_ERROR = 0.001;
// ---------------------------------------------------------------- robot ----
export const ROBOT_MAX_SIZE = 18; // FTC starting size cap (incl. intake reach)
export const ROBOT_MIN_SIZE = 12;
/** the chassis may be narrower than the intake (easier base parking) */
export const ROBOT_MIN_WIDTH = 10;
/** wheel centers sit this far INSIDE the chassis edge (typical FTC build);
 * the four wheel ground-contact points are what counts for base parking */
export const WHEEL_INSET = 2.6;
/** drivetrain modeling: per-robot params derive from spec (drivetrain type,
 * driveRpm, massLb) in src/sim/drivetrain.ts. Reference values below are
 * calibrated so the DEFAULT robot reproduces the original tuned feel exactly
 * (75 in/s, 7 rad/s, 280 in/s²) — verified by a smoke check. */
export const REF_DRIVE_RPM = 435;
export const REF_MASS_LB = 26;
export const SPEED_PER_RPM = 75 / 435; // in/s per wheel RPM
export const BASE_DRIVE_ACCEL = 280; // in/s^2 at reference RPM/mass
export const TURN_MAX_SPEED = 12.0; // rad/s absolute cap (small fast bots approach it; default is 7)
export const TURN_ACCEL_PER_ACCEL = 40 / 280; // rad/s^2 per in/s^2 of drive accel
/** robot mass/rpm GLOBAL fallbacks for the builder (lb / wheel rpm). The real
 * limits are per-drivetrain (DRIVETRAIN_LIMITS below); these bound the widest
 * envelope and still gate settings validation where a drivetrain isn't known. */
export const ROBOT_MIN_MASS = 20;
export const ROBOT_MAX_MASS = 42;
export const ROBOT_MIN_RPM = 200;
export const ROBOT_MAX_RPM = 600;

/** per-drivetrain weight + RPM envelopes. Tank runs heavy with a torque-biased
 * (lower) RPM ceiling; swerve modules are complex → a raised mass floor and a
 * lower RPM ceiling; mecanum/x-drive get the full range. The MASS FLOOR is
 * further raised by flywheel inertia (a heavier flywheel — see massLimits). */
export const DRIVETRAIN_LIMITS = {
  mecanum: { minMass: 18, maxMass: 42, minRpm: 200, maxRpm: 600 },
  xdrive: { minMass: 18, maxMass: 42, minRpm: 200, maxRpm: 600 },
  tank: { minMass: 22, maxMass: 42, minRpm: 200, maxRpm: 560 },
  swerve: { minMass: 22, maxMass: 40, minRpm: 200, maxRpm: 500 },
} as const;
/** lb added to a drivetrain's mass floor at flywheelInertia 1 (a big flywheel
 * weighs more): effective floor = base + INERTIA_MASS_FLOOR·inertia. Kept small
 * so inertia only nudges the mass range. */
export const INERTIA_MASS_FLOOR = 6;

/** penalty added to fireInterval when robot is sorting (canSort: true) */
export const SORT_FIRE_PENALTY = 0.25;

/** per-drivetrain multipliers + wheel-saturation model. saturation:
 * 'sum'   = |f|+|s|+|ω|  (mecanum/x-drive: the worst roller wheel sees all)
 * 'tank'  = |f|+|ω|      (no strafe at all — strafe input is dead)
 * 'vec'   = hypot(f,s)+|ω| (swerve modules are direction-independent)
 * accelMult + pushMult order (tank > swerve > mecanum > xdrive): traction
 * wheels bite hardest, then steered modules, then rollers. pushMult scales the
 * EFFECTIVE shove mass in the Rapier robot solver (physicsEngine.ts) alongside
 * real mass, RPM (torque), and power draw. mecanum stays 1.0/1.0 — it is the
 * DEFAULT calibration anchor (75 in/s, 7 rad/s, 280 in/s²). */
export const DRIVETRAIN_PRESETS = {
  /** the FTC standard: full strafe at roller-slip speed */
  mecanum: { strafeMult: 0.85, speedMult: 1.0, accelMult: 1.0, pushMult: 1.0, saturation: 'sum' },
  /** 45° omni pods: full-speed strafe, slight overall speed loss + least bite */
  xdrive: { strafeMult: 1.0, speedMult: 0.9, accelMult: 0.92, pushMult: 0.9, saturation: 'sum' },
  /** traction wheels: no strafe, best straight-line speed, accel, and push */
  tank: { strafeMult: 0, speedMult: 1.05, accelMult: 1.5, pushMult: 1.5, saturation: 'tank' },
  /** independent steered modules: full-speed any direction, strong bite */
  swerve: { strafeMult: 1.0, speedMult: 1.0, accelMult: 1.12, pushMult: 1.15, saturation: 'vec' },
} as const;

/** flywheel recovery: after an energetic (long-range) shot, a LOW-inertia
 * flywheel needs time to spin back up before the next shot. Shots below
 * FLYWHEEL_CLOSE_SPEED add nothing (so ANY robot rapid-fires up close), then
 * recovery ramps STRONGLY with (speed over that)² and with (1 - inertia) — so
 * DISTANCE dominates the cadence, and low inertia is punished hard far out while
 * high inertia keeps firing fast at range. */
export const FLYWHEEL_CLOSE_SPEED = 135; // in/s launch speed considered "close"
export const FLYWHEEL_RECOVERY_MAX = 1.25; // s extra between max-range shots at inertia 0

/** POWER DRAW: a running intake, plus the flywheel, pull current away from the
 * drive motors, so the robot gets slightly slower AND pushes weaker. Draw scales
 * drive speed/accel down by (1 − draw) and the Rapier shove mass by the same,
 * capped so it stays "slight". The flywheel has TWO terms (both × inertia):
 *  - HOLD: a small steady cost for keeping a spun-up wheel turning. Just being
 *    far from the goal barely matters — this is intentionally light.
 *  - SPIN-UP: the DOMINANT cost of ACCELERATING the wheel, i.e. actively driving
 *    AWAY from the goal so the required spin is climbing. Proportional to how
 *    fast the spin target is rising (per second) — a heavy (high-inertia) wheel
 *    is expensive to spin up, a light one is nearly free. Spinning DOWN (driving
 *    toward the goal) costs nothing. flywheelSpin is a 0..1 ramp with distance to
 *    the robot's own goal (FLY_SPIN_NEAR→FLY_SPIN_FAR); flywheelSpinRate is its
 *    positive rate of change (1/s), both set in updateRobotActions. */
export const POWER_DRAW_FLYWHEEL_HOLD = 0.04; // steady: inertia × spin (far & idle)
export const POWER_DRAW_FLYWHEEL_SPINUP = 0.45; // per 1/s of rising spin: inertia × rate
export const POWER_DRAW_INTAKE = 0.06; // intake motors running
export const POWER_DRAW_MAX = 0.18; // cap ⇒ at most ~18% slower ("slightly")
export const FLY_SPIN_NEAR = 40; // in to goal: flywheel spin 0
export const FLY_SPIN_FAR = 170; // in to goal: flywheel spin 1

/** capture tolerance beyond the ball radius, each way (tight — no vacuuming
 * balls from a distance; a ball must actually reach the compliant wheels) */
export const INTAKE_CAPTURE_BAND = 0.5;
/** how fast a HELD ball slides between storage slots (in/s), in the robot frame —
 * so the triangle's front ball visibly slides aside to make room for a 3rd */
export const HELD_SLIDE_SPEED = 45;
/** the intake ROLLER (axle + compliant wheels) sticks out this far past the
 * ball-colliding wedges. The roller is a physical hitbox for ROBOTS/WALLS (the
 * full `reach`, via robotExtents), but it rides HIGH in z so BALLS pass under it
 * and never collide with it — only the recessed wedges deflect balls. So the
 * ball hitbox is `reach − INTAKE_WHEEL_STICKOUT` deep. */
export const INTAKE_WHEEL_STICKOUT = 1.3;
/** Intake presets model the REAL mechanism, not a touch-and-wait hitbox.
 * TOP LEVEL (feeds robotExtents → the Rapier robot-robot/wall collider, length
 * clamps, drawing):
 *   reach       forward extension of the box past the chassis front
 *   overhang    the compliant wheels may stick out past a narrower chassis
 *               (vector); without it the chassis ENCOMPASSES the intake so side
 *               intake is geometrically impossible
 *   min/maxLength  legal chassis length range · fireInterval  hopper→shooter cadence
 * mouth GEOMETRY (robot-local inches, front = +x):
 *   wedge       true = a FUNNEL front: two angled side slopes (from the front
 *               corners in to the throat) direct balls to the CENTER compliant
 *               wheels — NO flat front wall (sloped/triangle). false = a flat
 *               front, wheels span the whole mouth (vector).
 *   mouthHalf   half-width of the opening at the tip
 *   throatHalf  half-width of the compliant-wheel CAPTURE zone: at the chassis
 *               front for a funnel (balls funnel to center there), = the full
 *               mouth for a flat front (vector captures across the tip)
 *   drawIn      suction speed (in/s) the running intake pulls a ball in the
 *               mouth toward the throat (0 = flat front, wheels grab in place)
 *   capMin/capMax  swallow interval as the capture point goes CENTER→EDGE
 *               (vector: compliant center fast, vectoring sides slow)
 *   clumpInterval  swallow cadence while 2+ balls sit at the mouth
 *   dual        capture TWO balls per cycle from a clump (triangle's 2 front slots) */
export const INTAKE_PRESETS = {
  /** SLOPED: two side slopes funnel artifacts into the compliant wheels at the
   * throat — no flat front. maxLength = 18 − reach (the roller counts toward the
   * 18in cube). Fast + eats clumps. */
  sloped: {
    reach: 3, overhang: false, minLength: 13.5, maxLength: 15, fireInterval: 0.08, fireCap: 0,
    mouth: {
      wedge: true, mouthHalf: 7, throatHalf: 3, drawIn: 26,
      capMin: 0.05, capMax: 0.09, clumpInterval: 0.04, dual: false,
    },
  },
  /** VECTOR WHEEL: flat front (no side slopes), the roller spans the whole mouth
   * so the throat is full-width; balls are sucked straight to the chassis front.
   * CENTER intakes fast, the SIDES slower (vectoring), and the overhang lets it
   * grab balls strafed into its flank. Chassis 11.5..14.5in. */
  vector: {
    reach: 3.5, overhang: true, minLength: 11.5, maxLength: 14.5, fireInterval: 0.1, fireCap: 0,
    mouth: {
      // flat plate `mouthHalf` wide; the mecanum wheels VECTOR a ball laterally
      // (drawIn) to the center compliant zone (throatHalf) before sucking it in,
      // so edge entries take longer — the vectoring time
      wedge: false, mouthHalf: 8.5, throatHalf: 3, drawIn: 18,
      capMin: 0.08, capMax: 0.14, clumpInterval: 0.12, dual: false,
    },
  },
  /** TRIANGLE: named for the triangular ball storage (2 near the mouth, 1 deep).
   * Sloped-style funnel slopes + longest reach; devours a clump TWO at a time.
   * Transfer is the SAME as the others EXCEPT a max-rate CAP (`fireCap`): it can't
   * fire faster than that, but when conditions are already slower than the cap
   * (flywheel recovery on far shots) it fires at the same rate as everyone else. */
  triangle: {
    reach: 5, overhang: false, minLength: 11, maxLength: 13, fireInterval: 0.1, fireCap: 0.18,
    mouth: {
      // strongest INTAKE of the three (its identity — devours clumps): a hard
      // suction (drawIn) snaps balls to the throat and it swallows quickest. The
      // tradeoff is TRANSFER (fireCap), not the grab — those stay untouched.
      wedge: true, mouthHalf: 7, throatHalf: 3.5, drawIn: 46,
      capMin: 0.04, capMax: 0.07, clumpInterval: 0.035, dual: true,
    },
  },
} as const;
/** flank capture engages only when actually strafing toward the ball */
export const INTAKE_SIDE_MIN_STRAFE = 8; // in/s
/** forward speed above which a FLAT (vector) intake driven into a CLUMP scatters
 * it instead of vectoring it in: the non-compliant wheels + impact force push the
 * pile away. Below this a controlled approach still intakes normally. Wedge
 * (sloped/triangle) funnels are immune — they devour clumps by design. */
export const INTAKE_RAM_SPEED = 32; // in/s

export const HOPPER_CAPACITY = 3;

// --------------------------------------------------------------- turret ----
/** turret center as a fraction of chassis length behind the center of
 * rotation — scales with the chassis so the turret never overhangs it */
export const TURRET_OFFSET_FRAC = -1 / 6; // 18in chassis -> 3in behind center
/** base hood angle; the solver steepens it up close so every distance has an
 * exact ballistic solution into the opening — the robot never misses */
export const LAUNCH_ANGLE = (55 * Math.PI) / 180;
export const LAUNCH_ANGLE_MAX = (80 * Math.PI) / 180;
export const LAUNCH_ANGLE_MARGIN = (14 * Math.PI) / 180; // above line-of-sight
export const LAUNCH_HEIGHT = 12; // in, muzzle height
export const LAUNCH_MAX_SPEED = 320; // in/s
/** no flywheel spin-up model — shots are limited only by this cadence */
// firing cadence lives per intake preset: INTAKE_PRESETS[*].fireInterval
/** fraction of chassis velocity inherited by the launched ball. The turret's
 * aim solver lead-compensates for it, so shooting on the move is accurate. */
export const SHOT_ROBOT_VEL_INHERIT = 0.5;

// ----------------------------------------------------------------- goal ----
/** GOAL footprint: a right triangle tucked into the far corner with its legs
 * flush along the two walls. Measured from the manual's "Top View Goal Opening
 * Inside Dimensions" (Section 9): GOAL_FACE_WIDTH runs along the far wall,
 * GOAL_DEPTH down the side wall; the hypotenuse is the FACE the robots shoot
 * at, and the DEPOT tape runs flush along it. The face is therefore NOT at 45°.
 * See goalTriangle / goalFaceNormal / goalLineValue in field.ts. */
export const GOAL_FACE_WIDTH = 26.5; // in, leg along the far wall
export const GOAL_DEPTH = 18.3; // in, leg down the side wall
export const GOAL_FACE_LEN = Math.sqrt(GOAL_FACE_WIDTH ** 2 + GOAL_DEPTH ** 2); // ~32.2 (hypotenuse/face)
export const GOAL_OPENING_Z = 38.75; // in, height of the opening lip
export const GOAL_WALL_TOP = 37; // flights below this bounce off the goal face
export const GOAL_OPENING_RADIUS = 11; // in, effective entry radius at the plane

// ----------------------------------------------------- classifier / gate ----
export const RAMP_SLOTS = 9;
/** classifier channel along the side wall (robot obstacle), running from the
 * gate all the way into the far corner behind the goal */
export const CLASSIFIER_W = 6; // strip width from the wall
export const CLASSIFIER_Y0 = 2; // gate end (y)
export const CLASSIFIER_Y1 = FIELD_HALF; // reaches the far wall corner
export const RAMP_RAIL_INSET = 3; // ball rail distance from the wall
export const RAMP_SURFACE_Z = 10; // drawn height of balls on the ramp
export const OVERFLOW_Z = 13.5; // overflow rolls over the retained balls

// goal basin (inside the triangular goal structure)
export const BASIN_FLOOR_Z = 14; // funnel floor height inside the goal
export const BASIN_RESTITUTION = 0.4; // vertical bounce off the funnel floor
export const BASIN_WALL_RESTITUTION = 0.55; // lively caroms off the goal walls
export const BASIN_FUNNEL_ACCEL = 700; // in/s^2 pull toward the classifier entrance (drains the basin briskly so balls don't clog)
/** the funnel only really grips slow balls — fast ones carom around first */
export const BASIN_FUNNEL_GRIP_SPEED = 260; // in/s (higher ⇒ funnels sooner, less caroming)
export const BASIN_DAMPING = 1.1; // 1/s horizontal velocity damping (settles onto the funnel faster)
/** tangential (orbital) velocity damping about the funnel throat, 1/s. High so
 * balls SPIRAL straight into the classifier instead of circling the throat —
 * the goal footprint is a triangle, not a bowl, so there is no round basin for
 * them to orbit. This is what stops the "circular jumble". */
export const BASIN_TANGENT_DAMPING = 6; // 1/s
export const BASIN_ENTRY_RADIUS = 7.5; // in, hand-off distance to the rail (wider catch = fewer balls milling at the mouth)
export const BASIN_ENTRY_KEEP_V = 0.45; // entry velocity retained (splash energy)

// classifier rail (1D flow, contact stacking)
export const RAIL_S_MAX = 55; // rail length: SQUARE at the top (y = CLASSIFIER_Y0 + s), at the goal's inner exit
export const RAIL_ACCEL = 80; // in/s^2 down-ramp
export const RAIL_TERMINAL = 46; // in/s max flow speed
export const RAIL_PITCH = 5.1; // ball contact spacing on the stack
export const GATE_STOP_S = 2; // lowest rest position against the closed gate
// entrance blocked only while a ball is still within ~one pitch of the top entry
// (s = RAIL_S_MAX = 55); was 43.4, which forced each ball to flow 11.6" clear
// before the next could board — throttling the drain to ~2 balls/s and clogging
// the basin. One pitch below the entry keeps proper spacing but drains ~2× faster.
export const RAIL_ENTRY_BLOCK_S = 50;
export const RAIL_EXIT_S = -4; // past the gate: ball drops out to the floor
export const OVERFLOW_FLOW_SPEED = 58; // in/s, overflow rides over everything (clears a full goal quickly)
/** lateral/vertical glide rate as a ball settles onto the rail line */
export const RAIL_BLEND_SPEED = 30; // in/s

export const GATE_OPEN_HOLD = 0.08; // s of push before the gate swings open
/** once open, the spring can only re-close when no ball occupies the gateway */
export const GATE_CLOSE_CLEAR_LO = -4;
export const GATE_CLOSE_CLEAR_HI = 4.5;
/** gate zone tape in front of the gate: 10in from the wall at y ~ 0 */
/** gate INTERACTION rect (a robot overlapping it works the gate). The tape
 * marking on the mat is drawn separately — see GATE_TAPE_* / gateTapeSegments */
export const GATE_ZONE = { xNear: 62, xFar: 72, y0: -2, y1: 3 };
/** how far BELOW the gate a robot's center may sit and still count as working
 * the gate from the long (field) side. Only a robot deeper than this — coming
 * up from the gate mouth / audience side — is a short-end tap that won't open it. */
export const GATE_LONG_SIDE_MARGIN = 10; // in
/** official GATE ZONE marking (manual Section 9): a 2.75in-wide x 10in-long
 * volume bounded by TWO parallel alliance-colored tape LINES, 10in long,
 * running perpendicular to the side wall (into the field), spaced 2.75in
 * apart and centered on the gate. GATE_ZONE above is the (larger, undrawn)
 * interaction rect that actually works the gate. */
export const GATE_TAPE_W = 2.75; // spacing between the two lines (zone width)
export const GATE_TAPE_LEN = 10; // line length, into the field from the wall
export const GATE_TAPE_Y = (GATE_ZONE.y0 + GATE_ZONE.y1) / 2; // gate center y
/** where released/overflow balls emerge onto the floor, on the goal's wall */
export const TUNNEL_EXIT = { x: 68, y: -3 };
/** gate-release exit velocity. Kept GENTLE (low `along`): a big forward push
 * plows the whole drain out in a straight conga line. With little momentum the
 * front balls stall on friction and the ones behind carom off them, so the
 * drain fans out across the floor instead of running linear. */
export const TUNNEL_EXIT_VEL = { along: 22, inward: 8 }; // toward audience, off the wall

// ---------------------------------------------------------------- zones ----
/** small audience-side launch zone: apex (0,-48), base 2 tiles on the wall */
export const AUD_ZONE_APEX_Y = 48;
export const AUD_ZONE_HALF_W = 24;

/** BASE ZONE: 18x18 with its outer corner at the tile intersection
 * (driverSide*24, -48), extending inward — center (driverSide*33, -39).
 * Diagonally opposite corners (driverSide*24,-48) and (driverSide*42,-30),
 * per the manual Figure 9-3 (measured on-field). */
export const BASE_CENTER = { x: 33, y: -39 };

/** loading zone: 23x23 audience corner on the drive-team side */
export const LOAD_ZONE_SIZE = 23;

/** loading-zone artifact layout (driverSide-relative in x; y is audience-anchored).
 * The GRAB ROW is the 3 pre-staged artifacts, in a row along field-x (which reads
 * vertical on the driver's rotated screen) so a robot sweeps all 3 driving along x.
 * The 2x3 BOX is the human player's out-of-play storage, tucked into the audience
 * corner behind the grab row. */
export const LOAD_COL_XS = [51, 58, 65] as const; // 3 grab-row columns (clear of the corner pre-stage)
export const LOAD_ROW_Y = -65; // grab row y — ~7in in front of the audience wall (y=-72)
// the box is OFF the field (the human player stands off-field): its two rows sit
// well beyond the audience wall (y < -FIELD_HALF) with a clear gap from it, aligned
// below the grab row. This "beyond the audience wall" direction maps to the screen's
// horizontal axis, which has slack past VIEW_MARGIN on landscape windows, so the box
// stays on-screen without shrinking the field.
export const LOAD_BOX_YS = [-80, -85] as const;

/** depot band: floor in front of the goal face, out to the ~30in depot line
 * (the line spans the goal face base — endpoints are the face corners pushed
 * DEPOT_DEPTH out along the face normal, giving the manual's ~30in length) */
export const DEPOT_DEPTH = 6; // perpendicular depth of the band
/** SECRET TUNNEL ZONE (manual Section 9): ~46.5in long x ~6.125in wide floor
 * band along the side wall from the gate toward the audience, bounded by
 * alliance-colored tape. Belongs to the alliance whose DRIVE TEAM is on that
 * wall — i.e. the OPPOSING alliance to the goal above it (its released
 * artifacts roll out here, cross-court from that goal's own drivers). */
export const TUNNEL_STRIP_LEN = 46.5;
export const TUNNEL_W = 6.125; // strip width from the wall

/** spike marks: 10in horizontal white tape, three per side in a column just
 * ONE tile from each side wall (column center ~23.5in off the wall — value
 * re-verified against the Section 9 markings figure July 2026; an older
 * comment claiming "two tiles" was wrong, the VALUE was right); balls sit in
 * a row on the mark */
export const SPIKE_COL_X = 48.5;
export const SPIKE_ROW_YS = [-35.5, -12.8, 11.1]; // near, middle, far
export const SPIKE_BALL_SPACING = 5.6;
export const SPIKE_MARK_LEN = 10;

/** robot start poses, all inside the big launch zone near the alliance's
 * goal (blue goal is far-left, so blue mirrors to the left). Coordinates and
 * headings are authored for goalSide=+1; the spawn helper mirrors them for the
 * other alliance. Headings are in degrees, measured in the field frame.
 * Index = the menu/lobby "start position" choice per robot slot. */
export const START_POSES = [
  { x: 50, y: 55, headingDeg: 270, label: 'CLOSE SIDE' }, // the original solo pose
  { x: 20, y: 40, headingDeg: 315, label: 'CENTER' },
  { x: 18, y: -60, headingDeg: 0, label: 'FAR SIDE' },
] as const;

// --------------------------------------------------------- human player ----
export const HP_PLACE_DELAY = 0.15; // s between placements from the box into the grab row (fast HP)
/** the alliance-area pool is two 3-ball preload sets (4P+2G total); each present
 * robot takes one, and any leftover sets seed the human-player box (spawn.ts hpBox) */
export const PRELOAD: readonly ('purple' | 'green')[] = ['purple', 'green', 'purple'];
export const HP_INITIAL_STOCK: readonly ('purple' | 'green')[] = ['purple', 'purple', 'green'];

// -------------------------------------------------------- robot presets ----
/** named example robots covering the archetype matrix; the menu also offers
 * a fully custom builder. Keep DEFAULT ("Standard Issue") = the original
 * tuned solo feel. */
export const ROBOT_PRESETS: readonly RobotSpec[] = [
  {
    name: 'Standard Issue', teamName: 'Baseline Robotics', teamNumber: 1234,
    length: 15, width: 18, intake: 'sloped', massLb: 26, drivetrain: 'mecanum',
    driveRpm: 435, flywheelInertia: 0.5, canSort: false,
  },
  {
    name: 'Bulldozer', teamName: 'Iron Plows', teamNumber: 9909,
    length: 15, width: 18, intake: 'sloped', massLb: 36, drivetrain: 'tank',
    driveRpm: 340, flywheelInertia: 0.9, canSort: false,
  },
  {
    name: 'Hummingbird', teamName: 'Featherweights', teamNumber: 5511,
    length: 12.5, width: 12, intake: 'vector', massLb: 22, drivetrain: 'swerve',
    driveRpm: 500, flywheelInertia: 0, canSort: false,
  },
  {
    name: 'Crossfire', teamName: 'Diagonal Society', teamNumber: 8080,
    length: 13, width: 14, intake: 'triangle', massLb: 23, drivetrain: 'xdrive',
    driveRpm: 480, flywheelInertia: 0.35, canSort: false,
  },
  {
    name: 'The Librarian', teamName: 'Sorted Motors', teamNumber: 3141,
    length: 12.5, width: 16, intake: 'triangle', massLb: 26, drivetrain: 'mecanum',
    driveRpm: 400, flywheelInertia: 0.6, canSort: true,
  },
] as const;

// ------------------------------------------------------------------ sim ----
// 60 Hz fixed timestep. Lower than 120 so weaker browsers can sustain it (in
// lockstep multiplayer everyone is coupled to the slowest peer) and so the
// 8-tick INPUT_DELAY buffer covers ~133 ms of latency. step() is dt-parameterized
// (physics scales with dt), so this stays deterministic across peers.
export const SIM_DT = 1 / 60;
export const MAX_STEPS_PER_FRAME = 5;
/** Angle tolerance (radians) for heading alignment between path segments.
 * If the difference between the robot's current heading and the next segment's
 * start heading is greater than this, the robot will rotate to align. */
export const ALIGNMENT_ANGLE_TOLERANCE = 0.02; // ~1.1 degrees
/** Rotational speed (radians/second) for heading alignment. */
export const ALIGNMENT_ROTATIONAL_SPEED = 3.0; // rad/s

// ------------------------------------------------------------ rendering ----
export const COLORS = {
  mat: '#23262b',
  tile: '#2c3038',
  wall: '#4b5563',
  red: '#ef4444',
  redDim: 'rgba(239,68,68,0.10)',
  blue: '#3b82f6',
  blueDim: 'rgba(59,130,246,0.10)',
  white: '#e5e7eb',
  purple: '#a855f7',
  green: '#22c55e',
  launchTint: 'rgba(229,231,235,0.05)',
} as const;
export const VIEW_MARGIN = 14; // in of world margin around the field when fitting (just clears the obelisk)

// ------------------------------------------------------------ off-field ----
/** ALLIANCE AREA: taped drive-team rectangle OUTSIDE each alliance wall
 * (red left, blue right). Runs from the audience wall toward the far wall —
 * NOT wall-centered (verified from the Section 9 figures). */
export const ALLIANCE_AREA_ALONG = 96; // in along the wall
export const ALLIANCE_AREA_DEEP = 54; // in outward from the wall