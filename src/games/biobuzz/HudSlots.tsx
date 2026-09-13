import type { Alliance } from '../../types';
import type { HudSnapshot } from '../../game';
import type { GameBuilderProps, GameHudProps, ResultsSection } from '../module';
import { BiobuzzBuilder } from './Builder';
import { BB_RP } from './config';
import type { BbCellHud, BiobuzzFieldHud } from './hud';
import type { BiobuzzHud } from './hudRobot';
import { BB_MODE_LABELS } from './labels';
import type { BbAllianceScore, BbRankPoints } from './score';

/**
 * The BIOBUZZ UI SLOTS that need JSX — the builder adapter, the two live-HUD slots and the
 * results breakdown. `index.ts` stays a plain registration, like `chain/index.ts`, because a
 * `.tsx` module index would be the one file in `src/games/` that resolves differently.
 *
 * Everything here reads `HudSnapshot.gameHud`, which is the game's own HUD slice
 * (`GameSimModule.hud` → `hudRobot.ts`'s `biobuzzHud`). It is typed `unknown` at the seam on
 * purpose: only this game's own components know its shape, so the cast happens HERE, once, in
 * `sliceOf`, rather than at every read.
 *
 * ── WHY THIS FILE CARRIES SO MUCH OF THE GAME ───────────────────────────────
 * The BIOBUZZ field draws STATE and never text: a CELL's contents are a row of discs, a
 * FLOWER's stack is a column of discs outside the wall, and there are no letters or digits
 * anywhere in a match (field-plan §2.5, owner ruling 2026-09-12). Everything a driver has to
 * COUNT rather than SEE therefore has to be here, and `hud.ts` exists to supply exactly that
 * list. A chip removed from this file is a number a driver cannot get any other way.
 */

/** the game's HUD slice off the snapshot. Undefined when a snapshot predates this game. */
const sliceOf = (hud: HudSnapshot): BiobuzzHud | undefined => hud.gameHud as BiobuzzHud | undefined;

/** the OTHER alliance. One spelling, because the results rows need it on every line. */
const other = (a: Alliance): Alliance => (a === 'red' ? 'blue' : 'red');

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
 * THE UP-CELL LINE: how many more POLLEN would TIP this alliance's HIVE.
 *
 * A NUMBER, never a word. `BB_TIP_POLLEN` is a measured table indexed by the NECTAR count
 * (reference §4.1) — 3 NECTAR takes 3 POLLEN, 2 takes 6 — so "a few more" is not something a
 * driver can act on, and it is not derivable from the discs the field draws. `needed` 0 means
 * the next element takes it and still prints as 0 rather than as READY: every other value
 * this line shows is a count of shots, and so is that one.
 *
 * TIPPING wins over the number for the 4 s of the swing, because the CELL accepts nothing
 * while it moves (`hiveAccepts`) — a launcher that keeps firing at it is emptying its hopper
 * onto the floor.
 */
const cellLine = (c: BbCellHud | undefined): string =>
  !c ? '' : c.tipping > 0 ? 'TIPPING' : `${c.needed} MORE TO TIP`;

