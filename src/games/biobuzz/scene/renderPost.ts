import * as THREE from 'three';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { CopyShader } from 'three/examples/jsm/shaders/CopyShader.js';
import { BB_HALF_X, BB_HALF_Y } from '../config';

/**
 * BIOBUZZ 3D POST-PROCESSING — ambient occlusion and bloom, the two effects of the Extreme column
 * (`graphics/settings.ts`, rows `ao` and `bloom`), in a LAZY CHUNK of their own.
 *
 * ── HOW IT IS REACHED ───────────────────────────────────────────────────────────────────────
 * Only `renderScene.ts` imports this file, and only as `import('./renderPost')`, fired the first
 * time `wantsPost(settings)` is true. A player who never turns AO or bloom on never downloads it.
 * A SECOND importer (the builder preview, a static import anywhere) would make Rollup hoist
 * three.js out of the scene chunk into a shared one with no marker strings, which is the same
 * `bundleaudit` failure `docs/area/biobuzz.md`'s ONE DYNAMIC SPECIFIER rule exists to prevent.
 *
 * ── WHY THE PASSES ARE DRIVEN BY HAND, AND NOT THROUGH `EffectComposer` ──────────────────────
 *   • The scene's blit (`renderScene.ts`) is where ACES and the sRGB conversion happen, from the
 *     renderer's own `toneMapping`/`toneMappingExposure`, which the environment rig sets. The
 *     composer's way to finish is `OutputPass`, a SECOND place for both. Here the passes work on
 *     linear HDR and hand back a texture; the blit stays the only place the image becomes sRGB.
 *   • The composer owns its own `RenderPass`, so the scene pass would move inside it and the
 *     stats read (`renderer.info.render`, reset by every `render()` call) could no longer be taken
 *     between the scene pass and everything after it.
 *   • `EffectComposer.setSize` multiplies by the renderer's pixel ratio itself. The scene sizes
 *     its targets in DEVICE pixels already (`syncSize`), so a composer fed the same numbers
 *     squares the ratio, the bug `renderMinimap`'s note describes for `setViewport`.
 *
 * ── THE ONE RULE ABOUT TARGETS ──────────────────────────────────────────────────────────────
 * ⚠️ NOTHING HERE MAY DRAW INTO THE SCENE'S MULTISAMPLED TARGET. When three resolves an MSAA
 * target into its texture (`updateMultisampleRenderTarget`) it then INVALIDATES the multisampled
 * colour buffer. The texture is fine to read; drawing back into the target afterwards blends
 * onto undefined contents and the next resolve overwrites the good texture with them. Bloom
 * finishes by blending INTO its input, so with AO off and MSAA on, the input is copied into a
 * 0-sample target first. AO always writes a target of its own, so it never needs the copy.
 *
 * Every size given to this file is in DEVICE pixels.
 */

// ─────────────────────────────────────────────────────────────── ambient occlusion (GTAO) ──

/**
 * GTAO's parameters, in INCHES. The pass's defaults (radius 0.25, thickness 1) are for scenes
 * in metres, where they would make this field's occlusion a sixth of an inch wide.
 *
 *   • RADIUS 12: the world-space reach of a sample. It spans a hive tray's lip to its floor and
 *     a robot's belly to the tiles (frame rails sit 1–3 in up), so those two, the contact shading
 *     Extreme is for, both land inside it. Wider (16+) started darkening whole wall panels from
 *     the robots in front of them.
 *   • THICKNESS 12: a sample more than this much nearer the eye than the surface does not count,
 *     which is what keeps a robot in the foreground from casting a dark halo onto tiles feet
 *     behind it. Tuned up from 4, where the creases this is for barely darkened at all.
 *   • DISTANCE EXPONENT 1.5 and FALLOFF 0.5: more of the 16 samples near the surface, where the
 *     contact creases are, and fewer at the rim of the radius.
 *   • POWER 1.6: 2.5 went blotchy under the hive's base triangle.
 *   • BLEND 0.8: GTAO multiplies the FINISHED image, the sunlit and emissive parts included, so
 *     at full strength it greys lamps and sun-facing panels as much as it darkens creases.
 */
