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
import { ImportError } from './importError';
import type { StepColourHint, StepLostBody } from './stepConvert';
import { placementsJoin } from './stepConvert';

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
 * OCCT WORKERS THAT MAY RUN AT ONCE. The read is CPU-bound and splits evenly (measured, 2026-10-03,
 * REV's 125 MB STEP: 3 workers 64.6 s, 6 36.0 s, 8 30.5 s, 13 22.6 s, with the occt time summed over
 * the pieces unchanged). Every core but two (the page and the import worker keep theirs); on a device
 * that says it has 8 GB or more (`deviceMemory` stops at 8), six, or eight with 16 cores; three on
 * 4 GB, two on 2 GB, else one. That is a CEILING: memory is held to `readerBudget` read by read
 * (`HeapGate`), because a reader's heap is not a constant: on a real team assembly the faces of a few
 * large solids took a fresh occt to its 2 GB ceiling however they were packed, where every other piece
 * stayed under half a GB, and a reader keeps its high-water, so eight readers held over 8 GB
 * (measured 2026-11-27).
 */
export function poolSize(pieces: number, cores: number, memGb: number): number {
  const byMem = memGb >= 8 ? (cores >= 16 ? 8 : 6) : memGb >= 4 ? 3 : memGb >= 2 ? 2 : 1;
  return Math.max(1, Math.min(pieces, byMem, cores - 2));
}

const MB = 1024 * 1024;

/**
 * The occt heap all readers together may hold, by the memory the device reports: the envelope
 * `poolSize` was first sized to (six 368 MB readers at 8 GB, three at 4, two at 2), 3.0, 1.1 and
 * 0.75 GB. Under 2 GB there is one reader and nothing to share.
 */
export function readerBudget(memGb: number): number {
  return memGb >= 8 ? 3072 * MB : memGb >= 4 ? 1126 * MB : memGb >= 2 ? 768 * MB : Infinity;
}

/** occt-import-js 0.0.23's heap ceiling (`getHeapMax`): no read can hold more */
export const HEAP_MAX = 2048 * MB;
/** a fresh occt before it reads anything */
export const HEAP_BASE = 34 * MB;
/**
 * Heap per byte of a piece's STEP text, above `HEAP_BASE`. Measured on real team assemblies at Light
 * and Full, every piece in a fresh occt (2026-11-27): one piece alone ranges widely (the heap grows in
 * 20 % steps, and what a face costs is its geometry, not its length), but summed over a file's pieces
 * 24 is within 15 % (costly solids aside, which `CostlyPricing` prices).
 */
export const HEAP_PER_BYTE = 24;

/** what reading `textBytes` of STEP takes a fresh occt's heap to, bytes, at most `HEAP_MAX` */
export function pieceHeap(textBytes: number): number {
  return Math.min(HEAP_MAX, HEAP_BASE + HEAP_PER_BYTE * textBytes);
}

/**
 * A SOLID THIS BIG IS COSTLY UNTIL IT HAS BEEN MEASURED (`CostlyPricing`): only the faces of solids
 * over a whole piece were seen to take a fresh occt to its ceiling (real team assemblies, 2026-11-27).
 */
export const COSTLY_ROOT_BYTES = STEP_PIECE_BYTES;

/**
 * THE READERS' MEMORY, READ BY READ. Each reader holds its occt heap's high-water (it never shrinks);
 * a read RESERVES its estimate on top of what its reader holds, and starts only when the readers'
 * total stays inside the budget (or when nothing else is reading, so the read always moves). The
 * first read waiting in line keeps its room: nothing behind it may take what it needs. A reader
 * whose heap ends over its share (`budget / readers`) is ended, which frees its heap at once.
 */
export class HeapGate {
  private held: number[];
  private reserved: number[];
  constructor(
    readonly budget: number,
    readers: number,
  ) {
    this.held = new Array(readers).fill(0);
    this.reserved = new Array(readers).fill(0);
  }
  get share(): number {
    return this.budget / this.held.length;
  }
  /** the heap the readers hold and reserve now */
  get used(): number {
    let s = 0;
    for (let i = 0; i < this.held.length; i++) s += Math.max(this.held[i], this.reserved[i]);
    return s;
  }
  get reading(): number {
    return this.reserved.filter((r) => r > 0).length;
  }
  /**
   * What to keep free for the read first in line (`est`): its room, unless it cannot run beside the
   * biggest read in flight anyway, when keeping room would only idle the other readers until that
   * one ends (and the reads that took the room end long before it).
   */
  keepFor(est: number): number {
    let top = 0;
    for (const r of this.reserved) if (r > top) top = r;
    return top + est <= this.budget ? est : 0;
  }
  /** may reader `slot` start a read of `est` now, keeping `keep` free for the read first in line */
  fits(slot: number, est: number, keep = 0): boolean {
    if (this.reading === 0) return true;
    const mine = Math.max(this.held[slot], this.reserved[slot]);
    return this.used - mine + Math.max(this.held[slot], est) + keep <= this.budget;
  }
  start(slot: number, est: number): void {
    this.reserved[slot] = Math.max(1, est);
  }
  /** the read ended with its reader's heap at `heap`; true when the reader should be ended */
  end(slot: number, heap: number): boolean {
    this.reserved[slot] = 0;
    this.held[slot] = heap;
    if (heap > this.share) {
      this.held[slot] = 0;
      return true;
    }
    return false;
  }
  /** the reader was ended (or started over) */
  drop(slot: number): void {
    this.held[slot] = 0;
  }
  /**
   * The next read to start: the first in line (`ests`, the waiting reads' estimates in order) that
   * fits on an idle reader, a read behind the first leaving it `keepFor` its room. [index in line,
   * reader], or null when none may start yet.
   */
  pick(ests: readonly number[], idle: readonly number[]): [number, number] | null {
    if (!ests.length) return null;
    const keep = this.keepFor(ests[0]);
    for (let k = 0; k < ests.length; k++) for (const s of idle) if (this.fits(s, ests[k], k === 0 ? 0 : keep)) return [k, s];
    return null;
  }
}

/** the costly solid (over `COSTLY_ROOT_BYTES`) whose faces a read of `units` holds, or −1 */
export function costlyRootOf(plan: Pick<StepPlan, 'units' | 'roots'>, units: readonly number[]): number {
  for (const u of units) {
    const unit = plan.units[u];
    if (unit.face >= 0 && plan.roots[unit.root].bytes > COSTLY_ROOT_BYTES) return unit.root;
  }
  return -1;
}

/**
 * How many pieces of ONE unmeasured costly solid may be read at once, each at its own `pieceHeap`, on
 * a device reporting 8 GB or more (`CostlyPricing`): the smallest count at which every real team robot
 * we measured with such a solid read within 15 % of its time with no gate, simulated over each piece's
 * measured heap and read time with this scheduler (2026-11-27). One at a time, a solid whose largest
 * piece was slow but cheap held its siblings until that piece ended. What it can cost: the readers'
 * heap may pass the budget by up to this many reads at the ceiling, while that one solid is unmeasured.
 */
