/**
 * GPU TIME PER FRAME, where the browser will say — `EXT_disjoint_timer_query_webgl2`.
 *
 * Auto's Extreme trial (`graphics/auto.ts`) needs to know what a frame costs the GPU, because
 * Extreme's extra cost is almost all fill and the CPU span `renderScene.ts` already times cannot
 * see it. Chromium exposes the extension on desktop; Firefox only behind a privacy pref, and
 * Safari not at all. Where it is missing this hands out nothing and the governor runs on late
 * frames alone, which it does everywhere anyway.
 *
 * ── HOW A RESULT ARRIVES ───────────────────────────────────────────────────────────────────
 * A `TIME_ELAPSED_EXT` query wraps one frame's GPU work (`begin` before the scene pass, `end`
 * after the blit and the minimap). Its result is not available for a few frames, and WebGL 2
 * never makes one available inside the task that issued it, so `poll` runs at the start of the
 * next frame and reads, oldest first, every query that has finished. A RING of `SLOTS` queries
 * keeps that many frames in flight; a frame with all of them still pending is simply not timed
 * (a GPU that far behind is one the late-frame count already sees).
 *
 * ── ⚠️ WHY `end` FLUSHES ───────────────────────────────────────────────────────────────────
 * The query's two timestamps are taken when the GPU REACHES them. Without a flush the frame's
 * tail (the blit, the end of the query) can wait in the command buffer until the browser's next
 * flush, a frame later, and the query then times the GPU sitting idle across that gap. MEASURED
 * in the offscreen capture harness (RTX 4070 Ti SUPER via ANGLE D3D11, Ultra at 1922 × 1081, 30
 * fps paint): one query around the frame read 29.9 ms p50, the frame period less a few ms of
 * CPU; the same query with `gl.flush()` after `endQuery` read 0.61 ms p50 (1.75 p95), which is
 * what timing each draw call on its own also adds up to. One flush per frame, at the end of the
 * frame's GL work, is the whole cost.
 *
 * ── GPU_DISJOINT_EXT ───────────────────────────────────────────────────────────────────────
 * The extension raises it when something made the timer unreliable (a power-state change, a GPU
 * reset, another process taking the GPU). Every result in flight at that point is suspect, so
 * all of them are dropped. Reading the flag also clears it.
 *
 * ── NOTHING ALLOCATED PER FRAME ────────────────────────────────────────────────────────────
 * The queries are created once. `begin`, `end` and `poll` touch only numbers, the fixed array
 * and the sink the caller created once; `getParameter`/`getQueryParameter` return primitives.
 * The RENDER lane drives this against a fake context for a thousand frames and checks that.
 *
 * ── A LOST CONTEXT ─────────────────────────────────────────────────────────────────────────
 * Every call checks `isContextLost()` first and does nothing on a dead context: no throw, no
 * result. The scene falls back to 2D on a loss anyway (`renderCore.ts`'s `watchContextLoss`);
 * this only has to not be the thing that throws on the way out.
 */

/** frames in flight. Results typically land two or three frames later. */
export const GPU_TIMER_SLOTS = 4;

export interface GpuTimer {
  /** does this browser time the GPU at all? */
  readonly supported: boolean;
  /** open this frame's query. A no-op when unsupported, lost, or every slot is in flight. */
  begin(): void;
  /** close it. A no-op if `begin` did not open one. */
  end(): void;
  /** hand every finished result (ms) to `sink`, oldest first. */
  poll(sink: (ms: number) => void): void;
  dispose(): void;
}

/** the two enums this file uses; the extension object carries them. */
interface TimerQueryExt {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

const NO_TIMER: GpuTimer = {
  supported: false,
  begin() {},
  end() {},
  poll() {},
  dispose() {},
};

export function createGpuTimer(gl: WebGL2RenderingContext): GpuTimer {
  let ext: TimerQueryExt | null = null;
  try {
    ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExt | null;
  } catch {
    ext = null;
  }
  if (!ext) return NO_TIMER;
  const TIME_ELAPSED = ext.TIME_ELAPSED_EXT;
  const DISJOINT = ext.GPU_DISJOINT_EXT;
  const queries: (WebGLQuery | null)[] = [];
  for (let i = 0; i < GPU_TIMER_SLOTS; i++) queries.push(gl.createQuery());
  /** queries begun and closed, and results consumed; slot = count % SLOTS. */
  let issued = 0;
  let read = 0;
  let open = false;

  return {
    supported: true,
    begin(): void {
      if (open || gl.isContextLost() || issued - read >= GPU_TIMER_SLOTS) return;
      const q = queries[issued % GPU_TIMER_SLOTS];
      if (!q) return;
      gl.beginQuery(TIME_ELAPSED, q);
      open = true;
    },
    end(): void {
      if (!open) return;
      open = false;
      if (gl.isContextLost()) return;
      gl.endQuery(TIME_ELAPSED);
      // SUBMIT IT NOW (see "WHY end FLUSHES" above): without this the query read the frame period
      gl.flush();
      issued++;
    },
    poll(sink: (ms: number) => void): void {
      if (gl.isContextLost()) {
        read = issued; // nothing in flight will ever come back
        return;
      }
      if (read === issued) return;
      if (gl.getParameter(DISJOINT) === true) {
        read = issued; // every result in flight is suspect
        return;
      }
      while (read < issued) {
        const q = queries[read % GPU_TIMER_SLOTS];
        if (!q || gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) !== true) return;
        const ns: unknown = gl.getQueryParameter(q, gl.QUERY_RESULT);
        read++;
        if (typeof ns === 'number' && ns > 0) sink(ns / 1e6);
      }
    },
    dispose(): void {
      if (gl.isContextLost()) return;
      if (open) {
        gl.endQuery(TIME_ELAPSED);
        open = false;
      }
      for (const q of queries) if (q) gl.deleteQuery(q);
    },
  };
}
