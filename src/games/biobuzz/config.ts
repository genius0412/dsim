/**
 * BIOBUZZ (FTC 2026–27) — field + element constants.
 *
 * ── WHAT IS ACTUALLY KNOWN, AS OF THE V0 PRE-SEASON MANUAL ──────────────────
 * `BIOBUZZ_Competition_Manual_V0.pdf` (93 pages, fetched with `scripts/manual.mjs`) ships
 * Sections 1–7 and 12–16. Sections 8 (Game Overview), 9 (ARENA), 10 (Game Details) and 11
 * (Game Rules) are each a single page reading "This section will be updated with the Kickoff
 * Competition Manual release on September 12, 2026". So NOTHING about the field, the scoring
 * elements, the goals, the zones or the point values is published yet.
 *
 * What Section 12 DOES fix, and what this file is therefore entitled to assume:
 *  • R102 — STARTING CONFIGURATION is limited to an 18-inch CUBE.
 *  • R104 — there is NO ROBOT weight limit.
 *  • R105 — a ROBOT stays one assembly and may expand past its starting configuration, but
 *    "Sizing Constraints and more details will be released at Kickoff". The expansion PRISM
 *    below is therefore the one number in the robot envelope that is still a guess.
 *
 * ── THE APPROX CONVENTION ───────────────────────────────────────────────────
 * Every constant whose value is NOT in the V0 manual carries an `APPROX` comment naming what
 * it was derived from. That is not decoration: at Kickoff someone greps `APPROX` in this file
 * and that grep IS the work list. A number without the marker is a number the manual gave us.
 *
 * The FIELD is the safe part: every FTC field since 2007 has been a 12 ft × 12 ft (144") soft
 * tile field inside a perimeter wall, and R102/R104 are unchanged from DECODE. Origin at the
 * centre, +x = audience right, +y = away from the audience — the same frame DECODE and Chain
 * Reaction use, so the shared camera, drivetrain and Rapier solve need no per-game handling.
 *
 * ── TERMINOLOGY (see `docs/biobuzz-contract.md` §6) ─────────────────────────
 * The scoring element is a POLLEN. Not a ball, not a particle, not an artifact — those are
 * DECODE's and Chain Reaction's words, and the user-visible strings in this game say POLLEN.
 * Pollen ride `world.balls` as `Artifact`s because that is the shared transport the physics,
 * the snapshot and the wire already speak; the TYPE is shared, the NAME is not.
 *
 * Copied and owned from `games/chain/config.ts`. Everything catalyst / hook / accelerator /
 * ring-stand / beam / lab-area / ground-clearance specific is deleted rather than carried
 * over — a shell that ships CR's field furniture under BIOBUZZ names would be worse than an
 * empty field, because it would look finished.
 */

import type { AssistConfig, RobotSpec, StartCat } from '../../types';
import { INTAKE_PRESETS, ROBOT_MAX_SIZE } from '../../config';
import { lengthLimits, massLimits, widthLimits } from '../../sim/drivetrain';
import {
  BB_DEFAULT_INTAKE_MOUNT,
  type BbIntakeMount,
  type BbScoreMode,
  bbIntakeMountOf,
} from './mounts';

/** millimetres → inches (the sim's world unit). The manual dimensions arrive in mm, so this
 * is the conversion every element constant is written THROUGH rather than pre-multiplied,
 * which keeps the manual's own number visible in the source. */
export const mm = (v: number): number => v / 25.4;

// ─────────────────────────────────────────────────────────────────────────────
// FIELD
// ─────────────────────────────────────────────────────────────────────────────

/** field half-extents (in). A 12 ft × 12 ft FTC field is 144" square ⇒ ±72 from centre.
 * NOT approximate: every FTC field is this size, and R102's 18" cube is stated against it. */
export const BB_HALF_X = 72;
export const BB_HALF_Y = 72;

/** perimeter wall collider half-thickness (in). Deliberately far thicker than a real wall:
 * these cuboids sit entirely OUTSIDE the play area, and a thick static is what stops a fast
 * robot from tunnelling through a thin one in a single 1/60 s step. */
export const BB_WALL_T = 10;

/** camera fit margin (in) — breathing room around the field so the walls are not flush with
 * the viewport edge. */
export const BB_VIEW_MARGIN = 8;

