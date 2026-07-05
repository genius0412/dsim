import type { Alliance, GoalState, ScoreBreakdown, World } from '../types';
import * as C from '../config';
import { baseZone, inDepot, inRect, launchSegments } from './field';
import { robotCorners, wheelContacts } from './physics';
import { distToSegment } from '../math';

export function emptyScore(): ScoreBreakdown {
  return {
    leave: 0,
    autoClassified: 0,
    autoOverflow: 0,
    autoPattern: 0,
    teleClassified: 0,
    teleOverflow: 0,
    telePattern: 0,
    depot: 0,
    base: 0,
    total: 0,
  };
}

function recomputeTotal(s: ScoreBreakdown): void {
  s.total =
    s.leave +
    s.autoClassified +
    s.autoOverflow +
    s.autoPattern +
    s.teleClassified +
    s.teleOverflow +
    s.telePattern +
    s.depot +
    s.base;
}

export function addClassified(world: World, alliance: Alliance): void {
  const s = world.match.scores[alliance];
  if (world.match.phase === 'auto') s.autoClassified += C.PTS_CLASSIFIED;
  else s.teleClassified += C.PTS_CLASSIFIED;
  recomputeTotal(s);
}

export function addOverflow(world: World, alliance: Alliance): void {
  const s = world.match.scores[alliance];
  if (world.match.phase === 'auto') s.autoOverflow += C.PTS_OVERFLOW;
  else s.teleOverflow += C.PTS_OVERFLOW;
  recomputeTotal(s);
}

/** pattern points for the current classifier stack: the motif repeats 3x over
 * the 9 positions (gate outward); each retained artifact matching scores. */
export function patternPoints(world: World, goal: GoalState): number {
  const stack = world.balls
    .filter(
      (b) =>
        b.state.kind === 'rail' &&
        b.state.goal === goal.alliance &&
        !b.state.overflow &&
        !b.state.pending, // still descending — not settled into a slot yet
    )
    .sort((p, q) => (p.state as { s: number }).s - (q.state as { s: number }).s);
  let pts = 0;
  stack.slice(0, C.RAMP_SLOTS).forEach((ball, i) => {
    if (ball.color === world.motif[i % 3]) pts += C.PTS_PATTERN;
  });
  return pts;
}

/** does the robot's footprint overlap any launch-line tape? */
function robotOverLaunchLine(world: World, robotIdx: number): boolean {
  const r = world.robots[robotIdx];
  const corners = robotCorners(r);
  const halfDiag = Math.hypot(r.spec.length, r.spec.width) / 2;
  for (const [a, b] of launchSegments()) {
    // any corner close to the tape?
    if (corners.some((c) => distToSegment(c, a, b) < C.TAPE_W + 0.25)) return true;
    // or the tape passes beneath the chassis: corners straddle the line while
    // the segment is near the robot center
    if (distToSegment(r.pos, a, b) < halfDiag) {
      const nx = -(b.y - a.y);
      const ny = b.x - a.x;
      const side = (p: { x: number; y: number }) => (p.x - a.x) * nx + (p.y - a.y) * ny;
      const signs = corners.map(side);
      if (signs.some((s) => s > 0) && signs.some((s) => s < 0)) return true;
    }
  }
  return false;
}

export function assessEndOfAuto(world: World): void {
  for (let i = 0; i < world.robots.length; i++) {
    const r = world.robots[i];
    if (!robotOverLaunchLine(world, i)) {
      world.match.scores[r.alliance].leave += C.PTS_LEAVE;
      world.events.push(`LEAVE +${C.PTS_LEAVE}`);
    }
  }
  for (const a of ['red', 'blue'] as Alliance[]) {
    const pts = patternPoints(world, world.goals[a]);
    world.match.scores[a].autoPattern = pts;
    if (pts > 0 && world.robots.some((r) => r.alliance === a)) {
      world.events.push(`AUTO PATTERN +${pts}`);
    }
    recomputeTotal(world.match.scores[a]);
  }
}

export function assessMatchEnd(world: World): void {
  for (const a of ['red', 'blue'] as Alliance[]) {
    const s = world.match.scores[a];
    s.telePattern = patternPoints(world, world.goals[a]);
    // depot: ground balls resting in the alliance's depot band
    let depot = 0;
    for (const b of world.balls) {
      if (b.state.kind === 'ground' && inDepot(b.pos, a)) depot += C.PTS_DEPOT;
    }
    s.depot = depot;
    // base return per robot, + bonus when 2 robots fully returned. Only the
    // WHEEL ground-contact points count — intake/turret overhang doesn't
    // touch the floor, so it neither earns nor spoils parking credit.
    let fullCount = 0;
    for (const r of world.robots) {
      if (r.alliance !== a) continue;
      const zone = baseZone(a);
      const wheels = wheelContacts(r);
      const insideCount = wheels.filter((c) => inRect(c, zone)).length;
      if (insideCount === wheels.length) {
        s.base += C.PTS_BASE_FULL;
        fullCount++;
      } else if (insideCount > 0) {
        s.base += C.PTS_BASE_PARTIAL;
      }
    }
    if (fullCount >= 2) s.base += C.PTS_BASE_FULL; // 2-robot alliance bonus
    recomputeTotal(s);
  }
}

export function updateProvisionalPattern(world: World): void {
  for (const a of ['red', 'blue'] as Alliance[]) {
    world.match.provisionalPattern[a] = patternPoints(world, world.goals[a]);
  }
}
