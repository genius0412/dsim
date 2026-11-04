/**
 * STAND-IN FOR `@horizon36596/zenith-season-biobuzz` when it is not installed
 * (`./unavailable.ts`). Its field file is `./field/biobuzz.field.json`: an empty 144 in field,
 * because `src/games/biobuzz/auto` reads it at import time to build DSIM's own copy.
 */
import type { Field } from './schema';
import type { SeasonRules } from './core';
import { zenithUnavailable } from './unavailable';

export function loadSeason(_field: Field): SeasonRules {
  throw zenithUnavailable('loadSeason');
}
