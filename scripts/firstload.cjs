/* FIRST VISIT AND THE FIRST PLAY FLY (2026-11-04). Owner: "When loading into the homepage for the
 * first time, there is a loading screen, but then there is another loading animation for the field,
 * and even when the field shows up, the background scene shows up even later. On laggier machines,
 * clicking 'play' for the first time lags during the animation and it looks like there is no
 * animation at all."
 *
 *   npm run build
 *   npm run firstload                                 # High and Low, CPU x1/x4/x6, its own vite preview (~8 min)
 *   npm run firstload -- --tiers=high --cpu=4         # one cell
 *   npm run firstload -- --check                      # High and Low at x1/x4, 3 runs each, medians against
 *                                                     # scripts/firstload-ceilings.json (~15 min)
 *   npm run firstload -- --runs=3 --verbose           # medians; the load's longest frames too
 *   npm run firstload -- --outdir=<dir>               # serve another build (a saved baseline)
 *   npm run firstload -- --net=slow                   # a slow line (1.6 Mbit/s, 150 ms) on top
 *
 * Each cell is its OWN Electron process with a fresh profile, an in-memory session and the GPU
 * shader disk cache off, so the HTTP cache, storage and the GPU's program cache are all cold: a first
 * visit. Offscreen (`show:false` + `offscreen:true`) and muted. The GPU is ON (a software renderer
 * makes the 3D stage fall back to 2D), which is why this is not a pass of `shiftaudit.cjs`: that
 * script turns hardware acceleration off for the whole process. CPU slowdown is DevTools'
 * `Emulation.setCPUThrottlingRate` on the page's thread.
 *
 * What one cell records, in page time (ms since navigation):
 *   boot     the HTML loading screen starts to leave (`dismissBoot`) and is gone
 *   wait     the stage's own loading bar (`.ds-stage-wait`) was mounted long enough to show (600 ms)
 *   stage    the 3D stage's canvas fades in (`.ds-stage-3d.shown`)
 *   venue    the modeled venue swapped in (`dsim:venue-model` mark) and whether it was before `stage`
 *   tti      the first 500 ms with no long task after the boot screen left
 * then a REAL click on Play (input events), the frames through the camera fly, a click on the mark
 * back to Home, and the second Play click:
 *   worst    the longest gap between two animation frames from the click to the fly's end + 600 ms
 *   over50   frames longer than 50 ms in that window
 *   renders  frames the stage drew during the fly (an animation that visibly runs draws most of them)
 *   blame    for each long frame: the scripts the browser attributes it to (Long Animation Frames),
 *            and the WebGL time spent compiling shaders and uploading textures/buffers in it
 *
 * `--check` holds each cell's median first fly to `scripts/firstload-ceilings.json` (its worst frame,
 * frames over 50 ms, frames the stage drew, the click's task, no program linked in it), and in every
 * run: ONE REVEAL (a High stage shows with its room, or the room crossfades in; never a pop), the
 * stage's own bar never seen on a load the boot screen covered, and Play's page rehearsed before the
 * click. ⚠️ THIS PC IS SHARED: a run beside a build or a game reads slow (see `calibration`), which is
 * why the ceilings hold medians of three. Rules: `docs/area/biobuzz.md`, THE MENU STAGE LOADS IN ONE
 * REVEAL.
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

const arg = (k, d) => {
  const a = process.argv.find((s) => s.startsWith(`--${k}=`));
  if (a) return a.slice(k.length + 3);
  return process.argv.includes(`--${k}`) ? '1' : d;
};
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(arg('port', process.env.DSIM_PORT || '4291'));
const BASE = `http://localhost:${PORT}`;
const W = 1920;
const H = 1080;
/** `--verbose`: the load's longest frames too */
const VERBOSE = arg('verbose', '') === '1';
/** the fly (`FLY_MS` in MenuStage.tsx, 1 s) and a frame's grace, from the click */
const FLY_END = 1150;

