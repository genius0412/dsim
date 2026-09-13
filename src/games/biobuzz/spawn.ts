import type {
  Alliance,
  Artifact,
  GameMode,
  GameSettings,
  GoalState,
  RobotSpec,
  RobotState,
  StartPose,
  Vec2,
  World,
} from '../../types';
import * as C from '../../config';
import { clamp, datan2, dcos, dsin, nextRandom, rot, wrapAngle } from '../../math';
import {
  DEFAULT_ASSISTS,
  MOTIFS,
  coerceAssists,
  coerceAutoPath,
  coerceStartPose,
  type RobotSetup,
} from '../../sim/spawn';
import { emptyScore } from '../../sim/scoring';
import {
  BB_FLOWERS,
  BB_GARDEN,
  BB_HALF_X,
  BB_HALF_Y,
  BB_HIVE_CELL_DY,
  BB_HIVE_OPEN_Z,
  BB_HIVE_X,
  BB_NECTAR_R,
  BB_POLLEN_R,
  BB_START_POSES,
  bbLoadingZoneSpot,
  bbMirror,
} from './config';
import { capturePollen } from './elements';
import { flowerStackZ } from './flower';
import { bbCoerceSpec } from './robotConfig';
import { bbFootprint } from './robot';
import { bbSnapStart } from './start';
import { emptyBiobuzzState, type BiobuzzState } from './state';
import { BB_HOOD_DEFAULT_DEG } from './config';
import { bbIsTurreted, bbLauncherOf } from './mechs';

/**
 * BIOBUZZ world spawn — a PLAYABLE, UNSCORED match.
 *
 * Robots start at their alliance's two anchors; the field is STAGED to Fig 10-2 by
 * `stageBiobuzz`. BIOBUZZ state rides `world.biobuzz`, and the shared
 * `goals`/`scores`/`motif`/`match` are kept INERT-BUT-PRESENT because `worldHash`, the
 * snapshot diff and the HUD all read them and a missing field is a crash rather than a zero.
 *
 * DETERMINISM. The staging layout is FIXED — every element's place comes from the manual's
 * figures and the constants, not from a draw — so the world is identical for every seed, and
 * the mulberry32 chain off `seed` is advanced once and stored back on `world.rngState` for
 * the match to continue. Nothing here reads a clock, the DOM or `Math.random`: same seed,
 * same world, on the client and on the server, which is what makes a replay and a
 * multiplayer match agree.
 */

interface Pose {
  pos: Vec2;
  heading: number;
}

/**
 * SANITIZE ONE SETUP — the BIOBUZZ replacement for the shared `coerceSetup`.
 *
 * The shared one CANNOT be used here, and it is worth being precise about why rather than
 * quietly writing a second copy: `coerceSetup` clamps `startIndex` to DECODE's
 * `C.START_POSES.length` (5) and repairs a custom pose with `snapStartToLegal`, which is
 * DECODE's G304 geometry — launch lines, goal faces, alliance halves. BIOBUZZ has two anchors
 * and no published legality at all (`startLegality: false`), so running it would clamp against
 * the wrong count and snap poses against zones this game does not have.
 *
 * What it DOES do is exactly what matters, and none of it is DECODE-specific:
 *   • ALLIANCE — an enum, defaulted rather than trusted.
 *   • STARTINDEX — finite, integral, in range for THIS game's anchor count.
 *   • STARTPOSE  — structurally validated and field-clamped (`coerceStartPose`).
 *   • AUTOPATH   — structurally validated and field-clamped, with `autoPathEnabled` forced
 *                  false when there is no usable path (an enabled-but-absent path is what
 *                  drives `pathTraversal` into a null target).
 *   • ASSISTS    — every flag validated independently.
 *
 * CHAIN REACTION SKIPS ALL OF THIS. `createChainWorld` calls `coerceSpec` and `coerceAssists`
 * but never `coerceSetup`, so a CR setup arriving off the wire with `startIndex: 1e9` or a
 * malformed auto path is spawned as-is. That is a KNOWN GAP in CR and it is deliberately NOT
 * copied here — this is the last line of defence before a robot exists, and it runs on every
 * spawn path (localStorage, the wire, a staged match, smoke).
 */
