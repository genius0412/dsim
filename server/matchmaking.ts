import { Room, type Client } from './room';
import { persistMatch, persistDodges, persistBehaviour } from './persist';
import { actFor, getRating, getSkill, createPendingMatch } from './db/repo';
import { dbEnabled } from './db/pool';
import type { GameId } from '../src/types';
import { DEPLOY_REGIONS, bestHost, type PingInfo } from './regions';
import type { PendingMatch, PendingRosterEntry } from './matchTypes';
import { QUEUE_NEED, type LobbyPlayer, type QueueMode, type ServerMsg } from '../src/net/protocol';

/**
 * Region-aware ranked matchmaking. Runs on the DESIGNATED matchmaker machine (all
 * `?mm=1` connections are fly-replayed here), so it holds ONE global queue per
 * bucket across every region. Pairing is region-local first and widens over time:
 *
 *  - Each entry reports `homeRegion` + `accessMs`; the matchmaker estimates every
 *    player's latency to every region (`bestHost`) and hosts a match on the fair
 *    MIDPOINT region (minimax).
 *  - A pairing is only allowed once its cross-region `spread` fits under every
 *    member's SEARCH RADIUS, which starts at 0 (same region only) and widens with
 *    wait time / an explicit `expandSearch`. So you get a local match if one is
 *    available soon, and a farther one only after waiting.
 *
 * On a match the matchmaker STAGES the roster (Postgres `pending_matches`) and sends
 * `matchAssigned`; the clients reconnect to the host region, which builds the real
 * match. When the DB is off (local dev) it falls back to hosting the match right
 * here (`localStart`), which only works for same-machine players — fine for dev.
 */

/**
 * Search-radius schedule, in CROSS-REGION ms (not absolute ping — a player's own
 * access latency never counts against the gate, so a bad local link can't block a
 * local match).
 *
 * TUNED FOR A SMALL POOL, which is the pool this game actually has. The radius is
 * not a quality mechanism — `findMatch` picks the CLOSEST eligible opponent, so a
 * local match is taken whenever a local match exists, at any radius. All the
 * radius decides is HOW LONG YOU WAIT FOR A BETTER ONE TO SHOW UP. On a pool of
 * two or three people that better one is not coming, and the old schedule (0ms
 * for the first 8s, +60ms per 8s) charged everyone for it: 16 seconds before two
 * players on opposite US coasts were even allowed to meet, 40 before the queue
 * went global. With a handful of players online that wait WAS the matchmaking
 * time.
 *
 * So: open at 90ms, which already covers every same-continent pair (iad↔lhr 76,
 * iad↔sjc 85) — those are good matches, and there is nothing to gain by making
 * them wait. Then reach worldwide in 6 seconds instead of 40.
 */
export const RADIUS_BASE_MS = 90;
export const RADIUS_STEP_MS = 105;
export const RADIUS_INTERVAL_MS = 3000;
export const RADIUS_MAX_MS = 300;

/** the widening ceiling for one waiting entry (cross-region ms it will tolerate) */
export function radiusCeiling(waitedMs: number, expandBumps: number, noWiden?: boolean): number {
  if (noWiden) return 0; // stay region-local forever
  const steps = Math.floor(Math.max(0, waitedMs) / RADIUS_INTERVAL_MS) + expandBumps;
  return Math.min(RADIUS_MAX_MS, RADIUS_BASE_MS + RADIUS_STEP_MS * steps);
}

/**
 * SKILL SCHEDULE — the rating spread a waiting entry will tolerate in its match.
 *
 * Units are Glicko-2 rating points, and the numbers come from what a gap MEANS. At an
 * established RD the expected score for the stronger player runs 56.8% at a 50-point
 * gap, 63.3% at 100, 74.8% at 200, 83.6% at 300 and 89.8% at 400. So ±200 is the edge
 * of a game that is still a game, and anything under ±50 is noise on a pool this size.
 *
 * IT WIDENS ON THE SAME CLOCK AS THE RADIUS, and saturates at the same instant —
 * `RADIUS_INTERVAL_MS`, unbounded from step 2, which is the 6s where `radiusCeiling`
 * reaches `RADIUS_MAX_MS`. That lock is deliberate: with two independent schedules a
 * group can sit latency-eligible and skill-blocked (or the reverse) for an unbounded
 * stretch, and nobody watching the queue can tell which gate is holding them.
 *
 * UNBOUNDED, not merely large, is what makes anti-starvation a theorem rather than a
 * tuning question: from 6 seconds on, every pairing that would have been legal before
 * this existed is legal again. The gate can delay a match; it can never prevent one.
 *
 * This pool is young and clusters hard around the 1000 default, so the median match was
 * already inside ±200 by luck. The tail is the harm and the tail is the target —
 * measured on today's latency-only pairing at 2000 concurrent, the spread is p50 164 /
 * p90 436 / p99 715, and a 715-point gap is a ~95% foregone conclusion.
 *
 * SKILL_BASE IS THE DIAL THAT BINDS. Swept over the same 2000-concurrent population,
 * rating spread against wait (scripts/zz-mm-quality.ts, 6 simulated minutes each):
 *
 *   SKILL_BASE   spread p50 / p90 / p99     wait p50 / p90 / p99
 *          100        95 /  320 /  516            2 /   4 /   7
 *          200       140 /  322 /  516            2 /   3 /   5    <- shipped
 *          400       171 /  357 /  491            2 /   3 /   4
 *      (off)         176 /  439 /  636            2 /   3 /   3
 *
 * 200 takes essentially all of the p90 win (439 -> 322, a 27% cut in the tail that
 * actually hurts) for two seconds at p99. Tightening to 100 buys a much better MEDIAN
 * and almost no further p90, for another two seconds — the wrong trade on a young pool
 * that is already clustered near the 1000 default, where the median match was fine by
 * luck and the tail was the harm. Revisit when the population is dense enough that a
 * tighter band still has somebody inside it.
 */
