/**
 * MODELED VENUE BUILD (2026-11-04) — one Sketchfab glTF in, one `public/venues/<id>.glb` out.
 *
 *   npx tsx scripts/venue-models/build.ts <id> --inspect     what the source holds (nodes, bounds, textures)
 *   npx tsx scripts/venue-models/build.ts <id>               build it (needs `fieldAt` and `floor` set)
 *   npx tsx scripts/venue-models/build.ts --placeholder      the whole chain on a generated room, to scratch/
 *
 * Tools live OUTSIDE the repo, like the field pipeline's (`scripts/field-cad/`): `VENUE_TOOLS`
 * (default `%LOCALAPPDATA%/dsim/venue-models/npmtools`) holds `@gltf-transform/{core,functions,
 * extensions}` 4.5.1, `meshoptimizer` 1.1.1, `sharp` and `ktx2-encoder` 0.6.0 (Basis Universal as wasm,
 * so no native `ktx` binary). Sources live in `VENUE_SOURCES` (default `D:/Projects/dsim/venue-sources`).
 *
 * What it does, in order — the README beside this file says why for each:
 *   1. read the glTF (or the zip, extracted with `tar` into the tools' work folder);
 *   2. drop `drop` nodes, every light, camera and animation (the scene's `rig` lights the room);
 *   3. place it: z up, inches, turned by `yawDeg`, the source's `fieldAt` at the origin and its
 *      `floor` at the procedural ground's height (−0.75 in, under the field's mat);
 *   4. grow the CLEAR BOX (`graphics/venueRoom.ts`) from the field's footprint: the row's
 *      `cameraRoom`, inside which no triangle stands — it fails if the field's own footprint is not
 *      clear, naming the nodes in the way;
 *   5. dedup, prune, weld; textures resized to `maxTexture`, then KTX2 (Basis ETC1S for colour,
 *      UASTC for normal maps, sRGB only where the slot is colour); geometry meshopt-compressed;
 *   6. write the GLB and print the row's numbers (`file`, `bytes`, `tris`, `cameraRoom`).
 * Nothing is decimated by rule: a simplified copy is added only for a tier that measurably needs one.
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VENUE_MODEL_SOURCES, type VenueModelSource } from './venues';
import { growClearBox, insetCameraRoom, obstacleTris, trisInBox, type VenueBox, type VenueTris } from '../../src/games/biobuzz/graphics/venueRoom';
import { BB_HALF_X, BB_HALF_Y } from '../../src/games/biobuzz/config';

const LOCAL = process.env.LOCALAPPDATA ?? join(process.env.HOME ?? '.', 'AppData', 'Local');
const TOOLS = process.env.VENUE_TOOLS ?? join(LOCAL, 'dsim', 'venue-models', 'npmtools');
const SOURCES = process.env.VENUE_SOURCES ?? 'D:/Projects/dsim/venue-sources';
const WORK = join(TOOLS, '..', 'work');
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** the procedural venue's ground (`renderVenue.ts`, GROUND_Z): the field's mat sits above it */
const GROUND_Z = -0.75;
/** the box that must be clear before anything grows: the field and a driver's reach round it */
const SEED: VenueBox = { min: [-(BB_HALF_X + 60), -(BB_HALF_Y + 60), GROUND_Z], max: [BB_HALF_X + 60, BB_HALF_Y + 60, 110] };
/** how far the clear box may grow: past the orbit camera's 620-in reach, and a high roof */
const LIMIT: VenueBox = { min: [-900, -900, GROUND_Z], max: [900, 900, 900] };
/** the orbit and free eyes stop this far inside the clear box */
const CAMERA_MARGIN_IN = 24;
const IN_PER_M = 39.37007874;

const mod = async (rel: string): Promise<any> => import(pathToFileURL(join(TOOLS, 'node_modules', rel)).href);

