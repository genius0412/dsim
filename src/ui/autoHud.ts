import type { GameAutoStatus, HudSnapshot } from '../game';

/**
 * WHAT THE MATCH SCREEN SAYS ABOUT THE ZENITH AUTO (docs/area/autos.md). DOM-free and in the main
 * chunk, so the AUTO smoke lane holds the words: before this, a file the seat could not load, or
 * one Zenith refuses (a start in the other half, a path through the HIVE), drove nothing or drove
 * wrong with nothing on screen but an event-log line most drivers never read.
 */
type AutoHud = Pick<HudSnapshot, 'auto' | 'phase'>;

/**
 * The line on the second HUD card: the step running (or STUCK on it), a shot the auto gave up on,
 * AUTO DONE, or AUTO OFF when it cannot run. STUCK wins over the shot: the robot is held now, and
 * the shot is a step already behind it (`AutoSeatStatus.cantShoot` stays up for 3 s of match time).
 */
export function autoHudLine({ auto, phase }: AutoHud): string | null {
  if (!auto) return null;
  if (auto.state === 'running' && auto.stuck) return `AUTO STUCK ON ${(auto.stepId ?? auto.name).toUpperCase()}`;
  if (auto.cantShoot !== undefined && (auto.state === 'running' || auto.state === 'done') && (phase === 'auto' || phase === 'freeplay')) {
    return `AUTO COULDN’T SHOOT ON ${(auto.cantShoot || auto.name).toUpperCase()}`;
  }
  if (auto.state === 'running') return `AUTO · ${(auto.stepId ?? auto.name).toUpperCase()}`;
  const early = phase === 'pre' || phase === 'auto' || phase === 'freeplay';
  if (auto.state === 'done' && (phase === 'auto' || phase === 'freeplay')) return 'AUTO DONE';
  if (auto.state === 'error' && early) return 'AUTO OFF';
  return null;
}

/** "a", "a and b", "a, b and c" */
function nameList(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * What the file uses that will not run, as one sentence per cause (empty when it uses none): the
 * commands DSIM does not run, the conditions it cannot read, and the commands this build has no
 * mechanism for. The Autonomous panel lists the same as "Not in DSIM" and "Not on this robot". A
 * command ends at once and a condition never reads true (a wait on one runs to its timeout), so
 * the driver is not left wondering why a step did nothing.
 */
function skippedClause({
  unsupported,
  unsupportedConditions,
  notOnRobot,
}: Pick<GameAutoStatus, 'unsupported' | 'unsupportedConditions' | 'notOnRobot'>): string {
  const clause = (names: readonly string[] | undefined, why: string, does: [string, string]): string => {
    const list = [...new Set(names ?? [])];
    if (list.length === 0) return '';
    const one = list.length === 1;
    return `${nameList(list)} ${one ? 'is' : 'are'} ${why} and ${one ? does[0] : does[1]}.`;
  };
  return [
    clause(unsupported, 'not in DSIM', ['ends at once', 'end at once']),
    clause(unsupportedConditions, 'not in DSIM', ['never reads true', 'never read true']),
    clause(notOnRobot, 'not on this robot', ['ends at once', 'end at once']),
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * The pre-match panel's line: which auto AUTO plays, why it will not, or what Zenith flags in it,
 * and what in the file will not run. `tone` picks the `.ds-hint` modifier.
 */
export function autoPreNotice({ auto }: Pick<HudSnapshot, 'auto'>): { tone: 'ok' | 'warn' | 'err'; text: string } | null {
  if (!auto) return null;
  if (auto.state === 'error') {
    return { tone: 'err', text: `Auto off: ${auto.error ?? 'the auto could not be loaded.'} You drive in AUTO.` };
  }
  const skipped = skippedClause(auto);
  const n = auto.problems.length;
  if (n > 0) {
    return {
      tone: 'warn',
      text: `${auto.name} plays in AUTO, but Zenith flags ${n === 1 ? 'a problem' : `${n} problems`}. ${auto.problems[0]}${skipped ? ` ${skipped}` : ''}`,
    };
  }
  if (skipped) return { tone: 'warn', text: `${auto.name} plays in AUTO. ${skipped}` };
  return { tone: 'ok', text: `${auto.name} plays in AUTO.` };
}

/** "1 step", "3 steps" */
export const countOf = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * The Autonomous panel's verdict on the selected auto, from its `AutoView`: Zenith's first problem,
 * or the step count and the estimate against the AUTO period ("1 step, about 1.1 s of 30 s": it
 * read "1 steps"). Here, and DOM-free, so the AUTOUI lane holds the words.
 */
export function planVerdict(v: {
  errors: readonly { message: string }[];
  steps: number;
  atLeast: boolean;
  estimateS: number | null;
  periodS: number;
}): { ok: boolean; text: string } {
  if (v.errors.length > 0) return { ok: false, text: `${countOf(v.errors.length, 'problem')}: ${v.errors[0].message}` };
  return { ok: true, text: `${countOf(v.steps, 'step')}, ${v.atLeast ? 'at least ' : 'about '}${(v.estimateS ?? 0).toFixed(1)} s of ${v.periodS} s` };
}

/** The panel's "Warning" / "Warnings" row: the one message, or the count and the first. */
export function warningsFact(warnings: readonly { message: string }[]): { label: string; text: string } | null {
  if (warnings.length === 0) return null;
  return warnings.length === 1
    ? { label: 'Warning', text: warnings[0].message }
    : { label: 'Warnings', text: `${warnings.length}. First: ${warnings[0].message}` };
}

/** What follows a list of commands that do not run: "It ends at once." / "These end at once." */
export function endsAtOnce(names: readonly string[]): string {
  return `${names.length > 1 ? 'These end' : 'It ends'} at once.`;
}

/** ...and what follows a list of conditions DSIM cannot read: "It never reads true." */
export function neverReadsTrue(names: readonly string[]): string {
  return `${names.length > 1 ? 'These never read' : 'It never reads'} true.`;
}