export const SKILL_BASE = 200;
export const SKILL_STEP = 300;
/**
 * Steps after which the band is UNBOUNDED. 2 puts it at 6s, where the radius also
 * saturates.
 *
 * ⚠️ MEASURED, THIS DIAL DOES NOT CURRENTLY BIND. Over a 2000-concurrent population
 * (scripts/zz-mm-quality.ts) moving it from 2 to 4 changed nothing at all — not one
 * percentile of wait or of spread — because the queue drains long before anyone reaches
 * the saturation step (wait p99 is 5s against a 6s opening). It is kept because it is
 * what makes anti-starvation a theorem rather than a hope, and it will start to bind on
 * a pool deep enough to hold people past six seconds. Do not tune it against today's
 * numbers; it has no effect on them.
 *
 * SKILL_BASE is the dial that does bind — see the sweep on it above.
 */
export const SKILL_OPEN_STEPS = 2;

export function skillCeiling(waitedMs: number, expandBumps: number): number {
  const steps = Math.floor(Math.max(0, waitedMs) / RADIUS_INTERVAL_MS) + expandBumps;
  return steps >= SKILL_OPEN_STEPS ? Infinity : SKILL_BASE + SKILL_STEP * steps;
}

/**
 * The rating spread of a trial group: max − min over its RATED members.
 *
 * A max over members rather than a pairwise distance, mirroring how `spread` treats
 * latency — and, like it, monotone under adding a member, which is what lets the greedy
 * fill trust a partial group's number.
 *
 * UNRATED MEMBERS ARE NOT COUNTED, they are not refused. An unplaced player (fewer than
 * PLACEMENT_GAMES on this board) and a player whose rating read has not landed are the
 * same situation — no number to match on — and the answer to that is to let them play,
 * not to hold them out. A DB outage, a dev box, a fresh act and everybody's first five
 * games all therefore degrade to exactly the latency-only pairing that shipped before
 * this, which is the correct floor and by some margin the most likely state of a young
 * ladder.
 */
function ratingSpan(group: QueueEntry[], extra: QueueEntry[]): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const e of group) {
    if (e.rating === undefined || !e.placed) continue;
    if (e.rating < lo) lo = e.rating;
    if (e.rating > hi) hi = e.rating;
  }
  for (const e of extra) {
    if (e.rating === undefined || !e.placed) continue;
    if (e.rating < lo) lo = e.rating;
    if (e.rating > hi) hi = e.rating;
  }
  return hi < lo ? 0 : hi - lo; // nobody rated ⇒ nothing to gate on
}

/** the tightest skill ceiling in a trial — the freshest arrival caps the group, exactly
 * as it does for the radius. An unrated member imposes none. */
function skillCapOf(
  group: QueueEntry[],
  extra: QueueEntry[],
  ceil: (e: QueueEntry) => number,
): number {
  let cap = Infinity;
  for (const e of group) if (e.rating !== undefined && e.placed) cap = Math.min(cap, ceil(e));
  for (const e of extra) if (e.rating !== undefined && e.placed) cap = Math.min(cap, ceil(e));
  return cap;
}

export interface QueueEntry {
  id: string;
  send: (m: ServerMsg) => void;
  player: Omit<LobbyPlayer, 'clientId'>;
  userId?: string;
  mode: QueueMode;
  homeRegion: string;
  accessMs: number;
  /** true ⇒ never widen past my own region */
  noWiden?: boolean;
  /** protocol capabilities this client build advertised (mixed-version safe) */
  caps?: string[];
  /** which game this client queued for (part of the bucket key — see bucketKey).
   * Absent ⇒ 'decode'. */
  game?: GameId;
  /** release channel ('alpha' | 'stable' | …). The matchmaker ONLY pairs entries
   * of the same channel — alpha and stable run different src/sim, so a shared
   * authoritative match would desync. Absent ⇒ 'stable'. */
  channel?: string;
  /** this client build's id (the git sha, `__BUILD_ID__`). The matchmaker ALSO
   * segregates by build so two different builds NEVER share an authoritative match
   * even inside one channel — the exact "same code" invariant (a channel is only a
   * coarse, manually-set proxy). This is what actually keeps alpha and main apart
   * automatically: their shas always differ, no `VITE_APP_CHANNEL` required. Matches
   * the client-side version gate ("everyone on the same version for multiplayer"),
   * enforced authoritatively here. Absent (old client that predates this) ⇒ falls
   * back to channel-only separation. */
  build?: string;
  /**
   * "Play a friend": the verified challenge token this entry queued under. Entries
   * sharing one form a UNIT — the matchmaker adds them to a group all-or-nothing
   * and never splits them across alliances.
   *
   * VERIFIED, not claimed: `server/index.ts` resolves the token against the actual
   * challenge row before it reaches here, so an entry carrying one is known to be
   * a party to it. Two people who never challenged each other cannot hand each
   * other a string and stage themselves a rated match.
   */
  party?: string;
  /**
   * How many entries this party is waiting to be (2 for a friend challenge).
   *
   * Load-bearing, not bookkeeping. The two members enqueue SECONDS apart — one
   * accepts, the other is already waiting — and without a known target size the
   * matchmaker sees the first arrival as a complete unit of one and can hand them
   * to an open group before their partner ever connects. The friend then arrives
   * to a challenge whose other half is already in someone else's match.
   */
  partySize?: number;
  /** this party is the WHOLE match: pair it with itself and nobody else, and skip
   * the search radius (they chose each other; there is nothing to widen toward) */
  partyOnly?: boolean;
  /** set by enqueue (this.now()); drives the widening ceiling */
  enqueuedAt: number;
  /** extra manual widen steps from `expandSearch` */
  expandBumps: number;
  /**
   * This player's rating on the board this queue pairs for, STAMPED BY THE SERVER.
   *
   * `undefined` means "not known yet", and that is a real and ordinary state, not an
   * error: the read is fired off the join path and lands a moment later, so an entry
   * can sit in the queue briefly with no rating. It costs nothing — `tick()` re-attempts
   * pairing every second, so the stamp is picked up on the next pass.
   *
   * NEVER READ FROM THE WIRE. The queue message carries no rating field and must not
   * gain one: a client-declared ladder position is an exploit primitive, the same reason
   * `LobbyPlayer.supporter` and `.role` are server-authored.
   */
  rating?: number;
  /**
   * Whether `rating` is a PLAYED rating rather than the 1000 default.
   *
   * The default is ambiguous — an account with no row on this board reads exactly the
   * same as one that played to 1000 — so this is what a skill gate keys on. False means
   * UNKNOWN SKILL, which must mean "do not gate": an unplaced player has no rating to
   * match on and still has to get a game.
   */
  placed?: boolean;
  /** DEV FALLBACK only: told which local Room this connection landed in */
  onRoom?: (room: Room) => void;
}

