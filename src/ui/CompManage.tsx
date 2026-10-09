import { useState } from 'react';
import { compAction, matchCard, matchFacts, matchRulings, type FactsPatch, type RulingsPatch } from '../net/competitions';
import type { CompetitionDetail, CompMatchView } from '../competition/wire';
import type { Alliance, CardColour, CompFormat, ResolvedBonus, ResolvedRanking, RpRuling } from '../competition/types';
import { MEASURE_TIEBREAKERS } from '../competition/types';
import {
  CARD_LABEL,
  DQ_REASON_LABEL,
  RULING_LABEL,
  RULING_NONE,
  STATUS_LABEL,
  bonusLabel,
  measureLabel,
  minutesLabel,
} from '../competition/copy';
import { entriesPerAlliance } from '../competition/settings';
import type { GameId } from '../games/types';
import { NOTICE_MESSAGE_MAX } from '../notices';
import { PlayerName, dqOf } from './CompParts';
import type { Run } from './CompDetail';

/**
 * THE ORGANIZER'S DESK — the competition's next step, the match queue, the staff and a message
 * to every entrant. A referee sees the match half only: calling matches and ruling on them is
 * theirs, the competition's shape and its lifecycle are the organizers'.
 *
 * Every step names what it does before it does it (`docs/ui-standard.md` §6: a confirm names the
 * target and the effect), and none of them is a timer: a competition moves when a person says so.
 */
