import { Fragment, useEffect, useRef, useState } from 'react';
import type { HudSnapshot, EloResultRow } from '../game';
import { appChannel, lanActive } from '../net/env';
import { PTS_FOUL_MINOR, PTS_FOUL_MAJOR } from '../config';
import { ResultsAd } from './AdSlot';
import { ReportDialog } from './ReportDialog';
import { ScoreReportDialog } from './ScoreReportDialog';
import type { MatchResultInfo } from '../net/session';
import type { MatchDriver, RecordRankInfo, StaffRole } from '../net/protocol';
import type { Replay, ReplayResult } from '../sim/replay';
import type { RobotSetup } from '../sim/spawn';
import { moduleFor } from '../games';
import { recordBanner } from './recordBanner';
import { DRIVETRAIN_LABELS } from './labelData';
import type { ResultBanner } from './recordBanner';
import { seasonFor } from '../seasons';
import { SupporterBadge } from './SupporterBadge';
import { Marquee } from './Marquee';
import { useDialog } from './useDialog';
import type { Alliance, ScoreBreakdown } from '../types';

/**
 * THE RESULTS SCREEN — a full-screen broadcast takeover, built against the official FTC
 * scoring software's audience "Match Results" display: it replaces the whole viewport (not
 * a card on a scrim), splits into a RED half and a BLUE half each carrying its team rows and
 * a huge final total, with the category breakdown centred between them, a WINNER banner on
 * the winning side, and a ~3.2s lead-up animation (wipe → panels settle → rows cascade →
 * totals land → secondary info) before the quiet actions row appears.
 *
 * Split out of `GameView.tsx` so the live in-match HUD and the post-match screen stop
 * sharing one 1700-line file. `GameView` still owns `<Results>`'s call site and props —
 * nothing here changes that contract except one additive prop (`localRobotId`, needed to
 * mark "YOU" in a roster row; see the call site).
 *
 * ── THEMING: THIS SCREEN IS FIXED-DARK, LIKE THE FIELD CANVAS — DELIBERATELY ─────────────
 * A broadcast scoreboard does not go light-mode. The stage background (`--ds-stage-bg`, new
 * — see shell.css) and every piece of text painted directly on it (`--ds-on-field*`) are the
 * CANVAS-GROUND family: fixed, never re-valued in the dark block, exactly like the game field
 * itself. The two alliance halves stay the existing fixed-ink chip pair
 * (`--ds-{red,blue}-chip` / `-chip-ink`) — already non-inverting, so nothing here clashes.
 * The actions row is `.overlay-buttons`, but RE-TOKENED on this stage (styles.css,
 * `.resx-stage .overlay-buttons button`): the themed keycap sat straight on the fixed-dark
 * ground, so the hierarchy flipped with the theme — a light MENU cap shouted in light mode and
 * vanished in dark (design review 06-11). ONE primary per context (`primaryAction`), filled
 * with the on-field mint, rightmost; everything else is a secondary outline in on-field ink.
 */

