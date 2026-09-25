import type { DodgeVerdict } from '../dodge';
import type { StandingTierKey } from '../standing';
import type {
  Alliance,
  Artifact,
  AssistConfig,
  BallState,
  GameId,
  Physics,
  RobotCommand,
  RobotSpec,
  RobotState,
  World,
  StartPose,
  StartCat,
} from '../types';
import type { RobotSetup } from '../sim/spawn';
import type { Replay, ReplayResult } from '../sim/replay';
import { clamp } from '../math';
import { flywheelSpinTarget } from '../sim/field';

/**
 * Wire protocol for the SERVER-AUTHORITATIVE netcode (Phase 0). All messages are
 * JSON over a single WebSocket per client — binary/delta encoding is a Phase 1
 * optimization. Two directions:
 *   - ClientMsg (browser → server): lobby ops + per-tick `input`.
 *   - ServerMsg (server → browser): roster, `matchStart`, `snapshot`, `drop`.
 *
 * Determinism note (narrower than the old lockstep rule): the server is the sole
 * authority, so cross-machine float determinism is NOT required. What IS required
 * is that the value the client PREDICTS with matches the value the server steps:
 * the client quantizes its command (`quantizeCommand`) before sending AND predicts
 * on the round-tripped value (`localizeCommand`); the server dequantizes the same
 * bytes. Never predict on a raw command while sending a quantized one.
 */

/** a RobotCommand packed into 3 signed axes + a button bitfield (4 bytes) */
export interface QCommand {
  dx: number; // int8, -127..127  (driveX * 127)
  dy: number; // int8
  rot: number; // int8
  buttons: number; // uint16 bitfield: bit0 intake, bit1 fire, bit2 catalyst … bit8 bbRamp
  // TANK drive steers via leftDrive/rightDrive (NOT dx/dy) — these MUST be on the
  // wire or a networked tank robot gets zero drive and sits frozen at spawn. Optional
  // so a packet from an older client still decodes (missing ⇒ 0, the old behavior).
  ld?: number; // int8 (leftDrive * 127)
  rd?: number; // int8 (rightDrive * 127)
}

const BTN_INTAKE = 1;
const BTN_FIRE = 2;
const BTN_CATALYST = 4;
// Adding a bit is backward-compatible: an older peer masks only the bits it knows and
// ignores the rest. EVERY new held button MUST be added here — the quantizer is the wire
// format, so a field that is not in the mask does not exist as far as the server (or a
// predicted/replayed step) is concerned.
const BTN_FLING = 8;
const BTN_DRIVEMODE = 16;
// BIOBUZZ Box Tube placement, both EDGE-triggered in the sim: `bbPlaceNectar` places a NECTAR
// and `bbPlace` a POLLEN into the FLOWER in reach. Bit 32 used to be the removed hold-to-raise
// `bbLift`; it is REUSED (BIOBUZZ is alpha-only and version-gated) so bit 128, the last spare
// replay bit, stays free. Neither is an analog axis, so no `REPLAY_FORMAT` bump is needed.
const BTN_BBPLACE_NECTAR = 32;
const BTN_BBPLACE = 64;
// The HUMAN PLAYER button (G426) — an EDGE like `catalyst`, held on the wire and edge-detected
// in the sim, so a reconciled or replayed tick cannot enter two NECTAR off one press. It was
// the last bit of a uint8; see `BTN_BBRAMP` for the widening.
const BTN_BBNECTAR = 128;
// ⚠️ `buttons` IS 16 BITS WIDE SINCE 2026-09-20. It is a JSON number on the wire and a plain
// number in a replay track, so the width was only ever `sanitizeQCommand`'s range check and
// `packKey`'s byte mask (`src/sim/replay.ts`) — both widened with this bit. An OLDER SERVER
// refuses a packet carrying it (its sanitizer still stops at 255), which costs that sender one
// tick of input on a build that has no ramp to deploy; an older peer reading a newer replay masks
// the bits it knows, as always. The BIOBUZZ deployable-ramp toggle, an EDGE like `driveMode`.
const BTN_BBRAMP = 256;
// BIOBUZZ PASS-TO-PARTNER, an EDGE like `fire`. Bit 512 needs no widening — `buttons` has
// been 16 bits since 2026-09-20 (see BTN_BBRAMP) and `BUTTONS_MAX` already admits it. An
// older server's sanitizer stops at 0xffff too, so unlike the ramp's bit this one costs a
// new client NOTHING against an old server: the packet is accepted, the bit is simply
// ignored by a step that has no pass in it.
const BTN_BBPASS = 512;
/** the widest `buttons` an honest sender can produce — every bit above is refused. */
const BUTTONS_MAX = 0xffff;

export function quantizeCommand(c: RobotCommand): QCommand {
  return {
    dx: Math.round(clamp(c.driveX, -1, 1) * 127),
    dy: Math.round(clamp(c.driveY, -1, 1) * 127),
    rot: Math.round(clamp(c.rotate, -1, 1) * 127),
    buttons:
      (c.intake ? BTN_INTAKE : 0) |
      (c.fire ? BTN_FIRE : 0) |
      (c.catalyst ? BTN_CATALYST : 0) |
      (c.fling ? BTN_FLING : 0) |
      (c.driveMode ? BTN_DRIVEMODE : 0) |
      (c.bbPlaceNectar ? BTN_BBPLACE_NECTAR : 0) |
      (c.bbPlace ? BTN_BBPLACE : 0) |
      (c.bbNectar ? BTN_BBNECTAR : 0) |
      (c.bbRamp ? BTN_BBRAMP : 0) |
      (c.bbPass ? BTN_BBPASS : 0),
    ld: Math.round(clamp(c.leftDrive ?? 0, -1, 1) * 127),
    rd: Math.round(clamp(c.rightDrive ?? 0, -1, 1) * 127),
  };
}

/** the wire range of a packed axis — `int8`, and exactly what `quantizeCommand` can emit */
const Q_AXIS_MAX = 127;
/**
 * Force an UNTRUSTED `q` payload into a QCommand, or refuse it outright.
 *
 * `dequantizeCommand` divides by 127 and masks bits; it does not type-check, because the
 * packet it was written for came from `quantizeCommand` one function above. A packet off a
 * WebSocket did not: `{}` dequantizes to `driveX: NaN`, and `{ ld: 1e9 }` to a left track
 * running at 7,874,015 — both inside the SERVER-OWNED world every other member of the room
 * is watching, so the poisoned pose is broadcast to them as authoritative truth.
 *
 * REFUSED, not clamped. Every honest sender is `quantizeCommand`, which rounds and clamps
 * already, so anything out of range was hand-made — and a clamp would answer it with a legal
 * command the driver never gave. Dropping the frame costs the sender their own input for one
 * tick and costs nobody else anything.
 */
export function sanitizeQCommand(raw: unknown): QCommand | null {
  if (raw === null || typeof raw !== 'object') return null;
  const q = raw as Record<string, unknown>;
  const axis = (v: unknown): number | null =>
    typeof v === 'number' && Number.isInteger(v) && v >= -Q_AXIS_MAX && v <= Q_AXIS_MAX ? v : null;
  const dx = axis(q.dx);
  const dy = axis(q.dy);
  const rot = axis(q.rot);
  if (dx === null || dy === null || rot === null) return null;
  if (typeof q.buttons !== 'number' || !Number.isInteger(q.buttons) || q.buttons < 0 || q.buttons > BUTTONS_MAX) {
    return null;
  }
  // ld/rd stay OPTIONAL (a pre-tank client sends neither and means zero), but a present
  // one must still be a legal axis — absent and malformed are not the same packet.
  const ld = q.ld === undefined ? undefined : axis(q.ld);
  const rd = q.rd === undefined ? undefined : axis(q.rd);
  if (ld === null || rd === null) return null;
  // `buttons` is kept WHOLE rather than masked to the bits this build knows: a mask here would
  // be a silent way to drop a newer client's action. `dequantizeCommand` reads the bits it
  // understands and ignores the rest, which is the back-compat rule already.
  const out: QCommand = { dx, dy, rot, buttons: q.buttons };
  if (ld !== undefined) out.ld = ld;
  if (rd !== undefined) out.rd = rd;
  return out;
}

