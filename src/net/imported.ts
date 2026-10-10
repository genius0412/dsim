/**
 * IMPORTED ROBOTS ON THE WIRE — the rules for where one may go, in one DOM-free module.
 *
 * An imported robot (`RobotSpec.imported`, `docs/robot-import-plan.md`) plays in solo practice,
 * free drive, custom rooms and LAN rooms. It is refused by the ranked queue, by a staged ranked
 * room and by a record room, enforced SERVER-side (`server/room.ts`, `server/index.ts`); the
 * client's own gating is a courtesy. This file holds what both halves share: the capability, the
 * predicates, the refusal sentences, and the one function that decides whether a seat may enter
 * a room that has (or would gain) an imported robot.
 *
 * It imports nothing at runtime, because `server/room.ts` is bundled for the browser (the LAN
 * host runs a `Room` in a tab) and the replay container reads it too.
 *
 * ⚠️ THE CAPABILITY IS A HARD GATE, LIKE `'bb3d'`, NOT A FEATURE FLAG. A client that predates
 * imports drops `spec.imported` in `coerceSpec`, so in a room that contains one it would predict
 * and draw a standard robot against a server that stepped the imported one: permanent reconcile
 * snaps, a different game from the one being scored. So such a room admits only clients that
 * advertise `ROBOT_IMPORT_CAP`, and an imported robot is never added to a room that holds one
 * that does not.
 */

/**
 * WHERE THE IMPORTER SHIPS, by release channel (owner, 2026-10-10: "We will not deploy the robot
 * importer feature to main until I tell you to, but we will keep it on alpha. Note that things like
 * fixed shooter should stay."). ONE rule for both halves of the gate: the client asks it of its
 * build's channel (`VITE_APP_CHANNEL`, which the alpha site already bakes), the server of its own
 * (`SERVER_CHANNEL`, which `fly.alpha.toml` already sets), so neither deployment needs a setting.
 * An unknown channel is closed, the safe direction, as `seasonVisibleOn` does. It gates the
 * importer only: the editor, the library, imported robots in rooms and the look relay. Mechanisms
 * that landed beside it (the fixed shooter, hand loading) are everyone's. Opening production is
 * adding `'stable'` here, and the rest of the list in `docs/area/robot-import.md` "Where it ships".
 */
export const IMPORTER_CHANNELS: readonly string[] = ['alpha'];

/** is the importer open on a deployment of release channel `channel`? */
export function importerOpenOn(channel: string | undefined): boolean {
  return typeof channel === 'string' && IMPORTER_CHANNELS.includes(channel.trim());
}

/** advertised by clients on `join`/`queue`/`rejoin`/`spectate` (`CLIENT_CAPS`) and by the server on
 *  `/api/presence` (`SERVER_CAPS`). The client offers an imported robot online only when the
 *  server says it. */
export const ROBOT_IMPORT_CAP = 'robotImport';

/**
 * A replay container that holds an imported robot is stamped with this `format` and no other.
 * A build that predates it reads `format > REPLAY_FORMAT` as `'future'` and refuses to play it,
 * which is the point: it would otherwise re-simulate a rectangle robot and show a match that
 * never happened. A container without an import stays format 2, byte for byte.
 */
export const REPLAY_FORMAT_IMPORTED = 3;
/** ...and one whose import carries practice tuning (`ImportedRobot.tune`) with this */
export const REPLAY_FORMAT_TUNED = 4;

/** does this spec (anything shaped like one, typically straight off the wire) carry an import? */
export function isImportedSpec(spec: unknown): boolean {
  if (typeof spec !== 'object' || spec === null) return false;
  const imp = (spec as { imported?: unknown }).imported;
  return typeof imp === 'object' && imp !== null && !Array.isArray(imp);
}

/** `spec` as a standard robot: the same object when it already is one, else a copy without the
 *  import. The parametric fields an import always carries stay, so what is left is a legal
 *  rectangle robot. */
export function stripImported<T extends object>(spec: T): T {
  if (!isImportedSpec(spec)) return spec;
  const out = { ...spec } as T & { imported?: unknown };
  delete out.imported;
  return out;
}

/** `spec` without an import's practice tuning: the same object when it carries none. A ROOM never
 *  plays tuning (`Room.beginMatch`): the room is everyone's, and an older client would predict the
 *  untuned robot. */
export function stripTune<T extends object>(spec: T): T {
  const imp = (spec as { imported?: { tune?: unknown } }).imported;
  if (!imp || typeof imp !== 'object' || imp.tune === undefined) return spec;
  const { tune: _t, ...rest } = imp;
  void _t;
  return { ...spec, imported: rest } as T;
}

/** does any setup in this list carry an import with practice tuning? */
export function setupsHaveTune(setups: readonly { spec?: unknown }[] | null | undefined): boolean {
  return !!setups && setups.some((s) => isImportedSpec(s?.spec) && typeof (s.spec as { imported: { tune?: unknown } }).imported.tune === 'object');
}

/** does any setup in this list carry an import? (a match's `setups`, a replay's `setups`) */
export function setupsHaveImported(setups: readonly { spec?: unknown }[] | null | undefined): boolean {
  return !!setups && setups.some((s) => isImportedSpec(s?.spec));
}

/** does this replay container (raw or sanitised) hold an imported robot? Read off the setups,
 *  and off the stamp, so a container that claims format 3 is treated as one either way. */
