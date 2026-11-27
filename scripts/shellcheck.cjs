/* THE DESKTOP SHELL, RUN FOR REAL (`electron/**`), with nothing it does reaching the owner's desktop.
 *
 * `electron/main.cjs`, `preload.cjs` and the three pure modules beside them decide what a page in the
 * shell may do (which pages get `window.dsim`, which permissions are granted, which hosts are
 * cancelled, which links reach the OS, when an update dialog opens). `npm test` holds the pure
 * helpers; this holds that Electron actually CALLS them with the arguments they expect: a handler
 * with the wrong signature fails SILENTLY in a shell, so it has to be driven.
 *
 *   ELECTRON=1 npx vite build                                   # the bundled copy the shell falls back to
 *   env -u ELECTRON_RUN_AS_NODE npx electron scripts/shellcheck.cjs [--offline] [--keep]
 *
 *   --offline  never load the live site (the shell is pointed at the bundled copy from the start)
 *   --auto     run ONLY the auto-update wiring: the shell is told it is packaged and is handed a FAKE
 *              updater (electron-updater itself is never loaded or run); implies --offline
 *   --keep     keep the scratch user-data directory (its path is printed) instead of deleting it
 *
 * Exit code 0 = every check passed. It must run from inside the repo (a `require('electron')`
 * resolves from the repo's node_modules). On a machine where an agent shell exports
 * `ELECTRON_RUN_AS_NODE=1` unset it first, or `app` is undefined.
 *
 * WHAT KEEPS IT QUIET. It is the Electron entry point and patches the `electron` module BEFORE it
 * requires `electron/main.cjs` (a `Module._load` hook hands the shell a wrapper):
 *  - every BrowserWindow is forced `show:false` and `show/focus/maximize/...` are no-ops, audio is
 *    muted on every webContents, and the run asserts no window was ever visible;
 *  - `shell.openExternal` and the `dialog.*` calls are RECORDERS: nothing opens, nothing is shown;
 *  - the updater (electron-updater, loaded only for a packaged app) is never loaded (the run is
 *    unpackaged, so the shell is in its "manual" mode), `app.relaunch/quit/exit` are recorders, and
 *    `net.fetch` answers the GitHub "latest release" call with a stub, so nothing is downloaded;
 *  - `child_process.spawn` is a fake, so the LAN host never starts a server or binds a port;
 *  - user data, session data and crash dumps are a scratch directory under the OS temp folder.
 * The shell loads the LIVE SITE at start (read only: it is a page load, the same one a player
 * makes). Everything after that runs against the bundled `dist/index.html` with a dead proxy
 * (`127.0.0.1:9`), so no request leaves the machine. A local http server on 127.0.0.1 serves the
 * "untrusted page".
 *
 * WHAT IT DOES NOT COVER (read, never run): the auto-update mode (electron-updater needs a packaged
 * app), a real `requestFullscreen`/`requestPointerLock` (they could show the hidden window; the
 * permission handlers are driven directly instead), and the Google sign-in pop-up (`dsim:oauth`
 * past argument validation).
 */
'use strict';

const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const cp = require('node:child_process');
const { EventEmitter } = require('events');

const real = require('electron');
if (!real || !real.app) {
  console.log('shellcheck: `electron` resolved to a path, not the API. Unset ELECTRON_RUN_AS_NODE and run it with `electron`.');
  process.exit(2);
}

