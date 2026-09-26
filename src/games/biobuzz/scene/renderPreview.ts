import * as THREE from 'three';
import type { Alliance, RobotSpec } from '../../../types';
import * as C from '../../../config';
import { BB_TILE_PITCH, bbDeployedHeightIn } from '../config';
import {
  GFX_PRESETS,
  effectivePixelRatio,
  frameIntervalMs,
  getGraphics,
  shadowBlurRadius,
  shadowMapSize,
  subscribeGraphics,
  type GraphicsSettings,
  type GraphicsTier,
} from '../graphics/settings';
import { bbSpecKey } from '../specKey';
import {
  SCENE_HEMI_INTENSITY,
  SCENE_HEMI_INTENSITY_NO_IBL,
  SceneUnsupportedError,
  createSceneLights,
  createSceneRenderer,
  releaseRenderer,
  watchContextLoss,
  gpuProbe,
} from './renderCore';
import { createEnvironment, type BbEnvironment } from './renderEnvironment';
import { bbWheelDetail, buildRobotGroup, disposeRobotGroup, type BbWheelDetail } from './renderRobots';

/**
 * THE ROBOT-BUILDER TURNTABLE (`docs/roadmap.md` item 1) — a small 3D scene that shows ONE robot,
 * built from its spec, on a disc of field tile.
 *
 * ── IT IS THE MATCH'S OWN GENERATOR, NOT A SECOND DRAWING ───────────────────────────────────
 * `buildRobotGroup` (`renderRobots.ts`) is the function the live match calls for every robot on
 * the field, and it is the function this calls. Nothing here draws a chassis, a wheel, a sweeper
 * or a turret. The renderer, the tone mapping and the light rig come from `renderCore.ts` for the
 * same reason. That is the whole design: roadmap item 1 lists "preview and match must not drift"
 * as its risk, and the way to retire a risk is to remove the second copy rather than to promise
 * to keep two of them in step.
 *
 * ── WHAT IT ADDS, WHICH THE MATCH SCENE HAS NO USE FOR ──────────────────────────────────────
 *  • A TURNTABLE. Slow auto-rotate, drag to swing, wheel to zoom. The drag and zoom rates are the
 *    match orbit camera's own (`renderCameras.ts`), so the gesture feels the same in both places;
 *    the auto-rotate is faster, because a card is a display stand and a match shot is not. Under
 *    `prefers-reduced-motion` it does not rotate at all, exactly as the orbit camera does not.
 *  • A FLOOR DISC. A robot floating in a void has no scale and casts its shadow nowhere. The disc
 *    is the field's own mat/tile colours at the field's own tile pitch, so the robot stands on the
 *    floor it will drive on — and it is what gives the picture contrast in BOTH themes, which is
 *    why this scene's buffer is transparent (see `createSceneRenderer`'s `alpha`) and the card's
 *    own surface is the background.
 *  • `capture()`. One frame, synchronously, as a data URL — the saved-robot thumbnails.
 *
 * ── COORDINATES ─────────────────────────────────────────────────────────────────────────────
 * Field INCHES, z up, same as everything else under `scene/`. The robot is built at the origin
 * facing +x; the camera is the only thing that moves.
 */

/** the disc's radius as a multiple of the robot's own plan half-diagonal. Bigger than the FRAME
 * (below), on purpose: a disc whose edge sits inside the picture reads as a plate the robot is
 * standing on, and one that runs off two sides of it reads as floor. */
const FLOOR_MARGIN = 2.4;
/** how much of the frame the robot's own bounding sphere takes — the rest is headroom. 1.0 would
 * put the corners of the chassis exactly on the frame edge, which is where a rounding error or a
 * resize mid-drag clips a wheel; 1.35 is a product shot. */
const FRAME_MARGIN = 1.35;
/** the tile texture's resolution, and the world span of one repeat. */
const TILE_TEX_PX = 256;
const TILE_TEX_IN = BB_TILE_PITCH;

