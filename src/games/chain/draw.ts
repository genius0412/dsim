import type { Alliance, Vec2, World } from '../../types';
import * as C from '../../config';
import { CHAIN_CATALYST_OD, CHAIN_PARTICLE_R } from './config';
import { hookPos } from './state';

/**
 * Chain Reaction scoring-elements renderer (drawn after the robots).
 *
 * PARTICLES (white wiffle balls) — ground flat, flight lifted with a shadow;
 * CATALYSTS (purple rings) — on the field, carried, or seated on a hook; a clear
 * per-accelerator COUNT so it's unambiguous how many rings are on the hooks (the two
 * hooks read as one top-down); and endgame badges over ascended/parked robots.
 */
const PARTICLE_FILL = '#e8eaed';
const PARTICLE_LINE = 'rgba(20,22,26,0.55)';
const CATALYST = '#7c3aed';
const CATALYST_SEATED = '#c4b5fd';

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

  const rOuter = CHAIN_CATALYST_OD / 2;
  const rMid = rOuter - 0.9;
  const up = Math.atan2(screenUp.x, screenUp.y);

  // HOOK SLOTS — draw EACH hook (2 per alliance) individually so it's clear how many
  // hooks there are and WHICH are occupied (the physical hooks read as one top-down,
  // so we render explicit slots): empty = hollow dim ring, occupied = filled bright
  // ring + a small index tag (1/2). Seated catalysts render here (at their hook).
  for (const a of ['red', 'blue'] as Alliance[]) {
    for (let i = 0; i < 2; i++) {
      const h = hookPos(a, i);
      const occupied = (world.chain?.catalysts ?? []).some(
        (c) => c.hook?.alliance === a && c.hook.index === i,
      );
      if (occupied) {
        ctx.fillStyle = CATALYST_SEATED; // filled donut = ring on this hook
        ctx.beginPath();
        ctx.arc(h.x, h.y, rOuter, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = C.COLORS.mat;
        ctx.beginPath();
        ctx.arc(h.x, h.y, rOuter - 1.6, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.lineWidth = 0.8; // hollow dim outline = empty hook slot
        ctx.strokeStyle = 'rgba(196,181,253,0.5)';
        ctx.beginPath();
        ctx.arc(h.x, h.y, rMid, 0, Math.PI * 2);
        ctx.stroke();
      }
      // slot index tag (upright) so two nearby hooks are never mistaken for one
      ctx.save();
      ctx.translate(h.x, h.y);
      ctx.rotate(up);
      ctx.scale(1, -1);
      ctx.fillStyle = occupied ? '#ffffff' : 'rgba(196,181,253,0.7)';
      ctx.font = '700 3px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), 0, 0);
      ctx.restore();
    }
  }

  // free / carried catalysts (not yet seated) render at their world position
  for (const c of world.chain?.catalysts ?? []) {
    if (c.hook) continue;
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = CATALYST;
    ctx.beginPath();
    ctx.arc(c.pos.x, c.pos.y, rMid, 0, Math.PI * 2);
    ctx.stroke();
  }

  // endgame badges over robots (ascended = ring stand, parked = lab)
  const eg = world.chain?.endgame ?? {};
  for (const r of world.robots) {
    const st = eg[r.id];
    if (st !== 'ascended' && st !== 'parked') continue;
    ctx.save();
    ctx.translate(r.pos.x, r.pos.y);
    ctx.rotate(up);
    ctx.scale(1, -1);
    ctx.fillStyle = st === 'ascended' ? '#f5c518' : C.COLORS.white;
    ctx.font = '700 5px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(st === 'ascended' ? '▲ ASCENDED' : '■ PARKED', 0, -10);
    ctx.restore();
  }
}
