import type { Alliance, Artifact, RobotCommand, RobotState, World } from '../../types';
import * as C from '../../config';
import { dcos, dsin, datan2, hyp, nextRandom, rot } from '../../math';
import { robotExtents } from '../../sim/physics';
import {
  CHAIN_ACCEL_DEPTH,
  CHAIN_ACCEL_HALF_Y,
  CHAIN_ASCEND_R,
  CHAIN_CATALYST_PICK_R,
  CHAIN_EJECT_SPEED,
  CHAIN_EJECT_SPREAD,
  CHAIN_EJECT_VZ,
  CHAIN_FIRE_INTERVAL,
  CHAIN_HALF_X,
  CHAIN_HALF_Y,
  CHAIN_HOOK_PLACE_R,
  CHAIN_STORAGE_DEFAULT,
  CHAIN_STORAGE_MAX,
  CHAIN_STORAGE_MIN,
  CHAIN_INTAKE_HALF,
  CHAIN_INTAKE_REACH,
  CHAIN_PARTICLE_R,
  CHAIN_PART_FRICTION,
  CHAIN_PART_REST_SPEED,
  CHAIN_PART_SEP_ITERS,
  CHAIN_PART_WALL_REST,
  CHAIN_SHOT_SPEED,
  CHAIN_SHOT_VZ,
  CHAIN_ENDGAME_S,
} from './config';
import {
  accelMultiplier,
  accelSide,
  hookPos,
  labAreas,
  ringStands,
  CHAIN_HOOKS_PER_GOAL,
  type ChainState,
} from './state';

/**
 * Chain Reaction gameplay step (called from `chainStep` after the robots move).
 *
 * Particles: bespoke integrator + a spatial-hash SEPARATION pass so they never
 * overlap (scales to 300). Shooter: launch held particles into the alliance
 * ACCELERATOR; a scored particle visibly flies INTO the accelerator, is counted,
 * then the auto-score system EJECTS it back onto the field (same ball — count stays
 * conserved at 300). Catalysts: a BUTTON picks up a nearby ring / places a carried
 * ring on a hook. Endgame park/ascend. Deterministic (commands + world.rngState).
 */
