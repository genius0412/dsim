/**
 * PLAYER NOTICES — what a moderator did, told to the people it was done to or for.
 *
 * The shared vocabulary for migration 0057's inbox: the server writes FACTS (`data`) and a
 * moderator's own words (`message`); this module words them. Pure and DOM-free, so the server,
 * the client and `npm test` agree on what every kind means, and the copy can change without
 * rewriting rows already sent.
 *
 * THE SHAPE IS TAKEN FROM WHAT OTHER GAMES SETTLED ON:
 *   - the PENALIZED player is told what happened, what it cost and for how long, the moment
 *     they are back in the client (Riot's in-client penalty notice);
 *   - a REPORTER is told when their report led to action (Overwatch, League, VALORANT), and,
 *     like Epic's "My reports", can see each report's status — including "no action";
 *   - a rating lost to a wrong result is GIVEN BACK and the player is shown the exact amount
 *     (VALORANT's ranked rollback, lichess's refund). A refund never takes rating from anyone.
 *
 * What a reporter is NOT told is the size of somebody else's penalty: that is between the
 * penalized player and the moderators, here as in every one of those games.
 */
import { REPORT_LABELS, type ReportReason } from './report';
import { tierOf } from './standing';
import { SEASONS } from './seasons';
import { RANKED_PLACEMENT } from './config';

export const NOTICE_KINDS = [
  /** to every player in a match whose score a moderator corrected */
  'match.corrected',
  /** to the filer of a misscore claim */
  'misscore.upheld',
  'misscore.rejected',
  /** to each player who reported someone, once a moderator has ruled */
  'report.actioned',
  'report.closed',
  /** to the reported player when the reports are upheld */
  'penalty',
  /** to a player whose standing a moderator edited by hand */
  'standing.edited',
  /** to every player whose rating a recalculation of the act moved (`server/ratingRecalc.ts`) */
  'rating.recalculated',
  /* COMPETITIONS (0059). Each carries `CompNoticeData`: the competition's slug and name, so the
     card can link to it. A notice says what happened TO the recipient; a called match is not one
     (it is time-critical, and the call bar says it for exactly as long as it is true). */
  /** an organizer's message to everyone entered */
  'competition.message',
  /** invited to play as somebody's duo partner */
  'competition.invite',
  /** off the waitlist and into the competition */
  'competition.promoted',
  /** an organizer removed or disqualified your entry */
  'competition.removed',
  /** a referee entered, forfeited, voided or reset a result of one of your matches */
  'competition.result',
  /** the competition finished: your place */
  'competition.finished',
  /** the competition was cancelled */
  'competition.cancelled',
  /** a card in one of your qualification matches (the sim's or a referee's), and what it costs */
  'competition.card',
  /** a referee's ruling changed the ranking points your alliance took from a match */
  'competition.rp',
] as const;

export type NoticeKind = (typeof NOTICE_KINDS)[number];

export const isNoticeKind = (v: unknown): v is NoticeKind =>
  typeof v === 'string' && (NOTICE_KINDS as readonly string[]).includes(v);

/** a moderator's message to a player: long enough to explain a decision, short enough that it
 *  is read. Capped again at the API boundary. */
export const NOTICE_MESSAGE_MAX = 500;

/** a moderator's message as stored: trimmed, control characters out (newlines kept), capped,
 *  and null when there is nothing left — so an empty box never sends an empty quote. */
export function cleanMessage(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, NOTICE_MESSAGE_MAX).trim();
  return s ? s : null;
}