/** turntable: the ring's elevation bounds and how far a wheel may zoom, as a multiple of the
 * fitted distance. `TURN_ELEV_DEFAULT` is a display-stand angle — above the deck so the top-side
 * mechanisms read, well short of plan view where the chassis becomes a rectangle. */
const TURN_ELEV_DEFAULT = 0.5; // rad, ≈ 29°
const TURN_ELEV_MIN = 0.02;
const TURN_ELEV_MAX = 1.35;
const TURN_ZOOM_MIN = 0.55;
const TURN_ZOOM_MAX = 2.4;
/** auto-rotate, rad/s — one lap in about 22 s. The match's orbit camera turns at 0.05 (a lap per
 * match), which is right for a shot you are watching for two minutes and far too slow for a card
 * you glance at while dragging a slider. */
const TURN_AUTO_RATE = 0.28;
/** drag sensitivity, radians per CSS pixel — `ORBIT_DRAG_YAW`/`_PITCH`'s own values, and the same
 * signs, so "grab the robot and swing it round" costs the same gesture here as in a match. */
const TURN_DRAG_YAW = 0.006;
const TURN_DRAG_PITCH = 0.004;
/** the yaw the turntable starts at — three-quarter front, so a front sweeper and one flank are
 * both visible before anybody drags anything. */
const TURN_YAW_START = -2.2;
/** vertical FOV. Tighter than any match camera on purpose: a long lens flattens the perspective,
 * which is what makes a small object read as a MODEL of a robot rather than as a wide-angle
 * snapshot of one. */
const TURN_FOV = 32;

/** the key light's direction, scaled by the fitted distance. Over the robot's front-left
 * shoulder: it lights the mechanisms the builder is about, and throws the shadow back and to the
 * right where it separates the robot from the disc. */
const SUN_DIR = new THREE.Vector3(0.55, -0.75, 1.0).normalize();

let tileTexture: THREE.CanvasTexture | null = null;
/**
 * The field's tile look as a tiling texture — `COLORS.mat` with a `COLORS.tile` seam along two
 * edges, repeated at the CAD's own 23.528-in pitch (`BB_TILE_PITCH`, NOT `C.TILE`'s 24, which is
 * DECODE's and Chain Reaction's nominal tile and the thing the whole field-size finding was
 * about).
 *
 * The CANVAS is generated once per document; each scene takes a `clone()`, which shares the image
 * but owns its own `repeat` — two previews alive at once (the builder's, and the offscreen one the
 * thumbnails draw through) fit different-sized discs and would otherwise overwrite each other's.
 */
function getTileTexture(): THREE.CanvasTexture {
  if (tileTexture) return tileTexture;
  const canvas = document.createElement('canvas');
  canvas.width = TILE_TEX_PX;
  canvas.height = TILE_TEX_PX;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = C.COLORS.mat;
    ctx.fillRect(0, 0, TILE_TEX_PX, TILE_TEX_PX);
    ctx.strokeStyle = C.COLORS.tile;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, 1.5);
    ctx.lineTo(TILE_TEX_PX, 1.5);
    ctx.moveTo(1.5, 0);
    ctx.lineTo(1.5, TILE_TEX_PX);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tileTexture = tex;
  return tex;
}

/** one `MediaQueryList`, constructed once — `matchMedia()` per frame is a cost this is read on
 * every frame to avoid. Null in a non-DOM host, which reads as "motion is fine". */
const reducedMotionMq: MediaQueryList | null =
  typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

export interface RobotPreviewOptions {
  /** FIX the quality tier, ignoring (and not subscribing to) the device's graphics preference.
   * The thumbnail scene fixes it, so a card does not come out at whatever the machine happened to
   * be set to and so a settings change cannot alter an already-cached image. */
  quality?: GraphicsTier;
  /** `false` binds no pointer handlers — a scene nobody is driving (a thumbnail). */
  interactive?: boolean;
  /** `false` runs NO frame loop at all: the scene draws only when `capture()` asks it to. */
  animate?: boolean;
  /** the WebGL context was lost and the scene has disposed itself; the host shows its fallback */
  onContextLost?: () => void;
}

