import type { Artifact, RobotCommand, RobotSpec, RobotState, Vec2, World } from '../../src/types';
import { readFileSync } from 'node:fs';
import * as C from '../../src/config';
import { datan2, hyp, wrapAngle } from '../../src/math';
import { worldHash } from '../../src/net/checksum';
import { coerceSettings, defaultSettings, switchGame } from '../../src/settings';
import { coerceSpec, DEFAULT_ASSISTS, DEFAULT_SPEC } from '../../src/sim/spawn';
import {
  BB_HIVE_CELL_LEN,
  BB_MASS_BASE,
  BB_MASS_BOX_TUBE,
  BB_MASS_DUMPER,
  BB_MASS_SWEEPER_EDGE,
  BB_MASS_TURRET,
  BB_MASS_TURRET2,
  BB_PRESETS,
  BB_SIZE_STEP,
  bbMassLimits,
  bbSizeLimits,
  BB_AIM_TOL,
  BB_DEG,
  BB_DUMP_RELOAD_S,
  BB_FIRE_INTERVAL,
  BB_FLOWER_D,
  BB_FLOWER_FOOT,
  BB_FLOWER_RETRIEVE_S,
  BB_FLOWER_RETRIEVE_Z,
  BB_FLOWER_TOP_Z,
  BB_FLOWERS,
  BB_HIVE_OPEN_Z,
  BB_HOOD_DEFAULT_DEG,
  BB_DUMP_APEX_ABOVE,
  BB_DUMP_MAX_DIST,
  BB_DUMP_MIN_DIST,
  BB_LAUNCH_SPEED_MAX,
  BB_LAUNCH_Z0,
  BB_HALF_X,
  BB_HALF_Y,
  BB_INTAKE_CENTRE_FRAC,
  BB_INTAKE_CROSS_MAX,
  BB_INTAKE_DRAW_IN,
  BB_INTAKE_GRIP_ACCEL,
  BB_INTAKE_PERIOD_MAX,
  bbIntakeReach,
  BB_PLACE_REACH,
  BB_POLLEN_R,
  BB_PRISM,
  BB_PRISM_NARROW,
  BB_PTS,
  BB_RAMP_DEPLOY_S,
  BB_RAMP_OUT,
  BB_RAMP_REACH,
  BB_RAMP_TIP_Z,
  BB_SIDE_ROLLER_R,
  BB_SIDE_ROLLER_REACH,
  BB_SIDE_ROLLER_GRIP,
  BB_SIDE_ROLLER_PROTRUDE,
  bbArchetypeWallExtra,
  bbSideRollerY,
  bbFlowerReachOf,
  FLOWER_MOUTH,
  BB_START_POSE_COUNT,
  BB_TURRET_ACCEL,
  BB_TURRET_PITCH_ACCEL,
  BB_TURRET_PITCH_MAX,
  BB_TURRET_PITCH_MIN,
  BB_TURRET_PITCH_REST,
  BB_TURRET_PITCH_SLEW,
  BB_TURRET_SLEW,
  BB_TURRET_SOLVE_PASSES,
  bbStorageMax,
  BB_DECK_Z,
  BB_FEED_SLIDE,
  BB_FEED_WALL_T,
  BB_FLYWHEEL_CLEAR,
  BB_FLYWHEEL_D_MM,
  BB_FLYWHEEL_R,
  bbHead,
  BB_HOOD_COMPRESSION,
  BB_HOOD_T,
  BB_HOOD_WRAP,
  BB_NECTAR_R,
  BB_SIDE_PLATE_BOTTOM_Z,
  BB_SIDE_PLATE_FRONT_X,
  BB_SIDE_PLATE_TOP_Z,
  BB_TURRET_AXLE_Z,
  BB_TURRET_BRACE_R,
  BB_TURRET_BRACES,
  BB_TURRET_MOTOR_R,
  BB_TURRET_PLATE_TOP_Z,
} from '../../src/games/biobuzz/config';
import { biobuzzColliders } from '../../src/games/biobuzz/colliders';
import { bbEvalStart, bbStartBox } from '../../src/games/biobuzz/start';
import { capturePollen, hiveCellTarget, pollenIn, releasePollen, scoreTargets, takeHeld } from '../../src/games/biobuzz/elements';
import type { ScoreTarget } from '../../src/games/biobuzz/state';
import {
  BB_INTAKE_MOUNTS,
  BB_MOUNT_POSITIONS,
  BB_SCORE_MODES,
  BB_SHOOTER_EDGES,
  MOUNT_DIR,
  isTurreted,
  mountsClash,
} from '../../src/games/biobuzz/mounts';
import {
  type BbShot,
  bbAimHeading,
  bbAimPitch,
  bbDumpSolution,
  bbFlowerInReach,
  bbFootprint,
  bbLaunch,
  bbLobThrow,
  bbHopperCap,
  bbMouths,
  bbMuzzleLocal,
  bbMuzzleZ,
  bbPlacePoint,
  bbPlacePointLocal,
  bbRampSettled,
  bbRampStep,
  bbRampSwingProgress,
  bbRobotSolids,
  bbSlewTurret,
  bbSolveShot,
  bbTurretOrigin,
  bbTurretRelease,
  bbTurretSolution,
  mouthAxes,
} from '../../src/games/biobuzz/robot';
import { bbConfigSummary } from '../../src/games/biobuzz/labels';
import { bbAimTarget, bbFlightEnters, bbKindOf, bbPassPoint } from '../../src/games/biobuzz/play';
import {
  BB_PASS_PRESETS,
  BB_PASS_PRESET_DEFAULT,
  BB_PASS_PRESET_HINT,
  BB_PASS_PRESET_LABEL,
  bbPassPresetPoint,
} from '../../src/games/biobuzz/passTargets';
import { hiveCellPos } from '../../src/games/biobuzz/hive';
import { hiveCellTarget } from '../../src/games/biobuzz/elements';
import {
  BB_INTAKE_KINDS,
  bbCarriesNectar,
  bbCellsAdjacent,
  bbIntakeAccepts,
  bbIntakeKindOf,
  bbIsTurreted,
  bbLauncherBlocker,
  bbLauncherOf,
  bbLiftOf,
  type BbIntakeKind,
} from '../../src/games/biobuzz/mechs';
import { flowerFits, flowerScore } from '../../src/games/biobuzz/flower';
import { biobuzzHud } from '../../src/games/biobuzz/hudRobot';
import { bbIndexElements, createBiobuzzWorld } from '../../src/games/biobuzz/spawn';
import { biobuzzStep } from '../../src/games/biobuzz/step';
import {
  BB_PRESET_LIST,
  BB_REAL_PRESETS,
  BB_STARTER_BOTS,
  bbSpecMatches,
} from '../../src/games/biobuzz/presets';
import { robotPenetration, robotSolids } from '../../src/sim/artifactSolids';
import { simModuleFor } from '../../src/games/sim';
import { BB_DEFAULT_SPEC, bbDials } from '../../src/games/biobuzz/robotConfig';
import { BB_SCENES, bbPollen, bbSceneAt } from '../../src/games/biobuzz/scenes';
import { bbSpecKey } from '../../src/games/biobuzz/specKey';
import { cadFlowerRings, fieldColliders3d } from '../../src/games/biobuzz/sim3d/fieldColliders';
import { bbCoerce, cmd, mkWorld, mkWorld3d, run, setup, type Check } from './harness';

/**
 * LANE B's smoke: THE ROBOT.
 *
 * Coercion, the build space, the loadout, and everything a BIOBUZZ robot can do to an element.
 * Everything whose subject is a MECHANISM or a SPEC rather than the field.
 *
 * Like the field lane, every check here is one that survives Kickoff. Nothing asserts a
 * capacity, a range or a rate as a NUMBER — those are all `APPROX` in `config.ts`, and an
 * assertion against a guess is a check that passes until the day the guess is replaced and
 * then fails for a reason nobody can act on. What is asserted instead are the INVARIANTS the
 * numbers have to satisfy whatever they become: the coercer is idempotent, the drawn mouths
 * are the capture areas, the hopper cap is honoured, no mechanism ever creates or destroys an
 * element, and the hopper and the held set are one multiset.
 *
 * ⚠️ MECHANISM BEHAVIOUR IS DRIVEN THROUGH THE WORLD (`run` / `biobuzzStep`), not by calling the
 * mechanism's function. Twice a mechanism was green on direct-call tests while no match could
 * reach it (the turret slew, the removed lift). Setup may call `capturePollen` to stage a
 * hopper; the behaviour under test never skips the tick.
 */

/** the whole BIOBUZZ build space: every archetype × every launcher mount that archetype can
 * have × every intake mount. Small enough to check exhaustively, large enough that a coercion
 * bug hides in exactly one of them. */
function everyBuild(): RobotSpec[] {
  const out: RobotSpec[] = [];
  for (const scoreMode of BB_SCORE_MODES) {
    const mounts = isTurreted(scoreMode) ? BB_MOUNT_POSITIONS : BB_SHOOTER_EDGES;
    for (const shooterMount of mounts) {
      for (const intakeMount of BB_INTAKE_MOUNTS) {
        out.push(bbCoerce({ ...BB_DEFAULT_SPEC, scoreMode, shooterMount, intakeMount }));
      }
    }
  }
  return out;
}

/**
 * The fields of a spec, as a stable string.
 *
 * `JSON.stringify` of the spec is NOT usable for this: key order differs between an object
 * built by a spread and one built by mutation, so two identical specs stringify differently
 * and an idempotence check on it reports a bug that is not there.
 */
function specKey(s: RobotSpec): string {
  const r = s as unknown as Record<string, unknown>;
  return Object.keys(r)
    .sort()
    .map((k) => `${k}=${JSON.stringify(r[k])}`)
    .join('|');
}

