import { useEffect, useState } from 'react';
import { fetchUserStatsByUsername, type UserStats } from '../net/api';
import { gameServerConfigured } from '../net/env';
import { APP_NAME } from '../seasons';
import { CareerPanel } from './CareerPanel';
import { ShareButton } from './ShareButton';

/**
 * Public player profile at `/profile/<username>` — anyone can view any player's
 * competitive stats by their unique username (no sign-in needed). Reuses the
 * shared `CareerPanel`; the data is the SAME `UserStats` shape as "My Stats" but
 * resolved server-side from the username. A 404 (unknown username) is a
 * first-class "player not found" state.
 */
export function Profile({ username }: { username: string }) {
  const configured = gameServerConfigured();
  const [stats, setStats] = useState<UserStats | null>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'error' | 'notfound'>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!configured) {
      setStatus('error');
      setError('Profiles need the game server (set VITE_GAME_SERVER_URL).');
      return;
    }
    let alive = true;
    setStatus('loading');
    fetchUserStatsByUsername(username)
      .then((s) => {
        if (!alive) return;
        setStats(s);
        setStatus('ok');
      })
      .catch((e: unknown) => {
        if (!alive) return;
        const msg = e instanceof Error ? e.message : String(e);
        // the server answers 404 for an unknown username → a clean "not found"
        if (/404/.test(msg)) {
          setStatus('notfound');
        } else {
          setError(msg);
          setStatus('error');
        }
      });
    return () => {
      alive = false;
    };
  }, [username, configured]);

  const name = stats?.handle ?? `@${username}`;

  return (
    <>
      <p className="ds-eyebrow">{APP_NAME} · Player</p>
      <h1 className="ds-h1">{stats?.handle ?? `@${username}`}</h1>
      <p className="ds-sub">
        {stats?.username ? `@${stats.username} · ` : ''}
        Public profile — ranked ELO, personal bests, and recent matches this season.
      </p>

      {status === 'notfound' ? (
        <div className="ds-panel">
          <div className="ds-empty">
            <div className="big">No such player</div>
            No account with the username <code>@{username}</code>.
          </div>
        </div>
      ) : (
        <CareerPanel
          stats={stats}
          status={status}
          error={error}
          name={name}
          headerAction={<ShareButton username={stats?.username ?? username} />}
        />
      )}
    </>
  );
}
