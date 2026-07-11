const { app, BrowserWindow, nativeTheme } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    autoHideMenuBar: true,
    // tracks --ds-bg in src/ui/shell.css (and THEME_BG in src/theme.ts) — otherwise
    // the window flashes the wrong ground before the renderer first paints.
    // The MAIN process can't read the renderer's localStorage, so this follows the OS.
    // Correct whenever the theme pref is 'system' (the default); if the user has
    // FORCED a theme against their OS, one frame mismatches. Accepted — the fix is an
    // extra IPC/userData round-trip for one frame of polish.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#20262c' : '#f9faf7',
    title: 'DSIM',
  });
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
