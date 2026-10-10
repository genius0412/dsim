/* Layout-shift auditor. Drives the built app in Electron and, for every interactive
 * element, forces :hover / :hover:active and toggles the `on`/`primary` state classes,
 * asserting that NOTHING outside that element's own subtree moves.
 *
 *   VITE_ROBOT_IMPORT=1 npm run build && npx vite preview --port 4173   # in another shell
 *   npm run shiftaudit                                 # both themes
 *   DSIM_THEME=dark npm run shiftaudit                 # one theme
 *
 * `VITE_ROBOT_IMPORT=1` opens the robot importer in a local build (`importerEnabled`,
 * src/seasonVisibility.ts: it ships on the alpha channel only). Without it the importer's route
 * and the seeded pass are not in the build, and the run says so at the start and in its summary
 * rather than auditing the robot page twice under the importer's name.
 *
 * Why it exists: the design system builds depth from HARD OFFSET SHADOWS and "thick"
 * keycap edges (`--ds-edge`, `--ds-block`). Those are easy to implement with a border
 * or margin that appears on hover, which reflows the page under the cursor. Every
 * pressable surface must instead move via `transform` + `box-shadow`, which don't
 * participate in layout. This catches the regression.
 *
 * It lived in a session scratchpad for two sessions and was twice presumed deleted.
 * It is a repo script now.
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = process.env.DSIM_PORT || '4173';
const BASE = `http://localhost:${PORT}`;
// `system` is resolved in JS, so the audit forces an explicit theme (see src/theme.ts).
const THEMES = process.env.DSIM_THEME ? [process.env.DSIM_THEME] : ['light', 'dark'];
const OUT = process.env.DSIM_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'shiftaudit-'));
const LOG = path.join(OUT, 'shiftaudit.log');
fs.writeFileSync(LOG, '');
// QUIET BY DEFAULT. The full page-by-page trace always goes to the LOG FILE; the console
// only gets the things you actually need to see — shifts and the final summary. DSIM_VERBOSE=1
// puts the trace back on stdout.
const VERBOSE = process.env.DSIM_VERBOSE === '1';
const log = (...a) => {
  const line = a.join(' ');
  fs.appendFileSync(LOG, line + '\n');
  if (VERBOSE) console.log(line);
};
/** always reaches the console, verbose or not (findings + the summary) */
const say = (...a) => {
  const line = a.join(' ');
  fs.appendFileSync(LOG, line + '\n');
  console.log(line);
};

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { log('WATCHDOG'); process.exit(2); }, 600000);
process.on('unhandledRejection', (e) => { log('UNHANDLED REJECTION:', (e && e.stack) || e); process.exit(3); });
process.on('uncaughtException', (e) => { log('UNCAUGHT:', (e && e.stack) || e); process.exit(3); });

const ALL_PAGES = ['/', '/modes', '/configure/robot', '/configure/match', '/configure/controls',
               '/configure/audio', '/configure/network', '/records', '/records/career', '/account', '/download',
               // The routes roadmap rounds 1-2 added. They were NOT in this list when they
               // shipped, which is the failure mode the list has: a page nobody adds here is a
               // page this audit silently reports zero shifts for. `/privacy` earns its place
               // twice over — the Your-data panel is the densest run of pressables in the app.
               '/privacy', '/terms', '/contributors',
               // the robot importer (its empty state: the drop card, the step rail, the head)
               '/configure/robot/import'];
// DSIM_PAGES=/configure/robot,/records narrows a run to the routes you actually touched.
const PAGES = process.env.DSIM_PAGES
  ? process.env.DSIM_PAGES.split(',').map((p) => p.trim()).filter(Boolean)
  : ALL_PAGES;
