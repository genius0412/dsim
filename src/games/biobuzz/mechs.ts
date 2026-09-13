import type { Alliance, RobotSpec } from '../../types';
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
 *  1. **"This robot has TWO mechanisms."** A launcher AND a Box Tube is a coherent, buildable
 *     robot: the launcher scores the HIVE and the tube places into a FLOWER (nothing launched
 *     ever enters a FLOWER).
 *  2. **"This launcher has two turrets."** A double turret's NECTAR turret needs its own cell.
 *
 * (A launcher-less build was a case once. The owner ruled on 2026-09-12 that a launcher is
 * MANDATORY, so a stored `launcher: null` is no longer a loadout: it migrates from the flat
 * `scoreMode`/`shooterMount` mirror exactly like an absent container.)
 *
 * ── WHY ONE CONTAINER FIELD AND NOT TWO ─────────────────────────────────────
 * `RobotSpec.bbMech?: { launcher: …; lift: … | null }`, not `bbLauncher?` + `bbLift?`.
 * `bbMech === undefined` means "a spec written before this existed — migrate it from
 * `scoreMode`". It is also ONE carry-across line in
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
 * LIFT archetypes. One today — the BOX TUBE (internal kind `vslide`, kept so every stored spec
 * still resolves), the mechanism that PLACES an element into a FLOWER rather than launching it.
 * It has no height dial and no raise travel: placement is a proximity action at
 * `bbPlacePointLocal` (`robot.ts`). An enum rather than a `hasLift` boolean so a second kind is
 * an added union member instead of a second `RobotSpec` field.
 */
export const BB_LIFT_KINDS = ['vslide'] as const;
export type BbLiftKind = (typeof BB_LIFT_KINDS)[number];

/** THE LAUNCHER SLOT. MANDATORY (owner ruling 2026-09-12): every BIOBUZZ build carries one. */
export interface BbLauncherSpec {
  kind: BbScoreMode;
  /** where it is bolted. A TURRET may sit at any of the nine positions (it aims itself, so the
   * mount is an origin, not a facing); a TURRETLESS launcher (the dumper) fires along a LINE
   * spanning a chassis side, so the coercer folds it to one of the four edges. For a DOUBLE
   * turret this is the POLLEN turret. */
  mount: BbMountPos;
  /** the NECTAR turret of a DOUBLE turret (`twinturret`) — the second, individual turret. Only
   * ever present for that kind: the coercer defaults it to the first cell ≠ `mount` (in
   * `BB_MOUNT_POSITIONS` order) and deletes it for every other kind. */
  mount2?: BbMountPos;
  /** the HOOD angle in DEGREES above level that a TURRETLESS launcher throws at. A fixed hood
   * is real hardware. A TURRETED launcher ignores it and solves its own elevation per shot. */
  hoodDeg: number;
}

/** THE LIFT SLOT — the Box Tube. No height: it places at a point, it does not raise. */
export interface BbLiftSpec {
  kind: BbLiftKind;
  /** where the tube is bolted — one of the EIGHT perimeter cells of the nine-cell map (never
   * `center`: the placement point has to sit past a chassis edge to reach a FLOWER). */
  mount: BbMountPos;
}

