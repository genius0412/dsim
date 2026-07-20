import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameId } from '../types';
import {
  acceptFriendRequest,
  blockUser,
  cancelFriendRequest,
  declineFriendRequest,
  dismissRoomInvite,
  fetchFriends,
  FriendsUnavailableError,
  inviteToRoom,
  removeFriend,
  sendFriendRequest,
  setPresenceStatus,
  unblockUser,
  type FriendsPayload,
  type PresenceStatus,
} from '../net/api';
import { gameServerConfigured } from '../net/env';

/** how often to re-poll while the panel is open vs. collapsed. A collapsed panel
 * only needs its request-count badge to be roughly current, so it backs right off. */
const POLL_OPEN_MS = 30_000;
const POLL_COLLAPSED_MS = 120_000;

const EMPTY: FriendsPayload = {
  friends: [],
  incoming: [],
  outgoing: [],
  blocked: [],
  invites: [],
  status: null,
};

export interface FriendsApi {
  data: FriendsPayload;
  loading: boolean;
  /** the server has no friends API (older deploy than this client) — render the
   * unavailable state, never an error */
  unavailable: boolean;
  /** last mutation error, for inline display; cleared on the next attempt */
  error: string | null;
  refresh: () => void;
  add: (username: string) => Promise<'sent' | 'accepted'>;
  accept: (username: string) => Promise<void>;
  decline: (username: string) => Promise<void>;
  cancel: (username: string) => Promise<void>;
  unfriend: (username: string) => Promise<void>;
  block: (username: string) => Promise<void>;
  unblock: (username: string) => Promise<void>;
  setStatus: (status: PresenceStatus | null) => Promise<void>;
  /** invite a friend to a room by code (server checks the friendship) */
  inviteToRoom: (
    username: string,
    room: string,
    game: GameId,
    kind: 'versus' | 'record',
    record?: 'solo' | 'duo' | null,
  ) => Promise<void>;
  /** dismiss (or consume, on join) an invite addressed to me */
  dismissInvite: (id: string) => Promise<void>;
}

/**
 * The one owner of friends state: the poll timer, the cached payload, and every
 * mutation. Mounted once (in `AppShell`, beside the panel), so the expanded
 * list, the collapsed rail's badge, and anything added later all read one cache
 * instead of each starting a timer.
 *
 * Two things keep this cheap against a scale-to-zero Fly machine:
 *
 *  - **It only polls while the document is VISIBLE.** Otherwise every background
 *    tab someone leaves open would ping the server ~2,900 times a day and keep
 *    them eternally "online" while they're asleep — a cost problem and a wrong
 *    answer. An abandoned tab simply falls out of the freshness window and reads
 *    as offline, which is the truth.
 *  - **The read IS the heartbeat.** `GET /api/friends` records the caller's own
 *    presence server-side, so there's no second ping request.
 */
