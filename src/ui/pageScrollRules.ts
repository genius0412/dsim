/**
 * WHERE A NAVIGATION LANDS — the rules, DOM-free. `pageScroll.ts` is the DOM half; `npm test` checks
 * these ("page scroll:"), and `DSIM_SCROLL=only npm run shiftaudit` checks the app.
 *
 * Owner, 2026-11-04: "Clicking one of the settings menus (like 'Network') while I am on a different tab
 * (like 'Graphics') while being scrolled down, it does not bring me to the top of the page. Make sure
 * weird things like this dont happen for all other page transitions." The cause was structural: the
 * shell screens scroll inside `.ds-app`, not the window, and that element stays mounted across every
 * shell navigation, so a new page inherited the old one's offset (clamped to its own height). Measured
 * on the alpha build before the fix: 76 of 78 landings wrong.
 *
 * THE RULES
 *  1. NEW NAVIGATION LANDS AT THE TOP: a route change, a Configure section, a Records tab, a Profile
 *     page, a competition page, an in-page tab that replaces the content (the console, the importer's
 *     steps). The shell's scroller and every scroller nested in the page go to 0. Navigating to the
 *     address you are already on (a re-click) does the same.
 *  2. BACK AND FORWARD RESTORE the offset the page had when it was left, waiting for content that is
 *     still loading (`RESTORE_WAIT_MS`) unless the player scrolls first.
 *  3. AN ANCHOR WINS over the top: `navigate(…, anchor)` or a deep link's `#id` lands the element
 *     `ANCHOR_GAP` under the bar, waiting for it to render (`ANCHOR_WAIT_MS`).
 *  4. IN PLACE DOES NOT MOVE THE PAGE: a filter, a board pick, a select, a toggle, a fold, a game switch
 *     on the same page, a popup over Play. A list whose rows are replaced (a filter, Prev/Next) puts its
 *     OWN scroller at its first row, and moves the page only when that first row is above the visible
 *     area, bringing the list's top to just under the bar. "Load more" appends and moves nothing.
 *  5. FOCUS FOLLOWS: after a landing that changed the page, focus goes to the new page's
 *     `[data-page-focus]`, else its `h1`, else its region, with `preventScroll`; an anchor takes focus
 *     itself. Not on the first load, and never out of an open dialog or popup.
 *  6. INSTANT, ALWAYS. No smooth scrolling anywhere in this, so `prefers-reduced-motion` has nothing to
 *     turn off; a jump to a place the player asked for is not an animation they need.
 */

/** how long a Back waits for the page to grow tall enough to hold the offset it had */
export const RESTORE_WAIT_MS = 2500;
/** how long an anchor is waited for (an account's standing arrives after the session and a fetch) */
export const ANCHOR_WAIT_MS = 4000;
/** an anchor lands this far under the sticky bar (`.ds-standing`'s `scroll-margin-top` agrees) */
export const ANCHOR_GAP = 16;
/** a list revealed by rule 4 lands this far under the bar */
export const LIST_GAP = 8;

/** how the shell arrived at the page it is about to show */
export type Arrival =
  /** `navigate`: an anchor to land at, or `again` when the address did not change (a re-click) */
  | { kind: 'navigate'; anchor: string | null; again: boolean }
  /** Back or Forward: the entry's saved offset when it has one, and its address's anchor */
  | { kind: 'pop'; y: number | null; anchor: string | null }
  /** the document loaded: a deep link's anchor, or a Back into the document's saved offset */
  | { kind: 'load'; y: number | null; anchor: string | null };

export type Landing =
  | { kind: 'stay' }
  | { kind: 'top' }
  | { kind: 'restore'; y: number }
  | { kind: 'anchor'; id: string };

/** rules 1-4 for the shell: what a commit does to the scroller, given whether the PAGE changed */
export function landing(pageChanged: boolean, a: Arrival | null): Landing {
  if (a && a.kind !== 'navigate' && a.y != null && a.y > 0) return { kind: 'restore', y: a.y };
  if (a?.anchor) return { kind: 'anchor', id: a.anchor };
  if (pageChanged || (a?.kind === 'navigate' && a.again)) return { kind: 'top' };
  return { kind: 'stay' };
}

/** rule 5: does focus move into the page after this landing? `firstMount` is the shell's first commit */
export function focusMoves(l: Landing, a: Arrival | null, firstMount: boolean): boolean {
  if (l.kind === 'stay') return false;
  if (l.kind === 'anchor') return true;
  return !(firstMount && (!a || a.kind === 'load'));
}

/** a fragment that names an element: `#your-data`, not the console's `#tab=users&user=…` */
export function anchorOf(hash: string): string | null {
  let id = hash.replace(/^#/, '');
  try {
    id = decodeURIComponent(id);
  } catch {
    return null;
  }
  return /^[A-Za-z][\w-]{0,63}$/.test(id) ? id : null;
}

/**
 * Rule 4: how far to scroll when a list's rows were replaced. The list (its panel, with its controls) has
 * its top at `top` and its first row at `rowsTop`; the visible area starts at `viewTop` (one frame).
 * 0 while the first row shows, so a pick in the list's own head never nudges the page; otherwise the
 * panel's top comes back to `gap` under the bar.
 */
export function revealDelta(top: number, rowsTop: number, viewTop: number, gap = LIST_GAP): number {
  return rowsTop < viewTop - 0.5 ? top - viewTop - gap : 0;
}

/** rule 3: how far to scroll so an anchor at `top` lands `margin` under the scroller's top */
export function anchorDelta(top: number, scrollerTop: number, margin: number): number {
  return top - scrollerTop - margin;
}
