/**
 * PLAYOFF ALLIANCE FORMATION: FTC alliance selection, and serpentine seeding.
 *
 * Selection is stored as its ACTIONS (each pick and decline, in order), never as the alliances
 * they produce. `selectionState` replays the log from the seeding order, so a re-read derives the
 * same alliances, and a corrected ranking before selection starts simply changes who the captains
 * are. The server validates an action with `applySelection` before appending it; replay skips
 * anything invalid rather than throwing, so one bad row can never brick the event.
 */
import type { PlayoffAlliance, SelectionAction, SelectionState } from './types';

/**
 * The selection state plus what is needed to apply the next action: the seeding order and the
 * alliance count (a promotion picks the next entry in `order`, which the public state alone does
 * not carry — declined entries drop out of `available` but can still become captains).
 */
export interface Selection extends SelectionState {
  order: number[];
  allianceCount: number;
  /**
   * Set when selection cannot finish: no entry is left to fill the alliance on turn. Named
   * `stuck`, not `error`, so `'error' in result` keeps meaning "applySelection refused".
   */
  stuck?: string;
}

/**
 * Derive the selection from the seeding order (eligible entries, best first) and the action log.
 *
 * FTC rules, two entries per alliance: the top `allianceCount` of `order` are captains, and in
 * seed order each captain picks one partner. A captain may pick a LOWER captain: that alliance
 * dissolves, the alliances below it move up a seed in order, and the next entry in `order` not on
 * an alliance becomes the new last captain (a declined entry can; declining only stops it being
 * picked). A decline does not use up the turn.
 *
 * If there are not enough entries, `complete` never becomes true: `turn` stays on the alliance
 * that cannot fill (null if no entry was left even to captain it), `available` is empty, and
 * `stuck` says why.
 */
export function selectionState(order: number[], allianceCount: number, actions: SelectionAction[]): Selection {
  const uniq = [...new Set(order)];
  const n = Math.max(0, Math.floor(allianceCount));
  const alliances: PlayoffAlliance[] = uniq.slice(0, n).map((e, i) => ({ seed: i + 1, entries: [e] }));
  let st = finish(uniq, n, alliances, []);
  for (const a of actions) {
    const r = applySelection(st, a);
    if (!('error' in r)) st = r;
  }
  return st;
}

/**
 * Apply one action to a selection, or say in plain English why it is not allowed. Never mutates
 * `state`.
 */
export function applySelection(state: Selection, action: SelectionAction): Selection | { error: string } {
  if (state.complete || state.turn == null) return { error: 'Alliance selection is already complete.' };
  const t = state.turn;
  const e = action.entry;
  if (!state.order.includes(e)) return { error: 'That entry is not eligible for the playoffs.' };
  if (state.declined.includes(e)) return { error: 'That entry has already declined an invitation.' };
  const at = state.alliances.findIndex((a) => a.entries.includes(e));
  if (at >= 0) {
    if (state.alliances[at].entries[0] !== e) return { error: 'That entry is already on an alliance.' };
    if (at === t) return { error: action.kind === 'pick' ? 'A captain cannot pick itself.' : 'The captain on turn cannot decline.' };
    if (at < t) return { error: 'That entry is the captain of a higher-seeded alliance.' };
  }

  if (action.kind === 'decline') {
    return finish(state.order, state.allianceCount, state.alliances.map(copy), [...state.declined, e]);
  }

  const alliances = state.alliances.map(copy);
  alliances[t].entries.push(e);
  if (at > t) {
    // the picked captain's alliance dissolves; the ones below move up; the next free entry in the
    // seeding order (declined or not) becomes the last captain
    alliances.splice(at, 1);
    const onOne = new Set(alliances.flatMap((a) => a.entries));
    const next = state.order.find((x) => !onOne.has(x));
    if (next != null) alliances.push({ seed: 0, entries: [next] });
    alliances.forEach((a, i) => (a.seed = i + 1));
  }
  return finish(state.order, state.allianceCount, alliances, state.declined.slice());
}

const copy = (a: PlayoffAlliance): PlayoffAlliance => ({ seed: a.seed, entries: a.entries.slice() });

/** turn, availability and completion, from alliances + declines */
function finish(order: number[], allianceCount: number, alliances: PlayoffAlliance[], declined: number[]): Selection {
  const open = alliances.findIndex((a) => a.entries.length < 2);
  const complete = alliances.length === allianceCount && open < 0;
  const turn = complete || open < 0 ? null : open;
  const available: number[] = [];
  if (turn != null) {
    const partners = new Set(alliances.flatMap((a) => a.entries.slice(1)));
    const higherCaptains = new Set(alliances.slice(0, turn + 1).map((a) => a.entries[0]));
    const dec = new Set(declined);
    for (const e of order) if (!partners.has(e) && !higherCaptains.has(e) && !dec.has(e)) available.push(e);
  }
  const out: Selection = { alliances, turn, available, declined, complete, order, allianceCount };
  if (!complete && available.length === 0) {
    out.stuck =
      order.length < allianceCount * 2
        ? `Needs at least ${allianceCount * 2} entries for ${allianceCount} alliances of two.`
        : 'No entry is left to invite: too many have declined.';
  }
  return out;
}

/**
 * SERPENTINE: alliance i (1-based) is order[i − 1] with order[2N − i] — the best captain gets
 * the worst partner. With one entry per alliance, alliance i is order[i − 1] alone. With too few
 * entries the missing places are simply left out (an alliance without a partner, or fewer
 * alliances).
 */
export function serpentineAlliances(order: number[], allianceCount: number, perAlliance: 1 | 2): PlayoffAlliance[] {
  const out: PlayoffAlliance[] = [];
  const n = Math.max(0, Math.floor(allianceCount));
  for (let i = 1; i <= n && i <= order.length; i++) {
    const entries = [order[i - 1]];
    if (perAlliance === 2 && 2 * n - i < order.length) entries.push(order[2 * n - i]);
    out.push({ seed: i, entries });
  }
  return out;
}
