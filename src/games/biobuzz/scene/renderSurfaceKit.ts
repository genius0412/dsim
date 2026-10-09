import * as THREE from 'three';
import type { DetailKind, Finish, FinishDetail } from '../graphics/finishes';

/**
 * THE PHYSICAL-MATERIALS KIT — everything the `materials: 'physical'` row's appliers share:
 * procedural detail textures, ONE shader patch for every physical twin, and the swap/revert
 * bookkeeping. Part of the LAZY `renderSurfaces` chunk: imported only by `renderSurfaces.ts`
 * and its `renderSurface*.ts` siblings, never by anything the scene chunk loads eagerly, so
 * Rollup keeps it in the same lazy file (`bundleaudit`'s `surfaces` route).
 *
 * ── THE ONE RULE: A TWIN, NEVER AN EDIT ─────────────────────────────────────────────────────
 * The base materials are SHARED. A robot's `solidMat` is one module-global object used by the
 * match, the builder preview, the thumbnails, the gallery and the fixed-High replay export at
 * once, and a fixed-tier scene does not even subscribe to settings. So physical mode never writes
 * a single property on a base material: it builds a `MeshPhysicalMaterial` TWIN from it, parks the
 * base on `mesh.userData.bbBaseMat` and points the MESH at the twin. Reverting is the reverse
 * assignment. Standard mode is therefore pixel-identical by construction — the base objects are
 * byte-for-byte what they always were — and the only cost of having been physical once is the
 * cached twins.
 *
 * ── A TWIN IGNORES `dispose()` ──────────────────────────────────────────────────────────────
 * ⚠️ Twins live in caches that outlive the meshes they are put on: a robot group is thrown away
 * on every spec change (`disposeRobotGroup`) and the venue on every environment change
 * (`disposeObject3D`), and both walks dispose whatever material a mesh is holding. A disposed
 * twin that other robots are still drawing with loses its program, and three RECOMPILES it on
 * the next frame — a hitch per rebuild that would read as "physical mode stutters". So a twin's
 * own `dispose` is a no-op and only this kit frees one (`releaseTwin`), when the cache that made
 * it says its base is gone for good. The walks were not changed to know about twins, on purpose:
 * standard mode must not depend on a chunk that may never have loaded.
 */

// ═══════════════════════════════════════════════════════════════ the shared uniforms ══

/**
 * THE PROBE AND SPECULAR UNIFORMS, SHARED BY EVERY TWIN IN THE DOCUMENT — one object each, so a
 * write reaches every program with no recompile (the same trick as `renderFieldGlb.ts`'s
 * `PANEL_OUTPUT_CAP`).
 *
 * AT REST (`lowerSurfaceUniforms`) THEY ARE INERT: the probe is off and `bbProbeMap` is null (three
 * binds its empty texture for a null sampler), and `bbSpecIbl` is 1, which is exactly three's own
 * image-based specular. A scene raises them for ITS OWN scene pass only and lowers them straight
 * after (`renderSurfaceProbe.ts`'s `raise`/`lower`), because the twins are shared with scenes on
 * OTHER GL contexts (the builder preview, a thumbnail), and a render target from one context is
 * not a texture in another. JavaScript is single-threaded, so nothing else can draw between the
 * raise and the lower.
 */
export const SURFACE_UNIFORMS = {
  bbProbeMap: { value: null as THREE.Texture | null },
  bbProbeOn: { value: 0 },
  bbProbeMin: { value: new THREE.Vector3() },
  bbProbeMax: { value: new THREE.Vector3() },
  bbProbePos: { value: new THREE.Vector3() },
  /** the probe's EXPOSURE, one scalar per half of the sphere (upper for a reflected ray pointing
   * up from the probe, lower for one pointing down, blended across the horizon). The drawn room
   * carries a third of the light the scene is actually lit by — see `renderSurfaceProbe.ts`'s
   * `probeGains` for the measurement and the rule — so the probe keeps the room's SHAPE and
   * colour and takes its ENERGY from the lighting. 1 at rest, and only ever read under
   * `bbProbeOn`. */
  bbProbeGainUp: { value: 1 },
  bbProbeGainDown: { value: 1 },
  /** the probe's WHITE BALANCE, per half, beside the gain: a luminance-1 RGB factor that turns the
   * drawn room's tint into the tint of the light the paint beside the metal is lit by (`probeGains`
   * again). (1, 1, 1) at rest. */
  bbProbeTintUp: { value: new THREE.Vector3(1, 1, 1) },
  bbProbeTintDown: { value: new THREE.Vector3(1, 1, 1) },
  /** the `reflections` row, for real: it scales the image-based SPECULAR of every twin (the dome's
   * or the probe's), and never the diffuse irradiance, which is the `envLighting` row's job. The
   * standard materials' `envMapIntensity` write in `tuneMaterials` is a no-op in three 0.186 (it
   * is read only when `material.envMap` is set, and nothing sets one); this is the working path. */
  bbSpecIbl: { value: 1 },
};

