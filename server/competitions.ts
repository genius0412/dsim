/**
 * COMPETITIONS — the server (migration 0059, `docs/area/competitions.md`).
 *
 * Three jobs, in this order in the file:
 *   1. WHO MAY DO WHAT. Site admins run everything today. A competition also has its own staff
 *      (organizers and referees), and creation is ONE policy (`mayCreate`), so opening
 *      competitions to the public is that function and a capacity cap, not a rewrite.
 *   2. THE HTTP API, `/api/competitions/*`, reached from `handleApi` (server/api.ts) behind the
 *      same closed-site write door as every other POST.
 *   3. THE ROOM HALF. A called match is a STAGED ROOM like a ranked pairing: the first join claims
 *      the call (`claimCompetitionRoom`) and the room builds its roster from it; the room reports a
 *      finished match through `persistMatch` and a call that never became a match through the
 *      dodge report. Nothing about a competition room rates anyone or charges standing.
 *
 * Everything derived (rankings, selection, the bracket's progress, placements) is recomputed from
 * the rows by the pure modules in `src/competition/` on every read. A write here changes rows and
 * nothing else; the next read says what it means.
 */
import type { IncomingMessage } from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { dbEnabled, type Tx } from './db/pool';
import * as db from './db/competitions';
import {
  addNotices,
  ensureProfile,
  getProfile,
  getSuspension,
  resolvePlayerTag,
  writeAudit,
  type NewNotice,
} from './db/repo';
import { emailGateRefusal, verifyAuthToken, type AuthedUser } from './auth';
import { ADMIN_IDS } from './staff';
import { moderateName } from './moderation';
import { MATCHMAKER_REGION } from './regions';
import { SERVER_CHANNEL } from './channel';
import type { CompetitionTag, PendingMatch, PendingRosterEntry } from './matchTypes';
import type { LiveRoom } from '../src/net/protocol';
import type { ReplayResult } from '../src/sim/replay';
import type { RobotSpec } from '../src/types';
import { isGameId, serverPhysics, type GameId } from '../src/games/types';
import { simModuleFor } from '../src/games/sim';
import { gameVisibleOn } from '../src/seasons';
import { DEFAULT_ASSISTS, DEFAULT_SPEC } from '../src/sim/spawn';
import { BB_DEFAULT_SPEC } from '../src/games/biobuzz/coerce';
import { cleanMessage, type CompNoticeData, type MatchResult } from '../src/notices';
import {
  coerceCompSettings,
  coerceTeamMode,
  entriesPerAlliance,
  LIMITS,
  slugify,
} from '../src/competition/settings';
import { computeRankings, effectiveDq, matchRp, seedOrder } from '../src/competition/rankings';
import { cmTable, coerceFacts, effectiveRanking, unreachableBonus } from '../src/competition/manual';
import { applySelection, selectionState, serpentineAlliances, type Selection } from '../src/competition/selection';
import { bracketState, buildBracket, type BracketState } from '../src/competition/bracket';
import { drawBalanced, drawRoundRobin, drawSwissRound } from '../src/competition/schedule';
import { matchLabel } from '../src/competition/wire';
import { CALL_FAILED, type CallFailure } from '../src/competition/copy';
import type {
  CompEntryView,
  CompetitionDetail,
  CompetitionFull,
  CompLogView,
  CompMatchView,
  CompPlayer,
  CompViewer,
  MyCompetition,
} from '../src/competition/wire';
import { TIEBREAKERS } from '../src/competition/types';
import type {
  Alliance,
  AllianceFacts,
  CardColour,
  CompEntryCore,
  CompResult,
  CompRole,
  CompSettings,
  CompSlot,
  CompStatus,
  CompetitionSummary,
  DqReason,
  EffectiveDq,
  EntryStatus,
  MatchRp,
  PlayoffAlliance,
  RankRow,
  ResolvedBonus,
  ResolvedRanking,
  RpLevel,
  SelectionAction,
  SeriesSpec,
  Tiebreaker,
  Winner,
} from '../src/competition/types';

// =====================================================================================
// 1. WHO MAY DO WHAT
// =====================================================================================

/**
 * WHO MAY CREATE A COMPETITION. One function, so opening creation up is a change here and in
 * nothing else. `COMPETITION_CREATORS`:
 *   - unset or `admins`: site admins only (today);
 *   - `signed-in`: any account in good standing, capped at `OPEN_CAP` unfinished ones;
 *   - `group:<name>`: reserved for an access group; until access groups are read here it means
 *     admins only, which is the safe direction for an unknown policy to fail in.
 * A competition made by an admin is OFFICIAL; one made by anybody else is not, and says so.
 */
const CREATE_POLICY = (process.env.COMPETITION_CREATORS ?? 'admins').trim();
const OPEN_CAP = 3;

export function isAdmin(userId: string | null | undefined): boolean {
  return !!userId && ADMIN_IDS.has(userId);
}

async function mayCreate(userId: string): Promise<string | null> {
  if (isAdmin(userId)) return null;
  if (CREATE_POLICY !== 'signed-in') return 'Only DSIM staff can create competitions right now.';
  const susp = await getSuspension(userId);
  if (susp.until) return 'A suspended account can’t create competitions.';
  if ((await db.openCompetitionsBy(userId)) >= OPEN_CAP) {
    return `You already run ${OPEN_CAP} competitions that haven’t finished. Finish or cancel one first.`;
  }
  return null;
}

/** the viewer's role on one competition: site admin, its own staff, or its non-admin creator */
async function roleFor(comp: db.CompRow, userId: string | null): Promise<CompRole | null> {
  if (!userId) return null;
  if (isAdmin(userId)) return 'admin';
  if (comp.createdBy === userId) return 'organizer';
  return dbEnabled ? db.staffRoleOf(comp.id, userId) : null;
}

/** organizers run the competition; referees run its matches */
const canManage = (r: CompRole | null): boolean => r === 'admin' || r === 'organizer';
const canReferee = (r: CompRole | null): boolean => r === 'admin' || r === 'organizer' || r === 'referee';

// =====================================================================================
// small helpers
// =====================================================================================

class Refusal extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}
const refuse = (code: number, message: string): never => {
  throw new Refusal(code, message);
};

const RUNNING: CompStatus[] = ['qualification', 'selection', 'playoffs'];

/** the region a competition's rooms are hosted in */
const regionOf = (c: db.CompRow): string => (c.region && /^[a-z]{3}$/.test(c.region) ? c.region : MATCHMAKER_REGION);

/** a competition room code: region-coded so the proxy routes a join to the room's machine, and a
 *  shape of its own so a gone match is refused rather than opened as an empty custom room */
export function competitionRoomCode(region: string): string {
  const tail = [...randomBytes(8)].map((b) => (b % 36).toString(36)).join('');
  return `${region}-cm${tail}`;
}
const COMP_CODE = /^[a-z]{3}-cm[0-9a-z]{8}$/;
export function isCompetitionRoomCode(code: string): boolean {
  return COMP_CODE.test(code);
}

function baselineSpec(game: GameId): RobotSpec {
  return game === 'biobuzz' ? BB_DEFAULT_SPEC : DEFAULT_SPEC;
}

/** what the settings column says, made safe for this competition's shape and game */
const settingsOf = (c: db.CompRow): CompSettings => coerceCompSettings(c.settings, c.format, c.teamMode, c.game);

const RP_LEVELS: readonly RpLevel[] = ['event', 'regional', 'championship', 'custom'];

/**
 * THE RANKING RULES FROZEN AT THE START OF QUALIFICATIONS (`competitions.rp_table`), checked
 * before use: `effectiveRanking` hands a frozen copy back as it is, and `computeRankings` walks
 * its lists on every read. A copy of any other shape is ignored whole, and the live table is read
 * instead — half a table would rank by rules nobody chose.
 */
function frozenOf(raw: unknown): ResolvedRanking | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (r.scheme !== 'cm' || !num(r.win) || !num(r.tie) || !num(r.loss)) return null;
  if (!Array.isArray(r.bonus) || !Array.isArray(r.measures) || !Array.isArray(r.tiebreakers)) return null;
  if (!r.measures.every((m) => typeof m === 'string')) return null;
  const bonus: ResolvedBonus[] = [];
  for (const raw2 of r.bonus as unknown[]) {
    const b = raw2 && typeof raw2 === 'object' ? (raw2 as Record<string, unknown>) : null;
    if (!b || typeof b.id !== 'string' || typeof b.measure !== 'string' || !num(b.threshold)) return null;
    if (typeof b.award !== 'boolean' || typeof b.deny !== 'boolean') return null;
    if (b.awardFact !== undefined && typeof b.awardFact !== 'string') return null;
    bonus.push({
      id: b.id,
      measure: b.measure,
      threshold: b.threshold,
      ...(typeof b.awardFact === 'string' ? { awardFact: b.awardFact } : {}),
      award: b.award,
      deny: b.deny,
    });
  }
  return {
    scheme: 'cm',
    level: RP_LEVELS.includes(r.level as RpLevel) ? (r.level as RpLevel) : 'event',
    source: typeof r.source === 'string' ? r.source : null,
    win: r.win,
    tie: r.tie,
    loss: r.loss,
    bonus,
    tiebreakers: (r.tiebreakers as unknown[]).filter((t): t is Tiebreaker => TIEBREAKERS.includes(t as Tiebreaker)),
    measures: r.measures as string[],
  };
}

/** the ranking rules this competition applies: the frozen copy once qualifications started, else
 *  its settings against the game's manual table */
const rankingOf = (c: db.CompRow, s: CompSettings): ResolvedRanking => effectiveRanking(s, c.game, frozenOf(c.rpTable));

const nameOfEntry = (e: db.EntryRow): string => e.name || e.handle || 'Entry';

/** every account an entry puts on the field: the captain, then an accepted partner */
function usersOf(e: db.EntryRow): string[] {
  const out: string[] = [];
  if (e.userId) out.push(e.userId);
  if (e.partnerId && e.status !== 'pending') out.push(e.partnerId);
  return out;
}

const PLAYING: EntryStatus[] = ['registered'];

function player(id: string | null, handle: string | null, username: string | null, role: unknown, supporter: unknown, badges: unknown): CompPlayer {
  return {
    userId: id,
    handle: handle ?? 'Deleted account',
    username,
    role: role === 'owner' || role === 'admin' ? role : null,
    supporter: !!supporter,
    badges: Array.isArray(badges) ? (badges as CompPlayer['badges']) : null,
  };
}

// =====================================================================================
// THE DERIVED STATE — everything a read computes from the rows
// =====================================================================================

interface CompState {
  comp: db.CompRow;
  settings: CompSettings;
  /** the ranking rules applied (`rankingOf`) */
  ranking: ResolvedRanking;
  entries: db.EntryRow[];
  matches: db.MatchRow[];
  specs: SeriesSpec[];
  rankings: RankRow[] | null;
  /** the playoff seeding order: frozen at the end of qualifications, else as it stands */
  order: number[];
  selection: Selection | null;
  alliances: PlayoffAlliance[] | null;
  bracket: BracketState | null;
}

const entryCore = (e: db.EntryRow): CompEntryCore => ({
  id: e.id,
  status: e.status,
  seed: e.seed,
  registeredAt: e.registeredAt,
});

async function loadState(comp: db.CompRow): Promise<CompState> {
  const [entries, matches, specs] = await Promise.all([
    db.listEntries(comp.id),
    db.listMatches(comp.id),
    db.listSeries(comp.id),
  ]);
  return derive(comp, entries, matches, specs);
}

function derive(comp: db.CompRow, entries: db.EntryRow[], matches: db.MatchRow[], specs: SeriesSpec[]): CompState {
  const settings = settingsOf(comp);
  const ranking = rankingOf(comp, settings);
  const cores = entries.map(entryCore);
  const quals = matches.filter((m) => m.stage === 'qual');
  const rankings = quals.length ? computeRankings(cores, quals, ranking, comp.rngSeed) : null;
  const order = comp.seedOrder ?? seedOrder(cores, rankings);
  const perAlliance = entriesPerAlliance(comp.format, comp.teamMode);
  const n = settings.playoffs.alliances;
  let selection: Selection | null = null;
  let alliances: PlayoffAlliance[] | null = comp.alliances;
  if (!alliances && settings.playoffs.enabled && (comp.status === 'selection' || comp.status === 'qualification')) {
    if (perAlliance === 2 && settings.playoffs.selection === 'captains') {
      if (comp.status === 'selection') {
        selection = selectionState(order, n, comp.selection);
        alliances = selection.alliances;
      }
    } else if (order.length >= n * perAlliance) {
      alliances = serpentineAlliances(order, n, perAlliance);
    }
  }
  const bracket =
    specs.length && comp.alliances
      ? bracketState(specs, comp.alliances, matches.filter((m) => m.stage === 'playoff'))
      : null;
  return { comp, settings, ranking, entries, matches, specs, rankings, order, selection, alliances, bracket };
}

const qualsOf = (st: CompState): db.MatchRow[] => st.matches.filter((m) => m.stage === 'qual');

/** one entry's card in one match, the sim's and a referee's together (as `rankings.ts` reads it) */
function colourIn(m: db.MatchRow, entry: number): CardColour | null {
  const a = m.cards?.[String(entry)];
  const b = m.refCards?.[String(entry)];
  if (a === 'red' || b === 'red') return 'red';
  const yellows = (a === 'yellow' ? 1 : 0) + (b === 'yellow' ? 1 : 0);
  return yellows >= 2 ? 'red' : yellows === 1 ? 'yellow' : null;
}

/** the order cards escalate in: first decided first, a match with no time last (`effectiveDq`) */
function byDecided(a: db.MatchRow, b: db.MatchRow): number {
  const ta = a.finishedAt ?? Infinity;
  const tb = b.finishedAt ?? Infinity;
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.number - b.number || a.id - b.id;
}

/** a forfeit's log line names the entries it disqualified: `dq` (names, what the log prints) and
 *  `dqEntries` (ids, which `deleteAccount` scrubs the names by) */
function dqLog(st: CompState, ids: number[]): { dq?: string[]; dqEntries?: number[] } {
  if (!ids.length) return {};
  const byId = new Map(st.entries.map((e) => [e.id, e]));
  return { dq: ids.map((id) => { const e = byId.get(id); return e ? nameOfEntry(e) : `Entry ${id}`; }), dqEntries: ids };
}

/** the entries of a match that are not in the competition any more (R7: they take nothing from it) */
function leftEntries(st: CompState, m: db.MatchRow): number[] {
  const status = new Map(st.entries.map((e) => [e.id, e.status]));
  return [...new Set([...m.red, ...m.blue].map((s) => s.entry))].filter((id) => status.get(id) !== 'registered');
}

/** "Q12", "SF1-2": the label each match carries */
function labelsOf(s: CompState): Map<number, string> {
  const out = new Map<number, string>();
  const bySeries = new Map<string, db.MatchRow[]>();
  for (const m of s.matches) {
    if (m.stage === 'qual') out.set(m.id, matchLabel('qual', m.number));
    else if (m.series) {
      const list = bySeries.get(m.series) ?? [];
      list.push(m);
      bySeries.set(m.series, list);
    } else out.set(m.id, matchLabel('playoff', m.number));
  }
  const spec = new Map(s.specs.map((x) => [x.key, x]));
  for (const [key, list] of bySeries) {
    list.sort((a, b) => a.number - b.number);
    const sp = spec.get(key);
    list.forEach((m, i) => out.set(m.id, matchLabel('playoff', m.number, sp?.short ?? key, i + 1, sp?.bestOf ?? 1)));
  }
  return out;
}

// =====================================================================================
// LIVE ROOMS — supplied by server/index.ts, which owns the room registry and the presence beat
// =====================================================================================

type LiveFn = () => Promise<LiveRoom[]>;
let liveRooms: LiveFn = async () => [];
/** called once by `server/index.ts`, which knows every region's live rooms */
export function setCompetitionLive(fn: LiveFn): void {
  liveRooms = fn;
}

let liveCache: { at: number; rooms: Map<string, LiveRoom> } | null = null;
async function liveByCode(): Promise<Map<string, LiveRoom>> {
  if (liveCache && Date.now() - liveCache.at < 2000) return liveCache.rooms;
  let list: LiveRoom[] = [];
  try {
    list = await liveRooms();
  } catch (e) {
    console.warn('[comp] live room read failed:', e);
  }
  const rooms = new Map(list.map((r) => [r.room, r]));
  liveCache = { at: Date.now(), rooms };
  return rooms;
}

// =====================================================================================
// VIEWS — the rows as the wire carries them
// =====================================================================================

