import { coerceZenithAuto } from '../auto/coerce';
import type { ZenithAutoSetup } from '../auto/types';
import type {
  Alliance,
  Artifact,
  ArtifactColor,
  AssistConfig,
  DrivetrainType,
  GameId,
  GameMode,
  GoalState,
  Motif,
  RobotSpec,
  RobotState,
  World,
  AutoPathData, // Import AutoPathData
  GameSettings, // Import GameSettings
  PathPoint, // Import PathPoint
  PathLine,
  SequenceItem,
  ControlPoint, // Import ControlPoint
  StartPose,
} from '../types';
import * as C from '../config';
/**
 * The start-anchor COUNT is per game, so the spawn chokepoint has to ask the
 * registry for it. This is a genuine import CYCLE (`games/sim` → `decode/sim` →
 * here) and it is safe only because nothing is read at module-eval time:
 * `simModuleFor` is a hoisted function declaration and `coerceSetup` calls it at
 * runtime. Do not move a registry read to this file's top level.
 */
import { simModuleFor } from '../games/sim';
/**
 * The BIOBUZZ arm of `coerceSpec`, from a LEAF module. It holds this game's own clamps (the
 * size envelope per intake mount, the archetype mass floor, the hopper ceiling) so that no
 * BIOBUZZ number lives in `src/sim/` — the same split Chain Reaction's arm uses, and the repo
 * rule in `docs/biobuzz-contract.md`. It must stay a leaf: it is a DEPENDENCY of this file, so
 * an import there that reached back here would be a cycle around the shared chokepoint.
 */
import { coerceBiobuzzSpec } from '../games/biobuzz/coerce';
import {
  CHAIN_CLEARANCE_DEFAULT,
  CHAIN_CLEARANCE_MAX,
  CHAIN_CLEARANCE_MIN,
  CHAIN_STORAGE_DEFAULT,
  CHAIN_STORAGE_MIN,
  chainStorageMax,
  chainMassFloorBump,
  CHAIN_CATALYST_TYPES,
  CHAIN_DEFAULT_CATALYST,
  CHAIN_DEFAULT_CATALYST_MOUNT,
  CHAIN_CATAPULT_RANGE_MIN,
  CHAIN_CATAPULT_RANGE_MAX,
  CHAIN_CATAPULT_RANGE_DEFAULT,
  CHAIN_CATAPULT_YAW_DEFAULT,
  CHAIN_CATAPULT_YAW_STEP,
  CHAIN_DEFAULT_SCORE_MODE,
  CHAIN_DEFAULT_INTAKE,
  CHAIN_SCORE_MODES,
  CHAIN_INTAKE_STYLES,
  chainSizeLimits,
  chainMountFits,
} from '../games/chain/config';
import {
  CHAIN_DEFAULT_INTAKE_MOUNT,
  CHAIN_DEFAULT_SHOOTER_MOUNT,
  CHAIN_CATALYST_MOUNTS,
  CHAIN_RAIL_MOUNTS,
  intakeMountOf,
  SWING_MOUNTS,
  isEdgePos,
  isSwingMount,
  isTurreted,
  mountsClash,
  railEdgeOf,
  shooterEdgeOf,
  shooterMountOf,
} from '../games/chain/mounts';
import { nextRandom, wrapAngle, rot, clamp } from '../math'; // Import wrapAngle
import { COSMETIC_AXES, clampCosmetics, type Cosmetics } from '../cosmetics';
import { butterflyTankRpmLimits, lengthLimits, massLimits, rpmLimits, widthLimits } from './drivetrain';
import { heldSlotPos } from './physics';
import { flywheelSpinTarget, loadPreStage, spikeMarkBalls, startPose } from './field';
import { emptyScore } from './scoring';

export const MOTIFS: Motif[] = [
  ['green', 'purple', 'purple'], // obelisk AprilTag 21: GPP
  ['purple', 'green', 'purple'], // 22: PGP
  ['purple', 'purple', 'green'], // 23: PPG
];

/**
 * The DEFAULT spec now LIVES IN A LEAF (`./specDefaults`) and is re-exported here, so every
 * existing importer is unchanged. It had to move: a game module reads it at MODULE-EVAL time
 * (BIOBUZZ's `BB_DEFAULT_SPEC` is a top-level spread of it), and this file is inside the
 * registry import cycle, so the read landed in `DEFAULT_SPEC`'s TDZ and threw at import.
 * `specDefaults.ts`'s header has the whole story. Do not move it back.
 */
import { DEFAULT_SPEC } from './specDefaults';
export { DEFAULT_SPEC };

// Neutral sim/wire FALLBACK for assists (used by coercion bases, replay, server
// fill-robots, dummies, and smoke). Deliberately NOT the same as the player's
// menu default (`defaultAssistsFor` below): tests + fallbacks want auto OFF.
export const DEFAULT_ASSISTS: AssistConfig = {
  fieldCentric: true,
  aimAssist: true,
  autoIntake: false,
  autoFire: false,
};

/**
 * The player-facing DEFAULT assists, and the default for `RobotSpec.assists` — EVERY assist
 * is ON, including field-centric drive, for every drivetrain and BOTH games.
 *
 * Assists used to be remembered per DRIVETRAIN (with swerve alone defaulting field-centric);
 * they are now saved ON THE ROBOT (`RobotSpec.assists`), so the memory is per-build and the
 * per-drivetrain library is gone. Distinct from `DEFAULT_ASSISTS` above, which stays auto-OFF
 * as the neutral sim/wire fallback for replay, dummies, and smoke.
 */
export const PLAYER_ASSISTS: AssistConfig = {
  fieldCentric: true,
  aimAssist: true,
  autoIntake: true,
  autoFire: true,
};

/** the player default (kept as a function for call sites; no longer drivetrain-dependent) */
export function defaultAssistsFor(_d?: DrivetrainType): AssistConfig {
  return { ...PLAYER_ASSISTS };
}

// ---- untrusted-input sanitization -------------------------------------------
// A player's robot config arrives from localStorage (hand-editable) AND, in
// multiplayer, straight off the wire from an untrusted client (people have
// spoofed it via devtools to spawn oversized / NaN-dimensioned robots). These
// coercers are the SINGLE SOURCE OF TRUTH for "what is a legal config": every
// numeric field is forced finite and clamped to its per-drivetrain / per-preset
// range, every enum is checked, and anything missing falls back to a default.
// They are IDEMPOTENT, so it is safe to run them at multiple layers (client
// settings load, server ingress, AND createWorld) — belt and suspenders.

/** clamp `n` to [lo,hi], substituting `fallback` when it is not a finite number
 * (guards against NaN/Infinity: bare `clamp(NaN,...)` returns NaN unchanged) */
