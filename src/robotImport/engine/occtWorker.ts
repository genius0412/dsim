/**
 * ONE OCCT INSTANCE: STEP text in, triangles out. occt-import-js (LGPL-2.1, OpenCascade compiled to
 * wasm) tessellates the B-rep and this worker turns its JSON into transferable typed arrays, one
 * part per colour. Spawned by the STEP worker (`stepWorker.ts`), one per piece reader, so neither
 * the 97 KB glue nor the 7.6 MB wasm is fetched by anyone who does not drop a STEP file.
 *
 * It reads one request at a time and keeps its occt between requests: the wasm heap cannot shrink,
 * and what one piece freed the next one reuses.
 */
import occtimportjs, { type Occt } from 'occt-import-js';
import wasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';
import { stepToParts, type OcctRequest, type OcctResponse } from './stepConvert';

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<OcctRequest>) => void) | null;
  postMessage(msg: OcctResponse, transfer?: Transferable[]): void;
};

let occt: Promise<Occt> | null = null;

ctx.onmessage = async (e: MessageEvent<OcctRequest>) => {
  const { id, bytes, params, hint } = e.data;
  try {
    occt ??= occtimportjs({ locateFile: () => wasmUrl });
    const o = await occt;
    ctx.postMessage({ kind: 'reading', id });
    const res = o.ReadStepFile(bytes, params);
    const out = stepToParts(res, hint);
    if (out.kind !== 'done') {
      ctx.postMessage({ kind: 'error', id, message: out.message });
      return;
    }
    const transfer: Transferable[] = [];
    for (const p of out.parts) transfer.push(p.positions.buffer, p.indices.buffer);
    ctx.postMessage({ kind: 'done', id, parts: out.parts, trisIn: out.trisIn, faces: out.faces }, transfer);
  } catch (err) {
    ctx.postMessage({ kind: 'error', id, message: err instanceof Error ? err.message : String(err) });
  }
};
