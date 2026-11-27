/* ONE REAL ROBOT STEP THROUGH THE REAL EDITOR, FIELD-TEST STYLE (a measurement, not a test).
 * One OFFSCREEN, MUTED Electron window on an in-memory partition, against an alpha-channel dev server:
 *
 *   VITE_APP_CHANNEL=alpha npx vite --config scripts/vite.window.config.ts --port 5194 --strictPort
 *   env -u ELECTRON_RUN_AS_NODE npx electron scripts/cadfieldprobe.cjs --file <abs path .step|.zip> --out <dir>
 *       [--port 5194] [--game biobuzz] [--details Light,Full] [--gpu] [--phases import,drive,stress]
 *
 * The file is handed to the drop box's <input type=file> through the debugger (DOM.setFileInputFiles), so
 * the page never holds its bytes. Phases:
 *   import  per Detail: the drop (timeline, renderer/main/all-process peaks), the Model step's facts and
 *           every line it says, pictures (3/4, Top, Front, Side, Collision shape), each step's text and
 *           picture, Review's items, Save, the library record (descriptor, setup, stored mesh, top PNG,
 *           written to <out>), Export file (the share file) and the share file added back (the record and
 *           stored mesh compared before/after)
 *   drive   per saved robot: re-open, Review, Test drive in 2D, then 3D (needs --gpu): the mesh slots, the
 *           robot pose before/after a forward key, frame times, console errors, pictures
 *   stress  Back in the middle of a read (workers, memory, Resume card), Replace mid-edit, Detail changed on
 *           Review, a reload mid-edit and Resume, re-open, Duplicate, Delete
 * Writes <out>/results.json and <out>/*.png. Never shown, never audible.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const argOf = (n, f) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : f; };
const flag = (n) => process.argv.includes(`--${n}`);
const BASE = `http://localhost:${argOf('port', '5194')}`;
const FILE = path.resolve(argOf('file', ''));
const OUT = path.resolve(argOf('out', 'scratch/cadfield'));
const GAME = argOf('game', 'biobuzz');
const DETAILS = argOf('details', 'Light,Full').split(',').filter(Boolean);
const PHASES = argOf('phases', 'import,drive').split(',').filter(Boolean);
const GPU = flag('gpu');
const TAG = argOf('tag', 'r');
// `--effects standard`: the drive's graphics stay Low but with this effects level (Low's `minimal` turns
// no wheel), so a 3D drive can show the import's wheels turning
const EFFECTS = argOf('effects', '');
const GFX = JSON.stringify(EFFECTS ? { preset: 'custom', tier: 'low', settings: { effects: EFFECTS } } : { preset: 'low', tier: 'low' });
fs.mkdirSync(OUT, { recursive: true });
if (!GPU) app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('js-flags', '--expose-gc');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// a hung window can keep process.exit from returning: app.exit first, then a hard exit on a timer
setTimeout(() => { console.log('WATCHDOG'); dump(); setTimeout(() => process.exit(2), 3000); try { app.exit(2); } catch {} process.exit(2); }, Number(argOf('watchdog', '7200')) * 1000);
app.on('window-all-closed', () => {});

const results = { file: path.basename(FILE), bytes: fs.existsSync(FILE) ? fs.statSync(FILE).size : 0, gpu: GPU, game: GAME, details: [], drives: [], stress: [], console: [] };
function dump() { try { fs.writeFileSync(path.join(OUT, `${TAG}-results.json`), JSON.stringify(results, null, 1)); } catch {} }
const log = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log(line);
  try { fs.appendFileSync(path.join(OUT, `${TAG}-progress.log`), `${new Date().toISOString().slice(11, 19)} ${line}\n`); } catch {}
};

const OBSERVE = `window.__lt = []; window.__ft = null;
try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push({ t: e.startTime, d: e.duration }); }).observe({ type: 'longtask' }); } catch {}
(() => { const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((t) => { if (!window.__ft) return cb(t); const t0 = performance.now(); try { cb(t); } finally { const d = performance.now() - t0; const f = window.__ft; const last = f[f.length - 1]; if (last && last.t === t) last.d += d; else f.push({ t, d }); } });
  const W = window.Worker; window.__workers = [];
  window.Worker = function (u, o) { const w = new W(u, o); const rec = { url: String(u).split('/').pop().split('?')[0], alive: true }; window.__workers.push(rec); const t = w.terminate.bind(w); w.terminate = () => { rec.alive = false; t(); }; return w; };
  window.Worker.prototype = W.prototype;
})();`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1600, height: 1000, show: false, useContentSize: true, webPreferences: { backgroundThrottling: false, offscreen: true, partition: `cadfield-${Date.now()}` } });
  win.webContents.setAudioMuted(true);
  const downloads = [];
  win.webContents.session.on('will-download', (_e, item) => {
    const to = path.join(OUT, `${TAG}-dl-${downloads.length}-${item.getFilename()}`);
    item.setSavePath(to);
    item.once('done', (_ev, state) => downloads.push({ to, state, bytes: item.getReceivedBytes() }));
  });
  win.webContents.on('console-message', (e) => {
    const lvl = e.level;
    const m = String(e.message ?? '');
    if (lvl === 'error' || lvl === 'warning' || lvl === 3 || lvl === 2) { if (results.console.length < 300) results.console.push(`${lvl}: ${m.slice(0, 300)}`); }
  });
  win.webContents.on('render-process-gone', (_e, d) => { results.console.push(`RENDER GONE: ${JSON.stringify(d)}`); log('RENDER GONE', d); });
  // a page first: Page.enable on a window that never loaded one does not answer
  await win.loadURL(BASE + '/');
  log('first page loaded');
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  await dbg.sendCommand('Page.enable');
  await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVE });
  const js = (s) => win.webContents.executeJavaScript(s);
  const until = (cond, ms = 30000) => js(`(async () => { const t0 = performance.now(); while (true) { let ok = false; try { ok = !!(${cond}); } catch {} if (ok) return true; if (performance.now() - t0 > ${ms}) return false; await new Promise((r) => setTimeout(r, 100)); } })()`);
  let shotN = 0;
  const shot = async (what) => {
    await sleep(400);
    const img = await win.webContents.capturePage();
    const p = path.join(OUT, `${TAG}-${String(++shotN).padStart(2, '0')}-${what}.png`);
    fs.writeFileSync(p, img.toPNG());
    return path.basename(p);
  };
  const click = async (sel, text, exact = false) => {
    const r = await js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => ${text == null ? 'true' : exact ? `x.textContent.trim() === ${JSON.stringify(text)}` : `x.textContent.trim().startsWith(${JSON.stringify(text)})`}); if (!b) return 'missing'; if (b.disabled) return 'disabled'; b.click(); return 'ok'; })()`);
    await sleep(200);
    return r;
  };
  const setInputFile = async (sel, file) => {
    const { root } = await dbg.sendCommand('DOM.getDocument', { depth: 0 });
    const { nodeId } = await dbg.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
    if (!nodeId) return false;
    await dbg.sendCommand('DOM.setFileInputFiles', { files: [file], nodeId });
    return true;
  };
  // memory: the renderer (the import's workers are its threads), the main process, and every process
  const pid = () => win.webContents.getOSProcessId();
  let peaks = null;
  setInterval(() => {
    if (!peaks) return;
    const ms = app.getAppMetrics();
    const r = ms.find((x) => x.pid === pid());
    if (r) peaks.renderer = Math.max(peaks.renderer, r.memory.workingSetSize / 1024);
    const b = ms.find((x) => x.type === 'Browser');
    if (b) peaks.main = Math.max(peaks.main, b.memory.workingSetSize / 1024);
    peaks.gpu = Math.max(peaks.gpu, ms.filter((x) => x.type === 'GPU').reduce((s, x) => s + x.memory.workingSetSize / 1024, 0));
    peaks.all = Math.max(peaks.all, ms.reduce((s, x) => s + x.memory.workingSetSize / 1024, 0));
  }, 100);
  const memNow = () => { const ms = app.getAppMetrics(); return { renderer: Math.round((ms.find((x) => x.pid === pid())?.memory.workingSetSize ?? 0) / 1024), all: Math.round(ms.reduce((s, x) => s + x.memory.workingSetSize / 1024, 0)) }; };
  const startPeaks = () => { peaks = { renderer: 0, main: 0, gpu: 0, all: 0 }; };
  const stopPeaks = () => { const p = peaks; peaks = null; return Object.fromEntries(Object.entries(p).map(([k, v]) => [k + 'PeakMB', Math.round(v)])); };
  const longTasks = async (since) => {
    const lt = await js(`JSON.stringify((window.__lt || []).map((x) => ({ t: x.t - (${since}), d: x.d })))`).then(JSON.parse);
    const t = lt.filter((x) => x.t >= -5);
    return { longTasks: t.length, longestMs: Math.round(t.reduce((m, x) => Math.max(m, x.d), 0)), blockedMs: Math.round(t.reduce((s, x) => s + x.d, 0)) };
  };
  const lib = (what) => js(`new Promise((res) => { const q = indexedDB.open('decodesim.robots'); q.onerror = () => res('[]'); q.onsuccess = () => { const db = q.result;
    if (!db.objectStoreNames.contains(${JSON.stringify(what)})) { db.close(); return res('[]'); }
    const all = db.transaction(${JSON.stringify(what)}, 'readonly').objectStore(${JSON.stringify(what)}).getAll();
    all.onsuccess = () => { db.close(); res(JSON.stringify(all.result.map((r) => (${what === 'robots' ? `{ id: r.id, name: r.spec && r.spec.name, imported: r.spec && r.spec.imported, setup: r.setup, source: r.source, updated: r.updated, mech: r.spec && (r.spec.bbMech ?? null) }` : `{ key: r.key ?? r.id ?? null, keys: Object.keys(r) }`})))); }; all.onerror = () => res('[]'); }; })`).then(JSON.parse);
  const fileOf = (key) => js(`new Promise((res) => { const q = indexedDB.open('decodesim.robots'); q.onsuccess = () => { const g = q.result.transaction('files', 'readonly').objectStore('files').get(${JSON.stringify(key)}); g.onsuccess = async () => { if (!g.result) return res(''); const u8 = new Uint8Array(await g.result.arrayBuffer()); let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode(...u8.subarray(i, i + 8192)); res(btoa(s)); }; g.onerror = () => res(''); }; q.onerror = () => res(''); })`);
  const bodyText = (sel = '.ds-import, main, body') => js(`(document.querySelector(${JSON.stringify(sel)})?.innerText ?? '').replace(/[ \\t]+/g, ' ').slice(0, 6000)`);
  const panelTitle = () => js(`document.querySelector('.ds-import-body .ds-panel-title')?.textContent?.trim() ?? ''`);
  const workersAlive = () => js(`(window.__workers || []).filter((w) => w.alive).map((w) => w.url)`);
  const freshDevice = async () => {
    await win.loadURL(BASE + '/');
    await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('decodesim.theme', 'dark'); localStorage.setItem('decodesim.graphics', JSON.stringify({ preset: 'low', tier: 'low' })); localStorage.setItem('decodesim.view.v2', '2d');
      new Promise((r) => { const q = indexedDB.deleteDatabase('decodesim.robots'); q.onsuccess = q.onerror = q.onblocked = () => r(1); })`);
  };
  const DROP = '.ds-import-drop input[type=file]';
  const modelReady = `(document.querySelector('.ds-import-filerow') && document.querySelector('.ds-import-canvas-host canvas'))`;
  const saveReady = `(document.getElementById('ri-save-head') && !document.getElementById('ri-save-head').disabled)`;

  /** open the importer empty, pick Detail, hand the file; returns once the model is shown or an error is */
  const dropFile = async (detail, file = FILE) => {
    log(`drop: loading the importer (${detail})`);
    await win.loadURL(`${BASE}/${GAME}/configure/robot/import`);
    const there = await until(`document.querySelector('${DROP}')`, 60000);
    log(`drop: drop box ${there}, path ${await js('location.pathname')}`);
    if (!there) await shot('no-dropbox');
    await sleep(800);
    if (detail) log(`drop: detail click ${await click('.ds-import-before .ds-opt', detail)}`);
    await js(`window.__lt.length = 0; window.__tl = []; (() => { const t0 = performance.now(); window.__t0 = t0;
      const seen = (s) => { const last = window.__tl[window.__tl.length - 1]; if (!last || last.s !== s) window.__tl.push({ t: Math.round(performance.now() - t0), s }); };
      new MutationObserver(() => { const od = document.querySelector('.ds-import-drop .od'); const pt = document.querySelector('.ds-import-body .ds-panel-title'); if (od) seen(od.textContent); else if (pt) seen('title: ' + pt.textContent); }).observe(document.body, { subtree: true, childList: true, characterData: true }); })()`);
    startPeaks();
    const mem0 = memNow();
    const t0 = Date.now();
    log(`drop: setInputFile ${await setInputFile(DROP, file)}`);
    // a staged file waits for Start import
    await sleep(600);
    log(`drop: after set: ${(await bodyText('.ds-import-body')).slice(0, 200).replace(/\n/g, ' / ')}`);
    if (await js(`!!document.getElementById('ri-start')`)) await click('#ri-start', null);
    const shown = await until(`${modelReady} || document.querySelector('.ds-import-drop [role=alert]') || document.querySelector('.ds-import-drop .od.err')`, 3600000);
    const tModel = (Date.now() - t0) / 1000;
    const ok = await js(`!!document.querySelector('.ds-import-filerow')`);
    let tSave = null;
    if (ok) { if (await until(saveReady, 900000)) tSave = (Date.now() - t0) / 1000; }
    await sleep(1500);
    const mem = stopPeaks();
    const tl = (await js(`JSON.stringify(window.__tl)`).then(JSON.parse)).map((p) => ({ t: p.t, s: p.s.replace(/\d+(\.\d+)?%/, '').replace(/about \d+ (min|s)( left)?/, 'about N left').trim() }));
    const thin = [];
    for (const p of tl) if (!thin.length || thin[thin.length - 1].s !== p.s) thin.push(p);
    return { ok, shown, toModelS: +tModel.toFixed(1), toSaveReadyS: tSave && +tSave.toFixed(1), memBefore: mem0, ...mem, ...(await longTasks('window.__t0')), timeline: thin.slice(0, 40).map((p) => `${(p.t / 1000).toFixed(1)}s ${p.s.slice(0, 120)}`), error: ok ? null : await js(`(document.querySelector('.ds-import-drop')?.innerText ?? '').replace(/\\s+/g, ' ')`) };
  };

  const modelFacts = async () => js(`({
    facts: [...document.querySelectorAll('.ds-facts dt')].map((d) => d.textContent.trim() + ': ' + (d.nextElementSibling?.textContent.trim() ?? '')),
    file: document.querySelector('.ds-import-filerow')?.innerText.replace(/\\s+/g, ' '),
    units: document.querySelector('#ri-units select')?.value, up: document.querySelector('#ri-up select')?.value,
    front: document.querySelector('#ri-front')?.innerText.replace(/\\s+/g, ' ').slice(0, 300),
    wheels: document.querySelector('#ri-wheels')?.innerText.replace(/\\s+/g, ' ').slice(0, 600),
    parts: document.querySelector('#ri-parts')?.innerText.replace(/\\s+/g, ' ').slice(0, 400),
    detail: (document.querySelector('#ri-detail .ds-opt.on .ot')?.textContent ?? document.querySelector('#ri-detail .ds-opt.on')?.textContent ?? '').trim(),
    hints: [...document.querySelectorAll('.ds-import-body .ds-hint, .ds-import-body [role=alert], .ds-import-body .ds-note')].map((h) => h.textContent.replace(/\\s+/g, ' ').trim()).filter(Boolean).slice(0, 20),
    title: document.querySelector('.ds-import-body .ds-panel-title')?.textContent?.trim(),
  })`);
  const cams = async (p) => {
    const out = {};
    for (const v of ['Top', 'Front', 'Side', '3/4']) { if ((await click('.ds-import-preview-tools .ds-seg', v, true)) === 'ok') { await sleep(900); out[v] = await shot(`${p}-cam-${v.replace('/', '')}`); } }
    if ((await click('.ds-import-preview-tools .ds-seg', 'Collision shape', true)) === 'ok') {
      await click('.ds-import-preview-tools .ds-seg', 'Top', true); await sleep(900); out.collisionTop = await shot(`${p}-collision-top`);
      await click('.ds-import-preview-tools .ds-seg', '3/4', true); await sleep(900); out.collision34 = await shot(`${p}-collision-34`);
      await click('.ds-import-preview-tools .ds-seg', 'Collision shape', true);
    }
    return out;
  };
  const steps = ['Drivetrain', 'Mechanisms', 'Moving parts', 'Review'];
  const walkSteps = async (p) => {
    const seen = [];
    for (let i = 0; i < steps.length; i++) {
      const r = await click('.ds-import-tabs .ds-tab, .ds-import-steps .ds-tab', steps[i], false);
      if (r !== 'ok') await js(`document.querySelectorAll('.ds-import-steps .ds-tab')[${i + 1}]?.click()`);
      await sleep(1500);
      if (steps[i] === 'Review') await until(`!/Preparing|Measuring|Looking/.test(document.querySelector('.ds-import-body .ds-panel-title')?.textContent ?? '')`, 300000);
      await sleep(800);
      seen.push({ step: steps[i], title: await panelTitle(), text: (await bodyText('.ds-import-body')).slice(0, 1500), shot: await shot(`${p}-step-${steps[i].replace(/ /g, '')}`) });
    }
    return seen;
  };

  const imported = [];
  if (PHASES.includes('import')) {
    log(`start: ${FILE} → ${OUT}, details ${DETAILS}, gpu ${GPU}`);
    await freshDevice();
    log('fresh device');
    for (const detail of DETAILS) {
      const d = { detail };
      results.details.push(d);
      const p = `${detail.toLowerCase()}`;
      log(`\n== import at ${detail}`);
      d.drop = await dropFile(detail);
      log(JSON.stringify(d.drop));
      dump();
      if (!d.drop.ok) { d.dropShot = await shot(`${p}-error`); continue; }
      d.model = await modelFacts();
      d.modelText = (await bodyText('.ds-import-body')).slice(0, 3000);
      log(JSON.stringify(d.model));
      d.modelShot = await shot(`${p}-model`);
      d.cams = await cams(p);
      d.steps = await walkSteps(p);
      d.review = await js(`({ title: document.querySelector('.ds-import-body .ds-panel-title')?.textContent?.trim(), items: [...document.querySelectorAll('.ds-import-checks li')].map((l) => l.className + ': ' + l.textContent.replace(/\\s+/g, ' ').trim()), save: (() => { const b = [...document.querySelectorAll('.ds-import-foot .ds-btn')].find((x) => /^Save/.test(x.textContent.trim())); return b ? { disabled: b.disabled, title: b.title } : null; })() })`);
      log('review', JSON.stringify(d.review));
      dump();
      if (d.review.save && !d.review.save.disabled) {
        const before = new Set((await lib('robots')).map((x) => x.id));
        await js(`window.__lt.length = 0; window.__t3 = performance.now()`);
        startPeaks();
        const ts = Date.now();
        await click('.ds-import-foot .ds-btn.primary', 'Save');
        const left = await until(`!location.pathname.includes('/import')`, 900000);
        d.save = { left, s: +((Date.now() - ts) / 1000).toFixed(1), ...(await longTasks('window.__t3')) };
        await sleep(1500);
        Object.assign(d.save, stopPeaks());
        const rec = (await lib('robots')).find((x) => !before.has(x.id));
        if (rec) {
          fs.writeFileSync(path.join(OUT, `${TAG}-${p}-record.json`), JSON.stringify(rec, null, 1));
          fs.writeFileSync(path.join(OUT, `${TAG}-${p}-imported.json`), JSON.stringify(rec.imported, null, 1));
          const xs = rec.imported.hull.map((q) => q.x), ys = rec.imported.hull.map((q) => q.y);
          d.saved = { id: rec.id, name: rec.name, footprint: [+(Math.max(...xs) - Math.min(...xs)).toFixed(2), +(Math.max(...ys) - Math.min(...ys)).toFixed(2)], heightIn: rec.imported.heightIn, wheels: rec.imported.wheels, hullN: rec.imported.hull.length, bands: (rec.imported.bands || []).length, triBudget: rec.setup?.triBudget, motion: (rec.setup?.motion ?? []).map((g) => `${g.role}${g.corner ?? ''}x${g.bodies?.length}`), mech: rec.mech, source: rec.source, descriptorBytes: JSON.stringify(rec.imported).length };
          for (const kind of ['mesh', 'top', 'thumb']) {
            const b64 = await fileOf(`${rec.id}:${kind}`);
            if (!b64) continue;
            const buf = Buffer.from(b64, 'base64');
            const f = path.join(OUT, `${TAG}-${p}-stored-${kind}.${kind === 'mesh' ? 'glb' : 'png'}`);
            fs.writeFileSync(f, buf);
            d.saved[`${kind}Bytes`] = buf.length;
            d.saved[`${kind}Sha`] = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
          }
          imported.push({ rec, p });
        }
        log('saved', JSON.stringify(d.save), JSON.stringify(d.saved));
        d.robotPage = await shot(`${p}-robot-page`);
        // Export file, then the share file added back
        if (rec) {
          const n0 = downloads.length;
          let ex = 'missing';
          for (let t = 0; t < 60 && ex !== 'ok'; t++) { ex = await click('.ds-panel .ds-btn', 'Export file', true); if (ex !== 'ok') await sleep(500); }
          const te = Date.now();
          for (let i = 0; i < 1200 && downloads.length === n0; i++) await sleep(100);
          const dl = downloads[downloads.length - 1];
          d.export = { click: ex, s: +((Date.now() - te) / 1000).toFixed(1), ...(downloads.length > n0 ? { file: path.basename(dl.to), state: dl.state, bytes: dl.bytes, sha: crypto.createHash('sha256').update(fs.readFileSync(dl.to)).digest('hex').slice(0, 12) } : { file: null }) };
          log('export', JSON.stringify(d.export));
          if (downloads.length > n0 && dl.state === 'completed') {
            const recBefore = (await lib('robots')).find((x) => x.id === rec.id);
            const meshBefore = await fileOf(`${rec.id}:mesh`);
            await win.loadURL(`${BASE}/${GAME}/configure/robot/import`);
            await until(`document.querySelector('${DROP}')`, 30000);
            await sleep(600);
            const ta = Date.now();
            await setInputFile(DROP, dl.to);
            await sleep(800);
            if (await js(`!!document.getElementById('ri-start')`)) await click('#ri-start', null);
            const landed = await until(`location.pathname.endsWith('/configure/robot') || document.querySelector('.ds-import-drop [role=alert]') || document.querySelector('.ds-modal')`, 300000);
            await sleep(1500);
            const after = await lib('robots');
            const same = after.find((x) => x.id === rec.id);
            const meshAfter = same ? await fileOf(`${rec.id}:mesh`) : '';
            d.reimport = { landed, s: +((Date.now() - ta) / 1000).toFixed(1), path: await js('location.pathname'), modal: await js(`document.querySelector('.ds-modal')?.innerText ?? null`), alert: await js(`document.querySelector('.ds-import-drop [role=alert]')?.innerText ?? null`), records: after.length, sameIdKept: !!same, descriptorIdentical: !!same && JSON.stringify(same.imported) === JSON.stringify(recBefore.imported), setupIdentical: !!same && JSON.stringify(same.setup) === JSON.stringify(recBefore.setup), meshIdentical: !!same && meshAfter === meshBefore, meshBytesBefore: meshBefore.length * 0.75 | 0, meshBytesAfter: meshAfter.length * 0.75 | 0 };
            if (same) {
              const a = recBefore.setup ?? {}, b = same.setup ?? {};
              d.reimport.setupKeysChanged = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map((k) => `${k}: ${JSON.stringify(a[k] ?? null).slice(0, 80)} → ${JSON.stringify(b[k] ?? null).slice(0, 80)}`);
              fs.writeFileSync(path.join(OUT, `${TAG}-${p}-record-after-share.json`), JSON.stringify(same, null, 1));
            }
            log('reimport', JSON.stringify(d.reimport));
            d.reimportShot = await shot(`${p}-share-readded`);
          }
        }
      } else {
        d.blockedShot = await shot(`${p}-review-blocked`);
      }
      dump();
    }
  }

  if (PHASES.includes('drive')) {
    const robots = imported.length ? imported : (await lib('robots')).map((rec) => ({ rec, p: `${rec.setup?.triBudget ? 'light' : 'full'}` }));
    for (const { rec, p } of robots) {
      for (const view of GPU ? ['2d', '3d'] : ['2d']) {
        const dv = { robot: rec.name, detail: p, view };
        results.drives.push(dv);
        log(`\n== drive ${p} ${view}`);
        await js(`localStorage.setItem('decodesim.view.v2', '${view}'); localStorage.setItem('decodesim.graphics', ${JSON.stringify(GFX)}); 1`);
        startPeaks();
        const tr = Date.now();
        await win.loadURL(`${BASE}/${GAME}/configure/robot/import/${rec.id}`);
        await until(modelReady, 900000);
        dv.reopenS = +((Date.now() - tr) / 1000).toFixed(1);
        await until(saveReady, 300000);
        await js(`document.querySelectorAll('.ds-import-steps .ds-tab')[4]?.click()`);
        await sleep(1500);
        dv.reviewTitle = await panelTitle();
        const td = Date.now();
        dv.tdClick = await click('#ri-testdrive', null);
        await until(`!document.querySelector('.ds-import-filerow') && document.querySelectorAll('canvas').length > 0 && !document.querySelector('.game-loading')`, 600000);
        dv.toDriveS = +((Date.now() - td) / 1000).toFixed(1);
        await sleep(7000);
        const ctl = `(() => { for (const c of document.querySelectorAll('canvas')) { let f = c[Object.keys(c).find((k) => k.startsWith('__reactFiber$'))]; for (let i = 0; f && i < 60; i++, f = f.return) { let h = f.memoizedState; for (let j = 0; h && j < 80; j++, h = h.next) { const v = h.memoizedState; if (v && v.current && typeof v.current.getHud === 'function') return v.current; } } } return null; })()`;
        const pose = () => js(`(() => { const c = ${ctl}; if (!c) return null; const r = c.world.robots[0]; return { x: +r.pos.x.toFixed(2), y: +r.pos.y.toFixed(2), h: +(r.heading * 180 / Math.PI).toFixed(1), vx: +r.vel.x.toFixed(1), vy: +r.vel.y.toFixed(1), imported: !!r.spec.imported, hullN: r.spec.imported?.hull?.length ?? 0, view: c.world.view ?? null }; })()`);
        dv.assets = await js(`(async () => { const ia = await import('/src/render/importedAssets.ts'); let slots = []; try { const m = await import('/src/games/biobuzz/scene/renderImported.ts'); slots = m.importedMeshSlots(); } catch (e) { slots = ['ERR ' + e]; } return { sizes: ia.importedAssetCacheSizes(), slots, canvases: document.querySelectorAll('canvas').length, view3d: !!document.querySelector('canvas[data-engine], .scene3d canvas') }; })()`);
        dv.pose0 = await pose();
        dv.shot0 = await shot(`${p}-drive-${view}-start`);
        for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: 800, y: 600, button: 'left', clickCount: 1 });
        win.webContents.focus();
        await sleep(600);
        // W held: whichever way it moves, compare that with the heading
        await js(`window.__lt.length = 0; window.__t4 = performance.now(); window.__ft = []`);
        // the 3D scene's import motion nodes (`importedMotionNodes`): each wheel's running angle, before W
        // and while it is held (a wheel row that turns changes its angle; Low's effects turn none)
        const spins = () => js(`(() => { const c = ${ctl}; const R = c && c.scene && c.scene.robots; if (!R || !R.group) return null; const nodes = []; R.group.traverse((o) => { const m = o.userData && o.userData.importMotion; if (m) for (const n of m) nodes.push({ role: n.info.role, corner: n.info.corner ?? null, angle: +n.angle.toFixed(3) }); }); return { wheelSpin: R.wheelSpin, nodes }; })()`);
        if (view === '3d') dv.spin0 = await spins();
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W' });
        await sleep(400);
        dv.poseW = await pose();
        if (view === '3d') dv.spinW = await spins();
        await sleep(500);
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W' });
        await sleep(800);
        dv.pose1 = await pose();
        dv.shot1 = await shot(`${p}-drive-${view}-afterW`);
        if (dv.pose0 && dv.pose1) {
          const dx = dv.pose1.x - dv.pose0.x, dy = dv.pose1.y - dv.pose0.y;
          const hr = dv.pose0.h * Math.PI / 180;
          dv.motion = { dist: +Math.hypot(dx, dy).toFixed(2), alongHeading: +(dx * Math.cos(hr) + dy * Math.sin(hr)).toFixed(2), sideways: +(-dx * Math.sin(hr) + dy * Math.cos(hr)).toFixed(2), dirDeg: +(Math.atan2(dy, dx) * 180 / Math.PI).toFixed(1) };
        }
        // a few seconds of driving for frame times
        const pattern = [['S', 900], ['E', 500], ['A', 700], ['W', 900], ['Q', 500], ['D', 700]];
        const end = Date.now() + 6000;
        for (let i = 0; Date.now() < end; i++) { const [k, ms] = pattern[i % pattern.length]; win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k }); await sleep(ms); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k }); }
        // a page that navigated or reloaded meanwhile has no frame list (null): no frame times, not a crash
        const ft = ((await js(`JSON.stringify(window.__ft)`).then(JSON.parse)) || []).map((f) => f.d).sort((a, b) => a - b);
        await js(`window.__ft = null`);
        dv.frames = ft.length ? { n: ft.length, medianMs: +ft[ft.length >> 1].toFixed(2), p95Ms: +ft[Math.floor(ft.length * 0.95)].toFixed(2), maxMs: +ft[ft.length - 1].toFixed(2) } : null;
        Object.assign(dv, await longTasks('window.__t4'));
        dv.shot2 = await shot(`${p}-drive-${view}-moved`);
        Object.assign(dv, stopPeaks());
        dv.consoleErrors = results.console.filter((l) => /^(error|3):/.test(l)).length;
        log(JSON.stringify(dv));
        dump();
      }
    }
  }

  // `--phases up --ups +z,-y --details Light`: read once, then each Up axis in turn: what the Model step says
  // and the four views, then the steps to Review (is the guess the editor made the right one?)
  if (PHASES.includes('up')) {
    await freshDevice();
    const r = await dropFile(DETAILS[0]);
    log('up: read', JSON.stringify({ ok: r.ok, s: r.toModelS }));
    const ups = argOf('ups', '+z').split(',');
    results.up = [];
    for (const u of ups) {
      const v = await js(`(() => { const s = document.querySelector('#ri-up select'); if (!s) return 'no select'; const o = [...s.options].find((x) => x.value === ${JSON.stringify(u)}); if (!o) return 'no option: ' + [...s.options].map((x) => x.value).join(','); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, o.value); s.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
      await sleep(1500);
      await until(`!/Measuring/.test(document.querySelector('.ds-import-body .ds-panel-title')?.textContent ?? '') && ${saveReady}`, 300000);
      await sleep(2500);
      const row = { up: u, set: v, model: await modelFacts(), cams: await cams(`up${u.replace(/[^a-z0-9]/gi, '')}`) };
      row.steps = await walkSteps(`up${u.replace(/[^a-z0-9]/gi, '')}`);
      row.review = await js(`[...document.querySelectorAll('.ds-import-checks li')].map((l) => l.className + ': ' + l.textContent.replace(/\\s+/g, ' ').trim())`);
      row.motion = await js(`[...document.querySelectorAll('.ds-import-body .ds-motion-row, .ds-import-body [class*=motion] li')].map((x) => x.textContent.replace(/\\s+/g, ' ').trim()).slice(0, 30)`);
      await js(`document.querySelectorAll('.ds-import-steps .ds-tab')[0]?.click()`);
      await sleep(800);
      results.up.push(row);
      log('up', JSON.stringify({ up: u, set: v, facts: row.model.facts, front: row.model.front, review: row.review }));
      dump();
    }
  }

  // `--phases detail --details Light,Full`: read at the first Detail, Review, then the second Detail from the
  // Model step; what Review, the facts and Moving parts say after the re-read, and after Find moving parts;
  // then Save (if it can), re-open, Duplicate, Delete
  if (PHASES.includes('detail')) {
    await freshDevice();
    const step = (i) => js(`document.querySelectorAll('.ds-import-steps .ds-tab')[${i}]?.click()`);
    const settled = `!/^(Reading|Preparing|Measuring|Looking)/.test(document.querySelector('.ds-import-body .ds-panel-title')?.textContent ?? 'Reading') && !document.querySelector('.rec-track')`;
    const snap = async (label) => {
      await step(3); await sleep(1500);
      await until(settled, 300000);
      const moving = (await bodyText('.ds-import-body')).replace(/\n+/g, ' | ').slice(0, 900);
      const sMove = await shot(`detail-${label}-moving`);
      await step(4); await sleep(1500);
      await until(settled, 300000);
      await sleep(1500);
      const o = { label, title: await panelTitle(), review: await js(`[...document.querySelectorAll('.ds-import-checks li')].map((l) => l.className + ': ' + l.textContent.replace(/\\s+/g, ' ').trim())`), moving, shots: [sMove, await shot(`detail-${label}-review`)] };
      await step(0); await sleep(1000);
      o.facts = (await modelFacts()).facts;
      o.modelShot = await shot(`detail-${label}-model`);
      log('detail', JSON.stringify(o));
      (results.detailFlow ??= []).push(o);
      dump();
      return o;
    };
    const r = await dropFile(DETAILS[0]);
    log('detail: first read', JSON.stringify({ ok: r.ok, s: r.toModelS }));
    await snap(`read-${DETAILS[0]}`);
    const t = Date.now();
    log('detail: click', await click('#ri-detail .ds-opt', DETAILS[1]));
    await sleep(1000);
    await until(settled, 1800000);
    await sleep(3000);
    log('detail: re-read took', (Date.now() - t) / 1000);
    await snap(`reread-${DETAILS[1]}`);
    await step(3); await sleep(1000);
    log('detail: find moving parts', await click('.ds-import-body .ds-btn', 'Find moving parts', true));
    await sleep(2000);
    await until(settled, 300000);
    await snap(`refind-${DETAILS[1]}`);
    // Save, then the library actions
    const can = await until(saveReady, 30000);
    const s5 = { canSave: can };
    if (can) {
      const before = new Set((await lib('robots')).map((x) => x.id));
      await click('#ri-save-head', null);
      await until(`!location.pathname.includes('/import')`, 300000);
      await sleep(1500);
      const mine = (await lib('robots')).find((x) => !before.has(x.id));
      s5.saved = !!mine;
      if (mine) {
        const tr = Date.now();
        await win.loadURL(`${BASE}/${GAME}/configure/robot/import/${mine.id}`);
        s5.reopened = await until(`${modelReady}`, 600000);
        s5.reopenS = +((Date.now() - tr) / 1000).toFixed(1);
        await sleep(2000);
        s5.reopenFacts = (await modelFacts()).facts;
        await js(`document.querySelector('.ds-back')?.click()`);
        await until(`location.pathname.endsWith('/configure/robot')`, 15000);
        await sleep(2000);
        s5.dup = await click('.ds-panel .ds-btn', 'Duplicate', true);
        await sleep(5000);
        const recs = await lib('robots');
        s5.afterDup = recs.length;
        const dupe = recs.find((x) => x.id !== mine.id);
        if (dupe) {
          s5.dupName = dupe.name;
          s5.dupMeshSame = (await fileOf(`${dupe.id}:mesh`)) === (await fileOf(`${mine.id}:mesh`));
        }
        s5.dupShot = await shot('detail-duplicated');
        s5.del = await click('.ds-panel .ds-btn', 'Delete', true);
        await until(`!!document.querySelector('.ds-modal')`, 8000);
        s5.delDialog = await js(`document.querySelector('.ds-modal')?.innerText.replace(/\\s+/g, ' ') ?? null`);
        await js(`[...document.querySelectorAll('.ds-modal .ds-btn')].find((x) => x.textContent.trim() === 'Delete')?.click()`);
        await sleep(2500);
        const left = await lib('robots');
        s5.afterDel = left.map((x) => x.name);
        s5.filesLeft = await js(`new Promise((res) => { const q = indexedDB.open('decodesim.robots'); q.onsuccess = () => { const r = q.result.transaction('files', 'readonly').objectStore('files').getAllKeys(); r.onsuccess = () => res(r.result.map(String)); r.onerror = () => res([]); }; })`);
        s5.delShot = await shot('detail-deleted');
      }
    }
    results.libraryFlow = s5;
    log('library', JSON.stringify(s5));
    dump();
  }

  if (PHASES.includes('stress')) {
    const st = (name, o) => { results.stress.push({ name, ...o }); log(name, JSON.stringify(o)); dump(); };
    // S1 Back in the middle of the read
    {
      await win.loadURL(`${BASE}/${GAME}/configure/robot/import`);
      await until(`document.querySelector('${DROP}')`, 30000);
      await sleep(600);
      await click('.ds-import-before .ds-opt', 'Full');
      const m0 = memNow();
      startPeaks();
      await setInputFile(DROP, FILE);
      await sleep(500);
      if (await js(`!!document.getElementById('ri-start')`)) await click('#ri-start', null);
      // wait until the read is well under way (a progress bar and a third of the way, or 25 s)
      await until(`document.querySelector('.rec-track')`, 60000);
      await sleep(Number(argOf('backAfterMs', '25000')));
      const mid = { label: await js(`document.querySelector('.ds-import-drop .od')?.textContent ?? null`), workers: await workersAlive(), mem: memNow() };
      const tb = Date.now();
      await js(`document.querySelector('.ds-back')?.click()`);
      await until(`location.pathname.endsWith('/configure/robot')`, 15000);
      const backS = (Date.now() - tb) / 1000;
      await sleep(2500);
      const alive2 = await workersAlive();
      await sleep(5000);
      await js(`window.gc && window.gc()`);
      await sleep(3000);
      const m1 = memNow();
      const peaksBack = stopPeaks();
      const cards = await js(`[...document.querySelectorAll('.ds-opt-add, .ds-robot-card')].map((c) => c.textContent.trim().slice(0, 60))`);
      const s1 = await shot('stress-back-midread');
      st('S1 Back mid-read (Full)', { mid, backS, workersAlive2_5s: alive2, workersAlive8s: await workersAlive(), memBefore: m0, memAfter10s: m1, ...peaksBack, cards, resumeCard: cards.some((c) => /Resume import/.test(c)), shot: s1 });
    }
    // S2 a robot read, an edit, then Replace with the same file at Light (another robot when --file2 is given)
    {
      const r = await dropFile('Light');
      if (r.ok) {
        // an edit: Track width + 0.5
        await js(`(() => { const f = [...document.querySelectorAll('#ri-wheels .ds-field')].find((x) => /Track width/.test(x.textContent)); const i = f?.querySelector('input'); if (!i) return; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, String(Number(i.value) + 0.5)); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
        await sleep(1200);
        const other = argOf('file2', FILE);
        const t0 = Date.now();
        const okSet = await setInputFile('.ds-import-filerow input[type=file]', other);
        await sleep(800);
        const staged = { start: await js(`!!document.getElementById('ri-start')`), keep: await js(`!!document.getElementById('ri-keep')`), text: (await bodyText('.ds-import-body')).slice(0, 400) };
        const s2a = await shot('stress-replace-staged');
        if (staged.start) await click('#ri-start', null);
        const done = await until(`${modelReady} && ${saveReady}`, 1800000);
        st('S2 Replace mid-edit', { okSet, staged, done, s: +((Date.now() - t0) / 1000).toFixed(1), after: await modelFacts(), shots: [s2a, await shot('stress-replace-done')] });
        // S3 Detail changed on Review (Light → Full), from the Model step's Detail with Review open first
        await js(`document.querySelectorAll('.ds-import-steps .ds-tab')[4]?.click()`);
        await sleep(1500);
        const rv0 = await js(`[...document.querySelectorAll('.ds-import-checks li')].map((l) => l.textContent.replace(/\\s+/g, ' ').trim())`);
        await js(`document.querySelectorAll('.ds-import-steps .ds-tab')[0]?.click()`);
        await sleep(800);
        startPeaks();
        const t3 = Date.now();
        const c3 = await click('#ri-detail .ds-opt', 'Full');
        await sleep(300);
        await js(`document.querySelectorAll('.ds-import-steps .ds-tab')[4]?.click()`);
        await sleep(500);
        const during = { title: await panelTitle(), foot: await js(`[...document.querySelectorAll('.ds-import-foot .ds-btn')].map((b) => b.textContent.trim() + (b.disabled ? ' (disabled: ' + b.title + ')' : ''))`) };
        const done3 = await until(`!/^Reading|Preparing|Measuring/.test(document.querySelector('.ds-import-body .ds-panel-title')?.textContent ?? 'Reading') && ${saveReady}`, 1800000);
        await sleep(1500);
        st('S3 Detail Light→Full with Review open', { click: c3, during, done: done3, s: +((Date.now() - t3) / 1000).toFixed(1), ...stopPeaks(), tab: await js(`[...document.querySelectorAll('.ds-import-steps .ds-tab')].findIndex((t) => t.classList.contains('on'))`), reviewBefore: rv0, reviewAfter: await js(`[...document.querySelectorAll('.ds-import-checks li')].map((l) => l.textContent.replace(/\\s+/g, ' ').trim())`), shot: await shot('stress-detail-reread') });
        // S4 a reload mid-edit, then Resume
        await js(`document.querySelectorAll('.ds-import-steps .ds-tab')[0]?.click()`);
        await sleep(600);
        await js(`(() => { const f = [...document.querySelectorAll('#ri-wheels .ds-field')].find((x) => /Wheelbase/.test(x.textContent)); const i = f?.querySelector('input'); if (!i) return; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, String(Number(i.value) - 0.5)); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
        await sleep(1200);
        const wb0 = await js(`[...document.querySelectorAll('#ri-wheels .ds-field')].find((x) => /Wheelbase/.test(x.textContent))?.querySelector('input')?.value ?? null`);
        startPeaks();
        const t4 = Date.now();
        await win.loadURL(`${BASE}/${GAME}/configure/robot`);
        await until(`[...document.querySelectorAll('.ds-opt-add')].some((c) => /Resume import/.test(c.textContent))`, 20000);
        const card = await js(`[...document.querySelectorAll('.ds-opt-add')].map((c) => c.textContent.trim().slice(0, 80))`);
        await js(`[...document.querySelectorAll('.ds-opt-add')].find((c) => /Resume import/.test(c.textContent))?.click()`);
        const back4 = await until(`${modelReady}`, 900000);
        await sleep(2000);
        const wb1 = await js(`[...document.querySelectorAll('#ri-wheels .ds-field')].find((x) => /Wheelbase/.test(x.textContent))?.querySelector('input')?.value ?? null`);
        st('S4 reload mid-edit, Resume', { card, restored: back4, s: +((Date.now() - t4) / 1000).toFixed(1), ...stopPeaks(), wheelbaseBefore: wb0, wheelbaseAfter: wb1, detail: (await modelFacts()).detail, title: await panelTitle(), shot: await shot('stress-resumed') });
        // S5 save, re-open, duplicate, export, delete
        await until(saveReady, 300000);
        const before = new Set((await lib('robots')).map((x) => x.id));
        await click('#ri-save-head', null);
        await until(`!location.pathname.includes('/import')`, 900000);
        await sleep(1500);
        const recs = await lib('robots');
        const mine = recs.find((x) => !before.has(x.id));
        const s5 = { saved: !!mine, records: recs.length };
        if (mine) {
          const tr = Date.now();
          await win.loadURL(`${BASE}/${GAME}/configure/robot/import/${mine.id}`);
          s5.reopened = await until(`${modelReady}`, 900000);
          s5.reopenS = +((Date.now() - tr) / 1000).toFixed(1);
          s5.reopenFacts = await modelFacts();
          await js(`document.querySelector('.ds-back')?.click()`);
          await until(`location.pathname.endsWith('/configure/robot')`, 15000);
          await sleep(1500);
          s5.dup = await click('.ds-panel .ds-btn', 'Duplicate', true);
          await sleep(4000);
          const recs2 = await lib('robots');
          s5.afterDup = recs2.length;
          const dupe = recs2.find((x) => !before.has(x.id) && x.id !== mine.id);
          if (dupe) s5.dupMeshSame = (await fileOf(`${dupe.id}:mesh`)) === (await fileOf(`${mine.id}:mesh`));
          s5.dupShot = await shot('stress-duplicated');
          s5.del = await click('.ds-panel .ds-btn', 'Delete', true);
          await until(`!!document.querySelector('.ds-modal')`, 8000);
          s5.delDialog = await js(`document.querySelector('.ds-modal')?.innerText.replace(/\\s+/g, ' ') ?? null`);
          await js(`[...document.querySelectorAll('.ds-modal .ds-btn')].find((x) => x.textContent.trim() === 'Delete')?.click()`);
          await sleep(2500);
          s5.afterDel = (await lib('robots')).length;
          s5.filesLeft = await js(`new Promise((res) => { const q = indexedDB.open('decodesim.robots'); q.onsuccess = () => { const r = q.result.transaction('files', 'readonly').objectStore('files').getAllKeys(); r.onsuccess = () => res(r.result.map(String)); r.onerror = () => res([]); }; })`);
          s5.delShot = await shot('stress-deleted');
        }
        st('S5 save, reopen, duplicate, delete', s5);
      } else st('S2 skipped: Light read failed', r);
    }
  }
  dump();
  log('\nDONE');
  app.exit(0);
});
