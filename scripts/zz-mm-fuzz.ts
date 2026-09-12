/**
 * DIFFERENTIAL FUZZ for the matchmaker's pairing core.
 *
 * `findMatch` is being restructured from an all-pairs scan into pooled lookup, and the
 * failure mode of getting that wrong is SILENT: a wrongly-unmade match is
 * indistinguishable from an empty queue, and a match made in the wrong ORDER still
 * looks like a match — but `allianceOrder` and `assign`'s positional `i < half` split
 * read that order, so it decides who is red and what `startIndex` each player gets.
 *
 * So this records the PUBLIC behaviour (what gets staged, in what order, hosted where)
 * over thousands of randomised queues, and the restructure has to reproduce it exactly.
 *
 *   npx tsx scripts/zz-mm-fuzz.ts --save    write the baseline from the current build
 *   npx tsx scripts/zz-mm-fuzz.ts           compare the current build against it
 *
 * Deterministic: seeded PRNG, injected clock. No wall-clock, no Math.random, so a
 * difference is always a code change and never a flake.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Matchmaker, type QueueEntry } from '../server/matchmaking';
import type { PendingMatch } from '../server/matchTypes';
import type { QueueMode } from '../src/net/protocol';

const SAVE = process.argv.includes('--save');
const arg = (n: string, d: number): number => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  const v = h ? Number(h.slice(n.length + 3)) : NaN;
  return Number.isFinite(v) ? v : d;
};
const SCENES = arg('scenes', 20_000);
const BASELINE = new URL('./.mm-fuzz-baseline.json', import.meta.url);

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** deployed AND undeployed regions, so the '' pool and the unknown penalty are exercised */
const REGIONS = ['iad', 'ord', 'sjc', 'lhr', 'syd', 'nrt', 'gru', 'jnb', 'fra', ''];
const BUILDS = ['b1', 'b1', 'b1', 'b2', 'b3']; // weighted: mostly one build, sometimes a rollout
const CHANNELS = ['stable', 'stable', 'alpha'];
const GAMES = ['decode', 'decode', 'chain'] as const;

/** one randomised queue + clock schedule */
function scene(rand: () => number, n: number): { entries: QueueEntry[]; mode: QueueMode; clocks: number[] } {
  const mode: QueueMode = rand() < 0.5 ? '1v1' : '2v2';
  const entries: QueueEntry[] = [];
  let partySeq = 0;
  for (let i = 0; i < n; i++) {
    const r = rand();
    // ~18% of entries belong to a party; half of those are CLOSED (a rated challenge)
    let party: string | undefined;
    let partySize: number | undefined;
    let partyOnly: boolean | undefined;
    if (r < 0.18) {
      party = `pt${partySeq}`;
      partySize = 2;
      partyOnly = rand() < 0.5 ? true : undefined;
      // the partner joins too, MOST of the time — a half-arrived party must not match
      if (rand() < 0.8 && i + 1 < n) {
        entries.push(mk(entries.length, mode, rand, party, partySize, partyOnly));
        i++;
      }
      partySeq++;
    }
    entries.push(mk(entries.length, mode, rand, party, partySize, partyOnly));
  }
  // a few clock stops so the widening schedule is crossed in both directions
  const clocks = [0, 3_000, 6_000, 12_000];
  return { entries, mode, clocks };
}

function mk(
  i: number,
  mode: QueueMode,
  rand: () => number,
  party?: string,
  partySize?: number,
  partyOnly?: boolean,
): QueueEntry {
  return {
    id: `e${i}`,
    send: () => {},
    userId: `u${i}`,
    player: { name: `e${i}`, teamName: '', teamNumber: 0 },
    mode,
    homeRegion: REGIONS[Math.floor(rand() * REGIONS.length)],
    accessMs: Math.floor(rand() * 60),
    noWiden: rand() < 0.12 ? true : undefined,
    build: BUILDS[Math.floor(rand() * BUILDS.length)],
    channel: CHANNELS[Math.floor(rand() * CHANNELS.length)],
    game: GAMES[Math.floor(rand() * GAMES.length)],
    party,
    partySize,
    partyOnly,
    enqueuedAt: 0,
    expandBumps: rand() < 0.15 ? 1 + Math.floor(rand() * 2) : 0,
  } as QueueEntry;
}

/** what one scene PRODUCES — ordered roster names + host, per staged match, in order */
async function run(s: ReturnType<typeof scene>): Promise<string> {
  let t = 0;
  const staged: PendingMatch[] = [];
  const mm = new Matchmaker({
    now: () => t,
    stage: async (m) => {
      staged.push(m);
    },
    // no rating source: this fuzz pins the LATENCY core, so skill must be absent
  });
  for (const e of s.entries) mm.enqueue(e);
  await new Promise((r) => setTimeout(r, 0));
  for (const c of s.clocks) {
    t = c;
    mm.tick();
    await new Promise((r) => setTimeout(r, 0));
  }
  // ORDER IS PART OF THE ANSWER — roster order drives allianceOrder and the red/blue split
  return staged
    .map((m) => `${m.hostRegion}:${m.roster.map((r) => `${r.name}/${r.alliance}/${r.startIndex}`).join(',')}`)
    .join(' | ');
}

async function main(): Promise<void> {
  const rand = rng(0x5eed);
  const out: string[] = [];
  for (let i = 0; i < SCENES; i++) {
    const n = 2 + Math.floor(rand() * 12); // 2..13 entries
    out.push(await run(scene(rand, n)));
  }

  if (SAVE) {
    writeFileSync(BASELINE, JSON.stringify({ scenes: SCENES, out }, null, 0));
    const made = out.filter((o) => o.length > 0).length;
    console.log(`\nbaseline written: ${SCENES} scenes, ${made} of them staged at least one match\n`);
    return;
  }

  if (!existsSync(BASELINE)) {
    console.error('\nno baseline — run with --save on a known-good build first\n');
    process.exit(1);
  }
  const base = JSON.parse(readFileSync(BASELINE, 'utf8')) as { scenes: number; out: string[] };
  if (base.scenes !== SCENES) {
    console.error(`\nbaseline has ${base.scenes} scenes, this run has ${SCENES} — same --scenes, please\n`);
    process.exit(1);
  }
  const diffs: number[] = [];
  for (let i = 0; i < SCENES; i++) if (base.out[i] !== out[i]) diffs.push(i);
  const made = out.filter((o) => o.length > 0).length;
  if (!diffs.length) {
    console.log(`\n✓ differential fuzz: ${SCENES} scenes identical (${made} staged a match)\n`);
    return;
  }
  console.error(`\n✗ differential fuzz: ${diffs.length}/${SCENES} scenes DIFFER\n`);
  for (const i of diffs.slice(0, 8)) {
    console.error(`  scene ${i}`);
    console.error(`    was: ${base.out[i] || '(no match)'}`);
    console.error(`    now: ${out[i] || '(no match)'}`);
  }
  if (diffs.length > 8) console.error(`  ... and ${diffs.length - 8} more`);
  console.error('');
  process.exit(1);
}
main();
