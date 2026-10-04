/**
 * PLAYOFF BRACKETS: the static structure (`buildBracket`) and everything derived from the played
 * matches (`bracketState`).
 *
 * The structure is generated once when the playoffs start and never changes. Who is in each
 * series, who has won it, what to play next and the final placements are all recomputed from the
 * matches on every read, so a corrected result re-routes the bracket and there is no stored
 * progress to fall out of step.
 */
import type { BracketFormat, CompMatchCore, Placement, PlayoffAlliance, SeriesFeed, SeriesSpec, SeriesState } from './types';

/**
 * Standard bracket order: seed 1 meets the lowest seed, and the top two seeds can only meet in the
 * final. 2 → [1,2], 4 → [1,4,2,3], 8 → [1,8,4,5,2,7,3,6]. Built by replacing every seed s with
 * (s, 2m + 1 − s) as the field doubles to m·2. A size that is not a power of two rounds up.
 */
export function seedPositions(n: number): number[] {
  let p = [1];
  while (p.length < n) {
    const size = p.length * 2;
    p = p.flatMap((s) => [s, size + 1 - s]);
  }
  return p;
}

const winnerOf = (series: string): SeriesFeed => ({ series, take: 'winner' });
const loserOf = (series: string): SeriesFeed => ({ series, take: 'loser' });

/**
 * THE BRACKET'S SERIES, in a playable order (every series after the ones that feed it).
 *
 * SINGLE ELIMINATION: log2 N rounds. Round 1 pairs `seedPositions(N)` two at a time, later rounds
 * take the winners of two adjacent series. Keys `U{round}-{position}`, the final `F`. The last
 * rounds are named Final / Semifinal n / Quarterfinal n (F, SF1, QF1); anything earlier is
 * "Round of 16, series n" (R16-1).
 *
 * DOUBLE ELIMINATION (N ≥ 4; N = 2 is just a final): with k = log2 N,
 *   - upper rounds U1 … Uk (N/2, N/4, … 1 series), Uk being the upper final;
 *   - lower rounds L1 … L(2k − 2):
 *       L1 pairs the losers of U1 (N/4 series);
 *       even rounds are DROP-INS: the winners of the round before against the losers of upper
 *         round j/2 + 1, the dropping losers fed in REVERSED order on every other drop-in round
 *         (L2, L6, …), so an alliance does not drop straight back into the one it just lost to;
 *       odd rounds from L3 pair the winners of the round before among themselves;
 *       the last is the lower final (lower survivor against the upper final's loser);
 *   - the grand final F: upper final winner against lower final winner. No bracket reset.
 * Series count: (N − 1) upper + (N − 2) lower + 1 final = 2N − 2. N = 4 gives exactly U1-1 (1v4),
 * U1-2 (2v3), L1-1, U2-1 (the upper final), L2-1 (the lower final), F.
 *
 * The final plays `finalsBestOf`; every other series `bestOf`.
 */
