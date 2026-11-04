import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * PLAY'S PAGE, REHEARSED WHILE HOME IS IDLE (2026-11-04, owner: "clicking 'play' for the first time
 * lags during the animation and it looks like there is no animation at all. Subsequent transitions
 * are fine.").
 *
 * Measured cold (`npm run firstload`, CPU ×4): the click's own task, React mounting Play's page and
 * laying it out, was 80–140 ms the first time and under 50 ms every later time, and it sat in front of
 * the camera fly's first frame. Rehearsed: ~35 ms the first time too. Nothing about the second mount is cached by the app: what the first one
 * paid for was the engine's first time through that code and those styles (lazily compiled
 * functions, the page's style rules, the text it shapes).
 *
 * So App mounts the page once, invisible and inert, while Home is idle (rendered in a transition,
 * so React yields between slices), lets it lay out, and drops it. Its handlers are no-ops; it
 * fetches nothing the real page would not. Off-screen in every sense: `visibility: hidden` (laid
 * out, never painted), `aria-hidden` + `inert`, a portal at the end of `body`, so a query for one of
 * Play's elements finds the real page first whenever it is there.
 */
export function PlayRehearsal({ children, onDone }: { children: ReactNode; onDone: () => void }) {
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    let r2 = 0;
    // the frame after the commit lays the page out; the one after that, it is done
    const r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => done.current());
    });
    return () => {
      cancelAnimationFrame(r1);
      cancelAnimationFrame(r2);
    };
  }, []);
  return createPortal(
    <div className="ds-rehearsal" aria-hidden="true" {...{ inert: '' }}>
      {children}
    </div>,
    document.body,
  );
}
