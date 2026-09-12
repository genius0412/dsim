/**
 * Matchmaker verification — `npm run test:mm`.
 *
 * Deterministic, in-process, no DB and no sockets: `Matchmaker` takes an injected
 * clock and an injected `stage`, so a whole pairing round is a function call and
 * the staged roster is just an object to assert on.
 *
 * This exists because of "play a friend". Party pairing is the one piece of
 * matchmaking whose failure modes are all SILENT — a party split across alliances,
 * a closed challenge quietly matched against a stranger for rating, a friend left
 * waiting because their partner was consumed by an open group — and the only other
 * way to exercise it is two real accounts on two machines against the live server.
 * The open-queue cases are covered too, so this doubles as a regression net for the
 * pairing rewrite that party units required.
 *
 * `npm test` stays the SIM smoke check (a red `npm test` must keep meaning
 * "physics broke"), so this is its own script.
 */
import { Matchmaker, groupUnits, allianceOrder, type MatchmakerDeps, type QueueEntry } from '../server/matchmaking';
import type { PendingMatch } from '../server/matchTypes';
import type { QueueMode, ServerMsg } from '../src/net/protocol';
import { DEPLOY_REGIONS, bestHost, interRegionMs } from '../server/regions';
import { SKILL_BASE, skillCeiling } from '../server/matchmaking';
import { readFileSync } from 'node:fs';

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

/** a queue entry with everything the matchmaker reads and nothing it doesn't */
function entry(id: string, mode: QueueMode, opts: Partial<QueueEntry> = {}): QueueEntry {
  return {
    id,
    send: () => {},
    player: { name: id, teamName: '', teamNumber: 0 } as QueueEntry['player'],
    userId: `u-${id}`,
    mode,
    homeRegion: 'iad',
    accessMs: 10,
    build: 'test-build',
    enqueuedAt: 0,
    expandBumps: 0,
    ...opts,
  };
}

/**
 * Enqueue everyone, then let the staging microtasks land.
 *
 * `enqueue` matches synchronously but STAGES asynchronously (`assign` awaits the
 * intro-ELO reads and the stage write), so reading `staged` on the next line sees
 * an empty array whether or not a match was made. Every assertion below waits.
 */
async function pair(
  entries: QueueEntry[],
  deps: Partial<MatchmakerDeps> = {},
): Promise<{ mm: Matchmaker; staged: PendingMatch[] }> {
  const staged: PendingMatch[] = [];
  const mm = new Matchmaker({
    // frozen clock: the search radius never widens on its own, so a cross-region
    // pairing only happens if the code deliberately skips the gate
    now: () => 0,
    stage: async (m) => {
      staged.push(m);
    },
    ...deps,
  });
  for (const e of entries) mm.enqueue(e);
  await new Promise((r) => setTimeout(r, 0));
  return { mm, staged };
}

/** who ended up on which alliance, by entry id */
const alliancesOf = (m: PendingMatch | undefined): Record<string, string> =>
  Object.fromEntries((m?.roster ?? []).map((r) => [r.name, r.alliance]));
const namesOf = (m: PendingMatch | undefined): string =>
  (m?.roster ?? []).map((r) => r.name).sort().join(',');

// ---- unit grouping (the primitive everything else rests on) -----------------
{
  const a = entry('a', '2v2', { party: 'tok', partySize: 2 });
  const b = entry('b', '2v2');
  const c = entry('c', '2v2', { party: 'tok', partySize: 2 });
  const units = groupUnits([a, b, c]);
  check('units: a party is one unit', units.length === 2, `got ${units.length}`);
  check('units: party members share a unit', units[0].length === 2 && units[0][0].id === 'a');
  check('units: a party keeps its FIRST member place in line', units[1][0].id === 'b');
}
{
  // 2v2: one premade + two solos. The index split is positional (i < half ⇒ red),
  // so the party has to come out contiguous AND front-loaded.
  const g = [
    entry('s1', '2v2'),
    entry('p1', '2v2', { party: 't', partySize: 2 }),
    entry('s2', '2v2'),
    entry('p2', '2v2', { party: 't', partySize: 2 }),
  ];
  const ids = allianceOrder(g).map((e) => e.id);
  check('allianceOrder: premade lands in one half', ids[0].startsWith('p') && ids[1].startsWith('p'), ids.join(','));
}
{
  const g = [entry('a', '1v1'), entry('b', '1v1')];
  check('allianceOrder: no parties ⇒ FIFO untouched', allianceOrder(g) === g);
}