// SHELLCHECK_ROOT: a directory holding `electron/` and `dist/` to run instead of this checkout's (used to prove the
// checks fail when the shell is broken: copy electron/, break it, link dist/, point this at the copy)
const ROOT = process.env.SHELLCHECK_ROOT ? path.resolve(process.env.SHELLCHECK_ROOT) : path.resolve(__dirname, '..');
const AUTO = process.argv.includes('--auto');
const OFFLINE = process.argv.includes('--offline') || AUTO;
const KEEP = process.argv.includes('--keep');
const SITE = 'https://www.playdsim.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- results ----------------------------------------------------------------------------------
let failures = 0;
const results = []; // { item, name, ok }
let currentItem = '0';
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  results.push({ item: currentItem, name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${currentItem}] ${name}${ok || detail === '' ? '' : `  ::  ${detail}`}`);
};
const info = (s) => console.log(`      ${s}`);
const j = (v) => JSON.stringify(v);
const section = (item, title) => {
  currentItem = item;
  console.log(`\n== ${item}. ${title}`);
};

// ---- what the shell did (recorders) -----------------------------------------------------------
const rec = {
  openExternal: [],
  dialogs: [],
  errorBoxes: [],
  relaunch: 0,
  quit: 0,
  exit: 0,
  windows: [], // every window the shell asked for: { win, opts }
  showCalls: 0, // `show()` etc. the shell asked for and the harness swallowed
  realShowEvents: 0,
  everVisible: false,
  loadFiles: [], // the shell's own `win.loadFile` calls
  loadURLs: [], // the shell's own `win.loadURL` calls (a loadFile ends in one too)
  ipcChannels: [],
  openHandlerCalls: [], // { url, result }
  spawns: [],
  uncaught: [],
  consoleErrors: [], // { wcId, url, message }
  renderGone: [],
  netErrors: [], // webRequest.onErrorOccurred: { url, error }
  failedLoads: [], // did-fail-load: { wcId, code, url, main }
  permSeen: [], // every permission name Chromium actually put to the handlers: 'request:<name>' / 'check:<name>'
  fallbackTrue: 0,
};
const state = {
  probe: OFFLINE ? 'down' : 'real', // what `net.fetch(<site>/version.json)` answers: real | up | down
  latestTag: 'v0.2.0',
  latestFail: false,
  latestCalls: 0,
  answers: [], // queued answers for the next message boxes (default 1 = the "Later"/"OK" button)
  skew: 0, // ms added to Date.now()
};
const captured = { permReq: null, permCheck: null };
const intervals = []; // setInterval calls the shell made at the 4-hour mark (held back)
let fakeLoads = 0;
const fakeUpdater = new EventEmitter();
fakeUpdater.checks = 0;
fakeUpdater.quits = [];
fakeUpdater.checkForUpdates = async () => {
  fakeUpdater.checks++;
  return { updateInfo: { version: state.latestTag.replace(/^v/, '') }, downloadPromise: Promise.resolve([]) };
};
fakeUpdater.quitAndInstall = (...a) => {
  fakeUpdater.quits.push(a);
};
const handlers = new Map(); // channel -> the handler main.cjs registered
let bgCheck = null; // the 3 s background update check main.cjs schedules, captured and held back

process.on('uncaughtException', (e) => rec.uncaught.push(`uncaughtException: ${e && e.stack ? e.stack : e}`));
process.on('unhandledRejection', (e) => rec.uncaught.push(`unhandledRejection: ${e && e.stack ? e.stack : e}`));

// ---- scratch directories ----------------------------------------------------------------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsim-shellcheck-'));
const USERDATA = path.join(TMP, 'userData');
fs.mkdirSync(USERDATA, { recursive: true });
// A unique app name, so the DEFAULT profile directory (%APPDATA%/<name>) is one nothing else ever writes: a run
// from `electron script.cjs` is named "Electron", a directory every other Electron script on the machine shares.
real.app.setName('dsim-shellcheck');
const defaultProfile = path.join(real.app.getPath('appData'), 'dsim-shellcheck');
const profileBefore = fs.existsSync(defaultProfile);
real.app.setPath('userData', USERDATA);
real.app.setPath('sessionData', path.join(TMP, 'session'));
real.app.setPath('crashDumps', path.join(TMP, 'crash'));
real.app.setPath('logs', path.join(TMP, 'logs'));
real.app.disableHardwareAcceleration();
real.app.commandLine.appendSwitch('mute-audio');
real.app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// ---- clock: Date.now() can be moved forward (the weekly update rule) -------------------------
const realNow = Date.now;
Date.now = () => realNow() + state.skew;

// ---- the 3 s background update check is captured, not run -------------------------------------
const realSetTimeout = global.setTimeout;
const realSetInterval = global.setInterval;
global.setTimeout = function patchedSetTimeout(fn, ms, ...rest) {
  if (ms === 3000 && !bgCheck && typeof fn === 'function' && /promptUpdate\(false\)/.test(String(fn))) {
    bgCheck = fn;
    return realSetTimeout(() => {}, 0);
  }
  return realSetTimeout.call(this, fn, ms, ...rest);
};

global.setInterval = function patchedSetInterval(fn, ms, ...rest) {
  if (ms === 4 * 60 * 60 * 1000) {
    intervals.push({ ms, fn });
    return realSetTimeout(() => {}, 0);
  }
  return realSetInterval.call(this, fn, ms, ...rest);
};

// ---- a fake spawn: the LAN host can never start a server --------------------------------------
cp.spawn = function fakeSpawn(cmd, args, opts) {
  rec.spawns.push({ cmd, args, env: opts && opts.env });
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    realSetTimeout(() => child.emit('exit', 0), 0);
    return true;
  };
  realSetTimeout(() => {
    child.stderr.emit('data', 'shellcheck fake server: not started');
    child.emit('exit', 1);
  }, 20);
  return child;
};

// ---- the wrapped `electron` module the shell is handed ----------------------------------------
/** a proxy over `target` that answers `ov`'s keys and passes everything else through, with methods bound */
function over(target, ov) {
  return new Proxy(target, {
    get(t, k) {
      if (Object.prototype.hasOwnProperty.call(ov, k)) return ov[k];
      const v = Reflect.get(t, k, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

const QUIET_NOOPS = ['show', 'showInactive', 'focus', 'maximize', 'unmaximize', 'restore', 'moveTop', 'setFullScreen', 'setSimpleFullScreen', 'flashFrame', 'setAlwaysOnTop', 'center'];
/**
 * The real class is wrapped, not subclassed: a subclass instance is not listed by
 * `BrowserWindow.getAllWindows()`, which the shell's own `activate` handler reads.
 */
function quieten(win, opts) {
  rec.windows.push({ win, opts });
  for (const m of QUIET_NOOPS) {
    win[m] = () => {
      rec.showCalls++;
    };
  }
  const proto = real.BrowserWindow.prototype;
  win.loadFile = (f, o) => {
    rec.loadFiles.push({ file: f, t: Date.now() });
    return proto.loadFile.call(win, f, o);
  };
  win.loadURL = (u, o) => {
    rec.loadURLs.push({ url: u, t: Date.now() });
    return proto.loadURL.call(win, u, o);
  };
  win.on('show', () => {
    rec.realShowEvents++;
  });
  const wc = win.webContents;
  const origOpen = wc.setWindowOpenHandler.bind(wc);
  wc.setWindowOpenHandler = (fn) =>
    origOpen((details) => {
      const result = fn(details);
      rec.openHandlerCalls.push({ url: details.url, result });
      return result;
    });
}
const QuietWindow = new Proxy(real.BrowserWindow, {
  construct(Target, args) {
    const opts = args[0] || {};
    const win = new Target({
      ...opts,
      show: false,
      fullscreen: false,
      alwaysOnTop: false,
      skipTaskbar: true,
      webPreferences: { ...(opts.webPreferences || {}), backgroundThrottling: false },
    });
    quieten(win, opts);
    return win;
  },
});

const sessionStub = over(real.session, {
  get defaultSession() {
    const ses = real.session.defaultSession;
    return over(ses, {
      setPermissionRequestHandler(fn) {
        captured.permReq = fn;
        return ses.setPermissionRequestHandler((wc, p, cb, d) => {
          rec.permSeen.push(`request:${p}`);
          return fn(wc, p, cb, d);
        });
      },
      setPermissionCheckHandler(fn) {
        captured.permCheck = fn;
        return ses.setPermissionCheckHandler((wc, p, o, d) => {
          rec.permSeen.push(`check:${p}`);
          return fn(wc, p, o, d);
        });
      },
    });
  },
});

const answerBox = () => (state.answers.length ? state.answers.shift() : 1);
const fakeElectron = new Proxy(real, {
  get(t, k) {
    switch (k) {
      case 'BrowserWindow':
        return QuietWindow;
      case 'session':
        return sessionStub;
      case 'shell':
        return over(real.shell, {
          openExternal: (u) => {
            rec.openExternal.push(String(u));
            return Promise.resolve();
          },
          openPath: (p) => {
            rec.openExternal.push(`openPath:${p}`);
            return Promise.resolve('');
          },
          showItemInFolder: (p) => {
            rec.openExternal.push(`showItemInFolder:${p}`);
          },
        });
      case 'dialog':
        return over(real.dialog, {
          showMessageBox: (a, b) => {
            rec.dialogs.push(b || a);
            return Promise.resolve({ response: answerBox(), checkboxChecked: false });
          },
          showMessageBoxSync: (a, b) => {
            rec.dialogs.push(b || a);
            return answerBox();
          },
          showErrorBox: (title, content) => {
            rec.errorBoxes.push(`${title}: ${content}`);
          },
          showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
          showSaveDialog: () => Promise.resolve({ canceled: true }),
        });
      case 'app':
        return over(real.app, {
          get isPackaged() {
            return AUTO;
          },
          relaunch: () => {
            rec.relaunch++;
          },
          quit: () => {
            rec.quit++;
          },
          exit: () => {
            rec.exit++;
          },
        });
      case 'ipcMain':
        return over(real.ipcMain, {
          handle: (ch, fn) => {
            rec.ipcChannels.push(ch);
            handlers.set(ch, fn);
            return real.ipcMain.handle(ch, fn);
          },
        });
      case 'net':
        return over(real.net, {
          fetch: (url, init) => {
            const u = String(url && url.url ? url.url : url);
            if (u.startsWith('https://api.github.com/')) {
              state.latestCalls++;
              if (state.latestFail) return Promise.reject(new TypeError('net::ERR_INTERNET_DISCONNECTED'));
              return Promise.resolve(
                new Response(JSON.stringify({ tag_name: state.latestTag }), { status: 200, headers: { 'content-type': 'application/json' } }),
              );
            }
            if (u.endsWith('/version.json') && state.probe !== 'real') {
              if (state.probe === 'down') return Promise.reject(new TypeError('net::ERR_INTERNET_DISCONNECTED'));
              return Promise.resolve(new Response(null, { status: 200 }));
            }
            return real.net.fetch(url, init);
          },
        });
      default:
        return Reflect.get(t, k, t);
    }
  },
});

const origLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  if (/dist-electron[\\/]+updater/.test(String(request))) {
    if (!AUTO) throw new Error('shellcheck: the updater bundle must never load');
    fakeLoads++;
    return { autoUpdater: fakeUpdater }; // electron-updater itself is never loaded
  }
  return origLoad.apply(this, arguments);
};

// ---- things that must exist before the shell's own `whenReady` handler runs -------------------
real.app.on('web-contents-created', (_e, wc) => {
  wc.setAudioMuted(true);
  wc.on('console-message', (...a) => {
    const d = a[0] && typeof a[0] === 'object' && 'message' in a[0] ? a[0] : { level: a[1], message: a[2] };
    const lvl = d.level;
    if (lvl === 3 || lvl === 'error') rec.consoleErrors.push({ wcId: wc.id, url: wc.getURL(), message: String(d.message).slice(0, 300) });
  });
  wc.on('render-process-gone', (_ev, details) => rec.renderGone.push(details && details.reason));
  wc.on('did-fail-load', (_ev, code, desc, url, isMain) => rec.failedLoads.push({ wcId: wc.id, code, desc, url, main: !!isMain }));
});
real.app.whenReady().then(() => {
  real.session.defaultSession.webRequest.onErrorOccurred((d) => rec.netErrors.push({ url: d.url, error: d.error }));
});

// the trust module is the shell's own instance (same require cache): count its fallback decisions
const trust = require(path.join(ROOT, 'electron', 'trust.cjs'));
const origFallback = trust.shouldFallBackToBundle;
trust.shouldFallBackToBundle = (...a) => {
  const r = origFallback(...a);
  if (r) rec.fallbackTrue++;
  return r;
};

// ---- helpers ----------------------------------------------------------------------------------
async function waitFor(fn, ms = 10000, step = 100) {
  const t0 = realNow();
  while (realNow() - t0 < ms) {
    let v;
    try {
      v = await fn();
    } catch {
      v = false;
    }
    if (v) return v;
    await sleep(step);
  }
  return false;
}
const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => realSetTimeout(() => rej(new Error(`timeout: ${what}`)), ms))]);
const ev = (wc, code, gesture = false) => withTimeout(wc.executeJavaScript(code, gesture), 20000, code.slice(0, 40));
const liveWindows = () => real.BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
const sampleVisible = () => {
  for (const w of liveWindows()) if (w.isVisible()) rec.everVisible = true;
};
const visTimer = setInterval(sampleVisible, 100);
const shellWindow = (pred) => {
  const hit = rec.windows.map((r) => r).reverse().find((r) => !r.win.isDestroyed() && pred(r.opts));
  return hit ? hit.win : null;
};
const mainOpts = (o) => o.title === 'DSIM' && o.width === 1280;

async function closeAllWindows() {
  for (const w of liveWindows()) w.close();
  await waitFor(() => liveWindows().length === 0, 8000);
}

/** the main window's current document is loaded (not loading) and has an address */
async function pageSettled(wc, ms = 45000) {
  return waitFor(() => wc.getURL() !== '' && !wc.isLoading(), ms, 150);
}

// =================================================================================================
async function main() {
  // the local "untrusted page" server (loopback only, ephemeral port)
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>untrusted</title><p>untrusted page</p>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const LOCAL = `http://127.0.0.1:${server.address().port}/`;

  // trusted (`file:`) pages for the raw-IPC probe window, and its preload
  const pages = path.join(TMP, 'pages');
  fs.mkdirSync(pages);
  fs.writeFileSync(path.join(pages, 'child.html'), '<!doctype html><title>child</title>');
  fs.writeFileSync(path.join(pages, 'trusted.html'), `<!doctype html><title>trusted</title><iframe src="${pathToFileUrl(path.join(pages, 'child.html'))}"></iframe>`);
  fs.writeFileSync(
    path.join(pages, 'raw-preload.cjs'),
    "const { contextBridge, ipcRenderer } = require('electron');\ncontextBridge.exposeInMainWorld('raw', { invoke: (ch, ...a) => ipcRenderer.invoke(ch, ...a) });\n",
  );

  // ---- 1. it starts ----------------------------------------------------------------------------
  section('1', 'It starts');
  require(path.join(ROOT, 'electron', 'main.cjs'));
  await real.app.whenReady();
  check('app.whenReady completed', true);
  check('user data is the scratch directory', real.app.getPath('userData') === USERDATA, real.app.getPath('userData'));
  if (!AUTO) check('the run is unpackaged, so electron-updater is never loaded', real.app.isPackaged === false);
  info(`Electron ${process.versions.electron}, Chromium ${process.versions.chrome}, Node ${process.versions.node}`);

  const mainWin = await waitFor(() => shellWindow(mainOpts), 10000);
  check('the main window was created', !!mainWin);
  if (!mainWin) return finish(server);
  const wc = mainWin.webContents;
  check('the splash window was created (hidden)', !!shellWindow((o) => o.width === 420 && o.frame === false));
  check('permission request + check handlers were registered', typeof captured.permReq === 'function' && typeof captured.permCheck === 'function');
  const EXPECTED = ['dsim:version', 'dsim:check', 'dsim:installUpdate', 'dsim:getAuto', 'dsim:setAuto', 'dsim:openDownload', 'dsim:oauth', 'dsim:getPerf', 'dsim:setPerf', 'dsim:relaunch', 'dsim:lanStart', 'dsim:lanStop', 'dsim:lanStatus'];
  check('all 13 IPC handlers registered', EXPECTED.every((c) => handlers.has(c)) && rec.ipcChannels.length === EXPECTED.length, j(rec.ipcChannels));
  check('no uncaught exception or rejection during startup', rec.uncaught.length === 0, rec.uncaught.join(' | '));

  let liveOk = false;
  if (!OFFLINE) {
    await pageSettled(wc, 60000);
    await sleep(5000); // let the site's own scripts settle
    const url = wc.getURL();
    liveOk = new URL(url).origin === SITE;
    check('the live site loaded in the main window', liveOk, url);
    if (liveOk) {
      const root = await ev(wc, "(() => { const r = document.getElementById('root'); return r ? r.children.length : -1; })()");
      check('live: the app rendered into #root', root > 0, `children=${root}`);
      await livePhase(wc);
    } else {
      info('LIVE SITE NOT REACHED: the live-site checks are NOT RUN (the shell fell back to the bundle)');
    }
  } else {
    await pageSettled(wc, 60000);
    info('--offline: the live site is not loaded');
  }
  section('1', 'Startup (continued)');
  if (AUTO) {
    await autoPhase();
    return finish(server);
  }
  const splash = shellWindow((o) => o.width === 420 && o.frame === false);
  check('the splash handed over: it is closed once the main window painted', !splash, `splash still open; windows=${liveWindows().length}`);

  // ---- 6. offline fallback ---------------------------------------------------------------------
  await fallbackPhase(mainWin);

  // ---- everything else runs on the bundled copy in the window the last fallback produced ------
  const bundleWin = shellWindow(mainOpts);
  if (!bundleWin) {
    check('a bundled window exists for the remaining checks', false);
    return finish(server);
  }
  const bwc = bundleWin.webContents;
  await pageSettled(bwc, 60000);
  await sleep(4000);
  section('1', 'Bundled copy');
  const bpath = bwc.getURL();
  check('the bundled copy is the page (file: dist/index.html)', /^file:\/\/\/.*dist\/index\.html/i.test(bpath), bpath);
  const broot = await ev(bwc, "(() => { const r = document.getElementById('root'); return r ? r.children.length : -1; })()");
  check('bundle: the app rendered into #root', broot > 0, `children=${broot}`);

  await bridgePhase(bundleWin, LOCAL);
  await probeWindowPhase(LOCAL, pages);
  await permissionsPhase(bwc, 'bundle');
  await adPhase(bwc);
  await linkPhase(bundleWin);
  await updatePhase();
  await lanPhase();
  await finish(server);
}

