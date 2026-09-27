import { useEffect, useState } from 'react';
import type { GameSettings } from '../game';
import { authClient, clearAuthToken } from '../lib/authClient';
import { fetchAccountSettings } from '../net/api';
import { coerceSettings } from '../settings';

// Module-level so it survives this component unmounting (it's only mounted on
// shell screens, not during a game): a given user is loaded from the server at
// most once per session, so returning to the menu never re-fetches and clobbers
// unsaved local edits. Reset when signed out.
let syncedUser: string | null = null;

/**
 * Per-account settings sync (rendered only when auth is enabled → `authClient`
 * non-null). On sign-in it loads the account's saved settings and applies them,
 * or — if the account has none yet — seeds it from the current local settings.
 * Ongoing saves happen in App's `update()` (debounced). Renders nothing.
 */
export function AccountSync({
  onUser,
  onLoad,
  seed,
}: {
  onUser: (id: string | null) => void;
  onLoad: (s: GameSettings) => void;
  seed: () => void;
}) {
  const session = authClient!.useSession();
  const uid = session.data?.user?.id ?? null;
  /**
   * A FAILED LOAD IS RETRIED, NOT LEFT FOR "A LATER RENDER". `fetchAccountSettings` throws on
   * anything but a real answer (a cold server's 502, a token hiccup) precisely so this does not
   * seed the account over its own settings — but nothing re-ran the effect after a failure, so
   * the account's settings simply never arrived until this component remounted. Bumped on a
   * backoff instead; the module-level `syncedUser` still stops a success from ever repeating.
   */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // The identity just changed - sign-in, sign-out, or a switch between accounts -
    // so the in-memory JWT belongs to whoever was here before. Clearing it here
    // covers every sign-out button at once, since they all land on this effect.
    // Keyed on the identity ALONE: the load below retries on its own clock, and a retry
    // is not an identity change that should throw away a good cached token.
    clearAuthToken();
    onUser(uid);
    if (!uid) syncedUser = null;
  }, [uid, onUser]);

  useEffect(() => {
    if (!uid || syncedUser === uid) return;
    syncedUser = uid;
    let alive = true;
    let settled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    fetchAccountSettings()
      .then((raw) => {
        settled = true;
        if (!alive) return;
        if (raw) onLoad(coerceSettings(raw));
        else seed();
      })
      .catch(() => {
        settled = true;
        syncedUser = null;
        if (!alive) return;
        retry = setTimeout(() => setAttempt((n) => n + 1), Math.min(60_000, 3_000 * 2 ** attempt));
      });
    return () => {
      alive = false;
      if (retry !== undefined) clearTimeout(retry);
      // UNMOUNTED BEFORE THE ANSWER (a match started first, or StrictMode's rehearsal unmount):
      // whatever arrives now is dropped, so this user is not synced and the next mount asks again
      if (!settled && syncedUser === uid) syncedUser = null;
    };
    // `attempt` is read for the backoff and is the retry trigger itself
  }, [uid, onLoad, seed, attempt]);

  return null;
}
