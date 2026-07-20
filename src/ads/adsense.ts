/**
 * Google AdSense integration — the single place that decides whether ads run.
 *
 * Everything is OPT-IN through env: with `VITE_ADSENSE_CLIENT` unset (the default,
 * and the state of every build until the AdSense application is approved) nothing
 * here loads, no script tag is injected, and `<AdSlot>` renders nothing. That keeps
 * the ad layer completely dormant rather than half-live.
 *
 * Three hard rules encoded here, each of which is a policy violation if broken:
 *
 *  1. NEVER in the desktop build. AdSense does not permit serving inside a
 *     non-browser application wrapper, and an Electron shell is exactly that.
 *  2. NEVER on touch devices. Not a policy rule but a product one — the compact
 *     mobile layout has no free space, and the field would have to shrink.
 *  3. NEVER for supporters. Removing ads is the headline membership benefit, so
 *     the gate has to exist from the first commit rather than be retrofitted.
 *
 * Rule 3 is reactive (it resolves asynchronously after sign-in) and so lives in
 * `AdsProvider`, not here. This module owns only the static facts.
 */

/** publisher id, e.g. `ca-pub-1234567890123456`. Absent ⇒ ads are fully off. */
const CLIENT = (import.meta.env.VITE_ADSENSE_CLIENT as string | undefined)?.trim() || '';

/** per-unit slot ids, created in the AdSense dashboard. Absent ⇒ that unit is off. */
const SLOT_GAME = (import.meta.env.VITE_ADSENSE_SLOT_GAME as string | undefined)?.trim() || '';
const SLOT_MENU = (import.meta.env.VITE_ADSENSE_SLOT_MENU as string | undefined)?.trim() || '';

export const ADSENSE_CLIENT = CLIENT;

/** the ad units we run. `game` flanks the field; `menu` sits on shell pages. */
export type AdUnit = 'game' | 'menu';

export function slotFor(unit: AdUnit): string {
  return unit === 'game' ? SLOT_GAME : SLOT_MENU;
}

/**
 * Running inside the Electron desktop shell? Checked two ways because each alone
 * is fragile: the user-agent string is the direct signal, and a relative BASE_URL
 * is what `vite.config.ts` sets when `ELECTRON=1` (so it holds even if Electron
 * ever stops advertising itself).
 */
export function isElectron(): boolean {
  if (typeof navigator !== 'undefined' && /electron/i.test(navigator.userAgent)) return true;
  return import.meta.env.BASE_URL === './';
}

/** a coarse pointer means the compact layout, which has no room to give away */
function isTouch(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

/**
 * Can ads run in this build at all? Static only — it says nothing about whether
 * the current user is a supporter (see `AdsProvider`).
 */
export function adsConfigured(): boolean {
  return !!CLIENT && !isElectron() && !isTouch();
}

declare global {
  interface Window {
    adsbygoogle?: unknown[];
  }
}

let loading: Promise<void> | null = null;

/**
 * Inject the AdSense script, at most once per page.
 *
 * Deliberately lazy: this is never called at boot. The sim runs a 60 Hz rAF loop
 * against a Rapier physics step, and pulling a third-party script into startup
 * costs frames on exactly the surface the whole product is judged on. The script
 * loads when the first slot mounts and not before.
 *
 * A failed load resolves rather than rejects — no ad is a cosmetic problem, and it
 * must never surface as an error to someone trying to drive.
 */
export function ensureAdSenseLoaded(): Promise<void> {
  if (!adsConfigured()) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise<void>((resolve) => {
    const existing = document.querySelector('script[data-dsim-adsense]');
    if (existing) return resolve();
    const s = document.createElement('script');
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.dataset.dsimAdsense = '1';
    s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(CLIENT)}`;
    s.onload = () => resolve();
    s.onerror = () => resolve(); // blocked or offline — degrade silently
    document.head.appendChild(s);
  });
  return loading;
}

/**
 * Hand a mounted `<ins>` to AdSense. Safe to call more than once for the same
 * element: React StrictMode runs effects twice in development, and pushing the
 * same slot twice makes AdSense throw "already have ads in them".
 */
export function fillSlot(el: HTMLElement): void {
  if (el.dataset.adsbygoogleStatus) return; // AdSense stamps this once filled
  try {
    (window.adsbygoogle = window.adsbygoogle || []).push({});
  } catch {
    /* blocked by an extension, or the script never arrived — leave the box empty */
  }
}