function clampFinite(n: unknown, lo: number, hi: number, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? clamp(n, lo, hi) : clamp(fallback, lo, hi);
}

/** Coerce an arbitrary value into a fully-legal RobotSpec. Unknown/missing/
 * corrupt fields fall back to `base` (default: DEFAULT_SPEC); all numeric fields
 * are clamped to their legal ranges (length per intake preset, mass per
 * drivetrain×inertia, rpm per drivetrain). Never throws; always returns a spec
 * safe to spawn. */
export function coerceSpec(raw: unknown, base: RobotSpec = DEFAULT_SPEC, game?: GameId): RobotSpec {
  const out: RobotSpec = { ...base };
  const sp = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;

  // The clamp order is DELIBERATE — it mirrors the builder UI's dependency graph
  // exactly, so a hand-edited / spoofed / stale spec is bounded the same way the
  // sliders bound a live one. Each numeric range is resolved from ONLY the
  // field(s) it depends on, in this order:
  //   1. INTAKE + DRIVETRAIN → length range (intake) + width range (drivetrain floor)
  //   2. DRIVETRAIN         → rpm range                     (rpmLimits)
  //   3. INERTIA            → 0..1
  //   4. DRIVETRAIN×INERTIA → mass range                   (massLimits: floor ↑ inertia)

  // resolve INTAKE + DRIVETRAIN first (width's floor depends on the drivetrain —
  // swerve needs a wider base). Legacy preset names from older saves migrate.
  if (sp.intake === 'sloped' || sp.intake === 'vector' || sp.intake === 'triangle') out.intake = sp.intake;
  else if (sp.intake === 'compact') out.intake = 'sloped';
  else if (sp.intake === 'extended') out.intake = 'vector';
  if (
    sp.drivetrain === 'mecanum' ||
    sp.drivetrain === 'tank' ||
    sp.drivetrain === 'swerve' ||
    sp.drivetrain === 'xdrive' ||
    sp.drivetrain === 'butterfly'
  ) {
    out.drivetrain = sp.drivetrain;
  }

  // 1) SIZE: length from the intake preset, width floored per drivetrain (DECODE).
  // CR sizes are bounded per BUILD: the sweeper is structure inside the 18" start cube, and
  // its MOUNT decides which axis it eats (ends → length, flanks → width). Resolve the mount
  // first — it is normalised further down, but the size clamp needs it now.
  let preMount = intakeMountOf(
    (sp.intakeMount !== undefined || sp.intakeSide !== undefined ? sp : base) as RobotSpec,
  );
  // a mount whose intake cannot fit the start cube is not a legal build — fall back to the
  // single front sweeper rather than clamping to an oversized chassis
  if (game === 'chain' && !chainMountFits({ ...out, intakeMount: preMount }, preMount)) preMount = 'front';
  const crSize = chainSizeLimits({ ...out, intakeMount: preMount });
  const len =
    game === 'chain'
      ? { min: crSize.minLength, max: crSize.maxLength }
      : lengthLimits(out.intake);
  const wid =
    game === 'chain'
      ? { min: crSize.minWidth, max: crSize.maxWidth }
      : widthLimits(out.intake, out.drivetrain);
  out.length = clampFinite(sp.length, len.min, len.max, base.length);
  out.width = clampFinite(sp.width, wid.min, wid.max, base.width);

  // 2) DRIVETRAIN → rpm range. BUTTERFLY has TWO geared wheel sets, so it has two
  // sliders: `driveRpm` is its mecanum set (the shared field) and `tankRpm` its traction
  // set, clamped to the torque-biased tank envelope. `tankRpm` is written for butterfly
  // only and STRIPPED otherwise, so a spec that switches away can't smuggle a stale value
  // back if it switches return — the same normalize-at-the-chokepoint rule the CR mounts use.
  const rpm = rpmLimits(out.drivetrain);
  out.driveRpm = clampFinite(sp.driveRpm, rpm.min, rpm.max, base.driveRpm);
  if (out.drivetrain === 'butterfly') {
    const tl = butterflyTankRpmLimits();
    const rawTank = sp.tankRpm !== undefined ? sp.tankRpm : base.tankRpm;
    out.tankRpm = clampFinite(rawTank, tl.min, tl.max, clamp(out.driveRpm, tl.min, tl.max));
  } else {
    delete out.tankRpm;
  }

  // 3) INERTIA in 0..1
  out.flywheelInertia = clampFinite(sp.flywheelInertia, 0, 1, base.flywheelInertia);

  // 4) MASS range from DRIVETRAIN × INERTIA (the floor rises with inertia), PLUS any
  // heavy game mechanism. The CR scoring archetype is resolved just below for storage,
  // so read it here from the raw/base input the same way — a twin turret carries a whole
  // second flywheel assembly and cannot be built at the lightest weights.
  const preMode = (CHAIN_SCORE_MODES as readonly string[]).includes(sp.scoreMode as string)
    ? (sp.scoreMode as RobotSpec['scoreMode'])
    : (base.scoreMode ?? CHAIN_DEFAULT_SCORE_MODE);
  const preCatalyst = (CHAIN_CATALYST_TYPES as readonly string[]).includes(sp.catalystType as string)
    ? (sp.catalystType as RobotSpec['catalystType'])
    : (base.catalystType ?? CHAIN_DEFAULT_CATALYST);
  // the catapult's RANGE feeds its weight, so it has to be resolved before the mass clamp
  // (it is written to `out` further down, in the catalyst block)
  const preRange = clampFinite(
    sp.catapultRange !== undefined ? sp.catapultRange : base.catapultRange,
    CHAIN_CATAPULT_RANGE_MIN,
    CHAIN_CATAPULT_RANGE_MAX,
    CHAIN_CATAPULT_RANGE_DEFAULT,
  );
  const mass = massLimits(
    out.drivetrain,
    out.flywheelInertia,
    game === 'chain'
      ? chainMassFloorBump({ ...out, scoreMode: preMode, catalystType: preCatalyst, catapultRange: preRange })
      : 0,
  );
  out.massLb = clampFinite(sp.massLb, mass.min, mass.max, base.massLb);

  // Chain Reaction scoring archetype + intake design (enum checks, defaulted). Resolved
  // BEFORE ball storage: the storage MAX depends on the archetype (+ the size above).
  out.scoreMode = (CHAIN_SCORE_MODES as readonly string[]).includes(sp.scoreMode as string)
    ? (sp.scoreMode as RobotSpec['scoreMode'])
    : (base.scoreMode ?? CHAIN_DEFAULT_SCORE_MODE);
  out.chainIntake = (CHAIN_INTAKE_STYLES as readonly string[]).includes(sp.chainIntake as string)
    ? (sp.chainIntake as RobotSpec['chainIntake'])
    : (base.chainIntake ?? CHAIN_DEFAULT_INTAKE);
  // COSMETICS: chassisColor/accent/decal/plate — four closed axes, `src/cosmetics.ts`. SHAPE
  // ONLY, never entitlement (plan §3.3, docs/cosmetics-plan.md): this coercer also runs over
  // REPLAY RE-SIMULATION, which must always reproduce the look a run was recorded with,
  // whoever is watching it today or what their supporter/earned status is now — baking a tier
  // check in here would silently downgrade an old replay's cosmetics the first time a
  // membership lapses or a key gets re-tiered. Entitlement is enforced only at the server's
  // live ingress (`server/room.ts`, `stripUnentitledCosmetics`), strictly after this clamp.
  // Per axis: an allowlisted raw value wins; otherwise fall back to `base`'s own value for
  // that axis IF IT IS ITSELF a legal key (never propagate an invalid/spoofed base forward);
  // `clampCosmetics` then folds whatever survives onto its closed set, defaulting anything
  // still unrecognised — the same "unknown falls back to base, else default" rule the old
  // single-axis chassisColor clamp used, now shared by all four. Idempotent: re-running this
  // on its own output changes nothing, since every surviving value is already a legal key.
  const cosmeticIn: Cosmetics = {};
  for (const axis of Object.keys(COSMETIC_AXES) as (keyof Cosmetics)[]) {
    const v = sp[axis];
    const bv = base[axis];
    cosmeticIn[axis] =
      typeof v === 'string' && COSMETIC_AXES[axis].includes(v)
        ? v
        : typeof bv === 'string' && COSMETIC_AXES[axis].includes(bv)
          ? bv
          : undefined;
  }
  const cosmetics = clampCosmetics(cosmeticIn);
  out.chassisColor = cosmetics.chassisColor;
  out.accent = cosmetics.accent;
  out.decal = cosmetics.decal;
  out.plate = cosmetics.plate;
  // MECHANISM MOUNTS. Enum-checked, with the legacy `intakeSide`/`shooterRear` booleans as the
  // fallback so old saves + older peers migrate (see games/chain/mounts.ts). `intakeMountOf`/
  // `shooterMountOf` do exactly that resolution, so run them on the RAW input first, then fall
  // back to the base spec's resolved mount when the raw value carried nothing at all.
  const rawMounts = sp as Pick<RobotSpec, 'intakeMount' | 'intakeSide' | 'shooterMount' | 'shooterRear'>;
  const hasIntakeMount = sp.intakeMount !== undefined || sp.intakeSide !== undefined;
  const hasShooterMount = sp.shooterMount !== undefined || sp.shooterRear !== undefined;
  // CATALYST mechanism: type + mount, enum-checked like the others. Resolved BEFORE the
  // mass clamp above reads it? No — mass is clamped earlier, so the floor uses the RAW
  // type via `preMode`'s sibling below; keep both in sync if a new heavy mechanism lands.
  out.catalystType = (CHAIN_CATALYST_TYPES as readonly string[]).includes(sp.catalystType as string)
    ? (sp.catalystType as RobotSpec['catalystType'])
    : (base.catalystType ?? CHAIN_DEFAULT_CATALYST);
  // 'frontback' is not in CHAIN_CATALYST_MOUNTS any more (it was the swing, not a place), but
  // it still arrives from old saves and older clients — accept it here and migrate it below.
  out.catalystMount =
    (CHAIN_CATALYST_MOUNTS as readonly string[]).includes(sp.catalystMount as string) ||
    sp.catalystMount === 'frontback'
      ? (sp.catalystMount as RobotSpec['catalystMount'])
      : (base.catalystMount ?? CHAIN_DEFAULT_CATALYST_MOUNT);
  // the axis, accepting BOTH legacy shapes: the boolean this field briefly was (⇒ fore-aft,
  // the only kind that existed then) and the `'frontback'` mount before that
  out.catalystSwing =
    sp.catalystSwing === true || sp.catalystSwing === 'fb'
      ? 'fb'
      : sp.catalystSwing === 'lr'
        ? 'lr'
        : sp.catalystSwing === false
          ? undefined
          : base.catalystSwing;
  // CATAPULT build: range (in) and the fixed mounting yaw (deg, 15° steps). Only meaningful
  // on the launcher, but kept on the spec unconditionally so switching mechanism back and
  // forth doesn't silently discard the build.
  out.catapultRange = Math.round(
    clampFinite(
      sp.catapultRange !== undefined ? sp.catapultRange : base.catapultRange,
      CHAIN_CATAPULT_RANGE_MIN,
      CHAIN_CATAPULT_RANGE_MAX,
      CHAIN_CATAPULT_RANGE_DEFAULT,
    ),
  );
  {
    const rawYaw = sp.catapultYaw !== undefined ? sp.catapultYaw : base.catapultYaw;
    const y = clampFinite(rawYaw, -180, 180, CHAIN_CATAPULT_YAW_DEFAULT);
    out.catapultYaw = Math.round(y / CHAIN_CATAPULT_YAW_STEP) * CHAIN_CATAPULT_YAW_STEP;
  }
  out.intakeMount = game === 'chain' ? preMount : hasIntakeMount ? intakeMountOf(rawMounts) : intakeMountOf(base);
  out.shooterMount = hasShooterMount ? shooterMountOf(rawMounts) : shooterMountOf(base);
  // A TURRETLESS launcher fires along a LINE spanning a chassis SIDE, so a corner or centre
  // mount is not something it can be built as — fold it to the nearest edge. A TURRET keeps any
  // of the nine positions: it aims itself, so its mount is where it is BOLTED (and therefore
  // where the Particle is born), not a facing. Resolved HERE, the one chokepoint, so a spec
  // that changes archetype later can never keep a mount that archetype cannot have.
  if (!isTurreted(out.scoreMode)) out.shooterMount = shooterEdgeOf({ shooterMount: out.shooterMount });

  // MOUNTS BELONG TO THE GAMES THAT HAVE THEM. They are the one CR field with a SHARED
  // physics effect — the intake mount moves the collision footprint (`footprintExtents`), so a
  // CR build's side sweeper leaking into DECODE would widen its flanks and delete its front
  // intake reach. The builder only offers mounts for the games that use them and `switchGame`
  // keeps a per-game spec, but a spec can still arrive from a hand-edited store, a pre-loadouts
  // save, or an untrusted client whose build doesn't match the room's game — so normalize here,
  // the chokepoint every one of those passes.
  // Only when the game is EXPLICITLY known and does not use the fields: `game` is optional on
  // several call paths, and treating "unspecified" as DECODE would silently wipe a real build.
  //
  // BIOBUZZ IS EXEMPT because it rides these same two fields (see `games/biobuzz/mounts.ts`:
  // reusing them rather than minting `bb*` twins is what lets the shared footprint reader work
  // for it), and its own arm below is the authority on them — it enum-checks both against this
  // game's lists, folds a corner mount off a turretless launcher, re-derives the size envelope
  // from the intake mount and re-mirrors the legacy booleans. Wiping them here instead spawned
  // every turretless build with a front drum whatever edge was picked and bolted every turret
  // to the front whatever the nine positions offered.
  if (game !== undefined && game !== 'chain' && game !== 'biobuzz') {
    out.intakeMount = CHAIN_DEFAULT_INTAKE_MOUNT;
    out.shooterMount = CHAIN_DEFAULT_SHOOTER_MOUNT;
  }
  // MIRROR the deprecated booleans so a spec routed through an older peer/server (which drops
  // the fields it doesn't know) round-trips to the nearest legal mount instead of resetting.
  out.intakeSide = out.intakeMount === 'side';
  out.shooterRear = out.shooterMount === 'back';

  /**
   * CATALYST PLACEMENT — resolved HERE, AFTER the per-game mount reset above.
   *
   * It depends on the SHOOTER mount, so it has to run once that is final. Running it any
   * earlier is not just untidy, it breaks IDEMPOTENCY: a DECODE spec has its shooter mount
   * reset to the default further down, so a first pass would place the catalyst against the
   * raw mount and a second pass against the reset one, and coerceSpec runs at several layers.
   *
   * Two rules, both physical:
   *  1. A RAIL's track spans a whole chassis SIDE, so it can only be bolted to one of the
   *     four EDGES. A corner has no span to run along and the frontback swing is a different
   *     mechanism. Folded like the turretless launcher's firing edge is folded.
   *  2. NO TWO MECHANISMS SHARE A CELL. There is one piece of frame in a given spot and only
   *     one thing can be mounted to it, so a catalyst is pushed off any cell the shooter or
   *     the intake already occupies (`occupiedCells` handles the edge-spanning and frontback
   *     cases, which take more than one cell each).
   *
   * Done at the chokepoint rather than in the builder so a spec that changes archetype,
   * mount or intake later can never end up with two mechanisms in the same place — including
   * one arriving from an older client that never knew the rule.
   */
  {
    const railed = out.catalystType === 'rail';
    /**
     * THE SWING, resolved before anything else reads the mount.
     *
     * `'frontback'` was the old way of saying "a centre-pivot swing" — a MOUNT that was
     * really a mechanism, which is why "a swing, on the right" could not be expressed. It is
     * migrated here rather than at the call sites so every reader (sim, renderers, picker,
     * the wire) sees one shape.
     *
     * Then two physical rules: a RAIL is a track, not a pivot, so it never swings; and a
     * pivot needs a front and a back to swing between, so it lives on the centre line or a
     * flank. An illegal pairing drops the SWING rather than moving the mount — the player
     * chose where to bolt it, and silently relocating hardware is the thing this whole block
     * exists to avoid.
     */
    if (out.catalystMount === ('frontback' as RobotSpec['catalystMount'])) {
      out.catalystMount = 'center';
      out.catalystSwing = 'fb';
    }
    // Only the ARM swings (a turret aims itself, a rail traverses), and a pivot only works
    // where BOTH of its ends are reachable — which depends on the axis, so the mechanism and
    // the position are checked together.
    if (
      out.catalystType !== 'arm' ||
      (out.catalystSwing && !isSwingMount(out.catalystMount as string, out.catalystSwing))
    ) {
      out.catalystSwing = undefined;
    }
    // ...and the middle of a chassis reaches nothing without one, so a centre mount that is
    // not a pivot falls to the front edge.
    if (out.catalystMount === 'center' && !out.catalystSwing) out.catalystMount = 'front';
    if (railed && !isEdgePos(out.catalystMount as string)) {
      out.catalystMount = railEdgeOf(out.catalystMount as string);
    }
    // What the SHOOTER is sitting on. A turretless launcher fires along a line spanning its
    // edge, so it takes that whole side; a turret is a single bolted cell.
    //
    // The INTAKE is deliberately NOT a blocker. A sweeper is a low roller at floor level and
    // a claw arm reaches over it — real robots stack those two all the time — whereas the
    // shooter and the catalyst both want the deck. Counting the sweeper would also make two
    // of the shipped preset builds illegal (front+back sweepers plus a front/back swing claw),
    // which is a strong hint the rule is about the deck rather than about the edge.
    const blockers = [{ pos: out.shooterMount as string, spansEdge: !isTurreted(out.scoreMode) }];
    const clashes = (m: string): boolean =>
      blockers.some((b) => mountsClash({ pos: m, spansEdge: railed, swing: out.catalystSwing ?? null }, b));
    if (clashes(out.catalystMount as string)) {
      // The fallback set has to be places THIS mechanism can legally live, or the relocation
      // silently produces a build the next pass has to fix again — which is exactly how this
      // broke idempotency: a swing pushed onto a corner had its swing quietly dropped on the
      // second pass, so coerceSpec(coerceSpec(x)) !== coerceSpec(x).
      const options = railed
        ? (CHAIN_RAIL_MOUNTS as readonly string[])
        : out.catalystSwing
          ? (SWING_MOUNTS[out.catalystSwing] as readonly string[])
          : (CHAIN_CATALYST_MOUNTS as readonly string[]).filter((m) => m !== 'center');
      const free = options.find((m) => !clashes(m));
      // if EVERY position clashes the build is over-stuffed; leave the mount alone rather
      // than inventing one, and let the builder's own warning explain it
      if (free) out.catalystMount = free as RobotSpec['catalystMount'];
    }
  }
  // Chain Reaction ball storage — clamped to the archetype+size max (chainStorageMax). NOTE: the
  // intake-mount storage penalty depends on out.intakeMount, so it's resolved BEFORE this clamp.
  out.ballStorage = Math.round(
    clampFinite(
      sp.ballStorage,
      CHAIN_STORAGE_MIN,
      chainStorageMax(out),
      base.ballStorage ?? CHAIN_STORAGE_DEFAULT,
    ),
  );
  // Chain Reaction ground clearance (inches) — over-a-beam capability vs raised CoG
  out.groundClearance = clampFinite(
    sp.groundClearance,
    CHAIN_CLEARANCE_MIN,
    CHAIN_CLEARANCE_MAX,
    base.groundClearance ?? CHAIN_CLEARANCE_DEFAULT,
  );

  // DRIVER ASSISTS ride the robot (both games), every flag defaulting ON. Each flag is
  // validated independently, so an old spec with no `assists` (or a partial one off the
  // wire) fills from the base rather than being dropped.
  out.assists = coerceAssists(sp.assists, base.assists ?? PLAYER_ASSISTS);

  // identity + flags (no cross-field dependency)
  if (typeof sp.canSort === 'boolean') out.canSort = sp.canSort;
  if (typeof sp.name === 'string' && sp.name.trim()) out.name = sp.name.slice(0, 24);
  if (typeof sp.teamName === 'string') out.teamName = sp.teamName.slice(0, 48);
  out.teamNumber = Math.round(clampFinite(sp.teamNumber, 0, 99999, base.teamNumber));

  /**
   * THE BIOBUZZ ARM, LAST — this game's own clamps, over a spec every shared pass above has
   * already bounded.
   *
   * Last rather than interleaved, because the two halves clamp DIFFERENT things and the second
   * depends on the first: the shared pass fixes the intake preset, the drivetrain, the rpm and
   * the inertia, and BIOBUZZ's size envelope, mass floor and hopper ceiling are all derived
   * from those plus the mounts resolved just above. Interleaving would mean resolving a range
   * from a field that is not final yet, which is exactly what breaks IDEMPOTENCY — and
   * `coerceSpec` running at several layers (settings load, server ingress, `createWorld`) is
   * what makes idempotency load-bearing rather than tidy. The BIOBUZZ smoke suite asserts
   * `f(f(x)) === f(x)` over a hostile input matrix and over all 26 shipped builds.
   *
   * It also STRIPS the Chain Reaction fields a BIOBUZZ robot has no mechanism for (the
   * catalyst, the catapult, the ground clearance), which is why it has to run after the blocks
   * above write them. Moving it ahead of the CR blocks would put those fields BACK on the spec
   * after the strip, so a BIOBUZZ robot would carry a catalyst mount again — the ordering is
   * load-bearing in both directions.
   *
   * ⚠️ WHAT "LAST" DOES NOT MEAN, and the trap for the first `bb*` spec field: this arm is
   * handed `out`, not the RAW input. `out` starts as a copy of `base` and gains only the fields
   * the passes above explicitly read off `sp`, so a value that no shared pass knows about is
   * already gone by the time the game coercer runs — it would silently fall back to the base
   * spec's value on every load, every wire ingress and every `createWorld`, which reads as "the
   * builder keeps forgetting my setting". The fix, when a BIOBUZZ-only field lands, is to carry
   * it across HERE (copy it onto `out`, or hand `coerceBiobuzzSpec` the raw `sp` as a second
   * input) — NOT to move the arm earlier, for the two order reasons above. Chain Reaction has
   * the same shape and does not hit it only because every CR field is read off `sp` by name in
   * this function. `docs/biobuzz-contract.md` §4 is where a new field is registered; add the
   * carry-across in the same change.
   */
  if (game === 'biobuzz') {
    // THE CARRY-ACROSS the ⚠️ block above describes, and `bbMech` is the first field to need
    // it. Nothing in the shared passes reads it by name, so without this line it is already
    // gone by the time the game coercer runs and every mechanism loadout would silently revert
    // to the base spec's on every load, every wire ingress and every `createWorld`.
    //
    // Copied onto `out` UNVALIDATED on purpose: this is a transport step, and
    // `coerceBiobuzzSpec` is the one place allowed to decide what a legal loadout is. It also
    // must NOT default — `undefined` and `{ launcher: null }` mean different things to that
    // function (a legacy spec to migrate vs. a robot with genuinely no launcher).
    out.bbMech = sp.bbMech as RobotSpec['bbMech'];
    // the SAME carry-across for heightIn -- coerceBiobuzzSpec clamps it (BB3_HEIGHT_MIN..MAX)
    // off this field by name, and nothing in the shared passes above reads it, so without this
    // line every real caller (settings load, server ingress, createWorld) silently dropped a
    // spec's heightIn before the biobuzz clamp ever saw it -- see this lane's final report.
    out.heightIn = sp.heightIn as RobotSpec['heightIn'];
    // and the declared stow height (R102), read structurally downstream -- same reason
    out.stowHeightIn = sp.stowHeightIn as RobotSpec['stowHeightIn'];
    // and the PASS TARGET pair (`PassPicker.tsx`) -- same trap, same fix. Without this, every
    // edit from the builder's map/preset picker reverted on the very next coercion (which
    // `setSpec` runs on every keystroke), reading as "the picker does nothing" even though the
    // click handler fires and the patch reaches this function correctly.
    out.bbPassTarget = sp.bbPassTarget as RobotSpec['bbPassTarget'];
    out.bbPassPreset = sp.bbPassPreset as RobotSpec['bbPassPreset'];
    // ⚠️ AND THE MASS, RAW — this one is a carry-across of a SHARED field, for the opposite
    // reason to the four above: the shared pass DID read it, and that is the problem. BIOBUZZ
    // owns its own mass model (`bbMassLimits`: a bare chassis per drivetrain plus every
    // mechanism bolted to it), and `massLimits`' per-drivetrain floor prices in a DECODE
    // shooter, so it sits ABOVE that model for every drivetrain — a mecanum turret build floors
    // at 18.00 in this game and the shared pass had already lifted it to 18 + 4·inertia, a tank
    // one at 19.50 against 22. Step 4 above would therefore raise a legal light build before the
    // game's own clamp could see it, and a preset the coercer moves is a card that can never
    // read as selected. Unvalidated like the fields above: `coerceBiobuzzSpec` re-clamps it
    // (through `clampFinite`, so NaN / Infinity / absent all still fall back to `base`).
    out.massLb = sp.massLb as RobotSpec['massLb'];
    return coerceBiobuzzSpec(out, base);
  }
  return out;
}

