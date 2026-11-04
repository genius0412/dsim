import type { CommunityEvent, CommunityFeed, EloDelta, RecordRankInfo } from './net/protocol';
import type { RewardGrant } from './rewards';
import { RANKED_PLACEMENT } from './config';
import { seasonFor } from './seasons';
import { DRIVETRAIN_LABELS } from './ui/labelData';
import { TOASTS_SEEN_KEY } from './storageKeys';
import type { DrivetrainType } from './types';
import type { GameId } from './games/types';

/**
 * THE EVENT TOASTS — one compact notice in a fixed corner, on every page, for the things worth
 * interrupting nobody for: your new best or record, your rating after a ranked match, a badge
 * unlocked, and the community's news (a new world record, a new No.1 in ranked, a new supporter).
 *
 * DOM-free and clock-free (every time is an argument), so `npm test` drives all of it; the React
 * half is `src/ui/EventToasts.tsx`, mounted beside `<App/>` in `main.tsx` like the banner strip.
 *
 * ── TWO SCOPES, TWO CARRIERS, NO NEW CHANNEL ──────────────────────────────────────────────
 *  - PERSONAL toasts are built from the message that already carries the result to this client:
 *    `recordResult` and `eloResult` (`ServerSession`), and the rewards read (`rewardsStore`) for a
 *    badge. Zero new bytes. Always on.
 *  - COMMUNITY toasts come from the site status poll every page already makes, with a cursor
 *    (`?ev=`, `statusCursor`), answered from `community_events` (`server/communityEvents.ts`).
 *    "Show community announcements" in Configure ▸ Audio and Visual turns them off.
 * Records-based BADGES never toast (owner): a season's record award is the same news as the
 * world-record toast that already went out.
 *
 * ── NEVER IN A DRIVER'S FACE ──────────────────────────────────────────────────────────────
 * The host HOLDS the queue while a match or its results are on screen, while a replay plays, and
 * while any dialog is open (a joined room, ranked and the record popups are dialogs). A toast on
 * screen when a hold starts goes back to the front of the queue. Everything waits and shows after.
 *
 * ── ONE AT A TIME, AND BURSTS COLLAPSE ────────────────────────────────────────────────────
 * Personal toasts first, one after another. Community toasts at most one per `COMMUNITY_GAP_MS`,
 * and whatever arrived in the meantime goes out as ONE ("3 new world records").
 */

export type ToastScope = 'personal' | 'community';
export type ToastKind = 'pb' | 'wr' | 'rating' | 'placed' | 'badge' | 'record' | 'ranked1' | 'supporter' | 'burst';

/** where a click on the toast goes (`setToastNavigator`, registered by `App`) */
/** where a toast opens. A leaderboard target names its BOARD where it knows it (a duo record opens the Duo
 *  board, a 2v2 rating the 2v2 ladder); without one, Records opens on the board last shown in that game. */
export type ToastTarget = { to: 'leaderboard'; game: string; board?: 'solo' | 'duo' | '1v1' | '2v2' } | { to: 'donate' } | { to: 'rewards' };

export interface Toast {
  /** unique per event; a repeat of a key is dropped */
  key: string;
  scope: ToastScope;
  kind: ToastKind;
  title: string;
  detail?: string;
  target?: ToastTarget;
}

/** how long a toast stays up (paused while hovered or focused) */
export const SHOW_MS = 5000;
/** the most a community toast can show: one per this, a burst in between collapses into it */
export const COMMUNITY_GAP_MS = 30_000;
/** how many personal toasts wait at most (the oldest go) */
export const PERSONAL_CAP = 5;
/** how many community events wait at most before a collapse (they are counted, not shown, past it) */
export const COMMUNITY_CAP = 50;

// ------------------------------------------------------------------------------- copy ----

const gameName = (game: string | null | undefined): string => seasonFor((game ?? 'decode') as GameId).name;
const drivetrainName = (d: string): string =>
  d === 'overall' ? 'mixed drivetrains' : (DRIVETRAIN_LABELS[d as DrivetrainType] ?? d);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** a finished record run's result (`recordResult`): a world record, a personal best, or nothing */
