const { app, BrowserWindow, Menu, dialog, shell, nativeTheme } = require('electron');
const path = require('path');
const https = require('https');

const SITE = 'https://www.playdsim.com';
const LATEST_API = 'https://api.github.com/repos/genius0412/dsim/releases/latest';

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    autoHideMenuBar: true,
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

// ---- update check -------------------------------------------------------
// A cross-platform MANUAL update: quietly on launch and loudly from the menu we
// ask GitHub for the latest release tag and compare it to this app's version; if
// a newer one exists we offer to open the download page. We deliberately do NOT
// auto-INSTALL: Squirrel.Mac auto-update needs a code-signed app and this build is
// unsigned (mac.identity:null), so a real installer would fail on macOS. A
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

async function checkForUpdates(interactive) {
  let latest;
  try {
    latest = await fetchLatestTag();
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
  const current = app.getVersion();
  if (latest && cmpSemver(latest, current) > 0) {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      message: `A new version of DSIM is available (${latest.replace(/^v/, '')}).`,
      detail: `You have ${current}. Open the download page to update?`,
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) shell.openExternal(`${SITE}/download`);
  } else if (interactive) {
    dialog.showMessageBox({
      type: 'info',
      message: 'You’re up to date.',
      detail: `DSIM ${current} is the latest version.`,
      buttons: ['OK'],
    });
  }
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const checkItem = { label: 'Check for Updates…', click: () => checkForUpdates(true) };
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
  // quiet check shortly after launch (only speaks up if there's a newer version)
  setTimeout(() => checkForUpdates(false), 3000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
