import type { Artifact, RobotCommand, RobotSpec, RobotState, World } from '../../src/types';
import * as C from '../../src/config';
import { wrapAngle } from '../../src/math';
import { worldHash } from '../../src/net/checksum';
import { defaultSettings, switchGame } from '../../src/settings';
import { DEFAULT_SPEC } from '../../src/sim/spawn';
import {
  BB_AIM_TOL,
  BB_DEG,
  BB_DUMP_RELOAD_S,
  BB_FIRE_INTERVAL,
  BB_FLOWER_D,
  BB_FLOWER_FOOT,
  BB_FLOWER_TOP_Z,
  BB_FLOWERS,
  BB_HIVE_OPEN_Z,
  BB_HOOD_DEFAULT_DEG,
  BB_HOOD_MAX_DEG,
  BB_HOOD_MIN_DEG,
  BB_LAUNCH_SPEED_MAX,
  BB_LAUNCH_Z0,
  BB_PLACE_REACH,
  BB_POLLEN_R,
  BB_PTS,
  BB_TURRET_PITCH_MAX,
  bbStorageMax,
} from '../../src/games/biobuzz/config';
import { capturePollen, pollenIn, releasePollen, scoreTargets, takeHeld } from '../../src/games/biobuzz/elements';
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
  bbAimHeading,
  bbAimPitch,
  bbDumpSolution,
  bbFlowerInReach,
  bbFootprint,
  bbHoodDescends,
  bbHoodSpeed,
  bbHopperCap,
  bbMouths,
  bbMuzzleZ,
  bbPlacePoint,
  bbPlacePointLocal,
  bbRobotSolids,
  bbSolveShot,
  bbTurretOrigin,
  bbTurretSolution,
} from '../../src/games/biobuzz/robot';
import { bbConfigSummary } from '../../src/games/biobuzz/labels';
import { bbKindOf, bbPickTarget } from '../../src/games/biobuzz/play';
import {
  bbCarriesNectar,
  bbCellsAdjacent,
  bbIntakeAccepts,
  bbIsTurreted,
  bbLauncherBlocker,
  bbLauncherOf,
  bbLiftOf,
} from '../../src/games/biobuzz/mechs';
import { flowerFits, flowerScore } from '../../src/games/biobuzz/flower';
import { biobuzzHud } from '../../src/games/biobuzz/hudRobot';
import { bbIndexElements } from '../../src/games/biobuzz/spawn';
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
import { bbCoerce, cmd, mkWorld, run, type Check } from './harness';

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

  // ── THE DUMPER'S HOOD REACHES THE HIVE ────────────────────────────────────
  /**
   * EVERY BUILDABLE HOOD SCORES FROM SOMEWHERE. The up-CELL accepts only a DESCENDING element, a
   * dump's speed is capped, and a robot on the open side has a limited stand-off — so the hood
   * range is exactly the set of angles that still has an accepted distance. This replaces the
   * old pin that NO turretless hood reached the HIVE: the owner ruled that a dumper must.
   */
  {
    const dh = (BB_HIVE_OPEN_Z[0] + BB_HIVE_OPEN_Z[1]) / 2 - BB_LAUNCH_Z0;
    for (let deg = BB_HOOD_MIN_DEG; deg <= BB_HOOD_MAX_DEG; deg++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let d = 1; d <= 150; d += 0.5) {
        const v = bbHoodSpeed(d, dh, deg * BB_DEG);
        if (v !== null && v <= BB_LAUNCH_SPEED_MAX && bbHoodDescends(d, dh, deg * BB_DEG)) {
          lo = Math.min(lo, d);
          hi = Math.max(hi, d);
        }
      }
      check(`dump hood ${deg}°: an accepted (descending, under the cap) distance exists`, hi >= lo, `${lo}–${hi} in`);
    }
    const th = 75 * BB_DEG;
    const v = bbHoodSpeed(40, dh, th)!;
    const t = 40 / (v * Math.cos(th));
    const rise = v * Math.sin(th) * t - 0.5 * C.GRAVITY * t * t;
    check('dump: the hood-speed formula passes through the target height', Math.abs(rise - dh) < 1e-6, `rise=${rise} dh=${dh}`);
    check('dump: a hood too flat for the rise has no speed', bbHoodSpeed(10, 60, 20 * BB_DEG) === null);
  }

  // ── TARGET SELECTION: HIVE ONLY, OWN CELL, OPEN SIDE ─────────────────────
  /**
   * Launchers aim at HIVE cells only (owner ruling 2026-09-12 — a FLOWER is placed into, never
   * shot into), never at the opponent's cell, and only from the side a cell's mouth opens to.
   * Property checks over a grid: the expected pick count is DERIVED from the own cell's open
   * half-plane, so the check keeps meaning something when the HIVE moves.
   */
  {
    const w = mkWorld('free', 41);
    const r = w.robots[0]; // blue
    const own = scoreTargets(w, r.alliance).find((t) => t.id === `hive:${r.alliance}`)!;
    let picked = 0;
    let expected = 0;
    let oppWouldHaveWon = 0;
    let badAlliance = 0;
    let badMouth = 0;
    let notHive = 0;
    for (let x = -66; x <= 66; x += 6) {
      for (let y = -66; y <= 66; y += 6) {
        r.pos = { x, y };
        if ((x - own.pos.x) * own.mouth!.x + (y - own.pos.y) * own.mouth!.y > 0) expected++;
        // What nearest-by-distance ALONE would have chosen among the HIVE cells. It is measured
        // over the FIELD-WIDE list (both alliances, merged), not over the one this robot is
        // offered: since the owner's ruling of 2026-09-12 `scoreTargets(w, a)` already drops the
        // opponent's cell, so asking it alone would make this check vacuous by construction and
        // prove nothing about `bbPickTarget`'s own filter.
        const hives: ScoreTarget[] = [];
        {
          const seen = new Set<string>();
          for (const a of ['red', 'blue'] as const) {
            for (const t of scoreTargets(w, a)) {
              if (!t.id.startsWith('hive:') || seen.has(t.id)) continue;
              seen.add(t.id);
              hives.push(t);
            }
          }
        }
        let raw = hives[0];
        let rawD = Infinity;
        for (const t of hives) {
          const d = (t.pos.x - x) ** 2 + (t.pos.y - y) ** 2;
          if (d < rawD) {
            rawD = d;
            raw = t;
          }
        }
        if (raw.alliance !== r.alliance) oppWouldHaveWon++;
        const got = bbPickTarget(w, r);
        if (!got) continue;
        picked++;
        if (!got.id.startsWith('hive:')) notHive++;
        if (got.alliance !== r.alliance) badAlliance++;
        if (got.mouth && -(got.pos.x - x) * got.mouth.x + -(got.pos.y - y) * got.mouth.y <= 0) badMouth++;
      }
    }
    check('aim: a target is picked from exactly the poses on the own cell\'s open side', picked === expected && expected > 0, `picked=${picked} expected=${expected}`);
    check('aim: bbPickTarget never returns a FLOWER', notHive === 0, `${notHive} flower picks`);
    check('aim: the OPPONENT’s CELL is never aimed at', badAlliance === 0, `${badAlliance} of ${picked}`);
    check('aim: ...and that filter is not vacuous — raw nearest WOULD have picked it', oppWouldHaveWon > 100, `${oppWouldHaveWon}`);
    check('aim: a target is only ever picked from the side its MOUTH opens toward', badMouth === 0, `${badMouth}`);
  }

  // ── A TURRET SLEWS, AND ITS ARC ARRIVES (through the world) ──────────────
  {
    const w = mkWorld('free', 43, mech({ launcher: { kind: 'turret', mount: 'center', hoodDeg: BB_HOOD_DEFAULT_DEG }, lift: null }));
    const r = w.robots[0];
    park(r, 40, 50, Math.PI); // blue, on its own cell's OPEN side
    const yaw0 = r.turretHeading;
    const pitch0 = r.bbTurretPitch ?? 0;
    run(w, cmd({}), 1.5);
    const target = bbPickTarget(w, r);
    check('turret: the test pose has a target (the open side)', target !== null);
    if (target) {
      const sol = bbTurretSolution(r, target)!;
      check('turret: STEPPING THE WORLD moves the yaw axis off its spawn bearing', Math.abs(r.turretHeading - yaw0) > 1e-3, `${yaw0.toFixed(3)} -> ${r.turretHeading.toFixed(3)} rad`);
      check('turret: it settles ON the solution', Math.abs(wrapAngle(r.turretHeading - sol.yaw)) < 0.02, `yaw=${r.turretHeading.toFixed(3)} want=${sol.yaw.toFixed(3)}`);
      check('turret: the PITCH axis is driven too, and off zero', (r.bbTurretPitch ?? 0) > 0.05 && Math.abs((r.bbTurretPitch ?? 0) - pitch0) > 1e-3, `pitch=${((r.bbTurretPitch ?? 0) / BB_DEG).toFixed(1)}deg`);
      check('turret: pitch stays inside the barrel envelope', (r.bbTurretPitch ?? 0) <= BB_TURRET_PITCH_MAX + 1e-9);
      check('turret: a single turret never writes the second turret\'s fields', r.bbTurret2Heading === undefined && r.bbTurret2Pitch === undefined);
      const o = bbTurretOrigin(r);
      const d = Math.hypot(target.pos.x - o.x, target.pos.y - o.y);
      const t = d / (sol.speed * Math.cos(sol.pitch));
      const rise = sol.speed * Math.sin(sol.pitch) * t - 0.5 * C.GRAVITY * t * t;
      const want = target.z - bbMuzzleZ(r.spec);
      check('turret: the solved (speed, angle) pair lands at the target HEIGHT', Math.abs(rise - want) < 0.5, `rise=${rise.toFixed(2)} want=${want.toFixed(2)} d=${d.toFixed(1)}`);
      check('turret: the solved speed is inside the launcher ceiling', sol.speed <= BB_LAUNCH_SPEED_MAX + 1e-9, `${sol.speed.toFixed(1)}`);
    }
  }

  // ── THE DOUBLE TURRET: TWO TURRETS SLEW, TWO EXITS ────────────────────────
  {
    const w = mkWorld('free', 47, mech({ launcher: TWIN, lift: null }));
    const r = w.robots[0];
    check('twin: spawn seeds the NECTAR turret\'s yaw and pitch', typeof r.bbTurret2Heading === 'number' && r.bbTurret2Pitch === 0, `${r.bbTurret2Heading}/${r.bbTurret2Pitch}`);
    emptyHopper(w, r);
    park(r, 40, 50, Math.PI);
    const yaw0 = r.turretHeading;
    const yaw1 = r.bbTurret2Heading ?? 0;
    run(w, cmd({}), 1.5);
    const target = bbPickTarget(w, r)!;
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
    let nectarAt: { p: { x: number; y: number }; o: { x: number; y: number }; z: number } | null = null;
    let pollenAt: { p: { x: number; y: number }; o: { x: number; y: number }; z: number } | null = null;
    for (let k = 0; k < 40 && !(nectarAt && pollenAt); k++) {
      tick(w, cmd({ fire: true }));
      for (const b of w.balls) {
        if (b.state.kind !== 'flight' || seen.has(b.id)) continue;
        seen.add(b.id);
        const rec = { p: { ...b.pos }, o: bbTurretOrigin(r, b.color === 'blue' ? 1 : 0), z: b.z };
        if (b.color === 'blue') nectarAt = rec;
        else pollenAt = rec;
      }
    }
    const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);
    check('twin: a NECTAR is born at turret 1 (mount2)', !!nectarAt && dist(nectarAt.p, nectarAt.o) < 1e-6, nectarAt ? `${dist(nectarAt.p, nectarAt.o)}` : 'never fired');
    check('twin: a POLLEN is born at turret 0 (mount)', !!pollenAt && dist(pollenAt.p, pollenAt.o) < 1e-6, pollenAt ? `${dist(pollenAt.p, pollenAt.o)}` : 'never fired');
    check('twin: ...and the two exits are genuinely different points', dist(bbTurretOrigin(r, 0), bbTurretOrigin(r, 1)) > 3);
    /** THE SOLVE STARTS WHERE THE ELEMENT DOES. `bbTurretSolution` solves from `bbMuzzleZ` and
     * `releasePollen` releases at `BB_LAUNCH_Z0`; the turret once solved from 2in above the
     * release, and every turret shot arrived 2in low. Read off the world, on both turrets. */
    check(
      'twin: both turrets release at the height their arc was solved from',
      !!nectarAt && !!pollenAt && Math.abs(nectarAt.z - bbMuzzleZ(r.spec)) < 1e-9 && Math.abs(pollenAt.z - bbMuzzleZ(r.spec)) < 1e-9 && bbMuzzleZ(r.spec) === BB_LAUNCH_Z0,
      `nectar z=${nectarAt?.z} pollen z=${pollenAt?.z} solve z=${bbMuzzleZ(r.spec)}`,
    );
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
      run(w, cmd({ intake: true }), 0.1);
      const want = colour === 'yellow' || (colour === 'blue' && kind !== 'turret');
      const what = colour === 'yellow' ? 'POLLEN' : colour === 'blue' ? 'own NECTAR' : 'OPPONENT NECTAR';
      check(
        `intake [${kind}] ${what}: ${want ? 'taken' : 'left on the floor'}`,
        (b.state.kind === 'held') === want && (want || b.state.kind === 'ground'),
        `state=${b.state.kind} hopper=${r.hopper.join(',')}`,
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
      run(w, cmd({ intake: true }), 0.1);
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
    r.fireReadyAt = w.time;
    tick(w, cmd({ fire: true }));
    check('release sync: the POLLEN on top of the hopper is the element that flies', p.state.kind === 'flight' && n.state.kind === 'held', `pollen=${p.state.kind} nectar=${n.state.kind}`);
    check('release sync: ...and the hopper still matches what is held', r.hopper.join(',') === 'blue' && hopperColours(r) === heldColours(w, r), `${hopperColours(r)} vs ${heldColours(w, r)}`);
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
  const dumperWorld = (seed: number): { w: World; r: RobotState; cellY: number } => {
    const w = mkWorld('free', seed, mech({ launcher: { kind: 'dumper', mount: 'front', hoodDeg: BB_HOOD_DEFAULT_DEG }, lift: null }, { intakeMount: 'back' }));
    const r = w.robots[0];
    r.aimAssist = true;
    r.autoFire = false;
    const cell = scoreTargets(w, 'blue').find((t) => t.id === 'hive:blue')!;
    park(r, cell.pos.x, cell.pos.y + 45, -Math.PI / 2);
    return { w, r, cellY: cell.pos.y };
  };
  {
    const { w, r } = dumperWorld(53);
    const cell = bbPickTarget(w, r);
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
    // this lane's, `g417warned` the rules lane's, `nectarPress` the field lane's HUMAN PLAYER
    // latch (`play.ts` NECTAR_PRESS_KEY). A new key belongs here the day it is written — the
    // check exists to catch a latch stored under a name nobody else knows about.
    check('place: the latch is namespaced and only TRUE keys are stored', Object.entries(bb.held[r.id] ?? {}).every(([k, v]) => v === true && (k === 'placeP' || k === 'placeN' || k === 'g417warned' || k === 'nectarPress')));
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

  // ── AUTO-FIRE WAITS FOR A SHOT ────────────────────────────────────────────
  /**
   * Every robot is staged FULL and the presets ship auto-fire, so an unconditional auto-fire
   * emptied a Box Tube robot the moment the match started. Auto-fire now waits for ON TARGET.
   */
  {
    const w = mkWorld('free', 83, mech({ launcher: { kind: 'turret', mount: 'center', hoodDeg: 75 }, lift: { kind: 'vslide', mount: 'back' } }));
    const r = w.robots[0];
    r.autoFire = true;
    park(r, 40, -50, Math.PI); // blue's CLOSED side: nothing to shoot at
    const full = r.hopper.length;
    run(w, cmd({}), 2);
    check('autofire: a full robot with NO target keeps its load (it can carry it to a FLOWER)', r.hopper.length === full && full > 0, `hopper ${full}→${r.hopper.length}`);
    park(r, 40, 50, Math.PI);
    run(w, cmd({}), 3);
    check('autofire: ...and on the open side, once the turret is settled on the HIVE, it fires', r.hopper.length < full, `hopper=${r.hopper.length}`);
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
    const seconds = cap * BB_FIRE_INTERVAL + 0.5;
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

  // ── AND NOTHING IN THIS LANE READS THE CLOCK ──────────────────────────────
  {
    const a = mkWorld('free', 29);
    const b = mkWorld('free', 29);
    run(a, cmd({ driveY: 1, intake: true, fire: true }), 4);
    run(b, cmd({ driveY: 1, intake: true, fire: true }), 4);
    check('determinism: two identical robot runs hash identically', worldHash(a) === worldHash(b), `${worldHash(a)} vs ${worldHash(b)}`);
    check('determinism: ...after exactly the expected number of ticks', a.tick === Math.round(4 / C.SIM_DT), `tick=${a.tick}`);
  }
}