/** how a paired group is handed off to its host machine. Production stages it to
 * Postgres; tests inject a recorder. */
export type StageFn = (m: PendingMatch) => Promise<void>;

/**
 * Where a player's rating comes from. Production reads Postgres; tests inject a table.
 *
 * Injectable for the same reason `stage` is: `npm run test:mm` runs with no database
 * and no sockets, and skill-based pairing is otherwise only exercisable against a live
 * Neon instance with real accounts. Returning null is the FAIL-OPEN answer — DB off,
 * signed out, or a read that threw — and must leave the entry unrated rather than
 * defaulting it, so a database that cannot answer never gates anyone out of a match.
 */
export type RatingFn = (
  userId: string,
  mode: QueueMode,
  game: GameId | undefined,
) => Promise<{ rating: number; placed: boolean } | null>;

export interface MatchmakerDeps {
  /** injectable clock (tests control widening); when set, the auto-widen timer is off */
  now?: () => number;
  /** override the staging step (default: Postgres pending_matches when dbEnabled) */
  stage?: StageFn;
  /** override the rating read (default: Postgres elo_ratings when dbEnabled) */
  rating?: RatingFn;
}

let roomSeq = 0;
const rand6 = (): string => Math.floor(Math.random() * 0x7fffffff).toString(36).padStart(6, '0').slice(-6);

export class Matchmaker {
  private readonly queues: Record<QueueMode, QueueEntry[]> = { '1v1': [], '2v2': [] };
  private readonly rooms = new Set<Room>();
  /** entries pulled out of a queue for a pairing whose staging write has not landed yet,
   *  keyed by connection id. See `tryMatch` / `restoreGroup`. */
  private readonly staging = new Map<string, QueueEntry>();
  private readonly now: () => number;
  private readonly stage?: StageFn;
  private readonly rating?: RatingFn;
  private readonly timer: ReturnType<typeof setInterval> | null;

  constructor(deps: MatchmakerDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    // default staging: write to Postgres so the host machine can claim it. Absent
    // (no injected stage AND no DB) ⇒ localStart fallback.
    this.stage = deps.stage ?? (dbEnabled ? (m) => createPendingMatch(m) : undefined);
    // default rating source: the act's elo_ratings row. Absent when the DB is off, which
    // leaves every entry unrated and pairing exactly as latency-only as it is today.
    this.rating =
      deps.rating ??
      (dbEnabled
        ? async (userId, mode, game) => {
            try {
              const act = await actFor(game);
              const s = await getSkill(userId, mode, act, game);
              return { rating: s.rating, placed: s.placed };
            } catch {
              return null; // fail open — see RatingFn
            }
          }
        : undefined);
    // auto-widen: re-attempt matches as ceilings grow. Disabled when a clock is
    // injected (deterministic tests drive matching via enqueue/expand/tick).
    this.timer = deps.now ? null : setInterval(() => this.tick(), 1000);
    if (this.timer?.unref) this.timer.unref(); // never keep the process alive
  }

  enqueue(entry: QueueEntry): void {
    this.remove(entry.id); // never double-queue a connection
    // never let one ACCOUNT hold two queue entries at once (a second tab, or a
    // stale entry a `?mm=1` reconnect left behind under a fresh connection id).
    // Otherwise the matchmaker could pair a user with THEMSELF, staging a roster
    // with two slots for one identity — on the host, `byUser` collapses to one
    // client, so one robot takes the driver's input (a "ghost" they control) and
    // the other is left unmapped + frozen. Drop any prior entry for this user.
    if (entry.userId) this.removeUser(entry.userId, entry.id);
    entry.enqueuedAt = this.now();
    entry.expandBumps = entry.expandBumps ?? 0;
    this.queues[entry.mode].push(entry);
    this.stampRating(entry);
    this.tryMatch(entry.mode);
    this.broadcastStatus(entry.mode);
  }