export function dequantizeCommand(q: QCommand): RobotCommand {
  return {
    driveX: q.dx / 127,
    driveY: q.dy / 127,
    rotate: q.rot / 127,
    leftDrive: (q.ld ?? 0) / 127, // ?? 0: tolerate an older client's ld/rd-less packet
    rightDrive: (q.rd ?? 0) / 127,
    intake: (q.buttons & BTN_INTAKE) !== 0,
    fire: (q.buttons & BTN_FIRE) !== 0,
    catalyst: (q.buttons & BTN_CATALYST) !== 0,
    fling: (q.buttons & BTN_FLING) !== 0,
    driveMode: (q.buttons & BTN_DRIVEMODE) !== 0,
    bbPlaceNectar: (q.buttons & BTN_BBPLACE_NECTAR) !== 0,
    bbPlace: (q.buttons & BTN_BBPLACE) !== 0,
    bbNectar: (q.buttons & BTN_BBNECTAR) !== 0,
    bbRamp: (q.buttons & BTN_BBRAMP) !== 0,
    bbPass: (q.buttons & BTN_BBPASS) !== 0,
  };
}

/** the exact command the client must PREDICT with (quantize round-trip), so its
 * local sim matches what the server computes from the same wire bytes */
export function localizeCommand(c: RobotCommand): RobotCommand {
  return dequantizeCommand(quantizeCommand(c));
}

// ---- lobby model ------------------------------------------------------------

/** max drivers per room (2v2) */
export const ROOM_CAPACITY = 4;

/**
 * The two clocks a staged ranked match runs on, and the reason they live out here.
 *
 * They are the SERVER's rules (`server/room.ts` owns both timers), but the queue screen has
 * to state them before a player joins the queue: missing either one is a dodge, and a dodge
 * costs account standing. A player who finds that out by being charged was never told the
 * rule. Quoting one number from the wire module keeps the screen and the timer in step; a
 * second copy in the UI would drift the first time either is tuned.
 */
export const RANKED_JOIN_GRACE_MS = 20000;
export const STRATEGY_DURATION_MS = 20000;

/** who runs the service — the staff badge beside a name. Lives here rather than
 * in the UI because it travels on the wire (`LobbyPlayer`, the leaderboard rows,
 * the entitlements payload) and `src/net` must not depend on `src/ui`. */
export type StaffRole = 'owner' | 'admin';

/** what a room runs. 'versus' = the existing PvP match (ELO). 'record' =
 * opponent-free score-attack for the record boards; solo = 1 robot (1v0), duo =
 * 2 co-op robots on one alliance (2v0). A duo may mix drivetrains — a mixed pair
 * ranks the OVERALL board only, a matched pair also ranks that drivetrain's. */
export type RoomKind = 'versus' | 'record';
export type RecordKind = 'solo' | 'duo';
/** ranked matchmaking bucket */
export type QueueMode = '1v1' | '2v2';
export const QUEUE_NEED: Record<QueueMode, number> = { '1v1': 2, '2v2': 4 };

export interface RoomConfig {
  kind: RoomKind;
  /** set when kind === 'record' */
  record?: RecordKind;
  /** which game the room plays. Absent ⇒ 'decode' (old clients / back-compat).
   * The server resolves the game module from this; matchmaking buckets by it. */
  game?: GameId;
  /**
   * WHICH PHYSICS BACKEND THIS ROOM'S WORLD RUNS ON — ⚠️ **NO LONGER READ BY THE SERVER**
   * (owner ruling, 2026-09-18).
   *
   * `Room.physics` now answers from the GAME alone: a game that can step `'3d'` runs `'3d'` for
   * every server-connected match — record, ranked, matchmade, custom, spectated, LAN — because
   * the record board is one solve. There is no host choice left for this field to carry.
   *
   * It stays on the wire as the room's DECLARED solve, and it is omitted entirely for a game
   * with no 3D solve, which keeps DECODE and Chain Reaction's handshake byte-identical.
   *
   * ⚠️ IT IS NOT A BACK-COMPAT PATH. An older server does not read this field at all — the
   * `RoomConfig` on main has no `physics` key and the decoder drops config keys it does not
   * know — so sending it to a server a deploy behind is inert, not compatible. The
   * compatibility that has to be managed runs the OTHER way and it is a DEPLOY ORDER: BIOBUZZ
   * is public on the stable channel, and every production client built before the `'bb3d'` cap
   * existed is refused from every BIOBUZZ room until it reloads. Ship and verify the CLIENT
   * (Vercel) FIRST, then the server (Fly); a tab held open across the deploy is refused with
   * `BB3D_REFUSAL` until the version gate reloads it.
   *
   * It is a ROOM property and not a per-client one: a room has one authoritative world, so a
   * client whose build cannot step `'3d'` cannot be in it at all. That is what the `'bb3d'`
   * capability gate below is for — and since a bare BIOBUZZ join now yields a 3D room rather
   * than a 2D one, that gate is where an old client is turned away instead of downgraded.
   */
  physics?: Physics;
}

export const DEFAULT_ROOM_CONFIG: RoomConfig = { kind: 'versus' };

/** roster cap for a room kind (record rooms are opponent-free + small) */
export function roomCapacity(config: RoomConfig): number {
  if (config.kind === 'record') return config.record === 'duo' ? 2 : 1;
  return ROOM_CAPACITY;
}

/** a driver in a room (server-authoritative — no presence/mesh bookkeeping) */
export interface LobbyPlayer {
  clientId: string;
  name: string;
  teamName: string;
  teamNumber: number;
  alliance: Alliance;
  /** index into START_POSES (mirrored per alliance) — the quick-pick fallback */
  startIndex: number;
  /** a fully-placed CUSTOM start pose (canonical goalSide=+1 frame). Overrides
   * startIndex when present; the server + createWorld snap it G304-legal. */
  startPose?: StartPose | null;
  /** 2v2 start ROLE (which start category this robot may pick). Absent ⇒ derived
   * from alliance join order. Set explicitly only after a consented role swap. */
  startRole?: StartCat;
  /** true while this player has an outstanding / accepted role-swap request. When
   * BOTH alliance members set it, each flips its own role and clears the flag. */
  swapReq?: boolean;
  ready: boolean;
  /**
   * HAS THIS SEAT'S 3D PHYSICS CHUNK LOADED — server-authored, and only meaningful in a
   * `'3d'` room (`READY3D_CAP`).
   *
   * `ready` is a decision the driver makes; this is a fact about their machine, so the two
   * are separate chips and separate fields. It is on the roster because the screen that has
   * to wait has to say WHO it is waiting for — "Everyone ready. Starting…" sitting there for
   * eight seconds with nothing else on it is the state this whole handshake exists to remove.
   *
   * ABSENT means "nothing to wait for": a 2D room, a client that never advertised the
   * capability, a bot, or an older server that does not set it. Additive and optional both
   * ways, so no `caps` gate — an older client ignores the key and renders no chip.
   */
  ready3d?: boolean;
  /**
   * The NAME of the Zenith auto this player will run in AUTO, server-authored from their
   * `zenithAuto` message, so the lobby can show who has one. Only the name: the file itself never
   * rides the roster. Absent = none (or an older server). Custom rooms only.
   */
  autoName?: string;
  spec: RobotSpec;
  assists: AssistConfig;
  // NOTE: no `autoPath` here. Autonomous does not run in a server-authoritative
  // match (`Room.beginMatch` strips it from every setup), so carrying a whole
  // path on the roster put an unbounded object on every `roster` broadcast for
  // a field nothing read. A path still reaches a STAGED match through
  // `PendingRobot.autoPath`, which is a different source and still coerced.
  // ---- server-authored, set only during the ranked pre-match STRATEGY phase ----
  // (never accepted from a client patch). `slot` is this player's roster/robot
  // index so its card can look up its `PlayerIntro` ELO; `hidden` marks an OPPONENT
  // card the server has redacted (name/team/ELO only — its `spec`/`assists` are
  // neutralized placeholders so an opponent can't be counter-picked pre-match).
  slot?: number;
  hidden?: boolean;
  /**
   * active supporter membership — renders the badge beside this driver's name.
   *
   * ALSO server-authored, set once at join from the signed-in account.
   * `sanitizePlayer` builds an allowlisted object and `PlayerPatch` is a `Pick`,
   * so a client cannot put this on the wire itself — which matters, because the
   * badge is the visible half of a paid tier and a self-declared one is worth
   * nothing. Optional, so an older server that never sets it and an older client
   * that ignores it both keep working against this build.
   */
  supporter?: boolean;
  /**
   * 'owner' | 'admin' — renders the staff badge instead of the supporter one.
   *
   * Server-authored on exactly the same terms as `supporter` above, and for a
   * sharper version of the same reason: a self-declared "owner" badge beside a
   * driver's name in a lobby is an impersonation primitive, not a cosmetic.
   */
  role?: StaffRole;
  /**
   * the EQUIPPED TITLE id, or null — the award hexagon / ledger chip beside this
   * driver's name, resolved client-side by `parseAwardTitleId` without a second query.
   *
   * Server-authored on exactly the same terms as the two above, and for the same reason:
   * a title is something earned, so a self-declared one is a claim to have earned it.
   * Read once at join from the account (`getProfile`), like the badge fields, so a roster
   * broadcast still costs no database read. Optional, so an older server that never sets
   * it and an older client that ignores it both keep working against this build.
   */
  title?: string | null;
  /**
   * the EQUIPPED BADGES and their counters, `[{id, n}]` (migration 0048, `src/badges.ts`).
   * Server-authored on exactly the same terms as `title` above — a badge is a claim to have
   * won something — and read at join off the same `getProfile` row, so a roster broadcast
   * still costs no database read. At most three short ids, never a rendered string. Optional:
   * an older server never sets it and an older client ignores it.
   */
  badges?: { id: string; n: number }[];
  /**
   * THIS SEAT IS A BOT, and the string is its TIER (plan §6).
   *
   * Server-authored on exactly the same terms as `supporter` and `role` — `sanitizePlayerPatch`
   * builds an allowlisted object and `PlayerPatch` is a `Pick` that does not name it, so a
   * client cannot put it on the wire. That matters here for a reason the badges do not have: a
   * bot seat makes a room UNRATED, so a self-declared one would be a way to ask for that, and a
   * self-declared ABSENCE would be a way to hide it.
   *
   * Optional, and an OLD CLIENT IS UNHARMED BY IT: it renders the roster row as an ordinary
   * driver named "Medium bot", ready, on an alliance — which is exactly what the seat is. The
   * only thing it cannot do is remove one, and removing one is a host action an old client has
   * no button for anyway.
   */
  bot?: string;
}

