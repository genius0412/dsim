/**
 * Headless smoke test of the sim core: drives, shoots (incl. on the move),
 * opens the gate, and checks scoring math. Run with: npx tsx scripts/smoke.ts
 */
import { createWorld, DEFAULT_ASSISTS, DEFAULT_SPEC } from '../src/sim/spawn';
import { step } from '../src/sim/world';
import { robotInLaunchZone } from '../src/sim/robot';
import { updateHumanPlayers } from '../src/sim/humanPlayer';
import { startMatch } from '../src/sim/match';
import {
  inLaunchZone,
  gateZone,
  startPose,
  goalCenter,
  goalTriangle,
  goalFaceNormal,
  goalLineValue,
  basinFunnelTarget,
  railPos,
  classifierRect,
  baseZone,
  gateTapeSegments,
  depotSegment,
  allianceArea,
  tunnelStrip,
  loadZone,
  loadSlots,
  loadBoxSlots,
  loadPreStage,
  inRect,
} from '../src/sim/field';
import { assessMatchEnd } from '../src/sim/scoring';
import type { Alliance, GameMode, RobotCommand, RobotSpec, World } from '../src/types';
import {
  SIM_DT,
  GATE_STOP_S,
  RAIL_PITCH,
  BASIN_FLOOR_Z,
  RAMP_SURFACE_Z,
  FIELD_HALF,
  BALL_RADIUS,
  HP_INITIAL_STOCK,
  HP_PLACE_DELAY,
  BALANCE_VERSION,
} from '../src/config';
import { robotCorners, robotExtents, wheelContacts } from '../src/sim/physics';
import { driveParams } from '../src/sim/drivetrain';
import type { RobotSetup } from '../src/sim/spawn';
import { DEFAULT_BINDINGS, mergeBindings } from '../src/input/bindings';
import { quantizeCommand, localizeCommand, slimWorld, unslimWorld } from '../src/net/protocol';
import type { Artifact } from '../src/types';
import { worldHash } from '../src/net/checksum';
import {
  runRecordMatch,
  simulateReplay,
  verifyReplay,
  recordSetups,
  maxMatchTicks,
  REPLAY_FORMAT,
  type CommandSource,
} from '../src/sim/replay';
import { Room, type Client } from '../server/room';
import { computeElo, eloMode, type EloParticipant } from '../server/ranked';
import type { ServerMsg } from '../src/net/protocol';
import { dsin, dcos, dtan, datan2 } from '../src/math';
import { initPhysics } from '../src/sim/physicsEngine';

// the sim now steps a Rapier physics world (robots) — load the WASM before any
// step() runs. tsx runs this file as ESM, so top-level await is available.
await initPhysics();

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const cmd = (patch: Partial<RobotCommand>): RobotCommand => ({
  driveX: 0,
  driveY: 0,
  rotate: 0,
  intake: false,
  fire: false,
  ...patch,
});

function run(world: World, c: RobotCommand, seconds: number): void {
  const commands = new Map([[0, c]]);
  const n = Math.round(seconds / SIM_DT);
  for (let i = 0; i < n; i++) step(world, SIM_DT, commands);
}

/** legacy single-robot spawn used by most checks: robot id 0 on `alliance`,
 * default spec/assists, optionally overridden by a partial spec */
const mkWorld = (
  mode: GameMode,
  alliance: Alliance,
  seed: number,
  spec?: Partial<RobotSpec>,
): World =>
  createWorld(mode, seed, [
    {
      id: 0,
      alliance,
      spec: { ...DEFAULT_SPEC, ...spec },
      assists: { ...DEFAULT_ASSISTS },
      startIndex: 0,
    },
  ]);

const slotCount = (w: World, a: 'red' | 'blue') =>
  w.balls.filter((b) => b.state.kind === 'rail' && b.state.goal === a && !b.state.overflow)
    .length;

// ---- spawn sanity ----------------------------------------------------------
{
  const w = mkWorld('match', 'blue', 42);
  const purple = w.balls.filter((b) => b.color === 'purple').length;
  const green = w.balls.filter((b) => b.color === 'green').length;
  check('24 on-field balls at spawn (9 spike + 3 loading pre-stage per alliance)', w.balls.length === 24, `${w.balls.length}`);
  check('on-field color split 16P/8G', purple === 16 && green === 8, `${purple}P ${green}G`);
  check('hopper preloaded with 3', w.robots[0].hopper.length === 3);
  check('start pose inside launch zone', inLaunchZone(w.robots[0].pos, 'blue'));
  const pose = startPose('blue', 0);
  check(
    'start pose heading comes from START_POSES degrees',
    Math.abs(w.robots[0].heading - pose.heading) < 1e-9,
    `${(w.robots[0].heading * 180 / Math.PI).toFixed(1)}°`,
  );
  check('blue goal is far-left (cross-court)', goalCenter('blue').x < 0 && goalCenter('blue').y > 0);
  check('red goal is far-right', goalCenter('red').x > 0 && goalCenter('red').y > 0);
}

// ---- field markings geometry (manual Section 9) ----------------------------
{
  // gate-zone marking: two parallel 10in tape LINES, 2.75in apart, running
  // perpendicular to the wall (constant y), centered on the gate
  let tapeOk = true;
  for (const a of ['red', 'blue'] as const) {
    const [s0, s1] = gateTapeSegments(a);
    for (const [p0, p1] of [s0, s1]) {
      if (Math.abs(Math.abs(p1.x - p0.x) - 10) > 1e-9) tapeOk = false; // 10in into the field
      if (Math.abs(p1.y - p0.y) > 1e-9) tapeOk = false; // runs ⟂ to the wall (constant y)
      if (Math.abs(Math.abs(p0.x) - (FIELD_HALF - 6)) > 1e-9) tapeOk = false; // starts at classifier edge (66)
    }
    if (Math.abs(Math.abs(s0[0].y - s1[0].y) - 2.75) > 1e-9) tapeOk = false; // 2.75in apart
  }
  check('gate tape: two 10in lines 2.75in apart, starting at the classifier edge', tapeOk);

  // depot tape runs flush ALONG the goal face from the far-wall corner to the
  // classifier edge (it must NOT run through the classifier to the side wall)
  const [d0, d1] = depotSegment('blue');
  const tri = goalTriangle('blue');
  check(
    'depot tape starts flush at the goal face far-wall corner',
    Math.hypot(d0.x - tri[0].x, d0.y - tri[0].y) < 1e-9,
  );
  check(
    'depot tape lies flush on the goal face (both ends, perp dist ~0)',
    Math.abs(goalLineValue(d0, 'blue')) < 1e-9 && Math.abs(goalLineValue(d1, 'blue')) < 1e-9,
  );
  check(
    'depot tape ends at the classifier edge, not the side wall',
    Math.abs(Math.abs(d1.x) - (FIELD_HALF - 6)) < 1e-9,
    `end x=${d1.x.toFixed(1)}`,
  );

  // alliance areas: fully outside the field, 96 along wall from the audience end
  let areaOk = true;
  for (const a of ['red', 'blue'] as const) {
    const r = allianceArea(a);
    const outside = Math.min(Math.abs(r.x0), Math.abs(r.x1)) >= FIELD_HALF - 1e-9;
    const span = r.y1 - r.y0;
    if (!outside || Math.abs(span - 96) > 1e-9 || r.y0 !== -FIELD_HALF) areaOk = false;
  }
  check('alliance areas: 96x54 outside the walls, flush with the audience end', areaOk);

  // secret tunnel tape length + width (manual: ~46.5 x ~6.125)
  const ts = tunnelStrip('blue');
  check('secret tunnel strip is TUNNEL_STRIP_LEN long', Math.abs(ts.y1 - ts.y0 - 46.5) < 1e-9, `${(ts.y1 - ts.y0).toFixed(1)} in`);
  check('secret tunnel strip is ~6.125in wide', Math.abs(ts.x1 - ts.x0 - 6.125) < 1e-9, `${(ts.x1 - ts.x0).toFixed(3)} in`);

  // GOAL footprint: right triangle in the corner, 26.5in along the far wall,
  // 18.3in down the side wall (manual "Top View Goal Opening Inside Dimensions")
  for (const a of ['red', 'blue'] as const) {
    const [far, side, corner] = goalTriangle(a);
    // corner is the right angle, on both walls
    const cornerOk = Math.abs(Math.abs(corner.x) - FIELD_HALF) < 1e-9 && Math.abs(corner.y - FIELD_HALF) < 1e-9;
    const farLeg = Math.hypot(far.x - corner.x, far.y - corner.y); // along the far wall
    const sideLeg = Math.hypot(side.x - corner.x, side.y - corner.y); // down the side wall
    check(
      `${a} goal: 26.5in far-wall leg / 18.3in side-wall leg, right-angle in the corner`,
      cornerOk && Math.abs(farLeg - 26.5) < 1e-9 && Math.abs(sideLeg - 18.3) < 1e-9,
      `far=${farLeg.toFixed(1)} side=${sideLeg.toFixed(1)}`,
    );
  }
  // goal face normal is a unit vector pointing into the field (not 45°)
  const n = goalFaceNormal('blue');
  check(
    'goal face normal is unit and points into the field',
    Math.abs(Math.hypot(n.x, n.y) - 1) < 1e-9 && n.x > 0 && n.y < 0 && Math.abs(n.x - Math.SQRT1_2) > 1e-3,
    `(${n.x.toFixed(3)},${n.y.toFixed(3)})`,
  );
  // BASE ZONE: 18x18, diagonally opposite corners (d*24,-48) and (d*42,-30)
  let baseOk = true;
  for (const a of ['red', 'blue'] as const) {
    const bz = baseZone(a);
    const d = a === 'blue' ? 1 : -1; // driver side (blue +x, red -x)
    const xs = [bz.x0, bz.x1].map((x) => x).sort((p, q) => p - q);
    const want = [d * 24, d * 42].sort((p, q) => p - q);
    if (Math.abs(xs[0] - want[0]) > 1e-9 || Math.abs(xs[1] - want[1]) > 1e-9) baseOk = false;
    if (Math.abs(bz.y0 - -48) > 1e-9 || Math.abs(bz.y1 - -30) > 1e-9) baseOk = false;
  }
  check('base zone: 18x18 corners at (d*24,-48) & (d*42,-30)', baseOk);

  // goalLineValue: >0 behind the face (in the corner), <0 in front (field side)
  const [, , blueCorner] = goalTriangle('blue');
  check(
    'goalLineValue: corner is behind the face, field center is in front',
    goalLineValue(blueCorner, 'blue') > 0 && goalLineValue({ x: 0, y: 0 }, 'blue') < 0,
    `corner=${goalLineValue(blueCorner, 'blue').toFixed(1)} center=${goalLineValue({ x: 0, y: 0 }, 'blue').toFixed(1)}`,
  );
}

// ---- driving: forward vs strafe ratio -------------------------------------
{
  const w = mkWorld('free', 'blue', 7);
  const r = w.robots[0];
  r.pos = { x: 0, y: 0 };
  r.heading = Math.PI / 2;
  r.fieldCentric = false;
  run(w, cmd({ driveY: 1 }), 0.8);
  const fwd = r.pos.y;

  const w2 = mkWorld('free', 'blue', 7);
  const r2 = w2.robots[0];
  r2.pos = { x: 0, y: 0 };
  r2.heading = Math.PI / 2;
  r2.fieldCentric = false;
  run(w2, cmd({ driveX: 1 }), 0.8);
  const strafe = Math.abs(r2.pos.x);
  const ratio = strafe / fwd;
  check('strafe slower than forward (~0.8x)', ratio > 0.7 && ratio < 0.95, `ratio=${ratio.toFixed(3)}`);
}

