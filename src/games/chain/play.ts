import type { Alliance, Artifact, RobotCommand, RobotState, World } from '../../types';
import * as C from '../../config';
import { clamp, datan2, dcos, dsin, hyp, nextRandom, rot, wrapAngle } from '../../math';
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
  chainHopperCap,
  CHAIN_INTAKES,
  CHAIN_DEFAULT_INTAKE,
  CHAIN_DEFAULT_SCORE_MODE,
  CHAIN_AIM_TOL,
  CHAIN_AIM_GAIN,
  CHAIN_LAUNCH_LINE_FRAC,
  CHAIN_LAUNCH_Z0,
  CHAIN_DRUM_MAX,
  CHAIN_DRUM_INTERVAL,
  CHAIN_DRUM_SPEED,
  CHAIN_DUMP_RANGE,
  CHAIN_DUMP_INTERVAL,
  CHAIN_DUMP_SPEED,
  CHAIN_DUMP_SIDE_VAR,
  CHAIN_FUNNEL_S,
  CHAIN_FUNNEL_FALL,
  CHAIN_FUNNEL_DRIFT,
  CHAIN_THROWBACK_SPEED,
  CHAIN_THROWBACK_SPREAD,
  CHAIN_PARTICLE_R,
  CHAIN_PART_FRICTION,
  CHAIN_PART_REST_SPEED,
  CHAIN_PART_SEP_ITERS,
  CHAIN_PART_WALL_REST,
  CHAIN_SHOT_SPEED,
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

  // ── robots: aim, fire/dump, catalyst button ────────────────────────────────
  for (const r of world.robots) {
    const mouth = { x: accelSide(r.alliance) * CHAIN_HALF_X, y: 0 };
    const cmd = cmds.get(r.id);
    const wantsFire = enabled && (r.autoFire || (cmd?.fire ?? false));
    const mode = r.spec.scoreMode ?? CHAIN_DEFAULT_SCORE_MODE;
    const distMouth = hyp(mouth.x - r.pos.x, mouth.y - r.pos.y);

    if (mode === 'turret') {
      // TURRET single-shooter: auto-aim the turret at the mouth center and index ONE
      // particle per cadence, from ANY range. SOLVED trajectory (aim at center ⇒ always
      // crosses the mouth; arc adapts to distance so a shot never falls short).
      r.turretHeading = datan2(mouth.y - r.pos.y, mouth.x - r.pos.x);
      if (wantsFire && r.hopper.length > 0 && world.time >= r.fireReadyAt) {
        r.hopper.shift();
        launchToAccel(world, chain, r, mouth, CHAIN_SHOT_SPEED, 0);
        r.fireReadyAt = world.time + CHAIN_FIRE_INTERVAL;
        r.lastFireAt = world.time;
      }
    } else {
      // TURRETLESS (drum / dumper): no turret — the barrel is the chassis, so the robot
      // AIMS BY TURNING to face the goal (the fire button steers it, see chainAimAssist in
      // step.ts) and fires a PARALLEL LINE of particles across its width. Only fires once
      // ALIGNED; drum from any range, dumper only within its (generous) stand-off range.
      r.turretHeading = r.heading;
      const aligned = Math.abs(wrapAngle(goalHeading(r.alliance) - r.heading)) <= CHAIN_AIM_TOL;
      const inRange = mode === 'drum' ? true : distMouth <= CHAIN_DUMP_RANGE;
      if (wantsFire && aligned && inRange && r.hopper.length > 0 && world.time >= r.fireReadyAt) {
        if (mode === 'drum') {
          // flywheel drum: up to 6 at once, UNIFORM velocity, slower burst cadence
          const n = Math.min(CHAIN_DRUM_MAX, r.hopper.length);
          r.hopper.splice(0, n);
          launchLine(world, chain, r, n, CHAIN_DRUM_SPEED, 0);
          r.fireReadyAt = world.time + CHAIN_DRUM_INTERVAL;
        } else {
          // catapult: fling the WHOLE hopper at once, side-to-side velocity variance
          const n = r.hopper.length;
          r.hopper.length = 0;
          launchLine(world, chain, r, n, CHAIN_DUMP_SPEED, CHAIN_DUMP_SIDE_VAR);
          r.fireReadyAt = world.time + CHAIN_DUMP_INTERVAL;
        }
        r.lastFireAt = world.time;
      }
    }

    // catalyst pick-up / place-down — EDGE-triggered (acts once per press)
    const held = chain.catalystHeld[r.id] ?? false;
    const now = enabled && (cmd?.catalyst ?? false);
    if (now && !held) catalystAction(chain, r);
    chain.catalystHeld[r.id] = now;
  }

  // ── flight particles: fly at the goal → score + FUNNEL down → wall-side launcher
  //    flings them back out; a MISS is thrown back into the field by a human ──────
  const survivors: Artifact[] = [];
  for (const b of world.balls) {
    if (b.state.kind !== 'flight') {
      survivors.push(b);
      continue;
    }
    const st = b.state;
    const a = st.target;
    const side = accelSide(a);
    const wall = side * CHAIN_HALF_X;

    if (!st.scored) {
      // ballistic flight toward the goal
      b.pos.x += b.vel.x * dt;
      b.pos.y += b.vel.y * dt;
      b.z += b.vz * dt;
      b.vz -= C.GRAVITY * dt;
      const beyond = side < 0 ? b.pos.x <= wall : b.pos.x >= wall;
      if (beyond && Math.abs(b.pos.y) <= CHAIN_ACCEL_HALF_Y) {
        // ENTERED the tall opening → score, then FUNNEL down inside the goal before the
        // launcher flings it back out (no more instant eject).
        chain.scored[a]++;
        chain.particlePoints[a] += accelMultiplier(chain, a);
        st.scored = true;
        st.funnelT = CHAIN_FUNNEL_S;
        b.pos.x = wall + side * (CHAIN_PARTICLE_R + 1); // just inside the opening
        b.vel.x = 0;
        b.vel.y = 0;
        b.vz = 0;
        b.z = Math.max(b.z, 8);
        survivors.push(b);
      } else if (beyond) {
        // missed the opening (hit the perimeter wall) → a human throws it back in
        survivors.push(throwBack(b, side, rand));
      } else if (b.z <= 0) {
        survivors.push(landed(b, { x: b.pos.x, y: b.pos.y })); // fell short, into the field
      } else {
        survivors.push(b);
      }
      continue;
    }

    // SCORED. Funnel down inside the goal, then the wall-side launcher (spanning the whole
    // goal width) flings it back onto the field.
    if ((st.funnelT ?? 0) > 0) {
      st.funnelT = (st.funnelT ?? 0) - dt;
      b.z = Math.max(0, b.z - CHAIN_FUNNEL_FALL * dt); // settle to the goal floor
      b.pos.x = approach(b.pos.x, wall, CHAIN_FUNNEL_DRIFT * dt); // drift to the wall-side launcher
      if ((st.funnelT ?? 0) <= 0) {
        // LAUNCH back onto the field from the wall-side launcher, across the goal width
        const spd = CHAIN_EJECT_SPEED * (0.8 + rand() * 0.5);
        b.pos.x = wall - side * CHAIN_PARTICLE_R;
        b.pos.y = (rand() - 0.5) * 2 * CHAIN_ACCEL_HALF_Y * 0.85; // spread across the launcher
        b.vel.x = -side * spd;
        b.vel.y = (rand() - 0.5) * CHAIN_EJECT_SPREAD;
        b.vz = CHAIN_EJECT_VZ * (0.8 + rand() * 0.5);
        b.z = Math.max(b.z, 5);
      }
      survivors.push(b);
    } else {
      // ejecting back onto the field — integrate + land as a ground particle
      b.pos.x += b.vel.x * dt;
      b.pos.y += b.vel.y * dt;
      b.z += b.vz * dt;
      b.vz -= C.GRAVITY * dt;
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

/** launch one particle from robot `r` toward its accelerator `mouth` at a fixed
 * horizontal speed, with an optional lateral velocity (a dump fans several out). Aims
 * at the mouth center and solves the vertical velocity so the ballistic arc lands
 * mid-box at ANY distance (so a shot never falls short). Pushes a 'flight' ball. */
function launchToAccel(
  world: World,
  chain: ChainState,
  r: RobotState,
  mouth: { x: number; y: number },
  horizSpeed: number,
  latVel: number,
): void {
  const distMouth = Math.max(1, hyp(mouth.x - r.pos.x, mouth.y - r.pos.y));
  const dir = { x: (mouth.x - r.pos.x) / distMouth, y: (mouth.y - r.pos.y) / distMouth };
  const perp = { x: -dir.y, y: dir.x }; // lateral spread axis
  const z0 = 8;
  const land = distMouth + CHAIN_ACCEL_DEPTH * 0.5; // land halfway into the box
  const t = land / horizSpeed;
  const vz = 0.5 * C.GRAVITY * t - z0 / t; // solve z(t)=0 for the landing point
  world.balls.push({
    id: chain.nextBallId++,
    color: 'green',
    state: { kind: 'flight', target: r.alliance },
    pos: { x: r.pos.x + dir.x * 4, y: r.pos.y + dir.y * 4 },
    vel: { x: dir.x * horizSpeed + perp.x * latVel, y: dir.y * horizSpeed + perp.y * latVel },
    z: z0,
    vz,
  });
}

/** the heading a turretless launcher must face to aim at its goal (goal is at ±x, so
 * face +x = heading 0 for blue, −x = heading π for red). */
function goalHeading(a: Alliance): number {
  return accelSide(a) > 0 ? 0 : Math.PI;
}

/**
 * TURRETLESS AIM ASSIST (drum / dumper). While the MANUAL fire button is held, steer the
 * whole robot to face its goal — the fire button turns the robot, THEN it shoots (see the
 * fire gate in updateChain). Returns a `rotate` command override, or null to leave the
 * player's rotation alone (turret, or auto-fire, which fires opportunistically without
 * hijacking the driver's heading). Called from `chainStep` BEFORE the drivetrain model.
 */
export function chainAimAssist(r: RobotState, cmd: RobotCommand | undefined, enabled: boolean): number | null {
  const mode = r.spec.scoreMode ?? CHAIN_DEFAULT_SCORE_MODE;
  if (mode !== 'drum' && mode !== 'dumper') return null;
  if (!enabled || !(cmd?.fire ?? false)) return null; // only the manual button steers
  const err = wrapAngle(goalHeading(r.alliance) - r.heading);
  return clamp(err * CHAIN_AIM_GAIN, -1, 1);
}

/**
 * Fire a PARALLEL LINE of `count` particles across the robot's width toward its goal.
 * The launcher is fixed to the chassis (no turret), so every ball leaves along the robot's
 * FORWARD heading (aim comes from the robot turning to face the goal) — they travel
 * parallel, NOT converging on a point. `speed` is the base horizontal launch speed;
 * `sideVar` (dumper catapult) makes balls stored on opposite sides leave at ± that
 * fraction of the speed ⇒ scatter. The arc is solved so each is still airborne crossing
 * the wall plane (the tall over-field opening). Deterministic (no RNG).
 */
function launchLine(
  world: World,
  chain: ChainState,
  r: RobotState,
  count: number,
  speed: number,
  sideVar: number,
): void {
  if (count <= 0) return;
  const side = accelSide(r.alliance);
  const hw = r.spec.width / 2;
  const hl = r.spec.length / 2;
  const fwd = { x: dcos(r.heading), y: dsin(r.heading) };
  const wall = side * CHAIN_HALF_X;
  for (let i = 0; i < count; i++) {
    const frac = count > 1 ? i / (count - 1) - 0.5 : 0; // −0.5..0.5 across the width line
    const w = rot({ x: hl, y: frac * 2 * hw * CHAIN_LAUNCH_LINE_FRAC }, r.heading);
    const px = r.pos.x + w.x;
    const py = r.pos.y + w.y;
    const spd = speed * (1 + sideVar * (frac * 2)); // frac*2 ∈ [−1,1] — catapult side variance
    const vx = fwd.x * spd;
    const vy = fwd.y * spd;
    // arc: solve vz so z(tWall) = z0 (still airborne crossing the wall — a lob into the tall goal)
    const vhx = Math.max(1, Math.abs(vx));
    const tWall = Math.max(0.05, Math.abs(wall - px) / vhx);
    world.balls.push({
      id: chain.nextBallId++,
      color: 'green',
      state: { kind: 'flight', target: r.alliance },
      pos: { x: px, y: py },
      vel: { x: vx, y: vy },
      z: CHAIN_LAUNCH_Z0,
      vz: 0.5 * C.GRAVITY * tWall,
    });
  }
}

/** a HUMAN retrieves a missed particle at the wall and throws it back into the field
 * (tossed inward from where it hit; FOR NOW — this rule may change). */
function throwBack(b: Artifact, side: -1 | 1, rand: () => number): Artifact {
  b.state = { kind: 'ground' };
  b.z = 0;
  b.vz = 0;
  b.pos.x = side * (CHAIN_HALF_X - CHAIN_PARTICLE_R);
  b.pos.y = clamp(b.pos.y, -(CHAIN_HALF_Y - CHAIN_PARTICLE_R), CHAIN_HALF_Y - CHAIN_PARTICLE_R);
  const spd = CHAIN_THROWBACK_SPEED * (0.7 + rand() * 0.6);
  b.vel.x = -side * spd;
  b.vel.y = (rand() - 0.5) * CHAIN_THROWBACK_SPREAD;
  return b;
}

/** move `v` toward `target` by at most `step` */
function approach(v: number, target: number, step: number): number {
  if (v < target) return Math.min(v + step, target);
  return Math.max(v - step, target);
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

  const intakeActive = enabled && (rob.autoIntake || (cmd?.intake ?? false));
  const cap = chainHopperCap(rob.spec);
  // CR intake DESIGN (roller / funnel / sweeper): capture every particle inside the
  // design's band, measured off the ACTUAL CHASSIS (not the collision OBB, which juts
  // forward by the DECODE intake reach) so the effective area stays ~robot-sized —
  // half-width `widthFrac`·chassis (+overhang for a deployed sweeper), from `backFrac`
  // of the chassis forward to a SMALL `reach` past the front edge. One pass swallows
  // every particle in that band at once (multi-ball throughput).
  if (intakeActive && rob.hopper.length < cap) {
    const it = CHAIN_INTAKES[rob.spec.chainIntake ?? CHAIN_DEFAULT_INTAKE];
    const hl = rob.spec.length / 2;
    const hw = rob.spec.width / 2;
    const captureZone =
      local.x > -hl * it.backFrac &&
      local.x < hl + it.reach &&
      Math.abs(local.y) < hw * it.widthFrac + it.overhang;
    if (captureZone) return 'absorbed';
  }

  // plow (not intaking, or no room): only for particles actually inside the footprint
  const inBox = local.x < e.front + r2 && local.x > -e.rear - r2 && Math.abs(local.y) < e.half + r2;
  if (!inBox) return 'none';

  // push out along the min-penetration axis (robot-local), impart robot vel
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
