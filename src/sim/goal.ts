import type { Alliance, Artifact, World } from '../types';
import * as C from '../config';
import {
  basinFunnelTarget,
  gateZone,
  goalCenter,
  goalFaceNormal,
  goalLineValue,
  goalSide,
  railPos,
  tunnelExitVel,
} from './field';
import { addClassified, addOverflow } from './scoring';
import { approach, nextRandom } from '../math';
import { robotIntersectsRect } from './physics';

/** balls of a goal's rail stack (non-overflow), sorted from the gate up */
export function railStack(world: World, a: Alliance): Artifact[] {
  return world.balls
    .filter((b) => b.state.kind === 'rail' && b.state.goal === a && !b.state.overflow)
    .sort((p, q) => (p.state as { s: number }).s - (q.state as { s: number }).s);
}

/** flight ball crossing the opening plane drops into the goal basin. Entry
 * counts in EITHER direction — close, flat shots that cross the plane still
 * ascending are caught by the goal's funnel/canopy and drop in. */
export function checkGoalEntry(_world: World, b: Artifact, prevZ: number): boolean {
  if (b.state.kind !== 'flight') return false;
  const P = C.GOAL_OPENING_Z;
  if (!((prevZ - P) * (b.z - P) <= 0 && prevZ !== b.z)) return false;
  for (const a of ['red', 'blue'] as Alliance[]) {
    const g = goalCenter(a);
    if (Math.hypot(b.pos.x - g.x, b.pos.y - g.y) > C.GOAL_OPENING_RADIUS) continue;
    b.state = { kind: 'basin', goal: a };
    // keep entry velocity so the ball splashes around the whole basin
    b.vel.x *= C.BASIN_ENTRY_KEEP_V;
    b.vel.y *= C.BASIN_ENTRY_KEEP_V;
    b.vz *= 0.3;
    return true;
  }
  return false;
}

/** physics inside the triangular goal basin: gravity onto the funnel floor,
 * containment by the goal walls, pull toward the classifier entrance, and
 * ball-ball jumbling. Hand off to the rail when the entrance is clear. */
