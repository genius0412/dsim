import { useEffect, useState, type ReactNode } from 'react';
import { fetchSeasons, type UserStats } from '../net/api';

/**
 * The competitive-stats panel shared by "My Stats" (own account) and the public
 * `/profile/<username>` page: overall 1v1/2v2 ELO + rank, solo/duo record bests +
 * rank, ranked W–L, and recent match history. Purely presentational — the caller
 * fetches the `UserStats` (by user id for self, by username for a public profile)
 * and owns the surrounding page head. `name` is the chip shown in the panel header.
 */
export function CareerPanel({
  stats,
  status,
  error,
  name,
  headerAction,
}: {
  stats: UserStats | null;
  status: 'loading' | 'ok' | 'error';
  error?: string;
  name: string;
  /** optional control rendered in the panel header (e.g. a Share button) */
  headerAction?: ReactNode;
}) {
  // Resolve the season's DISPLAY NAME (what the Leaderboard shows) for the number
  // in `stats.season`, so Career and the boards label the season identically (a
  // season can be named e.g. "Season 0" while numbered 1). Falls back to the raw
  // number until the lookup lands / if the server is unconfigured.
  const [seasonNames, setSeasonNames] = useState<Record<number, string>>({});
  useEffect(() => {
    let alive = true;
    fetchSeasons()
      .then((r) => {
        if (!alive) return;
        setSeasonNames(Object.fromEntries(r.seasons.map((s) => [s.season, s.name])));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const seasonLabel =
    stats?.season != null ? (seasonNames[stats.season] ?? `Season ${stats.season}`) : '—';

  const elo1 = stats?.elo.find((e) => e.mode === '1v1');
  const elo2 = stats?.elo.find((e) => e.mode === '2v2');
  const solo = stats?.records.find((r) => r.mode === 'solo');
  const duo = stats?.records.find((r) => r.mode === 'duo');
  const rankTag = (rank: number | null): string => (rank ? `Rank #${rank}` : 'Unranked');
  const winPct =
    stats && stats.match.played > 0 ? Math.round((stats.match.wins / stats.match.played) * 100) : null;

  return (
    <div className="ds-panel">
      <div className="ds-panel-h">
        <span className="ds-panel-title">{seasonLabel} · Overall</span>
        <span className="ds-head-spacer" />
        <span className="ds-chip">
          <b>{name}</b>
        </span>
        {headerAction}
      </div>

      {status === 'loading' && <div className="ds-loading">Loading…</div>}
      {status === 'error' && (
        <div className="ds-empty">
          <div className="big">Couldn’t load stats</div>
          {error}
        </div>
      )}

      {status === 'ok' && stats && (
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="ds-stats">
            <div className="ds-stat">
              <span className="sv">{elo1?.rating ?? 1000}</span>
              <span className="sl">1V1 ELO</span>
              <span className="sl">
                {rankTag(elo1?.rank ?? null)} · {elo1?.games ?? 0} games
              </span>
            </div>
            <div className="ds-stat">
              <span className="sv">{elo2?.rating ?? 1000}</span>
              <span className="sl">2V2 ELO</span>
              <span className="sl">
                {rankTag(elo2?.rank ?? null)} · {elo2?.games ?? 0} games
              </span>
            </div>
            <div className="ds-stat">
              <span className="sv">{solo?.best ?? '—'}</span>
              <span className="sl">Solo best</span>
              <span className="sl">{rankTag(solo?.rank ?? null)}</span>
            </div>
            <div className="ds-stat">
              <span className="sv">{duo?.best ?? '—'}</span>
              <span className="sl">Duo best</span>
              <span className="sl">{rankTag(duo?.rank ?? null)}</span>
            </div>
            <div className="ds-stat">
              <span className="sv">
                {stats.match.wins}–{stats.match.losses}
              </span>
              <span className="sl">Ranked W–L</span>
              <span className="sl">{winPct != null ? `${winPct}% win` : 'no matches'}</span>
            </div>
          </div>

          {stats.match.played === 0 && solo?.best == null && duo?.best == null && (
            <p className="ds-hint">No games played yet this season.</p>
          )}
        </div>
      )}
    </div>
  );
}
