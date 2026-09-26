import * as THREE from 'three';
import type { GameScene, GameSceneFactory, SceneCamera, SceneFrame, SceneOptions } from '../../module';
import type { World } from '../../../types';
import { BB_HALF_X, BB_HALF_Y, BB_VIEW_MARGIN } from '../config';
import {
  CAMERA_PREFS,
  getCameraPref,
  getDriverHeightIn,
  getFreeCamNav,
  resolveSceneCamera,
  fallBackTo2d,
  setCameraPref,
  subscribeCameraPref,
  subscribeDriverHeightIn,
  subscribeFreeCamNav,
  type CameraPref,
} from '../graphics/store';
import { freeCamGesture, subscribeFreeCamReset, type FreeCamNav } from '../graphics/freeCam';
import {
  GFX_PRESETS,
  effectivePixelRatio,
  frameIntervalMs,
  getGraphics,
  msaaSamples,
  shadowBlurRadius,
  shadowMapSize,
  subscribeGraphics,
  type GraphicsSettings,
  type GraphicsTier,
} from '../graphics/settings';
import { applyFirstGuess, createQualityGovernor, probeAdapter, type QualityGovernor } from '../graphics/auto';
import { installViewKey, viewActionOf } from '../graphics/viewKey';
import { buildBiobuzzField, updateBiobuzzField, type BbFieldHandles } from './renderField';
import { buildBiobuzzElements, setElementDetail, setElementShadows, updateBiobuzzElements, type BbElements } from './renderElements';
import { loadElementGeometries } from './renderElementsGlb';
import { bbWheelDetail, buildBiobuzzRobots, updateBiobuzzRobots, type BbRobots } from './renderRobots';
import { buildBiobuzzReticle, updateBiobuzzReticle, type BbReticle } from './renderReticle';
import { applyVenueLayers, bbVenueDetail, buildBiobuzzVenue } from './renderVenue';
import { createCameras, setCameraTuning, setDriverHeightIn, type BbCameras } from './renderCameras';
import { applyEnvironmentRig, createEnvironment, type BbEnvironment } from './renderEnvironment';
import { environmentDefFor } from '../graphics/environments';
import { createStats, type BbStats } from './renderStats';
import {
  SceneUnsupportedError,
  createSceneLights,
  createSceneRenderer,
  watchContextLoss,
  disposeObject3D,
  gpuProbe,
  releaseRenderer,
  readBackdropColor,
} from './renderCore';

/**
 * THE CHUNK'S TWO ENTRY POINTS, BOTH REACHED THROUGH THIS ONE MODULE SPECIFIER.
 *
 * `src/games/biobuzz/index.ts` fills two module slots — `scene` (the match view, below) and
 * `previewScene` (the robot-builder turntable, `renderPreview.ts`) — and BOTH of them write
 * `import('./scene/renderScene')`. That is deliberate: one dynamic specifier is ONE Rollup
 * chunk, so `bundleaudit`'s `scene` route stays one measurable file. Two specifiers would make
 * three.js a hoisted shared chunk with a facade either side, and a facade carries none of the
 * marker strings that route says `scene` by — both would land in `other` and fail the audit for
 * a reason that has nothing to do with size. The re-export is what makes the second slot
 * reachable without a second entry.
 *
 * `SceneUnsupportedError` is re-exported for a plainer reason: it used to be DECLARED here, and
 * a host catching it imports it from here.
 */
export { SceneUnsupportedError } from './renderCore';
export { createRobotPreviewScene, type RobotPreviewScene } from './renderPreview';

/**
 * ⚠️ `SceneQuality` / `QUALITY` ARE GONE. They were a module CONSTANT at "Medium", with a header
 * saying the Day 3 Graphics section would replace the literal. It has: the sixteen settings of
 * `docs/biobuzz/plan-3d.md` §4.4 live in `graphics/settings.ts`, per device, and this file
 * SUBSCRIBES to them. Everything below that used to read `QUALITY.shadows` now reads
 * `this.settings`, and `applyQuality` is the one place a change lands.
 *
 * The rule the whole section is built on: **a setting is applied LIVE, without rebuilding the
 * scene**, and the two that genuinely cannot be are named as such in the UI rather than
 * silently deferred (mesh detail, which is a different GLB, and anti-aliasing's OWN reason for
 * existing here — see `syncTarget`).
 */

/** `castShadow`/`receiveShadow` on the static field, set ONCE after the meshes exist — not
 * per-object at construction, because a GLB-backed field builder (plan-3d.md §8) returns the
 * same `BbFieldHandles` shape but should not have to know this scene's shadow policy itself.
 * The ELEMENTS' own flags are `setElementShadows`'s (they are a settings row of their own) and
 * robots set theirs in `buildRobotGroup`. */
function applyShadowFlags(field: BbFieldHandles): void {
  field.floor.receiveShadow = true;
  field.walls.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  for (const a of ['red', 'blue'] as const) {
    field.hives[a].traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
  }
  for (const f of field.flowers) {
    f.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
  }
}

/**
 * BIOBUZZ 3D SCENE — the lazily loaded renderer chunk (Day 1, `docs/biobuzz/plan-3d.md` §2.3,
 * §2.5, §4). This is the ONE file `three` is imported by that the rest of the game reaches: the
 * seam is `src/games/biobuzz/index.ts`'s `scene: () => import('./scene/renderScene').then(m =>
 * m.createBiobuzzScene)`, a dynamic `import()` so Vite emits everything under `scene/` as its
 * own chunk, never touched by a player who stays on the 2D view.
 *
 * COORDINATES, EVERYWHERE IN THIS DIRECTORY: field INCHES, z UP — x right, y up-field
 * (audience-away), z up. No axis conversion happens anywhere in `scene/`; every camera's `up`
 * is `(0,0,1)` (`renderCameras.ts`). This mirrors the field frame the rest of BIOBUZZ already
 * uses (`config.ts`'s header: "origin at the centre, +x = audience right, +y = away from the
 * audience"), so a position read straight off `World` needs no transform to become a Three.js
 * position.
 */

/** the PiP minimap's size as a fraction of the canvas's short edge, and its margin. §4.4 offers
 * it on Low/Medium, where the 3D shot is the least legible and a top-down aid earns its second
 * pass over the scene. */