const AO_RADIUS_IN = 12;
const AO_THICKNESS_IN = 12;
const AO_DISTANCE_EXPONENT = 1.5;
const AO_SAMPLES = 16;
const AO_DISTANCE_FALLOFF = 0.5;
const AO_POWER = 1.6;
const AO_BLEND = 0.8;
/**
 * The G-buffer, the AO and its denoise run at HALF the backbuffer's resolution each way: a quarter
 * of the pixels, and the G-buffer pass is a whole second draw of the scene. It works cleanly
 * because every internal pass renders into a target of its own size (the viewport follows the
 * target), and the final blend is a full-screen quad at the OUTPUT's size that samples the
 * denoised AO by UV with linear filtering. AO is low-frequency by nature; the cost of the half
 * resolution is a one-pixel softening at silhouettes, which the denoise's depth and normal
 * weights keep from becoming a halo.
 */
const AO_RES_DIVISOR = 2;
/**
 * WHERE AO IS COMPUTED AT ALL: the field and everything on it, inches. The venue (walls, a gym's
 * bleachers, a hall's stage) is scenery at 300–700 in, where a 10-in radius is a sub-pixel
 * smudge that costs full price, so the shader discards it. The shader fades AO out over one
 * radius past this box rather than cutting it.
 */
const AO_CLIP_MARGIN_IN = 12;
const AO_CLIP_Z_MIN_IN = -2;
const AO_CLIP_Z_MAX_IN = 90;

/**
 * GTAO WITH A G-BUFFER THAT LEAVES OUT WHAT DOES NOT WRITE DEPTH.
 *
 * The base pass draws every visible mesh with a `MeshNormalMaterial` override, and an override
 * material writes depth whatever the mesh's own material said. The clear perimeter panels, the
 * element blob discs and the shot reticle are all `depthWrite: false`: in the scene pass they
 * are glass and decals over what is behind them, in the G-buffer they became OPAQUE surfaces,
 * so the driver camera computed AO on the glass it looks through. Anything whose material (or
 * any material of an array) has `depthWrite === false` or `visible === false` is hidden for the
 * G-buffer pass alone, pushed onto `_visibilityCache` so the base's restore turns it back on.
 *
 * The scene BACKGROUND is also dropped for that pass. The shader discards every pixel at the far
 * plane anyway, so drawing the environment dome into a normal buffer is pure fill cost.
 *
 * ⚠️ AND SO ARE THE VENUE'S `BackSide` ENCLOSURES (the hall shell, the studio cyclorama). The
 * normal material below is `DoubleSide`, which ignores each mesh's own `side`. From outside a
 * shell, the overhead camera (the phone default) and a high orbit, the scene pass culls its
 * ceiling and sees the field through it; the G-buffer drew the ceiling OVER the field, the clip
 * box then discarded every pixel as out of range, and AO silently did nothing at full cost. The
 * venue is outside the clip box anyway, so leaving it out of the G-buffer changes nothing else.
 *
 * ⚠️ `_overrideVisibility` is three's PRIVATE name (0.186; the bundled `.d.ts` still calls it
 * `overrideVisibility`). The constructor checks the base still has it, and warns once if an
 * upgrade renamed it, rather than silently putting AO back on the glass.
 */
class FieldGtaoPass extends GTAOPass {
  private savedBackground: THREE.Scene['background'] = null;

  constructor(scene: THREE.Scene, camera: THREE.Camera, width: number, height: number) {
    super(scene, camera, width, height);
    const proto = GTAOPass.prototype as unknown as Record<string, unknown>;
    if (typeof proto._overrideVisibility !== 'function' || typeof proto._restoreVisibility !== 'function') {
      console.warn('[renderPost] GTAOPass no longer has _overrideVisibility; AO will include the clear panels');
    }
    // OPEN SHELLS. The field GLB's thin parts are single `DoubleSide` sheets and the venue's
    // walls are `BackSide` boxes, so a front-face-only normal pass left holes (and a halo around
    // each) wherever the camera saw a sheet's back.
    this.normalMaterial.side = THREE.DoubleSide;
  }

