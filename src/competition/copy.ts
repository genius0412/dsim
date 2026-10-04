/**
 * COMPETITION WORDS — every label the pages and the call bar print for a status, a format or a
 * setting, in one place (`docs/area/ui.md` UI COPY: sentence case, one name per thing).
 * DOM-free so `npm run test:comp` can hold them.
 */
import type { GameId } from '../games/types';
import type {
  BracketFormat,
  CardColour,
  CompFormat,
  CompMatchStatus,
  CompStatus,
  DqReason,
  EntryStatus,
  QualKind,
  ResolvedBonus,
  RpLevel,
  RpRuling,
  RpScheme,
  SelectionMode,
  TeamMode,
  Tiebreaker,
} from './types';
import { countdown } from './clock';
import { measureOf } from './manual';

export const STATUS_LABEL: Record<CompStatus, string> = {
  draft: 'Draft',
  published: 'Registration',
  qualification: 'Qualifications',
  selection: 'Alliance selection',
  playoffs: 'Playoffs',
  completed: 'Finished',
  cancelled: 'Cancelled',
};

/** the badge tone a status reads in (`.ds-badge` tones) */
export function statusTone(s: CompStatus): 'accent' | 'ok' | 'warn' | 'danger' | '' {
  if (s === 'qualification' || s === 'selection' || s === 'playoffs') return 'accent';
  if (s === 'published') return 'ok';
  if (s === 'cancelled') return 'danger';
  if (s === 'draft') return 'warn';
  return '';
}

export const ENTRY_LABEL: Record<EntryStatus, string> = {
  registered: 'Registered',
  waitlist: 'Waitlist',
  pending: 'Waiting for partner',
  withdrawn: 'Withdrawn',
  disqualified: 'Disqualified',
};

export const MATCH_LABEL: Record<CompMatchStatus, string> = {
  scheduled: 'Scheduled',
  called: 'Called',
  done: 'Played',
  void: 'Void',
};

export function formatLabel(format: CompFormat, teamMode: TeamMode): string {
  if (format === '1v1') return '1v1';
  return teamMode === 'duo' ? '2v2 · duos' : '2v2 · alliances drawn';
}

export const QUAL_LABEL: Record<QualKind, string> = {
  balanced: 'Balanced schedule',
  roundRobin: 'Round robin',
  swiss: 'Swiss rounds',
  none: 'No qualifications',
};

export const BRACKET_LABEL: Record<BracketFormat, string> = {
  single: 'Single elimination',
  double: 'Double elimination',
};

export const SELECTION_LABEL: Record<SelectionMode, string> = {
  captains: 'Captains pick partners',
  serpentine: 'Paired by seed',
};

export const TIEBREAK_LABEL: Record<Tiebreaker, string> = {
  avgNoFoul: 'Average score without fouls',
  avgScore: 'Average score',
  highScore: 'Highest score',
  avgMargin: 'Average margin',
  wins: 'Wins',
  fewestFouls: 'Fewest fouls given',
  avgAuto: 'Average AUTO points',
  avgBase: 'Average BASE points',
  avgTips: 'Average TIPS',
  avgAscent: 'Average ASCENT points',
};

/** a rankings column header for each tiebreaker; `TIEBREAK_LABEL` is its title */
export const TIEBREAK_COL: Record<Tiebreaker, string> = {
  avgNoFoul: 'Avg no fouls',
  avgScore: 'Avg',
  highScore: 'High',
  avgMargin: 'Margin',
  wins: 'Wins',
  fewestFouls: 'Fouls given',
  avgAuto: 'AUTO',
  avgBase: 'BASE',
  avgTips: 'TIPS',
  avgAscent: 'ASCENT',
};

/** "Average score without fouls, then average BASE points": a tiebreak order as one sentence */
export function tiebreakLine(list: readonly Tiebreaker[]): string {
  if (!list.length) return 'A coin toss';
  return list.map((t, i) => (i ? lowerFirst(TIEBREAK_LABEL[t]) : TIEBREAK_LABEL[t])).join(', then ');
}

