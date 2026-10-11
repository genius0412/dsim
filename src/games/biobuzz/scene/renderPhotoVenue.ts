import * as THREE from 'three';
import { BB_HALF_X, BB_HALF_Y } from '../config';
import type { EnvironmentDef, PhotoVenue } from '../graphics/environments';
import type { GraphicsSettings, GraphicsTier } from '../graphics/settings';

/**
 * THE PHOTOGRAPHED VENUE (2026-10-10) — a real room around the field, from a panorama.
 *
 * Owner: "Please add actual good quality scenes for backgrounds." Every surround before this was
 * `renderVenue.ts`'s procedural box room; the two photographs the environment list had were only
 * lighting the field, because that geometry hid them.
 *
 * ── HOW A PANORAMA BECOMES A ROOM THE FIELD STANDS IN ───────────────────────────────────────
 * A panorama is light arriving at ONE point from every direction. Drawn as a background (a dome
 * at infinity) it has no parallax and no ground; drawn on a sphere it has parallax but the floor
 * curves away. So it is PROJECTED, per fragment, onto a proxy of the room it was taken in: every
 * fragment of the proxy looks up the photograph along the ray from the CAPTURE POINT to itself.
 * The proxy here is a box — the floor `height` below the lens, the four walls where the real
 * walls are (`PhotoVenue.room`, read off the photograph's own floor/wall junctions) — so the
 * floor, its scale and its parallax are exact from any camera, and so are the walls. The capture
 * point is the field's centre, so the tripod patch at the nadir is under the field. Only the
 * furniture is wrong: a chair is drawn where its ray meets the floor or a wall.
 *
 * This is three's `GroundedSkybox` idea (a sphere flattened to a floor at the lens height) with a
 * box in place of the sphere. The sphere was worked through and rejected: it has to clear the
 * camera's reach (660 in), so every wall nearer than that leaves its own base smeared across the
 * floor — in the events hall the lowest 33 in of a side wall 318 in out stretched over the 339 in
 * of floor beyond it — and from a driver 150 in off-centre that hall's far side wall (515 in away)
 * would draw as if 810 in away, at 0.64 of its size. Halls are boxes; a box puts each wall where
 * it is.
 *
 * ── AND THE ROOM IS SMALLER THAN THE CAMERAS CAN REACH ──────────────────────────────────────
 * The real rooms are 208–882 in from the lens to a wall, and the orbit camera zooms to 620 in and
 * rises to 637 (`renderCameras.ts`). A camera outside a `BackSide` box sees through the wall it is
 * behind, which is the bug `VENUE_MIN_HALF` exists for, and a box that moved its wall out past the
 * eye showed that wall's base stretched across the floor for a third to a half of the frame. Two
 * rules, so neither happens:
 *   • THE ORBIT AND FREE CAMERAS STAY IN THE ROOM (2026-10-11). `photoCameraRoom` is the room less
 *     `PUSH_MARGIN_IN`, handed to `BbCameras.setRoom`; their boom shortens to stay inside it.
 *   • THE BOX GROWS AROUND ANY OTHER CAMERA, in the vertex shader: a wall (or the ceiling) the eye
 *     is within `PUSH_MARGIN_IN` of moves out to keep it inside, per camera and per pass
 *     (`cameraPosition` is whichever camera is drawing). That is the overhead and minimap shots
 *     above the ceiling (orthographic, straight down, so a wall is seen edge-on), a driver on a
 *     portrait phone 20 in from the school hall's −x wall, a raised chase eye under the quad's
 *     canopy — each within the margin or above the roof, never looking back across a moved wall.
 *
 * ── WHAT ELSE IS HERE ───────────────────────────────────────────────────────────────────────
 * The field's shadow on the photographed floor (`ShadowMaterial`, the sun's own map), and a soft
 * contact band around the perimeter's foot: without the two the field floats on the photograph.
 *
 * Nothing here casts, nothing writes `bloomBase` (bloom is selective, and a photograph is not a
 * lamp), and the proxy is `BackSide` and the two overlays `depthWrite: false`, so GTAO's G-buffer
 * pass leaves all three out (`renderPost.ts`).
 */

/** the photographed floor's z: the procedural ground's (`renderVenue.ts`), under the CAD's own
 * alliance-area tape at −0.589 */
export const PHOTO_FLOOR_Z = -0.75;

