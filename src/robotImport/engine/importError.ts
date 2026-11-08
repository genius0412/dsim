/**
 * The importer's one error type, three-free so the import worker can throw it and the main thread
 * re-throw it from the worker's message with the same code and sentence.
 */
export type ImportErrorCode =
  | 'no-file'
  | 'unsupported'
  | 'too-large'
  | 'corrupt'
  | 'empty'
  | 'missing-file'
  | 'draco'
  /** occt read the file and could not make triangles of it */
  | 'step-failed'
  /** the STEP reader itself (its worker or wasm) did not load */
  | 'step-reader'
  /** a STEP file that stops partway through */
  | 'truncated'
  /** a zip that could not be opened, or holds no model */
  | 'zip';

/**
 * Where a player goes when a STEP file cannot be read: a fresh STEP export, menu by menu, for the
 * four CAD tools FTC teams use. The editor takes STEP only (and a zip of it, and DSIM's own share
 * file), so this was a GLB or STL export until 2026-11-05 and is not one now: the drop box refuses both.
 */
export const EXPORT_HINT =
  'Export it again as STEP AP214 or AP242. Onshape: right-click the assembly tab, Export, STEP. Fusion: File › Export, STEP. SolidWorks: File › Save As, STEP AP214. Inventor: File › Export › CAD Format, STEP.';

/** a load failure with a sentence the UI can show as is (copy: docs/area/ui.md) */
export class ImportError extends Error {
  constructor(
    readonly code: ImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ImportError';
  }
}

/**
 * A STEP file that stops partway through: a download cut short, or a file published that way
 * (goBILDA's DECODE skid-steer STEP ends mid-entity, and a fresh download is the same). occt would
 * report only thousands of unresolved references.
 */
export const stepCutOff = (name: string): ImportError =>
  new ImportError(
    'truncated',
    `Couldn’t read ${name}: the file is cut off. It stops partway through, before the END-ISO-10303-21 line a STEP file ends with. Download it again; if the new copy is cut off too, it was published that way, so ask the publisher for a whole file. ${EXPORT_HINT}`,
  );

/** a file named .step or .stp that does not open as one */
export const notStep = (name: string): ImportError =>
  new ImportError('corrupt', `Couldn’t read ${name}: it isn’t a STEP file (it doesn’t start with ISO-10303-21). ${EXPORT_HINT}`);

/** the error a cancelled import rejects with (`err.name === 'AbortError'`) */
export function abortError(): Error {
  const e = new Error('The import was cancelled.');
  e.name = 'AbortError';
  return e;
}
