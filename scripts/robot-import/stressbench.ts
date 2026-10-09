/**
 * THE IMPORTER'S STAGES, TIMED IN NODE on the stress robots (lane 9). The editor-level numbers
 * come from `stressprobe.cjs` in a real browser; this one splits the engine's work by stage on one
 * thread with nothing else running, and answers the accuracy question the browser cannot: how far
 * the measurement taken on the SIMPLIFIED mesh is from the one taken on the full model.
 *
 *   npx tsx scripts/robot-import/stressbench.ts [--dir DIR] [--files stress-s.stl,…] [--full]
 *
 * `--full` also measures the unsimplified model (slow at millions of triangles: it is the
 * reference the tolerance is stated against).
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDescriptor, defaultImportSetup, measureParts, triangleCount } from '../../src/robotImport/geometry';
import { loadModel } from '../../src/robotImport/engine/load';
import { normalise, simplifyModel } from '../../src/robotImport/engine/importerEngine';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const DIR = arg('dir', join(tmpdir(), 'dsim-robot-stress'));
const FILES = arg('files', 'stress-s.stl,stress-m.stl,stress-l.stl,stress-s.glb,stress-l.glb').split(',');
const FULL = process.argv.includes('--full');
const mb = (b: number): string => `${Math.round(b / 1048576)}`;

/** the largest distance from any vertex of `a` to polygon `b`'s boundary, when outside it */
function hullGap(a: { x: number; y: number }[], b: { x: number; y: number }[]): number {
  let worst = 0;
  for (const p of a) {
    let inside = true;
    let d = Infinity;
    for (let i = 0; i < b.length; i++) {
      const s = b[i];
      const t = b[(i + 1) % b.length];
      const cr = (t.x - s.x) * (p.y - s.y) - (t.y - s.y) * (p.x - s.x);
      if (cr < -1e-12) inside = false;
      const dx = t.x - s.x;
      const dy = t.y - s.y;
      const l2 = dx * dx + dy * dy;
      const u = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - s.x) * dx + (p.y - s.y) * dy) / l2)) : 0;
      d = Math.min(d, Math.hypot(s.x + u * dx - p.x, s.y + u * dy - p.y));
    }
    worst = Math.max(worst, inside ? 0 : d);
  }
  return worst;
}

async function main(): Promise<void> {
  for (const name of FILES) {
    const bytes = readFileSync(join(DIR, name));
    const file = new File([bytes], name);
    const rss0 = process.memoryUsage().rss;
    let t = performance.now();
    const loaded = await loadModel([file]);
    const loadMs = performance.now() - t;
    const rssLoad = process.memoryUsage().rss;
    t = performance.now();
    const prepared = await simplifyModel(loaded, 100_000);
    const simplifyMs = performance.now() - t;
    const rssSimp = process.memoryUsage().rss;
    const setup = defaultImportSetup();
    t = performance.now();
    const n = normalise(prepared, setup);
    const normMs = performance.now() - t;
    // a wheel drag: the same setup with manual wheels (units and up stay as they were, as in the editor)
    const wheels = n.measurement.wheelsUsed ?? [{ x: 5, y: 5 }, { x: 5, y: -5 }, { x: -5, y: 5 }, { x: -5, y: -5 }];
    t = performance.now();
    normalise(prepared, { ...setup, wheels: wheels.map((w, i) => (i ? w : { x: w.x + 0.25, y: w.y })) });
    const dragMs = performance.now() - t;
    // a units click: a new orientation (the editor computes it in the measure worker)
    t = performance.now();
    normalise(prepared, { ...setup, units: 'in' });
    const orientMs = performance.now() - t;
    const d = buildDescriptor({ id: '0123456789abcdef', measurement: n.measurement });
    const row: Record<string, unknown> = {
      file: name,
      MB: +(bytes.byteLength / 1048576).toFixed(1),
      trisIn: loaded.trisIn,
      trisOut: prepared.trisOut,
      loadMs: Math.round(loadMs),
      simplifyMs: Math.round(simplifyMs),
      normaliseMs: Math.round(normMs),
      wheelDragMs: +dragMs.toFixed(2),
      newOrientationMs: Math.round(orientMs),
      rssMB: `${mb(rss0)} → ${mb(rssLoad)} → ${mb(rssSimp)}`,
      units: n.measurement.units,
      up: n.measurement.up,
      size: [n.measurement.size.length, n.measurement.size.width, n.measurement.size.height].map((v) => +v.toFixed(3)),
      wheels: d.wheels,
      hullVerts: d.hull.length,
      bands: d.bands?.map((b) => [b.z0, b.z1, b.hull.length]),
    };
    if (FULL) {
      t = performance.now();
      const full = measureParts(loaded.parts, setup, { format: loaded.format, fileUnit: loaded.fileUnit });
      row.fullMeasureMs = Math.round(performance.now() - t);
      const fd = buildDescriptor({ id: '0123456789abcdef', measurement: full.measurement });
      const fm = full.measurement;
      row.vsFull = {
        size: [fm.size.length - n.measurement.size.length, fm.size.width - n.measurement.size.width, fm.size.height - n.measurement.size.height].map((v) => +v.toFixed(4)),
        sameUnitsUp: fm.units === n.measurement.units && fm.up === n.measurement.up,
        wheelsMax: fd.wheels && d.wheels ? Math.max(...fd.wheels.map((w, i) => Math.hypot(w.x - d.wheels![i].x, w.y - d.wheels![i].y))) : null,
        // how far the full model's hull pokes outside the simplified one's, and the reverse
        hullOut: +hullGap(fd.hull, d.hull).toFixed(4),
        hullIn: +hullGap(d.hull, fd.hull).toFixed(4),
        sameHull: JSON.stringify(fd.hull) === JSON.stringify(d.hull),
        fullBands: fd.bands?.map((b) => [b.z0, b.z1, b.hull.length]),
      };
    }
    console.log(JSON.stringify(row));
    void triangleCount;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
