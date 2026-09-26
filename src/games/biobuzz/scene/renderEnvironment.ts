import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { environmentDef, environmentDefFor, type EnvironmentDef, type EnvironmentLook } from '../graphics/environments';
import type { EnvironmentId } from '../graphics/settings';

/**
 * THE ENVIRONMENT MAP — a PAINTED dome, three's own procedural room, or one of the two CC0
 * HDRIs, run through `PMREMGenerator` and handed to the scene (`docs/biobuzz/plan-3d.md` §4.5).
 *
 * ── WHAT A PMREM IS FOR, IN ONE LINE ───────────────────────────────────────────────────────
 * A `MeshStandardMaterial` with nothing to reflect is a flat-shaded polygon. `scene.environment`
 * gives every PBR material in the scene an image to gather light from — the diffuse term from
 * its low-frequency content and the specular term from a roughness-indexed mip chain, which is
 * what `PMREMGenerator` pre-filters. One texture, generated once, read by every material with
 * no per-material wiring.
 *
 * ── THE THREE RULES §4.5 SETS, AND WHERE EACH IS KEPT ──────────────────────────────────────
 *   ON DEMAND   — an HDRI is fetched by `HDRLoader` the first time its id is selected, and
 *                 never otherwise. It is `HDRLoader` and NOT `RGBELoader`: three 0.186 renamed
 *                 it and the old name now logs a deprecation warning on every load, which is a
 *                 line of console noise a player would see for picking a setting. Same loader,
 *                 same `.hdr` parser, same few KB in this chunk — which is already the thing a
 *                 2D player never downloads.
 *   CACHED      — twice over. Poly Haven's CDN answers `Cache-Control: max-age=14400`, so a
 *                 re-pick inside four hours is a memory-cache hit; and this loader keeps the
 *                 generated PMREM per id for the life of the scene, so switching back and forth
 *                 in the Graphics section costs nothing at all after the first of each.
 *   NEVER BUNDLED — no `public/` copy, no import, no data URI. `bundleaudit` would see it.
 *
 * ── FAILURE IS A PAINTED ROOM, NOT A BLACK SCENE ───────────────────────────────────────────
 * A blocked CDN, an offline desktop build, a corporate proxy that rewrites `.hdr` to HTML: all
 * of it ends at the same place, a surround that needs no network, plus one event-log line. A 3D
 * view that goes black because a decoration failed to download would be a far worse bug than
 * the one it is reporting.
 *
 * ⚠️ IT IS THE ENTRY'S OWN `hdri.fallback` NOW, NOT `'room'` — a school hall falls back to the
 * painted school gym, a monochrome studio to the dark cyclorama. `'room'` was the flattest
 * surround on the list and, since the venue geometry landed, it also disagreed with the room the
 * scene was still BUILDING around the field: `renderScene` sizes the venue off the environment
 * row, so the old path put a hall's walls, ceiling and bleachers around a field lit by three's
 * generic box. See `graphics/environments.ts`'s `fallback`.
 *
 * ⚠️ AND A FAILURE IS REMEMBERED, WHICH IT WAS NOT. Only successes were cached, so every scene
 * build and every graphics-settings change re-issued a request that had already failed — in the
 * Discord Activity, where the CSP refuses the host outright, that was once per scene for the life
 * of the embed. `failedHdri` below is module-scope on purpose (see it).
 *
 * The CSP case does not even reach here any more: `environmentDefFor` resolves an unfetchable
 * entry to its stand-in BEFORE a loader is built, so the embed takes the ordinary painted path
 * with no request at all. What is left for this file is the TRANSIENT failure.
 */

/** what a background looks like when the environment is a photographed room: blurred enough to
 * read as a surround rather than as a picture somebody hung behind the field, and dimmed so the
 * field — whose own colours are FIXED (§4.5: the HUD's on-field contrast pairs depend on it) —
 * stays the brightest thing on screen. */
const BG_BLUR = 0.4;
const BG_INTENSITY = 0.5;

