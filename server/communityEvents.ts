import { dbEnabled } from './db/pool';
import { insertCommunityEvent, listCommunityEvents, type CommunityEventRow } from './db/repo';
import { COMMUNITY_KINDS, type CommunityEvent, type CommunityFeed, type CommunityKind } from '../src/net/protocol';

/**
 * COMMUNITY EVENTS — what every online client is told about (migration 0065, `community_events`):
 * a new world record, a new No.1 in ranked, a new supporter. Personal events (your best, your rating,
 * your badge) are NOT here: they ride the message that already carries the result to the one
 * client it concerns (`recordResult`, `eloResult`, the rewards read), see `src/eventToasts.ts`.
 *
 * ── HOW AN EVENT REACHES EVERYONE ─────────────────────────────────────────────────────────
 * The machine that saw it writes a row (`announce`). Every machine keeps the newest rows in a
 * small cache, re-read at most once per `TTL_MS` and ONLY when a status poll asks
 * (`refreshCommunityEvents`), the way `siteState.ts` caches the banners beside it. Clients already
 * poll `GET /api/status` (boot, then every 20 s while somebody is at the keyboard) and now add
 * `?ev=<cursor>`; the answer carries what came after the cursor (`feedSince`). A row is read
 * only once it is `COMMUNITY_SETTLE_MS` old, so ids that commit out of order are never skipped. So an event crosses
 * Fly machines, satellites and room worker threads through the database alone, nothing new is
 * held open, and nothing runs per tick. Rooms on workers never see this: persistence, and so
 * every emission, is on the socket thread.
 *
 * ── LOAD ──────────────────────────────────────────────────────────────────────────────────
 * Reads: one primary-key range scan per machine per `TTL_MS`, and only while status polls with a
 * cursor arrive, which is exactly when that machine's banner read runs too — the database is no
 * more awake than it was. Writes: one insert (+ prune) per event, a few an hour. Bytes: a poll
 * whose cursor is at the head gets NO `ev` key at all; an event costs each online client ~150
 * bytes once. The numbers at 2,000 online are in `docs/area/accounts.md`.
 *
 * ── NEVER THROWS ──────────────────────────────────────────────────────────────────────────
 * `announce` is called from the tail of persistence and from the Ko-fi webhook, after the thing
 * it announces is committed. A failure is logged and swallowed: an announcement is decoration on
 * a result, never part of it.
 */

/** how stale a machine's copy may be: the banners' TTL, so both reads ride the same wake */
export const TTL_MS = 10_000;
/** how many events a machine keeps in memory (a burst past it collapses on the client anyway) */
export const RING = 20;
/** older than this is not news: a client back from an hour away is not handed the hour */
export const MAX_AGE_MS = 15 * 60_000;

let ring: CommunityEvent[] = [];
let head = 0;
/**
 * A READ HAS SUCCEEDED ON THIS MACHINE, so `head` is a real answer. Until then (a cold machine whose
 * first read failed on a Neon wake) the machine answers no `ev` at all: a head of 0 there would read
 * to a client as "the feed starts at 0", and the next healthy machine would hand it fifteen minutes
 * of history as news.
 */
let known = false;
let readAt = 0;
let inFlight: Promise<void> | null = null;

/** a stored row as a client sees it; null for a kind this build does not know */
export function eventOf(r: CommunityEventRow): CommunityEvent | null {
  if (!(COMMUNITY_KINDS as readonly string[]).includes(r.kind)) return null;
  const d = r.data ?? {};
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  const e: CommunityEvent = { id: r.id, kind: r.kind as CommunityKind, game: r.game, at: r.at };
  const name = str(d.name);
  const partner = str(d.partner);
  if (name) e.name = name;
  if (partner) e.partner = partner;
  if (r.userId) e.uid = r.userId;
  if (r.partnerId) e.pid = r.partnerId;
  if (typeof d.mode === 'string') e.mode = d.mode;
  if (typeof d.score === 'number' && Number.isFinite(d.score)) e.score = d.score;
  return e;
}

/** fold newly read rows into a ring: deduped by id, oldest first, capped */
export function mergeRing(prev: readonly CommunityEvent[], rows: readonly CommunityEvent[], cap = RING): CommunityEvent[] {
  const byId = new Map<number, CommunityEvent>();
  for (const e of prev) byId.set(e.id, e);
  for (const e of rows) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => a.id - b.id).slice(-cap);
}