export function CompManage({
  data,
  run,
  busy,
  slug,
  onEdit,
  onGone,
}: {
  data: CompetitionDetail;
  run: Run;
  busy: boolean;
  slug: string;
  onEdit: () => void;
  onGone: () => void;
}) {
  const c = data.competition;
  const s = c.settings;
  const v = data.viewer;
  const manager = v.role === 'admin' || v.role === 'organizer';
  const status = (to: string, extra: Record<string, unknown> = {}) => void run(() => compAction(slug, 'status', { to, ...extra }));
  const schedule = (action: string) => void run(() => compAction(slug, 'schedule', { action }));
  const quals = data.matches.filter((m) => m.stage === 'qual');
  const playoffs = data.matches.filter((m) => m.stage === 'playoff');
  const stageMatches = c.status === 'playoffs' ? playoffs : quals;
  const decided = stageMatches.filter((m) => m.status === 'done' || m.status === 'void').length;
  const called = stageMatches.filter((m) => m.status === 'called');
  const nextUp = stageMatches.filter((m) => m.status === 'scheduled').sort((a, b) => a.number - b.number)[0] ?? null;
  const registered = data.entries.filter((e) => e.status === 'registered');
  const checkedIn = registered.filter((e) => e.checkedIn).length;
  const per = entriesPerAlliance(c.format, c.teamMode);
  const playoffNeed = s.playoffs.alliances * per;
  const confirm = (what: string, effect: string): boolean => window.confirm(`${what}?\n\n${effect}`);

  return (
    <>
      <div className="ds-panel">
        <div className="ds-panel-h">
          <h2 className="ds-panel-title">Next step</h2>
          {manager && (
            <button className="ds-btn ghost small" onClick={onEdit}>
              Edit settings
            </button>
          )}
        </div>
        <div className="ds-panel-body stack">
          <p className="ds-hint">
            Now: <b>{STATUS_LABEL[c.status]}</b>.{' '}
            {c.status === 'published' &&
              `${registered.length} registered${s.checkIn ? `, ${checkedIn} checked in` : ''}${quals.length ? `, ${quals.length} qualification matches drawn` : ''}.`}
            {(c.status === 'qualification' || c.status === 'playoffs') &&
              `${decided} of ${stageMatches.length} matches decided, ${called.length} called.`}
          </p>
          {manager && (
            <div className="ds-actions">
              {c.status === 'draft' && (
                <button className="ds-btn primary" disabled={busy} onClick={() => confirm(`Publish ${c.name}`, 'It becomes visible, and registration follows its window.') && status('published')}>
                  Publish
                </button>
              )}
              {c.status === 'published' && (
                <>
                  <button className="ds-btn ghost" disabled={busy} onClick={() => status('draft')}>
                    Back to draft
                  </button>
                  {c.regClosesAt && c.regClosesAt <= data.now ? (
                    <button className="ds-btn" disabled={busy} onClick={() => status('openRegistration')}>
                      Reopen registration
                    </button>
                  ) : (
                    <button className="ds-btn" disabled={busy} onClick={() => status('closeRegistration')}>
                      Close registration
                    </button>
                  )}
                  {(s.quals.kind === 'balanced' || s.quals.kind === 'roundRobin') && (
                    <>
                      <button className="ds-btn" disabled={busy} onClick={() => schedule('draw')}>
                        {quals.length ? 'Draw again' : 'Draw schedule'}
                      </button>
                      {quals.length > 0 && (
                        <button className="ds-btn ghost" disabled={busy} onClick={() => schedule('clear')}>
                          Clear schedule
                        </button>
                      )}
                    </>
                  )}
                  {s.quals.kind === 'none' ? (
                    <button
                      className="ds-btn primary"
                      disabled={busy}
                      onClick={() =>
                        confirm('Close registration and seed the playoffs', `${s.checkIn ? 'Entries that have not checked in are left out. ' : ''}Seeding follows the organizer seeds, then registration order.`) &&
                        status('selection')
                      }
                    >
                      Seed the playoffs
                    </button>
                  ) : (
                    <button
                      className="ds-btn primary"
                      disabled={busy}
                      onClick={() =>
                        confirm('Start qualifications', `Registration closes.${s.checkIn ? ' Entries that have not checked in are left out.' : ''} Matches can then be called.`) &&
                        status('qualification')
                      }
                    >
                      Start qualifications
                    </button>
                  )}
                </>
              )}
              {c.status === 'qualification' && (
                <>
                  {s.quals.kind === 'swiss' && (
                    <button className="ds-btn" disabled={busy} onClick={() => schedule('round')}>
                      Draw next round
                    </button>
                  )}
                  <button
                    className="ds-btn primary"
                    disabled={busy}
                    onClick={() => {
                      const open = quals.filter((m) => m.status === 'scheduled').length;
                      if (!confirm('End qualifications', open ? `${open} unplayed match${open === 1 ? ' is' : 'es are'} voided. The rankings are frozen for seeding.` : 'The rankings are frozen for seeding.')) return;
                      status('selection', { force: open > 0 });
                    }}
                  >
                    {s.playoffs.enabled ? 'End qualifications' : 'Finish the competition'}
                  </button>
                </>
              )}
              {c.status === 'selection' && (
                <button
                  className="ds-btn primary"
                  disabled={busy}
                  onClick={() => confirm('Build the bracket and start the playoffs', 'The alliances are fixed from here on, and the first playoff matches are scheduled.') && status('playoffs')}
                >
                  Start the playoffs
                </button>
              )}
              {c.status === 'playoffs' && data.bracket && !data.bracket.complete && (
                <button
                  className="ds-btn ghost"
                  disabled={busy}
                  onClick={() => confirm('Finish now', 'Placements are written from the bracket as it stands; undecided series place their alliances together.') && status('completed', { force: true })}
                >
                  Finish now
                </button>
              )}
              {c.status !== 'completed' && c.status !== 'cancelled' && (
                <button
                  className="ds-btn ghost danger"
                  disabled={busy}
                  onClick={() => confirm(`Cancel ${c.name}`, 'Called matches are recalled and every entrant is told. This cannot be undone.') && status('cancelled')}
                >
                  Cancel competition
                </button>
              )}
              {(c.status === 'draft' || c.status === 'cancelled' || v.role === 'admin') && (
                <button
                  className="ds-btn ghost danger"
                  disabled={busy}
                  onClick={async () => {
                    if (!confirm(`Delete ${c.name}`, 'The competition, its entries, matches and log are deleted. Archived match replays stay. This cannot be undone.')) return;
                    if (await run(() => compAction(slug, 'delete'))) onGone();
                  }}
                >
                  Delete
                </button>
              )}
            </div>
          )}
          {c.status === 'selection' && registered.length < playoffNeed && (
            <p className="ds-hint warn">
              The playoffs need {playoffNeed} entries and {registered.length} are left. Lower the playoff alliances in the settings.
            </p>
          )}
        </div>
      </div>

      {(c.status === 'qualification' || c.status === 'playoffs') && (
        <div className="ds-panel">
          <div className="ds-panel-h">
            <h2 className="ds-panel-title">Match queue</h2>
          </div>
          <div className="ds-panel-body stack">
            <p className="ds-hint">
              {s.run.autoCall
                ? `Auto-calling is on: up to ${s.run.maxConcurrent} matches at once, each driver resting ${s.run.restSec} s between matches.`
                : 'Matches are called by hand.'}{' '}
              A called match waits {minutesLabel(s.run.joinGraceSec)} for its drivers;{' '}
              {s.run.noShow === 'forfeit' ? 'an alliance missing a driver forfeits.' : 'then it goes back on the schedule for you to decide.'}
            </p>
            <div className="ds-actions">
              {nextUp && (
                <button className="ds-btn primary" disabled={busy} onClick={() => void run(() => compAction(slug, 'match', { action: 'call', match: nextUp.id }))}>
                  Call {nextUp.label}
                </button>
              )}
              {manager && (
                <button
                  className="ds-btn"
                  disabled={busy}
                  onClick={() => void run(() => compAction(slug, 'update', { settings: { run: { ...s.run, autoCall: !s.run.autoCall } } }), s.run.autoCall ? 'Auto-calling is off.' : 'Auto-calling is on.')}
                >
                  {s.run.autoCall ? 'Stop auto-calling' : 'Start auto-calling'}
                </button>
              )}
            </div>
            {called.length > 0 && (
              <ul className="ds-comp-stack">
                {called.map((m) => (
                  <li key={m.id} className="ds-hint">
                    <b>{m.label}</b> {m.live ? `is live (${m.live.score.red}–${m.live.score.blue})` : 'is waiting for its drivers'}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {manager && <Staff data={data} run={run} busy={busy} slug={slug} />}
      {manager && <Message data={data} run={run} busy={busy} slug={slug} />}
    </>
  );
}

function Staff({ data, run, busy, slug }: { data: CompetitionDetail; run: Run; busy: boolean; slug: string }) {
  const [tag, setTag] = useState('');
  const [role, setRole] = useState<'referee' | 'organizer'>('referee');
  return (
    <div className="ds-panel">
      <div className="ds-panel-h">
        <h2 className="ds-panel-title">Staff</h2>
      </div>
      <div className="ds-panel-body stack">
        <p className="ds-hint">Organizers can do everything here. Referees call matches and rule on results.</p>
        {data.staff.length > 0 && (
          <ul className="ds-comp-stack">
            {data.staff.map((p) => (
              <li key={p.userId ?? p.handle} className="ds-comp-alliance">
                <span className="ds-comp-stack">
                  <span>
                    <PlayerName p={p} /> <span className="ds-muted">({p.role2})</span>
                  </span>
                </span>
                <button
                  className="ds-btn ghost small danger"
                  disabled={busy || !p.userId}
                  onClick={() => void run(() => compAction(slug, 'staff', { action: 'remove', userId: p.userId }))}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="ds-field-row"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => compAction(slug, 'staff', { action: 'add', tag: tag.trim(), role })).then((ok) => ok && setTag(''));
          }}
        >
          <input className="ds-input grow" placeholder="@username" aria-label="Staff member" value={tag} onChange={(e) => setTag(e.target.value)} />
          <select className="ds-select" aria-label="Role" value={role} onChange={(e) => setRole(e.target.value === 'organizer' ? 'organizer' : 'referee')}>
            <option value="referee">Referee</option>
            <option value="organizer">Organizer</option>
          </select>
          <button className="ds-btn" type="submit" disabled={busy || !tag.trim()}>
            Add
          </button>
        </form>
      </div>
    </div>
  );
}

function Message({ data, run, busy, slug }: { data: CompetitionDetail; run: Run; busy: boolean; slug: string }) {
  const [text, setText] = useState('');
  const n = data.entries.filter((e) => e.status !== 'withdrawn').length;
  return (
    <div className="ds-panel">
      <div className="ds-panel-h">
        <h2 className="ds-panel-title">Message the entrants</h2>
      </div>
      <form
        className="ds-panel-body stack"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => compAction(slug, 'message', { message: text })).then((ok) => ok && setText(''));
        }}
      >
        <textarea
          className="ds-input ds-comp-textarea"
          aria-label="Message"
          maxLength={NOTICE_MESSAGE_MAX}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="ds-actions">
          <span className="ds-muted">
            {text.length}/{NOTICE_MESSAGE_MAX} · goes to {n} entr{n === 1 ? 'y' : 'ies'} as a notice
          </span>
          <button className="ds-btn primary" type="submit" disabled={busy || !text.trim() || n === 0}>
            Send
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * ONE MATCH'S REFEREE ACTIONS, opened under its row. Every result a referee writes is logged,
 * audited for site staff, and told to the drivers in the match; a playoff result cannot change
 * once a later match was played on it (the server refuses with a sentence).
 */
export function MatchDesk({
  m,
  data,
  run,
  busy,
  slug,
  onClose,
}: {
  m: CompMatchView;
  data: CompetitionDetail;
  run: Run;
  busy: boolean;
  slug: string;
  onClose: () => void;
}) {
  const [red, setRed] = useState(m.result?.red != null ? String(m.result.red) : '');
  const [blue, setBlue] = useState(m.result?.blue != null ? String(m.result.blue) : '');
  const [redFoul, setRedFoul] = useState(String(m.result?.redFoul ?? 0));
  const [blueFoul, setBlueFoul] = useState(String(m.result?.blueFoul ?? 0));
  const [note, setNote] = useState('');
  // entries to disqualify with a forfeit (no-shows): R7, qualification matches only
  const [absent, setAbsent] = useState<number[]>([]);
  const act = (action: string, extra: Record<string, unknown> = {}) =>
    run(() => compAction(slug, 'match', { action, match: m.id, note: note.trim() || undefined, ...extra }));
  const entries = new Map(data.entries.map((e) => [e.id, e]));
  const nameOf = (id: number): string => entries.get(id)?.name ?? `#${id}`;
  const num = (v: string): string => v.replace(/[^0-9]/g, '').slice(0, 5);
  const stageLive =
    (m.stage === 'qual' && data.competition.status === 'qualification') || (m.stage === 'playoff' && data.competition.status === 'playoffs');
  const slots = [...m.red, ...m.blue];
  const counted = slots.filter((s) => !s.surrogate);
  const forfeit = (winner: Alliance): void => {
    const dq = absent.filter((e) => counted.some((s) => s.entry === e));
    const who = dq.map(nameOf);
    const also = who.length ? `\n\n${who.join(' and ')} ${who.length === 1 ? 'is' : 'are'} disqualified in it.` : '';
    if (!window.confirm(`${m.label}: ${winner} wins by forfeit?${also}`)) return;
    void act('forfeit', { winner, ...(dq.length ? { dq } : {}) }).then((ok) => ok && setAbsent([]));
  };
  // what disqualifies each entry here, cards and their escalation included (`effectiveDq`)
  const out = dqOf(m);
  return (
    <div className="ds-comp-stack">
      <div className="ds-actions">
        {stageLive && m.status !== 'done' && m.status !== 'void' && (
          <button className="ds-btn" disabled={busy} onClick={() => void act('call')}>
            {m.status === 'called' ? 'Call again (new room)' : 'Call'}
          </button>
        )}
        {m.status === 'called' && (
          <button className="ds-btn ghost" disabled={busy} onClick={() => void act('uncall')}>
            Cancel the call
          </button>
        )}
        {m.status !== 'void' && (
          <>
            <button className="ds-btn ghost" disabled={busy} onClick={() => forfeit('red')}>
              Red by forfeit
            </button>
            <button className="ds-btn ghost" disabled={busy} onClick={() => forfeit('blue')}>
              Blue by forfeit
            </button>
            <button className="ds-btn ghost danger" disabled={busy} onClick={() => window.confirm(`Void ${m.label}?\n\nIt stops counting for anyone.`) && void act('void')}>
              Void
            </button>
          </>
        )}
        {(m.status === 'done' || m.status === 'void') && (
          <button className="ds-btn ghost" disabled={busy} onClick={() => window.confirm(`Reset ${m.label}?\n\nIts result is cleared and it goes back on the schedule.`) && void act('reset')}>
            Play again
          </button>
        )}
        <button className="ds-btn ghost" onClick={onClose}>
          Close
        </button>
      </div>
      {m.stage === 'qual' && m.status !== 'void' && counted.length > 0 && (
        <div className="ds-actions" role="group" aria-labelledby={`dqabsent-${m.id}`}>
          <span className="ds-muted" id={`dqabsent-${m.id}`}>Disqualify the absent entries with a forfeit:</span>
          {counted.map((s) => (
            <label key={s.entry} className="ds-checkline">
              <input
                type="checkbox"
                checked={absent.includes(s.entry)}
                disabled={busy}
                onChange={(e) => setAbsent((xs) => (e.target.checked ? [...xs, s.entry] : xs.filter((x) => x !== s.entry)))}
              />
              {nameOf(s.entry)}
            </label>
          ))}
        </div>
      )}
      <form
        className="ds-form ds-comp-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void act('result', { red: Number(red), blue: Number(blue), redFoul: Number(redFoul || 0), blueFoul: Number(blueFoul || 0) });
        }}
      >
        <label>
          <span>Red score</span>
          <input className="ds-input" inputMode="numeric" value={red} onChange={(e) => setRed(num(e.target.value))} />
        </label>
        <label>
          <span>Blue score</span>
          <input className="ds-input" inputMode="numeric" value={blue} onChange={(e) => setBlue(num(e.target.value))} />
        </label>
        <label>
          <span>Foul points red was given</span>
          <input className="ds-input" inputMode="numeric" value={redFoul} onChange={(e) => setRedFoul(num(e.target.value))} />
        </label>
        <label>
          <span>Foul points blue was given</span>
          <input className="ds-input" inputMode="numeric" value={blueFoul} onChange={(e) => setBlueFoul(num(e.target.value))} />
        </label>
        <label className="wide">
          <span>Reason (shown with the result)</span>
          <input className="ds-input" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <div className="ds-actions wide">
          <button className="ds-btn" type="submit" disabled={busy || red === '' || blue === ''}>
            {m.status === 'done' ? 'Correct result' : 'Enter result'}
          </button>
        </div>
      </form>
      {m.status === 'done' && (
        <RankingForm key={`${m.id}:${m.attempt}`} m={m} ranking={data.ranking} game={data.competition.game} format={data.competition.format} nameOf={nameOf} run={run} busy={busy} slug={slug} />
      )}
      {m.status === 'done' && (
        <div className="ds-actions">
          <span className="ds-muted">Disqualified in this match (no ranking points):</span>
          {slots.map((s) => {
            const on = m.dq.includes(s.entry);
            const why = out.get(s.entry);
            // a DQ a card caused is not this toggle's: it lifts when the card does
            if (!on && why && why !== 'dq') {
              return (
                <button key={s.entry} className="ds-btn small danger" aria-pressed disabled>
                  {nameOf(s.entry)}: {DQ_REASON_LABEL[why]}
                </button>
              );
            }
            return (
              <button key={s.entry} className={`ds-btn small${on ? ' danger' : ' ghost'}`} aria-pressed={on} disabled={busy} onClick={() => void act('dq', { entry: s.entry, on: !on })}>
                {nameOf(s.entry)}
                {s.surrogate ? ' (surrogate)' : ''}
              </button>
            );
          })}
        </div>
      )}
      {m.status === 'done' && slots.some((s) => s.surrogate && m.dq.includes(s.entry)) && (
        <p className="ds-hint">A disqualification on a surrogate appearance has no effect: that match doesn’t count for the entry.</p>
      )}
    </div>
  );
}

/** how a referee counts a measure, where the label alone does not say (the inputs are not the
 *  results screen's lines: `artifacts` is a count, `tips` is a count where the HUD shows points) */
/** how a measure is counted, for a referee typing it; `two`: two robots an alliance */
function measureHow(game: GameId, id: string, two: boolean): string | null {
  switch (id) {
    case 'auto':
      return game === 'chain' ? 'scored before AUTO ends' : 'scored before TELEOP starts';
    case 'artifacts':
      return 'classified + overflow, every pass';
    case 'movement':
      return two ? 'both robots, the BASE bonus included' : null;
    case 'base':
      return two ? 'both robots, the bonus included' : null;
    case 'pattern':
      return 'AUTO + TELEOP';
    case 'swarm':
      return two ? 'both robots, AUTO and TELEOP PARK' : 'AUTO and TELEOP PARK';
    case 'tips':
      return 'a count: TIPS points ÷ 20';
    default:
      return null;
  }
}

const SIDES: Alliance[] = ['red', 'blue'];

interface RpDraft {
  /** per alliance, per measure: the input's text ('' = unknown) */
  facts: Record<Alliance, Record<string, string>>;
  /** per alliance, per bonus id: '' = as scored */
  rulings: Record<Alliance, Record<string, RpRuling | ''>>;
  /** per entry id: the referee's card, '' = none */
  cards: Record<string, CardColour | ''>;
}

/**
 * THE RANKING-POINT CORRECTIONS for one decided qualification match: what the game measured (only
 * the measures this competition's ranking reads; never the sim's G417 flag, which the 'Awarded'
 * ruling already expresses), a ruling per bonus RP where the manual allows one, and a referee card
 * per entry. Folded by default under the result form, with its own Save and a required reason,
 * because every change is a public log line.
 *
 * Only what CHANGED is sent, against the values this form opened with (`base`), not the latest
 * poll: a field another referee changed meanwhile is left alone rather than reverted. Keyed on the
 * match's attempt, so a reset and replay opens a fresh form.
 *
 * Nothing at all under `custom` with no measured tiebreaker (there is nothing to read), on a
 * forfeit (no score to rule on) or on a playoff match (no ranking points).
 */
function RankingForm({
  m,
  ranking,
  game,
  format,
  nameOf,
  run,
  busy,
  slug,
}: {
  m: CompMatchView;
  ranking: ResolvedRanking | undefined;
  game: GameId;
  format: CompFormat;
  nameOf: (id: number) => string;
  run: Run;
  busy: boolean;
  slug: string;
}) {
  const needed = new Set<string>();
  for (const b of ranking?.bonus ?? []) needed.add(b.measure);
  for (const t of ranking?.tiebreakers ?? []) {
    const k = MEASURE_TIEBREAKERS[t];
    if (k) needed.add(k);
  }
  const measures = (ranking?.measures ?? []).filter((k) => needed.has(k) && k !== 'patternAward');
  const ruled: ResolvedBonus[] = (ranking?.bonus ?? []).filter((b) => b.award || b.deny);
  const draft = (): RpDraft => {
    const side = <T,>(fn: (a: Alliance) => T): Record<Alliance, T> => ({ red: fn('red'), blue: fn('blue') });
    const fact = (a: Alliance, k: string): string => {
      const v = m.facts?.[a]?.[k];
      return typeof v === 'number' ? String(v) : '';
    };
    return {
      facts: side((a) => Object.fromEntries(measures.map((k) => [k, fact(a, k)]))),
      rulings: side((a) => Object.fromEntries(ruled.map((b) => [b.id, m.rulings?.[a]?.[b.id] ?? '']))),
      cards: Object.fromEntries([...m.red, ...m.blue].map((s) => [String(s.entry), m.refCards?.[String(s.entry)] ?? ''])),
    };
  };
  const [base, setBase] = useState<RpDraft>(draft);
  const [cur, setCur] = useState<RpDraft>(draft);
  const [why, setWhy] = useState('');

  const scored = m.stage === 'qual' && !!m.result && m.result.red !== null && m.result.blue !== null;
  // cards escalate under either scheme, so the form is always there for them; facts and rulings
  // only where the ranking reads them
  if (!ranking || !scored) return null;
  const title = measures.length || ruled.length ? 'Ranking points and cards' : 'Cards';

  const factsPatch: FactsPatch = {};
  const rulingsPatch: RulingsPatch = {};
  for (const a of SIDES) {
    for (const k of measures) {
      if (cur.facts[a][k] === base.facts[a][k]) continue;
      (factsPatch[a] ??= {})[k] = cur.facts[a][k] === '' ? null : Number(cur.facts[a][k]);
    }
    for (const b of ruled) {
      if (cur.rulings[a][b.id] === base.rulings[a][b.id]) continue;
      (rulingsPatch[a] ??= {})[b.id] = cur.rulings[a][b.id] || null;
    }
  }
  const cardChanges = Object.keys(cur.cards).filter((e) => cur.cards[e] !== base.cards[e]);
  const factsChanged = Object.keys(factsPatch).length > 0;
  const rulingsChanged = Object.keys(rulingsPatch).length > 0;
  const changed = factsChanged || rulingsChanged || cardChanges.length > 0;

  const setFact = (a: Alliance, k: string, v: string): void =>
    setCur((x) => ({ ...x, facts: { ...x.facts, [a]: { ...x.facts[a], [k]: v.replace(/[^0-9]/g, '').slice(0, 4) } } }));
  const setRuling = (a: Alliance, id: string, v: string): void =>
    setCur((x) => ({ ...x, rulings: { ...x.rulings, [a]: { ...x.rulings[a], [id]: v === 'award' || v === 'deny' ? v : '' } } }));
  const setCard = (entry: number, v: string): void =>
    setCur((x) => ({ ...x, cards: { ...x.cards, [String(entry)]: v === 'yellow' || v === 'red' ? v : '' } }));

  const save = (): void => {
    const note = why.trim();
    const sent = cur;
    // one request per kind, in order; each one that lands moves `base`, so a refusal part-way
    // leaves only the unsent changes marked as changed
    void run(async () => {
      let res: unknown = null;
      if (factsChanged) {
        res = await matchFacts(slug, m, factsPatch, note);
        setBase((b) => ({ ...b, facts: sent.facts }));
      }
      if (rulingsChanged) {
        res = await matchRulings(slug, m, rulingsPatch, note);
        setBase((b) => ({ ...b, rulings: sent.rulings }));
      }
      for (const e of cardChanges) {
        const c = sent.cards[e];
        res = await matchCard(slug, m, Number(e), c === '' ? null : c, note);
        setBase((b) => ({ ...b, cards: { ...b.cards, [e]: c } }));
      }
      return res;
    }, `${m.label} updated.`).then((ok) => ok && setWhy(''));
  };

  return (
    <details className="ds-fold inset">
      <summary>{title}</summary>
      <form
        className="ds-fold-body ds-form"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="ds-comp-grid">
          {SIDES.map((a) => {
            const now = m.rp?.alliance[a];
            // a flag the sim set (DECODE's G417), shown and never typed
            const flags = (ranking.bonus ?? []).flatMap((b) => (b.awardFact && (m.facts?.[a]?.[b.awardFact] ?? 0) > 0 ? [b.awardFact] : []));
            return (
              <fieldset key={a} className={`ds-comp-facts ${a}`}>
                <legend>{a === 'red' ? 'Red' : 'Blue'}</legend>
                {now && (
                  <p className="ds-hint">
                    {now.total} RP: {now.result} for the result
                    {now.bonus.length > 0 && ` + ${now.bonus.map(bonusLabel).join(' + ')}`}
                  </p>
                )}
                {flags.map((f) => (
                  <p key={f} className="ds-hint">
                    {measureLabel(f)}
                  </p>
                ))}
                {measures.map((k) => {
                  const how = measureHow(game, k, format === '2v2');
                  return (
                    <label key={k}>
                      <span>
                        {measureLabel(k)}
                        {how && ` (${how})`}
                      </span>
                      <input className="ds-input" inputMode="numeric" placeholder="Unknown" value={cur.facts[a][k]} onChange={(e) => setFact(a, k, e.target.value)} />
                    </label>
                  );
                })}
                {ruled.map((b) => (
                  <label key={b.id}>
                    <span>{bonusLabel(b.id)}</span>
                    <select className="ds-select" value={cur.rulings[a][b.id]} onChange={(e) => setRuling(a, b.id, e.target.value)}>
                      <option value="">{RULING_NONE}</option>
                      {b.award && <option value="award">{RULING_LABEL.award}</option>}
                      {b.deny && <option value="deny">{RULING_LABEL.deny}</option>}
                    </select>
                  </label>
                ))}
                {m[a].map((s) => {
                  const name = nameOf(s.entry);
                  const sim = m.cards?.[String(s.entry)];
                  return (
                    <label key={s.entry}>
                      <span>
                        {name}
                        {s.surrogate ? ' (surrogate)' : ''}
                      </span>
                      <span className="ds-field-row">
                        <select className="ds-select" aria-label={`Card for ${name}`} value={cur.cards[String(s.entry)] ?? ''} onChange={(e) => setCard(s.entry, e.target.value)}>
                          <option value="">No card</option>
                          <option value="yellow">{CARD_LABEL.yellow}</option>
                          <option value="red">{CARD_LABEL.red}</option>
                        </select>
                        {sim && (
                          <span className="ds-muted">
                            In play: <span className={`ds-badge ${sim === 'red' ? 'danger' : 'warn'}`}>{CARD_LABEL[sim]}</span>
                          </span>
                        )}
                      </span>
                      {sim === 'yellow' && cur.cards[String(s.entry)] === 'yellow' && <span className="ds-hint warn">Two yellow cards in one match are a red card.</span>}
                    </label>
                  );
                })}
              </fieldset>
            );
          })}
        </div>
        <label>
          <span>Reason (shown in the log)</span>
          <input className="ds-input" maxLength={200} required value={why} onChange={(e) => setWhy(e.target.value)} />
        </label>
        <div className="ds-actions">
          <button className="ds-btn" type="submit" disabled={busy || !changed || !why.trim()}>
            Save
          </button>
        </div>
      </form>
    </details>
  );
}