/** a driver's pre-match ranked intro data (ELO, keyed by the robot id the server
 * assigns at matchStart). Sent only for ranked rooms; drives the intro overlay.
 * Name / team / drivetrain come from the matching `RobotSetup`, so only the
 * per-driver ELO travels here. */
export interface PlayerIntro {
  /** the robot id assigned in `matchStart.setups` */
  id: number;
  /** current overall ranked ELO, or null if the driver is signed out / unrated */
  elo: number | null;
}

/**
 * WHO IS DRIVING ROBOT `robotId` — the account username, keyed by the robot id the server
 * assigned at matchStart.
 *
 * It exists because a match had no way to name the PEOPLE in it. `matchStart.setups` carries
 * each robot's `RobotSpec`, whose `name` is what the builder called the CHASSIS, and the
 * in-match label drew that — so two drivers who both left the default name on their build were
 * labelled identically. The username is on the lobby `roster` the whole time and nothing mapped
 * it onto a robot id.
 *
 * A BOT SEAT IS A DRIVER HERE TOO, named for its tier exactly as its roster row is: the label
 * is answering "who is that", and "Medium bot" is the honest answer.
 *
 * No `caps` gate: the field is purely additive on a message every build already parses, so an
 * older client destructures the fields it knows and never sees this one, and an older SERVER
 * sends none and the client falls back to `spec.name` — which is what it drew before this
 * existed. Same reasoning as `error.code`.
 */
export interface MatchDriver {
  /** the robot id assigned in `matchStart.setups` */
  robotId: number;
  /** the driver's username, already moderated (`scrubName` at join) */
  name: string;
  /**
   * The BADGE FIELDS, carried so the results roster can name a driver the way every other
   * surface does. Copied from the same `LobbyPlayer` the lobby roster renders — never read
   * a second time, and never accepted from a client, for the reasons stated there. Both are
   * optional: an older server sends neither and the roster row renders bare, which is
   * exactly what it drew before this existed.
   *
   * NO `title` here, unlike `LobbyPlayer`. The results roster is a one-line broadcast row
   * whose name marquees rather than wraps, and a variable-width title chip takes its width
   * from the name — see the note beside `.resx-roster-name` in styles.css. A field nothing
   * renders is a field that goes stale, so it is not on the wire.
   */
  supporter?: boolean;
  role?: StaffRole;
}

/** one driver's overall-ELO change, sent after a ranked match is scored so the
 * results screen can show before → after (+delta). Keyed by robot id. */
export interface EloDelta {
  robotId: number;
  before: number;
  after: number;
  /** new Glicko rating deviation (kept for reference; no longer drives the "?") */
  rd: number;
  /** overall-board games AFTER this match — < PLACEMENT_GAMES ⇒ still in
   * placements, shown with a "?" on the results screen */
  games: number;
}

/** fields a client may change about itself while in the room */
export type PlayerPatch = Partial<
  Pick<
    LobbyPlayer,
    'name' | 'teamName' | 'teamNumber' | 'alliance' | 'startIndex' | 'startPose' | 'startRole' | 'swapReq' | 'ready' | 'spec' | 'assists'
  >
>;

// ---- client → server --------------------------------------------------------

/** capabilities THIS client build understands, sent on `join`/`queue` so ONE server
 * can serve mixed client versions (alpha/beta/main all point at it). A staged ranked
 * room opens the pre-match strategy window only when EVERY member advertises
 * 'strategy'; otherwise it starts immediately (the pre-strategy behavior), so an old
 * client is never stranded waiting for a `strategyStart` it can't render. Absent/old
 * clients send nothing ⇒ treated as no caps. Add new capability strings here as the
 * protocol grows. */
export const CLIENT_CAPS: string[] = ['strategy', 'startpose', 'game', 'standing', 'recycle', 'bb3d', 'ready3d'];

/**
 * THE ONE CAPABILITY THAT IS A HARD GATE RATHER THAN A FEATURE FLAG.
 *
 * Every other entry in `CLIENT_CAPS` degrades: a client without `'strategy'` skips the
 * pre-match window, one without `'recycle'` never sees a room go back to its lobby. `'bb3d'`
 * cannot degrade, because it is about whether the client can SIMULATE the room at all — a
 * `'3d'`-physics world steps through `step3d`, and a build that predates `sim3d/` has no code
 * for it. Such a client in such a room would not render a worse match; it would throw on its
 * first tick, or (worse) fall through to the 2D pipeline and predict a different game from the
 * one the server is scoring.
 *
 * So the server REFUSES the join instead, with the sentence below. Named here, beside the
 * capability, because three call sites send it (`join`, `rejoin`, `spectate`) and a fourth
 * refuses a `queue` for a BIOBUZZ format — four spellings of one rule is how a refusal ends up
 * saying something different depending on which door you came through.
 */
export const BB3D_CAP = 'bb3d';
export const BB3D_REFUSAL = 'Update DSIM to play this room.';

/** may a client advertising `caps` be seated in a room running `physics`? A `'2d'` room
 *  admits everyone, exactly as it always did — that is the back-compat rule this whole gate
 *  is written around. Absent caps (an old client that sends none) ⇒ no capabilities. */
export function physicsAllowed(physics: Physics | undefined, caps: readonly string[] | undefined): boolean {
  return (physics ?? '2d') !== '3d' || !!caps?.includes(BB3D_CAP);
}

/**
 * `'ready3d'` — THIS CLIENT WILL SAY WHEN ITS 3D PHYSICS CHUNK HAS LOADED.
 *
 * `'bb3d'` says the build CAN step a 3D world. It says nothing about WHEN: the Rapier 3D
 * wasm and the `sim3d/` barrel are two lazy chunks (`initPhysics3d`), so a client that is
 * fully capable is still unable to step anything for as long as they are in flight. The
 * server used to start the match the instant everyone readied, and a driver whose chunks
 * were still downloading watched the first seconds of their own match from the loading
 * panel — in a RANKED match, seconds they are accounted away for.
 *
 * So a client that advertises this sends `{ t: 'physicsReady' }` once `initPhysics3d()` has
 * resolved, and a `'3d'` room holds its start until every seat that advertised it has.
 *
 * ⚠️ IT DEGRADES, unlike `'bb3d'`. A client WITHOUT it counts as ready the moment it sits
 * down — it is an older build that never sends the message, and a room that waited on one
 * would wait for `READY3D_DEADLINE_MS` and then start anyway, i.e. hold everyone else up
 * for 45 seconds for nothing. A bot seat is ready for the same reason: the server's own
 * physics is up before any room ticks (`physicsReadyForRoom`).
 */
