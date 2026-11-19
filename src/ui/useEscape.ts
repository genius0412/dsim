import { useEffect, useRef } from 'react';

/**
 * ONE ESCAPE, ONE SURFACE. Every enabled `useEscape` is on this stack in the order it was enabled,
 * and a press goes to the LAST one alone: the surface opened most recently.
 *
 * Each call used to add its own `window` listener, and they all ran. The friends sheet opens over
 * a joined room, the ranked screen, a record run and the LAN panel, each of which leaves on
 * Escape, so the press that closed the sheet also left the room under it (and a host who leaves
 * gives the room up). Listeners on one target run in the order they were added, so the sheet,
 * always added later, could not have consumed the key first.
 */
interface Holder {
  fn: () => void;
}
const stack: Holder[] = [];

/** Put `holder` on top; the returned function takes it off again, wherever it is by then. */
export function holdEscape(holder: Holder): () => void {
  stack.push(holder);
  return () => {
    const at = stack.indexOf(holder);
    if (at >= 0) stack.splice(at, 1);
  };
}

/** Run the top holder's handler. False when nothing holds the key. */
export function escapePressed(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.fn();
  return true;
}

let listening = false;
const onKey = (e: KeyboardEvent): void => {
  // a child that already consumed this Escape (Select closing its listbox, a `useDialog`: both
  // run before this window listener) must not also exit the screen
  if (e.key === 'Escape' && !e.defaultPrevented) escapePressed();
};

/**
 * Escape backs out of a full-screen console surface (Lobby, Record Run, Ranked).
 * `fn` should be the SAME handler the visible `.ds-back` button runs — Esc is a
 * shortcut for that button, not a second exit with its own semantics.
 *
 * Pass `enabled: false` while the screen has handed the viewport to a child that
 * owns its own back semantics (e.g. Matchmaking → MatchStrategy), so Esc can't
 * reach past it and trigger the parent's exit.
 *
 * `fn` is read when the key arrives, so a handler that is a new arrow every render keeps its
 * place on the stack; only `enabled` moves it.
 */
export function useEscape(fn: () => void, enabled = true): void {
  const holder = useRef<Holder>({ fn });
  holder.current.fn = fn;
  useEffect(() => {
    if (!enabled) return;
    if (!listening) {
      window.addEventListener('keydown', onKey);
      listening = true;
    }
    return holdEscape(holder.current);
  }, [enabled]);
}
