const { app, BrowserWindow, Menu, dialog, shell, ipcMain, nativeTheme } = require('electron');
const path = require('path');
const https = require('https');
const fs = require('fs');

const SITE = 'https://www.playdsim.com';
const LATEST_API = 'https://api.github.com/repos/genius0412/dsim/releases/latest';

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    autoHideMenuBar: true,
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
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  return win;
}

// ---- auto-check preference (persisted in userData) ----------------------
const prefPath = () => path.join(app.getPath('userData'), 'update-pref.json');
function getAutoCheck() {
  try {
    return JSON.parse(fs.readFileSync(prefPath(), 'utf8')).autoCheck !== false;
  } catch {
    return true; // default ON
  }
}
function setAutoCheck(v) {
  try {
    fs.writeFileSync(prefPath(), JSON.stringify({ autoCheck: !!v }));
  } catch {
    /* best-effort */
  }
}

// ---- update check -------------------------------------------------------
// We compare this app's version to the latest GitHub release tag. Actual install
// is a one-click trip to the download page — we deliberately do NOT auto-INSTALL:
// Squirrel.Mac auto-update needs a code-signed app and this build is unsigned, so
// check-and-notify behaves identically on Windows, macOS, and Linux.
function cmpSemver(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

function fetchLatestTag() {
  return new Promise((resolve, reject) => {
    const req = https.get(
      LATEST_API,
      { headers: { 'User-Agent': 'DSIM-desktop', Accept: 'application/vnd.github+json' }, timeout: 8000 },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`GitHub ${res.statusCode}`));
          return;
        }
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body).tag_name || '');
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** { current, latest, updateAvailable } — or throws on network failure. */
async function checkLatest() {
  const current = app.getVersion();
  const latest = (await fetchLatestTag()).replace(/^v/, '');
  return { current, latest: latest || null, updateAvailable: !!latest && cmpSemver(latest, current) > 0 };
}

/** interactive (menu/launch) path: native dialog + optional open-download. */
async function promptUpdate(interactive) {
  let r;
  try {
    r = await checkLatest();
  } catch {
    if (interactive) {
      dialog.showMessageBox({
        type: 'warning',
        message: 'Could not check for updates',
        detail: 'Please try again later, or visit playdsim.com.',
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
ipcMain.handle('dsim:getAuto', () => getAutoCheck());
ipcMain.handle('dsim:setAuto', (_e, v) => {
  setAutoCheck(v);
  return getAutoCheck();
});
ipcMain.handle('dsim:openDownload', () => shell.openExternal(`${SITE}/download`));

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
  createWindow();
  // quiet check shortly after launch, only if auto-check is enabled
  setTimeout(() => {
    if (getAutoCheck()) promptUpdate(false);
  }, 3000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
