/**
 * RESCALE A VENUE'S ROOM FILE TO A RE-MEASURED LENS HEIGHT — run after `pack.ts` (see
 * `scripts/venues/README.md`), when a venue's lens is measured again and the GPU stages are not.
 *
 * Every room was read off its photograph in LENS HEIGHTS, so a lens measured k × higher makes the
 * whole room k × larger about the lens: the floor stays at `PHOTO_FLOOR_Z`, the lens moves from
 * `FLOOR_Z + from` to `FLOOR_Z + to`, and every point goes `eye' + k (p − eye)`. A direction from
 * the lens is unchanged, so the photograph's lookup, the furniture's rows and the split at the lens
 * all hold. The meshes are quantised with the dequantisation on each node (`pack.ts`), so this is
 * the nodes' `translation` and `scale` and nothing else: the BIN chunk is copied byte for byte.
 *
 *   npx tsx scripts/venues/rescale-lens.ts --only court --from 63 --to 64.6
 *
 * Then scale the row's `room` (and a `PhotoLayers.floor`, and `layers.py`'s `ROOMS`/`FLOOR_STEPS`)
 * by the same k, set the row's `height`, put the printed size in the row's `bytes.mesh`, and run the
 * RENDER lane: its mesh-against-row checks hold only if the file and the row moved together.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** `PHOTO_FLOOR_Z` (`renderPhotoVenue.ts`), as `layers.py` repeats it */
const FLOOR_Z = -0.75;

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`usage: --only <id> --from <in> --to <in> (missing ${name})`);
  return process.argv[i + 1];
}

const id = arg('--only');
const from = Number(arg('--from'));
const to = Number(arg('--to'));
if (!(from > 0 && to > 0)) throw new Error('--from and --to are lens heights in inches');
const k = to / from;
const eyeOld = FLOOR_Z + from;
const eyeNew = FLOOR_Z + to;

const path = join(ROOT, 'public', 'venues', `${id}-room.glb`);
const buf = readFileSync(path);
if (buf.readUInt32LE(0) !== 0x46546c67 || buf.readUInt32LE(4) !== 2) throw new Error(`${path}: not a glTF 2 GLB`);
const jsonLen = buf.readUInt32LE(12);
if (buf.readUInt32LE(16) !== 0x4e4f534a) throw new Error(`${path}: first chunk is not JSON`);
const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen)) as {
  nodes: { name?: string; children?: number[]; rotation?: number[]; matrix?: number[]; translation?: number[]; scale?: number[] }[];
};
const bin = buf.subarray(20 + jsonLen);

// pack.ts writes flat nodes, each a translation and a uniform scale; anything else would need its
// parent chain or rotation composed, so refuse rather than move it wrongly
for (const n of json.nodes) {
  if (n.children?.length || n.rotation || n.matrix || !n.translation || !n.scale) throw new Error(`${path}: node ${n.name} is not pack.ts's flat translate-and-scale`);
  const [x, y, z] = n.translation;
  n.translation = [k * x, k * y, eyeNew + k * (z - eyeOld)];
  n.scale = n.scale.map((s) => k * s);
}

const text = Buffer.from(JSON.stringify(json), 'utf8');
const padded = (text.length + 3) & ~3;
const out = Buffer.alloc(12 + 8 + padded + bin.length);
out.writeUInt32LE(0x46546c67, 0);
out.writeUInt32LE(2, 4);
out.writeUInt32LE(out.length, 8);
out.writeUInt32LE(padded, 12);
out.writeUInt32LE(0x4e4f534a, 16);
text.copy(out, 20);
out.fill(0x20, 20 + text.length, 20 + padded);
bin.copy(out, 20 + padded);
writeFileSync(path, out);
console.log(`${id}: lens ${from} -> ${to} in (k ${k.toFixed(6)}), ${out.length} bytes`);
