import { useEffect } from 'react';

/**
 * Escape backs out of a full-screen console surface (Lobby, Record Run, Ranked).
 * `fn` should be the SAME handler the visible `.ds-back` button runs — Esc is a
 * shortcut for that button, not a second exit with its own semantics.
 *
 * Pass `enabled: false` while the screen has handed the viewport to a child that
 * owns its own back semantics (e.g. Matchmaking → MatchStrategy), so Esc can't
 * reach past it and trigger the parent's exit.
 */
export function useEscape(fn: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') fn();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fn, enabled]);
}