// ---- wall contact squares the robot up --------------------------------------
{
  const w = mkWorld('free', 'blue', 3);
  const r = w.robots[0];
  r.pos = { x: 0, y: 50 };
  r.heading = Math.PI / 2 + 0.3; // tilted ~17° while driving at the far wall
  r.fieldCentric = false;
  run(w, cmd({ driveY: 1 }), 2.5);
  const misalign = Math.abs(((r.heading - Math.PI / 2 + Math.PI) % Math.PI) - Math.PI);
  const err = Math.min(Math.abs(misalign), Math.abs(Math.abs(misalign) - Math.PI));
  check('driving tilted into a wall straightens the robot', err < 0.08, `residual=${err.toFixed(3)} rad`);
}

// ---- contact torque scales with speed: a fast hit squares up fast ---------------
{
  const w = mkWorld('free', 'blue', 4);
  const r = w.robots[0];
  r.pos = { x: 0, y: 25 }; // long run-up: reaches full speed before the far wall
  r.heading = Math.PI / 2 + 0.35; // ~20° tilt
  r.fieldCentric = false;
  run(w, cmd({ driveY: 1 }), 1.2);
  const misalign = Math.abs(((r.heading - Math.PI / 2 + Math.PI) % Math.PI) - Math.PI);
  const err = Math.min(Math.abs(misalign), Math.abs(Math.abs(misalign) - Math.PI));
  check(
    'full-speed wall hit swings the robot flush quickly',
    err < 0.05,
    `residual=${err.toFixed(3)} rad after 1.2s incl. run-up`,
  );
  // keep shoving for another 0.5s: the settled heading must not buzz
  let hMin = Infinity;
  let hMax = -Infinity;
  const commands = new Map([[0, cmd({ driveY: 1 })]]);
  for (let i = 0; i < Math.round(0.5 / SIM_DT); i++) {
    step(w, SIM_DT, commands);
    hMin = Math.min(hMin, r.heading);
    hMax = Math.max(hMax, r.heading);
  }
  check(
    'no heading oscillation while squared against the wall',
    hMax - hMin < 0.01,
    `jitter=${(hMax - hMin).toFixed(4)} rad`,
  );
}

// ---- Rapier containment: full-speed wall drive never tunnels ----------------
{
  const w = mkWorld('free', 'blue', 33);
  const r = w.robots[0];
  r.pos = { x: 0, y: 0 }; // center column: the far wall at x=0 is clear of goals
  r.heading = Math.PI / 2; // +y forward
  r.fieldCentric = false;
  run(w, cmd({ driveY: 1 }), 3); // slam the far (+y) wall for 3s
  const front = robotExtents(r).front;
  // soft contacts allow a sub-half-inch steady penetration (invisible at field
  // scale); the point of the check is that it can't tunnel THROUGH the wall
  const inField = robotCorners(r).every(
    (c) => Math.abs(c.x) <= FIELD_HALF + 0.6 && Math.abs(c.y) <= FIELD_HALF + 0.6,
  );
  check(
    'full-speed wall drive is contained (no tunneling, front edge at the wall)',
    inField && r.pos.y + front <= FIELD_HALF + 0.6 && r.pos.y + front > FIELD_HALF - 2,
    `frontEdge=${(r.pos.y + front).toFixed(2)} wall=${FIELD_HALF}`,
  );
}

// ---- a wheel wedged in the classifier is evicted (no wall fight) ----------------
{
  const w = mkWorld('free', 'blue', 8);
  const r = w.robots[0];
  // left-front corner lands at (-71, 1): 1" off the wall, inside the blue
  // channel — the nearest eviction is THROUGH the wall, which must be refused
  r.pos = { x: -62, y: -11 };
  r.heading = Math.PI / 2;
  r.fieldCentric = false;
  r.vel = { x: 0, y: 0 };
  run(w, cmd({}), 1);
  const rect = classifierRect('blue');
  const stuck = robotCorners(r).some(
    (c) => c.x > rect.x0 && c.x < rect.x1 && c.y > rect.y0 && c.y < rect.y1,
  );
  check('wheel wedged in the classifier gets evicted', !stuck, `pos=(${r.pos.x.toFixed(1)},${r.pos.y.toFixed(1)})`);
  run(w, cmd({ driveY: -1 }), 1);
  check('robot drives free after the eviction', r.pos.y < -25, `y=${r.pos.y.toFixed(1)}`);
}

// ---- pinned ball resists the robot ------------------------------------------
{
  const w = mkWorld('free', 'blue', 21);
  const r = w.robots[0];
  r.pos = { x: 0, y: 45 };
  r.heading = Math.PI / 2; // facing the far wall
  r.fieldCentric = false;
  const ball = w.balls[0];
  ball.state = { kind: 'ground' };
  ball.pos = { x: 0, y: FIELD_HALF - BALL_RADIUS }; // resting against the far wall
  ball.vel = { x: 0, y: 0 };
  ball.z = 0;
  ball.vz = 0;
  run(w, cmd({ driveY: 1 }), 2.5); // grind straight into the pinned ball
  const front = robotExtents(r).front;
  const ballSpeed = Math.hypot(ball.vel.x, ball.vel.y);
  const robotSpeed = Math.hypot(r.vel.x, r.vel.y);
  check(
    'wall-pinned ball stalls the robot (no grind-through)',
    r.pos.y + front < FIELD_HALF - 2 * BALL_RADIUS + 0.5,
    `front edge y=${(r.pos.y + front).toFixed(1)}`,
  );
  check('robot stalled against the pinned ball', robotSpeed < 5, `v=${robotSpeed.toFixed(1)}`);
  check(
    'pinned ball stays put, in-field, no energy blow-up',
    Math.abs(ball.pos.x) < 6 && ball.pos.y <= FIELD_HALF - BALL_RADIUS + 0.01 && ballSpeed < 20,
    `pos=(${ball.pos.x.toFixed(1)},${ball.pos.y.toFixed(1)}) v=${ballSpeed.toFixed(1)}`,
  );
}

// ---- off-center wall ball scatters out of the way -----------------------------
{
  const w = mkWorld('free', 'blue', 22);
  const r = w.robots[0];
  r.pos = { x: 0, y: 45 };
  r.heading = Math.PI / 2;
  r.fieldCentric = false;
  const half = r.spec.width / 2;
  const ball = w.balls[0];
  ball.state = { kind: 'ground' };
  ball.pos = { x: half + 1.5, y: FIELD_HALF - BALL_RADIUS }; // at the corner's path
  ball.vel = { x: 0, y: 0 };
  ball.z = 0;
  ball.vz = 0;
  const startX = ball.pos.x;
  run(w, cmd({ driveY: 1 }), 2.5);
  check(
    'corner-hit wall ball squirts out sideways',
    ball.pos.x > startX + 4 && Math.abs(ball.pos.x) <= FIELD_HALF - BALL_RADIUS + 0.01,
    `x ${startX.toFixed(1)} -> ${ball.pos.x.toFixed(1)}`,
  );
  check('robot drove on once the ball escaped', r.pos.y > 52, `y=${r.pos.y.toFixed(1)}`);
}

// ---- open-field push still moves balls easily ---------------------------------
{
  const w = mkWorld('free', 'blue', 23);
  const r = w.robots[0];
  r.pos = { x: 0, y: -20 };
  r.heading = Math.PI / 2;
  r.fieldCentric = false;
  const ball = w.balls[0];
  ball.state = { kind: 'ground' };
  ball.pos = { x: 0, y: 0 };
  ball.vel = { x: 0, y: 0 };
  ball.z = 0;
  ball.vz = 0;
  run(w, cmd({ driveY: 1 }), 1);
  const dist = Math.hypot(ball.pos.x, ball.pos.y);
  check('open-field push sends the ball rolling', dist > 20, `moved ${dist.toFixed(1)} in`);
}

// ---- launch zone: robot straddling the wedge APEX is IN (OBB overlap, not just
//      corners — the wedge narrows to a point at field center, so all four corners
//      can sit outside both diagonals while the body covers the zone) -------------
{
  const w = mkWorld('free', 'blue', 30);
  const r = w.robots[0];
  r.heading = -Math.PI / 2; // intake points -y, AWAY from the wedge (can't help)
  r.pos = { x: 0, y: -5 }; // body straddles the apex (0,0); no corner is inside
  const cornersIn = robotCorners(r).some((c) => inLaunchZone(c, 'blue'));
  check(
    'robot straddling the launch-wedge apex counts as in-zone (no corner inside)',
    robotInLaunchZone(r) && !cornersIn,
    `result=${robotInLaunchZone(r)} anyCornerIn=${cornersIn}`,
  );
  // sanity: a robot parked in a far corner (well outside both zones) is OUT
  r.pos = { x: 60, y: -60 };
  r.heading = 0;
  check('robot in a far corner is NOT in a launch zone', !robotInLaunchZone(r));
}

// ---- Rapier ground balls: ball-ball separation (no robot involved) -------------
{
  const w = mkWorld('free', 'blue', 24);
  w.robots[0].pos = { x: 60, y: -60 }; // park the robot far from the balls
  const a = w.balls[0];
  const b = w.balls[1];
  for (const bb of [a, b]) {
    bb.state = { kind: 'ground' };
    bb.z = 0;
    bb.vz = 0;
    bb.vel = { x: 0, y: 0 };
  }
  a.pos = { x: -2, y: 0 };
  b.pos = { x: 2, y: 0 }; // overlapping (centers 4in < 5in diameter)
  run(w, cmd({}), 0.5);
  const sep = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
  // started 4in apart (overlapping); Rapier pushes them out to ~contact distance
  // (a small residual < BALL_RADIUS is the soft-contact steady penetration, the
  // same slack robots rest at — the point is they separated, no explosion)
  check(
    'Rapier separates two overlapping ground balls (ball-ball contact)',
    sep >= 2 * BALL_RADIUS - 0.5 && sep < 2 * BALL_RADIUS + 1 && Number.isFinite(sep),
    `sep=${sep.toFixed(2)} in`,
  );
}

// ---- Rapier ground ball never tunnels a wall (hard clamp holds) ----------------
{
  const w = mkWorld('free', 'blue', 25);
  w.robots[0].pos = { x: -60, y: -60 };
  const ball = w.balls[0];
  ball.state = { kind: 'ground' };
  ball.pos = { x: 0, y: FIELD_HALF - 8 };
  ball.vel = { x: 0, y: 400 }; // fired hard at the far wall
  ball.z = 0;
  ball.vz = 0;
  run(w, cmd({}), 0.5);
  check(
    'fast ground ball stays inside the wall (no tunnel past the clamp)',
    ball.pos.y <= FIELD_HALF - BALL_RADIUS + 0.02 && Number.isFinite(ball.pos.y),
    `y=${ball.pos.y.toFixed(3)}`,
  );
}

// ---- Rapier ground-ball physics is deterministic across replays ----------------
{
  const mk = (): World => {
    const w = mkWorld('free', 'blue', 26);
    w.robots[0].pos = { x: 55, y: 55 };
    const a = w.balls[0];
    const b = w.balls[1];
    a.state = { kind: 'ground' }; a.pos = { x: -20, y: 0 }; a.vel = { x: 120, y: 0 }; a.z = 0; a.vz = 0;
    b.state = { kind: 'ground' }; b.pos = { x: 20, y: 0 }; b.vel = { x: -120, y: 0 }; b.z = 0; b.vz = 0;
    return w;
  };
  const w1 = mk();
  const w2 = mk();
  for (let i = 0; i < 300; i++) { step(w1, SIM_DT, new Map()); step(w2, SIM_DT, new Map()); }
  check(
    'ground-ball collisions are bit-for-bit deterministic across two replays',
    worldHash(w1) === worldHash(w2),
    `${worldHash(w1)} vs ${worldHash(w2)}`,
  );
}

