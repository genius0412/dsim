import type { ListedRoom } from '../src/net/protocol';

/** what `Room.listing()` emits onto the presence beat: the public card plus the host's account id,
 *  which is the server's own and never reaches a client */
export type ListingEntry = ListedRoom & { listing: true; hostUserId: string };

/** how many cards one answer carries */
export const BROWSE_MAX = 100;

/**
 * BROWSE ROOMS: the Public rooms out of everything on the heartbeat (live matches and listing
 * cards share one array), one per host account, without the host's id. Joinable rooms first, then
 * the fullest, which are the ones about to start. An entry that is not a listing is ignored, so
 * the live-match half of the array passes through harmlessly.
 *
 * Pure, so `npm test` holds it without a server.
 */
export function browseRooms(all: unknown[]): ListedRoom[] {
  const seenRoom = new Set<string>();
  const seenHost = new Set<string>();
  const out: ListedRoom[] = [];
  for (const r of all) {
    const l = r as Partial<ListingEntry> | null;
    if (!l || l.listing !== true || !l.room || !l.hostUserId) continue;
    // ONE listed room per account: a second is a duplicate of the first, however it got here
    if (seenRoom.has(l.room) || seenHost.has(l.hostUserId)) continue;
    seenRoom.add(l.room);
    seenHost.add(l.hostUserId);
    const { listing: _l, hostUserId: _h, ...card } = l as ListingEntry;
    out.push(card);
  }
  return out
    .sort((a, b) => Number(b.joinable) - Number(a.joinable) || b.seats - a.seats)
    .slice(0, BROWSE_MAX);
}
