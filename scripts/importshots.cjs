/* THE ROBOT IMPORTER'S SHOT RUNNER (lane 4). Drives the importer end to end in an OFFSCREEN Electron
 * window and photographs every state, at three widths and in both themes, so the pictures are read
 * before anybody else sees the screens.
 *
 *   npx vite --port 5194 --strictPort            # in another shell (a dev server is fine)
 *   env -u ELECTRON_RUN_AS_NODE npx electron scripts/importshots.cjs
 *
 *   --port 5194              the server
 *   --sizes 1440x900,390x844 a subset of the three widths
 *   --theme dark             one theme
 *   --only robot,model       scene-name prefixes
 *   --out scratch/importshots/mine
 *
 * The flow is the real one: files are handed to the editor's own file input (fetched from
 * `scripts/fixtures/robot-import/`), every click is a real click on a real control, and the library
 * is the browser's own IndexedDB, wiped at the start of each run. Never shown: `show: false` and an
 * offscreen render, with the three paint switches `shots.cjs` documents.
 *
 * Output: `scratch/importshots/<short-sha>/<size>.<theme>.<scene>.png` and an index.html sheet.
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const PORT = argOf('port', process.env.DSIM_PORT || '5194');
const BASE = `http://localhost:${PORT}`;
const THEMES = argOf('theme') ? [argOf('theme')] : ['light', 'dark'];
const SIZES = (argOf('sizes', '1440x900,1100x720,390x844'))
  .split(',')
  .map((s) => s.split('x').map(Number));
const ONLY = (argOf('only') || '').split(',').filter(Boolean);

function shortSha() {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src'], { encoding: 'utf8' }).trim();
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return 'nogit';
  }
}
const OUT = path.resolve(argOf('out', path.join('scratch', 'importshots', shortSha())));
fs.mkdirSync(OUT, { recursive: true });

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log('WATCHDOG'); process.exit(2); }, 1500000);
process.on('unhandledRejection', (e) => { console.log('UNHANDLED REJECTION:', (e && e.stack) || e); process.exit(3); });

const FREEZE = `(() => { if (!document.getElementById('__freeze')) {
  const s = document.createElement('style'); s.id='__freeze';
  s.textContent = '*,*::before,*::after{transition:none !important;animation:none !important;caret-color:transparent !important}';
  document.head.appendChild(s);} return true; })()`;

/** in-page helpers, installed after every load */
const HELPERS = `(() => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__until = async (fn, ms = 20000) => { for (let t = 0; t < ms; t += 100) { try { if (fn()) return true; } catch {} await wait(100); } return false; };
  window.__drop = async (names, fake) => {
    const files = [];
    for (const n of names) {
      if (fake) { files.push(new File([new Uint8Array([1, 2, 3])], n)); continue; }
      const b = await (await fetch('/scripts/fixtures/robot-import/' + n)).blob();
      files.push(new File([b], n));
    }
    const input = document.querySelector('.ds-import-drop input[type=file]') || document.querySelector('.ds-import-filerow input[type=file]');
    const dt = new DataTransfer(); files.forEach((f) => dt.items.add(f));
    input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  window.__click = (sel, text) => {
    const all = [...document.querySelectorAll(sel)];
    const el = !text ? all[0] : all.find((e) => e.textContent.trim() === text) || all.find((e) => e.textContent.trim().startsWith(text));
    if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true;
  };
  window.__step = (i) => { const t = document.querySelectorAll('.ds-import-steps .ds-tab')[i]; if (!t) return false; t.click(); return true; };
  window.__setNumber = (sel, v) => {
    const el = document.querySelector(sel); if (!el) return false;
    const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); d.set.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
    el.focus(); el.blur(); return true;
  };
  // the app scrolls in \`.ds-app\` (html and body are overflow: hidden); scroll THAT, and keep the
  // root at 0 — a root scroll is the bug \`.ds-import\`'s position: relative fixed, not a viewport
  const scroller = () => document.querySelector('.ds-app') || document.scrollingElement;
  window.__scroll = (sel) => { const el = document.querySelector(sel); if (!el) return false; const s = scroller(); const hero = document.querySelector('.ds-hero'); const y = el.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop - 100 - (hero && getComputedStyle(hero).position === 'sticky' ? hero.getBoundingClientRect().height : 0); s.scrollTop = Math.max(0, y); window.scrollTo(0, 0); return true; };
  window.__top = () => { window.scrollTo(0, 0); const s = scroller(); if (s) s.scrollTop = 0; document.querySelectorAll('.ds-main, main').forEach((m) => (m.scrollTop = 0)); return true; };
  return true;
})()`;

