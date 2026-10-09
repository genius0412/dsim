/**
 * GRAPHICS SETTINGS — the nineteen dials of `docs/biobuzz/plan-3d.md` §4.4, their five preset
 * columns, and the per-device store that holds them.
 *
 * ── WHY PER DEVICE, AND NOT IN `GameSettings` ──────────────────────────────────────────────
 * The same reason `getViewPref` and `src/theme.ts` are: `GameSettings` syncs to Postgres per
 * ACCOUNT, and a shadow resolution is a fact about the GPU in front of you, not about who you
 * are. A student who practises on a school Chromebook and at home on a desktop must not have
 * the Chromebook's preset follow them home. So: `localStorage['decodesim.graphics']`, the same
 * `decodesim.` prefix, client-only, no React import in this file.
 *
 * ── THE SHAPE, AND WHY THERE ARE THREE FIELDS AND NOT ONE ──────────────────────────────────
 * `{ preset, tier, settings }`.
 *   • `settings` is the truth — nineteen values, and the only thing the renderer ever reads.
 *   • `preset` is what the PICKER shows: one of the five named columns, `auto`, or `custom`
 *     the moment any single setting differs from the column it claims.
 *   • `tier` is one of the five columns ALWAYS, even under `custom`/`auto`, because the PIXEL
 *     BUDGET (§4.4's 0.6 / 1.2 / 2.2 / 4.0 / 8.3 MP) is a property of the preset COLUMN and not of
 *     any one setting — there is no setting it could be derived from. It is the column the
 *     current settings were last branched from, so a player who picks High and then turns
 *     shadows off keeps High's 2.2 MP backbuffer cap, which is what they asked for.
 *
 * Nothing here imports three.js or touches a canvas: this is the MODEL. `scene/renderScene.ts`
 * subscribes and applies; `graphics/auto.ts` writes into it after detection; `ui/
 * GraphicsSection.tsx` renders it. A headless smoke lane can import it with no DOM at all.
 */

// ────────────────────────────────────────────────────────────────────── the nineteen values ──

/**
 * §4.4 row 2 — the draw-loop frame cap, in frames per second, with TWO SENTINELS.
 *
 * It is a plain `number` and not a union of literals because the row is not a fixed ladder:
 * the owner asked for a rate you drag or type (2026-09-19), so any integer in `[GFX_FPS_MIN,
 * GFX_FPS_MAX]` is a legal cap. `coerceMaxFps` below is what keeps that honest — this is the
 * first field in the whole settings object whose value can arrive from a TEXT BOX, so it is
 * the first one that has to reject shapes (`NaN`, `Infinity`, `'60'`, `59.5`) instead of merely
 * choosing between known ones.
 *
 * ── THE TWO SENTINELS, AND WHY THEY ARE NOT "A BIGGER NUMBER" ──────────────────────────────
 *
 * **`0` — VSync.** The draw loop is `requestAnimationFrame` (`src/game.ts`), which the
 * compositor paces at the display's refresh. `0` means "no skip, draw on every frame the
 * browser hands us" — which in a BROWSER is the ceiling, because there is no way to PRESENT
 * more frames than the panel shows. It was called "Display", which is what made it read as a
 * CAP rather than as the absence of one.
 *
 * **`-1` — Unlimited.** Negative is the one thing a frame rate can never be, so it cannot
 * collide with a real rate however the range grows, and it survives `JSON.stringify` exactly
 * (a `null` or a `'unlimited'` string would not survive `Number` coercion anywhere this value
 * is compared). It behaves IDENTICALLY to VSync inside the loop — `frameIntervalMs` returns
 * `0` for both — because the difference is not in the loop at all: it is whether the SHELL has
 * let the compositor run free.
 *
 * ── WHY UNLIMITED IS NO LONGER SHOWN ON THE WEB (owner ruling 2026-09-19) ──────────────────
 * Genuinely exceeding vsync needs Chromium's `disable-frame-rate-limit` and
 * `disable-gpu-vsync`, which only the desktop shell can pass (`electron/main.cjs`), and which
 * must be appended BEFORE `app.whenReady()` — so changing it cannot take effect until the app
 * restarts. Neither switch exists for a web page: a browser tab cannot ask its own compositor
 * for this, at any price. This used to be reason to show the control anyway, captioned
 * `Desktop app only`, on the theory that hiding a control that does something ELSEWHERE is
 * worse than a caption. The owner's report was that seeing "Unlimited" on the web — reading
 * 164 fps on a 165 Hz monitor, indistinguishable from VSync — read as broken, not as a caption
 * nobody had read yet. So the rule this row now follows is the other one this repo already
 * uses elsewhere: **hide what does not apply.** `GraphicsSection.tsx` never renders the word
 * "Unlimited" on the web at all; the row's top stop is labelled "Display rate" there instead —
 * the honest name for "every frame the compositor hands us", which is what `0` always was.
 *
 * ── THE CONTROL IS A SLIDER PLUS A TYPED RATE, NOT A ROW OF TILES ──────────────────────────
 * `GFX_FPS_SLIDER_MAX`/`GFX_FPS_SLIDER_NO_CAP` and `fpsFromSliderPos`/`sliderPosFromFps` below
 * are the slider's own mapping: drag position `[GFX_FPS_MIN, GFX_FPS_SLIDER_MAX]` reads off the
 * number line, and one more stop past it means "no cap" — VSync alone on the web, VSync or
 * Unlimited on the desktop (a second control next to the slider chooses which, only once the
 * slider is already at that stop). The number box beside it still takes the full typed range up
 * to `GFX_FPS_MAX`, for the panels and the budgets past what a drag can aim at precisely.
 */
export type MaxFps = number;