const pathToFileUrl = (p) => require('url').pathToFileURL(p).href;

// ---- 1/2/3/4 on the live site ----------------------------------------------------------------
async function livePhase(wc) {
  section('2', 'The bridge on the live site');
  const d = await ev(wc, "(() => ({ has: typeof window.dsim, desktop: window.dsim && window.dsim.isDesktop, keys: window.dsim ? Object.keys(window.dsim).sort() : [] }))()");
  check('live (https origin): window.dsim exists', d.has === 'object' && d.desktop === true, j(d));
  info(`the preload exposes: ${d.keys.join(', ')}`);
  const v = await ev(wc, 'window.dsim.version()', true);
  check('live: dsim.version() answers (the main-process guard accepts the https top frame)', v === real.app.getVersion(), j(v));
  const auto = await ev(wc, 'window.dsim.getAutoCheck()', true);
  check('live: dsim.getAutoCheck() answers a boolean', typeof auto === 'boolean', j(auto));
  const lan = await ev(wc, 'window.dsim.lan.status()', true);
  check('live: dsim.lan.status() answers (read only, not running)', lan && lan.running === false && Array.isArray(lan.addresses), j(lan).slice(0, 120));
  await permissionsPhase(wc, 'live');
  const adErrs = rec.netErrors.filter((e) => /googlesyndication|doubleclick|googleadservices|adtrafficquality/.test(e.url));
  section('4', 'Ad hosts on the live page');
  info(`the live page itself requested: ${adErrs.map((e) => `${new URL(e.url).host} ${e.error}`).join('; ') || '(nothing)'}`);
  check('live: the site\'s own ad tag request was cancelled (ERR_BLOCKED_BY_CLIENT), not loaded', adErrs.length > 0 && adErrs.every((e) => e.error === 'net::ERR_BLOCKED_BY_CLIENT'), j(adErrs));
  const errs = rec.consoleErrors.filter((e) => new URL(e.url || 'about:blank').origin === SITE);
  info(`live console errors: ${errs.length}${errs.length ? ' :: ' + errs.map((e) => e.message.slice(0, 120)).join(' | ') : ''}`);
}

