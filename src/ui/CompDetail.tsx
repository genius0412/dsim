import { useEffect, useMemo, useState } from 'react';
import { CompError, compAction, fetchCompetition } from '../net/competitions';
import type { CompetitionDetail, CompEntryView, CompMatchView } from '../competition/wire';
import {
  BRACKET_LABEL,
  ENTRY_LABEL,
  QUAL_LABEL,
  SELECTION_LABEL,
  TIEBREAK_LABEL,
  bestOfLabel,
  countdown,
  formatLabel,
  logLine,
  minutesLabel,
  phaseLine,
} from '../competition/copy';
import { entriesPerAlliance } from '../competition/settings';
import { seasonFor } from '../seasons';
import { fmtDay, fmtDayTime } from './fmtDate';
import { Markdown } from './markdown';
import { useCompPoll, saveCsv, Ago } from './compBits';
import { EntryLine, MatchState, PlayerName, ScoreCell, Side, StatusBadge, allianceOf, inMatch } from './CompParts';
import { CompPlayoffs } from './CompBracket';
import { CompManage, MatchDesk } from './CompManage';

export type CompTab = 'overview' | 'entrants' | 'matches' | 'rankings' | 'playoffs' | 'manage' | 'log';
export const COMP_TABS: CompTab[] = ['overview', 'entrants', 'matches', 'rankings', 'playoffs', 'manage', 'log'];

/** an action's outcome, shown in the one status line under the header */
export interface ActState {
  busy: boolean;
  msg: string | null;
  bad: boolean;
}
export type Run = (fn: () => Promise<{ note?: string } | unknown>, okMsg?: string) => Promise<boolean>;

/**
 * ONE COMPETITION'S PAGE. Polled every five seconds while the tab is visible (`useCompPoll`), so a
 * called match, a result or a pick shows up without a reload; the server caches the read for two
 * seconds, so a room full of spectators is one database read per beat, not one each.
 */