// ────────────────────────────────────────────────────────── the painted domes (2026-09-21) ──
//
// Eight of the eleven environments are PAINTED rather than fetched — see
// `graphics/environments.ts`'s header for why. The recipe is one equirectangular canvas per id:
// a vertical gradient, then (where the `look` asks for them) a lamp disc, a truss ring, a
// silhouette band and a star field. That canvas goes through the SAME `PMREMGenerator` the HDRI
// path uses, and the mip chain it produces is both `scene.environment` and `scene.background`.
//
// ⚠️ **ONE TEXTURE FOR BOTH, AND THROUGH THE PMREM EVEN WHEN THE LIGHTING IS OFF.** A raw
// `CanvasTexture` assigned to `scene.background` is a plain 2D map to three's background pass and
// `backgroundBlurriness` does nothing to it; the PMREM output carries `CubeUVReflectionMapping`,
// which is the branch that reads the blurriness uniform. It is also what keeps a picked
// environment looking the same whether the IBL row is on or off — only the light-gathering
// changes, never the picture behind the field.

/** the painted dome's size. 768 × 384 is two mip levels above what `PMREMGenerator` actually
 * consumes for the irradiance term and enough for the truss/silhouette to survive the background
 * blur as STRUCTURE rather than as a smear. Bigger buys nothing: the source is thrown away the
 * moment the mip chain exists, exactly as the HDRI's is. */
const SKY_W = 768;
const SKY_H = 384;

/**
 * IDS WHOSE `.hdr` HAS ALREADY FAILED TO LOAD IN THIS DOCUMENT.
 *
 * ⚠️ MODULE SCOPE, unlike the PMREM `cache` below — and the two are opposites for a reason. A
 * generated texture belongs to ONE renderer (a PMREM is GL-context-bound, and the gallery mounts
 * several scenes), so caching it per scene is mandatory. Whether a URL can be fetched is a
 * property of the NETWORK and the page's CSP, so re-asking per scene only reproduces the same
 * refusal: the failure has to outlive the scene or it is not remembered at all.
 *
 * ⚠️ IT COUNTS, IT DOES NOT BLACKLIST ON THE FIRST MISS. One refusal is what a mobile blip, a
 * captive portal or a proxy hiccup looks like, and a document is a whole Electron run — so
 * remembering it forever meant one bad second cost a player the real environment until they
 * restarted the app. Two tries, then the stand-in: a transient failure recovers on the next
 * scene build, a host the client genuinely cannot reach still stops being re-requested.
 */
const HDRI_MAX_TRIES = 2;
const failedHdri = new Map<EnvironmentId, number>();
/**
 * ⚠️ AND THE COUNT EXPIRES. Two blips in one long Electron run still meant the stand-in until a
 * restart, so a spent count is forgotten `HDRI_RETRY_MS` after its last miss (and a success clears
 * it outright). An unreachable host is then asked once per window, not once per scene build.
 */
const HDRI_RETRY_MS = 5 * 60_000;
const hdriFailedAt = new Map<EnvironmentId, number>();

/**
 * ⚠️ **THE ENVIRONMENT MAP IS SAMPLED IN THREE'S OWN Y-UP FRAME AND THIS SCENE IS Z-UP.**
 *
 * Every camera in `scene/` sets `up = (0,0,1)` and every position in this directory is field
 * inches with z up — which is a choice about the SCENE GRAPH, and an environment map does not
 * live in the scene graph. `textureCubeUV` is handed a world direction and three's convention for
 * an equirectangular map is +y = the zenith, so an unrotated map lies on its SIDE here: its
 * ceiling points at the rear wall and its floor at the audience. Nothing looked obviously wrong
 * while the only maps were a photographed hall and a white studio (both near-symmetric about
 * their own vertical), and it is glaring the moment a dome has a horizon in it.
 *
 * ⚠️ AND THE SIGN IS `+π/2`, WHICH IS NOT THE ONE THE ARITHMETIC ALONE GIVES. Rotating a world
 * direction by −π/2 about X is what maps world +z onto the map's +y, and that is what was tried
 * first — it painted the sunset dome UPSIDE DOWN (orange at the zenith, night blue underfoot),
 * measured. `WebGLRenderer` negates all three Euler components before building the matrix it
 * hands the shader ("accommodate left-handed frame"), so the rotation a scene ASKS for and the
 * one the sampler applies are inverses of each other. Written out rather than left as a
 * mysterious `+`: the next person to derive this on paper will get `-` too.
 */
