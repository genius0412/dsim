/**
 * STEP files too big for occt, read in PIECES. three-free and DOM-free: the STEP worker runs it, and
 * so does the Node harness.
 *
 * occt-import-js is compiled with a 2 GB wasm heap (`getHeapMax`), and occt's STEP reader keeps the
 * whole entity graph in it: about 16 bytes of heap per byte of file. Measured on REV's 125 MB DECODE
 * starter bot, the heap hit 2 GB, 160,811 allocations failed inside BRepMesh, every one was caught
 * per face, and occt returned 1,334 meshes with ZERO triangles and `success: true`. Nothing errored.
 *
 * So a big file is split before occt sees it. A STEP file is an assembly SKELETON (products,
 * occurrences, placements, colours: about 1 % of the bytes) and the GEOMETRY of each part (solids,
 * shells, faces, curves, points). Each piece is a complete, valid STEP file: the whole skeleton, and
 * the geometry of a share of the parts. The items of the other parts are cut from their shape
 * representations (the lists `ADVANCED_BREP_SHAPE_REPRESENTATION('',(#solid,#axis),#ctx)` name them
 * in), and whatever only pointed at what was cut (a `STYLED_ITEM` on a cut solid or face) is cut
 * with it. occt then places every piece's parts exactly where the whole file would have, because
 * the placements are all in the skeleton every piece carries.
 *
 * Also here: the checks made before any of that (is it STEP, is it complete), the size filter
 * that leaves tiny fasteners out of a huge assembly, and the body colours occt cannot find in an
 * assembly (`colourHint`).
 */
import type { StepColourHint, StepLostBody } from './stepConvert';

/**
 * the bytes one piece may carry of geometry (its skeleton comes on top). 6 MB, was 12 (measured
 * 2026-10-03): a reader's heap peaks at 368 MB instead of 627 (the real kits), so about twice the
 * readers fit the same memory (`poolSize`); the skeleton each piece re-reads costs occt ~0.26 s a
 * piece, 4–6 % of the read.
 */
export const STEP_PIECE_BYTES = 6 * 1024 * 1024;
/** ...and the least: below it the skeleton every piece re-reads (~1.3 MB on a real kit) costs more
 *  than the extra pieces save */
export const STEP_PIECE_MIN_BYTES = 3 * 1024 * 1024;

/**
 * The piece size for a file of `fileBytes` read by up to `pool` readers: about two pieces a reader,
 * between `STEP_PIECE_MIN_BYTES` and `STEP_PIECE_BYTES`. A mid-size file split by the cap alone
 * would keep most readers idle: measured on a 12.6 MB file, 6 MB pieces (2) 7.7 s, 3 MB (6) 4.2 s,
 * read whole 10.0 s.
 */
export function pieceBytesFor(fileBytes: number, pool: number): number {
  const want = Math.floor(fileBytes / (2 * Math.max(1, pool)));
  return Math.max(STEP_PIECE_MIN_BYTES, Math.min(STEP_PIECE_BYTES, want));
}

/**
 * OCCT WORKERS TO RUN AT ONCE. The read is CPU-bound and splits evenly (measured, 2026-10-03, REV's
 * 125 MB STEP: 3 workers 64.6 s, 6 36.0 s, 8 30.5 s, 13 22.6 s, with the occt time summed over the
 * pieces unchanged), so the limit is memory: each worker keeps its heap's high-water mark, 368 MB
 * at 6 MB pieces. Every core but two (the page and the import worker keep theirs); on a device
 * that says it has 8 GB or more (`deviceMemory` stops at 8), six, or eight with 16 cores, which
 * no 8 GB machine has (2.2 / 2.9 GB of occt heap, against the 1.9 GB of three 12 MB readers before);
 * three on 4 GB, two on 2 GB, else one.
 */
export function poolSize(pieces: number, cores: number, memGb: number): number {
  const byMem = memGb >= 8 ? (cores >= 16 ? 8 : 6) : memGb >= 4 ? 3 : memGb >= 2 ? 2 : 1;
  return Math.max(1, Math.min(pieces, byMem, cores - 2));
}

// ---- what a file is, before reading it ------------------------------------------------------

export type StepTextCheck = { ok: true } | { ok: false; reason: 'not-step' | 'truncated' };

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));
const MAGIC = ascii('ISO-10303-21');
const END = ascii('END-ISO-10303-21');

function startsWithAt(buf: Uint8Array, at: number, word: Uint8Array): boolean {
  if (at + word.length > buf.length) return false;
  for (let k = 0; k < word.length; k++) if (buf[at + k] !== word[k]) return false;
  return true;
}

/**
 * Bytes per `String.fromCharCode(...bytes)`: every byte is an argument on the stack, and a worker's
 * stack is small (64 KB of them overflowed Chromium's STEP worker, measured, where Node took them).
 */
const SPREAD = 4096;

/**
 * `bytes` as a string, one char per byte. `fromCharCode.apply` over the typed array, NOT a spread:
 * the spread walks the iterator protocol per byte, and measured on goBILDA's 420 MB STEP it was 70 %
 * of `planPieces`, mostly sizing parts from their points (`pointOf`). The same string, 3.8× faster.
 * At most `SPREAD` bytes a call.
 */
function chars(bytes: Uint8Array): string {
  return String.fromCharCode.apply(null, bytes as unknown as number[]);
}

const isSpace = (c: number): boolean => c === 32 || c === 10 || c === 13 || c === 9 || c === 0 || c === 12;

/**
 * Is this a whole STEP file? It must open with `ISO-10303-21;` and end with `END-ISO-10303-21;`
 * (trailing whitespace allowed). A file that stops partway (a download cut short, or an upstream
 * export that was: goBILDA's DECODE skid-steer STEP ends mid-entity) is `truncated`, which occt
 * would only report as thousands of unresolved references.
 */
export function checkStepText(buf: Uint8Array): StepTextCheck {
  let i = 0;
  // a UTF-8 byte-order mark
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) i = 3;
  while (i < buf.length && isSpace(buf[i])) i++;
  if (!startsWithAt(buf, i, MAGIC)) return { ok: false, reason: 'not-step' };
  let j = buf.length - 1;
  while (j >= 0 && isSpace(buf[j])) j--;
  // the last word, with its semicolon (some writers put a comment after it: allow 4 KB of tail)
  const from = Math.max(0, j - 4096);
  for (let k = j - END.length + 1; k >= from; k--) if (startsWithAt(buf, k, END)) return { ok: true };
  return { ok: false, reason: 'truncated' };
}

// ---- the index: every entity's bytes, type and references ------------------------------------