export function buildBracket(alliances: 2 | 4 | 8 | 16, format: BracketFormat, bestOf: number, finalsBestOf: number): SeriesSpec[] {
  const N = seedPositions(Math.max(2, alliances)).length;
  const k = Math.round(Math.log2(N));
  const sp = seedPositions(N);
  const out: SeriesSpec[] = [];
  const firstRound = (key: string, side: SeriesSpec['side'], p: number, label: string, short: string, bo: number): SeriesSpec => {
    const a = sp[2 * (p - 1)];
    const b = sp[2 * (p - 1) + 1];
    return { key, side, round: 1, position: p, label, short, bestOf: bo, redSeed: Math.min(a, b), blueSeed: Math.max(a, b), redFrom: null, blueFrom: null };
  };
  const fed = (key: string, side: SeriesSpec['side'], round: number, p: number, label: string, short: string, bo: number, red: SeriesFeed, blue: SeriesFeed): SeriesSpec => ({
    key, side, round, position: p, label, short, bestOf: bo, redSeed: null, blueSeed: null, redFrom: red, blueFrom: blue,
  });

  if (format === 'single' || N === 2) {
    const keyOf = (r: number, p: number): string => (r === k ? 'F' : `U${r}-${p}`);
    for (let r = 1; r <= k; r++) {
      const count = N >> r;
      const fromEnd = k - r;
      for (let p = 1; p <= count; p++) {
        const key = keyOf(r, p);
        let label: string;
        let short: string;
        if (fromEnd === 0) [label, short] = ['Final', 'F'];
        else if (fromEnd === 1) [label, short] = [`Semifinal ${p}`, `SF${p}`];
        else if (fromEnd === 2) [label, short] = [`Quarterfinal ${p}`, `QF${p}`];
        else {
          const left = N >> (r - 1);
          [label, short] = [`Round of ${left}, series ${p}`, `R${left}-${p}`];
        }
        const side = fromEnd === 0 ? 'final' : 'upper';
        const bo = fromEnd === 0 ? finalsBestOf : bestOf;
        const round = fromEnd === 0 ? 1 : r;
        const position = fromEnd === 0 ? 1 : p;
        if (r === 1) out.push({ ...firstRound(key, side, p, label, short, bo), round, position });
        else out.push(fed(key, side, round, position, label, short, bo, winnerOf(keyOf(r - 1, 2 * p - 1)), winnerOf(keyOf(r - 1, 2 * p))));
      }
    }
    return out;
  }

  const lowerRounds = 2 * k - 2;
  const lowerCount: number[] = [];
  const upper = (r: number): void => {
    for (let p = 1; p <= N >> r; p++) {
      const key = `U${r}-${p}`;
      const label = r === k ? 'Upper final' : `Upper round ${r}, series ${p}`;
      if (r === 1) out.push(firstRound(key, 'upper', p, label, key, bestOf));
      else out.push(fed(key, 'upper', r, p, label, key, bestOf, winnerOf(`U${r - 1}-${2 * p - 1}`), winnerOf(`U${r - 1}-${2 * p}`)));
    }
  };
  const lower = (j: number): void => {
    const count = j === 1 ? N >> 2 : j % 2 === 0 ? lowerCount[j - 1] : lowerCount[j - 1] >> 1;
    lowerCount[j] = count;
    for (let p = 1; p <= count; p++) {
      const key = `L${j}-${p}`;
      const label = j === lowerRounds ? 'Lower final' : `Lower round ${j}, series ${p}`;
      let red: SeriesFeed;
      let blue: SeriesFeed;
      if (j === 1) {
        red = loserOf(`U1-${2 * p - 1}`);
        blue = loserOf(`U1-${2 * p}`);
      } else if (j % 2 === 0) {
        const u = j / 2 + 1;
        const reversed = (j / 2) % 2 === 1;
        red = loserOf(`U${u}-${reversed ? count + 1 - p : p}`);
        blue = winnerOf(`L${j - 1}-${p}`);
      } else {
        red = winnerOf(`L${j - 1}-${2 * p - 1}`);
        blue = winnerOf(`L${j - 1}-${2 * p}`);
      }
      out.push(fed(key, 'lower', j, p, label, key, bestOf, red, blue));
    }
  };
  upper(1);
  lower(1);
  for (let r = 2; r <= k; r++) {
    upper(r);
    if (r >= 3) lower(2 * r - 3);
    lower(2 * r - 2);
  }
  out.push(fed('F', 'final', 1, 1, 'Final', 'F', finalsBestOf, winnerOf(`U${k}-1`), winnerOf(`L${lowerRounds}-1`)));
  return out;
}

export interface BracketState {
  series: SeriesState[];
  /** placements decided so far: eliminated alliances as they go out, the top two once the final is won */
  placements: Placement[];
  champion: number | null;
  complete: boolean;
  /** the next match to create for every series that is ready and has nothing scheduled */
  next: { series: string; red: number; blue: number; number: number }[];
}

