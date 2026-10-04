/**
 * THE IMPORTER ENGINE — the one entry of the lazy three.js zone `src/robotImport/engine/`.
 *
 * Reached ONLY through `loadImporterEngine()` (`src/robotImport/engineLoader.ts`), the single
 * dynamic specifier, so the zone is one measurable chunk (`bundleaudit`'s `importer` route) and
 * a player who never imports a robot downloads none of it. STEP support is a further lazy step
 * inside (`load.ts` → `stepReader.ts` → a worker), fetched only when a STEP file is dropped.
 *
 * The pipeline, in the order the editor runs it:
 *   importModel(files, opts)    → PreparedModel: read, merged, welded, ≤ budget, creased — in the
 *                                 import WORKER, cancellable, with progress (`importSession.ts`)
 *   prepareMeasure(model, setup)→ the heavy half of the measurement, in the measure WORKER
 *   normalise(model, setup)     → measurement + MODEL-frame parts, from the cached halves (cheap:
 *                                 re-run on every edit; `measureSession.ts`)
 *   bake({ … })                 → the stored GLB, the top PNG, the thumbnail
 *   createPreview(canvas)       → the orbit view the editor drives with `update`
 * `loadModel` + `simplifyModel` are the same first step on the calling thread (a stored mesh, a
 * share file, the dev harness). Frames and budgets: `docs/area/robot-import.md`.
 */
import type { ImportSetup } from '../types';
import { measurerFor, releaseMeasurer, type NormalisedModel } from './measureSession';
import type { PreparedModel } from './prepare';

export { loadModel, pickModelFile, ImportError, MAX_FILE_BYTES } from './load';
export type { LoadedModel, LoadProgress, LoadStage, ImportErrorCode } from './load';
export { importModel } from './importSession';
export type { ImportOptions } from './importSession';
export type { ImportProgress, ImportStage } from './importProtocol';
export { simplifyModel } from './prepare';
export type { PreparedModel } from './prepare';
export type { NormalisedModel } from './measureSession';
export { bake, exportGlb, renderTop, renderThumb, toRobotLocal } from './bake';
// the relay's lighter mesh, made in the import worker (`liteMeshOff`; `lite.ts` is the work itself)
export { liteMeshOff as liteMesh } from './importSession';
export type { BakeInput, BakeResult } from './bake';
export { createPreview } from './preview';
export type { PreviewController, PreviewState } from './preview';

/**
 * Units, up axis, yaw, floor, centring, and every measurement (`measureParts`), on the prepared
 * model, from two cached halves: the orientation (`prepareMeasure` computes it off the main thread;
 * this computes it here if nobody did) and the wheels/hull-cap finish. The SAME objects come back
 * while nothing they depend on changed, and callers must not mutate them.
 */
export function normalise(model: PreparedModel, setup: ImportSetup): NormalisedModel {
  return measurerFor(model).normalise(setup);
}

/** is `setup`'s orientation measured, so `normalise` is cheap? */
export function measureReady(model: PreparedModel, setup: ImportSetup): boolean {
  return measurerFor(model).ready(setup);
}

/** measure `setup`'s orientation in the measure worker; resolves when `measureReady` */
export function prepareMeasure(model: PreparedModel, setup: ImportSetup): Promise<void> {
  return measurerFor(model).prepare(setup);
}

/** drop a model's cached measurements and stop its measure worker */
export function releaseModel(model: PreparedModel): void {
  releaseMeasurer(model);
}
