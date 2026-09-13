import type { RobotSpec } from '../../types';
import { clamp } from '../../math';
import { massLimits } from '../../sim/drivetrain';
import { DEFAULT_SPEC } from '../../sim/specDefaults';
import {
  BB_HOOD_DEFAULT_DEG,
  BB_HOOD_MAX_DEG,
  BB_HOOD_MIN_DEG,
  BB_PRESETS,
  BB_STORAGE_DEFAULT,
  BB_STORAGE_MIN,
  bbMassFloorBump,
  bbMountFits,
  bbSizeLimits,
  bbStorageMax,
} from './config';
import {
  BB_LIFT_KINDS,
  BB_LIFT_POSITIONS,
  type BbLauncherSpec,
  type BbLiftSpec,
  type BbMechSpec,
  bbFoldTwinMount,
  bbLauncherBlocker,
  bbLauncherOf,
  bbLiftOf,
  bbResolveLiftMount,
  bbResolveMount2,
} from './mechs';
import {
  BB_DEFAULT_INTAKE_MOUNT,
  BB_DEFAULT_SHOOTER_MOUNT,
  type BbMountPos,
  BB_INTAKE_MOUNTS,
  BB_MOUNT_POSITIONS,
  type BbIntakeMount,
  bbIntakeMountOf,
  bbShooterEdgeOf,
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
 * shared spec defaults, and this game's own constant modules. All are leaves. An import here
 * that reaches `sim/spawn.ts`, `physicsEngine.ts` or a game MODULE is a cycle with a
 * module-eval-time read in it, which is the class of bug `src/sim/specDefaults.ts` documents.
 *
 * ── WHY THE CLAMPS ARE HERE AND NOT IN `coerceSpec` ITSELF ─────────────────
 * `coerceSpec` is the SINGLE idempotent chokepoint every robot spec passes through: a spec
 * arrives from localStorage (hand-editable), off the multiplayer wire (people have spoofed it
 * via devtools to spawn NaN-dimensioned robots), and again at `createWorld`. Per
 * `docs/biobuzz-contract.md` §1, the `game === 'biobuzz'` arms of that function are Lane B's,
 * and Lane B's clamps are BIOBUZZ geometry — the size envelope per intake mount, the
 * mechanism mass floor, the hopper ceiling. Keeping the body in this directory is what keeps
 * `src/sim/spawn.ts` free of BIOBUZZ numbers (the same repo rule Chain Reaction follows).
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
 * run as its last step, on a spec the shared passes have already bounded. IDEMPOTENT —
 * `f(f(x)) === f(x)` for every input, which smoke asserts, because the coercer genuinely does run
 * at several layers and a non-idempotent pass shows up as a preset card that stops highlighting
 * as selected.
 *
 * The clamp ORDER mirrors the builder's dependency graph, and that is load-bearing rather
 * than tidy: each range is resolved from only the field(s) it depends on, so re-running the
 * function cannot walk a value.
 *   0. THE LOADOUT              → launcher (mandatory), a double turret's second cell, the Box
 *                                 Tube — resolved from `raw` and written, flat mirrors included,
 *                                 BEFORE anything below reads it
 *   1. INTAKE MOUNT             → an enum, and it feeds the ranges below
 *   2. SIZE                     → per-mount envelope (`bbSizeLimits`)
 *   3. MASS                     → drivetrain × inertia × the loadout's mechanism floor
 *   4. HOPPER                   → footprint × launcher × mount (`bbStorageMax`)
 *
 * ⚠️ WHY THE LOADOUT IS STEP 0. Mass (`bbMassFloorBump`) and storage (`bbStorageMax`) both read
 * the launcher through `bbLauncherOf`. They used to run BEFORE the loadout was validated, so they
 * read whatever raw, unvalidated `bbMech` the spec arrived with; the validated container was
 * written afterwards from `raw` separately. Resolving it first means every later step reads the
 * one validated answer.
 *
 * ⚠️ `raw` HERE IS NOT THE USER'S INPUT — it is what `coerceSpec` has already made of it, and
 * that function builds its output from the base spec plus the fields it reads off the input BY
 * NAME. So a BIOBUZZ-only `bb*` field will not arrive here on its own: it has to be carried
 * across at the call site (`src/sim/spawn.ts`, at the `game === 'biobuzz'` arm).
 */
export function coerceBiobuzzSpec(raw: RobotSpec, base: RobotSpec = BB_DEFAULT_SPEC): RobotSpec {
  const out: RobotSpec = { ...raw };

  // 0) THE MECHANISM LOADOUT, and its flat MIRRORS, unconditionally. The container is
  // authoritative; `scoreMode`/`shooterMount`/`shooterRear` are what an older peer or server
  // reads (it drops `bbMech` entirely), so they always say what the container says.
  const mech = coerceBbMech(raw);
  out.bbMech = mech;
  out.scoreMode = mech.launcher.kind;
  out.shooterMount = mech.launcher.mount;
  out.shooterRear = mech.launcher.mount === 'back';

  // 1) INTAKE MOUNT. Resolved through `bbIntakeMountOf` so the legacy `intakeSide` boolean
  // still migrates, then checked for BUILDABILITY: a mount whose sweepers cannot fit the
  // expansion prism is not a legal build, and the honest repair is to fall back to the single
  // front sweeper rather than to silently shrink a chassis the player sized on purpose.
  let mount = bbIntakeMountOf(out);
  if (!(BB_INTAKE_MOUNTS as readonly string[]).includes(mount)) mount = BB_DEFAULT_INTAKE_MOUNT;
  if (!bbMountFits({ ...out, intakeMount: mount }, mount)) mount = 'front';
  out.intakeMount = mount as BbIntakeMount;
  // MIRROR the deprecated boolean, so a spec routed through an older peer round-trips to the
  // nearest legal mount instead of resetting to the default.
  out.intakeSide = out.intakeMount === 'side';

  // 2) SIZE, from the resolved intake mount (which is why step 1 runs first).
  const size = bbSizeLimits(out);
  // When a mount leaves nothing legal, `bbSizeLimits` reports max < min on purpose. Clamping
  // to an inverted range would produce the MAX (i.e. a robot smaller than the floor), so
  // widen to the floor.
  out.length = clampFinite(out.length, size.minLength, Math.max(size.minLength, size.maxLength), base.length);
  out.width = clampFinite(out.width, size.minWidth, Math.max(size.minWidth, size.maxWidth), base.width);

  // 3) MASS, from drivetrain × flywheel inertia × whatever heavy mechanism the loadout carries.
  // R104 says there is NO ROBOT weight limit in BIOBUZZ, so this is the sim's own model of what
  // a given drivetrain can actually move, not a rules clamp.
  const mass = massLimits(out.drivetrain, out.flywheelInertia, bbMassFloorBump(out));
  out.massLb = clampFinite(out.massLb, mass.min, mass.max, base.massLb);

  // 4) HOPPER, from the footprint and the launcher and the mount — so it runs last.
  out.ballStorage = Math.round(
    clampFinite(out.ballStorage, BB_STORAGE_MIN, bbStorageMax(out), base.ballStorage ?? BB_STORAGE_DEFAULT),
  );

  // CR-ONLY FIELDS ARE STRIPPED, not carried. A spec that was a Chain Reaction build before
  // the player switched game arrives here with a catalyst mechanism and a ground clearance
  // BIOBUZZ has no mechanism for; leaving them on the spec means the wire, the snapshot and
  // the builder's summary all describe hardware this robot does not have. `chainIntake` is
  // WRITTEN by the shared pass on the way through, so it has to go too.
  delete out.chainIntake;
  delete out.catalystType;
  delete out.catalystMount;
  delete out.catalystSwing;
  delete out.catapultRange;
  delete out.catapultYaw;
  delete out.groundClearance;

  return out;
}

/**
 * THE MECHANISM LOADOUT, normalized — step 0.
 *
 * ── THE LAUNCHER IS MANDATORY ───────────────────────────────────────────────
 * (Owner ruling 2026-09-12.) The order is fixed and every step is a fold, never a rejection:
 *   1. a spec with no container, or a stored `launcher: null` (an old launcher-less save),
 *      migrates from the flat `scoreMode`/`shooterMount` mirror (`bbLauncherOf`);
 *   2. a legacy `drum` becomes a `dumper` (`BB_LEGACY_SCORE_MODES`), then the enum check —
 *      both inside `bbLauncherOf`, so every fallback site applies the same map;
 *   3. the mount is enum-checked, and a TURRETLESS launcher's folds to an edge (its launch
 *      LINE spans a whole side); a DOUBLE turret's folds off `center`;
 *   4. the hood is clamped;
 *   5. a DOUBLE turret's NECTAR-turret cell (`mount2`) is resolved — never the POLLEN turret's
 *      cell or a neighbour of it — and every other kind carries no `mount2` at all;
 *   6. the Box Tube, which folds around BOTH turrets and never sits on `center`.
 *
 * An unknown archetype reads as a turret here, where it used to read as `base.scoreMode`: the
 * base is `BB_DEFAULT_SPEC` (the Sniper, a turret), so the answer is the same.
 *
 * ⚠️ `raw` IS THE CARRIED-ACROSS INPUT. `bbMech` only reaches this function because
 * `src/sim/spawn.ts`'s biobuzz arm copies it over first; if that line is ever removed this
 * silently falls back to the flat-field migration on every load.
 *
 * IDEMPOTENT: every branch resolves to a value that re-resolves to itself. `mount2` is a pure
 * function of (mount, want) that is chassis-independent, and `bbResolveLiftMount` is a pure
 * function of (want, blockers) whose output is by construction free.
 */
function coerceBbMech(raw: RobotSpec): BbMechSpec {
  const src = bbLauncherOf(raw, BB_HOOD_DEFAULT_DEG);
  const kind = src.kind; // already legacy-mapped and enum-checked by `bbLauncherOf`
  let mount = ((BB_MOUNT_POSITIONS as readonly string[]).includes(src.mount as string)
    ? src.mount
    : BB_DEFAULT_SHOOTER_MOUNT) as BbMountPos;
  if (!isTurreted(kind)) mount = bbShooterEdgeOf({ shooterMount: mount });
  if (kind === 'twinturret') mount = bbFoldTwinMount(mount);
  const hoodDeg = clampFinite(src.hoodDeg, BB_HOOD_MIN_DEG, BB_HOOD_MAX_DEG, BB_HOOD_DEFAULT_DEG);
  // Built without a `mount2` key for every kind but the double turret, so a stale one is dropped.
  const launcher: BbLauncherSpec =
    kind === 'twinturret'
      ? { kind, mount, mount2: bbResolveMount2(mount, src.mount2), hoodDeg }
      : { kind, mount, hoodDeg };

  // THE BOX TUBE. No legacy path — an absent container means no tube.
  const wantLift = bbLiftOf(raw);
  let lift: BbLiftSpec | null = null;
  if (wantLift) {
    const liftKind = (BB_LIFT_KINDS as readonly string[]).includes(wantLift.kind as string)
      ? wantLift.kind
      : BB_LIFT_KINDS[0];
    const liftMount = bbResolveLiftMount(
      BB_LIFT_POSITIONS.includes(wantLift.mount) ? wantLift.mount : BB_LIFT_POSITIONS[0],
      bbLauncherBlocker(launcher),
    );
    // `null` is "no free perimeter cell on this chassis". Dropping the tube is the honest
    // repair; stacking it on the launcher is not. A stored `maxZ` from the removed raise
    // mechanism is dropped by building the object fresh.
    if (liftMount) lift = { kind: liftKind as BbLiftSpec['kind'], mount: liftMount };
  }

  return { launcher, lift };
}