export function replayHasImported(replay: unknown): boolean {
  if (typeof replay !== 'object' || replay === null) return false;
  const r = replay as { format?: unknown; setups?: unknown };
  if (typeof r.format === 'number' && r.format >= REPLAY_FORMAT_IMPORTED) return true;
  return Array.isArray(r.setups) && setupsHaveImported(r.setups as { spec?: unknown }[]);
}

/** does a client advertising `caps` understand imported robots? */
export function hasImportCap(caps: readonly string[] | undefined): boolean {
  return !!caps?.includes(ROBOT_IMPORT_CAP);
}

// ---- the sentences ------------------------------------------------------------------
// Plain sentences, sentence case, `Couldn’t …` plus the next step (docs/area/ui.md).

/** the ranked queue, at the door, before a pairing exists */
export const IMPORT_REFUSED_RANKED =
  'Couldn’t start matchmaking with an imported robot. Ranked uses a standard robot, so pick one of your saved robots and try again.';

/** a staged ranked room or a record room: anywhere an imported robot may not play */
export const IMPORT_REFUSED_HERE =
  'Couldn’t use an imported robot here. This room uses a standard robot, so pick one of your saved robots and try again.';

/** a seat whose build predates imports, joining a room that has one */
export const IMPORT_ROOM_NEEDS_UPDATE =
  'Couldn’t join this room. It has an imported robot that your version of DSIM can’t play. Refresh the page to update, then try again.';

/** an imported robot, offered by a seat that has a member on an older build */
export const IMPORT_MEMBER_NEEDS_UPDATE =
  'Couldn’t use an imported robot. Someone in this room is on an older version of DSIM. Pick a standard robot, or ask them to refresh the page.';

/** the host pressed START with an imported robot and a seat or spectator that cannot play it */
export const IMPORT_START_REFUSED =
  'Couldn’t start the match. Someone here is on an older version of DSIM and can’t play an imported robot. Ask them to refresh the page, or pick a standard robot.';

/** an imported robot whose id another seat in the room already holds */
export const IMPORT_ID_TAKEN =
  'Couldn’t use this imported robot here. Another driver in this room has a robot with the same id. Duplicate it in your robot library to give it its own id, or pick another robot.';

/** the client's own one-liner when it falls back to a standard robot */
export const IMPORT_FELL_BACK = 'This server can’t play imported robots yet, so you are using your last standard robot.';

/** the robot id (`ImportedRobot.id`) a spec carries, read off the RAW value, or undefined. The id
 *  rule is `coerceImported`'s (16 lowercase hex), so a raw id that passes here survives coercion. */
export function importIdOf(spec: unknown): string | undefined {
  if (!isImportedSpec(spec)) return undefined;
  const id = (spec as { imported: { id?: unknown } }).imported.id;
  return typeof id === 'string' && /^[0-9a-f]{16}$/.test(id) ? id : undefined;
}

// ---- the room's state, and the one admission rule -------------------------------------

/**
 * What a room has to know about imported robots to decide who may come in. Four facts, so a
 * worker room can mirror them to the socket thread (`RoomFacts`) and the same rule runs on both
 * sides of that boundary.
 */
export interface ImportRoomState {
  /** may an imported robot play here at all? A custom or LAN room only: never a ranked or staged
   *  room, never a record room. */
  allows: boolean;
  /** some seat's robot, or the match being played, carries an import */
  hasImport: boolean;
  /** some seated client or spectator does not advertise `ROBOT_IMPORT_CAP` */
  capless: boolean;
  /**
   * The robot ids the seats hold (a seat changing its own robot is left out of its own check).
   * TWO SEATS MAY NOT HOLD ONE ID: a robot's picture and mesh are relayed and drawn by that id, so
   * a second seat claiming it could put its own look on the first seat's robot for everyone.
   * Absent on a mirror that predates it (then the room's own `add` decides).
   */
  ids?: readonly string[];
}

/**
 * May `who` come into (or change their robot in) a room in `state`? Null when yes, else the
 * sentence to send. The ONE rule, asked at every door the server has: a new driver (join), a
 * returning seat (rejoin), a watcher (spectate, who steps the world as a driver's client does)
 * and a seated driver asking for an imported robot (an `update` patch that carries one).
 *
 * `who.imported` is whether the robot they bring is imported. A client whose build lacks the cap
 * can never honestly bring one, so that combination is refused as a plain "not here". `who.id` is
 * that robot's id, when it has a well-formed one.
 */
export function importAdmission(
  state: ImportRoomState,
  who: { imported: boolean; caps: readonly string[] | undefined; id?: string },
): string | null {
  const cap = hasImportCap(who.caps);
  if (who.imported) {
    if (!state.allows) return IMPORT_REFUSED_HERE;
    if (!cap) return IMPORT_ROOM_NEEDS_UPDATE;
    // `capless` is read over every seat and spectator; this client has the cap, so it adds nothing
    if (state.capless) return IMPORT_MEMBER_NEEDS_UPDATE;
    if (who.id !== undefined && state.ids?.includes(who.id)) return IMPORT_ID_TAKEN;
    return null;
  }
  // an ordinary robot: only the room's contents can turn it away, and only for lack of the cap
  if (state.hasImport && !cap) return IMPORT_ROOM_NEEDS_UPDATE;
  return null;
}
