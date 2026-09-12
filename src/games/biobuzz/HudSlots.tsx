import type { HudSnapshot } from '../../game';
import type { GameBuilderProps, GameHudProps, ResultsSection } from '../module';
import { BiobuzzBuilder } from './Builder';
import type { BiobuzzHud } from './hudRobot';
import { BB_MODE_LABELS } from './labels';

/**
 * The BIOBUZZ UI SLOTS that need JSX — the builder adapter, the two live-HUD slots and the
 * results breakdown. `index.ts` stays a plain registration, like `chain/index.ts`, because a
 * `.tsx` module index would be the one file in `src/games/` that resolves differently.
 *
 * Everything here reads `HudSnapshot.gameHud`, which is the game's own HUD slice
 * (`GameSimModule.hud` → `hudRobot.ts`'s `biobuzzHud`). It is typed `unknown` at the seam on
 * purpose: only this game's own components know its shape, so the cast happens HERE, once, in
 * `sliceOf`, rather than at every read.
 */

/** the game's HUD slice off the snapshot. Undefined when a snapshot predates this game. */
const sliceOf = (hud: HudSnapshot): BiobuzzHud | undefined => hud.gameHud as BiobuzzHud | undefined;

/**
 * The BUILDER props ADAPTER.
 *
 * The slot hands over `{ spec, onChange, game }` — a PARTIAL patch callback, because a builder
 * must not know where a spec is stored — and `BiobuzzBuilder` takes `{ spec, setSpec }`, which
 * is the same contract under this game's own spelling. `game` is dropped: a per-game builder
 * already knows which game it is, and reading it would be the first step back toward one
 * component with a branch per season.
 */
export function BiobuzzBuilderSlot({ spec, onChange }: GameBuilderProps) {
  return <BiobuzzBuilder spec={spec} setSpec={onChange} />;
}

/**
 * The ROBOT-level chips in the live HUD's `.robot-status` row.
 *
 * Exactly the two facts `hudRobot.ts` argues a BIOBUZZ driver needs and cannot infer: how full
 * the hopper is (it decides whether to go collect or go score) and which archetype's rules are
 * in force (it decides whether the fire button STEERS the chassis). Rendered INSIDE the
 * existing row, so it inherits the chip styles and the touch-layout suppression.
 *
 * ALLIANCE-level facts are the score bar's, not this row's — see `BiobuzzScoreBar`.
 */
export function BiobuzzHudChips({ hud }: GameHudProps) {
  const r = sliceOf(hud)?.robot;
  if (!r) return null;
  return (
    <>
      <span className="chip">{BB_MODE_LABELS[r.mode].toUpperCase()}</span>
      <span className={`chip ${r.hopper >= r.cap ? 'on' : ''}`}>
        HOPPER {r.hopper}/{r.cap}
      </span>
    </>
  );
}

const PHASE_LABEL: Record<HudSnapshot['phase'], string> = {
  pre: 'PRE-MATCH',
  auto: 'AUTONOMOUS',
  transition: 'TRANSITION',
  teleop: 'DRIVER-CONTROLLED',
  post: 'FINAL',
  freeplay: 'FREE DRIVE',
};

const fmtTime = (s: number): string => {
  const t = Math.max(0, Math.ceil(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

/**
 * The whole bottom bar — red | timer | blue, then a BIOBUZZ breakdown row.
 *
 * It exists because the SHARED bar is DECODE's: it draws the motif dots and the
 * CLASSIFIED / OVERFLOW / PATTERN / RAMP breakdown for every game that is not Chain Reaction,
 * and BIOBUZZ has neither a motif nor any of those four. The LAYOUT is the shared one on
 * purpose (the same `scorebar` / `score-panel` / `timer-panel` classes), so it themes
 * identically and a driver who plays two games reads the same bar in both.
 *
 * The panels show POLLEN SCORED, which is structurally 0 in the shell, and the breakdown row
 * says so out loud. That is the honest rendering of `scored: false`: a bar that quietly read
 * 0-0 looks like a scoring bug rather than like a game whose Scoring section is a Kickoff
 * placeholder.
 */
export function BiobuzzScoreBar({ hud }: GameHudProps) {
  const f = sliceOf(hud)?.field;
  const red = f?.scored.red ?? 0;
  const blue = f?.scored.blue ?? 0;
  const urgent = hud.timeLeft <= 10 && (hud.phase === 'auto' || hud.phase === 'teleop');
  if (hud.mode !== 'match') {
    return (
      <div className="scorebar">
        <div className="timer-panel">
          <span className="timer-phase">FREE DRIVE</span>
        </div>
      </div>
    );
  }
  return (
    <>
      <div className="scorebar">
        <div className={`score-panel red ${hud.alliance === 'red' ? 'mine' : ''}`}>
          {hud.alliance === 'red' && <span className="you-tag">YOU</span>}
          <span className="panel-score">{red}</span>
        </div>
        <div className={`timer-panel ${urgent ? 'urgent' : ''}`}>
          {/* status on the PHASE only — the digits beside it retick every frame and would
              flood a screen reader. This changes ~4 times a match. */}
          <span className="timer-phase" role="status">
            {PHASE_LABEL[hud.phase]}
          </span>
          <span className="timer-time">{hud.phase === 'post' ? '0:00' : fmtTime(hud.timeLeft)}</span>
        </div>
        <div className={`score-panel blue ${hud.alliance === 'blue' ? 'mine' : ''}`}>
          {hud.alliance === 'blue' && <span className="you-tag">YOU</span>}
          <span className="panel-score">{blue}</span>
        </div>
      </div>
      <div className="breakdown-row">
        <span>POLLEN SCORED {red + blue}</span>
        <span>UNSCORED SHELL &mdash; SCORING LANDS AT KICKOFF</span>
      </div>
    </>
  );
}

/**
 * The results-screen breakdown. Rows are ALLIANCE-RELATIVE (`[label, mine, opp]`) because the
 * two screens want different things from the same numbers: the versus results print
 * red | blue, and a solo record run has no opponent column at all.
 *
 * Two sections and no more: what this game scores (nothing yet, stated as a row rather than
 * hidden) and the fouls, which are the ONLY points a shell match can actually produce —
 * `play.ts`'s score pass sets each alliance's total to its `foulPoints` and nothing else.
 */
export function biobuzzResultsRows(hud: HudSnapshot): readonly ResultsSection[] {
  const f = sliceOf(hud)?.field;
  const mine = hud.alliance === 'red' ? (f?.scored.red ?? 0) : (f?.scored.blue ?? 0);
  const opp = hud.alliance === 'red' ? (f?.scored.blue ?? 0) : (f?.scored.red ?? 0);
  return [
    ['SCORING (UNSCORED SHELL)', [['Pollen scored', mine, opp]]],
    ['PENALTIES', [['Fouls awarded', hud.score.foulPoints, hud.oppScore.foulPoints]]],
  ];
}
