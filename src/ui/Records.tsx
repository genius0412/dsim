import { APP_NAME } from '../seasons';
import { Leaderboard } from './Leaderboard';
import { Stats } from './Stats';

export const RECORDS_TABS = ['leaderboard', 'career'] as const;
export type RecordsTab = (typeof RECORDS_TABS)[number];

export function isRecordsTab(s: string | null): s is RecordsTab {
  return s !== null && (RECORDS_TABS as readonly string[]).includes(s);
}

const LABELS: Record<RecordsTab, string> = {
  leaderboard: 'Leaderboard',
  career: 'Career',
};

/**
 * Records — the global leaderboard and your own career, behind one destination.
 * Both panels are the existing components; only the heading and the tab strip
 * are new. `/leaderboard` and `/stats` still resolve here (see App's parsePath)
 * so old links and the replay viewer's "back" keep working.
 */
export function Records({
  tab,
  onTab,
  myUserId,
  onWatch,
  onOpenProfile,
}: {
  tab: RecordsTab;
  onTab: (t: RecordsTab) => void;
  myUserId: string | null;
  onWatch: (replayId: string) => void;
  onOpenProfile: (username: string) => void;
}) {
  return (
    <>
      <p className="ds-eyebrow">{APP_NAME} · Records</p>
      <h1 className="ds-h1">Records</h1>
      <p className="ds-sub">Where you stand, and how you got there.</p>

      <div className="ds-tabs" role="tablist">
        {RECORDS_TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={`ds-tab${tab === t ? ' on' : ''}`}
            onClick={() => onTab(t)}
          >
            {LABELS[t]}
          </button>
        ))}
      </div>

      {tab === 'leaderboard' ? (
        <Leaderboard myUserId={myUserId} onWatch={onWatch} onOpenProfile={onOpenProfile} />
      ) : (
        <Stats onWatch={onWatch} onOpenProfile={onOpenProfile} />
      )}
    </>
  );
}
