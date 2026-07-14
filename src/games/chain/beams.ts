import type { DrivetrainType, RobotSpec, World } from '../../types';
import type { Rect } from '../../sim/field';
import { robotExtents, robotIntersectsRect } from '../../sim/physics';
import { clamp } from '../../math';
import {
  CHAIN_BEAM_HEIGHT,
  CHAIN_BEAM_MIN_CLIMB,
  CHAIN_CLEARANCE_DEFAULT,
  CHAIN_CLEARANCE_MAX,
  CHAIN_CLEARANCE_MIN,
  CHAIN_COG_PENALTY,
} from './config';

/**
 * Chain Reaction BEAMS — four 1"-tall tubes of difficult terrain around the center.
 *
 * Crossing model (bespoke, after the Rapier robot solve):
 *  • A robot can only mount a beam if its `groundClearance ≥ CHAIN_BEAM_HEIGHT` AND
 *    its drivetrain can climb (traction wheels climb; omni/x-drive can't — see
 *    `BUMP_CLIMB`/`CHAIN_BEAM_MIN_CLIMB`). Otherwise the beam blocks it like a wall
 *    (it can still drive ALONGSIDE — only the across-beam motion is stopped).
 *  • If it CAN cross, the beam DRAGS the across-beam velocity: harder for low-traction
 *    wheels, easier with more clearance margin (a taller robot rolls over a bump more
 *    easily). So low clearance / omni wheels barely get across; tank strides over.
 *  • The clearance ↔ CoG tradeoff: more clearance eases beam crossing but raises the
 *    center of gravity ⇒ `cogFactor` scales down ALL drive authority (sluggish, tippy).
 *
 * Positions are APPROXIMATE (a symmetric ring around the particle zone) pending exact
 * manual coordinates.
 */

/** each beam is an axis-aligned tube; `axis` is its NORMAL (the direction you cross). */
export const CHAIN_BEAMS: { rect: Rect; axis: 'x' | 'y' }[] = [
  { rect: { x0: -18, y0: 29, x1: 18, y1: 31 }, axis: 'y' }, // top
  { rect: { x0: -18, y0: -31, x1: 18, y1: -29 }, axis: 'y' }, // bottom
  { rect: { x0: 29, y0: -18, x1: 31, y1: 18 }, axis: 'x' }, // right
  { rect: { x0: -31, y0: -18, x1: -29, y1: 18 }, axis: 'x' }, // left
];

/** how well each drivetrain's wheels climb a bump (0..1). Traction (tank/swerve)
 * climb; roller-based mecanum struggles; x-drive omnis at 45° barely grip an edge. */
const BUMP_CLIMB: Record<DrivetrainType, number> = {
  tank: 1.0,
  swerve: 0.85,
  mecanum: 0.4,
  xdrive: 0.3,
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

/** can this robot get over a beam at all? (clearance meets the height + wheels climb) */
export function canCrossBeams(spec: RobotSpec): boolean {
  return clearanceOf(spec) >= CHAIN_BEAM_HEIGHT && BUMP_CLIMB[spec.drivetrain] >= CHAIN_BEAM_MIN_CLIMB;
}

/**
 * Resolve robots against the beams: block a robot that can't cross (stop its
 * across-beam motion + keep it on its side), or drag one that can. Runs after
 * `solveRobots` in `chainStep`.
 */
export function crossBeams(world: World): void {
  for (const r of world.robots) {
    const climb = BUMP_CLIMB[r.spec.drivetrain];
    const clr = clearanceOf(r.spec);
    const cross = canCrossBeams(r.spec);
    const retain = clamp(0.3 + 0.45 * climb + 0.2 * (clr - CHAIN_BEAM_HEIGHT), 0.3, 0.94);
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
          r.vel.y *= retain;
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
          r.vel.x *= retain;
        }
      }
    }
  }
}