/**
 * WHAT A STATUS POLL IS TOLD, given its cursor (the raw `ev` parameter). Pure, so smoke holds it.
 *  - `null` (no parameter): an older client. Nothing — the parameter IS the capability.
 *  - `h` null (this machine has never read the table): nothing, whatever the cursor.
 *  - `''` (no cursor yet, a first read): the head alone, so nothing that happened before the page
 *    opened is replayed.
 *  - the head itself, or AHEAD of it (this machine's copy lags another's): nothing. A head is never
 *    reported below a cursor; the client keeps the larger of the two anyway (`CommunityCursor`).
 *  - behind the head: the head and the events after the cursor that are younger than `MAX_AGE_MS`.
 */
export function feedSince(
  since: string | null,
  events: readonly CommunityEvent[],
  h: number | null,
  now = Date.now(),
): CommunityFeed | undefined {
  if (since === null || h === null) return undefined;
  const cur = since === '' ? NaN : Number(since);
  if (!Number.isFinite(cur) || cur < 0) return { h };
  if (cur >= h) return undefined;
  const items = events.filter((e) => e.id > cur && now - e.at <= MAX_AGE_MS);
  return items.length ? { h, items } : { h };
}

/** re-read this machine's copy when it is older than `TTL_MS`; one read in flight at a time */
export async function refreshCommunityEvents(force = false): Promise<void> {
  if (!dbEnabled) return;
  if (!force && Date.now() - readAt < TTL_MS) return;
  if (!force && inFlight) return inFlight;
  const run = (async (): Promise<void> => {
    try {
      const rows = await listCommunityEvents(head, RING);
      const events = rows.map(eventOf).filter((e): e is CommunityEvent => !!e);
      ring = mergeRing(ring, events);
      for (const r of rows) head = Math.max(head, r.id);
      known = true;
    } catch (e) {
      // keep the last copy; the next poll after the TTL tries again
      console.error('[community] read failed, keeping last copy:', e);
    }
    readAt = Date.now();
  })();
  if (!force) {
    inFlight = run;
    void run.finally(() => {
      if (inFlight === run) inFlight = null;
    });
  }
  return run;
}

/** this machine's answer for one poll (call after `refreshCommunityEvents`) */
export const communityFeed = (since: string | null, now = Date.now()): CommunityFeed | undefined =>
  feedSince(since, ring, known || !dbEnabled ? head : null, now);

/** WITHOUT A DATABASE (local dev, a LAN box) the ring is the store, as banners are */
let memId = 0;

export interface CommunityNews {
  kind: CommunityKind;
  game: string | null;
  userId?: string | null;
  partnerId?: string | null;
  name?: string | null;
  partner?: string | null;
  mode?: string;
  score?: number;
}

/** write one announcement. NEVER throws (see the header). */
export async function announce(a: CommunityNews, now = Date.now()): Promise<void> {
  const data: Record<string, unknown> = {};
  if (a.name) data.name = a.name;
  if (a.partner) data.partner = a.partner;
  if (a.mode) data.mode = a.mode;
  if (typeof a.score === 'number') data.score = a.score;
  try {
    if (!dbEnabled) {
      const row: CommunityEventRow = {
        id: ++memId, kind: a.kind, game: a.game, userId: a.userId ?? null, partnerId: a.partnerId ?? null, data, at: now,
      };
      const e = eventOf(row);
      if (e) ring = mergeRing(ring, [e]);
      head = Math.max(head, row.id);
      console.log(`[community] ${a.kind} ${a.game ?? ''} ${a.name ?? '(anonymous)'} (memory)`);
      return;
    }
    const id = await insertCommunityEvent({
      kind: a.kind, game: a.game, userId: a.userId ?? null, partnerId: a.partnerId ?? null, data,
    });
    // NOT read back at once: a cursor read takes only SETTLED rows (`COMMUNITY_SETTLE_MS`), so this
    // machine's pollers get it with everyone else's, within the TTL
    console.log(`[community] #${id} ${a.kind} ${a.game ?? ''} ${a.name ?? '(anonymous)'}`);
  } catch (e) {
    console.error('[community] write failed (the result it describes is unaffected):', e);
  }
}

/* ── WHO IS ANNOUNCED — the pure rules, held by smoke ───────────────────────────────────── */

