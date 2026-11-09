/** The messages between `measureSession.ts` and `measureWorker.ts`. Types only. */
import type { MeasureOptions, MeshPart, OrientedMeasure } from '../geometry';
import type { Found, Search } from '../findMoving';
import type { FoldPlan } from '../motion';
import type { ImportSetup } from '../types';

/** a measured orientation's MODEL frame, as `toModelFrame` takes it, less the deleted bodies */
export interface FindFrame {
  sourceToModel: number[];
  folds: FoldPlan[];
  removed: number[];
}

export type MeasureRequest =
  | { kind: 'init'; parts: MeshPart[]; opts: MeasureOptions }
  /** every triangle of a model kept at Full detail (`PreparedModel.full`): what a search reads */
  | { kind: 'full'; parts: MeshPart[] }
  | { kind: 'orient'; id: number; setup: ImportSetup }
  | { kind: 'find'; id: number; frame: FindFrame; search: Search };

export type MeasureResponse =
  | { kind: 'oriented'; id: number; oriented: OrientedMeasure }
  | { kind: 'found'; id: number; found: Found }
  | { kind: 'error'; id: number; message: string };
