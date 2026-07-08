import type { UserStats } from '../net/api';

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
}: {
  stats: UserStats | null;
  status: 'loading' | 'ok' | 'error';
  error?: string;
  name: string;
}) {
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
        <span className="ds-panel-title">Season {stats?.season ?? '—'} · Overall</span>
        <span className="ds-chip">
          <b>{name}</b>
        </span>
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

          {stats.recent.length > 0 && (
            <div>
              <span className="ds-panel-title" style={{ display: 'block', marginBottom: 8 }}>
                Recent matches
              </span>
              <table className="ds-table">
                <thead>
                  <tr>
                    <th>Mode</th>
                    <th>Alliance</th>
                    <th>Result</th>
                    <th style={{ textAlign: 'right' }}>Score</th>
                    <th style={{ textAlign: 'right' }}>ELO Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.recent.map((m) => {
                    const delta = m.ratingAfter - m.ratingBefore;
                    return (
                      <tr key={m.matchId}>
                        <td>{m.mode}</td>
                        <td>
                          <span className="ds-dt">{m.alliance.toUpperCase()}</span>
                        </td>
                        <td style={{ color: m.won ? 'var(--ds-ok)' : 'var(--ds-mut)' }}>
                          {m.won ? 'WIN' : 'LOSS'}
                        </td>
                        <td className="sc" style={{ color: 'var(--ds-ink)' }}>
                          {m.score}
                        </td>
                        <td
                          className="sc"
                          style={{ color: delta >= 0 ? 'var(--ds-ok)' : 'var(--ds-danger)' }}
                        >
                          {delta >= 0 ? `+${delta}` : delta}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {stats.match.played === 0 && solo?.best == null && duo?.best == null && (
            <p className="ds-hint">No games played yet this season.</p>
          )}
        </div>
      )}
    </div>
  );
}