// ---- 6. fallback ------------------------------------------------------------------------------
async function fallbackPhase(mainWin) {
  section('6', 'Offline fallback');
  const ses = real.session.defaultSession;
  // from here nothing leaves the machine: every http(s) request goes to a closed local port
  await ses.setProxy({ proxyRules: 'http=127.0.0.1:9;https=127.0.0.1:9' });
  await ses.closeAllConnections();
  state.probe = 'up'; // the reachability probe says the site is fine; the LOAD then fails

  // (a) a later load of the site fails in a window that is already open (Ctrl+R, the site address)
  const wc = mainWin.webContents;
  const f0 = rec.loadFiles.length;
  const fb0 = rec.fallbackTrue;
  const onSite = (() => {
    try {
      return new URL(wc.getURL()).origin === SITE;
    } catch {
      return false;
    }
  })();
  if (onSite) wc.reload();
  else wc.loadURL(SITE).catch(() => {});
  const gotFallback = await waitFor(() => rec.loadFiles.length > f0, 15000);
  check('(a) a failed reload/load of the site puts the bundled copy up', !!gotFallback, `loadFile calls: ${rec.loadFiles.length - f0}`);
  await sleep(6000);
  check('(a) once: exactly one loadFile, no loop', rec.loadFiles.length - f0 === 1, `loadFile calls: ${rec.loadFiles.length - f0}`);
  check('(a) the window now shows the bundle', /^file:/.test(wc.getURL()), wc.getURL());
  const siteFail = rec.failedLoads.find((f) => f.main && f.url.startsWith(SITE));
  check('(a) did-fail-load fired for the site main frame with a real error code', !!siteFail && siteFail.code !== -3, j(siteFail));
  check('(a) shouldFallBackToBundle said yes exactly once', rec.fallbackTrue - fb0 === 1, `yes=${rec.fallbackTrue - fb0}`);
  check('(a) the bundle\'s own file: load did not trigger a fallback', rec.failedLoads.filter((f) => f.main && f.url.startsWith('file:')).length === 0);

  // (b) a fresh window: the probe says the site is up, the load fails, BOTH answers run, one loads
  const q0 = rec.quit;
  await closeAllWindows();
  rec.loadFiles.length = 0;
  rec.loadURLs.length = 0;
  const fb1 = rec.fallbackTrue;
  real.app.emit('activate');
  const w2 = await waitFor(() => shellWindow(mainOpts), 5000);
  check('(b) a new main window is created on activate', !!w2);
  await waitFor(() => rec.loadFiles.length > 0, 15000);
  await sleep(6000);
  check('(b) probe up + failed load: the bundle is loaded once, not twice', rec.loadFiles.length === 1, `loadFile calls: ${rec.loadFiles.length}`);
  check('(b) the site was tried first (loadURL to the site)', rec.loadURLs.some((l) => l.url === SITE || l.url === `${SITE}/`), j(rec.loadURLs.map((l) => l.url)));
  // the did-fail-load answer starts the bundle load, which aborts the pending loadURL: its rejection then reads ERR_ABORTED and
  // loadApp's catch stays quiet. The 2 s dedupe in loadLocal is the guard if both ever do answer.
  check('(b) did-fail-load answered the failure once', rec.fallbackTrue - fb1 === 1, `fallback yes=${rec.fallbackTrue - fb1}`);
  check('(b) closing the last window asked the app to quit (recorded, not performed)', rec.quit > q0);

  // (c) the probe fails: straight to the bundle, the site is never tried
  await closeAllWindows();
  state.probe = 'down';
  rec.loadFiles.length = 0;
  rec.loadURLs.length = 0;
  real.app.emit('activate');
  await waitFor(() => shellWindow(mainOpts), 5000);
  await waitFor(() => rec.loadFiles.length > 0, 15000);
  await sleep(3000);
  check('(c) probe down: the bundle is loaded once', rec.loadFiles.length === 1, `loadFile calls: ${rec.loadFiles.length}`);
  check('(c) probe down: the site is never loaded', !rec.loadURLs.some((l) => l.url.startsWith(SITE)), j(rec.loadURLs.map((l) => l.url)));
  check('(6) no uncaught exception', rec.uncaught.length === 0, rec.uncaught.join(' | '));
  state.probe = 'up';
}

// ---- 2. the bridge on the bundle and on untrusted pages -----------------------------------------
async function bridgePhase(bundleWin, LOCAL) {
  section('2', 'The bridge on the bundled copy and on untrusted pages');
  const wc = bundleWin.webContents;
  const d = await ev(wc, "(() => ({ has: typeof window.dsim, desktop: window.dsim && window.dsim.isDesktop, keys: window.dsim ? Object.keys(window.dsim).sort() : [] }))()");
  check('file: (bundle): window.dsim exists', d.has === 'object' && d.desktop === true, j(d));
  const ver = await ev(wc, 'window.dsim.version()', true);
  check('file: dsim.version() answers', ver === real.app.getVersion(), j(ver));
  const lan = await ev(wc, 'window.dsim.lan.status()', true);
  check('file: dsim.lan.status() answers', lan && lan.running === false, j(lan).slice(0, 100));
  const perf = await ev(wc, 'window.dsim.perf.get()', true);
  check('file: dsim.perf.get() answers { unlimitedFps, active }', perf && perf.unlimitedFps === false && perf.active === false, j(perf));
  state.latestTag = 'v0.2.0';
  const chk = await ev(wc, 'window.dsim.check()', true);
  check('file: dsim.check() answers in manual mode (GitHub call stubbed)', chk && chk.mode === 'manual' && chk.current === real.app.getVersion() && chk.updateAvailable === false, j(chk));
  const inst = await ev(wc, 'window.dsim.installUpdate()', true);
  check('file: dsim.installUpdate() answers false (nothing downloaded)', inst === false, j(inst));
  const oa = await ev(wc, "window.dsim.oauth('http://not-https', 'x')", true);
  check('file: dsim.oauth with a non-https URL reaches the handler and is refused as bad-request', oa && oa.error === 'bad-request', j(oa));
  check('file: oauth opened no pop-up window', liveWindows().length === 1, `windows: ${liveWindows().length}`);

  // navigate the SAME window to untrusted pages: the preload must not expose the bridge
  const probes = [
    ['about:blank', 'about:blank'],
    ['a data: page', 'data:text/html,<title>d</title><p>data page</p>'],
    ['http://127.0.0.1 (local server)', LOCAL],
  ];
  for (const [label, url] of probes) {
    try {
      await withTimeout(wc.loadURL(url), 15000, url);
    } catch (e) {
      // a data: or about: load can report as aborted/blocked; the page is what matters
    }
    const has = await ev(wc, "typeof window.dsim");
    check(`untrusted (${label}): window.dsim is ABSENT`, has === 'undefined', `typeof window.dsim = ${has}`);
  }
  // back to the bundle for the rest
  await wc.loadFile(path.join(ROOT, 'dist', 'index.html'));
  await sleep(4000);
}