function summaryOf(c: db.CompRow): CompetitionSummary {
  return {
    id: c.id,
    slug: c.slug,
    name: c.name,
    game: c.game,
    format: c.format,
    teamMode: c.teamMode,
    status: c.status,
    visibility: c.visibility,
    official: c.official,
    summary: c.summary,
    capacity: c.capacity,
    entrants: c.entrants ?? 0,
    waitlist: c.waitlist ?? 0,
    regOpensAt: c.regOpensAt,
    regClosesAt: c.regClosesAt,
    checkinOpensAt: c.checkinOpensAt,
    startsAt: c.startsAt,
    createdAt: c.createdAt,
    completedAt: c.completedAt,
    champions: c.champions ?? [],
  };
}

function fullOf(c: db.CompRow, s: CompSettings): CompetitionFull {
  return {
    ...summaryOf(c),
    description: c.description,
    rules: c.rules,
    settings: s,
    region: c.region,
    createdBy: c.createdBy,
    startedAt: c.startedAt,
    cancelledAt: c.cancelledAt,
    updatedAt: c.updatedAt,
  };
}

function entryView(e: db.EntryRow, staff: boolean): CompEntryView {
  const players: CompPlayer[] = [];
  players.push(player(e.userId, e.handle, e.username, e.role, e.supporter, e.badges));
  const partner = e.partnerId
    ? player(e.partnerId, e.partnerHandle, e.partnerUsername, e.partnerRole, e.partnerSupporter, e.partnerBadges)
    : null;
  if (partner && e.status !== 'pending') players.push(partner);
  return {
    id: e.id,
    status: e.status,
    name: nameOfEntry(e),
    number: e.number,
    checkedIn: e.checkedInAt !== null,
    seed: e.seed,
    placement: e.placement,
    registeredAt: e.registeredAt,
    players,
    ...(e.status === 'pending' ? { invited: partner } : {}),
    ...(staff ? { note: e.note } : {}),
  };
}

// =====================================================================================
// REGISTRATION RULES
// =====================================================================================

/** is sign-up open right now (status and window), ignoring who is asking */
function registrationOpen(c: db.CompRow, now = Date.now()): string | null {
  if (c.status === 'draft') return 'This competition isn’t published yet.';
  if (c.status !== 'published') return 'Registration has closed.';
  if (c.regOpensAt && now < c.regOpensAt) return 'Registration hasn’t opened yet.';
  if (c.regClosesAt && now >= c.regClosesAt) return 'Registration has closed.';
  return null;
}

function checkInOpen(c: db.CompRow, s: CompSettings, now = Date.now()): boolean {
  return s.checkIn && c.status === 'published' && (c.checkinOpensAt === null || now >= c.checkinOpensAt);
}

/** the entries that will play: registered, and checked in where check-in is required */
function eligibleEntries(st: CompState): db.EntryRow[] {
  return st.entries.filter((e) => e.status === 'registered' && (!st.settings.checkIn || e.checkedInAt !== null));
}

// =====================================================================================
// THE DETAIL READ
// =====================================================================================

async function viewerOf(st: CompState, user: AuthedUser | null, role: CompRole | null): Promise<CompViewer> {
  const uid = user?.userId ?? null;
  const mine = uid ? st.entries.find((e) => e.status !== 'withdrawn' && (e.userId === uid || (e.partnerId === uid && e.status !== 'pending'))) : undefined;
  const invite = uid ? st.entries.find((e) => e.status === 'pending' && e.partnerId === uid) : undefined;
  let registerBlock: string | null = registrationOpen(st.comp);
  if (!registerBlock && !uid) registerBlock = 'Sign in to register.';
  if (!registerBlock && mine) registerBlock = 'You’re already entered.';
  if (!registerBlock && invite) registerBlock = 'You have an invitation waiting. Accept or decline it first.';
  let canPick = false;
  if (st.selection && st.selection.turn !== null && mine) {
    const turn = st.selection.alliances[st.selection.turn];
    canPick = !!turn && turn.entries[0] === mine.id;
  }
  return {
    signedIn: !!uid,
    role,
    entryId: mine?.id ?? null,
    inviteEntryId: invite?.id ?? null,
    canRegister: registerBlock === null,
    registerBlock,
    canCheckIn: !!mine && mine.status === 'registered' && mine.checkedInAt === null && checkInOpen(st.comp, st.settings),
    canPick,
  };
}

async function detailOf(comp: db.CompRow, user: AuthedUser | null): Promise<CompetitionDetail> {
  const role = await roleFor(comp, user?.userId ?? null);
  const staff = canReferee(role);
  const st = await loadState(comp);
  const [staffRows, log, live] = await Promise.all([db.listStaff(comp.id), db.listLog(comp.id, staff), liveByCode()]);
  const labels = labelsOf(st);
  const graceMs = st.settings.run.joinGraceSec * 1000;
  // the card escalation is derived over every qualification match at once, so each match's view
  // agrees with the rankings about who takes nothing from it
  const eff = effectiveDq(qualsOf(st));
  const matches: CompMatchView[] = st.matches.map((m) => {
    const room = m.status === 'called' && m.roomCode ? live.get(m.roomCode) : undefined;
    return {
      id: m.id,
      stage: m.stage,
      round: m.round,
      number: m.number,
      series: m.series,
      red: m.red,
      blue: m.blue,
      status: m.status,
      result: m.result,
      dq: m.dq,
      label: labels.get(m.id) ?? `#${m.id}`,
      attempt: m.attempt,
      roomCode: m.roomCode,
      calledAt: m.calledAt,
      graceEndsAt: m.status === 'called' && m.calledAt ? m.calledAt + graceMs : null,
      finishedAt: m.finishedAt,
      replayId: m.replayId,
      note: m.note,
      ...(staff ? { callNote: m.callNote } : {}),
      live: room
        ? { phase: room.phase, timeLeft: room.timeLeft, score: room.score, spectators: room.spectators, region: room.region }
        : null,
      facts: m.facts,
      rulings: m.rulings,
      cards: m.cards,
      refCards: m.refCards,
      ...(m.stage === 'qual' ? { rp: matchRp(m, st.ranking, eff.get(m.id)), dqEffective: eff.get(m.id) ?? [] } : {}),
    };
  });
  const actorIds = [...new Set(log.map((l) => l.actor).filter((a) => a !== 'system' && a !== 'secret'))];
  const names = new Map<string, string>();
  for (const id of actorIds) {
    const p = await getProfile(id).catch(() => null);
    if (p) names.set(id, p.username ? `@${p.username}` : p.handle);
  }
  const logView: CompLogView[] = log.map((l) => {
    // `users` (account ids) is for `deleteAccount` to find the line by; no page prints it
    const { users: _users, ...data } = l.data;
    return {
      id: l.id,
      at: l.at,
      actor: l.actor === 'system' ? 'DSIM' : (names.get(l.actor) ?? (isAdmin(l.actor) ? 'DSIM staff' : 'Organizer')),
      kind: l.kind,
      data,
      public: l.public,
    };
  });
  return {
    competition: fullOf(comp, st.settings),
    entries: st.entries
      .filter((e) => staff || e.status !== 'pending' || e.userId === user?.userId || e.partnerId === user?.userId)
      .map((e) => entryView(e, staff)),
    matches,
    rankings: st.rankings,
    ranking: st.ranking,
    unreachable: unreachableBonus(st.ranking, comp.game, comp.format),
    selection: st.selection,
    alliances: st.alliances,
    bracket: st.bracket
      ? { series: st.bracket.series, placements: st.bracket.placements, champion: st.bracket.champion, complete: st.bracket.complete }
      : null,
    staff: staffRows.map((r) => ({
      ...player(r.userId, r.handle, r.username, r.staffRole, r.supporter, r.badges),
      role2: r.role,
    })),
    log: logView,
    viewer: await viewerOf(st, user, role),
    now: Date.now(),
  };
}

// =====================================================================================
// NOTICES — who is told what (never throws into a route; see server/notices.ts)
// =====================================================================================

/** a step after a write that already landed (a notice, and the read it needs): its failure is
 *  logged, never turned into an error for a change that was made */
async function afterWrite(what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`[comp] ${what} failed:`, e);
  }
}

async function notify(rows: NewNotice[]): Promise<void> {
  if (!dbEnabled || !rows.length) return;
  try {
    await addNotices(rows);
  } catch (e) {
    console.error('[comp] notices failed:', e);
  }
}

const noticeData = (c: db.CompRow, extra: Partial<CompNoticeData> = {}): Record<string, unknown> => ({
  slug: c.slug,
  name: c.name,
  ...extra,
});

/** a referee changed a result: tell every driver in the match, from their own side */
async function noticeResult(st: CompState, m: db.MatchRow, what: CompNoticeData['what'], label: string): Promise<void> {
  const byId = new Map(st.entries.map((e) => [e.id, e]));
  const rows: NewNotice[] = [];
  for (const [side, slots] of [['red', m.red], ['blue', m.blue]] as const) {
    for (const s of slots) {
      const e = byId.get(s.entry);
      if (!e) continue;
      const outcome: MatchResult | null =
        m.result && what !== 'void' && what !== 'reset'
          ? m.result.winner === 'tie'
            ? 'tie'
            : m.result.winner === side
              ? 'win'
              : 'loss'
          : null;
      const score =
        m.result && m.result.red !== null && m.result.blue !== null ? { red: m.result.red, blue: m.result.blue } : null;
      for (const userId of usersOf(e)) {
        rows.push({
          userId,
          kind: 'competition.result',
          game: st.comp.game,
          data: noticeData(st.comp, { label, what, outcome, score }),
        });
      }
    }
  }
  await notify(rows);
}

/**
 * A referee's facts or ruling moved the ranking points a match gave: tell each driver whose own
 * points from it changed, with the old and new number. Read per entry rather than per alliance, so
 * a surrogate or a disqualified entry (0 either way) is not told about points it never takes.
 */
async function noticeRp(st: CompState, label: string, before: MatchRp | null, after: MatchRp | null): Promise<void> {
  const byId = new Map(st.entries.map((e) => [e.id, e]));
  const rows: NewNotice[] = [];
  for (const key of new Set([...Object.keys(before?.entries ?? {}), ...Object.keys(after?.entries ?? {})])) {
    const was = before?.entries[key] ?? 0;
    const now = after?.entries[key] ?? 0;
    const e = byId.get(Number(key));
    if (was === now || !e) continue;
    for (const userId of usersOf(e)) {
      rows.push({ userId, kind: 'competition.rp', game: st.comp.game, data: noticeData(st.comp, { label, before: was, after: now }) });
    }
  }
  await notify(rows);
}

/** (match, entry) pairs a CARD disqualifies now that it did not before: what a card notice is about */
function newCardDqs(before: Map<number, EffectiveDq[]>, after: Map<number, EffectiveDq[]>): { match: number; entry: number; why: DqReason }[] {
  const out: { match: number; entry: number; why: DqReason }[] = [];
  for (const [match, list] of after) {
    for (const d of list) {
      if (d.why === 'dq' || (before.get(match) ?? []).some((x) => x.entry === d.entry)) continue;
      out.push({ match, entry: d.entry, why: d.why });
    }
  }
  return out;
}

/**
 * WHAT A CARD NOTICE SAYS (`competition.card`), for one entry's card in match `x` and the DQs it
 * newly caused (`pairs`, that entry's only). In order: the card costs `x` itself (a red, or a
 * second yellow); it is a surrogate appearance's card, counted against another match; it made a
 * LATER yellow the second one (a referee's card added to an early match); it is a surrogate card
 * with no match yet to count against (the next one will). `why` is absent when it costs nothing.
 */
function cardNoticeData(
  st: CompState,
  x: db.MatchRow,
  entry: number,
  colour: CardColour | null,
  pairs: { match: number; why: DqReason }[],
): Partial<CompNoticeData> {
  const labels = labelsOf(st);
  const labelOf = (id: number): string => labels.get(id) ?? `#${id}`;
  const label = labelOf(x.id);
  if (!colour) return { label, colour: null };
  const own = pairs.find((p) => p.match === x.id && (p.why === 'red' || p.why === 'yellow2'));
  if (own) return { label, colour, why: own.why as 'red' | 'yellow2' };
  const counted = pairs.find((p) => p.why === 'surrogate');
  if (counted) return { label, colour, why: 'surrogate', dqLabel: labelOf(counted.match) };
  const later = pairs.find((p) => p.why === 'yellow2');
  if (later) return { label: labelOf(later.match), colour: 'yellow', why: 'yellow2' };
  if ([...x.red, ...x.blue].some((s) => s.entry === entry && s.surrogate)) {
    // a surrogate card that costs a match (a red, or a yellow on top of one carried in) but changed
    // nothing new: the match it counts against was already lost, or there is none yet
    const before = qualsOf(st)
      .filter((m) => m.id !== x.id && m.status === 'done' && !!m.result && byDecided(m, x) < 0)
      .filter((m) => [...m.red, ...m.blue].some((s) => s.entry === entry))
      .sort(byDecided);
    const carried = before.some((m) => colourIn(m, entry) !== null);
    if (colour === 'red' || carried) {
      const earlier = before.filter((m) => [...m.red, ...m.blue].some((s) => s.entry === entry && !s.surrogate)).pop();
      return earlier ? { label, colour, why: 'surrogate', dqLabel: labelOf(earlier.id) } : { label, colour, why: 'surrogate' };
    }
  }
  return { label, colour };
}

async function noticeCard(st: CompState, entry: number, data: Partial<CompNoticeData>): Promise<void> {
  const e = st.entries.find((x) => x.id === entry);
  if (!e) return;
  await notify(usersOf(e).map((userId) => ({ userId, kind: 'competition.card', game: st.comp.game, data: noticeData(st.comp, data) })));
}

// =====================================================================================
// CALLING A MATCH
// =====================================================================================

/** the drivers a match puts in its room, by alliance, from entries still in the competition */
function rosterOf(st: CompState, m: db.MatchRow): { red: db.EntryRow[]; blue: db.EntryRow[] } {
  const byId = new Map(st.entries.map((e) => [e.id, e]));
  const side = (slots: CompSlot[]): db.EntryRow[] =>
    slots.map((s) => byId.get(s.entry)).filter((e): e is db.EntryRow => !!e && PLAYING.includes(e.status) && usersOf(e).length > 0);
  return { red: side(m.red), blue: side(m.blue) };
}

/**
 * CALL A MATCH (or call it again). Mints a fresh room code and a new attempt; the room itself is
 * built by the first driver to join. A side with nobody left to play (withdrawn, disqualified) is
 * decided here instead: one empty alliance forfeits, two void the match.
 */
async function callMatch(st: CompState, m: db.MatchRow, actor: string): Promise<{ called: boolean; note: string }> {
  const label = labelsOf(st).get(m.id) ?? `#${m.id}`;
  const stageOk = m.stage === 'qual' ? st.comp.status === 'qualification' : st.comp.status === 'playoffs';
  if (!stageOk) refuse(409, `${label} can’t be called while the competition is in ${st.comp.status}.`);
  if (m.status === 'done' || m.status === 'void') refuse(409, `${label} already has a result. Reset it first.`);
  const roster = rosterOf(st, m);
  if (!roster.red.length || !roster.blue.length) {
    if (!roster.red.length && !roster.blue.length) {
      await db.voidMatch(m.id, 'Nobody left to play it.');
      await db.addLog(st.comp.id, actor, 'match.void', { match: m.id, label, why: 'empty' });
      return { called: false, note: `${label} was voided: nobody left on either alliance.` };
    }
    const winner: Alliance = roster.red.length ? 'red' : 'blue';
    const dqAdd = m.stage === 'qual' ? leftEntries(st, m) : [];
    await db.writeResult(
      m.id,
      { red: null, blue: null, redFoul: 0, blueFoul: 0, winner, source: 'forfeit', note: 'The other alliance had nobody left to play.', dqAdd },
      { fromStatus: ['scheduled', 'called'] },
    );
    await db.addLog(st.comp.id, actor, 'match.forfeit', { match: m.id, label, winner, why: 'empty', ...dqLog(st, dqAdd.filter((e) => !m.dq.includes(e))) });
    await afterResult(st.comp.id);
    return { called: false, note: `${label} went to ${winner} by forfeit: the other alliance had nobody left.` };
  }
  const users = [...roster.red, ...roster.blue].flatMap(usersOf);
  const busy = await db.usersInCalledMatches(users, m.id);
  if (busy.size) {
    const who = [...roster.red, ...roster.blue].filter((e) => usersOf(e).some((u) => busy.has(u))).map(nameOfEntry);
    refuse(409, `${who.join(', ')} ${who.length === 1 ? 'is' : 'are'} already in another called match.`);
  }
  const code = competitionRoomCode(regionOf(st.comp));
  const attempt = await db.callMatchRow(m.id, code, ['scheduled', 'called']);
  if (attempt === null) refuse(409, `${label} changed while you were looking at it. Refresh and try again.`);
  await db.addLog(st.comp.id, actor, 'match.called', { match: m.id, label, attempt });
  const min = Math.max(1, Math.round(st.settings.run.joinGraceSec / 60));
  return { called: true, note: `${label} is called. Its drivers have ${min} minute${min === 1 ? '' : 's'} to join.` };
}

