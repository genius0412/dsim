import type { GameModule } from '../module';
import { CHAIN_SIM } from './sim';
import { drawChainField } from './drawField';
import { drawChainBalls } from './draw';
import { drawChainRobot } from './drawRobot';

/**
 * Chain Reaction as a full (client) `GameModule` — the DOM-free `CHAIN_SIM` plus
 * the field + particle/catalyst renderers and its builder/HUD spec. `showScoreHud`
 * true (CR is scored now); no start editor yet (no G304 model).
 */
export const CHAIN_MODULE: GameModule = {
  ...CHAIN_SIM,
  drawField: drawChainField,
  drawRobot: drawChainRobot,
  drawBalls: drawChainBalls,
  ui: { showScoreHud: true, startEditor: false, intakes: ['sloped'] },
};