export function recordToast(info: RecordRankInfo, game: string): Toast | null {
  const what = `${info.score} in ${gameName(game)} ${info.mode === 'duo' ? 'duo' : 'solo'}`;
  const key = `rec:${game}:${info.mode}:${info.drivetrain}:${info.score}`;
  const target: ToastTarget = { to: 'leaderboard', game, board: info.mode === 'duo' ? 'duo' : 'solo' };
  if (info.isWR) {
    return { key, scope: 'personal', kind: 'wr', title: 'World record', detail: `${what} · ${drivetrainName(info.drivetrain)}`, target };
  }
  if (info.isPB) {
    return { key, scope: 'personal', kind: 'pb', title: 'New personal best', detail: `${what} · #${info.rank} of ${info.total}`, target };
  }
  return null;
}

/**
 * THIS driver's rating after a ranked match (`eloResult`, re-keyed to robot ids by the room).
 * Placement games say nothing until the last one, which says where you placed; after that every
 * match says what moved. A voided match (a partner who never showed) moved nothing and is silent.
 */
export function ratingToast(results: readonly EloDelta[], robotId: number, game: string, seats: number): Toast | null {
  const d = results.find((r) => r.robotId === robotId);
  if (!d) return null;
  const mode = seats > 2 ? '2v2' : '1v1';
  const where = `${gameName(game)} ${mode}`;
  const after = Math.round(d.after);
  const delta = after - Math.round(d.before);
  const need = RANKED_PLACEMENT[mode];
  const key = `elo:${game}:${mode}:${d.games}:${after}`;
  const target: ToastTarget = { to: 'leaderboard', game, board: mode };
  if (d.games < need) return null;
  if (d.games === need) return { key, scope: 'personal', kind: 'placed', title: 'Placement done', detail: `Rated ${after} in ${where}`, target };
  if (delta === 0) return null;
  const sign = delta > 0 ? `+${delta}` : `−${-delta}`;
  return { key, scope: 'personal', kind: 'rating', title: `Rating ${sign}`, detail: `Now ${after} in ${where}`, target };
}

/** a badge unlocked: the GitHub star, the only one that toasts (owner, 2026-11-04) */
export function badgeToast(grant: Pick<RewardGrant, 'id' | 'source'>): Toast | null {
  if (grant.source !== 'stargazer') return null;
  return {
    key: `grant:${grant.id}`,
    scope: 'personal',
    kind: 'badge',
    title: 'Stargazer badge unlocked',
    detail: 'For starring DSIM on GitHub',
    target: { to: 'rewards' },
  };
}

const nameOf = (e: CommunityEvent): string => (e.partner ? `${e.name ?? 'Someone'} and ${e.partner}` : (e.name ?? 'Someone'));

/** one community event as a toast; null for a kind or shape this build does not draw */
export function communityToast(e: CommunityEvent): Toast | null {
  const key = `ev:${e.id}`;
  if (e.kind === 'record' && typeof e.score === 'number') {
    return {
      key, scope: 'community', kind: 'record', title: 'New world record',
      detail: `${nameOf(e)} · ${e.score} in ${gameName(e.game)} ${e.mode === 'duo' ? 'duo' : 'solo'}`,
      target: { to: 'leaderboard', game: e.game ?? 'decode', board: e.mode === 'duo' ? 'duo' : 'solo' },
    };
  }
  if (e.kind === 'ranked1' && typeof e.score === 'number') {
    return {
      key, scope: 'community', kind: 'ranked1', title: 'New #1 in ranked',
      detail: `${nameOf(e)} · ${e.score} in ${gameName(e.game)} ${e.mode === '2v2' ? '2v2' : '1v1'}`,
      target: { to: 'leaderboard', game: e.game ?? 'decode', board: e.mode === '2v2' ? '2v2' : '1v1' },
    };
  }
  if (e.kind === 'supporter') {
    return {
      key, scope: 'community', kind: 'supporter',
      title: e.name ? `${e.name} joined DSIM’s supporters` : 'A new supporter joined DSIM',
      target: { to: 'donate' },
    };
  }
  return null;
}

