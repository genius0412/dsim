import * as THREE from 'three';
import { probeGpu } from '../graphics/auto';

/**
 * BIOBUZZ 3D SCENE — the bits EVERY scene in this directory is built the same way from.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────────
 * There are two Three.js scenes now: the match view (`renderScene.ts`) and the robot-builder
 * turntable (`renderPreview.ts`). They frame completely different things, but a preview whose
 * renderer is set up even slightly differently from the match's is a preview that LIES — the
 * same robot would come out a different colour, because tone mapping, the output colour space
 * and the shadow filter are all per-RENDERER settings and every one of them changes the pixels.
 * That is the drift `docs/roadmap.md` item 1 names as its own risk, and the cheapest way to
 * make it impossible is for there to be exactly one place that makes a renderer and exactly one
 * set of numbers for the light rig.
 *
 * So: the renderer factory, the light-rig constants, the WebGL2 probe, the themed backdrop read
 * and the disposal walk live here, and both scenes import them. Nothing in this file knows what
 * a `World` is; it is renderer plumbing only.
 */

/**
 * WebGL2 SUPPORT, PROBED ONCE PER DOCUMENT.
 *
 * `probeGpu` creates (and immediately loses) a real WebGL2 context, and Chrome caps how many a
 * page may hold — probing per scene mount would eventually cost a scene the context it is
 * trying to create. The builder preview, the thumbnail scene and the match view all share this
 * one answer. (The AUTO-quality first guess is a separate thing and stays in `renderScene.ts`:
 * it applies a graphics preference, which a preview must not do.)
 */
let cachedProbe: ReturnType<typeof probeGpu> | null = null;
export function gpuProbe(): ReturnType<typeof probeGpu> {
  if (cachedProbe) return cachedProbe;
  const probe = probeGpu();
  // ONLY A GOOD ANSWER IS KEPT. A probe taken while the page sat at the context cap, or while
  // Chrome was on its software rasteriser after a GPU-process crash, said "no" for the rest of
  // the tab, so the 3D button could not work again until a reload. A "no" is asked again on the
  // next mount, and mounts only happen when the player asks for 3D.
  if (probe.webgl2 && !probe.software) cachedProbe = probe;
  return probe;
}

/**
 * FREE A RENDERER'S CONTEXT NOW, not at the next garbage collection. `dispose()` alone leaves
 * the WebGL context alive until the canvas is collected, and Chrome caps a page at 16: every
 * builder visit, view switch and match left one behind, and at the cap Chrome drops the OLDEST
 * live one, which can be the scene on screen. Callers remove their `webglcontextlost` listener
 * first (their teardown list runs before this), so the forced loss is not read as a failure.
 */
export function releaseRenderer(renderer: THREE.WebGLRenderer): void {
  renderer.dispose();
  renderer.forceContextLoss();
}

/** thrown by a scene factory that cannot run here — no WebGL2, or a software rasteriser. The
 * host catches it and shows the 2D view instead; `reason` is what it may print. */
export class SceneUnsupportedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`BIOBUZZ 3D scene unsupported: ${reason}`);
    this.name = 'SceneUnsupportedError';
    this.reason = reason;
  }
}

/** literal fallback for the letterbox backdrop colour — `COLORS.backdropDark` (`src/config.ts`),
 * copied rather than imported so this file's imports stay renderer plumbing; the CSS token is
 * read at creation instead (see below). */
const BACKDROP_FALLBACK = 0x20262c;

/** the letterbox backdrop's current CSS value, read via `--ds-bg` (the token
 * `COLORS.backdrop`/`backdropDark` tracks — `src/config.ts`'s own comment on `backdrop`).
 *
 * ⚠️ READ ON EVERY THEME CHANGE, not once (Day 2 fix). It used to be read once at construction,
 * so toggling light/dark while a 3D view was mounted left the old letterbox behind the field
 * until the scene was torn down and rebuilt — and on the CAD field path the backdrop is not a
 * letterbox at all but the whole surround (`glbFieldToHandles` adds no procedural room), so the
 * stale colour was most of the picture. `BiobuzzScene` watches `documentElement`'s `data-theme`
 * attribute — the attribute `src/theme.ts`'s `applyTheme` stamps, and the same signal
 * `docs/area/ui.md` tells JS to read instead of `getComputedStyle` — and re-reads this. The
 * VENUE's own colours (`scene/renderVenue.ts`, per environment) stay fixed: their ground is the
 * canvas, category 3 in the theming note, so a hall does not turn white in the light theme.
 *
 * ⚠️ AND IT MATTERS LESS THAN IT DID. The backdrop is only ever seen where the venue is not —
 * above an outdoor horizon, in the gap a camera finds past a hall's wall — because there is real
 * geometry around the field now instead of a grey cylinder that existed on the constants path
 * alone. It is still read on every theme change; it is just no longer most of the picture. */
