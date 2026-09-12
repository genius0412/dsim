import { WebSocketServer, WebSocket } from 'ws';
import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import v8 from 'node:v8';
import { Room, type Client } from './room';
import { decodeClientMsg, encodeMsg, DEFAULT_ROOM_CONFIG, RATED_FORMATS, SERVER_CAPS, type ClientMsg, type LiveRoom, type RoomConfig, type ServerMsg } from '../src/net/protocol';
import { sanitizePlayer } from '../src/net/sanitize';
import { verifyAuthToken } from './auth';
import { initPhysics } from '../src/sim/physicsEngine';
import { migrate } from './db/migrate';
import { persistMatch, persistDodges } from './persist';
import { routeTarget } from './routing';
import { SERVER_CHANNEL, isAlphaServer } from './channel';
import { LAN_MODE, enforceLanPolicy } from './lanMode';
import { chargeStanding, rankedLock } from './standing';
import { lockRemaining, tierOf,
  STANDING_MAX,
} from '../src/standing';
import { isReportReason, REPORT_DETAIL_MAX } from '../src/report';
import { handleApi } from './api';
import { serveClient, servingClient } from './static';
import { Matchmaker } from './matchmaking';
import { MATCHMAKER_REGION } from './regions';
import { BALANCE_VERSION } from '../src/config';
import { periodLabel } from '../src/seasons';
import { dbEnabled } from './db/pool';
import {
  currentSeasonNumber,
  purgeSeasonReplays,
  startNewSeason,
  takePendingMatch,
  createPendingMatch,
  cleanupStalePending,
  adminListRecords,
  deleteRecordById,
  deleteUserRecords,
  searchProfiles,
  setHandle,
  getProfile,
  getSupporter,
  grantSupporter,
  revokeSupporter,
  refundKofiPayment,
  listSupporterGrants,
  createAnnouncement,
  deleteAnnouncement,
  upsertPresence,
  globalPresence,
  globalLiveRooms,
  adminPresence,
  recentMatches,
  submitReport,
  distinctReporters,
  getStanding,
  listStandingEvents,
  standingsFor,
  listReportedUsers,
  listReportsFor,
  listScoreReports,
  resolveScoreReport,
  submitScoreReport,
  setReportsStatus,
  userRecentMatches,
  getMaintenance,
  setMaintenance,
  maintenanceBiting,
  type PresencePlayer,
  type PresenceAnon,
  type PresenceGuest,
  type MaintenanceWindow,
  challengeParty,
  syncStaffRoles,
  type GlobalPresence,
} from './db/repo';

/**
 * Authoritative DECODE game server (Phase 0). One WebSocket per client; rooms are
 * keyed by lowercased room code. The server imports the SHARED src/sim and runs
 * the match loop inside each Room (see room.ts). Lobby + match live on the same
 * connection, so there is no separate signaling service.
 *
 * Run: `npm run server` (tsx watch) or `npm run server:start`. Configure the
 * client with VITE_GAME_SERVER_URL=ws://localhost:8787. Deploy: see docs/deploy.md
 * (Fly.io). A plain GET /health returns 200 for the platform health check.
 */

/**
 * SELF-HOSTED (LAN) POLICY, DECIDED BEFORE ANYTHING READS THE ENVIRONMENT.
 *
 * `LAN_MODE=1` makes this process a LAN server in its own right rather than by virtue of how
 * it was launched: no database, no credentials, no admin surface. `SERVE_CLIENT` without it
 * refuses to boot. Both rules and the reasoning behind them are in `server/lanMode.ts`.
 *
 * It runs HERE, above the module constants below, because `ADMIN_USER_IDS` and `OWNER_USER_ID`
 * are read into `const`s a couple of hundred lines down and a scrub after that would scrub
 * nothing. `DATABASE_URL` and the JWKS are not on this clock at all — `db/pool.ts` and
 * `auth.ts` read `LAN_MODE` in their own module bodies, which run before this statement does.
 */
enforceLanPolicy();

const PORT = Number(process.env.PORT ?? 8787);
const rooms = new Map<string, Room>();

// Has this machine staged a ranked match whose row might still be sitting in
// `pending_matches`? Arms the reaper below; see the note on its interval for why
// an idle machine must not sweep on a timer.
let pendingStaged = false;
const matchmaker = new Matchmaker(
  dbEnabled
    ? {
        stage: async (m) => {
          pendingStaged = true;
          await createPendingMatch(m);
        },
      }
    : {},
);

// live presence, surfaced at GET /api/presence (polled by the client so the
// homepage/ranked screens can show who's around WITHOUT anyone holding a standing
// socket — a persistent presence connection from every visitor would keep the
// auto-stopping Fly machine awake 24/7 and defeat the idle-to-zero cost model).
// `online` = open sockets (people actually engaged with multiplayer; solo/free
// players never connect). `signedIn` = DISTINCT authenticated users (deduped by
// userId, so multiple tabs count once).
let onlineCount = 0;
const authedUsers = new Map<string, number>(); // userId -> live socket count
/** Publish this machine's presence row RIGHT NOW. Installed by the heartbeat below;
 *  a no-op until then (and in tests, which never start it). Called on the
 *  empty -> occupied edge so the first player of a quiet period is visible to the
 *  OTHER regions in milliseconds instead of on the next 5s tick. */
let beatNow: () => void = () => {};

// "one live game per user": userId -> code of the room whose MATCH they're currently
// in. Set by a room when its match begins (Room.onUserActive), cleared when their slot
// is released (finalize / grace-drop / room stop). A user with an entry here is refused
// a second join/queue elsewhere — they must rejoin or leave that game first. Reconnects
// (the `rejoin` message) bypass this, so returning to your OWN game always works.
const userRoom = new Map<string, string>();

/**
 * Every live socket on this machine, by its connection id, and whether it has
 * proven an account.
 *
 * Needed because an anonymous player who is just browsing belongs to no room and no
 * queue, so nothing else on the server knows they exist as an individual — only the
 * `onlineCount` integer does. The operator view lists guests row by row, and a row
 * needs something to BE. The id is this process's own per-socket routing id: not an
 * IP, not a fingerprint, deleted on close, and unrelated to the id the same person
 * gets if they reconnect.
 */
const liveSockets = new Map<string, { authed: boolean }>();

/**
 * MAINTENANCE LOCKDOWN, cached from the database.
 *
 * Read on a timer rather than per request: this is consulted on every join/queue,
 * and a database round trip on the hot path of starting a match would be a worse
 * problem than the one it solves. A few seconds of staleness is fine — the window
 * is announced minutes ahead, which is the entire point of scheduling it.
 *
 * Admins are exempt, deliberately: the person deploying has to be able to smoke-test
 * the thing they just shipped while everyone else is still held out.
 */
const MAINT_TTL_MS = 10_000;
let maint: MaintenanceWindow = { active: false, startsAt: null, endsAt: null, message: '' };
let maintAt = 0;
async function refreshMaintenance(force = false): Promise<MaintenanceWindow> {
  if (!dbEnabled) return maint;
  if (!force && Date.now() - maintAt < MAINT_TTL_MS) return maint;
  try {
    maint = await getMaintenance();
    maintAt = Date.now();
  } catch (e) {
    // a DB hiccup must not lock everyone out, nor silently unlock — keep the last
    // known answer and try again on the next tick
    console.error('[maintenance] read failed, keeping last known state:', e);
  }
  return maint;
}
/** is the lockdown biting for THIS caller? Admins always pass. */
function lockedOut(userId?: string | null): boolean {
  if (userId && ADMIN_IDS.has(userId)) return false;
  return maintenanceBiting(maint);
}
/** the message a locked-out client is shown */
function lockoutMessage(): string {
  const base = maint.message?.trim() || 'DSIM is down for maintenance.';
  if (!maint.endsAt) return `${base} Please try again shortly.`;
  const mins = Math.max(1, Math.round((maint.endsAt - Date.now()) / 60000));
  return `${base} Back in about ${mins} minute${mins === 1 ? '' : 's'}.`;
}
/** true if this user already has a LIVE match in a DIFFERENT room (stale entries whose
 * room has since vanished are pruned and treated as clear). */
const activeElsewhere = (userId: string, code: string): boolean => {
  const other = userRoom.get(userId);
  if (!other || other === code) return false;
  if (!rooms.has(other)) {
    userRoom.delete(userId);
    return false;
  }
  return true;
};

/**
 * "Play a friend", rated: turn the party token off the wire into a token the
 * matchmaker is allowed to trust — or refuse it.
 *
 * The token is a shared secret between two people who challenged each other, and
 * everything downstream treats entries sharing one as a pair that MUST be matched
 * together. So it cannot be taken on the client's word: without this check any two
 * clients could agree on a string and stage themselves a rated, leaderboard-moving
 * match having never been friends, never sent a challenge, and never had the other
 * person see anything. `challengeParty` resolves the token against the real
 * challenge row and only answers for an account actually named on it, which also
 * means a third client that GUESSES a live token still can't join the pair.
 *
 * Returns null for an ordinary open-queue entry (no token — the common case),
 * `'bad-token'` for one to reject, or the verified token to enqueue under.
 */
type VerifiedParty = { token: string; partyOnly: boolean } | null | 'bad-token';
async function verifyParty(
  userId: string,
  msg: Extract<ClientMsg, { t: 'queue' }>,
): Promise<VerifiedParty> {
  const token = typeof msg.party === 'string' ? msg.party.trim() : '';
  if (!token) return null;
  const format = typeof msg.partyFormat === 'string' ? msg.partyFormat : '';
  const spec = RATED_FORMATS[format];
  // the format decides the queue it belongs in, so a token issued for one must not
  // be spendable in the other
  if (!spec || spec.mode !== msg.mode) return 'bad-token';
  // no DB (local dev) ⇒ no challenges exist to verify against. Drop the party and
  // let them pair through the open queue, which on a single dev machine is the
  // same two people anyway.
  if (!dbEnabled) return null;
  const pair = await challengeParty(userId, token, format);
  if (!pair) return 'bad-token';
  return { token, partyOnly: spec.partyOnly };
}
/** a challenge is always exactly two people: the one who sent it and the one who
 * accepted. The matchmaker needs the number to know when the party is complete. */
const PARTY_SIZE = 2;

// accounts allowed to use the admin API (their auth-JWT `sub`/userId). Set as a
// Fly secret: ADMIN_USER_IDS="uuid1,uuid2". Empty => admin API is locked to nobody.
const ADMIN_LIST = (process.env.ADMIN_USER_IDS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const ADMIN_IDS = new Set(ADMIN_LIST);

/**
 * The OWNER — one account, badged apart from the admins it otherwise sits with.
 *
 * Defaults to the FIRST id in `ADMIN_USER_IDS` rather than requiring a second
 * secret, because that list has always been owner-first in practice and a feature
 * that silently does nothing until someone sets an env var they were never told
 * about is worse than a documented default. Set `OWNER_USER_ID` explicitly to
 * override it.
 *
 * Owner implies admin: the gate above is `ADMIN_IDS`, and the owner is in it.
 */
const OWNER_ID = (process.env.OWNER_USER_ID ?? '').trim() || ADMIN_LIST[0] || null;

// a pending admin notice (scheduled restart / info) broadcast to every client and
// re-sent to anyone who connects while it's still live, so late joiners see it too
let currentNotice: (ServerMsg & { t: 'serverNotice' }) | null = null;
const noticeLive = (): boolean =>
  !!currentNotice && (currentNotice.until === undefined || currentNotice.until > Date.now());

/** broadcast a message to EVERY open socket; returns how many got it */
function broadcastAll(m: ServerMsg): number {
  const payload = encodeMsg(m);
  let n = 0;
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      // same size rule as every other send — see COMPRESS_THRESHOLD. An admin notice is a
      // sentence; deflating it costs a threadpool round trip to save nothing.
      ws.send(payload, { compress: payload.length >= COMPRESS_THRESHOLD });
      n++;
    }
  }
  return n;
}

/** read a small request body (admin POSTs) with a hard cap so a bad client can't
 * exhaust memory. Rejects past 16KB — announcements are tiny. */
function readAdminBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 16 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// an explicit HTTP server so we can answer GET /health (Fly/Load-balancer probe)
// while the WebSocket upgrade rides the same port
const REGION = process.env.FLY_REGION ?? process.env.SERVER_REGION ?? '';

// ---- perf probe (GET /api/perf) ---------------------------------------------
// Sizing evidence. The question "can this machine run on a SHARED cpu?" is not
// answered by average cpu% — the room loop is a FIXED 60Hz step that must finish
// inside 16.67ms, and Fly throttles a shared machine to a small baseline once its
// burst credits drain. The symptom is then an event loop that stops turning: the
// /health probe misses its timeout and the machine flaps unhealthy (see fly.toml).
// So measure the thing that actually predicts that: EVENT LOOP DELAY, alongside
// cpu-seconds-per-second (= cores in use) and how many rooms produced that load.
// Read it repeatedly during real matches before changing any machine's cpu kind.
//
// RESOLUTION MUST STAY WELL UNDER THE 16.67ms STEP BUDGET. This was `resolution: 10`,
// which is the histogram's sampling period AND therefore its noise floor: a completely
// idle machine reported mean 10.18 / p99 11.2ms, and two machines in different regions
// on different CPU sizes returned identical numbers because the figure was measuring the
// timer, not the loop. That made the tuning rule this comment states — "p99 approaching
// 16.67ms means the loop is late" — impossible to apply: the floor was already 60% of
// the budget, so real lag and idle were indistinguishable. At 1ms an idle loop reads
// ~1ms and the number means what it claims to.
const loopDelay = monitorEventLoopDelay({ resolution: 1 });
loopDelay.enable();
/** ms epoch of the last `?reset=1` (or boot) — `max` is only meaningful relative to it */
let loopDelaySince = Date.now();
let cpuMark = process.cpuUsage();
let cpuMarkAt = process.hrtime.bigint();
/** cores in use since the previous call — sampling resets the window */
function coresInUse(): number {
  const now = process.hrtime.bigint();
  const d = process.cpuUsage(cpuMark);
  const elapsedUs = Number(now - cpuMarkAt) / 1000;
  cpuMark = process.cpuUsage();
  cpuMarkAt = now;
  if (elapsedUs <= 0) return 0;
  return (d.user + d.system) / elapsedUs;
}
// stable per-machine id for the shared presence table (unique per Fly machine)
const MACHINE = process.env.FLY_MACHINE_ID || REGION || 'local';