// ── the instrument, injected into the page before any of its scripts (main world) ─────────────
const INSTR = (seed) => `(() => {
  if (window.__fl) return;
  try { ${seed} } catch (e) {}
  const T = (window.__fl = { frames: [], lt: [], loaf: [], res: [], marks: [], dom: [], clicks: [], stageCtx: -1 });
  const dom = (k) => T.dom.push([k, performance.now()]);
  // ── the frame recorder: one entry per animation frame, carrying the WebGL work since the last ──
  let cur = { shader: 0, tex: 0, buf: 0, read: 0, links: 0, draws: {} };
  const tick = (t) => {
    T.frames.push([t, cur.shader, cur.tex, cur.buf, cur.read, cur.draws, cur.links]);
    cur = { shader: 0, tex: 0, buf: 0, read: 0, links: 0, draws: {} };
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const obs = (type, f) => { try { new PerformanceObserver((l) => l.getEntries().forEach(f)).observe({ type, buffered: true }); } catch (e) {} };
  obs('longtask', (e) => T.lt.push([e.startTime, e.duration]));
  obs('long-animation-frame', (e) => T.loaf.push({ s: e.startTime, d: e.duration, b: e.blockingDuration,
    scripts: e.scripts.map((x) => ({ s: x.startTime, d: x.duration, inv: x.invoker, src: (x.sourceURL || '').split('/').pop(), fn: x.sourceFunctionName })) }));
  obs('resource', (e) => T.res.push([e.name.split('/').pop().split('?')[0], e.startTime, e.responseEnd, e.transferSize]));
  obs('mark', (e) => T.marks.push([e.name, e.startTime]));
  obs('paint', (e) => T.marks.push([e.name, e.startTime]));
  // ── WebGL: time in the calls that compile, link, upload or read back; a count of draws per context ──
  const ids = new WeakMap();
  let nextId = 0;
  const idOf = (gl) => { let i = ids.get(gl); if (i === undefined) { i = nextId++; ids.set(gl, i); } return i; };
  const cats = {
    shader: ['compileShader', 'linkProgram', 'getProgramParameter', 'getShaderParameter', 'getProgramInfoLog', 'getShaderInfoLog', 'getUniformLocation', 'getActiveUniform', 'getActiveAttrib'],
    tex: ['texImage2D', 'texImage3D', 'texSubImage2D', 'texSubImage3D', 'compressedTexImage2D', 'compressedTexSubImage2D', 'compressedTexImage3D', 'texStorage2D', 'texStorage3D', 'generateMipmap'],
    buf: ['bufferData', 'bufferSubData'],
    read: ['readPixels', 'getError', 'clientWaitSync', 'finish'],
  };
  const P = window.WebGL2RenderingContext && WebGL2RenderingContext.prototype;
  if (P) {
    for (const [cat, names] of Object.entries(cats))
      for (const k of names) {
        const f = P[k];
        if (typeof f !== 'function') continue;
        P[k] = function () { const t = performance.now(); try { return f.apply(this, arguments); } finally { cur[cat] += performance.now() - t; } };
      }
    const link = P.linkProgram;
    P.linkProgram = function () { cur.links++; return link.apply(this, arguments); };
    for (const k of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'drawRangeElements']) {
      const f = P[k];
      if (typeof f !== 'function') continue;
      P[k] = function () { const i = idOf(this); cur.draws[i] = (cur.draws[i] || 0) + 1; return f.apply(this, arguments); };
    }
  }
  T.ctxOf = (canvas) => { try { const gl = canvas.getContext('webgl2'); return gl ? idOf(gl) : -1; } catch (e) { return -1; } };
  // ── the DOM milestones the page does not mark itself ──
  addEventListener('pointerdown', (e) => T.clicks.push(e.timeStamp), true);
  const seen = new WeakSet();
  const watch = () => {
    const boot = document.getElementById('seo-home');
    if (boot && !seen.has(boot)) {
      seen.add(boot);
      dom('boot-present');
      new MutationObserver(() => { if (boot.style.opacity === '0' && !T.bootLeave) { T.bootLeave = 1; dom('boot-leave'); } }).observe(boot, { attributes: true, attributeFilter: ['style'] });
    }
    if (T.bootPresent === undefined && boot) T.bootPresent = 1;
    if (T.bootPresent && !boot && !T.bootGone) { T.bootGone = 1; dom('boot-gone'); }
    const s3 = document.querySelector('.ds-stage-3d');
    if (s3 && !seen.has(s3)) {
      seen.add(s3);
      dom('stage-mount');
      const check = () => {
        if (s3.classList.contains('shown') && !T.stageShown) { T.stageShown = 1; dom('stage-shown'); }
        const c = s3.querySelector('canvas');
        if (c && T.stageCtx < 0) { T.stageCtx = T.ctxOf(c); dom('stage-canvas'); }
      };
      check();
      new MutationObserver(check).observe(s3, { attributes: true, attributeFilter: ['class'], childList: true });
    }
    const wait = document.querySelector('.ds-stage-wait');
    if (wait && !T.waitOn) { T.waitOn = performance.now(); dom('wait-mount'); }
    if (!wait && T.waitOn) { dom('wait-gone'); T.waitOn = 0; }
    const s2 = document.querySelector('.ds-stage-2d img');
    if (s2 && !T.stage2d) { T.stage2d = 1; dom('stage-2d'); }
    const veil = document.querySelector('.ds-stage-veil');
    if (veil && !seen.has(veil)) {
      seen.add(veil);
      new MutationObserver(() => { if (!veil.hidden && !T.veil) { T.veil = 1; dom('veil-on'); } }).observe(veil, { attributes: true, attributeFilter: ['hidden'] });
    }
  };
  new MutationObserver(watch).observe(document, { childList: true, subtree: true });
})();`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ════════════════════════════════════════════════════════════════════════════════════════════════
// ONE CELL (a child process)
// ════════════════════════════════════════════════════════════════════════════════════════════════
async function oneCell(cfg) {
  const js = (win, s) => win.webContents.executeJavaScript(s);
  const win = new BrowserWindow({
    width: W,
    height: H,
    show: false,
    useContentSize: true,
    enableLargerThanScreen: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, partition: `firstload-${process.pid}` },
  });
  win.webContents.setAudioMuted(true);
  win.webContents.setFrameRate(60);
  win.setContentSize(W, H);
  await win.loadURL('data:text/html,<title>firstload</title><p>');
  // HOW BUSY IS THIS PC RIGHT NOW: a fixed piece of script, before any throttling (≈78 ms on the dev
  // PC on 2026-11-04). Reported beside each run, so a slow run can be told from a slow build.
  const calib = await js(win, `(() => { const t = performance.now(); let x = 0; for (let i = 0; i < 3e7; i++) x = (x + i * 7) % 1000003; return Math.round(performance.now() - t) + (x < 0 ? 1 : 0); })()`);
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  const cmd = (m, p) => dbg.sendCommand(m, p);
  await cmd('Page.enable');
  await cmd('Network.enable');
  const gfx = JSON.stringify({ preset: cfg.tier, tier: cfg.tier, rev: 4 });
  const seed = `if (!sessionStorage.getItem('__flSeeded')) { sessionStorage.setItem('__flSeeded', '1'); localStorage.setItem('decodesim.graphics', ${JSON.stringify(gfx)}); }`;
  await cmd('Page.addScriptToEvaluateOnNewDocument', { source: INSTR(seed) });
  if (cfg.cpu > 1) await cmd('Emulation.setCPUThrottlingRate', { rate: cfg.cpu });
  if (cfg.net === 'slow')
    await cmd('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });

  await win.loadURL(`${BASE}${cfg.route}`);
  const state = () =>
    js(win, `(() => { const T = window.__fl; if (!T) return null; return { now: performance.now(), bootGone: !!T.bootGone, stage: !!T.stageShown, s2d: !!T.stage2d,
      lastLong: T.lt.length ? T.lt[T.lt.length - 1][0] + T.lt[T.lt.length - 1][1] : 0,
      }; })()`);
  // HOME IS SETTLED: the boot screen gone, the stage shown (or fell back to 2D), and the page quiet for
  // 1.5 s — the same wait for every build, so a build that is slower to settle is not clicked early
  const cap = 20000 + cfg.cpu * 8000 + (cfg.net === 'slow' ? 40000 : 0);
  const t0 = Date.now();
  let st = null;
  for (;;) {
    st = await state();
    if (st && st.bootGone && (st.stage || st.s2d) && st.now - st.lastLong > 1500 && Date.now() - t0 > 3000) {
      // and anything the page itself is still fetching
      await sleep(500);
      const again = await state();
      if (again.now - again.lastLong > 1500) break;
    }
    if (Date.now() - t0 > cap) break;
    await sleep(250);
  }
  // let the idle-time work run as it would for someone reading the page: a fixed 3 s more
  await sleep(cfg.dwell);
  const home = await js(win, 'performance.now()');

  const clickAt = async (sel) => {
    const r = await js(win, `(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.offsetParent !== null); if (!e) return null; const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`);
    if (!r) throw new Error(`nothing to click: ${sel}`);
    const [x, y] = r.map(Math.round);
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    await sleep(30);
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await sleep(40);
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  };

  await clickAt('.ds-menu-btn.primary');
  await sleep(1000 + 2500 + cfg.cpu * 300);
  const firstClickN = (await js(win, 'window.__fl.clicks.length')) - 1;
  // back to Home by the bar's mark, then Play again
  await clickAt('.ds-mark');
  await sleep(3000 + cfg.cpu * 300);
  await clickAt('.ds-menu-btn.primary');
  await sleep(1000 + 2500 + cfg.cpu * 300);

  const raw = await js(win, `(() => { const T = window.__fl; return { frames: T.frames, lt: T.lt, loaf: T.loaf, res: T.res, marks: T.marks, dom: T.dom, clicks: T.clicks, stageCtx: T.stageCtx, s2d: !!T.stage2d }; })()`);
  try { dbg.detach(); } catch {}
  win.destroy();
  return { ...summarise(cfg, raw, home, firstClickN), calib };
}

