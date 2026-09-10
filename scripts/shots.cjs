/* BIOBUZZ gallery SHOT RUNNER. Drives the built app in Electron, screenshots every cell of
 * `/biobuzz/gallery` in both themes, and writes a contact sheet.
 *
 *   ELECTRON=1 npm run build
 *   npx vite preview --port 4173                      # in another shell
 *   env -u ELECTRON_RUN_AS_NODE npx electron scripts/shots.cjs
 *
 *   --scene pile-slow,corner-pile     only those scenes (id prefix, so `archetype` works too)
 *   --theme dark                      one theme instead of both
 *   --out scratch/shots/mine          override the output directory
 *   --path /biobuzz/gallery           where the gallery is served from
 *   --port 5173                       a dev server instead of `vite preview`
 *   --show                            watch the run in a visible window
 *
 * `--path` exists because the gallery's route is not this script's to know: it is mounted
 * through the module's `devRoutes` slot, which P0-core owns, and it is behind the `alpha`
 * channel. It is also what lets a shot run happen against a scratch mount point before that
 * slot exists — the CELLS come off the page, so anything that renders `BiobuzzGallery` at any
 * URL can be photographed.
 *
 * Output: `scratch/shots/<short-sha>/<cell>.<theme>.png` plus an `index.html` contact sheet.
 * `scratch/` is gitignored, so a run never dirties the tree.
 *
 * ── WHY IT EXISTS ───────────────────────────────────────────────────────────
 * So that CLAUDE SEES ITS OWN OUTPUT BEFORE A HUMAN DOES. Every visual change in this repo has
 * a failure mode that is instant to spot in a picture and nearly impossible to spot in code — a
 * drum drawn on the wrong edge, a turret ring an inch off the launch origin, a sweeper whose
 * rollers miss its own footprint. Claude runs this, reads the PNGs, and fixes what is wrong;
 * the human's review time then goes to judgement ("that does not feel like pollen") rather than
 * to catching mechanical errors.
 *
 * ── WHY ELECTRON AND NOT A HEADLESS BROWSER ────────────────────────────────
 * The same reasons `shiftaudit.cjs` uses it: Electron is already a dependency (the desktop
 * wrapper), it renders the real app with the real GPU-less Skia path, and `capturePage` gives
 * a device-pixel screenshot of an arbitrary rect without a driver protocol. The three switches
 * at the top of this file are what let it paint correctly in a HIDDEN window —
 * `disableHardwareAcceleration`, the `CalculateNativeWinOcclusion` disable, and
 * `backgroundThrottling: false`. Drop any one of them and an unfocused run silently
 * screenshots blank frames.
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const PORT = argOf('port', process.env.DSIM_PORT || '4173');
const BASE = `http://localhost:${PORT}`;
const GALLERY = argOf('path', '/biobuzz/gallery');
// `system` is resolved in JS, so a run forces an explicit theme (see src/theme.ts) — otherwise
// both "themes" would be whatever the host OS happens to be set to.
const THEMES = argOf('theme') ? [argOf('theme')] : ['light', 'dark'];
const ONLY = (argOf('scene') || '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * The output directory is named by the COMMIT, because a shot is evidence about a commit.
 * A `-dirty` suffix when the tree has uncommitted changes, since that is the single most
 * confusing thing about a screenshot: which code it was actually of.
 */
function shortSha() {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return 'nogit';
  }
}
const OUT = path.resolve(argOf('out', path.join('scratch', 'shots', shortSha())));
fs.mkdirSync(OUT, { recursive: true });

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log('WATCHDOG'); process.exit(2); }, 600000);
process.on('unhandledRejection', (e) => { console.log('UNHANDLED REJECTION:', (e && e.stack) || e); process.exit(3); });
process.on('uncaughtException', (e) => { console.log('UNCAUGHT:', (e && e.stack) || e); process.exit(3); });

/** Kill every transition and animation before measuring or capturing. Same stylesheet
 * `shiftaudit.cjs` injects, and for the same reason: a card mid-transition photographs at an
 * intermediate transform, so two runs of identical code produce different PNGs. */