export function updateBasins(world: World, dt: number): void {
  const basins: Record<Alliance, Artifact[]> = { red: [], blue: [] };
  for (const b of world.balls) {
    if (b.state.kind === 'basin') basins[b.state.goal].push(b);
  }
  for (const a of ['red', 'blue'] as Alliance[]) {
    const balls = basins[a];
    if (balls.length === 0) continue;
    const entry = basinFunnelTarget(a);
    const g = goalSide(a);
    const f = C.FIELD_HALF;
    const channelEdge = g * (f - C.CLASSIFIER_W); // basin is field-side of the channel

    for (const b of balls) {
      // vertical: fall onto the funnel floor
      b.z += b.vz * dt;
      b.vz -= C.GRAVITY * dt;
      if (b.z <= C.BASIN_FLOOR_Z) {
        b.z = C.BASIN_FLOOR_Z;
        if (b.vz < 0) b.vz = -b.vz * C.BASIN_RESTITUTION;
        if (Math.abs(b.vz) < 15) b.vz = 0;
      }
      // horizontal: funnel pull toward the classifier entrance + damping.
      // fast balls mostly carom around the basin; the funnel grips them
      // once they slow down
      const dx = entry.x - b.pos.x;
      const dy = entry.y - b.pos.y;
      const d = Math.hypot(dx, dy) || 1;
      const onFloor = b.z <= C.BASIN_FLOOR_Z + 1;
      const speed = Math.hypot(b.vel.x, b.vel.y);
      let pull = onFloor ? C.BASIN_FUNNEL_ACCEL : C.BASIN_FUNNEL_ACCEL * 0.25;
      if (speed > C.BASIN_FUNNEL_GRIP_SPEED) pull *= 0.3;
      b.vel.x += (dx / d) * pull * dt;
      b.vel.y += (dy / d) * pull * dt;
      const damp = Math.max(0, 1 - C.BASIN_DAMPING * dt);
      b.vel.x *= damp;
      b.vel.y *= damp;
      b.pos.x += b.vel.x * dt;
      b.pos.y += b.vel.y * dt;

      // containment: channel edge + far wall + the goal face from the inside
      const rr = C.BALL_RADIUS;
      if (g > 0 ? b.pos.x > channelEdge - rr : b.pos.x < channelEdge + rr) {
        b.pos.x = channelEdge - g * rr;
        b.vel.x = -b.vel.x * C.BASIN_WALL_RESTITUTION;
      }
      if (b.pos.y > f - rr) {
        b.pos.y = f - rr;
        b.vel.y = -b.vel.y * C.BASIN_WALL_RESTITUTION;
      }
      const gv = goalLineValue(b.pos, a); // > 0 inside the goal footprint
      const pen = rr - gv / Math.SQRT2; // how far the ball pokes out the face
      if (pen > 0) {
        const n = goalFaceNormal(a); // points out into the field
        b.pos.x -= n.x * pen; // push back INSIDE (against -n)
        b.pos.y -= n.y * pen;
        const vn = b.vel.x * n.x + b.vel.y * n.y;
        if (vn > 0) {
          b.vel.x -= n.x * vn * 1.4;
          b.vel.y -= n.y * vn * 1.4;
        }
      }
    }

    // jumbling: ball-ball collisions within the basin
    for (let i = 0; i < balls.length; i++) {
      for (let j = i + 1; j < balls.length; j++) {
        const p = balls[i];
        const q = balls[j];
        if (Math.abs(p.z - q.z) > C.BALL_RADIUS * 1.6) continue;
        const dx = q.pos.x - p.pos.x;
        const dy = q.pos.y - p.pos.y;
        const d2 = dx * dx + dy * dy;
        const minD = C.BALL_RADIUS * 2;
        if (d2 >= minD * minD || d2 < 1e-9) continue;
        const d = Math.sqrt(d2);
        const nx = dx / d;
        const ny = dy / d;
        const ov = (minD - d) / 2;
        p.pos.x -= nx * ov;
        p.pos.y -= ny * ov;
        q.pos.x += nx * ov;
        q.pos.y += ny * ov;
        const rvx = q.vel.x - p.vel.x;
        const rvy = q.vel.y - p.vel.y;
        const vn = rvx * nx + rvy * ny;
        if (vn < 0) {
          const imp = -vn * 0.55;
          p.vel.x -= imp * nx;
          p.vel.y -= imp * ny;
          q.vel.x += imp * nx;
          q.vel.y += imp * ny;
        }
      }
    }

    // hand-off to the rail: one at a time, when near the entrance and the
    // top of the rail is clear. The ball boards UNDECIDED — classified vs
    // overflow is settled in updateRails at the moment it first meets the
    // stack (or the gate floor), so a drain in progress can still save it.
    const entryBlocked = world.balls.some(
      (b) =>
        b.state.kind === 'rail' &&
        b.state.goal === a &&
        !b.state.overflow &&
        b.state.s > C.RAIL_ENTRY_BLOCK_S,
    );
    if (!entryBlocked) {
      for (const b of balls) {
        const d = Math.hypot(b.pos.x - entry.x, b.pos.y - entry.y);
        if (d > C.BASIN_ENTRY_RADIUS || b.z > C.BASIN_FLOOR_Z + 2) continue;
        // hand-off keeps the ball's position: it glides onto the rail while
        // descending (x/z blend happens in updateRails) — no snapping
        const s = b.pos.y - C.CLASSIFIER_Y0;
        const v = Math.min(b.vel.y, -8);
        b.state = { kind: 'rail', goal: a, s, v, overflow: false, pending: true };
        b.vel = { x: 0, y: 0 };
        b.vz = 0;
        break; // one hand-off per goal per tick keeps the flow orderly
      }
    }
  }
}

/** 1D flow down the classifier rail with contact stacking against the gate
 * (or the ball ahead). Overflow balls ride over everything and always exit. */