export interface StepIndex {
  buf: Uint8Array;
  /** where the DATA section's keyword starts: the bytes before it are the header every piece copies */
  dataAt: number;
  count: number;
  /** entity k is bytes [start[k], end[k]) (from its `#` to just after its `;`) */
  start: Uint32Array;
  end: Uint32Array;
  /** interned type name (`typeNames`); `(…)` complex instances are `COMPLEX` */
  type: Uint32Array;
  typeNames: string[];
  /** entity k's references are refs[refStart[k] .. refStart[k + 1]), as entity INDICES (−1 when unresolved) */
  refStart: Uint32Array;
  refs: Int32Array;
  /** per reference: bit 0 set when it is an element of a list (so it can be cut from it); bits 1..7 its paren depth */
  refFlags: Uint8Array;
  /** the largest entity id: a piece numbers the entities it adds after it */
  maxId: number;
}

export const COMPLEX = '(complex)';

export class StepSyntaxError extends Error {
  constructor(
    message: string,
    readonly truncated: boolean,
  ) {
    super(message);
    this.name = 'StepSyntaxError';
  }
}

const C_HASH = 35;
const C_EQ = 61;
const C_LP = 40;
const C_RP = 41;
const C_SEMI = 59;
const C_QUOTE = 39;
const C_SLASH = 47;
const C_STAR = 42;
const C_COMMA = 44;

const isIdent = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95;
const isDigit = (c: number): boolean => c >= 48 && c <= 57;

function growU32(a: Uint32Array, need: number): Uint32Array {
  if (need <= a.length) return a;
  const b = new Uint32Array(Math.max(need, Math.ceil(a.length * 1.6)));
  b.set(a);
  return b;
}
function growI32(a: Int32Array, need: number): Int32Array {
  if (need <= a.length) return a;
  const b = new Int32Array(Math.max(need, Math.ceil(a.length * 1.6)));
  b.set(a);
  return b;
}
function growU8(a: Uint8Array, need: number): Uint8Array {
  if (need <= a.length) return a;
  const b = new Uint8Array(Math.max(need, Math.ceil(a.length * 1.6)));
  b.set(a);
  return b;
}

/** the offset of `DATA;` after the header's `ENDSEC;` */
function findData(buf: Uint8Array): number {
  const n = Math.min(buf.length, 4 << 20);
  let text = '';
  for (let i = 0; i < n; i += SPREAD) text += chars(buf.subarray(i, Math.min(n, i + SPREAD)));
  const m = /ENDSEC\s*;\s*(?:\/\*[\s\S]*?\*\/\s*)*DATA\s*(?:\([^;]*\))?\s*;/.exec(text);
  if (!m) throw new StepSyntaxError('no DATA section', false);
  return m.index + m[0].search(/DATA\s*(?:\([^;]*\))?\s*;$/);
}

/**
 * One pass over the bytes. Strings (`'…'`, with `''` escapes) and comments are skipped; a `(` is a
 * LIST when the byte before it (ignoring whitespace) is `(`, `,` or `=`, and a record or a typed
 * parameter when it is a name. Throws `StepSyntaxError` (`truncated` when the file stops inside an
 * entity, a string or a comment).
 */
export function indexStep(buf: Uint8Array): StepIndex {
  const len = buf.length;
  const dataAt = findData(buf);
  let i = dataAt;
  // past "DATA ... ;"
  while (i < len && buf[i] !== C_SEMI) i++;
  i++;
  let cap = Math.max(1024, Math.ceil(len / 64));
  let start: Uint32Array = new Uint32Array(cap);
  let end: Uint32Array = new Uint32Array(cap);
  let type: Uint32Array = new Uint32Array(cap);
  let ids: Int32Array = new Int32Array(cap);
  let refStart: Uint32Array = new Uint32Array(cap + 1);
  let refCap = cap * 3;
  let refs: Int32Array = new Int32Array(refCap);
  let refFlags: Uint8Array = new Uint8Array(refCap);
  let nRefs = 0;
  let count = 0;
  let maxId = 0;
  const typeNames: string[] = [COMPLEX];
  // type names by a 32-bit FNV hash of their bytes, collisions resolved by comparing the name
  const typeByHash = new Map<number, number[]>();
  const typeBytes: Uint8Array[] = [ascii(COMPLEX)];
  const internType = (a: number, b: number): number => {
    let h = 0x811c9dc5;
    for (let k = a; k < b; k++) h = Math.imul(h ^ buf[k], 0x01000193);
    const list = typeByHash.get(h);
    if (list) {
      for (const t of list) {
        const tb = typeBytes[t];
        if (tb.length !== b - a) continue;
        let same = true;
        for (let k = 0; k < tb.length; k++) {
          if (tb[k] !== buf[a + k]) {
            same = false;
            break;
          }
        }
        if (same) return t;
      }
    }
    const t = typeNames.length;
    typeBytes.push(buf.slice(a, b));
    typeNames.push(chars(buf.subarray(a, b)).toUpperCase());
    if (list) list.push(t);
    else typeByHash.set(h, [t]);
    return t;
  };
  const stack = new Uint8Array(256); // paren kind per depth: 1 list, 2 record / typed parameter
  const truncated = (what: string): never => {
    throw new StepSyntaxError(`the file ends inside ${what}`, true);
  };
  const skipComment = (at: number): number => {
    let k = at + 2;
    while (k + 1 < len && !(buf[k] === C_STAR && buf[k + 1] === C_SLASH)) k++;
    if (k + 1 >= len) truncated('a comment');
    return k + 2;
  };
  let sections = 1;
  outer: while (i < len) {
    const c = buf[i];
    if (isSpace(c)) {
      i++;
      continue;
    }
    if (c === C_SLASH && buf[i + 1] === C_STAR) {
      i = skipComment(i);
      continue;
    }
    if (c === C_HASH) {
      const at = i;
      i++;
      let id = 0;
      while (i < len && isDigit(buf[i])) id = id * 10 + (buf[i++] - 48);
      while (i < len && isSpace(buf[i])) i++;
      if (i >= len) truncated('an entity');
      if (buf[i] !== C_EQ) throw new StepSyntaxError(`expected = after #${id}`, false);
      i++;
      while (i < len && isSpace(buf[i])) i++;
      let t = 0;
      if (buf[i] !== C_LP) {
        const a = i;
        while (i < len && isIdent(buf[i])) i++;
        t = internType(a, i);
      }
      if (count + 1 >= cap) {
        cap = Math.ceil(cap * 1.6);
        start = growU32(start, cap);
        end = growU32(end, cap);
        type = growU32(type, cap);
        ids = growI32(ids, cap);
        refStart = growU32(refStart, cap + 1);
      }
      start[count] = at;
      type[count] = t;
      ids[count] = id;
      refStart[count] = nRefs;
      if (id > maxId) maxId = id;
      let depth = 0;
      // the previous significant byte: the type name for a simple instance, `=` for a complex one
      let last = t === 0 ? C_EQ : 65;
      for (;;) {
        if (i >= len) truncated(`entity #${id}`);
        const b = buf[i];
        if (b === C_QUOTE) {
          i++;
          for (;;) {
            if (i >= len) truncated(`a string in #${id}`);
            if (buf[i] === C_QUOTE) {
              if (buf[i + 1] === C_QUOTE) i += 2;
              else break;
            } else i++;
          }
          i++;
          last = C_QUOTE;
          continue;
        }
        if (b === C_SLASH && buf[i + 1] === C_STAR) {
          i = skipComment(i);
          continue;
        }
        if (b === C_LP) {
          if (depth < 255) stack[depth] = isIdent(last) ? 2 : 1;
          depth++;
          last = b;
          i++;
          continue;
        }
        if (b === C_RP) {
          depth--;
          last = b;
          i++;
          continue;
        }
        if (b === C_HASH) {
          i++;
          let r = 0;
          while (i < len && isDigit(buf[i])) r = r * 10 + (buf[i++] - 48);
          if (nRefs + 1 >= refCap) {
            refCap = Math.ceil(refCap * 1.6);
            refs = growI32(refs, refCap);
            refFlags = growU8(refFlags, refCap);
          }
          refs[nRefs] = r;
          refFlags[nRefs] = ((depth > 0 && depth <= 256 && stack[depth - 1] === 1) ? 1 : 0) | (Math.min(depth, 127) << 1);
          nRefs++;
          last = 48; // a reference reads as a name for the paren rule (it never precedes one)
          continue;
        }
        if (b === C_SEMI && depth <= 0) {
          i++;
          break;
        }
        if (!isSpace(b)) last = b;
        i++;
      }
      end[count] = i;
      count++;
      continue;
    }
    // ENDSEC, then perhaps another DATA section, then END-ISO-10303-21
    if (startsWithAt(buf, i, END)) break;
    if (startsWithAt(buf, i, ascii('ENDSEC'))) {
      i += 6;
      while (i < len && buf[i] !== C_SEMI) i++;
      i++;
      while (i < len && isSpace(buf[i])) i++;
      if (startsWithAt(buf, i, ascii('DATA'))) {
        sections++;
        while (i < len && buf[i] !== C_SEMI) i++;
        i++;
        continue outer;
      }
      continue;
    }
    throw new StepSyntaxError(`unexpected text at byte ${i}`, false);
  }
  void sections;
  refStart[count] = nRefs;
  // ids → indices
  const resolve = maxId < 1 << 26 ? new Int32Array(maxId + 1).fill(-1) : null;
  const resolveMap = resolve ? null : new Map<number, number>();
  for (let k = 0; k < count; k++) {
    if (resolve) resolve[ids[k]] = k;
    else resolveMap!.set(ids[k], k);
  }
  for (let r = 0; r < nRefs; r++) {
    const id = refs[r];
    refs[r] = resolve ? (id <= maxId ? resolve[id] : -1) : (resolveMap!.get(id) ?? -1);
  }
  return {
    buf,
    dataAt,
    count,
    start: start.subarray(0, count),
    end: end.subarray(0, count),
    type: type.subarray(0, count),
    typeNames,
    refStart: refStart.subarray(0, count + 1),
    refs: refs.subarray(0, nRefs),
    refFlags: refFlags.subarray(0, nRefs),
    maxId,
  };
}