/** BOTH SLOTS, as they sit on the spec. The launcher is mandatory; the lift may be `null`. */
export interface BbMechSpec {
  launcher: BbLauncherSpec;
  lift: BbLiftSpec | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// RESOLUTION — reading a spec that may predate any of this
// ─────────────────────────────────────────────────────────────────────────────

/**
 * LEGACY ARCHETYPE NAMES → today's vocabulary, applied BEFORE the enum check at every fallback
 * site (the flat `scoreMode` legacy path and the container). `drum` was removed (owner ruling
 * 2026-09-12) and becomes a `dumper`, keeping its edge and hood — without this map it would fail
 * the enum check and fall back to a turret, relocating the player's launcher.
 */
export const BB_LEGACY_SCORE_MODES: Readonly<Record<string, BbScoreMode>> = { drum: 'dumper' };

/** fold any stored archetype name onto today's vocabulary: the legacy map first, then the enum
 * check; anything still unknown is a turret. */
export function bbFoldScoreMode(kind: unknown): BbScoreMode {
  const k = typeof kind === 'string' ? (BB_LEGACY_SCORE_MODES[kind] ?? kind) : kind;
  return (BB_SCORE_MODES as readonly string[]).includes(k as string)
    ? (k as BbScoreMode)
    : BB_SCORE_MODES[0]; // 'turret' — the same default `config.ts` names
}

/**
 * The LAUNCHER this spec actually has. NEVER null — a launcher is mandatory.
 *
 * MIGRATION: a spec with no `bbMech`, OR one whose stored `launcher` is `null` (an old
 * launcher-less save, or a peer that wrote one), migrates to a launcher built from the flat
 * `scoreMode` + `shooterMount` mirror — which `src/sim/spawn.ts` always writes, so there is
 * always something to migrate from. A legacy `drum` (flat or in the container) reads as a
 * `dumper`.
 *
 * PURE, and safe on a RAW un-coerced spec — `footprintExtents` and the builder both call it.
 * A valid container launcher is returned BY REFERENCE; only a folded one is copied.
 */
export function bbLauncherOf(spec: RobotSpec, defaultHoodDeg: number): BbLauncherSpec {
  const l = spec.bbMech?.launcher;
  if (l) {
    const kind = bbFoldScoreMode(l.kind);
    return kind === l.kind ? l : { ...l, kind };
  }
  return { kind: bbFoldScoreMode(spec.scoreMode), mount: bbShooterMountOf(spec), hoodDeg: defaultHoodDeg };
}

/** The LIFT this spec has, or `null`. No legacy path: an absent container means no lift. */
export function bbLiftOf(spec: RobotSpec): BbLiftSpec | null {
  return spec.bbMech?.lift ?? null;
}

/** does this launcher aim itself (single or double turret)? */
export function bbIsTurreted(launcher: BbLauncherSpec): boolean {
  return isTurreted(launcher.kind);
}

/**
 * Can this launcher's robot carry NECTAR at all? A SINGLE turret feeds POLLEN only; a DOUBLE
 * turret has a dedicated NECTAR turret, and a DUMPER heaves whatever is in its hopper. The
 * intake (`capturePollen`, `elements.ts`) refuses a NECTAR for a build this says no to.
 */
export function bbCarriesNectar(launcher: BbLauncherSpec): boolean {
  return launcher.kind === 'twinturret' || launcher.kind === 'dumper';
}

/**
 * WILL THIS BUILD'S INTAKE TAKE AN ELEMENT OF `color`? — the one predicate `capturePollen` asks.
 *
 * POLLEN (yellow): always. NECTAR (`red`/`blue`): only this robot's OWN alliance's (G408, for
 * every build), and only when its launcher can carry NECTAR at all (`bbCarriesNectar`). PURE
 * over the spec, so the builder and a smoke check can ask it without a world.
 */
export function bbIntakeAccepts(spec: RobotSpec, alliance: Alliance, color: string): boolean {
  if (color !== 'red' && color !== 'blue') return true;
  // the hood default is irrelevant to `kind`, which is all this reads
  return color === alliance && bbCarriesNectar(bbLauncherOf(spec, 0));
}

/** which turret an element leaves from: a DOUBLE turret sends NECTAR out of turret 1 and POLLEN
 * out of turret 0; every other build has one exit (0). */
export function bbTurretFor(launcher: BbLauncherSpec, nectar: boolean): 0 | 1 {
  return launcher.kind === 'twinturret' && nectar ? 1 : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLASH — above-deck mechanisms, one chassis
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Does a mechanism at `pos` span its whole edge?
 *
 * A TURRETLESS launcher does: it fires along a line across the chassis side, so it occupies
 * that edge and both of its corners. A TURRET and a BOX TUBE are both single-cell towers.
 */
export function bbSpansEdge(kind: BbScoreMode | BbLiftKind): boolean {
  return kind !== 'vslide' && !isTurreted(kind as BbScoreMode);
}

/**
 * THE DOUBLE TURRET'S FIXED PARTNER CELLS — front↔back, left↔right, each corner↔its opposite
 * corner. Where a missing or illegal NECTAR-turret cell goes.
 *
 * ── WHY TWO TURRETS MAY NOT BE NEIGHBOURS ───────────────────────────────────
 * A turret ring's radius is `min(3.8, 0.24·min(L, W))` and an edge/corner turret is pulled
 * inboard by it (`turretLocal`), so two rings in NEIGHBOURING 3x3 cells overlap on every legal
 * chassis. The rule is therefore chassis-INDEPENDENT — cells at grid distance 2 only — which is
 * what keeps the coercer idempotent (a size change can never re-home a turret). `center`
 * neighbours every cell, so a double turret cannot use it at all (`bbFoldTwinMount`).
 */
export const BB_TWIN_PARTNER: Readonly<Record<BbMountPos, BbMountPos>> = {
  front: 'back',
  back: 'front',
  left: 'right',
  right: 'left',
  frontleft: 'backright',
  backright: 'frontleft',
  frontright: 'backleft',
  backleft: 'frontright',
  center: 'back', // unreachable: `bbFoldTwinMount` never leaves a double turret on `center`
};

/** a double turret's POLLEN-turret cell: `center` (which neighbours everything) folds to `front`. */
export function bbFoldTwinMount(mount: BbMountPos): BbMountPos {
  return mount === 'center' ? 'front' : mount;
}

/** are two cells of the 3x3 chassis map the same cell or NEIGHBOURS (8-connected)? */
export function bbCellsAdjacent(a: BbMountPos, b: BbMountPos): boolean {
  const ia = BB_MOUNT_POSITIONS.indexOf(a);
  const ib = BB_MOUNT_POSITIONS.indexOf(b);
  return Math.abs(Math.floor(ia / 3) - Math.floor(ib / 3)) <= 1 && Math.abs((ia % 3) - (ib % 3)) <= 1;
}

/**
 * The NECTAR turret's cell for a DOUBLE turret whose POLLEN turret is at `mount` (already folded
 * off `center`).
 *
 * The requested cell when it is a real position that is not `mount` and not one of its
 * neighbours; otherwise `mount`'s fixed partner (`BB_TWIN_PARTNER`). A pure function of
 * (mount, want) whose output re-resolves to itself — which keeps the coercer idempotent.
 */
export function bbResolveMount2(mount: BbMountPos, want: unknown): BbMountPos {
  if ((BB_MOUNT_POSITIONS as readonly string[]).includes(want as string) && !bbCellsAdjacent(mount, want as BbMountPos)) {
    return want as BbMountPos;
  }
  return BB_TWIN_PARTNER[mount];
}

/** the eight PERIMETER cells a Box Tube may use — the nine-cell map without `center`. Used for
 * validation AND as the resolver's fallback order. */
export const BB_LIFT_POSITIONS: readonly BbMountPos[] = BB_MOUNT_POSITIONS.filter((p) => p !== 'center');

/**
 * Find the BOX TUBE cell a mount can legally use, given where the launcher already is.
 *
 * ── WHY THE LAUNCHER WINS ───────────────────────────────────────────────────
 * Somebody has to, or the resolution is not a function and `coerceSpec` stops being
 * idempotent. The launcher is resolved FIRST and the tube folds around it: the launcher is
 * mandatory and has the harder constraint (a dumper needs a whole edge).
 *
 * NEVER `center`: a placement point has to sit past a chassis edge. A `center` request (or any
 * clashing one) folds to the first free PERIMETER cell in `BB_MOUNT_POSITIONS` order; `null`
 * means no perimeter cell is free, which the caller reads as "this build cannot carry a tube".
 */
export function bbResolveLiftMount(
  want: BbMountPos,
  blockers: readonly { pos: BbMountPos; spansEdge: boolean }[],
): BbMountPos | null {
  const free = (pos: BbMountPos): boolean =>
    BB_LIFT_POSITIONS.includes(pos) && !blockers.some((b) => mountsClash({ pos, spansEdge: false }, b));
  if (free(want)) return want;
  return BB_LIFT_POSITIONS.find(free) ?? null;
}

/** the cells a resolved launcher occupies, as blocker entries — BOTH turrets of a double. */
export function bbLauncherBlocker(launcher: BbLauncherSpec): { pos: BbMountPos; spansEdge: boolean }[] {
  const out = [{ pos: launcher.mount, spansEdge: bbSpansEdge(launcher.kind) }];
  if (launcher.kind === 'twinturret' && launcher.mount2) out.push({ pos: launcher.mount2, spansEdge: false });
  return out;
}

/** re-exported so a caller that has a mount and a span does not have to reach into `mounts.ts`
 * as well as this file for one composition. */
export { occupiedCells, isEdgePos };
