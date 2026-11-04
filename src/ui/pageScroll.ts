import { useLayoutEffect, useRef, type RefObject } from 'react';
import {
  ANCHOR_GAP,
  ANCHOR_WAIT_MS,
  RESTORE_WAIT_MS,
  anchorDelta,
  anchorOf,
  focusMoves,
  landing,
  revealDelta,
  type Arrival,
  type Landing,
} from './pageScrollRules';

/**
 * WHERE A NAVIGATION LANDS — the DOM half, and THE ONE PLACE that does it. The rules and why are in
 * `pageScrollRules.ts`; `docs/area/ui.md` ("Where a navigation lands") says how to use this from a
 * new screen.
 *
 *  - The SHELL (`AppShell`) calls `useRouteScroll` with the page App says it shows. Every route, section
 *    and tab that is a route gets rules 1-3 and 5 from that, with nothing of its own.
 *  - App's router writes history ONLY through `pushRoute` / `replaceRoute`, which key every entry so
 *    Back can find the offset it was left at, and declares an anchor or a re-click with `arrive`.
 *  - A tab strip that is NOT a route (the console's tabs, the importer's steps) calls `usePageTop`.
 *  - A list whose rows a control replaces calls `useListTop`.
 *
 * `npm test` fails a new tab strip that uses neither a route nor this module, and any history write,
 * shell scroll reset or `scrollIntoView` anchor jump made anywhere else ("page scroll:").
 */

const STATE_KEY = 'dsimScroll';
interface EntryState {
  id: string;
  /** the offset the page had when it was left by a push or unloaded: a Back into a reloaded document */
  y?: number;
}

const hasWindow = typeof window !== 'undefined';
const webHistory = hasWindow && window.location.protocol !== 'file:';

let seq = 0;
const newId = (): string => `${Date.now().toString(36)}.${(seq++).toString(36)}`;
/** entry id → the offset its page was left at (this document's life) */
const saved = new Map<string, number>();

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
function entryOf(state: unknown): EntryState | null {
  const e = isObj(state) ? state[STATE_KEY] : null;
  return isObj(e) && typeof e.id === 'string' ? { id: e.id, y: typeof e.y === 'number' ? e.y : undefined } : null;
}
function writeEntry(e: EntryState): void {
  const st = window.history.state;
  window.history.replaceState({ ...(isObj(st) ? st : {}), [STATE_KEY]: e }, '');
}
/** the entry on screen, keyed now if a writer outside this module replaced its state */
function currentEntry(): EntryState {
  const e = entryOf(window.history.state);
  if (e) return e;
  const fresh = { id: newId() };
  writeEntry(fresh);
  return fresh;
}

/** the shell's scroller: `.ds-app` (html and body are `overflow: hidden` for the game canvas) */
const shell = (): HTMLElement | null => (hasWindow ? document.querySelector<HTMLElement>('.ds-app') : null);

/** the entry the page on screen belongs to */
let shownId: string | null = null;
/** how the next commit arrives, and for which entry (a stale one is ignored) */
let pending: { a: Arrival; id: string | null } | null = null;

if (webHistory) {
  shownId = currentEntry().id;
  const nav = performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined;
  const back = nav?.type === 'back_forward';
  pending = {
    a: { kind: 'load', y: back ? (entryOf(window.history.state)?.y ?? null) : null, anchor: anchorOf(window.location.hash) },
    id: shownId,
  };
  // the browser's own restoration has nothing to restore (the window never scrolls) and must not try
  if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';
  // CAPTURE, and registered at module load: this runs before App's own `popstate` listener, whose state
  // update React may commit in the microtask after it, so the page being left is still the one on screen
  window.addEventListener(
    'popstate',
    () => {
      const e = entryOf(window.history.state);
      // a synthetic popstate (`net/env.ts` asking App to re-read the address) is not a move
      if (e && e.id === shownId) return;
      const app = shell();
      if (app && shownId) saved.set(shownId, app.scrollTop);
      shownId = e?.id ?? null;
      pending = {
        a: { kind: 'pop', y: e ? (saved.get(e.id) ?? e.y ?? null) : null, anchor: anchorOf(window.location.hash) },
        id: shownId,
      };
    },
    true,
  );
  // a document that is unloaded keeps its offset in its own entry, for a Back into it later
  window.addEventListener('pagehide', () => {
    const app = shell();
    if (app) writeEntry({ ...currentEntry(), y: app.scrollTop });
  });
}