  _overrideVisibility(): void {
    const cache = (this as unknown as { _visibilityCache: THREE.Object3D[] })._visibilityCache;
    this.savedBackground = this.scene.background;
    this.scene.background = null;
    this.scene.traverse((o) => {
      if (!o.visible) return;
      const line = o as THREE.Object3D & { isPoints?: boolean; isLine?: boolean; isLine2?: boolean };
      if (line.isPoints || line.isLine || line.isLine2) {
        o.visible = false;
        cache.push(o);
        return;
      }
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (mats.some((m) => m.depthWrite === false || m.visible === false || m.side === THREE.BackSide)) {
        o.visible = false;
        cache.push(o);
      }
    });
  }

  _restoreVisibility(): void {
    const cache = (this as unknown as { _visibilityCache: THREE.Object3D[] })._visibilityCache;
    for (const o of cache) o.visible = true;
    cache.length = 0;
    this.scene.background = this.savedBackground;
    this.savedBackground = null;
  }

  /** the pass reads `camera.near/far` and both matrices every frame, but compiled the camera's
   * KIND into the shader as a define. The overhead camera (the phone default) is orthographic
   * and every other shot is perspective, so a camera switch recompiles once, here. */
  setCamera(camera: THREE.Camera): void {
    this.camera = camera;
    const persp = (camera as THREE.PerspectiveCamera).isPerspectiveCamera ? 1 : 0;
    for (const m of [this.gtaoMaterial, this.depthRenderMaterial]) {
      if (m.defines.PERSPECTIVE_CAMERA !== persp) {
        m.defines.PERSPECTIVE_CAMERA = persp;
        m.needsUpdate = true;
      }
    }
  }

  /** after a throw inside `render`: the base only restores what `_overrideVisibility` hid when
   * it gets that far, so a G-buffer pass that threw would leave the glass hidden for good. */
  recoverFromThrow(): void {
    const cache = (this as unknown as { _visibilityCache: THREE.Object3D[] })._visibilityCache;
    for (const o of cache) o.visible = true;
    cache.length = 0;
    this.savedBackground = null;
  }

  /** the base `dispose` leaves these two ShaderMaterials allocated. */
  disposeAll(): void {
    this.dispose();
    this.gtaoMaterial.dispose();
    this.blendMaterial.dispose();
  }
}

// ──────────────────────────────────────────────────────────────────────────────── bloom ──

/**
 * SELECTIVE BLOOM, AND WHY IT HAS TO BE.
 *
 * A luminance threshold on this scene cannot tell a lamp from a white surface in sunlight on its
 * own: measured raw (linear, before exposure), lit near-white diffuse is 1.2–1.7, the venue's lamp
 * fittings 1.0–1.95. So the things that SHOULD glow, the lamps and nothing else, are pushed past
 * the threshold instead: `renderScene.ts` multiplies the emissive of every material tagged
 * `userData.bloomBase` by `BLOOM_EMISSIVE_GAIN` for the scene pass while bloom is on, and the
 * threshold sits between the lit-diffuse ceiling and the boosted emissives. A ROBOT PART NEVER
 * GLOWS (owner, 2026-09-27): the front light bar is untagged, and its own emissive plus lit white
 * (about 2.0–2.5 raw) has to stay under the threshold's lower knee. Hard metal glints (3–8 raw)
 * are real specular highlights and may clear it.
 *
 * THE THRESHOLD IS DISPLAY-NORMALISED. The high pass compares RAW luminance, before tone mapping,
 * and each environment's rig sets its own exposure (1.1–1.38), so a fixed raw threshold would
 * bloom a surface in one room and not in the next. `render()` divides by the live exposure.
 *
 * STRENGTH and RADIUS are modest on purpose: this is a driver-practice view, and a glow that
 * softens the edge of a POLLEN or a hive lip is a legibility regression wearing a graphics option.
 */
export const BLOOM_EMISSIVE_GAIN = 3.5;
/** the high pass's threshold, in luminance AFTER exposure (raw × `toneMappingExposure`). */
const BLOOM_THRESHOLD = 3.0;
/** the soft knee above the threshold, same units: a lamp that sits right at the threshold
 * fades in rather than popping on as the camera moves. */
