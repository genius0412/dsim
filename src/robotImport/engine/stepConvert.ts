/**
 * occt-import-js's result → plain parts, one per colour, and the messages of the STEP workers.
 * Shared by the occt worker and the Node harness (which runs occt directly), so both measure
 * exactly the same triangles.
 */
import type { OcctParams, OcctResult } from 'occt-import-js';
import type { ImportErrorCode } from './importError';
import type { ZipEntry } from './zip';

/** the triangulation a file read WHOLE uses: millimetres, 0.1 % of the bounding box, 0.5 rad */
export const STEP_PARAMS: OcctParams = {
  linearUnit: 'millimeter',
  linearDeflectionType: 'bounding_box_ratio',
  linearDeflection: 0.001,
  angularDeflection: 0.5,
};

/**
 * The triangulation of a file read IN PIECES (`stepSplit.ts`): ABSOLUTE, 0.5 mm and 0.5 rad. A
 * bounding-box ratio is taken per top-level shape, and a piece's shape is only its share of the
 * robot, so every piece would mesh to a different tolerance. 0.5 mm is what 0.1 % of an FTC robot's
 * average extent comes to (the whole-file setting), and occt's time is its STEP parse, not this:
 * measured on REV's starter bot, 2 mm and 1 rad cut a 24 MB piece's 29.3 s to 27.4 s.
 */
export const STEP_PIECE_PARAMS: OcctParams = {
  linearUnit: 'millimeter',
  linearDeflectionType: 'absolute_value',
  linearDeflection: 0.5,
  angularDeflection: 0.5,
};

export interface StepPart {
  positions: Float32Array;
  indices: Uint32Array;
  /** linear RGB 0..1 */
  color: [number, number, number];
  name: string;
  /** per-vertex body id: the occt mesh (a solid) it came from, from 0 within one read */
  body?: Uint32Array;
}

/** what one occt read gave: parts by colour, the triangles, and the B-rep faces it saw */
export type StepParts = { kind: 'done'; parts: StepPart[]; trisIn: number; faces: number } | { kind: 'error'; message: string };

/** the STEP worker's request: the file (or the zip holding it), read there, not on the main thread */
/** `keepSmall`: read every part, screws and nuts too (Full detail); without it a file read in
 *  pieces leaves out parts under `MIN_PART_MM` to read faster */
export type StepRequest = { file: Blob; name: string; entry: ZipEntry | null; keepSmall?: boolean };
export type StepStage = 'unzip' | 'read' | 'step-wasm' | 'step-index' | 'step-parse';
export type StepResponse =
  | { kind: 'progress'; stage: StepStage; frac?: number }
  | { kind: 'done'; parts: StepPart[]; trisIn: number; notes: string[] }
  | { kind: 'error'; code: ImportErrorCode | null; message: string };

/**
 * The colours occt cannot find itself. occt-import-js names and colours a mesh by looking its solid
 * up in the document AT ITS PLACED LOCATION, and that lookup succeeds only when the solid is its
 * part's whole shape. So every body of a MULTI-BODY part placed in an assembly comes back with no
 * name and no colour, and so does every shell of a solid split into faces (`stepSplit.ts`), in a
 * whole read as in pieces (measured: the fixture's 10-body part placed twice reads all grey; a
 * third of goBILDA's BIOBUZZ bot by area). The reader knows each body's styled colour from the file,
 * and occt meshes a part's bodies in its list order, solids first, then shells, once per placement.
 */
export interface StepLostBody {
  /** the B-rep faces occt will report for it */
  faces: number;
  /** its own styled colour, linear; null when it has none */
  color: [number, number, number] | null;
}

export interface StepColourHint {
  /** per multi-body part in this read: its solids in list order, and (another run) its shells */
  runs: StepLostBody[][];
  /** the colour of any mesh still without one: a piece holding one split solid's faces and nothing else */
  fill: [number, number, number] | null;
}

/** one occt worker's request (STEP text, transferred) and its answers */
export type OcctRequest = { id: number; bytes: Uint8Array; params: OcctParams; hint?: StepColourHint };
export type OcctResponse =
  | { kind: 'reading'; id: number }
  | { kind: 'done'; id: number; parts: StepPart[]; trisIn: number; faces: number }
  | { kind: 'error'; id: number; message: string };

/**
 * CAD aluminium when a STEP body carries no colour. LINEAR, like every colour occt returns: OCCT's
 * `Quantity_Color` holds linear RGB and converts a STEP file's sRGB `COLOUR_RGB` on read (measured:
 * a fixture written as sRGB 0.95/0.55/0.10 comes back 0.89/0.26/0.01).
 */
const DEFAULT_LINEAR: [number, number, number] = [0.48, 0.5, 0.52];

/**
 * The colour of each mesh occt returned with no name and no colour, from the hint (null where it
 * stays unknown). A stretch of such meshes is explained by runs whose face counts match, a mesh
 * left over costing one; a mesh takes a colour only when every best explanation gives it the same
 * one, so two parts with the same face counts and different colours leave it grey, not guessed.
 */
