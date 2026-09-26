import { useEffect, useState } from 'react';
import { fetchRewards } from '../net/api';

/**
 * WHAT HAPPENED WHEN YOU CONNECTED GITHUB — shown once, on the bounce back from the link.
 *
 * ⚠️ **THE REWARD ITSELF IS NOT SHOWN HERE ANY MORE.** Since 0048 every reward arrives as a
 * PENDING grant that the claim dialog (`RewardDialog`) presents — what it is, why, Claim,
 * Equip now — and the link route sweeps immediately, so a starred repo means that dialog is
 * already waiting when the browser lands back here. A second "Reward unlocked" card under it
 * would be the same news twice, and one of the two would be announcing a reward that is not
 * yet the player's.
 *
 * WHAT IS LEFT is the case the dialog cannot cover: linked, but the repo is NOT starred, which
 * used to end in silence and read as a broken link. So this looks the account up — never the
 * `?link=ok` in the address bar, which says the LINK worked and nothing about the star — and
 * says what to do only when there is neither a claimed stargazer badge nor a pending reward.
 */
export function StarReward() {
  const [notStarred, setNotStarred] = useState(false);

  useEffect(() => {
    // only on the bounce back from a completed link. `LinkedAccounts` strips the parameter
    // after reading it, so this has to look BEFORE that happens — hence one effect, on mount,
    // in a component mounted above it in the same tree.
    if (new URLSearchParams(window.location.search).get('link') !== 'ok') return;
    let live = true;
    fetchRewards()
      .then((s) => {
        if (!live) return;
        // the badge and the decal move as a unit (`STARGAZER_ITEMS`, server/db/repo.ts), so
        // the badge's count is the witness for both
        const has = (s.badges?.stargazer ?? 0) > 0 || s.pending.some((p) => p.source === 'stargazer');
        setNotStarred(!has);
      })
      // a failed lookup shows NOTHING rather than a guess: telling somebody who just earned the
      // reward that they did not is worse than staying quiet
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  if (!notStarred) return null;
  return (
    <div className="ds-panel star-reward">
      <div className="ds-panel-body stack start">
        <p className="ds-hint">GitHub connected. Star the repo to earn the Stargazer badge and the star decal.</p>
      </div>
    </div>
  );
}
