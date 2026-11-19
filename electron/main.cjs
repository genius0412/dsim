const { app, BrowserWindow, Menu, dialog, shell, ipcMain, nativeTheme, net } = require('electron');
const path = require('path');
const fs = require('fs');
const lanHost = require('./lanHost.cjs');

const SITE = 'https://www.playdsim.com';
const LATEST_API = 'https://api.github.com/repos/genius0412/dsim/releases/latest';

/**
 * A LINK FROM A PAGE GOES TO THE OS ONLY AS https: OR mailto:.
 *
 * `shell.openExternal` hands its argument to ShellExecute, which runs whatever is registered for
 * the scheme: `file:` (a UNC path included) opens or launches the target, and `ms-*:`,
 * `search-ms:` and the rest start their handlers. The URL comes from `window.open` in a window
 * that loads the live site, so any frame or third-party script in it can supply one. Every link
 * the app itself opens is https, or mailto on the legal pages.
 */
function openLink(url) {
  let scheme = '';
  try {
    scheme = new URL(String(url)).protocol;
  } catch {
    return;
  }
  if (scheme === 'https:' || scheme === 'mailto:') shell.openExternal(url);
}

/**
 * THE SPLASH. See electron/splash.html for what it says and why.
 *
 * Startup here is slow in a way a web page's is not: `siteReachable()` probes for
 * up to 2.5s and then the whole live site loads over the network, and until this
 * existed the user watched an empty 1280x820 window for all of it. It is also the
 * desktop build's presenting-sponsor placement.
 *
 * Frameless, un-resizable and never in the taskbar — it is a loading state, not a
 * window anybody should be able to end up managing. `alwaysOnTop` is scoped to its
 * own lifetime, which is at most `SPLASH_MAX_MS`.
 */
const SPLASH_MAX_MS = 15000;
let splash = null;

function showSplash() {
  splash = new BrowserWindow({
    width: 420,
    height: 260,
    frame: false,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#20262c' : '#f9faf7',
    // no preload, no node: this page is static markup and must stay that way
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splash.loadFile(path.join(__dirname, 'splash.html'));
  splash.on('closed', () => {
    splash = null;
  });
  return splash;
}

/** Take the splash down. Idempotent, and safe to call after the user has closed
 *  the app — every caller below is an event that can fire after teardown. */
function closeSplash() {
  if (splash && !splash.isDestroyed()) splash.close();
  splash = null;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    autoHideMenuBar: true,
    /**
     * HIDDEN UNTIL IT HAS SOMETHING TO SHOW. With the splash in front, an empty
     * main window behind it is what the user sees the instant the splash closes —
     * so the swap is `ready-to-show`, which fires once the renderer has painted.
     * Without this the splash would hand over to the same blank window it exists
     * to replace.
     */
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    // App icon (dock/taskbar/finder + Linux window) comes from the packaged icon
    // electron-builder generates from build/icon.png; no runtime path needed.
    // tracks --ds-bg in src/ui/shell.css (and THEME_BG in src/theme.ts) — otherwise
    // the window flashes the wrong ground before the renderer first paints.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#20262c' : '#f9faf7',
    title: 'DSIM',
  });

  // External links in the app all use target=_blank / window.open — send those to
  // the user's real browser instead of opening a chrome-less child window. We do
  // NOT intercept same-window navigations: an older site build still does Google
  // sign-in as a full-page redirect, and blocking it would break auth there. A
  // current one asks for a pop-up instead (`dsim:oauth` below).
  win.webContents.setWindowOpenHandler(({ url }) => {
    openLink(url);
    return { action: 'deny' };
  });

  /**
   * THE HANDOVER, and its three exits — because a splash that outlives its window
   * is a frameless always-on-top rectangle the user cannot get rid of.
   *  - `ready-to-show`: the ordinary path.
   *  - the timeout: a live site that hangs past `SPLASH_MAX_MS`. `loadApp` falls
   *    back to the bundled copy only on a FAILED load, not on a slow one, so
   *    without this a stalled request holds the splash open indefinitely.
   *  - `closed`: the user quit during startup.
   */
  win.once('ready-to-show', () => {
    closeSplash();
    win.show();
  });
  const splashTimer = setTimeout(() => {
    closeSplash();
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  }, SPLASH_MAX_MS);
  win.on('closed', () => {
    clearTimeout(splashTimer);
    closeSplash();
  });

  loadApp(win);
  return win;
}