const MAP_ROT = new THREE.Euler(Math.PI / 2, 0, 0);

/** a hex as `#rrggbb`, for the canvas 2D API. */
function hex(c: number): string {
  return `#${c.toString(16).padStart(6, '0')}`;
}

/** DETERMINISTIC noise for the star field — the same dome every time this is painted, on every
 * machine. `Math.random` here would make a replay export's first frame differ from its second
 * and from everybody else's. */
function starRand(i: number): number {
  let t = (i * 0x9e3779b1) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** row on the canvas for an elevation in degrees (+90 = zenith at row 0). */
function rowForEl(el: number): number {
  return ((90 - el) / 180) * SKY_H;
}

/**
 * PAINT one `EnvironmentLook` onto an equirectangular canvas.
 *
 * Deliberately flat and cheap: this runs once per id, on the frame the player picks it, and the
 * blur the background is drawn with (`look.blur`) is doing most of the work of making it read as
 * a place rather than as a painting. Anything more detailed would be thrown away by that blur and
 * by the PMREM's own filtering.
 */
function paintSky(look: EnvironmentLook): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = SKY_W;
  cv.height = SKY_H;
  const g = cv.getContext('2d')!;

  // the vertical gradient, zenith to nadir
  const grad = g.createLinearGradient(0, 0, 0, SKY_H);
  for (const [t, c] of look.sky) grad.addColorStop(Math.min(1, Math.max(0, t)), hex(c));
  g.fillStyle = grad;
  g.fillRect(0, 0, SKY_W, SKY_H);

  // STARS, in the upper dome only — below the horizon is a floor, and a star under it reads as a
  // speck of dirt on the lens.
  if (look.stars) {
    g.fillStyle = '#ffffff';
    for (let i = 0; i < 420; i++) {
      const x = starRand(i * 3) * SKY_W;
      const y = starRand(i * 3 + 1) * SKY_H * 0.46;
      const a = 0.25 + starRand(i * 3 + 2) * 0.6;
      g.globalAlpha = a * (1 - y / (SKY_H * 0.5)); // thinner toward the horizon, as a real sky is
      g.fillRect(x, y, 1.2, 1.2);
    }
    g.globalAlpha = 1;
  }

  // THE TRUSS / STRIP-LIGHT RING — a bright bar at one elevation, all the way round. Drawn with a
  // soft vertical falloff so it lights the dome around it instead of reading as a cut-out slot.
  if (look.truss) {
    const cy = rowForEl(look.truss.el);
    const half = (look.truss.h / 180) * SKY_H;
    const halo = g.createLinearGradient(0, cy - half * 3, 0, cy + half * 3);
    halo.addColorStop(0, 'rgba(0,0,0,0)');
    halo.addColorStop(0.5, hex(look.truss.color));
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalAlpha = 0.5;
    g.fillStyle = halo;
    g.fillRect(0, cy - half * 3, SKY_W, half * 6);
    g.globalAlpha = 1;
    g.fillStyle = hex(look.truss.color);
    g.fillRect(0, cy - half, SKY_W, half * 2);
  }

  // A LAMP — a single soft disc (the sun, or a bank of ceiling lamps). `az` is a fraction round
  // the dome; the map's own zero azimuth is arbitrary, so this is a PLACEMENT, not a direction
  // the key light is derived from (`rig.sun` is that, and the two are set together by hand).
  if (look.lamp) {
    const cx = ((look.lamp.az % 360) / 360) * SKY_W;
    const cy = rowForEl(look.lamp.el);
    const r = (look.lamp.r / 180) * SKY_H;
    // drawn three times across the seam so a lamp near azimuth 0 is not sliced in half
    for (const dx of [-SKY_W, 0, SKY_W]) {
      const rg = g.createRadialGradient(cx + dx, cy, 0, cx + dx, cy, r);
      rg.addColorStop(0, hex(look.lamp.color));
      rg.addColorStop(0.45, `${hex(look.lamp.color)}80`);
      rg.addColorStop(1, `${hex(look.lamp.color)}00`);
      g.fillStyle = rg;
      g.fillRect(cx + dx - r, cy - r, r * 2, r * 2);
    }
  }

  // THE SILHOUETTE — a toothed dark band below the horizon: stands, bleachers, shelving. The
  // teeth are what stop it reading as a second gradient stop; their heights come from the same
  // deterministic noise the stars do.
  if (look.silhouette) {
    const s = look.silhouette;
    const y0 = s.top * SKY_H;
    const y1 = s.bottom * SKY_H;
    g.globalAlpha = s.alpha;
    g.fillStyle = hex(s.color);
    g.fillRect(0, (y0 + y1) / 2, SKY_W, SKY_H - (y0 + y1) / 2);
    const w = SKY_W / s.teeth;
    for (let i = 0; i < s.teeth; i++) {
      const h = (y1 - y0) * (0.35 + starRand(i * 7 + 11) * 0.65);
      g.fillRect(i * w, (y0 + y1) / 2 - h, w * 0.94, h);
    }
    g.globalAlpha = 1;
  }

  return cv;
}