// ---- the plan: which geometry goes in which piece ---------------------------------------------

/** representation items that are structure, not geometry: they stay in every piece */
const STRUCTURAL_ITEMS = new Set(['AXIS2_PLACEMENT_3D', 'AXIS2_PLACEMENT_2D', 'AXIS1_PLACEMENT', 'MAPPED_ITEM', 'CARTESIAN_POINT', 'DIRECTION']);

/** entities that only DECORATE what they point at (a colour, a layer, a usage): cut with their target */
const DECORATIONS = new Set([
  'STYLED_ITEM',
  'OVER_RIDING_STYLED_ITEM',
  'CONTEXT_DEPENDENT_OVER_RIDING_STYLED_ITEM',
  'GEOMETRIC_ITEM_SPECIFIC_USAGE',
  'ANNOTATION_OCCURRENCE',
  'ANNOTATION_PLANE',
  'DRAUGHTING_MODEL_ITEM_ASSOCIATION',
]);

const isShapeRepName = (name: string): boolean => name.endsWith('SHAPE_REPRESENTATION') && name !== 'CONTEXT_DEPENDENT_SHAPE_REPRESENTATION';

export interface StepRoot {
  /** entity index of the representation item (a solid, a shell model, a curve set …) */
  entity: number;
  /** entity index of the shape representation listing it */
  rep: number;
  /** bytes of the item and everything it references */
  bytes: number;
  /** its bounding-box diagonal in millimetres (null when its unit is unknown or it was not measured) */
  sizeMm: number | null;
  /** the `STYLED_ITEM` that colours it, or −1 */
  style: number;
}

/** what a piece carries: a whole root, or ONE FACE of a root too big for a piece */
export interface StepUnit {
  /** ordinal into `roots` */
  root: number;
  /** the face's entity index, or −1 for the whole root */
  face: number;
  bytes: number;
}

export interface StepPlan {
  roots: StepRoot[];
  units: StepUnit[];
  /** unit ordinals per piece */
  pieces: number[][];
  /** roots left out by the size filter */
  skipped: number[];
  /** per root ordinal split into faces: the solid and its shells (kept, their face lists cut) */
  carriers: Map<number, number[]>;
  /**
   * per split root ordinal: the styled items that colour the solid, and the presentation that
   * lists each. A piece gives each of its faces a copy (see `pieceText`).
   */
  splitStyles: Map<number, { item: number; holder: number }[]>;
  /** the geometry bytes kept, and the skeleton every piece carries */
  geometryBytes: number;
  skeletonBytes: number;
  /** per entity: 1 when it is reachable from a root (geometry) */
  inGeometry: Uint8Array;
  /** per entity: 1 when it is a root */
  isRoot: Uint8Array;
  /** per entity: 1 when it is a shape representation (whose list items may be cut) */
  isShapeRep: Uint8Array;
  /** the entities outside the geometry, in file order */
  skeleton: Int32Array;
  /** per entity: 1 for geometry the skeleton names directly (a point or direction shared with a placement) */
  alwaysKeep: Uint8Array;
  /** per type: 1 for a decoration */
  decorationType: Uint8Array;
}

export interface PlanOptions {
  pieceBytes?: number;
  /** leave out parts whose bounding-box diagonal is under this many millimetres (0: keep all) */
  minPartMm?: number;
}