/** the numbers one cell reports */
function summarise(cfg, raw, home, firstClickN) {
  const at = (name) => {
    const m = raw.marks.find((x) => x[0] === name);
    if (m) return m[1];
    const d = raw.dom.find((x) => x[0] === name);
    return d ? d[1] : null;
  };
  const r0 = (v) => (v == null ? null : Math.round(v));
  const fcp = at('first-contentful-paint');
  const bootLeave = at('dsim:boot-leave') ?? at('boot-leave');
  const bootGone = at('boot-gone');
  // the reveal: the build's own mark (`dsim:stage-whole` / `-partial`), else the stage's class
  const whole = at('dsim:stage-whole');
  const part = at('dsim:stage-partial');
  const stage = whole ?? part ?? at('stage-shown');
  const lt = raw.lt.map(([s, d]) => [s, s + d]);
  // THE STAGE'S OWN BAR, AS SEEN: mounted 600 ms (its CSS delay) and not under the boot screen
  let barShown = 0;
  {
    const mount = at('wait-mount');
    const gone = at('wait-gone');
    if (mount != null) {
      const from = Math.max(mount + 600, bootLeave ?? 0);
      const to = gone ?? Infinity;
      if (to > from) barShown = Number.isFinite(to) ? to - from : -1;
    }
  }
  // TIME TO INTERACTIVE: from the boot screen's leave, the first 500 ms with no long task in it
  let tti = null;
  if (bootLeave != null) {
    let t = bootLeave;
    for (const [s, e] of lt.filter(([, e]) => e > bootLeave).sort((a, b) => a[0] - b[0])) {
      if (s - t >= 500) break;
      t = Math.max(t, e);
    }
    tti = t;
  }
  // stage renders (frames the stage's own context drew in), by frame time
  const ctx = String(raw.stageCtx);
  const frames = raw.frames.map(([t, shader, tex, buf, read, draws, links]) => ({ t, shader, tex, buf, read, links: links || 0, draws: draws[ctx] || 0, other: Object.entries(draws).filter(([k]) => k !== ctx).reduce((a, [, n]) => a + n, 0) }));
  // the stage's draw count per render up to the first click: the venue swap shows as a step in it
  const click1 = raw.clicks[firstClickN] ?? null;
  const click2 = raw.clicks[raw.clicks.length - 1] ?? null;
  const renders = [];
  for (let i = 1; i < frames.length; i++) {
    const f = frames[i];
    if (f.draws > 0 && (click1 == null || f.t < click1)) renders.push([Math.round(frames[i - 1].t), f.draws]);
  }
  // THE MODELED ROOM IN: the build's mark, else (a build without marks) the first render whose draw
  // count stepped up by 150+ over the stage's first FULL render (100+ draws: the ones before are the
  // light probe's). The GRB hall adds ~250 draws on High; on marked builds the two agree within 20 ms.
  let venue = at('dsim:venue-model');
  const full = renders.find(([, d]) => d >= 100);
  if (venue == null && full) {
    const step = renders.find(([, d]) => d >= full[1] + 150);
    if (step) venue = step[0];
  }
  /** the longest frames in [from, to): their WebGL time and the scripts the browser blames */
  const longest = (from, to, n) => {
    const out = [];
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1];
      const b = frames[i];
      if (b.t <= from || a.t >= to) continue;
      out.push({ from: a.t, to: b.t, gap: b.t - a.t, shader: b.shader, tex: b.tex, buf: b.buf, read: b.read, links: b.links, draws: b.draws, other: b.other });
    }
    return out
      .sort((x, y) => y.gap - x.gap)
      .slice(0, n)
      .filter((f) => f.gap > 50)
      .map((f) => {
        const scripts = raw.loaf
          .filter((l) => l.s < f.to && l.s + l.d > f.from)
          .flatMap((l) => l.scripts)
          .filter((s) => s.d >= 5)
          .sort((x, y) => y.d - x.d)
          .slice(0, 4)
          .map((s) => `${s.inv || '?'}${s.fn ? ` ${s.fn}` : ''} @${s.src} ${Math.round(s.d)}ms`);
        return {
          at: Math.round(f.from),
          gap: Math.round(f.gap),
          gl: `shader ${Math.round(f.shader)} tex ${Math.round(f.tex)} buf ${Math.round(f.buf)} read ${Math.round(f.read)} links ${f.links} draws ${f.draws}`,
          scripts,
        };
      });
  };
  const fly = (c) => {
    if (c == null) return null;
    const end = c + 1000 + 600;
    const inWin = [];
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1];
      const b = frames[i];
      if (b.t <= c || a.t >= end) continue;
      inWin.push({ from: a.t, to: b.t, gap: b.t - a.t, shader: b.shader, tex: b.tex, buf: b.buf, read: b.read, links: b.links, draws: b.draws, other: b.other });
    }
    const long = inWin.filter((f) => f.gap > 50);
    const blame = long
      .sort((a, b) => b.gap - a.gap)
      .slice(0, 6)
      .map((f) => {
        const loafs = raw.loaf.filter((l) => l.s < f.to && l.s + l.d > f.from);
        const scripts = loafs
          .flatMap((l) => l.scripts)
          .filter((s) => s.d >= 5)
          .sort((a, b) => b.d - a.d)
          .slice(0, 4)
          .map((s) => `${s.inv || '?'}${s.fn ? ` ${s.fn}` : ''} @${s.src} ${Math.round(s.d)}ms`);
        const res = raw.res.filter((x) => x[2] > f.from - 200 && x[2] < f.to).map((x) => x[0]);
        return {
          at: Math.round(f.from - c),
          gap: Math.round(f.gap),
          gl: `shader ${Math.round(f.shader)} tex ${Math.round(f.tex)} buf ${Math.round(f.buf)} read ${Math.round(f.read)}`,
          scripts,
          landed: res.slice(0, 6),
        };
      });
    // THE FLY is the first FLY_MS (1 s) after the click, and a frame's grace: what the ceilings hold.
    // The 600 ms after it (the landing, and what runs once the camera rests) is reported as `tail`.
    const flyFrames = inWin.filter((f) => f.from < c + FLY_END);
    const tail = inWin.filter((f) => f.from >= c + FLY_END);
    // the click's own task (React mounting the page it opens), as the browser attributes it
    const clickTask = Math.max(
      0,
      ...raw.loaf
        .filter((l) => l.s >= c - 100 && l.s < c + 400)
        .flatMap((l) => l.scripts)
        .filter((s) => /click|pointer|mouse/i.test(s.inv || ''))
        .map((s) => s.d),
    );
    return {
      clickTask: Math.round(clickTask),
      worst: Math.round(Math.max(0, ...flyFrames.map((f) => f.gap))),
      over50: flyFrames.filter((f) => f.gap > 50).length,
      over100: flyFrames.filter((f) => f.gap > 100).length,
      tailWorst: Math.round(Math.max(0, ...tail.map((f) => f.gap))),
      frames: inWin.length,
      renders: flyFrames.filter((f) => f.draws > 0).length,
      // shader programs linked and draws on other canvases (Play's robot cards) in the window
      links: inWin.reduce((a, f) => a + f.links, 0),
      cardDraws: inWin.reduce((a, f) => a + f.other, 0),
      firstRender: (() => {
        const f = inWin.find((x) => x.draws > 0);
        return f ? Math.round(f.to - c) : null;
      })(),
      loaded: raw.res.filter((x) => x[1] >= c - 50 && x[1] < end).map((x) => x[0]),
      blame,
    };
  };
  return {
    cell: `${cfg.tier} x${cfg.cpu}${cfg.net ? ` ${cfg.net}` : ''}`,
    tier: cfg.tier,
    cpu: cfg.cpu,
    net: cfg.net || '',
    fcp: r0(fcp),
    bootLeave: r0(bootLeave),
    bootGone: r0(bootGone),
    appReady: r0(at('dsim:app-ready')),
    field: r0(at('dsim:stage-field')),
    stage: r0(stage),
    reveal: whole != null ? 'whole' : part != null ? 'partial' : stage != null ? 'first frame' : 'none',
    stage2d: raw.s2d,
    barShown: r0(barShown),
    venue: r0(venue),
    veil: raw.dom.some((d) => d[0] === 'veil-on'),
    tti: r0(tti),
    home: r0(home),
    renders,
    // what the load spent its longest frames on, up to the reveal (or 2 s after the app was ready)
    loadFrames: longest(at('dsim:app-ready') ?? 0, stage != null ? stage + 200 : (at('dsim:app-ready') ?? 0) + 2000, 8),
    marks: raw.marks.filter((m) => m[0].startsWith('dsim:')).map(([n, t]) => [n, Math.round(t)]),
    first: fly(click1),
    second: fly(click2),
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// THE RUN (the parent process): a preview server, one child per cell, the table, the check
// ════════════════════════════════════════════════════════════════════════════════════════════════
const up = () =>
  new Promise((res) => {
    const req = http.get(BASE + '/', (r) => {
      r.resume();
      res(r.statusCode === 200);
    });
    req.on('error', () => res(false));
    req.setTimeout(2000, () => {
      req.destroy();
      res(false);
    });
  });

async function runAll() {
  const check = arg('check', '') === '1';
  const tiers = arg('tiers', 'high,low').split(',');
  // the check holds ×1 and ×4 (the target); ×6 is reported, too noisy on a shared PC to hold
  const cpus = arg('cpu', check ? '1,4' : '1,4,6').split(',').map(Number);
  const net = arg('net', '');
  const route = arg('route', '/biobuzz');
  const outdir = arg('outdir', '');
  const dwell = Number(arg('dwell', '3000'));
  const outFile = arg('out', '');
  let server = null;
  if (!(await up())) {
    // ITS OWN PREVIEW SERVER, stopped at the end. `ELECTRON_RUN_AS_NODE` makes this binary a plain node.
    const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
    const a = [vite, 'preview', '--port', String(PORT), '--strictPort'];
    if (outdir) a.push('--outDir', outdir);
    server = spawn(process.execPath, a, { cwd: ROOT, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore' });
    for (let i = 0; i < 80 && !(await up()); i++) await sleep(250);
    if (!(await up())) {
      console.error(`firstload: no preview on ${BASE} (did you build?)`);
      server.kill();
      app.exit(2);
      return;
    }
  }
  const results = [];
  const cells = [];
  try {
    for (const tier of tiers)
      for (const cpu of cpus) {
        const runs = [];
        for (let n = 0; n < RUNS; n++) {
          const cfg = { tier, cpu, net, route, dwell };
          // a fresh profile per run, removed after it (the child cannot delete its own)
          const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'firstload-'));
          const child = spawn(process.execPath, [__filename, `--one=${JSON.stringify(cfg)}`, `--port=${PORT}`, `--profile=${profile}`], {
            cwd: ROOT,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let out = '';
          child.stdout.on('data', (d) => (out += d));
          child.stderr.on('data', () => {});
          const code = await new Promise((r) => child.on('exit', r));
          for (let i = 0; i < 10; i++) {
            try {
              fs.rmSync(profile, { recursive: true, force: true });
              break;
            } catch {
              await sleep(500);
            }
          }
          const line = out.split('\n').find((l) => l.startsWith('FLRESULT '));
          if (!line) {
            console.log(`${tier} x${cpu}: the run failed (exit ${code})\n${out.slice(-2000)}`);
            continue;
          }
          const r = JSON.parse(line.slice(9));
          results.push(r);
          runs.push(r);
          if (RUNS === 1 || VERBOSE) print(r);
          else console.log(brief(r, n + 1));
        }
        if (runs.length) {
          const m = median(runs);
          cells.push(m);
          if (RUNS > 1) console.log(`   median of ${runs.length}: ${briefNums(m)}`);
        }
      }
  } finally {
    if (server) server.kill();
  }
  if (outFile) fs.writeFileSync(outFile, JSON.stringify({ runs: results, medians: cells }, null, 2));
  let failed = 0;
  if (check) failed = runCheck(results, cells);
  app.exit(failed ? 1 : 0);
}

/** runs per cell (`--runs`); a `--check` takes the median of three: this PC is shared, and one run
 * that landed beside someone else's build is not a regression */
const RUNS = Number(arg('runs', arg('check', '') === '1' ? '3' : '1'));

const med = (xs) => {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  return v.length ? v[Math.floor((v.length - 1) / 2)] : null;
};
/** a cell's runs → one row of medians (the reveal and the room's crossfade: any run's) */
function median(runs) {
  const r0 = runs[0];
  const fly = (k) =>
    runs[0][k] && {
      clickTask: med(runs.map((r) => r[k]?.clickTask)),
      worst: med(runs.map((r) => r[k]?.worst)),
      over50: med(runs.map((r) => r[k]?.over50)),
      renders: med(runs.map((r) => r[k]?.renders)),
      tailWorst: med(runs.map((r) => r[k]?.tailWorst)),
      links: Math.max(...runs.map((r) => r[k]?.links ?? 0)),
    };
  return {
    cell: r0.cell,
    tier: r0.tier,
    cpu: r0.cpu,
    runs: runs.length,
    calib: med(runs.map((r) => r.calib)),
    appReady: med(runs.map((r) => r.appReady)),
    bootLeave: med(runs.map((r) => r.bootLeave)),
    field: med(runs.map((r) => r.field)),
    stage: med(runs.map((r) => r.stage)),
    venue: med(runs.map((r) => r.venue)),
    barShown: med(runs.map((r) => r.barShown)),
    tti: med(runs.map((r) => r.tti)),
    reveals: runs.map((r) => r.reveal),
    first: fly('first'),
    second: fly('second'),
  };
}
function briefNums(r) {
  const f = (x) => (x == null ? '-' : `${x}`);
  const p = (v) => (v ? `click ${v.clickTask} worst ${v.worst} >50 ${v.over50} drew ${v.renders}` : '-');
  return (
    `boot leaves ${f(r.bootLeave)} · stage ${f(r.stage)} (${r.reveal ?? r.reveals?.join('/')}) · room ${f(r.venue)}${r.veil ? ' crossfaded' : ''} · bar ${f(r.barShown)} · ` +
    `first Play ${p(r.first)} · second ${p(r.second)} · calib ${f(r.calib)} ms`
  );
}
function brief(r, n) {
  return `   ${r.cell}${r.stage2d ? ' (2D)' : ''} run ${n}: ${briefNums(r)}`;
}

function print(r) {
  const f = (x) => (x == null ? '-' : `${x}`);
  console.log(
    `\n== ${r.cell}${r.stage2d ? ' (2D stage)' : ''}   (calibration ${f(r.calib)} ms)\n` +
      `   boot screen  shown ${f(r.fcp)}  app ready ${f(r.appReady)}  leaves ${f(r.bootLeave)}  gone ${f(r.bootGone)}   stage's own bar seen for ${f(r.barShown)} ms\n` +
      `   stage field drawn ${f(r.field)}  shown ${f(r.stage)} (${r.reveal})  venue model in ${f(r.venue)}${r.veil ? ' (crossfaded)' : ''}   interactive ${f(r.tti)}   clicked Play at ${f(r.home)}\n` +
      `   stage renders before the click [t, draws]: ${JSON.stringify(r.renders.slice(0, 12))}${r.renders.length > 12 ? ` …(${r.renders.length})` : ''}\n` +
      `   marks ${JSON.stringify(r.marks)}`,
  );
  if (VERBOSE) for (const b of r.loadFrames) console.log(`      load @${b.at}: ${b.gap} ms  [${b.gl}]  ${b.scripts.join(' | ')}`);
  for (const k of ['first', 'second']) {
    const v = r[k];
    if (!v) continue;
    console.log(
      `   ${k} Play: click task ${v.clickTask} ms; fly's worst frame ${v.worst} ms, >50 ms ${v.over50}, >100 ms ${v.over100}, stage drew ${v.renders} of its frames (first ${f(v.firstRender)} ms after the click); landing's worst ${v.tailWorst} ms; programs linked ${v.links}, card draws ${v.cardDraws}` +
        (v.loaded.length ? `\n      fetched in it: ${v.loaded.join(', ')}` : ''),
    );
    for (const b of v.blame) console.log(`      +${b.at} ms: ${b.gap} ms  [${b.gl}]  ${b.scripts.join(' | ')}${b.landed.length ? `  landed: ${b.landed.join(', ')}` : ''}`);
  }
}

/** THE LOCK. The reveal rules hold in every run; the ceilings hold each cell's MEDIAN. */
function runCheck(results, cells) {
  const ceilings = JSON.parse(fs.readFileSync(path.join(__dirname, 'firstload-ceilings.json'), 'utf8'));
  let bad = 0;
  const fail = (s) => {
    bad++;
    console.log(`FAIL ${s}`);
  };
  for (const m of cells) {
    const c = ceilings[m.tier]?.[`x${m.cpu}`];
    if (!c || !m.first) continue;
    if (c.reveal && !m.reveals.every((x) => x === c.reveal)) fail(`${m.cell}: the stage's reveals were ${m.reveals.join('/')}, expected ${c.reveal}`);
    if (m.first.worst > c.worst) fail(`${m.cell}: first Play's worst fly frame ${m.first.worst} ms (median) > ${c.worst}`);
    if (m.first.over50 > c.over50) fail(`${m.cell}: first Play had ${m.first.over50} fly frames over 50 ms (median) > ${c.over50}`);
    if (m.first.renders < c.renders) fail(`${m.cell}: the stage drew ${m.first.renders} frames of the first fly (median) < ${c.renders}`);
    if (c.clickTask != null && m.first.clickTask > c.clickTask) fail(`${m.cell}: first Play's click task ${m.first.clickTask} ms (median) > ${c.clickTask}`);
    if (m.first.links > 0) fail(`${m.cell}: ${m.first.links} shader programs linked during a first fly (warm them on Home)`);
  }
  for (const r of results) {
    if (r.stage2d) {
      fail(`${r.cell}: the stage fell back to 2D (no GPU?), nothing measured`);
      continue;
    }
    // ONE REVEAL: on a fast enough load the stage shows WHOLE (its room with it); short of that its
    // room crossfades in. Never a room that pops in after the stage has been seen.
    const modeled = r.tier !== 'low' && r.tier !== 'medium';
    if (r.stage == null) fail(`${r.cell}: the stage never showed`);
    else if (modeled && r.venue == null) fail(`${r.cell}: no modeled venue went in`);
    else if (modeled && r.venue > r.stage + 1 && !r.veil) fail(`${r.cell}: the stage showed at ${r.stage} ms and its room popped in at ${r.venue} ms`);
    // the boot screen covers the whole load: the stage's own bar is never seen on a cold load that
    // made it inside the boot screen's cap
    if (r.reveal === 'whole' && r.barShown > 0) fail(`${r.cell}: the stage's own loading bar was seen for ${r.barShown} ms`);
    // Play's page was rehearsed on Home before the click (`PlayRehearsal.tsx`)
    if (r.first && !r.marks.some((x) => x[0] === 'dsim:play-rehearsed' && x[1] < r.home)) fail(`${r.cell}: Play's page was not rehearsed before the first click`);
  }
  console.log(bad ? `\nfirstload: ${bad} failure(s)` : '\nfirstload: within the ceilings');
  return bad;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
const one = arg('one', '');
if (one) {
  // a COLD profile: its own user data (the parent's fresh directory), no shader disk cache, muted
  app.setPath('userData', arg('profile', '') || fs.mkdtempSync(path.join(os.tmpdir(), 'firstload-')));
  app.commandLine.appendSwitch('mute-audio');
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  setTimeout(() => process.exit(3), 240000);
  app.whenReady().then(async () => {
    try {
      const r = await oneCell(JSON.parse(one));
      process.stdout.write(`FLRESULT ${JSON.stringify(r)}\n`);
      app.exit(0);
    } catch (e) {
      process.stdout.write(`FLERROR ${(e && e.stack) || e}\n`);
      app.exit(3);
    }
  });
} else {
  app.commandLine.appendSwitch('mute-audio');
  app.whenReady().then(runAll);
}
