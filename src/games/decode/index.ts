import { drawField } from '../../render/drawField';
import { drawRampStrips } from '../../render/drawGoals';
import type { GameModule } from '../module';
import { DECODE_SIM } from './sim';

/**
 * DECODE as a full (client) `GameModule` — the DOM-free `DECODE_SIM` plus the
 * existing canvas renderers. Nothing here reimplements DECODE.
 */
export const DECODE_MODULE: GameModule = {
  ...DECODE_SIM,
  drawField,
  drawOverlays: drawRampStrips,
  ui: { showScoreHud: true, startEditor: true, intakes: ['sloped', 'vector', 'triangle'] },
};
