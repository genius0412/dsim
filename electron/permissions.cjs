/**
 * WHAT A PAGE IN THE DESKTOP SHELL MAY ASK THE SYSTEM FOR, AND WHAT IT MAY FETCH.
 *
 * Pure: no `require('electron')`, so `scripts/smoke.ts` loads it directly.
 *
 * With no handler Electron GRANTS every permission request without a prompt, camera, microphone
 * and location included, to any frame the window shows (an injected script, a provider's page
 * after the account-link navigation). The game needs three: fullscreen, pointer lock and
 * writing to the clipboard (copy room code, copy link). A future feature that needs another
 * permission must be added here, deliberately.
 */
const ALLOWED_PERMISSIONS = Object.freeze(['fullscreen', 'pointerLock', 'clipboard-sanitized-write']);

/** may a page have this permission? An unknown or absent name is a no. */
function permissionAllowed(permission) {
  return typeof permission === 'string' && ALLOWED_PERMISSIONS.includes(permission);
}

/**
 * ADS DO NOT RUN IN THE DESKTOP APP (`src/ads/adsense.ts` rule 1: AdSense does not permit
 * serving inside a non-browser app wrapper). The shell loads the live site, and `index.html`
 * hardcodes the publisher tag for the web crawler, so the script request is cancelled here.
 * The page still loads: the tag is `async` and `AdsProvider` treats a missing `adsbygoogle` as
 * no ads. These are `webRequest` URL filters (match patterns).
 */
const AD_URL_PATTERNS = Object.freeze([
  '*://*.googlesyndication.com/*',
  '*://*.doubleclick.net/*',
  '*://*.googleadservices.com/*',
  '*://*.adtrafficquality.google/*',
]);

/**
 * A SAME-WINDOW NAVIGATION TO A `mailto:` ADDRESS GOES TO THE OS MAIL HANDLER. The Privacy and
 * Terms pages carry `[addr](mailto:addr)` links that render as a plain `<a href>` (no target), so
 * they navigate the window itself. Chromium hands a non-web scheme to the embedder through the
 * `openExternal` permission, which `permissionAllowed` refuses, so without this the link is dead.
 * `main.cjs` stops the navigation (`will-navigate`) and passes the address to `openLink`, which
 * allows only https and mailto. Only `mailto:` is taken here: every other navigation, and every
 * other scheme, is left exactly as it was (the window still never navigates to `ms-*:` or `file:`
 * by this path). Returns whether this URL is such a navigation.
 */
function isMailtoNavigation(url) {
  try {
    return new URL(String(url)).protocol === 'mailto:';
  } catch {
    return false;
  }
}

module.exports = { ALLOWED_PERMISSIONS, permissionAllowed, AD_URL_PATTERNS, isMailtoNavigation };
