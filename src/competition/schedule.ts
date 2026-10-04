/**
 * QUALIFICATION SCHEDULES: balanced (FTC's model), round robin and swiss.
 *
 * Pure and seeded: the same entries, settings and seed always draw the same schedule, so the
 * server can store just the matches and a re-draw with the stored seed reproduces them exactly.
 * Entries are opaque ids here; nothing in this file knows what an entry is.
 */
import type { CompSlot } from './types';
import { mulberry32, shuffle } from './rng';

export interface DrawnMatch {
  round: number;
  red: CompSlot[];
  blue: CompSlot[];
}

// ---------------------------------------------------------------------------------------------
// balanced
// ---------------------------------------------------------------------------------------------

/**
 * A BALANCED SCHEDULE: every entry plays exactly `matchesPerEntry` counted matches.
 *
 * There are M = ceil(n·m / slotsPerMatch) matches. When n·m does not fill them, the spare slots
 * (fewer than one match's worth) go to SURROGATE appearances: distinct entries that play one extra
 * match which does not count for them. No entry ever gets two.
 *
 * Construction: m seeded permutations of the entries laid end to end (permutation r is round r),
 * then the surrogate slots as a partial extra permutation, chunked into matches in that order.
 * That gives every entry one appearance per round, give or take a match that straddles two
 * permutations (which can even hold one entry twice), and nothing else a schedule is judged on.
 * A local search then swaps single slots between (and within) matches, plus whole-match colour
 * flips, keeping a move when the cost does not get worse. The cost is compared
 * LEXICOGRAPHICALLY, in this priority order, because a weighted sum lets enough of a cheap term
 * buy one of a dear one:
 *
 *   1. an entry twice in one match (forbidden; a repair pass guarantees it is gone)
 *   2. appearances closer than `minGap` matches apart (gap = index difference − 1), by shortfall
 *   3. repeated partners (two entries per alliance only)
 *   4. repeated opponents
 *   5. red/blue imbalance per entry
 *   6. round drift: an entry's j-th appearance sitting outside round j
 *
 * Partner and opponent counts are costed c·(c−1)/2, not "c beyond the first": the two agree on
 * which schedules have no repeats, but only the convex one tells a schedule where one pair met
 * five times from one where five pairs met twice, and when repeats are forced (four entries, every
 * match the same four) it is what rotates the partners evenly. Colour is costed (red − blue)².
 *
 * ROUND NUMBERS are a function of play position: match i is in round min(m, floor(i·k/n) + 1)
 * (k slots per match). Round r is the stretch of the schedule in which an average entry plays its
 * r-th match, the surrogate tail counts as the last round, and rounds never decrease in play
 * order. Term 6 keeps entries close to that, at the lowest priority.
 *
 * In small fields the terms conflict: 8 entries in 2v2 with `minGap` 1 can only avoid every
 * back-to-back by playing the same two foursomes over and over, and a local search will not walk
 * that far from a schedule with no repeated partners. It settles where it can; a smaller `minGap`
 * is the organizer's lever there.
 *
 * Bounded: the search runs a fixed number of moves scaled to the schedule's size (capped), and
 * stops early if every term reaches its floor. 128 entries × 12 matches in 2v2 takes ~0.3 s.
 */
