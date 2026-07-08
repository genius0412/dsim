import { useEffect, useState } from 'react';
import { fetchUserStats, type UserStats } from '../net/api';
import { gameServerConfigured } from '../net/env';
import { authEnabled, authClient } from '../lib/authClient';
import { APP_NAME } from '../seasons';
import { CareerPanel } from './CareerPanel';
import { ShareButton } from './ShareButton';

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
        <p className="ds-eyebrow">{APP_NAME}</p>
        <h1 className="ds-h1">Career</h1>
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
      <p className="ds-eyebrow">{APP_NAME}</p>
      <h1 className="ds-h1">Career</h1>
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

  const name = stats?.handle ?? user.name ?? user.email ?? 'Player';
  return (
    <>
      {head}
      <CareerPanel
        stats={stats}
        status={status === 'idle' ? 'loading' : status}
        error={error}
        name={name}
        headerAction={stats?.username ? <ShareButton username={stats.username} label="Share my profile" /> : undefined}
      />
    </>
  );
}