// ---- open queue: the pre-existing behaviour must not have moved -------------
{
  const { staged } = await pair([entry('a', '1v1')]);
  check('open 1v1: one waiter does not match', staged.length === 0);
}
{
  const { staged } = await pair([entry('a', '1v1'), entry('b', '1v1')]);
  check('open 1v1: two waiters pair', staged.length === 1);
  check('open 1v1: staged ranked', staged[0]?.ranked === true);
  check('open 1v1: one per alliance', new Set(staged[0]?.roster.map((r) => r.alliance)).size === 2);
}
{
  const { staged } = await pair(['a', 'b', 'c', 'd'].map((id) => entry(id, '2v2')));
  check('open 2v2: four waiters pair', staged.length === 1);
  check('open 2v2: two per alliance', staged[0]?.roster.filter((r) => r.alliance === 'red').length === 2);
}
{
  // different builds never share an authoritative match (desync guard)
  const { staged } = await pair([
    entry('a', '1v1', { build: 'sha-1' }),
    entry('b', '1v1', { build: 'sha-2' }),
  ]);
  check('open: mixed builds never pair', staged.length === 0);
}
{
  // the radius gate still bites for strangers: with the clock frozen at enqueue
  // time the ceiling is zero, so a cross-region pair must wait
  const { staged } = await pair([
    entry('a', '1v1', { homeRegion: 'iad' }),
    entry('b', '1v1', { homeRegion: 'syd' }),
  ]);
  check('open: cross-region strangers wait for the radius', staged.length === 0);
}

// ---- closed party (rated 1v1 challenge) ------------------------------------
{
  const { staged } = await pair([entry('a', '1v1', { party: 'tok', partySize: 2, partyOnly: true })]);
  check('closed 1v1: challenger alone waits', staged.length === 0);
}
{
  const { staged } = await pair([
    entry('a', '1v1', { party: 'tok', partySize: 2, partyOnly: true }),
    entry('b', '1v1', { party: 'tok', partySize: 2, partyOnly: true }),
  ]);
  check('closed 1v1: the pair matches', staged.length === 1);
  check('closed 1v1: rated', staged[0]?.ranked === true);
  const al = alliancesOf(staged[0]);
  check('closed 1v1: opponents, not teammates', !!al['a'] && al['a'] !== al['b'], JSON.stringify(al));
}
{
  // THE important one: a closed party is unreachable from the open pool. A stranger
  // waiting in 1v1 must never be pulled into somebody's friend challenge, and the
  // challenger must never be spent on the stranger.
  const half = await pair([
    entry('a', '1v1', { party: 'tok', partySize: 2, partyOnly: true }),
    entry('x', '1v1'),
  ]);
  check('closed 1v1: a stranger cannot be pulled in', half.staged.length === 0);

  const { staged } = await pair([
    entry('a', '1v1', { party: 'tok', partySize: 2, partyOnly: true }),
    entry('x', '1v1'),
    entry('b', '1v1', { party: 'tok', partySize: 2, partyOnly: true }),
  ]);
  check('closed 1v1: pairs with its own partner, not the stranger', staged.length === 1);
  check('closed 1v1: exactly the challenged pair', namesOf(staged[0]) === 'a,b', namesOf(staged[0]));
}
{
  // a challenge crosses any distance — the two already chose each other, so the
  // widening schedule has nothing to say about it
  const { staged } = await pair([
    entry('a', '1v1', { party: 'tok', partySize: 2, partyOnly: true, homeRegion: 'syd' }),
    entry('b', '1v1', { party: 'tok', partySize: 2, partyOnly: true, homeRegion: 'lhr' }),
  ]);
  check('closed 1v1: ignores the search radius', staged.length === 1);
}
{
  // ...but NOT the compatibility bucket. Two friends on different builds run
  // different code; matching them would desync the match, challenge or not.
  const { staged } = await pair([
    entry('a', '1v1', { party: 'tok', partySize: 2, partyOnly: true, build: 'sha-1' }),
    entry('b', '1v1', { party: 'tok', partySize: 2, partyOnly: true, build: 'sha-2' }),
  ]);
  check('closed 1v1: mixed builds still refuse', staged.length === 0);
}
{
  // two different challenges in flight at once must not cross-pair
  const cross = await pair([
    entry('a', '1v1', { party: 't1', partySize: 2, partyOnly: true }),
    entry('c', '1v1', { party: 't2', partySize: 2, partyOnly: true }),
  ]);
  check('closed 1v1: separate tokens never cross-pair', cross.staged.length === 0);

  const { staged } = await pair([
    entry('a', '1v1', { party: 't1', partySize: 2, partyOnly: true }),
    entry('c', '1v1', { party: 't2', partySize: 2, partyOnly: true }),
    entry('d', '1v1', { party: 't2', partySize: 2, partyOnly: true }),
  ]);
  check('closed 1v1: the second challenge resolves on its own token', staged.length === 1);
  check('closed 1v1: right pair matched', namesOf(staged[0]) === 'c,d', namesOf(staged[0]));
}

