import type { Alliance, GameId, GameSettings, RobotSpec, StartCat, StartPose, StartSel } from '../types';
import { MAX_SAVED_STARTS, MAX_SAVED_STARTS_SUPPORTER } from '../config';
import { simModuleFor } from '../games/sim';
import { footprintExtents } from '../sim/field';
import { categoryDefaultIndex } from '../net/startRoles';

// the role model and the category helpers live in `src/net/startRoles.ts`, where the server can
// read them too (it answers the swap for a bot seat); every screen keeps importing them from here
export { otherCat, allianceDuo, derivedRole, categoryPresets, categoryDefaultIndex, indexCategory } from '../net/startRoles';
export type { CatPreset } from '../net/startRoles';

/**
 * Pure helpers for the Close/Far start-position model shared by the editor and
 * its host screens. The ACTIVE start (`startIndex`/`startPose`) is what spawns /
 * travels on the wire; `startCat` picks the category, `savedStartPoses` is the
 * per-category library (≤ MAX_SAVED_STARTS each), and `startMemory` remembers the
 * last selection in each category so switching tabs restores it.
 */

/** the ACTIVE start fields (startIndex/startPose) for a remembered selection */
function activeFromSel(cat: StartCat, sel: StartSel, game?: GameId): { startIndex: number; startPose: StartPose | null } {
  const index = sel.index >= 0 ? sel.index : categoryDefaultIndex(cat, game);
  return { startIndex: index, startPose: sel.pose };
}

/** patch: switch the active category, restoring that category's remembered pick */
export function switchCategory(s: GameSettings, cat: StartCat): Partial<GameSettings> {
  return { startCat: cat, ...activeFromSel(cat, s.startMemory[cat], s.game) };
}

/** patch: set the active start to `sel` within the CURRENT category + remember it */
export function selectStart(s: GameSettings, sel: StartSel): Partial<GameSettings> {
  const cat = s.startCat;
  return { ...activeFromSel(cat, sel, s.game), startMemory: { ...s.startMemory, [cat]: sel } };
}

/**
 * patch: save a custom pose into the current category's library.
 *
 * The slice is a RUNAWAY GUARD, not the entitlement gate — hence the supporter
 * ceiling rather than the free one. `StartPositionEditor` is the single place
 * that decides whether the "＋ Save" button appears at all (via `savedStartCap`),
 * and if this also enforced the free cap it would silently truncate a supporter's
 * six poses down to two on their very next save. Same reasoning as
 * `coerceSettings`: the persisted ceiling is always the high one.
 */
export function saveStart(s: GameSettings, pose: StartPose): Partial<GameSettings> {
  const cat = s.startCat;
  const list = [...s.savedStartPoses[cat], pose].slice(-MAX_SAVED_STARTS_SUPPORTER);
  return { savedStartPoses: { ...s.savedStartPoses, [cat]: list } };
}

/** how many saved starts per category this player gets — the ONE place the perk
 *  is decided. */
export function savedStartCap(supporter: boolean): number {
  return supporter ? MAX_SAVED_STARTS_SUPPORTER : MAX_SAVED_STARTS;
}

/** patch: delete a saved pose from a category */
export function deleteSavedStart(s: GameSettings, cat: StartCat, i: number): Partial<GameSettings> {
  return {
    savedStartPoses: { ...s.savedStartPoses, [cat]: s.savedStartPoses[cat].filter((_, k) => k !== i) },
  };
}

/**
 * How far ahead of the robot's origin the start editors put their HEADING HANDLE: 8 in past the
 * robot's front, so a grab of the handle is never a grab of the robot. An IMPORT's front is its
 * hull's (`footprintExtents`), which is not `length / 2`: the origin is the wheelbase centre, and
 * DECODE caps an import's parametric `length` at 15 (sloped intake) while its hull runs to 18, so
 * `length / 2 + 8` put the handle on or inside a long nose. A standard robot's handle is where it
 * always was.
 */
export function startHandleReach(spec: RobotSpec): number {
  return (spec.imported ? footprintExtents(spec).front : spec.length / 2) + 8;
}

/** are two poses effectively the same spot? (for highlighting the active pick) */
export function samePose(a: StartPose | null | undefined, b: StartPose | null | undefined): boolean {
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) < 0.05 && Math.abs(a.y - b.y) < 0.05 && Math.abs(a.headingDeg - b.headingDeg) < 0.5;
}

/**
 * Is the ACTIVE start selection legal, for EITHER game? A null pose means "use the
 * named anchor", which both games resolve legal for any chassis. A custom pose is
 * checked against that game's own rule — DECODE's G304 setup constraints, CR's G04
 * Lab-Area containment (plus the solid Ring-Stand assembly). Both take the pose in
 * the CANONICAL frame and are alliance-symmetric.
 *
 * Callers use this to REFUSE ready-up / game-start rather than let the spawn quietly
 * relocate a robot: CR gained free placement with `ChainStartEditor`, so "chain is
 * always legal" (true when it only offered anchors) no longer holds.
 */
export function startSelectionLegal(
  game: GameId | undefined,
  spec: RobotSpec,
  alliance: Alliance,
  startPose: StartPose | null | undefined,
): boolean {
  if (!startPose) return true;
  // THE MODULE ANSWERS, because this used to be `game === 'chain' ? … : …` and a two-valued
  // branch over a five-valued registry is the seam bug CLAUDE.md names: BIOBUZZ fell into
  // DECODE's arm and had its poses measured against DECODE's launch lines. A game with no
  // start rule fills nothing and every pose is legal — which is what the old DECODE arm could
  // not express. `src/games/sim.ts` is the SERVER-SAFE registry, so this stays DOM-free.
  const legal = simModuleFor(game).startLegal;
  return legal ? legal(spec, alliance, startPose) : true;
}