export function drawBalanced(
  entries: number[],
  perAlliance: 1 | 2,
  matchesPerEntry: number,
  minGap: number,
  seed: number,
): DrawnMatch[] {
  const n = entries.length;
  const k = 2 * perAlliance;
  if (n < k) throw new Error(`Needs at least ${k} entries.`);
  if (new Set(entries).size !== n) throw new Error('An entry is listed twice.');
  const m = Math.floor(matchesPerEntry);
  if (!(m >= 1)) throw new Error('Needs at least one match per entry.');
  const gapMin = Math.max(0, Math.floor(minGap) || 0);

  const M = Math.ceil((n * m) / k);
  const total = M * k;
  const spare = total - n * m;
  const rand = mulberry32(seed);

  // ent[t] = entry INDEX in slot t; slot t is in match floor(t / k), red when t % k < perAlliance
  const ent = new Int32Array(total);
  const sur = new Uint8Array(total);
  const idx = Array.from({ length: n }, (_, i) => i);
  let t0 = 0;
  for (let r = 0; r < m; r++) for (const e of shuffle(idx, rand)) ent[t0++] = e;
  if (spare > 0) {
    const p = shuffle(idx, rand);
    for (let i = 0; i < spare; i++, t0++) {
      ent[t0] = p[i];
      sur[t0] = 1;
    }
  }

  const matchRound = new Int32Array(M);
  for (let i = 0; i < M; i++) matchRound[i] = Math.min(m, Math.floor((i * k) / n) + 1);

  const apps: number[][] = Array.from({ length: n }, () => []);
  for (let t = 0; t < total; t++) apps[ent[t]].push(t);

  // ---- per-entry terms (gap, colour, round drift) ------------------------------------------
  const tmp = new Int32Array(m + 2);
  let ecGap = 0;
  let ecCol = 0;
  let ecRnd = 0;
  const entryCosts = (list: number[]): void => {
    const len = list.length;
    let reds = 0;
    for (let x = 0; x < len; x++) {
      const t = list[x];
      if (t % k < perAlliance) reds++;
      // insertion sort by match index; a list is at most m + 1 long
      const v = (t / k) | 0;
      let y = x - 1;
      while (y >= 0 && tmp[y] > v) {
        tmp[y + 1] = tmp[y];
        y--;
      }
      tmp[y + 1] = v;
    }
    let gap = 0;
    let rnd = 0;
    for (let x = 0; x < len; x++) {
      if (x > 0) {
        const g = tmp[x] - tmp[x - 1] - 1;
        if (g < gapMin) gap += gapMin - g;
      }
      const ideal = Math.min(x + 1, m);
      const d = matchRound[tmp[x]] - ideal;
      rnd += d < 0 ? -d : d;
    }
    const diff = 2 * reds - len;
    ecGap = gap;
    ecCol = diff * diff;
    ecRnd = rnd;
  };
  const gapC = new Int32Array(n);
  const colC = new Int32Array(n);
  const rndC = new Int32Array(n);
  let totGap = 0;
  let totCol = 0;
  let totRnd = 0;
  let colFloor = 0;
  for (let e = 0; e < n; e++) {
    entryCosts(apps[e]);
    gapC[e] = ecGap;
    colC[e] = ecCol;
    rndC[e] = ecRnd;
    totGap += ecGap;
    totCol += ecCol;
    totRnd += ecRnd;
    colFloor += apps[e].length % 2;
  }

  // ---- per-match terms (duplicates, partners, opponents) -----------------------------------
  const partner = new Int32Array(perAlliance === 2 ? n * n : 0);
  const opp = new Int32Array(n * n);
  let dP = 0;
  let dO = 0;
  const bumpP = (a: number, b: number, sign: number): void => {
    if (a === b) return;
    const ix = a < b ? a * n + b : b * n + a;
    if (sign > 0) dP += partner[ix]++;
    else dP -= --partner[ix];
  };
  const bumpO = (a: number, b: number, sign: number): void => {
    if (a === b) return;
    const ix = a < b ? a * n + b : b * n + a;
    if (sign > 0) dO += opp[ix]++;
    else dO -= --opp[ix];
  };
  const pairs = (i: number, sign: number): void => {
    const b = i * k;
    if (perAlliance === 2) {
      bumpP(ent[b], ent[b + 1], sign);
      bumpP(ent[b + 2], ent[b + 3], sign);
      bumpO(ent[b], ent[b + 2], sign);
      bumpO(ent[b], ent[b + 3], sign);
      bumpO(ent[b + 1], ent[b + 2], sign);
      bumpO(ent[b + 1], ent[b + 3], sign);
    } else {
      bumpO(ent[b], ent[b + 1], sign);
    }
  };
  const dupOf = (i: number): number => {
    const b = i * k;
    let d = 0;
    for (let x = 0; x < k; x++) for (let y = x + 1; y < k; y++) if (ent[b + x] === ent[b + y]) d++;
    return d;
  };
  let totDup = 0;
  for (let i = 0; i < M; i++) {
    totDup += dupOf(i);
    pairs(i, 1);
  }
  let totP = dP;
  let totO = dO;

  /** swap slots s1 and s2 if that does not make the schedule worse; true when kept */
  const attempt = (s1: number, s2: number, dupOnly: boolean): boolean => {
    const a = ent[s1];
    const b = ent[s2];
    if (a === b) return false;
    const i = (s1 / k) | 0;
    const j = (s2 / k) | 0;
    const same = i === j;
    const dupBefore = dupOf(i) + (same ? 0 : dupOf(j));
    dP = 0;
    dO = 0;
    pairs(i, -1);
    if (!same) pairs(j, -1);
    ent[s1] = b;
    ent[s2] = a;
    pairs(i, 1);
    if (!same) pairs(j, 1);
    const dDup = dupOf(i) + (same ? 0 : dupOf(j)) - dupBefore;
    const la = apps[a];
    const lb = apps[b];
    la[la.indexOf(s1)] = s2;
    lb[lb.indexOf(s2)] = s1;
    entryCosts(la);
    const ga = ecGap;
    const ca = ecCol;
    const ra = ecRnd;
    entryCosts(lb);
    const dGap = ga + ecGap - gapC[a] - gapC[b];
    const dCol = ca + ecCol - colC[a] - colC[b];
    const dRnd = ra + ecRnd - rndC[a] - rndC[b];
    const dPm = dP;
    const dOm = dO;
    const verdict = dupOnly
      ? dDup
      : dDup || dGap || dPm || dOm || dCol || dRnd;
    if (verdict <= 0 && (!dupOnly || dDup < 0)) {
      gapC[a] = ga;
      colC[a] = ca;
      rndC[a] = ra;
      gapC[b] = ecGap;
      colC[b] = ecCol;
      rndC[b] = ecRnd;
      totDup += dDup;
      totGap += dGap;
      totP += dPm;
      totO += dOm;
      totCol += dCol;
      totRnd += dRnd;
      const f = sur[s1];
      sur[s1] = sur[s2];
      sur[s2] = f;
      return true;
    }
    pairs(i, -1);
    if (!same) pairs(j, -1);
    ent[s1] = a;
    ent[s2] = b;
    pairs(i, 1);
    if (!same) pairs(j, 1);
    la[la.indexOf(s2)] = s1;
    lb[lb.indexOf(s1)] = s2;
    return false;
  };

  /**
   * Swap a match's whole red alliance with its whole blue one. Partners and opponents are
   * untouched, so this is the only move that can fix colour once a schedule has no repeats left:
   * any single-slot swap that changes a colour also breaks a partnership the higher terms hold.
   */
  const flip = (i: number): void => {
    if (dupOf(i) > 0) return;
    const b = i * k;
    const before = new Int32Array(k);
    for (let x = 0; x < k; x++) before[x] = colC[ent[b + x]];
    const swapHalves = (): void => {
      for (let x = 0; x < perAlliance; x++) {
        const s1 = b + x;
        const s2 = b + perAlliance + x;
        const a = ent[s1];
        const c = ent[s2];
        ent[s1] = c;
        ent[s2] = a;
        const f = sur[s1];
        sur[s1] = sur[s2];
        sur[s2] = f;
        const la = apps[a];
        const lc = apps[c];
        la[la.indexOf(s1)] = s2;
        lc[lc.indexOf(s2)] = s1;
      }
    };
    swapHalves();
    let dCol = 0;
    const after = new Int32Array(k);
    for (let x = 0; x < k; x++) {
      entryCosts(apps[ent[b + x]]);
      after[x] = ecCol;
      dCol += ecCol - before[x];
    }
    if (dCol <= 0) {
      for (let x = 0; x < k; x++) colC[ent[b + x]] = after[x];
      totCol += dCol;
    } else {
      swapHalves();
    }
  };

  // ~200 tries per slot, at least 50k and at most 300k: 128 entries × 12 matches in 2v2 is 1,536
  // slots and lands at the cap, well under a second. One try in eight is a colour flip.
  const iters = Math.min(300_000, Math.max(50_000, total * 200));
  for (let it = 0; it < iters; it++) {
    if ((it & 1023) === 0 && totDup === 0 && totGap === 0 && totP === 0 && totO === 0 && totCol === colFloor && totRnd === 0) break;
    if (perAlliance === 2 && (it & 7) === 7) flip((rand() * M) | 0);
    else attempt((rand() * total) | 0, (rand() * total) | 0, false);
  }

  // A safety net, not the mechanism: the search ranks duplicates first and clears them in every
  // case the tests draw, but an illegal match must be impossible rather than improbable.
  for (let pass = 0; pass < 4 && totDup > 0; pass++) {
    for (let s1 = 0; s1 < total && totDup > 0; s1++) {
      const i = (s1 / k) | 0;
      if (dupOf(i) === 0) continue;
      for (let s2 = 0; s2 < total; s2++) if (attempt(s1, s2, true)) break;
    }
  }
  if (totDup > 0) throw new Error('Could not draw a schedule without an entry twice in one match.');

  const out: DrawnMatch[] = [];
  const slot = (t: number): CompSlot => (sur[t] ? { entry: entries[ent[t]], surrogate: true } : { entry: entries[ent[t]] });
  for (let i = 0; i < M; i++) {
    const b = i * k;
    const red: CompSlot[] = [];
    const blue: CompSlot[] = [];
    for (let x = 0; x < perAlliance; x++) {
      red.push(slot(b + x));
      blue.push(slot(b + perAlliance + x));
    }
    out.push({ round: matchRound[i], red, blue });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// round robin
// ---------------------------------------------------------------------------------------------

/**
 * EVERY ENTRY MEETS EVERY OTHER, `cycles` times. One entry per alliance.
 *
 * Pairings come from the circle (polygon) method: n − 1 points on a circle, a fixed point in the
 * middle, and in round r point r plays the middle while r ± i play each other. With an odd count
 * the middle is a BYE, and whoever draws it sits out that round (no match is emitted).
 *
 * Colours are not the circle method's: a pairing's colour comes from a fixed orientation of the
 * complete graph — on an odd number of points, a gets red against b exactly when b sits 1 … (q−1)/2
 * places after a around the circle, which gives every point (q−1)/2 reds and as many blues; with
 * an even count the last entry plays outside that circle and alternates by parity. So within one
 * cycle every entry's red and blue differ by at most one (by zero for an odd count). The second
 * cycle swaps every colour, the third is the first again.
 *
 * The seed only shuffles who sits where on the circle.
 */
export function drawRoundRobin(entries: number[], cycles: number, seed: number): DrawnMatch[] {
  const p = entries.length;
  if (p < 2) throw new Error('Needs at least 2 entries.');
  if (new Set(entries).size !== p) throw new Error('An entry is listed twice.');
  const c = Math.floor(cycles);
  if (!(c >= 1)) throw new Error('Needs at least one cycle.');
  const order = shuffle(entries, mulberry32(seed));
  const odd = p % 2 === 1;
  const N = odd ? p + 1 : p; // index p is the bye when odd
  const circle = N - 1;
  const q = odd ? p : p - 1; // the odd circle the colour orientation is taken on
  /** true when order[a] takes red against order[b] in the first cycle */
  const redFirst = (a: number, b: number): boolean => {
    if (!odd) {
      if (a === p - 1) return b % 2 === 1;
      if (b === p - 1) return a % 2 === 0;
    }
    const d = (((b - a) % q) + q) % q;
    return d >= 1 && d <= (q - 1) / 2;
  };
  const out: DrawnMatch[] = [];
  for (let cy = 0; cy < c; cy++) {
    for (let r = 0; r < circle; r++) {
      const round = cy * circle + r + 1;
      const pairs: [number, number][] = [[N - 1, r]];
      for (let i = 1; i < N / 2; i++) pairs.push([(r + i) % circle, (r - i + circle) % circle]);
      for (const [a, b] of pairs) {
        if (a >= p || b >= p) continue; // the bye
        const aRed = redFirst(a, b) !== (cy % 2 === 1);
        const [x, y] = aRed ? [a, b] : [b, a];
        out.push({ round, red: [{ entry: order[x] }], blue: [{ entry: order[y] }] });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// swiss
// ---------------------------------------------------------------------------------------------

export interface SwissRound {
  matches: DrawnMatch[];
  /** the entry sitting this round out (odd count), or null */
  bye: number | null;
}

/**
 * ONE SWISS ROUND, paired from the current `ranking` (entry ids, best first). One entry per
 * alliance.
 *
 * Bye: with an odd count, the lowest-ranked entry that has not had a bye yet sits out (the lowest
 * of all if everyone has). Who has had one comes from `byes` when given; without it, from
 * `colorCounts` — an entry with fewer than `round − 1` matches in it must have sat one out. Pass
 * `byes` when you have it: a voided match would otherwise read as a bye.
 *
 * Pairing: top-down, each entry taking the best-ranked opponent left that it has not met, with
 * backtracking when that strands someone further down. When no pairing avoids every rematch, the
 * search allows one rematch, then two, and so on, so the result has the fewest rematches there
 * are (bounded: a search that runs too long falls through to allowing more).
 *
 * Colour: red to the entry with fewer reds so far; on a tie, to the higher-ranked one.
 *
 * `seed` is accepted for symmetry with the other draws and reserved: the pairing is fully decided
 * by the ranking, which already carries the competition's coin.
 */
export function drawSwissRound(
  round: number,
  ranking: number[],
  played: [number, number][],
  colorCounts: Map<number, { red: number; blue: number }>,
  _seed: number,
  byes?: number[],
): SwissRound {
  const list = [...new Set(ranking)];
  let bye: number | null = null;
  if (list.length % 2 === 1) {
    const had = new Set<number>(
      byes ??
        list.filter((e) => {
          const cc = colorCounts.get(e);
          return (cc ? cc.red + cc.blue : 0) < round - 1;
        }),
    );
    let pickAt = list.length - 1;
    for (let i = list.length - 1; i >= 0; i--) {
      if (!had.has(list[i])) {
        pickAt = i;
        break;
      }
    }
    bye = list[pickAt];
    list.splice(pickAt, 1);
  }
  const met = new Set<string>();
  const key = (a: number, b: number): string => (a < b ? `${a},${b}` : `${b},${a}`);
  for (const [a, b] of played) met.add(key(a, b));

  const L = list.length;
  const used = new Uint8Array(L);
  const out: [number, number][] = [];
  const NODE_LIMIT = 200_000;
  let nodes = 0;
  let aborted = false;
  const rec = (budget: number): boolean => {
    let i = 0;
    while (i < L && used[i]) i++;
    if (i >= L) return true;
    used[i] = 1;
    for (let j = i + 1; j < L; j++) {
      if (used[j]) continue;
      const cost = met.has(key(list[i], list[j])) ? 1 : 0;
      if (cost > budget) continue;
      if (++nodes > NODE_LIMIT) {
        aborted = true;
        break;
      }
      used[j] = 1;
      out.push([i, j]);
      if (rec(budget - cost)) return true;
      out.pop();
      used[j] = 0;
      if (aborted) break;
    }
    used[i] = 0;
    return false;
  };
  for (let budget = 0; budget <= L / 2; budget++) {
    nodes = 0;
    aborted = false;
    used.fill(0);
    out.length = 0;
    if (rec(budget)) break;
  }

  const reds = (e: number): number => colorCounts.get(e)?.red ?? 0;
  const matches: DrawnMatch[] = out.map(([i, j]) => {
    const hi = list[i];
    const lo = list[j];
    const loRed = reds(lo) < reds(hi);
    return { round, red: [{ entry: loRed ? lo : hi }], blue: [{ entry: loRed ? hi : lo }] };
  });
  return { matches, bye };
}

// ---------------------------------------------------------------------------------------------
// quality
// ---------------------------------------------------------------------------------------------

export interface ScheduleQuality {
  /** COUNTED appearances per entry (surrogate appearances excluded) */
  appearances: Map<number, number>;
  /** surrogate appearances in the whole schedule */
  surrogates: number;
  /** partnerships beyond the first, summed over pairs: Σ max(0, c − 1) */
  partnerRepeats: number;
  /** opponent meetings beyond the first, summed over pairs */
  opponentRepeats: number;
  /** consecutive appearances of one entry in adjacent matches */
  backToBack: number;
  /** the largest |red − blue| of any entry, over every appearance (surrogates included) */
  maxColorImbalance: number;
  /** entries listed twice in one match, summed over matches (a legal schedule has none) */
  duplicates: number;
}

/** how good a drawn schedule is, by the measures `drawBalanced` optimizes */
export function scheduleQuality(matches: DrawnMatch[], perAlliance: 1 | 2): ScheduleQuality {
  const appearances = new Map<number, number>();
  const seen = new Map<number, number[]>();
  const colour = new Map<number, number>();
  const partnerC = new Map<string, number>();
  const oppC = new Map<string, number>();
  const key = (a: number, b: number): string => (a < b ? `${a},${b}` : `${b},${a}`);
  const bump = (m: Map<string, number>, a: number, b: number): void => {
    if (a === b) return;
    const k = key(a, b);
    m.set(k, (m.get(k) ?? 0) + 1);
  };
  let surrogates = 0;
  let duplicates = 0;
  matches.forEach((mt, i) => {
    const all = [...mt.red, ...mt.blue];
    for (const s of all) {
      if (!appearances.has(s.entry)) appearances.set(s.entry, 0);
      if (s.surrogate) surrogates++;
      else appearances.set(s.entry, appearances.get(s.entry)! + 1);
      const l = seen.get(s.entry) ?? [];
      l.push(i);
      seen.set(s.entry, l);
    }
    for (const s of mt.red) colour.set(s.entry, (colour.get(s.entry) ?? 0) + 1);
    for (const s of mt.blue) colour.set(s.entry, (colour.get(s.entry) ?? 0) - 1);
    const ids = all.map((s) => s.entry);
    duplicates += ids.length - new Set(ids).size;
    if (perAlliance === 2) {
      for (const side of [mt.red, mt.blue]) {
        for (let x = 0; x < side.length; x++) for (let y = x + 1; y < side.length; y++) bump(partnerC, side[x].entry, side[y].entry);
      }
    }
    for (const r of mt.red) for (const b of mt.blue) bump(oppC, r.entry, b.entry);
  });
  let backToBack = 0;
  for (const l of seen.values()) for (let x = 1; x < l.length; x++) if (l[x] - l[x - 1] === 1) backToBack++;
  let maxColorImbalance = 0;
  for (const v of colour.values()) maxColorImbalance = Math.max(maxColorImbalance, Math.abs(v));
  const repeats = (m: Map<string, number>): number => {
    let r = 0;
    for (const c of m.values()) r += Math.max(0, c - 1);
    return r;
  };
  return {
    appearances,
    surrogates,
    partnerRepeats: repeats(partnerC),
    opponentRepeats: repeats(oppC),
    backToBack,
    maxColorImbalance,
    duplicates,
  };
}