/** `0` — draw every frame the compositor offers, i.e. the display's refresh. */
export const MAX_FPS_VSYNC = 0;
/** `-1` — ask the desktop shell to stop honouring the display's refresh at all. */
export const MAX_FPS_UNLIMITED = -1;

/**
 * The bounds a TYPED rate is clamped into. Both are deliberate, and a value outside them
 * clamps to the bound rather than being dropped — somebody who types 5000 meant "as fast as
 * possible", and answering that by silently reverting to whatever was there tells them nothing.
 *
 *   • **24** — the film rate, and the floor at which this is still a driver-practice sim. The
 *     fixed sim step is 60 Hz; a render cap under 24 means most ticks are never drawn, a shot
 *     cannot be timed by eye, and the player is breaking their own practice rather than tuning
 *     it. It also doubles as the slider's own minimum, so a drag can never reach lower.
 *   • **1000** — past every panel that exists (the fastest shipping displays are under 600 Hz),
 *     so it is already indistinguishable from no cap, and a four-digit box reads as a frame
 *     rate rather than as a budget in some other unit. Anything genuinely uncapped is a
 *     sentinel, which is a different control for a different reason — see `GFX_FPS_SLIDER_MAX`
 *     for why the slider's own numeric span stops well short of this.
 */
export const GFX_FPS_MIN = 24;
export const GFX_FPS_MAX = 1000;

/**
 * The slider's own numeric ceiling, in fps — the highest rate a DRAG can aim at; the box beside
 * it still reaches `GFX_FPS_MAX`. Picked at 360: the fastest class of monitor actually sold
 * today (esports panels top out around there), comfortably past the 240 Hz gaming tier and the
 * 165 Hz panel that started this conversation, while a rate past it (400, 500, a HFR capture
 * rig) is rare enough that aiming a drag at it is harder than typing the number — the box takes
 * anything up to `GFX_FPS_MAX` for exactly that case.
 */
export const GFX_FPS_SLIDER_MAX = 360;

/** one past the slider's numeric ceiling: the drag position that means "no cap" at all — see
 * `fpsFromSliderPos`. Never itself a returned `MaxFps`; it is a position, not a rate. */
export const GFX_FPS_SLIDER_NO_CAP = GFX_FPS_SLIDER_MAX + 1;

/**
 * Drag position → the value to store. Below the ceiling it is the number line, rounded and
 * clamped; AT the ceiling it is "no cap", and which sentinel that means depends on the
 * platform and on what was already selected:
 *   • the web has exactly one way to say "no cap" (`isDesktop` false always yields VSync,
 *     whatever `preferUnlimited` says) — this is the one place that rule is enforced, so the
 *     web can never produce Unlimited by dragging, typing, or any other path through this row;
 *   • the desktop has two, and `preferUnlimited` (the caller passes "is the current value
 *     already Unlimited") is what keeps a drag that merely revisits the top stop from silently
 *     switching Unlimited back to VSync — the platform-specific chooser next to the slider is
 *     the only other way to change which of the two it means.
 */
export function fpsFromSliderPos(pos: number, isDesktop: boolean, preferUnlimited: boolean): MaxFps {
  if (pos >= GFX_FPS_SLIDER_NO_CAP) {
    return isDesktop && preferUnlimited ? MAX_FPS_UNLIMITED : MAX_FPS_VSYNC;
  }
  return Math.max(GFX_FPS_MIN, Math.min(GFX_FPS_SLIDER_MAX, Math.round(pos)));
}

/** the inverse, for drawing the puck: either sentinel is the top stop, and a real rate clamps
 * into the slider's own numeric span — a typed rate past `GFX_FPS_SLIDER_MAX` (up to
 * `GFX_FPS_MAX`) still shows pinned at the right rather than running off the track. */
export function sliderPosFromFps(v: MaxFps): number {
  if (v === MAX_FPS_VSYNC || v === MAX_FPS_UNLIMITED) return GFX_FPS_SLIDER_NO_CAP;
  return Math.max(GFX_FPS_MIN, Math.min(GFX_FPS_SLIDER_MAX, v));
}

/** recognizable round numbers along the slider's span, for its tick marks (`<datalist>` in
 * `GraphicsSection.tsx`) — a shortcut a drag can snap towards, never the domain itself. */
export const GFX_FPS_STEPS: readonly number[] = [30, 60, 120, 144, 240];

/** a positive rate that is not one of the tick marks above — i.e. a typed value with nothing
 * round about it. Kept for the settings that still carry one from before the slider. */
export function isCustomFps(v: MaxFps): boolean {
  return v > 0 && !GFX_FPS_STEPS.includes(v);
}

/**
 * The one coercer in this file that is not an allowlist, because its domain is a RANGE.
 *
 * Order matters: the sentinels are matched FIRST and exactly, so no arithmetic can ever produce
 * one — `-1` and `0` are reachable only by being exactly `-1` and `0`, never by clamping. A
 * negative integer that is not the sentinel is not "a cap below the floor", it is junk of the
 * wrong shape, so it falls back rather than clamping up to 24; clamping it would quietly turn a
 * corrupt value into a working cap the player never chose.
 */
export function coerceMaxFps(v: unknown, fallback: MaxFps): MaxFps {
  if (v === MAX_FPS_VSYNC || v === MAX_FPS_UNLIMITED) return v;
  // `Number.isInteger` is false for NaN, ±Infinity, 59.5 and for anything that is not a number
  // at all, which is the whole junk list in one predicate.
  if (!Number.isInteger(v) || (v as number) < 1) return fallback;
  return Math.min(GFX_FPS_MAX, Math.max(GFX_FPS_MIN, v as number));
}

