// DERIVE THE PHOTOGRAPHED VENUES — every file under `public/venues/`, from Poly Haven's CC0 4k
// `.hdr` of each row in `venues.cjs`. Reproducible: the same source (md5-checked) and this script
// give the same bytes up to the WebP encoder's own version.
//
//   npx electron scripts/venues/derive.cjs [--cache <dir>] [--only <id,id>] [--out <dir>]
//
// (from a Git Bash shell that has ELECTRON_RUN_AS_NODE set, prefix `env -u ELECTRON_RUN_AS_NODE`.)
// Runs under Electron because the WebP encoder is Chromium's (`OffscreenCanvas.convertToBlob`);
// the decode, the curve and the `.hdr` writer are plain Node. Nothing is shown: the one window is
// `show: false` and offscreen. `--cache` (default `scratch/venues-src/`, gitignored) holds the 4k
// sources; a missing one is downloaded and its md5 checked against `venues.cjs`.
//
// ── WHAT IS WRITTEN, PER VENUE ──────────────────────────────────────────────────────────────
//   <id>-4k.webp   4096 × 2048 backdrop, the curve below, sRGB, WebP (High and up)
//   <id>-2k.webp   2048 × 1024, the same (Low and Medium, or a GPU under 4096 px textures)
//   <id>-ibl.hdr   IBL_W × IBL_W/2 Radiance RGBE, linear, box-filtered — the light-gathering map
// all turned by the row's `yaw` (a whole-column shift of the 4k source, so no resampling).
//
// ── ENCODING: WHY THE BACKDROP IS NOT JUST A TONEMAPPED JPEG ────────────────────────────────
// The scene tone-maps once, at its own blit (ACES, per-environment exposure). A backdrop that was
// already tone-mapped would be tone-mapped twice and every lamp and window would come out a flat
// grey. So the file stores LINEAR light through an invertible highlight curve:
//     v = gain · x          e = v / (1 + v)          stored = sRGB(e), 8 bits
// and the shader inverts it (`x = e / (1 − e) / gain`). The curve is near-linear in the shadows
// and mid-tones, where the floor and walls are, and squeezes the highlights instead of clipping
// them: with `gain` putting the floor's median at v ≈ 0.25, the top usable code (v = 110) is
// ~440 × that median, so a lamp is a lamp after the blit. A plain `x / 4` headroom was the other
// candidate: it tops out at 4 (a lamp is flat grey again) and leaves a floor at 0.05–0.3 about 50
// codes.
// It is NOT the light-gathering map: some photographs keep most of their energy in a few very hot
// texels (school hall: clipped where this curve tops out, x = 110 / gain, it keeps 30.4 % of its
// up-facing irradiance; the events hall 89 %, the hangar 99.7 %), which no 8-bit
// file carries — hence the separate small `.hdr`.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, BrowserWindow } = require('electron');
const { decodeRgbe, encodeRgbe } = require('./rgbe.cjs');
const VENUES = require('./venues.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const CACHE = path.resolve(ROOT, opt('cache', 'scratch/venues-src'));
const OUT = path.resolve(ROOT, opt('out', 'public/venues'));
const ONLY = opt('only', '') ? opt('only', '').split(',') : null;
/** the light-gathering map's width. 512 keeps every texel of irradiance the 4k has (a box filter
 * conserves energy) at 1/16 of the 1k file's texels; see the README for the measurement. */
const IBL_W = Number(opt('ibl', '512'));
const PH = (slug) => `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/${slug}_4k.hdr`;

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

async function source(v) {
  const file = path.join(CACHE, `${v.slug}_4k.hdr`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(CACHE, { recursive: true });
    console.log(`downloading ${PH(v.slug)}`);
    const res = await fetch(PH(v.slug));
    if (!res.ok) throw new Error(`${v.slug}: HTTP ${res.status}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  const buf = fs.readFileSync(file);
  const sum = md5(buf);
  if (sum !== v.md5) throw new Error(`${v.slug}: md5 ${sum}, expected ${v.md5} — not the file venues.cjs was tuned on`);
  return buf;
}

/** turn the panorama by `yawDeg` (whole columns): out(u) = in(u + yaw/360) */
function turn(img, yawDeg) {
  const { width: W, height: H, data } = img;
  const shift = ((Math.round((yawDeg / 360) * W) % W) + W) % W;
  if (shift === 0) return img;
  const out = new Float32Array(data.length);
  for (let y = 0; y < H; y++) {
    const row = y * W * 3;
    for (let x = 0; x < W; x++) {
      const s = row + ((x + shift) % W) * 3;
      const d = row + x * 3;
      out[d] = data[s];
      out[d + 1] = data[s + 1];
      out[d + 2] = data[s + 2];
    }
  }
  return { width: W, height: H, data: out };
}

/** box-filter down by an integer factor, in LINEAR light (energy-conserving) */
function shrink(img, f) {
  const { width: W, height: H, data } = img;
  const w = W / f;
  const h = H / f;
  const out = new Float32Array(w * h * 3);
  const n = f * f;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < f; j++) {
        let o = ((y * f + j) * W + x * f) * 3;
        for (let i = 0; i < f; i++, o += 3) {
          r += data[o];
          g += data[o + 1];
          b += data[o + 2];
        }
      }
      const d = (y * w + x) * 3;
      out[d] = r / n;
      out[d + 1] = g / n;
      out[d + 2] = b / n;
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * THE FURNITURE PATCH — a region of the (turned) panorama replaced by the room's MIRROR image.
 *
 * The renderer projects the photograph onto a box (`renderPhotoVenue.ts`), which is exact for the
 * floor and the walls and wrong for anything standing in the room: a chair is drawn where its ray
 * meets the floor, i.e. stretched flat across it. A few metres of chairs beside the capture point
 * (the events hall's banquet table) became a carpet of white streaks behind the field from every
 * camera. So, where `venues.cjs` names a region, it is filled from the same room mirrored across
 * the field's x axis: each pixel's ray is followed to the room box, the hit point is reflected to
 * the other side (y scaled from that side's wall distance to this one's), and the photograph is
 * read along the ray to the reflected point. Floor lands on floor and wall on wall, at the right
 * scale, so the seam is only a change of texture, which the feather hides.
 *
 * `p`: `th` field-frame azimuth range (degrees CCW from +x), `e` elevation range (degrees), `feather`
 * (degrees), `room` the box in LENS HEIGHTS (the lens at z = 1 above the floor): the same box as
 * the environment row's `photo.room`, divided by its `height`.
 *
 * Or `shift: <degrees>` instead of `room`: the region is filled from the same elevations `shift`
 * degrees round — for a small object (the school hall's lectern) whose neighbours at the same
 * distance are the same floor and the same stage edge.
 */
function patchMirror(img, p) {
  const { width: W, height: H, data } = img;
  const src = Float32Array.from(data);
  const r = p.room;
  const f = p.feather;
  const ramp = (x, a, b) => {
    // 0 outside [a, b], 1 inside it by `f`, smooth between
    const t = Math.min(1, Math.max(0, Math.min(x - (a - f), b + f - x) / (2 * f)));
    return t * t * (3 - 2 * t);
  };
  const sample = (u, v, out) => {
    const x = u * W - 0.5;
    const y = Math.min(H - 1.001, Math.max(0, v * H - 0.5));
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    for (let c = 0; c < 3; c++) out[c] = 0;
    for (const [dx, dy, w] of [
      [0, 0, (1 - fx) * (1 - fy)],
      [1, 0, fx * (1 - fy)],
      [0, 1, (1 - fx) * fy],
      [1, 1, fx * fy],
    ]) {
      const o = ((y0 + dy) * W + ((((x0 + dx) % W) + W) % W)) * 3;
      for (let c = 0; c < 3; c++) out[c] += src[o + c] * w;
    }
  };
  const s = [0, 0, 0];
  for (let j = 0; j < H; j++) {
    const e = 90 - ((j + 0.5) / H) * 180;
    const we = ramp(e, p.e[0], p.e[1]);
    if (we <= 0) continue;
    const ce = Math.cos((e * Math.PI) / 180);
    const dz = Math.sin((e * Math.PI) / 180);
    for (let i = 0; i < W; i++) {
      // this column's field-frame azimuth: u = 0.5 − θ/360 (the renderer's convention)
      let th = (0.5 - (i + 0.5) / W) * 360;
      if (th < -180) th += 360;
      const w = we * ramp(th, p.th[0], p.th[1]);
      if (w <= 0) continue;
      if (p.shift !== undefined) {
        let u = 0.5 - (th + p.shift) / 360;
        u -= Math.floor(u);
        sample(u, (j + 0.5) / H, s);
        const o = (j * W + i) * 3;
        for (let c = 0; c < 3; c++) data[o + c] = data[o + c] * (1 - w) + s[c] * w;
        continue;
      }
      const dx = ce * Math.cos((th * Math.PI) / 180);
      const dy = ce * Math.sin((th * Math.PI) / 180);
      // the ray from the lens (0, 0, 1) to the room box
      let t = Infinity;
      if (dx > 1e-9) t = Math.min(t, r.x1 / dx);
      if (dx < -1e-9) t = Math.min(t, r.x0 / dx);
      if (dy > 1e-9) t = Math.min(t, r.y1 / dy);
      if (dy < -1e-9) t = Math.min(t, r.y0 / dy);
      if (dz < -1e-9) t = Math.min(t, -1 / dz);
      if (dz > 1e-9) t = Math.min(t, (r.ceil - 1) / dz);
      const px = dx * t;
      const py = dy * t;
      const pz = 1 + dz * t;
      // reflected across the x axis, y rescaled onto the other side's wall
      const qy = py > 0 ? (py * r.y0) / r.y1 : (py * r.y1) / r.y0;
      const qz = pz - 1;
      const qh = Math.hypot(px, qy);
      const th2 = Math.atan2(qy, px);
      const e2 = Math.atan2(qz, qh);
      let u = 0.5 - th2 / (2 * Math.PI);
      u -= Math.floor(u);
      const v = 0.5 - e2 / Math.PI;
      sample(u, v, s);
      const o = (j * W + i) * 3;
      for (let c = 0; c < 3; c++) data[o + c] = data[o + c] * (1 - w) + s[c] * w;
    }
  }
}

/**
 * THE FLOOR DE-GLOSS — a glossy floor's reflections of the windows, flattened.
 *
 * A reflection is not ON the floor: it moves with the eye. Seen from the lens it lies along the
 * line toward the window, so projected onto the floor every reflection becomes a streak pointing
 * at the capture point — from the overhead camera the events hall's polished concrete was a white
 * sunburst round the field (measured: streaks at 2–4 × the floor's own level). A sunlit patch is
 * different and is kept: it IS on the floor (the hangar's window light).
 *
 * Per row of the floor band, `F` is the median of the BLURRED luminance (the floor's own level at
 * that distance); wherever the blurred luminance `Lb` rises past `F × above`, the pixel is scaled
 * so the excess keeps `1 − strength` of itself. The scale is a function of the blurred level only,
 * so the concrete's grain, cracks and stains under a reflection keep their contrast.
 *
 * `g`: `e` the elevation band (degrees, below the horizon), `blur` the radius in degrees, `above`,
 * `strength`, and `pct` (optional, default the median): the percentile of the blurred row taken as
 * the floor's own level. Where the reflections cover a large share of a row (the events hall's run
 * of windows: nearly half of it at 15° below the horizon) the median is raised by them and lets
 * them through; a lower percentile is the clean concrete.
 */
function degloss(img, g) {
  const { width: W, height: H, data } = img;
  const row0 = Math.max(0, Math.floor(((90 - g.e[1]) / 180) * H));
  const row1 = Math.min(H, Math.ceil(((90 - g.e[0]) / 180) * H));
  const R = Math.max(1, Math.round((g.blur / 360) * W));
  // luminance of the band plus a margin of R rows, then a separable box blur (wrapping in x)
  const y0 = Math.max(0, row0 - R);
  const y1 = Math.min(H, row1 + R);
  const n = y1 - y0;
  const lum = new Float32Array(W * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < W; x++) {
      const o = ((y0 + y) * W + x) * 3;
      lum[y * W + x] = 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
    }
  }
  const tmp = new Float32Array(W * n);
  for (let y = 0; y < n; y++) {
    let acc = 0;
    for (let k = -R; k <= R; k++) acc += lum[y * W + ((k + W) % W)];
    for (let x = 0; x < W; x++) {
      tmp[y * W + x] = acc / (2 * R + 1);
      acc += lum[y * W + ((x + R + 1) % W)] - lum[y * W + ((x - R + W) % W)];
    }
  }
  const blur = new Float32Array(W * n);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < n; y++) {
      let acc = 0;
      let c = 0;
      for (let k = Math.max(0, y - R); k <= Math.min(n - 1, y + R); k++) {
        acc += tmp[k * W + x];
        c++;
      }
      blur[y * W + x] = acc / c;
    }
  }
  for (let y = row0; y < row1; y++) {
    const by = y - y0;
    const row = Array.from(blur.subarray(by * W, by * W + W)).sort((a, b) => a - b);
    const T = row[g.pct === undefined ? row.length >> 1 : Math.floor((row.length - 1) * g.pct)] * g.above;
    for (let x = 0; x < W; x++) {
      const Lb = blur[by * W + x];
      if (!(Lb > T)) continue;
      const s = (T + (Lb - T) * (1 - g.strength)) / Lb;
      const o = (y * W + x) * 3;
      data[o] *= s;
      data[o + 1] *= s;
      data[o + 2] *= s;
    }
  }
}

const srgb = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

/** a deterministic 0–1 hash, for the dither: the same file on every machine */
function hash01(i) {
  let t = (i * 0x9e3779b1) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** linear → the stored 8-bit RGBA (see ENCODING). A ±½-code triangular dither breaks the bands a
 * smooth floor gradient would otherwise show at 8 bits. */
function encodeDisplay(img, gain) {
  const { width: W, height: H, data } = img;
  const out = Buffer.alloc(W * H * 4);
  for (let i = 0, n = W * H; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const v = Math.max(0, data[i * 3 + c]) * gain;
      const e = v / (1 + v);
      const dither = hash01(i * 3 + c) - hash01(i * 3 + c + 0x51ed27);
      out[i * 4 + c] = Math.max(0, Math.min(255, Math.round(srgb(e) * 255 + dither * 0.5)));
    }
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** WebP through Chromium's own encoder, in a hidden page. */
async function webp(win, rgba, w, h, quality, file) {
  const tmp = path.join(CACHE, `.rgba-${process.pid}.raw`);
  fs.writeFileSync(tmp, rgba);
  const bytes = await win.webContents.executeJavaScript(`(async () => {
    const fs = require('fs');
    const raw = fs.readFileSync(${JSON.stringify(tmp)});
    const img = new ImageData(new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.length), ${w}, ${h});
    const cv = new OffscreenCanvas(${w}, ${h});
    cv.getContext('2d').putImageData(img, 0, 0);
    const blob = await cv.convertToBlob({ type: 'image/webp', quality: ${quality} });
    if (blob.type !== 'image/webp') throw new Error('this Chromium cannot encode WebP: ' + blob.type);
    const buf = Buffer.from(await blob.arrayBuffer());
    fs.writeFileSync(${JSON.stringify(file)}, buf);
    return buf.length;
  })()`);
  fs.unlinkSync(tmp);
  return bytes;
}

function readme(rows) {
  const lines = [
    '# Photographed venues (BIOBUZZ 3D)',
    '',
    'DERIVED files, not the photographs as published: each is built from the Poly Haven 4k `.hdr`',
    'named below by `scripts/venues/derive.cjs`, which checks the source md5 first. Rebuild with',
    '',
    '    npx electron scripts/venues/derive.cjs',
    '',
    '(`env -u ELECTRON_RUN_AS_NODE` first in a shell that sets it). Per venue:',
    '',
    '- `<id>-4k.webp`, `<id>-2k.webp` — the backdrop: linear light through `e = v / (1 + v)`,',
    '  `v = gain × x`, stored sRGB; the renderer inverts it before its own tone mapping. Turned by',
    '  `yaw` degrees so the room lines up with the field.',
    `- \`<id>-ibl.hdr\` — the light-gathering map: ${IBL_W} × ${IBL_W / 2} RGBE, linear, box-filtered from the 4k`,
    '  (energy-conserving), same turn.',
    '',
    'Same origin on purpose: a Discord Activity\'s CSP refuses `dl.polyhaven.org`, and these load',
    'there like any other file of the site.',
    '',
    'All sources are CC0 1.0 (https://polyhaven.com/license); credit is given anyway, on the',
    'Contributors page (built from `src/games/biobuzz/graphics/environments.ts`) and here.',
    '',
    '| id | source | 4k .hdr md5 | authors | yaw | gain | WebP q | clean-up | 4k | 2k | ibl |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    const authors = Object.entries(r.v.authors).map(([n, role]) => `${n} (${role})`).join(', ');
    // the furniture patches and the de-gloss, as `venues.cjs` states them
    const clean = [
      ...(r.v.patches ?? []).map((p) =>
        p.shift !== undefined
          ? `patch θ ${p.th[0]}…${p.th[1]}°, e ${p.e[0]}…${p.e[1]}° from ${p.shift}° round`
          : `patch θ ${p.th[0]}…${p.th[1]}°, e ${p.e[0]}…${p.e[1]}° from the room's mirror`,
      ),
      ...(r.v.degloss ? [`de-gloss e ${r.v.degloss.e[0]}…${r.v.degloss.e[1]}°`] : []),
    ].join('; ') || '—';
    lines.push(
      `| ${r.v.id} | [${r.v.slug}](https://polyhaven.com/a/${r.v.slug}) (${PH(r.v.slug)}) | \`${r.v.md5}\` | ${authors} | ${r.v.yaw} | ${r.v.gain} | ${r.v.quality} | ${clean} | ${r.b4} | ${r.b2} | ${r.bi} |`,
    );
  }
  lines.push('', 'Sizes are bytes.', '');
  return lines.join('\n');
}

app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  let code = 0;
  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, nodeIntegration: true, contextIsolation: false, sandbox: false },
  });
  try {
    await win.loadURL('data:text/html,<!doctype html><title>derive</title>');
    fs.mkdirSync(OUT, { recursive: true });
    const rows = [];
    for (const v of VENUES) {
      const prior = ONLY && !ONLY.includes(v.id);
      if (prior) continue;
      const t0 = Date.now();
      const img = turn(decodeRgbe(await source(v)), v.yaw);
      if (img.width !== 4096 || img.height !== 2048) throw new Error(`${v.slug}: ${img.width}×${img.height}, expected 4096×2048`);
      for (const p of v.patches ?? []) patchMirror(img, p);
      if (v.degloss) degloss(img, v.degloss);
      const b4 = await webp(win, encodeDisplay(img, v.gain), 4096, 2048, v.quality, path.join(OUT, `${v.id}-4k.webp`));
      const half = shrink(img, 2);
      const b2 = await webp(win, encodeDisplay(half, v.gain), 2048, 1024, v.quality, path.join(OUT, `${v.id}-2k.webp`));
      const ibl = shrink(img, 4096 / IBL_W);
      const hdr = encodeRgbe(ibl.width, ibl.height, ibl.data);
      fs.writeFileSync(path.join(OUT, `${v.id}-ibl.hdr`), hdr);
      rows.push({ v, b4, b2, bi: hdr.length });
      console.log(`${v.id.padEnd(12)} 4k ${b4}  2k ${b2}  ibl ${hdr.length}  (${Date.now() - t0} ms)`);
    }
    if (!ONLY) fs.writeFileSync(path.join(OUT, 'README.md'), readme(rows));
  } catch (err) {
    console.error(err);
    code = 1;
  }
  win.destroy();
  app.exit(code);
});