async function tools() {
  if (!existsSync(join(TOOLS, 'node_modules', '@gltf-transform', 'core'))) {
    throw new Error(`no tools at ${TOOLS}: npm install @gltf-transform/core@4.5.1 @gltf-transform/functions@4.5.1 @gltf-transform/extensions@4.5.1 meshoptimizer@1.1.1 sharp ktx2-encoder@0.6.0 there`);
  }
  const core = await mod('@gltf-transform/core/dist/index.js');
  const fns = await mod('@gltf-transform/functions/dist/index.js');
  const ext = await mod('@gltf-transform/extensions/dist/index.js');
  const meshopt = await mod('meshoptimizer/index.js');
  const sharp = (await mod('sharp/dist/index.mjs')).default;
  const { ktx2 } = await mod('ktx2-encoder/dist/gltf-transform/index.js');
  await meshopt.MeshoptEncoder.ready;
  await meshopt.MeshoptDecoder.ready;
  const io = new core.NodeIO().registerExtensions(ext.ALL_EXTENSIONS).registerDependencies({
    'meshopt.decoder': meshopt.MeshoptDecoder,
    'meshopt.encoder': meshopt.MeshoptEncoder,
  });
  return { core, ext, fns, meshopt, sharp, ktx2, io };
}
type Tools = Awaited<ReturnType<typeof tools>>;

/** the source's glTF/GLB, extracting a zip first if that is what the folder holds */
function sourceFile(src: VenueModelSource): string {
  const dir = join(SOURCES, src.uid);
  if (!existsSync(dir)) throw new Error(`waiting for the owner's download: ${dir} does not exist (${src.page}, glTF format)`);
  const find = (d: string): string | null => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) {
        const r = find(p);
        if (r) return r;
      } else if (/\.(gltf|glb)$/i.test(f)) return p;
    }
    return null;
  };
  const direct = find(dir);
  if (direct) return direct;
  const zip = readdirSync(dir).find((f) => /\.zip$/i.test(f));
  if (!zip) throw new Error(`${dir} holds no .gltf, .glb or .zip`);
  const out = join(WORK, src.uid);
  mkdirSync(out, { recursive: true });
  execFileSync('tar', ['-xf', join(dir, zip), '-C', out], { stdio: 'inherit' });
  const extracted = find(out);
  if (!extracted) throw new Error(`${zip} holds no .gltf or .glb`);
  return extracted;
}

/** every primitive's triangles in WORLD space (after the placement node), and which node owns each */
function worldTris(t: Tools, doc: any): { tris: VenueTris; owner: string[] } {
  const pos: number[] = [];
  const owner: string[] = [];
  const v = [0, 0, 0];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    // ⚠️ A NODE CARRYING EXT_mesh_gpu_instancing DRAWS ITS MESH ONCE PER INSTANCE (a generated source
    // writes its repeated parts that way): every instance's triangles are obstacles, not the node's one
    const batch = node.getExtension('EXT_mesh_gpu_instancing');
    const mats: number[][] = [];
    if (batch) {
      const T = batch.getAttribute('TRANSLATION');
      const R = batch.getAttribute('ROTATION');
      const S = batch.getAttribute('SCALE');
      const n = (T ?? R ?? S).getCount();
      const w = node.getWorldMatrix();
      const t = [0, 0, 0], r = [0, 0, 0, 1], s = [1, 1, 1];
      for (let i = 0; i < n; i++) {
        if (T) T.getElement(i, t);
        if (R) R.getElement(i, r);
        if (S) S.getElement(i, s);
        const [x, y, z, q] = r;
        // T·R·S as a column-major 4×4, then the node's world in front of it
        const l = [
          (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * q) * s[0], 2 * (x * z - y * q) * s[0], 0,
          2 * (x * y - z * q) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * q) * s[1], 0,
          2 * (x * z + y * q) * s[2], 2 * (y * z - x * q) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
          t[0], t[1], t[2], 1,
        ];
        const out = new Array(16).fill(0);
        for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) for (let k = 0; k < 4; k++) out[c * 4 + rr] += w[k * 4 + rr] * l[c * 4 + k];
        mats.push(out);
      }
    } else mats.push(node.getWorldMatrix());
    for (const m of mats) for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== t.core.Primitive.Mode.TRIANGLES) continue;
      const p = prim.getAttribute('POSITION');
      if (!p) continue;
      const idx = prim.getIndices();
      const n = idx ? idx.getCount() : p.getCount();
      for (let i = 0; i < n; i++) {
        const k = idx ? idx.getScalar(i) : i;
        p.getElement(k, v);
        pos.push(m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]);
        if (i % 3 === 0) owner.push(node.getName() || mesh.getName() || '(unnamed)');
      }
    }
  }
  return { tris: { positions: pos, indices: null }, owner };
}