const KIND_WORDS: Record<'record' | 'ranked1' | 'supporter', [string, string]> = {
  record: ['new world record', 'new world records'],
  ranked1: ['new #1 in ranked', 'new #1s in ranked'],
  supporter: ['new supporter', 'new supporters'],
};

/**
 * A BURST AS ONE TOAST. One event is itself; several of one kind are "3 new world records" with
 * the newest names; a mix is "New on DSIM" with the count of each. Oldest first in, so the names
 * read newest first.
 */
export function collapseCommunity(events: readonly CommunityEvent[]): Toast | null {
  const drawn = events.filter((e) => communityToast(e) !== null);
  if (drawn.length === 0) return null;
  if (drawn.length === 1) return communityToast(drawn[0]);
  const last = drawn[drawn.length - 1];
  const key = `burst:${drawn[0].id}-${last.id}`;
  const kinds = [...new Set(drawn.map((e) => e.kind))] as (keyof typeof KIND_WORDS)[];
  const games = new Set(drawn.map((e) => e.game ?? 'decode'));
  const target: ToastTarget | undefined =
    kinds.length === 1 && kinds[0] === 'supporter'
      ? { to: 'donate' }
      : !kinds.includes('supporter') && games.size === 1
        ? { to: 'leaderboard', game: [...games][0] }
        : undefined;
  if (kinds.length === 1) {
    const [one, many] = KIND_WORDS[kinds[0]];
    const named = [...new Set([...drawn].reverse().map((e) => e.name).filter((n): n is string => !!n))];
    const shown = named.slice(0, 2).join(', ');
    const rest = drawn.length - Math.min(2, named.length);
    const detail = named.length === 0 ? undefined : rest > 0 ? `${shown} and ${rest} more` : shown;
    return { key, scope: 'community', kind: 'burst', title: plural(drawn.length, one, many), detail, target };
  }
  const parts = kinds.map((k) => plural(drawn.filter((e) => e.kind === k).length, KIND_WORDS[k][0], KIND_WORDS[k][1]));
  return { key, scope: 'community', kind: 'burst', title: 'New on DSIM', detail: parts.join(' · '), target };
}

// ------------------------------------------------------------------------------ queue ----

/**
 * WHAT IS WAITING, and what shows next. Personal toasts in arrival order; community events raw,
 * so a burst can be collapsed at the moment it is shown rather than when it arrived.
 */
export class ToastQueue {
  private personal: Toast[] = [];
  private community: CommunityEvent[] = [];
  private keys = new Set<string>();
  private lastCommunityAt = -Infinity;

  /** queue a personal toast; a repeat of a key already seen is dropped */
  pushPersonal(t: Toast): boolean {
    if (this.keys.has(t.key)) return false;
    this.remember(t.key);
    this.personal.push(t);
    if (this.personal.length > PERSONAL_CAP) this.personal.splice(0, this.personal.length - PERSONAL_CAP);
    return true;
  }

  /** queue a community event; a repeat id is dropped */
  pushCommunity(e: CommunityEvent): boolean {
    const key = `ev:${e.id}`;
    if (this.keys.has(key)) return false;
    this.remember(key);
    this.community.push(e);
    if (this.community.length > COMMUNITY_CAP) this.community.splice(0, this.community.length - COMMUNITY_CAP);
    return true;
  }

  /** a toast that was on screen when a hold began: it shows first once the hold ends */
  putBack(t: Toast): void {
    this.personal.unshift(t);
  }

  /** the community switch went off: nothing waiting from it is shown */
  dropCommunity(): void {
    this.community = [];
  }

  get waiting(): number {
    return this.personal.length + this.community.length;
  }