/** the outer x half-extent the CAMERA must show. Equal to the wall for now: BIOBUZZ has no
 * known structure protruding outside the perimeter (CR's accelerators did, which is why the
 * shared `bounds` carries a view extent distinct from the collider extent at all).
 * APPROX — Section 9 (ARENA) lands at Kickoff and may add an outboard goal. */
export const BB_VIEW_HALF_X = BB_HALF_X;

// ─────────────────────────────────────────────────────────────────────────────
// POLLEN — the scoring element
// ─────────────────────────────────────────────────────────────────────────────

/** POLLEN radius (in). APPROX: a 3" OD ball, i.e. the size a wiffle-ball scoring element has
 * been in DECODE (5" artifacts aside) and Chain Reaction. Section 10 fixes this at Kickoff. */
export const BB_POLLEN_R = 3 / 2;

/** how many POLLEN the shell scatters. APPROX: 60 is a placeholder chosen to LOOK like a
 * field worth driving on and to be cheap in the shared solve, not a manual count. It is also
 * deliberately far below CR's 300 so the shell's step cost has headroom for whatever Section
 * 10 actually asks for. */
export const BB_POLLEN_SIM = 60;

/**
 * GROUND POLLEN PHYSICS IS NOT CONFIGURED HERE, AND THERE IS NOTHING TO PUT BACK.
 *
 * A ground POLLEN is solved by the SHARED artifact solve (`solveArtifacts`), which BIOBUZZ
 * calls with `BB_POLLEN_R` and nothing else. Friction, restitution, rest speed, contact
 * stiffness and the speed cap are all the shared solve's constants in `src/config.ts`
 * (`PHYS_BALL_*`, `BALL_*`), they are the repo OWNER's to tune, and BIOBUZZ must not shadow
 * them — a second set of numbers describing the same contact is the same bug as a second
 * integrator. See `docs/biobuzz/feedback/000-solver-observations.md` for what the shared solve
 * does with a 1.5" element, and `play.ts`'s header for why it is the only one.
 *
 * Four constants used to live here (`BB_POLLEN_FRICTION`, `_REST_SPEED`, `_SEP_ITERS` and the
 * wall restitution), copied from CR's particle model for the bespoke arm that is now deleted.
 * Only the wall restitution survives, because FLIGHT pollen are still this game's own:
 */

/** how much of its speed a POLLEN keeps when a LOB hits a wall. FLIGHT ONLY — a ground pollen's
 * wall bounce is the shared solve's `BALL_WALL_RESTITUTION`. APPROX: a guess about a 3" foam
 * ball, and only a picture judges it (`launch-wall-bounce` in the gallery). */
export const BB_POLLEN_WALL_REST = 0.35;

// ─────────────────────────────────────────────────────────────────────────────
// MATCH — the shell reuses the shared phase durations (`src/config.ts`), because auto /
// transition / teleop lengths are set by the Tournament section, not by the game, and
// Section 13 (Tournament) IS published in V0 and unchanged.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The ACT this season starts on. BIOBUZZ is DSIM's third game, so its record/ranked periods
 * begin at 2 (DECODE 0, Chain Reaction 1). Read by the shared `initialAct` slot rather than a
 * per-game ternary in the season code.
 */
export const BB_INITIAL_ACT = 2;

// ─────────────────────────────────────────────────────────────────────────────
// ROBOT — intake geometry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * INTAKE DESIGN. The only style in the shell is the SWEEPER — a full-width roller. Its MOUNT
 * (`RobotSpec.intakeMount`) picks which chassis edge(s) carry it: FRONT (default), BACK, both
 * SIDES, or FRONT+BACK.
 *
 * The geometry lives in `bbMouths` (robot.ts) — one rect per mounted edge, shared by the
 * capture logic AND both renderers, so THE DRAWN MOUTHS ARE THE CAPTURE AREAS. The same mount
 * drives `footprintExtents`, so it moves the COLLISION box with it. Open edges cost hopper
 * volume (`bbMountStoreMult`).
 *
 * `widthFrac`·chassis + `overhang` = the mouth half-width on an END edge (a flank mouth spans
 * the chassis length); `depth` = how far behind the edge it reaches, which is what lets the
 * roller catch a POLLEN before the frame would plow it.
 */