/** wrap every scene root in one node that turns the source z up, into inches, and places it */
function place(t: Tools, doc: any, src: Pick<VenueModelSource, 'scale' | 'yawDeg'> & { fieldAt: readonly [number, number]; floor: number }): void {
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  const venue = doc.createNode('venue');
  for (const child of scene.listChildren()) {
    scene.removeChild(child);
    venue.addChild(child);
  }
  scene.addChild(venue);
  // y up → z up: +90° about x, then the yaw about z
  const s = IN_PER_M * src.scale;
  const yaw = (src.yawDeg * Math.PI) / 180;
  const qx = [Math.sin(Math.PI / 4), 0, 0, Math.cos(Math.PI / 4)];
  const qz = [0, 0, Math.sin(yaw / 2), Math.cos(yaw / 2)];
  const q = [
    qz[3] * qx[0] + qz[0] * qx[3] + qz[1] * qx[2] - qz[2] * qx[1],
    qz[3] * qx[1] - qz[0] * qx[2] + qz[1] * qx[3] + qz[2] * qx[0],
    qz[3] * qx[2] + qz[0] * qx[1] - qz[1] * qx[0] + qz[2] * qx[3],
    qz[3] * qx[3] - qz[0] * qx[0] - qz[1] * qx[1] - qz[2] * qx[2],
  ];
  // `fieldAt`/`floor` are read in the z-up frame; turned by the yaw and scaled, they go to the origin
  const [fx, fy] = src.fieldAt;
  const rx = Math.cos(yaw) * fx - Math.sin(yaw) * fy;
  const ry = Math.sin(yaw) * fx + Math.cos(yaw) * fy;
  venue.setRotation(q).setScale([s, s, s]).setTranslation([-rx * s, -ry * s, GROUND_Z - src.floor * s]);
}

async function inspect(t: Tools, src: VenueModelSource): Promise<void> {
  const file = sourceFile(src);
  const doc = await t.io.read(file);
  place(t, doc, { scale: src.scale, yawDeg: 0, fieldAt: [0, 0], floor: 0 });
  const rows: { name: string; tris: number; min: number[]; max: number[] }[] = [];
  for (const node of doc.getRoot().listNodes()) {
    if (!node.getMesh()) continue;
    const b = t.core.getBounds(node);
    let tris = 0;
    for (const p of node.getMesh().listPrimitives()) tris += (p.getIndices()?.getCount() ?? p.getAttribute('POSITION')?.getCount() ?? 0) / 3;
    rows.push({ name: node.getName(), tris, min: b.min.map((x: number) => x / IN_PER_M), max: b.max.map((x: number) => x / IN_PER_M) });
  }
  rows.sort((a, b) => b.tris - a.tris);
  const all = t.core.getBounds(doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0]);
  console.log(`${src.id}: ${file}`);
  console.log(`bounds (z-up metres, unplaced): min ${all.min.map((x: number) => (x / IN_PER_M).toFixed(2)).join(', ')}  max ${all.max.map((x: number) => (x / IN_PER_M).toFixed(2)).join(', ')}`);
  console.log(`triangles ${rows.reduce((a, r) => a + r.tris, 0)} in ${rows.length} meshes; the largest:`);
  for (const r of rows.slice(0, 40)) console.log(`  ${String(r.tris).padStart(8)}  ${r.name}  [${r.min.map((x) => x.toFixed(2)).join(', ')}] .. [${r.max.map((x) => x.toFixed(2)).join(', ')}]`);
  for (const tex of doc.getRoot().listTextures()) {
    const size = tex.getSize();
    console.log(`  texture ${tex.getName() || tex.getURI()} ${tex.getMimeType()} ${size ? size.join('x') : '?'} ${tex.getImage()?.byteLength ?? 0} B`);
  }
  for (const l of doc.getRoot().listExtensionsUsed()) console.log(`  extension ${l.extensionName}`);
}

