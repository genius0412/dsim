/**
 * A COMPETITION'S SETTINGS: the defaults, and the one coercer every write goes through.
 *
 * `competitions.settings` is jsonb, so a client (or an older build, or a hand-edited row) can put
 * anything there. The server coerces every write and every read through `coerceCompSettings`, field
 * by field, the way `coerceSettings` treats a player's settings blob: an unknown or out-of-range
 * value falls back to its default rather than refusing the whole object, so one bad field never
 * costs an organizer every other choice they made.
 *
 * Some choices only make sense for some shapes of competition, and the coercer folds them back
 * rather than leaving an impossible combination for the scheduler to discover:
 *   - round robin and swiss need ONE entry per alliance (1v1, or 2v2 duos), so a 2v2 of solo
 *     entries falls back to `balanced`;
 *   - alliance selection only exists where two solo entries form an alliance.
 */
import type {
  BracketFormat,
  CompFormat,
  CompSettings,
  QualKind,
  SelectionMode,
  TeamMode,
  Tiebreaker,
} from './types';
import { TIEBREAKERS } from './types';

export const QUAL_KINDS: readonly QualKind[] = ['balanced', 'roundRobin', 'swiss', 'none'];
export const BRACKET_FORMATS: readonly BracketFormat[] = ['single', 'double'];
export const SELECTION_MODES: readonly SelectionMode[] = ['captains', 'serpentine'];
export const PLAYOFF_SIZES = [2, 4, 8, 16] as const;
export const BEST_OF = [1, 3, 5] as const;

/** the bounds the coercer enforces, exported so the editor's inputs say the same thing */
export const LIMITS = {
  matchesPerEntry: { min: 1, max: 12 },
  /** round robin: full cycles */
  cycles: { min: 1, max: 3 },
  minGap: { min: 0, max: 6 },
  points: { min: 0, max: 10 },
  joinGraceSec: { min: 60, max: 900 },
  maxConcurrent: { min: 1, max: 16 },
  restSec: { min: 0, max: 900 },
  capacity: { min: 2, max: 256 },
  name: { min: 3, max: 60 },
  summary: { max: 140 },
  description: { max: 8000 },
  rules: { max: 8000 },
} as const;

export const DEFAULT_SETTINGS: CompSettings = {
  quals: { kind: 'balanced', matchesPerEntry: 5, minGap: 1 },
  points: { win: 2, tie: 1, loss: 0 },
  tiebreakers: ['avgNoFoul', 'highScore', 'avgMargin'],
  playoffs: {
    enabled: true,
    alliances: 4,
    format: 'double',
    bestOf: 1,
    finalsBestOf: 3,
    selection: 'captains',
  },
  run: { joinGraceSec: 180, noShow: 'hold', autoCall: false, maxConcurrent: 4, restSec: 60 },
  checkIn: true,
};

/** robots one entry fields: a duo is two drivers on one alliance */
export function robotsPerEntry(teamMode: TeamMode): 1 | 2 {
  return teamMode === 'duo' ? 2 : 1;
}

/** entries that make up one alliance: two solo entries in a 2v2, else one */
export function entriesPerAlliance(format: CompFormat, teamMode: TeamMode): 1 | 2 {
  return format === '2v2' && teamMode === 'solo' ? 2 : 1;
}

/** a duo only exists in a 2v2 */
export function coerceTeamMode(format: CompFormat, raw: unknown): TeamMode {
  return format === '2v2' && raw === 'duo' ? 'duo' : 'solo';
}

const int = (v: unknown, d: number, min: number, max: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return d;
  return Math.min(max, Math.max(min, Math.round(n)));
};
const pick = <T,>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * `raw` coerced into settings for a competition of this shape. Never throws; every field that is
 * missing or wrong takes its default.
 */
