/**
 * "SHOW OTHER PLAYERS’ IMPORTED ROBOTS" — a per-device preference, default ON.
 *
 * Off means every other player's imported robot is its footprint (an outline) and this device
 * asks the room for nothing: no picture, no mesh. It lives in its own `localStorage` key
 * (`IMPORT_VISUALS_KEY`), never in `GameSettings`, for the reason the Graphics section's other
 * settings do: what a screen can afford to download is a fact about this device, not the account
 * (`docs/area/ui.md`, Configure). No React import, so the relay client can read it.
 */
import { IMPORT_SHARE_KEY, IMPORT_VISUALS_KEY } from '../storageKeys';

const listeners = new Set<(on: boolean) => void>();

/** true unless this device chose otherwise; never throws (storage may be blocked) */
export function getShowOthersImported(): boolean {
  try {
    return localStorage.getItem(IMPORT_VISUALS_KEY) !== '0';
  } catch {
    return true;
  }
}

/** persist the choice and tell this tab's subscribers (best-effort: a storage failure still notifies) */
export function setShowOthersImported(on: boolean): void {
  try {
    localStorage.setItem(IMPORT_VISUALS_KEY, on ? '1' : '0');
  } catch {
    /* non-fatal: the pick still applies for this session */
  }
  for (const fn of listeners) fn(on);
}

/** subscribe to changes made through `setShowOthersImported`; returns the unsubscribe */
export function subscribeShowOthersImported(fn: (on: boolean) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * "SHARE MY IMPORTED ROBOT'S LOOK" — the OWNER's side, per device, and the one switch that decides
 * whether anything of a player's imported robot leaves this machine for a room (docs/area/robot-import.md,
 * "Relayed to a room"). Three states, not two:
 *
 *  · `'ask'` — never answered. THE DEFAULT, and what unreadable or absent storage reads as: a device
 *    that cannot say yes has not said yes. Nothing is uploaded; the lobby asks once (`ShareLookDialog`).
 *  · `'on'` — the owner said yes: the room is sent the robot's top picture and, in BIOBUZZ, a lighter copy
 *    of its model.
 *  · `'off'` — the owner said no, or turned it off again: nothing is uploaded and a look already in a room
 *    is withdrawn (`visualDrop`).
 *
 * It fails CLOSED in every direction: only the exact stored `'1'` is a yes, only the exact `'0'` a no,
 * and any other value (a hand-edited key, a newer build's) asks again. A per-device key, never in
 * `GameSettings`: that blob syncs to the account, and a new device must ask for itself (FTC teams keep
 * their CAD private until an event). No React import, so the relay client can read it.
 */
export type ShareOwnLook = 'ask' | 'on' | 'off';

const shareListeners = new Set<(v: ShareOwnLook) => void>();
/** an answer the player GAVE but storage would not keep (a blocked or full store): honoured until this page reloads, never invented */
let unsavedShare: ShareOwnLook | null = null;

/** the stored answer; `'ask'` when none, or when storage cannot be read. Never throws. */
export function getShareOwnLook(): ShareOwnLook {
  try {
    const v = localStorage.getItem(IMPORT_SHARE_KEY);
    if (v === '1') return 'on';
    if (v === '0') return 'off';
  } catch {
    /* unreadable: ask */
  }
  return unsavedShare ?? 'ask';
}

/** persist the answer and tell this tab's subscribers (a store that will not take it still applies the answer until the page reloads) */
export function setShareOwnLook(on: boolean): void {
  const v: ShareOwnLook = on ? 'on' : 'off';
  try {
    localStorage.setItem(IMPORT_SHARE_KEY, on ? '1' : '0');
    unsavedShare = null;
  } catch {
    unsavedShare = v;
  }
  for (const fn of [...shareListeners]) fn(v);
}

/** subscribe to changes made through `setShareOwnLook`, in this tab or another; returns the unsubscribe */
export function subscribeShareOwnLook(fn: (v: ShareOwnLook) => void): () => void {
  shareListeners.add(fn);
  return () => {
    shareListeners.delete(fn);
  };
}

// ANOTHER TAB'S ANSWER reaches this one as a `storage` event, so turning sharing off in a second tab
// withdraws the look from the room this tab is in as well. Best-effort: no window, no listener.
try {
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('storage', (e: StorageEvent) => {
      if (e.key !== IMPORT_SHARE_KEY && e.key !== null) return; // null: the whole store was cleared
      const v = getShareOwnLook();
      for (const fn of [...shareListeners]) fn(v);
    });
  }
} catch {
  /* a sandbox without events: this tab's own switch still works */
}
