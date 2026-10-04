/**
 * THE EDITOR'S MEASUREMENTS, CACHED IN TWO HALVES (`docs/area/robot-import.md`, "Measuring").
 *
 * `orientParts` (the heavy half) depends only on the model and the setup's units, up axis, yaw and
 * band switch; `finishMeasure` (the light half) on the wheels, their layout and the hull cap. So a `Measurer` keeps
 * one `OrientedMeasure` per orientation it has seen, with the model-frame parts built from it, and a
 * wheel drag, a drivetrain pick or a mechanism nudge re-runs only the light half (well under a
 * millisecond to a few). The model-frame arrays and the moving parts keep their identity while the
 * orientation (and `setup.motion`) does, so the preview does not rebuild its mesh on those edits.
 *
 * A NEW orientation is computed in `measureWorker.ts` (`prepare`), so a Units, Up axis or Turn click
 * costs the main thread only the arrays' rebuild. `normalise` answers at once from the cache, and
 * computes on this thread only when nobody asked `prepare` first (the dev harness) or a worker
 * cannot start.
 */
import { finishMeasure, orientKey, orientParts, toModelFrame, withMotion, type MeasureOptions, type MeshPart, type OrientedMeasure } from '../geometry';
import type { ImportMeasurement, ImportSetup } from '../types';
import type { MeasureRequest, MeasureResponse } from './measureProtocol';
import type { PreparedModel } from './prepare';

export interface NormalisedModel {
  measurement: ImportMeasurement;
  /** MODEL frame, with normals: what was measured (and picked, and searched for moving parts) */
  modelParts: MeshPart[];
  /**
   * MODEL frame, with normals: EVERY triangle, for a model kept at Full detail (`PreparedModel.full`):
   * what the preview shows and the bake stores. Absent when `modelParts` is the whole model.
   */
  shownParts?: MeshPart[];
}

/** orientations kept per model: units, up and turn, and the way back */
const KEEP_ORIENTATIONS = 6;
/** models with a live measurer (and so a worker): the one being edited and the one before */
const KEEP_MODELS = 2;

interface Entry {
  oriented: OrientedMeasure;
  modelParts?: MeshPart[];
  /** `PreparedModel.full` in this orientation's MODEL frame: kept for the newest orientation only */
  shown?: MeshPart[];
  finKey?: string;
  fin?: NormalisedModel;
  /** the moving parts for `motionKey` (they read the orientation and `setup.motion`, never the wheels) */
  motionKey?: string;
  motion?: ImportMeasurement['motion'];
}

/** what `finishMeasure` (and the moving parts on it) reads that `orientKey` does not */
const finishKey = (s: ImportSetup): string => JSON.stringify([s.wheels, s.hullMaxVerts, s.wheelLayout ?? null, s.motion ?? null]);

export class Measurer {
  private worker: Worker | null = null;
  private noWorker = false;
  private disposed = false;
  private entries = new Map<string, Entry>();
  private waits = new Map<string, Promise<void>>();
  private calls = new Map<number, { resolve: (o: OrientedMeasure) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private readonly opts: MeasureOptions;

  constructor(readonly model: PreparedModel) {
    this.opts = { format: model.format, fileUnit: model.fileUnit };
  }

  /** is the orientation `setup` needs cached (so `normalise` is cheap)? */
  ready(setup: ImportSetup): boolean {
    return this.entries.has(orientKey(setup));
  }

  /** compute `setup`'s orientation off the main thread; resolves when `ready(setup)` */
  prepare(setup: ImportSetup): Promise<void> {
    const key = orientKey(setup);
    if (this.entries.has(key)) return Promise.resolve();
    const have = this.waits.get(key);
    if (have) return have;
    const p = this.orientOff(setup)
      .then((oriented) => {
        this.put(key, { oriented });
      })
      .catch((err) => {
        if (this.disposed) return;
        console.warn('[import] measuring off the main thread failed; measuring here', err);
        this.computeHere(setup);
      })
      .finally(() => this.waits.delete(key));
    this.waits.set(key, p);
    return p;
  }

  /** the measurement and the model-frame parts for `setup` (cached halves; see the file comment) */
  normalise(setup: ImportSetup): NormalisedModel {
    const key = orientKey(setup);
    const entry = this.entries.get(key) ?? this.computeHere(setup);
    // most recently used last
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (!entry.modelParts) entry.modelParts = toModelFrame(this.model.parts, entry.oriented.sourceToModel, entry.oriented.folds);
    if (this.model.full && !entry.shown) {
      // EVERY TRIANGLE IN ONE ORIENTATION AT A TIME: a full copy is hundreds of MB on a real CAD
      // export, so an older orientation lets its copy go (and the answer that names it) and builds
      // it again if it is ever picked again
      for (const e of this.entries.values()) {
        if (e === entry || !e.shown) continue;
        e.shown = undefined;
        e.fin = undefined;
        e.finKey = undefined;
      }
      entry.shown = toModelFrame(this.model.full, entry.oriented.sourceToModel, entry.oriented.folds);
    }
    const fk = finishKey(setup);
    if (entry.fin && entry.finKey === fk) return entry.fin;
    const measurement = finishMeasure(entry.oriented, setup);
    // ⚠️ THE MOVING PARTS ARE KEPT, ARRAY AND ALL, while the orientation and `setup.motion` are. A
    // wheel nudge re-ran them (every vertex of the model) and handed the preview a new `motion`,
    // which rebuilt its whole mesh: a 100–120 ms task per nudge at 250k triangles (2026-10-03)
    const mk = JSON.stringify(setup.motion ?? null);
    if (entry.motionKey === mk) {
      if (entry.motion) measurement.motion = entry.motion;
    } else {
      withMotion(measurement, entry.modelParts, setup, entry.oriented);
      entry.motionKey = mk;
      entry.motion = measurement.motion;
    }
    measurement.trisIn = this.model.trisIn;
    if (!this.model.fullDetail && this.model.trisOut < this.model.trisIn) {
      measurement.checks.push({
        code: 'mesh-simplified',
        level: 'info',
        message: `Simplified from ${this.model.trisIn.toLocaleString('en-US')} to ${this.model.trisOut.toLocaleString('en-US')} triangles for the match view.`,
      });
    }
    entry.fin = { measurement, modelParts: entry.modelParts, ...(entry.shown ? { shownParts: entry.shown } : {}) };
    entry.finKey = fk;
    return entry.fin;
  }

  dispose(): void {
    this.disposed = true;
    this.worker?.terminate();
    this.worker = null;
    this.noWorker = true;
    for (const c of this.calls.values()) c.reject(new Error('the measurer was released'));
    this.calls.clear();
  }

  private computeHere(setup: ImportSetup): Entry {
    const { oriented, modelParts } = orientParts(this.model.parts, setup, this.opts);
    return this.put(orientKey(setup), { oriented, modelParts });
  }

  private put(key: string, entry: Entry): Entry {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > KEEP_ORIENTATIONS) this.entries.delete(this.entries.keys().next().value as string);
    return entry;
  }