export const READY3D_CAP = 'ready3d';

/**
 * How long a `'3d'` room will hold its start waiting for seats to report in.
 *
 * ⚠️ **IT STARTS THE MATCH, IT NEVER CANCELS ONE.** The wait exists to spare a driver the
 * first seconds of their own match, and that is worth 45 seconds and not one second more —
 * a chunk that has not arrived by then is not arriving, and the other three people in the
 * room have done nothing wrong. Cancelling instead would also hand every client a free
 * dodge: `physicsReady` is a message a client chooses to send, so "never send it" would be
 * a way to kill a staged ranked match at no cost to the person who killed it.
 *
 * Generous because the measure is a cold cache on a bad connection, not a warm one: the
 * client kicks the load off the moment a server match is in prospect (entering the queue,
 * joining a room, opening the record page), so the usual wait is zero.
 */
export const READY3D_DEADLINE_MS = 45000;

/** does a client advertising `caps` report 3D readiness? A client without the capability
 *  counts as ready at once — see `READY3D_CAP`. */
export function reportsPhysicsReady(caps: readonly string[] | undefined): boolean {
  return !!caps?.includes(READY3D_CAP);
}

/**
 * The `caps` off a client frame, as a list of strings and nothing else.
 *
 * ONE coercion for every door, because `caps` is attacker-controlled and `Array.isArray` alone
 * is not a validation: it admits `[{…}, 5, null]`, which is then STORED on the client record
 * and compared by every feature gate, and it admits an array of any LENGTH — a free per-socket
 * allocation on a frame that arrives before anything is authenticated. Strings only, and the
 * first 16 of them; `CLIENT_CAPS` has six, so the cap is slack rather than a limit anyone can
 * reach honestly.
 */
export function coerceCaps(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((c): c is string => typeof c === 'string').slice(0, 16) : [];
}

/**
 * Capabilities the SERVER advertises, reported on `GET /api/presence`.
 *
 * The mirror image of `CLIENT_CAPS`, pointed the other way and for the same
 * reason: one Fly app serves every client build, so a NEW client can find itself
 * talking to a server that predates the feature it wants to offer. That is
 * harmless for anything the server would simply ignore — but not for `party`. An
 * older server ignores the party fields on `queue` and drops both friends into the
 * open ranked pool as strangers, which silently produces the wrong thing: two
 * people who asked to play each other get matched against whoever else is waiting.
 *
 * So the rated challenge formats stay hidden until the server says it can honour
 * them. No `caps` in the response at all (an older deploy) ⇒ no capabilities.
 */
export const SERVER_CAPS: string[] = [
  'party',
  /**
   * `'bb3d'` — THIS DEPLOY RUNS EVERY BIOBUZZ ROOM ON THE 3D SOLVE.
   *
   * (It said "ranked and record rooms" until the 2026-09-18 ruling made it all of them. The
   * capability's job is unchanged: it is how a client tells a deployed server from one that is
   * still behind. A CUSTOM room no longer needs it either way — the client sends
   * `physics: '3d'` and an older server honours that — but a RANKED queue does, because the
   * matchmaker stages the room and no client field reaches it.)
   *
   * The mirror of the client capability of the same name, and it exists because the cutover is
   * PER SERVER (plan §7: alpha on Day 3, production when the owner says so). A client build that
   * can play 3D rooms says so on `join`; a SERVER that will stage them says so here. Without it
   * the client cannot tell a server that has not been deployed yet from one that has, and the
   * two answers matter in opposite directions: a BIOBUZZ ranked queue against an old server
   * stages a 2D match whose result lands on the same board as everybody's 3D ones, silently.
   * So the client refuses to queue BIOBUZZ ranked on a server that does not advertise this, and
   * says why. Nothing else is gated on it — 2D rooms, custom rooms and practice are untouched.
   */
  'bb3d',
  /**
   * `'bots'` — THIS DEPLOY UNDERSTANDS `addBot` / `removeBot`.
   *
   * An older server ignores an unknown client message rather than refusing it, so "Add a bot"
   * would be a button that does nothing at all. Same reasoning as `party` directly above, and
   * the same remedy: the control is not offered until the server says it can honour it.
   */
  'bots',
  /**
   * `'ready3d'` — THIS DEPLOY HOLDS A 3D ROOM'S START UNTIL THE SEATS HAVE LOADED.
   *
   * The mirror of the client capability of the same name. Nothing is gated on it: a client
   * sends `physicsReady` regardless, an older server falls through its `onMessage` switch and
   * ignores it, and the match starts the way it always did. It is here so a screen can say
   * whether the wait it is showing is real — and so an operator can tell a fleet mid-rollout
   * apart from one that is done.
   */
  'ready3d',
  /**
   * `'zenithAuto'` — THIS DEPLOY PLAYS A PLAYER'S ZENITH AUTO IN A CUSTOM ROOM'S AUTO.
   *
   * The client sends `{ t: 'zenithAuto' }` only to a server that says this, because an older one
   * would silently drop the file and the driver would stand still through AUTO wondering why.
   */
  'zenithAuto',
];

/** the formats a "play a friend" challenge can be issued in. Shared so the API's
 * allowlist, the matchmaker's gate, and the picker's tiles can't drift apart. */
export const CHALLENGE_FORMATS = [
  'casual1v1',
  'casual2v2',
  'rated1v1',
  'ranked2v2',
  'duorecord',
] as const;
export type ChallengeFormat = (typeof CHALLENGE_FORMATS)[number];

/**
 * The formats that resolve through the MATCHMAKER instead of through a joinable
 * room code — which is exactly what makes them rated, since `Room.ranked` is only
 * ever set from a staged `pending_matches` row (see server/room.ts).
 *
 * `partyOnly` is the difference between the two:
 *  - `rated1v1` is a CLOSED pair. The token is the whole match; it never admits a
 *    stranger and never waits on the search radius, because the two of them
 *    already chose each other.
 *  - `ranked2v2` is a PREMADE that queues into the OPEN 2v2 pool. It waits for two
 *    more like anyone else; the only privilege is landing on one alliance.
 */
export const RATED_FORMATS: Record<string, { mode: QueueMode; partyOnly: boolean }> = {
  rated1v1: { mode: '1v1', partyOnly: true },
  ranked2v2: { mode: '2v2', partyOnly: false },
};