/** one placed row of a ranked board, as the board orders it */
export interface LadderEntry {
  userId: string;
  rating: number;
  games: number;
}

/** the live board's order (`eloLeaderboard`): rating, then games, then user id */
export const ladderAhead = (a: LadderEntry, b: LadderEntry): boolean =>
  a.rating !== b.rating ? a.rating > b.rating : a.games !== b.games ? a.games > b.games : a.userId < b.userId;

/**
 * DID A RANKED MATCH CHANGE WHO IS No.1, and who is it now?
 *
 * Asked once per rated match with ONE read: the board's top `players + 1` rows after the match
 * (`after`, placed rows only, board order). Only the match's players moved, so the board BEFORE
 * is the non-players in `after` (unchanged, and the best of them is in there because the read
 * took one more row than there are players) plus each player's rating and games from before the
 * match (`before`; absent = no row yet). A player counts before only if they were placed then.
 *
 * Returns the new No.1's id, or null when nothing changed. A No.1 who did not play can be the
 * answer: the old No.1 lost and dropped under them. A board with fewer than two placed players
 * has no No.1 worth announcing (the first player to place on a new act would be it by default).
 */
export function newRankedTop(
  after: readonly LadderEntry[],
  before: ReadonlyMap<string, { rating: number; games: number } | null>,
  minGames: number,
): string | null {
  const top = after[0];
  if (!top || after.length < 2) return null;
  const was: LadderEntry[] = after.filter((e) => !before.has(e.userId));
  for (const [userId, b] of before) if (b && b.games >= minGames) was.push({ userId, rating: b.rating, games: b.games });
  let prev: LadderEntry | null = null;
  for (const e of was) if (!prev || ladderAhead(e, prev)) prev = e;
  return prev?.userId === top.userId ? null : top.userId;
}

/** the Ko-fi webhook fields that decide a supporter announcement */
export interface SupporterPayment {
  /** false when Ko-fi retried an event already stored */
  fresh: boolean;
  /** the months the payment bought (`monthsFor`): a tip below the tier is not a membership */
  months: number;
  isSubscription: boolean;
  /** Ko-fi's `is_first_subscription_payment`; absent on a one-off */
  isFirstSubscriptionPayment?: boolean;
  /** Ko-fi's `is_public`: the payer let Ko-fi show the payment */
  isPublic?: boolean;
  /** the account the payment was matched to (`profiles.kofi_email`), if any */
  linkedUserId: string | null;
  /** that account's @username, if it has one */
  linkedUsername: string | null;
  /** an earlier payment or membership grant for this email or account (`hadEarlierSupport`) */
  earlierSupport?: boolean;
}

/**
 * IS THIS PAYMENT A NEW SUPPORTER, and may they be named? (owner's privacy rule, 2026-11-04)
 *
 * A NEW supporter is a person's FIRST payment that bought at least one month: not a subscription's
 * later month, and not anyone with an earlier payment or membership grant (`earlierSupport`), so a
 * second tip or a resubscription after a lapse is not "joined DSIM's supporters" twice. A $1 tip
 * below the tier is thanks, not a membership, and is not announced.
 *
 * NAMED only when Ko-fi marks the payment public AND it is linked to a DSIM account with a
 * @username — and then by that @username, never by anything Ko-fi sent (a Ko-fi display name is
 * whatever the payer typed, and an email is never shown). Otherwise the announcement is anonymous.
 * A FIRST payment is never linked yet (the payer links it by claiming it, minutes later), so it is
 * announced anonymously at the webhook and the claim announces nothing: one payment, one toast.
 */
export function supporterAnnouncement(p: SupporterPayment): CommunityNews | null {
  if (!p.fresh || p.months <= 0) return null;
  if (p.isSubscription && p.isFirstSubscriptionPayment === false) return null;
  if (p.earlierSupport) return null;
  const named = !!(p.isPublic && p.linkedUserId && p.linkedUsername);
  return {
    kind: 'supporter',
    game: null,
    userId: named ? p.linkedUserId : null,
    name: named ? p.linkedUsername : null,
  };
}

/** test seam: forget this machine's copy */
export function resetCommunityEventsForTests(): void {
  ring = [];
  head = 0;
  known = false;
  readAt = 0;
  inFlight = null;
  memId = 0;
}
