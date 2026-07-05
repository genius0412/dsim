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

// -------------------------------------------------------------- scoring ----
export const PTS_LEAVE = 3;
export const PTS_CLASSIFIED = 3;
export const PTS_OVERFLOW = 1;
export const PTS_DEPOT = 1;
export const PTS_PATTERN = 2; // per ramp slot matching the motif
export const PTS_BASE_PARTIAL = 5;
export const PTS_BASE_FULL = 10;

// ------------------------------------------------------------ artifacts ----
export const BALL_RADIUS = 2.5; // 5 in diameter
export const BALL_ROLL_FRICTION = 25; // in/s^2
export const BALL_REST_SPEED = 2; // in/s, snap to rest below this
export const BALL_WALL_RESTITUTION = 0.5;
export const BALL_BALL_RESTITUTION = 0.55;
export const BALL_GROUND_RESTITUTION = 0.45; // vertical bounce
export const BALL_BOUNCE_H_RETAIN = 0.8; // horizontal speed kept on ground bounce
export const GRAVITY = 386; // in/s^2
/** light foam ball off a heavy chassis: nearly inelastic — the ball inherits
 * the chassis surface speed but gains almost no extra bounce */
export const BALL_ROBOT_RESTITUTION = 0.05;
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

// ---------------------------------------------------------------- robot ----
export const ROBOT_MAX_SIZE = 18; // FTC starting size cap (incl. intake reach)
export const ROBOT_MIN_SIZE = 12;
/** the chassis may be narrower than the intake (easier base parking) */
export const ROBOT_MIN_WIDTH = 10;
/** wheel centers sit this far INSIDE the chassis edge (typical FTC build);
 * the four wheel ground-contact points are what counts for base parking */
export const WHEEL_INSET = 2.6;
/** mecanum drivetrain, modeled on real motor limits: wheel saturation is
 * |fwd| + |strafe| + |rot| (the worst wheel sees all three demands added),
 * rotation tops out at wheelSpeed / (half track diagonal) like a real chassis,
 * and acceleration reflects an FTC bot hitting full speed in ~0.25s. */
export const DRIVE_MAX_SPEED = 75; // in/s forward (~1.9 m/s, fast FTC drivetrain)
export const STRAFE_MULT = 0.85; // roller slip: strafing slightly slower
export const TURN_MAX_SPEED = 7.0; // rad/s (~400°/s, wheelSpeed / half-diagonal)
export const DRIVE_ACCEL = 280; // in/s^2
export const TURN_ACCEL = 40; // rad/s^2

/** capture happens when a compliant wheel is DIRECTLY ABOVE the artifact:
 * the wheel line sits at the tip of the intake's reach, and a ball within
 * this band of it (ball radius + compliance squish) gets swallowed */
export const INTAKE_CAPTURE_BAND = 1; // in beyond ball radius, each way
/** fireInterval = transfer (outtake) cadence from hopper to shooter — the
 * ONLY firing rate limit (no flywheel spin-up model, per product decision).
 * overhang = the compliant wheels may stick out past a narrower chassis;
 * without it the chassis ENCOMPASSES the intake (trapezoid mouth recessed
 * between side prongs), which is what geometrically rules out side intake.
 * clumpPerBall = swallow cadence while 2+ balls sit at the mouth — sloped
 * and triangle devour clumps, vector feeds at its steady pace. */
export const INTAKE_PRESETS = {
  /** sloped ramp with a trapezoid mouth recessed in the frame (doesn't count
   * against the 18in cap): must face the ball, but swallows fast */
  sloped: {
    reach: 3, halfWidth: 6, perBall: 0.12, clumpPerBall: 0.04, overhang: false,
    minLength: 12, maxLength: 18, fireInterval: 0.1,
  },
  /** VECTOR WHEEL intake: wide compliant wheels ride over artifacts ahead of
   * the chassis (within the 18in cap — chassis 11.5..14.5in). Grabs whatever
   * is under a wheel — including balls strafed into, wherever the wheels
   * overhang the chassis — but slower per ball */
  vector: {
    reach: 3.5, halfWidth: 8.5, perBall: 0.22, clumpPerBall: 0.22, overhang: true,
    minLength: 11.5, maxLength: 14.5, fireInterval: 0.1,
  },
  /** TRIANGLE intake: named for the triangular ball storage inside the robot.
   * Longest reach, trapezoid mouth in the frame, slower transfer out */
  triangle: {
    reach: 5, halfWidth: 7, perBall: 0.15, clumpPerBall: 0.05, overhang: false,
    minLength: 12, maxLength: 13, fireInterval: 0.3,
  },
} as const;
/** flank capture engages only when actually strafing toward the ball */
export const INTAKE_SIDE_MIN_STRAFE = 8; // in/s

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
/** goal front face line constant: blue y - x = C, red y + x = C.
 * The goal is a wedge against the far wall, next to the classifier channel:
 * drawn footprint (g*45,72) (g*66,51) (g*66,72) — face on this line. */
