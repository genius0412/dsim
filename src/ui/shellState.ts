import { useSyncExternalStore } from 'react';

/**
 * WHAT THE APP IS SHOWING, for the two things mounted BESIDE `<App/>` in `main.tsx` that need
 * to know: the site gate (a lockdown that starts mid-match waits until the match screen is
 * left) and the banner stack (hidden in a match, scoped to the game being played).
 * `App` writes it; nothing else does.
 */
export interface ShellState {
  /** the match screen is up (a local or server match, results included) */
  inMatch: boolean;
  /** the game the player is on */
  game: string;
}

let state: ShellState = { inMatch: false, game: 'decode' };
const subs = new Set<() => void>();

export function setShellState(patch: Partial<ShellState>): void {
  const next = { ...state, ...patch };
  if (next.inMatch === state.inMatch && next.game === state.game) return;
  state = next;
  subs.forEach((f) => f());
}
export const getShellState = (): ShellState => state;
export function useShellState(): ShellState {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    getShellState,
    getShellState,
  );
}