/**
 * §4.4 row 3. `smaa` IS NOT OFFERED ON THIS BUILD and the type does not carry it — see
 * `GFX_NOT_OFFERED` below for the measurement that decided it. MSAA is real multisampling at
 * the sample count named, done in an offscreen render target rather than through the canvas's
 * own `antialias` context attribute: WebGL gives no way to ASK the default framebuffer for a
 * particular sample count, and the attribute is fixed for the life of the context, so an
 * `antialias`-based implementation could offer neither "2x" nor a live change.
 */
export type AntiAliasing = 'off' | 'msaa2' | 'msaa4';

/**
 * §4.4 row 4 — the sun's shadow map. `soft` is `high` plus a wider VSM blur radius. `max` is
 * Extreme's: a 4096 map, twice the texels per inch of `soft`, with a blur of about the same WORLD
 * width drawn with twice the samples. It is a value of its own rather than a bigger `soft` so an
 * Ultra player's stored `soft` keeps meaning the 2048 map it always did.
 */
export type ShadowQuality = 'off' | 'low' | 'high' | 'soft' | 'max';

/**
 * §4.4 row 5. `real` is the elements' `InstancedMesh` casting into the sun's shadow map (56
 * more casters); `blob` is a flat dark disc under each one, which costs one more instanced
 * draw and no shadow-map work at all; `none` is neither.
 */
export type ElementShadows = 'none' | 'blob' | 'real';

/**
 * §4.4 row 6. `ssao` is screen-space ambient occlusion, drawn by three's GTAO pass in the lazy
 * post-processing chunk (`scene/renderPost.ts`). The stored value keeps the name `ssao` because
 * the type and the store have accepted it since Day 3, when it was reserved and not drawn; a
 * blob written by that build therefore needs no migration, and an older build reading one of
 * ours keeps the value and ignores it.
 */
export type AmbientOcclusion = 'off' | 'ssao';

/** §4.4 row 7 — `texture.anisotropy`, clamped to the GPU's own maximum at apply time. */
export type Anisotropy = 1 | 4 | 8 | 16;

/** §4.4 row 8 — which CAD GLB decimation `buildBiobuzzField` loads (`field.glb` /
 * `field-low.glb`). The ONE setting that cannot be applied without rebuilding the field. */
export type MeshDetail = 'low' | 'high';

/**
 * The SEVENTEENTH row, added 2026-09-21 — which geometry the 56 scoring elements are drawn with.
 *
 *   sphere — a smooth `THREE.SphereGeometry`, 12×8, ~176 triangles
 *   cad    — the perforated CAD solid (`public/models/biobuzz/elements.glb`, 26 bores),
 *            2,286 triangles for a POLLEN and 2,542 for a NECTAR
 *
 * ⚠️ **IT IS NOT `meshDetail`, AND THE REASON IS MEDIUM.** `meshDetail` is already `high` on
 * Medium (it is `low` on Low alone — the RENDER lane pins that), so folding the elements into it
 * would put 100 perforated balls, and on High/Ultra 100 more shadow casters of them, on the
 * tier that exists for a machine that could not hold the frame rate at Medium's own settings.
 * A row of its own is what lets the ladder be sphere / sphere / cad / cad, and it is the same
 * reason `elementShadows` is not folded into `shadows`.
 *
 * Applied LIVE: the asset is fetched once and both geometries are kept, so switching is an
 * assignment. The sphere is also what stands while the fetch is in flight and what stands
 * forever if it fails — `scene/renderElements.ts` never blocks on it.
 */
export type ElementDetail = 'sphere' | 'cad';

/**
 * The NINETEENTH row (2026-09-27, Extreme) — what the surfaces are made of.
 *
 *   standard — the flat-colour `MeshStandardMaterial`s every tier has always drawn
 *   physical  — measured finishes (bare aluminium is a metal, powder coat and plastics are
 *               dielectrics, rubber is rubber), procedural surface detail (foam stipple, powder-
 *               coat orange peel, extrusion lines, roller pips), and a ROOM PROBE: metals and the
 *               polycarbonate reflect the venue that is actually drawn, not the HDRI photograph
 *               the venue geometry hides
 *
 * Owner, 2026-09-27, on the first Extreme: "Adding accurate texture, material, and reflection
 * matters more [than glow]." A row of its own, asked of the SETTINGS like `wantsPost`, so a Custom
 * branched from High can have it. The code lives in a lazy chunk (`scene/renderSurfaces.ts`),
 * fetched the first time it is on. A string and not a boolean so a later step (a baked probe, a
 * downloaded texture set) is a third value rather than a second row.
 */
export type MaterialModel = 'standard' | 'physical';

/**
 * §4.4 row 12 — how much of the cosmetic layer runs.
 *   minimal  — no landing reticle, no rolling spin on the elements, no wheel rotation
 *   standard — reticle + rolling spin + wheels
 *   full     — the above plus the reticle's full arc trace
 */
export type EffectsLevel = 'minimal' | 'standard' | 'full';

/** §4.4 row 14 — `reduced` damps the chase/orbit smoothing and stops the turntable, the same
 * thing `prefers-reduced-motion: reduce` does. The OS preference always wins: a player who has
 * asked their system for less motion gets it whatever this says. */
export type CameraMotion = 'full' | 'reduced';

/**
 * §4.4 row 16 — what the corner read-out prints.
 *
 * ⚠️ **INERT.** The read-out is one display for all three games now, in the React HUD, on
 * `GameSettings.perfDisplay` (`src/ui/PerfHud.tsx`) — a 3D-only row could not carry the ping,
 * and the div it drew sat on top of the event log. `scene/renderStats.ts` publishes its
 * counters instead of drawing, and ignores this value; the picker for it is gone from
 * `GraphicsSection`. The field is still here only because deleting it means editing
 * `renderScene.ts`'s two call sites, which another lane is in this week — take all three out
 * together.
 */
export type PerfOverlay = 'off' | 'fps' | 'full';