// ---- premade party (ranked 2v2 with a friend) ------------------------------
{
  const { staged } = await pair([
    entry('p1', '2v2', { party: 'tok', partySize: 2 }),
    entry('p2', '2v2', { party: 'tok', partySize: 2 }),
  ]);
  check('premade 2v2: a party of two does not fill a 4-slot match', staged.length === 0);
}
{
  const { staged } = await pair([
    entry('p1', '2v2', { party: 'tok', partySize: 2 }),
    entry('p2', '2v2', { party: 'tok', partySize: 2 }),
    entry('s1', '2v2'),
    entry('s2', '2v2'),
  ]);
  check('premade 2v2: fills from the open pool', staged.length === 1);
  const al = alliancesOf(staged[0]);
  check('premade 2v2: the party plays TOGETHER', !!al['p1'] && al['p1'] === al['p2'], JSON.stringify(al));
  check('premade 2v2: the solos are the opponents', al['s1'] === al['s2'] && al['s1'] !== al['p1'], JSON.stringify(al));
}
{
  const { staged } = await pair([
    entry('a1', '2v2', { party: 'ta', partySize: 2 }),
    entry('b1', '2v2', { party: 'tb', partySize: 2 }),
    entry('a2', '2v2', { party: 'ta', partySize: 2 }),
    entry('b2', '2v2', { party: 'tb', partySize: 2 }),
  ]);
  check('premade 2v2: two premades pair', staged.length === 1);
  const al = alliancesOf(staged[0]);
  check(
    'premade 2v2: each premade keeps its own alliance',
    !!al['a1'] && al['a1'] === al['a2'] && al['b1'] === al['b2'] && al['a1'] !== al['b1'],
    JSON.stringify(al),
  );
}
{
  // a premade must be added all-or-nothing: with only one slot left it is skipped
  // rather than half-taken, which would strand its other member
  const { staged } = await pair([
    entry('s1', '2v2'),
    entry('s2', '2v2'),
    entry('s3', '2v2'),
    entry('p1', '2v2', { party: 'tok', partySize: 2 }),
    entry('p2', '2v2', { party: 'tok', partySize: 2 }),
  ]);
  check('premade 2v2: a group forms', staged.length === 1);
  const inGroup = staged[0]?.roster.filter((r) => r.name.startsWith('p')).length ?? 0;
  check('premade 2v2: party is all-in or all-out', inGroup === 0 || inGroup === 2, `${inGroup} of 2 — ${namesOf(staged[0])}`);
  const al = alliancesOf(staged[0]);
  if (inGroup === 2) {
    check('premade 2v2: and still on one alliance', al['p1'] === al['p2'], JSON.stringify(al));
  }
}

// ---- NEAREST-FIRST pairing (what makes the fast radius safe) ----------------
// The radius no longer buys locality by refusing to look — it opens same-continent
// immediately and worldwide within 6s. Locality is bought here instead, by picking
// the CLOSEST eligible opponent rather than the first one in the queue that fits.
// Under the old first-fit rule these were one knob, so matching faster necessarily
// meant matching worse; if this regresses, that trade quietly comes back.
{
  // the anchor is in iad; a far opponent (nrt, 164) is ahead of a near one (lhr, 76)
  // in the queue. First-fit would take nrt purely for being earlier.
  const { staged } = await pair([
    entry('anchor', '1v1', { homeRegion: 'iad' }),
    entry('far', '1v1', { homeRegion: 'nrt' }),
    entry('near', '1v1', { homeRegion: 'lhr' }),
  ]);
  check('nearest-first: the CLOSER opponent wins over the earlier one',
    namesOf(staged[0]) === 'anchor,near', namesOf(staged[0]));
}
{
  // ...and a same-region opponent beats everyone, however late they queued
  const { staged } = await pair([
    entry('anchor', '1v1', { homeRegion: 'iad' }),
    entry('cross', '1v1', { homeRegion: 'syd' }),
    entry('local', '1v1', { homeRegion: 'iad' }),
  ]);
  check('nearest-first: a same-region opponent still wins at a wide radius',
    namesOf(staged[0]) === 'anchor,local', namesOf(staged[0]));
  check('nearest-first: ...and the match hosts in that shared region', staged[0]?.hostRegion === 'iad');
}
{
  // FIFO fairness survives it: equally-close candidates are taken in queue order,
  // because a tie does NOT displace the incumbent
  const { staged } = await pair([
    entry('anchor', '1v1', { homeRegion: 'iad' }),
    entry('first', '1v1', { homeRegion: 'iad' }),
    entry('second', '1v1', { homeRegion: 'iad' }),
  ]);
  check('nearest-first: a TIE goes to whoever waited longer', namesOf(staged[0]) === 'anchor,first', namesOf(staged[0]));
}
{
  // The radius still MEANS something: the worst pair on the map is held back on the
  // first attempt, so a wide-open queue never instantly commits someone to a distant
  // match that a few seconds of waiting might have improved. (lhr↔syd is 251ms
  // direct, but the gate reads `bestHost`'s SPREAD — 148 — because the minimax host
  // lands on sjc in the middle. 148 is the worst spread any pair can produce, which
  // is why one widening step now covers the entire map.)
  const { staged } = await pair([
    entry('a', '1v1', { homeRegion: 'lhr' }),
    entry('b', '1v1', { homeRegion: 'syd' }),
  ]);
  check('radius: the worst-case pair is NOT taken on the first attempt', staged.length === 0);
}
{
  // ...but nobody is stranded — once the radius has opened (here via two expand
  // bumps, which the frozen test clock lets us reach directly) it does match.
  const { staged } = await pair([
    entry('a', '1v1', { homeRegion: 'lhr', expandBumps: 2 }),
    entry('b', '1v1', { homeRegion: 'syd', expandBumps: 2 }),
  ]);
  check('radius: ...and DOES match once widened (nobody is stranded)', staged.length === 1);
}

