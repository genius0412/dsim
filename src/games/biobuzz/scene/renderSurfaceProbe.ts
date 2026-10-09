import * as THREE from 'three';
import type { VenueSpec } from '../graphics/environments';
import { VENUE_OVERHEAD_LAYER } from './renderVenue';
import { SURFACE_UNIFORMS, lowerSurfaceUniforms } from './renderSurfaceKit';

/**
 * THE ROOM PROBE — what the physical twins reflect in the MATCH: the venue that is actually drawn
 * around the field, instead of the HDRI photograph (or painted dome) that the venue geometry hides.
 * Part of the lazy `renderSurfaces` chunk.
 *
 * ── WHY A CAPTURED CUBE, AND NOT ANYTHING CHEAPER OR FANCIER ────────────────────────────────
 * The dome is at infinity and the venue is geometry now, so every metal and every panel was
 * reflecting a room that is not there (a school-hall photograph behind a hall of boxes). One
 * `CubeCamera` capture of the venue, the floor and the background, filtered by three's own PMREM,
 * is a static texture: ~80 draws and one filter ONCE per environment, nothing per frame but a few
 * ALU per fragment and a texture unit. Screen-space reflections cost 2–3 extra scene renders a
 * frame and cannot see behind the driver; `Reflector` is a full render per plane and drops PBR;
 * `transmission` is an extra opaque pass and makes the stacked clear panels invisible to each
 * other. All three measured and rejected in the 2026-09-27 reflection survey.
 *
 * ── WHAT IS IN IT, AND WHAT IS DELIBERATELY NOT ─────────────────────────────────────────────
 * IN: the venue (INCLUDING the overhead layer — lamps, truss, softboxes — which PMREM's own
 * `fromScene` camera cannot see because it renders layer 0 only), the field's floor, the
 * background dome. OUT: the perimeter, the hives, the flowers, the boxes, robots, elements and the
 * reticle — the caller hides them for the capture. A single box cannot place a 65-in centre
 * structure or a moving robot, and a robot reflecting a frozen copy of itself is worse than one
 * reflecting nothing; their occlusion is left to GTAO.
 *
 * ── THE THREE NUMBERS THAT HAVE TO AGREE ────────────────────────────────────────────────────
 *   • THE CUBE SIZE equals the DOME's (128 for a painted dome, 256 for an HDRI and the room), read
 *     off `scene.environment` at capture. The `CUBEUV_*` defines a twin's program is compiled with
 *     come from `scene.environment`'s size, and the probe is sampled through the SAME
 *     `textureCubeUV`, so a mismatched probe would be read with the wrong mip layout. `raise`
 *     re-checks it every frame and leaves the probe off while an HDRI that just landed has not been
 *     re-captured yet. (A bigger probe would buy nothing anyway: the smoothest surface here samples
 *     a ~23 px face.)
 *   • THE ROTATION is identity: the capture is in world axes, and the dome's `MAP_ROT` is a fix for
 *     a y-up equirect in a z-up scene that must not be applied twice.
 *   • THE BOX is the venue's own room (`probeBoxFor`), which is what the reflection is projected
 *     against — see `bbProbeDir` in the kit.
 */

/** the capture point: the field's centre, at a robot's height — the height most reflecting
 * surfaces (robot sides, the hive frame's lower half, the perimeter) actually sit at. */
export const PROBE_POS_IN: readonly [number, number, number] = [0, 0, 36];

/** `renderVenue.ts`'s `VENUE_MIN_HALF` (the camera-escape guard it applies to every enclosed
 * venue), mirrored because it is not exported and this chunk must not change that file's
 * surface. The RENDER lane should pin the two equal. */
const ENCLOSED_MIN_HALF = 660;
/** below the venue ground (`GROUND_Z` −0.75) and the shell's own floor (−1) */
const BOX_FLOOR_Z = -1;
/** outdoors the ground disc reaches 1.35 × `half` (`buildBiobuzzVenue`), and there is no ceiling:
 * the sky is the dome, so the box's top is simply far enough to read as "at infinity" */
const OUTDOOR_REACH = 1.35;
const OUTDOOR_SKY_IN = 5000;

/** the proxy box the reflections are projected against, in field inches — plain numbers, so the
 * RENDER lane can pin it without a GL context. */
