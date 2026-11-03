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

let booted = false;
let leaving = false;
let asked = false;
let holds = 0;
let wake: (() => void) | null = null;
/**
 * The boot screen is gone. From then on a shell that MOUNTS (back from a match, a replay) takes
 * `.ds-arrive` at mount; the first one is under the boot screen's fade instead. Read at mount,
 * never flipped onto a mounted element, which would start the fade on a screen already showing.
 */
export const bootDone = (): boolean => booted;
const bootWaiters: (() => void)[] = [];
/** resolves once the boot screen is gone (at once if it already is): work that should not compete
 * with the first screen's own build waits for it */
export const afterBoot = (): Promise<void> =>
  booted ? Promise.resolve() : new Promise<void>((resolve) => bootWaiters.push(resolve));
const finishBoot = (): void => {
  booted = true;
  bootWaiters.splice(0).forEach((f) => f());
};

/**
 * how long the boot screen waits for a picture the first screen is still making, after the app has
 * mounted: past it the screen shows with its own loading state. The 3D stage measured ~1.5 s from
 * mount on a fast line; on Slow 4G it is ~8 s, too long to keep the menu covered.
 */
const HOLD_MAX_MS = 3000;

/**
 * KEEP THE BOOT SCREEN UP for a picture the first screen is still making (the 3D menu stage,
 * `MenuStage.tsx`), so the page appears once, whole, instead of in a second step (owner, 2026-11-02:
 * a 2D field shown "for a split second before switching to 3d"). Returns the release, which is safe
 * to call twice. Once the boot screen has started to leave, it holds nothing.
 */
export function holdBoot(): () => void {
  if (leaving || booted) return () => {};
  holds++;
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    holds--;
    // on the next task, so a StrictMode unmount-and-remount (release, then hold again) is not a leave
    if (holds === 0) window.setTimeout(() => holds === 0 && wake?.(), 0);
  };
}

/**
 * THE BOOT SCREEN LEAVES (`#seo-home`, `index.html`). It is a sibling of `#root`, fixed over it, so
 * React mounts underneath and the first screen is painted before the boot screen fades off it; it
 * used to be inside `#root`, where the mount replaced it in one frame with a different page. Called
 * by `main.tsx` once it renders something (the app or the closed screen); waits for the holds above,
 * at most `HOLD_MAX_MS`. Idempotent.
 */
export function dismissBoot(): void {
  if (asked) return;
  asked = true;
  const el = document.getElementById('seo-home');
  if (!el) return finishBoot();
  const go = (): void => {
    if (leaving) return;
    leaving = true;
    wake = null;
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
          finishBoot();
        }, ms + 50);
      }),
    );
  };
  if (holds === 0) return go();
  wake = go;
  window.setTimeout(go, HOLD_MAX_MS);
}