function coerceBiobuzzSetup(s: RobotSetup): RobotSetup {
  const alliance: Alliance = s.alliance === 'red' || s.alliance === 'blue' ? s.alliance : 'blue';
  const autoPath = s.autoPath !== undefined ? coerceAutoPath(s.autoPath) : null;
  const spec = bbCoerceSpec(s.spec);
  return {
    id: s.id, // PRESERVED — it keys the per-tick command map for the whole match
    alliance,
    spec,
    assists: coerceAssists(s.assists, DEFAULT_ASSISTS),
    startIndex: Number.isFinite(s.startIndex)
      ? clamp(Math.round(s.startIndex), 0, BB_START_POSES.length - 1)
      : 0,
    startPose: coerceStartPose(s.startPose) ?? undefined,
    autoPath: autoPath ?? undefined,
    autoPathEnabled: autoPath ? s.autoPathEnabled === true : false,
    passive: s.passive,
  };
}

/**
 * THE FOOTPRINT FITS INSIDE THE FIELD — the containment invariant a start pose has to satisfy,
 * enforced on the FINAL pose (after the alliance mirror) by sliding the chassis in.
 *
 * A custom pose used to be validated on its CENTRE ALONE: `coerceStartPose` (`src/sim/
 * spawn.ts`) clamps `x`/`y` to ±`FIELD_HALF` and nothing else, so a pose at the corner spawned
 * a robot with half its frame — and all of its sweeper — through the wall. BIOBUZZ has no
 * published start legality (`startLegality: false`), so there is no G304 analogue to snap to
 * the way `coerceSetup` does for DECODE; what there IS, and what does not need a manual, is
 * that a robot must begin the match inside the field. Rapier will not fix it either: the
 * perimeter invariant in `solveRobots` clamps GROWTH past the wall and deliberately leaves a
 * body that was ALREADY outside alone, so an out-of-bounds spawn simply stays out of bounds.
 *
 * The FOOTPRINT, not the chassis box, for the same reason `footprintExtents` is what the
 * solver collides on: the sweeper is a physical part of the robot and `bbFootprint` grows the
 * box by its reach on whichever edge(s) it is mounted. And the ROTATED footprint, measured as
 * the axis-aligned box the turned rectangle actually occupies — a robot at 45° reaches further
 * toward a wall than its half-length.
 *
 * It SLIDES rather than rejects: a translation is the smallest repair that keeps the driver's
 * chosen heading and their intent (a pose against the wall stays against the wall), and the
 * AABB translates exactly with the centre, so the fix is a single subtraction with no search.
 * A footprint too large for the field at all cannot be made to fit, so it is centred on that
 * axis — unreachable today (the size envelope is an 18in cube on a 144in field) and it must
 * not silently produce an inverted clamp.
 *
 * Applied to the ANCHORS too, deliberately: they are hand-placed `APPROX` numbers, and this is
 * a no-op for them (`npm run test:bb` asserts every anchor's footprint is already inside) but
 * it means there is no spawn path left that can place a robot through a wall. Deterministic
 * and idempotent — `f(f(x)) === f(x)`, so it cannot walk a pose across repeated coercion.
 */
function bbFitPose(spec: RobotSpec, pose: Pose): Pose {
  const e = bbFootprint(spec);
  const c = dcos(pose.heading);
  const s = dsin(pose.heading);
  // the footprint's own centre — offset from the robot's origin whenever the sweeper makes it
  // asymmetric fore-and-aft (a front-only mount), and it rotates with the chassis
  const half = (e.front + e.rear) / 2;
  const off = (e.front - e.rear) / 2;
  const cx = pose.pos.x + off * c;
  const cy = pose.pos.y + off * s;
  // the axis-aligned half-extents of the rotated rectangle
  const ax = Math.abs(half * c) + Math.abs(e.half * s);
  const ay = Math.abs(half * s) + Math.abs(e.half * c);
  const limX = Math.max(0, BB_HALF_X - ax);
  const limY = Math.max(0, BB_HALF_Y - ay);
  return {
    pos: { x: pose.pos.x + (clamp(cx, -limX, limX) - cx), y: pose.pos.y + (clamp(cy, -limY, limY) - cy) },
    heading: pose.heading,
  };
}

