/* REAL ROBOT CAD THROUGH THE REAL EDITOR. An OFFSCREEN Electron window against a PRODUCTION build,
 * one file at a time (a big STEP keeps several cores and gigabytes busy for minutes):
 *
 *   VITE_ROBOT_IMPORT=1 npm run build && npx vite preview --port 4173 --strictPort
 *   env -u ELECTRON_RUN_AS_NODE npx electron scripts/robot-import/realcadprobe.cjs \
 *       --files <path>[,<path>…] --out <dir> [--port 4173] [--game decode]
 *       [--gpu] [--details Full,Light] [--orbit] [--tiers low,medium,high,ultra,extreme] [--reps 2] [--seconds 6]
 *
 * The files are vendors' published CAD (a STEP, or the zip it is published in), never committed:
 * goBILDA publishes no licence, REV's is CC BY-NC-SA. Per file, in a FRESH window, per Detail in
 * `--details` (default: whatever the editor reads at):
 *   1. the drop: the status-line timeline, every long task (> 50 ms) on the page, the renderer's
 *      peak working set (the import's workers are threads of it), and the time to the preview; a
 *      Detail other than the one the file was read at is then picked (a re-read, timed the same way);
 *   2. what the Model step says (size, triangles, wheels, units, up, front) and pictures of it;
 *      `--orbit` drags the preview round for two seconds and times its frames;
 *   3. Save (timed), then the library record's descriptor (hull, wheels, height, in robot-local
 *      inches; the whole of it in `<out>/<file>-<detail>-imported.json`) and the stored mesh;
 *   4. each saved robot re-opened (timed, its draft cleared first so the stored mesh is read), Review,
 *      Test drive: pictures of the match, before and after driving and turning. With `--tiers`, once
 *      per graphics tier (the preset written to storage before the page loads), the robots taking
 *      turns tier by tier and `--reps` times over (other work on the machine moves frame times
 *      between runs; side by side it moves both), each pass with the frame time of the match while
 *      the robot drives: the page's work in each animation frame, the GPU's included (a one-pixel
 *      `readPixels` after the frame's callbacks waits for it). BIOBUZZ ends with a close-up from the
 *      chase camera on the last tier.
 * `--gpu` keeps hardware GL (frame times mean nothing on the software rasteriser). Writes
 * `<out>/<file>-*.png` and `<out>/results.json`. A measurement, not a test.
 * `VITE_ROBOT_IMPORT=1`: the importer ships on the alpha channel only (`importerEnabled`), and a
 * local build without it has no editor route to drive.
 */
const { app, BrowserWindow, session } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);
const BASE = `http://localhost:${argOf('port', '4173')}`;
const FILES = argOf('files', '').split(',').filter(Boolean);
const OUT = path.resolve(argOf('out', 'scratch/realcad'));
const GAME = argOf('game', 'decode');
const DETAILS = argOf('details', argOf('detail', '')).split(',').filter(Boolean);
const TIERS = argOf('tiers', '').split(',').filter(Boolean);
const REPS = Number(argOf('reps', '1'));
const SECONDS = Number(argOf('seconds', '6'));
const GPU = flag('gpu');
fs.mkdirSync(OUT, { recursive: true });
// a profile of its own: other Electron scripts on this machine share the default one
app.setPath('userData', path.join(OUT, 'profile'));

if (!GPU) app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('js-flags', '--expose-gc');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => {
  console.log('WATCHDOG');
  process.exit(2);
}, 3 * 3600000);

