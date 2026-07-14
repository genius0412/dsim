import type { Alliance, Artifact, RobotCommand, RobotState, World } from '../../types';
import * as C from '../../config';
import { dcos, dsin, datan2, hyp, nextRandom, rot } from '../../math';
import { robotExtents } from '../../sim/physics';
import {
  CHAIN_ACCEL_HALF_Y,
  CHAIN_ASCEND_R,
  CHAIN_CATALYST_PICK_R,
  CHAIN_FIRE_INTERVAL,
  CHAIN_HALF_X,
  CHAIN_HALF_Y,
  CHAIN_HOOK_PLACE_R,
  CHAIN_HOPPER_CAP,
  CHAIN_INTAKE_HALF,
  CHAIN_INTAKE_REACH,
  CHAIN_PARTICLE_R,
  CHAIN_PART_FRICTION,
  CHAIN_PART_REST_SPEED,
  CHAIN_PART_WALL_REST,
  CHAIN_SHOT_SPEED,
  CHAIN_SHOT_VZ,
  CHAIN_ENDGAME_S,
} from './config';
import {
  accelMouth,
  accelMultiplier,
  accelSide,
  hookPos,
  labAreas,
  ringStands,
  type ChainState,
} from './state';

/**
 * Chain Reaction gameplay step (called from `chainStep` after the robots move).
 *
 * Owns: particle physics (bespoke, no ball↔ball so 300 is cheap), robot plow +
 * intake, the shooter (launch held particles into the alliance ACCELERATOR),
 * accelerator scoring + RECYCLE (a scored particle is rejected back onto the field —
 * count conserved at `CHAIN_PARTICLE_SIM`), CATALYST pick-up/seat-on-hook (multiplier),
 * and endgame park/ascend. Deterministic: reject positions come off `world.rngState`.
 */