export function updateRails(world: World, dt: number): void {
  for (const a of ['red', 'blue'] as Alliance[]) {
    const goal = world.goals[a];

    const railX = railPos(a, 0).x;

    // stacked balls flow together
    const stack = railStack(world, a);
    let floor = goal.gateOpen ? -Infinity : C.GATE_STOP_S;
    let below = 0; // column balls ahead of (below) the current one
    for (const b of stack) {
      const st = b.state as { s: number; v: number; overflow: boolean; pending?: boolean };
      st.v = Math.max(st.v - C.RAIL_ACCEL * dt, -C.RAIL_TERMINAL);
      st.s += st.v * dt;
      if (st.s < floor) {
        // first contact with the gate stop or the ball ahead: a pending ball
        // decides HERE — meeting a full column (9 below) diverts it over the
        // top as OVERFLOW; otherwise it settles into the column CLASSIFIED
        if (st.pending && below >= C.RAMP_SLOTS) {
          st.pending = false;
          st.overflow = true;
          st.v = -C.OVERFLOW_FLOW_SPEED;
          goal.overflowCount++;
          addOverflow(world, a);
          continue; // rides over from here on — handled by the overflow pass
        }
        st.s = floor;
        st.v = 0;
        if (st.pending) {
          st.pending = false;
          goal.classifiedCount++;
          addClassified(world, a);
        }
      }
      floor = st.s + C.RAIL_PITCH;
      below++;
      // glide smoothly onto the rail line — no positional snapping
      b.pos.y = C.CLASSIFIER_Y0 + st.s;
      b.pos.x = approach(b.pos.x, railX, C.RAIL_BLEND_SPEED * dt);
      b.z = approach(b.z, C.RAMP_SURFACE_Z, C.RAIL_BLEND_SPEED * dt);
    }

    // overflow balls ride over the stack at constant flow
    for (const b of world.balls) {
      if (b.state.kind !== 'rail' || b.state.goal !== a || !b.state.overflow) continue;
      b.state.s -= C.OVERFLOW_FLOW_SPEED * dt;
      b.pos.y = C.CLASSIFIER_Y0 + b.state.s;
      b.pos.x = approach(b.pos.x, railX, C.RAIL_BLEND_SPEED * dt);
      b.z = approach(b.z, C.OVERFLOW_Z, C.RAIL_BLEND_SPEED * dt);
    }

    // balls past the gate roll out onto the floor from where they are
    for (const b of world.balls) {
      if (b.state.kind !== 'rail' || b.state.goal !== a) continue;
      if (b.state.s > C.RAIL_EXIT_S) continue;
      if (b.state.pending) {
        // flowed down the whole channel and out an open gate without ever
        // meeting the column: it was sorted, then released — CLASSIFIED
        b.state.pending = false;
        goal.classifiedCount++;
        addClassified(world, a);
      }
      const vel = tunnelExitVel(a);
      let r1 = nextRandom(world.rngState);
      let r2 = nextRandom(r1.state);
      world.rngState = r2.state;
      b.state = { kind: 'ground' };
      b.z = 0;
      b.vz = 0;
      b.vel = { x: vel.x * (0.8 + r1.value * 0.4), y: vel.y * (0.8 + r2.value * 0.4) };
    }
  }
}

/** the gate is a physical valve: a push swings it open, and once balls are
 * streaming through, the spring can't close it against the flow — it only
 * shuts when a gap opens at the gateway. A tap therefore usually drains the
 * whole column, but can stop early if the flow breaks up. */
export function updateGates(world: World, dt: number): void {
  for (const a of ['red', 'blue'] as Alliance[]) {
    const goal = world.goals[a];
    const zone = gateZone(a);
    const held = world.robots.some((r) => r.alliance === a && robotIntersectsRect(r, zone));
    if (held) {
      goal.gateHoldTime += dt;
      if (goal.gateHoldTime >= C.GATE_OPEN_HOLD && !goal.gateOpen) {
        goal.gateOpen = true;
        world.events.push('GATE OPEN');
      }
    } else {
      goal.gateHoldTime = 0;
      if (goal.gateOpen) {
        // spring tries to close: blocked while any ball is in the gateway
        const ballInGateway = world.balls.some(
          (b) =>
            b.state.kind === 'rail' &&
            b.state.goal === a &&
            b.state.s > C.GATE_CLOSE_CLEAR_LO &&
            b.state.s < C.GATE_CLOSE_CLEAR_HI,
        );
        if (!ballInGateway) goal.gateOpen = false;
      }
    }
  }
}
