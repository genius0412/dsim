import { useEffect, useState } from 'react';
import { gameServerHttpUrl } from '../net/env';
import { getAuthToken } from '../lib/authClient';
import type { CompetitionSummary, CompStatus } from '../competition/types';
import { SEASONS } from '../seasons';
import { ListState, When } from './adminBits';

/** the console's own words for a status; the pages' (`competition/copy.ts`) live in their chunk */
const STATUS: Record<CompStatus, string> = {
  draft: 'Draft',
  published: 'Registration',
  qualification: 'Qualifications',
  selection: 'Selection',
  playoffs: 'Playoffs',
  completed: 'Finished',
  cancelled: 'Cancelled',
};

/**
 * THE COMPETITIONS TAB — every competition, drafts and unlisted ones included, for the staff who
 * run them. Running one happens on its own page (its Manage tab), which is where an organizer who
 * is not site staff will run theirs once creation opens up; this tab is the site-wide view and
 * the way in.
 *
 * Its own fetch rather than `src/net/competitions.ts`: that module is in the competitions chunk,
 * and importing it from this one would split it into a third chunk shared by the two.
 */
export function AdminCompetitions({ onOpen }: { onOpen: (sub: string | null) => void }) {
  const [rows, setRows] = useState<CompetitionSummary[] | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const base = gameServerHttpUrl();
        const token = await getAuthToken();
        if (!base || !token) throw new Error('no server or token');
        const res = await fetch(`${base}/api/competitions?scope=all`, { headers: { authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { competitions: CompetitionSummary[] };
        if (alive) setRows(body.competitions);
      } catch (e) {
        console.warn('[admin] competitions failed', e);
        if (alive) setErr(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  const game = (g: string) => SEASONS.find((s) => s.key === g)?.name ?? g;
  return (
    <>
      <div className="admin-buttons">
        <button className="ds-btn primary" onClick={() => onOpen('new')}>
          New competition
        </button>
        <button className="ds-btn ghost" onClick={() => onOpen(null)}>
          Open the public list
        </button>
      </div>
      {!rows || rows.length === 0 ? (
        <ListState loading={!rows && !err ? 'Loading competitions…' : undefined} error={err ? 'load the competitions' : undefined} empty="No competitions yet">
          Create one above. It starts as a draft only staff can see.
        </ListState>
      ) : (
        <div className="ds-table-scroll">
          <table className="ds-table adm-table">
            <thead>
              <tr>
                <th>Competition</th>
                <th>Status</th>
                <th>Game</th>
                <th className="r">Entries</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td>
                    {c.name}
                    {c.visibility === 'unlisted' && <span className="ds-muted"> · unlisted</span>}
                    {!c.official && <span className="ds-muted"> · community</span>}
                  </td>
                  <td>
                    <span className="ds-badge">{STATUS[c.status]}</span>
                  </td>
                  <td className="ds-muted">
                    {game(c.game)} · {c.format}
                  </td>
                  <td className="r num">
                    {c.entrants}/{c.capacity}
                    {c.waitlist ? ` +${c.waitlist}` : ''}
                  </td>
                  <td>
                    <When at={c.completedAt ?? c.createdAt} />
                  </td>
                  <td>
                    <span className="adm-rowacts">
                      <button className="ds-btn ghost small" onClick={() => onOpen(c.slug)}>
                        Open
                      </button>
                      <button className="ds-btn ghost small" onClick={() => onOpen(`${c.slug}/manage`)}>
                        Manage
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