/**
 * A side of a series, resolved: an alliance seed (> 0), NOBODY (0: a seed with no alliance, or
 * the loser of a walkover), or not known yet (null).
 */
type Side = number | null;

/**
 * THE BRACKET'S PROGRESS, derived from the playoff matches.
 *
 * A series' alliances come from its seeds (first round) or its feeds; once both are known the
 * better (lower) seed is red. A match is credited by ALLIANCE, not by colour: its red side is the
 * alliance holding `match.red[0].entry`, so a match played with the colours swapped still counts
 * for the right alliance. Only `done` matches with a red or blue winner count (a tie counts for
 * nobody, and the series needs another match); `void` matches are ignored entirely; a match whose
 * entries are not the series' two alliances is ignored. First to ceil(bestOf / 2) wins.
 *
 * A series' `matches` are its non-void matches in `number` order. `next` has one entry for every
 * series with both alliances known, no winner and nothing `scheduled` or `called`, numbered
 * (non-void matches of that series) + 1, better seed red.
 *
 * A seed with no alliance is a bye: its series is a walkover for the other side, with no loser.
 *
 * PLACEMENTS. An alliance's place is 1 + the number of alliances that finish ahead of it, and it is
 * fixed by the round it is knocked out in: single elimination — final loser 2, semifinal losers 3,
 * quarterfinal losers 5, round-of-16 losers 9; double elimination — final loser 2, lower final
 * loser 3, then each earlier lower round's losers sharing the next place (N = 8: 4, 5–6, 7–8).
 * An eliminated alliance is placed as soon as it is out.
 *
 * Never throws on inconsistent data.
 */
