/**
 * A loaded model → a PREPARED one: welded, creased, and either under the triangle budget or, at FULL
 * detail, whole with a simplified copy to measure. three-free, so the import worker runs it;
 * `importerEngine.ts` re-exports it for the main-thread path.
 */
import { isFullDetail, MEASURE_TRI_BUDGET, triangleCount, type MeshPart } from '../geometry';
import { creaseParts } from './meshOps';
import type { LoadedModel } from './parse';
import { simplifyParts } from './simplify';

export interface PreparedModel extends LoadedModel {
  /**
   * what is MEASURED (the footprint, the wheels, the part finders, picking), welded and creased,
   * still the SOURCE frame. Without `full` it is also what is previewed and stored.
   */
  parts: MeshPart[];
  /**
   * FULL detail: every triangle the reader made, welded and creased, in the same frame with the same
   * body ids; `parts` is then a simplification of it that keeps every body. Absent when the budget
   * simplified the model, and when the whole model fits `MEASURE_TRI_BUDGET` (`parts` is all of it).
   */
  full?: MeshPart[];
  /** the triangles the stored mesh will have: `full`'s, else `parts`' */
  trisOut: number;
  /** read at FULL detail (nothing simplified away, whether or not `full` is set) */
  fullDetail?: boolean;
  /** meshopt's largest relative error (of `parts`) */
  simplifyError: number;
}

/** `triBudget` as the simplifier takes it: Full is every triangle (`Infinity`), any other at least 1000 */
export function clampBudget(triBudget: number): number {
  return isFullDetail(triBudget) ? Infinity : Math.max(1000, Math.floor(triBudget));
}

/** the parts a model is previewed, baked and stored from: every triangle when it was kept in full */
export function shownParts(model: Pick<PreparedModel, 'parts' | 'full'>): MeshPart[] {
  return model.full ?? model.parts;
}

/**
 * Simplify once per file, in the source frame (simplification is invariant under the rotation
 * and uniform scale normalisation applies), then crease the normals. At FULL detail
 * (`isFullDetail`) nothing the reader made is dropped: the whole model is kept (`full`) and the
 * copy the editor measures is simplified to `MEASURE_TRI_BUDGET` without losing a body.
 */
export async function simplifyModel(
  model: LoadedModel,
  triBudget: number,
  onProgress?: (frac: number) => void,
  opts: { consume?: boolean } = {},
): Promise<PreparedModel> {
  // `consume`: the loaded parts are the caller's to give up (the import worker's, the main-thread
  // fallback's); they are taken out of `model` and released one by one as they are welded
  const parts = opts.consume ? model.parts.splice(0) : model.parts;
  if (isFullDetail(triBudget)) {
    const s = await simplifyParts(parts, MEASURE_TRI_BUDGET, onProgress, { ...opts, keepFull: true, keepBodies: true });
    const measured = creaseParts(s.parts);
    if (!s.full || s.full === s.parts) return { ...model, parts: measured, trisOut: s.trisOut, simplifyError: 0, fullDetail: true };
    const full = creaseParts(s.full);
    return { ...model, parts: measured, full, trisOut: triangleCount(full), simplifyError: s.error, fullDetail: true };
  }
  const s = await simplifyParts(parts, clampBudget(triBudget), onProgress, opts);
  return { ...model, parts: creaseParts(s.parts), trisOut: s.trisOut, simplifyError: s.error };
}
