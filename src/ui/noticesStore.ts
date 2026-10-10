import { useSyncExternalStore } from 'react';
import { fetchNotices, markNoticesRead } from '../net/api';
import { noticeView, type Notice } from '../notices';

/**
 * THE ACCOUNT'S NOTICE INBOX, one copy for the whole shell (`GET /api/user/notices`, 0057).
 *
 * A module store for the reason `rewardsStore` is one: the pop-up (`NoticeDialog`) and the
 * career page's list (`NoticeInbox`) must agree the moment either changes it. A notice
 * acknowledged in the pop-up shows as read on the page behind it without a second fetch.
 *
 * `useSyncExternalStore` needs a NEW snapshot object on every change, so `set` replaces it.
 */
export interface NoticesSnapshot {
  status: 'idle' | 'loading' | 'ready' | 'error';
  notices: Notice[];
  /** the account this inbox belongs to — a sign-out or account switch must not show the last one's */
  userId: string | null;
  /** when the last load landed (ms), so a refocus within a minute does not refetch */
  at: number;
}

let snap: NoticesSnapshot = { status: 'idle', notices: [], userId: null, at: 0 };
const subs = new Set<() => void>();
function set(next: Partial<NoticesSnapshot>): void {
  snap = { ...snap, ...next };
  for (const f of subs) f();
}
const subscribe = (f: () => void): (() => void) => {
  subs.add(f);
  return () => subs.delete(f);
};

export function useNotices(): NoticesSnapshot {
  return useSyncExternalStore(subscribe, () => snap, () => snap);
}

let seq = 0;
/** LOAD (or reload) for `userId`. Null clears — signed out. */
export async function loadNotices(userId: string | null): Promise<void> {
  const mine = ++seq;
  if (!userId) {
    set({ status: 'idle', notices: [], userId: null, at: 0 });
    return;
  }
  if (snap.userId !== userId) set({ notices: [], userId });
  set({ status: 'loading' });
  try {
    const notices = await fetchNotices();
    if (mine !== seq) return;
    set({ status: 'ready', notices, at: Date.now() });
  } catch (e) {
    if (mine !== seq) return;
    console.warn('[notices] load failed:', e);
    set({ status: 'error' });
  }
}

/** load unless this user's inbox is already here and fresh, or on its way */
export function ensureNotices(userId: string | null, maxAgeMs = 60_000): void {
  if (!userId) return void loadNotices(null);
  if (snap.userId === userId && snap.status === 'loading') return;
  if (snap.userId === userId && snap.status === 'ready' && Date.now() - snap.at < maxAgeMs) return;
  void loadNotices(userId);
}

/** UNREAD notices this build can word, oldest first — the order things happened in */
export function unreadNotices(s: NoticesSnapshot): Notice[] {
  return s.notices.filter((n) => !n.readAt && noticeView(n) !== null).reverse();
}

/**
 * MARK THESE READ — optimistically, so the pop-up closes on the press rather than on the round
 * trip. A failed write is logged and left: the notice is still in the inbox on the career page,
 * and the pop-up showing it once more next time is the honest consequence.
 */
export async function acknowledgeNotices(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const now = new Date().toISOString();
  const wanted = new Set(ids);
  set({ notices: snap.notices.map((n) => (wanted.has(n.id) && !n.readAt ? { ...n, readAt: now } : n)) });
  try {
    await markNoticesRead(ids);
  } catch (e) {
    console.warn('[notices] mark read failed:', e);
  }
}
