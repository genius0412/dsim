import type { Vec2, World } from '../../types';
import * as C from '../../config';
import type { GameModule } from '../module';
import { BIOBUZZ_SIM } from './sim';

/**
 * BIOBUZZ as a full (client) `GameModule`.
 *
 * ⚠️ PLACEHOLDER — the P0-shell chat replaces this file. The renderers below are
 * the minimum that makes an empty field legible on screen (mat, tile grid,
 * perimeter) so `/biobuzz` opens on an alpha build and the shared camera can be
 * seen to fit the bounds. `drawRobot` is omitted on purpose: the SHARED
 * `drawRobot` is used, which is right for a game whose mechanisms do not exist
 * yet. No UI slots are filled, so every consumer keeps its existing branch.
 */

const BB_HALF = BIOBUZZ_SIM.colliders.bounds.halfX;

function drawBiobuzzField(ctx: CanvasRenderingContext2D, _world: World, _screenUp?: Vec2): void {
  // mat + tile grid, reusing DECODE's palette so it themes identically on the
  // dark field (the canvas ground does not theme — see CLAUDE.md's category 3)
  ctx.fillStyle = C.COLORS.mat;
  ctx.fillRect(-BB_HALF, -BB_HALF, 2 * BB_HALF, 2 * BB_HALF);
  ctx.strokeStyle = C.COLORS.tile;
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  for (let x = -BB_HALF; x <= BB_HALF + 0.01; x += C.TILE) {
    ctx.moveTo(x, -BB_HALF);
    ctx.lineTo(x, BB_HALF);
  }
  for (let y = -BB_HALF; y <= BB_HALF + 0.01; y += C.TILE) {
    ctx.moveTo(-BB_HALF, y);
    ctx.lineTo(BB_HALF, y);
  }
  ctx.stroke();
  // the perimeter itself — the board is separated from the dark floor by this
  // outline alone, so it is not decoration (CLAUDE.md, theming)
  ctx.strokeStyle = C.COLORS.wall;
  ctx.lineWidth = 1.4;
  ctx.strokeRect(-BB_HALF, -BB_HALF, 2 * BB_HALF, 2 * BB_HALF);
}

/** nothing to draw: the placeholder field has no scoring elements */
function drawBiobuzzBalls(_ctx: CanvasRenderingContext2D, _world: World, _screenUp: Vec2): void {}

export const BIOBUZZ_MODULE: GameModule = {
  ...BIOBUZZ_SIM,
  drawField: drawBiobuzzField,
  drawBalls: drawBiobuzzBalls,
  // no score HUD (nothing is scored), no start editor (no legality model), and
  // the shared sloped intake so the builder has something valid to offer
  ui: { showScoreHud: false, startEditor: false, intakes: ['sloped'] },
};
