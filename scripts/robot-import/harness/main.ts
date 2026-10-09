/**
 * ROBOT IMPORT HARNESS — proves the lazy engine end to end in a real browser. A throwaway dev
 * page (never built or shipped): `npx vite scripts/robot-import/harness --port 5191`.
 *
 * For every fixture format it runs load → simplify → normalise → descriptor → bake, times each
 * stage, re-imports the baked GLB to check the stored frame round-trips (it must measure the
 * same hull and wheels as the source), writes the share file and reads it back, and POSTs the
 * outputs to `/__out/` (see `vite.config.ts`). Then it times a dense (≈1M triangle) model, and
 * leaves the default robot in the preview with a mechanism placement drawn on it.
 *
 * Results land in `window.__harness` and the page's log.
 */
import { loadImporterEngine } from '../../../src/robotImport/engineLoader';
import { buildDescriptor, defaultImportSetup, type MeshPart } from '../../../src/robotImport/geometry';
import { readShareFile, writeShareFile } from '../../../src/robotImport/shareFile';
import * as lib from '../../../src/robotImport/library';
import { synthParts, synthRobot, type V3 } from '../synthRobot';

type Row = Record<string, unknown>;
const log = document.getElementById('log') as HTMLPreElement;
const images = document.getElementById('images') as HTMLDivElement;
const results: Row[] = [];
(window as unknown as { __harness: unknown }).__harness = { done: false, results };

const say = (s: string): void => {
  log.textContent = (log.textContent === 'running…' ? '' : log.textContent) + s + '\n';
};
const ms = (t0: number): number => Math.round(performance.now() - t0);

async function post(name: string, data: Blob | ArrayBuffer | string): Promise<void> {
  await fetch(`/__out/${name}`, { method: 'POST', body: data });
}

function show(label: string, blob: Blob): void {
  const fig = document.createElement('figure');
  const img = document.createElement('img');
  img.src = URL.createObjectURL(blob);
  const cap = document.createElement('figcaption');
  cap.textContent = label;
  fig.append(img, cap);
  images.append(fig);
}

const FIXTURES: [string, string[]][] = [
  ['glb', ['robot.glb']],
  ['stl', ['robot.stl']],
  ['obj', ['robot.obj', 'robot.mtl']],
  ['ply', ['robot.ply']],
  ['3mf', ['robot.3mf']],
  ['step', ['robot.step']],
];

async function fetchFiles(names: string[]): Promise<File[]> {
  return Promise.all(
    names.map(async (n) => {
      const r = await fetch(`/${n}`);
      if (!r.ok) throw new Error(`fetch ${n}: ${r.status}`);
      return new File([await r.arrayBuffer()], n);
    }),
  );
}

/** a dense extra part: a UV sphere with `seg`² × 2 triangles */
function densePart(seg: number, c: V3, r: number): MeshPart {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= seg; i++) {
    const th = (Math.PI * i) / seg;
    for (let j = 0; j <= seg; j++) {
      const ph = (2 * Math.PI * j) / seg;
      pos.push(c[0] + r * Math.sin(th) * Math.cos(ph), c[1] + r * Math.sin(th) * Math.sin(ph), c[2] + r * Math.cos(th));
    }
  }
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * (seg + 1) + j;
      const b = a + seg + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx), color: [0.6, 0.6, 0.62], name: 'dense' };
}

