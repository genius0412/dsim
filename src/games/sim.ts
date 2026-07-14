import type { GameId, GameSimModule } from './types';
import { DECODE_SIM } from './decode/sim';
import { CHAIN_SIM } from './chain/sim';

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
  decode: DECODE_SIM,
  chain: CHAIN_SIM,
};

/** the sim module for a game id, defaulting to DECODE (undefined / unknown / old). */
export function simModuleFor(id: GameId | undefined | null): GameSimModule {
  return (id && SIM_GAMES[id]) || DECODE_SIM;
}

/** the sim module a world belongs to (its `game`, defaulting to DECODE). */
export function simGameOf(world: { game?: GameId } | null | undefined): GameSimModule {
  return simModuleFor(world?.game);
}