export interface BbIntakeGeom {
  widthFrac: number; // mouth half-width as a fraction of the chassis half-width
  overhang: number; // extra mouth half-width past the frame (deployed intake), inches
  depth: number; // mouth reaches this far BEHIND the edge (into the frame), inches
}
export const BB_INTAKE_STYLES = ['sweeper'] as const;
export type BbIntakeStyle = (typeof BB_INTAKE_STYLES)[number];
export const BB_INTAKES: Record<BbIntakeStyle, BbIntakeGeom> = {
  sweeper: { widthFrac: 1.0, overhang: 0, depth: 2.5 }, // full-width roller
};
export const BB_DEFAULT_INTAKE: BbIntakeStyle = 'sweeper';

// ─────────────────────────────────────────────────────────────────────────────
// ROBOT — launcher geometry (the four archetypes)
// ─────────────────────────────────────────────────────────────────────────────

export const BB_DEFAULT_SCORE_MODE: BbScoreMode = 'turret';

/** turret slew rate (rad/s). A turret does NOT snap to a heading — it swings at a finite rate,
 * which is why a turreted robot must spawn already pointed at its target rather than spending
 * the first second of auto rotating. APPROX: CR's tuned value, and turret hardware has not
 * changed. */
export const BB_TURRET_SLEW = 7;

/** heading error (rad) under which a TURNED robot counts as aimed, and the P-gain that turns
 * it. Only turretless archetypes use these: the fire button steers the chassis. APPROX. */
export const BB_AIM_TOL = 0.14;
export const BB_AIM_GAIN = 4.5;

/** fraction of the chassis width a turretless launcher's parallel launch LINE spans. Slightly
 * under 1 so the outermost POLLEN of a burst is not born exactly on the frame line. APPROX. */
export const BB_LAUNCH_LINE_FRAC = 0.92;

/** launch height (in) — how high off the tile a POLLEN leaves the mechanism. APPROX and
 * PLACEHOLDER: without Section 9 there is no target height to arc into, so `releasePollen`
 * lobs with whatever velocity the caller hands it and this is only the z it starts at. */
export const BB_LAUNCH_Z0 = 10;

/** the launcher's plate channel, in inches — `GAP` is the clear width between the two plates
 * a POLLEN passes between, `OVERHANG` how far they reach past the flywheel. GAP is
 * `BB_POLLEN_R * 2` plus a working clearance, which is why it tracks the element size rather
 * than being an independent number. APPROX with the element. */
export const BB_LAUNCH_PLATE_GAP = BB_POLLEN_R * 2 + 0.3;
export const BB_LAUNCH_PLATE_OVERHANG = 1.2;
/** lateral spacing of a TWIN turret's two barrels from the turret centre (in) — half the
 * plate gap, so the two channels sit shoulder to shoulder. */
export const BB_TWIN_BARREL_OFFSET = BB_LAUNCH_PLATE_GAP / 2;
/** a twin turret's throughput bonus and the mass floor its second flywheel assembly adds. */
export const BB_TWIN_FIRE_MULT = 1.15;
export const BB_TWIN_MASS_FLOOR = 2.5; // lb on the chassis mass FLOOR

/** DRUM: a chassis-wide flywheel drum. `MAX` is its pocket count (an 18" drum of 3" pockets),
 * `INTERVAL` the nominal gap between shots with `JITTER` of natural variation either side,
 * and `SPEED` the uniform horizontal launch speed. APPROX — all four are CR's tuning. */
export const BB_DRUM_MAX = 6;
export const BB_DRUM_INTERVAL = 1 / 30;
export const BB_DRUM_JITTER = 0.55;
export const BB_DRUM_SPEED = 175;

/** single-shooter cadence (s between shots) — 13 POLLEN/s. The turret ACCUMULATES this
 * interval rather than re-anchoring to `world.time`, so the sub-tick remainder carries and
 * the long-run rate averages exactly 13/s instead of tick-quantizing to 12 or 15. APPROX. */
export const BB_FIRE_INTERVAL = 1 / 13;

// ─────────────────────────────────────────────────────────────────────────────
// ROBOT — chassis envelope
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The EXPANSION PRISM (in) a robot may grow into once the match starts.
 *
 * APPROX, and the single biggest robot-envelope guess in this file. R105 says expansion is
 * bounded but that "Sizing Constraints and more details will be released at Kickoff", so 24"
 * is carried over from Chain Reaction's manual as a plausible bound rather than a known one.
 * `BB_EXPANSION` is what that leaves past the 18" starting cube.
 */
export const BB_PRISM = 24;
export const BB_EXPANSION = BB_PRISM - ROBOT_MAX_SIZE; // 6" past the starting cube

