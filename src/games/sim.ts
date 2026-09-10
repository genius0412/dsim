import type { GameId, GameSimModule } from './types';
import { DECODE_SIM } from './decode/sim';
import { CHAIN_SIM } from './chain/sim';
import { BIOBUZZ_SIM } from './biobuzz/sim';

/**
 * The SERVER-SAFE (DOM-free) game registry: simulation modules only
 * (createWorld/step/colliders/bounds/scored/startLegality). The authoritative
 * server + headless smoke import THIS so they never pull the browser renderers.
 * The client's full registry is `./index.ts`.
 *
 * Typed PARTIAL: an unbuilt game is absent, and both resolvers fall back to
 * DECODE — the single back-compat rule (old worlds carry no `game`). `'decode'`
 * must always be present.
 */
export const SIM_GAMES: Partial<Record<GameId, GameSimModule>> = {
  // ⚠️ GETTERS, NOT VALUES — and that is load-bearing, not style.
  //
  // There is a real import CYCLE through this file: `src/sim/spawn.ts` imports
  // `simModuleFor` (a start index is clamped to the active game's
  // `startPoseCount`), and every game module imports `spawn` for `coerceSpec` /
  // `createWorld`. A cycle is safe only when nothing is READ at module-eval time
  // (CLAUDE.md, Gotchas), and an object literal holding `decode: DECODE_SIM` is
  // exactly such a read — so whether this module worked depended on which file
  // the process happened to load FIRST. Enter through `spawn` and it resolved;
  // enter through a game module (which is what `scripts/smoke-biobuzz` does) and
  // this file's body ran while `decode/sim.ts` was still mid-evaluation, throwing
  // `Cannot access 'DECODE_SIM' before initialization`.
  //
  // A getter defers the read to the first LOOKUP, by which time every module has
  // finished. Keep it this way, and keep any new game the same.
  get decode() {
    return DECODE_SIM;
  },
  get chain() {
    return CHAIN_SIM;
  },
  get biobuzz() {
    return BIOBUZZ_SIM;
  },
};

/** the sim module for a game id, defaulting to DECODE (undefined / unknown / old). */
export function simModuleFor(id: GameId | undefined | null): GameSimModule {
  return (id && SIM_GAMES[id]) || DECODE_SIM;
}

/** the sim module a world belongs to (its `game`, defaulting to DECODE). */
export function simGameOf(world: { game?: GameId } | null | undefined): GameSimModule {
  return simModuleFor(world?.game);
}