export type ClientMsg =
  // `authToken` is the Neon Auth JWT; the server verifies it to attribute the
  // run to a real user (absent/invalid ⇒ anonymous). See server/auth.ts.
  // `caps` (optional) advertises this client build's protocol capabilities.
  | {
      t: 'join';
      room: string;
      player: Omit<LobbyPlayer, 'clientId'>;
      config?: RoomConfig;
      authToken?: string;
      caps?: string[];
      /** this client build's release channel ('alpha' | 'stable' | …). Absent ⇒
       * 'stable'. Alpha rooms are segregated + never persisted (see server). */
      channel?: string;
      /** optional grouping tag (the Discord Activity instance id) so the Discord
       * lobby browser can list only the rooms from one activity. Set by the room
       * CREATOR; ignored on an existing room. Absent ⇒ ungrouped. */
      group?: string;
    }
  // reclaim an in-match slot after a transient socket drop (within the grace
  // window) — the server rebinds the robot to the new connection and resyncs
  // `caps` is the same advertisement `join` carries, re-sent because a reclaim is a fresh
  // socket and the server gates a `'3d'` room on it at every door. Absent (older clients) ⇒
  // no capabilities, which is what they had before this field and refuses them only from the
  // rooms they could never have joined in the first place.
  | { t: 'rejoin'; room: string; clientId: string; caps?: string[] }
  /**
   * GIVE UP A HELD SLOT ON PURPOSE — the "Abandon" on the game-in-progress card.
   *
   * Sent on a throwaway socket by a client that is NOT in the room: the point is to be
   * usable from the menu, after a reload, by a browser whose only memory of the match is
   * the `activeGame` record. Owning the client id is the proof, exactly as it is for
   * `rejoin` — the server minted it and told nobody else.
   *
   * Without it, Abandon cleared the browser's record and nothing else, so the server's
   * single-game lock outlived the button by the length of the reconnect grace and the
   * next thing the player started was refused by advice about a game the UI had just
   * told them was gone.
   */
  | { t: 'abandon'; room: string; clientId: string }
  // SPECTATE a live match: join a room read-only. The server adds a spectator (no
  // robot slot, never counted toward capacity/roster/persistence), sends the current
  // `matchStart`, and streams the same `snapshot`s the drivers get. Input is ignored.
  // `authToken` is optional here and used for ONE thing: if the server verifies it
  // as an admin, this watcher is not counted in the visible spectator total (see
  // Room.hideSpectator). It is never a claim the client can make on its own.
  | { t: 'spectate'; room: string; caps?: string[]; authToken?: string }
  /**
   * REPORT another driver in this room, by ROBOT ID.
   *
   * Never by user id: the client is not told who its opponents are, and this keeps it that
   * way. The server maps the robot id onto its own roster, so a client can only report
   * somebody actually in the match it is actually in.
   */
  | { t: 'report'; robotId: number; reason: string; detail?: string }
  /**
   * REPORT A MISSCORE — a claim about the RESULT, not about a person.
   *
   * It carries no target at all, which is the whole difference: the score is the server's
   * arithmetic, so if it is wrong there is no opponent at fault and naming one would be a
   * lie the reporter has no way to check. The server resolves the reporter and the match it
   * wrote from its own roster, exactly as it does for a player report.
   */
  | { t: 'reportScore'; detail: string }
  | { t: 'update'; patch: PlayerPatch }
  /**
   * HOST ONLY: seat an AI driver on an empty slot, or give one back (plan §6).
   *
   * ⚠️ **CAP-GATED ON `SERVER_CAPS` `'bots'`, AND THAT GATE IS NOT OPTIONAL** — it is the same
   * failure shape as `party`. One Fly app serves every client build, so a new client can be
   * talking to a server that predates this message; an older server's `onMessage` falls through
   * its switch and IGNORES it. The button would then appear, be pressed, and do nothing, with
   * no error anywhere. So the client only offers "Add a bot" when the server says it can seat
   * one (`serverCaps()`), exactly as the rated challenge formats stay hidden without `party`.
   *
   * `tier` is the game's own opaque difficulty string (`GameSimModule.bot.tiers`); absent or
   * unknown folds to that driver's `defaultTier`, server-side, because a tier list is a
   * property of the game module and not of the client that names one.
   */
  | { t: 'addBot'; tier?: string }
  /** HOST ONLY: remove the bot seat with this roster `clientId` (the synthetic id the server
   *  minted for it and put in the roster). */
  | { t: 'removeBot'; seat: string }
  /**
   * MY 3D PHYSICS CHUNK HAS LOADED — sent once `initPhysics3d()` resolves, by any client
   * that advertised `READY3D_CAP`, and re-sent on a reconnect because a new socket is a new
   * client record on the server and its readiness went with the old one.
   *
   * It carries nothing. It is not a claim the server acts on beyond "stop waiting for this
   * seat": the room's own physics was up before it ticked anything, and a client that lies
   * here only hurts itself, since it is its own first tick that throws.
   *
   * Idempotent, unconditional and safe against an older server, which ignores an unknown
   * message rather than refusing it — so there is no `SERVER_CAPS` gate on sending it.
   */
  | { t: 'physicsReady' }
  /**
   * THIS PLAYER'S ZENITH AUTO for the next match of a CUSTOM room (docs/area/autos.md), or null
   * to clear it. Sent once from the lobby, never on the roster (a file is up to 64 KiB and the
   * roster is broadcast on every change): the server keeps it on the client record, puts its
   * name on the roster (`LobbyPlayer.autoName`), and at match start puts it into that robot's
   * setup, where the server's auto seat drives it through AUTO. A ranked, staged or record room
   * ignores it. An older server ignores the message, so send it only when the server
   * advertises `'zenithAuto'` (`SERVER_CAPS`).
   */
  | { t: 'zenithAuto'; auto: import('../auto/types').ZenithAutoSetup | null }
  | { t: 'start' } // host only: build + broadcast the match world
  | { t: 'restart' } // host only: re-author the match with a fresh seed
  /**
   * HOST ONLY: send a FINISHED room back to its lobby so it can host another game.
   *
   * A rematch replays the roster frozen at the first start; this recycles the room
   * instead — the world is torn down, everyone un-readies, and the next `start`
   * rebuilds setups from whoever is in the room THEN. That is what lets a group
   * switch alliances, or replace a player who left, without minting a new code.
   */
  | { t: 'lobby' }
  /**
   * DUO RECORD rematch vote — a TOGGLE, not a trigger.
   *
   * A co-op run belongs to both drivers, so one of them cannot restart it out from
   * under the other. Everyone votes, the server counts, and the match only restarts
   * once every connected driver has said yes; anyone can take their vote back.
   */
  | { t: 'rematch'; on: boolean }
  // `ack` (optional) is the newest authoritative snapshot `serverTick` this client
  // has APPLIED as its ball baseline — a client→server snapshot ACK piggybacked on
  // the per-tick input (drivers send input every tick, so it costs nothing). The
  // server uses it to know which baseline the client actually holds. Over the
  // reliable WebSocket the happy-path delta is still against the last broadcast;
  // the ack only drives a self-healing keyframe when a client's CONFIRMED baseline
  // falls too far behind (a wedged/way-behind client resyncs instead of drifting).
  // On an UNRELIABLE lane it carries the whole scheme: a tab-hosted LAN guest takes
  // snapshots over an unordered `maxRetransmits: 0` DataChannel, so last-sent is no
  // longer last-received and the server keys that client's delta to this ack (see
  // `lossy` in server/room.ts). The server refuses an ack that names a tick the world
  // has not reached — it is a baseline, not a claim. Absent from older clients ⇒ they
  // are never force-resynced and never treated as lossy (unchanged behaviour).
  // `gen` is the MATCH GENERATION this input was produced for (see `matchStart`).
  // A rematch rebuilds the world at tick 0, so inputs still in flight from the old
  // match carry tick numbers the NEW match will eventually reach — and would then be
  // applied as if they were fresh. The server drops any input whose generation is not
  // the current one. Absent (older clients) ⇒ accepted, exactly as before.
  | { t: 'input'; tick: number; q: QCommand; ack?: number; gen?: number }
  // ranked matchmaking: enter/leave a queue. Sent over a `?mm=1` connection that
  // fly-replay pins to the designated matchmaker machine. `homeRegion` is the region
  // Fly routed this client to (from the /health x-region header) and `accessMs` is
  // its measured RTT there; the matchmaker estimates cross-region latency from these
  // to pick a fair host. `noWiden` ⇒ never widen past my own region (stay local
  // forever). On a match the server sends `matchAssigned` (not `matchStart`): the
  // client reconnects to the assigned host region, where the real match is built.
  | {
      t: 'queue';
      mode: QueueMode;
      player: Omit<LobbyPlayer, 'clientId'>;
      authToken?: string;
      homeRegion: string;
      accessMs: number;
      noWiden?: boolean;
      caps?: string[];
      /** which game to queue for. Absent ⇒ 'decode'. The matchmaker buckets by it
       * so a Chain-Reaction queuer never pairs into a DECODE authoritative room. */
      game?: GameId;
      /** release channel (see `join.channel`): alpha queues only pair with alpha */
      channel?: string;
      /** this client's build id (git sha). The matchmaker segregates the queue by
       * build so two DIFFERENT builds never share an authoritative match — the exact
       * "same code" invariant (channel is only a coarse, manual proxy). Absent ⇒ the
       * server falls back to channel-only separation. */
      build?: string;
      /** "Play a friend": the challenge token both sides of a rated challenge hand
       * the matchmaker. Entries sharing one are matched as a UNIT — never split
       * across alliances, never matched apart. The server does NOT take this on
       * trust: it resolves the token against the actual challenge row and refuses
       * one the caller isn't a party to (`challengeParty`). */
      party?: string;
      /** this party is the WHOLE match — pair its members with each other and no
       * one else (`rated1v1`). Ignored unless `party` is set and verified. */
      partyOnly?: boolean;
      /** the challenge format the token was issued in, so the server can verify
       * the token against a challenge of that exact format */
      partyFormat?: string;
    }
  // widen my search radius NOW (impatient player), instead of waiting for the timed
  // auto-widen. Idempotent; ignored once the ceiling is already at max.
  | { t: 'expandSearch' }
  | { t: 'leaveQueue' }
  // latency probe: the server echoes `ts` straight back in a `pong`, so the client
  // measures round-trip time for the connection-quality HUD (no server clock needed)
  | { t: 'ping'; ts: number }
  /* ── LAN SIGNALLING ──────────────────────────────────────────────────────────────────
   * The cloud's whole involvement in a match it does not run. A LAN room is hosted in a
   * player's tab and reached over an RTCDataChannel at ~1 ms; these four messages are only
   * the introduction that lets two browsers find each other, because neither can be dialled
   * into. Once ICE has a pair, nothing else goes through the server until somebody leaves.
   * `server/lanSignal.ts` carries the reasoning and the bounds; `docs/lan-webrtc.md` §1 has
   * what it costs (~10 KB per guest, once, against 940 KB/s for a cloud 2v2). */
  // claim a code and host a LAN room. REQUIRES a valid `authToken`: the host is the one who
  // uploads the match afterwards, so an anonymous host is a match with nowhere to land.
  | { t: 'lanHost'; code: string; authToken?: string }
  // give up the code and drop every guest (also implied by the socket closing)
  | { t: 'lanStopHosting' }
  // ask to be introduced to a code's host
  | { t: 'lanJoin'; code: string }
  // forward one opaque blob (an SDP offer/answer, or an ICE candidate) to `peer`. The server
  // does not parse `data` — it is bounded and counted, never read.
  | { t: 'lanSignal'; peer: string; data: string };