/**
 * ADMISSION CONTROL — the maximum number of rooms this machine will HOST.
 *
 * There was no limit at all: every `join` for an unknown code created a room, so a
 * busy region did not degrade, it collapsed — and it collapsed for everyone already
 * playing on that machine, not just for the arrival that tipped it over. That is the
 * worst possible failure shape, because the server has no back pressure of its own:
 * past saturation `Room.startLoop` SHEDS simulation time rather than consuming more
 * CPU (it caps catch-up at 8 ticks and clamps the accumulator at 0.25 s), so the
 * machine never looks overloaded on CPU while every match on it stutters. Measured:
 * `cores` flat at 0.80-0.89 from 8 rooms to 48 while the snapshot gap p50 went 35 ms
 * to 248 ms (docs/capacity.md §0).
 *
 * Refusing the 25th room is a bad experience for one person. Accepting it is a bad
 * experience for everyone in the other 24.
 *
 * ⚠️ THE CAP IS A ROOM COUNT, NOT A LOAD READING, AND THAT IS DELIBERATE FOR NOW.
 * Event-loop lag is the honest saturation signal and `/api/perf` already reports it,
 * but `loopDelay` is a since-reset histogram whose percentiles move too slowly to
 * admit or refuse a single connection on, and `coresInUse()` cannot be called here at
 * all — it RESETS its sampling window, so polling it would corrupt the figure
 * `/api/perf` reports. A lag-driven cap is the follow-up once there are real Linux
 * numbers to calibrate against (see docs/capacity.md §0: none of the latency
 * thresholds are measurable on the Windows dev box).
 *
 * 24 is deliberately well ABOVE the measured redline (~13 driven DECODE rooms per
 * core, ~10 with margin) rather than at it. This is a runaway guard, not a tuning
 * knob: set it near the redline and a machine refuses players while it still has
 * headroom for the many rooms that are parked rather than actively driven, which cost
 * 0.031 cores instead of 0.075.
 *
 * 0 disables the cap. Off by default OFF Fly, because the load harness routinely runs
 * 48-room sweeps against a local server and a cap would silently truncate them.
 */
const MAX_ROOMS = ((): number => {
  const raw = process.env.MAX_ROOMS;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return REGION ? 24 : 0;
})();

/**
 * SPECTATOR ADMISSION — the cap `MAX_ROOMS` does not provide.
 *
 * `MAX_ROOMS` bounds how many matches a machine SIMULATES; nothing bounded how many people
 * WATCH one. A spectator takes the same 30 Hz snapshot stream a driver takes, and the
 * `spectate` path reaches it without a room slot, without a room cap (the room already
 * exists, so the admission check above never runs) and without signing in — so one shared
 * link was an unbounded fan-out on a machine whose whole capacity model is per-room.
 * Egress, not compute, is the cliff (docs/capacity.md §5), and audience is pure egress.
 *
 * TWO caps because they fail differently. The per-room one is the realistic shape — one
 * match everybody wants to see — and refusing there costs nobody else anything. The
 * machine-wide one is what the event loop actually pays, across every room at once.
 *
 * The numbers are deliberately generous rather than measured: 24 is a full match's worth of
 * teams watching one room, and 192 is eight such rooms, which is already more audience than
 * `MAX_ROOMS` worth of DECODE rooms can produce drivers. They are runaway guards in exactly
 * the sense `MAX_ROOMS` is (see its note above) — set from what a crowd plausibly looks
 * like, not from a measured redline, because there is no Linux measurement of spectator cost
 * to set one from. Both are env-overridable and `0` disables, same convention as MAX_ROOMS.
 *
 * ⚠️ A HIDDEN ADMIN OBSERVER COUNTS. `Room.spectatorCount()` is deliberately the total and
 * not `visibleSpectators()`: the JWT that would identify an admin is verified asynchronously
 * AFTER attach (so a slow verify never costs them the start of a match), so there is nothing
 * to exempt them on at admission time — and a cap that could be bypassed by not being
 * displayed would not be a cap. With these values an admin is only ever refused on a room
 * that is already carrying two dozen watchers.
 */
const spectatorCap = (name: string, dflt: number): number => {
  const raw = process.env[name];
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n) || Infinity;
  }
  return dflt;
};
const MAX_SPECTATORS_PER_ROOM = spectatorCap('MAX_SPECTATORS_PER_ROOM', 24);
const MAX_SPECTATORS = spectatorCap('MAX_SPECTATORS', 192);
/** attached spectators across every room on this machine (see the caps above) */
let spectatorTotal = 0;

/**
 * INBOUND MESSAGE RATE, per socket, per second.
 *
 * The future-tick cap bounds what one ROBOT can buffer; nothing bounded how fast a socket
 * could make this process parse. Every frame costs a `JSON.parse` on the event loop that
 * runs every room in the region, and the `spectate`/`rejoin`/`report` branches each do real
 * work, so a single socket spinning messages is a whole-region denial of service that no
 * per-room guard can see.
 *
 * 240/s is 4× what a legitimate client produces: `input` at 60 Hz plus a `ping` a second and
 * the occasional `update`. A client that exceeds it is dropped-message-throttled rather than
 * disconnected, because the honest way to exceed it a little is a burst after a stall, and
 * hanging up on a reconnecting player is a worse outcome than losing a frame of input they
 * will re-send 16 ms later. A socket past `MSG_RATE_KILL` in one second is not a client with
 * a hiccup and is closed outright (1008), which runs the normal detach + reconnect grace.
 *
 * The window is a plain 1-second bucket, not a sliding one: it is a guard rail, and a
 * sliding window costs per-message bookkeeping on the hottest path in the process.
 */
const MSG_RATE_LIMIT = 240;
const MSG_RATE_KILL = 2000;

/**
 * GET /api/presence aggregates presence across ALL regions' machines (each machine
 * only knows its own sockets). This is the most-called endpoint on the site — every
 * open tab polls it every 8s for the online chip and every 20s for the admin-notice
 * banner — so it is throttled by a shared cache rather than run per request.
 *
 * THE ANSWER IS ALWAYS REAL. An earlier pass had an idle machine skip the query and
 * report zeros, on the theory that "no sockets here" meant "nobody anywhere". It
 * does not, and the failure was ugly: a visitor got a confident "0 online", and the
 * instant anything made that machine briefly non-idle the real count appeared and
 * then snapped back to the fake zero. A counter that flickers 0 -> 1 -> 0 reads as
 * broken, and greeting the first person through the door with "0 online" is a worse
 * outcome than any amount of compute. Never fabricate this number.
 *
 * The cost lever is the CACHE TTL instead, and the reason that is enough:
 *
 *   Someone with the page open IS a user, and keeping the database awake while a
 *   human is looking at the site is fine. What was never fine was staying awake
 *   when NOBODY was there — and that traffic came from the unconditional 5s
 *   heartbeat (now activity-gated) and from hidden background tabs (now paused in
 *   usePresence/NoticePoller). With those two gone, a site with nobody on it makes
 *   no queries at all and the compute suspends; a site with one person browsing
 *   costs about one query a minute, which is the correct thing to pay for.
 *
 * So: a long TTL when this machine is idle (one visitor's whole polling stream
 * collapses onto ~1 query/min), a short one when it is busy or when `?full=1` asks
 * for freshness — the ranked screen, where queue depth is a number people act on.
 */
const PRESENCE_TTL_BUSY_MS = 7_000;
/** Only when the world looks EMPTY and this machine is empty too. Halved from 45s
 *  once `globalPresence` became a single query — the cost of a refresh dropped, so
 *  the staleness budget could too. This is the worst-case delay before an idle
 *  machine notices the first player joining somewhere else. */
const PRESENCE_TTL_QUIET_MS = 20_000;
let presenceCache: { at: number; val: GlobalPresence } | null = null;
function machineIdle(): boolean {
  const qs = matchmaker.queueSizes();
  return onlineCount === 0 && authedUsers.size === 0 && qs['1v1'] === 0 && qs['2v2'] === 0;
}

/**
 * This machine's OWN live counts, as a FLOOR under the database's answer.
 *
 * The aggregate is assembled from rows every machine writes about itself, so between
 * a socket opening here and this machine's row landing in Postgres, the query
 * genuinely returns a total that does not include a player this process is holding a
 * socket to. Measured against production: a real client connected, and /api/presence
 * answered `online: 0` for ~8s afterwards — from the very machine serving that
 * socket. It knew, and said zero anyway.
 *
 * `max` per field, applied at RESPONSE time and never folded into the cache: the
 * cached value stays the pure database answer, so this can never outlive the socket
 * it describes. It cannot over-count either — a fresh row for this machine is already
 * in the sum, and the max is then a no-op.
 */
function withLocal(v: GlobalPresence): GlobalPresence {
  const qs = matchmaker.queueSizes();
  const byGame = matchmaker.queueSizesByGame();
  // same max-per-field rule, applied per game: this machine's own queue is already
  // in the aggregate once its beat lands, so the max is a no-op then and a floor
  // in the window before it
  const gameQueues: Record<string, { '1v1': number; '2v2': number }> = {};
  for (const g of new Set([...Object.keys(v.gameQueues ?? {}), ...Object.keys(byGame)])) {
    const a = v.gameQueues?.[g] ?? { '1v1': 0, '2v2': 0 };
    const b = byGame[g] ?? { '1v1': 0, '2v2': 0 };
    gameQueues[g] = { '1v1': Math.max(a['1v1'], b['1v1']), '2v2': Math.max(a['2v2'], b['2v2']) };
  }
  return {
    online: Math.max(v.online, onlineCount),
    signedIn: Math.max(v.signedIn, authedUsers.size),
    queues: {
      '1v1': Math.max(v.queues['1v1'], qs['1v1']),
      '2v2': Math.max(v.queues['2v2'], qs['2v2']),
    },
    gameQueues,
  };
}

/** How long the cached DB answer may be reused. The long TTL is for ONE case — a
 *  quiet machine on an apparently quiet site — because that is the only case where
 *  nobody is waiting on the number. If anyone is online ANYWHERE, the site is in use
 *  and the count is worth keeping honest. */
function presenceTtl(full: boolean): number {
  if (full || !machineIdle()) return PRESENCE_TTL_BUSY_MS;
  if (presenceCache && presenceCache.val.online > 0) return PRESENCE_TTL_BUSY_MS;
  return PRESENCE_TTL_QUIET_MS;
}

/**
 * This machine's operator snapshot: what every connected session is doing.
 *
 * Assembled entirely from state the server already holds to run matches — room
 * membership, queue membership, the socket registry. Nothing is asked of any client
 * to build it, and there is still no field for which SCREEN anybody is on: knowing
 * a player is "in Configure" moderates nothing, and collecting it would be tracking
 * for its own sake. `menu` means "connected, not in a room, not queued", the same
 * resolution a player's own friends already see.
 *
 * GUESTS ARE LISTED INDIVIDUALLY, by the server's per-socket connection id. That is
 * a deliberate change from counting them: an operator asking "is that session idle
 * or stuck in a lobby" cannot answer it from a total. The id is not an IP, not a
 * fingerprint, is written nowhere else, and dies with the socket — it distinguishes
 * two live sessions from each other and cannot connect either to a past one. The
 * privacy policy says exactly this; if this widens, that text moves with it.
 */
function operatorSnapshot(): {
  players: PresencePlayer[];
  guests: PresenceGuest[];
  anon: PresenceAnon;
} {
  const byUser = new Map<string, PresencePlayer>();
  const byGuest = new Map<string, PresenceGuest>();
  for (const [code, r] of rooms) {
    const s = r.presenceSnapshot();
    for (const p of s.players) byUser.set(p.userId, { userId: p.userId, act: p.act, room: code, game: r.gameId });
    for (const g of s.guests) byGuest.set(g.id, { id: g.id, act: g.act, room: code, game: r.gameId });
  }
  // queue membership layers ON TOP of where they are: the whole point of the
  // background queue is that you can be queued while doing something else, and an
  // operator debugging "my search never resolved" needs to see both at once.
  // `queueGame` is kept SEPARATE from `game` because they can differ — you can be
  // queued for Chain Reaction while sitting in a DECODE practice room, and an
  // operator who is shown only one of those is being told a half-truth.
  for (const q of matchmaker.queuedPlayers()) {
    const cur = byUser.get(q.userId);
    byUser.set(q.userId, {
      ...(cur ?? { userId: q.userId, act: 'menu' as const }),
      queue: q.mode,
      queuedS: q.waitedS,
      queueGame: q.game,
      game: cur?.game ?? q.game,
    });
  }
  // signed in and connected but in neither a room nor a queue
  for (const uid of authedUsers.keys()) {
    if (!byUser.has(uid)) byUser.set(uid, { userId: uid, act: 'menu' });
  }
  // stamp each account's SOCKET count so the operator tiles reconcile: sockets held
  // by accounts, plus guest rows, equals the online total exactly
  for (const [uid, p] of byUser) p.sessions = authedUsers.get(uid) ?? 1;
  // ...and the same for guests: a socket in the registry that is not authed and not
  // in any room is somebody sitting in the menus, which is a row, not a rounding
  // error. This is the only place idle guests are visible at all.
  for (const [sid, sock] of liveSockets) {
    if (sock.authed || byGuest.has(sid)) continue;
    byGuest.set(sid, { id: sid, act: 'menu' });
  }
  const guests = [...byGuest.values()];
  return {
    players: [...byUser.values()],
    guests,
    // the summary tiles are DERIVED from the rows, so a count can never disagree
    // with the list printed under it
    anon: {
      total: guests.length,
      inMatch: guests.filter((g) => g.act === 'match').length,
      inLobby: guests.filter((g) => g.act === 'lobby').length,
      idle: guests.filter((g) => g.act === 'menu').length,
    },
  };
}

