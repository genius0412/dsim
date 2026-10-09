import type { Alliance, ArtifactColor, World } from '../types';
import * as C from '../config';
import { loadSlots, loadZone, inRect, type Rect } from './field';
import { heldSlotPos, robotIntersectsRect } from './physics';
import { hyp, rot } from '../math';

/** The human player works the loading zone. They CONTINUOUSLY grab loose/returned
 * artifacts out of the zone into the off-field box (up to the 6-out-of-play cap),
 * and feed the grab row from the box one artifact at a time — one-at-a-time keeps
 * box + in-transit within the 6-out-of-play cap. A robot with NO intake gets its
 * artifacts by hand instead (`handLoad`). */
export function updateHumanPlayers(world: World): void {
  // the human player does nothing until teleop (idle through pre / auto /
  // transition); free-drive practice counts as always-teleop.
  const phase = world.match.phase;
  if (phase !== 'teleop' && phase !== 'freeplay') return;
  for (const a of ['red', 'blue'] as Alliance[]) {
    const hp = world.humanPlayers[a];
    const slots = loadSlots(a);
    const zone = loadZone(a);
    // one action a tick: a hand-off is that tick's action
    if (handLoad(world, a, zone)) continue;
    // a robot's intake mouth can reach several inches ahead of its center, so an
    // approaching robot is already contesting balls near the zone before its own
    // position crosses the boundary — pad the zone by a generous reach margin
    const approachZone = { x0: zone.x0 - 20, x1: zone.x1 + 20, y0: zone.y0 - 20, y1: zone.y1 + 20 };

    // COLLECT: continuously pull a loose ground ball out of the loading zone into
    // the off-field box (the returned/overflow artifacts the HP recycles). Skip a
    // ball staged at a grab slot. Also stand down entirely while a robot is
    // working (or approaching) the zone — the per-ball "is a robot on it right
    // now" check used to be the only guard, so the HP would race a robot for a
    // ball it was still approaching (not yet within that ball's own tiny radius)
    // and usually win, vacuuming it into the box before the robot's own intake
    // ever got a shot — the balls a driver saw "sucked up" without landing in
    // the hopper.
    const robotInZone = world.robots.some((r) => inRect(r.pos, approachZone));
    if (hp.box.length < 6 && !robotInZone) {
      for (let i = world.balls.length - 1; i >= 0; i--) {
        const b = world.balls[i];
        if (b.state.kind !== 'ground' || !inRect(b.pos, zone)) continue;
        const atSlot = slots.some((s) => hyp(b.pos.x - s.x, b.pos.y - s.y) < C.BALL_RADIUS * 1.5);
        if (atSlot) continue;
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

/**
 * HAND LOADING (manual G432: "DRIVE TEAM members may load SCORING ELEMENTS into a ROBOT that is
 * partially or fully in the LOADING ZONE"). A robot of this alliance with NO intake (`noIntake`),
 * any part of it in the zone, nearly still, with hopper room, is handed one artifact per
 * `HP_HAND_LOAD_S`: from the box first, else off the zone's own floor. It goes straight into the
 * next storage slot (`heldSlotPos`) — a person reaching over and dropping it in, not a roll across
 * the field. Every other robot is untouched, so a world without a no-intake robot steps exactly as
 * before. Returns whether it loaded one (the human player's one action this tick).
 */
function handLoad(world: World, a: Alliance, zone: Rect): boolean {
  const hp = world.humanPlayers[a];
  if (world.time < hp.nextPlaceAt) return false;
  for (const r of world.robots) {
    if (r.alliance !== a || r.passive || !C.noIntake(r.spec)) continue;
    if (r.hopper.length >= C.HOPPER_CAPACITY) continue;
    if (hyp(r.vel.x, r.vel.y) > C.HP_HAND_LOAD_MAX_SPEED || Math.abs(r.angVel) > C.HP_HAND_LOAD_MAX_TURN) continue;
    if (!robotIntersectsRect(r, zone)) continue;
    let color: ArtifactColor;
    const floor = hp.box.length > 0 ? -1 : world.balls.findIndex((b) => b.state.kind === 'ground' && inRect(b.pos, zone));
    if (hp.box.length > 0) color = hp.box.shift()!;
    else if (floor >= 0) color = world.balls[floor].color;
    else return false; // nothing in hand and nothing on the zone's floor
    const slot = r.hopper.length;
    const at = heldSlotPos(r.spec, slot, 0);
    const w = rot(at, r.heading);
    const state = { kind: 'held' as const, robot: r.id, slot, lx: at.x, ly: at.y, side: 0 };
    const pos = { x: r.pos.x + w.x, y: r.pos.y + w.y };
    if (floor >= 0) {
      const b = world.balls[floor];
      b.state = state;
      b.pos = pos;
      b.vel = { x: 0, y: 0 };
      b.z = 0;
      b.vz = 0;
    } else {
      world.balls.push({
        id: world.balls.reduce((m, b) => Math.max(m, b.id), 0) + 1,
        color,
        state,
        pos,
        vel: { x: 0, y: 0 },
        z: 0,
        vz: 0,
      });
    }
    r.hopper.push(color);
    hp.nextPlaceAt = world.time + C.HP_HAND_LOAD_S;
    return true;
  }
  return false;
}