/** the closure of `from` (it and everything it references), stamped `stamp` in `seen` */
function closure(ix: StepIndex, from: number, seen: Int32Array, stamp: number, out: number[] | null, stack: number[]): number {
  let bytes = 0;
  stack.length = 0;
  if (seen[from] === stamp) return 0;
  seen[from] = stamp;
  stack.push(from);
  while (stack.length) {
    const e = stack.pop()!;
    bytes += ix.end[e] - ix.start[e];
    if (out) out.push(e);
    for (let r = ix.refStart[e]; r < ix.refStart[e + 1]; r++) {
      const t = ix.refs[r];
      if (t >= 0 && seen[t] !== stamp) {
        seen[t] = stamp;
        stack.push(t);
      }
    }
  }
  return bytes;
}

/** the text of entity `e` (latin1: STEP is 7-bit, with `\X2\` escapes for anything else) */
export function entityText(ix: StepIndex, e: number): string {
  return latin1(ix.buf.subarray(ix.start[e], ix.end[e]));
}

/** bytes as a latin1 string, `SPREAD` bytes at a time */
function latin1(bytes: Uint8Array): string {
  let s = '';
  for (let k = 0; k < bytes.length; k += SPREAD) s += chars(bytes.subarray(k, Math.min(bytes.length, k + SPREAD)));
  return s;
}