// WITH AN IMPORTED ROBOT. The importer above is audited empty; a user who has imported a robot
// sees other surfaces: the robot page with its Imported robot panel and library card, and the
// editor reopened by Edit, on each of its four steps. The run makes one the way a user does
// (the STL fixture through the drop card's file input, straight to Review, Save) and audits
// those. Off with DSIM_SEED=0; a DSIM_PAGES run includes it only when the list names `seeded`.
const SEED = process.env.DSIM_SEED !== '0' && (!process.env.DSIM_PAGES || PAGES.includes('seeded'));
const STL = path.join(__dirname, 'fixtures', 'robot-import', 'robot.stl');
// PAGE selectors — the controls that differ from route to route.
const SELECTORS = [
  '.ds-btn', '.ds-cta', '.ds-tile', '.ds-opt', '.ds-opt-add', '.ds-opt-del',
  '.ds-key', '.ds-seg', '.ds-tab', '.ds-menu-btn',
  '.ds-subnav-btn', '.ds-chip', '.ds-select', '.ds-input', 'input[type=range]',
];
// SHELL chrome — the rail, wordmark and footer are the SAME markup on all ten routes, so
// probing them per page was nine redundant passes. Probed once per theme instead.
// (`.ds-rail-home` is gone: the wordmark IS the home link now, and `.ds-mark` probes it)
const CHROME = ['.ds-rail-btn', '.ds-mark', '.ds-foot-link'];
const TOGGLE_CLASSES = [
  ['.ds-seg', 'on'], ['.ds-tab', 'on'], ['.ds-opt', 'on'], ['.ds-rail-btn', 'on'],
  ['.ds-subnav-btn', 'on'], ['.ds-key', 'on'], ['.ds-key', 'selected'],
  ['.ds-tile', 'primary'], ['.ds-btn', 'primary'], ['.ds-menu-btn', 'primary'],
  // the two held states the keycap/card block added: a key waiting for input, a button mid-request
  ['.ds-opt', 'capturing'], ['.ds-btn', 'busy'],
];
// Regions whose CONTENT arrives from the server while the audit runs — the top bar's live
// queue/player counts. Their text width changes on its own schedule, and because the bar is
// right-aligned that nudges its siblings; the blame then lands on whichever element happened
// to be probed at that instant, which is why the reported culprit was different every run.
// It IS a reflow, but not a state-driven one, and this audit exists to police the latter:
// "does hovering/activating a control move anything outside itself".
// `.ds-qcount` is listed on its own as well as via the bar: the same counter also rides the
// left rail (`.ds-qcount.rail`), where its own width changes as the number ticks.
const LIVE = ['.ds-bar-right', '.ds-qcount'];
const FREEZE = `(() => { if (!document.getElementById('__freeze')) {
  const s = document.createElement('style'); s.id='__freeze';
  s.textContent = '*,*::before,*::after{transition:none !important;animation:none !important}';
  document.head.appendChild(s);} return true; })()`;
const MAX_PER = 3;
const EPS = 0.5;
// settle after applying/clearing a forced state. Transitions are already frozen (FREEZE), so
// this only needs to outlast a paint — it was 60ms per read, i.e. ~2 min of pure sleeping
// across a full run.
const SETTLE = 25;

/**
 * ONE eval returns the rects AND the skip set, measured at the same instant.
 *
 * They used to be separate: subtree indices were computed ONCE per page and reused across
 * every probe. When the app re-rendered mid-run (version poll, stats, presence) the node
 * count changed, every index shifted, and the probed element fell out of its own skip set —
 * so it reported its own 1px hover `translate()` as a shift somewhere else. That is why the
 * same build audited 88, then 43, then 0. Resolving the skip against the very array being
 * diffed makes that impossible; a re-render between BASE and CUR is still caught by the
 * length guard in `diff`.
 *
 * `sel`/`i` name the element being probed; LIVE regions are folded in here too.
 */
