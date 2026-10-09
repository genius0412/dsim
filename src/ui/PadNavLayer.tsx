import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import {
  OSK_DIGITS,
  OSK_LETTERS,
  PAD_GLYPHS,
  PAD_NAV_REPEAT,
  PAD_SLIDER_REPEAT,
  maskPadButtons,
  oskInit,
  oskReduce,
  padBackButton,
  padConfirmButton,
  padFamily,
  padNavPrefs,
  padNavSuspended,
  pickNav,
  repeatDueMs,
  subscribePadNavPrefs,
  wrapNav,
  type NavRect,
  type OskState,
  type PadFamily,
  type PadNavDir,
} from '../input/padNav';

/**
 * PAD NAVIGATION — the DOM half.
 *
 * ONE rAF loop for the whole app, mounted beside `<App/>` in `main.tsx`. It turns pad input into
 * NATIVE focus moves and NATIVE activation on the real DOM: nothing here keeps a parallel
 * selection, so everything that is keyboard-reachable is pad-reachable, and the holes it forces
 * shut are accessibility holes. `src/input/padNav.ts` holds every rule that can be tested
 * without a browser; this file is the wiring.
 *
 * It polls ONLY while a pad is connected (`gamepadconnected` arms it, `gamepaddisconnected`
 * disarms it), so a touch device or a mouse-only desktop runs nothing.
 *
 * ⚠️ IT STANDS DOWN COMPLETELY WHILE SUSPENDED. `GameView` holds `'match'` for its whole mount
 * and the Controls screen holds `'capture'` while a rebind is armed — see `padNavSuspended`. The
 * only thing the loop still does under a suspension is watch the MENU button, and only while the
 * reason is `'match'`: that is how a driver gets back out.
 */

export const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** surfaces that TRAP focus while they are up — a modal is not a thing to navigate out of */
const TRAP = '.ds-osk, .ds-modal-backdrop, .overlay, .net-overlay, .ds-padmenu';

const TEXTY = new Set(['text', 'search', 'email', 'password', 'url', 'tel', 'number']);

const isTextField = (el: Element | null): el is HTMLInputElement | HTMLTextAreaElement => {
  if (!el) return false;
  if (el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && TEXTY.has((el as HTMLInputElement).type);
};

const isRange = (el: Element | null): el is HTMLInputElement =>
  !!el && el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'range';

/** React listens to the NATIVE `input` event through its own value tracker, so a value written
 *  straight onto the element is silently swallowed. Go through the prototype setter. */
function setNativeValue(el: HTMLInputElement, value: string): void {
  const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
  if (desc?.set) desc.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

const visible = (el: HTMLElement): boolean => {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  if (el.closest('[aria-hidden="true"]')) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none';
};

/** the innermost scrollable ancestor, or null for the document */
function scroller(el: Element | null): HTMLElement | null {
  let n: HTMLElement | null = el as HTMLElement | null;
  while (n && n !== document.body) {
    const cs = getComputedStyle(n);
    if (/(auto|scroll|overlay)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 2) return n;
    n = n.parentElement;
  }
  return null;
}

/** everything focusable inside the current scope (the topmost trap, or the document) */
function candidates(): { els: HTMLElement[]; rects: NavRect[]; scope: HTMLElement | null } {
  const traps = document.querySelectorAll<HTMLElement>(TRAP);
  const scope = traps.length ? traps[traps.length - 1] : null;
  const root: ParentNode = scope ?? document;
  const els: HTMLElement[] = [];
  const rects: NavRect[] = [];
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    els.push(el);
    rects.push({ x: r.left, y: r.top, w: r.width, h: r.height });
  }
  return { els, rects, scope };
}

/** the closest focusable to the middle of the viewport — where focus lands when nothing has it */
function firstTarget(els: HTMLElement[], rects: NavRect[]): number {
  if (!els.length) return -1;
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 3;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const d = Math.hypot(r.x + r.w / 2 - cx, r.y + r.h / 2 - cy);
    if (d < bestD) {
      best = i;
      bestD = d;
    }
  }
  return best;
}

const focusAt = (el: HTMLElement): void => {
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
};

/** the in-match menu's opener, registered by `GameView` while it is mounted */
let menuHandler: (() => void) | null = null;
export function setPadMenuHandler(fn: (() => void) | null): void {
  menuHandler = fn;
}

interface Held {
  /** when this direction/button went down */
  since: number;
  /** how many times it has fired, the press included */
  fires: number;
}

