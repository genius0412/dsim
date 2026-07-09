import type { GameSettings, StartCat, StartPose, StartSel } from '../types';
import { START_POSES, MAX_SAVED_STARTS } from '../config';

/**
 * Pure helpers for the Close/Far start-position model shared by the editor and
 * its host screens. The ACTIVE start (`startIndex`/`startPose`) is what spawns /
 * travels on the wire; `startCat` picks the category, `savedStartPoses` is the
 * per-category library (≤ MAX_SAVED_STARTS each), and `startMemory` remembers the
 * last selection in each category so switching tabs restores it.
 */

export interface CatPreset {
  index: number;
  pose: StartPose;
  label: string;
}

/** the built-in presets belonging to a category, with their START_POSES index */
export function categoryPresets(cat: StartCat): CatPreset[] {
  const out: CatPreset[] = [];
  START_POSES.forEach((p, index) => {
    if (p.cat === cat) out.push({ index, pose: { x: p.x, y: p.y, headingDeg: p.headingDeg }, label: p.label });
  });
  return out;
}

/** the fallback preset index for a category (its first preset) */
export function categoryDefaultIndex(cat: StartCat): number {
  return categoryPresets(cat)[0]?.index ?? 0;
}

/** the category a preset index belongs to */
export function indexCategory(index: number): StartCat {
  return START_POSES[index]?.cat ?? 'close';
}

/** the ACTIVE start fields (startIndex/startPose) for a remembered selection */
function activeFromSel(cat: StartCat, sel: StartSel): { startIndex: number; startPose: StartPose | null } {
  const index = sel.index >= 0 ? sel.index : categoryDefaultIndex(cat);
  return { startIndex: index, startPose: sel.pose };
}

/** patch: switch the active category, restoring that category's remembered pick */
export function switchCategory(s: GameSettings, cat: StartCat): Partial<GameSettings> {
  return { startCat: cat, ...activeFromSel(cat, s.startMemory[cat]) };
}

/** patch: set the active start to `sel` within the CURRENT category + remember it */
export function selectStart(s: GameSettings, sel: StartSel): Partial<GameSettings> {
  const cat = s.startCat;
  return { ...activeFromSel(cat, sel), startMemory: { ...s.startMemory, [cat]: sel } };
}

/** patch: save a custom pose into the current category's library (cap, drop oldest) */
export function saveStart(s: GameSettings, pose: StartPose): Partial<GameSettings> {
  const cat = s.startCat;
  const list = [...s.savedStartPoses[cat], pose].slice(-MAX_SAVED_STARTS);
  return { savedStartPoses: { ...s.savedStartPoses, [cat]: list } };
}

/** patch: delete a saved pose from a category */
export function deleteSavedStart(s: GameSettings, cat: StartCat, i: number): Partial<GameSettings> {
  return {
    savedStartPoses: { ...s.savedStartPoses, [cat]: s.savedStartPoses[cat].filter((_, k) => k !== i) },
  };
}

/** are two poses effectively the same spot? (for highlighting the active pick) */
export function samePose(a: StartPose | null | undefined, b: StartPose | null | undefined): boolean {
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) < 0.05 && Math.abs(a.y - b.y) < 0.05 && Math.abs(a.headingDeg - b.headingDeg) < 0.5;
}
