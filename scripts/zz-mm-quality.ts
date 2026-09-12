/**
 * MATCH QUALITY under a simulated population — the other half of the matchmaker story.
 *
 * `zz-mm-marginal.ts` measures what a join COSTS. This measures what the queue PRODUCES:
 * how long people wait, how many get matched at all, and — once skill-based pairing exists
 * — how mismatched the pairs are. Speed alone cannot tell you whether a skill window is set
 * right, because every tightening of a window trades match quality against wait time, and
 * both are player-visible.
 *
 * Deterministic: a seeded PRNG and an INJECTED clock, so a tuning change shows up as a
 * change in the numbers and never as noise. No wall-clock, no Math.random.
 *
 * Run: npx tsx scripts/zz-mm-quality.ts [--ccu=2000] [--mins=10] [--sd=300]
 */
import { Matchmaker, type QueueEntry } from '../server/matchmaking';
import type { PendingMatch } from '../server/matchTypes';
import type { QueueMode } from '../src/net/protocol';

const arg = (n: string, d: number): number => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  const v = h ? Number(h.slice(n.length + 3)) : NaN;
  return Number.isFinite(v) ? v : d;
};
const CCU = arg('ccu', 2000);
const MINS = arg('mins', 10);
const SD = arg('sd', 180);
/** share of the pool that is UNPLACED (games < PLACEMENT_GAMES 5) and therefore sitting at
 * the 1000 default. They are the reason a skill gate must not be a hard veto: a new player
 * has no rating to match on and must still get a game. */
const UNPLACED = arg('unplaced', 0.35);
/** share of CCU that is queueing for a rated mode at any moment (repo split: 1/8 + 1/8) */
const RATED_SHARE = arg('rated', 0.25);
/** how many client BUILDS are live at once. 1 = settled fleet; >1 = a version rollout,
 * which splits the pairing bucket and is the condition under which the queue stops
 * draining at all. This is the realistic launch-day state, not the steady state. */
const BUILDS = arg('builds', 1);

/** mulberry32 — the sim's own PRNG shape, so runs are reproducible */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20260912);
/** Box-Muller, so ratings are normally distributed the way a real ladder is */
function normal(mean: number, sd: number): number {
  const u = Math.max(1e-9, rand());
  const v = rand();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** US-concentrated population, per the stated target */
const REGION_MIX: [string, number][] = [['iad', 0.5], ['ord', 0.3], ['sjc', 0.2]];
function pickRegion(): string {
  let r = rand();
  for (const [name, share] of REGION_MIX) {
    if (r < share) return name;
    r -= share;
  }
  return 'iad';
}

interface Rec { id: string; rating: number; joinedMs: number; mode: QueueMode }

async function main(): Promise<void> {
  const staged: { m: PendingMatch; atMs: number }[] = [];
  let clock = 0;
  const mm = new Matchmaker({
    now: () => clock,
    stage: async (m) => { staged.push({ m, atMs: clock }); },
  } as never);

  const byId = new Map<string, Rec>();
  let seq = 0;
  const TOTAL_MS = MINS * 60_000;
  // arrivals per second so the QUEUE holds ~RATED_SHARE of CCU in steady state
  const targetQueued = Math.round(CCU * RATED_SHARE);
  const arrivalsPerSec = targetQueued / 45; // ~45s mean dwell before a match

  console.log(`\nMATCH QUALITY — ${CCU} CCU, ${Math.round(targetQueued)} in rated queues, ${MINS} min, rating sd ${SD}\n`);

  let peakDepth = 0;
  let tickCostMs = 0;
  let worstTickMs = 0;
  for (let sec = 0; sec * 1000 < TOTAL_MS; sec++) {
    clock = sec * 1000;
    let due = arrivalsPerSec;
    while (due > 0) {
      if (due < 1 && rand() > due) break;
      due -= 1;
      const mode: QueueMode = rand() < 0.5 ? '1v1' : '2v2';
      const id = `p${seq++}`;
      // NEW PLAYERS START AT 1000, not at Glicko's internal CENTER of 1500 (server/ranked.ts
      // :28-31 vs repo.ts's `?? 1000`). The live band measured off the real glicko2Update is
      // ~450-1550 clustered hard around 1000, so that is what this models — an unplaced share
      // sitting exactly on the default, and an established tail around it.
      const placed = rand() >= UNPLACED;
      const rating = placed ? Math.max(450, Math.min(1550, Math.round(normal(1000, SD)))) : 1000;
      byId.set(id, { id, rating, joinedMs: clock, mode });
      const e = {
        id, send: () => {}, userId: `u-${id}`,
        player: { name: id, teamName: '', teamNumber: 0 },
        mode, homeRegion: pickRegion(), accessMs: 8 + Math.round(rand() * 25),
        build: `b${seq % BUILDS}`, enqueuedAt: clock, expandBumps: 0,
        // `placed` is what the skill gate keys on: an unplaced player has no rating to
        // match on and must not be gated. The harness models that share explicitly.
        rating,
        placed,
      } as unknown as QueueEntry;
      mm.enqueue(e);
    }
    const t = process.hrtime.bigint();
    mm.tick();
    const one = Number(process.hrtime.bigint() - t) / 1e6;
    tickCostMs += one;
    if (one > worstTickMs) worstTickMs = one;
    const d = mm.queueSizes();
    peakDepth = Math.max(peakDepth, d['1v1'] + d['2v2']);
    await Promise.resolve();
  }
  await new Promise((r) => setTimeout(r, 0));

  // ---- outcomes -------------------------------------------------------------
  const waits: number[] = [];
  const deltas: number[] = [];
  const spreads: number[] = [];
  let matchedPlayers = 0;
  for (const { m, atMs } of staged) {
    const rs: number[] = [];
    for (const r of m.roster) {
      const rec = byId.get(r.name);
      if (!rec) continue;
      matchedPlayers++;
      waits.push((atMs - rec.joinedMs) / 1000);
      rs.push(rec.rating);
    }
    if (rs.length >= 2) deltas.push(Math.max(...rs) - Math.min(...rs));
    spreads.push(0);
  }
  const pct = (a: number[], p: number): number => {
    if (!a.length) return NaN;
    const s = [...a].sort((x, y) => x - y);
    return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 10) / 10;
  };
  const created = seq;
  console.log(`  players queued       ${created}`);
  console.log(`  matched              ${matchedPlayers} (${Math.round((matchedPlayers / created) * 1000) / 10}%)`);
  console.log(`  matches staged       ${staged.length}`);
  console.log(`  peak queue depth     ${peakDepth}`);
  console.log('');
  console.log(`  WAIT seconds         p50 ${pct(waits, 50)}   p90 ${pct(waits, 90)}   p99 ${pct(waits, 99)}`);
  console.log(`  RATING SPREAD/match  p50 ${pct(deltas, 50)}   p90 ${pct(deltas, 90)}   p99 ${pct(deltas, 99)}`);
  console.log(`     (random pairing gives ~${Math.round(1.128 * SD * (1 - UNPLACED))}; a fair match is <=150-200 — see ranked.ts win-probability table)`);
  console.log('');
  console.log(`  matchmaker CPU       ${Math.round(tickCostMs)} ms of tick() over ${MINS} simulated minutes`);
  console.log(`                       = ${Math.round((tickCostMs / (MINS * 60)) * 100) / 100} ms per simulated second\n`);
}
main();
