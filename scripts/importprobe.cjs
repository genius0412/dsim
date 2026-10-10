/* THE IMPORTER'S COST, MEASURED (lane 4). An OFFSCREEN Electron window against a PRODUCTION build
 * (`VITE_ROBOT_IMPORT=1 npm run build && npx vite preview --port 4173`: the importer ships on the
 * alpha channel only, and the variable opens it in a local build), cold cache, a `longtask`
 * observer on every page:
 *
 *   1. the robot page with no imports, then with six: what the import row adds to the main thread;
 *   2. the empty editor: its own chunk only, the engine NOT fetched;
 *   3. a dropped model: the longest task from the drop to the preview's first frame;
 *   4. ten trips editor → robot page on a saved import: no "Too many active WebGL contexts", and
 *      the heap after a forced GC within 5 MB of the first trip (the controller, the session and
 *      their object URLs all go when the editor does).
 *
 *   env -u ELECTRON_RUN_AS_NODE npx electron scripts/importprobe.cjs [--port 4173] [--file robot.glb]
 *
 * A measurement with budgets, not a test in `npm test`: the numbers depend on the machine. The run
 * prints them and fails (exit 1) only when a budget is broken.
 */
const { app, BrowserWindow, session } = require('electron');

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = `http://localhost:${argOf('port', '4173')}`;
const FILE = argOf('file', 'robot.glb');
const HEAVY = Number(argOf('tris', '150000'));

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('js-flags', '--expose-gc');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log('WATCHDOG'); process.exit(2); }, 420000);