/**
 * The environment ids `graphics/environments.ts` defines, repeated here as a TYPE so this module
 * stays the one place the settings SHAPE is written — the other file carries the data, and it
 * imports this, so the dependency only ever points one way.
 *
 * Nine of the eleven are PROCEDURAL (2026-09-21): they are painted, they cost no download, and
 * they are therefore live on every tier including the two where image-based lighting is off.
 * `school-hall` and `monochrome-studio` are the two fetched HDRIs and the only entries that cost
 * bytes; `school-hall` is also what the fixed-High replay export renders in, so it is a
 * CONTRACT, not merely a default (`GFX_PRESETS.high`, and the RENDER lane pins it).
 */
export type EnvironmentId =
  | 'room'
  | 'arena'
  | 'gym'
  | 'workshop'
  | 'overcast'
  | 'sunset'
  | 'night'
  | 'cyc-light'
  | 'cyc-dark'
  | 'school-hall'
  | 'monochrome-studio';

/** the allowlist `coerceGraphicsSettings` checks a stored `environment` against. A removed or
 * misspelled id falls back to the TIER's own column, which is the same field-by-field rule every
 * other row follows — never a reset of the whole object. */
export const ENVIRONMENT_IDS: readonly EnvironmentId[] = [
  'room',
  'arena',
  'gym',
  'workshop',
  'overcast',
  'sunset',
  'night',
  'cyc-light',
  'cyc-dark',
  'school-hall',
  'monochrome-studio',
];

/** THE NINETEEN (§4.4's eighteen rows, Bloom and Materials among them since Extreme, plus `elementDetail`, this build's own). In §4.4's own table order, so the two can be diffed by eye. */
export interface GraphicsSettings {
  /** 50–200 % of CSS pixels, before the tier's pixel budget caps the backbuffer. */
  renderScale: number;
  maxFps: MaxFps;
  aa: AntiAliasing;
  shadows: ShadowQuality;
  elementShadows: ElementShadows;
  ao: AmbientOcclusion;
  anisotropy: Anisotropy;
  meshDetail: MeshDetail;
  elementDetail: ElementDetail;
  materials: MaterialModel;
  environment: EnvironmentId;
  /** image-based lighting: `scene.environment` set, or lights only. */
  envLighting: boolean;
  /** the environment map's SPECULAR contribution on metals (`envMapIntensity`). */
  reflections: boolean;
  /**
   * The EIGHTEENTH row (2026-09-27, Extreme): a glow around the venue's lamps and the brightest
   * glints, drawn by three's UnrealBloom pass in the lazy post-processing chunk. Never a robot part.
   * A boolean, not a strength: the strength, radius and threshold are tuned once for this field
   * (`scene/renderPost.ts`) and a slider would be a way to wash the field out.
   */
  bloom: boolean;
  effects: EffectsLevel;
  /**
   * HORIZONTAL degrees, `GFX_FOV_MIN`–`GFX_FOV_MAX` (60–120, the top being what both human eyes
   * see together — `graphics/fov.ts`). Each camera turns it into a vertical FOV for its own screen:
   * a ceiling on the solved driver camera, the lens of the height-accurate driver eye, and the
   * chase/orbit FOV. Stored as `hfov`; a blob from before 2026-09-24 has a VERTICAL `fov` instead,
   * which `coerceGraphicsSettings` converts once.
   */
  hfov: number;
  cameraMotion: CameraMotion;
  /** the picture-in-picture overhead map in a corner. */
  /**
   * The PiP top-down aid. ⚠️ **OFF ON EVERY PRESET (owner, 2026-09-21).** Low and Medium
   * used to default it ON, on the reasoning that the machines with the hardest-to-read 3D
   * shot are the ones that want a top-down aid. It is still a SECOND FULL PASS over the
   * scene, which is the cost those machines can least afford, and it covers a corner of
   * the field it is meant to help with. It stays a one-click setting for anyone who wants
   * it; it is simply not a thing a new player is given without asking.
   */
  minimap: boolean;
  perfOverlay: PerfOverlay;
}

export type GraphicsTier = 'low' | 'medium' | 'high' | 'ultra' | 'extreme';
export const GFX_TIERS: readonly GraphicsTier[] = ['low', 'medium', 'high', 'ultra', 'extreme'];

/**
 * THE HIGHEST TIER AUTO WILL PICK. Extreme is past it on purpose, for four reasons:
 *   • the warm-up measures CPU submit time (`renderScene.ts`), and Extreme's cost is almost all
 *     GPU fill: a fast Ultra frame says nothing about whether a supersampled frame with two
 *     post passes on it will hold 60 fps;
 *   • after the warm-up only the 25 ms slip moves the tier, so a machine that climbed into
 *     Extreme and landed at 45 fps would stay there for the whole match;
 *   • `firstGuess` cannot tell machines apart at the top (`deviceMemory` caps at 8);
 *   • Extreme downloads a chunk. Auto must not start a download nobody asked for.
 * So Auto stops here, and Extreme is only ever a hand pick. `stepTier` takes this as its ceiling
 * on the way up; `setGraphicsPreset('auto')` clamps to it.
 */
export const GFX_AUTO_MAX_TIER: GraphicsTier = 'ultra';

export type GraphicsPreset = 'auto' | GraphicsTier | 'custom';

/**
 * §4.4's PIXEL BUDGET, in megapixels of BACKBUFFER. The render scale multiplies the device
 * pixel ratio; this caps the product, so a 200 % scale on a 4K panel cannot ask a laptop iGPU
 * for 33 million pixels a frame. Read by `effectivePixelRatio` below, which is the only
 * consumer — the renderer never does this arithmetic itself.
 */
