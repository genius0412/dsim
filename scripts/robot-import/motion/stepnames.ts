/**
 * A STEP FILE READ AS THE EDITOR READS IT, WITH NAMES (`docs/area/robot-import.md`, "Moving parts"):
 * in pieces, with the STEP worker's plan, params, colour hints and body numbering, one occt per child
 * process, and each body's STEP part name kept: occt's own, else its part's (a multi-body part's
 * bodies come back nameless; matched by face counts as the colours are, `lostColours`), else '~' and
 * the occt node that lists it. Never commit the vendors' files.
 *
 *   npx tsx scripts/robot-import/motion/stepnames.ts --file X.step --out DIR [--procs 8]
 *
 * Writes DIR/model.bin + DIR/model.json: the parts (positions, indices, body, colour) and names[],
 * paths[], faces[] per body id. `motionprobe.ts` reads it.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { colourHint, indexStep, pieceBytesFor, pieceText, planPieces } from '../../../src/robotImport/engine/stepSplit';
import { STEP_PIECE_PARAMS, stepToParts, type StepPart } from '../../../src/robotImport/engine/stepConvert';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const MIN_PART_MM = 16;
const POOL = 8; // the editor's pool on this machine (32 cores, deviceMemory 8)

function plan(file: string) {
  const bytes = new Uint8Array(readFileSync(file));
  const ix = indexStep(bytes);
  const p = planPieces(ix, { pieceBytes: pieceBytesFor(bytes.length, POOL), minPartMm: MIN_PART_MM });
  return { bytes, ix, p };
}

type OcctNode = { name: string; meshes: number[]; children: OcctNode[] };
type Ix = ReturnType<typeof indexStep>;
type Plan = ReturnType<typeof planPieces>;

/** what occt meshes of a root (copied from stepSplit's private `bodyMeshes`) */
function bodyMeshes(ix: Ix, e: number): { solids: number[]; shells: number[] } | null {
  const name = (x: number): string => ix.typeNames[ix.type[x]];
  const shellFaces = (s: number): number => {
    if (s < 0) return -1;
    if (name(s) === 'ORIENTED_CLOSED_SHELL' || name(s) === 'ORIENTED_OPEN_SHELL') s = ix.refStart[s + 1] > ix.refStart[s] ? ix.refs[ix.refStart[s + 1] - 1] : -1;
    if (s < 0 || (name(s) !== 'CLOSED_SHELL' && name(s) !== 'OPEN_SHELL')) return -1;
    let n = 0;
    for (let r = ix.refStart[s]; r < ix.refStart[s + 1]; r++) if (ix.refFlags[r] & 1) n++;
    return n;
  };
  const t = name(e);
  if (t === 'GEOMETRIC_CURVE_SET' || t === 'GEOMETRIC_SET') return { solids: [], shells: [] };
  const solid = t === 'MANIFOLD_SOLID_BREP' || t === 'BREP_WITH_VOIDS' || t === 'FACETED_BREP';
  if (!solid && t !== 'SHELL_BASED_SURFACE_MODEL') return null;
  const counts: number[] = [];
  for (let r = ix.refStart[e]; r < ix.refStart[e + 1]; r++) {
    const n = shellFaces(ix.refs[r]);
    if (n < 0) return null;
    counts.push(n);
  }
  return solid ? { solids: [counts.reduce((s, n) => s + n, 0)], shells: [] } : { solids: [], shells: counts };
}

/** who references each entity (CSR) */
function reverseIndex(ix: Ix): { start: Uint32Array; from: Int32Array } {
  const n = ix.count;
  const cnt = new Uint32Array(n + 1);
  for (let e = 0; e < n; e++) for (let r = ix.refStart[e]; r < ix.refStart[e + 1]; r++) if (ix.refs[r] >= 0) cnt[ix.refs[r] + 1]++;
  for (let i = 0; i < n; i++) cnt[i + 1] += cnt[i];
  const from = new Int32Array(cnt[n]);
  const fill = cnt.slice(0, n);
  for (let e = 0; e < n; e++) for (let r = ix.refStart[e]; r < ix.refStart[e + 1]; r++) if (ix.refs[r] >= 0) from[fill[ix.refs[r]]++] = e;
  return { start: cnt, from };
}

const text = (ix: Ix, e: number): string => new TextDecoder('latin1').decode(ix.buf.subarray(ix.start[e], ix.end[e]));

