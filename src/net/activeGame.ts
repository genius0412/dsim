import type { MatchStart } from './lobbyClient';

/**
 * A tiny localStorage record of the multiplayer game this browser is currently in,
 * so the player can REJOIN the same match after navigating away / refreshing, and
 * so we can stop them from starting a SECOND game while one is live.
 *
 * It stores everything a `ServerSession` needs to reconstruct itself (the original
 * `matchStart` payload) plus the room + our clientId, which the server uses to
 * reclaim our held slot within its reconnect grace. It is a HINT: the server is the
 * authority — a rejoin fails cleanly (and we clear this) if the slot is already gone.
 */
export interface ActiveGameRef {
  room: string;
  /** the Fly region hosting the match, for reconnect routing (custom rooms need it) */
  region?: string;
  clientId: string;
  /** the matchStart payload (seed/setups/yourRobotId/…) to rebuild the session */
  start: MatchStart;
  ranked: boolean;
  /** what kind of game, for the Home rejoin card label */
  kind: 'ranked' | 'custom' | 'record';
  savedAt: number;
}

const KEY = 'decodesim.activeGame.v1';
/** how long a saved ref stays valid. Comfortably longer than a match + settle, but
 * short enough that a long-abandoned entry expires on its own (the server grace is
 * far shorter, so a stale rejoin just fails cleanly regardless). */
const TTL_MS = 6 * 60 * 1000;

export function saveActiveGame(ref: ActiveGameRef): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(ref));
  } catch {
    /* storage unavailable — rejoin just won't be offered */
  }
}

/** the current active-game ref, or null if none / expired / corrupt (expired and
 * corrupt entries are cleared as a side effect). */
export function loadActiveGame(): ActiveGameRef | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as ActiveGameRef;
    if (
      !r ||
      typeof r.room !== 'string' ||
      typeof r.clientId !== 'string' ||
      !r.start ||
      typeof r.savedAt !== 'number'
    ) {
      clearActiveGame();
      return null;
    }
    if (Date.now() - r.savedAt > TTL_MS) {
      clearActiveGame();
      return null;
    }
    return r;
  } catch {
    clearActiveGame();
    return null;
  }
}

export function clearActiveGame(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
