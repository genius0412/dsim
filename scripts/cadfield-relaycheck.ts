/**
 * WOULD ANOTHER PLAYER SEE THIS IMPORTED ROBOT'S REAL LOOK? A field-test measurement on one stored
 * mesh (the library's `<id>:mesh` GLB) and its top PNG, through the relay path the owner's client takes
 * (`importVisualsClient.ts`): the stored file as it is when `validateMeshGlb` takes it, else `liteMesh`
 * to `VISUAL_MAX_BYTES.mesh`; then the relay's validator on what would be sent, and the viewer's own
 * check (`prepareImportedMesh` + `importedMeshFits`) on the parsed result. Also the stored mesh's size
 * against `MAX_MESH_BYTES`.
 *
 *   npx tsx scripts/cadfield-relaycheck.ts --glb <stored.glb> [--png <top.png>] [--imported <imported.json>]
 */
import { readFileSync } from 'node:fs';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import * as THREE from 'three';
import { validateMeshGlb, validateTopPng, VISUAL_MAX_TRIANGLES } from '../src/net/visualCheck';
import { VISUAL_MAX_BYTES } from '../src/net/importVisuals';
import { liteMesh } from '../src/robotImport/engine/lite';
import { MAX_MESH_BYTES } from '../src/robotImport/types';

// three's GLTFExporter (liteMesh's writer) reads its Blob through FileReader, which Node lacks
if (typeof (globalThis as { FileReader?: unknown }).FileReader === 'undefined') {
  (globalThis as unknown as { FileReader: unknown }).FileReader = class {
    result: ArrayBuffer | string | null = null;
    onloadend: (() => void) | null = null;
    onload: (() => void) | null = null;
    readAsArrayBuffer(b: Blob) {
      void b.arrayBuffer().then((x) => {
        this.result = x;
        this.onload?.();
        this.onloadend?.();
      });
    }
    readAsDataURL(b: Blob) {
      void b.arrayBuffer().then((x) => {
        this.result = `data:${b.type || 'application/octet-stream'};base64,${Buffer.from(x).toString('base64')}`;
        this.onload?.();
        this.onloadend?.();
      });
    }
  };
}

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const glbPath = args.get('glb');
if (!glbPath) throw new Error('--glb');

const stats = (root: THREE.Object3D) => {
  let tris = 0;
  let prims = 0;
  const box = new THREE.Box3();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    prims++;
    const g = m.geometry;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    g.computeBoundingBox();
    box.union(g.boundingBox!.clone().applyMatrix4(m.matrixWorld));
  });
  return { tris, prims, boxM: { min: box.min.toArray().map((v) => +v.toFixed(3)), max: box.max.toArray().map((v) => +v.toFixed(3)) } };
};

const main = async () => {
  const out: Record<string, unknown> = {};
  const stored = new Uint8Array(readFileSync(glbPath));
  out.storedBytes = stored.length;
  out.storedMB = +(stored.length / 1048576).toFixed(2);
  out.maxMeshMB = +(MAX_MESH_BYTES / 1048576).toFixed(0);
  out.storedUnderCap = stored.length <= MAX_MESH_BYTES;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder as Parameters<GLTFLoader['setMeshoptDecoder']>[0]);
  const ab = stored.buffer.slice(stored.byteOffset, stored.byteOffset + stored.byteLength);
  const t0 = performance.now();
  const g0 = await loader.parseAsync(ab, '');
  out.storedParseMs = Math.round(performance.now() - t0);
  out.stored = stats(g0.scene);
  out.storedValidator = validateMeshGlb(stored);
  // what the owner's client sends: the stored file when the validator takes it, else liteMesh
  let send: Uint8Array | null = out.storedValidator === null ? stored : null;
  if (!send) {
    const t1 = performance.now();
    const lite = await liteMesh(ab, VISUAL_MAX_BYTES.mesh);
    out.liteMs = Math.round(performance.now() - t1);
    send = lite ? new Uint8Array(lite) : null;
  }
  out.relayCapBytes = VISUAL_MAX_BYTES.mesh;
  out.relayMaxTriangles = VISUAL_MAX_TRIANGLES;
  if (!send) {
    out.sent = null;
    out.verdict = 'liteMesh returned null: the relay sends the picture alone (2D look only, 3D placeholder)';
  } else {
    out.sentBytes = send.length;
    out.sentValidator = validateMeshGlb(send);
    const g1 = await loader.parseAsync(send.buffer.slice(send.byteOffset, send.byteOffset + send.byteLength), '');
    out.sent = stats(g1.scene);
    // the viewer's own check, as the 3D slot runs it (renderImported pulls in the scene module's imports)
    try {
      const ri = await import('../src/games/biobuzz/scene/renderImported');
      const imp = args.get('imported') ? JSON.parse(readFileSync(args.get('imported')!, 'utf8')) : {};
      const prepared = ri.prepareImportedMesh(g1.scene);
      out.viewerFits = ri.importedMeshFits(prepared, imp);
    } catch (e) {
      out.viewerFits = `not run in Node: ${String(e).slice(0, 200)}`;
    }
    out.verdict = out.sentValidator === null && out.viewerFits === true ? 'others see the real 3D look' : 'others see a placeholder in 3D';
  }
  if (args.get('png')) {
    const png = new Uint8Array(readFileSync(args.get('png')!));
    out.pngBytes = png.length;
    out.pngValidator = validateTopPng(png);
  }
  console.log(JSON.stringify(out, null, 1));
};
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
