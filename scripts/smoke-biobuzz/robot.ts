import type { RobotSpec } from '../../src/types';
import * as C from '../../src/config';
import { worldHash } from '../../src/net/checksum';
import { defaultSettings, switchGame } from '../../src/settings';
import { DEFAULT_SPEC } from '../../src/sim/spawn';
import { BB_FIRE_INTERVAL, BB_POLLEN_R } from '../../src/games/biobuzz/config';
import { capturePollen, pollenIn, releasePollen, scoreTargets } from '../../src/games/biobuzz/elements';
import type { ScoreTarget } from '../../src/games/biobuzz/state';
import {
  BB_INTAKE_MOUNTS,
  BB_MOUNT_POSITIONS,
  BB_SCORE_MODES,
  BB_SHOOTER_EDGES,
  isTurreted,
} from '../../src/games/biobuzz/mounts';
import { bbFootprint, bbHopperCap, bbMouths, bbRobotSolids } from '../../src/games/biobuzz/robot';
import { bbConfigSummary } from '../../src/games/biobuzz/labels';
import {
  bbAimPitch,
  bbLiftHeight,
  bbLiftSeated,
  bbSolveShot,
  bbStepLift,
  bbTurretOrigin,
  bbTurretSolution,
} from '../../src/games/biobuzz/robot';
import { bbPickTarget } from '../../src/games/biobuzz/play';
import { bbIsTurreted, bbLauncherOf, bbLiftOf } from '../../src/games/biobuzz/mechs';
import {
  BB_DEG,
  BB_FLOWER_TOP_Z,
  BB_HIVE_OPEN_Z,
  BB_HOOD_DEFAULT_DEG,
  BB_LAUNCH_Z0,
  BB_LIFT_MAX_Z,
  BB_LIFT_MIN_Z,
  BB_R105_HEIGHT_CAP,
  BB_TURRET_PITCH_MAX,
  BB_DRUM_SPEED,
  BB_HOOD_MAX_DEG,
  BB_HOOD_MIN_DEG,
  BB_TURRET_SPEED_MAX,
} from '../../src/games/biobuzz/config';
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
 * Coercion, the build space, the loadout, and the two things a BIOBUZZ robot can do to a
 * POLLEN. Everything whose subject is a MECHANISM or a SPEC rather than the field.
 *
 * Like the field lane, every check here is one that survives Kickoff. Nothing asserts a
 * capacity, a range or a rate as a NUMBER — those are all `APPROX` in `config.ts`, and an
 * assertion against a guess is a check that passes until the day the guess is replaced and
 * then fails for a reason nobody can act on. What is asserted instead are the INVARIANTS the
 * numbers have to satisfy whatever they become: the coercer is idempotent, the drawn mouths
 * are the capture areas, the hopper cap is honoured, and no mechanism ever creates or
 * destroys a POLLEN.
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

