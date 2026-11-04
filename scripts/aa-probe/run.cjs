// EDGE-ALIASING PROBE DRIVER — offscreen Electron over `scripts/aa-probe` (a Vite root of its own;
// `record.mjs` starts it). One DPR per process. For each tier it draws every view through the real
// scene, reads the canvas back, asks the page for the supersampled reference and the class map, and
// scores the difference. `npm run aaprobe` (record.mjs) is the usual way in; this is the worker.
//
//   electron scripts/aa-probe/run.cjs --port=5203 --tiers=low,medium,high,ultra --dprs=2 //     [--views=driver,tape | none] [--S=6] [--motion=4] [--shadow=1] [--set=aa:off] [--out=dir] [--save=1] [--gpu=1]
//
// Scores, all in 8-bit sRGB luma levels against the reference:
//   E      mean |test − ref| over EDGE pixels (reference contrast ≥ 32 levels in the 3×3 around)
//   J      share of edge pixels off by more than 24 levels (a visible step)
//   alias  (a canvas drawn below the panel's pixels) E and J against the reference resolved AT THE
//          RENDER RESOLUTION and stretched the way the compositor stretches it: the stair-steps,
//          without the softness the pixel count costs, which no antialiasing can give back (`soft`)
//   by class: geometric edges by the surface in front (floor, tape, structure, hive, robot,
//   element, venue, glass), and "interior" edges (texture, shadow and shading edges inside one
//   surface). Motion views add F, the mean |Δtest − Δref| between consecutive frames on edges
//   (crawl the reference does not have), and flatF/flatBig the same off the edges (z-fighting,
//   sparkle). `--shadow=1` adds shadowMap: the frame's sun map against one with 4× the texels.
//   ⚠️ A GL LINE PRIMITIVE (the shot path) is 1 px wide at any resolution, so the reference draws
//   it S times thinner; it shows as error on its few pixels and is not aliasing.
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const arg = (k, d) => {
  const a = process.argv.find((s) => s.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const PORT = Number(arg('port', '4183'));
const TIERS = arg('tiers', 'low,medium,high,ultra').split(',');
const DPRS = arg('dprs', '1,2').split(',').map(Number);
const VIEWS = arg('views', '');
const S = Number(arg('S', '6'));
const MOTION = Number(arg('motion', '4'));
const SHADOW = arg('shadow', '0') === '1';
const SET = arg('set', '');
const OUT = arg('out', '');
const SAVE = arg('save', '0') === '1';
const GPU = arg('gpu', '0') === '1';
const CSS_W = Number(arg('w', '1920'));
const CSS_H = Number(arg('h', '1080'));

app.commandLine.appendSwitch('mute-audio');
// the CAPTURE comes out at the host's scale factor whatever the page is emulating, so one DPR per
// process, forced here; the page is told the same through device emulation below
if (DPRS.length !== 1) throw new Error('one --dprs value per run (the capture scale is per process)');
app.commandLine.appendSwitch('force-device-scale-factor', String(DPRS[0]));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CATS = ['background', 'floor', 'tape', 'structure', 'hive', 'robot', 'element', 'venue', 'glass'];

/** BGRA bitmap → luma (sRGB-encoded levels) */
function luma(bgra, n) {
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = 0.0722 * bgra[i * 4] + 0.7152 * bgra[i * 4 + 1] + 0.2126 * bgra[i * 4 + 2];
  return y;
}

function score(T, R, cls, W, H, prev, M = R) {
  const n = W * H;
  const err = new Float32Array(n);
  for (let i = 0; i < n; i++) err[i] = Math.abs(T[i] - R[i]);
  const tot = { n: 0, e: 0, j: 0, f: 0 };
  const flat = { n: 0, f: 0, big: 0 };
  const geo = {};
  const inner = {};
  let allE = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      allE += err[i];
      let lo = 255;
      let hi = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const v = M[i + dy * W + dx];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      if (hi - lo < 32) {
        // FLAT: z-fighting, shimmer and specular sparkle show up here as frame-to-frame change the
        // reference does not have
        if (prev) {
          const d = Math.abs(T[i] - prev.T[i] - (R[i] - prev.R[i]));
          flat.n++;
          flat.f += d;
          if (d > 16) flat.big++;
        }
        continue;
      }
      const c = cls[i];
      const cat = CATS[c & 15] ?? 'unknown';
      const bucket = c & 16 ? geo : inner;
      const b = (bucket[cat] ??= { n: 0, e: 0, j: 0 });
      b.n++;
      b.e += err[i];
      if (err[i] > 24) b.j++;
      tot.n++;
      tot.e += err[i];
      if (err[i] > 24) tot.j++;
      if (prev) tot.f += Math.abs(T[i] - prev.T[i] - (R[i] - prev.R[i]));
    }
  }
  const fin = (b) => ({ n: b.n, E: +(b.e / Math.max(1, b.n)).toFixed(2), J: +(b.j / Math.max(1, b.n)).toFixed(3) });
  const out = { E: +(tot.e / Math.max(1, tot.n)).toFixed(2), J: +(tot.j / Math.max(1, tot.n)).toFixed(3), n: tot.n, all: +(allE / n).toFixed(2) };
  if (prev) {
    out.F = +(tot.f / Math.max(1, tot.n)).toFixed(2);
    out.flatF = +(flat.f / Math.max(1, flat.n)).toFixed(3);
    out.flatBig = +(flat.big / Math.max(1, flat.n)).toFixed(5);
  }
  out.geo = Object.fromEntries(Object.entries(geo).map(([k, b]) => [k, fin(b)]));
  out.inner = Object.fromEntries(Object.entries(inner).map(([k, b]) => [k, fin(b)]));
  return out;
}