// Load the LIVE site when online so the desktop app is always the current deploy
// (the game content updates with every web deploy — no re-download to update), and
// fall back to the BUNDLED copy when offline (the primary case for a downloaded
// build). The bundled copy is a full, online-capable build (vite bakes the public
// game-server + auth config in for ELECTRON=1), so multiplayer works from it too if
// a network is present — the fallback only really means "solo/offline" when there's
// genuinely no connection.
function loadLocal(win) {
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

async function loadApp(win) {
  if (await siteReachable()) {
    // loadURL rejects if the page fails to load; ERR_ABORTED is a benign
    // client-side navigation (e.g. the SPA taking over), not a real failure.
    win.loadURL(SITE).catch((e) => {
      if (!e || e.code !== 'ERR_ABORTED') loadLocal(win);
    });
  } else {
    loadLocal(win);
  }
}

/**
 * IS THE LIVE SITE REACHABLE? A HEAD probe, so a truly-offline launch falls back to the
 * bundle fast. Any status < 500 counts as reachable.
 *
 * ⚠️ IT GOES THROUGH CHROMIUM'S NETWORK STACK (`net.fetch`), THE ONE `loadURL` USES. It used
 * to be Node's `https`, which ignores the system proxy (and its PAC script) and the Windows
 * certificate store. On a school or office network with a proxy or TLS inspection, the probe
 * failed while the site opened fine in a browser, and the app fell back to the copy bundled
 * in the installer: v0.1.3 shipped a July 2026 build with no BIOBUZZ, and players reported the
 * app "not having BIOBUZZ 3D". Asking the stack that will load the page means the two agree.
 *
 * `PROBE_MS` bounds only a network that connects and then stalls: with no network at all
 * `net.isOnline()` answers at once. It was 2.5 s; the splash covers the wait now, and a slow
 * first TLS handshake is not a reason to show a months-old build.
 */
const PROBE_MS = 5000;

/** `net.fetch` with a deadline. Rejects on timeout like any other network failure. */
async function fetchWithin(url, init, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await net.fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function siteReachable() {
  if (!net.isOnline()) return false;
  try {
    const res = await fetchWithin(
      `${SITE}/version.json`,
      { method: 'HEAD', headers: { 'User-Agent': 'DSIM-desktop' } },
      PROBE_MS,
    );
    return res.status > 0 && res.status < 500;
  } catch {
    return false;
  }
}

// ---- persisted preferences (userData) -----------------------------------
//
// ONE FILE, READ-MODIFY-WRITE. It held a single `autoCheck` key and was written by
// replacing the whole document, which is fine for one key and silently destroys the
// others the moment there are two. `unlimitedFps` is the second.
const prefPath = () => path.join(app.getPath('userData'), 'update-pref.json');
function readPrefs() {
  try {
    const o = JSON.parse(fs.readFileSync(prefPath(), 'utf8'));
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {}; // missing, corrupt, or a profile we cannot read — every default is below
  }
}
function writePrefs(patch) {
  try {
    fs.writeFileSync(prefPath(), JSON.stringify({ ...readPrefs(), ...patch }));
  } catch {
    /* best-effort */
  }
}
function getAutoCheck() {
  return readPrefs().autoCheck !== false; // default ON
}
function setAutoCheck(v) {
  writePrefs({ autoCheck: !!v });
}

/**
 * UNLIMITED FRAME RATE — the desktop half of the Max frame rate row (see
 * `src/games/biobuzz/graphics/settings.ts`, which carries the full reasoning).
 *
 * The renderer's draw loop is `requestAnimationFrame`, so the compositor paces it at the
 * display's refresh and no amount of renderer-side setting can present a frame past it.
 * These two Chromium switches are the only thing that can, and they are why the option
 * exists in the desktop app and nowhere else.
 *
 * ⚠️ **THEY MUST BE APPENDED BEFORE `app.whenReady()`** — the command line is read when the
 * GPU process is spawned, and appending a switch afterwards does nothing at all (quietly:
 * no error, no warning, and a frame rate that is still pinned to the panel). That is why
 * this reads the preference at module scope, why the renderer is told what THIS process
 * actually launched with, and why changing the setting asks for a restart instead of
 * pretending to take effect.
 *
 * Default OFF, and `=== true` rather than `!== false`: leaving vsync off costs a GPU that
 * renders frames nobody will ever see, so it is opt-in and a corrupt pref file opts out.
 */
function getUnlimitedFps() {
  return readPrefs().unlimitedFps === true;
}
function setUnlimitedFps(v) {
  writePrefs({ unlimitedFps: !!v });
}

/** what THIS process launched with — frozen here, because the pref can change under it. */
const UNLIMITED_FPS_ACTIVE = getUnlimitedFps();
if (UNLIMITED_FPS_ACTIVE) {
  app.commandLine.appendSwitch('disable-frame-rate-limit');
  app.commandLine.appendSwitch('disable-gpu-vsync');
}

// ---- updates ------------------------------------------------------------
/**
 * THE APP UPDATES ITSELF (owner, 2026-11-16: "make sure that we never have to release a new
 * version again. No matter what we do"). `.github/workflows/release.yml` publishes a release
 * on every push to main that changes what ships in the app; this downloads it in the
 * background and installs it when the player closes the app. The next launch is the new shell
 * AND a new bundled offline copy. Nobody tags, uploads or reinstalls anything.
 *
 * WHERE IT CANNOT INSTALL, `updater` stays null and the app keeps the old behaviour: a notice
 * and the download page.
 *  - macOS: Squirrel.Mac refuses an update to an unsigned app, and this build is unsigned
 *    (`mac.identity: null`). Fixing that needs an Apple Developer ID.
 *  - the portable exe: nothing is installed, so there is nothing to install over.
 *  - an unpackaged run (`npm run electron`): there is no release to compare it to.
 *
 * It is electron-updater, bundled into `dist-electron/updater.cjs` by `npm run desktop:bundle`
 * because the package ships no node_modules. Its requests go through Electron's `net`, so the
 * system proxy applies (see `siteReachable`), and it checks the release's sha512 before
 * installing. The NSIS uninstaller skips `deleteAppDataOnUninstall` when it runs as part of an
 * update, so settings and the sign-in survive one.
 */
const UPDATE_EVERY_MS = 4 * 60 * 60 * 1000;
let updater = null;
/** the version downloaded and waiting for the app to close, or null */
let readyVersion = null;

function loadUpdater() {
  if (!app.isPackaged || process.platform === 'darwin' || process.env.PORTABLE_EXECUTABLE_DIR) return null;
  if (process.platform === 'linux' && !process.env.APPIMAGE) return null;
  try {
    const { autoUpdater } = require(path.join(__dirname, '..', 'dist-electron', 'updater.cjs'));
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;
    autoUpdater.on('update-downloaded', (info) => {
      readyVersion = info.version;
    });
    // a failed check or download is simply tried again at the next check
    autoUpdater.on('error', () => {});
    return autoUpdater;
  } catch {
    return null; // a package built without the bundle still has the notice-and-download path
  }
}

/** quit now and install the downloaded update, then relaunch. False when nothing is ready. */
function installUpdate() {
  if (!updater || !readyVersion) return false;
  // after this reply reaches the renderer: quitAndInstall closes every window, its own included
  setImmediate(() => updater.quitAndInstall(true, true));
  return true;
}

function cmpSemver(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

/** the latest release's tag. Through `net.fetch` for the reason `siteReachable` is: on a
 * network that needs the system proxy, Node's `https` never reached GitHub, so the players
 * most in need of a new build were the ones never told about it. */
async function fetchLatestTag() {
  const res = await fetchWithin(
    LATEST_API,
    { headers: { 'User-Agent': 'DSIM-desktop', Accept: 'application/vnd.github+json' } },
    8000,
  );
  if (res.status !== 200) throw new Error(`GitHub ${res.status}`);
  return (await res.json()).tag_name || '';
}

/**
 * `{ current, latest, updateAvailable, mode, ready }`, or throws on a network failure.
 * `mode` is `'auto'` where this app installs updates itself and `'manual'` where it can only
 * point at the download page. `ready`: an update is downloaded and installs when the app closes.
 * In `'auto'` mode the check also STARTS the download.
 */
async function checkLatest() {
  const current = app.getVersion();
  if (updater) {
    const r = await updater.checkForUpdates();
    // the download runs on after this returns; a failure there is the 'error' event's business
    r?.downloadPromise?.catch(() => {});
    const latest = r?.updateInfo?.version || null;
    return {
      current,
      latest,
      updateAvailable: !!latest && cmpSemver(latest, current) > 0,
      mode: 'auto',
      ready: !!readyVersion && cmpSemver(readyVersion, current) > 0,
    };
  }
  const latest = (await fetchLatestTag()).replace(/^v/, '');
  return {
    current,
    latest: latest || null,
    updateAvailable: !!latest && cmpSemver(latest, current) > 0,
    mode: 'manual',
    ready: false,
  };
}

/** the menu item (`interactive`) and the background checks. The background path never opens a
 * dialog in `'auto'` mode: the update installs when the app closes. */
async function promptUpdate(interactive) {
  let r;
  try {
    r = await checkLatest();
  } catch {
    if (interactive) {
      dialog.showMessageBox({
        type: 'warning',
        message: 'Couldn’t check for updates.',
        detail: 'Check your connection and try again, or get the latest version at playdsim.com/download.',
        buttons: ['OK'],
      });
    }
    return;
  }
  if (r.mode === 'auto') {
    if (!interactive) return;
    if (r.ready) {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        message: `DSIM ${readyVersion} is ready to install.`,
        detail: 'Restart now, or it installs the next time you close DSIM.',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) installUpdate();
    } else if (r.updateAvailable) {
      dialog.showMessageBox({
        type: 'info',
        message: `Downloading DSIM ${r.latest}.`,
        detail: 'It installs the next time you close DSIM.',
        buttons: ['OK'],
      });
    } else {
      dialog.showMessageBox({
        type: 'info',
        message: 'You’re up to date.',
        detail: `DSIM ${r.current} is the latest version.`,
        buttons: ['OK'],
      });
    }
    return;
  }
  if (r.updateAvailable) {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      message: `A new version of DSIM is available (${r.latest}).`,
      detail: `You have ${r.current}. Open the download page to update?`,
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) shell.openExternal(`${SITE}/download`);
  } else if (interactive) {
    dialog.showMessageBox({
      type: 'info',
      message: 'You’re up to date.',
      detail: `DSIM ${r.current} is the latest version.`,
      buttons: ['OK'],
    });
  }
}

// ---- renderer bridge (see electron/preload.cjs) -------------------------
ipcMain.handle('dsim:version', () => app.getVersion());
ipcMain.handle('dsim:check', () => checkLatest()); // in-app UI: returns the result, no dialog
ipcMain.handle('dsim:installUpdate', () => installUpdate());
ipcMain.handle('dsim:getAuto', () => getAutoCheck());
ipcMain.handle('dsim:setAuto', (_e, v) => {
  setAutoCheck(v);
  return getAutoCheck();
});
ipcMain.handle('dsim:openDownload', () => shell.openExternal(`${SITE}/download`));

/**
 * GOOGLE SIGN-IN IN A POP-UP (owner, 2026-09-24: on the desktop app "clicking on the log in with
 * google button shows the google sign in screen on the app instead of opening up a new tab on a
 * browser or showing a pop up").
 *
 * The web flow is a full-page redirect, so in this window Google replaced the app. A tab in the
 * user's own browser cannot be used: the session it would end with lives in THAT browser's cookie
 * jar, and nothing hands it back. A child window here shares this app's session, so the renderer
 * asks Neon Auth for the provider URL (`disableRedirect`), and this opens it. The moment the flow
 * redirects to `callback` (a URL on the site, which is never loaded), the pop-up closes and the
 * `neon_auth_session_verifier` Neon Auth appended is handed back: the renderer exchanges it for
 * the session exactly as a returning web redirect does. Closing the pop-up resolves `null`.
 *
 * The pop-up's user agent drops the `Electron/…` and app tokens: Google refuses sign-in in what
 * it recognises as an embedded browser. Only this window's; the site reads "Electron" in the main
 * window's to know it is the desktop app.
 */
ipcMain.handle('dsim:oauth', (e, opts) => {
  const url = opts && typeof opts.url === 'string' ? opts.url : '';
  const callback = opts && typeof opts.callback === 'string' ? opts.callback : '';
  if (!/^https:\/\//.test(url) || !/^https:\/\//.test(callback)) return Promise.resolve({ error: 'bad-request' });
  return new Promise((resolve) => {
    const parent = BrowserWindow.fromWebContents(e.sender) || undefined;
    const pop = new BrowserWindow({
      width: 500,
      height: 700,
      parent,
      autoHideMenuBar: true,
      title: 'Sign in with Google',
      backgroundColor: '#ffffff',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const ua = pop.webContents
      .getUserAgent()
      .replace(/\s*Electron\/\S+/i, '')
      .replace(new RegExp(`\\s*${app.getName().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/\\S+`, 'i'), '');
    pop.webContents.setUserAgent(ua);
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      resolve(result);
      if (!pop.isDestroyed()) pop.close();
    };
    const atCallback = (ev, target) => {
      if (typeof target !== 'string' || !target.startsWith(callback)) return;
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      let verifier = null;
      let error = null;
      try {
        const q = new URL(target).searchParams;
        verifier = q.get('neon_auth_session_verifier');
        error = q.get('error');
      } catch {
        error = 'bad-callback';
      }
      finish(verifier ? { verifier } : { error: error || 'no-verifier' });
    };
    pop.webContents.on('will-redirect', atCallback);
    pop.webContents.on('will-navigate', atCallback);
    pop.webContents.on('did-navigate', (_ev, target) => atCallback(null, target));
    // a link inside the provider's page ("Help", "Privacy") goes to the real browser
    pop.webContents.setWindowOpenHandler(({ url: u }) => {
      openLink(u);
      return { action: 'deny' };
    });
    pop.on('closed', () => finish({ cancelled: true }));
    pop.loadURL(url).catch(() => {
      /* an aborted load is the callback being intercepted, not a failure */
    });
  });
});

/**
 * THE FRAME-RATE SWITCHES. Two facts, not one, because they can legitimately disagree:
 * `unlimitedFps` is what the NEXT launch will do and `active` is what THIS one did. The
 * renderer shows "restart to apply" from exactly that difference — there is no other way for
 * it to know, and guessing would make the restart prompt appear when nothing had changed.
 */
const perfState = () => ({ unlimitedFps: getUnlimitedFps(), active: UNLIMITED_FPS_ACTIVE });
ipcMain.handle('dsim:getPerf', () => perfState());
ipcMain.handle('dsim:setPerf', (_e, v) => {
  setUnlimitedFps(v);
  return perfState();
});
/**
 * RESTART, ONLY EVER BECAUSE SOMEBODY PRESSED A BUTTON. The Graphics screen is its own
 * top-level screen (`screen === 'configure'` in `App.tsx`), mutually exclusive with the one a
 * match runs on, so there is no match to interrupt from there — but the rule stands anyway:
 * nothing in the main process may decide on its own that now is a good moment to quit.
 */
ipcMain.handle('dsim:relaunch', () => {
  app.relaunch();
  app.quit();
});

/**
 * HOSTING A LAN GAME. See `electron/lanHost.cjs`.
 *
 * Three calls and no more: the renderer asks to start, to stop, or for the current state.
 * Everything about WHERE the server lives, how it is run and what environment it gets stays
 * in the main process, because none of it is the renderer's business and some of it
 * (blanking `DATABASE_URL`) is a rule rather than a detail.
 */
ipcMain.handle('dsim:lanStart', (_e, opts) => lanHost.start(app, opts || {}));
ipcMain.handle('dsim:lanStop', () => lanHost.stop());
ipcMain.handle('dsim:lanStatus', () => lanHost.status());

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const checkItem = { label: 'Check for Updates…', click: () => promptUpdate(true) };
  const template = [
    ...(isMac
      ? [{ label: app.name, submenu: [{ role: 'about' }, checkItem, { type: 'separator' }, { role: 'quit' }] }]
      : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        ...(isMac ? [] : [checkItem, { type: 'separator' }]),
        { label: 'DSIM on the web', click: () => shell.openExternal(SITE) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildMenu();
  // splash FIRST, so there is something on screen while `createWindow` starts its
  // reachability probe and the site load behind it
  showSplash();
  createWindow();
  updater = loadUpdater();
  // quiet check shortly after launch, only if auto-check is enabled
  setTimeout(() => {
    if (getAutoCheck()) promptUpdate(false);
  }, 3000);
  // and again while a long session stays open. Only where the app installs updates itself:
  // the manual path's check is a dialog, and one every four hours is nagging.
  if (updater) {
    setInterval(() => {
      if (getAutoCheck()) promptUpdate(false);
    }, UPDATE_EVERY_MS);
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/**
 * THE HOSTED SERVER DIES WITH THE APP, always.
 *
 * A child process outliving its parent would hold port 8787 with nothing on screen
 * explaining why the next attempt to host fails — and on Windows it would keep answering a
 * venue's network from an app the host believes they closed. `before-quit` covers the
 * ordinary exit and `quit` covers the paths that skip it.
 */
app.on('before-quit', () => {
  // a quit during startup must not leave the splash behind
  closeSplash();
  lanHost.stop();
});
app.on('quit', () => lanHost.stop());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
