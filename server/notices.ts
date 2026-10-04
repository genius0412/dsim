/**
 * PLAYER NOTICES — the server half of `src/notices.ts`: who is told what, after each
 * moderation outcome (migration 0057).
 *
 * Called by the admin routes in `server/index.ts` AFTER the outcome itself has been committed,
 * so the notice describes what was actually stored (the standing verdict a charge returned, the
 * refund that landed), never what was asked for.
 *
 * NOTHING HERE THROWS INTO A ROUTE, the rule `writeAudit` and `server/standing.ts` follow: the
 * decision has already been made and written, and a failure to tell somebody about it must not
 * turn the moderator's request into a 500 they would retry. Every function answers how many
 * notices it wrote, and 0 when it could not.
 */
import { dbEnabled } from './db/pool';
import { addNotices, getProfile, matchScoreDetail, type MatchScoreRow, type NewNotice } from './db/repo';
import type { StandingVerdict } from '../src/standing';
import type {
  MatchCorrectedData,
  MisscoreData,
  PenaltyData,
  ReportOutcomeData,
  Score2,
  StandingCost,
  StandingEditedData,
} from '../src/notices';

async function send(rows: NewNotice[]): Promise<number> {
  if (!dbEnabled || !rows.length) return 0;
  try {
    return await addNotices(rows);
  } catch (e) {
    console.error('[notices] write failed:', e);
    return 0;
  }
}

/** what an offence cost, as the player is told it; null when nothing was charged */
export function costOf(v: StandingVerdict | null): StandingCost | null {
  if (!v) return null;
  return { points: v.points, scoreAfter: v.scoreAfter, cooldownMin: v.cooldownMin, ratingCharge: v.ratingCharge };
}

const matchRef = (m: MatchScoreRow): { at: string; mode: string; ranked: boolean | null } => ({
  at: m.createdAt,
  mode: m.mode,
  ranked: m.ranked,
});

/** the reported player's name, the way the reporter saw it */
async function nameOf(userId: string): Promise<string> {
  try {
    const p = await getProfile(userId);
    return p?.username ? `@${p.username}` : p?.handle || 'a player';
  } catch {
    return 'a player';
  }
}

/**
 * A MISSCORE CLAIM WAS RULED ON — tell the filer. An upheld claim carries the corrected
 * numbers when the match has been corrected (the original result → what it says now); a
 * rejected one carries what it cost when the moderator smote it.
 */
export async function noticeMisscore(o: {
  reporterId: string;
  matchId: string | null;
  game: string;
  verdict: 'upheld' | 'rejected';
  cost: StandingCost | null;
  message: string | null;
}): Promise<number> {
  try {
    const m = o.matchId ? await matchScoreDetail(o.matchId) : null;
    const data: MisscoreData = {
      ...(m ? matchRef(m) : {}),
      corrected:
        o.verdict === 'upheld' && m && m.corrections.length
          ? { before: m.original, after: { red: m.red, blue: m.blue } }
          : null,
      cost: o.verdict === 'rejected' ? o.cost : null,
    };
    return await send([
      { userId: o.reporterId, kind: `misscore.${o.verdict}`, game: m?.game ?? o.game, data: { ...data }, message: o.message },
    ]);
  } catch (e) {
    console.error('[notices] misscore notice failed:', e);
    return 0;
  }
}

/**
 * A MATCH'S SCORE WAS CORRECTED — tell every player in it, each from their own alliance's side:
 * the totals before and after, whether their result changed, and any rating given back.
 * `m` is the match as it reads AFTER the correction.
 */
export async function noticeCorrection(o: {
  match: MatchScoreRow;
  before: Score2;
  after: Score2;
  refunds: { userId: string; points: number }[];
  message: string | null;
}): Promise<number> {
  const back = new Map(o.refunds.map((r) => [r.userId, r.points]));
  const rows: NewNotice[] = o.match.participants.map((p) => {
    const data: MatchCorrectedData = {
      ...matchRef(o.match),
      alliance: p.alliance,
      before: o.before,
      after: o.after,
      refund: back.get(p.userId) ?? 0,
    };
    return { userId: p.userId, kind: 'match.corrected', game: o.match.game, data: { ...data }, message: o.message };
  });
  return send(rows);
}

/**
 * REPORTS AGAINST A PLAYER WERE TRIAGED — tell each reporter the outcome of THEIR report (action
 * taken / no action, never the size of the penalty), and on an upheld verdict tell the player
 * what it cost them and why. Two messages because there are two audiences: what a moderator
 * writes to the people who reported is not necessarily what they write to the reported.
 */
export async function noticeReportTriage(o: {
  target: string;
  status: 'reviewed' | 'dismissed';
  closed: { reporterId: string; reason: string; game: string }[];
  verdict: StandingVerdict | null;
  reporterMessage: string | null;
  playerMessage: string | null;
}): Promise<number> {
  if (!o.closed.length) return 0;
  try {
    const subject = await nameOf(o.target);
    const by = new Map<string, { reasons: Set<string>; game: string }>();
    for (const r of o.closed) {
      const e = by.get(r.reporterId) ?? { reasons: new Set<string>(), game: r.game };
      e.reasons.add(r.reason);
      by.set(r.reporterId, e);
    }
    const rows: NewNotice[] = [...by.entries()]
      .filter(([reporterId]) => reporterId !== o.target)
      .map(([reporterId, e]) => {
        const data: ReportOutcomeData = { subject, reasons: [...e.reasons] };
        return {
          userId: reporterId,
          kind: o.status === 'reviewed' ? 'report.actioned' : 'report.closed',
          game: e.game,
          data: { ...data },
          message: o.reporterMessage,
        };
      });
    if (o.status === 'reviewed') {
      const cost = costOf(o.verdict) ?? { points: 0, scoreAfter: 0, cooldownMin: 0, ratingCharge: 0 };
      const data: PenaltyData = {
        ...cost,
        reasons: [...new Set(o.closed.map((r) => r.reason))],
        reporters: by.size,
      };
      rows.push({ userId: o.target, kind: 'penalty', game: null, data: { ...data }, message: o.playerMessage });
    }
    return await send(rows);
  } catch (e) {
    console.error('[notices] report notice failed:', e);
    return 0;
  }
}

/** A MODERATOR EDITED SOMEBODY'S STANDING — tell them, with the reason the editor typed */
export async function noticeStandingEdit(o: {
  target: string;
  scoreBefore: number;
  scoreAfter: number;
  pardoned: number;
  lock: false | number | undefined;
  note: string | null;
}): Promise<number> {
  const data: StandingEditedData = {
    scoreBefore: o.scoreBefore,
    scoreAfter: o.scoreAfter,
    pardoned: o.pardoned,
    lock: o.lock === false ? 'cleared' : typeof o.lock === 'number' && o.lock > 0 ? o.lock : null,
  };
  return send([{ userId: o.target, kind: 'standing.edited', game: null, data: { ...data }, message: o.note }]);
}
