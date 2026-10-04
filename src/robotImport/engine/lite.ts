/**
 * THE LIGHTER MESH for a room's visuals relay (`src/net/importVisuals.ts`): the stored GLB cut down
 * to fit the relay's 1 MiB, colours kept, STAYING IN THE STORED MESH FRAME so every viewer places it
 * with the same `STORED_MESH_TO_ROBOT` it uses for the full one.
 *
 * It does not go back through `normalise`/`bake`: those re-measure the model (units, up axis,
 * origin, wheels) and a re-detection could land the lighter mesh a hair off the footprint the
 * sim was told about. This reads the GLB, simplifies the SAME vertices with the importer's own
 * simplifier, re-creases the normals and writes it back, so nothing about where the robot is moves.
 * The stored mesh is already welded, one part per colour, with no textures.
 *
 * ⚠️ IT ALWAYS WRITES A FLOAT GLB (`exportStoredScene`), whatever it reads. The stored mesh is
 * quantised and meshopt-packed (`storedGlb.ts`), and the relay's validator, on this build's server,
 * older servers and every client, refuses any glTF extension. A compressed stored mesh is never sent
 * as it is, however small (`importVisualsClient.ts`).
 */
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
// through the facade, so the import worker's build keeps the decoder in `meshoptDecoder-*.js`
import { MeshoptDecoder } from './meshoptDecoder';
import { triangleCount, type MeshPart } from '../geometry';
import { readStoredScene, sceneParts, type StoredScene } from './bakeMesh';
import { exportStoredScene } from './floatGlb';
import { creaseParts, disposeTree } from './meshGroup';
import { mergeByColour } from './meshOps';
import { simplifyLists } from './simplify';
import { glbUsesExtensions } from './storedGlb';

/** below this a robot stops looking like itself, so the relay sends the picture alone instead */
const MIN_TRIANGLES = 400;
/** aim a little under the cap: the export's size is only roughly linear in the triangle count */
const AIM = 0.85;
/** the float writer's bytes a triangle: about 44–48 on CAD (`storedGlb.ts`), and never under 20 */
const FLOAT_BYTES = 46;
const FLOAT_FLOOR_BYTES = 20;

const creasedScene = (scene: StoredScene): StoredScene => ({ rest: creaseParts(scene.rest), moving: scene.moving.map((m) => ({ ...m, parts: creaseParts(m.parts) })) });

/**
 * `glb` (the stored mesh) as a GLB of at most `maxBytes`, or null when it cannot be brought under
 * that without dropping below `MIN_TRIANGLES`. Up to six passes, each aimed from the last export's
 * measured size, the way `bake` refits to `MAX_MESH_BYTES`. The moving parts stay nodes of their own
 * (`readStoredScene`), each simplified to its share; the body ids are left out (a viewer has no use
 * for them, and they are a tenth of the bytes).
 */
export async function liteMesh(glb: ArrayBuffer, maxBytes: number): Promise<ArrayBuffer | null> {
  const loader = new GLTFLoader();
  // a stored mesh is compressed (`storedGlb.ts`); one saved before that is a float GLB
  loader.setMeshoptDecoder(MeshoptDecoder as Parameters<GLTFLoader['setMeshoptDecoder']>[0]);
  const gltf = await loader.parseAsync(glb, '');
  const read = readStoredScene(gltf.scene);
  disposeTree(gltf.scene);
  const tidy = (parts: MeshPart[]): MeshPart[] => mergeByColour(parts).map((p) => ({ ...p, body: null }));
  let scene: StoredScene = { rest: tidy(read.rest), moving: read.moving.map((m) => ({ ...m, parts: tidy(m.parts) })) };
  if (!triangleCount(sceneParts(scene))) return null;
  let bytes = glb.byteLength;
  if (glbUsesExtensions(glb)) {
    // ⚠️ THE RELAY TAKES NO EXTENSION, so a compressed mesh always goes out re-written as float: whole
    // when that fits, else aimed from the float size (the compressed size says nothing about it).
    // A mesh that cannot fit by eight times (a Full robot: millions of triangles, a float copy of
    // hundreds of MB) is aimed from the float writer's usual size instead of writing it to find out.
    const total = triangleCount(sceneParts(scene));
    if (total * FLOAT_FLOOR_BYTES > maxBytes * 8) bytes = total * FLOAT_BYTES;
    else {
      const whole = await exportStoredScene(creasedScene(scene));
      if (whole.byteLength <= maxBytes) return whole;
      bytes = whole.byteLength;
    }
  }
  for (let pass = 0; pass < 6; pass++) {
    const total = triangleCount(sceneParts(scene));
    const budget = Math.max(MIN_TRIANGLES, Math.floor((total * maxBytes * AIM) / bytes));
    // one error bound over the robot and its moving parts, each kept apart (`simplifyLists`); the
    // simplifier numbers the connected pieces of a part with no ids, and the relay has no use for them
    const prep = (parts: MeshPart[]): MeshPart[] => parts.map((p) => ({ ...p, normals: null }));
    const s = await simplifyLists([prep(scene.rest), ...scene.moving.map((m) => prep(m.parts))], budget);
    const bare = (parts: MeshPart[]): MeshPart[] => parts.map((p) => ({ ...p, body: null }));
    scene = { rest: bare(s.lists[0]), moving: scene.moving.map((m, i) => ({ ...m, parts: bare(s.lists[i + 1]) })) };
    const out = await exportStoredScene(creasedScene(scene));
    if (out.byteLength <= maxBytes) return out;
    if (budget <= MIN_TRIANGLES) return null;
    bytes = out.byteLength;
  }
  return null;
}