/**
 * A live match summarised for the "Watch Live" list (`GET /api/live`) and for the
 * admin's live view.
 *
 * The two lists are the SAME shape but not the same set: `/api/live` is public and
 * shows RANKED matches only, while the admin endpoint shows everything running,
 * custom and record included. Filtering happens at the endpoints — `Room.summary()`
 * describes every live room and decides nothing about who may see it.
 */
export interface LiveRoom {
  /** the room code to spectate (region-coded, e.g. `iad-abc123`) */
  room: string;
  game: GameId;
  /** '1v1' | '2v2' (versus) or 'solo' | 'duo' (record) */
  mode: string;
  /** match clock phase ('auto' | 'transition' | 'teleop' | 'post') */
  phase: string;
  /** seconds left in the current phase (rounded) */
  timeLeft: number;
  ranked: boolean;
  /** the drivers (name + team + alliance), for the card */
  players: { name: string; teamName?: string; teamNumber?: number; alliance: 'red' | 'blue' }[];
  /** live alliance scores (red/blue totals) */
  score: { red: number; blue: number };
  /** how many people are already watching */
  spectators: number;
  /** 'versus' | 'record'. Optional: an older server predates it, and every reader
   *  must treat a missing value as the historical meaning (versus). */
  kind?: 'versus' | 'record';
  /** which Fly region is hosting, for the admin's cross-region list. Absent on a
   *  single-region/dev deploy. */
  region?: string;
}

// ---- server → client --------------------------------------------------------

/**
 * Machine-readable reasons for a `t: 'error'`. Only the cases a client can ACT on are
 * worth a code — everything else stays a plain message. Unknown codes must be treated
 * as an ordinary error, so this list can grow without a capability gate.
 */
export type ErrorCode =
  /** this machine is at its room cap — the same code can be joined elsewhere, so the
   *  client should offer a different region rather than just reporting a failure */
  | 'region_full'
  /** the single-game lock refused this join: the account is already in a match somewhere.
   *  The client can act on it — rejoin that game or leave it — so it is worth a code
   *  instead of a screen that only reads the sentence back. Older servers send no code,
   *  so a handler must still recognise the message (see `RecordRun`). */
  | 'active_game';