const BLOOM_KNEE = 0.75;
/**
 * The brightest RAW luminance a single pixel may feed the blur. The clear panels' sun sheen
 * (`renderFieldGlb.ts`) reaches tens and a metal glint 8; unclamped, one of those pixels blurs
 * into a disc brighter than the lamp the effect is for, and it flickers as the pixel appears and
 * disappears between frames. Clamping per pixel, before the blur, keeps it a glint.
 */
const BLOOM_MAX_LUMINANCE = 8;
/**
 * THE CLEAR PANELS' ON-SCREEN CEILING while bloom is on, same units as the threshold, handed to
 * `renderFieldGlb.ts`'s `setClearPanelCap` for the scene pass. HALF the threshold, not the
 * threshold: a perimeter wall is thousands of pixels, and a wall capped AT the threshold still
 * sat just over it wherever the floor showed through, which the blur summed back into the same
 * haze (measured, `monochrome-studio` driver view). At half, the wall plus what is behind it stays
 * under the line and a lit sheet still reads as a bright sheet.
 */
const BLOOM_PANEL_CAP = BLOOM_THRESHOLD * 0.5;
const BLOOM_STRENGTH = 0.35;
const BLOOM_RADIUS = 0.4;
/**
 * Bloom's input is HALF the backbuffer each way, and UnrealBloom halves again inside, so its
 * brightest mip is a sixteenth of the pixels. The blur is dozens of pixels wide at any size, so
 * the full-resolution version bought nothing visible at 4K and cost four times the fill. The
 * high pass below takes a 4-tap box so a thin bright line does not alias between frames at
 * that reduction.
 */
const BLOOM_RES_DIVISOR = 2;

/** UnrealBloom's own high pass, replaced: the same uniforms plus a per-pixel clamp and a 4-tap
 * box filter (see `BLOOM_MAX_LUMINANCE` and `BLOOM_RES_DIVISOR`). `luminosityThreshold` and
 * `tDiffuse` are the pass's own uniform objects, which it writes every frame. */