/** Coerce an arbitrary value into a legal AssistConfig (each flag defaults to
 * `base` when absent / non-boolean). */
export function coerceAssists(raw: unknown, base: AssistConfig = DEFAULT_ASSISTS): AssistConfig {
  const out: AssistConfig = { ...base };
  if (typeof raw === 'object' && raw !== null) {
    const a = raw as Record<string, unknown>;
    for (const k of ['fieldCentric', 'aimAssist', 'autoIntake', 'autoFire'] as const) {
      if (typeof a[k] === 'boolean') out[k] = a[k];
    }
  }
  // AIM ASSIST IS ALWAYS ON, in BOTH games — the menu toggle is gone, and this is what
  // makes that true rather than merely unreachable. It has to be HERE, because a stored
  // `false` can arrive from four directions: localStorage, a synced account blob, a saved
  // robot slot (`coerceSpec` routes through this), and the wire. Forcing it only in the UI
  // would leave anyone who had switched it off before the removal stuck on manual aim with
  // no control to switch it back.
  //
  // The SIM still branches on `r.aimAssist` (the manual-aim turret path in robot.ts, and
  // Chain's `chainAimAssist`), so the behaviour is intact and tested — tests set the flag
  // on the spawned robot directly. Restoring the option is deleting this line and putting
  // the toggle back in Menu.tsx.
  out.aimAssist = true;
  return out;
}

