/**
 * AUTO — what this machine can draw, decided in two steps (`docs/biobuzz/plan-3d.md` §4.6).
 *
 *   1. A FIRST GUESS from what the browser will tell us for free: the WebGL renderer string,
 *      the WebGPU adapter's info where it exists, device memory, core count and the device
 *      pixel ratio. Cheap, instant, and wrong often enough that it is only ever a starting
 *      point — a renderer string is a marketing name, and "Apple M2" and "Intel UHD 620" are
 *      the same kind of string with a 10× difference behind them.
 *   2. A TWO-SECOND WARM-UP on the real scene, which is a measurement and therefore the one
 *      that decides. p95 frame time over the warm-up window moves the preset one step down if
 *      it is over 16.7 ms (the 60 Hz budget) or one step up if it is under 6 ms.
 *
 * ...and then a THIRD thing, which is not detection at all: the SLIP RULE. A machine that
 * warmed up fine can still fall over when the match fills up with 56 elements and four robots,
 * so a sustained p95 over 25 ms lowers the preset ONE step, once, and says so in the event log.
 * Once, because a rule that keeps stepping down turns a two-second hiccup into Low.
 *
 * ...and, since 2026-10-10, the EXTREME TRIAL (owner: "Extreme should be able to be picked by
 * auto"). Neither step above can see Extreme's cost, which is GPU fill, so Auto reaches Extreme
 * only by measuring Extreme itself: a device whose warm-up lands on Ultra runs a 2 s Ultra
 * BASELINE, and if that has headroom it switches to Extreme and, once the scene reports its chunks
 * loaded and its programs compiled, measures 3 s of real frames. GPU time where the browser can
 * time it (`scene/renderGpuTimer.ts`), the fraction of LATE frames against the display's own
 * period everywhere, CPU time as always. The verdict is stored per GPU in the graphics blob
 * (`ExtremeTrial`), and the EXTREME GUARD then watches the same numbers for as long as the device
 * stays there. The constants above `createQualityGovernor` carry the numbers and why.
 *
 * NO THREE.JS HERE. The scene owns frame times and feeds them in; this module owns the policy.
 * That is what lets `scripts/smoke-biobuzz/render.ts` check the policy without a GPU.
 */

import {
  GFX_TIERS,
  GFX_AUTO_MAX_TIER,
  GFX_AUTO_STEP_MAX_TIER,
  GFX_PRESET_LABEL,
  extremeTrialFor,
  getGraphics,
  setGraphicsTier,
  type ExtremeTrial,
  type GraphicsState,
  type GraphicsTier,
} from './settings';

/** one line for `world.events`/the console — the scene has no access to `world.events`, so it
 * is handed out through `SceneOptions.onQualityEvent` and routed by the host. */
export type QualityEvent = (line: string) => void;

// ───────────────────────────────────────────────────────────────────────── the first guess ──

export interface GpuProbe {
  /** `WEBGL_debug_renderer_info`'s UNMASKED_RENDERER_WEBGL, or '' where the extension is
   * withheld (Firefox with `privacy.resistFingerprinting`, some locked-down enterprise
   * profiles). An empty string is not a failure — it just means step 2 does all the work. */
  renderer: string;
  vendor: string;
  /** a WebGPU adapter's own vendor/architecture, where `navigator.gpu` exists. Filled
   * asynchronously, so it is absent on the first synchronous probe. */
  adapter: string;
  /** `navigator.deviceMemory` in GB, 0 when not reported (Safari, Firefox). */
  memoryGb: number;
  cores: number;
  dpr: number;
  /** does a WebGL2 context come back at all? False selects the 2D view outright. */
  webgl2: boolean;
  /** SwiftShader / llvmpipe / Microsoft Basic Render Driver — a CPU rasteriser pretending to
   * be a GPU. 3D is not playable on one and §4.6 says to take the 2D view instead. */
  software: boolean;
}

/** the renderer strings that mean "there is no GPU behind this". Matched case-insensitively
 * against the renderer AND the vendor, because which of the two carries the name differs by
 * browser. */
const SOFTWARE_RX = /swiftshader|llvmpipe|softpipe|basic render|software rasterizer|microsoft basic|mesa offscreen/i;

/** discrete-GPU families. Deliberately a short list of the names that actually appear in a
 * renderer string, not a database: anything unrecognised falls to the integrated guess, which
 * is the one the warm-up corrects fastest in both directions. */
const DISCRETE_RX = /nvidia|geforce|rtx|gtx|quadro|radeon (rx|pro)|\brx \d{3,4}\b|arc a\d{3}|apple m[1-9]/i;

/** integrated parts, named so an "Intel(R) Iris(R) Xe" does not fall through to "unknown". */
const INTEGRATED_RX = /intel|iris|uhd graphics|hd graphics|vega \d| radeon\(tm\) graphics|adreno|mali|powervr|apple gpu/i;