// ---- a challenge must be queued under the CHALLENGE'S game -------------------
// The matchmaker buckets by game so a Chain Reaction queuer can never be paired
// into a DECODE room. That rule is correct, and it is also what made a cross-game
// challenge silently impossible: a challenge is accepted from wherever the
// recipient already is, and the client queued under the game it was CURRENTLY in
// rather than the one the challenge names. The closed pair then sat in two
// different buckets waiting for each other, with nothing on either screen to say
// why. These pin both halves — the bucket rule stays strict, and the fix is that
// both entries carry the challenge's own game.
{
  const { staged } = await pair([
    entry('a', '1v1', { party: 'tok', partySize: 2, partyOnly: true, game: 'decode' }),
    entry('b', '1v1', { party: 'tok', partySize: 2, partyOnly: true, game: 'chain' }),
  ]);
  check('challenge: a pair split across GAMES never stages (bucket rule holds)', staged.length === 0);
}
{
  const { staged } = await pair([
    entry('a', '1v1', { party: 'tok', partySize: 2, partyOnly: true, game: 'chain' }),
    entry('b', '1v1', { party: 'tok', partySize: 2, partyOnly: true, game: 'chain' }),
  ]);
  check('challenge: both sides on the challenge’s game DO pair', staged.length === 1);
  check('challenge: ...and the room is staged for that game', staged[0]?.game === 'chain', String(staged[0]?.game));
}

// ---- the one-live-game guard must not forfeit a staged ranked match ----------
// `Room.stagedFor` is the predicate that lets a matchmaker-staged join through
// the "you already have a game in progress" refusal. Without it, being matched
// out of a BACKGROUND queue while a solo record run was still in flight was an
// automatic forfeit: the run's slot is held for the reconnect grace, so the join
// that pays ELO is the one that gets refused. It must answer for exactly the
// roster and nobody else — a random code-joiner must still be turned away.
{
  const { Room } = await import('../server/room');
  const roster = [
    { userId: 'u-a', name: 'a', alliance: 'red' as const, startIndex: 0, introElo: null },
    { userId: 'u-b', name: 'b', alliance: 'blue' as const, startIndex: 0, introElo: null },
  ] as never;
  const plain = new Room('plain', () => {}, { kind: 'versus' }, undefined as never);
  check('stagedFor: an ordinary room is staged for nobody', !plain.stagedFor('u-a'));
  const staged = new Room('iad-1v1x', () => {}, { kind: 'versus' }, undefined as never);
  staged.applyPending({ code: 'iad-1v1x', hostRegion: 'iad', mode: '1v1', seed: 1, roster, ranked: true });
  check('stagedFor: a staged ranked room answers for its roster', staged.stagedFor('u-a') && staged.stagedFor('u-b'));
  check('stagedFor: ...and for nobody else (a code-guesser is still refused)', !staged.stagedFor('u-stranger'));
}

// ---- queue depth is PER GAME ------------------------------------------------
// Pairing buckets by game, so a combined count advertised a pool the reader could
// never match from: one Chain Reaction queuer made every DECODE menu read "1V1 1".
{
  const { mm } = await pair([
    entry('d1', '1v1', { game: 'decode' }),
    entry('c1', '1v1', { game: 'chain' }),
    entry('c2', '2v2', { game: 'chain' }),
  ]);
  const byGame = mm.queueSizesByGame();
  check('per-game depth: DECODE counts only its own queuer', byGame.decode?.['1v1'] === 1, JSON.stringify(byGame));
  check('per-game depth: Chain Reaction counts only its own', byGame.chain?.['1v1'] === 1);
  check('per-game depth: ...in each bucket separately', byGame.chain?.['2v2'] === 1 && byGame.decode?.['2v2'] === 0);
  check('per-game depth: a game with nobody waiting has no entry at all', !byGame.nope);
  // the combined shape stays correct too — older clients still read it
  check('per-game depth: the combined total is unchanged for old clients', mm.queueSizes()['1v1'] === 2);
}
{
  // a CLOSED challenge is not an open pool in either shape
  const { mm } = await pair([
    entry('p1', '1v1', { game: 'decode', party: 'tok', partySize: 2, partyOnly: true }),
  ]);
  check('per-game depth: a closed challenge is not advertised as available',
    (mm.queueSizesByGame().decode?.['1v1'] ?? 0) === 0);
}

// ---- the operator view of the queue -----------------------------------------
// A depth count cannot distinguish "nobody is queueing" from "everybody is queueing
// and nothing is pairing", which is exactly the failure an operator gets called
// about. The bucket + the WAIT is what separates them. Ranked requires an account,
// so every row here already belongs to a signed-in player — there is no guest data
// in this surface by construction.
{
  const { mm } = await pair([entry('a', '1v1'), entry('x', '2v2')]);
  const q = mm.queuedPlayers(30_000);
  check('operator queue: reports each waiting account', q.length === 2, JSON.stringify(q));
  check('operator queue: with its bucket', q.find((e) => e.userId === 'u-a')?.mode === '1v1');
  check('operator queue: and how long it has been waiting', q.find((e) => e.userId === 'u-a')?.waitedS === 30);
  check('operator queue: an anonymous entry cannot appear (ranked needs an account)',
    q.every((e) => !!e.userId));
}

