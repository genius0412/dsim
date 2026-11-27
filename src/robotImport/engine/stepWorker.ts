/**
 * THE STEP WORKER: a dropped STEP file (or the zip it came in) → parts, off the main thread. It
 * reads the bytes itself (a 420 MB file never passes through the page), checks that the file is
 * whole, and has occt (`occtWorker.ts`) read it:
 *
 * - up to `DIRECT_MAX_BYTES`, in ONE read;
 * - past that, IN PIECES (`stepSplit.ts`): occt's wasm heap stops at 2 GB and needs about 35 bytes
 *   of it per byte of STEP text, so a 125 MB file cannot be read whole (it "succeeds" with no
 *   triangles), and pieces read in parallel. Pieces of `pieceBytesFor` go to a pool of occt workers
 *   (`poolSize` at most, their heaps held to the device's budget read by read: `HeapGate`), costliest
 *   first. At Light detail parts under `MIN_PART_MM` (screws, nuts, washers) are left out, with a
 *   note saying so; Full reads every one (`keepSmall`).
 *
 * A whole read that comes back with faces and no triangles (occt out of heap) is read again in
 * pieces. ⚠️ A PIECE that comes back so is NOT out of memory: one face occt cannot mesh blanks every
 * triangle of its read, whatever the deflection, in a fresh occt (measured on a real team assembly,
 * 2026-11-27). It is read again root by root, then by its faces (`readPieces`, `retrySplit`), within a
 * bound per piece; what was read alone and never meshes is left out and the Review notes say so
 * (`unreadNote`), what a bound stopped is said as that (`stoppedNote`), and the file is refused only
 * when that is most of it (`unreadRefused`). Every read carries a colour hint (`colourHint`): occt finds no colour for a body of a
 * multi-body part placed in an assembly, and the file says what it is. Spawned by `stepReader.ts`;
 * terminating it terminates the occt workers it made.
 */
import { EXPORT_HINT, ImportError, notStep, stepCutOff } from './importError';
import { STEP_PARAMS, STEP_PIECE_PARAMS, type OcctRequest, type OcctResponse, type StepColourHint, type StepPart, type StepRequest, type StepResponse, type StepSolidRead, type StepStage } from './stepConvert';
import {
  CostlyPricing,
  HeapGate,
  StepSyntaxError,
  checkStepText,
  colourHint,
  costlyRootOf,
  faceUnitsOf,
  mergeSolidReads,
  indexStep,
  occtDied,
  partNames,
  placementCount,
  pieceBytesFor,
  pieceHeap,
  planPieces,
  poolSize,
  readPieces,
  readerBudget,
  renumberBodies,
  runRound,
  stoppedNote,
  stoppedOf,
  retrySplit,
  stepSchema,
  trustedPlacements,
  unitsText,
  unreadNote,
  unreadOf,
  unreadRefusal,
  unreadRefused,
  wholeHint,
} from './stepSplit';
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

const nav = (): { hardwareConcurrency?: number; deviceMemory?: number } | undefined => (self as unknown as { navigator?: { hardwareConcurrency?: number; deviceMemory?: number } }).navigator;
const deviceCores = (): number => nav()?.hardwareConcurrency ?? 4;
const deviceMemoryGb = (): number => nav()?.deviceMemory ?? 8;

function devicePool(pieces: number): number {
  return poolSize(pieces, deviceCores(), deviceMemoryGb());
}

/** what one occt read gave; `heap` is the reader's wasm heap after it, bytes */
type OcctRead = { parts: StepPart[]; trisIn: number; faces: number; heap: number; meshes: number; placementOf?: number[]; boxes?: number[] };

