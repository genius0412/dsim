/* THE IMPORTER AT REAL-CAD SCALE, MEASURED (lane 9). An OFFSCREEN Electron window against a
 * PRODUCTION build, driving the real editor with the stress robots `stress.ts` writes:
 *
 *   npx tsx scripts/robot-import/stress.ts                       # → %TEMP%/dsim-robot-stress
 *   VITE_ROBOT_IMPORT=1 npm run build && npx vite preview --port 4173 --strictPort   # the importer
 *                                     # ships on alpha only; the variable opens it in a local build
 *   env -u ELECTRON_RUN_AS_NODE npx electron scripts/robot-import/stressprobe.cjs \
 *       [--port 4173] [--dir <stress dir>] [--files stress-s.glb,stress-l.stl] [--gpu] [--out results.json]
 *
 * Per file, in a FRESH window (so the renderer's memory peak is this import's):
 *   1. the drop: the stage timeline read off the drop box's status line, every long task (> 50 ms)
 *      with the stage it started in, the renderer's peak working set (workers included: they live
 *      in the renderer process), and the time to the preview's first frame;
 *   2. the edits a player makes on the Model step — Units, Up axis, Turn left, a wheel nudged
 *      three times by keyboard — then a Drivetrain pick and a mechanism nudge: each one's blocking
 *      time (the click or key event returns after React's synchronous render) and its long tasks,
 *      and the time until the page shows the result;
 *   3. an orbit of the preview (a 40-move pointer drag): frame intervals;
 *   4. Save: the bake, to the robot page.
 *   5. Cancel: a second drop, cancelled 500 ms in; whether the page goes quiet (no long task in the
 *      next 3 s) and the drop box is ready again.
 *
 * A measurement, not a test: it prints a table and writes JSON (`--out`). Budgets are printed
 * against the lane's targets (no task over 100 ms) but do not fail the run.
 */
const { app, BrowserWindow, session } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = `http://localhost:${argOf('port', '4173')}`;
const DIR = path.resolve(argOf('dir', path.join(os.tmpdir(), 'dsim-robot-stress')));
const FILES = argOf('files', 'stress-s.glb,stress-s-flat.glb,stress-s.stl,stress-s.step,stress-m.glb,stress-m-flat.glb,stress-m.stl,stress-l.glb,stress-l-flat.glb,stress-l.stl').split(',');
const OUT = argOf('out', '');
const GAME = argOf('game', 'decode');

if (!process.argv.includes('--gpu')) app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('js-flags', '--expose-gc');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => {
  console.log('WATCHDOG');
  process.exit(2);
}, 3600000);

const OBSERVE = `window.__lt = [];
try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push({ t: e.startTime, d: e.duration }); }).observe({ type: 'longtask' }); } catch {}`;

// the stress files, over HTTP with CORS (the preview server does not serve the temp dir)
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const f = path.join(DIR, decodeURIComponent(req.url.slice(1)));
      if (!f.startsWith(DIR) || !fs.existsSync(f)) {
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

async function window_() {
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, useContentSize: true, webPreferences: { backgroundThrottling: false, offscreen: true } });
  win.webContents.setAudioMuted(true);
  const logs = [];
  win.webContents.on('console-message', (e) => {
    const m = e.message ?? '';
    if (/\[import\]|error|Too many active WebGL/i.test(m)) logs.push(m.slice(0, 300));
  });
  await win.loadURL(BASE + '/');
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Page.enable');
  await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVE });
  return { win, logs };
}