/** the CR-only mechanism fields BIOBUZZ must not carry. Named once, used twice. */
const CR_FIELDS = [
  'catalystType',
  'catalystMount',
  'catalystSwing',
  'catapultRange',
  'catapultYaw',
  'groundClearance',
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// fixtures
// ─────────────────────────────────────────────────────────────────────────────

type Colour = Artifact['color'];

/** a spec with an explicit loadout, over the harness default */
function mech(m: unknown, extra: Partial<RobotSpec> = {}): Partial<RobotSpec> {
  return { ...extra, bbMech: m as RobotSpec['bbMech'] };
}

/** the next free element id in `w`, kept in step with the state bag's own counter */
function nextId(w: World): number {
  return w.balls.reduce((m, b) => Math.max(m, b.id), 0) + 1;
}

/** park a robot: pose set, motion zeroed */
function park(r: RobotState, x: number, y: number, heading: number): void {
  r.pos = { x, y };
  r.heading = heading;
  r.vel = { x: 0, y: 0 };
  r.angVel = 0;
}

/**
 * EMPTY a robot's hopper WITHOUT deleting anything: every element it holds (its four preloads)
 * goes back on the tiles in a far corner. Clearing `world.balls` instead would leave the staged
 * HIVE and FLOWER stacks pointing at ids that no longer exist.
 */
function emptyHopper(w: World, r: RobotState): void {
  let k = 0;
  for (const b of w.balls) {
    if (b.state.kind !== 'held' || b.state.robot !== r.id) continue;
    b.state = { kind: 'ground' };
    b.pos = { x: -64 + k * 3.2, y: -40 };
    b.vel = { x: 0, y: 0 };
    k++;
  }
  r.hopper.length = 0;
}

/** STAGE elements in a hopper through the real capture path (setup, not behaviour). */
function give(w: World, r: RobotState, colours: readonly Colour[]): Artifact[] {
  const out: Artifact[] = [];
  let id = nextId(w);
  for (const c of colours) {
    const b: Artifact = { ...bbPollen(id++, r.pos.x, r.pos.y), color: c };
    w.balls.push(b);
    if (capturePollen(w, r, b)) out.push(b);
  }
  if (w.biobuzz) w.biobuzz.nextBallId = id;
  return out;
}

/** one tick of the real pipeline with `c` held on robot 0 */
function tick(w: World, c: RobotCommand): void {
  biobuzzStep(w, C.SIM_DT, new Map([[0, c]]));
}

const hopperColours = (r: RobotState): string => [...r.hopper].sort().join(',');
const heldColours = (w: World, r: RobotState): string =>
  w.balls
    .filter((b) => b.state.kind === 'held' && b.state.robot === r.id)
    .map((b) => b.color)
    .sort()
    .join(',');

const kindOfIn = (w: World) => (id: number) => {
  const b = w.balls.find((x) => x.id === id);
  return b ? bbKindOf(b) : 'pollen';
};

const TWIN = { kind: 'twinturret', mount: 'front', mount2: 'back', hoodDeg: BB_HOOD_DEFAULT_DEG };

export function robotChecks(check: Check): void {
  // ── COERCION: IDEMPOTENT ──────────────────────────────────────────────────
  /**
   * `coerceSpec(raw, base, 'biobuzz')` must be a PROJECTION. Running it twice has to equal
   * running it once: a spec is coerced on load, again when the builder edits it, again at
   * `createWorld`, and again on the server when it arrives over the wire. If it is not
   * idempotent a robot changes shape by being TRANSMITTED.
   *
   * The inputs are deliberately hostile. `localStorage` is hand-editable and specs have
   * arrived off the wire with NaN dimensions from devtools — and old saves carry loadouts the
   * owner has since ruled out (no launcher, a drum, a lift height).
   */
  const hostile: [string, unknown][] = [
    ['undefined', undefined],
    ['null', null],
    ['a string', 'not a spec'],
    ['an empty object', {}],
    ['NaN dimensions', { ...BB_DEFAULT_SPEC, length: NaN, width: NaN, massLb: NaN, ballStorage: NaN }],
    ['Infinity dimensions', { ...BB_DEFAULT_SPEC, length: Infinity, width: -Infinity, massLb: Infinity }],
    ['negative everything', { ...BB_DEFAULT_SPEC, length: -18, width: -18, massLb: -50, ballStorage: -9 }],
    ['absurdly large', { ...BB_DEFAULT_SPEC, length: 1e6, width: 1e6, massLb: 1e6, ballStorage: 1e6 }],
    ['string numbers', { ...BB_DEFAULT_SPEC, length: '18', width: '18', ballStorage: '5' }],
    ['a fractional hopper', { ...BB_DEFAULT_SPEC, ballStorage: 3.7 }],
    ['unknown archetype', { ...BB_DEFAULT_SPEC, scoreMode: 'trebuchet' }],
    ['unknown mounts', { ...BB_DEFAULT_SPEC, intakeMount: 'roof', shooterMount: 'orbit' }],
    ['a turretless corner mount', { ...BB_DEFAULT_SPEC, scoreMode: 'dumper', shooterMount: 'frontleft' }],
    ['a legacy flat drum', { ...BB_DEFAULT_SPEC, scoreMode: 'drum', shooterMount: 'left' }],
    ['a legacy drum container', { ...BB_DEFAULT_SPEC, ...mech({ launcher: { kind: 'drum', mount: 'back', hoodDeg: 72 }, lift: null }) }],
    ['an old launcher-less save', { ...BB_DEFAULT_SPEC, ...mech({ launcher: null, lift: null }) }],
    ['a double turret on centre', { ...BB_DEFAULT_SPEC, ...mech({ launcher: { ...TWIN, mount: 'center' }, lift: null }) }],
    ['a double turret with a neighbouring mount2', { ...BB_DEFAULT_SPEC, ...mech({ launcher: { ...TWIN, mount2: 'frontleft' }, lift: null }) }],
    ['a Box Tube on centre', { ...BB_DEFAULT_SPEC, ...mech({ launcher: { kind: 'turret', mount: 'back', hoodDeg: 75 }, lift: { kind: 'vslide', mount: 'center' } }) }],
    ['a stale lift height', { ...BB_DEFAULT_SPEC, ...mech({ launcher: { kind: 'turret', mount: 'center', hoodDeg: 75 }, lift: { kind: 'vslide', mount: 'left', maxZ: 999 } }) }],
    [
      'a Chain Reaction build',
      { ...DEFAULT_SPEC, catalystType: 'hook', catalystMount: 'front', catalystSwing: 30, groundClearance: 2 },
    ],
    ['a DECODE build', { ...DEFAULT_SPEC }],
  ];
  for (const [name, raw] of hostile) {
    const once = bbCoerce(raw);
    const twice = bbCoerce(once);
    check(`coerce: idempotent on ${name}`, specKey(once) === specKey(twice));
  }
  for (const spec of everyBuild()) {
    check(
      `coerce: ${spec.scoreMode}/${spec.shooterMount}/${spec.intakeMount} is a fixed point`,
      specKey(spec) === specKey(bbCoerce(spec)),
    );
  }

  // ── COERCION: EVERY DIAL LANDS INSIDE THE RANGE THE BUILDER OFFERS ────────
  const within = (v: number, r: { min: number; max: number }): boolean => v >= r.min - 1e-9 && v <= r.max + 1e-9;
  for (const [name, raw] of hostile) {
    const s = bbCoerce(raw);
    const d = bbDials(s);
    check(
      `coerce: ${name} lands inside every dial range`,
      Number.isFinite(s.length) &&
        Number.isFinite(s.width) &&
        Number.isFinite(s.massLb) &&
        within(s.length, d.length) &&
        within(s.width, d.width) &&
        within(s.massLb, d.mass) &&
        Number.isInteger(s.ballStorage) &&
        within(s.ballStorage ?? -1, d.storage) &&
        within(s.bbMech?.launcher.hoodDeg ?? -1, d.hood),
      `L=${s.length} W=${s.width} m=${s.massLb} hop=${s.ballStorage} hood=${s.bbMech?.launcher.hoodDeg}`,
    );
  }

  // ── THE PRESET CARDS ──────────────────────────────────────────────────────
  /**
   * A PRESET MUST BE A COERCER NO-OP: the builder marks a card selected by asking
   * `bbSpecMatches(spec, card)` about a coerced spec, so a card carrying any value the coercer
   * would move can never read as selected.
   */
  for (const p of BB_PRESET_LIST) {
    const coerced = bbCoerce(p);
    check(`preset [${p.name}]: survives the coercer unchanged`, specKey(p) === specKey(coerced));
    check(
      `preset [${p.name}]: still reads as SELECTED after coercion`,
      bbSpecMatches(coerced, p),
      bbConfigSummary(coerced),
    );
    check(
      `preset [${p.name}]: every dial sits inside the range the builder offers`,
      within(p.length, bbDials(p).length) &&
        within(p.width, bbDials(p).width) &&
        within(p.massLb, bbDials(p).mass) &&
        within(p.ballStorage ?? -1, bbDials(p).storage),
      `L=${p.length} W=${p.width} m=${p.massLb} hop=${p.ballStorage}`,
    );
    check(`preset [${p.name}]: carries a launcher`, !!p.bbMech?.launcher, JSON.stringify(p.bbMech));
  }
  {
    const names = BB_PRESET_LIST.map((p) => p.name);
    check('presets: every card name is unique', new Set(names).size === names.length, names.join(', '));
  }
  for (const p of BB_STARTER_BOTS) {
    check(
      `starterbot [${p.name}]: hopper honours the 4-element cap`,
      (p.ballStorage ?? 0) <= 4 && (p.ballStorage ?? 0) >= 1,
      `hopper=${p.ballStorage}`,
    );
  }
  // THE HOPPER IS CAPPED AT 4 ELEMENTS, POLLEN + NECTAR TOGETHER (owner ruling 2026-09-12, final;
  // it overrides Lane B relay 2 / field-plan §4.3). The volume law still runs underneath, so
  // these check the CAP at the builds where the volume law is largest, and through the world.
  {
    let worst = { n: 0, what: '' };
    let builds = 0;
    for (const s of everyBuild()) {
      const d = bbDials(s);
      for (const length of [d.length.min, d.length.max]) {
        for (const width of [d.width.min, d.width.max]) {
          const sized = bbCoerce({ ...s, length, width });
          builds++;
          const n = bbStorageMax(sized);
          if (n > worst.n) worst = { n, what: `${sized.scoreMode}/${sized.shooterMount}/${sized.intakeMount} ${sized.length}x${sized.width}` };
        }
      }
    }
    check('storage: every archetype × mount × size extreme has bbStorageMax <= 4', worst.n <= 4 && builds > 0, `max=${worst.n} at ${worst.what} over ${builds} builds`);

    const dumperMech: Partial<RobotSpec> = {
      intakeMount: 'front',
      scoreMode: 'dumper',
      shooterMount: 'back',
      bbMech: { launcher: { kind: 'dumper', mount: 'back', hoodDeg: BB_HOOD_DEFAULT_DEG }, lift: null },
    };
    const dumperDials = bbDials(bbCoerce({ ...BB_DEFAULT_SPEC, ...dumperMech }));
    const openDumper: Partial<RobotSpec> = { ...dumperMech, length: dumperDials.length.max, width: dumperDials.width.max };
    const big = bbCoerce({ ...BB_DEFAULT_SPEC, ...openDumper });
    const volume = Math.round((big.length * big.width) / 12);
    check(
      'storage: an open front-sweeper dumper at its largest size has a hopper dial max of exactly 4',
      bbDials(big).storage.max === 4 && bbHopperCap(bbCoerce({ ...big, ballStorage: 99 })) === 4,
      `dial max=${bbDials(big).storage.max} cap@99=${bbHopperCap(bbCoerce({ ...big, ballStorage: 99 }))} volume law~${volume} ${big.length}x${big.width}`,
    );

    // THROUGH THE WORLD: drive the same dumper, dial asked for 99, down a line of 7 loose POLLEN
    // with the intake held. On y = −36, clear of the HIVE frame (see the capture-line scene).
    const world = mkWorld('free', 29, { ...openDumper, ballStorage: 99 });
    const r = world.robots[0];
    r.pos = { x: -50, y: -36 };
    r.heading = 0;
    r.vel = { x: 0, y: 0 };
    r.autoIntake = false;
    r.autoFire = false;
    r.hopper.length = 0;
    world.balls.length = 0;
    const LINE = 7;
    for (let i = 0; i < LINE; i++) world.balls.push(bbPollen(i + 1, -30 + i * 6, -36));
    run(world, cmd({ driveY: 0.6, intake: true }), 4);
    const held = world.balls.filter((b) => b.state.kind === 'held').length;
    const ground = world.balls.filter((b) => b.state.kind === 'ground').length;
    check('storage: driving over 7 loose POLLEN with the intake on, the robot ends holding exactly 4', r.hopper.length === 4 && held === 4, `hopper=${r.hopper.length} held=${held}`);
    check('storage: ...and the other 3 stay on the floor', ground === LINE - 4 && world.balls.length === LINE, `ground=${ground} total=${world.balls.length}`);
    check('storage: ...and the robot really drove the whole line (not vacuous)', r.pos.x > -30 + (LINE - 1) * 6, `x=${r.pos.x.toFixed(1)}`);

    const w = mkWorld('free', 5);
    check('storage: a default build still spawns FULL with the staged 4', w.robots[0].hopper.length === 4 && bbHopperCap(w.robots[0].spec) === 4, `hopper=${w.robots[0].hopper.length} cap=${bbHopperCap(w.robots[0].spec)}`);
  }
  {
    check(
      'presets: realCount matches the StarterBot count',
      BB_REAL_PRESETS === BB_STARTER_BOTS.length,
      `${BB_REAL_PRESETS} vs ${BB_STARTER_BOTS.length}`,
    );
    check(
      'presets: the real robots are the leading entries',
      BB_PRESET_LIST.slice(0, BB_REAL_PRESETS).every((p, i) => p.name === BB_STARTER_BOTS[i].name),
      BB_PRESET_LIST.slice(0, BB_REAL_PRESETS).map((p) => p.name).join(', '),
    );
  }

  // ── THE MASS MODEL (`bbMassLimits`) ───────────────────────────────────────
  /**
   * BIOBUZZ OWNS ITS MASS FLOOR, AND EVERY PART OF THE BUILD PAYS FOR ITSELF.
   *
   * What this replaced (owner, 2026-09-22): DECODE's per-drivetrain floor plus a bump that
   * priced exactly two things, a second turret and a Box Tube. A sweeper weighed nothing, a
   * turret weighed nothing, a dumper weighed nothing and a second sweeper edge weighed nothing,
   * so a bare mecanum chassis and one carrying a turret and two sweepers both floored at 18 lb.
   * Every check below is a thing that was silently untrue then.
   */
  {
    const mech = (kind: string, mount: string, tube: boolean): Partial<RobotSpec> =>
      ({
        bbMech: {
          launcher: { kind, mount, hoodDeg: BB_HOOD_DEFAULT_DEG },
          lift: tube ? { kind: 'vslide', mount: 'back' } : null,
        },
      }) as unknown as Partial<RobotSpec>;
    /** a build, THROUGH the coercer, so what is measured is what would spawn. */
    const build = (o: Partial<RobotSpec>): RobotSpec =>
      bbCoerce({ ...BB_DEFAULT_SPEC, ...o });
    const floor = (o: Partial<RobotSpec>): number => bbMassLimits(build(o)).min;
    const ONE_TURRET = { intakeMount: 'front', ...mech('turret', 'center', false) } as Partial<RobotSpec>;

    // THE CALIBRATION POINT, stated by the owner in pounds: "single intake single turret should
    // weigh like 18lbs minimum". EXACTLY 18.00 rather than "about 18" — it is the one number the
    // five drivetrain bases were solved against, so an inexact assertion would let the whole
    // table drift a pound at a time.
    check(
      'mass: mecanum + ONE sweeper + ONE turret floors at exactly 18.00 lb',
      floor({ drivetrain: 'mecanum', ...ONE_TURRET }) === 18,
      `${floor({ drivetrain: 'mecanum', ...ONE_TURRET })}`,
    );
    // ...and the drivetrains are ORDERED, which is the only part of the table that is a claim
    // about the world rather than a chosen number: more wheels and more modules weigh more.
    const dtFloor = (dt: RobotSpec['drivetrain']): number => floor({ drivetrain: dt, ...ONE_TURRET });
    check(
      'mass: the drivetrain floors are ordered mecanum = xdrive < tank < swerve < butterfly',
      dtFloor('mecanum') === dtFloor('xdrive') &&
        dtFloor('mecanum') < dtFloor('tank') &&
        dtFloor('tank') < dtFloor('swerve') &&
        dtFloor('swerve') < dtFloor('butterfly'),
      `mec ${dtFloor('mecanum')} x ${dtFloor('xdrive')} tank ${dtFloor('tank')} swerve ${dtFloor('swerve')} bfly ${dtFloor('butterfly')}`,
    );
    // ...and every BASE is under the shared one it replaced. The shared floors price in DECODE's
    // own shooter; this model builds the shooter separately, so a base that was not lighter would
    // be double-charging for it.
    {
      const over = (Object.keys(BB_MASS_BASE) as (keyof typeof BB_MASS_BASE)[]).filter(
        (dt) => BB_MASS_BASE[dt] >= C.DRIVETRAIN_LIMITS[dt].minMass,
      );
      check('mass: every BARE chassis base is lighter than the shared floor it replaced', over.length === 0, over.join(', '));
    }

    // EVERY COMPONENT COSTS ITS OWN CONSTANT, and none of them is zero. Each row is a pair of
    // builds differing by exactly one part, so the delta can only be that part.
    const deltas: [string, number, number][] = [
      [
        'a SECOND sweeper edge',
        floor({ drivetrain: 'mecanum', ...mech('turret', 'center', false), intakeMount: 'frontback' }) -
          floor({ drivetrain: 'mecanum', ...ONE_TURRET }),
        BB_MASS_SWEEPER_EDGE,
      ],
      [
        'a TURRET over a DUMPER',
        floor({ drivetrain: 'mecanum', ...ONE_TURRET }) -
          floor({ drivetrain: 'mecanum', intakeMount: 'front', ...mech('dumper', 'back', false) }),
        BB_MASS_TURRET - BB_MASS_DUMPER,
      ],
      [
        'the SECOND turret of a double',
        floor({ drivetrain: 'mecanum', intakeMount: 'front', ...mech('twinturret', 'right', false) }) -
          floor({ drivetrain: 'mecanum', ...ONE_TURRET }),
        BB_MASS_TURRET2,
      ],
      [
        'a BOX TUBE',
        floor({ drivetrain: 'mecanum', intakeMount: 'front', ...mech('turret', 'center', true) }) -
          floor({ drivetrain: 'mecanum', ...ONE_TURRET }),
        BB_MASS_BOX_TUBE,
      ],
    ];
    for (const [what, got, want] of deltas) {
      check(`mass: ${what} costs ${want} lb and nothing else moves`, Math.abs(got - want) < 1e-9 && want > 0, `${got}`);
    }
    // BIOBUZZ HAS NO INERTIA (owner, 2026-09-24). A new BIOBUZZ spec is seeded from DECODE's
    // `DEFAULT_SPEC` (0.4), which used to price into the floor: mecanum + turret at 18.6.
    {
      const seeded = bbCoerce({ ...DEFAULT_SPEC, drivetrain: 'mecanum', ...ONE_TURRET });
      check('mass: a DECODE-seeded spec coerces to no inertia and floors at 18.00', seeded.flywheelInertia === 0 && bbMassLimits(seeded).min === 18, `inertia ${seeded.flywheelInertia}, floor ${bbMassLimits(seeded).min}`);
    }

    // THE HEAVY END LANDS SOMEWHERE PLAUSIBLE. Not a chosen number — a sanity band on the sum,
    // so a constant that grows by a factor rather than a pound is caught.
    {
      const heavy = floor({
        drivetrain: 'swerve',
        intakeMount: 'frontback',
        ...mech('twinturret', 'right', true),
      });
      check('mass: swerve + two sweepers + a double turret + a tube lands in 27..30 lb', heavy >= 27 && heavy <= 30, `${heavy}`);
    }

    // ROUNDED TO 0.01, the same reason `massLimits` documents: the floor is a sum of decimal
    // constants and it becomes the robot's ACTUAL clamped mass, which the builder then prints.
    {
      let worst = '';
      for (const s2 of everyBuild()) {
        const m = bbMassLimits(s2).min;
        if (Math.abs(m * 100 - Math.round(m * 100)) > 1e-9) worst = `${s2.scoreMode}/${s2.intakeMount}: ${m}`;
      }
      check('mass: every build’s floor is a clean 0.01 lb (no 15-digit slider bound)', worst === '', worst);
    }

    // THE BUILDER AND THE COERCER READ ONE MODEL. A slider bound from anywhere else is a slider
    // that offers a value the chokepoint immediately rewrites.
    {
      let bad = '';
      for (const s2 of everyBuild()) {
        const d = bbDials(s2).mass;
        const m = bbMassLimits(s2);
        if (d.min !== m.min || d.max !== m.max) bad = `${s2.scoreMode}/${s2.intakeMount}`;
      }
      check('mass: `bbDials` offers exactly `bbMassLimits`', bad === '', bad);
    }

    // ⚠️ AND THE CHOKEPOINT ENFORCES *THIS* FLOOR, NOT DECODE'S. `coerceSpec`'s own mass pass
    // runs before the BIOBUZZ arm and its floor is HIGHER for every drivetrain, so without the
    // raw carry-across in `src/sim/spawn.ts` a legal light build is lifted before this model is
    // ever consulted: a tank turret build would come back at 22 lb (DECODE's tank floor) rather
    // than at its own 19.50. NON-VACUOUS by construction — the check names both numbers.
    {
      const light = bbCoerce({
        ...BB_DEFAULT_SPEC,
        drivetrain: 'tank',
        massLb: 1,
        ...ONE_TURRET,
      });
      const own = bbMassLimits(light).min;
      check(
        'mass: a light build is clamped to the BIOBUZZ floor, not to the shared one',
        light.massLb === own && own < C.DRIVETRAIN_LIMITS.tank.minMass,
        `got ${light.massLb}, biobuzz floor ${own}, shared floor ${C.DRIVETRAIN_LIMITS.tank.minMass}`,
      );
    }

    // THE CEILING IS THE SHARED DRIVETRAIN ENVELOPE. R104 sets NO robot weight limit in BIOBUZZ
    // (`docs/biobuzz-reference.md` §6), so there is no rules number to clamp to: what is left is
    // the sim's own statement of what that drivetrain can still move.
    {
      let bad = '';
      for (const s2 of everyBuild()) {
        if (bbMassLimits(s2).max !== C.DRIVETRAIN_LIMITS[s2.drivetrain].maxMass) bad = s2.drivetrain;
      }
      check('mass: the ceiling is the shared per-drivetrain envelope (R104 sets none)', bad === '', bad);
    }

    // THE PRESET CARDS. Each declares a mass ABOVE its own floor -- a card sitting on the floor
    // says nothing about the tradeoff between the cards -- except the StarterBot, which is on it
    // on purpose (no kit publishes a weight). And each is a position the 1-lb mass SLIDER can
    // return to, or a player who nudges the dial can never get the card back.
    {
      const onGrid: string[] = [];
      const atFloor: string[] = [];
      for (const p of BB_PRESET_LIST) {
        const f = bbMassLimits(p).min;
        if (Math.abs((p.massLb - f) - Math.round(p.massLb - f)) > 1e-9) onGrid.push(`${p.name} ${p.massLb} vs floor ${f}`);
        if (p.massLb <= f) atFloor.push(p.name);
      }
      check('mass: every preset mass sits on the slider’s own 1-lb grid from its floor', onGrid.length === 0, onGrid.join(' · '));
      check(
        'mass: only the StarterBot sits ON its floor; every demo declares a heavier real weight',
        atFloor.length === BB_REAL_PRESETS && atFloor.every((n) => BB_STARTER_BOTS.some((b) => b.name === n)),
        atFloor.join(', '),
      );
    }
  }

  // ── MECHANISM COMPOSITION: THE LAUNCHER IS MANDATORY ──────────────────────
  /**
   * Owner ruling 2026-09-12: a launcher is mandatory. An old save that stored `launcher: null`
   * must come back WITH one — migrated from the flat mirror the shared coercer always writes —
   * and that answer must itself be a fixed point, or the robot changes on every coercion.
   */
  {
    const raw = { ...BB_DEFAULT_SPEC, scoreMode: 'dumper', shooterMount: 'back', ...mech({ launcher: null, lift: null }) };
    const once = bbCoerce(raw);
    const l = once.bbMech?.launcher;
    check(
      'mech: a stored launcher:null coerces to a real launcher, from the flat mirror',
      !!l && l.kind === 'dumper' && l.mount === 'back',
      JSON.stringify(l),
    );
    check('mech: ...and that is a coercion fixed point', specKey(once) === specKey(bbCoerce(once)));
    check(
      'mech: bbLauncherOf never returns null, even on the raw un-coerced spec',
      bbLauncherOf(raw as unknown as RobotSpec, BB_HOOD_DEFAULT_DEG) !== null,
    );
  }
  check(
    'mech: every build carries its launcher in the container, mirrored onto the flat fields',
    everyBuild().every((s) => {
      const l = s.bbMech?.launcher;
      return !!l && s.scoreMode === l.kind && s.shooterMount === l.mount && s.shooterRear === (l.mount === 'back');
    }),
  );
  /** DRUM IS GONE, and a legacy drum becomes a DUMPER on the same edge with the same hood —
   * not a turret, which is what the enum check alone would have made of it. */
  {
    const flat = bbCoerce({ ...BB_DEFAULT_SPEC, bbMech: undefined, scoreMode: 'drum', shooterMount: 'left' });
    const box = bbCoerce({ ...BB_DEFAULT_SPEC, ...mech({ launcher: { kind: 'drum', mount: 'back', hoodDeg: 72 }, lift: null }) });
    check(
      'mech: a legacy flat drum migrates to a dumper on the same edge',
      flat.bbMech?.launcher.kind === 'dumper' && flat.bbMech.launcher.mount === 'left' && flat.scoreMode === 'dumper',
      JSON.stringify(flat.bbMech?.launcher),
    );
    check(
      'mech: a legacy drum container migrates to a dumper keeping its edge AND hood',
      box.bbMech?.launcher.kind === 'dumper' && box.bbMech.launcher.mount === 'back' && box.bbMech.launcher.hoodDeg === 72,
      JSON.stringify(box.bbMech?.launcher),
    );
    check(
      'mech: ...both migrations are coercion fixed points',
      specKey(flat) === specKey(bbCoerce(flat)) && specKey(box) === specKey(bbCoerce(box)),
    );
    check('mech: drum is not in the launcher vocabulary', !(BB_SCORE_MODES as readonly string[]).includes('drum'));
  }
  /** MIGRATION: every archetype a flat spec names becomes that launcher. */
  for (const mode of BB_SCORE_MODES) {
    const legacy = bbCoerce({ ...BB_DEFAULT_SPEC, bbMech: undefined, scoreMode: mode });
    const l = bbLauncherOf(legacy, BB_HOOD_DEFAULT_DEG);
    check(`mech: a legacy ${mode} spec migrates to that launcher`, l.kind === mode, `got ${l.kind}`);
  }
  /** THE CONTAINER IS AUTHORITATIVE, and the flat field mirrors it. */
  {
    const patched = bbCoerce({
      ...BB_DEFAULT_SPEC,
      scoreMode: 'turret',
      ...mech({ launcher: { kind: 'dumper', mount: 'back', hoodDeg: BB_HOOD_DEFAULT_DEG }, lift: null }),
    });
    check('mech: the container wins over the flat scoreMode', bbLauncherOf(patched, BB_HOOD_DEFAULT_DEG).kind === 'dumper');
    check('mech: ...and the flat field is MIRRORED from it, for older peers', patched.scoreMode === 'dumper', `scoreMode=${patched.scoreMode}`);
  }

  // ── THE DOUBLE TURRET'S TWO CELLS ─────────────────────────────────────────
  /**
   * A double turret is two INDIVIDUAL turrets. Their rings overlap in neighbouring 3x3 cells on
   * every legal chassis, so the NECTAR turret's cell is never the POLLEN turret's, never a
   * neighbour of it, and neither sits on `center` (which neighbours everything). Swept over
   * every (mount, request) pair, because a fold that is right for one cell is a classic way to
   * be wrong for its mirror.
   */
  {
    let bad = 0;
    let notFixed = 0;
    const detail: string[] = [];
    for (const mount of BB_MOUNT_POSITIONS) {
      for (const want of [...BB_MOUNT_POSITIONS, undefined, 'orbit'] as unknown[]) {
        const s = bbCoerce({ ...BB_DEFAULT_SPEC, ...mech({ launcher: { ...TWIN, mount, mount2: want }, lift: null }) });
        const l = s.bbMech!.launcher;
        if (l.mount === 'center' || !l.mount2 || l.mount2 === l.mount || bbCellsAdjacent(l.mount, l.mount2)) {
          bad++;
          if (detail.length < 4) detail.push(`${mount}/${String(want)}→${l.mount}/${l.mount2}`);
        }
        if (specKey(s) !== specKey(bbCoerce(s))) notFixed++;
      }
    }
    check('twin: the NECTAR turret never shares or neighbours the POLLEN turret, and neither is on centre', bad === 0, detail.join(' '));
    check('twin: ...every mount2 resolution is a coercion fixed point', notFixed === 0, `${notFixed} not fixed`);
    const kept = bbCoerce({ ...BB_DEFAULT_SPEC, ...mech({ launcher: { ...TWIN, mount: 'frontleft', mount2: 'backright' }, lift: null }) });
    check('twin: a legal mount2 request is kept', kept.bbMech!.launcher.mount2 === 'backright', `${kept.bbMech!.launcher.mount2}`);
    const partner = bbCoerce({ ...BB_DEFAULT_SPEC, ...mech({ launcher: { kind: 'twinturret', mount: 'left', hoodDeg: 75 }, lift: null }) });
    check('twin: a missing mount2 takes the fixed partner (left→right)', partner.bbMech!.launcher.mount2 === 'right', `${partner.bbMech!.launcher.mount2}`);
    const single = bbCoerce({ ...BB_DEFAULT_SPEC, ...mech({ launcher: { kind: 'turret', mount: 'left', mount2: 'right', hoodDeg: 75 }, lift: null }) });
    check('twin: any other launcher carries NO mount2', !('mount2' in single.bbMech!.launcher), JSON.stringify(single.bbMech!.launcher));
  }

  // ── THE BOX TUBE'S CELL ───────────────────────────────────────────────────
  /**
   * The Box Tube lives on the eight PERIMETER cells (its placement point has to reach past an
   * edge), never on a launcher cell — both turrets of a double, the whole edge of a dumper — and
   * the fold is a fixed point. Swept over every launcher × every requested cell.
   */
  {
    let bad = 0;
    let notFixed = 0;
    let dropped = 0;
    const detail: string[] = [];
    for (const kind of BB_SCORE_MODES) {
      for (const mount of isTurreted(kind) ? BB_MOUNT_POSITIONS : BB_SHOOTER_EDGES) {
        for (const want of BB_MOUNT_POSITIONS) {
          const s = bbCoerce({ ...BB_DEFAULT_SPEC, ...mech({ launcher: { kind, mount, hoodDeg: 75 }, lift: { kind: 'vslide', mount: want } }) });
          const lift = bbLiftOf(s);
          if (!lift) {
            dropped++;
            continue;
          }
          const l = s.bbMech!.launcher;
          if (lift.mount === 'center' || bbLauncherBlocker(l).some((b) => mountsClash({ pos: lift.mount, spansEdge: false }, b))) {
            bad++;
            if (detail.length < 4) detail.push(`${kind}@${l.mount}/${l.mount2 ?? '-'} tube ${want}→${lift.mount}`);
          }
          if (specKey(s) !== specKey(bbCoerce(s))) notFixed++;
        }
      }
    }
    check('box tube: never on centre, never on a launcher cell (both turrets, a dumper\'s edge)', bad === 0, detail.join(' '));
    check('box tube: ...every resolution is a coercion fixed point', notFixed === 0, `${notFixed}`);
    check('box tube: ...and every launcher leaves it a free perimeter cell', dropped === 0, `${dropped} dropped`);
    const stale = bbLiftOf(bbCoerce({ ...BB_DEFAULT_SPEC, ...mech({ launcher: { kind: 'turret', mount: 'center', hoodDeg: 75 }, lift: { kind: 'vslide', mount: 'left', maxZ: 999 } }) }));
    check('box tube: a stored lift height from the removed raise mechanism is dropped', stale?.mount === 'left' && !('maxZ' in (stale ?? {})), JSON.stringify(stale));
    const centre = bbLiftOf(bbCoerce({ ...BB_DEFAULT_SPEC, ...mech({ launcher: { kind: 'turret', mount: 'back', hoodDeg: 75 }, lift: { kind: 'vslide', mount: 'center' } }) }));
    check('box tube: a centre request is relocated to a perimeter cell, not dropped', !!centre && centre.mount !== 'center', `${centre?.mount}`);
  }

  // ── R105.A: THE EXPANSION ENVELOPE, BOX TUBE INCLUDED — AND G304 AT SPAWN ──
  /**
   * R105.A: a ROBOT "must remain within a 18 in. … by 24 in. … by 29 in. … tall sizing volume
   * when fully expanded", oriented only in height, so the footprint must fit 24 × 18 one way or
   * 18 × 24 the other. What sticks out past the frame when deployed is the sweeper(s) AND the
   * Box Tube, whose placement point is `BB_PLACE_REACH` past the footprint — and the tube used
   * to be missing from `bbSizeLimits`, so a maxed chassis with a CORNER tube measured 19.7 × 18.7
   * (over 18 both ways). A FLANK tube on the same chassis is 18 × 19.4, which the rule allows
   * with the 24 across the width, and that is why the envelope considers both orientations.
   *
   * MEASURED FROM THE GEOMETRY, NOT FROM `bbEnvelopeReach`: the extent is the box around the
   * collision footprint (`bbFootprint`) and the placement point (`bbPlacePointLocal`), the two
   * functions the sim itself acts from. Swept over every launcher × launcher cell × tube cell
   * (and none) × intake × intake mount × width floor (swerve's is the only one that differs) at
   * the four CORNERS of the size range the builder offers — corners because both extents are
   * linear in the chassis size.
   *
   * The same builds then SPAWN, and every robot must start G304-legal and clear of every FLOWER
   * foot collider (G304.D). The spawn pose reads only the footprint (`bbSnapStart` + `bbFitPose`),
   * so one world per distinct footprint covers the build space; the presets spawn regardless.
   * The foot test is the AABB of the rotated footprint against the collider rectangle, which is
   * conservative: no AABB overlap means no overlap.
   */
  {
    check("R105.A: the prism is the manual's 18 × 24", BB_PRISM === 24 && BB_PRISM_NARROW === 18, `${BB_PRISM_NARROW} × ${BB_PRISM}`);
    const extent = (s: RobotSpec): { ex: number; ey: number } => {
      const f = bbFootprint(s);
      const p = bbPlacePointLocal(s);
      const x1 = Math.max(f.front, p ? p.x : -Infinity);
      const x0 = Math.min(-f.rear, p ? p.x : Infinity);
      const y1 = Math.max(f.half, p ? p.y : -Infinity);
      const y0 = Math.min(-f.half, p ? p.y : Infinity);
      return { ex: x1 - x0, ey: y1 - y0 };
    };
    const inPrism = (s: RobotSpec): boolean => {
      const { ex, ey } = extent(s);
      const e = 1e-9;
      return (ex <= BB_PRISM + e && ey <= BB_PRISM_NARROW + e) || (ex <= BB_PRISM_NARROW + e && ey <= BB_PRISM + e);
    };

    // THE CHECK CAN FAIL: the pre-fix envelope offered this build (sloped front sweeper, a Box
    // Tube on the front-left corner, the old 15 × 17 maximum), and it is 19.7 × 18.7.
    const oldMax = { ...BB_DEFAULT_SPEC, intake: 'sloped' as const, intakeMount: 'front' as const, length: 15, width: 17, ...mech({ launcher: { kind: 'turret', mount: 'center', hoodDeg: 75 }, lift: { kind: 'vslide', mount: 'frontleft' } }) };
    const oe = extent(oldMax as RobotSpec);
    check('R105.A: a maxed chassis with a corner Box Tube overruns the prism (so the sweep below can fail)', !inPrism(oldMax as RobotSpec), `${oe.ex.toFixed(2)} × ${oe.ey.toFixed(2)}`);
    const fixed = bbCoerce(oldMax);
    const fe = extent(fixed);
    check(
      'R105.A: ...and the coercer shrinks it into the prism',
      inPrism(fixed) && fixed.width < 17 && bbLiftOf(fixed)?.mount === 'frontleft',
      `${fixed.length} × ${fixed.width} → ${fe.ex.toFixed(2)} × ${fe.ey.toFixed(2)}`,
    );
    // AND BOTH ORIENTATIONS ARE HONOURED: a FLANK tube on that same maxed chassis is 18 × 19.4,
    // legal with the 24 across the width, so the fix must not shrink it.
    const flank = bbCoerce({ ...oldMax, ...mech({ launcher: { kind: 'turret', mount: 'center', hoodDeg: 75 }, lift: { kind: 'vslide', mount: 'left' } }) });
    const fl = extent(flank);
    check('R105.A: a flank Box Tube on a maxed chassis keeps its size (18 × 24 either way round)', inPrism(flank) && flank.length === 15 && flank.width === 17, `${flank.length} × ${flank.width} → ${fl.ex.toFixed(2)} × ${fl.ey.toFixed(2)}`);
    // THE CEILING IS R102's 18 AND THE WIDTH RANGE FOLLOWS THE LENGTH (owner, 2026-09-24). A front
    // sweeper with no tube reaches 18 × 18; the same flank-tube build can go 18 long, and then
    // only the length-long rectangle holds it, so its width range narrows to fit.
    {
      const plain = bbCoerce({ ...oldMax, length: 99, width: 99, ...mech({ launcher: { kind: 'turret', mount: 'center', hoodDeg: 75 }, lift: null }) });
      check('size: a front sweeper, no tube, dials to 18 × 18 (R102, not DECODE’s 15 or the old 17)', plain.length === 18 && plain.width === 18 && inPrism(plain), `${plain.length} × ${plain.width}`);
      const long = bbCoerce({ ...flank, length: 18, width: 18 });
      const ll = extent(long);
      check('size: the flank-tube build at 18 long gets the width that rectangle allows, and stays in the prism', long.length === 18 && long.width === 15.5 && inPrism(long), `${long.length} × ${long.width} → ${ll.ex.toFixed(2)} × ${ll.ey.toFixed(2)}`);
      check('size: ...and its dial range agrees with the coercer', bbSizeLimits(long).maxWidth === 15.5 && bbSizeLimits(flank).maxWidth === 18 && bbSizeLimits(flank).maxLength === 18, `${bbSizeLimits(long).maxWidth} / ${bbSizeLimits(flank).maxWidth} / ${bbSizeLimits(flank).maxLength}`);
      check('size: coercion is still idempotent across the dependent range', JSON.stringify(bbCoerce(long)) === JSON.stringify(long));
    }
    // NO 15-DIGIT SIZES (owner report, 2026-09-13): a corner tube's reach is 2.36·√½, and the
    // clamp used to land a chassis on 16.331227996399747. Every size limit sits on the slider grid.
    const onGrid = (v: number): boolean => Math.abs(v / BB_SIZE_STEP - Math.round(v / BB_SIZE_STEP)) < 1e-9;
    check('R105.A: the corner-tube chassis is clamped onto the slider grid', onGrid(fixed.length) && onGrid(fixed.width), `${fixed.length} × ${fixed.width}`);
    {
      let off = 0;
      let first = '';
      for (const intake of ['sloped', 'vector', 'triangle'] as const) {
        for (const intakeMount of BB_INTAKE_MOUNTS) {
          for (const lm of [null, ...BB_MOUNT_POSITIONS.filter((m) => m !== 'center')]) {
            const s = { ...BB_DEFAULT_SPEC, intake, intakeMount, ...mech({ launcher: { kind: 'turret', mount: 'center', hoodDeg: 75 }, lift: lm ? { kind: 'vslide', mount: lm } : null }) } as RobotSpec;
            const l = bbSizeLimits(s);
            for (const v of [l.maxLength, l.maxWidth]) {
              if (!onGrid(v)) {
                off++;
                if (!first) first = `${intake}/${intakeMount}/${lm}: ${v}`;
              }
            }
          }
        }
      }
      check(`R105.A: every build's maximum length and width is a multiple of ${BB_SIZE_STEP} in`, off === 0, first);
    }
    // ── E1: THE LIMIT BEING ON THE GRID WAS ONLY HALF THE FIX, and the owner re-reported it
    //    (2026-09-18). A clamp never touches a value that is already IN range, so a robot saved
    //    with the old 16.331227996399747 kept it: the default build's width ceiling is 17. The
    //    coercer SNAPS now (`bbSnapSize`), which is what heals a stored spec on load.
    {
      const long = 18 - 2.36 * Math.SQRT1_2; // exactly what the old coercer wrote: 16.331227996399747
      const healed = bbCoerce({ ...BB_DEFAULT_SPEC, length: long, width: long });
      check(
        'E1 R105.A: a robot SAVED with the 15-digit width is healed onto the grid on load',
        onGrid(healed.width) && onGrid(healed.length),
        `${healed.length} × ${healed.width}`,
      );
      const again = bbCoerce(healed);
      check(
        'E1 R105.A: snapping is idempotent (a second coercion moves nothing)',
        again.length === healed.length && again.width === healed.width,
        `${again.length} × ${again.width}`,
      );
      // the HEIGHT PAIR has the same shape of hole — clamped to whole inches, never snapped.
      const h = bbCoerce({ ...BB_DEFAULT_SPEC, heightIn: 20.3333333333, stowHeightIn: 17.7777 } as RobotSpec);
      const hs = (h as { stowHeightIn?: number }).stowHeightIn;
      check(
        'E1 R105.A: the height dials snap to their own 1-in step too',
        Number.isInteger(h.heightIn ?? 0) && Number.isInteger(hs ?? 0),
        `${h.heightIn} / ${hs}`,
      );
      // ...and a PRESET must still be a coercer no-op, which is what makes its card highlight.
      let moved = '';
      for (const p of BB_PRESETS) {
        const c = bbCoerce({ ...BB_DEFAULT_SPEC, ...p });
        if (c.length !== (p.length ?? BB_DEFAULT_SPEC.length) || c.width !== (p.width ?? BB_DEFAULT_SPEC.width)) {
          moved = `${p.name ?? '?'}: ${c.length} × ${c.width}`;
          break;
        }
      }
      check('E1 R105.A: snapping leaves every preset a coercer no-op', moved === '', moved);
    }

    const builds: RobotSpec[] = [];
    const lifts = [null, ...BB_MOUNT_POSITIONS.filter((m) => m !== 'center')];
    for (const kind of BB_SCORE_MODES) {
      for (const mount of isTurreted(kind) ? BB_MOUNT_POSITIONS : BB_SHOOTER_EDGES) {
        for (const intake of ['sloped', 'vector', 'triangle'] as const) {
          for (const intakeMount of BB_INTAKE_MOUNTS) {
            for (const drivetrain of ['mecanum', 'swerve'] as const) {
              for (const lm of lifts) {
                const base = bbCoerce({
                  ...BB_DEFAULT_SPEC,
                  intake,
                  intakeMount,
                  drivetrain,
                  ...mech({ launcher: { kind, mount, hoodDeg: 75 }, lift: lm ? { kind: 'vslide', mount: lm } : null }),
                });
                const d = bbDials(base);
                for (const length of [d.length.min, d.length.max]) {
                  for (const width of [d.width.min, d.width.max]) builds.push(bbCoerce({ ...base, length, width }));
                }
              }
            }
          }
        }
      }
    }
    let over = 0;
    let notFixed = 0;
    let tubed = 0;
    const overDetail: string[] = [];
    for (const s of builds) {
      if (bbLiftOf(s)) tubed++;
      if (!inPrism(s)) {
        over++;
        if (overDetail.length < 3) {
          const { ex, ey } = extent(s);
          overDetail.push(`${s.intake}/${s.intakeMount}/tube ${bbLiftOf(s)?.mount ?? '-'} ${s.length}x${s.width} → ${ex.toFixed(2)}x${ey.toFixed(2)}`);
        }
      }
      if (specKey(s) !== specKey(bbCoerce(s))) notFixed++;
    }
    check(`R105.A: every build at every dial corner fits 18 × 24 with its sweepers and Box Tube (${builds.length} builds, ${tubed} with a tube)`, over === 0 && tubed > 0, overDetail.join(' · ') || `${over} over`);
    check('R105.A: ...and every one of them is a coercion fixed point', notFixed === 0, `${notFixed} not fixed`);
    const presetsOver = BB_PRESET_LIST.filter((p) => !inPrism(p)).map((p) => p.name);
    check('R105.A: every preset card fits the prism', presetsOver.length === 0, presetsOver.join(', '));

    // G304 AT SPAWN, over the same build space.
    const feet = biobuzzColliders.statics.slice(-BB_FLOWERS.length);
    check(
      'G304.D sweep: the last statics are the FLOWER feet, in `BB_FLOWERS` order',
      feet.length === BB_FLOWERS.length && feet.every((s, i) => Math.hypot(s.tx - BB_FLOWERS[i].x, s.ty - BB_FLOWERS[i].y) < BB_FLOWER_FOOT.deep),
      JSON.stringify(feet),
    );
    const byFootprint = new Map<string, RobotSpec>();
    for (const s of builds) byFootprint.set(`${s.intake}/${s.intakeMount}/${s.length}/${s.width}`, s);
    const spawnSpecs = [...byFootprint.values(), ...BB_PRESET_LIST];
    let spawned = 0;
    let illegal = 0;
    let onFoot = 0;
    const spawnDetail: string[] = [];
    for (const spec of spawnSpecs) {
      const setups = [];
      let id = 0;
      for (const a of ['blue', 'red'] as const) {
        for (let i = 0; i < BB_START_POSE_COUNT; i++) setups.push(setup(id++, a, spec, i));
      }
      const w = createBiobuzzWorld('match', 7, setups);
      for (const r of w.robots) {
        spawned++;
        const pose = { x: r.pos.x, y: r.pos.y, headingDeg: (r.heading * 180) / Math.PI };
        const v = bbEvalStart(r.spec, pose, r.alliance);
        const b = bbStartBox(r.spec, pose);
        const hit = feet.some((f) => b.x1 > f.tx - f.hx && b.x0 < f.tx + f.hx && b.y1 > f.ty - f.hy && b.y0 < f.ty + f.hy);
        if (!v.legal) illegal++;
        if (hit) onFoot++;
        if ((!v.legal || hit) && spawnDetail.length < 3) {
          spawnDetail.push(`${spec.name} ${spec.intake}/${spec.intakeMount} ${spec.length}x${spec.width} ${r.alliance}#${r.id} at (${pose.x.toFixed(1)},${pose.y.toFixed(1)}): ${v.reason ?? 'on a FLOWER foot'}`);
        }
      }
    }
    check(
      `G304 at spawn: every build × both alliances × every anchor starts legal (${spawned} robots, ${byFootprint.size} footprints + ${BB_PRESET_LIST.length} presets)`,
      illegal === 0 && spawned === spawnSpecs.length * 2 * BB_START_POSE_COUNT,
      spawnDetail.join(' · ') || `${illegal} illegal`,
    );
    check('G304.D at spawn: ...and no spawned footprint overlaps a FLOWER foot collider', onFoot === 0, spawnDetail.join(' · ') || `${onFoot} on a foot`);
  }

  // ── THE PLACEMENT POINT (geometry) ────────────────────────────────────────
  {
    check('place point: the reach is derived so a flush chassis face puts the point on the ring', Math.abs(BB_PLACE_REACH - (BB_FLOWER_FOOT.deep - BB_FLOWER_D)) < 1e-12);
    const none = bbCoerce({ ...BB_DEFAULT_SPEC, ...mech({ launcher: { kind: 'turret', mount: 'center', hoodDeg: 75 }, lift: null }) });
    check('place point: none without a Box Tube', bbPlacePointLocal(none) === null);
    const front = bbCoerce({ ...BB_DEFAULT_SPEC, intakeMount: 'back', ...mech({ launcher: { kind: 'turret', mount: 'center', hoodDeg: 75 }, lift: { kind: 'vslide', mount: 'front' } }) });
    const pf = bbPlacePointLocal(front)!;
    check('place point: a FRONT tube reaches past the front face on the centreline', Math.abs(pf.x - (front.length / 2 + BB_PLACE_REACH)) < 1e-9 && pf.y === 0, `${pf.x},${pf.y}`);
    const swept = bbCoerce({ ...BB_DEFAULT_SPEC, intakeMount: 'front', ...mech({ launcher: { kind: 'turret', mount: 'center', hoodDeg: 75 }, lift: { kind: 'vslide', mount: 'front' } }) });
    const ps = bbPlacePointLocal(swept)!;
    check('place point: ...a sweeper on that edge counts (it reaches from the FOOTPRINT)', Math.abs(ps.x - (bbFootprint(swept).front + BB_PLACE_REACH)) < 1e-9, `${ps.x} vs ${bbFootprint(swept).front}`);
    const corner = bbCoerce({ ...BB_DEFAULT_SPEC, intakeMount: 'back', ...mech({ launcher: { kind: 'turret', mount: 'center', hoodDeg: 75 }, lift: { kind: 'vslide', mount: 'frontleft' } }) });
    const pc = bbPlacePointLocal(corner)!;
    const fc = bbFootprint(corner);
    check(
      'place point: a CORNER tube reaches along the diagonal from the footprint corner',
      Math.abs(pc.x - (fc.front + MOUNT_DIR.frontleft.x * BB_PLACE_REACH)) < 1e-9 && Math.abs(pc.y - (fc.half + MOUNT_DIR.frontleft.y * BB_PLACE_REACH)) < 1e-9,
      `${pc.x},${pc.y}`,
    );
  }

  // ── THE ARC ───────────────────────────────────────────────────────────────
  {
    const cellZ = (BB_HIVE_OPEN_Z[0] + BB_HIVE_OPEN_Z[1]) / 2;
    for (const d of [24, 48, 72, 96]) {
      const hive = bbSolveShot(d, cellZ - BB_LAUNCH_Z0);
      check(`arc @${d}in: a HIVE turret solution exists`, Number.isFinite(hive.speed) && Number.isFinite(hive.angle));
      check(`arc @${d}in: its elevation is inside the turret envelope`, hive.angle <= BB_TURRET_PITCH_MAX, `${(hive.angle / BB_DEG).toFixed(1)}deg`);
    }
  }
  // ── THE MUZZLE FOLLOWS THE HOOD, AND THE HOOD IS SIZED BY ITS ELEMENT ─────
  /**
   * The shooter rebuild of 2026-09-19 (owner report items a–d, seventh pass). The turret's whole
   * dimension chain lives in `config.ts` and `bbMuzzleLocal` is the ONE function the sim and the
   * 3D scene both read — five passes before that disagreed because the renderer owned the
   * geometry privately and the sim owned a constant.
   *
   * These checks are the chain itself, not a restatement of it: each one would have caught one of
   * the rounds of feedback before it shipped.
   */
  for (const which of [0, 1] as const) {
    const H = bbHead(which);
    const tag = which === 1 ? 'nectar' : 'pollen';
    const level = bbMuzzleLocal(BB_TURRET_PITCH_MIN, which);
    const top = bbMuzzleLocal(BB_TURRET_PITCH_MAX, which);
    /** owner item (c): the flywheel sits RIGHT ABOVE the turret plate, not wherever a pivot left
     * it. The axle is the plate top plus one bearing block plus the wheel radius, and nothing
     * else — so the wheel's bottom is `BB_FLYWHEEL_CLEAR` off the plate by construction, and it is
     * the SAME wheel on both heads: a bigger element wants a bigger hood, not a bigger wheel. */
    check(
      `muzzle ${tag}: the flywheel sits one bearing block above the turret plate`,
      Math.abs(BB_TURRET_AXLE_Z - (BB_TURRET_PLATE_TOP_Z + BB_FLYWHEEL_CLEAR + BB_FLYWHEEL_R)) < 1e-12,
      `axle ${BB_TURRET_AXLE_Z.toFixed(4)}, wheel bottom ${(BB_TURRET_AXLE_Z - BB_FLYWHEEL_R).toFixed(3)} over a plate at ${BB_TURRET_PLATE_TOP_Z.toFixed(2)}`,
    );
    /**
     * ⚠️ **OWNER ITEM (b), AS ARITHMETIC: THE ELEMENT RISES UP THE TURRET'S OWN ROTATION AXIS AND
     * FIRST MEETS THE WHEEL THERE.** "The flywheel should come forward more so that the location
     * where the balls contact the flywheel initially as it comes up is roughly in the center of
     * the turret." A feed through the ring bearing puts the element's centre on x = 0 while it
     * rises; it touches the wheel when it is `BB_FLYWHEEL_R + elemR` from the axle and is fully
     * pinched at `pathR`, so the pinch lands on the axis exactly when `axleX = pathR`. Both
     * points are worked out here from the axle's own offset rather than assumed.
     */
    const pinchX = H.axleX - H.pathR;
    const firstTouchDz = -Math.sqrt((BB_FLYWHEEL_R + H.elemR) ** 2 - H.axleX ** 2);
    check(
      `muzzle ${tag}: the element pinches ON the rotation axis — the axle is pathR forward of it`,
      Math.abs(pinchX) < 1e-12 && Math.abs(H.axleX - H.pathR) < 1e-12,
      `axle x ${H.axleX.toFixed(4)}, pinch x ${pinchX.toFixed(6)}, first touch z ${(BB_TURRET_AXLE_Z + firstTouchDz).toFixed(3)}`,
    );
    check(
      `muzzle ${tag}: ...and it touches the wheel BELOW the axle on the way up, not beside it`,
      Number.isFinite(firstTouchDz) && firstTouchDz < -0.5 && BB_TURRET_AXLE_Z + firstTouchDz > BB_DECK_Z,
      `first contact ${firstTouchDz.toFixed(3)} under the axle, at z ${(BB_TURRET_AXLE_Z + firstTouchDz).toFixed(3)}`,
    );
    /** the lip rides the element's own path circle about the axle, LESS the axle's own forward
     * offset — the closed form, not a fit. `back` is negative at rest: the lip is in FRONT of the
     * rotation axis and creeps back toward it as the hood elevates. */
    check(
      `muzzle ${tag}: the lip is the path circle rotated by the elevation, about an axle that is forward`,
      Math.abs(level.z - (BB_TURRET_AXLE_Z + H.pathR)) < 1e-9 &&
        Math.abs(level.back + H.axleX) < 1e-9 &&
        Math.abs(top.z - (BB_TURRET_AXLE_Z + H.pathR * Math.cos(BB_TURRET_PITCH_MAX))) < 1e-6 &&
        Math.abs(top.back - (H.pathR * Math.sin(BB_TURRET_PITCH_MAX) - H.axleX)) < 1e-6,
      `level (${level.back.toFixed(4)}, ${level.z.toFixed(4)})  80deg (${top.back.toFixed(4)}, ${top.z.toFixed(4)})`,
    );
    /** MONOTONE, both ways: elevating drops the release and pulls it back toward the axis. This is
     * the whole of what "the release follows the hood" buys, and a sign slip would read as a
     * shooter that fires from behind itself. The lip never gets BEHIND the rotation axis. */
    let mono = true;
    let ahead = true;
    let prev = level;
    for (let i = 1; i <= 80; i++) {
      const m = bbMuzzleLocal((i / 80) * BB_TURRET_PITCH_MAX, which);
      if (!(m.z < prev.z && m.back > prev.back)) mono = false;
      if (m.back > 0) ahead = false;
      prev = m;
    }
    check(
      `muzzle ${tag}: elevating LOWERS the release and pulls it BACK, monotonically, and never past the axis`,
      mono && ahead,
      `${level.z.toFixed(3)} -> ${prev.z.toFixed(3)} in, ${level.back.toFixed(3)} -> ${prev.back.toFixed(3)} back`,
    );
    /** owner item (b) of the pass before: the hood extends above the plates. Not by a tuned offset
     * — the plate's outer arc IS the head's own `hoodR` and the hood occupies the shell outside
     * it, so the hood is proud by exactly `BB_HOOD_T` in the worst case and by the plate's
     * flat-top cut everywhere else.
     *
     * ⚠️ **THIS IS THE COMPACT PROFILE AND IT IS THE SHIPPED ONE AGAIN.** Two passes grew the
     * fixed plate up to `hoodR` to close the gap to the hood — a relief ramp, then an exit cut
     * with a raked tail — and the owner rejected both ("the shooter parallel plates became ugly.
     * remember that the arc does not need to be big"), because a fixed plate sized to a part that
     * swings away from it is a bare fin at the 80° cap. The hood carries its own CHEEKS now
     * (`buildHoodNode`), so this arithmetic and `sidePlateR` agree again. The RENDER lane measures
     * the drawn meshes; this stays the arithmetic statement, restated rather than imported. */
    const plateR = (th: number): number => {
      const c = Math.cos(th);
      const sn = Math.sin(th);
      let lim = H.hoodR;
      if (sn > 1e-9) lim = Math.min(lim, BB_SIDE_PLATE_TOP_Z / sn);
      if (sn < -1e-9) lim = Math.min(lim, BB_SIDE_PLATE_BOTTOM_Z / sn);
      if (c > 1e-9) lim = Math.min(lim, BB_SIDE_PLATE_FRONT_X / c);
      return Math.max(0, lim);
    };
    let proud = Infinity;
    for (let i = 0; i <= 48; i++) {
      const pit = (i / 48) * BB_TURRET_PITCH_MAX;
      for (let j = 0; j <= 48; j++) proud = Math.min(proud, H.hoodR + BB_HOOD_T - plateR(Math.PI / 2 + pit + (BB_HOOD_WRAP * j) / 48));
    }
    check(`muzzle ${tag}: the HOOD stands proud of the side plates at every pitch`,
      proud >= BB_HOOD_T - 1e-9, `worst +${proud.toFixed(4)} in, rest +${(H.hoodR + BB_HOOD_T - plateR(Math.PI / 2)).toFixed(3)}`);
    /** the plate's flat top is the CEILING for anything fixed near the shot: it clears the
     * pitch-0 corridor by 0.15 by definition. It is the same number on BOTH heads, because
     * `pathR − elemR` is `BB_FLYWHEEL_R − BB_HOOD_COMPRESSION` whatever the element is — the one
     * place in the chain where a bigger element changes nothing. */
    check(`muzzle ${tag}: the plate top clears the level corridor, by the amount its own formula says`,
      Math.abs(H.pathR - H.elemR - BB_SIDE_PLATE_TOP_Z - 0.15) < 1e-12 &&
        Math.abs(H.pathR - H.elemR - (BB_FLYWHEEL_R - BB_HOOD_COMPRESSION)) < 1e-12,
      `${(H.pathR - H.elemR - BB_SIDE_PLATE_TOP_Z).toFixed(3)} in`);
    /** and no fixed part may sit INSIDE the turret plate. The braces are the front trio; the
     * MOTOR is the one at the back, and it has to clear the hood's whole swept disc rather than
     * an angular window, which is what `motorR` is. */
    let lowest = Infinity;
    for (const b of BB_TURRET_BRACES) lowest = Math.min(lowest, BB_TURRET_AXLE_Z + Math.sin(b.th) * b.r - BB_TURRET_BRACE_R);
    lowest = Math.min(lowest, BB_TURRET_AXLE_Z - BB_TURRET_MOTOR_R);
    check(`muzzle ${tag}: every brace and the motor stand ON the turret plate, not inside it`,
      lowest >= BB_TURRET_PLATE_TOP_Z, `lowest ${lowest.toFixed(3)} vs plate top ${BB_TURRET_PLATE_TOP_Z.toFixed(3)}`);
    /**
     * ⚠️ **OWNER ITEM (a): THE MOTOR IS BEHIND THE HOOD.** It sat at θ = −15°, in front of and
     * under the wheel. The hood sweeps a DISC of radius `hoodR + BB_HOOD_T` — every angle from
     * 90° to `90° + pitchMax + wrap` gets visited by some elevation — so "behind the hood" is a
     * radius, not an angle: the can's nearest point has to be outside that disc, and it has to
     * sit behind the feed wall it bolts to rather than through it.
     */
    check(
      `muzzle ${tag}: the motor is BEHIND the hood — outside its whole swept disc, behind the feed wall`,
      H.motorR - BB_TURRET_MOTOR_R > H.hoodR + BB_HOOD_T &&
        H.motorR - BB_TURRET_MOTOR_R >= H.wallR + BB_FEED_WALL_T - 1e-9 &&
        H.wallR >= H.hoodR + BB_HOOD_T + BB_FEED_SLIDE - 1e-9,
      `can front at ${(H.motorR - BB_TURRET_MOTOR_R).toFixed(3)} vs hood sweep ${(H.hoodR + BB_HOOD_T).toFixed(3)} and wall rear ${(H.wallR + BB_FEED_WALL_T).toFixed(3)}`,
    );
  }
  /**
   * ⚠️ **OWNER ITEM (d): THE TWO HEADS ARE DIFFERENT MACHINES.** "The size of the shooter should
   * be different for the pollen shooter and the nectar shooter." A hooded flywheel is sized by
   * what goes through it, so every length that touches the element has to differ — and the one
   * that does NOT (the corridor floor, above) is a construction, not an oversight.
   */
  {
    const p = bbHead(0);
    const n = bbHead(1);
    const differs: [string, number, number][] = [
      ['hoodR', p.hoodR, n.hoodR],
      ['pathR', p.pathR, n.pathR],
      ['axleX', p.axleX, n.axleX],
      ['plateGap', p.plateGap, n.plateGap],
      ['wallR', p.wallR, n.wallR],
      ['motorR', p.motorR, n.motorR],
      ['tieSpan', p.tieSpan, n.tieSpan],
      ['slotHalfW', p.slotHalfW, n.slotHalfW],
      ['frontX', p.frontX, n.frontX],
      ['backX', p.backX, n.backX],
    ];
    check(
      'heads: every element-sized length differs between the POLLEN head and the NECTAR head',
      p.elemR === BB_POLLEN_R && n.elemR === BB_NECTAR_R && differs.every(([, a, b]) => Math.abs(a - b) > 0.1),
      differs.map(([k, a, b]) => `${k} ${a.toFixed(2)}/${b.toFixed(2)}`).join(' '),
    );
    check(
      'heads: ...and so does the MUZZLE, which is what makes it a sim change and not a repaint',
      bbMuzzleLocal(0, 1).z - bbMuzzleLocal(0, 0).z > 0.3 && bbMuzzleLocal(0, 1).back < bbMuzzleLocal(0, 0).back,
      `pollen (${bbMuzzleLocal(0, 0).back.toFixed(3)}, ${bbMuzzleLocal(0, 0).z.toFixed(3)}) vs nectar (${bbMuzzleLocal(0, 1).back.toFixed(3)}, ${bbMuzzleLocal(0, 1).z.toFixed(3)})`,
    );
    check(
      'heads: ...and the NECTAR head is bigger in every direction it can be',
      n.hoodR > p.hoodR && n.frontX > p.frontX && n.backX < p.backX && n.plateHalfW > p.plateHalfW,
      `front ${p.frontX.toFixed(2)}→${n.frontX.toFixed(2)}, back ${p.backX.toFixed(2)}→${n.backX.toFixed(2)}, half-width ${p.plateHalfW.toFixed(2)}→${n.plateHalfW.toFixed(2)}`,
    );
  }
  /**
   * ⚠️ THE DUMPER HAS NO HOOD, AND THE TURRET'S CHANGE MUST NOT LEAK INTO IT. A tipping tray's
   * lip does not swing about a flywheel axle, so its release is `BB_LAUNCH_Z0` at every angle —
   * `bbMuzzleZ` has to say so for a turretless build whatever pitch it is handed.
   */
  {
    const w = mkWorld('free', 61);
    const r = w.robots[0];
    r.spec = bbCoerce({ ...r.spec, ...mech({ launcher: { kind: 'dumper', mount: 'back', hoodDeg: BB_HOOD_DEFAULT_DEG }, lift: null }) });
    let flat = true;
    for (let i = 0; i <= 16; i++) if (bbMuzzleZ(r.spec, (i / 16) * BB_TURRET_PITCH_MAX) !== BB_LAUNCH_Z0) flat = false;
    check('dumper: its release stays FLAT at BB_LAUNCH_Z0 at every pitch (no hood to follow)', flat,
      `${bbMuzzleZ(r.spec, BB_TURRET_PITCH_MAX)} at 80deg`);
    r.spec = bbCoerce({ ...r.spec, ...mech({ launcher: { kind: 'turret', mount: 'center', hoodDeg: BB_HOOD_DEFAULT_DEG }, lift: null }) });
    check('dumper: ...while a TURRET on the same chassis follows its hood down', bbMuzzleZ(r.spec, BB_TURRET_PITCH_MAX) < bbMuzzleZ(r.spec, BB_TURRET_PITCH_MIN),
      `${bbMuzzleZ(r.spec, BB_TURRET_PITCH_MAX).toFixed(3)} < ${bbMuzzleZ(r.spec, BB_TURRET_PITCH_MIN).toFixed(3)}`);
  }
  /**
   * ⚠️ RESIDUAL 4 OF THE REBUILD, AS A RATCHET. A lower release costs muzzle speed, and the
   * far-corner shot is what runs out first. MEASURED at the shipped geometry: 256.37 in/s against
   * a `BB_LAUNCH_SPEED_MAX` of 260, i.e. 3.63 of headroom, down from 6.74. The cap was NOT raised
   * and must not be; what this check exists to stop is the NEXT change quietly eating the rest.
   */
  {
    const w = mkWorld('free', 63, mech({ launcher: { kind: 'turret', mount: 'center', hoodDeg: BB_HOOD_DEFAULT_DEG }, lift: null }));
    const r = w.robots[0];
    let worst = 0;
    let at = '';
    for (const side of ['north', 'south'] as const) {
      const target = hiveCellTarget('blue', side);
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          r.pos = { x: sx * (BB_HALF_X - 9), y: sy * (BB_HALF_Y - 9) };
          const sol = bbTurretSolution(r, target)!;
          const o = bbTurretOrigin(r);
          const raw = bbSolveShot(
            Math.hypot(target.pos.x - o.x, target.pos.y - o.y) + bbMuzzleLocal(sol.pitch).back,
            target.z - bbMuzzleZ(r.spec, sol.pitch),
          ).speed;
          if (raw > worst) { worst = raw; at = `${side} from (${r.pos.x.toFixed(1)},${r.pos.y.toFixed(1)})`; }
        }
      }
    }
    check('headroom: the far-corner shot still fits under BB_LAUNCH_SPEED_MAX, with the measured margin',
      worst <= BB_LAUNCH_SPEED_MAX && BB_LAUNCH_SPEED_MAX - worst >= 3.6,
      `worst ${worst.toFixed(2)} at ${at}, headroom ${(BB_LAUNCH_SPEED_MAX - worst).toFixed(2)} (cap ${BB_LAUNCH_SPEED_MAX})`);
  }
  /** a turretless build has no pitch axis to solve, and says so rather than guessing one. */
  {
    const w = mkWorld('free', 29);
    const r = w.robots[0];
    const target = { id: 'hive:blue', alliance: 'blue', pos: { x: 40, y: 0 }, z: 59, r: 8 } as const;
    r.spec = bbCoerce({ ...r.spec, ...mech({ launcher: { kind: 'dumper', mount: 'front', hoodDeg: BB_HOOD_DEFAULT_DEG }, lift: null }) });
    check('aim: a TURRETLESS build returns no pitch solution', bbAimPitch(r, target) === null);
    r.spec = bbCoerce({ ...r.spec, ...mech({ launcher: { kind: 'turret', mount: 'center', hoodDeg: BB_HOOD_DEFAULT_DEG }, lift: null }) });
    check('aim: ...and a TURRET does', bbAimPitch(r, target) !== null);
    check('aim: bbIsTurreted agrees with the resolved launcher', bbIsTurreted(bbLauncherOf(r.spec, BB_HOOD_DEFAULT_DEG)));
  }

  // ── THE DUMPER LOBS, FROM CLOSE IN TO A STRICT CAP ────────────────────────
  /**
   * Owner, 2026-09-13: the fixed hood made a dumper stand far off (23–71 in at 75°) and reach too
   * far. A dump is now a LOB peaking `BB_DUMP_APEX_ABOVE` over the cell: it has a throw at every
   * distance in `BB_DUMP_MIN_DIST`..`BB_DUMP_MAX_DIST`, none past the cap, and every throw comes
   * down ON the target while descending (which `hiveAccepts` requires).
   */
  {
    const dh = (BB_HIVE_OPEN_Z[0] + BB_HIVE_OPEN_Z[1]) / 2 - BB_LAUNCH_Z0;
    let bad = 0;
    let firstBad = '';
    for (let d = BB_DUMP_MIN_DIST; d <= BB_DUMP_MAX_DIST; d += 0.5) {
      const lob = bbLobThrow(d, dh);
      if (!lob) {
        bad++;
        if (!firstBad) firstBad = `d=${d}: no throw`;
        continue;
      }
      const t = d / lob.vh; // time to cover d
      const z = lob.vz * t - 0.5 * C.GRAVITY * t * t;
      const vz = lob.vz - C.GRAVITY * t;
      const apex = (lob.vz * lob.vz) / (2 * C.GRAVITY);
      if (Math.abs(z - dh) > 1e-6 || !(vz < 0) || Math.abs(apex - (dh + BB_DUMP_APEX_ABOVE)) > 1e-6 || Math.hypot(lob.vh, lob.vz) > BB_LAUNCH_SPEED_MAX) {
        bad++;
        if (!firstBad) firstBad = `d=${d}: z=${z.toFixed(3)} vz=${vz.toFixed(1)} apex=${apex.toFixed(2)}`;
      }
    }
    check(`dump lob: every distance ${BB_DUMP_MIN_DIST}–${BB_DUMP_MAX_DIST} in has a throw that comes down ON the cell, descending, under the speed cap`, bad === 0, firstBad);
    check('dump lob: the minimum is close in (a throw from 3 in exists)', bbLobThrow(3, dh) !== null);
    check('dump lob: nothing past the strict cap', bbLobThrow(BB_DUMP_MAX_DIST + 0.5, dh) === null && bbLobThrow(60, dh) === null);
  }

  // ── TARGET SELECTION: HIVE ONLY, OWN CELL, OPEN SIDE ─────────────────────
  /**
   * AIM ASSIST AIMS AT THE NEARER CELL OF THE OWN HIVE, WHICHEVER WAY IT IS TILTED (owner,
   * 2026-09-13). No robot can sense which cell is up, so the pick must not change when the HIVE
   * tips. Never a FLOWER, never the opponent's HIVE. Property checks over a grid.
   */
  {
    const w = mkWorld('free', 41);
    const r = w.robots[0]; // blue
    const hive = w.biobuzz!.hives.blue;
    const upWas = hive.up;
    const own = (['north', 'south'] as const).map((s) => hiveCellTarget('blue', s));
    const opp = (['north', 'south'] as const).map((s) => hiveCellTarget('red', s));
    const d2 = (t: ScoreTarget, x: number, y: number): number => (t.pos.x - x) ** 2 + (t.pos.y - y) ** 2;
    let n = 0;
    let notNearest = 0;
    let notOwn = 0;
    let tipChanged = 0;
    let oppNearer = 0;
    let aimedAtDown = 0;
    for (let x = -66; x <= 66; x += 6) {
      for (let y = -66; y <= 66; y += 6) {
        r.pos = { x, y };
        n++;
        hive.up = 'north';
        const a = bbAimTarget(w, r);
        hive.up = 'south';
        const b = bbAimTarget(w, r);
        const want = d2(own[1], x, y) < d2(own[0], x, y) ? own[1] : own[0];
        if (a.pos.x !== want.pos.x || a.pos.y !== want.pos.y) notNearest++;
        if (a.id !== 'hive:blue' || a.alliance !== 'blue') notOwn++;
        if (a.pos.y !== b.pos.y || a.mouth?.y !== b.mouth?.y) tipChanged++;
        if (Math.min(d2(opp[0], x, y), d2(opp[1], x, y)) < Math.min(d2(own[0], x, y), d2(own[1], x, y))) oppNearer++;
        if (a.pos.y < 0) aimedAtDown++; // with the north cell up, a south pick is aimed at the DOWN cell
      }
    }
    hive.up = upWas;
    check('aim assist: always the NEARER cell of the own HIVE', notNearest === 0, `${notNearest}/${n}`);
    check('aim assist: never a FLOWER and never the opponent\'s HIVE', notOwn === 0, `${notOwn}/${n}`);
    check('aim assist: ...not vacuous — the opponent\'s HIVE was nearer at many poses', oppNearer > 100, `${oppNearer}`);
    check('aim assist: the pick does NOT change when the HIVE tips (it cannot sense which cell is up)', tipChanged === 0, `${tipChanged}/${n}`);
    check('aim assist: ...so it does aim at the DOWN cell from that side', aimedAtDown > 0, `${aimedAtDown}`);
  }

  // ── SHOOTING ON THE MOVE: INHERITANCE, THE LEAD, AND THE PROFILE ──────────
  //
  // Owner, 2026-09-19: "animate the turret properly so that it has a 'shooting on the move'
  // correction algorithm built in its animation. This does mean that perfect tracking is not
  // possible. Make the turret be fairly fast though." Four claims, one block.
  {
    const TURRET_C = { launcher: { kind: 'turret' as const, mount: 'center' as const, hoodDeg: BB_HOOD_DEFAULT_DEG }, lift: null };

    // (1) ⚠️ A PARKED ROBOT IS BYTE-IDENTICAL. Every lead term is multiplied by a velocity of
    // exactly zero, so the solve of a stopped robot must be the same FLOATS it was before the
    // lead existed — that is what keeps the field's scoreable-cell counts (1382 north / 1439
    // south) from moving. Pinned against the pre-lead loop, written out here in full.
    {
      const w = mkWorld('free', 61, mech(TURRET_C));
      const r = w.robots[0];
      let worst = 0;
      let n = 0;
      for (let x = -60; x <= 60; x += 7.5) {
        for (let y = -60; y <= 60; y += 7.5) {
          park(r, x, y, 0.3);
          const target = bbAimTarget(w, r);
          const sol = bbTurretSolution(r, target)!;
          const o = bbTurretOrigin(r);
          const dx = target.pos.x - o.x;
          const dy = target.pos.y - o.y;
          const d0 = hyp(dx, dy);
          let p = BB_TURRET_PITCH_MIN;
          let s = bbSolveShot(d0 + bbMuzzleLocal(p).back, target.z - bbMuzzleZ(r.spec, p));
          for (let i = 1; i < BB_TURRET_SOLVE_PASSES; i++) {
            p = Math.min(Math.max(s.angle, BB_TURRET_PITCH_MIN), BB_TURRET_PITCH_MAX);
            s = bbSolveShot(d0 + bbMuzzleLocal(p).back, target.z - bbMuzzleZ(r.spec, p));
          }
          p = Math.min(Math.max(s.angle, BB_TURRET_PITCH_MIN), BB_TURRET_PITCH_MAX);
          worst = Math.max(
            worst,
            Math.abs(sol.pitch - p),
            Math.abs(wrapAngle(sol.yaw - datan2(dy, dx))),
            Math.abs(sol.speed - Math.min(s.speed, BB_LAUNCH_SPEED_MAX)),
          );
          n++;
        }
      }
      check(
        `lead: a PARKED robot's solve is byte-identical to the pre-lead one (${n} poses)`,
        worst === 0,
        `worst deviation ${worst.toExponential(2)}`,
      );
    }

    // (2) INHERITANCE. A release from a robot moving at v (and spinning at omega) leaves with the
    // muzzle-relative velocity PLUS `v + omega x r` at the muzzle point — the thing that did not
    // happen at all before, and the thing a lead has to correct.
    {
      const w = mkWorld('free', 62, mech(TURRET_C));
      const r = w.robots[0];
      park(r, 20, 30, 0.7);
      r.bbTurretPitch = 0.6;
      r.turretHeading = 1.1;
      const still = bbTurretRelease(r, 0, 180);
      r.vel = { x: 37, y: -19 };
      r.angVel = 1.7;
      const moving = bbTurretRelease(r, 0, 180);
      const rx = still.origin.x - r.pos.x;
      const ry = still.origin.y - r.pos.y;
      const wantX = r.vel.x - r.angVel * ry;
      const wantY = r.vel.y + r.angVel * rx;
      check(
        'lead: a release inherits v + omega x r at the MUZZLE, and nothing else',
        Math.abs(moving.vel.x - still.vel.x - wantX) < 1e-9 &&
          Math.abs(moving.vel.y - still.vel.y - wantY) < 1e-9 &&
          moving.vel.z === still.vel.z &&
          moving.origin.x === still.origin.x,
        `dv=(${(moving.vel.x - still.vel.x).toFixed(4)},${(moving.vel.y - still.vel.y).toFixed(4)}) want=(${wantX.toFixed(4)},${wantY.toFixed(4)})`,
      );
      r.vel = { x: 0, y: 0 };
      r.angVel = 3;
      const spun = bbTurretRelease(r, 0, 180);
      check(
        'lead: ...and a SPINNING chassis alone moves the release velocity (the omega x r term)',
        Math.abs(rx) + Math.abs(ry) > 0.5 && hyp(spun.vel.x - still.vel.x, spun.vel.y - still.vel.y) > 1,
        `arm=(${rx.toFixed(2)},${ry.toFixed(2)}) dv=${hyp(spun.vel.x - still.vel.x, spun.vel.y - still.vel.y).toFixed(2)}`,
      );
      r.angVel = 0;
    }

    // (3) THE LEAD ACTUALLY LEADS. With the turret ON its solution at a real drive speed, the
    // solved release has to land in the CELL — which is exactly what firing the pre-lead pair at
    // the same speed does not do.
    {
      const w = mkWorld('free', 63, mech(TURRET_C));
      const r = w.robots[0];
      let led = 0;
      let unled = 0;
      let n = 0;
      for (const [x, y] of [
        [-30, 45],
        [10, 55],
        [40, 40],
        [-50, 20],
        [0, 62],
      ] as const) {
        for (let h = 0; h < 8; h++) {
          const a = (h * Math.PI) / 4;
          park(r, x, y, 0);
          const target = bbAimTarget(w, r);
          const hive = { ...w.biobuzz!.hives.blue, up: 'north' as const, tipping: 0, released: false };
          const cold = bbTurretSolution(r, target)!;
          r.turretHeading = cold.yaw;
          r.bbTurretPitch = cold.pitch;
          r.vel = { x: Math.cos(a) * 70, y: Math.sin(a) * 70 };
          if (cold.reachable) {
            const stale = bbTurretRelease(r, 0, cold.speed);
            if (bbFlightEnters(hive, 'blue', stale.origin, stale.z, stale.vel, C.SIM_DT)) unled++;
          }
          // the LED solve from the same MOVING pose — put the turret on its own fixed point first
          for (let k = 0; k < 4; k++) {
            const s = bbTurretSolution(r, target)!;
            r.turretHeading = s.yaw;
            r.bbTurretPitch = s.pitch;
          }
          const hot = bbTurretSolution(r, target)!;
          // ⚠️ COUNTED ON THE LED SOLUTION'S OWN `reachable`, not the parked one's. A robot driving
          // AWAY from its cell needs a longer shot than the same robot standing still, and past the
          // barrel's envelope the solve says so honestly — that is a miss the driver can see, not
          // a lead failure.
          if (hot.reachable) {
            n++;
            const rel = bbTurretRelease(r, 0, hot.speed);
            if (bbFlightEnters(hive, 'blue', rel.origin, rel.z, rel.vel, C.SIM_DT)) led++;
          }
          r.vel = { x: 0, y: 0 };
        }
      }
      check('lead: a shot from a robot driving at 70 in/s ENTERS the cell', n > 20 && led === n, `${led}/${n}`);
      check('lead: ...and the PRE-LEAD pair fired from the same pose does not', unled * 4 < n, `${unled}/${n} would have entered`);
    }

    // (4) THE PROFILE. A rate AND an acceleration, decelerating into the target, never past it —
    // and "fairly fast" is a NUMBER: 90 degrees in 0.25..0.35 s from rest.
    {
      const w = mkWorld('free', 64, mech(TURRET_C));
      const r = w.robots[0];
      park(r, 0, 0, 0);
      r.turretHeading = 0;
      r.bbTurretYawVel = 0;
      const want = Math.PI / 2;
      let ticks = -1;
      let peakRate = 0;
      let peakAcc = 0;
      let overshoot = 0;
      let prev = 0;
      for (let i = 0; i < 400; i++) {
        bbSlewTurret(r, want, null, C.SIM_DT, 0);
        const v = r.bbTurretYawVel ?? 0;
        peakRate = Math.max(peakRate, Math.abs(v));
        peakAcc = Math.max(peakAcc, Math.abs(v - prev) / C.SIM_DT);
        prev = v;
        overshoot = Math.max(overshoot, -wrapAngle(want - r.turretHeading));
        if (ticks < 0 && r.turretHeading === want && v === 0) ticks = i + 1;
      }
      check(
        'turret profile: a 90-degree swing from rest takes 0.25..0.35 s (owner: "fairly fast")',
        ticks > 0 && ticks * C.SIM_DT >= 0.25 && ticks * C.SIM_DT <= 0.35,
        `${ticks} ticks = ${(ticks * C.SIM_DT).toFixed(3)}s`,
      );
      check('turret profile: ...never exceeding the RATE limit', peakRate <= BB_TURRET_SLEW + 1e-9, `${peakRate.toFixed(4)}/${BB_TURRET_SLEW}`);
      check(
        'turret profile: ...never exceeding the ACCELERATION limit',
        // the tolerance is ONE QUANTUM of the rate per tick (1e-4 rad/s / dt = 6e-3 rad/s^2) — the
        // profile is exact and the rounding of `bbTurretYawVel` is what this allows for.
        peakAcc <= BB_TURRET_ACCEL + 1e-2,
        `${peakAcc.toFixed(3)}/${BB_TURRET_ACCEL}`,
      );
      check('turret profile: ...and never overshooting or ringing', overshoot <= 0, `overshoot=${overshoot.toExponential(2)}`);
      park(r, 0, 0, 0);
      r.turretHeading = 0;
      r.bbTurretYawVel = 0;
      bbSlewTurret(r, want, null, C.SIM_DT, 0);
      check(
        'turret profile: ...and a rate-only clamp is ruled out (tick one is at the ACCEL, not the RATE)',
        Math.abs((r.bbTurretYawVel ?? 0) - BB_TURRET_ACCEL * C.SIM_DT) < 1e-3,
        `v1=${(r.bbTurretYawVel ?? 0).toFixed(4)} accel*dt=${(BB_TURRET_ACCEL * C.SIM_DT).toFixed(4)}`,
      );
      park(r, 0, 0, 0);
      r.bbTurretPitch = 0;
      r.bbTurretPitchVel = 0;
      let pk = 0;
      let pacc = 0;
      let pprev = 0;
      for (let i = 0; i < 400; i++) {
        bbSlewTurret(r, null, BB_TURRET_PITCH_MAX, C.SIM_DT, 0);
        const v = r.bbTurretPitchVel ?? 0;
        pk = Math.max(pk, Math.abs(v));
        pacc = Math.max(pacc, Math.abs(v - pprev) / C.SIM_DT);
        pprev = v;
      }
      check(
        'turret profile: the PITCH axis keeps its own (slower) rate and acceleration',
        pk <= BB_TURRET_PITCH_SLEW + 1e-9 && pacc <= BB_TURRET_PITCH_ACCEL + 1e-2 && (r.bbTurretPitch ?? 0) === BB_TURRET_PITCH_MAX,
        `rate ${pk.toFixed(3)}/${BB_TURRET_PITCH_SLEW} accel ${pacc.toFixed(2)}/${BB_TURRET_PITCH_ACCEL}`,
      );
    }

    // (5) A SPINNING CHASSIS IS THE BASE THE RING TURNS ON. `turretHeading` is a WORLD angle, so
    // holding a bearing on a rotating robot costs the motor its own rate — and a chassis spinning
    // faster than the turret can counter DRAGS it.
    {
      const w = mkWorld('free', 65, mech(TURRET_C));
      const r = w.robots[0];
      park(r, 0, 0, 0);
      r.turretHeading = 0;
      r.bbTurretYawVel = 0;
      r.angVel = BB_TURRET_SLEW + 5;
      for (let i = 0; i < 30; i++) bbSlewTurret(r, 0, null, C.SIM_DT, 0);
      const dragged = r.turretHeading;
      check(
        'turret profile: a chassis spinning faster than the ring DRAGS the world bearing off target',
        dragged > 0.05,
        `bearing drifted ${dragged.toFixed(3)} rad while holding 0`,
      );
      park(r, 0, 0, 0);
      r.turretHeading = 0;
      r.bbTurretYawVel = 0;
      r.angVel = 3;
      for (let i = 0; i < 60; i++) bbSlewTurret(r, 0, null, C.SIM_DT, 0);
      check(
        'turret profile: ...and at a spin it CAN counter, the world bearing is held',
        Math.abs(r.turretHeading) < 1e-6,
        `bearing=${r.turretHeading.toExponential(2)}`,
      );
      r.angVel = 0;
    }

    // (6) THE GATE HOLDS A SHOT IT WOULD MISS. A hard reversal moves the lead solution faster than
    // the barrel can follow; Aim Assist must WAIT rather than release a miss.
    {
      const w = mkWorld('free', 66, mech(TURRET_C));
      const r = w.robots[0];
      park(r, -45, 52, 0);
      const fwd = cmd({ leftDrive: 1, rightDrive: 1, driveY: 1, fire: true });
      const back = cmd({ leftDrive: -1, rightDrive: -1, driveY: -1, fire: true });
      run(w, fwd, 2.5);
      const settled = Math.abs(wrapAngle(bbTurretSolution(r, bbAimTarget(w, r))!.yaw - r.turretHeading));
      let peak = 0;
      let firedOff = 0;
      for (let t = 0; t < 120; t++) {
        const before = r.hopper.length;
        tick(w, back);
        const e = Math.abs(wrapAngle(bbTurretSolution(r, bbAimTarget(w, r))!.yaw - r.turretHeading));
        peak = Math.max(peak, e);
        if (r.hopper.length < before && e > settled + 0.02) firedOff++;
      }
      check('lead: a hard REVERSAL leaves the barrel visibly behind its solution', peak > 0.15, `peak error ${(peak / BB_DEG).toFixed(1)} deg`);
      check('lead: ...and the landing gate HOLDS the shot rather than firing a miss', firedOff === 0, `${firedOff} releases while off-solution`);
    }
  }

  // ── A TURRET SLEWS, AND ITS ARC ARRIVES (through the world) ──────────────
  {
    const w = mkWorld('free', 43, mech({ launcher: { kind: 'turret', mount: 'center', hoodDeg: BB_HOOD_DEFAULT_DEG }, lift: null }));
    const r = w.robots[0];
    park(r, 40, 50, Math.PI); // blue, on its own cell's OPEN side
    const yaw0 = r.turretHeading;
    const pitch0 = r.bbTurretPitch ?? 0;
    // ⚠️ A TURRET SPAWNS AT `BB_TURRET_PITCH_REST`, NOT LEVEL — level is the hood's tallest pose and
    // one no HIVE shot uses (owner, 2026-09-24). A turretless build carries no pitch at all.
    check('turret: spawn seeds the elevation at BB_TURRET_PITCH_REST, not level', pitch0 === BB_TURRET_PITCH_REST, `${pitch0}`);
    {
      const wd = mkWorld('free', 43, mech({ launcher: { kind: 'dumper', mount: 'front', hoodDeg: BB_HOOD_DEFAULT_DEG }, lift: null }));
      check('turret: ...and a DUMPER spawns with no pitch field at all', wd.robots[0].bbTurretPitch === undefined && wd.robots[0].bbTurret2Pitch === undefined);
    }
    run(w, cmd({}), 1.5);
    const target = bbAimTarget(w, r);
    check('turret: the test pose aims at the own up cell (the nearer one, from its open side)', target.pos.y > 0);
    if (target) {
      const sol = bbTurretSolution(r, target)!;
      check('turret: STEPPING THE WORLD moves the yaw axis off its spawn bearing', Math.abs(r.turretHeading - yaw0) > 1e-3, `${yaw0.toFixed(3)} -> ${r.turretHeading.toFixed(3)} rad`);
      check('turret: it settles ON the solution', Math.abs(wrapAngle(r.turretHeading - sol.yaw)) < 0.02, `yaw=${r.turretHeading.toFixed(3)} want=${sol.yaw.toFixed(3)}`);
      check('turret: the PITCH axis is driven too, and off zero', (r.bbTurretPitch ?? 0) > 0.05 && Math.abs((r.bbTurretPitch ?? 0) - pitch0) > 1e-3, `pitch=${((r.bbTurretPitch ?? 0) / BB_DEG).toFixed(1)}deg`);
      check('turret: pitch stays inside the barrel envelope', (r.bbTurretPitch ?? 0) <= BB_TURRET_PITCH_MAX + 1e-9);
      check('turret: a single turret never writes the second turret\'s fields', r.bbTurret2Heading === undefined && r.bbTurret2Pitch === undefined);
      /**
       * ⚠️ MEASURED FROM THE MUZZLE, WHICH IS NO LONGER THE BOLT POINT (2026-09-19, the hood
       * rebuild). The hood lip rides the element's path circle about the flywheel axle, so at
       * elevation it sits LOWER and FURTHER BACK than the turret's mount — `bbMuzzleLocal` is the
       * one function that says by how much, and `bbTurretSolution` solves the fixed point it
       * creates. Reading `d` off the bolt point and `want` off a flat 10 in was right while the
       * exit was a constant; it now understates the range by `back` and the drop by 2.1 in, and
       * this check failed at rise=52.15 want=49.80 for exactly that reason.
       */
      const m = bbMuzzleLocal(sol.pitch);
      const o = bbTurretOrigin(r);
      const d = Math.hypot(target.pos.x - o.x, target.pos.y - o.y) + m.back;
      const t = d / (sol.speed * Math.cos(sol.pitch));
      const rise = sol.speed * Math.sin(sol.pitch) * t - 0.5 * C.GRAVITY * t * t;
      const want = target.z - bbMuzzleZ(r.spec, sol.pitch);
      check('turret: the solved (speed, angle) pair lands at the target HEIGHT', Math.abs(rise - want) < 0.5, `rise=${rise.toFixed(2)} want=${want.toFixed(2)} d=${d.toFixed(1)}`);
      /** THE FIXED POINT ACTUALLY CONVERGED. One more pass must not move the pitch: the release
       * height implied by the answer has to be the release height the answer was solved from. */
      {
        const again = bbSolveShot(d, target.z - bbMuzzleZ(r.spec, sol.pitch));
        check(
          'turret: the muzzle-follows-hood solve is a CONVERGED fixed point (one more pass moves nothing)',
          Math.abs(again.angle - sol.pitch) < 1e-6,
          `residual=${Math.abs(again.angle - sol.pitch).toExponential(2)} rad`,
        );
      }
      check('turret: the solved speed is inside the launcher ceiling', sol.speed <= BB_LAUNCH_SPEED_MAX + 1e-9, `${sol.speed.toFixed(1)}`);
    }
  }

  // ── THE DOUBLE TURRET: TWO TURRETS SLEW, TWO EXITS ────────────────────────
  {
    const w = mkWorld('free', 47, mech({ launcher: TWIN, lift: null }));
    const r = w.robots[0];
    check('twin: spawn seeds the NECTAR turret\'s yaw and pitch', typeof r.bbTurret2Heading === 'number' && r.bbTurret2Pitch === BB_TURRET_PITCH_REST, `${r.bbTurret2Heading}/${r.bbTurret2Pitch}`);
    check('twin: ...and the POLLEN turret spawns at the same rest elevation, not level', r.bbTurretPitch === BB_TURRET_PITCH_REST, `${r.bbTurretPitch}`);
    emptyHopper(w, r);
    park(r, 40, 50, Math.PI);
    const yaw0 = r.turretHeading;
    const yaw1 = r.bbTurret2Heading ?? 0;
    run(w, cmd({}), 1.5);
    const target = bbAimTarget(w, r);
    const s0 = bbTurretSolution(r, target, 0)!;
    const s1 = bbTurretSolution(r, target, 1)!;
    check('twin: STEPPING THE WORLD slews BOTH turrets', Math.abs(r.turretHeading - yaw0) > 1e-3 && Math.abs((r.bbTurret2Heading ?? 0) - yaw1) > 1e-3);
    check(
      'twin: each turret settles on ITS OWN solution (yaw and pitch)',
      Math.abs(wrapAngle(r.turretHeading - s0.yaw)) < 0.02 &&
        Math.abs(wrapAngle((r.bbTurret2Heading ?? 0) - s1.yaw)) < 0.02 &&
        Math.abs((r.bbTurret2Pitch ?? 0) - s1.pitch) < 0.02,
      `t0 ${r.turretHeading.toFixed(3)}/${s0.yaw.toFixed(3)} t1 ${(r.bbTurret2Heading ?? 0).toFixed(3)}/${s1.yaw.toFixed(3)} p1 ${(r.bbTurret2Pitch ?? 0).toFixed(3)}/${s1.pitch.toFixed(3)}`,
    );
    // FIRE: stage a POLLEN under a NECTAR, so the NECTAR (top) leaves first, then the POLLEN
    give(w, r, ['yellow', 'blue']);
    r.fireReadyAt = w.time;
    const seen = new Set<number>();
    type Born = { p: { x: number; y: number }; o: { x: number; y: number }; mz: number; z: number };
    let nectarAt: Born | null = null;
    let pollenAt: Born | null = null;
    for (let k = 0; k < 40 && !(nectarAt && pollenAt); k++) {
      tick(w, cmd({ fire: true }));
      for (const b of w.balls) {
        if (b.state.kind !== 'flight' || seen.has(b.id)) continue;
        seen.add(b.id);
        const which = b.color === 'blue' ? 1 : 0;
        // the RELEASE, read at the pitch the turret is at on the tick it fired — `bbTurretRelease`
        // is what `bbLaunch` itself called, so this is the same point and not a re-derivation
        const rel = bbTurretRelease(r, which, 0);
        const rec = { p: { ...b.pos }, o: rel.origin, mz: rel.z, z: b.z };
        if (b.color === 'blue') nectarAt = rec;
        else pollenAt = rec;
      }
    }
    const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);
    /** ⚠️ AT THE MUZZLE, NOT AT THE MOUNT. These two compared the birth point against
     * `bbTurretOrigin` while the exit was a fixed point over the ring; the hood lip RETREATS
     * along the turret heading as the barrel elevates (`bbMuzzleLocal`), so at the ~70° these
     * poses shoot at, the element is born 2.33/2.35 in behind the bolt point — which is what they
     * measured when they failed. `bbTurretRelease` is the one answer both the check and
     * `bbLaunch` read. */
    check('twin: a NECTAR is born at turret 1\'s MUZZLE (mount2, set back by the hood)', !!nectarAt && dist(nectarAt.p, nectarAt.o) < 1e-6, nectarAt ? `${dist(nectarAt.p, nectarAt.o)}` : 'never fired');
    check('twin: a POLLEN is born at turret 0\'s MUZZLE (mount, set back by the hood)', !!pollenAt && dist(pollenAt.p, pollenAt.o) < 1e-6, pollenAt ? `${dist(pollenAt.p, pollenAt.o)}` : 'never fired');
    check('twin: ...and the two exits are genuinely different points', dist(bbTurretOrigin(r, 0), bbTurretOrigin(r, 1)) > 3);
    /** THE SOLVE STARTS WHERE THE ELEMENT DOES. `bbTurretSolution` solves from `bbMuzzleZ` and
     * `releasePollen` is handed that same height; the turret once solved from 2in above the
     * release, and every turret shot arrived 2in low. Read off the world, on both turrets.
     *
     * ⚠️ IT IS NO LONGER `BB_LAUNCH_Z0`, AND THAT IS THE POINT OF THE REBUILD (owner,
     * 2026-09-19): the muzzle FOLLOWS THE HOOD. The two turrets sit at slightly different
     * elevations here, so they release at slightly different heights — 8.07 and 8.01 in these
     * poses — and each has to match ITS OWN solve, which a single shared constant could not
     * express. Both are below the level-muzzle 9.634 and below the old flat 10. */
    check(
      'twin: both turrets release at the height their OWN arc was solved from',
      !!nectarAt && !!pollenAt && Math.abs(nectarAt.z - nectarAt.mz) < 1e-9 && Math.abs(pollenAt.z - pollenAt.mz) < 1e-9,
      `nectar z=${nectarAt?.z} (solve ${nectarAt?.mz}) pollen z=${pollenAt?.z} (solve ${pollenAt?.mz})`,
    );
    check(
      'twin: ...and that height is the hood lip, below both the level muzzle and the old flat BB_LAUNCH_Z0',
      !!nectarAt &&
        !!pollenAt &&
        nectarAt.z < bbMuzzleZ(r.spec) &&
        pollenAt.z < bbMuzzleZ(r.spec) &&
        nectarAt.z < BB_LAUNCH_Z0 &&
        pollenAt.z < BB_LAUNCH_Z0,
      `level=${bbMuzzleZ(r.spec).toFixed(3)} flat=${BB_LAUNCH_Z0} nectar=${nectarAt?.z.toFixed(3)} pollen=${pollenAt?.z.toFixed(3)}`,
    );
  }

  // ── TWO TURRETS FIRE ON ONE BEAT (owner item 5, 2026-09-19) ───────────────
  /**
   * "Double turret shooter should start shooting pollen and nectar at the same time."
   *
   * MEASURED BEFORE THE FIX, a twin loaded with 2 POLLEN + 2 NECTAR, fire held from rest: the
   * releases came out NECTAR at tick 0, POLLEN at tick 4, NECTAR at 9, POLLEN at 13 — one LIFO
   * hopper top chose ONE exit per beat, so the second turret's first shot was always a whole
   * `BB_FIRE_INTERVAL` behind the first's, in both pipelines. And the gate read that top
   * element's exit ALONE, so a NECTAR on top with turret 1 off target refused the fire outright
   * and a loaded, aimed POLLEN turret fired nothing at all.
   *
   * `bbLaunch` is called DIRECTLY here rather than through a world tick, because what is being
   * pinned is the feed and the gate — one per exit — and a crafted `BbShot` is the only way to
   * say "turret 1 has no solution" without hunting for a pose that produces one.
   */
  {
    const target = hiveCellTarget('blue', 'north');
    /** a parked twin with `colours` in the hopper and its cadence clock ready */
    const armed = (seed: number, colours: readonly Colour[]): { w: World; r: RobotState } => {
      const w = mkWorld('free', seed, mech({ launcher: TWIN, lift: null }));
      const r = w.robots[0];
      emptyHopper(w, r);
      park(r, 40, 50, Math.PI);
      give(w, r, colours);
      w.time = 10;
      r.fireReadyAt = 10;
      return { w, r };
    };
    const flew = (w: World): string =>
      w.balls
        .filter((b) => b.state.kind === 'flight')
        .map((b) => (b.color === 'yellow' ? 'P' : 'N'))
        .sort()
        .join('');
    const shot = (l0: boolean, l1: boolean): BbShot => ({ target, speed: [undefined, undefined], lands: [l0, l1] });

    {
      const { w, r } = armed(61, ['yellow', 'blue']);
      bbLaunch(w, r, cmd({ fire: true }), true, shot(true, true));
      check(
        'twin fire: ONE tick from rest puts a POLLEN and a NECTAR out together',
        flew(w) === 'NP' && r.hopper.length === 0,
        `flew=${flew(w) || '-'} hopper=[${r.hopper.join(',')}]`,
      );
    }
    {
      // TURRET 1 HAS NOTHING. The POLLEN turret must still fire — it used to, but only because
      // the hopper top happened to be a POLLEN; the reverse case below is the one that failed.
      const { w, r } = armed(62, ['yellow', 'yellow']);
      bbLaunch(w, r, cmd({ fire: true }), true, shot(true, true));
      check('twin fire: an EMPTY NECTAR turret does not stop the POLLEN turret', flew(w) === 'P', `flew=${flew(w) || '-'}`);
    }
    {
      const { w, r } = armed(63, ['blue', 'blue']);
      bbLaunch(w, r, cmd({ fire: true }), true, shot(true, true));
      check('twin fire: an EMPTY POLLEN turret does not stop the NECTAR turret', flew(w) === 'N', `flew=${flew(w) || '-'}`);
    }
    {
      // ⚠️ THE REGRESSION. Aim assist is ON, the NECTAR is the hopper's top, and turret 1 is
      // still slewing: before the fix `want` was computed from the top element's exit alone and
      // the whole launcher refused, POLLEN turret included.
      const { w, r } = armed(64, ['yellow', 'blue']);
      r.aimAssist = true;
      bbLaunch(w, r, cmd({ fire: true }), true, shot(true, false));
      check(
        'twin fire: a NECTAR turret with no solution does not block the POLLEN turret',
        flew(w) === 'P' && r.hopper.join(',') === 'blue',
        `flew=${flew(w) || '-'} hopper=[${r.hopper.join(',')}]`,
      );
    }
    {
      const { w, r } = armed(65, ['yellow', 'blue']);
      r.aimAssist = true;
      bbLaunch(w, r, cmd({ fire: true }), true, shot(false, true));
      check(
        'twin fire: ...and the mirror — a POLLEN turret with no solution does not block the NECTAR turret',
        flew(w) === 'N' && r.hopper.join(',') === 'yellow',
        `flew=${flew(w) || '-'} hopper=[${r.hopper.join(',')}]`,
      );
    }
    {
      const { w, r } = armed(66, ['yellow', 'blue']);
      r.aimAssist = true;
      bbLaunch(w, r, cmd({ fire: true }), true, shot(false, false));
      check('twin fire: neither on target releases nothing at all', flew(w) === '' && r.hopper.length === 2, `flew=${flew(w) || '-'}`);
    }
    {
      // A SINGLE TURRET IS UNTOUCHED: one exit, one element per beat, the hopper's own top.
      const w = mkWorld('free', 67, mech({ launcher: { kind: 'turret', mount: 'front', hoodDeg: 75 }, lift: null }));
      const r = w.robots[0];
      emptyHopper(w, r);
      park(r, 40, 50, Math.PI);
      give(w, r, ['yellow', 'yellow', 'yellow']);
      w.time = 10;
      r.fireReadyAt = 10;
      bbLaunch(w, r, cmd({ fire: true }), true, shot(true, true));
      check(
        'single turret: still exactly ONE element per beat',
        w.balls.filter((b) => b.state.kind === 'flight').length === 1 && r.hopper.length === 2,
        `flew=${w.balls.filter((b) => b.state.kind === 'flight').length} hopper=${r.hopper.length}`,
      );
    }
  }

  // ── THE INTAKE RULE ───────────────────────────────────────────────────────
  {
    const specOf = (kind: string): RobotSpec =>
      bbCoerce({ ...BB_DEFAULT_SPEC, ...mech({ launcher: { kind, mount: kind === 'dumper' ? 'back' : 'front', hoodDeg: 75 }, lift: null }) });
    check('intake rule: every build takes POLLEN', BB_SCORE_MODES.every((k) => bbIntakeAccepts(specOf(k), 'blue', 'yellow')));
    check('intake rule: a SINGLE turret refuses even its own NECTAR', !bbIntakeAccepts(specOf('turret'), 'blue', 'blue'));
    check('intake rule: a DOUBLE turret and a DUMPER take their own NECTAR', bbIntakeAccepts(specOf('twinturret'), 'blue', 'blue') && bbIntakeAccepts(specOf('dumper'), 'red', 'red'));
    check('intake rule: NO build takes the opponent\'s NECTAR (G408)', BB_SCORE_MODES.every((k) => !bbIntakeAccepts(specOf(k), 'blue', 'red') && !bbIntakeAccepts(specOf(k), 'red', 'blue')));
    check(
      'intake rule: bbCarriesNectar is exactly double turret + dumper',
      BB_SCORE_MODES.every((k) => bbCarriesNectar(specOf(k).bbMech!.launcher) === (k === 'twinturret' || k === 'dumper')),
    );
  }
  /** ...and the same rule THROUGH THE WORLD: a real intake, a real mouth, a real tick. */
  for (const kind of BB_SCORE_MODES) {
    for (const colour of ['yellow', 'blue', 'red'] as const) {
      const w = mkWorld('free', 31, mech({ launcher: { kind, mount: kind === 'dumper' ? 'back' : 'center', hoodDeg: 75 }, lift: null }, { intakeMount: 'front' }));
      const r = w.robots[0];
      emptyHopper(w, r);
      park(r, 0, 0, 0);
      r.autoIntake = false;
      const m = bbMouths(r.spec)[0];
      const b: Artifact = { ...bbPollen(nextId(w), (m.x0 + m.x1) / 2, 0), color: colour };
      w.balls.push(b);
      // 0.35 s: an intake is a ROLLER now, not a trigger rect — one element per
      // `BB_INTAKE_PERIOD_MIN`..`_MAX` through the feed (`bbIntakeAct`), so the wait has to
      // clear the slowest cadence, not just be nonzero. WAS 0.15/0.3 s (a tenth of a second
      // was safely under the old MIN); PERIOD_MIN dropped to 0.06 s, so 0.35 s is kept as the
      // margin over the new PERIOD_MAX (0.12 s) rather than tightened — this check is about
      // WHICH colour is taken, not how fast, and a false failure here reads as a rules bug.
      run(w, cmd({ intake: true }), 0.35);
      const want = colour === 'yellow' || (colour === 'blue' && kind !== 'turret');
      const what = colour === 'yellow' ? 'POLLEN' : colour === 'blue' ? 'own NECTAR' : 'OPPONENT NECTAR';
      check(
        `intake [${kind}] ${what}: ${want ? 'taken' : 'left on the floor'}`,
        (b.state.kind === 'held') === want && (want || b.state.kind === 'ground'),
        `state=${b.state.kind} hopper=${r.hopper.join(',')}`,
      );
    }
  }

  // ── THE ROLLER INTAKE (`bbIntakeAct`) ─────────────────────────────────────
  /**
   * The intake is a ROLLER, not a trigger rect: it PULLS what it has hold of toward the throat
   * (a velocity the solve integrates — never a position), swallows only what has arrived, one
   * element per feed cadence, and refuses outright when the hopper is full. Every check below
   * is a case the old one-tick rect test got wrong, measured before it was replaced.
   */
  {
    const frontSpec: Partial<RobotSpec> = { intakeMount: 'front' };
    /** a fresh one-robot world, hopper emptied and the robot parked where the check wants it */
    const staged = (seed: number, x: number, y: number, heading = 0, spec: Partial<RobotSpec> = frontSpec) => {
      const w = mkWorld('free', seed, spec);
      const r = w.robots[0];
      emptyHopper(w, r);
      park(r, x, y, heading);
      r.autoIntake = false;
      r.autoFire = false;
      return { w, r };
    };
    const heldCount = (w: World, r: RobotState): number =>
      w.balls.filter((b) => b.state.kind === 'held' && b.state.robot === r.id).length;

    // ONE REACH. Everything that asks how far the sweeper sticks out must get the same answer.
    {
      let worst = '';
      for (const s of everyBuild()) {
        const reach = bbIntakeReach(s);
        const hl = s.length / 2;
        const front = bbMouths(s).find((m) => m.edge === 'front');
        const ok =
          reach >= 3 &&
          reach <= 5 &&
          (!front || Math.abs(front.x1 - (hl + reach)) < 1e-9) &&
          Math.abs(bbFootprint(s).front - (hl + (front ? reach : 0))) < 1e-9;
        if (!ok && !worst) worst = `${s.intake}/${s.intakeMount} reach=${reach} x1=${front?.x1} front=${bbFootprint(s).front}`;
      }
      check('roller: bbIntakeReach is the ONE reach — 3..5 in, and the mouth and the footprint are both built from it', worst === '', worst);
    }

    // A POLLEN ON A WALL IS COLLECTED, not wedged — the most common real complaint.
    {
      const { w, r } = staged(41, BB_HALF_X - bbFootprint(BB_DEFAULT_SPEC).front - 16, 8);
      w.balls.push(bbPollen(nextId(w), BB_HALF_X - BB_POLLEN_R, 8));
      const b = w.balls[w.balls.length - 1];
      run(w, cmd({ driveY: 0.7, intake: true }), 3);
      check('roller: a POLLEN pinned on a wall is captured, not wedged', b.state.kind === 'held', `state=${b.state.kind}`);
    }

    // ...AND IN A CORNER, taken square on, which is how a driver reaches one.
    {
      const f = bbFootprint(BB_DEFAULT_SPEC);
      const { w, r } = staged(42, BB_HALF_X - f.front - 16, BB_HALF_Y - f.half);
      void r;
      // AN EMPTY FIELD: the run-up along the wall crosses the staged loading-zone POLLEN, and at
      // the 2026-09-20 cadence the roller eats four of them in 0.43 s and arrives at the corner
      // with a FULL hopper — which is a hopper cap, not a corner. The corner is what this asks.
      w.balls.length = 0;
      w.balls.push(bbPollen(nextId(w), BB_HALF_X - BB_POLLEN_R, BB_HALF_Y - BB_POLLEN_R));
      const b = w.balls[w.balls.length - 1];
      run(w, cmd({ driveY: 0.7, intake: true }), 3);
      check('roller: a POLLEN in a corner is captured square on', b.state.kind === 'held', `state=${b.state.kind}`);
    }

    // THE FUNNEL: an off-centre POLLEN is WALKED toward the throat before it is taken, and the
    // walk takes ticks — a stationary robot proves it is the rollers doing it and not the drive.
    {
      const { w, r } = staged(43, 0, -30);
      const m = bbMouths(r.spec)[0];
      const off = m.y1 * 0.9;
      w.balls.push(bbPollen(nextId(w), (m.x0 + m.x1) / 2, -30 + off));
      const b = w.balls[w.balls.length - 1];
      const y0 = b.pos.y;
      run(w, cmd({ intake: true }), 0.05); // three ticks: not enough to have arrived
      const movedIn = Math.abs(b.pos.y - (-30)) < Math.abs(y0 - (-30));
      const notYet = b.state.kind === 'ground';
      run(w, cmd({ intake: true }), 0.6);
      check(
        'roller: an off-centre POLLEN is funnelled inboard before it is swallowed (not teleported)',
        movedIn && notYet && b.state.kind === 'held',
        `movedIn=${movedIn} afterThreeTicks=${notYet ? 'ground' : 'held'} end=${b.state.kind}`,
      );
    }

    // A FULL HOPPER DOES NOT PULL — it pushes. The element stays on the floor and is bulldozed.
    {
      const { w, r } = staged(44, -40, -30);
      give(w, r, ['yellow', 'yellow', 'yellow', 'yellow']);
      const m = bbMouths(r.spec)[0];
      w.balls.push(bbPollen(nextId(w), -40 + (m.x0 + m.x1) / 2, -30));
      const b = w.balls[w.balls.length - 1];
      const x0 = b.pos.x;
      run(w, cmd({ driveY: 0.6, intake: true }), 1.5);
      check(
        'roller: a FULL hopper refuses — the POLLEN is not pulled in, it is pushed',
        r.hopper.length === bbHopperCap(r.spec) && b.state.kind === 'ground' && b.pos.x - x0 > 4,
        `hopper=${r.hopper.length} state=${b.state.kind} pushed=${(b.pos.x - x0).toFixed(1)}in`,
      );
    }

    // ── THE SIDE OF THE INTAKE IS AN OBSTACLE, NOT A MOUTH (owner item 7, 2026-09-19) ────────
    /**
     * "If the side of the intake comes in contact with a pollen very gently, then a very weird
     * behavior happens where the pollen and the robot are stuck together and the robot turns by
     * itself."
     *
     * The grip's lateral window used to be `half + er`, so an element whose CENTRE was up to one
     * radius OUTBOARD of the roller's end — on the far side of the side plate `bbRobotSolids`
     * makes solid — was gripped anyway and commanded 50.4 in/s straight INTO that plate, every
     * tick, forever.
     *
     * ⚠️ THIS IS THE PARITY TWIN, NOT THE FALSIFYING ONE. In 2D a ground element cannot push a
     * robot at all — there is no pin half of the round loop here (`play.ts`'s own header) — so
     * the yaw never appeared in this pipeline and this block PASSED on the broken code too. The
     * check that goes red on a revert is the SIM3D lane's, where the element is a real body and
     * the drift measured 0.335 rad. This one is kept so the two pipelines cannot answer the same
     * scene differently later, which is the whole reason `bbIntakeAct` is one function.
     *
     * The sweep is over the whole outboard band an element can rest in, because the failure was
     * at every offset in it, not at one.
     */
    for (const frac of [0.3, 0.6, 0.9] as const) {
      const { w, r } = staged(48, 0, -30);
      const m = bbMouths(r.spec)[0];
      const reach = bbIntakeReach(r.spec);
      // beside the side plate, level with the middle of the reach band
      const b = bbPollen(nextId(w), r.spec.length / 2 + reach / 2, -30 + m.y1 + BB_POLLEN_R * frac);
      w.balls.push(b);
      const h0 = r.heading;
      let worstDrift = 0;
      for (let t = 0; t < 400; t++) {
        tick(w, cmd({ intake: true }));
        worstDrift = Math.max(worstDrift, Math.abs(wrapAngle(r.heading - h0)));
      }
      const stuck = b.state.kind !== 'ground';
      // ...and it SEPARATES when the robot leaves: a gripped element used to be dragged along.
      run(w, cmd({ driveY: -0.5 }), 1.5);
      const sep = Math.hypot(b.pos.x - r.pos.x, b.pos.y - r.pos.y);
      check(
        `roller: a POLLEN resting against the intake's SIDE PLATE (+${frac}r outboard) is not gripped, and the robot does not turn`,
        !stuck && worstDrift < 0.01 && sep > 40,
        `state=${b.state.kind} drift=${worstDrift.toFixed(5)}rad separation=${sep.toFixed(1)}in`,
      );
    }

    // NOTHING IS TAKEN THROUGH THE SIDES OR THE BACK of a front-only intake, however long it runs.
    {
      const { w, r } = staged(45, 0, -30);
      const hl = r.spec.length / 2;
      const hw = r.spec.width / 2;
      const beside = bbPollen(nextId(w), 0, -30 + hw + BB_POLLEN_R + 1);
      w.balls.push(beside);
      const behind = bbPollen(nextId(w), -(hl + BB_POLLEN_R + 1), -30);
      w.balls.push(behind);
      run(w, cmd({ intake: true }), 2);
      check(
        'roller: a front-only intake never takes a POLLEN beside or behind the chassis',
        beside.state.kind === 'ground' && behind.state.kind === 'ground' && heldCount(w, r) === 0,
        `beside=${beside.state.kind} behind=${behind.state.kind} held=${heldCount(w, r)}`,
      );
    }

    // THROUGHPUT: a wide bar feeds two lanes side by side, and it is still a CADENCE — four
    // POLLEN across the throat are not swallowed on one tick the way the rect test swallowed them.
    // The budget is DERIVED from `BB_INTAKE_PERIOD_MAX` (worst case, one lane, sequential) rather
    // than a literal, so a future re-tune of the constant moves this bound with it instead of
    // leaving a stale number a halving can silently outrun.
    {
      const { w, r } = staged(46, 0, -30);
      const hl = r.spec.length / 2;
      for (const y of [-6, -2, 2, 6]) w.balls.push(bbPollen(nextId(w), hl + 1, -30 + y));
      run(w, cmd({ intake: true }), 1 / 60);
      const firstTick = heldCount(w, r);
      const budget = 4 * BB_INTAKE_PERIOD_MAX * 1.25; // 25% margin, same ratio the old fixed bound kept
      run(w, cmd({ intake: true }), budget);
      check(
        `roller: four POLLEN across the throat feed a lane at a time, and all four are in within ${budget.toFixed(2)}s (4 * BB_INTAKE_PERIOD_MAX * 1.25)`,
        firstTick <= 2 && heldCount(w, r) === 4,
        `tick1=${firstTick} end=${heldCount(w, r)} budget=${budget.toFixed(3)}`,
      );
    }

    // A POLLEN CROSSING THE ROLLERS AT SPEED IS NOT GRIPPED — the rect test took it instantly.
    // WAS run for 0.25 s. Measured: this fast POLLEN hits the mouth's own solid geometry around
    // tick 8 (~0.13 s) and the COLLISION, not the intake, kills most of its speed — after that it
    // is a legitimately slow ball near the mouth and the funnel is right to take it (that part
    // used to complete after 0.25 s under the old, slower `BB_INTAKE_DRAW_IN`; the faster draw-in
    // now reaches the seat before 0.25 s is up). Shortened to 0.1 s (6 ticks, safely before the
    // bounce) so this asserts what its name says — REJECTED WHILE STILL CROSSING FAST — instead
    // of depending on how many ticks an unrelated collision takes to settle it.
    {
      const { w, r } = staged(47, 0, -30);
      const m = bbMouths(r.spec)[0];
      const fast = bbPollen(nextId(w), (m.x0 + m.x1) / 2, -30 - 6);
      fast.vel = { x: 0, y: BB_INTAKE_CROSS_MAX + 40 };
      w.balls.push(fast);
      run(w, cmd({ intake: true }), 0.1);
      check(
        'roller: a POLLEN crossing the mouth faster than BB_INTAKE_CROSS_MAX is not gripped',
        fast.state.kind === 'ground',
        `state=${fast.state.kind}`,
      );
    }

    // ── TWO HARD CEILINGS, ASSERTED AS ARITHMETIC (OWNER BUG 11) ──────────────
    // Both must hold with the CONSTANTS as they stand, not just at review time — a future bump
    // to either side of either inequality should fail HERE, not surface as a 2D/3D divergence
    // or a self-tripping funnel weeks later.
    {
      // ceiling 1: the roller's draw-in speed must stay under `C.BALL_MAX_SPEED` (90), the
      // 2D-only ground-ball clamp (`clampBallPosToStatics`'s sibling speed clamp). 3D has no
      // equivalent ceiling, so a `BB_INTAKE_DRAW_IN` at or above 90 would clip in 2D only and
      // the two backends would disagree on where a captured element's target speed lands.
      check(
        'roller ceiling 1: BB_INTAKE_DRAW_IN stays under C.BALL_MAX_SPEED (2D-only clamp)',
        BB_INTAKE_DRAW_IN < C.BALL_MAX_SPEED,
        `BB_INTAKE_DRAW_IN=${BB_INTAKE_DRAW_IN} BALL_MAX_SPEED=${C.BALL_MAX_SPEED}`,
      );
      // ceiling 2: the CENTRING term (`wv`'s magnitude) must stay under `BB_INTAKE_CROSS_MAX`,
      // or the funnel's own lateral pull trips its own cross-speed rejection on the next tick —
      // the exact self-trip bug documented at the `wv`/`wu` split above (measured once: 0/1
      // captured, 66 in of plow on a POLLEN 0.7 in off the throat).
      const centring = BB_INTAKE_DRAW_IN * BB_INTAKE_CENTRE_FRAC;
      check(
        'roller ceiling 2: BB_INTAKE_DRAW_IN * BB_INTAKE_CENTRE_FRAC stays under BB_INTAKE_CROSS_MAX',
        centring < BB_INTAKE_CROSS_MAX,
        `centring=${centring} BB_INTAKE_CROSS_MAX=${BB_INTAKE_CROSS_MAX}`,
      );
    }

    // ── THE UNITS-BUG REGRESSION (OWNER BUG 11) ───────────────────────────────
    // `approach()`'s `maxDelta` used to BE `BB_INTAKE_DRAW_IN` itself — a SPEED passed as a
    // per-TICK displacement cap, i.e. an effective 52 in/s ÷ (1/60 s) = 3120 in/s² of
    // acceleration, reaching full draw-in speed from rest in exactly one tick (an instant
    // teleport, not a grip). It is now `BB_INTAKE_GRIP_ACCEL * dt`. This is the regression test
    // for that units bug: an element pulled from REST must NOT already be at (or near)
    // `BB_INTAKE_DRAW_IN` after a single tick — it has to still be ramping.
    {
      const { w, r } = staged(48, 0, -30);
      const m = bbMouths(r.spec)[0];
      // off-centre and short of the seat, so the pull is live but nothing has arrived yet —
      // same positioning family as "THE FUNNEL" check above.
      w.balls.push(bbPollen(nextId(w), (m.x0 + m.x1) / 2, -30 + m.y1 * 0.5));
      const b = w.balls[w.balls.length - 1];
      run(w, cmd({ intake: true }), 1 / 60); // exactly one tick
      const speed = hyp(b.vel.x, b.vel.y);
      const oneTickMax = BB_INTAKE_GRIP_ACCEL * C.SIM_DT + 1e-6;
      check(
        'roller: an element pulled from rest ramps over >1 tick, not an instant BB_INTAKE_DRAW_IN teleport',
        speed > 0 && speed <= oneTickMax && speed < BB_INTAKE_DRAW_IN,
        `speed=${speed.toFixed(3)} oneTickMax=${oneTickMax.toFixed(3)} BB_INTAKE_DRAW_IN=${BB_INTAKE_DRAW_IN}`,
      );
    }

    // ── CADENCE, MEASURED (OWNER BUG 11: "cadence is really, really slow") ────
    // A robot driving full-stick over a dense line of POLLEN, at least `CADENCE_FLOOR`
    // elements/s. The hopper is drained every tick (the held ball spliced straight back out,
    // `r.hopper.length` reset to 0) so the fixed 4-element `BB_STORAGE_MAX` cap cannot mask the
    // intake MECHANISM's own throughput — `bbHopperCap` clamps any requested `ballStorage` to
    // that cap regardless of value, so a bigger `ballStorage` cannot do this the way the
    // diagnosis's own scratch measurement did; draining is the equivalent for this suite.
    //
    // `CADENCE_FLOOR` is DERIVED from `BB_INTAKE_PERIOD_MAX` rather than a literal, so a future
    // re-tune of the constant moves the floor with it instead of leaving a stale number behind (a
    // halving of `BB_INTAKE_PERIOD_MAX` that this floor did not follow would silently pass at a
    // rate the mechanism no longer needs to clear). `1 / BB_INTAKE_PERIOD_MAX` is the worst-case
    // PERIOD's own rate (lateral edge or wall grab, no closing bonus) on its own; driving
    // full-stick adds the closing bonus (`BB_INTAKE_CLOSE_BONUS`) on most of the line, and
    // `BB_DEFAULT_SPEC` is a single-lane intake (`BB_INTAKE_LANE_W` unchanged at 9), so a 0.6x
    // factor is a floor with margin below the measured rate, not the measured rate itself — the
    // number a future regression on either constant should trip, not a tight fit to today's build.
    {
      const CADENCE_FLOOR = (1 / BB_INTAKE_PERIOD_MAX) * 0.6;
      const DURATION = 2;
      const { w, r } = staged(50, -BB_HALF_X + 6, -60, 0);
      // a dense line of POLLEN every 1.5 in along the drive direction (a robot at full stick
      // covers roughly 60-70 in in 2 s, so 90+ elements is more supply than the run can reach).
      for (let i = 0; i < 100; i++) w.balls.push(bbPollen(nextId(w), -BB_HALF_X + 6 + i * 1.5, -60));
      // driveY, not driveX: robot-centric stick-up is local +x (`sim/robot.ts`'s `robotVec.x =
      // stick.y`), and heading 0 makes local +x world +x — the same axis the line of POLLEN
      // and the front mouth both sit on.
      const commands = new Map([[0, cmd({ driveY: 1, intake: true })]]);
      let captured = 0;
      const ticks = Math.round(DURATION / C.SIM_DT);
      for (let i = 0; i < ticks; i++) {
        biobuzzStep(w, C.SIM_DT, commands);
        if (r.hopper.length > 0) {
          captured += r.hopper.length;
          for (let bi = w.balls.length - 1; bi >= 0; bi--) {
            const bl = w.balls[bi];
            if (bl.state.kind === 'held' && bl.state.robot === r.id) w.balls.splice(bi, 1);
          }
          r.hopper.length = 0;
        }
      }
      const rate = captured / DURATION;
      check(
        `roller: driving over a line of POLLEN captures at least ${CADENCE_FLOOR}/s (hopper drained to isolate cadence)`,
        rate >= CADENCE_FLOOR,
        `captured=${captured} over ${DURATION}s = ${rate.toFixed(2)}/s, floor=${CADENCE_FLOOR}/s`,
      );
    }
  }

  /**
   * THE HUD SAYS WHAT IS HELD, not just how much: after a MIXED intake through the world, the HUD
   * slice's `held` is the robot's hopper colours in hopper order (first captured first, next out
   * last) — and a copy, so a HUD reader cannot reach into the sim.
   */
  {
    const w = mkWorld('free', 32, mech({ launcher: { kind: 'dumper', mount: 'back', hoodDeg: 75 }, lift: null }, { intakeMount: 'front' }));
    const r = w.robots[0];
    emptyHopper(w, r);
    park(r, 0, 0, 0);
    r.autoIntake = false;
    r.autoFire = false;
    const m = bbMouths(r.spec)[0];
    for (const colour of ['yellow', r.alliance] as const) {
      w.balls.push({ ...bbPollen(nextId(w), (m.x0 + m.x1) / 2, 0), color: colour });
      run(w, cmd({ intake: true }), 0.35); // one feed cadence per element — see the note above

    }
    const hud = biobuzzHud(w, r.id).robot;
    check('hud: held lists both elements of a mixed intake, in hopper order', r.hopper.join(',') === `yellow,${r.alliance}` && hud?.held.join(',') === r.hopper.join(','), `hopper=${r.hopper.join(',')} held=${hud?.held.join(',')}`);
    check('hud: held is a copy of the hopper, not the sim array', !!hud && hud.held !== r.hopper && hud.hopper === hud.held.length);
  }

  // ── RELEASE SYNC: THE HOPPER AND THE HELD SET ARE ONE MULTISET ───────────
  /**
   * The old release freed the held ball with the HIGHEST ARRAY INDEX while popping the hopper's
   * LAST COLOUR. Staged here is the exact layout that disagreed: a NECTAR captured FIRST but
   * sitting at a HIGHER index than a POLLEN captured after it.
   *
   * ⚠️ IT ALSO USED TO PROVE THAT ONLY *ONE* OF THE TWO LEFT, and that was the owner's item 5
   * ("double turret shooter should start shooting pollen and nectar at the same time"). Both
   * leave on one beat now, so the index-order guard is made by WHICH MUZZLE each came out of
   * instead: a swap would have put the POLLEN on the NECTAR turret's ring.
   */
  {
    const w = mkWorld('free', 37, mech({ launcher: TWIN, lift: null }));
    const r = w.robots[0];
    emptyHopper(w, r);
    park(r, 40, 50, Math.PI);
    const id = nextId(w);
    const p = bbPollen(id, r.pos.x, r.pos.y);
    const n: Artifact = { ...bbPollen(id + 1, r.pos.x, r.pos.y), color: 'blue' };
    w.balls.push(p, n); // POLLEN at the lower index
    capturePollen(w, r, n); // ...captured second-to-last
    capturePollen(w, r, p);
    if (w.biobuzz) w.biobuzz.nextBallId = id + 2;
    check('release sync: staged NECTAR under POLLEN', r.hopper.join(',') === 'blue,yellow', r.hopper.join(','));
    run(w, cmd({}), 1.5); // let both turrets settle, so Aim Assist lets the first held fire go
    r.fireReadyAt = w.time;
    tick(w, cmd({ fire: true }));
    check(
      'release sync: a DOUBLE turret sends the POLLEN and the NECTAR out on the SAME tick',
      p.state.kind === 'flight' && n.state.kind === 'flight',
      `pollen=${p.state.kind} nectar=${n.state.kind}`,
    );
    // ...AND EACH OUT OF ITS OWN RING. `bbLaunch` fires before the flight stage of the NEXT tick,
    // so a just-released element sits exactly on the muzzle it left. Turret 0 is `mount`, turret
    // 1 is `mount2` — 10+ in apart on this chassis — so a mis-fed release is unmissable here.
    const m0 = bbTurretRelease(r, 0, 0).origin;
    const m1 = bbTurretRelease(r, 1, 0).origin;
    const at = (b: Artifact, o: Vec2): number => hyp(b.pos.x - o.x, b.pos.y - o.y);
    check(
      'release sync: the POLLEN leaves turret 0 and the NECTAR leaves turret 1',
      at(p, m0) < 0.01 && at(n, m1) < 0.01 && hyp(m0.x - m1.x, m0.y - m1.y) > 4,
      `pollen ${at(p, m0).toFixed(3)} from turret 0 · nectar ${at(n, m1).toFixed(3)} from turret 1 · rings ${hyp(m0.x - m1.x, m0.y - m1.y).toFixed(1)}in apart`,
    );
    check('release sync: ...and the hopper still matches what is held', r.hopper.length === 0 && hopperColours(r) === heldColours(w, r), `${hopperColours(r)} vs ${heldColours(w, r)}`);
    const before = r.hopper.length;
    check('takeHeld: asking for a colour the hopper does not have changes nothing', takeHeld(w, r, 'red') === null && r.hopper.length === before);
  }
  /** per TICK, over a mixed intake + fire run: hopper colours == held colours, always. */
  {
    const w = mkWorld('free', 41, mech({ launcher: TWIN, lift: null }, { intakeMount: 'front' }));
    const r = w.robots[0];
    emptyHopper(w, r);
    park(r, -20, 40, 0);
    r.autoIntake = false;
    let id = nextId(w);
    for (let k = 0; k < 8; k++) w.balls.push({ ...bbPollen(id++, -8 + k * 5, 40), color: k % 2 ? 'blue' : 'yellow' });
    if (w.biobuzz) w.biobuzz.nextBallId = id;
    let mismatches = 0;
    let firstBad = '';
    let sawN = false;
    let sawP = false;
    const flew = new Set<number>();
    for (let t = 0; t < 240; t++) {
      tick(w, cmd({ driveY: 0.35, intake: true, fire: t % 30 > 20 }));
      if (hopperColours(r) !== heldColours(w, r)) {
        mismatches++;
        if (!firstBad) firstBad = `t${t}: ${hopperColours(r)} vs ${heldColours(w, r)}`;
      }
      if (r.hopper.includes('blue')) sawN = true;
      if (r.hopper.includes('yellow')) sawP = true;
      for (const b of w.balls) if (b.state.kind === 'flight') flew.add(b.id);
    }
    check('release sync: hopper colours == held colours on EVERY tick of a mixed intake+fire run', mismatches === 0, firstBad);
    check('release sync: ...not vacuously — both kinds were carried and some were fired', sawN && sawP && flew.size > 0, `nectar=${sawN} pollen=${sawP} fired=${flew.size}`);
  }

  // ── THE DUMPER SCORES IN ITS OWN CELL ─────────────────────────────────────
  /**
   * A parked DEFAULT dumper, squarely in front of its own up-CELL on the open side with its back
   * toward the wall, holding fire with aim assist on: its load goes INTO the cell. This is the
   * owner's "the dumper must reach the HIVE", end to end — the band, the converging throws,
   * `hiveAccepts`' descending-and-inboard rule, all through the real tick.
   */
  /** `edge` is how far the dumper's FRONT EDGE (where it releases) stands from the cell centre */
  const dumperWorld = (seed: number, edge = 18): { w: World; r: RobotState; cellY: number } => {
    const w = mkWorld('free', seed, mech({ launcher: { kind: 'dumper', mount: 'front', hoodDeg: BB_HOOD_DEFAULT_DEG }, lift: null }, { intakeMount: 'back' }));
    const r = w.robots[0];
    r.aimAssist = true;
    r.autoFire = false;
    const cell = scoreTargets(w, 'blue').find((t) => t.id === 'hive:blue')!;
    park(r, cell.pos.x, cell.pos.y + edge + r.spec.length / 2, -Math.PI / 2);
    return { w, r, cellY: cell.pos.y };
  };
  /**
   * CLOSE IN it scores, and PAST THE CAP a held fire does nothing (Aim Assist: it would not land).
   *
   * ⚠️ "CLOSE IN" IS 8 IN, NOT 6, AND THE SIX-INCH CASE IS NOW ITS OWN CHECK. The CAD ruling
   * (2026-09-18) put the down cell's underside at `BB_HIVE_BOTTOM_Z` 31.98 instead of the
   * manual's 25.5 — 6.5 in higher — and a dumper standing 6 in off the cell centre throws an
   * almost vertical lob that is still BELOW that underside when it crosses into the hive's plan
   * footprint. It gets deflected back down (`hiveDeflect`'s underside rule) and peaks at 31.97.
   * At 8 in the arc is shallow enough to enter over the structure and reach the 65.1 apex.
   *
   * That is a real consequence of the taller hive, not a regression: standing right under the
   * overhang and throwing straight up has always been a bad shot, and the field just said how
   * bad. Both facts are asserted so a future change to either the hive height or the lob has to
   * account for both ends of the band.
   */
  {
    const run2 = (edge: number): { scored: number; load: number; hopper: number } => {
      const { w, r } = dumperWorld(59, edge);
      const load = w.balls.filter((b) => b.state.kind === 'held' && b.state.robot === r.id).map((b) => b.id);
      const entered = new Set<number>();
      for (let t = 0; t < 120; t++) {
        tick(w, cmd({ fire: true }));
        for (const b of w.balls) if (b.state.kind === 'element' && b.state.el === 'hive:blue') entered.add(b.id);
      }
      return { scored: load.filter((id) => entered.has(id)).length, load: load.length, hopper: r.hopper.length };
    };
    const close = run2(8);
    check('dump range: 8 in from the cell a held fire dumps the whole load IN', close.scored === close.load && close.load > 0, JSON.stringify(close));
    const under = run2(6);
    check(
      "dump range: at 6 in the lob is too steep and clips the down cell's underside — nothing scores, and the load is gone from the hopper",
      under.scored === 0 && under.hopper === 0 && under.load > 0,
      JSON.stringify(under),
    );
    const far = run2(BB_DUMP_MAX_DIST + 8);
    check('dump range: past the cap a held fire dumps nothing', far.hopper === far.load && far.scored === 0, JSON.stringify(far));
  }
  {
    const { w, r } = dumperWorld(53);
    const cell = bbAimTarget(w, r);
    const load = w.balls.filter((b) => b.state.kind === 'held' && b.state.robot === r.id).map((b) => b.id);
    check('dump: the test robot has a load and a target', load.length > 0 && cell?.id === 'hive:blue', `load=${load.length} target=${cell?.id}`);
    if (cell) {
      check('dump: the parked default dumper is inside the accepted band', bbDumpSolution(r, cell, r.hopper.length) !== null);
      check('dump: ...and lined up within the aim tolerance', Math.abs(wrapAngle((bbAimHeading(r, cell) ?? 99) - r.heading)) < BB_AIM_TOL);
    }
    const contents0 = w.biobuzz!.hives.blue.contents.length;
    const entered = new Set<number>();
    let peak = contents0;
    for (let t = 0; t < 90; t++) {
      tick(w, cmd({ fire: true }));
      peak = Math.max(peak, w.biobuzz!.hives.blue.contents.length);
      for (const b of w.balls) if (b.state.kind === 'element' && b.state.el === 'hive:blue') entered.add(b.id);
    }
    const scored = load.filter((id) => entered.has(id)).length;
    check('dump: a parked default dumper holding fire puts elements into its own up-CELL', peak > contents0 && scored > 0, `contents ${contents0}→peak ${peak}, ${scored}/${load.length} of the load entered`);
    check('dump: ...the WHOLE load goes in (the throws converge on the cell)', scored === load.length, `${scored}/${load.length}`);
  }
  /** THE AIM GATE: a dumper off its aim holds the dump until the assist has turned it on. */
  {
    const { w, r } = dumperWorld(55);
    r.heading += 0.6;
    const n0 = r.hopper.length;
    tick(w, cmd({ fire: true }));
    check('dump: an UNALIGNED dumper holds its load on the first tick of fire', r.hopper.length === n0, `hopper ${n0}→${r.hopper.length}`);
    run(w, cmd({ fire: true }), 2.5);
    check('dump: ...the aim assist steers it on target and then it dumps', r.hopper.length === 0, `hopper=${r.hopper.length} heading err=${wrapAngle(r.heading + Math.PI / 2).toFixed(3)}`);
  }
  /**
   * HOLD FIRE AND A DUMPER TURNS ALL THE WAY ONTO THE CELL, THEN DUMPS INTO IT — Chain Reaction's
   * dumper feel — FOR A TANK TOO. The StarterBot is a tank dumper, and a tank's yaw comes only from
   * its side drives (`src/sim/robot.ts`), so an aim hook that overrode `rotate` alone never turned
   * it. Each robot starts facing directly AWAY from the cell, at a distance its own hood can dump
   * from (found by `bbDumpSolution`, not hard-coded, so a retuned hood does not break the check).
   */
  for (const [label, spec] of [
    ['default dumper', mech({ launcher: { kind: 'dumper', mount: 'front', hoodDeg: BB_HOOD_DEFAULT_DEG }, lift: null }, { intakeMount: 'back' })],
    ['StarterBot (tank)', BB_STARTER_BOTS[0]],
  ] as const) {
    const w = createBiobuzzWorld('free', 57, [{ ...setup(0, 'blue', spec), assists: { ...DEFAULT_ASSISTS, fieldCentric: false } }]);
    const r = w.robots[0];
    const edge = bbLauncherOf(r.spec, BB_HOOD_DEFAULT_DEG);
    check(`dump turn [${label}]: (scene) the build is a dumper`, edge.kind === 'dumper', edge.kind);
    const cell = hiveCellTarget('blue', 'north');
    let placed = false;
    for (let dy = 20; dy <= 90 && !placed; dy += 1) {
      park(r, cell.pos.x, cell.pos.y + dy, 0);
      r.heading = bbAimHeading(r, cell) ?? 0;
      placed = bbDumpSolution(r, cell, r.hopper.length) !== null;
    }
    check(`dump turn [${label}]: (scene) there is a distance its hood dumps from`, placed, `y=${r.pos.y.toFixed(1)}`);
    const want = r.heading;
    r.heading = wrapAngle(want + Math.PI); // facing directly AWAY
    const load = w.balls.filter((b) => b.state.kind === 'held' && b.state.robot === r.id).map((b) => b.id);
    tick(w, cmd({ fire: true }));
    check(`dump turn [${label}]: facing away, the first tick of fire dumps nothing`, r.hopper.length === load.length && load.length > 0, `hopper=${r.hopper.length}/${load.length}`);
    const entered = new Set<number>();
    let minErr = Math.PI;
    for (let t = 0; t < Math.round(6 / C.SIM_DT); t++) {
      tick(w, cmd({ fire: true }));
      minErr = Math.min(minErr, Math.abs(wrapAngle(r.heading - want)));
      for (const b of w.balls) if (b.state.kind === 'element' && b.state.el === 'hive:blue') entered.add(b.id);
    }
    const scored = load.filter((id) => entered.has(id)).length;
    check(`dump turn [${label}]: holding fire TURNS the chassis onto the cell`, minErr < BB_AIM_TOL, `closest heading error ${minErr.toFixed(3)} rad`);
    check(`dump turn [${label}]: ...and then it dumps, into the cell`, r.hopper.length === 0 && scored > 0, `hopper=${r.hopper.length} scored ${scored}/${load.length}`);
  }
  /**
   * RE-ARM: a held fire does not re-dump the moment something is back in the hopper. The
   * element is given INSIDE the reload window — on the tick right after the dump — because a
   * re-dump after the window has passed is correct, and a check that gives it later cannot fail.
   */
  {
    const { w, r } = dumperWorld(57);
    let dumpedAt = -1;
    for (let t = 0; t < 30 && dumpedAt < 0; t++) {
      tick(w, cmd({ fire: true }));
      if (r.hopper.length === 0) dumpedAt = w.time;
    }
    check('dump [re-arm]: the aligned dumper dumps on a held fire', dumpedAt >= 0, `hopper=${r.hopper.length}`);
    give(w, r, ['yellow']);
    tick(w, cmd({ fire: true }));
    check('dump [re-arm]: an element captured inside the reload window is NOT dumped yet', r.hopper.length === 1 && r.fireReadyAt > w.time, `hopper=${r.hopper.length} readyAt=${r.fireReadyAt.toFixed(3)} now=${w.time.toFixed(3)}`);
    run(w, cmd({ fire: true }), BB_DUMP_RELOAD_S + 0.2);
    check('dump [re-arm]: ...and once the tray has re-armed, the held fire dumps it', r.hopper.length === 0, `hopper=${r.hopper.length}`);
  }

  // ── NOTHING LAUNCHED ENTERS A FLOWER ──────────────────────────────────────
  {
    const w = mkWorld('free', 59);
    park(w.robots[0], 0, 0, 0);
    const f = BB_FLOWERS[2];
    const bb = w.biobuzz!;
    const before = JSON.stringify(bb.flowers[2].stack);
    const b = bbPollen(nextId(w), f.x, f.y);
    b.state = { kind: 'flight', target: 'blue' };
    b.z = BB_FLOWER_TOP_Z + 1;
    b.vz = -20;
    w.balls.push(b);
    let entered = false;
    for (let t = 0; t < 60; t++) {
      tick(w, cmd({}));
      if (b.state.kind === 'element') entered = true;
    }
    check('flower: a POLLEN descending onto a FLOWER ring through the tick does NOT enter it', !entered && JSON.stringify(bb.flowers[2].stack) === before, `state=${b.state.kind}`);
    // F3 stands on the +x wall: its foot is x ∈ [72 − deep, 72], y ∈ 24 ± along/2
    const footX = 72 - BB_FLOWER_FOOT.deep;
    const inside = b.pos.x > footX - BB_POLLEN_R + 0.1 && Math.abs(b.pos.y - f.y) < BB_FLOWER_FOOT.along / 2 + BB_POLLEN_R - 0.1;
    check('flower: ...it lands on the tiles CLEAR of the FLOWER foot (the landing push-out)', b.state.kind === 'ground' && !inside, `pos=${b.pos.x.toFixed(2)},${b.pos.y.toFixed(2)}`);
  }

  // ── THE BOX TUBE PLACES ───────────────────────────────────────────────────
  /** a blue DUMPER-at-the-back robot with a FRONT Box Tube (no front sweeper), assists off */
  const tubeWorld = (seed: number, tube = true, mode: 'free' | 'match' = 'free'): { w: World; r: RobotState } => {
    const w = mkWorld(mode, seed, mech({ launcher: { kind: 'dumper', mount: 'back', hoodDeg: 75 }, lift: tube ? { kind: 'vslide', mount: 'front' } : null }, { intakeMount: 'back' }));
    const r = w.robots[0];
    r.autoFire = false;
    r.autoIntake = false;
    return { w, r };
  };
  const F3 = 2; // BB_FLOWERS index of F3, on the +x wall at y = 24
  const flush = (r: RobotState): void => park(r, 72 - BB_FLOWER_FOOT.deep - r.spec.length / 2 - 0.2, BB_FLOWERS[F3].y, 0);
  /** REACH IS REACHABLE: drive square into the FLOWER and the placement point arrives on the ring. */
  {
    const { w, r } = tubeWorld(61);
    park(r, 72 - BB_FLOWER_FOOT.deep - r.spec.length / 2 - 6, BB_FLOWERS[F3].y, 0);
    check('box tube: out of reach before driving in', bbFlowerInReach(w, r) === null);
    run(w, cmd({ driveY: 0.5 }), 1.5);
    const p = bbPlacePoint(r)!;
    check('box tube: driving square into a FLOWER foot brings the placement point within reach', bbFlowerInReach(w, r) === F3, `point=${p.x.toFixed(2)},${p.y.toFixed(2)} ring=${BB_FLOWERS[F3].x},${BB_FLOWERS[F3].y}`);
    check('hud: flowerInReach reads true there', biobuzzHud(w, r.id).robot?.flowerInReach === true);
  }
  {
    const { w, r } = tubeWorld(63);
    const bb = w.biobuzz!;
    flush(r);
    emptyHopper(w, r);
    give(w, r, ['blue', 'yellow', 'yellow']);
    const stack = bb.flowers[F3].stack;
    const n0 = stack.length;
    const kindOf = kindOfIn(w);
    tick(w, cmd({ bbPlace: true }));
    check('place: one press puts one POLLEN into the FLOWER', stack.length === n0 + 1 && kindOf(stack[stack.length - 1]) === 'pollen' && r.hopper.join(',') === 'blue,yellow', `stack ${n0}→${stack.length} hopper=${r.hopper.join(',')}`);
    for (let t = 0; t < 30; t++) tick(w, cmd({ bbPlace: true }));
    check('place: HOLDING the button places once', stack.length === n0 + 1 && r.hopper.length === 2, `stack=${stack.length} hopper=${r.hopper.length}`);
    tick(w, cmd({}));
    tick(w, cmd({ bbPlaceNectar: true }));
    check('place: the NECTAR button places the held NECTAR', kindOf(stack[stack.length - 1]) === 'blue' && r.hopper.join(',') === 'yellow', `hopper=${r.hopper.join(',')}`);
    check('place: a placed NECTAR makes its alliance the FLOWER owner', flowerScore(stack, kindOf).owner === 'blue');
    check('place: the hopper matches the held set after placing', hopperColours(r) === heldColours(w, r));
    const top = w.balls.find((b) => b.id === stack[stack.length - 1])!;
    check('place: the element is PARKED in the flower and still in world.balls', top.state.kind === 'element' && top.state.el === `flower:${F3}`);
    const live = JSON.stringify({ f: bb.flowers.map((f) => f.stack), h: [bb.hives.red.contents, bb.hives.blue.contents] });
    bbIndexElements(w);
    const rebuilt = JSON.stringify({ f: bb.flowers.map((f) => f.stack), h: [bb.hives.red.contents, bb.hives.blue.contents] });
    check('place: bbIndexElements rebuilds exactly the live stacks after a placement', live === rebuilt, `${live} vs ${rebuilt}`);
    // The allowlist is EVERY owner of this per-robot map, across lanes: `placeP`/`placeN` are
    // this lane's, `g402billed`/`g407billed` the rules lane's per-MATCH latches, `nectarPress`
    // the field lane's HUMAN PLAYER latch (`play.ts` NECTAR_PRESS_KEY). A new key belongs here
    // the day it is written — the check exists to catch a latch stored under a name nobody else
    // knows about. `g417billed` was here too; G417 is REMOVED (owner ruling, 2026-09-19).
    check('place: the latch is namespaced and only TRUE keys are stored', Object.entries(bb.held[r.id] ?? {}).every(([k, v]) => v === true && (k === 'placeP' || k === 'placeN' || k === 'g402billed' || k === 'g407billed' || k === 'nectarPress')));
  }
  {
    const { w, r } = tubeWorld(65);
    park(r, 0, 0, 0);
    const before = JSON.stringify(w.biobuzz!.flowers.map((f) => f.stack));
    const n = r.hopper.length;
    tick(w, cmd({ bbPlace: true }));
    check('place: OUT OF REACH a press does nothing', JSON.stringify(w.biobuzz!.flowers.map((f) => f.stack)) === before && r.hopper.length === n);
    const none = tubeWorld(65, false);
    flush(none.r);
    const b2 = JSON.stringify(none.w.biobuzz!.flowers.map((f) => f.stack));
    const n2 = none.r.hopper.length;
    tick(none.w, cmd({ bbPlace: true }));
    check('place: WITHOUT a Box Tube a press at a FLOWER does nothing', bbFlowerInReach(none.w, none.r) === null && JSON.stringify(none.w.biobuzz!.flowers.map((f) => f.stack)) === b2 && none.r.hopper.length === n2);
  }
  /** a button HELD while driving into reach does not place — only a fresh press does */
  {
    const { w, r } = tubeWorld(71);
    park(r, 30, BB_FLOWERS[F3].y, 0);
    const stack = w.biobuzz!.flowers[F3].stack;
    const n0 = stack.length;
    for (let t = 0; t < 5; t++) tick(w, cmd({ bbPlace: true }));
    flush(r);
    for (let t = 0; t < 10; t++) tick(w, cmd({ bbPlace: true }));
    check('place: a button held from OUT of reach does not place on arriving in reach', stack.length === n0, `stack ${n0}→${stack.length}`);
    tick(w, cmd({}));
    tick(w, cmd({ bbPlace: true }));
    check('place: ...a fresh press there does', stack.length === n0 + 1, `stack ${n0}→${stack.length}`);
  }
  /** a FULL flower refuses, and the element stays held */
  {
    const { w, r } = tubeWorld(73);
    flush(r);
    const bb = w.biobuzz!;
    const f = bb.flowers[F3];
    const kindOf = kindOfIn(w);
    let id = nextId(w);
    while (flowerFits(f.stack, kindOf, BB_POLLEN_R)) {
      const b = bbPollen(id++, BB_FLOWERS[F3].x, BB_FLOWERS[F3].y);
      b.state = { kind: 'element', el: `flower:${F3}`, slot: f.stack.length };
      b.z = 10;
      w.balls.push(b);
      f.stack.push(b.id);
    }
    bb.nextBallId = id;
    const n = f.stack.length;
    const h = r.hopper.length;
    tick(w, cmd({ bbPlace: true }));
    check('place: a FULL flower refuses, and the element stays held', f.stack.length === n && r.hopper.length === h && h > 0, `stack=${f.stack.length} hopper=${r.hopper.length}`);
  }
  /** G410: a NECTAR placed before the 1:00 cue is a MAJOR to the opponent */
  {
    const { w, r } = tubeWorld(79, true, 'match');
    w.match.phase = 'teleop';
    w.match.phaseTimeLeft = 90;
    flush(r);
    emptyHopper(w, r);
    give(w, r, ['blue']);
    const red0 = w.match.scores.red.foulPoints;
    tick(w, cmd({ bbPlaceNectar: true }));
    tick(w, cmd({}));
    const placed = w.balls.some((b) => b.color === 'blue' && b.state.kind === 'element' && b.state.el === `flower:${F3}`);
    check('place: in a match, the NECTAR is placed', placed);
    check('place: a NECTAR placed before 1:00 bills G410 (one MAJOR to the opponent)', w.match.scores.red.foulPoints - red0 === BB_PTS.foulMajor, `red fouls ${red0}→${w.match.scores.red.foulPoints}`);
  }

  // ── AIM ASSIST: THE DRIVER FIRES, THE ASSIST ONLY LETS A LANDING SHOT GO ──
  /**
   * Owner, 2026-09-13: auto-fire is gone. It fired whenever the real up cell would take a shot and
   * stopped once the elements in the air would tip it — sensing no robot has. Aim Assist aims at
   * the NEARER own cell, pretends it is up, and releases a held fire only when the shot would land
   * there. Everything else is the real field's business.
   */
  {
    const AIM_TURRET = mech({ launcher: { kind: 'turret', mount: 'center', hoodDeg: 75 }, lift: null });
    /** step `secs` with fire held for the first `fireFor` seconds (and an optional steady feed),
     * then count what every launched element did once it came down. */
    const aimRun = (w: World, r: RobotState, secs: number, fireFor: number, feed = false): { fired: number; scored: number; missed: number } => {
      const flying = new Set<number>();
      let fired = 0;
      let scored = 0;
      let missed = 0;
      const n = Math.round(secs / C.SIM_DT);
      const nFire = Math.round(fireFor / C.SIM_DT);
      for (let i = 0; i < n; i++) {
        if (feed && i < nFire && r.hopper.length < bbHopperCap(r.spec)) give(w, r, ['yellow']);
        const before = new Set(w.balls.filter((b) => b.state.kind === 'flight').map((b) => b.id));
        tick(w, cmd({ fire: i < nFire }));
        for (const b of w.balls) {
          if (b.state.kind === 'flight' && !before.has(b.id)) {
            flying.add(b.id);
            fired++;
          }
        }
        for (const id of [...flying]) {
          const b = w.balls.find((q) => q.id === id)!;
          if (b.state.kind === 'flight') continue;
          flying.delete(id);
          if (b.state.kind === 'element' && b.state.el === `hive:${r.alliance}`) scored++;
          else missed++;
        }
      }
      return { fired, scored, missed };
    };
    {
      const w = createBiobuzzWorld('free', 83, [{ ...setup(0, 'blue', AIM_TURRET), assists: { ...DEFAULT_ASSISTS, autoFire: true } }]);
      const r = w.robots[0];
      check('aim assist: BIOBUZZ spawns with auto-fire OFF even when the assists ask for it', r.autoFire === false);
      r.autoFire = true; // and a flag forced on anyway does nothing
      park(r, 12, 50, Math.PI);
      const res = aimRun(w, r, 3, 0);
      check('aim assist: with fire NOT held, nothing is ever launched (no auto-fire)', res.fired === 0 && r.hopper.length === 4, `fired=${res.fired} hopper=${r.hopper.length}`);
    }
    {
      const w = mkWorld('free', 87, AIM_TURRET);
      const r = w.robots[0];
      park(r, 12, 50, Math.PI);
      emptyHopper(w, r);
      give(w, r, ['yellow']);
      const res = aimRun(w, r, 4, 2);
      check('aim assist: fire held on the up cell\'s open side releases the shot once it would land, and it scores', res.fired === 1 && res.scored === 1, JSON.stringify(res));
    }
    {
      const w = mkWorld('free', 89, AIM_TURRET);
      const r = w.robots[0];
      park(r, 12, 22, Math.PI); // too close under the cell for the barrel's pitch envelope
      const res = aimRun(w, r, 2, 2);
      check('aim assist: where no shot would land, a held fire releases nothing', res.fired === 0 && r.hopper.length === 4, JSON.stringify(res));
    }
    {
      // blue's NORTH cell is up; from y = −50 the nearer cell is the SOUTH one, which is DOWN
      const w = mkWorld('free', 91, AIM_TURRET);
      const r = w.robots[0];
      check('aim assist: (scene) blue\'s north cell is up', w.biobuzz!.hives.blue.up === 'north');
      park(r, 12, -50, Math.PI);
      run(w, cmd({}), 1.5);
      const down = hiveCellTarget('blue', 'south');
      const sol = bbTurretSolution(r, down)!;
      check('aim assist: from the down cell\'s side the turret settles on the DOWN cell', Math.abs(wrapAngle(r.turretHeading - sol.yaw)) < 0.03, `yaw=${r.turretHeading.toFixed(3)} want=${sol.yaw.toFixed(3)}`);
      const res = aimRun(w, r, 5, 2);
      check('aim assist: ...a held fire is released (it pretends that cell is up) and every shot MISSES', res.fired > 0 && res.scored === 0 && res.missed === res.fired, JSON.stringify(res));
    }
    {
      const w = mkWorld('free', 93, AIM_TURRET);
      const r = w.robots[0];
      park(r, 12, 50, Math.PI);
      run(w, cmd({}), 1.5);
      w.biobuzz!.hives.blue = { ...w.biobuzz!.hives.blue, tipping: 1.0, released: false };
      const res = aimRun(w, r, 0.5, 0.5);
      check('aim assist: it cannot sense a SWINGING HIVE — a held fire still goes', res.fired > 0, JSON.stringify(res));
    }
    {
      const w = mkWorld('free', 95, AIM_TURRET);
      const r = w.robots[0];
      park(r, 12, 45, Math.PI);
      const tips0 = w.biobuzz!.hives.blue.tips;
      const res = aimRun(w, r, 10, 6, true);
      const tips = w.biobuzz!.hives.blue.tips - tips0;
      check(
        'aim assist: on a steady feed it does NOT hold back for a tip it cannot sense — some shots reach a tipping cell and miss',
        res.scored > 0 && tips > 0 && res.missed > 0,
        `${JSON.stringify(res)} tips=${tips}`,
      );
    }
  }

  // ── INTAKE OFF A FLOWER (G418.B) ──────────────────────────────────────────
  /**
   * "only remove POLLEN from the bottom of a FLOWER": a running intake against a FLOWER foot's
   * field side pulls the BOTTOM POLLEN into the hopper, paced, never a NECTAR, and never from out
   * of position. Every FLOWER is staged with four POLLEN.
   *
   * ⚠️ ARCHETYPE-AWARE SINCE 2026-09-20 (owner: "intaking from the flower should now only be
   * done if it is physically possible") — the SWEEPER never reaches the opening at all; only
   * `siderollers` and a SETTLED `ramp` do. `flush`/`standoff` position the mouth's own outward
   * bound (`bbFootprint(spec).front`, the sweeper's collision footprint edge — the "tip line"
   * `bbFlowerAtIntake`'s own numbers are measured from, `BB_PLACE_REACH` further out from the
   * ring) rather than the bare chassis FRAME: the frame sits `bbIntakeReach` further BACK than
   * that, which is where a real robot's collision actually rests when driven flush, so measuring
   * from the frame instead once left the retrieval opening physically unreachable in real
   * gameplay (the TUTORIAL's "retrieve" step never completed — see `bbFlowerAtIntake`'s own
   * comment for the fix and the numbers). A fixed pose is held by RE-PARKING it every tick
   * rather than driving in, so a multi-tick check is not confounded by the robot solve's own
   * contact correction nudging the chassis off the tested standoff between ticks.
   */
  {
    const FR = 2; // F3, the +x wall at y = 24
    const f0 = BB_FLOWERS[FR];
    /** a blue robot with a `dumper` on the BACK (so the FRONT sweeper is free, no Box Tube),
     * the given INTAKE ARCHETYPE, assists off, hopper emptied. */
    const pullWorld = (seed: number, intake: BbIntakeKind): { w: World; r: RobotState } => {
      const w = mkWorld(
        'free',
        seed,
        mech({ launcher: { kind: 'dumper', mount: 'back', hoodDeg: 75 }, lift: null, intake: { kind: intake } }, { intakeMount: 'front' }),
      );
      const r = w.robots[0];
      r.autoFire = false;
      r.autoIntake = false;
      emptyHopper(w, r);
      // the spawn's preload captures stamp `lastIntakeAt` at t = 0; clear it so the pacing window
      // under test starts from the first pull, not from the staging
      r.lastIntakeAt = -10;
      return { w, r };
    };
    /** the mouth's own outward bound (the collision footprint edge) flush on the foot
     * (`standoff` further back); heading 0 faces F3, centred on the mouth's own centreline. */
    const flush = (r: RobotState, standoff = 0): void => park(r, f0.x - BB_PLACE_REACH - bbFootprint(r.spec).front - standoff, f0.y, 0);
    /**
     * ⚠️ SIDE ROLLERS ARE `edgeGrip`, NOT `half` (owner, 2026-09-20: "situated on the edges of the
     * robot, not near the center"). The pair is 12–17 in apart and cannot straddle a 2.8-in
     * POLLEN, so a centreline `flush()` pose no longer bites — the driver has to line up an END of
     * the intake instead: offset laterally by the wheel's own `bbSideRollerY(mouthHalf)` so ONE
     * wheel sits on the opening. `side` picks which wheel (either one grips identically by
     * symmetry).
     */
    const flushEdge = (r: RobotState, standoff = 0, side: 1 | -1 = 1): void => {
      const half = mouthAxes(bbMouths(r.spec)[0], r.spec.length / 2, r.spec.width / 2).half;
      const wy = bbSideRollerY(half);
      park(r, f0.x - BB_PLACE_REACH - bbFootprint(r.spec).front - standoff, f0.y - side * wy, 0);
    };
    /** hold a pose across several ticks — re-parking before each one, so the Rapier robot solve
     * (which does not know this chassis is "flush" by the archetype's own idealized convention,
     * only by its own collision footprint) cannot walk it off the tested standoff. */
    const holdTicks = (w: World, r: RobotState, standoff: number, c: RobotCommand, n: number): void => {
      for (let i = 0; i < n; i++) {
        flush(r, standoff);
        tick(w, c);
      }
    };
    /** the edge-offset twin of `holdTicks`, for the side-roller fixtures below. */
    const holdTicksEdge = (w: World, r: RobotState, standoff: number, c: RobotCommand, n: number): void => {
      for (let i = 0; i < n; i++) {
        flushEdge(r, standoff);
        tick(w, c);
      }
    };
    {
      const { w, r } = pullWorld(101, 'siderollers');
      const stack = w.biobuzz!.flowers[FR].stack;
      const before = [...stack];
      const n = w.balls.length;
      flushEdge(r);
      tick(w, cmd({}));
      check('flower intake: nothing comes out without the intake running', stack.length === before.length && r.hopper.length === 0, `stack=${stack.length} hopper=${r.hopper.length}`);
      flushEdge(r);
      tick(w, cmd({ intake: true }));
      const kids = w.balls.filter((b) => b.state.kind === 'element' && b.state.el === `flower:${FR}`);
      check(
        'flower intake: SIDE ROLLERS, one wheel lined up on the opening, pull the BOTTOM POLLEN into the hopper',
        r.hopper.join(',') === 'yellow' && stack.join(',') === before.slice(1).join(',') && w.balls.find((b) => b.id === before[0])?.state.kind === 'held',
        `hopper=${r.hopper.join(',')} stack ${before.join(',')}→${stack.join(',')}`,
      );
      check('flower intake: what is left is re-slotted bottom-first', stack.every((id, k) => kids.find((b) => b.id === id)?.state.kind === 'element' && (kids.find((b) => b.id === id)!.state as { slot: number }).slot === k));
      const copy = JSON.parse(JSON.stringify(w)) as World;
      bbIndexElements(copy);
      check('flower intake: the stack rebuilt off world.balls agrees with the live one', copy.biobuzz!.flowers[FR].stack.join(',') === stack.join(','), `${copy.biobuzz!.flowers[FR].stack.join(',')} vs ${stack.join(',')}`);
      const firstPullAt = r.lastIntakeAt;
      holdTicksEdge(w, r, 0, cmd({ intake: true }), Math.round((BB_FLOWER_RETRIEVE_S - C.SIM_DT) / C.SIM_DT));
      check('flower intake: SIDE ROLLERS are PACED at BB_FLOWER_RETRIEVE_S, not one a tick', r.hopper.length === 1, `hopper=${r.hopper.length} elapsed=${(w.time - firstPullAt).toFixed(3)} < ${BB_FLOWER_RETRIEVE_S}`);
      holdTicksEdge(w, r, 0, cmd({ intake: true }), Math.round(3 / C.SIM_DT));
      const want = Math.min(bbHopperCap(r.spec), before.length);
      check('flower intake: held on, it pulls until the hopper is full (or the POLLEN run out) and no further', r.hopper.length === want && stack.length === before.length - want, `hopper=${r.hopper.length} stack=${stack.length} want=${want}`);
      check('flower intake: nothing is created or destroyed', w.balls.length === n, `${n}→${w.balls.length}`);
    }
    {
      // ⚠️ REVERSED 2026-09-20: a SWEEPER's roller rides above the mid plate and never passes
      // the plate edge (`config.ts`'s opening header) — flush on the foot, held 3 s, it pulls
      // NOTHING, where every archetype used to pull the same way.
      const { w, r } = pullWorld(103, 'sweeper');
      const stack = w.biobuzz!.flowers[FR].stack;
      const n0 = stack.length;
      holdTicks(w, r, 0, cmd({ intake: true }), Math.round(3 / C.SIM_DT));
      check('flower intake: a SWEEPER flush on the foot, held 3 s, pulls NOTHING', stack.length === n0 && r.hopper.length === 0, `stack=${stack.length} hopper=${r.hopper.length}`);
    }
    {
      // ⚠️ EDGE-GRIP IS CONTACT NOW, NOT A BOX-BITE (owner, 2026-09-20: "it should also be
      // colliding with everything. It is a physical thing"). At `flushEdge` (one wheel's axis
      // exactly aligned on the opening, `v == wy`) the standoff tolerance is governed by the
      // CONTACT RADIUS (`BB_SIDE_ROLLER_GRIP` — `R + BB_POLLEN_R + BB_SIDE_ROLLER_CONTACT_TOL`)
      // against the wheel-to-POLLEN distance, which is `1.984 + standoff` at this pose (MEASURED:
      // the wheel's own `u` position past the tip line minus the POLLEN's, at `v` already dead on
      // the wheel's axis) — so the breakeven is `BB_SIDE_ROLLER_GRIP − 1.984` ≈ 1.27 in, a good
      // deal MORE forgiving than the old box-BITE's ≈0.42 in, because a solid wheel's contact
      // radius is a full 2D distance rather than an independent x-window. 1.6 in clears it with
      // margin (measured distance 3.584 in against a 3.25-in radius).
      const { w, r } = pullWorld(105, 'siderollers');
      const stack = w.biobuzz!.flowers[FR].stack;
      const n0 = stack.length;
      flushEdge(r, 1.6);
      tick(w, cmd({ intake: true }));
      check('flower intake: SIDE ROLLERS at 1.6 in standoff pull NOTHING (past the ≈1.27 in contact-radius tolerance)', stack.length === n0 && r.hopper.length === 0, `stack=${stack.length} hopper=${r.hopper.length}`);
    }
    {
      const { w, r } = pullWorld(107, 'siderollers');
      const stack = w.biobuzz!.flowers[FR].stack;
      const n0 = stack.length;
      flushEdge(r, 0.2);
      tick(w, cmd({ intake: true }));
      check('flower intake: SIDE ROLLERS at 0.2 in standoff DO pull', r.hopper.length === 1 && stack.length === n0 - 1, `hopper=${r.hopper.length} stack=${stack.length}`);
    }
    {
      // ⚠️ AND FLUSH ON THE CENTRELINE (the OLD pose) NO LONGER BITES — the pair cannot straddle
      // a 2.8-in ball, so a driver who does not line an end of the intake up on the opening pulls
      // nothing, however long the intake runs.
      const { w, r } = pullWorld(106, 'siderollers');
      const stack = w.biobuzz!.flowers[FR].stack;
      const n0 = stack.length;
      holdTicks(w, r, 0, cmd({ intake: true }), Math.round(1 / C.SIM_DT));
      check(
        'flower intake: SIDE ROLLERS flush on the CENTRELINE (neither wheel on the opening) pull NOTHING',
        stack.length === n0 && r.hopper.length === 0,
        `stack=${stack.length} hopper=${r.hopper.length}`,
      );
    }
    {
      const { w, r } = pullWorld(109, 'siderollers');
      const stack = w.biobuzz!.flowers[FR].stack;
      const bottom = w.balls.find((b) => b.id === stack[0])!;
      bottom.color = 'blue'; // a NECTAR at the bottom
      const n0 = stack.length;
      holdTicksEdge(w, r, 0, cmd({ intake: true }), Math.round(1 / C.SIM_DT));
      check('flower intake: a NECTAR at the bottom LOCKS the FLOWER (nothing comes out)', stack.length === n0 && r.hopper.length === 0, `stack=${stack.length} hopper=${r.hopper.length}`);
    }
    {
      const { w, r } = pullWorld(111, 'siderollers');
      const stack = w.biobuzz!.flowers[FR].stack;
      const n0 = stack.length;
      park(r, f0.x - BB_PLACE_REACH - r.spec.length / 2 - 6, f0.y, 0);
      tick(w, cmd({ intake: true }));
      check('flower intake: six inches off the foot, nothing comes out', stack.length === n0 && r.hopper.length === 0);
    }
    {
      const { w, r } = pullWorld(113, 'siderollers');
      const stack = w.biobuzz!.flowers[FR].stack;
      const n0 = stack.length;
      park(r, f0.x - BB_PLACE_REACH - r.spec.length / 2 - 0.2, f0.y, Math.PI); // BACK to the FLOWER: no sweeper there
      run(w, cmd({ intake: true }), 1);
      check('flower intake: the edge without a sweeper pulls nothing', stack.length === n0 && r.hopper.length === 0, `stack=${stack.length} hopper=${r.hopper.length}`);
    }

    // ── THE RAMP TOGGLE ────────────────────────────────────────────────────
    // ⚠️ DEPLOYED IN THE OPEN FIELD, NOT FLUSH ON THE FOOT (owner, 2026-09-20: "The ramp should
    // not be able to deploy INTO a flower... It needs to be deployed before going in"). The swing
    // guard (`bbRampSwingStep2d`) now REFUSES a deploy whose footprint would land on a static —
    // and `flush(r)` is standoff 0, i.e. AS CLOSE AS THE FOOT'S OWN COLLISION LETS THE CHASSIS
    // GET, so pressing there is exactly the case the guard exists to catch. These fixtures are
    // about the LATCH/PACING mechanics, not the guard (that has its own block below), so they
    // press well clear of the foot (`openPark`) and drive flush only AFTER the ramp has settled.
    const openPark = (r: RobotState): void => park(r, f0.x - 100, f0.y, 0);
    {
      const { w, r } = pullWorld(115, 'ramp');
      const stack = w.biobuzz!.flowers[FR].stack;
      const n0 = stack.length;
      holdTicks(w, r, 0, cmd({ intake: true }), Math.round(1 / C.SIM_DT));
      check('flower intake: RAMP folded pulls NOTHING', stack.length === n0 && r.hopper.length === 0 && r.bbRampOut !== true, `stack=${stack.length} hopper=${r.hopper.length} out=${r.bbRampOut}`);
    }
    {
      // a HELD button fires the rising edge once — holding it 30 ticks does not re-fire it, or
      // toggle it back off. Deliberately no `intake` here, so this is purely about the latch.
      const { w, r } = pullWorld(117, 'ramp');
      openPark(r);
      tick(w, cmd({ bbRamp: true }));
      const rampAt = r.bbRampAt;
      check('flower intake: cmd.bbRamp toggles the ramp OUT and stamps bbRampAt', r.bbRampOut === true && rampAt === w.time, `out=${r.bbRampOut} at=${rampAt} t=${w.time}`);
      const holdOpen = (rr: RobotState, standoff: number, c: RobotCommand, n: number): void => {
        for (let i = 0; i < n; i++) {
          openPark(rr);
          tick(w, c);
        }
      };
      holdOpen(r, 0, cmd({ bbRamp: true }), 29);
      check('flower intake: cmd.bbRamp held 30 ticks toggles ONCE', r.bbRampOut === true && r.bbRampAt === rampAt, `out=${r.bbRampOut} at=${r.bbRampAt} want=${rampAt}`);
    }
    {
      // ONE press, released immediately (so the deploy window is measured from a single stamp,
      // not stretched by a still-held button): nothing pulls until `BB_RAMP_DEPLOY_S` has
      // elapsed, and it pulls once it has. Deployed in the open, THEN driven flush once settled.
      const { w, r } = pullWorld(119, 'ramp');
      openPark(r);
      tick(w, cmd({ bbRamp: true }));
      const rampAt = r.bbRampAt!;
      let settledAt = -1;
      for (let i = 0; i < 60 && settledAt < 0; i++) {
        openPark(r);
        tick(w, cmd({}));
        if (bbRampSettled(r, w.time)) settledAt = w.time;
      }
      check(
        'flower intake: RAMP mid-swing (before BB_RAMP_DEPLOY_S) pulls nothing',
        settledAt > rampAt + BB_RAMP_DEPLOY_S - 1e-6,
        `settledAt=${settledAt} rampAt=${rampAt} deploy=${BB_RAMP_DEPLOY_S}`,
      );
      // ⚠️ THE RAMP IS A TWO-PHASE PULL NOW, NOT A ONE-TICK GATE (2026-09-20, the wedge). Once
      // settled the wedge is a real collider and the FIRST tick only starts the stall clock
      // (`flowerRetrieve3d`'s ramp branch: the lip's roller turns and the take waits on the blade
      // having physically lifted the POLLEN, `BB_RAMP_LIFT_Z`); the pull
      // release fires after that, and the extended pull sweeps it in a handful of ticks more —
      // MEASURED (`scratch/ramp_debug.ts`, a real drive-in) 112 ticks pop-to-hopper end to end.
      // 150 ticks held flush covers that with margin.
      holdTicks(w, r, 0, cmd({ intake: true }), 150);
      check(
        'flower intake: RAMP pulls once the stall fallback has had time to fire, and not before the ramp settled',
        r.hopper.length >= 1 && settledAt >= 0,
        `hopper=${r.hopper.length} settledAt=${settledAt}`,
      );
    }
    {
      // a SECOND press (a fresh rising edge — the button is released in between) folds the ramp
      // back, and pulling stops. Deployed AND folded in the open — folding FLUSH on the foot is
      // its own case (the swing guard refusing an un-deploy that would carry the ramp back UP
      // into the flower, "same with un-deploying"), covered below.
      const { w, r } = pullWorld(121, 'ramp');
      openPark(r);
      tick(w, cmd({ bbRamp: true }));
      for (let i = 0; i < 30 && !bbRampSettled(r, w.time); i++) {
        openPark(r);
        tick(w, cmd({}));
      }
      // see the previous fixture's own note: the ramp needs the stall window plus travel, not one
      // tick, before anything reaches the hopper.
      holdTicks(w, r, 0, cmd({ intake: true }), 150);
      const pulled = r.hopper.length;
      check('flower intake: (setup) the ramp pulled at least once before folding it back', pulled > 0, `hopper=${pulled}`);
      openPark(r);
      tick(w, cmd({ bbRamp: true }));
      check('flower intake: a second press folds the ramp', r.bbRampOut === false, `out=${r.bbRampOut}`);
      // ⚠️ LET THE FOLD FINISH SETTLING IN THE OPEN before moving flush — a fold still MID-SWING
      // that gets re-parked flush is exactly the "folding into a static" case the swing guard
      // above exists to catch, and it would reverse this fold back to deployed (re-enabling
      // reach) rather than let it complete, which is not what this fixture is testing.
      for (let i = 0; i < 30 && bbRampSwingProgress(r, w.time) !== null; i++) {
        openPark(r);
        tick(w, cmd({}));
      }
      holdTicks(w, r, 0, cmd({ intake: true }), 30);
      check('flower intake: ...and pulling stops', r.hopper.length === pulled, `hopper=${r.hopper.length} was=${pulled}`);
    }
    // ── THE SWING GUARD (owner, 2026-09-20) ─────────────────────────────────
    {
      // a deploy attempted FLUSH ON THE FOOT (standoff 0 — as close as the collision lets the
      // chassis get) is refused: it starts the swing and folds back before it ever settles.
      const { w, r } = pullWorld(123, 'ramp');
      flush(r);
      tick(w, cmd({ bbRamp: true }));
      for (let i = 0; i < 90; i++) {
        flush(r);
        tick(w, cmd({}));
      }
      check(
        "flower swing guard: a deploy FLUSH ON THE FLOWER'S FOOT reverses back to folded rather than settling deployed",
        r.bbRampOut === false && !bbRampSettled(r, w.time),
        `out=${r.bbRampOut} settled=${bbRampSettled(r, w.time)}`,
      );
    }
    {
      // "same with un-deploying": deploy in the open (safe), drive flush, THEN fold — the fold
      // sweeps the arm back UP through the same space the deploy swept down through, so folding
      // FLUSH ON THE FOOT is refused exactly the way deploying there was, and reverses back to
      // (re-settling) DEPLOYED rather than completing the fold.
      const { w, r } = pullWorld(124, 'ramp');
      park(r, f0.x - 100, f0.y, 0); // open field
      tick(w, cmd({ bbRamp: true }));
      for (let i = 0; i < 30 && !bbRampSettled(r, w.time); i++) {
        park(r, f0.x - 100, f0.y, 0);
        tick(w, cmd({}));
      }
      const wasSettledDeployed = r.bbRampOut === true && bbRampSettled(r, w.time);
      flush(r);
      tick(w, cmd({ bbRamp: true })); // fold, flush on the foot
      for (let i = 0; i < 90; i++) {
        flush(r);
        tick(w, cmd({}));
      }
      check(
        'flower swing guard: folding FLUSH ON THE FLOWER\'S FOOT reverses back to DEPLOYED rather than completing the fold',
        wasSettledDeployed && r.bbRampOut === true && bbRampSettled(r, w.time),
        `wasSettledDeployed=${wasSettledDeployed} out=${r.bbRampOut} settled=${bbRampSettled(r, w.time)}`,
      );
    }
    {
      // ⚠️ **4 IN OFF THE FOOT, NOT 3 — MEASURED.** The FINAL deployed footprint clears the
      // peanut supports at 0 standoff by ≈0.55 in (`clearance` in the CAD block below), which
      // reads as "3 in of standoff is a generous margin" — but a rigid arm rotating from vertical
      // to `BB_RAMP_ANGLE` below level does not sweep monotonically outward: `sin(φ)` peaks at
      // `φ = 90°` (horizontal), PAST the arm's own final resting angle
      // (`90° + BB_RAMP_ANGLE`), so the swing's outward reach OVERSHOOTS the settled position by
      // `BB_RAMP_L·(1 − cos(BB_RAMP_ANGLE))` at its mid-swing peak. Swept standoff 3..10 in: 3
      // still gets refused, 4 and up settle clean — the guard is catching a REAL transient
      // collision the final-pose-only clearance check cannot see, not a false positive.
      const { w, r } = pullWorld(125, 'ramp');
      flush(r, 4);
      tick(w, cmd({ bbRamp: true }));
      for (let i = 0; i < 30; i++) {
        flush(r, 4);
        tick(w, cmd({}));
      }
      check(
        'flower swing guard: a deploy 4 in off the foot stays deployed and settles (3 in still catches the mid-swing overshoot)',
        r.bbRampOut === true && bbRampSettled(r, w.time),
        `out=${r.bbRampOut} settled=${bbRampSettled(r, w.time)}`,
      );
    }
    {
      // a WALL-FLUSH deploy, on the intake edge, is refused the same way.
      const { w, r } = pullWorld(127, 'ramp');
      const wallFlushX = BB_HALF_X - bbFootprint(r.spec).front;
      const parkWall = (): void => park(r, wallFlushX, 0, 0); // heading 0: the FRONT mouth faces the +x wall
      parkWall();
      tick(w, cmd({ bbRamp: true }));
      for (let i = 0; i < 30; i++) {
        parkWall();
        tick(w, cmd({}));
      }
      check(
        'flower swing guard: a WALL-FLUSH deploy on the intake edge is refused',
        r.bbRampOut === false,
        `out=${r.bbRampOut}`,
      );
    }
    {
      // NO OSCILLATION: a blocked swing reverses at most once per press — `bbRampBlocked` stops
      // the guard testing again for the rest of that one swing.
      const { w, r } = pullWorld(129, 'ramp');
      flush(r);
      let changes = 0;
      let prevOut = r.bbRampOut ?? false;
      tick(w, cmd({ bbRamp: true }));
      for (let i = 0; i < 90; i++) {
        flush(r);
        tick(w, cmd({}));
        const now = r.bbRampOut ?? false;
        if (now !== prevOut) changes++;
        prevOut = now;
      }
      check('flower swing guard: a blocked swing changes state AT MOST TWICE per press (out, then back)', changes <= 2, `changes=${changes}`);
    }
    {
      // DETERMINISM: two fresh worlds, same script, same blocked press — identical hashes.
      const scriptedHash = (seed: number): number => {
        const { w, r } = pullWorld(seed, 'ramp');
        flush(r);
        tick(w, cmd({ bbRamp: true }));
        for (let i = 0; i < 40; i++) {
          flush(r);
          tick(w, cmd({}));
        }
        return worldHash(w);
      };
      const ha = scriptedHash(131);
      const hb = scriptedHash(131);
      check('flower swing guard: determinism holds with a BLOCKED press in the script', ha === hb, `${ha} vs ${hb}`);
    }
    {
      // a SWEEPER never READS `bbRamp` — the archetype gate in `bbRampStep` returns before
      // touching `r`, so all three fields stay `undefined` even under a held press.
      const { w, r } = pullWorld(119, 'sweeper');
      holdTicks(w, r, 0, cmd({ bbRamp: true }), 10);
      check(
        'flower intake: a SWEEPER build with bbRamp held writes NO ramp field',
        r.bbRampOut === undefined && r.bbRampAt === undefined && r.bbRampHeld === undefined,
        `out=${r.bbRampOut} at=${r.bbRampAt} held=${r.bbRampHeld}`,
      );
    }
    {
      // a press during `pre` is DRIVER CONTROL, and `enabled` is false: it does nothing.
      const { w, r } = pullWorld(121, 'ramp');
      w.match.phase = 'pre';
      flush(r);
      tick(w, cmd({ bbRamp: true }));
      check('flower intake: a bbRamp press during `pre` does nothing', r.bbRampOut !== true, `out=${r.bbRampOut}`);
    }
    {
      // DEBOUNCE (replay 1dc6eb8f, 2026-09-25): a held ramp button with a 1- or 2-tick dropout in
      // it is ONE press. Each dropout in that match flipped the ramp twice. A 3-tick gap was the
      // fastest real re-press in the same match, so it still counts.
      const flipsWithGap = (gap: number): number => {
        const { r } = pullWorld(123, 'ramp');
        let t = 0;
        let flips = 0;
        let out = r.bbRampOut;
        const hold = (on: boolean, n: number): void => {
          for (let i = 0; i < n; i++) {
            t += 1 / 60;
            bbRampStep(r, cmd({ bbRamp: on }), true, t);
            if (r.bbRampOut !== out) {
              flips++;
              out = r.bbRampOut;
            }
          }
        };
        hold(true, 8);
        hold(false, gap);
        hold(true, 8);
        hold(false, 10);
        return flips;
      };
      const f = [1, 2, 3, 6].map(flipsWithGap);
      check('ramp debounce: a 1-tick dropout inside a held press toggles ONCE', f[0] === 1, `flips=${f[0]}`);
      check('ramp debounce: a 2-tick dropout inside a held press toggles ONCE', f[1] === 1, `flips=${f[1]}`);
      check('ramp debounce: a 3-tick gap is a real re-press and toggles TWICE', f[2] === 2, `flips=${f[2]}`);
      check('ramp debounce: a 6-tick gap toggles TWICE', f[3] === 2, `flips=${f[3]}`);
    }
  }

  // ── THE INTAKE ARCHETYPE: coercion and identity ───────────────────────────
  {
    for (const kind of BB_INTAKE_KINDS) {
      const once = bbCoerce({ ...BB_DEFAULT_SPEC, ...mech({ launcher: { kind: 'turret', mount: 'front', hoodDeg: BB_HOOD_DEFAULT_DEG }, lift: null, intake: { kind } }) });
      check(`intake: ${kind} round-trips through bbIntakeKindOf`, bbIntakeKindOf(once) === kind, `got ${bbIntakeKindOf(once)}`);
      check(`intake: ${kind} coercion is a fixed point`, specKey(once) === specKey(bbCoerce(once)));
    }
    check(
      'intake: an unknown stored kind folds to the sweeper',
      bbIntakeKindOf({ ...BB_DEFAULT_SPEC, bbMech: { launcher: { kind: 'turret', mount: 'front', hoodDeg: BB_HOOD_DEFAULT_DEG }, lift: null, intake: { kind: 'auger' as unknown as BbIntakeKind } } }) === 'sweeper',
    );
    check(
      'intake: an absent container reads as the sweeper (a pre-archetype save)',
      bbIntakeKindOf({ ...BB_DEFAULT_SPEC, bbMech: undefined }) === 'sweeper',
    );
    const keys = BB_INTAKE_KINDS.map((kind) =>
      bbSpecKey(bbCoerce({ ...BB_DEFAULT_SPEC, ...mech({ launcher: { kind: 'turret', mount: 'front', hoodDeg: BB_HOOD_DEFAULT_DEG }, lift: null, intake: { kind } }) })),
    );
    check('intake: bbSpecKey differs across kinds', new Set(keys).size === BB_INTAKE_KINDS.length, keys.join(' | '));
  }

  // ── GEOMETRY FACTS AGAINST THE CAD (pure) ─────────────────────────────────
  /**
   * The archetype reach boxes in `config.ts` are `APPROX` hardware sized against the CAD's
   * numbers, copied into constants rather than read live. This re-derives the same facts off the
   * LIVE collider export (`scratch/flowerhulls.ts`'s own transform: `u` outward along the flower's
   * mouth normal from the ring centre, `v` along the wall) so a field-CAD regeneration that moves
   * a support or a plate edge fails HERE instead of shipping a reach that pokes into one.
   */
  {
    const fc = fieldColliders3d();
    const f0 = fc.flowers[0];
    const bf0 = BB_FLOWERS[0];
    const n = FLOWER_MOUTH[bf0.wall];
    const byName = new Map(fc.statics.map((s) => [s.name, s]));
    let nearestSupportU = -Infinity;
    for (const name of f0.staticNames) {
      if (!name.includes('peanut_support')) continue;
      const s = byName.get(name);
      if (!s) continue;
      const pts = s.points as number[];
      for (let i = 0; i < pts.length; i += 3) {
        const u = (pts[i] - bf0.x) * n.x + (pts[i + 1] - bf0.y) * n.y;
        nearestSupportU = Math.max(nearestSupportU, u);
      }
    }
    // the clearance from the plate's own field edge (`BB_PLACE_REACH` past the ring centre) back
    // to the nearest support face — measured 3.57 (config.ts's header); both archetypes' reach
    // must stay inside it, or their drawn hardware would poke into the support.
    const clearance = BB_PLACE_REACH - nearestSupportU;
    check(
      'flower reach (CAD): SIDE ROLLERS stay clear of the peanut supports under the mid plate',
      BB_SIDE_ROLLER_REACH.out[1] < clearance,
      `out[1]=${BB_SIDE_ROLLER_REACH.out[1]} clearance=${clearance.toFixed(3)}`,
    );
    check(
      'flower reach (CAD): the RAMP stays clear of the peanut supports under the mid plate',
      BB_RAMP_OUT < clearance,
      `BB_RAMP_OUT=${BB_RAMP_OUT} clearance=${clearance.toFixed(3)}`,
    );
    check(
      'flower reach (CAD): both archetypes\' z-maxima sit below the retrieval ceiling',
      BB_SIDE_ROLLER_REACH.z[1] < BB_FLOWER_RETRIEVE_Z[1] && BB_RAMP_REACH.z[1] < BB_FLOWER_RETRIEVE_Z[1],
      `siderollers=${BB_SIDE_ROLLER_REACH.z[1]} ramp=${BB_RAMP_REACH.z[1]} ceiling=${BB_FLOWER_RETRIEVE_Z[1]}`,
    );
    /**
     * ⚠️ **THE MINIMUM PROTRUSION, AND WHY IT IS NOT A STYLE CHOICE** (owner, 2026-09-21: "do the
     * side roller wheels need to stick out that much for flower intaking?"). A BIOBUZZ chassis is
     * ONE RECTANGULAR PRISM to a static — frame, arms, lintel and `chassis3dPocketShapes` — so
     * driving at a FLOWER it stops with its TIP LINE on the ring plates' own rim, `BB_PLACE_REACH`
     * past the ring axis (MEASURED on a real square drive-in: 2.4145 against the CAD's 2.404/2.415
     * plate edges). Only the wheel, which lives inside the retrieval window's z band, gets past
     * that. So the wheel's own FRONT has to stand at least `BB_PLACE_REACH − BB_POLLEN_R` past the
     * tip line or it cannot touch the bottom POLLEN AT ALL, and no tolerance may be widened to
     * pretend otherwise — `BB_SIDE_ROLLER_CONTACT_TOL` is a contact skin, not a reach.
     * `config.ts`'s own header on `BB_SIDE_ROLLER_R` carries the 540-drive-in sweep that says the
     * shipped 1.90 is also the KNEE of the skewed-retrieval curve.
     */
    check(
      'flower reach (CAD): a side roller stands far enough past the tip line to TOUCH the bottom POLLEN with the chassis stopped on the ring plates',
      BB_SIDE_ROLLER_PROTRUDE >= BB_PLACE_REACH - BB_POLLEN_R,
      `protrude=${BB_SIDE_ROLLER_PROTRUDE.toFixed(3)} floor=${(BB_PLACE_REACH - BB_POLLEN_R).toFixed(3)}`,
    );
    check(
      'flower reach (CAD): and BB_SIDE_ROLLER_PROTRUDE is the wheel reach box\'s own outer face, not a second number',
      Math.abs(BB_SIDE_ROLLER_PROTRUDE - BB_SIDE_ROLLER_REACH.out[1]) < 1e-12 &&
        Math.abs(bbArchetypeWallExtra('siderollers') - BB_SIDE_ROLLER_PROTRUDE) < 1e-12,
      `${BB_SIDE_ROLLER_PROTRUDE} vs out[1]=${BB_SIDE_ROLLER_REACH.out[1]} wallExtra=${bbArchetypeWallExtra('siderollers')}`,
    );
    // ⚠️ RELOCATED 2026-09-20 (owner: "situated on the edges of the robot, not near the center") —
    // the pair no longer straddles the centreline, so "the pair's outer extent [off the chassis
    // centreline]" is the wrong question — the wheel that GRIPS the ball is not fixed relative to
    // the FLOWER's own axis, it is fixed relative to the CHASSIS, and the driver lines it up by
    // moving the whole robot.
    //
    // ⚠️ TUCKED 2026-09-20 (owner: "right in front of the wheels ... not sticking out like that")
    // grew `BB_SIDE_ROLLER_R` past the point where `BB_SIDE_ROLLER_GRIP + BB_SIDE_ROLLER_R` (3.25)
    // still fits inside the mid plate's own half-width (2.976) — a gripping wheel's outer face can
    // now sit BEYOND the plate's edge. Owner ruling: that is fine PHYSICALLY, beside the foot is
    // open tile below the 3.9-in ceiling, solid only on the wall side where the peanut supports
    // (and the rest of this flower's own `flower_support` hardware) actually stand. So the real
    // question is not "does it fit under the plate" but "does the wheel box clear every SOLID
    // thing there actually is" — computed straight off the CAD hulls, like the rest of this block,
    // rather than assumed from the plate's rectangle.
    {
      // the wheel's own swept footprint (u outward, v along the wall, z up) as its axis ranges
      // anywhere within GRIP of the pollen, chassis flush (`BB_PLACE_REACH` is the tip line's own
      // u past the flower's centre — see `clearance` above): u is fixed by the reach box, v sweeps
      // ±(GRIP + R) about the axis (the worst case over every legal grip position), z is the reach
      // box's own band.
      const wheelU: readonly [number, number] = [
        BB_PLACE_REACH + BB_SIDE_ROLLER_REACH.out[0],
        BB_PLACE_REACH + BB_SIDE_ROLLER_REACH.out[1],
      ];
      const wheelVHalf = BB_SIDE_ROLLER_GRIP + BB_SIDE_ROLLER_R;
      const wheelZ = BB_SIDE_ROLLER_REACH.z;
      const overlaps1d = (a: readonly [number, number], b: readonly [number, number]): boolean => a[0] < b[1] && b[0] < a[1];
      let hit = '';
      // every SOLID hull this flower owns (backstop/peanut supports/brackets/pipes — all
      // `flower_support`, `convert.py`'s own class), transformed into the same (u, v, z) frame the
      // rest of this block reads.
      for (const name of f0.staticNames) {
        const s = byName.get(name);
        if (!s) continue;
        const pts = s.points as number[];
        let uMin = Infinity, uMax = -Infinity, vMin2 = Infinity, vMax2 = -Infinity, zMin = Infinity, zMax = -Infinity;
        for (let i = 0; i < pts.length; i += 3) {
          const u = (pts[i] - bf0.x) * n.x + (pts[i + 1] - bf0.y) * n.y;
          const v = -(pts[i] - bf0.x) * n.y + (pts[i + 1] - bf0.y) * n.x;
          uMin = Math.min(uMin, u);
          uMax = Math.max(uMax, u);
          vMin2 = Math.min(vMin2, v);
          vMax2 = Math.max(vMax2, v);
          zMin = Math.min(zMin, pts[i + 2]);
          zMax = Math.max(zMax, pts[i + 2]);
        }
        if (
          overlaps1d(wheelU, [uMin, uMax]) &&
          overlaps1d([-wheelVHalf, wheelVHalf], [vMin2, vMax2]) &&
          overlaps1d(wheelZ, [zMin, zMax])
        ) {
          hit = name;
          break;
        }
      }
      // ...and the ring plates themselves (not in `staticNames` — see `FieldFlowerDesc`'s own
      // header), each a rectangle at its own z band, projected into (u, v) the same way the
      // support hulls are above.
      if (!hit) {
        for (const ring of cadFlowerRings(0)) {
          if (!overlaps1d(wheelZ, ring.z)) continue;
          let uMin = Infinity, uMax = -Infinity, vMin2 = Infinity, vMax2 = -Infinity;
          for (const x of ring.rect.x) {
            for (const y of ring.rect.y) {
              const u = (x - bf0.x) * n.x + (y - bf0.y) * n.y;
              const v = -(x - bf0.x) * n.y + (y - bf0.y) * n.x;
              uMin = Math.min(uMin, u);
              uMax = Math.max(uMax, u);
              vMin2 = Math.min(vMin2, v);
              vMax2 = Math.max(vMax2, v);
            }
          }
          if (overlaps1d(wheelU, [uMin, uMax]) && overlaps1d([-wheelVHalf, wheelVHalf], [vMin2, vMax2])) {
            hit = `ring:${ring.id}`;
            break;
          }
        }
      }
      check(
        'flower reach (CAD): a side roller GRIPPING the ball never intersects a flower_support hull or ring plate',
        hit === '',
        `hit=${hit || 'none'} wheelU=[${wheelU[0].toFixed(3)},${wheelU[1].toFixed(3)}] wheelV=±${wheelVHalf.toFixed(3)} wheelZ=[${wheelZ[0]},${wheelZ[1]}]`,
      );
    }
    const lowerRingTop = cadFlowerRings(0)[0]?.z[1];
    check(
      "flower reach (CAD): the ramp's deployed tip clears the lower ring's top face",
      lowerRingTop !== undefined && BB_RAMP_TIP_Z > lowerRingTop,
      `BB_RAMP_TIP_Z=${BB_RAMP_TIP_Z} lowerRingTop=${lowerRingTop}`,
    );
    check("flower reach: the SWEEPER's reach is null — it never gets a box to bite with", bbFlowerReachOf('sweeper', true) === null);
  }
  /** the HUD reads the launcher through the resolver, never the flat mirror */
  {
    const w = mkWorld('free', 85, mech({ launcher: TWIN, lift: null }));
    const r = w.robots[0];
    r.spec = { ...r.spec, scoreMode: 'turret' };
    check('hud: mode comes from the resolved launcher, not the flat scoreMode', biobuzzHud(w, r.id).robot?.mode === 'twinturret');
    check('hud: flowerInReach is false for a build with no Box Tube', biobuzzHud(w, r.id).robot?.flowerInReach === false);
  }

  // ── COERCION: THE ENUMS FOLD, AND THE LEGACY MIRRORS AGREE ────────────────
  {
    check(
      'coerce: an unknown archetype folds to a known one',
      (BB_SCORE_MODES as readonly string[]).includes(bbCoerce({ ...BB_DEFAULT_SPEC, scoreMode: 'trebuchet' }).scoreMode as string),
    );
    const corner = bbCoerce({ ...BB_DEFAULT_SPEC, scoreMode: 'dumper', shooterMount: 'frontleft' });
    check('coerce: a turretless launcher on a CORNER folds to an edge', (BB_SHOOTER_EDGES as readonly string[]).includes(corner.shooterMount as string), `mount=${corner.shooterMount}`);
    const turret = bbCoerce({ ...BB_DEFAULT_SPEC, scoreMode: 'turret', shooterMount: 'frontleft' });
    check('coerce: a TURRET keeps its corner mount', turret.shooterMount === 'frontleft', `mount=${turret.shooterMount}`);
    check(
      'coerce: the legacy intakeSide/shooterRear booleans mirror the mounts',
      everyBuild().every((s) => s.intakeSide === (s.intakeMount === 'side') && s.shooterRear === (s.shooterMount === 'back')),
    );
    const fromCr = bbCoerce({
      ...DEFAULT_SPEC,
      catalystType: 'hook',
      catalystMount: 'front',
      catalystSwing: 30,
      catapultRange: 40,
      catapultYaw: 10,
      groundClearance: 2,
    }) as unknown as Record<string, unknown>;
    check('coerce: Chain Reaction mechanism fields are stripped, not carried', CR_FIELDS.every((k) => fromCr[k] === undefined), CR_FIELDS.filter((k) => fromCr[k] !== undefined).join(','));
    check('coerce: every build has a usable hopper', everyBuild().every((s) => bbHopperCap(s) >= 1));
  }

  // ── THE LOADOUT: SWITCHING GAME DOES NOT BLEED A BUILD ────────────────────
  {
    const s0 = switchGame(defaultSettings(), 'biobuzz');
    check('settings: switchGame("biobuzz") makes it the active game', s0.game === 'biobuzz');
    const mine = bbCoerce({ ...BB_DEFAULT_SPEC, scoreMode: 'dumper', intakeMount: 'back', ballStorage: 2 });
    const parked = { ...s0, spec: mine, savedRobots: [mine] };
    const inChain = switchGame(parked, 'chain');
    check('settings: leaving BIOBUZZ archives its loadout', !!inChain.loadouts?.biobuzz);
    check('settings: the CHAIN build is not the BIOBUZZ one', specKey(inChain.spec) !== specKey(mine), `chain scoreMode=${inChain.spec.scoreMode}`);
    check('settings: no BIOBUZZ saved robot leaks into CHAIN', inChain.savedRobots.length === 0);
    const back = switchGame(inChain, 'biobuzz');
    check('settings: returning to BIOBUZZ restores the parked build', specKey(back.spec) === specKey(mine));
    check('settings: ...and its saved robots', back.savedRobots.length === 1 && specKey(back.savedRobots[0]) === specKey(mine));
    check('settings: the active BIOBUZZ loadout is not ALSO left in the archive', back.loadouts?.biobuzz === undefined, `archived=${Object.keys(back.loadouts ?? {}).join(',')}`);
    check('settings: switching to the game already active is a no-op', switchGame(back, 'biobuzz') === back);
  }

  // ── A FIRST BIOBUZZ ROBOT IS BIOBUZZ'S, NOT DECODE'S CHASSIS CLAMPED (audit #29) ──────────
  //
  // `src/settings.ts` seeded every game's first loadout from `DEFAULT_SPEC`, which is DECODE's
  // chassis: `coerceSpec` starts from `base` and overlays only what it reads off the raw input,
  // so a fresh BIOBUZZ robot was DECODE's 14.5 × 16.5 / 500 rpm / 0.40 inertia bounded into this
  // game's legal ranges. Legal and playable, on tuning nobody chose. `BB_DEFAULT_SPEC` was
  // written to be that seed and nothing reached it — it is only `coerceBiobuzzSpec`'s default
  // PARAMETER, and `coerceSpec` always passes its own `base` explicitly.
  {
    const fresh = switchGame(defaultSettings(), 'biobuzz').spec;
    /** `BB_DEFAULT_SPEC` with the SHARED identity back on it — the seed as `src/settings.ts`
     * builds it. Spelled out here rather than imported so the check states the contract itself. */
    const seed = { ...BB_DEFAULT_SPEC, name: DEFAULT_SPEC.name, teamName: DEFAULT_SPEC.teamName, teamNumber: DEFAULT_SPEC.teamNumber };
    const bb = coerceSpec(seed, seed, 'biobuzz');
    check('settings: a first BIOBUZZ robot is the game’s own build', specKey(fresh) === specKey(bb), `${specKey(fresh)} vs ${specKey(bb)}`);
    // the three numbers the audit measured, named so a regression says WHICH way it went
    check(
      'settings: ...so it is not DECODE’s frame, gearing or flywheel',
      fresh.length === BB_DEFAULT_SPEC.length &&
        fresh.width === BB_DEFAULT_SPEC.width &&
        fresh.driveRpm === BB_DEFAULT_SPEC.driveRpm &&
        fresh.flywheelInertia === BB_DEFAULT_SPEC.flywheelInertia,
      `${fresh.length}x${fresh.width} ${fresh.driveRpm}rpm i=${fresh.flywheelInertia}`,
    );
    /** the seed as it WAS: DECODE's chassis as both raw input and base, bounded into BIOBUZZ. */
    const legacy = coerceSpec(DEFAULT_SPEC, DEFAULT_SPEC, 'biobuzz');
    check('settings: ...and it really differs from what DECODE’s chassis coerced to', specKey(fresh) !== specKey(legacy));
    // ⚠️ THE IDENTITY IS STILL THE SHARED ONE. `BB_DEFAULT_SPEC` is `{ ...DEFAULT_SPEC,
    // ...BB_PRESETS[0] }` and `BB_PRESETS[0]` is a preset CARD, so seeding straight from it would
    // name a new player's own robot "Pollinator" — a name they never typed, in one game only.
    check(
      'settings: a first BIOBUZZ robot still carries the shared name and team',
      fresh.name === DEFAULT_SPEC.name && fresh.teamName === DEFAULT_SPEC.teamName && fresh.teamNumber === DEFAULT_SPEC.teamNumber,
      `${fresh.name} / ${fresh.teamName} / ${fresh.teamNumber}`,
    );
    /**
     * ⚠️ THE SEED'S OWN TUNING MUST SURVIVE THE COERCER — the property that matters, and NOT
     * "the seed is a fixed point", which is false: `coerceSpec` adds `accent`/`bbMech`/
     * `chassisColor`/`decal`/`plate` and drops the fields BIOBUZZ does not use, so seed and
     * coerced seed never key-compare equal. The old check compared the coerced output with
     * ITSELF and so passed with a seed of `driveRpm: 99999`.
     */
    const seeded = BB_DEFAULT_SPEC;
    check(
      'settings: the seed’s own tuning survives coercion — it is not clamped away',
      fresh.driveRpm === seeded.driveRpm &&
        fresh.massLb === seeded.massLb &&
        fresh.flywheelInertia === seeded.flywheelInertia &&
        fresh.length === seeded.length &&
        fresh.width === seeded.width,
      `${fresh.driveRpm}rpm ${fresh.massLb}lb i=${fresh.flywheelInertia} ${fresh.length}x${fresh.width}`,
    );
    // and coercing it again changes nothing more (the builder must not rewrite it per keystroke)
    check('settings: …and a second pass changes nothing more', specKey(bbCoerce(fresh)) === specKey(fresh));
    // AND THE OTHER DOOR AGREES. A stored blob that names a game but carries no robot is the same
    // "seed a fresh loadout" case reached through `coerceSettings` instead of `switchGame`.
    check('settings: a stored blob with a game but no robot seeds the same build', specKey(coerceSettings({ game: 'biobuzz' }).spec) === specKey(fresh));
    // ⚠️ AND AN EXISTING PLAYER'S ROBOT IS NOT RE-TUNED. The seed only applies where there is no
    // stored spec; a saved one keeps `DEFAULT_SPEC` as its fallback base, so nothing people have
    // already built moves under them.
    const stored = JSON.parse(JSON.stringify({ ...switchGame(defaultSettings(), 'biobuzz'), spec: legacy })) as unknown;
    check('settings: a robot saved under the old seed survives a load unchanged', specKey(coerceSettings(stored).spec) === specKey(legacy));
    /**
     * ⚠️ AND A PARTIAL ONE TOO, which is the only shape that can observe this at all. A
     * COMPLETE stored spec makes `coerceSpec`'s BASE argument structurally unreachable, so
     * the check above cannot see which base was used — it passed even with the seed wired in
     * as the base, i.e. with every existing player's robot silently re-tuned. An older blob
     * missing the fields a later build added is the real case, and it must fall back to
     * DECODE's shared values rather than to BIOBUZZ's.
     */
    const partial = JSON.parse(
      JSON.stringify({ game: 'biobuzz', spec: { driveRpm: legacy.driveRpm, massLb: legacy.massLb } }),
    ) as unknown;
    const loaded = coerceSettings(partial).spec;
    check(
      'settings: a PARTIAL saved robot falls back to the shared base, not the BIOBUZZ seed',
      loaded.driveRpm === legacy.driveRpm &&
        loaded.massLb === legacy.massLb &&
        loaded.flywheelInertia === legacy.flywheelInertia,
      `${loaded.driveRpm}rpm ${loaded.massLb}lb i=${loaded.flywheelInertia} (seed would be ${BB_DEFAULT_SPEC.flywheelInertia})`,
    );
  }

  // ── THE DRAWN MOUTHS ARE THE CAPTURE AREAS ────────────────────────────────
  for (const intakeMount of BB_INTAKE_MOUNTS) {
    const world = mkWorld('free', 3, { intakeMount });
    const r = world.robots[0];
    r.pos = { x: 0, y: 0 };
    r.heading = 0;
    r.vel = { x: 0, y: 0 };
    const mouths = bbMouths(r.spec);
    let insideOk = true;
    let outsideOk = true;
    for (const m of mouths) {
      const cx = (m.x0 + m.x1) / 2;
      const cy = (m.y0 + m.y1) / 2;
      world.balls.length = 0;
      world.balls.push(bbPollen(1, cx, cy));
      if (pollenIn(world, r, m).length !== 1) insideOk = false;
      const gap = 2 * BB_POLLEN_R + 0.1;
      const out =
        m.edge === 'front'
          ? { x: m.x1 + gap, y: cy }
          : m.edge === 'back'
            ? { x: m.x0 - gap, y: cy }
            : m.edge === 'left'
              ? { x: cx, y: m.y1 + gap }
              : { x: cx, y: m.y0 - gap };
      world.balls.length = 0;
      world.balls.push(bbPollen(2, out.x, out.y));
      if (pollenIn(world, r, m).length !== 0) outsideOk = false;
    }
    check(`mouths [${intakeMount}]: a POLLEN in the drawn mouth is a capture candidate`, insideOk);
    check(`mouths [${intakeMount}]: a POLLEN beyond the drawn mouth is NOT`, outsideOk);
    const f = bbFootprint(r.spec);
    check(
      `mouths [${intakeMount}]: no mouth reaches past the collision footprint`,
      mouths.every((m) => m.x1 <= f.front + 1e-9 && m.x0 >= -f.rear - 1e-9 && Math.abs(m.y0) <= f.half + 1e-9 && Math.abs(m.y1) <= f.half + 1e-9),
      `footprint front=${f.front} rear=${f.rear} half=${f.half}`,
    );
  }

  // ── WHAT IS SOLID TO A POLLEN IS THIS GAME'S HARDWARE, ON THIS GAME'S EDGES ─
  for (const intakeMount of BB_INTAKE_MOUNTS) {
    const world = mkWorld('free', 3, { intakeMount });
    const r = world.robots[0];
    r.pos = { x: 0, y: 0 };
    r.heading = 0;
    const hl = r.spec.length / 2;
    const hw = r.spec.width / 2;
    const reach = C.INTAKE_PRESETS[r.spec.intake].reach;
    const sol = bbRobotSolids(r, [], BB_POLLEN_R);
    const mounted = new Set(bbMouths(r.spec).map((m) => m.edge));
    const chassis = sol.chassis;
    check(
      `solids [${intakeMount}]: the chassis solid IS the chassis box`,
      chassis.kind === 'box' && Math.abs(chassis.hx - hl) < 1e-9 && Math.abs(chassis.hy - hw) < 1e-9 && chassis.cx === 0 && chassis.cy === 0,
    );
    const edgeOf = (sh: { kind: string; cx?: number; cy?: number }): string => {
      const cx = sh.cx ?? 0;
      const cy = sh.cy ?? 0;
      if (cx > hl) return 'front';
      if (cx < -hl) return 'back';
      if (cy > hw) return 'left';
      if (cy < -hw) return 'right';
      return 'inside-the-frame';
    };
    const edges = sol.structure.map((sh) => edgeOf(sh as { kind: string; cx?: number; cy?: number }));
    check(
      `solids [${intakeMount}]: two sweeper side plates per mounted edge, and none anywhere else`,
      sol.structure.length === mounted.size * 2 &&
        edges.every((e) => mounted.has(e as 'front' | 'back' | 'left' | 'right')) &&
        [...mounted].every((e) => edges.filter((x) => x === e).length === 2),
      `mounted=[${[...mounted].join(',')}] plates on [${edges.join(',')}]`,
    );
    let openOk = true;
    let plateOk = true;
    for (const m of bbMouths(r.spec)) {
      const mid =
        m.edge === 'front'
          ? { x: hl + reach - 0.1, y: 0 }
          : m.edge === 'back'
            ? { x: -hl - reach + 0.1, y: 0 }
            : m.edge === 'left'
              ? { x: 0, y: hw + reach - 0.1 }
              : { x: 0, y: -hw - reach + 0.1 };
      if (robotPenetration(r, sol, mid, BB_POLLEN_R)) openOk = false;
    }
    for (const sh of sol.structure) {
      const b = sh as { cx: number; cy: number };
      if (!robotPenetration(r, sol, { x: b.cx, y: b.cy }, BB_POLLEN_R)) plateOk = false;
    }
    check(`solids [${intakeMount}]: the sweeper MOUTH is open to a POLLEN`, openOk);
    check(`solids [${intakeMount}]: the sweeper SIDE PLATES are solid to a POLLEN`, plateOk);
    r.spec.ballStorage = Math.max(1, r.spec.ballStorage ?? 1);
    const held = [bbPollen(900, 0, 0)];
    held[0].state = { kind: 'held', robot: r.id, lx: 0, ly: 0 } as Artifact['state'];
    const withHeld = bbRobotSolids(r, held, BB_POLLEN_R);
    const plug = withHeld.held[0] as { kind: string; r: number } | undefined;
    check(
      `solids [${intakeMount}]: a HELD pollen plugs the mouth at the POLLEN radius, not DECODE's`,
      withHeld.held.length === 1 && plug?.kind === 'circle' && plug.r === BB_POLLEN_R,
      `r=${plug?.r} want ${BB_POLLEN_R} (DECODE ${C.BALL_RADIUS})`,
    );
  }

  // ── THE SEAM IS WIRED, AND IT IS NOT THE SHARED GEOMETRY ──────────────────
  {
    const mod = simModuleFor('biobuzz');
    check('seam: BIOBUZZ fills GameSimModule.artifactSolids', typeof mod.artifactSolids === 'function');
    const world = mkWorld('free', 3, { intakeMount: 'back' });
    const r = world.robots[0];
    r.pos = { x: 0, y: 0 };
    r.heading = 0;
    const mine = mod.artifactSolids?.(r, [], BB_POLLEN_R);
    const shared = robotSolids(r, [], BB_POLLEN_R);
    check('seam: the module slot returns BIOBUZZ geometry', JSON.stringify(mine) === JSON.stringify(bbRobotSolids(r, [], BB_POLLEN_R)));
    check("seam: a BACK sweeper's solids are NOT DECODE's front funnel", JSON.stringify(mine?.structure) !== JSON.stringify(shared.structure), `bb=${mine?.structure.length} shapes, shared=${shared.structure.length}`);
    check('seam: DECODE and Chain Reaction leave the slot empty (the shared geometry is untouched)', simModuleFor('decode').artifactSolids === undefined && simModuleFor('chain').artifactSolids === undefined);
  }

  // ── THE INTAKE COLLECTS WHAT IT DRIVES OVER ───────────────────────────────
  {
    const world = mkWorld('free', 11);
    const r = world.robots[0];
    r.pos = { x: -20, y: 0 };
    r.heading = 0;
    r.vel = { x: 0, y: 0 };
    r.autoIntake = false;
    r.hopper.length = 0;
    world.balls.length = 0;
    world.balls.push(bbPollen(1, -8, 0));
    const before = world.balls.length;
    run(world, cmd({ driveY: 1, intake: true }), 2);
    const held = world.balls.filter((b) => b.state.kind === 'held');
    check('intake: a POLLEN driven over is collected', r.hopper.length === 1, `hopper=${r.hopper.length}`);
    check('intake: the collected POLLEN is HELD by this robot', held.length === 1 && held[0].state.kind === 'held' && held[0].state.robot === r.id);
    check('intake: collecting conserves the POLLEN count', world.balls.length === before, `${before} -> ${world.balls.length}`);
    const idle = mkWorld('free', 11);
    const ir = idle.robots[0];
    ir.pos = { x: -20, y: 0 };
    ir.heading = 0;
    ir.vel = { x: 0, y: 0 };
    ir.autoIntake = false;
    ir.hopper.length = 0;
    idle.balls.length = 0;
    idle.balls.push(bbPollen(1, -8, 0));
    run(idle, cmd({ driveY: 1 }), 2);
    check('intake: the same drive with the intake OFF collects nothing', ir.hopper.length === 0, `hopper=${ir.hopper.length}`);
  }

  // ── THE HOPPER CAP IS THE HOPPER CAP ──────────────────────────────────────
  {
    const world = mkWorld('free', 13);
    const r = world.robots[0];
    r.pos = { x: 0, y: 0 };
    r.heading = 0;
    r.hopper.length = 0;
    world.balls.length = 0;
    const cap = bbHopperCap(r.spec);
    for (let i = 0; i <= cap; i++) world.balls.push(bbPollen(i + 1, 0, 0));
    let taken = 0;
    for (const b of [...world.balls]) if (capturePollen(world, r, b)) taken++;
    check('hopper: capture stops at the cap', taken === cap && r.hopper.length === cap, `took ${taken} of ${cap}`);
    check('hopper: the refused POLLEN is still on the ground', world.balls.filter((b) => b.state.kind === 'ground').length === 1);
    check('hopper: a full hopper still conserves the count', world.balls.length === cap + 1);
  }

  // ── RELEASE CONSERVES, AND PUTS THE POLLEN IN FLIGHT ──────────────────────
  {
    const world = mkWorld('free', 17);
    const r = world.robots[0];
    r.pos = { x: 0, y: 0 };
    r.heading = 0;
    r.hopper.length = 0;
    world.balls.length = 0;
    const cap = bbHopperCap(r.spec);
    for (let i = 0; i < cap; i++) {
      const b = bbPollen(i + 1, 0, 0);
      world.balls.push(b);
      capturePollen(world, r, b);
    }
    const before = world.balls.length;
    releasePollen(world, r, { x: 60, y: 0, z: 40 }, undefined, { x: 5, y: 0 });
    check('release: the hopper drops by exactly one', r.hopper.length === cap - 1, `hopper=${r.hopper.length}`);
    check('release: the count is conserved', world.balls.length === before, `${before} -> ${world.balls.length}`);
    const flying = world.balls.filter((b) => b.state.kind === 'flight');
    check('release: exactly one POLLEN is in flight', flying.length === 1, `n=${flying.length}`);
    check(
      'release: it leaves from the origin it was given, with the velocity it was given',
      flying.length === 1 && flying[0].pos.x === 5 && flying[0].vel.x === 60 && flying[0].vz === 40,
      flying.length === 1 ? `pos=${flying[0].pos.x},${flying[0].pos.y} vx=${flying[0].vel.x} vz=${flying[0].vz}` : '',
    );
    check('release: the POLLEN released is the LAST one captured', flying.length === 1 && flying[0].id === cap);
    const empty = mkWorld('free', 19);
    empty.robots[0].hopper.length = 0;
    const n = empty.balls.length;
    releasePollen(empty, empty.robots[0], { x: 10, y: 0, z: 10 });
    check('release: releasing from an EMPTY hopper creates nothing', empty.balls.length === n, `${n} -> ${empty.balls.length}`);
  }

  // ── FIRING THROUGH THE PIPELINE EMPTIES THE HOPPER, CONSERVING ────────────
  /**
   * Hold `fire` with a full hopper until it is empty, for every launcher. At (0, 0) a blue robot
   * is on its own cell's CLOSED side, so there is no target: a manual fire still fires (a turret
   * at the neutral speed, a dumper straight over its edge).
   */
  for (const scoreMode of BB_SCORE_MODES) {
    const world = mkWorld('free', 23, { scoreMode });
    const r = world.robots[0];
    r.pos = { x: 0, y: 0 };
    r.heading = 0;
    r.hopper.length = 0;
    world.balls.length = 0;
    const cap = bbHopperCap(r.spec);
    for (let i = 0; i < cap; i++) {
      const b = bbPollen(i + 1, r.pos.x, r.pos.y);
      world.balls.push(b);
      capturePollen(world, r, b);
    }
    const before = world.balls.length;
    // at field centre, between the own HIVE's two cells, no shot lands: Aim Assist holds fire
    run(world, cmd({ fire: true }), 1);
    check(`launch [${scoreMode}]: where no shot would land, holding fire keeps the load`, r.hopper.length === cap, `hopper=${r.hopper.length}/${cap}`);
    // ...and from the own up cell's open side it goes (a dumper is turned onto it by the assist)
    r.pos = { x: 12.75, y: 37.4 };
    r.vel = { x: 0, y: 0 };
    r.heading = -Math.PI / 2;
    const seconds = cap * BB_FIRE_INTERVAL + 3;
    run(world, cmd({ fire: true }), seconds);
    check(`launch [${scoreMode}]: holding fire empties the hopper`, r.hopper.length === 0, `hopper=${r.hopper.length} after ${seconds.toFixed(2)}s`);
    check(`launch [${scoreMode}]: launching conserves the POLLEN count`, world.balls.length === before, `${before} -> ${world.balls.length}`);
    check(`launch [${scoreMode}]: no POLLEN is left stuck HELD`, world.balls.every((b) => b.state.kind !== 'held'), `held=${world.balls.filter((b) => b.state.kind === 'held').length}`);
  }

  // ── THE ROBOT-LANE SCENES HASH DETERMINISTICALLY ──────────────────────────
  for (const scene of BB_SCENES.filter((s) => s.lane === 'robot')) {
    const last = Math.max(...scene.stills);
    const h1 = worldHash(bbSceneAt(scene, last));
    const h2 = worldHash(bbSceneAt(scene, last));
    check(`scene [${scene.id}@${last}]: hashes deterministically`, h1 === h2, `${h1} vs ${h2}`);
  }

  // ── LANE C: THE TURRET AIMS ITSELF, WITHOUT BEING ASKED ───────────────────
  /**
   * Owner playtest feedback 2026-09-18, item 4: "the shooter is not automatically aiming at the
   * target". The SIM was measured first and it aims — a turret converges on `bbTurretSolution`'s
   * yaw AND pitch in ~45-52 ticks from the staged bearing, under both physics, with no button
   * held and with the robots not even enabled. The failure was in the 3D RENDERER (see the RENDER
   * lane's turret-node block for the measurement). These checks pin the sim half so a change to
   * stage 5b cannot quietly take the tracking away and leave the picture right.
   *
   * ⚠️ NO COMMAND IS HELD. A turret that only tracked while fire was down would pass an aim test
   * written with `fire: true` and still look dead to a driver lining up, which is exactly what the
   * feedback describes.
   */
  {
    const AIM_C = mech({ launcher: { kind: 'turret', mount: 'center', hoodDeg: 75 }, lift: null });
    /** where a converging turret's error stands after `secs` of idle stepping, and after how many
     * ticks it first got inside `BB_AIM_TOL` on both axes. */
    const converge = (x: number, y: number, secs: number): { yaw: number; pitch: number; ticks: number } => {
      const w = mkWorld('free', 131, AIM_C);
      const r = w.robots[0];
      park(r, x, y, 0.7);
      let ticks = -1;
      const n = Math.round(secs / C.SIM_DT);
      for (let i = 0; i < n; i++) {
        tick(w, cmd({}));
        const s = bbTurretSolution(r, bbAimTarget(w, r), 0);
        if (
          ticks < 0 &&
          s &&
          Math.abs(wrapAngle(s.yaw - r.turretHeading)) < BB_AIM_TOL &&
          Math.abs(s.pitch - (r.bbTurretPitch ?? 0)) < BB_AIM_TOL
        ) {
          ticks = i + 1;
        }
      }
      const s = bbTurretSolution(r, bbAimTarget(w, r), 0)!;
      return {
        yaw: Math.abs(wrapAngle(s.yaw - r.turretHeading)),
        pitch: Math.abs(s.pitch - (r.bbTurretPitch ?? 0)),
        ticks,
      };
    };
    for (const [x, y] of [[0, 0], [30, 20], [-20, -40], [50, -30], [10, 55]] as const) {
      const c = converge(x, y, 2);
      check(
        `aim: a turret at (${x}, ${y}) converges on its own solution with NO button held`,
        c.ticks > 0 && c.ticks <= 90 && c.yaw < 1e-3 && c.pitch < 1e-3,
        `ticks=${c.ticks} yawErr=${c.yaw.toFixed(5)} pitchErr=${c.pitch.toFixed(5)}`,
      );
    }
    // and it SLEWS rather than snapping: one tick can never move the yaw more than the slew rate
    {
      const w = mkWorld('free', 133, AIM_C);
      const r = w.robots[0];
      park(r, -40, -50, 0.7);
      const before = r.turretHeading;
      tick(w, cmd({}));
      check(
        'aim: the turret SLEWS — one tick moves it at most BB_TURRET_SLEW · dt',
        Math.abs(wrapAngle(r.turretHeading - before)) <= BB_TURRET_SLEW * C.SIM_DT + 1e-9,
        `${Math.abs(wrapAngle(r.turretHeading - before)).toFixed(5)} vs ${(BB_TURRET_SLEW * C.SIM_DT).toFixed(5)}`,
      );
    }
  }

  // ── AND NOTHING IN THIS LANE READS THE CLOCK ──────────────────────────────
  {
    const a = mkWorld('free', 29);
    const b = mkWorld('free', 29);
    run(a, cmd({ driveY: 1, intake: true, fire: true }), 4);
    run(b, cmd({ driveY: 1, intake: true, fire: true }), 4);
    check('determinism: two identical robot runs hash identically', worldHash(a) === worldHash(b), `${worldHash(a)} vs ${worldHash(b)}`);
    check('determinism: ...after exactly the expected number of ticks', a.tick === Math.round(4 / C.SIM_DT), `tick=${a.tick}`);
  }

  /**
   * ⚠️ PASS DELIVERS TO ITS POINT, AND ONLY WHEN THE TURRET IS ON IT.
   *
   * `bbPass` retargets the ONE turret solver at a field point (`bbPassTargetOf`) instead of the
   * hive: the player's own `spec.bbPassTarget`, or the alliance's LOADING ZONE when they never
   * set one. It never reads the partner's pose — owner, 2026-09-21: “in real life, you can't
   * know where your opponent is accurately” — so the target is a fixed point either way.
   *
   * ⚠️ THE ON-TARGET GATE IS WHAT THIS CHECK IS REALLY FOR. A solved arc says a shot EXISTS,
   * not that the hardware has slewed onto it. The hive path never had to say so out loud,
   * because `bbTurretShotEnters` forward-simulates from the turret's CURRENT pose and a turret
   * still slewing simply misses the cell. A pass has no cell to miss, so without
   * `bbTurretOnTarget` it releases on the first tick of the press and throws wherever the turret
   * happened to be facing: MEASURED, three passes at a 102-in preset landed 34.8, 64.2 and 78.3
   * in short. With the gate they land inside 6 in, which is what the bound below is set from.
   */
  {
    const NEAR = 8; // in — worst measured is 6.6; a miss without the on-target gate is 34+
    /**
     * ⚠️ **3D IS MEASURED AT CLOSEST APPROACH, NOT WHERE THE ELEMENT COMES TO REST, AND THE
     * DIFFERENCE IS NOT A FUDGE.** Under Rapier the element lands and then ROLLS — bounce and
     * roll on the tiles are real there and scripted away in 2D. MEASURED, three passes at the
     * 101.7-in preset:
     *
     *     closest approach 0.3, 0.3, 0.3 in   →  final rest 32.3, 32.9, 34.2 in
     *     and at a mid-field point (40, -40): closest 0.3-1.0  →  final 4.8-11.4
     *
     * DELIVERY is what the aiming system controls and what a driver is judged on, and it is
     * sub-inch. Where it then rolls to is a property of the TARGET — the preset sits one
     * radius off the wall (`bbLoadingZoneSpot`, shared with staging and the human player's own
     * entry, both of which want exactly that) and an element arriving there at speed runs on
     * down the wall. Asserting rest position would therefore pin field geometry under the guise
     * of pinning the shooter, and would have to be loosened to ~35 in — wide enough to hide a
     * genuinely bad shot.
     */
    const NEAR_3D = 3;
    /* THE PRESET SWEEP'S BOUND, one number for both backends because it is deliberately loose:
       what it has to separate is "delivered" from the 26-in scatter a blocked flight produces,
       not 1 in from 3 in. Worst measured across all four presets in both backends is ~7 in. */
    const DELIVER = 12;
    /* the settle bound is a SANITY rail, not an accuracy claim: it catches an element that
       left the field or never stopped, and nothing finer. See the note above. */
    const SETTLE_3D = 40;
    const throwTo = (target?: Vec2): { worst: number; thrown: number; inHive: number; pt: Vec2 } => {
      const w = mkWorld('free', 5, 'biobuzz');
      const r = w.robots[0];
      if (target) r.spec = { ...r.spec, bbPassTarget: target };
      w.balls.length = 0;
      for (const f of w.biobuzz!.flowers) f.stack = [];
      w.biobuzz!.hives.red.contents = [];
      w.biobuzz!.hives.blue.contents = [];
      r.hopper = ['yellow', 'yellow', 'yellow'];
      r.hopper.forEach((c, i) => {
        w.balls.push({
          id: i + 1, color: c, state: { kind: 'held', robot: r.id, slot: i },
          pos: { x: r.pos.x, y: r.pos.y }, vel: { x: 0, y: 0 }, z: 0, vz: 0, r: BB_POLLEN_R,
        } as Artifact);
      });
      const pt = bbPassPoint(r);
      run(w, cmd({ bbPass: true }), 8);
      const loose = w.balls.filter((b) => b.state.kind === 'ground');
      const worst = loose.length
        ? Math.max(...loose.map((b) => hyp(b.pos.x - pt.x, b.pos.y - pt.y)))
        : Infinity;
      return { worst, thrown: 3 - r.hopper.length, inHive: w.biobuzz!.hives.red.contents.length + w.biobuzz!.hives.blue.contents.length, pt };
    };

    const preset = throwTo();
    check(
      '⚠️ pass: the PRESET throws all three to the alliance LOADING ZONE, and none of them scores',
      preset.thrown === 3 && preset.worst < NEAR && preset.inHive === 0,
      `thrown ${preset.thrown}/3, worst ${preset.worst.toFixed(1)}in from (${preset.pt.x.toFixed(1)}, ${preset.pt.y.toFixed(1)}), in a hive ${preset.inHive}`,
    );

    const custom = throwTo({ x: 40, y: -40 });
    check(
      'pass: a CUSTOM `bbPassTarget` is where they land instead',
      custom.thrown === 3 && custom.worst < NEAR && Math.abs(custom.pt.x - 40) < 1e-9 && Math.abs(custom.pt.y + 40) < 1e-9,
      `thrown ${custom.thrown}/3, worst ${custom.worst.toFixed(1)}in from (${custom.pt.x.toFixed(1)}, ${custom.pt.y.toFixed(1)})`,
    );

    /**
     * ⚠️ **AND THE SAME THING IN 3D, WHICH IS WHERE IT ACTUALLY HAS TO WORK.**
     *
     * The pass shipped wired into the 2D pipeline and NOWHERE in the 3D one — `bbPass` did not
     * appear in `sim3d/elements3d.ts` at all, so `target` was always the hive and `asking` read
     * `fire` alone. Pressing pass in 3D did nothing whatsoever: no shot, no hopper change, no
     * error. And 3D is not the minority path: `docs/area/biobuzz.md` has EVERY server-connected
     * match running 3D, and `GameSettings.practicePhysics` defaults to `'3d'` for solo too. So
     * the feature worked only under the backend almost nobody plays, and the owner reported it
     * as "I'm not sure if the passing feature is working".
     *
     * ⚠️ THE CHECK ABOVE COULD NOT HAVE CAUGHT THAT, AND THAT IS THE LESSON: it was written
     * against `mkWorld`, which is 2D. A behaviour the two backends are supposed to SHARE has to
     * be asserted of both, or a whole feature can be missing from one and every test still pass.
     * `thrown === 3` is the load-bearing half here — the old code's failure was silence, not
     * inaccuracy.
     */
    {
      const throwTo3d = (target?: Vec2): { worst: number; closest: number; thrown: number; pt: Vec2 } => {
        const w = mkWorld3d('free', 5);
        const r = w.robots[0];
        if (target) r.spec = { ...r.spec, bbPassTarget: target };
        w.balls.length = 0;
        for (const f of w.biobuzz!.flowers) f.stack = [];
        w.biobuzz!.hives.red.contents = [];
        w.biobuzz!.hives.blue.contents = [];
        r.hopper = ['yellow', 'yellow', 'yellow'];
        r.hopper.forEach((c, i) => {
          w.balls.push({
            id: i + 1, color: c, state: { kind: 'held', robot: r.id, slot: i },
            pos: { x: r.pos.x, y: r.pos.y }, vel: { x: 0, y: 0 }, z: 0, vz: 0, r: BB_POLLEN_R,
          } as Artifact);
        });
        const pt = bbPassPoint(r);
        /* STEPPED BY HAND rather than through `run`, because the number that matters is the
           CLOSEST the element ever got to the point — see the `NEAR_3D` note. After it settles
           that information is gone. */
        const closestOf = new Map<number, number>();
        const cmds = new Map([[0, cmd({ bbPass: true })]]);
        for (let i = 0; i < Math.round(8 / C.SIM_DT); i++) {
          biobuzzStep(w, C.SIM_DT, cmds);
          for (const b of w.balls) {
            const d = hyp(b.pos.x - pt.x, b.pos.y - pt.y);
            if (!closestOf.has(b.id) || d < closestOf.get(b.id)!) closestOf.set(b.id, d);
          }
        }
        /* `element` counts too: a 3D pass that has come to rest on the tiles is settled by the
           same predicate the hive path uses, so accepting only `ground` would under-count a
           landed pass and read as a miss. */
        const loose = w.balls.filter((b) => b.state.kind === 'ground' || b.state.kind === 'element');
        const worst = loose.length
          ? Math.max(...loose.map((b) => hyp(b.pos.x - pt.x, b.pos.y - pt.y)))
          : Infinity;
        const closest = loose.length ? Math.max(...loose.map((b) => closestOf.get(b.id) ?? Infinity)) : Infinity;
        return { worst, closest, thrown: 3 - r.hopper.length, pt };
      };

      const fmt = (v: number): string => (v === Infinity ? 'nothing landed' : `${v.toFixed(1)}in`);
      const p3 = throwTo3d();
      check(
        '⚠️ pass 3D: the PRESET actually THROWS — in 3D the button used to do nothing at all',
        p3.thrown === 3,
        `thrown ${p3.thrown}/3`,
      );
      check(
        'pass 3D: ...and every one is DELIVERED to the point, not to the hive',
        p3.closest < NEAR_3D,
        `worst closest approach ${fmt(p3.closest)} to (${p3.pt.x.toFixed(1)}, ${p3.pt.y.toFixed(1)}), bound ${NEAR_3D}in · settles at ${fmt(p3.worst)}`,
      );
      check(
        'pass 3D: ...and none of them leaves the field or rolls forever',
        p3.worst < SETTLE_3D,
        `worst rest ${fmt(p3.worst)}, rail ${SETTLE_3D}in`,
      );
      const c3 = throwTo3d({ x: 40, y: -40 });
      check(
        'pass 3D: a CUSTOM `bbPassTarget` is honoured here too',
        c3.thrown === 3 && c3.closest < NEAR_3D && Math.abs(c3.pt.x - 40) < 1e-9 && Math.abs(c3.pt.y + 40) < 1e-9,
        `thrown ${c3.thrown}/3, worst closest ${fmt(c3.closest)}, settles at ${fmt(c3.worst)}`,
      );
    }

    /**
     * ── THE NAMED PRESETS (`passTargets.ts`) ───────────────────────────────────────────────
     *
     * Owner, 2026-09-22: "Pass should be passing towards the other side of the goal at a
     * specific point. Where to pass should also be configurable using a map and there should be
     * presets." The map is the UI half; this is the geometry half.
     *
     * ⚠️ WHAT MAKES A PRESET WRONG IS NOT USUALLY ITS ARITHMETIC. Every one of these points
     * is trivially computable and every one could still be a bad place to throw: inside a hive
     * cell (a "pass" that scores), off the field, on the thrower's OWN side, mirrored across the
     * wrong axis for red, or — the one that actually happened — on the hive's own axis, so the
     * flight goes THROUGH the structure. So these check the properties, and then MEASURE a real
     * pass at each one in both backends.
     */
    {
      const ENDS: readonly (readonly [string, Vec2])[] = [
        ['TOP', { x: 34, y: 60 }],
        ['BOTTOM', { x: 46, y: -60 }],
      ];

      /**
       * ⚠️ **EVERY BIOBUZZ-ONLY SPEC FIELD MUST BE CARRIED ACROSS `coerceSpec`, AND THIS BUG
       * HAS NOW SHIPPED THREE TIMES.**
       *
       * `src/sim/spawn.ts`'s `coerceSpec` builds its output from `base` and copies BIOBUZZ-only
       * fields onto it BY NAME, because no shared pass knows them. A field that lands on
       * `RobotSpec` without a line in that block is already gone by the time
       * `coerceBiobuzzSpec` runs — so it reverts to the base spec's value on every load, every
       * wire ingress and every `createWorld`, which reads to a player as "the builder keeps
       * forgetting my setting".
       *
       * The casualties so far: `bbMech` (the whole mechanism loadout), then
       * `heightIn`/`stowHeightIn`, then `bbPassTarget`/`bbPassPreset` — that last pair found
       * only by driving the real picker in a browser and watching clicks do nothing, with the
       * click handler firing correctly the whole time. `spawn.ts` documents the trap in a ⚠️
       * block and asks the next person to remember. Three misses is enough to say a comment is
       * not the right instrument.
       *
       * GREPPED, not driven, and deliberately: the failure is a MISSING LINE, so what has to be
       * compared is the set of fields that exist against the set that are carried. Round-tripping
       * a spec would also work but only for the fields somebody thought to put in the fixture —
       * which is the same blind spot that caused all three.
       */
      {
        const typesSrc = readFileSync('src/types.ts', 'utf8');
        const spawnSrc = readFileSync('src/sim/spawn.ts', 'utf8');
        /* the RobotSpec interface only — `RobotState` and the wire types have `bb*` members too
           and are not this function's business. */
        const at = typesSrc.indexOf('export interface RobotSpec');
        const specBody = typesSrc.slice(at, typesSrc.indexOf('\n}', at));
        const declared = [...specBody.matchAll(/^ {2}(bb[A-Za-z0-9_]*)\??:/gm)].map((m) => m[1]);
        /* the biobuzz arm of `coerceSpec`, from the game test to its return — scoped so a
           mention of the field ANYWHERE else in the file cannot satisfy this. */
        const armAt = spawnSrc.indexOf("if (game === 'biobuzz')");
        const arm = spawnSrc.slice(armAt, spawnSrc.indexOf('return coerceBiobuzzSpec', armAt));
        const missing = declared.filter((f) => !arm.includes(`out.${f} =`));
        check(
          '⚠️ spec: EVERY `bb*` field on RobotSpec is carried across coerceSpec (3 fields have shipped without it)',
          declared.length > 0 && missing.length === 0,
          declared.length === 0
            ? 'FOUND NO bb* FIELDS — the interface scan broke, not the carry-across'
            : `${declared.length} declared: ${declared.join(', ')} · missing: ${missing.join(', ') || 'none'}`,
        );
        /* AND THE TWO THAT ARE NOT `bb`-PREFIXED, named because the scan above cannot find them:
           `heightIn`/`stowHeightIn` are BIOBUZZ-only despite reading like shared fields, which is
           precisely why they were the second casualty. */
        for (const f of ['heightIn', 'stowHeightIn']) {
          check(`spec: ...and \`${f}\`, BIOBUZZ-only despite the shared-sounding name`, arm.includes(`out.${f} =`));
        }
      }

      // (a) THE REGISTRY IS COMPLETE. A preset with no label ships as a blank radio button.
      check(
        'pass presets: every id has a LABEL and a HINT — a nameless preset is a blank control',
        BB_PASS_PRESETS.every((k) => (BB_PASS_PRESET_LABEL[k] ?? '').length > 0 && (BB_PASS_PRESET_HINT[k] ?? '').length > 0),
        BB_PASS_PRESETS.filter((k) => !BB_PASS_PRESET_LABEL[k] || !BB_PASS_PRESET_HINT[k]).join(',') || 'all named',
      );
      check('pass presets: the default is one of them', BB_PASS_PRESETS.includes(BB_PASS_PRESET_DEFAULT));

      // (b) IN THE FIELD, and clear of BOTH hive cells — a pass that scores is not a pass.
      const off: string[] = [];
      const inCell: string[] = [];
      const wrongSide: string[] = [];
      const notMirrored: string[] = [];
      for (const k of BB_PASS_PRESETS) {
        for (const [endName, from] of ENDS) {
          for (const a of ['blue', 'red'] as const) {
            const q = bbPassPresetPoint(k, a, a === 'red' ? { x: -from.x, y: -from.y } : from);
            if (Math.abs(q.x) > BB_HALF_X || Math.abs(q.y) > BB_HALF_Y) off.push(`${k}/${a}/${endName}`);
            /* CLEAR OF THE CELL by more than the cell's own reach plus an element radius. The
               cell opening is centred `BB_HIVE_CELL_DY` off the pivot and runs
               `BB_HIVE_CELL_LEN` along the bar, so anything inside half that of a cell centre
               is in the mouth. */
            const clearance = Math.min(
              ...(['north', 'south'] as const).map((side) => {
                const c = hiveCellPos(a, side);
                return hyp(q.x - c.x, q.y - c.y);
              }),
            );
            if (clearance < BB_HIVE_CELL_LEN / 2 + BB_POLLEN_R) inCell.push(`${k}/${a}/${endName} ${clearance.toFixed(1)}in`);
          }
          /* (c) POINT SYMMETRY. Red's answer must be blue's answer mirrored through the ORIGIN,
             not reflected in x: the BIOBUZZ layout is 180°-symmetric, so a preset built by
             negating x alone lands in the wrong half. Asked with each alliance's own mirrored
             thrower, which is the only way the relative presets can agree. */
          const b = bbPassPresetPoint(k, 'blue', from);
          const rd = bbPassPresetPoint(k, 'red', { x: -from.x, y: -from.y });
          if (Math.abs(rd.x + b.x) > 1e-9 || Math.abs(rd.y + b.y) > 1e-9) {
            notMirrored.push(`${k}/${endName}: blue(${b.x.toFixed(1)},${b.y.toFixed(1)}) red(${rd.x.toFixed(1)},${rd.y.toFixed(1)})`);
          }
          /* (d) THE TWO RELATIVE PRESETS FACE AWAY FROM THE THROWER. This is the whole meaning
             of "the other side of the goal", and it is the property a sign error kills silently:
             a red pass aimed at red's own end still lands on the field and still looks fine in
             a unit test that only checks bounds. */
          for (const k2 of ['pastGoal', 'farEnd'] as const) {
            if (k !== k2) continue;
            const q = bbPassPresetPoint(k2, 'blue', from);
            if (Math.sign(q.y) === Math.sign(from.y)) wrongSide.push(`${k2}/blue/${endName}`);
            const qr = bbPassPresetPoint(k2, 'red', { x: -from.x, y: -from.y });
            if (Math.sign(qr.y) === Math.sign(-from.y)) wrongSide.push(`${k2}/red/${endName}`);
          }
        }
      }
      check('pass presets: every point is INSIDE the field', off.length === 0, off.join(' ') || 'all in');
      check(
        '⚠️ pass presets: ...and none sits in a hive cell — a pass that SCORES is not a pass',
        inCell.length === 0,
        inCell.join(' ') || 'all clear',
      );
      check(
        '⚠️ pass presets: red is blue MIRRORED THROUGH THE ORIGIN, not reflected in x',
        notMirrored.length === 0,
        notMirrored.join(' ') || 'point-symmetric',
      );
      check(
        '⚠️ pass presets: `pastGoal` and `farEnd` are on the FAR side of the thrower, both alliances',
        wrongSide.length === 0,
        wrongSide.join(' ') || 'all far-side',
      );

      // (e) PRECEDENCE, which the picker depends on: a map pick beats a preset.
      {
        const w = mkWorld('free', 5);
        const r = w.robots[0];
        r.spec = { ...r.spec, bbPassPreset: 'loadingZone', bbPassTarget: { x: 5, y: -5 } };
        const pt = bbPassPoint(r);
        check(
          '⚠️ pass presets: an explicit `bbPassTarget` BEATS the preset — the picker clears one to use the other',
          Math.abs(pt.x - 5) < 1e-9 && Math.abs(pt.y + 5) < 1e-9,
          `(${pt.x.toFixed(1)}, ${pt.y.toFixed(1)})`,
        );
        r.spec = { ...r.spec, bbPassTarget: undefined, bbPassPreset: 'nonsense-from-a-newer-build' };
        const d = bbPassPoint(r);
        const want = bbPassPresetPoint(BB_PASS_PRESET_DEFAULT, r.alliance, r.pos);
        check(
          'pass presets: ...and an UNKNOWN id resolves to the default, not to nothing',
          Math.abs(d.x - want.x) < 1e-9 && Math.abs(d.y - want.y) < 1e-9,
          `(${d.x.toFixed(1)}, ${d.y.toFixed(1)}) vs default (${want.x.toFixed(1)}, ${want.y.toFixed(1)})`,
        );
      }

      /* (f) AND EACH ONE ACTUALLY DELIVERS, in BOTH backends, scoring nothing. This is the half
         that caught the real bug: `pastGoal` began on the hive's own axis and MEASURED in 3D the
         three elements scattered to (68.9, -31.4), (35.0, -13.1) and (-11.6, -39.6) — the flight
         crossed the hive, which is a collider there and is not in 2D. Bounds-checking the point
         would never have found it; only throwing at it does. */
      for (const k of BB_PASS_PRESETS) {
        for (const phys of ['2d', '3d'] as const) {
          const w = phys === '2d' ? mkWorld('free', 5) : mkWorld3d('free', 5);
          const r = w.robots[0];
          r.spec = { ...r.spec, bbPassPreset: k };
          /**
           * ⚠️ THE ROBOT'S OWN PRELOADS, NOT HAND-BUILT HELD BALLS. Pushing
           * `{ kind: 'held', robot, slot }` artifacts by hand — which the older fixture just
           * above still does — produces held elements whose position is NaN on tick 0, MEASURED,
           * in 2D. It resolves the moment they launch, so a check that reads only settled
           * positions never notices; one that samples every tick gets NaN and reads as "nothing
           * landed". The world already preloads a full hopper through the real path, and those
           * are finite from the first tick, so there is nothing to hand-build.
           */
          const held = w.balls.filter(
            (b) => b.state.kind === 'held' && (b.state as { robot: number }).robot === r.id,
          );
          const ids = held.map((b) => b.id);
          w.balls.length = 0;
          w.balls.push(...held);
          for (const f of w.biobuzz!.flowers) f.stack = [];
          w.biobuzz!.hives.red.contents = [];
          w.biobuzz!.hives.blue.contents = [];
          const loaded = r.hopper.length;
          const pt = bbPassPoint(r);
          const near = new Map<number, number>();
          const cs = new Map([[0, cmd({ bbPass: true })]]);
          for (let i = 0; i < Math.round(8 / C.SIM_DT); i++) {
            biobuzzStep(w, C.SIM_DT, cs);
            for (const b of w.balls) {
              if (!Number.isFinite(b.pos.x) || !Number.isFinite(b.pos.y)) continue;
              const d = hyp(b.pos.x - pt.x, b.pos.y - pt.y);
              const prev = near.get(b.id);
              if (prev === undefined || d < prev) near.set(b.id, d);
            }
          }
          const thrown = loaded - r.hopper.length;
          const scored = w.biobuzz!.hives.red.contents.length + w.biobuzz!.hives.blue.contents.length;
          /* only the preloads: a restock can add a NECTAR mid-run and its distance to the pass
             point is not a fact about the pass. */
          const worst = Math.max(...ids.map((id) => near.get(id) ?? Infinity));
          check(
            `pass preset ${k} (${phys}): every preload thrown, delivered, and NOTHING scored`,
            thrown === loaded && loaded > 0 && worst < DELIVER && scored === 0,
            `thrown ${thrown}/${loaded}, worst closest ${worst === Infinity ? 'nothing landed' : worst.toFixed(1) + 'in'}, scored ${scored}, target (${pt.x.toFixed(0)}, ${pt.y.toFixed(0)})`,
          );
        }
      }
    }

    // the CONTROL: the same build holding FIRE still aims at the HIVE and still scores.
    const w = mkWorld('free', 5, 'biobuzz');
    const r = w.robots[0];
    w.balls.length = 0;
    for (const f of w.biobuzz!.flowers) f.stack = [];
    w.biobuzz!.hives.red.contents = [];
    w.biobuzz!.hives.blue.contents = [];
    r.hopper = ['yellow', 'yellow', 'yellow'];
    r.hopper.forEach((c, i) => {
      w.balls.push({
        id: i + 1, color: c, state: { kind: 'held', robot: r.id, slot: i },
        pos: { x: r.pos.x, y: r.pos.y }, vel: { x: 0, y: 0 }, z: 0, vz: 0, r: BB_POLLEN_R,
      } as Artifact);
    });
    run(w, cmd({ fire: true }), 8);
    const scored = w.biobuzz!.hives.red.contents.length + w.biobuzz!.hives.blue.contents.length;
    check(
      'pass: ...and FIRE is untouched — the same build still shoots its own HIVE',
      scored === 3,
      `${scored}/3 in a hive on the fire control`,
    );
  }
}
