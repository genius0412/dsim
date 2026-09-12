import type { RobotSpec } from '../../types';
import {
  BB_MOUNT_POSITIONS,
  BB_SCORE_MODES,
  type BbMountPos,
  type BbScoreMode,
  bbShooterMountOf,
  isEdgePos,
  isTurreted,
  mountsClash,
  occupiedCells,
} from './mounts';

/**
 * BIOBUZZ MECHANISM COMPOSITION — the vocabulary, and the rule for who gets which cell.
 *
 * ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
 * A BIOBUZZ robot used to have exactly ONE mechanism, spelled through two SHARED fields
 * (`scoreMode` + `shooterMount`) that Chain Reaction owns the names of. That shape cannot say
 * two true things about this game's real robots:
 *
 *  1. **"This robot has no launcher."** Studica's published StarterBot is a drivetrain and an
 *     intake — no shooter at all (`presets.ts`). An ABSENT `scoreMode` cannot mean that,
 *     because `src/sim/spawn.ts` WRITES `out.scoreMode` unconditionally on every pass and
 *     defaults it to a turret. So a launcher-less build spelled that way grows a phantom
 *     turret on the very next coercion — which is why the launcher needs a home that can hold
 *     a genuine `null`, and why that home has to be distinguishable from "field absent".
 *  2. **"This robot has TWO mechanisms."** A turreted launcher AND a vertical slide is a
 *     coherent, buildable robot: the two scoring targets sit at different heights and one
 *     mechanism cannot reach both (see `BB_R105_HEIGHT_CAP` below).
 *
 * ── WHY ONE CONTAINER FIELD AND NOT TWO ─────────────────────────────────────
 * `RobotSpec.bbMech?: { launcher: … | null; lift: … | null }`, not `bbLauncher?` + `bbLift?`.
 * The container is what makes ABSENCE legible: `bbMech === undefined` means "a spec written
 * before this existed — migrate it from `scoreMode`", while `bbMech.launcher === null` means
 * "this robot genuinely has no launcher". Two optional sibling fields cannot tell those apart,
 * and getting it wrong is the phantom turret above. It is also ONE carry-across line in
 * `src/sim/spawn.ts`, ONE key in smoke's `specKey`, and ONE blob on the wire.
 *
 * ── THIS FILE IS A LEAF ─────────────────────────────────────────────────────
 * It imports `../../types` and `./mounts` and nothing else, exactly like `mounts.ts` — because
 * `coerce.ts` needs it, and `coerce.ts` is a dependency of `src/sim/spawn.ts`'s `coerceSpec`.
 * An import here that reaches the spawn chokepoint is a module-eval cycle. TUNABLE NUMBERS
 * therefore live in `config.ts` (the repo's convention) and reach this file as arguments; what
 * lives HERE is the vocabulary, the defaults and the resolution rules — the same split
 * `mounts.ts` already makes by holding `BB_DEFAULT_INTAKE_MOUNT` but no geometry.
 */

// ─────────────────────────────────────────────────────────────────────────────
// THE VOCABULARY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * LIFT archetypes. One today — a vertical extension slide, the mechanism that PLACES an
 * element into a FLOWER rather than launching it. An enum rather than a `hasLift` boolean so
 * a second kind (a pivoting arm, a telescoping boom) is an added union member instead of a
 * second `RobotSpec` field.
 */
export const BB_LIFT_KINDS = ['vslide'] as const;
export type BbLiftKind = (typeof BB_LIFT_KINDS)[number];

/** THE LAUNCHER SLOT. `kind` keeps the four existing archetype names deliberately — see the
 * note on `bbLauncherOf` for why that is what preserves 26 gallery scenes. */
export interface BbLauncherSpec {
  kind: BbScoreMode;
  /** where it is bolted. A TURRET may sit at any of the nine positions (it aims itself, so the
   * mount is an origin, not a facing); a TURRETLESS launcher fires along a LINE spanning a
   * chassis side, so the coercer folds it to one of the four edges. */
  mount: BbMountPos;
  /** the HOOD angle in DEGREES above level that a TURRETLESS launcher throws at. A fixed hood
   * is real hardware — AndyMark's StarterBot manual calls it out explicitly ("Hood End: moving
   * the last standoff affects the release angle"). A TURRETED launcher ignores it and solves
   * its own elevation per shot, which is the whole point of putting a pitch axis on a turret. */
  hoodDeg: number;
}

/** THE LIFT SLOT — a vertical extension slide. */
export interface BbLiftSpec {
  kind: BbLiftKind;
  /** where the mast is bolted. The SAME nine-cell map the launcher uses, because a mast and a
   * turret both sit ABOVE the deck and can therefore want the same piece of frame. */
  mount: BbMountPos;
  /** how high the carriage reaches above the tiles, in inches. A build choice (a Builder
   * slider), clamped against `BB_R105_HEIGHT_CAP`. */
  maxZ: number;
}

