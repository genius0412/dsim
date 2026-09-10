import type { RobotSpec } from '../../src/types';
import * as C from '../../src/config';
import { worldHash } from '../../src/net/checksum';
import { defaultSettings, switchGame } from '../../src/settings';
import { DEFAULT_SPEC } from '../../src/sim/spawn';
import { BB_FIRE_INTERVAL, BB_POLLEN_R } from '../../src/games/biobuzz/config';
import { capturePollen, pollenIn, releasePollen } from '../../src/games/biobuzz/elements';
import {
  BB_INTAKE_MOUNTS,
  BB_MOUNT_POSITIONS,
  BB_SCORE_MODES,
  BB_SHOOTER_EDGES,
  isTurreted,
} from '../../src/games/biobuzz/mounts';
import { bbFootprint, bbHopperCap, bbMouths } from '../../src/games/biobuzz/robot';
import { BB_DEFAULT_SPEC, bbDials, coerceBiobuzzSpec } from '../../src/games/biobuzz/robotConfig';
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
     * ASSERTED ON `coerceBiobuzzSpec` DIRECTLY, not on the composed `bbCoerce`, and that is a
     * statement about a KNOWN GAP rather than a convenience. The shared `coerceSpec` has no
     * `game === 'biobuzz'` arm yet, so for an unrecognised game it RESETS the mechanism fields
     * (by design — it is what stops a Chain Reaction build leaking into DECODE), which wipes
     * `frontleft` to the CR default BEFORE this game's coercer ever sees it. So today a corner
     * turret does not survive `createWorld`: it lands on the front edge.
     *
     * That is the shell's one real functional gap and it is core-owned; `docs/biobuzz/
     * HANDOFF-shell.md` names the two `src/sim/spawn.ts` edits that close it. This check is
     * written against the function that owns the algebra so it verifies the CONTRACT and keeps
     * passing unchanged the day the arm lands — at which point it can be re-pointed at
     * `bbCoerce` by deleting one word.
     */
    const turret = coerceBiobuzzSpec({ ...BB_DEFAULT_SPEC, scoreMode: 'turret', shooterMount: 'frontleft' });
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