/** millimetres per unit of a length-unit entity, or null */
function unitMm(ix: StepIndex, e: number): number | null {
  const t = entityText(ix, e).toUpperCase().replace(/\s+/g, '');
  if (/CONVERSION_BASED_UNIT\('INCH'/.test(t)) return 25.4;
  if (/CONVERSION_BASED_UNIT\('(FOOT|FEET)'/.test(t)) return 304.8;
  const si = /SI_UNIT\((\.[A-Z]+\.|\$|\*),\.METRE\.\)/.exec(t);
  if (si) return ({ '.MILLI.': 1, '.CENTI.': 10, '.DECI.': 100, $: 1000, '*': 1000, '.KILO.': 1e6, '.MICRO.': 1e-3 } as Record<string, number>)[si[1]] ?? null;
  return null;
}

/** the length unit (mm per unit) of a representation's context, or null */
function repUnitMm(ix: StepIndex, rep: number, cache: Map<number, number | null>): number | null {
  // the context is the representation's last direct reference
  let ctx = -1;
  for (let r = ix.refStart[rep]; r < ix.refStart[rep + 1]; r++) if (!(ix.refFlags[r] & 1)) ctx = ix.refs[r];
  if (ctx < 0) return null;
  const hit = cache.get(ctx);
  if (hit !== undefined) return hit;
  let mm: number | null = null;
  for (let r = ix.refStart[ctx]; r < ix.refStart[ctx + 1] && mm === null; r++) {
    const u = ix.refs[r];
    if (u < 0) continue;
    const name = ix.typeNames[ix.type[u]];
    if (name === COMPLEX || name.includes('UNIT')) {
      const t = entityText(ix, u).toUpperCase();
      if (t.includes('LENGTH_UNIT') || /CONVERSION_BASED_UNIT\('(INCH|FOOT|FEET)'/.test(t.replace(/\s+/g, ''))) mm = unitMm(ix, u);
    }
  }
  cache.set(ctx, mm);
  return mm;
}

/** the numbers of a CARTESIAN_POINT('name',(x,y,z)): those after its last '(' */
function pointOf(ix: StepIndex, e: number, out: number[]): boolean {
  const buf = ix.buf;
  let k = ix.end[e] - 1;
  while (k > ix.start[e] && buf[k] !== C_LP) k--;
  out[0] = out[1] = out[2] = 0;
  let n = 0;
  let a = k + 1;
  for (let j = k + 1; j < ix.end[e] && n < 3; j++) {
    const c = buf[j];
    if (c === C_COMMA || c === C_RP) {
      out[n++] = parseFloat(chars(buf.subarray(a, j)));
      a = j + 1;
      if (c === C_RP) break;
    }
  }
  return n >= 2 && Number.isFinite(out[0]) && Number.isFinite(out[1]) && Number.isFinite(out[2]);
}

/** a circle's radius, or an ellipse's larger semi-axis: the numbers after its placement */
function radiusOf(ix: StepIndex, e: number): number {
  const m = /#\d+\s*,([^)]*)\)\s*;\s*$/.exec(entityText(ix, e));
  if (!m) return NaN;
  return Math.max(...m[1].split(',').map((s) => Math.abs(parseFloat(s))));
}

interface SizeTypes {
  cartesian: number;
  vertex: number;
  edge: number;
  circle: number;
  ellipse: number;
  spline: Uint8Array;
}

/**
 * The bounding-box diagonal of a root's geometry, in file units, from the points that lie ON it:
 * B-rep vertices, B-spline control points (which bound their curve or surface) and, for an edge
 * that is a WHOLE circle (one vertex, start = end), its centre ± its radius. Left out: the
 * placements of planes, cylinders and cones, whose origins can sit anywhere along the surface's
 * axis, and the circles under arcs, whose centres can be far away (measured on REV's starter bot:
 * 1,476 arcs of a 2.27 m circle on one 40 cm part). An arc's ends are vertices, which count. When
 * none of these is found, every point counts.
 */
function rootDiagonal(ix: StepIndex, ents: number[], ty: SizeTypes): number | null {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const p = [0, 0, 0];
  let any = false;
  const add = (x: number, y: number, z: number, r: number): void => {
    any = true;
    if (x - r < lo[0]) lo[0] = x - r;
    if (y - r < lo[1]) lo[1] = y - r;
    if (z - r < lo[2]) lo[2] = z - r;
    if (x + r > hi[0]) hi[0] = x + r;
    if (y + r > hi[1]) hi[1] = y + r;
    if (z + r > hi[2]) hi[2] = z + r;
  };
  const addPoint = (pt: number, r: number): void => {
    if (pt >= 0 && ix.type[pt] === ty.cartesian && pointOf(ix, pt, p)) add(p[0], p[1], p[2], r);
  };
  for (const e of ents) {
    const t = ix.type[e];
    const a = ix.refStart[e];
    const b = ix.refStart[e + 1];
    if (t === ty.vertex) {
      for (let r = a; r < b; r++) addPoint(ix.refs[r], 0);
    } else if (t === ty.edge && b - a >= 3 && ix.refs[a] === ix.refs[a + 1]) {
      // EDGE_CURVE('', #v, #v, #curve, .T.): a closed edge; a whole circle counts as centre ± radius
      const c = ix.refs[a + 2];
      if (c < 0 || (ix.type[c] !== ty.circle && ix.type[c] !== ty.ellipse) || ix.refStart[c + 1] === ix.refStart[c]) continue;
      // CIRCLE('', #axis, r): the axis placement's first reference is its location
      const axis = ix.refs[ix.refStart[c]];
      const rad = radiusOf(ix, c);
      if (axis >= 0 && ix.refStart[axis + 1] > ix.refStart[axis] && Number.isFinite(rad)) addPoint(ix.refs[ix.refStart[axis]], rad);
    } else if (ty.spline[t]) {
      for (let r = a; r < b; r++) if (ix.refFlags[r] & 1) addPoint(ix.refs[r], 0);
    }
  }
  if (!any) for (const e of ents) addPoint(e, 0);
  return any ? Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) : null;
}

/** what a root is made of: the shells under a solid and the faces they list */
function shellsAndFaces(ix: StepIndex, root: number): { carriers: number[]; faces: number[] } | null {
  const carriers = [root];
  const faces: number[] = [];
  const name = (e: number): string => ix.typeNames[ix.type[e]];
  const shells: number[] = [];
  for (let r = ix.refStart[root]; r < ix.refStart[root + 1]; r++) {
    let s = ix.refs[r];
    if (s < 0) continue;
    if (name(s) === 'ORIENTED_CLOSED_SHELL' || name(s) === 'ORIENTED_OPEN_SHELL') {
      carriers.push(s);
      // ORIENTED_CLOSED_SHELL('', *, #shell, .T.)
      let inner = -1;
      for (let q = ix.refStart[s]; q < ix.refStart[s + 1]; q++) inner = ix.refs[q];
      s = inner;
      if (s < 0) continue;
    }
    if (name(s) === 'CLOSED_SHELL' || name(s) === 'OPEN_SHELL') shells.push(s);
  }
  for (const s of shells) {
    carriers.push(s);
    for (let r = ix.refStart[s]; r < ix.refStart[s + 1]; r++) {
      const f = ix.refs[r];
      if (f >= 0 && ix.refFlags[r] & 1 && /FACE$/.test(name(f))) faces.push(f);
    }
  }
  return faces.length >= 2 ? { carriers, faces } : null;
}

/**
 * Find the roots (every non-structural item of every shape representation), measure each one's
 * closure, drop the ones under `minPartMm`, and pack the rest into pieces of about `pieceBytes`,
 * in file order. A root bigger than half a piece is split into its FACES (a 99 MB goBILDA body
 * of 3,520 faces would otherwise be one piece, and too big for occt on its own): each piece then
 * carries the solid and its shell with only its own faces listed.
 */
export function planPieces(ix: StepIndex, opts: PlanOptions = {}): StepPlan {
  const pieceBytes = opts.pieceBytes ?? STEP_PIECE_BYTES;
  const minPartMm = opts.minPartMm ?? 0;
  const n = ix.count;
  const isShapeRep = new Uint8Array(n);
  const isRoot = new Uint8Array(n);
  const repOf = new Int32Array(n).fill(-1);
  const typeIs = (pred: (name: string) => boolean): Uint8Array => {
    const out = new Uint8Array(ix.typeNames.length);
    ix.typeNames.forEach((name, t) => {
      if (pred(name)) out[t] = 1;
    });
    return out;
  };
  const shapeRepType = typeIs(isShapeRepName);
  const structuralType = typeIs((name) => STRUCTURAL_ITEMS.has(name));
  const complexT = 0;
  const rootList: number[] = [];
  for (let e = 0; e < n; e++) {
    const t = ix.type[e];
    let rep = shapeRepType[t] === 1;
    if (!rep && t === complexT) {
      // a complex instance that is a shape representation, e.g. (REPRESENTATION(…)SHAPE_REPRESENTATION())
      const text = entityText(ix, e);
      rep = /SHAPE_REPRESENTATION\s*\(/.test(text) && !/CONTEXT_DEPENDENT_SHAPE_REPRESENTATION/.test(text) && /\bREPRESENTATION\s*\(/.test(text);
    }
    if (!rep) continue;
    isShapeRep[e] = 1;
    const itemDepth = t === complexT ? 3 : 2;
    for (let r = ix.refStart[e]; r < ix.refStart[e + 1]; r++) {
      if (!(ix.refFlags[r] & 1) || ix.refFlags[r] >> 1 !== itemDepth) continue;
      const item = ix.refs[r];
      if (item < 0 || structuralType[ix.type[item]]) continue;
      if (!isRoot[item]) {
        isRoot[item] = 1;
        rootList.push(item);
        repOf[item] = e;
      }
    }
  }
  rootList.sort((a, b) => a - b);
  const seen = new Int32Array(n);
  let stamp = 0;
  const stack: number[] = [];
  const inGeometry = new Uint8Array(n);
  const sizeTypes: SizeTypes = {
    cartesian: ix.typeNames.indexOf('CARTESIAN_POINT'),
    vertex: ix.typeNames.indexOf('VERTEX_POINT'),
    edge: ix.typeNames.indexOf('EDGE_CURVE'),
    circle: ix.typeNames.indexOf('CIRCLE'),
    ellipse: ix.typeNames.indexOf('ELLIPSE'),
    spline: typeIs((name) => name === COMPLEX || /^(B_SPLINE|BEZIER|QUASI_UNIFORM|UNIFORM|RATIONAL_B_SPLINE)_(CURVE|SURFACE)/.test(name)),
  };
  const unitCache = new Map<number, number | null>();
  const roots: StepRoot[] = [];
  const ents: number[] = [];
  for (const e of rootList) {
    ents.length = 0;
    const bytes = closure(ix, e, seen, ++stamp, ents, stack);
    for (const x of ents) inGeometry[x] = 1;
    let sizeMm: number | null = null;
    if (minPartMm > 0) {
      const mm = repUnitMm(ix, repOf[e], unitCache);
      const d = mm !== null ? rootDiagonal(ix, ents, sizeTypes) : null;
      sizeMm = mm !== null && d !== null ? d * mm : null;
    }
    roots.push({ entity: e, rep: repOf[e], bytes, sizeMm, style: -1 });
  }
  const skipped: number[] = [];
  const units: StepUnit[] = [];
  const carriers = new Map<number, number[]>();
  let total = 0;
  roots.forEach((r, k) => {
    if (minPartMm > 0 && r.sizeMm !== null && r.sizeMm < minPartMm) {
      skipped.push(k);
      return;
    }
    total += r.bytes;
    const split = r.bytes > pieceBytes / 2 ? shellsAndFaces(ix, r.entity) : null;
    if (!split) {
      units.push({ root: k, face: -1, bytes: r.bytes });
      return;
    }
    carriers.set(k, split.carriers);
    for (const f of split.faces) units.push({ root: k, face: f, bytes: closure(ix, f, seen, ++stamp, null, stack) });
  });
  // next fit, in file order: a solid's faces stay together, so the edges they share mostly do too.
  // A split solid's faces get pieces of their own: occt colours none of the shells it makes of them
  // in an assembly, and a piece holding nothing else can give them all the solid's colour (`colourHint`)
  const pieces: number[][] = [];
  let fill = Infinity;
  let holds = -2; // the split root whose faces the current piece holds, −1 for whole roots
  units.forEach((u, k) => {
    const kind = u.face >= 0 ? u.root : -1;
    if ((fill + u.bytes > pieceBytes && fill > 0) || kind !== holds) {
      pieces.push([]);
      fill = 0;
      holds = kind;
    }
    pieces[pieces.length - 1].push(k);
    fill += u.bytes;
  });
  let skeletonBytes = 0;
  let nSkel = 0;
  for (let e = 0; e < n; e++) if (!inGeometry[e]) nSkel++;
  const skeleton = new Int32Array(nSkel);
  nSkel = 0;
  for (let e = 0; e < n; e++) {
    if (inGeometry[e]) continue;
    skeleton[nSkel++] = e;
    skeletonBytes += ix.end[e] - ix.start[e];
  }
  const decorationType = typeIs((name) => DECORATIONS.has(name));
  // geometry the skeleton names DIRECTLY (not in a list) and not as a decoration: every piece keeps it
  const alwaysKeep = new Uint8Array(n);
  ++stamp;
  for (const e of skeleton) {
    if (decorationType[ix.type[e]]) continue;
    for (let r = ix.refStart[e]; r < ix.refStart[e + 1]; r++) {
      const t = ix.refs[r];
      if (t < 0 || !inGeometry[t] || alwaysKeep[t] || ix.refFlags[r] & 1) continue;
      ents.length = 0;
      closure(ix, t, seen, stamp, ents, stack);
      for (const x of ents) alwaysKeep[x] = 1;
    }
  }
  // the styled item on each root, for the colours occt cannot find (`colourHint`)
  const styledType = ix.typeNames.indexOf('STYLED_ITEM');
  if (styledType >= 0) {
    const ordOf = new Map<number, number>();
    roots.forEach((r, k) => ordOf.set(r.entity, k));
    for (const e of skeleton) {
      if (ix.type[e] !== styledType) continue;
      for (let r = ix.refStart[e]; r < ix.refStart[e + 1]; r++) {
        if (ix.refFlags[r] & 1) continue;
        const k = ordOf.get(ix.refs[r]);
        if (k !== undefined && roots[k].style < 0) roots[k].style = e;
      }
    }
  }
  // the styles on each split solid, and the presentation (MDGPR) listing each style
  const splitStyles = new Map<number, { item: number; holder: number }[]>();
  if (carriers.size) {
    const splitOf = new Map<number, number>();
    for (const k of carriers.keys()) splitOf.set(roots[k].entity, k);
    const holderOf = new Map<number, number>();
    const styled: { item: number; root: number }[] = [];
    for (const e of skeleton) {
      for (let r = ix.refStart[e]; r < ix.refStart[e + 1]; r++) {
        const t = ix.refs[r];
        if (t < 0) continue;
        if (ix.refFlags[r] & 1) {
          if (!holderOf.has(t)) holderOf.set(t, e);
        } else if (decorationType[ix.type[e]] && splitOf.has(t)) styled.push({ item: e, root: splitOf.get(t)! });
      }
    }
    for (const { item, root } of styled) {
      const holder = holderOf.get(item);
      if (holder === undefined) continue;
      const list = splitStyles.get(root) ?? [];
      list.push({ item, holder });
      splitStyles.set(root, list);
    }
  }
  return { roots, units, pieces, skipped, carriers, splitStyles, geometryBytes: total, skeletonBytes, inGeometry, isRoot, isShapeRep, skeleton, alwaysKeep, decorationType };
}

// ---- one piece as a STEP file ----------------------------------------------------------------

/**
 * Piece `p` of `plan` as a complete STEP file: the header, every skeleton entity (rewritten where a
 * list named a cut item), the geometry of this piece's units, and the closing lines. The rules:
 *
 * - a shape representation keeps the roots this piece carries (whole or some of their faces) and
 *   its structural items; a split root's solid and shells are kept with only this piece's faces;
 * - geometry that nothing kept reaches is left out, unless the skeleton points at it directly (a
 *   point or direction shared with a placement), which keeps it;
 * - an entity that names something left out IN A LIST loses that element; one that names it
 *   DIRECTLY is left out too when it is a decoration (a styled item, a usage), and that repeats until
 *   nothing changes (an over-riding style on a cut style goes, and the presentation lists lose both).
 */
export function pieceText(ix: StepIndex, plan: StepPlan, p: number): Uint8Array {
  const n = ix.count;
  const KEEP = 1;
  const DROP = 2;
  const mark = new Uint8Array(n);
  const seen = new Int32Array(n);
  const stack: number[] = [];
  const ents: number[] = [];
  const inPiece = new Uint8Array(n);
  const carrying: number[] = [];
  const facesOf = new Map<number, number[]>();
  for (const u of plan.pieces[p]) {
    const unit = plan.units[u];
    const root = plan.roots[unit.root].entity;
    inPiece[root] = 1;
    ents.length = 0;
    closure(ix, unit.face < 0 ? root : unit.face, seen, 1, ents, stack);
    for (const e of ents) mark[e] = KEEP;
    if (unit.face >= 0) {
      const list = facesOf.get(unit.root) ?? [];
      list.push(unit.face);
      facesOf.set(unit.root, list);
      for (const c of plan.carriers.get(unit.root) ?? []) {
        if (mark[c] !== KEEP) carrying.push(c);
        mark[c] = KEEP;
      }
    }
  }
  // geometry the skeleton names directly is kept; the rest that nothing kept reaches is dropped
  for (let e = 0; e < n; e++) if (plan.inGeometry[e] && mark[e] !== KEEP) mark[e] = plan.alwaysKeep[e] ? KEEP : DROP;
  const cut = new Uint8Array(ix.refs.length); // list elements to leave out
  // a split solid's shells list only this piece's faces
  for (const c of carrying) {
    for (let r = ix.refStart[c]; r < ix.refStart[c + 1]; r++) {
      const t = ix.refs[r];
      if (t >= 0 && ix.refFlags[r] & 1 && mark[t] === DROP) cut[r] = 1;
    }
  }
  // then what named the rest: cut from lists, and decorations left out, until nothing changes
  const decoT = plan.decorationType;
  for (let changed = true; changed; ) {
    changed = false;
    for (const e of plan.skeleton) {
      if (mark[e] !== 0) continue;
      for (let r = ix.refStart[e]; r < ix.refStart[e + 1]; r++) {
        const t = ix.refs[r];
        if (t < 0 || cut[r]) continue;
        const gone = mark[t] === DROP || (plan.isShapeRep[e] && plan.isRoot[t] && !inPiece[t]);
        if (!gone) continue;
        if (ix.refFlags[r] & 1) cut[r] = 1;
        else if (decoT[ix.type[e]] || mark[t] === DROP) {
          mark[e] = DROP;
          changed = true;
          break;
        }
      }
    }
  }
  // write it
  const head = ix.buf.subarray(0, ix.dataAt);
  const parts: Uint8Array[] = [head, ascii('DATA;\n')];
  let total = head.length + 6;
  const nl = ascii('\n');
  const isCarrier = new Uint8Array(n);
  for (const c of carrying) isCarrier[c] = 1;
  for (let e = 0; e < n; e++) {
    if (mark[e] === DROP) continue;
    if (plan.inGeometry[e] && mark[e] !== KEEP) continue;
    let rewrite = false;
    for (let r = ix.refStart[e]; r < ix.refStart[e + 1]; r++) if (cut[r]) rewrite = true;
    let bytes = rewrite ? rewriteWithout(ix, e, cut) : ix.buf.subarray(ix.start[e], ix.end[e]);
    if (isCarrier[e]) bytes = openUp(bytes);
    parts.push(bytes, nl);
    total += bytes.length + 1;
  }
  // a split solid's colour, face by face. occt heals a shell whose faces no longer touch into
  // several new shells, and a new shell is not the solid the colour was given to (measured: the
  // fixture's right rail, cut to two faces, came back aluminium). A face keeps its identity, so
  // each one gets a copy of the solid's styled item, listed in a presentation of its own.
  let nextId = ix.maxId + 1;
  const idOf = (e: number): string => /^#(\d+)/.exec(latin1(ix.buf.subarray(ix.start[e], Math.min(ix.end[e], ix.start[e] + 16))))![1];
  for (const [rootOrd, faces] of facesOf) {
    const styles = plan.splitStyles.get(rootOrd);
    if (!styles) continue;
    const rootId = idOf(plan.roots[rootOrd].entity);
    const byHolder = new Map<number, string[]>();
    for (const { item, holder } of styles) {
      if (mark[item] === DROP || mark[holder] === DROP) continue;
      const text = entityText(ix, item);
      const tail = new RegExp(`,\\s*#${rootId}\\s*\\)\\s*;\\s*$`);
      if (!tail.test(text)) continue;
      const ids = byHolder.get(holder) ?? [];
      for (const f of faces) {
        const id = nextId++;
        const line = ascii(text.replace(/^#\d+/, `#${id}`).replace(tail, `,#${idOf(f)});`) + '\n');
        parts.push(line);
        total += line.length;
        ids.push(`#${id}`);
      }
      byHolder.set(holder, ids);
    }
    for (const [holder, ids] of byHolder) {
      const type = ix.typeNames[ix.type[holder]];
      let ctx = -1;
      for (let r = ix.refStart[holder]; r < ix.refStart[holder + 1]; r++) if (!(ix.refFlags[r] & 1)) ctx = ix.refs[r];
      if (type === COMPLEX || ctx < 0 || !ids.length) continue;
      const line = ascii(`#${nextId++}=${type}('',(${ids.join(',')}),#${idOf(ctx)});\n`);
      parts.push(line);
      total += line.length;
    }
  }
  const tail = ascii('ENDSEC;\nEND-ISO-10303-21;\n');
  parts.push(tail);
  total += tail.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const b of parts) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

/**
 * A split solid's carrier as SURFACES: the solid becomes a `SHELL_BASED_SURFACE_MODEL` and its
 * shell an `OPEN_SHELL`, keeping their ids, so the styled item on the solid still names it. Left a
 * solid with a closed shell missing most of its faces, occt's shape healing rebuilds it into a new
 * shape that the colour no longer finds (measured: the fixture's rails came back aluminium instead of
 * their own dark grey). A void's shell is left out: a cavity draws nothing seen from outside.
 */
function openUp(bytes: Uint8Array): Uint8Array {
  const text = latin1(bytes);
  let m = /^(#\d+\s*=\s*)CLOSED_SHELL(\s*\()/.exec(text);
  if (m) return ascii(text.replace(/^(#\d+\s*=\s*)CLOSED_SHELL/, '$1OPEN_SHELL'));
  m = /^(#\d+\s*=\s*)(?:MANIFOLD_SOLID_BREP|BREP_WITH_VOIDS)\s*\(([\s\S]*?),\s*(#\d+)\s*(?:,\s*\([^()]*\))?\s*\)\s*;\s*$/.exec(text);
  if (m) return ascii(`${m[1]}SHELL_BASED_SURFACE_MODEL(${m[2]},(${m[3]}));`);
  return bytes;
}

/** entity `e`'s text without the list elements marked in `cut`, commas mended */
function rewriteWithout(ix: StepIndex, e: number, cut: Uint8Array): Uint8Array {
  const buf = ix.buf;
  const out: number[] = [];
  // per open paren: how many elements it has written, and whether a comma is owed before the next
  const written: number[] = [];
  let pendingComma = false;
  let r = ix.refStart[e];
  let i = ix.start[e];
  const stop = ix.end[e];
  // the "#id=" head is copied as it is
  while (buf[i] !== C_EQ) out.push(buf[i++]);
  out.push(buf[i++]);
  const startElement = (): void => {
    if (pendingComma) out.push(C_COMMA);
    pendingComma = false;
    if (written.length) written[written.length - 1]++;
  };
  let inElement = false;
  while (i < stop) {
    const b = buf[i];
    if (b === C_QUOTE) {
      if (!inElement) {
        startElement();
        inElement = true;
      }
      out.push(b);
      i++;
      for (;;) {
        if (buf[i] === C_QUOTE) {
          if (buf[i + 1] === C_QUOTE) {
            out.push(C_QUOTE, C_QUOTE);
            i += 2;
            continue;
          }
          break;
        }
        out.push(buf[i++]);
      }
      out.push(buf[i++]);
      continue;
    }
    if (b === C_SLASH && buf[i + 1] === C_STAR) {
      i += 2;
      while (!(buf[i] === C_STAR && buf[i + 1] === C_SLASH)) i++;
      i += 2;
      continue;
    }
    if (isSpace(b)) {
      i++;
      continue;
    }
    if (b === C_HASH) {
      const drop = cut[r] === 1;
      r++;
      let j = i + 1;
      while (j < stop && isDigit(buf[j])) j++;
      if (!drop) {
        if (!inElement) {
          startElement();
          inElement = true;
        }
        for (let k = i; k < j; k++) out.push(buf[k]);
      }
      i = j;
      continue;
    }
    if (b === C_COMMA) {
      if (written.length && written[written.length - 1] > 0) pendingComma = true;
      inElement = false;
      i++;
      continue;
    }
    if (b === C_LP) {
      if (!inElement) startElement();
      out.push(b);
      written.push(0);
      pendingComma = false;
      inElement = false;
      i++;
      continue;
    }
    if (b === C_RP) {
      written.pop();
      pendingComma = false;
      out.push(b);
      inElement = true;
      i++;
      continue;
    }
    if (b === C_SEMI) {
      out.push(b);
      i++;
      break;
    }
    if (!inElement) {
      startElement();
      inElement = true;
    }
    out.push(b);
    i++;
  }
  return Uint8Array.from(out);
}

// ---- the colours occt cannot find ------------------------------------------------------------

/** what occt meshes of a root: one mesh per solid (its faces, voids' included), then one per shell of a surface model */
function bodyMeshes(ix: StepIndex, e: number): { solids: number[]; shells: number[] } | null {
  const name = (x: number): string => ix.typeNames[ix.type[x]];
  // the faces a shell lists (through an ORIENTED_CLOSED_SHELL('', *, #shell, .T.)), or −1
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

const PREDEFINED: Record<string, [number, number, number]> = {
  red: [1, 0, 0],
  green: [0, 1, 0],
  blue: [0, 0, 1],
  yellow: [1, 1, 0],
  magenta: [1, 0, 1],
  cyan: [0, 1, 1],
  black: [0, 0, 0],
  white: [1, 1, 1],
};

/** sRGB → linear as occt converts a `COLOUR_RGB` (`Quantity_Color`, which keeps floats) */
const toLinear = (v: number): number => Math.fround(v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

/** the colour a style gives a surface: under a surface style first, a fill before a rendering; linear */
function styleColour(ix: StepIndex, e: number, depth = 0): [number, number, number] | null {
  const t = ix.typeNames[ix.type[e]];
  if (t === 'COLOUR_RGB') {
    const m = /,\s*([-+.\dEe]+)\s*,\s*([-+.\dEe]+)\s*,\s*([-+.\dEe]+)\s*\)\s*;\s*$/.exec(entityText(ix, e));
    if (!m) return null;
    let rgb = [m[1], m[2], m[3]].map(Number);
    if (rgb.some((v) => !Number.isFinite(v) || v < 0)) return null;
    // occt scales a colour written 0..255 (any component over 1) by its largest
    const top = Math.max(...rgb);
    if (top > 1) rgb = rgb.map((v) => v / top);
    return [toLinear(rgb[0]), toLinear(rgb[1]), toLinear(rgb[2])];
  }
  if (t === 'DRAUGHTING_PRE_DEFINED_COLOUR' || t === 'PRE_DEFINED_COLOUR') {
    const m = /\(\s*'([^']*)'/.exec(entityText(ix, e));
    const c = m ? PREDEFINED[m[1].trim().toLowerCase()] : undefined;
    return c ? [c[0], c[1], c[2]] : null;
  }
  if (depth > 8) return null;
  const rank = (x: number): number => {
    const n = ix.typeNames[ix.type[x]];
    return n === 'SURFACE_STYLE_USAGE' || n === 'SURFACE_STYLE_FILL_AREA' ? 0 : n === 'CURVE_STYLE' ? 2 : 1;
  };
  const refs: number[] = [];
  // a styled item's target (its one reference outside a list) is not a style
  for (let r = ix.refStart[e]; r < ix.refStart[e + 1]; r++) if (ix.refs[r] >= 0 && (depth > 0 || ix.refFlags[r] & 1)) refs.push(ix.refs[r]);
  refs.sort((a, b) => rank(a) - rank(b));
  for (const x of refs) {
    const c = styleColour(ix, x, depth + 1);
    if (c) return c;
  }
  return null;
}

/**
 * The colours occt will not find in a read of `units` (`StepColourHint`, `stepConvert.ts`): every
 * shape representation that makes a part of more than one body here gives its bodies' face counts
 * and styled colours in list order, solids and shells as two runs; and a read of one split solid's
 * faces and nothing else gives that solid's colour to every mesh occt leaves grey.
 */
export function colourHint(ix: StepIndex, plan: StepPlan, units: readonly number[]): StepColourHint {
  const whole = new Map<number, number>(); // root entity → ordinal
  const split = new Set<number>();
  for (const u of units) {
    const unit = plan.units[u];
    if (unit.face < 0) whole.set(plan.roots[unit.root].entity, unit.root);
    else split.add(unit.root);
  }
  const cache = new Map<number, [number, number, number] | null>();
  const colour = (ord: number): [number, number, number] | null => {
    const s = plan.roots[ord].style;
    if (s < 0) return null;
    if (!cache.has(s)) cache.set(s, styleColour(ix, s));
    return cache.get(s)!;
  };
  const runs: StepLostBody[][] = [];
  const reps = new Set<number>();
  for (const ord of whole.values()) if (plan.roots[ord].rep >= 0) reps.add(plan.roots[ord].rep);
  for (const rep of reps) {
    const solids: StepLostBody[] = [];
    const shells: StepLostBody[] = [];
    const seen = new Set<number>();
    let known = true;
    for (let r = ix.refStart[rep]; r < ix.refStart[rep + 1] && known; r++) {
      const ord = ix.refFlags[r] & 1 ? whole.get(ix.refs[r]) : undefined;
      if (ord === undefined || seen.has(ord)) continue;
      seen.add(ord);
      const m = bodyMeshes(ix, plan.roots[ord].entity);
      if (!m) known = false;
      else {
        const c = colour(ord);
        for (const faces of m.solids) solids.push({ faces, color: c });
        for (const faces of m.shells) shells.push({ faces, color: c });
      }
    }
    // a part of ONE body is that body's shape, and occt finds its colour itself
    if (!known || (seen.size < 2 && solids.length + shells.length < 2)) continue;
    if (solids.length) runs.push(solids);
    if (shells.length) runs.push(shells);
  }
  const fill = whole.size === 0 && split.size === 1 ? colour([...split][0]) : null;
  return { runs, fill };
}

/** `colourHint` for a file read whole; null when the index cannot read it (occt still may) */
export function wholeHint(bytes: Uint8Array): StepColourHint | null {
  try {
    const ix = indexStep(bytes);
    const plan = planPieces(ix, { pieceBytes: Infinity });
    return colourHint(ix, plan, plan.units.map((_, k) => k));
  } catch {
    return null;
  }
}