/**
 * THE FIRST JOIN OF A CALLED MATCH BUILDS ITS ROOM — `server/index.ts`'s join path asks this for
 * a code `takePendingMatch` did not know. Answers the staged match, or `null` when the code names
 * no call that can still be claimed (already claimed, re-called, finished), which the join path
 * refuses as a match that is over.
 */
export async function claimCompetitionRoom(code: string): Promise<PendingMatch | null> {
  if (!dbEnabled || !isCompetitionRoomCode(code)) return null;
  const claim = await db.claimRoom(code);
  if (!claim) {
    console.warn(`[comp] ${code}: no claimable call (already claimed, re-called or decided)`);
    return null;
  }
  /* A FAILURE AFTER THE CLAIM GIVES IT BACK. The join path retries a read that throws (Neon
     waking), and a retry that found the call already claimed — by itself, a moment ago — would
     refuse the match as over and leave it claimed with no room, for good. */
  try {
    return await buildClaimedRoom(code, claim);
  } catch (e) {
    console.error(`[comp] ${code}: building the room failed after the claim; releasing it:`, e);
    await db.unclaimRoom(claim.id, claim.attempt).catch(() => {});
    throw e;
  }
}

async function buildClaimedRoom(code: string, claim: { id: number; attempt: number; competitionId: string }): Promise<PendingMatch | null> {
  const comp = await db.getCompetition({ id: claim.competitionId });
  if (!comp) return null;
  const st = await loadState(comp);
  const m = st.matches.find((x) => x.id === claim.id);
  if (!m) return null;
  const label = labelsOf(st).get(m.id) ?? `#${m.id}`;
  const roster = rosterOf(st, m);
  const physics = serverPhysics(simModuleFor(comp.game));
  const spec = baselineSpec(comp.game);
  const out: PendingRosterEntry[] = [];
  for (const [alliance, entries] of [['red', roster.red], ['blue', roster.blue]] as const) {
    let seat = 0;
    for (const e of entries) {
      const names = [
        { id: e.userId, handle: e.handle },
        ...(e.partnerId && e.status !== 'pending' ? [{ id: e.partnerId, handle: e.partnerHandle }] : []),
      ];
      for (const n of names) {
        if (!n.id) continue;
        out.push({
          userId: n.id,
          name: n.handle ?? 'Player',
          teamName: nameOfEntry(e).slice(0, 40),
          teamNumber: e.number ?? 0,
          spec,
          assists: DEFAULT_ASSISTS,
          startIndex: seat++,
          alliance,
          introElo: null,
          channel: SERVER_CHANNEL,
          game: comp.game,
          physics,
        });
      }
    }
  }
  const tag: CompetitionTag = {
    id: comp.id,
    slug: comp.slug,
    name: comp.name,
    game: comp.game,
    matchId: m.id,
    label,
    attempt: claim.attempt,
    // what is LEFT of the call's wait: a room built two minutes into a three-minute call waits
    // one more, not three. Never less than a minute, so a late first join is not cut off at once.
    graceMs: Math.max(60_000, (m.calledAt ?? Date.now()) + st.settings.run.joinGraceSec * 1000 - Date.now()),
  };
  return {
    code,
    hostRegion: regionOf(comp),
    mode: comp.format,
    seed: randomInt(1, 2 ** 31 - 1),
    roster: out,
    ranked: false,
    game: comp.game,
    channel: SERVER_CHANNEL,
    physics,
    competition: tag,
  };
}

/** what the room measured, coerced to the game's own keys (internal flags included: this is the
 *  server's write). An alliance with nothing known is `{}`, and both unknown is null. */
function playedFacts(game: GameId, raw: Record<Alliance, Record<string, number>> | undefined): Record<Alliance, AllianceFacts> | null {
  if (!raw || typeof raw !== 'object') return null;
  const red = coerceFacts(game, raw.red, true);
  const blue = coerceFacts(game, raw.blue, true);
  return red || blue ? { red: red ?? {}, blue: blue ?? {} } : null;
}

/**
 * THE SIM'S CARDS, BY ENTRY (R4). The room reports carded DRIVERS; a duo puts two on the field, and
 * two yellows to one team in a match are a red (the manual cards the team, not the robot). Any red,
 * or two or more yellows across the entry's drivers, is 'red'; one yellow is 'yellow'. Null when
 * nobody in the match was carded.
 */
function playedCards(st: CompState, m: db.MatchRow, carded: { userId: string; colour: CardColour }[]): Record<string, CardColour> | null {
  const byId = new Map(st.entries.map((e) => [e.id, e]));
  const tally = new Map<number, { red: number; yellow: number }>();
  for (const c of carded) {
    if (c.colour !== 'red' && c.colour !== 'yellow') continue;
    for (const id of new Set([...m.red, ...m.blue].map((s) => s.entry))) {
      const e = byId.get(id);
      if (!e || !usersOf(e).includes(c.userId)) continue;
      const t = tally.get(id) ?? { red: 0, yellow: 0 };
      t[c.colour]++;
      tally.set(id, t);
    }
  }
  const out: Record<string, CardColour> = {};
  for (const [id, t] of tally) out[String(id)] = t.red > 0 || t.yellow >= 2 ? 'red' : 'yellow';
  return Object.keys(out).length ? out : null;
}

/**
 * A COMPETITION ROOM FINISHED ITS MATCH — called by `persistMatch` with the authoritative result
 * and whatever it managed to archive. Conditional on the attempt: a room from a call the referee
 * has since replaced (re-called, voided, entered by hand) finishes into nothing.
 *
 * `extra` is what the room measured (`MatchOutcome.rankFacts`) and the drivers it carded; both
 * optional, and the parameter itself defaults, because a caller that predates it (a test, an older
 * worker) must still record the result. The facts, the cards and the R7 DQs go in the one
 * conditional write. The competition's rows are read first only for the cards and the DQs; a read
 * that fails costs those, never the result.
 */
export async function competitionMatchPlayed(
  tag: CompetitionTag,
  result: ReplayResult,
  ids: { matchId?: string | null; replayId?: string | null },
  extra: { facts?: Record<Alliance, Record<string, number>>; cards?: { userId: string; colour: CardColour }[] } = {},
): Promise<void> {
  if (!dbEnabled) return;
  try {
    const r = result.score;
    const winner: Winner = r.red > r.blue ? 'red' : r.blue > r.red ? 'blue' : 'tie';
    let st: CompState | null = null;
    try {
      const comp = await db.getCompetition({ id: tag.id });
      st = comp ? await loadState(comp) : null;
    } catch (e) {
      console.warn(`[comp] ${tag.slug} ${tag.label}: could not read the competition before the result; writing it without cards:`, e);
    }
    const m = st?.matches.find((x) => x.id === tag.matchId);
    const cards = st && m ? playedCards(st, m, extra.cards ?? []) : undefined;
    const dqAdd = st && m && m.stage === 'qual' ? leftEntries(st, m) : [];
    const ok = await db.writeResult(
      tag.matchId,
      {
        red: r.red,
        blue: r.blue,
        redFoul: result.foulPoints.red,
        blueFoul: result.foulPoints.blue,
        winner,
        source: 'played',
        matchId: ids.matchId ?? null,
        replayId: ids.replayId ?? null,
        facts: playedFacts(tag.game, extra.facts),
        // replaced by every played write (undefined only when the read above failed)
        cards,
        dqAdd,
      },
      { attempt: tag.attempt, fromStatus: ['called'] },
    );
    if (!ok) {
      console.log(`[comp] ${tag.slug} ${tag.label}: result from attempt ${tag.attempt} ignored (the call moved on)`);
      return;
    }
    await db.addLog(tag.id, 'system', 'match.result', { match: tag.matchId, label: tag.label, red: r.red, blue: r.blue, winner });
    console.log(`[comp] ${tag.slug} ${tag.label}: red ${r.red} – blue ${r.blue}`);
    touch(tag.id);
    await afterResult(tag.id);
    if (st && m && cards && m.stage === 'qual') await afterWrite('card notices', () => noticePlayedCards(st!, tag.matchId, cards));
  } catch (e) {
    console.error('[comp] recording a played result failed:', e);
  }
}

/** tell the drivers whose cards in a played match cost them a match (`cardNoticeData`) */
async function noticePlayedCards(before: CompState, matchId: number, cards: Record<string, CardColour>): Promise<void> {
  const after = await loadState(before.comp);
  const x = after.matches.find((m) => m.id === matchId);
  if (!x) return;
  const fresh = newCardDqs(effectiveDq(qualsOf(before)), effectiveDq(qualsOf(after)));
  for (const key of Object.keys(cards)) {
    const entry = Number(key);
    const data = cardNoticeData(after, x, entry, colourIn(x, entry), fresh.filter((p) => p.entry === entry));
    // a played card that costs nothing is no news: the driver saw it shown in the match
    if (data.why) await noticeCard(after, entry, data);
  }
}

/**
 * A CALLED MATCH DID NOT BECOME A MATCH — the room's join grace or strategy window ran out, or a
 * driver left before the start (the room's dodge report). Nobody's standing is charged: a
 * competition decides its own consequences. With `noShow: 'forfeit'` and the fault on one
 * alliance only, that alliance forfeits; otherwise the match goes back on the schedule with a
 * note for the referee.
 */
export async function competitionCallFailed(
  tag: CompetitionTag,
  culprits: { userId: string; kind: string }[],
): Promise<void> {
  if (!dbEnabled) return;
  try {
    const comp = await db.getCompetition({ id: tag.id });
    if (!comp) return;
    const st = await loadState(comp);
    const m = st.matches.find((x) => x.id === tag.matchId);
    if (!m || m.status !== 'called' || m.attempt !== tag.attempt) return;
    const roster = rosterOf(st, m);
    const guilty = new Set(culprits.map((c) => c.userId));
    const sideAtFault = (entries: db.EntryRow[]): boolean => entries.some((e) => usersOf(e).some((u) => guilty.has(u)));
    const redFault = sideAtFault(roster.red);
    const blueFault = sideAtFault(roster.blue);
    const at = st.entries.filter((e) => usersOf(e).some((u) => guilty.has(u)));
    const code: CallFailure = culprits.some((c) => c.kind === 'unready') ? 'unready' : culprits.some((c) => c.kind === 'bail') ? 'bail' : 'noshow';
    /* THE LOG CARRIES A CODE AND THE NAMES BY POSITION against their ids (`logLine` writes the
       sentence), so `deleteAccount` can drop a name. The public match note names the alliance only:
       nothing rewrites it. The call note is staff-only and replaced by the next call. */
    const failed = { why: code, who: at.map(nameOfEntry), whoEntries: at.map((e) => e.id) };
    const callNote = `${failed.who.join(', ') || 'A driver'} ${CALL_FAILED[code]}.`;
    if (st.settings.run.noShow === 'forfeit' && redFault !== blueFault) {
      const winner: Alliance = redFault ? 'blue' : 'red';
      /* R7: a driver who never connected or left before the start is disqualified from the match
         (G208, G203), which costs more than the loss (0 in every average under the manual). One
         who connected and did not ready up only loses it. Plus any entry no longer in the
         competition. Qualification matches only: nothing else reads a match's DQs. */
      const noShows = new Set(culprits.filter((c) => c.kind !== 'unready').map((c) => c.userId));
      const dqAdd =
        m.stage === 'qual'
          ? [...new Set([
              ...[...roster.red, ...roster.blue].filter((e) => usersOf(e).some((u) => noShows.has(u))).map((e) => e.id),
              ...leftEntries(st, m),
            ])]
          : [];
      const ok = await db.writeResult(
        m.id,
        { red: null, blue: null, redFoul: 0, blueFoul: 0, winner, source: 'forfeit', note: `${redFault ? 'Red' : 'Blue'} ${CALL_FAILED[code]}.`, dqAdd },
        { attempt: tag.attempt, fromStatus: ['called'] },
      );
      if (ok) {
        await db.addLog(comp.id, 'system', 'match.forfeit', { match: m.id, label: tag.label, winner, ...failed, ...dqLog(st, dqAdd.filter((e) => !m.dq.includes(e))) });
        touch(comp.id);
        await afterResult(comp.id);
        // the drivers hear about a forfeit the room decided as they would about a referee's
        const res: CompResult = { red: null, blue: null, redFoul: 0, blueFoul: 0, winner, source: 'forfeit' };
        await noticeResult(st, { ...m, result: res }, 'forfeit', tag.label);
      }
      return;
    }
    if (await db.uncallMatch(m.id, tag.attempt, callNote)) {
      await db.addLog(comp.id, 'system', 'match.uncalled', { match: m.id, label: tag.label, ...failed }, false);
      touch(comp.id);
    }
  } catch (e) {
    console.error('[comp] recording a failed call failed:', e);
  }
}

// =====================================================================================
// AFTER A RESULT — the playoffs' next matches, swiss rounds, and finishing
// =====================================================================================

/**
 * Bring the schedule in line with the results, under the competition's row lock so the runner, a
 * room's result and a referee cannot each insert the same next match.
 *   - playoffs: drop any unplayed match whose alliances no longer match its series (a result was
 *     changed upstream), create each series' next match, and finish the competition once the
 *     final is decided;
 *   - swiss: draw the next round once every match of the current one is decided.
 */
export async function afterResult(compId: string): Promise<void> {
  if (!dbEnabled) return;
  let finish = false;
  await db.tx(async (query) => {
    const comp = await db.lockCompetition(query, compId);
    if (!comp) return;
    const settings = settingsOf(comp);
    if (comp.status === 'playoffs' && comp.alliances) {
      const specs = await db.listSeries(comp.id, query);
      let matches = await db.listMatches(comp.id, query);
      let state = bracketState(specs, comp.alliances, matches.filter((m) => m.stage === 'playoff'));
      // an unplayed match whose sides no longer agree with its series is stale: remove it
      const sideOf = new Map<number, number>();
      for (const a of comp.alliances) for (const e of a.entries) sideOf.set(e, a.seed);
      const stale = matches.filter((m) => {
        if (m.stage !== 'playoff' || (m.status !== 'scheduled' && m.status !== 'called') || !m.series) return false;
        const s = state.series.find((x) => x.key === m.series);
        const red = m.red[0] ? sideOf.get(m.red[0].entry) : undefined;
        const blue = m.blue[0] ? sideOf.get(m.blue[0].entry) : undefined;
        return !s || s.winner !== null || s.red !== red || s.blue !== blue;
      });
      for (const m of stale) await query(`delete from competition_matches where id = $1`, [m.id]);
      if (stale.length) {
        matches = await db.listMatches(comp.id, query);
        state = bracketState(specs, comp.alliances, matches.filter((m) => m.stage === 'playoff'));
      }
      let next = Math.max(0, ...matches.filter((m) => m.stage === 'playoff').map((m) => m.number)) + 1;
      const byseed = new Map(comp.alliances.map((a) => [a.seed, a]));
      const drawn = state.next.map((n) => ({
        round: 0,
        number: next++,
        series: n.series,
        red: (byseed.get(n.red)?.entries ?? []).map((entry) => ({ entry })),
        blue: (byseed.get(n.blue)?.entries ?? []).map((entry) => ({ entry })),
      }));
      if (drawn.length) await db.insertMatches(comp.id, 'playoff', drawn, query);
      finish = state.complete;
    }
    if (comp.status === 'qualification' && settings.quals.kind === 'swiss') {
      const matches = await db.listMatches(comp.id, query);
      const quals = matches.filter((m) => m.stage === 'qual');
      const lastRound = Math.max(0, ...quals.map((m) => m.round));
      const undecided = quals.some((m) => m.status === 'scheduled' || m.status === 'called');
      if (!undecided && lastRound > 0 && lastRound < settings.quals.matchesPerEntry) {
        const entries = await db.listEntries(comp.id, query);
        await drawSwiss(comp, settings, entries, matches, lastRound + 1, query);
      }
    }
  });
  touch(compId);
  if (finish) {
    const comp = await db.getCompetition({ id: compId });
    if (comp && comp.status === 'playoffs') await completeCompetition(comp, 'system').catch((e) => console.error('[comp] finishing failed:', e));
  }
}

