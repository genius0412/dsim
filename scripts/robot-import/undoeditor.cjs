/* UNDO AND REDO IN THE REAL EDITOR (`docs/area/robot-import.md`, "Undo and redo"). Offscreen
 * Electron (show: false, offscreen) against a production build:
 *
 *   npm run build && npx vite preview --port 4174 --strictPort
 *   env -u ELECTRON_RUN_AS_NODE npx electron scripts/robot-import/undoeditor.cjs [--port 4174] [--out DIR]
 *
 * Drops the GLB fixture into the DECODE importer and checks that the editor's own edits leave Undo and
 * Redo off; then two edits (a turn, the weight), Ctrl+Z inside the number field (left to the field),
 * two undos (the keys, the button), a redo by Ctrl+Y and one by Ctrl+Shift+Z, reading the persisted
 * draft and the buttons after each; then five arrow presses on a placement handle, one step. Writes
 * `results.json` and pictures of the header (both themes, phone width) to the out dir.
 */
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const OUT = path.resolve(argOf('out', 'scratch/undoeditor'));
const BASE = `http://localhost:${argOf('port', '4174')}`;
const FILE = path.join(__dirname, '../fixtures/robot-import/robot.glb');
fs.mkdirSync(OUT, { recursive: true });
app.setPath('userData', path.join(OUT, 'userdata'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => {
  console.log('WATCHDOG');
  process.exit(2);
}, 5 * 60000);

const results = [];
const ok = (name, cond, extra) => {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined ? ` — ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : ''}`);
};

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, useContentSize: true, webPreferences: { backgroundThrottling: false, offscreen: true } });
  win.webContents.setAudioMuted(true);
  const logs = [];
  win.webContents.on('console-message', (e) => {
    const m = e.message ?? '';
    if (/error|warn/i.test(m)) logs.push(m.slice(0, 300));
  });
  const js = (s) => win.webContents.executeJavaScript(s);
  const until = (cond, ms = 30000) =>
    js(`(async () => { const t0 = performance.now(); while (!(${cond})) { if (performance.now() - t0 > ${ms}) return false; await new Promise((r) => setTimeout(r, 50)); } return true; })()`);
  const key = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(80);
  };
  const click = (sel, text) =>
    js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => ${text ? `x.textContent.trim().startsWith(${JSON.stringify(text)})` : 'true'}); if (!b) return false; b.click(); return true; })()`);
  const btn = (id) =>
    js(`(() => { const b = document.getElementById(${JSON.stringify(id)}); return b ? { disabled: b.disabled, title: b.title, label: b.getAttribute('aria-label'), focused: document.activeElement === b } : null; })()`);
  // the draft as persisted (800 ms after the last edit)
  const draft = async () => {
    await sleep(1100);
    return js(`new Promise((res) => {
      const q = indexedDB.open('decodesim.robots');
      q.onsuccess = () => {
        const db = q.result;
        if (!db.objectStoreNames.contains('drafts')) return res(null);
        const g = db.transaction('drafts', 'readonly').objectStore('drafts').get('decode:new');
        g.onsuccess = () => { const d = g.result; res(d ? JSON.parse(JSON.stringify({ step: d.step, yaw: d.setup.yaw, units: d.setup.units, massLb: d.setup.drive.massLb, triBudget: d.setup.triBudget, mech: d.mech, history: 'history' in d })) : null); };
        g.onerror = () => res(null);
      };
      q.onerror = () => res(null);
    })`);
  };
  const shot = async (name, sel) => {
    await js(`(() => { for (const e of document.querySelectorAll('*')) if (e.scrollTop > 0) e.scrollTop = 0; window.scrollTo(0, 0); return 1; })()`);
    await sleep(300);
    const r = sel
      ? await js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.max(0, Math.round(b.x) - 8), y: Math.max(0, Math.round(b.y) - 8), width: Math.round(b.width) + 16, height: Math.round(b.height) + 80 }; })()`)
      : null;
    await win.webContents.capturePage();
    const img = r ? await win.webContents.capturePage(r) : await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
  };

  try {
    await win.loadURL(BASE + '/');
    await session.defaultSession.clearCache();
    await js(`localStorage.clear(); new Promise((r) => { const q = indexedDB.deleteDatabase('decodesim.robots'); q.onsuccess = q.onerror = q.onblocked = () => r(1); })`);
    await win.loadURL(`${BASE}/decode/configure/robot/import`);
    await until(`document.querySelector('.ds-import-drop input[type=file]')`);
    ok('before a file: no Undo or Redo', (await btn('ri-undo')) === null && (await btn('ri-redo')) === null);
    const b64 = fs.readFileSync(FILE).toString('base64');
    await js(`(() => { const bin = atob(${JSON.stringify(b64)}); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); const f = new File([u], 'robot.glb'); const input = document.querySelector('.ds-import-drop input[type=file]'); const dt = new DataTransfer(); dt.items.add(f); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const loaded = await until(`document.querySelector('.ds-import-filerow') && (document.querySelector('.ds-import-canvas-host canvas') || document.querySelector('.ds-import-map'))`, 60000);
    ok('the fixture imports', loaded);
    // the editor's own edits land now: placements, the moving parts, the CAD build
    await sleep(3000);
    const d0 = await draft();
    const u0 = await btn('ri-undo');
    const r0 = await btn('ri-redo');
    ok('after the import, the editor’s own edits (placements, moving parts) leave Undo and Redo off', u0?.disabled && r0?.disabled, { u0, r0 });
    ok('the history is not in the persisted draft', d0 && d0.history === false, d0);
    await shot('header-0-fresh', '.ds-head');

    // EDIT 1: turn the robot (Model step)
    await click('.ds-import-turns button', 'Turn left');
    await sleep(1500); // the measurement and the placements re-default (auto) follow
    const d1 = await draft();
    const u1 = await btn('ri-undo');
    ok('edit 1: Turn left turns the robot', d1.yaw === (d0.yaw + 1) % 4, { before: d0.yaw, after: d1.yaw });
    ok('edit 1: Undo is on and names it; Redo stays off', !u1.disabled && u1.label === 'Undo: turn the robot' && u1.title === 'Undo: turn the robot (Ctrl+Z)' && (await btn('ri-redo')).disabled, u1);

    // EDIT 2: the weight, on the Drivetrain step
    await click('.ds-import-foot button', 'Next: Drivetrain');
    await sleep(800);
    const w0 = await js(`document.getElementById('ri-weight')?.value`);
    await js(`(() => { const el = document.getElementById('ri-weight'); el.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '25'); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await key('Return');
    const d2 = await draft();
    const u2 = await btn('ri-undo');
    ok('edit 2: the weight is 25 lb, on the Drivetrain step', d2.massLb === 25 && d2.step === 1, { was: w0, d2 });
    ok('edit 2: Undo names the weight', u2.label === 'Undo: change the weight', u2);
    // Ctrl+Z while the number field has focus is the field's own; the editor's history is untouched
    await key('Z', ['control']);
    await sleep(300);
    const u2b = await btn('ri-undo');
    const r2b = await btn('ri-redo');
    ok('Ctrl+Z inside a number field is left to the field', u2b.label === 'Undo: change the weight' && r2b.disabled, { u2b, r2b });
    await js(`document.activeElement?.blur()`);

    // UNDO 1, by the keyboard, focus outside any field
    await key('Z', ['control']);
    const d3 = await draft();
    const u3 = await btn('ri-undo');
    const r3 = await btn('ri-redo');
    ok('undo 1 (Ctrl+Z): the weight is back, the turn stays, the step stays Drivetrain', d3.massLb === d0.massLb && d3.yaw === d1.yaw && d3.step === 1, d3);
    ok('undo 1: Undo names the turn, Redo names the weight', !u3.disabled && u3.label === 'Undo: turn the robot' && !r3.disabled && r3.label === 'Redo: change the weight' && r3.title === 'Redo: change the weight (Ctrl+Y)', { u3, r3 });
    await shot('header-1-after-undo', '.ds-head');

    // UNDO 2, by the button
    await js(`document.getElementById('ri-undo').click()`);
    const d4 = await draft();
    await sleep(1500); // let the measurement and the effects run on the restored setup
    const d4b = await draft();
    const u4 = await btn('ri-undo');
    const r4 = await btn('ri-redo');
    ok('undo 2 (button): the turn is back to where the file was read, placements as they were, still on Drivetrain', d4.yaw === d0.yaw && d4.massLb === d0.massLb && d4.step === 1 && JSON.stringify(d4b.mech) === JSON.stringify(d0.mech), { d0: d0.mech, d4: d4b.mech });
    ok('undo 2: Undo is off; Redo names the turn and holds focus; the effects after the undo left Redo alone', u4.disabled && !r4.disabled && r4.label === 'Redo: turn the robot' && r4.focused, { u4, r4 });
    await shot('header-2-empty-undo', '.ds-head');

    // REDO 1, Ctrl+Y
    await key('Y', ['control']);
    await sleep(1500);
    const d5 = await draft();
    const u5 = await btn('ri-undo');
    const r5 = await btn('ri-redo');
    ok('redo (Ctrl+Y): the turn is back, the weight is not', d5.yaw === d1.yaw && d5.massLb === d0.massLb && d5.step === 1, d5);
    ok('redo: Undo names the turn, Redo names the weight', u5.label === 'Undo: turn the robot' && !r5.disabled && r5.label === 'Redo: change the weight', { u5, r5 });
    await key('Z', ['control', 'shift']);
    const d6 = await draft();
    ok('Ctrl+Shift+Z redoes the weight too, and Redo is off', d6.massLb === 25 && (await btn('ri-redo')).disabled, d6);

    // a run of arrow presses on one placement handle is one step
    await js(`document.querySelectorAll('.ds-import-steps .ds-tab')[2].click()`);
    await until(`document.querySelector('.ds-import-body .ds-import-handle')`, 10000);
    await sleep(1500);
    const m0 = await draft();
    const hid = await js(`(() => { const h = document.getElementById('ri-h-shooter') ?? document.querySelector('.ds-import-body .ds-import-handle'); h.scrollIntoView({ block: 'center' }); h.focus(); return h.id; })()`);
    for (let i = 0; i < 5; i++) await key('Up');
    const m1 = await draft();
    const um = await btn('ri-undo');
    ok(`five arrow presses on ${hid} move it`, JSON.stringify(m1.mech) !== JSON.stringify(m0.mech), { m0: m0.mech, m1: m1.mech });
    ok('…and are one step named by the handle', /^Undo: move the /.test(um.label), um);
    await key('Z', ['control']);
    const m2 = await draft();
    const um2 = await btn('ri-undo');
    ok('one Ctrl+Z (focus on the handle) takes all five back', JSON.stringify(m2.mech) === JSON.stringify(m0.mech) && um2.label === 'Undo: change the weight', { m2: m2.mech, um2 });
    await shot('mech-page', null);

    // a units change re-measures: undo puts the units back and the measurement follows
    await js(`document.querySelectorAll('.ds-import-steps .ds-tab')[0].click()`);
    await until(`document.querySelector('#ri-units select')`, 10000);
    await sleep(800);
    const size = () => js(`document.querySelector('.ds-facts dd')?.textContent.trim()`);
    const s0 = await size();
    const n0 = await draft();
    await js(`(() => { const el = document.querySelector('#ri-units select'); const v = el.value === 'mm' ? 'cm' : 'mm'; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('change', { bubbles: true })); return v; })()`);
    await sleep(1500);
    const n1 = await draft();
    const s1 = await size();
    const uu = await btn('ri-undo');
    ok('units: a new unit re-measures the model, and Undo names it', n1.units !== n0.units && s1 !== s0 && uu.label === 'Undo: change the units', { n0: n0.units, n1: n1.units, s0, s1, uu });
    // focus is still on the select, which keeps the keys: leave it first
    await js(`document.activeElement?.blur()`);
    await key('Z', ['control']);
    await sleep(1500);
    const n2 = await draft();
    const s2 = await size();
    ok('units: Ctrl+Z puts the units back and the size with them, placements as they were', n2.units === n0.units && s2 === s0 && JSON.stringify(n2.mech) === JSON.stringify(n0.mech), { n2: n2.units, s2, mech0: n0.mech, mech2: n2.mech });

    // Detail is not a step: the file is read again, and the history goes on across it
    const before = await btn('ri-undo');
    const light = await js(`(() => { const b = [...document.querySelectorAll('#ri-detail button')].find((x) => x.textContent.trim().startsWith('Light')); if (!b) return false; b.click(); return true; })()`);
    await until(`!document.querySelector('.ds-import-drop')`, 60000);
    await sleep(2000);
    const t1 = await draft();
    const after = await btn('ri-undo');
    ok('detail: Light re-reads the file and adds no step', light && t1.triBudget > 0 && after.label === before.label && !after.disabled, { light, triBudget: t1.triBudget, before: before.label, after: after.label });
    await js(`document.activeElement?.blur()`);
    await key('Z', ['control']);
    const t2 = await draft();
    ok('detail: an undo after it keeps the detail the model was read at', t2.triBudget === t1.triBudget, { t1: t1.triBudget, t2: t2.triBudget });

    // the header at phone width, and in the dark theme
    await js(`document.documentElement.dataset.theme = 'light'`);
    await shot('header-light', '.ds-head');
    await js(`document.documentElement.dataset.theme = 'dark'`);
    await shot('header-dark', '.ds-head');
    win.setContentSize(390, 844);
    await sleep(800);
    await shot('phone-dark', null);
    await js(`document.documentElement.dataset.theme = 'light'`);
    await shot('phone-light', null);
    const wraps = await js(`(() => { const h = document.querySelector('.ds-head'); const kids = [...h.children].filter((c) => c.offsetParent); const tops = new Set(kids.map((c) => Math.round(c.getBoundingClientRect().top))); return { rows: tops.size, width: h.scrollWidth, client: h.clientWidth }; })()`);
    ok('phone width: the header does not overflow', wraps.width <= wraps.client, wraps);
  } catch (e) {
    ok('probe ran', false, String(e && e.stack ? e.stack : e));
  } finally {
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ results, logs: logs.slice(-20) }, null, 2));
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed} passed, ${failed} failed`);
    if (logs.length) console.log('console:', logs.slice(-10).join('\n'));
    win.destroy();
    app.exit(failed ? 1 : 0);
  }
});
