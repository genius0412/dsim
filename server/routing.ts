/**
 * WHICH MACHINE a socket belongs on.
 *
 * One Fly app runs in several regions, and every connection arrives at whichever one the
 * Anycast address put it nearest to. This reads the routing HINTS off the query string and
 * answers with the region the connection should be replayed to, or null to keep it here.
 *
 * The subtle one is the last case. A matchmaker-staged room is region-coded (`iad-abc123`)
 * so its code alone says where it lives — but a CUSTOM room code is bare, and there is
 * nothing in `abc123` to route on. That is not a gap to be clever about: it is why a custom
 * room's region has to be carried alongside the code (a friend's invite stamps it, the
 * spectate box looks it up). Without it two players who picked different servers each opened
 * an empty room with the same code on their own machine, saw a lobby of one, and got no
 * error anywhere.
 *
 * Extracted from `index.ts` so the decision can be tested without booting a listener.
 */
/**
 * ⚠️ A REGION REACHES A `fly-replay` HEADER, SO IT IS VALIDATED HERE AND NOWHERE ELSE.
 *
 * Node throws `ERR_INVALID_CHAR` when a CRLF reaches `writeHead`, and that throw happens
 * INSIDE the request handler, where the process-level hook only logs it — the socket is left
 * with no response until it times out, so `?region=%0Ax` in a loop is a free way to pile up
 * hung sockets on the one machine every Discord Activity in the world is pinned to. The
 * WebSocket upgrade path is worse: it does a raw `socket.write` of the header, which bypasses
 * Node's validation entirely and hands attacker-authored bytes to the Fly edge.
 *
 * The guard lives in this function rather than at each call site because there are three of
 * them (`/health`, `/api/lobbies`, the upgrade) and one of them was missed for months.
 * A region is a Fly region code: three lowercase letters, nothing else.
 */
const LEGAL_REGION = /^[a-z]{3}$/;

/** the same test, for the handlers that build their own replay header */
export function legalRegion(r: string): boolean {
  return LEGAL_REGION.test(r);
}

export function routeTarget(url: URL, matchmakerRegion: string): string | null {
  // ranked queueing always meets on the ONE matchmaker, or two halves of a pairing would
  // sit in different pools waiting for each other
  if (url.searchParams.get('mm') === '1') return matchmakerRegion;
  // an explicit pick wins over everything below it: it is the only hint a caller sends when
  // it KNOWS where the room is (an invite's stamped region, a looked-up spectate target)
  const region = url.searchParams.get('region');
  if (region) return LEGAL_REGION.test(region) ? region : null;
  const room = url.searchParams.get('room');
  if (room) {
    const dash = room.indexOf('-');
    if (dash > 0) {
      // the room code is untrusted too, and its prefix lands in the same header
      const prefix = room.slice(0, dash); // region-coded `<region>-<code>`
      return LEGAL_REGION.test(prefix) ? prefix : null;
    }
  }
  return null; // a bare custom code — nothing to route on; stay here
}