async function aggregatePresence(full = false): Promise<GlobalPresence> {
  const now = Date.now();
  if (presenceCache && now - presenceCache.at < presenceTtl(full)) return withLocal(presenceCache.val);
  const val = await globalPresence();
  presenceCache = { at: now, val };
  return withLocal(val);
}

/**
 * Cross-region live rooms, cached.
 *
 * `/api/live` is polled every 4s by everyone sitting on the Watch screen and used
 * to cost zero database. One shared 3s cache keeps that nearly true: N watchers
 * cost one query per 3s instead of one each, which matters on a compute that bills
 * for being awake.
 */
const LIVE_TTL_MS = 3_000;
let liveCache: { at: number; val: unknown[] } | null = null;
async function aggregateLive(): Promise<unknown[]> {
  const now = Date.now();
  if (liveCache && now - liveCache.at < LIVE_TTL_MS) return liveCache.val;
  const val = await globalLiveRooms();
  liveCache = { at: now, val };
  return val;
}

/** every match running on THIS machine, unfiltered (see `Room.summary`) */
function localLive(): LiveRoom[] {
  return [...rooms.values()].map((r) => r.summary()).filter((s): s is LiveRoom => s !== null);
}

/**
 * May a stranger see this room in "Watch Live"? Everything EXCEPT custom rooms.
 *
 * A custom room is somebody's private game: it is reached by a code they chose to
 * hand out, and listing it publicly would hand that code to everyone. Friends
 * still spectate it (their friends list carries the code — see `liveRoomsByUser`),
 * anyone given the code can still type it in, and admins still see it.
 *
 * Ranked matches and record runs are both public: a ranked match is a rated game
 * nobody chose the opponent for, and a record run is a leaderboard attempt whose
 * score is published the moment it ends. Neither is reached by a shared secret.
 * A record room reports `ranked: false`, so kind has to be checked first or the
 * two would be filtered by the same test and record runs would vanish.
 */
function isPublicLive(r: unknown): boolean {
  const room = r as Partial<LiveRoom>;
  if (room?.kind === 'record') return true;
  return room?.ranked === true;
}

/** local rooms unioned with every other region's, newest information winning.
 *  Shared by `/api/live` and the admin view so the two can't disagree. */
function unionLive(local: LiveRoom[], global: unknown[]): unknown[] {
  const seen = new Set(local.map((r) => r.room));
  return [...local, ...global.filter((r) => !seen.has((r as { room: string }).room))];
}

