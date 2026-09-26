import { useSyncExternalStore } from 'react';
import {
  claimReward,
  ENTITLEMENTS_CHANGED,
  fetchRewards,
  FriendsUnavailableError,
  saveBadges,
  type RewardStateDto,
} from '../net/api';
import { withBadgeEquipped } from '../badges';
import { compareGrants, grantCards, grantCosmetics, type RewardGrant, type RewardItem } from '../rewards';

/**
 * THE ACCOUNT'S REWARD STATE, ONE COPY FOR THE WHOLE SHELL — pending grants, badge counts,
 * what is worn, and the trophy case (`GET /api/user/rewards`).
 *
 * A module store rather than per-component fetches because the things that read it must agree
 * the instant one of them changes it: the claim dialog (`RewardDialog`) and the badge picker
 * (`Appearance`). A badge claimed in the dialog has to be in the picker behind it without a
 * reload, and a picker that fetched its own copy would be a second opinion about what the
 * account holds.
 *
 * `useSyncExternalStore` needs a NEW snapshot object on every change (the queue bar learned
 * that the hard way — `docs/area/accounts.md`), so `set` always replaces it.
 */
export interface RewardsSnapshot {
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** null until the first load lands */
  state: RewardStateDto | null;
  /** the dialog was put off for this visit to the menus (Esc) */
  postponed: boolean;
  /** a claim or equip is in flight */
  busy: boolean;
  /** the user this state belongs to — a sign-out or account switch must not show the last one's */
  userId: string | null;
  /**
   * A CLAIMED grant whose cards are still being shown, and the card on screen. A grant is shown
   * one item per card (`grantCards`), but the server claims it once, on the first card — after
   * which it is no longer in `pending`, and without this its second card (the star's decal,
   * after its badge) would never appear. Kept here rather than in the dialog so Esc and a return
   * to the menus resume on the same card.
   */
  revealing: { grant: RewardGrant; at: number } | null;
}

let snap: RewardsSnapshot = { status: 'idle', state: null, postponed: false, busy: false, userId: null, revealing: null };
const subs = new Set<() => void>();
function set(next: Partial<RewardsSnapshot>): void {
  snap = { ...snap, ...next };
  for (const f of subs) f();
}
const subscribe = (f: () => void): (() => void) => {
  subs.add(f);
  return () => subs.delete(f);
};

export function useRewards(): RewardsSnapshot {
  return useSyncExternalStore(subscribe, () => snap, () => snap);
}

/** keep the queue in the order `compareGrants` states: the prestigious first, oldest first */
const sorted = (s: RewardStateDto): RewardStateDto => ({ ...s, pending: [...(s.pending ?? [])].sort(compareGrants) });

let seq = 0;
/**
 * LOAD (or reload) for `userId`. Null clears — signed out.
 *
 * ⚠️ AN OLDER SERVER HAS NO REWARD ROUTE, and answers 404 (`FriendsUnavailableError`). That is
 * "nothing pending, nothing held", which is true of a server that predates the ledger.
 */
export async function loadRewards(userId: string | null): Promise<void> {
  const mine = ++seq;
  if (!userId) {
    set({ status: 'idle', state: null, postponed: false, busy: false, userId: null, revealing: null });
    return;
  }
  if (snap.userId !== userId) set({ state: null, postponed: false, userId, revealing: null });
  set({ status: 'loading' });
  try {
    const s = await fetchRewards();
    if (mine !== seq) return;
    set({ status: 'ready', state: sorted(s) });
  } catch (e) {
    if (mine !== seq) return;
    if (e instanceof FriendsUnavailableError) {
      set({ status: 'ready', state: { pending: [], badges: {}, equippedBadges: [] } });
      return;
    }
    set({ status: 'error' });
  }
}

/** load unless this user's state is already here or on its way — for a page that reads the
 *  store and must not depend on the dialog having mounted first */
export function ensureRewards(userId: string | null): void {
  if (userId && snap.userId === userId && (snap.status === 'loading' || snap.status === 'ready')) return;
  void loadRewards(userId);
}

/** put the dialog off for the rest of this visit to the menus */
export function postponeRewards(): void {
  set({ postponed: true });
}

/** bring it back — the appearance page's "Show" button, and every return to the menus */
export function reopenRewards(): void {
  set({ postponed: false });
}

/** THE CARD ON SCREEN: the claimed grant still being walked through, else the next pending
 *  grant's first card. `item` is null only for a grant with nothing this build can draw. */
export interface RewardCardAt {
  grant: RewardGrant;
  at: number;
  of: number;
  item: RewardItem | null;
  /** the grant was already claimed (its first card was answered) */
  claimed: boolean;
}
export function currentCard(s: RewardsSnapshot): RewardCardAt | null {
  const claimed = !!s.revealing;
  const grant = s.revealing?.grant ?? s.state?.pending[0] ?? null;
  if (!grant) return null;
  const at = s.revealing?.at ?? 0;
  const cards = grantCards(grant);
  return { grant, at, of: Math.max(1, cards.length), item: cards[at] ?? null, claimed };
}

/**
 * ANSWER THE CARD ON SCREEN — Claim, or with `equip` Equip now. Answers whether it landed, and
 * the cosmetic to put on the active robot when Equip now was pressed on a decal (the robot is
 * the dialog's owner's to change, not the store's).
 *
 * The FIRST answer on a grant claims the whole grant (`claimReward` with `equip: false`, one
 * transaction on the server), because a grant is one thing that was earned. Equip now then
 * wears THIS card's item and nothing else: a badge through the same call the picker makes, a
 * decal by the caller. Only then does the card advance, so a failed equip leaves the card up to
 * try again — as a claimed one, so the retry does not claim twice.
 *
 * A claim that delivered a COSMETIC tells the entitlement provider to re-read, so the builder's
 * swatch unlocks without a reload (`ENTITLEMENTS_CHANGED`, `src/ads/AdsProvider.tsx`).
 */
export async function answerCard(equip: boolean): Promise<{ ok: boolean; cosmetic: string | null }> {
  const card = currentCard(snap);
  if (!card || snap.busy) return { ok: false, cosmetic: null };
  set({ busy: true });
  try {
    if (!card.claimed) {
      const s = await claimReward(card.grant.id, false);
      set({ state: sorted(s), revealing: { grant: card.grant, at: card.at } });
      if (grantCosmetics(card.grant).length > 0) window.dispatchEvent(new Event(ENTITLEMENTS_CHANGED));
    }
  } catch {
    set({ busy: false });
    return { ok: false, cosmetic: null };
  }
  if (equip && card.item?.kind === 'badge' && snap.state) {
    const worn = snap.state.equippedBadges.map((b) => b.id);
    if (!(await equipBadges(withBadgeEquipped(worn, card.item.id)))) {
      set({ busy: false });
      return { ok: false, cosmetic: null };
    }
  }
  const next = card.at + 1;
  set({ busy: false, revealing: next < card.of ? { grant: card.grant, at: next } : null });
  return { ok: true, cosmetic: equip && card.item?.kind === 'cosmetic' ? card.item.id : null };
}

/** WEAR these badges (the picker). Optimistic, rolled back on refusal. */
export async function equipBadges(ids: string[]): Promise<boolean> {
  const prev = snap.state;
  if (!prev) return false;
  const counts = prev.badges;
  set({ state: { ...prev, equippedBadges: ids.map((id) => ({ id, n: counts[id] ?? 1 })) } });
  try {
    const r = await saveBadges(ids);
    if (snap.state) set({ state: { ...snap.state, equippedBadges: r.equippedBadges } });
    return true;
  } catch {
    set({ state: prev });
    return false;
  }
}
