import { StrictMode, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { BannerStack } from './ui/BannerStack';
import { ClosedScreen } from './ui/ClosedScreen';
import { useShellState } from './ui/shellState';
import { BOOT_WAIT_MS, BUILD_CLOSED, getSiteState, isClosed, loadSiteStatus, useSiteState } from './net/siteStatus';
import { NoticePoller } from './ui/NoticePoller';
import { PadNavLayer } from './ui/PadNavLayer';
import { initPhysics } from './sim/physicsEngine';
import { initTheme } from './theme';
import { AdsProvider } from './ads/AdsProvider';
import { loadCmp } from './ads/adsense';
import { adoptLanFromOrigin } from './net/lanAdopt';
import { CHUNK_RELOAD_KEY } from './storageKeys';
// Self-hosted (not a CDN <link>): the Electron build runs from file:// with
// vite `base: './'`, so fingerprinted woff2 must be bundled to resolve offline.
// Variable cuts, because shell.css asks for weights off the 100 grid (750).
import '@fontsource-variable/plus-jakarta-sans';
import '@fontsource-variable/space-grotesk';
import './ui/styles.css';
import './ui/shell.css';
// the tutorial step card (roadmap item 6). Its own file, LAST: `styles.css`/`shell.css` are one
// large, actively-edited cascade and these rules are additive.
import './ui/tutorial.css';

// The inline script in index.html already stamped data-theme for the first paint.
// This re-stamps from the same key and, when the pref is 'system', arms the
// prefers-color-scheme listener so an OS switch is picked up live.
initTheme();

// Consent BEFORE the auction. index.html hardcodes the adsbygoogle tag so the
// AdSense crawler finds it on every route, which means the tag is already parsing
// by the time React mounts - a CMP that waited for the first ad slot would arrive
// far too late to gate anything. No-ops without a publisher id, and under Electron.
loadCmp();

// Init the Rapier physics WASM (shared src/sim) before the first sim step. It
// inlines its WASM as base64 (no separate asset), so this is a fast local
// decode — block the initial render on it so no GameController steps early.
// If this page was served BY a LAN host, play on that host. Runs alongside the physics
// init rather than after it, so a guest at a venue never waits on it; it resolves in
// milliseconds on a LAN and is skipped outright on https. See src/net/lanAdopt.ts.
const lanReady = adoptLanFromOrigin().catch(() => false);

// A STALE CHUNK AFTER A DEPLOY. A tab opened before a deploy still asks for the old hashed
// `assets/<name>-<hash>.js`, which is gone, and Vite fires this before the lazy import rejects.
// Reload ONCE to pick up the new build; the session flag stops a loop when the file is missing
// for some other reason (offline), which `LoadBoundary` then reports on the page.
window.addEventListener('vite:preloadError', (e) => {
  try {
    if (sessionStorage.getItem(CHUNK_RELOAD_KEY) === '1') return;
    sessionStorage.setItem(CHUNK_RELOAD_KEY, '1');
  } catch {
    return; // no storage, no loop guard: let LoadBoundary show the error instead
  }
  e.preventDefault();
  location.reload();
});

/*
 * THE SITE STATUS BEFORE THE FIRST PAINT (`src/net/siteStatus.ts`). Asked now, beside the
 * physics init, so a closed site renders the closed screen instead of the menus:
 *  - a build baked closed (the alpha) mounts the closed screen at once, no network wait;
 *  - a closed answer mounts it the moment it lands, physics or not;
 *  - otherwise the app waits for the answer at most BOOT_WAIT_MS from here, then opens (FAIL
 *    OPEN: an unreachable server is not a closed site). A later answer can still close it.
 */
const statusRead = loadSiteStatus();
const statusOrTimeout = Promise.race([statusRead, new Promise<void>((r) => setTimeout(r, BOOT_WAIT_MS))]);

let bootReady = false;
const bootSubs = new Set<() => void>();
const useBootReady = (): boolean =>
  useSyncExternalStore(
    (cb) => {
      bootSubs.add(cb);
      return () => bootSubs.delete(cb);
    },
    () => bootReady,
  );

/**
 * THE GATE. Closed means the closed screen, in place of everything else. A player already in a
 * match keeps it until they leave the match screen (the server lets a running match finish);
 * `App` reports that through `shellState`.
 */
function Root() {
  const site = useSiteState();
  const shell = useShellState();
  const ready = useBootReady();
  const closed = isClosed(site) && !shell.inMatch;
  return (
    <StrictMode>
      {closed ? (
        <ClosedScreen />
      ) : ready ? (
        <>
          {/* Wraps everything because the game screen renders OUTSIDE the app shell
              (App returns it early), and that is where the ad columns live. */}
          <AdsProvider>
            <App />
          </AdsProvider>
          <BannerStack />
          {/* CONTROLLER NAVIGATION. Beside `<App/>` rather than inside it, for the reason the ad
              provider wraps it: the game, lobby, record and ranked screens are returned EARLY and
              would each have to remember to mount this. It renders through a portal to `body`, so
              its position here costs it nothing, and it polls nothing until a pad connects. */}
          <PadNavLayer />
        </>
      ) : null}
      {/* the site status poll runs on BOTH sides of the gate: it is what reopens a closed screen */}
      <NoticePoller />
      {/* Page views are sent by `trackPageview` (`src/pageviews.ts`) from App's route effect,
          which applies the opt-out and strips the query string itself. */}
    </StrictMode>
  );
}

// React clears `#root` (the static crawler homepage) on its first render, so nothing renders
// until there is something to show: the closed screen, or the app.
let mounted = false;
const mount = (): void => {
  if (mounted) return;
  mounted = true;
  createRoot(document.getElementById('root')!).render(<Root />);
};
if (BUILD_CLOSED) mount();
void statusRead.then(() => {
  if (isClosed(getSiteState())) mount();
});
Promise.all([initPhysics(), lanReady, statusOrTimeout]).then(() => {
  bootReady = true;
  bootSubs.forEach((f) => f());
  mount();
});
