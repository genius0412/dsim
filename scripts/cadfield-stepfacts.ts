/**
 * WHAT THE IMPORTER'S STEP INDEX AND SPLIT MAKE OF ONE REAL STEP FILE, in Node, no occt.
 * A field-test measurement, not a test: the header (writer, schema, units), entity counts, the
 * assembly tree (products, occurrences, nesting depth, most-placed parts), and the plan the STEP worker
 * would make at Light (parts under MIN_PART_MM left out) and at Full, with the time and heap of each stage.
 *
 *   npx tsx scripts/cadfield-stepfacts.ts --file <path.step> [--pool 8] [--out <file.json>]
 *
 * Takes any path; prints JSON. Writes nothing unless --out is given.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { checkStepText, entityText, indexStep, pieceBytesFor, planPieces } from '../src/robotImport/engine/stepSplit';
// the STEP worker's own constants (stepWorker.ts touches `self` on import, so they are read from its source)
const workerSrc = readFileSync(new URL('../src/robotImport/engine/stepWorker.ts', import.meta.url), 'utf8');
const constOf = (name: string): number => {
  const m = new RegExp(`export const ${name} = ([0-9 *]+);`).exec(workerSrc);
  if (!m) throw new Error(name);
  return m[1].split('*').reduce((p, x) => p * Number(x.trim()), 1);
};
const MIN_PART_MM = constOf('MIN_PART_MM');
const DIRECT_MAX_BYTES = constOf('DIRECT_MAX_BYTES');

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const file = args.get('file');
if (!file) throw new Error('--file');
const POOL = Number(args.get('pool') ?? 8);

let heapPeak = 0;
const mem = () => {
  const m = process.memoryUsage();
  heapPeak = Math.max(heapPeak, m.rss);
  return Math.round(m.rss / 1048576);
};
const timer = setInterval(mem, 50);
const stage = <T>(name: string, f: () => T, out: Record<string, unknown>): T => {
  const t0 = performance.now();
  const r = f();
  out[name] = { ms: Math.round(performance.now() - t0), rssMB: mem() };
  return r;
};

const out: Record<string, unknown> = { file: file.split(/[\\/]/).pop() };
const stages: Record<string, unknown> = {};
const bytes = stage('readFile', () => new Uint8Array(readFileSync(file)), stages);
out.bytes = bytes.length;
out.readWhole = bytes.length <= DIRECT_MAX_BYTES;
out.check = stage('checkStepText', () => checkStepText(bytes), stages);

// the header, as text (bounded)
const head = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 16384))).toString('latin1');
const hdr = head.slice(0, Math.max(0, head.indexOf('ENDSEC;')) + 7);
out.headerText = hdr.slice(0, 3000);
const ix = stage('indexStep', () => indexStep(bytes), stages);
out.entities = ix.count;
out.maxId = ix.maxId;

// type histogram
const counts = new Map<string, number>();
for (let k = 0; k < ix.count; k++) {
  const n = ix.typeNames[ix.type[k]];
  counts.set(n, (counts.get(n) ?? 0) + 1);
}
const want = ['PRODUCT', 'PRODUCT_DEFINITION', 'NEXT_ASSEMBLY_USAGE_OCCURRENCE', 'MANIFOLD_SOLID_BREP', 'BREP_WITH_VOIDS', 'FACETED_BREP', 'SHELL_BASED_SURFACE_MODEL', 'ADVANCED_FACE', 'B_SPLINE_SURFACE_WITH_KNOTS', 'STYLED_ITEM', 'OVER_RIDING_STYLED_ITEM', 'GEOMETRIC_CURVE_SET', 'MAPPED_ITEM', 'SHAPE_REPRESENTATION', 'ADVANCED_BREP_SHAPE_REPRESENTATION', 'MANIFOLD_SURFACE_SHAPE_REPRESENTATION', 'TESSELLATED_SHAPE_REPRESENTATION', 'TRIANGULATED_FACE', 'COLOUR_RGB', 'DRAUGHTING_PRE_DEFINED_COLOUR', 'PRESENTATION_LAYER_ASSIGNMENT', 'INVISIBILITY'];
out.types = Object.fromEntries(want.map((w) => [w, counts.get(w) ?? 0]));
out.topTypes = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
out.complexCount = counts.get('(complex)') ?? 0;

// units: the length unit entities' text
const unitTexts = new Set<string>();
for (let k = 0; k < ix.count; k++) {
  const n = ix.typeNames[ix.type[k]];
  if (n === '(complex)' || n.includes('UNIT')) {
    const t = entityText(ix, k);
    if (/LENGTH_UNIT/.test(t)) unitTexts.add(t.replace(/^#\d+\s*=\s*/, '').slice(0, 200));
  }
  if (unitTexts.size > 8) break;
}
out.lengthUnits = [...unitTexts];

