// THE LIGHT IN A DERIVED `.hdr`, IN THE FIELD'S FRAME — what each photographed venue's `rig` was
// read from (`src/games/biobuzz/graphics/environments.ts`).
//
//   node scripts/venues/fieldlight.cjs public/venues/*-ibl.hdr
//
// Per file: the up-facing irradiance E_up (luminance and colour), the down-facing E_down, the
// luminance-weighted mean direction of the upper hemisphere, and that of its brightest 1 % of
// texels — the KEY, which is where a row's `sun` azimuth and elevation come from (raised to 40°
// where it is lower: the RENDER lane's 25° rule). Directions are field-frame: azimuth CCW from +x,
// the renderer's convention (column u → θ = −2π(u − 0.5), row 0 the zenith).
'use strict';

const fs = require('fs');
const path = require('path');
const { decodeRgbe } = require('./rgbe.cjs');

const lum = (v) => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
const ang = (v) => {
  const n = Math.hypot(...v);
  const az = ((Math.atan2(v[1], v[0]) * 180) / Math.PI + 360) % 360;
  return `az ${az.toFixed(0)} el ${((Math.asin(v[2] / n) * 180) / Math.PI).toFixed(0)}`;
};
const hex = (v) => {
  const m = Math.max(...v);
  return '#' + v.map((c) => Math.round((255 * c) / m).toString(16).padStart(2, '0')).join('');
};

for (const src of process.argv.slice(2)) {
  const { width: W, height: H, data } = decodeRgbe(fs.readFileSync(src));
  // the brightest 1 % of the UPPER hemisphere's texels
  const up = [];
  for (let y = 0; y < H / 2; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3;
      up.push(lum([data[o], data[o + 1], data[o + 2]]));
    }
  }
  const thr = Float32Array.from(up).sort()[Math.floor(up.length * 0.99)];
  const E = [0, 0, 0];
  const Edown = [0, 0, 0];
  const dir = [0, 0, 0];
  const key = [0, 0, 0];
  for (let y = 0; y < H; y++) {
    const el = ((90 - ((y + 0.5) / H) * 180) * Math.PI) / 180;
    const w = Math.cos(el) * (Math.PI / H) * ((2 * Math.PI) / W); // the texel's solid angle
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3;
      const th = -2 * Math.PI * ((x + 0.5) / W - 0.5);
      const rgb = [data[o], data[o + 1], data[o + 2]];
      const L = lum(rgb);
      const d = [Math.cos(el) * Math.cos(th), Math.cos(el) * Math.sin(th), Math.sin(el)];
      if (el > 0) {
        for (let c = 0; c < 3; c++) E[c] += rgb[c] * d[2] * w;
        for (let c = 0; c < 3; c++) dir[c] += L * w * d[c];
        if (L >= thr) for (let c = 0; c < 3; c++) key[c] += L * w * d[c];
      } else {
        for (let c = 0; c < 3; c++) Edown[c] += rgb[c] * -d[2] * w;
      }
    }
  }
  console.log(
    path.basename(src).padEnd(24),
    `E_up ${lum(E).toFixed(3)} ${hex(E)}`,
    `| E_down ${lum(Edown).toFixed(3)} ${hex(Edown)}`,
    `| mean ${ang(dir)}`,
    `| key (1 %) ${ang(key)}`,
  );
}