async function drawSwiss(
  comp: db.CompRow,
  settings: CompSettings,
  entries: db.EntryRow[],
  matches: db.MatchRow[],
  round: number,
  query: Tx | undefined,
): Promise<number> {
  const quals = matches.filter((m) => m.stage === 'qual');
  // the field is every entry still registered: the ones that never checked in were withdrawn when
  // qualifications started, and one withdrawn or disqualified since drops out of later rounds
  const pool = entries.filter((e) => e.status === 'registered' && (round > 1 || !settings.checkIn || e.checkedInAt !== null));
  const rankings = quals.length ? computeRankings(entries.map(entryCore), quals, rankingOf(comp, settings), comp.rngSeed) : null;
  const ids = new Set(pool.map((e) => e.id));
  const ranking = rankings
    ? rankings.filter((r) => ids.has(r.entry)).map((r) => r.entry)
    : seedOrder(pool.map(entryCore), null);
  const played: [number, number][] = [];
  const colors = new Map<number, { red: number; blue: number }>();
  for (const m of quals) {
    if (m.status === 'void') continue;
    const r = m.red[0]?.entry;
    const b = m.blue[0]?.entry;
    if (r !== undefined && b !== undefined) played.push([r, b]);
    for (const [side, slots] of [['red', m.red], ['blue', m.blue]] as const) {
      for (const s of slots) {
        const c = colors.get(s.entry) ?? { red: 0, blue: 0 };
        c[side]++;
        colors.set(s.entry, c);
      }
    }
  }
  // who has already sat a round out: in the pool, and in no match of that round (a voided match
  // still counts as played, which is why this is not inferred from colour counts)
  const byes: number[] = [];
  for (let r = 1; r < round; r++) {
    const inRound = new Set(quals.filter((m) => m.round === r).flatMap((m) => [...m.red, ...m.blue].map((s) => s.entry)));
    for (const e of pool) if (!inRound.has(e.id)) byes.push(e.id);
  }
  const { matches: drawn, bye } = drawSwissRound(round, ranking, played, colors, comp.rngSeed + round, byes);
  if (bye !== null && query) {
    const e = entries.find((x) => x.id === bye);
    await db.addLog(comp.id, 'system', 'schedule.bye', { round, entry: bye, name: e ? nameOfEntry(e) : null, users: e ? usersOf(e) : [] }, true, query);
  }
  let next = Math.max(0, ...quals.map((m) => m.number)) + 1;
  await db.insertMatches(
    comp.id,
    'qual',
    drawn.map((d) => ({ round, number: next++, series: null, red: d.red, blue: d.blue })),
    query,
  );
  if (query) await db.addLog(comp.id, 'system', 'schedule.round', { round, matches: drawn.length }, true, query);
  return drawn.length;
}

/**
 * FINISH: placements written, entrants told, status completed. From the bracket when there were
 * playoffs (an alliance's place goes to each of its entries, and everyone who did not make the
 * playoffs follows in seed order), from the rankings when there were none.
 */
async function completeCompetition(comp: db.CompRow, actor: string): Promise<void> {
  const st = await loadState(comp);
  const places = new Map<number, number>();
  if (st.bracket && comp.alliances) {
    const bySeed = new Map(comp.alliances.map((a) => [a.seed, a.entries]));
    for (const p of st.bracket.placements) for (const e of bySeed.get(p.alliance) ?? []) places.set(e, p.place);
  }
  let next = Math.max(0, ...places.values()) + 1;
  const rest = (st.rankings ? st.rankings.filter((r) => !r.disqualified).map((r) => r.entry) : st.order).filter((e) => !places.has(e));
  // entries placed together share a number only in the bracket; past it each takes the next one
  const startOfRest = st.bracket ? Math.max(next, (comp.alliances?.reduce((n, a) => n + a.entries.length, 0) ?? 0) + 1) : 1;
  next = startOfRest;
  for (const e of rest) {
    const row = st.entries.find((x) => x.id === e);
    if (!row || row.status !== 'registered') continue;
    places.set(e, next++);
  }
  // THE STATUS FLIP IS THE GATE, and it goes first. Two finishers can both get here: a room's
  // result and the runner's pass each run `afterResult`, and each reads "playoffs" before the other
  // has completed it. The flip is conditional on the status this one read, so only one of them
  // wins it; the other writes no places, no second log line, and sends nobody a second notice.
  const finished = await db.tx(async (query) => {
    const done = await db.updateCompetition(comp.id, { status: 'completed', completedAt: Date.now() }, comp.status, query);
    if (!done) return false;
    await db.writePlacements(comp.id, places, query);
    const champs = st.entries.filter((e) => places.get(e.id) === 1);
    // the ids beside the names, by position, so `deleteAccount` can drop a name
    await db.addLog(comp.id, actor, 'status.completed', { champions: champs.map(nameOfEntry), championEntries: champs.map((e) => e.id) }, true, query);
    return true;
  });
  if (!finished) return;
  touch(comp.id);
  const of = st.entries.filter((e) => e.status === 'registered' || e.status === 'disqualified').length;
  const rows: NewNotice[] = [];
  for (const e of st.entries) {
    if (e.status !== 'registered') continue;
    for (const userId of usersOf(e)) {
      rows.push({ userId, kind: 'competition.finished', game: comp.game, data: noticeData(comp, { place: places.get(e.id) ?? null, of }) });
    }
  }
  await notify(rows);
}

// =====================================================================================
// THE HTTP API
// =====================================================================================

export interface ApiCtx {
  json: (code: number, body: unknown) => void;
  readBody: (req: IncomingMessage) => Promise<string>;
  bearer: (req: IncomingMessage) => string | undefined;
}

/** the detail read is the page's poll: cached for a moment per competition, cleared on a write */
const detailCache = new Map<string, { at: number; byRole: Map<string, CompetitionDetail> }>();
function touch(compId: string): void {
  detailCache.delete(compId);
}

/** the runner is woken by any write that could give it work (see competitionRunner.ts) */
let wake: () => void = () => {};
export function setCompetitionWake(fn: () => void): void {
  wake = fn;
}

async function body(req: IncomingMessage, ctx: ApiCtx): Promise<Record<string, unknown>> {
  try {
    const raw = await ctx.readBody(req);
    if (!raw) return {};
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return refuse(400, 'That request could not be read.');
  }
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
const text = (v: unknown, max: number): string =>
  // eslint-disable-next-line no-control-regex
  typeof v === 'string' ? v.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').slice(0, max) : '';
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const intIn = (v: unknown, min: number, max: number): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && Number.isInteger(n) && n >= min && n <= max ? n : null;
};

/** may this text be shown publicly (the same moderation every other public name goes through) */
async function cleanPublic(v: string, what: string): Promise<string> {
  if (v && !(await moderateName(v)).allowed) refuse(400, `That ${what} isn’t allowed. Please choose another.`);
  return v;
}

export async function handleCompetitionApi(req: IncomingMessage, url: URL, ctx: ApiCtx): Promise<boolean> {
  const p = url.pathname;
  if (p !== '/api/competitions' && !p.startsWith('/api/competitions/')) return false;
  const { json } = ctx;
  if (!dbEnabled) {
    json(req.method === 'GET' ? 200 : 503, req.method === 'GET' ? { competitions: [], more: false } : { error: 'Competitions need the database.' });
    return true;
  }
  const token = ctx.bearer(req);
  const user = token ? await verifyAuthToken(token).catch(() => null) : null;
  try {
    // ------------------------------------------------------------------ reads
    if (req.method === 'GET') {
      if (p === '/api/competitions') return await listRoute(url, user, ctx), true;
      if (p === '/api/competitions/caps') {
        const why = user ? await mayCreate(user.userId) : 'Sign in first.';
        json(200, { canCreate: why === null, why, admin: isAdmin(user?.userId) });
        return true;
      }
      if (p === '/api/competitions/me') return await meRoute(user, ctx), true;
      const m = p.match(/^\/api\/competitions\/([a-z0-9-]{3,48})$/);
      if (m) {
        const comp = await db.getCompetition({ slug: m[1] });
        const role = comp ? await roleFor(comp, user?.userId ?? null) : null;
        if (!comp || (comp.status === 'draft' && !canReferee(role))) return json(404, { error: 'No such competition.' }), true;
        if (comp.status !== 'completed' && comp.status !== 'cancelled' && RUNNING.includes(comp.status)) wake();
        // the shared part is cached per role class; the viewer block is always fresh
        const key = canReferee(role) ? 'staff' : 'public';
        const hit = detailCache.get(comp.id);
        let d = hit && Date.now() - hit.at < 2000 ? hit.byRole.get(key) : undefined;
        if (!d || user) {
          d = await detailOf(comp, user);
          if (!user) {
            const slot = hit && Date.now() - hit.at < 2000 ? hit : { at: Date.now(), byRole: new Map() };
            slot.byRole.set(key, d);
            detailCache.set(comp.id, slot);
          }
        }
        json(200, d);
        return true;
      }
      json(404, { error: 'unknown endpoint' });
      return true;
    }
    if (req.method !== 'POST') return json(405, { error: 'method not allowed' }), true;
    if (!user) return json(401, { error: 'Sign in first.' }), true;

    // ---------------------------------------------------------------- create
    if (p === '/api/competitions') {
      const why = await mayCreate(user.userId);
      if (why) return json(403, { error: why }), true;
      const b = await body(req, ctx);
      const comp = await createRoute(user, b);
      json(200, { slug: comp.slug, id: comp.id, game: comp.game });
      return true;
    }

    const m = p.match(/^\/api\/competitions\/([a-z0-9-]{3,48})\/([a-z]+)$/);
    if (!m) return json(404, { error: 'unknown endpoint' }), true;
    const comp = await db.getCompetition({ slug: m[1] });
    if (!comp) return json(404, { error: 'No such competition.' }), true;
    const role = await roleFor(comp, user.userId);
    if (comp.status === 'draft' && !canReferee(role)) return json(404, { error: 'No such competition.' }), true;
    const b = await body(req, ctx);
    const out = await postRoute(m[2], comp, user, role, b);
    touch(comp.id);
    wake();
    json(200, { ok: true, ...out });
    return true;
  } catch (e) {
    if (e instanceof Refusal) {
      json(e.code, { error: e.message });
      return true;
    }
    throw e;
  }
}

async function listRoute(url: URL, user: AuthedUser | null, ctx: ApiCtx): Promise<void> {
  const raw = url.searchParams.get('scope') ?? 'upcoming';
  const scope: db.ListScope | 'mine' =
    raw === 'live' || raw === 'past' || raw === 'drafts' || raw === 'all' || raw === 'mine' ? raw : 'upcoming';
  const g = url.searchParams.get('game');
  const game = g && isGameId(g) ? g : null;
  const offset = Number(url.searchParams.get('offset') ?? 0) || 0;
  const admin = isAdmin(user?.userId);
  if ((scope === 'drafts' || scope === 'all') && !admin) return ctx.json(403, { error: 'Staff only.' });
  if (scope === 'mine' && !user) return ctx.json(200, { competitions: [], more: false });
  const { rows, more } = await db.listCompetitions({
    scope: scope === 'mine' ? 'all' : scope,
    game,
    hidden: admin || scope === 'mine',
    mine: scope === 'mine' ? user!.userId : null,
    offset,
  });
  ctx.json(200, { competitions: rows.map(summaryOf), more });
}

async function meRoute(user: AuthedUser | null, ctx: ApiCtx): Promise<void> {
  if (!user) return ctx.json(200, { competitions: [], now: Date.now() });
  const rows = await db.myOpenEntries(user.userId);
  const out: MyCompetition[] = [];
  for (const r of rows) {
    // only the run timing and check-in are read here, which no shape or game folds
    const settings = coerceCompSettings(r.settings, '1v1', 'solo', r.game);
    let called: MyCompetition['called'] = null;
    let next: MyCompetition['next'] = null;
    if (RUNNING.includes(r.status) && r.entryStatus === 'registered') {
      const open = await db.entryOpenMatches(r.entryId);
      for (const m of open) {
        const label = m.stage === 'qual' ? matchLabel('qual', m.number) : (m.series ?? `P${m.number}`);
        if (m.status === 'called' && m.roomCode && !called) {
          const red = m.red.some((s) => s.entry === r.entryId);
          called = {
            matchId: m.id,
            label,
            roomCode: m.roomCode,
            graceEndsAt: (m.calledAt ?? Date.now()) + settings.run.joinGraceSec * 1000,
            alliance: red ? 'red' : 'blue',
          };
        } else if (m.status === 'scheduled' && !next) {
          next = { matchId: m.id, label, ahead: m.ahead };
        }
      }
      if (called) wake();
    }
    out.push({
      slug: r.slug,
      name: r.name,
      game: r.game,
      status: r.status,
      entryId: r.entryId,
      entryStatus: r.entryStatus,
      checkedIn: r.checkedInAt !== null,
      checkIn: settings.checkIn,
      checkinOpensAt: r.checkinOpensAt,
      called,
      next,
    });
  }
  ctx.json(200, { competitions: out, now: Date.now() });
}

// ---------------------------------------------------------------------- create / edit

/** validate the editable fields; `prev` is the row being edited (null on create) */
async function readEdit(b: Record<string, unknown>, prev: db.CompRow | null, entryCount: number): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(b, k);
  const lockedShape = prev !== null && (prev.status !== 'draft' && prev.status !== 'published' ? true : entryCount > 0);
  if (has('name') || !prev) {
    const name = str(b.name, LIMITS.name.max);
    if (name.length < LIMITS.name.min) refuse(400, `The name needs at least ${LIMITS.name.min} characters.`);
    out.name = await cleanPublic(name, 'name');
  }
  if (has('summary')) out.summary = await cleanPublic(str(b.summary, LIMITS.summary.max), 'summary');
  if (has('description')) out.description = text(b.description, LIMITS.description.max);
  if (has('rules')) out.rules = text(b.rules, LIMITS.rules.max);
  if (has('visibility')) out.visibility = b.visibility === 'unlisted' ? 'unlisted' : 'public';
  const shapeKeys = ['game', 'format', 'teamMode'];
  if (shapeKeys.some(has) || !prev) {
    if (lockedShape && shapeKeys.some((k) => has(k) && b[k] !== (prev as unknown as Record<string, unknown>)[k])) {
      refuse(409, 'The game and format can’t change once people have entered.');
    }
    const game = has('game') ? b.game : prev?.game;
    if (typeof game !== 'string' || !isGameId(game) || !simModuleFor(game).scored) refuse(400, 'Pick a game.');
    if (!gameVisibleOn(game as GameId, SERVER_CHANNEL)) refuse(400, 'That game isn’t available on this server.');
    const format = (has('format') ? b.format : prev?.format) === '2v2' ? '2v2' : '1v1';
    out.game = game;
    out.format = format;
    out.teamMode = coerceTeamMode(format, has('teamMode') ? b.teamMode : prev?.teamMode);
  }
  if (has('capacity') || !prev) {
    const cap = intIn(b.capacity, LIMITS.capacity.min, LIMITS.capacity.max);
    if (cap === null) refuse(400, `Capacity is a whole number from ${LIMITS.capacity.min} to ${LIMITS.capacity.max}.`);
    if (prev && prev.status !== 'draft' && prev.status !== 'published') refuse(409, 'Capacity is fixed once qualifications start.');
    out.capacity = cap;
  }
  if (has('region')) {
    const r = b.region;
    if (r !== null && r !== '' && (typeof r !== 'string' || !/^[a-z]{3}$/.test(r))) refuse(400, 'A region is a three-letter code.');
    out.region = r || null;
  }
  for (const k of ['regOpensAt', 'regClosesAt', 'checkinOpensAt', 'startsAt'] as const) {
    if (has(k)) out[k] = numOrNull(b[k]);
  }
  const opens = (has('regOpensAt') ? out.regOpensAt : prev?.regOpensAt) as number | null | undefined;
  const closes = (has('regClosesAt') ? out.regClosesAt : prev?.regClosesAt) as number | null | undefined;
  if (opens && closes && closes <= opens) refuse(400, 'Registration has to close after it opens.');
  // the game the settings are coerced for: the one this edit leaves the competition on
  const game = (out.game ?? prev?.game ?? 'decode') as GameId;
  if (has('settings') || !prev) {
    const format = (out.format ?? prev?.format ?? '1v1') as '1v1' | '2v2';
    const teamMode = (out.teamMode ?? prev?.teamMode ?? 'solo') as 'solo' | 'duo';
    // a shallow merge, so an edit that leaves `rp` out keeps the stored one (without it, the
    // coercer would read the competition as one from before the manual scheme: custom). `rp` is
    // merged one level deeper: a body of `{ rp: { level } }` must not drop the stored scheme,
    // which a present `rp` without one coerces to the manual's.
    const plainObj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
    const stored = plainObj(prev?.settings) ?? {};
    const body = plainObj(b.settings) ?? {};
    const merged: Record<string, unknown> = { ...stored, ...body };
    if (plainObj(body.rp) && plainObj(stored.rp)) merged.rp = { ...plainObj(stored.rp), ...plainObj(body.rp) };
    const next = coerceCompSettings(merged, format, teamMode, game);
    if (prev) {
      const was = settingsOf(prev);
      const st = prev.status;
      if (st !== 'draft' && st !== 'published' && JSON.stringify(next.quals) !== JSON.stringify(was.quals)) {
        refuse(409, 'Qualification settings are fixed once qualifications start.');
      }
      // the rules every qualification match is ranked by, frozen with them (`rp_table`)
      if (st !== 'draft' && st !== 'published' && JSON.stringify(next.rp) !== JSON.stringify(was.rp)) {
        refuse(409, 'The ranking-point scheme is fixed once qualifications start.');
      }
      if ((st === 'playoffs' || st === 'completed' || st === 'cancelled') && JSON.stringify(next.playoffs) !== JSON.stringify(was.playoffs)) {
        refuse(409, 'Playoff settings are fixed once the bracket is built.');
      }
      if ((st === 'selection' || st === 'playoffs' || st === 'completed') && (JSON.stringify(next.points) !== JSON.stringify(was.points) || JSON.stringify(next.tiebreakers) !== JSON.stringify(was.tiebreakers))) {
        refuse(409, 'Ranking points and tiebreakers are fixed once qualifications end.');
      }
    }
    out.settings = next;
  } else if (out.format || out.teamMode) {
    out.settings = coerceCompSettings(prev?.settings, out.format as '1v1' | '2v2', out.teamMode as 'solo' | 'duo', game);
  }
  return out;
}