/**
 * A robot's start pose. The named `BB_START_POSES` anchors are CANONICAL for BLUE; RED is the
 * POINT MIRROR of them, and the mirror is applied HERE and nowhere else so no other file has
 * to know which alliance is which side.
 *
 * THE MIRROR IS `bbMirror` — a 180° ROTATION about the origin (`x → −x`, `y → −y`,
 * `heading → heading + π`), not the x-reflection this used to do. BIOBUZZ's layout is
 * point-symmetric (§9.3): red's LOADING ZONE is on the far half of the left wall and blue's
 * is the diagonal opposite, so reflecting in x alone puts a red robot beside BLUE's zone at
 * blue's y — the right side of the field, the wrong end of it. Every other mirrored thing on
 * this field (zones, gardens, garden lines) goes through the same helper, which is the point:
 * one definition of "the other alliance's version of this".
 *
 * A CUSTOM pose wins over the anchor index (the same contract DECODE uses) and is stored in
 * the canonical blue frame, so it is mirrored on the same path.
 *
 * ONLY THE ANCHORS ARE SNAPPED TO G304 (`bbSnapStart`, `./start`). An anchor is a NAMED SEAT
 * — "against the rear wall, facing the FIELD" — and the exact inch it lands on depends on the
 * chassis, so re-seating it per build is what the name means rather than a repair of a wrong
 * number. A CUSTOM pose is the opposite: a deliberate placement by a scene author, a driver or
 * a replay, and a spawner that dragged it to the nearest legal wall would make "put the robot
 * under the HIVE" or "put the robot 18 in off a FRAME leg" impossible to express. DECODE does
 * not do it either (`coerceStartPose` clamps to the field and nothing more), and BIOBUZZ
 * publishes `startLegality: false`, so nothing here claims to enforce G304 on a pose someone
 * asked for by name — `bbEvalStart` is available to anything that wants to ASK.
 *
 * Both paths are still fitted inside the perimeter (`bbFitPose`) — containment is not a rule
 * from the manual, it is what makes the pose representable at all.
 */
function bbStartPose(spec: RobotSpec, alliance: Alliance, index: number, custom?: StartPose | null): Pose {
  const base: Pose = custom
    ? { pos: { x: custom.x, y: custom.y }, heading: (custom.headingDeg * Math.PI) / 180 }
    : (() => {
        const n = BB_START_POSES.length;
        const p = BB_START_POSES[((index % n) + n) % n];
        return { pos: { ...p.pos }, heading: p.heading };
      })();
  const m = alliance === 'blue' ? { ...base.pos, heading: base.heading } : bbMirror({ ...base.pos, heading: base.heading });
  const actual: Pose = { pos: { x: m.x, y: m.y }, heading: wrapAngle(m.heading ?? base.heading) };
  if (custom) return bbFitPose(spec, actual);
  // `bbSnapStart` speaks `StartPose` (degrees), which is what every other start surface in the
  // repo speaks — the editor, `coerceStartPose`, DECODE's `evalStartPose`. The radians are this
  // spawner's own internal `Pose`, so the conversion belongs HERE and not in the rule file.
  const snapped = bbSnapStart(
    spec,
    { x: actual.pos.x, y: actual.pos.y, headingDeg: (actual.heading * 180) / Math.PI },
    alliance,
  );
  return bbFitPose(spec, {
    pos: { x: snapped.x, y: snapped.y },
    heading: wrapAngle((snapped.headingDeg * Math.PI) / 180),
  });
}

/** the shared goal state, present and INERT. BIOBUZZ has no goal — Section 9 lands at
 * Kickoff — but `worldHash`, the snapshot diff and the score HUD all read `world.goals`, so
 * the field is populated with zeroes rather than omitted. */
function inertGoal(alliance: Alliance): GoalState {
  return {
    alliance,
    gateOpen: false,
    gatePos: 0,
    gateVel: 0,
    gateHoldTime: 0,
    gateLatch: 0,
    classifiedCount: 0,
    overflowCount: 0,
  };
}

