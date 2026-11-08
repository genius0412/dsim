/* Layout-shift auditor. Drives the built app in Electron and, for every interactive
 * element, forces :hover / :hover:active and toggles the `on`/`primary` state classes,
 * asserting that NOTHING outside that element's own subtree moves.
 *
 *   VITE_ROBOT_IMPORT=1 npm run build && npx vite preview --port 4173   # in another shell
 *   npm run shiftaudit                                 # both themes
 *   DSIM_THEME=dark npm run shiftaudit                 # one theme
 *   DSIM_NAV=only npm run shiftaudit                   # just the cross-route nav comparison (~1 min)
 *   DSIM_SCROLL=only npm run shiftaudit                # just the scroll-on-navigation pass (~2 min)
 *   DSIM_ROOM=only npm run shiftaudit                  # just the one-screen room (needs a game server, below)
 *
 * THE ONE-SCREEN ROOM (docs/rooms-redesign.md, 2026-11-04). A room is reached through a game server,
 * so its pass is opt-in: build with `VITE_GAME_SERVER_URL` pointing at a running server (the admin
 * harness, or `npm run server:start`) and set `DSIM_ROOM=1` (with the rest) or `DSIM_ROOM=only`;
 * `DSIM_ROOM_WS` is that server's socket (default ws://localhost:8787). The window creates a Private
 * room and fake members join it over plain sockets from this process. Every probe below runs on the
 * room empty and full, and the room's own transitions are checked as states: a watcher joining and
 * leaving, READY toggled, the Setup drawer opened, and the crown passing to this window. None of them
 * may move a seat card, a side's header or a button in the bar. At 1366x768 and 390x844, both themes.
 *
 * WHERE A NAVIGATION LANDS (2026-11-04, owner: "Clicking one of the settings menus (like 'Network')
 * while I am on a different tab (like 'Graphics') while being scrolled down, it does not bring me to
 * the top of the page"). `SCROLL_CASES`: from a route scrolled down, a REAL click (input events, not
 * `el.click()`) on a section, a tab, a bar button or a footer link must land the new page at its top
 * (or at its anchor, just under the bar), move focus into the new page, and Back must put the old page
 * back where it was. `SCROLL_STAY`: a control that only changes what a list shows must not move the
 * page. Every shell page is padded to 3000px first (`DSIM_SCROLL_PAD=0` to not), so a short
 * destination cannot clamp a leftover offset to 0 and pass by luck. See `src/ui/pageScroll.ts`.
 * DSIM_SCROLL=0 skips it.
 *
 * THE BAR'S SECTIONS ACROSS ROUTES (2026-11-04). Besides the per-state probes, every theme opens
 * `NAV_PAGES` at three window sizes and asserts that Play, Configure and Records sit at the same
 * x/y/width/height on all of them. A state probe cannot see this class of shift: nothing on the
 * page changes state, the ROUTE does. It caught the always-on scroll track that every shell
 * screen keeps but Play, which moved all three sections 15px between Play and the rest.
 * DSIM_NAV=0 skips it.
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
// muted from the start, not only per window: the HUD pass starts a match and its audio
app.commandLine.appendSwitch('mute-audio');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { log('WATCHDOG'); process.exit(2); }, 600000);
process.on('unhandledRejection', (e) => { log('UNHANDLED REJECTION:', (e && e.stack) || e); process.exit(3); });
process.on('uncaughtException', (e) => { log('UNCAUGHT:', (e && e.stack) || e); process.exit(3); });

const ALL_PAGES = ['/', '/modes', '/configure/robot', '/configure/controls',
               '/configure/audio', '/configure/network', '/records', '/records/career', '/records/achievements', '/account', '/download',
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
// (the STEP fixture through the drop card's file input, straight to Review, Save) and audits
// those. Off with DSIM_SEED=0; a DSIM_PAGES run includes it only when the list names `seeded`.
const SEED = process.env.DSIM_SEED !== '0' && (!process.env.DSIM_PAGES || PAGES.includes('seeded'));
// THE CROSS-ROUTE NAV COMPARISON (see the header). One route of each kind the bar is drawn over:
// Play on the stage (no scroll track), two of its popups, a long and a short page of Configure and
// of Records, and two footer pages. Home is not here: its sections are hidden, not placed. Records is
// every tab and a board with a query (2026-11-04, the redesign): the old hub address, each tab, and a
// Duo board with its filters, which is the tallest page the bar sits over.
const NAV = process.env.DSIM_NAV || 'on'; // 'on' | 'only' | '0'
const NAV_PAGES = ['/modes', '/rooms', '/ranked', '/configure/robot', '/configure/audio', '/records',
  '/records/leaderboard', '/records/leaderboard?board=duo&cat=auto&dt=tank', '/records/leaderboard?board=2v2',
  '/records/career', '/records/achievements', '/download', '/privacy'];
const NAV_SIZES = [[1920, 1080], [1366, 768], [390, 844]];
const NAV_MEASURE = `(() => [...document.querySelectorAll('.ds-bar-nav-btn')].map((b) => {
  const r = b.getBoundingClientRect();
  return { t: b.textContent.trim(), shown: getComputedStyle(b).visibility !== 'hidden', r: [r.x, r.y, r.width, r.height] };
}))()`;
// THE SCROLL PASS (see the header). Each case: the page it starts on, scrolled down; the control a
// player clicks (by selector and its accessible name or the start of its text); the address it must
// reach (game prefix dropped); and, for a deep link, the anchor it must land at. DECODE where the
// game does not matter (a 2D page is lighter on this PC); BIOBUZZ for Graphics, which only a game with
// a 3D view has.
const SCROLL = process.env.DSIM_SCROLL || 'on'; // 'on' | 'only' | '0'
const SCROLL_PAD = process.env.DSIM_SCROLL_PAD !== '0';
const SCROLL_SIZES = [[1366, 768], [390, 844]];
const ROOM = process.env.DSIM_ROOM || '0'; // '1' | 'only' | '0'
const ROOM_WS = process.env.DSIM_ROOM_WS || 'ws://localhost:8787';
const ROOM_SIZES = [[1366, 768], [390, 844]];
/** what a room transition must not move: every seat card, each side's header, the bar's buttons */
const ROOM_FIXED = '.rm-seat, .rm-side-h, .rm-bar, .rm-cta, .rm-head';
const SCROLL_CASES = [
  // the bar's sections and the mark
  { from: '/decode/configure/controls', sel: '.ds-bar-nav-btn', name: 'Records', to: '/records/leaderboard' },
  { from: '/decode/records/career', sel: '.ds-bar-nav-btn', name: 'Configure', to: '/configure/robot' },
  { from: '/decode/account', sel: '.ds-bar-nav-btn', name: 'Play', to: '/modes' },
  { from: '/decode/download', sel: '.ds-mark', name: 'DSIM home', to: '' },
  // Configure's sections, round the ring; Graphics -> Network is the owner's report
  { from: '/biobuzz/configure/graphics', sel: '.ds-subnav-btn', name: 'Network', to: '/configure/network' },
  { from: '/biobuzz/configure/audio', sel: '.ds-subnav-btn', name: 'Graphics', to: '/configure/graphics' },
  { from: '/decode/configure/robot', sel: '.ds-subnav-btn', name: 'Controls', to: '/configure/controls' },
  { from: '/decode/configure/controls', sel: '.ds-subnav-btn', name: 'Audio and visual', to: '/configure/audio' },
  { from: '/decode/configure/audio', sel: '.ds-subnav-btn', name: 'Network', to: '/configure/network' },
  { from: '/decode/configure/network', sel: '.ds-subnav-btn', name: 'Robot', to: '/configure/robot' },
  // Records' three tabs
  { from: '/decode/records/leaderboard', sel: '.rb-tabs .ds-tab', name: 'My records', to: '/records/career' },
  { from: '/decode/records/career', sel: '.rb-tabs .ds-tab', name: 'Achievements', to: '/records/achievements' },
  { from: '/decode/records/achievements', sel: '.rb-tabs .ds-tab', name: 'Leaderboards', to: '/records/leaderboard' },
  // the Profile destination's two pages
  { from: '/decode/account', sel: '.ds-tabs .ds-tab', name: 'Appearance', to: '/account/appearance' },
  { from: '/decode/account/appearance', sel: '.ds-tabs .ds-tab', name: 'Account', to: '/account' },
  // the footer
  { from: '/decode/configure/controls', sel: '.ds-foot-link', name: 'Download', to: '/download' },
  { from: '/decode/records/achievements', sel: '.ds-foot-link', name: 'Privacy', to: '/privacy' },
  // an ANCHOR: the footer's Data link opens Privacy at Your data (a local build has no consent dialog)
  { from: '/decode/download', sel: '.ds-foot-link', name: 'Data', to: '/privacy', anchor: 'your-data' },
];
// IN PLACE: what a list shows changes, the page stays where it is
const SCROLL_STAY = [
  { at: '/decode/records/leaderboard', sel: '.rb-boards .ds-seg', name: 'Duo' },
  { at: '/decode/configure/audio', sel: '.ds-subnav-body .ds-opt:not(.on)', name: '' },
];
// a DEEP LINK to an anchor, loaded cold
const SCROLL_DEEP = [{ url: '/decode/privacy#your-data', anchor: 'your-data' }];
// the importer takes STEP CAD (or a zip of it) and a DSIM share file, nothing else
const STEP_FIXTURE = path.join(__dirname, 'fixtures', 'robot-import', 'robot.step');
// PAGE selectors — the controls that differ from route to route.
const SELECTORS = [
  '.ds-btn', '.ds-cta', '.ds-tile', '.ds-opt', '.ds-opt-add', '.ds-opt-del',
  '.ds-key', '.ds-seg', '.ds-tab', '.ds-menu-btn',
  '.ds-subnav-btn', '.ds-chip', '.ds-select', '.ds-input', 'input[type=range]',
];
// SHELL chrome — the rail, wordmark and footer are the SAME markup on all ten routes, so
// probing them per page was nine redundant passes. Probed once per theme instead.
// (`.ds-rail-home` is gone: the wordmark IS the home link now, and `.ds-mark` probes it)
// `.ds-bar-nav-btn`: the bar's sections (2026-11-01), the same markup on every route but Home
const CHROME = ['.ds-rail-btn', '.ds-bar-nav-btn', '.ds-mark', '.ds-foot-link'];
const TOGGLE_CLASSES = [
  ['.ds-seg', 'on'], ['.ds-tab', 'on'], ['.ds-opt', 'on'], ['.ds-rail-btn', 'on'], ['.ds-bar-nav-btn', 'on'],
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
    const b64 = fs.readFileSync(STEP_FIXTURE).toString('base64');
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
      dt.items.add(new File([bytes], 'robot.step'));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      // a STEP read loads the occt reader (7.6 MB of wasm) first
      for (let i = 0; i < 300 && !document.querySelector('.ds-import-filerow'); i++) await wait(200);
      if (!document.querySelector('.ds-import-filerow')) return 'the file was not read';
      { const tabs = document.querySelectorAll('.ds-import-steps .ds-tab'); tabs[tabs.length - 1]?.click(); }
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
  const navOnly = NAV === 'only';
  const scrollOnly = SCROLL === 'only';
  // an `only` pass (either, or both) runs just that: no importer check, no per-state probes
  const onlyPasses = navOnly || scrollOnly;
  const navOn = navOnly || (!scrollOnly && NAV !== '0');
  const scrollOn = scrollOnly || (!navOnly && SCROLL !== '0');
  if (!onlyPasses && (PAGES.includes(IMPORT_PAGE) || SEED)) {
    await win.loadURL(BASE + '/decode' + IMPORT_PAGE);
    importerOpen = await until(`location.pathname.endsWith(${JSON.stringify(IMPORT_PAGE)}) && !!document.querySelector('.ds-import-drop')`, 10000);
    if (!importerOpen) {
      say(`  IMPORTER NOT IN THIS BUILD: ${IMPORT_PAGE} and the seeded import pass are NOT audited (build with VITE_ROBOT_IMPORT=1 to audit them)`);
    }
  }

  /**
   * THE SECTIONS MUST NOT MOVE BETWEEN ROUTES. Each size: open every NAV_PAGES route, read the three
   * buttons, and compare each route with the first one that shows them. A button that is there but
   * hidden (Home's stage) is skipped, not compared; one that is missing where the first route had it
   * is a finding, because a section that comes and goes is the same shift.
   */
  let navChecked = 0;
  const navAcrossRoutes = async (theme) => {
    for (const [w, h] of NAV_SIZES) {
      win.setContentSize(w, h);
      await sleep(200);
      let ref = null;
      for (const page of NAV_PAGES) {
        await win.loadURL(BASE + page);
        await js(`document.fonts.ready.then(() => true)`);
        await until(`document.querySelectorAll('.ds-bar-nav-btn').length > 0`, 8000);
        await sleep(400);
        const got = (await js(NAV_MEASURE)).filter((b) => b.shown);
        log(`  nav [${theme} ${w}x${h}] ${page}: ${got.map((b) => `${b.t}@${b.r.map((v) => v.toFixed(1)).join(',')}`).join(' | ') || 'none shown'}`);
        if (!ref) {
          if (got.length) ref = { page, got };
          else say(`  NAV [${theme} ${w}x${h}] ${page}: no section shown`);
          continue;
        }
        navChecked++;
        const moved = [];
        for (const want of ref.got) {
          const b = got.find((x) => x.t === want.t);
          if (!b) { moved.push(`${want.t} missing`); continue; }
          const k = [0, 1, 2, 3].find((i) => Math.abs(b.r[i] - want.r[i]) > EPS);
          if (k !== undefined) moved.push(`${want.t} ${'xywh'[k]}: ${want.r[k].toFixed(1)} -> ${b.r[k].toFixed(1)}`);
        }
        if (got.length !== ref.got.length) moved.push(`${ref.got.length} sections on ${ref.page}, ${got.length} here`);
        if (moved.length) {
          problems++;
          say(`  NAV MOVED [${theme} ${w}x${h}] ${ref.page} -> ${page}`);
          moved.forEach((x) => say(`          ${x}`));
        }
      }
    }
    // back to the size every probe below was measured at
    win.setSize(1400, 900);
    await sleep(200);
  };

  /**
   * WHERE A NAVIGATION LANDS (see the header and `SCROLL_CASES`). Every check is counted in
   * `scrollFailed` and in `problems`; the console gets one line per failure and the total.
   */
  let scrollChecked = 0;
  let scrollFailed = 0;
  const scrollFail = (what) => {
    scrollFailed++;
    problems++;
    say(`  SCROLL ${what}`);
  };
  const strip = (p) => p.replace(/^\/(decode|chain|biobuzz)(?=\/|$)/, '');
  const FIND = (sel, name) => `(() => {
    const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const want = ${JSON.stringify(name)};
    return [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => {
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(e).visibility === 'hidden') return false;
      return !want || norm(e.getAttribute('aria-label')) === want || norm(e.textContent).startsWith(want);
    }) || null;
  })()`;
  // shell pages get a 3000px floor, so no destination is too short to keep a leftover offset
  const PAD = `(() => { if (!document.getElementById('__scrollpad')) { const s = document.createElement('style');
    s.id = '__scrollpad'; s.textContent = '.ds-app:not(.on-stage) .ds-main { min-height: 3000px !important; }';
    document.head.appendChild(s); } return true; })()`;
  /** the page scrolled to its end, then (when the control is not on screen there) up just far enough
   *  that the control sits under the bar; returns the point to click and the offset left behind */
  const AIM = (sel, name) => `(() => {
    const el = ${FIND(sel, name)};
    const app = document.querySelector('.ds-app');
    if (!el || !app) return null;
    app.scrollTop = app.scrollHeight;
    const barB = Math.max(0, document.querySelector('.ds-bar')?.getBoundingClientRect().bottom ?? 0);
    let r = el.getBoundingClientRect();
    if (r.top < barB + 2 || r.bottom > innerHeight - 2) app.scrollTop += r.top - barB - 2;
    r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, hit: !!hit && (hit === el || el.contains(hit)), y0: app.scrollTop };
  })()`;
  /** where the page is now: the shell's offset, any nested scroller in the page still scrolled, the
   *  anchor's place under the bar, and what has focus */
  const LANDED = (anchor) => `(() => {
    const app = document.querySelector('.ds-app');
    const main = document.querySelector('.ds-main');
    const name = (e) => e ? e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/).slice(0, 2).join('.') : '') : 'none';
    const nested = main ? [...main.querySelectorAll('*')].filter((e) => e.scrollTop > 0).map(name) : [];
    const barB = Math.max(0, document.querySelector('.ds-bar')?.getBoundingClientRect().bottom ?? 0);
    const a = ${JSON.stringify(anchor || '')};
    const at = a ? (document.getElementById(a) || document.querySelector('[data-anchor~="' + a + '"]')) : null;
    const ae = document.activeElement;
    const focusOk = !!ae && ae !== document.body && !!main && (main === ae || main.contains(ae))
      && (ae.matches('main, h1, h2, h3, [data-page-focus], [data-anchor]') || (!!a && ae.id === a));
    return { top: app ? app.scrollTop : -1, nested, anchorGap: at ? at.getBoundingClientRect().top - barB : null, focus: name(ae), focusOk };
  })()`;
  const click = async (x, y) => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
  };
  /** open a page, wait for the control, pad it */
  const openAt = async (url, sel, name) => {
    await win.loadURL(BASE + url);
    await js(`document.fonts.ready.then(() => true)`);
    const ok = await until(`!!${FIND(sel, name)}`, 10000);
    if (SCROLL_PAD) await js(PAD);
    await sleep(500);
    return ok;
  };
  const scrollPass = async () => {
    for (const [w, h] of SCROLL_SIZES) {
      win.setContentSize(w, h);
      await sleep(200);
      const at = `${w}x${h}`;
      for (const c of SCROLL_CASES) {
        const label = `[${at}] ${c.from} -> ${c.name}`;
        if (!(await openAt(c.from, c.sel, c.name))) { scrollFail(`${label}: no "${c.name}" to click`); continue; }
        const aim = await js(AIM(c.sel, c.name));
        if (!aim || !aim.hit) { scrollFail(`${label}: "${c.name}" is covered where it would be clicked`); continue; }
        if (aim.y0 < 1) log(`  (scroll ${label}: the page could not be left scrolled before the click)`);
        await click(aim.x, aim.y);
        if (!(await until(`location.pathname.replace(/^\\/(decode|chain|biobuzz)(?=\\/|$)/, '') === ${JSON.stringify(c.to)}`, 6000))) {
          scrollFail(`${label}: the click did not reach ${c.to || '/'}`);
          continue;
        }
        await sleep(700);
        const got = await js(LANDED(c.anchor));
        scrollChecked++;
        log(`  scroll ${label}: left at ${aim.y0.toFixed(0)}, landed ${got.top.toFixed(0)}${c.anchor ? ` (anchor ${got.anchorGap == null ? 'missing' : got.anchorGap.toFixed(0) + 'px under the bar'})` : ''}, focus ${got.focus}`);
        if (c.anchor) {
          if (got.anchorGap == null || got.anchorGap < -1 || got.anchorGap > 48) scrollFail(`${label}: #${c.anchor} is ${got.anchorGap == null ? 'missing' : got.anchorGap.toFixed(0) + 'px from the bar'} (want 0-48 under it)`);
        } else if (got.top > 0.5) scrollFail(`${label}: landed ${got.top.toFixed(0)}px down (left at ${aim.y0.toFixed(0)})`);
        if (got.nested.length) scrollFail(`${label}: still scrolled inside the page: ${got.nested.join(', ')}`);
        if (!got.focusOk) scrollFail(`${label}: focus stayed on ${got.focus}, not the new page`);
        // BACK puts the old page where it was
        win.webContents.navigationHistory.goBack();
        if (!(await until(`location.pathname === ${JSON.stringify(c.from)}`, 6000))) {
          scrollFail(`${label}: Back did not return to ${c.from}`);
          continue;
        }
        await sleep(700);
        const back = await js(LANDED(''));
        scrollChecked++;
        log(`  scroll ${label}: Back to ${back.top.toFixed(0)} (was ${aim.y0.toFixed(0)})`);
        if (Math.abs(back.top - aim.y0) > 2) scrollFail(`${label}: Back restored ${back.top.toFixed(0)}px, the page was left at ${aim.y0.toFixed(0)}`);
      }
      for (const s of SCROLL_STAY) {
        const label = `[${at}] ${s.at}: ${s.sel}${s.name ? ` "${s.name}"` : ''} in place`;
        if (!(await openAt(s.at, s.sel, s.name))) { scrollFail(`${label}: nothing to click`); continue; }
        const aim = await js(AIM(s.sel, s.name));
        if (!aim || !aim.hit) { scrollFail(`${label}: covered where it would be clicked`); continue; }
        const len = await js('history.length');
        await click(aim.x, aim.y);
        await sleep(700);
        const got = await js(LANDED(''));
        scrollChecked++;
        log(`  scroll ${label}: ${aim.y0.toFixed(0)} -> ${got.top.toFixed(0)}`);
        if (Math.abs(got.top - aim.y0) > 1) scrollFail(`${label}: the page moved ${aim.y0.toFixed(0)} -> ${got.top.toFixed(0)}`);
        if ((await js('history.length')) !== len) scrollFail(`${label}: an in-place change added a history entry`);
      }
      for (const d of SCROLL_DEEP) {
        const label = `[${at}] ${d.url} (loaded cold)`;
        await win.loadURL(BASE + d.url);
        await until(`!!document.getElementById(${JSON.stringify(d.anchor)})`, 10000);
        if (SCROLL_PAD) await js(PAD);
        await sleep(1200);
        const got = await js(LANDED(d.anchor));
        scrollChecked++;
        log(`  scroll ${label}: anchor ${got.anchorGap == null ? 'missing' : got.anchorGap.toFixed(0) + 'px under the bar'}`);
        if (got.anchorGap == null || got.anchorGap < -1 || got.anchorGap > 48) scrollFail(`${label}: #${d.anchor} is ${got.anchorGap == null ? 'missing' : got.anchorGap.toFixed(0) + 'px from the bar'} (want 0-48 under it)`);
      }
    }
    win.setSize(1400, 900);
    await sleep(200);
    say(`  scroll pass: ${scrollChecked} landings checked, ${scrollFailed} failed`);
  };

  /**
   * THE ONE-SCREEN ROOM (`DSIM_ROOM`). The probes on the room empty and full, then its transitions,
   * each a before/after of `ROOM_FIXED` (nothing in it may move; a card's own CONTENT may change).
   */
  let roomChecked = 0;
  const roomPass = async (theme) => {
    const WS = require('ws');
    const CAPS = ['recycle', 'autoOnly', 'rooms3', 'strategy', 'startpose', 'game'];
    const socks = [];
    const member = (room, name, alliance, watch = false, config) =>
      new Promise((resolve) => {
        const ws = new WS(ROOM_WS);
        socks.push(ws);
        ws.on('open', () => {
          ws.send(JSON.stringify(watch
            ? { t: 'spectate', room, caps: CAPS, name }
            : { t: 'join', room, caps: CAPS, config: config ?? { kind: 'versus', game: 'decode' },
                player: { name, teamName: '', teamNumber: 0, alliance, startIndex: 0, ready: false } }));
        });
        ws.on('message', (d) => { if (String(d).includes('"t":"welcome"')) resolve(ws); });
        ws.on('error', () => resolve(ws));
        setTimeout(() => resolve(ws), 5000);
      });
    // GEOMETRY BY ROLE: a seat by its side and place, a bar button by what it is. A box's own
    // classes and text may change (a seat filling, READY gaining ✓) and a new button may arrive
    // (START, with the crown); none of the boxes that were there may move or go.
    const RECTS = `(() => { const out = {}; const put = (k, e) => { const r = e.getBoundingClientRect(); out[k] = [r.x, r.y, r.width, r.height].map(Math.round).join(' '); };
      for (const side of document.querySelectorAll('.rm-side')) { const a = side.classList.contains('red') ? 'red' : 'blue';
        put('side-h ' + a, side.querySelector('.rm-side-h')); side.querySelectorAll('.rm-seat').forEach((e, n) => put('seat ' + a + n, e)); }
      for (const b of document.querySelectorAll('.rm-cta')) put(/START/.test(b.textContent) ? 'start' : 'ready', b);
      for (const sel of ['.rm-bar', '.rm-head']) { const e = document.querySelector(sel); if (e) put(sel, e); }
      return out; })()`;
    const same = async (label, act, wait) => {
      const before = await js(RECTS);
      await act();
      if (wait) await until(wait, 6000);
      await sleep(400);
      const after = await js(RECTS);
      roomChecked++;
      const moved = Object.keys(before).filter((k) => after[k] !== before[k]).map((k) => `${k}: ${before[k]}  ->  ${after[k] ?? 'gone'}`);
      if (moved.length) {
        problems++;
        say(`  SHIFT [${theme}] room: ${label}`);
        moved.slice(0, 6).forEach((x) => say(`          ${x}`));
      } else log(`  room ${label}: nothing moved`);
    };
    for (const [w, h] of ROOM_SIZES) {
      win.setContentSize(w, h);
      await win.loadURL(BASE + '/decode/rooms');
      await sleep(1500);
      const made = await js(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Private room'); if (!b) return false; b.click(); return true; })()`);
      if (!made || !(await until(`!!document.querySelector('.rm-bar .rm-cta') && /^[A-Z0-9]{6}$/.test(document.querySelector('.rm-code-v')?.textContent ?? '')`, 10000))) {
        say(`  (could not open a room at ${w}x${h} in ${theme}: is DSIM_ROOM_WS (${ROOM_WS}) the server this build talks to?)`);
        continue;
      }
      const code = (await js(`document.querySelector('.rm-code-v').textContent`)).toLowerCase();
      await auditHere(`[${theme}] ${w}x${h} room, alone`, false);
      await member(code, 'Guest A', 'red');
      await until(`document.querySelectorAll('.rm-seat:not(.open)').length >= 2`, 5000);
      let watcher;
      await same(`${w}x${h} a watcher joins`, async () => { watcher = await member(code, 'Watcher', 'blue', true); }, `document.querySelectorAll('.rm-watcher').length >= 1`);
      await same(`${w}x${h} a watcher leaves`, async () => { watcher.close(1000); }, `document.querySelectorAll('.rm-watcher').length === 0`);
      await same(`${w}x${h} READY toggled`, async () => { await js(`[...document.querySelectorAll('.rm-cta')].find((b) => /READY/.test(b.textContent))?.click(); true`); }, `[...document.querySelectorAll('.rm-cta')].some((b) => /✓ READY/.test(b.textContent))`);
      await same(`${w}x${h} the Setup drawer opens`, async () => { await js(`[...document.querySelectorAll('.rm-seat .ds-btn')].find((b) => b.textContent.trim() === 'Setup')?.click(); true`); }, `!!document.querySelector('.rm-drawer')`);
      await js(`[...document.querySelectorAll('.rm-drawer .ds-btn')].find((b) => b.textContent.trim() === 'Done')?.click(); true`);
      await member(code, 'Guest B', 'blue');
      await member(code, 'Guest C', 'blue');
      await until(`document.querySelectorAll('.rm-seat.open').length === 0`, 5000);
      await auditHere(`[${theme}] ${w}x${h} room, full`, false);
      for (const ws of socks.splice(0)) ws.close(1000);

      // the crown passing to this window: a socket hosts, this window joins, the socket leaves
      const ABC = '23456789BCDFGHJKMNPQRSTVWXYZ'; // the room-code alphabet (`ROOM_CODE_ALPHABET`)
      const code2 = Array.from({ length: 6 }, () => ABC[Math.floor(Math.random() * ABC.length)]).join('').toLowerCase();
      const host = await member(code2, 'Host', 'red', false, { kind: 'versus', game: 'decode', settings: { preset: 'casual-2v2', listed: false } });
      await win.loadURL(BASE + '/decode/rooms');
      await sleep(1200);
      await js(`(() => { const i = document.querySelector('input[aria-label="Room code"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(code2.toUpperCase())}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Join room')?.click(); true`);
      if (!(await until(`!!document.querySelector('.rm-bar .rm-cta')`, 8000))) {
        say(`  (could not join the second room at ${w}x${h} in ${theme})`);
        continue;
      }
      // the narrow bar shares its width between READY and START, so only the wide one is held to it
      if (w >= 760) await same(`${w}x${h} the crown passes to this window`, async () => { host.close(1000); }, `[...document.querySelectorAll('.rm-cta')].some((b) => /START/.test(b.textContent))`);
      for (const ws of socks.splice(0)) ws.close(1000);
    }
    win.setContentSize(1400, 900);
  };

  for (const theme of THEMES) {
    // stamped by the blocking inline script in index.html, so it must precede the load
    await js(`localStorage.setItem('decodesim.theme', ${JSON.stringify(theme)}); 'ok'`);
    log(`\n############################ THEME: ${theme.toUpperCase()}`);

    if (ROOM !== '0') await roomPass(theme);
    if (ROOM === 'only') continue;
    if (navOn) await navAcrossRoutes(theme);
    // where a page lands does not depend on the theme: once, in the first
    if (scrollOn && theme === THEMES[0]) await scrollPass();
    if (onlyPasses) continue;

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
        if (edit && (await until(`location.pathname.includes('/configure/robot/import') && document.querySelectorAll('.ds-import-steps .ds-tab').length >= 4`, 8000))) {
          const steps = await js(`document.querySelectorAll('.ds-import-steps .ds-tab').length`);
          for (let k = 0; k < steps; k++) {
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
    // Free drive is in the Solo list on Play
    if (await clickText('Solo') === 'MISS') log('  (could not reach Solo)');
    await sleep(500);
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
  say(`===== ${checked} state changes checked · ${roomChecked} room transitions · ${navChecked} route pairs compared for the bar's sections · ${scrollChecked} navigation landings checked (${scrollFailed} wrong) · ${problems} problems in all${importerOpen ? '' : ' · the importer NOT audited (not in this build)'} =====`);
  dbg.detach();
  process.exit(problems === 0 ? 0 : 1);
});
app.on('window-all-closed', () => process.exit(0));