  /**
   * Resolve this entry's rating and stamp it on, WITHOUT holding up the join.
   *
   * Deliberately not awaited. The queue press already runs three chained async steps
   * before it gets here (verify the token, read standing, verify a party token), and a
   * fourth in series would be felt on the one thing a player is watching. It does not
   * need to be in series: `tick()` re-attempts pairing every second, so an entry whose
   * rating lands 200ms late is simply not skill-gated for one pass and loses nothing.
   *
   * The entry is re-found by id before stamping rather than captured, because a player
   * can leave, or re-queue under a new connection, while the read is in flight — and
   * writing a rating onto an object that is no longer in the queue would at best do
   * nothing and at worst resurrect a stale entry's identity onto a fresh one.
   */
  private stampRating(entry: QueueEntry): void {
    const read = this.rating;
    if (!read || !entry.userId) return;
    const { id, mode, game, userId } = entry;
    void read(userId, mode, game)
      .then((s) => {
        if (!s) return; // unknown skill — leave unrated, which means "do not gate"
        const live = this.queues[mode].find((e) => e.id === id);
        if (!live || live.userId !== userId) return; // left, or re-queued since
        live.rating = s.rating;
        live.placed = s.placed;
        // a rating that lands between ticks should not wait up to a second for the
        // next one — this entry may now have a partner it could not be matched to
        this.tryMatch(mode);
      })
      .catch(() => {
        /* fail open: an unrated entry pairs on latency alone */
      });
  }

  remove(id: string): void {
    // a player who leaves WHILE their group is being staged must not be put back by
    // `restoreGroup` when that staging fails — dropping the held entry here is what
    // tells the restore that this seat is gone for good.
    this.staging.delete(id);
    for (const mode of Object.keys(this.queues) as QueueMode[]) {
      const q = this.queues[mode];
      const i = q.findIndex((e) => e.id === id);
      if (i >= 0) {
        q.splice(i, 1);
        this.broadcastStatus(mode);
      }
    }
  }

  /** drop every queue entry belonging to `userId` EXCEPT connection `keepId`
   * (the fresh entry). Prevents one account from holding two queue slots. */
  private removeUser(userId: string, keepId: string): void {
    for (const mode of Object.keys(this.queues) as QueueMode[]) {
      const q = this.queues[mode];
      const before = q.length;
      this.queues[mode] = q.filter((e) => e.userId !== userId || e.id === keepId);
      if (this.queues[mode].length !== before) this.broadcastStatus(mode);
    }
  }

  /** impatient player: widen their radius one step now, then retry */
  expand(id: string): void {
    for (const mode of Object.keys(this.queues) as QueueMode[]) {
      const e = this.queues[mode].find((x) => x.id === id);
      if (e) {
        e.expandBumps++;
        this.tryMatch(mode);
        return;
      }
    }
  }

  /** periodic re-attempt as wait-driven ceilings grow (auto-widen) */
  tick(): void {
    this.tryMatch('1v1');
    this.tryMatch('2v2');
  }

  private ceilingOf(e: QueueEntry, now: number): number {
    return radiusCeiling(now - e.enqueuedAt, e.expandBumps, e.noWiden);
  }

  /** this entry's current skill tolerance. `noWiden` is deliberately NOT read: it is a
   * statement about geography ("do not send me to another region"), and reading it here
   * would silently pin such a player to a 200-point band for the whole session. */
  private skillCeilingOf(e: QueueEntry, now: number): number {
    return skillCeiling(now - e.enqueuedAt, e.expandBumps);
  }

  private tryMatch(mode: QueueMode): void {
    let m = this.findMatch(mode);
    while (m) {
      const ids = new Set(m.group.map((g) => g.id));
      this.queues[mode] = this.queues[mode].filter((e) => !ids.has(e.id));
      // HELD, not dropped. The entries leave the pool synchronously (nothing may pair them
      // twice) but staging is a database write that can fail, and before this they were
      // simply gone when it did: the players sat on a search screen that would never end,
      // holding no queue entry, with the pairing that was made for them lost. They are kept
      // here until the write lands, and handed back if it does not.
      const group = m.group;
      for (const e of group) this.staging.set(e.id, e);
      void this.startMatch(mode, group, m.hostRegion).then(
        () => {
          for (const e of group) this.staging.delete(e.id);
        },
        (err: unknown) => this.restoreGroup(mode, group, err),
      );
      m = this.findMatch(mode);
    }
  }

  /**
   * Put a group whose staging FAILED back in the queue it was taken from.
   *
   * Anyone who left in the meantime is skipped — `remove` drops their held entry, so a
   * missing one here means the player is gone and re-adding them would mint the same ghost
   * this is meant to prevent. Deliberately does NOT re-run `tryMatch`: the same pairing
   * would be attempted against the same broken write immediately, and the retry belongs on
   * the next `tick`, which is a second away and not a microtask.
   */
  private restoreGroup(mode: QueueMode, group: QueueEntry[], err: unknown): void {
    console.error('[mm] staging failed — returning the group to the queue:', err);
    let back = 0;
    for (const e of group) {
      if (!this.staging.delete(e.id)) continue; // left or disconnected while staging
      if (this.queues[mode].some((x) => x.id === e.id)) continue; // already re-queued since
      this.queues[mode].push(e);
      back++;
    }
    if (back) this.broadcastStatus(mode);
  }