/** clamp a single path point's coordinates to the field (finite, in-bounds) so a
 * spoofed auto path can never teleport a robot out of the world or to NaN */
function coercePathPoint(p: PathPoint): PathPoint {
  const out: PathPoint = { ...p };
  out.x = clampFinite(p.x, -C.FIELD_HALF, C.FIELD_HALF, 0);
  out.y = clampFinite(p.y, -C.FIELD_HALF, C.FIELD_HALF, 0);
  for (const k of ['startDeg', 'endDeg', 'degrees'] as const) {
    if (out[k] !== undefined) out[k] = clampFinite(out[k], -720, 720, 0);
  }
  return out;
}

/** Auto-path size bounds. An auto path arrives from a hand-editable file picker AND
 * from the wire, is stored on `RobotState`, and rides every snapshot and replay, so
 * each unbounded array is a size amplifier rather than an exploit (`readBody` already
 * caps an upload at 512 KiB). `lines` was the only one bounded. */
const PATH_MAX_LINES = 200;
const PATH_MAX_SEQUENCE = 400; // read every tick by `pathTraversal`; 2 items per line is the real shape
const PATH_MAX_CONTROL_POINTS = 8;
const PATH_MAX_WAIT_MS = 30000; // one match; a longer wait is indistinguishable from "never move"