/**
 * Chassis size range (in), BOTH axes — the range BIOBUZZ itself wants.
 *
 * The CEILING is R102's 18" starting cube less a working inch for the bumper and frame slop a
 * real build has. The FLOORS are DECODE's per-intake floors, because there is no BIOBUZZ rule
 * to argue a different one from: Section 9 (ARENA) is the page that would tell us how big a
 * start zone is, and it lands at Kickoff. All four are APPROX.
 */
export const BB_MIN_LENGTH = 13.5;
export const BB_MAX_LENGTH = 17;
export const BB_MIN_WIDTH = 14.5;
export const BB_MAX_WIDTH = 17;

/**
 * CHASSIS SIZE LIMITS, per build — the INTERSECTION of two envelopes.
 *
 * 1. WHAT BIOBUZZ WANTS. The SWEEPER DEPLOYS, so it does not have to fit inside R102's 18"
 *    starting cube alongside the chassis — that is what most real FTC intakes do. But it is
 *    real structure once deployed, so chassis + sweepers must fit the EXPANSION prism, and
 *    which AXIS it eats depends on the mount, which is the whole point of having mounts:
 *      • front / back → one reach off the LENGTH
 *      • front+back   → TWO reaches off the LENGTH (a sweeper on each end)
 *      • side         → TWO reaches off the WIDTH (a sweeper on each flank)
 *    NOT floored to the minimum on purpose: when the deployed sweepers leave nothing legal
 *    the max drops BELOW the min, and `bbMountFits` is what reports that combination as
 *    impossible. Flooring here would instead hand back a robot that overruns the prism.
 *
 * 2. WHAT THE SHARED COERCER CURRENTLY ALLOWS. `coerceSpec` has a `game === 'chain'` arm that
 *    swaps in CR's size envelope, and no BIOBUZZ arm yet (Lane B owns adding one — see
 *    `docs/biobuzz-contract.md`, `src/sim/spawn.ts` row). Until it lands, a BIOBUZZ spec is
 *    sized by DECODE's per-intake `lengthLimits`/`widthLimits`, and a builder that offered a
 *    dial the chokepoint then clamped back would be a slider that visibly snaps.
 *
 * Intersecting means the builder never offers a size the coercer refuses, TODAY, and the
 * range simply widens to term 1 the moment term 2 stops binding. The intersection is also
 * what keeps `BB_PRESETS` a coercer no-op, which is what makes a preset card highlight as
 * selected — smoke asserts it.
 */
export function bbSizeLimits(spec: RobotSpec): {
  minLength: number;
  maxLength: number;
  minWidth: number;
  maxWidth: number;
} {
  const reach = INTAKE_PRESETS[spec.intake].reach;
  const mount = bbIntakeMountOf(spec);
  const ends = mount === 'front' || mount === 'back' ? 1 : mount === 'frontback' ? 2 : 0;
  const flanks = mount === 'side' ? 2 : 0;
  const shL = lengthLimits(spec.intake);
  const shW = widthLimits(spec.intake, spec.drivetrain);
  return {
    minLength: Math.max(BB_MIN_LENGTH, shL.min),
    maxLength: Math.min(BB_MAX_LENGTH, BB_PRISM - ends * reach, shL.max),
    minWidth: Math.max(BB_MIN_WIDTH, shW.min),
    maxWidth: Math.min(BB_MAX_WIDTH, BB_PRISM - flanks * reach, shW.max),
  };
}

/**
 * Can this intake preset be mounted this way at all?
 *
 * TRUE for every combination today — the sweeper deploys, so no mount can push the chassis
 * envelope below its own floor. Kept, and kept CALLED, on purpose: it is the one place that
 * answers "is this build possible" for both the coercer and the builder's greying-out, and
 * re-deriving that at two call sites the day a mechanism does constrain size is exactly how
 * the two drift apart.
 */
export function bbMountFits(spec: RobotSpec, mount: BbIntakeMount): boolean {
  const l = bbSizeLimits({ ...spec, intakeMount: mount });
  return l.maxLength >= l.minLength && l.maxWidth >= l.minWidth;
}

// ─────────────────────────────────────────────────────────────────────────────
// ROBOT — hopper capacity
// ─────────────────────────────────────────────────────────────────────────────

