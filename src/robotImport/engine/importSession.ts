/**
 * THE EDITOR'S IMPORT: dropped files → a prepared model, with the main thread left free. The heavy
 * work (parse, merge, weld, simplify, crease) runs in a fresh `importWorker.ts` per import, 3MF and a
 * zip's model included; STEP is read in its own workers first, and its parts then go to the import
 * worker for the rest. Arrays travel TRANSFERRED both ways.
 *
 * `signal` cancels: every worker this import started is terminated at once (an occt read or a
 * meshopt pass cannot be interrupted from inside), and the promise rejects with an `AbortError`.
 *
 * Where a worker cannot start (no `Worker`, or a script that fails to load), the same steps run
 * here on the main thread through `load.ts`, as they always did.
 */
import { bakeModelHere, type BakeModelInput } from './bakeMesh';
import { isFullDetail, type MeshPart } from '../geometry';
import { ImportError, abortError } from './importError';
import { partBuffers, type ImportProgress, type ImportRequest, type ImportResponse } from './importProtocol';
import { liteMesh } from './lite';
import { loadModel, readStepFile, resolveFiles } from './load';
import { WORKER_FORMATS } from './parse';
import { simplifyModel, type PreparedModel } from './prepare';

export interface ImportOptions {
  /** the triangle budget (`ImportSetup.triBudget`) */
  budget: number;
  onProgress?: (p: ImportProgress) => void;
  signal?: AbortSignal;
}

/** null where a module worker cannot be made at all */
function spawn(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('./importWorker.ts', import.meta.url), { type: 'module' });
  } catch (e) {
    console.warn('[import] the import worker could not start; reading on the main thread', e);
    return null;
  }
}

/** the same steps on this thread (no worker) */
async function onMainThread(files: File[], opts: ImportOptions): Promise<PreparedModel> {
  const loaded = await loadModel(files, (stage, frac) => opts.onProgress?.({ stage, frac }), { signal: opts.signal, keepSmall: isFullDetail(opts.budget) });
  if (opts.signal?.aborted) throw abortError();
  opts.onProgress?.({ stage: 'simplify', tris: loaded.trisIn });
  // a frame for the label to paint before the synchronous part of simplification
  await new Promise((r) => setTimeout(r, 30));
  return simplifyModel(loaded, opts.budget, undefined, { consume: true });
}

/**
 * The bake's mesh half (`bakeModelHere`) in a fresh import worker, the result transferred back; on
 * this thread where a worker cannot start or stops. The parts are COPIED there (the editor keeps
 * showing them; at Full detail a few hundred MB, a memory copy), so this thread still has them to
 * fall back on.
 */
export async function bakeModelOff(input: BakeModelInput): Promise<{ glb: ArrayBuffer; pictures: MeshPart[]; refits: number }> {
  const worker = spawn();
  if (!worker) return bakeModelHere(input);
  return new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<ImportResponse>) => {
      const m = e.data;
      if (m.kind === 'progress') return;
      worker.terminate();
      if (m.kind === 'baked') resolve({ glb: m.glb, pictures: m.pictures, refits: m.refits });
      else reject(new Error(m.kind === 'error' ? m.message : 'unexpected answer from the import worker'));
    };
    worker.onerror = (e) => {
      e.preventDefault();
      worker.terminate();
      console.warn('[import] the bake worker stopped; baking on the main thread', e.message);
      bakeModelHere(input).then(resolve, reject);
    };
    worker.postMessage({ kind: 'bake', input } satisfies ImportRequest);
  });
}

/**
 * The relay's lighter float GLB (`liteMesh`) in a fresh import worker; on this thread where a worker
 * cannot start or stops. From a 250k-triangle stored mesh it is 0.8 s of simplifying and exporting
 * (Node, 2026-10-03), which on this thread froze the lobby the first time a room asked for the robot.
 * `glb` is copied, never transferred: the caller keeps it.
 */
