/**
 * Competition verification — `npm run test:comp`.
 *
 * The pure competition modules (`src/competition/`): qualification schedules, rankings, alliance
 * selection and playoff brackets. All of them are functions of stored decisions (entries, matches,
 * selection actions) and a seed, so every case here is a function call and an assertion: no DB, no
 * sockets, no clock.
 *
 * What it guards is the part of a tournament nobody can see going wrong: an entry quietly playing
 * one match fewer, a partner repeated that did not need to be, a tie that advanced a series, a
 * placement handed to two alliances. Each of those would only surface as a complaint after the
 * event. The brackets are played to completion from `next` alone, at every size and format, the
 * way the server will drive them.
 *
 * Kept out of `npm test` on purpose: a red `npm test` must keep meaning "physics broke".
 */
import { drawBalanced, drawRoundRobin, drawSwissRound, scheduleQuality } from '../src/competition/schedule';
import { computeRankings, seedOrder } from '../src/competition/rankings';
import { applySelection, selectionState, serpentineAlliances, type Selection } from '../src/competition/selection';
import { bracketState, buildBracket, seedPositions } from '../src/competition/bracket';
import { hash32, mulberry32 } from '../src/competition/rng';
import type {
  BracketFormat,
  CompEntryCore,
  CompMatchCore,
  CompSettings,
  EntryStatus,
  PlayoffAlliance,
  RankRow,
  SelectionAction,
  SeriesSpec,
  Tiebreaker,
  Winner,
} from '../src/competition/types';

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}
const J = JSON.stringify;
const ids = (n: number, from = 1): number[] => Array.from({ length: n }, (_, i) => i + from);
const throws = (f: () => unknown): string | null => {
  try {
    f();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

// =============================================================================================
// rng
// =============================================================================================
{
  const a = mulberry32(42);
  const b = mulberry32(42);
  const xs = Array.from({ length: 5 }, () => a());
  const ys = Array.from({ length: 5 }, () => b());
  check('comp rng: mulberry32 is deterministic', J(xs) === J(ys));
  check('comp rng: mulberry32 stays in [0, 1)', xs.every((x) => x >= 0 && x < 1));
  check('comp rng: hash32 is stable and unsigned', hash32(7, 'x') === hash32(7, 'x') && hash32(7, 'x') >= 0 && Number.isInteger(hash32(7, 'x')));
  check('comp rng: hash32 separates parts', hash32(1, 23) !== hash32(12, 3));
}

// =============================================================================================
// balanced schedules
// =============================================================================================
{
  // THE GRID: every shape an organizer can pick, counted exactly
  const ns = [2, 3, 4, 5, 7, 8, 9, 12, 17, 24, 33, 64];
  for (const per of [1, 2] as const) {
    for (const n of ns) {
      if (n < 2 * per) continue;
      for (const m of [1, 3, 5, 8]) {
        const tag = `n=${n} ${per === 2 ? '2v2' : '1v1'} m=${m}`;
        const ents = ids(n, 101);
        const s = drawBalanced(ents, per, m, 1, 1000 + n * 10 + m);
        const q = scheduleQuality(s, per);
        const k = 2 * per;
        const M = Math.ceil((n * m) / k);
        const spare = M * k - n * m;
        const counts = ents.map((e) => q.appearances.get(e) ?? 0);
        check(`comp schedule: ${tag} — every entry plays exactly ${m} counted`, counts.every((c) => c === m), J(counts));
        const sur = new Map<number, number>();
        for (const mt of s) for (const sl of [...mt.red, ...mt.blue]) if (sl.surrogate) sur.set(sl.entry, (sur.get(sl.entry) ?? 0) + 1);
        check(
          `comp schedule: ${tag} — ${M} matches, ${spare} surrogates, at most one each`,
          s.length === M && q.surrogates === spare && [...sur.values()].every((c) => c === 1),
          J({ matches: s.length, surrogates: q.surrogates, spare }),
        );
        check(
          `comp schedule: ${tag} — no entry twice in a match, every alliance full`,
          q.duplicates === 0 && s.every((mt) => mt.red.length === per && mt.blue.length === per),
        );
        const rounds = s.map((mt) => mt.round);
        check(
          `comp schedule: ${tag} — rounds run 1…${m}, never decreasing`,
          rounds[0] === 1 && rounds[rounds.length - 1] === m && rounds.every((r, i) => i === 0 || r >= rounds[i - 1]),
          rounds.join(''),
        );
      }
    }
  }
}
{
  // DETERMINISM: the server stores the seed, and a re-draw must reproduce the schedule
  const a = drawBalanced(ids(17), 2, 5, 1, 99);
  const b = drawBalanced(ids(17), 2, 5, 1, 99);
  const c = drawBalanced(ids(17), 2, 5, 1, 100);
  check('comp schedule: same seed ⇒ identical schedule', J(a) === J(b));
  check('comp schedule: different seed ⇒ different schedule', J(a) !== J(c));
  const d = drawBalanced(ids(9), 1, 3, 1, 5);
  const e = drawBalanced(ids(9), 1, 3, 1, 5);
  check('comp schedule: same seed ⇒ identical (1v1, surrogates)', J(d) === J(e));
}
{
  // QUALITY where the numbers allow perfection, over several seeds
  for (const seed of [1, 2, 3, 4, 5]) {
    const s = drawBalanced(ids(16), 2, 5, 1, seed);
    const q = scheduleQuality(s, 2);
    check(`comp schedule: 16 entries 2v2 ×5 seed ${seed} — no repeated partner`, q.partnerRepeats === 0, `${q.partnerRepeats}`);
    check(`comp schedule: 16 entries 2v2 ×5 seed ${seed} — no back-to-back (minGap 1)`, q.backToBack === 0, `${q.backToBack}`);
    const s4 = drawBalanced(ids(16), 2, 4, 1, seed);
    const q4 = scheduleQuality(s4, 2);
    check(`comp schedule: 16 entries 2v2 ×4 seed ${seed} — colour imbalance ≤ 1`, q4.maxColorImbalance <= 1, `${q4.maxColorImbalance}`);
    const s1 = drawBalanced(ids(16), 1, 4, 1, seed);
    const q1 = scheduleQuality(s1, 1);
    check(
      `comp schedule: 16 entries 1v1 ×4 seed ${seed} — colour ≤ 1, no back-to-back, no repeated opponent`,
      q1.maxColorImbalance <= 1 && q1.backToBack === 0 && q1.opponentRepeats === 0,
      J({ col: q1.maxColorImbalance, b2b: q1.backToBack, opp: q1.opponentRepeats }),
    );
  }
  const big = drawBalanced(ids(24), 2, 5, 1, 7);
  const qb = scheduleQuality(big, 2);
  check('comp schedule: 24 entries 2v2 ×5 — no repeated partner or opponent, no back-to-back', qb.partnerRepeats === 0 && qb.opponentRepeats === 0 && qb.backToBack === 0, J(qb, (_k, v) => (v instanceof Map ? undefined : v)));
  const g2 = drawBalanced(ids(32), 2, 5, 2, 7);
  const lists = new Map<number, number[]>();
  g2.forEach((mt, i) => {
    for (const sl of [...mt.red, ...mt.blue]) lists.set(sl.entry, [...(lists.get(sl.entry) ?? []), i]);
  });
  let closest = Infinity;
  for (const l of lists.values()) for (let i = 1; i < l.length; i++) closest = Math.min(closest, l[i] - l[i - 1] - 1);
  check('comp schedule: 32 entries 2v2, minGap 2 — every gap is at least 2 matches', closest >= 2, `closest ${closest}`);
}
{
  // FOUR ENTRIES IN 2v2: every match is the same four, so partners can only rotate — evenly
  for (const m of [3, 6, 7]) {
    const s = drawBalanced(ids(4), 2, m, 1, 3);
    const pc = new Map<string, number>();
    for (const mt of s) for (const side of [mt.red, mt.blue]) {
      const [a, b] = [side[0].entry, side[1].entry].sort((x, y) => x - y);
      pc.set(`${a},${b}`, (pc.get(`${a},${b}`) ?? 0) + 1);
    }
    const counts = ['1,2', '1,3', '1,4', '2,3', '2,4', '3,4'].map((k) => pc.get(k) ?? 0);
    check(`comp schedule: 4 entries 2v2 ×${m} — partners rotate evenly`, Math.max(...counts) - Math.min(...counts) <= 1, J(counts));
    check(`comp schedule: 4 entries 2v2 ×${m} — every match holds all four`, s.every((mt) => new Set([...mt.red, ...mt.blue].map((x) => x.entry)).size === 4));
  }
}
{
  check('comp schedule: 3 entries in 2v2 is refused in plain English', throws(() => drawBalanced(ids(3), 2, 5, 1, 1)) === 'Needs at least 4 entries.');
  check('comp schedule: 1 entry in 1v1 is refused', throws(() => drawBalanced(ids(1), 1, 5, 1, 1)) === 'Needs at least 2 entries.');
  check('comp schedule: zero matches per entry is refused', throws(() => drawBalanced(ids(8), 1, 0, 1, 1)) !== null);
  check('comp schedule: a repeated entry is refused', throws(() => drawBalanced([1, 2, 2, 3], 1, 2, 1, 1)) !== null);
}
{
  // RUNTIME: the largest event the capacity limit allows a 2v2 to schedule
  const t = performance.now();
  const s = drawBalanced(ids(128), 2, 12, 1, 2026);
  const ms = performance.now() - t;
  const q = scheduleQuality(s, 2);
  check('comp schedule: 128 entries 2v2 ×12 draws in under 2 s', ms < 2000, `${ms.toFixed(0)} ms`);
  console.log(`      128 × 12 (2v2): ${ms.toFixed(0)} ms, ${s.length} matches, partner repeats ${q.partnerRepeats}, opponent repeats ${q.opponentRepeats}, back-to-back ${q.backToBack}, colour ≤ ${q.maxColorImbalance}`);
  check('comp schedule: 128 entries 2v2 ×12 — every entry 12, no duplicates', [...q.appearances.values()].every((c) => c === 12) && q.appearances.size === 128 && q.duplicates === 0);
}

// =============================================================================================
// round robin
// =============================================================================================
{
  for (let n = 2; n <= 13; n++) {
    for (const cycles of [1, 2, 3]) {
      const ents = ids(n, 11);
      const s = drawRoundRobin(ents, cycles, n * 7 + cycles);
      const N = n % 2 ? n + 1 : n;
      const perCycle = N - 1;
      const tag = `n=${n} ×${cycles}`;
      check(
        `comp roundrobin: ${tag} — ${(cycles * n * (n - 1)) / 2} matches over ${cycles * perCycle} rounds`,
        s.length === (cycles * n * (n - 1)) / 2 && Math.max(...s.map((m) => m.round)) === cycles * perCycle,
      );
      let pairsOk = true;
      let roundsOk = true;
      let byesOk = true;
      let colourOk = true;
      let swapOk = true;
      const firstColour = new Map<string, number>();
      for (let c = 0; c < cycles; c++) {
        const inCycle = s.filter((m) => m.round > c * perCycle && m.round <= (c + 1) * perCycle);
        const seen = new Map<string, number>();
        const col = new Map<number, number>();
        const sat = new Map<number, number>();
        for (let r = c * perCycle + 1; r <= (c + 1) * perCycle; r++) {
          const inRound = inCycle.filter((m) => m.round === r);
          const who = inRound.flatMap((m) => [m.red[0].entry, m.blue[0].entry]);
          if (new Set(who).size !== who.length) roundsOk = false;
          const out = ents.filter((e) => !who.includes(e));
          if (out.length !== n % 2) byesOk = false;
          for (const e of out) sat.set(e, (sat.get(e) ?? 0) + 1);
        }
        for (const m of inCycle) {
          const a = m.red[0].entry;
          const b = m.blue[0].entry;
          const key = a < b ? `${a},${b}` : `${b},${a}`;
          seen.set(key, (seen.get(key) ?? 0) + 1);
          col.set(a, (col.get(a) ?? 0) + 1);
          col.set(b, (col.get(b) ?? 0) - 1);
          if (c === 0) firstColour.set(key, a);
          else if (c === 1 && firstColour.get(key) !== b) swapOk = false;
        }
        if (seen.size !== (n * (n - 1)) / 2 || [...seen.values()].some((v) => v !== 1)) pairsOk = false;
        if (ents.some((e) => Math.abs(col.get(e) ?? 0) > 1)) colourOk = false;
        if (n % 2 === 1 && ents.some((e) => sat.get(e) !== 1)) byesOk = false;
      }
      check(`comp roundrobin: ${tag} — every pair meets exactly once per cycle`, pairsOk);
      check(`comp roundrobin: ${tag} — nobody plays twice in a round`, roundsOk);
      check(`comp roundrobin: ${tag} — ${n % 2 ? 'one bye per round, one per entry per cycle' : 'no byes'}`, byesOk);
      check(`comp roundrobin: ${tag} — red/blue differ by at most 1 per cycle`, colourOk);
      if (cycles >= 2) {
        check(`comp roundrobin: ${tag} — the second cycle swaps every colour`, swapOk);
        const tot = new Map<number, number>();
        for (const m of s.filter((x) => x.round <= 2 * perCycle)) {
          tot.set(m.red[0].entry, (tot.get(m.red[0].entry) ?? 0) + 1);
          tot.set(m.blue[0].entry, (tot.get(m.blue[0].entry) ?? 0) - 1);
        }
        check(`comp roundrobin: ${tag} — two cycles balance colours exactly`, ents.every((e) => (tot.get(e) ?? 0) === 0));
      }
    }
  }
  check('comp roundrobin: same seed ⇒ identical', J(drawRoundRobin(ids(9), 2, 5)) === J(drawRoundRobin(ids(9), 2, 5)));
  check('comp roundrobin: different seed ⇒ different', J(drawRoundRobin(ids(9), 1, 5)) !== J(drawRoundRobin(ids(9), 1, 6)));
  check('comp roundrobin: 1 entry is refused', throws(() => drawRoundRobin([1], 1, 1)) === 'Needs at least 2 entries.');
}

// =============================================================================================
// swiss
// =============================================================================================
/** the fewest rematches any pairing of `list` can have (brute force; small lists only) */
function minRematches(list: number[], met: Set<string>): number {
  if (list.length === 0) return 0;
  const [a, ...rest] = list;
  let best = Infinity;
  for (let i = 0; i < rest.length; i++) {
    const b = rest[i];
    const cost = met.has(a < b ? `${a},${b}` : `${b},${a}`) ? 1 : 0;
    best = Math.min(best, cost + minRematches([...rest.slice(0, i), ...rest.slice(i + 1)], met));
  }
  return best;
}
for (const n of [6, 7, 8]) {
  const ents = ids(n, 1);
  const rand = mulberry32(n * 31);
  const points = new Map<number, number>(ents.map((e) => [e, 0]));
  const colors = new Map<number, { red: number; blue: number }>();
  const played: [number, number][] = [];
  const met = new Set<string>();
  const byes: number[] = [];
  let noRematchEarly = true;
  let fewest = true;
  let colourRule = true;
  let inferredSame = true;
  let byeRule = true;
  let allPlay = true;
  const rounds = n + 1;
  for (let round = 1; round <= rounds; round++) {
    const ranking = ents.slice().sort((a, b) => points.get(b)! - points.get(a)! || hash32(9, b) - hash32(9, a));
    const res = drawSwissRound(round, ranking, played, colors, 9, byes);
    const inferred = drawSwissRound(round, ranking, played, colors, 9);
    if (J(res) !== J(inferred)) inferredSame = false;
    if (n % 2 === 1) {
      const expected = [...ranking].reverse().find((e) => !byes.includes(e)) ?? ranking[ranking.length - 1];
      if (res.bye !== expected) byeRule = false;
      if (res.bye != null) byes.push(res.bye);
    } else if (res.bye !== null) byeRule = false;
    const who = res.matches.flatMap((m) => [m.red[0].entry, m.blue[0].entry]);
    if (who.length + (res.bye == null ? 0 : 1) !== n || new Set(who).size !== who.length) allPlay = false;
    let rematches = 0;
    for (const m of res.matches) {
      const a = m.red[0].entry;
      const b = m.blue[0].entry;
      if (met.has(a < b ? `${a},${b}` : `${b},${a}`)) rematches++;
      const ra = colors.get(a)?.red ?? 0;
      const rb = colors.get(b)?.red ?? 0;
      if (ra > rb || (ra === rb && ranking.indexOf(a) > ranking.indexOf(b))) colourRule = false;
      if (m.round !== round) colourRule = false;
    }
    const pool = ranking.filter((e) => e !== res.bye);
    if (rematches !== minRematches(pool, met)) fewest = false;
    if (round <= 5 && rematches > 0) noRematchEarly = false;
    for (const m of res.matches) {
      const a = m.red[0].entry;
      const b = m.blue[0].entry;
      played.push([a, b]);
      met.add(a < b ? `${a},${b}` : `${b},${a}`);
      colors.set(a, { red: (colors.get(a)?.red ?? 0) + 1, blue: colors.get(a)?.blue ?? 0 });
      colors.set(b, { red: colors.get(b)?.red ?? 0, blue: (colors.get(b)?.blue ?? 0) + 1 });
      const r = rand();
      if (r < 0.45) points.set(a, points.get(a)! + 2);
      else if (r < 0.9) points.set(b, points.get(b)! + 2);
      else {
        points.set(a, points.get(a)! + 1);
        points.set(b, points.get(b)! + 1);
      }
    }
  }
  check(`comp swiss: ${n} entries — no rematch in the first 5 rounds`, noRematchEarly);
  check(`comp swiss: ${n} entries — every round has the fewest rematches possible (${rounds} rounds, brute-forced)`, fewest);
  check(`comp swiss: ${n} entries — everyone plays once a round (bar the bye)`, allPlay);
  check(`comp swiss: ${n} entries — red to fewer reds, ties to the higher rank`, colourRule);
  check(`comp swiss: ${n} entries — byes inferred from colour counts match the explicit list`, inferredSame);
  if (n % 2 === 1) {
    check(`comp swiss: ${n} entries — the bye goes to the lowest-ranked entry without one`, byeRule);
    const firstN = byes.slice(0, n);
    check(`comp swiss: ${n} entries — ${n} rounds give ${n} different byes`, new Set(firstN).size === n, J(byes));
  } else check(`comp swiss: ${n} entries — no bye with an even count`, byeRule);
}

// =============================================================================================
// rankings
// =============================================================================================
let mid = 1;
const ent = (id: number, status: EntryStatus = 'registered', seed: number | null = null, registeredAt = id): CompEntryCore => ({ id, status, seed, registeredAt });
const done = (
  red: (number | { entry: number; surrogate: true })[],
  blue: (number | { entry: number; surrogate: true })[],
  r: { red: number | null; blue: number | null; redFoul?: number; blueFoul?: number; winner?: Winner },
  extra: Partial<CompMatchCore> = {},
): CompMatchCore => {
  const winner: Winner = r.winner ?? (r.red! > r.blue! ? 'red' : r.red! < r.blue! ? 'blue' : 'tie');
  const slot = (x: number | { entry: number; surrogate: true }) => (typeof x === 'number' ? { entry: x } : x);
  const id = mid++;
  return {
    id,
    stage: 'qual',
    round: 1,
    number: id,
    series: null,
    red: red.map(slot),
    blue: blue.map(slot),
    status: 'done',
    result: { red: r.red, blue: r.blue, redFoul: r.redFoul ?? 0, blueFoul: r.blueFoul ?? 0, winner, source: r.red == null ? 'forfeit' : 'played' },
    dq: [],
    ...extra,
  };
};
const PTS: Pick<CompSettings, 'points' | 'tiebreakers'> = { points: { win: 2, tie: 1, loss: 0 }, tiebreakers: ['avgNoFoul', 'highScore', 'avgMargin'] };
const row = (rows: RankRow[], e: number): RankRow | undefined => rows.find((r) => r.entry === e);
{
  // 2v2: entries 1–4, plus a surrogate 5
  const entries = [1, 2, 3, 4, 5, 6].map((i) => ent(i));
  const matches = [
    done([1, 2], [3, 4], { red: 100, blue: 80, redFoul: 10, blueFoul: 5 }), // 1,2 win
    done([1, 3], [2, 4], { red: 50, blue: 50 }), // tie
    done([1, 4], [2, { entry: 5, surrogate: true }], { red: 30, blue: 60, blueFoul: 20 }), // 1,4 lose; 5 is a surrogate
    done([3, 5], [4, 2], { red: null, blue: null, winner: 'red' }), // forfeit: 3,5 win
    done([1, 2], [3, 4], { red: 999, blue: 0 }, { status: 'scheduled', result: null }), // not played
    done([1, 2], [3, 4], { red: 999, blue: 0 }, { status: 'void' }), // voided
    done([1, 2], [3, 4], { red: 999, blue: 0 }, { stage: 'playoff' }), // not a qual
  ];
  const rows = computeRankings(entries, matches, PTS, 1);
  const r1 = row(rows, 1)!;
  check('comp rankings: W-T-L and RP add up', r1.played === 3 && r1.wins === 1 && r1.ties === 1 && r1.losses === 1 && r1.rp === 3, J(r1));
  check('comp rankings: ranking score is RP per match played', r1.rs === 1);
  check('comp rankings: only done qual matches with a result count', row(rows, 2)!.played === 4);
  const r5 = row(rows, 5)!;
  check('comp rankings: a surrogate appearance does not count', r5.played === 1 && r5.wins === 1 && r5.rp === 2, J(r5));
  const r3 = row(rows, 3)!;
  check('comp rankings: a forfeit counts for W-L-T and RP but not for scored', r3.played === 3 && r3.scored === 2 && r3.wins === 1 && r3.rp === 3, J(r3));
  check('comp rankings: averages come from scored matches only', r3.avgScore === (80 + 50) / 2 && r3.highScore === 80, J(r3));
  check(
    'comp rankings: no-foul subtracts the fouls the alliance was GIVEN',
    r1.avgNoFoul === (100 - 10 + 50 + 30) / 3 && r1.avgScore === (100 + 50 + 30) / 3,
    J(r1),
  );
  const r2 = row(rows, 2)!;
  check('comp rankings: margin and fouls given away use the opponent side', r2.avgMargin === (20 + 0 + 30) / 3 && r2.avgFouls === (5 + 0 + 0) / 3, J(r2));
  check('comp rankings: ranks are 1…n with no shared places', rows.map((r) => r.rank).join(',') === ids(rows.length).join(','));
  check('comp rankings: an entry that played nothing ranks after every entry that did', rows[rows.length - 1].entry === 6 && rows[rows.length - 1].played === 0);
}
{
  // DQ in a match: no RP, recorded as a loss, still played; the partner is unaffected
  const entries = [1, 2, 3, 4].map((i) => ent(i));
  const matches = [done([1, 2], [3, 4], { red: 90, blue: 40 }, { dq: [1] })];
  const rows = computeRankings(entries, matches, PTS, 1);
  const a = row(rows, 1)!;
  const b = row(rows, 2)!;
  check('comp rankings: an entry DQ’d in a match takes 0 RP and a loss', a.rp === 0 && a.losses === 1 && a.wins === 0 && a.played === 1, J(a));
  check('comp rankings: …and that match is not in its score averages', a.scored === 0 && a.avgScore === 0);
  check('comp rankings: …while its partner keeps the win', b.rp === 2 && b.wins === 1 && b.scored === 1);
}
{
  // STATUS: disqualified last whatever it scored; withdrawn kept if it played; others left out
  const entries = [ent(1, 'disqualified'), ent(2), ent(3), ent(4, 'withdrawn'), ent(5, 'withdrawn'), ent(6, 'waitlist'), ent(7, 'pending')];
  const matches = [done([1], [2], { red: 100, blue: 0 }), done([1], [3], { red: 100, blue: 0 }), done([4], [3], { red: 10, blue: 0 })];
  const rows = computeRankings(entries, matches, PTS, 1);
  check('comp rankings: a disqualified entry ranks last, flagged', rows[rows.length - 1].entry === 1 && rows[rows.length - 1].disqualified, J(rows.map((r) => r.entry)));
  check('comp rankings: a withdrawn entry that played stays in the table', row(rows, 4) != null);
  check('comp rankings: a withdrawn entry that never played is left out', row(rows, 5) == null);
  check('comp rankings: waitlisted and pending entries are never ranked', row(rows, 6) == null && row(rows, 7) == null);
}
{
  // EACH TIEBREAKER DECIDES. Two entries on the same ranking score; in scenario A entry 1 is
  // better on the tiebreaker, in scenario B entry 2 is. The coin is fixed per entry, so if the
  // better one ranks first in BOTH, the tiebreaker decided it and not the coin.
  type Line = { own: number; opp: number; given?: number; gave?: number; result?: Winner };
  const scen: Record<Tiebreaker, [Line[], Line[]]> = {
    avgNoFoul: [[{ own: 90, opp: 0 }], [{ own: 100, opp: 0, given: 30 }]],
    avgScore: [[{ own: 100, opp: 0 }], [{ own: 90, opp: 0 }]],
    highScore: [[{ own: 80, opp: 0 }, { own: 10, opp: 0 }], [{ own: 50, opp: 0 }, { own: 50, opp: 0 }]],
    avgMargin: [[{ own: 60, opp: 0 }], [{ own: 100, opp: 90 }]],
    wins: [[{ own: 50, opp: 0 }, { own: 0, opp: 50 }], [{ own: 10, opp: 10, result: 'tie' }, { own: 10, opp: 10, result: 'tie' }]],
    fewestFouls: [[{ own: 50, opp: 0, gave: 0 }], [{ own: 50, opp: 0, gave: 20 }]],
  };
  for (const t of Object.keys(scen) as Tiebreaker[]) {
    const [better, worse] = scen[t];
    for (const flip of [false, true]) {
      const lines: [number, Line[]][] = flip ? [[1, worse], [2, better]] : [[1, better], [2, worse]];
      const matches: CompMatchCore[] = [];
      let opp = 100;
      for (const [e, ls] of lines) {
        for (const l of ls) {
          const winner: Winner = l.result ?? (l.own > l.opp ? 'red' : l.own < l.opp ? 'blue' : 'tie');
          matches.push(done([e], [opp++], { red: l.own, blue: l.opp, redFoul: l.given ?? 0, blueFoul: l.gave ?? 0, winner }));
        }
      }
      const entries = [1, 2, ...ids(opp - 100, 100)].map((i) => ent(i));
      const rows = computeRankings(entries, matches, { points: PTS.points, tiebreakers: [t] }, 77);
      const a = row(rows, 1)!;
      const b = row(rows, 2)!;
      const want = flip ? 2 : 1;
      const first = a.rank < b.rank ? 1 : 2;
      check(`comp rankings: tiebreaker ${t} decides (${flip ? 'entry 2' : 'entry 1'} better)`, a.rs === b.rs && first === want, J({ a, b }));
    }
  }
}
{
  // THE COIN: a full tie is settled by hash32(seed, entry), the same on every read
  const entries = ids(20).map((i) => ent(i));
  const r1 = computeRankings(entries, [], PTS, 5);
  const r2 = computeRankings(entries, [], PTS, 5);
  const r3 = computeRankings(entries, [], PTS, 6);
  const expect = ids(20).sort((a, b) => hash32(5, b) - hash32(5, a));
  check('comp rankings: a full tie falls to the coin, higher hash first', J(r1.map((r) => r.entry)) === J(expect));
  check('comp rankings: the coin is deterministic', J(r1) === J(r2));
  check('comp rankings: a different seed tosses a different coin', J(r1.map((r) => r.entry)) !== J(r3.map((r) => r.entry)));
}
{
  // SEEDING ORDER
  const entries = [ent(1, 'registered', null, 50), ent(2, 'registered', 2, 10), ent(3, 'registered', 1, 30), ent(4, 'withdrawn'), ent(5, 'registered', null, 20), ent(6, 'registered', null, 20), ent(7)];
  check('comp seeding: no rankings ⇒ manual seed, then registration order, then id', J(seedOrder(entries, null)) === J([3, 2, 7, 5, 6, 1]), J(seedOrder(entries, null)));
  const rows = computeRankings(entries, [done([1], [7], { red: 10, blue: 0 }), done([5], [6], { red: 10, blue: 0 })], PTS, 1);
  const order = seedOrder(entries, rows);
  check('comp seeding: ranked entries that played first, by rank; the rest after', J(order.slice(0, 4)) === J(rows.filter((r) => r.played > 0).map((r) => r.entry)) && J(order.slice(4)) === J([3, 2]), J(order));
  check('comp seeding: only registered entries are eligible', !order.includes(4));
}

// =============================================================================================
// alliance selection
// =============================================================================================
{
  const order = ids(10);
  const s0 = selectionState(order, 4, []);
  check('comp selection: the top N are captains, alliance 1 on turn', J(s0.alliances) === J([1, 2, 3, 4].map((e) => ({ seed: e, entries: [e] }))) && s0.turn === 0 && !s0.complete);
  check('comp selection: lower captains are available, the captain on turn is not', J(s0.available) === J([2, 3, 4, 5, 6, 7, 8, 9, 10]));
  const s1 = applySelection(s0, { kind: 'pick', entry: 5 }) as Selection;
  check('comp selection: a normal pick fills the alliance and passes the turn', J(s1.alliances[0].entries) === J([1, 5]) && s1.turn === 1 && J(s1.available) === J([3, 4, 6, 7, 8, 9, 10]));
  check('comp selection: applySelection does not mutate its input', J(s0.alliances[0].entries) === J([1]) && s0.turn === 0);
  const s2 = applySelection(s1, { kind: 'pick', entry: 4 }) as Selection;
  check(
    'comp selection: picking a lower captain dissolves its alliance, the rest move up, the next entry captains',
    J(s2.alliances.map((a) => a.entries)) === J([[1, 5], [2, 4], [3], [6]]) && J(s2.alliances.map((a) => a.seed)) === J([1, 2, 3, 4]) && s2.turn === 2,
    J(s2.alliances),
  );
  const s3 = applySelection(s2, { kind: 'decline', entry: 7 }) as Selection;
  check('comp selection: a decline keeps the turn and blocks the entry', s3.turn === 2 && J(s3.declined) === J([7]) && !s3.available.includes(7));
  const bad = applySelection(s3, { kind: 'pick', entry: 7 });
  check('comp selection: a declined entry cannot be picked later', 'error' in bad && /declined/.test(bad.error), J(bad));
  const s4 = applySelection(s3, { kind: 'pick', entry: 6 }) as Selection;
  check('comp selection: a declined entry can still become a captain', J(s4.alliances.map((a) => a.entries)) === J([[1, 5], [2, 4], [3, 6], [7]]) && s4.turn === 3, J(s4.alliances));
  const s5 = applySelection(s4, { kind: 'pick', entry: 8 }) as Selection;
  check('comp selection: the last pick completes it', s5.complete && s5.turn === null && s5.available.length === 0 && s5.stuck === undefined);
  const after = applySelection(s5, { kind: 'pick', entry: 9 });
  check('comp selection: nothing is accepted after completion', 'error' in after);

  const higher = applySelection(s1, { kind: 'pick', entry: 1 });
  const self = applySelection(s1, { kind: 'pick', entry: 2 });
  const partner = applySelection(s1, { kind: 'pick', entry: 5 });
  const stranger = applySelection(s1, { kind: 'pick', entry: 99 });
  check('comp selection: a higher captain cannot be picked', 'error' in higher && /higher-seeded/.test(higher.error));
  check('comp selection: a captain cannot pick itself', 'error' in self && /itself/.test(self.error));
  check('comp selection: a partner already taken cannot be picked', 'error' in partner && /already on an alliance/.test(partner.error));
  check('comp selection: an entry outside the order cannot be picked', 'error' in stranger && /not eligible/.test(stranger.error));

  const log: SelectionAction[] = [
    { kind: 'pick', entry: 5 },
    { kind: 'pick', entry: 1 }, // invalid: higher captain
    { kind: 'pick', entry: 4 },
    { kind: 'decline', entry: 7 },
    { kind: 'pick', entry: 7 }, // invalid: declined
    { kind: 'pick', entry: 6 },
    { kind: 'pick', entry: 42 }, // invalid: unknown
    { kind: 'pick', entry: 8 },
  ];
  const replay = selectionState(order, 4, log);
  check('comp selection: replay skips invalid actions and lands where the valid ones lead', J(replay) === J(s5), J(replay.alliances));
}
{
  const short = selectionState(ids(5), 3, [{ kind: 'pick', entry: 4 }, { kind: 'pick', entry: 5 }]);
  check('comp selection: too few entries never completes, and says why', !short.complete && short.turn === 2 && short.available.length === 0 && typeof short.stuck === 'string', J(short));
  const declinedOut = selectionState(ids(4), 2, [{ kind: 'decline', entry: 3 }, { kind: 'decline', entry: 4 }]);
  check('comp selection: declines that empty the pool leave it stuck, not complete', !declinedOut.complete && declinedOut.available.length === 1 && declinedOut.available[0] === 2);
  const after = applySelection(declinedOut, { kind: 'decline', entry: 2 }) as Selection;
  check('comp selection: …and a lower captain may decline too, staying a captain', after.alliances[1].entries[0] === 2 && after.available.length === 0 && typeof after.stuck === 'string');
}
{
  check('comp serpentine: 2 per alliance pairs rank i with rank 2N + 1 − i', J(serpentineAlliances(ids(8), 4, 2).map((a) => a.entries)) === J([[1, 8], [2, 7], [3, 6], [4, 5]]));
  check('comp serpentine: 1 per alliance is the top N alone', J(serpentineAlliances(ids(8), 4, 1)) === J([1, 2, 3, 4].map((e) => ({ seed: e, entries: [e] }))));
  check('comp serpentine: extra entries beyond 2N are left out', J(serpentineAlliances(ids(10), 2, 2).map((a) => a.entries)) === J([[1, 4], [2, 3]]));
}

// =============================================================================================
// brackets — structure
// =============================================================================================
{
  check('comp bracket: seed positions for 2', J(seedPositions(2)) === J([1, 2]));
  check('comp bracket: seed positions for 4', J(seedPositions(4)) === J([1, 4, 2, 3]));
  check('comp bracket: seed positions for 8', J(seedPositions(8)) === J([1, 8, 4, 5, 2, 7, 3, 6]));
  check('comp bracket: seed positions for 16', J(seedPositions(16)) === J([1, 16, 8, 9, 4, 13, 5, 12, 2, 15, 7, 10, 3, 14, 6, 11]));
}
/** keys unique, every feed points at an EARLIER series, every winner/loser consumed at most once */
function wellFormed(specs: SeriesSpec[]): string | null {
  const seen = new Set<string>();
  const used = new Set<string>();
  for (const s of specs) {
    if (seen.has(s.key)) return `duplicate ${s.key}`;
    for (const f of [s.redFrom, s.blueFrom]) {
      if (!f) continue;
      if (!seen.has(f.series)) return `${s.key} fed by later/unknown ${f.series}`;
      const u = `${f.series}:${f.take}`;
      if (used.has(u)) return `${u} consumed twice`;
      used.add(u);
    }
    if ((s.redFrom == null) !== (s.redSeed != null) || (s.blueFrom == null) !== (s.blueSeed != null)) return `${s.key} has both or neither of seed/feed`;
    seen.add(s.key);
  }
  return null;
}
for (const N of [2, 4, 8, 16] as const) {
  const sp = buildBracket(N, 'single', 1, 3);
  const k = Math.log2(N);
  check(`comp bracket: single ${N} — ${N - 1} series, well formed`, sp.length === N - 1 && wellFormed(sp) === null, wellFormed(sp) ?? '');
  const r1 = sp.filter((s) => s.redSeed != null);
  const pos = seedPositions(N);
  check(
    `comp bracket: single ${N} — round 1 pairs seed positions, better seed red`,
    r1.length === N / 2 && r1.every((s, i) => s.redSeed === Math.min(pos[2 * i], pos[2 * i + 1]) && s.blueSeed === Math.max(pos[2 * i], pos[2 * i + 1])),
  );
  const later = sp.filter((s) => s.redFrom != null);
  check(`comp bracket: single ${N} — later rounds take two winners`, later.every((s) => s.redFrom!.take === 'winner' && s.blueFrom!.take === 'winner'));
  const fin = sp[sp.length - 1];
  check(`comp bracket: single ${N} — the final is F, best of finalsBestOf`, fin.key === 'F' && fin.side === 'final' && fin.bestOf === 3 && fin.label === 'Final' && sp.slice(0, -1).every((s) => s.bestOf === 1 && s.side === 'upper'));
  if (N >= 4) check(`comp bracket: single ${N} — semifinals named`, J(sp.filter((s) => s.side === 'upper' && s.round === k - 1).map((s) => s.short)) === J(['SF1', 'SF2']));
  if (N >= 8) check(`comp bracket: single ${N} — quarterfinals named`, J(sp.filter((s) => s.side === 'upper' && s.round === k - 2).map((s) => s.short)) === J(['QF1', 'QF2', 'QF3', 'QF4']));
  if (N === 16) check('comp bracket: single 16 — round of 16 named', sp[0].label === 'Round of 16, series 1' && sp[0].short === 'R16-1');
}
{
  const d4 = buildBracket(4, 'double', 1, 3);
  const shape = d4.map((s) => [s.key, s.side, s.redSeed, s.blueSeed, s.redFrom && `${s.redFrom.take[0]}:${s.redFrom.series}`, s.blueFrom && `${s.blueFrom.take[0]}:${s.blueFrom.series}`]);
  check(
    'comp bracket: double 4 — exactly U1-1 (1v4), U1-2 (2v3), L1-1, U2-1, L2-1, F',
    J(shape) ===
      J([
        ['U1-1', 'upper', 1, 4, null, null],
        ['U1-2', 'upper', 2, 3, null, null],
        ['L1-1', 'lower', null, null, 'l:U1-1', 'l:U1-2'],
        ['U2-1', 'upper', null, null, 'w:U1-1', 'w:U1-2'],
        ['L2-1', 'lower', null, null, 'l:U2-1', 'w:L1-1'],
        ['F', 'final', null, null, 'w:U2-1', 'w:L2-1'],
      ]),
    J(shape),
  );
  check(
    'comp bracket: double 4 — labels',
    J(d4.map((s) => s.label)) === J(['Upper round 1, series 1', 'Upper round 1, series 2', 'Lower round 1, series 1', 'Upper final', 'Lower final', 'Final']) &&
      J(d4.map((s) => s.short)) === J(['U1-1', 'U1-2', 'L1-1', 'U2-1', 'L2-1', 'F']),
  );
  for (const N of [4, 8, 16] as const) {
    const d = buildBracket(N, 'double', 3, 5);
    const up = d.filter((s) => s.side === 'upper').length;
    const lo = d.filter((s) => s.side === 'lower').length;
    check(`comp bracket: double ${N} — 2N − 2 = ${2 * N - 2} series (${N - 1} upper, ${N - 2} lower, 1 final), well formed`, d.length === 2 * N - 2 && up === N - 1 && lo === N - 2 && wellFormed(d) === null, `${d.length} ${wellFormed(d) ?? ''}`);
    const losersOut = d.filter((s) => s.side === 'upper').every((s) => d.some((t) => t.side === 'lower' && [t.redFrom, t.blueFrom].some((f) => f?.series === s.key && f.take === 'loser')));
    check(`comp bracket: double ${N} — every upper loser drops into the lower bracket`, losersOut);
    check(`comp bracket: double ${N} — best-of applied`, d.every((s) => s.bestOf === (s.key === 'F' ? 5 : 3)));
  }
  const d8 = buildBracket(8, 'double', 1, 1);
  const l2 = d8.filter((s) => s.key.startsWith('L2-')).map((s) => s.redFrom!.series);
  check('comp bracket: double 8 — L2 takes the upper round 2 losers REVERSED', J(l2) === J(['U2-2', 'U2-1']), J(l2));
  const d16 = buildBracket(16, 'double', 1, 1);
  const l2b = d16.filter((s) => s.key.startsWith('L2-')).map((s) => s.redFrom!.series);
  const l4 = d16.filter((s) => s.key.startsWith('L4-')).map((s) => s.redFrom!.series);
  check('comp bracket: double 16 — L2 reversed, L4 straight', J(l2b) === J(['U2-4', 'U2-3', 'U2-2', 'U2-1']) && J(l4) === J(['U3-1', 'U3-2']), J({ l2b, l4 }));
  check('comp bracket: double 2 is just a final', J(buildBracket(2, 'double', 1, 3)) === J(buildBracket(2, 'single', 1, 3)) && buildBracket(2, 'double', 1, 3).length === 1);
}

// =============================================================================================
// brackets — played to completion from `next`, at every size and format
// =============================================================================================
/** places the structure hands out, best first */
function expectedPlaces(N: number, format: BracketFormat): number[] {
  if (N === 2) return [1, 2];
  const out = [1, 2];
  if (format === 'single') {
    for (let size = 2; size < N; size *= 2) for (let i = 0; i < size; i++) out.push(size + 1);
    return out;
  }
  // double: lower rounds latest → earliest: 1, 1, 2, 2, 4, 4, … series
  const k = Math.log2(N);
  const counts: number[] = [];
  let c = N / 4;
  for (let j = 1; j <= 2 * k - 2; j++) {
    if (j > 1 && j % 2 === 1) c /= 2;
    counts.push(c);
  }
  let ahead = 2;
  for (let j = counts.length - 1; j >= 0; j--) {
    for (let i = 0; i < counts[j]; i++) out.push(ahead + 1);
    ahead += counts[j];
  }
  return out;
}
const exercised = { ties: 0, voids: 0, swaps: 0, champFromUpper: 0, champFromLower: 0 };
for (const N of [2, 4, 8, 16] as const) {
  for (const format of ['single', 'double'] as const) {
    for (const bestOf of [1, 3]) {
      for (const finalsBestOf of [1, 3]) {
        const tag = `${format} ${N} bo${bestOf}/F bo${finalsBestOf}`;
        const specs = buildBracket(N, format, bestOf, finalsBestOf);
        const alliances: PlayoffAlliance[] = ids(N).map((seed) => ({ seed, entries: [1000 + seed * 2, 1001 + seed * 2] }));
        const allianceOf = (entry: number): number => alliances.find((a) => a.entries.includes(entry))!.seed;
        const rand = mulberry32(N * 100 + bestOf * 10 + finalsBestOf + (format === 'double' ? 7 : 0));
        const matches: CompMatchCore[] = [];
        let id = 1;
        let sameSides = false;
        let tieAdvanced = false;
        let nextWhilePending = false;
        let numbering = true;
        let winsMatch = true;
        let placesStable = true;
        let lateAppearance = false;
        const placedAt = new Map<number, number>();
        const eliminatedAt = new Map<number, number>(); // alliance → step it went out
        const expectWins = new Map<string, Map<number, number>>();
        let st = bracketState(specs, alliances, matches);
        let step = 0;
        let ties = 0;
        let swaps = 0;
        let voids = 0;
        for (; step < 2000 && !st.complete; step++) {
          for (const s of st.series) {
            if (s.red != null && s.red === s.blue) sameSides = true;
            const ew = expectWins.get(s.key);
            if (ew && s.red != null && s.blue != null && ((ew.get(s.red) ?? 0) !== s.redWins || (ew.get(s.blue) ?? 0) !== s.blueWins)) winsMatch = false;
            for (const a of [s.red, s.blue]) if (a != null && s.winner == null && eliminatedAt.has(a)) lateAppearance = true;
          }
          for (const p of st.placements) {
            if (placedAt.has(p.alliance) && placedAt.get(p.alliance) !== p.place) placesStable = false;
            placedAt.set(p.alliance, p.place);
            if (p.place !== 1) eliminatedAt.set(p.alliance, step);
          }
          const pending = matches.filter((m) => m.status === 'scheduled');
          if (pending.length) {
            for (const m of pending) {
              if (st.next.some((n) => n.series === m.series)) nextWhilePending = true;
              const r = rand();
              if (r < 0.05) {
                m.status = 'void';
                voids++;
                continue;
              }
              const winner: Winner = r < 0.2 ? 'tie' : r < 0.6 ? 'red' : 'blue';
              m.status = 'done';
              m.result = { red: 10, blue: 10, redFoul: 0, blueFoul: 0, winner, source: 'played' };
              if (winner === 'tie') ties++;
              else {
                const won = allianceOf((winner === 'red' ? m.red : m.blue)[0].entry);
                const w = expectWins.get(m.series!) ?? new Map<number, number>();
                w.set(won, (w.get(won) ?? 0) + 1);
                expectWins.set(m.series!, w);
              }
            }
            const before = st;
            st = bracketState(specs, alliances, matches);
            // a tie must not move a series: same wins, same (absent) winner
            for (const m of pending) {
              if (m.result?.winner !== 'tie') continue;
              const a = before.series.find((s) => s.key === m.series)!;
              const b = st.series.find((s) => s.key === m.series)!;
              if (a.redWins !== b.redWins || a.blueWins !== b.blueWins || (a.winner == null && b.winner != null)) tieAdvanced = true;
            }
            continue;
          }
          if (st.next.length === 0) break; // stuck: reported below as not complete
          for (const n of st.next) {
            const nonVoid = matches.filter((m) => m.series === n.series && m.status !== 'void').length;
            if (n.number !== nonVoid + 1 || n.red >= n.blue) numbering = false;
            const swap = rand() < 0.3; // play some matches with the colours the other way round
            if (swap) swaps++;
            const redA = swap ? n.blue : n.red;
            const blueA = swap ? n.red : n.blue;
            matches.push({
              id: id++,
              stage: 'playoff',
              round: 0,
              number: n.number,
              series: n.series,
              red: alliances[redA - 1].entries.map((e) => ({ entry: e })),
              blue: alliances[blueA - 1].entries.map((e) => ({ entry: e })),
              status: 'scheduled',
              result: null,
              dq: [],
            });
          }
          st = bracketState(specs, alliances, matches);
        }
        for (const p of st.placements) {
          if (placedAt.has(p.alliance) && placedAt.get(p.alliance) !== p.place) placesStable = false;
        }
        check(`comp playoff: ${tag} — reaches completion with exactly one champion`, st.complete && st.champion != null && st.placements.filter((p) => p.place === 1).length === 1, `steps ${step}`);
        const placedOnce = ids(N).every((a) => st.placements.filter((p) => p.alliance === a).length === 1) && st.placements.length === N;
        check(`comp playoff: ${tag} — every alliance placed exactly once`, placedOnce, J(st.placements.map((p) => [p.alliance, p.place])));
        const places = st.placements.map((p) => p.place).sort((a, b) => a - b);
        check(`comp playoff: ${tag} — places are ${J(expectedPlaces(N, format))}`, J(places) === J(expectedPlaces(N, format)), J(places));
        check(`comp playoff: ${tag} — placements carry the alliance's entries`, st.placements.every((p) => J(p.entries) === J(alliances[p.alliance - 1].entries)));
        check(`comp playoff: ${tag} — no series ever had one alliance on both sides`, !sameSides);
        check(`comp playoff: ${tag} — ties never advanced a series (${ties} ties, ${voids} voids)`, !tieAdvanced);
        check(`comp playoff: ${tag} — nothing new is offered while a match is scheduled`, !nextWhilePending);
        check(`comp playoff: ${tag} — next numbers count non-void matches, better seed red`, numbering);
        check(`comp playoff: ${tag} — wins credited by alliance even with colours swapped (${swaps} swaps)`, winsMatch);
        check(`comp playoff: ${tag} — a placement never changes once given`, placesStable);
        check(`comp playoff: ${tag} — an eliminated alliance never plays again`, !lateAppearance);
        check(`comp playoff: ${tag} — every series decided`, st.series.every((s) => s.winner != null && s.loser != null));

        const losses = new Map<number, number>();
        const wins = new Map<number, number>();
        for (const s of st.series) {
          if (s.loser != null) losses.set(s.loser, (losses.get(s.loser) ?? 0) + 1);
          if (s.winner != null) wins.set(s.winner, (wins.get(s.winner) ?? 0) + 1);
        }
        const champ = st.champion ?? -1;
        const fin = st.series.find((s) => s.key === 'F')!;
        const runnerUp = fin.loser ?? -1;
        if (format === 'single' || N === 2) {
          const ok = ids(N).every((a) => (losses.get(a) ?? 0) === (a === champ ? 0 : 1));
          check(`comp playoff: ${tag} — one loss eliminates, the champion has none`, ok, J([...losses]));
          check(`comp playoff: ${tag} — the champion won every round`, (wins.get(champ) ?? 0) === Math.log2(N));
        } else {
          const k = Math.log2(N);
          const upperFinal = st.series.find((s) => s.key === `U${k}-1`)!;
          const fromUpper = (a: number): boolean => upperFinal.winner === a;
          const ok = ids(N).every((a) => {
            const l = losses.get(a) ?? 0;
            if (a === champ) return l === (fromUpper(a) ? 0 : 1);
            if (a === runnerUp) return l === (fromUpper(a) ? 1 : 2);
            return l === 2;
          });
          check(`comp playoff: ${tag} — two losses eliminate (final loser: 1 from the upper side, 2 from the lower; champion 0 or 1 likewise)`, ok, J([...losses]));
        }
        exercised.ties += ties;
        exercised.voids += voids;
        exercised.swaps += swaps;
        if (format === 'double' && N > 2) {
          if (st.series.find((s) => s.key === `U${Math.log2(N)}-1`)!.winner === champ) exercised.champFromUpper++;
          else exercised.champFromLower++;
        }
        const total = st.series.reduce((n, s) => n + s.matches.length, 0);
        check(`comp playoff: ${tag} — series list their non-void matches`, total === matches.filter((m) => m.status !== 'void').length);
      }
    }
  }
}

check(
  'comp playoff: the playthroughs exercised ties, voids and swapped colours',
  exercised.ties > 10 && exercised.voids > 3 && exercised.swaps > 30,
  J(exercised),
);
check(
  'comp playoff: double elimination was won from both sides of the bracket (both final-loss counts asserted)',
  exercised.champFromUpper > 0 && exercised.champFromLower > 0,
  J(exercised),
);

// =============================================================================================
// brackets — robustness
// =============================================================================================
{
  // three alliances in a four-bracket: seed 4 has no alliance, so seed 1 walks over
  const specs = buildBracket(4, 'single', 1, 1);
  const three: PlayoffAlliance[] = [1, 2, 3].map((seed) => ({ seed, entries: [seed * 10] }));
  const st = bracketState(specs, three, []);
  const sf1 = st.series.find((s) => s.key === 'U1-1')!;
  check('comp bracket: a seed with no alliance is a walkover', sf1.winner === 1 && sf1.loser === null && sf1.matches.length === 0);
  check('comp bracket: …and only the real series is offered', J(st.next.map((n) => n.series)) === J(['U1-2']));
}
{
  const specs = buildBracket(4, 'single', 3, 3);
  const al: PlayoffAlliance[] = [1, 2, 3, 4].map((seed) => ({ seed, entries: [seed * 10, seed * 10 + 1] }));
  const mk = (mid: number, series: string, red: number, blue: number, status: CompMatchCore['status'], winner: Winner | null, number: number): CompMatchCore => ({
    id: mid,
    stage: 'playoff',
    round: 0,
    number,
    series,
    red: al[red - 1].entries.map((e) => ({ entry: e })),
    blue: al[blue - 1].entries.map((e) => ({ entry: e })),
    status,
    result: winner ? { red: 1, blue: 1, redFoul: 0, blueFoul: 0, winner, source: 'played' } : null,
    dq: [],
  });
  const ms = [mk(1, 'U1-1', 1, 4, 'done', 'red', 1), mk(2, 'U1-1', 1, 4, 'void', null, 2)];
  const st = bracketState(specs, al, ms);
  const n = st.next.find((x) => x.series === 'U1-1');
  check('comp bracket: a void match is ignored, and the next number skips it', n?.number === 2 && st.series[0].redWins === 1 && J(st.series[0].matches) === J([1]), J(n));
  const garbage: CompMatchCore[] = [
    { ...mk(3, 'U1-2', 2, 3, 'done', 'red', 1), red: [{ entry: 9999 }] }, // entry on no alliance
    { ...mk(4, 'NOPE', 2, 3, 'done', 'red', 1) }, // unknown series
    { ...mk(5, 'U1-2', 2, 3, 'done', 'red', 1), red: [] }, // empty side
    { ...mk(6, 'U1-2', 2, 2, 'done', 'red', 1) }, // one alliance on both sides
  ];
  let threw = false;
  let st2 = st;
  try {
    st2 = bracketState(specs, al, [...ms, ...garbage]);
  } catch {
    threw = true;
  }
  check('comp bracket: inconsistent matches are ignored, never thrown on', !threw && st2.series.find((s) => s.key === 'U1-2')!.redWins === 0 && st2.series.find((s) => s.key === 'U1-2')!.blueWins === 0);
  let threw2 = false;
  try {
    bracketState([...specs, { ...specs[0] }, { ...specs[1], key: 'X', redFrom: { series: 'X', take: 'winner' }, redSeed: null }], [], []);
  } catch {
    threw2 = true;
  }
  check('comp bracket: duplicate keys, self-feeds and no alliances do not throw', !threw2);
}

console.log(failures === 0 ? `\nALL PASS (${checks} checks)` : `\n${failures} FAILURES (of ${checks} checks)`);
process.exit(failures === 0 ? 0 : 1);