/** a shape representation's PRODUCT name: SDR → PDS → PD → PDF → PRODUCT, through simple SRRs */
function repName(ix: Ix, rev: { start: Uint32Array; from: Int32Array }, rep: number, cache: Map<number, string>): string {
  const hit = cache.get(rep);
  if (hit !== undefined) return hit;
  const tn = (x: number): string => ix.typeNames[ix.type[x]];
  const firstRef = (x: number): number => (ix.refStart[x + 1] > ix.refStart[x] ? ix.refs[ix.refStart[x]] : -1);
  const product = (sdr: number): string => {
    let x = firstRef(sdr); // PRODUCT_DEFINITION_SHAPE
    if (x < 0) return '';
    x = firstRef(x); // PRODUCT_DEFINITION
    if (x < 0) return '';
    x = firstRef(x); // PRODUCT_DEFINITION_FORMATION
    if (x < 0) return '';
    x = firstRef(x); // PRODUCT
    if (x < 0 || tn(x) !== 'PRODUCT') return '';
    const m = /PRODUCT\s*\(\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'/.exec(text(ix, x));
    return m ? m[2] || m[1] : '';
  };
  const seen = new Set<number>([rep]);
  let frontier = [rep];
  let out = '';
  for (let depth = 0; depth < 4 && !out && frontier.length; depth++) {
    const next: number[] = [];
    for (const r of frontier) {
      for (let k = rev.start[r]; k < rev.start[r + 1]; k++) {
        const e = rev.from[k];
        const t = tn(e);
        if (t === 'SHAPE_DEFINITION_REPRESENTATION') {
          const n = product(e);
          if (n) {
            out = n;
            break;
          }
        } else if (t === 'SHAPE_REPRESENTATION_RELATIONSHIP') {
          for (let q = ix.refStart[e]; q < ix.refStart[e + 1]; q++) {
            const o = ix.refs[q];
            if (o >= 0 && !seen.has(o)) {
              seen.add(o);
              next.push(o);
            }
          }
        }
      }
      if (out) break;
    }
    frontier = next;
  }
  cache.set(rep, out);
  return out;
}

/** per multi-body part in a read: its bodies' face counts and the part's name, solids then shells */
function nameRuns(ix: Ix, plan: Plan, units: readonly number[], rev: { start: Uint32Array; from: Int32Array }, cache: Map<number, string>): { runs: { faces: number; name: string }[][]; fill: string } {
  const whole = new Map<number, number>();
  const split = new Set<number>();
  for (const u of units) {
    const unit = plan.units[u];
    if (unit.face < 0) whole.set(plan.roots[unit.root].entity, unit.root);
    else split.add(unit.root);
  }
  const runs: { faces: number; name: string }[][] = [];
  const reps = new Set<number>();
  for (const ord of whole.values()) if (plan.roots[ord].rep >= 0) reps.add(plan.roots[ord].rep);
  for (const rep of reps) {
    const solids: { faces: number; name: string }[] = [];
    const shells: { faces: number; name: string }[] = [];
    const seen = new Set<number>();
    let known = true;
    const nm = repName(ix, rev, rep, cache);
    for (let r = ix.refStart[rep]; r < ix.refStart[rep + 1] && known; r++) {
      const ord = ix.refFlags[r] & 1 ? whole.get(ix.refs[r]) : undefined;
      if (ord === undefined || seen.has(ord)) continue;
      seen.add(ord);
      const m = bodyMeshes(ix, plan.roots[ord].entity);
      if (!m) known = false;
      else {
        for (const faces of m.solids) solids.push({ faces, name: nm });
        for (const faces of m.shells) shells.push({ faces, name: nm });
      }
    }
    if (!known || (seen.size < 2 && solids.length + shells.length < 2)) continue;
    if (solids.length) runs.push(solids);
    if (shells.length) runs.push(shells);
  }
  const fill = whole.size === 0 && split.size === 1 ? repName(ix, rev, plan.roots[[...split][0]].rep, cache) : '';
  return { runs, fill };
}

/** `lostColours` with names: each nameless mesh's part name when every best explanation agrees */
function lostNames(meshes: any[], hint: { runs: { faces: number; name: string }[][]; fill: string }): string[] {
  const n = meshes.length;
  const out: string[] = new Array(n).fill('');
  const lost = meshes.map((m) => !m.name);
  const faces = meshes.map((m) => m.brep_faces?.length ?? 0);
  for (let a = 0; a < n; ) {
    if (!lost[a]) {
      a++;
      continue;
    }
    let b = a;
    while (b < n && lost[b]) b++;
    const L = b - a;
    const at: { faces: number; name: string }[][][] = Array.from({ length: L }, () => []);
    for (let j = 0; j < L; j++) {
      for (const run of hint.runs) {
        if (!run.length || j + run.length > L) continue;
        let ok = true;
        for (let k = 0; k < run.length && ok; k++) ok = faces[a + j + k] === run[k].faces;
        if (ok) at[j].push(run);
      }
    }
    const f = new Array<number>(L + 1).fill(Infinity);
    const g = new Array<number>(L + 1).fill(Infinity);
    f[0] = 0;
    for (let j = 0; j < L; j++) {
      f[j + 1] = Math.min(f[j + 1], f[j] + 1);
      for (const run of at[j]) f[j + run.length] = Math.min(f[j + run.length], f[j]);
    }
    g[L] = 0;
    for (let j = L - 1; j >= 0; j--) {
      g[j] = g[j + 1] + 1;
      for (const run of at[j]) g[j] = Math.min(g[j], g[j + run.length]);
    }
    const says: (Set<string> | null)[] = new Array(L).fill(null);
    for (let j = 0; j < L; j++) {
      if (f[j] + 1 + g[j + 1] === f[L]) (says[j] ??= new Set()).add('');
      for (const run of at[j]) {
        if (f[j] + g[j + run.length] !== f[L]) continue;
        run.forEach((body, k) => (says[j + k] ??= new Set()).add(body.name));
      }
    }
    for (let j = 0; j < L; j++) {
      const s = says[j];
      if (s && s.size === 1) out[a + j] = [...s][0];
      else if (s && s.size > 1) out[a + j] = [...s].filter(Boolean).join(' | ');
    }
    a = b;
  }
  if (hint.fill) for (let i = 0; i < n; i++) if (lost[i] && !out[i]) out[i] = hint.fill;
  return out;
}

async function child(file: string, out: string, shard: number, of: number): Promise<void> {
  const { ix, p } = plan(file);
  const occtMod = (await import('occt-import-js')) as unknown as { default: (a: unknown) => Promise<{ ReadStepFile: (b: Uint8Array, p: unknown) => any }> };
  const wasmBytes = readFileSync(join('node_modules', 'occt-import-js', 'dist', 'occt-import-js.wasm'));
  const occt = await occtMod.default({
    locateFile: (f: string) => join('node_modules', 'occt-import-js', 'dist', f),
    instantiateWasm: (imports: any, cb: (i: WebAssembly.Instance, m: WebAssembly.Module) => void) => {
      WebAssembly.instantiate(wasmBytes, imports).then((r) => cb(r.instance, r.module));
      return {};
    },
  });
  const weights = p.pieces.map((pc) => pc.reduce((s, u) => s + p.units[u].bytes, 0) + p.skeletonBytes);
  const order = p.pieces.map((_, k) => k).sort((a, b) => weights[b] - weights[a] || a - b);
  const rev = reverseIndex(ix);
  const repCache = new Map<number, string>();
  for (let i = shard; i < order.length; i += of) {
    const k = order[i];
    const t0 = Date.now();
    const text = pieceText(ix, p, k);
    const res = occt.ReadStepFile(text, STEP_PIECE_PARAMS);
    const conv = stepToParts(res, colourHint(ix, p, p.pieces[k]));
    if (conv.kind !== 'done') throw new Error(`piece ${k}: ${conv.message}`);
    // names: the mesh's own, else its part's (face-count runs, as the colours), else '~' + the
    // deepest node that lists it; and the node path
    const hinted = lostNames(res.meshes, nameRuns(ix, p, p.pieces[k], rev, repCache));
    const names: string[] = res.meshes.map((m: any, mi: number) => m.name || hinted[mi] || '');
    const paths: string[] = res.meshes.map(() => '');
    const walk = (n: OcctNode, path: string[]): void => {
      const here = n.name ? [...path, n.name] : path;
      for (const mi of n.meshes ?? []) {
        if (!names[mi]) names[mi] = '~' + (n.name || '');
        paths[mi] = here.join(' / ');
      }
      for (const c of n.children ?? []) walk(c, here);
    };
    if (res.root) walk(res.root, []);
    const faces: number[] = res.meshes.map((m: any) => m.brep_faces?.length ?? 0);
    writePiece(join(out, `piece-${k}`), conv.parts, { names, paths, faces, meshes: res.meshes.length, trisIn: conv.trisIn });
    console.log(`shard ${shard}: piece ${k} ${Date.now() - t0} ms, ${conv.trisIn} tris, ${res.meshes.length} meshes`);
  }
}

export function writePiece(base: string, parts: StepPart[], meta: Record<string, unknown>): void {
  const head = parts.map((q) => ({ nV: q.positions.length / 3, nI: q.indices.length, color: q.color, name: q.name, body: !!q.body }));
  const total = parts.reduce((s, q) => s + q.positions.byteLength + q.indices.byteLength + (q.body ? q.body.byteLength : 0), 0);
  const bin = new Uint8Array(total);
  let o = 0;
  for (const q of parts)
    for (const a of [q.positions, q.indices, ...(q.body ? [q.body] : [])]) {
      bin.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), o);
      o += a.byteLength;
    }
  writeFileSync(base + '.bin', bin);
  writeFileSync(base + '.json', JSON.stringify({ ...meta, parts: head }));
}

