import { useState } from 'react';
import { compAction } from '../net/competitions';
import type { CompetitionDetail, CompMatchView } from '../competition/wire';
import { STATUS_LABEL, minutesLabel } from '../competition/copy';
import { entriesPerAlliance } from '../competition/settings';
import { NOTICE_MESSAGE_MAX } from '../notices';
import { PlayerName } from './CompParts';
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
  const act = (action: string, extra: Record<string, unknown> = {}) =>
    run(() => compAction(slug, 'match', { action, match: m.id, note: note.trim() || undefined, ...extra }));
  const entries = new Map(data.entries.map((e) => [e.id, e]));
  const num = (v: string): string => v.replace(/[^0-9]/g, '').slice(0, 5);
  const stageLive =
    (m.stage === 'qual' && data.competition.status === 'qualification') || (m.stage === 'playoff' && data.competition.status === 'playoffs');
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
            <button className="ds-btn ghost" disabled={busy} onClick={() => window.confirm(`${m.label}: red wins by forfeit?`) && void act('forfeit', { winner: 'red' })}>
              Red by forfeit
            </button>
            <button className="ds-btn ghost" disabled={busy} onClick={() => window.confirm(`${m.label}: blue wins by forfeit?`) && void act('forfeit', { winner: 'blue' })}>
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
        <div className="ds-actions">
          <span className="ds-muted">Disqualified in this match (no ranking points):</span>
          {[...m.red, ...m.blue].map((s) => {
            const on = m.dq.includes(s.entry);
            return (
              <button key={s.entry} className={`ds-btn small${on ? ' danger' : ' ghost'}`} aria-pressed={on} disabled={busy} onClick={() => void act('dq', { entry: s.entry, on: !on })}>
                {entries.get(s.entry)?.name ?? `#${s.entry}`}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