export const GFX_PIXEL_BUDGET: Record<GraphicsTier, number> = {
  low: 0.6e6,
  medium: 1.2e6,
  high: 2.2e6,
  ultra: 4.0e6,
  // a 4K UHD frame (3840 × 2160). Extreme renders at 150 %, so this is what lets a 1080p window
  // supersample at all (1.5² × 2.07 MP = 4.7 MP, past Ultra's 4.0) and is still a ceiling on a
  // HiDPI 4K panel, where 150 % of the device ratio would ask for 18 MP.
  extreme: 8.3e6,
};

/**
 * THE PRESET TABLE — §4.4's five columns, transcribed. If this file and that table ever
 * disagree, the table is right and this is a bug; `scripts/smoke-biobuzz/render.ts` asserts a
 * handful of the load-bearing cells so a silent edit here is caught.
 *
 * Ultra's two hedged cells moved to Extreme when Extreme was added (2026-09-27): AO is on at
 * Extreme alone, and SMAA is not offered at all (`GFX_NOT_OFFERED`) — Extreme supersamples on top
 * of MSAA 4x instead. Ultra's column is otherwise unchanged, so a stored Ultra still reads Ultra.
 */
/** the FOV slider's default, HORIZONTAL degrees — what the old default showed on a 16:9 screen
 * (70° vertical is 102° across), rounded. Declared here, above the presets that read it. */
export const GFX_FOV_DEFAULT = 100;

export const GFX_PRESETS: Record<GraphicsTier, GraphicsSettings> = {
  low: {
    renderScale: 75,
    maxFps: 60,
    aa: 'off',
    shadows: 'off',
    elementShadows: 'none',
    ao: 'off',
    anisotropy: 1,
    meshDetail: 'low',
    elementDetail: 'sphere',
    materials: 'standard',
    environment: 'room',
    envLighting: false,
    reflections: false,
    bloom: false,
    effects: 'minimal',
    hfov: GFX_FOV_DEFAULT,
    cameraMotion: 'reduced',
    minimap: false,
    perfOverlay: 'off',
  },
  medium: {
    renderScale: 100,
    maxFps: 0,
    aa: 'msaa2',
    shadows: 'low',
    elementShadows: 'blob',
    ao: 'off',
    anisotropy: 4,
    meshDetail: 'high',
    elementDetail: 'sphere',
    materials: 'standard',
    environment: 'room',
    envLighting: false,
    reflections: false,
    bloom: false,
    effects: 'standard',
    hfov: GFX_FOV_DEFAULT,
    cameraMotion: 'full',
    minimap: false,
    perfOverlay: 'off',
  },
  high: {
    renderScale: 100,
    maxFps: 0,
    aa: 'msaa4',
    shadows: 'high',
    elementShadows: 'real',
    ao: 'off',
    anisotropy: 8,
    meshDetail: 'high',
    elementDetail: 'cad',
    materials: 'standard',
    environment: 'school-hall',
    envLighting: true,
    reflections: true,
    bloom: false,
    effects: 'standard',
    hfov: GFX_FOV_DEFAULT,
    cameraMotion: 'full',
    minimap: false,
    perfOverlay: 'off',
  },
  ultra: {
    renderScale: 100,
    maxFps: 0,
    aa: 'msaa4',
    shadows: 'soft',
    elementShadows: 'real',
    ao: 'off',
    anisotropy: 16,
    meshDetail: 'high',
    elementDetail: 'cad',
    materials: 'standard',
    environment: 'school-hall',
    envLighting: true,
    reflections: true,
    bloom: false,
    effects: 'full',
    hfov: GFX_FOV_DEFAULT,
    cameraMotion: 'full',
    minimap: false,
    perfOverlay: 'off',
  },
  extreme: {
    // SUPERSAMPLED: 150 % of the device ratio, capped by the 8.3 MP budget above. On the thin
    // straight edges this field is made of (tape, frame rails, the seam teeth) that is the one
    // AA step past MSAA 4x that is visible, and it is why SMAA is still not offered.
    renderScale: 150,
    maxFps: 0,
    aa: 'msaa4',
    shadows: 'max',
    elementShadows: 'real',
    ao: 'ssao',
    anisotropy: 16,
    meshDetail: 'high',
    elementDetail: 'cad',
    materials: 'physical',
    environment: 'school-hall',
    envLighting: true,
    reflections: true,
    // OFF, not on (owner, 2026-09-27): the Extreme budget goes to what surfaces ARE, not to glow.
    // Bloom stays a switch for anyone who wants the lamps to flare.
    bloom: false,
    effects: 'full',
    hfov: GFX_FOV_DEFAULT,
    cameraMotion: 'full',
    minimap: false,
    perfOverlay: 'off',
  },
};

/**
 * THE ROW OF §4.4 THIS BUILD DOES NOT OFFER, with the reason it is refused rather than shipped
 * as a switch that does nothing. Rendered verbatim by the Graphics section, so the answer to
 * "where is SMAA?" is on the screen that would have had it.
 *
 * There were two until Extreme (2026-09-27). Ambient occlusion is offered now: the post passes
 * live in their own lazy chunk (`scene/renderPost.ts`), fetched only when AO or bloom is on, so
 * the reason it was refused (the renderer chunk's download budget) no longer applies to it.
 *
 *   • SMAA — `SMAAPass.js` is 38 KB gzipped on its own, almost all of it two base64 lookup
 *     TEXTURES, which are already-encoded data and do not compress. That would quadruple the
 *     post chunk (12 KB) for a second antialiasing pass on top of MSAA 4x, on the column (Extreme) that
 *     already supersamples at 150 %, which is sharper on this field's thin straight edges than
 *     either.
 *
 * A list and not a single object so a later refusal drops in without a UI change; the section
 * renders nothing at all when the list is empty.
 */
export const GFX_NOT_OFFERED: readonly { label: string; why: string }[] = [
  {
    label: 'SMAA',
    why: 'Extreme already renders at 150% on top of MSAA 4×, which is sharper on this field’s thin edges, and SMAA would quadruple the download the effects need',
  },
];