// ---- queue depth reporting --------------------------------------------------
{
  const { mm } = await pair([
    entry('a', '1v1', { party: 'tok', partySize: 2, partyOnly: true }),
    entry('x', '1v1'),
  ]);
  const sizes = mm.queueSizes();
  check('queueSizes: closed parties are not advertised as available', sizes['1v1'] === 1, String(sizes['1v1']));
}
{
  // a closed waiter is told about its OWN party, not the open pool it can't join
  const seen: ServerMsg[] = [];
  await pair([
    entry('x1', '1v1'),
    entry('a', '1v1', { party: 'tok', partySize: 2, partyOnly: true, send: (m) => seen.push(m) }),
  ]);
  const last = seen.filter((m) => m.t === 'queued').pop();
  check('queued: a challenge reports 1/2, not the open depth', last?.t === 'queued' && last.size === 1, JSON.stringify(last));
}
{
  // THE OPEN-POOL HALF of the same rule, which had no check at all — only the closed
  // party above did. `broadcastStatus` counts per BUCKET (game|channel|build), and the
  // count a waiter is shown decides whether the UI reads "waiting" or "nearly ready",
  // so a count that leaked across builds would promise a match that pairing can never
  // make. Two builds queued together: each must be told 1, never 2. This is also the
  // guard on the count-once rewrite of that method — the shape it replaced computed
  // the same number per recipient, so an off-by-one there would be silent.
  const seen: Record<string, ServerMsg[]> = { b1: [], b2: [], b1b: [] };
  await pair([
    entry('b1', '1v1', { build: 'build-one', send: (m) => seen.b1.push(m) }),
    entry('b2', '1v1', { build: 'build-two', send: (m) => seen.b2.push(m) }),
  ]);
  const sizeOf = (k: string): number | undefined => {
    const m = seen[k].filter((x) => x.t === 'queued').pop();
    return m?.t === 'queued' ? m.size : undefined;
  };
  check('queued: the depth is the waiter’s OWN build bucket, not the whole queue',
    sizeOf('b1') === 1 && sizeOf('b2') === 1, `b1=${sizeOf('b1')} b2=${sizeOf('b2')}`);
}
{
  // and two waiters that DO share a bucket must both be told 2 — the other direction of
  // the same count, so a bucket key that over-separated would be caught too
  const seen: Record<string, ServerMsg[]> = { s1: [], s2: [] };
  await pair([
    entry('s1', '2v2', { build: 'same', send: (m) => seen.s1.push(m) }),
    entry('s2', '2v2', { build: 'same', send: (m) => seen.s2.push(m) }),
  ]);
  const sizeOf = (k: string): number | undefined => {
    const m = seen[k].filter((x) => x.t === 'queued').pop();
    return m?.t === 'queued' ? m.size : undefined;
  };
  check('queued: waiters sharing a bucket are both told the shared depth',
    sizeOf('s1') === 2 && sizeOf('s2') === 2, `s1=${sizeOf('s1')} s2=${sizeOf('s2')}`);
}

