import type { RobotSpec } from '../../types';
import { clamp } from '../../math';
import { massLimits } from '../../sim/drivetrain';
import { DEFAULT_SPEC, coerceSpec } from '../../sim/spawn';
import {
  BB_DEFAULT_SCORE_MODE,
  BB_PRESETS,
  BB_STORAGE_DEFAULT,
  BB_STORAGE_MIN,
  bbMassFloorBump,
  bbMountFits,
  bbSizeLimits,
  bbStorageMax,
} from './config';
import {
  BB_DEFAULT_INTAKE_MOUNT,
  BB_DEFAULT_SHOOTER_MOUNT,
  BB_INTAKE_MOUNTS,
  BB_MOUNT_POSITIONS,
  BB_SCORE_MODES,
  type BbIntakeMount,
  type BbScoreMode,
  bbIntakeMountOf,
  bbShooterEdgeOf,
  bbShooterMountOf,
  isTurreted,
} from './mounts';

/**
 * BIOBUZZ robot DIALS — the defaults and the sanitizing clamps.
 *
 * ── WHY THIS FILE EXISTS SEPARATELY FROM `config.ts` ────────────────────────
 * `src/sim/spawn.ts`'s `coerceSpec` is the SINGLE idempotent chokepoint every robot spec
 * passes through: a spec arrives from localStorage (hand-editable), off the multiplayer wire
 * (people have spoofed it via devtools to spawn NaN-dimensioned robots), and again at
 * `createWorld`. Per `docs/biobuzz-contract.md`, the `game === 'biobuzz'` ARMS of that
 * function belong to Lane B and do not exist yet.
 *
 * `coerceBiobuzzSpec` below is exactly the body those arms will run, written and tested here
 * so the shell is safe TODAY and so folding it in later is a call, not a rewrite. `spawn.ts`
 * runs it immediately after the shared coercer. That is a deliberate, temporary,
 * DOUBLE-COERCION and it is sound because both halves are pure clamps: the shared pass bounds
 * everything it knows about, and this pass re-establishes the mechanism fields that pass
 * WIPES for any game it does not recognise (see `coerceSpec`'s `game !== 'chain'` branch,
 * which resets `intakeMount`/`shooterMount` to CR defaults precisely so a CR build cannot
 * leak into DECODE).
 *
 * When Lane B lands the real arms, the fix is two edits: call these helpers from inside
 * `coerceSpec`, and delete the follow-up call in `spawn.ts`. `docs/biobuzz/HANDOFF-shell.md`
 * names them.
 *
 * ── FIELD REUSE ─────────────────────────────────────────────────────────────
 * The shell rides the EXISTING shared mechanism fields (`intake`, `intakeMount`,
 * `shooterMount`, `scoreMode`, `ballStorage`) rather than minting `bb*` twins — see the header
 * of `mounts.ts` for why (the load-bearing reason is `footprintExtents`). So this coercer has
 * no `bb*`-prefixed fields to clamp yet; it clamps the shared fields THROUGH the BIOBUZZ
 * limits, which is the same guarantee under a different spelling. The moment Lane B adds a
 * genuinely new field, it is clamped here and nowhere else.
 */

/**
 * The BIOBUZZ base spec — the shared default, re-pointed at this game's first preset.
 *
 * A new player's first BIOBUZZ robot should be a coherent build rather than DECODE's chassis
 * with BIOBUZZ mechanism fields bolted on, and the first preset card is by definition the
 * archetype we want to introduce the game with.
 */
export const BB_DEFAULT_SPEC: RobotSpec = { ...DEFAULT_SPEC, ...BB_PRESETS[0] };

/** clamp `n` to [lo,hi], substituting `fallback` when it is not a finite number. Guards
 * against NaN and Infinity, which a bare `clamp` passes straight through. */
function clampFinite(n: unknown, lo: number, hi: number, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? clamp(n, lo, hi) : clamp(fallback, lo, hi);
}