export function readPiece(base: string): { parts: StepPart[]; meta: any } {
  const meta = JSON.parse(readFileSync(base + '.json', 'utf8'));
  const bin = readFileSync(base + '.bin');
  const ab = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
  let o = 0;
  const parts: StepPart[] = meta.parts.map((h: any) => {
    const positions = new Float32Array(ab.slice(o, o + h.nV * 12));
    o += h.nV * 12;
    const indices = new Uint32Array(ab.slice(o, o + h.nI * 4));
    o += h.nI * 4;
    let body: Uint32Array | undefined;
    if (h.body) {
      body = new Uint32Array(ab.slice(o, o + h.nV * 4));
      o += h.nV * 4;
    }
    return { positions, indices, color: h.color, name: h.name, body };
  });
  return { parts, meta };
}

async function driver(file: string, out: string): Promise<void> {
  const t0 = Date.now();
  const { p } = plan(file);
  const procs = Number(args.get('procs') ?? 8);
  console.log(`${p.pieces.length} pieces, ${p.skipped.length} parts left out; ${procs} readers`);
  await Promise.all(
    Array.from(
      { length: procs },
      (_, s) =>
        new Promise<void>((res, rej) => {
          const c = spawn(process.execPath, [...process.execArgv, process.argv[1], '--file', file, '--out', out, '--shard', String(s), '--of', String(procs)], { stdio: 'inherit' });
          c.on('exit', (code) => (code === 0 ? res() : rej(new Error(`shard ${s} exit ${code}`))));
        }),
    ),
  );
  // combine as the STEP worker does: piece order, each piece's bodies moved past the last one's
  let base = 0;
  const all: StepPart[] = [];
  const names: string[] = [];
  const paths: string[] = [];
  const faces: number[] = [];
  let trisIn = 0;
  for (let k = 0; k < p.pieces.length; k++) {
    const { parts, meta } = readPiece(join(out, `piece-${k}`));
    let top = -1;
    for (const q of parts) {
      if (!q.body) continue;
      for (let i = 0; i < q.body.length; i++) {
        const b = q.body[i];
        if (b > top) top = b;
        q.body[i] = b + base;
      }
    }
    for (let mi = 0; mi <= top; mi++) {
      names[base + mi] = meta.names[mi] ?? '';
      paths[base + mi] = meta.paths[mi] ?? '';
      faces[base + mi] = meta.faces[mi] ?? 0;
    }
    base += top + 1;
    all.push(...parts);
    trisIn += meta.trisIn;
  }
  writePiece(join(out, 'model'), all, { names, paths, faces, trisIn, file, skipped: p.skipped.length });
  console.log(`done: ${all.length} parts, ${base} bodies, ${trisIn} tris, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('motion/stepnames.ts')) {
  const file = args.get('file')!;
  const out = resolve(args.get('out')!);
  mkdirSync(out, { recursive: true });
  if (args.has('shard')) await child(file, out, Number(args.get('shard')), Number(args.get('of')));
  else await driver(file, out);
}
