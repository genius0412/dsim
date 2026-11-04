import type { Alliance, CardColor } from '../types';

/**
 * THE PENALTY LINE — written once, read back once.
 *
 * Every sanction any of the three games issues reaches a human as a line in `world.events`:
 * `MINOR FOUL - BLUE +5 (G424 contact in the gate zone)`. The live HUD pops it as a toast and
 * forgets it, which is all a driver mid-match wants. A REPLAY wants the opposite — the whole
 * list, at the ticks the calls landed, so somebody can see why the score moved — and that
 * means reading the line back apart.
 *
 * A LEAF MODULE HOLDING BOTH HALVES, and that is the point. The alternative was a regex in
 * the viewer matching a template three files away (`src/sim/scoring.ts`, and BIOBUZZ's own
 * tariff wrapper, which mirrors the same text for its 20-point majors), with nothing tying
 * the two together: change "FOUL" to "PENALTY" for the toast and the replay's penalty list
 * silently empties. Here the formatter is the only way a line is written and the parser is
 * the only way one is read, `npm test` round-trips them, and the drift cannot happen.
 *
 * DOM-free and import-free, so the sim, the headless suites and the UI can all have it.
 *
 * ⚠️ These strings are USER-VISIBLE COPY, and they live in `src/sim/`, so changing one is a
 * SERVER change and needs a deploy — the same rule the foul names themselves carry.
 */

/** who a foul was awarded TO, and everything a reader needs to say what happened */
export interface FoulLine {
  kind: 'foul';
  severity: 'minor' | 'major';
  /** the alliance the points went to — the one that did NOT commit it */
  awardedTo: Alliance;
  /** the alliance that committed it (the other one) */
  offender: Alliance;
  points: number;
  rule: string;
}

export interface CardLine {
  kind: 'card';
  colour: CardColor;
  /** the carded robot's alliance */
  alliance: Alliance;
  /** the team number or robot name the sim named */
  who: string;
  rule: string;
}

/** BIOBUZZ's third severity: a referee's verbal warning. No points, no tally — an event and
 *  nothing else, which is exactly what it is on a real field. */
export interface WarningLine {
  kind: 'warning';
  alliance: Alliance;
  rule: string;
}

export type PenaltyLine = FoulLine | CardLine | WarningLine;

const SIDE = (a: Alliance): string => a.toUpperCase();
const otherSide = (a: Alliance): Alliance => (a === 'red' ? 'blue' : 'red');
const allianceOf = (s: string): Alliance | null =>
  s === 'RED' ? 'red' : s === 'BLUE' ? 'blue' : null;

/** `MINOR FOUL - BLUE +5 (G424 contact in the gate zone)` — `victim` is who GAINS the points */
export const foulEventText = (
  severity: 'minor' | 'major',
  victim: Alliance,
  points: number,
  rule: string,
): string => `${severity === 'major' ? 'MAJOR' : 'MINOR'} FOUL - ${SIDE(victim)} +${points} (${rule})`;

/**
 * How a card line NAMES its robot: the team number, else the robot's name, else its seat. The
 * one formula, so the HUD's card signal can find the line for the robot it is drawing (the world
 * keeps a card's colour and nothing else). Unchanged from what `awardCard` always wrote.
 */
export const cardSubject = (spec: { teamNumber?: number | string | null; name?: string }, id: number): string =>
  spec.teamNumber ? `#${spec.teamNumber}` : spec.name || `robot ${id}`;

/** `YELLOW CARD - RED #4239 (G408 excessive control)` */
export const cardEventText = (
  colour: CardColor,
  alliance: Alliance,
  who: string,
  rule: string,
): string => `${colour.toUpperCase()} CARD - ${SIDE(alliance)} ${who} (${rule})`;

/** `WARNING - RED (G407 …)` */
export const warningEventText = (alliance: Alliance, rule: string): string =>
  `WARNING - ${SIDE(alliance)} (${rule})`;

/**
 * THE RULE IS GREEDY TO THE LAST BRACKET, on purpose: a rule name can itself contain
 * parentheses (`G408 over-possession (continuing)` is a real one), so a lazy match would cut
 * it in half and print a stray `)`.
 */
const FOUL_RE = /^(MINOR|MAJOR) FOUL - (RED|BLUE) \+(\d+) \((.*)\)$/;
/** the robot NAME is lazy, because it is user-supplied and the rule is the reliable end */
const CARD_RE = /^(YELLOW|RED) CARD - (RED|BLUE) (.+?) \((.*)\)$/;
const WARN_RE = /^WARNING - (RED|BLUE) \((.*)\)$/;

/**
 * Read one `world.events` line back as a sanction, or null when it is not one.
 *
 * Null is the common case and not a failure — the same list carries phase transitions, LEAVE
 * credits and whatever else a game pushes — so a caller filters on it rather than checking it.
 */
export function parsePenaltyEvent(text: string): PenaltyLine | null {
  const foul = FOUL_RE.exec(text);
  if (foul) {
    const awardedTo = allianceOf(foul[2]);
    if (!awardedTo) return null;
    return {
      kind: 'foul',
      severity: foul[1] === 'MAJOR' ? 'major' : 'minor',
      awardedTo,
      offender: otherSide(awardedTo),
      points: Number(foul[3]),
      rule: foul[4],
    };
  }
  const card = CARD_RE.exec(text);
  if (card) {
    const alliance = allianceOf(card[2]);
    if (!alliance) return null;
    return {
      kind: 'card',
      colour: card[1] === 'RED' ? 'red' : 'yellow',
      alliance,
      who: card[3],
      rule: card[4],
    };
  }
  const warn = WARN_RE.exec(text);
  if (warn) {
    const alliance = allianceOf(warn[1]);
    if (!alliance) return null;
    return { kind: 'warning', alliance, rule: warn[2] };
  }
  return null;
}
