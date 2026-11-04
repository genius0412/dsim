/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * STAND-IN FOR `@horizon36596/zenith-schema` when it is not installed (`./unavailable.ts`).
 * Loose types on purpose, as in `./core.ts`.
 */
import { zenithUnavailable } from './unavailable';

export type Auto = any;
export type Field = any;
export interface Pose {
  xIn: number;
  yIn: number;
  headingRad?: number;
}
export type PoseSource = any;
export type Robot = any;
export type Segment = any;
export type Step = any;
export type Waypoints = any;

/**
 * No format is newer than these, so DSIM's own "saved by a newer Zenith" line never fires on the
 * stand-in and the one that does is `ZENITH_AVAILABLE`'s.
 */
export const FORMAT_VERSIONS: Readonly<Record<'auto' | 'waypoints' | 'robot' | 'field' | 'link', number>> = {
  auto: Number.POSITIVE_INFINITY,
  waypoints: Number.POSITIVE_INFINITY,
  robot: Number.POSITIVE_INFINITY,
  field: Number.POSITIVE_INFINITY,
  link: Number.POSITIVE_INFINITY,
};

export function childLists(_step: any): any[][] {
  throw zenithUnavailable('childLists');
}
export function withChildLists(_step: any, _lists: any[][]): any {
  throw zenithUnavailable('withChildLists');
}

/** parses nothing: `safeParse` answers unavailable, `parse` throws */
export const robotSchema = {
  parse(_value: unknown): any {
    throw zenithUnavailable('robotSchema.parse');
  },
  safeParse(_value: unknown): { success: false; error: Error } {
    return { success: false, error: zenithUnavailable('robotSchema.safeParse') };
  },
};
