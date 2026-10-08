import { createContext, useContext } from 'react';
import type { HudSnapshot } from '../../game';
import { paceAt, type PaceCurve } from './curve';

/**
 * THE PACE READ-OUT IN THE SCORE BAR: `+12` over `PB`, beside your own alliance's score.
 *
 * Beside the total, not under it: under it, a BIOBUZZ panel stacked four things (YOU, the total,
 * the tip line, the pace) and its total rode up out of line with the other alliance's. In the
 * panel you already read, in its own ink, and nothing else — no colour for ahead or behind (the
 * sign says it, and the chip fill would not carry a third colour at AA), no popup, no sound. It
 * is there from the first frame of a paced match whether or not the curve has arrived, and it
 * holds a fixed width, so the bar never changes size mid-match: `—` until there is a number.
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
  // two short lines beside the total: the number, and what it is measured against under it
  return (
    <span className="pace-tag" title={label} aria-label={label}>
      <span className="pace-d">{delta == null ? '—' : fmtPace(delta)}</span>
      <span className="pace-k">{pace.tag}</span>
    </span>
  );
}
