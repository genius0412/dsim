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
export const BEAM_HALF_W = 0.5; // top-down half-width — a 1"-diameter tube reads as a 1"-wide bar
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

/**
 * Fraction of the across-beam velocity KEPT while mounting a beam. MOMENTUM dominates:
 * a running start (high across-speed) powers over with almost no slowdown; creeping is
 * where traction matters (traction wheels still climb, mecanum a bit worse, omni slowest
 * yet still crosses). A raised center of gravity (more clearance) makes it a touch harder.
 * Applied to velocity BEFORE the physics integration, so it really slows the crossing.
 */
export function beamDragFactor(spec: RobotSpec, acrossSpeed: number): number {
  const clr = clearanceOf(spec);
  const base = clamp(TRACTION[spec.drivetrain] + 0.05 * (clr - CHAIN_BEAM_HEIGHT), 0.45, 0.9);
  const mom = clamp(Math.abs(acrossSpeed) / CHAIN_BEAM_MOMENTUM_REF, 0, 1);
  const cogFrac = clamp((clr - CHAIN_CLEARANCE_MIN) / (CHAIN_CLEARANCE_MAX - CHAIN_CLEARANCE_MIN), 0, 1);
  return clamp((base + (1 - base) * mom) * (1 - 0.12 * cogFrac), 0.4, 0.985);
}

/**
 * PRE-solve: for a robot on a beam it CAN cross, drag its across-beam velocity so it
 * physically advances less this tick (momentum/traction/CoG decide how much). Applied
 * before the Rapier integration so the slowdown persists (the drivetrain model re-sets
 * velocity every tick, so a post-solve velocity change would be wiped).
 */
export function beamDrag(world: World): void {
  for (const r of world.robots) {
    if (!canCrossBeams(r.spec)) continue; // no-clearance robots are hard-blocked instead
    for (const beam of CHAIN_BEAMS) {
      if (!robotIntersectsRect(r, beam.rect)) continue;
      if (beam.axis === 'y') r.vel.y *= beamDragFactor(r.spec, r.vel.y);
      else r.vel.x *= beamDragFactor(r.spec, r.vel.x);
    }
  }
}

/**
 * POST-solve: a robot whose frame can't clear a beam is blocked like a wall — keep it on
 * the side it's on and stop its across-beam motion (it can still drive ALONGSIDE).
 */
export function beamBlock(world: World): void {
  for (const r of world.robots) {
    if (canCrossBeams(r.spec)) continue;
    const e = robotExtents(r);
    const rad = Math.max(e.half, (e.front + e.rear) / 2) + 0.5;
    for (const beam of CHAIN_BEAMS) {
      if (!robotIntersectsRect(r, beam.rect)) continue;
      if (beam.axis === 'y') {
        const bc = (beam.rect.y0 + beam.rect.y1) / 2;
        const bh = (beam.rect.y1 - beam.rect.y0) / 2;
        const side = r.pos.y >= bc ? 1 : -1;
        const limit = bc + side * (bh + rad);
        r.pos.y = side > 0 ? Math.max(r.pos.y, limit) : Math.min(r.pos.y, limit);
        if (side * r.vel.y < 0) r.vel.y = 0;
      } else {
        const bc = (beam.rect.x0 + beam.rect.x1) / 2;
        const bw = (beam.rect.x1 - beam.rect.x0) / 2;
        const side = r.pos.x >= bc ? 1 : -1;
        const limit = bc + side * (bw + rad);
        r.pos.x = side > 0 ? Math.max(r.pos.x, limit) : Math.min(r.pos.x, limit);
        if (side * r.vel.x < 0) r.vel.x = 0;
      }
    }
  }
}