/** one notice as the API serves it */
export interface Notice {
  id: string;
  kind: string;
  game: string | null;
  data: Record<string, unknown>;
  message: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface Score2 {
  red: number;
  blue: number;
}

/** what a notice says about the match it concerns */
export interface MatchRef {
  /** when it was played (ISO) */
  at?: string | null;
  mode?: string | null;
  ranked?: boolean | null;
}

/** a standing charge, as the player is told it */
export interface StandingCost {
  points: number;
  scoreAfter: number;
  cooldownMin: number;
  ratingCharge: number;
}

export interface MatchCorrectedData extends MatchRef {
  alliance: 'red' | 'blue';
  before: Score2;
  after: Score2;
  /** rating given back by this correction, 0 for none */
  refund: number;
}

export interface MisscoreData extends MatchRef {
  /** the latest correction of that match, when there is one */
  corrected?: { before: Score2; after: Score2 } | null;
  /** what filing it cost, when the moderator found it was filed in bad faith */
  cost?: StandingCost | null;
}

export interface ReportOutcomeData {
  /** the name the reported player had when the ruling was made */
  subject: string;
  reasons: string[];
}

export interface PenaltyData extends StandingCost {
  reasons: string[];
  /** distinct players whose reports were upheld */
  reporters: number;
}

export interface StandingEditedData {
  scoreBefore: number;
  scoreAfter: number;
  pardoned: number;
  /** 'cleared', a new lock in minutes, or null when the lock was left alone */
  lock: 'cleared' | number | null;
}

/** a recalculation moved this board's rating */
export interface RatingRecalculatedData {
  mode: '1v1' | '2v2';
  before: number;
  after: number;
}

export type MatchResult = 'win' | 'loss' | 'tie';

/** an alliance's result for a pair of totals. A tie is nobody's win, as in the sim. */
export function resultOf(alliance: 'red' | 'blue', s: Score2): MatchResult {
  const mine = alliance === 'red' ? s.red : s.blue;
  const theirs = alliance === 'red' ? s.blue : s.red;
  return mine > theirs ? 'win' : mine < theirs ? 'loss' : 'tie';
}

const RESULT_RANK: Record<MatchResult, number> = { loss: 0, tie: 1, win: 2 };

/**
 * RATING GIVEN BACK to one player when a correction changes a ranked result.
 *
 * The rating a match produced was computed from the score it was ORIGINALLY recorded with, so
 * that is the `original` to compare against, not whatever an earlier correction left. A player
 * whose corrected result is better than that, and who lost rating in the match, gets the loss
 * back. Nobody is charged: a misscore is the sim's fault, not the other alliance's, so a player
 * who was wrongly handed a win keeps the rating (VALORANT and lichess refund the loser and leave
 * the winner alone for the same reason). Re-rating properly is not possible: Glicko-2 is
 * sequential and every match since was rated against these numbers.
 */
export function ratingRefund(
  p: { alliance: 'red' | 'blue'; ratingBefore: number | null; ratingAfter: number | null },
  original: Score2,
  corrected: Score2,
): number {
  if (p.ratingBefore === null || p.ratingAfter === null) return 0;
  const lost = Math.round(p.ratingBefore - p.ratingAfter);
  if (!(lost > 0)) return 0;
  return RESULT_RANK[resultOf(p.alliance, corrected)] > RESULT_RANK[resultOf(p.alliance, original)] ? lost : 0;
}

/** "30 minutes", "2 hours", "3 days" — a lock as a person says it. `lockRemaining` stops at
 *  hours and would call a week "168 hours". */
export function durationWords(min: number): string {
  const m = Math.max(1, Math.round(min));
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  if (m < 1440) {
    const h = Math.round(m / 60);
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  const d = Math.round(m / 1440);
  return `${d} day${d === 1 ? '' : 's'}`;
}

const gameName = (id: string | null): string | null => SEASONS.find((s) => s.key === id)?.name ?? null;
const scoreWords = (s: Score2): string => `Red ${s.red}, Blue ${s.blue}`;
const reasonWords = (reasons: string[]): string =>
  reasons.map((r) => REPORT_LABELS[r as ReportReason] ?? r).join(', ');
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const score2 = (v: unknown): Score2 | null => {
  const o = v as Partial<Score2> | null;
  return o && typeof o.red === 'number' && typeof o.blue === 'number' ? { red: o.red, blue: o.blue } : null;
};

/** the cost lines shared by a penalty and a smitten claim */
function costLines(c: Partial<StandingCost>): string[] {
  const out: string[] = [];
  const points = num(c.points);
  if (points > 0) {
    const after = num(c.scoreAfter);
    out.push(`Standing −${points}, now ${after} (${tierOf(after).name}).`);
  }
  if (num(c.cooldownMin) > 0) out.push(`Ranked is locked for ${durationWords(num(c.cooldownMin))}.`);
  if (num(c.ratingCharge) > 0) out.push(`−${num(c.ratingCharge)} rating on your most recent ranked ladder.`);
  return out;
}

export type NoticeTone = 'good' | 'bad' | 'info';

export interface NoticeView {
  title: string;
  /** game · mode · date, when the notice is about one match */
  meta: string | null;
  lines: string[];
  tone: NoticeTone;
}

/**
 * Word one notice. Null for a kind this build does not know (a newer server), which the client
 * skips rather than rendering a blank card.
 */
export function noticeView(
  n: Pick<Notice, 'kind' | 'game' | 'data'>,
  fmtDate: (iso: string) => string = (iso) =>
    new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
): NoticeView | null {
  const d = (n.data ?? {}) as Record<string, unknown>;
  const matchMeta = (): string | null => {
    const parts: string[] = [];
    const mode = typeof d.mode === 'string' ? d.mode : null;
    if (mode) parts.push(`${d.ranked === true ? 'Ranked' : d.ranked === false ? 'Custom' : ''} ${mode}`.trim());
    const g = gameName(n.game);
    if (g) parts.push(g);
    if (typeof d.at === 'string' && d.at) parts.push(fmtDate(d.at));
    return parts.length ? parts.join(' · ') : null;
  };

  switch (n.kind) {
    case 'match.corrected': {
      const before = score2(d.before);
      const after = score2(d.after);
      const alliance = d.alliance === 'blue' ? 'blue' : 'red';
      if (!before || !after) return null;
      const was = resultOf(alliance, before);
      const now = resultOf(alliance, after);
      const refund = num(d.refund);
      const lines = [`${scoreWords(before)} → ${scoreWords(after)}.`];
      if (now !== was) {
        lines.push(
          now === 'win'
            ? 'You’re now recorded as the winner.'
            : now === 'loss'
              ? 'You’re now recorded as losing it.'
              : 'It’s now recorded as a tie.',
        );
      }
      if (refund > 0) lines.push(`+${refund} rating given back for the loss.`);
      else if (d.ranked === true && now !== was) lines.push('Your rating stays where it was.');
      return {
        title: 'A match score was corrected',
        meta: matchMeta(),
        lines,
        tone: refund > 0 || RESULT_RANK[now] > RESULT_RANK[was] ? 'good' : 'info',
      };
    }
    case 'misscore.upheld': {
      const c = d.corrected as { before?: unknown; after?: unknown } | null | undefined;
      const before = score2(c?.before);
      const after = score2(c?.after);
      return {
        title: 'Your misscore report was upheld',
        meta: matchMeta(),
        lines: [
          before && after
            ? `The score was corrected: ${scoreWords(before)} → ${scoreWords(after)}.`
            : 'A moderator agreed the score was wrong.',
          'Thanks for the report.',
        ],
        tone: 'good',
      };
    }
    case 'misscore.rejected': {
      const cost = (d.cost ?? null) as Partial<StandingCost> | null;
      const charged = cost ? costLines(cost) : [];
      return {
        title: 'Your misscore report was rejected',
        meta: matchMeta(),
        lines: [
          'A moderator checked the replay. The recorded score stands.',
          ...(charged.length ? ['The report was found to be made in bad faith.', ...charged] : []),
        ],
        tone: charged.length ? 'bad' : 'info',
      };
    }
    case 'report.actioned': {
      const subject = typeof d.subject === 'string' && d.subject ? d.subject : 'a player';
      const reasons = Array.isArray(d.reasons) ? (d.reasons as string[]) : [];
      return {
        title: 'A player you reported was penalized',
        meta: null,
        lines: [
          `A moderator reviewed your report against ${subject}${reasons.length ? ` (${reasonWords(reasons)})` : ''} and took action.`,
          'Thanks for the report.',
        ],
        tone: 'good',
      };
    }
    case 'report.closed': {
      const subject = typeof d.subject === 'string' && d.subject ? d.subject : 'a player';
      const reasons = Array.isArray(d.reasons) ? (d.reasons as string[]) : [];
      return {
        title: 'Your report was reviewed',
        meta: null,
        lines: [
          `A moderator reviewed your report against ${subject}${reasons.length ? ` (${reasonWords(reasons)})` : ''} and took no action.`,
        ],
        tone: 'info',
      };
    }
    case 'penalty': {
      const reasons = Array.isArray(d.reasons) ? (d.reasons as string[]) : [];
      const n2 = num(d.reporters);
      const who = n2 > 1 ? `${n2} players` : 'another player';
      return {
        title: 'Reports against you were upheld',
        meta: null,
        lines: [
          `A moderator reviewed reports from ${who}${reasons.length ? ` (${reasonWords(reasons)})` : ''} and upheld them.`,
          ...costLines(d as Partial<StandingCost>),
          'Clean ranked matches and time earn standing back.',
        ],
        tone: 'bad',
      };
    }
    case 'standing.edited': {
      const before = num(d.scoreBefore);
      const after = num(d.scoreAfter);
      const pardoned = num(d.pardoned);
      const lines: string[] = [];
      if (after !== before) lines.push(`Standing ${before} → ${after} (${tierOf(after).name}).`);
      if (pardoned > 0) {
        lines.push(`${pardoned} penalt${pardoned === 1 ? 'y no longer counts' : 'ies no longer count'} against you.`);
      }
      if (d.lock === 'cleared') lines.push('Your ranked lock was lifted.');
      else if (typeof d.lock === 'number' && d.lock > 0) lines.push(`Ranked is locked for ${durationWords(d.lock)}.`);
      const better = after > before || pardoned > 0 || d.lock === 'cleared';
      const worse = after < before || (typeof d.lock === 'number' && d.lock > 0);
      return {
        title:
          after > before
            ? 'A moderator restored your standing'
            : after < before
              ? 'A moderator lowered your standing'
              : 'A moderator reviewed your standing',
        meta: null,
        lines,
        tone: worse ? 'bad' : better ? 'good' : 'info',
      };
    }
    case 'rating.recalculated': {
      const before = num(d.before);
      const after = num(d.after);
      const mode = d.mode === '2v2' ? '2v2' : '1v1';
      const g = gameName(n.game);
      return {
        title: 'Ranked ratings were recalculated',
        meta: g ? `Ranked ${mode} · ${g}` : `Ranked ${mode}`,
        lines: [
          `Your ${mode} rating: ${before} → ${after}.`,
          'Every ranked match this act was re-rated under the new rules: a player’s first games no longer swing the rating as far.',
          `To be ranked on the board you now need ${RANKED_PLACEMENT[mode]} ${mode} matches.`,
        ],
        tone: after > before ? 'good' : 'info',
      };
    }
    case 'competition.message':
    case 'competition.invite':
    case 'competition.promoted':
    case 'competition.removed':
    case 'competition.result':
    case 'competition.finished':
    case 'competition.cancelled':
    case 'competition.card':
    case 'competition.rp':
      return competitionNotice(n.kind, d, gameName(n.game));
    default:
      return null;
  }
}

/** what every competition notice carries */
export interface CompNoticeData {
  slug: string;
  name: string;
  /** competition.invite: who invited you */
  from?: string;
  /** competition.removed: how */
  how?: 'removed' | 'disqualified';
  /** competition.result: the match and what happened to it */
  label?: string;
  what?: 'entered' | 'corrected' | 'forfeit' | 'void' | 'reset';
  /** competition.result: the result as it now stands, from the recipient's side */
  outcome?: MatchResult | null;
  score?: Score2 | null;
  /** competition.finished */
  place?: number | null;
  of?: number;
  /** competition.card: the colour shown (null: a referee withdrew a card) */
  colour?: 'yellow' | 'red' | null;
  /** competition.card: why it costs a match, when it does (`DqReason` in src/competition/types.ts) */
  why?: 'red' | 'yellow2' | 'surrogate';
  /** competition.card from a surrogate match: the match it counts against */
  dqLabel?: string;
  /** competition.rp: the recipient alliance's ranking points from the match, before and after */
  before?: number;
  after?: number;
}

/** "1st", "2nd", "3rd", "11th" */
export function ordinal(n: number): string {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  const suffix = ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
}

function competitionNotice(kind: string, d: Record<string, unknown>, game: string | null): NoticeView | null {
  const name = typeof d.name === 'string' && d.name ? d.name : 'A competition';
  const meta = game ? `Competition · ${game}` : 'Competition';
  switch (kind) {
    case 'competition.message':
      return { title: `Message from ${name}`, meta, lines: ['The organizers wrote to everyone entered.'], tone: 'info' };
    case 'competition.invite': {
      const from = typeof d.from === 'string' && d.from ? d.from : 'A player';
      return {
        title: `${from} invited you to ${name}`,
        meta,
        lines: ['You’d play as their duo partner. Open the competition to accept or decline.'],
        tone: 'info',
      };
    }
    case 'competition.promoted':
      return { title: `You’re in ${name}`, meta, lines: ['A place opened up and you came off the waitlist.'], tone: 'good' };
    case 'competition.removed':
      return {
        title: d.how === 'disqualified' ? `You were disqualified from ${name}` : `You were removed from ${name}`,
        meta,
        lines: [d.how === 'disqualified' ? 'Your remaining matches go to your opponents.' : 'Matches you already played still count.'],
        tone: 'bad',
      };
    case 'competition.result': {
      const label = typeof d.label === 'string' && d.label ? d.label : 'A match';
      const s = score2(d.score);
      const out = d.outcome === 'win' ? 'a win' : d.outcome === 'loss' ? 'a loss' : d.outcome === 'tie' ? 'a tie' : null;
      const what = d.what;
      const title =
        what === 'forfeit'
          ? `${label} was decided by forfeit`
          : what === 'void'
            ? `${label} was voided`
            : what === 'reset'
              ? `${label} will be played again`
              : what === 'corrected'
                ? `${label}’s result was corrected`
                : `${label}’s result was entered by a referee`;
      const lines: string[] = [];
      if (s && what !== 'void' && what !== 'reset') lines.push(`${scoreWords(s)}.`);
      if (out && what !== 'void' && what !== 'reset') lines.push(`It counts as ${out} for you.`);
      if (what === 'void') lines.push('It no longer counts for anyone.');
      if (what === 'reset') lines.push('Its result is cleared. You’ll be told when it’s called.');
      if (!lines.length) lines.push('The competition page has the full schedule.');
      return {
        title,
        meta: `${name} · ${meta}`,
        lines,
        tone: what === 'void' || what === 'reset' ? 'info' : d.outcome === 'win' ? 'good' : d.outcome === 'loss' ? 'bad' : 'info',
      };
    }
    case 'competition.finished': {
      const place = typeof d.place === 'number' && d.place > 0 ? d.place : null;
      const of = num(d.of);
      return {
        title: place === 1 ? `You won ${name}` : `${name} has finished`,
        meta,
        lines: place ? [`You placed ${ordinal(place)}${of > 0 ? ` of ${of}` : ''}.`] : ['The final standings are on the competition page.'],
        tone: place !== null && place <= 3 ? 'good' : 'info',
      };
    }
    case 'competition.cancelled':
      return { title: `${name} was cancelled`, meta, lines: ['Its remaining matches won’t be played.'], tone: 'info' };
    case 'competition.card': {
      const label = typeof d.label === 'string' && d.label ? d.label : 'a match';
      if (d.colour !== 'yellow' && d.colour !== 'red') {
        return { title: `A referee withdrew your card in ${label}`, meta: `${name} · ${meta}`, lines: ['It no longer counts.'], tone: 'info' };
      }
      const dqLabel = typeof d.dqLabel === 'string' && d.dqLabel ? d.dqLabel : null;
      // a yellow that costs a match is a second one: in this match, or carried in from an earlier one
      const second = d.colour === 'yellow' && (d.why === 'yellow2' || d.why === 'surrogate');
      const none = 'You take no ranking points from it.';
      const lines =
        d.why === 'surrogate'
          ? dqLabel
            ? [`It was a surrogate match, so the card counts against ${dqLabel}.`, `You take no ranking points from ${dqLabel}.`]
            : ['It was a surrogate match, so the card counts against your next qualification match.']
          : d.colour === 'red' || second
            ? [none]
            : ['A second yellow card in qualifications is a red card.'];
      return {
        title: second ? `Your second yellow card, in ${label}, is a red card` : `You were shown a ${d.colour} card in ${label}`,
        meta: `${name} · ${meta}`,
        lines,
        tone: 'bad',
      };
    }
    case 'competition.rp': {
      const label = typeof d.label === 'string' && d.label ? d.label : 'a match';
      const before = num(d.before);
      const after = num(d.after);
      return {
        title: `Your ranking points for ${label} changed`,
        meta: `${name} · ${meta}`,
        lines: [`From ${before} to ${after}.`],
        tone: after > before ? 'good' : after < before ? 'bad' : 'info',
      };
    }
    default:
      return null;
  }
}

/** one report this account FILED, as `GET /api/user/reports` serves it (Epic's "My reports") */
export interface FiledReport {
  /** a report about a PLAYER, or a misscore claim about a match */
  kind: 'player' | 'score';
  id: string;
  /** the reported player's name; null for a misscore claim */
  subject: string | null;
  /** the category of a player report; null for a misscore claim */
  reason: string | null;
  game: string;
  status: string;
  createdAt: string;
  reviewedAt: string | null;
  /** standing taken for a claim filed in bad faith */
  smite?: number;
}

/** what a filed report's status means to the person who filed it */
export function filedStatus(r: Pick<FiledReport, 'kind' | 'status' | 'smite'>): { label: string; tone: NoticeTone | 'open' } {
  if (r.status === 'open') return { label: 'Waiting for review', tone: 'open' };
  if (r.kind === 'player') {
    return r.status === 'reviewed' ? { label: 'Action taken', tone: 'good' } : { label: 'No action', tone: 'info' };
  }
  if (r.status === 'upheld') return { label: 'Upheld', tone: 'good' };
  return (r.smite ?? 0) > 0 ? { label: 'Rejected, standing charged', tone: 'bad' } : { label: 'Rejected', tone: 'info' };
}

/** what a filed report is about, in one line */
export function filedWhat(r: Pick<FiledReport, 'kind' | 'subject' | 'reason'>): string {
  if (r.kind === 'score') return 'Misscore';
  const reason = r.reason ? REPORT_LABELS[r.reason as ReportReason] ?? r.reason : null;
  return `${r.subject ?? 'A player'}${reason ? `: ${reason}` : ''}`;
}
