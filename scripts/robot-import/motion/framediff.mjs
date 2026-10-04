// WHAT MOVED between two Play frames (`motioneditor.cjs`): node scripts/robot-import/motion/framediff.mjs a.png b.png out.png
// A minimal PNG reader (8-bit RGB/RGBA, not interlaced) and writer, no dependency: the changed pixels
// painted red over a faded copy of frame a, and their count.
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';

function readPng(file) {
  const b = readFileSync(file);
  let o = 8;
  let w = 0, h = 0, ct = 0;
  const idat = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o);
    const type = b.toString('latin1', o + 4, o + 8);
    const data = b.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      ct = data[9];
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported png');
    } else if (type === 'IDAT') idat.push(data);
    o += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(w * h * bpp);
  const stride = w * bpp;
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let v = src[x];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) {
        const p = a + up - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      out[y * stride + x] = v & 255;
    }
  }
  return { w, h, bpp, px: out };
}

function writePng(file, w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  const table = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (buf) => {
    let c = -1;
    for (const x of buf) c = table[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

const [fa, fb, fo] = process.argv.slice(2);
const A = readPng(fa);
const B = readPng(fb);
const rgb = new Uint8Array(A.w * A.h * 3);
let changed = 0;
for (let i = 0; i < A.w * A.h; i++) {
  let d = 0;
  for (let k = 0; k < 3; k++) d += Math.abs(A.px[i * A.bpp + k] - B.px[i * B.bpp + k]);
  const g = (A.px[i * A.bpp] + A.px[i * A.bpp + 1] + A.px[i * A.bpp + 2]) / 3;
  if (d > 60) {
    changed++;
    rgb[3 * i] = 255;
    rgb[3 * i + 1] = 40;
    rgb[3 * i + 2] = 40;
  } else {
    rgb[3 * i] = rgb[3 * i + 1] = rgb[3 * i + 2] = 80 + g * 0.5;
  }
}
writePng(fo, A.w, A.h, rgb);
console.log(`${fo}: ${changed} pixels changed of ${A.w * A.h}`);
