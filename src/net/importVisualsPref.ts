/**
 * "SHOW OTHER PLAYERS’ IMPORTED ROBOTS" — a per-device preference, default ON.
 *
 * Off means every other player's imported robot is its footprint (an outline) and this device
 * asks the room for nothing: no picture, no mesh. It lives in its own `localStorage` key
 * (`IMPORT_VISUALS_KEY`), never in `GameSettings`, for the reason the Graphics section's other
 * settings do: what a screen can afford to download is a fact about this device, not the account
 * (`docs/area/ui.md`, Configure). No React import, so the relay client can read it.
 */
import { IMPORT_VISUALS_KEY } from '../storageKeys';

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