const MEASURE = (sel, i) => `(() => {
  const all=[...document.querySelectorAll('*')];
  const o=new Array(all.length*4);
  let sc=0;
  for (let k=0;k<all.length;k++){const r=all[k].getBoundingClientRect();
    o[k*4]=r.x;o[k*4+1]=r.y;o[k*4+2]=r.width;o[k*4+3]=r.height;sc+=all[k].scrollTop+all[k].scrollLeft;}
  o.push(document.documentElement.scrollHeight, sc);
  const idx=new Map(all.map((e,n)=>[e,n]));
  const sub=(t)=> t ? [idx.get(t), ...[...t.querySelectorAll('*')].map(d=>idx.get(d))] : [];
  const skip=sub(document.querySelectorAll(${JSON.stringify(sel)})[${i}]);
  for (const el of document.querySelectorAll(${JSON.stringify(LIVE.join(','))})) skip.push(...sub(el));
  return {rects:o, skip};
})()`;
const TAGS = `[...document.querySelectorAll('*')].map(e=>e.tagName.toLowerCase()+
  (typeof e.className==='string'&&e.className.trim()?'.'+e.className.trim().split(/\\s+/).slice(0,2).join('.'):''))`;

function diff(base, cur, skip, tags) {
  const out = [];
  // The DOM CHANGED SHAPE between the two reads — a live re-render (version poll, stats
  // fetch, a flyout) added or removed nodes while we measured. Every index past that point
  // now names a DIFFERENT element in the two arrays, so rect-vs-rect comparison is garbage:
  // it used to read the LAST SHARED INDEX as the scrollHeight sentinel and report phantom
  // "document height 0 -> 815" lines on pages the change never touched. Nothing about a
  // pseudo-state can add nodes, so this is never a real shift — skip the sample.
  if (base.length !== cur.length) return out;
  // SOMETHING SCROLLED between the two reads (a focus move, a late layout that anchored the
  // scroll): every rect below the scroller moved by the same amount, which is a scroll and not a
  // state-driven reflow. One run on a fresh session saw the page drift 700px across a step this way
  // and blamed each probe in turn. Skip the sample; the same pseudo-state cannot scroll.
  if (Math.abs(base[base.length - 1] - cur[cur.length - 1]) > EPS) return out;
  const n = base.length - 2; // the scrollHeight sentinel MEASURE appends (the scroll sum is last)
  if (Math.abs(base[n] - cur[n]) > EPS) out.push(`document height ${base[n]} -> ${cur[n]}`);
  for (let i = 0; i * 4 < n && out.length < 5; i++) {
    if (skip.has(i)) continue;
    for (let k = 0; k < 4; k++) {
      const a = base[i * 4 + k], b = cur[i * 4 + k];
      if (Math.abs(a - b) > EPS) {
        out.push(`${tags[i]}  ${'xywh'[k]}: ${a.toFixed(1)} -> ${b.toFixed(1)}`);
        break;
      }
    }
  }
  return out;
}