app.whenReady().then(async () => {
  console.log(`importshots · ${BASE} · ${SIZES.map((s) => s.join('x')).join(', ')} · ${THEMES.join(', ')} · out: ${OUT}`);
  const win = new BrowserWindow({
    width: SIZES[0][0],
    height: SIZES[0][1],
    show: false,
    useContentSize: true,
    webPreferences: { backgroundThrottling: false, offscreen: true },
  });
  win.webContents.setAudioMuted(true);
  const js = (s) => win.webContents.executeJavaScript(s);
  const shots = [];
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2 && !/AdSense|deprecated parameters|DevTools/.test(message)) errors.push(message.slice(0, 300));
  });

  const load = async (route) => {
    await win.loadURL(BASE + route);
    await js(HELPERS);
    await js(FREEZE);
    await sleep(600);
  };
  const snap = async (label, name) => {
    if (ONLY.length && !ONLY.some((p) => name.startsWith(p))) return;
    await js(FREEZE);
    await js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))');
    await sleep(250);
    await win.webContents.capturePage();
    const img = await win.webContents.capturePage();
    const file = `${label}.${name}.png`;
    fs.writeFileSync(path.join(OUT, file), img.toPNG());
    shots.push({ label, name, file });
    console.log(`  ${file}`);
  };

  for (const [w, h] of SIZES) {
    win.setContentSize(w, h);
    for (const theme of THEMES) {
      const label = `${w}x${h}.${theme}`;
      // a clean device: theme set, the robot library and every draft wiped, default settings
      await win.loadURL(BASE + '/');
      await js(`localStorage.clear(); localStorage.setItem('decodesim.theme', ${JSON.stringify(theme)});
        new Promise((r) => { const q = indexedDB.deleteDatabase('decodesim.robots'); q.onsuccess = q.onerror = q.onblocked = () => r(1); })`);

      await load('/decode/configure/robot');
      await js(`__until(() => document.querySelector('.ds-opt-add'))`);
      await js(`__scroll('.ds-opt-add')`);
      await snap(label, 'robot-empty');

      await load('/decode/configure/robot/import');
      await js(`__until(() => document.querySelector('.ds-import-drop'))`);
      await snap(label, 'editor-empty');

      await js(`__drop(['robot.f3d'], true)`);
      await js(`__until(() => document.querySelector('.ds-import-drop .err'))`);
      await js(`__scroll('.ds-import-drop')`);
      await snap(label, 'editor-error');

      // the STL is in millimetres: Units → in makes it oversize for the failing review below
      await js(`__drop(['robot.stl'])`);
      await js(`__until(() => document.querySelector('.ds-import-filerow'))`);
      await sleep(1200);
      await js(`__top()`);
      await snap(label, 'model-loaded');
      await js(`__scroll('#ri-wheels')`);
      await snap(label, 'model-wheels');

      await js(`__step(1)`);
      await sleep(300);
      await js(`__setNumber('#ri-weight', 12)`);
      await sleep(300);
      await js(`__scroll('.ds-import-body')`);
      await snap(label, 'drivetrain-clamped');
      await js(`__scroll('.ds-import-body .ds-stats')`);
      await snap(label, 'drivetrain-readout');
      await js(`__setNumber('#ri-weight', 30)`);

      await js(`__step(2)`);
      await sleep(400);
      await js(`document.getElementById('ri-h-shooter')?.focus()`);
      await js(`__scroll('#ri-placement')`);
      await snap(label, 'mechanisms-decode');

      await js(`__step(0)`);
      await sleep(300);
      await js(`__click('#ri-units .ds-opt', 'in')`);
      await sleep(600);
      await js(`__step(3)`);
      await sleep(400);
      await js(`__scroll('.ds-import-body')`);
      await snap(label, 'review-fail');
      await js(`__step(0)`);
      await sleep(300);
      await js(`__click('#ri-units .ds-opt', 'mm')`);
      await sleep(600);
      await js(`__step(3)`);
      await sleep(400);
      await js(`__scroll('.ds-import-body')`);
      await snap(label, 'review-pass');

      await js(`__click('.ds-head .ds-btn.ghost')`);
      await sleep(300);
      await snap(label, 'dialog-discard');
      await js(`__click('[role=dialog] .ds-btn', 'Cancel')`);
      await sleep(200);

      await js(`__click('.ds-import-foot .ds-btn', 'Test drive')`);
      await js(`__until(() => document.querySelector('.game-btn'), 30000)`);
      await sleep(1500);
      await snap(label, 'test-drive');
      await js(`__click('.game-btn', '◄ EDITOR')`);
      await js(`__until(() => document.querySelector('.ds-import-foot'))`);
      await sleep(1200);

      await js(`__click('.ds-import-foot .ds-btn', 'Save robot')`);
      await js(`__until(() => location.pathname.endsWith('/configure/robot') && document.querySelector('.ds-hero img, .ds-hero svg'))`);
      await sleep(800);
      await js(`__top()`);
      await snap(label, 'robot-imported');
      await js(`__scroll('.ds-opt-add')`);
      await snap(label, 'robot-row');
      await js(`__click('.ds-panel .ds-btn', 'Delete')`);
      await sleep(300);
      await snap(label, 'dialog-delete');
      await js(`__click('[role=dialog] .ds-btn', 'Cancel')`);
      await js(`__click('.ds-panel .ds-btn', 'Rename')`);
      await sleep(300);
      await snap(label, 'dialog-rename');
      await js(`__click('[role=dialog] .ds-btn', 'Cancel')`);

      for (const game of ['biobuzz', 'chain']) {
        await load(`/${game}/configure/robot/import`);
        await js(`__until(() => document.querySelector('.ds-import-drop, .ds-import-filerow'))`);
        await js(`__drop(['robot.stl'])`);
        await js(`__until(() => document.querySelector('.ds-import-filerow'))`);
        await sleep(800);
        await js(`__step(2)`);
        await sleep(500);
        await js(`__scroll('.ds-import-body')`);
        await snap(label, `mechanisms-${game}`);
        await js(`__scroll('#ri-placement')`);
        await snap(label, `placement-${game}`);
      }
    }
  }

  const rows = shots.map((s) => `<figure><img src="${s.file}" loading="lazy"><figcaption>${s.label} · ${s.name}</figcaption></figure>`).join('\n');
  fs.writeFileSync(
    path.join(OUT, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>importshots</title><style>body{font:14px system-ui;background:#222;color:#ddd}figure{display:inline-block;margin:8px;vertical-align:top}img{max-width:480px;border:1px solid #555}</style>${rows}`,
  );
  console.log(`\n${shots.length} shots · ${OUT}`);
  if (errors.length) {
    console.log(`\nconsole errors/warnings (${errors.length}):`);
    for (const e of [...new Set(errors)].slice(0, 30)) console.log('  ' + e);
  }
  app.quit();
});