/** BOTH SLOTS, as they sit on the spec. Either may be `null` — that is the point. */
export interface BbMechSpec {
  launcher: BbLauncherSpec | null;
  lift: BbLiftSpec | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// RESOLUTION — reading a spec that may predate any of this
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The LAUNCHER this spec actually has, or `null` for a build with none.
 *
 * MIGRATION IS THE INTERESTING CASE. A spec with no `bbMech` is one written before the slots
 * existed — every saved robot, every stored replay, every peer running an older client — and
 * every one of those DID have a launcher, because `scoreMode` was mandatory. So absence
 * migrates to a launcher built from `scoreMode` + `shooterMount`, and only an explicit
 * `bbMech.launcher === null` reads as "no launcher".
 *
 * ⚠️ THE FOUR ARCHETYPE NAMES SURVIVE UNTOUCHED, and that is a deliberate constraint rather
 * than inertia: the gallery's 26 `archetype-<mode>-<mount>` scene ids are keyed on
 * `BB_SCORE_MODES`, so renaming or replacing the vocabulary re-shoots every one of them under
 * the contract's §7 visual-proof rule. Three of the four StarterBots want a FIFTH kind (a
 * chassis-fixed SEQUENTIAL launcher — `presets.ts` says so at each entry), and `BbLauncherSpec`
 * is shaped so that is an added member plus a per-kind cadence rule, not a schema change.
 *
 * PURE, and safe on a RAW un-coerced spec — `footprintExtents` and the builder both call it.
 */
export function bbLauncherOf(spec: RobotSpec, defaultHoodDeg: number): BbLauncherSpec | null {
  const m = spec.bbMech;
  if (m) {
    if (!m.launcher) return null;
    return m.launcher;
  }
  // LEGACY: no container ⇒ the spec predates the slots and therefore has a launcher.
  const kind = ((BB_SCORE_MODES as readonly string[]).includes(spec.scoreMode as string)
    ? spec.scoreMode
    : BB_SCORE_MODES[0]) as BbScoreMode;  // 'turret' — the same default `config.ts` names
  return { kind, mount: bbShooterMountOf(spec), hoodDeg: defaultHoodDeg };
}

/** The LIFT this spec has, or `null`. No legacy path: nothing in this repo has ever modelled a
 * lift, so an absent container simply means no lift — there is nothing to migrate from. */
export function bbLiftOf(spec: RobotSpec): BbLiftSpec | null {
  return spec.bbMech?.lift ?? null;
}

/** does this build carry a launcher that aims itself? `false` for a launcher-less build, which
 * is why this exists rather than calling `isTurreted` on a possibly-absent kind. */
export function bbIsTurreted(launcher: BbLauncherSpec | null): boolean {
  return launcher !== null && isTurreted(launcher.kind);
}

// ─────────────────────────────────────────────────────────────────────────────
// CLASH — two above-deck mechanisms, one chassis
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Does a mechanism at `pos` span its whole edge?
 *
 * A TURRETLESS launcher does: it fires along a line across the chassis side, so it occupies
 * that edge and both of its corners. A TURRET and a LIFT are both single-cell towers.
 */
export function bbSpansEdge(kind: BbScoreMode | BbLiftKind): boolean {
  return kind !== 'vslide' && !isTurreted(kind as BbScoreMode);
}

/**
 * Find the LIFT a mount can legally use, given where the launcher already is.
 *
 * ── WHY THE LAUNCHER WINS ───────────────────────────────────────────────────
 * Somebody has to, or the resolution is not a function and `coerceSpec` stops being
 * idempotent — re-running it would swap which mechanism moved. The launcher is resolved FIRST
 * and the lift folds around it, for two reasons that outlive this pair: the launcher has the
 * harder constraint (a turretless one needs a whole edge, a lift never does), and it is the
 * mechanism a legacy spec already had, so a migrated build never sees its existing hardware
 * relocated by a lift it just gained.
 *
 * Returns the requested mount when it is free, otherwise the first free cell in
 * `BB_MOUNT_POSITIONS` order, otherwise `null` — which the caller reads as "this build cannot
 * carry a lift", NOT as an error. A chassis whose launcher spans an edge and whose remaining
 * cells are all taken is a real, if unusual, build.
 *
 * ⚠️ A THIRD above-deck mechanism turns this into an accumulating blocker list with an
 * ordering POLICY (which mechanism wins a contested cell), and that policy is a felt product
 * decision nobody should invent before a third mechanism exists. `blockers` is already a list
 * so the plumbing generalises; the ordering is what does not.
 */
export function bbResolveLiftMount(
  want: BbMountPos,
  blockers: readonly { pos: BbMountPos; spansEdge: boolean }[],
): BbMountPos | null {
  const free = (pos: BbMountPos): boolean =>
    !blockers.some((b) => mountsClash({ pos, spansEdge: false }, b));
  if (free(want)) return want;
  return BB_MOUNT_POSITIONS.find(free) ?? null;
}

/** the cells a resolved launcher occupies, as a blocker entry. `null` blocks nothing. */
export function bbLauncherBlocker(
  launcher: BbLauncherSpec | null,
): { pos: BbMountPos; spansEdge: boolean }[] {
  if (!launcher) return [];
  return [{ pos: launcher.mount, spansEdge: bbSpansEdge(launcher.kind) }];
}

/** re-exported so a caller that has a mount and a span does not have to reach into `mounts.ts`
 * as well as this file for one composition. */
export { occupiedCells, isEdgePos };