export type ServerMsg =
  | { t: 'welcome'; clientId: string }
  | { t: 'roster'; players: LobbyPlayer[]; hostId: string }
  /**
   * THE ROOM IS A LOBBY AGAIN — tear down the match view and show the roster.
   *
   * Sent to every member when the host recycles a finished room. A `roster` follows
   * immediately, so the client that adopts the socket back into a `LobbyClient` has
   * the players without asking for them. `clientId` is re-sent because the adopting
   * lobby never sends a `join` (it is already in the room) and so never gets a
   * `welcome` of its own.
   *
   * Gated on the 'recycle' capability: the room only offers this when EVERY member
   * advertises it, because a client that ignores this message would sit on a dead
   * results screen while the room restarted around it.
   */
  | { t: 'lobby'; clientId: string }
  /**
   * `message` is human-readable and every client since the first build shows it.
   *
   * `code` is OPTIONAL and machine-readable, added so the connection HUD can tell
   * "this region is at capacity, try another" apart from the dozen other things that
   * produce an error string. Adding an optional field to an existing message is the
   * cheapest kind of protocol change: an older client destructures `message` and is
   * completely unaffected, so this needs no `CLIENT_CAPS` gate. Keep it that way —
   * `message` must stay self-sufficient, never "see code".
   */
  | { t: 'error'; message: string; code?: ErrorCode }
  // reply to a 'rejoin': ok ⇒ slot reclaimed (a snapshot follows); !ok ⇒ the
  // grace window lapsed / slot is gone, stop trying
  /**
   * ⚠️ `gen` IS THE MATCH GENERATION THE ROOM IS ON, AND A REJOIN THAT DOES NOT ADOPT IT
   * IS A ROBOT THAT DOES NOT MOVE.
   *
   * The server drops any `input` stamped with a stale generation (see `matchStart.gen`),
   * and a client that came back through the Home rejoin card rebuilds its session from a
   * SAVED `matchStart` — which may be a generation behind, or may never have carried one.
   * So the reply that hands the slot back also states which match the slot is in. Optional
   * and additive: an older server sends none and the client keeps what it had.
   */
  | { t: 'rejoined'; ok: boolean; gen?: number }
  /** a `report` was accepted (or was a duplicate, which is reported the same way — the
   *  reporter does not need to know which, and telling them would leak prior reports) */
  | { t: 'reported'; ok: boolean }
  /**
   * A staged RANKED pairing died before it started, and this is what it cost.
   *
   * Sent to every still-connected member — including the innocent, whose `yours` is null.
   * That is deliberate: being told "the match was cancelled and you were not charged" is the
   * difference between a system that looks arbitrary and one that looks fair, and it is the
   * only moment the game can say so. Optional on the wire, so an older client simply shows
   * the plain cancellation error it always did.
   */
  | { t: 'dodgeVerdict'; message: string; yours: DodgeVerdict | null; others: DodgeVerdict[] }
  /**
   * The ranked queue is CLOSED to this account: their account standing has fallen far
   * enough to carry a cooldown (see `src/standing.ts`).
   *
   * Its own message rather than an `error` string, because a lock is a state with a CLOCK —
   * the client counts it down and reopens the button by itself, instead of showing a
   * sentence that is wrong thirty seconds later. Gated on the client's `standing` cap:
   * a build that would not know what to do with it gets the plain error instead.
   */
  | { t: 'standingLock'; until: number; score: number; tier: StandingTierKey }
  // `ranked` + `intros` are present only for ranked matchmaking rooms; they
  // drive the pre-match intro overlay (ELO reveal). Optional so custom rooms and
  // older servers omit them and the client simply shows no intro.
  | {
      t: 'matchStart';
      seed: number;
      setups: RobotSetup[];
      yourRobotId: number;
      /** which game to build the world for. Absent ⇒ 'decode' (old servers); the
       * client also falls back to the first snapshot's `world.game`. */
      game?: GameId;
      /**
       * WHICH PHYSICS THE ROOM'S WORLD RUNS ON (`RoomConfig.physics`). Absent ⇒ `'2d'` — an
       * older server, or any room that is not a 3D one.
       *
       * The client must build its predicted world with THIS, not with its own settings: it is
       * the only thing in the handshake that says which pipeline the authoritative loop is
       * stepping. A joiner or a reconnecting client that missed it can also read
       * `world.biobuzz.physics` off the first keyframe, which is why the tag rides the world
       * bag as well — two independent ways to learn one fact, because a spectator arriving
       * mid-match gets `matchStart` and a snapshot in the same breath.
       */
      physics?: Physics;
      ranked?: boolean;
      intros?: PlayerIntro[];
      /**
       * WHO IS IN THE SEATS — one entry per robot the room could name (see `MatchDriver`).
       * The in-match label reads this and falls back to `spec.name` for a robot it does not
       * cover. Absent from an older server, and absent for a room with nobody seated.
       */
      drivers?: MatchDriver[];
      /**
       * MATCH GENERATION — bumped every time this room authors a world, so a
       * rematch is distinguishable from the run it replaced.
       *
       * A restart rebuilds at tick 0, which means inputs still in flight from the
       * OLD match carry tick numbers the new one will reach a couple of minutes
       * later. Without a generation the server would buffer them and then apply
       * them as though they were current. The client echoes this on every `input`;
       * the server drops anything stamped with a stale one. Absent ⇒ 0.
       */
      gen?: number;
      /** the Fly region actually hosting this match (e.g. 'iad'). The client shows
       * it in the HUD so a player always knows which server they were matched on.
       * Absent from older servers ⇒ the client falls back to the room-code prefix
       * or the picked server label. */
      region?: string;
    }
  // authoritative world at `serverTick`, slimmed (spec-stripped robots) with the
  // balls delta-encoded; the client reassembles a full World via `unslimWorld`.
  // `cmds[i]` is the command robot `w.robots[i]` ran this tick — the client holds
  // it to PREDICT that robot forward (so remote collisions are actually simulated,
  // not faked at render time). `ackInputTick` is the newest input tick from THIS
  // client the server folded in (diagnostic — the client reconciles off `serverTick`).
  | {
      t: 'snapshot';
      serverTick: number;
      w: SlimWorld;
      balls: BallDelta;
      cmds: QCommand[];
      ackInputTick: number;
    }
  // matchmaking status: how many are queued for your bucket + how many are needed
  | { t: 'queued'; mode: QueueMode; size: number; need: number }
  // ranked match found: the matchmaker picked a fair host region and staged the
  // roster (in Postgres). The client must DROP this matchmaker connection and open a
  // new one to `?room=<room>` (fly-replay routes it to `hostRegion`), where the host
  // machine builds the authoritative match and sends `matchStart`. `room` is already
  // region-coded (`<hostRegion>-<code>`).
  | { t: 'matchAssigned'; mode: QueueMode; room: string; hostRegion: string }
  // ranked pre-match STRATEGY phase (server-authoritative rooms only): every paired
  // player has connected, so instead of starting immediately the room opens a
  // coordination window. The client switches to the strategy screen; live changes
  // (re-pick spec / claim a start pose / ready) flow through the existing
  // `update`/`roster` messages (the roster is REDACTED per-recipient so opponents
  // show name/team/ELO only). The match begins (a `matchStart` follows) once every
  // player readies, or the room CANCELS (an `error`) if not everyone readies by
  // `deadline` (epoch ms). `yourRobotId` = this client's roster slot; `intros`
  // carry per-slot ELO for the opponent/teammate cards.
  //
  // A CUSTOM ROOM OPENS THE SAME WINDOW, with `ranked: false` (2026-09-22). Its job there is
  // narrower: the drivers have already readied and the host has already pressed START, so it
  // is purely the waiting room for the 3D chunks (`READY3D_CAP`) and it closes the moment the
  // last seat reports in. No ELO travels — there is none — so the screen hides that column,
  // and the roster is NOT redacted (a custom lobby shows every build, and did before START).
  // ABSENT ⇒ ranked, which is what every `strategyStart` before this one was.
  | {
      t: 'strategyStart';
      deadline: number;
      yourRobotId: number;
      mode: QueueMode;
      intros: PlayerIntro[];
      game?: GameId;
      ranked?: boolean;
    }
  // a robot left: the server runs it on ZERO from `tick`; snapshots already
  // reflect this, so it is informational (drives the HUD)
  | { t: 'drop'; robotId: number; tick: number }
  // how many people are watching, as PLAYERS are told it (hidden admin observers
  // are not in this number — see Room.visibleSpectators). Edge-triggered on change,
  // deliberately NOT on the snapshot path: it moves a handful of times a match and
  // has no business riding a 30 Hz hot loop.
  | { t: 'spectators'; n: number }
  // duo-record rematch tally. `you` is whether THIS client's vote is currently in,
  // so the button can render pressed/unpressed without tracking it optimistically.
  | { t: 'rematch'; votes: number; need: number; you: boolean }
  // the match reached phase 'post': the SERVER's authoritative final score + the
  // full deterministic replay it recorded (input log). The server persists this
  // to the leaderboard (Phase 3 DB); clients render the results screen + can
  // replay it. `kind`/`record` say which board it belongs to.
  | {
      t: 'matchResult';
      kind: RoomKind;
      record?: RecordKind;
      result: ReplayResult;
      replay: Replay;
    }
  /**
   * THE MATCH ID, TO THE HOST ALONE. Sent immediately BEFORE the `matchResult` broadcast, on
   * the host's socket only, and to nobody else in the room.
   *
   * It is a globally unique id for the match just finished, minted by whichever server ran it,
   * and it exists for the self-hosted case (`docs/lan-selfhost.md`): a LAN match is uploaded to
   * the cloud by a CLIENT rather than written by the server that ran it, and without a stable
   * id the cloud cannot tell a re-upload from a second match. It is `UNIQUE` in `lan_runs`, so
   * the upload is idempotent and a retry after a flaky connection is free.
   *
   * ⚠️ **IT USED TO RIDE `matchResult`, WHICH IS A BROADCAST, AND THAT WAS THE BUG.** The
   * cloud has no way to know who really hosted a self-hosted match — it was not there. All it
   * can check is that the uploader signed in and named a match id. So possession of the id IS
   * the right to file the match, and broadcasting it handed that right to all four drivers and
   * every spectator: whoever posted first took the row, under THEIR account, and the actual
   * host's upload was then answered with somebody else's match. Sending it to one socket is
   * what makes "the host uploads" a fact about the protocol rather than a convention the
   * clients are trusted to keep.
   *
   * It arrives BEFORE `matchResult` on the same ordered socket, so the session has it in hand
   * by the time the result callback runs. The cloud checks ownership as well (`/api/lan`
   * answers 409 to anyone claiming a match another host already filed), because a capability
   * on the wire and a check at the table are protections against different mistakes.
   */
  | { t: 'matchArchive'; matchId: string }
  // ranked only: each driver's overall-ELO change, sent shortly after matchResult
  // once the match is scored + persisted (async DB write). Drives the results
  // screen's ELO reveal. Absent for custom/anonymous/DB-off matches.
  | { t: 'eloResult'; results: EloDelta[] }
  // record runs only: the run's standing on the leaderboard (its mode×drivetrain×
  // season bucket), sent shortly after matchResult once persisted. Drives the solo
  // results screen's PB / WR / rank line. Absent for anonymous/DB-off runs.
  | { t: 'recordResult'; info: RecordRankInfo }
  // an admin broadcast to EVERY connected client: a scheduled server restart (with
  // a countdown to `until`, epoch ms) or a general info message. Shown as a banner
  // so players aren't caught off guard by a restart mid-session.
  | { t: 'serverNotice'; kind: 'restart' | 'info'; message: string; until?: number }
  // echo of a client `ping` (same `ts`); the client computes RTT = now − ts
  | { t: 'pong'; ts: number }
  /* ── LAN SIGNALLING ── the replies to the four client messages above. */
  // the code is yours; `hostId` is the peer id guests will address their offers to
  | { t: 'lanHosting'; code: string; hostId: string }
  // (to the HOST) a guest asked to be introduced, and may now be signalled
  | { t: 'lanPeer'; peer: string }
  // a peer left. To a guest this names the HOST, and means the room is gone — the
  // authoritative room lived in that tab, so its closing ended the match.
  | { t: 'lanPeerGone'; peer: string }
  // (to a GUEST) the introduction worked; `hostId` is who to send the offer to
  | { t: 'lanJoined'; code: string; hostId: string }
  // one forwarded blob, verbatim, from `peer`
  | { t: 'lanSignal'; peer: string; data: string }
  /* a signalling request was refused. SEPARATE FROM `error` on purpose: `error` is rendered
   * as a lobby-level failure that tears the screen down, and "that code isn't hosting" is a
   * thing the player retypes rather than a thing that ends their session. */
  /* `closed` is the deployment saying the rendezvous is not switched on here at all
     (server/lanUploads.ts `LAN_SIGNALLING`), which is a different thing from every other
     reason in this union: the others are about this request, that one is about the server. */
  | {
      t: 'lanError';
      reason: 'badcode' | 'taken' | 'busy' | 'auth' | 'nohost' | 'full' | 'toobig' | 'nopeer' | 'closed';
      message: string;
    };

