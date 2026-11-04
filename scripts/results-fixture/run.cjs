/* THE RESULTS-SCREEN LAYOUT AUDIT, the Electron half. `scripts/resultsaudit.mjs` starts the Vite
 * server and runs this; see that file for why it exists and what each check is for.
 *
 * Offscreen and muted, like every capture in this repo: `show: false` + `offscreen: true`, audio
 * muted on the command line and on the page, one window for the whole run.
 *
 *   --port=N           the fixture's server (required)
 *   --cases=a,b        a subset of CASES
 *   --themes=dark      one theme
 *   --sizes=1366x625   a subset of SIZES (by WxH)
 *   --shots=DIR        also write a PNG per case, theme and size
 *   --verbose          say how long each board took to come up
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const PORT = arg('port', '');
const SHOTS = arg('shots', '');
const VERBOSE = process.argv.includes('--verbose');
const CASES = ['bbVersus', 'bbSolo', 'decodeVersus', 'decodeSolo', 'chainVersus'];
const THEMES = ['light', 'dark'];
/** [width, height, one column?]. ONE is the board's own anatomy — value | label | value across the
 *  centre, each value against its alliance's panel — and every window that can hold it must get it;
 *  1366x625 and 1280x600 are a laptop's browser, where the owner met the two-column flow. The last
 *  two are the phones, which cannot hold it and flow into two columns. */
const SIZES = [
  [1920, 1080, true],
  [1366, 768, true],
  [1366, 625, true],
  [1280, 600, true],
  [1024, 600, true],
  [844, 390, false],
  [390, 844, false],
];
const pick = (all, list, key) => (list ? all.filter((x) => list.split(',').includes(key(x))) : all);
const cases = pick(CASES, arg('cases', ''), (c) => c);
const themes = pick(THEMES, arg('themes', ''), (t) => t);
const sizes = pick(SIZES, arg('sizes', ''), ([w, h]) => `${w}x${h}`);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('mute-audio');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => {
  console.log('resultsaudit: WATCHDOG — gave up after 5 minutes');
  app.exit(2);
}, 300000);

/** in the page: every check, against the board as it is laid out right now. Returns failures. */
const CHECK = (oneColumn, versus) => `(() => {
  const fails = [];
  const fail = (check, detail) => fails.push(check + ': ' + detail);
  const box = (e) => e.getBoundingClientRect();
  const stage = document.querySelector('.resx-stage');
  const table = document.querySelector('.resx-breakdown');
  if (!stage || !table) return ['mount: no results stage or breakdown on the page'];

  // NO SCROLL (docs/area/ui.md, "THE RESULTS SCREEN MUST NOT SCROLL")
  const over = stage.scrollHeight - stage.clientHeight;
  if (over > 1) fail('no-scroll', 'the stage scrolls by ' + over + 'px');

  // THE ALLIANCE FILLS: each half wears its own chip colour, resolved from the token itself
  const probe = document.createElement('i');
  stage.appendChild(probe);
  const token = (t) => { probe.style.color = 'var(' + t + ')'; return getComputedStyle(probe).color; };
  for (const a of ['red', 'blue']) {
    const half = document.querySelector('.resx-half.' + a);
    if (!half) continue;
    const want = token('--ds-' + a + '-chip');
    const got = getComputedStyle(half).backgroundColor;
    if (got !== want) fail('alliance-fill', a + ' half is ' + got + ', not --ds-' + a + '-chip ' + want);
  }
  probe.remove();
  if (${versus} && !(document.querySelector('.resx-half.red') && document.querySelector('.resx-half.blue')))
    fail('alliance-fill', 'a versus board without both halves');

  // SECTIONS: a heading row, then its rows until the next heading
  const sections = [];
  for (const tr of table.querySelectorAll('tr')) {
    if (tr.classList.contains('resx-section')) sections.push({ head: tr, rows: [] });
    else if (sections.length) sections[sections.length - 1].rows.push(tr);
  }
  if (sections.length === 0) fail('sections', 'no section headings');
  for (const s of sections) {
    const title = s.head.textContent.trim();
    const h = box(s.head);
    // A SECTION NEVER BREAKS ACROSS COLUMNS: every row sits in its heading's column, under it
    for (const r of s.rows) {
      const b = box(r);
      if (Math.abs(b.left - h.left) > 1 || b.top < h.bottom - 1)
        fail('section-whole', title + ': row "' + (r.querySelector('.resx-cat') || r).textContent.trim() + '" is not under its heading (row at x ' + Math.round(b.left) + ', heading at x ' + Math.round(h.left) + ')');
    }
    // THE HEADING CENTRES OVER ITS OWN ROWS (it sat flush left when its cell shrink-wrapped)
    if (s.rows.length) {
      const range = document.createRange();
      range.selectNodeContents(s.head.querySelector('th') || s.head);
      const t = range.getBoundingClientRect();
      const left = Math.min(...s.rows.map((r) => box(r).left));
      const right = Math.max(...s.rows.map((r) => box(r).right));
      const off = (t.left + t.right) / 2 - (left + right) / 2;
      if (Math.abs(off) > 2) fail('heading-centred', title + ' is ' + Math.round(off) + 'px off the centre of its rows');
    }
  }

  // ONE COLUMN wherever one fits: every heading at one x
  const xs = [...new Set(sections.map((s) => Math.round(box(s.head).left)))];
  if (${oneColumn} && xs.length > 1) fail('one-column', 'the breakdown flows into ' + xs.length + ' columns on a window that holds one');

  // THE BOARD'S ANATOMY on one column: red value at the table's left edge, against the red panel,
  // blue value at its right edge, against the blue panel, and the label between them
  if (${oneColumn} && ${versus}) {
    const tb = box(table);
    for (const tr of table.querySelectorAll('tr:not(.resx-section)')) {
      const rv = tr.querySelector('.resx-rv'), cat = tr.querySelector('.resx-cat'), bv = tr.querySelector('.resx-bv');
      if (!rv || !cat || !bv) { fail('anatomy', 'a versus row without value | label | value'); break; }
      const label = cat.textContent.trim();
      if (Math.abs(box(rv).left - tb.left) > 1) fail('anatomy', label + ': the red value is not at the red edge');
      if (Math.abs(box(bv).right - tb.right) > 1) fail('anatomy', label + ': the blue value is not at the blue edge');
      if (!(box(rv).right <= box(cat).left + 1 && box(cat).right <= box(bv).left + 1)) fail('anatomy', label + ': value | label | value overlap');
    }
  }
  return fails;
})()`;

