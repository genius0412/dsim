/* THE STICK AXES ROW OF THE CONTROLS SCREEN (`src/input/padAxes.ts`, `ControlsSection.tsx`), in the
 * real app. One scripted pad with NO standard mapping, as a browser lists a generic USB pad: six
 * axes, a trigger resting at -1 on axis 2 and another on axis 5, the right stick on axes 3 and 4.
 * Runs in an OFFSCREEN Electron window (nothing is shown, audio is muted); every step is asserted
 * on the DOM and on the stored settings. rAF does not run in a hidden browser tab and the capture
 * polls on rAF, so this cannot be done in a background browser.
 *
 *   npx vite --port 5194 --strictPort            # in another shell
 *   env -u ELECTRON_RUN_AS_NODE npx electron scripts/padsticks.cjs [--port 5194]
 *
 * `npm test` holds the capture's rules, the coercer and the reader on synthetic axes; this holds
 * that the screen drives them: the prompts, the keycap, the saved map, the reset, and the refusal
 * on a pad that is already standard.
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

/** stub ONE pad: `standard` picks the mapping the browser would report */
const PAD = (standard) => `(() => {
  const pad = { id: 'Generic USB Joystick (Vendor: 1234 Product: bead)', index: 0, connected: true,
    mapping: ${standard ? "'standard'" : "''"}, timestamp: 0, axes: [0, 0, -1, 0, 0, -1],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0, touched: false })) };
  window.__pad = pad;
  navigator.getGamepads = () => [pad];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // push one axis to 0.9, let go, with a pause either side for the capture's frames to see it
  window.__push = async (axis) => {
    pad.axes[axis] = 0.9;
    await wait(150);
    pad.axes[axis] = 0;
    await wait(150);
  };
  window.dispatchEvent(new Event('gamepadconnected'));
  return true;
})()`;

/** the Driving card's title line (the live prompt stands in for the title while one is showing) and
 *  the stick keycap, found through the row's own label */
const ROW = `(() => {
  const row = [...document.querySelectorAll('.ds-bind-row')].find((r) => r.querySelector('.ds-bind-label')?.textContent === 'Stick axes');
  if (!row) return null;
  const caps = [...row.querySelectorAll('.ds-key')];
  const panel = row.closest('.ds-panel');
  return {
    cap: caps[0]?.textContent || '',
    capturing: !!caps[0]?.classList.contains('capturing'),
    label: caps[0]?.getAttribute('aria-label') || '',
    remove: caps.length > 1 ? caps[1].textContent : '',
    removeLabel: caps.length > 1 ? caps[1].getAttribute('aria-label') : '',
    status: panel?.querySelector('[role="status"]')?.textContent || '',
  };
})()`;
const CLICK_CAP = `(() => {
  const row = [...document.querySelectorAll('.ds-bind-row')].find((r) => r.querySelector('.ds-bind-label')?.textContent === 'Stick axes');
  row.querySelector('.ds-key').click();
  return true;
})()`;
const CLICK_REMOVE = `(() => {
  const row = [...document.querySelectorAll('.ds-bind-row')].find((r) => r.querySelector('.ds-bind-label')?.textContent === 'Stick axes');
  row.querySelector('.ds-key.remove').click();
  return true;
})()`;
const STORED_PAD = `(() => { try { return JSON.parse(localStorage['decodesim.settings.v1']).bindings.pad; } catch (e) { return null; } })()`;

const PROMPTS = [
  'Push the left stick right. Hold a button to cancel, or Esc.',
  'Push the left stick down. Hold a button to cancel, or Esc.',
  'Push the right stick right. Hold a button to cancel, or Esc.',
  'Push the right stick down. Hold a button to cancel, or Esc.',
];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 1100, show: false, useContentSize: true, webPreferences: { backgroundThrottling: false, offscreen: true } });
  win.webContents.setAudioMuted(true);
  const js = (s) => win.webContents.executeJavaScript(s);
  let failures = 0;
  const check = (name, ok, detail = '') => {
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  };
  const load = async (standard) => {
    await win.loadURL(BASE + '/configure/controls');
    await sleep(4000);
    await js(PAD(standard));
    await sleep(600);
  };

  try {
    // a clean account blob, then the page again so it loads with none
    await win.loadURL(BASE + '/');
    await js(`localStorage.removeItem('decodesim.settings.v1')`);

    // ---- a pad with no standard mapping --------------------------------------------------------
    await load(false);
    const idle = await js(ROW);
    check('the Stick axes row is on the Driving card, standard until set', !!idle && idle.cap === 'STANDARD' && !idle.remove && /standard/.test(idle.label), JSON.stringify(idle));

    await js(CLICK_CAP);
    await sleep(400);
    const armed = await js(ROW);
    check('clicking the keycap arms the capture and the Driving card asks for the left stick, right', armed.capturing && armed.status === PROMPTS[0], JSON.stringify(armed));

    await js(`window.__push(0)`);
    const second = await js(ROW);
    check('...pushing left X (axis 0) moves the prompt on to left stick down', second.status === PROMPTS[1], JSON.stringify(second));
    await js(`window.__push(1)`);
    const third = await js(ROW);
    check('...left Y (axis 1) moves it on to the right stick', third.status === PROMPTS[2], JSON.stringify(third));
    await js(`window.__push(3)`);
    const fourth = await js(ROW);
    check('...right X (axis 3, past a trigger resting at -1 on axis 2) moves it on to the last push', fourth.status === PROMPTS[3] && fourth.capturing, JSON.stringify(fourth));
    await js(`window.__push(4)`);
    await sleep(800);
    const done = await js(ROW);
    check('the keycap reads CUSTOM, the capture is over and the × is there', done.cap === 'CUSTOM' && !done.capturing && done.remove === '×' && done.removeLabel === 'Reset stick axes to standard', JSON.stringify(done));
    const stored = await js(STORED_PAD);
    check('the map is stored on the account blob, in the order pushed', !!stored && JSON.stringify(stored.sticks) === JSON.stringify({ axes: [0, 1, 3, 4], flip: [false, false, false, false] }), JSON.stringify(stored && stored.sticks));

    await js(CLICK_REMOVE);
    await sleep(800);
    const reset = await js(ROW);
    check('× puts the row back to STANDARD', reset.cap === 'STANDARD' && !reset.remove, JSON.stringify(reset));
    const storedReset = await js(STORED_PAD);
    check('...and the stored pad has no sticks field', !!storedReset && !('sticks' in storedReset), JSON.stringify(storedReset));

    // Esc leaves a capture without a map
    await js(CLICK_CAP);
    await sleep(400);
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await sleep(300);
    const esc = await js(ROW);
    check('Esc ends a capture and changes nothing', !esc.capturing && esc.cap === 'STANDARD', JSON.stringify(esc));

    // ---- a pad that is already standard ---------------------------------------------------------
    await load(true);
    await js(CLICK_CAP);
    await sleep(400);
    const std = await js(ROW);
    check('on a standard pad the keycap says so and starts no capture',
      !std.capturing && std.status === 'This controller’s sticks are already in the standard order.', JSON.stringify(std));
  } finally {
    await js(`localStorage.removeItem('decodesim.settings.v1')`).catch(() => {});
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  app.exit(failures === 0 ? 0 : 1);
});
