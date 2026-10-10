/** The messages between `measureSession.ts` and `measureWorker.ts`. Types only. */
import type { MeasureOptions, MeshPart, OrientedMeasure } from '../geometry';
import type { ImportSetup } from '../types';

export type MeasureRequest =
  | { kind: 'init'; parts: MeshPart[]; opts: MeasureOptions }
  | { kind: 'orient'; id: number; setup: ImportSetup };

export type MeasureResponse =
  | { kind: 'oriented'; id: number; oriented: OrientedMeasure }
  | { kind: 'error'; id: number; message: string };