function makeBiobuzzRobot(setup: RobotSetup, nth: number): RobotState {
  const spec: RobotSpec = setup.spec;
  const assists = setup.assists;
  // honour the chosen start (the selector's `startIndex`); default a 2-robot alliance to its
  // two anchors, so the pair never stacks
  const pose = bbStartPose(spec, setup.alliance, setup.startIndex ?? nth, setup.startPose);
  // A TURRET starts ALREADY POINTED. It slews at a finite rate (`BB_TURRET_SLEW`), so a
  // turreted robot that spawned on the chassis heading would spend the first second of auto
  // swinging round. There is no target to point AT yet, so it points at the field CENTRE —
  // the one direction that is equally wrong for every target Section 9 might add, and the one
  // a human would pick. Turretless launchers keep the chassis heading, which IS their aim.
  //
  // A DOUBLE turret has TWO individual turrets, so its NECTAR turret (`bbTurret2Heading` /
  // `bbTurret2Pitch`) is seeded the same way. Those two fields are written ONLY for that build,
  // so no other robot carries them on the wire.
  const launcher = bbLauncherOf(spec, BB_HOOD_DEFAULT_DEG);
  const turreted = bbIsTurreted(launcher);
  const turretHeading = turreted ? datan2(0 - pose.pos.y, 0 - pose.pos.x) : pose.heading;
  const twin = launcher.kind === 'twinturret' ? { bbTurret2Heading: turretHeading, bbTurret2Pitch: 0 } : {};
  return {
    id: setup.id,
    alliance: setup.alliance,
    spec,
    pos: { ...pose.pos },
    heading: pose.heading,
    vel: { x: 0, y: 0 },
    angVel: 0,
    turretHeading,
    ...twin,
    // `catalystRail` is DELIBERATELY ABSENT. It is Chain Reaction's rail-carriage position
    // and BIOBUZZ has no catalyst; it used to be written as an INERT-BUT-PRESENT 0 only
    // because the shared `RobotState` required it. It is optional now, absent reads as 0
    // everywhere, and a BIOBUZZ robot no longer carries a field describing hardware it does
    // not have.
    moduleAngles: [0, 0, 0, 0],
    moduleTargets: [0, 0, 0, 0],
    // BUTTERFLY starts on its MECANUM set — a robot that begins holonomic can always drop
    // traction, and the reverse costs a driver a surprise on tick one.
    butterflyTank: false,
    driveModeHeld: false,
    // required by the SHARED type (Chain Reaction's alternating barrels); BIOBUZZ never reads
    // it — a double turret here is two turrets, not two barrels.
    twinBarrel: false,
    hopper: [],
    fieldCentric: assists.fieldCentric,
    aimAssist: assists.aimAssist,
    autoIntake: assists.autoIntake,
    autoFire: assists.autoFire,
    passive: setup.passive,
    lastFireAt: -10,
    lastIntakeAt: -10,
    fireReadyAt: 0,
    flywheelSpin: 0,
    flywheelSpinRate: 0,
    powerDraw: 0,
    autoPathActive: false,
    currentPathSegmentIndex: 0,
    pathSegmentProgress: 0,
    pathWaitTimer: 0,
    pathSequenceIndex: 0,
    pathTargetPoint: null,
    pathTargetHeading: null,
    isAligningHeading: false,
    targetAlignmentHeading: null,
  };
}

/**
 * THE STAGED FIELD (§10.3.1, Fig 10-2 p83; §10.3.4 p85) — all 56 scoring elements.
 *
 * 40 POLLEN: 4 stacked in each of the four FLOWERS (16), 4 in each GARDEN (8), 4 pre-loaded
 * per ROBOT (16). 16 NECTAR: 3 in each alliance's upward-facing CELL (6), 5 per alliance in
 * the human player's hands (10). Nothing is drawn from the RNG — every position is a figure
 * or a constant, so the staged field is the same for every seed.
 *
 * ONE ARRAY, FIVE STATES. Every element lives in `world.balls` for its whole life and moves
 * between `ground`, `held`, `flight`, `element` (parked inside a FLOWER stack or a HIVE CELL)
 * and `stock` (in a human player's hands, off-field). That is the invariant the rest of the
 * game is built on: `world.balls.length` is constant at 56 from staging to the buzzer, so
 * "did an element leak" is one comparison rather than a sum over a ball array, two hoppers,
 * four flower stacks and a pair of cells.
 *
 * WHICH MEANS THERE IS NO SEPARATE STACK ARRAY. A FLOWER's contents are exactly the balls
 * whose `state.el` is `flower:<i>`, ordered by `slot`; a CELL's are the ones with
 * `hive:<alliance>`. Deriving the stack from the balls rather than mirroring it into
 * `BiobuzzState` means the two can never disagree — the failure mode where a pollen is in a
 * flower's id list and also rolling around on the tiles simply has nowhere to live.
 *
 * POINT SYMMETRY, NOT REFLECTION. Blue's half of the layout is `bbMirror` of red's — a 180°
 * rotation about the origin (§9.3) — so it is written once per alliance and mirrored, never
 * typed twice. An x-reflection would put red's GARDEN on the wrong wall.
 */

/** POLLEN are yellow and NECTAR carries its alliance colour (§9.8). */
const POLLEN_COLOR = 'yellow' as const;

/** how many POLLEN each ROBOT starts holding (§10.3.4, and G407 caps CONTROL at 4). */
const PRELOAD_PER_ROBOT = 4;

/** ROBOTS per alliance the staging budgets POLLEN for. The preload count has to be a
 * CONSTANT of the field rather than a function of who turned up: 40 POLLEN are on the field
 * whether or not both robots showed, and a no-show's four go to its LOADING ZONE. */
const ROBOTS_PER_ALLIANCE = 2;

/** POLLEN per FLOWER and NECTAR per CELL at staging (Fig 10-2). */
const POLLEN_PER_FLOWER = 4;
const NECTAR_PER_CELL = 3;

/** NECTAR per alliance in the human player's hands at setup (§10.3.1). */
const NECTAR_STOCK = 5;