/** NAVIGATE: a new history entry. The page being left keeps its offset for Back. */
export function pushRoute(url: string): void {
  if (!webHistory) return;
  const cur = currentEntry();
  const app = shell();
  if (app) {
    saved.set(cur.id, app.scrollTop);
    writeEntry({ ...cur, y: app.scrollTop });
  }
  const next = { id: newId() };
  window.history.pushState({ [STATE_KEY]: next }, '', url);
  shownId = next.id;
}

/** the same entry at another address (canonicalising, a filter, a hash): its key and offset are kept */
export function replaceRoute(url: string): void {
  if (!webHistory) return;
  const st = window.history.state;
  window.history.replaceState(isObj(st) ? st : null, '', url);
  shownId = currentEntry().id;
}

/** declare how the NEXT page lands: at `anchor`, or at the top when the address did not change */
export function arrive(anchor: string | null, again: boolean): void {
  pending = anchor || again ? { a: { kind: 'navigate', anchor, again }, id: shownId } : null;
}

function take(): Arrival | null {
  const p = pending;
  pending = null;
  return p && (!webHistory || p.id === shownId) ? p.a : null;
}

// ---- landing ---------------------------------------------------------------------------------------

/** what a player does to take the scroll back from a restore or an anchor still waiting */
const TAKEOVER = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
let stopWait: (() => void) | null = null;

/** run `step` now and then every 50 ms until it says done, `ms` pass, or the player takes over.
 *  `setTimeout`, not rAF: a hidden or backgrounded tab runs no frames, and the wait is "after React
 *  has committed and the data has come", not "before the next paint". */
function waitFor(step: () => boolean, ms: number): void {
  stopWait?.();
  if (step()) return;
  const t0 = Date.now();
  let timer = 0;
  const stop = (): void => {
    window.clearTimeout(timer);
    TAKEOVER.forEach((ev) => window.removeEventListener(ev, stop, true));
    if (stopWait === stop) stopWait = null;
  };
  const tick = (): void => {
    if (step() || Date.now() - t0 > ms) stop();
    else timer = window.setTimeout(tick, 50);
  };
  TAKEOVER.forEach((ev) => window.addEventListener(ev, stop, { capture: true, passive: true }));
  stopWait = stop;
  timer = window.setTimeout(tick, 50);
}

/** the nearest element at or above `el` that scrolls vertically, else the shell */
export function scrollerOf(el: Element | null): HTMLElement | null {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && n instanceof HTMLElement) return n;
  }
  return shell();
}

/** where the visible area of `sc` starts: under the sticky bar when it is the shell */
function viewTop(sc: HTMLElement): number {
  const top = sc.getBoundingClientRect().top;
  const bar = sc.querySelector(':scope > .ds-bar');
  return bar ? Math.max(top, bar.getBoundingClientRect().bottom) : top;
}

/** every vertical scroller inside `root` (and `root` itself) back to its first row */
function zeroNested(root: Element, self: boolean): void {
  if (self && root.scrollTop > 0) root.scrollTop = 0;
  root.querySelectorAll('*').forEach((e) => {
    if (e.scrollTop > 0) e.scrollTop = 0;
  });
}

const findAnchor = (id: string): HTMLElement | null =>
  document.getElementById(id) ?? document.querySelector<HTMLElement>(`[data-anchor~="${id}"]`);

/** the element focus moves to on arrival */
function focusTo(target: HTMLElement): void {
  // never out of a dialog, a popup or the pad's keyboard (the set `PadNavLayer` traps focus in)
  const ae = document.activeElement;
  if (ae && ae !== document.body && ae.closest('[role="dialog"], .overlay, .ds-modal-backdrop, .net-overlay, .ds-osk, .ds-padmenu')) return;
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  // `[data-scroll-focus]:focus` takes no ring (shell.css): it is a place, not a control
  target.setAttribute('data-scroll-focus', '');
  target.focus({ preventScroll: true });
}
const pageFocus = (region: HTMLElement): HTMLElement =>
  region.querySelector<HTMLElement>('[data-page-focus]') ?? region.querySelector<HTMLElement>('h1') ?? region.querySelector<HTMLElement>('h2') ?? region;

