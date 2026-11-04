import { useState, type ComponentType } from 'react';
import type { GameId } from '../types';
import type { Replay } from '../sim/replay';
import { AchievementsPage } from './AchievementsPage';
import { Leaderboard } from './Leaderboard';
import { MyRecords } from './MyRecords';
import { UserSearchBar } from './UserSearchBar';
import { RECORDS_PAGES, type RecordsPageKey } from './recordsPages';
import type { BoardKey, BoardQuery } from './recordsQuery';

/** what every tab is handed; a tab takes the few it needs */
interface PageProps {
  myUserId: string | null;
  game: GameId;
  board: BoardQuery;
  onBoard: (q: BoardQuery) => void;
  /** a board opened from elsewhere (My records' tiles): Leaderboards, that board, at your row */
  onOpenBoard: (board: BoardKey) => void;
  onGame: (g: GameId) => void;
  onWatch: (replayId: string) => void;
  onWatchLocal?: (replay: Replay) => void;
  onOpenProfile: (username: string) => void;
  onStanding: () => void;
}

function LeaderboardTab({ myUserId, game, board, onBoard, onGame, onWatch, onOpenProfile }: PageProps) {
  return <Leaderboard myUserId={myUserId} game={game} query={board} onQuery={onBoard} onGame={onGame} onWatch={onWatch} onOpenProfile={onOpenProfile} />;
}

function MyRecordsTab({ game, onOpenBoard, onWatch, onWatchLocal, onOpenProfile, onStanding }: PageProps) {
  return <MyRecords game={game} onBoard={onOpenBoard} onWatch={onWatch} onWatchLocal={onWatchLocal} onOpenProfile={onOpenProfile} onStanding={onStanding} />;
}

function AchievementsTab({ myUserId, game }: PageProps) {
  return <AchievementsPage myUserId={myUserId} game={game} />;
}

/**
 * ONE COMPONENT PER KEY of `RECORDS_PAGES`, typed so that a page added to the registry with no
 * component here fails the typecheck. (`recordsPages.ts` is DOM-free so the router and `npm test`
 * can read the keys; this is the half that needs React.)
 */
const PAGES: Record<RecordsPageKey, ComponentType<PageProps>> = {
  leaderboard: LeaderboardTab,
  career: MyRecordsTab,
  achievements: AchievementsTab,
};

/**
 * RECORDS (`docs/records-redesign.md`, built 2026-11-04): three tabs and the player search on one
 * line, then the tab. HEIGHT is what binds on this screen, not width, so nothing else sits above the
 * content: no page title on screen (the bar's trail names the tab, and an `h1` is kept for a screen
 * reader), no hub of link cards, no period heading.
 *
 * The tabs are NAVIGATION, not an ARIA tablist, for the reason `ProfileTabs` gives: each one changes
 * the URL. A phone keeps the search behind its button, so the strip stays one line.
 */
export function Records({
  view,
  onView,
  ...props
}: PageProps & {
  view: RecordsPageKey;
  onView: (v: RecordsPageKey) => void;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const Page = PAGES[view];
  const label = RECORDS_PAGES.find((p) => p.key === view)?.label ?? 'Records';
  return (
    <div className="rb-records">
      <h1 className="ds-sr">{label}</h1>
      <div className={`rb-top${searchOpen ? ' searching' : ''}`}>
        <nav className="ds-tabs rb-tabs" aria-label="Records">
          {RECORDS_PAGES.map((p) => (
            <button
              key={p.key}
              className={`ds-tab${view === p.key ? ' on' : ''}`}
              aria-current={view === p.key ? 'page' : undefined}
              aria-label={p.label}
              onClick={() => onView(p.key)}
            >
              <span className="rb-tab-full">{p.label}</span>
              <span className="rb-tab-short" aria-hidden="true">
                {p.short}
              </span>
            </button>
          ))}
        </nav>
        <button
          className="ds-btn small ghost rb-search-toggle"
          aria-expanded={searchOpen}
          aria-controls="rb-search"
          aria-label="Find a player"
          onClick={() => setSearchOpen((o) => !o)}
        >
          <svg className="rb-search-icon" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5 14 14" />
          </svg>
        </button>
        <div id="rb-search" className="rb-search">
          <UserSearchBar onOpenProfile={props.onOpenProfile} />
        </div>
      </div>
      <Page {...props} />
    </div>
  );
}
