/* Photographs the imported-robot render harness in both themes, OFFSCREEN (never a visible
 * window): `npx vite scripts/robot-import/render --port 5192` in one shell, then
 *   env -u ELECTRON_RUN_AS_NODE npx electron scripts/robot-import/render/capture.cjs <outDir> [port]
 * Writes `<outDir>/imported-render.<theme>.png` and prints the page's status line.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.resolve(process.argv[2] || 'scratch/imported-render');
const PORT = process.argv[3] || '5192';
fs.mkdirSync(OUT, { recursive: true });
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
setTimeout(() => {
  console.log('WATCHDOG');
  process.exit(2);
}, 240000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400,
    height: 1900,
    show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  win.webContents.setFrameRate(30);
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2) console.log('page:', msg);
  });
  const js = (s) => win.webContents.executeJavaScript(s);
  for (const theme of ['dark', 'light']) {
    await win.loadURL(`http://localhost:${PORT}/?theme=${theme}`);
    for (let i = 0; i < 400; i++) {
      if (await js('window.__done === true')) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    console.log(theme, await js(`document.getElementById('status').textContent`));
    const h = await js('document.documentElement.scrollHeight');
    win.setContentSize(1400, Math.min(4000, h + 16));
    await new Promise((r) => setTimeout(r, 600));
    await win.webContents.capturePage();
    const img = await win.webContents.capturePage();
    const file = path.join(OUT, `imported-render.${theme}.png`);
    fs.writeFileSync(file, img.toPNG());
    console.log('wrote', file);
  }
  app.exit(0);
});