// long tasks, and (while `__ft` is an array) each animation frame's work: every callback of the frame
// summed, with a one-pixel read of every live WebGL canvas after each, so the GPU's share is in it
const OBSERVE = `window.__lt = [];
try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push({ t: e.startTime, d: e.duration }); }).observe({ type: 'longtask' }); } catch {}
window.__gl = []; window.__ft = null;
(() => {
  const gc = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    const c = gc.call(this, type, attrs);
    if (c && (type === 'webgl2' || type === 'webgl') && !window.__gl.includes(c)) window.__gl.push(c);
    return c;
  };
  const px = new Uint8Array(4);
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((t) => {
    if (!window.__ft) return cb(t);
    const t0 = performance.now();
    try { cb(t); } finally {
      window.__gl = window.__gl.filter((gl) => !gl.isContextLost());
      for (const gl of window.__gl) if (gl.canvas.isConnected) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const d = performance.now() - t0;
      const f = window.__ft;
      const last = f[f.length - 1];
      if (last && last.t === t) last.d += d; else f.push({ t, d });
    }
  });
})();`;

const GRAPHICS = (tier) => JSON.stringify({ preset: tier, tier });

/** median, p95, max and the frame rate of `frames` ({t, d}) */
function frameStats(frames) {
  const d = frames.map((f) => f.d).sort((a, b) => a - b);
  if (!d.length) return null;
  const q = (p) => d[Math.min(d.length - 1, Math.floor(p * d.length))];
  const span = frames.length > 1 ? frames[frames.length - 1].t - frames[0].t : 0;
  return { frames: d.length, medianMs: +q(0.5).toFixed(2), p95Ms: +q(0.95).toFixed(2), maxMs: +d[d.length - 1].toFixed(2), fps: span ? +(((frames.length - 1) * 1000) / span).toFixed(1) : 0 };
}

