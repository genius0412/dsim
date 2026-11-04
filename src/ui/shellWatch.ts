import { useEffect, useRef, type RefObject } from 'react';

/**
 * THE MENU STAGE IS NEVER ALL THERE IS (owner, 2026-11-04: "after leaving room, a user freezes on the
 * robot page with nothing loaded"). The tester's screen was Play's 3D field with the bar, the robot rail
 * and the modes all gone, and no way to click anything. The stage is a fixed layer BEHIND the shell, so
 * anything that hides the shell (a fade stuck at opacity 0, the popup rule hiding Play for a popup that
 * shows nothing, the shell scrolled or stacked out of sight) leaves exactly that picture. The cause was
 * not reproduced, so this watches for the picture itself on the stage pages (Home, Play and the popups
 * over Play) and brings the page back.
 *
 * Every `WATCH_EVERY_MS` it asks whether any of the page's own UI is on screen (`stageUiShown`). Blank
 * for `BLANK_MS`: running animations in the shell are finished, the boot screen is removed and the
 * scroll is put back. Still blank `RETRY_MS` later: Home. Never more than that per page, so a page that
 * cannot be shown never loops. A hidden tab is not judged (its animations do not run).
 *
 * The decision is DOM-free (`watchStep`, `pageBlank`) and checked in smoke; the probe is not.
 */

export const WATCH_EVERY_MS = 1000;
/** blank this long before anything is done: every fade and the Home ↔ Play fly finish well inside it */
export const BLANK_MS = 3000;
/** after the repair, this long again before going Home */
export const RETRY_MS = 2000;

/** one candidate piece of the page's own UI, as the probe measured it */
export interface UiProbe {
  /** a box with area, at least partly inside the window */
  onScreen: boolean;
  /** computed `visibility` is visible */
  visible: boolean;
  /** its opacity times every ancestor's */
  opacity: number;
  /** the topmost thing at its centre is the menu stage */
  underStage: boolean;
}

/** nothing the player can see or press is on screen */
export function pageBlank(probes: readonly UiProbe[]): boolean {
  return !probes.some((p) => p.onScreen && p.visible && p.opacity > 0.05 && !p.underStage);
}

export interface WatchState {
  /** how long the page has been blank, in ms */
  blankFor: number;
  /** the repair has run for this blank spell */
  repaired: boolean;
  /** Home has been tried for this page; nothing more is done until it changes */
  gaveUp: boolean;
}

export const WATCH_START: WatchState = { blankFor: 0, repaired: false, gaveUp: false };

export type WatchAction = 'none' | 'repair' | 'home';

/** one tick of the watch: what to do now, and the state after it */
export function watchStep(s: WatchState, blank: boolean, dtMs: number): { state: WatchState; action: WatchAction } {
  if (!blank) return { state: { ...WATCH_START, gaveUp: s.gaveUp }, action: 'none' };
  if (s.gaveUp) return { state: s, action: 'none' };
  const blankFor = s.blankFor + dtMs;
  if (!s.repaired && blankFor >= BLANK_MS) return { state: { blankFor, repaired: true, gaveUp: false }, action: 'repair' };
  if (s.repaired && blankFor >= BLANK_MS + RETRY_MS) return { state: { ...WATCH_START, gaveUp: true }, action: 'home' };
  return { state: { ...s, blankFor }, action: 'none' };
}

/** the shell's own UI on a stage page: the bar, Home's column, Play's rail and modes, a popup's content */
const STAGE_UI = ['.ds-bar', '.ds-home', '.ds-setup-picker', '.ds-setup-side', '.ds-popup-host > *'];

function probe(el: Element): UiProbe {
  const r = el.getBoundingClientRect();
  const w = window.innerWidth;
  const h = window.innerHeight;
  const onScreen = r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < w && r.top < h;
  let opacity = 1;
  for (let n: Element | null = el; n && n !== document.documentElement; n = n.parentElement) {
    opacity *= parseFloat(getComputedStyle(n).opacity) || 0;
  }
  const cx = Math.min(w - 1, Math.max(0, r.left + r.width / 2));
  const cy = Math.min(h - 1, Math.max(0, r.top + r.height / 2));
  const top = onScreen ? document.elementFromPoint(cx, cy) : null;
  return {
    onScreen,
    visible: getComputedStyle(el).visibility === 'visible',
    opacity,
    underStage: !!top?.closest('.ds-stage'),
  };
}

/** is any of the stage page's own UI on screen? */
export function stageUiShown(): boolean {
  const els = STAGE_UI.flatMap((sel) => [...document.querySelectorAll(sel)]);
  return !pageBlank(els.map(probe));
}

/** finish the shell's own running fades, drop a boot screen that never left, scroll the shell home */
function repair(app: Element | null): void {
  for (const a of document.getAnimations?.() ?? []) {
    const target = (a.effect as KeyframeEffect | null)?.target;
    if (!target || !app?.contains(target)) continue;
    try {
      a.finish();
    } catch {
      a.cancel(); // an endless one cannot finish
    }
  }
  document.getElementById('seo-home')?.remove();
  if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
  if (app) app.scrollTop = 0;
}

/**
 * Watch a stage page (`AppShell` passes its `.ds-app` and the page key). `onHome` is the shell's way
 * Home. Off a stage page this does nothing.
 */
export function useStageWatch(active: boolean, page: string | undefined, app: RefObject<HTMLElement>, onHome: () => void): void {
  const home = useRef(onHome);
  home.current = onHome;
  useEffect(() => {
    if (!active) return;
    let state = WATCH_START;
    const t = window.setInterval(() => {
      if (document.hidden) return;
      const blank = !stageUiShown();
      const step = watchStep(state, blank, WATCH_EVERY_MS);
      state = step.state;
      if (step.action === 'repair') {
        // eslint-disable-next-line no-console
        console.warn('[shell] the page showed nothing for 3 s; finishing its fades');
        repair(app.current);
      } else if (step.action === 'home') {
        // eslint-disable-next-line no-console
        console.warn('[shell] the page still showed nothing; going Home');
        home.current();
      }
    }, WATCH_EVERY_MS);
    return () => window.clearInterval(t);
  }, [active, page, app]);
}
