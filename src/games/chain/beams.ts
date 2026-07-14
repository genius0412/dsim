import type { DrivetrainType, RobotSpec, World } from '../../types';
import type { Rect } from '../../sim/field';
import { robotExtents, robotIntersectsRect } from '../../sim/physics';
import { clamp } from '../../math';
import {
  CHAIN_BEAM_HEIGHT,
  CHAIN_BEAM_MOMENTUM_REF,
  CHAIN_CLEARANCE_DEFAULT,
  CHAIN_CLEARANCE_MAX,
  CHAIN_CLEARANCE_MIN,
  CHAIN_COG_PENALTY,
  CHAIN_DIAMOND_R,
  CHAIN_HALF_X,
  CHAIN_HALF_Y,
} from './config';

/**
 * Chain Reaction BEAMS — four 1"-tall tubes of difficult terrain around the center.
 *
 * Crossing model (bespoke, after the Rapier robot solve):
 *  • The ONLY hard gate is CLEARANCE: `groundClearance ≥ CHAIN_BEAM_HEIGHT`. If the
 *    frame can't clear the beam it's blocked like a wall (it can still drive
 *    ALONGSIDE — only the across-beam motion stops). Given clearance, EVERY drivetrain
 *    can cross — nothing is hard-blocked by wheel type.
 *  • Given clearance, the beam DRAGS the across-beam velocity by a `beamRetain` factor.
 *    MOMENTUM dominates: a running start (high across-speed) powers over with almost no
 *    slowdown; creeping from a standstill is where traction matters — traction wheels
 *    (tank/swerve) still climb, mecanum is only a bit worse, omni/x-drive is the slowest
 *    but still gets over. More clearance margin also eases it slightly.
 *  • The clearance ↔ CoG tradeoff: more clearance eases beam crossing but raises the
 *    center of gravity ⇒ `cogFactor` scales down ALL drive authority (sluggish, tippy).
 *
 * The beams form the +x/−x/+y/−y AXES: each runs from a field wall inward to the
 * central particle-zone diamond tape (so the middle diamond stays open). `axis` is a
 * beam's NORMAL (the direction you cross it).
 */
const BEAM_HALF_W = 1; // top-down half-width of a beam bar (the 1" is its HEIGHT/z)
const R = CHAIN_DIAMOND_R; // beams end at the diamond tape

export const CHAIN_BEAMS: { rect: Rect; axis: 'x' | 'y' }[] = [
  { rect: { x0: R, y0: -BEAM_HALF_W, x1: CHAIN_HALF_X, y1: BEAM_HALF_W }, axis: 'y' }, // +x axis
  { rect: { x0: -CHAIN_HALF_X, y0: -BEAM_HALF_W, x1: -R, y1: BEAM_HALF_W }, axis: 'y' }, // −x axis
  { rect: { x0: -BEAM_HALF_W, y0: R, x1: BEAM_HALF_W, y1: CHAIN_HALF_Y }, axis: 'x' }, // +y axis
  { rect: { x0: -BEAM_HALF_W, y0: -CHAIN_HALF_Y, x1: BEAM_HALF_W, y1: -R }, axis: 'x' }, // −y axis
];

/** standstill "grip" of each drivetrain climbing a bump (0..1) — how much across-speed
 * it keeps per tick with NO momentum. Traction (tank/swerve) climb best; mecanum only a
 * little worse; omni/x-drive is the slowest (relies most on momentum) but still crosses. */
const TRACTION: Record<DrivetrainType, number> = {
  tank: 0.9,
  swerve: 0.86,
  mecanum: 0.78,
  xdrive: 0.66,
};

export function clearanceOf(spec: RobotSpec): number {
  return clamp(spec.groundClearance ?? CHAIN_CLEARANCE_DEFAULT, CHAIN_CLEARANCE_MIN, CHAIN_CLEARANCE_MAX);
}

/** drive-authority factor (≤1) from the raised center of gravity: more clearance ⇒
 * more sluggish. Applied to the drive command in chainStep. */
export function cogFactor(spec: RobotSpec): number {
  const frac = (clearanceOf(spec) - CHAIN_CLEARANCE_MIN) / (CHAIN_CLEARANCE_MAX - CHAIN_CLEARANCE_MIN);
  return 1 - CHAIN_COG_PENALTY * clamp(frac, 0, 1);
}

/** does the robot's frame clear a beam at all? (the only hard gate — clearance). */
export function canCrossBeams(spec: RobotSpec): boolean {
  return clearanceOf(spec) >= CHAIN_BEAM_HEIGHT;
}

/** fraction of the across-beam velocity KEPT per tick while on a beam. Grows toward ~1
 * with MOMENTUM (approach speed) — a running start powers over; from a standstill it
 * falls back to the drivetrain's traction (+ a small clearance-margin bonus). */
export function beamRetain(spec: RobotSpec, acrossSpeed: number): number {
  const clr = clearanceOf(spec);
  const base = clamp(TRACTION[spec.drivetrain] + 0.05 * (clr - CHAIN_BEAM_HEIGHT), 0.5, 0.9);
  const mom = clamp(Math.abs(acrossSpeed) / CHAIN_BEAM_MOMENTUM_REF, 0, 1);
  return clamp(base + (1 - base) * mom, 0.5, 0.985);
}

/**
 * Resolve robots against the beams: block a robot whose frame can't clear a beam (stop
 * its across-beam motion + keep it on its side); otherwise DRAG the across velocity by a
 * momentum-aware `beamRetain`. Runs after `solveRobots` in `chainStep`.
 */
export function crossBeams(world: World): void {
  for (const r of world.robots) {
    const cross = canCrossBeams(r.spec);
    const e = robotExtents(r);
    const rad = Math.max(e.half, (e.front + e.rear) / 2) + 0.5;
    for (const beam of CHAIN_BEAMS) {
      if (!robotIntersectsRect(r, beam.rect)) continue;
      if (beam.axis === 'y') {
        const bc = (beam.rect.y0 + beam.rect.y1) / 2;
        const bh = (beam.rect.y1 - beam.rect.y0) / 2;
        const side = r.pos.y >= bc ? 1 : -1;
        if (!cross) {
          const limit = bc + side * (bh + rad);
          r.pos.y = side > 0 ? Math.max(r.pos.y, limit) : Math.min(r.pos.y, limit);
          if (side * r.vel.y < 0) r.vel.y = 0; // moving into the beam → stop
        } else {
          r.vel.y *= beamRetain(r.spec, r.vel.y);
        }
      } else {
        const bc = (beam.rect.x0 + beam.rect.x1) / 2;
        const bw = (beam.rect.x1 - beam.rect.x0) / 2;
        const side = r.pos.x >= bc ? 1 : -1;
        if (!cross) {
          const limit = bc + side * (bw + rad);
          r.pos.x = side > 0 ? Math.max(r.pos.x, limit) : Math.min(r.pos.x, limit);
          if (side * r.vel.x < 0) r.vel.x = 0;
        } else {
          r.vel.x *= beamRetain(r.spec, r.vel.x);
        }
      }
    }
  }
}
