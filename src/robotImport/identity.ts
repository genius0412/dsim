import type { RobotSpec } from '../types';

/**
 * WHO A ROBOT IS: the three fields a player types, with the limits every other door into a spec
 * already applies (`coerceSpec`: a name is 1-24 characters, a team name up to 48, a team number a
 * whole 0-99999). The "Edit details" dialog on a robot card, the device library's write and the
 * saved-robot list all read this one definition, so a card edit cannot store what the builder's
 * own fields, the importer's Review step or the server would not.
 *
 * A leaf (types only): the library, the dialog and the Play page each import it, and none of them
 * may pull the importer's editor in.
 */
export interface RobotIdentity {
  name: string;
  teamName: string;
  teamNumber: number;
}

export const ROBOT_NAME_MAX = 24;
export const TEAM_NAME_MAX = 48;
export const TEAM_NUMBER_MAX = 99999;

/** the identity a spec carries now */
export const identityOf = (s: Pick<RobotSpec, 'name' | 'teamName' | 'teamNumber'>): RobotIdentity => ({
  name: s.name,
  teamName: s.teamName,
  teamNumber: s.teamNumber,
});

/** a whole team number from whatever was typed: digits only, clamped, 0 when there is none */
export function teamNumberFrom(raw: string | number): number {
  const n = typeof raw === 'number' ? raw : Number(raw.replace(/\D/g, ''));
  return Number.isFinite(n) ? Math.max(0, Math.min(TEAM_NUMBER_MAX, Math.round(n))) : 0;
}

/**
 * `p` as it may be stored, or null when it may not: a name must have a letter left after trimming
 * (an empty one is what `coerceSpec` throws away, which would leave the old name under a card that
 * said it was renamed). Only the fields given come back, so a rename leaves the team alone.
 */
export function cleanIdentity(p: Partial<RobotIdentity>): Partial<RobotIdentity> | null {
  const out: Partial<RobotIdentity> = {};
  if (p.name !== undefined) {
    const name = p.name.trim().slice(0, ROBOT_NAME_MAX);
    if (!name) return null;
    out.name = name;
  }
  if (p.teamName !== undefined) out.teamName = p.teamName.trim().slice(0, TEAM_NAME_MAX);
  if (p.teamNumber !== undefined) out.teamNumber = teamNumberFrom(p.teamNumber);
  return out;
}

/** `list` with robot `i`'s identity replaced (the list itself when `p` is not storable or `i` is not in it) */
export function withIdentityAt(list: readonly RobotSpec[], i: number, p: Partial<RobotIdentity>): RobotSpec[] {
  const id = cleanIdentity(p);
  if (!id || i < 0 || i >= list.length) return [...list];
  return list.map((r, j) => (j === i ? { ...r, ...id } : r));
}
