/**
 * EACH GAME'S COMPETITION MANUAL, AS A RANKING TABLE: what a qualification match is worth in
 * ranking points, which bonus RPs it can earn and at what thresholds, and the order ties are
 * broken in. Read under the `cm` scheme (`RpSettings`); `effectiveRanking` resolves a
 * competition's settings against it, and `rankings.ts` applies the result.
 *
 * Imported only by `src/competition/*`, the competition pages (`src/ui/Comp*.tsx`), the server and
 * the test scripts — never by a game module or anything in the main chunk. The games report their
 * measures with string-literal keys (`GameSimModule.rankFacts`), and `scripts/smoke.ts` checks the
 * two key sets agree, so this module never drags game config into the competitions chunk (or the
 * reverse).
 *
 * The numbers are the manuals', and each table names its edition. When a Team Update changes one,
 * change it here: a competition whose qualifications already started ranks by the copy frozen in
 * `competitions.rp_table` at the start, so the edit only reaches events that begin after it.
 *
 * WHERE A ROW COMES FROM (the manual is not always explicit; the source of each reading is noted):
 *
 * DECODE — Competition Manual, Team Update 32 (16 Apr 2026). Table 10-2: WIN 3, TIE 1 (no LOSS
 * row, so 0); MOVEMENT RP for LEAVE + BASE points, GOAL RP for the number of ARTIFACTS scored
 * through the SQUARE, PATTERN RP for PATTERN points, 1 each. Table 10-3 thresholds (All Other
 * Events / Regional Championships / FIRST Championship): 16/21/21, 36/42/67, 18/22/22. Table 13-1:
 * RS, average alliance points minus fouls, average BASE points, average AUTO points, random.
 *   - GOAL counts CLASSIFIED + OVERFLOW (§10.5.1: both pass through the SQUARE), every pass of a
 *     recycled ARTIFACT counted again (Q&A Q27, Q83; and the 42/67 thresholds exceed the 36
 *     ARTIFACTS on the field).
 *   - MOVEMENT includes the two-robot BASE bonus and BASE awarded by G427 (Table 10-2 lists the
 *     bonus under BASE; Q&A Q155).
 *   - PATTERN sums the AUTO and TELEOP assessments (one assessment scores at most 18, below the
 *     22 threshold).
 *   - AUTO points include the transition (TU30 §10.5 A: criteria met before TELEOP starts count as
 *     AUTO) — the sim books them so (`scoredAsAuto`).
 *   - Rules can AWARD the opponent the PATTERN RP (G417.A, G418.B, G419.B, G431.C) or make an
 *     alliance INELIGIBLE for PATTERN (G418.A) or PATTERN and GOAL (G206); ineligibility overrides
 *     any award (Table 10-4). The sim reports G417 itself (`patternAward`).
 *
 * BIOBUZZ — Competition Manual, Team Update 03 (1 Oct 2026). Table 10-2: WIN 3, TIE 1; SWARM RP for
 * LEAVE + PARK points, POLLINATOR 1 and POLLINATOR 2 RP for the number of TIPS, 1 each (7 tips
 * earns both). Table 10-3: 16 points / 4 TIPS / 7 TIPS at All Other Events; Regional and FIRST
 * Championship are TBA. Table 13-1: RS, average alliance points minus fouls, average number of
 * TIPS, average AUTO points, random. SWARM sums both robots and both PARK assessments (a reading,
 * confirmed by the FTC Global Leadership Team's season guide). AUTO counts a TIP completed before
 * TELEOP starts (§10.5 B). No rule awards or withholds an RP.
 *
 * CHAIN REACTION — its own manual has no ranking rules at all (it defers hardware and gameplay to
 * INTO THE DEEP, not the tournament). DSIM ranks it by the INTO THE DEEP Competition Manual V14 (20
 * Mar 2025): Table 10-3 WIN 2, TIE 1, no bonus RPs; Table 13-1: RS, average alliance AUTO points,
 * average TELEOP alliance ASCENT points, highest match score (fouls included), random. AUTO is
 * what was scored before AUTO ENDED: ITD §10.5 B counts the transition as TELEOP.
 *
 * SHARED (§13.6.3 DECODE and BIOBUZZ; §13.5.3 INTO THE DEEP): RS is the average RP over the team's
 * qualification matches, surrogate matches excluded from every calculation; "A MATCH in which a
 * team is DISQUALIFIED contributes 0 to all sort criteria"; a DQ costs only the DQ'd team, never
 * its partner (T601; ITD T501).
 */
import type { GameId } from '../games/types';
import type {
  CompFormat,
  ResolvedBonus,
  ResolvedRanking,
  RpLevel,
  RpSettings,
  Tiebreaker,
} from './types';
import { MEASURE_TIEBREAKERS } from './types';

/** one number a game reports per alliance at the end of a match */
export interface CmMeasure {
  id: string;
  unit: 'points' | 'count' | 'flag';
  /** the most it can be — what a referee's input and a custom threshold are clamped to */
  max: number;
  /** a flag the sim sets and nobody types (DECODE's `patternAward`) */
  internal?: boolean;
}

