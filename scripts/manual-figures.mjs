#!/usr/bin/env node
/**
 * manual-figures.mjs — pull the FIGURES out of an FTC game manual, with page numbers.
 *
 *   node scripts/manual-figures.mjs [pdf] [outdir]
 *   node scripts/manual-figures.mjs --pages 61-63          # just Section 9 (ARENA)
 *   node scripts/manual-figures.mjs --min 400              # skip logos and icons
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * The field geometry in `docs/decode-reference.md` was not read out of the manual's prose,
 * because the prose does not contain it. It was PIXEL-MEASURED off the Section 9 figures: pull
 * the drawing out as an image, measure a known dimension in pixels, and every other dimension
 * on that drawing follows from the ratio. That is how DECODE got a 26.5 in goal face and an
 * 18.3 in goal depth out of a PDF that states neither.
 *
 * So a figure extractor is not a convenience here, it is the measuring instrument, and on this
 * machine there was none: `pdfimages` and `pdftoppm` are separate poppler binaries and the
 * MSYS/mingw build on PATH ships `pdftotext` ALONE (`scripts/manual.mjs` says so and skips
 * figures). Installing poppler on kickoff morning is not a plan. Node's own `zlib` is all an
 * embedded image actually needs, so this decodes them directly.
 *
 * ── WHAT IT DOES AND DOES NOT HANDLE ───────────────────────────────────────
 * HANDLES: `DCTDecode` (JPEG — written out verbatim, since the embedded bytes ARE a JPEG
 * file), and `FlateDecode` raster in DeviceRGB / DeviceGray / Indexed at 1 or 8 bits per
 * component, re-encoded as PNG. That covers every image in the V0 manual and every figure in
 * the DECODE and Chain Reaction manuals.
 *
 * DOES NOT HANDLE, and says so per image rather than failing: `JPXDecode` (JPEG 2000),
 * `CCITTFaxDecode`, and CMYK. None has appeared in an FTC manual; if one does, the line in the
 * index names the filter, which is the thing you would need to know.
 *
 * ⚠️ DOES NOT RENDER PAGES. An image XObject is a RASTER that was placed into the page. A
 * figure drawn as VECTOR line art — lines and text in the content stream — is not an image
 * object at all and nothing here will find it, because there is nothing to find. FTC's field
 * drawings have historically been placed raster exports of CAD views, which is why this works,
 * but the check is one command: if a page you can see a drawing on produces no figure, that
 * drawing is vector. The fallback for that case is a screenshot of the PDF at high zoom, and
 * it is recorded in `docs/biobuzz/HANDOFF-field.md` rather than pretended away here.
 *
 * ── PAGE ATTRIBUTION ───────────────────────────────────────────────────────
 * Each figure is named `p<page>-<obj>-<w>x<h>.<ext>`, where `<page>` is the 1-based PDF page
 * the image is placed on — the same index `scripts/manual.mjs` prints in its section table, so
 * "Section 9 starts on page 61" and "figure on page 61" line up without arithmetic. That
 * matters because a reference doc has to CITE, and "measured off the figure on p.61" is a
 * claim the next person can check.
 *
 * Attribution works by reading each `/Type /Page` object's `/Resources /XObject` dictionary.
 * PDF 1.5+ can hide objects inside compressed object streams, which would break this — but
 * page dictionaries in these manuals are plain objects (93 of them in V0, matching the page
 * count), and an image XObject can NEVER be in an object stream because object streams cannot
 * contain streams. A figure that fails to map is still written, as `pXX`, rather than dropped.
 *
 * Node stdlib only — this has to work on a fresh clone with no install.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

const DEFAULT_DIR = 'scratch/manual';

// ─────────────────────────────────────────────────────────────────────────────
// ARGUMENTS
// ─────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) {
    const v = argv[i + 1];
    argv.splice(i, 2);
    return v;
  }
  return fallback;
}

/** `--pages 61-63`, `--pages 61`, or `--pages 61,70-72`. Empty means every page. */
const pageSpec = flag('pages');
/** `--min 400` skips anything whose larger edge is under 400px — logos, icons, rule bullets. */
const minEdge = Number(flag('min', '0'));

