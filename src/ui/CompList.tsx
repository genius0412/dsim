import { useEffect, useState } from 'react';
import { fetchCompetitionCaps, fetchCompetitions, type ListScope } from '../net/competitions';
import type { CompetitionSummary } from '../competition/types';
import { formatLabel, phaseLine } from '../competition/copy';
import { seasonFor } from '../seasons';
import { fmtDay } from './fmtDate';
import { StatusBadge } from './CompParts';

const SCOPES: { id: ListScope; label: string }[] = [
  { id: 'live', label: 'Live' },
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'past', label: 'Past' },
  { id: 'mine', label: 'Mine' },
];
const STAFF_SCOPES: { id: ListScope; label: string }[] = [{ id: 'drafts', label: 'Drafts' }];

const EMPTY: Record<ListScope, [string, string]> = {
  live: ['Nothing running right now', 'Competitions show up here while their matches are being played.'],
  upcoming: ['No competitions coming up', 'New ones are announced here when registration opens.'],
  past: ['No finished competitions yet', 'Results stay here once a competition ends.'],
  mine: ['You haven’t entered any', 'Register for an upcoming competition and it shows up here.'],
  drafts: ['No drafts', 'A new competition starts as a draft only staff can see.'],
  all: ['No competitions', 'Create one to get started.'],
};

/**
 * THE COMPETITIONS LIST — every season's, filtered by when rather than by game: a competition
 * names its own game on its card, and somebody looking for an event to enter does not first go
 * and switch season to find out whether one exists.
 */
export function CompList({
  signedIn,
  onOpen,
  onCreate,
}: {
  signedIn: boolean;
  onOpen: (slug: string) => void;
  onCreate: () => void;
}) {
  const [scope, setScope] = useState<ListScope>('upcoming');
  const [rows, setRows] = useState<CompetitionSummary[] | null>(null);
  const [more, setMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [caps, setCaps] = useState<{ canCreate: boolean; admin: boolean } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    if (!signedIn) {
      setCaps(null);
      return;
    }
    let alive = true;
    fetchCompetitionCaps()
      .then((c) => alive && setCaps(c))
      .catch(() => alive && setCaps(null));
    return () => {
      alive = false;
    };
  }, [signedIn]);

  // open on whatever is happening: live first if anything is live
  const [picked, setPicked] = useState(false);
  useEffect(() => {
    let alive = true;
    setRows(null);
    setErr(null);
    fetchCompetitions(scope)
      .then((r) => {
        if (!alive) return;
        if (!picked && scope === 'upcoming' && r.competitions.length === 0) {
          // nothing upcoming: show what is live instead, once, rather than an empty first page
          setPicked(true);
          setScope('live');
          return;
        }
        setPicked(true);
        setRows(r.competitions);
        setMore(r.more);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        console.warn('[competitions] list failed', e);
        setErr('Couldn’t load competitions. Check your connection and try again.');
      });
    return () => {
      alive = false;
    };
    // `picked` only steers the first answer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  const loadMore = (): void => {
    if (!rows) return;
    setLoadingMore(true);
    fetchCompetitions(scope, null, rows.length)
      .then((r) => {
        setRows([...rows, ...r.competitions]);
        setMore(r.more);
      })
      .catch(() => setErr('Couldn’t load more. Try again.'))
      .finally(() => setLoadingMore(false));
  };

  const scopes = [...SCOPES.filter((s) => s.id !== 'mine' || signedIn), ...(caps?.admin ? STAFF_SCOPES : [])];
  const now = Date.now();

  return (
    <div className="ds-comp">
      <div className="ds-comp-head">
        <div className="ds-comp-title">
          <h1 className="ds-h1">Competitions</h1>
        </div>
        {caps?.canCreate && (
          <div className="ds-comp-acts">
            <button className="ds-btn primary" onClick={onCreate}>
              New competition
            </button>
          </div>
        )}
      </div>

      <nav className="ds-tabs" aria-label="Which competitions">
        {scopes.map((s) => (
          <button key={s.id} className={`ds-tab${scope === s.id ? ' on' : ''}`} aria-current={scope === s.id ? 'page' : undefined} onClick={() => setScope(s.id)}>
            {s.label}
          </button>
        ))}
      </nav>

      <div className="ds-panel">
        {err ? (
          <div className="ds-empty">
            <div className="big">Couldn’t load competitions</div>
            {err}
          </div>
        ) : rows === null ? (
          <div className="ds-loading">Loading competitions…</div>
        ) : rows.length === 0 ? (
          <div className="ds-empty">
            <div className="big">{EMPTY[scope][0]}</div>
            {EMPTY[scope][1]}
          </div>
        ) : (
          <>
            <div className="ds-panel-body ds-opts ds-comp-list">
              {rows.map((c) => (
                <button key={c.id} className="ds-opt" onClick={() => onOpen(c.slug)}>
                  <span className="ot">{c.name}</span>
                  <span className="ds-comp-tags">
                    <StatusBadge status={c.status} />
                    {c.official && <span className="ds-badge staff">Official</span>}
                    {c.visibility === 'unlisted' && <span className="ds-badge">Unlisted</span>}
                  </span>
                  <span className="od">
                    {[
                      seasonFor(c.game).name,
                      formatLabel(c.format, c.teamMode),
                      c.startsAt ? fmtDay(c.startsAt) : null,
                      `${c.entrants}/${c.capacity} entered`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  <span className="od">
                    {c.status === 'completed' && c.champions.length
                      ? `Won by ${c.champions.join(' and ')}`
                      : c.summary || phaseLine({ ...c, now })}
                  </span>
                </button>
              ))}
            </div>
            {more && (
              <div className="ds-comp-more">
                <button className="ds-btn ghost" disabled={loadingMore} aria-busy={loadingMore} onClick={loadMore}>
                  Show more
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