// ---- driver-side view frames ------------------------------------------------
{
  // blue driver stands at the RIGHT wall: stick-up must drive toward -x
  const wb = mkWorld('free', 'blue', 7);
  wb.robots[0].pos = { x: 0, y: 0 };
  wb.robots[0].fieldCentric = true;
  run(wb, cmd({ driveY: 1 }), 1);
  check('blue field-centric stick-up drives toward -x (away from blue wall)', wb.robots[0].pos.x < -10, `x=${wb.robots[0].pos.x.toFixed(1)}`);

  // red driver stands at the LEFT wall: stick-up must drive toward +x
  const wr = mkWorld('free', 'red', 7);
  wr.robots[0].pos = { x: 0, y: 0 };
  wr.robots[0].fieldCentric = true;
  run(wr, cmd({ driveY: 1 }), 1);
  check('red field-centric stick-up drives toward +x (away from red wall)', wr.robots[0].pos.x > 10, `x=${wr.robots[0].pos.x.toFixed(1)}`);
}

// ---- shooting & visible classification -------------------------------------
{
  const w = mkWorld('match', 'blue', 42);
  startMatch(w);
  const r = w.robots[0];
  r.pos = { x: 10, y: 40 }; // launch zone, mid-range to the blue goal (-60,60)
  run(w, cmd({ fire: true }), 0.5); // instant burst: 3 preloads in ~0.3s
  const inTransit = w.balls.filter((b) => b.state.kind === 'flight' || b.state.kind === 'basin').length;
  check('burst fire emptied hopper in ~0.3s', r.hopper.length === 0, `hopper=${r.hopper.length}`);
  check('balls travel visibly (flight/basin, no teleport)', inTransit > 0, `${inTransit} in transit`);
  run(w, cmd({}), 6); // land, jumble in the basin, funnel onto the rail
  const g = w.goals.blue;
  const s = w.match.scores.blue;
  check('shots settled into ramp slots', slotCount(w, 'blue') >= 2, `slots=${slotCount(w, 'blue')} classified=${g.classifiedCount} overflow=${g.overflowCount}`);
  check('classified points = 3 each', s.autoClassified === g.classifiedCount * 3, `${s.autoClassified} pts`);
}

// ---- shooting on the move ----------------------------------------------------
{
  const w = mkWorld('match', 'blue', 99);
  startMatch(w);
  const r = w.robots[0];
  r.pos = { x: 20, y: 50 };
  run(w, cmd({ fire: true, driveX: 0.6 }), 1); // strafing while firing
  run(w, cmd({}), 6);
  const g = w.goals.blue;
  check('shooting on the move still scores (lead compensation)', g.classifiedCount + g.overflowCount >= 2, `entered=${g.classifiedCount + g.overflowCount}`);
}

// ---- intake -----------------------------------------------------------------
{
  const w = mkWorld('free', 'blue', 42);
  const r = w.robots[0];
  r.hopper = [];
  // blue spike column is on the blue (right) side at x=+46
  r.pos = { x: 46, y: -55 };
  r.heading = Math.PI / 2;
  r.fieldCentric = false;
  run(w, cmd({ driveY: 0.6, intake: true }), 3);
  check('intake collected balls from the spike column', r.hopper.length > 0, `hopper=${r.hopper.length}`);
  check('hopper capped at 3', r.hopper.length <= 3);
}

// ---- vector intake: strafing into a ball swallows it (wheels overhang) ----------
{
  const spec = { length: 11.5, width: 14, intake: 'vector' as const };
  const w = mkWorld('free', 'blue', 6, spec);
  const r = w.robots[0];
  r.hopper = [];
  r.pos = { x: 0, y: 0 };
  r.heading = Math.PI / 2;
  r.fieldCentric = false;
  const ball = w.balls[0];
  w.balls.splice(1); // only this ball on the field
  ball.state = { kind: 'ground' };
  ball.pos = { x: -12, y: 8 }; // beside the protruding intake's flank
  ball.vel = { x: 0, y: 0 };
  ball.z = 0;
  ball.vz = 0;
  run(w, cmd({ driveX: -1, intake: true }), 1); // strafe into it
  check('vector intake grabs a ball it strafes into', r.hopper.length === 1, `hopper=${r.hopper.length}`);
}

// ---- sloped intake: the same maneuver only shoves the ball ---------------------
{
  const w = mkWorld('free', 'blue', 6);
  const r = w.robots[0];
  r.hopper = [];
  r.pos = { x: 0, y: 0 };
  r.heading = Math.PI / 2;
  r.fieldCentric = false;
  const ball = w.balls[0];
  w.balls.splice(1); // only this ball on the field
  ball.state = { kind: 'ground' };
  ball.pos = { x: -12, y: 8 };
  ball.vel = { x: 0, y: 0 };
  ball.z = 0;
  ball.vz = 0;
  run(w, cmd({ driveX: -1, intake: true }), 1);
  check('sloped intake has no side capture', r.hopper.length === 0, `hopper=${r.hopper.length}`);
}

// ---- side capture is geometric: a full-width chassis encompasses the wheels -----
{
  const spec = { length: 11.5, width: 18, intake: 'vector' as const };
  const w = mkWorld('free', 'blue', 6, spec);
  const r = w.robots[0];
  r.hopper = [];
  r.pos = { x: 0, y: 0 };
  r.heading = Math.PI / 2;
  r.fieldCentric = false;
  const ball = w.balls[0];
  w.balls.splice(1);
  ball.state = { kind: 'ground' };
  ball.pos = { x: -12, y: 8 };
  ball.vel = { x: 0, y: 0 };
  ball.z = 0;
  ball.vz = 0;
  // short window: long strafes may legitimately roll the ball around the
  // front corner into the mouth — the flank itself must never capture
  run(w, cmd({ driveX: -1, intake: true }), 0.35);
  check(
    '18" chassis encompasses the vector wheels — no side capture',
    r.hopper.length === 0,
    `hopper=${r.hopper.length}`,
  );
}

// ---- sloped/triangle devour clumps at the mouth ----------------------------------
{
  const w = mkWorld('free', 'blue', 6);
  const r = w.robots[0];
  r.hopper = [];
  r.pos = { x: 0, y: 0 };
  r.heading = Math.PI / 2;
  r.fieldCentric = false;
  r.vel = { x: 0, y: 0 };
  // three balls clumped just ahead of the mouth (touching the intake tip —
  // not center-on the face, which would eject them via the deep-overlap path)
  w.balls.splice(3);
  const clumpY = r.spec.length / 2 + 3 + 2; // wheel line + shallow contact
  [-5.1, 0, 5.1].forEach((off, i) => {
    const b = w.balls[i];
    b.state = { kind: 'ground' };
    b.pos = { x: -off, y: clumpY }; // local y=off at heading π/2
    b.vel = { x: 0, y: 0 };
    b.z = 0;
    b.vz = 0;
  });
  run(w, cmd({ intake: true }), 0.2); // steady pace would only manage 2
  check(
    'sloped intake devours a clump (3 balls in 0.2s)',
    r.hopper.length === 3,
    `hopper=${r.hopper.length}`,
  );
}

// ---- triangle intake transfers (outtakes) slower ---------------------------------
{
  const spec = { length: 12, width: 14, intake: 'triangle' as const };
  const w = mkWorld('free', 'blue', 6, spec);
  const r = w.robots[0];
  r.pos = { x: 10, y: 40 };
  run(w, cmd({ fire: true }), 0.5); // sloped/vector would empty 3 preloads in ~0.3s
  check(
    'triangle intake fires slower (0.3s transfer)',
    r.hopper.length === 1,
    `hopper=${r.hopper.length} after 0.5s burst`,
  );
}

// ---- gate release --------------------------------------------------------------
{
  const w = mkWorld('match', 'blue', 42);
  startMatch(w);
  const r = w.robots[0];
  r.pos = { x: 10, y: 40 };
  run(w, cmd({ fire: true }), 0.5);
  run(w, cmd({}), 6);
  const ramped = slotCount(w, 'blue');
  const zone = gateZone('blue');
  r.pos = { x: zone.x1 + 7, y: (zone.y0 + zone.y1) / 2 };
  r.heading = Math.PI;
  r.vel = { x: 0, y: 0 };
  run(w, cmd({}), 4);
  check('gate opened and released ramp balls', slotCount(w, 'blue') < ramped, `slots ${ramped} -> ${slotCount(w, 'blue')}`);
  const groundBalls = w.balls.filter((b) => b.state.kind === 'ground').length;
  check('released balls rolled out onto the field', groundBalls >= 21 + ramped - 1, `${groundBalls} ground`);
}

// ---- gate tap: flow holds the gate open ----------------------------------------
{
  const w = mkWorld('match', 'blue', 42);
  startMatch(w);
  const r = w.robots[0];
  r.pos = { x: 10, y: 40 };
  run(w, cmd({ fire: true }), 0.5);
  run(w, cmd({}), 6);
  const ramped = slotCount(w, 'blue');
  const zone = gateZone('blue');
  r.pos = { x: zone.x1 + 7, y: (zone.y0 + zone.y1) / 2 };
  r.vel = { x: 0, y: 0 };
  run(w, cmd({}), 0.3); // tap...
  r.pos = { x: 0, y: -30 }; // ...and drive away immediately
  run(w, cmd({}), 4);
  check('tapped gate kept draining (flow holds it open)', ramped >= 2 && slotCount(w, 'blue') === 0, `slots ${ramped} -> ${slotCount(w, 'blue')}`);
  check('gate re-closed after the column cleared', !w.goals.blue.gateOpen);
}

// fill the blue rail with 9 retained balls by direct placement (bypasses
// scoring — counters stay 0)
function fillBlueRail(w: World): void {
  for (let i = 0; i < 9; i++) {
    const b = w.balls[i];
    const s = GATE_STOP_S + i * RAIL_PITCH;
    b.state = { kind: 'rail', goal: 'blue', s, v: 0, overflow: false };
    b.pos = railPos('blue', s);
    b.vel = { x: 0, y: 0 };
    b.z = RAMP_SURFACE_Z;
    b.vz = 0;
  }
}

// drop a 10th ball into the blue basin right at the funnel entrance
function queueTenth(w: World): void {
  const tenth = w.balls[9];
  tenth.state = { kind: 'basin', goal: 'blue' };
  tenth.pos = basinFunnelTarget('blue');
  tenth.vel = { x: 0, y: 0 };
  tenth.z = BASIN_FLOOR_Z;
  tenth.vz = 0;
}

// ---- overflow decided at contact: full column + closed gate ---------------------
{
  const w = mkWorld('match', 'blue', 42);
  startMatch(w);
  fillBlueRail(w);
  queueTenth(w);
  run(w, cmd({}), 3);
  const g = w.goals.blue;
  check(
    '10th ball meeting a full column overflows (1 pt)',
    g.overflowCount === 1 && g.classifiedCount === 0 && w.match.scores.blue.autoOverflow === 1,
    `classified=${g.classifiedCount} overflow=${g.overflowCount}`,
  );
  check('overflow ball rode over the closed gate and exited', w.balls[9].state.kind === 'ground');
}

// ---- overflow decided at contact: gate cleared in time -> classified -------------
{
  const w = mkWorld('match', 'blue', 42);
  startMatch(w);
  fillBlueRail(w);
  // tap the gate, drive away — the column starts draining
  const r = w.robots[0];
  const zone = gateZone('blue');
  r.pos = { x: zone.x1 + 7, y: (zone.y0 + zone.y1) / 2 };
  r.vel = { x: 0, y: 0 };
  run(w, cmd({}), 0.3); // tap...
  r.pos = { x: 0, y: -30 };
  run(w, cmd({}), 0.7);
  // a late ball arrives while the drain is under way: by the time it reaches
  // the column there are fewer than 9 below it, so it must classify
  queueTenth(w);
  run(w, cmd({}), 5);
  const g = w.goals.blue;
  check(
    'ball arriving during a gate drain classifies (3 pts, not overflow)',
    g.overflowCount === 0 && g.classifiedCount === 1 && w.match.scores.blue.autoClassified === 3,
    `classified=${g.classifiedCount} overflow=${g.overflowCount} pts=${w.match.scores.blue.autoClassified}`,
  );
}

