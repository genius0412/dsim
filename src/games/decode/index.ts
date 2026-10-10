import { drawField } from '../../render/drawField';
import { drawBalls } from '../../render/drawBalls';
import { drawRampStrips } from '../../render/drawGoals';
import type { GameModule } from '../module';
import { DECODE_SIM } from './sim';
import { DECODE_TUTORIAL } from './tutorial';

/**
 * DECODE as a full (client) `GameModule` — the DOM-free `DECODE_SIM` plus the
 * existing canvas renderers. Nothing here reimplements DECODE.
 */
export const DECODE_MODULE: GameModule = {
  ...DECODE_SIM,
  drawField,
  drawOverlays: drawRampStrips,
  drawBalls,
  ui: { showScoreHud: true, startEditor: true, intakes: ['sloped', 'vector', 'triangle', 'none'] },
  // the four-step tutorial (roadmap item 6) — content only; see `./tutorial.ts`.
  tutorial: DECODE_TUTORIAL,
};