  /** the next toast at `now`, taken off the queue; null when nothing may show yet */
  take(now: number): Toast | null {
    const p = this.personal.shift();
    if (p) return p;
    if (this.community.length === 0 || now - this.lastCommunityAt < COMMUNITY_GAP_MS) return null;
    const burst = this.community;
    this.community = [];
    const t = collapseCommunity(burst);
    if (t) this.lastCommunityAt = now;
    return t;
  }

  /** ms until `take` could answer, or null when nothing is waiting */
  waitMs(now: number): number | null {
    if (this.personal.length) return 0;
    if (!this.community.length) return null;
    return Math.max(0, COMMUNITY_GAP_MS - (now - this.lastCommunityAt));
  }

  private remember(key: string): void {
    this.keys.add(key);
    if (this.keys.size > 500) this.keys = new Set([...this.keys].slice(-250));
  }
}

/**
 * THE TOAST ON SCREEN: the queue plus a clock for the one being shown. The host calls `step` when
 * something changed or `nextWakeMs` ran out, and draws `current`.
 */
export class ToastRunner {
  readonly queue = new ToastQueue();
  current: Toast | null = null;
  private endsAt = 0;
  /** ms left on the current toast while it is paused (hovered or focused); null when running */
  private pausedLeft: number | null = null;
  private held = false;

  /**
   * HOLD (a match, its results, a replay, a dialog). A toast on screen goes back to the front of
   * the queue and shows, in full, once the hold ends. Returns whether `current` changed.
   */
  setHeld(held: boolean, now: number): boolean {
    this.held = held;
    if (held && this.current) {
      this.queue.putBack(this.current);
      this.current = null;
      this.pausedLeft = null;
      return true;
    }
    return this.step(now);
  }

  get isHeld(): boolean {
    return this.held;
  }

  pause(now: number): void {
    if (this.current && this.pausedLeft === null) this.pausedLeft = Math.max(0, this.endsAt - now);
  }

  resume(now: number): void {
    if (this.pausedLeft === null) return;
    this.endsAt = now + this.pausedLeft;
    this.pausedLeft = null;
  }

  /** closed by hand (or a click that opened its page) */
  dismiss(now: number): void {
    this.current = null;
    this.pausedLeft = null;
    this.step(now);
  }

  /** retire an expired toast, show the next one. Returns whether `current` changed. */
  step(now: number): boolean {
    let changed = false;
    if (this.current && this.pausedLeft === null && now >= this.endsAt) {
      this.current = null;
      changed = true;
    }
    if (!this.current && !this.held) {
      const next = this.queue.take(now);
      if (next) {
        this.current = next;
        this.endsAt = now + SHOW_MS;
        this.pausedLeft = null;
        changed = true;
      }
    }
    return changed;
  }

  /** ms until `step` could change something, or null (nothing on screen or waiting, or held) */
  nextWakeMs(now: number): number | null {
    if (this.current) return this.pausedLeft === null ? Math.max(0, this.endsAt - now) : null;
    if (this.held) return null;
    return this.queue.waitMs(now);
  }
}

// ------------------------------------------------------------------- the live store ----

export interface ToastPrefs {
  /** the signed-in account: a community event about it is skipped (it got the personal toast) */
  me: string | null;
  /** "Show community announcements" */
  community: boolean;
  /** a game this build may name (a season hidden on this channel never toasts) */
  visible: (game: string) => boolean;
}

/**
 * The cursor protocol, separate from the queue so smoke can hold it: `null` until the first answer,
 * which carries only the head (nothing from before the page opened is replayed); after that every
 * answer's newer items are delivered once, by id.
 *
 * ⚠️ THE CURSOR NEVER MOVES BACKWARDS. It keeps the larger of itself and any head it is told. A
 * lagging machine, or a cold one whose first read failed, could otherwise drop it, and the next
 * healthy machine would hand the page events from before it opened as news. (A database-less dev
 * server that restarts hands out ids from 1 again; reload the page there.)
 */
export class CommunityCursor {
  cursor: number | null = null;
  private seen = new Set<number>();