// ---- the SERVER-STAMPED rating ---------------------------------------------
// Pairing on skill needs a rating ON the entry, and where it comes from is the whole
// security story: the queue message carries no rating field and must never gain one.
// These pin the stamp's lifecycle, which is the part that can fail quietly.
{
  const asked: string[] = [];
  const { mm } = await pair([entry('r1', '1v1', { userId: 'u-r1' })], {
    rating: async (userId) => {
      asked.push(userId);
      return { rating: 1420, placed: true };
    },
  });
  await new Promise((r) => setTimeout(r, 0));
  const e = mm.queuedPlayers(0).find((x) => x.userId === 'u-r1');
  check('rating: the queue was asked for the entry’s rating', asked.includes('u-r1'), asked.join(','));
  check('rating: ...and the entry is still queued while it resolves', !!e);
}
{
  // FAIL OPEN. A rating source that returns null — DB off, signed out, a read that
  // threw — must leave the entry unrated and matchable, never gate it out. A database
  // that cannot answer must not lock everyone out of ranked.
  const { staged } = await pair(
    [entry('f1', '1v1', { userId: 'u-f1' }), entry('f2', '1v1', { userId: 'u-f2' })],
    { rating: async () => null },
  );
  check('rating: a null read still pairs (fail open, not a gate)', staged.length === 1, String(staged.length));
}
{
  // a rating source that THROWS is the same situation and must not reject into the
  // queue press — an unhandled rejection there would take the matchmaker down
  const { staged } = await pair(
    [entry('t1', '1v1', { userId: 'u-t1' }), entry('t2', '1v1', { userId: 'u-t2' })],
    { rating: async () => { throw new Error('neon is asleep'); } },
  );
  check('rating: a THROWING read still pairs and never rejects into the join', staged.length === 1, String(staged.length));
}
{
  // the stamp must not resurrect an entry that has since left. The read is fired
  // off the join path, so a player can leave, or re-queue under a new connection id,
  // while it is in flight — writing onto the old object would at best do nothing and
  // at worst carry a departed identity onto a fresh entry.
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => { release = r; });
  const staged: PendingMatch[] = [];
  const mm = new Matchmaker({
    now: () => 0,
    stage: async (m) => { staged.push(m); },
    rating: async () => { await gate; return { rating: 1700, placed: true }; },
  });
  mm.enqueue(entry('gone', '1v1', { userId: 'u-gone' }));
  mm.remove('gone');
  release?.();
  await new Promise((r) => setTimeout(r, 0));
  check('rating: a stamp landing after the player left does not re-add them',
    mm.queuedPlayers(0).every((x) => x.userId !== 'u-gone'));
}
{
  // THE STAMP LANDS AFTER THE JOIN, ON PURPOSE, and that is visible here: two players
  // who enqueue back-to-back pair SYNCHRONOUSLY inside the second `enqueue`, before
  // either rating read has resolved. Correct — an empty queue has nobody to choose
  // between, so there is nothing for a rating to improve — but it means a test of the
  // stamp has to let the first read land before the second player arrives, which is
  // also what a real queue looks like.
  const staged: PendingMatch[] = [];
  const mm = new Matchmaker({
    now: () => 0,
    stage: async (m) => { staged.push(m); },
    rating: async (userId) => ({ rating: userId === 'u-i1' ? 1234 : 1567, placed: true }),
  });
  mm.enqueue(entry('i1', '1v1', { userId: 'u-i1' }));
  await new Promise((r) => setTimeout(r, 0)); // the first player's rating lands
  mm.enqueue(entry('i2', '1v1', { userId: 'u-i2' }));
  await new Promise((r) => setTimeout(r, 0));
  const elos = (staged[0]?.roster ?? []).map((r) => r.introElo);
  check('rating: the intro card is served from the stamp, not a fresh query',
    elos.includes(1234), JSON.stringify(elos));
  // and the SECOND player, who paired before their own read resolved, falls through to
  // the DB path — null here, because this harness has no database. That is the fallback
  // working: an absent stamp must read as "Unranked", never as a fabricated 1000.
  check('rating: an unstamped player falls back rather than inventing a rating',
    elos.length === 2 && elos.includes(null), JSON.stringify(elos));
}

// ---- the fleet and the code must name the same regions ----------------------
// THE CHECK THAT ACTUALLY BITES. Iterating over DEPLOY_REGIONS cannot catch a region
// MISSING from it — the loop just runs one fewer time — and that is the direction the
// bug came from. So the fleet is declared in scripts/fly-deploy.sh and asserted here.
// Neither file can see `fly machine list`, but the deploy script is what creates the
// machines, so it is the closest thing to the truth that lives in the repo.
{
  const sh = readFileSync(new URL('./fly-deploy.sh', import.meta.url), 'utf8');
  const m = /^FLEET_REGIONS=\(([^)]*)\)/m.exec(sh);
  const fleet = (m?.[1] ?? '').trim().split(/\s+/).filter(Boolean);
  check('fleet: fly-deploy.sh declares the region list', fleet.length >= 5, fleet.join(','));
  for (const r of fleet) {
    // every machine we run must at least have a latency row, or its players are
    // unpairable rather than merely far
    check(`fleet: ${r} has an RTT row (else its players cannot be matched at all)`,
      interRegionMs(r, 'iad') < 300 || r === 'iad', `${r}->iad = ${interRegionMs(r, 'iad')}`);
  }
  // and every region the matchmaker may HOST in must be a region we actually run
  for (const r of DEPLOY_REGIONS) {
    check(`fleet: DEPLOY_REGIONS.${r} has a machine in the fleet`, fleet.includes(r), fleet.join(','));
  }
}

// ---- region topology: the table the whole radius gate is computed from -------
// This is a SILENT-FAILURE class and it had already fired. `interRegionMs` answers a
// RADIUS_MAX-sized penalty for any region it has no row for, so a deployed region
// missing from the table does not read as "far" — it reads as UNPAIRABLE until the
// radius saturates six seconds later, and never at all for a `noWiden` player. `ord`
// had a live machine and no row: two players in the same city measured spread 300
// against an opening ceiling of 90, and their match hosted in another region.
{
  for (const a of DEPLOY_REGIONS) {
    check(`regions: ${a} has a zero diagonal`, interRegionMs(a, a) === 0, String(interRegionMs(a, a)));
    for (const b of DEPLOY_REGIONS) {
      if (a === b) continue;
      const ab = interRegionMs(a, b);
      const ba = interRegionMs(b, a);
      check(`regions: ${a}<->${b} is symmetric`, ab === ba, `${ab} vs ${ba}`);
      // the fallback is RADIUS_MAX_MS-sized; a real row is always well under it
      check(`regions: ${a}<->${b} has a REAL row, not the unknown-region penalty`,
        ab > 0 && ab < 300, String(ab));
    }
  }
}
{
  // the property that actually matters, asserted for EVERY deployed region rather
  // than for the one that broke: two players who landed in the same region must be
  // hostable there at zero spread, so they pair on the opening ceiling
  for (const r of DEPLOY_REGIONS) {
    const h = bestHost([{ homeRegion: r, accessMs: 10 }, { homeRegion: r, accessMs: 10 }]);
    check(`regions: two players in ${r} host in ${r} at spread 0`,
      h.hostRegion === r && h.spread === 0, JSON.stringify(h));
  }
}
{
  // and end to end through the matchmaker, at t=0, with the radius at its tightest —
  // including the noWiden case, which is the one that never recovers
  for (const r of DEPLOY_REGIONS) {
    const { staged } = await pair([
      entry(`${r}1`, '1v1', { homeRegion: r, noWiden: true }),
      entry(`${r}2`, '1v1', { homeRegion: r, noWiden: true }),
    ]);
    check(`regions: two region-locked players in ${r} pair immediately`,
      staged.length === 1, `${staged.length} staged`);
  }
}