/**
 * A persistent robot preview over one canvas, owned by whatever mounted it.
 *
 * `setSpec` is the only way state gets in, and it is safe to call on every React render: a spec
 * whose `bbSpecKey` has not changed rebuilds nothing.
 */
export interface RobotPreviewScene {
  readonly element: HTMLCanvasElement;
  /** show this build. Rebuilds the group only when the spec's GEOMETRY identity changes. */
  setSpec(spec: RobotSpec, alliance: Alliance): void;
  /** fix or release the quality tier (`null` goes back to following the device preference). */
  setQuality(tier: GraphicsTier | null): void;
  resize(width: number, height: number, dpr: number): void;
  /**
   * ONE frame at `size`×`size` CSS pixels, as a PNG data URL.
   *
   * No `preserveDrawingBuffer`: the drawing buffer is still valid for a `drawImage` in the SAME
   * task as the `render()` that filled it, which is the trick `Gallery.tsx`'s 3D stills already
   * use. Asking for the attribute instead would slow every frame of a live preview down to make
   * a call that happens three times a session cheaper.
   */
  capture(size: number): string;
  /** resolves once the first build's shaders are compiled — see `warmUp`. A thumbnail batch
   * awaits it before its first `capture`, which is synchronous and would otherwise block on the
   * compile itself. */
  ready(): Promise<void>;
  dispose(): void;
}

export type RobotPreviewFactory = (host: HTMLElement, options?: RobotPreviewOptions) => RobotPreviewScene;

/**
 * Build a turntable inside `host` (it appends its own canvas, per the scene seam's contract).
 *
 * ⚠️ IT DOES NOT TOUCH THE VIEW PREFERENCE. `createBiobuzzScene` sets it to `'2d'` before it
 * throws, because there the throw means "this machine cannot show you the match in 3D" and the
 * fallback has to stick or the scene is retried on every remount. A menu card is not that: it has
 * a 2D/3D toggle directly above it, the component prints one line and shows the schematic, and
 * rewriting the whole app's field-view preference from a builder page would be a surprise.
 */