/** one POLLEN diameter — the spacing of every staged line of POLLEN. */
const POLLEN_D = BB_POLLEN_R * 2;

/** make one element. Radius is carried PER BALL (`Artifact.r`) because BIOBUZZ has two sizes
 * on the floor and the renderer has to tell them apart; the shared solve still runs one
 * radius per call (owner item — see `docs/biobuzz/HANDOFF-field.md`). */
function element(
  id: number,
  color: Artifact['color'],
  r: number,
  pos: Vec2,
  state: Artifact['state'],
  z = 0,
): Artifact {
  return { id, color, r, state, pos: { ...pos }, vel: { x: 0, y: 0 }, z, vz: 0 };
}

/**
 * The four POLLEN stacked in FLOWER `i`, bottom (`slot` 0) to top.
 *
 * SEATED FROM THE BOTTOM, THROUGH `flowerStackZ` — the same function the scorer and the
 * renderer read the column from, so a staged stack cannot disagree with a played one about
 * where its elements are. It used to be placed DOWNWARD from the top ring one diameter at a
 * time, because `BB_FLOWER_TOP_Z` was the only column height this file had a constant for; the
 * APPROX note there asked for exactly this re-seat once the lower geometry landed, and the
 * middle-ring sorter ruling (field-plan §2.2) is that geometry.
 *
 * The four staged POLLEN pass the middle ring, so they rest on the LOWER ring (0.43) and the
 * bottom one is BELOW the scoring volume: a staged FLOWER reads 3 elements in volume and 0
 * points, which is the outcome the seat rule exists to produce.
 */
function flowerStack(startId: number): Artifact[] {
  const out: Artifact[] = [];
  let id = startId;
  // every staged element is a POLLEN, so the kind lookup is a constant here
  const zs = flowerStackZ(
    Array.from({ length: POLLEN_PER_FLOWER }, (_, k) => k),
    () => 'pollen',
  );
  BB_FLOWERS.forEach((f, i) => {
    for (let slot = 0; slot < POLLEN_PER_FLOWER; slot++) {
      out.push(
        element(
          id++,
          POLLEN_COLOR,
          BB_POLLEN_R,
          { x: f.x, y: f.y },
          { kind: 'element', el: `flower:${i}`, slot },
          zs[slot],
        ),
      );
    }
  });
  return out;
}

/**
 * The four GARDEN POLLEN for one alliance: "in a line starting in the corner closest to the
 * ALLIANCE AREA and contacting the audience or rear perimeter wall" (§10.3.1).
 *
 * Red's GARDEN runs along the AUDIENCE wall from the red (−x) corner, so the line starts at
 * the corner end of the strip and steps inward by one POLLEN diameter. Both coordinates are
 * pulled one POLLEN RADIUS off the walls they touch: "contacting the wall" in the manual is a
 * body touching it, which for a circle solved at its centre means a centre one radius clear.
 * A centre placed ON the tape line would start the match one radius inside a wall collider,
 * and the solve's first job would be to eject it.
 */
function gardenLine(startId: number, a: Alliance): Artifact[] {
  const out: Artifact[] = [];
  let id = startId;
  const g = BB_GARDEN.red;
  for (let k = 0; k < 4; k++) {
    // RED is the canonical half: the strip runs along the AUDIENCE wall from the red corner,
    // so the line starts at the corner end of `BB_GARDEN.red` and steps inward by a diameter.
    // BLUE is the point mirror of it, which lands on the rear wall running back toward the
    // blue corner — the same rule, never a second set of numbers.
    const base = { x: g.x0 + BB_POLLEN_R + k * POLLEN_D, y: g.y0 + BB_POLLEN_R };
    const p = a === 'red' ? base : bbMirror(base);
    out.push(element(id++, POLLEN_COLOR, BB_POLLEN_R, { x: p.x, y: p.y }, { kind: 'ground' }));
  }
  return out;
}


/**
 * PRELOADS — four POLLEN per ROBOT, through the real capture path.
 *
 * `capturePollen` is called rather than a `held` state being written here, so a preload is
 * subject to exactly the rule a mid-match intake is: it refuses once the hopper is full. That
 * matters because the hopper cap is a Lane B DIAL, and G407 caps CONTROL at 4 — a robot built
 * with a smaller hopper cannot legally hold four, and the manual's answer (§10.3.4, G304.G)
 * is that a preload may be "in or ON" the robot. So the overflow goes on the TILES TOUCHING
 * the robot, in front of the mouth, which is both legal and what a team actually does.
 *
 * A MISSING ROBOT still costs its alliance four POLLEN: they go to the centre of its LOADING
 * ZONE against the wall, in a line (§10.3.4). The field has 40 POLLEN in a 1v1 and in a 2v2,
 * which is what keeps conservation a constant rather than a function of the lineup.
 *
 * `capturePollen` reads `world.balls` only through the ball handed to it, but it is the REAL
 * entry point and may grow a lookup, so each preload is pushed onto `world.balls` before it
 * is captured and the array is handed back to the caller intact.
 */