/**
 * THE LIGHT RIG, APPLIED — the one place an environment's `rig` reaches the renderer.
 *
 * Called from `renderScene.ts`'s `applyQuality` on every settings change, beside the rest of
 * §4.4's rows. `ibl` picks which of the two hemisphere intensities the rig carries: with the
 * environment map off, the hemisphere is most of the ambient term there is and has to carry more.
 *
 * ⚠️ THE BUILDER PREVIEW IS NOT TOUCHED BY ANY OF THIS. It lights from `renderCore.ts`'s shared
 * constants, which are what `BASE_RIG` copies, so a robot in the garage and the same robot on the
 * field still agree — a preview whose lighting followed the match's ENVIRONMENT would show a
 * different-coloured chassis depending on a setting that has nothing to do with the build.
 */
export function applyEnvironmentRig(
  renderer: THREE.WebGLRenderer,
  hemi: THREE.HemisphereLight,
  sun: THREE.DirectionalLight,
  def: EnvironmentDef,
  ibl: boolean,
): void {
  const r = def.rig;
  hemi.color.setHex(r.hemiSky);
  hemi.groundColor.setHex(r.hemiGround);
  hemi.intensity = ibl ? r.hemiIbl : r.hemiNoIbl;
  sun.position.set(r.sun[0], r.sun[1], r.sun[2]);
  sun.color.setHex(r.sunColor);
  sun.intensity = r.sunIntensity;
  renderer.toneMappingExposure = r.exposure;
}

export interface BbEnvironment {
  /**
   * Apply `id` to `scene`, replacing whatever is there. Resolves when the map is live; on a
   * failure it resolves having applied that entry's painted `fallback` and called `onEvent`.
   *
   * `lighting` is §4.4's `envLighting` row. FALSE means the map does not light anything —
   * `scene.environment` stays null — but a PROCEDURAL dome is still painted as the background,
   * because it costs no download and the row is about the lighting, not about the picture. An
   * HDRI with the lighting off is the one case that falls back to the room: fetching 1.7 MB for a
   * backdrop is not a trade this setting is offering, which is what it has always said.
   */
  apply(id: EnvironmentId, onEvent?: (line: string) => void, lighting?: boolean): Promise<void>;
  /** the id currently applied — what the background restore logic checks. */
  readonly current: EnvironmentId;
  /** true while a fetch is in flight, for the picker's own busy state. */
  readonly loading: boolean;
  /** re-read the themed backdrop colour (the theme changed) — a no-op while an HDRI is the
   * background, because that one is not themed and must not be overwritten by a colour. */
  refreshBackdrop(hex: number): void;
  dispose(): void;
}