/** a floor of one POLLEN; NOT scaled with the rest. */
export const BB_STORAGE_MIN = 1;
/**
 * CEILING. APPROX, and RETUNED after looking at it.
 *
 * The first pass at these two numbers was carried over from a game whose element is much
 * smaller, and it made a mid-size dumper hold THIRTY-NINE POLLEN with a ceiling of 122. The
 * gallery is what showed it: `launch-wall-bounce` dumped a full hopper and drew a single-file
 * line of pollen along the entire 144" wall, because thirty-nine 3" balls is not a hopper, it
 * is a third of the field's supply riding inside one robot.
 *
 * The model now assumes ONE LAYER: a 3" POLLEN needs ~9 in² of hopper floor (hex packing is
 * 7.8, and nothing packs perfectly), plus the walls, the feed path and the shooter's own
 * volume — call it 12 in² apiece. A second layer would need a lift, and the shell has no
 * mechanism for one. That puts the default 15×17 turret at ~11 POLLEN and an open 18" dumper at
 * the 24 ceiling, which is the shape of a real FTC hopper.
 *
 * STILL A GUESS. Section 7 (the element) and Section 10 (Game Details) both land at Kickoff,
 * and either could move the diameter — which moves all of this. It is one constant.
 */
export const BB_STORAGE_MAX = 24;
export const BB_STORAGE_DEFAULT = 8;

/** square inches of footprint per stored POLLEN — the derived cap's only size term, so it is
 * the single dial for storage across every archetype, mount and chassis size. APPROX; see the
 * note on `BB_STORAGE_MAX` for where 12 comes from. */
export const BB_STORE_AREA_PER_BALL = 12;
export const BB_STORE_TURRET_MULT = 0.55; // a turret loses centre volume to the rotor + shooter
export const BB_STORE_TWIN_MULT = 0.45; // a second shooter assembly eats even more of it
export const BB_STORE_LAUNCHER_MULT = 1.0; // drum + dumper: open hopper (large, equal)
/** INTAKE MOUNT storage cost — every mounted edge is an OPENING the hopper cannot use.
 * front and back are mirror images (one open end), so a rear sweeper is a free stylistic
 * choice; two mounts cost real volume. SIDE is harshest, because the flanks run the full
 * chassis LENGTH — that is the price of collecting a stream you drive alongside. */
export const BB_STORE_SIDE_MULT = 0.6;
export const BB_STORE_FRONTBACK_MULT = 0.75;

/** the hopper-volume factor an intake mount costs (1 = no cost). */
export function bbMountStoreMult(mount: BbIntakeMount): number {
  if (mount === 'side') return BB_STORE_SIDE_MULT;
  if (mount === 'frontback') return BB_STORE_FRONTBACK_MULT;
  return 1; // front / back — a single open end, mirror images of each other
}

/** the MAX POLLEN this robot can hold — footprint × an archetype factor × the intake-mount
 * factor, clamped to [MIN, MAX]. */
export function bbStorageMax(spec: RobotSpec): number {
  const area = spec.length * spec.width;
  const mode = (spec.scoreMode ?? BB_DEFAULT_SCORE_MODE) as BbScoreMode;
  const mult =
    (mode === 'turret'
      ? BB_STORE_TURRET_MULT
      : mode === 'twinturret'
        ? BB_STORE_TWIN_MULT
        : BB_STORE_LAUNCHER_MULT) * bbMountStoreMult(bbIntakeMountOf(spec));
  const cap = Math.round((area / BB_STORE_AREA_PER_BALL) * mult);
  return Math.max(BB_STORAGE_MIN, Math.min(BB_STORAGE_MAX, cap));
}

/**
 * The robot's ACTIVE hopper capacity: its chosen `ballStorage`, clamped to its
 * archetype+size max. Read by the sim (the intake cap), the renderer (how full to draw the
 * hopper) and the HUD, so all three agree on one number.
 *
 * It lives HERE rather than in `robot.ts` even though the contract lists it as a robot export,
 * because `elements.ts` needs the cap to know whether a capture fits and importing `robot.ts`
 * for it would make an elements↔robot cycle. `robot.ts` re-exports it under the contract name.
 */
export function bbHopperCap(spec: RobotSpec): number {
  const want = Math.round(spec.ballStorage ?? BB_STORAGE_DEFAULT);
  return Math.max(BB_STORAGE_MIN, Math.min(bbStorageMax(spec), want));
}

