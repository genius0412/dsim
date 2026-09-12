import type { RobotSpec } from '../../types';
import { clamp } from '../../math';
import { massLimits } from '../../sim/drivetrain';
import { DEFAULT_SPEC } from '../../sim/specDefaults';
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
 * THE BIOBUZZ ARM OF `coerceSpec`, IN A LEAF MODULE.
 *
 * `src/sim/spawn.ts` calls `coerceBiobuzzSpec` from inside `coerceSpec`, so this file is a
 * DEPENDENCY of the shared spawn chokepoint. It therefore may not import `sim/spawn.ts` — or
 * anything that reaches it — or the shared coercer could not be built at all. That is why it
 * is split out of `robotConfig.ts` (which does import `coerceSpec`, and re-exports both
 * symbols below so every existing importer is unchanged), and why `DEFAULT_SPEC` comes from
 * `sim/specDefaults.ts` rather than from `sim/spawn.ts`.
 *
 * ITS IMPORTS ARE THE CONTRACT: `../../types`, `../../math`, the drivetrain mass model, the
 * shared spec defaults, and this game's own two constant modules. All five are leaves. An
 * import here that reaches `sim/spawn.ts`, `physicsEngine.ts` or a game MODULE is a cycle with
 * a module-eval-time read in it, which is the class of bug `src/sim/specDefaults.ts` documents.
 *
 * ── WHY THE CLAMPS ARE HERE AND NOT IN `coerceSpec` ITSELF ─────────────────
 * `coerceSpec` is the SINGLE idempotent chokepoint every robot spec passes through: a spec
 * arrives from localStorage (hand-editable), off the multiplayer wire (people have spoofed it
 * via devtools to spawn NaN-dimensioned robots), and again at `createWorld`. Per
 * `docs/biobuzz-contract.md` §1, the `game === 'biobuzz'` arms of that function are Lane B's,
 * and Lane B's clamps are BIOBUZZ geometry — the size envelope per intake mount, the
 * archetype mass floor, the hopper ceiling. Keeping the body in this directory is what keeps
 * `src/sim/spawn.ts` free of BIOBUZZ numbers (the same repo rule Chain Reaction follows: its
 * arm calls `chainSizeLimits` / `chainMassFloorBump` / `chainStorageMax` and holds none of
 * them itself).
 */

/** clamp `n` to [lo,hi], substituting `fallback` when it is not a finite number. Guards
 * against NaN and Infinity, which a bare `clamp` passes straight through. */
function clampFinite(n: unknown, lo: number, hi: number, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? clamp(n, lo, hi) : clamp(fallback, lo, hi);
}

/**
 * The BIOBUZZ base spec — the shared default, re-pointed at this game's first preset.
 *
 * A new player's first BIOBUZZ robot should be a coherent build rather than DECODE's chassis
 * with BIOBUZZ mechanism fields bolted on, and the first preset card is by definition the
 * archetype we want to introduce the game with.
 */
export const BB_DEFAULT_SPEC: RobotSpec = { ...DEFAULT_SPEC, ...BB_PRESETS[0] };

/**
 * Normalize the BIOBUZZ half of a spec — the body of `coerceSpec`'s `game === 'biobuzz'` arm,
 * run as its last step, on a spec the shared passes have already bounded. IDEMPOTENT — `f(f(x)) === f(x)` for every input,
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
 *
 * ⚠️ `raw` HERE IS NOT THE USER'S INPUT — it is what `coerceSpec` has already made of it, and
 * that function builds its output from the base spec plus the fields it reads off the input BY
 * NAME. So the first BIOBUZZ-only `bb*` field added to `RobotSpec` will not arrive here on its
 * own: it has to be carried across at the call site (`src/sim/spawn.ts`, at the `game ===
 * 'biobuzz'` arm, where the same warning is written out in full). A field that is clamped
 * beautifully here and never delivered is indistinguishable from a builder that forgets the
 * setting.
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