const PIP_FRACTION = 0.26;
const PIP_MARGIN = 12;
const PIP_MIN_PX = 120;
const PIP_MAX_PX = 260;

/** free cam drag-zoom: wheel-delta units per pixel of drag. The whole 20–420 in dolly range is
 * ~2,500 wheel units, so ~630 px of drag crosses it. */
const FREE_ZOOM_DRAG_PX = 4;

class BiobuzzScene implements GameScene {
  /** A GETTER, not a field. The canvas is stable for the life of the scene today, but the
   * contract's `readonly element` is satisfied either way and the host (`game.ts`) reads it at
   * mount and teardown — keeping it a getter is what would let a future renderer rebuild swap
   * the canvas without breaking that contract. */
  get element(): HTMLCanvasElement {
    return this.canvas;
  }
  /** `GameScene.camera` — the camera the last frame RESOLVED to, which is what the 2D overlay
   * pass above this canvas has to know (`SceneOverlayView`). The same value `project` projects
   * through, so a read-out and a label can never disagree about which shot they are on. */
  get camera(): SceneCamera {
    return this.lastCamera;
  }
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly cameras: BbCameras;
  private readonly field: BbFieldHandles;
  private readonly elements: BbElements;
  private readonly robots: BbRobots;
  private readonly reticle: BbReticle;
  /** does the device's `effects` setting want the shot path at all (see `applyQuality`)? */
  private reticleOn = true;
  private readonly env: BbEnvironment;
  private readonly stats: BbStats;
  private readonly governor: QualityGovernor;
  private readonly hemi: THREE.HemisphereLight;
  private readonly sun: THREE.DirectionalLight;
  private readonly host: HTMLElement;
  private readonly onQualityEvent?: (line: string) => void;
  /** a FIXED tier (exports run at High regardless of the device) — when set, the settings store
   * is not read and not subscribed to at all. */
  private readonly fixedTier: GraphicsTier | null;
  /** false for a scene nobody is driving (an export, a still, a thumbnail) — see
   *  `resolvedCamera` and `graphics/store.ts`'s `resolveSceneCamera`. */
  private readonly interactive: boolean;