export function coerceCompSettings(raw: unknown, format: CompFormat, teamMode: TeamMode): CompSettings {
  const r = obj(raw);
  const d = DEFAULT_SETTINGS;
  const oneEntryPerAlliance = entriesPerAlliance(format, teamMode) === 1;

  const q = obj(r.quals);
  let kind = pick(q.kind, QUAL_KINDS, d.quals.kind);
  if (!oneEntryPerAlliance && (kind === 'roundRobin' || kind === 'swiss')) kind = 'balanced';
  const perEntry =
    kind === 'roundRobin'
      ? int(q.matchesPerEntry, 1, LIMITS.cycles.min, LIMITS.cycles.max)
      : int(q.matchesPerEntry, d.quals.matchesPerEntry, LIMITS.matchesPerEntry.min, LIMITS.matchesPerEntry.max);

  const p = obj(r.points);
  const win = int(p.win, d.points.win, LIMITS.points.min, LIMITS.points.max);
  const tie = Math.min(win, int(p.tie, d.points.tie, LIMITS.points.min, LIMITS.points.max));
  const loss = Math.min(tie, int(p.loss, d.points.loss, LIMITS.points.min, LIMITS.points.max));

  // a list of distinct known tiebreakers, in the organizer's order
  const tb: Tiebreaker[] = [];
  if (Array.isArray(r.tiebreakers)) {
    for (const t of r.tiebreakers) if (TIEBREAKERS.includes(t as Tiebreaker) && !tb.includes(t as Tiebreaker)) tb.push(t as Tiebreaker);
  }

  const po = obj(r.playoffs);
  const run = obj(r.run);
  return {
    quals: { kind, matchesPerEntry: perEntry, minGap: int(q.minGap, d.quals.minGap, LIMITS.minGap.min, LIMITS.minGap.max) },
    points: { win, tie, loss },
    tiebreakers: Array.isArray(r.tiebreakers) ? tb : [...d.tiebreakers],
    playoffs: {
      // a competition with no qualifications IS its playoffs
      enabled: kind === 'none' ? true : typeof po.enabled === 'boolean' ? po.enabled : d.playoffs.enabled,
      alliances: pick(Number(po.alliances), PLAYOFF_SIZES, d.playoffs.alliances),
      format: pick(po.format, BRACKET_FORMATS, d.playoffs.format),
      bestOf: pick(Number(po.bestOf), BEST_OF, d.playoffs.bestOf),
      finalsBestOf: pick(Number(po.finalsBestOf), BEST_OF, d.playoffs.finalsBestOf),
      selection: oneEntryPerAlliance ? 'serpentine' : pick(po.selection, SELECTION_MODES, d.playoffs.selection),
    },
    run: {
      joinGraceSec: int(run.joinGraceSec, d.run.joinGraceSec, LIMITS.joinGraceSec.min, LIMITS.joinGraceSec.max),
      noShow: run.noShow === 'forfeit' ? 'forfeit' : 'hold',
      autoCall: typeof run.autoCall === 'boolean' ? run.autoCall : d.run.autoCall,
      maxConcurrent: int(run.maxConcurrent, d.run.maxConcurrent, LIMITS.maxConcurrent.min, LIMITS.maxConcurrent.max),
      restSec: int(run.restSec, d.run.restSec, LIMITS.restSec.min, LIMITS.restSec.max),
    },
    checkIn: typeof r.checkIn === 'boolean' ? r.checkIn : d.checkIn,
  };
}

/** entries a playoff of this size needs: an alliance of two solo entries needs two each */
export function playoffEntriesNeeded(s: CompSettings, format: CompFormat, teamMode: TeamMode): number {
  return s.playoffs.alliances * entriesPerAlliance(format, teamMode);
}

/**
 * A URL key from a name: lowercase, ASCII letters, digits and single dashes, 3–48 characters.
 * The server makes it unique by appending a number.
 */
export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return s.length >= 3 ? s : `event-${s || 'x'}`.slice(0, 48);
}

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/;
