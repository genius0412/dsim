/**
 * THE MEASURE WORKER: the heavy half of a measurement (`orientParts`: units and up-axis detection,
 * the model frame, the raw footprint hull, floor contacts and wheels, height bands) for a units, up
 * axis or turn the player picks, off the main thread. It holds one prepared model (positions and
 * indices, ≤ 150k triangles) and answers each `orient` with a small `OrientedMeasure`; the main
 * thread rebuilds the model-frame arrays itself (`toModelFrame`, bit for bit the same) so nothing
 * large comes back. three-free: this chunk is `geometry.ts` and little else.
 */
import { orientParts, type MeasureOptions, type MeshPart } from '../geometry';
import type { MeasureRequest, MeasureResponse } from './measureProtocol';

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<MeasureRequest>) => void) | null;
  postMessage(msg: MeasureResponse): void;
};

let parts: MeshPart[] = [];
let opts: MeasureOptions = { format: 'glb' };

ctx.onmessage = (e: MessageEvent<MeasureRequest>) => {
  const m = e.data;
  if (m.kind === 'init') {
    parts = m.parts;
    opts = m.opts;
    return;
  }
  try {
    const { oriented } = orientParts(parts, m.setup, opts);
    ctx.postMessage({ kind: 'oriented', id: m.id, oriented });
  } catch (err) {
    ctx.postMessage({ kind: 'error', id: m.id, message: err instanceof Error ? err.message : String(err) });
  }
};
