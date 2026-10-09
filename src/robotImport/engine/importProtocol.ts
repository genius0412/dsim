/**
 * The messages between the main thread (`importSession.ts`) and the import worker
 * (`importWorker.ts`). Types only, so neither side imports the other.
 */
import type { ModelFormat } from '../types';
import type { ImportErrorCode } from './importError';
import type { LoadStage, ParsedFiles } from './parse';
import type { PreparedModel } from './prepare';
import type { BakeModelInput } from './bakeMesh';
import type { MeshPart } from '../geometry';
import type { ZipPick } from './zip';

/** what the import is doing; `simplify` carries the triangle count it started from */
export type ImportStage = LoadStage | 'simplify' | 'measure';

export interface ImportProgress {
  stage: ImportStage;
  /** 0..1 within the stage, when known */
  frac?: number;
  /** `simplify`: the triangles going in */
  tris?: number;
}

export type ImportRequest =
  /** a format the worker reads itself: every dropped file (a .gltf's .bin, an .obj's .mtl) */
  | { kind: 'files'; files: File[]; primary: number; format: ModelFormat; budget: number }
  /** the model inside a dropped zip (the worker inflates it, and its .bin or .mtl, itself) */
  | { kind: 'zip'; pick: ZipPick; budget: number }
  /** parts read elsewhere (STEP in its own workers), not yet merged */
  | { kind: 'parts'; name: string; format: ModelFormat; parsed: ParsedFiles; budget: number }
  /** the bake's mesh half (`bakeModelHere`): MODEL-frame parts → the stored GLB and the pictures' parts */
  | { kind: 'bake'; input: BakeModelInput }
  /** the relay's lighter float GLB (`liteMesh`) from the stored GLB */
  | { kind: 'lite'; glb: ArrayBuffer; maxBytes: number };

export type ImportResponse =
  | ({ kind: 'progress' } & ImportProgress)
  | { kind: 'done'; model: PreparedModel }
  | { kind: 'baked'; glb: ArrayBuffer; pictures: MeshPart[]; refits: number }
  | { kind: 'lite'; glb: ArrayBuffer | null }
  | { kind: 'error'; code: ImportErrorCode | null; name: string; message: string };

/** every distinct ArrayBuffer under these parts (a buffer listed twice is a DataCloneError) */
export function partBuffers(parts: readonly { positions: Float32Array; indices: Uint32Array | null; normals?: Float32Array | null; body?: Uint32Array | null }[]): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  for (const p of parts) {
    out.add(p.positions.buffer as ArrayBuffer);
    if (p.indices) out.add(p.indices.buffer as ArrayBuffer);
    if (p.normals) out.add(p.normals.buffer as ArrayBuffer);
    if (p.body) out.add(p.body.buffer as ArrayBuffer);
  }
  return [...out];
}