export function CompDetail({
  slug,
  tab,
  onTab,
  onBack,
  onPlay,
  onWatch,
  onWatchReplay,
  onProfile,
  onEdit,
  onSignIn,
  onGone,
}: {
  slug: string;
  tab: CompTab;
  onTab: (t: CompTab) => void;
  onBack: () => void;
  onPlay: (slug: string) => void;
  onWatch: (room: string, region?: string) => void;
  onWatchReplay: (replayId: string) => void;
  onProfile: (username: string) => void;
  onEdit: () => void;
  onSignIn: () => void;
  onGone: () => void;
}) {
  const [missing, setMissing] = useState(false);
  const { data, err, reload } = useCompPoll<CompetitionDetail>(
    () =>
      fetchCompetition(slug).catch((e: unknown) => {
        if (e instanceof CompError && e.status === 404) setMissing(true);
        else console.warn('[competitions] detail failed', e);
        return null;
      }),
    5000,
  );
  const [act, setAct] = useState<ActState>({ busy: false, msg: null, bad: false });
  const run: Run = async (fn, okMsg) => {
    setAct({ busy: true, msg: null, bad: false });
    try {
      const out = (await fn()) as { note?: string } | undefined;
      setAct({ busy: false, msg: out?.note ?? okMsg ?? null, bad: false });
      reload();
      return true;
    } catch (e) {
      setAct({ busy: false, msg: e instanceof Error ? e.message : 'Couldn’t do that. Try again.', bad: true });
      return false;
    }
  };

  // a one-second clock for the countdowns, only while something is counting
  const [now, setNow] = useState(() => Date.now());
  const skew = data ? data.now - Date.now() : 0;
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const serverNow = now + skew;

  if (missing) {
    return (
      <div className="ds-comp">
        <button className="ds-back" onClick={onBack}>
          ← Competitions
        </button>
        <div className="ds-panel">
          <div className="ds-empty">
            <div className="big">No such competition</div>
            It may have been deleted, or the link is wrong.
          </div>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="ds-comp">
        <button className="ds-back" onClick={onBack}>
          ← Competitions
        </button>
        <div className="ds-panel">
          {err ? (
            <div className="ds-empty">
              <div className="big">Couldn’t load the competition</div>
              Trying again every few seconds.
            </div>
          ) : (
            <div className="ds-loading">Loading the competition…</div>
          )}
        </div>
      </div>
    );
  }

  const c = data.competition;
  const v = data.viewer;
  const staff = v.role !== null;
  const manager = v.role === 'admin' || v.role === 'organizer';
  const entries = new Map(data.entries.map((e) => [e.id, e]));
  const mine = v.entryId !== null ? (entries.get(v.entryId) ?? null) : null;
  const myCalled = data.matches.find((m) => m.status === 'called' && inMatch(m, v.entryId)) ?? null;
  const upcoming = data.matches.filter((m) => m.status === 'scheduled' || m.status === 'called');
  const myNext = v.entryId !== null ? (upcoming.find((m) => m.status === 'scheduled' && inMatch(m, v.entryId)) ?? null) : null;
  const ahead = myNext ? upcoming.filter((m) => m.stage === myNext.stage && m.number < myNext.number && m.status === 'scheduled').length : 0;
  const hasPlayoffs = !!(data.bracket || data.selection || data.alliances) && c.settings.playoffs.enabled;
  const tabs: { id: CompTab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'entrants', label: `Entrants (${data.entries.filter((e) => e.status === 'registered').length})` },
    ...(data.matches.length ? [{ id: 'matches' as const, label: 'Matches' }] : []),
    ...(data.rankings ? [{ id: 'rankings' as const, label: 'Rankings' }] : []),
    ...(hasPlayoffs ? [{ id: 'playoffs' as const, label: 'Playoffs' }] : []),
    ...(staff ? [{ id: 'manage' as const, label: manager ? 'Manage' : 'Referee' }] : []),
    { id: 'log' as const, label: 'Log' },
  ];
  const shown = tabs.some((t) => t.id === tab) ? tab : 'overview';

  return (
    <div className="ds-comp">
      <button className="ds-back" onClick={onBack}>
        ← Competitions
      </button>
      <div className="ds-comp-head">
        <div className="ds-comp-title">
          <h1 className="ds-h1">{c.name}</h1>
          <span className="ds-comp-tags">
            <StatusBadge status={c.status} />
            {c.official && <span className="ds-badge staff">Official</span>}
            <span className="ds-badge">{seasonFor(c.game).name}</span>
            <span className="ds-badge">{formatLabel(c.format, c.teamMode)}</span>
            {c.visibility === 'unlisted' && <span className="ds-badge">Unlisted</span>}
          </span>
        </div>
        <EntrantActions data={data} mine={mine} act={act} run={run} onSignIn={onSignIn} slug={slug} />
      </div>
      <p className="ds-sub compact">{c.summary || phaseLine({ ...c, now: serverNow })}</p>
      {act.msg && (
        <p className={`ds-hint${act.bad ? ' err' : ' ok'}`} role="status">
          {act.msg}
        </p>
      )}

      {myCalled && (
        <div className="ds-comp-call" role="alert">
          <span>
            <b>{myCalled.label} is called.</b>{' '}
            {myCalled.live ? 'It’s being played.' : 'Join now.'}
            {myCalled.graceEndsAt && !myCalled.live && (
              <>
                {' '}
                <span className="clock">{countdown(myCalled.graceEndsAt - serverNow)}</span> left to join.
              </>
            )}
          </span>
          <button className="ds-btn primary" onClick={() => onPlay(slug)}>
            {myCalled.live ? 'Rejoin match' : 'Join match'}
          </button>
        </div>
      )}
      {!myCalled && myNext && (
        <div className="ds-comp-call quiet">
          <span>
            Your next match is <b>{myNext.label}</b>
            {ahead > 0 ? `, ${ahead} match${ahead === 1 ? '' : 'es'} ahead of it.` : ', next up.'} Stay on this page or in the menus: you’ll be told when it’s called.
          </span>
        </div>
      )}

      <nav className="ds-tabs" aria-label="Competition sections">
        {tabs.map((t) => (
          <button key={t.id} className={`ds-tab${shown === t.id ? ' on' : ''}`} aria-current={shown === t.id ? 'page' : undefined} onClick={() => onTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      {shown === 'overview' && <Overview data={data} onProfile={onProfile} />}
      {shown === 'entrants' && <Entrants data={data} run={run} busy={act.busy} slug={slug} onProfile={onProfile} />}
      {shown === 'matches' && (
        <Matches data={data} entries={entries} run={run} busy={act.busy} slug={slug} onWatch={onWatch} onWatchReplay={onWatchReplay} />
      )}
      {shown === 'rankings' && <Rankings data={data} entries={entries} />}
      {shown === 'playoffs' && <CompPlayoffs data={data} entries={entries} run={run} busy={act.busy} slug={slug} onProfile={onProfile} />}
      {shown === 'manage' && staff && (
        <CompManage data={data} run={run} busy={act.busy} slug={slug} onEdit={onEdit} onGone={onGone} />
      )}
      {shown === 'log' && <Log data={data} />}
    </div>
  );
}

// ------------------------------------------------------------------ entrant actions

function EntrantActions({
  data,
  mine,
  act,
  run,
  onSignIn,
  slug,
}: {
  data: CompetitionDetail;
  mine: CompEntryView | null;
  act: ActState;
  run: Run;
  onSignIn: () => void;
  slug: string;
}) {
  const v = data.viewer;
  const c = data.competition;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [number, setNumber] = useState('');
  const [partner, setPartner] = useState('');
  const duo = c.teamMode === 'duo';
  if (!v.signedIn) {
    if (c.status !== 'published') return null;
    return (
      <div className="ds-comp-acts">
        <button className="ds-btn primary" onClick={onSignIn}>
          Sign in to register
        </button>
      </div>
    );
  }
  if (v.inviteEntryId !== null) {
    const inv = data.entries.find((e) => e.id === v.inviteEntryId);
    return (
      <div className="ds-comp-acts">
        <span className="ds-hint">{inv ? `${inv.name} invited you as their partner.` : 'You have an invitation.'}</span>
        <button className="ds-btn ghost" disabled={act.busy} onClick={() => void run(() => compAction(slug, 'partner', { accept: false }))}>
          Decline
        </button>
        <button className="ds-btn primary" disabled={act.busy} onClick={() => void run(() => compAction(slug, 'partner', { accept: true }))}>
          Accept
        </button>
      </div>
    );
  }
  if (mine) {
    const over = c.status === 'completed' || c.status === 'cancelled';
    return (
      <div className="ds-comp-acts">
        <span className="ds-badge ok">{over && mine.placement ? `Placed ${ordinalPlace(mine.placement)}` : ENTRY_LABEL[mine.status]}</span>
        {v.canCheckIn && (
          <button className="ds-btn primary" disabled={act.busy} onClick={() => void run(() => compAction(slug, 'checkin'))}>
            Check in
          </button>
        )}
        {mine.checkedIn && c.settings.checkIn && c.status === 'published' && <span className="ds-badge ok">Checked in</span>}
        {!over && mine.status !== 'withdrawn' && mine.status !== 'disqualified' && (
          <button
            className="ds-btn ghost"
            disabled={act.busy}
            onClick={() => {
              if (!window.confirm(`Withdraw from ${c.name}?\n\n${c.status === 'published' ? 'Your place goes to the next on the waitlist.' : 'Your remaining matches are played without you.'}`)) return;
              void run(() => compAction(slug, 'withdraw'));
            }}
          >
            Withdraw
          </button>
        )}
      </div>
    );
  }
  if (!v.canRegister) return v.registerBlock && c.status === 'published' ? <p className="ds-hint">{v.registerBlock}</p> : null;
  if (!open) {
    return (
      <div className="ds-comp-acts">
        <button className="ds-btn primary" onClick={() => setOpen(true)}>
          Register
        </button>
      </div>
    );
  }
  return (
    <form
      className="ds-form ds-panel ds-panel-body"
      onSubmit={(e) => {
        e.preventDefault();
        void run(() =>
          compAction(slug, 'register', {
            name: name.trim() || undefined,
            number: number.trim() ? Number(number) : undefined,
            partner: duo ? partner.trim() : undefined,
          }),
        ).then((ok) => ok && setOpen(false));
      }}
    >
      <label>
        <span>{duo ? 'Team name' : 'Name on the schedule (blank: your display name)'}</span>
        <input className="ds-input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        <span>Team number (optional)</span>
        <input className="ds-input" inputMode="numeric" value={number} maxLength={6} onChange={(e) => setNumber(e.target.value.replace(/[^0-9]/g, ''))} />
      </label>
      {duo && (
        <label>
          <span>Partner’s @username</span>
          <input className="ds-input" value={partner} maxLength={40} required onChange={(e) => setPartner(e.target.value)} />
        </label>
      )}
      <p className="ds-form-hint">Competition matches are public, replays included.</p>
      <div className="ds-actions">
        <button type="button" className="ds-btn ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button type="submit" className="ds-btn primary" disabled={act.busy || (duo && !partner.trim())}>
          {duo ? 'Invite and register' : 'Register'}
        </button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------ overview

function Overview({ data, onProfile }: { data: CompetitionDetail; onProfile: (u: string) => void }) {
  const c = data.competition;
  const s = c.settings;
  const registered = data.entries.filter((e) => e.status === 'registered').length;
  const waitlist = data.entries.filter((e) => e.status === 'waitlist').length;
  const placements = useMemo(
    () => data.entries.filter((e) => e.placement !== null && e.placement <= 3).sort((a, b) => (a.placement ?? 0) - (b.placement ?? 0)),
    [data.entries],
  );
  const window_ = (a: number | null, b: number | null): string =>
    a || b ? `${a ? fmtDayTime(a) : 'Now'} → ${b ? fmtDayTime(b) : 'until it starts'}` : 'Open until it starts';
  return (
    <>
      {c.status === 'completed' && placements.length > 0 && (
        <div className="ds-panel">
          <div className="ds-panel-h">
            <h2 className="ds-panel-title">Results</h2>
          </div>
          <div className="ds-panel-body ds-comp-podium">
            {/* one card per PLACE: a 2v2 alliance of two entries won together, and two
                semifinal losers share third */}
            {[...new Set(placements.map((e) => e.placement as number))].map((place) => {
              const here = placements.filter((e) => e.placement === place);
              return (
                <div key={place} className={`ds-comp-place${place === 1 ? ' first' : ''}`}>
                  <span className="n">{place === 1 ? (here.length > 1 ? 'Champions' : 'Champion') : place === 2 ? (here.length > 1 ? 'Finalists' : 'Finalist') : 'Third place'}</span>
                  <span className="who">{here.map((e) => e.name).join(' & ')}</span>
                  <span className="ds-comp-side">
                    {here.flatMap((e) => e.players).map((p, i) => (
                      <span key={p.userId ?? i}>
                        <PlayerName p={p} onProfile={onProfile} />
                      </span>
                    ))}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {c.description && (
        <div className="ds-panel">
          <div className="ds-panel-h">
            <h2 className="ds-panel-title">About</h2>
          </div>
          <div className="ds-panel-body">
            <Markdown text={c.description} />
          </div>
        </div>
      )}
      <div className="ds-panel">
        <div className="ds-panel-h">
          <h2 className="ds-panel-title">Details</h2>
        </div>
        <div className="ds-panel-body">
          <dl className="ds-facts">
            <dt>Game</dt>
            <dd>{seasonFor(c.game).name}</dd>
            <dt>Format</dt>
            <dd>{formatLabel(c.format, c.teamMode)}</dd>
            <dt>Entries</dt>
            <dd>
              {registered} of {c.capacity}
              {waitlist ? ` · ${waitlist} waiting` : ''}
            </dd>
            {c.startsAt && (
              <>
                <dt>Starts</dt>
                <dd>{fmtDayTime(c.startsAt)}</dd>
              </>
            )}
            {(c.status === 'draft' || c.status === 'published') && (
              <>
                <dt>Registration</dt>
                <dd>{window_(c.regOpensAt, c.regClosesAt)}</dd>
              </>
            )}
            {s.checkIn && (
              <>
                <dt>Check-in</dt>
                <dd>{c.checkinOpensAt ? `Opens ${fmtDayTime(c.checkinOpensAt)}` : 'Open now, until qualifications start'}</dd>
              </>
            )}
            <dt>Qualifications</dt>
            <dd>
              {QUAL_LABEL[s.quals.kind]}
              {s.quals.kind === 'balanced' && ` · ${s.quals.matchesPerEntry} matches each`}
              {s.quals.kind === 'swiss' && ` · ${s.quals.matchesPerEntry} rounds`}
              {s.quals.kind === 'roundRobin' && s.quals.matchesPerEntry > 1 && ` · ${s.quals.matchesPerEntry} cycles`}
            </dd>
            {s.quals.kind !== 'none' && (
              <>
                <dt>Ranking points</dt>
                <dd>
                  Win {s.points.win} · tie {s.points.tie} · loss {s.points.loss}
                </dd>
                <dt>Tiebreakers</dt>
                <dd>{s.tiebreakers.length ? s.tiebreakers.map((t, i) => (i ? TIEBREAK_LABEL[t].toLowerCase() : TIEBREAK_LABEL[t])).join(', then ') : 'A coin toss'}</dd>
              </>
            )}
            <dt>Playoffs</dt>
            <dd>
              {s.playoffs.enabled
                ? `${s.playoffs.alliances} ${entriesPerAlliance(c.format, c.teamMode) === 2 ? 'alliances' : 'entries'} · ${BRACKET_LABEL[s.playoffs.format]} · ${bestOfLabel(s.playoffs.bestOf)}, final ${bestOfLabel(s.playoffs.finalsBestOf).toLowerCase()}`
                : 'None: the rankings decide it'}
            </dd>
            {s.playoffs.enabled && entriesPerAlliance(c.format, c.teamMode) === 2 && (
              <>
                <dt>Alliances</dt>
                <dd>{SELECTION_LABEL[s.playoffs.selection]}</dd>
              </>
            )}
            <dt>No-shows</dt>
            <dd>
              {minutesLabel(s.run.joinGraceSec)} to join a called match;{' '}
              {s.run.noShow === 'forfeit' ? 'missing it forfeits.' : 'the referee decides.'}
            </dd>
            {data.staff.length > 0 && (
              <>
                <dt>Staff</dt>
                <dd className="ds-comp-side">
                  {data.staff.map((p, i) => (
                    <span key={p.userId ?? i}>
                      <PlayerName p={p} onProfile={onProfile} /> <span className="ds-muted">({p.role2})</span>
                    </span>
                  ))}
                </dd>
              </>
            )}
          </dl>
        </div>
      </div>
      {c.rules && (
        <div className="ds-panel">
          <div className="ds-panel-h">
            <h2 className="ds-panel-title">Rules</h2>
          </div>
          <div className="ds-panel-body">
            <Markdown text={c.rules} />
          </div>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ entrants

function Entrants({
  data,
  run,
  busy,
  slug,
  onProfile,
}: {
  data: CompetitionDetail;
  run: Run;
  busy: boolean;
  slug: string;
  onProfile: (u: string) => void;
}) {
  const v = data.viewer;
  const manager = v.role === 'admin' || v.role === 'organizer';
  const referee = v.role !== null;
  const c = data.competition;
  const before = c.status === 'draft' || c.status === 'published';
  const order: Record<string, number> = { registered: 0, pending: 1, waitlist: 2, disqualified: 3, withdrawn: 4 };
  const rows = [...data.entries].sort((a, b) => order[a.status] - order[b.status] || a.registeredAt - b.registeredAt);
  const act = (entry: number, action: string, extra: Record<string, unknown> = {}) =>
    void run(() => compAction(slug, 'entries', { action, entry, ...extra }));
  const [tag, setTag] = useState('');
  const [partner, setPartner] = useState('');
  return (
    <>
      {manager && before && (
        <div className="ds-panel">
          <div className="ds-panel-h">
            <h2 className="ds-panel-title">Add an entry</h2>
          </div>
          <form
            className="ds-panel-body ds-field-row"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => compAction(slug, 'entries', { action: 'add', tag: tag.trim(), partner: partner.trim() || undefined })).then((ok) => {
                if (ok) {
                  setTag('');
                  setPartner('');
                }
              });
            }}
          >
            <input className="ds-input grow" placeholder="@username" aria-label="Player" value={tag} onChange={(e) => setTag(e.target.value)} />
            {c.teamMode === 'duo' && (
              <input className="ds-input grow" placeholder="Partner’s @username" aria-label="Partner" value={partner} onChange={(e) => setPartner(e.target.value)} />
            )}
            <button className="ds-btn" type="submit" disabled={busy || !tag.trim()}>
              Add
            </button>
          </form>
        </div>
      )}
      <div className="ds-panel">
        {rows.length === 0 ? (
          <div className="ds-empty">
            <div className="big">Nobody has entered yet</div>
            {c.status === 'published' ? 'Registration is open.' : 'Entries open once the competition is published.'}
          </div>
        ) : (
          <div className="ds-table-scroll">
            <table className="ds-table ds-comp-table">
              <thead>
                <tr>
                  <th>Entry</th>
                  <th>Status</th>
                  {c.settings.checkIn && <th>Checked in</th>}
                  {manager && <th className="r">Seed</th>}
                  <th>Entered</th>
                  {(manager || referee) && <th />}
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id} className={e.id === v.entryId ? 'mine' : undefined}>
                    <td>
                      <EntryLine e={e} onProfile={onProfile} />
                      {e.invited && (
                        <span className="ds-muted">
                          {' '}
                          · invited <PlayerName p={e.invited} onProfile={onProfile} />
                        </span>
                      )}
                      {e.note && <div className="ds-hint">{e.note}</div>}
                    </td>
                    <td>
                      <span className={`ds-badge${e.status === 'registered' ? ' ok' : e.status === 'disqualified' ? ' danger' : ''}`}>{ENTRY_LABEL[e.status]}</span>
                      {e.placement ? <span className="ds-muted"> · {ordinalPlace(e.placement)}</span> : null}
                    </td>
                    {c.settings.checkIn && <td>{e.checkedIn ? 'Yes' : <span className="ds-muted">No</span>}</td>}
                    {manager && <td className="r num">{e.seed ?? <span className="ds-muted">—</span>}</td>}
                    <td className="ds-muted">{fmtDay(e.registeredAt)}</td>
                    {(manager || referee) && (
                      <td>
                        <span className="ds-comp-rowacts">
                          {c.settings.checkIn && before && e.status === 'registered' && (
                            <button className="ds-btn ghost small" disabled={busy} onClick={() => act(e.id, e.checkedIn ? 'uncheckin' : 'checkin')}>
                              {e.checkedIn ? 'Undo check-in' : 'Check in'}
                            </button>
                          )}
                          {manager && e.status === 'waitlist' && (
                            <button className="ds-btn ghost small" disabled={busy} onClick={() => act(e.id, 'promote')}>
                              Let in
                            </button>
                          )}
                          {manager && before && (
                            <button
                              className="ds-btn ghost small"
                              disabled={busy}
                              onClick={() => {
                                const s = window.prompt(`Seed for ${e.name} (blank clears it)`, e.seed ? String(e.seed) : '');
                                if (s !== null) act(e.id, 'seed', { seed: s.trim() === '' ? null : Number(s) });
                              }}
                            >
                              Seed
                            </button>
                          )}
                          {manager && (
                            <button
                              className="ds-btn ghost small"
                              disabled={busy}
                              onClick={() => {
                                const n = window.prompt('Name on the schedule', e.name);
                                if (n && n.trim()) act(e.id, 'rename', { name: n.trim() });
                              }}
                            >
                              Rename
                            </button>
                          )}
                          {manager && e.status === 'disqualified' && (
                            <button className="ds-btn ghost small" disabled={busy} onClick={() => act(e.id, 'reinstate')}>
                              Reinstate
                            </button>
                          )}
                          {manager && !before && e.status === 'registered' && (
                            <button
                              className="ds-btn ghost small danger"
                              disabled={busy}
                              onClick={() => {
                                const why = window.prompt(`Disqualify ${e.name}? Their remaining matches go to their opponents. Reason (shown to them):`, '');
                                if (why !== null) act(e.id, 'disqualify', { note: why });
                              }}
                            >
                              Disqualify
                            </button>
                          )}
                          {manager && e.status !== 'withdrawn' && (
                            <button
                              className="ds-btn ghost small danger"
                              disabled={busy}
                              onClick={() => {
                                if (window.confirm(`Remove ${e.name}?\n\n${before ? 'Their place goes to the waitlist.' : 'They are withdrawn; matches they played stay.'}`)) act(e.id, 'remove');
                              }}
                            >
                              Remove
                            </button>
                          )}
                        </span>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

const ordinalPlace = (n: number): string => {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
};

// ------------------------------------------------------------------ matches

function Matches({
  data,
  entries,
  run,
  busy,
  slug,
  onWatch,
  onWatchReplay,
}: {
  data: CompetitionDetail;
  entries: Map<number, CompEntryView>;
  run: Run;
  busy: boolean;
  slug: string;
  onWatch: (room: string, region?: string) => void;
  onWatchReplay: (replayId: string) => void;
}) {
  const v = data.viewer;
  const referee = v.role !== null;
  const quals = data.matches.filter((m) => m.stage === 'qual');
  const playoffs = data.matches.filter((m) => m.stage === 'playoff');
  const [stage, setStage] = useState<'qual' | 'playoff'>(playoffs.length && data.competition.status !== 'qualification' ? 'playoff' : 'qual');
  const [onlyMine, setOnlyMine] = useState(false);
  const [desk, setDesk] = useState<number | null>(null);
  const list = (stage === 'qual' ? quals : playoffs).filter((m) => !onlyMine || inMatch(m, v.entryId));
  const done = (stage === 'qual' ? quals : playoffs).filter((m) => m.status === 'done' || m.status === 'void').length;
  const total = (stage === 'qual' ? quals : playoffs).length;
  const exportCsv = (): void => {
    const name = (s: { entry: number }[]) => s.map((x) => entries.get(x.entry)?.name ?? `#${x.entry}`).join(' + ');
    saveCsv(
      `${slug}-${stage === 'qual' ? 'qualifications' : 'playoffs'}.csv`,
      ['match', 'red', 'blue', 'red score', 'blue score', 'winner', 'how'],
      list.map((m) => [m.label, name(m.red), name(m.blue), m.result?.red ?? '', m.result?.blue ?? '', m.result?.winner ?? '', m.result?.source ?? m.status]),
    );
  };
  return (
    <div className="ds-panel">
      <div className="ds-panel-h">
        <div className="ds-segs" role="group" aria-label="Stage">
          <button className={`ds-seg${stage === 'qual' ? ' on' : ''}`} aria-pressed={stage === 'qual'} onClick={() => setStage('qual')} disabled={!quals.length}>
            Qualifications
          </button>
          <button className={`ds-seg${stage === 'playoff' ? ' on' : ''}`} aria-pressed={stage === 'playoff'} onClick={() => setStage('playoff')} disabled={!playoffs.length}>
            Playoffs
          </button>
        </div>
        <span className="ds-comp-acts">
          <span className="ds-muted">
            {done} of {total} decided
          </span>
          {v.entryId !== null && (
            <label className="ds-checkline">
              <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />
              Mine only
            </label>
          )}
          <button className="ds-btn ghost small" onClick={exportCsv} disabled={!list.length}>
            CSV
          </button>
        </span>
      </div>
      {list.length === 0 ? (
        <div className="ds-empty">
          <div className="big">No matches here</div>
          {onlyMine ? 'None of them are yours.' : 'They appear once they are drawn.'}
        </div>
      ) : (
        <div className="ds-table-scroll tall">
          <table className="ds-table ds-comp-table">
            <thead>
              <tr>
                <th>Match</th>
                <th>Red</th>
                <th>Blue</th>
                <th>Score</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((m) => (
                <MatchRow
                  key={m.id}
                  m={m}
                  entries={entries}
                  mine={v.entryId}
                  referee={referee}
                  open={desk === m.id}
                  onDesk={() => setDesk(desk === m.id ? null : m.id)}
                  onWatch={onWatch}
                  onWatchReplay={onWatchReplay}
                  desk={
                    referee && desk === m.id ? (
                      <MatchDesk m={m} data={data} run={run} busy={busy} slug={slug} onClose={() => setDesk(null)} />
                    ) : null
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function MatchRow({
  m,
  entries,
  mine,
  referee,
  open,
  onDesk,
  onWatch,
  onWatchReplay,
  desk,
}: {
  m: CompMatchView;
  entries: Map<number, CompEntryView>;
  mine: number | null;
  referee: boolean;
  open: boolean;
  onDesk: () => void;
  onWatch: (room: string, region?: string) => void;
  onWatchReplay: (replayId: string) => void;
  desk: React.ReactNode;
}) {
  const yours = mine !== null && inMatch(m, mine);
  const side = yours && mine !== null ? allianceOf(m, mine) : null;
  return (
    <>
      <tr className={yours ? 'mine' : undefined}>
        <td>
          <b>{m.label}</b>
          {side && <span className="ds-muted"> · you’re {side}</span>}
          {m.note && <div className="ds-hint">{m.note}</div>}
          {referee && m.callNote && <div className="ds-hint warn">{m.callNote}</div>}
        </td>
        <td>
          <Side slots={m.red} alliance="red" entries={entries} dq={m.dq} mine={mine} />
        </td>
        <td>
          <Side slots={m.blue} alliance="blue" entries={entries} dq={m.dq} mine={mine} />
        </td>
        <td>
          {m.live ? (
            <span className="ds-comp-score">
              <span className="red">{m.live.score.red}</span>
              <span className="ds-muted"> – </span>
              <span className="blue">{m.live.score.blue}</span>
            </span>
          ) : (
            <ScoreCell r={m.result} />
          )}
        </td>
        <td>
          <span className="ds-comp-rowacts">
            <MatchState m={m} />
            {m.live && m.roomCode && (
              <button className="ds-btn ghost small" onClick={() => onWatch(m.roomCode as string, m.live?.region)}>
                Watch
              </button>
            )}
            {m.replayId && (
              <button className="ds-btn ghost small" onClick={() => onWatchReplay(m.replayId as string)}>
                Replay
              </button>
            )}
            {referee && (
              <button className={`ds-btn small${open ? '' : ' ghost'}`} aria-expanded={open} onClick={onDesk}>
                Referee
              </button>
            )}
          </span>
        </td>
      </tr>
      {desk && (
        <tr>
          <td colSpan={5}>{desk}</td>
        </tr>
      )}
    </>
  );
}

// ------------------------------------------------------------------ rankings

function Rankings({ data, entries }: { data: CompetitionDetail; entries: Map<number, CompEntryView> }) {
  const rows = data.rankings ?? [];
  const mine = data.viewer.entryId;
  const cutoff = data.competition.settings.playoffs.enabled
    ? data.competition.settings.playoffs.alliances * entriesPerAlliance(data.competition.format, data.competition.teamMode)
    : 0;
  const exportCsv = (): void =>
    saveCsv(
      `${data.competition.slug}-rankings.csv`,
      ['rank', 'entry', 'ranking score', 'wins', 'losses', 'ties', 'played', 'avg score', 'avg without fouls', 'high score'],
      rows.map((r) => [r.rank, entries.get(r.entry)?.name ?? r.entry, r.rs.toFixed(2), r.wins, r.losses, r.ties, r.played, r.avgScore.toFixed(1), r.avgNoFoul.toFixed(1), r.highScore]),
    );
  return (
    <div className="ds-panel">
      <div className="ds-panel-h">
        <h2 className="ds-panel-title">Qualification rankings</h2>
        <button className="ds-btn ghost small" onClick={exportCsv} disabled={!rows.length}>
          CSV
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="ds-empty">
          <div className="big">No rankings yet</div>
          They appear once a qualification match is decided.
        </div>
      ) : (
        <div className="ds-table-scroll tall">
          <table className="ds-table ds-comp-table">
            <thead>
              <tr>
                <th className="r">#</th>
                <th>Entry</th>
                <th className="r" title="Ranking points per match played">Score</th>
                <th className="r">W–L–T</th>
                <th className="r">Played</th>
                <th className="r">Avg</th>
                <th className="r" title="Average score minus the foul points the alliance was given">Avg no fouls</th>
                <th className="r">High</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const e = entries.get(r.entry);
                return (
                  <tr key={r.entry} className={r.entry === mine ? 'mine' : undefined}>
                    <td className="r rk">
                      {r.rank}
                      {cutoff > 0 && r.rank === cutoff && <span className="ds-sr"> (last playoff place)</span>}
                    </td>
                    <td>
                      {e ? e.name : `#${r.entry}`}
                      {r.disqualified && <span className="ds-badge danger"> Disqualified</span>}
                      {cutoff > 0 && r.rank <= cutoff && !r.disqualified && data.competition.status === 'qualification' && (
                        <span className="ds-muted"> · in playoff range</span>
                      )}
                    </td>
                    <td className="r num">{r.rs.toFixed(2)}</td>
                    <td className="r num">
                      {r.wins}–{r.losses}–{r.ties}
                    </td>
                    <td className="r num">{r.played}</td>
                    <td className="r num">{r.scored ? r.avgScore.toFixed(1) : '—'}</td>
                    <td className="r num">{r.scored ? r.avgNoFoul.toFixed(1) : '—'}</td>
                    <td className="r num">{r.scored ? r.highScore : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ log

function Log({ data }: { data: CompetitionDetail }) {
  const lines = data.log.map((l) => ({ ...l, text: logLine(l.kind, l.data) })).filter((l) => l.text);
  return (
    <div className="ds-panel">
      <div className="ds-panel-h">
        <h2 className="ds-panel-title">What happened</h2>
      </div>
      {lines.length === 0 ? (
        <div className="ds-empty">
          <div className="big">Nothing yet</div>
          Results, calls and changes are listed here as they happen.
        </div>
      ) : (
        <div className="ds-table-scroll tall">
          <table className="ds-table">
            <tbody>
              {lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    <Ago at={l.at} />
                  </td>
                  <td>
                    {l.text}
                    {!l.public && <span className="ds-badge"> Staff only</span>}
                  </td>
                  <td className="ds-muted">{l.actor}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