// ---- 2. raw IPC from a probe window --------------------------------------------------------------
async function probeWindowPhase(LOCAL, pages) {
  section('2', 'The main-process guard, independent of the preload');
  const probe = new real.BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    webPreferences: { preload: path.join(pages, 'raw-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegrationInSubFrames: true, backgroundThrottling: false, offscreen: true },
  });
  const pwc = probe.webContents;
  const baseWindows = liveWindows().length;
  const spawns0 = rec.spawns.length;
  const reloads0 = rec.relaunch;
  const open0 = rec.openExternal.length;
  const rawInvoke = (ch, args = []) => ev(pwc, `window.raw.invoke(${j(ch)}${args.map((a) => ',' + j(a)).join('')})`, true);
  const untrusted = [
    ['http://127.0.0.1', LOCAL],
    ['about:blank', 'about:blank'],
    ['data:', 'data:text/html,<title>d</title>x'],
  ];
  for (const [label, url] of untrusted) {
    try {
      await withTimeout(pwc.loadURL(url), 15000, url);
    } catch {}
    const has = await ev(pwc, 'typeof window.raw');
    if (has !== 'object') {
      check(`untrusted frame (${label}): the raw test bridge exists to probe with`, false, `typeof raw = ${has}`);
      continue;
    }
    const out = {};
    let allForbidden = true;
    for (const ch of EXPECTED_CHANNELS) {
      const args = ch === 'dsim:oauth' ? [{ url: 'https://example.invalid/', callback: 'https://example.invalid/cb' }] : ch === 'dsim:lanStart' ? [{ port: 45872 }] : [];
      const r = await rawInvoke(ch, args);
      out[ch] = r;
      if (!(r && r.error === 'forbidden')) allForbidden = false;
    }
    check(`untrusted frame (${label}): every guarded channel answers { error: 'forbidden' }`, allForbidden, j(out).slice(0, 300));
  }
  check('untrusted calls started nothing: no relaunch, no LAN spawn, no external open, no extra window', rec.relaunch === reloads0 && rec.spawns.length === spawns0 && rec.openExternal.length === open0 && liveWindows().length === baseWindows, `relaunch=${rec.relaunch - reloads0} spawns=${rec.spawns.length - spawns0} opens=${rec.openExternal.length - open0} windows=${liveWindows().length}`);

  // a trusted TOP frame (a file: page) is answered
  await withTimeout(pwc.loadURL(pathToFileUrl(path.join(pages, 'trusted.html'))), 15000, 'trusted.html');
  await waitFor(() => pwc.mainFrame.frames.length > 0, 8000);
  const v = await rawInvoke('dsim:version');
  check('trusted top frame (file:): the same channel answers with the version', v === real.app.getVersion(), j(v));
  const g = await rawInvoke('dsim:getAuto');
  check('trusted top frame: dsim:getAuto answers a boolean', typeof g === 'boolean', j(g));
  // a frame INSIDE the trusted page (its address is trusted, its parent is not null)
  const child = pwc.mainFrame.frames[0];
  const hasRaw = child ? await withTimeout(child.executeJavaScript('typeof window.raw'), 8000, 'child typeof') : 'no-frame';
  if (hasRaw === 'object') {
    const cv = await withTimeout(child.executeJavaScript("window.raw.invoke('dsim:version')"), 8000, 'child invoke');
    check('a sub-frame of a trusted page is refused ({ error: forbidden })', cv && cv.error === 'forbidden', j(cv));
  } else {
    info(`sub-frame probe not run: ${hasRaw}`);
    check('a sub-frame of a trusted page is refused', false, `no raw bridge in the sub-frame (${hasRaw})`);
  }
  await featureBattery(pwc);
  probe.destroy();
}

/** the browser features the app itself uses, in a window that counts as visible (offscreen), so a refusal is the permission handler's */
async function featureBattery(wc) {
  section('3', 'Features the app uses that sit behind a permission');
  const n0 = rec.permSeen.length;
  const code = `(async () => {
    const out = { visibility: document.visibilityState, secure: window.isSecureContext };
    try { const l = await navigator.wakeLock.request('screen'); out.wakeLock = 'GRANTED'; await l.release(); } catch (e) { out.wakeLock = e.name + ': ' + e.message; }
    try { out.persist = String(await navigator.storage.persist()); } catch (e) { out.persist = e.name; }
    try { out.persisted = String(await navigator.storage.persisted()); } catch (e) { out.persisted = e.name; }
    try { out.estimate = typeof (await navigator.storage.estimate()).quota; } catch (e) { out.estimate = e.name; }
    try { out.gamepads = typeof navigator.getGamepads; navigator.getGamepads(); } catch (e) { out.gamepads = e.name; }
    return out;
  })()`;
  const r = await ev(wc, code, true);
  info(`feature battery: ${j(r)}`);
  info(`permission names Chromium put to the handlers meanwhile: ${j(rec.permSeen.slice(n0))}`);
  check('navigator.wakeLock (the LAN host keeps the screen awake) is not refused by the permission handler', r.wakeLock === 'GRANTED', r.wakeLock);
  check('navigator.storage.persist() (the robot library asks for durable storage) is not refused', r.persist === 'true', `persist=${r.persist}`);
  check('storage.estimate and getGamepads work', r.estimate === 'number' && r.gamepads === 'function', j(r));
}
const EXPECTED_CHANNELS = ['dsim:version', 'dsim:check', 'dsim:installUpdate', 'dsim:getAuto', 'dsim:setAuto', 'dsim:openDownload', 'dsim:oauth', 'dsim:getPerf', 'dsim:setPerf', 'dsim:relaunch', 'dsim:lanStart', 'dsim:lanStop', 'dsim:lanStatus'];

// ---- 3. permissions -----------------------------------------------------------------------------
async function permissionsPhase(wc, label) {
  section('3', `Permissions (${label})`);
  const names = ['camera', 'microphone', 'media', 'geolocation', 'notifications', 'midi', 'midiSysex', 'openExternal', 'clipboard-read', 'display-capture', 'sensors', 'idle-detection', 'unknown-permission'];
  const asked = (p) => new Promise((resolve) => captured.permReq({ id: 1 }, p, (granted) => resolve(granted), { requestingUrl: 'https://www.playdsim.com/', isMainFrame: true }));
  let ok = true;
  const seen = {};
  for (const n of names) {
    const r = await asked(n);
    const c = captured.permCheck({ id: 1 }, n, 'https://www.playdsim.com/', { requestingUrl: 'https://www.playdsim.com/', isMainFrame: true });
    seen[n] = [r, c];
    if (r !== false || c !== false) ok = false;
  }
  check(`${label}: the request and check handlers deny camera, microphone, geolocation, notifications and the rest`, ok, j(seen));
  const allowed = {};
  let okAllow = true;
  for (const n of ['fullscreen', 'pointerLock', 'clipboard-sanitized-write']) {
    const r = await asked(n);
    const c = captured.permCheck({ id: 1 }, n, 'https://www.playdsim.com/', { requestingUrl: 'https://www.playdsim.com/', isMainFrame: true });
    allowed[n] = [r, c];
    if (r !== true || c !== true) okAllow = false;
  }
  check(`${label}: the handlers still allow fullscreen, pointer lock and clipboard write`, okAllow, j(allowed));
  if (!ok) {
    check(`${label}: real requests NOT run (the handler test failed, so a camera could open)`, false);
    return;
  }

  const code = `(async () => {
    const out = {};
    try { await navigator.mediaDevices.getUserMedia({ video: true }); out.camera = 'GRANTED'; } catch (e) { out.camera = e.name; }
    try { await navigator.mediaDevices.getUserMedia({ audio: true }); out.microphone = 'GRANTED'; } catch (e) { out.microphone = e.name; }
    out.geolocation = await new Promise((r) => navigator.geolocation.getCurrentPosition(() => r('GRANTED'), (e) => r('code' + e.code), { timeout: 5000 }));
    try { out.notifications = await Notification.requestPermission(); } catch (e) { out.notifications = 'err:' + e.name; }
    out.query = {};
    for (const n of ['camera', 'microphone', 'geolocation', 'notifications', 'clipboard-write', 'midi']) {
      try { out.query[n] = (await navigator.permissions.query({ name: n })).state; } catch (e) { out.query[n] = 'err:' + e.name; }
    }
    return out;
  })()`;
  const r = await ev(wc, code, true);
  info(`${label} renderer answers: ${j(r)}`);
  check(`${label}: camera request denied without a prompt (NotAllowedError)`, r.camera === 'NotAllowedError', r.camera);
  check(`${label}: microphone request denied (NotAllowedError)`, r.microphone === 'NotAllowedError', r.microphone);
  check(`${label}: geolocation request denied (PERMISSION_DENIED, code1)`, r.geolocation === 'code1', r.geolocation);
  check(`${label}: notifications request denied`, r.notifications === 'denied', r.notifications);
  check(`${label}: permissions.query says denied for camera, microphone, geolocation, notifications`, ['camera', 'microphone', 'geolocation', 'notifications'].every((n) => r.query[n] === 'denied'), j(r.query));
  check(`${label}: permissions.query says clipboard-write is granted`, r.query['clipboard-write'] === 'granted', j(r.query['clipboard-write']));

  // a real clipboard write, only when it cannot cost the owner anything (empty or plain-text clipboard)
  const fmts = real.clipboard.availableFormats();
  if (fmts.length === 0 || (fmts.length === 1 && fmts[0] === 'text/plain')) {
    const saved = real.clipboard.readText();
    wc.focus(); // focuses the hidden document inside its (never shown) window; the clipboard API wants a focused document
    await sleep(300);
    const w = await ev(wc, "navigator.clipboard.writeText('dsim-shellcheck').then(() => 'ok', (e) => e.name + ': ' + e.message)", true);
    const landed = !!(await waitFor(() => real.clipboard.readText() === 'dsim-shellcheck', 2000, 100));
    const seen = real.clipboard.readText();
    real.clipboard.writeText(saved);
    // the page's own promise is the test. Whether the text reaches the OS clipboard is not observable from a hidden window:
    // a stock Electron window with no handlers at all resolves the same write and leaves the clipboard empty.
    if (w === 'ok') {
      check(`${label}: a real navigator.clipboard.writeText is accepted (resolves, not NotAllowedError)`, true);
      info(`${label}: it reached the system clipboard: ${landed}${landed ? '' : ' (not observable from a hidden window; a stock Electron window behaves the same)'}`);
      void seen;
    }
    else if (/not focused/i.test(String(w))) info(`${label}: clipboard writeText refused only because the hidden document is not focused (${w}); the permission itself is covered by permissions.query above`);
    else check(`${label}: a real clipboard write is not refused by the permission handler`, false, w);
  } else {
    info(`${label}: the system clipboard holds ${fmts.join(', ')}; the real write was skipped so it is not disturbed`);
  }
}