export interface CmBonus {
  id: string;
  measure: string;
  /** Table 10-3 per level; null = TBA (not published yet) */
  thresholds: { event: number; regional: number | null; championship: number | null };
  awardFact?: string;
  award: boolean;
  deny: boolean;
  /** the most of `measure` ONE robot can score: a one-robot alliance cannot reach more */
  perRobotMax?: number;
}

export interface CmTable {
  game: GameId;
  /** the manual and edition, as the pages cite it */
  source: string;
  win: number;
  tie: number;
  loss: number;
  bonus: CmBonus[];
  measures: CmMeasure[];
  /** Table 13-1 after the ranking score, without the final random sort (that is the coin) */
  tiebreakers: Tiebreaker[];
}

const DECODE: CmTable = {
  game: 'decode',
  source: 'DECODE Competition Manual, Team Update 32',
  win: 3,
  tie: 1,
  loss: 0,
  bonus: [
    // LEAVE 3 + fully returned to BASE 10 is one robot's most: 13 < 16
    { id: 'movement', measure: 'movement', thresholds: { event: 16, regional: 21, championship: 21 }, award: false, deny: false, perRobotMax: 13 },
    { id: 'goal', measure: 'artifacts', thresholds: { event: 36, regional: 42, championship: 67 }, award: false, deny: true },
    {
      id: 'pattern',
      measure: 'pattern',
      thresholds: { event: 18, regional: 22, championship: 22 },
      awardFact: 'patternAward',
      award: true,
      deny: true,
    },
  ],
  measures: [
    { id: 'auto', unit: 'points', max: 9999 },
    // 2 robots fully returned (2 × 10) + the both-robots bonus (10)
    { id: 'base', unit: 'points', max: 30 },
    // 2 LEAVEs (6) + BASE (30)
    { id: 'movement', unit: 'points', max: 36 },
    { id: 'artifacts', unit: 'count', max: 999 },
    // 9 RAMP indices × 2 points × 2 assessments
    { id: 'pattern', unit: 'points', max: 36 },
    { id: 'patternAward', unit: 'flag', max: 1, internal: true },
  ],
  tiebreakers: ['avgNoFoul', 'avgBase', 'avgAuto'],
};

const BIOBUZZ: CmTable = {
  game: 'biobuzz',
  source: 'BIOBUZZ Competition Manual, Team Update 03',
  win: 3,
  tie: 1,
  loss: 0,
  bonus: [
    // LEAVE 3 + AUTO PARK 5 + TELEOP PARK 5 is one robot's most: 13 < 16
    { id: 'swarm', measure: 'swarm', thresholds: { event: 16, regional: null, championship: null }, award: false, deny: false, perRobotMax: 13 },
    { id: 'pollinator1', measure: 'tips', thresholds: { event: 4, regional: null, championship: null }, award: false, deny: false },
    { id: 'pollinator2', measure: 'tips', thresholds: { event: 7, regional: null, championship: null }, award: false, deny: false },
  ],
  measures: [
    { id: 'auto', unit: 'points', max: 9999 },
    // 2 × (LEAVE 3 + AUTO PARK 5 + TELEOP PARK 5)
    { id: 'swarm', unit: 'points', max: 26 },
    { id: 'tips', unit: 'count', max: 99 },
  ],
  tiebreakers: ['avgNoFoul', 'avgTips', 'avgAuto'],
};

const CHAIN: CmTable = {
  game: 'chain',
  source: 'INTO THE DEEP Competition Manual V14',
  win: 2,
  tie: 1,
  loss: 0,
  bonus: [],
  measures: [
    { id: 'auto', unit: 'points', max: 9999 },
    { id: 'ascent', unit: 'points', max: 999 },
  ],
  tiebreakers: ['avgAuto', 'avgAscent', 'highScore'],
};

/** a game with no table here ranks by the organizer's points only (`custom`) */
export const CM_TABLES: Readonly<Partial<Record<GameId, CmTable>>> = {
  decode: DECODE,
  biobuzz: BIOBUZZ,
  chain: CHAIN,
};

export function cmTable(game: GameId): CmTable | null {
  return CM_TABLES[game] ?? null;
}

/** the levels a game's table publishes thresholds for (`custom` only where there is a bonus) */
export function levelsOf(game: GameId): RpLevel[] {
  const t = cmTable(game);
  if (!t || !t.bonus.length) return ['event'];
  const out: RpLevel[] = ['event'];
  if (t.bonus.every((b) => b.thresholds.regional !== null)) out.push('regional');
  if (t.bonus.every((b) => b.thresholds.championship !== null)) out.push('championship');
  out.push('custom');
  return out;
}

export function measureOf(game: GameId, id: string): CmMeasure | null {
  return cmTable(game)?.measures.find((m) => m.id === id) ?? null;
}

/** the tiebreakers an organizer may pick for this game: the generic six, plus the measured ones it reports */
export function tiebreakersFor(game: GameId, all: readonly Tiebreaker[]): Tiebreaker[] {
  const t = cmTable(game);
  return all.filter((tb) => {
    const m = MEASURE_TIEBREAKERS[tb];
    return !m || !!t?.measures.some((x) => x.id === m);
  });
}