// ---- gate outflow stops against a parked robot instead of shoving it ------------
{
  const w = mkWorld('match', 'blue', 42);
  startMatch(w);
  fillBlueRail(w);
  // robot parked square across the tunnel exit path (as when intaking the drain)
  const r = w.robots[0];
  r.pos = { x: -63, y: -14 };
  r.heading = Math.PI / 2; // front (intake) faces the oncoming flow
  r.vel = { x: 0, y: 0 };
  const start = { x: r.pos.x, y: r.pos.y };
  w.goals.blue.gateOpen = true; // flow keeps it open while balls stream out
  run(w, cmd({}), 4);
  const moved = Math.hypot(r.pos.x - start.x, r.pos.y - start.y);
  const strays = w.balls.filter(
    (b) => b.state.kind === 'ground' && Math.abs(b.pos.x) > FIELD_HALF - BALL_RADIUS + 0.01,
  ).length;
  check('gate outflow cannot shove the parked robot', moved < 1.5, `moved ${moved.toFixed(2)} in`);
  check('blocked outflow stays in the field', strays === 0, `${strays} out of bounds`);
}

// ---- point-blank shots never miss ------------------------------------------------
{
  const w = mkWorld('match', 'blue', 11);
  startMatch(w);
  const r = w.robots[0];
  r.pos = { x: -44, y: 54 }; // right up against the blue goal face
  r.vel = { x: 0, y: 0 };
  run(w, cmd({ fire: true }), 0.5);
  run(w, cmd({}), 6);
  const g = w.goals.blue;
  check('point-blank shots all enter the goal', g.classifiedCount + g.overflowCount === 3, `entered=${g.classifiedCount + g.overflowCount}`);

  const w2 = mkWorld('match', 'blue', 12);
  startMatch(w2);
  const r2 = w2.robots[0];
  r2.pos = { x: 30, y: 35 }; // long cross-court shot
  run(w2, cmd({ fire: true }), 0.5);
  run(w2, cmd({}), 6);
  const g2 = w2.goals.blue;
  check('long shots all enter the goal', g2.classifiedCount + g2.overflowCount === 3, `entered=${g2.classifiedCount + g2.overflowCount}`);
}

// ---- auto intake & auto fire ----------------------------------------------------
{
  const w = mkWorld('free', 'blue', 5);
  const r = w.robots[0];
  r.hopper = [];
  r.autoIntake = true;
  r.autoFire = true;
  // drive up the blue spike column with no buttons held
  r.pos = { x: 46, y: -55 };
  r.heading = Math.PI / 2;
  r.fieldCentric = false;
  run(w, cmd({ driveY: 0.5 }), 2.5);
  run(w, cmd({}), 6);
  const g = w.goals.blue;
  check('auto intake collected without holding intake', r.hopper.length > 0 || g.classifiedCount + g.overflowCount > 0);
  check('auto fire launched without pressing fire', g.classifiedCount + g.overflowCount >= 1, `entered=${g.classifiedCount + g.overflowCount}`);
}

// ---- auto fire must NOT fire before the match starts ------------------------------
{
  const w = mkWorld('match', 'blue', 13);
  w.robots[0].autoFire = true;
  run(w, cmd({}), 2); // still in 'pre'
  check('auto fire holds until AUTO begins', w.robots[0].hopper.length === 3, `hopper=${w.robots[0].hopper.length}`);
  startMatch(w);
  run(w, cmd({}), 2);
  check('auto fire engages once AUTO starts', w.robots[0].hopper.length === 0, `hopper=${w.robots[0].hopper.length}`);
}

// ---- match flow ---------------------------------------------------------------
{
  const w = mkWorld('match', 'blue', 9);
  startMatch(w);
  run(w, cmd({ driveY: 0.5 }), 25);
  // park clearly off every launch line before the end-of-auto assessment
  w.robots[0].pos = { x: 0, y: -20 };
  w.robots[0].vel = { x: 0, y: 0 };
  w.robots[0].heading = 0;
  run(w, cmd({}), 6);
  check('auto -> transition after 30s', w.match.phase === 'transition', w.match.phase);
  run(w, cmd({}), 8.1);
  check('transition -> teleop after 8s', w.match.phase === 'teleop', w.match.phase);
  run(w, cmd({}), 120.2);
  check('teleop -> post after 2:00', w.match.phase === 'post', w.match.phase);
  check('leave scored (drove off launch lines)', w.match.scores.blue.leave === 3, `${w.match.scores.blue.leave}`);
}

// ---- base parking counts wheels on the ground, not intake overhang --------------
{
  const spec = { length: 11.5, width: 12, intake: 'vector' as const };
  const zone = baseZone('blue');
  const cx = (zone.x0 + zone.x1) / 2;
  const cy = (zone.y0 + zone.y1) / 2;

  // all four wheels inside, wide/long intake hanging out over the edge -> FULL
  const w1 = mkWorld('free', 'blue', 14, spec);
  w1.robots[0].pos = { x: cx, y: cy };
  w1.robots[0].heading = Math.PI / 2; // intake pokes out the top of the base
  assessMatchEnd(w1);
  check(
    'base FULL credit with intake overhanging (wheels all in)',
    w1.match.scores.blue.base === 10,
    `base=${w1.match.scores.blue.base}`,
  );

  // only the intake reaches into the base, wheels outside -> NO credit
  const w2 = mkWorld('free', 'blue', 14, spec);
  w2.robots[0].pos = { x: cx, y: zone.y1 + 11 };
  w2.robots[0].heading = -Math.PI / 2; // intake dips into the zone from above
  assessMatchEnd(w2);
  check(
    'intake-only overhang earns no base credit (no wheel touching)',
    w2.match.scores.blue.base === 0,
    `base=${w2.match.scores.blue.base}`,
  );

  // just ONE wheel in (parked over the inner corner) -> PARTIAL
  const w3 = mkWorld('free', 'blue', 14, spec);
  w3.robots[0].pos = { x: zone.x0, y: zone.y1 }; // one wheel dips over the corner
  w3.robots[0].heading = Math.PI / 2;
  const wheelsIn = wheelContacts(w3.robots[0]).filter((c) => inRect(c, zone)).length;
  assessMatchEnd(w3);
  check(
    'a single wheel in the base earns partial credit',
    wheelsIn === 1 && w3.match.scores.blue.base === 5,
    `wheelsIn=${wheelsIn} base=${w3.match.scores.blue.base}`,
  );
}

// ---- control bindings: validation / merge of persisted settings -----------------
{
  const clean = mergeBindings(null);
  check(
    'mergeBindings(null) yields the defaults',
    JSON.stringify(clean) === JSON.stringify(DEFAULT_BINDINGS),
  );
  const merged = mergeBindings({
    keys: { fire: ['j'], driveUp: 42, restart: ['escape'] }, // driveUp/restart invalid
    pad: { driveStick: 'right', buttons: { fire: [2], intake: 'nope' } },
  });
  check(
    'mergeBindings keeps valid overrides and repairs invalid ones',
    merged.keys.fire[0] === 'j' &&
      merged.keys.driveUp[0] === 'w' &&
      merged.keys.restart[0] === 'r' &&
      merged.pad.driveStick === 'right' &&
      merged.pad.buttons.fire[0] === 2 &&
      merged.pad.buttons.intake[0] === 6,
    JSON.stringify({ fire: merged.keys.fire, up: merged.keys.driveUp, stick: merged.pad.driveStick }),
  );
}

// ============================================================================
// Phase B: RobotSpec v2 — drivetrains, flywheel model, robot-robot physics,
// multi-robot spawn / determinism
// ============================================================================

const setup = (
  id: number,
  alliance: 'red' | 'blue',
  spec: Partial<RobotSpec>,
  startIndex = 0,
): RobotSetup => ({
  id,
  alliance,
  spec: { ...DEFAULT_SPEC, ...spec },
  assists: { ...DEFAULT_ASSISTS },
  startIndex,
});

// ---- default spec reproduces the legacy tuned feel exactly ------------------
{
  const dp = driveParams(DEFAULT_SPEC);
  check(
    'default spec drives at the legacy 75 in/s, 7 rad/s, 280 in/s²',
    Math.abs(dp.maxSpeed - 75) < 1e-6 &&
      Math.abs(dp.maxTurn - 7) < 1e-6 &&
      Math.abs(dp.accel - 280) < 1e-6,
    `${dp.maxSpeed.toFixed(2)} / ${dp.maxTurn.toFixed(2)} / ${dp.accel.toFixed(1)}`,
  );
}

// ---- top speed scales linearly with wheel RPM -------------------------------
{
  const slow = driveParams({ ...DEFAULT_SPEC, driveRpm: 300 });
  const fast = driveParams({ ...DEFAULT_SPEC, driveRpm: 600 });
  check(
    'top speed scales linearly with RPM',
    Math.abs(fast.maxSpeed / slow.maxSpeed - 2) < 1e-6,
    `${slow.maxSpeed.toFixed(1)} -> ${fast.maxSpeed.toFixed(1)}`,
  );
}

// ---- tank drivetrain has no strafe ------------------------------------------
{
  const w = mkWorld('free', 'blue', 7, { drivetrain: 'tank' });
  const r = w.robots[0];
  r.pos = { x: 0, y: 0 };
  r.heading = Math.PI / 2;
  r.fieldCentric = false;
  run(w, cmd({ driveX: 1 }), 0.8); // pure strafe command
  check('tank drivetrain cannot strafe', Math.hypot(r.pos.x, r.pos.y) < 0.5, `moved ${Math.hypot(r.pos.x, r.pos.y).toFixed(2)} in`);
}

// ---- mass-weighted shove: the heavier robot yields less ---------------------
{
  const w = createWorld('free', 7, [setup(0, 'blue', { massLb: 42 }, 0), setup(1, 'blue', { massLb: 21 }, 1)]);
  const [a, b] = w.robots;
  a.pos = { x: -5, y: 0 }; a.heading = 0; a.vel = { x: 0, y: 0 };
  b.pos = { x: 5, y: 0 }; b.heading = 0; b.vel = { x: 0, y: 0 };
  const a0 = { ...a.pos };
  const b0 = { ...b.pos };
  step(w, SIM_DT, new Map());
  const da = Math.hypot(a.pos.x - a0.x, a.pos.y - a0.y);
  const db = Math.hypot(b.pos.x - b0.x, b.pos.y - b0.y);
  check('heavier robot yields less (42 vs 21 lb ≈ 1:2 push)', Math.abs(db / da - 2) < 0.15, `da=${da.toFixed(2)} db=${db.toFixed(2)}`);
}

// ---- equal masses separate symmetrically ------------------------------------
{
  const w = createWorld('free', 7, [setup(0, 'blue', { massLb: 30 }, 0), setup(1, 'blue', { massLb: 30 }, 1)]);
  const [a, b] = w.robots;
  a.pos = { x: -5, y: 0 }; a.heading = 0; a.vel = { x: 0, y: 0 };
  b.pos = { x: 5, y: 0 }; b.heading = 0; b.vel = { x: 0, y: 0 };
  const a0 = { ...a.pos };
  const b0 = { ...b.pos };
  step(w, SIM_DT, new Map());
  const da = Math.hypot(a.pos.x - a0.x, a.pos.y - a0.y);
  const db = Math.hypot(b.pos.x - b0.x, b.pos.y - b0.y);
  check('equal-mass robots separate symmetrically', Math.abs(da - db) < 0.05, `da=${da.toFixed(2)} db=${db.toFixed(2)}`);
}

// ---- a robot squeezed by an opponent against a wall stays in-field ----------
{
  const w = createWorld('free', 3, [setup(0, 'blue', {}, 0), setup(1, 'blue', { massLb: 42 }, 1)]);
  const [a, b] = w.robots;
  a.pos = { x: 58, y: 0 }; a.heading = 0; a.vel = { x: 0, y: 0 }; a.fieldCentric = false; // pinned near +x wall
  b.pos = { x: 30, y: 0 }; b.heading = 0; b.vel = { x: 0, y: 0 }; b.fieldCentric = false; // heavy pusher
  const commands = new Map([[1, cmd({ driveY: 1 })]]); // drive B east into A
  for (let i = 0; i < Math.round(2 / SIM_DT); i++) step(w, SIM_DT, commands);
  const inField = (r: (typeof w.robots)[number]): boolean =>
    robotCorners(r).every((c) => Math.abs(c.x) <= FIELD_HALF + 0.5 && Math.abs(c.y) <= FIELD_HALF + 0.5);
  check('robot squeezed against a wall by an opponent stays in-field', inField(a) && inField(b), `a=(${a.pos.x.toFixed(1)},${a.pos.y.toFixed(1)})`);
}

