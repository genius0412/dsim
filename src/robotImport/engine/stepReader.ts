/**
 * Read a STEP file in a worker (`stepWorker.ts`, which runs occt in its own workers). Reached only
 * through `load.ts`'s dynamic `import('./stepReader')`, so the workers, occt's glue and the wasm
 * are fetched only when a STEP file is dropped. occt converts to millimetres itself, so a STEP
 * file's unit is KNOWN.
 *
 * The FILE goes to the worker, not its bytes: a 420 MB STEP (or the 69 MB zip it came in) is read
 * there, and the page never holds it. occt cannot be interrupted from inside, and a big export keeps
 * it busy for minutes: `signal` TERMINATES the worker, which takes its occt workers with it.
 */
import { ImportError, abortError } from './importError';
import type { StepPart, StepRequest, StepResponse, StepStage } from './stepConvert';
import type { ZipEntry } from './zip';

export type StepProgress = (stage: StepStage, frac?: number) => void;

export function readStep(
  file: Blob,
  name: string,
  entry: ZipEntry | null,
  onProgress?: StepProgress,
  signal?: AbortSignal,
  keepSmall = false,
): Promise<{ parts: StepPart[]; trisIn: number; notes: string[] }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    let worker: Worker;
    try {
      worker = new Worker(new URL('./stepWorker.ts', import.meta.url), { type: 'module' });
    } catch (e) {
      reject(new ImportError('step-reader', `Couldn’t start the STEP reader (${e instanceof Error ? e.message : String(e)}). Reload the page and try again.`));
      return;
    }
    const onAbort = (): void => {
      worker.terminate();
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const end = (): void => {
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
    };
    let heard = false;
    worker.onmessage = (e: MessageEvent<StepResponse>) => {
      heard = true;
      const m = e.data;
      if (m.kind === 'progress') {
        onProgress?.(m.stage, m.frac);
        return;
      }
      end();
      if (m.kind === 'done') resolve({ parts: m.parts, trisIn: m.trisIn, notes: m.notes });
      else reject(new ImportError(m.code ?? 'step-failed', m.message));
    };
    worker.onerror = (e) => {
      e.preventDefault();
      end();
      // silent and then an error: the script did not load. Part-way: it ran out of something.
      reject(
        heard
          ? new ImportError('step-failed', `Couldn’t finish reading ${name} (${e.message || 'the STEP reader stopped'}). The browser may have run out of memory: close other tabs and try again, or export a GLB or STL.`)
          : new ImportError('step-reader', `Couldn’t load the STEP reader (${e.message || 'its script did not load'}). Check your connection and try again.`),
      );
    };
    worker.postMessage({ file, name, entry, keepSmall } satisfies StepRequest);
  });
}