/** Structurally validate + bound-clamp an auto path from untrusted input. Returns
 * null when the shape is not a usable AutoPathData (the caller then disables auto
 * pathing). Coordinates are clamped to the field so `pathTraversal` cannot be
 * driven to spawn a robot at an absurd / NaN position. */
export function coerceAutoPath(raw: unknown): AutoPathData | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.fileName !== 'string') return null;
  if (typeof d.startPoint !== 'object' || d.startPoint === null) return null;
  if (!Array.isArray(d.lines)) return null;
  try {
    const out: AutoPathData = {
      fileName: d.fileName.slice(0, 120),
      startPoint: coercePathPoint(d.startPoint as PathPoint),
      lines: (d.lines as PathLine[]).slice(0, PATH_MAX_LINES).map((line) => {
        const l: PathLine = { ...line };
        l.endPoint = coercePathPoint(line.endPoint);
        if (Array.isArray(line.controlPoints)) {
          // ⚠️ NEVER slice to 2. `renderer.ts` and `pathTraversal` both read LENGTH as the
          // curve order (1 ⇒ quadratic, 2 ⇒ cubic, 0 ⇒ straight), so truncating a long list
          // to 2 silently turns a linear segment into a cubic Bézier through junk points.
          // 8 is well past any real .pp file and is a runaway guard, not a reshape.
          l.controlPoints = line.controlPoints.slice(0, PATH_MAX_CONTROL_POINTS).map((c) => ({
            x: clampFinite(c.x, -C.FIELD_HALF, C.FIELD_HALF, 0),
            y: clampFinite(c.y, -C.FIELD_HALF, C.FIELD_HALF, 0),
          }));
        }
        // every wait reaches `robot.pathWaitTimer` — all THREE of them, or the cap is
        // incoherent (see the sequence `durationMs` below)
        for (const k of ['waitBeforeMs', 'waitAfterMs'] as const) {
          if (l[k] !== undefined) l[k] = clampFinite(l[k], 0, PATH_MAX_WAIT_MS, 0);
        }
        // unread anywhere outside the importer — do not carry them into the world, a
        // snapshot or a stored replay
        delete l.waitBeforeName;
        delete l.waitAfterName;
        return l;
      }),
      // `shapes` is DROPPED, not capped: nothing reads it — no renderer, no sim, no HUD.
      // It was carried from the .pp importer through the coercer, the mirror and every
      // snapshot for nothing. Deletion beats a bound.
      sequence: Array.isArray(d.sequence)
        ? (d.sequence as SequenceItem[]).slice(0, PATH_MAX_SEQUENCE).map((it) => {
            const item: SequenceItem = { ...it };
            if (item.durationMs !== undefined) {
              item.durationMs = clampFinite(item.durationMs, 0, PATH_MAX_WAIT_MS, 0);
            }
            return item;
          })
        : undefined,
      version: typeof d.version === 'string' ? d.version.slice(0, 40) : undefined,
      timestamp: typeof d.timestamp === 'string' ? d.timestamp.slice(0, 40) : undefined,
    };
    return out;
  } catch {
    return null;
  }
}

