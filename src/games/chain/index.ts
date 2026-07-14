import type { GameModule } from '../module';
import { CHAIN_SIM } from './sim';
import { drawChainField } from './drawField';

/**
 * Chain Reaction as a full (client) `GameModule` — the DOM-free `CHAIN_SIM` plus
 * the plain-field renderer + a minimal builder/HUD spec (no score bar, no start
 * editor). Real geometry/intakes/rules land in this `src/games/chain/` tree later.
 */
export const CHAIN_MODULE: GameModule = {
  ...CHAIN_SIM,
  drawField: drawChainField,
  ui: { showScoreHud: false, startEditor: false, intakes: ['sloped'] },
};
