/**
 * IS THIS KEYSTROKE GOING INTO A TEXT FIELD?
 *
 * The game listens on `window`, so every keystroke anywhere on the page reached the robot —
 * including the ones being typed into the post-match report's "what happened" box. Two
 * things went wrong at once there: the letters bound to actions fired those actions while
 * you typed, and SPACE (always in `preventKeys`, so the page does not scroll under a driver)
 * had its default suppressed, which means the space bar did not type a space at all.
 * "I can't type properly in the report a player menu because some keys are counted as game
 * control."
 *
 * A field with focus owns the keyboard. That is the whole rule, and it is the browser's own:
 * text inputs, textareas, selects and anything contenteditable. Buttons and checkboxes are
 * NOT typing — a driver tabbing onto a HUD button should still be able to drive.
 */
function typingInto(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
  return !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image'].includes(
    type,
  );
}

/**
 * THE SHIFTED CHARACTER EACH DIGIT AND PUNCTUATION KEY TYPES ON A US LAYOUT (`KeyboardEvent.code` →
 * [unshifted, shifted]). Shift is the default Intake, so the driver holding it presses `;` (Reverse)
 * or `'` (the NECTAR bar) and the browser reports `:` and `"`, which no bind names: both did nothing
 * until Shift was let go. Binds are the unshifted character, so a press that arrives as the shifted
 * one is also registered as the key it was printed on.
 *
 * Only an event whose `key` IS the shifted character of its `code` is rewritten. On any other layout
 * `code` names a different character (German `Semicolon` is `ö`), so a `key` that does not match
 * the US pair is left exactly as it came: that layout keeps today's behaviour and never gains a
 * phantom `;`.
 */
const US_SHIFT: Readonly<Record<string, readonly [string, string]>> = {
  Digit1: ['1', '!'],
  Digit2: ['2', '@'],
  Digit3: ['3', '#'],
  Digit4: ['4', '$'],
  Digit5: ['5', '%'],
  Digit6: ['6', '^'],
  Digit7: ['7', '&'],
  Digit8: ['8', '*'],
  Digit9: ['9', '('],
  Digit0: ['0', ')'],
  Minus: ['-', '_'],
  Equal: ['=', '+'],
  BracketLeft: ['[', '{'],
  BracketRight: [']', '}'],
  Backslash: ['\\', '|'],
  Semicolon: [';', ':'],
  Quote: ["'", '"'],
  Comma: [',', '<'],
  Period: ['.', '>'],
  Slash: ['/', '?'],
  Backquote: ['`', '~'],
};

const LATIN_SCRIPT = /\p{Script=Latin}/u;

/**
 * THE LATIN LETTER OR DIGIT A KEY ON A NON-LATIN LAYOUT IS PRINTED AS. `key` follows the active
 * layout, so on a Russian, Greek, Hebrew, Arabic or Korean layout the W key reports `ц`, `ω`, ...
 * and every letter bind (WASD) was dead. `code` is the physical key, and the binds are named after
 * the US legend, so a lone non-Latin character on a `KeyX` or `DigitN` code stands for that letter.
 *
 * It rewrites nothing that is already Latin: an ASCII `key` (QWERTY, AZERTY, Dvorak, Colemak, and
 * Shift+digit's `!`) and any other Latin-script character (Turkish `ı`, Czech `ě` on a digit key)
 * return null, so a Latin layout keeps exactly the keys it always had. `Dead`, `Process` and
 * `Unidentified` are longer than one character and return null too.
 */
export function latinOf(key: string, code: string | undefined): string | null {
  if (!code || key.length !== 1 || key.charCodeAt(0) < 128 || LATIN_SCRIPT.test(key)) return null;
  const m = /^Key([A-Z])$/.exec(code) ?? /^Digit([0-9])$/.exec(code);
  return m ? m[1].toLowerCase() : null;
}

/** the key a rebind is stored as: layout-independent where `latinOf` can say, else the lowercased `key` */
export function canonicalKey(key: string, code: string | undefined): string {
  return latinOf(key, code) ?? key.toLowerCase();
}

/**
 * every lowercased key one keystroke stands for: its own `key`, plus the unshifted one when Shift
 * turned it, plus the Latin letter a non-Latin layout hides (`latinOf`). The native key stays in
 * the list, so a bind already stored as `ц` keeps working.
 */
export function keysOfStroke(key: string, code: string | undefined): string[] {
  const k = key.toLowerCase();
  const pair = code ? US_SHIFT[code] : undefined;
  const keys = pair && key === pair[1] ? [k, pair[0]] : [k];
  const latin = latinOf(key, code);
  if (latin !== null && !keys.includes(latin)) keys.push(latin);
  return keys;
}