// ────────────────────────────────────────────────────────────────────────────── the store ──

import { GRAPHICS_KEY } from '../../../storageKeys';
import { HUMAN_BINOCULAR_HFOV_DEG, hFovFromV } from './fov';
import { desktop } from '../../../desktop';

export interface GraphicsState {
  preset: GraphicsPreset;
  /** always one of the five columns — see this file's header on why it is not derived. */
  tier: GraphicsTier;
  settings: GraphicsSettings;
}

/** what a device that has never opened this screen gets, before `graphics/auto.ts` has run.
 * MEDIUM, not High: the first frame is drawn before detection finishes, and the cost of
 * guessing low on a fast machine is two seconds of a slightly plainer picture, while the cost
 * of guessing high on a slow one is two seconds of a slideshow. */
export const GFX_DEFAULT_TIER: GraphicsTier = 'medium';

function presetState(tier: GraphicsTier, preset: GraphicsPreset = tier): GraphicsState {
  return { preset, tier, settings: { ...GFX_PRESETS[tier] } };
}

/**
 * FIELD-BY-FIELD COERCION, the same discipline `src/settings.ts` applies to `GameSettings`:
 * every value is checked against its own allowlist and a bad one falls back to the tier's,
 * never to a default for the whole object. A stored blob written by an older build (fifteen
 * settings, or an `aa: 'smaa'` from a build that offered it) therefore keeps the ones it
 * still understands instead of resetting the lot.
 */
const oneOf = <T>(allowed: readonly T[], v: unknown, fallback: T): T =>
  (allowed as readonly unknown[]).includes(v) ? (v as T) : fallback;

const clampNum = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback;

export const GFX_RENDER_SCALE_MIN = 50;
export const GFX_RENDER_SCALE_MAX = 200;
export const GFX_FOV_MIN = 60;
export const GFX_FOV_MAX = HUMAN_BINOCULAR_HFOV_DEG;

/**
 * A blob from before the slider went horizontal carries `fov`, VERTICAL degrees (60–90). Read it
 * as what it showed on a 16:9 screen, the common case, and map the old default (70) onto the new
 * one so an untouched preset still reads as that preset rather than as "Custom".
 */
function legacyHfov(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  if (Math.round(v) === 70) return GFX_FOV_DEFAULT;
  return hFovFromV(Math.min(90, Math.max(60, v)), 16 / 9);
}

export function coerceGraphicsSettings(raw: unknown, base: GraphicsSettings): GraphicsSettings {
  const o = (raw ?? {}) as Partial<Record<keyof GraphicsSettings, unknown>>;
  return {
    renderScale: clampNum(o.renderScale, GFX_RENDER_SCALE_MIN, GFX_RENDER_SCALE_MAX, base.renderScale),
    maxFps: coerceMaxFps(o.maxFps, base.maxFps),
    aa: oneOf<AntiAliasing>(['off', 'msaa2', 'msaa4'], o.aa, base.aa),
    shadows: oneOf<ShadowQuality>(['off', 'low', 'high', 'soft', 'max'], o.shadows, base.shadows),
    elementShadows: oneOf<ElementShadows>(['none', 'blob', 'real'], o.elementShadows, base.elementShadows),
    ao: oneOf<AmbientOcclusion>(['off', 'ssao'], o.ao, base.ao),
    anisotropy: oneOf<Anisotropy>([1, 4, 8, 16], o.anisotropy, base.anisotropy),
    meshDetail: oneOf<MeshDetail>(['low', 'high'], o.meshDetail, base.meshDetail),
    elementDetail: oneOf<ElementDetail>(['sphere', 'cad'], o.elementDetail, base.elementDetail),
    materials: oneOf<MaterialModel>(['standard', 'physical'], o.materials, base.materials),
    environment: oneOf<EnvironmentId>(ENVIRONMENT_IDS, o.environment, base.environment),
    envLighting: typeof o.envLighting === 'boolean' ? o.envLighting : base.envLighting,
    reflections: typeof o.reflections === 'boolean' ? o.reflections : base.reflections,
    bloom: typeof o.bloom === 'boolean' ? o.bloom : base.bloom,
    effects: oneOf<EffectsLevel>(['minimal', 'standard', 'full'], o.effects, base.effects),
    hfov: clampNum(o.hfov ?? legacyHfov((o as { fov?: unknown }).fov), GFX_FOV_MIN, GFX_FOV_MAX, base.hfov),
    cameraMotion: oneOf<CameraMotion>(['full', 'reduced'], o.cameraMotion, base.cameraMotion),
    minimap: typeof o.minimap === 'boolean' ? o.minimap : base.minimap,
    perfOverlay: oneOf<PerfOverlay>(['off', 'fps', 'full'], o.perfOverlay, base.perfOverlay),
  };
}

/** every setting equal to the tier's column? — what decides `custom` vs a named preset. */
export function matchesPreset(settings: GraphicsSettings, tier: GraphicsTier): boolean {
  const p = GFX_PRESETS[tier];
  return (Object.keys(p) as (keyof GraphicsSettings)[]).every((k) => settings[k] === p[k]);
}

/**
 * Every value `preset` may hold, DERIVED from `GFX_TIERS`. It was a literal list once, and a
 * literal list type-checks with a tier missing from it: a stored Extreme would have read back as
 * `auto`, and detection would then have walked the player off the tier they picked on every
 * reload, with nothing failing anywhere.
 */
export const GFX_PRESETS_ALL: readonly GraphicsPreset[] = ['auto', ...GFX_TIERS, 'custom'];

/** a stored blob → a state this build can run. Exported so the smoke lane can round-trip every
 * preset through it (the literal-list bug above is exactly the kind a round trip catches). */
