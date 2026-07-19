/**
 * One-time "Chain Reaction is just for fun" disclaimer dismissal.
 *
 * Local-only (like `theme.ts`, deliberately NOT in `GameSettings`): it's a
 * per-device acknowledgement, shouldn't require signing in, and shouldn't follow
 * the account to another machine. Stored under its own localStorage key.
 */
// bumped v1→v2 when the wording was corrected (it's the SIM that's unrealistic,
// not the game) — so anyone who dismissed the old copy sees the fixed one once.
const KEY = 'decodesim.chainDisclaimer.v2';

/** has the player already dismissed the Chain Reaction disclaimer on this device? */
export function chainDisclaimerSeen(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false; // private mode / storage disabled → treat as unseen (show it)
  }
}

/** remember that the disclaimer was dismissed, so it never shows again. */
export function markChainDisclaimerSeen(): void {
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    /* non-fatal: it just shows again next session */
  }
}
