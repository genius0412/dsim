// EDGE-ALIASING PROBE — the real `BiobuzzScene` over a fixed set of views, and a SUPERSAMPLED
// REFERENCE of each frame so "jaggy" is a number. Driven offscreen by `run.cjs`; never built or
// shipped. `?tier=<GraphicsTier>` picks the graphics column (written to the real store before the
// scene exists, the path a player's own pick takes).
//
// The reference renders the SAME scene through the SAME camera, S×S samples per device pixel in
// tiles (the camera's projection is re-windowed per tile, so a solved off-axis camera stays exact),
// into a 0-sample half-float target, then TONE-MAPS EACH SAMPLE (the blit's ACES and exposure) and
// box-averages in display-linear light before the sRGB encode. That is the picture an ideal
// antialiaser would show: coverage weighted in the light the eye sees, not in HDR. Shadows come
// from the frame's own map (`autoUpdate` is off), so shadow-map steps are NOT error against it; a
// second reference with a 4× map measures those separately (`refShadow`).
//
// `__aa.classes()` renders a per-pixel class map at device resolution, one sample: the surface's
// category, whether a GEOMETRIC edge (category change or a depth step) runs through the pixel, and
// whether clear polycarbonate covers it. `run.cjs` attributes edge error with it.

import * as THREE from 'three';
import { initPhysics } from '../../src/sim/physicsEngine';
import { createBiobuzzWorld } from '../../src/games/biobuzz/spawn';
import { biobuzzStep } from '../../src/games/biobuzz/step';
import { DEFAULT_ASSISTS, type RobotSetup } from '../../src/sim/spawn';
import { BB_DEFAULT_SPEC } from '../../src/games/biobuzz/robotConfig';
import { SIM_DT } from '../../src/config';
import { viewAngleOf } from '../../src/sim/field';
import type { Alliance, RobotCommand, World } from '../../src/types';
import type { SceneCamera, ScenePose, SceneFrame } from '../../src/games/module';
import { moduleFor } from '../../src/games';
import { setGraphicsPreset, setGraphicsSetting, GFX_TIERS, type GraphicsTier } from '../../src/games/biobuzz/graphics/settings';
import { POSES, SHOW, STAGE_SEED } from '../../src/ui/menuStagePoses';

const params = new URLSearchParams(location.search);
// no `?tier=`: an idle page (what a preview pane opens), so the server can run without a 3D scene
const idle = !params.get('tier');
const tier = (params.get('tier') ?? 'high') as GraphicsTier;
if ((GFX_TIERS as readonly string[]).includes(tier)) setGraphicsPreset(tier);
// optional single-row overrides for experiments: `&set=aa:off,renderScale:100`
for (const kv of (params.get('set') ?? '').split(',').filter(Boolean)) {
  const [k, v] = kv.split(':');
  const num = Number(v);
  setGraphicsSetting(k as never, (v === 'true' ? true : v === 'false' ? false : Number.isFinite(num) ? num : v) as never);
}

function setup(id: number, alliance: Alliance, startIndex: number): RobotSetup {
  return { id, alliance, spec: { ...BB_DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS }, startIndex };
}

interface View {
  id: string;
  world: 'match' | 'stage';
  camera?: SceneCamera;
  pose?: ScenePose;
  /** per motion frame, the pose at frame k (a camera dolly) */
  move?: (k: number) => ScenePose;
}

/** the probe's fixed views. Poses are field inches, z up; the red driver station is at -y. */
const VIEWS: View[] = [
  { id: 'driver', world: 'match', camera: 'driver' },
  { id: 'chase', world: 'match', camera: 'chase' },
  // grazing along the floor from behind the red wall, a long lens on the far tape and tile joints
  { id: 'tape', world: 'match', pose: { eye: [-20, -95, 26], target: [10, 40, 0], fovDeg: 28 } },
  // a hive and the far wall against the venue's lit back wall
  { id: 'hive', world: 'match', pose: { eye: [-30, -120, 46], target: [0, 0, 26], fovDeg: 30 } },
  // a robot close up
  { id: 'robot', world: 'stage', pose: { eye: [SHOW.x + 26, SHOW.y - 30, 26], target: [SHOW.x, SHOW.y, 8], fovDeg: 34 } },
  { id: 'home', world: 'stage', pose: POSES.home },
  { id: 'setup', world: 'stage', pose: POSES.setup },
  // the driver's height, dollying sideways a quarter inch a frame: what the field does in motion
  {
    id: 'dolly',
    world: 'match',
    move: (k) => ({ eye: [-30 + 0.25 * k, -110, 54], target: [-30 + 0.25 * k, 20, 0], fovDeg: 60 }),
  },
];