// ---- 4-robot, 1200-tick determinism -----------------------------------------
{
  const build = (seed: number): World =>
    createWorld('match', seed, [
      setup(0, 'blue', {}, 0),
      setup(1, 'blue', { massLb: 24, driveRpm: 500 }, 1),
      setup(2, 'red', { drivetrain: 'tank' }, 0),
      setup(3, 'red', { intake: 'triangle' }, 1),
    ]);
  const cmds = new Map([
    [0, cmd({ driveY: 1, fire: true })],
    [1, cmd({ driveX: 0.5, intake: true })],
    [2, cmd({ rotate: 1 })],
    [3, cmd({ driveY: -0.7, fire: true })],
  ]);
  const runTicks = (w: World): void => {
    for (let i = 0; i < 1200; i++) step(w, SIM_DT, cmds);
  };
  const w1 = build(123); startMatch(w1); runTicks(w1);
  const w2 = build(123); startMatch(w2); runTicks(w2);
  check('4-robot 1200-tick sim is bit-for-bit deterministic', JSON.stringify(w1) === JSON.stringify(w2));
}

// ---- flywheel recovery: low inertia slows far shots, not close ones ---------
{
  // gap between the first two shots, fired continuously from `pos` (free mode
  // ignores launch-zone gating so we can place the robot anywhere)
  const firstGap = (spec: Partial<RobotSpec>, pos: { x: number; y: number }): number => {
    const w = mkWorld('free', 'blue', 5, spec);
    const r = w.robots[0];
    r.pos = { ...pos };
    r.vel = { x: 0, y: 0 };
    r.hopper = ['purple', 'green', 'purple'];
    const times: number[] = [];
    let prev = r.lastFireAt;
    const commands = new Map([[0, cmd({ fire: true })]]);
    for (let i = 0; i < Math.round(3 / SIM_DT) && times.length < 2; i++) {
      step(w, SIM_DT, commands);
      if (r.lastFireAt !== prev) { times.push(r.lastFireAt); prev = r.lastFireAt; }
    }
    return times.length >= 2 ? times[1] - times[0] : Infinity;
  };
  const near = { x: -50, y: 60 }; // point-blank on the blue goal
  const far = { x: 58, y: -30 };  // long cross-court shot
  const closeGap = firstGap({ flywheelInertia: 0 }, near);
  const farGap = firstGap({ flywheelInertia: 0 }, far);
  check('low-inertia flywheel fires rapidly up close', closeGap < 0.15, `gap=${closeGap.toFixed(3)}s`);
  check('low-inertia flywheel is slowed by a far shot (>3× the close gap)', farGap > 3 * closeGap, `far=${farGap.toFixed(3)}s close=${closeGap.toFixed(3)}s`);
  const hiFar = firstGap({ flywheelInertia: 1 }, far);
  check('high-inertia flywheel keeps rapid fire at range', Math.abs(hiFar - 0.1) < 0.03, `gap=${hiFar.toFixed(3)}s`);

  // the very first shot is always immediate (no spin-up before shot one)
  const w = mkWorld('free', 'blue', 5, { flywheelInertia: 0 });
  const r = w.robots[0];
  r.pos = { x: 58, y: -30 };
  r.hopper = ['purple', 'green', 'purple'];
  run(w, cmd({ fire: true }), SIM_DT * 2);
  check('first shot fires immediately even for a far low-inertia shot', r.lastFireAt <= SIM_DT * 2 + 1e-9, `t=${r.lastFireAt.toFixed(4)}`);
}

// ---- canSort fires the color the motif wants next ---------------------------
{
  const w = mkWorld('free', 'blue', 42, { canSort: true });
  const r = w.robots[0];
  r.pos = { x: -50, y: 60 };
  r.vel = { x: 0, y: 0 };
  const want = w.motif[0];
  const other: 'purple' | 'green' = want === 'purple' ? 'green' : 'purple';
  r.hopper = [other, want, other]; // FIFO would fire `other` first; sorter must skip to `want`
  run(w, cmd({ fire: true }), SIM_DT * 2); // exactly one shot
  const shot = w.balls[w.balls.length - 1];
  check('canSort robot fires the motif color first (skips FIFO)', shot.color === want, `shot=${shot.color} want=${want}`);
}

// ---- 4-robot spawn: distinct poses, preload split, HP stock drained ---------
{
  const w = createWorld('match', 77, [
    setup(0, 'blue', {}, 0),
    setup(1, 'blue', {}, 1),
    setup(2, 'red', {}, 0),
    setup(3, 'red', {}, 1),
  ]);
  const blue0 = w.robots.find((r) => r.id === 0)!;
  const blue1 = w.robots.find((r) => r.id === 1)!;
  check('4 robots spawn (2 per alliance)', w.robots.length === 4);
  check('first robot per alliance gets the 3-ball preload', blue0.hopper.length === 3, `${blue0.hopper.length}`);
  check(
    'second robot per alliance takes the HP stock as its preload',
    JSON.stringify(blue1.hopper) === JSON.stringify([...HP_INITIAL_STOCK]),
    `${blue1.hopper.join(',')}`,
  );
  check(
    'HP box is empty when two robots fill an alliance',
    w.humanPlayers.blue.box.length === 0 && w.humanPlayers.red.box.length === 0,
    `blue=${w.humanPlayers.blue.box.length} red=${w.humanPlayers.red.box.length}`,
  );
  const gap = Math.hypot(blue0.pos.x - blue1.pos.x, blue0.pos.y - blue1.pos.y);
  check('two robots on an alliance spawn at distinct, non-overlapping poses', gap > 20, `${gap.toFixed(1)} in apart`);
}

// ---- HP box = missing-robot leftovers only; pre-stage sits in the corner -----
{
  // full 2v2 -> box empty (both robots preloaded)
  const w2r = createWorld('match', 77, [setup(0, 'blue', {}, 0), setup(1, 'blue', {}, 1), setup(2, 'red', {}, 0), setup(3, 'red', {}, 1)]);
  check(
    'full 2v2 -> HP box is empty',
    w2r.humanPlayers.blue.box.length === 0 && w2r.humanPlayers.red.box.length === 0,
    `blue=${w2r.humanPlayers.blue.box.length}`,
  );
  // one robot -> box holds only the missing robot's set (3, PPG) — NOT full
  const w1 = createWorld('match', 77, [setup(0, 'blue', {}, 0), setup(1, 'red', {}, 0)]);
  check(
    'one-robot alliance -> box holds only the missing set (3, PPG)',
    JSON.stringify(w1.humanPlayers.blue.box) === JSON.stringify([...HP_INITIAL_STOCK]),
    `box=${w1.humanPlayers.blue.box.join(',')}`,
  );
  // empty alliance -> both leftover sets (6, 4P+2G), at the cap
  const w0 = createWorld('match', 77, [setup(0, 'blue', {}, 0)]);
  const redBox = w0.humanPlayers.red.box;
  check(
    'empty alliance -> box holds both leftover sets (6, 4P+2G)',
    redBox.length === 6 && redBox.filter((c) => c === 'purple').length === 4 && redBox.filter((c) => c === 'green').length === 2,
    `box=${redBox.join(',')}`,
  );
  // grab-row geometry: 3 slots in a row along x
  const slots = loadSlots('blue');
  check('grab row is 3 slots', slots.length === 3);
  check('grab row shares one y (a row along x)', slots.every((s) => s.y === slots[0].y));
  check(
    'grab row spans a range of x (robot sweeps along x)',
    Math.abs(slots[2].x - slots[0].x) > 2 * BALL_RADIUS,
    `dx=${(slots[2].x - slots[0].x).toFixed(1)}`,
  );
  // the 3 pre-staged artifacts (PGP) sit ON the field in the loading-zone corner,
  // against the alliance wall, touching, and NOT at the grab-row slots
  const pre = loadPreStage('blue');
  check('pre-stage is 3 PGP artifacts', pre.length === 3 && pre.map((p) => p.color).join(',') === 'purple,green,purple');
  check('pre-stage is flush against the alliance (side) wall', pre.every((p) => Math.abs(Math.abs(p.pos.x) - (FIELD_HALF - BALL_RADIUS)) < 1e-9));
  check('pre-stage balls are touching each other', Math.abs(Math.abs(pre[1].pos.y - pre[0].pos.y) - 2 * BALL_RADIUS) < 1e-9);
  check(
    'pre-stage is NOT at the grab-row slots',
    pre.every((p) => slots.every((s) => Math.hypot(p.pos.x - s.x, p.pos.y - s.y) > BALL_RADIUS * 1.5)),
  );
  const inZoneAtSetup = w0.balls.filter((b) => b.state.kind === 'ground' && inRect(b.pos, loadZone('blue')));
  check('the 3 pre-stage artifacts are on the field in the loading zone at setup', inZoneAtSetup.length === 3, `${inZoneAtSetup.length}`);
  // the 2x3 box has 6 cells OFF the field, just beyond the audience wall
  const cells = loadBoxSlots('blue');
  check(
    'the 2x3 box has 6 cells off the field (beyond the audience wall)',
    cells.length === 6 && cells.every((c) => c.y < -FIELD_HALF),
  );
}

// ---- HP is idle until teleop; then moves the corner pre-stage to the grab row -
{
  const w = createWorld('match', 5, [setup(0, 'blue', {}, 0)]); // starts in 'pre'
  w.robots[0].pos = { x: 0, y: 40 };
  const box0 = JSON.stringify(w.humanPlayers.blue.box);
  const preStageStill = () => loadPreStage('blue').every((p) => w.balls.some((b) => b.state.kind === 'ground' && Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y) < 0.1));
  // pre / auto / transition: HP does nothing — box untouched, pre-stage untouched
  for (const ph of ['pre', 'auto', 'transition'] as const) {
    w.match.phase = ph;
    updateHumanPlayers(w);
  }
  check(
    'HP does nothing before teleop (box + corner pre-stage untouched)',
    JSON.stringify(w.humanPlayers.blue.box) === box0 && preStageStill(),
    `boxMoved=${JSON.stringify(w.humanPlayers.blue.box) !== box0} preStage=${preStageStill()}`,
  );
  // teleop: over a couple seconds the HP moves the 3 pre-stage balls into the grab row
  w.match.phase = 'teleop';
  for (let k = 0; k < 40; k++) {
    updateHumanPlayers(w);
    w.time += HP_PLACE_DELAY + 0.02;
  }
  const slots = loadSlots('blue');
  const inGrabRow = slots.filter((s) => w.balls.some((b) => b.state.kind === 'ground' && Math.hypot(b.pos.x - s.x, b.pos.y - s.y) < 0.2)).length;
  check(
    'HP moves the pre-stage into the grab row once teleop begins',
    inGrabRow === 3 && !preStageStill(),
    `grabRow=${inGrabRow}`,
  );
}