/** a phone or tablet, by the same coarse-pointer query the rest of the app uses. */
function coarsePointer(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

/**
 * Probe SYNCHRONOUSLY, on a throwaway canvas that is never attached to the document.
 *
 * ⚠️ It creates a real WebGL2 context, so it is not free — call it ONCE and keep the result.
 * `loseContext()` at the end returns the GPU resources immediately rather than at the next GC,
 * which matters on a machine with a small context limit (Chrome caps concurrent WebGL contexts
 * per page, and a probe that leaked one would eventually cost the scene its own).
 */
export function probeGpu(): GpuProbe {
  const out: GpuProbe = {
    renderer: '',
    vendor: '',
    adapter: '',
    memoryGb: 0,
    cores: 0,
    dpr: 1,
    webgl2: false,
    software: false,
  };
  try {
    const nav = navigator as Navigator & { deviceMemory?: number };
    out.memoryGb = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : 0;
    out.cores = typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : 0;
    out.dpr = window.devicePixelRatio || 1;
  } catch {
    /* a non-DOM host (a smoke lane) keeps the zeros */
  }
  try {
    const canvas = document.createElement('canvas');
    // the SAME power preference the real renderer asks for (§4.6), so a dual-GPU laptop probes
    // the chip it will actually draw on rather than the one it idles on
    const gl = canvas.getContext('webgl2', { powerPreference: 'high-performance' }) as WebGL2RenderingContext | null;
    if (gl) {
      out.webgl2 = true;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) {
        out.renderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '');
        out.vendor = String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) ?? '');
      }
      // the unmasked strings are the informative ones, but the masked pair still catches
      // SwiftShader, which names itself in both
      if (!out.renderer) out.renderer = String(gl.getParameter(gl.RENDERER) ?? '');
      if (!out.vendor) out.vendor = String(gl.getParameter(gl.VENDOR) ?? '');
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    /* context creation threw — `webgl2` stays false, which is the answer */
  }
  out.software = SOFTWARE_RX.test(`${out.renderer} ${out.vendor}`);
  return out;
}

/**
 * The WebGPU adapter's own description, where the browser has one. Asynchronous and entirely
 * optional: it is a SECOND opinion on the same GPU, useful because `adapter.info.architecture`
 * is a real architecture name (`rdna-3`, `apple-m`) rather than a marketing string, and because
 * a browser that withholds `WEBGL_debug_renderer_info` sometimes still answers this.
 *
 * Never awaited by anything on the critical path — the first guess is made without it and
 * refined if it arrives.
 */
export async function probeAdapter(): Promise<string> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu) return '';
    const adapter = (await gpu.requestAdapter()) as { info?: Record<string, string> } | null;
    const info = adapter?.info;
    if (!info) return '';
    return [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' ');
  } catch {
    return '';
  }
}

/**
 * §4.6's own rule, in order: "integrated GPU → Medium, discrete → High, phone → Low", with the
 * memory/core/DPR terms as the tie-breakers the plan asks them to be.
 *
 * A PHONE IS CHECKED FIRST and wins outright. A modern phone's GPU string looks discrete-ish
 * (`Apple GPU`, `Adreno 750`) and its core count looks like a desktop's, but it is drawing into
 * a 3× backbuffer on a thermal budget measured in single-digit watts, and §4.4 gives Low a
 * 0.6 MP cap precisely for that.
 */
export function firstGuess(p: GpuProbe, adapter = ''): GraphicsTier {
  if (!p.webgl2 || p.software) return 'low';
  if (coarsePointer()) return 'low';
  const text = `${p.renderer} ${p.vendor} ${adapter}`;
  if (DISCRETE_RX.test(text)) {
    // a discrete part with plenty of memory and cores behind it can start at Ultra rather than
    // spend its warm-up climbing there one step at a time
    return p.memoryGb >= 8 && p.cores >= 8 ? 'ultra' : 'high';
  }
  if (INTEGRATED_RX.test(text)) {
    // an integrated GPU pushing a HiDPI panel is doing 4× the work of one pushing 1080p, and
    // that is exactly the case the pixel budget exists for — start it a step lower
    return p.dpr > 1.5 || p.cores <= 4 ? 'low' : 'medium';
  }
  // NOTHING RECOGNISED — the common case on a browser that withholds the renderer string.
  // Medium, and let the two-second measurement do the work.
  return p.cores >= 8 && p.memoryGb >= 8 ? 'high' : 'medium';
}

/**
 * One step along `GFX_TIERS`, clamped at both ends. A step UP also stops at `max`, which is how
 * the warm-up is kept below Extreme (`GFX_AUTO_STEP_MAX_TIER`). An up-step from a tier already past
 * `max` stays where it is rather than walking DOWN to it: the ceiling says how far Auto may climb,
 * not where a hand pick has to be.
 *
 * ⚠️ It walks the whole `GFX_TIERS` and clamps by index. Stepping through a FILTERED list instead
 * would put Extreme at index -1, and a slip from it would clamp to index 0: Low.
 */
export function stepTier(
  tier: GraphicsTier,
  dir: 1 | -1,
  max: GraphicsTier = GFX_TIERS[GFX_TIERS.length - 1],
): GraphicsTier {
  const i = GFX_TIERS.indexOf(tier);
  if (dir > 0) {
    const top = GFX_TIERS.indexOf(max);
    return i >= top ? tier : GFX_TIERS[i + 1];
  }
  return GFX_TIERS[Math.max(0, i - 1)];
}

/**
 * Run detection and store the result — but ONLY when the player is still on `auto`. Somebody
 * who has picked Ultra by hand has said what they want, and a detector that overrode it would
 * be a bug report about the setting not sticking.
 *
 * Returns the tier in force afterwards (detected or chosen), so the caller can log it.
 */