/**
 * Normalize the BIOBUZZ half of a spec. IDEMPOTENT — `f(f(x)) === f(x)` for every input,
 * which smoke asserts, because the coercer genuinely does run at several layers and a
 * non-idempotent pass shows up as a preset card that stops highlighting as selected.
 *
 * The clamp ORDER mirrors the builder's dependency graph, and that is load-bearing rather
 * than tidy: each range is resolved from only the field(s) it depends on, so re-running the
 * function cannot walk a value.
 *   1. ARCHETYPE + INTAKE MOUNT → both are enums, and both feed the ranges below
 *   2. SIZE                     → per-mount envelope (`bbSizeLimits`)
 *   3. MASS                     → drivetrain × inertia × the archetype's mechanism floor
 *   4. HOPPER                   → footprint × archetype × mount (`bbStorageMax`)
 */
export function coerceBiobuzzSpec(raw: RobotSpec, base: RobotSpec = BB_DEFAULT_SPEC): RobotSpec {
  const out: RobotSpec = { ...raw };

  // 1a) SCORING ARCHETYPE. Enum-checked against BIOBUZZ's own list, not CR's, so a future
  // divergence in either game's archetype set is a one-line change in one file.
  out.scoreMode = ((BB_SCORE_MODES as readonly string[]).includes(out.scoreMode as string)
    ? out.scoreMode
    : (base.scoreMode ?? BB_DEFAULT_SCORE_MODE)) as BbScoreMode;

  // 1b) INTAKE MOUNT. Resolved through `bbIntakeMountOf` so the legacy `intakeSide` boolean
  // still migrates, then checked for BUILDABILITY: a mount whose sweepers cannot fit the
  // expansion prism is not a legal build, and the honest repair is to fall back to the single
  // front sweeper rather than to silently shrink a chassis the player sized on purpose.
  let mount = bbIntakeMountOf(out);
  if (!(BB_INTAKE_MOUNTS as readonly string[]).includes(mount)) mount = BB_DEFAULT_INTAKE_MOUNT;
  if (!bbMountFits({ ...out, intakeMount: mount }, mount)) mount = 'front';
  out.intakeMount = mount as BbIntakeMount;

  // 1c) LAUNCHER MOUNT. A TURRET may sit at any of the nine positions — it aims itself, so
  // its mount is where it is BOLTED (and therefore where a POLLEN is born), not a facing. A
  // TURRETLESS launcher fires along a LINE spanning a chassis SIDE, so a corner or the centre
  // is not something it can be built as: fold it to the nearest edge. Resolved HERE, the one
  // chokepoint, so a spec that changes archetype later can never keep a mount that archetype
  // cannot have.
  let shooter = bbShooterMountOf(out);
  if (!(BB_MOUNT_POSITIONS as readonly string[]).includes(shooter)) shooter = BB_DEFAULT_SHOOTER_MOUNT;
  out.shooterMount = shooter;
  if (!isTurreted(out.scoreMode as BbScoreMode)) out.shooterMount = bbShooterEdgeOf(out);

  // MIRROR the deprecated booleans, so a spec routed through an older peer or server — which
  // drops the fields it does not know — round-trips to the nearest legal mount instead of
  // resetting to the default.
  out.intakeSide = out.intakeMount === 'side';
  out.shooterRear = out.shooterMount === 'back';

  // 2) SIZE, from the resolved intake mount (which is why step 1b runs first).
  const size = bbSizeLimits(out);
  // When a mount leaves nothing legal, `bbSizeLimits` reports max < min on purpose. Clamping
  // to an inverted range would produce the MAX (i.e. a robot smaller than the floor), so
  // widen to the floor: step 1b has already ruled out the mount that caused it, and this is
  // only reachable if a future mechanism narrows the envelope further.
  out.length = clampFinite(out.length, size.minLength, Math.max(size.minLength, size.maxLength), base.length);
  out.width = clampFinite(out.width, size.minWidth, Math.max(size.minWidth, size.maxWidth), base.width);

  // 3) MASS, from drivetrain × flywheel inertia × whatever heavy mechanism the archetype
  // carries. R104 says there is NO ROBOT weight limit in BIOBUZZ, so this is not a rules
  // clamp — it is the sim's own model of what a given drivetrain can actually move.
  const mass = massLimits(out.drivetrain, out.flywheelInertia, bbMassFloorBump(out));
  out.massLb = clampFinite(out.massLb, mass.min, mass.max, base.massLb);

  // 4) HOPPER, from the footprint and the archetype and the mount — so it runs last, after
  // all three are final.
  out.ballStorage = Math.round(
    clampFinite(out.ballStorage, BB_STORAGE_MIN, bbStorageMax(out), base.ballStorage ?? BB_STORAGE_DEFAULT),
  );

  // CR-ONLY FIELDS ARE STRIPPED, not carried. A spec that was a Chain Reaction build before
  // the player switched game arrives here with a catalyst mechanism and a ground clearance
  // BIOBUZZ has no mechanism for; leaving them on the spec means the wire, the snapshot and
  // the builder's summary all describe hardware this robot does not have.
  delete out.catalystType;
  delete out.catalystMount;
  delete out.catalystSwing;
  delete out.catapultRange;
  delete out.catapultYaw;
  delete out.groundClearance;

  return out;
}