export function robotChecks(check: Check): void {
  // ── COERCION: IDEMPOTENT ──────────────────────────────────────────────────
  /**
   * `coerceSpec(raw, base, 'biobuzz')` — composed with `coerceBiobuzzSpec`, the arm Lane B
   * will fold into it; see `bbCoerce` in the harness — must be a PROJECTION. Running it twice
   * has to equal running it once.
   *
   * Why that property and not merely "it clamps": a spec is coerced on load, again when the
   * builder edits it, again at `createWorld`, and again on the server when it arrives over the
   * wire. If the function is not idempotent a robot changes shape by being TRANSMITTED, and
   * client and server then disagree about the geometry they are both simulating — which
   * presents as unexplained snapshot correction, not as a coercion bug.
   *
   * The inputs are deliberately hostile. `localStorage` is hand-editable and specs have
   * arrived off the wire with NaN dimensions from devtools, so "what the UI would send" is the
   * wrong input set for this check.
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
    ['a turretless corner mount', { ...BB_DEFAULT_SPEC, scoreMode: 'drum', shooterMount: 'frontleft' }],
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
  /**
   * The clamps and the slider bounds must be THE SAME numbers. `bbDials` is what the builder
   * renders and `coerceBiobuzzSpec` is what the world enforces; both derive from
   * `bbSizeLimits` / `massLimits` / `bbStorageMax`, and this is the check that they still do.
   *
   * Drift between them is not a crash, it is a slider that snaps back: the player drags length
   * to 18, the coercer answers 15, and the control looks broken. Checked on every hostile
   * input because the envelope is a function of the MOUNTS, so the bug would be per-build.
   */
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
        within(s.ballStorage ?? -1, d.storage),
      `L=${s.length} W=${s.width} m=${s.massLb} hop=${s.ballStorage}`,
    );
  }

  // ── THE PRESET CARDS ──────────────────────────────────────────────────────
  /**
   * A PRESET MUST BE A COERCER NO-OP. This is the load-bearing property of the whole preset
   * feature and the reason mass and storage are derived rather than typed: the builder marks a
   * card selected by asking `bbSpecMatches(spec, card)`, and the spec it asks about has been
   * through `coerceSpec`. So a card carrying any value the coercer would move is a card that
   * can never read as selected — the player clicks it, the robot changes, and nothing lights
   * up. Silent, and indistinguishable from a broken click handler.
   *
   * Checked per card rather than in bulk so a failure names the robot that drifted.
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
  }
  /**
   * Card names are React keys AND the only thing distinguishing two cards on screen, so a
   * duplicate is both a render warning and a genuinely ambiguous picker.
   */
  {
    const names = BB_PRESET_LIST.map((p) => p.name);
    check(
      'presets: every card name is unique',
      new Set(names).size === names.length,
      names.join(', '),
    );
  }
  /**
   * G407 caps CONTROL at FOUR SCORING ELEMENTS, and every published StarterBot is built to it.
   * The archetype DEMOS deliberately take their derived maximum instead — they exist to show
   * what an archetype's hopper can be — so this is asserted over the real robots only.
   *
   * Asserted as `<=`, not `===`: the rule is a ceiling. If a manufacturer's post-kickoff
   * revision carries fewer, that is a new fact and not a regression.
   */
  for (const p of BB_STARTER_BOTS) {
    check(
      `starterbot [${p.name}]: hopper honours G407's 4-element cap`,
      (p.ballStorage ?? 0) <= 4 && (p.ballStorage ?? 0) >= 1,
      `hopper=${p.ballStorage}`,
    );
  }
  /**
   * The real robots come FIRST and `realCount` says how many, because the builder marks
   * exactly the leading `realCount` cards as real. An off-by-one here mislabels an invented
   * archetype demo as a manufacturer's robot, which is the one error this feature must not
   * make: the whole point of the divider is telling a player what is documented.
   */
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

  // ── MECHANISM COMPOSITION ─────────────────────────────────────────────────
  /**
   * THE PHANTOM TURRET — the single check this whole feature is shaped around.
   *
   * `coerceSpec` writes `out.scoreMode` unconditionally and defaults it to a turret, so any
   * design that spells "this robot has no launcher" as an absent `scoreMode` grows one back on
   * the next pass. A launcher-less build is REAL (Studica's published StarterBot is a
   * drivetrain and an intake), so `launcher: null` has to survive coercion — and survive it
   * TWICE, because the coercer runs at settings load, at wire ingress and again at
   * `createWorld`.
   */
  {
    const none = bbCoerce({ ...BB_DEFAULT_SPEC, bbMech: { launcher: null, lift: null } });
    check('mech: a launcher-less build survives coercion', bbLauncherOf(none, BB_HOOD_DEFAULT_DEG) === null);
    const twice = bbCoerce(none);
    check(
      'mech: ...and survives it AGAIN (no phantom turret on the second pass)',
      bbLauncherOf(twice, BB_HOOD_DEFAULT_DEG) === null,
      `scoreMode=${twice.scoreMode}`,
    );
    check('mech: a launcher-less build is a coercion fixed point', specKey(none) === specKey(twice));
  }
  /**
   * MIGRATION. Every spec that exists today has no container and DID have a launcher, because
   * `scoreMode` was mandatory. Absence must therefore read as "migrate me", never as "none" —
   * the other half of the distinction above.
   */
  for (const mode of BB_SCORE_MODES) {
    const legacy = bbCoerce({ ...BB_DEFAULT_SPEC, bbMech: undefined, scoreMode: mode });
    const l = bbLauncherOf(legacy, BB_HOOD_DEFAULT_DEG);
    check(`mech: a legacy ${mode} spec migrates to a real launcher`, l !== null && l.kind === mode, `got ${l?.kind}`);
  }
  /**
   * THE CONTAINER IS AUTHORITATIVE. A caller that patches only `bbMech` must win; the flat
   * `scoreMode` mirrors it afterwards. This inverted once — the flat field was the source of
   * truth and a container-only edit was silently reverted, with nothing failing.
   */
  {
    const patched = bbCoerce({
      ...BB_DEFAULT_SPEC,
      scoreMode: 'turret',
      bbMech: { launcher: { kind: 'dumper', mount: 'back', hoodDeg: BB_HOOD_DEFAULT_DEG }, lift: null },
    });
    check('mech: the container wins over the flat scoreMode', bbLauncherOf(patched, BB_HOOD_DEFAULT_DEG)?.kind === 'dumper');
    check('mech: ...and the flat field is MIRRORED from it, for older peers', patched.scoreMode === 'dumper', `scoreMode=${patched.scoreMode}`);
  }
  /**
   * THE CLASH. A lift and a launcher both bolt ABOVE the deck, so unlike the sweeper they can
   * genuinely want the same cell — the first live use of `occupiedCells`/`mountsClash`. The
   * launcher wins and the lift folds around it, and the fold has to be IDEMPOTENT or the
   * coercer stops being one.
   */
  {
    const clash = bbCoerce({
      ...BB_DEFAULT_SPEC,
      bbMech: {
        launcher: { kind: 'turret', mount: 'center', hoodDeg: BB_HOOD_DEFAULT_DEG },
        lift: { kind: 'vslide', mount: 'center', maxZ: BB_LIFT_MAX_Z },
      },
    });
    const lift = bbLiftOf(clash);
    check('mech: a lift clashing with the launcher is relocated, not dropped', lift !== null && lift.mount !== 'center', `lift@${lift?.mount}`);
    check('mech: ...and the launcher keeps the cell it asked for', bbLauncherOf(clash, BB_HOOD_DEFAULT_DEG)?.mount === 'center');
    check('mech: ...and the relocation is a fixed point', specKey(clash) === specKey(bbCoerce(clash)));
  }
  /** the lift's height dial is clamped to the R105 envelope at BOTH ends. */
  {
    const tall = bbCoerce({ ...BB_DEFAULT_SPEC, bbMech: { launcher: null, lift: { kind: 'vslide', mount: 'center', maxZ: 999 } } });
    const short = bbCoerce({ ...BB_DEFAULT_SPEC, bbMech: { launcher: null, lift: { kind: 'vslide', mount: 'center', maxZ: -5 } } });
    check('mech: a lift taller than R105 is clamped to it', (bbLiftOf(tall)?.maxZ ?? 0) <= BB_R105_HEIGHT_CAP, `maxZ=${bbLiftOf(tall)?.maxZ}`);
    check('mech: a lift shorter than the floor is raised to it', (bbLiftOf(short)?.maxZ ?? 0) >= BB_LIFT_MIN_Z, `maxZ=${bbLiftOf(short)?.maxZ}`);
  }
  /**
   * THE ARC REACHES BOTH REAL TARGETS, and R105 is why there have to be two mechanisms.
   *
   * These assert REACHABILITY and the ORDERING between the two targets, never a speed or an
   * angle as a number — every constant behind them is `APPROX` and an assertion against a
   * guess fails the day the guess is replaced, for a reason nobody can act on.
   */
  {
    const cellZ = (BB_HIVE_OPEN_Z[0] + BB_HIVE_OPEN_Z[1]) / 2;
    for (const d of [24, 48, 72, 96]) {
      const flower = bbSolveShot(d, BB_FLOWER_TOP_Z - BB_LAUNCH_Z0);
      const hive = bbSolveShot(d, cellZ - BB_LAUNCH_Z0);
      check(`arc @${d}in: a solution exists for both targets`, Number.isFinite(flower.speed) && Number.isFinite(hive.speed));
      check(
        `arc @${d}in: both elevations are inside the turret envelope`,
        flower.angle <= BB_TURRET_PITCH_MAX && hive.angle <= BB_TURRET_PITCH_MAX,
        `flower ${(flower.angle / BB_DEG).toFixed(1)}deg hive ${(hive.angle / BB_DEG).toFixed(1)}deg`,
      );
      check(`arc @${d}in: the HIGHER target needs the steeper, faster shot`, hive.angle > flower.angle && hive.speed > flower.speed);
    }
  }
  /**
   * A LIFT CAN REACH A FLOWER AND CAN NEVER REACH A HIVE CELL. This is the whole reason the
   * two mechanisms are different rather than two flavours of one, and it falls out of R105's
   * 29in cap versus the two published opening heights — no rule is written by hand for it.
   */
  {
    const w = mkWorld('free', 29);
    const r = w.robots[0];
    r.spec = bbCoerce({ ...r.spec, bbMech: { launcher: null, lift: { kind: 'vslide', mount: 'center', maxZ: BB_LIFT_MAX_Z } } });
    for (let i = 0; i < 240; i++) bbStepLift(r, cmd({ bbLift: true }), C.SIM_DT);
    const top = bbLiftHeight(r);
    check('lift: holding the button tops the carriage out at its build height', Math.abs(top - BB_LIFT_MAX_Z) < 0.5, `top=${top.toFixed(2)}in`);
    check('lift: a fully raised carriage never exceeds R105', top <= BB_R105_HEIGHT_CAP + 1e-6, `top=${top.toFixed(2)}in`);
    check(
      'lift: it can NEVER seat at a HIVE CELL, from R105 alone',
      !bbLiftSeated(r, { id: 'h', alliance: 'red', pos: { x: 0, y: 0 }, z: BB_HIVE_OPEN_Z[0], r: 6 }),
      `carriage tops at ${top.toFixed(1)}in vs a cell opening at ${BB_HIVE_OPEN_Z[0]}in`,
    );
    for (let i = 0; i < 240; i++) bbStepLift(r, cmd({ bbLift: false }), C.SIM_DT);
    check('lift: releasing stows it again', (r.bbLiftZ ?? 0) < 0.01, `z=${r.bbLiftZ}`);
  }
  /** a turretless build has no pitch axis to solve, and says so rather than guessing one. */
  {
    const w = mkWorld('free', 29);
    const r = w.robots[0];
    const target = { id: 'f', alliance: null, pos: { x: 40, y: 0 }, z: BB_FLOWER_TOP_Z, r: 2 } as const;
    r.spec = bbCoerce({ ...r.spec, bbMech: { launcher: { kind: 'drum', mount: 'front', hoodDeg: BB_HOOD_DEFAULT_DEG }, lift: null } });
    check('aim: a TURRETLESS build returns no pitch solution', bbAimPitch(r, target) === null);
    r.spec = bbCoerce({ ...r.spec, bbMech: { launcher: { kind: 'turret', mount: 'center', hoodDeg: BB_HOOD_DEFAULT_DEG }, lift: null } });
    check('aim: ...and a TURRET does', bbAimPitch(r, target) !== null);
    check('aim: isTurreted agrees with the resolved launcher', bbIsTurreted(bbLauncherOf(r.spec, BB_HOOD_DEFAULT_DEG)));
  }

  // ── TARGET SELECTION: THE OPPONENT'S CELL, AND THE CLOSED SIDE ────────────
  // Both filters only became reachable when Lane A filled `scoreTargets()` in — while it
  // returned `[]` the selection could not be wrong because it never ran. These are property
  // checks over a grid rather than hand-picked coordinates, so they keep meaning something
  // when the HIVE or the FLOWERS move.
  {
    const w = mkWorld('free', 41);
    const r = w.robots[0]; // blue
    let picked = 0;
    let oppWouldHaveWon = 0; // non-vacuity: how often raw nearest WOULD have been the opponent's
    let badAlliance = 0;
    let badMouth = 0;
    for (let x = -66; x <= 66; x += 6) {
      for (let y = -66; y <= 66; y += 6) {
        r.pos = { x, y };
        // What nearest-by-distance ALONE would have chosen — the code that shipped before this.
        // It is measured over the FIELD-WIDE list (both alliances, merged), not over the one
        // this robot is offered: since the owner's ruling of 2026-09-12 `scoreTargets(w, a)`
        // already drops the opponent's cell, so asking it alone would make this check vacuous
        // by construction and prove nothing about `bbPickTarget`'s own filter.
        const all: ScoreTarget[] = [];
        {
          const seen = new Set<string>();
          for (const a of ['red', 'blue'] as const) {
            for (const t of scoreTargets(w, a)) {
              if (seen.has(t.id)) continue;
              seen.add(t.id);
              all.push(t);
            }
          }
        }
        let raw = all[0];
        let rawD = Infinity;
        for (const t of all) {
          const d = (t.pos.x - x) ** 2 + (t.pos.y - y) ** 2;
          if (d < rawD) {
            rawD = d;
            raw = t;
          }
        }
        if (raw.alliance !== null && raw.alliance !== r.alliance) oppWouldHaveWon++;

        const got = bbPickTarget(w, r);
        if (!got) continue;
        picked++;
        if (got.alliance !== null && got.alliance !== r.alliance) badAlliance++;
        if (got.mouth && -(got.pos.x - x) * got.mouth.x + -(got.pos.y - y) * got.mouth.y <= 0) badMouth++;
      }
    }
    check('aim: a target is picked from essentially everywhere on the field', picked > 400, `picked=${picked}`);
    check(
      'aim: the OPPONENT’s CELL is never aimed at — it is a legal shot that scores nothing',
      badAlliance === 0,
      `${badAlliance} of ${picked} picks were the opponent’s`,
    );
    check(
      'aim: ...and that filter is not vacuous — raw nearest WOULD have picked it',
      oppWouldHaveWon > 100,
      `nearest-by-distance alone chose the opponent’s opening at ${oppWouldHaveWon} poses`,
    );
    check(
      'aim: a target is only ever picked from the side its MOUTH opens toward',
      badMouth === 0,
      `${badMouth} of ${picked} picks were from the closed side`,
    );
  }

  // ── THE TURRET ACTUALLY SLEWS, AND ITS ARC ACTUALLY ARRIVES ──────────────
  // `bbSlewTurret` shipped with NO CALLER: `turretHeading` was written once by `spawn.ts` and
  // `bbTurretPitch` by nothing at all, so every turret was frozen at its spawn bearing firing
  // flat. These pin the stage that fixes it.
  {
    const w = mkWorld('free', 43);
    const r = w.robots[0];
    r.spec = bbCoerce({ ...r.spec, bbMech: { launcher: { kind: 'turret', mount: 'center', hoodDeg: BB_HOOD_DEFAULT_DEG }, lift: null } });
    r.pos = { x: 40, y: -50 };
    const yaw0 = r.turretHeading;
    const pitch0 = r.bbTurretPitch ?? 0;
    run(w, cmd({}), 1.5);
    const target = bbPickTarget(w, r)!;
    const sol = bbTurretSolution(r, target)!;
    check('turret: the yaw axis moves off its spawn bearing', Math.abs(r.turretHeading - yaw0) > 1e-3, `${yaw0.toFixed(3)} -> ${r.turretHeading.toFixed(3)} rad`);
    check('turret: it settles ON the solution', Math.abs(r.turretHeading - sol.yaw) < 0.02, `yaw=${r.turretHeading.toFixed(3)} want=${sol.yaw.toFixed(3)}`);
    check('turret: the PITCH axis is driven too, and off zero', (r.bbTurretPitch ?? 0) > 0.05 && Math.abs((r.bbTurretPitch ?? 0) - pitch0) > 1e-3, `pitch=${((r.bbTurretPitch ?? 0) / BB_DEG).toFixed(1)}deg`);
    check('turret: pitch stays inside the barrel envelope', (r.bbTurretPitch ?? 0) <= BB_TURRET_PITCH_MAX + 1e-9);

    // THE ARC ARRIVES. Speed and angle are a MATCHED pair out of `bbSolveShot`, so firing the
    // pair at the target's range must land at the target's height — this is the check that
    // would have caught the angle being flown at some other fixed speed.
    const o = bbTurretOrigin(r);
    const d = Math.hypot(target.pos.x - o.x, target.pos.y - o.y);
    const vh = sol.speed * Math.cos(sol.pitch);
    const t = d / vh;
    const rise = sol.speed * Math.sin(sol.pitch) * t - 0.5 * C.GRAVITY * t * t;
    const want = target.z - (BB_LAUNCH_Z0 + 2); // turret muzzle sits 2in above the deck launch height
    check('turret: the solved (speed, angle) pair lands at the target HEIGHT', Math.abs(rise - want) < 0.5, `rise=${rise.toFixed(2)}in want=${want.toFixed(2)}in at d=${d.toFixed(1)}in`);
    check('turret: the solved speed is inside the flywheel ceiling', sol.speed <= BB_TURRET_SPEED_MAX + 1e-9, `speed=${sol.speed.toFixed(1)}in/s`);
  }

  // ── THE MECHANISMS ARE WIRED INTO THE TICK, NOT MERELY WRITTEN ───────────
  /**
   * ⚠️ THE CHECK THAT WAS MISSING, AND IT COST BOTH MECHANISMS.
   *
   * `bbSlewTurret` and `bbStepLift` each shipped with their ONLY callers in this file — the
   * lift checks above drive `bbStepLift(r, cmd, dt)` directly — so both were green on code that
   * no match could reach. In an actual match the turret was frozen at the bearing `spawn.ts`
   * gave it, firing at 0° elevation, and the lift never left the deck.
   *
   * So these drive the WORLD. `run()` steps the real `biobuzzStep` pipeline with a command
   * held on robot 0, exactly as a driver would, and asserts the mechanism MOVED. A direct-call
   * test cannot distinguish "this function works" from "this function runs", and the second is
   * the thing that was broken.
   */
  {
    const w = mkWorld('free', 47);
    const r = w.robots[0];
    r.spec = bbCoerce({
      ...r.spec,
      bbMech: {
        launcher: { kind: 'turret', mount: 'center', hoodDeg: BB_HOOD_DEFAULT_DEG },
        lift: { kind: 'vslide', mount: 'back', maxZ: BB_LIFT_MAX_Z },
      },
    });
    const yaw0 = r.turretHeading;
    run(w, cmd({ bbLift: true }), 2.0);
    check(
      'wired: STEPPING THE WORLD raises the lift — `bbStepLift` has a caller in the pipeline',
      (r.bbLiftZ ?? 0) > 1,
      `bbLiftZ=${(r.bbLiftZ ?? 0).toFixed(2)}in after 2s of a held button`,
    );
    check(
      'wired: STEPPING THE WORLD slews the turret — `bbSlewTurret` has a caller in the pipeline',
      Math.abs(r.turretHeading - yaw0) > 1e-3 && (r.bbTurretPitch ?? 0) > 0.05,
      `yaw ${yaw0.toFixed(3)}->${r.turretHeading.toFixed(3)} rad, pitch=${((r.bbTurretPitch ?? 0) / BB_DEG).toFixed(1)}deg`,
    );
    // ...and RELEASING it brings the carriage back down, through the pipeline too.
    run(w, cmd({ bbLift: false }), 2.0);
    check(
      'wired: releasing the button stows it again, through the same pipeline',
      (r.bbLiftZ ?? 0) < 0.01,
      `bbLiftZ=${r.bbLiftZ}`,
    );
  }

  // ── RECORDED: A TURRETLESS LAUNCHER CANNOT REACH THE HIVE, AT ANY HOOD ────
  // Not a rule anyone wrote — it falls out of `BB_DRUM_SPEED` against `BB_HIVE_OPEN_Z`, and it
  // is a real archetype split (turretless scores FLOWERS; the HIVE is the turret's). Pinned so
  // that if someone retunes the launch speed, the day this stops being true is a decision
  // somebody makes rather than a balance change nobody noticed.
  {
    let bestApex = 0;
    for (let deg = BB_HOOD_MIN_DEG; deg <= BB_HOOD_MAX_DEG; deg++) {
      const apex = BB_LAUNCH_Z0 + (BB_DRUM_SPEED * Math.sin(deg * BB_DEG)) ** 2 / (2 * C.GRAVITY);
      if (apex > bestApex) bestApex = apex;
    }
    check(
      'launch: no TURRETLESS hood angle reaches the HIVE — the FLOWERS are its targets',
      bestApex < BB_HIVE_OPEN_Z[0],
      `best apex ${bestApex.toFixed(1)}in over the whole hood range vs a cell lip at ${BB_HIVE_OPEN_Z[0]}in`,
    );
    check(
      'launch: ...but it DOES clear a FLOWER top ring',
      bestApex > BB_FLOWER_TOP_Z,
      `best apex ${bestApex.toFixed(1)}in vs a flower top at ${BB_FLOWER_TOP_Z}in`,
    );
  }

  // ── COERCION: THE ENUMS FOLD, AND THE LEGACY MIRRORS AGREE ────────────────
  {
    check(
      'coerce: an unknown archetype folds to a known one',
      (BB_SCORE_MODES as readonly string[]).includes(
        bbCoerce({ ...BB_DEFAULT_SPEC, scoreMode: 'trebuchet' }).scoreMode as string,
      ),
    );
    // A turretless launcher fires along a LINE spanning one chassis side, so a corner is not
    // something it can be built as. The coercer folds it to the nearest edge rather than
    // rejecting the spec, because rejecting it would throw away a build the player can see.
    const corner = bbCoerce({ ...BB_DEFAULT_SPEC, scoreMode: 'drum', shooterMount: 'frontleft' });
    check(
      'coerce: a turretless launcher on a CORNER folds to an edge',
      (BB_SHOOTER_EDGES as readonly string[]).includes(corner.shooterMount as string),
      `mount=${corner.shooterMount}`,
    );
    /**
     * ...and a TURRET keeps its corner, because a turret aims itself: its mount is where it is
     * BOLTED, not a facing. One fold applied to both archetypes would relocate hardware.
     *
     * THIS CHECK FOUND A REAL BUG, and it is worth saying which: run through the shared
     * `coerceSpec` alone, EVERY mount collapsed to the front — the shared pass resets mounts
     * for a game it does not recognise, and BIOBUZZ is one until Lane B lands its arm. So every
     * turretless build spawned with a front drum and every turret bolted to the front, and the
     * gallery's 26 archetype sheets were 26 copies of two pictures. `bbCoerceSpec` re-arms the
     * raw mounts between the two passes; see its header.
     */
    const turret = bbCoerce({ ...BB_DEFAULT_SPEC, scoreMode: 'turret', shooterMount: 'frontleft' });
    check('coerce: a TURRET keeps its corner mount', turret.shooterMount === 'frontleft', `mount=${turret.shooterMount}`);
    // The deprecated booleans are what an older peer or server round-trips a spec through, so
    // they have to keep saying what the mount fields say.
    check(
      'coerce: the legacy intakeSide/shooterRear booleans mirror the mounts',
      everyBuild().every(
        (s) => s.intakeSide === (s.intakeMount === 'side') && s.shooterRear === (s.shooterMount === 'back'),
      ),
    );
    // CR-only mechanism fields must be GONE, not carried: the wire, the snapshot and the
    // builder's summary all describe the spec, and a leftover catalyst describes hardware this
    // robot does not have.
    const fromCr = bbCoerce({
      ...DEFAULT_SPEC,
      catalystType: 'hook',
      catalystMount: 'front',
      catalystSwing: 30,
      catapultRange: 40,
      catapultYaw: 10,
      groundClearance: 2,
    }) as unknown as Record<string, unknown>;
    check(
      'coerce: Chain Reaction mechanism fields are stripped, not carried',
      CR_FIELDS.every((k) => fromCr[k] === undefined),
      CR_FIELDS.filter((k) => fromCr[k] !== undefined).join(','),
    );
    check('coerce: every build has a usable hopper', everyBuild().every((s) => bbHopperCap(s) >= 1));
  }

  // ── THE LOADOUT: SWITCHING GAME DOES NOT BLEED A BUILD ────────────────────
  /**
   * Each game keeps its OWN robot, saved robots and start positions. Verified by round trip:
   * park a distinctive BIOBUZZ build, leave for Chain Reaction, come back, and the build has
   * to be the one that was parked — with the Chain Reaction side unaffected in both
   * directions.
   *
   * Not hypothetical. The `loadouts` archive exists because a single flat `spec` meant
   * switching game rebuilt your robot as the other game's coercion of it, and a player could
   * lose a tuned build by looking at another game.
   */
  {
    const s0 = switchGame(defaultSettings(), 'biobuzz');
    check('settings: switchGame("biobuzz") makes it the active game', s0.game === 'biobuzz');
    // A build nothing else would produce, so finding it later proves it was RESTORED rather
    // than re-defaulted into the same shape by coincidence.
    const mine = bbCoerce({ ...BB_DEFAULT_SPEC, scoreMode: 'dumper', intakeMount: 'back', ballStorage: 2 });
    const parked = { ...s0, spec: mine, savedRobots: [mine] };
    const inChain = switchGame(parked, 'chain');
    check('settings: leaving BIOBUZZ archives its loadout', !!inChain.loadouts?.biobuzz);
    check(
      'settings: the CHAIN build is not the BIOBUZZ one',
      specKey(inChain.spec) !== specKey(mine),
      `chain scoreMode=${inChain.spec.scoreMode}`,
    );
    check('settings: no BIOBUZZ saved robot leaks into CHAIN', inChain.savedRobots.length === 0);
    const back = switchGame(inChain, 'biobuzz');
    check('settings: returning to BIOBUZZ restores the parked build', specKey(back.spec) === specKey(mine));
    check(
      'settings: ...and its saved robots',
      back.savedRobots.length === 1 && specKey(back.savedRobots[0]) === specKey(mine),
    );
    check(
      'settings: the active BIOBUZZ loadout is not ALSO left in the archive',
      back.loadouts?.biobuzz === undefined,
      `archived=${Object.keys(back.loadouts ?? {}).join(',')}`,
    );
    check('settings: switching to the game already active is a no-op', switchGame(back, 'biobuzz') === back);
  }

  // ── THE DRAWN MOUTHS ARE THE CAPTURE AREAS ────────────────────────────────
  /**
   * The load-bearing invariant of the whole mount system, checked as GEOMETRY rather than as a
   * picture: a POLLEN inside a mouth rect is a capture candidate, and one placed beyond that
   * rect's outward face is not.
   *
   * `pollenIn` is the function the gameplay tick uses and `bbMouths` is the function the
   * sprite and the builder preview draw, so this cannot pass while those two disagree.
   *
   * The robot sits at the origin facing +x so its LOCAL frame IS the world frame and the
   * placement arithmetic needs no rotation — a rotation here would be a second implementation
   * of the transform under test. `pollenIn` accepts a POLLEN within `BB_POLLEN_R` of the rect
   * (a ball TOUCHING the mouth is in it), so "beyond" has to clear a whole diameter.
   */
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
      // one POLLEN diameter beyond the mouth's OUTWARD face, along the axis that face faces
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
    // A mouth is what the sprite draws outside the frame; the footprint is what Rapier
    // collides on. A mouth reaching past the footprint would capture from a place a POLLEN can
    // never be, because the frame would have pushed it away first.
    const f = bbFootprint(r.spec);
    check(
      `mouths [${intakeMount}]: no mouth reaches past the collision footprint`,
      mouths.every(
        (m) =>
          m.x1 <= f.front + 1e-9 &&
          m.x0 >= -f.rear - 1e-9 &&
          Math.abs(m.y0) <= f.half + 1e-9 &&
          Math.abs(m.y1) <= f.half + 1e-9,
      ),
      `footprint front=${f.front} rear=${f.rear} half=${f.half}`,
    );
  }

  // ── WHAT IS SOLID TO A POLLEN IS THIS GAME'S HARDWARE, ON THIS GAME'S EDGES ─
  /**
   * `bbRobotSolids` is what the artifact solve collides POLLEN against, and it exists because
   * the shared `robotSolids` describes DECODE: a chassis plus the FRONT funnel wedges (sloped /
   * triangle) or the vector preset's front rails, whatever mount the spec carries. Run through
   * that, a BIOBUZZ robot met its POLLEN through hardware it does not have, on an edge its
   * sweeper is not on — a `back` build had solid wedges across its front and nothing at all
   * behind it, where the roller actually is.
   *
   * Asserted as GEOMETRY, per mount, because that is the thing that was wrong: the set of edges
   * carrying something solid outside the frame must be exactly the set of edges the sweeper is
   * mounted on, two side plates each. `bbMouths` supplies the same rects the sprite draws, so
   * the solid and the drawn mouth cannot drift apart.
   */
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
      chassis.kind === 'box' &&
        Math.abs(chassis.hx - hl) < 1e-9 &&
        Math.abs(chassis.hy - hw) < 1e-9 &&
        chassis.cx === 0 &&
        chassis.cy === 0,
    );

    // which edge each structure box sits outside of — a plate is outboard of the frame by
    // construction, so its centre alone names its edge
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

    // THE MOUTH IS OPEN — a POLLEN at the middle of the roller band touches nothing, which is
    // what lets `interact()` capture it before the frame arrives. A funnel wedge here (the old
    // shared geometry) would report a penetration.
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
    // ...and the SIDE PLATE is solid: a POLLEN centred on one is inside the robot
    for (const sh of sol.structure) {
      const b = sh as { cx: number; cy: number };
      if (!robotPenetration(r, sol, { x: b.cx, y: b.cy }, BB_POLLEN_R)) plateOk = false;
    }
    check(`solids [${intakeMount}]: the sweeper MOUTH is open to a POLLEN`, openOk);
    check(`solids [${intakeMount}]: the sweeper SIDE PLATES are solid to a POLLEN`, plateOk);

    // THE HELD PLUG IS POLLEN-SIZED. A hopper full of DECODE-radius circles is a plug an inch
    // too fat in every direction, and it is the one place the radius reaches the geometry.
    r.spec.ballStorage = Math.max(1, r.spec.ballStorage ?? 1);
    const held = [bbPollen(900, 0, 0)];
    held[0].state = { kind: 'held', robot: r.id, lx: 0, ly: 0 };
    const withHeld = bbRobotSolids(r, held, BB_POLLEN_R);
    const plug = withHeld.held[0] as { kind: string; r: number } | undefined;
    check(
      `solids [${intakeMount}]: a HELD pollen plugs the mouth at the POLLEN radius, not DECODE's`,
      withHeld.held.length === 1 && plug?.kind === 'circle' && plug.r === BB_POLLEN_R,
      `r=${plug?.r} want ${BB_POLLEN_R} (DECODE ${C.BALL_RADIUS})`,
    );
  }

  // ── THE SEAM IS WIRED, AND IT IS NOT THE SHARED GEOMETRY ──────────────────
  /**
   * `GameSimModule.artifactSolids` (`src/games/types.ts`) is the optional slot a game fills to
   * supply its own artifact-solid geometry; absent, a consumer uses the shared `robotSolids`.
   * BIOBUZZ fills it, and `play.ts` reads it — so this checks BOTH halves, because a slot that
   * is declared and never read is how the whole class of seam bug survives: everything compiles,
   * the game just silently plays DECODE's shape.
   *
   * The second half is what makes the first half worth anything: on a mount DECODE cannot have,
   * the two geometries must actually DIFFER. If they ever agree here, either the seam stopped
   * being read or the shared geometry grew a BIOBUZZ arm, and both are worth failing over.
   */
  {
    const mod = simModuleFor('biobuzz');
    check('seam: BIOBUZZ fills GameSimModule.artifactSolids', typeof mod.artifactSolids === 'function');
    const world = mkWorld('free', 3, { intakeMount: 'back' });
    const r = world.robots[0];
    r.pos = { x: 0, y: 0 };
    r.heading = 0;
    const mine = mod.artifactSolids?.(r, [], BB_POLLEN_R);
    const shared = robotSolids(r, [], BB_POLLEN_R);
    check(
      'seam: the module slot returns BIOBUZZ geometry',
      JSON.stringify(mine) === JSON.stringify(bbRobotSolids(r, [], BB_POLLEN_R)),
    );
    check(
      "seam: a BACK sweeper's solids are NOT DECODE's front funnel",
      JSON.stringify(mine?.structure) !== JSON.stringify(shared.structure),
      `bb=${mine?.structure.length} shapes, shared=${shared.structure.length}`,
    );
    check(
      'seam: DECODE and Chain Reaction leave the slot empty (the shared geometry is untouched)',
      simModuleFor('decode').artifactSolids === undefined &&
        simModuleFor('chain').artifactSolids === undefined,
    );
  }

  // ── THE INTAKE COLLECTS WHAT IT DRIVES OVER ───────────────────────────────
  /**
   * Through the FULL `biobuzzStep`, not by calling `capturePollen` directly: the point is that
   * the button reaches the mechanism through the real pipeline (resolve → aim → drivetrain →
   * solve → gameplay), which is where an intake gets accidentally disconnected.
   *
   * `autoIntake` is forced OFF so this tests the BUTTON. With the assist on, the check would
   * pass for an intake wired to nothing.
   *
   * THE COUNT MUST NOT CHANGE. A captured POLLEN stays in `world.balls` as `kind: 'held'` —
   * the BIOBUZZ decision Chain Reaction did not make — and that is what makes
   * `world.balls.length` an invariant of the whole match rather than of the ground alone.
   */
  {
    const world = mkWorld('free', 11);
    const r = world.robots[0];
    r.pos = { x: -20, y: 0 };
    r.heading = 0;
    r.vel = { x: 0, y: 0 };
    r.autoIntake = false;
    r.hopper.length = 0;
    world.balls.length = 0;
    world.balls.push(bbPollen(1, -8, 0)); // 12" ahead, dead centre of the front mouth's path
    const before = world.balls.length;
    run(world, cmd({ driveY: 1, intake: true }), 2);
    const held = world.balls.filter((b) => b.state.kind === 'held');
    check('intake: a POLLEN driven over is collected', r.hopper.length === 1, `hopper=${r.hopper.length}`);
    check(
      'intake: the collected POLLEN is HELD by this robot',
      held.length === 1 && held[0].state.kind === 'held' && held[0].state.robot === r.id,
    );
    check('intake: collecting conserves the POLLEN count', world.balls.length === before, `${before} -> ${world.balls.length}`);

    // The same drive with the button UP must collect nothing. Without this, the check above
    // also passes for a robot that eats whatever it touches regardless of input.
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
  /**
   * `capturePollen` is the single place the cap is enforced, and it enforces it by RETURNING
   * FALSE — not by throwing, and not by overwriting a slot. A robot parked on a pile with the
   * intake held is the ordinary way to reach the limit.
   */
  {
    const world = mkWorld('free', 13);
    const r = world.robots[0];
    r.pos = { x: 0, y: 0 };
    r.heading = 0;
    r.hopper.length = 0;
    world.balls.length = 0;
    const cap = bbHopperCap(r.spec);
    // one more POLLEN than the hopper holds, all at the robot so every one is a candidate
    for (let i = 0; i <= cap; i++) world.balls.push(bbPollen(i + 1, 0, 0));
    let taken = 0;
    for (const b of [...world.balls]) if (capturePollen(world, r, b)) taken++;
    check('hopper: capture stops at the cap', taken === cap && r.hopper.length === cap, `took ${taken} of ${cap}`);
    check(
      'hopper: the refused POLLEN is still on the ground',
      world.balls.filter((b) => b.state.kind === 'ground').length === 1,
    );
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
    // LIFO — a hopper is a stack and its feed path is at the top. Releasing the FIRST captured
    // POLLEN instead is invisible in the shell (pollen are interchangeable) and wrong the
    // moment Section 10 gives them a distinguishing property.
    check('release: the POLLEN released is the LAST one captured', flying.length === 1 && flying[0].id === cap);
    // An EMPTY hopper must be a no-op, not a spawned POLLEN. It is the one path that could
    // break conservation from nothing, so it gets its own check.
    const empty = mkWorld('free', 19);
    empty.robots[0].hopper.length = 0;
    const n = empty.balls.length;
    releasePollen(empty, empty.robots[0], { x: 10, y: 0, z: 10 });
    check('release: releasing from an EMPTY hopper creates nothing', empty.balls.length === n, `${n} -> ${empty.balls.length}`);
  }

  // ── FIRING THROUGH THE PIPELINE EMPTIES THE HOPPER, CONSERVING ────────────
  /**
   * The launcher's own path: hold `fire` with a full hopper until it is empty, and every POLLEN
   * must have left with the count unchanged. Run for every ARCHETYPE, because each launches
   * differently — a turret feeds one at a time from its ring, a drum meters a burst, a dumper
   * fans its whole load in a tick — and conservation is the one thing all four owe.
   *
   * THE BUDGET IS DERIVED, NOT GUESSED. The first version of this check held `fire` for two
   * seconds, which is a hidden assertion about the FEED RATE: a turret feeds one POLLEN every
   * `BB_FIRE_INTERVAL`, so a 39-POLLEN hopper needs three seconds and the check failed on a
   * mechanism that was working perfectly. Deriving the window from the cap and the interval
   * (plus slack for the slowest archetype and the startup tick) asserts what is actually owed
   * — that firing DRAINS the hopper — and survives every retune of an APPROX constant.
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
    check(
      `launch [${scoreMode}]: holding fire empties the hopper`,
      r.hopper.length === 0,
      `hopper=${r.hopper.length} after ${seconds.toFixed(2)}s`,
    );
    check(
      `launch [${scoreMode}]: launching conserves the POLLEN count`,
      world.balls.length === before,
      `${before} -> ${world.balls.length}`,
    );
    check(
      `launch [${scoreMode}]: no POLLEN is left stuck HELD`,
      world.balls.every((b) => b.state.kind !== 'held'),
      `held=${world.balls.filter((b) => b.state.kind === 'held').length}`,
    );
  }

  // ── THE ROBOT-LANE SCENES HASH DETERMINISTICALLY ──────────────────────────
  /**
   * The property the field lane checks, over the scenes that exercise MECHANISMS —
   * `intake-line`, `launch-wall-bounce` and all 26 archetype sheets. Cheap, and it is what
   * makes the contact sheet a reproducible artefact: a cell whose hash moves between runs is a
   * cell whose screenshot cannot be compared with yesterday's.
   */
  for (const scene of BB_SCENES.filter((s) => s.lane === 'robot')) {
    const last = Math.max(...scene.stills);
    const h1 = worldHash(bbSceneAt(scene, last));
    const h2 = worldHash(bbSceneAt(scene, last));
    check(`scene [${scene.id}@${last}]: hashes deterministically`, h1 === h2, `${h1} vs ${h2}`);
  }

  // ── AND NOTHING IN THIS LANE READS THE CLOCK ──────────────────────────────
  // `SIM_DT` is the only time a mechanism may know about. Every mechanism is exercised at once
  // here — drive, intake and fire held together — so a `Date.now()` inside any of them makes
  // the two runs diverge.
  {
    const a = mkWorld('free', 29);
    const b = mkWorld('free', 29);
    run(a, cmd({ driveY: 1, intake: true, fire: true }), 4);
    run(b, cmd({ driveY: 1, intake: true, fire: true }), 4);
    check(
      'determinism: two identical robot runs hash identically',
      worldHash(a) === worldHash(b),
      `${worldHash(a)} vs ${worldHash(b)}`,
    );
    check('determinism: ...after exactly the expected number of ticks', a.tick === Math.round(4 / C.SIM_DT), `tick=${a.tick}`);
  }
}
