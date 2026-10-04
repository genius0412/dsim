/**
 * THE STEP WORKER: a dropped STEP file (or the zip it came in) → parts, off the main thread. It
 * reads the bytes itself (a 420 MB file never passes through the page), checks that the file is
 * whole, and has occt (`occtWorker.ts`) read it:
 *
 * - up to `DIRECT_MAX_BYTES`, in ONE read;
 * - past that, IN PIECES (`stepSplit.ts`): occt's wasm heap stops at 2 GB and needs about 35 bytes
 *   of it per byte of STEP text, so a 125 MB file cannot be read whole (it "succeeds" with no
 *   triangles), and pieces read in parallel. Pieces of `pieceBytesFor` go to a pool of occt workers
 *   (`poolSize`), biggest first. At Light detail parts under `MIN_PART_MM` (screws, nuts, washers)
 *   are left out, with a note saying so; Full reads every one (`keepSmall`).
 *
 * A whole read that comes back with faces and no triangles (occt out of heap) is read again in
 * pieces. Every read carries a colour hint (`colourHint`): occt finds no colour for a body of a
 * multi-body part placed in an assembly, and the file says what it is. Spawned by `stepReader.ts`;
 * terminating it terminates the occt workers it made.
 */
import { EXPORT_HINT, ImportError, notStep, stepCutOff } from './importError';
import { STEP_PARAMS, STEP_PIECE_PARAMS, type OcctRequest, type OcctResponse, type StepColourHint, type StepPart, type StepRequest, type StepResponse, type StepStage } from './stepConvert';
import { StepSyntaxError, checkStepText, colourHint, indexStep, pieceBytesFor, pieceText, planPieces, poolSize, wholeHint } from './stepSplit';
import { zipEntryBytes } from './zip';

/**
 * files up to this are read whole, in one occt worker. 8 MB, was 20 (2026-10-03): past it, pieces
 * in parallel are faster (a 12.6 MB file: 10.0 s whole, 4.2 s in 3 MB pieces on 8 readers).
 */
export const DIRECT_MAX_BYTES = 8 * 1024 * 1024;
/** parts whose bounding-box diagonal is under this are left out of a file read in pieces at Light
 *  detail; Full reads them all (`StepRequest.keepSmall`) */
export const MIN_PART_MM = 16;

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<StepRequest>) => void) | null;
  postMessage(msg: StepResponse, transfer?: Transferable[]): void;
};

const progress = (stage: StepStage, frac?: number): void => ctx.postMessage({ kind: 'progress', stage, frac });

function devicePool(pieces: number): number {
  const nav = (self as unknown as { navigator?: { hardwareConcurrency?: number; deviceMemory?: number } }).navigator;
  return poolSize(pieces, nav?.hardwareConcurrency ?? 4, nav?.deviceMemory ?? 8);
}

/** one occt worker, read by read */
class OcctReader {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: { parts: StepPart[]; trisIn: number; faces: number }) => void; reject: (e: Error) => void; onReading?: () => void }>();

  constructor() {
    this.worker = new Worker(new URL('./occtWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<OcctResponse>) => {
      const m = e.data;
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.kind === 'reading') {
        p.onReading?.();
        return;
      }
      this.pending.delete(m.id);
      if (m.kind === 'done') p.resolve({ parts: m.parts, trisIn: m.trisIn, faces: m.faces });
      else p.reject(new Error(m.message));
    };
    this.worker.onerror = (e) => {
      e.preventDefault();
      const err = new ImportError('step-reader', `Couldn’t start the STEP reader (${e.message || 'it stopped'}). Reload the page and try again, or export a GLB or STL.`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  read(bytes: Uint8Array, whole: boolean, hint: StepColourHint | null, onReading?: () => void): Promise<{ parts: StepPart[]; trisIn: number; faces: number }> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onReading });
      this.worker.postMessage({ id, bytes, params: whole ? STEP_PARAMS : STEP_PIECE_PARAMS, ...(hint ? { hint } : {}) } satisfies OcctRequest, [bytes.buffer]);
    });
  }

  close(): void {
    this.worker.terminate();
  }
}

/** the bytes of the dropped file, unzipped when it came in a zip */
async function readBytes(req: StepRequest): Promise<Uint8Array> {
  if (req.entry) {
    progress('unzip', 0);
    return zipEntryBytes(req.file, req.entry, req.name, (f) => progress('unzip', f));
  }
  progress('read');
  return new Uint8Array(await req.file.arrayBuffer());
}

const plural = (n: number, one: string, many: string): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

