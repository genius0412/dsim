// Rewrite each venue's `PHOTO_LAYERS(...)` rows and byte counts in `environments.ts` from what
// `meshes.py` and `pack.ts` just wrote, and the picker note's High-tier download (room + furniture
// textures, meshes and light-gathering map) — stage 5; the RENDER lane checks they agree.
//
//   node scripts/venues/sync-env.mjs
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENV = join(ROOT, 'src', 'games', 'biobuzz', 'graphics', 'environments.ts');
const n = (x) => String(x).replace(/\B(?=(\d{3})+(?!\d))/g, '_');

let src = readFileSync(ENV, 'utf8');
for (const v of ['school-hall', 'events-hall', 'hangar', 'court', 'quad']) {
  const info = JSON.parse(readFileSync(join(ROOT, 'scratch', 'venues-layers', v, 'pack.json'), 'utf8'));
  const mesh = statSync(join(ROOT, 'public', 'venues', `${v}-room.glb`)).size;
  const b = info.bytes;
  const re = new RegExp(`PHOTO_LAYERS\\(\\s*'${v}',\\s*\\[[^\\]]*\\],\\s*\\{[^}]*\\}`);
  if (!re.test(src)) throw new Error(`${v}: no PHOTO_LAYERS call`);
  src = src.replace(
    re,
    `PHOTO_LAYERS('${v}', [${info.fgRows[0]}, ${info.fgRows[1]}], { bg: ${n(b.bg)}, bgLow: ${n(b.bgLow)}, fg: ${n(b.fg)}, fgLow: ${n(b.fgLow)}, mesh: ${n(mesh)} }`,
  );
  const ibl = statSync(join(ROOT, 'public', 'venues', `${v}-ibl.hdr`)).size;
  const mb = ((b.bg + b.fg + mesh + ibl) / 1e6).toFixed(1);
  const note = new RegExp(`(id: '${v}',\\s*name: '[^']*',\\s*note: '[^']*?, )\\d+\\.\\d MB'`);
  if (!note.test(src)) throw new Error(`${v}: no note ending in a size`);
  src = src.replace(note, `$1${mb} MB'`);
}
writeFileSync(ENV, src);
console.log('environments.ts: layer rows and sizes synced');
