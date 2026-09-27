import { useEffect, useState } from 'react';
import {
  PREDICTION_BLURBS,
  PREDICTION_LABELS,
  PREDICTION_PREFS,
  getPredictionPref,
  setPredictionPref,
  subscribePredictionPref,
  type PredictionPref,
} from '../net/predictionPref';
import { OptRow } from './OptRow';

/**
 * NETWORK — client prediction (`docs/biobuzz/plan-3d.md` §5).
 *
 * ── WHY IT IS ITS OWN SECTION ──────────────────────────────────────────────────────────────
 * It sat at the bottom of Controls, in a "More" fold with the touch-layout button, for no
 * better reason than that both were "not a binding". Prediction is not a control of any kind:
 * it decides how this machine draws its own robot ahead of the server in a 3D-physics room, and
 * somebody chasing lag looks for it under a network heading, not under keyboard and gamepad
 * (owner, 2026-09-22: "Network prediction should NOT be part of controls").
 *
 * Not Graphics either, although both are per DEVICE. Graphics is what the GPU draws; this is
 * what the netcode predicts, and the two are tuned for different complaints.
 *
 * Per device, so it is NOT a `GameSettings` field and does not arrive through props — it has
 * its own store and subscription (`src/net/predictionPref.ts`), the shape the view preference
 * uses, because a machine's speed is not a property of an account. The in-match connection
 * panel sets the same store, which is why this subscribes rather than reading once.
 *
 * SHOWN UNCONDITIONALLY rather than gated on the active game: the room whose physics decides
 * whether it does anything has not been joined yet, and hiding a control that will matter in
 * five minutes is how a player never finds it. The one line under the tiles says where it
 * applies — the one fact the tiles cannot carry.
 */
export function NetworkSection() {
  const [prediction, setPrediction] = useState<PredictionPref>(() => getPredictionPref());
  useEffect(() => subscribePredictionPref(setPrediction), []);
  return (
    <section className="ds-panel">
      <div className="ds-panel-h">
        <h2 className="ds-panel-title">Prediction</h2>
      </div>
      <div className="ds-panel-body stack">
        <OptRow<PredictionPref>
          value={prediction}
          cols="two"
          lead
          onPick={setPredictionPref}
          options={PREDICTION_PREFS.map((p) => ({ v: p, t: PREDICTION_LABELS[p], d: PREDICTION_BLURBS[p] }))}
        />
        <p className="ds-hint">Used only in 3D-physics rooms.</p>
      </div>
    </section>
  );
}
