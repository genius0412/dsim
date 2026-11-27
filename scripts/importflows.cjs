/* THE ROBOT IMPORTER, END TO END, IN A REAL WINDOW (run before the importer goes public).
 * One OFFSCREEN, MUTED Electron window on an in-memory partition (so a run leaves nothing on the machine
 * and every flow starts from an empty library); every step is asserted on the DOM, and the app's own
 * console warnings and errors are collected per flow.
 *
 *   # an ALPHA-channel dev server (the importer is compiled in only there, or on any dev server):
 *   VITE_APP_CHANNEL=alpha npx vite --config scripts/vite.window.config.ts --port 5194 --strictPort
 *   # then, from the repo root:
 *   env -u ELECTRON_RUN_AS_NODE npx electron scripts/importflows.cjs [--port 5194] [--only f1,f2] [--out scratch/window-pass/importflows]
 *
 * Flows (see the header of each):
 *   f1  import a fixture, every step to Review, Save, find it on Play, test drive in each game, the robot
 *       drawn (not a placeholder) at graphics Low; f9 (the sharing line on Review) and f10
 *       (`navigator.storage.persist` only from the Save click) are asserted inside it
 *   f2  Replace with a cut-off file: a BANNER with Dismiss, the step stays usable, Dismiss clears it,
 *       leaving the Model step clears it
 *   f3  Back mid-read stops the read (no worker alive within 2 s) and leaves no Resume card
 *   f4  during a Detail re-read Save (header and Review), Export and Test drive are disabled and say why
 *   f5  a stored draft that cannot be measured: an error with Discard, never an endless "Measuring…"
 *   f6  "Restored your unsaved changes." only after a real edit, and only until the next one
 *   f7  wheels at the footprint edge, and a model reaching outside the robot box, are blocked in Review
 *   f7b a model reaching outside the robot box (needs: npx tsx scripts/importflows-boom.ts)
 *   f8  share files: export and add back, a cut-off one, an oversized one
 *
 * It needs the vite server's repo files (the fixtures are fetched from `/scripts/fixtures/robot-import/`).
 * Never shown, never audible. Exit code 1 on any FAIL.
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = `http://localhost:${argOf('port', '5194')}`;
const OUT = path.resolve(argOf('out', path.join('scratch', 'window-pass', 'importflows')));
const ONLY = (argOf('only', '') || '').split(',').filter(Boolean);
const SIZE = argOf('size', '1440x900').split('x').map(Number);
fs.mkdirSync(OUT, { recursive: true });

// --gpu keeps hardware GL: BIOBUZZ's 3D view refuses a software renderer and falls back to 2D, so the 3D
// checks need it (offscreen, graphics Low)
if (!process.argv.includes('--gpu')) app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log('WATCHDOG'); process.exit(2); }, Number(argOf('watchdog', '1500')) * 1000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE[0], height: SIZE[1], show: false, useContentSize: true,
    webPreferences: { backgroundThrottling: false, offscreen: true, partition: `importflows-${Date.now()}` },
  });
  win.webContents.setAudioMuted(true);
  const downloads = [];
  win.webContents.session.on('will-download', (_e, item) => {
    const to = path.join(OUT, `dl-${downloads.length}-${item.getFilename()}`);
    item.setSavePath(to);
    item.once('done', (_ev, state) => downloads.push({ to, state }));
  });
  let consoleLog = [];
  win.webContents.on('console-message', (...a) => {
    const d = a[0] && typeof a[0] === 'object' && 'level' in a[0] ? a[0] : { level: a[1], message: a[2] };
    const lvl = typeof d.level === 'string' ? ({ warning: 2, error: 3 }[d.level] ?? 1) : d.level;
    if (lvl >= 2) consoleLog.push(`${lvl === 3 ? 'error' : 'warn'}: ${String(d.message).slice(0, 300)}`);
  });
  const js = (s) => win.webContents.executeJavaScript(s);
  let failures = 0;
  let flow = '';
  const results = [];
  const check = (name, ok, detail = '') => {
    if (!ok) failures++;
    results.push({ flow, name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  [${flow}] ${name}${ok || !detail ? '' : ` — ${detail}`}`);
    return ok;
  };
  const note = (s) => console.log(`NOTE  [${flow}] ${s}`);
  const shot = async (name) => {
    const f = path.join(OUT, `${flow.replace(/[^a-z0-9]+/gi, "_")}-${name}.png`);
    fs.writeFileSync(f, (await win.webContents.capturePage()).toPNG());
    return f;
  };
  const until = (expr, ms = 15000) =>
    js(`(async () => { for (let t = 0; t < ${ms}; t += 100) { try { if (${expr}) return true; } catch {} await new Promise((r) => setTimeout(r, 100)); } return false; })()`);
  const text = (sel) => js(`document.querySelector(${JSON.stringify(sel)})?.textContent?.trim() ?? null`);
  /** click the first element of `scope` whose text is (or, with `has`, contains) `t`; one click per call */
  const click = async (scope, t, has = false) => {
    const r = await js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope)})].find((x) => ${has ? `x.textContent.includes(${JSON.stringify(t)})` : `x.textContent.trim() === ${JSON.stringify(t)}`}); if (!b) return 'missing'; if (b.disabled) return 'disabled'; b.click(); return 'ok'; })()`);
    await sleep(160);
    return r;
  };
  /** wait for a button (the robot page loads its library after the panel title shows), then click it */
  const clickWhenThere = async (scope, t, has = false) => {
    await until(`[...document.querySelectorAll(${JSON.stringify(scope)})].some((x) => ${has ? `x.textContent.includes(${JSON.stringify(t)})` : `x.textContent.trim() === ${JSON.stringify(t)}`})`, 15000);
    return click(scope, t, has);
  };
  const clickSel = async (sel) => {
    const r = await js(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return 'missing'; if (b.disabled) return 'disabled'; b.click(); return 'ok'; })()`);
    await sleep(160);
    return r;
  };
  const tab = () => js(`[...document.querySelectorAll('.ds-import-steps .ds-tab')].findIndex((t) => t.classList.contains('on'))`);
  const path_ = () => js(`location.pathname`);
  const bodyText = () => js(`document.body.innerText`);
  const fixB64 = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'robot-import', name)).toString('base64');
  /** a File made in the page from base64 bytes (or from the vite-served fixture) */
  const FILE_JS = (b64, name, slice) => `(() => { const s = atob(${JSON.stringify(b64)}); let u = Uint8Array.from(s, (c) => c.charCodeAt(0)); ${slice ? `u = u.slice(0, Math.floor(u.length * ${slice}));` : ''} return new File([u], ${JSON.stringify(name)}); })()`;
  const setFiles = (inputSel, fileExpr) =>
    js(`(() => { const input = document.querySelector(${JSON.stringify(inputSel)}); if (!input) return false; const dt = new DataTransfer(); dt.items.add(${fileExpr}); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const DROP_INPUT = '.ds-import-drop input[type=file]';

  /** a clean device: no settings, no library, dark theme, graphics Low, the stubs the flows read */
  const fresh = async (extra = '') => {
    await win.loadURL(BASE + '/');
    await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('decodesim.theme', 'dark');
      localStorage.setItem('decodesim.graphics', JSON.stringify({ preset: 'low', tier: 'low' }));
      localStorage.setItem('decodesim.view.v2', '3d');
      new Promise((r) => { const q = indexedDB.deleteDatabase('decodesim.robots'); q.onsuccess = q.onerror = q.onblocked = () => r(1); })`);
    consoleLog = [];
  };
  /** counters the flows read: workers made and still alive, and every navigator.storage call */
  const STUBS = `(() => {
    if (window.__stubbed) return true; window.__stubbed = true;
    window.__persist = { persist: 0, persisted: 0, at: [] };
    try {
      navigator.storage.persisted = async () => { window.__persist.persisted++; return false; };
      navigator.storage.persist = async () => { window.__persist.persist++; window.__persist.at.push(location.pathname); return true; };
    } catch (e) { window.__persist.error = String(e); }
    const W = window.Worker; window.__workers = [];
    window.Worker = function (u, o) {
      const w = new W(u, o); const rec = { url: String(u).split('/').pop().split('?')[0], alive: true, t0: Date.now(), t1: 0 };
      window.__workers.push(rec); const t = w.terminate.bind(w);
      w.terminate = () => { if (rec.alive) { rec.alive = false; rec.t1 = Date.now(); } t(); };
      return w;
    };
    window.Worker.prototype = W.prototype;
    return true; })()`;
  const open = async (route) => {
    await win.loadURL(BASE + route);
    await js(STUBS);
    await sleep(400);
  };
  /** the importer on `game`, a fixture dropped and read, ready (measured, the build and the moving parts found) */
  const importFixture = async (game, fixture = 'robot.step', opts = {}) => {
    if (!opts.keep) await fresh();
    await open(`/${game}/configure/robot/import`);
    const ok1 = await until(`!!document.querySelector('${DROP_INPUT}')`, 20000);
    if (!ok1) return false;
    await setFiles(DROP_INPUT, FILE_JS(fixB64(fixture), fixture));
    const ok2 = await until(`!!document.querySelector('.ds-import-filerow')`, 120000);
    if (!ok2) return false;
    // the editor reads the build and the moving parts by itself; the header Save waits for it
    return until(`!!document.querySelector('#ri-save-head') && !document.querySelector('#ri-save-head').disabled`, 90000);
  };
  const goStep = async (i) => {
    await js(`document.querySelectorAll('.ds-import-steps .ds-tab')[${i}]?.click()`);
    await sleep(250);
  };
  const reviewReady = () => until(`(() => { const t = document.querySelector('.ds-import-body .ds-panel-title')?.textContent ?? ''; return t && !/Preparing|Measuring/.test(t); })()`, 60000);
  const savedOnRobotPage = () => until(`location.pathname.endsWith('/configure/robot') && [...document.querySelectorAll('.ds-panel-title')].some((h) => h.textContent.trim() === 'Imported robot')`, 60000);
  /** import a fixture and save it from the header, ending on the robot page */
  const saveRobot = async (game = 'decode', fixture = 'robot.step') => {
    if (!(await importFixture(game, fixture))) return false;
    await clickSel('#ri-save-head');
    return savedOnRobotPage();
  };
  const endOfFlow = (extraNote = '') => {
    const errs = consoleLog.filter((l) => l.startsWith('error'));
    if (errs.length) note(`console errors (${errs.length}): ${[...new Set(errs)].slice(0, 4).join(' | ')}`);
    const warns = consoleLog.filter((l) => l.startsWith('warn'));
    if (warns.length) note(`console warnings (${warns.length}): ${[...new Set(warns)].slice(0, 3).join(' | ')}`);
    if (extraNote) note(extraNote);
  };

  const flows = {};

  // ───────────────────────────── f1 (+ f9, f10) ─────────────────────────────
  flows.f1 = async () => {
    const games = (argOf('games', 'decode,chain,biobuzz')).split(',');
    for (const game of games) {
      flow = `f1:${game}`;
      const ready = await importFixture(game);
      if (!check(`${game}: the fixture reads and the editor is ready (Save enabled)`, ready, await text('.ds-panel-title'))) { await shot('not-ready'); continue; }
      const persist0 = await js(`window.__persist.persist`);
      check(`${game}: navigator.storage.persist not called by the import (f10)`, persist0 === 0, `calls ${persist0}`);
      check(`${game}: Model step shows the file`, /robot\.step/.test((await text('.ds-import-filerow')) ?? ''), await text('.ds-import-filerow'));
      if (game === games[0]) await shot('model');
      // every step to Review, by the primary Next
      const names = ['Drivetrain', 'Mechanisms', 'Moving parts', 'Review'];
      for (let i = 0; i < 4; i++) {
        const r = await click('.ds-import-foot .ds-btn.primary', `Next: ${names[i]}`);
        const okTab = await until(`[...document.querySelectorAll('.ds-import-steps .ds-tab')].findIndex((t) => t.classList.contains('on')) === ${i + 1}`, 5000);
        check(`${game}: Next to ${names[i]}`, r === 'ok' && okTab, `${r} tab ${await tab()}`);
        if (game === games[0]) await shot(`step-${names[i].replace(/ /g, '-').toLowerCase()}`);
      }
      await reviewReady();
      const title = await text('.ds-import-body .ds-panel-title');
      const items = await js(`[...document.querySelectorAll('.ds-import-checks li')].map((l) => l.className + ': ' + l.textContent.trim())`);
      note(`Review: "${title}" · ${items.join(' | ')}`);
      check(`${game}: Review has no blocking item`, !/to fix/.test(title ?? '') && !items.some((i) => i.startsWith('bad')), `${title}`);
      const hint = await js(`[...document.querySelectorAll('.ds-import-body .ds-hint')].map((h) => h.textContent.trim()).find((t) => /everyone sees/.test(t)) ?? null`);
      check(`${game}: Review says what a room sees and that the picture and model are shared only by choice (f9)`, hint === 'In a room, everyone sees this robot’s outline and measurements. Its picture and 3D model are sent only if you choose to share them.', String(hint));
      if (game === games[0]) await shot('review');
      const robotName = await js(`document.getElementById('ri-name')?.value ?? ''`);
      // ── test drive ──
      const td = await clickSel('#ri-testdrive');
      check(`${game}: Test drive starts a drive (the game view opens)`, td === 'ok' && (await until(`!!document.querySelector('.game-btn') && !!document.querySelector('canvas')`, 60000)), td);
      await sleep(4000);
      const assets = await js(`(async () => {
        const ia = await import('/src/render/importedAssets.ts');
        let slots = [];
        try { const m = await import('/src/games/biobuzz/scene/renderImported.ts'); slots = m.importedMeshSlots(); } catch (e) { slots = ['ERR ' + e]; }
        return { sizes: ia.importedAssetCacheSizes(), slots, canvas: document.querySelectorAll('canvas').length };
      })()`);
      note(`drive assets: ${JSON.stringify(assets)}`);
      if (game === 'biobuzz') {
        const ready3d = assets.slots.some((s) => Array.isArray(s) && s[1] === 'ready' && s[2] > 0);
        check(`biobuzz: the 3D view draws the imported robot's model, not a placeholder (a mesh slot ready and in use)`, ready3d, JSON.stringify(assets.slots));
      } else {
        check(`${game}: the 2D view has the robot's picture (a top image cached, not the footprint placeholder)`, assets.sizes.tops >= 1, JSON.stringify(assets.sizes));
      }
      await shot('drive');
      check(`${game}: the drive has no console errors`, !consoleLog.some((l) => l.startsWith('error')), consoleLog.filter((l) => l.startsWith('error')).slice(0, 2).join(' | '));
      const pAfterDrive = await js(`window.__persist.persist`);
      check(`${game}: still no navigator.storage.persist after a test drive (f10)`, pAfterDrive === 0, `calls ${pAfterDrive}`);
      await click('.game-btn', 'EDITOR', true);
      check(`${game}: EDITOR returns to the importer, on Review`, (await until(`location.pathname.endsWith('/configure/robot/import') && !!document.getElementById('ri-testdrive')`, 20000)), `${await path_()} tab ${await tab()}`);
      await reviewReady();
      // ── Save ──
      const before = await js(`window.__persist.persist`);
      const save = await click('.ds-import-foot .ds-btn.primary', 'Save robot');
      check(`${game}: Save robot clicks`, save === 'ok', save);
      check(`${game}: lands on the robot page with the Imported robot panel`, await savedOnRobotPage(), await path_());
      await sleep(1200);
      const persists = await js(`({ persist: window.__persist.persist, persisted: window.__persist.persisted, at: window.__persist.at })`);
      check(`${game}: navigator.storage.persist was called once, from the Save (before: ${before}) (f10)`, before === 0 && persists.persist === 1 && persists.persisted >= 1, JSON.stringify(persists));
      if (game === games[0]) await shot('robot-page');
      // ── find it on Play ──
      await open(`/${game}/modes`);
      await sleep(2500);
      const play = await bodyText();
      check(`${game}: Play lists the imported robot ("${robotName}")`, robotName ? play.includes(robotName) : false, play.slice(0, 200).replace(/\n/g, ' / '));
      await shot('play');
      endOfFlow();
    }
  };

  // ───────────────────────────── f2 ─────────────────────────────
  flows.f2 = async () => {
    flow = 'f2';
    if (!(await importFixture('decode'))) return check('a model is loaded', false, await text('.ds-panel-title'));
    const step = fixB64('robot.step');
    const bad = Buffer.from('ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1=NOT_A_REAL_ENTITY(;\n', 'utf8').toString('base64');
    for (const [label, b64, slice, name] of [['a cut-off STEP (60%)', step, 0.6, 'cut.step'], ['a garbage STEP', bad, 0, 'garbage.step']]) {
      await goStep(0);
      await setFiles('.ds-import-filerow input[type=file]', FILE_JS(b64, name, slice || 0));
      const staged = await until(`!!document.getElementById('ri-start')`, 8000);
      if (!check(`${label}: Replace stages the file (Start import, Keep current model)`, staged, (await text('.ds-import-body')) ?? '')) continue;
      await clickSel('#ri-start');
      const banner = await until(`!!document.querySelector('.ds-import-body [role=alert] .ds-hint.err') || !!document.querySelector('.ds-import-body .rec-track') === false && !!document.querySelector('.ds-import-filerow')`, 120000);
      await sleep(600);
      const alertText = await js(`document.querySelector('.ds-import-body [role=alert] .ds-hint.err')?.textContent ?? null`);
      const loaded = await js(`!!document.querySelector('.ds-import-filerow')`);
      note(`${label}: banner ${JSON.stringify(alertText)} · model still shown: ${loaded}`);
      if (!alertText) { check(`${label}: an error BANNER appears`, false, `no banner; the read ${loaded ? 'succeeded (model shown)' : 'left no model'}; body: ${(await text('.ds-import-body'))?.slice(0, 200)}`); await shot('nobanner'); continue; }
      check(`${label}: an error BANNER appears above the Model step`, !!alertText);
      check(`${label}: the banner has Dismiss`, await js(`!!document.getElementById('ri-dismiss')`));
      await shot('banner');
      // Units, Wheels (the map), parts and Detail still usable
      const units0 = await js(`document.querySelector('#ri-units select')?.value`);
      const usable = await js(`(() => ({ units: !!document.querySelector('#ri-units select') && !document.querySelector('#ri-units select').disabled,
        up: !!document.querySelector('#ri-up select') && !document.querySelector('#ri-up select').disabled,
        wheels: !!document.querySelector('#ri-wheels'), parts: !!document.querySelector('#ri-parts button:not([disabled])'),
        detail: !!document.querySelector('#ri-detail .ds-opt:not([disabled]), #ri-detail button:not([disabled])'), turn: !!document.querySelector('#ri-front button:not([disabled])') }))()`);
      check(`${label}: Units, Up axis, Front, Wheels, Parts and Detail are present and enabled under the banner`, Object.values(usable).every(Boolean), JSON.stringify(usable));
      await js(`(() => { const s = document.querySelector('#ri-units select'); const o = [...s.options].find((x) => x.value !== s.value); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, o.value); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await sleep(900);
      const units1 = await js(`document.querySelector('#ri-units select')?.value`);
      check(`${label}: Units can be changed under the banner (${units0} → ${units1}) and the banner stays`, units1 !== units0 && !!(await js(`!!document.querySelector('[role=alert] .ds-hint.err')`)));
      await js(`(() => { const s = document.querySelector('#ri-units select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(units0)}); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await sleep(600);
      await clickSel('#ri-dismiss');
      await sleep(300);
      check(`${label}: Dismiss clears the banner`, await js(`!document.querySelector('[role=alert] .ds-hint.err')`));
      check(`${label}: focus moved to the step's first control, not the page`, (await js(`document.activeElement?.closest('#ri-front, .ds-import-body') !== null`)), await js(`document.activeElement?.tagName + '#' + document.activeElement?.id`));
      // again, then leave the Model step
      await goStep(0);
      await setFiles('.ds-import-filerow input[type=file]', FILE_JS(b64, name, slice || 0));
      await until(`!!document.getElementById('ri-start')`, 8000);
      await clickSel('#ri-start');
      await until(`!!document.querySelector('.ds-import-body [role=alert] .ds-hint.err')`, 120000);
      await goStep(1);
      await goStep(0);
      await sleep(300);
      check(`${label}: leaving the Model step clears the banner`, await js(`!document.querySelector('[role=alert] .ds-hint.err')`));
    }
    endOfFlow();
  };

  // ───────────────────────────── f3 ─────────────────────────────
  flows.f3 = async () => {
    for (const delay of [0, 250, 600]) {
      flow = `f3:${delay}ms`;
      await fresh();
      await open('/decode/configure/robot/import');
      await until(`!!document.querySelector('${DROP_INPUT}')`, 20000);
      await setFiles(DROP_INPUT, FILE_JS(fixB64('robot.step'), 'robot.step'));
      // Back is pressed `delay` ms after the progress bar first shows, from inside the page (no round trip)
      const pressed = await js(`(async () => { for (let i = 0; i < 4000; i++) { if (document.querySelector('.rec-track')) { await new Promise((r) => setTimeout(r, ${delay})); const bar = !!document.querySelector('.rec-track'); const label = document.querySelector('.ds-import-drop .od')?.textContent; window.__t0 = Date.now(); document.querySelector('.ds-back').click(); return { bar, label, workers: window.__workers.filter((w) => w.alive).map((w) => w.url) }; } await new Promise((r) => setTimeout(r, 5)); } return null; })()`);
      if (!check('the read starts (a progress bar shows) and Back is pressed', !!pressed, 'no bar')) continue;
      note(`Back pressed ${delay} ms in: still reading ${pressed.bar} ("${pressed.label}"), workers ${pressed.workers.join(', ') || '(none)'}`);
      const gone = await until(`window.__workers.filter((w) => w.alive).length === 0`, 2500);
      const took = await js(`Date.now() - window.__t0`);
      const alive = await js(`window.__workers.filter((w) => w.alive).map((w) => w.url)`);
      check(`no worker alive within 2 s of Back (${took} ms)`, gone, `alive: ${alive.join(', ')}`);
      await sleep(2500);
      check('Back landed on the robot page', (await path_()).endsWith('/configure/robot'), await path_());
      const card = await js(`[...document.querySelectorAll('.ds-opt-add')].map((c) => c.textContent.trim())`);
      if (pressed.bar) check('read stopped mid-way: the robot page shows NO "Resume import" card', !card.some((c) => /Resume import/.test(c)), JSON.stringify(card));
      else note(`the read had finished when Back was pressed, so a draft is expected: cards ${JSON.stringify(card)}`);
      const late = await js(`({ alive: window.__workers.filter((w) => w.alive).map((w) => w.url), total: window.__workers.length })`);
      check('no worker alive 2.5 s later (the read did not carry on)', late.alive.length === 0, JSON.stringify(late));
      await js(`document.querySelector('.ds-opt-add')?.click()`);
      await until(`location.pathname.endsWith('/import')`, 8000);
      await sleep(1500);
      const reopened = await js(`({ reading: !!document.querySelector('.rec-track'), empty: !!document.getElementById('ri-choose') && !document.querySelector('.ds-import-filerow'), model: !!document.querySelector('.ds-import-filerow'), text: document.querySelector('.ds-import-body')?.innerText.slice(0, 120) })`);
      if (pressed.bar) check('reopening the importer shows an empty drop box (no read, no model)', !reopened.reading && reopened.empty, JSON.stringify(reopened));
      else note(`reopened: ${JSON.stringify(reopened)}`);
      await shot('reopened');
      endOfFlow();
    }
  };

  // ───────────────────────────── f4 ─────────────────────────────
  flows.f4 = async () => {
    flow = 'f4';
    if (!(await importFixture('decode'))) return check('a model is loaded', false);
    await goStep(0);
    const c = await js(`(() => { const b = [...document.querySelectorAll('#ri-detail button, #ri-detail .ds-opt')].find((x) => /Light/.test(x.textContent)); if (!b) return 'missing'; b.click(); return 'ok'; })()`);
    check('Detail: Light clicks', c === 'ok', c);
    // a fixture re-reads in a fraction of a second, so everything that must be seen while it is still running is read in ONE
    // call: the Model step's header Save, then (through the rail) Review's buttons and status line
    const snap = await js(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const t0 = Date.now(); while (!document.querySelector('.rec-track') && Date.now() - t0 < 10000) await sleep(5);
      const hb = document.getElementById('ri-save-head');
      const model = { head: hb ? { disabled: hb.disabled, title: hb.title } : null, bar: !!document.querySelector('.rec-track') };
      document.querySelectorAll('.ds-import-steps .ds-tab')[4]?.click();
      await sleep(120);
      const get = (t) => { const b = [...document.querySelectorAll('.ds-import-foot .ds-btn')].find((x) => x.textContent.trim() === t); return b ? { disabled: b.disabled, title: b.title, desc: b.getAttribute('aria-describedby') } : null; };
      const rev = { tab: [...document.querySelectorAll('.ds-import-steps .ds-tab')].findIndex((t) => t.classList.contains('on')), status: document.querySelector('.ds-import-body .ds-panel-title')?.textContent, save: get('Save robot'), exp: get('Export file'), drive: get('Test drive'), why: document.getElementById('ri-why')?.textContent };
      return { model, rev };
    })()`);
    const { model, rev } = snap;
    check('a re-read starts (a progress bar)', model.bar);
    check('header Save is disabled and says why (Model step)', model.bar && !!model.head && model.head.disabled && /Wait for the file to finish reading/.test(model.head.title), JSON.stringify(model));
    note(`Review during the re-read: ${JSON.stringify(rev)}`);
    const stillReading = /^Reading/.test(rev.status ?? '');
    check('Review opened while the read was still running (its status says Reading…)', stillReading, rev.status);
    for (const [k, label] of [['save', 'Review Save'], ['exp', 'Export'], ['drive', 'Test drive']]) {
      const b = rev[k];
      check(`${label} is disabled and says why during the re-read`, !!b && b.disabled && /Wait for the file to finish reading/.test(b.title) && b.desc === 'ri-why', JSON.stringify(b));
    }
    await shot('reread-review');
    // it settles; they come back
    const done = await until(`!/^Reading/.test(document.querySelector('.ds-import-body .ds-panel-title')?.textContent ?? 'Reading')`, 90000);
    await sleep(800);
    const after = await js(`({ tab: [...document.querySelectorAll('.ds-import-steps .ds-tab')].findIndex((t) => t.classList.contains('on')), status: document.querySelector('.ds-import-body .ds-panel-title')?.textContent, foot: [...document.querySelectorAll('.ds-import-foot .ds-btn')].map((b) => b.textContent.trim() + (b.disabled ? ' (disabled)' : '')), model: !!document.querySelector('.ds-import-filerow') })`);
    note(`after the re-read: ${JSON.stringify(after)}`);
    await shot('reread-after');
    check('the re-read finished', done, JSON.stringify(after));
    // a Detail re-read leaves the player on the step they moved to: Review, not the Model step
    check('the re-read lands on the step the player was on (Review), not the Model step', after.tab === 4, JSON.stringify(after));
    if (after.tab !== 4) { note('the editor is not on Review after the re-read; going back to Review'); await goStep(4); await reviewReady(); }
    const settled = await js(`['Save robot', 'Export file', 'Test drive'].map((t) => { const b = [...document.querySelectorAll('.ds-import-foot .ds-btn')].find((x) => x.textContent.trim() === t); return b ? !b.disabled : null; })`);
    check('after the re-read lands, Save, Export and Test drive are enabled again', settled.every((x) => x === true), JSON.stringify(settled));
    endOfFlow();
  };

  // ───────────────────────────── f5 ─────────────────────────────
  flows.f5 = async () => {
    for (const mode of (argOf('corrupt', 'empty,nan,junk')).split(',')) {
      flow = `f5:${mode}`;
      if (!(await importFixture('decode'))) { check('a model is loaded', false); continue; }
      await js(`document.querySelector('.ds-back')?.click()`);
      await until(`location.pathname.endsWith('/configure/robot')`, 8000);
      await sleep(1500);
      check('Back leaves a draft: the robot page offers Resume import', await js(`[...document.querySelectorAll('.ds-opt-add')].some((c) => /Resume import/.test(c.textContent))`));
      // the stored model cannot be measured: empty (no triangles), NaN positions, or not a model at all
      const r = await js(`new Promise((resolve) => {
        const q = indexedDB.open('decodesim.robots');
        q.onerror = () => resolve('open failed');
        q.onsuccess = () => {
          const db = q.result; const tx = db.transaction('draftModels', 'readwrite'); const st = tx.objectStore('draftModels');
          const all = st.openCursor(); let n = 0;
          all.onsuccess = () => { const c = all.result; if (!c) return; const v = c.value;
            if (${JSON.stringify(mode)} === 'empty') { v.parts = []; if (v.full) v.full = []; v.trisOut = 0; }
            else if (${JSON.stringify(mode)} === 'nan') { for (const p of v.parts) p.positions = new Float32Array(p.positions.length).fill(NaN); if (v.full) v.full = v.parts; }
            else { v.parts = [{ positions: 'abc', indices: null, color: [1, 1, 1], name: 'x' }]; delete v.full; }
            c.update(v); n++; c.continue(); };
          tx.oncomplete = () => { db.close(); resolve('rows ' + n); };
          tx.onerror = () => resolve('tx error ' + tx.error);
        };
      })`);
      note(`corrupted the stored draft model (${mode}): ${r}`);
      await win.loadURL(BASE + '/decode/configure/robot');
      await js(STUBS);
      await until(`[...document.querySelectorAll('.ds-opt-add')].some((c) => /Resume import/.test(c.textContent))`, 10000);
      await js(`[...document.querySelectorAll('.ds-opt-add')].find((c) => /Resume import/.test(c.textContent))?.click()`);
      await until(`location.pathname.endsWith('/import')`, 8000);
      // never an endless "Measuring…": within 30 s the editor shows a model or an error, and a way out
      const stuck = await until(`!/Measuring…|Restoring your import…|Loading the importer…/.test(document.querySelector('.ds-import-body, .ds-panel')?.innerText ?? document.body.innerText)`, 30000);
      await sleep(1500);
      const state = await js(`({ body: (document.querySelector('.ds-import-body')?.innerText ?? document.body.innerText).slice(0, 360), alert: [...document.querySelectorAll('[role=alert]')].map((a) => a.textContent.trim().slice(0, 200)),
        status: document.querySelector('.ds-import-body .ds-panel-title')?.textContent, buttons: [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter((t) => /Discard|Choose|Undo|Back|Replace|Try/.test(t)), size: document.querySelector('.ds-facts dd')?.textContent?.slice(0, 40) })`);
      note(`after Resume: ${JSON.stringify(state)}`);
      check(`${mode}: the editor does not stay on "Measuring…" (30 s)`, stuck, state.body);
      check(`${mode}: Discard is on screen`, state.buttons.some((t) => /^Discard/.test(t)), JSON.stringify(state.buttons));
      // a model with no extent (no triangles, NaN positions) is a failed measurement, said as one: never a
      // "0.0 × 0.0 × 0.0 in" robot that fits; a junk model is the crash screen's
      if (mode === 'junk') check(`${mode}: the player is told (an error sentence)`, state.alert.length > 0 || /Couldn’t/.test(state.body ?? '') || /Couldn’t/.test(state.status ?? ''), JSON.stringify(state));
      else {
        check(`${mode}: the measurement-failure sentence with its exits (not a 0 x 0 x 0 in robot that fits)`, /Couldn’t measure this model\./.test(state.body ?? '') && !/^0\.0 × 0\.0/.test(state.size ?? '') && !/Fits 18 in/i.test(state.body ?? '') && !/^Measuring/.test(state.status ?? ''), JSON.stringify(state));
        check(`${mode}: Choose another file is on screen (an exit besides Discard)`, state.buttons.some((t) => /^Choose/.test(t)), JSON.stringify(state.buttons));
      }
      await shot('after-resume');
      const boundary = await js(`!!document.querySelector('.ds-empty[role=alert]')`);
      const d = boundary ? await clickWhenThere('.ds-empty .ds-btn', 'Discard this import') : await clickWhenThere('.ds-head .ds-btn', 'Discard', true);
      await sleep(400);
      // the crash screen asks inline (its own Discard / Cancel), the editor's header in a dialog
      const dlg = boundary ? await js(`!![...document.querySelectorAll('.ds-empty .ds-btn')].find((b) => b.textContent.trim() === 'Discard')`) : await js(`!!document.querySelector('.ds-modal')`);
      check(`${mode}: Discard asks first (a dialog)`, d === 'ok' && dlg, `${d} dialog ${dlg}`);
      await js(`[...document.querySelectorAll('.ds-modal .ds-btn, .ds-empty .ds-btn')].find((x) => x.textContent.trim() === 'Discard')?.click()`);
      await sleep(1500);
      const after = await js(`({ path: location.pathname, resume: [...document.querySelectorAll('.ds-opt-add')].some((c) => /Resume import/.test(c.textContent)) })`);
      check(`${mode}: Discard works (no Resume import left)`, !after.resume, JSON.stringify(after));
      await win.loadURL(BASE + '/decode/configure/robot');
      await sleep(1500);
      check(`${mode}: after a reload there is still no Resume import`, await js(`![...document.querySelectorAll('.ds-opt-add')].some((c) => /Resume import/.test(c.textContent))`));
      endOfFlow();
    }
  };

  // ───────────────────────────── f6 ─────────────────────────────
  flows.f6 = async () => {
    flow = 'f6';
    if (!(await saveRobot('decode'))) return check('a robot is saved', false);
    const status = () => js(`document.querySelector('.ds-import-body .ds-panel-title')?.textContent?.trim() ?? ''`);
    const editBtn = () => clickWhenThere('.ds-panel-h .ds-btn', 'Edit in the importer', true);
    const openEdit = async () => { const r = await editBtn(); await until(`/\\/import\\/[0-9a-f]{16}$/.test(location.pathname) && !!document.querySelector('.ds-import-filerow')`, 60000); await sleep(1000); return r; };
    const back = async () => { await js(`document.querySelector('.ds-back')?.click()`); await until(`location.pathname.endsWith('/configure/robot')`, 8000); await sleep(1800); };
    const RESTORED = 'Restored your unsaved changes.';
    const nudge = async (delta) => {
      // Wheelbase, the first number field of the Wheels block, typed
      const v = await js(`(() => { const f = [...document.querySelectorAll('#ri-wheels .ds-field')].find((x) => /Wheelbase/.test(x.textContent)); const i = f?.querySelector('input'); if (!i) return null; const next = String(Math.round((Number(i.value) + (${delta})) * 16) / 16); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, next); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return next; })()`);
      await sleep(900);
      return v;
    };
    check('Edit in the importer opens the saved robot', (await openEdit()) === 'ok');
    check('first open: no "Restored your unsaved changes."', (await status()) !== RESTORED, await status());
    await back();
    check('the robot page shows no Resume import after only opening a saved robot', await js(`![...document.querySelectorAll('.ds-opt-add')].some((c) => /Resume import/.test(c.textContent))`));
    await openEdit();
    check('open, Back, open again: still no "Restored your unsaved changes."', (await status()) !== RESTORED, await status());
    const n1 = await nudge(0.5);
    check('a wheel edit lands (Wheelbase)', n1 !== null, String(n1));
    await back();
    await openEdit();
    check('edit a wheel, Back, reopen: the line "Restored your unsaved changes." appears', (await status()) === RESTORED, await status());
    await shot('restored');
    const n2 = await nudge(-0.25);
    check('the next edit lands', n2 !== null, String(n2));
    check('…and the line disappears on that edit', (await status()) !== RESTORED, await status());
    // a rename on the robot page while the edit draft exists survives a later Save
    await back();
    await js(`(() => { const p = [...document.querySelectorAll('.ds-panel')].find((x) => x.querySelector('.ds-panel-title')?.textContent.trim() === 'Imported robot'); const el = p.querySelector('input[type=text]'); el.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'Renamed Bot'); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    await sleep(1200);
    await openEdit();
    await goStep(4);
    await reviewReady();
    const nm = await js(`document.getElementById('ri-name')?.value`);
    check('a rename on the robot page, then Edit: the editor holds the new name', nm === 'Renamed Bot', String(nm));
    await click('.ds-import-foot .ds-btn.primary', 'Save changes');
    await savedOnRobotPage();
    await sleep(800);
    const stored = await js(`[...document.querySelectorAll('.ds-robot-card')].map((c) => c.textContent.trim().slice(0, 40))`);
    check('Save changes keeps the new name on the robot page', stored.some((s) => /Renamed Bot/.test(s)), JSON.stringify(stored));
    endOfFlow();
  };

  // ───────────────────────────── f7 ─────────────────────────────
  flows.f7 = async () => {
    flow = 'f7';
    if (!(await importFixture('decode'))) return check('a model is loaded', false);
    const setField = async (label, v) => {
      const r = await js(`(() => { const f = [...document.querySelectorAll('#ri-wheels .ds-field')].find((x) => x.querySelector('.cap')?.textContent.startsWith(${JSON.stringify(label)})); const i = f?.querySelector('input'); if (!i) return null; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(String(v))}); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return i.value; })()`);
      await sleep(900);
      return r;
    };
    const dims = await js(`document.querySelector('.ds-facts')?.innerText`);
    note(`model facts: ${JSON.stringify(dims)}`);
    const len = Number(/([\d.]+) × ([\d.]+) × ([\d.]+)/.exec(dims ?? '')?.[1] ?? 14);
    const edge = Math.max(0.5, len / 2 - 0.2);
    note(`footprint length ${len} in: putting the wheel centre ${edge.toFixed(2)} in forward of the footprint middle (the edge)`);
    const got = await setField('Centre forward', edge.toFixed(2));
    check('Centre forward can be typed at the footprint edge', got !== null, String(got));
    await goStep(4);
    await reviewReady();
    const title = await text('.ds-import-body .ds-panel-title');
    const items = await js(`[...document.querySelectorAll('.ds-import-checks li')].map((l) => l.className + ': ' + l.textContent.replace(/\\s+/g, ' ').trim())`);
    note(`Review: "${title}" · ${items.join(' | ')}`);
    const edgeItem = items.find((i) => /edge of the footprint/.test(i));
    check('Review blocks wheels at the footprint edge, with a next step (a Fix button)', !!edgeItem && edgeItem.startsWith('bad') && /Drag the wheels toward the middle/.test(edgeItem), JSON.stringify(items));
    check('the footer Save is disabled and says "Fix the checks above first."', await js(`(() => { const b = [...document.querySelectorAll('.ds-import-foot .ds-btn')].find((x) => x.textContent.trim() === 'Save robot'); return !!b && b.disabled && /Fix the checks above first/.test(b.title); })()`));
    await shot('origin-edge');
    const fix = await js(`(() => { const b = [...document.querySelectorAll('.ds-import-checks li')].find((l) => /edge of the footprint/.test(l.textContent))?.querySelector('button'); if (!b) return 'missing'; b.click(); return 'ok'; })()`);
    await sleep(500);
    check('Fix goes to the Wheels on the Model step', fix === 'ok' && (await tab()) === 0, `${fix} tab ${await tab()}`);
    await setField('Centre forward', 0);
    await goStep(4);
    await reviewReady();
    check('with the wheels back in the middle the block is gone', await js(`![...document.querySelectorAll('.ds-import-checks li')].some((l) => /edge of the footprint/.test(l.textContent))`));
    endOfFlow();
  };

  // ───────────────────────────── f8 ─────────────────────────────
  flows.f8 = async () => {
    flow = 'f8';
    if (!(await saveRobot('decode'))) return check('a robot is saved', false);
    // export
    const n0 = downloads.length;
    let ex = await clickWhenThere('.ds-panel .ds-btn', 'Export file');
    for (let t = 0; t < 40 && ex === 'disabled'; t++) { await sleep(250); ex = await click('.ds-panel .ds-btn', 'Export file'); }
    note(`Export file click: ${ex}`);
    for (let i = 0; i < 200 && downloads.length === n0; i++) await sleep(100);
    const dl = downloads[downloads.length - 1];
    if (!check('Export file writes a .glb', downloads.length > n0 && dl.state === 'completed' && /\.glb$/.test(dl.to), JSON.stringify(dl))) { await shot('no-export'); return; }
    const bytes = fs.readFileSync(dl.to);
    note(`share file ${bytes.length} bytes`);
    const b64 = bytes.toString('base64');
    // add it back: the editor's drop box
    await open('/decode/configure/robot/import');
    const there = await until(`!!document.querySelector('${DROP_INPUT}')`, 20000);
    note(`importer route with a saved robot on the device: drop box ${there}, path ${await path_()}, h1 ${await text('h1')}`);
    // 1) the same robot again: the file's robot IS the account's active robot, so it replaces the record
    //    under the active id without asking (rule 2 of the active-robot section) and lands on the robot page
    await setFiles(DROP_INPUT, FILE_JS(b64, 'share.glb'));
    const back1 = await until(`location.pathname.endsWith('/configure/robot')`, 30000);
    await sleep(1200);
    const cards1 = await js(`[...document.querySelectorAll('.ds-robot-card')].filter((c) => c.querySelector('.ds-badge')?.textContent === 'Imported').length`);
    const heroName = await text('.ds-hero-name');
    check('the share file adds back: lands on the robot page, one imported robot (adopted by id, not a second copy)', back1 && cards1 === 1, `cards ${cards1}`);
    note(`hero after the add: ${heroName}`);
    await shot('share-added');
    // 2) delete the robot, then add the file: it comes back, drawn from the share file's model
    await clickWhenThere('.ds-panel .ds-btn', 'Delete');
    await until(`!!document.querySelector('.ds-modal')`, 8000);
    await js(`[...document.querySelectorAll('.ds-modal .ds-btn')].find((x) => x.textContent.trim() === 'Delete')?.click()`);
    await sleep(1500);
    check('Delete removes it (no imported robot left)', await js(`![...document.querySelectorAll('.ds-robot-card')].some((c) => c.querySelector('.ds-badge')?.textContent === 'Imported')`));
    await open('/decode/configure/robot/import');
    await until(`!!document.querySelector('${DROP_INPUT}')`, 20000);
    await setFiles(DROP_INPUT, FILE_JS(b64, 'share.glb'));
    const back2 = await until(`location.pathname.endsWith('/configure/robot') && [...document.querySelectorAll('.ds-robot-card')].some((c) => c.querySelector('.ds-badge')?.textContent === 'Imported')`, 30000);
    await sleep(1200);
    check('after deleting, the share file adds the robot back', back2);
    const picture = await js(`!!document.querySelector('.ds-hero .ds-import-hero-img') || !!document.querySelector('.ds-robot-card.on .ds-import-thumb')`);
    check('…and its picture (from the share file) shows', picture);
    await shot('share-readded');
    // it plays: the 3D mesh and top come out of the share file
    const added = await js(`document.querySelector('.ds-notice, .ds-toast, [role=status]')?.textContent ?? ''`);
    note(`notice: ${added}`);
    // cut-off share file
    for (const [label, file, expect] of [
      ['a cut-off share file', FILE_JS(b64, 'cut.glb', 0.6), /cut short or damaged\. Download it again/],
      ['a share file with a wrong magic', FILE_JS(Buffer.from('not a glb at all, just words'.repeat(20)).toString('base64'), 'words.glb'), /Couldn’t (import|read|open|add)/],
    ]) {
      await open('/decode/configure/robot/import');
      await until(`!!document.querySelector('${DROP_INPUT}')`, 20000);
      const t0 = Date.now();
      await setFiles(DROP_INPUT, file);
      await until(`!!document.querySelector('.ds-import-drop [role=alert]') || !!document.getElementById('ri-start')`, 10000);
      if (await js(`!!document.getElementById('ri-start')`)) await clickSel('#ri-start');
      await until(`!!document.querySelector('.ds-import-drop [role=alert]')`, 15000);
      const msg = await text('.ds-import-drop [role=alert]');
      check(`${label}: refused with its own sentence within 5 s (${Date.now() - t0} ms)`, !!msg && expect.test(msg) && Date.now() - t0 < 5000, String(msg));
      note(`${label}: "${msg}"`);
      await shot(label.replace(/ /g, '-'));
    }
    // oversized: 131 MiB of shared Blob, named .glb
    await open('/decode/configure/robot/import');
    await until(`!!document.querySelector('${DROP_INPUT}')`, 20000);
    const mem0 = await js(`performance.memory ? performance.memory.usedJSHeapSize : 0`);
    const t0 = Date.now();
    await js(`(() => { const one = new Blob([new Uint8Array(1048576)]); const big = new File(Array(131).fill(one), 'huge.glb'); const dt = new DataTransfer(); dt.items.add(big); const input = document.querySelector('${DROP_INPUT}'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); return big.size; })()`);
    await until(`!!document.querySelector('.ds-import-drop [role=alert]') || !!document.getElementById('ri-start')`, 10000);
    if (await js(`!!document.getElementById('ri-start')`)) await clickSel('#ri-start');
    await until(`!!document.querySelector('.ds-import-drop [role=alert]')`, 15000);
    const big = await text('.ds-import-drop [role=alert]');
    const mem1 = await js(`performance.memory ? performance.memory.usedJSHeapSize : 0`);
    check(`an oversized .glb is refused with "larger than any robot file DSIM saves" (${Date.now() - t0} ms)`, /larger than any robot file DSIM saves/.test(big ?? ''), String(big));
    check(`…and was not read whole (JS heap grew ${(((mem1 - mem0) / 1048576) | 0)} MB)`, mem1 - mem0 < 60 * 1048576, `${mem0} → ${mem1}`);
    await shot('oversized');
    endOfFlow();
  };

  // ───────────────────────────── f7b: a model that reaches outside the robot box ─────────────────────────────
  // needs scratch/window-pass/boom.step: `npx tsx scripts/importflows-boom.ts`
  flows.f7b = async () => {
    flow = 'f7b';
    const boomPath = path.resolve('scratch', 'window-pass', 'boom.step');
    if (!fs.existsSync(boomPath)) return note('NOT RUN: run `npx tsx scripts/importflows-boom.ts` first');
    await fresh();
    await open('/decode/configure/robot/import');
    await until(`!!document.querySelector('${DROP_INPUT}')`, 20000);
    await setFiles(DROP_INPUT, FILE_JS(fs.readFileSync(boomPath).toString('base64'), 'boom.step'));
    check('the boom model reads', await until(`!!document.querySelector('.ds-import-filerow')`, 120000));
    await until(`!document.getElementById('ri-save-head')?.disabled`, 60000);
    await sleep(1500);
    note(`facts: ${JSON.stringify(await text('.ds-facts'))}`);
    check('the 70 in boom makes the model over 18 in until it is left out', /Over 18 in/i.test((await text('.ds-facts')) ?? ''), (await text('.ds-facts')) ?? '');
    await click('.ds-import-turns .ds-btn', 'Select parts');
    await js(`[...document.querySelectorAll('.ds-import-preview-tools button')].find((b) => b.textContent.trim() === 'Top')?.click()`);
    await sleep(1800);
    // find the magenta boom in the preview and click it
    const rect = await js(`(() => { const r = document.querySelector('.ds-import-preview-stage').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, iw: innerWidth }; })()`);
    const img = await win.webContents.capturePage();
    const sz = img.getSize(); const bmp = img.toBitmap();
    const k = sz.width / rect.iw;
    let n = 0, sx = 0, sy = 0;
    for (let y = Math.floor(rect.y * k); y < Math.min(sz.height, (rect.y + rect.h) * k); y++) for (let x = Math.floor(rect.x * k); x < Math.min(sz.width, (rect.x + rect.w) * k); x++) {
      const o = (y * sz.width + x) * 4; const b = bmp[o], g = bmp[o + 1], r = bmp[o + 2];
      if (r > 130 && b > 130 && g < 100) { n++; sx += x; sy += y; }
    }
    note(`magenta pixels in the preview: ${n}`);
    await shot('top-view');
    if (!check('the boom is visible in the preview (magenta pixels)', n > 30, `${n}`)) return;
    const cx = Math.round(sx / n / k), cy = Math.round(sy / n / k);
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) {
      win.webContents.sendInputEvent({ type, x: cx, y: cy, button: 'left', clickCount: 1 });
      await sleep(150);
    }
    await sleep(700);
    const sel = await js(`document.querySelector('#ri-parts .cap')?.textContent`);
    check('clicking the boom selects it (Parts: 1 selected)', /1 selected/.test(sel ?? ''), String(sel));
    await click('.ds-import-turns .ds-btn', 'Leave out of footprint');
    await sleep(1800);
    note(`facts after leaving the boom out: ${JSON.stringify(await text('.ds-facts'))}`);
    await goStep(4);
    await reviewReady();
    const items = await js(`[...document.querySelectorAll('.ds-import-checks li')].map((l) => l.className + ': ' + l.textContent.replace(/\\s+/g, ' ').trim())`);
    note(`Review: ${items.join(' | ')}`);
    const reach = items.find((i) => /sticks out of the space a room can draw/.test(i));
    check('Review blocks a model that reaches outside the robot box, naming how far and which way', !!reach && reach.startsWith('bad') && /\d+\.\d in too far (forward|back|left|right)/.test(reach), JSON.stringify(items));
    check('…and says what to do (delete the parts or shorten them)', !!reach && /delete them, or shorten them in your CAD/.test(reach), String(reach));
    check('Save is disabled with the reason', await js(`(() => { const b = [...document.querySelectorAll('.ds-import-foot .ds-btn')].find((x) => x.textContent.trim() === 'Save robot'); return !!b && b.disabled && /Fix the checks above first/.test(b.title); })()`));
    await shot('mesh-reach');
    // Fix goes to Parts; deleting the boom clears the block
    const fix = await js(`(() => { const b = [...document.querySelectorAll('.ds-import-checks li')].find((l) => /sticks out/.test(l.textContent))?.querySelector('button'); if (!b) return 'missing'; b.click(); return 'ok'; })()`);
    await sleep(500);
    check('Fix goes to the Parts on the Model step', fix === 'ok' && (await tab()) === 0, `${fix} tab ${await tab()}`);
    endOfFlow();
  };

  // ── run ──
  const order = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f7b', 'f8'];
  for (const k of order) {
    if (ONLY.length && !ONLY.includes(k)) continue;
    if (!flows[k]) continue;
    console.log(`\n── ${k} ──`);
    flow = k;
    try {
      await flows[k]();
    } catch (e) {
      failures++;
      console.log(`FAIL  [${k}] threw: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
      try { await shot('threw'); } catch {}
    }
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
  app.exit(failures ? 1 : 0);
});
