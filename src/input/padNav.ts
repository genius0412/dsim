/**
 * PAD NAVIGATION — the DOM-free half.
 *
 * Everything here is pure or module-local state with no DOM, no clock and no `navigator`: the
 * geometry that picks the next focus target, the repeat clock behind a held direction, the
 * glyph set for a controller family, the on-screen keyboard's reducer, the SUSPEND registry
 * that stands the whole layer down, and the BUTTON MASK that keeps one press from being read
 * twice. `src/ui/PadNavLayer.tsx` is the half that touches focus.
 *
 * It is split this way because every rule below is a thing `npm test` can drive frame by frame
 * on synthetic rects and an injected clock — which is the only way to test spatial navigation
 * without a browser.
 */

// ---- geometry ---------------------------------------------------------------------

export type PadNavDir = 'up' | 'down' | 'left' | 'right';

/** a candidate's box in viewport pixels — `getBoundingClientRect()` reduced to what matters */
export interface NavRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const centreX = (r: NavRect): number => r.x + r.w / 2;
const centreY = (r: NavRect): number => r.y + r.h / 2;

/** how far apart two intervals are — 0 while they overlap */
const gap = (a0: number, a1: number, b0: number, b1: number): number => {
  if (a1 > b0 && b1 > a0) return 0;
  return a1 <= b0 ? b0 - a1 : a0 - b1;
};

/**
 * THE PICKER. Which rect is "the one in that direction" from `from`, or -1.
 *
 * A candidate qualifies when its CENTRE is strictly past the source's centre on the direction's
 * axis — one pixel of slack, so a row of tiles whose centres happen to line up is not a
 * candidate for itself. Among those, the winner minimises
 *
 *     alongDistance + 2 × crossGap
 *
 * where `crossGap` is ZERO while the two boxes overlap on the other axis. That one term is what
 * makes a ragged grid behave: moving down out of a narrow tile onto a row of wide ones picks
 * whatever is actually underneath it, not whatever happens to be nearest by straight-line
 * distance. Ties go to the smaller cross-centre offset, then to source order, so the answer is
 * deterministic for a layout with repeated geometry (a grid of identical tiles).
 */
export function pickNav(rects: readonly NavRect[], from: number, dir: PadNavDir): number {
  const f = rects[from];
  if (!f) return -1;
  const horiz = dir === 'left' || dir === 'right';
  const sign = dir === 'right' || dir === 'down' ? 1 : -1;
  const fAlong = horiz ? centreX(f) : centreY(f);
  const fCross = horiz ? centreY(f) : centreX(f);
  let best = -1;
  let bestScore = Infinity;
  let bestCross = Infinity;
  for (let i = 0; i < rects.length; i++) {
    if (i === from) continue;
    const c = rects[i];
    if (c.w <= 0 && c.h <= 0) continue;
    const cAlong = horiz ? centreX(c) : centreY(c);
    const delta = (cAlong - fAlong) * sign;
    if (delta <= 1) continue;
    const crossGap = horiz
      ? gap(f.y, f.y + f.h, c.y, c.y + c.h)
      : gap(f.x, f.x + f.w, c.x, c.x + c.w);
    const score = delta + 2 * crossGap;
    const crossOff = Math.abs((horiz ? centreY(c) : centreX(c)) - fCross);
    if (score < bestScore - 0.001 || (Math.abs(score - bestScore) <= 0.001 && crossOff < bestCross)) {
      best = i;
      bestScore = score;
      bestCross = crossOff;
    }
  }
  return best;
}

/**
 * WRAP within a container: the first or last rect along the direction's axis, used when
 * `pickNav` found nothing and the container is a list, a tablist or a modal's focus scope.
 * Moving right off the end of a `.ds-segs` strip lands on its first segment.
 */
export function wrapNav(rects: readonly NavRect[], from: number, dir: PadNavDir): number {
  if (rects.length < 2) return -1;
  const horiz = dir === 'left' || dir === 'right';
  const forward = dir === 'right' || dir === 'down';
  let best = -1;
  let bestAlong = forward ? Infinity : -Infinity;
  for (let i = 0; i < rects.length; i++) {
    if (i === from) continue;
    const a = horiz ? centreX(rects[i]) : centreY(rects[i]);
    if (forward ? a < bestAlong : a > bestAlong) {
      best = i;
      bestAlong = a;
    }
  }
  return best;
}

// ---- the repeat clock -------------------------------------------------------------

/**
 * A HELD DIRECTION REPEATS, and it accelerates — a long list is unusable at a fixed rate and a
 * short one overshoots at a fast one. `first` is the pause before the first repeat (so a tap is
 * one move), then the gap shrinks linearly from `start` to `min` over `ramp` repeats.
 */
export interface RepeatProfile {
  /** ms from the press to repeat #1 */
  first: number;
  /** the gap after repeat #1 */
  start: number;
  /** the floor the gap decays to */
  min: number;
  /** how many repeats the decay takes */
  ramp: number;
}