async function createRoute(user: AuthedUser, b: Record<string, unknown>): Promise<db.CompRow> {
  const f = await readEdit(b, null, 0);
  const comp = await db.insertCompetition({
    slug: slugify(String(f.name)),
    name: String(f.name),
    game: f.game as GameId,
    format: f.format as '1v1' | '2v2',
    teamMode: f.teamMode as 'solo' | 'duo',
    visibility: (f.visibility as 'public' | 'unlisted') ?? 'public',
    official: isAdmin(user.userId),
    summary: (f.summary as string) ?? '',
    description: (f.description as string) ?? '',
    rules: (f.rules as string) ?? '',
    settings: f.settings,
    capacity: f.capacity as number,
    region: (f.region as string | null) ?? null,
    regOpensAt: (f.regOpensAt as number | null) ?? null,
    regClosesAt: (f.regClosesAt as number | null) ?? null,
    checkinOpensAt: (f.checkinOpensAt as number | null) ?? null,
    startsAt: (f.startsAt as number | null) ?? null,
    rngSeed: randomInt(1, 2 ** 31 - 1),
    createdBy: user.userId,
  });
  // a non-admin creator is the competition's organizer by `created_by`; their profile exists
  if (!isAdmin(user.userId)) await ensureProfile(user.userId, user.handle || 'Player');
  await db.addLog(comp.id, user.userId, 'created', {}, false);
  await writeAudit({ adminId: user.userId, action: 'competition.create', targetId: comp.id, detail: { slug: comp.slug, game: comp.game } });
  return comp;
}

// ---------------------------------------------------------------------- POST /:slug/:action

type Audit = (what: string, detail?: Record<string, unknown>, note?: string | null) => Promise<void>;

/** a player's own actions (an admin entering as a player is not acting as staff), and `delete`,
 *  which writes its own audit row for every role because the competition's log goes with it */
const NOT_STAFF_AUDITED = new Set(['register', 'withdraw', 'checkin', 'partner', 'delete']);

/**
 * EVERY MUTATING ADMIN ROUTE WRITES TO `admin_audit` (docs/area/accounts.md), and here that is
 * enforced in one place rather than remembered at each call site. An action audits itself when it
 * has a before/after worth recording; one that succeeded without doing so (a call, a swap, a seed,
 * an undo, a pick made on a captain's behalf, …) gets a plain row naming the action and its ids,
 * so "what has this admin done to this competition" has no holes. Only on success: a refusal
 * throws past this. The ids are re-read as integers and the action names are ones the route has
 * just accepted, so nothing a client typed reaches `detail` (the rule `writeAudit` states).
 */
async function postRoute(
  action: string,
  comp: db.CompRow,
  user: AuthedUser,
  role: CompRole | null,
  b: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let audited = false;
  const audit: Audit = (what, detail = {}, note) => {
    audited = true;
    return role === 'admin' ? writeAudit({ adminId: user.userId, action: `competition.${what}`, targetId: comp.id, detail: { slug: comp.slug, ...detail }, note }) : Promise.resolve();
  };
  const out = await postAction(action, comp, user, role, b, audit);
  if (role === 'admin' && !audited && !NOT_STAFF_AUDITED.has(action)) {
    const sub = action === 'status' ? b.to : b.action;
    const detail: Record<string, unknown> = { slug: comp.slug };
    for (const k of ['match', 'entry'] as const) {
      const id = intIn(b[k], 1, Number.MAX_SAFE_INTEGER);
      if (id !== null) detail[k] = id;
    }
    await writeAudit({
      adminId: user.userId,
      action: `competition.${action}${typeof sub === 'string' && /^[a-zA-Z]{1,24}$/.test(sub) ? `.${sub}` : ''}`,
      targetId: comp.id,
      detail,
    });
  }
  return out;
}

async function postAction(
  action: string,
  comp: db.CompRow,
  user: AuthedUser,
  role: CompRole | null,
  b: Record<string, unknown>,
  audit: Audit,
): Promise<Record<string, unknown>> {
  const need = (ok: boolean): void => {
    if (!ok) refuse(403, 'You don’t run this competition.');
  };
  switch (action) {
    // ------------------------------------------------------------- player actions
    case 'register':
      return registerRoute(comp, user, b);
    case 'withdraw':
      return withdrawRoute(comp, user);
    case 'checkin': {
      const st = await loadState(comp);
      const mine = st.entries.find((e) => e.status === 'registered' && (e.userId === user.userId || e.partnerId === user.userId));
      if (!mine) refuse(409, 'You’re not entered.');
      if (!checkInOpen(comp, st.settings)) refuse(409, 'Check-in isn’t open.');
      await db.updateEntry(mine!.id, { checkedIn: true });
      await db.addLog(comp.id, user.userId, 'entry.checkin', { entry: mine!.id, name: nameOfEntry(mine!), users: usersOf(mine!) }, false);
      return { note: 'You’re checked in.' };
    }
    case 'partner':
      return partnerRoute(comp, user, b);
    case 'pick': {
      if (comp.status !== 'selection') refuse(409, 'Alliance selection isn’t running.');
      const st = await loadState(comp);
      if (!st.selection) refuse(409, 'This competition doesn’t use alliance selection.');
      const entry = intIn(b.entry, 1, Number.MAX_SAFE_INTEGER);
      if (entry === null) refuse(400, 'Pick an entry.');
      const turn = st.selection!.turn;
      const mine = st.entries.find((e) => e.userId === user.userId || e.partnerId === user.userId);
      const captainsTurn = turn !== null && !!mine && st.selection!.alliances[turn]?.entries[0] === mine.id;
      need(canManage(role) || captainsTurn);
      const kind: SelectionAction['kind'] = b.decline === true ? 'decline' : 'pick';
      if (kind === 'decline') need(canManage(role));
      const res = applySelection(st.selection!, { kind, entry: entry! });
      if ('error' in res) refuse(409, res.error);
      const actions = [...comp.selection, { kind, entry: entry! }];
      if (!(await writeSelection(comp, actions))) refuse(409, 'Selection moved on. Refresh and try again.');
      const picked = st.entries.find((e) => e.id === entry);
      await db.addLog(comp.id, user.userId, kind === 'pick' ? 'selection.pick' : 'selection.decline', {
        entry,
        name: picked ? nameOfEntry(picked) : null,
        users: picked ? usersOf(picked) : [],
        alliance: turn !== null ? turn + 1 : null,
      });
      return {};
    }

    // ------------------------------------------------------------- organizer: edit
    case 'update': {
      need(canManage(role));
      const st = await loadState(comp);
      const live = st.entries.filter((e) => e.status !== 'withdrawn').length;
      const patch = await readEdit(b, comp, live);
      if (patch.capacity !== undefined && (patch.capacity as number) < st.entries.filter((e) => e.status === 'registered').length) {
        refuse(409, 'More people are already registered than that capacity holds. Move some to the waitlist first.');
      }
      const next = await db.updateCompetition(comp.id, patch, comp.status);
      if (!next) refuse(409, 'The competition changed while you were editing. Refresh and try again.');
      await db.addLog(comp.id, user.userId, 'edited', { fields: Object.keys(patch) }, false);
      await audit('edit', { fields: Object.keys(patch) });
      // a bigger capacity frees places for the waitlist
      if (patch.capacity !== undefined) await promoteWaitlist(next!);
      return { slug: next!.slug };
    }
    case 'status':
      need(canManage(role));
      return statusRoute(comp, user, role!, b, audit);
    case 'delete': {
      need(canManage(role));
      if (comp.status !== 'draft' && comp.status !== 'cancelled' && role !== 'admin') {
        refuse(409, 'Only a draft or a cancelled competition can be deleted.');
      }
      await db.deleteCompetition(comp.id);
      await writeAudit({ adminId: user.userId, action: 'competition.delete', targetId: comp.id, detail: { slug: comp.slug, name: comp.name, status: comp.status } });
      return { deleted: true };
    }

    // ------------------------------------------------------------- organizer: entries
    case 'entries':
      if (b.action === 'checkin' || b.action === 'uncheckin') need(canReferee(role));
      else need(canManage(role));
      return entriesRoute(comp, user, b, audit);

    // ------------------------------------------------------------- organizer: schedule
    case 'schedule':
      need(canManage(role));
      return scheduleRoute(comp, user, b, audit);

    // ------------------------------------------------------------- referees: matches
    case 'match':
      need(canReferee(role));
      return matchRoute(comp, user, role!, b, audit);

    // ------------------------------------------------------------- organizer: selection
    case 'selection': {
      need(canManage(role));
      if (comp.status !== 'selection') refuse(409, 'Alliance selection isn’t running.');
      if (b.action === 'undo') {
        // undo what this organizer was looking at, never a pick that landed since
        if (!(await writeSelection(comp, comp.selection.slice(0, -1)))) refuse(409, 'Selection moved on. Refresh and try again.');
        await db.addLog(comp.id, user.userId, 'selection.undo', {}, false);
        return {};
      }
      if (b.action === 'reset') {
        await db.updateCompetition(comp.id, { selection: [] }, 'selection');
        await db.addLog(comp.id, user.userId, 'selection.reset', {}, false);
        return {};
      }
      return refuse(400, 'Unknown selection action.');
    }

    // ------------------------------------------------------------- organizer: staff
    case 'staff': {
      need(canManage(role));
      if (b.action === 'add') {
        const r = b.role === 'organizer' ? 'organizer' : 'referee';
        const found = await resolvePlayerTag(str(b.tag, 80));
        if (!found.ok) refuse(400, found.error);
        if (found.ok) {
          await db.setStaff(comp.id, found.userId, r, user.userId);
          await db.addLog(comp.id, user.userId, 'staff.add', { userId: found.userId, role: r }, false);
          await audit('staff.add', { userId: found.userId, role: r });
          return { note: `${found.username ? `@${found.username}` : found.handle} is now a ${r}.` };
        }
      }
      if (b.action === 'remove') {
        const uid = str(b.userId, 120);
        if (!(await db.removeStaff(comp.id, uid))) refuse(404, 'They aren’t on the staff.');
        await db.addLog(comp.id, user.userId, 'staff.remove', { userId: uid }, false);
        await audit('staff.remove', { userId: uid });
        return {};
      }
      return refuse(400, 'Unknown staff action.');
    }

    // ------------------------------------------------------------- organizer: message
    case 'message': {
      need(canManage(role));
      const msg = cleanMessage(b.message);
      if (!msg) refuse(400, 'Write a message first.');
      const last = lastMessage.get(comp.id) ?? 0;
      if (Date.now() - last < 30_000) refuse(429, 'Wait half a minute between messages.');
      lastMessage.set(comp.id, Date.now());
      const st = await loadState(comp);
      const to = new Set<string>();
      for (const e of st.entries) {
        if (e.status === 'withdrawn') continue;
        for (const u of usersOf(e)) to.add(u);
      }
      await notify([...to].map((userId) => ({ userId, kind: 'competition.message', game: comp.game, data: noticeData(comp), message: msg })));
      await db.addLog(comp.id, user.userId, 'message', { message: msg, to: to.size });
      await audit('message', { to: to.size }, msg);
      return { note: `Sent to ${to.size} player${to.size === 1 ? '' : 's'}.` };
    }
  }
  return refuse(404, 'Unknown action.');
}

const lastMessage = new Map<string, number>();

/**
 * WRITE THE SELECTION LOG, conditional on it still being the log this request read. A pick (or an
 * undo) is computed from that log, and `updateCompetition`'s status condition alone let the later
 * of two writes replace the earlier: a captain's pick landing while the organizer pressed undo was
 * silently lost, and the undo took back the action BEFORE it. Under the row lock, so the compare
 * and the write are one step. Both logs come from the jsonb column, so they serialize alike.
 */
async function writeSelection(comp: db.CompRow, actions: SelectionAction[]): Promise<boolean> {
  return db.tx(async (query) => {
    const locked = await db.lockCompetition(query, comp.id);
    if (!locked || locked.status !== 'selection' || JSON.stringify(locked.selection) !== JSON.stringify(comp.selection)) return false;
    return (await db.updateCompetition(comp.id, { selection: actions }, 'selection', query)) !== null;
  });
}

// ---------------------------------------------------------------------- registration

async function registerRoute(comp: db.CompRow, user: AuthedUser, b: Record<string, unknown>): Promise<Record<string, unknown>> {
  const closed = registrationOpen(comp);
  if (closed) refuse(409, closed);
  const gate = emailGateRefusal(user);
  if (gate) refuse(403, gate);
  const susp = await getSuspension(user.userId);
  if (susp.until) refuse(403, 'This account is suspended from online play, competitions included.');
  await ensureProfile(user.userId, user.handle || 'Player');
  const me = await getProfile(user.userId);
  if (!me?.username) refuse(409, 'Choose a username first, so the schedule can name you.');
  const teamName = await cleanPublic(str(b.name, 40), 'team name');
  const number = b.number === undefined || b.number === null || b.number === '' ? null : intIn(b.number, 0, 999999);
  if (b.number !== undefined && b.number !== null && b.number !== '' && number === null) refuse(400, 'A team number is a whole number up to 999999.');
  let partnerId: string | null = null;
  let partnerName = '';
  if (comp.teamMode === 'duo') {
    const found = await resolvePlayerTag(str(b.partner, 80));
    if (!found.ok) refuse(400, found.error);
    if (found.ok) {
      if (found.userId === user.userId) refuse(400, 'Your partner has to be somebody else.');
      if ((await getSuspension(found.userId)).until) refuse(409, 'That player can’t play online right now.');
      partnerId = found.userId;
      partnerName = found.username ? `@${found.username}` : found.handle;
    }
  }
  const { status, entry } = await db.tx(async (query) => {
    const locked = await db.lockCompetition(query, comp.id);
    if (!locked || registrationOpen(locked)) refuse(409, 'Registration has closed.');
    const entries = await db.listEntries(comp.id, query);
    const taken = (uid: string): db.EntryRow | undefined =>
      entries.find((e) => e.status !== 'withdrawn' && (e.userId === uid || e.partnerId === uid));
    const old = entries.find((e) => e.userId === user.userId && e.status === 'withdrawn');
    if (taken(user.userId)) refuse(409, 'You’re already entered.');
    if (partnerId && taken(partnerId)) refuse(409, `${partnerName} is already entered.`);
    const full = entries.filter((e) => e.status === 'registered').length >= locked!.capacity;
    // THE WAITLIST IS CAPPED AT THE CAPACITY: past that nobody realistic gets in, and the entry
    // list (`listEntries`, hard-capped at 600 rows) must stay whole for these very checks
    if (full && entries.filter((e) => e.status === 'waitlist' || e.status === 'pending').length >= locked!.capacity) {
      refuse(409, 'The competition and its waitlist are full.');
    }
    const st: EntryStatus = partnerId ? 'pending' : full ? 'waitlist' : 'registered';
    const name = teamName || me!.handle || me!.username || 'Player';
    // the partner may still be named on a duo that withdrew (see `releaseWithdrawnPartner`)
    if (partnerId) await db.releaseWithdrawnPartner(comp.id, partnerId, old?.id ?? null, query);
    if (old) {
      // a player who withdrew comes back as a new arrival: last in line
      await query(
        `update competition_entries set status = $2, partner_id = $3, name = $4, number = $5, checked_in_at = null,
                registered_at = now() where id = $1`,
        [old.id, st, partnerId, name, number],
      );
      return { status: st, entry: old.id };
    }
    return { status: st, entry: await db.insertEntry({ competitionId: comp.id, userId: user.userId, partnerId, name, number, status: st }, query) };
  });
  // the entry id rides along so `deleteAccount` can find this line's name to scrub
  await db.addLog(comp.id, user.userId, 'entry.register', { entry, status, name: teamName || me!.handle, users: [user.userId] }, false);
  if (partnerId) {
    await notify([{ userId: partnerId, kind: 'competition.invite', game: comp.game, data: noticeData(comp, { from: `@${me!.username}` }) }]);
    return { status, note: `Invitation sent to ${partnerName}. You’re entered once they accept.` };
  }
  return {
    status,
    note: status === 'waitlist' ? 'The competition is full. You’re on the waitlist.' : 'You’re registered.',
  };
}