app.whenReady().then(async () => {
  if (!PORT) {
    console.log('resultsaudit: --port=N is required (run it through `npm run resultsaudit`)');
    app.exit(2);
    return;
  }
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const win = new BrowserWindow({
    width: 1920,
    height: 1080,
    show: false,
    useContentSize: true,
    enableLargerThanScreen: true,
    webPreferences: { backgroundThrottling: false, offscreen: true, partition: 'resultsaudit' },
  });
  win.webContents.setAudioMuted(true);
  // ⚠️ A DOCUMENT BEFORE ANY EMULATION: `enableDeviceEmulation` on a webContents that has never
  // loaded took the whole process down (exit 127, nothing printed)
  await win.loadURL('about:blank');
  const js = (s) => win.webContents.executeJavaScript(s);
  const size = (w, h) => {
    win.setContentSize(w, h);
    win.webContents.enableDeviceEmulation({
      screenPosition: 'desktop',
      screenSize: { width: w, height: h },
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: 1,
      viewSize: { width: w, height: h },
      scale: 1,
    });
  };
  /** two frames with the same layout, so a counting value or a late font cannot be caught mid-move */
  const settle = async () => {
    let last = '';
    for (let i = 0; i < 20; i++) {
      await sleep(120);
      const now = await js(`[...document.querySelectorAll('.resx-breakdown tr, .resx-half, .resx-secondary')].map((e) => { const b = e.getBoundingClientRect(); return [b.x, b.y, b.width, b.height].map(Math.round).join(','); }).join(';')`);
      if (now === last) return;
      last = now;
    }
  };

  let failures = 0;
  let checked = 0;
  for (const c of cases) {
    const versus = c.endsWith('Versus');
    for (const theme of themes) {
      size(sizes[0][0], sizes[0][1]);
      for (let t = 0; ; t++) {
        try {
          await win.loadURL(`http://localhost:${PORT}/scripts/results-fixture/index.html?case=${c}&theme=${theme}`);
          break;
        } catch (e) {
          if (t >= 3) throw e;
          await sleep(1500);
        }
      }
      // skip the reveal (a stage click is the player's own skip), then let the entrances finish.
      // The first load on a cold server transforms the whole module graph, so it gets a minute.
      const t0 = Date.now();
      while (Date.now() - t0 < 60000 && !(await js(`!!document.querySelector('.resx-stage')`))) await sleep(150);
      await js(`document.querySelector('.resx-stage') && document.querySelector('.resx-stage').click()`);
      for (let i = 0; i < 80 && !(await js(`!!document.querySelector('.resx-secondary')`)); i++) await sleep(100);
      if (!(await js(`!!document.querySelector('.resx-secondary')`))) {
        console.log(`FAIL ${c} ${theme}  mount: the results screen did not reach its actions row in ${Math.round((Date.now() - t0) / 1000)}s`);
        failures++;
        continue;
      }
      if (VERBOSE) console.log(`${c} ${theme}: on screen in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      await js(`Promise.race([
        Promise.all(document.getAnimations().filter((a) => a.effect && a.effect.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => 0))),
        new Promise((r) => setTimeout(r, 3000)),
      ]).then(() => document.fonts.ready).then(() => 1)`);
      for (const [w, h, one] of sizes) {
        size(w, h);
        await settle();
        const fails = await js(CHECK(one, versus));
        checked++;
        for (const f of fails) console.log(`FAIL ${c} ${theme} ${w}x${h}  ${f}`);
        failures += fails.length;
        if (SHOTS) fs.writeFileSync(path.join(SHOTS, `${c}.${theme}.${w}x${h}.png`), (await win.webContents.capturePage()).toPNG());
      }
    }
  }
  console.log(
    failures
      ? `resultsaudit: ${failures} failure(s) across ${checked} boards`
      : `resultsaudit: ${checked} boards (${cases.length} cases x ${themes.length} themes x ${sizes.length} sizes), all pass`,
  );
  win.destroy();
  app.exit(failures ? 1 : 0);
});