/** focus moves: slow enough to aim, fast enough to cross a long leaderboard */
export const PAD_NAV_REPEAT: RepeatProfile = { first: 420, start: 150, min: 40, ramp: 10 };
/** a slider: a 0..1 range in 100 steps has to be crossable without a sore thumb */
export const PAD_SLIDER_REPEAT: RepeatProfile = { first: 260, start: 90, min: 24, ramp: 14 };

/** the gap between repeat `i` and repeat `i + 1` (i is 1-based) */
const repeatGap = (i: number, p: RepeatProfile): number =>
  p.start + (p.min - p.start) * Math.min(1, Math.max(0, (i - 1) / p.ramp));

/**
 * How long after the press repeat `n` is due (n = 1 is the first repeat; the press itself fires
 * immediately and is not a repeat). Monotone in `n`, which is what lets the driver keep a plain
 * counter instead of a timestamp per fire.
 */
export function repeatDueMs(n: number, p: RepeatProfile = PAD_NAV_REPEAT): number {
  if (n <= 0) return 0;
  let t = p.first;
  for (let i = 1; i < n; i++) t += repeatGap(i, p);
  return t;
}

/** how many times a direction held for `heldMs` should have fired, the press included */
export function repeatCount(heldMs: number, p: RepeatProfile = PAD_NAV_REPEAT): number {
  let n = 0;
  while (repeatDueMs(n + 1, p) <= heldMs) n++;
  return n + 1;
}

// ---- controller families ----------------------------------------------------------

export type PadFamily = 'xbox' | 'playstation' | 'nintendo' | 'generic';

/**
 * Which glyph set to print, from `Gamepad.id`. The id is a free-form vendor string, so this is
 * patterns over the ones that actually appear — including the USB vendor ids, which is what a
 * browser falls back to for a pad it does not recognise (`054c` Sony, `045e` Microsoft,
 * `057e` Nintendo). Unknown stays `generic` rather than guessing Xbox: a wrong glyph is worse
 * than a neutral one, because the player trusts it and presses the wrong button.
 */
export function padFamily(id: string | null | undefined): PadFamily {
  const s = (id ?? '').toLowerCase();
  if (!s) return 'generic';
  if (/nintendo|switch|joy-?con|joycon|pro controller|057e/.test(s)) return 'nintendo';
  if (/playstation|dual ?shock|dual ?sense|sony|ps[345]\b|054c/.test(s)) return 'playstation';
  if (/xbox|x-?input|microsoft|045e/.test(s)) return 'xbox';
  return 'generic';
}

export interface PadGlyphs {
  confirm: string;
  back: string;
  secondary: string;
  primary: string;
  lb: string;
  rb: string;
  start: string;
}

export const PAD_GLYPHS: Record<PadFamily, PadGlyphs> = {
  xbox: { confirm: 'A', back: 'B', secondary: 'X', primary: 'Y', lb: 'LB', rb: 'RB', start: 'Menu' },
  playstation: { confirm: '✕', back: '○', secondary: '□', primary: '△', lb: 'L1', rb: 'R1', start: 'Options' },
  nintendo: { confirm: 'A', back: 'B', secondary: 'Y', primary: 'X', lb: 'L', rb: 'R', start: '+' },
  generic: { confirm: '1', back: '2', secondary: '3', primary: '4', lb: 'L1', rb: 'R1', start: 'Start' },
};

/**
 * WHICH BUTTON CONFIRMS, per family, and it is not always index 0.
 *
 * In the standard mapping index 0 is the BOTTOM face button and index 1 the RIGHT one. On an
 * Xbox or PlayStation pad the bottom one is confirm; on a Nintendo pad the RIGHT one is (its A),
 * and a Switch player pressing the bottom button expects to go back. Relabelling alone would
 * hand them a legend that says A and a layer that listens to B.
 */
export function padConfirmButton(f: PadFamily): number {
  return f === 'nintendo' ? 1 : 0;
}
export function padBackButton(f: PadFamily): number {
  return f === 'nintendo' ? 0 : 1;
}

/**
 * The default IN-MATCH MENU button: D-RIGHT.
 *
 * It is next to controls a thumb already knows. The default binds are fire 7/0, intake 6/1,
 * catalyst and place POLLEN 4, fling and pass 10, place NECTAR 12, nectar 14, ramp 11 (R3),
 * driveMode 5, flip 3, park 2, start 9, restart 8. D-DOWN (13) is unbound by default; it was the
 * ramp's until 2026-09-26.
 */
export const PAD_MENU_BUTTON = 15;

// ---- the suspend registry ---------------------------------------------------------

/**
 * THE LAYER STANDS DOWN COMPLETELY while anything holds a reason. Two hold one today:
 *
 *  · `'match'` — `GameView` is mounted. IN A MATCH THE PAD IS THE ROBOT'S: no focus moves, no
 *    synthetic clicks, nothing polled. The in-match menu releases it while it is open.
 *  · `'capture'` — the Controls screen has a rebind armed. Without this, A-to-activate would
 *    bind A to whatever row the player just opened, every time.
 *
 * A registry rather than a boolean because the two overlap (the in-match menu can be opened over
 * a match, and Controls can be reached from it), and a boolean would have the second release
 * undo the first.
 */