export function coerceGraphicsState(raw: unknown): GraphicsState {
  const o = (raw ?? {}) as { preset?: unknown; tier?: unknown; settings?: unknown };
  const tier = oneOf<GraphicsTier>(GFX_TIERS, o.tier, GFX_DEFAULT_TIER);
  const settings = coerceGraphicsSettings(o.settings, GFX_PRESETS[tier]);
  let preset = oneOf<GraphicsPreset>(GFX_PRESETS_ALL, o.preset, 'auto');
  // A STORED PRESET NAME IS A CLAIM, NOT A FACT. If the settings under it no longer match the
  // column — an older build wrote a row this one coerced, or a column moved between releases —
  // the honest label is `custom`, because that is what the picker would otherwise lie about.
  if (preset !== 'custom' && preset !== 'auto' && !matchesPreset(settings, preset)) preset = 'custom';
  return { preset, tier, settings };
}

/** the live state, read synchronously by the scene on every settings change. Loaded once, on
 * first access, and never re-read from storage (this tab owns it; see `subscribeGraphics`). */
let state: GraphicsState | null = null;

export function getGraphics(): GraphicsState {
  if (state) return state;
  try {
    const raw = localStorage.getItem(GRAPHICS_KEY);
    state = raw ? coerceGraphicsState(JSON.parse(raw)) : presetState(GFX_DEFAULT_TIER, 'auto');
  } catch {
    // corrupt JSON, private browsing, a locked-down profile — the default is always available
    state = presetState(GFX_DEFAULT_TIER, 'auto');
  }
  return state;
}

/** just the nineteen — the shape every renderer call site actually wants. */
export function getGraphicsSettings(): GraphicsSettings {
  return getGraphics().settings;
}

type GraphicsListener = (state: GraphicsState) => void;
const listeners = new Set<GraphicsListener>();

/**
 * Subscribe to any change made through this module IN THIS TAB. Same rule as `subscribeViewPref`
 * and for the same reason: no `storage`-event relay, because a second tab lowering its own
 * shadows must not restyle the match someone is driving in this one.
 */
