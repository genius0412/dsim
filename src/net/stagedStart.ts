import { RANKED_JOIN_GRACE_MS } from './protocol';

/**
 * HOW LONG A STAGED RANKED ROOM HAS TO ANSWER BEFORE THE CLIENT STOPS WAITING FOR IT.
 *
 * After `matchAssigned` the ranked screen shows "Match found · loading into the match" and waits
 * for `strategyStart`, `matchStart` or `error` from the room. Nothing else moves it, and it has
 * no button, because leaving there costs a dodge. A room that sent none of the three left the
 * player there indefinitely (2026-10-03, "stuck on loading into match"):
 *   - the match was already over (cancelled, or its machine restarted), and an older server
 *     answered the join with an EMPTY custom room under the ranked code (the server half is
 *     `isStagedRoomCode`, server/matchTypes.ts);
 *   - the join threw on the server and nothing was sent back;
 *   - the socket never opened, which the transport retries for minutes.
 *
 * WHY THE NUMBERS ARE SAFE. A staged room answers within `RANKED_JOIN_GRACE_MS` of being staged
 * (`Room.applyPending`): everyone arrives and the prep window opens, or the grace runs out and it
 * cancels with an `error`. It is staged while the first driver's join is handled: after our join
 * went out if we were first, earlier if we were not. So a room that has said nothing for the grace
 * plus the time a join takes to handle (auth, a database read or two) after our join went out is
 * not going to, and giving up then costs nothing the room has not already charged.
 *
 * Before our join goes out the clock is the assignment, with room for a satellite's cold boot
 * (~1-6 s measured) on top.
 */
export const STAGED_ANSWER_MS = RANKED_JOIN_GRACE_MS + 15_000;
export const STAGED_CONNECT_MS = RANKED_JOIN_GRACE_MS + 25_000;

/** shown in place of the screen that was waiting (`Matchmaking.strategyCancelled`) */
export const STAGED_TIMEOUT_MESSAGE = 'Couldn’t load into the match. Find a new one.';

/**
 * Has the room had its chance? `joinSentAt` is when the FIRST join frame went out on an open
 * socket (null until then). A reconnect does not move it: the room's grace did not restart either.
 */
export function stagedStartOverdue(assignedAt: number, joinSentAt: number | null, now: number): boolean {
  return joinSentAt === null ? now - assignedAt > STAGED_CONNECT_MS : now - joinSentAt > STAGED_ANSWER_MS;
}
