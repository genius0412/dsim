/**
 * COMPETITION WORDS — every label the pages and the call bar print for a status, a format or a
 * setting, in one place (`docs/area/ui.md` UI COPY: sentence case, one name per thing).
 * DOM-free so `npm run test:comp` can hold them.
 */
import type {
  BracketFormat,
  CompFormat,
  CompMatchStatus,
  CompStatus,
  EntryStatus,
  QualKind,
  SelectionMode,
  TeamMode,
  Tiebreaker,
} from './types';
import { countdown } from './clock';

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
    case 'match.uncalled':
      return s('why') ? `${label || 'A match'} went back on the schedule: ${s('why')}` : `${label || 'A match'} went back on the schedule.`;
    case 'match.result': {
      const w = s('winner');
      return `${label}: red ${Number(d.red) || 0}, blue ${Number(d.blue) || 0}${w === 'tie' ? ', a tie' : w ? `, ${w} wins` : ''}.`;
    }
    case 'match.forfeit':
      return `${label}: ${s('winner') || 'one alliance'} wins by forfeit${s('why') ? `. ${s('why')}` : '.'}`;
    case 'match.entered':
      return `${label}: a referee entered red ${Number(d.red) || 0}, blue ${Number(d.blue) || 0}.`;
    case 'match.corrected':
      return `${label}: corrected to red ${Number(d.red) || 0}, blue ${Number(d.blue) || 0}${s('why') ? `. ${s('why')}` : '.'}`;
    case 'match.void':
      return `${label} was voided${s('why') ? `: ${s('why')}` : '.'}`;
    case 'match.reset':
      return `${label} will be played again.`;
    case 'match.dq':
      return `${name || 'An entry'} was disqualified in ${label}.`;
    case 'match.undq':
      return `${name || 'An entry'}’s disqualification in ${label} was lifted.`;
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