/** how close an eye may come to a wall (or the ceiling) before it moves out — see the header */
export const PUSH_MARGIN_IN = 30;

/**
 * THE PHOTOGRAPH WITH THE ENVIRONMENT LIGHTING OFF (Low and Medium's `envLighting`), as a share
 * of itself with it on — an exposure change on the whole photograph, so the highlight knee moves
 * with it. The projection is unlit (it is the room's own light), so without this it kept its
 * Extreme brightness while the field it surrounds lost the IBL: the events hall's floor stood
 * 54 × the mat at Low (0.488 against 0.009 rendered). The procedural rooms' floors stand 9–18 ×
 * theirs at Low (room 0.114 / 0.0128, gym 0.189 / 0.0103); at 0.6 the five photographs stand
 * 7–14 × (events hall 0.135 / 0.0096). ACES's toe makes the rendered floor fall faster than the
 * scale: 0.3 put the events hall at 0.048, 5 × its mat.
 */
export const PHOTO_NO_IBL_DIM = 0.6;

/** the decoded backdrop's ceiling: the top code of the stored curve, `e / (1 − e)` at e = 254/255 */
const E_MAX = 0.996;

/**
 * THE HIGHLIGHT KNEE, in the decoded photograph's linear units (after `intensity`). Below it the
 * photograph is drawn as it is; above it the excess is rolled off toward twice the knee. A window,
 * a doorway into sunlight or a lamp stays the brightest thing IN THE ROOM and stops competing with
 * the field's own lit white panels (1.2–1.7 raw): before the knee the events hall's windows and
 * the school hall's open door reached 5–50 raw and drew as large flat-white areas on either side
 * of the field. The floors (medians 0.17–0.31) are untouched.
 */
export const PHOTO_KNEE = 0.6;

/** the backdrop size a device gets. The 4k (44.7 MB of GPU memory with mipmaps) on High and up;
 * the 2k (11.2 MB) on Low and Medium, with `meshDetail: 'low'`, and on a GPU whose largest
 * texture is under 4096. */
export type BbPhotoDetail = 'hi' | 'lo';

export function bbPhotoDetail(
  settings: Pick<GraphicsSettings, 'meshDetail'>,
  tier: GraphicsTier,
  maxTextureSize: number,
): BbPhotoDetail {
  if (settings.meshDetail === 'low' || tier === 'low' || tier === 'medium') return 'lo';
  return maxTextureSize >= 4096 ? 'hi' : 'lo';
}

/** a `public/` path → a URL, through Vite's base (the Electron build's is `./`, under which a
 * bare `/venues/…` resolves at the filesystem root and 404s silently) */
export function venueAssetUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const env = (import.meta as { env?: { BASE_URL?: string } }).env;
  const base = (env?.BASE_URL ?? '/').replace(/\/+$/, '');
  return `${base}/${path.replace(/^\/+/, '')}`;
}

/** the room box in field inches: x/y from the capture point (the field's centre), z from the floor */
export function photoRoomBox(p: PhotoVenue): { min: [number, number, number]; max: [number, number, number] } {
  return {
    min: [p.room.x0, p.room.y0, PHOTO_FLOOR_Z],
    max: [p.room.x1, p.room.y1, PHOTO_FLOOR_Z + p.room.ceil],
  };
}

/** the room the orbit and free cameras are held inside (`BbCameras.setRoom`): the real walls and
 * ceiling less `PUSH_MARGIN_IN`, so the vertex shader's push never moves a wall for them */
export function photoCameraRoom(p: PhotoVenue): { min: [number, number, number]; max: [number, number, number] } {
  const b = photoRoomBox(p);
  return {
    min: [b.min[0] + PUSH_MARGIN_IN, b.min[1] + PUSH_MARGIN_IN, b.min[2]],
    max: [b.max[0] - PUSH_MARGIN_IN, b.max[1] - PUSH_MARGIN_IN, b.max[2] - PUSH_MARGIN_IN],
  };
}

/** how far inside the sun's shadow frustum the catcher stops, light-space inches — see below */
export const CATCHER_INSET_IN = 4;