/** extra lb on the chassis MASS FLOOR from the BIOBUZZ scoring mechanism. Only the twin
 * turret carries one (a whole second flywheel assembly); every other archetype is already
 * priced into the base chassis. Threaded into `massLimits` by the coercer and by the
 * builder's mass slider, so the floor the UI offers is the floor the sim enforces. */
export function bbMassFloorBump(spec: RobotSpec): number {
  return (spec.scoreMode ?? BB_DEFAULT_SCORE_MODE) === 'twinturret' ? BB_TWIN_MASS_FLOOR : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// START ANCHORS
// ─────────────────────────────────────────────────────────────────────────────

export interface BbStartAnchor {
  name: string;
  pos: { x: number; y: number };
  heading: number;
}

/**
 * The named start anchors — CANONICAL for BLUE (goal side +x); RED is the x-mirror, applied
 * once in `spawn.ts` so no other file mirrors anything.
 *
 * TWO anchors, because a BIOBUZZ alliance is two robots and each locks one so they cannot
 * stack. There is no third or fourth because there is no known reason for one: CR's extra
 * pair existed to put a robot on a Ring Stand, and BIOBUZZ has no such structure published.
 *
 * APPROX — ALL OF IT. Section 9 (ARENA) is the page that says where a robot may start, and it
 * lands at Kickoff. These sit a robot half-length off the +x wall at y = ±36 (the quarter
 * points of that wall), facing the field centre, which is the layout every FTC start zone has
 * had and is far enough from the perimeter that a 17" chassis at any heading is inside the
 * field. `startLegality` is FALSE for this game, so these are a convenience, not a rule the
 * server enforces — which is exactly the right posture until the rule exists.
 *
 * ORDER IS LOAD-BEARING: a 2-robot alliance defaults to anchors 0 and 1, so index 0 must be
 * the TOP (y ≥ 0) anchor and index 1 the BOTTOM one.
 */
export const BB_START_POSES: readonly BbStartAnchor[] = [
  { name: 'START · TOP', pos: { x: 60, y: 36 }, heading: Math.PI },
  { name: 'START · BOTTOM', pos: { x: 60, y: -36 }, heading: Math.PI },
];

/** how many start anchors this game offers — read by the shared per-game start-index clamp
 * (`coerceStartIndex` / `coerceSetup`) instead of DECODE's `START_POSES.length`. */
export const BB_START_POSE_COUNT = BB_START_POSES.length;

/**
 * Start ROLES are TOP / BOTTOM (which half of the start wall a robot occupies), not DECODE's
 * CLOSE / FAR. The shared `StartCat` slots carry it: close = TOP (y ≥ 0), far = BOTTOM
 * (y < 0), so a locked role limits the selector to that anchor.
 */
export const bbAnchorCat = (index: number): StartCat =>
  (BB_START_POSES[index]?.pos.y ?? 0) >= 0 ? 'close' : 'far';
export const bbDefaultIndex = (cat: StartCat): number => {
  const i = BB_START_POSES.findIndex((_, idx) => bbAnchorCat(idx) === cat);
  return i >= 0 ? i : 0;
};
export const bbRoleLabel = (cat: StartCat | undefined): string =>
  cat === 'close' ? 'TOP' : cat === 'far' ? 'BOTTOM' : '-';

// ─────────────────────────────────────────────────────────────────────────────
// PENALTIES
// ─────────────────────────────────────────────────────────────────────────────

/** inches of bumper slack for the robot-robot contact test. The BIOBUZZ penalty engine is
 * EMPTY (`penalties.ts`) — Section 11 (Game Rules) is a Kickoff page, so there are no rules
 * to enforce. This constant exists because the edge-trigger scaffold is wired and tested; the
 * first real foul only has to add its own predicate. */
export const BB_FOUL_SLOP = 1;

// ─────────────────────────────────────────────────────────────────────────────
// PRESETS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every preset drives ROBOT-CENTRIC. A sweeper collects over the edge it is mounted on and a
 * turretless launcher fires over its own edge, so for most of these builds the chassis
 * heading IS the aim, and field-centric drive hides that heading from the stick. A preset
 * default, not a rule — the assist stays a per-robot setting anyone can flip.
 *
 * Shared by reference rather than repeated, so "the presets all drive the same way" stays
 * true by construction.
 */
const BB_PRESET_ASSISTS: AssistConfig = {
  fieldCentric: false,
  aimAssist: true,
  autoIntake: true,
  autoFire: true,
};

/**
 * BIOBUZZ ROBOT PRESETS — one card per scoring archetype, so a single click sets a coherent
 * playstyle and the four cards between them demonstrate every mount.
 *
 * FOUR cards, not CR's nine: the five named team robots in CR's list are real builds for a
 * real game, and inventing BIOBUZZ equivalents before Section 10 exists would be inventing
 * playstyles for a game nobody has read. These four are archetype DEMOS and say so.
 *
 * All numbers stay inside the coercer's ranges, so applying a card is a no-op through the
 * coercer and the card highlights as selected — smoke asserts this.
 */
const BB_PRESET_BUILDS: readonly RobotSpec[] = [
  {
    // long-range precision: a turret aims itself, so the chassis never has to face anything —
    // which is exactly the build that can afford FRONT+BACK sweepers and collect while
    // driving in either direction. It pays ~25% of the hopper for that.
    name: 'Sniper', teamName: 'Turret · shoots and collects any direction', teamNumber: 0,
    length: 15, width: 17, intake: 'sloped', massLb: 24, drivetrain: 'swerve',
    driveRpm: 500, flywheelInertia: 0.2, canSort: false,
    scoreMode: 'turret',
    intakeMount: 'frontback', shooterMount: 'center',
    assists: BB_PRESET_ASSISTS,
  },
  {
    // volume hauler: a REAR dumper makes the whole cycle one straight line — drive forward to
    // fill the hopper, reverse into range, unload. No turning around at either end, and two
    // end mounts on opposite edges cost NO storage, so it keeps the biggest hopper in the set.
    name: 'Hauler', teamName: 'Dumper · fill forward, reverse and unload', teamNumber: 0,
    length: 15, width: 17, intake: 'sloped', massLb: 38, drivetrain: 'tank',
    driveRpm: 340, flywheelInertia: 0.2, canSort: false,
    scoreMode: 'dumper',
    intakeMount: 'front', shooterMount: 'back',
    assists: BB_PRESET_ASSISTS,
  },
  {
    // the volume shooter: SIDE sweepers turn a mecanum's strafe into the collection tool —
    // slide sideways along a line of POLLEN and hoover it up with the flank rollers, then face
    // the target and stream. Open flanks are the harshest storage cost, and the smallest
    // chassis in the set keeps the strafe quick.
    name: 'Drummer', teamName: 'Drum · strafe-collect, stream from anywhere', teamNumber: 0,
    length: 15, width: 15, intake: 'sloped', massLb: 25, drivetrain: 'mecanum',
    driveRpm: 470, flywheelInertia: 0.3, canSort: false,
    scoreMode: 'drum',
    intakeMount: 'side', shooterMount: 'front',
    assists: BB_PRESET_ASSISTS,
  },
  {
    // fast wall-runner: an x-drive strafes as fast as it drives, so a BROADSIDE launcher lets
    // it run the wall and fire sideways without ever turning — and the launch line then spans
    // the chassis LENGTH rather than its width.
    name: 'Skimmer', teamName: 'Twin turret · run the wall, fire broadside', teamNumber: 0,
    length: 15, width: 16, intake: 'sloped', massLb: 26, drivetrain: 'xdrive',
    driveRpm: 520, flywheelInertia: 0.1, canSort: false,
    scoreMode: 'twinturret',
    intakeMount: 'front', shooterMount: 'right',
    assists: BB_PRESET_ASSISTS,
  },
] as const;

/**
 * The shipped builds, with MASS and HOPPER derived rather than typed out.
 *
 * Both are FUNCTIONS of the build — the mass floor of a drivetrain × inertia × mechanism, and
 * the capacity of a footprint × archetype × mount — so a hard-coded number would quietly stop
 * being "the minimum" / "the maximum" the moment any of those constants moved, and a preset
 * whose value the coercer then clamps is a card that stops highlighting as selected.
 */
export const BB_PRESETS: readonly RobotSpec[] = BB_PRESET_BUILDS.map((s) => ({
  ...s,
  massLb: Math.max(s.massLb, massLimits(s.drivetrain, s.flywheelInertia, bbMassFloorBump(s)).min),
  ballStorage: bbStorageMax(s),
}));

/** the default mount for a build that arrives without one (re-exported so the builder and the
 * coercer read the same constant the leaf module defines). */
export { BB_DEFAULT_INTAKE_MOUNT };