export function applyFirstGuess(probe: GpuProbe, adapter: string, onEvent?: QualityEvent): GraphicsTier {
  const cur = getGraphics();
  if (cur.preset !== 'auto') return cur.tier;
  // A STORED PASS ON THIS GPU IS A MEASUREMENT, and it outranks a guess: the device starts on
  // Extreme and the Extreme guard watches it from there. `firstGuess` itself never says Extreme.
  const tier: GraphicsTier = extremeTrialFor(cur, probe.renderer)?.pass ? GFX_AUTO_MAX_TIER : firstGuess(probe, adapter);
  if (tier !== cur.tier) {
    setGraphicsTier(tier, true);
    onEvent?.(`Graphics: ${GFX_PRESET_LABEL[tier]} (auto)`);
  }
  return tier;
}

// ──────────────────────────────────────────────────────────────── the warm-up and the slip ──

/** §4.6's thresholds, named so the numbers in the doc and the numbers in the code are the same
 * three numbers. */
export const WARMUP_MS = 2000;
/** over the 60 Hz budget ⇒ one step down. */
export const WARMUP_DOWN_MS = 16.7;
/** comfortably inside it ⇒ one step up. */
export const WARMUP_UP_MS = 6;
/** a sustained p95 at or past this IN A MATCH lowers the preset once. */
export const SLIP_MS = 25;
/** how long the slip has to last. Two seconds of 25 ms is a machine that cannot keep up; a
 * quarter of a second of it is a garbage collection or a texture upload, and lowering the
 * preset for one of those would make the setting feel haunted. */
export const SLIP_WINDOW_MS = 3000;
/**
 * ⚠️ A GAP THIS LONG BETWEEN TWO FRAMES IS NOT A SLOW FRAME — IT IS A TAB THAT WAS NOT BEING
 * DRAWN, and the sample is thrown away rather than recorded.
 *
 * `requestAnimationFrame` stops firing in a backgrounded tab (and is throttled behind a modal,
 * during a long main-thread task, or in an automated browser that only paints when something
 * asks it to), but the monotonic clock (`performance` dot `now`) keeps running. Without this guard the first frame after
 * an alt-tab measures the whole time away, the rolling p95 goes straight past 25 ms, and a
 * player who checked their email comes back to a lowered preset and no idea why. FOUND EXACTLY
 * THAT WAY: driving the live scene from an automated browser, where a frame only renders when a
 * screenshot forces a paint, walked Medium down to Low inside five seconds.
 *
 * 500 ms is well past any frame a human would sit through (that is 2 fps) and well inside the
 * one-second tick a throttled background tab gets.
 */
export const STALL_MS = 500;

/** p95 of `samples` (already an array of frame times in ms). Nearest-rank, on a COPY — the
 * caller's ring buffer must not be reordered under it. */
export function p95(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[Math.max(0, idx)];
}

/** the `q` quantile of `samples`, nearest-rank, on a copy (same rules as `p95`). */
export function quantile(samples: readonly number[], q: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))];
}

/** the median, for the baseline's display period. */
export function median(samples: readonly number[]): number {
  return quantile(samples, 0.5);
}

// ──────────────────────────────────────────────────────────────────────── the Extreme trial ──
//
// The warm-up cannot see Extreme's cost: it times the CPU's half of a frame, and Extreme's
// extra work is GPU fill. So Auto reaches Extreme only by drawing it and measuring the result,
// with the two numbers that can see a GPU-bound frame: GPU time where the browser will time the
// GPU (`scene/renderGpuTimer.ts`, `EXT_disjoint_timer_query_webgl2`), and LATE FRAMES everywhere.
//
// ⚠️ A LATE-FRAME FRACTION IS NOT THE FRAME PERIOD THE WARM-UP REFUSED TO USE. On a vsync-locked
// display the period of a healthy frame IS the refresh, so a p95 of it against 16.7 ms says
// nothing (it sits at 16.7 on every machine that keeps up). Counting the frames whose period is
// well past the display's OWN period, measured on Ultra first, does not have that problem: a
// frame that missed its vsync shows up as a period of two refreshes, on any panel.

/** the Ultra BASELINE a trial is entered from: the warm-up's own two seconds, run again on Ultra
 * once the warm-up has settled (its first frames carry shader compiles that a p95 counts). */
export const BASELINE_MS = 2000;
/** the trial's measurement window, on real Extreme frames. */
export const TRIAL_MS = 3000;
/** frames thrown away after the scene reports Extreme ready: the first ones compile the new
 * programs (GTAO, the physical twins) and allocate the bigger targets and the 4096 shadow map. */
export const TRIAL_SETTLE_MS = 500;
/** a trial whose chunks have not arrived by then is abandoned: back to Ultra, nothing stored,
 * because nothing was measured. */
export const TRIAL_READY_TIMEOUT_MS = 15000;
/** PASS needs the GPU p95 at or under this, where the GPU is timed: 16.7 ms less ~2.7 ms for the
 * compositor and for whatever the match adds after the trial (four robots, 56 elements). */
