/**
 * WHERE the join cost actually is. `enqueue` does three things that scale with queue
 * depth — removeUser (a filter per mode), tryMatch (the all-pairs scan), and
 * broadcastStatus (a send per waiting entry) — and a fix aimed at only one of them
 * leaves the others in the path. Measured by monkey-patching the prototype, so the
 * real code runs and only the accounting is added.
 */
import { Matchmaker, type QueueEntry } from '../server/matchmaking';
import type { PendingMatch } from '../server/matchTypes';

const REGIONS = ['iad', 'ord', 'sjc', 'lhr', 'fra', 'nrt', 'syd', 'gru'];
let seq = 0;
const mk = (build: string, region: string): QueueEntry =>
  ({
    id: `p${seq}`, send: () => {}, userId: `u${seq}`,
    player: { name: `p${seq++}`, teamName: '', teamNumber: 0 },
    mode: '1v1', homeRegion: region, accessMs: 10, build, enqueuedAt: 0, expandBumps: 0,
  }) as QueueEntry;

const ns = (): bigint => process.hrtime.bigint();
const acc: Record<string, number> = { tryMatch: 0, removeUser: 0, broadcastStatus: 0 };

// wrap the three depth-scaling steps of enqueue, on the prototype, before any instance exists
const proto = Matchmaker.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
for (const name of ['tryMatch', 'removeUser', 'broadcastStatus']) {
  const orig = proto[name];
  if (typeof orig !== 'function') throw new Error(`no ${name} on Matchmaker.prototype`);
  proto[name] = function patched(...a: unknown[]): unknown {
    const t = ns();
    try { return orig.apply(this, a); } finally { acc[name] += Number(ns() - t) / 1e6; }
  };
}

async function main(): Promise<void> {
  console.log('\nJOIN COST BREAKDOWN — one enqueue at a standing queue depth (ms)\n');
  console.log('  depth      total   tryMatch  removeUser  broadcast     other');
  const staged: PendingMatch[] = [];
  const mm = new Matchmaker({ now: () => Date.now(), stage: async (m) => { staged.push(m); } } as never);
  let depth = 0;
  for (const target of [100, 300, 500, 1000]) {
    while (depth < target - 1) { mm.enqueue(mk(`solo${depth}`, REGIONS[depth % 8])); depth++; }
    for (const k of Object.keys(acc)) acc[k] = 0;
    const t = ns();
    mm.enqueue(mk(`solo${depth}`, REGIONS[depth % 8]));
    depth++;
    const total = Number(ns() - t) / 1e6;
    const other = total - acc.tryMatch - acc.removeUser - acc.broadcastStatus;
    const f = (n: number): string => n.toFixed(2).padStart(9);
    console.log(`  ${String(target).padStart(5)}${f(total)}${f(acc.tryMatch)}${f(acc.removeUser)}${f(acc.broadcastStatus)}${f(other)}`);
  }
  console.log('');
}
main();