  // ── graphics state ────────────────────────────────────────────────────────────────────────
  private settings: GraphicsSettings;
  private tier: GraphicsTier;
  /** the MSAA render target, or null when anti-aliasing is off (which renders straight to the
   * canvas and costs no blit at all). */
  private target: THREE.WebGLRenderTarget | null = null;
  private readonly blitScene = new THREE.Scene();
  private readonly blitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly blitMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  /** the dedicated PiP camera — NOT `cameras.overhead`, which carries the main shot's
   * `setViewOffset` window and would render the minimap through the HUD's safe rect. */
  private readonly pipCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 4000);
  private frameInterval = 0;
  private lastDraw = 0;
  /** how many children the robot group had when material tuning was last applied. Robots are
   * built lazily per spec, so anisotropy and reflections have to be re-applied when one appears
   * — a cheap integer compare per frame instead of a traverse. */
  private robotChildren = -1;

  /** THE VENUE (`renderVenue.ts`) — real geometry around the field, rebuilt only when the
   * environment or the detail level actually changes. `venueKey` is what makes `applyQuality`
   * idempotent for it: that method runs on every settings change and rebuilding a room because
   * somebody moved the FOV slider would throw away and re-upload a dozen buffers per frame of
   * the drag. */
  private venue: THREE.Group | null = null;
  private venueKey = '';

  private cssW = 1;
  private cssH = 1;
  private hostDpr = 1;

  private cameraPref: CameraPref = getCameraPref();
  private readonly teardown: (() => void)[] = [];
  private lastW = 1;
  private lastH = 1;
  private readonly projScratch = new THREE.Vector3();
  private lastCamera: SceneCamera = 'driver';
  /** the viewAngle the LAST frame carried — what a free-cam reset (double-click, the HUD chip)
   * frames against, since neither trigger has a `SceneFrame` of its own to read one from. */
  private lastViewAngle = 0;
  /** `null` while no drag is in flight; otherwise which gesture the pointer that went down is
   * driving — orbit's own left-drag, or one of free cam's three. WHICH button/modifier means
   * which is `freeNav.preset`'s call (`graphics/freeCam.ts`'s `freeCamGesture`). */
  private dragMode: 'orbit' | 'free-orbit' | 'free-pan' | 'free-zoom' | null = null;
  /** the free camera's mouse layout + wheel direction, per device (`graphics/store.ts`). */
  private freeNav: FreeCamNav = getFreeCamNav();
  private dragX = 0;
  private dragY = 0;

  constructor(canvas: HTMLCanvasElement, field: BbFieldHandles, host: HTMLElement, opts: SceneOptions) {
    this.canvas = canvas;
    this.host = host;
    this.onQualityEvent = opts.onQualityEvent;
    this.fixedTier = (opts.quality as GraphicsTier | undefined) ?? null;
    this.interactive = opts.interactive !== false;
    const gfx = getGraphics();
    this.tier = this.fixedTier ?? gfx.tier;
    this.settings = this.fixedTier ? { ...GFX_PRESETS[this.fixedTier] } : gfx.settings;

    /**
     * ⚠️ `antialias: false`, ALWAYS, AND THAT IS WHAT MAKES THE AA SETTING LIVE.
     *
     * The context's `antialias` attribute is fixed for the life of the context and WebGL gives
     * no way to ask the default framebuffer for a PARTICULAR sample count — you get "some" MSAA
     * or none. An implementation built on it could offer neither §4.4's "MSAA 2x" nor a change
     * without recreating the canvas. So the scene renders into a multisampled render target of
     * its own (`syncTarget`) and blits, which makes the sample count a number this scene owns
     * and can change between two frames.
     */
    // `antialias: false` HERE, ALWAYS — the reason is the paragraph above, and the target that
    // replaces it is `syncTarget` below. Tone mapping, the output colour space and the shadow
    // filter come with the shared factory (`renderCore.ts`), which the builder preview builds
    // its renderer from too — so the same robot cannot come out two different colours in the
    // two places this game draws it.
    this.renderer = createSceneRenderer(canvas, { antialias: false, alpha: false });
    /**
     * A LOST CONTEXT TAKES THE SAME EXIT AS AN UNSUPPORTED ONE — `fallBackTo2d()` plus an
     * event-log line, exactly what the factory below does for a failed WebGL2 probe or a
     * software renderer. One host path, because a player cannot tell the three apart and
     * neither answer is "keep looking at this canvas": see `watchContextLoss` for why a lost
     * context is otherwise INVISIBLE (no throw, no error — the calls just stop doing anything).
     *
     * The scene is not disposed from in here. The host owns the mount, `dispose` is its call to
     * make when it swaps the view, and disposing a scene from inside its own canvas's event
     * handler would free the renderer under the frame that is running.
     */
    this.teardown.push(
      watchContextLoss(canvas, () => {
        fallBackTo2d();
        this.onQualityEvent?.('Lost the graphics context. Showing the 2D view.');
      }),
    );

    // HEMISPHERE FILL — a lighter, less blue-shifted ground term (`0x4b525c`, up from a near-navy
    // `0x404048`) so light bounced off the (dark) tile floor still lifts the underside of the
    // robots and the hive trays instead of leaving them silhouetted. Its INTENSITY is a function
    // of the environment-lighting setting (`applyQuality`): with the IBL off it is most of the
    // ambient term there is and has to carry more.
    const lights = createSceneLights();
    this.hemi = lights.hemi;
    this.sun = lights.sun;
    this.sun.position.set(60, -80, 140);
    // the shadow camera is an orthographic frustum sized to cover the field plus the hive's
    // height — a frustum sized to the whole 260-in room would waste most of its depth/texel
    // budget on backdrop that never casts anything.
    {
      const cam = this.sun.shadow.camera;
      const half = BB_HALF_X + 20;
      cam.left = -half;
      cam.right = half;
      cam.top = half;
      cam.bottom = -half;
      cam.near = 1;
      cam.far = 260;
      cam.updateProjectionMatrix();
      // BIAS and NORMAL-BIAS are `createSceneLights`' (`renderCore.ts`), shared with the builder
      // preview — that file carries the note on why the two have to be tuned as a pair.
    }
    this.scene.add(this.hemi, this.sun);

    this.field = field;
    this.scene.add(this.field.group);
    this.elements = buildBiobuzzElements(this.settings.elementDetail);
    this.scene.add(this.elements.group);
    this.robots = buildBiobuzzRobots();
    this.scene.add(this.robots.group);
    this.reticle = buildBiobuzzReticle();
    this.scene.add(this.reticle.group);
    applyShadowFlags(this.field);

    // IMAGE-BASED LIGHTING (plan-3d.md §4.5) — the procedural `RoomEnvironment` PMREM, or one of
    // the two CC0 HDRIs, owned by `renderEnvironment.ts`. It is what makes a metal turret ring or
    // a glossy chassis read as a physical material instead of a flat-shaded polygon: a
    // `MeshStandardMaterial` with no environment has nothing to reflect.
    this.env = createEnvironment(this.renderer, this.scene, readBackdropColor());

    this.blitMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      // `depthTest`/`depthWrite` off: it is a full-screen copy, there is nothing to sort against.
      // `toneMapped` is left TRUE on purpose — the scene renders into a linear half-float target
      // with tone mapping SKIPPED (three applies it only when the destination is the canvas), so
      // this copy is where ACES and the sRGB conversion actually happen, on the full HDR range.
      new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false }),
    );
    this.blitMesh.frustumCulled = false;
    this.blitScene.add(this.blitMesh);

    this.pipCamera.up.set(0, 0, 1);

    this.cameras = createCameras();
    this.stats = createStats(host, this.settings.perfOverlay);
    // the clock this scene's own frame loop already reads — `graphics/auto.ts` takes it as a
    // parameter rather than reading one itself (see its note on the determinism guard)
    this.governor = createQualityGovernor(() => performance.now(), this.onQualityEvent);

    this.applyQuality();
    this.bindTheme();
    this.bindPrefs();
    if (this.interactive) {
      this.bindPointer();
      this.bindKeys();
      this.teardown.push(installViewKey());
      // the HUD's "Reset view" chip (`GameView.tsx`) lives outside this scene entirely, so it
      // reaches the free camera through the same signal the double-click gesture below uses.
      this.teardown.push(subscribeFreeCamReset(() => this.cameras.freeReset(this.lastViewAngle)));
    }
  }

  // ───────────────────────────────────────────────────────── the settings, applied live (Day 3) ──

  /**
   * Push `this.settings` into the renderer, the lights, the meshes and the cameras. Called at
   * construction and on every change from the settings store; idempotent, and cheap enough
   * (a few property writes plus at most one scene traverse) that nothing here diffs.
   *
   * Every row of §4.4's table is handled here or named as an exception:
   *   render scale + budget → `syncSize`      max frame rate → `frameInterval`
   *   anti-aliasing         → `syncTarget`    shadows        → below
   *   element shadows       → `setElementShadows`
   *   element detail        → `setElementDetail` (fetches `elements.glb` behind the spheres)
   *   ambient occlusion     → NOT OFFERED (`GFX_NOT_OFFERED`, and the UI says so)
   *   anisotropy            → `tuneMaterials` reflections    → `tuneMaterials`
   *   mesh detail           → the ONE setting that needs a rebuild: it selects which GLB
   *                           `buildBiobuzzField` loads, and the field is built before the scene
   *                           exists. It takes effect on the next 3D view; the UI says that.
   *   environment + env lighting → `renderEnvironment.ts`
   *   effects               → reticle + rolling spin
   *   FOV + camera motion   → `setCameraTuning`
   *   PiP minimap + overlay → read per frame by `render`
   */
  private applyQuality(): void {
    const s = this.settings;
    this.frameInterval = frameIntervalMs(s.maxFps);

    // ── shadows ────────────────────────────────────────────────────────────────────────────
    const on = s.shadows !== 'off';
    this.renderer.shadowMap.enabled = on;
    this.sun.castShadow = on;
    if (on) {
      const size = shadowMapSize(s.shadows);
      if (this.sun.shadow.mapSize.x !== size) {
        this.sun.shadow.mapSize.set(size, size);
        // A SHADOW MAP IS ALLOCATED ONCE, AT ITS FIRST SIZE. Changing `mapSize` on a light whose
        // map already exists does nothing at all until the old render target is thrown away —
        // this is the line that makes "low ⇄ high" a live change rather than a stored setting
        // that only applies after a reload.
        this.sun.shadow.map?.dispose();
        this.sun.shadow.map = null;
      }
      this.sun.shadow.radius = shadowBlurRadius(s.shadows);
    }
    this.renderer.shadowMap.needsUpdate = true;
    setElementShadows(this.elements, s.elementShadows);
    // the CAD-detail row: live, and its own asset load is fire-and-forget behind the spheres
    setElementDetail(this.elements, s.elementDetail);

    // THE DRIVE WHEELS' own tessellation. Not applied in place — the geometry is baked when a
    // robot group is built — so `buildBiobuzzRobots`'s `sync` folds it into its rebuild key and
    // the four robots re-generate on the next frame. See `bbWheelDetail` for why it reads BOTH
    // `meshDetail` and the preset column rather than asking for a seventeenth dial.
    this.robots.wheelDetail = bbWheelDetail(s, this.tier);

    // ── effects ────────────────────────────────────────────────────────────────────────────
    this.elements.rollingSpin = s.effects !== 'minimal';
    // the same row's other half, and the one the §4.4 table has always promised ("minimal — …
    // no wheel rotation") with nothing behind it until the wheels became real parts that could
    // be seen to turn
    this.robots.wheelSpin = s.effects !== 'minimal';
    // ⚠️ A FLAG, NOT `group.visible`. `updateBiobuzzReticle` writes `visible` every frame, so a
    // value set here was overwritten on the next one and `minimal` never actually turned the shot
    // path off.
    this.reticleOn = s.effects !== 'minimal';

    // ── environment and its lighting ───────────────────────────────────────────────────────
    //
    // ONE CALL FOR BOTH ROWS (2026-09-21). It used to branch here: with `envLighting` off the
    // scene forced `'room'` and nulled `scene.environment`, because the only two environments
    // that were not the room were 1.7 MB HDRIs and fetching one for a BACKDROP is not a trade
    // that setting offers. Eight PAINTED domes later that reasoning only covers the two fetched
    // ones — a painted surround costs no network at all — so `env.apply` takes the row as an
    // argument and owns the distinction: a painted environment still paints, an HDRI still falls
    // back to the room, and `scene.environment` is set only when the lighting is on. The effect
    // is that Low and Medium, where §4.4 has `envLighting` off, have a background picker at all.
    //
    // THE LIGHT RIG comes with the environment (`graphics/environments.ts`'s `rig`): the hemi
    // pair, the sun's direction/colour/intensity and the exposure, so a gym is lit like a gym.
    // `renderCore.ts`'s `SCENE_*` constants are still the DEFAULT rig's values — `BASE_RIG`
    // copies them and the RENDER lane asserts the copy — and the builder preview still lights
    // from them directly, which is what keeps a robot the same colour in both places.
    //
    // ⚠️ `environmentDefFor`, NOT `environmentDef` — the RESOLVED row, which is the declared one
    // everywhere except a client that cannot fetch an HDRI at all (the Discord Activity's CSP).
    // The rig, the venue below and `env.apply` must all read the SAME row or the picture is a
    // school hall lit like a cardboard box; that is exactly what the embed was rendering while
    // the loader silently substituted the practice room under a hall's geometry.
    const def = environmentDefFor(s.environment);
    applyEnvironmentRig(this.renderer, this.hemi, this.sun, def, s.envLighting);
    void this.env.apply(s.environment, this.onQualityEvent, s.envLighting);

    // ── the venue ──────────────────────────────────────────────────────────────────────────
    //
    // THE SURROUND IS GEOMETRY NOW, not only a background texture (`renderVenue.ts` carries the
    // three measurements that decided it). It is a pure function of the environment and of the
    // detail level, so it is keyed and rebuilt only when one of those two moves — everything
    // else in this method is a property write, and a room rebuilt on an FOV drag would not be.
    // It is added BEFORE `tuneMaterials` so the ground's own texture gets the anisotropy row,
    // which is the most grazing-angle surface in the scene once a driver camera is on it.
    const detail = bbVenueDetail(s, this.tier);
    const key = `${def.id}:${detail}`;
    if (key !== this.venueKey) {
      if (this.venue) {
        this.scene.remove(this.venue);
        disposeObject3D(this.venue);
      }
      this.venue = buildBiobuzzVenue(def.venue, detail);
      /* ⚠️ THE TWO TOP-DOWN CAMERAS ARE LEFT OUT ON PURPOSE. Everything the venue hangs
         over the field — the lighting grid, the ceiling fittings — sits on
         `VENUE_OVERHEAD_LAYER`, and enabling it here for the side-on cameras only is what
         keeps a 5×5 beam grid from being drawn as a giant cross across the overhead shot
         and the PiP. Re-applied on every rebuild because the cameras outlive the venue. */
      applyVenueLayers([this.cameras.driver, this.cameras.chase, this.cameras.orbit, this.cameras.free]);
      this.scene.add(this.venue);
      this.venueKey = key;
    }

    this.tuneMaterials();
    setCameraTuning(s.hfov, s.cameraMotion);
    this.stats.setMode(s.perfOverlay);
    this.syncTarget();
    this.syncSize();
  }

  /**
   * ANISOTROPY and REFLECTIONS, the two rows that live on the MATERIALS.
   *
   * Anisotropic filtering is a per-TEXTURE sampler setting: it is what keeps the tile seams and
   * the tape lines from turning to mush where the floor runs away from a driver-station camera,
   * which is the single most grazing-angle surface in this scene and therefore the one the
   * setting was put in the table for. Clamped to the GPU's own maximum — asking for 16 on a part
   * that offers 2 is silently ignored by WebGL and would leave the UI claiming something untrue.
   *
   * Reflections are `envMapIntensity` on the METAL-ish materials only. A diffuse plastic chassis
   * gets its environment contribution from the same map and turning that off would just make the
   * scene darker, which is the `envLighting` row's job; what a player switching "reflections"
   * off wants back is the specular sheen on the frame rails and the turret ring.
   */
  private tuneMaterials(): void {
    const max = this.renderer.capabilities.getMaxAnisotropy();
    const aniso = Math.min(this.settings.anisotropy, max);
    const refl = this.settings.reflections ? 1 : 0;
    this.scene.traverse((o) => {
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
    this.robotChildren = this.robots.group.children.length;
  }

  /** create/resize/destroy the multisampled target for the current AA setting. */
  private syncTarget(): void {
    const samples = msaaSamples(this.settings.aa);
    if (samples === 0) {
      if (this.target) {
        this.target.dispose();
        this.target = null;
        this.blitMesh.material.map = null;
      }
      return;
    }
    const w = Math.max(1, Math.round(this.cssW * this.renderer.getPixelRatio()));
    const h = Math.max(1, Math.round(this.cssH * this.renderer.getPixelRatio()));
    if (this.target && this.target.samples === samples) {
      this.target.setSize(w, h);
      return;
    }
    this.target?.dispose();
    this.target = new THREE.WebGLRenderTarget(w, h, {
      samples,
      // HALF FLOAT so the scene keeps its HDR range until the blit tone-maps it. An 8-bit target
      // would clip every highlight ACES exists to roll off, and the whole point of the filmic
      // curve is what happens ABOVE 1.0.
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
    });
    // the working colour space: three skips the output conversion when the destination is a
    // render target, so what lands here is linear and the blit converts it
    this.target.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this.blitMesh.material.map = this.target.texture;
    this.blitMesh.material.needsUpdate = true;
  }

  /** the backbuffer size for the current render scale and the tier's pixel budget. */
  private syncSize(): void {
    const pr = effectivePixelRatio(this.settings, this.tier, this.cssW, this.cssH, this.hostDpr);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(this.cssW, this.cssH, false);
    if (this.target) this.target.setSize(Math.max(1, Math.round(this.cssW * pr)), Math.max(1, Math.round(this.cssH * pr)));
  }

  // ─────────────────────────────────────────────────────────────────── live inputs (Day 2) ──

  /** THE THEME. `applyTheme` stamps `data-theme` on `<html>`, so one `MutationObserver` on that
   * one attribute is the whole subscription — and it catches an OS-driven change too, which
   * `theme.ts` resolves in JS before stamping (CSS never sees `system`). */
  private bindTheme(): void {
    if (typeof MutationObserver !== 'function' || typeof document === 'undefined') return;
    const obs = new MutationObserver(() => this.env.refreshBackdrop(readBackdropColor()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    this.teardown.push(() => obs.disconnect());
  }

  private bindPrefs(): void {
    this.teardown.push(
      subscribeCameraPref((pref) => {
        this.cameraPref = pref;
      }),
    );
    // "YOUR HEIGHT" (owner, 2026-09-21) — module-scope state on `renderCameras.ts`, the same
    // shape `setCameraTuning` already uses for FOV/motion, so it is set once from storage here
    // and kept live for every scene that mounts (the gallery's several scenes included).
    setDriverHeightIn(getDriverHeightIn());
    this.teardown.push(subscribeDriverHeightIn(setDriverHeightIn));
    // the free camera's layout reaches the CAMERAS as well as this file: the buttons are decided
    // here (a DOM event), the direction senses and sensitivities inside `freeOrbit`/`freePan`/
    // `freeDolly`, so both have to see the same object.
    this.cameras.setFreeNav(this.freeNav);
    this.teardown.push(
      subscribeFreeCamNav((nav) => {
        this.freeNav = nav;
        this.cameras.setFreeNav(nav);
      }),
    );
    // A FIXED-TIER SCENE DOES NOT SUBSCRIBE. A replay export runs at High by contract (§4.7), and
    // a player who opened the Graphics section in another tab mid-encode must not change the
    // resolution of a video that is halfway written.
    if (this.fixedTier) return;
    this.teardown.push(
      subscribeGraphics((state) => {
        this.settings = state.settings;
        this.tier = state.tier;
        this.applyQuality();
      }),
    );
  }

  /**
   * ORBIT + FREE CAM INPUT — drag to swing the turntable or orbit/pan the free camera, wheel to
   * zoom/dolly, double-click to reset the free camera. MOUSE ONLY throughout (`e.pointerType`),
   * and every branch is gated on `this.lastCamera`, the RESOLVED camera the last frame actually
   * rendered: a touch drag over the field is the driving control on a phone, a wheel that
   * swallowed the page's scroll on every other camera would be a regression, and a listener that
   * acted before the free camera was ever selected would fight the start-position editor and
   * every ordinary canvas click (owner spec: "must be inert ... unless the 3D view is showing
   * AND the camera is 'free'").
   *
   * These listeners go on `this.host` (`.game-viewport`), the SAME element orbit has always used
   * — the 2D overlay canvas sits above the WebGL one and is what actually receives the pointer
   * (`docs/area/biobuzz.md`'s BIOBUZZ 3D section), but it is a CHILD of `host`, so the pointer
   * events bubble up to exactly this listener regardless of which canvas was hit.
   */
  private bindPointer(): void {
    const host = this.host;
    const onMove = (e: PointerEvent): void => {
      if (!this.dragMode) return;
      const dx = e.clientX - this.dragX;
      const dy = e.clientY - this.dragY;
      this.dragX = e.clientX;
      this.dragY = e.clientY;
      if (this.dragMode === 'orbit') this.cameras.orbitDrag(dx, dy);
      else if (this.dragMode === 'free-orbit') this.cameras.freeOrbit(dx, dy);
      else if (this.dragMode === 'free-pan') this.cameras.freePan(dx, dy);
      // drag-zoom: pulling DOWN zooms in, the way the CAD packages that have it do. One pixel of
      // drag is worth `FREE_ZOOM_DRAG_PX` of wheel delta, so a full-height drag spans the range.
      // The device's zoom DIRECTION and sensitivity are applied inside `freeDolly`, along with
      // "zoom to cursor" — a drag-zoom zooms toward where the drag started, same as the wheel.
      else this.cameras.freeDolly(-dy * FREE_ZOOM_DRAG_PX, this.ndcOf(e));
    };
    const endDrag = (e: PointerEvent): void => {
      if (this.dragMode) {
        try {
          host.releasePointerCapture(e.pointerId);
        } catch {
          /* capture was never taken, or the pointer is already gone — nothing to release */
        }
      }
      this.dragMode = null;
    };
    const onDown = (e: PointerEvent): void => {
      if (e.pointerType !== 'mouse') return;
      if (this.lastCamera === 'orbit' && e.button === 0) {
        this.dragMode = 'orbit';
      } else if (this.lastCamera === 'free') {
        // ⌘ IS CTRL HERE. A Mac has no ctrl-drag to spare (it is a right-click at the OS level),
        // so `metaKey` folds into the same flag and every "Ctrl+…" mapping works on both.
        const g = freeCamGesture(this.freeNav, e.button, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey });
        if (!g) return;
        this.dragMode = g === 'orbit' ? 'free-orbit' : g === 'pan' ? 'free-pan' : 'free-zoom';
      } else {
        return;
      }
      this.dragX = e.clientX;
      this.dragY = e.clientY;
      try {
        host.setPointerCapture(e.pointerId);
      } catch {
        /* an element that cannot capture still gets the window-level move/up below */
      }
    };
    const onWheel = (e: WheelEvent): void => {
      if (this.lastCamera === 'orbit') {
        e.preventDefault();
        this.cameras.orbitZoom(e.deltaY);
      } else if (this.lastCamera === 'free') {
        e.preventDefault();
        this.cameras.freeDolly(e.deltaY, this.ndcOf(e));
      }
    };
    // A MIDDLE PRESS STARTS THE BROWSER'S AUTOSCROLL (the four-way arrow cursor) on Windows, and
    // that swallows every move after it — so a middle-drag gesture has to cancel the press's
    // default. It is the legacy `mousedown` that carries that default, not `pointerdown`.
    const onMouseDown = (e: MouseEvent): void => {
      if (this.lastCamera === 'free' && e.button === 1) e.preventDefault();
    };
    // right-drag panning the free camera must not pop a context menu on release — but ONLY
    // while the free camera is active, so an ordinary right-click elsewhere on the page (or on
    // any other camera) is untouched.
    const onContextMenu = (e: MouseEvent): void => {
      if (this.lastCamera === 'free') e.preventDefault();
    };
    const onDblClick = (): void => {
      if (this.lastCamera !== 'free') return;
      this.cameras.freeReset(this.lastViewAngle);
    };
    host.addEventListener('pointerdown', onDown);
    host.addEventListener('mousedown', onMouseDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    // `passive: false` or `preventDefault()` is ignored and the page scrolls/zooms under it
    host.addEventListener('wheel', onWheel, { passive: false });
    host.addEventListener('contextmenu', onContextMenu);
    host.addEventListener('dblclick', onDblClick);
    this.teardown.push(() => {
      host.removeEventListener('pointerdown', onDown);
      host.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
      host.removeEventListener('wheel', onWheel);
      host.removeEventListener('contextmenu', onContextMenu);
      host.removeEventListener('dblclick', onDblClick);
    });
  }

  /**
   * A MOUSE EVENT → CLIP SPACE on the rendered canvas, for "zoom to cursor" (`freeDolly`'s
   * second argument). The INVERSE of `project`'s last two lines, and against the same rect:
   * `projectionMatrix` already carries `setViewOffset`, so NDC taken over the whole canvas is
   * what the camera's own unprojection expects with the HUD up.
   *
   * Reads the live `getBoundingClientRect()` rather than `cssW`/`cssH`: those are the canvas's
   * SIZE, and a `clientX` is measured from the viewport, so the canvas's own offset is needed
   * too. It is one uncached layout read per wheel notch, which is exactly the rate a wheel
   * arrives at.
   */
  private ndcOf(e: { clientX: number; clientY: number }): { x: number; y: number } | undefined {
    const el = this.canvas;
    if (typeof el.getBoundingClientRect !== 'function') return undefined;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0) || !(r.height > 0)) return undefined;
    return { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -(((e.clientY - r.top) / r.height) * 2 - 1) };
  }

  /**
   * THE CAMERA KEYS (plan §4.3: `i`/`o` eye height, plus `c` for the camera itself).
   *
   * ⚠️ `t` IS NO LONGER ONE OF THEM. It lives in `graphics/viewKey.ts` now, installed above and
   * reference-counted, because a listener owned by the scene can only ever go 3D → 2D: the scene
   * is torn down the moment the view becomes 2D and there is then nothing left listening to take
   * it back. That was this file's own note on Day 2 and it is what Day 3 fixed.
   *
   * The rest stay here, on `window`, because they act on this scene's cameras. Their KEYS are
   * bindings (`VIEW_ACTIONS`), with rows in Controls: they were hard-coded, and `c` fired the
   * camera AND Place POLLEN on one press (owner, 2026-09-24). The camera's default is L now.
   */
  private bindKeys(): void {
    if (typeof window === 'undefined') return;
    const onKey = (e: KeyboardEvent): void => {
      // the player's binds, read through the one reader (`graphics/viewKey.ts`), which also
      // ignores a modifier and typing in a chat box, a team-name field or a rebind capture
      switch (viewActionOf(e)) {
        case 'cameraCycle': {
          const i = CAMERA_PREFS.indexOf(this.cameraPref);
          setCameraPref(CAMERA_PREFS[(i + 1) % CAMERA_PREFS.length]);
          break;
        }
        case 'eyeUp':
          this.cameras.nudgeEye(1);
          break;
        case 'eyeDown':
          this.cameras.nudgeEye(-1);
          break;
        default:
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    this.teardown.push(() => window.removeEventListener('keydown', onKey));
  }

  /** the camera actually rendered this frame: the device preference WINS over the one the host
   * asked for on an INTERACTIVE scene (`'auto'`, the default, is "whatever the host asked
   * for") — but an export or a still is fully host-controlled. See `resolveSceneCamera`. */
  private resolvedCamera(hostPick: SceneCamera): SceneCamera {
    return resolveSceneCamera(this.interactive, hostPick, this.cameraPref);
  }

  render(world: World, frame: SceneFrame): void {
    const t0 = performance.now();
    // ── the frame cap (§4.4 row 2) ─────────────────────────────────────────────────────────
    // A SKIPPED FRAME RETURNS BEFORE ANY WORK, including the mesh updates: they are the other
    // half of the cost, and a cap that still posed 56 instances and every robot would save the
    // GPU and not the CPU. The world is read fresh on the next frame that does draw, so nothing
    // goes stale — this is a render cap, not a simulation one.
    if (this.frameInterval > 0 && t0 - this.lastDraw < this.frameInterval) return;
    this.lastDraw = t0;

    updateBiobuzzField(this.field, world);
    updateBiobuzzElements(this.elements, world);
    updateBiobuzzRobots(this.robots, world);
    updateBiobuzzReticle(this.reticle, world, frame.localRobotId, this.reticleOn);
    // a robot appeared or its spec changed: its materials are new and have never been tuned
    if (this.robots.group.children.length !== this.robotChildren) this.tuneMaterials();

    this.lastW = Math.max(1, frame.width);
    this.lastH = Math.max(1, frame.height);
    this.lastViewAngle = frame.viewAngle;
    this.lastCamera = this.resolvedCamera(frame.camera);
    const camera = this.cameras.update(frame, world, this.lastCamera);

    // ONE scene pass, into the MSAA target when anti-aliasing is on and straight to the canvas
    // when it is off (which costs no blit at all — that is the whole reason `off` is a real
    // setting here rather than a 1-sample target).
    this.renderer.setRenderTarget(this.target);
    this.renderer.render(this.scene, camera);
    // THE SCENE'S OWN COUNTS, READ HERE — `info.render` is reset at the START of every
    // `render()` call, and up to two more follow (the blit, the minimap), so a read taken after
    // them reports the blit's two triangles.
    const calls = this.renderer.info.render.calls;
    const tris = this.renderer.info.render.triangles;
    if (this.target) {
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.blitScene, this.blitCamera);
    }

    if (this.settings.minimap) this.renderMinimap(frame);

    /**
     * WHAT THE GOVERNOR IS FED, AND WHY IT IS NOT THE FRAME PERIOD.
     *
     * The obvious measurement — the wall-clock gap between two `render` calls — is the DISPLAY's
     * period on any machine that is keeping up, because rAF is vsync-locked. On a 60 Hz panel
     * that is 16.67 ms with jitter, so its p95 would sit just OVER §4.6's 16.7 ms threshold on
     * every healthy machine in the world and Auto would walk everybody down to Low.
     *
     * What §4.6 is actually asking is "does a frame COST more than a 60 Hz budget", so that is
     * what is measured: this function's own span. It is CPU submit time, which under-reports a
     * purely GPU-bound frame — but only for one frame, because the driver's own backpressure
     * stalls the NEXT frame's submission inside this same span. A machine that cannot draw the
     * scene shows it here within a frame or two, which is all a two-second warm-up needs.
     */
    const cost = performance.now() - t0;
    this.governor.sample(cost);
    this.stats.frame(cost, this.governor.p95Ms, calls, tris);
  }

  /**
   * THE PiP MINIMAP (§4.4's last-but-one row) — the overhead shot, in a corner, over the main
   * one. Drawn straight to the CANVAS (never through the MSAA target): it goes on top of the
   * finished image, and a second pass through the target would mean a second blit.
   *
   * It is a second full pass over the scene, which is why the table has it ON at Low and Medium
   * and OFF at High and Ultra — the machines that want a top-down aid are the ones whose 3D shot
   * is hardest to read, and the ones that do not want a second pass are the ones already drawing
   * a good one.
   */
  private renderMinimap(frame: SceneFrame): void {
    const short = Math.min(this.lastW, this.lastH);
    const size = Math.max(PIP_MIN_PX, Math.min(PIP_MAX_PX, short * PIP_FRACTION));
    /**
     * ⚠️ CSS PIXELS, NOT DRAWING-BUFFER PIXELS — and the origin is BOTTOM-left (the GL
     * convention), not the top-left the rest of the app measures in.
     *
     * `WebGLRenderer.setViewport`/`setScissor` store what they are given and multiply by the
     * renderer's own pixel ratio when they reach `gl.viewport`. Passing a figure that was
     * already multiplied therefore squares the ratio: at Low (render scale 75 %) the whole
     * scene rendered into 56 % of the canvas, tucked into the bottom-left corner with the rest
     * of the frame left as backdrop — and it looked like a CAMERA bug, because the field was
     * small and low, which is exactly what a bad fit looks like. It was this line.
     */
    const w = size;
    const h = size;
    const x = PIP_MARGIN;
    const y = PIP_MARGIN;

    // the fit: the whole field plus its view margin, squared off so a round minimap window shows
    // the same extent on both axes whatever the main camera is doing
    const ext = Math.max(BB_HALF_X, BB_HALF_Y) + BB_VIEW_MARGIN;
    this.pipCamera.left = -ext;
    this.pipCamera.right = ext;
    this.pipCamera.top = ext;
    this.pipCamera.bottom = -ext;
    this.pipCamera.position.set(0, 0, 300);
    // `up` is the driver's own screen-up in world space (`rot({0,1}, -viewAngle)`), so the
    // minimap is oriented exactly like the 2D map the same player sees when they press `t`
    const theta = -frame.viewAngle;
    this.pipCamera.up.set(-Math.sin(theta), Math.cos(theta), 0);
    this.pipCamera.lookAt(0, 0, 0);
    this.pipCamera.updateProjectionMatrix();

    const r = this.renderer;
    r.setScissorTest(true);
    r.setScissor(x, y, w, h);
    r.setViewport(x, y, w, h);
    // clear only inside the scissor — `clear()` respects it, which is what makes this an inset
    // rather than a wipe of the frame that was just drawn
    r.autoClear = false;
    r.clear(true, true, false);
    r.render(this.scene, this.pipCamera);
    r.setScissorTest(false);
    r.autoClear = true;
    r.setViewport(0, 0, this.cssW, this.cssH);
  }

  /**
   * FIELD POINT → CSS PIXELS on the overlay canvas, through the camera this scene last
   * rendered (`GameScene.project`, `games/module.ts` — read its contract first).
   *
   * Projects manually rather than through `Vector3.project()` so a point BEHIND the camera can
   * be rejected: the perspective divide flips the sign of x and y behind the eye, so a robot
   * two feet behind a driver's shoulder projects to a perfectly plausible on-screen position,
   * mirrored. Camera space is checked first (`z > 0` is behind, three.js cameras look down
   * their own −z), then the projection matrix — WHICH ALREADY CARRIES `setViewOffset`, so the
   * NDC that comes out maps to the WHOLE canvas, exactly the pixels the overlay draws in.
   */
  project(x: number, y: number, z: number, out: { x: number; y: number; visible: boolean }): void {
    const cam = this.cameras.active;
    const v = this.projScratch.set(x, y, z);
    v.applyMatrix4(cam.matrixWorldInverse);
    if (v.z > -1e-3) {
      out.visible = false;
      return;
    }
    v.applyMatrix4((cam as THREE.PerspectiveCamera).projectionMatrix);
    out.x = (v.x * 0.5 + 0.5) * this.lastW;
    out.y = (-v.y * 0.5 + 0.5) * this.lastH;
    out.visible = v.x >= -1 && v.x <= 1 && v.y >= -1 && v.y <= 1 && v.z <= 1;
  }

  resize(width: number, height: number, dpr: number): void {
    this.cssW = Math.max(1, width);
    this.cssH = Math.max(1, height);
    // the DEVICE ratio is capped at 2 before the settings see it: past 2× the difference is
    // below the resolving power of the panel and the cost is quadratic. The render-scale
    // setting can still push past it deliberately (§4.4 offers up to 200 %), which is the
    // difference between "the browser said 3" and "the player asked for it".
    this.hostDpr = Math.min(dpr, 2);
    this.syncSize();
  }

  dispose(): void {
    for (const off of this.teardown) off();
    this.teardown.length = 0;
    this.governor.dispose();
    this.stats.dispose();
    this.reticle.dispose();
    this.env.dispose();
    this.target?.dispose();
    this.blitMesh.geometry.dispose();
    this.blitMesh.material.dispose();
    /**
     * ⚠️ **THE ROBOTS COME OUT OF THE SCENE BEFORE THE BLANKET WALK, AND ARE FREED THEIR OWN
     * WAY.** `disposeObject3D` frees every geometry and material it touches, and
     * `renderRobots.ts` SHARES most of a robot's geometry and material between robots, between
     * scenes and with the builder's preview (`SHARED_GEO` / `SHARED_MAT`, and that file's header
     * says exactly this). Walking them from here frees the frame geometry, the roller texture
     * and every solid material out from under a preview that is still mounted and under the next
     * 3D view the player opens — three re-uploads and recompiles whatever it can, so the symptom
     * is a frame hitch and a warning, not a crash, which is how it survives review.
     * `renderPreview.ts`'s own `dispose` has always done it this way.
     *
     * Only the robots need this. The field builds its meshes per scene (its caches are local to
     * the build function), and the elements, the reticle and the blit mesh are this scene's own.
     */
    this.scene.remove(this.robots.group);
    this.robots.dispose();
    disposeObject3D(this.scene);
    releaseRenderer(this.renderer);
    this.element.parentElement?.removeChild(this.element);
  }
}

/**
 * AUTO, RUN ONCE PER PAGE (plan §4.6).
 *
 * The probe creates a real WebGL2 context and the WebGPU adapter query is a permission-shaped
 * async call, so neither belongs on the path of every scene the gallery mounts. The result is
 * cached here for the life of the document; the WARM-UP, which is the half that actually
 * measures anything, runs per scene inside the governor.
 */
let detected = false;
// `gpuProbe()` (the once-per-document WebGL2 probe) is `renderCore.ts`'s now: the builder
// preview needs the same answer, and a second probe would cost a real WebGL context.

function detectOnce(onEvent?: (line: string) => void): void {
  if (detected) return;
  detected = true;
  const probe = gpuProbe();
  applyFirstGuess(probe, '', onEvent);
  // the WebGPU adapter is a SECOND opinion and arrives late; it refines the guess only while
  // the warm-up has not yet had its say
  void probeAdapter().then((adapter) => {
    if (adapter) applyFirstGuess(probe, adapter, onEvent);
  });
}

/**
 * Builds a `GameScene` inside `host`. Creates its own `<canvas>` (per the seam contract) and
 * appends it. Requires WebGL2 — probed before anything else touches the canvas — so the caller
 * can fall back to the 2D view on a software renderer or an old browser without this module
 * having thrown mid-construction.
 *
 * ⚠️ A SOFTWARE RENDERER IS REFUSED HERE, AND THE TAB FALLS BACK TO 2D BEFORE THE THROW
 * (plan §4.6: "a software renderer string or a failed WebGL2 probe selects the 2D view
 * with an event-log line; the 3D view stays one click away for retry"). The fallback is what
 * makes it stick for this tab (never in storage: see `fallBackTo2d`). The host's own catch only
 * logs, so without it the scene would be retried on every remount and the player would sit in front of a canvas that never
 * appears. Nothing is disabled: the Graphics section's 3D button is still one click away, which
 * is the retry §4.6 asks for.
 *
 * ASYNC (the CAD switch-over, §8): `buildBiobuzzField` awaits the GLB (or falls back to the
 * constants field on any failure, logging its own warning) BEFORE the `BiobuzzScene` is
 * constructed, so the scene never exists half-built.
 */
export const createBiobuzzScene: GameSceneFactory = async (host: HTMLElement, options?: SceneOptions): Promise<GameScene> => {
  const opts = options ?? {};
  if (!opts.quality) detectOnce(opts.onQualityEvent);

  const probe = gpuProbe();
  if (!probe.webgl2) {
    fallBackTo2d();
    opts.onQualityEvent?.('This browser has no WebGL2. Showing the 2D view.');
    throw new SceneUnsupportedError('WebGL2 unavailable');
  }
  if (probe.software) {
    fallBackTo2d();
    opts.onQualityEvent?.(`No GPU acceleration here (${probe.renderer || 'software renderer'}). Showing the 2D view.`);
    throw new SceneUnsupportedError(`software renderer: ${probe.renderer}`);
  }

  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  const quality = opts.quality ? GFX_PRESETS[opts.quality as GraphicsTier] : getGraphics().settings;
  // THE ELEMENT CAD RIDES ALONG WITH THE FIELD'S OWN AWAIT, and is allowed to fail. 22 KB
  // against `field.glb`'s 754 adds nothing measurable to a load that is already happening, and
  // it is what makes the REPLAY EXPORT (a fixed-High scene, §4.7) draw perforated balls on its
  // very first frame instead of spheres for however long a fetch takes. A live scene does not
  // depend on it: `buildBiobuzzElements` starts on spheres and swaps whenever the promise
  // lands, so this await is an optimisation and the `catch` is the whole error path.
  const [field] = await Promise.all([
    buildBiobuzzField(quality.meshDetail),
    quality.elementDetail === 'cad' ? loadElementGeometries().catch(() => null) : null,
  ]);
  host.appendChild(canvas);
  // `host` is handed on: the orbit camera's pointer listeners live on it (see the class's own
  // note — the 2D overlay canvas is above this one and would otherwise swallow every press).
  return new BiobuzzScene(canvas, field, host, opts);
};
