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
  BB_HOOD_DEFAULT_DEG,
  BB_HOOD_MAX_DEG,
  BB_HOOD_MIN_DEG,
  BB_LIFT_MAX_Z,
  BB_LIFT_MIN_Z,
} from './config';
import {
  BB_LIFT_KINDS,
  type BbLauncherSpec,
  type BbLiftSpec,
  type BbMechSpec,
  bbLauncherBlocker,
  bbLauncherOf,
  bbLiftOf,
  bbResolveLiftMount,
} from './mechs';
import {
  BB_DEFAULT_INTAKE_MOUNT,
  BB_DEFAULT_SHOOTER_MOUNT,
  BB_DEFAULT_TURRET_POS,
  type BbMountPos,
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

  // 5) THE MECHANISM LOADOUT. Runs after the archetype/mount folds above, because the
  // launcher slot MIRRORS them both ways and a half-folded mount would round-trip wrong.
  out.bbMech = coerceBbMech(raw, out);

  // CR-ONLY FIELDS ARE STRIPPED, not carried. A spec that was a Chain Reaction build before
  // the player switched game arrives here with a catalyst mechanism and a ground clearance
  // BIOBUZZ has no mechanism for; leaving them on the spec means the wire, the snapshot and
  // the builder's summary all describe hardware this robot does not have.
  //
  // `chainIntake` belongs to that list and was missing from it, which made it the ONE CR field
  // every BIOBUZZ spec carried. It is not inherited from an old build either — `coerceSpec`
  // WRITES it on the way through (`src/sim/spawn.ts`, the shared pass above this arm), so a
  // spec built from scratch for this game picked it up too. BIOBUZZ has its own intake enum
  // (`BB_INTAKE_STYLES`) and reads this one nowhere. Found by the preset checks: a card
  // defined as its own coerced form could never be a fixed point of the FULL chokepoint while
  // one field was still being added after it.
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
 * THE MECHANISM LOADOUT, normalized — the body of step 5.
 *
 * ── THE ONE THING THIS FUNCTION EXISTS TO GET RIGHT ─────────────────────────
 * `undefined` and `{ launcher: null }` mean different things and must keep meaning different
 * things. A spec with no container predates composable mechanisms, so it HAS a launcher and
 * that launcher is migrated out of `scoreMode` / `shooterMount`. A spec that explicitly says
 * `launcher: null` is a real launcher-less build (Studica's StarterBot) and must survive as
 * one. Collapsing the two is the phantom-turret bug: the shared pass in `src/sim/spawn.ts`
 * writes `out.scoreMode` unconditionally, so anything that reads "no launcher" off an absent
 * `scoreMode` grows a turret on the very next pass.
 *
 * ⚠️ `raw` HERE IS THE CARRIED-ACROSS INPUT, not `out`. `coerceSpec` builds its output from the
 * base spec plus the fields it reads off the input BY NAME, so `bbMech` only reaches this
 * function because `src/sim/spawn.ts`'s biobuzz arm copies it over first. If that line is ever
 * removed this silently falls back to the base spec's loadout on every load — see the ⚠️ block
 * at `spawn.ts:473`.
 *
 * IDEMPOTENT: every branch resolves to a value that re-resolves to itself. The lift's mount is
 * the subtle one — `bbResolveLiftMount` is a pure function of (want, blockers), and running it
 * on its own output returns the same cell because that cell is by construction free.
 */
function coerceBbMech(raw: RobotSpec, out: RobotSpec): BbMechSpec {
  // LAUNCHER. `bbLauncherOf` migrates a spec that has no container yet; everything after it is
  // validation of whatever came back.
  //
  // ⚠️ THE CONTAINER IS AUTHORITATIVE, AND THE FLAT FIELDS MIRROR IT — not the other way round.
  // This read used to take `kind`/`mount` off `out.scoreMode`/`out.shooterMount` (already
  // folded in steps 1a/1c), which quietly made the FLAT fields the source of truth: a caller
  // that patched only `bbMech` — the obvious thing to do, and what the builder tried first —
  // had its edit overwritten by the old archetype on the very next coercion, with nothing
  // failing. That is the container's whole purpose inverted. So the container is folded on its
  // OWN values here and mirrored OUT below, and `scoreMode`/`shooterMount` are what an older
  // peer reads rather than what this game reads.
  const src = bbLauncherOf(raw, BB_HOOD_DEFAULT_DEG);
  let launcher: BbLauncherSpec | null = null;
  if (src) {
    // Same two folds steps 1a/1c apply to the flat fields, applied to the container's values:
    // an unknown archetype falls back, and a TURRETLESS launcher cannot sit on a corner or the
    // centre because its launch LINE has to span a whole side.
    const kind = ((BB_SCORE_MODES as readonly string[]).includes(src.kind as string)
      ? src.kind
      : BB_DEFAULT_SCORE_MODE) as BbScoreMode;
    let mount = ((BB_MOUNT_POSITIONS as readonly string[]).includes(src.mount as string)
      ? src.mount
      : BB_DEFAULT_SHOOTER_MOUNT) as BbMountPos;
    if (!isTurreted(kind)) mount = bbShooterEdgeOf({ shooterMount: mount });
    launcher = {
      kind,
      mount,
      hoodDeg: clampFinite(src.hoodDeg, BB_HOOD_MIN_DEG, BB_HOOD_MAX_DEG, BB_HOOD_DEFAULT_DEG),
    };
  }

  // LIFT. No legacy path — nothing in this repo has ever modelled one, so an absent container
  // means no lift rather than a lift to migrate.
  const wantLift = bbLiftOf(raw);
  let lift: BbLiftSpec | null = null;
  if (wantLift) {
    const kind = (BB_LIFT_KINDS as readonly string[]).includes(wantLift.kind as string)
      ? wantLift.kind
      : BB_LIFT_KINDS[0];
    // The mast folds around the launcher rather than the other way round: the launcher has the
    // harder constraint (a turretless one needs a whole edge) and it is the mechanism a legacy
    // spec already had, so gaining a lift never relocates hardware the player already placed.
    const mount = bbResolveLiftMount(
      (BB_MOUNT_POSITIONS as readonly string[]).includes(wantLift.mount as string)
        ? wantLift.mount
        : BB_DEFAULT_TURRET_POS,
      bbLauncherBlocker(launcher),
    );
    // `null` is "there is no free cell on this chassis" — a real answer for a build whose
    // turretless launcher spans an edge and whose remaining cells are taken. Dropping the lift
    // is the honest repair; silently stacking it on the launcher is not.
    if (mount) {
      lift = { kind: kind as BbLiftSpec['kind'], mount, maxZ: clampFinite(wantLift.maxZ, BB_LIFT_MIN_Z, BB_LIFT_MAX_Z, BB_LIFT_MAX_Z) };
    }
  }

  // MIRROR THE CONTAINER BACK ONTO THE FLAT FIELDS. They are what an older peer or server
  // reads — it drops `bbMech` entirely, so without this a spec that round-trips through one
  // comes back describing a different robot.
  //
  // A LAUNCHER-LESS BUILD IS THE LOSSY CASE, and knowingly so: there is no flat value that
  // says "no launcher", so `scoreMode` keeps whatever it had and an old peer sees a launcher
  // this robot does not have. An omission would be better than a phantom, but the flat schema
  // cannot express one — it is a rollout-window cost for a build class that could not exist at
  // all before today, and it belongs in the release note rather than in a workaround here.
  if (launcher) {
    out.scoreMode = launcher.kind;
    out.shooterMount = launcher.mount;
    out.shooterRear = launcher.mount === 'back';
  }

  return { launcher, lift };
}