export function subscribeGraphics(fn: GraphicsListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * KEEP THE DESKTOP SHELL'S PREFERENCE IN STEP WITH THIS ONE.
 *
 * Unlimited is TWO stores: the graphics setting lives here, in `localStorage`, and the
 * Chromium switches live in the main process, in `userData`, because they have to be appended
 * before the app is ready. This is the seam between them, and it is here — inside `commit` —
 * rather than in the picker, because `maxFps` has three other writers: `setGraphicsPreset`,
 * `setGraphicsTier` (which `graphics/auto.ts` calls after detection) and `resetGraphicsToAuto`.
 * A player who picks Unlimited and then drops to Low has NOT asked to keep running with vsync
 * disabled, and a sync that only ran in the picker would leave them there forever.
 *
 * Fire-and-forget, and swallowed: an older desktop shell has no `perf` bridge at all (the app
 * loads the LIVE site, so a new client inside last month's shell is the ordinary case, not an
 * edge one), and a failed IPC must not lose the pick the player just made. The renderer's value
 * is the intent; `GraphicsSection` reconciles the two on mount and reports any disagreement.
 */
function syncDesktopUnlimited(prev: MaxFps | null, next: MaxFps): void {
  const wantOn = next === MAX_FPS_UNLIMITED;
  if (prev !== null && wantOn === (prev === MAX_FPS_UNLIMITED)) return;
  desktop()?.perf?.setUnlimitedFps(wantOn).catch(() => {});
}

function commit(next: GraphicsState): void {
  const prev = state;
  state = next;
  try {
    localStorage.setItem(GRAPHICS_KEY, JSON.stringify(next));
  } catch {
    /* non-fatal: the pick still applies for this session */
  }
  syncDesktopUnlimited(prev ? prev.settings.maxFps : null, next.settings.maxFps);
  for (const fn of listeners) fn(next);
}

/** the lower of two tiers, by `GFX_TIERS` order. */
function minTier(a: GraphicsTier, b: GraphicsTier): GraphicsTier {
  return GFX_TIERS.indexOf(a) <= GFX_TIERS.indexOf(b) ? a : b;
}

/** pick a named column (or `auto`, which `graphics/auto.ts` then resolves into a tier). */
export function setGraphicsPreset(preset: GraphicsPreset): void {
  if (preset === 'custom') return; // `custom` is a CONSEQUENCE of editing a setting, never a pick
  const cur = getGraphics();
  // Auto keeps the tier it is on until detection runs, but never above its own ceiling: picking
  // Auto while on Extreme must not leave "Auto" sitting on a tier Auto would never choose.
  const tier = preset === 'auto' ? minTier(cur.tier, GFX_AUTO_MAX_TIER) : preset;
  commit({ preset, tier, settings: { ...GFX_PRESETS[tier] } });
}

/**
 * Write the tier AUTO decided. `keepAuto` is what separates the two callers: the detector and
 * the warm-up are still "Auto" and must stay labelled that way, while a player who has picked
 * a column by hand is not moved by anything.
 */
export function setGraphicsTier(tier: GraphicsTier, keepAuto: boolean): void {
  commit({ preset: keepAuto ? 'auto' : tier, tier, settings: { ...GFX_PRESETS[tier] } });
}

/** change ONE setting. The preset becomes `custom` unless the result happens to land exactly
 * back on a column, in which case it is honestly named again. */
export function setGraphicsSetting<K extends keyof GraphicsSettings>(key: K, value: GraphicsSettings[K]): void {
  const cur = getGraphics();
  const settings = { ...cur.settings, [key]: value };
  const named = GFX_TIERS.find((t) => matchesPreset(settings, t));
  commit({ preset: named ?? 'custom', tier: named ?? cur.tier, settings });
}

/** forget everything and let detection decide again (§4.4's "Reset to Auto" button). The
 * caller re-runs `graphics/auto.ts`; this only clears the stored opinion. */
export function resetGraphicsToAuto(): void {
  commit(presetState(GFX_DEFAULT_TIER, 'auto'));
}

// ───────────────────────────────────────────────────────────────────── derived, for the scene ──

/**
 * The BACKBUFFER pixel ratio for a canvas of `cssW × cssH`: the device ratio scaled by the
 * player's render scale, then capped so `cssW·cssH·r²` stays inside the tier's pixel budget.
 *
 * Returned as a RATIO rather than a size because that is what `WebGLRenderer.setPixelRatio`
 * and a render target's own sizing both take, and because the cap has to be recomputed on
 * every resize — a window dragged from a quarter of a 4K screen to full screen quadruples the
 * pixel count at an unchanged setting.
 */
export function effectivePixelRatio(
  settings: GraphicsSettings,
  tier: GraphicsTier,
  cssW: number,
  cssH: number,
  devicePixelRatio: number,
): number {
  const w = Math.max(1, cssW);
  const h = Math.max(1, cssH);
  const wanted = Math.max(0.1, devicePixelRatio * (settings.renderScale / 100));
  const cap = Math.sqrt(GFX_PIXEL_BUDGET[tier] / (w * h));
  return Math.max(0.3, Math.min(wanted, cap));
}

/** the sun shadow map's square resolution for a quality level; `off` has no map at all (the
 * 1024 it returns is never allocated). Every value is spelled out, so a new level cannot fall
 * through to someone else's size. */
export function shadowMapSize(q: ShadowQuality): number {
  switch (q) {
    case 'max':
      return 4096;
    case 'high':
    case 'soft':
      return 2048;
    case 'low':
    case 'off':
      return 1024;
  }
}

/** VSM blur radius in shadow-map texels. `soft` is the same 2048 map with a wider kernel —
 * which is what makes it a separate row from `high` rather than a fourth resolution. `max`'s 10
 * texels at 4096 is 0.44 in, a little under `soft`'s 0.53: the same soft edge, drawn finer. */
export function shadowBlurRadius(q: ShadowQuality): number {
  return q === 'max' ? 10 : q === 'soft' ? 6 : 3;
}

/** VSM blur taps (`shadow.blurSamples`; three's default is 8). A 10-texel radius sampled 8
 * times bands visibly, so `max` takes 16. */
export function shadowBlurSamples(q: ShadowQuality): number {
  return q === 'max' ? 16 : 8;
}

/**
 * Does this set of settings need the POST-PROCESSING chunk (`scene/renderPost.ts`)? The one
 * predicate the renderer asks, and it asks the SETTINGS, never the tier: a Custom preset branched
 * from High with AO turned on must get AO, or the row is a switch that does nothing.
 */
export function wantsPost(s: GraphicsSettings): boolean {
  return s.ao !== 'off' || s.bloom;
}

/** Does this set of settings need the SURFACES chunk (`scene/renderSurfaces.ts`: physical
 * materials, procedural surface detail, the room probe)? Asked of the settings, like `wantsPost`. */
export function wantsSurfaces(s: GraphicsSettings): boolean {
  return s.materials === 'physical';
}

/**
 * WHERE A LOST WEBGL CONTEXT LEAVES THE STORED PRESET: the tier to drop to, or `null` to leave it.
 *
 * A GPU that cannot hold Extreme-class settings (the post chain's targets, the 4096 shadow map,
 * Extreme's 8.3 MP budget at a render scale past 100 %) loses the context, the scene falls back to 2D, and the next reload
 * brings the same settings back and loses it again. So a state carrying any of them drops to
 * its own column with them gone: Extreme to Ultra, a Custom to the column it branched from
 * (never ABOVE Ultra, and never above where it was). It asks the SETTINGS, like `wantsPost`: a
 * Custom branched from Ultra with AO and Max shadows turned on is exactly as heavy as Extreme,
 * and a Custom branched from Extreme with all three turned back off is not heavy at all, so a
 * driver reset must not cost that player their FOV and frame cap.
 */
export function contextLossTier(g: GraphicsState): GraphicsTier | null {
  const s = g.settings;
  // Extreme's budget only costs memory when something asks past 100 % of the device ratio
  const bigBackbuffer = g.tier === 'extreme' && s.renderScale > 100;
  if (!wantsPost(s) && s.shadows !== 'max' && !bigBackbuffer) return null;
  return minTier(g.tier, GFX_AUTO_MAX_TIER);
}

/** how many multisamples a render target needs for `aa`; 0 means render straight to the
 * canvas with no intermediate target at all. */
export function msaaSamples(aa: AntiAliasing): number {
  return aa === 'msaa2' ? 2 : aa === 'msaa4' ? 4 : 0;
}

/**
 * The minimum wall-clock gap between two rendered frames, in ms; `0` is uncapped.
 *
 * BOTH SENTINELS RETURN 0, and that is the point: in the loop, Unlimited and VSync are the
 * same instruction — skip nothing. Whether the frames that instruction produces are actually
 * presented faster is decided by the shell, before this process had a draw loop at all.
 */
export function frameIntervalMs(fps: MaxFps): number {
  // 0.5 ms of slack: a 60 Hz display's rAF lands at 16.66 ms and a hard `>= 16.666` compare
  // drops every other frame to 30 fps, which is the classic way a frame cap makes things worse.
  return fps > 0 ? 1000 / fps - 0.5 : 0;
}

/** the human label for a preset, for the picker and for an event-log line. */
export const GFX_PRESET_LABEL: Record<GraphicsPreset, string> = {
  auto: 'Auto',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  ultra: 'Ultra',
  extreme: 'Extreme',
  custom: 'Custom',
};
