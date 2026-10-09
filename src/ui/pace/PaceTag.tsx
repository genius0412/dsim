import { createContext, useContext } from 'react';
import type { HudSnapshot } from '../../game';
import { paceAt, type PaceCurve } from './curve';

/**
 * THE PACE READ-OUT: `+12 PB`, a chip in the row over the score bar (`.breakdown-row`), first,
 * beside NECTAR LOCKED / CLASSIFIED / PARTICLES.
 *
 * NOT IN THE SCORE BAR (owner, 2026-10-08: it "broke the clean, symmetrical scoring look", then
 * "make it another chip like how NECTAR LOCKED is, in that row, of the same style"). Inside a
 * panel it made the two alliance panels differ; the row is where a driver's own read-outs
 * already live. GREEN ahead, RED behind, plain ink level. It is there from the first frame of a
 * paced match whether or not the curve has arrived (`—` until there is a number), so the row's
 * HEIGHT, which is what the field fit measures, never changes mid-match; its width moves with
 * the digits the way PENDING's already does.
 */

export interface PaceState {
  /** `PB` / `WR` / `REPLAY` */
  tag: string;
  curve: PaceCurve | null;
  /** why there is no number, for the tooltip; empty while it is still being worked out */
  why: string;
}

/** provided by `GameView` for a paced match (`usePace`); a score bar with no provider shows no
 *  pace. This file stays free of the network and storage halves on purpose: every game's score
 *  bar imports it, and so does `npm test` through them. */
export const PaceContext = createContext<PaceState | null>(null);

/** −12 with a real minus, +12, 0 */
export const fmtPace = (d: number): string => (d > 0 ? `+${d}` : d < 0 ? `−${-d}` : '0');

/**
 * The line itself. Reads the live NET score off the HUD — the alliance total minus what its own
 * fouls handed the other side, floored at 0 — which is what the curve holds (`curve.ts`).
 */
export function PaceTag({ hud }: { hud: HudSnapshot }) {
  const pace = useContext(PaceContext);
  if (!pace || hud.mode !== 'match') return null;
  const ref = pace.curve ? paceAt(pace.curve, hud.phase, hud.timeLeft) : null;
  const delta = ref == null ? null : Math.max(0, hud.score.total - hud.oppScore.foulPoints) - ref;
  const label =
    delta == null
      ? pace.why || `Pace against ${pace.tag}`
      : `${delta === 0 ? 'Level with' : `${Math.abs(delta)} ${delta > 0 ? 'ahead of' : 'behind'}`} ${pace.tag} at this point`;
  const tone = delta == null || delta === 0 ? 'level' : delta > 0 ? 'ahead' : 'behind';
  return (
    <span className={`pace ${tone}`} title={label} aria-label={label}>
      {delta == null ? '—' : fmtPace(delta)} {pace.tag}
    </span>
  );
}
