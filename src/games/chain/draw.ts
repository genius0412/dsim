import type { Vec2, World } from '../../types';
import * as C from '../../config';
import { CHAIN_CATALYST_OD, CHAIN_PARTICLE_R } from './config';

/**
 * Chain Reaction scoring-elements renderer (drawn after the robots).
 *
 * PARTICLES (white wiffle balls) — ground flat, flight lifted with a shadow;
 * CATALYSTS (purple rings) — on the field, carried, or seated on a hook; and
 * endgame badges over ascended/parked robots.
 */
const PARTICLE_FILL = '#e8eaed';
const PARTICLE_LINE = 'rgba(20,22,26,0.55)';
const CATALYST = '#7c3aed';

export function drawChainBalls(ctx: CanvasRenderingContext2D, world: World, screenUp: Vec2): void {
  // shadows for airborne particles
  for (const b of world.balls) {
    if (b.state.kind !== 'flight') continue;
    const k = Math.max(0.3, 1 - b.z / 100);
    ctx.fillStyle = `rgba(0,0,0,${0.3 * k})`;
    ctx.beginPath();
    ctx.arc(b.pos.x, b.pos.y, CHAIN_PARTICLE_R * 0.9, 0, Math.PI * 2);
    ctx.fill();
  }

  // particles
  ctx.lineWidth = 0.35;
  for (const b of world.balls) {
    const lift = b.state.kind === 'flight' ? b.z * 0.12 : 0;
    const x = b.pos.x + screenUp.x * lift;
    const y = b.pos.y + screenUp.y * lift;
    ctx.fillStyle = PARTICLE_FILL;
    ctx.beginPath();
    ctx.arc(x, y, CHAIN_PARTICLE_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = PARTICLE_LINE;
    ctx.stroke();
  }

  // catalysts (purple rings)
  const rOuter = CHAIN_CATALYST_OD / 2;
  const rInner = rOuter - 1;
  for (const c of world.chain?.catalysts ?? []) {
    ctx.lineWidth = rOuter - rInner + 0.6;
    ctx.strokeStyle = c.hook ? '#a78bfa' : CATALYST; // seated ⇒ lighter
    ctx.beginPath();
    ctx.arc(c.pos.x, c.pos.y, (rOuter + rInner) / 2, 0, Math.PI * 2);
    ctx.stroke();
  }

  // endgame badges over robots (ascended = ring stand, parked = lab)
  const eg = world.chain?.endgame ?? {};
  for (const r of world.robots) {
    const st = eg[r.id];
    if (st !== 'ascended' && st !== 'parked') continue;
    ctx.save();
    ctx.translate(r.pos.x, r.pos.y);
    // undo camera rotation + y-flip so the glyph reads upright
    const ang = Math.atan2(screenUp.x, screenUp.y);
    ctx.rotate(ang);
    ctx.scale(1, -1);
    ctx.fillStyle = st === 'ascended' ? '#f5c518' : C.COLORS.white;
    ctx.font = '700 5px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(st === 'ascended' ? '▲ ASCENDED' : '■ PARKED', 0, -10);
    ctx.restore();
  }
}