export function lostColours(meshes: OcctResult['meshes'], hint: StepColourHint): ([number, number, number] | null)[] {
  const n = meshes.length;
  const out: ([number, number, number] | null)[] = new Array(n).fill(null);
  const lost = meshes.map((m) => !m.name && !m.color && !(m.brep_faces ?? []).some((f) => f.color));
  const faces = meshes.map((m) => m.brep_faces?.length ?? 0);
  const key = (c: [number, number, number] | null): string => (c ? c.join(',') : '');
  for (let a = 0; a < n; ) {
    if (!lost[a]) {
      a++;
      continue;
    }
    let b = a;
    while (b < n && lost[b]) b++;
    const L = b - a;
    // runs matching at each position of the stretch
    const at: StepLostBody[][][] = Array.from({ length: L }, () => []);
    for (let j = 0; j < L; j++) {
      for (const run of hint.runs) {
        if (!run.length || j + run.length > L) continue;
        let ok = true;
        for (let k = 0; k < run.length && ok; k++) ok = faces[a + j + k] === run[k].faces;
        if (ok) at[j].push(run);
      }
    }
    // fewest meshes left over, from the front (f) and from the back (g)
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
    // what every best explanation says each mesh is
    const says: (Set<string> | null)[] = new Array(L).fill(null);
    const say = (j: number, c: string): void => {
      (says[j] ??= new Set()).add(c);
    };
    const colourOf = new Map<string, [number, number, number]>();
    for (let j = 0; j < L; j++) {
      if (f[j] + 1 + g[j + 1] === f[L]) say(j, '');
      for (const run of at[j]) {
        if (f[j] + g[j + run.length] !== f[L]) continue;
        run.forEach((body, k) => {
          const c = key(body.color);
          if (body.color) colourOf.set(c, body.color);
          say(j + k, c);
        });
      }
    }
    for (let j = 0; j < L; j++) {
      const s = says[j];
      if (s && s.size === 1) {
        const c = colourOf.get([...s][0]);
        if (c) out[a + j] = c;
      }
    }
    a = b;
  }
  if (hint.fill) for (let i = 0; i < n; i++) if (lost[i] && !out[i]) out[i] = hint.fill;
  return out;
}

/**
 * `faces` counts the B-rep faces occt reported. Faces with no triangles is how occt says it ran out
 * of heap: its mesher catches the failure per face and the read still "succeeds" (REV's 125 MB
 * starter bot: 118,734 faces, zero triangles). `hint` gives back the colours occt cannot find
 * (`StepColourHint`); a mesh occt named or coloured is never touched.
 */
export function stepToParts(res: OcctResult, hint?: StepColourHint | null): StepParts {
  if (!res || !res.success) return { kind: 'error', message: 'occt could not read the file' };
  const groups = new Map<string, { color: [number, number, number]; pos: number[]; idx: number[]; name: string; body: number[] }>();
  const found = hint && (hint.runs.length || hint.fill) ? lostColours(res.meshes, hint) : null;
  let trisIn = 0;
  let faces = 0;
  for (let mi = 0; mi < res.meshes.length; mi++) {
    const m = res.meshes[mi];
    const P = m.attributes.position.array;
    const I = m.index.array;
    const nT = Math.floor(I.length / 3);
    trisIn += nT;
    faces += m.brep_faces?.length ?? 0;
    const meshColor = m.color ?? found?.[mi] ?? DEFAULT_LINEAR;
    // triangle → colour, from the B-rep faces when they carry their own
    const triColor: ([number, number, number] | null)[] = new Array(nT).fill(null);
    for (const f of m.brep_faces ?? []) {
      if (!f.color) continue;
      for (let t = f.first; t <= f.last && t < nT; t++) triColor[t] = f.color;
    }
    const local = new Map<string, Map<number, number>>(); // colour key → (source vertex → group vertex)
    for (let t = 0; t < nT; t++) {
      const c = triColor[t] ?? meshColor;
      const key = `${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)}`;
      let g = groups.get(key);
      if (!g) {
        g = { color: [c[0], c[1], c[2]], pos: [], idx: [], name: m.name || 'step', body: [] };
        groups.set(key, g);
      }
      let vm = local.get(key);
      if (!vm) local.set(key, (vm = new Map()));
      for (let k = 0; k < 3; k++) {
        const v = I[3 * t + k];
        let nv = vm.get(v);
        if (nv === undefined) {
          nv = g.pos.length / 3;
          g.pos.push(P[3 * v], P[3 * v + 1], P[3 * v + 2]);
          g.body.push(mi);
          vm.set(v, nv);
        }
        g.idx.push(nv);
      }
    }
  }
  const parts: StepPart[] = [...groups.values()].map((g) => ({
    positions: new Float32Array(g.pos),
    indices: new Uint32Array(g.idx),
    color: g.color,
    name: g.name,
    body: new Uint32Array(g.body),
  }));
  return { kind: 'done', parts, trisIn, faces };
}