function highPassMaterial(passUniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...passUniforms,
      maxLuminance: { value: BLOOM_MAX_LUMINANCE },
      invInput: { value: new THREE.Vector2(1, 1) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform float luminosityThreshold;
      uniform float smoothWidth;
      uniform float maxLuminance;
      uniform vec2 invInput;
      varying vec2 vUv;
      vec3 tap(vec2 o) {
        vec3 c = texture2D(tDiffuse, vUv + o * invInput).rgb;
        // ⚠️ ONE NON-FINITE TEXEL POISONS THE WHOLE FRAME. The scene pass itself leaves a few
        // NaN texels on the robots (4 of 7.9 M in a 3744 × 2106 school-hall driver frame,
        // measured; the same view at 1920 × 1080 had none). Without bloom each is one black
        // pixel nobody sees. With it, the blur spreads NaN through every mip and the additive
        // blend turns the ENTIRE image black, which is what the first Extreme captures showed.
        // A spike past half float's 65504 (+Inf) would do the same through Inf × 0 below.
        if (any(isnan(c))) c = vec3(0.0);
        c = min(c, vec3(60000.0));
        float v = luminance(c);
        // clamp BEFORE the average, so one hot texel cannot carry its neighbours over
        return c * (min(v, maxLuminance) / max(v, 1e-4));
      }
      void main() {
        // four bilinear taps one input texel off-centre each way: a 4x4 box of the input
        vec3 c = 0.25 * (tap(vec2(-1.0, -1.0)) + tap(vec2(1.0, -1.0)) + tap(vec2(-1.0, 1.0)) + tap(vec2(1.0, 1.0)));
        // SOFT THRESHOLD: what passes is the part ABOVE the threshold, not the whole pixel, with a
        // quadratic knee either side of it. A front bar just over the line then feeds a little
        // glow rather than its whole brightness, and nothing pops on or off as the camera moves.
        float v = luminance(c);
        float k = max(smoothWidth, 1e-4);
        float soft = clamp(v - luminosityThreshold + k, 0.0, 2.0 * k);
        soft = soft * soft / (4.0 * k);
        gl_FragColor = vec4(c * (max(soft, v - luminosityThreshold) / max(v, 1e-4)), 1.0);
      }`,
  });
}

// ─────────────────────────────────────────────────────────────────────────── the chain ──

export interface PostOptions {
  ao: boolean;
  bloom: boolean;
}

export interface BbPost {
  /** `BLOOM_EMISSIVE_GAIN`, handed over here because the scene may not import this file. */
  readonly emissiveGain: number;
  /** `BLOOM_PANEL_CAP` (display-normalised), for the clear panels' output cap in the scene pass. */
  readonly panelCap: number;
  /** the scene target's size, DEVICE pixels. */
  setSize(width: number, height: number): void;
  /**
   * Run the enabled passes over `input` (the scene target, linear HDR, possibly multisampled —
   * only its resolved texture is read) and return the target holding the finished linear-HDR
   * image, for the scene's blit to tone-map. Returns `input` itself when nothing ran. Leaves the
   * render target bound to whatever the last pass drew into; the caller binds its own.
   */
  render(renderer: THREE.WebGLRenderer, input: THREE.WebGLRenderTarget, camera: THREE.Camera, opts: PostOptions): THREE.WebGLRenderTarget;
  dispose(): void;
}

/** a 0-sample, depthless half-float target: what every post output lands in. */
function hdrTarget(w: number, h: number): THREE.WebGLRenderTarget {
  const t = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false });
  t.texture.colorSpace = THREE.LinearSRGBColorSpace;
  t.texture.generateMipmaps = false;
  return t;
}

const div = (n: number, d: number): number => Math.max(1, Math.round(n / d));

/**
 * Build the post chain for `scene`. Nothing is allocated until a pass is first asked for, and a
 * pass switched off is disposed at once, so a player who drops AO gets its G-buffer back.
 */
export function createPost(scene: THREE.Scene): BbPost {
  let w = 1;
  let h = 1;
  let gtao: FieldGtaoPass | null = null;
  let bloom: UnrealBloomPass | null = null;
  let bloomHigh: THREE.ShaderMaterial | null = null;
  /** where AO writes, and where bloom works when its input is multisampled. */
  let ping: THREE.WebGLRenderTarget | null = null;
  const copyMat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms),
    vertexShader: CopyShader.vertexShader,
    fragmentShader: CopyShader.fragmentShader,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
  });
  const copyQuad = new FullScreenQuad(copyMat);
  const savedClear = new THREE.Color();
  const clipBox = new THREE.Box3(
    new THREE.Vector3(-BB_HALF_X - AO_CLIP_MARGIN_IN, -BB_HALF_Y - AO_CLIP_MARGIN_IN, AO_CLIP_Z_MIN_IN),
    new THREE.Vector3(BB_HALF_X + AO_CLIP_MARGIN_IN, BB_HALF_Y + AO_CLIP_MARGIN_IN, AO_CLIP_Z_MAX_IN),
  );

  function ensurePing(): THREE.WebGLRenderTarget {
    if (!ping) ping = hdrTarget(w, h);
    return ping;
  }

  function ensureGtao(camera: THREE.Camera): FieldGtaoPass {
    if (!gtao) {
      gtao = new FieldGtaoPass(scene, camera, div(w, AO_RES_DIVISOR), div(h, AO_RES_DIVISOR));
      gtao.output = GTAOPass.OUTPUT.Default;
      gtao.blendIntensity = AO_BLEND;
      gtao.updateGtaoMaterial({
        radius: AO_RADIUS_IN,
        thickness: AO_THICKNESS_IN,
        distanceExponent: AO_DISTANCE_EXPONENT,
        distanceFallOff: AO_DISTANCE_FALLOFF,
        scale: AO_POWER,
        samples: AO_SAMPLES,
        screenSpaceRadius: false,
      });
      // the denoise's depth weight is in view units too: 2 in, not the default's 2 m
      gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
      gtao.setSceneClipBox(clipBox);
    }
    gtao.setCamera(camera);
    return gtao;
  }

  function ensureBloom(): UnrealBloomPass {
    if (!bloom) {
      const bw = div(w, BLOOM_RES_DIVISOR);
      const bh = div(h, BLOOM_RES_DIVISOR);
      bloom = new UnrealBloomPass(new THREE.Vector2(bw, bh), BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);
      const uniforms = bloom.highPassUniforms as Record<string, THREE.IUniform>;
      bloom.materialHighPassFilter.dispose();
      bloomHigh = highPassMaterial(uniforms);
      bloom.materialHighPassFilter = bloomHigh;
    }
    return bloom;
  }

  function freeGtao(): void {
    gtao?.disposeAll();
    gtao = null;
  }
  function freeBloom(): void {
    bloom?.dispose();
    bloomHigh?.dispose();
    bloom = null;
    bloomHigh = null;
  }

  return {
    emissiveGain: BLOOM_EMISSIVE_GAIN,
    panelCap: BLOOM_PANEL_CAP,

    setSize(width, height) {
      w = Math.max(1, Math.round(width));
      h = Math.max(1, Math.round(height));
      ping?.setSize(w, h);
      // `GTAOPass.setSize` copies the camera's projection too; the camera is re-read every frame
      gtao?.setSize(div(w, AO_RES_DIVISOR), div(h, AO_RES_DIVISOR));
      bloom?.setSize(div(w, BLOOM_RES_DIVISOR), div(h, BLOOM_RES_DIVISOR));
    },

    render(renderer, input, camera, opts) {
      if (!opts.ao) freeGtao();
      if (!opts.bloom) freeBloom();
      // THE STATE THE PASSES CHANGE, taken before any of them runs. Each restores it on the way
      // out, but not on a throw: GTAO would leave `overrideMaterial` set and the glass hidden, and
      // both leave `autoClear` off, so every later frame drew normals into an uncleared target.
      // The scene drops post on a throw and carries on, so it has to carry on from here.
      const autoClear = renderer.autoClear;
      const clearAlpha = renderer.getClearAlpha();
      renderer.getClearColor(savedClear);
      const background = scene.background;
      try {
        return runPasses(renderer, input, camera, opts);
      } catch (err) {
        gtao?.recoverFromThrow();
        scene.overrideMaterial = null;
        scene.background = background;
        renderer.autoClear = autoClear;
        renderer.setClearColor(savedClear, clearAlpha);
        throw err;
      }
    },

    dispose() {
      freeGtao();
      freeBloom();
      ping?.dispose();
      ping = null;
      copyQuad.dispose();
      copyMat.dispose();
    },
  };

  function runPasses(
    renderer: THREE.WebGLRenderer,
    input: THREE.WebGLRenderTarget,
    camera: THREE.Camera,
    opts: PostOptions,
  ): THREE.WebGLRenderTarget {
    let current = input;

    if (opts.ao) {
      const pass = ensureGtao(camera);
      const out = ensurePing();
      pass.render(renderer, out, current, 0, false);
      current = out;
    }

    if (opts.bloom) {
      // THE MSAA RULE (header): bloom blends into its input, and a multisampled input cannot
      // be drawn into after its resolve. AO's output is already a 0-sample target of ours.
      if (current.samples > 0) {
        const out = ensurePing();
        copyMat.uniforms.tDiffuse.value = current.texture;
        renderer.setRenderTarget(out);
        copyQuad.render(renderer);
        current = out;
      }
      const pass = ensureBloom();
      pass.threshold = BLOOM_THRESHOLD / Math.max(0.05, renderer.toneMappingExposure);
      const u = pass.highPassUniforms as Record<string, THREE.IUniform>;
      u.smoothWidth.value = BLOOM_KNEE / Math.max(0.05, renderer.toneMappingExposure);
      (bloomHigh!.uniforms.invInput.value as THREE.Vector2).set(1 / current.width, 1 / current.height);
      pass.render(renderer, null as unknown as THREE.WebGLRenderTarget, current, 0, false);
    }

    if (!opts.ao && !(opts.bloom && input.samples > 0) && ping) {
      ping.dispose();
      ping = null;
    }
    return current;
  }
}
