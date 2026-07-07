import { useEffect, useState } from 'react';
import { fetchUserStats, type UserStats } from '../net/api';
import { gameServerConfigured } from '../net/env';
import { authEnabled, authClient } from '../lib/authClient';
import { APP_NAME } from '../seasons';

/**
 * My Stats — a signed-in player's competitive profile, read in ONE call from the
 * server's per-user endpoint (`/api/user/:id/stats`): overall ELO + rank per
 * mode, record personal-bests + rank, W/L, and recent match history. Ranks are
 * computed server-side, so the client never pulls a full leaderboard. Auth is a
 * stable module constant, so the early return before hooks is safe.
 */
export function Stats() {
  if (!authEnabled) {
    return (
      <>
        <p className="ds-eyebrow">{APP_NAME} · Career</p>
        <h1 className="ds-h1">My Stats</h1>
        <div className="ds-panel">
          <div className="ds-empty">
            <div className="big">Accounts are off in this build</div>
            Set <code>VITE_NEON_AUTH_URL</code> to sign in and track ELO, records, and match history.
          </div>
        </div>
      </>
    );
  }
  return <StatsSignedIn />;
}

function StatsSignedIn() {
  const session = authClient!.useSession();
  const user = session.data?.user;
  const configured = gameServerConfigured();

  const [stats, setStats] = useState<UserStats | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user || !configured) return;
    let alive = true;
    setStatus('loading');
    fetchUserStats(user.id)
      .then((s) => {
        if (!alive) return;
        setStats(s);
        setStatus('ok');
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
      });
    return () => {
      alive = false;
    };
  }, [user, configured]);

  const head = (
    <>
      <p className="ds-eyebrow">{APP_NAME} · Career</p>
      <h1 className="ds-h1">My Stats</h1>
      <p className="ds-sub">Your ranked ELO, personal bests, and recent matches this season.</p>
    </>
  );

  if (session.isPending) {
    return (
      <>
        {head}
        <div className="ds-panel">
          <div className="ds-loading">Loading…</div>
        </div>
      </>
    );
  }

  if (!user) {
    return (
      <>
        {head}
        <div className="ds-panel">
          <div className="ds-empty">
            <div className="big">Sign in to see your stats</div>
            Sign in from the top bar to track your ELO and records.
          </div>
        </div>
      </>
    );
  }

  if (!configured) {
    return (
      <>
        {head}
        <div className="ds-panel">
          <div className="ds-empty">
            <div className="big">Stats need the game server</div>
            Set <code>VITE_GAME_SERVER_URL</code> — ELO and records live on the match server.
          </div>
        </div>
      </>
    );
  }

  const elo1 = stats?.elo.find((e) => e.mode === '1v1');
  const elo2 = stats?.elo.find((e) => e.mode === '2v2');
  const solo = stats?.records.find((r) => r.mode === 'solo');
  const duo = stats?.records.find((r) => r.mode === 'duo');
  const rankTag = (rank: number | null): string => (rank ? `Rank #${rank}` : 'Unranked');
  const winPct =
    stats && stats.match.played > 0 ? Math.round((stats.match.wins / stats.match.played) * 100) : null;

  return (
    <>
      {head}
      <div className="ds-panel">
        <div className="ds-panel-h">
          <span className="ds-panel-title">Season {stats?.season ?? '—'} · Overall</span>
          <span className="ds-chip">
            <b>{stats?.handle ?? user.name ?? user.email ?? 'Player'}</b>
          </span>
        </div>

        {status === 'loading' && <div className="ds-loading">Loading…</div>}
        {status === 'error' && (
          <div className="ds-empty">
            <div className="big">Couldn’t load your stats</div>
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
              <p className="ds-hint">No games yet — play Ranked or a Record Run to get started.</p>
            )}
          </div>
        )}
      </div>
    </>
  );
}
