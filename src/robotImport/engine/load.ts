/**
 * Files → parts ON THE CALLING THREAD. One loader per format, all ending in the same place:
 * `MeshPart`s in the SOURCE frame (world transforms applied, the file's own units and axes), merged
 * by colour.
 *
 * The editor does not read a dropped file here: `importSession.ts` sends GLB, glTF, STL, OBJ, PLY
 * and 3MF to the import worker, which runs `parse.ts` there, and STEP to its own worker. This is the
 * path for a stored mesh or a share file (≤ 4 MB), for the dev harness, and for a browser that
 * cannot start a worker (3MF then uses the page's own `DOMParser`).
 *
 * A dropped .zip is opened here only as far as its directory (the file's last few KB), to see
 * which model is inside; the model itself is inflated where it is read.
 */
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { ModelFormat } from '../types';
import { EXPORT_HINT, ImportError } from './importError';
import { WORKER_FORMATS, assembleLoaded, extOf, parseFiles, type LoadProgress, type LoadedModel, type ParsedFiles } from './parse';
import type { StepPart } from './stepConvert';
import { entryBaseName, unzipFiles, zipEntries, type ZipPick } from './zip';

export type { ZipPick } from './zip';

export { ImportError } from './importError';
export type { ImportErrorCode } from './importError';
export { partsFromObject } from './parse';
export type { LoadedModel, LoadProgress, LoadStage } from './parse';

/** the largest mesh file (or mesh inside a zip) the importer reads */
export const MAX_FILE_BYTES = 400 * 1024 * 1024;
/**
 * The largest STEP file, or STEP inside a zip, and the largest zip. A STEP past 20 MB is read in
 * pieces (`stepWorker.ts`), so what bounds it is the STEP worker holding the text and its index
 * (about 1.5 × the file) beside the occt workers: measured on goBILDA's 420 MB BIOBUZZ starter bot.
 */
export const MAX_STEP_BYTES = 1024 * 1024 * 1024;

const EXT_FORMAT: Record<string, ModelFormat> = {
  glb: 'glb',
  gltf: 'gltf',
  stl: 'stl',
  obj: 'obj',
  '3mf': '3mf',
  ply: 'ply',
  step: 'step',
  stp: 'step',
};
/** which file is the model when several are dropped together */
const PRIORITY: ModelFormat[] = ['glb', 'gltf', 'step', '3mf', 'obj', 'stl', 'ply'];

/** which of these names would be read, and as what (null when none is a supported model) */
function pickModel<T extends { name: string }>(items: readonly T[]): { item: T; format: ModelFormat } | null {
  let best: { item: T; format: ModelFormat } | null = null;
  for (const f of items) {
    const fmt = EXT_FORMAT[extOf(f.name)];
    if (!fmt) continue;
    if (!best || PRIORITY.indexOf(fmt) < PRIORITY.indexOf(best.format)) best = { item: f, format: fmt };
  }
  return best;
}

/** which of these files would be read, and as what (null when none is a supported model) */
export function pickModelFile(files: readonly File[]): { file: File; format: ModelFormat } | null {
  const p = pickModel(files);
  return p && { file: p.item, format: p.format };
}

const capFor = (format: ModelFormat): number => (format === 'step' ? MAX_STEP_BYTES : MAX_FILE_BYTES);
const mb = (bytes: number): number => Math.round(bytes / 1048576);

function tooLarge(name: string, bytes: number, format: ModelFormat): ImportError {
  return new ImportError(
    'too-large',
    format === 'step'
      ? `${name} is ${mb(bytes)} MB; the importer reads STEP files up to ${mb(MAX_STEP_BYTES)} MB. Export it without fasteners, or ${EXPORT_HINT.charAt(0).toLowerCase()}${EXPORT_HINT.slice(1)}`
      : `${name} is ${mb(bytes)} MB; the importer reads ${format.toUpperCase()} files up to ${mb(MAX_FILE_BYTES)} MB. Export it without hidden parts or fasteners and try again.`,
  );
}

const isZipName = (name: string): boolean => extOf(name) === 'zip';

/**
 * The checks every load makes before reading a byte: a file, a supported one (or a zip), not
 * empty, not over its cap. Throws `ImportError` with a sentence for the player.
 */
export function checkFiles(input: readonly File[] | FileList): { files: File[]; file: File; format: ModelFormat | 'zip' } {
  const files = Array.from(input as ArrayLike<File>);
  if (!files.length) throw new ImportError('no-file', 'Choose a robot file to import.');
  const pick = pickModelFile(files);
  if (!pick) {
    const zip = files.find((f) => isZipName(f.name));
    if (zip) {
      if (zip.size === 0) throw new ImportError('empty', `${zip.name} is empty. Download it again and retry.`);
      if (zip.size > MAX_STEP_BYTES) throw new ImportError('too-large', `${zip.name} is ${mb(zip.size)} MB; the importer reads zips up to ${mb(MAX_STEP_BYTES)} MB. Unzip it and drop the model inside.`);
      return { files, file: zip, format: 'zip' };
    }
    const names = files.map((f) => f.name).join(', ');
    throw new ImportError('unsupported', `Couldn’t read ${names}: DSIM imports GLB, glTF, STEP, STL, OBJ, 3MF and PLY, or a zip holding one. Export the robot in one of those and try again.`);
  }
  const { file, format } = pick;
  if (file.size > capFor(format)) throw tooLarge(file.name, file.size, format);
  if (file.size === 0) throw new ImportError('empty', `${file.name} is empty. Export it again and retry.`);
  return { files, file, format };
}