export function bracketState(specs: SeriesSpec[], alliances: PlayoffAlliance[], matches: CompMatchCore[]): BracketState {
  const bySeed = new Map<number, PlayoffAlliance>();
  const allianceOf = new Map<number, number>();
  for (const a of alliances) {
    bySeed.set(a.seed, a);
    for (const e of a.entries) allianceOf.set(e, a.seed);
  }
  const byKey = new Map<string, SeriesSpec>();
  for (const s of specs) if (!byKey.has(s.key)) byKey.set(s.key, s);
  const seriesMatches = new Map<string, CompMatchCore[]>();
  for (const m of matches) {
    if (m.stage !== 'playoff' || m.series == null || !byKey.has(m.series)) continue;
    const l = seriesMatches.get(m.series) ?? [];
    l.push(m);
    seriesMatches.set(m.series, l);
  }
  for (const l of seriesMatches.values()) l.sort((a, b) => a.number - b.number || a.id - b.id);

  const solved = new Map<string, { st: SeriesState; w: Side; l: Side; pending: boolean }>();
  const visiting = new Set<string>();
  const side = (feed: SeriesFeed | null, seed: number | null): Side => {
    if (feed) {
      const r = solve(feed.series);
      if (!r) return 0;
      return feed.take === 'winner' ? r.w : r.l;
    }
    return seed != null && bySeed.has(seed) ? seed : 0;
  };
  const solve = (key: string): { st: SeriesState; w: Side; l: Side; pending: boolean } | null => {
    const done = solved.get(key);
    if (done) return done;
    const spec = byKey.get(key);
    if (!spec || visiting.has(key)) return null; // an unknown feed or a cycle: nobody comes from it
    visiting.add(key);
    const a = side(spec.redFrom, spec.redSeed);
    const b = side(spec.blueFrom, spec.blueSeed);
    visiting.delete(key);

    const list = seriesMatches.get(key) ?? [];
    const st: SeriesState = {
      ...spec,
      red: null,
      blue: null,
      redWins: 0,
      blueWins: 0,
      winner: null,
      loser: null,
      matches: list.filter((m) => m.status !== 'void').map((m) => m.id),
    };
    const pending = list.some((m) => m.status === 'scheduled' || m.status === 'called');
    let w: Side = null;
    let l: Side = null;
    if (a != null && b != null && a > 0 && b > 0 && a !== b) {
      st.red = Math.min(a, b);
      st.blue = Math.max(a, b);
      const target = Math.ceil(Math.max(1, spec.bestOf) / 2);
      for (const m of list) {
        if (m.status !== 'done' || !m.result) continue;
        if (m.result.winner !== 'red' && m.result.winner !== 'blue') continue;
        const redA = allianceOf.get(m.red[0]?.entry ?? NaN);
        const blueA = allianceOf.get(m.blue[0]?.entry ?? NaN);
        if (redA == null || blueA == null || redA === blueA) continue;
        if (!((redA === st.red && blueA === st.blue) || (redA === st.blue && blueA === st.red))) continue;
        const won: number = m.result.winner === 'red' ? redA : blueA;
        if (won === st.red) st.redWins++;
        else st.blueWins++;
        if (st.redWins >= target || st.blueWins >= target) break;
      }
      if (st.redWins >= target) [w, l] = [st.red, st.blue];
      else if (st.blueWins >= target) [w, l] = [st.blue, st.red];
    } else if (a != null && b != null) {
      // a walkover (one side is nobody) or no series at all (both are)
      const present = a > 0 ? a : b > 0 ? b : 0;
      if (present > 0) st.red = present;
      [w, l] = [present, 0];
    } else {
      // one side still unknown: show the one that is known where its feed puts it
      if (a != null && a > 0) st.red = a;
      if (b != null && b > 0) st.blue = b;
    }
    st.winner = w != null && w > 0 ? w : null;
    st.loser = l != null && l > 0 ? l : null;
    const r = { st, w, l, pending };
    solved.set(key, r);
    return r;
  };

  const series: SeriesState[] = [];
  const next: BracketState['next'] = [];
  for (const spec of specs) {
    if (byKey.get(spec.key) !== spec) continue; // a repeated key: the first one stands
    const r = solve(spec.key);
    if (!r) continue;
    series.push(r.st);
    if (r.st.red != null && r.st.blue != null && r.w == null && !r.pending) {
      next.push({ series: spec.key, red: r.st.red, blue: r.st.blue, number: r.st.matches.length + 1 });
    }
  }

  // PLACEMENTS: the series whose loser no other series takes are the eliminating ones; group
  // them by round, order the groups earliest → latest, and a loser's place is 2 + the number of
  // alliances knocked out in later groups (the champion is the 1).
  const fedLosers = new Set<string>();
  for (const s of specs) {
    for (const f of [s.redFrom, s.blueFrom]) if (f && f.take === 'loser') fedLosers.add(f.series);
  }
  const sideRank = { upper: 0, lower: 1, final: 2 } as const;
  const groups = new Map<string, SeriesState[]>();
  for (const s of series) {
    if (fedLosers.has(s.key)) continue;
    const g = `${sideRank[s.side]}:${String(s.round).padStart(3, '0')}`;
    const l = groups.get(g) ?? [];
    l.push(s);
    groups.set(g, l);
  }
  const order = [...groups.keys()].sort();
  const placements: Placement[] = [];
  const entriesOf = (seed: number): number[] => bySeed.get(seed)?.entries.slice() ?? [];
  let behind = 0;
  for (let gi = order.length - 1; gi >= 0; gi--) {
    const g = groups.get(order[gi])!;
    for (const s of g) if (s.loser != null) placements.push({ place: 2 + behind, alliance: s.loser, entries: entriesOf(s.loser) });
    behind += g.length;
  }
  const final = series.find((s) => s.side === 'final') ?? null;
  const finalSolved = final ? solved.get(final.key) ?? null : null;
  const champion = final?.winner ?? null;
  if (champion != null) placements.push({ place: 1, alliance: champion, entries: entriesOf(champion) });
  placements.sort((a, b) => a.place - b.place || a.alliance - b.alliance);

  return {
    series,
    placements,
    champion,
    complete: finalSolved != null && finalSolved.w != null,
    next,
  };
}