export function readBackdropColor(): number {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--ds-bg').trim();
    if (/^#[0-9a-fA-F]{6}$/.test(raw)) return parseInt(raw.slice(1), 16);
  } catch {
    // getComputedStyle can throw on a detached / pre-layout document; the literal covers it
  }
  return BACKDROP_FALLBACK;
}

// ───────────────────────────────────────────────────────────────────────── the light rig ──
//
// THE LIGHT RIG'S NUMBERS, in one place because two scenes light the same robot. Every value
// here was tuned against the match view in the 2026-09-18 playtest ("very dark, shadows don't
// look good") and the reasoning is on the constants themselves. A preview that picked its own
// would show a robot that is not the robot the match draws.

/** ACES exposure. 1.0 (ACES's own neutral) rendered the dark tile albedo near-black; 1.35 with a
 * brighter hemi/sun pair washed the alliance tray panels out to pastel under the highlight
 * roll-off. 1.2 is the value between them that reads back close to the 2D canvas. */
export const SCENE_EXPOSURE = 1.2;
/** hemisphere fill: white sky, a light-grey (not near-navy) ground term so light bounced off the
 * dark tiles lifts the underside of a robot instead of leaving it silhouetted. */
export const SCENE_HEMI_SKY = 0xffffff;
export const SCENE_HEMI_GROUND = 0x4b525c;
/** hemisphere intensity WITH image-based lighting on, and without — with the IBL off it is most
 * of the ambient term there is, so it has to carry more. */
export const SCENE_HEMI_INTENSITY = 1.3;
export const SCENE_HEMI_INTENSITY_NO_IBL = 2.1;
/** the key light. */
export const SCENE_SUN_INTENSITY = 1.9;
/**
 * BIAS/NORMAL-BIAS, TUNED TOGETHER. `bias` alone at a value that kills acne on a flat floor
 * peter-pans a THIN caster (a wall frame, a flower pipe, a sweeper bar) off its own base;
 * `normalBias` offsets along the surface normal instead and closes that gap without reopening
 * the acne. Both scenes' shadow cameras are sized differently and these still hold, because
 * they are in world units against geometry of the same scale.
 */
export const SCENE_SHADOW_BIAS = -0.0012;
export const SCENE_SHADOW_NORMAL_BIAS = 0.035;

/**
 * A `WebGLRenderer` set up the way EVERY scene in this directory wants it.
 *
 * ⚠️ `antialias` IS A CALLER'S DECISION AND IT CANNOT BE CHANGED AFTERWARDS. The context
 * attribute is fixed for the life of the context and WebGL gives no way to ask the default
 * framebuffer for a PARTICULAR sample count — you get "some" MSAA or none. The MATCH view
 * therefore passes `false` and owns a multisampled render target of its own, which is what
 * makes §4.4's "MSAA 2x" a live setting rather than a reload. The small builder PREVIEW passes
 * `true`: its canvas is a 300-px card, its context is created fresh every time the 3D preview
 * is mounted, and a render target plus a blit pass is not a trade worth making for it.
 *
 * `alpha` is the other caller's decision: the match view is opaque (it owns the whole viewport
 * and paints its own letterbox), the preview is transparent so the card's themed surface shows
 * through and it needs no background of its own to keep in step with the theme.
 *
 * `context`: a WebGL2 context made by the caller, which three then uses as it is — the match view
 * passes one on a browser that can go immersive (`BbXR.context`, `renderXR.ts`, which says why).
 */