// ---- the two pairing rules the tests did NOT cover --------------------------
// Both of these were found by mutation: reverting `spread < pick.spread` to first-fit,
// and replacing `Math.min(...trial.map(ceilingOf))` with the anchor's own ceiling, each
// passed all 160 checks. They are the two rules any rewrite of findMatch has to
// re-derive, so they are pinned here BEFORE the pairing core is touched.
{
  // NEAREST-FIRST: among legal candidates the matchmaker takes the one with the
  // SMALLEST resulting spread, not the first one in the queue. Anchor in iad; syd is
  // 148 away (best host sjc), nrt is 109 (best host sjc). syd is queued FIRST, so
  // first-fit takes syd and nearest-first takes nrt.
  let t = 0;
  const staged: PendingMatch[] = [];
  const mm = new Matchmaker({ now: () => t, stage: async (m) => { staged.push(m); } });
  mm.enqueue(entry('anchor', '1v1', { homeRegion: 'iad' }));
  mm.enqueue(entry('far', '1v1', { homeRegion: 'syd' }));
  mm.enqueue(entry('near', '1v1', { homeRegion: 'nrt' }));
  await new Promise((r) => setTimeout(r, 0));
  check('nearest-first: nothing is legal at the opening ceiling', staged.length === 0, `${staged.length}`);
  t = 20_000; // past RADIUS_MAX: every candidate is now legal, so the CHOICE is visible
  mm.tick();
  await new Promise((r) => setTimeout(r, 0));
  check('nearest-first: a match is made once the radius has opened', staged.length === 1, `${staged.length}`);
  check('nearest-first: it takes the CLOSEST candidate, not the first queued',
    namesOf(staged[0]) === 'anchor,near', namesOf(staged[0]));
  check('nearest-first: and hosts on the fair midpoint for that pair',
    staged[0]?.hostRegion === 'sjc', staged[0]?.hostRegion);
}
{
  // GROUP-MINIMUM CEILING: the radius a trial group is held to is the SMALLEST of its
  // members, so one freshly-arrived player caps a group of veterans. Three iad players
  // who have waited past saturation (ceiling 300) plus one syd player who just arrived
  // (ceiling 90). The syd pairing costs 148, which the anchor alone would allow and the
  // group minimum must refuse.
  let t = 0;
  const staged: PendingMatch[] = [];
  const mm = new Matchmaker({ now: () => t, stage: async (m) => { staged.push(m); } });
  mm.enqueue(entry('v1', '2v2', { homeRegion: 'iad' }));
  mm.enqueue(entry('v2', '2v2', { homeRegion: 'iad' }));
  mm.enqueue(entry('v3', '2v2', { homeRegion: 'iad' }));
  t = 20_000; // the three veterans are now saturated at RADIUS_MAX
  mm.enqueue(entry('fresh', '2v2', { homeRegion: 'syd' })); // stamped enqueuedAt = 20000
  await new Promise((r) => setTimeout(r, 0));
  check('group ceiling: a fresh arrival caps the whole group, so no match forms',
    staged.length === 0, `${staged.length} staged: ${namesOf(staged[0])}`);
  t = 40_000; // now the fresh player has saturated too and the group is legal
  mm.tick();
  await new Promise((r) => setTimeout(r, 0));
  check('group ceiling: ...and the match forms once THEY have waited, not before',
    staged.length === 1 && namesOf(staged[0]) === 'fresh,v1,v2,v3', namesOf(staged[0]));
}