export function updateChain(
  world: World,
  dt: number,
  cmds: Map<number, RobotCommand>,
  enabled: boolean,
): void {
  const chain = world.chain!;
  const r2 = CHAIN_PARTICLE_R;

  const rand = (): number => {
    const n = nextRandom(world.rngState);
    world.rngState = n.state;
    return n.value;
  };

  // carried catalysts ride their robot
  for (const c of chain.catalysts) {
    if (c.carriedBy === null) continue;
    const rob = world.robots.find((x) => x.id === c.carriedBy);
    if (!rob) {
      c.carriedBy = null;
      continue;
    }
    c.pos = { x: rob.pos.x, y: rob.pos.y };
  }

  // ── robots: aim, fire, catalyst button ─────────────────────────────────────
  for (const r of world.robots) {
    const mouth = { x: accelSide(r.alliance) * CHAIN_HALF_X, y: 0 };
    r.turretHeading = datan2(mouth.y - r.pos.y, mouth.x - r.pos.x);
    const cmd = cmds.get(r.id);

    // fire a held particle toward the accelerator (auto-aimed ⇒ reliably scores)
    const wantsFire = enabled && (r.autoFire || (cmd?.fire ?? false));
    if (wantsFire && r.hopper.length > 0 && world.time >= r.fireReadyAt) {
      r.hopper.shift();
      const ang = r.turretHeading;
      world.balls.push({
        id: chain.nextBallId++,
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

    // catalyst pick-up / place-down — EDGE-triggered (acts once per press)
    const held = chain.catalystHeld[r.id] ?? false;
    const now = enabled && (cmd?.catalyst ?? false);
    if (now && !held) catalystAction(chain, r);
    chain.catalystHeld[r.id] = now;
  }

  // ── flight particles: fly INTO the accelerator, score, then eject back out ──
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
    const wall = side * CHAIN_HALF_X;
    const beyond = side < 0 ? b.pos.x <= wall : b.pos.x >= wall;

    if (!b.state.scored) {
      if (beyond && Math.abs(b.pos.y) <= CHAIN_ACCEL_HALF_Y) {
        // ENTERED the accelerator → count it; keep flying into the box
        chain.scored[a]++;
        chain.particlePoints[a] += accelMultiplier(chain, a);
        b.state.scored = true;
        survivors.push(b);
      } else if (beyond) {
        survivors.push(landed(b, { x: wall - side * r2, y: b.pos.y })); // missed the mouth
      } else if (b.z <= 0) {
        survivors.push(landed(b, { x: b.pos.x, y: b.pos.y })); // fell short
      } else {
        survivors.push(b);
      }
      continue;
    }

    // scored: two sub-phases by velocity direction
    const outgoing = Math.sign(b.vel.x) === -side;
    if (!outgoing) {
      // still flying INTO the box — eject when it lands or reaches the back wall
      const backWall = side * (CHAIN_HALF_X + CHAIN_ACCEL_DEPTH);
      const hitBack = side < 0 ? b.pos.x <= backWall : b.pos.x >= backWall;
      if (b.z <= 0 || hitBack) {
        if (hitBack) b.pos.x = backWall;
        b.vel.x = -side * CHAIN_EJECT_SPEED;
        b.vel.y = (rand() - 0.5) * CHAIN_EJECT_SPREAD;
        b.vz = CHAIN_EJECT_VZ;
        b.z = Math.max(b.z, 5);
      }
      survivors.push(b);
    } else {
      // ejecting back onto the field — land as a ground particle
      if (b.z <= 0) survivors.push(landed(b, { x: b.pos.x, y: b.pos.y }));
      else survivors.push(b);
    }
  }
  world.balls = survivors;

  // ── ground particles: friction, integrate, robot plow/intake ───────────────
  const out: Artifact[] = [];
  const ground: Artifact[] = [];
  for (const b of world.balls) {
    if (b.state.kind !== 'ground') {
      out.push(b);
      continue;
    }
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

    let absorbed = false;
    for (const rob of world.robots) {
      if (interact(b, rob, cmds.get(rob.id), enabled) === 'absorbed') {
        rob.hopper.push('green');
        rob.lastIntakeAt = world.time;
        absorbed = true;
        break;
      }
    }
    if (!absorbed) ground.push(b);
  }

  // never overlap: spatial-hash separation, then clamp inside the walls
  separateParticles(ground);
  const lim = CHAIN_HALF_X - r2;
  const limY = CHAIN_HALF_Y - r2;
  for (const b of ground) {
    if (b.pos.x > lim) {
      b.pos.x = lim;
      if (b.vel.x > 0) b.vel.x = -b.vel.x * CHAIN_PART_WALL_REST;
    } else if (b.pos.x < -lim) {
      b.pos.x = -lim;
      if (b.vel.x < 0) b.vel.x = -b.vel.x * CHAIN_PART_WALL_REST;
    }
    if (b.pos.y > limY) {
      b.pos.y = limY;
      if (b.vel.y > 0) b.vel.y = -b.vel.y * CHAIN_PART_WALL_REST;
    } else if (b.pos.y < -limY) {
      b.pos.y = -limY;
      if (b.vel.y < 0) b.vel.y = -b.vel.y * CHAIN_PART_WALL_REST;
    }
    out.push(b);
  }
  world.balls = out;

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

/** convert a flight ball to a resting ground particle at `pos` */
function landed(b: Artifact, pos: { x: number; y: number }): Artifact {
  b.state = { kind: 'ground' };
  b.pos = pos;
  b.vel = { x: 0, y: 0 };
  b.z = 0;
  b.vz = 0;
  return b;
}

/** push overlapping ground particles apart (position-based) using a uniform grid so
 * 300 particles never rest on top of each other. A few passes settle a pile. */
function separateParticles(ground: Artifact[]): void {
  const cell = 2 * CHAIN_PARTICLE_R;
  const minD = 2 * CHAIN_PARTICLE_R;
  const minD2 = minD * minD;
  const key = (cx: number, cy: number): number => (cx + 128) * 512 + (cy + 128);
  for (let iter = 0; iter < CHAIN_PART_SEP_ITERS; iter++) {
    const grid = new Map<number, Artifact[]>();
    for (const b of ground) {
      const k = key(Math.floor(b.pos.x / cell), Math.floor(b.pos.y / cell));
      const arr = grid.get(k);
      if (arr) arr.push(b);
      else grid.set(k, [b]);
    }
    for (const b of ground) {
      const cx = Math.floor(b.pos.x / cell);
      const cy = Math.floor(b.pos.y / cell);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const arr = grid.get(key(cx + ox, cy + oy));
          if (!arr) continue;
          for (const o of arr) {
            if (o.id <= b.id) continue;
            const dx = o.pos.x - b.pos.x;
            const dy = o.pos.y - b.pos.y;
            const d2 = dx * dx + dy * dy;
            if (d2 >= minD2 || d2 < 1e-9) continue;
            const d = Math.sqrt(d2);
            const push = (minD - d) / 2;
            const nx = dx / d;
            const ny = dy / d;
            b.pos.x -= nx * push;
            b.pos.y -= ny * push;
            o.pos.x += nx * push;
            o.pos.y += ny * push;
          }
        }
      }
    }
  }
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
  const rel = { x: b.pos.x - rob.pos.x, y: b.pos.y - rob.pos.y };
  const local = rot(rel, -rob.heading);
  const r2 = CHAIN_PARTICLE_R;
  const inBox = local.x < e.front + r2 && local.x > -e.rear - r2 && Math.abs(local.y) < e.half + r2;
  if (!inBox) return 'none';

  const intakeActive = enabled && (rob.autoIntake || (cmd?.intake ?? false));
  const frontZone = local.x > e.front - CHAIN_INTAKE_REACH && Math.abs(local.y) < CHAIN_INTAKE_HALF;
  const cap = Math.round(
    Math.min(CHAIN_STORAGE_MAX, Math.max(CHAIN_STORAGE_MIN, rob.spec.ballStorage ?? CHAIN_STORAGE_DEFAULT)),
  );
  if (intakeActive && rob.hopper.length < cap && frontZone) return 'absorbed';

  // plow: push out along the min-penetration axis (robot-local), impart robot vel
  const penX = e.front + r2 - local.x;
  const penXneg = local.x + e.rear + r2;
  const penY = e.half + r2 - Math.abs(local.y);
  let nx = 0;
  let ny = 0;
  if (Math.min(penX, penXneg) < penY) nx = penX < penXneg ? 1 : -1;
  else ny = local.y >= 0 ? 1 : -1;
  const world = rot({ x: nx, y: ny }, rob.heading);
  b.pos.x += world.x * 0.6;
  b.pos.y += world.y * 0.6;
  const rv = hyp(rob.vel.x, rob.vel.y);
  b.vel.x = world.x * rv * 0.9;
  b.vel.y = world.y * rv * 0.9;
  return 'none';
}

/** edge action: place a carried ring on a nearby empty hook (else drop it), or pick
 * up the nearest free ring in range if not carrying one. */
function catalystAction(chain: ChainState, rob: RobotState): void {
  const mine = chain.catalysts.find((c) => c.carriedBy === rob.id);
  if (mine) {
    for (let i = 0; i < CHAIN_HOOKS_PER_GOAL; i++) {
      const taken = chain.catalysts.some(
        (o) => o.hook && o.hook.alliance === rob.alliance && o.hook.index === i,
      );
      if (taken) continue;
      const h = hookPos(rob.alliance, i);
      if (hyp(h.x - rob.pos.x, h.y - rob.pos.y) < CHAIN_HOOK_PLACE_R) {
        mine.hook = { alliance: rob.alliance, index: i };
        mine.carriedBy = null;
        return;
      }
    }
    // no hook in range → drop it here
    mine.carriedBy = null;
    mine.pos = { x: rob.pos.x, y: rob.pos.y };
    return;
  }
  // not carrying → take the nearest reachable ring: a FREE ring on the field, OR a
  // SEATED ring off a hook — either your OWN goal or the OPPONENT's (de-scoring).
  let best: (typeof chain.catalysts)[number] | null = null;
  let bestD = Infinity;
  for (const c of chain.catalysts) {
    if (c.carriedBy !== null) continue;
    let d: number;
    if (c.hook) {
      const h = hookPos(c.hook.alliance, c.hook.index); // reach to the hook (any goal)
      d = hyp(h.x - rob.pos.x, h.y - rob.pos.y);
      if (d >= CHAIN_HOOK_PLACE_R) continue;
    } else {
      d = hyp(c.pos.x - rob.pos.x, c.pos.y - rob.pos.y);
      if (d >= CHAIN_CATALYST_PICK_R) continue;
    }
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  if (best) {
    best.hook = null; // if it was seated, this removes it from the goal (de-score)
    best.carriedBy = rob.id;
  }
}

/** a robot's endgame status: ascended (near a ring stand, slow) > parked (center in a
 * lab-area corner) > none */
function endgameOf(rob: RobotState): 'none' | 'parked' | 'ascended' {
  const slow = hyp(rob.vel.x, rob.vel.y) < 12;
  for (const rs of ringStands()) {
    if (slow && hyp(rs.x - rob.pos.x, rs.y - rob.pos.y) < CHAIN_ASCEND_R) return 'ascended';
  }
  const cx = rob.pos.x;
  const cy = rob.pos.y;
  for (const lab of labAreas(rob.alliance)) {
    if (cx >= lab.x0 && cx <= lab.x1 && cy >= lab.y0 && cy <= lab.y1) return 'parked';
  }
  return 'none';
}