/** the threshold a bonus takes at a level; `custom` reads the organizer's, defaulting to the event column */
export function thresholdAt(b: CmBonus, level: RpLevel, custom: Record<string, number>): number {
  if (level === 'custom') {
    const v = custom[b.id];
    return typeof v === 'number' && Number.isFinite(v) ? v : b.thresholds.event;
  }
  if (level === 'regional') return b.thresholds.regional ?? b.thresholds.event;
  if (level === 'championship') return b.thresholds.championship ?? b.thresholds.event;
  return b.thresholds.event;
}

/**
 * THE RANKING RULES A COMPETITION APPLIES. A frozen copy (written when qualifications started under
 * `cm`) wins over the live table, so a Team Update never re-ranks an event already under way.
 * `rp` may be absent (a settings object from before the manual scheme, or a test fixture): that is
 * `custom`, as a stored row without it is.
 */
export function effectiveRanking(
  settings: { points: { win: number; tie: number; loss: number }; tiebreakers: Tiebreaker[]; rp?: RpSettings },
  game: GameId,
  frozen?: ResolvedRanking | null,
): ResolvedRanking {
  const rp = settings.rp;
  const table = cmTable(game);
  const measures = table ? table.measures.filter((m) => !m.internal).map((m) => m.id) : [];
  if (rp?.scheme === 'cm' && frozen && frozen.scheme === 'cm') return frozen;
  if (rp?.scheme === 'cm' && table) {
    const bonus: ResolvedBonus[] = table.bonus.map((b) => ({
      id: b.id,
      measure: b.measure,
      threshold: thresholdAt(b, rp.level, rp.thresholds),
      ...(b.awardFact ? { awardFact: b.awardFact } : {}),
      award: b.award,
      deny: b.deny,
    }));
    return {
      scheme: 'cm',
      level: rp.level,
      source: table.source,
      win: table.win,
      tie: table.tie,
      loss: table.loss,
      bonus,
      tiebreakers: [...table.tiebreakers],
      measures,
    };
  }
  return {
    scheme: 'custom',
    level: rp?.level ?? 'event',
    source: null,
    win: settings.points.win,
    tie: settings.points.tie,
    loss: settings.points.loss,
    bonus: [],
    tiebreakers: tiebreakersFor(game, settings.tiebreakers),
    measures,
  };
}

/**
 * DID AN ALLIANCE EARN THIS BONUS RP? Table 10-4: an "ineligible" ruling overrides any award, from
 * play or from a violation; then an award (a referee's, or the sim's `awardFact`); then the
 * measure against the threshold. Unknown facts earn nothing.
 */
export function bonusEarned(
  b: ResolvedBonus,
  facts: Record<string, number> | null | undefined,
  ruling?: 'award' | 'deny' | null,
): boolean {
  if (ruling === 'deny' && b.deny) return false;
  if (ruling === 'award' && b.award) return true;
  if (b.awardFact && (facts?.[b.awardFact] ?? 0) > 0) return true;
  const v = facts?.[b.measure];
  return typeof v === 'number' && v >= b.threshold;
}

/** robots on one alliance of a competition of this format */
export function robotsPerAlliance(format: CompFormat): 1 | 2 {
  return format === '2v2' ? 2 : 1;
}

/**
 * BONUS RPs AN ALLIANCE OF THIS SIZE CAN NEVER EARN: the manual's thresholds assume two robots,
 * and one robot's LEAVE + BASE (DECODE) or LEAVE + PARK (BIOBUZZ) tops out at 13, below 16. The
 * editor and the overview say so; nothing is changed behind the organizer's back.
 */
export function unreachableBonus(r: ResolvedRanking, game: GameId, format: CompFormat): string[] {
  const t = cmTable(game);
  if (!t || r.scheme !== 'cm') return [];
  const robots = robotsPerAlliance(format);
  return r.bonus
    .filter((b) => {
      const row = t.bonus.find((x) => x.id === b.id);
      // two robots reach the measure's own max (DECODE adds a both-robots BASE bonus on top of
      // 2 × 13), and every threshold is clamped to that; only a one-robot alliance falls short
      return robots === 1 && row?.perRobotMax !== undefined && b.threshold > row.perRobotMax && !b.awardFact;
    })
    .map((b) => b.id);
}

/**
 * A referee's or a client's facts, coerced to what the game reports: known keys only (internal
 * flags included only when `internal` is true — the server's own write), whole numbers clamped to
 * [0, max]. Anything else is dropped. An empty result is null (unknown).
 */
export function coerceFacts(game: GameId, raw: unknown, internal = false): Record<string, number> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const t = cmTable(game);
  if (!t) return null;
  const out: Record<string, number> = {};
  for (const m of t.measures) {
    if (m.internal && !internal) continue;
    const v = (raw as Record<string, unknown>)[m.id];
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    if (!Number.isFinite(n)) continue;
    out[m.id] = Math.min(m.max, Math.max(0, Math.round(n)));
  }
  return Object.keys(out).length ? out : null;
}
