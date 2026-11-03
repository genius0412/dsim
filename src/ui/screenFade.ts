/**
 * SCREEN ARRIVALS (2026-11-02, owner: a smooth first load and smooth transitions, "not excessive").
 * Every screen change is one opacity fade at `--ds-dur-screen` (shell.css), entry only. CSS owns the
 * surfaces that MOUNT (popups and dialogs: `ds-screen-in`; a match: `ds-cover-out`); this file owns
 * the two it cannot see mount: a route change that keeps the shell's `<main>`, and the boot screen in
 * `index.html`.
 */

const reduced = (): boolean =>
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** `--ds-dur-screen` in ms, off the stylesheet, so the token is the one place it is set */
export function screenFadeMs(): number {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--ds-dur-screen').trim();
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return 200;
  return v.endsWith('ms') ? n : n * 1000;
}

/** fade a screen's content in (a new route inside the same `<main>`) */
export function fadeIn(el: HTMLElement | null): void {
  if (!el || reduced() || typeof el.animate !== 'function') return;
  el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: screenFadeMs(), easing: 'ease-out' });
}

/**
 * THE BOOT SCREEN LEAVES (`#seo-home`, `index.html`). It is a sibling of `#root`, fixed over it, so
 * React mounts underneath and the first screen is painted before the boot screen fades off it; it
 * used to be inside `#root`, where the mount replaced it in one frame with a different page. Called
 * by `main.tsx` once it renders something (the app or the closed screen). Idempotent.
 */
let booted = false;
/**
 * The boot screen is gone. From then on a shell that MOUNTS (back from a match, a replay) takes
 * `.ds-arrive` at mount; the first one is under the boot screen's fade instead. Read at mount,
 * never flipped onto a mounted element, which would start the fade on a screen already showing.
 */
export const bootDone = (): boolean => booted;

export function dismissBoot(): void {
  const el = document.getElementById('seo-home');
  const done = (): void => {
    booted = true;
  };
  if (!el) return done();
  if (el.dataset.leaving) return;
  el.dataset.leaving = '1';
  // the page under it takes the pointer at once: it is mounted, and two frames from painted
  el.style.pointerEvents = 'none';
  const ms = reduced() ? 0 : screenFadeMs();
  // two frames: the first one commits the new screen, the second has painted it
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      el.style.transition = `opacity ${ms}ms ease-out`;
      el.style.opacity = '0';
      window.setTimeout(() => {
        el.remove();
        done();
      }, ms + 50);
    }),
  );
}