/**
 * THE ONE COERCION A BIOBUZZ SPEC GETS — the shared chokepoint, then this game's arm.
 *
 * ── WHY IT CANNOT JUST BE `coerceSpec(raw, base, 'biobuzz')` ───────────────
 * Because that call DESTROYS the build. `coerceSpec` resets `intakeMount` and `shooterMount`
 * to the Chain Reaction defaults for any game it does not recognise (`src/sim/spawn.ts`, the
 * `game !== 'chain'` branch), and it does that for a good reason: those two fields have a
 * SHARED physics effect — the intake mount moves the collision footprint — so a CR side
 * sweeper leaking into DECODE would widen a DECODE robot's flanks. With no `biobuzz` arm yet,
 * BIOBUZZ is one of the games it does not recognise.
 *
 * The visible cost was total: every turretless build spawned with a FRONT drum whatever edge
 * the player picked, and every turret spawned bolted to the front whatever the nine positions
 * offered — the gallery's 26 archetype sheets rendered as 26 copies of two pictures, which is
 * how this was found.
 *
 * So the raw mount fields are RE-ARMED between the two passes. That is sound rather than a
 * bypass: `coerceBiobuzzSpec` is the authority on those fields for this game, it enum-checks
 * them, folds a corner mount off a turretless launcher, re-derives the size envelope from the
 * intake mount and re-mirrors the legacy booleans. The shared pass is still what bounds
 * everything else. It stays idempotent because the re-armed values are the coerced ones on any
 * second pass.
 *
 * WHEN LANE B LANDS THE ARM in `coerceSpec`, this function's body becomes the single call
 * `coerceSpec(raw, base, 'biobuzz')` and every caller keeps working —
 * `docs/biobuzz/HANDOFF-shell.md` names the edits.
 */
export function bbCoerceSpec(raw: unknown, base: RobotSpec = BB_DEFAULT_SPEC): RobotSpec {
  const shared = coerceSpec(raw, base, 'biobuzz');
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<RobotSpec>;
  return coerceBiobuzzSpec(
    {
      ...shared,
      // the four spellings of a mount: the two fields and the two legacy booleans older peers
      // and saves still speak. `coerceBiobuzzSpec` resolves whichever arrived.
      intakeMount: r.intakeMount ?? shared.intakeMount,
      intakeSide: r.intakeSide ?? shared.intakeSide,
      shooterMount: r.shooterMount ?? shared.shooterMount,
      shooterRear: r.shooterRear ?? shared.shooterRear,
    },
    base,
  );
}

/**
 * The DIAL RANGES the builder renders, as one object.
 *
 * Derived from the same functions the coercer uses rather than from parallel constants — a
 * slider whose bounds came from anywhere else is a slider that can offer a value the
 * chokepoint then clamps, which reads to the player as the control snapping back.
 */
export function bbDials(spec: RobotSpec): {
  length: { min: number; max: number };
  width: { min: number; max: number };
  mass: { min: number; max: number };
  storage: { min: number; max: number };
} {
  const size = bbSizeLimits(spec);
  const mass = massLimits(spec.drivetrain, spec.flywheelInertia, bbMassFloorBump(spec));
  return {
    length: { min: size.minLength, max: Math.max(size.minLength, size.maxLength) },
    width: { min: size.minWidth, max: Math.max(size.minWidth, size.maxWidth) },
    mass,
    storage: { min: BB_STORAGE_MIN, max: bbStorageMax(spec) },
  };
}