export const createRobotPreviewScene: RobotPreviewFactory = (host, options) => {
  const opts = options ?? {};
  const probe = gpuProbe();
  if (!probe.webgl2) throw new SceneUnsupportedError('WebGL2 unavailable');
  if (probe.software) throw new SceneUnsupportedError(`software renderer: ${probe.renderer}`);

  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  host.appendChild(canvas);

  // ANTIALIAS ON THE CONTEXT, not on a render target — see `createSceneRenderer`. ALPHA on, so
  // the card's own themed surface is the background and this scene has no colour to keep in step
  // with the theme.
  const renderer = createSceneRenderer(canvas, { antialias: true, alpha: true });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(TURN_FOV, 1, 1, 4000);
  camera.up.set(0, 0, 1);

  const { hemi, sun } = createSceneLights();
  scene.add(hemi, sun);

  // ── the floor disc ────────────────────────────────────────────────────────────────────────
  const floorGeo = new THREE.CircleGeometry(1, 64);
  const floorTex = getTileTexture().clone();
  floorTex.needsUpdate = true;
  const floorMat = new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.95 });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.name = 'bb-preview:floor';
  floor.receiveShadow = true;
  // a hair below z = 0, for the reason the field's own floor is there: the chassis bottom and the
  // sweeper bar sit at 0, and a co-planar pair flickers
  floor.position.z = -0.02;
  scene.add(floor);

  // IMAGE-BASED LIGHTING, the same environment the match uses at this quality — it is what makes
  // the turret ring and the frame rails read as metal rather than as flat-shaded polygons. The
  // backdrop colour it is handed is never seen: `draw()` clears `scene.background` every frame
  // (see there).
  const env: BbEnvironment = createEnvironment(renderer, scene, 0x000000);

  // ── state ─────────────────────────────────────────────────────────────────────────────────
  let fixedTier: GraphicsTier | null = opts.quality ?? null;
  let settings: GraphicsSettings = fixedTier ? { ...GFX_PRESETS[fixedTier] } : getGraphics().settings;
  let tier: GraphicsTier = fixedTier ?? getGraphics().tier;

  let group: THREE.Group | null = null;
  let key = '';
  let alliance: Alliance = 'red';
  /** the radius of the sphere the camera has to frame, in inches. The DISTANCE is not stored
   * with it: it depends on the canvas's aspect, which changes without the build changing. */
  let fitRadius = 20;
  /** scratch for the bounding-sphere measure, reused — it runs once per rebuild, never per
   * frame, but a `Box3` per slider drag is still a `Box3` per slider drag. */
  const bounds = new THREE.Box3();
  const sphere = new THREE.Sphere();
  /** what the camera orbits — up the chassis, so a tall build does not sit low in the frame. */
  const target = new THREE.Vector3(0, 0, 9);

  let yaw = TURN_YAW_START;
  let elev = TURN_ELEV_DEFAULT;
  let zoom = 1;
  let auto = opts.animate !== false;

  let cssW = 1;
  let cssH = 1;
  let hostDpr = 1;
  let frameInterval = 0;
  let lastDraw = 0;
  let lastT = 0;
  let raf = 0;
  /** is the turntable on screen? rAF keeps firing for a canvas scrolled out of view, so the loop
   * skips the draw rather than rendering a full WebGL frame nobody can see. */
  let onScreen = true;
  let disposed = false;
  const teardown: (() => void)[] = [];
  /** the detached 2D canvas `capture()` blits into. ONE per scene, reused, so a grid of
   * thumbnails allocates one canvas and not one per card. */
  let shot: HTMLCanvasElement | null = null;

  function applyQuality(): void {
    const s = settings;
    frameInterval = frameIntervalMs(s.maxFps);
    const on = s.shadows !== 'off';
    renderer.shadowMap.enabled = on;
    sun.castShadow = on;
    if (on) {
      const size = shadowMapSize(s.shadows);
      if (sun.shadow.mapSize.x !== size) {
        sun.shadow.mapSize.set(size, size);
        // A SHADOW MAP IS ALLOCATED ONCE, AT ITS FIRST SIZE — changing `mapSize` on a light whose
        // map already exists does nothing until the old target is thrown away. Same line, and the
        // same reason, as `renderScene.ts`'s.
        sun.shadow.map?.dispose();
        sun.shadow.map = null;
      }
      sun.shadow.radius = shadowBlurRadius(s.shadows);
    }
    renderer.shadowMap.needsUpdate = true;
    hemi.intensity = s.envLighting ? SCENE_HEMI_INTENSITY : SCENE_HEMI_INTENSITY_NO_IBL;
    if (s.envLighting) {
      void env.apply(s.environment);
    } else {
      // and no HDRI is fetched at all — an environment map that is not lighting anything is a
      // 1.7 MB download for nothing at all here, since this scene shows no background
      void env.apply('room');
      scene.environment = null;
    }
    tuneMaterials();
    syncSize();
  }

  /** ANISOTROPY and REFLECTIONS, the two settings that live on the MATERIALS — same rule as the
   * match scene's `tuneMaterials`, and re-run whenever a new robot group appears, because its
   * materials are new and have never been tuned. */
  function tuneMaterials(): void {
    const aniso = Math.min(settings.anisotropy, renderer.capabilities.getMaxAnisotropy());
    const refl = settings.reflections ? 1 : 0;
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        const std = m as THREE.MeshStandardMaterial;
        if (std.map && std.map.anisotropy !== aniso) {
          std.map.anisotropy = aniso;
          std.map.needsUpdate = true;
        }
        if (typeof std.metalness === 'number' && std.metalness >= 0.3) std.envMapIntensity = refl;
      }
    });
  }

  function syncSize(): void {
    const pr = effectivePixelRatio(settings, tier, cssW, cssH, hostDpr);
    renderer.setPixelRatio(pr);
    renderer.setSize(cssW, cssH, false);
    camera.aspect = Math.max(1e-3, cssW / cssH);
    camera.updateProjectionMatrix();
  }

  /**
   * FIT the camera, the floor disc and the shadow frustum to this build.
   *
   * Everything downstream is a function of one number — the half-diagonal of the box the robot
   * occupies — so a 12-in sweeper bot and a 29-in tower are framed the same way, and a player
   * dragging the height slider watches the camera pull back rather than the robot leave the frame.
   */
  /** the DISC and the SUN, both of which follow from the chassis footprint alone — so this runs
   * on every `setSpec`, including the ones that rebuild nothing. */
  function fit(s: RobotSpec): void {
    const plan = Math.hypot(s.length, s.width) / 2;
    const discR = plan * FLOOR_MARGIN;
    floor.scale.set(discR, discR, 1);
    // the texture repeats at the FIELD's tile pitch, so the seams are the size they are on the
    // field rather than a decorative grid scaled to the disc
    floorTex.repeat.set((discR * 2) / TILE_TEX_IN, (discR * 2) / TILE_TEX_IN);

    // the sun rides out with the fit, so a tall robot is not lit from inside its own shadow
    // frustum, and the frustum covers the disc and nothing more
    sun.position.copy(SUN_DIR).multiplyScalar(discR * 3);
    const cam = sun.shadow.camera;
    cam.left = -discR;
    cam.right = discR;
    cam.top = discR;
    cam.bottom = -discR;
    cam.near = 1;
    cam.far = discR * 7;
    cam.updateProjectionMatrix();
  }

  /**
   * WHAT THE CAMERA HAS TO FRAME — MEASURED off the built group, not derived from the spec.
   *
   * ⚠️ The chassis is not the tall part. A turret stands on the deck and its barrel reaches out
   * past the frame rail; a Box Tube is above the deck too; wheels hang off both flanks. A fit
   * computed from `length × width × heightIn` cropped the turret off the top of the card, which
   * is the one part of the picture a player is in the builder to look at. `Box3` over the real
   * group cannot be wrong about any mechanism, including ones added later.
   */
  function measure(g: THREE.Group): void {
    bounds.setFromObject(g);
    if (bounds.isEmpty()) return;
    bounds.getBoundingSphere(sphere);
    fitRadius = Math.max(1, sphere.radius) * FRAME_MARGIN;
    target.copy(sphere.center);
  }

  /**
   * HOW FAR THE CAMERA STANDS, for the current build AND the current canvas shape.
   *
   * ⚠️ A `PerspectiveCamera`'s `fov` is the VERTICAL one, so on a canvas that is taller than it
   * is wide — which the builder's 220px column is — the HORIZONTAL field is the narrower of the
   * two and is what actually decides whether a wide robot fits. Fitting to the vertical alone is
   * why the first pass framed a chassis with its corners off both sides of the card.
   */
  function cameraDistance(): number {
    const halfV = Math.tan(((TURN_FOV / 2) * Math.PI) / 180);
    const halfH = halfV * camera.aspect;
    return (fitRadius / Math.max(0.05, Math.min(halfV, halfH))) * zoom;
  }

  /**
   * THE DECLARED HEIGHT, AS A MEASUREMENT — dashed uprights at the four chassis corners and a
   * dashed rectangle at `heightIn`. BUILDER ONLY.
   *
   * ⚠️ It is deliberately not hardware and it is deliberately not in `buildRobotGroup`. The first
   * answer to "robot is way too tall for no apparent reason" put a solid two-post mast at the
   * declared height on the robot itself, which is the same complaint in a thinner shape. A robot's
   * visual height is whatever its mechanisms reach; `heightIn` is a COLLIDER extent (R105.A's
   * sizing volume), so the one place it is shown is the panel where a player is dragging the
   * dial, drawn as a dashed envelope nobody could mistake for a part. The match view shows
   * nothing. `bbDeployedHeightIn` is the same resolver the rule reads, so the Stowed toggle —
   * which hands this scene a spec whose `heightIn` IS the stow height — moves the envelope free.
   */
  function buildHeightEnvelope(spec: RobotSpec): THREE.LineSegments {
    const hl = spec.length / 2;
    const hw = spec.width / 2;
    const h = bbDeployedHeightIn(spec);
    const corners: [number, number][] = [
      [hl, hw],
      [hl, -hw],
      [-hl, -hw],
      [-hl, hw],
    ];
    const pts: number[] = [];
    corners.forEach(([x, y], i) => {
      pts.push(x, y, 0, x, y, h); // the upright
      const [nx, ny] = corners[(i + 1) % 4];
      pts.push(x, y, h, nx, ny, h); // the top rail
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const line = new THREE.LineSegments(
      geo,
      // the scene's own machined-aluminium tone (`ALU` in `renderRobots.ts`) — a WebGL material
      // colour, which cannot be a CSS token
      new THREE.LineDashedMaterial({ color: '#98a3b2', dashSize: 0.9, gapSize: 0.7, transparent: true, opacity: 0.5 }),
    );
    line.name = 'bb-height-envelope';
    line.computeLineDistances();
    return line;
  }

  /** the spec the live group was built from, so a QUALITY change can rebuild it without the
   *  caller handing the spec back — the wheel tessellation is baked at build time (see
   *  `bbWheelDetail`) and is the one setting this preview cannot apply in place. */
  let builtSpec: RobotSpec | null = null;

  /**
   * THE FIRST BUILD'S SHADERS COMPILE OFF THE MAIN THREAD. A first `render()` compiles every
   * program synchronously and then BLOCKS on the link (`getProgramInfoLog`): measured at ~100 ms of
   * the ~210 ms of long tasks on entering Configure ▸ Robot in BIOBUZZ 3D (2026-09-23).
   * `compileAsync` polls `KHR_parallel_shader_compile` instead, so the loop draws nothing until it
   * resolves — a blank frame or two in a box that was blank anyway while the chunk loaded. Once
   * only: a later rebuild adds a mechanism's material or two, which is the old, small cost.
   */
  let warm = false;
  let warming: Promise<void> | null = null;
  function warmUp(): Promise<void> {
    warming ??= renderer
      .compileAsync(scene, camera)
      .catch(() => undefined)
      .then(() => {
        warm = true;
      });
    return warming;
  }
  let builtWheelDetail: BbWheelDetail = bbWheelDetail(settings, tier);

  function rebuild(spec: RobotSpec): void {
    if (group) {
      scene.remove(group);
      // only what this GROUP owns — the chassis geometry, its edge lines and every solid material
      // are shared module caches in `renderRobots.ts` and disposing them on a slider drag would
      // re-upload a texture and recompile a shader per frame
      disposeRobotGroup(group);
    }
    // ⚠️ id 1: the sign panel's texture is cached per (id, alliance) and a preview has no slot
    // number, so it borrows the first rather than minting a cache entry per saved robot.
    builtSpec = spec;
    builtWheelDetail = bbWheelDetail(settings, tier);
    group = buildRobotGroup(spec, 1, alliance, builtWheelDetail);
    // the measurement envelope rides ALONG with the group rather than inside the generator, so
    // it is framed by the same `Box3`, removed by the same `scene.remove` and freed by the same
    // `disposeRobotGroup` walk (its geometry and material are this preview's, not shared caches)
    group.add(buildHeightEnvelope(spec));
    scene.add(group);
    measure(group);
    tuneMaterials();
    void warmUp();
  }

  /** place the camera for this frame. `dt` advances the turntable; 0 leaves it where it is. */
  function poseCamera(dt: number): void {
    if (auto && !(reducedMotionMq?.matches ?? false)) yaw += TURN_AUTO_RATE * dt;
    const d = cameraDistance();
    const ce = Math.cos(elev);
    const se = Math.sin(elev);
    camera.position.set(target.x + Math.cos(yaw) * ce * d, target.y + Math.sin(yaw) * ce * d, target.z + se * d);
    camera.lookAt(target);
    camera.near = Math.max(1, d * 0.05);
    camera.far = d * 6;
    camera.updateProjectionMatrix();
  }

  function draw(dt: number): void {
    // `createEnvironment` owns `scene.background` too — it is the match view's letterbox, and its
    // HDRI surround. THIS scene has no background: the transparent buffer lets the card's own
    // themed surface through, which is what keeps it in step with light/dark for free. Cleared
    // here rather than after `apply()` because an HDRI resolves between two frames and would
    // otherwise win.
    if (scene.background !== null) scene.background = null;
    poseCamera(dt);
    renderer.render(scene, camera);
  }

  function loop(): void {
    raf = requestAnimationFrame(loop);
    const now = performance.now();
    if (!warm || !onScreen || (frameInterval > 0 && now - lastDraw < frameInterval)) return;
    const dt = lastT === 0 ? 0 : Math.min(0.25, (now - lastT) / 1000);
    lastT = now;
    lastDraw = now;
    draw(dt);
  }

  // ── pointer: drag to swing, wheel to zoom ─────────────────────────────────────────────────
  if (opts.interactive !== false) {
    let dragging = false;
    let dragX = 0;
    let dragY = 0;
    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0) return;
      dragging = true;
      dragX = e.clientX;
      dragY = e.clientY;
      // the viewer has taken the camera; having it drift back out from under them is worse than
      // losing the effect — the same ruling the match's orbit camera makes
      auto = false;
    };
    const onMove = (e: PointerEvent): void => {
      if (!dragging) return;
      yaw -= (e.clientX - dragX) * TURN_DRAG_YAW;
      elev = Math.max(TURN_ELEV_MIN, Math.min(TURN_ELEV_MAX, elev + (e.clientY - dragY) * TURN_DRAG_PITCH));
      dragX = e.clientX;
      dragY = e.clientY;
    };
    const endDrag = (): void => {
      dragging = false;
    };
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      // MULTIPLICATIVE, like `orbitZoom`: a notch is ±100 on a mouse and a few pixels on a
      // trackpad, so the same gesture has to move the same FRACTION of the current distance.
      zoom = Math.max(TURN_ZOOM_MIN, Math.min(TURN_ZOOM_MAX, zoom * Math.exp(e.deltaY * 0.0012)));
    };
    host.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    // `passive: false`, or the `preventDefault()` above is ignored and the page scrolls under the zoom
    host.addEventListener('wheel', onWheel, { passive: false });
    teardown.push(() => {
      host.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
      host.removeEventListener('wheel', onWheel);
    });
  }

  // A FIXED-TIER SCENE DOES NOT SUBSCRIBE — a cached thumbnail must not change because the
  // Graphics section was opened somewhere else.
  if (!fixedTier) {
    teardown.push(
      subscribeGraphics((state) => {
        settings = state.settings;
        tier = state.tier;
        applyQuality();
      }),
    );
  }

  applyQuality();
  if (opts.animate !== false) {
    if (typeof IntersectionObserver === 'function') {
      const io = new IntersectionObserver((entries) => {
        onScreen = entries.some((e) => e.isIntersecting);
        if (!onScreen) lastT = 0; // resume without a catch-up jump in the turntable
      });
      io.observe(host);
      teardown.push(() => io.disconnect());
    }
    raf = requestAnimationFrame(loop);
  }

  /**
   * A LOST CONTEXT, KEPT DELIBERATELY SIMPLE HERE — the card TEARS ITSELF DOWN and the 3D tab
   * above it is the retry.
   *
   * The match scene routes a loss to the host's 2D fallback; this one must not, for the same
   * reason it does not touch the view preference when WebGL2 is missing (see this factory's
   * header). What it must not do either is keep drawing: every GL call after a loss is a silent
   * no-op, so the card would sit frozen on its last frame, indistinguishable from a build the
   * turntable had simply stopped rotating. Disposing removes the canvas, `Preview3D.tsx` still
   * holds this scene and calls `dispose()` again on unmount (idempotent, via `disposed`), and
   * its 3D button builds a fresh context on the next press.
   */
  const api: RobotPreviewScene = {
    element: canvas,
    setSpec(next: RobotSpec, nextAlliance: Alliance): void {
      if (disposed) return;
      const nextKey = `${bbSpecKey(next)}|${nextAlliance}`;
      // the FIT is arithmetic over three numbers and depends only on the dimensions, so it is
      // re-run unconditionally; the GROUP is the expensive half and only a key change earns one
      fit(next);
      if (nextKey === key) return;
      key = nextKey;
      alliance = nextAlliance;
      rebuild(next);
    },
    setQuality(next: GraphicsTier | null): void {
      if (disposed) return;
      fixedTier = next;
      if (next) {
        settings = { ...GFX_PRESETS[next] };
        tier = next;
      } else {
        const state = getGraphics();
        settings = state.settings;
        tier = state.tier;
      }
      applyQuality();
      // THE ONE SETTING `applyQuality` CANNOT APPLY: the wheels' tessellation is baked into the
      // group's geometry, so a column change that moves it has to re-generate the robot. Same
      // rule the match scene follows through its own rebuild key — and the preview is the
      // BUILDER's window, where a player switching presets expects to see the difference.
      const wantWheels = bbWheelDetail(settings, tier);
      if (builtSpec && wantWheels !== builtWheelDetail) rebuild(builtSpec);
    },
    resize(width: number, height: number, dpr: number): void {
      if (disposed) return;
      cssW = Math.max(1, width);
      cssH = Math.max(1, height);
      // capped at 2 before the settings see it, same as the match scene: past 2x the difference is
      // below the panel's resolving power and the cost is quadratic
      hostDpr = Math.min(dpr, 2);
      syncSize();
    },
    capture(size: number): string {
      if (disposed) return '';
      const prevW = cssW;
      const prevH = cssH;
      const prevDpr = hostDpr;
      cssW = Math.max(1, Math.round(size));
      cssH = cssW;
      hostDpr = 1;
      syncSize();
      draw(0);
      shot ??= document.createElement('canvas');
      shot.width = cssW;
      shot.height = cssH;
      const ctx = shot.getContext('2d');
      let url = '';
      if (ctx) {
        ctx.clearRect(0, 0, cssW, cssH);
        ctx.drawImage(canvas, 0, 0, cssW, cssH);
        url = shot.toDataURL('image/png');
      }
      cssW = prevW;
      cssH = prevH;
      hostDpr = prevDpr;
      syncSize();
      return url;
    },
    ready(): Promise<void> {
      return warmUp();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      for (const off of teardown) off();
      teardown.length = 0;
      env.dispose();
      if (group) {
        scene.remove(group);
        disposeRobotGroup(group);
      }
      group = null;
      floorGeo.dispose();
      floorTex.dispose();
      floorMat.dispose();
      shot = null;
      releaseRenderer(renderer);
      canvas.parentElement?.removeChild(canvas);
    },
  };

  // a lost context leaves an empty box, so the host is told and can offer the retry
  teardown.push(
    watchContextLoss(canvas, () => {
      api.dispose();
      opts.onContextLost?.();
    }),
  );

  return api;
};