async function readInPieces(bytes: Uint8Array, name: string, keepSmall: boolean): Promise<{ parts: StepPart[]; trisIn: number; notes: string[] }> {
  progress('step-index');
  let ix;
  try {
    ix = indexStep(bytes);
  } catch (e) {
    if (e instanceof StepSyntaxError && e.truncated) throw stepCutOff(name);
    throw new ImportError('corrupt', `Couldn’t read ${name}: it looks damaged (${e instanceof Error ? e.message : 'unknown error'}). Export it again, or export a GLB or STL instead.`);
  }
  const plan = planPieces(ix, { pieceBytes: pieceBytesFor(bytes.length, devicePool(Infinity)), minPartMm: keepSmall ? 0 : MIN_PART_MM });
  if (!plan.pieces.length) {
    throw new ImportError('empty', `Couldn’t find any solids in ${name}. Export the robot as solids or surfaces and try again.`);
  }
  const weights = plan.pieces.map((p) => p.reduce((s, u) => s + plan.units[u].bytes, 0) + plan.skeletonBytes);
  const total = weights.reduce((s, w) => s + w, 0);
  const results: { parts: StepPart[]; trisIn: number }[] = new Array(plan.pieces.length);
  const readers = Array.from({ length: devicePool(plan.pieces.length) }, () => new OcctReader());
  // the biggest pieces first, so the last one to start is a small one (a split root's faces can make
  // a piece twice the others)
  const order = plan.pieces.map((_, k) => k).sort((a, b) => weights[b] - weights[a] || a - b);
  let next = 0;
  let doneBytes = 0;
  let started = false;
  progress('step-wasm');
  try {
    await Promise.all(
      readers.map(async (reader) => {
        for (;;) {
          const i = next++;
          if (i >= order.length) return;
          const k = order[i];
          const text = pieceText(ix, plan, k);
          const r = await reader.read(text, false, colourHint(ix, plan, plan.pieces[k]), () => {
            if (!started) {
              started = true;
              progress('step-parse', doneBytes / total);
            }
          });
          if (r.trisIn === 0 && r.faces > 0) {
            throw new ImportError('step-failed', `Couldn’t read ${name}: part of it needs more memory than the STEP reader has. ${EXPORT_HINT}`);
          }
          results[k] = { parts: r.parts, trisIn: r.trisIn };
          doneBytes += weights[k];
          progress('step-parse', doneBytes / total);
        }
      }),
    );
  } finally {
    for (const r of readers) r.close();
  }
  const notes: string[] = [];
  if (plan.skipped.length) {
    notes.push(`Left out ${plural(plan.skipped.length, 'part', 'parts')} under ${MIN_PART_MM} mm across (screws, nuts and washers) to read this large file faster. They don’t change the footprint.`);
  }
  // each piece numbers its bodies from 0: move every piece's past the last one's, so a body id names
  // one solid across the whole file
  let base = 0;
  for (const r of results) {
    let top = -1;
    for (const p of r.parts) {
      if (!p.body) continue;
      for (let i = 0; i < p.body.length; i++) {
        const b = p.body[i];
        if (b > top) top = b;
        p.body[i] = b + base;
      }
    }
    base += top + 1;
  }
  return { parts: results.flatMap((r) => r.parts), trisIn: results.reduce((s, r) => s + r.trisIn, 0), notes };
}

ctx.onmessage = async (e: MessageEvent<StepRequest>) => {
  const req = e.data;
  try {
    const bytes = await readBytes(req);
    const check = checkStepText(bytes);
    if (!check.ok) throw check.reason === 'truncated' ? stepCutOff(req.name) : notStep(req.name);
    if (bytes.length <= DIRECT_MAX_BYTES) {
      progress('step-wasm');
      const reader = new OcctReader();
      let r;
      try {
        // the bytes are transferred; a copy stays here in case the whole read runs out of heap
        r = await reader.read(bytes.slice(), true, wholeHint(bytes), () => progress('step-parse'));
      } catch (err) {
        if (err instanceof ImportError) throw err;
        throw new ImportError('step-failed', `Couldn’t read ${req.name} as STEP (${err instanceof Error ? err.message : 'unknown error'}). ${EXPORT_HINT}`);
      } finally {
        reader.close();
      }
      if (!(r.trisIn === 0 && r.faces > 0)) {
        const transfer: Transferable[] = [];
        for (const p of r.parts) transfer.push(p.positions.buffer, p.indices.buffer, ...(p.body ? [p.body.buffer] : []));
        ctx.postMessage({ kind: 'done', parts: r.parts, trisIn: r.trisIn, notes: [] }, transfer);
        return;
      }
    }
    const out = await readInPieces(bytes, req.name, !!req.keepSmall);
    const transfer: Transferable[] = [];
    for (const p of out.parts) transfer.push(p.positions.buffer, p.indices.buffer, ...(p.body ? [p.body.buffer] : []));
    ctx.postMessage({ kind: 'done', parts: out.parts, trisIn: out.trisIn, notes: out.notes }, transfer);
  } catch (err) {
    if (err instanceof ImportError) ctx.postMessage({ kind: 'error', code: err.code, message: err.message });
    else ctx.postMessage({ kind: 'error', code: 'step-failed', message: `Couldn’t read ${req.name} as STEP (${err instanceof Error ? err.message : String(err)}). ${EXPORT_HINT}` });
  }
};
