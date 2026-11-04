import * as THREE from 'three';
import {
  PackedSplats,
  SparkRenderer,
  SplatEdit,
  SplatEditRgbaBlendMode,
  SplatEditSdf,
  SplatEditSdfType,
  SplatMesh,
} from '@sparkjsdev/spark';
import { BB_HALF_X, BB_HALF_Y } from '../config';
import type { SplatVenue } from '../graphics/environments';
import { noteVenueFailure, venueAssetUrl, venueBlocked } from '../graphics/venueFiles';
import { splatHiddenBoxes } from '../graphics/venueRoom';

/**
 * A SPLAT VENUE (2026-11-04, the trial; `SplatVenue`, `graphics/environments.ts`) — a captured room
 * drawn by Spark (MIT, three r180+, WebGL2). A LAZY chunk: `renderScene.ts` reaches it by
 * `import('./renderSplatVenue')` only when a splat row is picked from High up. Spark is ~1 MB
 * gzipped (its sorter's wasm is inlined), and the capture itself is tens of MB, which is what the
 * trial is meant to weigh against the modeled rooms.
 *
 * Three things a capture needs that a mesh does not:
 *   • ITS FLOOR IS HIDDEN UNDER THE FIELD. A captured floor is a few inches of fuzz, which pokes
 *     through the mat; a box edit drops every splat under the field's footprint.
 *   • NOTHING CAPTURED STANDS IN FRONT OF THE PLAY. A second box edit drops every splat inside the
 *     row's `cameraRoom` above the floor (a capture's floaters, a hoop, a person). The room is convex
 *     and the orbit and free eyes are held in it, so no sight line to the field can be blocked.
 *   • ITS LIGHT IS BAKED, so a robot's shadow has nothing to land on: a shadow catcher (a
 *     `ShadowMaterial` plane on the floor round the field) takes the sun's shadow map.
 * And one rule about order: splats are drawn as ONE transparent object, and three sorts transparent
 * objects whole. The room is behind everything on the field, so it is drawn FIRST among them
 * (`renderOrder`), and the field's polycarbonate then blends over it.
 */

/** the floor's height in the scene (`renderVenue.ts`, GROUND_Z): the capture is placed on it */
const GROUND_Z = -0.75;
/** the shadow catcher's reach round the field and its darkness */
const CATCHER_REACH_IN = 60;
const CATCHER_OPACITY = 0.4;
/** drawn before every other transparent object (see the header) */
export const SPLAT_RENDER_ORDER = -1000;

/** a box SDF over `min`..`max`, field inches. ⚠️ Spark's box is centred on the SDF and its SCALE IS
 * THE HALF-SIZE (`abs(p) - sizes` in its shader): a full-size scale hid the whole capture. */
function boxSdf(min: readonly number[], max: readonly number[]): SplatEditSdf {
  const sdf = new SplatEditSdf({ type: SplatEditSdfType.BOX, opacity: 0 });
  sdf.position.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
  sdf.scale.set((max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2);
  return sdf;
}

/**
 * BUILD the venue group round a splat mesh: Spark's renderer (drawn first among the transparents),
 * the mesh, the two hiding edits and the shadow catcher. `source` is the row's file, or a
 * `constructSplats` callback (the RENDER harness's synthetic capture).
 */
export async function loadSplatVenue(
  v: SplatVenue,
  renderer: THREE.WebGLRenderer,
  source?: (splats: PackedSplats) => void,
): Promise<THREE.Group> {
  const g = new THREE.Group();
  g.name = 'bb-venue-splat';
  g.userData.splatVenue = true;
  const spark = new SparkRenderer({ renderer });
  spark.renderOrder = SPLAT_RENDER_ORDER;
  g.add(spark);
  const url = venueAssetUrl(v.file);
  if (!source && venueBlocked(url, Date.now())) throw new Error(`${v.file}: blocked after repeated failures`);
  const mesh = source ? new SplatMesh({ constructSplats: source }) : new SplatMesh({ url });
  mesh.position.set(...v.transform.position);
  mesh.quaternion.set(...v.transform.quaternion);
  mesh.scale.setScalar(v.transform.scale);
  try {
    await mesh.initialized;
  } catch (err) {
    if (!source) noteVenueFailure(url, Date.now());
    mesh.dispose();
    spark.dispose();
    throw err;
  }
  g.add(mesh);
  const edit = new SplatEdit({ rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY, softEdge: 0, sdfSmooth: 0 });
  for (const b of splatHiddenBoxes(v.cameraRoom)) edit.addSdf(boxSdf(b.min, b.max));
  g.add(edit);
  const reachX = BB_HALF_X + CATCHER_REACH_IN;
  const reachY = BB_HALF_Y + CATCHER_REACH_IN;
  const catcher = new THREE.Mesh(new THREE.PlaneGeometry(reachX * 2, reachY * 2), new THREE.ShadowMaterial({ opacity: CATCHER_OPACITY }));
  catcher.name = 'bb-venue-splat-catcher';
  catcher.position.z = GROUND_Z + 0.05;
  catcher.receiveShadow = true;
  g.add(catcher);
  g.userData.dispose = (): void => {
    mesh.dispose();
    spark.dispose();
  };
  return g;
}
