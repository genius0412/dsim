import type { Alliance, World } from '../../types';
import type { RankFactsAt } from '../types';

const ALLIANCES: readonly Alliance[] = ['red', 'blue'];

/**
 * DECODE'S NUMBERS FOR A COMPETITION'S RANKING POINTS (`GameSimModule.rankFacts`). The keys are
 * the DECODE measures in `src/competition/manual.ts`; `scripts/smoke.ts` checks the two agree.
 *
 * Everything is reported at `'final'`. DECODE books an ARTIFACT that meets its criteria before
 * TELEOP starts as AUTO (`scoredAsAuto`, §10.5 A), so the AUTO lines are already right at the end
 * of the match and need no earlier snapshot.
 *
 * Read off the breakdown LINES, never `total`: a red card voids the total and keeps the lines, and
 * the facts are what was played. Whether a carded team earns anything is the competition's call.
 *
 * `patternAward` is G417.A ("the opposing ALLIANCE is awarded the PATTERN RP"). The sim keeps no
 * flag for it; the penalty engine's episode key `G417:<gate owner>:<robot>` is the record, and a
 * DECODE world never prunes `penalties.episodes`. G418.B awards the same RP, and in the sim it can
 * only follow a G417 (the culprit is a robot that touched the arm), so this covers both.
 */
export function decodeRankFacts(world: World, at: RankFactsAt): Record<Alliance, Record<string, number>> {
  const out: Record<Alliance, Record<string, number>> = { red: {}, blue: {} };
  if (at !== 'final') return out;
  const episodes = Object.keys(world.penalties.episodes);
  for (const a of ALLIANCES) {
    const s = world.match.scores[a];
    const g = world.goals[a];
    const prefix = `G417:${a}:`;
    out[a] = {
      auto: s.leave + s.autoClassified + s.autoOverflow + s.autoPattern,
      // the two-robot bonus and a G427 award are both BASE (Table 10-2; Q&A Q155)
      base: s.base,
      movement: s.leave + s.base,
      // every pass through the SQUARE, CLASSIFIED or OVERFLOW (Q&A Q27, Q83)
      artifacts: g.classifiedCount + g.overflowCount,
      pattern: s.autoPattern + s.telePattern,
      patternAward: episodes.some((k) => k.startsWith(prefix)) ? 1 : 0,
    };
  }
  return out;
}