// the assembly tree: PRODUCT_DEFINITION nodes joined by NEXT_ASSEMBLY_USAGE_OCCURRENCE (relating → related)
const t1 = performance.now();
const children = new Map<number, number[]>();
const isChild = new Set<number>();
const pdName = new Map<number, string>();
const productName = new Map<number, string>();
const nonAscii = { escapes: 0, examples: [] as string[] };
for (let k = 0; k < ix.count; k++) {
  const n = ix.typeNames[ix.type[k]];
  if (n === 'NEXT_ASSEMBLY_USAGE_OCCURRENCE') {
    const refs: number[] = [];
    for (let r = ix.refStart[k]; r < ix.refStart[k + 1]; r++) refs.push(ix.refs[r]);
    if (refs.length >= 2) {
      const [a, b] = refs;
      (children.get(a) ?? children.set(a, []).get(a)!).push(b);
      isChild.add(b);
    }
  } else if (n === 'PRODUCT') {
    const t = entityText(ix, k);
    const m = /PRODUCT\s*\(\s*'((?:[^']|'')*)'/.exec(t);
    productName.set(k, m ? m[1] : '');
    if (/\\X2\\|\\X\\|\\S\\/.test(t)) {
      nonAscii.escapes++;
      if (nonAscii.examples.length < 5) nonAscii.examples.push(t.slice(0, 120));
    }
  }
}
// PRODUCT_DEFINITION → its product (through PRODUCT_DEFINITION_FORMATION)
for (let k = 0; k < ix.count; k++) {
  if (ix.typeNames[ix.type[k]] !== 'PRODUCT_DEFINITION') continue;
  let name = '';
  for (let r = ix.refStart[k]; r < ix.refStart[k + 1] && !name; r++) {
    const f = ix.refs[r];
    if (f < 0) continue;
    for (let q = ix.refStart[f]; q < ix.refStart[f + 1]; q++) {
      const p = ix.refs[q];
      if (p >= 0 && productName.has(p)) {
        name = productName.get(p)!;
        break;
      }
    }
  }
  pdName.set(k, name);
}
const roots = [...pdName.keys()].filter((k) => !isChild.has(k) && children.has(k));
let maxDepth = 0;
let leafPlacements = 0;
const placed = new Map<string, number>();
const walk = (k: number, d: number, guard: number) => {
  if (guard > 64) return;
  maxDepth = Math.max(maxDepth, d);
  const c = children.get(k);
  if (!c || !c.length) {
    leafPlacements++;
    const nm = pdName.get(k) ?? '?';
    placed.set(nm, (placed.get(nm) ?? 0) + 1);
    return;
  }
  for (const x of c) walk(x, d + 1, guard + 1);
};
for (const r of roots) walk(r, 0, 0);
out.assembly = {
  products: productName.size,
  productDefinitions: pdName.size,
  occurrences: counts.get('NEXT_ASSEMBLY_USAGE_OCCURRENCE') ?? 0,
  rootAssemblies: roots.map((r) => pdName.get(r)),
  maxDepth,
  leafPlacements,
  distinctLeafParts: placed.size,
  mostPlaced: [...placed.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15),
  nonAsciiProductNames: nonAscii,
  ms: Math.round(performance.now() - t1),
};

for (const [label, minPartMm] of [['light', MIN_PART_MM], ['full', 0]] as const) {
  const plan = stage(`plan_${label}`, () => planPieces(ix, { pieceBytes: pieceBytesFor(bytes.length, POOL), minPartMm }), stages);
  const sizes = plan.roots.map((r) => r.sizeMm).filter((s): s is number => s !== null).sort((a, b) => a - b);
  const q = (p: number) => (sizes.length ? +sizes[Math.min(sizes.length - 1, Math.floor(p * sizes.length))].toFixed(1) : null);
  const rootTypes = new Map<string, number>();
  for (const r of plan.roots) {
    const n = ix.typeNames[ix.type[r.entity]];
    rootTypes.set(n, (rootTypes.get(n) ?? 0) + 1);
  }
  out[`plan_${label}`] = {
    roots: plan.roots.length,
    rootTypes: Object.fromEntries(rootTypes),
    unknownSize: plan.roots.filter((r) => r.sizeMm === null).length,
    sizeMmP10_50_90_max: [q(0.1), q(0.5), q(0.9), sizes.length ? +sizes[sizes.length - 1].toFixed(1) : null],
    units: plan.units.length,
    pieces: plan.pieces.length,
    skipped: plan.skipped.length,
    skippedBytes: plan.skipped.reduce((s, i) => s + plan.roots[i].bytes, 0),
    splitIntoFaces: plan.carriers.size,
    biggestRootMB: +(Math.max(0, ...plan.roots.map((r) => r.bytes)) / 1048576).toFixed(2),
    geometryMB: +(plan.geometryBytes / 1048576).toFixed(2),
    skeletonMB: +(plan.skeletonBytes / 1048576).toFixed(2),
    unstyledRoots: plan.roots.filter((r) => r.style < 0).length,
  };
}
clearInterval(timer);
out.stages = stages;
out.rssPeakMB = Math.round(heapPeak / 1048576);
const s = JSON.stringify(out, null, 1);
if (args.get('out')) writeFileSync(args.get('out')!, s);
console.log(s);