export function updateChain(
  world: World,
  dt: number,
  cmds: Map<number, RobotCommand>,
  enabled: boolean,
): void {
  const chain = world.chain!;
  const r2 = CHAIN_PARTICLE_R;

  // deterministic rng advancing world.rngState (for particle rejects)
  const rand = (): number => {
    const n = nextRandom(world.rngState);
    world.rngState = n.state;
    return n.value;
  };
  const rejectPos = (): { x: number; y: number } => ({
    x: (rand() - 0.5) * 2 * (CHAIN_HALF_X - 4),
    y: (rand() - 0.5) * 2 * (CHAIN_HALF_Y - 4),
  });

  // ── robots: aim at the accelerator + fire + catalysts ──────────────────────
  for (const r of world.robots) {
    const mouth = accelMouth(r.alliance);
    r.turretHeading = datan2(mouth.y - r.pos.y, mouth.x - r.pos.x);
    const cmd = cmds.get(r.id);

    // fire a held particle toward the accelerator (auto-aimed ⇒ reliably scores)
    const wantsFire = enabled && (r.autoFire || (cmd?.fire ?? false));
    if (wantsFire && r.hopper.length > 0 && world.time >= r.fireReadyAt) {
      r.hopper.shift();
      const ang = r.turretHeading;
      world.balls.push({
        id: nextBallId(world),
        color: 'green',
        state: { kind: 'flight', target: r.alliance },
        pos: { x: r.pos.x + dcos(ang) * 4, y: r.pos.y + dsin(ang) * 4 },
        vel: { x: dcos(ang) * CHAIN_SHOT_SPEED, y: dsin(ang) * CHAIN_SHOT_SPEED },
        z: 8,
        vz: CHAIN_SHOT_VZ,
      });
      r.fireReadyAt = world.time + CHAIN_FIRE_INTERVAL;
      r.lastFireAt = world.time;
    }
  }

  updateCatalysts(world, chain);

  // ── flight particles: fly, score into the accelerator, or fall to ground ───
  const survivors: Artifact[] = [];
  for (const b of world.balls) {
    if (b.state.kind !== 'flight') {
      survivors.push(b);
      continue;
    }
    const a = b.state.target;
    const side = accelSide(a);
    b.pos.x += b.vel.x * dt;
    b.pos.y += b.vel.y * dt;
    b.z += b.vz * dt;
    b.vz -= C.GRAVITY * dt;
    const mouthX = side * CHAIN_HALF_X;
    const crossed = side < 0 ? b.pos.x <= mouthX : b.pos.x >= mouthX;
    if (crossed) {
      if (Math.abs(b.pos.y) <= CHAIN_ACCEL_HALF_Y) {
        // SCORED — count + points (multiplier at score time), then RECYCLE a ground
        // particle back onto the field (the accelerator's reject system).
        chain.scored[a]++;
        chain.particlePoints[a] += accelMultiplier(chain, a);
        survivors.push(groundParticle(nextBallId(world), rejectPos()));
      } else {
        // hit the wall outside the mouth ⇒ drops to the floor there
        survivors.push(landed(b, { x: mouthX - side * r2, y: b.pos.y }));
      }
      continue;
    }
    if (b.z <= 0) {
      survivors.push(landed(b, { x: b.pos.x, y: b.pos.y }));
      continue;
    }
    survivors.push(b);
  }
  world.balls = survivors;

  // ── ground particles: friction, integrate, robot plow/intake, wall clamp ───
  const ground: Artifact[] = [];
  for (const b of world.balls) {
    if (b.state.kind !== 'ground') {
      ground.push(b);
      continue;
    }
    // rolling friction
    const sp = hyp(b.vel.x, b.vel.y);
    if (sp > 0) {
      const ns = sp - CHAIN_PART_FRICTION * dt;
      if (ns <= CHAIN_PART_REST_SPEED) {
        b.vel.x = 0;
        b.vel.y = 0;
      } else {
        b.vel.x *= ns / sp;
        b.vel.y *= ns / sp;
      }
    }
    b.pos.x += b.vel.x * dt;
    b.pos.y += b.vel.y * dt;

    // robot plow / intake
    let absorbed = false;
    for (const rob of world.robots) {
      const res = interact(b, rob, cmds.get(rob.id), enabled);
      if (res === 'absorbed') {
        rob.hopper.push('green');
        rob.lastIntakeAt = world.time;
        absorbed = true;
        break;
      }
    }
    if (absorbed) continue;

    // hard wall clamp (inside the perimeter)
    const lim = CHAIN_HALF_X - r2;
    if (b.pos.x > lim) {
      b.pos.x = lim;
      if (b.vel.x > 0) b.vel.x = -b.vel.x * CHAIN_PART_WALL_REST;
    } else if (b.pos.x < -lim) {
      b.pos.x = -lim;
      if (b.vel.x < 0) b.vel.x = -b.vel.x * CHAIN_PART_WALL_REST;
    }
    if (b.pos.y > lim) {
      b.pos.y = lim;
      if (b.vel.y > 0) b.vel.y = -b.vel.y * CHAIN_PART_WALL_REST;
    } else if (b.pos.y < -lim) {
      b.pos.y = -lim;
      if (b.vel.y < 0) b.vel.y = -b.vel.y * CHAIN_PART_WALL_REST;
    }
    ground.push(b);
  }
  world.balls = ground;

  // ── scoring + endgame ──────────────────────────────────────────────────────
  const isEndgame =
    world.match.phase === 'post' ||
    (world.match.phase === 'teleop' && world.match.phaseTimeLeft <= CHAIN_ENDGAME_S);
  for (const rob of world.robots) {
    chain.endgame[rob.id] = isEndgame ? endgameOf(rob) : 'none';
  }
  for (const a of ['red', 'blue'] as Alliance[]) {
    let eg = 0;
    for (const rob of world.robots) {
      if (rob.alliance !== a) continue;
      const st = chain.endgame[rob.id];
      eg += st === 'ascended' ? 20 : st === 'parked' ? 5 : 0;
    }
    world.match.scores[a].total = chain.particlePoints[a] + eg;
    world.goals[a].classifiedCount = chain.scored[a]; // surfaces in worldHash
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** a deterministic next ball id off the chain-state counter (no module global) */
function nextBallId(world: World): number {
  return world.chain!.nextBallId++;
}

function groundParticle(id: number, pos: { x: number; y: number }): Artifact {
  return { id, color: 'green', state: { kind: 'ground' }, pos, vel: { x: 0, y: 0 }, z: 0, vz: 0 };
}

/** convert a flight ball to a resting ground particle at `pos` */
function landed(b: Artifact, pos: { x: number; y: number }): Artifact {
  b.state = { kind: 'ground' };
  b.pos = pos;
  b.vel = { x: 0, y: 0 };
  b.z = 0;
  b.vz = 0;
  return b;
}

/**
 * Resolve one ground particle against one robot: intake it (front zone + active +
 * room) ⇒ 'absorbed'; else plow it out of the chassis (impart the robot's velocity).
 */
function interact(
  b: Artifact,
  rob: RobotState,
  cmd: RobotCommand | undefined,
  enabled: boolean,
): 'absorbed' | 'none' {
  const e = robotExtents(rob);
  // particle in the robot's local frame (forward = +x)
  const rel = { x: b.pos.x - rob.pos.x, y: b.pos.y - rob.pos.y };
  const local = rot(rel, -rob.heading);
  const r2 = CHAIN_PARTICLE_R;
  const inBox = local.x < e.front + r2 && local.x > -e.rear - r2 && Math.abs(local.y) < e.half + r2;
  if (!inBox) return 'none';

  const intakeActive = enabled && (rob.autoIntake || (cmd?.intake ?? false));
  const frontZone = local.x > e.front - CHAIN_INTAKE_REACH && Math.abs(local.y) < CHAIN_INTAKE_HALF;
  if (intakeActive && rob.hopper.length < CHAIN_HOPPER_CAP && frontZone) return 'absorbed';

  // plow: push out along the min-penetration axis (robot-local), impart robot vel
  const penX = e.front + r2 - local.x; // toward +x escape
  const penXneg = local.x + e.rear + r2; // toward -x escape
  const penY = e.half + r2 - Math.abs(local.y);
  let nx = 0;
  let ny = 0;
  const minX = Math.min(penX, penXneg);
  if (minX < penY) {
    nx = penX < penXneg ? 1 : -1;
  } else {
    ny = local.y >= 0 ? 1 : -1;
  }
  const world = rot({ x: nx, y: ny }, rob.heading); // escape normal in world frame
  b.pos.x += world.x * 0.6;
  b.pos.y += world.y * 0.6;
  const rv = hyp(rob.vel.x, rob.vel.y);
  b.vel.x = world.x * rv * 0.9;
  b.vel.y = world.y * rv * 0.9;
  return 'none';
}

/** update carried catalysts (follow the robot, seat on a nearby empty hook) + auto
 * pick up a free catalyst with a robot that isn't already carrying one */
function updateCatalysts(world: World, chain: ChainState): void {
  const carrying = new Set<number>();
  for (const c of chain.catalysts) if (c.carriedBy !== null) carrying.add(c.carriedBy);

  for (const c of chain.catalysts) {
    if (c.hook) continue; // seated, done
    if (c.carriedBy !== null) {
      const rob = world.robots.find((x) => x.id === c.carriedBy);
      if (!rob) {
        c.carriedBy = null;
        continue;
      }
      c.pos = { x: rob.pos.x, y: rob.pos.y };
      // seat on an empty hook of the carrier's alliance
      for (let i = 0; i < 2; i++) {
        const taken = chain.catalysts.some(
          (o) => o.hook && o.hook.alliance === rob.alliance && o.hook.index === i,
        );
        if (taken) continue;
        const h = hookPos(rob.alliance, i);
        if (hyp(h.x - rob.pos.x, h.y - rob.pos.y) < CHAIN_HOOK_PLACE_R) {
          c.hook = { alliance: rob.alliance, index: i };
          c.carriedBy = null;
          carrying.delete(rob.id);
          break;
        }
      }
      continue;
    }
    // free on the field: a robot not already carrying can pick it up
    for (const rob of world.robots) {
      if (carrying.has(rob.id)) continue;
      if (hyp(c.pos.x - rob.pos.x, c.pos.y - rob.pos.y) < CHAIN_CATALYST_PICK_R) {
        c.carriedBy = rob.id;
        carrying.add(rob.id);
        break;
      }
    }
  }
}

/** a robot's endgame status: ascended (near a ring stand, slow) > parked (fully in a
 * lab-area corner) > none */
function endgameOf(rob: RobotState): 'none' | 'parked' | 'ascended' {
  const slow = hyp(rob.vel.x, rob.vel.y) < 12;
  for (const rs of ringStands()) {
    if (slow && hyp(rs.x - rob.pos.x, rs.y - rob.pos.y) < CHAIN_ASCEND_R) return 'ascended';
  }
  // parked if the robot's CENTER is within one of its alliance's lab-area squares
  // (forgiving — the exact "fully contained" rule + real lab geometry come later).
  const cx = rob.pos.x;
  const cy = rob.pos.y;
  for (const lab of labAreas(rob.alliance)) {
    if (cx >= lab.x0 && cx <= lab.x1 && cy >= lab.y0 && cy <= lab.y1) return 'parked';
  }
  return 'none';
}