export const GOAL_LINE_C = 117;
export const GOAL_FACE_FAR_X = 45; // face endpoint on the far wall
export const GOAL_FACE_SIDE_Y = 51; // face endpoint on the channel edge
export const GOAL_OPENING_Z = 38.75; // in, height of the opening lip
export const GOAL_WALL_TOP = 37; // flights below this bounce off the goal face
export const GOAL_OPENING_RADIUS = 11; // in, effective entry radius at the plane
export const GOAL_CENTER = { x: 58, y: 64 }; // opening center (goal side sign)

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
export const BASIN_FUNNEL_ACCEL = 45; // in/s^2 pull toward the classifier entrance
/** the funnel only really grips slow balls — fast ones carom around first */
export const BASIN_FUNNEL_GRIP_SPEED = 25; // in/s
export const BASIN_DAMPING = 0.8; // 1/s horizontal velocity damping
export const BASIN_ENTRY_RADIUS = 5; // in, hand-off distance to the rail
export const BASIN_ENTRY_KEEP_V = 0.55; // entry velocity retained (splash energy)

// classifier rail (1D flow, contact stacking)
export const RAIL_S_MAX = 48; // rail length: SQUARE at the top (y = CLASSIFIER_Y0 + s)
export const RAIL_ACCEL = 80; // in/s^2 down-ramp
export const RAIL_TERMINAL = 46; // in/s max flow speed
export const RAIL_PITCH = 5.1; // ball contact spacing on the stack
export const GATE_STOP_S = 2; // lowest rest position against the closed gate
export const RAIL_ENTRY_BLOCK_S = 43.4; // entrance blocked while a ball is above this
export const RAIL_EXIT_S = -4; // past the gate: ball drops out to the floor
export const OVERFLOW_FLOW_SPEED = 40; // in/s, overflow rides over everything
/** lateral/vertical glide rate as a ball settles onto the rail line */
export const RAIL_BLEND_SPEED = 30; // in/s

export const GATE_OPEN_HOLD = 0.08; // s of push before the gate swings open
/** once open, the spring can only re-close when no ball occupies the gateway */
export const GATE_CLOSE_CLEAR_LO = -4;
export const GATE_CLOSE_CLEAR_HI = 4.5;
/** gate zone tape in front of the gate: 10in from the wall at y ~ 0 */
export const GATE_ZONE = { xNear: 62, xFar: 72, y0: -2, y1: 3 };
/** where released/overflow balls emerge onto the floor, on the goal's wall */
export const TUNNEL_EXIT = { x: 68, y: -3 };
export const TUNNEL_EXIT_VEL = { along: 42, inward: 7 }; // toward audience, off the wall

// ---------------------------------------------------------------- zones ----
/** small audience-side launch zone: apex (0,-48), base 2 tiles on the wall */
export const AUD_ZONE_APEX_Y = 48;
export const AUD_ZONE_HALF_W = 24;

/** base zone: 18x18 centered on the tile at (driverSide*36, -36) */
export const BASE_CENTER = { x: 36, y: -36 };

/** loading zone: 23x23 audience corner on the drive-team side */
export const LOAD_ZONE_SIZE = 23;

/** depot band: floor in front of the goal face, out to the 30in depot line */
export const DEPOT_DEPTH = 6; // perpendicular depth of the band

/** spike marks: 10in horizontal white tape, three per side in a column just
 * off the tile seam two tiles from each side wall; balls sit in a row on the
 * mark (positions measured from the manual's Figure 9-3) */
export const SPIKE_COL_X = 48.5;
export const SPIKE_ROW_YS = [-35.5, -12.8, 11.1]; // near, middle, far
export const SPIKE_BALL_SPACING = 5.6;
export const SPIKE_MARK_LEN = 10;

/** robot start pose: inside the big launch zone NEAR THE ALLIANCE'S GOAL
 * (blue goal is far-left, so blue starts on the left) */
export const START = { x: 30, y: 45 };

// --------------------------------------------------------- human player ----
export const HP_PLACE_DELAY = 3; // s between placements into the loading zone
/** preloaded hopper (from the alliance area's 6: 4P+2G); rest becomes HP stock */
export const PRELOAD: readonly ('purple' | 'green')[] = ['purple', 'green', 'purple'];
export const HP_INITIAL_STOCK: readonly ('purple' | 'green')[] = ['purple', 'purple', 'green'];

// ------------------------------------------------------------------ sim ----
export const SIM_DT = 1 / 120;
export const MAX_STEPS_PER_FRAME = 5;

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
export const VIEW_MARGIN = 26; // in of world margin around the field when fitting