const wantPage = (() => {
  if (!pageSpec) return () => true;
  const ranges = pageSpec.split(',').map((part) => {
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(part.trim());
    if (m) return [Number(m[1]), Number(m[2])];
    const n = Number(part.trim());
    return [n, n];
  });
  return (p) => ranges.some(([a, b]) => p >= a && p <= b);
})();

/** the newest `.pdf` in `scratch/manual/`, so the common case takes no arguments at all. */
function newestPdf(dir) {
  if (!existsSync(dir)) return null;
  const pdfs = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.pdf'));
  if (pdfs.length === 0) return null;
  return join(dir, pdfs.sort()[pdfs.length - 1]);
}

const pdfPath = resolve(argv[0] ?? newestPdf(DEFAULT_DIR) ?? '');
if (!pdfPath || !existsSync(pdfPath)) {
  console.error('No PDF. Run `node scripts/manual.mjs` first, or pass a path.');
  console.error('  node scripts/manual-figures.mjs [pdf] [outdir] [--pages 61-63] [--min 400]');
  process.exit(1);
}
const outdir = resolve(argv[1] ?? join(DEFAULT_DIR, 'figures'));
mkdirSync(outdir, { recursive: true });

// ─────────────────────────────────────────────────────────────────────────────
// PDF OBJECT SCANNING
// ─────────────────────────────────────────────────────────────────────────────

const buf = readFileSync(pdfPath);
/**
 * The whole file as `latin1`, which is a BYTE-PRESERVING round trip in Node — one char per
 * byte, no UTF-8 decoding to corrupt a binary stream. Offsets into this string are therefore
 * offsets into `buf`, which is what lets the dictionary be parsed as text while the stream is
 * sliced out of the Buffer.
 */
const src = buf.toString('latin1');

/** every `N 0 obj … endobj` in the file, as `{ num, start, end, body }`. */
function scanObjects() {
  const out = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(src))) {
    const num = Number(m[1]);
    const start = m.index + m[0].length;
    const end = src.indexOf('endobj', start);
    if (end < 0) continue;
    // A later generation of the same object number supersedes an earlier one (an incremental
    // update appends rather than rewrites), and the file is scanned front to back, so simply
    // overwriting gives the last definition — which is the live one.
    out.set(num, { num, start, end, body: src.slice(start, Math.min(end, start + 4096)) });
  }
  return out;
}

const objects = scanObjects();

/** the raw bytes between `stream` and `endstream` for an object, or null. */
function streamOf(obj) {
  const s = src.indexOf('stream', obj.start);
  if (s < 0 || s > obj.end) return null;
  // the keyword is followed by CRLF or LF, and NOTHING else may be skipped — a leading byte
  // eaten here shifts every sample in the image.
  let p = s + 'stream'.length;
  if (src[p] === '\r') p++;
  if (src[p] === '\n') p++;
  let e = src.indexOf('endstream', p);
  if (e < 0) return null;
  // trim the EOL the writer put before `endstream`; it is delimiter, not data.
  let q = e;
  if (src[q - 1] === '\n') q--;
  if (src[q - 1] === '\r') q--;
  return buf.subarray(p, q);
}