  private orientOff(setup: ImportSetup): Promise<OrientedMeasure> {
    const w = this.workerOrNull();
    if (!w) return Promise.reject(new Error('no worker'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      w.postMessage({ kind: 'orient', id, setup } satisfies MeasureRequest);
    });
  }

  private workerOrNull(): Worker | null {
    if (this.worker || this.noWorker) return this.worker;
    if (typeof Worker === 'undefined') {
      this.noWorker = true;
      return null;
    }
    let w: Worker;
    try {
      w = new Worker(new URL('./measureWorker.ts', import.meta.url), { type: 'module' });
    } catch {
      this.noWorker = true;
      return null;
    }
    w.onmessage = (e: MessageEvent<MeasureResponse>) => {
      const m = e.data;
      const call = this.calls.get(m.id);
      if (!call) return;
      this.calls.delete(m.id);
      if (m.kind === 'oriented') call.resolve(m.oriented);
      else call.reject(new Error(m.message));
    };
    w.onerror = (e) => {
      e.preventDefault();
      // the worker is gone: every call falls back to measuring here, and so does every later one
      this.worker = null;
      this.noWorker = true;
      w.terminate();
      for (const c of this.calls.values()) c.reject(new Error(e.message || 'the measure worker stopped'));
      this.calls.clear();
    };
    // positions and indices only (normals do not change a measurement), copied: the editor keeps
    // the prepared model for the preview, the bake and the draft
    const parts: MeshPart[] = this.model.parts.map((p) => ({ positions: p.positions.slice(), indices: p.indices ? p.indices.slice() : null, color: p.color, name: p.name, body: p.body ? p.body.slice() : null }));
    const transfer = new Set<ArrayBuffer>();
    for (const p of parts) {
      transfer.add(p.positions.buffer as ArrayBuffer);
      if (p.indices) transfer.add(p.indices.buffer as ArrayBuffer);
      if (p.body) transfer.add(p.body.buffer as ArrayBuffer);
    }
    w.postMessage({ kind: 'init', parts, opts: this.opts } satisfies MeasureRequest, [...transfer]);
    this.worker = w;
    return w;
  }
}

const live: Measurer[] = [];

/** the measurer for `model`, made on first use; the oldest past `KEEP_MODELS` is released */
export function measurerFor(model: PreparedModel): Measurer {
  const at = live.findIndex((m) => m.model === model);
  if (at >= 0) {
    const m = live[at];
    live.splice(at, 1);
    live.push(m);
    return m;
  }
  const m = new Measurer(model);
  live.push(m);
  while (live.length > KEEP_MODELS) live.shift()!.dispose();
  return m;
}

/** let a model's measurer (and its worker) go: the import was saved, discarded or replaced */
export function releaseMeasurer(model: PreparedModel): void {
  const at = live.findIndex((m) => m.model === model);
  if (at >= 0) live.splice(at, 1)[0].dispose();
}
