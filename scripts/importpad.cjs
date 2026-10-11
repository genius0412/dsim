/* THE IMPORTER, BY CONTROLLER ONLY (lane 4). A pad-only walkthrough of the import editor in an
 * OFFSCREEN Electron window: a scripted standard-mapping gamepad (`navigator.getGamepads` stubbed,
 * `gamepadconnected` fired) drives the real `PadNavLayer` and the editor's grab mode, and every
 * step is asserted on the DOM. rAF does not run in a hidden browser tab, so this cannot be done in
 * a background browser; an offscreen Electron window keeps painting.
 *
 *   npx vite --port 5194 --strictPort            # in another shell (the dev server has the importer;
 *                                                # a production build needs VITE_ROBOT_IMPORT=1)
 *   env -u ELECTRON_RUN_AS_NODE npx electron scripts/importpad.cjs [--port 5194]
 *
 * The one step a pad cannot do is pick a file (an OS dialog): the run hands the editor the STL
 * fixture through its file input, then puts the mouse away for good.
 *
 * Then the ROBOT PAGE, by pad again: the import is saved (Y on Review), and the library row, the
 * Imported robot panel and its dialogs (Rename, Duplicate, Export, Delete, a copy's ✕) are walked
 * and asserted, the export lands as a file (the download is caught, never a dialog), and the page's
 * OUT-OF-DATE state is staged (the synced spec moved under the record) and checked: the line, the
 * footprint in the hero, Import the file in Edit's place, and the lit card a no-op.
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = `http://localhost:${argOf('port', '5194')}`;
const OUT = path.resolve(argOf('out', path.join('scratch', 'importpad')));
fs.mkdirSync(OUT, { recursive: true });

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log('WATCHDOG'); process.exit(2); }, 300000);

const PAD = `(() => {
  const pad = { id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e)', connected: true, mapping: 'standard', index: 0,
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0, touched: false })), axes: [0, 0, 0, 0], timestamp: 0 };
  navigator.getGamepads = () => [pad];
  window.__pad = pad;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__press = async (i, ms = 90) => { pad.buttons[i] = { pressed: true, value: 1, touched: true }; await wait(ms); pad.buttons[i] = { pressed: false, value: 0, touched: false }; await wait(160); };
  window.__hold = (i, on) => { pad.buttons[i] = { pressed: on, value: on ? 1 : 0, touched: on }; };
  window.dispatchEvent(new Event('gamepadconnected'));
  return true;
})()`;

const A = 0, B = 1, X = 2, Y = 3, LB = 4, RB = 5, UP = 12, DOWN = 13, LEFT = 14, RIGHT = 15;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, useContentSize: true, webPreferences: { backgroundThrottling: false, offscreen: true } });
  win.webContents.setAudioMuted(true);
  // an export is a download: caught here and written beside the shots, never a save dialog
  const downloads = [];
  win.webContents.session.on('will-download', (_e, item) => {
    const to = path.join(OUT, item.getFilename());
    item.setSavePath(to);
    item.once('done', (_ev, state) => downloads.push({ to, state }));
  });
  const js = (s) => win.webContents.executeJavaScript(s);
  let failures = 0;
  const check = (name, ok, detail = '') => {
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  };
  const shot = async (name) => fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG());

  await win.loadURL(BASE + '/');
  await js(`localStorage.clear(); localStorage.setItem('decodesim.theme', 'dark');
    new Promise((r) => { const q = indexedDB.deleteDatabase('decodesim.robots'); q.onsuccess = q.onerror = q.onblocked = () => r(1); })`);
  await win.loadURL(BASE + '/decode/configure/robot/import');
  await sleep(1500);
  await js(`(async () => {
    const b = await (await fetch('/scripts/fixtures/robot-import/robot.stl')).blob();
    const input = document.querySelector('.ds-import-drop input[type=file]');
    const dt = new DataTransfer(); dt.items.add(new File([b], 'robot.stl'));
    input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 60 && !document.querySelector('.ds-import-filerow'); i++) await new Promise((r) => setTimeout(r, 200));
    return !!document.querySelector('.ds-import-filerow');
  })()`);
  await sleep(800);
  await js(PAD);
  await sleep(400);
  const tab = () => js(`document.querySelector('.ds-import-steps .ds-tab.on')?.textContent.trim().slice(0, 1)`);
  const active = () => js(`(document.activeElement && (document.activeElement.id || document.activeElement.textContent.trim().slice(0, 30))) || ''`);

  // a first d-pad press puts focus on the page, as the layer does when nothing has it
  await js(`__press(${DOWN})`);
  check('pad: a d-pad press gives the page focus', (await active()) !== '');
  check('pad: the layer marks the pad active (the focus ring shows)', await js(`document.documentElement.dataset.padnav === 'on'`));

  // LB/RB walk the step rail, wherever focus is
  await js(`document.getElementById('ri-h-w0').focus()`);
  await js(`__press(${RB})`);
  check('pad: RB from a control in the body goes to the next STEP, not the next destination', (await tab()) === '2', await tab());
  await js(`__press(${RB})`);
  check('pad: RB again: Mechanisms', (await tab()) === '3', await tab());
  await js(`__press(${LB})`);
  await js(`__press(${LB})`);
  check('pad: LB twice: back on Model', (await tab()) === '1', await tab());
  check('pad: still in the editor (the rail did not take the press)', await js(`location.pathname.endsWith('/configure/robot/import')`));

  // grab a wheel: A grabs, the d-pad moves it, A drops (commit), B cancels (restore)
  await js(`document.getElementById('ri-h-w0').focus(); document.getElementById('ri-h-w0').scrollIntoView({ block: 'center' })`);
  const before = await js(`document.getElementById('ri-h-w0').getAttribute('aria-label')`);
  await js(`__press(${A})`);
  check('pad: A on a handle GRABS it (held)', await js(`document.getElementById('ri-h-w0').classList.contains('held')`));
  check('pad: the map says how to move it, in this pad’s glyphs', /Move with .* or the left stick\. A to drop, B to cancel\./.test(await js(`[...document.querySelectorAll('.ds-import-map-status')].map((e) => e.textContent).join(' ')`)));
  await shot('grabbed');
  for (let i = 0; i < 4; i++) await js(`__press(${UP})`);
  check('pad: while grabbed, the d-pad MOVES the handle (focus stays on it)', (await js(`document.activeElement?.id`)) === 'ri-h-w0');
  await js(`__press(${A})`);
  await sleep(400);
  const after = await js(`document.getElementById('ri-h-w0')?.getAttribute('aria-label')`);
  const fwd = (s) => Number(/([\d.]+) in (forward|back)/.exec(s ?? '')?.[1] ?? NaN) * (/ in back/.test(s ?? '') ? -1 : 1);
  check('pad: A drops it: the wheel moved forward by 4 × 0.25 in', Math.abs(fwd(after) - fwd(before) - 1) < 0.051, `${before} → ${after}`);
  check('pad: dropped, the layer navigates again', !(await js(`document.getElementById('ri-h-w0')?.classList.contains('held')`)));
  await js(`document.getElementById('ri-h-w1').focus()`);
  const b1 = await js(`document.getElementById('ri-h-w1').getAttribute('aria-label')`);
  await js(`__press(${A})`);
  for (let i = 0; i < 3; i++) await js(`__press(${LEFT})`);
  await js(`__press(${B})`);
  await sleep(400);
  check('pad: B cancels a grab and puts the handle back', (await js(`document.getElementById('ri-h-w1')?.getAttribute('aria-label')`)) === b1);
  check('pad: B in a grab does not leave the editor', await js(`location.pathname.endsWith('/configure/robot/import')`));

  // Y is the step's primary action
  await js(`__press(${Y})`);
  check('pad: Y presses the primary action (Next: Drivetrain)', (await tab()) === '2', await tab());
  // a range: ◄► nudge a focused slider through the layer
  await js(`__press(${RB})`);
  await sleep(300);
  await js(`(() => { const r = document.querySelector('.ds-import-body input[type=range]'); r?.scrollIntoView({ block: 'center' }); r?.focus(); return !!r; })()`);
  const v0 = await js(`document.activeElement?.value`);
  await js(`__press(${RIGHT})`);
  check('pad: ◄► nudge a focused range (Mechanisms)', (await js(`document.activeElement?.value`)) !== v0, `${v0}`);
  check('pad: the page root never grows past the window (a hidden line positioned against the page scrolled it blank)', await js(`document.documentElement.scrollHeight <= innerHeight + 1 && scrollY === 0`), await js(`document.documentElement.scrollHeight + ' / ' + innerHeight + ' @ ' + scrollY`));
  await shot('mechanisms');
  // B leaves for the robot page; the draft stays
  await js(`document.querySelector('.ds-import-steps .ds-tab')?.focus()`);
  await js(`__press(${B})`);
  await sleep(800);
  check('pad: B leaves the editor for the robot page', await js(`location.pathname.endsWith('/configure/robot')`));
  check('pad: …and the import waits there as Resume import', await js(`!!document.querySelector('.ds-opt-add') && document.querySelector('.ds-opt-add').textContent.includes('Resume import')`));
  await shot('robot-resume');

  // ── the same editor by KEYBOARD (real key events, not synthetic ones) ──
  await js(`navigator.getGamepads = () => []; true`);
  win.webContents.focus();
  const key = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    // a button activates on Enter's CHAR event (keypress), so Return needs one too
    if (keyCode.length === 1 || keyCode === 'Return') win.webContents.sendInputEvent({ type: 'char', keyCode: keyCode === 'Return' ? '\r' : keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(180);
  };
  await js(`document.querySelector('.ds-opt-add')?.focus(); true`);
  await key('Return');
  await sleep(1500);
  check('keys: Enter on Resume import reopens the editor', await js(`location.pathname.endsWith('/configure/robot/import')`));
  check('keys: …on the step it was left on (Mechanisms)', (await tab()) === '3', await tab());
  await js(`document.querySelector('.ds-import-steps .ds-tab')?.focus(); true`);
  await key('Return');
  await sleep(500);
  check('keys: Enter on a step tab goes to that step', (await tab()) === '1', await tab());
  // Tab order = DOM order = the narrow layout's visual order: rail, preview controls, then the step
  await js(`document.querySelector('.ds-import-steps .ds-tab:last-child')?.focus(); true`);
  await key('Tab');
  check('keys: Tab after the step rail reaches the preview controls next (DOM = narrow visual order)', await js(`!!document.activeElement?.closest('.ds-import-preview, .ds-import-canvas-host') || !!document.activeElement?.closest('.ds-segs')`), await active());
  for (let i = 0; i < 8 && !(await js(`!!document.activeElement?.closest('.ds-import-body')`)); i++) await key('Tab');
  check('keys: …and a few Tabs later, the step itself', await js(`!!document.activeElement?.closest('.ds-import-body')`), await active());
  // handles: arrows 1/4 in, Shift 1/16 in, Home back to the import's placement
  await js(`document.getElementById('ri-h-w2').focus(); true`);
  const k0 = await js(`document.getElementById('ri-h-w2').getAttribute('aria-label')`);
  await key('Up');
  await key('Up');
  const k1 = await js(`document.getElementById('ri-h-w2').getAttribute('aria-label')`);
  check('keys: ↑ twice moves a wheel 0.5 in forward', Math.abs(fwd(k1) - fwd(k0) - 0.5) < 0.051, `${k0} → ${k1}`);
  check('keys: an arrow on a handle does not scroll or leave it', (await js(`document.activeElement?.id`)) === 'ri-h-w2');
  await key('Home');
  await sleep(300);
  const k2 = await js(`document.getElementById('ri-h-w2').getAttribute('aria-label')`);
  check('keys: Home puts the wheel back where the import placed it', Math.abs(fwd(k2) - fwd(k0)) < 0.051, `${k0} → ${k2}`);
  // Next by Enter; the discard dialog opens and Escape closes it, nothing else leaves on Escape
  await js(`[...document.querySelectorAll('.ds-import-foot .ds-btn')].find((b) => b.classList.contains('primary'))?.focus(); true`);
  await key('Return');
  await sleep(400);
  check('keys: Enter on Next: Drivetrain', (await tab()) === '2', await tab());
  await key('Escape');
  await sleep(300);
  check('keys: Escape outside a dialog does not leave the editor', await js(`location.pathname.endsWith('/configure/robot/import')`));
  const discard = await js(`(() => { const b = [...document.querySelectorAll('.ds-head .ds-btn')].find((x) => /Discard/.test(x.textContent)); b?.focus(); return !!b; })()`);
  if (discard) {
    await key('Return');
    await sleep(400);
    check('keys: Discard asks first (a dialog, focus inside it)', await js(`!!document.activeElement?.closest('.ds-modal')`));
    await key('Escape');
    await sleep(400);
    check('keys: Escape closes the dialog and hands focus back to Discard', await js(`!document.querySelector('.ds-modal') && /Discard/.test(document.activeElement?.textContent ?? '')`), await active());
  } else check('keys: a Discard button in the foot', false);
  await shot('keys-drivetrain');

  // ── THE ROBOT PAGE, BY PAD: the library row, the Imported robot panel, its dialogs ──
  await js(PAD);
  await sleep(300);
  const until = (expr, ms = 15000) => js(`(async () => { for (let t = 0; t < ${ms}; t += 100) { try { if (${expr}) return true; } catch {} await new Promise((r) => setTimeout(r, 100)); } return false; })()`);
  const focus = (expr) => js(`(() => { const e = ${expr}; if (!e) return false; e.scrollIntoView({ block: 'center' }); e.focus(); return document.activeElement === e; })()`);
  const btnIn = (scope, text) => `[...document.querySelectorAll(${JSON.stringify(scope)})].find((b) => b.textContent.trim() === ${JSON.stringify(text)})`;
  const panelBtn = (text) => btnIn('.ds-panel .ds-btn', text);
  await js(`__press(${RB})`);
  await js(`__press(${RB})`);
  check('pad: RB twice from Drivetrain: Review', (await tab()) === '4', await tab());
  await js(`__press(${Y})`);
  check('pad: Y on Review saves the robot and lands on the robot page', await until(`location.pathname.endsWith('/configure/robot') && [...document.querySelectorAll('.ds-panel-title')].some((h) => h.textContent.trim() === 'Imported robot')`));
  await sleep(600);
  const cards = () => js(`document.querySelectorAll('.ds-robot-card .ds-badge').length ? [...document.querySelectorAll('.ds-robot-card')].filter((c) => c.querySelector('.ds-badge')?.textContent === 'Imported').length : 0`);
  check('library row: one imported card, lit (it is the active robot), with its picture', (await cards()) === 1 &&
    (await js(`!!document.querySelector('.ds-robot-card.on .ds-import-thumb') || !!document.querySelector('.ds-robot-card.on svg')`)));
  check('library row: the hero shows the import (its picture) and the Imported badge', await js(`!!document.querySelector('.ds-hero .ds-import-hero-img') && /Imported/.test(document.querySelector('.ds-hero-name')?.textContent ?? '')`));
  await shot('robot-saved');
  // the lit card is the active robot: A on it changes nothing (an old copy cannot be re-applied)
  const specNow = () => js(`localStorage.getItem('decodesim.settings.v1')`);
  const s0 = await specNow();
  await focus(`document.querySelector('.ds-robot-card.on')`);
  await js(`__press(${A})`);
  await sleep(300);
  check('library row: A on the lit card is a no-op (the settings are untouched)', (await specNow()) === s0);
  // d-pad reachability: from the card, DOWN reaches the panel's actions
  let reached = false;
  for (let i = 0; i < 12 && !reached; i++) {
    await js(`__press(${DOWN})`);
    reached = await js(`!!document.activeElement?.closest('.ds-panel') && document.activeElement.classList.contains('ds-btn') && [...document.querySelectorAll('.ds-panel-title')].some((h) => h.textContent.trim() === 'Imported robot' && h.closest('.ds-panel').contains(document.activeElement))`);
  }
  check('panel: the d-pad reaches the Imported robot panel’s actions from the library row', reached, await active());
  // Rename: A opens it with focus inside, B closes it and hands focus back
  await focus(panelBtn('Rename'));
  await js(`__press(${A})`);
  check('panel: A on Rename opens the dialog with focus inside it', await until(`!!document.activeElement?.closest('.ds-modal') && !!document.querySelector('.ds-modal input')`, 4000));
  await shot('dialog-rename');
  await js(`__press(${B})`);
  check('panel: B closes Rename and hands focus back to it', await until(`!document.querySelector('.ds-modal') && document.activeElement?.textContent.trim() === 'Rename'`, 4000), await active());
  // Duplicate: a second card
  await focus(panelBtn('Duplicate'));
  await js(`__press(${A})`);
  check('panel: A on Duplicate adds a second card, named "… copy"', await until(`[...document.querySelectorAll('.ds-robot-card')].some((c) => /copy/.test(c.textContent))`, 6000));
  // the copy's ✕: B cancels, A on the dialog's Delete removes it
  await focus(`[...document.querySelectorAll('.ds-opt-slot')].find((s) => /copy/.test(s.textContent))?.querySelector('.ds-opt-del')`);
  await js(`__press(${A})`);
  check('library row: A on a card’s ✕ asks first (a dialog naming the robot)', await until(`!!document.querySelector('.ds-modal') && /copy/.test(document.querySelector('.ds-dialog-title')?.textContent ?? '')`, 4000));
  await shot('dialog-delete-copy');
  await js(`__press(${B})`);
  check('library row: B cancels it (the copy stays, focus back on its ✕)', await until(`!document.querySelector('.ds-modal') && document.activeElement?.classList.contains('ds-opt-del')`, 4000) && (await cards()) === 2, await active());
  await js(`__press(${A})`);
  await until(`!!document.querySelector('.ds-modal')`, 4000);
  await focus(btnIn('.ds-modal .ds-btn', 'Delete'));
  await js(`__press(${A})`);
  check('library row: A on the dialog’s Delete removes the copy, the active robot stays', await until(`![...document.querySelectorAll('.ds-robot-card')].some((c) => /copy/.test(c.textContent))`, 6000) && (await cards()) === 1 &&
    (await js(`[...document.querySelectorAll('.ds-panel-title')].some((h) => h.textContent.trim() === 'Imported robot')`)));
  // Export: a real file, caught
  await focus(panelBtn('Export file'));
  await js(`__press(${A})`);
  for (let i = 0; i < 60 && !downloads.length; i++) await sleep(100);
  const dl = downloads[0];
  check('panel: A on Export file writes the share file (a .glb, caught, no dialog)', !!dl && dl.state === 'completed' && /\.glb$/.test(dl.to) && fs.statSync(dl.to).size > 1000, dl ? `${dl.state} ${dl.to}` : 'no download');
  // Delete (the ACTIVE robot): it asks, says what you will drive instead, and B closes it
  await focus(panelBtn('Delete'));
  await js(`__press(${A})`);
  check('panel: A on Delete asks first and names the robot you will drive instead', await until(`!!document.querySelector('.ds-modal') && /You’ll drive/.test(document.querySelector('.ds-modal')?.textContent ?? '')`, 4000));
  await shot('dialog-delete-active');
  await js(`__press(${B})`);
  check('panel: B closes it, nothing deleted', await until(`!document.querySelector('.ds-modal')`, 4000) && (await cards()) === 1);
  // ── OUT OF DATE: the synced spec moves under this device's record (an edit on another device) ──
  await js(`(() => { const k = 'decodesim.settings.v1'; const s = JSON.parse(localStorage.getItem(k)); const h = s.spec.imported.heightIn; s.spec.imported.heightIn = h <= 17.5 ? h + 0.5 : h - 0.5; localStorage.setItem(k, JSON.stringify(s)); return true; })()`);
  await win.loadURL(BASE + '/decode/configure/robot');
  await sleep(1200);
  await js(PAD);
  check('stale: the panel says the model here is out of date, in one line, with the way to update it', await until(`/out of date/.test(document.querySelector('.ds-panel .ds-hint.warn')?.textContent ?? '') && /newest exported file/.test(document.querySelector('.ds-panel .ds-hint.warn')?.textContent ?? '')`, 6000));
  check('stale: the hero shows the footprint, not the old picture', await js(`!document.querySelector('.ds-hero .ds-import-hero-img') && !!document.querySelector('.ds-hero svg')`));
  check('stale: Edit is replaced by Import the file, in the panel head', await js(`(() => { const h = [...document.querySelectorAll('.ds-panel-title')].find((t) => t.textContent.trim() === 'Imported robot')?.closest('.ds-panel-h'); const b = h?.querySelector('.ds-btn'); return !!b && b.textContent.trim() === 'Import the file'; })()`));
  await shot('robot-stale');
  const s1 = await specNow();
  await focus(`document.querySelector('.ds-robot-card.on')`);
  await js(`__press(${A})`);
  await sleep(300);
  check('stale: A on the (out-of-date) lit card does not put the old spec back', (await specNow()) === s1);
  await focus(`[...document.querySelectorAll('.ds-panel-h .ds-btn')].find((b) => b.textContent.trim() === 'Import the file')`);
  await js(`__press(${A})`);
  check('stale: A on Import the file opens the importer', await until(`location.pathname.endsWith('/configure/robot/import')`, 4000));

  console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
  app.exit(failures ? 1 : 0);
});
