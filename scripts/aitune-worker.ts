/**
 * THE AI TUNER'S WORKER — `scripts/aitune.mjs` spawns one per core with a JSON file of jobs
 * `[{ key, wa, wb, seed, aSide, tier?, physics? }]`, and this plays each as a full 2v2 of bots on the
 * roster builds, weights `wa` on alliance `aSide` and `wb` on the other, printing one JSON line per
 * match: `{ key, seed, a, b }` (each side's final score). Headless, no windows.
 */
import { readFileSync } from 'node:fs';
import type { Alliance, RobotCommand, World } from '../src/types';
import { SIM_DT } from '../src/config';
import { startMatch } from '../src/sim/match';
import { DEFAULT_ASSISTS } from '../src/sim/spawn';
import { BIOBUZZ_SIM } from '../src/games/biobuzz/sim';
import { bbBotBuild } from '../src/games/biobuzz/ai/builds';
import { createBiobuzzBot } from '../src/games/biobuzz/ai/policy';
import { initPhysics } from '../src/sim/physicsEngine';
import { initPhysics3d } from '../src/games/biobuzz/sim3d/engine';
import { newSettleClock, settleStep } from '../src/sim/settle';

const jobs = JSON.parse(readFileSync(process.argv[2], 'utf8'));
await initPhysics();
await initPhysics3d();
for (const j of jobs) {
  const tier = j.tier ?? 'hard';
  const seats = [0, 1, 2, 3].map((id) => ({ id, alliance: (id < 2 ? 'blue' : 'red') as Alliance, startIndex: id % 2 }));
  const setups = seats.map((st) => ({
    id: st.id,
    alliance: st.alliance,
    spec: bbBotBuild({ seed: j.seed, robotId: st.id, tier, alliance: st.alliance }),
    assists: { ...DEFAULT_ASSISTS },
    startIndex: st.startIndex,
  }));
  const world: World = BIOBUZZ_SIM.createWorld('match', j.seed, setups, undefined, j.physics ?? '3d');
  startMatch(world);
  const bots = seats.map((st) =>
    createBiobuzzBot(world, st.id, tier, (j.seed ^ ((st.id + 1) * 0x9e3779b1)) >>> 0, st.alliance === j.aSide ? j.wa : j.wb),
  );
  const cmds = new Map<number, RobotCommand>();
  const settle = newSettleClock();
  for (let t = 0; t < 16000; t++) {
    seats.forEach((st, i) => cmds.set(st.id, bots[i].step(world)));
    world.events.length = 0;
    BIOBUZZ_SIM.step(world, SIM_DT, cmds);
    if (world.match.phase === 'post' && settleStep(settle, world, BIOBUZZ_SIM.settled)) break;
  }
  const bSide: Alliance = j.aSide === 'blue' ? 'red' : 'blue';
  console.log(JSON.stringify({ key: j.key, seed: j.seed, a: world.match.scores[j.aSide].total, b: world.match.scores[bSide].total }));
}
