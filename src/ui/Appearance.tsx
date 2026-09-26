import { useEffect, useState } from 'react';
import { authClient, authEnabled } from '../lib/authClient';
import { gameServerConfigured } from '../net/env';
import { fetchProfile, type PublicProfile } from '../net/api';
import { BADGE_EARN, BADGE_KEYS, BADGE_LABELS, MAX_EQUIPPED_BADGES, withBadgeEquipped, type BadgeId } from '../badges';
import { rewardEyebrow, rewardHeadline } from '../rewards';
import { useAds } from '../ads/AdsProvider';
import { AuthDisabled } from './AuthDisabled';
import { AuthPanel } from './AuthPanel';
import { inDiscordActivity } from '../net/discordActivity';
import { SITE_HOST } from '../lib/authFlows';
import { BadgeArt, BadgeMarks } from './BadgeMark';
import { DisplayName, Username } from './ProfileName';
import { ProfileTabs, type ProfileTab } from './ProfileTabs';
import { DecalPreview } from './RewardDialog';
import { ensureRewards, equipBadges, reopenRewards, useRewards } from './rewardsStore';
import { SupporterBadge } from './SupporterBadge';

/**
 * APPEARANCE — how you appear to other players (owner, 2026-09-22: the profile's "title and
 * cosmetics settings", separated from the account's settings; titles folded into badges on
 * 2026-09-24).
 *
 * Top to bottom: what a stranger sees beside your name, anything waiting to be claimed, the
 * name itself, the badges, and the robot look your rewards have unlocked. Every piece of
 * reward state comes from ONE store (`rewardsStore`), shared with the claim dialog, so a
 * reward claimed there changes this page without a reload — and the preview at the top is
 * drawn with `BadgeMarks`, the same component every board row uses, so it cannot show you
 * something the boards would not.
 */
export function Appearance({
  onTab,
  onHandleSaved,
  onViewProfile,
  onRobotBuilder,
}: {
  onTab?: (t: ProfileTab) => void;
  /** a saved display name, pushed back up to App so the header updates on save */
  onHandleSaved?: (handle: string) => void;
  /** open your own public profile */
  onViewProfile?: (username: string) => void;
  /** open the robot builder, where a decal or colour is actually picked */
  onRobotBuilder?: () => void;
}) {
  return (
    <>
      <h1 className="ds-h1">Profile</h1>
      <ProfileTabs active="appearance" onPick={onTab} />
      {authEnabled ? (
        <SignedIn onHandleSaved={onHandleSaved} onViewProfile={onViewProfile} onRobotBuilder={onRobotBuilder} />
      ) : (
        <AuthDisabled />
      )}
    </>
  );
}