async function build(t: Tools, src: VenueModelSource, input: string | any, out: string, keepClear: VenueBox | null = null): Promise<void> {
  if (!src.fieldAt || src.floor === null) throw new Error(`${src.id}: set fieldAt and floor in venues.ts first (run --inspect)`);
  const doc = typeof input === 'string' ? await t.io.read(input) : input;
  const root = doc.getRoot();
  // 2. what the venue must not carry
  for (const node of root.listNodes()) if (src.drop.some((re) => re.test(node.getName()))) node.dispose();
  for (const node of root.listNodes()) node.setCamera(null);
  for (const a of root.listAnimations()) a.dispose();
  for (const e of root.listExtensionsUsed()) if (e.extensionName === 'KHR_lights_punctual') e.dispose();
  // 3. placement
  place(t, doc, { scale: src.scale, yawDeg: src.yawDeg, fieldAt: src.fieldAt, floor: src.floor });
  await doc.transform(t.fns.dedup(), t.fns.prune(), t.fns.weld());
  // 4. the clear box
  const { tris, owner } = worldTris(t, doc);
  const obstacles = obstacleTris(tris, GROUND_Z);
  const inSeed = trisInBox(tris, obstacles, SEED);
  if (inSeed.length > 0) {
    const names = new Map<string, number>();
    for (const i of inSeed) names.set(owner[i], (names.get(owner[i]) ?? 0) + 1);
    throw new Error(`${src.id}: the field's footprint is not clear: ${[...names].map(([n, c]) => `${n} (${c})`).join(', ')}. Move fieldAt, or drop those nodes.`);
  }
  const clear = growClearBox(tris, obstacles, SEED, LIMIT);
  const cameraRoom = insetCameraRoom(clear, CAMERA_MARGIN_IN);
  // a GENERATED source states the box its author kept clear for the sim's eyes; the grown box must
  // contain it, or the generator let something stand where an eye goes
  if (keepClear) {
    const short = [0, 1, 2].flatMap((i) => [
      ...(clear.min[i] > keepClear.min[i] + 0.5 && i < 2 ? [`min[${i}] ${clear.min[i].toFixed(1)} > ${keepClear.min[i]}`] : []),
      ...(clear.max[i] < keepClear.max[i] - 0.5 ? [`max[${i}] ${clear.max[i].toFixed(1)} < ${keepClear.max[i]}`] : []),
    ]);
    if (short.length) throw new Error(`${src.id}: the clear box does not contain the generator's KEEP_CLEAR: ${short.join(', ')}`);
  }
  // 4b. one GPU-instanced draw per part placed twice or more (a generated venue places its columns,
  // joists, truss sections and fixtures, and its neighbouring fields, as shared meshes)
  await doc.transform(t.fns.instance({ min: 2 }));
  // 5. textures, then geometry
  await doc.transform(t.fns.textureCompress({ encoder: t.sharp, resize: [src.maxTexture, src.maxTexture] }));
  const imageDecoder = async (buffer: Uint8Array) => {
    const { data, info } = await t.sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data: new Uint8Array(data), width: info.width, height: info.height };
  };
  const basis = { generateMipmap: true, imageDecoder };
  await doc.transform(t.ktx2({ ...basis, isUASTC: true, isNormalMap: true, isSetKTX2SRGBTransferFunc: false, slots: /normalTexture/ }));
  await doc.transform(t.ktx2({ ...basis, isUASTC: false, qualityLevel: 160, isSetKTX2SRGBTransferFunc: true, slots: /baseColorTexture|emissiveTexture|diffuseTexture/ }));
  await doc.transform(t.ktx2({ ...basis, isUASTC: false, qualityLevel: 160, isSetKTX2SRGBTransferFunc: false }));
  await doc.transform(t.fns.meshopt({ encoder: t.meshopt.MeshoptEncoder, level: 'medium' }));
  // 6. out
  mkdirSync(dirname(out), { recursive: true });
  const glb: Uint8Array = await t.io.writeBinary(doc);
  writeFileSync(out, glb);
  const r = (b: VenueBox) => `{ min: [${b.min.map((x) => Math.round(x)).join(', ')}], max: [${b.max.map((x) => Math.round(x)).join(', ')}] }`;
  console.log(`${src.id}: ${out}`);
  console.log(`  bytes ${glb.byteLength} (${(glb.byteLength / 1e6).toFixed(2)} MB), triangles ${tris.positions.length / 9}, textures ${root.listTextures().length}`);
  console.log(`  clear box ${r(clear)}`);
  console.log(`  row: model: { file: 'venues/${src.id}.glb', bytes: ${glb.byteLength}, tris: ${tris.positions.length / 9}, cameraRoom: ${r(cameraRoom)}, ... }`);
}

/** THE PLACEHOLDER: a generated hall in metres, y up, with a stand, a pillar out of the way, a lamp
 * the build must drop and one textured floor, so every step above runs before a real file exists */