// ---- HP recycles loose balls in teleop (grabs them into the box), capped ------
{
  const setups4 = [setup(0, 'blue', {}, 0), setup(1, 'blue', {}, 1), setup(2, 'red', {}, 0), setup(3, 'red', {}, 1)];
  const slots = loadSlots('blue');
  const lz = loadZone('blue');

  // 2v2 -> box empty; fill the grab row so STAGING is a no-op, isolating COLLECT
  const w = createWorld('match', 5, setups4);
  w.match.phase = 'teleop';
  for (const r of w.robots) r.pos = { x: 0, y: 40 };
  // remove the corner pre-stage so only our injected loose ball is collectable
  w.balls = w.balls.filter((b) => !(b.state.kind === 'ground' && inRect(b.pos, lz)));
  slots.forEach((s, i) => w.balls.push({ id: 5000 + i, color: 'purple', state: { kind: 'ground' }, pos: { x: s.x, y: s.y }, vel: { x: 0, y: 0 }, z: 0, vz: 0 }));
  w.balls.push({ id: 4242, color: 'green', state: { kind: 'ground' }, pos: { x: (lz.x0 + lz.x1) / 2, y: lz.y1 - 3 }, vel: { x: 0, y: 0 }, z: 0, vz: 0 });
  const before = w.humanPlayers.blue.box.length;
  updateHumanPlayers(w);
  check(
    'HP grabs a loose ball out of the loading zone into the box',
    !w.balls.some((b) => b.id === 4242) && w.humanPlayers.blue.box.length === before + 1,
    `box ${before}->${w.humanPlayers.blue.box.length}`,
  );
  check(
    'HP does not grab the balls staged at the grab slots',
    [5000, 5001, 5002].every((id) => w.balls.some((b) => b.id === id)),
  );

  // at the 6-out-of-play cap the HP grabs nothing more
  const w3 = createWorld('match', 5, []); // no robots -> box = 6 (capped)
  w3.match.phase = 'teleop';
  w3.balls = w3.balls.filter((b) => !(b.state.kind === 'ground' && inRect(b.pos, lz)));
  slots.forEach((s, i) => w3.balls.push({ id: 5200 + i, color: 'purple', state: { kind: 'ground' }, pos: { x: s.x, y: s.y }, vel: { x: 0, y: 0 }, z: 0, vz: 0 }));
  w3.balls.push({ id: 4243, color: 'green', state: { kind: 'ground' }, pos: { x: (lz.x0 + lz.x1) / 2, y: lz.y1 - 3 }, vel: { x: 0, y: 0 }, z: 0, vz: 0 });
  updateHumanPlayers(w3);
  check(
    'HP does not grab when the box is already at the 6-out-of-play cap',
    w3.balls.some((b) => b.id === 4243) && w3.humanPlayers.blue.box.length === 6,
  );
}

// ============================================================================
// Phase C: penalty engine (Section 11 fouls)
// ============================================================================

/** two cross-alliance robots (blue id0, red id1) forced into teleop */
function foulWorld(timeLeft = 60): World {
  const w = createWorld('match', 55, [setup(0, 'blue', {}, 0), setup(1, 'red', {}, 0)]);
  w.match.phase = 'teleop';
  w.match.phaseTimeLeft = timeLeft;
  // park both well away from every foul zone until each test places them
  w.robots[0].pos = { x: 0, y: -8 };
  w.robots[1].pos = { x: 0, y: 20 };
  for (const r of w.robots) { r.vel = { x: 0, y: 0 }; r.fieldCentric = false; }
  return w;
}

function runCmds(w: World, cmds: Map<number, RobotCommand>, seconds: number): void {
  const n = Math.round(seconds / SIM_DT);
  for (let i = 0; i < n; i++) step(w, SIM_DT, cmds);
}

/** drop a robot into an opposing gate zone and press it in for `secs` */
function inGate(w: World, robotIdx: number, gate: 'red' | 'blue'): void {
  const gz = gateZone(gate);
  w.robots[robotIdx].pos = { x: (gz.x0 + gz.x1) / 2, y: (gz.y0 + gz.y1) / 2 };
}

// ---- opponent gate (MAJOR): working the other alliance's gate ---------------
{
  const w = foulWorld();
  inGate(w, 0, 'red'); // blue robot intrudes into RED's gate
  runCmds(w, new Map(), 0.5);
  check(
    'opponent in the gate zone draws a MAJOR foul (opening opponent gate)',
    w.match.scores.red.foulPoints === 15 && w.match.fouls.blue.major === 1,
    `redFoulPts=${w.match.scores.red.foulPoints} blueMajor=${w.match.fouls.blue.major}`,
  );
  // holding in the gate is ONE foul, not a stream (episode-debounced)
  runCmds(w, new Map(), 1.5);
  check(
    'staying in the gate is a single foul, not one per tick',
    w.match.fouls.blue.major === 1,
    `blueMajor=${w.match.fouls.blue.major}`,
  );

  // leaving and coming back AFTER the clear window is a fresh foul
  w.robots[0].pos = { x: 0, y: -8 }; // out
  runCmds(w, new Map(), 1.3); // stay clear past PENALTY_CLEAR (1.0 s)
  check('leaving the gate does not add a foul', w.match.fouls.blue.major === 1);
  inGate(w, 0, 'red'); // back in
  runCmds(w, new Map(), 0.3);
  check(
    're-entering the opponent gate after the clear window fouls again',
    w.match.fouls.blue.major === 2 && w.match.scores.red.foulPoints === 30,
    `blueMajor=${w.match.fouls.blue.major} redFoulPts=${w.match.scores.red.foulPoints}`,
  );

  // a robot working its OWN gate is never fouled
  const w2 = foulWorld();
  inGate(w2, 0, 'blue');
  runCmds(w2, new Map(), 0.5);
  check(
    'working your OWN gate is never a foul',
    w2.match.scores.red.foulPoints === 0 && w2.match.fouls.blue.major === 0,
  );
}

// ---- G425 secret tunnel (MINOR) --------------------------------------------
{
  const w = foulWorld();
  const ts = tunnelStrip('red'); // the strip under RED's goal, owned by BLUE
  const cx = (ts.x0 + ts.x1) / 2;
  w.robots[0].pos = { x: cx, y: -25 };
  w.robots[1].pos = { x: cx, y: -24 }; // overlapping -> contact
  runCmds(w, new Map(), 0.3);
  check(
    'contact in the secret tunnel draws a MINOR foul on the intruder',
    w.match.scores.blue.foulPoints === 5 && w.match.fouls.red.minor === 1,
    `blueFoulPts=${w.match.scores.blue.foulPoints} redMinor=${w.match.fouls.red.minor}`,
  );
}

// ---- G426 loading zone (MINOR): opponent contacts you in your own zone ------
{
  const w = foulWorld();
  // sit well inside the loading zone AND clear of the side-wall tunnel strip
  // (a wide chassis near the +x wall would straddle both zones)
  const cx = loadZone('blue').x0 + 5;
  for (const r of w.robots) r.heading = Math.PI / 2; // forward = +y
  w.robots[0].pos = { x: cx, y: -58 }; // victim (blue) in its own loading zone
  w.robots[1].pos = { x: cx, y: -42 }; // opponent (red) overlapping slightly -> one contact
  runCmds(w, new Map(), 0.3);
  check(
    'opponent contact in your loading zone fouls the opponent (MINOR)',
    w.match.scores.blue.foulPoints === 5 && w.match.fouls.red.minor === 1,
    `blueFoulPts=${w.match.scores.blue.foulPoints} redMinor=${w.match.fouls.red.minor}`,
  );
}

// ---- G427 base zone (MAJOR + counts the victim fully returned) --------------
{
  const w = foulWorld(15); // endgame (<= ENDGAME_START)
  const bz = baseZone('blue');
  const cx = (bz.x0 + bz.x1) / 2;
  const cy = (bz.y0 + bz.y1) / 2;
  w.robots[0].pos = { x: cx, y: cy }; // blue in its base
  w.robots[1].pos = { x: cx, y: cy + 1 }; // red contacts it
  runCmds(w, new Map(), 0.3);
  check(
    'base contact in endgame draws a MAJOR foul + marks the victim base-awarded',
    w.match.scores.blue.foulPoints === 15 &&
      w.match.fouls.red.major === 1 &&
      w.robots[0].baseAwarded === true,
    `blueFoulPts=${w.match.scores.blue.foulPoints} redMajor=${w.match.fouls.red.major} awarded=${w.robots[0].baseAwarded}`,
  );
  // drive the victim clear out of its base, then assess: baseAwarded => full
  w.robots[0].pos = { x: 0, y: 0 };
  w.robots[1].pos = { x: 0, y: 40 };
  assessMatchEnd(w);
  check(
    'a base-awarded robot is credited a FULL base return even outside the base',
    w.match.scores.blue.base === 10,
    `base=${w.match.scores.blue.base}`,
  );

  // outside endgame the same contact is NOT a base foul
  const w2 = foulWorld(60);
  w2.robots[0].pos = { x: cx, y: cy };
  w2.robots[1].pos = { x: cx, y: cy + 1 };
  runCmds(w2, new Map(), 0.3);
  check(
    'base contact BEFORE endgame is not a G427 foul',
    w2.match.scores.blue.foulPoints === 0 && !w2.robots[0].baseAwarded,
  );
}

// ---- G402 AUTO interference (MAJOR): fully on the opponent's side -----------
{
  const w = createWorld('match', 55, [setup(0, 'blue', {}, 0), setup(1, 'red', {}, 0)]);
  startMatch(w); // -> auto
  for (const r of w.robots) { r.vel = { x: 0, y: 0 }; r.fieldCentric = false; }
  w.robots[0].pos = { x: -30, y: 0 }; // blue entirely on red's (-x) side
  w.robots[1].pos = { x: -30, y: 1 }; // contacting a red robot
  runCmds(w, new Map(), 0.2);
  check(
    'crossing fully onto the opponent side and contacting in AUTO is a MAJOR foul',
    w.match.scores.red.foulPoints === 15 && w.match.fouls.blue.major === 1,
    `redFoulPts=${w.match.scores.red.foulPoints} blueMajor=${w.match.fouls.blue.major}`,
  );
}

// ---- same-alliance contact never fouls -------------------------------------
{
  const w = createWorld('match', 55, [setup(0, 'blue', {}, 0), setup(1, 'blue', {}, 1)]);
  w.match.phase = 'teleop';
  w.match.phaseTimeLeft = 60;
  const ts = tunnelStrip('red');
  const cx = (ts.x0 + ts.x1) / 2;
  for (const r of w.robots) { r.vel = { x: 0, y: 0 }; r.fieldCentric = false; }
  w.robots[0].pos = { x: cx, y: -25 };
  w.robots[1].pos = { x: cx, y: -24 };
  runCmds(w, new Map(), 0.5);
  check(
    'same-alliance contact in a foul zone never fouls',
    w.match.scores.red.foulPoints === 0 &&
      w.match.scores.blue.foulPoints === 0 &&
      w.match.fouls.blue.minor === 0 &&
      w.match.fouls.blue.major === 0,
  );
}

/** pin scenario: pinned robot flush against the far wall, pinner just below and
 * driving up into it (heading π/2 so robot-forward = +y). */
function pinWorld(): World {
  const w = foulWorld();
  for (const r of w.robots) r.heading = Math.PI / 2;
  w.robots[1].pos = { x: 0, y: 63 }; // pinned red, flush at the far wall
  w.robots[0].pos = { x: 0, y: 44 }; // pinner blue, 1" gap, drives up into it
  return w;
}
const PIN_CMDS = new Map([[0, cmd({ driveY: 1 })], [1, cmd({ driveY: 1 })]]);

// ---- G422 pinning: 3-count fires, then resets on separation -----------------
{
  const w = pinWorld();
  runCmds(w, PIN_CMDS, 2.7);
  check('no pin foul before the 3 s threshold', w.match.fouls.blue.minor === 0, `blueMinor=${w.match.fouls.blue.minor}`);
  runCmds(w, PIN_CMDS, 0.5); // cross 3 s
  check(
    'a 3 s pin draws a MINOR foul on the pinner',
    w.match.fouls.blue.minor === 1,
    `blueMinor=${w.match.fouls.blue.minor}`,
  );
  // separate: the accumulator must reset and stop fouling
  w.robots[0].pos = { x: 0, y: -20 };
  const before = w.match.fouls.blue.minor + w.match.fouls.blue.major;
  runCmds(w, new Map(), 2);
  check(
    'breaking the pin resets the count (no further foul while separated)',
    w.match.fouls.blue.minor + w.match.fouls.blue.major === before,
    `after=${w.match.fouls.blue.minor + w.match.fouls.blue.major}`,
  );
}

