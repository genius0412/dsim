/* THE REST OF THE IMPORTER'S UI, IN A REAL WINDOW: Play with an imported robot active (the three
 * tiles it cannot play are disabled and say why), Configure ▸ Controls ▸ Driving (the Stick axes row), the admin
 * page signed out ("Admin sign-in required"), and a replay route that has nothing behind it. Screenshots in both
 * themes at 1440x900 for reading. Needs the alpha dev server and, for the Play tiles, the local game server
 * (the tiles are disabled without any server, with another note).
 *
 *   VITE_APP_CHANNEL=alpha VITE_GAME_SERVER_URL=ws://localhost:8799 npx vite --config scripts/vite.window.config.ts --port 5194 --strictPort
 *   ROBOT_IMPORT=1 PORT=8799 npx tsx server/index.ts
 *   env -u ELECTRON_RUN_AS_NODE npx electron scripts/importui.cjs [--port 5194] [--out scratch/window-pass/importui]
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const argOf = (n, f) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : f; };
const BASE = `http://localhost:${argOf('port', '5194')}`;
const OUT = path.resolve(argOf('out', path.join('scratch', 'window-pass', 'importui')));
fs.mkdirSync(OUT, { recursive: true });
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log('WATCHDOG'); process.exit(2); }, 400000);
const STEP_B64 = fs.readFileSync(path.join(__dirname, 'fixtures', 'robot-import', 'robot.step')).toString('base64');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, useContentSize: true, webPreferences: { backgroundThrottling: false, offscreen: true, partition: `ui-${Date.now()}` } });
  win.webContents.setAudioMuted(true);
  const js = (s) => win.webContents.executeJavaScript(s);
  const until = (e, ms = 15000) => js(`(async () => { for (let t = 0; t < ${ms}; t += 100) { try { if (${e}) return true; } catch {} await new Promise((r) => setTimeout(r, 100)); } return false; })()`);
  let failures = 0;
  const check = (n, ok, d = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok || !d ? '' : ` — ${d}`}`); };
  const shot = async (n) => fs.writeFileSync(path.join(OUT, `${n}.png`), (await win.webContents.capturePage()).toPNG());
  const go = async (r, w = 2500) => { await win.loadURL(BASE + r); await sleep(w); };
  const body = () => js('document.body.innerText');

  await win.loadURL(BASE + '/');
  await js(`localStorage.clear(); localStorage.setItem('decodesim.theme', 'dark'); localStorage.setItem('decodesim.view.v2', '2d'); localStorage.setItem('decodesim.graphics', JSON.stringify({ preset: 'low', tier: 'low' })); true`);
  // an imported robot, saved and active (decode)
  await go('/decode/configure/robot/import', 1500);
  await until(`!!document.querySelector('.ds-import-drop input[type=file]')`, 20000);
  await js(`(() => { const s = atob(${JSON.stringify(STEP_B64)}); const u = Uint8Array.from(s, (c) => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([u], 'robot.step')); const i = document.querySelector('.ds-import-drop input[type=file]'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await until(`!!document.querySelector('.ds-import-filerow')`, 120000);
  await until(`!!document.querySelector('#ri-save-head') && !document.querySelector('#ri-save-head').disabled`, 90000);
  await js(`document.querySelector('#ri-save-head').click()`);
  check('an imported robot is saved and active', await until(`location.pathname.endsWith('/configure/robot') && [...document.querySelectorAll('.ds-panel-title')].some((h) => h.textContent.trim() === 'Imported robot')`, 60000));

  for (const theme of ['dark', 'light']) {
    await js(`localStorage.setItem('decodesim.theme', ${JSON.stringify(theme)}); true`);
    // ── Play with the import active ──
    await go('/decode/modes', 3500);
    const tiles = await js(`[...document.querySelectorAll('.ds-entry, button')].filter((b) => /Ranked|Solo record|Duo record|New room|Browse rooms|Competitions|Solo practice|Free drive/.test(b.textContent.trim().split('\\n')[0])).map((b) => ({ t: b.textContent.trim().replace(/\\s+/g, ' ').slice(0, 90), disabled: b.disabled || b.getAttribute('aria-disabled') === 'true', title: b.title || '' }))`);
    if (theme === 'dark') console.log(`NOTE  Play tiles: ${JSON.stringify(tiles)}`);
    const text = await body();
    const note = /Imported robots can’t play this\. Pick a standard robot\./.test(text);
    if (theme === 'dark') {
      check('Play: the note "Imported robots can’t play this. Pick a standard robot." is shown', note, text.slice(0, 300).replace(/\n/g, ' / '));
      for (const name of ['Ranked', 'Solo record', 'Duo record']) {
        const t = tiles.find((x) => x.t.startsWith(name));
        check(`Play: "${name}" is disabled with an import active`, !!t && t.disabled, JSON.stringify(t));
      }
      for (const name of ['Solo practice', 'Free drive', 'New room']) {
        const t = tiles.find((x) => x.t.startsWith(name));
        check(`Play: "${name}" stays enabled`, !!t && !t.disabled, JSON.stringify(t));
      }
    }
    await shot(`play-${theme}`);
    // ── Controls ▸ Driving ──
    await go('/decode/configure/controls', 2500);
    const row = await js(`(() => { const l = [...document.querySelectorAll('.ds-bind-label')].find((x) => x.textContent.trim() === 'Stick axes'); return l ? l.parentElement.innerText.replace(/\\n+/g, ' | ') : null; })()`);
    if (theme === 'dark') check('Controls ▸ Driving has the Stick axes row', !!row, String(row));
    if (theme === 'dark') console.log(`NOTE  Stick axes row: ${row}`);
    await js(`(() => { const l = [...document.querySelectorAll('.ds-bind-label')].find((x) => x.textContent.trim() === 'Stick axes'); l?.scrollIntoView({ block: 'center' }); })()`);
    await sleep(400);
    await shot(`controls-${theme}`);
    // ── a signed-out admin page ──
    if (theme === 'dark') {
      await go('/admin', 2500);
      check('/admin signed out: "Admin sign-in required"', /Admin sign-in required/.test(await body()), (await body()).slice(0, 200).replace(/\n/g, ' / '));
      await shot('admin');
      // a replay with nothing behind it
      await go('/replay/AAAAAAAA', 4000);
      const t = await body();
      console.log(`NOTE  /replay/AAAAAAAA offline: ${JSON.stringify(t.slice(0, 260))}`);
      check('a replay route with no replay behind it renders a message (not a blank page)', t.trim().length > 40 && !!(await js(`document.querySelector('#root')?.children.length`)));
      await shot('replay-missing');
    }
  }
  console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
  app.exit(failures ? 1 : 0);
});
