import * as THREE from 'three';

/**
 * THE SCENE PASS IN TWO HALVES, SO THE MSAA RESOLVE AVERAGES WHAT THE EYE SEES (2026-11-04).
 *
 * The scene used to draw everything into one multisampled half-float target in linear HDR and
 * tone-map at the blit. The hardware resolve averages HDR samples and the tone curve is not linear:
 * a dark rail half over a lit white panel (1.2–1.7 raw × exposure) averages to a value ACES still
 * maps close to white, so the edge keeps a hard step that MSAA had already smoothed. WebGL2 cannot
 * read samples, so the averaging has to happen on values that are already tone-mapped. All in the
 * scene's own multisampled target, which keeps its samples and its depth after a resolve (three
 * invalidates them only on Oculus Browser, and there step 2 rewrites every sample anyway):
 *
 *   1. OPAQUE, with tone mapping IN THE MATERIALS (the target is flagged the way three flags an XR
 *      target, the one switch three reads for that), so every sample holds its display-linear
 *      colour, and the resolve at the end of the call averages in display light. A transparent mesh
 *      that casts or receives is MUTED for this call, not hidden: the sun's VSM map is drawn inside
 *      it from casters and receivers both, and the clear panels cast on standard materials. One that
 *      does neither is left out.
 *   2. DECODE, into the same samples: a full-screen quad writes ACES⁻¹ of the resolved colour to
 *      every sample (no depth test, no depth write, so the per-sample depth of step 1 stays). ACES is
 *      invertible below its clip, so a pixel nothing else covers comes back to its own value at the
 *      blit. A partly covered pixel's samples all hold the same decoded average.
 *   3. TRANSPARENT, in the same call as 2, multisampled, in plain linear HDR blending over the
 *      decoded picture and depth-tested per sample against step 1. Every layer is blended by the
 *      fixed-function blender, so stacks of clear panels compose exactly however many there are,
 *      and their own outlines keep MSAA. That is the difference from `gfx/edge-aa` (2026-10-11,
 *      never merged), which solved each clear layer against the opaque value in a compressed space
 *      and left white dots where one clear layer crossed another.
 * What reaches post and the output is the same linear HDR image as before, in the same target. The
 * cost is one full-screen pass over every sample, one more resolve and the muted draws; no memory
 * (`docs/area/biobuzz.md`, EDGES RESOLVE IN DISPLAY LIGHT, has the numbers).
 */

/** the layer the late call draws: the decode quad, the transparent meshes and the lights. No camera
 * enables it except for that call, so tagging an object with it hides nothing. */
export const LATE_LAYER = 30;

/** three's ACES matrices, column-major as GLSL's `mat3(vec3 …)` reads them (`tonemapping_pars_fragment`) */
export const ACES_IN = [0.59719, 0.076, 0.0284, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777];
export const ACES_OUT = [1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602];

const rrt = (v: number): number => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
const mul = (m: readonly number[], v: readonly number[]): number[] => [
  m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
  m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
  m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
];

/** three's `ACESFilmicToneMapping`, in JS: linear HDR → display-linear, at `exposure` */
export function acesFilmic(c: readonly number[], exposure: number): number[] {
  const k = exposure / 0.6;
  return mul(ACES_OUT, mul(ACES_IN, [c[0] * k, c[1] * k, c[2] * k]).map(rrt)).map((x) => Math.min(1, Math.max(0, x)));
}

/** the rational curve's root per channel: the value `RRTAndODTFit` maps to `y` (below its clip) */
const INV_RRT = /* glsl */ `
vec3 invRRT(vec3 y) {
  vec3 a = 0.983729 * y - 1.0;
  vec3 b = 0.4329510 * y - 0.0245786;
  vec3 c = 0.238081 * y + 0.000090537;
  return (-b - sqrt(max(b * b - 4.0 * a * c, 0.0))) / (2.0 * a);
}`;

/** the JS twin of the decode below, for the RENDER lane */
export function acesFilmicInverse(y: readonly number[], exposure: number, invIn: readonly number[], invOut: readonly number[]): number[] {
  const r = mul(invOut, y).map((x) => Math.min(ACES_CLIP, Math.max(-0.00038, x)));
  const v = r.map((yy) => {
    const a = 0.983729 * yy - 1;
    const b = 0.432951 * yy - 0.0245786;
    const c = 0.238081 * yy + 0.000090537;
    return (-b - Math.sqrt(Math.max(b * b - 4 * a * c, 0))) / (2 * a);
  });
  return mul(invIn, v).map((x) => (x * 0.6) / exposure);
}

/** where the curve's input is clamped before the root: just under its asymptote, 1/0.983729 */
export const ACES_CLIP = 1.015;

const DECODE_VERT = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

/**
 * ACES⁻¹, three's own fit run backwards: the output matrix, the curve per channel, the input matrix,
 * the exposure. The curve reaches 1.0165 only at infinity, so a channel at its clip decodes to a
 * large finite value, which the blit maps straight back to the clip.
 */
export const DECODE_FRAG = /* glsl */ `
uniform sampler2D tColor;
uniform mat3 invIn;
uniform mat3 invOut;
uniform float invExposure;
${INV_RRT}
void main() {
  vec3 y = texelFetch(tColor, ivec2(gl_FragCoord.xy), 0).rgb;
  vec3 r = clamp(invOut * y, vec3(-0.00038), vec3(${ACES_CLIP.toFixed(3)}));
  gl_FragColor = vec4(invIn * invRRT(r) * invExposure, 1.0);
}`;