/** `/Key 123` or `/Key /Name` or `/Key 12 0 R` — the flat lookups an image dict needs. */
function dictNum(body, key) {
  const m = new RegExp(`/${key}\\s+(\\d+(?:\\.\\d+)?)`).exec(body);
  return m ? Number(m[1]) : null;
}
function dictName(body, key) {
  const m = new RegExp(`/${key}\\s*/([A-Za-z0-9]+)`).exec(body);
  return m ? m[1] : null;
}
function dictRef(body, key) {
  const m = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(body);
  return m ? Number(m[1]) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE → IMAGE ATTRIBUTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map image object number → 1-based page number.
 *
 * Pages are taken in FILE ORDER rather than by walking `/Kids`, because the page tree's
 * intermediate nodes are exactly the objects a PDF 1.5+ writer is most likely to pack into a
 * compressed object stream, while the leaves are not. File order matches page order in every
 * FTC manual checked, and the page COUNT is printed so a mismatch against `manual.mjs` is
 * visible rather than silent.
 */
function pageOfImage() {
  const pageObjs = [];
  for (const obj of objects.values()) {
    if (/\/Type\s*\/Page(?![a-zA-Z])/.test(obj.body)) pageObjs.push(obj);
  }
  pageObjs.sort((a, b) => a.start - b.start);

  const map = new Map();
  pageObjs.forEach((page, i) => {
    const pageNo = i + 1;
    // /Resources may be inline in the page dict or an indirect reference to its own object.
    let res = page.body;
    const resRef = dictRef(page.body, 'Resources');
    if (resRef != null && objects.has(resRef)) res = objects.get(resRef).body;
    // /XObject likewise.
    let xo = null;
    const xoRef = dictRef(res, 'XObject');
    if (xoRef != null && objects.has(xoRef)) {
      xo = objects.get(xoRef).body;
    } else {
      const m = /\/XObject\s*<<([\s\S]*?)>>/.exec(res);
      if (m) xo = m[1];
    }
    if (!xo) return;
    for (const ref of xo.matchAll(/\/[A-Za-z0-9.]+\s+(\d+)\s+\d+\s+R/g)) {
      const num = Number(ref[1]);
      if (!map.has(num)) map.set(num, pageNo);
    }
  });
  return { map, pageCount: pageObjs.length };
}

const { map: imagePage, pageCount } = pageOfImage();

/**
 * Objects that are some other image's `/SMask` — the ALPHA CHANNEL, not a figure.
 *
 * A transparent PNG placed in InDesign arrives as two image objects: the colour, and a
 * same-sized greyscale mask. Writing both doubled the output and put a black-and-white ghost
 * of every figure next to it, with no page attribution (a mask is referenced by the image, not
 * by the page, so `pageOfImage` never sees it — those were the `pXX` rows). They are skipped
 * rather than merged: the alpha of a field drawing carries no measurement, and compositing it
 * onto white would change pixels that are about to be measured.
 */
const maskObjects = new Set();
for (const obj of objects.values()) {
  if (!/\/Subtype\s*\/Image/.test(obj.body)) continue;
  for (const key of ['SMask', 'Mask']) {
    const ref = dictRef(obj.body, key);
    if (ref != null) maskObjects.add(ref);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PNG ENCODING — stdlib only
// ─────────────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes) {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * `raw` is tightly packed samples, `channels` per pixel at 8 bits. PNG wants a FILTER BYTE in
 * front of every scanline; 0 (None) is correct and costs one byte a row, and the deflate pass
 * that follows recovers far more than that.
 */
function encodePng(width, height, channels, raw) {
  const stride = width * channels;
  const withFilter = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    withFilter[y * (stride + 1)] = 0;
    raw.copy(withFilter, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 1 ? 0 : 2; // colour type: 0 grey, 2 truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(withFilter, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// COLOUR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve `/ColorSpace` to `{ kind, channels, palette? }`.
 *
 * `/Indexed` is the one that needs work: the image's samples are INDICES into a palette, so
 * the palette has to be found (it is either a hex/literal string in the dict or its own
 * stream object) and every sample expanded to RGB. Scanned line art is very often indexed,
 * and treating an index as a grey level produces a recognisable but WRONG picture — which is
 * the worst failure available to a measuring instrument, so it is handled rather than skipped.
 */
function colorSpaceOf(body) {
  // `/ColorSpace 42 0 R` — the array lives in its own object. Resolving it matters: an
  // unresolved Indexed space fell through to "DeviceRGB" on the strength of the word appearing
  // inside the array, and then read one-byte-per-pixel index data as three-byte RGB.
  const csRef = dictRef(body, 'ColorSpace');
  if (csRef != null && objects.has(csRef)) {
    const target = objects.get(csRef);
    const full = src.slice(target.start, target.end);
    return colorSpaceOf(`/ColorSpace ${full}`);
  }
  const idx = /\/ColorSpace\s*\[\s*\/(?:I|Indexed)\s*\/(DeviceRGB|DeviceGray)\s+(\d+)\s+([\s\S]*?)\]/.exec(body);
  if (idx) {
    const base = idx[1];
    const baseCh = base === 'DeviceRGB' ? 3 : 1;
    const tail = idx[3].trim();
    let palette = null;
    const refM = /^(\d+)\s+\d+\s+R$/.exec(tail);
    if (refM && objects.has(Number(refM[1]))) {
      const s = streamOf(objects.get(Number(refM[1])));
      if (s) palette = decodeStream(objects.get(Number(refM[1])).body, s);
    } else if (tail.startsWith('<')) {
      const hex = tail.replace(/[<>\s]/g, '');
      palette = Buffer.from(hex, 'hex');
    }
    if (palette) return { kind: 'indexed', channels: 1, baseCh, palette };
  }
  const direct = dictName(body, 'ColorSpace');
  if (direct === 'DeviceRGB') return { kind: 'rgb', channels: 3 };
  if (direct === 'DeviceGray') return { kind: 'gray', channels: 1 };
  if (direct === 'DeviceCMYK') return { kind: 'cmyk', channels: 4 };
  // an indirect ColorSpace we did not resolve: guess from the data size later
  return { kind: 'unknown', channels: 0 };
}

/** apply the object's `/Filter` chain to its stream bytes (Flate only; JPEG is passed through). */
function decodeStream(body, bytes) {
  if (/\/FlateDecode/.test(body)) {
    try {
      return inflateSync(bytes);
    } catch {
      return null;
    }
  }
  return bytes;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXTRACT
// ─────────────────────────────────────────────────────────────────────────────

const rows = [];
let written = 0;
let skipped = 0;

for (const obj of [...objects.values()].sort((a, b) => a.start - b.start)) {
  if (!/\/Subtype\s*\/Image/.test(obj.body)) continue;
  if (maskObjects.has(obj.num)) continue; // an alpha channel, not a figure — see above
  const width = dictNum(obj.body, 'Width');
  const height = dictNum(obj.body, 'Height');
  if (!width || !height) continue;

  const page = imagePage.get(obj.num) ?? null;
  const bigEdge = Math.max(width, height);
  const note = (why) => {
    rows.push({ page, obj: obj.num, width, height, file: '', note: why });
    skipped++;
  };

  if (page != null && !wantPage(page)) continue;
  if (bigEdge < minEdge) continue;

  const bytes = streamOf(obj);
  if (!bytes) {
    note('no stream');
    continue;
  }

  const pTag = page == null ? 'pXX' : `p${String(page).padStart(2, '0')}`;
  const stem = `${pTag}-obj${obj.num}-${width}x${height}`;

  // JPEG: the embedded bytes are a complete JPEG file. Writing them verbatim is not a
  // shortcut, it is the lossless option — re-encoding would add artifacts to the thing being
  // measured.
  if (/\/DCTDecode/.test(obj.body)) {
    writeFileSync(join(outdir, `${stem}.jpg`), bytes);
    rows.push({ page, obj: obj.num, width, height, file: `${stem}.jpg`, note: 'JPEG verbatim' });
    written++;
    continue;
  }
  if (/\/JPXDecode|\/CCITTFaxDecode/.test(obj.body)) {
    note(`unsupported filter ${/\/JPXDecode/.test(obj.body) ? 'JPXDecode' : 'CCITTFaxDecode'}`);
    continue;
  }

  const raw = decodeStream(obj.body, bytes);
  if (!raw) {
    note('inflate failed');
    continue;
  }

  const bpc = dictNum(obj.body, 'BitsPerComponent') ?? 8;
  const cs = colorSpaceOf(obj.body);

  // 1-bit bilevel — scanned line art. Expand to 8-bit grey; PDF 1 means WHITE for DeviceGray.
  if (bpc === 1) {
    const rowBytes = Math.ceil(width / 8);
    const out = Buffer.alloc(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const byte = raw[y * rowBytes + (x >> 3)] ?? 0;
        const bit = (byte >> (7 - (x & 7))) & 1;
        out[y * width + x] = bit ? 255 : 0;
      }
    }
    writeFileSync(join(outdir, `${stem}.png`), encodePng(width, height, 1, out));
    rows.push({ page, obj: obj.num, width, height, file: `${stem}.png`, note: '1bpc → grey' });
    written++;
    continue;
  }

  if (bpc !== 8) {
    note(`${bpc} bits per component`);
    continue;
  }

  let channels = cs.channels;
  let pixels = raw;

  if (cs.kind === 'indexed') {
    const out = Buffer.alloc(width * height * cs.baseCh);
    for (let i = 0; i < width * height; i++) {
      const idxv = raw[i] ?? 0;
      for (let c = 0; c < cs.baseCh; c++) out[i * cs.baseCh + c] = cs.palette[idxv * cs.baseCh + c] ?? 0;
    }
    pixels = out;
    channels = cs.baseCh;
  } else if (cs.kind === 'cmyk') {
    note('CMYK (not converted)');
    continue;
  } else if (cs.kind === 'unknown') {
    // Infer from the byte count — the only honest options are 1 and 3 channels, and the data
    // length decides between them unambiguously.
    const per = raw.length / (width * height);
    if (Math.round(per) === 3) channels = 3;
    else if (Math.round(per) === 1) channels = 1;
    else {
      note(`unresolved colour space (${per.toFixed(2)} bytes/px)`);
      continue;
    }
  }

  // THE DATA OUTRANKS THE DICTIONARY. If the byte count does not match the colour space we
  // resolved, the resolution was wrong — and the byte count cannot be. Recomputing from it
  // recovers the case where an Indexed space named its BASE as DeviceRGB somewhere this parser
  // read as the image's own space: one byte per pixel of index data, declared as three.
  if (cs.kind !== 'indexed' && raw.length !== width * height * channels) {
    const per = raw.length / (width * height);
    if (Math.abs(per - 3) < 0.01) channels = 3;
    else if (Math.abs(per - 1) < 0.01) channels = 1;
    else {
      note(`data does not fit (${raw.length} bytes, ${per.toFixed(2)}/px, declared ${channels}ch)`);
      continue;
    }
  }
  // `pixels`, not `raw` — an Indexed image has already been expanded from one index byte per
  // pixel to `baseCh` colour bytes, and measuring the index data against the expanded channel
  // count rejects every indexed figure in the manual for being exactly a third too small.
  if (pixels.length < width * height * channels) {
    note(`short data (${pixels.length} < ${width * height * channels})`);
    continue;
  }
  writeFileSync(join(outdir, `${stem}.png`), encodePng(width, height, channels, pixels));
  rows.push({
    page,
    obj: obj.num,
    width,
    height,
    file: `${stem}.png`,
    note: channels === 3 ? 'RGB' : 'grey',
  });
  written++;
}

// ─────────────────────────────────────────────────────────────────────────────
// INDEX
// ─────────────────────────────────────────────────────────────────────────────

rows.sort((a, b) => (a.page ?? 999) - (b.page ?? 999) || a.obj - b.obj);

const lines = [
  `# Figures — ${basename(pdfPath)}`,
  '',
  `${written} written, ${skipped} skipped, from ${pageCount} pages.`,
  'Page numbers are 1-based PDF pages — the same index `scripts/manual.mjs` prints beside each',
  'section, so a citation can name one without arithmetic.',
  '',
  '| page | object | pixels | file | note |',
  '|---:|---:|---|---|---|',
  ...rows.map(
    (r) =>
      `| ${r.page ?? '?'} | ${r.obj} | ${r.width}×${r.height} | ${r.file || '—'} | ${r.note} |`,
  ),
  '',
  '## Measuring a field drawing',
  '',
  'Open the figure, find ONE dimension the manual states in words or in a callout, measure it',
  'in pixels, and every other dimension on the same drawing follows from that ratio. Check the',
  'result against a second known dimension before trusting it — a drawing that is not to scale',
  'fails that check immediately, and a drawing that is to scale costs one extra measurement.',
  '',
  'Record the page, the reference dimension and the pixel counts in `docs/biobuzz-reference.md`',
  'so the number can be re-derived rather than re-guessed.',
];
writeFileSync(join(outdir, 'index.md'), lines.join('\n') + '\n');

console.log(`${basename(pdfPath)}: ${pageCount} pages`);
console.log(`  ${written} figures → ${outdir}`);
if (skipped) console.log(`  ${skipped} skipped (see index.md)`);
console.log(`  ${join(outdir, 'index.md')}`);
if (written === 0) {
  console.log('');
  console.log('  No raster figures found. If you can SEE a drawing in the PDF, it is vector');
  console.log('  line art — nothing here can extract it. Screenshot it at high zoom instead.');
}