/** Coerce a whole RobotSetup from untrusted input into a spawn-safe one: legal
 * spec/assists, valid alliance, in-range startIndex, sanitized auto path. The
 * `id` is preserved (it keys the command map). This is the LAST line of defense —
 * `createWorld` runs it on every setup, so no spawn path can produce a bad robot
 * regardless of how the setup was assembled. */
/** structural + bounds coercion for a custom start pose (canonical goalSide=+1
 * frame). Returns null for anything non-finite. Field-clamps x/y and normalizes
 * the heading to [0,360). G304 LEGALITY (over a launch line, touching a surface,
 * own half) is NOT enforced here — that needs the alliance+spec and is applied by
 * `coerceSetup` via `snapStartToLegal`, the spawn chokepoint. */
export function coerceStartPose(raw: unknown): StartPose | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.headingDeg)) return null;
  let h = (p.headingDeg as number) % 360;
  if (h < 0) h += 360;
  return {
    x: clamp(p.x as number, -C.FIELD_HALF, C.FIELD_HALF),
    y: clamp(p.y as number, -C.FIELD_HALF, C.FIELD_HALF),
    headingDeg: h,
  };
}

export function coerceSetup(s: RobotSetup, game?: GameId): RobotSetup {
  // EVERY per-game answer this function needs comes off the module, not off `game ===`:
  // the anchor count, whether start legality exists, whether paths run at all. An
  // absent/unknown game resolves to DECODE, like every other module lookup.
  const mod = simModuleFor(game);
  // A PATH A GAME CANNOT RUN IS DROPPED HERE. Only DECODE's step drives path traversal
  // (`autoPaths`), so for the others this was state that survived localStorage, the wire,
  // the world and the replay while doing nothing — and an `autoPathActive` robot whose
  // game never advances the path is the one shape `pathTraversal` has no answer for.
  const autoPath = mod.autoPaths && s.autoPath !== undefined ? coerceAutoPath(s.autoPath) : null;
  const alliance = s.alliance === 'red' || s.alliance === 'blue' ? s.alliance : 'blue';
  // THE GAME IS PASSED ON, EXCEPT FOR DECODE — narrowed on purpose. `coerceSpec`'s per-game
  // arms (CR's mount fits, BIOBUZZ's own clamps) were being skipped at this chokepoint, which
  // is supposed to be the last line of defence, so CR and BIOBUZZ both pass `game` straight
  // through. An explicit `'decode'` is different: it also arms the mount-reset branch in
  // `coerceSpec`, which rewrites `intakeMount` to 'front'. `intakeMount` is PHYSICS —
  // `footprintExtents` grows the collider on the mounted edge and `worldHash` mixes robot
  // positions — so arming it for DECODE here would make every stored replay carrying a
  // non-front mount re-simulate as a different robot, i.e. a SIM_VERSION bump that retires
  // the whole archive. The stale-`intakeMount` leak that branch exists to close therefore
  // STAYS OPEN on this path for DECODE. It is a separate pre-existing bug and wants its own
  // fix at a deliberate version boundary — do NOT "complete" the threading for DECODE.
  const spec = coerceSpec(s.spec, DEFAULT_SPEC, game === 'decode' ? undefined : game);
  // a custom pose overrides the preset; snap it G304-legal for THIS spec+alliance
  // so no spawn path (localStorage, wire, staged match) can place an illegal robot.
  //
  // ONLY THROUGH THE GAME'S OWN SNAP (`startSnap`). `snapStartToLegal` is G304 geometry —
  // launch lines, goal faces, DECODE's alliance halves, an x-mirror between alliances — so
  // it is DECODE's slot and nobody else's. It used to be gated on `startLegality`, which
  // BIOBUZZ also sets, so a BIOBUZZ pose was seated against DECODE's field and mirrored the
  // wrong way (BIOBUZZ is point-symmetric). A game without the slot keeps the structurally
  // validated, field-clamped pose and supplies its own fit pass if it has one, as BIOBUZZ's
  // spawn does.
  let startPose: StartPose | undefined;
  const raw = coerceStartPose(s.startPose);
  if (raw) startPose = mod.startSnap ? mod.startSnap(spec, alliance, raw) : raw;
  return {
    id: s.id,
    alliance,
    spec,
    assists: coerceAssists(s.assists),
    // the anchor count is PER GAME (DECODE 5, CR 4) — see `coerceStartIndex`. An
    // absent/unknown game resolves to DECODE, like every other module lookup.
    startIndex: Number.isFinite(s.startIndex)
      ? clamp(Math.round(s.startIndex), 0, mod.startPoseCount - 1)
      : 0,
    startPose,
    autoPath: autoPath ?? undefined,
    autoPathEnabled: autoPath ? s.autoPathEnabled === true : false,
    // the same rule as `autoPath`: a game that cannot play one never carries one
    zenithAuto: mod.zenithAutos ? coerceZenithAuto(s.zenithAuto) : undefined,
    passive: s.passive,
  };
}