// ---- 4. ad hosts ----------------------------------------------------------------------------------
async function adPhase(wc) {
  section('4', 'Ad hosts (bundled copy, dead proxy)');
  const hosts = {
    googlesyndication: 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js',
    'googlesyndication apex, http': 'http://googlesyndication.com/x',
    doubleclick: 'https://googleads.g.doubleclick.net/pagead/id',
    googleadservices: 'https://www.googleadservices.com/pagead/conversion.js',
    adtrafficquality: 'https://ep1.adtrafficquality.google/getconfig/sodar',
  };
  const CONTROL = 'https://example.com/shellcheck-control';
  const code = `(async () => {
    const out = {};
    for (const [k, u] of Object.entries(${j(hosts)})) {
      try { await fetch(u, { mode: 'no-cors', cache: 'no-store' }); out[k] = 'LOADED'; } catch (e) { out[k] = 'failed:' + e.name; }
    }
    try { await fetch(${j(CONTROL)}, { mode: 'no-cors', cache: 'no-store' }); out.control = 'LOADED'; } catch (e) { out.control = 'failed:' + e.name; }
    out.script = await new Promise((r) => { const s = document.createElement('script'); s.src = ${j(hosts.googlesyndication + '?client=shellcheck')}; s.onload = () => r('LOADED'); s.onerror = () => r('error'); document.head.appendChild(s); });
    return out;
  })()`;
  const n0 = rec.netErrors.length;
  const r = await ev(wc, code, false);
  const errs = rec.netErrors.slice(n0);
  const errOf = (frag) => (errs.find((e) => e.url.includes(frag)) || {}).error;
  for (const [k, u] of Object.entries(hosts)) {
    const e = errOf(new URL(u).host);
    check(`ad host ${k}: the request fails in the renderer and the error is the filter's (ERR_BLOCKED_BY_CLIENT)`, String(r[k]).startsWith('failed') && e === 'net::ERR_BLOCKED_BY_CLIENT', `${r[k]} / ${e}`);
  }
  check('ad host: a <script> tag for the ad library errors', r.script === 'error', r.script);
  const ce = errOf('example.com');
  check('control: a non-ad host is NOT cancelled by the filter (it fails only at the dead proxy)', String(r.control).startsWith('failed') && ce !== 'net::ERR_BLOCKED_BY_CLIENT', `${r.control} / ${ce}`);
  // the page is still alive and rendering
  const alive = await ev(wc, "document.getElementById('root') && document.getElementById('root').children.length");
  check('the page still works with the ad hosts cancelled (#root rendered)', alive > 0, `children=${alive}`);
}

// ---- 5. links -------------------------------------------------------------------------------------
async function linkPhase(win) {
  section('5', 'Links');
  const wc = win.webContents;
  const click = (html) => ev(wc, `(() => { const d = document.createElement('div'); d.innerHTML = ${j(html)}; document.body.appendChild(d); d.firstElementChild.click(); return true; })()`, true);
  const urlBefore = wc.getURL();
  const wins0 = liveWindows().length;
  let created = 0;
  wc.on('did-create-window', () => created++);

  // positive controls first: they prove the recorder is the shell's `shell`
  const o0 = rec.openExternal.length;
  await ev(wc, "window.open('https://example.com/shellcheck-a', '_blank'); true", true);
  await waitFor(() => rec.openExternal.length > o0, 4000);
  check('window.open of an https URL reaches the recorder', rec.openExternal[o0] === 'https://example.com/shellcheck-a', j(rec.openExternal.slice(o0)));
  const o1 = rec.openExternal.length;
  await click('<a href="https://example.com/shellcheck-b" target="_blank">x</a>');
  await waitFor(() => rec.openExternal.length > o1, 4000);
  check('a target=_blank https link reaches the recorder', rec.openExternal[o1] === 'https://example.com/shellcheck-b', j(rec.openExternal.slice(o1)));
  const o2 = rec.openExternal.length;
  await ev(wc, "window.open('https://example.com/a b?x=1', '_blank'); true", true);
  await waitFor(() => rec.openExternal.length > o2, 4000);
  check('the PARSED href is what is opened (a space becomes %20)', rec.openExternal[o2] === 'https://example.com/a%20b?x=1', j(rec.openExternal.slice(o2)));

  // mailto: a click that would navigate the window
  const m0 = rec.openExternal.length;
  let prevented = null;
  const spy = (ev2) => {
    prevented = ev2.defaultPrevented;
  };
  wc.on('will-navigate', spy);
  await click('<a href="mailto:shellcheck@example.com">mail</a>');
  await waitFor(() => rec.openExternal.length > m0, 4000);
  check('a click on a mailto: link calls the recorder with that mailto: URL', rec.openExternal[m0] === 'mailto:shellcheck@example.com', j(rec.openExternal.slice(m0)));
  check('will-navigate fired for the mailto: link and was prevented by the shell', prevented === true, `defaultPrevented=${prevented}`);
  await sleep(600);
  check('the window did NOT navigate away from the page', wc.getURL() === urlBefore, wc.getURL());
  const m1 = rec.openExternal.length;
  await ev(wc, "location.href = 'mailto:shellcheck2@example.com'; true", true);
  await waitFor(() => rec.openExternal.length > m1, 4000);
  check('location.href = mailto: is handled the same way', rec.openExternal[m1] === 'mailto:shellcheck2@example.com' && wc.getURL() === urlBefore, j(rec.openExternal.slice(m1)));
  wc.removeListener('will-navigate', spy);

  // refused targets: none may reach the recorder (harmless addresses on purpose)
  const bad = [
    'file:///C:/shellcheck-nonexistent.txt',
    'file://127.0.0.1/shellcheck/share',
    'ms-shellcheck-probe:x',
    'search-ms:query=shellcheck',
    'javascript:void(0)',
    'http://example.com/shellcheck-plain-http',
  ];
  const before = rec.openExternal.length;
  const h0 = rec.openHandlerCalls.length;
  for (const u of bad) {
    await ev(wc, `try { window.open(${j(u)}, '_blank'); } catch (e) {} true`, true);
    await sleep(150);
  }
  await sleep(500);
  const handled = rec.openHandlerCalls.slice(h0);
  check('refused targets reached the window-open handler and were denied (the check is not vacuous)', handled.length >= 3 && handled.every((h) => h.result && h.result.action === 'deny'), `handler saw ${handled.length}: ${j(handled.map((h) => h.url))}`);
  check('file:, ms-*:, search-ms:, javascript: and plain http: targets never reach the recorder', rec.openExternal.length === before, j(rec.openExternal.slice(before)));
  // a refused scheme as a same-window navigation
  await click('<a href="ms-shellcheck-probe:y">x</a>');
  await sleep(700);
  check('a click on a non-web scheme link goes nowhere (no recorder call, no navigation)', rec.openExternal.length === before && wc.getURL() === urlBefore, j(rec.openExternal.slice(before)));
  check('no pop-up window was created by any of these', created === 0 && liveWindows().length === wins0, `created=${created} windows ${wins0}->${liveWindows().length}`);
}

