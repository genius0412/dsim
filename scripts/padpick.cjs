/* WHICH PAD THE MENUS FOLLOW (`src/input/padSelect.ts`), in the real app. Two scripted pads in an
 * OFFSCREEN Electron window: a generic device in slot 0 and an Xbox pad in slot 1, as a browser
 * lists them when the OS has another game controller ahead of the player's. Every step is asserted
 * on the DOM. rAF does not run in a hidden browser tab and the layer polls on rAF, so this cannot
 * be done in a background browser; an offscreen Electron window keeps painting.
 *
 *   npx vite --port 5194 --strictPort            # in another shell
 *   env -u ELECTRON_RUN_AS_NODE npx electron scripts/padpick.cjs [--port 5194]
 *
 * `npm test` holds the picker's rules on synthetic pads; this holds that the layer asks it.
 */
const { app, BrowserWindow } = require('electron');

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = `http://localhost:${argOf('port', '5194')}`;

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log('WATCHDOG'); process.exit(2); }, 120000);

const PADS = `(() => {
  const mk = (index, id, axes) => ({ id, index, connected: true, mapping: 'standard', timestamp: 0, axes,
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0, touched: false })) });
  const other = mk(0, 'Generic USB Joystick (Vendor: 1234 Product: bead)', [0, 0, 0, 0]);
  const mine = mk(1, 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e)', [0, 0, 0, 0]);
  window.__pads = [other, mine];
  navigator.getGamepads = () => window.__pads;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__press = async (slot, i, ms = 90) => {
    const p = window.__pads[slot];
    p.buttons[i] = { pressed: true, value: 1, touched: true };
    await wait(ms);
    p.buttons[i] = { pressed: false, value: 0, touched: false };
    await wait(120);
  };
  window.dispatchEvent(new Event('gamepadconnected'));
  return true;
})()`;

const DOWN = 13, RIGHT = 15;
const STATE = `({ on: document.documentElement.dataset.padnav === 'on',
  focus: document.activeElement && document.activeElement !== document.body ? (document.activeElement.className || document.activeElement.tagName) + '|' + (document.activeElement.textContent || '').trim().slice(0, 24) : '',
  hint: (document.querySelector('.ds-padhint .ds-key')?.textContent || '') })`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, useContentSize: true, webPreferences: { backgroundThrottling: false, offscreen: true } });
  win.webContents.setAudioMuted(true);
  const js = (s) => win.webContents.executeJavaScript(s);
  let failures = 0;
  const check = (name, ok, detail = '') => {
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  };

  await win.loadURL(BASE + '/');
  await sleep(4000);
  await js(PADS);
  await sleep(600);
  const idle = await js(STATE);
  check('two pads listed, nothing pressed: the menus are not in pad mode', !idle.on, JSON.stringify(idle));

  await js(`window.__press(1, ${DOWN})`);
  const first = await js(STATE);
  check('a D-pad press on the pad in slot 1 moves the focus', first.on && first.focus !== '', JSON.stringify(first));
  check('the hint shows that pad’s glyphs (Xbox A), not the slot 0 device’s', first.hint === 'A', `hint "${first.hint}"`);

  await js(`window.__press(1, ${RIGHT})`);
  await js(`window.__press(1, ${DOWN})`);
  const second = await js(STATE);
  check('later presses on it keep moving the focus', second.on && second.focus !== '' && second.focus !== first.focus, `${first.focus} -> ${second.focus}`);

  // the other device presses while the pad is quiet: it takes over, and the glyphs follow
  await sleep(600);
  await js(`window.__press(0, ${DOWN})`);
  const other = await js(STATE);
  check('a press on the other device, with the pad quiet, is read too (glyphs go generic)', other.on && other.hint === '1', `hint "${other.hint}"`);

  await sleep(600);
  await js(`window.__press(1, ${DOWN})`);
  const back = await js(STATE);
  check('...and the pad takes it back on its next press', back.hint === 'A', `hint "${back.hint}"`);

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  app.exit(failures === 0 ? 0 : 1);
});
