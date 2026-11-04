import type { RobotSpec } from '../types';

/**
 * REMOVING A SAVED ROBOT (owner, 2026-11-04: what the builder's list says and what Play shows
 * disagreed after a delete). DOM-free, so `npm test` holds the rule.
 *
 * `saved` without slot `i`, and, when slot `i` was the robot being driven, the robot to drive
 * instead: the next saved robot (the one that took its place, else the last), else `fallback`, the
 * default preset's build. Driving on with the deleted build used to leave it in Play's strip as a
 * card of its own; an "Unsaved" card is meant for a build the player made and never saved, not for
 * one they just deleted.
 */
export interface SavedRemoval {
  saved: RobotSpec[];
  /** the robot to drive now, or null when the one being driven is not the removed one */
  select: RobotSpec | null;
  /** `select`'s slot in `saved`, or -1 when it is the fallback (or there is no selection) */
  selectedIndex: number;
}

export function removeSavedRobot(saved: readonly RobotSpec[], i: number, wasOn: boolean, fallback: RobotSpec | null): SavedRemoval {
  if (i < 0 || i >= saved.length) return { saved: [...saved], select: null, selectedIndex: -1 };
  const rest = saved.filter((_, j) => j !== i);
  if (!wasOn) return { saved: rest, select: null, selectedIndex: -1 };
  if (!rest.length) return { saved: rest, select: fallback, selectedIndex: -1 };
  const at = Math.min(i, rest.length - 1);
  return { saved: rest, select: rest[at], selectedIndex: at };
}