const httpServer = createServer((req, res) => {
  if (req.method === 'GET' && req.url?.startsWith('/health')) {
    // `?region=<code>` lets the client ping a SPECIFIC region (the picker) or read
    // its home region: on Fly we fly-replay the GET to that region's machine, which
    // answers with its own x-region. Locally (REGION='') we just answer here.
    const want = new URL(req.url, 'http://x').searchParams.get('region');
    const already = !!req.headers['fly-replay-src'];
    if (REGION && want && want !== REGION && !already) {
      res.writeHead(200, {
        'fly-replay': `region=${want}`,
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      });
      res.end();
      return;
    }
    // CORS so the web client (different origin) can time this for the pre-connect
    // ping picker. Includes the region so a client can confirm which one answered.
    // `expose-headers` is REQUIRED for that: a cross-origin fetch can only read
    // CORS-safelisted response headers, so without it `res.headers.get('x-region')`
    // is null in the browser (curl sees the header fine — CORS is browser-side only).
    // That silently broke every home-region read: the matchmaker got homeRegion ''
    // and scored every region as the unknown-pair penalty.
    res.writeHead(200, {
      'content-type': 'text/plain',
      'access-control-allow-origin': '*',
      'access-control-expose-headers': 'x-region',
      'cache-control': 'no-store',
      ...(REGION ? { 'x-region': REGION } : {}),
    });
    res.end('ok');
    return;
  }
  // ADMIN API — gated by ADMIN_USER_IDS (your account's UUID, via the signed-in
  // JWT); the ADMIN_SECRET query still works for curl. CORS'd for the web app.
  //   GET  /api/admin/status                          -> { isAdmin, userId }
  //   POST /api/admin/announce?seconds=300&msg=…       schedule a restart notice
  //   POST /api/admin/announce?cancel=1                clear a pending notice
  if (req.url?.startsWith('/api/admin/')) {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const u = new URL(req.url, 'http://x');
    void (async () => {
      const auth = req.headers['authorization'];
      const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
      const user = await verifyAuthToken(token);
      const isAdmin = !!user && ADMIN_IDS.has(user.userId);

      if (req.method === 'GET' && u.pathname === '/api/admin/status') {
        res.writeHead(200, { ...cors, 'content-type': 'application/json' });
        res.end(JSON.stringify({ isAdmin, userId: user?.userId ?? null }));
        return;
      }
      /**
       * GET /api/admin/presence — the operator view of who is on the service.
       *
       * WHAT THIS SHOWS AND DELIBERATELY DOES NOT:
       *  - SIGNED-IN accounts: handle, coarse activity (menu/lobby/match), the room
       *    they are in, and their ranked-queue bucket + wait. Every field is either
       *    already public (`/api/live` lists live rooms WITH player names) or
       *    already shown to that player's own friends. Nothing new is collected
       *    from anyone to build this.
       *  - ANONYMOUS sessions: COUNTS ONLY, bucketed by activity. No identifier, no
       *    row, no history. A guest cannot be warned, banned or contacted, so
       *    identifying one enables no moderation action — it would be surveillance
       *    with no remedy attached to it.
       *  - NOBODY: which menu or screen they are on, their inputs, or any timeline.
       *    The table underneath is a ~5s snapshot that overwrites itself, so this
       *    cannot answer "what was X doing an hour ago" even in principle.
       */
      if (req.method === 'GET' && u.pathname === '/api/admin/presence') {
        if (!isAdmin) {
          res.writeHead(403, cors);
          res.end('forbidden');
          return;
        }
        const machines = dbEnabled ? await adminPresence() : [];
        const local = operatorSnapshot();
        // EVERY region and EVERY kind. The operator list used to be this machine's
        // rooms only, which on a multi-region deploy meant "Live matches" answered
        // with whatever happened to be hosted next to the admin — the same bug
        // `/api/live` had. Custom and record rooms are kept here (they are filtered
        // out of the PUBLIC list, not out of the room summary), so "spectate any
        // game" means any game.
        const liveRooms = dbEnabled
          ? unionLive(localLive(), await aggregateLive().catch(() => []))
          : localLive();
        res.writeHead(200, { ...cors, 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            region: REGION,
            machines,
            // this machine's own numbers too, so a single-region/dev deploy — and
            // the gap between a socket opening and the next beat — still reads true
            local: { machine: MACHINE, region: REGION, online: onlineCount, ...local },
            rooms: liveRooms,
            queues: matchmaker.queueSizes(),
          }),
        );
        return;
      }
      /**
       * GET /api/admin/matches — the most recently FINISHED games, service-wide.
       *
       * The past half of "show me every game": the live list covers what is running
       * now, and this covers what just ran. A finished match cannot be spectated, so
       * each row carries its `replayId` and the panel opens the replay instead.
       *
       * This is a records read, not a surveillance one: every row is a match result
       * that already appears in its own players' public match history. It is here
       * because that history is per-account and an operator does not know the
       * account yet — which is the whole reason for the page.
       */
      if (req.method === 'GET' && u.pathname === '/api/admin/matches') {
        if (!isAdmin) {
          res.writeHead(403, cors);
          res.end('forbidden');
          return;
        }
        if (!dbEnabled) {
          res.writeHead(200, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify({ matches: [] }));
          return;
        }
        const gq = u.searchParams.get('game');
        const rows = await recentMatches(
          Number(u.searchParams.get('limit')) || 40,
          gq === 'chain' || gq === 'decode' ? gq : undefined,
        );
        res.writeHead(200, { ...cors, 'content-type': 'application/json' });
        res.end(JSON.stringify({ matches: rows }));
        return;
      }
      /**
       * MODERATION — the report queue, one player's reports, and their matches.
       *
       *   GET  /api/admin/reports                  the queue (one row per reported player)
       *   GET  /api/admin/reports?user=<id>        that player's reports + recent matches
       *   POST /api/admin/reports?user=<id>&status=reviewed|dismissed
       *
       * The per-user GET returns the MATCHES alongside the reports deliberately. A report
       * for cheating or throwing cannot be judged from its text — the moderator has to
       * watch the match — and a queue that makes them go and find the replay somewhere else
       * is a queue that stops being worked. One request, everything needed to make a call.
       */
      if (u.pathname === '/api/admin/reports') {
        if (!isAdmin) {
          res.writeHead(403, cors);
          res.end('forbidden');
          return;
        }
        if (!dbEnabled) {
          res.writeHead(200, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify({ users: [], reports: [], matches: [] }));
          return;
        }
        // `target` — NOT `user`, which is the verified ADMIN in this scope. Shadowing it
        // silently made the moderator id resolve to the reported player's.
        const target = u.searchParams.get('user');
        if (req.method === 'POST') {
          const status = u.searchParams.get('status');
          if (!target || (status !== 'reviewed' && status !== 'dismissed')) {
            res.writeHead(400, cors);
            res.end('bad request');
            return;
          }
          const n = await setReportsStatus(target, status, user?.userId ?? 'admin');
          // UPHELD is the only event in the standing system a human has actually verified,
          // so it is the only one big enough to move a player two tiers — and unlike the raw
          // reports it replaces, it restricts. DISMISSED deliberately does nothing: the raw
          // nudges those reports already applied heal off on their own, and reversing them
          // would need a per-report ledger to undo exactly, which is a lot of machinery for
          // a few points that expire anyway.
          if (status === 'reviewed' && n > 0) {
            void chargeStanding(target, 'reportUpheld', {}).catch((e) =>
              console.error('[standing] upheld charge failed:', e),
            );
          }
          res.writeHead(200, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, updated: n }));
          return;
        }
        if (target) {
          const [reports, matches, standings, events] = await Promise.all([
            listReportsFor(target),
            userRecentMatches(target),
            standingsFor([target]),
            listStandingEvents(target, 20),
          ]);
          res.writeHead(200, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify({ reports, matches, standing: standings[target] ?? null, standingEvents: events }));
          return;
        }
        // The QUEUE carries each player's standing alongside the report counts. It is the
        // corroborating half of a report: a name with twelve reports and a full standing is
        // a very different case from one the SERVER has independently watched leave three
        // matches, and a moderator should not have to open a row to tell them apart.
        const users = await listReportedUsers();
        const standings = await standingsFor(users.map((u) => u.userId));
        res.writeHead(200, { ...cors, 'content-type': 'application/json' });
        res.end(JSON.stringify({
          users: users.map((u) => ({ ...u, standing: standings[u.userId]?.score ?? null })),
        }));
        return;
      }
      /**
       * GET/POST /api/admin/score-reports — the MISSCORE queue.
       *
       * A separate queue from the player one because it is a different question. A player
       * report asks "is this person behaving"; a misscore claim asks "did the server get the
       * arithmetic wrong", which is answered by opening the replay, not by watching someone
       * drive. Each row carries the claim, the match it points at, and the reporter's own
       * history — how many they have filed and how many were rejected — because that history
       * is what separates an honest confusion from a habit before anyone reaches for a smite.
       *
       * POST ?id=&verdict=upheld|rejected&smite=N. The smite is standing points taken off the
       * REPORTER for a claim found malicious, and it goes through the ordinary standing ledger
       * (`falseReport`) rather than a private one, so the player sees it where they see every
       * other penalty and the tier/cooldown machinery treats it like any other offence.
       */
      if (u.pathname === '/api/admin/score-reports') {
        if (!isAdmin) {
          res.writeHead(403, cors);
          res.end('forbidden');
          return;
        }
        if (!dbEnabled) {
          res.writeHead(200, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify({ reports: [] }));
          return;
        }
        if (req.method === 'POST') {
          const id = u.searchParams.get('id');
          const verdict = u.searchParams.get('verdict');
          const smite = Math.max(0, Math.min(STANDING_MAX, Number(u.searchParams.get('smite') ?? 0) || 0));
          if (!id || (verdict !== 'upheld' && verdict !== 'rejected')) {
            res.writeHead(400, cors);
            res.end('bad request');
            return;
          }
          const done = await resolveScoreReport(id, verdict, user?.userId ?? 'admin', smite);
          // A SMITE ONLY EVER FOLLOWS A REJECTION. Upholding a claim means the reporter was
          // right; charging them for being right is the failure mode this whole feature is
          // supposed to guard against, so the server refuses it rather than trusting the UI
          // to never offer it.
          if (done && verdict === 'rejected' && smite > 0) {
            void chargeStanding(done.reporterId, 'falseReport', {
              roomCode: done.roomCode,
              points: smite,
            }).catch((e) => console.error('[standing] smite failed:', e));
          }
          res.writeHead(200, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: Boolean(done) }));
          return;
        }
        const reports = await listScoreReports({ status: u.searchParams.get('status') ?? undefined });
        res.writeHead(200, { ...cors, 'content-type': 'application/json' });
        res.end(JSON.stringify({ reports }));
        return;
      }
      /**
       * GET/POST /api/admin/maintenance — the lockdown window.
       *
       * POST body (query params): active=1|0, startsAt/endsAt (ms epoch, blank for
       * "now"/"open-ended"), msg. Setting a FUTURE start is the normal path: it
       * announces the window to everyone without locking anyone out yet, which is
       * the difference between scheduled maintenance and an outage.
       */
      if (u.pathname === '/api/admin/maintenance') {
        if (!isAdmin) {
          res.writeHead(403, cors);
          res.end('forbidden');
          return;
        }
        if (!dbEnabled) {
          res.writeHead(200, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'no database — maintenance needs one to be shared across regions' }));
          return;
        }
        if (req.method === 'POST') {
          const num = (k: string): number | null => {
            const v = u.searchParams.get(k);
            if (!v) return null;
            const n = Number(v);
            return Number.isFinite(n) && n > 0 ? n : null;
          };
          const next = await setMaintenance({
            active: u.searchParams.get('active') === '1',
            startsAt: num('startsAt'),
            endsAt: num('endsAt'),
            message: (u.searchParams.get('msg') ?? '').slice(0, 200),
          });
          await refreshMaintenance(true); // this machine stops/starts enforcing NOW
          res.writeHead(200, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, maintenance: next }));
          return;
        }
        const cur = await getMaintenance();
        res.writeHead(200, { ...cors, 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, maintenance: cur, biting: maintenanceBiting(cur) }));
        return;
      }
      if (req.method === 'POST' && u.pathname === '/api/admin/announce') {
        const secretOk =
          !!process.env.ADMIN_SECRET && u.searchParams.get('secret') === process.env.ADMIN_SECRET;
        if (!isAdmin && !secretOk) {
          res.writeHead(403, cors);
          res.end('forbidden');
          return;
        }
        if (u.searchParams.get('cancel')) {
          currentNotice = { t: 'serverNotice', kind: 'info', message: '' }; // empty => clear on client
          const n = broadcastAll(currentNotice);
          currentNotice = null;
          res.writeHead(200, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, cancelled: true, notified: n }));
          return;
        }
        const seconds = Math.max(0, Number(u.searchParams.get('seconds') ?? 300));
        const message = u.searchParams.get('msg') || 'Server restarting for an update';
        currentNotice = { t: 'serverNotice', kind: 'restart', message, until: Date.now() + seconds * 1000 };
        const notified = broadcastAll(currentNotice);
        console.log(`[admin] restart notice in ${seconds}s -> ${notified} clients: "${message}"`);
        res.writeHead(200, { ...cors, 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, notified, until: currentNotice.until }));
        return;
      }
      // SEASONS: archive the live boards and open a fresh season, or purge the
      // replays of an archived season (frees storage; boards stay, watchability
      // drops). Both are admin-gated (JWT admin id OR the ADMIN_SECRET query).
      if (
        req.method === 'POST' &&
        (u.pathname === '/api/admin/season/start' || u.pathname === '/api/admin/season/purge-replays')
      ) {
        const secretOk =
          !!process.env.ADMIN_SECRET && u.searchParams.get('secret') === process.env.ADMIN_SECRET;
        if (!isAdmin && !secretOk) {
          res.writeHead(403, cors);
          res.end('forbidden');
          return;
        }
        if (!dbEnabled) {
          res.writeHead(503, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'DB disabled' }));
          return;
        }
        // which game's period to advance — DECODE and Chain Reaction run independent
        // Act → Season progressions (default DECODE).
        const adminGame = u.searchParams.get('game') === 'chain' ? 'chain' : 'decode';
        if (u.pathname === '/api/admin/season/start') {
          const name = u.searchParams.get('name') ?? undefined;
          // `act=new` opens a fresh ACT (act++, season resets to 1); otherwise a
          // new season in the current act.
          const bumpAct = u.searchParams.get('act') === 'new';
          const { season, act, seasonNo } = await startNewSeason(BALANCE_VERSION, name, bumpAct, adminGame);
          const label = periodLabel({ name, act, seasonNo });
          console.log(
            `[admin] started new ${bumpAct ? 'act' : 'season'}: bv=${season} (${label})`,
          );
          // auto-publish a cinematic announcement (editable/retire-able from the
          // admin console). `announce=0` opts out for a silent roll.
          if (u.searchParams.get('announce') !== '0') {
            await createAnnouncement({
              kind: bumpAct ? 'act' : 'season',
              title: label,
              tagline: bumpAct ? 'A NEW ACT BEGINS' : 'A NEW SEASON BEGINS',
              body: 'Fresh leaderboards and ranked ratings are live. Set a new record and climb from the top.',
            }).catch((e) => console.error('[admin] announcement failed:', e));
          }
          res.writeHead(200, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, season, act, seasonNo }));
          return;
        }
        // purge-replays: default to every season BEFORE the live one when unspecified
        const seasonArg = u.searchParams.get('season');
        const current = await currentSeasonNumber(BALANCE_VERSION, adminGame);
        let freed = 0;
        if (seasonArg !== null) {
          const s = Number(seasonArg);
          if (s >= current) {
            res.writeHead(400, { ...cors, 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'refusing to purge the live season' }));
            return;
          }
          freed = await purgeSeasonReplays(s, adminGame);
        } else {
          for (let s = 1; s < current; s++) freed += await purgeSeasonReplays(s, adminGame);
        }
        console.log(`[admin] purged ${freed} archived-season replays`);
        res.writeHead(200, { ...cors, 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, freed }));
        return;
      }

      // MODERATION — inspect/delete leaderboard records + rename inappropriate
      // display names. Same admin gate as above (JWT admin id OR ADMIN_SECRET);
      // every action is re-authorized here on the server, never trusting the UI.
      if (
        u.pathname === '/api/admin/records' ||
        u.pathname === '/api/admin/record/delete' ||
        u.pathname === '/api/admin/user/records/clear' ||
        u.pathname === '/api/admin/users' ||
        u.pathname === '/api/admin/user/rename' ||
        u.pathname === '/api/admin/supporter/grant' ||
        u.pathname === '/api/admin/supporter/revoke' ||
        u.pathname === '/api/admin/supporter/history' ||
        u.pathname === '/api/admin/supporter/refund'
      ) {
        const secretOk =
          !!process.env.ADMIN_SECRET && u.searchParams.get('secret') === process.env.ADMIN_SECRET;
        if (!isAdmin && !secretOk) {
          res.writeHead(403, cors);
          res.end('forbidden');
          return;
        }
        if (!dbEnabled) {
          res.writeHead(503, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'DB disabled' }));
          return;
        }
        const jsonOut = (code: number, body: unknown): void => {
          res.writeHead(code, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };

        // GET /api/admin/records?mode=&drivetrain=&limit= — moderation board view
        if (req.method === 'GET' && u.pathname === '/api/admin/records') {
          const mode = u.searchParams.get('mode') === 'duo' ? 'duo' : 'solo';
          const drivetrain = u.searchParams.get('drivetrain') ?? 'overall';
          const limit = Math.min(500, Math.max(1, Number(u.searchParams.get('limit') ?? 100)));
          const adminRecGame = u.searchParams.get('game') === 'chain' ? 'chain' : 'decode';
          const season = await currentSeasonNumber(BALANCE_VERSION, adminRecGame);
          const rows = await adminListRecords({ mode, drivetrain, balanceVersion: season, limit, game: adminRecGame });
          jsonOut(200, { season, mode, drivetrain, rows, game: adminRecGame });
          return;
        }
        // POST /api/admin/record/delete?id= — remove one run (+ its replay)
        if (req.method === 'POST' && u.pathname === '/api/admin/record/delete') {
          const id = u.searchParams.get('id') ?? '';
          if (!id) {
            jsonOut(400, { ok: false, error: 'missing id' });
            return;
          }
          const deleted = await deleteRecordById(id);
          console.log(`[admin] delete record ${id} -> ${deleted}`);
          jsonOut(deleted ? 200 : 404, { ok: deleted });
          return;
        }
        // POST /api/admin/user/records/clear?userId= — nuke a cheater's runs
        if (req.method === 'POST' && u.pathname === '/api/admin/user/records/clear') {
          const uid = u.searchParams.get('userId') ?? '';
          if (!uid) {
            jsonOut(400, { ok: false, error: 'missing userId' });
            return;
          }
          const removed = await deleteUserRecords(uid);
          console.log(`[admin] cleared ${removed} records for user ${uid}`);
          jsonOut(200, { ok: true, removed });
          return;
        }
        // GET /api/admin/users?q= — find profiles to rename/moderate
        if (req.method === 'GET' && u.pathname === '/api/admin/users') {
          const query = (u.searchParams.get('q') ?? '').trim();
          const users = query ? await searchProfiles(query) : [];
          jsonOut(200, { users });
          return;
        }
        // POST /api/admin/user/rename?userId=&handle= — force a clean display name
        if (req.method === 'POST' && u.pathname === '/api/admin/user/rename') {
          const uid = u.searchParams.get('userId') ?? '';
          const handle = (u.searchParams.get('handle') ?? '').trim();
          if (!uid) {
            jsonOut(400, { ok: false, error: 'missing userId' });
            return;
          }
          if (handle.length < 2 || handle.length > 24) {
            jsonOut(400, { ok: false, error: 'name must be 2–24 characters' });
            return;
          }
          const profile = await getProfile(uid);
          if (!profile) {
            jsonOut(404, { ok: false, error: 'no such user' });
            return;
          }
          await setHandle(uid, handle);
          console.log(`[admin] renamed ${uid}: "${profile.handle}" -> "${handle}"`);
          jsonOut(200, { ok: true, userId: uid, handle });
          return;
        }

        // SUPPORTER MEMBERSHIPS. Ko-fi grants arrive by webhook, but two cases
        // will always need a human: comping someone (a contributor, a botched
        // payment, a currency Ko-fi settled oddly) and taking a membership back
        // after a chargeback. Without these the only remedies were a psql session
        // or nothing, which is not a remedy.
        //
        // Every change is written to `supporter_grants` with the acting admin's
        // id, so a membership can always be traced to who gave it and why.

        // POST /api/admin/supporter/grant?userId=&months=&note= — comp a membership
        if (req.method === 'POST' && u.pathname === '/api/admin/supporter/grant') {
          const uid = u.searchParams.get('userId') ?? '';
          const months = Math.floor(Number(u.searchParams.get('months') ?? 1));
          if (!uid) {
            jsonOut(400, { ok: false, error: 'missing userId' });
            return;
          }
          if (!Number.isFinite(months) || months < 1 || months > 60) {
            jsonOut(400, { ok: false, error: 'months must be 1–60' });
            return;
          }
          if (!(await getProfile(uid))) {
            jsonOut(404, { ok: false, error: 'no such user' });
            return;
          }
          const note = (u.searchParams.get('note') ?? '').slice(0, 200);
          const until = await grantSupporter(
            uid,
            months,
            'admin',
            `by ${user?.userId ?? 'secret'}${note ? `: ${note}` : ''}`,
          );
          console.log(`[admin] supporter +${months}mo for ${uid} -> ${until}`);
          jsonOut(200, { ok: true, userId: uid, until });
          return;
        }

        // POST /api/admin/supporter/revoke?userId=&note= — chargeback / mistake
        if (req.method === 'POST' && u.pathname === '/api/admin/supporter/revoke') {
          const uid = u.searchParams.get('userId') ?? '';
          if (!uid) {
            jsonOut(400, { ok: false, error: 'missing userId' });
            return;
          }
          const note = (u.searchParams.get('note') ?? '').slice(0, 200);
          const revoked = await revokeSupporter(
            uid,
            `by ${user?.userId ?? 'secret'}${note ? `: ${note}` : ''}`,
          );
          console.log(`[admin] supporter revoked for ${uid} -> ${revoked}`);
          jsonOut(200, { ok: true, userId: uid, revoked });
          return;
        }

        // POST /api/admin/supporter/refund?txn= — flag a payment as charged back.
        // Separate from revoke on purpose: the entitlement may cover other
        // payments too, so ending it is a second, deliberate decision.
        if (req.method === 'POST' && u.pathname === '/api/admin/supporter/refund') {
          const txn = (u.searchParams.get('txn') ?? '').trim();
          if (!txn) {
            jsonOut(400, { ok: false, error: 'missing txn' });
            return;
          }
          const flagged = await refundKofiPayment(txn);
          console.log(`[admin] payment ${txn} flagged refunded -> ${flagged}`);
          jsonOut(flagged ? 200 : 404, { ok: flagged });
          return;
        }

        // GET /api/admin/supporter/history?userId= — why does this account have one?
        if (req.method === 'GET' && u.pathname === '/api/admin/supporter/history') {
          const uid = u.searchParams.get('userId') ?? '';
          if (!uid) {
            jsonOut(400, { ok: false, error: 'missing userId' });
            return;
          }
          jsonOut(200, { grants: await listSupporterGrants(uid) });
          return;
        }
        jsonOut(404, { ok: false, error: 'unknown admin route' });
        return;
      }

      // ANNOUNCEMENTS — publish patch notes / new-season / new-act reveals, or
      // retire an existing one. Same admin gate (JWT admin id OR ADMIN_SECRET);
      // reads go through the PUBLIC GET /api/announcements (active feed).
      if (u.pathname === '/api/admin/announcement' || u.pathname === '/api/admin/announcement/delete') {
        const secretOk =
          !!process.env.ADMIN_SECRET && u.searchParams.get('secret') === process.env.ADMIN_SECRET;
        if (!isAdmin && !secretOk) {
          res.writeHead(403, cors);
          res.end('forbidden');
          return;
        }
        if (!dbEnabled) {
          res.writeHead(503, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'DB disabled' }));
          return;
        }
        const jsonOut = (code: number, body: unknown): void => {
          res.writeHead(code, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (req.method === 'POST' && u.pathname === '/api/admin/announcement/delete') {
          const id = u.searchParams.get('id') ?? '';
          if (!id) {
            jsonOut(400, { ok: false, error: 'missing id' });
            return;
          }
          const deleted = await deleteAnnouncement(id);
          console.log(`[admin] retire announcement ${id} -> ${deleted}`);
          jsonOut(deleted ? 200 : 404, { ok: deleted });
          return;
        }
        // POST /api/admin/announcement — publish. Body: {kind,title,body,tagline}
        if (req.method === 'POST' && u.pathname === '/api/admin/announcement') {
          let payload: { kind?: string; title?: string; body?: string; tagline?: string };
          try {
            payload = JSON.parse(await readAdminBody(req));
          } catch {
            jsonOut(400, { ok: false, error: 'bad request' });
            return;
          }
          const title = (payload.title ?? '').trim();
          if (title.length < 2 || title.length > 80) {
            jsonOut(400, { ok: false, error: 'title must be 2–80 characters' });
            return;
          }
          const body = (payload.body ?? '').slice(0, 8000); // long-form Markdown patch notes
          const tagline = (payload.tagline ?? '').trim().slice(0, 80) || null;
          const row = await createAnnouncement({ kind: payload.kind ?? 'patch', title, body, tagline });
          console.log(`[admin] published ${row.kind} announcement "${row.title}"`);
          // a live-info banner nudges connected players to look — the feed itself
          // shows on their NEXT load (localStorage "seen" gate), but this makes it
          // feel immediate for anyone already online.
          jsonOut(200, { ok: true, announcement: row });
          return;
        }
        jsonOut(404, { ok: false, error: 'unknown admin route' });
        return;
      }
      res.writeHead(404, cors);
      res.end();
    })().catch((e) => {
      console.error('[admin] handler error:', e);
      if (!res.headersSent) res.writeHead(500, cors);
      res.end();
    });
    return;
  }
  /**
   * LOOK UP ONE ROOM BY CODE — `GET /api/room?code=XXXXXX`.
   *
   * Answers "is this match live, and WHICH REGION is hosting it". Spectating needs
   * both: a custom room's code is a bare 6 characters with no region prefix, so a
   * spectate socket opened without a region lands on whichever machine anycast is
   * nearest and finds no such room. Ranked codes ARE region-coded and route
   * themselves, but they come through here identically so there is one path.
   *
   * NOT a directory: it answers about a code you already hold, and holding the code
   * is what lets you join the room in the first place — so this discloses nothing
   * that typing the code into the join box did not already. Custom rooms are absent
   * from the public `/api/live` list precisely so they can only be reached this way.
   */
  if (req.method === 'GET' && req.url?.startsWith('/api/room')) {
    const code = (new URL(req.url, 'http://x').searchParams.get('code') ?? '').toLowerCase();
    const send = (room: LiveRoom | null): void => {
      res.writeHead(room ? 200 : 404, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      res.end(JSON.stringify(room ? { room } : { error: 'no such live match' }));
    };
    const find = (list: unknown[]): LiveRoom | null =>
      (list as LiveRoom[]).find((r) => r.room.toLowerCase() === code) ?? null;
    if (!code) {
      send(null);
      return;
    }
    const local = find(localLive());
    if (local || !dbEnabled) {
      send(local);
      return;
    }
    aggregateLive().then(
      (all) => send(find(all)),
      (e) => {
        console.error('[live] room lookup failed:', e);
        send(null);
      },
    );
    return;
  }
  // live presence (served here, not in api.ts, because the counts live on this
  // process: the socket registry + the in-memory matchmaker queues)
  // "Watch Live": every currently-running RANKED match ACROSS EVERY REGION. Each
  // entry's `room` code is spectated via the WS `spectate` message.
  if (req.method === 'GET' && req.url?.startsWith('/api/live')) {
    const local = localLive();
    const send = (list: unknown[]): void => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      res.end(JSON.stringify({ region: REGION, rooms: list.filter(isPublicLive) }));
    };
    // EVERY region, not just this one. Anycast lands each caller on their nearest
    // machine, and a machine only knows its OWN rooms — so this answered with
    // whatever happened to be running in the caller's region and silently omitted
    // the rest of the service. Matches are hosted wherever the matchmaker judged
    // fairest, which is frequently not where a given spectator is, so "no live
    // matches right now" was routinely just wrong. Rooms ride the presence
    // heartbeat (0021); this machine's own list is unioned in on top so a room
    // started since the last beat is never missing from its own region's answer.
    if (dbEnabled) {
      aggregateLive().then(
        (all) => send(unionLive(local, all)),
        (e) => {
          console.error('[live] aggregate failed, using local:', e);
          send(local);
        },
      );
    } else {
      send(local);
    }
    return;
  }
  /**
   * GET /api/lobbies?group=<id> — OPEN lobbies for a Discord Activity.
   *
   * The Discord lobby browser lists the rooms of ONE activity so more than four
   * players can split into several games cleanly. Scoped strictly by `group` (the
   * activity instance id, set by each room's creator): a request without a group,
   * or for a group with no rooms, gets an empty list — this never exposes the
   * global custom-room set (those are private-by-code, deliberately absent from
   * every public list). LOCAL rooms only: Discord's `/gs` mapping targets a single
   * region, so an activity's rooms all live on one machine.
   */
  if (req.method === 'GET' && req.url?.startsWith('/api/lobbies')) {
    const u = new URL(req.url, 'http://x');
    // Region PIN (see the Discord client's DISCORD_REGION): all of an activity's
    // rooms live on one machine, so the listing must be READ from that same machine
    // or an anycast-nearest read returns a different region's (empty) set. On Fly we
    // fly-replay this GET to the requested region; locally (REGION='') we answer here.
    const want = u.searchParams.get('region');
    if (REGION && want && want !== REGION && !req.headers['fly-replay-src']) {
      res.writeHead(200, {
        'fly-replay': `region=${want}`,
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      });
      res.end();
      return;
    }
    const group = (u.searchParams.get('group') ?? '').replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 64);
    const lobbies = group
      ? [...rooms.values()]
          .filter((r) => r.group === group)
          .map((r) => r.lobbySummary())
          .filter((s): s is NonNullable<ReturnType<Room['lobbySummary']>> => s !== null)
      : [];
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    res.end(JSON.stringify({ region: REGION, lobbies }));
    return;
  }
  // machine-sizing evidence for THIS machine (see the perf probe above). Public and
  // read-only: counts and timings, no player or account data. `?reset=1` zeroes the
  // lag histogram so a sample can be scoped to one match instead of since boot.
  if (req.method === 'GET' && req.url?.startsWith('/api/perf')) {
    const live = localLive();
    const ms = (n: number): number => Math.round((n / 1e6) * 100) / 100; // ns → ms
    const heap = v8.getHeapStatistics();
    const mb = (n: number): number => Math.round(n / 1048576);
    const body = {
      region: REGION,
      machine: MACHINE,
      uptimeS: Math.round(process.uptime()),
      cores: Math.round(coresInUse() * 1000) / 1000,
      rooms: live.length,
      // the admission cap and whether it is currently biting. An operator debugging
      // "players say the region is full" needs both numbers in one place.
      maxRooms: MAX_ROOMS,
      admitting: MAX_ROOMS === 0 || rooms.size < MAX_ROOMS,
      players: onlineCount,
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
      // HEAP, not just RSS. RSS alone cannot distinguish "V8 is holding freed pages it
      // hasn't returned to the OS" (harmless) from "the live set is near the heap cap"
      // (pathological: every allocation triggers a full GC, and those pauses ARE the
      // stutter players report). `usedMb` against `limitMb` is the ratio that tells them
      // apart — a long-lived machine sitting at a high fraction of the limit while idle
      // is the one to restart or profile.
      heapMb: {
        used: mb(heap.used_heap_size),
        total: mb(heap.total_heap_size),
        limit: mb(heap.heap_size_limit),
      },
      // the decisive numbers: a p99 approaching the 16.67ms step budget means the
      // loop is already late, and a max past the /health timeout means a flap.
      // `windowS` is how long these have been accumulating: without it `max` is a
      // since-BOOT figure, so a week-old machine reports the one-off JIT/WASM stall
      // from its own startup forever and every reading looks alarming. Sample with
      // `?reset=1` to start a fresh window, then read it again during a real match —
      // that pair is the only way to attribute a stall to current load.
      windowS: Math.round((Date.now() - loopDelaySince) / 1000),
      loopLagMs: {
        mean: ms(loopDelay.mean),
        p50: ms(loopDelay.percentile(50)),
        p99: ms(loopDelay.percentile(99)),
        max: ms(loopDelay.max),
      },
    };
    if (new URL(req.url, 'http://x').searchParams.get('reset')) {
      loopDelay.reset();
      loopDelaySince = Date.now();
    }
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    res.end(JSON.stringify(body));
    return;
  }
  /**
   * YOUR OWN ACCOUNT STANDING, with the ledger behind it.
   *
   * Authed and self-only: the standing endpoint answers for the account on the token and
   * takes no user parameter at all, so it cannot be turned into a lookup for whether some
   * other player has been penalised. Moderators see other people's standing through the
   * admin reports API, which is separately gated.
   *
   * The EVENTS come with it, unasked. A number that dropped with no explanation attached is
   * the thing that makes a penalty system feel arbitrary, and the player should not have to
   * ask a human what happened to them.
   */
  if (req.method === 'GET' && new URL(req.url ?? '/', 'http://x').pathname === '/api/standing') {
    const head = { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' };
    const auth = req.headers['authorization'];
    const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
    void (async () => {
      const user = await verifyAuthToken(token).catch(() => null);
      if (!user || !dbEnabled) {
        res.writeHead(200, head);
        res.end(JSON.stringify({ standing: null }));
        return;
      }
      try {
        const s = await getStanding(user.userId);
        const events = await listStandingEvents(user.userId, 20);
        res.writeHead(200, head);
        res.end(JSON.stringify({ standing: { score: s.score, restrictedUntil: s.restrictedUntil }, events }));
      } catch (e) {
        console.error('[standing] read failed:', e);
        res.writeHead(200, head);
        res.end(JSON.stringify({ standing: null }));
      }
    })();
    return;
  }
  if (req.method === 'GET' && new URL(req.url ?? '/', 'http://x').pathname === '/api/presence') {
    // `?full=1` opts out of the idle short-circuit in `aggregatePresence` — the
    // ranked screen asks for it because its queue depth is a number people act on.
    const wantFull = new URL(req.url ?? '/', 'http://x').searchParams.get('full') === '1';
    void refreshMaintenance(); // keep the cached window fresh off this same poll
    // include any LIVE admin notice so the client can show the restart banner
    // (and block starting new games) on EVERY page — even disconnected ones
    // like Home/solo where no WebSocket delivers `serverNotice`.
    const notice =
      noticeLive() && currentNotice
        ? { kind: currentNotice.kind, message: currentNotice.message, until: currentNotice.until }
        : null;
    const respond = (
      online: number,
      signedIn: number,
      queues: Record<string, number>,
      gameQueues: Record<string, Record<string, number>>,
    ): void => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      // `caps` tells a NEW client what this (possibly older) deploy can honour —
      // see SERVER_CAPS. One app serves every client build, so a feature that
      // would misbehave rather than degrade has to be gated on the answer.
      //
      // `queues` (all games combined) STAYS for older clients that only know that
      // shape. `gameQueues` is the one a player can act on: pairing is bucketed by
      // game, so a combined count advertises a pool the reader cannot match from.
      // the maintenance window rides the presence poll every page already makes, so
      // the banner reaches disconnected screens (Home, solo) too — the same reason
      // `notice` is here rather than only on the WebSocket.
      const m = maint.active
        ? { startsAt: maint.startsAt, endsAt: maint.endsAt, message: maint.message, biting: maintenanceBiting(maint) }
        : null;
      res.end(JSON.stringify({ region: REGION, online, signedIn, queues, gameQueues, notice, maintenance: m, caps: SERVER_CAPS }));
    };
    // GLOBAL count: aggregate every region's heartbeat (this machine only sees its
    // own sockets — anycast routing means the caller often lands on an empty region).
    // Fall back to this machine's local numbers if the DB read fails.
    if (dbEnabled) {
      aggregatePresence(wantFull).then(
        (g) => respond(g.online, g.signedIn, g.queues, g.gameQueues ?? {}),
        (e) => {
          console.error('[presence] aggregate failed, using local:', e);
          respond(onlineCount, authedUsers.size, matchmaker.queueSizes(), matchmaker.queueSizesByGame());
        },
      );
    } else {
      respond(onlineCount, authedUsers.size, matchmaker.queueSizes(), matchmaker.queueSizesByGame());
    }
    return;
  }
  // public leaderboard / replay read API (GET /api/*)
  if (req.url?.startsWith('/api/')) {
    handleApi(req, res).catch((e) => {
      console.error('[api] handler crash:', e);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    return;
  }
  /**
   * THE BUILT CLIENT, for a self-hosted LAN server only (`SERVE_CLIENT=/path/to/dist`).
   *
   * LAST, deliberately: `/health`, `/api/admin/*` and `/api/*` are all dispatched above, so
   * nothing real can be shadowed by a file that happens to share a name. Off by default,
   * which is what keeps the Fly deployment — which has a CDN in front of it — from ever
   * serving a bundled copy of its own. See `server/static.ts`.
   */
  if (servingClient()) {
    void serveClient(req, res)
      .then((handled) => {
        if (handled) return;
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      })
      .catch((e) => {
        console.error('[static] handler crash:', e);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    return;
  }
  res.writeHead(426, { 'content-type': 'text/plain' });
  res.end('WebSocket only');
});
// LOW-LATENCY SOCKETS. Disable Nagle's algorithm on every connection: the room
// loop streams a ~20 Hz burst of SMALL delta frames, and Nagle batches small
// writes (waiting on the peer's ACK) — which, against TCP delayed-ACK, injects
// 40–200 ms stalls. That is exactly the symptom seen here: a healthy p50 (~40 ms)
// but a p95/p99 tail of 400–570 ms (periodic spikes / rubberbanding), and the
// classic Fly.io 60 Hz-game report. Nagle is PER-SOCKET (no OS/Dockerfile toggle
// works), so we set TCP_NODELAY on each socket in-process. Covers WS upgrades and
// the small HTTP (health/API) responses too.
httpServer.on('connection', (socket) => socket.setNoDelay(true));

// COMPRESSION IS ON, AND WHAT MAKES IT PAY IS THE WINDOW SURVIVING BETWEEN
// MESSAGES. This was `perMessageDeflate: false` for a long time, on the reasoning
// that "compression buffers/among-frames context adds latency + memory for our tiny
// JSON frames and buys little on already-delta'd snapshots". The latency and memory
// halves of that are real costs and are priced below; the last clause is simply
// wrong for this workload, and load testing measured how wrong (`docs/capacity.md`
// §6, over 300 REAL consecutive snapshot frames):
//
//   as sent today          6,424 B   (DECODE, 4 robots)
//   stateless deflate L1   1,724 B   (-73%)  — each message compressed alone
//   context takeover L1      446 B   (-93%)  — the window remembers the last frames
//
// A delta snapshot is already delta'd against the client's ACK, but CONSECUTIVE
// snapshots are still nearly identical to EACH OTHER: 30 Hz means a robot has moved
// a fraction of an inch, and the ball id ORDER is re-sent every frame by design
// (determinism). Frame-to-frame redundancy is exactly the structure a deflate window
// exploits and exactly the structure a per-message compressor throws away — hence the
// 73% vs 93% split above, and hence `serverNoContextTakeover: false` being the single
// load-bearing line in this block. Setting it true keeps the memory cost and gives up
// most of the saving.
//
// WHY THIS IS WORTH CPU AND MEMORY: the ceiling we actually hit first is BANDWIDTH,
// not compute. At the 1,000-concurrent target the uncompressed wire is ~440 GB/hour,
// which spends the entire daily infrastructure budget on egress for a single 3-hour
// peak before any compute is paid for (§5). Compression is the only lever that closes
// that gap without an architecture change.
//
// WHY THE WINDOW IS 15/8 AND NOT THE 13/6 §6 RECOMMENDED. §6 picked 13/6 (64 KB/socket)
// as the knee, priced against holding 63 MB of windows at 1,000 SOCKETS ON ONE MACHINE —
// and §3 of the same document proves that machine cannot exist. Node is single-threaded,
// one process is one core, and a core carries ~13 driven rooms; a machine therefore holds
// tens of sockets, not a thousand. At 20 sockets, 15/8 costs 5 MB and 13/6 costs 1.3 MB,
// so the memory axis the knee was chosen on is not a real constraint in any reachable
// topology. Measured end to end (`scripts/zz-deflate-cost.ts`), the difference is large:
//
//                       13/6              15/8
//   decode-solo   15.2 KB/s (-83%)   12.5 KB/s (-88%)
//   decode-1v1    38.3 KB/s (-80%)   26.0 KB/s (-86%)
//   decode-2v2    91.1 KB/s (-67%)   48.9 KB/s (-83%)
//   chain-solo    90.8 KB/s (-78%)   68.8 KB/s (-82%)
//
// Note how 13/6 DEGRADED AS THE ROOM GOT BUSIER, down to -67% on a 2v2. That is the knee
// argument turned around: a 2v2 frame is bigger, so 64 KB holds fewer consecutive frames
// and less of the redundancy is in reach. A room with four robots is the expensive one, so
// losing the ratio exactly there is the worst place to save 192 KB. `level: 1` stays,
// because the gain comes from the window and not from searching harder within a frame.
//
// ⚠️ THIS NEEDS NO `CLIENT_CAPS` GATE AND IS NOT A PROTOCOL CHANGE. permessage-deflate
// is a WebSocket extension negotiated per connection in the HTTP upgrade (RFC 7692), so
// a client that does not offer it is not given it and keeps receiving byte-for-byte what
// it receives today. Backward compatibility is structural, which matters here because
// ONE Fly app serves every client version.
//
// ⚠️ THE LATENCY HALF OF THE ORIGINAL COMMENT IS STILL UNVERIFIED ON LINUX. Two things
// to watch, both of which a Windows dev box cannot measure: whether the added per-message
// time shows up in the SNAPSHOT GAP (jitter is the choppiness signal players feel, not
// mean RTT), and whether the windows plus ws's own send buffers stay inside the machine
// at full population. Node runs permessage-deflate's zlib on the libuv THREADPOOL rather
// than the event loop, so the cost should land beside the room loop rather than inside it
// — that is the thing most worth confirming, because §6 priced it as if it were on-loop.
//
// THE KILL SWITCH IS `WS_COMPRESS=0`, and it exists because the latency half of this is
// the one thing that could not be measured before shipping. Everything above is a wire
// WIN; the risk is entirely on the other axis, and it lands on the day the population is
// largest. Turning the extension off is a restart of the machines with one env var set —
// no deploy, no code change, no client change (a client that offered the extension simply
// is not given it, which is the same path every old client already takes). Named as the
// rollback in docs/launch-load-test.md §3a, so it has to keep working.
//
// ⚠️ THE PARSE IS FORGIVING ON PURPOSE. This is a rollback lever somebody reaches for
// under load, from a phone, on the worst day the population has ever had — and it used to
// disable only the exact string `"0"`, so `WS_COMPRESS=false` (the spelling half of the
// world reaches for first, and the one `fly secrets` examples tend to show) left the
// extension ON while the operator believed they had turned it off. A switch that silently
// ignores a reasonable spelling of "off" is worse than no switch, because it costs the
// minutes spent looking somewhere else.
const WS_COMPRESS = !/^(0|false|no|off)$/i.test((process.env.WS_COMPRESS ?? '').trim());

/**
 * Below this many bytes a frame is sent UNCOMPRESSED: deflating a pong, a two-field roster
 * patch or a `spectators` count costs a zlib round trip on the libuv threadpool for a
 * saving measured in tens of bytes, and those messages outnumber snapshots.
 *
 * Applied per send rather than through ws's own `threshold` option, which does not apply
 * while context takeover is on — see the note on `perMessageDeflate` below. Skipping a
 * message is protocol-legal with context takeover (RFC 7692 §7.1: compression is per
 * message, signalled by RSV1, and an uncompressed message simply contributes nothing to
 * the shared LZ77 window), so the deflate history stays valid either way.
 *
 * The test is on `String#length` — UTF-16 units, not bytes. Our ServerMsg JSON is ASCII
 * apart from player names, so it under-counts by a few bytes at worst, and a threshold
 * this coarse does not care.
 */
const COMPRESS_THRESHOLD = 1024;

/**
 * Largest inbound frame this server will read. Past it `ws` closes the connection (1009)
 * rather than buffering.
 *
 * Left at ws's default it is 100 MiB per socket — a single unauthenticated socket could
 * make the machine hold 100 MiB before anything in this file had a chance to look at the
 * message, and the machine hosts every room in its region. The clients that exist send
 * ~100-byte quantized commands at 60 Hz and, once per connection, a `join` carrying a
 * sanitized `LobbyPlayer` (spec + assists + start pose, low single-digit KB). 64 KiB is
 * three orders of magnitude above the hot path and roughly an order above the largest
 * legitimate message, so nothing real is refused; replays and other genuinely large
 * payloads travel over HTTP, never over this socket.
 */
const WS_MAX_PAYLOAD = 64 * 1024;

// noServer: we intercept the upgrade ourselves (below) to do region routing. The
// extension is negotiated inside `wss.handleUpgrade`, so these options still apply.
const wss = new WebSocketServer({
  maxPayload: WS_MAX_PAYLOAD,
  noServer: true,
  perMessageDeflate: WS_COMPRESS ? {
    zlibDeflateOptions: { level: 1, windowBits: 15, memLevel: 8 },
    // advertised to the peer AND used for our deflate window; keep the two equal
    serverMaxWindowBits: 15,
    // THE LOAD-BEARING LINE — see above. False = the window survives between messages.
    serverNoContextTakeover: false,
    // the UPSTREAM direction is quantized RobotCommands, ~100 B, and carries no
    // frame-to-frame win worth an inflate window per socket. Asking the client to reset
    // its context each message bounds what we hold for a direction that is not the cost.
    clientNoContextTakeover: true,
    // ⚠️ INERT IN THIS CONFIGURATION, AND KEPT ONLY BECAUSE IT IS NOT ALWAYS INERT.
    // `ws` consults `threshold` in exactly one place (`lib/sender.js`, `Sender#send`) and
    // only when the NEGOTIATED params carry this direction's `*_no_context_takeover`:
    //
    //     if (rsv1 && perMessageDeflate && perMessageDeflate.params[
    //           perMessageDeflate._isServer ? 'server_no_context_takeover'
    //                                       : 'client_no_context_takeover']) {
    //       rsv1 = byteLength >= perMessageDeflate._threshold;
    //     }
    //
    // We deliberately run WITH context takeover on our side (`serverNoContextTakeover:
    // false` — the load-bearing line above), so `server_no_context_takeover` is absent
    // from the negotiated params and that branch never runs: every outbound frame was
    // being deflated, pongs and two-field roster patches included. The size test is
    // therefore applied at the SEND SITE instead (see `COMPRESS_THRESHOLD`), which is
    // where we know the byte count anyway. This line still matters for a peer that asks
    // us for no-context-takeover in its own offer, which ws accepts.
    threshold: COMPRESS_THRESHOLD,
    concurrencyLimit: 20,
  } : false,
});

// WS-level liveness. A half-open TCP connection (laptop lid closed, wifi dropped,
// a tab hard-killed) does NOT fire 'close' until the OS keepalive eventually times
// out — minutes to hours. Until then the socket is a GHOST: it stays in the ranked
// QUEUE (so the bucket reads e.g. "4/4" and a match is staged against a player who
// will never reconnect) and holds its ROOM slot. A periodic ping/pong reaps them:
// any socket that missed the previous ping is terminated, which fires 'close' and
// runs the normal teardown (matchmaker.remove + room.detach). See the heartbeat
// interval at the bottom of this file.
const socketAlive = new WeakMap<WebSocket, boolean>();

// ---- region routing (fly-replay) --------------------------------------------
// One Fly app, one machine per region. A WebSocket upgrade carries a routing hint
// in its query string; if it belongs to a DIFFERENT region we answer the upgrade
// with a `fly-replay` header instead of accepting it, and Fly's proxy replays the
// whole upgrade to the target region's machine (which then holds the connection).
// Hints:  ?mm=1 → the designated matchmaker region;  ?room=<region>-<code> → that
// room's host region;  ?region=<code> → an explicit pick.
// Only active on Fly (FLY_REGION set); locally REGION='' so we always accept here.
/**
 * The region a `?mm=1` connection was FIRST received in, from Fly's `fly-replay-src`
 * header (format `instance=…;region=<r>;t=…`). Anycast lands the connection on the
 * client's NEAREST region, which then replays it here to the matchmaker — so this
 * is a SERVER-OBSERVED home region, immune to the client's `/health` probe failing
 * (a cold/auto-stopped satellite makes that probe fall back to the warm primary or
 * to '', which then defaults every player to iad and hosts every match one-sided).
 * Used only as a FALLBACK when the client didn't report its own homeRegion, so the
 * working path is unchanged. Empty string when not replayed (already nearest here).
 */
function replaySrcRegion(req: IncomingMessage): string {
  const h = req.headers['fly-replay-src'];
  const raw = Array.isArray(h) ? h[0] : h;
  if (!raw) return '';
  const m = /(?:^|;)\s*region=([a-z]{3})(?:;|$)/i.exec(raw);
  return m ? m[1].toLowerCase() : '';
}


httpServer.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    const target = routeTarget(url, MATCHMAKER_REGION);
    // `fly-replay-src` is set by Fly after it has already replayed once — never
    // replay again (loop guard); accept locally as a graceful fallback.
    const alreadyReplayed = !!req.headers['fly-replay-src'];
    if (REGION && target && target !== REGION && !alreadyReplayed) {
      socket.write(
        'HTTP/1.1 200 OK\r\n' +
          `fly-replay: region=${target}\r\n` +
          'content-length: 0\r\n' +
          'connection: close\r\n\r\n',
      );
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } catch {
    socket.destroy();
  }
});