/** lower-cases the first letter only, so "AUTO" and "BASE" keep their capitals */
function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/**
 * THE RANKING-POINT WORDS. Game terms keep the manuals' capitals (LEAVE, BASE, PATTERN, PARK,
 * TIPS), as the HUD and BIOBUZZ's results screen print them. The in-match results screen itself
 * shows no ranking points, competition matches included.
 */
export const SCHEME_LABEL: Record<RpScheme, string> = {
  cm: 'Competition Manual',
  custom: 'Win, tie and loss only',
};

export const LEVEL_LABEL: Record<RpLevel, string> = {
  event: 'Standard events',
  regional: 'Regional Championship',
  championship: 'FIRST Championship',
  custom: 'Custom',
};

/** keyed by bonus id (`manual.ts`); the ids are unique across games */
export const BONUS_LABEL: Record<string, string> = {
  movement: 'Movement RP',
  goal: 'Goal RP',
  pattern: 'Pattern RP',
  swarm: 'Swarm RP',
  pollinator1: 'Pollinator 1 RP',
  pollinator2: 'Pollinator 2 RP',
};

/** keyed by measure id (`AllianceFacts` keys), for the referee's inputs and the overview */
export const MEASURE_LABEL: Record<string, string> = {
  auto: 'AUTO points',
  base: 'BASE points',
  movement: 'LEAVE + BASE points',
  artifacts: 'ARTIFACTS scored',
  pattern: 'PATTERN points',
  patternAward: 'PATTERN RP awarded by G417',
  swarm: 'LEAVE + PARK points',
  tips: 'TIPS',
  ascent: 'ASCENT points',
};

/** a counted measure's label for exactly one */
const MEASURE_ONE: Record<string, string> = {
  artifacts: 'ARTIFACT scored',
  tips: 'TIP',
};

/** a bonus id's label, or a plain fallback for one this build does not know */
export function bonusLabel(id: string): string {
  return BONUS_LABEL[id] ?? 'Bonus RP';
}

export function measureLabel(id: string): string {
  return MEASURE_LABEL[id] ?? id;
}

/**
 * WHAT ONE BONUS RP ASKS FOR, in words: "16 LEAVE + BASE points", "36 ARTIFACTS scored", "4 TIPS".
 * The measure's unit comes from the game's table, for the singular of a custom threshold of 1
 * ("1 TIP", "1 PATTERN point").
 */
export function bonusRule(game: GameId, b: Pick<ResolvedBonus, 'measure' | 'threshold'>): string {
  const label = measureLabel(b.measure);
  if (b.threshold !== 1) return `${b.threshold} ${label}`;
  if (measureOf(game, b.measure)?.unit === 'count') return `1 ${MEASURE_ONE[b.measure] ?? label}`;
  return `1 ${label.replace(/ points$/, ' point')}`;
}

export const RULING_LABEL: Record<RpRuling, string> = {
  award: 'Awarded',
  deny: 'Ineligible',
};

/** the select's option for no ruling: the RP goes by what was scored */
export const RULING_NONE = 'As scored';

export const CARD_LABEL: Record<CardColour, string> = {
  yellow: 'Yellow card',
  red: 'Red card',
};

export const DQ_REASON_LABEL: Record<DqReason, string> = {
  dq: 'Disqualified',
  red: 'Red card',
  yellow2: 'Second yellow card',
  surrogate: 'Card from a surrogate match',
};

/** "Best of 3", or nothing for a single game */
export function bestOfLabel(n: number): string {
  return n > 1 ? `Best of ${n}` : 'One game';
}

export { countdown };

/** "1 minute", "3 minutes": a wait given in seconds, as a person says it */
export function minutesLabel(sec: number): string {
  const m = Math.max(1, Math.round(sec / 60));
  return `${m} minute${m === 1 ? '' : 's'}`;
}