const suspended = new Set<string>();

export function suspendPadNav(reason: string): void {
  suspended.add(reason);
}
export function resumePadNav(reason: string): void {
  suspended.delete(reason);
}
export function padNavSuspended(): boolean {
  return suspended.size > 0;
}
export function padNavSuspendReasons(): string[] {
  return [...suspended].sort();
}
/** tests only — the registry is module state and a leaked reason would mute the next block */
export function resetPadNavSuspend(): void {
  suspended.clear();
}

// ---- the button mask ---------------------------------------------------------------

/**
 * ONE PRESS, ONE MEANING.
 *
 * The press that opens the in-match menu must not also be read as a drive input, and the press
 * that closes it must not fire a shot on the way out. Both are the chord resolver's rule 3 in a
 * different costume: a button that has already been spent is dead until it is RELEASED.
 *
 * `maskPadButtons` records everything held at the moment the menu opened or closed;
 * `applyPadMask` is run by `GamepadInput.sample` over the held list before the resolver sees it,
 * and drops a masked entry as soon as its button comes up. It is module state rather than a
 * field on `GamepadInput` because the two sides are different objects on different loops — the
 * pad-nav rAF sets it, the sim's input manager reads it.
 */
const masked = new Set<number>();

export function maskPadButtons(held: Iterable<number>): void {
  for (const i of held) masked.add(i);
}

/** the held list with every spent button removed, releasing any that are no longer down */
export function applyPadMask(held: readonly number[]): number[] {
  if (masked.size === 0) return held as number[];
  const down = new Set(held);
  for (const i of [...masked]) if (!down.has(i)) masked.delete(i);
  return masked.size === 0 ? (held as number[]) : held.filter((i) => !masked.has(i));
}

export function clearPadMask(): void {
  masked.clear();
}
export function padMaskSize(): number {
  return masked.size;
}

// ---- the two preferences, as a tiny store -------------------------------------------

/**
 * The pad-nav half of `PadBindings`, mirrored into module state so the LAYER can read it.
 *
 * The layer is mounted beside `<App/>` (it renders through a portal, so where it sits in the
 * tree is irrelevant, and every full-screen surface App returns early would otherwise have to
 * remember to include it). App owns the settings blob, so it pushes the two fields here instead.
 * Numbers and a boolean only — importing `PadBindings` as a value would close the cycle
 * `bindings.ts → padNav.ts`.
 */
export interface PadNavPrefs {
  menuButton: number;
  navEnabled: boolean;
}

let prefs: PadNavPrefs = { menuButton: PAD_MENU_BUTTON, navEnabled: true };
const prefSubs = new Set<() => void>();

export function setPadNavPrefs(p: PadNavPrefs): void {
  if (p.menuButton === prefs.menuButton && p.navEnabled === prefs.navEnabled) return;
  prefs = { menuButton: p.menuButton, navEnabled: p.navEnabled };
  for (const fn of prefSubs) fn();
}
export function padNavPrefs(): PadNavPrefs {
  return prefs;
}
export function subscribePadNavPrefs(fn: () => void): () => void {
  prefSubs.add(fn);
  return () => prefSubs.delete(fn);
}

// ---- the on-screen keyboard's reducer -----------------------------------------------

/**
 * A pad has no keys, so a text field activated BY PAD gets one drawn on the screen. The reducer
 * is here, DOM-free, because the interesting part is the edit semantics (caps is one-shot, the
 * cap is the field's own `maxLength`) and not the grid of buttons that calls it.
 */
export type OskLayout = 'letters' | 'digits';

export interface OskState {
  value: string;
  layout: OskLayout;
  /** one-shot shift: the next letter is upper case, then it releases */
  caps: boolean;
}

export type OskAction =
  | { t: 'char'; c: string }
  | { t: 'back' }
  | { t: 'space' }
  | { t: 'clear' }
  | { t: 'caps' }
  | { t: 'layout'; l: OskLayout }
  | { t: 'set'; value: string };

export const OSK_LETTERS = 'abcdefghijklmnopqrstuvwxyz';
export const OSK_DIGITS = '0123456789-_.';

export function oskInit(value: string): OskState {
  return { value, layout: 'letters', caps: false };
}

export function oskReduce(s: OskState, a: OskAction, maxLen = 64): OskState {
  switch (a.t) {
    case 'char': {
      if (s.value.length >= maxLen) return s.caps ? { ...s, caps: false } : s;
      const c = s.caps ? a.c.toUpperCase() : a.c;
      return { ...s, value: s.value + c, caps: false };
    }
    case 'space':
      if (s.value.length >= maxLen) return s;
      return { ...s, value: s.value + ' ' };
    case 'back':
      return { ...s, value: s.value.slice(0, -1) };
    case 'clear':
      return { ...s, value: '' };
    case 'caps':
      return { ...s, caps: !s.caps };
    case 'layout':
      return { ...s, layout: a.l };
    case 'set':
      return { ...s, value: a.value.slice(0, maxLen) };
  }
}
