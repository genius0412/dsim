import type { Alliance, World } from '../../types';
import type { RankFactsAt } from '../types';
import { bbScoreWorld } from './score';

const ALLIANCES: readonly Alliance[] = ['red', 'blue'];

/**
 * BIOBUZZ'S NUMBERS FOR A COMPETITION'S RANKING POINTS (`GameSimModule.rankFacts`). The keys are
 * the BIOBUZZ measures in `src/competition/manual.ts`; `scripts/smoke.ts` checks the two agree.
 * `bbScoreWorld` is a pure read on a 2D and a 3D world alike, so this is one.
 *
 * AUTO is read at `'teleopStart'`. §10.5 B counts a TIP completed before TELEOP starts as AUTO, and
 * TIPS have no AUTO/TELEOP split in the state, so the count has to be taken at that instant. A swing
 * still moving then completes in TELEOP and is not in it: `bbScoreWorld` adds a moving swing to
 * `tips` only once the match is over. LEAVE and AUTO PARK are already latched by then.
 *
 * SWARM and TIPS are read at `'final'`, on the settled field the score itself is taken from. SWARM
 * is both robots and both PARK assessments (LEAVE + AUTO PARK + TELEOP PARK).
 */
export function biobuzzRankFacts(world: World, at: RankFactsAt): Record<Alliance, Record<string, number>> {
  const out: Record<Alliance, Record<string, number>> = { red: {}, blue: {} };
  if (at === 'autoEnd' || !world.biobuzz) return out;
  const s = bbScoreWorld(world);
  for (const a of ALLIANCES) {
    const x = s[a];
    out[a] =
      at === 'teleopStart'
        ? { auto: x.leave + x.parkAuto + x.tipPts }
        : { swarm: x.leave + x.parkAuto + x.parkTele, tips: x.tips };
  }
  return out;
}