export function createEnvironment(renderer: THREE.WebGLRenderer, scene: THREE.Scene, backdropHex: number): BbEnvironment {
  const pmrem = new THREE.PMREMGenerator(renderer);
  // compiling the equirectangular shader up front keeps the first HDRI's `fromEquirectangular`
  // off the frame it lands on — otherwise the swap costs a visible hitch on a cold shader cache
  pmrem.compileEquirectangularShader();

  /** generated maps, per id, for the life of this scene. A PMREM is renderer-bound, so this
   * cache cannot be module-scope: two scenes (the gallery mounts several) would hand each
   * other's GL context a texture it has never seen. */
  const cache = new Map<EnvironmentId, THREE.Texture>();
  const backdrop = new THREE.Color(backdropHex);
  let current: EnvironmentId = 'room';
  let loading = false;
  // see `MAP_ROT` — this scene is z-up and an environment map is not
  scene.backgroundRotation.copy(MAP_ROT);
  scene.environmentRotation.copy(MAP_ROT);
  /** bumped on every `apply`, so a slow HDRI that lands after the player has picked something
   * else is dropped instead of replacing the newer choice. */
  let epoch = 0;
  let disposed = false;

  const roomTexture = (): THREE.Texture => {
    const hit = cache.get('room');
    if (hit) return hit;
    const room = new RoomEnvironment();
    const tex = pmrem.fromScene(room, 0.04).texture;
    // `RoomEnvironment` is a throwaway scene of ~12 boxes; the PMREM has already consumed it
    room.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry?.dispose();
        const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
        for (const mat of mats) mat.dispose();
      }
    });
    cache.set('room', tex);
    return tex;
  };

  /** the room is the environment AND the themed letterbox behind the field. */
  const applyRoom = (lighting = true): void => {
    scene.environment = lighting ? roomTexture() : null;
    scene.background = backdrop;
    scene.backgroundBlurriness = 0;
    scene.backgroundIntensity = 1;
    current = 'room';
  };

  /**
   * A PAINTED DOME, through the same PMREM the HDRI path uses. Cached per id for the life of the
   * scene exactly as an HDRI's is — the canvas, the `CanvasTexture` and the equirect source are
   * all thrown away the moment the mip chain exists, so what is held is one small cube-UV
   * texture per environment the player has actually looked at.
   */
  const skyTexture = (def: EnvironmentDef): THREE.Texture => {
    const hit = cache.get(def.id);
    if (hit) return hit;
    const src = new THREE.CanvasTexture(paintSky(def.look!));
    src.mapping = THREE.EquirectangularReflectionMapping;
    src.colorSpace = THREE.SRGBColorSpace;
    const tex = pmrem.fromEquirectangular(src).texture;
    src.dispose();
    cache.set(def.id, tex);
    return tex;
  };

  /** a painted environment: the dome is the surround always, and the light-gathering map only
   * when §4.4's `envLighting` row is on. */
  const applySky = (def: EnvironmentDef, lighting: boolean): void => {
    const tex = skyTexture(def);
    scene.environment = lighting ? tex : null;
    scene.background = tex;
    scene.backgroundBlurriness = def.look!.blur;
    scene.backgroundIntensity = def.look!.intensity;
    current = def.id;
  };

  /** the painted stand-in for a fetched entry we cannot have — see `EnvironmentDef.hdri.fallback`.
   * A stand-in is required to be a PAINTED entry, and the `look` guard is the belt to that brace:
   * a mistyped id resolves through `environmentDef` to the room, which still needs no network. */
  const applyFallback = (def: EnvironmentDef, lighting: boolean): EnvironmentDef => {
    const alt = environmentDef(def.hdri!.fallback);
    if (alt.look) applySky(alt, lighting);
    else applyRoom(lighting);
    return alt;
  };

  const applyHdri = (id: EnvironmentId, tex: THREE.Texture): void => {
    scene.environment = tex;
    // THE HDRI IS ALSO THE SURROUND. On the CAD-GLB field path there is no procedural room
    // behind the walls at all (see `renderScene.ts`'s note on `readBackdropColor`), so the
    // background IS most of the picture — leaving it a flat themed colour while the lighting
    // came from a hall would read as a compositing mistake rather than as a setting.
    scene.background = tex;
    scene.backgroundBlurriness = BG_BLUR;
    scene.backgroundIntensity = BG_INTENSITY;
    current = id;
  };

  applyRoom();

  return {
    get current(): EnvironmentId {
      return current;
    },
    get loading(): boolean {
      return loading;
    },
    async apply(id: EnvironmentId, onEvent?: (line: string) => void, lighting = true): Promise<void> {
      if (disposed) return;
      const mine = ++epoch;
      // ⚠️ THE RESOLVED ROW, the same one `renderScene.applyQuality` lights and builds the venue
      // from. On a client whose CSP forbids the HDRI host this is already the painted stand-in,
      // so the fetch below is never even reached there — see `graphics/environments.ts`.
      const def = environmentDefFor(id);
      if (def.look) {
        loading = false;
        applySky(def, lighting);
        return;
      }
      if (!def.hdri) {
        loading = false;
        applyRoom(lighting);
        return;
      }
      // AN HDRI WITH THE LIGHTING OFF IS NOT FETCHED — see `BbEnvironment.apply`. The room is the
      // honest fallback: it is the other environment that needs no network.
      if (!lighting) {
        loading = false;
        applyRoom(false);
        return;
      }
      const cached = cache.get(id);
      if (cached) {
        loading = false;
        applyHdri(id, cached);
        return;
      }
      // ALREADY TRIED, ALREADY REFUSED. Without this the retry ran on every scene build and every
      // graphics-settings change, because only a SUCCESS was ever cached — see `failedHdri`.
      if (Date.now() - (hdriFailedAt.get(id) ?? 0) >= HDRI_RETRY_MS) failedHdri.delete(id);
      if ((failedHdri.get(id) ?? 0) >= HDRI_MAX_TRIES) {
        loading = false;
        applyFallback(def, lighting);
        return;
      }
      loading = true;
      try {
        /**
         * ⚠️ ONLY THE FETCH COUNTS AGAINST THE URL. Everything after it runs on the GPU, and a
         * context loss there would have recorded a download that actually succeeded as an
         * unreachable host — blacklisting an environment for a reason that has nothing to do
         * with whether it can be loaded.
         */
        let src: THREE.DataTexture;
        try {
          src = await new HDRLoader().loadAsync(def.hdri.url);
        } catch (err) {
          failedHdri.set(id, (failedHdri.get(id) ?? 0) + 1);
          hdriFailedAt.set(id, Date.now());
          throw err;
        }
        failedHdri.delete(id); // it CAN be fetched: earlier misses were blips, not the host
        if (disposed || mine !== epoch) {
          src.dispose();
          return;
        }
        src.mapping = THREE.EquirectangularReflectionMapping;
        const tex = pmrem.fromEquirectangular(src).texture;
        // the equirectangular SOURCE is a 1k float texture and is not needed once the mip
        // chain exists — keeping it would hold ~8 MB of GPU memory per environment for nothing
        src.dispose();
        cache.set(id, tex);
        applyHdri(id, tex);
      } catch (err) {
        // the COUNT is recorded at the fetch above, even if a newer pick has landed — that
        // record is about the URL, not about which environment is on screen right now.
        if (disposed || mine !== epoch) return;
        const alt = applyFallback(def, lighting);
        onEvent?.(`Couldn’t load the ${def.name} environment. Using ${alt.name} instead.`);
        // eslint-disable-next-line no-console
        console.warn(`BIOBUZZ 3D: HDRI environment failed to load; using ${alt.id} instead.`, err);
      } finally {
        if (mine === epoch) loading = false;
      }
    },
    refreshBackdrop(hexColor: number): void {
      backdrop.setHex(hexColor);
      // only the room path paints the background with a colour; an HDRI or a painted dome is a
      // texture and `scene.background` already points at it
      if (current === 'room') scene.background = backdrop;
    },
    dispose(): void {
      disposed = true;
      epoch++;
      scene.environment = null;
      scene.background = null;
      for (const tex of cache.values()) tex.dispose();
      cache.clear();
      pmrem.dispose();
    },
  };
}
