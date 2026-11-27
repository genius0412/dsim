/**
 * WHICH PAGES THE DESKTOP SHELL TRUSTS, AND WHICH LINKS IT MAY HAND TO THE OS.
 *
 * Pure: no `require('electron')`, so `scripts/smoke.ts` loads it directly. Every decision the
 * shell makes about an address lives here; `main.cjs` only wires it to Electron.
 *
 * ⚠️ `preload.cjs` CANNOT REQUIRE THIS FILE. A renderer is sandboxed by default (Electron 20+),
 * and a sandboxed preload may require only `electron`, `events`, `timers` and `url`. The preload
 * therefore carries its own two-line copy of `isTrustedUrl`'s rule, and `scripts/smoke.ts` runs
 * the preload against stub locations and asserts the two agree. Change the allow list here and
 * the check fails until the preload says the same.
 */

/** the live site the shell loads (`SITE` in main.cjs). The only https origin that gets the bridge. */
const SITE_ORIGIN = 'https://www.playdsim.com';

/**
 * The origins that may call `window.dsim`. The www origin is what the shell loads; the apex is
 * the same owner's domain and redirects to it, listed so a page that ever lands there is not
 * locked out of its own bridge. NOT alpha: a developer pointing a shell at the alpha site gets no
 * bridge, on purpose.
 */
const TRUSTED_HTTPS_ORIGINS = [SITE_ORIGIN, 'https://playdsim.com'];

/**
 * Is this the shell's own page? `file:` is the offline bundle; the https origins are the live
 * site. Anything else (a sign-in provider after the account-link navigation, `about:blank`, a
 * look-alike host such as `https://www.playdsim.com.evil.example`) is not.
 */
function isTrustedUrl(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return false;
  }
  if (u.protocol === 'file:') return true;
  return u.protocol === 'https:' && TRUSTED_HTTPS_ORIGINS.includes(u.origin);
}

/**
 * May this IPC message be answered? `frame` is `event.senderFrame` (a `WebFrameMain`, or null
 * when the frame navigated or was destroyed). Only the TOP frame of a trusted page: a frame
 * embedded in a trusted page, or a page that has since navigated away, is refused.
 */
function isTrustedSender(frame) {
  try {
    if (!frame || typeof frame.url !== 'string') return false;
    if (frame.parent != null) return false; // `parent` is null on the top frame
    return isTrustedUrl(frame.url);
  } catch {
    return false; // reading a destroyed frame can throw
  }
}

/**
 * Wrap an `ipcMain.handle` handler so an untrusted sender gets `{ error: 'forbidden' }` and the
 * handler never runs. `check` is a parameter only so the smoke suite can pass a stub.
 */
function guarded(fn, check = isTrustedSender) {
  return (event, ...args) => {
    let frame = null;
    try {
      frame = event ? event.senderFrame : null;
    } catch {
      frame = null;
    }
    if (!check(frame)) return { error: 'forbidden' };
    return fn(event, ...args);
  };
}

/**
 * A link a page asked the OS to open, or null. Only `https:` and `mailto:` reach
 * `shell.openExternal` (see `openLink` in main.cjs for why). It returns the PARSED href, not the
 * string the page supplied: the URL parser drops tabs, newlines and leading blanks, so the
 * check and the use must see the same bytes.
 */
function safeExternalUrl(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return null;
  }
  return u.protocol === 'https:' || u.protocol === 'mailto:' ? u.href : null;
}

/** Chromium's ERR_ABORTED: a navigation replaced by another one, never a failure */
const ERR_ABORTED = -3;

/**
 * Should a failed load put the bundled offline copy on screen? Only the MAIN frame of a load of
 * the live site, and not an aborted one. An offline reload of the live site otherwise leaves a
 * blank window; a failed provider page or sub-frame must not replace the app, and the bundle's
 * own `file:` load failing must not loop.
 */
function shouldFallBackToBundle(isMainFrame, errorCode, url, site = SITE_ORIGIN) {
  if (!isMainFrame || errorCode === ERR_ABORTED) return false;
  try {
    return new URL(String(url)).origin === new URL(site).origin;
  } catch {
    return false;
  }
}

module.exports = {
  SITE_ORIGIN,
  TRUSTED_HTTPS_ORIGINS,
  isTrustedUrl,
  isTrustedSender,
  guarded,
  safeExternalUrl,
  shouldFallBackToBundle,
};