/** one robot slot in a match: only filled slots spawn robots */
export interface RobotSetup {
  id: number; // slot index, fixed for the whole match (command-map key)
  alliance: Alliance;
  spec: RobotSpec;
  assists: AssistConfig;
  /** index into START_POSES (mirrored per alliance) — the quick-pick fallback */
  startIndex: number;
  /** a fully-placed CUSTOM start pose (canonical goalSide=+1 frame). Overrides
   * startIndex when present; `coerceSetup` snaps it G304-legal at spawn. */
  startPose?: StartPose;
  // New fields for auto pathing
  autoPath?: AutoPathData;
  autoPathEnabled?: boolean;
  /** a ZENITH auto (`*.auto.json` text) this robot plays in AUTO, for a game with
   * `zenithAutos`. Bounded by `coerceZenithAuto`; played by an auto seat (`src/auto/`), never
   * read by a step. */
  zenithAuto?: ZenithAutoSetup;
  /** an inert obstacle (practice dummy): skips all per-tick action compute (see
   * `RobotState.passive`). */
  passive?: boolean;
}

/** the off-field human-player box holds ONLY the alliance-area preload set(s) no
 * present robot claimed (each present robot consumes one 3-ball set): 2 robots ->
 * 0 (empty), 1 -> 3 (PPG), 0 -> 6 (PGP+PPG). The 3 pre-staged loading-zone
 * artifacts are NOT in here — they sit on the field in the loading-zone corner. */
function hpBox(present: number): ArtifactColor[] {
  return [[...C.PRELOAD], [...C.HP_INITIAL_STOCK]].slice(present).flat();
}