export async function liteMeshOff(glb: ArrayBuffer, maxBytes: number): Promise<ArrayBuffer | null> {
  const worker = spawn();
  if (!worker) return liteMesh(glb, maxBytes);
  return new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<ImportResponse>) => {
      const m = e.data;
      if (m.kind === 'progress') return;
      worker.terminate();
      if (m.kind === 'lite') resolve(m.glb);
      else reject(new Error(m.kind === 'error' ? m.message : 'unexpected answer from the import worker'));
    };
    worker.onerror = (e) => {
      e.preventDefault();
      worker.terminate();
      console.warn('[import] the lighter mesh worker stopped; making it on the main thread', e.message);
      liteMesh(glb, maxBytes).then(resolve, reject);
    };
    worker.postMessage({ kind: 'lite', glb: glb.slice(0), maxBytes } satisfies ImportRequest);
  });
}

/** read and prepare `input` (the editor's `readModel`); throws `ImportError` or `AbortError` */
export async function importModel(input: readonly File[] | FileList, opts: ImportOptions): Promise<PreparedModel> {
  const files = Array.from(input as ArrayLike<File>);
  const r = await resolveFiles(files);
  const name = r.zip ? r.zip.name : r.file.name;
  if (opts.signal?.aborted) throw abortError();
  const worker = spawn();
  if (!worker) return onMainThread(files, opts);
  let request: ImportRequest;
  let transfer: Transferable[] = [];
  try {
    if (r.format === 'step') {
      // STEP in its own workers, then the merge and simplify in the import worker
      // Full detail reads every part of the file, the screws and nuts too
      const parsed = await readStepFile(r, (stage, frac) => opts.onProgress?.({ stage, frac }), opts.signal, isFullDetail(opts.budget));
      request = { kind: 'parts', name, format: 'step', parsed, budget: opts.budget };
      transfer = partBuffers(parsed.parts);
    } else if (!WORKER_FORMATS.includes(r.format)) {
      throw new Error(`${r.format} has no reader`);
    } else if (r.zip) {
      request = { kind: 'zip', pick: r.zip, budget: opts.budget };
    } else {
      request = { kind: 'files', files: r.files, primary: r.files.indexOf(r.file), format: r.format, budget: opts.budget };
    }
  } catch (e) {
    worker.terminate();
    throw e;
  }
  return new Promise<PreparedModel>((resolve, reject) => {
    let heard = false;
    const done = (): void => {
      opts.signal?.removeEventListener('abort', onAbort);
      worker.terminate();
    };
    const onAbort = (): void => {
      done();
      reject(abortError());
    };
    if (opts.signal?.aborted) return onAbort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = (e: MessageEvent<ImportResponse>) => {
      heard = true;
      const m = e.data;
      if (m.kind === 'progress') {
        opts.onProgress?.({ stage: m.stage, frac: m.frac, tris: m.tris });
        return;
      }
      done();
      if (m.kind === 'done') resolve(m.model);
      else if (m.kind !== 'error') reject(new Error('unexpected answer from the import worker'));
      else if (m.code) reject(new ImportError(m.code, m.message));
      else {
        const err = new Error(m.message);
        err.name = m.name;
        reject(err);
      }
    };
    worker.onerror = (e) => {
      e.preventDefault();
      done();
      // a worker that never said a word did not load (a blocked module script, an old browser):
      // do it here instead. One that failed part-way ran out of something; say so.
      if (!heard && (request.kind === 'files' || request.kind === 'zip')) {
        console.warn('[import] the import worker did not start; reading on the main thread', e.message);
        onMainThread(files, opts).then(resolve, reject);
      } else {
        reject(new ImportError('corrupt', `Couldn’t finish reading ${name} (${e.message || 'the reader stopped'}). Export it again, or with fewer parts, and retry.`));
      }
    };
    worker.postMessage(request, transfer);
  });
}