/** area-average `src` (w×h) to `ow` columns: separable box weights with fractional ends */
function areaRows(src, w, h, ow) {
  const out = new Float32Array(ow * h);
  const k = w / ow;
  for (let ox = 0; ox < ow; ox++) {
    const a = ox * k;
    const b = a + k;
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let x = Math.floor(a); x < Math.ceil(b); x++) {
        const wgt = Math.min(b, x + 1) - Math.max(a, x);
        s += wgt * src[y * w + Math.min(w - 1, x)];
      }
      out[y * ow + ox] = s / k;
    }
  }
  return out;
}
function transpose(src, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[x * h + y] = src[y * w + x];
  return out;
}
/** bilinear, texel centres aligned (what the compositor does to a canvas drawn below its size) */
function bilinearUp(src, w, h, W, H) {
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(h - 1, Math.max(0, ((y + 0.5) * h) / H - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(h - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < W; x++) {
      const sx = Math.min(w - 1, Math.max(0, ((x + 0.5) * w) / W - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(w - 1, x0 + 1);
      const fx = sx - x0;
      const t = src[y0 * w + x0] * (1 - fx) + src[y0 * w + x1] * fx;
      const b = src[y1 * w + x0] * (1 - fx) + src[y1 * w + x1] * fx;
      out[y * W + x] = t * (1 - fy) + b * fy;
    }
  }
  return out;
}
/** the reference as a perfect antialiaser would deliver it AT THE RENDER RESOLUTION, then stretched
 * by the browser: what is left of test-vs-this is aliasing, and this-vs-reference is the softness
 * the pixel count costs */
function resMatched(R, W, H, w, h) {
  const a = areaRows(R, W, H, w); // w × H
  const t = transpose(a, w, H); // H × w (rows of length H)
  const b = areaRows(t, H, w, h); // h columns per row → w rows × h
  const lo = transpose(b, h, w); // w×h, rows of length w
  return bilinearUp(lo, w, h, W, H);
}

function bitmapOf(dataUrl) {
  const img = nativeImage.createFromDataURL(dataUrl);
  const { width, height } = img.getSize();
  return { W: width, H: height, bgra: img.toBitmap() };
}

async function probe(dpr, tier) {
  const win = new BrowserWindow({
    width: CSS_W,
    height: CSS_H,
    show: false,
    useContentSize: true,
    enableLargerThanScreen: true,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  win.webContents.setAudioMuted(true);
  win.setContentSize(CSS_W, CSS_H);
  win.webContents.setFrameRate(15);
  const q = `?tier=${tier}${SET ? `&set=${SET}` : ''}`;
  for (let tries = 0; ; tries++) {
    try {
      await win.loadURL(`http://localhost:${PORT}/${q}`);
      break;
    } catch (e) {
      if (tries >= 3) throw e;
      await sleep(2000);
    }
  }
  win.webContents.enableDeviceEmulation({
    screenPosition: 'desktop',
    screenSize: { width: CSS_W, height: CSS_H },
    viewPosition: { x: 0, y: 0 },
    deviceScaleFactor: dpr,
    viewSize: { width: CSS_W, height: CSS_H },
    scale: 1,
  });
  const js = (s) => win.webContents.executeJavaScript(s);
  for (let i = 0; i < 300 && !(await js('!!window.__aaReady')); i++) await sleep(100);
  // the field GLB, the environment and the first compiles
  await sleep(5000);
  const info = await js('window.__aa.info()');
  const views = (await js('window.__aa.views')).filter((v) => !VIEWS || VIEWS.split(',').includes(v.id));
  const res = { info, views: {} };
  const compositorDiff = [];
  for (const v of views) {
    const frames = v.moving ? MOTION : 1;
    const per = [];
    let prev = null;
    for (let k = 0; k < frames; k++) {
      await js(`window.__aa.setView(${JSON.stringify(v.id)}, ${k})`);
      // the driver eye eases toward its aim: let it land
      await sleep(k === 0 ? 2500 : 700);
      // stop the loop, draw ONE frame, and capture that frame: the reference is drawn through
      // the camera of the last frame drawn, which must be the one on screen
      await js('window.__aa.hold(false)');
      await sleep(150);
      const back = bitmapOf(await js('window.__aa.renderOnce(true)'));
      await sleep(400);
      const img = await win.webContents.capturePage();
      const { width: W, height: H } = img.getSize();
      // ⚠️ THE TEST IMAGE IS THE CANVAS READBACK, stretched to the device size the way the
      // compositor stretches a canvas drawn below its CSS size (bilinear, texel centres aligned).
      // The offscreen capture is exact at DPR 1, but under device emulation at DPR 2 it resamples
      // even a native canvas (a 3840×2160 canvas captured at DPR 2 scored 14 where the same pixels
      // at DPR 1 scored 3.3). At DPR 1 the model is checked against the capture.
      const n0 = W * H;
      const backY = luma(back.bgra, back.W * back.H);
      const T0 = back.W === W && back.H === H ? backY : bilinearUp(backY, back.W, back.H, W, H);
      if (dpr === 1) {
        const capY = luma(img.toBitmap(), n0);
        let d = 0;
        for (let i = 0; i < n0; i++) d += Math.abs(capY[i] - T0[i]);
        compositorDiff.push(+(d / n0).toFixed(3));
      }
      const ref = bitmapOf(await js(`window.__aa.reference(${S})`));
      const cls = bitmapOf(await js('window.__aa.classes()'));
      const refSh = SHADOW ? bitmapOf(await js(`window.__aa.refShadow(${S})`)) : null;
      await js('window.__aa.hold(true)');
      if (ref.W !== W || ref.H !== H) throw new Error(`size mismatch: capture ${W}x${H}, reference ${ref.W}x${ref.H}`);
      const n = W * H;
      const T = T0;
      const R = luma(ref.bgra, n);
      const C = new Uint8Array(n);
      for (let i = 0; i < n; i++) C[i] = cls.bgra[i * 4 + 2];
      const s = score(T, R, C, W, H, prev);
      const [bw, bh] = info.buf;
      if (bw < W * 0.99) {
        // below native: split the error into aliasing at the render resolution and the softness of it
        const Rm = resMatched(R, W, H, bw, bh);
        const a = score(T, Rm, C, W, H, null, R);
        const o = score(Rm, R, C, W, H, null, R);
        s.alias = { E: a.E, J: a.J };
        s.soft = { E: o.E, J: o.J };
      }
      if (refSh) {
        // shadow-map resolution: the frame's map against a 4× map, on the floor's interior only
        const R2 = luma(refSh.bgra, n);
        s.shadowMap = score(R, R2, C, W, H, null).inner.floor ?? null;
      }
      per.push(s);
      prev = { T, R };
      if (SAVE && OUT && k === 0) {
        const tag = `${v.id}-${tier}-dpr${dpr}`;
        const tb = Buffer.alloc(n * 4);
        for (let i = 0; i < n; i++) {
          const v = Math.max(0, Math.min(255, Math.round(T[i])));
          tb[i * 4] = tb[i * 4 + 1] = tb[i * 4 + 2] = v;
          tb[i * 4 + 3] = 255;
        }
        fs.writeFileSync(path.join(OUT, `${tag}-test.png`), nativeImage.createFromBitmap(tb, { width: W, height: H }).toPNG());
        fs.writeFileSync(path.join(OUT, `${tag}-canvas.png`), nativeImage.createFromBitmap(back.bgra, { width: back.W, height: back.H }).toPNG());
        fs.writeFileSync(path.join(OUT, `${tag}-ref.png`), nativeImage.createFromBitmap(ref.bgra, { width: W, height: H }).toPNG());
      }
    }
    res.views[v.id] = frames === 1 ? per[0] : { ...per[0], frames: per.map(({ E, J, F, flatF, flatBig }) => ({ E, J, F, flatF, flatBig })), E: avg(per.map((p) => p.E)), J: avg(per.map((p) => p.J)), F: avg(per.slice(1).map((p) => p.F)) };
  }
  if (arg('card', '0') === '1' && OUT) {
    // the robot card: saved for an offline comparison against its own 4× capture
    const [small, big] = await js(`window.__aa.card(${JSON.stringify(tier)})`);
    fs.writeFileSync(path.join(OUT, `card-${tier}-dpr${dpr}-192.png`), nativeImage.createFromDataURL(small).toPNG());
    fs.writeFileSync(path.join(OUT, `card-${tier}-dpr${dpr}-768.png`), nativeImage.createFromDataURL(big).toPNG());
  }
  if (GPU) {
    await js(`window.__aa.setView('driver', 0)`);
    await sleep(1500);
    res.gpu = await js('window.__aa.hold(false), window.__aa.gpuTime(120)');
    await js('window.__aa.hold(true)');
  }
  res.compositorDiff = compositorDiff;
  win.destroy();
  return res;
}
const avg = (a) => +(a.reduce((s, x) => s + x, 0) / Math.max(1, a.length)).toFixed(3);

// one window per tier, destroyed in between: closing the last one must not quit the run
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const all = {};
  try {
    if (OUT) fs.mkdirSync(OUT, { recursive: true });
    for (const dpr of DPRS) {
      for (const tier of TIERS) {
        const r = await probe(dpr, tier);
        all[`${tier}@${dpr}`] = r;
        const line = Object.entries(r.views)
          .map(([k, v]) => `${k} E${v.E} J${v.J}${v.F !== undefined ? ` F${v.F}` : ''}${v.alias ? ` (alias ${v.alias.E}/soft ${v.soft.E})` : ''}`)
          .join(' | ');
        if (r.compositorDiff.length) console.log(`[aa] DPR-1 capture vs the stretched-readback model (mean |d| luma): ${r.compositorDiff.join(' ')}`);
        console.log(`[aa] ${tier}@dpr${dpr} pr=${r.info.pr.toFixed(2)} buf=${r.info.buf.join('x')} samples=${r.info.samples} :: ${line}${r.gpu ? ` :: gpu p50 ${r.gpu.p50?.toFixed(3)} p95 ${r.gpu.p95?.toFixed(3)} cpu50 ${r.gpu.cpu50?.toFixed(2)}` : ''}`);
      }
    }
    if (OUT) fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(all, null, 1));
  } catch (e) {
    console.error('[aa] failed', e);
  } finally {
    app.quit();
  }
});