// resilience: a game server must never let one stray error kill every room. Log
// loudly and keep listening (the ws / room handlers already catch closer in).
wss.on('error', (e) => console.error('[server] websocket server error:', e));
httpServer.on('error', (e) => console.error('[server] http server error:', e));
process.on('uncaughtException', (e) => console.error('[server] uncaughtException:', e));
process.on('unhandledRejection', (e) => console.error('[server] unhandledRejection:', e));

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  // liveness: mark alive now and on every pong; the heartbeat interval (bottom of
  // file) pings and reaps anything that stops answering
  socketAlive.set(ws, true);
  ws.on('pong', () => socketAlive.set(ws, true));

  // server-observed home region (see replaySrcRegion) — the fallback for a client
  // whose own region probe failed, so a cold-satellite player is no longer
  // mis-hosted at iad
  const edgeRegion = replaySrcRegion(req);

  let id: string = randomUUID(); // reassigned to the reclaimed clientId on a rejoin
  let room: Room | null = null;
  // the owning-connection stamp this socket was issued for its slot (0 until it
  // joins/rejoins). Passed to detach on close so a stale socket that a newer
  // reconnect already superseded can't knock the live player offline.
  let conn = 0;
  /**
   * This socket has gone away. Read by the ASYNC join path, which runs several awaits
   * (a staged-match claim, a JWT verify, a maintenance refresh, a supporter lookup)
   * between claiming a room and adding anyone to it — `ws.on('close')` can land in any of
   * those gaps, and at that moment `room` is still null, so the close handler's
   * `room?.detach` does nothing at all. Without this flag the attempt finishes against a
   * socket nobody is holding. See `joinRoom`.
   */
  let closed = false;
  /** true once this socket is attached as a SPECTATOR, so the global tally can be
   *  decremented exactly once on close (a spectator never becomes a driver — the
   *  `spectate` branch is only reachable while `room` is null, and it sets it). */
  let spectating = false;
  const wasEmpty = onlineCount === 0;
  onlineCount++;
  liveSockets.set(id, { authed: false });
  // FIRST arrival after a quiet spell: publish immediately rather than waiting up to
  // 5s for the next tick, and drop the cached answer — it was computed when this
  // machine was empty, so serving it again would report a zero we already know is
  // wrong. Only on the EDGE, so a busy machine still writes at its normal cadence.
  if (wasEmpty) {
    presenceCache = null;
    beatNow();
  }
  // the authed user this socket belongs to (set once its JWT verifies), so the
  // signed-in tally can be decremented cleanly on close
  let authedUserId: string | null = null;
  const markAuthed = (userId: string): void => {
    if (authedUserId) return; // count each connection's user exactly once
    authedUserId = userId;
    const sock = liveSockets.get(id);
    if (sock) sock.authed = true; // no longer a guest row
    authedUsers.set(userId, (authedUsers.get(userId) ?? 0) + 1);
  };
  // the one place a frame actually reaches the socket. `compress` is decided here rather
  // than by ws's `threshold` option, which is inert while context takeover is on — see
  // COMPRESS_THRESHOLD. (With the extension off, ws ignores the flag entirely.)
  const write = (s: string): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(s, { compress: s.length >= COMPRESS_THRESHOLD });
  };
  const send = (m: ServerMsg): void => {
    write(encodeMsg(m));
  };
  // the room encodes a broadcast ONCE and hands every recipient the same string —
  // see `Client.sendRaw` in room.ts for why that matters in a 2v2. This is the only
  // place that knows the string is already a serialized ServerMsg.
  const sendRaw = (s: string): void => {
    write(s);
  };
  /** what this socket still owes the kernel. The room reads it to coalesce snapshots for
   *  a client that has stopped draining — see `Client.backlog` in room.ts. */
  const backlog = (): number => ws.bufferedAmount;
  // a late joiner during a pending restart still gets the countdown banner
  if (noticeLive() && currentNotice) send(currentNotice);

  // Join (or create) a room. Async because a region-coded code may name a ranked
  // match the designated matchmaker STAGED in Postgres: the first joiner claims it
  // (atomic delete-returning) and makes the room authoritative from that roster, and
  // we verify identity BEFORE adding so a ranked room can map each driver to a roster
  // slot by user id. The registry slot is claimed synchronously (before any await) so
  // a racing second joiner finds the same room instead of creating a duplicate.
  const joinRoom = async (msg: Extract<ClientMsg, { t: 'join' }>): Promise<void> => {
    const code = msg.room.toLowerCase();
    let r = rooms.get(code);
    let created = false;
    // sanitize the untrusted room game to a known id (unknown ⇒ 'decode'); the room
    // resolves its sim module from this, and a mismatched joiner is refused below.
    const cfg: RoomConfig = {
      ...(msg.config ?? DEFAULT_ROOM_CONFIG),
      game: msg.config?.game === 'chain' ? 'chain' : 'decode',
    };
    if (!r && MAX_ROOMS > 0 && rooms.size >= MAX_ROOMS) {
      // AT CAPACITY. Refuse to HOST anything new; joining a room that already exists
      // here is always allowed, because that player's partner is already on this
      // machine and bouncing them would break a room that is under way.
      //
      // `code` lets a new client offer another region — the same room code is joinable
      // elsewhere, so this is a "try over there", not a dead end. `message` stays
      // self-sufficient for every client that predates the field.
      console.warn(`[admit] refused room ${code}: at cap (${rooms.size}/${MAX_ROOMS})`);
      send({
        t: 'error',
        code: 'region_full',
        message: 'This region is busy. Pick a different region and try again.',
      });
      return;
    }
    if (!r) {
      r = new Room(
        code,
        () => rooms.delete(code),
        cfg,
        persistMatch,
        (uid) => userRoom.set(uid, code),
        (uid) => {
          if (userRoom.get(uid) === code) userRoom.delete(uid);
        },
        persistDodges,
      );
      // tag a freshly-created room with the creator's group (the Discord Activity
      // instance) so the lobby browser can list this activity's rooms. Sanitized:
      // the id is untrusted, so clamp to a bounded, safe token. Only set on
      // creation — a joiner never changes an existing room's group.
      if (typeof msg.group === 'string') {
        r.group = msg.group.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 64);
      }
      rooms.set(code, r);
      created = true;
    }
    const theRoom = r;
    /**
     * GIVE BACK A ROOM THIS ATTEMPT CLAIMED AND NEVER FILLED.
     *
     * The registry slot is taken SYNCHRONOUSLY, before any await, so a racing second
     * joiner finds this room instead of opening a duplicate under the same code. The
     * joiner itself is only added several awaits later, and every path between the two
     * has to be able to hand the slot back — otherwise the room is counted against
     * `MAX_ROOMS` for the lifetime of the process, and a client that opens a socket,
     * sends `join`, and closes can exhaust the cap 24 times in a second. That is the
     * whole failure: `ws.on('close')` fires while `room` is still null, so its
     * `room?.detach` runs nothing, and Room's own `onEmpty` teardown is only ever
     * reached THROUGH detach.
     *
     * `rooms.get(code) === r` because the room we created may already have been deleted
     * and re-created by a later attempt; `isAbandonable()` because somebody else may
     * have joined it while we were awaiting, and because a room that has claimed a
     * STAGED ranked match must reap itself on its own grace instead (see room.ts).
     */
    const abandon = (): void => {
      if (created && rooms.get(code) === theRoom && theRoom.isAbandonable()) rooms.delete(code);
    };
    // Room codes are KIND-SCOPED: a custom (versus) code must never admit a
    // duo-record joiner, or vice-versa (both mint codes from the same generator, so
    // a shared/typo'd code could otherwise drop you into the wrong game mode — wrong
    // capacity, alliance layout, and leaderboard). The client sends its intended
    // config on every join; when the code already names a room, its config wins and a
    // mismatched joiner is refused. (A just-created room can't mismatch — its config
    // IS the joiner's.)
    if (!created) {
      const want = cfg;
      if (
        r.config.kind !== want.kind ||
        r.config.record !== want.record ||
        (r.config.game ?? 'decode') !== (want.game ?? 'decode')
      ) {
        send({ t: 'error', message: 'That code is for a different game mode.' });
        return; // unreachable for a just-created room — its config IS the joiner's
      }
    }
    if (created && dbEnabled) {
      const pending = await takePendingMatch(code).catch(() => null);
      if (pending) r.applyPending(pending);
    }
    let user: Awaited<ReturnType<typeof verifyAuthToken>> = null;
    if (msg.authToken) user = await verifyAuthToken(msg.authToken).catch(() => null);
    // the socket went away mid-join, or a concurrent frame already placed it — either
    // way nobody is going to occupy what this attempt claimed
    if (closed || room) {
      abandon();
      return;
    }
    // MAINTENANCE: refuse new games while the window is biting. Enforced HERE, not
    // only in the client's start guard — the lockdown exists to protect a migration
    // mid-flight, and a guard anyone can skip by holding a stale tab is not one.
    // A room the matchmaker staged is exempt for the same reason it beats the
    // one-live-game guard: the server already committed those players to it.
    await refreshMaintenance();
    if (lockedOut(user?.userId) && !r.stagedFor(user?.userId ?? '')) {
      send({ t: 'error', message: lockoutMessage() });
      abandon();
      return;
    }
    if (!r.canJoin()) {
      send({ t: 'error', message: 'Room is full or a match is already in progress.' });
      abandon(); // don't leave an empty just-created room behind
      return;
    }
    // one live game per user: refuse a second game while one is in progress (they
    // rejoin/leave it from Home). Reconnects use `rejoin`, so this never blocks
    // returning to your OWN match.
    //
    // ONE EXCEPTION, and it is the whole point of the background queue: a room the
    // MATCHMAKER STAGED FOR THIS USER is not a second game they chose to start — it
    // is the match the server has already committed them to, and it is about to
    // cost them ELO. Get matched while a solo record run is still in flight and the
    // run's slot is held for the reconnect grace, so this guard would refuse the
    // ranked join and turn "matched out of a background queue" into an automatic
    // forfeit. The staged roster is the server's own record of who belongs here, so
    // it wins: release the stale slot and let them in. (The abandoned room finalizes
    // on its own grace; its `onUserInactive` is code-scoped, so it can't then clear
    // the lock this match takes out.)
    if (user && activeElsewhere(user.userId, code)) {
      if (r.stagedFor(user.userId)) {
        userRoom.delete(user.userId);
      } else {
        send({ t: 'error', message: 'You already have a game in progress - rejoin or leave it first.' });
        abandon();
        return;
      }
    }
    room = r;
    const client: Client = {
      id,
      send,
      sendRaw,
      backlog,
      // NEVER trust the wire spec: sanitize the whole player to legal ranges
      // before it lands on the roster (a spoofed devtools spec is clamped here)
      player: { ...sanitizePlayer(msg.player, cfg.game), clientId: id },
      connected: true,
      disconnectAt: 0,
      // protocol capabilities this client build understands (mixed-version safe:
      // the room only opens the strategy window if EVERY member supports it)
      caps: Array.isArray(msg.caps) ? msg.caps : [],
      // release channel: alpha rooms are segregated + never persisted (in-dev)
      channel: typeof msg.channel === 'string' ? msg.channel : undefined,
    };
    if (user) {
      client.userId = user.userId;
      client.player.name = user.handle;
      // Supporter badge, resolved once at join rather than per broadcast. A lapse
      // mid-match therefore keeps the badge until the next join, which is the
      // right trade: the alternative is a database read on every roster frame.
      // Never fatal — a DB hiccup costs a badge, not a join.
      if (dbEnabled) {
        const ent = await getSupporter(user.userId).catch(() => null);
        if (ent?.supporter) client.player.supporter = true;
        // staff badge rides the same read — `getSupporter` already returns the
        // role, so this costs nothing extra
        if (ent?.role) client.player.role = ent.role;
      }
      markAuthed(user.userId);
    }
    // LAST GAP: the supporter lookup above is another await, and a socket that went away
    // inside it would be added to a room that will never hear its close (detach finds no
    // client and returns before `onEmpty`). Nothing may await between here and `add`.
    if (closed) {
      abandon();
      return;
    }
    room.add(client);
    conn = client.conn ?? 0; // remember which socket-generation owns our slot
    room.maybeStartRanked(); // no-op unless a staged ranked room is now fully present
  };

  // inbound rate bucket for this socket — see MSG_RATE_LIMIT
  let msgWindow = 0;
  let msgCount = 0;
  ws.on('message', (data: unknown) => {
    // RATE LIMIT FIRST, before `String(data)` and the parse — the point is to not pay for
    // a flood, and both of those are the cost being defended against.
    const now = Date.now();
    if (now - msgWindow >= 1000) {
      msgWindow = now;
      msgCount = 0;
    }
    msgCount++;
    if (msgCount > MSG_RATE_LIMIT) {
      if (msgCount > MSG_RATE_KILL) {
        console.warn(`[rate] closing ${id}: ${msgCount} messages in one second`);
        ws.close(1008, 'rate');
      }
      return;
    }
    let msg;
    try {
      msg = decodeClientMsg(String(data));
    } catch {
      return; // ignore malformed frames
    }
    // never let a bad message take down the process (and every other room)
    try {
      if (msg.t === 'ping') {
        // latency probe — echo the client's timestamp straight back so it can
        // measure RTT for the connection-quality HUD (answered in lobby OR match)
        send({ t: 'pong', ts: msg.ts });
        return;
      }
      if (msg.t === 'join') {
        if (room) return; // already in a room on this connection
        void joinRoom(msg).catch((e) => console.error(`[server] join error from ${id}:`, e));
      } else if (msg.t === 'spectate') {
        if (room) return;
        const r = rooms.get(msg.room.toLowerCase());
        if (!r) {
          send({ t: 'error', message: 'That match is no longer live.' });
          return;
        }
        // ADMISSION CONTROL FOR WATCHERS. A spectator costs the same 30 Hz snapshot stream
        // a driver does and passes none of the checks a driver does — no room cap (the room
        // already exists), no roster slot, no sign-in — so the two caps are the only thing
        // between a shared match link and an unbounded broadcast. Per-room first, because
        // one popular match is the realistic shape; machine-wide as well, because
        // `MAX_ROOMS` bounds rooms, not audiences, and the sum is what the event loop pays.
        //
        // NOT `region_full`: that code tells the client to try a different region, which is
        // exactly wrong here — the room is on THIS machine and exists nowhere else. This is
        // the plain-message refusal every client since the first build already renders.
        if (r.spectatorCount() >= MAX_SPECTATORS_PER_ROOM || spectatorTotal >= MAX_SPECTATORS) {
          send({ t: 'error', message: 'This match already has as many spectators as it can carry. Try again in a moment.' });
          return;
        }
        const spec = {
          id,
          send,
          sendRaw,
          backlog,
          player: { ...sanitizePlayer(undefined, r.config.game), clientId: id },
          connected: true,
          disconnectAt: 0,
          caps: Array.isArray(msg.caps) ? msg.caps : [],
        };
        room = r; // route this socket's close → r.detach (drops the spectator)
        // HIDDEN OBSERVER: an admin may watch without moving the spectator count.
        // The flag is NEVER taken from the message — `hidden: true` off the wire
        // would let anyone make themselves invisible. It is set only after this
        // server verifies the JWT and finds the subject in ADMIN_USER_IDS. Attach
        // immediately either way so a slow/failed verify never costs the admin the
        // start of the match; the count is corrected the moment it resolves.
        if (typeof msg.authToken === 'string' && msg.authToken) {
          void verifyAuthToken(msg.authToken)
            .then((u) => {
              if (u && ADMIN_IDS.has(u.userId)) r.hideSpectator(id);
            })
            .catch(() => {});
        }
        spectating = true;
        spectatorTotal++;
        r.addSpectator(spec);
      } else if (msg.t === 'rejoin') {
        if (room) return;
        const r = rooms.get(msg.room.toLowerCase());
        // hand over EVERY sender, not just `send` — see the note in `Room.reattach`
        const nc = r ? r.reattach(msg.clientId, send, sendRaw, backlog) : null;
        if (r && nc !== null) {
          liveSockets.delete(id);
          id = msg.clientId; // adopt the reclaimed identity on this socket
          liveSockets.set(id, { authed: !!authedUserId });
          room = r;
          conn = nc; // this socket now owns the slot (supersedes the dropped one)
        } else {
          send({ t: 'rejoined', ok: false });
        }
      } else if (msg.t === 'reportScore') {
        /**
         * A MISSCORE claim from this room. No target to resolve — see the protocol note —
         * so the only questions are who filed it and which match they were looking at.
         *
         * Answered `ok` unconditionally, like a player report and for the same reason: a
         * duplicate and a signed-out filer must be indistinguishable from a filed claim, or
         * the button becomes a probe. Unlike a player report it charges NOTHING on arrival:
         * an unreviewed claim about arithmetic is evidence of nothing until a moderator has
         * opened the replay, and the only standing that ever moves for it is the SMITE that
         * follows a rejection.
         */
        const sc = room ? room.resolveScoreReport(id) : null;
        const detail = typeof msg.detail === 'string' ? msg.detail.slice(0, REPORT_DETAIL_MAX).trim() : '';
        if (sc && detail && dbEnabled) {
          void submitScoreReport({
            reporterId: sc.reporterId,
            matchId: sc.matchId,
            roomCode: sc.roomCode,
            game: room!.gameId,
            detail,
          }).catch((e) => console.error('[report] score report failed:', e));
        }
        send({ t: 'reported', ok: true });
      } else if (msg.t === 'report') {
        /**
         * A player reporting another driver in their room. The ROOM resolves the robot id
         * onto an account (see `Room.resolveReport`) — this handler never sees a user id
         * from the client, so a crafted message cannot report an arbitrary person.
         *
         * Always answered `ok`, including when nothing was written: a duplicate, an
         * anonymous target and an unknown robot are all indistinguishable to the reporter
         * by design. Telling them apart would turn the button into a probe for who is
         * signed in and who has already been reported.
         */
        const r = room && isReportReason(msg.reason) ? room.resolveReport(id, msg.robotId) : null;
        if (r && dbEnabled) {
          void submitReport({
            reportedId: r.reportedId,
            reporterId: r.reporterId,
            reason: msg.reason,
            detail: typeof msg.detail === 'string' ? msg.detail.slice(0, REPORT_DETAIL_MAX) : null,
            roomCode: room!.code,
            game: room!.gameId,
          })
            .then((fresh) => {
              // A NEW report (not a duplicate) nudges the reported player's standing. It is
              // the weakest evidence in the system — one person's opinion, filed in a temper
              // as often as not — so it moves the number a little, never restricts anything,
              // and is capped per match inside `applyStandingEvent`. What it is really for is
              // SURFACING someone to a moderator; the moderator upholding it is what bites.
              if (!fresh) return;
              return distinctReporters(r.reportedId, room!.code).then((count) =>
                chargeStanding(r.reportedId, 'report', {
                  game: room!.gameId,
                  roomCode: room!.code,
                  count,
                }),
              );
            })
            .catch((e) => console.error('[report] write failed:', e));
        }
        send({ t: 'reported', ok: true });
      } else if (msg.t === 'queue') {
        if (room) return; // already in a room/match
        // ranked REQUIRES a verified account (ELO/leaderboard only make sense with
        // an identity). Anonymous players can still use custom rooms, just not
        // ranked. Verify the JWT, then enqueue; on a match the matchmaker sets our
        // `room` so subsequent input routes there.
        verifyAuthToken(msg.authToken).then((u) => {
          if (!u) {
            send({ t: 'error', message: 'Sign in to play ranked.' });
            return;
          }
          if (lockedOut(u.userId)) {
            send({ t: 'error', message: lockoutMessage() });
            return;
          }
          // one live game per user: can't queue ranked while another game is live
          if (activeElsewhere(u.userId, '')) {
            send({ t: 'error', message: 'You already have a game in progress - rejoin or leave it first.' });
            return;
          }
          markAuthed(u.userId);
          const enqueueNow = (): void => {
          void verifyParty(u.userId, msg).then((party) => {
            if (party === 'bad-token') {
              // Never silently fall back to the OPEN queue here. The player asked
              // to play one specific person; quietly matching them against a
              // stranger for rating is worse than saying it didn't work.
              send({ t: 'error', message: 'That challenge expired - send a new one.' });
              return;
            }
            matchmaker.enqueue({
            id,
            send,
            // sanitize the ranked player's spec/assists too (same clamp as join)
            player: { ...sanitizePlayer(msg.player, msg.game === 'chain' ? 'chain' : 'decode'), name: u.handle ?? msg.player.name },
            userId: u.userId,
            mode: msg.mode,
            // the client's home region (Fly's x-region for its connection) + measured
            // access latency; the matchmaker estimates cross-region ping from these to
            // pick a fair host. Prefer the client's own measurement; if it failed
            // (empty — a cold satellite Anycast-fell-back to the warm primary), use the
            // SERVER-OBSERVED source region from fly-replay-src before defaulting to
            // THIS instance's region (iad) — otherwise every unprobed player lands on
            // iad and every match hosts one-sided.
            homeRegion: msg.homeRegion || edgeRegion || REGION,
            accessMs: msg.accessMs ?? 0,
            noWiden: msg.noWiden ?? false,
            caps: Array.isArray(msg.caps) ? msg.caps : [],
            // segregate the queue by GAME (a CR queuer never pairs into a DECODE room)
            game: msg.game === 'chain' ? 'chain' : 'decode',
            channel: typeof msg.channel === 'string' ? msg.channel : undefined,
            // segregate the pool by build too (two builds never share a match)
            build: typeof msg.build === 'string' ? msg.build : undefined,
            // "play a friend": only ever the VERIFIED token (see verifyParty) —
            // never the raw one off the wire
            party: party?.token,
            partyOnly: party?.partyOnly,
            partySize: party ? PARTY_SIZE : undefined,
            enqueuedAt: 0, // stamped by enqueue()
            expandBumps: 0,
            onRoom: (r) => {
              room = r; // dev/no-DB local fallback only
            },
            });
          });
          };
          // ACCOUNT STANDING gate — checked HERE rather than in the matchmaker, because a
          // locked player must never enter the pool at all. Refusing them at PAIRING time
          // would mean the other players had already been staged and would have to be
          // requeued, which costs the wrong people their minutes. Fails OPEN (see
          // `rankedLock`): a database that cannot answer must not lock everybody out.
          void rankedLock(u.userId).then((lock) => {
            if (!lock) {
              enqueueNow();
              return;
            }
            const tier = tierOf(lock.score);
            if ((Array.isArray(msg.caps) ? msg.caps : []).includes('standing')) {
              // a lock is a state with a CLOCK, so the client is sent the deadline and
              // counts it down itself rather than being handed a sentence that is wrong
              // thirty seconds later
              send({ t: 'standingLock', until: lock.until, score: lock.score, tier: tier.key });
            } else {
              send({
                t: 'error',
                message:
                  `Ranked is locked for another ${lockRemaining(lock.until, Date.now())} ` +
                  `- your account standing is ${tier.name.toLowerCase()}.`,
              });
            }
          });
        });
      } else if (msg.t === 'expandSearch') {
        matchmaker.expand(id);
      } else if (msg.t === 'leaveQueue') {
        matchmaker.remove(id);
      } else if (room) {
        room.onMessage(id, msg);
      }
    } catch (e) {
      console.error(`[server] error handling ${msg.t} from ${id}:`, e);
    }
  });

  ws.on('close', () => {
    closed = true; // an in-flight async join must stop and hand its room back
    onlineCount--;
    if (spectating) {
      spectating = false;
      spectatorTotal = Math.max(0, spectatorTotal - 1);
    }
    liveSockets.delete(id);
    if (authedUserId) {
      const n = (authedUsers.get(authedUserId) ?? 1) - 1;
      if (n <= 0) authedUsers.delete(authedUserId);
      else authedUsers.set(authedUserId, n);
    }
    matchmaker.remove(id); // drop from any ranked queue
    // lobby ⇒ leave; mid-match ⇒ hold the slot for a reconnect. `conn` lets the room
    // ignore this close if a newer socket already reclaimed the slot (fast reconnect).
    room?.detach(id, conn);
  });

  ws.on('error', () => {
    /* a close event follows; teardown happens there */
  });
});