const FREEZE = `(() => { if (!document.getElementById('__freeze')) {
  const s = document.createElement('style'); s.id='__freeze';
  s.textContent = '*,*::before,*::after{transition:none !important;animation:none !important}';
  document.head.appendChild(s);} return true; })()`;

/**
 * Find every gallery cell and name it.
 *
 * THE NAME COMES OUT OF THE PAGE, not out of a list in this file. A cell's `.ot` caption is
 * `<scene>@<tick>` — the exact string `bbSceneCells()` builds, the gallery renders, and a human
 * quotes in a feedback dump. Reading it back means this script cannot drift out of sync with the
 * scene registry: add a scene, get a shot, with no edit here.
 */
const CELLS = `(() => [...document.querySelectorAll('.ds-sec .ds-opt')]
  .map((el, i) => {
    const cap = el.querySelector(':scope > .ot');
    return { i, name: cap ? cap.textContent.trim() : '' };
  })
  .filter((c) => /@\\d+$/.test(c.name)))()`;

/** scroll cell `i` into view and report its rect. Rounded OUTWARD so a fractional rect never
 * clips a border off the capture — a 1px sliver of missing edge reads as a rendering bug. */
const RECT = (i) => `(() => {
  const el = [...document.querySelectorAll('.ds-sec .ds-opt')][${i}];
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  const x = Math.floor(r.x), y = Math.floor(r.y);
  return { x, y, width: Math.ceil(r.right) - x, height: Math.ceil(r.bottom) - y };
})()`;

/** filename-safe, and STABLE: `pile-slow@60` -> `pile-slow@60`. Only the characters Windows
 * actually refuses are replaced, so a filename still reads as the cell id it came from. */