async function main(): Promise<void> {
  await initPhysics();
  const match = createBiobuzzWorld('match', 4242, [setup(0, 'red', 0), setup(1, 'red', 1), setup(2, 'blue', 0), setup(3, 'blue', 1)], undefined, '2d');
  match.match.phase = 'teleop';
  match.match.phaseTimeLeft = 120;
  const drive: RobotCommand = { driveX: 0, driveY: 1, rotate: 0.15, leftDrive: 0, rightDrive: 0, intake: true, fire: false };
  const commands = new Map<number, RobotCommand>([0, 1, 2, 3].map((id) => [id, drive]));
  for (let i = 0; i < 90; i++) biobuzzStep(match, SIM_DT, commands);

  const mod = moduleFor('biobuzz');
  const stage = mod.createWorld('match', STAGE_SEED, [setup(0, 'blue', 0)], undefined, '3d');
  stage.robots[0].pos = { x: SHOW.x, y: SHOW.y };
  stage.robots[0].heading = SHOW.heading;
  mod.restMenuWorld?.(stage);

  const { createBiobuzzScene } = await import('../../src/games/biobuzz/scene/renderScene');
  const host = document.getElementById('host')!;
  const scene = await createBiobuzzScene(host, { interactive: false, tunesTier: false });
  const gs = scene as unknown as {
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    target: THREE.WebGLRenderTarget | null;
    robots: { group: THREE.Group };
    elements: { group: THREE.Group };
    venue: THREE.Group | null;
    field: { group: THREE.Group };
    sun: THREE.DirectionalLight;
  };
  const renderer = gs.renderer;

  // the camera of the frame's SCENE pass (the one drawn into the MSAA target, or the canvas on Low)
  let lastCam: THREE.Camera | null = null;
  let probing = false;
  const orig = renderer.render.bind(renderer);
  renderer.render = (s: THREE.Object3D, c: THREE.Camera) => {
    if (!probing && s === gs.scene && renderer.getRenderTarget() === gs.target) lastCam = c;
    orig(s, c);
  };

  let view: View = VIEWS[0];
  let frameK = 0;
  let still = true;
  const frameOf = (): SceneFrame => {
    const pose = view.move ? view.move(frameK) : view.pose;
    return {
      alpha: 1,
      viewAngle: viewAngleOf('red'),
      camera: view.camera ?? 'driver',
      localRobotId: view.world === 'match' ? 0 : undefined,
      localStartCat: 'close',
      width: host.clientWidth,
      height: host.clientHeight,
      dpr: window.devicePixelRatio || 1,
      pose,
    } as SceneFrame;
  };
  const worldOf = (): World => (view.world === 'stage' ? stage : match);
  let frames = 0;
  let sized = '';
  const loop = (): void => {
    // what `GameController` does on a size change
    const key = `${host.clientWidth}x${host.clientHeight}@${devicePixelRatio}`;
    if (key !== sized) {
      sized = key;
      scene.resize(host.clientWidth, host.clientHeight, devicePixelRatio);
    }
    if (still && !probing) {
      scene.render(worldOf(), frameOf());
      frames++;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  // ── the reference ──────────────────────────────────────────────────────────────────────────
  const TILE = 256; // device pixels per tile side
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const down = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { src: { value: null }, S: { value: 6 }, exposure: { value: 1 } },
    vertexShader: `out vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `
      precision highp float;
      uniform highp sampler2D src; uniform int S; uniform float exposure;
      out vec4 outColor;
      vec3 RRTAndODTFit(vec3 v){ vec3 a = v*(v+0.0245786)-0.000090537; vec3 b = v*(0.983729*v+0.4329510)+0.238081; return a/b; }
      vec3 aces(vec3 color){
        const mat3 I = mat3(vec3(0.59719,0.07600,0.02840), vec3(0.35458,0.90834,0.13383), vec3(0.04823,0.01566,0.83777));
        const mat3 O = mat3(vec3(1.60475,-0.10208,-0.00327), vec3(-0.53108,1.10813,-0.07276), vec3(-0.07367,-0.00605,1.07602));
        color *= exposure / 0.6; color = I*color; color = RRTAndODTFit(color); color = O*color; return clamp(color, 0.0, 1.0);
      }
      vec3 srgb(vec3 c){ return mix(c*12.92, pow(c, vec3(0.41666))*1.055-0.055, step(vec3(0.0031308), c)); }
      void main(){
        ivec2 p = ivec2(gl_FragCoord.xy) * S;
        vec3 sum = vec3(0.0);
        for (int j = 0; j < S; j++) for (int i = 0; i < S; i++) {
          vec3 c = texelFetch(src, p + ivec2(i, j), 0).rgb;
          // a NaN texel (the scene leaves a few on robots, biobuzz.md) must not poison the pixel
          if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
          sum += aces(max(c, vec3(0.0)));
        }
        outColor = vec4(srgb(sum / float(S*S)), 1.0);
      }`,
    depthTest: false,
    depthWrite: false,
  });

  /** device size of the canvas as the compositor shows it */
  const deviceSize = (): [number, number] => [Math.round(host.clientWidth * devicePixelRatio), Math.round(host.clientHeight * devicePixelRatio)];

  /** a tile camera: the frame camera's projection re-windowed to NDC [x0,x1]×[y0,y1] */
  function tileCamera(cam: THREE.Camera, x0: number, x1: number, y0: number, y1: number): THREE.Camera {
    const c = cam.clone();
    const sx = 2 / (x1 - x0);
    const sy = 2 / (y1 - y0);
    const m = new THREE.Matrix4().set(sx, 0, 0, -sx * (x0 + x1) / 2, 0, sy, 0, -sy * (y0 + y1) / 2, 0, 0, 1, 0, 0, 0, 0, 1);
    c.projectionMatrix.copy(m.multiply(cam.projectionMatrix));
    c.projectionMatrixInverse.copy(c.projectionMatrix).invert();
    // `clone` would let three recompute it from fov/aspect on the next updateProjectionMatrix; nothing calls it here
    return c;
  }

  /** render the frame's scene through `cam` S×S per device pixel, tone-mapped per sample, as RGBA8 rows (top row first) */
  function reference(S: number): { W: number; H: number; px: Uint8Array } {
    const cam = lastCam;
    if (!cam) throw new Error('no frame drawn yet');
    const [W, H] = deviceSize();
    const out = new Uint8Array(W * H * 4);
    const hdr = new THREE.WebGLRenderTarget(TILE * S, TILE * S, { type: THREE.HalfFloatType, depthBuffer: true, samples: 0 });
    hdr.texture.colorSpace = THREE.LinearSRGBColorSpace;
    hdr.texture.minFilter = THREE.NearestFilter;
    hdr.texture.magFilter = THREE.NearestFilter;
    hdr.texture.generateMipmaps = false;
    const ldr = new THREE.WebGLRenderTarget(TILE, TILE, { type: THREE.UnsignedByteType, depthBuffer: false });
    const buf = new Uint8Array(TILE * TILE * 4);
    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    probing = true;
    try {
      renderer.shadowMap.needsUpdate = false;
      down.uniforms.S.value = S;
      down.uniforms.exposure.value = renderer.toneMappingExposure;
      down.uniforms.src.value = hdr.texture;
      quad.material = down;
      for (let ty = 0; ty < H; ty += TILE) {
        for (let tx = 0; tx < W; tx += TILE) {
          const tw = Math.min(TILE, W - tx);
          const th = Math.min(TILE, H - ty);
          // NDC: x left→right, y bottom→top; tile rows are counted from the TOP
          const x0 = -1 + (2 * tx) / W;
          const x1 = -1 + (2 * (tx + tw)) / W;
          const y1 = 1 - (2 * ty) / H;
          const y0 = 1 - (2 * (ty + th)) / H;
          const tc = tileCamera(cam, x0, x1, y0, y1);
          hdr.setSize(tw * S, th * S);
          renderer.setRenderTarget(hdr);
          renderer.clear();
          orig(gs.scene, tc);
          ldr.setSize(tw, th);
          renderer.setRenderTarget(ldr);
          orig(quadScene, quadCam);
          renderer.readRenderTargetPixels(ldr, 0, 0, tw, th, buf);
          for (let r = 0; r < th; r++) {
            // GL rows are bottom-up
            const srcRow = (th - 1 - r) * tw * 4;
            out.set(buf.subarray(srcRow, srcRow + tw * 4), ((ty + r) * W + tx) * 4);
          }
        }
      }
    } finally {
      probing = false;
      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = prevAuto;
      hdr.dispose();
      ldr.dispose();
    }
    return { W, H, px: out };
  }

  // ── the class map ──────────────────────────────────────────────────────────────────────────
  // categories (R channel): 1 floor, 2 tape, 3 field structure, 4 hive, 5 robot, 6 element, 7 venue, 0 background
  const CAT_NAMES = ['background', 'floor', 'tape', 'structure', 'hive', 'robot', 'element', 'venue', 'glass'];
  function isUnder(o: THREE.Object3D, root: THREE.Object3D | null): boolean {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p === root) return true;
    return false;
  }
  function nameChain(o: THREE.Object3D): string {
    const parts: string[] = [];
    for (let p: THREE.Object3D | null = o; p; p = p.parent) parts.push(p.name);
    return parts.join('/').toLowerCase();
  }
  function catOf(mesh: THREE.Mesh): number {
    if (isUnder(mesh, gs.robots.group)) return 5;
    if (isUnder(mesh, gs.elements.group)) return 6;
    if (gs.venue && isUnder(mesh, gs.venue)) return 7;
    const n = nameChain(mesh);
    if (n.includes('tape')) return 2;
    if (n.startsWith('floor') || n.includes('/floor') || n.includes('tile')) return 1;
    if (n.includes('hive')) return 4;
    return 3;
  }
  const idMat = (cat: number): THREE.ShaderMaterial =>
    new THREE.ShaderMaterial({
      uniforms: { cat: { value: cat } },
      vertexShader: `
        #include <common>
        #include <batching_pars_vertex>
        varying float vDepth;
        void main() {
          #include <batching_vertex>
          #include <begin_vertex>
          #include <project_vertex>
          vDepth = -mvPosition.z;
        }`,
      fragmentShader: `uniform float cat; varying float vDepth; void main(){ gl_FragColor = vec4(cat, vDepth, 0.0, 1.0); }`,
      side: THREE.DoubleSide,
    });

  function classPass(glassOnly: boolean, W: number, H: number, cam: THREE.Camera): Float32Array {
    const swapped: [THREE.Mesh, THREE.Material | THREE.Material[], boolean][] = [];
    const mats = new Map<number, THREE.ShaderMaterial>();
    gs.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible) return;
      const m0 = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      const glass = !!m0 && m0.transparent;
      const cat = glass ? 8 : catOf(mesh);
      const show = glassOnly ? glass : !glass;
      if (!mats.has(cat)) mats.set(cat, idMat(cat));
      swapped.push([mesh, mesh.material, mesh.visible]);
      mesh.material = mats.get(cat)!;
      mesh.visible = show;
    });
    const bg = gs.scene.background;
    const t = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, depthBuffer: true });
    const out = new Float32Array(W * H * 4);
    probing = true;
    try {
      gs.scene.background = null;
      renderer.setRenderTarget(t);
      renderer.setClearColor(0x000000, 1);
      renderer.clear();
      orig(gs.scene, cam);
      renderer.readRenderTargetPixels(t, 0, 0, W, H, out);
    } finally {
      probing = false;
      for (const [mesh, m, v] of swapped) {
        mesh.material = m;
        mesh.visible = v;
      }
      gs.scene.background = bg;
      renderer.setRenderTarget(null);
      t.dispose();
      for (const m of mats.values()) m.dispose();
    }
    return out;
  }

  /** per device pixel: low nibble = category (glass = 8 where it covers an otherwise smooth pixel),
   * bit 4 = a geometric edge runs through the 3×3 around it. Rows top first. */
  function classes(): { W: number; H: number; px: Uint8Array } {
    const cam = lastCam;
    if (!cam) throw new Error('no frame drawn yet');
    const [W, H] = deviceSize();
    const opaque = classPass(false, W, H, cam);
    const glass = classPass(true, W, H, cam);
    const out = new Uint8Array(W * H);
    const at = (x: number, y: number): number => ((H - 1 - y) * W + x) * 4; // GL rows bottom-up
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = at(x, y);
        const c = opaque[i];
        const d = opaque[i + 1];
        let edge = false;
        for (let dy = -1; dy <= 1 && !edge; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = Math.min(W - 1, Math.max(0, x + dx));
            const yy = Math.min(H - 1, Math.max(0, y + dy));
            const j = at(xx, yy);
            const cj = opaque[j];
            const dj = opaque[j + 1];
            if (cj !== c || (d > 0 && dj > 0 && Math.abs(dj - d) > 0.03 * Math.min(d, dj))) {
              edge = true;
              break;
            }
          }
        }
        let cat = c;
        // glass in front, and its own silhouette or none at all under it: a glass pixel
        if (glass[i] === 8 && (glass[i + 1] < d || d === 0)) {
          let glassEdge = false;
          for (let dy = -1; dy <= 1 && !glassEdge; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const xx = Math.min(W - 1, Math.max(0, x + dx));
              const yy = Math.min(H - 1, Math.max(0, y + dy));
              const j = at(xx, yy);
              if (glass[j] !== 8 || Math.abs(glass[j + 1] - glass[i + 1]) > 0.03 * glass[i + 1]) {
                glassEdge = true;
                break;
              }
            }
          }
          if (glassEdge || !edge) {
            cat = 8;
            edge = edge || glassEdge;
          }
        }
        out[y * W + x] = (cat & 15) | (edge ? 16 : 0);
      }
    }
    return { W, H, px: out };
  }

  /** RGBA rows → PNG data URL (for `run.cjs`, which decodes it with `nativeImage`) */
  function toPng(W: number, H: number, rgba: Uint8Array): string {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const x = c.getContext('2d')!;
    const id = x.createImageData(W, H);
    id.data.set(rgba);
    x.putImageData(id, 0, 0);
    return c.toDataURL('image/png');
  }

  /** frame GPU time: the scene's whole `render`, timed with the disjoint timer query */
  async function gpuTime(n: number): Promise<{ p50: number; p95: number; cpu50: number } | null> {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!ext) return null;
    const gpu: number[] = [];
    const cpu: number[] = [];
    probing = true;
    try {
      for (let i = 0; i < n + 10; i++) {
        const q = gl.createQuery()!;
        const t0 = performance.now();
        gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
        probing = false;
        scene.render(worldOf(), frameOf());
        probing = true;
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        gl.flush();
        if (i >= 10) cpu.push(performance.now() - t0);
        await new Promise((r) => setTimeout(r, 20));
        for (let k = 0; k < 50 && !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE); k++) await new Promise((r) => setTimeout(r, 5));
        if (i >= 10 && !gl.getParameter(ext.GPU_DISJOINT_EXT)) gpu.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(q);
      }
    } finally {
      probing = false;
    }
    const pct = (a: number[], p: number): number => {
      const s = [...a].sort((x, y) => x - y);
      return s[Math.min(s.length - 1, Math.floor(p * s.length))];
    };
    return { p50: pct(gpu, 0.5), p95: pct(gpu, 0.95), cpu50: pct(cpu, 0.5) };
  }

  (window as unknown as { __aa: unknown }).__aa = {
    views: VIEWS.map((v) => ({ id: v.id, moving: !!v.move })),
    cats: CAT_NAMES,
    setView(id: string, k = 0) {
      view = VIEWS.find((v) => v.id === id) ?? VIEWS[0];
      frameK = k;
    },
    frames: () => frames,
    info() {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const t = gs.target;
      return {
        tier,
        dpr: devicePixelRatio,
        css: [host.clientWidth, host.clientHeight],
        pr: renderer.getPixelRatio(),
        buf: [gl.drawingBufferWidth, gl.drawingBufferHeight],
        samples: t ? t.samples : 'none',
        target: t ? [t.width, t.height] : null,
        canvas: [renderer.domElement.width, renderer.domElement.height, renderer.domElement.clientWidth, renderer.domElement.clientHeight],
        exposure: renderer.toneMappingExposure,
        shadow: renderer.shadowMap.enabled ? gs.sun.shadow.mapSize.x : 0,
        gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      };
    },
    reference(S: number): string {
      const r = reference(S);
      return toPng(r.W, r.H, r.px);
    },
    /** the reference with the sun's map at 4× the texels (and the same blur in inches) */
    refShadow(S: number): string {
      const sh = gs.sun.shadow;
      const was = { size: sh.mapSize.x, radius: sh.radius, samples: sh.blurSamples };
      if (!renderer.shadowMap.enabled) return this.reference(S);
      const big = Math.min(8192, was.size * 4);
      const k = big / was.size;
      sh.mapSize.set(big, big);
      sh.radius = was.radius * k;
      sh.blurSamples = Math.min(64, was.samples * 2);
      sh.map?.dispose();
      sh.map = null as unknown as THREE.WebGLRenderTarget;
      // three's VSM pass target is cached on the shadow as `mapPass`
      const any = sh as unknown as { mapPass?: THREE.WebGLRenderTarget | null };
      any.mapPass?.dispose();
      any.mapPass = null;
      probing = true;
      renderer.shadowMap.needsUpdate = true;
      renderer.setRenderTarget(null);
      orig(gs.scene, lastCam!);
      probing = false;
      const png = this.reference(S);
      sh.mapSize.set(was.size, was.size);
      sh.radius = was.radius;
      sh.blurSamples = was.samples;
      sh.map?.dispose();
      sh.map = null as unknown as THREE.WebGLRenderTarget;
      any.mapPass?.dispose();
      any.mapPass = null;
      renderer.shadowMap.needsUpdate = true;
      return png;
    },
    classes(): string {
      const c = classes();
      const rgba = new Uint8Array(c.W * c.H * 4);
      for (let i = 0; i < c.W * c.H; i++) {
        rgba[i * 4] = c.px[i];
        rgba[i * 4 + 3] = 255;
      }
      return toPng(c.W, c.H, rgba);
    },
    gpuTime,
    /** the scene target's HDR after a frame: the share of pixels bloom draws from (luminance ×
     * exposure past its 3.0 threshold) and the share at the decode's clip (any channel within 2 % of
     * 25.7 × 0.6 / exposure, where ACES clipped and the split capped it) */
    hdrStats(): { bloomShare: number; clipShare: number; clipOfBloom: number } | null {
      const t = gs.target;
      if (!t) return null;
      const n = t.width * t.height;
      const buf = new Uint16Array(n * 4);
      renderer.readRenderTargetPixels(t, 0, 0, t.width, t.height, buf);
      const ex = renderer.toneMappingExposure;
      const cap = (25.7 * 0.6) / ex;
      let bloom = 0;
      let clip = 0;
      let both = 0;
      for (let i = 0; i < n; i++) {
        const r = THREE.DataUtils.fromHalfFloat(buf[i * 4]);
        const g = THREE.DataUtils.fromHalfFloat(buf[i * 4 + 1]);
        const b = THREE.DataUtils.fromHalfFloat(buf[i * 4 + 2]);
        const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) * ex;
        const hot = lum > 3.0;
        const atCap = Math.max(r, g, b) > cap * 0.98;
        if (hot) bloom++;
        if (atCap) clip++;
        if (hot && atCap) both++;
      }
      return { bloomShare: bloom / n, clipShare: clip / n, clipOfBloom: bloom ? both / bloom : 0 };
    },
    /** a robot CARD as Play draws it (the preview scene at `tier`, `capture(192)`), and the same
     * card at 4× the size for a box-filtered reference: two PNG data URLs */
    async card(cardTier: GraphicsTier): Promise<[string, string]> {
      const factory = await mod.previewScene!();
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;left:-2000px;top:0;width:300px;height:300px';
      document.body.appendChild(el);
      const card = factory!(el, { interactive: false, animate: false, quality: cardTier });
      card.setSpec(BB_DEFAULT_SPEC, 'blue');
      await card.ready();
      const small = card.capture(192, BB_DEFAULT_SPEC, 'blue');
      const big = card.capture(768, BB_DEFAULT_SPEC, 'blue');
      card.dispose();
      el.remove();
      return [small, big];
    },
    hold(on: boolean) {
      still = on;
    },
    /** with the loop held: draw ONE frame and read the canvas back in the same task (the buffer is
     * gone after the composite), as a PNG at the drawing buffer's own size */
    renderOnce(read: boolean): string {
      scene.render(worldOf(), frameOf());
      if (!read) return '';
      const gl = renderer.getContext() as WebGL2RenderingContext;
      const W = gl.drawingBufferWidth;
      const H = gl.drawingBufferHeight;
      const px = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const rows = new Uint8Array(W * H * 4);
      for (let y = 0; y < H; y++) rows.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
      return toPng(W, H, rows);
    },
  };
  (window as unknown as { __aaReady: boolean }).__aaReady = true;
}

if (!idle) void main();