export const COSTLY_TOGETHER = 4;

/**
 * WHAT A READ OF A COSTLY SOLID'S FACES IS PRICED AT (`HeapGate`'s estimate). Every other read is
 * `pieceHeap`. A solid's price comes from ITS OWN reads only: it is MEASURED once one of its pieces
 * has ended and none of its unmeasured pieces is still running, and is then priced at the most its
 * pieces took. Nothing another solid took ever lowers it (a cheap solid measured first once let a dear
 * one's six pieces start together). Before it is measured:
 *
 * - **8 GB or more** (`strict` false): up to `COSTLY_TOGETHER` of its pieces at their own
 *   `pieceHeap`; another unmeasured solid waits (Infinity: `HeapGate.fits` admits it only when nothing
 *   is reading). Two unmeasured solids never overlap, and the readers' heap passes the budget by at
 *   most `COSTLY_TOGETHER` reads at the ceiling, while one solid is unmeasured.
 * - **Under 8 GB** (`strict`): one unmeasured costly read at a time, priced at the room the other
 *   readers leave (`firstCostlyHeap`): the budget plus at most one read at the ceiling.
 *
 * A small PROBE read cannot stand in for a measurement: on a real team assembly (2026-11-27) the first
 * faces of a solid whose pieces reached the ceiling took no more heap than a cheap solid's.
 */
export class CostlyPricing {
  private solid = new Map<number, number>();
  private took = new Map<number, number>();
  private running = new Map<number, number>();
  constructor(
    readonly strict: boolean,
    readonly budget: number,
    private readonly readers: number,
    /** the heap of the file's biggest ordinary read (`pieceHeap`) */
    private readonly typical: number,
  ) {}
  /** is `root` a costly solid not measured yet? */
  unknown(root: number): boolean {
    return root >= 0 && !this.solid.has(root);
  }
  price(root: number, textBytes: number): number {
    const own = pieceHeap(textBytes);
    if (root < 0) return own;
    const known = this.solid.get(root);
    if (known !== undefined) return Math.max(own, known);
    let all = 0;
    let other = false;
    for (const [k, n] of this.running) {
      all += n;
      if (n > 0 && k !== root) other = true;
    }
    if (this.strict) return firstCostlyHeap(textBytes, this.budget, this.readers, all > 0, this.typical);
    const mine = this.running.get(root) ?? 0;
    if (other || mine >= COSTLY_TOGETHER) return Infinity;
    return own;
  }
  /** a read of `root`'s faces started; true when it is unmeasured (pass it back to `end`) */
  start(root: number): boolean {
    const u = this.unknown(root);
    if (u) this.running.set(root, (this.running.get(root) ?? 0) + 1);
    return u;
  }
  /** the read ended with its reader's heap at `heap` (not a number: priced as the ceiling) */
  end(root: number, heap: number, unknown: boolean): void {
    if (root < 0) return;
    const h = Number.isFinite(heap) ? heap : HEAP_MAX;
    if (!unknown) {
      this.solid.set(root, Math.max(this.solid.get(root) ?? 0, h));
      return;
    }
    const left = Math.max(0, (this.running.get(root) ?? 1) - 1);
    this.running.set(root, left);
    this.took.set(root, Math.max(this.took.get(root) ?? 0, h));
    if (left === 0) this.solid.set(root, this.took.get(root)!);
  }
}

/**
 * What the FIRST costly read of a file is priced at on a device under 8 GB (`CostlyPricing`, strict):
 * the room the other readers leave (`budget` less `readers − 1` of the file's biggest ordinary reads,
 * `typical`), at least its own `pieceHeap`, at most the ceiling, and `HEAP_MAX` for any other while
 * it runs. A dear solid's first read can pass the budget by at most one read at the ceiling.
 */
export function firstCostlyHeap(textBytes: number, budget: number, readers: number, oneRunning: boolean, typical: number): number {
  if (oneRunning || !Number.isFinite(budget)) return HEAP_MAX;
  const own = pieceHeap(textBytes);
  return Math.min(HEAP_MAX, Math.max(own, budget - (readers - 1) * typical));
}

/** the occt readers of one file: their slots (a reader, or none), the memory gate and the pricing */
export interface ReaderPool<R> {
  gate: HeapGate;
  pricing: CostlyPricing;
  slots: (R | null)[];
}

/** what `runRound` needs to start, end and use a reader */
export interface ReaderIo<R, T> {
  open(): R;
  close(reader: R): void;
  /** read job `i` of the round on `reader` */
  read(reader: R, i: number): Promise<T>;
  /** the reader's heap after the read, bytes */
  heap(read: T): number;
}

/**
 * ONE ROUND OF READS ON THE POOL, the STEP worker's own scheduler (pure: `npm test` drives it with
 * readers of its own). `jobs` give each read's STEP bytes (`text`) and the costly solid it reads
 * (`costly`, −1 for none). The rules:
 *
 * - the costliest first (a costly solid's first piece, then the biggest), so the long reads start
 *   early; a read starts when `HeapGate.pick` admits it at its `CostlyPricing` price;
 * - when nothing waiting fits and idle readers hold heap, they are ended (that can be all that keeps
 *   the first read out);
 * - a read made again (`first` false), a read of a costly solid's faces, and any read priced over a
 *   reader's share, gets a FRESH occt: a read near the 2 GB ceiling on a reader that already holds
 *   heap can come back blank or with holes, so its verdict would depend on which reader it landed on,
 *   and the same file must give the same model on every run;
 * - a reader whose heap ends over its share is ended; a heap that is not a number counts as none
 *   for the gate and as the ceiling for the pricing.
 *
 * `settle` is called as each read ends; the promise rejects with the first read that failed.
 */