// the shared builder labels ("X-drive", 07-21), plus the duo board's mixed sentinel
const DRIVETRAIN_LABEL: Record<string, string> = {
  ...DRIVETRAIN_LABELS,
  // sentinel for a mixed-drivetrain duo run (overall board only, no dt-specific)
  overall: 'Mixed',
};
const prettyDrivetrain = (d: string): string => DRIVETRAIN_LABEL[d] ?? d;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** count an integer from `from` to `target` over `duration` ms once `active` flips true
 * (ease-out cubic). A reduced-motion viewer gets the target immediately rather than a
 * faster version of the same animation — capping duration alone would still be motion,
 * just shorter (see CLAUDE.md's gotcha). */
function useCountUp(target: number, active: boolean, duration = 900, from = 0): number {
  const [val, setVal] = useState(from);
  useEffect(() => {
    if (!active) {
      setVal(from);
      return;
    }
    if (prefersReducedMotion()) {
      setVal(target);
      return;
    }
    let raf = 0;
    let t0 = 0;
    const tick = (t: number): void => {
      if (!t0) t0 = t;
      const p = Math.min(1, (t - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setVal(Math.round(from + (target - from) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, active, duration, from]);
  return active ? val : from;
}

/** the count-up's own length for one breakdown value (`RowVal`). */
const ROWVAL_MS = 350;

/**
 * THE CASCADE BEAT. One index used to run across the WHOLE table, capped at ten
 * (`Math.min(idx, 10)`), so every BIOBUZZ row past the tenth appeared on the same frame.
 * The stagger now restarts at each SECTION and the heading leads its own rows in by one
 * beat, which is what makes a section read as a section rather than as more rows.
 *
 * Bounded by construction rather than by a cap: the worst case in any game today is
 * BIOBUZZ's PENALTIES at section index 5, landing at 5·140 + 55 = 755 ms, inside the 900 ms
 * `rows` phase. ponytail: a game shipping many more sections than that wants the step
 * divided by the unit count instead of these two constants.
 */
const headDelay = (section: number): number => section * 140;
const rowDelay = (section: number, row: number): number => section * 140 + (row + 1) * 55;

/** a single breakdown VALUE, counting up on its own short beat once `run` flips true — the
 * "rows cascade in, each pair of values counting up" beat. The delay is `rowDelay`'s, so the
 * value moves with the row it sits in. It used to FLASH (`brightness(1.9)`) as it landed; that
 * went with the rest of the game-show punch (design review 06-14) — the count-up already says
 * the value arrived. */
function RowVal({ value, run, delay }: { value: number; run: boolean; delay: number }) {
  const [go, setGo] = useState(false);
  useEffect(() => {
    if (!run) {
      setGo(false);
      return;
    }
    // a reduced-motion viewer gets the value at once. The stagger is motion too, and waiting
    // out half a second of zeros is the same animation played slower — the trap the
    // `prefersReducedMotion` branch in `useCountUp` already documents.
    if (prefersReducedMotion()) {
      setGo(true);
      return;
    }
    const start = window.setTimeout(() => setGo(true), delay);
    return () => window.clearTimeout(start);
  }, [run, delay]);
  const shown = useCountUp(value, go, ROWVAL_MS);
  return <>{shown}</>;
}

/**
 * THE LEAD-UP SEQUENCE. Phases run once `revealed` flips true (the same instant the sim's
 * own `match_result` whoosh plays — see `GameController`'s settle-clock comment — so the
 * sound, the wipe and the saved score stay one moment, with no new audio hook needed here):
 *
 *   wipe (700ms)   — the two halves slam in from their edges; the title stings over the seam
 *   split (650ms)  — halves finish settling; team rows slide in from their own sides
 *   rows (900ms)   — the breakdown cascades top→bottom, each value counting up
 *   totals (950ms) — a beat of suspense, then the big totals count up and land with a punch;
 *                    the WINNER banner sweeps in on the winning side
 *   done           — ELO deltas / record callout / fouls detail / actions / ad fade in;
 *                    focus lands on the primary action
 *
 * `skip()` (click, Enter or Space) jumps straight to `done`. Reduced motion skips the whole
 * sequence and cross-fades directly to it — see the `prefersReducedMotion` branch.
 */
type Phase = 'wait' | 'wipe' | 'split' | 'rows' | 'totals' | 'done';
const PHASE_MS: Record<'wipe' | 'split' | 'rows' | 'totals', number> = {
  wipe: 700,
  split: 650,
  rows: 900,
  totals: 950,
};
const PHASE_ORDER: readonly Phase[] = ['wipe', 'split', 'rows', 'totals', 'done'];
/** a stage click only does something while the sequence is RUNNING (`skip` is a no-op at
 * `wait` and `done`), so only then does the stage wear `cursor: pointer` (design review 06-23). */
const skippable = (p: Phase): boolean => p !== 'wait' && p !== 'done';

function usePhase(revealed: boolean): { phase: Phase; skip: () => void } {
  const [phase, setPhase] = useState<Phase>('wait');
  const timers = useRef<number[]>([]);

  const clearTimers = (): void => {
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current = [];
  };

  useEffect(() => {
    clearTimers();
    if (!revealed) {
      setPhase('wait');
      return clearTimers;
    }
    if (prefersReducedMotion()) {
      setPhase('done');
      return clearTimers;
    }
    setPhase('wipe');
    let t = 0;
    for (let i = 1; i < PHASE_ORDER.length; i++) {
      t += PHASE_MS[PHASE_ORDER[i - 1] as keyof typeof PHASE_MS];
      const next = PHASE_ORDER[i];
      timers.current.push(window.setTimeout(() => setPhase(next), t));
    }
    return clearTimers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealed]);

  const skip = (): void => {
    clearTimers();
    setPhase((p) => (p === 'wait' ? p : 'done'));
  };

  // Enter / Space skip the sequence — Escape is left alone: it is already the app-wide
  // menu/exit key (GameController's global handler), and overloading it here would fight
  // that convention instead of extending it. A click anywhere on the stage also skips
  // (wired on the root element itself, not here).
  useEffect(() => {
    if (phase === 'wait' || phase === 'done') return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        skip();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  return { phase, skip };
}

/** one driver's roster row: name, "YOU" marker, drivetrain, and (ranked, once `done`) the
 * ELO delta. Built from the match's own recorded `RobotSetup`s (`Replay.setups`), not a
 * second roster the server sends separately — a replay already has to carry this to be
 * reproducible, so it is the one source both this screen and a later replay viewer agree on. */
interface RosterEntry {
  robotId: number;
  name: string;
  /**
   * The badge fields for this seat, from `matchStart.drivers` (`MatchDriver`).
   *
   * They are NOT on `RobotSetup` and must not be: a setup is replay input, re-simulated
   * verbatim years later, and a membership that lapses afterwards would change what an old
   * replay claims. The roster reads them off the LIVE room instead, so a solo run, a replay
   * and an older server all land on `undefined` and the row renders bare — which is what it
   * drew before this existed.
   */
  supporter?: boolean;
  role?: StaffRole;
  /** `0` is UNSET, not team zero (`RobotSpec.teamNumber`) — every bot and every stock preset
   *  is 0, so the row tests truthiness and prints the app's usual `-` for the rest. */
  teamNumber: number;
  isLocal: boolean;
  elo: EloResultRow | null;
}

function rosterFor(
  setups: readonly RobotSetup[],
  alliance: Alliance,
  localRobotId: number | undefined,
  eloResults: EloResultRow[] | null,
  drivers: readonly MatchDriver[] = [],
): RosterEntry[] {
  return setups
    .filter((s) => s.alliance === alliance && !s.passive)
    .map((s) => {
      const d = drivers.find((x) => x.robotId === s.id);
      return {
        robotId: s.id,
        name: s.spec.name || `Driver ${s.id}`,
        teamNumber: s.spec.teamNumber,
        isLocal: s.id === localRobotId,
        elo: eloResults?.find((r) => r.robotId === s.id) ?? null,
        supporter: d?.supporter,
        role: d?.role,
      };
    });
}

/** the small "Updating rating…" line for a ranked match whose per-driver deltas have not
 * landed yet. Same 9s give-up as the old dedicated rating block. */
function useEloPending(ranked: boolean, eloResults: EloResultRow[] | null): string | null {
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (!ranked || eloResults !== null) return;
    const id = window.setTimeout(() => setTimedOut(true), 9000);
    return () => window.clearTimeout(id);
  }, [ranked, eloResults]);
  if (!ranked || eloResults !== null) return null;
  // alpha builds never persist — the server sends no eloResult, so say so up front
  // instead of spinning on "Updating rating…"
  if (appChannel() === 'alpha') return 'Not rated on this test build.';
  return timedOut ? 'No rating change this match.' : 'Updating rating…';
}

function RosterList({
  roster,
  showElo,
  outerFirst = false,
}: {
  roster: readonly RosterEntry[];
  showElo: boolean;
  /** render each group OUTER-first — see `outward` in `AllianceHalf`. */
  outerFirst?: boolean;
}) {
  if (roster.length === 0) return null;
  const order = (inner: React.ReactNode, outer: React.ReactNode): React.ReactNode =>
    outerFirst ? (
      <>
        {outer}
        {inner}
      </>
    ) : (
      <>
        {inner}
        {outer}
      </>
    );
  return (
    <ul className="resx-roster">
      {roster.map((p, i) => (
        <li key={p.robotId} className="resx-roster-row" style={{ animationDelay: `${i * 90}ms` }}>
          {order(
            <span className="resx-roster-name">
              <Marquee text={p.name} />
              {/* A SIBLING of the clip, never inside it: `Marquee` MEASURES its text
                  against the clip to decide whether to marquee, so anything else in there
                  would widen the thing being measured and scroll a name that fits.
                  Status disc ONLY here — no worn badges. See the note in styles.css beside
                  `.resx-roster-name` for the measurement that decided it. */}
              <SupporterBadge supporter={p.supporter} role={p.role} />
              {p.isLocal && <span className="resx-you">YOU</span>}
            </span>,
            <span className="resx-roster-meta">
              {order(
                p.teamNumber ? p.teamNumber : '-',
                showElo && p.elo ? (
                  <span className="resx-elo" title={`Rating ${p.elo.before} → ${p.elo.after}`}>
                    {p.elo.after >= p.elo.before ? '▲' : '▼'}
                    {Math.abs(p.elo.after - p.elo.before)}
                  </span>
                ) : null,
              )}
            </span>,
          )}
        </li>
      ))}
    </ul>
  );
}

/** one scoring-category row, alliance-relative: `[label, value]` (solo) or `[label, red, blue]`
 * (versus). */
type SoloSection = readonly [string, readonly (readonly [string, number])[]];
type VersusSection = readonly [string, readonly (readonly [string, number, number])[]];

/** the shared centre breakdown table for a VERSUS match — one table, red value left /
 * category middle / blue value right, exactly the official board's anatomy. Each SECTION
 * cascades on its own beat once `rowsActive`, led in by its heading, each pair of values
 * counting up and flashing as it lands.
 *
 * ⚠️ The entrance is gated on `rowsActive`, not applied on mount. The table mounts during
 * `wipe` but `rowsActive` is 1350 ms later, so an unconditional `resx-row` cascaded the rows
 * in reading 0 and left them sitting there for over a second before they counted up. The old
 * flat 55 ms ramp hid that; a per-section rhythm does not.
 *
 * ⚠️ The `<Fragment key={title}>` boundary is what keeps `key={label}` unique — BIOBUZZ
 * prints `PARK (robots)` in two different sections. Do not flatten these to get an index. */
function BreakdownTable({
  sections,
  rowsActive,
}: {
  sections: readonly VersusSection[];
  rowsActive: boolean;
}) {
  const cls = `resx-row${rowsActive ? ' in' : ''}`;
  return (
    <table className="resx-breakdown" aria-label="Score breakdown">
      <tbody>
        {sections.map(([title, rows], s) => (
          <Fragment key={title}>
            <tr className={`resx-section ${cls}`} style={{ animationDelay: `${headDelay(s)}ms` }}>
              <th className="resx-section-label" colSpan={3} scope="colgroup">
                {title}
              </th>
            </tr>
            {rows.map(([label, rv, bv], r) => (
              <tr key={label} className={cls} style={{ animationDelay: `${rowDelay(s, r)}ms` }}>
                <td className="resx-rv">
                  <RowVal value={rv} run={rowsActive} delay={rowDelay(s, r)} />
                </td>
                <td className="resx-cat">{label}</td>
                <td className="resx-bv">
                  <RowVal value={bv} run={rowsActive} delay={rowDelay(s, r)} />
                </td>
              </tr>
            ))}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

/** the SOLO breakdown, sitting beside the total inside the one alliance half — same
 * cascading rows, single value column. */
function SoloTable({ sections, rowsActive }: { sections: readonly SoloSection[]; rowsActive: boolean }) {
  const cls = `resx-row${rowsActive ? ' in' : ''}`;
  return (
    <table className="resx-breakdown resx-breakdown-solo" aria-label="Score breakdown">
      <tbody>
        {sections.map(([title, rows], s) => (
          <Fragment key={title}>
            {/* ⚠️ colSpan ONE, not two — the heading's box must stay the LABEL's box, whatever
                the label column is. It is the only in-flow column now (`.resx-val` is
                positioned; see its CSS), so one column is the whole table and the heading
                centres exactly where the labels do. Spanning two also happens to land there
                today, but it would drift again the moment the value column returned to
                flow. */}
            <tr className={`resx-section ${cls}`} style={{ animationDelay: `${headDelay(s)}ms` }}>
              <th className="resx-section-label" scope="colgroup">
                {title}
              </th>
            </tr>
            {rows.map(([label, v], r) => (
              <tr key={label} className={cls} style={{ animationDelay: `${rowDelay(s, r)}ms` }}>
                <td className="resx-cat">{label}</td>
                <td className="resx-val">
                  <RowVal value={v} run={rowsActive} delay={rowDelay(s, r)} />
                </td>
              </tr>
            ))}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

/** one side of a VERSUS board: the winner names itself, a tie names both, and the loser keeps
 *  the slot and prints nothing so the two halves' rosters and totals stay on one line. */
const versusBanner = (win: boolean, tie: boolean): ResultBanner =>
  tie ? { text: 'TIE', tone: 'quiet' } : { text: win ? 'WINNER' : '' };

/** the alliance's own name, which LABELS its total — the fill already says which side this
 *  is, so the word `TOTAL` beside the number was saying nothing the panel had not said. */
const ALLIANCE_NAME: Record<Alliance, string> = { red: 'Red', blue: 'Blue' };

/**
 * ONE ALLIANCE HALF — full height, solid alliance fill. A WINNER banner across the top, team
 * rows under it, a huge total at the bottom; the versus breakdown lives in the shared
 * `BreakdownTable` between the two halves, but a SOLO half draws its own (`soloSections`),
 * beside the total.
 *
 * ── THE TWO HALVES MIRROR ABOUT THE BREAKDOWN ───────────────────────────────
 * Every row in here is written INNER→OUTER — inner being the centre of the stage, where the
 * breakdown is — and the LEFT half renders each group outer-first (`outward`). So the name
 * hugs the centre on both sides and the meta runs out to the wall on both sides, from one
 * flag and no per-side markup.
 *
 * It is a child SWAP and not `flex-direction: row-reverse` on purpose: `.resx-roster-row` is
 * `flex-wrap` and a long username is MEANT to wrap onto its own line rather than push the
 * meta off the edge (see its CSS comment). Reversed items wrap per line, which leaves a
 * wrapped name aligned against nothing. A swap also needs no undo in the narrow layout,
 * where the halves stack and there is no centre to mirror about.
 */
function AllianceHalf({
  alliance,
  phase,
  banner,
  standing,
  roster,
  showElo,
  total,
  totalLabel,
}: {
  alliance: Alliance;
  phase: Phase;
  /** the slot across the top of the panel. An EMPTY `text` RESERVES the space and prints
   *  nothing — which is both the losing half of a versus board and a record run whose rank
   *  has not landed yet, from one rule. Absent means no slot at all. See `recordBanner`. */
  banner?: ResultBanner;

  standing?: React.ReactNode;
  roster: readonly RosterEntry[];
  showElo: boolean;
  total: number;
  /** overrides the alliance name beside the total. The RECORD screen needs it: its number is
   *  a NET score with the runner's own penalties already subtracted, so it deliberately does
   *  not equal the breakdown above it — which is why that screen prints a negative penalties
   *  row — and `Red` would delete the only word explaining the difference. */
  totalLabel?: string;
}) {
  const settled = phase !== 'wait' && phase !== 'wipe';
  const totalsActive = phase === 'totals' || phase === 'done';
  // "this panel is on the LEFT", which is now the same question as "is it red" on every board:
  // a pair is red|blue left-to-right, and a LONE panel takes its own alliance's side too — red
  // in the left column, blue in the right — so its banner bleeds off the outer edge of the
  // screen rather than into the details column. Everything inside a half is written
  // inner→outer and the left-hand one renders each group outer-first.
  const outward = alliance === 'red';
  const label = totalLabel ?? ALLIANCE_NAME[alliance];
  // the panel's ONLY heading, and so the accessible name for the `<section>` around it — a
  // `<section>` with none is not exposed as a region at all. It used to be the `RED` /
  // `BLUE` title at the top of the half; moving the text did not make the element optional.
  const name = (
    <h3 className="resx-total-label" key="name">
      {label}
    </h3>
  );
  const num = (
    // no aria-label: a `strong` has no role to carry one (06-19). The h3 beside it plus the
    // number already read "Red, 123"; the outcome is announced once by the stage's live line.
    <strong className={`resx-total-num ${totalsActive ? 'landed' : ''}`} key="num">
      {totalsActive ? total : '–'}
    </strong>
  );
  return (
    <section className={`resx-half ${alliance}`}>
      {/* the slot holds its height whatever is in it, so the driver row never jumps when a
          rank lands late and the two halves of a versus board stay on one line.
          ⚠️ It is a direct child of the HALF, not of `.resx-half-top`: that block centres
          itself in whatever is left between here and the total, and the banner has to stay
          welded to the top edge it bleeds out to. */}
      {banner && (
        <span
          className={`resx-winbanner${banner.tone ? ` ${banner.tone}` : ''}${
            totalsActive && banner.text ? ' on' : ''
          }`}
        >
          {banner.text}
        </span>
      )}
      <div className="resx-half-top">
        {settled && standing}
        {settled && <RosterList roster={roster} showElo={showElo} outerFirst={outward} />}
      </div>
      {/* just the total, which `margin-top: auto` pins to the panel's bottom edge. The
          one-panel screens used to wrap their breakdown in here too; it is a sibling out in
          the content column now, so this is the same shape on every screen. */}
      <div className="resx-half-lower">
        <div className="resx-total">{outward ? [name, num] : [num, name]}</div>
      </div>
    </section>
  );
}

/**
 * The rematch control, in EVERY multiplayer mode — ranked, custom and record alike.
 *
 * It reads its pressed state from the SERVER tally rather than a local guess, so
 * everyone in the room always sees the same count, and it is a VOTE: the match only
 * restarts once every connected driver has pressed it. Declining costs nothing —
 * you simply do not press — which is what makes "everyone agrees" a gate rather
 * than a way to lean on somebody.
 */
function RematchVote({
  vote,
  onToggle,
  primary,
}: {
  vote: { votes: number; need: number; mine: boolean };
  onToggle: () => void;
  primary: boolean;
}) {
  const waiting = vote.mine && vote.votes < vote.need;
  // PRESSED is `.on` + `aria-pressed`, separate from the row's primary/secondary rank: a vote is a
  // toggle, and the flush keycap with its ring (styles.css) is what says it counted.
  return (
    <button
      className={`${rank(primary)}${vote.mine ? ' on' : ''}`}
      aria-pressed={vote.mine}
      onClick={onToggle}
    >
      {waiting ? 'WAITING…' : 'REMATCH'} {vote.votes}/{vote.need}
    </button>
  );
}

/** focuses the row's `.primary` action the moment it appears (phase `done`), so a
 * keyboard/switch user lands on it without hunting. It was the FIRST button, which was WATCH
 * REPLAY — not what the screen expects next. */
function useFocusPrimaryAction(show: boolean): React.RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!show) return;
    const row = ref.current;
    const target = row?.querySelector<HTMLButtonElement>('button.primary') ?? row?.querySelector('button');
    target?.focus({ preventScroll: true });
  }, [show]);
  return ref;
}

/** THE ONE PRIMARY in a results action row (design review 06-06): the next step this context
 * expects. Ranked → find new opponents; a custom host → back to the room; solo → play again;
 * otherwise the rematch vote. WATCH REPLAY and MENU are never it. */
type ResultsAction = 'queue' | 'lobby' | 'rematch' | 'vote' | null;
function primaryAction(o: { queue: boolean; lobby: boolean; rematch: boolean; vote: boolean }): ResultsAction {
  return o.queue ? 'queue' : o.lobby ? 'lobby' : o.rematch ? 'rematch' : o.vote ? 'vote' : null;
}
const rank = (on: boolean): string => (on ? 'primary' : 'secondary');

/** final match results — a full-screen RED | BLUE broadcast board, like the FTC audience
 * display. Foul rows show the fouls each alliance COMMITTED (its own count) — the POINTS
 * for those go to the OPPONENT's total (see the footnote), so a foul always benefits the
 * fouled alliance. */
export function Results({
  hud,
  final,
  lost,
  ranked,
  eloResults,
  canRematch,
  onRematch,
  onRunAgain,
  rematchVote,
  onRematchVote,
  onQueueAgain,
  onBackToLobby,
  onExit,
  matchResult,
  practiceRun,
  recordResult,
  signedIn,
  lanHost,
  onWatchReplay,
  reportable,
  onReport,
  onReportScore,
  onSignIn,
  localRobotId,
  drivers,
}: {
  hud: HudSnapshot;
  /** the score is FINALIZED (see `HudSnapshot.resultFinal`) — the reveal lands then, not on a timer */
  final: boolean;
  /** the final score never arrived (see `HudSnapshot.resultLost`) */
  lost: boolean;
  /** ranked match? shows per-driver ELO deltas inline in the roster */
  ranked: boolean;
  /** per-driver ELO changes, or null until the server's eloResult lands */
  eloResults: EloResultRow[] | null;
  /** SOLO only (`!session` at the call site) — doubles as the single-alliance-half
   *  layout switch: a solo run has nobody to show an opposing half for. */
  canRematch: boolean;
  onRematch: () => void;
  /** SOLO RECORD run only: start a fresh run (GameView's `onRestartRun`). A record run is
   *  server-hosted, so `canRematch` is false for it and RUN AGAIN needs its own callback. */
  onRunAgain?: () => void;
  /** duo-record co-op vote (null unless this run has one) */
  rematchVote: { votes: number; need: number; mine: boolean } | null;
  onRematchVote: () => void;
  onQueueAgain?: () => void;
  onBackToLobby?: () => void;
  onExit: () => void;
  matchResult: MatchResultInfo | null;
  /**
   * The finished SOLO PRACTICE run, kept apart from `matchResult` on purpose: that one is the
   * SERVER's authoritative payload, and a locally produced stand-in would quietly claim this
   * score was witnessed. Nothing witnessed it — that is what offline means — and the replay is
   * offered on exactly those terms.
   */
  practiceRun: { replay: Replay; result: ReplayResult } | null;
  /** record run's leaderboard standing, or null until the server's recordResult
   * lands (or forever if anonymous) */
  recordResult: RecordRankInfo | null;
  signedIn: boolean;
  /** on a LAN match, is THIS client the one hosting it? — decides which of the two LAN
   *  lines the results screen shows, since only the host keeps the match */
  lanHost?: boolean;
  onWatchReplay?: (replay: Replay) => void;
  /** the OTHER drivers in this match, reportable by robot id (empty in solo) */
  reportable?: { robotId: number; name: string }[];
  /** send a report; absent in solo / on an older session */
  onReport?: (robotId: number, reason: string, detail: string) => void;
  /** file a MISSCORE claim about this match — see ScoreReportDialog */
  onReportScore?: (detail: string) => void;
  /** open the account screen. A signed-out RECORD run is offered the sign-in that would put
   *  its score on the board; absent, the offer degrades to a plain sentence. */
  onSignIn?: () => void;
  /** this client's own robot id (`GameController.localRobotId`) — marks the "YOU" row
   *  in a roster built from `matchResult`/`practiceRun`'s recorded setups. Optional so
   *  an older caller still renders (just without the marker). */
  localRobotId?: number;
  /** who is in each seat (`matchStart.drivers`) — the roster's badge source. Empty in
   *  solo, in a replay, and against a server older than the fields. */
  drivers?: readonly MatchDriver[];
}) {
  const [reporting, setReporting] = useState(false);
  const [scoreReporting, setScoreReporting] = useState(false);
  const [scoreReported, setScoreReported] = useState(false);
  // THE REPORT LINKS STAY MOUNTED while their form is open (06-03): unmounting the element
  // that had focus dropped a keyboard user on <body>. Closing a form hands focus back here.
  const reportBtn = useRef<HTMLButtonElement>(null);
  const scoreBtn = useRef<HTMLButtonElement>(null);
  const scoreDone = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (scoreReported) scoreDone.current?.focus();
  }, [scoreReported]);
  // the stage is modal (17-08). No onClose: the results are answered by a button, and
  // Escape stays free for the report forms nested inside.
  const stageRef = useDialog();
  const red =hud.alliance === 'red' ? hud.score : hud.oppScore;
  const blue = hud.alliance === 'blue' ? hud.score : hud.oppScore;
  /**
   * THE TOTALS SHOWN ARE THE SAVED ONES. Online, the server's finalized result is the score of
   * record; the HUD beside it is this client's PREDICTED world, which can run a few ticks past
   * the last snapshot. The breakdown rows still come from the HUD — the field has settled by the
   * time this reveals, so they agree — but the numbers a driver reads as "the score" are exactly
   * the numbers that were saved. Solo practice has no server, and its own world IS the result.
   */
  const saved = matchResult?.result ?? null;
  const redFinal = saved ? saved.score.red : red.total;
  const blueFinal = saved ? saved.score.blue : blue.total;
  const winner: Alliance | 'tie' =
    redFinal > blueFinal ? 'red' : blueFinal > redFinal ? 'blue' : 'tie';

  // RECORD runs are opponent-free score attacks: no winner, and the player's own
  // fouls (which are "awarded" to the empty opposing alliance) SUBTRACT from the
  // net score shown + saved.
  const isRecord = matchResult?.kind === 'record';
  const mine = hud.score; // the player's own breakdown
  const penaltyPts = hud.oppScore.foulPoints; // points the player's fouls handed the empty opponent
  const oppAlliance: Alliance = hud.alliance === 'red' ? 'blue' : 'red';
  const netScore = saved
    ? Math.max(0, saved.score[hud.alliance] - saved.foulPoints[oppAlliance])
    : Math.max(0, mine.total - penaltyPts);

  const revealed = final;
  const { phase, skip } = usePhase(revealed);
  const rowsActive = phase === 'rows' || phase === 'totals' || phase === 'done';
  const totalsActive = phase === 'totals' || phase === 'done';
  const doneVisible = phase === 'done';
  // the totals count up as part of the TOTALS BEAT, not the instant the score reveals —
  // the suspense is the point (see the phase doc comment above).
  const redTotal = useCountUp(redFinal, totalsActive, 700);
  const blueTotal = useCountUp(blueFinal, totalsActive, 700);
  // ⚠️ NO count-up for the record run's net score here. `RecordResults` runs its own, and
  // animating it twice made the child count up toward a target that moved every frame — the
  // inner tween restarted on each new `target`, so the number crawled and never landed. The
  // RAW `netScore` goes down; the single animation belongs to the component that prints it.
  const eloNote = useEloPending(ranked, eloResults);
  const actionsRef = useFocusPrimaryAction(doneVisible);
  const primary = primaryAction({
    queue: !!onQueueAgain,
    lobby: !!onBackToLobby,
    rematch: canRematch,
    vote: !!rematchVote,
  });

  // THE ROSTER, for both branches below: who actually played, pulled from the match's own
  // recorded setups rather than a second roster the server would have to send separately.
  // `Replay.setups` already has to exist for the run to be reproducible.
  const replay = matchResult?.replay ?? practiceRun?.replay ?? null;
  const setups = replay?.setups ?? [];
  const redRoster = rosterFor(setups, 'red', localRobotId, ranked ? eloResults : null, drivers);
  const blueRoster = rosterFor(setups, 'blue', localRobotId, ranked ? eloResults : null, drivers);

  if (isRecord) {
    return (
      <RecordResults
        hud={hud}
        mine={mine}
        penaltyPts={penaltyPts}
        netScore={netScore}
        revealed={revealed}
        lost={lost}
        practiceRun={practiceRun}
        recordResult={recordResult}
        signedIn={signedIn}
        matchResult={matchResult}
        canRematch={canRematch}
        onRematch={onRematch}
        onRunAgain={onRunAgain}
        rematchVote={rematchVote}
        onRematchVote={onRematchVote}
        onExit={onExit}
        onWatchReplay={onWatchReplay}
        onSignIn={onSignIn}
        roster={hud.alliance === 'red' ? redRoster : blueRoster}
      />
    );
  }

  const cr = hud.game === 'chain';
  const f = hud.fouls; // fouls COMMITTED by each alliance
  const val = (get: (s: ScoreBreakdown) => number): [number, number] => [get(red), get(blue)];

  // Chain Reaction has its own scoring: Particle points (catalyst multiplier folded in) +
  // End Game (park 5 / ascend 100) + penalty points awarded from the OPPONENT's fouls.
  const crSections = (): VersusSection[] => {
    const c = hud.chain;
    if (!c) return [];
    const isRed = hud.alliance === 'red';
    const redP = isRed ? c.particlePts : c.oppParticlePts;
    const blueP = isRed ? c.oppParticlePts : c.particlePts;
    const redF = isRed ? c.foulPts : c.oppFoulPts;
    const blueF = isRed ? c.oppFoulPts : c.foulPts;
    return [
      ['SCORING', [['Particles ×mult', redP, blueP]]],
      ['RING STAND / PARK', [['Descend / Ascend / Park', red.total - redP - redF, blue.total - blueP - blueF]]],
      ['PENALTIES', [['Fouls awarded', redF, blueF]]],
    ];
  };

  // a game's OWN breakdown, through the module slot. Its rows are
  // alliance-RELATIVE ([label, mine, opp]) — this screen prints red | blue.
  const own = moduleFor(hud.game).resultsRows;
  const ownSections = (): VersusSection[] =>
    (own?.(hud) ?? []).map(([title, rows]) => [
      title,
      rows.map(([label, mine2, opp2]) =>
        hud.alliance === 'red' ? [label, mine2, opp2] : [label, opp2, mine2],
      ) as (readonly [string, number, number])[],
    ]);

  const sections: VersusSection[] = own
    ? ownSections()
    : cr
    ? crSections()
    : [
        [
          'AUTONOMOUS',
          [
            ['Leave', ...val((s) => s.leave)],
            ['Classified', ...val((s) => s.autoClassified)],
            ['Overflow', ...val((s) => s.autoOverflow)],
            ['Pattern', ...val((s) => s.autoPattern)],
          ],
        ],
        [
          'DRIVER-CONTROLLED',
          [
            ['Classified', ...val((s) => s.teleClassified)],
            ['Overflow', ...val((s) => s.teleOverflow)],
            ['Pattern', ...val((s) => s.telePattern)],
          ],
        ],
        [
          'END OF MATCH',
          [
            ['Depot', ...val((s) => s.depot)],
            ['Base return', ...val((s) => s.base)],
          ],
        ],
        [
          // penalty POINTS awarded to each alliance (from the OPPONENT's fouls) —
          // shown as points, not counts, so the breakdown reconciles with each TOTAL
          'PENALTIES',
          [
            ['Minor', f.blue.minor * PTS_FOUL_MINOR, f.red.minor * PTS_FOUL_MINOR],
            ['Major', f.blue.major * PTS_FOUL_MAJOR, f.red.major * PTS_FOUL_MAJOR],
          ],
        ],
      ];

  // SOLO means NOBODY TO SHOW AN OPPOSING HALF FOR, which is not the same as "no session".
  // `canRematch` (`!session` at the call site) only says the run was local: a BIOBUZZ solo
  // practice with AI seats in Match ▸ Practice (`MatchSetup`), and `src/game.ts` seats a
  // NON-PASSIVE bot for it — a real opponent, with a real score and a real winner. Reading
  // `canRematch` alone hid all of that behind a one-sided screen. The roster is the honest
  // test, because `rosterFor` already drops `passive` setups, so a practice dummy is absent
  // from it and a bot is not.
  const solo = canRematch && (redRoster.length === 0 || blueRoster.length === 0);
  const season = seasonFor(hud.game).name;
  const format = redRoster.length && blueRoster.length ? `${redRoster.length}V${blueRoster.length}` : '';
  // the EYEBROW asks a different question from the layout: `canRematch` (no session) is what
  // makes a run solo practice, bots or not — a practice run against a bot is still practice,
  // and calling it CUSTOM 1V1 because the field had an opponent on it would be wrong.
  const modeLabel = canRematch
    ? 'SOLO PRACTICE'
    : ranked
      ? `RANKED${format ? ` ${format}` : ''}`
      : lanActive()
        ? `LAN${format ? ` ${format}` : ''}`
        : `CUSTOM${format ? ` ${format}` : ''}`;

  const soloSections: SoloSection[] | undefined = solo
    ? sections.map(([title, rows]) => [
        title,
        rows.map(([label, rv, bv]) => [label, hud.alliance === 'red' ? rv : bv] as [string, number]),
      ])
    : undefined;

  return (
    <div
      className={`resx-stage${skippable(phase) ? ' skippable' : ''}`}
      onClick={skip}
      ref={stageRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Match results"
    >
      {phase !== 'wait' && (
        <div className="resx-sting" aria-hidden="true">
          MATCH RESULTS
        </div>
      )}
      {/* THE OUTCOME, said once (06-19). Mounted empty from the start: a live region has to
          exist before the text lands in it, or the text is not announced. */}
      <p className="ds-sr" aria-live="polite">
        {doneVisible
          ? solo
            ? `Final score ${hud.alliance === 'red' ? redFinal : blueFinal}`
            : winner === 'tie'
              ? `Tie, ${redFinal} to ${blueFinal}`
              : `${ALLIANCE_NAME[winner]} wins ${Math.max(redFinal, blueFinal)} to ${Math.min(redFinal, blueFinal)}`
          : ''}
      </p>
      {/* ⚠️ THE HEADER AND THE ACTIONS ROW LIVE INSIDE THE BODY GRID, in its centre column,
          because the two alliance halves run the FULL HEIGHT of the stage. A header band
          above them would push both panels down off the top edge, and the mockup this screen
          is built to has the panels meeting it. Placement is by `grid-area`, so the DOM keeps
          its reading and tab order: header, red, breakdown, blue, actions.

          ⚠️ `resx-body-solo` was MISSING on this branch — the class was hard-coded without
          it, so a one-sided run drew its half in column 1 of a three-column grid with half
          the stage dead beside it, and `.resx-body-solo .resx-half-lower`'s "breakdown beside
          the total" never fired on this path at all. `RecordResults` had it right. */}
      <div className={`resx-body${solo ? ' resx-body-solo' : ''}`}>
        <header className="resx-bar">
          <span className="resx-eyebrow">{modeLabel}</span>
          <h2 className="resx-title">{revealed ? 'MATCH RESULTS' : 'FINAL SCORE'}</h2>
          <span className="resx-season">{season}</span>
        </header>
        {!revealed && (
          <p className="resx-wait">
            {lost
              ? 'Couldn’t get the final score from the server. Check Career for the result.'
              : 'Waiting for the field to settle…'}
          </p>
        )}
        {phase !== 'wait' &&
          (solo ? (
            // the breakdown is a SIBLING of the panel, not a child of it: the panel is a
            // full-height column in the one-panel grid and the table belongs in the content
            // column beside it, where the header and the buttons are.
            <>
              <AllianceHalf
                alliance={hud.alliance}
                phase={phase}
                banner={recordBanner(null, true)}
                roster={hud.alliance === 'red' ? redRoster : blueRoster}
                showElo={false}
                total={hud.alliance === 'red' ? redTotal : blueTotal}
              />
              {soloSections && <SoloTable sections={soloSections} rowsActive={rowsActive} />}
            </>
          ) : (
            <>
              <AllianceHalf
                alliance="red"
                phase={phase}
                banner={versusBanner(winner === 'red', winner === 'tie')}
                roster={redRoster}
                showElo={ranked}
                total={redTotal}
              />
              <BreakdownTable sections={sections} rowsActive={rowsActive} />
              <AllianceHalf
                alliance="blue"
                phase={phase}
                banner={versusBanner(winner === 'blue', winner === 'tie')}
                roster={blueRoster}
                showElo={ranked}
                total={blueTotal}
              />
            </>
          ))}
        {doneVisible && (
          <div className="resx-secondary">
            {/* A VOIDED total is 0 with a full breakdown above it, which reads as a bug unless
                the reason is stated. Say it plainly. */}
            {(red.voided || blue.voided) && (
              <p className="resx-void">
                {/* full stops, not a dash, and "the red alliance" rather than a bare RED straight
                    after "Red card", which is the penalty (06-21) */}
                {red.voided && blue.voided
                  ? 'Red cards. Both alliances forfeit the match.'
                  : `Red card. The ${red.voided ? 'red' : 'blue'} alliance forfeits the match.`}{' '}
                Points are shown but do not count.
              </p>
            )}
            {eloNote && <p className="resx-note">{eloNote}</p>}
            {matchResult && (
              <p className="resx-note ok">
                {/* A LAN MATCH WAS NOT RECORDED BY THE SERVER THAT RAN IT, and "✓ Match recorded."
                    is simply false there — a LAN box has no database. What actually happened
                    depends on which end of the room you are, so it says which: the HOST keeps it
                    (and their account gets it once they are online), and a guest keeps nothing. */}
                {lanActive()
                  ? lanHost
                    ? signedIn
                      ? '✓ Saved on this computer. It goes to your account next time you’re online.'
                      : '✓ Saved on this computer. Sign in to save it to your account.'
                    : '✓ Match over. The host keeps the replay.'
                  : matchResult.kind === 'record'
                    ? '✓ Recorded. Sign in to save it to the leaderboard.'
                    : '✓ Match recorded.'}
              </p>
            )}
            {/* A practice run says what it IS. It was not on a leaderboard and never will be —
                offline has no authority to put it there — so the copy promises only what happened:
                the run is kept, and it is yours to watch. */}
            {practiceRun && !matchResult && (
              <p className="resx-note ok">
                {signedIn
                  ? '✓ Saved to your practice replays.'
                  : '✓ Saved on this device. Sign in to keep it on your account.'}
              </p>
            )}
            {/* EXIT FIRST, PRIMARY LAST (ui-standard §6: primary is rightmost). Everything but
                `primary` is a secondary, so the row says which one the screen expects. */}
            <div className="overlay-buttons" ref={actionsRef} onClick={(e) => e.stopPropagation()}>
              <button className="secondary" onClick={onExit}>
                MENU
              </button>
              {(matchResult ?? practiceRun) && onWatchReplay && (
                <button className="secondary" onClick={() => onWatchReplay((matchResult ?? practiceRun)!.replay)}>
                  WATCH REPLAY
                </button>
              )}
              {rematchVote && (
                <RematchVote vote={rematchVote} onToggle={onRematchVote} primary={primary === 'vote'} />
              )}
              {/* REMATCH plays these same people on these same sides. This re-opens the room,
                  so the next game is built from whoever is in it then — which is what you want
                  when somebody left, or when the sides want swapping. */}
              {onBackToLobby && (
                <button className={rank(primary === 'lobby')} onClick={onBackToLobby}>
                  BACK TO LOBBY
                </button>
              )}
              {canRematch && (
                <button className={rank(primary === 'rematch')} onClick={onRematch}>
                  REMATCH
                </button>
              )}
              {/* the OTHER thing you want after a ranked match. REMATCH beside it plays
                  the same people again; this finds new ones without going out to the
                  menu and back in through Play ▸ Ranked. */}
              {onQueueAgain && (
                <button className={rank(primary === 'queue')} onClick={onQueueAgain}>
                  QUEUE AGAIN
                </button>
              )}
            </div>
            {/* REPORT is deliberately not in the button row. It is a rare, deliberate action and
                the row is where REMATCH and MENU live — the two things every player reaches for
                every match. A quiet link below keeps it available without putting it under a
                thumb aiming for the exit. */}
            {onReport && reportable && reportable.length > 0 && (
              <button
                ref={reportBtn}
                className="ds-linkbtn results-report resx-linkbtn"
                aria-expanded={reporting}
                onClick={(e) => {
                  e.stopPropagation();
                  setReporting((v) => !v);
                }}
              >
                <span aria-hidden="true">⚑</span> Report a player
              </button>
            )}
            {/* ...and the SCORE itself. A separate action from reporting a player because it is a
                separate claim: the score is the server's arithmetic, so a wrong one is nobody's
                misconduct and asking the reporter to name a culprit would be asking them to
                invent one. Only offered on a match that actually SCORED (a record run has its own
                number and no opponent to dispute it with). */}
            {onReportScore && matchResult && !scoreReported && (
              <button
                ref={scoreBtn}
                className="ds-linkbtn results-report resx-linkbtn"
                aria-expanded={scoreReporting}
                onClick={(e) => {
                  e.stopPropagation();
                  setScoreReporting((v) => !v);
                }}
              >
                <span aria-hidden="true">⚖</span> Report a misscore
              </button>
            )}
            {/* the link is gone once the claim is filed (one per match), so the confirmation
                takes the focus it would otherwise drop */}
            {scoreReported && (
              <p className="results-report-done resx-linkbtn" ref={scoreDone} tabIndex={-1} role="status">
                Misscore reported. A moderator will check the replay.
              </p>
            )}
            {scoreReporting && onReportScore && (
              <ScoreReportDialog
                onSubmit={(detail) => {
                  onReportScore(detail);
                  setScoreReported(true);
                  setScoreReporting(false);
                }}
                onClose={() => {
                  setScoreReporting(false);
                  scoreBtn.current?.focus();
                }}
              />
            )}
            {reporting && onReport && reportable && (
              <ReportDialog
                drivers={reportable}
                onSubmit={(rid, reason, detail) => onReport(rid, reason, detail)}
                onClose={() => {
                  setReporting(false);
                  reportBtn.current?.focus();
                }}
              />
            )}
            {/* AFTER the buttons, deliberately. The results screen is a good place for an ad —
                the match is over and the player is reading rather than driving — but REMATCH and
                MENU must stay the first things reachable, by mouse and by tab order. */}
            <ResultsAd />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The line UNDER the banner on a record run — the one that qualifies it.
 *
 * The banner (`recordBanner`) carries the headline; this carries what the headline does not
 * say, and NEVER the same fact twice. A world record and a personal best both need their
 * category and their placing spelled out; a plain placing has no headline at all, so its rank
 * IS the banner and only the category is left down here.
 *
 * Null info ⇒ the run is still being scored, or the build does not persist, or it was
 * anonymous (anonymous runs are never persisted, so no rank will ever exist). The banner is
 * blank through all three and this line is what speaks.
 */
function RecordStanding({
  info,
  signedIn,
  onSignIn,
}: {
  info: RecordRankInfo | null;
  signedIn: boolean;
  /** opens the account screen. Optional, so a caller that cannot navigate still renders — it
   *  just gets the sentence without the offer, rather than an arrow pointing at nothing. */
  onSignIn?: () => void;
}) {
  if (!info) {
    // alpha builds are not persisted server-side (no recordResult ever arrives) —
    // don't leave a signed-in player spinning on "Saving…"
    if (appChannel() === 'alpha') {
      return <p className="resx-standing pending">Not saved on this test build.</p>;
    }
    if (signedIn) return <p className="resx-standing pending">Saving · computing your rank…</p>;
    // ⚠️ A BUTTON, not a sentence with an arrow stuck on the end. This was a `<p>` reading
    // "… see your rank →", which promises an affordance the markup did not have: a signed-out
    // player could read the offer and had no way at all to take it from this screen. The
    // stage swallows clicks to skip the sequence, hence `stopPropagation`.
    return onSignIn ? (
      <button
        className="ds-linkbtn resx-linkbtn resx-standing signin"
        onClick={(e) => {
          e.stopPropagation();
          onSignIn();
        }}
      >
        Sign in to save this run and see your rank →
      </button>
    ) : (
      <p className="resx-standing signin">Sign in next time to save a run to the leaderboard.</p>
    );
  }
  const cat = `${info.mode === 'duo' ? 'Duo' : 'Solo'} · ${prettyDrivetrain(info.drivetrain)}`;
  const tone = info.isWR ? 'wr' : info.isPB ? 'pb' : 'rank';
  return (
    <p className={`resx-standing ${tone}`}>
      {info.isWR || info.isPB ? `${cat} · #${info.rank} of ${info.total}` : cat}
    </p>
  );
}

/** opponent-free record-run results: one net score (own penalties subtracted), a PB / WR /
 * rank line, and a single-column breakdown beside the total. No opponent, no winner — the
 * same full-screen anatomy as a versus match, just one alliance half, centred. */
function RecordResults({
  hud,
  mine,
  penaltyPts,
  netScore,
  revealed,
  lost,
  recordResult,
  signedIn,
  matchResult,
  practiceRun,
  canRematch,
  onRematch,
  onRunAgain,
  rematchVote,
  onRematchVote,
  onExit,
  onWatchReplay,
  onSignIn,
  roster,
}: {
  hud: HudSnapshot;
  mine: ScoreBreakdown;
  penaltyPts: number;
  /** the RAW net score. Animated HERE and only here — see the note at the call site. */
  netScore: number;
  revealed: boolean;
  /** the final score never arrived — see `HudSnapshot.resultLost` */
  lost: boolean;
  recordResult: RecordRankInfo | null;
  signedIn: boolean;
  matchResult: MatchResultInfo | null;
  /** the finished SOLO PRACTICE run — see the note on the other results screen */
  practiceRun: { replay: Replay; result: ReplayResult } | null;
  canRematch: boolean;
  onRematch: () => void;
  /** SOLO RECORD run only: start a fresh run (GameView's `onRestartRun`). A record run is
   *  server-hosted, so `canRematch` is false for it and RUN AGAIN needs its own callback. */
  onRunAgain?: () => void;
  /** duo-record co-op vote (null unless this run has one) */
  rematchVote: { votes: number; need: number; mine: boolean } | null;
  onRematchVote: () => void;
  onExit: () => void;
  onWatchReplay?: (replay: Replay) => void;
  /** open the account screen — see the same prop on `Results` */
  onSignIn?: () => void;
  /** who ran it — one row solo, two for a duo-record — from the replay's own setups */
  roster: readonly RosterEntry[];
}) {
  const cr = hud.game === 'chain';
  const f = hud.fouls[hud.alliance]; // fouls the PLAYER committed
  const { phase, skip } = usePhase(revealed);
  const rowsActive = phase === 'rows' || phase === 'totals' || phase === 'done';
  const totalsActive = phase === 'totals' || phase === 'done';
  const doneVisible = phase === 'done';
  const netCount = useCountUp(netScore, totalsActive, 700);

  // the game's own breakdown, through the module slot. A solo run has no opponent,
  // so only the "mine" half of each row is printed.
  const own = moduleFor(hud.game).resultsRows;
  const sections: SoloSection[] = own
    ? (own(hud) ?? []).map(([title, rows]) => [
        title,
        rows.map(([label, v]) => [label, v] as [string, number]),
      ])
    : cr && hud.chain
      ? [
          ['SCORING', [['Particles ×mult', hud.chain.particlePts]]],
          ['END GAME', [['Park / Ascend', mine.total - hud.chain.particlePts - hud.chain.foulPts]]],
        ]
      : [
          ['AUTONOMOUS', [
            ['Leave', mine.leave],
            ['Classified', mine.autoClassified],
            ['Overflow', mine.autoOverflow],
            ['Pattern', mine.autoPattern],
          ]],
          ['DRIVER-CONTROLLED', [
            ['Classified', mine.teleClassified],
            ['Overflow', mine.teleOverflow],
            ['Pattern', mine.telePattern],
          ]],
          ['END OF MATCH', [
            ['Depot', mine.depot],
            ['Base return', mine.base],
          ]],
        ];
  // PENALTIES belongs to whoever owns the breakdown: a game with its own `resultsRows`
  // puts its penalty row in `sections`, and printing this one too would show the
  // heading twice. `!own` is `!cr` for both games that existed - neither filled the slot.
  if (!own) {
    sections.push([
      'PENALTIES',
      [[`Fouls committed (${f.minor} minor · ${f.major} major)`, penaltyPts > 0 ? -penaltyPts : 0]],
    ]);
  }

  const season = seasonFor(hud.game).name;
  const duo = roster.length > 1;
  const modeLabel = `${duo ? 'DUO' : 'SOLO'} RECORD RUN`;
  const actionsRef = useFocusPrimaryAction(doneVisible);
  const stageRef = useDialog();

  return (
    <div
      className={`resx-stage${skippable(phase) ? ' skippable' : ''}`}
      onClick={skip}
      ref={stageRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Run results"
    >
      {phase !== 'wait' && (
        <div className="resx-sting" aria-hidden="true">
          RUN COMPLETE
        </div>
      )}
      <p className="ds-sr" aria-live="polite">
        {doneVisible ? `${cr ? 'Total' : 'Net score'} ${netScore}` : ''}
      </p>
      {/* the header and the actions sit INSIDE the body grid here too — see the note at the
          other screen. One column, so they simply stack above and below the half. */}
      <div className="resx-body resx-body-solo">
        <header className="resx-bar">
          <span className="resx-eyebrow">{modeLabel}</span>
          <h2 className="resx-title">{revealed ? 'RUN COMPLETE' : 'FINAL SCORE'}</h2>
          <span className="resx-season">{season}</span>
        </header>
        {!revealed && (
          <p className="resx-wait">
            {lost
              ? 'Couldn’t get the final score from the server. Check Career for the result.'
              : 'Waiting for the field to settle…'}
          </p>
        )}
        {/* `totalLabel` is NOT the alliance name here, unlike the versus screen: this number
            is a NET score with the runner's own penalties already subtracted, so it does not
            equal the breakdown beside it — which is exactly why that breakdown prints a
            NEGATIVE penalties row. `Red` would delete the only word explaining the gap. */}
        {phase !== 'wait' && (
          <>
            <AllianceHalf
              alliance={hud.alliance}
              phase={phase}
              banner={recordBanner(recordResult, false)}
              standing={
                phase !== 'wipe' ? (
                  <RecordStanding info={recordResult} signedIn={signedIn} onSignIn={onSignIn} />
                ) : null
              }
              roster={roster}
              showElo={false}
              total={netCount}
              totalLabel={cr ? 'Total' : 'Net score'}
            />
            <SoloTable sections={sections} rowsActive={rowsActive} />
          </>
        )}
        {doneVisible && (
          <div className="resx-secondary">
            <div className="overlay-buttons" ref={actionsRef} onClick={(e) => e.stopPropagation()}>
              <button className="secondary" onClick={onExit}>
                MENU
              </button>
              {(matchResult ?? practiceRun) && onWatchReplay && (
                <button className="secondary" onClick={() => onWatchReplay((matchResult ?? practiceRun)!.replay)}>
                  WATCH REPLAY
                </button>
              )}
              {/* CO-OP: the run belongs to both drivers, so restarting is a vote —
                  the same control (and the same R binding) as mid-match. */}
              {rematchVote && <RematchVote vote={rematchVote} onToggle={onRematchVote} primary={!canRematch} />}
              {(canRematch || onRunAgain) && (
                <button className="primary" onClick={onRunAgain ?? onRematch}>
                  RUN AGAIN
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