const safe = (name) => name.replace(/[\\/:*?"<>|]/g, '_');

app.whenReady().then(async () => {
  console.log(`shots · ${BASE}${GALLERY} · themes: ${THEMES.join(', ')} · out: ${OUT}`);
  if (ONLY.length) console.log(`  filtered to: ${ONLY.join(', ')}`);

  // NEVER STEAL FOCUS (see the header): hidden by default, `showInactive()` maps the window
  // without raising it when you want to watch.
  // 1500x1400, and the height matters even though nothing is shown: `capturePage(rect)` CLIPS
  // silently to the viewport, so a cell taller than the window loses its bottom in the PNG with
  // no warning at all. Asking for more than the display's work area does not help either —
  // Windows and X11 clamp the window — so this is a request, not a guarantee, and a gallery
  // cell has to be laid out to fit a laptop screen. That is why an archetype sheet puts its
  // canvas and its previews side by side instead of stacking them.
  const win = new BrowserWindow({
    width: 1500,
    height: 1400,
    show: false,
    webPreferences: { backgroundThrottling: false },
  });
  win.webContents.setAudioMuted(true);

  const js = (s) => win.webContents.executeJavaScript(s);
  /** @type {{cell: string, theme: string, file: string}[]} */
  const shots = [];

  for (const theme of THEMES) {
    // Stamped by the blocking inline script in index.html, so it has to precede the load.
    await win.loadURL(BASE + '/');
    await js(`localStorage.setItem('decodesim.theme', ${JSON.stringify(theme)}); 'ok'`);
    await win.loadURL(BASE + GALLERY);
    if (flag('show')) win.showInactive();

    /**
     * WAIT FOR THE CELLS, do not sleep a guessed interval.
     *
     * The gallery steps every scene synchronously on mount — a couple of thousand Rapier ticks
     * — so the first paint is late, and how late depends on the machine. A fixed sleep is
     * either a flaky run or a slow one. Poll for the cells instead, then give the canvases one
     * settle window: they are painted in `useEffect`, i.e. after the DOM they are measured in
     * already exists.
     */
    let cells = [];
    for (let waited = 0; waited < 60000; waited += 250) {
      cells = await js(CELLS);
      if (cells.length) break;
      await sleep(250);
    }
    if (!cells.length) {
      console.log(`  [${theme}] NO CELLS at ${GALLERY}.`);
      console.log('  Either the dev route is not mounted yet (P0-core owns the `devRoutes`');
      console.log('  slot and the App.tsx routing for it), or the channel is not `alpha`.');
      continue;
    }
    await js(FREEZE);
    await sleep(400);

    const want = ONLY.length ? cells.filter((c) => ONLY.some((p) => c.name.startsWith(p))) : cells;
    console.log(`  [${theme}] ${want.length}/${cells.length} cells`);

    for (const cell of want) {
      const rect = await js(RECT(cell.i));
      if (!rect) continue;
      // A settle after scrolling: `scrollIntoView` is instant, but the capture reads the
      // COMPOSITED frame, and that is one paint behind the scroll.
      await sleep(120);
      const img = await win.webContents.capturePage(rect);
      const file = `${safe(cell.name)}.${theme}.png`;
      fs.writeFileSync(path.join(OUT, file), img.toPNG());
      shots.push({ cell: cell.name, theme, file });
    }
  }

  await js(`localStorage.removeItem('decodesim.theme'); 'ok'`);
  writeSheet(OUT, shots);
  console.log(`===== ${shots.length} shots -> ${OUT} =====`);
  console.log(`      contact sheet: ${path.join(OUT, 'index.html')}`);
  // NON-ZERO ON NOTHING CAPTURED, so a broken route fails a script that chains off this one
  // instead of quietly producing an empty directory.
  process.exit(shots.length ? 0 : 1);
});
app.on('window-all-closed', () => process.exit(0));

/**
 * The CONTACT SHEET: one row per cell, one column per theme.
 *
 * Rows rather than a flat grid, because the comparison that matters is a cell against ITSELF in
 * the other theme — that is what a two-theme run is for. It is a standalone file opened straight
 * off disk (`file://`), so it carries its own inline CSS and depends on nothing: the app's own
 * `ds-*` tokens are not loaded here, and pulling them in would make the sheet's chrome themed
 * by whatever the app last stored, which is exactly the variable being examined.
 */
function writeSheet(dir, shots) {
  const byCell = new Map();
  for (const s of shots) {
    if (!byCell.has(s.cell)) byCell.set(s.cell, {});
    byCell.get(s.cell)[s.theme] = s.file;
  }
  const themes = [...new Set(shots.map((s) => s.theme))];
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const rows = [...byCell.entries()]
    .map(([cell, files]) => {
      const cols = themes
        .map((t) =>
          files[t]
            ? `<td><img src="${esc(files[t])}" alt="${esc(cell)} ${t}" loading="lazy"></td>`
            : '<td class="miss">—</td>',
        )
        .join('');
      return `<tr><th>${esc(cell)}</th>${cols}</tr>`;
    })
    .join('\n');
  const html = `<!doctype html>
<meta charset="utf-8">
<title>BIOBUZZ gallery shots</title>
<style>
  body { margin: 0; padding: 24px; background: #14161a; color: #e7eaee;
         font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p  { margin: 0 0 20px; color: #98a3b2; }
  table { border-collapse: collapse; }
  th { text-align: left; vertical-align: top; padding: 8px 16px 8px 0; white-space: nowrap;
       color: #cbd5e1; font-weight: 600; }
  td { padding: 8px 8px 20px 0; vertical-align: top; }
  img { display: block; max-width: 460px; border: 1px solid #39414f; border-radius: 6px; }
  .miss { color: #6b7280; }
  thead th { padding-bottom: 12px; text-transform: uppercase; letter-spacing: 0.06em; }
</style>
<h1>BIOBUZZ gallery — ${byCell.size} cells</h1>
<p>${esc(path.basename(dir))} · ${themes.join(' / ')}</p>
<table>
<thead><tr><th>cell</th>${themes.map((t) => `<th>${esc(t)}</th>`).join('')}</tr></thead>
<tbody>
${rows}
</tbody>
</table>
`;
  fs.writeFileSync(path.join(dir, 'index.html'), html);
}
