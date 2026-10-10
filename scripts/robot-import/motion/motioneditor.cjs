/* MOVING PARTS IN THE REAL EDITOR. Offscreen Electron (show: false, offscreen) against a production
 * build:
 *
 *   VITE_ROBOT_IMPORT=1 npm run build && npx vite preview --port 4175 --strictPort   # the importer
 *                                     # ships on alpha only; the variable opens it in a local build
 *   env -u ELECTRON_RUN_AS_NODE npx electron scripts/robot-import/motion/motioneditor.cjs --cfg cfg.json
 *     cfg.json: { "files": "tag=path,...", "out": DIR, "port": 4175, "game": "biobuzz,decode,...",
 *                 "playOnly": false }   (paths in a file: Git Bash mangles several on a command line)
 *
 * Per file, a fresh window with its own profile: drop it, Next to Mechanisms, wait for the moving parts
 * the editor finds, dump the draft (setup, placements, spec: `motionprobe.ts --cfg` reads it), a
 * picture of the preview with each group picked (its bodies tinted), and Play frames from the side, the
 * front and 3/4 (`framediff.mjs` paints what moved between two).
 */
const { app, BrowserWindow, session } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// arguments from argv, or from a JSON file (--cfg x.json: { files, out, port, game })
const cfgAt = process.argv.indexOf('--cfg');
const CFG = cfgAt >= 0 ? JSON.parse(fs.readFileSync(process.argv[cfgAt + 1], 'utf8')) : {};
const argOf = (name, fallback) => {
  if (CFG[name] !== undefined) return String(CFG[name]);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = `http://localhost:${argOf('port', '4175')}`;
const FILES = argOf('files', '')
  .split(',')
  .filter(Boolean)
  .map((kv) => {
    const [tag, ...rest] = kv.split('=');
    return { tag, file: rest.join('=') };
  });
const OUT = path.resolve(argOf('out', 'scratch/motioneditor'));
const GAMES = argOf('game', 'decode').split(',');
fs.mkdirSync(OUT, { recursive: true });

app.setPath('userData', path.join(OUT, 'userdata'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => {
  console.log('WATCHDOG');
  process.exit(2);
}, 2 * 3600000);

function serve() {
  return new Promise((resolve) => {
    const byName = new Map(FILES.map((f) => [path.basename(f.file), f.file]));
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
  for (let fi = 0; fi < FILES.length; fi++) {
    const { tag, file } = FILES[fi];
    const GAME = GAMES[Math.min(fi, GAMES.length - 1)];
    const name = path.basename(file);
    const win = new BrowserWindow({ width: 1440, height: 900, show: false, useContentSize: true, webPreferences: { backgroundThrottling: false, offscreen: true } });
    win.webContents.setAudioMuted(true);
    const logs = [];
    win.webContents.on('console-message', (e) => {
      const m = e.message ?? '';
      if (/error|warn/i.test(m)) logs.push(m.slice(0, 300));
    });
    const js = (s) => win.webContents.executeJavaScript(s);
    const until = (cond, ms = 30000) => js(`(async () => { const t0 = performance.now(); while (!(${cond})) { if (performance.now() - t0 > ${ms}) return false; await new Promise((r) => setTimeout(r, 50)); } return true; })()`);
    const shot = async (what, whole = false) => {
      await sleep(400);
      const r = whole ? null : await js(`(() => { const e = document.querySelector('.ds-import-preview-stage'); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }; })()`);
      await win.webContents.capturePage();
      const img = r ? await win.webContents.capturePage(r) : await win.webContents.capturePage();
      const p = path.join(OUT, `${tag}-${what}.png`);
      fs.writeFileSync(p, img.toPNG());
      return p;
    };
    const click = (sel, text) => js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => ${text ? `x.textContent.trim().startsWith(${JSON.stringify(text)})` : 'true'}); if (!b) return false; b.click(); return true; })()`);
    const row = { tag, file: name, game: GAME };
    try {
      await win.loadURL(BASE + '/');
      await session.defaultSession.clearCache();
      await js(`localStorage.clear(); new Promise((r) => { const q = indexedDB.deleteDatabase('decodesim.robots'); q.onsuccess = q.onerror = q.onblocked = () => r(1); })`);
      await win.loadURL(`${BASE}/${GAME}/configure/robot/import`);
      await until(`document.querySelector('.ds-import-drop input[type=file]')`);
      await sleep(800);
      await js(`(async () => { const r = await fetch('http://127.0.0.1:${port}/${encodeURIComponent(name)}'); window.__file = new File([await r.blob()], ${JSON.stringify(name)}); return 1; })()`);
      const t0 = Date.now();
      await js(`(() => { const input = document.querySelector('.ds-import-drop input[type=file]'); const dt = new DataTransfer(); dt.items.add(window.__file); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
      await until(`(document.querySelector('.ds-import-filerow') && document.querySelector('.ds-import-canvas-host canvas')) || document.querySelector('.ds-import-drop .od.err') || document.querySelector('.ds-import-drop [role=alert]')`, 3600000);
      row.importS = +((Date.now() - t0) / 1000).toFixed(1);
      await sleep(2500);
      row.facts = await js(`[...document.querySelectorAll('.ds-facts dt')].map((d) => d.textContent.trim() + ': ' + d.nextElementSibling.textContent.trim())`);
      console.log(`\n${tag}: imported in ${row.importS} s; ${row.facts.join(' | ')}`);
      for (const s of ['Next: Drivetrain', 'Next: Mechanisms', 'Next: Moving parts']) {
        await click('button', s);
        await sleep(800);
      }
      await until(`document.querySelectorAll('.ds-import-moving li').length > 0`, 20000);
      await sleep(1500);
      row.groups = await js(`[...document.querySelectorAll('.ds-import-moving li')].map((l) => l.querySelector('.what')?.textContent.replace(/\\s+/g, ' ').trim())`);
      row.build = await js(`[...document.querySelectorAll('.ds-hint')].map((h) => h.textContent).find((t) => t.startsWith('Set from the model')) ?? ''`);
      console.log(`  editor found: ${row.groups.join(' | ')}`);
      console.log(`  ${row.build}`);
      // the draft, as persisted (800 ms after the last edit)
      await sleep(1500);
      row.draft = await js(`new Promise((res) => {
        const q = indexedDB.open('decodesim.robots');
        q.onsuccess = () => {
          const db = q.result;
          if (!db.objectStoreNames.contains('drafts')) return res(null);
          const g = db.transaction('drafts', 'readonly').objectStore('drafts').get(${JSON.stringify(GAME + ':new')});
          g.onsuccess = () => { const d = g.result; res(d ? JSON.parse(JSON.stringify({ setup: d.setup, mech: d.mech, spec: d.spec, detected: d.detected, game: d.game })) : null); };
          g.onerror = () => res(null);
        };
        q.onerror = () => res(null);
      })`);
      if (row.draft) fs.writeFileSync(path.join(OUT, `${tag}-draft.json`), JSON.stringify(row.draft, null, 1));
      await click('.ds-import-preview-tools button', '3/4');
      await shot('mech-page', true);
      await shot('mech-iso');
      // each group picked: its bodies tinted, from the side and 3/4
      const n = CFG.playOnly ? 0 : row.groups.length;
      for (let i = 0; i < n; i++) {
        const ok = await js(`(() => { const li = document.querySelectorAll('.ds-import-moving li')[${i}]; const b = li && li.querySelector('.ds-import-moving-row'); if (!b) return false; b.click(); return true; })()`);
        if (!ok) continue;
        await sleep(500);
        await click('.ds-import-preview-tools button', 'Side');
        await shot(`g${i}-side`);
        await click('.ds-import-preview-tools button', '3/4');
        await shot(`g${i}-iso`);
        await js(`(() => { const li = document.querySelectorAll('.ds-import-moving li')[${i}]; const b = li && [...li.querySelectorAll('.ds-import-moving-edit button')].find((x) => x.textContent.trim() === 'Done'); if (b) b.click(); return !!b; })()`);
        await sleep(300);
      }
      // Play: frames from the side and the front
      if (await click('.ds-import-turns button', 'Play')) {
        for (const view of ['Side', 'Front', '3/4']) {
          await click('.ds-import-preview-tools button', view);
          await sleep(600);
          for (let k = 0; k < 3; k++) {
            await shot(`play-${view === '3/4' ? 'iso' : view.toLowerCase()}-${k}`);
            await sleep(170);
          }
        }
        await click('.ds-import-turns button', 'Stop');
      }
    } catch (e) {
      row.failure = String(e && e.message ? e.message : e);
      console.log(`  ${row.failure}`);
    } finally {
      row.logs = logs.slice(-10);
      results.push(row);
      fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
      win.destroy();
      await sleep(2000);
    }
  }
  srv.close();
  app.exit(0);
});