// ---- G422 pinning: a continuous pin is ONE foul; a REPEAT escalates to MAJOR -
{
  const w = pinWorld();
  runCmds(w, PIN_CMDS, 6.3); // hold the pin continuously well past 6 s
  check(
    'a sustained pin is a single MINOR foul, not one every 3 s',
    w.match.fouls.blue.minor === 1 && w.match.fouls.blue.major === 0,
    `blueMinor=${w.match.fouls.blue.minor} blueMajor=${w.match.fouls.blue.major}`,
  );
  // separate, then pin again — the repeat by the same pinner escalates to MAJOR
  w.robots[0].pos = { x: 0, y: -20 };
  runCmds(w, new Map(), 0.4); // break contact
  w.robots[0].pos = { x: 0, y: 44 };
  runCmds(w, PIN_CMDS, 3.3);
  check(
    'a repeat pin (after separating) escalates to MAJOR',
    w.match.fouls.blue.major === 1,
    `blueMinor=${w.match.fouls.blue.minor} blueMajor=${w.match.fouls.blue.major}`,
  );
}

// ---- penalty state stays deterministic -------------------------------------
{
  const w1 = pinWorld(); runCmds(w1, PIN_CMDS, 4);
  const w2 = pinWorld(); runCmds(w2, PIN_CMDS, 4);
  check('penalty engine is bit-for-bit deterministic', JSON.stringify(w1) === JSON.stringify(w2));
}

// ============================================================================
// Phase 0: server-authoritative netcode (protocol / checksum / predict-reconcile)
// ============================================================================

// ---- command quantization: clamp + idempotent round-trip -------------------
{
  const q = quantizeCommand(cmd({ driveX: 5, driveY: -5, rotate: 0.5, intake: true, fire: false }));
  check(
    'quantize clamps out-of-range axes to int8 and packs buttons',
    q.dx === 127 && q.dy === -127 && q.rot === Math.round(0.5 * 127) && q.buttons === 1,
    `dx=${q.dx} dy=${q.dy} rot=${q.rot} btn=${q.buttons}`,
  );
  // quantize∘dequantize is the identity on a QCommand, so localize is stable —
  // the client predicts on exactly what the server decodes from the same bytes
  const raw = cmd({ driveX: 0.37, driveY: -0.81, rotate: 0.12, fire: true });
  const once = localizeCommand(raw);
  const twice = localizeCommand(once);
  check(
    'localizeCommand is stable (client prediction == server-decoded value)',
    JSON.stringify(once) === JSON.stringify(twice),
    JSON.stringify(once),
  );
}

// ---- worldHash: replay determinism + sensitivity ---------------------------
{
  const build = (): World =>
    createWorld('match', 321, [
      setup(0, 'blue', {}, 0),
      setup(1, 'blue', { massLb: 24, driveRpm: 500 }, 1),
      setup(2, 'red', { drivetrain: 'tank' }, 0),
      setup(3, 'red', { intake: 'triangle' }, 1),
    ]);
  const cmds = new Map([
    [0, cmd({ driveY: 1, fire: true })],
    [1, cmd({ driveX: 0.5, intake: true })],
    [2, cmd({ rotate: 1 })],
    [3, cmd({ driveY: -0.7, fire: true })],
  ]);
  const hashesAt = (w: World): number[] => {
    startMatch(w);
    const out: number[] = [];
    for (let i = 0; i < 600; i++) {
      step(w, SIM_DT, cmds);
      if (w.tick % 120 === 0) out.push(worldHash(w)); // sample every ~2 s
    }
    return out;
  };
  const h1 = hashesAt(build());
  const h2 = hashesAt(build());
  check(
    'worldHash agrees across identical replays (server/client parity per tick)',
    h1.length === 5 && JSON.stringify(h1) === JSON.stringify(h2),
    `n=${h1.length}`,
  );
  check('the checksum actually evolves (not constant)', new Set(h1).size > 1);

  const wa = build();
  const wb = build();
  wb.robots[0].pos.x += 1; // a 1" divergence must change the hash
  check('worldHash detects a diverged position', worldHash(wa) !== worldHash(wb));
}

// ---- snapshot fidelity: World survives a JSON snapshot round-trip -----------
// (reconciliation replaces the world with a JSON snapshot from the server, so
// the parsed world must hash identically to the original)
{
  const w = createWorld('match', 555, [setup(0, 'blue', {}, 0), setup(1, 'red', {}, 1)]);
  startMatch(w);
  const cmds = new Map([
    [0, cmd({ driveY: 1, rotate: 0.4, fire: true })],
    [1, cmd({ driveX: -0.6, intake: true })],
  ]);
  for (let i = 0; i < 240; i++) step(w, SIM_DT, cmds);
  const clone: World = JSON.parse(JSON.stringify(w));
  check('World survives a JSON snapshot round-trip (hash-identical)', worldHash(clone) === worldHash(w));
}

// ---- delta snapshots: slim (spec-stripped) + ball delta reassemble exactly --
{
  const setups = [setup(0, 'blue', {}, 0), setup(1, 'red', { drivetrain: 'tank' }, 1)];
  const w = createWorld('match', 654, setups);
  startMatch(w);
  const cmds = new Map([
    [0, cmd({ driveY: 1, fire: true })],
    [1, cmd({ driveX: -0.5, intake: true })],
  ]);
  // stop early, while balls are still in flight/motion (so the delta below has
  // both changed and idle balls to distinguish)
  for (let i = 0; i < 45; i++) step(w, SIM_DT, cmds);

  // slim (drop balls + robot.spec) then reassemble with spec re-injected
  const specById = (id: number): (typeof setups)[number]['spec'] =>
    setups.find((s) => s.id === id)!.spec;
  const rebuilt = unslimWorld(slimWorld(w), w.balls, specById);
  check('slim+unslim snapshot reassembles to an identical worldHash', worldHash(rebuilt) === worldHash(w));
  check(
    'the slim wire world carries no robot spec (client re-injects it)',
    !('spec' in (slimWorld(w).robots[0] as object)),
  );

  // ball delta: encode changes vs a baseline, apply to the baseline, compare
  const baseline: Artifact[] = w.balls.map((b) => JSON.parse(JSON.stringify(b)));
  const prevJson = new Map(baseline.map((b) => [b.id, JSON.stringify(b)]));
  for (let i = 0; i < 6; i++) step(w, SIM_DT, cmds); // move some balls
  const curJson = new Map(w.balls.map((b) => [b.id, JSON.stringify(b)]));
  const order = w.balls.map((b) => b.id);
  const upd = w.balls.filter((b) => curJson.get(b.id) !== prevJson.get(b.id));

  // client-side apply: patch baseline by id, rebuild in the authoritative order
  const base = new Map(baseline.map((b) => [b.id, b]));
  for (const b of upd) base.set(b.id, JSON.parse(JSON.stringify(b)));
  const keep = new Set(order);
  for (const id of [...base.keys()]) if (!keep.has(id)) base.delete(id);
  const applied = order.map((id) => base.get(id) as Artifact);

  check(
    'ball delta reconstructs the exact ball array (order + data)',
    JSON.stringify(applied) === JSON.stringify(w.balls),
    `sent ${upd.length}/${w.balls.length} balls`,
  );
  const unchanged = w.balls.filter((b) => prevJson.get(b.id) === curJson.get(b.id)).length;
  check(
    'ball delta sends only the moved balls (some changed, some idle)',
    upd.length > 0 && unchanged > 0 && upd.length < w.balls.length,
    `${upd.length} changed, ${unchanged} idle`,
  );
}

// ---- predict/reconcile parity ----------------------------------------------
// The client replaces its world with a server snapshot at `serverTick`, then
// replays the local inputs it had buffered PAST that tick (remote robots default
// to ZERO in step()). The result must equal the authoritative world stepped with
// those same local inputs — this is exactly GameController.reconcile().
{
  const seed = 909;
  const setups = [setup(0, 'blue', {}, 0), setup(1, 'red', {}, 1)];
  const localStream = (t: number): RobotCommand =>
    cmd({ driveY: 0.8, rotate: 0.2, fire: t % 15 === 0 });

  // authoritative world: local robot driven, remote robot idle (ZERO)
  const auth = createWorld('match', seed, setups);
  startMatch(auth);
  for (let t = 1; t <= 100; t++) step(auth, SIM_DT, new Map([[0, localizeCommand(localStream(t))]]));
  const snap: World = JSON.parse(JSON.stringify(auth)); // the "server snapshot" at tick 100

  // authority runs 20 more ticks with the same local inputs
  const buffered: RobotCommand[] = [];
  for (let t = 101; t <= 120; t++) {
    const l = localizeCommand(localStream(t));
    buffered.push(l);
    step(auth, SIM_DT, new Map([[0, l]]));
  }

  // client reconciles: adopt the snapshot, replay the 20 buffered local inputs
  const client: World = JSON.parse(JSON.stringify(snap));
  for (const l of buffered) step(client, SIM_DT, new Map([[0, l]]));
  check(
    'reconcile replay reproduces the authoritative world exactly',
    worldHash(client) === worldHash(auth),
    `client=${worldHash(client)} auth=${worldHash(auth)}`,
  );
}

// ---- remote prediction reproduces robot-robot collisions --------------------
// The client predicts remote robots forward with their HELD command (not a
// render-time hack), so `step()` moves + COLLIDES them exactly like the server.
// Two robots seeded overlapping ⇒ collideRobots runs every tick; the client that
// replays with the held remote command must match the server bit-for-bit.
{
  const setups = [setup(0, 'blue', {}, 0), setup(1, 'red', {}, 0)];
  const mk = (): World => {
    const w = createWorld('match', 111, setups);
    startMatch(w);
    w.robots[0].pos = { x: 0, y: -5 }; // 10" apart, chassis ~18" ⇒ overlapping
    w.robots[1].pos = { x: 0, y: 5 };
    return w;
  };
  const c0 = localizeCommand(cmd({ driveY: 0.5, fire: true })); // local robot
  const c1 = localizeCommand(cmd({ driveX: -0.5, intake: true })); // remote robot (held)

  const auth = mk();
  for (let t = 1; t <= 60; t++) step(auth, SIM_DT, new Map([[0, c0], [1, c1]]));
  const overlapStart = Math.hypot(
    auth.robots[0].pos.x - auth.robots[1].pos.x,
    auth.robots[0].pos.y - auth.robots[1].pos.y,
  );
  const snap: World = JSON.parse(JSON.stringify(auth));
  const buffered: RobotCommand[] = [];
  for (let t = 61; t <= 90; t++) {
    buffered.push(c0);
    step(auth, SIM_DT, new Map([[0, c0], [1, c1]]));
  }
  // client: snapshot + replay local(0) live and remote(1) HELD command
  const client: World = JSON.parse(JSON.stringify(snap));
  for (const l of buffered) step(client, SIM_DT, new Map([[0, l], [1, c1]]));
  check(
    'remote prediction (held command) reproduces the world incl. robot-robot collisions',
    worldHash(client) === worldHash(auth),
    `client=${worldHash(client)} auth=${worldHash(auth)}`,
  );
  check(
    'seeded-overlapping robots get separated by the sim (collision actually ran)',
    overlapStart > 10,
    `sep=${overlapStart.toFixed(1)}"`,
  );
}

// ---- server drop degrades cleanly (ZERO from the drop tick) -----------------
// a robot whose client left runs on ZERO and never stalls the others; the match
// keeps advancing and the world stays finite.
{
  const w = createWorld('match', 42, [setup(0, 'blue', {}, 0), setup(1, 'red', {}, 1)]);
  startMatch(w);
  // both robots active for a bit
  for (let t = 0; t < 60; t++) {
    step(w, SIM_DT, new Map([[0, cmd({ driveY: 1 })], [1, cmd({ driveX: 1 })]]));
  }
  const before = w.tick;
  // robot 1 "drops": server feeds only robot 0; robot 1 gets ZERO by default
  for (let t = 0; t < 120; t++) step(w, SIM_DT, new Map([[0, cmd({ driveY: -1 })]]));
  const r1 = w.robots[1];
  check(
    'a dropped robot keeps the sim advancing (no stall) and stays finite',
    w.tick === before + 120 && Number.isFinite(r1.pos.x) && Number.isFinite(r1.pos.y),
    `tick=${w.tick} r1=(${r1.pos.x.toFixed(1)},${r1.pos.y.toFixed(1)})`,
  );
}