  /**
   * FIFO-anchored greedy pairing over UNITS: for the oldest waiting unit, add the
   * units that keep the group hostable under EVERY member's current radius, until
   * the bucket is full. Returns the group + its fair host region, or null.
   *
   * NEAREST-FIRST, not first-fit. Each round picks the eligible unit that yields
   * the SMALLEST resulting spread, ties going to whoever has waited longer (the
   * comparison is strict, so FIFO order wins them). That inversion is what lets the
   * radius schedule be aggressive: proximity is now enforced directly, by choosing
   * the closest opponent available, instead of indirectly by refusing to look far
   * for the first 40 seconds. Under first-fit the two mechanisms were the same
   * knob, so making matchmaking quick necessarily made it worse; separated, a wide
   * radius only ever means "nothing closer exists", never "we stopped looking".
   *
   * A unit is normally one player. A "play a friend" party is one unit of two, and
   * pairing at unit granularity is what makes that work: a party is added
   * all-or-nothing, so it can never be half-matched into a group with no room left
   * for its other member.
   */
  private findMatch(mode: QueueMode): { group: QueueEntry[]; hostRegion: string } | null {
    const need = QUEUE_NEED[mode];
    const units = this.units(mode);
    const now = this.now();
    for (let i = 0; i < units.length; i++) {
      const anchor = units[i];
      if (anchor.length > need) continue; // malformed party — never stage it
      if (!partyReady(anchor)) continue; // still waiting on its other member
      const group = [...anchor];
      if (anchor.some((e) => e.partyOnly)) {
        // a CLOSED party (rated 1v1): it is the whole match or it waits. No
        // strangers, and no radius gate — two people who challenged each other
        // have already decided they'll play across whatever distance separates
        // them. The compatibility bucket still applies: same channel + build or no
        // match, because a mixed-build match desyncs no matter who asked for it.
        if (group.length !== need) continue;
        if (group.some((e) => bucketKey(e) !== bucketKey(anchor[0]))) continue;
        return { group, hostRegion: bestHost(group.map(toPing)).hostRegion };
      }
      const taken = new Set<number>([i]);
      // THE REGION THE GROUP SO FAR ALL SHARES, when that is a region we deploy to.
      // This is what makes the common case cheap, and it is a property of the GROUP, so
      // it is re-derived as the group grows rather than fixed from the anchor.
      //
      // `bestHost` is an argmin over DEPLOY_REGIONS of the worst estimated ping. If
      // every member of a trial shares a deployed region r, then hosting at r gives
      // `interRegionMs(r, r) = 0` for all of them, so the spread is 0 and no other
      // region can beat it. Spread 0 clears every ceiling the schedule can produce,
      // `noWiden`'s 0 included. So for a homogeneous trial the minimax, the ceiling
      // minimum and both array builds are all provably constant and can be skipped —
      // and that is where the time is: bestHost alone is ~76% of a candidate's cost,
      // the allocations only ~9%.
      //
      // NOTE the candidate SET is untouched; only the cost of pricing one is. Narrowing
      // the scan to a pool was tried and is wrong twice over: a cross-region match could
      // then never be found once the radius widened, and a PARTY whose members all sit
      // in the anchor's region is a zero-spread candidate that lives in a different pool.
      let homeRegion = freeRegion(anchor);
      while (group.length < need) {
        let pick: { j: number; unit: QueueEntry[]; spread: number; span: number } | null = null;
        for (let j = 0; j < units.length; j++) {
          if (taken.has(j)) continue;
          const cand = units[j];
          // a closed party never joins someone else's group
          if (cand.some((e) => e.partyOnly)) continue;
          // and a half-arrived party is not available to be taken
          if (!partyReady(cand)) continue;
          // all-or-nothing: a party that doesn't fit in the remaining slots is skipped
          if (group.length + cand.length > need) continue;
          // never pair across compatibility buckets (channel + build) — different
          // src/sim (alpha vs stable) OR different builds run different code, so a
          // shared authoritative match would desync both clients
          if (bucketKey(cand[0]) !== bucketKey(anchor[0])) continue;
          // never put the same account in a group twice (backstop for the userId
          // dedup above) — a self-pair produces a frozen "ghost" robot
          if (cand.some((c) => c.userId && group.some((g) => g.userId === c.userId))) continue;
          let spread: number;
          if (homeRegion !== null && allIn(cand, homeRegion)) {
            spread = 0; // homogeneous trial in a deployed region — see above
          } else {
            const trial = [...group, ...cand];
            spread = bestHost(trial.map(toPing)).spread;
            const ceiling = Math.min(...trial.map((e) => this.ceilingOf(e, now)));
            if (spread > ceiling) continue;
          }
          // SKILL, second. Latency stays primary: a candidate is priced on distance
          // first and only then asked whether the match would be one-sided, so a
          // same-region opponent is never passed over for a better-rated distant one.
          // Both schedules saturate together at 6s, so neither gate outlives the other.
          const span = ratingSpan(group, cand);
          if (span > skillCapOf(group, cand, (e) => this.skillCeilingOf(e, now))) continue;
          // STRICTLY closer to displace the incumbent, so an equally-close unit never
          // jumps the queue ahead of one that has been waiting longer. THE TIEBREAK IS
          // WRITTEN OUT rather than left to iteration order, because roster order is
          // not cosmetic: `allianceOrder` and assign's positional `i < half` split read
          // it to decide who is red and what startIndex each player gets.
          // and SPAN breaks a spread tie, which is where it does most of its work:
          // inside one region every spread is 0, so today's nearest-first degenerates to
          // pure FIFO and skill fills a total order that was previously arbitrary. A
          // strict refinement — it never reorders a pair that spread alone separated.
          if (
            !pick ||
            spread < pick.spread ||
            (spread === pick.spread && span < pick.span) ||
            (spread === pick.spread && span === pick.span && j < pick.j)
          ) {
            pick = { j, unit: cand, spread, span };
          }
        }
        if (!pick) break;
        taken.add(pick.j);
        group.push(...pick.unit);
        // once a member outside the shared region joins, the shortcut is void for the
        // rest of this fill
        if (homeRegion !== null && !allIn(pick.unit, homeRegion)) homeRegion = null;
      }
      if (group.length === need) {
        const { hostRegion } = bestHost(group.map(toPing));
        return { group, hostRegion };
      }
    }
    return null;
  }