export const TRIAL_GPU_MS = 14;
/** PASS needs at most this fraction of late frames. A healthy 60 Hz session misses well under 1 %. */
export const TRIAL_LATE_MAX = 0.05;
/**
 * WHAT EXTREME COSTS ON THE GPU, AS A MULTIPLE OF ULTRA, as the entry gate applies it to Ultra's
 * GPU p95. From what the column adds:
 *   • 150 % render scale: 1.5² = 2.25× the pixels at 1080p and 1440p, 2.07× where the 8.3 MP
 *     budget caps it against Ultra's 4.0 MP;
 *   • on those pixels, GTAO's G-buffer pass and its half-resolution AO + denoise, and the
 *     physical twins' heavier shading;
 *   • the 4096 VSM map (4× the texels, 16 blur taps for 8).
 * MEASURED on one GPU (RTX 4070 Ti SUPER via ANGLE D3D11, 1922 × 1081 CSS at DPR 1, offscreen,
 * two cameras): Ultra 0.50 to 0.61 ms p50 and 1.59 to 1.88 ms p95, Extreme 2.41 to 2.63 ms p50
 * and 2.59 to 2.85 ms p95. That is 4.3 to 4.8× on the median but only 1.4 to 1.8× on the p95,
 * because Ultra's own p95 sits about three times its median there. The gate reads a p95, so 3
 * errs on the side of trialling: a needless trial costs three seconds once per GPU, a gate that
 * is too strict means a GPU that could hold Extreme never gets it.
 */
export const EXTREME_COST_FACTOR = 3;
/** ENTRY: Ultra's GPU p95, where timed, at or under the PASS budget divided by the factor. */
export const TRIAL_ENTRY_GPU_MS = TRIAL_GPU_MS / EXTREME_COST_FACTOR;
/** a frame is LATE past `LATE_FACTOR` × the baseline period, and never under `LATE_FLOOR_MS`. */
export const LATE_FACTOR = 1.5;
/**
 * The floor under the late threshold, and the entry gate's ceiling on Ultra's own period.
 * 18 ms is a little under 56 fps: on a 60 Hz panel 1.5 × 16.7 = 25 ms (a missed vsync) decides,
 * and on a 144 Hz one the floor does, so "late" there means "under ~56 fps", not "missed one of
 * 144 refreshes". An Ultra that does not hold this itself is not trialled.
 */
export const LATE_FLOOR_MS = 18;
/** the period assumed when nothing measured one (a hand-picked Extreme): 60 Hz, so a late frame
 * is a frame under 40 fps, the slip rule's own line. */
export const DEFAULT_PERIOD_MS = 1000 / 60;
/**
 * ⚠️ THE GUARD ALSO READS THE PACE THIS SESSION IS ACTUALLY DRAWN AT: the 5th-percentile period of
 * the rolling window, when that is slower than the stored one. FOUND IN THE CAPTURE HARNESS, which
 * paints at 30 fps: every frame was "late" against 60 Hz and a hand-picked Extreme was lowered in
 * three seconds. A browser does the same on purpose (Chrome's energy saver and Safari's low power
 * mode cap rAF at 30), and a stored PASS must not turn into a FAIL because a laptop went on
 * battery. The cost: a GPU-bound Extreme that holds a STEADY 30 fps looks exactly like a 30 fps
 * cap and is not caught by the late count. Where the GPU is timed, its p95 still catches it.
 */
export const PACE_FLOOR_Q = 0.05;
/** fewer GPU results than this in a window and the window counts as untimed. */
export const MIN_GPU_SAMPLES = 20;
/**
 * THE EXTREME GUARD. It judges each quarter second between two checks (a BUCKET): bad with GPU
 * p95 over `GUARD_GPU_MS`, or more than `GUARD_LATE_MAX` of its frames late. Bad buckets back to
 * back for `GUARD_WINDOW_MS`, counted from the START of the first, lower Extreme to Ultra once.
 *
 * Quarter seconds and not a rolling window, because a rolling window keeps a one-second hiccup
 * in it for as long as the window is long, and "sustained" would then mean "recent". With a
 * bucket this short, a stretch of bad frames has to last about two and a half seconds to fill
 * three seconds of buckets.
 */
export const GUARD_GPU_MS = 20;
export const GUARD_LATE_MAX = 0.25;
export const GUARD_WINDOW_MS = 3000;
/** a bucket with fewer GPU results than this is judged on late frames alone (a quarter second at
 * 32 fps; under that, the late count is already damning). */
const GUARD_MIN_GPU = 8;

/** the period past which a frame counts as late, for a display whose own period is `periodMs`. */
export function lateThreshold(periodMs: number): number {
  return Math.max(LATE_FACTOR * periodMs, LATE_FLOOR_MS);
}

/**
 * THE VERDICT A LOST CONTEXT LEAVES: an Auto device that lost its WebGL context ON Extreme has
 * failed Extreme as plainly as a trial can, so the next match does not try it again. `undefined`
 * keeps whatever is stored (`setGraphicsTier`'s third argument).
 */
export function contextLossTrial(g: GraphicsState, gpu: string): ExtremeTrial | undefined {
  if (g.preset !== 'auto' || g.tier !== GFX_AUTO_MAX_TIER) return undefined;
  const periodMs = extremeTrialFor(g, gpu)?.periodMs;
  return periodMs === undefined ? { gpu, pass: false } : { gpu, pass: false, periodMs };
}

