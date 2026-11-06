/**
 * WHAT THE EDITOR TAKES (owner, 2026-11-05): STEP CAD, a zip holding a STEP (goBILDA publishes its
 * starter bots as zips of the STEP), or one `.glb` that `ImportEditor` then checks is a DSIM share
 * file. Every path a file comes in by asks this first: the picker and a drop, Replace, and files
 * handed from the robot page. DOM-free, so `npm test` holds the rule with `File` stubs.
 *
 * A zip is judged by its DIRECTORY (`zipFileNames` in the engine, the last few KB of the file): it
 * is taken when a `.step` or `.stp` is in it, and the engine then reads that STEP whatever else the
 * zip holds (`ImportOptions.zipFormats`).
 */
import { COPY } from './copy';

/** the picker's filter */
export const ACCEPT = '.step,.stp,.zip,.glb';
const STEP_NAME = /\.(step|stp)$/i;
const ZIP_NAME = /\.zip$/i;
const GLB_NAME = /\.glb$/i;

export const isStepName = (name: string): boolean => STEP_NAME.test(name);

/** what a selection is by its names: STEP files, one zip, one possible share file, or none of them */
export type SelectionKind = 'step' | 'zip' | 'share';

export function selectionKind(files: readonly { name: string }[]): SelectionKind | null {
  if (!files.length) return null;
  if (files.every((f) => isStepName(f.name))) return 'step';
  if (files.length !== 1) return null;
  if (ZIP_NAME.test(files[0].name)) return 'zip';
  if (GLB_NAME.test(files[0].name)) return 'share';
  return null;
}

export type Selection = { ok: true; kind: SelectionKind } | { ok: false; text: string };

/**
 * A zip's file names (the engine's `zipFileNames`). It throws an `ImportError` with a sentence for a
 * file that is not a zip or is damaged; anything else it throws is the engine failing to load.
 */
export type ZipLister = (zip: File) => Promise<string[]>;

const list = (names: readonly string[]): string => names.slice(0, 3).join(', ') + (names.length > 3 ? ' …' : '');

/** may these files be imported? A refusal carries the sentence the drop box shows */
export async function checkImportFiles(files: readonly File[], listZip: ZipLister): Promise<Selection> {
  const kind = selectionKind(files);
  if (!kind) return { ok: false, text: COPY.notStep(list(files.map((f) => f.name))) };
  if (kind !== 'zip') return { ok: true, kind };
  let inside: string[];
  try {
    inside = await listZip(files[0]);
  } catch (err) {
    return { ok: false, text: err instanceof Error && err.name === 'ImportError' ? err.message : COPY.engineFailed };
  }
  if (inside.some(isStepName)) return { ok: true, kind };
  return { ok: false, text: COPY.zipNoStep(files[0].name, list(inside)) };
}