  /**
   * Group a queue into matchable units, preserving FIFO: a party takes the queue
   * position of its FIRST member, so waiting together never jumps the line and
   * never loses your place either.
   */
  private units(mode: QueueMode): QueueEntry[][] {
    return groupUnits(this.queues[mode]);
  }

  /**
   * Current overall ELO for a driver's intro card (best-effort; null on DB-off /
   * signed-out / read failure — the intro just shows "Unranked").
   *
   * PREFERS THE STAMP the entry already carries. This is awaited once per roster entry
   * inside `assign`, between pairing and `matchAssigned`, and it used to resolve the act
   * and read the rating every time — three sequential queries per player, so TWELVE for
   * a 2v2, all of them on the wait between "match found" and the match appearing. The
   * same number is now read once at enqueue, so in the ordinary case this is free.
   *
   * The query stays as the fallback, because the stamp is genuinely absent sometimes:
   * a rating read that failed, or a group paired in the moment before it landed.
   */
  private async introElo(entry: QueueEntry, mode: QueueMode): Promise<number | null> {
    if (entry.rating !== undefined) return entry.rating;
    if (!dbEnabled || !entry.userId) return null;
    try {
      // ELO is keyed by the game's current ACT (persists across seasons in an act).
      return await getRating(entry.userId, mode, await actFor(entry.game), entry.game);
    } catch {
      return null;
    }
  }

  private async startMatch(mode: QueueMode, group: QueueEntry[], hostRegion: string): Promise<void> {
    if (this.stage) await this.assign(mode, group, hostRegion);
    else this.localStart(mode, group); // dev fallback: host here (same-machine only)
  }