export interface BbSplitPass {
  /** draw the scene through `camera` into `target` (multisampled, half-float); returns the counts */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, target: THREE.WebGLRenderTarget): { calls: number; triangles: number };
  /** re-collect the transparent meshes (after anything that adds, swaps or rebuilds materials) */
  collect(scene: THREE.Scene, lights: readonly THREE.Light[]): void;
  /** what the late call draws (the decode quad and the transparent meshes), for a shader warm-up */
  lateObjects(): readonly THREE.Object3D[];
  dispose(): void;
}

export function createSplitPass(): BbSplitPass {
  const invIn = new THREE.Matrix3().fromArray(ACES_IN).invert();
  const invOut = new THREE.Matrix3().fromArray(ACES_OUT).invert();
  const decode = new THREE.ShaderMaterial({
    uniforms: { tColor: { value: null }, invIn: { value: invIn }, invOut: { value: invOut }, invExposure: { value: 0.6 } },
    vertexShader: DECODE_VERT,
    fragmentShader: DECODE_FRAG,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), decode);
  quad.name = 'split:decode';
  quad.frustumCulled = false;
  // first of the late call's draws: it is opaque and the rest are transparent, and nothing sorts
  // before this among the opaque
  quad.renderOrder = -1e9;
  quad.layers.set(LATE_LAYER);
  /** the transparent materials and what their two switches were */
  let muted: { m: THREE.Material; color: boolean; depth: boolean }[] = [];
  let tagged: THREE.Object3D[] = [];
  /** the transparent meshes, for step 1: hidden when they neither cast nor receive */
  let lateMeshes: THREE.Mesh[] = [];
  const hidden: THREE.Mesh[] = [];
  let home: THREE.Scene | null = null;
  const clear = new THREE.Color();

  return {
    collect(scene, lights) {
      for (const o of tagged) o.layers.disable(LATE_LAYER);
      tagged = [];
      muted = [];
      lateMeshes = [];
      const seen = new Set<THREE.Material>();
      if (home !== scene) {
        home?.remove(quad);
        scene.add(quad);
        home = scene;
      }
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || mesh === quad) return;
        const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        if (!list.some((m) => m.transparent)) return;
        mesh.layers.enable(LATE_LAYER);
        tagged.push(mesh);
        lateMeshes.push(mesh);
        for (const m of list) {
          if (!m.transparent || seen.has(m)) continue;
          seen.add(m);
          muted.push({ m, color: m.colorWrite, depth: m.depthWrite });
        }
      });
      for (const l of lights) {
        l.layers.enable(LATE_LAYER);
        tagged.push(l);
      }
    },
    lateObjects() {
      return [quad, ...tagged.filter((o) => (o as THREE.Mesh).isMesh)];
    },
    render(renderer, scene, camera, target) {
      const xr = target as unknown as { isXRRenderTarget: boolean };
      const bg = scene.background;
      const exposure = renderer.toneMappingExposure;
      // 1. opaque, tone-mapped per sample. A transparent mesh that neither casts nor receives is
      // left out of this call (a splat venue is millions of splats); one that does is MUTED instead,
      // because VSM draws casters and receivers into the sun's map inside this call. A COLOUR
      // background is a clear, which no material tone-maps, so it is cleared to its own display
      // value here. (A material made opaque since `collect` keeps drawing in this half.)
      for (const mesh of lateMeshes) {
        if (mesh.castShadow || mesh.receiveShadow || !mesh.layers.isEnabled(0)) continue;
        mesh.layers.disable(0);
        hidden.push(mesh);
      }
      for (const t of muted) {
        if (!t.m.transparent) continue;
        t.m.colorWrite = false;
        t.m.depthWrite = false;
      }
      if (bg instanceof THREE.Color) {
        const d = acesFilmic([bg.r, bg.g, bg.b], exposure);
        scene.background = clear.setRGB(d[0], d[1], d[2], THREE.LinearSRGBColorSpace);
      }
      xr.isXRRenderTarget = true;
      let calls = 0;
      let triangles = 0;
      try {
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
        calls = renderer.info.render.calls;
        triangles = renderer.info.render.triangles;
      } finally {
        xr.isXRRenderTarget = false;
        scene.background = bg;
        for (const t of muted) {
          t.m.colorWrite = t.color;
          t.m.depthWrite = t.depth;
        }
        for (const mesh of hidden) mesh.layers.enable(0);
        hidden.length = 0;
      }
      // 2 + 3. decode into every sample, then the transparent objects over it, in one call
      decode.uniforms.tColor.value = target.texture;
      decode.uniforms.invExposure.value = 0.6 / Math.max(1e-4, exposure);
      const auto = renderer.autoClear;
      const mask = camera.layers.mask;
      // step 1 brought every world matrix up to date; walking the whole graph again costs CPU
      const matrices = scene.matrixWorldAutoUpdate;
      renderer.autoClear = false;
      scene.background = null;
      scene.matrixWorldAutoUpdate = false;
      camera.layers.set(LATE_LAYER);
      try {
        renderer.render(scene, camera);
        calls += renderer.info.render.calls;
        triangles += renderer.info.render.triangles;
      } finally {
        camera.layers.mask = mask;
        scene.matrixWorldAutoUpdate = matrices;
        scene.background = bg;
        renderer.autoClear = auto;
      }
      return { calls, triangles };
    },
    dispose() {
      for (const o of tagged) o.layers.disable(LATE_LAYER);
      home?.remove(quad);
      decode.dispose();
      quad.geometry.dispose();
    },
  };
}
