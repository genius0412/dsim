import { useCallback, useState } from 'react';
import type { GameId } from '../types';
import type { Replay } from '../sim/replay';
import { fetchUserStats, fetchUserMatches, type MatchHistoryOpts } from '../net/api';
import { gameServerConfigured } from '../net/env';
import { authEnabled, authClient } from '../lib/authClient';
import { CareerView } from './CareerView';
import { ShareButton } from './ShareButton';
import { StandingCard } from './StandingCard';
import { NoticeInbox } from './NoticeInbox';
import { AuthPanel } from './AuthPanel';
import { PracticeReplays } from './PracticeReplays';
import { LanReplays } from './LanReplays';

export interface CareerNav {
  onWatch?: (replayId: string) => void;
  /** watch a replay this DEVICE holds (a local practice run) — handed over as the log itself,
   *  since there is no server id to fetch it by */
  onWatchLocal?: (replay: Replay) => void;
  onOpenProfile?: (username: string) => void;
  /** open a competition's page (the profile's placements list) */
  onOpenCompetition?: (slug: string) => void;
  /** which game's boards to show (DECODE default) — its own periods/records */
  game?: GameId;
}

/**
 * My Stats — a signed-in player's competitive profile. A single Act/Season period
 * picker (in `CareerView`) drives both the stats panel and the match history, so a
 * player can review a PAST season's final standings and matches. Ranks are computed
 * server-side, so the client never pulls a full leaderboard. Auth is a stable
 * module constant, so the early return before hooks is safe.
 */
export function Stats(nav: CareerNav = {}) {
  if (!authEnabled) {
    return (
      <>
        <div className="ds-panel">
          <div className="ds-empty">
            <div className="big">Accounts are off in this build</div>
            This build has no sign-in, so your rating, records and match history aren’t saved. Solo practice and free drive still work.
          </div>
        </div>
        <PracticeReplays signedIn={false} game={nav.game} onWatchLocal={nav.onWatchLocal} />
        <LanReplays signedIn={false} game={nav.game} onWatchLocal={nav.onWatchLocal} />
      </>
    );
  }
  return <StatsSignedIn nav={nav} />;
}

function StatsSignedIn({ nav }: { nav: CareerNav }) {
  const session = authClient!.useSession();
  const user = session.data?.user;
  const userId = user?.id;
  const configured = gameServerConfigured();
  const [authOpen, setAuthOpen] = useState(false);

  const game = nav.game;
  const loadStats = useCallback(
    (season?: number) => fetchUserStats(userId!, season, game),
    [userId, game],
  );
  const fetchPage = useCallback(
    (opts: MatchHistoryOpts) => fetchUserMatches(userId!, { ...opts, game }),
    [userId, game],
  );

  if (session.isPending) {
    return (
      <div className="ds-panel">
        <div className="ds-loading">Loading…</div>
      </div>
    );
  }

  /**
   * SIGNED OUT STILL HAS PRACTICE REPLAYS, and they have to be reachable.
   *
   * Solo practice is the primary OFFLINE mode and keeps its runs on the device whether or not
   * anyone is signed in — so a Career page that showed nothing but a sign-in prompt would be
   * holding runs the player has no way to open. Rating and records genuinely need an account;
   * these do not.
   */
  if (!user) {
    return (
      <>
        <div className="ds-panel">
          <div className="ds-empty">
            <div className="big">Sign in to see your career</div>
            Track your rating, records and match history.
          </div>
          {/* the action ON the empty state (design review 19-13): "from the top bar" pointed at
              an unlabelled avatar. Same anatomy as Appearance's signed-out panel. */}
          <div className="ds-panel-body row">
            <span className="ds-head-spacer" />
            <button className="ds-btn primary" onClick={() => setAuthOpen(true)}>
              Sign in
            </button>
          </div>
          {authOpen && <AuthPanel onClose={() => setAuthOpen(false)} />}
        </div>
        <PracticeReplays signedIn={false} game={nav.game} onWatchLocal={nav.onWatchLocal} />
        <LanReplays signedIn={false} game={nav.game} onWatchLocal={nav.onWatchLocal} />
      </>
    );
  }

  if (!configured) {
    return (
      <>
        <div className="ds-panel">
          <div className="ds-empty">
            <div className="big">Career is online-only</div>
            This build isn’t connected to a game server. Solo practice and free drive still work.
          </div>
        </div>
        {/* the local half needs no server either */}
        <PracticeReplays signedIn={false} game={nav.game} onWatchLocal={nav.onWatchLocal} />
        <LanReplays signedIn={false} game={nav.game} onWatchLocal={nav.onWatchLocal} />
      </>
    );
  }

  const nameFallback = user.name ?? user.email ?? 'Player';
  return (
    <CareerView
      loadStats={loadStats}
      fetchPage={fetchPage}
      nameFallback={nameFallback}
      // ACCOUNT STANDING is self-only, so it hangs off THIS screen rather than the shared
      // CareerPanel, which also renders public profiles. Someone else's penalties are
      // between them and the moderators.
      head={() => (
        <>
          <StandingCard />
          {/* what moderators told this account, and the reports it filed (0057). Self-only
              like StandingCard, and absent when there is nothing in either list. */}
          <NoticeInbox />
          {/* SELF-ONLY, same reasoning as StandingCard above: practice runs are offline and
              unverified, and on a public profile they would read as competitive history. */}
          <PracticeReplays
            signedIn
            game={nav.game}
            onWatchId={nav.onWatch}
            onWatchLocal={nav.onWatchLocal}
          />
          {/* renders NOTHING unless this account has hosted something — see its header */}
          <LanReplays
            signedIn
            game={nav.game}
            onWatchId={nav.onWatch}
            onWatchLocal={nav.onWatchLocal}
          />
        </>
      )}
      headerAction={(stats) =>
        stats?.username ? <ShareButton username={stats.username} label="Share my profile" /> : undefined
      }
      nav={nav}
    />
  );
}