async function withdrawRoute(comp: db.CompRow, user: AuthedUser): Promise<Record<string, unknown>> {
  const e = await db.entryOfUser(comp.id, user.userId);
  if (!e || e.status === 'withdrawn' || e.status === 'disqualified') refuse(409, 'You’re not entered.');
  if (e!.userId !== user.userId && e!.status !== 'pending') refuse(409, 'Only the captain can withdraw a duo.');
  if (comp.status === 'completed' || comp.status === 'cancelled') refuse(409, 'This competition is over.');
  const before = comp.status === 'draft' || comp.status === 'published';
  if (before && e!.status === 'pending') await db.deleteEntry(e!.id);
  else await db.updateEntry(e!.id, { status: 'withdrawn', checkedIn: false });
  await db.addLog(comp.id, user.userId, 'entry.withdraw', { entry: e!.id, name: nameOfEntry(e!), users: usersOf(e!) });
  if (e!.status === 'registered' && before) await promoteWaitlist(comp);
  return { note: 'You’ve withdrawn.' };
}

async function partnerRoute(comp: db.CompRow, user: AuthedUser, b: Record<string, unknown>): Promise<Record<string, unknown>> {
  const st = await loadState(comp);
  const e = st.entries.find((x) => x.status === 'pending' && x.partnerId === user.userId);
  if (!e) refuse(404, 'There’s no invitation waiting for you.');
  if (b.accept !== true) {
    await db.deleteEntry(e!.id);
    await db.addLog(comp.id, user.userId, 'entry.decline', { entry: e!.id, users: usersOf(e!) }, false);
    return { note: 'Invitation declined.' };
  }
  if (registrationOpen(comp)) refuse(409, 'Registration has closed.');
  const susp = await getSuspension(user.userId);
  if (susp.until) refuse(403, 'This account is suspended from online play, competitions included.');
  await ensureProfile(user.userId, user.handle || 'Player');
  const status = await db.tx(async (query) => {
    const locked = await db.lockCompetition(query, comp.id);
    if (!locked) refuse(404, 'No such competition.');
    const entries = await db.listEntries(comp.id, query);
    if (entries.some((x) => x.id !== e!.id && x.status !== 'withdrawn' && (x.userId === user.userId || x.partnerId === user.userId))) {
      refuse(409, 'You’re already entered in this competition.');
    }
    const full = entries.filter((x) => x.status === 'registered').length >= locked!.capacity;
    const next: EntryStatus = full ? 'waitlist' : 'registered';
    await db.updateEntry(e!.id, { status: next }, query);
    return next;
  });
  await db.addLog(comp.id, user.userId, 'entry.accept', { entry: e!.id, name: nameOfEntry(e!), users: usersOf({ ...e!, status }) });
  return { status, note: status === 'waitlist' ? 'Accepted. The competition is full, so your duo is on the waitlist.' : 'Accepted. Your duo is registered.' };
}

/** fill free places from the waitlist, oldest first, and tell each player who got in */
async function promoteWaitlist(comp: db.CompRow): Promise<void> {
  if (comp.status !== 'published' && comp.status !== 'draft') return;
  const promoted = await db.tx(async (query) => {
    const locked = await db.lockCompetition(query, comp.id);
    if (!locked) return [];
    const entries = await db.listEntries(comp.id, query);
    let free = locked.capacity - entries.filter((e) => e.status === 'registered').length;
    const out: db.EntryRow[] = [];
    for (const e of entries.filter((x) => x.status === 'waitlist').sort((a, b) => a.registeredAt - b.registeredAt || a.id - b.id)) {
      if (free <= 0) break;
      await db.updateEntry(e.id, { status: 'registered' }, query);
      out.push(e);
      free--;
    }
    return out;
  });
  for (const e of promoted) await db.addLog(comp.id, 'system', 'entry.promoted', { entry: e.id, name: nameOfEntry(e), users: usersOf({ ...e, status: 'registered' }) });
  await notify(
    promoted.flatMap((e) => usersOf({ ...e, status: 'registered' }).map((userId) => ({ userId, kind: 'competition.promoted', game: comp.game, data: noticeData(comp) }))),
  );
}

// ---------------------------------------------------------------------- status

async function statusRoute(
  comp: db.CompRow,
  user: AuthedUser,
  role: CompRole,
  b: Record<string, unknown>,
  audit: (what: string, detail?: Record<string, unknown>, note?: string | null) => Promise<void>,
): Promise<Record<string, unknown>> {
  const to = String(b.to ?? '');
  const st = await loadState(comp);
  const set = async (status: CompStatus, extra: Record<string, unknown> = {}, from: CompStatus | CompStatus[] = comp.status): Promise<void> => {
    const ok = await db.updateCompetition(comp.id, { status, ...extra }, from);
    if (!ok) refuse(409, 'The competition changed while you were looking at it. Refresh and try again.');
    await db.addLog(comp.id, user.userId, `status.${status}`, {});
    await audit(`status.${status}`);
  };
  switch (to) {
    case 'published':
      if (comp.status !== 'draft') refuse(409, 'Only a draft can be published.');
      await set('published');
      return { note: 'Published. Registration follows its window.' };
    case 'draft':
      if (comp.status !== 'published') refuse(409, 'Only a published competition can go back to draft.');
      await set('draft');
      return { note: 'Back to draft. It’s hidden again.' };
    case 'closeRegistration':
      if (comp.status !== 'published') refuse(409, 'Registration isn’t open.');
      await db.updateCompetition(comp.id, { regClosesAt: Date.now() }, 'published');
      await db.addLog(comp.id, user.userId, 'registration.closed', {});
      return { note: 'Registration closed.' };
    case 'openRegistration':
      if (comp.status !== 'published') refuse(409, 'Only a published competition takes registrations.');
      await db.updateCompetition(comp.id, { regClosesAt: null, regOpensAt: comp.regOpensAt && comp.regOpensAt > Date.now() ? Date.now() : comp.regOpensAt }, 'published');
      await db.addLog(comp.id, user.userId, 'registration.opened', {});
      return { note: 'Registration is open.' };
    case 'qualification': {
      if (comp.status !== 'published') refuse(409, 'Qualifications start from a published competition.');
      if (st.settings.quals.kind === 'none') refuse(409, 'This competition has no qualifications. Go to alliance selection instead.');
      const eligible = eligibleEntries(st);
      const per = entriesPerAlliance(comp.format, comp.teamMode);
      if (eligible.length < 2 * per) refuse(409, `It needs at least ${2 * per} entries${st.settings.checkIn ? ' checked in' : ''} to start.`);
      const quals = st.matches.filter((m) => m.stage === 'qual');
      const drawnIds = new Set(quals.flatMap((m) => [...m.red, ...m.blue].map((s) => s.entry)));
      const want = new Set(eligible.map((e) => e.id));
      // An entry the organizer REMOVES before the start is deleted, and its slots go with it (the
      // cascade), so the ids left in the schedule can equal the entry list exactly while matches
      // have nobody on one side. A full alliance in every match is part of "drawn for this list";
      // without it those matches would start, and each would forfeit to the side that has drivers.
      const holed = quals.some((m) => m.red.length !== per || m.blue.length !== per);
      if (st.settings.quals.kind !== 'swiss') {
        if (!quals.length) await drawQuals(comp, st, eligible);
        else if (holed || drawnIds.size !== want.size || [...want].some((id) => !drawnIds.has(id))) {
          refuse(409, 'The entry list changed since the schedule was drawn. Draw it again first.');
        }
      }
      await db.tx(async (query) => {
        // everything above read the settings this request loaded: an edit saved since then is
        // refused here rather than locked in under rules built from the older settings
        const locked = await db.lockCompetition(query, comp.id);
        if (!locked || locked.status !== 'published' || JSON.stringify(locked.settings) !== JSON.stringify(comp.settings)) {
          refuse(409, 'The competition changed while you were looking at it. Refresh and try again.');
        }
        // THE RANKING RULES FREEZE HERE under the manual scheme (R2): a Team Update that changes a
        // table after this cannot re-rank an event already under way. Read from the live table,
        // never an older frozen copy; the scheme itself is locked from now on (`readEdit`).
        const ranking = effectiveRanking(settingsOf(locked!), comp.game);
        // entries that never checked in, and the waitlist, sit this one out
        for (const e of st.entries) {
          if (e.status === 'registered' && !want.has(e.id)) await db.updateEntry(e.id, { status: 'withdrawn' }, query);
        }
        const started = await db.updateCompetition(
          comp.id,
          {
            status: 'qualification',
            startedAt: Date.now(),
            regClosesAt: comp.regClosesAt && comp.regClosesAt < Date.now() ? comp.regClosesAt : Date.now(),
            rpTable: ranking.scheme === 'cm' ? ranking : null,
          },
          'published',
          query,
        );
        if (!started) refuse(409, 'The competition changed while you were looking at it. Refresh and try again.');
        if (st.settings.quals.kind === 'swiss') {
          await query(`delete from competition_matches where competition_id = $1 and stage = 'qual'`, [comp.id]);
          const entries = await db.listEntries(comp.id, query);
          await drawSwiss(comp, st.settings, entries, [], 1, query);
        }
      });
      await db.addLog(comp.id, user.userId, 'status.qualification', { entries: eligible.length });
      await audit('status.qualification', { entries: eligible.length });
      return { note: 'Qualifications have started.' };
    }
    case 'selection': {
      // straight from registration when there are no qualifications, else from qualifications
      if (comp.status === 'published') {
        if (st.settings.quals.kind !== 'none') refuse(409, 'Play the qualifications first.');
        const eligible = eligibleEntries(st);
        const need = st.settings.playoffs.alliances * entriesPerAlliance(comp.format, comp.teamMode);
        if (eligible.length < need) refuse(409, `The playoffs need ${need} entries${st.settings.checkIn ? ' checked in' : ''}; there are ${eligible.length}. Use fewer playoff alliances or wait for more entries.`);
        const order = seedOrder(eligible.map(entryCore), null);
        await db.tx(async (query) => {
          const want = new Set(eligible.map((e) => e.id));
          for (const e of st.entries) if (e.status === 'registered' && !want.has(e.id)) await db.updateEntry(e.id, { status: 'withdrawn' }, query);
          await db.updateCompetition(comp.id, { status: 'selection', seedOrder: order, startedAt: Date.now() }, 'published', query);
        });
        await db.addLog(comp.id, user.userId, 'status.selection', {});
        await audit('status.selection');
        return { note: 'Seeding is set. Build the bracket when the alliances are ready.' };
      }
      if (comp.status !== 'qualification') refuse(409, 'Alliance selection follows the qualifications.');
      const quals = st.matches.filter((m) => m.stage === 'qual');
      if (quals.some((m) => m.status === 'called')) refuse(409, 'A qualification match is still called. Finish or cancel it first.');
      const open = quals.filter((m) => m.status === 'scheduled');
      if (open.length && b.force !== true) refuse(409, `${open.length} qualification match${open.length === 1 ? ' hasn’t' : 'es haven’t'} been played. Play them, or end qualifications anyway (they’ll be voided).`);
      if (st.settings.quals.kind === 'swiss' && b.force !== true) {
        const lastRound = Math.max(0, ...quals.map((m) => m.round));
        if (lastRound < st.settings.quals.matchesPerEntry) refuse(409, `Only ${lastRound} of ${st.settings.quals.matchesPerEntry} swiss rounds have been drawn.`);
      }
      for (const m of open) await db.voidMatch(m.id, 'Not played: qualifications ended.');
      const fresh = await loadState(comp);
      const order = seedOrder(fresh.entries.map(entryCore), fresh.rankings);
      if (!st.settings.playoffs.enabled) {
        await db.updateCompetition(comp.id, { seedOrder: order }, 'qualification');
        const again = await db.getCompetition({ id: comp.id });
        if (again) await completeCompetition(again, user.userId);
        await audit('status.completed');
        return { note: 'Qualifications are over and the competition is complete.' };
      }
      const need = st.settings.playoffs.alliances * entriesPerAlliance(comp.format, comp.teamMode);
      if (order.length < need) refuse(409, `The playoffs need ${need} entries; ${order.length} are left. Use fewer playoff alliances in the settings first.`);
      await set('selection', { seedOrder: order }, 'qualification');
      return { note: 'Qualifications are over. Rankings are frozen for seeding.' };
    }
    case 'playoffs': {
      if (comp.status !== 'selection') refuse(409, 'The bracket is built from alliance selection.');
      const per = entriesPerAlliance(comp.format, comp.teamMode);
      const n = st.settings.playoffs.alliances;
      let alliances: PlayoffAlliance[];
      if (per === 2 && st.settings.playoffs.selection === 'captains') {
        if (!st.selection?.complete) refuse(409, 'Alliance selection isn’t finished.');
        alliances = st.selection!.alliances;
      } else {
        if (st.order.length < n * per) refuse(409, `The playoffs need ${n * per} entries; there are ${st.order.length}.`);
        alliances = serpentineAlliances(st.order, n, per);
      }
      const specs = buildBracket(n, st.settings.playoffs.format, st.settings.playoffs.bestOf, st.settings.playoffs.finalsBestOf);
      await db.tx(async (query) => {
        await db.deleteSeries(comp.id, query);
        await query(`delete from competition_matches where competition_id = $1 and stage = 'playoff'`, [comp.id]);
        await db.insertSeries(comp.id, specs, query);
        const ok = await db.updateCompetition(comp.id, { status: 'playoffs', alliances }, 'selection', query);
        if (!ok) refuse(409, 'The competition changed while you were looking at it. Refresh and try again.');
      });
      await db.addLog(comp.id, user.userId, 'status.playoffs', { alliances: alliances.length });
      await audit('status.playoffs', { alliances: alliances.length });
      await afterResult(comp.id);
      return { note: 'The bracket is built. The first playoff matches are on the schedule.' };
    }
    case 'completed': {
      if (comp.status !== 'playoffs') refuse(409, 'A competition completes from its playoffs.');
      if (!st.bracket?.complete && b.force !== true) refuse(409, 'The final hasn’t been decided.');
      await completeCompetition(comp, user.userId);
      await audit('status.completed');
      return { note: 'The competition is complete.' };
    }
    case 'cancelled': {
      if (comp.status === 'completed' || comp.status === 'cancelled') refuse(409, 'This competition is already over.');
      for (const m of st.matches.filter((x) => x.status === 'called')) await db.uncallMatch(m.id, null, 'The competition was cancelled.');
      await set('cancelled', { cancelledAt: Date.now() });
      const to2 = new Set<string>();
      for (const e of st.entries) if (e.status !== 'withdrawn') for (const u of usersOf(e)) to2.add(u);
      if (comp.status !== 'draft') {
        await notify([...to2].map((userId) => ({ userId, kind: 'competition.cancelled', game: comp.game, data: noticeData(comp) })));
      }
      return { note: 'Cancelled.' };
    }
  }
  void role;
  return refuse(400, 'Unknown status change.');
}

// ---------------------------------------------------------------------- entries (organizer)

