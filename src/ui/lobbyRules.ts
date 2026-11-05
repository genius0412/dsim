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

// ---- the one-screen room (docs/rooms-redesign.md) -----------------------------------------------

/** where a seat move is going: a side, or the watchers */
export type SeatTo = Alliance | 'watch';

/** a move this screen asked for and the room has not answered yet (drawn as if it had) */
export interface PendingSeat {
  id: string;
  to: SeatTo;
}

/** one place on a side: a member, or an open seat (`p: null`) */
export interface Seat {
  a: Alliance;
  p: LobbyPlayer | null;
}

/**
 * THE SEAT MAP: each side's members in roster order, then its open seats, so a side always draws
 * as many cards as it has seats and a join or a leave moves nothing around it. A move this screen
 * has asked for is drawn as done (`pending`); the next roster says whether it was. A side holding
 * more members than seats (a host shrank it under an older server) shows them all. A legacy room
 * has a total and no sides, so each side shows one open seat while any is left.
 */
export function seatMap(
  players: readonly LobbyPlayer[],
  set: RoomSettings | undefined,
  capacity: number,
  pending: PendingSeat | null,
): { red: Seat[]; blue: Seat[] } {
  const shown = players
    .filter((p) => !(pending?.to === 'watch' && p.clientId === pending.id))
    .map((p) => (pending && pending.to !== 'watch' && p.clientId === pending.id ? { ...p, alliance: pending.to } : p));
  const side = (a: Alliance): Seat[] => shown.filter((p) => p.alliance === a).map((p) => ({ a, p }));
  const red = side('red');
  const blue = side('blue');
  if (set) {
    while (red.length < set.perAlliance.red) red.push({ a: 'red', p: null });
    while (blue.length < set.perAlliance.blue) blue.push({ a: 'blue', p: null });
  } else if (shown.length < capacity) {
    red.push({ a: 'red', p: null });
    blue.push({ a: 'blue', p: null });
  }
  return { red, blue };
}

/**
 * MAY THIS VIEWER TAKE AN OPEN SEAT ON `a`? A watcher may take any (the room checks the side), a
 * driver may change side only where drivers pick their own (`teamSwitch`), and a record run's seats
 * are fixed.
 */
export function canTakeSeat(
  a: Alliance,
  v: { spectating: boolean; me: Pick<LobbyPlayer, 'alliance'> | null; set: RoomSettings | undefined; record: boolean },
): boolean {
  if (v.record) return false;
  if (v.spectating) return true;
  if (!v.me || v.me.alliance === a) return false;
  return !v.set || v.set.teamSwitch;
}

/**
 * MAY THIS PLAYER WATCH INSTEAD OF DRIVE? Not the host (the room would be left with nobody to start
 * it), not a record run (its seats are the point), not a LAN room (a tab-hosted room has no watcher
 * socket) and not inside a Discord activity, whose room is everybody's one lobby.
 */
export function canWatch(v: { isHost: boolean; record: boolean; lan: boolean; activity: boolean }): boolean {
  return !v.isHost && !v.record && !v.lan && !v.activity;
}

/** the room's title: which kind of room this is. It follows the host's Private/Public switch. */
export function roomTitle(record: boolean, listed: boolean): string {
  return record ? 'Duo record' : listed ? 'Public room' : 'Private room';
}

/**
 * THE ACTION BAR'S ONE LINE: what this player is waiting for, or what they can do next. It sits
 * beside READY and START, so it never restates them.
 */
export function barStatus(v: {
  spectating: boolean;
  anyOpen: boolean;
  isHost: boolean;
  record: boolean;
  players: readonly Pick<LobbyPlayer, 'ready'>[];
  capacity: number;
  meReady: boolean;
}): string {
  if (v.spectating) return v.anyOpen ? 'You are watching. Take an open seat to play.' : 'You are watching. Every seat is taken.';
  if (v.record && v.players.length < v.capacity) return 'Waiting for your partner to join with the code';
  const ready = v.players.filter((p) => p.ready).length;
  if (v.isHost) return ready === v.players.length ? 'Everyone is ready' : `${ready} of ${v.players.length} ready`;
  return v.meReady ? 'Waiting for the host to start' : `${ready} of ${v.players.length} ready`;
}

/** the room's shape in one line, for everyone but the host (who has the controls instead) */
export function settingsLine(set: RoomSettings): string {
  return [
    `${set.perAlliance.red} red · ${set.perAlliance.blue} blue`,
    set.teamSwitch ? 'drivers pick a side' : 'the host places drivers',
    set.runLength === 'auto' ? 'auto only' : 'full match',
  ].join(' · ');
}