/**
 * THE SHADOW CATCHER IS THE SUN'S SHADOW FOOTPRINT: the floor inside the sun's shadow camera (a box
 * of ±(BB_HALF + 20) in light space, 1–260 in deep, `renderScene.ts`) — its four corner rays
 * followed along the light to the floor, then cut where the floor leaves the box's depth. At the
 * rigs' 40–45° the footprint reaches 1.4–1.6 × the square along the sun's azimuth, and a catcher
 * the size of the square (±96 in) cut the hive crossbar's shadow off in a straight line. It stops
 * `CATCHER_INSET_IN` inside every face: one that reached the far face drew it, a one-pixel dark
 * line across the floor where that face meets it (seen at Extreme in the events hall, ~120 in out
 * on the side away from the sun, where the far face reaches the floor at 118). Read off the live
 * light, so the camera's own turn about the light axis is whatever three gives it.
 * Returns the polygon's floor points, counter-clockwise seen from above.
 */
export function shadowFootprint(sun: THREE.DirectionalLight, z: number, inset = CATCHER_INSET_IN): [number, number][] {
  sun.updateMatrixWorld(true);
  sun.target.updateMatrixWorld(true);
  sun.shadow.updateMatrices(sun);
  const cam = sun.shadow.camera as THREE.OrthographicCamera;
  const dir = cam.getWorldDirection(new THREE.Vector3());
  const eye = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
  let poly: [number, number][] = [];
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ]) {
    const x = sx < 0 ? cam.left + inset : cam.right - inset;
    const y = sy < 0 ? cam.bottom + inset : cam.top - inset;
    const p = new THREE.Vector3(x, y, -cam.near).applyMatrix4(cam.matrixWorld);
    const t = (z - p.z) / dir.z;
    poly.push([p.x + dir.x * t, p.y + dir.y * t]);
  }
  // depth along the light, linear on the floor: cut the quad to [near + inset, far − inset]
  const depth = ([x, y]: [number, number]): number => (x - eye.x) * dir.x + (y - eye.y) * dir.y + (z - eye.z) * dir.z;
  for (const [lim, sign] of [
    [cam.near + inset, 1],
    [cam.far - inset, -1],
  ] as const) {
    const keep = (q: [number, number]): number => sign * (depth(q) - lim);
    const next: [number, number][] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const ka = keep(a);
      const kb = keep(b);
      if (ka >= 0) next.push(a);
      if (ka >= 0 !== kb >= 0) {
        const t = ka / (ka - kb);
        next.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    poly = next;
  }
  const area = poly.reduce((s, [x, y], i) => s + x * poly[(i + 1) % poly.length][1] - poly[(i + 1) % poly.length][0] * y, 0);
  return area < 0 ? poly.reverse() : poly;
}

/**
 * THE PROXY BOX AS A GIVEN EYE SEES IT — the vertex shader's push (`VERT` below), in plain
 * numbers, so the RENDER lane can walk every camera's reach through it without a GL context. The
 * GLSL and this must say the same thing; the lane checks the shader's text as well.
 */
export function pushedRoomBox(
  box: { min: readonly number[]; max: readonly number[] },
  eye: readonly [number, number, number],
  margin = PUSH_MARGIN_IN,
): { min: [number, number, number]; max: [number, number, number] } {
  return {
    min: [Math.min(box.min[0], eye[0] - margin), Math.min(box.min[1], eye[1] - margin), box.min[2]],
    max: [Math.max(box.max[0], eye[0] + margin), Math.max(box.max[1], eye[1] + margin), Math.max(box.max[2], eye[2] + margin)],
  };
}

/** the panorama coordinate of a world direction — the fragment shader's lookup (`FRAG`), with `v`
 * from the image's TOP row (the backdrop is uploaded `flipY: false`) */
export function photoUv(dx: number, dy: number, dz: number): [number, number] {
  const n = Math.hypot(dx, dy, dz) || 1;
  return [Math.atan2(-dy / n, dx / n) / (2 * Math.PI) + 0.5, 0.5 - Math.asin(Math.max(-1, Math.min(1, dz / n))) / Math.PI];
}

// ────────────────────────────────────────────────────────────────────────────── the loader ──

/**
 * BACKDROPS THAT HAVE ALREADY FAILED TO LOAD IN THIS DOCUMENT — the same bargain the HDRI loader
 * makes (`renderEnvironment.ts`'s `failedHdri`): module scope, because whether a URL loads is a
 * property of the network and not of a scene; two tries, then the procedural venue stays; and the
 * count expires, so a blip in a long Electron run does not cost the photograph until a restart.
 */
const PHOTO_MAX_TRIES = 2;
const PHOTO_RETRY_MS = 5 * 60_000;
const failedPhoto = new Map<string, { n: number; at: number }>();