/** tracks held keys and edge-triggered presses */
export class Keyboard {
  private down = new Set<string>();
  private pressed = new Set<string>();
  /** keys whose browser default (scroll etc.) is suppressed — kept in sync
   * with the active bindings so any bound key works cleanly */
  private preventKeys = new Set<string>([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);

  setPreventKeys(keys: Iterable<string>): void {
    this.preventKeys = new Set([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
    for (const k of keys) this.preventKeys.add(k);
  }

  /**
   * WHICH KEY EACH PHYSICAL KEY WENT DOWN AS (`KeyboardEvent.code` → the lowercased `key`).
   *
   * Bindings are by `key`, and `key` is not stable across one press: it depends on the
   * modifiers held AT THAT MOMENT. Shift is the default intake, so pressing `1`, then holding
   * Shift and letting go of `1` produced a keyup for `!` — and `1` stayed held, driving or
   * firing, until the window lost focus. The same happens to any digit or punctuation bind and
   * to a keyboard-layout switch mid-press. The release is therefore matched by the PHYSICAL key,
   * and falls back to `key` only for an event that carries no `code`.
   *
   * It holds a LIST because one press can stand for two keys: Shift turns `;` into `:`, and the
   * press is held as both (`keysOfStroke`). The release lets go of every one of them, whichever
   * of the two the keyup arrives as (Shift let go first, or pressed after the key).
   */
  private codeKey = new Map<string, string[]>();
  /**
   * keys that went down while ⌘ was held. macOS sends NO keyup for a key released while Meta is
   * down, so these are let go when Meta is — the only release they will ever get.
   */
  private underMeta = new Set<string>();

  private releaseAll(): void {
    this.down.clear();
    this.pressed.clear();
    this.codeKey.clear();
    this.underMeta.clear();
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (typingInto(e.target)) {
      // ...and anything already held is RELEASED, so clicking into a field mid-drive does not
      // leave the robot pinned on the last key down (the same reason `onBlur` clears).
      this.releaseAll();
      return;
    }
    const keys = keysOfStroke(e.key, e.code);
    // a repeat of a press that was already registered as a pair must not drop the unshifted half
    // (Shift went down after the key, so the first press was `;` and this one is `:`): merge
    const held = e.code ? this.codeKey.get(e.code) : undefined;
    const all = held ? [...new Set([...held, ...keys])] : keys;
    for (const k of keys) {
      if (!e.repeat) this.pressed.add(k);
    }
    for (const k of keys) this.down.add(k);
    if (e.code) this.codeKey.set(e.code, all);
    for (const k of keys) if (e.metaKey && k !== 'meta') this.underMeta.add(k);
    if (keys.some((k) => this.preventKeys.has(k))) {
      e.preventDefault();
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    // NOT guarded by `typingInto`: a key can go down on the field and come up somewhere else
    // (or the other way round), and a release must always be honoured — the failure mode of
    // missing one is a key stuck down forever.
    const k = e.key.toLowerCase();
    const wentDownAs = e.code ? this.codeKey.get(e.code) : undefined;
    if (e.code) this.codeKey.delete(e.code);
    // the keyup's own `key` (and its unshifted twin) as well as everything the press went down as
    for (const j of [...keysOfStroke(e.key, e.code), ...(wentDownAs ?? [])]) {
      this.down.delete(j);
      this.underMeta.delete(j);
    }
    if (k === 'meta') {
      for (const held of this.underMeta) this.down.delete(held);
      this.underMeta.clear();
    }
  };

  /** focus moving INTO a field releases everything, so a held key does not survive the
   * transition — you click the box while driving forward and the robot stops. */
  private onFocusIn = (e: FocusEvent): void => {
    if (!typingInto(e.target)) return;
    this.releaseAll();
  };

  /**
   * IS THIS WINDOW EVEN GETTING THE KEYSTROKES?
   *
   * `onBlur` has always KNOWN the answer — it is the moment every held key has to be let go,
   * because no keyup is ever coming — and nothing ever said so out loud. Embedded as a Discord
   * Activity the game is a cross-origin iframe sitting next to a chat box, and clicking that
   * chat box is the entire point of the surrounding app. A driver who typed "ready" there
   * before the host pressed START is pulled into a live match without a click of their own:
   * the sim keeps stepping, they press W, the W lands in Discord's message field and their
   * robot sits still with nothing on screen to explain it. They lose believing the sim broke.
   * On the web the same state costs a deliberate alt-tab and moves a whole window, so it reads
   * as what it is; in an iframe it is one click away and invisible.
   *
   * So the edge is kept as STATE, read through `hasFocus()` by the 10 Hz HUD poll, which is
   * what renders the one sentence that fixes it. No new mechanism and no polling: it is the
   * blur the class already listened for, plus its other half.
   */
  private focused = true;

  /** true while this window is the one receiving keystrokes (see `focused`) */
  hasFocus(): boolean {
    return this.focused;
  }

  private onBlur = (): void => {
    this.focused = false;
    this.down.clear();
    this.codeKey.clear();
    this.underMeta.clear();
  };

  /** the other half of `onBlur`: the keyboard is ours again, so the HUD's notice goes away */
  private onFocus = (): void => {
    this.focused = true;
  };

  attach(): void {
    // SEED FROM THE DOCUMENT, because the blur that matters most may have happened long before
    // this object existed — a non-host never clicks into the match at all, so there is no event
    // left to catch. An unknown answer (the headless smoke run, any non-browser host) reads as
    // FOCUSED on purpose: a notice shown to somebody whose keys are already working is worse
    // than no notice at all.
    this.focused =
      typeof document === 'undefined' || typeof document.hasFocus !== 'function'
        ? true
        : document.hasFocus();
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('focus', this.onFocus);
    window.addEventListener('focusin', this.onFocusIn);
  }

  detach(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('focus', this.onFocus);
    window.removeEventListener('focusin', this.onFocusIn);
  }

  held(key: string): boolean {
    return this.down.has(key);
  }

  /** true once per physical key press; consumed on read */
  justPressed(key: string): boolean {
    if (this.pressed.has(key)) {
      this.pressed.delete(key);
      return true;
    }
    return false;
  }

  /** drop un-consumed presses at the end of the frame */
  endFrame(): void {
    this.pressed.clear();
  }
}