  /** stage the roster for the host region + tell each client to reconnect there */
  private async assign(mode: QueueMode, rawGroup: QueueEntry[], hostRegion: string): Promise<void> {
    const group = balanceAlliances(allianceOrder(rawGroup));
    const half = group.length / 2;
    const seed = (this.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
    const code = `${hostRegion}-${mode}${roomSeq++}${rand6()}`;
    const roster: PendingRosterEntry[] = await Promise.all(
      group.map(async (e, i) => ({
        userId: e.userId,
        name: e.player.name,
        teamName: e.player.teamName,
        teamNumber: e.player.teamNumber,
        spec: e.player.spec,
        assists: e.player.assists,
        // distinct START_POSES index per alliance (not trusted from the client)
        startIndex: i < half ? i : i - half,
        alliance: (i < half ? 'red' : 'blue') as PendingRosterEntry['alliance'],
        introElo: await this.introElo(e, mode),
        channel: e.channel,
        // stash the game in the roster jsonb so the host recovers it (no schema col)
        game: e.game,
      })),
    );
    await this.stage!({ code, hostRegion, mode, seed, roster, ranked: true, channel: group[0].channel, game: group[0].game });
    for (const e of group) e.send({ t: 'matchAssigned', mode, room: code, hostRegion });
  }

  /** DEV/no-DB fallback: run the match on THIS machine. Only reachable when
   * DATABASE_URL is unset, where everyone is on one machine anyway. Routes through
   * the SAME staged-roster path (`applyPending`) as production so the pre-match
   * STRATEGY window runs in dev too — dev clients may be anonymous, so synthesize a
   * stable per-connection id for the userId→slot mapping. */
  private localStart(mode: QueueMode, rawGroup: QueueEntry[]): void {
    const group = balanceAlliances(allianceOrder(rawGroup));
    const code = `mm-${mode}-${roomSeq++}`;
    const room = new Room(code, () => this.rooms.delete(room), { kind: 'versus', game: group[0].game }, persistMatch, undefined, undefined, persistDodges, (b) => void persistBehaviour(b));
    this.rooms.add(room);
    const half = group.length / 2;
    const seed = (this.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
    const roster: PendingRosterEntry[] = group.map((e, i) => ({
      userId: e.userId ?? e.id, // dev: a stable id so the host can map roster slots
      name: e.player.name,
      teamName: e.player.teamName,
      teamNumber: e.player.teamNumber,
      spec: e.player.spec,
      assists: e.player.assists,
      startIndex: i < half ? i : i - half,
      alliance: (i < half ? 'red' : 'blue') as PendingRosterEntry['alliance'],
      introElo: null,
    }));
    group.forEach((e, i) => {
      const client: Client = {
        id: e.id,
        send: e.send,
        player: { ...e.player, clientId: e.id, alliance: roster[i].alliance },
        connected: true,
        disconnectAt: 0,
        userId: roster[i].userId,
        caps: e.caps,
        channel: e.channel,
      };
      room.add(client);
      e.onRoom?.(room);
    });
    room.applyPending({ code, hostRegion: '', mode, seed, roster, ranked: true });
  }

  /** live queue depth per bucket ACROSS EVERY GAME. Kept because older clients read
   * this shape; new ones want `queueSizesByGame` (a DECODE player cannot pair with
   * a Chain Reaction queuer, so a combined number misleads them). CLOSED parties are
   * excluded: they can never pair with anyone reading this, so counting them would
   * advertise a pool that isn't there. */
  queueSizes(): Record<QueueMode, number> {
    const open = (m: QueueMode): number => this.queues[m].reduce((n, e) => n + (e.partyOnly ? 0 : 1), 0);
    return { '1v1': open('1v1'), '2v2': open('2v2') };
  }

  /**
   * Queue depth split BY GAME, which is the only version of this number that means
   * anything to a player.
   *
   * Pairing is bucketed by game (see `bucketKey`) — a Chain Reaction queuer and a
   * DECODE queuer can never be matched — so a combined count told a DECODE player
   * "1 waiting in 1V1" about somebody they had no way of playing. That inverts the
   * whole point of showing the number: the chip exists to be an argument FOR
   * queueing, and it was advertising a pool that did not exist for the reader.
   */
  queueSizesByGame(): Record<string, Record<QueueMode, number>> {
    const out: Record<string, Record<QueueMode, number>> = {};
    for (const mode of Object.keys(this.queues) as QueueMode[]) {
      for (const e of this.queues[mode]) {
        if (e.partyOnly) continue; // a closed challenge is not an open pool
        const g = e.game ?? 'decode';
        out[g] ??= { '1v1': 0, '2v2': 0 };
        out[g][mode]++;
      }
    }
    return out;
  }

  /**
   * Who is waiting in the ranked queue right now, for the operator view.
   *
   * The queue is the one place a stall is invisible from the outside — "nobody is
   * matching" and "nobody is queueing" look identical from a depth count — so the
   * bucket and the WAIT are the numbers that make it diagnosable. Anonymous
   * entries cannot exist here (ranked requires an account), so there is no
   * guest data to leak: every row already belongs to a signed-in player.
   */
  queuedPlayers(now = this.now()): { userId: string; mode: QueueMode; waitedS: number; game?: GameId }[] {
    const out: { userId: string; mode: QueueMode; waitedS: number; game?: GameId }[] = [];
    for (const mode of Object.keys(this.queues) as QueueMode[]) {
      for (const e of this.queues[mode]) {
        if (!e.userId) continue;
        out.push({
          userId: e.userId,
          mode,
          waitedS: Math.max(0, Math.round((now - e.enqueuedAt) / 1000)),
          game: e.game,
        });
      }
    }
    return out;
  }

  private broadcastStatus(mode: QueueMode): void {
    // report each waiter the depth of ITS OWN bucket (channel + build) — pairing is
    // bucket-scoped, so a mixed count would falsely read "enough players" and never
    // match (a lone alpha queuer must not be told a pool of stable/older builds is ready)
    //
    // COUNT ONCE, THEN SEND. Every waiter's number is one of a handful of totals, so
    // this is two linear passes and not a scan per recipient. It was the latter —
    // a `reduce` over the whole queue inside the loop, building a `bucketKey` STRING
    // on both sides of the comparison every iteration — and that is O(n²) with an
    // allocation in the inner term. `enqueue` calls this on every join, so it cost
    // what the pairing scan itself cost: measured on a standing 1v1 queue,
    // 1.33ms of a 2.68ms join at depth 100 and 134.80ms of 281.64ms at depth 1000,
    // i.e. about half the join, on the one always-warm machine that also runs rooms
    // and answers /health. The counts below are the same numbers the reduces
    // produced; only the number of times they are computed changed.
    const byBucket = new Map<string, number>();
    const byParty = new Map<string, number>();
    // `x.party` is compared with `===` below, so undefined has to stay its own key
    // rather than collapsing into the string one — a closed party with no token must
    // keep counting exactly the entries that also have none.
    const partyKey = (e: QueueEntry): string => (e.party === undefined ? '\0none' : `t${e.party}`);
    for (const x of this.queues[mode]) {
      const pk = partyKey(x);
      byParty.set(pk, (byParty.get(pk) ?? 0) + 1);
      // the open-pool count excludes closed parties, exactly as the old predicate did
      if (!x.partyOnly) {
        const bk = bucketKey(x);
        byBucket.set(bk, (byBucket.get(bk) ?? 0) + 1);
      }
    }
    for (const e of this.queues[mode]) {
      // a closed party isn't waiting on the pool, it's waiting on one person — so
      // count only its own members. Otherwise a friend challenge would read "6/2"
      // off a busy open queue it can never be matched from.
      const size = e.partyOnly
        ? (byParty.get(partyKey(e)) ?? 0)
        : (byBucket.get(bucketKey(e)) ?? 0);
      e.send({ t: 'queued', mode, size, need: QUEUE_NEED[mode] });
    }
  }
}

const toPing = (e: QueueEntry): PingInfo => ({ homeRegion: e.homeRegion, accessMs: e.accessMs });

/**
 * EVEN THE TWO ALLIANCES UP, once the group is chosen.
 *
 * `ratingSpan` gates how wide a MATCH may be, and cannot say anything about how that
 * width is distributed across the two sides. Both of these have a span of 500:
 *
 *   (1500, 1450) vs (1050, 1000)   — a rout
 *   (1500, 1000) vs (1500, 1000)   — dead even
 *
 * so 2v2 needs a second, separate step. This one does not choose WHO plays — that is
 * settled — only which side of a decided match each player stands on, which is free.
 *
 * It runs AFTER `allianceOrder` and preserves everything that function established: the
 * split is positional (`i < half` is red), so this only ever SWAPS a red index with a
 * blue one, and it refuses to move a player who belongs to a PARTY. Keeping a premade
 * on one alliance is the whole point of `allianceOrder`, and a balance pass that broke
 * it would silently undo the feature it runs after.
 *
 * Only for a full 2v2 of placed players. With anyone unrated there is no number to
 * balance on, and inventing one from the 1000 default would put unplaced players on a
 * side for a reason that is not real.
 */
function balanceAlliances(group: QueueEntry[]): QueueEntry[] {
  const half = group.length / 2;
  if (group.length !== 4) return group; // 1v1 has nothing to distribute
  if (group.some((e) => e.rating === undefined || !e.placed)) return group;
  const rating = (e: QueueEntry): number => e.rating as number;
  const gap = (g: QueueEntry[]): number =>
    Math.abs(rating(g[0]) + rating(g[1]) - (rating(g[2]) + rating(g[3])));
  const movable = (i: number): boolean => group[i].party === undefined;

  let best = group;
  let bestGap = gap(group);
  // the three partitions of four players into two pairs are reachable by swapping one
  // red with one blue, so enumerating those four swaps covers them all
  for (let r = 0; r < half; r++) {
    for (let b = half; b < group.length; b++) {
      if (!movable(r) || !movable(b)) continue;
      const trial = group.slice();
      trial[r] = group[b];
      trial[b] = group[r];
      const g = gap(trial);
      if (g < bestGap) {
        bestGap = g;
        best = trial;
      }
    }
  }
  return best;
}

/** every member of this unit sits in region `r` */
function allIn(unit: QueueEntry[], r: string): boolean {
  for (const e of unit) if (e.homeRegion !== r) return false;
  return true;
}

/**
 * The region this unit is entirely in, IF that region is one we deploy to — else null.
 *
 * Null is the "no shortcut available" answer and covers two distinct cases that both
 * have to take the slow path: a unit straddling regions (a premade with one player in
 * iad and one in syd has no single region, so nothing about its host is settled in
 * advance), and a unit in a region with no machine (there is nothing to host on, so its
 * members really do have to be priced against every candidate host).
 */
function freeRegion(unit: QueueEntry[]): string | null {
  const r = unit[0].homeRegion;
  if (!(DEPLOY_REGIONS as readonly string[]).includes(r)) return null;
  return allIn(unit, r) ? r : null;
}

/**
 * Split a queue into matchable UNITS: each "play a friend" party is one unit,
 * everyone else is a unit of one. A party takes the queue position of its first
 * member, so the whole thing keeps that member's place in line.
 *
 * Exported for the matchmaker test script — this and `allianceOrder` are the two
 * pieces of party logic that a live two-account test would otherwise be the only
 * way to exercise.
 */
/**
 * Is this unit matchable yet? A solo always is; a party only once every member it
 * is waiting for has actually connected.
 *
 * The two members of a challenge enqueue seconds apart, and treating the first
 * arrival as a complete unit lets an open group swallow them — their friend then
 * accepts into a challenge whose other half is already playing someone else.
 */
export function partyReady(unit: QueueEntry[]): boolean {
  const want = unit[0]?.partySize ?? 0;
  return !unit[0]?.party || unit.length >= want;
}

export function groupUnits(q: QueueEntry[]): QueueEntry[][] {
  const byParty = new Map<string, QueueEntry[]>();
  const out: QueueEntry[][] = [];
  for (const e of q) {
    if (!e.party) {
      out.push([e]);
      continue;
    }
    const unit = byParty.get(e.party);
    if (unit) unit.push(e);
    else {
      const fresh = [e];
      byParty.set(e.party, fresh);
      out.push(fresh);
    }
  }
  return out;
}

/**
 * Order a matched group so `assign`'s index split (`i < half` ⇒ red) puts each
 * party on ONE alliance.
 *
 * The split is positional, so all this has to do is make parties contiguous and
 * front-loaded — a stable sort by descending unit size does it: a 2v2 with one
 * party becomes [P, P, S, S], red = the party.
 *
 * The 1v1 case looks like it should be the exception and isn't. A `rated1v1`
 * party of two lands at indices 0 and 1 with half = 1, so it splits ACROSS the
 * alliances — which is exactly right, because in that format the party is the two
 * opponents, not two teammates. Same rule, both meanings.
 */
export function allianceOrder(group: QueueEntry[]): QueueEntry[] {
  const units = groupUnits(group);
  if (units.length === group.length) return group; // no parties — leave FIFO alone
  return units.sort((a, b) => b.length - a.length).flat();
}

/** matchmaking compatibility bucket: two entries may only be paired when this key
 * matches — same release channel AND same client build. Absent build ⇒ '' (old
 * clients fall back to channel-only separation). */
// GAME is part of the bucket: a Chain-Reaction queuer and a DECODE queuer run
// DIFFERENT `step()`s, so they must NEVER share one authoritative room (instant
// desync). Old clients advertise no game ⇒ 'decode', so they only ever bucket with
// other DECODE players.
const bucketKey = (e: QueueEntry): string => `${e.game ?? 'decode'}|${e.channel ?? 'stable'}|${e.build ?? ''}`;
