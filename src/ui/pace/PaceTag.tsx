import { createContext, useContext } from 'react';
import type { HudSnapshot } from '../../game';
import { paceAt, type PaceCurve } from './curve';

/**
 * THE PACE READ-OUT: `+12 PB`, a small TAB on the top edge of your own alliance's score panel.
 *
 * OUTSIDE THE PANEL, NOT IN IT (owner, 2026-10-08: it "broke the clean, symmetrical scoring look"):
 * under the total it stacked a fourth line into a BIOBUZZ panel, and beside the total it pushed
 * the total off centre. As a tab the two alliance panels are identical whether or not the match
 * is paced. GREEN ahead, RED behind, plain ink level — on the tab's own HUD fill, not the
 * alliance chip, which could not carry a third colour at AA. It is there from the first frame of
 * a paced match whether or not the curve has arrived, so nothing moves mid-match: `—` until
 * there is a number. A band (`data-hud-band`): the field fit keeps clear of it.
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
    <span className={`pace-tab ${tone}`} title={label} aria-label={label} data-hud-band>
      {delta == null ? '—' : fmtPace(delta)} {pace.tag}
    </span>
  );
}
