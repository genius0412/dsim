// Radiance .hdr (RGBE) decoder — no dependencies, so `derive.cjs` runs in Node or Electron as-is.
//
// Reads the header, then every scanline in either the run-length format (the one Poly Haven
// writes) or flat RGBE. Returns linear float RGB, row 0 at the TOP of the image (the zenith of
// an equirectangular panorama) — the file's own order for `-Y h +X w`, the only orientation
// accepted here.
'use strict';

function decodeRgbe(buf) {
  let p = 0;
  const line = () => {
    const s = p;
    while (p < buf.length && buf[p] !== 0x0a) p++;
    const out = buf.toString('latin1', s, p);
    p++;
    return out;
  };
  const magic = line();
  if (!/^#\?(RADIANCE|RGBE)/.test(magic)) throw new Error(`not a Radiance file: ${magic}`);
  let format = '';
  for (;;) {
    const l = line();
    if (l === '') break;
    const m = /^FORMAT=(.*)$/.exec(l);
    if (m) format = m[1];
    if (p >= buf.length) throw new Error('header never ended');
  }
  if (format && format !== '32-bit_rle_rgbe') throw new Error(`unsupported FORMAT=${format}`);
  const res = /^-Y (\d+) \+X (\d+)$/.exec(line());
  if (!res) throw new Error('unsupported orientation (only -Y h +X w)');
  const h = Number(res[1]);
  const w = Number(res[2]);
  const out = new Float32Array(w * h * 3);
  const scan = new Uint8Array(w * 4);
  for (let y = 0; y < h; y++) {
    const rle = w >= 8 && w < 32768 && buf[p] === 2 && buf[p + 1] === 2 && ((buf[p + 2] << 8) | buf[p + 3]) === w;
    if (rle) {
      p += 4;
      for (let c = 0; c < 4; c++) {
        let x = 0;
        while (x < w) {
          let n = buf[p++];
          if (n > 128) {
            n -= 128;
            const v = buf[p++];
            for (let k = 0; k < n; k++) scan[(x++) * 4 + c] = v;
          } else {
            for (let k = 0; k < n; k++) scan[(x++) * 4 + c] = buf[p++];
          }
        }
      }
    } else {
      for (let x = 0; x < w * 4; x++) scan[x] = buf[p++];
    }
    for (let x = 0; x < w; x++) {
      const e = scan[x * 4 + 3];
      const o = (y * w + x) * 3;
      if (e === 0) {
        out[o] = out[o + 1] = out[o + 2] = 0;
        continue;
      }
      // Radiance's own convention: (m + 0.5) · 2^(e − 136)
      const f = Math.pow(2, e - 136);
      out[o] = (scan[x * 4] + 0.5) * f;
      out[o + 1] = (scan[x * 4 + 1] + 0.5) * f;
      out[o + 2] = (scan[x * 4 + 2] + 0.5) * f;
    }
  }
  return { width: w, height: h, data: out };
}

module.exports = { decodeRgbe };

/**
 * Radiance .hdr (RGBE) ENCODER, run-length per channel (the format `decodeRgbe` above and three's
 * `HDRLoader` both read). `data` is linear float RGB, row 0 at the top.
 */
function encodeRgbe(width, height, data) {
  const head = Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`, 'latin1');
  const chunks = [head];
  const scan = new Uint8Array(width * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      const r = data[o], g = data[o + 1], b = data[o + 2];
      const m = Math.max(r, g, b);
      if (!(m > 1e-32)) {
        scan[x * 4] = scan[x * 4 + 1] = scan[x * 4 + 2] = scan[x * 4 + 3] = 0;
        continue;
      }
      // frexp: m = f · 2^e with f in [0.5, 1)
      let e = Math.ceil(Math.log2(m));
      let f = m / Math.pow(2, e);
      if (f >= 1) { f /= 2; e += 1; }
      if (f < 0.5) { f *= 2; e -= 1; }
      const s = 256 / Math.pow(2, e);
      scan[x * 4] = Math.min(255, Math.floor(r * s));
      scan[x * 4 + 1] = Math.min(255, Math.floor(g * s));
      scan[x * 4 + 2] = Math.min(255, Math.floor(b * s));
      scan[x * 4 + 3] = e + 128;
    }
    const line = [2, 2, (width >> 8) & 255, width & 255];
    for (let c = 0; c < 4; c++) {
      // runs of >= 3 equal bytes go as a run, everything else as literals (max 127 / 128 per packet)
      let x = 0;
      while (x < width) {
        let run = 1;
        while (x + run < width && run < 127 && scan[(x + run) * 4 + c] === scan[x * 4 + c]) run++;
        if (run >= 3) {
          line.push(128 + run, scan[x * 4 + c]);
          x += run;
          continue;
        }
        const start = x;
        let n = 0;
        while (x < width && n < 128) {
          let r2 = 1;
          while (x + r2 < width && r2 < 3 && scan[(x + r2) * 4 + c] === scan[x * 4 + c]) r2++;
          if (r2 >= 3) break;
          x++;
          n++;
        }
        line.push(n);
        for (let k = 0; k < n; k++) line.push(scan[(start + k) * 4 + c]);
      }
    }
    chunks.push(Buffer.from(line));
  }
  return Buffer.concat(chunks);
}

module.exports.encodeRgbe = encodeRgbe;