// ---- deterministic trig: cross-engine lockstep needs Math-free sin/cos/atan2 -
// (Math.sin/cos/tan/atan2 are not correctly-rounded, so they differ across
// browsers and fork a lockstep sim; dsin/dcos/dtan/datan2 are pure +,-,*,/ )
{
  let maxSin = 0;
  let maxCos = 0;
  let maxTan = 0;
  let maxAtan2 = 0;
  for (let i = 0; i < 4001; i++) {
    const x = (i / 4000 - 0.5) * 40 * Math.PI; // ±20π, exercises range reduction
    maxSin = Math.max(maxSin, Math.abs(dsin(x) - Math.sin(x)));
    maxCos = Math.max(maxCos, Math.abs(dcos(x) - Math.cos(x)));
    if (Math.abs(Math.cos(x)) > 0.2) maxTan = Math.max(maxTan, Math.abs(dtan(x) - Math.tan(x)));
  }
  for (let i = -40; i <= 40; i++) {
    for (let j = -40; j <= 40; j++) {
      if (i === 0 && j === 0) continue;
      let d = datan2(i, j) - Math.atan2(i, j);
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      maxAtan2 = Math.max(maxAtan2, Math.abs(d));
    }
  }
  check('dsin matches Math.sin (<1e-9) across ±20π', maxSin < 1e-9, maxSin.toExponential(2));
  check('dcos matches Math.cos (<1e-9) across ±20π', maxCos < 1e-9, maxCos.toExponential(2));
  check('dtan matches Math.tan (<1e-7) away from asymptotes', maxTan < 1e-7, maxTan.toExponential(2));
  check('datan2 matches Math.atan2 (<1e-7) over all quadrants', maxAtan2 < 1e-7, maxAtan2.toExponential(2));
  // determinism proper: pure arithmetic ⇒ identical on repeat (no engine state)
  check('deterministic trig is referentially stable', dsin(1.2345) === dsin(1.2345) && datan2(3, -4) === datan2(3, -4));
}

// ---- replays + record-chasing (Phase 3 foundation) -------------------------
{
  // a scripted driver that varies its command (so tracks hold multiple entries)
  // and fires + intakes throughout — the start poses sit in the launch zone with
  // a preloaded hopper, so this scores real points to compare on.
  const drive: CommandSource = (tick) => {
    const seg = Math.floor(tick / 37) % 4;
    const c: RobotCommand = {
      driveX: seg === 1 ? 0.5 : 0,
      driveY: seg === 2 ? -0.4 : 0,
      rotate: seg === 3 ? 0.3 : 0,
      intake: true,
      fire: true,
    };
    const m = new Map<number, RobotCommand>();
    for (const r of [0, 1]) m.set(r, c);
    return m;
  };

  // recordSetups shape
  const solo = recordSetups(DEFAULT_SPEC, 'solo');
  const duo = recordSetups(DEFAULT_SPEC, 'duo');
  check('recordSetups solo = 1 robot (1v0)', solo.length === 1 && solo[0].id === 0);
  check(
    'recordSetups duo = 2 robots, same drivetrain, distinct poses',
    duo.length === 2 &&
      duo[0].spec.drivetrain === duo[1].spec.drivetrain &&
      duo[0].startIndex !== duo[1].startIndex,
  );

  // full SOLO record match → re-simulate → byte-identical (the core guarantee)
  const run = runRecordMatch(0x51ce, solo, drive);
  check('record match runs to phase "post"', run.world.match.phase === 'post');
  check('replay stamped with format + balance version', run.replay.format === REPLAY_FORMAT && run.replay.balanceVersion === BALANCE_VERSION);
  const entries0 = (run.replay.tracks[0]?.length ?? 0) / 5;
  check('replay recorded a non-trivial run', run.replay.ticks > 1000 && entries0 >= 2);
  check('replay hold-last compresses (entries << ticks)', entries0 * 20 < run.replay.ticks, `${entries0} entries / ${run.replay.ticks} ticks`);
  check('record run scored points to compare on', run.result.score.blue > 0, `blue ${run.result.score.blue}`);

  const v = verifyReplay(run.replay);
  check('verifyReplay reproduces the final worldHash', v.hash === run.result.hash, `${v.hash} vs ${run.result.hash}`);
  check('verifyReplay reproduces the score', v.score.blue === run.result.score.blue && v.score.red === run.result.score.red);
  check('verifyReplay reproduces the tick count', v.ticks === run.result.ticks);
  // referential determinism: a second re-sim is identical
  check('simulateReplay is referentially stable', worldHash(simulateReplay(run.replay)) === v.hash);

  // DUO (2v0) short run: two command tracks, both re-simulate deterministically
  const duoRun = runRecordMatch(0xd0, duo, drive, { stopTick: 700 });
  check('duo replay has a track per robot', !!duoRun.replay.tracks[0] && !!duoRun.replay.tracks[1]);
  check('duo replay re-simulates deterministically', verifyReplay(duoRun.replay).hash === duoRun.result.hash);
}

// ---- server-side recording via a real Room (Phase 3 server spine) ----------
{
  const msgs: ServerMsg[] = [];
  const host: Client = {
    id: 'host-1',
    send: (m) => msgs.push(m),
    player: {
      clientId: 'host-1',
      name: 'Rec',
      teamName: 'T',
      teamNumber: 1,
      alliance: 'red', // record must FORCE this to blue (co-op, opponent-free)
      startIndex: 0,
      ready: true,
      spec: { ...DEFAULT_SPEC },
      assists: { ...DEFAULT_ASSISTS },
    },
    connected: true,
    disconnectAt: 0,
  };
  const room = new Room('smoke-rec', () => {}, { kind: 'record', record: 'solo' });
  check('record-solo room caps the roster at 1', room.canJoin());
  room.add(host);
  check('record-solo room is full after 1 driver', !room.canJoin());
  room.onMessage('host-1', { t: 'start' });
  // pre-load a fire+intake command for every tick so the run scores real points
  const cap = maxMatchTicks();
  const fire = quantizeCommand({ driveX: 0, driveY: 0, rotate: 0, intake: true, fire: true });
  for (let t = 1; t <= cap; t++) room.onMessage('host-1', { t: 'input', tick: t, q: fire });
  room.advanceForTest(cap + 5);

  const res = msgs.find((m) => m.t === 'matchResult');
  check('server Room emits a matchResult at match end', !!res);
  if (res && res.t === 'matchResult') {
    check('matchResult tagged kind=record / solo', res.kind === 'record' && res.record === 'solo');
    check(
      'record forces the run onto blue (opponent-free, red player → blue robot)',
      res.result.score.blue > 0 && res.result.score.red === 0,
      `blue ${res.result.score.blue} red ${res.result.score.red}`,
    );
    check(
      'server-recorded replay re-simulates to the authoritative world',
      verifyReplay(res.replay).hash === res.result.hash,
      `${verifyReplay(res.replay).hash} vs ${res.result.hash}`,
    );
    check('server replay stamped with balance version', res.replay.balanceVersion === BALANCE_VERSION);
  }
}

// ---- ranked ELO math (Phase 3) ---------------------------------------------
{
  const p = (
    userId: string,
    alliance: 'red' | 'blue',
    drivetrain: EloParticipant['drivetrain'],
    r = 1000,
  ): EloParticipant => ({
    userId,
    alliance,
    drivetrain,
    ratingOverall: r,
    ratingDrivetrain: r,
  });

  check('eloMode: 2 players = 1v1, 4 = 2v2', eloMode(2) === '1v1' && eloMode(4) === '2v2');

  // even 1v1, same drivetrain, red wins → symmetric ±16 on BOTH boards
  const evenRedWin = computeElo([p('a', 'red', 'mecanum'), p('b', 'blue', 'mecanum')], {
    red: 50,
    blue: 30,
  });
  const boards = new Set(evenRedWin.map((u) => u.board));
  check('same-drivetrain game updates overall + that drivetrain board', boards.has('overall') && boards.has('mecanum') && boards.size === 2);
  const aOverall = evenRedWin.find((u) => u.userId === 'a' && u.board === 'overall')!;
  const bOverall = evenRedWin.find((u) => u.userId === 'b' && u.board === 'overall')!;
  check('winner +16 / loser -16 on even ratings', aOverall.after === 1016 && bOverall.after === 984, `${aOverall.after}/${bOverall.after}`);

  // mixed drivetrains → OVERALL board only (no per-drivetrain board)
  const mixed = computeElo([p('a', 'red', 'mecanum'), p('b', 'blue', 'tank')], { red: 50, blue: 30 });
  check('mixed-drivetrain game updates OVERALL only', new Set(mixed.map((u) => u.board)).size === 1 && mixed.every((u) => u.board === 'overall'));

  // a draw moves nobody
  const draw = computeElo([p('a', 'red', 'swerve'), p('b', 'blue', 'swerve')], { red: 40, blue: 40 });
  check('a draw leaves ratings unchanged', draw.every((u) => u.after === u.before));

  // 2v2, red team stronger, red wins → red gains less (favored), blue loses less
  const team = computeElo(
    [
      p('a', 'red', 'swerve', 1200),
      p('b', 'red', 'swerve', 1200),
      p('c', 'blue', 'swerve', 1000),
      p('d', 'blue', 'swerve', 1000),
    ],
    { red: 60, blue: 20 },
  );
  const aT = team.find((u) => u.userId === 'a' && u.board === 'overall')!;
  check('favored winner gains modestly (<16)', aT.after - aT.before > 0 && aT.after - aT.before < 16, `+${aT.after - aT.before}`);
}

// ---- ranked results: server broadcasts eloResult, re-keyed to robot ids ------
{
  const msgs: ServerMsg[] = [];
  const mk = (id: string, alliance: 'red' | 'blue', userId: string): Client => ({
    id,
    send: (m) => msgs.push(m),
    player: {
      clientId: id,
      name: id,
      teamName: 'T',
      teamNumber: 1,
      alliance,
      startIndex: 0,
      ready: true,
      spec: { ...DEFAULT_SPEC },
      assists: { ...DEFAULT_ASSISTS },
    },
    connected: true,
    disconnectAt: 0,
    userId,
  });
  // onResult resolves to overall-ELO changes (as applyMatchElo would); the Room
  // must re-key them to robot ids (add order → robotId 0 = red, 1 = blue)
  const onResult = () =>
    Promise.resolve([
      { userId: 'u-red', before: 1000, after: 1016 },
      { userId: 'u-blue', before: 1000, after: 984 },
    ]);
  const room = new Room('smoke-elo', () => {}, { kind: 'versus' }, onResult);
  room.add(mk('cr', 'red', 'u-red'));
  room.add(mk('cb', 'blue', 'u-blue'));
  room.onMessage('cr', { t: 'start' });
  room.advanceForTest(maxMatchTicks() + 5);
  await new Promise((r) => setTimeout(r, 0)); // flush the async eloResult broadcast

  const elo = msgs.find((m) => m.t === 'eloResult');
  check('server Room broadcasts eloResult after a ranked match', !!elo);
  if (elo && elo.t === 'eloResult') {
    const red = elo.results.find((r) => r.robotId === 0);
    const blue = elo.results.find((r) => r.robotId === 1);
    check('eloResult re-keys the winner delta to red robot 0', red?.after === 1016 && red?.before === 1000);
    check('eloResult re-keys the loser delta to blue robot 1', blue?.after === 984 && blue?.before === 1000);
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