/** what is dropped, resolved: plain files, or the model inside a zip */
export type Resolved = { files: File[]; file: File; format: ModelFormat; zip: null } | { files: File[]; file: File; format: ModelFormat; zip: ZipPick };

/**
 * `checkFiles`, and for a zip its directory read (the last few KB of the file) and the model in it
 * picked by the same priority as dropped files, with the same caps on its unpacked size.
 */
export async function resolveFiles(input: readonly File[] | FileList): Promise<Resolved> {
  const c = checkFiles(input);
  if (c.format !== 'zip') return { files: c.files, file: c.file, format: c.format, zip: null };
  const zip = c.file;
  const entries = await zipEntries(zip, zip.name);
  const pick = pickModel(entries.filter((e) => !/(^|\/)(__MACOSX|\.)/.test(e.name)));
  if (!pick) {
    const inside = entries.slice(0, 6).map((e) => entryBaseName(e.name)).join(', ') || 'nothing';
    throw new ImportError('zip', `Couldn’t find a robot model in ${zip.name}: it holds ${inside}${entries.length > 6 ? ' …' : ''}. Drop a zip with a GLB, glTF, STEP, STL, OBJ, 3MF or PLY in it, or the model itself.`);
  }
  const { item: entry, format } = pick;
  const name = entryBaseName(entry.name);
  if (entry.size > capFor(format)) throw tooLarge(name, entry.size, format);
  if (entry.size === 0) throw new ImportError('empty', `${name} in ${zip.name} is empty. Export it again and retry.`);
  // a .gltf's buffers and an .obj's materials travel with it
  const companions = format === 'gltf' ? ['bin'] : format === 'obj' ? ['mtl'] : [];
  const extra = entries.filter((e) => e !== entry && companions.includes(extOf(e.name)));
  return { files: c.files, file: zip, format, zip: { zip, entry, entries: [entry, ...extra], format, name } };
}

export interface LoadOptions {
  /** stop a STEP read (its worker is terminated) and reject with an `AbortError` */
  signal?: AbortSignal;
}

/**
 * Read dropped files into parts. Several files may be dropped together: a `.gltf` with its
 * `.bin`, an `.obj` with its `.mtl`; or a zip holding them. Throws `ImportError` with a sentence
 * for the player.
 */
export async function loadModel(input: readonly File[] | FileList, onProgress?: LoadProgress, opts: LoadOptions = {}): Promise<LoadedModel> {
  const { name, format, parsed } = await readRaw(input, onProgress, opts);
  onProgress?.('convert');
  return assembleLoaded(name, format, parsed);
}

/**
 * `loadModel` without the merge: the parts as the format gave them. The import session reads a
 * STEP file this way (and 3MF where no worker starts) and hands the parts to the worker, which
 * merges and simplifies them.
 */
export async function readRaw(
  input: readonly File[] | FileList,
  onProgress?: LoadProgress,
  opts: LoadOptions = {},
): Promise<{ name: string; format: ModelFormat; parsed: ParsedFiles }> {
  const r = await resolveFiles(input);
  const name = r.zip ? r.zip.name : r.file.name;
  onProgress?.('read');
  if (r.format === 'step') return { name, format: r.format, parsed: await readStepFile(r, onProgress, opts.signal) };
  let files = r.files;
  let file = r.file;
  if (r.zip) {
    files = await unzipFiles(r.zip, (f) => onProgress?.('unzip', f), opts.signal);
    file = files[0];
  }
  if (!WORKER_FORMATS.includes(r.format)) throw new Error(`${r.format} is not read here`);
  return { name, format: r.format, parsed: await parseFiles(file, files, r.format, onProgress, async () => MeshoptDecoder, opts.signal) };
}

/** a STEP file (or the STEP in a zip) in its worker */
export async function readStepFile(r: Resolved, onProgress?: LoadProgress, signal?: AbortSignal): Promise<ParsedFiles> {
  const name = r.zip ? r.zip.name : r.file.name;
  let readStep: typeof import('./stepReader').readStep;
  try {
    ({ readStep } = await import('./stepReader'));
  } catch (e) {
    throw new ImportError('step-reader', `Couldn’t load the STEP reader (${e instanceof Error ? e.message : String(e)}). Check your connection and try again.`);
  }
  const res = await readStep(r.file, name, r.zip?.entry ?? null, (s, frac) => onProgress?.(s, frac), signal);
  return stepParsed(res, r.zip ? r.zip.entry.size : r.file.size);
}

/**
 * The STEP worker's answer as the import's parsed files. ⚠️ Each part keeps its `body` ids (one per
 * occt solid): dropped here, every STEP import fell back to one body per connected piece of a colour,
 * so a channel and the gear touching it, or a wheel's hub and a motor shield, were one part that
 * could only move together (2026-10-04, owner: "You are still combining the motor into the wheel").
 */
export function stepParsed(res: { parts: readonly StepPart[]; trisIn: number; notes: string[] }, bytes: number): ParsedFiles {
  const parts = res.parts.map((p) => ({ positions: p.positions, indices: p.indices, color: p.color, name: p.name, body: p.body ?? null }));
  return { parts, bytes, notes: res.notes, fileUnit: 'mm', trisIn: res.trisIn };
}
