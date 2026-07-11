import { useCallback } from 'react';
import {
  fetchUserStatsByUsername,
  fetchUserMatchesByUsername,
  type MatchHistoryOpts,
  type UserStats,
} from '../net/api';
import { gameServerConfigured } from '../net/env';
import { APP_NAME } from '../seasons';
import { CareerView } from './CareerView';
import { ShareButton } from './ShareButton';
import type { CareerNav } from './Stats';

/**
 * Public player profile at `/profile/<username>` — anyone can view any player's
 * competitive stats by their unique username (no sign-in needed). Reuses the
 * shared `CareerView`, so it gets the same Act/Season period picker (a past
 * season shows that player's final standings + matches). A 404 (unknown username)
 * renders a first-class "player not found" state.
 */
export function Profile({ username, nav = {} }: { username: string; nav?: CareerNav }) {
  const configured = gameServerConfigured();
  const loadStats = useCallback(
    (season?: number) => fetchUserStatsByUsername(username, season),
    [username],
  );
  const fetchPage = useCallback(
    (opts: MatchHistoryOpts) => fetchUserMatchesByUsername(username, opts),
    [username],
  );

  const head = (stats: UserStats | null) => (
    <>
      <p className="ds-eyebrow">{APP_NAME} · Player</p>
      <h1 className="ds-h1">{stats?.handle ?? `@${username}`}</h1>
      <p className="ds-sub">
        {stats?.username ? `@${stats.username} · ` : ''}
        Public profile — ranked ELO, personal bests, and match history.
      </p>
    </>
  );

  if (!configured) {
    return (
      <>
        {head(null)}
        <div className="ds-panel">
          <div className="ds-empty">
            <div className="big">Profiles need the game server</div>
            Set <code>VITE_GAME_SERVER_URL</code>.
          </div>
        </div>
      </>
    );
  }

  const notFound = (
    <div className="ds-panel">
      <div className="ds-empty">
        <div className="big">No such player</div>
        No account with the username <code>@{username}</code>.
      </div>
    </div>
  );

  return (
    <CareerView
      loadStats={loadStats}
      fetchPage={fetchPage}
      nameFallback={`@${username}`}
      head={head}
      headerAction={(stats) => <ShareButton username={stats?.username ?? username} />}
      nav={nav}
      notFound={notFound}
    />
  );
}
