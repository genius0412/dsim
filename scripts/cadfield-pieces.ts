/**
 * EVERY PIECE OF ONE STEP FILE, READ AS THE STEP WORKER READS IT, with what occt said about each: a
 * field-test measurement for a file the editor refused. The plan is the editor's (`planPieces` with the
 * worker's piece size and, at Light, its part-size floor), each piece's text is `pieceText`, the params
 * `STEP_PIECE_PARAMS`, the colour hint `colourHint`, and the verdict `stepToParts` (a piece with B-rep
 * faces and no triangles is what the editor calls "needs more memory than the STEP reader has").
 * Readers are child processes, each keeping its occt between pieces as an occt worker does; `--fresh`
 * gives every piece a new occt instead (to tell a heap that filled up over several pieces from one
 * piece that cannot be read at all).
 *
 *   npx tsx scripts/cadfield-pieces.ts --file <path.step> [--detail light|full] [--readers 6] [--fresh] [--only 3,17]
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { colourHint, entityText, indexStep, pieceBytesFor, pieceText, planPieces } from '../src/robotImport/engine/stepSplit';
import { STEP_PIECE_PARAMS, stepToParts } from '../src/robotImport/engine/stepConvert';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i].replace(/^--/, '');
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) args.set(k, '1');
  else {
    args.set(k, v);
    i++;
  }
}
const file = args.get('file')!;
const detail = args.get('detail') ?? 'light';
const POOL = 8;
const workerSrc = readFileSync(new URL('../src/robotImport/engine/stepWorker.ts', import.meta.url), 'utf8');
const MIN_PART_MM = Number(/export const MIN_PART_MM = (\d+);/.exec(workerSrc)![1]);

// `--piecebytes 1`: every root (or every face of a split root) a piece of its own, to find the one that fails
const plan = () => {
  const bytes = new Uint8Array(readFileSync(file));
  const ix = indexStep(bytes);
  const pb = args.get('piecebytes') ? Number(args.get('piecebytes')) : pieceBytesFor(bytes.length, POOL);
  const p = planPieces(ix, { pieceBytes: pb, minPartMm: detail === 'full' ? 0 : MIN_PART_MM });
  return { bytes, ix, p };
};

async function child(list: number[], fresh: boolean) {
  const { ix, p } = plan();
  const occtMod = (await import('occt-import-js')) as unknown as { default: (a: unknown) => Promise<any> };
  const make = () => occtMod.default({ locateFile: (f: string) => join('node_modules', 'occt-import-js', 'dist', f) });
  let occt = await make();
  for (const k of list) {
    if (fresh) occt = await make();
    const text = pieceText(ix, p, k);
    const t0 = performance.now();
    let row: Record<string, unknown> = { piece: k, mb: +(text.length / 1048576).toFixed(2), units: p.pieces[k].length };
    try {
      const res = occt.ReadStepFile(text, STEP_PIECE_PARAMS);
      const out = stepToParts(res, colourHint(ix, p, p.pieces[k]));
      const heap = occt.HEAPU8?.length ?? occt.HEAP8?.length ?? 0;
      row = { ...row, ms: Math.round(performance.now() - t0), ok: out.kind === 'done', tris: out.kind === 'done' ? out.trisIn : 0, faces: out.kind === 'done' ? out.faces : 0, meshes: res?.meshes?.length ?? 0, heapMB: Math.round(heap / 1048576) };
      if (out.kind === 'done' && out.trisIn === 0 && out.faces > 0) row.verdict = 'FACES, NO TRIANGLES (the editor refuses the file here)';
      // `--sample N`: every Nth vertex occt gave, in the file's own frame (mm), for a handedness check
      if (args.get('sample') && out.kind === 'done') {
        const every = Number(args.get('sample'));
        const pts: number[] = [];
        // every Nth TRIANGLE: its centroid and area (mm, mm²), so both sides can be area-weighted
        for (const part of out.parts) {
          const P = part.positions, I = part.indices;
          for (let t = 0; t < I.length / 3; t += every) {
            const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
            const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
            const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
            pts.push(+((P[a] + P[b] + P[c]) / 3).toFixed(2), +((P[a + 1] + P[b + 1] + P[c + 1]) / 3).toFixed(2), +((P[a + 2] + P[b + 2] + P[c + 2]) / 3).toFixed(2), +area.toFixed(3));
          }
        }
        row.pts = pts;
      }
      // what the piece holds: its roots' part names (through their shape representation) and sizes
      const roots = [...new Set(p.pieces[k].map((u) => p.units[u].root))];
      row.roots = roots.slice(0, 6).map((r) => {
        const R = p.roots[r];
        const nm = /'((?:[^']|'')*)'/.exec(entityText(ix, R.rep))?.[1] ?? '';
        return `${ix.typeNames[ix.type[R.entity]]} ${nm.slice(0, 40)} ${(R.bytes / 1048576).toFixed(2)}MB${R.sizeMm != null ? ` ${R.sizeMm.toFixed(0)}mm` : ''}${p.carriers.has(r) ? ' (split into faces)' : ''}`;
      });
      row.rootCount = roots.length;
    } catch (e) {
      row = { ...row, ms: Math.round(performance.now() - t0), ok: false, threw: String(e).slice(0, 200) };
    }
    process.stdout.write(JSON.stringify(row) + '\n');
  }
}

async function main() {
  if (args.get('child')) return child(args.get('child')!.split(',').map(Number), args.has('fresh'));
  const t0 = performance.now();
  const { p } = plan();
  const weights = p.pieces.map((u) => u.reduce((s, x) => s + p.units[x].bytes, 0) + p.skeletonBytes);
  let order = p.pieces.map((_, k) => k).sort((a, b) => weights[b] - weights[a] || a - b);
  if (args.get('only')) order = args.get('only')!.split(',').map(Number);
  // `--isolate 41,42 --piecebytes 1`: the roots of those pieces in the EDITOR's plan, one piece each
  if (args.get('isolate')) {
    const bytes = new Uint8Array(readFileSync(file));
    const ix = indexStep(bytes);
    const ed = planPieces(ix, { pieceBytes: pieceBytesFor(bytes.length, POOL), minPartMm: detail === 'full' ? 0 : MIN_PART_MM });
    const want = new Set(args.get('isolate')!.split(',').map(Number).flatMap((k) => ed.pieces[k].map((u) => ed.roots[ed.units[u].root].entity)));
    order = p.pieces.map((_, k) => k).filter((k) => p.pieces[k].some((u) => want.has(p.roots[p.units[u].root].entity)));
  }
  const n = Math.min(Number(args.get('readers') ?? 6), order.length);
  console.log(JSON.stringify({ file: file.split(/[\\/]/).pop(), detail, pieces: p.pieces.length, readers: n, skipped: p.skipped.length, planMs: Math.round(performance.now() - t0) }));
  // round-robin, biggest first, so each reader gets a mix as the pool's would
  const lists: number[][] = Array.from({ length: n }, () => []);
  order.forEach((k, i) => lists[i % n].push(k));
  const rows: any[] = [];
  await Promise.all(
    lists.map(
      (list) =>
        new Promise<void>((res) => {
          const c = spawn(process.execPath, [...process.execArgv, process.argv[1], '--file', file, '--detail', detail, '--child', list.join(','), ...(args.has('fresh') ? ['--fresh'] : []), ...(args.get('sample') ? ['--sample', args.get('sample')!] : []), ...(args.get('piecebytes') ? ['--piecebytes', args.get('piecebytes')!] : [])], { stdio: ['ignore', 'pipe', 'pipe'] });
          let buf = '';
          c.stdout.on('data', (d) => {
            buf += d;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, i);
              buf = buf.slice(i + 1);
              try {
                const r = JSON.parse(line);
                rows.push(r);
                if (!r.ok || r.verdict) console.log('PROBLEM ' + line);
              } catch {}
            }
          });
          c.stderr.on('data', (d) => process.stderr.write(d));
          c.on('close', (code) => {
            if (code) console.log(`reader exited ${code} (pieces ${list.join(',')})`);
            res();
          });
        }),
    ),
  );
  rows.sort((a, b) => a.piece - b.piece);
  if (args.get('sampleout')) {
    const all: number[] = [];
    for (const r of rows) if (r.pts) for (const v of r.pts) all.push(v);
    writeFileSync(args.get('sampleout')!, JSON.stringify(all));
  }
  for (const r of rows) {
    delete r.pts;
    console.log(JSON.stringify(r));
  }
  const bad = rows.filter((r) => !r.ok || r.verdict);
  console.log(JSON.stringify({ read: rows.length, of: order.length, bad: bad.map((r) => r.piece), tris: rows.reduce((s, r) => s + (r.tris ?? 0), 0), maxHeapMB: Math.max(0, ...rows.map((r) => r.heapMB ?? 0)), seconds: Math.round((performance.now() - t0) / 1000) }));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