async function placeholder(t: Tools): Promise<any> {
  const doc = new t.core.Document();
  const buffer = doc.createBuffer();
  const png = await t.sharp({ create: { width: 512, height: 512, channels: 4, background: { r: 140, g: 110, b: 70, alpha: 1 } } })
    .composite([{ input: Buffer.from('<svg width="512" height="512"><rect x="0" y="0" width="256" height="256" fill="#6b5236"/><rect x="256" y="256" width="256" height="256" fill="#6b5236"/></svg>'), top: 0, left: 0 }])
    .png()
    .toBuffer();
  const tex = doc.createTexture('floor').setImage(new Uint8Array(png)).setMimeType('image/png');
  const wood = doc.createMaterial('wood').setBaseColorTexture(tex).setRoughnessFactor(0.5);
  const wall = doc.createMaterial('wall').setBaseColorFactor([0.7, 0.68, 0.64, 1]);
  const scene = doc.createScene('scene');
  /** a box, metres, y up: centre and half-size */
  const box = (name: string, c: number[], h: number[], mat: any) => {
    const p: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const faces = [
      [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
    ];
    for (const [a, b, n] of faces) {
      for (const sn of [-1, 1]) {
        const base = p.length / 3;
        for (const [sa, sb] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          const v = [0, 0, 0];
          v[a] = c[a] + sa * h[a];
          v[b] = c[b] + sb * h[b];
          v[n] = c[n] + sn * h[n];
          p.push(...v);
          uv.push((sa + 1) * 4, (sb + 1) * 4);
        }
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(p)).setBuffer(buffer))
      .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(uv)).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(idx)).setBuffer(buffer))
      .setMaterial(mat);
    scene.addChild(doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim)));
  };
  box('floor', [0, -0.05, 0], [25, 0.05, 15], wood);
  box('wall-n', [0, 5, -15], [25, 5, 0.1], wall);
  box('wall-s', [0, 5, 15], [25, 5, 0.1], wall);
  box('wall-e', [25, 5, 0], [0.1, 5, 15], wall);
  box('wall-w', [-25, 5, 0], [0.1, 5, 15], wall);
  box('roof', [0, 10, 0], [25, 0.1, 15], wall);
  box('stand', [0, 1, 12], [10, 1, 2], wall);
  box('pillar', [14, 5, -8], [0.3, 5, 0.3], wall);
  box('lamp-DA42', [0, 6, 0], [1, 0.2, 1], wall);
  return doc;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const t = await tools();
  if (args.includes('--placeholder')) {
    const src: VenueModelSource = { id: 'placeholder', uid: '-', title: 'placeholder', author: '-', page: '-', scale: 1, fieldAt: [0, 0], floor: 0, yawDeg: 0, drop: [/da.?42/i], maxTexture: 2048 };
    await build(t, src, await placeholder(t), join(REPO, 'scratch', 'venue-models', 'placeholder.glb'));
    return;
  }
  const src = VENUE_MODEL_SOURCES.find((s) => s.id === args[0]);
  if (!src) throw new Error(`usage: build.ts <${VENUE_MODEL_SOURCES.map((s) => s.id).join('|')}> [--inspect] | --placeholder`);
  if (src.generator) {
    // a venue GENERATED in this repo: the generator builds the source document from its numbers; the
    // source is also written, uncompressed, to the tools' work folder, so it can be opened in a viewer
    const gen = await import(pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), src.generator)).href);
    const { doc, notes } = await gen.generate(t, REPO);
    for (const n of notes) console.log(`  ${n}`);
    const srcOut = join(WORK, src.id, `${src.id}-source.glb`);
    mkdirSync(dirname(srcOut), { recursive: true });
    writeFileSync(srcOut, await t.io.writeBinary(doc));
    console.log(`  source: ${srcOut}`);
    if (args.includes('--source')) return;
    const kc = gen.keepClear as { min: number[]; max: number[] };
    // the generator's frame has the floor at 0; the build's at GROUND_Z
    await build(t, src, doc, join(REPO, 'public', 'venues', `${src.id}.glb`), { min: [kc.min[0], kc.min[1], GROUND_Z], max: [kc.max[0], kc.max[1], kc.max[2] + GROUND_Z] });
    return;
  }
  if (args.includes('--inspect')) await inspect(t, src);
  else await build(t, src, sourceFile(src), join(REPO, 'public', 'venues', `${src.id}.glb`));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