function preloads(world: World, startId: number): Artifact[] {
  const out: Artifact[] = [];
  let id = startId;
  for (const a of ['red', 'blue'] as const) {
    const mine = world.robots.filter((r) => r.alliance === a).sort((p, q) => p.id - q.id);
    for (let n = 0; n < ROBOTS_PER_ALLIANCE; n++) {
      const r = mine[n];
      if (!r) {
        // no-show: its four go to the LOADING ZONE centre, spaced along the zone's long axis
        const spot = bbLoadingZoneSpot(a);
        for (let k = 0; k < PRELOAD_PER_ROBOT; k++) {
          const y = spot.y + (k - (PRELOAD_PER_ROBOT - 1) / 2) * POLLEN_D;
          out.push(element(id++, POLLEN_COLOR, BB_POLLEN_R, { x: spot.x, y }, { kind: 'ground' }));
        }
        continue;
      }
      const e = bbFootprint(r.spec);
      for (let k = 0; k < PRELOAD_PER_ROBOT; k++) {
        // born on the tiles at the robot's own centre, then captured — the same two steps a
        // POLLEN driven over goes through, so nothing here can produce a hopper the intake
        // could not have produced itself
        const ball = element(
          id++,
          POLLEN_COLOR,
          BB_POLLEN_R,
          { x: r.pos.x, y: r.pos.y },
          { kind: 'ground' },
        );
        out.push(ball);
        world.balls.push(ball);
        if (capturePollen(world, r, ball)) continue;
        // hopper full: park it on the tiles against the front face, spread across the mouth
        const lx = e.front + BB_POLLEN_R;
        const ly = (k - (PRELOAD_PER_ROBOT - 1) / 2) * POLLEN_D;
        const w = rot({ x: lx, y: ly }, r.heading);
        ball.pos = { x: r.pos.x + w.x, y: r.pos.y + w.y };
      }
    }
  }
  return out;
}

/**
 * NECTAR IN THE CELLS — three of each alliance's colour in that alliance's UPWARD-FACING
 * CELL (§10.3.1): each HIVE is tilted so the CELL pointing at a FLOWER is DOWN, putting red's
 * south cell and blue's north up.
 *
 * WHICH CELL IS UP COMES FROM THE STATE, `hives[a].up`, not from `BB_HIVE_UP_STAGED`. The
 * constant is the STAGED pose and `emptyBiobuzzState` already builds the hives in it, so at
 * t = 0 the two agree — but the state is what a TIP moves, and the constant is not. Staging a
 * world whose hives had been tipped (a scene, a restored snapshot) against the constant would
 * put the three NECTAR in the cell facing the floor.
 *
 * The CELL centre is `BB_HIVE_CELL_DY` from the pivot along y, on whichever side is up, and
 * the pivots sit at x = −/+`BB_HIVE_X` (Fig 9-10, centre to centre 25.5). The three are laid
 * across the cell one NECTAR diameter apart; z is the mid-height of the opening. Neither is a
 * measured seat — an `element` ball is neither solved nor drawn as a loose ball — but the
 * count and the ORDER are read, by `hives[a].contents`.
 */
function cellNectar(startId: number, hives: BiobuzzState['hives']): Artifact[] {
  const out: Artifact[] = [];
  let id = startId;
  const z = (BB_HIVE_OPEN_Z[0] + BB_HIVE_OPEN_Z[1]) / 2;
  for (const a of ['red', 'blue'] as const) {
    const x0 = a === 'red' ? -BB_HIVE_X : BB_HIVE_X;
    const y = hives[a].up === 'south' ? -BB_HIVE_CELL_DY : BB_HIVE_CELL_DY;
    for (let slot = 0; slot < NECTAR_PER_CELL; slot++) {
      const x = x0 + (slot - (NECTAR_PER_CELL - 1) / 2) * BB_NECTAR_R * 2;
      out.push(element(id++, a, BB_NECTAR_R, { x, y }, { kind: 'element', el: `hive:${a}`, slot }, z));
    }
  }
  return out;
}