function serve() {
  return new Promise((resolve) => {
    const byName = new Map(FILES.map((f) => [path.basename(f), f]));
    const srv = http.createServer((req, res) => {
      const f = byName.get(decodeURIComponent(req.url.slice(1)));
      if (!f || !fs.existsSync(f)) {
        res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Length': fs.statSync(f).size, 'Content-Type': 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const { srv, port } = await serve();
  const results = [];
  for (const file of FILES) {
    const name = path.basename(file);
    const tag = name.replace(/\.[^.]+$/, '');
    const win = new BrowserWindow({ width: 1920, height: 1080, show: false, useContentSize: true, webPreferences: { backgroundThrottling: false, offscreen: true } });
    win.webContents.setAudioMuted(true);
    const logs = [];
    win.webContents.on('console-message', (e) => {
      const m = e.message ?? '';
      if (/\[import\]|error|warn/i.test(m)) logs.push(m.slice(0, 400));
    });
    await win.loadURL(BASE + '/');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Page.enable');
    await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVE });
    const js = (s) => win.webContents.executeJavaScript(s);
    const until = (cond, ms = 30000) => js(`(async () => { const t0 = performance.now(); while (!(${cond})) { if (performance.now() - t0 > ${ms}) return false; await new Promise((r) => setTimeout(r, 50)); } return true; })()`);
    const shot = async (what) => {
      await sleep(300);
      await win.webContents.capturePage();
      const img = await win.webContents.capturePage();
      const p = path.join(OUT, `${tag}-${what}.png`);
      fs.writeFileSync(p, img.toPNG());
      return p;
    };
    const click = (sel, text) => js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => ${text ? `x.textContent.trim().startsWith(${JSON.stringify(text)})` : 'true'}); if (!b) return false; b.click(); return true; })()`);
    const key = async (keyCode, holdMs) => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
      await sleep(holdMs);
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
    };
    const pid = win.webContents.getOSProcessId();
    let memPeak = 0;
    let allPeak = 0;
    let gpuPeak = 0;
    let sampling = false;
    const sampler = setInterval(() => {
      const ms = app.getAppMetrics();
      const m = ms.find((x) => x.pid === pid);
      if (!m || !sampling) return;
      memPeak = Math.max(memPeak, m.memory.workingSetSize / 1024);
      allPeak = Math.max(allPeak, ms.reduce((s, x) => s + x.memory.workingSetSize / 1024, 0));
      gpuPeak = Math.max(gpuPeak, ms.filter((x) => x.type === 'GPU').reduce((s, x) => s + x.memory.workingSetSize / 1024, 0));
    }, 100);
    const memNow = () => app.getAppMetrics().find((x) => x.pid === pid)?.memory.workingSetSize / 1024;
    const startSampling = () => {
      memPeak = memNow();
      allPeak = 0;
      gpuPeak = 0;
      sampling = true;
    };
    const stopSampling = () => {
      sampling = false;
      return { rendererPeakMB: Math.round(memPeak), allProcessesPeakMB: Math.round(allPeak), gpuProcessPeakMB: Math.round(gpuPeak) };
    };
    const longTasks = async (since) => {
      const lt = await js(`JSON.stringify(window.__lt.map((x) => ({ t: x.t - (${since}), d: x.d })))`).then(JSON.parse);
      const tasks = lt.filter((x) => x.t >= -5);
      return { longTasks: tasks.length, longestMs: Math.round(tasks.reduce((m, x) => Math.max(m, x.d), 0)), blockedMs: Math.round(tasks.reduce((s, x) => s + x.d, 0)) };
    };
    const filerowReady = `(document.querySelector('.ds-import-filerow') && document.querySelector('.ds-import-canvas-host canvas'))`;
    const clearDrafts = () =>
      js(`new Promise((res) => {
        const q = indexedDB.open('decodesim.robots');
        q.onsuccess = () => {
          const db = q.result;
          const stores = ['drafts', 'draftModels'].filter((s) => db.objectStoreNames.contains(s));
          if (!stores.length) return res(0);
          const tx = db.transaction(stores, 'readwrite');
          for (const s of stores) tx.objectStore(s).clear();
          tx.oncomplete = tx.onerror = () => { db.close(); res(1); };
        };
        q.onerror = () => res(0);
      })`);
    const libraryRows = () =>
      js(`new Promise((res) => {
        const q = indexedDB.open('decodesim.robots');
        q.onsuccess = () => {
          const db = q.result;
          if (!db.objectStoreNames.contains('robots')) return res('[]');
          const tx = db.transaction('robots', 'readonly');
          const all = tx.objectStore('robots').getAll();
          all.onsuccess = () => res(JSON.stringify(all.result.filter((r) => r && r.spec && r.spec.imported).map((r) => ({ id: r.id, name: r.spec.name, imported: r.spec.imported, source: r.source, setup: r.setup, updated: r.updated, mech: r.spec.bbMech ?? { intake: r.spec.intake, launcher: r.spec.launcher } }))));
          all.onerror = () => res('[]');
        };
        q.onerror = () => res('[]');
      })`).then(JSON.parse);
    const fileOf = (id, kind) =>
      js(`new Promise((res) => {
        const q = indexedDB.open('decodesim.robots');
        q.onsuccess = () => {
          const g = q.result.transaction('files', 'readonly').objectStore('files').get(${JSON.stringify(id)} + ':${kind}');
          g.onsuccess = async () => {
            if (!g.result) return res('');
            const u8 = new Uint8Array(await g.result.arrayBuffer());
            let s = '';
            for (let i = 0; i < u8.length; i += 4096) s += String.fromCharCode(...u8.subarray(i, i + 4096));
            res(btoa(s));
          };
          g.onerror = () => res('');
        };
        q.onerror = () => res('');
      })`);
    const toReview = async () => {
      // five steps since Moving parts became its own (d154b36a); a missing button is skipped
      for (const s of ['Next: Drivetrain', 'Next: Mechanisms', 'Next: Moving parts', 'Next: Review']) {
        await click('button', s);
        await sleep(600);
      }
    };

    /** drop the file on a fresh import page; the import's row */
    const importOnce = async () => {
      await clearDrafts();
      await win.loadURL(`${BASE}/${GAME}/configure/robot/import`);
      await until(`document.querySelector('.ds-import-drop input[type=file]')`);
      await sleep(800);
      await js(`(async () => { const r = await fetch('http://127.0.0.1:${port}/${encodeURIComponent(name)}'); window.__file = new File([await r.blob()], ${JSON.stringify(name)}); return 1; })()`);
      await sleep(500);
      const mem0 = memNow();
      await js(`window.__lt.length = 0; window.__tl = []; (() => {
        const t0 = performance.now(); window.__t0 = t0;
        const seen = (s) => { const last = window.__tl[window.__tl.length - 1]; if (!last || last.s !== s) window.__tl.push({ t: Math.round(performance.now() - t0), s }); };
        new MutationObserver(() => {
          const od = document.querySelector('.ds-import-drop .od');
          const fill = document.querySelector('.ds-import-drop .rec-fill');
          if (od) seen(od.textContent + (fill && fill.style.width ? ' ' + fill.style.width : ''));
        }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
        const input = document.querySelector('.ds-import-drop input[type=file]');
        const dt = new DataTransfer(); dt.items.add(window.__file);
        input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      startSampling();
      const t0 = Date.now();
      await until(`${filerowReady} || document.querySelector('.ds-import-drop .od.err') || document.querySelector('.ds-import-drop [role=alert]')`, 3600000);
      const ok = await js(`!!document.querySelector('.ds-import-filerow')`);
      const s = +((Date.now() - t0) / 1000).toFixed(1);
      await sleep(2500);
      const mem = stopSampling();
      const lt = await js(`JSON.stringify(window.__tl)`).then(JSON.parse);
      // the timeline, thinned to one entry per stage label (the bar's width changes are many)
      const tl = [];
      for (const p of lt) {
        const label = p.s.replace(/ \d+(\.\d+)?%$/, '');
        if (!tl.length || tl[tl.length - 1].label !== label) tl.push({ t: p.t, label });
      }
      const out = { ok, s, timeline: tl.map((p) => `${(p.t / 1000).toFixed(1)}s ${p.label}`), ...(await longTasks('window.__t0')), memBaseMB: Math.round(mem0), ...mem };
      console.log(`\n${name} (${(fs.statSync(file).size / 1048576).toFixed(1)} MB): ${ok ? 'imported' : 'FAILED'} in ${out.s} s; longest task ${out.longestMs} ms (${out.longTasks} tasks, ${out.blockedMs} ms); renderer ${out.memBaseMB} → ${out.rendererPeakMB} MB, all processes peak ${out.allProcessesPeakMB} MB`);
      console.log(`  ${out.timeline.join(' → ')}`);
      return out;
    };

    /** one test drive of a saved robot at `tier`: re-open (timed), Review, Test drive, frames */
    const drivePass = async (rec, tier, label, closeup) => {
      await clearDrafts();
      await js(`localStorage.setItem('decodesim.camera', ${JSON.stringify(closeup ? 'chase' : 'auto')}); ${tier ? `localStorage.setItem('decodesim.graphics', ${JSON.stringify(GRAPHICS(tier))});` : ''} 1`);
      startSampling();
      const tr = Date.now();
      await win.loadURL(`${BASE}/${GAME}/configure/robot/import/${rec.id}`);
      await until(filerowReady, 600000);
      const reopenS = +((Date.now() - tr) / 1000).toFixed(1);
      await sleep(1500);
      const reopen = { s: reopenS, ...stopSampling(), ...(await longTasks('0')) };
      await toReview();
      startSampling();
      const td = Date.now();
      await js(`window.__lt.length = 0; window.__t5 = performance.now()`);
      // `--profile`: the main thread's JS, sampled, from the click to the drive (a .cpuprofile)
      const prof = flag('profile') && !closeup;
      if (prof) {
        await win.webContents.debugger.sendCommand('Profiler.enable');
        await win.webContents.debugger.sendCommand('Profiler.setSamplingInterval', { interval: 500 });
        await win.webContents.debugger.sendCommand('Profiler.start');
      }
      await click('#ri-testdrive');
      await until(`!document.querySelector('.ds-import-filerow') && !document.querySelector('.game-loading') && document.querySelectorAll('canvas').length > 0`, 300000);
      const toDriveS = +((Date.now() - td) / 1000).toFixed(1);
      await sleep(8000);
      // the match's first seconds: the scene, and the stored mesh parsed and uploaded
      const startTasks = await longTasks('window.__t5');
      if (prof) {
        const { profile } = await win.webContents.debugger.sendCommand('Profiler.stop');
        fs.writeFileSync(path.join(OUT, `${tag}-${label}-start.cpuprofile`), JSON.stringify(profile));
      }
      // the field takes the keys once clicked
      for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: 960, y: 620, button: 'left', clickCount: 1 });
      win.webContents.focus();
      await sleep(1000);
      if (closeup) {
        // out from the wall first, so the chase camera is behind the robot on the field
        await key('S', 1500);
        await sleep(1500);
        await shot(`${label}-chase`);
        await key('E', 500);
        await sleep(800);
        await shot(`${label}-chase-turned`);
        stopSampling();
        return null;
      }
      await shot(`${label}-0`);
      // the drive is field-centric by default and the start is against a wall: S and A drive
      // away from it (down and left on the screen), E turns
      await js(`window.__lt.length = 0; window.__t4 = performance.now(); window.__ft = []`);
      const end = Date.now() + SECONDS * 1000;
      const pattern = [['S', 1200], ['E', 600], ['A', 900], ['W', 1200], ['Q', 600], ['D', 900]];
      for (let i = 0; Date.now() < end; i++) await key(...pattern[i % pattern.length]);
      const ft = await js(`JSON.stringify(window.__ft)`).then(JSON.parse);
      await js(`window.__ft = null`);
      const pass = { tier, reopen, toDriveS, start: startTasks, ...frameStats(ft), ...(await longTasks('window.__t4')), ...stopSampling() };
      pass.canvas = await js(`(() => { const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0]; return c ? c.width + 'x' + c.height : ''; })()`);
      console.log(`  ${label}: ${JSON.stringify(pass)}`);
      await shot(`${label}-moved`);
      return pass;
    };

    const row = { file: name, mb: +(fs.statSync(file).size / 1048576).toFixed(1), gpu: GPU, details: [] };
    try {
      await session.defaultSession.clearCache();
      await win.loadURL(`${BASE}/${GAME}/configure/robot/import`);
      await js(`localStorage.clear(); new Promise((r) => { const q = indexedDB.deleteDatabase('decodesim.robots'); q.onsuccess = q.onerror = q.onblocked = () => r(1); })`);
      row.glRenderer = await js(`(() => { const c = document.createElement('canvas').getContext('webgl2'); const d = c && c.getExtension('WEBGL_debug_renderer_info'); return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'n/a'; })()`);
      console.log(`GL: ${row.glRenderer}`);
      const robots = [];
      for (const want of DETAILS.length ? DETAILS : ['']) {
        const d = { import: await importOnce() };
        row.details.push(d);
        if (!d.import.ok) {
          d.error = await js(`(document.querySelector('.ds-import-drop')?.innerText ?? '').replace(/\\s+/g, ' ')`);
          console.log(`  error: ${d.error}`);
          await shot('error');
          throw new Error('import failed');
        }
        const on = await js(`(document.querySelector('#ri-detail .ds-opt.on .ot')?.textContent ?? '').trim()`);
        if (want && on && !on.startsWith(want)) {
          await js(`window.__lt.length = 0; window.__t1 = performance.now()`);
          startSampling();
          const t1 = Date.now();
          await click('#ri-detail .ds-opt', want);
          await until(`!document.querySelector('.ds-import-filerow')`, 10000);
          await until(filerowReady, 3600000);
          d.reread = { s: +((Date.now() - t1) / 1000).toFixed(1) };
          await sleep(2500);
          Object.assign(d.reread, stopSampling(), await longTasks('window.__t1'));
          console.log(`  re-read at ${want}: ${JSON.stringify(d.reread)}`);
        }
        d.detail = await js(`(document.querySelector('#ri-detail .ds-opt.on .ot')?.textContent ?? '').trim()`);
        const p = d.detail.toLowerCase() || 'model';
        d.facts = await js(`[...document.querySelectorAll('.ds-facts dt')].map((d) => d.textContent.trim() + ': ' + d.nextElementSibling.textContent.trim())`);
        d.fields = await js(`[...document.querySelectorAll('.ds-field .cap, .ds-import-opt .cap, [id^=ri-] .cap')].map((c) => c.textContent.replace(/\\s+/g, ' ').trim()).filter(Boolean)`);
        console.log(`  detail ${d.detail} | ${d.facts.join(' | ')}`);
        console.log(`  ${d.fields.join(' | ')}`);
        await shot(`${p}-model`);
        for (const view of ['Top', 'Front', 'Side']) {
          if (await click('.ds-import-cams button, [aria-label="Preview camera"] button', view)) await shot(`${p}-model-${view.toLowerCase()}`);
        }
        await click('.ds-import-cams button, [aria-label="Preview camera"] button', '3/4');
        {
          // a close-up in the preview: the wheel zooms in toward the model
          const r = await js(`(() => { const c = document.querySelector('.ds-import-canvas-host canvas'); const b = c.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
          for (let i = 0; i < 14; i++) {
            win.webContents.sendInputEvent({ type: 'mouseWheel', x: Math.round(r.x), y: Math.round(r.y), deltaX: 0, deltaY: 120 });
            await sleep(40);
          }
          await sleep(500);
          await shot(`${p}-model-zoom`);
          await click('.ds-import-cams button, [aria-label="Preview camera"] button', '3/4');
        }
        if (flag('orbit')) {
          // two seconds of dragging the preview round: each frame's work, the GPU's included
          const r = await js(`(() => { const c = document.querySelector('.ds-import-canvas-host canvas'); const b = c.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
          await sleep(1000);
          await js(`window.__lt.length = 0; window.__t2 = performance.now(); window.__ft = []`);
          win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(r.x), y: Math.round(r.y), button: 'left', clickCount: 1 });
          for (let i = 0; i < 120; i++) {
            win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(r.x + 200 * Math.sin(i / 19)), y: Math.round(r.y + 40 * Math.sin(i / 31)), button: 'left', modifiers: ['leftButtonDown'] });
            await sleep(16);
          }
          win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(r.x), y: Math.round(r.y), button: 'left', clickCount: 1 });
          await sleep(200);
          const ft = await js(`JSON.stringify(window.__ft)`).then(JSON.parse);
          await js(`window.__ft = null`);
          d.orbit = { ...frameStats(ft), ...(await longTasks('window.__t2')) };
          console.log(`  orbit: ${JSON.stringify(d.orbit)}`);
          await shot(`${p}-model-orbit`);
        }
        if (flag('reload')) {
          // the unsaved import comes back from its draft (the model as IndexedDB holds it)
          await sleep(3000);
          startSampling();
          const tr = Date.now();
          await win.loadURL(`${BASE}/${GAME}/configure/robot/import`);
          await until(filerowReady, 600000);
          d.draftRestore = { s: +((Date.now() - tr) / 1000).toFixed(1) };
          await sleep(1500);
          Object.assign(d.draftRestore, stopSampling(), await longTasks('0'));
          console.log(`  draft restored: ${JSON.stringify(d.draftRestore)}`);
        }
        await toReview();
        // the moving parts are found, and the model measured again with them (a deployed ramp folded),
        // after the steps are clicked through: Save waits for it
        await until(`[...document.querySelectorAll('button.ds-btn.primary')].some((b) => /Save/.test(b.textContent) && !b.disabled) && !document.querySelector('.ds-import-checks .bad, .ds-import-checks [data-level=block]')`, 180000);
        await sleep(1000);
        d.review = await js(`[...document.querySelectorAll('.ds-import-checks li')].map((l) => l.textContent.replace(/\\s+/g, ' ').trim())`);
        await shot(`${p}-review`);
        const before = new Set((await libraryRows()).map((x) => x.id));
        await js(`window.__lt.length = 0; window.__t3 = performance.now()`);
        startSampling();
        const ts = Date.now();
        await click('button.ds-btn.primary', 'Save');
        await until(`!location.pathname.includes('/import')`, 600000);
        d.save = { s: +((Date.now() - ts) / 1000).toFixed(1), ...(await longTasks('window.__t3')) };
        await sleep(1500);
        Object.assign(d.save, stopSampling());
        console.log(`  save: ${JSON.stringify(d.save)}`);
        const rec = (await libraryRows()).find((x) => !before.has(x.id));
        if (!rec) throw new Error('nothing saved');
        const xs = rec.imported.hull.map((q) => q.x);
        const ys = rec.imported.hull.map((q) => q.y);
        d.footprintIn = { length: +(Math.max(...xs) - Math.min(...xs)).toFixed(2), width: +(Math.max(...ys) - Math.min(...ys)).toFixed(2), height: rec.imported.heightIn };
        d.wheelsIn = rec.imported.wheels ?? null;
        // the whole saved descriptor (robot-local inches), for sim scenes built on this robot
        fs.writeFileSync(path.join(OUT, `${tag}-${p}-imported.json`), JSON.stringify(rec.imported, null, 2));
        d.source = rec.source;
        d.triBudget = rec.setup.triBudget;
        for (const kind of ['mesh', 'top']) {
          const b64 = await fileOf(rec.id, kind);
          if (!b64) continue;
          const buf = Buffer.from(b64, 'base64');
          fs.writeFileSync(path.join(OUT, `${tag}-${p}-stored.${kind === 'mesh' ? 'glb' : 'png'}`), buf);
          if (kind === 'mesh') d.storedMB = +(buf.length / 1048576).toFixed(2);
        }
        console.log(`  saved: footprint ${d.footprintIn.length} × ${d.footprintIn.width} in, height ${d.footprintIn.height} in, stored mesh ${d.storedMB} MB, ${JSON.stringify(rec.source)}`);
        // what was read: the build, and the moving parts with their body counts
        d.mech = rec.mech;
        d.motion = (rec.setup.motion ?? []).map((g) => `${g.role}${g.corner ?? ''}×${g.bodies.length}${g.follows ? ` follows ${g.follows.group}` : ''}`);
        console.log(`  build ${JSON.stringify(d.mech)}; moving parts ${d.motion.join(', ') || 'none'}; review ${d.review.join(' | ') || 'clear'}`);
        await shot(`${p}-robot-page`);
        robots.push({ rec, d, p });
      }
      // test drives: per tier, the robots side by side, `--reps` times over
      const passes = TIERS.length ? TIERS : [null];
      for (let rep = 0; rep < REPS; rep++) {
        for (const tier of passes) {
          for (const r of robots) {
            const pass = await drivePass(r.rec, tier, `${r.p}-${tier ?? 'drive'}${REPS > 1 ? `-r${rep}` : ''}`, false);
            (r.d.drive ??= []).push(pass);
          }
        }
      }
      if (GAME === 'biobuzz') for (const r of robots) await drivePass(r.rec, passes[passes.length - 1], `${r.p}-${passes[passes.length - 1] ?? 'drive'}`, true);
    } catch (e) {
      row.failure = String(e && e.message ? e.message : e);
      console.log(`  ${row.failure}`);
    } finally {
      clearInterval(sampler);
      row.logs = logs.slice(-20);
      results.push(row);
      fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
      win.destroy();
      await sleep(2000);
    }
  }
  srv.close();
  app.exit(0);
});