function goalState(alliance: Alliance): GoalState {
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

// Helper function to mirror a PathPoint across the x=0 axis
function mirrorPathPoint(pathPoint: PathPoint): PathPoint {
  const mirrored: PathPoint = { ...pathPoint, x: -pathPoint.x };
  if (mirrored.degrees !== undefined) {
    // Mirror angle: new_angle = 180 - old_angle (in degrees)
    mirrored.degrees = wrapAngle((180 - mirrored.degrees) * Math.PI / 180) * 180 / Math.PI;
  }
  if (mirrored.startDeg !== undefined) {
    mirrored.startDeg = wrapAngle((180 - mirrored.startDeg) * Math.PI / 180) * 180 / Math.PI;
  }
  if (mirrored.endDeg !== undefined) {
    mirrored.endDeg = wrapAngle((180 - mirrored.endDeg) * Math.PI / 180) * 180 / Math.PI;
  }
  // The 'reverse' property should logically remain the same, as it indicates
  // whether to drive the segment in reverse, not a direction relative to the field.
  return mirrored;
}

// Helper function to mirror a ControlPoint across the x=0 axis
function mirrorControlPoint(controlPoint: ControlPoint): ControlPoint {
  return { ...controlPoint, x: -controlPoint.x };
}

// Helper function to deep copy and mirror AutoPathData
function mirrorAutoPathData(autoPath: AutoPathData): AutoPathData {
  const mirroredAutoPath: AutoPathData = JSON.parse(JSON.stringify(autoPath)); // Deep copy

  mirroredAutoPath.startPoint = mirrorPathPoint(mirroredAutoPath.startPoint);

  mirroredAutoPath.lines = mirroredAutoPath.lines.map((line) => {
    const mirroredLine = { ...line };
    mirroredLine.endPoint = mirrorPathPoint(mirroredLine.endPoint);
    if (mirroredLine.controlPoints) {
      mirroredLine.controlPoints = mirroredLine.controlPoints.map(mirrorControlPoint);
    }
    return mirroredLine;
  });

  // `shapes` is dropped by `coerceAutoPath` (nothing reads it), so there is nothing here to mirror.

  return mirroredAutoPath;
}


export function createWorld(mode: GameMode, seed: number, setups: RobotSetup[], gameSettings?: GameSettings): World {
  const rng = nextRandom(seed || 1);
  const motif = MOTIFS[Math.floor(rng.value * 3) % 3];

  const balls: Artifact[] = [];
  let id = 1;
  const addBall = (pos: { x: number; y: number }, color: ArtifactColor): void => {
    balls.push({
      id: id++,
      color,
      state: { kind: 'ground' },
      pos: { x: pos.x, y: pos.y },
      vel: { x: 0, y: 0 },
      z: 0,
      vz: 0,
    });
  };

  for (const a of ['red', 'blue'] as Alliance[]) {
    for (const s of spikeMarkBalls(a)) addBall(s.pos, s.color);
    // the 3 pre-staged loading-zone artifacts (manual setup), in the corner
    // against the alliance wall — on the field from the start; the human player
    // arranges them into the grab row once teleop begins.
    for (const s of loadPreStage(a)) addBall(s.pos, s.color);
  }

  // preloads come from the alliance area's 6 balls (4P+2G): the first robot
  // takes PRELOAD (PGP), the second takes HP_INITIAL_STOCK (PPG). Any set no
  // present robot claims seeds the human-player box instead (see hpBox).
  const robots: RobotState[] = [];
  const allianceCount: Record<Alliance, number> = { red: 0, blue: 0 };
  // FINAL sanitization pass: no matter how these setups were assembled (client
  // localStorage, wire message, DB-staged ranked match), force every robot to a
  // legal, spawn-safe config here. Deterministic + idempotent, so live play and
  // replay re-runs agree. See coerceSetup / coerceSpec above.
  for (const s of [...setups].map((st) => coerceSetup(st, 'decode')).sort((p, q) => p.id - q.id)) {
    const pose = startPose(s.alliance, s.startIndex, s.startPose, s.spec);
    const nth = allianceCount[s.alliance]++;

    let robotAutoPath = s.autoPath;
    if (s.alliance === 'red' && s.autoPathEnabled && s.autoPath) {
      robotAutoPath = mirrorAutoPathData(s.autoPath);
    }

    robots.push({
      id: s.id,
      alliance: s.alliance,
      spec: s.spec,
      pos: pose.pos,
      heading: pose.heading,
      vel: { x: 0, y: 0 },
      angVel: 0,
      turretHeading: pose.heading,
      moduleAngles: [0, 0, 0, 0], // swerve pods (FL,FR,BL,BR) start pointing forward
      moduleTargets: [0, 0, 0, 0], // and their commanded targets
      catalystRail: 0, // CR rail carriage (unused in DECODE)
      // BUTTERFLY starts on its MECANUM set — a robot that begins holonomic can always
      // drop traction, and it matches DRIVETRAIN_PRESETS.butterfly (the mecanum half).
      butterflyTank: false,
      driveModeHeld: false,
      twinBarrel: false,
      hopper: nth === 0 ? [...C.PRELOAD] : [...C.HP_INITIAL_STOCK],
      fieldCentric: s.assists.fieldCentric,
      aimAssist: s.assists.aimAssist,
      autoIntake: s.assists.autoIntake,
      autoFire: s.assists.autoFire,
      passive: s.passive,
      lastFireAt: -10,
      lastIntakeAt: -10,
      fireReadyAt: 0,
      // seed at the spawn-distance target so the first tick sees no phantom spin-up
      flywheelSpin: flywheelSpinTarget(s.alliance, pose.pos),
      flywheelSpinRate: 0,
      powerDraw: 0,
      // Initialize new auto pathing fields
      autoPathActive: !!(s.autoPathEnabled && robotAutoPath !== undefined),
      currentPathSegmentIndex: 0,
      pathSegmentProgress: 0,
      pathWaitTimer: 0,
      pathWaitedBefore: -1,
      pathSequenceIndex: 0,
      pathTargetPoint: null,
      pathTargetHeading: null,
      isAligningHeading: false, // Initialize new state
      targetAlignmentHeading: null, // Initialize new state
      autoPath: robotAutoPath, // Assign the (potentially mirrored) autoPath
    });

    // If auto path is enabled, override initial position and heading
    if (s.autoPathEnabled && robotAutoPath) {
      const robot = robots[robots.length - 1]; // Get the newly added robot
      robot.pos = { x: robotAutoPath.startPoint.x, y: robotAutoPath.startPoint.y };
      // Convert degrees to radians for initial heading
      if (robotAutoPath.startPoint.heading === 'constant' && robotAutoPath.startPoint.degrees !== undefined) {
        robot.heading = robotAutoPath.startPoint.degrees * Math.PI / 180;
        robot.turretHeading = robot.heading;
      } else if (robotAutoPath.startPoint.heading === 'linear' && robotAutoPath.startPoint.startDeg !== undefined) {
        robot.heading = robotAutoPath.startPoint.startDeg * Math.PI / 180;
        robot.turretHeading = robot.heading;
      }
      // For tangential, initial heading will be determined by the first path segment.
      // The path follower will handle this dynamically.
    }

    // preloaded artifacts are PHYSICAL held balls (the hopper mirrors their colors);
    // step()'s positionHeldBalls parks them at the storage slots
    const created = robots[robots.length - 1];
    created.hopper.forEach((color, slot) => {
      const side = slot >= 1 ? (slot === 1 ? -1 : 1) : 0; // triangle front row: opposite sides
      const lp = heldSlotPos(created.spec, slot, side);
      const wp = rot(lp, created.heading);
      balls.push({
        id: id++,
        color,
        state: { kind: 'held', robot: created.id, slot, lx: lp.x, ly: lp.y, side },
        pos: { x: created.pos.x + wp.x, y: created.pos.y + wp.y },
        vel: { x: 0, y: 0 },
        z: 0,
        vz: 0,
      });
    });
  }

  return {
    mode,
    time: 0,
    tick: 0,
    rngState: rng.state,
    motif,
    robots,
    balls,
    goals: { red: goalState('red'), blue: goalState('blue') },
    humanPlayers: {
      red: { box: hpBox(allianceCount.red), nextPlaceAt: 0 },
      blue: { box: hpBox(allianceCount.blue), nextPlaceAt: 0 },
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
    pinnedArtifacts: [],
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
    gameSettings: gameSettings, // Pass gameSettings to the world
  };
}