// installed BEFORE any page script (CDP addScriptToEvaluateOnNewDocument): long tasks are not
// buffered in the performance timeline, so an observer added at dom-ready misses the whole load
const OBSERVE = `window.__lt = [];
try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push({ t: e.startTime, d: e.duration }); }).observe({ type: 'longtask' }); } catch {}`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, useContentSize: true, webPreferences: { backgroundThrottling: false, offscreen: true } });
  win.webContents.setAudioMuted(true);
  const js = (s) => win.webContents.executeJavaScript(s);
  const warnings = [];
  win.webContents.on('console-message', (e) => {
    const m = e.message ?? '';
    if (/Too many active WebGL contexts/i.test(m)) warnings.push(m);
  });
  let broken = 0;
  const budget = (name, value, max, unit) => {
    const ok = value <= max;
    if (!ok) broken++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${value.toFixed(1)} ${unit} (budget ${max} ${unit})`);
  };
  const until = (cond, ms = 30000) => js(`(async () => { const t0 = performance.now(); while (!(${cond})) { if (performance.now() - t0 > ${ms}) return false; await new Promise((r) => setTimeout(r, 50)); } return true; })()`);
  const tasks = () => js(`JSON.stringify(window.__lt ?? [])`).then((s) => JSON.parse(s));
  const sum = (a) => a.reduce((s, x) => s + x.d, 0);
  const max = (a) => a.reduce((m, x) => Math.max(m, x.d), 0);
  const cold = async (route) => {
    await session.defaultSession.clearCache();
    await win.loadURL(BASE + route);
    await sleep(2500);
    return tasks();
  };

  // a clean device
  await win.loadURL(BASE + '/');
  // attach on a real document: on a blank target the CDP domains never resolve (shiftaudit’s note)
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Page.enable');
  await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVE });
  await js(`localStorage.clear(); new Promise((r) => { const q = indexedDB.deleteDatabase('decodesim.robots'); q.onsuccess = q.onerror = q.onblocked = () => r(1); })`);

  // 1a. the robot page, no imports
  const page0 = await cold('/decode/configure/robot');
  console.log(`robot page, 0 imports: long tasks ${page0.length}, total ${sum(page0).toFixed(0)} ms, longest ${max(page0).toFixed(0)} ms`);
  // the observer is alive (else every zero below means nothing): a deliberate 120 ms task
  await js(`(() => { const t = performance.now(); while (performance.now() - t < 120) {} return 1; })()`);
  await sleep(200);
  const alive = (await tasks()).some((x) => x.d >= 110);
  console.log(`${alive ? 'PASS' : 'FAIL'}  the long-task observer sees a deliberate 120 ms task`);
  if (!alive) broken++;
  await js(`window.__lt.length = 0; true`);

  // 2. the empty editor: its chunk, not the engine
  await js(`document.querySelector('.ds-opt-add')?.click(); true`);
  await until(`document.querySelector('.ds-import-drop')`);
  await sleep(1200);
  const res = await js(`JSON.stringify(performance.getEntriesByType('resource').map((r) => r.name.split('/').pop()))`).then(JSON.parse);
  const editorChunk = res.some((n) => /^ImportEditor-/.test(n));
  // the ENGINE is three.js and its loaders (`importerEngine-*.js`, the shared three chunk, STEP);
  // `geometry-*.js` is the measurement code the editor itself runs (8 KB), so it is expected here
  const engine = res.filter((n) => /^(importerEngine|stepReader|stepWorker|meshopt_decoder|three)/.test(n));
  if (res.some((n) => /^geometry-/.test(n))) console.log('      (geometry-*.js fetched with the editor: the measurement code it runs itself)');
  console.log(`${editorChunk && !engine.length ? 'PASS' : 'FAIL'}  empty editor: its chunk ${editorChunk ? 'fetched' : 'MISSING'}, engine ${engine.length ? 'FETCHED ' + engine.join(', ') : 'not fetched'}`);
  if (!editorChunk || engine.length) broken++;

  // 3. drop a model: the longest task from the drop to the preview's first frame
  await js(`window.__lt.length = 0; true`);
  const t0 = Date.now();
  // the preview server does not serve scripts/: hand the bytes over from here
  const bytes = require('fs').readFileSync(require('path').join(__dirname, 'fixtures', 'robot-import', FILE)).toString('base64');
  await js(`(() => {
    const raw = atob('${bytes}'); const u = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) u[i] = raw.charCodeAt(i);
    const input = document.querySelector('.ds-import-drop input[type=file]');
    const dt = new DataTransfer(); dt.items.add(new File([u], '${FILE}'));
    input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await until(`document.querySelector('.ds-import-filerow') && document.querySelector('.ds-import-canvas-host canvas')`, 60000);
  await js(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))`);
  const dropMs = Date.now() - t0;
  const dropTasks = await tasks();
  console.log(`dropped ${FILE}: first frame after ${dropMs} ms, long tasks ${dropTasks.length}, longest ${max(dropTasks).toFixed(0)} ms`);
  budget('drop: the longest main-thread task', max(dropTasks), 200, 'ms');

  // save it, then five duplicates: six imports
  await js(`document.querySelectorAll('.ds-import-steps .ds-tab')[3].click(); true`);
  await sleep(800);
  await js(`[...document.querySelectorAll('.ds-import-foot .ds-btn.primary')].find((b) => /Save/.test(b.textContent))?.click(); true`);
  await until(`location.pathname.endsWith('/configure/robot')`);
  await sleep(1200);
  for (let i = 0; i < 5; i++) {
    await js(`[...document.querySelectorAll('.ds-panel .ds-btn')].find((b) => b.textContent.trim() === 'Duplicate')?.click(); true`);
    await sleep(900);
  }
  const n = await js(`document.querySelectorAll('.ds-robot-card .ds-import-thumb, .ds-robot-card-thumb .ds-import-thumb').length`);
  // 1b. the robot page, six imports, cold
  const page6 = await cold('/decode/configure/robot');
  await until(`document.querySelectorAll('.ds-import-thumb').length >= 6`, 10000);
  console.log(`robot page, ${n} imports: long tasks ${page6.length}, total ${sum(page6).toFixed(0)} ms, longest ${max(page6).toFixed(0)} ms`);
  budget('robot page: main-thread time six imports add', Math.max(0, sum(page6) - sum(page0)), 20, 'ms');

  // 4. ten trips into the editor and back
  const heap = [];
  const reopens = [];
  for (let i = 0; i < 10; i++) {
    // timed IN the page, frame by frame: the click to the frame the preview and the file row are in
    const reopen = await js(`(async () => {
      const t0 = performance.now();
      [...document.querySelectorAll('.ds-panel .ds-btn')].find((b) => /Edit in the importer/.test(b.textContent))?.click();
      while (!(document.querySelector('.ds-import-canvas-host canvas') && document.querySelector('.ds-import-filerow'))) {
        if (performance.now() - t0 > 30000) return -1;
        await new Promise((r) => requestAnimationFrame(r));
      }
      return performance.now() - t0;
    })()`);
    const ok = reopen >= 0;
    if (ok) reopens.push(reopen);
    if (!ok) { console.log(`FAIL  trip ${i + 1}: the editor did not open its preview`); broken++; break; }
    await sleep(600);
    await js(`document.querySelector('.ds-back')?.click(); true`);
    await until(`location.pathname.endsWith('/configure/robot')`);
    await sleep(800);
    heap.push(await js(`(() => { window.gc?.(); window.gc?.(); return performance.memory ? performance.memory.usedJSHeapSize : 0; })()`));
  }
  const mb = (b) => b / 1048576;
  if (heap.length === 10) {
    console.log(`heap after GC, trips 1/5/10: ${mb(heap[0]).toFixed(1)} / ${mb(heap[4]).toFixed(1)} / ${mb(heap[9]).toFixed(1)} MB`);
    const sorted = [...reopens].sort((a, b) => a - b);
    console.log(`re-open to first frame, trips 1 / median / worst: ${reopens[0].toFixed(0)} / ${sorted[5].toFixed(0)} / ${sorted[9].toFixed(0)} ms`);
    budget('re-open a saved import, warm (median of 10)', sorted[5], 160, 'ms');
    budget('ten editor trips: heap growth after GC', Math.max(0, mb(heap[9]) - mb(heap[0])), 5, 'MB');
  }
  console.log(`${warnings.length ? 'FAIL' : 'PASS'}  ten editor trips: "Too many active WebGL contexts" ${warnings.length} times`);
  if (warnings.length) broken++;

  // 5. a HEAVY model: the STL fixture (a robot on four wheels) with its triangles split into four
  // until there are ${HEAVY} (`--tris`, default 150k: past the editor's 100k budget, so the
  // simplifier runs), as dense at the floor as a CAD export of real wheels. Made in the page.
  await win.loadURL(BASE + '/decode/configure/robot/import');
  await until(`document.querySelector('.ds-import-drop input[type=file]')`);
  await sleep(800);
  const stl = require('fs').readFileSync(require('path').join(__dirname, 'fixtures', 'robot-import', 'robot.stl')).toString('base64');
  const tris = await js(`(() => {
    const raw = atob('${stl}'); const u = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) u[i] = raw.charCodeAt(i);
    const dv0 = new DataView(u.buffer); const n0 = dv0.getUint32(80, true);
    let tris = [];
    for (let n = 0; n < n0; n++) { const t = []; for (let a = 0; a < 3; a++) { const v = []; for (let b = 0; b < 3; b++) v.push(dv0.getFloat32(84 + n * 50 + 12 + a * 12 + b * 4, true)); t.push(v); } tris.push(t); }
    const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
    // split whole levels while a full level fits, then split just enough of the next one
    while (tris.length < ${HEAVY}) {
      const room = Math.min(tris.length, Math.ceil((${HEAVY} - tris.length) / 3));
      const next = [];
      tris.forEach((t, i) => { if (i >= room) return void next.push(t); const [A, B, C] = t; const ab = mid(A, B), bc = mid(B, C), ca = mid(C, A); next.push([A, ab, ca], [ab, B, bc], [ca, bc, C], [ab, bc, ca]); });
      tris = next;
    }
    const buf = new ArrayBuffer(84 + tris.length * 50), dv = new DataView(buf);
    dv.setUint32(80, tris.length, true);
    tris.forEach((t, n) => t.forEach((v, a) => v.forEach((x, b) => dv.setFloat32(84 + n * 50 + 12 + a * 12 + b * 4, x, true))));
    window.__heavy = new File([buf], 'heavy.stl');
    return tris.length;
  })()`);
  // making the file is the PROBE's work, not the importer's: the clock starts at the drop
  await sleep(300);
  await js(`window.__lt.length = 0; true`);
  const h0 = Date.now();
  await js(`(() => {
    const input = document.querySelector('.ds-import-drop input[type=file]');
    const dt = new DataTransfer(); dt.items.add(window.__heavy);
    input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const okHeavy = await until(`document.querySelector('.ds-import-filerow') && document.querySelector('.ds-import-canvas-host canvas')`, 120000);
  await js(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))`);
  const heavyMs = Date.now() - h0;
  const heavyTasks = await tasks();
  console.log(`heavy STL (${tris.toLocaleString('en-US')} triangles, the fixture subdivided): ${okHeavy ? `first frame after ${heavyMs} ms` : 'NO FRAME'}, long tasks ${heavyTasks.length}, longest ${max(heavyTasks).toFixed(0)} ms`);
  if (!okHeavy) broken++;
  budget('heavy drop: the longest main-thread task', max(heavyTasks), 200, 'ms');

  console.log(broken ? `\n${broken} BUDGET(S) BROKEN` : '\nALL BUDGETS MET');
  app.exit(broken ? 1 : 0);
});