  /** the `ev` query value for the next status read */
  param(): string {
    return this.cursor === null ? '' : String(this.cursor);
  }

  /** an answer's `ev`: the events to deliver, oldest first */
  accept(feed: CommunityFeed | undefined): CommunityEvent[] {
    if (!feed || typeof feed.h !== 'number' || !Number.isFinite(feed.h)) return [];
    const prev = this.cursor;
    this.cursor = prev === null ? feed.h : Math.max(prev, feed.h);
    if (prev === null || !Array.isArray(feed.items)) return [];
    const out: CommunityEvent[] = [];
    for (const e of feed.items) {
      if (!e || typeof e.id !== 'number' || e.id <= prev || this.seen.has(e.id)) continue;
      this.seen.add(e.id);
      out.push(e);
    }
    if (this.seen.size > 400) this.seen = new Set([...this.seen].slice(-200));
    return out;
  }
}

/** should this community event be queued at all, for this viewer? */
export function communityWanted(e: CommunityEvent, prefs: ToastPrefs): boolean {
  if (!prefs.community) return false;
  if (e.game && !prefs.visible(e.game)) return false;
  // your own record or No.1 already toasted as yours
  if (prefs.me && (e.kind === 'record' || e.kind === 'ranked1') && (e.uid === prefs.me || e.pid === prefs.me)) return false;
  return communityToast(e) !== null;
}

const runner = new ToastRunner();
const cursor = new CommunityCursor();
let prefs: ToastPrefs = { me: null, community: true, visible: () => true };
const subs = new Set<() => void>();
const notify = (): void => subs.forEach((f) => f());

export const toastRunner = (): ToastRunner => runner;
export function subscribeToasts(f: () => void): () => void {
  subs.add(f);
  return () => subs.delete(f);
}

export function setToastPrefs(p: Partial<ToastPrefs>): void {
  const wasOn = prefs.community;
  prefs = { ...prefs, ...p };
  if (wasOn && !prefs.community) runner.queue.dropCommunity();
}

/** the `ev` value `siteStatus` sends with every status read */
export const statusCursor = (): string => cursor.param();

/** a status answer's `ev` (absent from an older server, or when nothing is new) */
export function noteCommunityFeed(feed: CommunityFeed | undefined): void {
  let any = false;
  for (const e of cursor.accept(feed)) if (communityWanted(e, prefs) && runner.queue.pushCommunity(e)) any = true;
  if (any) notify();
}

/** a personal toast (from a result message or the rewards read) */
export function notePersonal(t: Toast | null): void {
  if (t && runner.queue.pushPersonal(t)) notify();
}

// ------------------------------------------------------------- the badge, seen once ----

function readSeen(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(TOASTS_SEEN_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * THE REWARDS READ (`rewardsStore.loadRewards`): a stargazer grant this device has not toasted
 * yet. Remembered per device, so a reload or the next visit does not say it again; storage that
 * throws says it once per page instead.
 */
export function noteRewardGrants(pending: readonly Pick<RewardGrant, 'id' | 'source'>[]): void {
  const fresh = pending.map((g) => ({ g, t: badgeToast(g) })).filter((x) => x.t !== null);
  if (!fresh.length) return;
  const seen = readSeen();
  const add: string[] = [];
  for (const { g, t } of fresh) {
    if (seen.includes(g.id)) continue;
    add.push(g.id);
    notePersonal(t);
  }
  if (!add.length) return;
  try {
    localStorage.setItem(TOASTS_SEEN_KEY, JSON.stringify([...seen, ...add].slice(-50)));
  } catch {
    /* storage off: the queue's own key set still stops a repeat on this page */
  }
}

// -------------------------------------------------------------------- the click ----

let goTo: ((t: ToastTarget) => void) | null = null;
/** `App` registers how a click reaches a page; the closed screen registers nothing */
export function setToastNavigator(f: ((t: ToastTarget) => void) | null): void {
  goTo = f;
}
export function openToastTarget(t: ToastTarget): boolean {
  if (!goTo) return false;
  goTo(t);
  return true;
}
