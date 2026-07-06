import type { Alliance, World } from '../types';
import * as C from '../config';
import { loadSlots } from './field';
import { hyp } from '../math';

/** the human player feeds the grab row one artifact at a time from the box.
 * One-at-a-time placement is what keeps box + in-transit within the 6-out-of-play
 * cap (a 5-ball box can only ever "hold" one more, never two). */
export function updateHumanPlayers(world: World): void {
  for (const a of ['red', 'blue'] as Alliance[]) {
    const hp = world.humanPlayers[a];
    if (hp.box.length === 0 || world.time < hp.nextPlaceAt) continue;
    const slots = loadSlots(a);
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
