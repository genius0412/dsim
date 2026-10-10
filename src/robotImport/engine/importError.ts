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
 * Where a player goes when a file cannot be read: a mesh export, menu by menu. Every format the
 * four CAD tools FTC teams use can write one the importer reads (menu names checked against each
 * vendor's help, 2026-10: Onshape's tab Export lists GLB, SolidWorks' Save As lists Extended Reality
 * Binary, Fusion's and Inventor's export dialogs list STL).
 */
export const EXPORT_HINT =
  'Export it as a GLB or STL instead. Onshape: right-click the assembly tab, Export, GLB. Fusion: File › Export, STL. SolidWorks: File › Save As, Extended Reality Binary (*.glb). Inventor: File › Export › CAD Format, STL.';

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
  new ImportError('corrupt', `Couldn’t read ${name}: it isn’t a STEP file (it doesn’t start with ISO-10303-21). Export the robot again as STEP AP214 or AP242. ${EXPORT_HINT}`);

/** the error a cancelled import rejects with (`err.name === 'AbortError'`) */
export function abortError(): Error {
  const e = new Error('The import was cancelled.');
  e.name = 'AbortError';
  return e;
}