/** has `url` failed often enough, recently enough, not to be asked again */
export function photoBlocked(url: string, now = Date.now()): boolean {
  const f = failedPhoto.get(url);
  if (!f) return false;
  if (now - f.at >= PHOTO_RETRY_MS) {
    failedPhoto.delete(url);
    return false;
  }
  return f.n >= PHOTO_MAX_TRIES;
}

/** record a failed load of `url` (exported for the RENDER lane) */
export function notePhotoFailure(url: string, now = Date.now()): void {
  const f = failedPhoto.get(url);
  failedPhoto.set(url, { n: (f?.n ?? 0) + 1, at: now });
}

/**
 * LOAD one backdrop as a texture. Decoded off the main thread where the browser can
 * (`createImageBitmap`): a 4096 × 2048 WebP decoded at upload is a visible hitch. Rejects on any
 * failure, and counts it (`photoBlocked`).
 *
 * The image is uploaded top row first (`flipY` false, which is what an `ImageBitmap` gets
 * anyway), and the projection shader samples it that way. The bitmap is closed once it is on the
 * GPU: 32 MB of CPU memory for a texture nothing re-uploads (the anisotropy is set here, once).
 */
export async function loadPhotoBackdrop(path: string, anisotropy: number): Promise<THREE.Texture> {
  const url = venueAssetUrl(path);
  let tex: THREE.Texture;
  try {
    if (typeof createImageBitmap === 'function') {
      const bitmap = await new THREE.ImageBitmapLoader().setOptions({ premultiplyAlpha: 'none' }).loadAsync(url);
      tex = new THREE.Texture(bitmap);
      tex.onUpdate = (): void => {
        bitmap.close();
      };
      // and when the texture is freed without ever being uploaded (the player picked another
      // venue while this one decoded): `close` twice is a no-op
      tex.addEventListener('dispose', () => bitmap.close());
    } else {
      tex = await new THREE.TextureLoader().loadAsync(url);
    }
  } catch (err) {
    notePhotoFailure(url);
    throw err;
  }
  failedPhoto.delete(url);
  tex.name = path;
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = Math.max(1, anisotropy);
  tex.needsUpdate = true;
  return tex;
}

// ─────────────────────────────────────────────────────────────────────────── the projection ──

const VERT = /* glsl */ `
uniform vec3 bbBoxMin;
uniform vec3 bbBoxMax;
uniform float bbMargin;
varying vec3 vWorld;
void main() {
	// the TRUE room, grown around the camera that is drawing (see the header). The floor never
	// moves: it is the one surface whose height the photograph fixes.
	vec3 c = 0.5 * ( bbBoxMin + bbBoxMax );
	vec3 hi = max( bbBoxMax, cameraPosition + bbMargin );
	vec3 lo = min( bbBoxMin, cameraPosition - bbMargin );
	vec3 w = vec3(
		position.x > c.x ? hi.x : lo.x,
		position.y > c.y ? hi.y : lo.y,
		position.z > c.z ? hi.z : bbBoxMin.z
	);
	vWorld = w;
	gl_Position = projectionMatrix * viewMatrix * vec4( w, 1.0 );
}`;

const FRAG = /* glsl */ `
uniform sampler2D bbMap;
uniform vec3 bbEye;
uniform float bbScale;
uniform float bbSat;
uniform float bbKnee;
varying vec3 vWorld;
#define BB_E_MAX ${E_MAX}
void main() {
	vec3 d = normalize( vWorld - bbEye );
	// three's equirect convention as this z-up scene samples it through MAP_ROT
	// (renderEnvironment.ts): +x at u = 0.5, u grows clockwise seen from above, the zenith at the
	// image's top row. The light-gathering .hdr is the same panorama, turned the same way, so the
	// two agree by construction.
	float u = atan( - d.y, d.x ) * 0.15915494309 + 0.5;
	float v = 0.5 - asin( clamp( d.z, - 1.0, 1.0 ) ) * 0.31830988618;
	vec2 uv = vec2( u, v );
	// THE SEAM. u jumps from 1 to 0 at the panorama's edge, so its screen derivative spikes there
	// and the sampler drops to the smallest mip: a one-pixel line down every wall. The same
	// derivative taken from u shifted half a turn is continuous at that edge; take the smaller.
	vec2 dx = dFdx( uv );
	vec2 dy = dFdy( uv );
	float ax = dFdx( fract( u + 0.5 ) );
	float ay = dFdy( fract( u + 0.5 ) );
	if ( abs( ax ) < abs( dx.x ) ) dx.x = ax;
	if ( abs( ay ) < abs( dy.x ) ) dy.x = ay;
	vec3 e = min( textureGrad( bbMap, uv, dx, dy ).rgb, vec3( BB_E_MAX ) );
	// the stored curve inverted (scripts/venues/derive.cjs, ENCODING), then the dim
	vec3 x = e / ( 1.0 - e ) * bbScale;
	float l = dot( x, vec3( 0.2126, 0.7152, 0.0722 ) );
	// the knee (PHOTO_KNEE), on luminance so a window keeps its colour
	float k = l > bbKnee ? bbKnee + ( l - bbKnee ) / ( 1.0 + ( l - bbKnee ) / bbKnee ) : l;
	x *= k / max( l, 1e-6 );
	gl_FragColor = vec4( mix( vec3( k ), x, bbSat ), 1.0 );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`;

