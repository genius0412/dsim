import { useRef } from 'react';
import type { Alliance } from '../../types';
import type { HudSnapshot } from '../../game';
import type { ArtifactColor } from '../../types';
import type { GameBuilderProps, GameHudProps, ResultsSection } from '../module';
import { fmtTime, timerPanel } from '../../ui/timerPanel';
import { FoulChip } from '../../ui/FoulChip';
import { PaceTag } from '../../ui/pace/PaceTag';
import { BiobuzzBuilder } from './Builder';
import { BbPassPicker } from './PassPicker';
import { BB_NECTAR_COUNT, BB_PTS } from './config';
import type { BbCellHud, BbPinHud, BiobuzzFieldHud } from './hud';
import type { BiobuzzHud } from './hudRobot';
import type { BbAllianceScore } from './score';

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
 *
 */
export function BiobuzzBuilderSlot({ spec, onChange, hideFrame }: GameBuilderProps) {
  return <BiobuzzBuilder spec={spec} setSpec={onChange} hideFrame={hideFrame} />;
}

/**
 * The DRIVING-panel rows: where PASS throws (owner, 2026-09-23: it was a Build block, under the
 * launcher). `alliance`/`startIndex`/`startPose` are defaulted to `'blue'`/`0`/`undefined` HERE,
 * so the one fallback lives at the seam every other slot's optional prop is resolved at — the
 * picker's `from` needs them.
 */
export function BiobuzzDrivingSlot({ spec, onChange, alliance, startIndex, startPose }: GameBuilderProps) {
  return (
    <BbPassPicker
      spec={spec}
      alliance={alliance ?? 'blue'}
      startIndex={startIndex ?? 0}
      startPose={startPose}
      onChange={onChange}
    />
  );
}

/** the words for one held element, for the row's accessible name. POLLEN is yellow; a NECTAR
 * is named by its alliance colour because whose NECTAR it is decides what it may do. */
const HELD_WORD: Partial<Record<ArtifactColor, string>> = {
  yellow: 'POLLEN',
  red: 'red NECTAR',
  blue: 'blue NECTAR',
};