export function PadNavLayer(): JSX.Element | null {
  const prefs = useSyncExternalStore(subscribePadNavPrefs, padNavPrefs, padNavPrefs);
  const [connected, setConnected] = useState(false);
  const [family, setFamily] = useState<PadFamily>('generic');
  /** is a PAD the active input right now? drives the focus ring and the legend, so a mouse user
   *  never sees either. Cleared by any pointer move. */
  const [padActive, setPadActive] = useState(false);
  const [osk, setOsk] = useState<OskState | null>(null);
  const oskTarget = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  // ---- connection ------------------------------------------------------------------
  useEffect(() => {
    const scan = (): void => {
      const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];
      const pad = pads.find((p) => p && p.connected) ?? null;
      setConnected(!!pad);
      if (pad) setFamily(padFamily(pad.id));
    };
    scan();
    const on = (): void => scan();
    window.addEventListener('gamepadconnected', on);
    window.addEventListener('gamepaddisconnected', on);
    return () => {
      window.removeEventListener('gamepadconnected', on);
      window.removeEventListener('gamepaddisconnected', on);
    };
  }, []);

  // a mouse takes the modality back, so the ring and the legend disappear for a mouse user
  useEffect(() => {
    if (!padActive) return;
    const off = (): void => setPadActive(false);
    window.addEventListener('pointerdown', off);
    window.addEventListener('pointermove', off, { once: true });
    return () => {
      window.removeEventListener('pointerdown', off);
      window.removeEventListener('pointermove', off);
    };
  }, [padActive]);

  useEffect(() => {
    const on = padActive && connected && prefs.navEnabled;
    if (on) document.documentElement.dataset.padnav = 'on';
    else delete document.documentElement.dataset.padnav;
    return () => {
      delete document.documentElement.dataset.padnav;
    };
  }, [padActive, connected, prefs.navEnabled]);

  const closeOsk = useCallback((commit: boolean) => {
    const t = oskTarget.current;
    oskTarget.current = null;
    setOsk(null);
    if (t) {
      if (!commit) t.blur();
      window.setTimeout(() => t.focus({ preventScroll: true }), 0);
    }
  }, []);

  // ---- the loop --------------------------------------------------------------------
  const oskRef = useRef<OskState | null>(null);
  oskRef.current = osk;

  useEffect(() => {
    if (!connected || !prefs.navEnabled) return;
    let raf = 0;
    const held = new Map<string, Held>();
    let prevButtons: boolean[] = [];

    /** fire on the press and then on the repeat schedule, for a key that is down */
    const edge = (key: string, down: boolean, now: number, profile = PAD_NAV_REPEAT): boolean => {
      if (!down) {
        held.delete(key);
        return false;
      }
      const h = held.get(key);
      if (!h) {
        held.set(key, { since: now, fires: 1 });
        return true;
      }
      if (now - h.since >= repeatDueMs(h.fires, profile)) {
        h.fires++;
        return true;
      }
      return false;
    };

    const move = (dir: PadNavDir): void => {
      const { els, rects, scope } = candidates();
      if (!els.length) return;
      const active = document.activeElement as HTMLElement | null;
      let from = active ? els.indexOf(active) : -1;
      if (from < 0) {
        const at = firstTarget(els, rects);
        if (at >= 0) focusAt(els[at]);
        return;
      }
      let to = pickNav(rects, from, dir);
      if (to < 0) {
        // nothing that way: scroll first, and only wrap inside a container that is a LIST
        const sc = scroller(els[from]);
        if ((dir === 'up' || dir === 'down') && sc) {
          const by = dir === 'down' ? 120 : -120;
          const before = sc.scrollTop;
          sc.scrollTop += by;
          if (sc.scrollTop !== before) return;
        }
        const group = els[from].closest('[data-padnav-group], [role="tablist"], .ds-segs');
        const box = group ?? scope;
        if (!box) return;
        const inBox = els.map((e, i) => (box.contains(e) ? i : -1)).filter((i) => i >= 0);
        if (inBox.length < 2) return;
        const sub = inBox.map((i) => rects[i]);
        const w = wrapNav(sub, inBox.indexOf(from), dir);
        if (w < 0) return;
        to = inBox[w];
      }
      focusAt(els[to]);
    };

    const adjust = (el: HTMLInputElement, sign: number): void => {
      const step = Number(el.step && el.step !== 'any' ? el.step : 1) || 1;
      const min = el.min === '' ? 0 : Number(el.min);
      const max = el.max === '' ? 100 : Number(el.max);
      const next = Math.min(max, Math.max(min, Number(el.value) + sign * step));
      if (next !== Number(el.value)) setNativeValue(el, String(next));
    };

    const activate = (): void => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) {
        const { els, rects } = candidates();
        const at = firstTarget(els, rects);
        if (at >= 0) focusAt(els[at]);
        return;
      }
      if (isTextField(el)) {
        oskTarget.current = el;
        setOsk(oskInit(el.value));
        return;
      }
      if (isRange(el)) return; // ◄► adjusts it; A would be a second, silent way to do nothing
      el.click();
    };

    /** B: close the keyboard, then a modal, then an open fold, then leave the screen */
    const back = (): void => {
      if (oskRef.current) {
        closeOsk(false);
        return;
      }
      const traps = document.querySelectorAll<HTMLElement>(TRAP);
      const trap = traps.length ? traps[traps.length - 1] : null;
      if (trap) {
        const b = trap.querySelector<HTMLElement>('[data-padnav-back]') ?? trap.querySelector<HTMLElement>('.secondary, .ds-btn.ghost');
        if (b) {
          b.click();
          return;
        }
      }
      const active = document.activeElement as HTMLElement | null;
      const fold = active?.closest('details[open]') as HTMLDetailsElement | null;
      if (fold) {
        fold.open = false;
        const s = fold.querySelector('summary');
        if (s) focusAt(s as HTMLElement);
        return;
      }
      const backBtn = document.querySelector<HTMLElement>('[data-padnav-back], .ds-back');
      if (backBtn) {
        backBtn.click();
        return;
      }
      window.history.back();
    };

    const sectionStep = (delta: number): void => {
      // A SCREEN THAT NAMES ITS OWN SECTIONS (`[data-padnav-sections]`, the robot importer's step
      // rail) gets LB/RB over those alone. Without it the list below starts from the first lit
      // item in the document — the nav rail's — so RB from a control in the page body left the
      // screen for the next destination instead of going to the next step.
      const scoped = Array.from(document.querySelectorAll<HTMLElement>('[data-padnav-sections]')).find(visible);
      const sel = '.ds-rail-btn, .ds-subnav-btn, .ds-seg, .ds-tab';
      const list = scoped
        ? Array.from(scoped.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]')).filter(visible)
        : Array.from(document.querySelectorAll<HTMLElement>(sel)).filter(visible);
      if (list.length < 2) return;
      const active = document.activeElement as HTMLElement | null;
      let at = list.findIndex((e) => e === active);
      if (at < 0) at = list.findIndex((e) => e.classList.contains('on'));
      if (at < 0) at = 0;
      const next = list[(at + delta + list.length) % list.length];
      next.click();
      focusAt(next);
    };

    const press = (sel: string): void => {
      const el = document.querySelector<HTMLElement>(sel);
      if (el && visible(el)) {
        el.click();
        return;
      }
    };

    const poll = (): void => {
      raf = requestAnimationFrame(poll);
      const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];
      const pad = pads.find((p) => p && p.connected) ?? null;
      if (!pad) return;
      const now = performance.now();
      const btn = (i: number): boolean => {
        const b = pad.buttons[i];
        return !!b && (b.pressed || b.value > 0.5);
      };
      const rising = (i: number): boolean => btn(i) && !prevButtons[i];

      // THE MENU BUTTON is watched even while the layer is suspended for a match — it is the
      // way back out. Its press is MASKED so the drive path never sees it (`padNav.ts`).
      const menuBtn = prefs.menuButton;
      if (rising(menuBtn) && menuHandler) {
        const down: number[] = [];
        for (let i = 0; i < pad.buttons.length; i++) if (btn(i)) down.push(i);
        maskPadButtons(down);
        setPadActive(true);
        menuHandler();
        prevButtons = pad.buttons.map((_, i) => btn(i));
        return;
      }

      if (padNavSuspended()) {
        held.clear();
        prevButtons = pad.buttons.map((_, i) => btn(i));
        return;
      }

      const std = pad.mapping === 'standard';
      const confirm = padConfirmButton(family);
      const backB = padBackButton(family);
      const ax = (i: number): number => {
        const v = pad.axes[i] ?? 0;
        return Math.abs(v) < 0.5 ? 0 : v;
      };
      // D-pad on a standard pad, left stick everywhere
      const left = (std && btn(14)) || ax(0) < 0;
      const right = (std && btn(15)) || ax(0) > 0;
      const up = (std && btn(12)) || ax(1) < 0;
      const down = (std && btn(13)) || ax(1) > 0;

      const target = document.activeElement as HTMLElement | null;
      const slider = isRange(target) ? target : null;
      const hProfile = slider ? PAD_SLIDER_REPEAT : PAD_NAV_REPEAT;

      let acted = false;
      if (edge('left', left, now, hProfile)) {
        acted = true;
        if (slider) adjust(slider, -1);
        else move('left');
      }
      if (edge('right', right, now, hProfile)) {
        acted = true;
        if (slider) adjust(slider, 1);
        else move('right');
      }
      if (edge('up', up, now)) {
        acted = true;
        move('up');
      }
      if (edge('down', down, now)) {
        acted = true;
        move('down');
      }
      if (rising(confirm)) {
        acted = true;
        activate();
      }
      if (rising(backB)) {
        acted = true;
        back();
      }
      if (std) {
        if (rising(4)) {
          acted = true;
          sectionStep(-1);
        }
        if (rising(5)) {
          acted = true;
          sectionStep(1);
        }
        if (rising(2)) {
          acted = true;
          press('[data-padnav-secondary], .ds-back, .ds-btn.ghost');
        }
        if (rising(3) || rising(9)) {
          acted = true;
          press('[data-padnav-primary], .ds-cta, .ds-btn.primary');
        }
        // right stick scrolls whatever the focus is inside of
        const ry = pad.axes[3] ?? 0;
        if (Math.abs(ry) > 0.25) {
          acted = true;
          const sc = scroller(document.activeElement);
          const by = ry * 18;
          if (sc) sc.scrollTop += by;
          else window.scrollBy(0, by);
        }
      }
      if (acted) setPadActive(true);
      prevButtons = pad.buttons.map((_, i) => btn(i));
    };

    raf = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(raf);
  }, [connected, prefs.navEnabled, prefs.menuButton, family, closeOsk]);

  if (!connected || !prefs.navEnabled) return null;
  const g = PAD_GLYPHS[family];
  return createPortal(
    <>
      {osk && (
        <PadKeyboard
          state={osk}
          glyphs={g}
          onAction={(a) => {
            setOsk((s) => {
              const t = oskTarget.current;
              const max = t && 'maxLength' in t && t.maxLength > 0 ? t.maxLength : 64;
              const next = s ? oskReduce(s, a, max) : s;
              if (next && t && next.value !== t.value) setNativeValue(t as HTMLInputElement, next.value);
              return next;
            });
          }}
          onDone={() => closeOsk(true)}
        />
      )}
      {padActive && !padNavSuspended() && !osk && (
        <div className="ds-padhint" role="note" aria-live="off">
          <span className="ds-key fixed">{g.confirm}</span> Select
          <span className="ds-key fixed">{g.back}</span> Back
          <span className="ds-key fixed">
            {g.lb}/{g.rb}
          </span>{' '}
          Section
        </div>
      )}
    </>,
    document.body,
  );
}