/** put every shared uniform back at rest — see `SURFACE_UNIFORMS`. Cannot throw. */
export function lowerSurfaceUniforms(): void {
  SURFACE_UNIFORMS.bbProbeOn.value = 0;
  SURFACE_UNIFORMS.bbProbeMap.value = null;
  SURFACE_UNIFORMS.bbProbeGainUp.value = 1;
  SURFACE_UNIFORMS.bbProbeGainDown.value = 1;
  SURFACE_UNIFORMS.bbProbeTintUp.value.set(1, 1, 1);
  SURFACE_UNIFORMS.bbProbeTintDown.value.set(1, 1, 1);
  SURFACE_UNIFORMS.bbSpecIbl.value = 1;
}

// ═════════════════════════════════════════════════════════ procedural surface detail ══

/** the detail tile's edge, texels. 256² RGBA8 is 256 KB (341 with mips) per KIND, shared by every
 * material and every scene that uses it; nine kinds cost ~3 MB at most. */
export const DETAIL_TEX = 256;

/** DETERMINISTIC hash — the one `renderTiles.ts`, `renderVenue.ts` and `renderEnvironment.ts`
 * each carry a private copy of; the same surface on every machine and in every exported frame. */
export function surfaceRand(i: number): number {
  let t = (i * 0x9e3779b1) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * TILEABLE VALUE NOISE on a `gx` × `gy` lattice over the unit square — every lattice index is
 * taken modulo its own grid, so the tile wraps seamlessly on both axes. Separate grids per axis
 * are what make a DIRECTIONAL relief (die lines, wood grain: few cells along the part, many
 * across it) out of the same function as an isotropic one. Smoothstep-interpolated, output 0–1.
 */
export function tileNoise(gx: number, gy: number, seed: number): (u: number, v: number) => number {
  const at = (i: number, j: number): number =>
    surfaceRand((((i % gx) + gx) % gx) * 92837 + (((j % gy) + gy) % gy) * 689287 + seed * 7919);
  return (u, v) => {
    const x = u * gx;
    const y = v * gy;
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = x - i;
    const fy = y - j;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = at(i, j);
    const b = at(i + 1, j);
    const c = at(i, j + 1);
    const d = at(i + 1, j + 1);
    const top = a + (b - a) * sx;
    return top + (c + (d - c) * sx - top) * sy;
  };
}

const frac = (x: number): number => x - Math.floor(x);

/**
 * EACH KIND'S HEIGHT FIELD over one tile, 0–1. What the table (`graphics/finishes.ts`) decides is
 * the SIZE of a tile in inches; what is decided here is only the SHAPE inside it. Every recipe is
 * periodic on the unit square (integer lattices, integer sine frequencies), so no kind has a seam.
 * Directional kinds run their long axis along `u`; the shader patch maps `u` onto the part's axis.
 */
function heightFn(kind: DetailKind): (u: number, v: number) => number {
  switch (kind) {
    case 'stipple': {
      const a = tileNoise(24, 24, 1);
      const b = tileNoise(96, 96, 2);
      return (u, v) => 0.3 * a(u, v) + 0.7 * b(u, v);
    }
    case 'orangePeel': {
      // broad rounded swells and nothing sharp: the coat flowed before it cured
      const a = tileNoise(5, 5, 3);
      const b = tileNoise(11, 11, 4);
      return (u, v) => 0.75 * a(u, v) + 0.25 * b(u, v);
    }
    case 'extrusion': {
      // die lines: 3 cells ALONG the part, 128 across it, and a gentler band structure on top
      const a = tileNoise(3, 128, 5);
      const b = tileNoise(6, 40, 6);
      return (u, v) => 0.7 * a(u, v) + 0.3 * b(u, v);
    }
    case 'bead': {
      const a = tileNoise(32, 32, 7);
      const b = tileNoise(128, 128, 8);
      return (u, v) => 0.2 * a(u, v) + 0.8 * b(u, v);
    }
    case 'pips': {
      // a raised dome per cell, 8 × 8 to the tile, on a flat ground
      const n = 8;
      return (u, v) => {
        const du = frac(u * n) - 0.5;
        const dv = frac(v * n) - 0.5;
        const r = Math.sqrt(du * du + dv * dv) / 0.32;
        return r >= 1 ? 0 : (1 - r * r) ** 1.5;
      };
    }
    case 'weave': {
      // plain weave, 12 threads a tile: over/under alternates cell by cell, each thread rounded
      const n = 12;
      return (u, v) => {
        const over = (Math.floor(u * n) + Math.floor(v * n)) & 1;
        const across = Math.sin(Math.PI * frac(over ? v * n : u * n));
        return 0.35 + 0.55 * across * (over ? 1 : 0.8);
      };
    }
    case 'grain': {
      // growth lines along the board, warped by a slow field so they wander like wood does
      const warp = tileNoise(2, 6, 9);
      const fine = tileNoise(4, 160, 10);
      return (u, v) => 0.5 + 0.3 * Math.sin(2 * Math.PI * (40 * v + 3 * warp(u, v))) + 0.2 * (fine(u, v) - 0.5) * 2;
    }
    case 'speckle': {
      const a = tileNoise(16, 16, 11);
      const b = tileNoise(64, 64, 12);
      return (u, v) => {
        const s = b(u, v);
        const fleck = s < 0.55 ? 0 : s > 0.7 ? 1 : ((s - 0.55) / 0.15) ** 2;
        return 0.4 * a(u, v) + 0.6 * fleck;
      };
    }
    case 'layer': {
      // ten evenly spaced ridges across the tile (the table's 0.08 in tile → 0.008 in layers)
      return (_u, v) => 0.5 + 0.5 * Math.sin(2 * Math.PI * 10 * v);
    }
  }
}

/**
 * THE DETAIL TEXTURES, one per kind, for the life of the document. Shared by every twin in every
 * scene: they are DATA (no colour), so one upload per GL context serves all of them, and nothing
 * frees them, exactly like the robot module's shared caches.
 */
const DETAIL_CACHE = new Map<DetailKind, THREE.DataTexture>();
let detailAnisotropy = 1;

/**
 * THE 256² DETAIL TILE FOR `kind`, as `RGBA8` DATA:
 *   R, G — the surface SLOPE along u and v, normalised so the 98th percentile is ±1 and stored
 *          as `s * 0.5 + 0.5`. The table's `normal` is then a plain gain on a known range, the
 *          same number meaning the same tilt for every kind.
 *   B    — the height, stretched to 0–1: the roughness modulation (a raised fleck is more worn,
 *          a pore holds more dust — both read as the same sign of change).
 *   A    — 255, unused.
 * `NoColorSpace`, repeat-wrapped, mipmapped and linearly filtered: a slope map is data, and an
 * sRGB decode on it is the classic wrong-lighting bug.
 *
 * Pure arithmetic into a `Uint8Array` — no canvas — so it runs (and can be pinned) in the Node
 * smoke lanes, where the canvas stub has no image data. Null only if three itself refuses.
 */
export function detailTexture(kind: DetailKind): THREE.DataTexture | null {
  const hit = DETAIL_CACHE.get(kind);
  if (hit) return hit;
  try {
    const data = detailData(kind);
    const tex = new THREE.DataTexture(data, DETAIL_TEX, DETAIL_TEX, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.colorSpace = THREE.NoColorSpace;
    tex.anisotropy = detailAnisotropy;
    tex.name = `bb-detail:${kind}`;
    tex.needsUpdate = true;
    DETAIL_CACHE.set(kind, tex);
    return tex;
  } catch {
    return null;
  }
}

/** the raw bytes behind `detailTexture` — exported so the RENDER lane can measure a kind (its
 * slope range, that it tiles) without a GL context. */
export function detailData(kind: DetailKind): Uint8Array {
  const n = DETAIL_TEX;
  const h = heightFn(kind);
  const hs = new Float32Array(n * n);
  let lo = Infinity;
  let hi = -Infinity;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const v = h(x / n, y / n);
      hs[y * n + x] = v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  // central differences ON THE STORED GRID (wrapping), so the slope is exactly the tile's own and
  // the edges agree with the far side
  const sx = new Float32Array(n * n);
  const sy = new Float32Array(n * n);
  const mags: number[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const dx = hs[y * n + ((x + 1) % n)] - hs[y * n + ((x + n - 1) % n)];
      const dy = hs[((y + 1) % n) * n + x] - hs[((y + n - 1) % n) * n + x];
      // a normal leans AWAY from the uphill side
      sx[i] = -dx;
      sy[i] = -dy;
      if ((i & 7) === 0) mags.push(Math.abs(dx), Math.abs(dy));
    }
  }
  mags.sort((a, b) => a - b);
  const p98 = Math.max(1e-6, mags[Math.floor(mags.length * 0.98)] ?? 1e-6);
  const span = Math.max(1e-6, hi - lo);
  const out = new Uint8Array(n * n * 4);
  const byte = (s: number): number => Math.max(0, Math.min(255, Math.round((Math.max(-1, Math.min(1, s)) * 0.5 + 0.5) * 255)));
  for (let i = 0; i < n * n; i++) {
    out[i * 4] = byte(sx[i] / p98);
    out[i * 4 + 1] = byte(sy[i] / p98);
    out[i * 4 + 2] = Math.round(((hs[i] - lo) / span) * 255);
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** the anisotropy row, for the detail textures — `tuneMaterials` only reaches `.map`, and these are
 * uniforms. Clamped by the caller to the GPU's own maximum. Shared across scenes, so the last
 * scene to apply its settings wins, which on one device is the one setting there is. */
export function setDetailAnisotropy(n: number): void {
  detailAnisotropy = Math.max(1, n);
  for (const tex of DETAIL_CACHE.values()) {
    if (tex.anisotropy !== detailAnisotropy) {
      tex.anisotropy = detailAnisotropy;
      tex.needsUpdate = true;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════ the shader patch ══

/** where a twin's detail is sampled: `object` — in the mesh's own axes, scaled back to inches by
 * the model matrix, so the detail rides with a moving robot part; `world` — field inches, for
 * static surfaces and for INSTANCED ones (the venue's unit boxes are scaled per instance, which
 * `object` would stretch). */
export type DetailSpace = 'object' | 'world';

/** which axis a DIRECTIONAL detail's long direction follows: 0 = x, 1 = y, 2 = z. */
export type DetailAxis = 0 | 1 | 2;

export interface SurfacePatch {
  /** triplanar detail, or null for a finish that has none */
  detail: (FinishDetail & { space: DetailSpace; axis: DetailAxis }) | null;
  /** hook the ROOM PROBE into the specular IBL. Always true in the match; the preview's twins are
   * the same objects, and with the probe at rest the hook is the dome, exactly. */
  probe: boolean;
  /** apply the probe's EXPOSURE (`bbProbeGainUp`/`Down`). False only for a surface whose
   * reflection strength is itself a tuned legibility figure — see `TwinRecipe.probeExposure`. */
  exposure: boolean;
}

/**
 * THE PROJECTION PLANES' (u, v) AXES, per long axis. A projection onto the plane facing x has
 * y and z to work with, and so on; a directional detail wants its `u` along the part, so the
 * pair is ordered by the axis. Written as `#define`s because GLSL ES indexes a vector with a
 * constant only.
 */
const PLANE_AXES: Record<DetailAxis, [number, number, number, number, number, number]> = {
  // x-facing, y-facing, z-facing — (a, b) each
  0: [1, 2, 0, 2, 0, 1],
  1: [1, 2, 2, 0, 1, 0],
  2: [2, 1, 2, 0, 0, 1],
};

/**
 * THE PATCHED `getIBLRadiance`, built once from three's own chunk and checked, not assumed.
 *
 * Only the RADIANCE (the reflection) is redirected; `getIBLIrradiance`, the diffuse half, stays on
 * the dome, so every measured brightness and contrast figure in the RENDER lane (the mat's
 * luminance band, element contrast) is still the figure it was measured as. The anisotropic and
 * clearcoat paths both call `getIBLRadiance`, so they inherit the hook for free.
 *
 * `null` if three's chunk no longer has the two lines this replaces (an upgrade): the twins then
 * keep the dome's reflection, the probe does nothing, and the console says so once.
 */
const PATCHED_ENVMAP: string | null = (() => {
  const src = THREE.ShaderChunk.envmap_physical_pars_fragment;
  const start = src.indexOf('vec3 getIBLRadiance(');
  const end = start < 0 ? -1 : src.indexOf('#ifdef USE_RETROREFLECTION', start);
  if (start < 0 || end < 0) return null;
  let body = src.slice(start, end);
  const sample = 'vec4 envMapColor = textureCubeUV( envMap, envMapRotation * reflectVec, roughness );';
  const ret = 'return envMapColor.rgb * envMapIntensity;';
  if (!body.includes(sample) || !body.includes(ret)) return null;
  body = body.replace(
    sample,
    [
      '#ifdef BB_PROBE',
      // a WORLD-space capture, sampled with IDENTITY rotation: `envMapRotation` is the dome's
      // +π/2 z-up fix (`renderEnvironment.ts`'s `MAP_ROT`) and would lay the room on its side
      '\t\t\tvec4 envMapColor;',
      '\t\t\tif ( bbProbeOn > 0.5 ) {',
      '\t\t\t\tvec3 bbDir = bbProbeDir( reflectVec );',
      '\t\t\t\tenvMapColor = textureCubeUV( bbProbeMap, bbDir, roughness );',
      // the EXPOSURE, by the half of the probe the ray reads (`bbDir` is never zero-length), and
      // only on a ROUGH lobe. What the drawn room lacks is the energy of small bright sources — the
      // photograph's lamps are in the tens — and a wide lobe integrates them where a sharp one
      // would only ever show them as points. A sharp lobe lifted by the gain shows a wall BRIGHTER
      // than the wall itself, which no reflection can: at ×2.5 the maple's 0.12 coat turned the far
      // floor into a white glare. So a mirror reflects the room exactly as drawn, the gain is
      // fully on from roughness 0.45 (the metals, 0.35–0.4, get 82–95 % of it), the coat 3 %.
      // The white balance (`bbProbeTint*`) rides on the gain: it is the colour of the same light.
      '#ifndef BB_PROBE_RAW',
      '\t\t\t\tfloat bbHalf = smoothstep( -0.2, 0.2, normalize( bbDir ).z );',
      '\t\t\t\tvec3 bbGain = mix( bbProbeGainDown, bbProbeGainUp, bbHalf ) * mix( bbProbeTintDown, bbProbeTintUp, bbHalf );',
      '\t\t\t\tenvMapColor.rgb *= mix( vec3( 1.0 ), bbGain, smoothstep( 0.08, 0.45, roughness ) );',
      '#endif',
      '\t\t\t} else envMapColor = textureCubeUV( envMap, envMapRotation * reflectVec, roughness );',
      '#else',
      `\t\t\t${sample}`,
      '#endif',
    ].join('\n'),
  );
  body = body.replace(ret, 'return envMapColor.rgb * envMapIntensity * bbSpecIbl;');
  return src.slice(0, start) + body + src.slice(end);
})();

let warnedPatch = false;
function warnPatchOnce(what: string): void {
  if (warnedPatch) return;
  warnedPatch = true;
  // eslint-disable-next-line no-console
  console.warn(`[renderSurfaceKit] three's shader chunks changed shape (${what}); physical twins keep the dome's reflections.`);
}

/** the fragment-global declarations, placed just before the envmap chunk: after `vViewPosition`
 * and `textureCubeUV` exist, before anything calls into them. */
const FRAGMENT_DECLS = /* glsl */ `
uniform float bbSpecIbl;
#ifdef BB_PROBE
uniform sampler2D bbProbeMap;
uniform float bbProbeOn;
uniform vec3 bbProbeMin;
uniform vec3 bbProbeMax;
uniform vec3 bbProbePos;
uniform float bbProbeGainUp;
uniform float bbProbeGainDown;
uniform vec3 bbProbeTintUp;
uniform vec3 bbProbeTintDown;
// BOX PROJECTION (a parallax-corrected environment map): intersect the reflected ray from THIS
// fragment's world position with the room's box, and look the hit point up from where the probe
// was captured. Without it every metal reflects the room as if it stood at the probe's centre, and
// the lamp grid slides across a robot as it drives. Guarded three ways, because bloom's high pass
// is the only thing in the chain that would otherwise zero a NaN: a zero ray component divides by
// a positive epsilon (that axis then never limits the hit), a fragment OUTSIDE the box keeps the
// plain direction, and a hit that lands on the probe itself keeps the plain direction too.
vec3 bbProbeDir( const in vec3 dir ) {
\tvec3 wp = ( ( vec4( - vViewPosition, 1.0 ) - viewMatrix[ 3 ] ) * viewMatrix ).xyz;
\tvec3 d = normalize( dir );
\tif ( any( greaterThan( wp, bbProbeMax ) ) || any( lessThan( wp, bbProbeMin ) ) ) return d;
\tvec3 safe = mix( vec3( 1e-5 ), d, step( vec3( 1e-5 ), abs( d ) ) );
\tvec3 tf = max( ( bbProbeMax - wp ) / safe, ( bbProbeMin - wp ) / safe );
\tfloat t = max( min( min( tf.x, tf.y ), tf.z ), 0.0 );
\tvec3 r = wp + d * t - bbProbePos;
\treturn dot( r, r ) > 1e-6 ? r : d;
}
#endif
#ifdef BB_DETAIL
varying vec3 vBbPos;
varying vec3 vBbNrm;
uniform sampler2D bbDetailMap;
uniform float bbDetailFreq;
uniform float bbDetailNormal;
uniform float bbDetailRough;
// one projection's tilt, in VIEW space: its (u, v) gradients T and B (below) scaled to unit
// length the way three's own \`getTangentFrame\` scales them, times the stored slope
vec3 bbDetailTilt( const in vec3 T, const in vec3 B, const in vec2 s ) {
\tfloat d = max( dot( T, T ), dot( B, B ) );
\tfloat k = d > 0.0 ? inversesqrt( d ) : 0.0;
\treturn ( T * ( s.x * 2.0 - 1.0 ) + B * ( s.y * 2.0 - 1.0 ) ) * k;
}
#endif
`;

/**
 * TRIPLANAR DETAIL, after three's own normal maps: the geometry has no UVs (the field and element
 * GLBs carry POSITION only) and the robots' UVs run 0..1 per box face whatever its size, so the
 * detail is projected from inches instead.
 *
 * The tangent frame is three's `getTangentFrame` done ONCE for all three projections: with
 * `p` the detail coordinate, each projection's (u, v) is two components of `p`, so its screen
 * derivatives are components of `dFdx(p)`/`dFdy(p)` and the view-space gradient of detail axis k
 * is `q1perp · dp.x[k] + q0perp · dp.y[k]`. Three columns of one matrix, and each plane takes two.
 * No normal matrix is needed in the fragment shader (three does not declare one there), and it
 * works the same for object and world coordinates.
 *
 * The roughness modulation runs HERE too, not at `roughnessmap_fragment`: `roughnessFactor` is
 * still a plain local until the lights read it, and sampling once serves both.
 */
const FRAGMENT_DETAIL = /* glsl */ `
#ifdef BB_DETAIL
{
\tvec3 bbP = vBbPos * bbDetailFreq;
\tvec3 bbN = normalize( vBbNrm );
\tvec3 bbW = pow( abs( bbN ), vec3( 4.0 ) );
\tbbW /= max( bbW.x + bbW.y + bbW.z, 1e-5 );
\tvec3 bbDx = dFdx( bbP );
\tvec3 bbDy = dFdy( bbP );
\tvec3 bbQ0 = dFdx( - vViewPosition );
\tvec3 bbQ1 = dFdy( - vViewPosition );
\tvec3 bbQ1p = cross( bbQ1, normal );
\tvec3 bbQ0p = cross( normal, bbQ0 );
\tmat3 bbG = mat3( bbQ1p * bbDx.x + bbQ0p * bbDy.x, bbQ1p * bbDx.y + bbQ0p * bbDy.y, bbQ1p * bbDx.z + bbQ0p * bbDy.z );
\tvec4 bbSX = texture2D( bbDetailMap, vec2( bbP[ BB_XA ], bbP[ BB_XB ] ) );
\tvec4 bbSY = texture2D( bbDetailMap, vec2( bbP[ BB_YA ], bbP[ BB_YB ] ) );
\tvec4 bbSZ = texture2D( bbDetailMap, vec2( bbP[ BB_ZA ], bbP[ BB_ZB ] ) );
\tvec3 bbD = bbW.x * bbDetailTilt( bbG[ BB_XA ], bbG[ BB_XB ], bbSX.xy )
\t\t+ bbW.y * bbDetailTilt( bbG[ BB_YA ], bbG[ BB_YB ], bbSY.xy )
\t\t+ bbW.z * bbDetailTilt( bbG[ BB_ZA ], bbG[ BB_ZB ], bbSZ.xy );
\tnormal = normalize( normal + bbDetailNormal * bbD );
\tfloat bbR = dot( bbW, vec3( bbSX.z, bbSY.z, bbSZ.z ) );
\troughnessFactor = clamp( roughnessFactor * ( 1.0 + ( bbR - 0.5 ) * 2.0 * bbDetailRough ), 0.0, 1.0 );
}
#endif
`;

/** the detail coordinate and the normal the triplanar weights come from, in the patch's space. */
const VERTEX_DETAIL = /* glsl */ `
#ifdef BB_DETAIL
#if BB_DETAIL_WORLD == 1
\tvec4 bbWp = vec4( transformed, 1.0 );
\tvec3 bbWn = objectNormal;
\t#ifdef USE_INSTANCING
\t\tbbWp = instanceMatrix * bbWp;
\t\tbbWn = mat3( instanceMatrix ) * bbWn;
\t#endif
\tvBbPos = ( modelMatrix * bbWp ).xyz;
\tvBbNrm = mat3( modelMatrix ) * bbWn;
#else
\tvBbPos = transformed * vec3( length( modelMatrix[ 0 ].xyz ), length( modelMatrix[ 1 ].xyz ), length( modelMatrix[ 2 ].xyz ) );
\tvBbNrm = objectNormal;
#endif
#endif
`;

function replaceOnce(src: string, anchor: string, withText: string, what: string): string {
  if (!src.includes(anchor)) {
    warnPatchOnce(what);
    return src;
  }
  return src.replace(anchor, withText);
}

/**
 * INSTALL THE SURFACE PATCH on `twin`, composed over `base`'s own hook if it has one.
 *
 * ⚠️ COMPOSED, NOT REPLACED: the clear panels already carry an `onBeforeCompile` (their alpha,
 * sheen and veil) and a `customProgramCacheKey`; a twin of one calls the base hook FIRST and
 * extends its key, or three would hand one program to two different shaders. A base without a
 * hook of its own contributes nothing to the key.
 *
 * Per-material values (the detail's texture, frequency and gains) are UNIFORMS, not defines, so
 * every twin with the same patch shape shares one program. Only the SHAPE is in the key: detail
 * on/off, its space and axis, the probe hook.
 */
export function installSurfacePatch(twin: THREE.MeshPhysicalMaterial, base: THREE.Material, patch: SurfacePatch): void {
  const baseHook = base.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile ? base.onBeforeCompile : null;
  const baseKey = baseHook ? base.customProgramCacheKey() : '';
  const probe = patch.probe && PATCHED_ENVMAP !== null;
  const detailTex = patch.detail ? detailTexture(patch.detail.kind) : null;
  // a detail whose texture could not be made is simply not drawn — never a half-patched shader
  const d = detailTex ? patch.detail : null;
  const detailUniforms = d && detailTex
    ? {
        bbDetailMap: { value: detailTex as THREE.Texture },
        bbDetailFreq: { value: 1 / Math.max(1e-3, d.scaleIn) },
        bbDetailNormal: { value: d.normal },
        bbDetailRough: { value: d.rough },
      }
    : null;
  const raw = probe && !patch.exposure;
  const shape = `bbs1|${d ? `d${d.space === 'world' ? 'w' : 'o'}${d.axis}` : 'n'}|${probe ? (raw ? 'pr' : 'p') : 'n'}`;
  twin.customProgramCacheKey = (): string => `${baseKey}|${shape}`;
  twin.onBeforeCompile = (shader, renderer): void => {
    baseHook?.call(base, shader, renderer);
    const defs: string[] = [];
    if (probe) defs.push('#define BB_PROBE');
    if (raw) defs.push('#define BB_PROBE_RAW');
    if (detailUniforms && d) {
      const [xa, xb, ya, yb, za, zb] = PLANE_AXES[d.axis];
      defs.push(
        '#define BB_DETAIL',
        `#define BB_DETAIL_WORLD ${d.space === 'world' ? 1 : 0}`,
        `#define BB_XA ${xa}`,
        `#define BB_XB ${xb}`,
        `#define BB_YA ${ya}`,
        `#define BB_YB ${yb}`,
        `#define BB_ZA ${za}`,
        `#define BB_ZB ${zb}`,
      );
      Object.assign(shader.uniforms, detailUniforms);
      shader.vertexShader =
        `${defs.join('\n')}\nvarying vec3 vBbPos;\nvarying vec3 vBbNrm;\n` +
        replaceOnce(shader.vertexShader, '#include <begin_vertex>', `#include <begin_vertex>\n${VERTEX_DETAIL}`, 'begin_vertex');
    }
    Object.assign(shader.uniforms, SURFACE_UNIFORMS);
    let frag = `${defs.join('\n')}\n${shader.fragmentShader}`;
    // ONE patched chunk for both shapes: without `BB_PROBE` defined it samples the dome exactly as
    // three does, and the `bbSpecIbl` scale (the reflections row) applies either way
    frag = replaceOnce(
      frag,
      '#include <envmap_physical_pars_fragment>',
      `${FRAGMENT_DECLS}\n${PATCHED_ENVMAP ?? '#include <envmap_physical_pars_fragment>'}`,
      'envmap_physical_pars_fragment',
    );
    if (PATCHED_ENVMAP === null) warnPatchOnce('getIBLRadiance');
    if (detailUniforms) {
      frag = replaceOnce(frag, '#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${FRAGMENT_DETAIL}`, 'normal_fragment_maps');
    }
    shader.fragmentShader = frag;
  };
  twin.needsUpdate = true;
}

// ════════════════════════════════════════════════════════════════════════════ the twins ══

/** what an applier asks the kit for: a finish from the table plus how to lay it on this base. */
export interface TwinRecipe {
  /** the finish's table key — part of the cache key and the twin's name */
  id: string;
  finish: Finish;
  /** keep the base colour even where the finish names one (colour identity) */
  keepColor?: boolean;
  /** detail sampling space; default `object` */
  space?: DetailSpace;
  /** a directional detail's long axis; default x */
  axis?: DetailAxis;
  /** hook the room probe; default true */
  probe?: boolean;
  /**
   * take the probe's EXPOSURE (`renderSurfaceProbe.ts`'s `probeGains`). ONLY A METAL EVER DOES
   * (`finish.metalness === 1`); this can switch it off for one, never on for a dielectric.
   *
   * ⚠️ WHY METALS ONLY. A metal has no diffuse term, so the probe IS its whole appearance, and
   * without the exposure a clear-anodised plate in the school hall read dark bronze. A dielectric
   * already carries the scene's full lighting in its diffuse term and takes a few per cent of
   * the probe on top — and lifting that few per cent 2.5× is what washes the DARK surfaces the
   * driver reads against: measured at a robot close-up in the school hall, the black chassis
   * deck went from 30/255 (standard) to 78 with the probe as captured and 123 with the exposure,
   * a brown-grey; the tiles took a warm haze across the whole mat in the chase view, and the
   * near perimeter (a sheet the driver looks THROUGH) went to a cream veil over the robot behind.
   */
  probeExposure?: boolean;
  /** carry the finish's `anisotropy` onto the twin. OFF by default: three builds the anisotropic
   * tangent frame from `vUv` or a `tangent` attribute, the field GLBs have neither and the robots'
   * per-face box UVs point a different way on every face. The applier that turns it on owns
   * giving the geometry a frame that is right. */
  anisotropy?: boolean;
  /** the applier's last word, after the table (a map swap, a sheen colour) */
  tweak?: (twin: THREE.MeshPhysicalMaterial, base: THREE.Material) => void;
}

/** every twin this kit made, for `isTwin` */
const TWINS = new WeakSet<THREE.Material>();

export function isTwin(m: THREE.Material): boolean {
  return TWINS.has(m);
}

/** ACTUALLY free a twin (its own `dispose` is a no-op — see the header). */
export function releaseTwin(twin: THREE.Material): void {
  THREE.Material.prototype.dispose.call(twin);
}

/**
 * BUILD a physical twin of `base` from `recipe`, or `null` for a base that must not have one:
 * anything that is not a `MeshStandardMaterial` (the blob discs, the reticle, line materials), and
 * anything tagged `userData.bloomBase` — a lamp is a light fitting, not a finish, and a twin of
 * one would carry its emissive into the bloom list under a new identity.
 *
 * Everything the base says about HOW it is drawn (side, transparency, depth, polygon offset, its
 * maps, its emissive — which this never adds to) is copied by three's own `copy`; everything the
 * table says about WHAT it is made of then overwrites the surface model.
 */
export function makeTwin(base: THREE.Material, recipe: TwinRecipe): THREE.MeshPhysicalMaterial | null {
  const std = base as THREE.MeshStandardMaterial;
  if (!std.isMeshStandardMaterial) return null;
  if (typeof base.userData.bloomBase === 'number') return null;
  const twin = new THREE.MeshPhysicalMaterial();
  if ((base as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial) {
    twin.copy(base as THREE.MeshPhysicalMaterial);
  } else {
    // the STANDARD copy, not the physical one: `MeshPhysicalMaterial.copy` would read clearcoat,
    // sheen and the rest off a base that has none of them. It resets `defines` to a standard
    // material's, so the physical ones go back after it.
    (THREE.MeshStandardMaterial.prototype.copy as (this: THREE.MeshStandardMaterial, s: THREE.MeshStandardMaterial) => void).call(twin, std);
    twin.defines = { STANDARD: '', PHYSICAL: '' };
  }
  const f = recipe.finish;
  if (f.color !== undefined && !recipe.keepColor) twin.color.setHex(f.color);
  twin.roughness = f.roughness;
  twin.metalness = f.metalness;
  twin.ior = f.ior ?? 1.5;
  twin.clearcoat = f.clearcoat ?? 0;
  twin.clearcoatRoughness = f.clearcoatRoughness ?? 0;
  twin.sheen = f.sheen ?? 0;
  twin.sheenRoughness = f.sheenRoughness ?? 1;
  // cloth sheen is the fibre's own colour
  twin.sheenColor.copy(twin.color);
  twin.anisotropy = recipe.anisotropy ? f.anisotropy ?? 0 : 0;
  twin.envMapIntensity = 1;
  twin.name = `${base.name || base.type}|phys:${recipe.id}`;
  recipe.tweak?.(twin, base);
  installSurfacePatch(twin, base, {
    detail: f.detail ? { ...f.detail, space: recipe.space ?? 'object', axis: recipe.axis ?? 0 } : null,
    probe: recipe.probe !== false,
    exposure: recipe.probeExposure !== false && f.metalness === 1,
  });
  // see the header: only the kit frees a twin
  twin.dispose = (): void => {};
  TWINS.add(twin);
  return twin;
}

/**
 * A CACHE OF TWINS, per base material and recipe id. `releasable` caches (a scene's field and
 * venue, whose bases die with the scene) free their twins in `releaseAll`/`release`; a
 * non-releasable one (the robots', whose bases are module-global) keeps them for the page, exactly
 * as `renderRobots.ts` keeps its own `SHARED_MAT`.
 */
export class TwinCache {
  private readonly byBase = new WeakMap<THREE.Material, Map<string, THREE.MeshPhysicalMaterial | null>>();
  private readonly made = new Set<THREE.MeshPhysicalMaterial>();

  constructor(readonly releasable: boolean) {}

  get(base: THREE.Material, recipe: TwinRecipe): THREE.MeshPhysicalMaterial | null {
    let per = this.byBase.get(base);
    if (!per) {
      per = new Map();
      this.byBase.set(base, per);
    }
    if (per.has(recipe.id)) return per.get(recipe.id) ?? null;
    const twin = makeTwin(base, recipe);
    per.set(recipe.id, twin);
    if (twin) this.made.add(twin);
    return twin;
  }

  /** free these twins now (their bases are going away). A no-op for a non-releasable cache. */
  release(twins: Iterable<THREE.Material>): void {
    if (!this.releasable) return;
    for (const t of twins) {
      const twin = t as THREE.MeshPhysicalMaterial;
      if (!this.made.has(twin)) continue;
      this.made.delete(twin);
      releaseTwin(twin);
    }
  }

  releaseAll(): void {
    if (!this.releasable) return;
    for (const t of this.made) releaseTwin(t);
    this.made.clear();
  }
}

// ══════════════════════════════════════════════════════════════════════ the swap itself ══

/** the base material(s) a swapped mesh came with. Kept on the mesh, so a revert needs nothing
 * but the mesh — any walk can undo any apply. */
type BaseSlot = THREE.Material | THREE.Material[];

/**
 * SWAP one mesh onto twins: `pick` answers per material (null = keep the base). Idempotent — a
 * mesh already swapped is left alone, which is what lets an applier walk a whole group again
 * after one robot in it was rebuilt. Returns whether the mesh changed.
 */
export function swapMesh(mesh: THREE.Mesh, pick: (m: THREE.Material) => THREE.Material | null): boolean {
  if (mesh.userData.bbBaseMat !== undefined) return false;
  const base = mesh.material as BaseSlot;
  if (Array.isArray(base)) {
    let changed = false;
    const next = base.map((m) => {
      const t = pick(m);
      if (t && t !== m) changed = true;
      return t ?? m;
    });
    if (!changed) return false;
    mesh.userData.bbBaseMat = base;
    mesh.material = next;
    return true;
  }
  const t = pick(base);
  if (!t || t === base) return false;
  mesh.userData.bbBaseMat = base;
  mesh.material = t;
  return true;
}

/** put one mesh back on its base; returns the twins it was wearing (for a releasable cache). */
export function restoreMesh(mesh: THREE.Mesh): THREE.Material[] {
  const base = mesh.userData.bbBaseMat as BaseSlot | undefined;
  if (base === undefined) return [];
  const wore = mesh.material as BaseSlot;
  mesh.material = base;
  delete mesh.userData.bbBaseMat;
  const was = Array.isArray(wore) ? wore : [wore];
  return was.filter((m) => TWINS.has(m));
}

/** swap every mesh under `root`; returns how many changed */
export function swapTree(root: THREE.Object3D, pick: (m: THREE.Material, mesh: THREE.Mesh) => THREE.Material | null): number {
  let n = 0;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (swapMesh(mesh, (m) => pick(m, mesh))) n++;
  });
  return n;
}

/** restore every mesh under `root`; returns the twins that came off */
export function restoreTree(root: THREE.Object3D): Set<THREE.Material> {
  const off = new Set<THREE.Material>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const t of restoreMesh(mesh)) off.add(t);
    restoreShadow(mesh);
  });
  return off;
}

/**
 * A MESH'S SHADOW FLAGS, changed reversibly — the base pair is parked on
 * `userData.bbBaseShadow` and `restoreTree` puts it back. For a physical-mode-only shadow policy
 * (the clear panels) that standard mode must not see.
 */
export function setShadow(mesh: THREE.Object3D, cast: boolean, receive: boolean): void {
  if (mesh.userData.bbBaseShadow === undefined) mesh.userData.bbBaseShadow = [mesh.castShadow, mesh.receiveShadow];
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
}

export function restoreShadow(mesh: THREE.Object3D): void {
  const base = mesh.userData.bbBaseShadow as [boolean, boolean] | undefined;
  if (base === undefined) return;
  mesh.castShadow = base[0];
  mesh.receiveShadow = base[1];
  delete mesh.userData.bbBaseShadow;
}

/** a hex colour as `rrggbb` off any material with a `color` — how the appliers recognise a
 * base (`solidMat` caches by colour, and the GLB finishes are named by it). */
export function colorHexOf(m: THREE.Material): string | null {
  const c = (m as THREE.MeshStandardMaterial).color;
  return c && typeof c.getHexString === 'function' ? c.getHexString() : null;
}
