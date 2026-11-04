import { useEffect, useLayoutEffect, useReducer, useRef, useState, type CSSProperties } from 'react';
import { openToastTarget, subscribeToasts, toastRunner, type Toast } from '../eventToasts';
import { useShellState } from './shellState';
import { useOpenDialogs } from './useDialog';
import { CloseGlyph } from './FriendsPanel';

/**
 * THE EVENT TOAST — the one corner notice (`src/eventToasts.ts` holds the rules, the queue and
 * the copy; this draws it). Mounted once beside `<App/>` in `main.tsx`, so it is on every page,
 * the early-returned full-screen ones included, and renders through nothing but a fixed box.
 *
 * - HELD (nothing shows, everything waits) while the match screen is up (results included),
 *   while a replay plays, and while any dialog is open — `useOpenDialogs` counts every
 *   `useDialog`, which is every popup and modal in the shell.
 * - ONE at a time, `SHOW_MS` each, PAUSED while hovered or focused.
 * - A click opens the page it is about and closes it; × closes it.
 * - The region is ALWAYS MOUNTED: a live region has to exist before content is put in it, or the
 *   first toast is never announced (the friend toasts learned that, `FriendToasts`).
 * - `position: fixed` and moved only by `transform`/`opacity`, so it never shifts the page.
 * - IT STEPS OVER WHAT IS ALREADY IN ITS CORNER. The ranked queue bar, a called competition match
 *   (the same `.ds-queuebar`) and the friend toasts are fixed to the bottom too. On a desktop they
 *   sit bottom-right and nothing is in the way; on a phone everything spans the one bottom edge,
 *   and the queue bar wraps to two or three lines. So when a toast appears, `liftOver` measures
 *   whichever of them share its columns and lifts it above the highest (`--ds-toast-lift`). Once
 *   per toast, not on a loop.
 */
export function EventToasts() {
  const shell = useShellState();
  const dialogs = useOpenDialogs();
  const held = shell.inMatch || shell.replay || dialogs > 0;
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const runner = toastRunner();
  const region = useRef<HTMLDivElement>(null);
  const [lift, setLift] = useState(0);

  useEffect(() => subscribeToasts(rerender), []);

  useEffect(() => {
    if (runner.setHeld(held, Date.now())) rerender();
  }, [held, runner]);

  // the clock: after every render, retire or advance, else sleep until the next thing can happen
  useEffect(() => {
    const now = Date.now();
    if (runner.step(now)) {
      rerender();
      return;
    }
    const ms = runner.nextWakeMs(now);
    if (ms === null) return;
    const id = window.setTimeout(rerender, Math.max(50, ms + 10));
    return () => window.clearTimeout(id);
  });

  const t = runner.current;
  useLayoutEffect(() => {
    if (t && region.current) setLift(liftOver(region.current));
  }, [t?.key]);
  const close = (): void => {
    runner.dismiss(Date.now());
    rerender();
  };

  return (
    <div
      ref={region}
      className="ds-toasts"
      style={lift ? ({ '--ds-toast-lift': `${lift}px` } as CSSProperties) : undefined}
      role="region"
      aria-label="Announcements"
      aria-live="polite"
      onMouseEnter={() => runner.pause(Date.now())}
      onMouseLeave={() => {
        runner.resume(Date.now());
        rerender();
      }}
      onFocus={() => runner.pause(Date.now())}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        runner.resume(Date.now());
        rerender();
      }}
    >
      {t && <ToastCard key={t.key} t={t} onOpen={() => (t.target ? openToastTarget(t.target) : false) && close()} onClose={close} />}
    </div>
  );
}

/** the fixed bottom cards that can share the toast's corner */
const BOTTOM_CARDS = '.ds-queuebar:not(.over), .fr-toasts:not(.in-match) > .fr-toast';

/** how far above its resting place the toast must sit to clear every card in its columns */
function liftOver(region: HTMLElement): number {
  const own = region.getBoundingClientRect();
  // measured from where it RESTS: the box may still carry the last toast's lift
  const floor = own.bottom + (parseFloat(getComputedStyle(region).getPropertyValue('--ds-toast-lift')) || 0);
  let top = floor;
  for (const el of document.querySelectorAll<HTMLElement>(BOTTOM_CARDS)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.right <= own.left || r.left >= own.right) continue;
    top = Math.min(top, r.top);
  }
  return top < floor ? Math.ceil(floor - top) + 8 : 0;
}

function ToastCard({ t, onOpen, onClose }: { t: Toast; onOpen: () => void; onClose: () => void }) {
  const body = (
    <>
      <span className="ds-toast-title">{t.title}</span>
      {t.detail && <span className="ds-toast-detail">{t.detail}</span>}
    </>
  );
  return (
    <div className={`ds-toast ${t.scope}`}>
      {t.target ? (
        <button type="button" className="ds-toast-main" onClick={onOpen}>
          {body}
        </button>
      ) : (
        <div className="ds-toast-main">{body}</div>
      )}
      <button type="button" className="ds-toast-x" aria-label="Dismiss" onClick={onClose}>
        <CloseGlyph size={12} />
      </button>
    </div>
  );
}
