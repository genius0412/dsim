/**
 * THE PACE WORKER: re-simulates a reference replay into its pace curve (`curve.ts`).
 *
 * A Worker and not the page because it is a WHOLE MATCH of sim, and it runs while the player is
 * driving one: on the page it would take frames from the live game, and a BIOBUZZ 3D reference is
 * a second Rapier 3D world beside the one being driven. Here it is neither — its own thread and its
 * own wasm instances — and the page only ever receives a few hundred numbers.
 *
 * Fetched only when a pace is switched on and its curve is not already stored, so a player who
 * never turns it on never downloads it (`bundleaudit`'s `paceWorker` route).
 */
import { initPhysics } from '../../sim/physicsEngine';
import { initPhysics3d, disposePhysics3dFor } from '../../games/biobuzz/sim3d/engine';
import type { Replay } from '../../sim/replay';
import { buildPaceCurve } from './curve';
import type { Alliance } from '../../types';

export interface PaceWorkerIn {
  id: number;
  replay: Replay;
  alliance: Alliance;
}
export type PaceWorkerOut =
  | { id: number; ok: true; curve: { k: number[]; s: number[] } }
  | { id: number; ok: false; error: string };

const post = (m: PaceWorkerOut): void => {
  (self as unknown as { postMessage: (m: PaceWorkerOut) => void }).postMessage(m);
};

self.addEventListener('message', (e: MessageEvent) => {
  const { id, replay, alliance } = e.data as PaceWorkerIn;
  void (async () => {
    try {
      // the CONTAINER's physics decides, as it does for every re-simulation (`ReplayPlayer`)
      await Promise.all([initPhysics(), replay.physics === '3d' ? initPhysics3d() : null]);
      const curve = buildPaceCurve(replay, alliance, (w) => {
        if (replay.physics === '3d') disposePhysics3dFor(w);
      });
      post({ id, ok: true, curve });
    } catch (err) {
      post({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();
});