/** one occt worker, read by read */
class OcctReader {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: OcctRead) => void; reject: (e: Error) => void; onReading?: () => void }>();
  /** occt loaded here and began a read (`reading`) */
  private started = false;

  constructor(name: string, keepSmall: boolean) {
    this.worker = new Worker(new URL('./occtWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<OcctResponse>) => {
      const m = e.data;
      if (m.kind === 'reading') this.started = true;
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.kind === 'reading') {
        p.onReading?.();
        return;
      }
      this.pending.delete(m.id);
      if (m.kind === 'done') p.resolve({ parts: m.parts, trisIn: m.trisIn, faces: m.faces, heap: Number(m.heap) || 0, meshes: Number(m.meshes) || 0, placementOf: m.placementOf, boxes: m.boxes });
      else p.reject(new Error(m.message));
    };
    this.worker.onerror = (e) => {
      e.preventDefault();
      const err = occtDied(name, e.message, this.started, keepSmall);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  read(bytes: Uint8Array, whole: boolean, hint: StepColourHint | null, onReading?: () => void, solid?: StepSolidRead): Promise<OcctRead> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onReading });
      this.worker.postMessage({ id, bytes, params: whole ? STEP_PARAMS : STEP_PIECE_PARAMS, ...(hint ? { hint } : {}), ...(solid ? { solid } : {}) } satisfies OcctRequest, [bytes.buffer]);
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
    throw new ImportError('corrupt', `Couldn’t read ${name}: it looks damaged (${e instanceof Error ? e.message : 'unknown error'}). ${EXPORT_HINT}`);
  }
  const plan = planPieces(ix, { pieceBytes: pieceBytesFor(bytes.length, devicePool(Infinity)), minPartMm: keepSmall ? 0 : MIN_PART_MM });
  if (!plan.pieces.length) {
    throw new ImportError('empty', `Couldn’t find any solids in ${name}. Export the robot as solids or surfaces and try again.`);
  }
  const cost = (units: readonly number[]): number => units.reduce((s, u) => s + plan.units[u].bytes, 0) + plan.skeletonBytes;
  // `poolSize` readers at most, their heaps held to the device's budget read by read (`HeapGate`)
  const readers = devicePool(plan.pieces.length);
  const gate = new HeapGate(readerBudget(deviceMemoryGb()), readers);
  const slots: (OcctReader | null)[] = new Array(readers).fill(null);
  // what a costly solid's faces are priced at, from what this file has shown (`CostlyPricing`)
  const pricing = new CostlyPricing(deviceMemoryGb() < 8, gate.budget, readers, pieceHeap(Math.max(...plan.pieces.map(cost))));
  let started = false;
  const onReading = (): void => {
    if (!started) {
      started = true;
      progress('step-parse', 0);
    }
  };
  const names = new Map<number, string | null>();
  // how many times a solid read again is placed, when its blank whole read and the assembly agree
  const placements = new Map<number, number | null>();
  const solidName = (k: number): string | null => {
    if (!names.has(k)) names.set(k, partNames(ix, plan, [k])[0]);
    return names.get(k)!;
  };
  progress('step-wasm');
  let out;
  try {
    out = await readPieces<{ parts: StepPart[]; trisIn: number; solid: number; placementOf?: number[]; boxes?: number[] }>(plan.pieces, {
      cost,
      geometry: (units) => units.reduce((s, u) => s + plan.units[u].bytes, 0),
      split: (units) =>
        retrySplit(
          units,
          (u) => plan.units[u].root,
          (u) => plan.units[u].face >= 0,
          (k) => faceUnitsOf(ix, plan, k),
        ),
      progress: (f) => progress('step-parse', f),
      // the file-wide rule (`RETRY_BATCH`): refused early only by the final refusal's own test
      refused: (lost, stopped) => unreadRefused(unreadOf(plan, lost).bytes + stoppedOf(plan, stopped).bytes, plan.geometryBytes),
      batch: readers,
      // the pool's own scheduler (`runRound`): what each read is, and how it is read
      run: (jobs, first, settle) => {
        const what = jobs.map((j) => {
          const units = j.units;
          const oneRoot = new Set(units.map((u) => plan.units[u].root)).size === 1;
          // a read again of some of ONE solid's faces is one body per placement (`StepSolidRead`)
          const solid = !first && oneRoot && units.every((u) => plan.units[u].face >= 0) ? plan.units[units[0]].root : -1;
          return { units, oneRoot, solid, text: cost(units), costly: costlyRootOf(plan, units) };
        });
        return runRound<OcctReader, OcctRead>(
          { gate, pricing, slots },
          what,
          first,
          {
            open: () => new OcctReader(name, keepSmall),
            close: (r) => r.close(),
            heap: (r) => r.heap,
            read: (reader, i) => {
              const w = what[i];
              return reader.read(unitsText(ix, plan, w.units), false, colourHint(ix, plan, w.units, !first && w.oneRoot), onReading, w.solid >= 0 ? { name: solidName(w.solid), placements: placements.get(w.solid) ?? null } : undefined);
            },
          },
          (i, r) => {
            const w = what[i];
            // a whole solid's blank read gives a mesh a placement: trusted only when the assembly counts the
            // same placements (a count of one for many would merge them all)
            if (w.units.length === 1 && plan.units[w.units[0]].face < 0 && r.trisIn === 0 && r.faces > 0) {
              const k = plan.units[w.units[0]].root;
              placements.set(k, trustedPlacements(r.meshes, placementCount(ix, plan, k)));
            }
            settle(i, { blank: r.trisIn === 0 && r.faces > 0, value: { parts: r.parts, trisIn: r.trisIn, solid: w.solid, placementOf: r.placementOf, boxes: r.boxes } });
          },
        );
      },
    });
  } finally {
    for (const r of slots) r?.close();
  }
  const notes: string[] = [];
  if (plan.skipped.length) {
    notes.push(`Left out ${plural(plan.skipped.length, 'part', 'parts')} under ${MIN_PART_MM} mm across (screws, nuts and washers) to read this large file faster. They don’t change the footprint.`);
  }
  const named = (ks: readonly number[]): string[] => [...new Set(partNames(ix, plan, [...ks]).filter((s): s is string => !!s))];
  if (out.lost.length || out.stopped.length) {
    // every missing surface is counted under its own reason: unreadable (read alone, blank) or stopped
    const unread = unreadOf(plan, out.lost);
    const stop = stoppedOf(plan, out.stopped);
    const lostRoots = [...unread.whole, ...unread.partial.keys()].sort((a, b) => a - b);
    const stopRoots = [...stop.whole, ...stop.partial.keys()].sort((a, b) => a - b);
    const onlyStopped = stopRoots.filter((k) => !lostRoots.includes(k));
    if (unreadRefused(unread.bytes + stop.bytes, plan.geometryBytes)) {
      throw unreadRefusal(name, lostRoots.length, onlyStopped.length, plan.roots.length - plan.skipped.length, named([...lostRoots, ...onlyStopped]), stepSchema(ix));
    }
    const faces = (m: Map<number, number>): number => [...m.values()].reduce((t, n) => t + n, 0);
    const note = unreadNote(unread.whole.length, faces(unread.partial), unread.partial.size, named(lostRoots));
    if (note) notes.push(note);
    const stopNote = stoppedNote(stop.whole.length, faces(stop.partial), stop.partial.size, named(stopRoots));
    if (stopNote) notes.push(stopNote);
  }
  // the kept faces of each solid read again by its faces become one read, one body a placement
  const reads = mergeSolidReads(out.kept).map((k) => k.value);
  renumberBodies(reads);
  return { parts: reads.flatMap((r) => r.parts), trisIn: reads.reduce((s, r) => s + r.trisIn, 0), notes };
}

ctx.onmessage = async (e: MessageEvent<StepRequest>) => {
  const req = e.data;
  try {
    const bytes = await readBytes(req);
    const check = checkStepText(bytes);
    if (!check.ok) throw check.reason === 'truncated' ? stepCutOff(req.name) : notStep(req.name);
    if (bytes.length <= DIRECT_MAX_BYTES) {
      progress('step-wasm');
      const reader = new OcctReader(req.name, !!req.keepSmall);
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
