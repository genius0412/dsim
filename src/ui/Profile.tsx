import { useCallback } from 'react';
import {
  fetchUserStatsByUsername,
  fetchUserMatchesByUsername,
  type MatchHistoryOpts,
  type UserStats,
} from '../net/api';
import { gameServerConfigured } from '../net/env';
import { CareerView } from './CareerView';
import { ShareButton } from './ShareButton';
import { SupporterBadge } from './SupporterBadge';
import { BadgeMarks } from './BadgeMark';
import { ProfileFriendActions } from './ProfileFriendActions';
import { useFriendsCtx } from './friendsContext';
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
  // the shared menu-shell friends store (one poll for the whole shell) — Profile
  // is always rendered inside AppShell's FriendsProvider
  const friends = useFriendsCtx();
  const isOwnProfile = signedIn && viewerUsername != null && viewerUsername === username;
  // THE GAME GOES ON BOTH FETCHES, as it does on My Stats: without it the server falls back to
  // DECODE, so a BIOBUZZ profile showed the player's DECODE career
  const game = nav.game;
  const loadStats = useCallback(
    (season?: number) => fetchUserStatsByUsername(username, season, game),
    [username, game],
  );
  const fetchPage = useCallback(
    (opts: MatchHistoryOpts) => fetchUserMatchesByUsername(username, { ...opts, game }),
    [username, game],
  );

  const head = (stats: UserStats | null) => (
    <>
      <h1 className="ds-h1">
        {stats?.handle ?? `@${username}`}
        <SupporterBadge supporter={stats?.supporter} role={stats?.role} size="md" />
        {/* the equipped title, beside the badge and never inside it — the same composition
            the leaderboard uses, so the row that sent you here and the header you land on
            say the same thing about the same person. */}
        <BadgeMarks badges={stats?.badges} />
      </h1>
      {/* the @name only (design review 08-24): the role word repeated the badge in the h1 just
          above, and "Public profile" restated the URL. The route's own name stands in until
          the stats land, so the line never appears late. */}
      <p className="ds-sub">@{stats?.username ?? username}</p>
    </>
  );

  if (!configured) {
    return (
      <>
        {head(null)}
        <div className="ds-panel">
          <div className="ds-empty">
            <div className="big">Profiles aren’t available here</div>
            This build isn’t connected to a game server.
          </div>
        </div>
      </>
    );
  }

  const notFound = (
    <div className="ds-panel">
      <div className="ds-empty">
        <div className="big">No such player</div>
        <code>@{username}</code>
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