/**
 * The on-screen keyboard a text field gets when it is activated BY PAD. Ordinary buttons, so the
 * same layer navigates it and no second input model exists. It is a `TRAP`, so focus cannot
 * wander out of it into the page behind.
 */
function PadKeyboard({
  state,
  glyphs,
  onAction,
  onDone,
}: {
  state: OskState;
  glyphs: (typeof PAD_GLYPHS)[PadFamily];
  onAction: (a: Parameters<typeof oskReduce>[1]) => void;
  onDone: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>('button');
    first?.focus({ preventScroll: true });
  }, []);
  const chars = (state.layout === 'letters' ? OSK_LETTERS : OSK_DIGITS).split('');
  return (
    <div className="ds-osk" ref={ref} role="group" aria-label="On-screen keyboard">
      <div className="ds-osk-val" aria-live="polite">
        {state.value || ' '}
      </div>
      <div className="ds-osk-grid">
        {chars.map((c) => (
          <button key={c} className="ds-osk-key" onClick={() => onAction({ t: 'char', c })}>
            {state.caps ? c.toUpperCase() : c}
          </button>
        ))}
      </div>
      <div className="ds-osk-row">
        <button className={`ds-osk-key wide${state.caps ? ' on' : ''}`} aria-pressed={state.caps} onClick={() => onAction({ t: 'caps' })}>
          Caps
        </button>
        <button
          className="ds-osk-key wide"
          onClick={() => onAction({ t: 'layout', l: state.layout === 'letters' ? 'digits' : 'letters' })}
        >
          {state.layout === 'letters' ? '123' : 'abc'}
        </button>
        <button className="ds-osk-key wide" onClick={() => onAction({ t: 'space' })}>
          Space
        </button>
        <button className="ds-osk-key wide" onClick={() => onAction({ t: 'back' })}>
          Delete
        </button>
        <button className="ds-osk-key wide secondary" data-padnav-back onClick={onDone}>
          Done
        </button>
      </div>
      <div className="ds-osk-foot">
        <span className="ds-key fixed">{glyphs.confirm}</span> Type
        <span className="ds-key fixed">{glyphs.back}</span> Close
      </div>
    </div>
  );
}