// ---- 7. update dialog ------------------------------------------------------------------------------
async function updatePhase() {
  section('7', 'The update dialog (manual mode)');
  if (!bgCheck) {
    check('the 3 s background check was captured from main.cjs', false);
    return;
  }
  check('the 3 s background check was captured from main.cjs', true);
  const prefsFile = path.join(USERDATA, 'update-pref.json');
  try {
    fs.unlinkSync(prefsFile);
  } catch {}
  const run = async (fn) => {
    const c0 = state.latestCalls;
    const d0 = rec.dialogs.length;
    fn();
    await waitFor(() => state.latestCalls > c0, 4000);
    await sleep(500);
    return rec.dialogs.length - d0;
  };
  const prefs = () => {
    try {
      return JSON.parse(fs.readFileSync(prefsFile, 'utf8'));
    } catch {
      return null;
    }
  };
  const cur = real.app.getVersion();
  const menuItem = (() => {
    const find = (items) => {
      for (const it of items) {
        if (/Check for Updates/.test(it.label || '')) return it;
        if (it.submenu) {
          const f = find(it.submenu.items);
          if (f) return f;
        }
      }
      return null;
    };
    return find(real.Menu.getApplicationMenu().items);
  })();
  check('the Help menu has "Check for Updates…"', !!menuItem);

  state.latestTag = 'v99.0.0';
  state.answers = [0]; // press "Download" this once
  const o0 = rec.openExternal.length;
  let n = await run(bgCheck);
  check('a newer version: the background check shows the dialog once', n === 1, `dialogs=${n}`);
  const dlg = rec.dialogs[rec.dialogs.length - 1] || {};
  check('the dialog says which version is available', /99\.0\.0/.test(dlg.message || '') && Array.isArray(dlg.buttons), j(dlg).slice(0, 160));
  check('pressing Download hands the download page to the recorder', rec.openExternal[o0] === `${SITE}/download`, j(rec.openExternal.slice(o0)));
  const p1 = prefs();
  check('the prefs file it wrote is in the scratch user-data directory', fs.existsSync(prefsFile) && real.app.getPath('userData') === USERDATA, prefsFile);
  check('it stored notifiedVersion and notifiedAt', p1 && p1.notifiedVersion === '99.0.0' && typeof p1.notifiedAt === 'number', j(p1));

  n = await run(bgCheck);
  check('the same version again: no dialog', n === 0, `dialogs=${n}`);

  state.latestTag = 'v99.1.0';
  n = await run(bgCheck);
  check('a newer version inside seven days: no dialog', n === 0, `dialogs=${n}`);

  n = await run(() => menuItem.click());
  check('the menu\'s own "Check for Updates" is never suppressed (same version, inside the week)', n === 1, `dialogs=${n}`);
  const mdlg = rec.dialogs[rec.dialogs.length - 1] || {};
  check('...and answers with the available version', /99\.1\.0/.test(mdlg.message || ''), j(mdlg).slice(0, 120));

  state.skew = 8 * 24 * 3600 * 1000;
  n = await run(bgCheck);
  check('a newer version more than seven days after the last dialog: the dialog opens', n === 1, `dialogs=${n}`);
  n = await run(bgCheck);
  check('...and then not again for that version', n === 0, `dialogs=${n}`);
  state.skew = 0;

  state.latestTag = `v${cur}`;
  n = await run(bgCheck);
  check('already up to date: the background check is silent', n === 0, `dialogs=${n}`);
  n = await run(() => menuItem.click());
  const udlg = rec.dialogs[rec.dialogs.length - 1] || {};
  check('already up to date: the menu check says so', n === 1 && /up to date/.test(udlg.message || ''), j(udlg).slice(0, 120));

  state.latestFail = true;
  n = await run(bgCheck);
  check('a failed background check (offline) is silent', n === 0, `dialogs=${n}`);
  n = await run(() => menuItem.click());
  const edlg = rec.dialogs[rec.dialogs.length - 1] || {};
  check('a failed menu check shows the "couldn’t check" notice', n === 1 && /check for updates/i.test(edlg.message || ''), j(edlg).slice(0, 120));
  state.latestFail = false;

  // the auto-check preference gates the background check
  const handler = handlers.get('dsim:setAuto');
  const trustedEvent = { senderFrame: { url: 'file:///x/index.html', parent: null } };
  await handler(trustedEvent, false);
  state.latestTag = 'v99.9.0';
  state.skew = 30 * 24 * 3600 * 1000;
  n = await run(bgCheck);
  await handler(trustedEvent, true);
  check('with the auto-check preference off, the background check does nothing', n === 0, `dialogs=${n}`);
  state.skew = 0;
  state.answers = [];
}

// ---- 7b. the auto-update wiring, with a fake updater -------------------------------------------------
async function autoPhase() {
  section('7', 'The update path in AUTO mode (fake updater; electron-updater itself is not run)');
  const u = fakeUpdater;
  const trustedEvent = { senderFrame: { url: 'file:///x/index.html', parent: null } };
  check('the shell loaded its updater bundle once', fakeLoads === 1, `loads=${fakeLoads}`);
  check('autoDownload and autoInstallOnAppQuit are on, logger off', u.autoDownload === true && u.autoInstallOnAppQuit === true && u.logger === null);
  check('it listens for update-downloaded and error (an error event cannot throw)', u.listenerCount('update-downloaded') === 1 && u.listenerCount('error') === 1);
  let threw = false;
  try {
    u.emit('error', new Error('boom'));
  } catch {
    threw = true;
  }
  check('emitting error on the updater does not throw', !threw);
  check('a 4-hour re-check is scheduled (held back here)', intervals.length === 1, `intervals=${intervals.length}`);
  check('the 3 s background check was captured from main.cjs', typeof bgCheck === 'function');

  const cur = real.app.getVersion();
  const run = async (fn) => {
    const c0 = u.checks;
    const d0 = rec.dialogs.length;
    fn();
    await waitFor(() => u.checks > c0, 4000);
    await sleep(500);
    return rec.dialogs.length - d0;
  };
  const menuItem = (() => {
    const find = (items) => {
      for (const it of items) {
        if (/Check for Updates/.test(it.label || '')) return it;
        if (it.submenu) {
          const x = find(it.submenu.items);
          if (x) return x;
        }
      }
      return null;
    };
    return find(real.Menu.getApplicationMenu().items);
  })();
  state.latestTag = 'v99.0.0';
  let n = await run(bgCheck);
  check('a newer version: the BACKGROUND check starts the download and opens no dialog', n === 0 && u.checks === 1, `dialogs=${n} checks=${u.checks}`);
  const viaIpc = await handlers.get('dsim:check')(trustedEvent);
  check('dsim:check reports { mode: auto, updateAvailable: true, ready: false }', viaIpc && viaIpc.mode === 'auto' && viaIpc.updateAvailable === true && viaIpc.ready === false && viaIpc.latest === '99.0.0', j(viaIpc));
  n = await run(() => menuItem.click());
  const dl = rec.dialogs[rec.dialogs.length - 1] || {};
  check('the menu check says the new version is downloading', n === 1 && /Downloading DSIM 99\.0\.0/.test(dl.message || ''), j(dl).slice(0, 140));
  check('installUpdate before anything is downloaded answers false and installs nothing', handlers.get('dsim:installUpdate')(trustedEvent) === false && u.quits.length === 0);
  u.emit('update-downloaded', { version: '99.0.0' });
  const ready = await handlers.get('dsim:check')(trustedEvent);
  check('after update-downloaded: dsim:check says ready', ready && ready.ready === true, j(ready));
  state.answers = [1]; // "Later"
  n = await run(() => menuItem.click());
  const rd = rec.dialogs[rec.dialogs.length - 1] || {};
  await sleep(200);
  check('the menu check offers "Restart now" / "Later"; Later installs nothing', n === 1 && /ready to install/.test(rd.message || '') && /Restart now/.test((rd.buttons || [])[0] || '') && u.quits.length === 0, j(rd).slice(0, 160));
  state.answers = [0]; // "Restart now"
  n = await run(() => menuItem.click());
  await sleep(300);
  check('"Restart now" calls quitAndInstall(true, true)', n === 1 && u.quits.length === 1 && u.quits[0][0] === true && u.quits[0][1] === true, j(u.quits));
  const inst = handlers.get('dsim:installUpdate')(trustedEvent);
  await sleep(200);
  check('dsim:installUpdate from a trusted page now answers true and calls quitAndInstall', inst === true && u.quits.length === 2, `inst=${inst} quits=${u.quits.length}`);
  const before = u.quits.length;
  const refused = handlers.get('dsim:installUpdate')({ senderFrame: { url: 'https://evil.example/', parent: null } });
  await sleep(200);
  check('dsim:installUpdate from an untrusted page is refused and installs nothing', refused && refused.error === 'forbidden' && u.quits.length === before, j(refused));
  state.latestTag = `v${cur}`;
  u.emit('update-downloaded', { version: cur });
  n = await run(() => menuItem.click());
  const ud = rec.dialogs[rec.dialogs.length - 1] || {};
  check('up to date: the menu check says so', n === 1 && /up to date/.test(ud.message || ''), j(ud).slice(0, 120));
  n = await run(bgCheck);
  check('up to date: the background check is silent', n === 0, `dialogs=${n}`);
  check('relaunch was never called', rec.relaunch === 0);
}