/**
 * THE HUMAN PLAYERS' NECTAR — five per alliance, `state: 'stock'`, OFF-FIELD (§10.3.1).
 *
 * `stock` is a real ball state rather than a counter on `BiobuzzState` for the same reason
 * everything else is a ball: it keeps the count in ONE array. A nectar entered by a human
 * player during the match is then a state change on an existing ball, not a spawn — so the
 * conservation check cannot be satisfied by a leak in one bucket and a creation in another.
 *
 * `pos` is the LOADING ZONE spot it will enter at. Nothing reads it while the ball is
 * `stock` (an off-field ball is not solved and not drawn), but a position that is already
 * where the element appears means entry is a state flip with no teleport.
 */
function stockNectar(startId: number): Artifact[] {
  const out: Artifact[] = [];
  let id = startId;
  for (const a of ['red', 'blue'] as const) {
    // at the NECTAR radius, not the POLLEN one: this is where `play.ts` puts the element down
    // when the human player enters it, and "no teleport" is only true if the two agree.
    const spot = bbLoadingZoneSpot(a, BB_NECTAR_R);
    for (let k = 0; k < NECTAR_STOCK; k++) {
      out.push(element(id++, a, BB_NECTAR_R, spot, { kind: 'stock', alliance: a }));
    }
  }
  return out;
}

/**
 * THE STATE BAG IS A VIEW OF `world.balls`, and this is the one place that builds it.
 *
 * `flowers[i].stack` and `hives[a].contents` hold BALL IDS and `nectarStock[a]` is a COUNT, so
 * every one of them is a second way of saying something `world.balls` already says. They exist
 * because the renderer and the scorer ask questions the array answers slowly: `drawField.ts`
 * wants a FLOWER's depth and a CELL's count every frame, and both scoring rules for a FLOWER
 * are about the ORDER of its stack (§10.5.2 — the owner is the top-most NECTAR, the bonus is
 * the bottom-most), which a set of positions cannot express.
 *
 * DERIVED, NOT WRITTEN ALONGSIDE. The alternative — each builder appending its own ids as it
 * goes — is one edit away from a stack that lists a ball the array does not have, and the
 * failure is silent: a FLOWER that draws 4 deep and conserves 3. Reading the ids back off the
 * finished array makes disagreement unrepresentable at staging, and `field.ts` asserts the
 * same equality afterwards so a RUNTIME writer cannot drift either.
 *
 * BOTTOM TO TOP, by `slot` rather than by array order. The builders happen to emit ascending
 * slots, but "bottom-most" is a scoring rule and it should not rest on the order a loop
 * happened to push in.
 *
 * Stage the whole field onto `world`. Called once by `createBiobuzzWorld`, after the robots
 * exist (the preloads need them) and before anything steps.
 *
 * ORDER IS PART OF THE CONTRACT: flowers, gardens, preloads, cell nectar, stock nectar. Ball
 * ids are handed out in that sequence, so the id of any given staged element is stable across
 * builds and a hash captured today still means something tomorrow.
 */
export function stageBiobuzz(world: World): void {
  const bb = world.biobuzz;
  let id = bb ? bb.nextBallId : 1;
  const take = (batch: Artifact[]): Artifact[] => {
    id += batch.length;
    return batch;
  };

  world.balls = [];
  const staged: Artifact[] = [];
  staged.push(...take(flowerStack(id)));
  staged.push(...take(gardenLine(id, 'red')));
  staged.push(...take(gardenLine(id, 'blue')));
  staged.push(...take(preloads(world, id)));
  staged.push(...take(cellNectar(id, bb ? bb.hives : emptyBiobuzzState().hives)));
  staged.push(...take(stockNectar(id)));

  world.balls = staged;
  // continue the id sequence past the staged set, so a runtime spawn can never alias one
  if (bb) bb.nextBallId = id;
  if (bb) bbIndexElements(world);
}

/**
 * Read `flowers[i].stack`, `hives[a].contents` and `nectarStock[a]` back off `world.balls`.
 *
 * EXPORTED because `world.balls` has a second writer: `bbWorld` in `scenes.ts` replaces the
 * whole array with a scene's own POLLEN layout after staging has run, and a state bag left
 * over from the staged set then describes elements the world no longer has — which is exactly
 * what a gallery cell captioned `0 pollen` under four FLOWERS badged `4` is showing. `bbWorld`
 * now calls this straight after its replace, and so should anything else that assigns
 * `world.balls` wholesale. `scripts/smoke-biobuzz/field.ts` asserts the invariant the call
 * buys: every id in a FLOWER stack or an up-CELL resolves to a ball in the array.
 *
 * Every field is REBUILT rather than appended to: staging is not incremental, and a world
 * staged twice (a scene rebuilding, a smoke fixture) would otherwise carry both passes' ids.
 *
 * An `el` tag naming a FLOWER or HIVE that does not exist is DROPPED rather than thrown on.
 * The tags are `string`s on `BallState`, so an out-of-range index is a type-legal value this
 * function can be handed; taking it would push an id into a stack nothing renders, and
 * throwing would take a whole world down over one mislabelled ball.
 */