export function useFriends({
  signedIn,
  collapsed,
}: {
  signedIn: boolean;
  collapsed: boolean;
}): FriendsApi {
  const [data, setData] = useState<FriendsPayload>(EMPTY);
  // mirrors `data` so an async mutation can read the pre-patch value for rollback
  // without re-creating its callback on every poll
  const dataRef = useRef<FriendsPayload>(EMPTY);
  dataRef.current = data;
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // `refresh()` is called from mutation handlers; a counter avoids threading the
  // fetch function through the effect's deps and re-arming the timer each render
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const active = signedIn && gameServerConfigured();

  useEffect(() => {
    if (!active) {
      setData(EMPTY);
      setUnavailable(false);
      return;
    }
    let alive = true;
    const load = (): void => {
      if (document.visibilityState !== 'visible') return;
      setLoading(true);
      fetchFriends()
        .then((d) => {
          if (!alive) return;
          setData(d);
          setUnavailable(false);
        })
        .catch((e: unknown) => {
          if (!alive) return;
          // an old server (no friends API) is a permanent state → show the
          // unavailable panel. Anything else is transient: keep the last good
          // data and let the next tick retry.
          if (e instanceof FriendsUnavailableError) setUnavailable(true);
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
    };

    load();
    const iv = window.setInterval(load, collapsed ? POLL_COLLAPSED_MS : POLL_OPEN_MS);
    // catch up immediately when a backgrounded tab comes forward, rather than
    // showing stale presence until the next interval
    const onVis = (): void => {
      if (document.visibilityState === 'visible') load();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive = false;
      window.clearInterval(iv);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [active, collapsed, nonce]);

  /**
   * Apply `patch` to the local cache immediately, then run `call`. A 30s poll is
   * far too long to wait for a row to disappear after clicking Accept, so the UI
   * moves first; on failure the previous state is restored and the message
   * surfaced, and either way the next poll reconciles against the server.
   */
  const mutate = useCallback(
    async (patch: (d: FriendsPayload) => FriendsPayload, call: () => Promise<unknown>) => {
      setError(null);
      // rollback state comes from the ref, NOT from smuggling it out of the
      // setData updater — an updater must be a pure function of its input, and
      // React may invoke it more than once per commit (it does in StrictMode).
      const previous = dataRef.current;
      setData(patch);
      try {
        await call();
      } catch (e) {
        setData(previous);
        setError(e instanceof Error ? e.message : 'Something went wrong.');
        throw e;
      } finally {
        refresh();
      }
    },
    [refresh],
  );

  /** drop one person from a list by username, PRESERVING the element type — a
   * non-generic version widens `friends` to the shared `{username}` shape and
   * loses the presence fields */
  const byName = <T extends { username: string | null }>(list: T[], username: string): T[] =>
    list.filter((p) => p.username !== username);

  const accept = useCallback(
    (username: string) =>
      mutate((d) => {
        const from = d.incoming.find((p) => p.username === username);
        return {
          ...d,
          incoming: byName(d.incoming, username),
          // show them immediately as an offline friend; the next poll fills in
          // their real presence
          friends: from
            ? [
                ...d.friends,
                {
                  userId: from.userId,
                  handle: from.handle ?? '',
                  username: from.username,
                  online: false,
                  status: null,
                  offlineSeconds: null,
                },
              ]
            : d.friends,
        };
      }, () => acceptFriendRequest(username)).then(() => undefined),
    [mutate],
  );

  const decline = useCallback(
    (username: string) =>
      mutate((d) => ({ ...d, incoming: byName(d.incoming, username) }), () =>
        declineFriendRequest(username),
      ).then(() => undefined),
    [mutate],
  );

  const cancel = useCallback(
    (username: string) =>
      mutate((d) => ({ ...d, outgoing: byName(d.outgoing, username) }), () =>
        cancelFriendRequest(username),
      ).then(() => undefined),
    [mutate],
  );

  const unfriend = useCallback(
    (username: string) =>
      mutate((d) => ({ ...d, friends: byName(d.friends, username) }), () =>
        removeFriend(username),
      ).then(() => undefined),
    [mutate],
  );

  const block = useCallback(
    (username: string) =>
      mutate(
        (d) => ({
          ...d,
          // blocking tears down the friendship and both pending requests
          // server-side, so mirror all three locally
          friends: byName(d.friends, username),
          incoming: byName(d.incoming, username),
          outgoing: byName(d.outgoing, username),
        }),
        () => blockUser(username),
      ).then(() => undefined),
    [mutate],
  );

  const unblock = useCallback(
    (username: string) =>
      mutate((d) => ({ ...d, blocked: byName(d.blocked, username) }), () =>
        unblockUser(username),
      ).then(() => undefined),
    [mutate],
  );

  const setStatus = useCallback(
    (status: PresenceStatus | null) =>
      mutate((d) => ({ ...d, status }), () => setPresenceStatus(status)).then(() => undefined),
    [mutate],
  );

  const add = useCallback(
    async (username: string): Promise<'sent' | 'accepted'> => {
      setError(null);
      try {
        const outcome = await sendFriendRequest(username);
        return outcome;
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Something went wrong.');
        throw e;
      } finally {
        refresh();
      }
    },
    [refresh],
  );

  // no local mutation to apply — nothing in MY OWN data changes by inviting
  // someone else — but it still surfaces errors + reconciles on the next poll,
  // same as `add`.
  const inviteRoom = useCallback(
    async (
      username: string,
      room: string,
      game: GameId,
      kind: 'versus' | 'record',
      record?: 'solo' | 'duo' | null,
    ): Promise<void> => {
      setError(null);
      try {
        await inviteToRoom(username, room, game, kind, record);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Something went wrong.');
        throw e;
      } finally {
        refresh();
      }
    },
    [refresh],
  );

  const dismissInvite = useCallback(
    (id: string) =>
      mutate((d) => ({ ...d, invites: d.invites.filter((i) => i.id !== id) }), () =>
        dismissRoomInvite(id),
      ).then(() => undefined),
    [mutate],
  );

  return {
    data,
    loading,
    unavailable,
    error,
    refresh,
    add,
    accept,
    decline,
    cancel,
    unfriend,
    block,
    unblock,
    setStatus,
    inviteToRoom: inviteRoom,
    dismissInvite,
  };
}