/** apply a landing to the shell's scroller; `region` is the page (`<main>`) */
function land(sc: HTMLElement, region: HTMLElement | null, l: Landing, focus: boolean): void {
  if (l.kind === 'stay') return;
  stopWait?.();
  if (l.kind === 'restore') {
    const y = l.y;
    // content still arriving (a board, a lazy section) cannot hold the offset yet: keep trying
    waitFor(() => {
      sc.scrollTop = y;
      return Math.abs(sc.scrollTop - y) <= 1;
    }, RESTORE_WAIT_MS);
  } else {
    // a scroller nested in the page that survived the change (the same component, new props) too.
    // A page that positions its own list does it in a passive effect, which runs after this one.
    sc.scrollTop = 0;
    if (region) zeroNested(region, false);
  }
  if (l.kind === 'anchor') {
    const id = l.id;
    waitFor(() => {
      const el = findAnchor(id);
      if (!el) return false;
      const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || viewTop(sc) - sc.getBoundingClientRect().top + ANCHOR_GAP;
      sc.scrollTop += anchorDelta(el.getBoundingClientRect().top, sc.getBoundingClientRect().top, margin);
      if (focus) focusTo(el);
      return true;
    }, ANCHOR_WAIT_MS);
    return;
  }
  if (focus && region) focusTo(pageFocus(region));
}

/**
 * THE SHELL'S HOOK (`AppShell`): `page` is which page App shows (`scrollPage` in App.tsx: the screen
 * and the route part that replaces the content, never a filter). Runs after every commit, before
 * paint, so a new page is never drawn at the old offset.
 */
export function useRouteScroll(app: RefObject<HTMLElement>, main: RefObject<HTMLElement>, page: string): void {
  const last = useRef<string | null>(null);
  useLayoutEffect(() => {
    const sc = app.current;
    if (!sc) return;
    const firstMount = last.current === null;
    const changed = !firstMount && last.current !== page;
    last.current = page;
    const a = take();
    if (!changed && !a) return;
    const l = landing(changed || firstMount, a);
    land(sc, main.current, l, focusMoves(l, a, firstMount));
  });
}

/**
 * AN IN-PAGE TAB STRIP that replaces the content without a route (rule 1): when `key` changes the page
 * goes to its top and the region's scrollers to theirs. `focus` false for an ARIA tablist, whose
 * pattern keeps focus on the tab (the console's). `null` is "not shown yet": the first key after it
 * (a restored draft opening on its third step) is where the page starts, not a change.
 */
export function usePageTop(key: string | number | null, region: RefObject<HTMLElement>, focus = true): void {
  const last = useRef(key);
  useLayoutEffect(() => {
    if (last.current === key) return;
    const from = last.current;
    last.current = key;
    if (from === null || key === null) return;
    const el = region.current;
    const sc = scrollerOf(el?.parentElement ?? null);
    if (!el || !sc) return;
    stopWait?.();
    sc.scrollTop = 0;
    zeroNested(el, true);
    if (focus) focusTo(pageFocus(el));
  }, [key, region, focus]);
}

/**
 * A LIST WHOSE ROWS A CONTROL REPLACES (rule 4): a filter, a board, Prev/Next. `list` is its panel; its
 * rows are the first `table`, `[data-list-rows]`, or the list's empty or loading state in it (the panel
 * itself when it has none). When `key` changes
 * the list's own scrollers go to its first row, and the page moves only if that first row is above the
 * visible area, bringing the panel's top back under the bar. Focus stays on the control.
 */
export function useListTop(key: string | number, list: RefObject<HTMLElement>): void {
  const last = useRef(key);
  useLayoutEffect(() => {
    if (last.current === key) return;
    last.current = key;
    const el = list.current;
    const sc = scrollerOf(el?.parentElement ?? null);
    if (!el || !sc) return;
    zeroNested(el, true);
    const rows = el.querySelector('table, [data-list-rows], .ds-empty, .ds-loading') ?? el;
    const d = revealDelta(el.getBoundingClientRect().top, rows.getBoundingClientRect().top, viewTop(sc));
    if (d) sc.scrollTop += d;
  }, [key, list]);
}