// ---- the skill window --------------------------------------------------------
// Pairing now reads rating as well as latency. Latency stays PRIMARY; skill is a second
// gate plus a tiebreak, never a partition, so a same-region opponent is never passed
// over for a better-rated distant one.
{
  check('skill: the band opens at SKILL_BASE', skillCeiling(0, 0) === SKILL_BASE, String(skillCeiling(0, 0)));
  check('skill: it widens on the radius clock', skillCeiling(3000, 0) > skillCeiling(0, 0));
  check('skill: and goes UNBOUNDED, so any pairing legal before this is legal again',
    skillCeiling(6000, 0) === Infinity, String(skillCeiling(6000, 0)));
  check('skill: an expandSearch bump widens it too', skillCeiling(0, 2) === Infinity);
}
{
  // a gap wider than the opening band waits; it is not refused forever
  const rated = (id: string, rating: number): Partial<QueueEntry> =>
    ({ rating, placed: true } as Partial<QueueEntry>);
  let t = 0;
  const staged: PendingMatch[] = [];
  const mm = new Matchmaker({ now: () => t, stage: async (m) => { staged.push(m); } });
  mm.enqueue(entry('lo', '1v1', rated('lo', 900)));
  mm.enqueue(entry('hi', '1v1', rated('hi', 1900)));   // a 1000-point gap
  await new Promise((r) => setTimeout(r, 0));
  check('skill: a 1000-point gap does not pair on the opening band', staged.length === 0, `${staged.length}`);
  t = 6000; // the band is unbounded from here
  mm.tick();
  await new Promise((r) => setTimeout(r, 0));
  check('skill: ...and pairs once the band opens, so nobody starves', staged.length === 1, `${staged.length}`);
}
{
  // UNRATED MEANS DO NOT GATE. This is the floor the whole feature degrades to — a DB
  // outage, a dev box, a fresh act, or anyone inside their placement games.
  const { staged } = await pair([
    entry('u1', '1v1', { rating: 900, placed: false } as Partial<QueueEntry>),
    entry('u2', '1v1', { rating: 1900, placed: false } as Partial<QueueEntry>),
  ]);
  check('skill: two UNPLACED players pair regardless of the gap', staged.length === 1, `${staged.length}`);
}
{
  const { staged } = await pair([entry('n1', '1v1'), entry('n2', '1v1')]);
  check('skill: entries with no rating at all pair exactly as before', staged.length === 1, `${staged.length}`);
}
{
  // one rated + one unrated: the unrated member imposes no ceiling and is not in the
  // span, so there is nothing to gate on and the match is made
  const { staged } = await pair([
    entry('r', '1v1', { rating: 1900, placed: true } as Partial<QueueEntry>),
    entry('x', '1v1'),
  ]);
  check('skill: a rated player still pairs with an unrated one', staged.length === 1, `${staged.length}`);
}
{
  // THE TIEBREAK. Every player is in one region, so every spread is 0 and latency cannot
  // separate them — which is exactly where skill does its work.
  //
  // Getting a CHOICE in front of the anchor takes some care, and both details are
  // load-bearing. `enqueue` matches synchronously, so two compatible waiters pair the
  // instant the second arrives and a third never gets considered; and findMatch anchors
  // on the OLDEST unit, so the player doing the choosing must be the first to queue.
  //
  // So: all three are mutually out of band at t=0 (every pairwise gap exceeds 200), and
  // the clock is then advanced to widen the band to 500, at which point the anchor at
  // 1000 sees BOTH 1500 (span 500) and 1250 (span 250) at once and has to pick.
  let t = 0;
  const staged: PendingMatch[] = [];
  const mm = new Matchmaker({ now: () => t, stage: async (m) => { staged.push(m); } });
  mm.enqueue(entry('anchor', '1v1', { homeRegion: 'iad', rating: 1000, placed: true } as Partial<QueueEntry>));
  mm.enqueue(entry('far', '1v1', { homeRegion: 'iad', rating: 1500, placed: true } as Partial<QueueEntry>));
  mm.enqueue(entry('near', '1v1', { homeRegion: 'iad', rating: 1250, placed: true } as Partial<QueueEntry>));
  await new Promise((r) => setTimeout(r, 0));
  check('skill: nothing pairs while every gap is outside the opening band',
    staged.length === 0, `${staged.length}`);
  t = 3000; // band widens to SKILL_BASE + SKILL_STEP
  mm.tick();
  await new Promise((r) => setTimeout(r, 0));
  check('skill: among equal-latency candidates it takes the closest RATED one',
    namesOf(staged[0]) === 'anchor,near', namesOf(staged[0]));
}
{
  // A CLOSED PARTY IS NEVER SKILL-GATED. Two friends who challenged each other have
  // already decided; a rating band there would refuse a match both sides asked for.
  const { staged } = await pair([
    entry('c1', '1v1', { party: 'tok', partySize: 2, partyOnly: true, rating: 600, placed: true } as Partial<QueueEntry>),
    entry('c2', '1v1', { party: 'tok', partySize: 2, partyOnly: true, rating: 2000, placed: true } as Partial<QueueEntry>),
  ]);
  check('skill: a friend challenge ignores the band entirely', staged.length === 1, `${staged.length}`);
}
{
  // the freshest arrival caps the group, exactly as it does for the radius
  let t = 0;
  const staged: PendingMatch[] = [];
  const mm = new Matchmaker({ now: () => t, stage: async (m) => { staged.push(m); } });
  mm.enqueue(entry('old', '1v1', { rating: 1000, placed: true } as Partial<QueueEntry>));
  t = 6000; // `old` alone would now accept anyone
  mm.enqueue(entry('new', '1v1', { rating: 1900, placed: true } as Partial<QueueEntry>));
  await new Promise((r) => setTimeout(r, 0));
  check('skill: a fresh arrival caps the group, so the wide gap still waits',
    staged.length === 0, `${staged.length}`);
}

// ---- report ----------------------------------------------------------------
if (failures.length) {
  console.error(`\n✗ matchmaker: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ matchmaker: ${passed} checks passed`);