export function createSceneRenderer(
  canvas: HTMLCanvasElement,
  opts: { antialias: boolean; alpha: boolean; context?: WebGL2RenderingContext },
): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    context: opts.context,
    antialias: opts.antialias,
    alpha: opts.alpha,
    powerPreference: 'high-performance',
  });
  // a context handed in sets three's background alpha from its own attribute (always `alpha: true`,
  // as three creates them), so restate the caller's
  renderer.setClearAlpha(opts.alpha ? 0 : 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // FIDELITY PASS (plan-3d.md §4.4): filmic tone mapping so the key light's highlights roll off
  // instead of clipping — see `SCENE_EXPOSURE` for how the exposure was landed on.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = SCENE_EXPOSURE;
  // `PCFSoftShadowMap` is deprecated in this three release (WebGLShadowMap silently substitutes
  // `PCFShadowMap` and warns) — `VSMShadowMap` is the maintained soft-shadow type and, unlike a
  // bare PCF filter, its blur radius (`shadow.radius`) is genuinely a BLUR rather than a wider
  // hard-edge sample pattern, which is what "shadows don't look good" was pointing at.
  renderer.shadowMap.type = THREE.VSMShadowMap;
  return renderer;
}

/**
 * ⚠️ **WATCH FOR A LOST WEBGL CONTEXT. THE BROWSER WILL NOT TELL YOU ANY OTHER WAY.**
 *
 * A context is lost on a GPU reset, a driver update, a laptop switching graphics card, a tab
 * backgrounded long enough on a memory-pressured phone, or another tab taking the GPU. What the
 * page sees is NOT an exception: every GL call after it becomes a silent no-op and the canvas
 * keeps whatever pixels it last had. So the failure looks like a FROZEN 3D VIEW that still
 * accepts input, with a HUD updating on top of it — which reads as "the game hung", and the one
 * thing a player cannot do about it is find the 2D view, because the field they are looking at
 * has not moved.
 *
 * `preventDefault()` on the event is what makes restoration POSSIBLE at all (without it the
 * browser never fires `webglcontextrestored`). This scene does not restore — every buffer,
 * texture and program would have to be rebuilt — it hands the loss to the host, which takes the
 * same route the `SceneUnsupportedError` fallback takes: this tab falls back to 2D (`fallBackTo2d`, never stored) and a
 * line goes to the event log. That is a live game a click later instead of a dead canvas.
 *
 * Returns the REMOVER, for the caller's teardown list. A scene that is disposed and remounted
 * (a view switch, a restart) would otherwise leave a listener holding a closure over a dead
 * scene on a canvas that has been detached.
 */
export function watchContextLoss(canvas: HTMLCanvasElement, onLost: () => void): () => void {
  const handler = (e: Event): void => {
    e.preventDefault();
    onLost();
  };
  canvas.addEventListener('webglcontextlost', handler);
  return () => canvas.removeEventListener('webglcontextlost', handler);
}

/** the hemisphere + directional pair every scene here lights with, at the shared intensities.
 * The SHADOW CAMERA is the caller's: a field-sized frustum and a robot-sized one want completely
 * different extents, and sizing it to what is actually casting is the whole of that decision. */
export function createSceneLights(): { hemi: THREE.HemisphereLight; sun: THREE.DirectionalLight } {
  const hemi = new THREE.HemisphereLight(SCENE_HEMI_SKY, SCENE_HEMI_GROUND, SCENE_HEMI_INTENSITY);
  const sun = new THREE.DirectionalLight(0xffffff, SCENE_SUN_INTENSITY);
  sun.shadow.bias = SCENE_SHADOW_BIAS;
  sun.shadow.normalBias = SCENE_SHADOW_NORMAL_BIAS;
  return { hemi, sun };
}

/** free every geometry, material and material map under `root`. Called from a scene's `dispose`;
 * the module-level caches in `renderRobots.ts` are walked too, which is safe because three
 * re-uploads a disposed geometry's (still-resident) attribute data the next time it draws. */
export function disposeObject3D(root: THREE.Object3D): void {
  root.traverse((child) => {
    const mesh = child as Partial<THREE.Mesh> & Partial<THREE.InstancedMesh>;
    if (!mesh.geometry) return;
    mesh.geometry.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const m of materials) {
      const map = (m as THREE.MeshStandardMaterial).map;
      if (map) map.dispose();
      m.dispose();
    }
  });
}
