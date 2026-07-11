/**
 * Theme preference — light / dark / follow-the-OS.
 *
 * Deliberately NOT part of `GameSettings`:
 *  1. `GameSettings` round-trips through Postgres per account
 *     (`0003_profile_settings.sql`). A display preference should not follow you to a
 *     different machine with a different monitor, and must not require signing in.
 *  2. `loadSettings()` runs inside React, which mounts AFTER first paint — a theme read
 *     from there guarantees a flash of the wrong theme.
 *
 * So it lives in its own localStorage key, and the FIRST stamp happens in a blocking
 * inline script in `index.html` before the stylesheet loads. This module owns everything
 * after that. CSS only ever sees the two RESOLVED states (`data-theme="light|dark"`);
 * `'system'` is resolved here, so an explicit choice can override the OS without
 * duplicating the palette inside a `@media (prefers-color-scheme)` block.
 */
export const THEME_KEY = 'decodesim.theme';

export type ThemePref = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

/** keep in sync with `--ds-bg` in shell.css (light `:root` / dark `[data-theme]`) */
export const THEME_BG: Record<ResolvedTheme, string> = {
  light: '#f9faf7',
  dark: '#20262c',
};

const isPref = (v: unknown): v is ThemePref => v === 'system' || v === 'light' || v === 'dark';

const darkQuery = (): MediaQueryList | null =>
  typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

export function loadThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return isPref(v) ? v : 'system';
  } catch {
    return 'system'; // private mode / storage disabled
  }
}

export function resolveTheme(pref: ThemePref): ResolvedTheme {
  if (pref !== 'system') return pref;
  return darkQuery()?.matches ? 'dark' : 'light';
}

/** stamp the resolved theme on <html>; also drives the mobile browser chrome */
export function applyTheme(resolved: ResolvedTheme): void {
  document.documentElement.dataset.theme = resolved;
}

/**
 * Persist a preference, stamp it, and (re)arm the OS listener.
 *
 * The listener must exist ONLY while the pref is `'system'` — otherwise an OS theme
 * change would stomp an explicit choice. `setThemePref` is the single place that
 * arms/disarms it, so callers can't get that wrong.
 */
let stopListening: (() => void) | null = null;

export function setThemePref(pref: ThemePref): ResolvedTheme {
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* non-fatal: the theme still applies for this session */
  }

  stopListening?.();
  stopListening = null;

  if (pref === 'system') {
    const mq = darkQuery();
    if (mq) {
      const onChange = (e: MediaQueryListEvent): void => applyTheme(e.matches ? 'dark' : 'light');
      mq.addEventListener('change', onChange);
      stopListening = () => mq.removeEventListener('change', onChange);
    }
  }

  const resolved = resolveTheme(pref);
  applyTheme(resolved);
  return resolved;
}

/** call once at startup, after the inline script has already stamped the first paint */
export function initTheme(): ThemePref {
  const pref = loadThemePref();
  setThemePref(pref);
  return pref;
}