export function runRound<R, T>(pool: ReaderPool<R>, jobs: readonly { text: number; costly: number }[], first: boolean, io: ReaderIo<R, T>, settle: (i: number, read: T) => void): Promise<void> {
  const { gate, pricing, slots } = pool;
  return new Promise<void>((resolve, reject) => {
    const est = (i: number): number => pricing.price(jobs[i].costly, jobs[i].text);
    // unmeasured costly solids' pieces first (the sooner one ends, the sooner its siblings are priced),
    // then the dearest, then the biggest
    const first0 = (i: number): number => (pricing.unknown(jobs[i].costly) ? 0 : 1);
    const queue = jobs.map((_, i) => i).sort((a, b) => first0(a) - first0(b) || est(b) - est(a) || jobs[b].text - jobs[a].text || a - b);
    const idle = slots.map((_, s) => s);
    let running = 0;
    let failed = false;
    const drop = (s: number): void => {
      const r = slots[s];
      if (r !== null && r !== undefined) io.close(r);
      slots[s] = null;
      gate.drop(s);
    };
    const pump = (): void => {
      while (!failed && queue.length && idle.length) {
        let picked = gate.pick(queue.map(est), idle);
        if (!picked && idle.some((s) => slots[s] !== null)) {
          for (const s of idle) drop(s);
          picked = gate.pick(queue.map(est), idle);
        }
        if (!picked) break;
        const [q, slot] = picked;
        const i = queue.splice(q, 1)[0];
        idle.splice(idle.indexOf(slot), 1);
        running++;
        const price = est(i);
        if (slots[slot] !== null && (!first || price > gate.share || jobs[i].costly >= 0)) drop(slot);
        const reader = (slots[slot] ??= io.open());
        gate.start(slot, price);
        const unknown = pricing.start(jobs[i].costly);
        io.read(reader, i).then(
          (r) => {
            running--;
            const heap = Number(io.heap(r));
            pricing.end(jobs[i].costly, heap, unknown);
            if (gate.end(slot, Number.isFinite(heap) ? heap : 0) || !first) {
              io.close(reader);
              if (slots[slot] === reader) slots[slot] = null;
              gate.drop(slot);
            }
            idle.push(slot);
            settle(i, r);
            pump();
          },
          (err) => {
            failed = true;
            reject(err);
          },
        );
      }
      if (!failed && !queue.length && running === 0) resolve();
    };
    pump();
  });
}

// ---- what a file is, before reading it ------------------------------------------------------

export type StepTextCheck = { ok: true } | { ok: false; reason: 'not-step' | 'truncated' };

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));
const MAGIC = ascii('ISO-10303-21');
const END = ascii('END-ISO-10303-21');
const ENDSEC_WORD = ascii('ENDSEC');
const DATA_WORD = ascii('DATA');

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

/**
 * What the STEP worker says when one of its occt workers dies (here, not in `stepWorker.ts`, so a
 * test can ask it: that module is a worker's entry). ⚠️ ONE THAT HAD STARTED READING RAN OUT OF
 * SOMETHING (2026-11-26): it was reported as "Couldn’t start the STEP reader", whose code
 * (`step-reader`) is the one the editor offers Try again for, and a read that runs a reader out of
 * memory does it again. Past its `reading` message occt had loaded, so the read is what failed
 * (`step-failed`) and the next step is memory: other tabs, or Light detail, which leaves the
 * smallest parts out (said only at Full, `keepSmall`). Not started: the wasm or its glue did not
 * load, and a reload is the step. Neither offers a GLB or STL, which the editor has refused since
 * 2026-11-05.
 */
