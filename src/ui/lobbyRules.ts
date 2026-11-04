import type { Alliance } from '../types';
import type { ErrorCode, LobbyPlayer, RoomSettings } from '../net/protocol';

/**
 * THE ROOM LOBBY'S DECISIONS, pulled out of `Lobby.tsx` so `npm test` can drive them.
 *
 * DOM-free and clock-free. Each of these used to be an inline expression in a 1,900-line component,
 * where the only way to pin it was to grep the source for its text.
 */

/** the seats a side holds right now, bots included: the server counts them the same way (`sideCount`) */
export const seated = (players: readonly Pick<LobbyPlayer, 'alliance'>[], a: Alliance): number =>
  players.filter((p) => p.alliance === a).length;

/**
 * IS THERE A FREE SEAT ON `a`, for a spectator to take? A legacy room (no `settings`) has no
 * per-side count, only a total, so the answer there is the total.
 */
export function seatFree(
  players: readonly Pick<LobbyPlayer, 'alliance'>[],
  set: RoomSettings | undefined,
  capacity: number,
  a: Alliance,
): boolean {
  return set ? seated(players, a) < set.perAlliance[a] : players.length < capacity;
}

/**
 * CAN THE HOST TAKE A SEAT OFF `a`? The server refuses a shrink below who is seated ("Move N
 * players off red first"), and in "Drivers pick a side" the host cannot move a driver to make
 * room, so the button is off whenever the side is full, with the reason on it. Zero seats left is
 * off too, and needs no reason.
 */
export function shrinkState(
  players: readonly Pick<LobbyPlayer, 'alliance'>[],
  set: RoomSettings,
  a: Alliance,
): { disabled: boolean; reason: string | null } {
  if (set.perAlliance[a] <= 0) return { disabled: true, reason: null };
  if (seated(players, a) >= set.perAlliance[a]) return { disabled: true, reason: `Every ${a} seat is taken. Free one first.` };
  return { disabled: false, reason: null };
}

/**
 * DOES THE HOST GET A "Move to …" BUTTON ON THIS ROW? Not in "Drivers pick a side": the drivers
 * place themselves and the server refuses the move (`Room.moveMember`). A bot has no hands to pick
 * with, so the host still places those, and "Host places drivers" keeps every button it had.
 * A record run's seats are fixed.
 */
export function hostMoveOffered(
  member: { bot?: string },
  set: RoomSettings | undefined,
  host: { isHost: boolean; record: boolean },
): boolean {
  return host.isHost && !!set && !host.record && (!!member.bot || !set.teamSwitch);
}

/** where a refusal came from, for `watchesOnRefusal` */
export interface RefusalContext {
  /** the room's own screen is up (a role switch), not a door that has not opened yet */
  inRoom: boolean;
  /** a seat was asked for from the spectator view and nothing has answered yet */
  seatTry: boolean;
  /** this screen is already watching */
  spectating: boolean;
  /** inside a Discord activity, where `in_progress` is a wait with a retry, not a refusal */
  activity: boolean;
  /** a tab-hosted LAN room, which has no spectator socket */
  lan: boolean;
  /** this screen just created the room */
  creating: boolean;
  /** a record run, whose seats are the whole point */
  record: boolean;
}

/**
 * DOES THIS REFUSAL MEAN "WATCH IT INSTEAD"? `room_full` (no free driver seat) and `in_progress`
 * (the match is running) are the two refusals that only say there is no seat for you; the room
 * itself is fine and a spectator may attach. Everything else is an ordinary error.
 */
export function watchesOnRefusal(code: ErrorCode | undefined, c: RefusalContext): boolean {
  return (
    (code === 'room_full' || code === 'in_progress') &&
    (!c.inRoom || c.seatTry) &&
    !c.spectating &&
    !c.activity &&
    !c.lan &&
    !c.creating &&
    !c.record
  );
}

/** the server's sentence for a code that names a room of another KIND ("That code is for a different game mode.") */
const KIND_MISMATCH = /different game mode/i;

/**
 * A CODE TYPED INTO BROWSE ROOMS NAMES NO KIND. It is tried as an ordinary room, and a duo-record
 * room answers "different game mode", so the join goes again as the record room it is. Only a typed
 * code, only from an ordinary room's screen (a record screen that is refused stays refused: no
 * loop), and not in an activity. Matches the sentence, because an older server sends no code.
 */
export function retriesAsRecord(message: string, c: { typed: boolean; record: boolean; activity: boolean }): boolean {
  return c.typed && !c.record && !c.activity && KIND_MISMATCH.test(message);
}

/** the title of the create screen: the visibility was chosen one screen before, and is read back here */
export function entryTitle(record: boolean, listed: boolean, signedIn: boolean): string {
  return record ? 'Duo record' : listed && signedIn ? 'Public room' : 'Private room';
}