/**
 * ⚠️ THE CLOCK IS INJECTED, AND THAT IS NOT A TESTING CONVENIENCE.
 *
 * `scripts/smoke.ts`'s determinism guard walks every `.ts` under `src/games/biobuzz/` that is
 * not named `draw*`/`render*` and fails on a the monotonic clock (`performance` dot `now`), because those files are the
 * ones a replay re-simulates through. This module is policy, not simulation — but the guard is
 * a grep and it is RIGHT to be: an exemption list is how a real clock read gets into a sim file
 * six months later. So the clock comes in from `renderScene.ts`, which is a `render*` file and
 * is allowed one, and this module stays a pure function of the numbers it is handed.
 */
export interface QualityGovernor {
  /** one rendered frame took `ms`. Called from the render loop, so it allocates nothing. The
   * frame's PERIOD is derived here too: `now() - ms` is when the frame began. */
  sample(ms: number): void;
  /** the GPU time of a frame drawn a few frames ago (`scene/renderGpuTimer.ts`), in arrival
   * order. Never called where the browser cannot time the GPU. Allocates nothing. */
  gpuSample(ms: number): void;
  /** the live read-out for the performance overlay: p95 over the rolling window. */
  readonly p95Ms: number;
  /** where the governor is, for the smoke lane and a debugging session. */
  readonly phase: GovernorPhase;
  dispose(): void;
}

/**
 * `warmup` → `watch`, or `warmup` → `baseline` (Ultra, measured) → `trial-load` (Extreme, chunks
 * in flight) → `trial-settle` (programs compiling) → `trial` (measured) → `watch`. `watch` is the
 * rest of the scene's life: the slip rule and the Extreme guard.
 */
export type GovernorPhase = 'warmup' | 'baseline' | 'trial-load' | 'trial-settle' | 'trial' | 'watch';

export interface GovernorOptions {
  /** the WebGL renderer string the Extreme verdict is keyed by (`GpuProbe.renderer`). */
  gpu?: string;
  /** is the scene drawing everything its settings ask for? (`renderScene.ts`: the post and
   * surfaces chunks loaded or failed, the room probe captured). Absent means always. */
  ready?: () => boolean;
}

/**
 * The governor the scene owns: it takes frame times and changes the preset at most a handful of
 * times in its life — the warm-up step, the Extreme trial's two writes, and one lowering.
 *
 * ── WHY A ROLLING ARRAY AND NOT A RUNNING STATISTIC ────────────────────────────────────────
 * p95 is not computable incrementally without keeping the samples, and the window is small
 * (180 frames at 60 Hz). The buffers are allocated once at construction and written in a ring,
 * so the per-frame cost is a few stores and compares — a render loop must not allocate. The
 * late-frame fractions ARE running counts, which is why they cost nothing to keep per bucket.
 *
 * ── WHY THE SORT IS NOT PER FRAME ──────────────────────────────────────────────────────────
 * p95 is only READ when a decision is due (the end of the warm-up, the baseline and the trial,
 * then at most four times a second for the slip check and the overlay), so the O(n log n) and
 * its one small array are amortised to nothing.
 */
