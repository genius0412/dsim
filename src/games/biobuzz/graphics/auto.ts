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
 * NO THREE.JS HERE. The scene owns frame times and feeds them in; this module owns the policy.
 * That is what lets `scripts/smoke-biobuzz/render.ts` check the policy without a GPU.
 */

import {
  GFX_TIERS,
  GFX_AUTO_MAX_TIER,
  GFX_PRESET_LABEL,
  getGraphics,
  setGraphicsTier,
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
 * the warm-up is kept below Extreme (`GFX_AUTO_MAX_TIER`). An up-step from a tier already past
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
  const tier = firstGuess(probe, adapter);
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
  /** one rendered frame took `ms`. Called from the render loop, so it allocates nothing. */
  sample(ms: number): void;
  /** the live read-out for the performance overlay: p95 over the rolling window. */
  readonly p95Ms: number;
  dispose(): void;
}

/**
 * The governor the scene owns: it takes frame times and, at most twice in its life, changes the
 * preset.
 *
 * ── WHY A ROLLING ARRAY AND NOT A RUNNING STATISTIC ────────────────────────────────────────
 * p95 is not computable incrementally without keeping the samples, and the window is small
 * (180 frames at 60 Hz). The buffer is allocated once at construction and written in a ring, so
 * the per-frame cost is one store and one compare — a render loop must not allocate.
 *
 * ── WHY THE SORT IS NOT PER FRAME ──────────────────────────────────────────────────────────
 * p95 is only READ when a decision is due (once at the end of the warm-up, then at most once a
 * second for the slip check and the overlay), so the O(n log n) is amortised to nothing.
 */
export function createQualityGovernor(
  now: () => number,
  onEvent?: QualityEvent,
  /**
   * `false` for a scene drawn at a FIXED tier (the replay export and the gallery, both at High):
   * it still measures, for the read-out, but it never writes the device's preset. It used to, and
   * a warm-up measured at High on an Auto device would step the stored tier from what the export
   * happened to draw rather than from anything the player's own view had done.
   */
  decide = true,
): QualityGovernor {
  const CAP = 256;
  const buf = new Float32Array(CAP);
  let n = 0;
  let head = 0;
  const started = now();
  let warmedUp = false;
  /** the slip rule fires ONCE — §4.6's own word. */
  let slipped = false;
  let lastCheck = started;
  let lastP95 = 0;
  /** when the rolling window first went over `SLIP_MS`, or 0 while it is under. */
  let slipSince = 0;
  /** when the previous sample arrived — the stall guard's only state (see `STALL_MS`). */
  let lastSampleAt = started;

  const windowSamples = (): number[] => {
    const out: number[] = [];
    const count = Math.min(n, CAP);
    for (let i = 0; i < count; i++) out.push(buf[(head - 1 - i + CAP) % CAP]);
    return out;
  };

  const lower = (why: string): void => {
    const cur = getGraphics();
    const next = stepTier(cur.tier, -1);
    if (next === cur.tier) return; // already at Low — there is nowhere to go, and no line to write
    // A HAND-PICKED PRESET IS STILL LOWERED, and that is deliberate: the slip rule is the one
    // place a measurement overrides a choice, because the alternative is a player sitting at
    // 8 fps wondering why. It stops being `auto` though — it becomes the named tier it landed
    // on, so the picker tells the truth and the player can put it straight back.
    setGraphicsTier(next, cur.preset === 'auto');
    onEvent?.(`Graphics lowered to ${GFX_PRESET_LABEL[next]} — ${why}`);
  };

  return {
    sample(ms: number): void {
      const t = now();
      // THE STALL GUARD, before anything is recorded — see `STALL_MS`. A frame that arrived
      // after a gap is not evidence about this machine's speed, and neither is the slip window
      // that was open across it.
      const gap = t - lastSampleAt;
      lastSampleAt = t;
      if (gap > STALL_MS) {
        slipSince = 0;
        return;
      }
      buf[head] = ms;
      head = (head + 1) % CAP;
      n++;

      // ── the warm-up, once ──────────────────────────────────────────────────────────────
      if (!warmedUp) {
        if (t - started < WARMUP_MS) return;
        warmedUp = true;
        lastCheck = t;
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
        if (v > WARMUP_DOWN_MS) {
          const next = stepTier(cur.tier, -1);
          if (next !== cur.tier) {
            setGraphicsTier(next, true);
            onEvent?.(`Graphics: ${GFX_PRESET_LABEL[next]} (auto, ${v.toFixed(1)} ms p95)`);
          }
        } else if (v < WARMUP_UP_MS) {
          // never into Extreme: see `GFX_AUTO_MAX_TIER` for why a fast Ultra frame is no evidence
          const next = stepTier(cur.tier, 1, GFX_AUTO_MAX_TIER);
          if (next !== cur.tier) {
            setGraphicsTier(next, true);
            onEvent?.(`Graphics: ${GFX_PRESET_LABEL[next]} (auto, ${v.toFixed(1)} ms p95)`);
          }
        }
        return;
      }

      // ── the slip rule, at most once, checked at 4 Hz ───────────────────────────────────
      if (t - lastCheck < 250) return;
      lastCheck = t;
      lastP95 = p95(windowSamples());
      if (slipped || !decide) return;
      if (lastP95 >= SLIP_MS) {
        if (slipSince === 0) slipSince = t;
        else if (t - slipSince >= SLIP_WINDOW_MS) {
          slipped = true;
          lower(`${lastP95.toFixed(0)} ms frames`);
        }
      } else {
        slipSince = 0;
      }
    },
    get p95Ms(): number {
      return lastP95;
    },
    dispose(): void {
      n = 0;
      head = 0;
    },
  };
}
