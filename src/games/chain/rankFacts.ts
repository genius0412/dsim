import type { Alliance, World } from '../../types';
import type { RankFactsAt } from '../types';
import { CHAIN_PTS } from './config';

const ALLIANCES: readonly Alliance[] = ['red', 'blue'];

/**
 * CHAIN REACTION'S NUMBERS FOR A COMPETITION'S RANKING POINTS (`GameSimModule.rankFacts`). The keys
 * are the Chain Reaction measures in `src/competition/manual.ts`; `scripts/smoke.ts` checks the two
 * agree. CR has no ranking rules of its own and ranks by INTO THE DEEP's Table 13-1.
 *
 * AUTO is read at `'autoEnd'`, the first tick out of AUTO. ITD §10.5 B counts the transition as
 * TELEOP, and `play.ts` scores a PARTICLE whenever it enters an accelerator, phase or not, so a shot
 * still in the air at the buzzer is TELEOP. `chainStep` runs the gameplay before the phase machine,
 * so the particles of the last AUTO tick are in the count and none of the transition's are. AUTO is
 * the particle points plus the latched Ring-Stand descents (the sim does not score the Lab LEAVE).
 *
 * ASCENT is read at `'final'`: the endgame state is derived from where each robot sits, and the
 * field has settled by then.
 */
export function chainRankFacts(world: World, at: RankFactsAt): Record<Alliance, Record<string, number>> {
  const out: Record<Alliance, Record<string, number>> = { red: {}, blue: {} };
  const chain = world.chain;
  if (!chain || at === 'teleopStart') return out;
  for (const a of ALLIANCES) {
    let n = 0;
    for (const r of world.robots) {
      if (r.alliance !== a) continue;
      if (at === 'autoEnd' ? chain.descended?.[r.id] : chain.endgame[r.id] === 'ascended') n++;
    }
    out[a] =
      at === 'autoEnd'
        ? { auto: chain.particlePoints[a] + n * CHAIN_PTS.ringStandDescend }
        : { ascent: n * CHAIN_PTS.ringStandAscend };
  }
  return out;
}
