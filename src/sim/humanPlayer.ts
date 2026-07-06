import type { Alliance, World } from '../types';
import * as C from '../config';
import { loadSlots } from './field';
import { hyp } from '../math';

/** the human player restocks the loading zone from the alliance-area stock */
export function updateHumanPlayers(world: World): void {
  for (const a of ['red', 'blue'] as Alliance[]) {
    const hp = world.humanPlayers[a];
    if (hp.stock.length === 0 || world.time < hp.nextPlaceAt) continue;
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
        const color = hp.stock.shift()!;
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