export function createQualityGovernor(
  now: () => number,
  onEvent?: QualityEvent,
  /**
   * `false` for a scene drawn at a FIXED tier (the replay export and the gallery, both at High):
   * it still measures, for the read-out, but it never writes the device's preset. It used to, and
   * a warm-up measured at High on an Auto device would step the stored tier from what the export
   * happened to draw rather than from anything the player's own view had done. It never trials.
   */
  decide = true,
  opts: GovernorOptions = {},
): QualityGovernor {
  const gpu = opts.gpu ?? '';
  const ready = opts.ready ?? (() => true);
  const CAP = 256;
  /** CPU ms and frame period ms, written together at `head`. */
  const buf = new Float32Array(CAP);
  const per = new Float32Array(CAP);
  let n = 0;
  let head = 0;
  /** GPU ms, in arrival order. */
  const gbuf = new Float32Array(CAP);
  let ghead = 0;
  const started = now();
  let phase: GovernorPhase = 'warmup';
  /** one lowering per scene, slip or guard — §4.6's "once". */
  let slipped = false;
  let lastCheck = started;
  let lastP95 = 0;
  /** when the rolling window first went over `SLIP_MS`, or 0 while it is under. */
  let slipSince = 0;
  /** when the previous sample arrived — the stall guard's only state (see `STALL_MS`). */
  let lastSampleAt = started;
  /** when the previous frame BEGAN, for its period. */
  let lastBegin = started;
  /** the frame period past which a frame counts as late, for the window or bucket being filled. */
  let lateMs = lateThreshold(DEFAULT_PERIOD_MS);

  // ── the measuring window (baseline, trial) ───────────────────────────────────────────────
  let winStart = 0;
  let winN = 0;
  let winGpu = 0;
  let winLate = 0;
  /** Ultra's median period from the baseline, once one has run. */
  let measuredPeriod: number | undefined;
  let trialStart = 0;
  let settleUntil = 0;

  // ── the Extreme guard: this quarter second's bucket, and the bad stretch it may extend ──
  let bucketStart = started;
  let bucketFrames = 0;
  let bucketLate = 0;
  let bucketGpu = 0;
  let bucketGpuOver = 0;
  /** where the current run of bad buckets began, or -1 while the last bucket was fine. */
  let guardFrom = -1;
  let stretchFrames = 0;
  let stretchLate = 0;
  let stretchGpu = 0;

  /** the last `count` values of a ring, newest first (a decision-time allocation, never per frame). */
  const lastOf = (ring: Float32Array, h: number, count: number): number[] => {
    const out: number[] = [];
    const c = Math.min(count, CAP);
    for (let i = 0; i < c; i++) out.push(ring[(h - 1 - i + CAP) % CAP]);
    return out;
  };
  const windowSamples = (): number[] => lastOf(buf, head, n);
  const openWindow = (t: number): void => {
    winStart = t;
    winN = 0;
    winGpu = 0;
    winLate = 0;
  };
  const resetBucket = (t: number): void => {
    bucketStart = t;
    bucketFrames = 0;
    bucketLate = 0;
    bucketGpu = 0;
    bucketGpuOver = 0;
  };
  const pct = (f: number): string => `${Math.round(f * 100)}%`;
  /** Auto, on Extreme: the only state a trial may write from. Anything else (a hand pick, Reset
   * to Auto, a context loss) ends the trial with nothing stored. */
  const onTrialTier = (): boolean => {
    const g = getGraphics();
    return g.preset === 'auto' && g.tier === GFX_AUTO_MAX_TIER;
  };
  /** the Extreme column itself, picked by hand or by Auto. A Custom branched from Extreme is the
   * player's own tune (and may carry a frame cap the late count would misread): the CPU slip
   * still covers it, the guard does not. */
  const guarded = (g: GraphicsState): boolean =>
    g.tier === GFX_AUTO_MAX_TIER && (g.preset === 'auto' || g.preset === GFX_AUTO_MAX_TIER);
  /** the guard's late line: the display period the trial measured on this GPU, else this
   * scene's own baseline, else 60 Hz (a hand pick nothing measured), or the pace this session is
   * actually drawn at when that is slower (`PACE_FLOOR_Q`). Read at 4 Hz, never per frame. */
  const guardLateMs = (g: GraphicsState): number =>
    lateThreshold(
      Math.max(extremeTrialFor(g, gpu)?.periodMs ?? measuredPeriod ?? DEFAULT_PERIOD_MS, quantile(lastOf(per, head, n), PACE_FLOOR_Q)),
    );
  const verdict = (pass: boolean, g: GraphicsState): ExtremeTrial => {
    const periodMs = measuredPeriod ?? extremeTrialFor(g, gpu)?.periodMs;
    return periodMs === undefined ? { gpu, pass } : { gpu, pass, periodMs };
  };

  const lower = (why: string): void => {
    const cur = getGraphics();
    const next = stepTier(cur.tier, -1);
    if (next === cur.tier) return; // already at Low — there is nowhere to go, and no line to write
    // A HAND-PICKED PRESET IS STILL LOWERED, and that is deliberate: the slip rule is the one
    // place a measurement overrides a choice, because the alternative is a player sitting at
    // 8 fps wondering why. It stops being `auto` though — it becomes the named tier it landed
    // on, so the picker tells the truth and the player can put it straight back.
    const auto = cur.preset === 'auto';
    // An Auto device lowered OFF Extreme has failed Extreme on this GPU, and says so in the blob,
    // or the next match would start there again.
    setGraphicsTier(next, auto, auto && cur.tier === GFX_AUTO_MAX_TIER ? verdict(false, cur) : undefined);
    onEvent?.(`Graphics lowered to ${GFX_PRESET_LABEL[next]} — ${why}`);
  };

  /** the warm-up's window closed: the step, then (on Ultra) the baseline. */
  const endWarmup = (t: number): void => {
    phase = 'watch';
    lastCheck = t;
    resetBucket(t);
    // A WARM-UP WITH ALMOST NO FRAMES IN IT IS NOT A MEASUREMENT. A tab that was
    // backgrounded, or a scene mounted behind a modal, throttles rAF to ~1 Hz and would
    // hand us a p95 of a second — which reads as "this machine cannot draw" and is really
    // "this machine was not asked to".
    if (n < 20) return;
    const v = p95(windowSamples());
    lastP95 = v;
    if (!decide) return;
    const cur = getGraphics();
    if (cur.preset !== 'auto') return; // detection does not move a hand-picked preset
    // AN AUTO EXTREME CAME FROM A STORED PASS (`applyFirstGuess`). This step's CPU number is not
    // what that pass measured, and its first frames carry Extreme's shader compiles; the guard
    // watches it from here, with the numbers that can see it.
    if (cur.tier === GFX_AUTO_MAX_TIER) return;
    if (v > WARMUP_DOWN_MS) {
      const next = stepTier(cur.tier, -1);
      if (next !== cur.tier) {
        setGraphicsTier(next, true);
        onEvent?.(`Graphics: ${GFX_PRESET_LABEL[next]} (auto, ${v.toFixed(1)} ms p95)`);
      }
      return;
    }
    if (v < WARMUP_UP_MS) {
      // never into Extreme by this step: see `GFX_AUTO_STEP_MAX_TIER` for why a fast Ultra
      // frame is no evidence. The trial below is the only way up from Ultra.
      const next = stepTier(cur.tier, 1, GFX_AUTO_STEP_MAX_TIER);
      if (next !== cur.tier) {
        setGraphicsTier(next, true);
        onEvent?.(`Graphics: ${GFX_PRESET_LABEL[next]} (auto, ${v.toFixed(1)} ms p95)`);
      }
    }
    const g = getGraphics();
    if (g.preset !== 'auto' || g.tier !== GFX_AUTO_STEP_MAX_TIER) return;
    const known = extremeTrialFor(g, gpu);
    if (known?.pass) {
      // measured before, on this GPU: no second trial, and the guard watches it
      setGraphicsTier(GFX_AUTO_MAX_TIER, true);
      onEvent?.(`Graphics: ${GFX_PRESET_LABEL[GFX_AUTO_MAX_TIER]} (auto)`);
      return;
    }
    if (known) return; // FAILED on this GPU: not again until Reset to Auto clears it
    phase = 'baseline';
    openWindow(t);
  };

  /** two seconds of Ultra, then the entry gate. Nothing is stored either way. */
  const baselineStep = (t: number): void => {
    const g = getGraphics();
    if (g.preset !== 'auto' || g.tier !== GFX_AUTO_STEP_MAX_TIER) {
      phase = 'watch'; // something else moved it: a hand pick, the slip, Reset to Auto
      return;
    }
    if (t - winStart < BASELINE_MS) return;
    if (winN < 20) {
      openWindow(t);
      return;
    }
    phase = 'watch';
    const cpu = p95(lastOf(buf, head, winN));
    const period = median(lastOf(per, head, winN));
    const gpuMs = winGpu >= MIN_GPU_SAMPLES ? p95(lastOf(gbuf, ghead, winGpu)) : 0;
    // NO HEADROOM, NO TRIAL: a CPU already past the up-step's 6 ms, an Ultra that does not
    // itself hold ~56 fps, or (timed) an Ultra GPU frame Extreme's factor would push past 14 ms
    if (cpu >= WARMUP_UP_MS || period > LATE_FLOOR_MS || gpuMs > TRIAL_ENTRY_GPU_MS) return;
    measuredPeriod = period;
    lateMs = lateThreshold(period);
    phase = 'trial-load';
    trialStart = t;
    setGraphicsTier(GFX_AUTO_MAX_TIER, true);
    onEvent?.(`Graphics: trying ${GFX_PRESET_LABEL[GFX_AUTO_MAX_TIER]} (auto)`);
  };

  /** wait for the chunks, let the programs compile, then three seconds of real Extreme frames. */
  const trialStep = (t: number): void => {
    if (!onTrialTier()) {
      phase = 'watch';
      return;
    }
    if (phase === 'trial-load') {
      if (ready()) {
        phase = 'trial-settle';
        settleUntil = t + TRIAL_SETTLE_MS;
      } else if (t - trialStart >= TRIAL_READY_TIMEOUT_MS) {
        phase = 'watch';
        setGraphicsTier(GFX_AUTO_STEP_MAX_TIER, true);
        onEvent?.(`Graphics: ${GFX_PRESET_LABEL[GFX_AUTO_STEP_MAX_TIER]} (auto). Extreme’s effects did not load.`);
      }
      return;
    }
    if (!ready()) {
      phase = 'trial-load'; // a chunk went back in flight: wait again, inside the same timeout
      return;
    }
    if (phase === 'trial-settle') {
      if (t >= settleUntil) {
        phase = 'trial';
        openWindow(t);
      }
      return;
    }
    if (t - winStart < TRIAL_MS) return;
    if (winN < 20) {
      openWindow(t);
      return;
    }
    phase = 'watch';
    resetBucket(t);
    guardFrom = -1;
    const cpu = p95(lastOf(buf, head, winN));
    const timed = winGpu >= MIN_GPU_SAMPLES;
    const gpuMs = timed ? p95(lastOf(gbuf, ghead, winGpu)) : 0;
    const late = winLate / winN;
    const why =
      timed && gpuMs > TRIAL_GPU_MS
        ? `${gpuMs.toFixed(1)} ms GPU p95`
        : late > TRIAL_LATE_MAX
          ? `${pct(late)} of frames late`
          : cpu > WARMUP_DOWN_MS
            ? `${cpu.toFixed(1)} ms CPU p95`
            : '';
    const g = getGraphics();
    if (!why) {
      setGraphicsTier(GFX_AUTO_MAX_TIER, true, verdict(true, g));
      onEvent?.(`Graphics: ${GFX_PRESET_LABEL[GFX_AUTO_MAX_TIER]} (auto, ${timed ? `${gpuMs.toFixed(1)} ms GPU p95, ` : ''}${pct(late)} of frames late)`);
      return;
    }
    setGraphicsTier(GFX_AUTO_STEP_MAX_TIER, true, verdict(false, g));
    onEvent?.(`Graphics: ${GFX_PRESET_LABEL[GFX_AUTO_STEP_MAX_TIER]} (auto). On Extreme: ${why}.`);
  };

  /** four times a second, after the warm-up: the clamp, the slip rule, the Extreme guard. */
  const check = (t: number): void => {
    if (slipped || !decide) return;
    const cur = getGraphics();
    // AUTO ON EXTREME WITHOUT A PASS ON THIS GPU: `setGraphicsPreset('auto')` keeps a stored pass
    // without knowing which GPU it was measured on, and this is where that is checked.
    if (phase === 'watch' && cur.preset === 'auto' && cur.tier === GFX_AUTO_MAX_TIER && !extremeTrialFor(cur, gpu)?.pass) {
      setGraphicsTier(GFX_AUTO_STEP_MAX_TIER, true);
      onEvent?.(`Graphics: ${GFX_PRESET_LABEL[GFX_AUTO_STEP_MAX_TIER]} (auto)`);
      return;
    }

    // ── the slip rule, at most once ─────────────────────────────────────────────────────
    if (lastP95 >= SLIP_MS) {
      if (slipSince === 0) slipSince = t;
      else if (t - slipSince >= SLIP_WINDOW_MS) {
        slipped = true;
        lower(`${lastP95.toFixed(0)} ms frames`);
        return;
      }
    } else {
      slipSince = 0;
    }

    // ── the Extreme guard ───────────────────────────────────────────────────────────────
    // The slip above times the CPU and cannot see a GPU-bound frame, which is all Extreme's
    // extra cost is. This watches the trial's two numbers for as long as Extreme is on screen.
    if (phase !== 'watch' || !guarded(cur) || !ready()) {
      guardFrom = -1;
      resetBucket(t);
      lateMs = guardLateMs(cur);
      return;
    }
    // GPU p95 over GUARD_GPU_MS, read as a count: more than 5 % of the bucket's GPU frames over it
    const gpuBad = bucketGpu >= GUARD_MIN_GPU && bucketGpuOver / bucketGpu > 0.05;
    const lateBad = bucketFrames > 0 && bucketLate / bucketFrames > GUARD_LATE_MAX;
    if (gpuBad || lateBad) {
      if (guardFrom < 0) {
        guardFrom = bucketStart;
        stretchFrames = 0;
        stretchLate = 0;
        stretchGpu = 0;
      }
      stretchFrames += bucketFrames;
      stretchLate += bucketLate;
      stretchGpu += bucketGpu;
    } else {
      guardFrom = -1;
    }
    resetBucket(t);
    lateMs = guardLateMs(cur);
    if (guardFrom < 0 || t - guardFrom < GUARD_WINDOW_MS) return;
    slipped = true;
    // the line quotes the whole bad stretch, not the last quarter second of it
    const gpuMs = stretchGpu >= MIN_GPU_SAMPLES ? p95(lastOf(gbuf, ghead, stretchGpu)) : 0;
    lower(
      gpuMs > GUARD_GPU_MS
        ? `${gpuMs.toFixed(1)} ms GPU p95 on Extreme`
        : `${pct(stretchLate / Math.max(1, stretchFrames))} of frames late on Extreme`,
    );
  };

  return {
    sample(ms: number): void {
      const t = now();
      // THE STALL GUARD, before anything is recorded — see `STALL_MS`. A frame that arrived
      // after a gap is not evidence about this machine's speed, and neither is a slip window,
      // a guard bucket, a baseline or a trial window that was open across it.
      const gap = t - lastSampleAt;
      lastSampleAt = t;
      const begin = t - ms;
      const period = begin - lastBegin;
      lastBegin = begin;
      if (gap > STALL_MS) {
        slipSince = 0;
        guardFrom = -1;
        resetBucket(t);
        if (phase === 'baseline' || phase === 'trial') openWindow(t);
        return;
      }
      buf[head] = ms;
      per[head] = period;
      head = (head + 1) % CAP;
      n++;
      winN++;
      bucketFrames++;
      if (period > lateMs) {
        winLate++;
        bucketLate++;
      }

      // ── the warm-up, once ──────────────────────────────────────────────────────────────
      if (phase === 'warmup') {
        if (t - started >= WARMUP_MS) endWarmup(t);
        return;
      }
      if (phase === 'baseline') baselineStep(t);
      else if (phase === 'trial-load' || phase === 'trial-settle' || phase === 'trial') trialStep(t);

      // ── the overlay's p95 and the checks, at 4 Hz ──────────────────────────────────────
      if (t - lastCheck < 250) return;
      lastCheck = t;
      lastP95 = p95(windowSamples());
      if (phase === 'baseline' || phase === 'watch') check(t);
    },
    gpuSample(ms: number): void {
      if (!(ms > 0) || !Number.isFinite(ms)) return;
      gbuf[ghead] = ms;
      ghead = (ghead + 1) % CAP;
      winGpu++;
      bucketGpu++;
      if (ms > GUARD_GPU_MS) bucketGpuOver++;
    },
    get p95Ms(): number {
      return lastP95;
    },
    get phase(): GovernorPhase {
      return phase;
    },
    dispose(): void {
      // A TRIAL IS NEVER LEFT STANDING. A scene torn down mid-trial (the view switched to 2D, the
      // match ended) would leave Auto on an Extreme nothing measured; the next scene starts on
      // Ultra and trials again.
      if (decide && (phase === 'trial-load' || phase === 'trial-settle' || phase === 'trial') && onTrialTier()) {
        setGraphicsTier(GFX_AUTO_STEP_MAX_TIER, true);
      }
      phase = 'watch';
      n = 0;
      head = 0;
      ghead = 0;
    },
  };
}