export function bbIndexElements(world: World): void {
  const bb = world.biobuzz;
  if (!bb) return;
  indexInto(bb, world.balls);
}

function indexInto(bb: BiobuzzState, staged: readonly Artifact[]): void {
  for (const f of bb.flowers) f.stack = [];
  for (const a of ['red', 'blue'] as const) {
    bb.hives[a].contents = [];
    bb.nectarStock[a] = 0;
  }

  // slot is carried alongside the id so the sort below is by the STACK's own order
  const byFlower: { id: number; slot: number }[][] = [[], [], [], []];
  const byHive: Record<Alliance, { id: number; slot: number }[]> = { red: [], blue: [] };

  for (const b of staged) {
    if (b.state.kind === 'stock') {
      bb.nectarStock[b.state.alliance] += 1;
      continue;
    }
    if (b.state.kind !== 'element') continue;
    const { el, slot } = b.state;
    if (el.startsWith('flower:')) {
      const i = Number(el.slice(7));
      if (Number.isInteger(i) && i >= 0 && i < byFlower.length) byFlower[i].push({ id: b.id, slot });
    } else if (el === 'hive:red' || el === 'hive:blue') {
      byHive[el === 'hive:red' ? 'red' : 'blue'].push({ id: b.id, slot });
    }
  }

  const ids = (xs: { id: number; slot: number }[]): number[] =>
    xs.sort((p, q) => p.slot - q.slot || p.id - q.id).map((x) => x.id);
  byFlower.forEach((xs, i) => {
    bb.flowers[i].stack = ids(xs);
  });
  for (const a of ['red', 'blue'] as const) bb.hives[a].contents = ids(byHive[a]);
}

export function createBiobuzzWorld(
  mode: GameMode,
  seed: number,
  setups: RobotSetup[],
  gameSettings?: GameSettings,
): World {
  // The staged layout takes no draws (every position is a figure or a constant), but the
  // chain is still advanced once and stored on the world so the MATCH continues a seeded
  // stream — a spill, a human-player jitter or anything else added later inherits it.
  const rng = nextRandom(seed || 1);

  // SORTED BY ID before spawning. The setups arrive from a Map or a wire array whose order is
  // not guaranteed, and the spawn order decides the order of RNG draws — so an unsorted list
  // is a hash divergence between two peers with the same seed.
  const robots: RobotState[] = [];
  const allianceCount: Record<Alliance, number> = { red: 0, blue: 0 };
  for (const s of [...setups].sort((p, q) => p.id - q.id)) {
    const safe = coerceBiobuzzSetup(s);
    robots.push(makeBiobuzzRobot(safe, allianceCount[safe.alliance]++));
  }

  const biobuzz = emptyBiobuzzState();

  const world: World = {
    game: 'biobuzz',
    biobuzz,
    mode,
    time: 0,
    tick: 0,
    rngState: rng.state,
    motif: MOTIFS[0], // inert: BIOBUZZ has no motif, but the HUD and the hash read the field
    robots,
    balls: [],
    goals: { red: inertGoal('red'), blue: inertGoal('blue') },
    humanPlayers: {
      red: { box: [], nextPlaceAt: 0 },
      blue: { box: [], nextPlaceAt: 0 },
    },
    match: {
      phase: mode === 'match' ? 'pre' : 'freeplay',
      phaseTimeLeft: mode === 'match' ? C.AUTO_DURATION : 0,
      scores: { red: emptyScore(), blue: emptyScore() },
      provisionalPattern: { red: 0, blue: 0 },
      fouls: { red: { minor: 0, major: 0 }, blue: { minor: 0, major: 0 } },
    },
    events: [],
    rrContacts: [],
    penalties: {
      episodes: {},
      pins: {},
      pinFouls: {},
      possession: {},
      possessionBilled: {},
      possessionRebill: {},
      controlHeld: {},
      ballHold: {},
      ballAnchor: {},
      controlInstances: {},
      carded: {},
      gateCulprit: { red: null, blue: null },
      rampBallIds: { red: [], blue: [] },
    },
    gameSettings,
  };

  // STAGED LAST, and onto the finished world: the preloads run through `capturePollen`, which
  // takes a `World` — so the field cannot be laid out until there is one to lay it out on.
  stageBiobuzz(world);
  return world;
}
