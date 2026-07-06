import type { Alliance, World } from '../types';
import * as C from '../config';
import { loadSlots, loadZone, inRect } from './field';
import { hyp } from '../math';

/** The human player works the loading zone. They CONTINUOUSLY grab loose/returned
 * artifacts out of the zone into the off-field box (up to the 6-out-of-play cap),
 * and feed the grab row from the box one artifact at a time — one-at-a-time keeps
 * box + in-transit within the 6-out-of-play cap. */
export function updateHumanPlayers(world: World): void {
  // the human player does nothing until teleop (idle through pre / auto /
  // transition); free-drive practice counts as always-teleop.
  const phase = world.match.phase;
  if (phase !== 'teleop' && phase !== 'freeplay') return;
  for (const a of ['red', 'blue'] as Alliance[]) {
    const hp = world.humanPlayers[a];
    const slots = loadSlots(a);

    // COLLECT: continuously pull a loose ground ball out of the loading zone into
    // the off-field box (the returned/overflow artifacts the HP recycles). Skip a
    // ball staged at a grab slot and any a robot is currently on.
    if (hp.box.length < 6) {
      for (let i = world.balls.length - 1; i >= 0; i--) {
        const b = world.balls[i];
        if (b.state.kind !== 'ground' || !inRect(b.pos, loadZone(a))) continue;
        const atSlot = slots.some((s) => hyp(b.pos.x - s.x, b.pos.y - s.y) < C.BALL_RADIUS * 1.5);
        const robotNear = world.robots.some((r) => hyp(r.pos.x - b.pos.x, r.pos.y - b.pos.y) < 14);
        if (atSlot || robotNear) continue;
        world.balls.splice(i, 1);
        hp.box.push(b.color);
        break; // one grab per tick — continuous but not instantaneous
      }
    }

    // STAGE: feed the grab row from the box one artifact at a time (the pre-staged
    // set is at the front, so the grab row fills PGP first once teleop begins).
    if (hp.box.length === 0 || world.time < hp.nextPlaceAt) continue;
    for (const slot of slots) {
      const occupied = world.balls.some(
        (b) =>
          (b.state.kind === 'ground' || b.state.kind === 'flight') &&
          hyp(b.pos.x - slot.x, b.pos.y - slot.y) < C.BALL_RADIUS * 2.2,
      );
      const robotNear = world.robots.some(
        (r) => hyp(r.pos.x - slot.x, r.pos.y - slot.y) < 16,
      );
      if (!occupied && !robotNear) {
        const color = hp.box.shift()!;
        world.balls.push({
          id: world.balls.reduce((m, b) => Math.max(m, b.id), 0) + 1,
          color,
          state: { kind: 'ground' },
          pos: { x: slot.x, y: slot.y },
          vel: { x: 0, y: 0 },
          z: 0,
          vz: 0,
        });
        hp.nextPlaceAt = world.time + C.HP_PLACE_DELAY;
        break;
      }
    }
  }
}