async function run(): Promise<void> {
  let t0 = performance.now();
  const eng = await loadImporterEngine();
  say(`engine chunk loaded in ${ms(t0)} ms`);
  let lastNormalised: Awaited<ReturnType<typeof eng.normalise>> | null = null;
  let libraryInput: {
    descriptor: ReturnType<typeof buildDescriptor>;
    baked: Awaited<ReturnType<typeof eng.bake>>;
    setup: ReturnType<typeof defaultImportSetup>;
    loaded: Awaited<ReturnType<typeof eng.loadModel>>;
  } | null = null;

  for (const [fmt, names] of FIXTURES) {
    const row: Row = { format: fmt };
    try {
      const files = await fetchFiles(names);
      t0 = performance.now();
      const loaded = await eng.loadModel(files);
      row.loadMs = ms(t0);
      t0 = performance.now();
      const prepared = await eng.simplifyModel(loaded, 100_000);
      row.simplifyMs = ms(t0);
      t0 = performance.now();
      const setup = defaultImportSetup();
      const norm = eng.normalise(prepared, setup);
      row.normaliseMs = ms(t0);
      const m = norm.measurement;
      const descriptor = buildDescriptor({ id: '0123456789abcdef', measurement: m });
      t0 = performance.now();
      const baked = await eng.bake({ modelParts: norm.modelParts, origin: m.origin, descriptor });
      row.bakeMs = ms(t0);
      Object.assign(row, {
        units: m.units,
        up: m.up,
        upMargin: Math.round(m.upMargin * 100) / 100,
        size: [m.size.length, m.size.width, m.size.height].map((v) => Math.round(v * 100) / 100),
        hullVerts: descriptor.hull.length,
        wheels: descriptor.wheels,
        bands: descriptor.bands?.map((b) => [b.z0, b.z1, b.hull.length]),
        trisIn: loaded.trisIn,
        trisOut: prepared.trisOut,
        meshBytes: baked.meshBytes,
        topBytes: baked.top.size,
        thumbBytes: baked.thumb.size,
        descriptorBytes: JSON.stringify(descriptor).length,
        checks: m.checks.map((c) => c.code),
      });
      // the stored frame must round-trip: the baked GLB re-imported is glTF (metres, +Y up),
      // and measures the same robot
      const back = await eng.loadModel([new File([baked.mesh], `${fmt}-baked.glb`)]);
      const backNorm = eng.normalise(await eng.simplifyModel(back, 100_000), defaultImportSetup());
      const bd = buildDescriptor({ id: '0123456789abcdef', measurement: backNorm.measurement });
      row.roundTrip = {
        units: backNorm.measurement.units,
        up: backNorm.measurement.up,
        sameHull: JSON.stringify(bd.hull) === JSON.stringify(descriptor.hull),
        sameWheels: JSON.stringify(bd.wheels) === JSON.stringify(descriptor.wheels),
      };
      // share file
      const share = writeShareFile(await baked.mesh.arrayBuffer(), { game: 'biobuzz', name: `Fixture ${fmt}`, spec: { name: 'x' } as never, setup });
      const read = readShareFile(share);
      row.share = read.ok ? { ok: true, bytes: share.byteLength, name: read.payload.name } : { ok: false, error: read.error };
      await post(`${fmt}-mesh.glb`, baked.mesh);
      await post(`${fmt}-top.png`, baked.top);
      await post(`${fmt}-thumb.png`, baked.thumb);
      await post(`${fmt}-share.glb`, new Blob([share]));
      show(`${fmt} top`, baked.top);
      if (fmt === 'glb' || fmt === 'step') show(`${fmt} thumb`, baked.thumb);
      if (fmt === 'glb') {
        lastNormalised = norm;
        libraryInput = { descriptor, baked, setup, loaded };
      }
    } catch (e) {
      row.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }
    results.push(row);
    say(JSON.stringify(row));
  }

  // the library, in a real IndexedDB
  if (libraryInput) {
    const { descriptor, baked, setup, loaded } = libraryInput;
    const id = lib.newRobotId();
    const now = Date.now();
    const robot = {
      id,
      game: 'biobuzz' as const,
      spec: { name: 'Harness bot', imported: { ...descriptor, id } } as never,
      mesh: baked.mesh,
      top: baked.top,
      thumb: baked.thumb,
      source: { name: loaded.name, format: loaded.format, bytes: loaded.bytes, trisIn: loaded.trisIn, trisOut: baked.trisOut },
      setup,
      created: now,
      updated: now,
    };
    const row: Row = { library: true };
    const put = await lib.putRobot(robot);
    const listed = await lib.listRobots('biobuzz');
    const got = await lib.getRobot(id);
    const renamed = await lib.renameRobot(id, 'Renamed bot');
    const dup = await lib.duplicateRobot(id);
    const mesh = await lib.meshFor(id);
    const top = await lib.topFor(id);
    const delA = await lib.deleteRobot(id);
    const delB = dup.ok ? await lib.deleteRobot(dup.value.id) : null;
    const after = await lib.getRobot(id);
    Object.assign(row, {
      put: put.ok,
      listed: listed.ok && listed.value.some((r) => r.id === id),
      got: got.ok && got.value.mesh.size === baked.mesh.size,
      renamed: renamed.ok && renamed.value.spec.name === 'Renamed bot',
      duplicated: dup.ok && dup.value.id !== id && (dup.value.spec.imported?.id ?? '') === dup.value.id && dup.value.spec.name === 'Renamed bot copy',
      meshFor: mesh?.size === baked.mesh.size,
      topFor: top?.size === baked.top.size,
      deleted: delA.ok && (delB?.ok ?? false) && !after.ok && after.error === 'not-found',
    });
    results.push(row);
    say(JSON.stringify(row));
  }

  // .gltf variants built from the GLB fixture: external .bin dropped alongside, and an embedded
  // data URI; both name a texture that was NOT dropped (the loader must strip it, not fetch it)
  {
    const glb = new Uint8Array(await (await fetch('/robot.glb')).arrayBuffer());
    const dv = new DataView(glb.buffer);
    const jl = dv.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jl)));
    const binLen = dv.getUint32(20 + jl, true);
    const bin = glb.slice(20 + jl + 8, 20 + jl + 8 + binLen);
    json.images = [{ uri: 'not-dropped.png' }];
    json.textures = [{ source: 0 }];
    json.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 };
    let b64 = '';
    for (let i = 0; i < bin.length; i += 0x8000) b64 += String.fromCharCode(...bin.subarray(i, i + 0x8000));
    const variants: [string, File[]][] = [
      ['gltf + bin', [new File([JSON.stringify({ ...json, buffers: [{ uri: 'robot.bin', byteLength: binLen }] })], 'robot.gltf'), new File([bin], 'robot.bin')]],
      ['gltf data URI', [new File([JSON.stringify({ ...json, buffers: [{ uri: `data:application/octet-stream;base64,${btoa(b64)}`, byteLength: binLen }] })], 'robot.gltf')]],
      // two external buffers (the same bytes twice, odd views on the second): the packer must
      // re-point every view at the merged BIN with the right offset
      [
        'gltf + two bins',
        [
          new File(
            [JSON.stringify({ ...json, buffers: [{ uri: 'a.bin', byteLength: binLen }, { uri: 'b.bin', byteLength: binLen }], bufferViews: json.bufferViews.map((v: { buffer: number }, i: number) => ({ ...v, buffer: i % 2 })) })],
            'robot.gltf',
          ),
          new File([bin], 'a.bin'),
          new File([bin], 'b.bin'),
        ],
      ],
    ];
    for (const [label, files] of variants) {
      const row: Row = { format: label };
      try {
        t0 = performance.now();
        const loaded = await eng.loadModel(files);
        row.loadMs = ms(t0);
        const norm = eng.normalise(await eng.simplifyModel(loaded, 100_000), defaultImportSetup());
        const d = buildDescriptor({ id: '0123456789abcdef', measurement: norm.measurement });
        Object.assign(row, { units: norm.measurement.units, up: norm.measurement.up, hullVerts: d.hull.length, wheels: d.wheels?.length, bytes: loaded.bytes });
      } catch (e) {
        row.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      }
      results.push(row);
      say(JSON.stringify(row));
    }
  }

  // error paths
  for (const [label, file] of [
    ['unsupported', new File(['hello'], 'robot.txt')],
    ['empty', new File([], 'robot.stl')],
    ['corrupt glb', new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21])], 'robot.glb')],
    ['gltf missing bin', new File([JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'robot.bin', byteLength: 12 }] })], 'robot.gltf')],
  ] as const) {
    try {
      await eng.loadModel([file]);
      results.push({ errorCase: label, threw: false });
    } catch (e) {
      results.push({ errorCase: label, threw: true, code: (e as { code?: string }).code, message: (e as Error).message });
    }
    say(JSON.stringify(results[results.length - 1]));
  }

  // a dense model: the synthetic robot plus a ≈1M-triangle sphere on the tower
  {
    const parts = synthParts(synthRobot(), (v) => [v[1] * 25.4, -v[0] * 25.4, v[2] * 25.4]) as MeshPart[];
    const sphere = densePart(700, [0, 2 * 25.4, 12 * 25.4], 2.5 * 25.4);
    parts.push(sphere);
    const trisIn = parts.reduce((s, p) => s + (p.indices ? p.indices.length : p.positions.length / 3) / 3, 0);
    const loaded = { name: 'dense', format: 'stl' as const, bytes: 0, fileUnit: null, parts, trisIn, notes: [] };
    const row: Row = { format: 'dense (in-memory, Z-up mm)', trisIn };
    t0 = performance.now();
    const prepared = await eng.simplifyModel(loaded, 100_000);
    row.simplifyMs = ms(t0);
    row.trisOut = prepared.trisOut;
    t0 = performance.now();
    const norm = eng.normalise(prepared, defaultImportSetup());
    row.normaliseMs = ms(t0);
    const descriptor = buildDescriptor({ id: '0123456789abcdef', measurement: norm.measurement });
    t0 = performance.now();
    const baked = await eng.bake({ modelParts: norm.modelParts, origin: norm.measurement.origin, descriptor });
    row.bakeMs = ms(t0);
    row.meshBytes = baked.meshBytes;
    row.refits = baked.refits;
    row.wheels = descriptor.wheels;
    results.push(row);
    say(JSON.stringify(row));
    // and at the 150k cap
    const capped = await eng.simplifyModel(loaded, 150_000);
    const n2 = eng.normalise(capped, defaultImportSetup());
    const b2 = await eng.bake({ modelParts: n2.modelParts, origin: n2.measurement.origin, descriptor: buildDescriptor({ id: '0123456789abcdef', measurement: n2.measurement }) });
    const capRow = { format: 'dense @150k', trisOut: capped.trisOut, bakedTris: b2.trisOut, meshBytes: b2.meshBytes, refits: b2.refits };
    results.push(capRow);
    say(JSON.stringify(capRow));
  }

  // the preview, left on screen with the default robot and a mechanism placement
  if (lastNormalised) {
    const canvas = document.getElementById('preview') as HTMLCanvasElement;
    const m = lastNormalised.measurement;
    const preview = eng.createPreview(canvas, {
      parts: lastNormalised.modelParts,
      hull: m.hull,
      wheels: m.wheelsUsed,
      contacts: m.wheels.contacts,
      origin: m.origin,
      size: m.size,
      mech: { intakes: [{ edge: 'front', from: -5, to: 5 }], shooter: { x: -2, y: 0, z: 14 } },
    });
    (window as unknown as { __preview: unknown }).__preview = preview;
  }
  // 3MF: the import worker's small DOM (`miniDom.ts`) against this page's own DOMParser, on the
  // fixture and on a sample written to exercise the XML; `npm test` pins the small DOM's hashes
  const { parseThreeMf } = await import('../../../src/robotImport/engine/threeMf');
  const { threeMfSample, partsHash } = await import('../threeMfSample');
  const mfSamples: [string, Uint8Array][] = [
    ['robot.3mf', new Uint8Array(await (await fetch('/robot.3mf')).arrayBuffer())],
    ['threeMfSample', threeMfSample()],
  ];
  for (const [label, bytes] of mfSamples) {
    const native = partsHash(parseThreeMf(bytes.slice().buffer, 'auto'));
    const mini = partsHash(parseThreeMf(bytes.slice().buffer, 'mini'));
    results.push({ threeMf: label, native, mini, same: native === mini });
    say(JSON.stringify(results[results.length - 1]));
  }
  await post('results.json', JSON.stringify(results, null, 2));
  (window as unknown as { __harness: { done: boolean } }).__harness.done = true;
  say('done');
}

run().catch((e) => {
  say(`FAILED: ${e instanceof Error ? e.stack : String(e)}`);
  (window as unknown as { __harness: { done: boolean; error: string } }).__harness = { done: true, error: String(e) } as never;
});