async function entriesRoute(
  comp: db.CompRow,
  user: AuthedUser,
  b: Record<string, unknown>,
  audit: (what: string, detail?: Record<string, unknown>, note?: string | null) => Promise<void>,
): Promise<Record<string, unknown>> {
  const act = String(b.action ?? '');
  if (act === 'add') {
    if (comp.status !== 'draft' && comp.status !== 'published') refuse(409, 'Entries can only be added before the competition starts.');
    const found = await resolvePlayerTag(str(b.tag, 80));
    if (!found.ok) refuse(400, found.error);
    if (!found.ok) return {};
    let partnerId: string | null = null;
    if (comp.teamMode === 'duo') {
      const p = await resolvePlayerTag(str(b.partner, 80));
      if (!p.ok) refuse(400, `Partner: ${p.error}`);
      if (p.ok) partnerId = p.userId;
      if (partnerId === found.userId) refuse(400, 'A duo is two different players.');
    }
    const name = (await cleanPublic(str(b.name, 40), 'team name')) || found.handle;
    const added = await db.tx(async (query) => {
      const locked = await db.lockCompetition(query, comp.id);
      if (!locked) refuse(404, 'No such competition.');
      const entries = await db.listEntries(comp.id, query);
      const taken = (uid: string): boolean => entries.some((e) => e.status !== 'withdrawn' && (e.userId === uid || e.partnerId === uid));
      if (taken(found.userId) || (partnerId && taken(partnerId))) refuse(409, 'Already entered.');
      const old = entries.find((e) => e.userId === found.userId);
      if (old) await query(`delete from competition_entries where id = $1`, [old.id]);
      if (partnerId) await db.releaseWithdrawnPartner(comp.id, partnerId, null, query);
      return db.insertEntry({ competitionId: comp.id, userId: found.userId, partnerId, name, number: intIn(b.number, 0, 999999), status: 'registered' }, query);
    });
    const users = partnerId ? [found.userId, partnerId] : [found.userId];
    await db.addLog(comp.id, user.userId, 'entry.add', { entry: added, name, users }, false);
    await audit('entry.add', { userId: found.userId });
    return { note: `Added ${name}.` };
  }
  const id = intIn(b.entry, 1, Number.MAX_SAFE_INTEGER);
  if (id === null) refuse(400, 'Which entry?');
  const e = await db.getEntry(id!);
  if (!e || e.competitionId !== comp.id) refuse(404, 'No such entry.');
  const entry = e!;
  const name = nameOfEntry(entry);
  const before = comp.status === 'draft' || comp.status === 'published';
  switch (act) {
    case 'remove':
      if (before) await db.deleteEntry(entry.id);
      else await db.updateEntry(entry.id, { status: 'withdrawn' });
      await db.addLog(comp.id, user.userId, 'entry.remove', { entry: entry.id, name, users: usersOf(entry) });
      await audit('entry.remove', { entry: entry.id, userId: entry.userId });
      await notify(usersOf(entry).map((userId) => ({ userId, kind: 'competition.removed', game: comp.game, data: noticeData(comp, { how: 'removed' }) })));
      if (before && entry.status === 'registered') await promoteWaitlist(comp);
      return { note: `Removed ${name}.` };
    case 'disqualify':
      await db.updateEntry(entry.id, { status: 'disqualified' });
      await db.addLog(comp.id, user.userId, 'entry.disqualify', { entry: entry.id, name, users: usersOf(entry), why: str(b.note, 200) || null });
      await audit('entry.disqualify', { entry: entry.id, userId: entry.userId }, str(b.note, 200) || null);
      await notify(usersOf(entry).map((userId) => ({ userId, kind: 'competition.removed', game: comp.game, data: noticeData(comp, { how: 'disqualified' }), message: cleanMessage(b.note) })));
      return { note: `${name} is disqualified.` };
    case 'reinstate':
      await db.updateEntry(entry.id, { status: 'registered' });
      await db.addLog(comp.id, user.userId, 'entry.reinstate', { entry: entry.id, name, users: usersOf(entry) });
      await audit('entry.reinstate', { entry: entry.id });
      return { note: `${name} is back in.` };
    case 'checkin':
    case 'uncheckin':
      await db.updateEntry(entry.id, { checkedIn: act === 'checkin' });
      await db.addLog(comp.id, user.userId, `entry.${act}`, { entry: entry.id, name, users: usersOf(entry) }, false);
      return {};
    case 'promote':
      if (entry.status !== 'waitlist') refuse(409, 'That entry isn’t on the waitlist.');
      // once the schedule is playing, an entry let in now would hold a place and have no matches
      if (!before) refuse(409, 'The competition has started. Nobody can come off the waitlist now.');
      await db.updateEntry(entry.id, { status: 'registered' });
      await db.addLog(comp.id, user.userId, 'entry.promoted', { entry: entry.id, name, users: usersOf(entry) });
      await notify(usersOf({ ...entry, status: 'registered' }).map((userId) => ({ userId, kind: 'competition.promoted', game: comp.game, data: noticeData(comp) })));
      return { note: `${name} is in.` };
    case 'demote':
      if (entry.status !== 'registered' || !before) refuse(409, 'Only a registered entry can move to the waitlist before the start.');
      await db.updateEntry(entry.id, { status: 'waitlist' });
      await db.addLog(comp.id, user.userId, 'entry.waitlisted', { entry: entry.id, name, users: usersOf(entry) }, false);
      return {};
    case 'seed': {
      const seed = b.seed === null || b.seed === '' ? null : intIn(b.seed, 1, 999);
      await db.updateEntry(entry.id, { seed });
      await db.addLog(comp.id, user.userId, 'entry.seed', { entry: entry.id, name, seed, users: usersOf(entry) }, false);
      return {};
    }
    case 'rename': {
      const nm = await cleanPublic(str(b.name, 40), 'team name');
      if (!nm) refuse(400, 'A name is required.');
      await db.updateEntry(entry.id, { name: nm, number: b.number === undefined ? undefined : intIn(b.number, 0, 999999) });
      await db.addLog(comp.id, user.userId, 'entry.rename', { entry: entry.id, from: name, to: nm, users: usersOf(entry) });
      return {};
    }
    case 'note':
      await db.updateEntry(entry.id, { note: text(b.note, 500) || null });
      // in the trail like every other organizer action; private, and without the note itself,
      // which only the staff's own reads carry
      await db.addLog(comp.id, user.userId, 'entry.note', { entry: entry.id, name, users: usersOf(entry) }, false);
      return {};
  }
  return refuse(400, 'Unknown entry action.');
}

// ---------------------------------------------------------------------- schedule

async function drawQuals(comp: db.CompRow, st: CompState, eligible: db.EntryRow[]): Promise<number> {
  const ids = eligible.map((e) => e.id).sort((a, b) => a - b);
  const per = entriesPerAlliance(comp.format, comp.teamMode);
  const s = st.settings.quals;
  // a fresh seed per draw, from the competition's: re-drawing gives a different schedule
  const seed = (comp.rngSeed + Date.now()) % 2147483647;
  const drawn =
    s.kind === 'roundRobin'
      ? drawRoundRobin(ids, s.matchesPerEntry, seed)
      : drawBalanced(ids, per, s.matchesPerEntry, s.minGap, seed);
  await db.tx(async (query) => {
    await query(`delete from competition_matches where competition_id = $1 and stage = 'qual'`, [comp.id]);
    await db.insertMatches(comp.id, 'qual', drawn.map((d, i) => ({ round: d.round, number: i + 1, series: null, red: d.red, blue: d.blue })), query);
  });
  return drawn.length;
}

async function scheduleRoute(
  comp: db.CompRow,
  user: AuthedUser,
  b: Record<string, unknown>,
  audit: (what: string, detail?: Record<string, unknown>, note?: string | null) => Promise<void>,
): Promise<Record<string, unknown>> {
  const st = await loadState(comp);
  const act = String(b.action ?? '');
  if (act === 'draw') {
    if (comp.status !== 'published' && comp.status !== 'draft') refuse(409, 'The schedule is drawn before qualifications start.');
    if (st.settings.quals.kind === 'none' || st.settings.quals.kind === 'swiss') {
      refuse(409, st.settings.quals.kind === 'swiss' ? 'Swiss rounds are drawn one at a time once qualifications start.' : 'This competition has no qualifications.');
    }
    const eligible = eligibleEntries(st);
    const per = entriesPerAlliance(comp.format, comp.teamMode);
    if (eligible.length < 2 * per) refuse(409, `It needs at least ${2 * per} entries${st.settings.checkIn ? ' checked in' : ''} to draw a schedule.`);
    let n = 0;
    try {
      n = await drawQuals(comp, st, eligible);
    } catch (e) {
      if (e instanceof Refusal) throw e;
      refuse(409, e instanceof Error ? e.message : 'Couldn’t draw that schedule.');
    }
    await db.addLog(comp.id, user.userId, 'schedule.drawn', { matches: n, entries: eligible.length }, false);
    await audit('schedule.draw', { matches: n });
    return { note: `Drew ${n} qualification matches for ${eligible.length} entries.` };
  }
  if (act === 'clear') {
    if (comp.status !== 'published' && comp.status !== 'draft') refuse(409, 'The schedule can only be cleared before qualifications start.');
    const n = await db.deleteAllMatches(comp.id, 'qual');
    await db.addLog(comp.id, user.userId, 'schedule.cleared', { matches: n }, false);
    return { note: 'Schedule cleared.' };
  }
  if (act === 'round') {
    if (comp.status !== 'qualification' || st.settings.quals.kind !== 'swiss') refuse(409, 'Only a running swiss competition draws rounds.');
    const quals = st.matches.filter((m) => m.stage === 'qual');
    if (quals.some((m) => m.status === 'scheduled' || m.status === 'called')) refuse(409, 'Finish the current round first.');
    const round = Math.max(0, ...quals.map((m) => m.round)) + 1;
    const n = await db.tx((query) => drawSwiss(comp, st.settings, st.entries, st.matches, round, query));
    return { note: `Drew round ${round}: ${n} matches.` };
  }
  if (act === 'swap') {
    const mid = intIn(b.match, 1, Number.MAX_SAFE_INTEGER);
    const m = st.matches.find((x) => x.id === mid);
    if (!m) refuse(404, 'No such match.');
    if (m!.status !== 'scheduled' || m!.stage !== 'qual') refuse(409, 'Only a qualification match that hasn’t been called can be changed.');
    const alliance = b.alliance === 'blue' ? 'blue' : 'red';
    const slot = intIn(b.slot, 0, 3);
    const entry = intIn(b.entry, 1, Number.MAX_SAFE_INTEGER);
    const e = st.entries.find((x) => x.id === entry);
    if (slot === null || !e || e.status !== 'registered') refuse(400, 'Pick a registered entry for that slot.');
    if ([...m!.red, ...m!.blue].some((s, i) => s.entry === entry && !(i === (alliance === 'red' ? slot : m!.red.length + slot!)))) {
      refuse(409, 'That entry is already in this match.');
    }
    await db.setSlot(m!.id, alliance, slot!, entry!, b.surrogate === true);
    await db.addLog(comp.id, user.userId, 'schedule.swap', { match: m!.id, alliance, slot, entry, name: nameOfEntry(e!), users: usersOf(e!) });
    return {};
  }
  return refuse(400, 'Unknown schedule action.');
}

// ---------------------------------------------------------------------- matches (referee)

