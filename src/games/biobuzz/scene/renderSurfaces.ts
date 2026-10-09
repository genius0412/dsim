import type * as THREE from 'three';
import type { EnvironmentDef } from '../graphics/environments';
import type { BbFieldHandles } from './renderField';
import { createFieldSurfaces } from './renderSurfaceField';
import { lowerSurfaceUniforms, setDetailAnisotropy, SURFACE_UNIFORMS } from './renderSurfaceKit';
import { createRoomProbe } from './renderSurfaceProbe';
import { applyRobotSurfaces, revertRobotSurfaces } from './renderSurfaceRobots';
import { createVenueSurfaces } from './renderSurfaceVenue';

/**
 * BIOBUZZ 3D PHYSICAL MATERIALS — the `materials: 'physical'` row (`graphics/settings.ts`, the
 * NINETEENTH, on by default in Extreme), in a LAZY CHUNK of its own. Owner, 2026-09-27: "Robot
 * front bars shouldn't glow. There's no need for it to. Adding accurate texture, material, and
 * reflection matters more." So this is realism, not effects: measured finishes from the table in
 * `graphics/finishes.ts`, procedural surface detail at real feature sizes, and a ROOM PROBE the
 * metals and coatings reflect. Nothing here glows, and nothing here adds an emissive.
 *
 * ── HOW IT IS REACHED ───────────────────────────────────────────────────────────────────────
 * Only through `import('./renderSurfaces')`, from exactly two places, both inside the scene chunk:
 * `renderScene.ts` (the match) and `renderPreview.ts` (the builder turntable, robots only). Its
 * helpers (`renderSurfaceKit`, `renderSurfaceProbe`, `renderSurfaceField`, `renderSurfaceRobots`,
 * `renderSurfaceVenue`) are imported ONLY from inside this chunk, so Rollup emits them into the
 * same lazy file, which `bundleaudit` routes as `surfaces` by its filename. A STATIC import from
 * anywhere in the scene chunk would pull the whole lot into the chunk every 3D player downloads;
 * an import from outside `scene/` would hoist three.js out of it.
 *
 * ── THE CONTRACT WITH THE SCENES ────────────────────────────────────────────────────────────
 *   • EVERYTHING IS LIVE AND REVERSIBLE. `apply*` swaps meshes onto cached physical TWINS and
 *     parks the base on `mesh.userData.bbBaseMat`; `revert*` swaps them back. No base material is
 *     ever written (the kit's header says why: they are shared with scenes that are not asking for
 *     this). So standard mode is pixel-identical whether this chunk was ever loaded or not.
 *   • `apply*` IS IDEMPOTENT, so a caller can re-walk a group after part of it was rebuilt.
 *   • A THROW FROM ANY OF THIS IS THE CALLER'S TO CATCH, and the answer is to drop the mode for the
 *     scene's life (`renderScene.ts`'s `dropSurfaces`), never to let it out of `render` — a throw
 *     there drops the player to 2D, which is a far worse answer to "no physical materials".
 *   • THE PROBE IS THE MATCH'S ALONE. The preview is created with `{ probe: false }` and reflects
 *     the dome — the ONE allowed material-side difference between the builder and the match
 *     (besides post, the shadow-map size and the light rig), because the preview has no venue to
 *     capture.
 */

export interface SurfacesOptions {
  /** capture and use a room probe (the match); false = dome reflections only (the preview) */
  probe: boolean;
}

export interface BbSurfaces {
  /** the field's static parts (the GLB's `<finish>#<hex>@<family>` materials) and the clear
   * panels' physical-mode shadow policy */
  applyField(field: BbFieldHandles): void;
  revertField(field: BbFieldHandles): void;
  /** every robot mesh under `group` — idempotent, re-walk after any rebuild */
  applyRobots(group: THREE.Object3D): void;
  revertRobots(group: THREE.Object3D): void;
  /** the venue group `buildBiobuzzVenue` returned for `def`. REVERT BEFORE DISPOSING a venue:
   * the bases then go back on their meshes and the scene's `disposeObject3D` frees them. */
  applyVenue(venue: THREE.Object3D, def: EnvironmentDef): void;
  revertVenue(venue: THREE.Object3D): void;
  /** the scoring elements' group (a no-op in the core pass; the scenery applier's hook) */
  applyElements(group: THREE.Object3D): void;
  revertElements(group: THREE.Object3D): void;
  /**
   * CAPTURE THE ROOM PROBE, with `hidden` hidden for it. A no-op returning false for a
   * `{ probe: false }` instance, or when the scene has no cube-UV environment yet. Call it when the
   * room CHANGED — the environment resolved (a late HDRI included), the venue was rebuilt, the
   * mode was switched on — never per frame, and outside `raise`/`lower` and the bloom window.
   */
  recapture(renderer: THREE.WebGLRenderer, scene: THREE.Scene, hidden: readonly THREE.Object3D[], def: EnvironmentDef): boolean;
  /** push THIS scene's surface uniforms (the probe, the reflections scale) — immediately before
   * its own scene pass */
  raise(scene: THREE.Scene): void;
  /** put the shared uniforms back at rest — immediately after that pass, in a `finally`. Cannot
   * throw. */
  lower(): void;
  /** the `reflections` row: scales every twin's image-based specular (applied at `raise`) */
  setReflections(on: boolean): void;
  /** whether robots RECEIVE shadows (the match passes `shadows === 'max'`; the preview never
   * calls it). Lands on the next `applyRobots`, which the caller makes. */
  setRobotShadows(on: boolean): void;
  /** the `anisotropy` row, for the detail textures (already clamped to the GPU's maximum) */
  setAnisotropy(n: number): void;
  /** free this instance's probe, textures and per-scene twins. Revert first. */
  dispose(): void;
}

export function createSurfaces(opts: SurfacesOptions): BbSurfaces {
  const field = createFieldSurfaces();
  const venue = createVenueSurfaces();
  const probe = opts.probe ? createRoomProbe() : null;
  let reflections = true;
  let robotShadows = false;

  return {
    applyField: (f) => field.apply(f),
    revertField: (f) => field.revert(f),
    applyRobots: (g) => {
      applyRobotSurfaces(g, robotShadows);
    },
    revertRobots: (g) => revertRobotSurfaces(g),
    applyVenue: (v, def) => venue.apply(v, def),
    revertVenue: (v) => venue.revert(v),
    // the elements' PE twin is the field applier's (`renderSurfaceField.ts`); the venue hook is
    // kept in the chain so either applier can own a part without the other having to know
    applyElements: (g) => {
      field.applyElements(g);
      venue.applyElements(g);
    },
    revertElements: (g) => {
      field.revertElements(g);
      venue.revertElements(g);
    },
    recapture(renderer, scene, hidden, def): boolean {
      return probe ? probe.capture(renderer, scene, hidden, def.venue) : false;
    },
    raise(scene): void {
      SURFACE_UNIFORMS.bbSpecIbl.value = reflections ? 1 : 0;
      if (probe) probe.raise(scene);
      else {
        SURFACE_UNIFORMS.bbProbeOn.value = 0;
        SURFACE_UNIFORMS.bbProbeMap.value = null;
      }
    },
    lower: lowerSurfaceUniforms,
    setReflections(on): void {
      reflections = on;
    },
    setRobotShadows(on): void {
      robotShadows = on;
    },
    setAnisotropy(n): void {
      setDetailAnisotropy(n);
      field.setAnisotropy(n);
    },
    dispose(): void {
      lowerSurfaceUniforms();
      probe?.dispose();
      field.dispose();
      venue.dispose();
    },
  };
}