export function probeBoxFor(venue: VenueSpec): { min: [number, number, number]; max: [number, number, number] } {
  if (venue.kind === 'outdoor') {
    const r = venue.half * OUTDOOR_REACH;
    return { min: [-r, -r, BOX_FLOOR_Z], max: [r, r, OUTDOOR_SKY_IN] };
  }
  const half = Math.max(venue.half, ENCLOSED_MIN_HALF);
  return { min: [-half, -half, BOX_FLOOR_Z], max: [half, half, Math.max(venue.ceil, PROBE_POS_IN[2] + 1)] };
}

/**
 * ── THE PROBE'S EXPOSURE ────────────────────────────────────────────────────────────────────
 * ⚠️ THE DRAWN ROOM IS FAR DARKER THAN THE LIGHT THE SCENE IS LIT BY, so a probe reflected as
 * captured turns every metal dark bronze. Measured 2026-09-27 at Extreme, the probe's mean
 * radiance against the dome it stands in for (both averaged over 64 directions at roughness 1):
 * school-hall 0.27 vs 0.80 (×3.0), gym ×2.4, the practice room ×4.6, sunset ×1.7, overcast ×1.6,
 * workshop ×1.4, arena ×1.2, cyc ×1.0, night ×0.5. On top of that every diffuse surface also gets
 * the rig's HEMISPHERE light (1.3 of white from above in the shared rig), which three gives to
 * the diffuse term ONLY — a metal has none, so it had lost that too. The causes are real and
 * none of them is a bug: the venue's lamps are drawn at 1–2 raw where the photograph's are in the
 * tens, and the field's mat is kept at #454545 for the HUD's contrast pins when real EVA is about
 * four times that.
 *
 * So the probe keeps the room's SHAPE and COLOUR — where the lamps are, the parallax, the warm
 * floor — and takes its ENERGY from the lighting, separately for the half above the probe and the
 * half below it (the rig itself splits its ambient that way, sky and ground):
 *
 *     gain(half) = lum( dome(half) + hemi(half) / π ) / lum( probe(half) ),   clamped to [1, 2.5]
 *
 * `hemi / π` is the radiance an environment would need to put the hemisphere light's irradiance
 * on a surface, which is what a metal has to be shown to look lit by the same room as the paint
 * beside it. Never below 1, because the one room brighter than its lighting (night: the drawn
 * mast lamps against a black sky) is brighter for a reason the dome does not know about.
 *
 * THE COLOUR OF THAT LIGHT TOO (`tint`, 2026-09-27). The gain alone lifted the missing hemisphere
 * light in the drawn room's colour, and the hemisphere is not that colour: in the school hall the
 * probe and the dome are both warm (chroma 1.33 / 0.94 / 0.59), the hemisphere is white at 1.3,
 * and the paint beside a metal is lit mostly by it and the white sun. Clear-anodised aluminium
 * came out cream, like ivory plastic, next to a neutral white front bar. So each half also gets
 * the chroma of `dome + hemi / π` over the chroma of the probe, per channel, clamped to
 * [TINT_MIN, TINT_MAX] and renormalised to luminance 1, so the gain stays the one number that sets
 * energy. Measured: school hall ×(0.89, 1.01, 1.25) above, gym ×(0.84, 1.01, 1.37); where the rig
 * is the room's colour (arena above, overcast, the halls' floor half) within ~5 % of 1. Only as far
 * as the gain adds light: a half brighter than its lighting keeps its own colour too.
 *
 * Seen at a robot close-up in the school hall: the turret's clear-anodised plates and braces go
 * from cream to a paler, less yellow silver (blue/red of the lit pixels 0.87 → 0.89; the standard
 * robot is 0.92). The braces stay BRIGHT, and that is the room more than the gain: at the same
 * frame, ceilings of 2.5, 2.0 and 2.5 up / 1.3 down give the turret a median luminance of 113, 99
 * and 82 (standard 80) but the rods' lit upper half reads the same pale silver in all three,
 * because a satin rod mostly reflects the lit cream walls above it.
 *
 * ⚠️ NEVER ABOVE 2.5, AND THAT CEILING IS A LEGIBILITY CALL, NOT PHYSICS. The full rule asks for
 * 4.0 above and 3.1 below in the school hall, and at that gain the metals are right against the
 * paint beside them (an 18 % grey metal sphere at ×3 still reads 153/255 against the 18 % grey
 * paint sphere's 213 at mid-height) — but the same gain lands on every GLOSSY DIELECTRIC too, and
 * this rig is exposed so a light diffuse surface sits near clipping: at ×4 the black powder-coat
 * rails wash to brown-grey and the far perimeter reads as a white veil over the elements behind
 * it. Captured side by side at ×1, ×2/1.6, ×2.6/2 and ×4/3.1 (school-hall, driver, chase, a
 * robot close-up): ×1 is the dark-bronze aluminium this exists to fix, ×2.5 reads as bead-blasted
 * aluminium with the rails still black. Also a ceiling on a probe that is nearly black (a capture
 * taken before the venue has drawn).
 *
 * Computed on the GPU at capture (a 2×1 float target, each texel averaging 64 directions of one
 * map's half, read back once), so it costs a few dozen texture reads and one tiny readback per
 * capture, and nothing per frame beyond a mix in the patched `getIBLRadiance`.
 */