app.whenReady().then(async () => {
  log('boot · themes: ' + THEMES.join(', ') + ' · log: ' + LOG);
  // NEVER STEAL FOCUS. The audit ran with a visible, focused window, so every run yanked
  // the desktop away for a minute-plus. It is hidden now: layout and getBoundingClientRect
  // work fine offscreen, and the two switches this file already sets are exactly what keeps
  // an unfocused/hidden window painting normally — `backgroundThrottling: false` and the
  // CalculateNativeWinOcclusion disable at the top. `showInactive()` (not `show()`) is the
  // fallback when debugging: it maps the window WITHOUT raising or focusing it.
  // DSIM_SHOW=1 to watch a run.
  const visible = process.env.DSIM_SHOW === '1';
  // an IN-MEMORY session (a partition without `persist:`): the seeded import, its IndexedDB
  // library and the settings it writes are gone when the run ends, and every run starts clean
  const win = new BrowserWindow({ width: 1400, height: 900, show: false,
    webPreferences: { backgroundThrottling: false, offscreen: true, partition: 'shiftaudit' } });
  const surface = () => { if (visible) win.showInactive(); };
  // MUTE. The run clicks into Free Drive to reach the in-game HUD, which starts the match
  // audio — countdown, announcer, the lot. Nothing about layout needs sound.
  win.webContents.setAudioMuted(true);
  // Load a real document BEFORE attaching: on a blank target, DOM.enable never
  // resolves and the whole run silently hangs until the watchdog.
  await win.loadURL(BASE + '/');
  await sleep(1200);
  surface();
  const dbg = win.webContents.debugger;
  try { dbg.attach('1.3'); log('debugger attached'); }
  catch (e) { log('ATTACH FAILED:', e.message); process.exit(3); }

  // every CDP call gets a deadline, so a hang is reported not swallowed
  const cmd = (method, params) => Promise.race([
    dbg.sendCommand(method, params),
    new Promise((_, rej) => setTimeout(() => rej(new Error('CDP timeout: ' + method)), 10000)),
  ]);
  await cmd('DOM.enable');
  await cmd('CSS.enable');
  log('CDP ready');
  const js = (s) => win.webContents.executeJavaScript(s);

  let checked = 0, problems = 0;

  const probePseudo = async (sel, nodeIds, tags) => {
    for (let i = 0; i < Math.min(nodeIds.length, MAX_PER); i++) {
      const M = MEASURE(sel, i);
      for (const pseudo of [['hover'], ['hover', 'active']]) {
        const base = await js(M);
        // A RE-RENDER CAN RETIRE THE NODE between `DOM.getDocument` and here (a library or a
        // settings read answering after the first paint): CDP then says "Could not find node
        // with given id". That element is gone, not shifting; skip it rather than end the run.
        try {
          await cmd('CSS.forcePseudoState', { nodeId: nodeIds[i], forcedPseudoClasses: pseudo });
        } catch (e) {
          log(`  (${sel}[${i}] left the DOM before it was probed: ${e.message})`);
          return;
        }
        await sleep(SETTLE);
        const cur = await js(M);
        await cmd('CSS.forcePseudoState', { nodeId: nodeIds[i], forcedPseudoClasses: [] }).catch(() => {});
        // SETTLE AFTER CLEARING. Pressable surfaces hover via `transform: translate(-1px,-1px)`
        // — correct, since transforms don't reflow — but getBoundingClientRect() REPORTS the
        // transform. Without this wait, the cleared transform is still applied when the NEXT
        // element's baseline is read, and its 1px snap-back gets blamed on that element.
        // (Cost me a false positive on `.ds-subnav-btn` that was really `.ds-opt`.)
        await sleep(SETTLE);
        checked++;
        const d = diff(base.rects, cur.rects, new Set(cur.skip), tags);
        if (d.length) {
          problems++;
          say(`  SHIFT ${sel}[${i}] :${pseudo.join(':')}`);
          d.forEach((x) => say(`          ${x}`));
        }
      }
    }
  };

  /** every probe, on whatever the window shows now (a route, or a state reached by clicking) */
  const auditHere = async (label, withChrome) => {
      surface();
      // A FRESH SESSION HAS NO FONT CACHE: a face that arrives mid-probe re-measures every label in
      // it, and the first probe after it is blamed (the top bar's season name, 72 -> 108 px)
      await js(`document.fonts.ready.then(() => true)`);
      await js(FREEZE);          // transitions would bleed into the next probe
      await sleep(120);
      log(`\n##### ${label}`);
      const tags = await js(TAGS);
      const { root } = await cmd('DOM.getDocument', { depth: -1 });

      for (const sel of withChrome ? [...SELECTORS, ...CHROME] : SELECTORS) {
        let nodeIds = [];
        try {
          nodeIds = (await cmd('DOM.querySelectorAll',
            { nodeId: root.nodeId, selector: sel })).nodeIds || [];
        } catch { continue; }
        if (!nodeIds.length) continue;
        await probePseudo(sel, nodeIds, tags);
      }

      for (const [sel, cls] of TOGGLE_CLASSES) {
        const n = await js(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
        if (!n) continue;
        for (let i = 0; i < Math.min(n, MAX_PER); i++) {
          const M = MEASURE(sel, i);
          const base = await js(M);
          // (null: a re-render removed the element between the count and the toggle; skip it)
          const had = await js(`(()=>{const e=document.querySelectorAll(${JSON.stringify(sel)})[${i}]; if (!e) return null;
            const h=e.classList.contains(${JSON.stringify(cls)});e.classList.toggle(${JSON.stringify(cls)});return h;})()`);
          if (had === null) continue;
          await sleep(SETTLE);
          const cur = await js(M);
          await js(`document.querySelectorAll(${JSON.stringify(sel)})[${i}]?.classList.toggle(${JSON.stringify(cls)}); true`);
          await sleep(SETTLE); // settle before the next baseline — see probePseudo
          checked++;
          const d = diff(base.rects, cur.rects, new Set(cur.skip), tags);
          if (d.length) {
            problems++;
            say(`  SHIFT ${sel}[${i}] .${cls} ${had ? 'removed' : 'added'}`);
            d.forEach((x) => say(`          ${x}`));
          }
        }
      }
  };

  const until = (expr, ms = 15000) => js(`(async () => { for (let t = 0; t < ${ms}; t += 100) { try { if (${expr}) return true; } catch {} await new Promise((r) => setTimeout(r, 100)); } return false; })()`);
  const IMPORTED_PANEL = `[...document.querySelectorAll('.ds-panel-title')].some((h) => h.textContent.trim() === 'Imported robot')`;
  /** make the imported robot: the fixture through the drop card, straight to Review, Save */
  const seedImport = async () => {
    const b64 = fs.readFileSync(STL).toString('base64');
    await win.loadURL(BASE + '/decode/configure/robot/import');
    await sleep(1500);
    const got = await js(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const bin = atob(${JSON.stringify(b64)});
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const input = document.querySelector('.ds-import-drop input[type=file]');
      if (!input) return 'no drop card';
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'robot.stl'));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      for (let i = 0; i < 100 && !document.querySelector('.ds-import-filerow'); i++) await wait(200);
      if (!document.querySelector('.ds-import-filerow')) return 'the file was not read';
      document.querySelectorAll('.ds-import-steps .ds-tab')[3]?.click();
      await wait(600);
      let save = null;
      for (let i = 0; i < 100; i++) {
        save = document.querySelector('.ds-import-foot .ds-btn.primary');
        if (save && !save.disabled) break;
        await wait(200);
      }
      if (!save || save.disabled) return 'Save stayed disabled';
      save.click();
      return 'saving';
    })()`);
    const ok = got === 'saving' && (await until(`location.pathname.endsWith('/configure/robot') && ${IMPORTED_PANEL}`));
    log(`seed import: ${got}${ok ? ', saved' : ''}`);
    // the save's writes (the library record, the synced settings) finish after the page has moved
    // on; a reload straight away raced them and came back without the import
    if (ok) await sleep(1500);
    if (!ok) say(`  (could not seed an imported robot: ${got === 'saving' ? 'Save did not land on the robot page' : got}; those surfaces were NOT audited)`);
    return ok;
  };
  let seeded = null;

  // IS THE IMPORTER IN THIS BUILD? It ships on the alpha channel only (`importerEnabled`); a local
  // build has it with VITE_ROBOT_IMPORT=1. Where it is closed its route falls through to the robot
  // page and the address bar is rewritten to it, so the run would audit /configure/robot a second
  // time under the importer's name and the seeded pass could not make a robot. Said, not skipped quietly.
  const IMPORT_PAGE = '/configure/robot/import';
  let importerOpen = true;
  if (PAGES.includes(IMPORT_PAGE) || SEED) {
    await win.loadURL(BASE + '/decode' + IMPORT_PAGE);
    importerOpen = await until(`location.pathname.endsWith(${JSON.stringify(IMPORT_PAGE)}) && !!document.querySelector('.ds-import-drop')`, 10000);
    if (!importerOpen) {
      say(`  IMPORTER NOT IN THIS BUILD: ${IMPORT_PAGE} and the seeded import pass are NOT audited (build with VITE_ROBOT_IMPORT=1 to audit them)`);
    }
  }

  for (const theme of THEMES) {
    // stamped by the blocking inline script in index.html, so it must precede the load
    await js(`localStorage.setItem('decodesim.theme', ${JSON.stringify(theme)}); 'ok'`);
    log(`\n############################ THEME: ${theme.toUpperCase()}`);

    let chromeDone = false;
    for (const page of PAGES) {
      if (page === 'seeded') continue;
      if (page === IMPORT_PAGE && !importerOpen) continue;
      await win.loadURL(BASE + page);
      await sleep(1400);
      await auditHere(`[${theme}] ${page}`, !chromeDone);
      chromeDone = true;
    }

    // ---- with an imported robot: the robot page, then the editor (Edit) on each step ----
    if (SEED && importerOpen) {
      if (seeded === null) seeded = await seedImport();
      if (seeded) {
        await win.loadURL(BASE + '/decode/configure/robot');
        await sleep(1400);
        if (await until(IMPORTED_PANEL, 12000)) await auditHere(`[${theme}] /configure/robot (an imported robot)`, false);
        else say(`  (the robot page did not show the imported robot in ${theme})`);
        await win.loadURL(BASE + '/decode/configure/robot');
        // the panel's Edit appears once the library has answered (IndexedDB, after the first paint)
        const EDIT = `[...([...document.querySelectorAll('.ds-panel-title')].find((t) => t.textContent.trim() === 'Imported robot')?.closest('.ds-panel-h')?.querySelectorAll('.ds-btn') ?? [])].find((x) => /^Edit/.test(x.textContent.trim()))`;
        const edit = (await until(`!!${EDIT}`, 8000)) && (await js(`(() => { const b = ${EDIT}; if (!b) return false; b.click(); return true; })()`));
        if (edit && (await until(`location.pathname.includes('/configure/robot/import') && document.querySelectorAll('.ds-import-steps .ds-tab').length === 4`, 8000))) {
          for (let k = 0; k < 4; k++) {
            await js(`document.querySelectorAll('.ds-import-steps .ds-tab')[${k}].click(); true`);
            await sleep(700);
            await auditHere(`[${theme}] importer, editing the imported robot, step ${k + 1}`, false);
          }
        } else say(`  (could not open the imported robot in the editor in ${theme})`);
      }
    }

    // ---- in-game HUD: the one surface not reachable by URL ----
    // Post-Phase-5 the console screens are plain <button>s, so match on TEXT rather than
    // the old `.ds-menu-btn` / `.ds-tile` classes, and click one per eval (React batches).
    await win.loadURL(BASE + '/');
    await sleep(1500);
    const clickText = async (txt) => js(`(() => {
      const b = [...document.querySelectorAll('button,a')]
        .find(e => e.textContent.replace(/\\s+/g,' ').includes(${JSON.stringify(txt)}));
      if (!b) return 'MISS';
      b.click(); return 'ok';
    })()`);
    if (await clickText('Play') === 'MISS') log('  (could not reach Play)');
    await sleep(900);
    if (await clickText('Free drive') === 'MISS') log('  (could not reach Free drive)');
    await sleep(3500);
    await js(FREEZE);
    await sleep(150);
    const inGame = await js(`!!document.querySelector('.game-canvas')`);
    log(`\n##### [${theme}] in-game HUD (free drive) canvas=${inGame}`);
    if (inGame) {
      const tags = await js(TAGS);
      const { root } = await cmd('DOM.getDocument', { depth: -1 });
      for (const sel of ['.game-btn', '.chip', '.hopper-pip', '.power-gauge']) {
        let nodeIds = [];
        try { nodeIds = (await cmd('DOM.querySelectorAll', { nodeId: root.nodeId, selector: sel })).nodeIds || []; }
        catch { continue; }
        if (!nodeIds.length) { log(`  (no ${sel})`); continue; }
        await probePseudo(sel, nodeIds, tags);
      }
    }
  }

  await js(`localStorage.removeItem('decodesim.theme'); 'ok'`);
  say(`===== ${checked} state changes checked · ${problems} caused layout shift${importerOpen ? '' : ' · the importer NOT audited (not in this build)'} =====`);
  dbg.detach();
  process.exit(problems === 0 ? 0 : 1);
});
app.on('window-all-closed', () => process.exit(0));
