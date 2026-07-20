import { useState } from 'react';
import type { FriendsApi } from './useFriends';

/**
 * Friend/block controls for a profile you're viewing (not your own). Rendered
 * next to `ShareButton` in the profile header. Reuses whichever `useFriends()`
 * instance the caller already mounted — no new API surface, just contextual
 * buttons over the existing add/accept/decline/cancel/unfriend/block/unblock
 * mutations, picked by matching this profile's `username` against the
 * caller's friends/incoming/outgoing/blocked lists.
 */
export function ProfileFriendActions({
  username,
  friends,
}: {
  username: string;
  friends: FriendsApi;
}) {
  const [busy, setBusy] = useState(false);
  if (friends.unavailable) return null;

  const { friends: list, incoming, outgoing, blocked } = friends.data;
  const isFriend = list.some((f) => f.username === username);
  const incomingReq = incoming.find((p) => p.username === username);
  const outgoingReq = outgoing.find((p) => p.username === username);
  const isBlocked = blocked.some((p) => p.username === username);

  const run = (fn: () => Promise<unknown>): void => {
    setBusy(true);
    void fn().finally(() => setBusy(false));
  };

  if (isBlocked) {
    return (
      <button
        className="ds-btn ghost"
        disabled={busy}
        onClick={() => run(() => friends.unblock(username))}
      >
        Blocked · Unblock
      </button>
    );
  }

  if (isFriend) {
    return (
      <span className="ds-profile-friend-actions">
        <span className="ds-chip on">✓ Friends</span>
        <button className="ds-btn ghost" disabled={busy} onClick={() => run(() => friends.unfriend(username))}>
          Unfriend
        </button>
        <button className="ds-btn ghost" disabled={busy} onClick={() => run(() => friends.block(username))}>
          Block
        </button>
      </span>
    );
  }

  if (incomingReq) {
    return (
      <span className="ds-profile-friend-actions">
        <button
          className="ds-btn small primary"
          disabled={busy}
          onClick={() => run(() => friends.accept(username))}
        >
          Accept
        </button>
        <button
          className="ds-btn small ghost"
          disabled={busy}
          onClick={() => run(() => friends.decline(username))}
        >
          Decline
        </button>
      </span>
    );
  }

  if (outgoingReq) {
    return (
      <button className="ds-btn ghost" disabled={busy} onClick={() => run(() => friends.cancel(username))}>
        Request sent · Cancel
      </button>
    );
  }

  return (
    <span className="ds-profile-friend-actions">
      <button className="ds-btn" disabled={busy} onClick={() => run(() => friends.add(username))}>
        Add friend
      </button>
      <button className="ds-btn ghost" disabled={busy} onClick={() => run(() => friends.block(username))}>
        Block
      </button>
    </span>
  );
}