// ---- 8. the LAN host --------------------------------------------------------------------------------
async function lanPhase() {
  section('8', 'LAN host: copy the server bundle when the app\'s is newer');
  const lan = require(path.join(ROOT, 'electron', 'lanHost.cjs'));
  // `process.resourcesPath` is read-only, so the copy rule is run on lanHost.cjs's OWN SOURCE, evaluated
  // with a process whose resourcesPath is the scratch directory (same code, no edit)
  const resources = path.join(TMP, 'resources');
  const fakeProcess = new Proxy(process, {
    get: (t, k) => (k === 'resourcesPath' ? resources : Reflect.get(t, k, t)),
  });
  const lanMod = { exports: {} };
  const lanFile = path.join(ROOT, 'electron', 'lanHost.cjs');
  new Function('require', 'module', 'exports', '__dirname', '__filename', 'process', fs.readFileSync(lanFile, 'utf8'))(require, lanMod, lanMod.exports, path.dirname(lanFile), lanFile, fakeProcess);
  const lanCopy = lanMod.exports;
  check('bundleStale: same size and time is not stale', lan.bundleStale({ size: 5, mtimeMs: 1000 }, { size: 5, mtimeMs: 1000 }) === false);
  check('bundleStale: a different size is stale', lan.bundleStale({ size: 5, mtimeMs: 1000 }, { size: 6, mtimeMs: 1000 }) === true);
  check('bundleStale: a newer source beyond 1 s is stale; within 1 s is not', lan.bundleStale({ size: 5, mtimeMs: 5000 }, { size: 5, mtimeMs: 1000 }) === true && lan.bundleStale({ size: 5, mtimeMs: 1900 }, { size: 5, mtimeMs: 1000 }) === false);

  const scratch = path.join(TMP, 'lanscratch');
  fs.mkdirSync(scratch, { recursive: true });
  const prevNoAsar = process.noAsar;
  const prevDb = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'shellcheck-secret';
  let restored = false;
  try {
    process.noAsar = true; // `app.asar` below is a plain directory
    const srcDir = path.join(resources, 'app.asar', 'dist-server');
    fs.mkdirSync(srcDir, { recursive: true });
    const src = path.join(srcDir, 'lan.mjs');
    const out = path.join(scratch, 'lan-server.mjs');
    const fakeApp = { isPackaged: true, getPath: () => scratch };
    const T1 = new Date(Date.now() - 3600 * 1000);
    const setSrc = (content, when) => {
      fs.writeFileSync(src, content);
      fs.utimesSync(src, when, when);
    };
    const runStart = async () => {
      const s0 = rec.spawns.length;
      const r = await lanCopy.start(fakeApp, { port: 45871 });
      await lanCopy.stop();
      return { r, spawn: rec.spawns[s0] };
    };
    const N = 64;
    setSrc('A'.repeat(N), T1);
    let { r, spawn } = await runStart();
    check('first host: the server bundle is copied out of app.asar', fs.existsSync(out) && fs.readFileSync(out, 'utf8') === 'A'.repeat(N), j(r));
    check('...stamped with the source\'s modification time', Math.abs(fs.statSync(out).mtimeMs - fs.statSync(src).mtimeMs) <= 1000);
    check('the (fake) child was started on the copy, never the in-asar file, with LAN_MODE and no database URL', !!spawn && spawn.args[0] === out && spawn.env.LAN_MODE === '1' && !('DATABASE_URL' in spawn.env), j(spawn && { args: spawn.args, lan: spawn.env.LAN_MODE, db: spawn.env.DATABASE_URL }));
    fs.writeFileSync(out, 'B'.repeat(N));
    fs.utimesSync(out, T1, T1);
    await runStart();
    check('same size, same time: the copy is left alone', fs.readFileSync(out, 'utf8') === 'B'.repeat(N));
    setSrc('C'.repeat(N), new Date(T1.getTime() + 10 * 60 * 1000));
    await runStart();
    check('same size but the app\'s bundle is NEWER: the copy is replaced', fs.readFileSync(out, 'utf8') === 'C'.repeat(N));
    check('...and stamped with the new source time (so the next update compares against the build)', Math.abs(fs.statSync(out).mtimeMs - fs.statSync(src).mtimeMs) <= 1000);
    setSrc('D'.repeat(N + 5), new Date(T1.getTime() - 10 * 60 * 1000));
    await runStart();
    check('a different size is replaced even when the source is older', fs.readFileSync(out, 'utf8') === 'D'.repeat(N + 5));
    check('no real server was started: every spawn went to the fake', rec.spawns.length >= 4 && rec.spawns.every((s) => s.args && s.args[0] === out));
    restored = true;
  } finally {
    process.noAsar = prevNoAsar;
    if (prevDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDb;
    void restored;
  }
}

// ---- end ----------------------------------------------------------------------------------------------
async function finish(server) {
  section('0', 'Whole run');
  sampleVisible();
  check('no window was ever visible (the shell asked to show windows ' + rec.showCalls + ' times; all swallowed)', rec.everVisible === false && rec.realShowEvents === 0, `everVisible=${rec.everVisible} showEvents=${rec.realShowEvents}`);
  check('no uncaught exception or unhandled rejection in the main process', rec.uncaught.length === 0, rec.uncaught.join(' | '));
  check('no renderer process crashed', rec.renderGone.length === 0, j(rec.renderGone));
  check('no error box was shown', rec.errorBoxes.length === 0, j(rec.errorBoxes));
  check('nothing relaunched the app', rec.relaunch === 0, `relaunch=${rec.relaunch}`);
  const benign = /net::ERR_|Failed to fetch|WebSocket|Failed to load resource|ERR_PROXY|ERR_CONNECTION|ERR_BLOCKED|ERR_NAME|NetworkError|AbortError|Load failed/i;
  const bad = rec.consoleErrors.filter((e) => !benign.test(e.message));
  info(`renderer console errors: ${rec.consoleErrors.length} (network-shaped: ${rec.consoleErrors.length - bad.length})`);
  for (const e of bad.slice(0, 8)) info(`  console error: ${e.message.slice(0, 200)}  @ ${e.url.slice(0, 60)}`);
  check('no renderer console error other than failed network requests', bad.length === 0, bad.map((e) => e.message.slice(0, 120)).join(' | '));
  check('nothing was written to the default profile directory (user data went to the scratch directory)', profileBefore === false && !fs.existsSync(defaultProfile), defaultProfile);
  info(`openExternal recorder saw: ${j(rec.openExternal)}`);

  // summary per item
  console.log('\n== summary');
  const items = ['1', '2', '3', '4', '5', '6', '7', '8'];
  for (const it of items) {
    const rs = results.filter((r) => r.item === it);
    const bad2 = rs.filter((r) => !r.ok);
    console.log(`${rs.length === 0 ? 'NOT RUN' : bad2.length ? 'FAIL   ' : 'PASS   '}  item ${it}  (${rs.length - bad2.length}/${rs.length})`);
  }
  console.log(failures === 0 ? '\nSHELLCHECK: ALL PASS' : `\nSHELLCHECK: ${failures} FAILED`);

  clearInterval(visTimer);
  try {
    server.close();
  } catch {}
  for (const w of liveWindows()) {
    try {
      w.destroy();
    } catch {}
  }
  if (!KEEP) {
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {}
  } else console.log(`scratch kept: ${TMP}`);
  realSetTimeout(() => real.app.exit(failures === 0 ? 0 : 1), 200);
}

realSetTimeout(() => {
  console.log('SHELLCHECK WATCHDOG: no result in 5 minutes');
  real.app.exit(2);
}, 300000);

main().catch((e) => {
  failures++;
  console.log(`FAIL  harness crashed: ${e && e.stack ? e.stack : e}`);
  finish({ close() {} }).catch(() => real.app.exit(1));
});
