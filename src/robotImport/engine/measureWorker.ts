/**
 * THE MEASURE WORKER: the heavy half of a measurement (`orientParts`: units and up-axis detection,
 * the model frame, the raw footprint hull, floor contacts and wheels, height bands) for a units, up
 * axis or turn the player picks, off the main thread. It holds one prepared model (positions and
 * indices, ≤ 150k triangles) and answers each `orient` with a small `OrientedMeasure`; the main
 * thread rebuilds the model-frame arrays itself (`toModelFrame`, bit for bit the same) so nothing
 * large comes back. three-free: this chunk is `geometry.ts` and little else.
 *
 * It also runs the moving-part search (`find`, `findMoving.ts`) on the parts the editor would search:
 * every triangle (`full`) when the model is kept at Full detail, else the measured ones, in the MODEL
 * frame the editor names, built here the same way (`toModelFrame`) and kept while that frame is, so a
 * build read and the search after it share one contact index.
 */
import { orientParts, toModelFrame, withoutBodies, type MeasureOptions, type MeshPart } from '../geometry';
import { runSearch } from '../findMoving';
import type { MeasureRequest, MeasureResponse } from './measureProtocol';

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<MeasureRequest>) => void) | null;
  postMessage(msg: MeasureResponse): void;
};

let parts: MeshPart[] = [];
let full: MeshPart[] | null = null;
let opts: MeasureOptions = { format: 'glb' };
/** the MODEL-frame parts of the last frame searched */
let framed: { key: string; parts: MeshPart[] } | null = null;

ctx.onmessage = (e: MessageEvent<MeasureRequest>) => {
  const m = e.data;
  if (m.kind === 'init') {
    parts = m.parts;
    opts = m.opts;
    framed = null;
    return;
  }
  if (m.kind === 'full') {
    full = m.parts;
    framed = null;
    return;
  }
  try {
    if (m.kind === 'orient') {
      const { oriented } = orientParts(parts, m.setup, opts);
      ctx.postMessage({ kind: 'oriented', id: m.id, oriented });
      return;
    }
    const key = JSON.stringify(m.frame);
    if (framed?.key !== key) {
      framed = null;
      framed = { key, parts: toModelFrame(withoutBodies(full ?? parts, m.frame.removed), m.frame.sourceToModel, m.frame.folds) };
    }
    ctx.postMessage({ kind: 'found', id: m.id, found: runSearch(framed.parts, m.search) });
  } catch (err) {
    ctx.postMessage({ kind: 'error', id: m.id, message: err instanceof Error ? err.message : String(err) });
  }
};