const fmtTime = (s: number): string => {
  const t = Math.max(0, Math.ceil(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

/**
 * The chips in the live HUD's `.robot-status` row — the DRIVER'S ALLIANCE ONLY.
 *
 * The split with the score bar is by AUDIENCE, not by subject: the bar is the audience
 * display and prints both alliances, this row is the driver's own strip and prints the facts
 * that change what THEY do next. So the robot half (hopper, archetype) and the alliance half
 * (own CELL, own NECTAR supply) both belong here, and the opponent's numbers do not.
 *
 * G410 IS DELIBERATELY IN BOTH. `GameView` suppresses this whole row on a coarse pointer, so
 * on a phone the bar's chip is the only NECTAR LOCKED there is — and a MAJOR 20 per NECTAR
 * entered one second early is not a rule to leave to a cue the device does not render. The
 * bar's chip carries the countdown, because it is the field-wide cue; this one is the
 * driver's own state.
 */
export function BiobuzzHudChips({ hud }: GameHudProps) {
  const s = sliceOf(hud);
  const f = s?.field;
  const r = s?.robot;
  const cell = f?.cells[hud.alliance];
  const due = f?.nectarDue[hud.alliance] ?? 0;
  return (
    <>
      {r && <span className="chip">{BB_MODE_LABELS[r.mode].toUpperCase()}</span>}
      {r && (
        <span className={`chip ${r.hopper >= r.cap ? 'on' : ''}`}>
          HOPPER {r.hopper}/{r.cap}
        </span>
      )}
      {cell &&
        (cell.tipping > 0 ? (
          <span className="chip prompt">CELL TIPPING</span>
        ) : (
          <span className="chip">CELL {cell.needed} MORE</span>
        ))}
      {/* STOCK AND DUE ON ONE CHIP, because they are one fact: what the human player can
          still enter. Two chips cost ~130px on a row that is `nowrap`, right-anchored and
          grows LEFTWARD into the sponsor mark — measured at 1440px with the alpha pose
          readout on, a sixth chip put the archetype behind the mark. */}
      {f && (
        <span className={`chip ${due > 0 ? 'on' : ''}`}>
          NECTAR {f.nectarStock[hud.alliance]}
          {due > 0 ? ` · ${due} DUE` : ''}
        </span>
      )}
      {f?.nectarLocked && <span className="chip warn">NECTAR LOCKED</span>}
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

/**
 * The whole bottom bar — red | timer | blue, each alliance's up-CELL line under its total,
 * and the G410 cue above.
 *
 * It exists because the SHARED bar is DECODE's: it draws the motif dots for every game that
 * is not Chain Reaction, and BIOBUZZ has no motif. The LAYOUT is the shared one on purpose
 * (the same `scorebar` / `score-panel` / `timer-panel` classes), so it themes identically and
 * a driver who plays two games reads the same bar in both. The one addition is the sub-line,
 * which is `.score-panel.bb` stacking its children instead of centring one.
 *
 * The panels show the alliance TOTAL, read from the shared `ScoreBreakdown` rather than from
 * `score[a].total`: the shared number already folds in foul points and already reads 0 for a
 * VOIDED alliance, and a bar that disagreed with the results screen about who is winning
 * would be worse than either number on its own.
 */
export function BiobuzzScoreBar({ hud }: GameHudProps) {
  const f = sliceOf(hud)?.field;
  const red = hud.alliance === 'red' ? hud.score.total : hud.oppTotal;
  const blue = hud.alliance === 'blue' ? hud.score.total : hud.oppTotal;
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
      {/* G410: a NECTAR into a FLOWER before the 1:00 cue is a MAJOR, PER NECTAR. On a real
          field the cue is audio; here it has to be readable from the driver's station, so it
          sits on the bar rather than only in the desktop-only chip row. `nectarIn` is null
          outside TELEOP, where a countdown would be a guess at the remaining AUTO — so the
          chip states the lock and says nothing about when. */}
      {f?.nectarLocked && (
        <div className="breakdown-row">
          <span>NECTAR LOCKED{f.nectarIn === null ? '' : ` ${fmtTime(f.nectarIn)}`}</span>
        </div>
      )}
      <div className="scorebar">
        <div className={`score-panel bb red ${hud.alliance === 'red' ? 'mine' : ''}`}>
          {hud.alliance === 'red' && <span className="you-tag">YOU</span>}
          <span className="panel-score">{red}</span>
          <span className={`bb-tip ${f && f.cells.red.tipping > 0 ? 'go' : ''}`}>
            {cellLine(f?.cells.red)}
          </span>
        </div>
        <div className={`timer-panel ${urgent ? 'urgent' : ''}`}>
          {/* status on the PHASE only — the digits beside it retick every frame and would
              flood a screen reader. This changes ~4 times a match. */}
          <span className="timer-phase" role="status">
            {PHASE_LABEL[hud.phase]}
          </span>
          <span className="timer-time">{hud.phase === 'post' ? '0:00' : fmtTime(hud.timeLeft)}</span>
        </div>
        <div className={`score-panel bb blue ${hud.alliance === 'blue' ? 'mine' : ''}`}>
          {hud.alliance === 'blue' && <span className="you-tag">YOU</span>}
          <span className="panel-score">{blue}</span>
          <span className={`bb-tip ${f && f.cells.blue.tipping > 0 ? 'go' : ''}`}>
            {cellLine(f?.cells.blue)}
          </span>
        </div>
      </div>
    </>
  );
}

/**
 * The results-screen breakdown — every line of Table 10-2 (§10.5, p91), then the RPs.
 *
 * Rows are ALLIANCE-RELATIVE (`[label, mine, opp]`) because the two screens want different
 * things from the same numbers: the versus results print red | blue, and a solo record run
 * has no opponent column at all.
 *
 * ── COUNTS AND POINTS, BOTH ─────────────────────────────────────────────────
 * Every achievement that has both gets two rows. A points-only table cannot be checked
 * against the field — GARDEN 7 is seven elements at 1 each, and nothing on the screen says
 * so — and a count-only table does not add up to the total printed under it. The
 * parenthetical names the unit, and it is the same word on every row that shares one.
 *
 * ── THERE IS NO TOTAL ROW HERE, DELIBERATELY ────────────────────────────────
 * Both consumers append their own (`GameView`'s `total-row`, off the shared
 * `ScoreBreakdown.total`), so a second one would print the number twice — and would DISAGREE
 * with it on a VOIDED match, where the shared row reads 0 over a full breakdown on purpose.
 * RANKING POINTS is therefore the last section and the screen's own TOTAL closes the table.
 *
 * RPs print as 1 / 0, because a section row is `[label, number, number]`. The threshold goes
 * in the label rather than in a legend: a bare 0 in a numeric column says nothing about what
 * would have earned it. The numbers come from `BB_RP`, so a label cannot drift from the test
 * that sets the flag.
 */
export function biobuzzResultsRows(hud: HudSnapshot): readonly ResultsSection[] {
  const f: BiobuzzFieldHud | undefined = sliceOf(hud)?.field;
  const me = hud.alliance;
  const opp = other(me);
  /** one breakdown field, alliance-relative. An absent slice reads 0, never throws. */
  const n = (s: BbAllianceScore | undefined, k: keyof BbAllianceScore): number => s?.[k] ?? 0;
  const row = (label: string, k: keyof BbAllianceScore) =>
    [label, n(f?.score[me], k), n(f?.score[opp], k)] as const;
  const rp = (label: string, k: keyof BbRankPoints) =>
    [label, f?.rp[me][k] ? 1 : 0, f?.rp[opp][k] ? 1 : 0] as const;
  return [
    [
      'AUTONOMOUS',
      [
        row('LEAVE (robots)', 'leaveCount'),
        row('LEAVE (points)', 'leave'),
        row('PARK (robots)', 'parkAutoCount'),
        row('PARK (points)', 'parkAuto'),
      ],
    ],
    ['END OF MATCH', [row('PARK (robots)', 'parkTeleCount'), row('PARK (points)', 'parkTele')]],
    [
      'HIVE',
      [
        row('TIPS (count)', 'tips'),
        row('TIPS (points)', 'tipPts'),
        row('Up CELL contents (elements)', 'cellCount'),
        row('Up CELL contents (points)', 'cellPts'),
      ],
    ],
    [
      'FLOWER',
      [
        row('OWNED FLOWER (elements)', 'ownedCount'),
        row('OWNED FLOWER (points)', 'ownedPts'),
        row('Bottom NECTAR Bonus (FLOWERS)', 'bottomCount'),
        row('Bottom NECTAR Bonus (points)', 'bottomPts'),
      ],
    ],
    ['GARDEN', [row('GARDEN (elements)', 'gardenCount'), row('GARDEN (points)', 'gardenPts')]],
    // points AWARDED to each alliance, i.e. earned from the OPPONENT's violations — the same
    // direction the shared breakdown prints, so the two reconcile against their totals.
    ['PENALTIES', [row('Fouls awarded (points)', 'foul')]],
    [
      'RANKING POINTS',
      [
        rp(`SWARM (${BB_RP.swarm} LEAVE + PARK points)`, 'swarm'),
        rp(`POLLINATOR 1 (${BB_RP.pollinator1} TIPS)`, 'pollinator1'),
        rp(`POLLINATOR 2 (${BB_RP.pollinator2} TIPS)`, 'pollinator2'),
      ],
    ],
  ];
}