/** the soft band around the perimeter's foot: from the wall's face out to `CONTACT_IN`, darkest
 * at the wall. Measured against the field's own shadow on the floor, not tuned to look dramatic. */
const CONTACT_IN = 16;
const CONTACT_ALPHA = 0.32;

function buildContact(): THREE.Mesh {
  // eight quads round a rectangle: an inner edge at the perimeter, an outer at +CONTACT_IN, alpha
  // from CONTACT_ALPHA to 0. The four corners are fanned so the falloff stays round there.
  const ix = BB_HALF_X + 1;
  const iy = BB_HALF_Y + 1;
  const pos: number[] = [];
  const col: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[], aa: number, ab: number, ac: number, ad: number): void => {
    for (const [p, al] of [
      [a, aa],
      [b, ab],
      [c, ac],
      [a, aa],
      [c, ac],
      [d, ad],
    ] as [number[], number][]) {
      pos.push(p[0], p[1], 0);
      col.push(0, 0, 0, al);
    }
  };
  const A = CONTACT_ALPHA;
  const o = CONTACT_IN;
  // sides
  quad([-ix, -iy - o], [ix, -iy - o], [ix, -iy], [-ix, -iy], 0, 0, A, A);
  quad([-ix, iy], [ix, iy], [ix, iy + o], [-ix, iy + o], A, A, 0, 0);
  quad([-ix - o, -iy], [-ix, -iy], [-ix, iy], [-ix - o, iy], 0, A, A, 0);
  quad([ix, -iy], [ix + o, -iy], [ix + o, iy], [ix, iy], A, 0, 0, A);
  // corners: a fan of thin wedges from the corner point
  const SEG = 6;
  for (const [sx, sy] of [
    [1, 1],
    [-1, 1],
    [-1, -1],
    [1, -1],
  ]) {
    const cx = sx * ix;
    const cy = sy * iy;
    const a0 = Math.atan2(sy, sx) - Math.PI / 4;
    for (let k = 0; k < SEG; k++) {
      const t0 = a0 + (k / SEG) * (Math.PI / 2);
      const t1 = a0 + ((k + 1) / SEG) * (Math.PI / 2);
      for (const [p, al] of [
        [[cx, cy], A],
        [[cx + Math.cos(t0) * o, cy + Math.sin(t0) * o], 0],
        [[cx + Math.cos(t1) * o, cy + Math.sin(t1) * o], 0],
      ] as [number[], number][]) {
        pos.push(p[0], p[1], 0);
        col.push(0, 0, 0, al);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  geo.computeBoundingSphere();
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'bb-venue:photo-contact';
  mesh.position.z = PHOTO_FLOOR_Z + 0.06;
  mesh.renderOrder = 1;
  return mesh;
}

/** the decode's linear scale: the encode `gain` divided back out, the row's dim, and the no-IBL dim
 * (`PHOTO_NO_IBL_DIM`) when the environment lighting is off */
export function photoScale(p: PhotoVenue, ibl: boolean): number {
  return (p.intensity / p.gain) * (ibl ? 1 : PHOTO_NO_IBL_DIM);
}

/** the highlight knee for the environment-lighting row: `PHOTO_KNEE`, dimmed with the rest */
export function photoKnee(ibl: boolean): number {
  return PHOTO_KNEE * (ibl ? 1 : PHOTO_NO_IBL_DIM);
}

/** re-apply `photoScale` and `photoKnee` to a built photographed venue when the
 * environment-lighting row changes (a rebuild would refetch and re-decode the backdrop); a no-op
 * for any other venue */
export function setPhotoVenueLighting(venue: THREE.Object3D | null, def: EnvironmentDef, ibl: boolean): void {
  if (!def.photo || venue?.userData.photo !== def.id) return;
  const room = venue.getObjectByName('bb-venue:photo') as THREE.Mesh | undefined;
  const mat = room?.material as THREE.ShaderMaterial | undefined;
  if (!mat?.uniforms?.bbScale) return;
  mat.uniforms.bbScale.value = photoScale(def.photo, ibl);
  mat.uniforms.bbKnee.value = photoKnee(ibl);
}

/**
 * BUILD the photographed venue for `def` around an already-loaded backdrop. One group, freed with
 * `disposeObject3D` — EXCEPT the backdrop texture, which is a uniform and so invisible to that
 * walk: the caller owns it and frees it with the venue (one 44.7 MB texture per live venue, never
 * two). `sun` is the scene's key light with this row's rig on it (the catcher is its shadow
 * footprint, `shadowFootprint`) and `ibl` the environment-lighting row (`photoScale`).
 */
export function buildPhotoVenue(def: EnvironmentDef, backdrop: THREE.Texture, sun: THREE.DirectionalLight, ibl: boolean): THREE.Group {
  const p = def.photo!;
  const group = new THREE.Group();
  group.name = 'bb-venue';
  group.userData.photo = def.id;

  const box = photoRoomBox(p);
  const size = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
  const geo = new THREE.BoxGeometry(size[0], size[1], size[2]);
  geo.translate((box.max[0] + box.min[0]) / 2, (box.max[1] + box.min[1]) / 2, (box.max[2] + box.min[2]) / 2);
  const mat = new THREE.ShaderMaterial({
    name: 'bb-venue:photo',
    uniforms: {
      bbMap: { value: backdrop },
      bbEye: { value: new THREE.Vector3(0, 0, PHOTO_FLOOR_Z + p.height) },
      bbBoxMin: { value: new THREE.Vector3(...box.min) },
      bbBoxMax: { value: new THREE.Vector3(...box.max) },
      bbMargin: { value: PUSH_MARGIN_IN },
      bbScale: { value: photoScale(p, ibl) },
      bbSat: { value: p.saturation },
      bbKnee: { value: photoKnee(ibl) },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.BackSide,
  });
  const room = new THREE.Mesh(geo, mat);
  room.name = 'bb-venue:photo';
  // the vertex shader moves the walls per camera, so no bounding volume holds; it surrounds the
  // eye anyway
  room.frustumCulled = false;
  room.castShadow = false;
  room.receiveShadow = false;
  group.add(room);

  // the field's shadow on the photographed floor — the sun's own map, so it is the shadow the mat
  // shows, continued out to (just inside) the edge of that map's footprint on the floor
  const z = PHOTO_FLOOR_Z + 0.04;
  const f = shadowFootprint(sun, z);
  const cg = new THREE.BufferGeometry();
  cg.setAttribute('position', new THREE.Float32BufferAttribute(f.flatMap(([x, y]) => [x, y, 0]), 3));
  cg.setAttribute('normal', new THREE.Float32BufferAttribute(f.flatMap(() => [0, 0, 1]), 3));
  // a convex polygon, counter-clockwise from above: a fan
  cg.setIndex(f.slice(2).flatMap((_, i) => [0, i + 1, i + 2]));
  cg.computeBoundingSphere();
  const catcher = new THREE.Mesh(cg, new THREE.ShadowMaterial({ opacity: p.shadow, depthWrite: false }));
  catcher.name = 'bb-venue:photo-shadow';
  catcher.position.z = z;
  catcher.receiveShadow = true;
  catcher.castShadow = false;
  group.add(catcher);

  group.add(buildContact());
  return group;
}

/** the backdrop texture a built photo venue is drawing, if `venue` is one */
export function photoBackdropOf(venue: THREE.Object3D | null): THREE.Texture | null {
  const room = venue?.getObjectByName('bb-venue:photo') as THREE.Mesh | undefined;
  const mat = room?.material as THREE.ShaderMaterial | undefined;
  return (mat?.uniforms?.bbMap?.value as THREE.Texture | undefined) ?? null;
}