export function occtDied(name: string, why: string, started: boolean, keepSmall: boolean): ImportError {
  return started
    ? new ImportError('step-failed', `Couldn’t finish reading ${name} (${why || 'the STEP reader stopped'}). The browser may have run out of memory: close other tabs and try again${keepSmall ? ', or choose Light detail' : ''}.`)
    : new ImportError('step-reader', `Couldn’t start the STEP reader (${why || 'it stopped'}). Reload the page and try again.`);
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

/**
 * The largest entity number read: `ids` and `refs` are Int32Arrays, and occt's own reader keeps them
 * in a 32-bit int. A reference past it used to wrap negative and resolve to entity 0
 * (M-IMP-ENGINE-08); now the file is refused as damaged. Real files number from #1 or #10 upward.
 */
const MAX_STEP_ID = 0x7fffffff;
/**
 * The id → index table is used while the largest id is under this many times the entity count
 * (plus 1,024), so it costs at most 64 bytes an entity, against the 20 the index already holds.
 * Exporters number entities one by one (measured on the fixture: 3,160 entities, largest #3160, a
 * ratio of 1.0), some in tens (10), and anything sparser is read through a Map, with the same answers.
 */
const ID_TABLE_PER_ENTITY = 16;

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

/** a JavaScript regex `\s` in the latin1 range (what the old `findData` pattern matched) */
const isReSpace = (c: number): boolean => c === 32 || (c >= 9 && c <= 13) || c === 160;

/**
 * The offset of `DATA` after the header's `ENDSEC;` (and blanks and comments), in the first 4 MB.
 *
 * ⚠️ ONE PASS, NOT A REGEX (2026-11-26). It was `/ENDSEC\s*;\s*(?:\/\*[\s\S]*?\*\/\s*)*DATA…/`, which
 * scans to the end of the text again from every `ENDSEC;/*` with no `*` `/` after it: 16,000 of them
 * (141 KB) took 402 ms, and 4 MB of them minutes of the STEP worker (M-IMP-ENGINE-07). This walks the
 * header once, skipping its strings (`'…'`, `''` inside) and comments, and at each `ENDSEC` outside
 * them reads what the pattern did: blanks, `;`, blanks and whole comments, `DATA`, blanks, an
 * optional `(…)` holding no `;`, blanks, `;`. A header comment that never ends ends the search
 * (occt would read the rest of the file as that comment), so such a file has no DATA section.
 *
 * ⚠️ `strings` false IGNORES STRINGS (comments only), and is the second try: a header whose string holds
 * an apostrophe written raw (an author `O'Brien` from a non-conformant exporter; the standard writes
 * `''`) flips the pass's string parity, so `ENDSEC; DATA;` reads as inside one and the file was refused
 * "no DATA section" where the old pattern, blind to strings, found it (merge audit RI-04, proved on a
 * header with one raw apostrophe). Still one linear pass, so the pair is linear. −1: not found.
 */
function findData(buf: Uint8Array, strings = true): number {
  const n = Math.min(buf.length, 4 << 20);
  const blanks = (k: number): number => {
    while (k < n && isReSpace(buf[k])) k++;
    return k;
  };
  const wordAt = (k: number, word: Uint8Array): boolean => {
    if (k + word.length > n) return false;
    for (let j = 0; j < word.length; j++) if (buf[k + j] !== word[j]) return false;
    return true;
  };
  const opensComment = (k: number): boolean => k + 1 < n && buf[k] === C_SLASH && buf[k + 1] === C_STAR;
  /** the end of the comment opening at `k` (just past its `*` `/`), or −1 when it never closes */
  const commentEnd = (k: number): number => {
    for (let j = k + 2; j + 1 < n; j++) if (buf[j] === C_STAR && buf[j + 1] === C_SLASH) return j + 2;
    return -1;
  };
  /** after the `ENDSEC` at `k`: where its `DATA` starts, or −1 */
  const dataAfter = (k: number): number => {
    k = blanks(k + 6);
    if (k >= n || buf[k] !== C_SEMI) return -1;
    k = blanks(k + 1);
    while (opensComment(k)) {
      const e = commentEnd(k);
      if (e < 0) return -1;
      k = blanks(e);
    }
    if (!wordAt(k, DATA_WORD)) return -1;
    const at = k;
    k = blanks(k + 4);
    if (k < n && buf[k] === C_LP) {
      // `\([^;]*\)`: the last `)` before the first `;` after it
      let semi = k + 1;
      while (semi < n && buf[semi] !== C_SEMI) semi++;
      if (semi >= n) return -1;
      let close = semi - 1;
      while (close > k && buf[close] !== C_RP) close--;
      if (close <= k) return -1;
      k = blanks(close + 1);
    }
    return k < n && buf[k] === C_SEMI ? at : -1;
  };
  for (let i = 0; i < n; ) {
    const c = buf[i];
    if (strings && c === C_QUOTE) {
      // a string, `''` inside it
      i++;
      while (i < n && !(buf[i] === C_QUOTE && buf[i + 1] !== C_QUOTE)) i += buf[i] === C_QUOTE ? 2 : 1;
      i++;
      continue;
    }
    if (opensComment(i)) {
      const e = commentEnd(i);
      if (e < 0) break;
      i = e;
      continue;
    }
    if (c === ENDSEC_WORD[0] && wordAt(i, ENDSEC_WORD)) {
      const at = dataAfter(i);
      if (at >= 0) return at;
      i += 6;
      continue;
    }
    i++;
  }
  return -1;
}

/**
 * One pass over the bytes. Strings (`'…'`, with `''` escapes) and comments are skipped; a `(` is a
 * LIST when the byte before it (ignoring whitespace) is `(`, `,` or `=`, and a record or a typed
 * parameter when it is a name. Throws `StepSyntaxError` (`truncated` when the file stops inside an
 * entity, a string or a comment).
 */
export function indexStep(buf: Uint8Array): StepIndex {
  const len = buf.length;
  let dataAt = findData(buf);
  if (dataAt < 0) dataAt = findData(buf, false);
  if (dataAt < 0) throw new StepSyntaxError('no DATA section', false);
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
  const tooBig = (): never => {
    throw new StepSyntaxError('an entity number is past 2,147,483,647', false);
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
      if (id > MAX_STEP_ID) tooBig();
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
          if (r > MAX_STEP_ID) tooBig();
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
  // ids → indices: a table where the ids are about as many as the entities, else a Map (the same
  // answers). The table was used whenever the largest id was under 2^26, so a 130-byte file naming
  // #67108000 allocated 256 MB, in the STEP worker and again in `wholeHint` (M-IMP-ENGINE-08).
  const resolve = maxId < Math.min(1 << 26, ID_TABLE_PER_ENTITY * count + 1024) ? new Int32Array(maxId + 1).fill(-1) : null;
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

/**
 * A circle's radius, or an ellipse's larger semi-axis: the numbers after its placement. What
 * `/#\d+\s*,([^)]*)\)\s*;\s*$/` matched, found without it (2026-11-26): unanchored, that pattern
 * tried every `#` and scanned to the next `)` from each, quadratic on a long entity whose last `)`
 * is not followed by `;`. The `)` it ends on is the last one, followed only by blanks and `;`; the
 * `#` is the first `#\d+\s*,` after the `)` before it.
 */
function radiusOf(ix: StepIndex, e: number): number {
  let text = entityText(ix, e).trimEnd();
  if (!text.endsWith(';')) return NaN;
  text = text.slice(0, -1).trimEnd();
  if (!text.endsWith(')')) return NaN;
  const close = text.length - 1;
  const from = text.lastIndexOf(')', close - 1) + 1;
  const run = text.slice(from, close);
  const m = /#\d+\s*,/.exec(run);
  if (!m) return NaN;
  // `Math.max(...list)` without the spread, which a list of a million numbers overflows
  let r = -Infinity;
  for (const s of run.slice(m.index + m[0].length).split(',')) {
    const v = Math.abs(parseFloat(s));
    if (Number.isNaN(v)) return NaN;
    if (v > r) r = v;
  }
  return r;
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
export function colourHint(ix: StepIndex, plan: StepPlan, units: readonly number[], oneRoot = false): StepColourHint {
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
  // `oneRoot` (a read again of one root, whole or some of its faces): its colour for what occt leaves grey
  const fill = whole.size === 0 && split.size === 1 ? colour([...split][0]) : oneRoot && whole.size === 1 && split.size === 0 ? colour([...whole.values()][0]) : null;
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

// ---- a read that came back with faces and no triangles ----------------------------------------

/**
 * Root `k` of `plan` as FACE units, for a retry: a unit per face is appended to `plan.units`, with the
 * carriers and styles `pieceText` needs to write a piece of some of them (what `planPieces` does for a
 * root over half a piece). The face units' ordinals, the same ones when asked again; null when the root
 * is not a solid or shell of two faces or more.
 */
export function faceUnitsOf(ix: StepIndex, plan: StepPlan, k: number): number[] | null {
  if (plan.carriers.has(k)) {
    const have: number[] = [];
    plan.units.forEach((u, i) => {
      if (u.root === k && u.face >= 0) have.push(i);
    });
    return have.length >= 2 ? have : null;
  }
  const split = shellsAndFaces(ix, plan.roots[k].entity);
  if (!split) return null;
  plan.carriers.set(k, split.carriers);
  // the styles on the solid, and the presentation listing each (as `planPieces` finds them)
  const target = plan.roots[k].entity;
  const items: number[] = [];
  for (const e of plan.skeleton) {
    if (!plan.decorationType[ix.type[e]]) continue;
    for (let r = ix.refStart[e]; r < ix.refStart[e + 1]; r++) {
      if (!(ix.refFlags[r] & 1) && ix.refs[r] === target) {
        items.push(e);
        break;
      }
    }
  }
  if (items.length) {
    const want = new Set(items);
    const holder = new Map<number, number>();
    for (const e of plan.skeleton) {
      for (let r = ix.refStart[e]; r < ix.refStart[e + 1]; r++) {
        const t = ix.refs[r];
        if (t >= 0 && ix.refFlags[r] & 1 && want.has(t) && !holder.has(t)) holder.set(t, e);
      }
    }
    const styles = items.filter((item) => holder.has(item)).map((item) => ({ item, holder: holder.get(item)! }));
    if (styles.length) plan.splitStyles.set(k, styles);
  }
  const seen = new Int32Array(ix.count);
  const stack: number[] = [];
  const out: number[] = [];
  split.faces.forEach((f, i) => {
    out.push(plan.units.length);
    plan.units.push({ root: k, face: f, bytes: closure(ix, f, seen, i + 1, null, stack) });
  });
  return out;
}

/** the STEP text of a read of `units` of `plan` (a piece, or part of one being read again) */
export function unitsText(ix: StepIndex, plan: StepPlan, units: number[]): Uint8Array {
  return pieceText(ix, { ...plan, pieces: [units] }, 0);
}

/**
 * How a read that came back BLANK (B-rep faces, no triangles) is read again: a read of several roots,
 * root by root; one root, by its faces in `RETRY_FAN` parts; a run of faces, in `RETRY_FAN` parts.
 * Empty when there is nothing smaller to read (one face, or a root that does not split into faces):
 * that is what is left out. `facesOf` gives a root's face units (`faceUnitsOf`).
 */
export function retrySplit(units: readonly number[], rootOf: (u: number) => number, isFace: (u: number) => boolean, facesOf: (root: number) => number[] | null): number[][] {
  const roots: number[] = [];
  const byRoot = new Map<number, number[]>();
  for (const u of units) {
    const r = rootOf(u);
    let list = byRoot.get(r);
    if (!list) {
      byRoot.set(r, (list = []));
      roots.push(r);
    }
    list.push(u);
  }
  if (roots.length > 1) return roots.map((r) => byRoot.get(r)!);
  let list: readonly number[] = units;
  if (list.length === 1 && !isFace(list[0])) list = facesOf(roots[0]) ?? [];
  if (list.length < 2) return [];
  const parts = Math.min(RETRY_FAN, list.length);
  const out: number[][] = [];
  for (let i = 0; i < parts; i++) out.push(list.slice(Math.floor((i * list.length) / parts), Math.floor(((i + 1) * list.length) / parts)));
  return out;
}

/**
 * See `retrySplit`. Four: a run of faces with one occt cannot mesh is narrowed to that face in about
 * as many reads by quarters as by halves, in half the rounds (the pool runs a round's reads side by
 * side), measured on a real team assembly, 2026-11-27.
 */
export const RETRY_FAN = 4;

/**
 * THE BOUND ON READING AGAIN, per blank piece, so it never runs out on a file with many pieces that
 * each hold one bad face: a piece may be read again at most `RETRY_READS_PER_PIECE` times, reading at
 * most `RETRY_GEOMETRY_PER_PIECE` times its own geometry. One bad face among ten solids of fifty faces
 * takes 22 reads and under twice the piece's geometry; a file that will not mesh at all stops at the
 * bound, piece by piece (every read again costs the skeleton too, about one MB a second of occt).
 * What a bound stops is said as THAT (`RetryOutcome.stopped`), never as unreadable.
 */
export const RETRY_READS_PER_PIECE = 64;
export const RETRY_GEOMETRY_PER_PIECE = 4;

/**
 * One read of the pieces: `units` of the plan, and its place in the whole read. `key` is `[k]` for
 * piece k and the path of child indices below it for a retry, so the results are put together in key
 * order, never in the order readers finish in.
 */
export interface PieceJob {
  key: number[];
  units: number[];
}

/** what a read gave: `blank` when occt reported B-rep faces and no triangles */
export interface JobRead<T> {
  blank: boolean;
  value: T;
}

export function compareKeys(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length && i < b.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

export interface RetryIo<T> {
  /** what a read of these units costs (bytes of STEP text, the skeleton included): the bar */
  cost(units: readonly number[]): number;
  /** their geometry bytes (no skeleton): the bound */
  geometry(units: readonly number[]): number;
  /** what a blank read is read again as (`retrySplit`) */
  split(units: readonly number[]): number[][];
  /** read every job (`first`: the pieces, else retries), calling `settle` as each one ends */
  run(jobs: PieceJob[], first: boolean, settle: (i: number, read: JobRead<T>) => void): Promise<void>;
  /** the bar, 0..1: it never goes back, and every read that keeps triangles moves it */
  progress?(frac: number): void;
  /**
   * The final refusal's own test over what is left out so far (`unreadRefused` on `unreadOf` and
   * `stoppedOf` bytes): true when it already refuses the file. Default: their geometry over half.
   */
  refused?(lost: readonly PieceJob[], stopped: readonly PieceJob[]): boolean;
  /** blank pieces read again at once while the early refusal is possible (`RETRY_BATCH`): the pool's size */
  batch?: number;
}

export interface RetryOutcome<T> {
  /** the reads that kept triangles, in key order */
  kept: { key: number[]; value: T }[];
  /** UNREADABLE: blank reads of one face, or of one solid that does not split into faces, in key order */
  lost: PieceJob[];
  /** blank reads NOT read again because their piece reached its bound (may hold readable parts) */
  stopped: PieceJob[];
  /**
   * REFUSED EARLY (`RETRY_BATCH`): what is left out (`lost` and `stopped`) already makes the final
   * refusal certain, so `unread` blank pieces were not read again. The refusal is the one the whole
   * read would have reached: it is made by the same test.
   */
  early?: { unread: PieceJob[] };
  /** reads made again, and their geometry bytes */
  retryReads: number;
  retryBytes: number;
}

/**
 * THE FILE-WIDE RULE ON READING AGAIN, EXACT. While the blank pieces could still hold more than half the
 * file's geometry, they are read again in key order in batches of `batch` (the pool's size), each
 * batch to its end; after every round, if what is already left out (unreadable, or stopped by a
 * piece's bound) makes the final refusal's own test refuse the file, it is refused then, because no
 * later read can put back what is left out. Once what is left out plus every blank piece not yet
 * finished can no longer refuse it, the rest is read again all at once. So an early refusal is always
 * one the whole read would have reached, a mostly good file is read to its end, and a file whose every
 * face fails stops after about one batch's retries (fifteen such pieces on eight readers: 15 plain reads
 * and about 500 read again in rounds of up to eight at a time, where reading every piece again was 930).
 * Results are put together by key, whatever the batch size.
 */
export const RETRY_BATCH_DEFAULT = 8;

/**
 * Read `pieces`, then read every blank one again in smaller units (`io.split`), round by round, until
 * nothing blank is left to split, within each piece's bound and the file-wide rule (`RETRY_BATCH`). A
 * round's blank reads are admitted in KEY order once the round has ended, so what is read again, and
 * what a bound stops, does not depend on which reader finished first.
 */
export async function readPieces<T>(pieces: number[][], io: RetryIo<T>, perPiece = { reads: RETRY_READS_PER_PIECE, geometry: RETRY_GEOMETRY_PER_PIECE }): Promise<RetryOutcome<T>> {
  let round: PieceJob[] = pieces.map((units, k) => ({ key: [k], units }));
  const kept: { key: number[]; value: T }[] = [];
  const lost: PieceJob[] = [];
  const stopped: PieceJob[] = [];
  const reads = new Map<number, number>();
  const bytes = new Map<number, number>();
  let retryBytes = 0;
  let retryReads = 0;
  const total = pieces.reduce((s, p) => s + io.geometry(p), 0);
  const refused =
    io.refused ??
    ((l: readonly PieceJob[], s: readonly PieceJob[]): boolean => [...l, ...s].reduce((t, j) => t + io.geometry(j.units), 0) > UNREAD_REFUSE_SHARE * total);
  // the bar: each read that keeps triangles moves it by its share of what is left to read, so retries
  // added later stretch what is left instead of pulling the bar back
  let left = round.reduce((s, j) => s + io.cost(j.units), 0);
  let shown = 0;
  const advance = (w: number): void => {
    if (left > 0) shown += ((1 - shown) * Math.min(w, left)) / left;
    left = Math.max(0, left - w);
    if (left === 0) shown = 1;
    io.progress?.(shown);
  };
  // the blank reads of a round, in key order, become the next round (or are left out, or stopped)
  const expand = (blank: PieceJob[]): PieceJob[] => {
    const next: PieceJob[] = [];
    for (const b of blank) {
      const kids = io.split(b.units);
      const was = io.cost(b.units);
      if (!kids.length) {
        lost.push(b);
        advance(was);
        continue;
      }
      const k = b.key[0];
      const geo = kids.reduce((s, u) => s + io.geometry(u), 0);
      const r = (reads.get(k) ?? 0) + kids.length;
      const g = (bytes.get(k) ?? 0) + geo;
      if (r > perPiece.reads || g > perPiece.geometry * io.geometry(pieces[k])) {
        stopped.push(b);
        advance(was);
        continue;
      }
      reads.set(k, r);
      bytes.set(k, g);
      retryBytes += geo;
      left += kids.reduce((s, u) => s + io.cost(u), 0) - was;
      kids.forEach((units, i) => next.push({ key: [...b.key, i], units }));
    }
    retryReads += next.length;
    return next;
  };
  const batch = Math.max(1, io.batch ?? RETRY_BATCH_DEFAULT);
  // the blank pieces not yet read again, in key order, while the early refusal is possible
  let waiting: PieceJob[] = [];
  // could what is left out plus every blank piece not finished still refuse the file?
  const possible = (inFlight: readonly PieceJob[]): boolean => refused(lost, [...stopped, ...inFlight, ...waiting]);
  const finish = (): RetryOutcome<T> => {
    kept.sort((a, b) => compareKeys(a.key, b.key));
    lost.sort((a, b) => compareKeys(a.key, b.key));
    stopped.sort((a, b) => compareKeys(a.key, b.key));
    return { kept, lost, stopped, retryReads, retryBytes };
  };
  for (let first = true; round.length; first = false) {
    const jobs = round;
    const got: (JobRead<T> | undefined)[] = new Array(jobs.length);
    await io.run(jobs, first, (i, read) => {
      if (got[i]) return;
      got[i] = read;
      if (!read.blank) advance(io.cost(jobs[i].units));
    });
    let blank: PieceJob[] = [];
    jobs.forEach((job, i) => {
      const read = got[i];
      if (!read) throw new Error(`piece ${job.key.join('.')} was not read`);
      if (read.blank) blank.push(job);
      else kept.push({ key: job.key, value: read.value });
    });
    blank.sort((a, b) => compareKeys(a.key, b.key));
    if (first && blank.length > batch && possible(blank)) {
      waiting = blank.slice(batch);
      blank = blank.slice(0, batch);
    }
    round = expand(blank);
    // already certain: no later read can put back what is left out
    if (waiting.length && refused(lost, stopped)) {
      const out = finish();
      return { ...out, early: { unread: waiting } };
    }
    if (!round.length && waiting.length) {
      if (possible([])) {
        round = expand(waiting.slice(0, batch));
        waiting = waiting.slice(batch);
      } else {
        round = expand(waiting);
        waiting = [];
      }
    }
  }
  return finish();
}

/**
 * ONE SOLID IS ONE BODY, ALSO AFTER A RE-READ, WHEN THE DATA PROVES IT. A blank solid read again by its
 * faces comes back in several reads (`retrySplit`'s quarters), each a body per mesh. When EVERY kept
 * read of the solid knows each mesh's placement (`placementRuns`), and all of them the same number of
 * placements, and together each placement is one placed solid (`placementsJoin`), they become ONE read
 * at the place of the first, a body per placement in order, as the solid read whole would have been. If
 * any of that fails, none is merged: the solid keeps a body per mesh, as it would on HEAD, rather than
 * mix the two. Reads of no solid pass unchanged. Body ids in place.
 */
export function mergeSolidReads<T extends { parts: readonly { body?: Uint32Array }[]; trisIn: number; solid?: number; placementOf?: number[]; boxes?: number[] }>(
  kept: readonly { key: number[]; value: T }[],
): { key: number[]; value: T }[] {
  const groups = new Map<number, { key: number[]; value: T }[]>();
  for (const k of kept) {
    const s = k.value.solid;
    if (s === undefined || s < 0) continue;
    const g = groups.get(s) ?? [];
    g.push(k);
    groups.set(s, g);
  }
  const count = (p: number[]): number => (p.length ? Math.max(...p) + 1 : 0);
  const proved = new Set<number>();
  for (const [s, g] of groups) {
    const first = g[0].value.placementOf;
    if (!first || !g.every((x) => x.value.placementOf && x.value.boxes && count(x.value.placementOf) === count(first))) continue;
    if (placementsJoin(g.map((x) => ({ placementOf: x.value.placementOf!, boxes: x.value.boxes! })))) proved.add(s);
  }
  const out: { key: number[]; value: T }[] = [];
  for (const k of kept) {
    const s = k.value.solid;
    if (s === undefined || s < 0 || !proved.has(s)) {
      out.push(k);
      continue;
    }
    const g = groups.get(s)!;
    if (g[0] !== k) continue;
    for (const x of g) {
      const map = x.value.placementOf!;
      for (const p of x.value.parts) if (p.body) for (let i = 0; i < p.body.length; i++) p.body[i] = map[p.body[i]];
    }
    out.push({ key: k.key, value: { ...k.value, parts: g.flatMap((x) => x.value.parts), trisIn: g.reduce((t, x) => t + x.value.trisIn, 0) } });
  }
  return out;
}

/**
 * `StepSolidRead.placements` for a solid read again: the meshes its blank whole read gave (one a placed
 * solid), trusted only when the assembly counts the same (`placementCount`); else null (a body per
 * mesh). A count of one for many would merge every placement into one body.
 */
export function trustedPlacements(blankMeshes: number, assemblyCount: number | null): number | null {
  return blankMeshes > 0 && blankMeshes === assemblyCount ? blankMeshes : null;
}

/**
 * How many times root `k`'s part is placed in the assembly: the paths from a top product definition
 * down `NEXT_ASSEMBLY_USAGE_OCCURRENCE`s to the part's definition (found as `partNames` finds its
 * product). Null when the file does not say. A second source for `StepSolidRead.placements`, which
 * cannot count one placement for many.
 */
export function placementCount(ix: StepIndex, plan: StepPlan, k: number): number | null {
  const sdr = ix.typeNames.indexOf('SHAPE_DEFINITION_REPRESENTATION');
  const srr = ix.typeNames.indexOf('SHAPE_REPRESENTATION_RELATIONSHIP');
  const nauo = ix.typeNames.indexOf('NEXT_ASSEMBLY_USAGE_OCCURRENCE');
  const direct = (e: number): number[] => {
    const out: number[] = [];
    for (let r = ix.refStart[e]; r < ix.refStart[e + 1]; r++) if (ix.refs[r] >= 0 && !(ix.refFlags[r] & 1)) out.push(ix.refs[r]);
    return out;
  };
  const defined = new Map<number, number>();
  const linked = new Map<number, number[]>();
  const parents = new Map<number, number[]>();
  for (const e of plan.skeleton) {
    const t = ix.type[e];
    if (t === sdr) {
      const r = direct(e);
      if (r.length >= 2) defined.set(r[1], r[0]);
    } else if (t === srr) {
      const r = direct(e);
      if (r.length >= 2) {
        (linked.get(r[0]) ?? linked.set(r[0], []).get(r[0])!).push(r[1]);
        (linked.get(r[1]) ?? linked.set(r[1], []).get(r[1])!).push(r[0]);
      }
    } else if (t === nauo) {
      const r = direct(e);
      if (r.length >= 2) (parents.get(r[1]) ?? parents.set(r[1], []).get(r[1])!).push(r[0]);
    }
  }
  const start = plan.roots[k]?.rep ?? -1;
  if (start < 0) return null;
  let pd = -1;
  const seen = new Set<number>([start]);
  const queue = [start];
  while (queue.length && pd < 0 && seen.size < 64) {
    const rep = queue.shift()!;
    const pds = defined.get(rep);
    if (pds !== undefined) {
      const r = direct(pds);
      if (r.length) pd = r[0];
      break;
    }
    for (const n of linked.get(rep) ?? []) if (!seen.has(n)) (seen.add(n), queue.push(n));
  }
  if (pd < 0) return null;
  const memo = new Map<number, number>();
  const paths = (d: number, depth: number): number => {
    const m = memo.get(d);
    if (m !== undefined) return m;
    if (depth > 64) return 0;
    const ps = parents.get(d);
    const n = ps && ps.length ? ps.reduce((s, p) => s + paths(p, depth + 1), 0) : 1;
    memo.set(d, n);
    return n;
  };
  return paths(pd, 0);
}

/**
 * Each read numbers its bodies from 0: move every read's past the last one's, in the order given (key
 * order), so a body id names one solid across the whole file. In place.
 */
export function renumberBodies(reads: readonly { parts: readonly { body?: Uint32Array }[] }[]): void {
  let base = 0;
  for (const r of reads) {
    let top = -1;
    for (const p of r.parts) {
      if (!p.body) continue;
      for (let i = 0; i < p.body.length; i++) {
        const b = p.body[i];
        if (b > top) top = b;
        p.body[i] = b + base;
      }
    }
    base += top + 1;
  }
}

/** what the left-out reads were: parts left out whole, and faces left out of the others */
export interface Unread {
  /** root ordinals left out whole, in order */
  whole: number[];
  /** root ordinal → faces left out of it, for roots that kept some */
  partial: Map<number, number>;
  /** the geometry bytes left out (a root's at most, however many of its faces) */
  bytes: number;
}

export function unreadOf(plan: StepPlan, lost: readonly PieceJob[]): Unread {
  const whole = new Set<number>();
  const partial = new Map<number, number>();
  const faceBytes = new Map<number, number>();
  for (const job of lost) {
    for (const u of job.units) {
      const unit = plan.units[u];
      if (unit.face < 0) whole.add(unit.root);
      else {
        partial.set(unit.root, (partial.get(unit.root) ?? 0) + 1);
        faceBytes.set(unit.root, (faceBytes.get(unit.root) ?? 0) + unit.bytes);
      }
    }
  }
  // a root none of whose faces was kept is left out whole
  for (const [k, n] of partial) {
    let all = 0;
    for (const u of plan.units) if (u.root === k && u.face >= 0) all++;
    if (n >= all) {
      partial.delete(k);
      whole.add(k);
    }
  }
  let bytes = 0;
  for (const k of whole) bytes += plan.roots[k].bytes;
  for (const k of partial.keys()) bytes += Math.min(plan.roots[k].bytes, faceBytes.get(k) ?? 0);
  return { whole: [...whole].sort((a, b) => a - b), partial, bytes };
}

/** the parts a bound stopped (`RetryOutcome.stopped`), and their geometry bytes (a part's at most) */
export function stoppedOf(plan: StepPlan, stopped: readonly PieceJob[]): Unread {
  return unreadOf(plan, stopped);
}

/**
 * ⚠️ REFUSE ONLY WHEN MOST OF THE ROBOT IS MISSING: when what is left out is more than half of the
 * geometry the plan read (by bytes of STEP text, which is what a face costs, and which is known
 * without occt: a blank read's own face count is not, as occt stops counting where its mesher gave
 * up). Under that the footprint, the size and the wheels are still read from most of the robot and
 * the note says what is missing; over it they would be measured on what happened to survive.
 */
export const UNREAD_REFUSE_SHARE = 0.5;

export function unreadRefused(lostBytes: number, geometryBytes: number): boolean {
  return geometryBytes > 0 && lostBytes > UNREAD_REFUSE_SHARE * geometryBytes;
}

/** a part name as the notes show it: at most `NAME_MAX` characters */
export const NAME_MAX = 40;
const shortName = (s: string): string => (s.length > NAME_MAX ? `${s.slice(0, NAME_MAX - 1).trimEnd()}…` : s);

/** "A", "A and B", "A, B and C", "A, B, C and 2 more" */
function nameList(names: readonly string[]): string {
  const shown = names.slice(0, 3).map(shortName);
  const more = names.length - shown.length;
  if (!shown.length) return '';
  if (more > 0) return `${shown.join(', ')} and ${more.toLocaleString('en-US')} more`;
  return shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

const count = (n: number, one: string, many: string): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * The Review note for what the reader could not turn into triangles (null when nothing): parts left
 * out whole, and surfaces of the others, named (up to three) when the file names them. Only what was
 * read ALONE and came back blank (`RetryOutcome.lost`) is said so.
 */
export function unreadNote(whole: number, faces: number, partialParts: number, names: readonly string[]): string | null {
  if (!whole && !faces) return null;
  const named = names.length ? ` (${nameList(names)})` : '';
  const what =
    whole && faces
      ? `${count(whole, 'part', 'parts')}, and ${count(faces, 'surface', 'surfaces')} of ${count(partialParts, 'other part', 'other parts')}`
      : whole
        ? count(whole, 'part', 'parts')
        : `${count(faces, 'surface', 'surfaces')} of ${count(partialParts, 'part', 'parts')}`;
  return `Left out ${what}${named}: the STEP reader couldn’t turn them into triangles. The robot may have holes there.`;
}

/**
 * The Review note for parts a bound stopped (`RetryOutcome.stopped`, null when none): they were not
 * read alone, so they are not called unreadable.
 */
export function stoppedNote(whole: number, faces: number, partialParts: number, names: readonly string[]): string | null {
  if (!whole && !faces) return null;
  const named = names.length ? ` (${nameList(names)})` : '';
  return `Left out ${leftOut(whole, faces, partialParts)}${named}: the STEP reader stopped reading them again at its limit for one piece, so they may be whole in the file. The robot may have gaps there.`;
}

/** "2 parts", "3 surfaces of 2 parts", "1 part, and 3 surfaces of 2 other parts" */
function leftOut(whole: number, faces: number, partialParts: number): string {
  return whole && faces
    ? `${count(whole, 'part', 'parts')}, and ${count(faces, 'surface', 'surfaces')} of ${count(partialParts, 'other part', 'other parts')}`
    : whole
      ? count(whole, 'part', 'parts')
      : `${count(faces, 'surface', 'surfaces')} of ${count(partialParts, 'part', 'parts')}`;
}

/** the STEP schema a file's header names: 'AP242', 'AP214', 'AP203' or null */
export function stepSchema(ix: StepIndex): 'AP242' | 'AP214' | 'AP203' | null {
  const head = latin1(ix.buf.subarray(0, Math.min(ix.dataAt, 1 << 16))).toUpperCase();
  const m = /FILE_SCHEMA\s*\(\s*\(([^)]*)\)/.exec(head);
  const s = m ? m[1] : '';
  if (/AP242|MANAGED_MODEL_BASED/.test(s)) return 'AP242';
  if (/AP214|AUTOMOTIVE_DESIGN/.test(s)) return 'AP214';
  if (/AP203|CONFIG_CONTROL_DESIGN/.test(s)) return 'AP203';
  return null;
}

/**
 * What the editor says when most of a file is left out (`unreadRefused`). TRUE, and not `EXPORT_HINT`
 * ("export it again" is how the file was made): it counts what could not be turned into triangles and
 * what a bound stopped, names the parts, and the next step is the parts themselves, or the other STEP
 * schema the editor reads.
 */
export function unreadRefusal(name: string, unreadable: number, stopped: number, parts: number, names: readonly string[], schema: 'AP242' | 'AP214' | 'AP203' | null): ImportError {
  const named = names.length ? ` (${nameList(names)})` : '';
  const other = schema === 'AP242' ? 'AP214' : schema === 'AP214' || schema === 'AP203' ? 'AP242' : null;
  const swap = other ? `, or export the robot as STEP ${other} instead of ${schema}` : '';
  const what = unreadable
    ? `the STEP reader couldn’t turn ${unreadable.toLocaleString('en-US')} of ${count(parts, 'part', 'parts')} into triangles${stopped ? ` and stopped reading ${count(stopped, 'more', 'more')} again at its limit` : ''}`
    : `the STEP reader stopped reading ${stopped.toLocaleString('en-US')} of ${count(parts, 'part', 'parts')} again at its limit`;
  const check = names.length ? 'Check those parts in your CAD tool and repair or simplify them' : 'Check the robot’s parts in your CAD tool and repair or simplify any that are damaged';
  return new ImportError('step-failed', `Couldn’t read ${name}: ${what}${named}. ${check}${swap}.`);
}

/**
 * A STEP string's text: `''` is a quote, `\X\hh` a Latin-1 byte, `\X2\…\X0\` UTF-16, `\S\c` c + 128;
 * and bytes past ASCII written raw (an exporter writing UTF-8, which the index reads as Latin-1) are
 * read as UTF-8 when they are valid UTF-8.
 */
export function stepString(raw: string): string {
  let s = raw;
  if (/[\x80-\xff]/.test(s)) {
    try {
      s = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff));
    } catch {
      // not UTF-8: Latin-1 as read
    }
  }
  return s
    .replace(/''/g, "'")
    .replace(/\\X2\\((?:[0-9A-Fa-f]{4})*)\\X0\\/g, (_, hex: string) => {
      let t = '';
      for (let i = 0; i < hex.length; i += 4) t += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
      return t;
    })
    .replace(/\\X\\([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\S\\(.)/g, (_, c: string) => String.fromCharCode(c.charCodeAt(0) + 128))
    .replace(/\\\\/g, '\\');
}

/**
 * The part names of roots `ks` (null where the file gives none): root → its shape representation →
 * (through plain `SHAPE_REPRESENTATION_RELATIONSHIP`s, never an assembly's placed ones) the one a
 * `SHAPE_DEFINITION_REPRESENTATION` defines → product definition → formation → `PRODUCT`'s name.
 */
export function partNames(ix: StepIndex, plan: StepPlan, ks: readonly number[]): (string | null)[] {
  const sdr = ix.typeNames.indexOf('SHAPE_DEFINITION_REPRESENTATION');
  const srr = ix.typeNames.indexOf('SHAPE_REPRESENTATION_RELATIONSHIP');
  const defined = new Map<number, number>(); // rep → product definition shape
  const linked = new Map<number, number[]>(); // rep → reps it is related to
  const link = (a: number, b: number): void => {
    const l = linked.get(a) ?? [];
    l.push(b);
    linked.set(a, l);
  };
  for (const e of plan.skeleton) {
    const t = ix.type[e];
    if (t !== sdr && t !== srr) continue;
    const refs: number[] = [];
    for (let r = ix.refStart[e]; r < ix.refStart[e + 1]; r++) if (ix.refs[r] >= 0 && !(ix.refFlags[r] & 1)) refs.push(ix.refs[r]);
    if (t === sdr && refs.length >= 2) defined.set(refs[1], refs[0]);
    else if (t === srr && refs.length >= 2) {
      link(refs[0], refs[1]);
      link(refs[1], refs[0]);
    }
  }
  const firstRef = (e: number): number => (ix.refStart[e + 1] > ix.refStart[e] ? ix.refs[ix.refStart[e]] : -1);
  const strings = (e: number): string[] => [...entityText(ix, e).matchAll(/'((?:[^']|'')*)'/g)].map((m) => stepString(m[1]).trim());
  return ks.map((k) => {
    const start = plan.roots[k]?.rep ?? -1;
    if (start < 0) return null;
    const seen = new Set<number>([start]);
    const queue = [start];
    while (queue.length && seen.size < 64) {
      const rep = queue.shift()!;
      const pds = defined.get(rep);
      if (pds !== undefined) {
        const pd = firstRef(pds);
        const pdf = pd >= 0 ? firstRef(pd) : -1;
        const product = pdf >= 0 ? firstRef(pdf) : -1;
        if (product < 0 || ix.typeNames[ix.type[product]] !== 'PRODUCT') return null;
        const [id, nm] = strings(product);
        return nm || id || null;
      }
      for (const next of linked.get(rep) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return null;
  });
}