async function matchRoute(
  comp: db.CompRow,
  user: AuthedUser,
  role: CompRole,
  b: Record<string, unknown>,
  audit: (what: string, detail?: Record<string, unknown>, note?: string | null) => Promise<void>,
): Promise<Record<string, unknown>> {
  const act = String(b.action ?? '');
  // A FINISHED COMPETITION'S RESULTS ARE FINAL: its placements were written once from them, and
  // a result changed afterwards would leave them stale (a public note is still allowed)
  if ((comp.status === 'completed' || comp.status === 'cancelled') && act !== 'note') {
    refuse(409, 'This competition is over. Its results are final.');
  }
  const st = await loadState(comp);
  const id = intIn(b.match, 1, Number.MAX_SAFE_INTEGER);
  const m = st.matches.find((x) => x.id === id);
  if (!m) refuse(404, 'No such match.');
  const match = m!;
  const label = labelsOf(st).get(match.id) ?? `#${match.id}`;
  const note = str(b.note, 200) || null;
  const playoffGuard = (next: CompResult | null): void => {
    if (match.stage !== 'playoff' || !st.comp.alliances) return;
    // a playoff result may not change once the series it feeds has PLAYED a match that depends on it
    const hypo = st.matches.map((x) => (x.id === match.id ? { ...x, status: next ? ('done' as const) : ('scheduled' as const), result: next } : x));
    const after = bracketState(st.specs, st.comp.alliances, hypo.filter((x) => x.stage === 'playoff'));
    const seedOfEntry = new Map<number, number>();
    for (const a of st.comp.alliances) for (const e of a.entries) seedOfEntry.set(e, a.seed);
    for (const x of hypo) {
      if (x.stage !== 'playoff' || x.status !== 'done' || x.id === match.id || !x.series) continue;
      const s = after.series.find((y) => y.key === x.series);
      const red = x.red[0] ? seedOfEntry.get(x.red[0].entry) : undefined;
      const blue = x.blue[0] ? seedOfEntry.get(x.blue[0].entry) : undefined;
      if (!s || s.red !== red || s.blue !== blue) refuse(409, 'Later playoff matches were played on this result. Reset those first.');
    }
  };
  const inMatch = (entry: number | null): boolean => entry !== null && [...match.red, ...match.blue].some((s) => s.entry === entry);
  /* A RULING ON A DECIDED MATCH (facts, rp, card). It must be the decided attempt the referee was
     looking at: a match reset, re-called or re-played since has other facts, and a ruling on the
     old ones would land on the new. The reason is required; it is the log line. The write itself
     is conditional on the same attempt, for a change that lands between this read and it. */
  const ruling = (): number => {
    if (match.status !== 'done' || !match.result) refuse(409, `${label} has no result to rule on.`);
    const attempt = intIn(b.attempt, 0, Number.MAX_SAFE_INTEGER);
    if (attempt === null || attempt !== match.attempt) refuse(409, 'The match changed. Refresh.');
    if (!note) refuse(400, 'Say why. The reason goes in the log.');
    return attempt!;
  };
  const perAlliance = (raw: unknown, what: string): [Alliance, Record<string, unknown>][] => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) refuse(400, `Send the ${what} to change, per alliance.`);
    return Object.entries(raw as Record<string, unknown>).map(([side, val]) => {
      if ((side !== 'red' && side !== 'blue') || !val || typeof val !== 'object' || Array.isArray(val)) {
        refuse(400, `Send the ${what} to change, per alliance.`);
      }
      return [side as Alliance, val as Record<string, unknown>];
    });
  };
  switch (act) {
    case 'call': {
      const r = await callMatch(st, match, user.userId);
      return { note: r.note, called: r.called };
    }
    case 'uncall': {
      if (match.status !== 'called') refuse(409, `${label} isn’t called.`);
      await db.uncallMatch(match.id, null, note ?? 'Call cancelled by a referee.');
      await db.addLog(comp.id, user.userId, 'match.uncalled', { match: match.id, label }, false);
      return { note: `${label} is back on the schedule. A room already playing it will finish into nothing.` };
    }
    case 'forfeit': {
      const winner = b.winner === 'blue' ? 'blue' : b.winner === 'red' ? 'red' : null;
      if (!winner) refuse(400, 'Pick the alliance that wins by forfeit.');
      // R7: the referee may disqualify the entries at fault (a no-show is G208), on top of the
      // entries no longer in the competition, which take nothing from a qualification match
      const picked: number[] = [];
      if (b.dq !== undefined && b.dq !== null) {
        if (!Array.isArray(b.dq) || b.dq.length > 8) refuse(400, 'List the entries to disqualify.');
        for (const x of b.dq as unknown[]) {
          const entry = intIn(x, 1, Number.MAX_SAFE_INTEGER);
          if (!inMatch(entry)) refuse(400, 'That entry isn’t in this match.');
          picked.push(entry!);
        }
      }
      const dqAdd = [...new Set([...picked, ...(match.stage === 'qual' ? leftEntries(st, match) : [])])];
      const res: CompResult = { red: null, blue: null, redFoul: 0, blueFoul: 0, winner: winner!, source: 'forfeit' };
      playoffGuard(res);
      await db.writeResult(match.id, { ...res, note, dqAdd });
      await db.addLog(comp.id, user.userId, 'match.forfeit', { match: match.id, label, winner, why: note, ...dqLog(st, dqAdd.filter((e) => !match.dq.includes(e))) });
      await audit('match.forfeit', { match: match.id, label, winner, ...(dqAdd.length ? { dq: dqAdd } : {}) }, note);
      await afterResult(comp.id);
      await noticeResult(st, { ...match, result: res }, 'forfeit', label);
      return { note: `${label}: ${winner} wins by forfeit.` };
    }
    case 'result': {
      const red = intIn(b.red, 0, 100000);
      const blue = intIn(b.blue, 0, 100000);
      if (red === null || blue === null) refuse(400, 'Enter both alliance scores.');
      const redFoul = intIn(b.redFoul ?? 0, 0, 100000) ?? 0;
      const blueFoul = intIn(b.blueFoul ?? 0, 0, 100000) ?? 0;
      // foul points GIVEN to an alliance are part of its total, so they can never be more than it
      if (redFoul > red! || blueFoul > blue!) refuse(400, 'Fouls given can’t exceed the score.');
      const winner: Winner = red! > blue! ? 'red' : blue! > red! ? 'blue' : 'tie';
      const res: CompResult = { red: red!, blue: blue!, redFoul, blueFoul, winner, source: 'manual' };
      playoffGuard(res);
      const was = match.status === 'done';
      await db.writeResult(match.id, { ...res, note, dqAdd: match.stage === 'qual' ? leftEntries(st, match) : [] });
      await db.addLog(comp.id, user.userId, was ? 'match.corrected' : 'match.entered', { match: match.id, label, red, blue, winner, why: note });
      await audit(was ? 'match.correct' : 'match.enter', { match: match.id, label, red, blue, before: match.result }, note);
      await afterResult(comp.id);
      // a FIRST result entered by hand is the ordinary way an offline-scored match lands, and a
      // driver is no more told about it than about a played one; changing a result is news
      if (was) await noticeResult(st, { ...match, result: res }, 'corrected', label);
      return { note: `${label}: red ${red}, blue ${blue}.` };
    }
    case 'void': {
      playoffGuard(null);
      await db.voidMatch(match.id, note ?? 'Voided by a referee.');
      await db.addLog(comp.id, user.userId, 'match.void', { match: match.id, label, why: note });
      await audit('match.void', { match: match.id, label }, note);
      await afterResult(comp.id);
      await noticeResult(st, match, 'void', label);
      return { note: `${label} is void.` };
    }
    case 'reset': {
      if (match.status === 'scheduled') refuse(409, `${label} hasn’t been played.`);
      playoffGuard(null);
      await db.clearResult(match.id, note);
      // a reset drops the referee's cards with the result they were shown on: the log says which,
      // so a card that should follow the replay can be shown again on purpose
      const cards = Object.entries(match.refCards ?? {}).map(([key, colour]) => {
        const e = st.entries.find((x) => x.id === Number(key));
        return { entry: Number(key), name: e ? nameOfEntry(e) : `Entry ${key}`, colour };
      });
      await db.addLog(comp.id, user.userId, 'match.reset', { match: match.id, label, why: note, ...(cards.length ? { cards } : {}) });
      await audit('match.reset', { match: match.id, label, before: match.result, ...(cards.length ? { cards: cards.map((c) => ({ entry: c.entry, colour: c.colour })) } : {}) }, note);
      await afterResult(comp.id);
      if (match.status === 'done') await noticeResult(st, match, 'reset', label);
      return { note: `${label} is back on the schedule.` };
    }
    case 'dq': {
      const entry = intIn(b.entry, 1, Number.MAX_SAFE_INTEGER);
      if (entry === null || ![...match.red, ...match.blue].some((s) => s.entry === entry)) refuse(400, 'That entry isn’t in this match.');
      const on = b.on !== false;
      const dq = on ? [...new Set([...match.dq, entry!])] : match.dq.filter((x) => x !== entry);
      await db.setMatchDq(match.id, dq);
      const e = st.entries.find((x) => x.id === entry);
      await db.addLog(comp.id, user.userId, on ? 'match.dq' : 'match.undq', { match: match.id, label, entry, name: e ? nameOfEntry(e) : null, users: e ? usersOf(e) : [], why: note });
      await audit(on ? 'match.dq' : 'match.undq', { match: match.id, label, entry }, note);
      return {};
    }
    case 'facts': {
      // what the game measured, typed or fixed by a referee: a key at a time (null deletes one)
      if (match.stage !== 'qual') refuse(409, 'Playoff matches earn no ranking points.');
      const attempt = ruling();
      if (match.result!.red === null) refuse(409, 'A forfeit has no score to rule on.');
      const table = cmTable(comp.game);
      if (!table) refuse(409, 'This game reports nothing to rule on.');
      const patch: Partial<Record<Alliance, db.SidePatch>> = {};
      let changed = 0;
      for (const [side, val] of perAlliance(b.facts, 'measures')) {
        const p: db.SidePatch = { set: {}, drop: [] };
        for (const [k, v] of Object.entries(val)) {
          // only what the game reports and a person may type: never an internal flag, such as
          // DECODE's `patternAward`, which the sim sets and the patch leaves where it is
          const measure = table!.measures.find((x) => x.id === k && !x.internal);
          if (!measure) refuse(400, 'That isn’t something this game measures.');
          const had = match.facts?.[side]?.[k];
          if (v === null) {
            if (had !== undefined) p.drop.push(k);
            continue;
          }
          const n = intIn(v, 0, measure!.max);
          if (n === null) refuse(400, `Each measure is a whole number from 0 to ${measure!.max}.`);
          if (n !== had) p.set[k] = n;
        }
        changed += Object.keys(p.set).length + p.drop.length;
        patch[side] = p;
      }
      if (!changed) return { note: 'Nothing changed.' };
      const eff = effectiveDq(qualsOf(st)).get(match.id);
      const before = matchRp(match, st.ranking, eff);
      if (!(await db.patchSides(match.id, attempt, 'facts', patch))) refuse(409, 'The match changed. Refresh.');
      await db.addLog(comp.id, user.userId, 'match.facts', { match: match.id, label, why: note });
      await audit('match.facts', { match: match.id, label, facts: patch }, note);
      await afterWrite('facts notices', async () => {
        const fresh = await db.getMatch(match.id);
        await noticeRp(st, label, before, fresh ? matchRp(fresh, st.ranking, eff) : null);
      });
      return { note: `${label}: the measures are updated.` };
    }
    case 'rp': {
      // a referee's ruling on a bonus RP, only where the manual has one (R9; `ResolvedBonus`)
      if (!st.ranking.bonus.length) refuse(409, 'This competition has no bonus ranking points.');
      if (match.stage !== 'qual') refuse(409, 'Playoff matches earn no ranking points.');
      const attempt = ruling();
      if (match.result!.red === null) refuse(409, 'A forfeit has no score to rule on.');
      const patch: Partial<Record<Alliance, db.SidePatch>> = {};
      const changes: { alliance: Alliance; bonus: string; ruling: 'award' | 'deny' | null }[] = [];
      for (const [side, val] of perAlliance(b.rulings, 'rulings')) {
        const p: db.SidePatch = { set: {}, drop: [] };
        for (const [id, v] of Object.entries(val)) {
          const bonus = st.ranking.bonus.find((x) => x.id === id);
          if (!bonus || (!bonus.award && !bonus.deny)) refuse(400, 'The manual has no ruling on that ranking point.');
          if (v !== null && v !== 'award' && v !== 'deny') refuse(400, 'A ruling is award, deny, or none.');
          if ((v === 'award' && !bonus!.award) || (v === 'deny' && !bonus!.deny)) refuse(400, 'The manual doesn’t allow that ruling on that ranking point.');
          const ruled = v as 'award' | 'deny' | null;
          if (ruled === (match.rulings?.[side]?.[id] ?? null)) continue;
          if (ruled === null) p.drop.push(id);
          else p.set[id] = ruled;
          changes.push({ alliance: side, bonus: id, ruling: ruled });
        }
        patch[side] = p;
      }
      if (!changes.length) return { note: 'Nothing changed.' };
      const eff = effectiveDq(qualsOf(st)).get(match.id);
      const before = matchRp(match, st.ranking, eff);
      if (!(await db.patchSides(match.id, attempt, 'rp_rulings', patch))) refuse(409, 'The match changed. Refresh.');
      for (const c of changes) await db.addLog(comp.id, user.userId, 'match.rp', { match: match.id, label, ...c, why: note });
      await audit('match.rp', { match: match.id, label, rulings: changes }, note);
      await afterWrite('ruling notices', async () => {
        const fresh = await db.getMatch(match.id);
        await noticeRp(st, label, before, fresh ? matchRp(fresh, st.ranking, eff) : null);
      });
      return { note: `${label}: ${changes.length === 1 ? 'the ruling is' : 'the rulings are'} recorded.` };
    }
    case 'card': {
      // a referee's card (§10.6.1), kept apart from the sim's; together they escalate (`effectiveDq`)
      if (match.stage !== 'qual') refuse(409, 'Cards are recorded on qualification matches only.');
      const attempt = ruling();
      const entry = intIn(b.entry, 1, Number.MAX_SAFE_INTEGER);
      if (!inMatch(entry)) refuse(400, 'That entry isn’t in this match.');
      const colour: CardColour | null | undefined = b.colour === 'yellow' || b.colour === 'red' ? b.colour : b.colour === null ? null : undefined;
      if (colour === undefined) refuse(400, 'Pick a yellow card, a red card, or none.');
      if ((match.refCards?.[String(entry)] ?? null) === colour) return { note: 'Nothing changed.' };
      const before = effectiveDq(qualsOf(st));
      if (!(await db.setRefCard(match.id, attempt, entry!, colour!))) refuse(409, 'The match changed. Refresh.');
      const e = st.entries.find((x) => x.id === entry);
      const name = e ? nameOfEntry(e) : `Entry ${entry}`;
      await db.addLog(comp.id, user.userId, 'match.card', { match: match.id, label, entry, name, users: e ? usersOf(e) : [], colour, why: note });
      await audit('match.card', { match: match.id, label, entry, colour }, note);
      // the card can cost this match, an earlier one (a surrogate's) or a later one (a second
      // yellow): the notice is read off the escalation before and after
      await afterWrite('card notice', async () => {
        const after = await loadState(comp);
        const x = after.matches.find((y) => y.id === match.id);
        if (!x) return;
        const pairs = newCardDqs(before, effectiveDq(qualsOf(after))).filter((p) => p.entry === entry);
        await noticeCard(after, entry!, cardNoticeData(after, x, entry!, colour ? colourIn(x, entry!) : null, pairs));
      });
      return { note: colour ? `${label}: ${name} is shown a ${colour} card.` : `${label}: ${name}’s card is withdrawn.` };
    }
    case 'note': {
      await db.setMatchStatus(match.id, match.status, note);
      // the note is shown publicly beside the result, so who wrote what is in the public trail
      await db.addLog(comp.id, user.userId, 'match.note', { match: match.id, label, note });
      return {};
    }
  }
  void role;
  return refuse(400, 'Unknown match action.');
}

// =====================================================================================
// THE RUNNER'S QUESTIONS (server/competitionRunner.ts asks; this answers from the rows)
// =====================================================================================

export interface RunnerPass {
  /** matches still called that the runner returned to the schedule */
  stale: number;
  called: number;
  /** anything still running that wants another pass */
  busy: boolean;
}

/** a called match with no room after this long is one nobody joined */
const UNCLAIMED_SLACK_MS = 45_000;
/** a claimed match's room should have finished by then: grace, strategy, a match, the settle */
const CLAIMED_MAX_MS = 9 * 60_000;

/**
 * ONE PASS over every running competition: return calls that will never become matches to the
 * schedule, finish anything a result made finishable, and call the next matches where auto-calling
 * is on. Idempotent; the runner calls it on a timer only while something is running.
 */
export async function runnerPass(): Promise<RunnerPass> {
  const out: RunnerPass = { stale: 0, called: 0, busy: false };
  if (!dbEnabled) return out;
  const comps = await db.runningCompetitions();
  const live = comps.length ? await liveByCode() : new Map<string, LiveRoom>();
  for (const comp of comps) {
    out.busy = true;
    try {
      const st = await loadState(comp);
      const graceMs = st.settings.run.joinGraceSec * 1000;
      const now = Date.now();
      // ---- calls that will never become matches
      for (const m of st.matches) {
        if (m.status !== 'called' || !m.calledAt) continue;
        const inRoom = !!(m.roomCode && live.has(m.roomCode));
        const unclaimedDead = !m.claimedAt && now > m.calledAt + graceMs + UNCLAIMED_SLACK_MS;
        const claimedDead = !!m.claimedAt && !inRoom && now > m.claimedAt + graceMs + CLAIMED_MAX_MS;
        if (!unclaimedDead && !claimedDead) continue;
        const why = unclaimedDead ? 'Nobody joined before the call ran out.' : 'The room closed without a result.';
        if (await db.uncallMatch(m.id, m.attempt, why)) {
          out.stale++;
          await db.addLog(comp.id, 'system', 'match.uncalled', { match: m.id, why }, false);
          touch(comp.id);
        }
      }
      // ---- playoffs: make sure every ready series has its next match
      if (comp.status === 'playoffs') await afterResult(comp.id);
      // ---- auto-call
      if (st.settings.run.autoCall) out.called += await autoCall(comp);
    } catch (e) {
      console.error(`[comp] runner pass failed for ${comp.slug}:`, e);
    }
  }
  return out;
}

/**
 * CALL WHAT CAN BE CALLED: the earliest scheduled matches whose drivers are all free (not in a
 * called match) and rested, up to `maxConcurrent` called at once. Looks a little past the head of
 * the queue so one driver who is still playing does not hold up everyone behind them, but not so
 * far that the order of play stops meaning anything.
 */
async function autoCall(comp: db.CompRow): Promise<number> {
  const st = await loadState(comp);
  const s = st.settings.run;
  const stage = comp.status === 'qualification' ? 'qual' : comp.status === 'playoffs' ? 'playoff' : null;
  if (!stage) return 0;
  let called = st.matches.filter((m) => m.status === 'called').length;
  if (called >= s.maxConcurrent) return 0;
  const busy = new Set<number>();
  for (const m of st.matches) if (m.status === 'called') for (const x of [...m.red, ...m.blue]) busy.add(x.entry);
  const lastFinished = new Map<number, number>();
  for (const m of st.matches) {
    if (m.status !== 'done' || !m.finishedAt) continue;
    for (const x of [...m.red, ...m.blue]) lastFinished.set(x.entry, Math.max(lastFinished.get(x.entry) ?? 0, m.finishedAt));
  }
  const queue = st.matches.filter((m) => m.stage === stage && m.status === 'scheduled').sort((a, b) => a.number - b.number);
  const window = queue.slice(0, Math.max(2, s.maxConcurrent * 2));
  let made = 0;
  for (const m of window) {
    if (called >= s.maxConcurrent) break;
    const entries = [...m.red, ...m.blue].map((x) => x.entry);
    if (entries.some((e) => busy.has(e))) continue;
    if (entries.some((e) => Date.now() - (lastFinished.get(e) ?? 0) < s.restSec * 1000)) continue;
    try {
      const r = await callMatch(st, m, 'system');
      for (const e of entries) busy.add(e);
      if (r.called) {
        called++;
        made++;
      }
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      // a driver in another competition's called match: try the next one
    }
  }
  if (made) touch(comp.id);
  return made;
}

/** is any competition running (the runner's arm question, asked once at boot) */
export async function anyRunning(): Promise<boolean> {
  if (!dbEnabled) return false;
  return (await db.runningCompetitions()).length > 0;
}

/** the players' profile page: finished competitions and their places */
export const placementsOf = db.placementsOf;

/**
 * IS THIS ARCHIVED MATCH A COMPETITION'S? Asked by the moderators' misscore tool
 * (`/api/admin/match`, R11). A competition match's result is the competition's, and its ranking
 * points rest on facts that tool cannot edit, so a moderator's correction there would leave the
 * competition's own row (and every RP derived from it) as it was while telling the drivers it
 * changed. Its referees correct it, from the match desk; this names the match and says so.
 */
export async function competitionOfArchived(matchId: string): Promise<{ slug: string; name: string; label: string; refusal: string } | null> {
  if (!dbEnabled) return null;
  const row = await db.competitionMatchOf(matchId);
  if (!row) return null;
  const comp = await db.getCompetition({ id: row.competitionId });
  if (!comp) return null;
  const st = await loadState(comp);
  const label = labelsOf(st).get(row.id) ?? `#${row.id}`;
  return { slug: comp.slug, name: comp.name, label, refusal: `${label} of ${comp.name} is corrected by its referees, from the match desk.` };
}

export const _test = { regionOf, registrationOpen, derive, labelsOf, COMP_CODE };

/**
 * TEST SEAM for `scripts/dbtest.ts`: the routes with an already-verified user, so the suite can
 * drive registration, the lifecycle and the referee actions on PGlite without a JWKS. Not routed
 * anywhere; the HTTP handler above is the only door a request has.
 */
export const competitionTestApi = {
  create: (user: AuthedUser, b: Record<string, unknown>): Promise<db.CompRow> => createRoute(user, b),
  /** `between` runs after the row is read and before the route sees it: a write that lands while
   *  this request is in flight */
  async post(
    slug: string,
    action: string,
    user: AuthedUser,
    b: Record<string, unknown> = {},
    between?: () => Promise<unknown>,
  ): Promise<{ ok: boolean; code?: number; error?: string; [k: string]: unknown }> {
    const comp = await db.getCompetition({ slug });
    if (!comp) return { ok: false, code: 404, error: 'No such competition.' };
    const role = await roleFor(comp, user.userId);
    if (between) await between();
    try {
      const out = await postRoute(action, comp, user, role, b);
      touch(comp.id);
      return { ok: true, ...out };
    } catch (e) {
      if (e instanceof Refusal) return { ok: false, code: e.code, error: e.message };
      throw e;
    }
  },
  async detail(slug: string, user: AuthedUser | null): Promise<CompetitionDetail | null> {
    const comp = await db.getCompetition({ slug });
    return comp ? detailOf(comp, user) : null;
  },
  async me(user: AuthedUser): Promise<unknown> {
    let out: unknown = null;
    await meRoute(user, { json: (_c, b) => (out = b), readBody: async () => '', bearer: () => undefined });
    return out;
  },
};