/** a finished record run's leaderboard standing (its mode×drivetrain×season
 * bucket). `score` is the NET score (earned − own penalties). */
export interface RecordRankInfo {
  mode: RecordKind;
  drivetrain: string;
  score: number;
  rank: number; // 1-based position in the bucket
  total: number; // number of ranked players in the bucket
  isPB: boolean; // this run beat the player's previous best in the bucket
  isWR: boolean; // rank === 1
}

export const encodeMsg = (m: ClientMsg | ServerMsg): string => JSON.stringify(m);
export const decodeClientMsg = (s: string): ClientMsg => JSON.parse(s) as ClientMsg;
export const decodeServerMsg = (s: string): ServerMsg => JSON.parse(s) as ServerMsg;

// ---- snapshot slimming + ball delta -----------------------------------------

/**
 * Wire snapshots drop bandwidth two ways without any determinism risk:
 *  1. STRIP the static `spec` from each robot — it never changes after
 *     matchStart, so the client re-injects it from `setups` (worldHash ignores
 *     spec, so parity is unaffected).
 *  2. DELTA the balls — send the authoritative id ORDER every frame (cheap, a
 *     few dozen ints) but only the DATA for balls that changed since the last
 *     snapshot. The client rebuilds the array in the sent order from its
 *     baseline, so it is byte-identical to the server's `world.balls`.
 *
 * Sending the order every frame is what keeps it deterministic: array position
 * drives collision/scoring iteration + `worldHash`, so it must match exactly.
 *
 * "Since the last snapshot" is the server's choice of BASELINE, not a property of
 * the format: `upd` always carries each listed ball's CURRENT data, so a delta cut
 * against any older baseline the client genuinely holds is equally correct, just
 * larger. That is what the lossy WebRTC lane uses — over the reliable+ordered
 * WebSocket the baseline is simply the previous snapshot, and a reconnect re-primes
 * with a full keyframe. See `broadcastSnapshot` in server/room.ts.
 */
export type SlimWorld = Omit<World, 'balls' | 'robots'> & {
  robots: Omit<RobotState, 'spec'>[];
};

/** the authoritative ball id ORDER + full data for only the changed balls */
export interface BallDelta {
  order: number[];
  upd: Artifact[];
}

function stripSpec(r: RobotState): Omit<RobotState, 'spec'> {
  const c: Partial<RobotState> = { ...r };
  delete c.spec;
  return c as Omit<RobotState, 'spec'>;
}

/** world for the wire: balls removed, robots stripped of their static spec */
export function slimWorld(world: World): SlimWorld {
  const { robots, ...rest } = world; // `rest` still carries balls
  const slim = { ...rest, robots: robots.map(stripSpec) };
  delete (slim as { balls?: unknown }).balls;
  return slim as SlimWorld;
}

/** finite number or a fallback — guards against a field that arrived undefined
 * (an older server never sent it) or as `null` (JSON serializes NaN/Infinity to
 * null). Bare arithmetic on either poisons the sim to NaN. */
const finiteOr = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/**
 * BACKWARD-COMPAT SHIM: the shared `src/sim` grows new per-tick RobotState fields
 * over time (e.g. the power-draw model added `flywheelSpin` / `flywheelSpinRate` /
 * `powerDraw`). ONE Fly app serves every client version, so a NEWER client can
 * receive a snapshot from an OLDER server whose RobotState predates those fields —
 * they arrive `undefined`. The newer client's `step()` then does
 * `POWER_DRAW_FLYWHEEL_HOLD * undefined` → NaN, which propagates into the drive
 * params and blows the robot's position to NaN (it renders at the camera origin /
 * field centre and freezes). Re-seed any missing/non-finite dynamic field to a
 * sane value (mirrors `createWorld`'s spawn seeding) so an old→new skew degrades
 * gracefully instead of NaN-ing. Harmless when the server DOES send them.
 */
function backfillRobot(r: RobotState): RobotState {
  return {
    ...r,
    // flywheel spin is DERIVED from distance to the robot's own goal; seed it at
    // the position target (like spawn) so there's no phantom spin-up spike.
    flywheelSpin: finiteOr(r.flywheelSpin, flywheelSpinTarget(r.alliance, r.pos)),
    flywheelSpinRate: finiteOr(r.flywheelSpinRate, 0),
    powerDraw: finiteOr(r.powerDraw, 0),
    moduleAngles:
      Array.isArray(r.moduleAngles) && r.moduleAngles.length === 4
        ? r.moduleAngles.map((a) => finiteOr(a, 0))
        : [0, 0, 0, 0],
    moduleTargets:
      Array.isArray(r.moduleTargets) && r.moduleTargets.length === 4
        ? r.moduleTargets.map((a) => finiteOr(a, 0))
        : [0, 0, 0, 0],
  };
}

/**
 * Ball-delta codec — ONE tested encode/decode pair used by both ends so the
 * server's encoder and the client's decoder can never silently drift apart.
 *
 * `encodeBallDelta` diffs the live balls against a `baseline` (id → the ball the
 * client is known to hold); `applyBallDelta` reconstructs the array from a running
 * baseline the client mutates in place. The `order` (every id, every frame) is what
 * keeps it deterministic — array position drives collision/scoring iteration and
 * `worldHash`, so it must match the server exactly. A `null` baseline (or one that
 * has been reset) yields a full KEYFRAME (`upd` == every ball).
 *
 * The reconstruction is baseline-agnostic in a way the unreliable lane relies on:
 * any ball NOT in `upd` is, by construction, byte-identical between the baseline
 * and now, so a client holding ANY intermediate state for it rebuilds correctly —
 * which is why a delta keyed to an older ACKed baseline survives a dropped frame.
 */
export function encodeBallDelta(
  baseline: Map<number, Artifact> | null,
  balls: Artifact[],
): BallDelta {
  const order = balls.map((b) => b.id);
  if (!baseline) return { order, upd: balls.slice() };
  const upd: Artifact[] = [];
  for (const b of balls) {
    const prev = baseline.get(b.id);
    if (prev === undefined || JSON.stringify(prev) !== JSON.stringify(b)) upd.push(b);
  }
  return { order, upd };
}

/** Reconstruct the ball array from a running `baseline` (MUTATED in place: patched
 * with `upd`, then pruned to exactly `order`). Byte-identical to the server's
 * `world.balls`. Returns the rebuilt array in the authoritative order.
 *
 * ⚠️ THE RETURNED BALLS ARE COPIES, AND THAT IS THE WHOLE POINT: nothing the caller
 * holds is in the baseline. The sim mutates artifacts IN PLACE every tick (`b.pos.x`,
 * `st.v`/`st.s`/`state.pending` on the rail, `st.lx`/`st.ly` on a held ball), so
 * handing out the baseline's own objects corrupted the diff baseline as the client
 * stepped — a ball the server then did NOT re-send rebuilt from the client's own
 * drifted value and stayed wrong for as long as it sat still. `state` is a nested
 * object too, hence FOUR spreads; every `BallState` member is flat scalars, so a
 * shallow spread of each is total. */
export function applyBallDelta(baseline: Map<number, Artifact>, delta: BallDelta): Artifact[] {
  for (const b of delta.upd) baseline.set(b.id, b);
  const keep = new Set(delta.order);
  for (const id of baseline.keys()) if (!keep.has(id)) baseline.delete(id);
  return delta.order
    .map((id) => baseline.get(id))
    .filter((b): b is Artifact => b !== undefined)
    .map((b) => ({
      ...b,
      pos: { ...b.pos },
      vel: { ...b.vel },
      state: { ...b.state } as BallState,
    }));
}

/** rebuild a full World from a slim world + reconstructed ball array, re-injecting
 * each robot's spec by id (and back-filling any dynamic fields an older server
 * omitted — see `backfillRobot`) */
export function unslimWorld(
  w: SlimWorld,
  balls: Artifact[],
  specById: (id: number) => RobotSpec,
): World {
  return {
    ...w,
    // old servers omit `game`; default it so gameOf/moduleFor resolve to DECODE
    game: w.game ?? 'decode',
    robots: w.robots.map((r) => backfillRobot({ ...r, spec: specById(r.id) })),
    balls,
  };
}