// bind 0.0.0.0 explicitly — Fly (and most platforms) route to the app there, NOT
// localhost/127.0.0.1 (a bind to localhost is unreachable ⇒ 502 / "not listening").
// LISTEN FIRST so GET /health answers within the platform's boot window, THEN load
// the Rapier WASM: loading it before listen() left nothing bound to the port during
// the (sub-second, but real on a shared CPU) WASM init, so Fly saw "app not listening
// on 8080" and flapped the machine. A match can't start until physicsReady() (guarded
// in room.ts), so serving /health ahead of physics is safe.
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] DECODE game server listening on 0.0.0.0:${PORT}`);
/**
 * WHICH DEPLOYMENT, AND WHICH DATABASE. One line, at boot, because the single most
 * expensive mistake available here is an ALPHA server pointed at the PRODUCTION database:
 * everything would work, and test matches, test ratings and test standing charges would
 * quietly land in real boards. The host is printed (never the credentials) so the answer is
 * visible in `fly logs` instead of being inferred from behaviour.
 */
console.log(
  `[server] channel=${SERVER_CHANNEL} db=${
    process.env.DATABASE_URL
      ? (process.env.DATABASE_URL.match(/@([^/?]+)/)?.[1] ?? 'set')
      : 'none'
  }${LAN_MODE ? ' lan=1 (self-hosted: nothing here persists)' : ''}${
    isAlphaServer() ? ' (alpha results PERSIST here)' : ''
  }`,
);
});
initPhysics()
  .then(() => console.log('[server] Rapier physics ready - matches enabled'))
  .catch((e) => {
    console.error('[server] failed to init physics:', e);
    process.exit(1);
  });

// apply DB migrations at boot (off the hot path; no-ops without DATABASE_URL). A
// DB failure must NOT take the game server down — records just won't persist.
migrate()
  .then(async () => {
    console.log('[server] database ready');
    // Project ADMIN_USER_IDS / OWNER_USER_ID onto profiles.role. The env stays the
    // source of truth; this is what lets a badge be JOINED by the leaderboard and
    // roster queries instead of post-processed row by row (0020_staff_roles.sql).
    // Symmetric — an id removed from the env loses its role here.
    if (!dbEnabled) return;
    await syncStaffRoles(OWNER_ID, ADMIN_LIST);
    console.log(
      `[server] staff synced: ${OWNER_ID ? '1 owner' : 'no owner'}, ${Math.max(0, ADMIN_LIST.filter((id) => id !== OWNER_ID).length)} admin(s)`,
    );
  })
  .catch((e) => console.error('[server] migration failed (records disabled):', e));

/*
 * IDLE MEANS SILENT. Everything below is a recurring timer that touches Postgres,
 * and Neon bills COMPUTE HOURS: the compute suspends only after five consecutive
 * minutes with NO queries, and bills for every second it is awake. So a timer that
 * fires unconditionally does not cost "one small query" — it costs the entire
 * month of compute. `min_machines_running = 1` (fly.toml) keeps iad up forever, so
 * an unconditional beat there pinned the database on 24/7 whether or not a single
 * person was playing.
 *
 * Rule for anything added here: fire only when there is something to say.
 */
if (dbEnabled) {
  // Reap staged ranked matches nobody claimed (both clients vanished after assign).
  // Self-arming: rows only exist after THIS machine stages one (`stagePending`
  // below), so an idle machine sweeps nothing. A sweep that finds nothing left
  // disarms until the next match is staged. Rows orphaned by a crash are inert —
  // their code only ever went to the two clients, so nobody can claim them — and
  // the next staged match sweeps the whole table, so it still self-heals.
  const reaper = setInterval(() => {
    if (!pendingStaged) return;
    cleanupStalePending(60_000)
      .then((n) => {
        if (n === 0) pendingStaged = false;
      })
      .catch((e) => console.error('[server] pending cleanup:', e));
  }, 60_000);
  reaper.unref();

  // PRESENCE HEARTBEAT — publish this machine's live counts so /api/presence can
  // aggregate a GLOBAL total across regions. A stopped/crashed machine simply stops
  // beating and its row ages out of the freshness window; a restart with the same
  // FLY_MACHINE_ID overwrites its own row, so no ghosts accumulate.
  //
  // An EMPTY machine beats once to publish the zero and then goes quiet until
  // someone shows up. Nothing reads a missing row as anything but absent —
  // `globalPresence` already filters to rows updated inside its freshness window,
  // so silence and a zero row mean the same thing to every consumer.
  let lastBeatEmpty = false;
  const beat = (): void => {
    const qs = matchmaker.queueSizes();
    const empty =
      onlineCount === 0 && authedUsers.size === 0 && qs['1v1'] === 0 && qs['2v2'] === 0;
    if (empty && lastBeatEmpty) return; // nothing here, and we already said so
    lastBeatEmpty = empty;
    const snap = operatorSnapshot();
    upsertPresence(
      MACHINE, REGION, onlineCount, [...authedUsers.keys()], qs['1v1'], qs['2v2'],
      // live rooms ride the SAME beat, so "Watch Live" sees every region (0021).
      // UNFILTERED — the admin view reads this too, and a beat that had already
      // dropped custom/record rooms could not be widened back at the endpoint.
      localLive(),
      snap.players, snap.anon, matchmaker.queueSizesByGame(), snap.guests,
    ).catch((e) => console.error('[presence] heartbeat failed:', e));
  };
  beat();
  beatNow = beat;
  const hb = setInterval(beat, 5_000);
  hb.unref();
}

// WS heartbeat — reap ghost sockets (see socketAlive above). Every interval:
// terminate any socket that didn't pong since the last ping (fires 'close' → the
// normal matchmaker.remove + room.detach teardown), then ping the rest. A live
// client answers pong automatically at the protocol level (no app code needed).
// 15s cadence ⇒ a dead socket is gone within ~30s instead of lingering for the OS
// TCP timeout, so it can no longer pad a ranked bucket or hold a match slot.
const WS_HEARTBEAT_MS = 15_000;
const pinger = setInterval(() => {
  for (const ws of wss.clients) {
    if (socketAlive.get(ws) === false) {
      ws.terminate();
      continue;
    }
    socketAlive.set(ws, false);
    try {
      ws.ping();
    } catch {
      ws.terminate();
    }
  }
}, WS_HEARTBEAT_MS);
pinger.unref();