/** "Holding 2 POLLEN, 1 red NECTAR. Next out: red NECTAR" — the disc row said in words. */
function heldPhrase(held: readonly ArtifactColor[]): string {
  if (held.length === 0) return 'Holding nothing';
  const word = (c: ArtifactColor): string => HELD_WORD[c] ?? c;
  const counts = (['yellow', 'red', 'blue'] as const)
    .map((c) => [c, held.filter((h) => h === c).length] as const)
    .filter(([, n]) => n > 0)
    .map(([c, n]) => `${n} ${word(c)}`);
  return `Holding ${counts.join(', ')}. Next out: ${word(held[held.length - 1])}`;
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
 * TIPPING wins over the number for the 4 s of the swing. The HIVE does keep taking elements
 * through it (`hiveTakingSide`), but which tray it is putting them in changes at the release,
 * so a count of "more to tip" against a moving bar is a number about to be answered by a
 * different cell.
 */
const cellLine = (c: BbCellHud | undefined): string =>
  !c ? '' : c.tipping > 0 ? 'TIPPING' : `${c.needed} MORE TO TIP`;

/** seconds a G407 CONTROL warning stays on screen after the count moves. */
const BB_WARN_HOLD_S = 3;

/**
 * THE PIN THAT BILLS SOONEST, or null when nobody is pinning.
 *
 * `pins` is usually empty and holds more than one entry only in a genuine multi-robot tangle.
 * The chip shows ONE, and it is the one with the least time left on its tariff: every entry
 * carries the same 20-point-per-3-second clock, so the soonest is the only one whose number
 * changes what either driver does in the next second. PAUSED pins are skipped — their clock
 * is not moving, and a frozen countdown is not a warning.
 */
const soonestPin = (pins: readonly BbPinHud[] | undefined): BbPinHud | null => {
  const live = pins?.filter((p) => p.counting) ?? [];
  return live.length === 0 ? null : live.reduce((a, b) => (b.nextIn < a.nextIn ? b : a));
};

/**
 * THE PIN LINE. `PIN · 20 IN 1.4 S` — the ACT, the tariff, and the seconds until it lands.
 *
 * ONE DECIMAL, and that is the point of the line. `nextIn` runs 3 → 0 and a whole-second
 * readout would spend a third of every tariff cycle showing the same digit while 20 points
 * moved; the tenths are what make it read as a countdown rather than as a label. `billed` is
 * appended only once it is non-zero, because a PIN that has not yet cost anything is a warning
 * and a PIN that has is a running bill, and the driver reaction to the two is different.
 */
const pinLine = (p: BbPinHud): string =>
  `PIN · ${BB_PTS.foulMajor} IN ${p.nextIn.toFixed(1)} S` +
  (p.billed > 0 ? ` · ${p.billed * BB_PTS.foulMajor} BILLED` : '');

// 8 NECTAR/alliance = 3 staged in the HIVE at kickoff + 5 stock (spawn.ts's NECTAR_PER_CELL /
// NECTAR_STOCK — Lane A constants, not exported, so this total is kept in sync by comment
// rather than a cross-lane import). BB_NECTAR_COUNT (config.ts) is the total's single source
// of truth.
const NECTAR_STAGED = 3;
const NECTAR_STOCK_MAX = BB_NECTAR_COUNT - NECTAR_STAGED;

/** the NECTAR dot row's accessible name — the dots carry no text, so this says the same
 * thing in words: how many are placed, how many are left, and whether a press does anything. */
function nectarPhrase(placed: number, stock: number, available: boolean, ringed: number): string {
  const parts = [`${NECTAR_STAGED + placed} placed`, `${stock} in stock`];
  if (available) parts.push(ringed > 0 ? `${ringed} due now` : 'available');
  return `Nectar: ${parts.join(', ')}.`;
}

/**
 * THE PENDING LINE — what this alliance has SATISFIED but has not been AWARDED yet.
 *
 * §10.5 assesses LEAVE and AUTO PARK at the end of AUTO (F), TELEOP PARK at the end of the
 * MATCH (G), and the up-CELL contents and the GARDEN once everything has come to rest (C, E).
 * `score.ts` pays each of those exactly zero until its instant has passed (owner ruling,
 * 2026-09-19) — before that, a robot clear of the perimeter and sitting in its own LOADING
 * ZONE moves the score bar by nothing at all.
 *
 * Which is correct and, on its own, unreadable: a driver who has just done the right thing
 * sees no acknowledgement, and a bar that never moves reads as broken. So the amount the
 * instants still owe gets a chip of its own, in the muted chip row rather than in the panel,
 * because the one thing it must never look like is part of the total. `+` and PENDING both say
 * so; `score.ts` guarantees `total + pendingPts` is the same number all match for a field that
 * stops changing, so the chip is a promise the score will keep.
 *
 * Empty at 0, like every other chip in this row — nothing satisfied, nothing to say. The ROW
 * is what is always mounted (see the band note in `BiobuzzScoreBar`); the spans inside it come
 * and go, which is the pattern the row's reserved `min-height` exists for.
 */
const pendingLine = (f: BiobuzzFieldHud | undefined, a: Alliance): string => {
  const n = f?.score[a].pendingPts ?? 0;
  return n > 0 ? `+${n} PENDING` : '';
};


/**
 * A CHIP THAT HAS TO OUTLIVE ITS FACT.
 *
 * `warnings` is a monotonic COUNT — G407 moves it by one on the tick a robot takes CONTROL of
 * a fifth SCORING ELEMENT, and it never comes back down. A chip bound to the count itself
 * would therefore be a chip that appears once and then stays up for the rest of the match,
 * which is not what a warning is. So it is bound to the MOMENT the count moved, and held for
 * `BB_WARN_HOLD_S` after it.
 *
 * THE CLOCK IS THE MATCH CLOCK, not `Date.now()`. `GameView` re-samples the HUD every 100 ms
 * and match time is already on the props, so the hold costs no timer of its own: it PAUSES
 * when the match does and it is identical on a replay of the same match, neither of which is
 * true of a `setTimeout`. 100 ms of resolution on a 3 s hold is a 3% error on when the chip
 * goes away, which is not a number anybody reads.
 *
 * `timeLeft` counts DOWN inside a phase and JUMPS UP at a phase boundary, so the hold is only
 * ever measured within ONE phase: a warning drawn in the last second of AUTO does not carry a
 * stale chip into TELEOP, and the arithmetic never sees a negative elapsed.
 */
function useHeldBump(count: number, timeLeft: number, phase: string, hold: number): boolean {
  // `at` starts at -Infinity so a HUD that MOUNTS onto a match already carrying warnings (a
  // spectator joining late, a replay scrubbed into the middle) does not flash one that was
  // drawn before it was watching.
  const seen = useRef({ count, at: -Infinity, phase });
  const s = seen.current;
  if (count !== s.count || phase !== s.phase) {
    s.at = count > s.count && phase === s.phase ? timeLeft : -Infinity;
    s.count = count;
    s.phase = phase;
  }
  const since = s.at - timeLeft;
  return since >= 0 && since < hold;
}

/**
 * The chips in the live HUD's `.robot-status` row — the DRIVER'S ROBOT and the DRIVER'S
 * ALLIANCE ONLY.
 *
 * The split with the score bar is by AUDIENCE, not by subject: the bar is the audience
 * display and prints both alliances, this row is the driver's own strip and prints the facts
 * that change what THEY do next. So the robot half and the alliance half (own CELL, own NECTAR
 * supply) both belong here, and the opponent's numbers do not.
 *
 * TWO COLUMNS, dots only, no wording anywhere (owner ruling 2026-09-12 extended to every chip
 * in this card):
 *  - LEFT, top-aligned: STORAGE — one disc per held element, coloured by element, then a
 *    hollow ring per free slot up to the cap (NEXT-OUT FIRST: the leftmost filled disc carries
 *    the `.next` ring). Under it, bottom-aligned: the FLOWER icon (grey while G410 locks entry,
 *    alliance-yellow once it opens, ringed while `flowerInReach`).
 *  - RIGHT, top-aligned: NECTAR — 8 dots per alliance (see the color/ring rule at
 *    `nectarPhrase`, below). Removed 2026-09-19 and restored 2026-09-22 at the owner's request
 *    — the human player's box is where the NECTAR physically sits, but the drive team still
 *    reads this corner, not the pit.
 * The PIN countdown and the CONTROL 5+ warning do NOT live here — both are transient calls to
 * action rather than standing facts, so `BiobuzzPinnedNotice` renders them above the event log
 * instead (see there).
 * Every row's accessible name says the same thing in words, since the dots carry no text.
 */
export function BiobuzzHudChips({ hud }: GameHudProps) {
  const s = sliceOf(hud);
  const f = s?.field;
  const r = s?.robot;
  const due = f?.nectarDue[hud.alliance] ?? 0;
  const held = r?.held ?? [];
  const free = r ? Math.max(0, r.cap - held.length) : 0;
  const said = heldPhrase(held);

  const stock = f?.nectarStock[hud.alliance] ?? 0;
  const placed = NECTAR_STOCK_MAX - stock;
  const available = f?.nectarWhy[hud.alliance] === 'ok';
  // the dump window: past the 1:00 cue the WHOLE remaining stock may go in with nothing
  // banked, so `due` reads 0 while a press is still granted — ring every dot left in stock.
  const ringCount = !available ? 0 : due > 0 ? Math.min(due, stock) : stock;
  const nectarSaid = nectarPhrase(placed, stock, available, ringCount);

  // G410: grey while locked, alliance-yellow once the FLOWERS open — a standing fill, not a
  // flash (contrast a G407 warning, which genuinely only matters for a few seconds).
  const flowerOpen = f?.nectarLocked === false;
  const flowerSaid = `FLOWER ${flowerOpen ? 'open' : 'locked'}${r?.flowerInReach ? ', in reach' : ''}.`;

  return (
    <div className="bb-hud">
      <div className="bb-hud-left">
        {/* NO ARCHETYPE CHIP. The launcher's name is a thing the driver CHOSE in the builder
            and cannot change mid-match, so it told them nothing they did not already know
            while costing the width of the longest label in `BB_MODE_LABELS`
            ("DOUBLE TURRET"). What the launcher's rules actually DO to the controls is already
            in the controls themselves; the hopper column beside it is the part that changes. */}
        {r && (
          <div className="hopper vertical" role="img" aria-label={said}>
            {[...held].reverse().map((c, i) => (
              <span key={`h${i}`} className={`hopper-pip ${c}${i === 0 ? ' next' : ''}`} />
            ))}
            {Array.from({ length: free }, (_, i) => (
              <span key={`e${i}`} className="hopper-pip empty" />
            ))}
          </div>
        )}
        {/* NO CELL CHIP. `BiobuzzScoreBar` already prints this alliance's up-CELL line under
            its own score panel — `cellLine`, the same two states ("n MORE TO TIP" / "TIPPING")
            this card used to carry, in the place a driver already watches for the score. */}
        {/* THE FLOWER ICON replaces the old FLOWER IN REACH / FLOWERS OPEN text chips — G410's
            lock is the fill (grey/open), `flowerInReach` is the ring. CONTROL 5+ used to sit
            beside it here; it now lives in the event log with the PIN countdown, below, since
            both are transient calls to action rather than a standing fact like this icon. */}
        {f && (
          <span
            className={`flower-icon${flowerOpen ? ' open' : ''}${r?.flowerInReach ? ' reach' : ''}`}
            role="img"
            aria-label={flowerSaid}
          />
        )}
      </div>
      {/* THE NECTAR COLUMN. The 3 staged dots are always alliance-coloured. Of the 5 stock
          dots: already-placed ones (`i < placed`) are alliance-coloured too, and never ringed
          — a placed dot isn't due any more. Of the rest, `nectarWhy === 'ok'` turns a dot from
          grey to alliance-coloured the moment a press would succeed, whether or not it has
          been pressed yet; the ring layers ON TOP of that colour, for the ones within
          `ringCount`, and is never drawn on a grey dot. */}
      {f && (
        <div className="bb-hud-right">
          <div className="hopper vertical" role="img" aria-label={nectarSaid}>
            {Array.from({ length: NECTAR_STAGED }, (_, i) => (
              <span key={`ns${i}`} className={`hopper-pip ${hud.alliance}`} />
            ))}
            {Array.from({ length: NECTAR_STOCK_MAX }, (_, i) => {
              const isPlaced = i < placed;
              const colored = isPlaced || available;
              const ringed = !isPlaced && i - placed < ringCount;
              return (
                <span
                  key={`nk${i}`}
                  className={`hopper-pip${colored ? ` ${hud.alliance}` : ' grey'}${ringed ? ' due' : ''}`}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * THE TWO LIVE WARNINGS, pinned above the event log's toasts while either is active — a PIN's
 * countdown and G407's CONTROL 5+.
 *
 * `BbPinHud.nextIn` ticks continuously, which is exactly the shape the toast log cannot hold —
 * a toast decays after 2.5 s and would have to re-fire every frame to stay lit, which is not a
 * toast, it is a second HUD. CONTROL 5+ isn't continuous the same way, but it is still a call
 * to action rather than a fact ("do something differently right now"), which is what belongs
 * in the driver's eyeline rather than parked as furniture in the HUD card — so it moved here
 * alongside PIN rather than getting a bespoke third home. Both read the live slice directly,
 * through the `pinnedNotice` slot (`GameModule`), and the component renders nothing when
 * neither is active.
 *
 * PIN'S NEUTRAL COLOUR IS DELIBERATE, AND IT IS A GAP: the line cannot yet say whether THIS
 * alliance is the one pinning or the one being held. `BbPinHud` carries robot IDs, and nothing
 * that reaches a HUD component maps an ID to an alliance — `HudSnapshot` has no roster and no
 * local robot ID, and the slice's robot half (Lane B's `hudRobot.ts`) has no ID either. A PIN
 * is always cross-alliance, so the line is always relevant to whoever is reading it and the
 * COUNTDOWN is the same number for both sides (let go / keep trying); only the colour split is
 * blocked. Requested of the master: one `pinnerAlliance: Alliance` on `BbPinHud` and this
 * becomes two differently-coloured lines.
 */
export function BiobuzzPinnedNotice({ hud }: GameHudProps) {
  const f = sliceOf(hud)?.field;
  const pin = soonestPin(f?.pins);
  // G407. The hook runs on every sample, including the ones where an absent slice reads 0, so
  // the hold is measured against the same clock the rest of the HUD is drawn from.
  const warned = useHeldBump(f?.warnings[hud.alliance] ?? 0, hud.timeLeft, hud.phase, BB_WARN_HOLD_S);
  // ...and whether it has climbed all the way to the STRATEGIC MAJOR (owner ruling 2026-09-19).
  // A flag, not a held bump: the MAJOR is a per-MATCH latch, so once it is true it stays the
  // fact for the rest of the match, the same way a red card would.
  const majored = f?.controlMajor[hud.alliance] ?? false;
  if (!pin && !warned && !majored) return null;
  return (
    <>
      {/* G407 — CONTROL of a fifth SCORING ELEMENT. The owner's ruling makes this a WARNING
          worth no points and no card, which is exactly why it needs a line: a sanction that
          moves no number is invisible on a scoreboard unless something says it happened. Held
          `BB_WARN_HOLD_S` off the match clock (see `useHeldBump`), because the underlying count
          never comes back down.
          ONCE THE STRATEGIC MAJOR BILLS, the line SWITCHES rather than adds a second one: same
          slot, `.eventlog-pinned.bad` in place of the plain warn colour, so the driver sees the
          escalation coming without a log that grows. `majored` is a latch, not a held bump, so
          the line stays up for the rest of the match once it is true. */}
      {(warned || majored) && (
        <div className={`eventlog-line eventlog-pinned${majored ? ' bad' : ''}`}>
          {majored ? 'CONTROL 5+ MAJOR' : 'CONTROL 5+'}
        </div>
      )}
      {/* G421 — a PIN, counting. 20 points every three seconds, and the clock runs in a
          referee's head, so `nextIn` is the only warning either driver gets. */}
      {pin && <div className="eventlog-line eventlog-pinned">{pinLine(pin)}</div>}
    </>
  );
}

/**
 * The whole bottom bar — red | timer | blue, each alliance's up-CELL line under its total.
 *
 * It exists because the SHARED bar is DECODE's: it draws the motif dots for every game that
 * is not Chain Reaction, and BIOBUZZ has no motif. The LAYOUT is the shared one on purpose
 * (the same `scorebar` / `score-panel` / `timer-panel` classes), so it themes identically and
 * a driver who plays two games reads the same bar in both. The one addition is the sub-line,
 * which is `.score-panel.bb` stacking its children instead of centring one.
 *
 * `data-hud-band` on the bar and the chip row: this game has a 3D view, and a camera fitted to
 * the whole canvas frames the far wall underneath this bar (owner's re-test, 2026-09-18). The
 * attribute is what `GameController.refreshHudInsets` measures; it changes nothing visually, and
 * a game that fills the `scoreBar` slot and forgets it simply gets the old, overlapping fit.
 *
 * The panels show the alliance TOTAL, read from the shared `ScoreBreakdown` rather than from
 * `score[a].total`: the shared number already folds in foul points and already reads 0 for a
 * VOIDED alliance, and a bar that disagreed with the results screen about who is winning
 * would be worse than either number on its own.
 */
export function BiobuzzScoreBar({ hud }: GameHudProps) {
  const f = sliceOf(hud)?.field;
  const pin = soonestPin(f?.pins);
  // the VIEWER's alliance: PENDING is a driver's own readout, and two of them on one chip row
  // would be a scoreboard the row is not.
  const pending = pendingLine(f, hud.alliance);
  const red = hud.alliance === 'red' ? hud.score.total : hud.oppTotal;
  const blue = hud.alliance === 'blue' ? hud.score.total : hud.oppTotal;
  // the timer panel is the SHARED one (END GAME, MATCH OVER until the field settles)
  const timer = timerPanel(hud);
  if (hud.mode !== 'match') {
    return (
      <div className="scorebar" data-hud-band>
        <div className="timer-panel">
          <span className="timer-phase">FREE DRIVE</span>
        </div>
      </div>
    );
  }
  return (
    <>
      <div className="scorebar" data-hud-band>
        <div className={`score-panel bb red ${hud.alliance === 'red' ? 'mine' : ''}`}>
          {hud.alliance === 'red' && <span className="you-tag">YOU</span>}
          <span className="panel-score">{red}</span>
          <span className={`bb-tip ${f && f.cells.red.tipping > 0 ? 'go' : ''}`}>
            {cellLine(f?.cells.red)}
          </span>
          {/* the pace is a TAB on the panel's top edge, outside its flow (`.pace-tab`), so the
              two panels stay the same two lines either way */}
          {hud.alliance === 'red' && <PaceTag hud={hud} />}
        </div>
        <div className={`timer-panel ${timer.cls}`}>
          {/* status on the PHASE only — the digits beside it retick every frame and would
              flood a screen reader. This changes ~4 times a match. */}
          <span className="timer-phase" role="status">
            {timer.label}
          </span>
          <span className="timer-time">{timer.time}</span>
        </div>
        <div className={`score-panel bb blue ${hud.alliance === 'blue' ? 'mine' : ''}`}>
          {hud.alliance === 'blue' && <span className="you-tag">YOU</span>}
          <span className="panel-score">{blue}</span>
          <span className={`bb-tip ${f && f.cells.blue.tipping > 0 ? 'go' : ''}`}>
            {cellLine(f?.cells.blue)}
          </span>
          {hud.alliance === 'blue' && <PaceTag hud={hud} />}
        </div>
      </div>
      {/* AFTER the bar, as DECODE's and Chain Reaction's rows are (`GameView`): the two are
          siblings in one stacking context, so DOM order is the paint order, and a row
          rendered first went UNDER the phone's compact bar the moment the two touched. */}
      {/* G410: a NECTAR into a FLOWER before the 1:00 cue is a MAJOR, PER NECTAR. On a real
          field the cue is audio; here it has to be readable from the driver's station, so it
          sits on the bar rather than only in the desktop-only chip row. `nectarIn` is null
          outside TELEOP, where a countdown would be a guess at the remaining AUTO — so the
          chip states the lock and says nothing about when. */}
      {/* G421 rides the same row and for the same reason G410 does: `GameView` suppressed the
          whole chip row on a coarse pointer until design review 05-05, and even now the phone's
          card is a shrunken column in a gutter, so the bar is where a PIN is sure to be read — and 20 points every three seconds is not a tariff to leave to a cue the
          device does not render. `.warn` because it is a clock running against somebody, not a
          state of the field like the lock beside it. */}
      {/* ⚠️ THE ROW IS ALWAYS MOUNTED, AND ITS CONTENTS ARE WHAT COME AND GO.
          It used to be `{(nectarLocked || pin) && <div data-hud-band>…}`, so the band
          DISAPPEARED on the tick the FLOWERS opened — and a band is what the 3D camera fits
          the field around (`GameController.refreshHudInsets`). Measured at 1431×649: the
          bottom inset dropped 98px → 73px at the 1:00 cue and the whole field jumped
          (owner report, 2026-09-18). A band's box must be a function of the VIEWPORT, never
          of match state, so the slot is reserved (`.breakdown-row` has a min extent) and
          only the spans inside it are conditional. An empty row draws nothing. */}
      {/* PENDING rides this row for the third time the same reason the two above do: it is a
          number the field draws nowhere, it belongs to the driver rather than to the field, and
          this row is the one a coarse-pointer device renders at full size. It is deliberately NOT in
          the alliance panel — the panel is the score, and the whole point of this figure is
          that it is not in the score yet (§10.5 C/E/F/G). */}
      <div className="breakdown-row" data-hud-band>
        {f?.nectarLocked && (
          <span>NECTAR LOCKED{f.nectarIn === null ? '' : ` ${fmtTime(f.nectarIn)}`}</span>
        )}
        {pending && <span>{pending}</span>}
        {pin && <span className="warn">{pinLine(pin)}</span>}
        {/* the shared running foul tally — the same chip, in the same row, as DECODE's and
            Chain Reaction's (design review 22-02). CONTROL 5+ and PIN stay this game's own. */}
        <FoulChip hud={hud} />
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
 * ── POINTS ONLY, BY OWNER RULING (2026-09-21) ───────────────────────────────
 * Every achievement that has both a count and a points value USED to get two rows, so that
 * the table could be checked against the field (GARDEN 7 is seven elements at 1 each). It
 * does not any more: 17 rows of small type was the reason the results screen was a wall of
 * 15px text in a 1400px-tall void, and the screen is display-scaled now — 17 rows of it
 * overruns any display by ~390px, so the cut is what PAYS for the size. The counts are
 * therefore surfaced NOWHERE post-match; `BiobuzzScoreBar` never showed them either.
 * Every `*Count` field is still computed and still rides `BbAllianceScore`, so putting any
 * row back is one `row(…)` tuple.
 *
 * The labels are bare for the same reason. `(points at the buzzer)` existed to explain a 0
 * sitting beside a non-zero COUNT — `<Results>` only ever mounts after the buzzer, and with
 * the count rows gone there is no such pair left to explain.
 *
 * ── THERE IS NO TOTAL ROW HERE, DELIBERATELY ────────────────────────────────
 * Both consumers append their own (`Results.tsx`'s `.resx-total`, off the shared
 * `ScoreBreakdown.total`), so a second one would print the number twice — and would DISAGREE
 * with it on a VOIDED match, where the shared row reads 0 over a full breakdown on purpose.
 * PENALTIES is therefore the last section and the screen's own TOTAL closes the table.
 *
 * ── THE ORDER IS THE MATCH'S OWN ────────────────────────────────────────────
 * AUTONOMOUS, then the three things scored all match long, then END OF MATCH, then the
 * PENALTIES that adjust the total. The endgame section reads immediately above the penalties
 * because both are settled at the buzzer and a driver reads down towards the total.
 *
 * ⚠️ RANKING POINTS used to close this table: SWARM / POLLINATOR 1 / POLLINATOR 2, printed as
 * 1 / 0 off `BB_RP`. It was REMOVED on 2026-09-21 at the owner's request. `BbRankPoints` is
 * still computed in `score.ts` and still rides `BiobuzzFieldHud.rp`, so restoring the section
 * is one tuple. The results screen stays RP-free, competition matches included: ranking points
 * are shown on the competition pages, ranked by `src/competition/manual.ts`'s table.
 */
export function biobuzzResultsRows(hud: HudSnapshot): readonly ResultsSection[] {
  const f: BiobuzzFieldHud | undefined = sliceOf(hud)?.field;
  const me = hud.alliance;
  const opp = other(me);
  /** one breakdown field, alliance-relative. An absent slice reads 0, never throws. */
  const n = (s: BbAllianceScore | undefined, k: keyof BbAllianceScore): number => s?.[k] ?? 0;
  const row = (label: string, k: keyof BbAllianceScore) =>
    [label, n(f?.score[me], k), n(f?.score[opp], k)] as const;
  return [
    ['AUTONOMOUS', [row('LEAVE', 'leave'), row('PARK', 'parkAuto')]],
    ['HIVE', [row('TIPS', 'tipPts'), row('Up CELL contents', 'cellPts')]],
    ['FLOWER', [row('OWNED FLOWER', 'ownedPts'), row('Bottom NECTAR Bonus', 'bottomPts')]],
    ['GARDEN', [row('GARDEN', 'gardenPts')]],
    ['END OF MATCH', [row('PARK', 'parkTele')]],
    // points AWARDED to each alliance, i.e. earned from the OPPONENT's violations — the same
    // direction the shared breakdown prints, so the two reconcile against their totals.
    ['PENALTIES', [row('Fouls awarded', 'foul')]],
  ];
}