// each file gets its own window, so the last one closing must not quit the app
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const { srv, port } = await serve();
  const results = [];
  for (const name of FILES) {
    if (!fs.existsSync(path.join(DIR, name))) {
      console.log(`skip ${name}: not in ${DIR}`);
      continue;
    }
    const { win, logs } = await window_();
    const js = (s) => win.webContents.executeJavaScript(s);
    const until = (cond, ms = 30000) => js(`(async () => { const t0 = performance.now(); while (!(${cond})) { if (performance.now() - t0 > ${ms}) return false; await new Promise((r) => setTimeout(r, 25)); } return true; })()`);
    const pid = win.webContents.getOSProcessId();
    const memNow = () => {
      const m = app.getAppMetrics().find((x) => x.pid === pid);
      return m ? m.memory.workingSetSize / 1024 : 0;
    };
    let memPeak = 0;
    let sampling = false;
    // every 50 ms: the renderer's working set (peak while `sampling`) and its CPU since the last
    // sample (workers are threads of the renderer, so an import worker still running shows here)
    const cpuLog = [];
    const sampler = setInterval(() => {
      const m = app.getAppMetrics().find((x) => x.pid === pid);
      if (!m) return;
      cpuLog.push({ t: Date.now(), cpu: m.cpu.percentCPUUsage });
      if (cpuLog.length > 400) cpuLog.shift();
      if (sampling) memPeak = Math.max(memPeak, m.memory.workingSetSize / 1024);
    }, 50);
    const cpuBetween = (a, b) => {
      const s = cpuLog.filter((x) => x.t >= a && x.t <= b);
      return s.length ? Math.round(s.reduce((acc, x) => acc + x.cpu, 0) / s.length) : null;
    };
    const row = { file: name, mb: +(fs.statSync(path.join(DIR, name)).size / 1048576).toFixed(1) };
    try {
      await session.defaultSession.clearCache();
      await js(`localStorage.clear(); new Promise((r) => { const q = indexedDB.deleteDatabase('decodesim.robots'); q.onsuccess = q.onerror = q.onblocked = () => r(1); })`);
      await win.loadURL(`${BASE}/${GAME}/configure/robot/import`);
      await until(`document.querySelector('.ds-import-drop input[type=file]')`);
      await sleep(800);
      // the file into the page (the probe's work, not the importer's)
      await js(`(async () => { const r = await fetch('http://127.0.0.1:${port}/${name}'); window.__file = new File([await r.blob()], '${name}'); return 1; })()`);
      await sleep(500);
      if (typeof global.gc === 'function') global.gc();
      const memBase = memNow();
      await js(`window.__lt.length = 0; window.__tl = []; window.__fracs = new Set(); (() => {
        const t0 = performance.now(); window.__t0 = t0;
        const seen = (s) => { const last = window.__tl[window.__tl.length - 1]; if (!last || last.s !== s) window.__tl.push({ t: performance.now() - t0, s }); };
        const tick = () => {
          const od = document.querySelector('.ds-import-drop .od');
          const row = document.querySelector('.ds-import-filerow');
          seen(row ? 'done' : od ? od.textContent : '?');
          const fill = document.querySelector('.ds-import-drop .rec-fill');
          if (fill && fill.style.width && fill.style.width !== '2%') window.__fracs.add(fill.style.width);
          if (!row) window.__tick = requestAnimationFrame(tick);
        };
        new MutationObserver(() => { const od = document.querySelector('.ds-import-drop .od'); if (od) seen(od.textContent); }).observe(document.body, { subtree: true, childList: true, characterData: true });
        const input = document.querySelector('.ds-import-drop input[type=file]');
        const dt = new DataTransfer(); dt.items.add(window.__file);
        input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
        tick();
        return true;
      })()`);
      memPeak = memBase;
      sampling = true;
      await until(`(document.querySelector('.ds-import-filerow') && document.querySelector('.ds-import-canvas-host canvas')) || document.querySelector('.ds-import-drop .od.err')`, 600000);
      const ok = await js(`!!document.querySelector('.ds-import-filerow')`);
      const firstFrame = await js(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now() - window.__t0))))`);
      await sleep(1500);
      sampling = false;
      const lt = await js(`JSON.stringify({ lt: window.__lt.map((x) => ({ t: x.t - window.__t0, d: x.d })), tl: window.__tl, fracs: window.__fracs.size })`).then(JSON.parse);
      const stageAt = (t) => {
        let s = 'start';
        for (const p of lt.tl) if (p.t <= t) s = p.s;
        return s;
      };
      const tasks = lt.lt.filter((x) => x.t >= -5);
      row.import = {
        ok,
        firstFrameMs: Math.round(firstFrame),
        timeline: lt.tl.map((p) => `${Math.round(p.t)}:${p.s.replace(/stress-[a-z-]+\.\w+/, 'F')}`),
        longTasks: tasks.length,
        longestMs: Math.round(tasks.reduce((m, x) => Math.max(m, x.d), 0)),
        blockedMs: Math.round(tasks.reduce((s, x) => s + x.d, 0)),
        over100: tasks.filter((x) => x.d > 100).map((x) => `${Math.round(x.d)}@${stageAt(x.t).replace(/stress-[a-z-]+\.\w+/, 'F')}`),
        progressSteps: lt.fracs,
        memBaseMB: Math.round(memBase),
        memPeakMB: Math.round(memPeak),
      };
      if (!ok) throw new Error(`the import did not finish: ${await js(`(document.querySelector('.ds-import-drop')?.innerText ?? '').replace(/\\s+/g, ' ')`)}`);
      row.facts = await js(`[...document.querySelectorAll('.ds-facts dd')].map((d) => d.textContent.trim()).join(' | ')`);
      console.log(`\n${name} (${row.mb} MB): first frame ${row.import.firstFrameMs} ms, long tasks ${row.import.longTasks} (longest ${row.import.longestMs}, total ${row.import.blockedMs}), memory ${row.import.memBaseMB} → ${row.import.memPeakMB} MB`);
      console.log(`  timeline ${row.import.timeline.join(' → ')}  (progress bar: ${row.import.progressSteps} distinct widths)`);
      console.log(`  > 100 ms: ${row.import.over100.join(', ') || 'none'}`);
      console.log(`  ${row.facts}`);

      // ---- edits ----
      // `act` runs the action and measures: the synchronous part (the event returns after React's
      // render), the long tasks, and the time until `settled` is true
      const act = async (label, action, settled) => {
        await js(`window.__lt.length = 0; true`);
        const r = await js(`(async () => {
          const t0 = performance.now();
          const before = ${settled ? `(${settled.before})()` : 'null'};
          ${action};
          const sync = performance.now() - t0;
          ${settled ? `while (!((${settled.done})(before))) { if (performance.now() - t0 > ${settled.ms ?? 60000}) break; await new Promise((r) => requestAnimationFrame(r)); }` : ''}
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          return { sync, settle: performance.now() - t0 };
        })()`);
        await sleep(400);
        const t = await js(`JSON.stringify(window.__lt)`).then(JSON.parse);
        const out = { sync: Math.round(r.sync), settle: Math.round(r.settle), longest: Math.round(t.reduce((m, x) => Math.max(m, x.d), 0)), tasks: t.length };
        console.log(`  ${label.padEnd(28)} sync ${String(out.sync).padStart(5)} ms  settled ${String(out.settle).padStart(5)} ms  longest task ${String(out.longest).padStart(5)} ms (${out.tasks})`);
        return out;
      };
      const size = `() => document.querySelector('.ds-facts dd')?.textContent`;
      const changed = `(b) => document.querySelector('.ds-facts dd')?.textContent !== b`;
      const clickOpt = (sel, text) => `[...document.querySelectorAll('${sel} .ds-opt')].find((b) => b.textContent.trim() === '${text}')?.click()`;
      const units = await js(`[...document.querySelectorAll('#ri-units .ds-opt')].find((b) => b.classList.contains('on'))?.textContent.trim()`);
      const up = await js(`[...document.querySelectorAll('#ri-up .ds-opt')].find((b) => b.classList.contains('on'))?.textContent.trim()`);
      row.edits = {};
      row.edits.unitsIn = await act('Units → in', clickOpt('#ri-units', units === 'in' ? 'cm' : 'in'), { before: size, done: changed });
      row.edits.unitsBack = await act(`Units → ${units}`, clickOpt('#ri-units', units), { before: size, done: changed });
      row.edits.upX = await act('Up → +X', clickOpt('#ri-up', up === '+X' ? '+Y' : '+X'), { before: size, done: changed });
      row.edits.upBack = await act(`Up → ${up}`, clickOpt('#ri-up', up), { before: size, done: changed });
      row.edits.turn = await act('Turn left', `[...document.querySelectorAll('.ds-import-turns .ds-btn')][0].click()`, { before: size, done: changed });
      row.edits.turnBack = await act('Turn right', `[...document.querySelectorAll('.ds-import-turns .ds-btn')][1].click()`, { before: size, done: changed });
      const handle = `document.querySelector('.ds-import-handle.wheel')`;
      const label = `() => ${handle}?.getAttribute('aria-label')`;
      const moved = `(b) => ${handle}?.getAttribute('aria-label') !== b`;
      const key = (k) => `${handle}.focus(); ${handle}.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', bubbles: true }))`;
      row.edits.wheel1 = await act('Wheel nudge 1', key('ArrowRight'), { before: label, done: moved });
      row.edits.wheel2 = await act('Wheel nudge 2', key('ArrowRight'), { before: label, done: moved });
      row.edits.wheel3 = await act('Wheel nudge 3', key('ArrowLeft'), { before: label, done: moved });
      // the preview: a pointer orbit, frame intervals
      row.orbit = await js(`(async () => {
        const c = document.querySelector('.ds-import-canvas-host canvas');
        if (!c) return null;
        const r = c.getBoundingClientRect();
        const x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
        // OrbitControls zooms on a wheel event and renders on the next frame: one per frame, 40 of
        // them (a synthetic pointer drag cannot take pointer capture, so it would not orbit)
        window.__lt.length = 0;
        const frames = [];
        let last = performance.now(), run = true;
        const loop = (t) => { frames.push(t - last); last = t; if (run) requestAnimationFrame(loop); };
        requestAnimationFrame((t) => { last = t; requestAnimationFrame(loop); });
        for (let i = 1; i <= 40; i++) {
          c.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: x0, clientY: y0, deltaY: i % 2 ? 60 : -60, deltaMode: 0 }));
          await new Promise((r) => requestAnimationFrame(r));
        }
        await new Promise((r) => setTimeout(r, 200));
        run = false;
        const f = frames.slice(1).sort((a, b) => a - b);
        return { frames: f.length, median: Math.round(f[Math.floor(f.length / 2)] ?? 0), p95: Math.round(f[Math.floor(f.length * 0.95)] ?? 0), worst: Math.round(f[f.length - 1] ?? 0), longest: Math.round(window.__lt.reduce((m, x) => Math.max(m, x.d), 0)) };
      })()`);
      console.log(`  orbit: ${JSON.stringify(row.orbit)}`);
      // Drivetrain: a different gearbox
      await js(`document.querySelectorAll('.ds-import-steps .ds-tab')[1].click(); true`);
      await sleep(600);
      row.edits.drive = await act('Drivetrain: gearbox', `(() => { const opts = [...document.querySelectorAll('#ri-motor .ds-opt')]; const off = opts.filter((b) => !b.classList.contains('on')); off[off.length - 1]?.click(); })()`, null);
      // Mechanisms: nudge the first handle
      await js(`document.querySelectorAll('.ds-import-steps .ds-tab')[2].click(); true`);
      await sleep(600);
      const mh = `document.querySelector('.ds-import-handle')`;
      row.edits.mech = await act('Mechanism nudge', `${mh}?.focus(); ${mh}?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))`, { before: `() => ${mh}?.getAttribute('aria-label')`, done: `(b) => ${mh}?.getAttribute('aria-label') !== b`, ms: 3000 });
      // Save: the bake
      await js(`document.querySelectorAll('.ds-import-steps .ds-tab')[3].click(); true`);
      await sleep(800);
      sampling = true;
      row.save = await act('Save (bake)', `[...document.querySelectorAll('.ds-import-foot .ds-btn.primary')].find((b) => /Save/.test(b.textContent))?.click()`, { before: `() => 0`, done: `() => location.pathname.endsWith('/configure/robot')` });
      sampling = false;
      row.save.memPeakMB = Math.round(memPeak);
      // Cancel: a second drop of the same file, cancelled 500 ms in. First: does the page come back
      // with a draft after a Save (it should not)?
      await win.loadURL(`${BASE}/${GAME}/configure/robot/import`);
      await sleep(1500);
      row.draftAfterSave = await js(`!!document.querySelector('.ds-import-filerow')`);
      console.log(`  a fresh import page after Save opens ${row.draftAfterSave ? 'WITH A DRAFT' : 'empty'}`);
      await js(`new Promise((r) => { const q = indexedDB.deleteDatabase('decodesim.robots'); q.onsuccess = q.onerror = q.onblocked = () => r(1); })`);
      await win.loadURL(`${BASE}/${GAME}/configure/robot/import`);
      await until(`document.querySelector('.ds-import-drop input[type=file]')`);
      await sleep(600);
      await js(`(async () => { const r = await fetch('http://127.0.0.1:${port}/${name}'); window.__file = new File([await r.blob()], '${name}'); return 1; })()`);
      await sleep(300);
      // the click lands 40 % of the way into this file's import; then the renderer's CPU from 0.5 s
      // to 2.5 s after it, against the 1 s before it (an import still running keeps a core busy)
      const tDrop = Date.now();
      row.cancel = await js(`(async () => {
        const input = document.querySelector('.ds-import-drop input[type=file]');
        const dt = new DataTransfer(); dt.items.add(window.__file);
        input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, ${Math.max(150, Math.round((row.import?.firstFrameMs ?? 1000) * 0.4))}));
        const t0 = performance.now();
        const btn = [...document.querySelectorAll('.ds-import-drop .ds-btn')].find((b) => /Cancel/.test(b.textContent));
        if (!btn) return { clicked: false, note: 'no Cancel button (already done?)' };
        btn.click();
        window.__lt.length = 0;
        return { clicked: true, clickMs: Math.round(performance.now() - t0) };
      })()`);
      const tClick = Date.now();
      await sleep(3000);
      if (row.cancel.clicked) {
        Object.assign(row.cancel, await js(`(() => ({
          readyAfter3s: !!document.querySelector('.ds-import-drop #ri-choose'),
          longestTaskAfterMs: Math.round(window.__lt.reduce((m, x) => Math.max(m, x.d), 0)),
          modelAppeared: !!document.querySelector('.ds-import-filerow'),
        }))()`));
        row.cancel.cpuBeforePct = cpuBetween(Math.max(tDrop, tClick - 1000), tClick);
        row.cancel.cpuAfterPct = cpuBetween(tClick + 500, tClick + 2500);
        // the same in 250 ms steps from the click, % of ALL logical cores (1 core = 100 / cores)
        row.cancel.cpuSteps = Array.from({ length: 10 }, (_, i) => cpuBetween(tClick + 250 * i, tClick + 250 * (i + 1)));
      }
      console.log(`  cancel: ${JSON.stringify(row.cancel)}`);
      if (logs.length) row.logs = logs.slice(0, 8);
    } catch (err) {
      row.error = String(err && err.stack ? err.stack : err);
      console.log(`  ERROR ${row.error}`);
    }
    clearInterval(sampler);
    results.push(row);
    win.destroy();
    await sleep(500);
  }
  srv.close();
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  app.exit(0);
});
