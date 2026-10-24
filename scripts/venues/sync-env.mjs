// Rewrite each venue's row in `environments.ts` from what the pipeline just wrote — stage 5; the
// RENDER lane checks they agree:
//   - `PHOTO_LAYERS(...)`: the furniture's rows and byte counts (`meshes.py`'s pack.json, `pack.ts`'s
//     room file), and for a venue with a floor step its stage rectangle (`PhotoLayers.floor`: the
//     room's x and y0, y1 the step edge's lowest y);
//   - `room` and `height`: the measured room and lens `layers.py` built it on (its meta.json), so a
//     re-measured room cannot ship with the row still describing the old one;
//   - `PHOTO_FILES(...)`: the backdrop and light map's byte counts (`derive.cjs` rewrites those files);
//   - the picker note's High-tier download (room + furniture textures, meshes and light map).
//
//   node scripts/venues/sync-env.mjs [--only hangar,events-hall]
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENV = join(ROOT, 'src', 'games', 'biobuzz', 'graphics', 'environments.ts');
const n = (x) => String(x).replace(/\B(?=(\d{3})+(?!\d))/g, '_');
const VENUES = ['school-hall', 'events-hall', 'hangar', 'court', 'quad'];
const i = process.argv.indexOf('--only');
const only = i >= 0 ? process.argv[i + 1].split(',') : VENUES;
/** `PHOTO_LENS_IN` in `environments.ts`: a lens equal to it is written as the name */
const LENS_IN = Number(/const PHOTO_LENS_IN = ([\d.]+);/.exec(readFileSync(ENV, 'utf8'))?.[1]);
const size = (f) => statSync(join(ROOT, 'public', 'venues', f)).size;
const obj = (o) => `{ ${Object.entries(o).map(([k, v]) => `${k}: ${Math.round(v * 10) / 10}`).join(', ')} }`;

let src = readFileSync(ENV, 'utf8');
for (const v of only) {
  if (!VENUES.includes(v)) throw new Error(`${v}: not a photographed venue`);
  const dir = join(ROOT, 'scratch', 'venues-layers', v);
  const info = JSON.parse(readFileSync(join(dir, 'pack.json'), 'utf8'));
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  // this venue's row: from its PHOTO_FILES call to its credit block
  const at = src.indexOf(`PHOTO_FILES('${v}',`);
  const end = src.indexOf('PH_CREDIT(', at);
  if (at < 0 || end < 0) throw new Error(`${v}: no PHOTO_FILES … PH_CREDIT row`);
  let row = src.slice(at, end);
  const swap = (re, to, what) => {
    if (!re.test(row)) throw new Error(`${v}: no ${what} in its row`);
    row = row.replace(re, to);
  };

  swap(/PHOTO_FILES\('[^']+',[^)]*\)/, `PHOTO_FILES('${v}', ${n(size(`${v}-4k.webp`))}, ${n(size(`${v}-2k.webp`))}, ${n(size(`${v}-ibl.hdr`))})`, 'PHOTO_FILES');
  swap(/\bheight: [^,]+,/, `height: ${meta.lens === LENS_IN ? 'PHOTO_LENS_IN' : meta.lens},`, 'height');
  swap(/\broom: \{[^}]*\}/, `room: ${obj(meta.room)}`, 'room');
  const mesh = size(`${v}-room.glb`);
  const b = info.bytes;
  const step = meta.floorStep;
  const floor = step ? `, ${obj({ x0: meta.room.x0, x1: meta.room.x1, y0: meta.room.y0, y1: Math.min(...step.edge.map((p) => p[1])) })}` : '';
  swap(
    /PHOTO_LAYERS\(\s*'[^']+',\s*\[[^\]]*\],\s*\{[^}]*\}(?:,\s*\{[^}]*\})?\)/,
    `PHOTO_LAYERS('${v}', [${info.fgRows[0]}, ${info.fgRows[1]}], { bg: ${n(b.bg)}, bgLow: ${n(b.bgLow)}, fg: ${n(b.fg)}, fgLow: ${n(b.fgLow)}, mesh: ${n(mesh)} }${floor})`,
    'PHOTO_LAYERS',
  );
  src = src.slice(0, at) + row + src.slice(end);

  const mb = ((b.bg + b.fg + mesh + size(`${v}-ibl.hdr`)) / 1e6).toFixed(1);
  const note = new RegExp(`(id: '${v}',\\s*name: '[^']*',\\s*note: '[^']*?, )\\d+\\.\\d MB'`);
  if (!note.test(src)) throw new Error(`${v}: no note ending in a size`);
  src = src.replace(note, `$1${mb} MB'`);
}
writeFileSync(ENV, src);
console.log(`environments.ts: ${only.join(', ')} synced (files, room, lens, layers, note)`);