function SignedIn({
  onHandleSaved,
  onViewProfile,
  onRobotBuilder,
}: {
  onHandleSaved?: (handle: string) => void;
  onViewProfile?: (username: string) => void;
  onRobotBuilder?: () => void;
}) {
  const session = authClient!.useSession();
  const user = session.data?.user ?? null;
  const [authOpen, setAuthOpen] = useState(false);
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [handle, setHandle] = useState<string | null>(null);
  const configured = gameServerConfigured();

  // the reward state this page reads — normally already loaded by the claim dialog
  useEffect(() => ensureRewards(user?.id ?? null), [user?.id]);

  useEffect(() => {
    if (!user || !configured) return;
    let alive = true;
    fetchProfile(user.id)
      .then((p) => alive && setProfile(p))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [user, configured]);

  if (session.isPending) return <p className="ds-loading">Loading…</p>;
  if (!user) {
    /**
     * INSIDE THE ACTIVITY THERE IS NOTHING TO OFFER, so this says so instead of asking.
     *
     * Discord's frame blocks the sign-in service outright, so the button below can only
     * fail — and this page is reachable from the home menu's own keycap, which makes it one
     * of the first things a participant can walk into. Same shape as the Account page's
     * panel: name the limit, name where the account does work, and no live control that
     * cannot succeed. Plain text rather than a link, because navigating the activity frame
     * away from itself has no back button.
     */
    if (inDiscordActivity()) {
      return (
        <div className="ds-panel">
          <div className="ds-empty">
            <div className="big">Titles and badges aren’t available inside Discord</div>
            They belong to an account, and Discord’s activity frame blocks the sign-in
            service. Open {SITE_HOST} in a browser to use yours.
          </div>
        </div>
      );
    }
    return (
      <div className="ds-panel">
        <div className="ds-empty">
          <div className="big">Sign in to earn badges</div>
          Ranked podiums and record boards pay out to accounts when an act or season ends.
        </div>
        <div className="ds-panel-body row">
          <span className="ds-head-spacer" />
          <button className="ds-btn primary" onClick={() => setAuthOpen(true)}>
            Sign in
          </button>
        </div>
        {authOpen && <AuthPanel onClose={() => setAuthOpen(false)} />}
      </div>
    );
  }

  const shownName = handle ?? profile?.handle ?? user.name ?? 'Player';
  return (
    <>
      <Preview
        name={shownName}
        profile={profile}
        onViewProfile={onViewProfile}
      />
      <Unclaimed />
      <div className="ds-panel">
        <div className="ds-panel-h">
          <span className="ds-panel-title">Name</span>
        </div>
        <div className="ds-panel-body stack">
          <DisplayName
            userId={user.id}
            fallback={user.name ?? 'Player'}
            onSaved={(h) => {
              setHandle(h);
              onHandleSaved?.(h);
            }}
          />
          <Username userId={user.id} />
        </div>
      </div>
      <BadgePicker />
      <RobotLook onRobotBuilder={onRobotBuilder} />
    </>
  );
}

/** WHAT A STRANGER SEES beside your name, drawn with the board's own components. */
function Preview({
  name,
  profile,
  onViewProfile,
}: {
  name: string;
  profile: PublicProfile | null;
  onViewProfile?: (username: string) => void;
}) {
  const r = useRewards();
  const username = profile?.username ?? null;
  return (
    <div className="ds-panel">
      <div className="ds-panel-h">
        <span className="ds-panel-title">How others see you</span>
        <span className="ds-head-spacer" />
        {username && onViewProfile && (
          <button className="ds-btn ghost small" onClick={() => onViewProfile(username)}>
            View public profile
          </button>
        )}
      </div>
      <div className="ds-panel-body">
        <div className="appr-preview">
          <span className="appr-name">{name}</span>
          <SupporterBadge supporter={profile?.supporter} role={profile?.role} />
          <BadgeMarks badges={r.state?.equippedBadges} />
          {username && <span className="lb-at">@{username}</span>}
        </div>
      </div>
    </div>
  );
}

/** ANYTHING WAITING TO BE CLAIMED — the way back to a dialog that was put off with Esc. */
function Unclaimed() {
  const r = useRewards();
  const pending = r.state?.pending ?? [];
  if (pending.length === 0) return null;
  return (
    <div className="ds-panel appr-unclaimed">
      <div className="ds-panel-h">
        <span className="ds-panel-title">Waiting to be claimed</span>
        <span className="ds-count">{pending.length}</span>
        <span className="ds-head-spacer" />
        <button className="ds-btn primary small" onClick={reopenRewards}>
          Claim
        </button>
      </div>
      <ul className="appr-pending">
        {pending.map((g) => (
          <li key={g.id}>
            <span className="appr-pending-h">{rewardHeadline(g)}</span>
            <span className="ds-hint">{rewardEyebrow(g)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * THE BADGE PICKER — wear up to `MAX_EQUIPPED_BADGES`, in the order picked.
 *
 * EVERY badge is listed, the ones not yet earned as locked tiles that say how to earn them:
 * the set is five and closed, and a badge you cannot see is not one you can aim at. The same
 * call `CosmeticsRows` makes for locked swatches ("a visible locked option is honest").
 * Picking a fourth when three are worn swaps out the one worn longest (`withBadgeEquipped`).
 */
function BadgePicker() {
  const r = useRewards();
  const [error, setError] = useState(false);
  if (!r.state) return null;
  const counts = r.state.badges;
  const worn = r.state.equippedBadges.map((b) => b.id);

  const toggle = (id: BadgeId): void => {
    const next = worn.includes(id) ? worn.filter((x) => x !== id) : withBadgeEquipped(worn, id);
    setError(false);
    void equipBadges(next).then((ok) => setError(!ok));
  };

  return (
    <div className="ds-panel">
      <div className="ds-panel-h">
        <span className="ds-panel-title">Badges</span>
        <span className="ds-count">
          {worn.length} of {MAX_EQUIPPED_BADGES} worn
        </span>
      </div>
      <div className="ds-panel-body stack start">
        <div className="ds-opts two" role="group" aria-label="Badges">
          {BADGE_KEYS.map((id) => {
            const n = counts[id] ?? 0;
            const on = worn.includes(id);
            return (
              <button
                key={id}
                className={`ds-opt appr-badge${on ? ' on' : ''}`}
                aria-pressed={on}
                disabled={n === 0}
                onClick={() => toggle(id)}
              >
                <span className="appr-badge-art" aria-hidden="true">
                  <BadgeArt id={id} n={Math.max(1, n)} size="lg" />
                </span>
                <span className="ot">{BADGE_LABELS[id]}</span>
                <span className="od">{n > 0 ? (n > 1 ? `Earned ${n} times` : 'Earned once') : BADGE_EARN[id]}</span>
              </button>
            );
          })}
        </div>
        {error && <p className="ds-hint warn">Couldn’t save your badges. Check your connection and try again.</p>}
      </div>
    </div>
  );
}

/** THE ROBOT LOOK your rewards have unlocked. The picking itself happens in the builder. */
function RobotLook({ onRobotBuilder }: { onRobotBuilder?: () => void }) {
  const { earnedCosmetics } = useAds();
  const unlocked = earnedCosmetics.filter((id) => id === 'decal:star');
  return (
    <div className="ds-panel">
      <div className="ds-panel-h">
        <span className="ds-panel-title">Robot look</span>
        <span className="ds-head-spacer" />
        {onRobotBuilder && (
          <button className="ds-btn ghost small" onClick={onRobotBuilder}>
            Open the robot builder
          </button>
        )}
      </div>
      {unlocked.length > 0 ? (
        <ul className="appr-unlocks">
          {unlocked.map((id) => (
            <li key={id}>
              <DecalPreview id={id} />
              <span>Star decal</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="ds-empty">
          <div className="big">No reward decals yet</div>
          Star DSIM on GitHub, then connect it under Account, to unlock the star decal.
        </div>
      )}
    </div>
  );
}
