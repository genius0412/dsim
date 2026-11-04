import { useSyncExternalStore } from 'react';

/**
 * WHAT THE APP IS SHOWING, for the things mounted BESIDE `<App/>` in `main.tsx` that need to
 * know: the site gate (a lockdown that starts mid-match waits until the match screen is left),
 * the banner stack (hidden in a match, scoped to the game being played) and the event toasts
 * (held in a match and in a replay). `App` writes it; nothing else does.
 */
export interface ShellState {
  /** the match screen is up (a local or server match, results included) */
  inMatch: boolean;
  /** the replay viewer is up (the event toasts wait for it like a match) */
  replay: boolean;
  /** the game the player is on */
  game: string;
}

let state: ShellState = { inMatch: false, replay: false, game: 'decode' };
const subs = new Set<() => void>();

export function setShellState(patch: Partial<ShellState>): void {
  const next = { ...state, ...patch };
  if (next.inMatch === state.inMatch && next.replay === state.replay && next.game === state.game) return;
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
