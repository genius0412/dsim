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
import { ProfileFriendActions } from './ProfileFriendActions';
import { useFriends } from './useFriends';
import type { CareerNav } from './Stats';

/**
 * Public player profile at `/profile/<username>` — anyone can view any player's
 * competitive stats by their unique username (no sign-in needed). Reuses the
 * shared `CareerView`, so it gets the same Act/Season period picker (a past
 * season shows that player's final standings + matches). A 404 (unknown username)
 * renders a first-class "player not found" state.
 */
export function Profile({
  username,
  signedIn = false,
  viewerUsername = null,
  nav = {},
}: {
  username: string;
  /** is *some* account signed in right now (any account, not necessarily this
   * profile's) — gates whether friend/block actions render at all */
  signedIn?: boolean;
  /** the signed-in account's own username, so viewing your own profile doesn't
   * show "Add friend"/"Block" pointed at yourself */
  viewerUsername?: string | null;
  nav?: CareerNav;
}) {
  const configured = gameServerConfigured();
  // collapsed: true — this is a background poll for one profile visit, not the
  // rail's live badge, so it can back off to the slower interval
  const friends = useFriends({ signedIn, collapsed: true });
  const isOwnProfile = signedIn && viewerUsername != null && viewerUsername === username;
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
      headerAction={(stats) => (
        <>
          <ShareButton username={stats?.username ?? username} />
          {!isOwnProfile && signedIn && <ProfileFriendActions username={username} friends={friends} />}
        </>
      )}
      nav={nav}
      notFound={notFound}
    />
  );
}
