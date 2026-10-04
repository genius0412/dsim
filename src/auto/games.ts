/**
 * WHICH GAMES PLAY ZENITH AUTOS, and each one's adapter. LAZY CHUNK. The main chunk asks
 * `GameSimModule.zenithAutos` instead, so this map is only reached once an auto is in play;
 * `npm test` holds the two to the same answer for every game.
 *
 * Only BIOBUZZ: Zenith has no field for DECODE or Chain Reaction. DECODE's own `.pp` path
 * (`src/sim/pathTraversal.ts`) is untouched.
 */
import { BIOBUZZ_AUTO } from '../games/biobuzz/auto';
import type { GameId } from '../games/types';
import type { GameAutoAdapter } from './types';

const ADAPTERS: Partial<Record<GameId, GameAutoAdapter>> = {
  biobuzz: BIOBUZZ_AUTO,
};

export function autoAdapterFor(game: GameId | undefined): GameAutoAdapter | null {
  return (game && ADAPTERS[game]) || null;
}