const GAIN_MIN = 1;
const GAIN_MAX = 2.5;
const GAIN_DIRS = 64;
/** the white balance's per-channel bounds, before renormalising: a correction, never a recolour */
const TINT_MIN = 0.7;
const TINT_MAX = 1.4;
/** the want/have excess over which the white balance comes fully on (see `probeGains`) */
const TINT_RAMP = 0.25;

/** luminance (Rec. 709, linear) — the one number a gain is allowed to change */
function lum(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

type Rgb = [number, number, number];

/**
 * THE RULE, as plain numbers so the RENDER lane can pin it without a GL context: the two
 * hemispheres' gains and white balances from the measured means (`probe`/`dome`: [upR, upG, upB,
 * downR, downG, downB]) and the hemisphere light's sky and ground radiance-equivalents
 * (colour × intensity, before /π). A tint is (1, 1, 1) wherever its half cannot be measured.
 */
export function probeGains(
  probe: readonly number[],
  dome: readonly number[],
  sky: readonly [number, number, number],
  ground: readonly [number, number, number],
): { up: number; down: number; upTint: Rgb; downTint: Rgb } {
  const wantOf = (o: number, h: readonly [number, number, number]): Rgb => [
    dome[o] + h[0] / Math.PI,
    dome[o + 1] + h[1] / Math.PI,
    dome[o + 2] + h[2] / Math.PI,
  ];
  const one = (o: number, h: readonly [number, number, number]): number => {
    const have = lum(probe[o], probe[o + 1], probe[o + 2]);
    const want = lum(...wantOf(o, h));
    if (!(have > 1e-4) || !Number.isFinite(want)) return GAIN_MAX;
    return Math.min(GAIN_MAX, Math.max(GAIN_MIN, want / have));
  };
  const tint = (o: number, h: readonly [number, number, number]): Rgb => {
    const w = wantOf(o, h);
    const lw = lum(...w);
    const lh = lum(probe[o], probe[o + 1], probe[o + 2]);
    if (!(lw > 1e-4) || !(lh > 1e-4) || !w.every(Number.isFinite)) return [1, 1, 1];
    // only as far as the gain ADDS light: a half already brighter than its lighting (night's lower
    // half, the drawn mast lamps) keeps its own colour for the reason it keeps its own energy, and
    // the correction ramps in over the first TINT_RAMP of gain so nothing jumps at the boundary
    const k = Math.min(1, Math.max(0, (lw / lh - 1) / TINT_RAMP));
    const t = [0, 1, 2].map((c) => {
      const have = probe[o + c] / lh;
      const r = have > 1e-4 ? w[c] / lw / have : 1;
      return 1 + k * (Math.min(TINT_MAX, Math.max(TINT_MIN, Number.isFinite(r) ? r : 1)) - 1);
    }) as Rgb;
    const lt = lum(...t);
    return lt > 1e-4 ? [t[0] / lt, t[1] / lt, t[2] / lt] : [1, 1, 1];
  };
  return { up: one(0, sky), down: one(3, ground), upTint: tint(0, sky), downTint: tint(3, ground) };
}

/** the averaging pass: texel x = 0 averages the upper half of `map`, x = 1 the lower. Compiled for
 * one cube-UV size (the defines three's own chunk needs), so rebuilt when the size changes. */
function meanMaterial(size: number): THREE.ShaderMaterial {
  // three's `WebGLPrograms` values for a cube-UV map of height 4·size — the same the twins get
  const maxMip = Math.log2(size * 4) - 2;
  return new THREE.ShaderMaterial({
    defines: {
      ENVMAP_TYPE_CUBE_UV: '',
      CUBEUV_TEXEL_WIDTH: 1 / (3 * Math.max(Math.pow(2, maxMip), 7 * 16)),
      CUBEUV_TEXEL_HEIGHT: 1 / (size * 4),
      CUBEUV_MAX_MIP: `${maxMip}.0`,
      BB_DIRS: GAIN_DIRS,
    },
    uniforms: { bbMap: { value: null }, bbRot: { value: new THREE.Matrix3() } },
    vertexShader: 'void main() { gl_Position = vec4( position.xy, 0.0, 1.0 ); }',
    fragmentShader: /* glsl */ `
uniform sampler2D bbMap;
// the map's own rotation, exactly as three hands a material its envMapRotation: the dome is a
// y-up equirect turned to z-up, so ITS upper half is not its texture's +z
uniform mat3 bbRot;
#include <cube_uv_reflection_fragment>
void main() {
\tfloat lower = step( 1.0, gl_FragCoord.x );
\tvec3 sum = vec3( 0.0 );
\t// a Fibonacci spiral over ONE hemisphere (z from 1 to 0, flipped for the lower), at the
\t// roughest level, which is already a wide average of its neighbourhood
\tfor ( int i = 0; i < BB_DIRS; i ++ ) {
\t\tfloat fi = float( i ) + 0.5;
\t\tfloat z = 1.0 - fi / float( BB_DIRS );
\t\tfloat r = sqrt( max( 0.0, 1.0 - z * z ) );
\t\tfloat ph = 2.39996323 * fi;
\t\tvec3 d = vec3( r * cos( ph ), r * sin( ph ), mix( z, - z, lower ) );
\t\tsum += textureCubeUV( bbMap, bbRot * d, 1.0 ).rgb;
\t}
\tgl_FragColor = vec4( sum / float( BB_DIRS ), 1.0 );
}`,
    depthTest: false,
    depthWrite: false,
  });
}

export interface ProbeMeans {
  /** upper RGB then lower RGB, linear */
  probe: number[];
  dome: number[];
  up: number;
  down: number;
  upTint: Rgb;
  downTint: Rgb;
}

/** the first visible hemisphere light in the scene — the rig's, whose ambient a metal must be shown */
function findHemi(scene: THREE.Scene): THREE.HemisphereLight | null {
  for (const o of scene.children) {
    if ((o as THREE.HemisphereLight).isHemisphereLight && o.visible) return o as THREE.HemisphereLight;
  }
  return null;
}

export interface RoomProbe {
  /**
   * Capture the room now, with `hidden` hidden for the six faces and put back after. Returns
   * false (and leaves the last good capture) when there is no cube-UV environment to match — the
   * environment-lighting row off, or the room still loading.
   *
   * ⚠️ Call it OUTSIDE `raise`/`lower` (the twins drawn INTO the probe must reflect the dome, not
   * last capture's probe) and outside the bloom window (the lamps must be at their own power).
   * The sun's shadow map is redrawn for the capture with the hidden objects gone, and flagged to
   * be redrawn again for the next scene pass.
   */
  capture(renderer: THREE.WebGLRenderer, scene: THREE.Scene, hidden: readonly THREE.Object3D[], venue: VenueSpec): boolean;
  /** write this probe into the shared uniforms, if it matches `scene.environment` — see the header */
  raise(scene: THREE.Scene): void;
  /** is there a capture at all */
  readonly ready: boolean;
  /** the last capture's measured means and the gains taken from them (a capture script's view of
   * the exposure rule; null before the first measured capture) */
  readonly means: ProbeMeans | null;
  dispose(): void;
}

export function createRoomProbe(): RoomProbe {
  let cubeRT: THREE.WebGLCubeRenderTarget | null = null;
  let cam: THREE.CubeCamera | null = null;
  let pmrem: THREE.PMREMGenerator | null = null;
  let pmremRenderer: THREE.WebGLRenderer | null = null;
  /** the filtered probe: REUSED across captures of the same size, so the texture object — and so
   * the uniform's value — stays the same one */
  let target: THREE.WebGLRenderTarget | null = null;
  let targetSize = 0;
  const min = new THREE.Vector3();
  const max = new THREE.Vector3();
  const pos = new THREE.Vector3(...PROBE_POS_IN);
  /** the exposure of the current capture (`probeGains`), written at `raise` */
  let gainUp = 1;
  let gainDown = 1;
  let tintUp: Rgb = [1, 1, 1];
  let tintDown: Rgb = [1, 1, 1];
  let lastMeans: ProbeMeans | null = null;
  // the averaging pass's pieces, built on the first capture and kept (a 2×1 target, one triangle)
  let mean: { mat: THREE.ShaderMaterial; size: number; rt: THREE.WebGLRenderTarget; scene: THREE.Scene; mesh: THREE.Mesh; cam: THREE.Camera } | null = null;
  const rot = new THREE.Matrix3();
  const rotM4 = new THREE.Matrix4();
  const px = new Float32Array(8);

  /**
   * THE EXPOSURE (the header's rule): average the filtered probe and the dome, each by half, and
   * read the four means back. Any failure — no float render target on this GPU, a read the driver
   * refuses — leaves the gains at 1, which is the probe exactly as captured.
   */
  const measure = (renderer: THREE.WebGLRenderer, scene: THREE.Scene, probeTex: THREE.Texture, size: number): void => {
    gainUp = 1;
    gainDown = 1;
    tintUp = [1, 1, 1];
    tintDown = [1, 1, 1];
    const env = scene.environment;
    if (!env || !renderer.extensions.has('EXT_color_buffer_float')) return;
    if (!mean || mean.size !== size) {
      mean?.mat.dispose();
      const mat = meanMaterial(size);
      if (!mean) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
        const mesh = new THREE.Mesh(geo, mat);
        mesh.frustumCulled = false;
        const sc = new THREE.Scene();
        sc.add(mesh);
        const rt = new THREE.WebGLRenderTarget(2, 1, { type: THREE.FloatType, depthBuffer: false });
        mean = { mat, size, rt, scene: sc, mesh, cam: new THREE.Camera() };
      } else {
        mean.mesh.material = mat;
        mean = { ...mean, mat, size };
      }
    }
    const m = mean;
    const read = (tex: THREE.Texture, r: THREE.Matrix3, into: number): void => {
      m.mat.uniforms.bbMap.value = tex;
      (m.mat.uniforms.bbRot.value as THREE.Matrix3).copy(r);
      renderer.setRenderTarget(m.rt);
      renderer.render(m.scene, m.cam);
      renderer.readRenderTargetPixels(m.rt, 0, 0, 2, 1, px);
      // texel 0 is the upper half, texel 1 the lower
      out[into] = px[0];
      out[into + 1] = px[1];
      out[into + 2] = px[2];
      out[into + 3] = px[4];
      out[into + 4] = px[5];
      out[into + 5] = px[6];
    };
    const out = new Array<number>(12).fill(0);
    const was = renderer.getRenderTarget();
    try {
      read(probeTex, rot.identity(), 0);
      // the dome's rotation as three passes it (`WebGLMaterials`: the Euler's matrix, transposed)
      read(env, rot.setFromMatrix4(rotM4.makeRotationFromEuler(scene.environmentRotation)).transpose(), 6);
    } finally {
      renderer.setRenderTarget(was);
      m.mat.uniforms.bbMap.value = null;
    }
    if (!out.every(Number.isFinite)) return;
    const hemi = findHemi(scene);
    const sky: [number, number, number] = hemi ? [hemi.color.r * hemi.intensity, hemi.color.g * hemi.intensity, hemi.color.b * hemi.intensity] : [0, 0, 0];
    const ground: [number, number, number] = hemi
      ? [hemi.groundColor.r * hemi.intensity, hemi.groundColor.g * hemi.intensity, hemi.groundColor.b * hemi.intensity]
      : [0, 0, 0];
    const g = probeGains([out[0], out[1], out[2], out[3], out[4], out[5]], [out[6], out[7], out[8], out[9], out[10], out[11]], sky, ground);
    gainUp = g.up;
    gainDown = g.down;
    tintUp = g.upTint;
    tintDown = g.downTint;
    lastMeans = { probe: out.slice(0, 6), dome: out.slice(6), up: g.up, down: g.down, upTint: g.upTint, downTint: g.downTint };
  };

  const envHeight = (scene: THREE.Scene): number => {
    const env = scene.environment;
    if (!env || env.mapping !== THREE.CubeUVReflectionMapping) return 0;
    const h = (env.image as { height?: number } | null)?.height ?? 0;
    return h > 0 ? h : 0;
  };

  return {
    get ready(): boolean {
      return target !== null;
    },
    capture(renderer, scene, hidden, venue): boolean {
      const h = envHeight(scene);
      // a PMREM target is 4 × cubeSize tall, and cubeSize is a power of two ≥ 16
      const size = h / 4;
      if (!(size >= 16) || Math.log2(size) % 1 !== 0) return false;

      if (!cubeRT || cubeRT.width !== size) {
        cubeRT?.dispose();
        cubeRT = new THREE.WebGLCubeRenderTarget(size, {
          // HALF FLOAT: the room is HDR (lamps at 1–2 raw, a sunlit wall above 1), and an 8-bit
          // capture would clip exactly the highlights a metal is supposed to show
          type: THREE.HalfFloatType,
          generateMipmaps: false,
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
        });
        // far enough for the outdoor ground's rim (1.35 × 1700 in) from the field centre; the
        // background is drawn at infinity whatever this says
        cam = new THREE.CubeCamera(1, 12000, cubeRT);
        // the lamps, the truss, the softboxes — the reason this is a CubeCamera and not `fromScene`
        cam.layers.enable(VENUE_OVERHEAD_LAYER);
      }
      cam!.position.copy(pos);
      cam!.updateMatrixWorld(true);

      const was = hidden.map((o) => o.visible);
      for (const o of hidden) o.visible = false;
      renderer.shadowMap.needsUpdate = true;
      try {
        // the twins in the capture (the venue floor) must see the dome, never a previous probe
        lowerSurfaceUniforms();
        cam!.update(renderer, scene);
      } finally {
        hidden.forEach((o, i) => {
          o.visible = was[i];
        });
        // the map just drawn is missing everything hidden above; the next scene pass needs its own
        renderer.shadowMap.needsUpdate = true;
      }

      if (pmremRenderer !== renderer) {
        pmrem?.dispose();
        pmrem = new THREE.PMREMGenerator(renderer);
        pmremRenderer = renderer;
        target?.dispose();
        target = null;
        targetSize = 0;
      }
      // ⚠️ A TARGET MAY BE PASSED ONLY ONCE THE GENERATOR HAS ALLOCATED FOR THIS SIZE. three 0.186's
      // `fromCubemap(tex, target)` skips `_allocateTargets`, which is what builds the ping-pong
      // target and the per-LOD meshes; on a fresh generator (or a new size) it would index an empty
      // mesh list. So the first capture at a size lets PMREM allocate, and later ones reuse.
      if (target && targetSize === size) {
        pmrem!.fromCubemap(cubeRT.texture, target);
      } else {
        target?.dispose();
        target = pmrem!.fromCubemap(cubeRT.texture);
        targetSize = size;
      }

      measure(renderer, scene, target.texture, size);

      const box = probeBoxFor(venue);
      min.set(...box.min);
      max.set(...box.max);
      return true;
    },
    raise(scene): void {
      const ok = target !== null && envHeight(scene) === target.height;
      SURFACE_UNIFORMS.bbProbeOn.value = ok ? 1 : 0;
      SURFACE_UNIFORMS.bbProbeMap.value = ok ? target!.texture : null;
      SURFACE_UNIFORMS.bbProbeMin.value.copy(min);
      SURFACE_UNIFORMS.bbProbeMax.value.copy(max);
      SURFACE_UNIFORMS.bbProbePos.value.copy(pos);
      SURFACE_UNIFORMS.bbProbeGainUp.value = ok ? gainUp : 1;
      SURFACE_UNIFORMS.bbProbeGainDown.value = ok ? gainDown : 1;
      if (ok) {
        SURFACE_UNIFORMS.bbProbeTintUp.value.set(...tintUp);
        SURFACE_UNIFORMS.bbProbeTintDown.value.set(...tintDown);
      } else {
        SURFACE_UNIFORMS.bbProbeTintUp.value.set(1, 1, 1);
        SURFACE_UNIFORMS.bbProbeTintDown.value.set(1, 1, 1);
      }
    },
    get means() {
      return lastMeans;
    },
    dispose(): void {
      lowerSurfaceUniforms();
      cubeRT?.dispose();
      cubeRT = null;
      cam = null;
      target?.dispose();
      target = null;
      pmrem?.dispose();
      pmrem = null;
      pmremRenderer = null;
      if (mean) {
        mean.mat.dispose();
        mean.mesh.geometry.dispose();
        mean.rt.dispose();
        mean = null;
      }
    },
  };
}
