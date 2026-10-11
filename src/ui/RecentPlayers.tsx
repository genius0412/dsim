import { useEffect, useState } from 'react';
import type { PublicProfile } from '../net/api';
import { fetchUserMatches } from '../net/api';
import { PersonRow, recentPeople } from './FriendsPanel';

/**
 * "Recently played" on the Players page: the opponents and teammates from your last matches, one
 * click from their profile. The same derivation the friends panel uses (`recentPeople`: freshest
 * first, no username means nobody to open, you are never in your own list), without the friend
 * request buttons, because this page is for finding people to LOOK at.
 *
 * Renders nothing until there is somebody to show: a new or signed-out player sees no empty section,
 * and a failed read is silent for the same reason (the search box above still works).
 */
export function RecentPlayers({
  myUserId,
  onOpenProfile,
}: {
  myUserId: string | null;
  onOpenProfile: (username: string) => void;
}) {
  const [people, setPeople] = useState<PublicProfile[]>([]);

  useEffect(() => {
    if (!myUserId) {
      setPeople([]);
      return;
    }
    let alive = true;
    void fetchUserMatches(myUserId, { limit: 25 })
      .then((page) => alive && setPeople(recentPeople(page.rows, myUserId).slice(0, 12)))
      .catch(() => alive && setPeople([]));
    return () => {
      alive = false;
    };
  }, [myUserId]);

  if (people.length === 0) return null;
  return (
    <div className="ds-panel">
      <div className="ds-panel-h">
        <h2 className="ds-panel-title">Recently played</h2>
      </div>
      <div className="ds-panel-body">
        {people.map((p) => (
          <PersonRow key={p.userId} p={p} onOpenProfile={onOpenProfile} />
        ))}
      </div>
    </div>
  );
}
