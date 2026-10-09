import { PACE_CURVES_KEY } from '../../storageKeys';
import { BALANCE_VERSION, SIM_VERSION } from '../../config';
import { replayFidelity, type Replay } from '../../sim/replay';
import type { Alliance, GameId } from '../../types';
import { coerceCurve, type PaceCurve } from './curve';
import type { PaceWorkerIn, PaceWorkerOut } from './paceWorker';

/**
 * PACE CURVES, KEPT ON THIS DEVICE, and the worker that makes them.
 *
 * A curve is a pure function of its replay, and a replay never changes once it exists, so a curve
 * is made once and read forever. The key names the replay: `r:<server replay id>` or
 * `l:<local key>`. The re-simulation is the expensive half (a whole match, seconds of CPU for a
 * BIOBUZZ 3D run); the curve is a few hundred numbers.
 *
 * A CURVE PICKED AS A CUSTOM PACE IS PINNED. A curve fetched for a PB or WR can always be made
 * again from the server, but a just-played run watched straight off the results screen has no
 * server id this screen knows, so its curve is the only copy. One pin per game; picking another
 * replay for that game releases the old one.
 */

/** curves kept besides the pinned ones; a PB and a WR per mode per game fits with room over */
const MAX_CURVES = 24;

interface Entry {
  /** last used, epoch ms: the oldest unpinned entry goes first */
  at: number;
  game: GameId;
  pin?: true;
  c: PaceCurve;
}

const read = (): Record<string, Entry> => {
  try {
    const raw = localStorage.getItem(PACE_CURVES_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    if (typeof v !== 'object' || v === null) return {};
    const out: Record<string, Entry> = {};
    for (const [key, e] of Object.entries(v as Record<string, Partial<Entry>>)) {
      const c = coerceCurve(e?.c);
      if (c && typeof e.at === 'number' && typeof e.game === 'string') {
        out[key] = { at: e.at, game: e.game, c, ...(e.pin ? { pin: true as const } : {}) };
      }
    }
    return out;
  } catch {
    return {};
  }
};

const write = (all: Record<string, Entry>): void => {
  const keys = Object.keys(all)
    .filter((k) => !all[k].pin)
    .sort((a, b) => all[b].at - all[a].at);
  for (const k of keys.slice(MAX_CURVES)) delete all[k];
  try {
    localStorage.setItem(PACE_CURVES_KEY, JSON.stringify(all));
  } catch {
    /* storage full or off: the curve is simply made again next time */
  }
};

export function storedCurve(key: string): PaceCurve | null {
  return read()[key]?.c ?? null;
}

export function storeCurve(key: string, game: GameId, c: PaceCurve, pin = false): void {
  const all = read();
  if (pin) for (const e of Object.values(all)) if (e.game === game) delete e.pin;
  all[key] = { at: Date.now(), game, c, ...(pin || all[key]?.pin ? { pin: true as const } : {}) };
  write(all);
}

/** the store key for a replay's curve under THIS build's sim and balance (see `curveFor`): a
 *  stored curve is only reused by a build that would still re-run its replay exactly */
export const curveKey = (ref: string): string => `${ref}#${SIM_VERSION}.${BALANCE_VERSION}`;

/**
 * THE REFERENCE MUST RE-RUN EXACTLY. Stricter than the viewer, which plays a replay whose sim has
 * moved under it with a note (`replayFidelity`'s drift): watching a drifted run is still worth it,
 * but pacing against one is not. Measured 2026-10-07, a 723-point DECODE record from sim v2
 * re-simulated on sim v5 finished on 40, so its curve would have the player "ahead of the record"
 * all match. So after a SIM_VERSION bump a PB or WR set before it has no pace until it is beaten.
 */
export class PaceStale extends Error {
  constructor() {
    super('That run was played on an older version of DSIM, so it cannot be raced.');
    this.name = 'PaceStale';
  }
}

// ── the worker ────────────────────────────────────────────────────────────────────────────────

let worker: Worker | null = null;
let nextId = 1;
const waiting = new Map<number, (out: PaceWorkerOut) => void>();
const inFlight = new Map<string, Promise<PaceCurve>>();

/** a whole match takes a few seconds (BIOBUZZ 3D the longest); far past that, it is not coming */
const JOB_TIMEOUT_MS = 120_000;

/** fail everything waiting on the worker and drop it, so the next ask starts a fresh one rather
 *  than queueing behind a dead or stuck one */
const resetWorker = (error: string): void => {
  for (const done of waiting.values()) done({ id: 0, ok: false, error });
  waiting.clear();
  worker?.terminate();
  worker = null;
};

const getWorker = (): Worker => {
  if (worker) return worker;
  worker = new Worker(new URL('./paceWorker.ts', import.meta.url), { type: 'module' });
  worker.addEventListener('message', (e: MessageEvent) => {
    const out = e.data as PaceWorkerOut;
    waiting.get(out.id)?.(out);
    waiting.delete(out.id);
  });
  worker.addEventListener('error', () => resetWorker('pace worker failed'));
  return worker;
};

/**
 * The curve for `key`: from storage when it is there, else re-simulated in the worker and then
 * stored. Two asks for one key share one simulation.
 */
export function curveFor(
  ref: string,
  game: GameId,
  replay: () => Promise<Replay>,
  /** whose score; absent reads the replay's first seat */
  alliance?: Alliance,
  pin = false,
): Promise<PaceCurve> {
  // the SIM is in the key: a replay re-simulated by a build whose sim moved can land somewhere
  // else (`replayFidelity`'s drift), so a curve is only reused by the sim that made it
  const key = curveKey(ref);
  const have = storedCurve(key);
  if (have) {
    storeCurve(key, game, have, pin); // touch, so a curve in use is not the one evicted
    return Promise.resolve(have);
  }
  const running = inFlight.get(key);
  if (running) return running;
  const job = (async () => {
    const r = await replay();
    if (replayFidelity(r, BALANCE_VERSION, SIM_VERSION) !== 'ok') {
      throw new PaceStale();
    }
    const out = await new Promise<PaceWorkerOut>((resolve) => {
      const id = nextId++;
      // a worker killed without an error event (out of memory) answers nothing, ever
      const timer = setTimeout(() => resetWorker('pace worker timed out'), JOB_TIMEOUT_MS);
      waiting.set(id, (o) => {
        clearTimeout(timer);
        resolve(o);
      });
      const msg: PaceWorkerIn = { id, replay: r, alliance: alliance ?? r.setups[0]?.alliance ?? 'blue' };
      getWorker().postMessage(msg);
    });
    if (!out.ok) throw new Error(out.error);
    storeCurve(key, game, out.curve, pin);
    return out.curve;
  })();
  inFlight.set(key, job);
  job.then(
    () => inFlight.delete(key),
    () => inFlight.delete(key),
  );
  return job;
}
