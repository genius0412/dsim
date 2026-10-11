import type { ComponentType } from 'react';
import type { GameId } from '../types';
import type { Replay } from '../sim/replay';
import { AchievementsPage } from './AchievementsPage';
import { Leaderboard } from './Leaderboard';
import { RecentPlayers } from './RecentPlayers';
import { RecordsHub } from './RecordsHub';
import { RECORDS_HUB, type RecordsPageKey, type RecordsView } from './recordsPages';
import { Stats } from './Stats';
import { UserSearchBar } from './UserSearchBar';

/** what every page of Records is handed; a page takes the few it needs */
interface PageProps {
  myUserId: string | null;
  game?: GameId;
  onWatch: (replayId: string) => void;
  onWatchLocal?: (replay: Replay) => void;
  onOpenProfile: (username: string) => void;
}

function LeaderboardPage({ myUserId, game, onWatch, onOpenProfile }: PageProps) {
  return (
    <>
      <h1 className="ds-h1">Leaderboards</h1>
      <Leaderboard myUserId={myUserId} game={game} onWatch={onWatch} onOpenProfile={onOpenProfile} />
    </>
  );
}

function CareerPage({ game, onWatch, onWatchLocal, onOpenProfile }: PageProps) {
  return (
    <>
      <h1 className="ds-h1">My records</h1>
      <Stats game={game} onWatch={onWatch} onWatchLocal={onWatchLocal} onOpenProfile={onOpenProfile} />
    </>
  );
}

function PlayersPage({ myUserId, onOpenProfile }: PageProps) {
  return (
    <>
      <h1 className="ds-h1">Players</h1>
      <p className="ds-sub">Search by display name or @username to open a profile.</p>
      <UserSearchBar onOpenProfile={onOpenProfile} />
      <RecentPlayers myUserId={myUserId} onOpenProfile={onOpenProfile} />
    </>
  );
}

function AchievementsRoute({ myUserId, game }: PageProps) {
  return <AchievementsPage myUserId={myUserId} game={game} />;
}

/**
 * ONE COMPONENT PER KEY of `RECORDS_PAGES`, typed so that a page added to the registry with no
 * component here fails the typecheck. (`recordsPages.ts` is DOM-free so the router and `npm test`
 * can read the keys; this is the half that needs React.)
 */
const PAGES: Record<RecordsPageKey, ComponentType<PageProps>> = {
  leaderboard: LeaderboardPage,
  career: CareerPage,
  players: PlayersPage,
  achievements: AchievementsRoute,
};

/**
 * Records — a hub and the pages behind it. `/records` is the hub (`RecordsHub`: search, the feed,
 * a link to each page); `/records/<key>` is one page. There is no tab strip: the way between pages
 * is the hub, and Back in the app bar returns to it (`App`'s `onBack`). `/leaderboard` and `/stats`
 * still resolve here (App's parsePath) so old links and the replay viewer's "back" keep working.
 */
export function Records({
  view,
  onView,
  myUserId,
  game,
  onWatch,
  onWatchLocal,
  onOpenProfile,
}: PageProps & {
  view: RecordsView;
  onView: (v: RecordsView) => void;
}) {
  if (view === RECORDS_HUB) {
    return <RecordsHub game={game} onPage={onView} onOpenProfile={onOpenProfile} onWatch={onWatch} />;
  }
  const Page = PAGES[view];
  return <Page myUserId={myUserId} game={game} onWatch={onWatch} onWatchLocal={onWatchLocal} onOpenProfile={onOpenProfile} />;
}