/** the one-line answer to "what is happening in this competition right now" */
export function phaseLine(o: {
  status: CompStatus;
  regOpensAt: number | null;
  regClosesAt: number | null;
  startsAt: number | null;
  entrants: number;
  capacity: number;
  now: number;
}): string {
  switch (o.status) {
    case 'draft':
      return 'Not published yet. Only its staff can see it.';
    case 'published': {
      if (o.regOpensAt && o.now < o.regOpensAt) return `Registration opens in ${countdown(o.regOpensAt - o.now)}.`;
      if (o.regClosesAt && o.now >= o.regClosesAt) return 'Registration has closed. Qualifications start soon.';
      const left = o.capacity - o.entrants;
      return left > 0 ? `Registration is open: ${left} of ${o.capacity} places left.` : 'Registration is full. New entries join the waitlist.';
    }
    case 'qualification':
      return 'Qualifications are being played.';
    case 'selection':
      return 'Qualifications are over. The playoff alliances are being formed.';
    case 'playoffs':
      return 'The playoffs are being played.';
    case 'completed':
      return 'This competition has finished.';
    case 'cancelled':
      return 'This competition was cancelled.';
  }
}

/** "A", "A and B", "A, B and C" */
function andList(xs: readonly string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

/** the names in a log line's list: plain strings, or objects with a `name` */
function names(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' && typeof (x as { name?: unknown }).name === 'string' ? (x as { name: string }).name : ''))
    .filter((x) => x !== '');
}

/** a line, then the referee's reason as its own sentence */
function withWhy(line: string, why: string): string {
  return why ? `${line}. ${why}` : `${line}.`;
}

/** why a called match did not become one, as the server codes it (`competitionCallFailed`) */
export type CallFailure = 'noshow' | 'bail' | 'unready';

export const CALL_FAILED: Record<CallFailure, string> = {
  noshow: 'did not connect',
  bail: 'left before the start',
  unready: 'did not ready up in time',
};

/** a forfeit's or an uncall's `why`: a code with the names in `who`, else the text as written (a
 *  referee's reason, or a failed call logged before the code) */
function callFailedWhy(d: Record<string, unknown>): string {
  const why = typeof d.why === 'string' ? d.why : '';
  if (!Array.isArray(d.who) || (why !== 'noshow' && why !== 'bail' && why !== 'unready')) return why;
  return `${andList(names(d.who)) || 'A driver'} ${CALL_FAILED[why]}.`;
}

/** what a log line says, from its kind and data. Null for a kind this build does not know. */
export function logLine(kind: string, d: Record<string, unknown>): string | null {
  const s = (k: string): string => (typeof d[k] === 'string' ? (d[k] as string) : '');
  const label = s('label');
  const name = s('name');
  switch (kind) {
    case 'created':
      return 'Created.';
    case 'edited':
      return 'Settings changed.';
    case 'status.published':
      return 'Published. Registration follows its window.';
    case 'status.draft':
      return 'Moved back to draft.';
    case 'status.qualification':
      return 'Qualifications started.';
    case 'status.selection':
      return 'Qualifications ended. Seeding is frozen.';
    case 'status.playoffs':
      return 'The playoff bracket was built.';
    case 'status.completed': {
      const champs = Array.isArray(d.champions) ? (d.champions as string[]).filter((x) => typeof x === 'string') : [];
      return champs.length ? `Finished. Champions: ${champs.join(' and ')}.` : 'Finished.';
    }
    case 'status.cancelled':
      return 'Cancelled.';
    case 'registration.closed':
      return 'Registration closed.';
    case 'registration.opened':
      return 'Registration opened.';
    case 'entry.register':
      return name ? `${name} registered.` : 'A player registered.';
    case 'entry.withdraw':
      return name ? `${name} withdrew.` : 'An entry withdrew.';
    case 'entry.promoted':
      return name ? `${name} came off the waitlist.` : 'An entry came off the waitlist.';
    case 'entry.accept':
      return name ? `${name}’s duo is complete.` : 'A duo is complete.';
    case 'entry.add':
      return name ? `${name} was entered by an organizer.` : 'An organizer added an entry.';
    case 'entry.remove':
      return name ? `${name} was removed.` : 'An entry was removed.';
    case 'entry.disqualify':
      return name ? `${name} was disqualified.` : 'An entry was disqualified.';
    case 'entry.reinstate':
      return name ? `${name} was reinstated.` : 'An entry was reinstated.';
    case 'entry.rename':
      return `${s('from') || 'An entry'} is now ${s('to') || 'renamed'}.`;
    case 'entry.checkin':
      return name ? `${name} checked in.` : 'An entry checked in.';
    case 'schedule.drawn':
      return `The qualification schedule was drawn: ${Number(d.matches) || 0} matches.`;
    case 'schedule.round':
      return `Swiss round ${Number(d.round) || ''} was drawn.`;
    case 'schedule.bye':
      return name ? `${name} sits out round ${Number(d.round) || ''}.` : 'An entry has a bye.';
    case 'schedule.swap':
      return name ? `${name} was moved into ${label || 'a match'}.` : 'A match was changed.';
    case 'match.called':
      return `${label} was called.`;
    case 'match.uncalled': {
      const why = callFailedWhy(d);
      return why ? `${label || 'A match'} went back on the schedule: ${why}` : `${label || 'A match'} went back on the schedule.`;
    }
    case 'match.result': {
      const w = s('winner');
      return `${label}: red ${Number(d.red) || 0}, blue ${Number(d.blue) || 0}${w === 'tie' ? ', a tie' : w ? `, ${w} wins` : ''}.`;
    }
    case 'match.forfeit': {
      // `why: 'empty'` is the server's code for an alliance with nobody left to play
      const why = s('why') === 'empty' ? 'The other alliance had nobody left to play.' : callFailedWhy(d);
      const dq = names(d.dq);
      const out = dq.length ? ` ${andList(dq)} ${dq.length === 1 ? 'was' : 'were'} disqualified.` : '';
      return `${label}: ${s('winner') || 'one alliance'} wins by forfeit.${out}${why ? ` ${why}` : ''}`;
    }
    case 'match.entered':
      return `${label}: a referee entered red ${Number(d.red) || 0}, blue ${Number(d.blue) || 0}.`;
    case 'match.corrected':
      return `${label}: corrected to red ${Number(d.red) || 0}, blue ${Number(d.blue) || 0}${s('why') ? `. ${s('why')}` : '.'}`;
    case 'match.void':
      return s('why') === 'empty' ? `${label} was voided: nobody was left to play it.` : `${label} was voided${s('why') ? `: ${s('why')}` : '.'}`;
    case 'match.reset': {
      const cards = names(d.cards);
      return cards.length
        ? `${label} will be played again. The referee cards for ${andList(cards)} were withdrawn.`
        : `${label} will be played again.`;
    }
    case 'match.dq':
      return `${name || 'An entry'} was disqualified in ${label}.`;
    case 'match.undq':
      return `${name || 'An entry'}’s disqualification in ${label} was lifted.`;
    case 'match.note':
      return s('note') ? `Note on ${label}: “${s('note')}”` : `The note on ${label} was removed.`;
    case 'match.card': {
      const who = name || 'an entry';
      const c = s('colour');
      const line =
        c === 'yellow' || c === 'red'
          ? `${label}: ${who} was shown a ${c} card`
          : `${label}: ${name ? `${name}’s` : 'an entry’s'} card was withdrawn`;
      return withWhy(line, s('why'));
    }
    case 'match.rp': {
      const side = s('alliance') || 'an alliance';
      const bonus = bonusLabel(s('bonus'));
      const r = s('ruling');
      const line =
        r === 'award'
          ? `${label}: ${side} was awarded the ${bonus}`
          : r === 'deny'
            ? `${label}: ${side} was ruled ineligible for the ${bonus}`
            : `${label}: the ruling on ${side}’s ${bonus} was withdrawn`;
      return withWhy(line, s('why'));
    }
    case 'match.facts':
      return withWhy(`${label}: the score breakdown was corrected`, s('why'));
    case 'selection.pick':
      return `Alliance ${Number(d.alliance) || ''} picked ${name || 'an entry'}.`;
    case 'selection.decline':
      return `${name || 'An entry'} declined.`;
    case 'selection.undo':
      return 'The last selection was undone.';
    case 'selection.reset':
      return 'Alliance selection was restarted.';
    case 'staff.add':
      return `A ${s('role') || 'staff member'} was added.`;
    case 'staff.remove':
      return 'A staff member was removed.';
    case 'message':
      return s('message') ? `Message to entrants: “${s('message')}”` : 'A message went to every entrant.';
    default:
      return null;
  }
}
