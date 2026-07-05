/**
 * Headless smoke test of the sim core: drives, shoots (incl. on the move),
 * opens the gate, and checks scoring math. Run with: npx tsx scripts/smoke.ts
 */
import { createWorld } from '../src/sim/spawn';
import { step } from '../src/sim/world';
import { startMatch } from '../src/sim/match';
import {
  inLaunchZone,
  gateZone,
  goalCenter,
  basinFunnelTarget,
  railPos,
  classifierRect,
  baseZone,
} from '../src/sim/field';
import { assessMatchEnd } from '../src/sim/scoring';
import type { RobotCommand, World } from '../src/types';
import {
  SIM_DT,
  GATE_STOP_S,
  RAIL_PITCH,
  BASIN_FLOOR_Z,
  RAMP_SURFACE_Z,
  FIELD_HALF,
  BALL_RADIUS,
} from '../src/config';
import { robotCorners, robotExtents } from '../src/sim/physics';
import { DEFAULT_BINDINGS, mergeBindings } from '../src/input/bindings';

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

const slotCount = (w: World, a: 'red' | 'blue') =>
  w.balls.filter((b) => b.state.kind === 'rail' && b.state.goal === a && !b.state.overflow)
    .length;

// ---- spawn sanity ----------------------------------------------------------
{
  const w = createWorld('match', 'blue', 42);
  const purple = w.balls.filter((b) => b.color === 'purple').length;
  const green = w.balls.filter((b) => b.color === 'green').length;
  check('24 on-field balls at spawn (9 spike + 3 loading per alliance)', w.balls.length === 24, `${w.balls.length}`);
  check('on-field color split 16P/8G', purple === 16 && green === 8, `${purple}P ${green}G`);
  check('hopper preloaded with 3', w.robots[0].hopper.length === 3);
  check('start pose inside launch zone', inLaunchZone(w.robots[0].pos, 'blue'));
  check('blue goal is far-left (cross-court)', goalCenter('blue').x < 0 && goalCenter('blue').y > 0);
  check('red goal is far-right', goalCenter('red').x > 0 && goalCenter('red').y > 0);
}

// ---- driving: forward vs strafe ratio -------------------------------------
{
  const w = createWorld('free', 'blue', 7);
  const r = w.robots[0];
  r.pos = { x: 0, y: 0 };
  r.heading = Math.PI / 2;
  r.fieldCentric = false;
  run(w, cmd({ driveY: 1 }), 0.8);
  const fwd = r.pos.y;

  const w2 = createWorld('free', 'blue', 7);
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
  const w = createWorld('free', 'blue', 3);
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
  const w = createWorld('free', 'blue', 4);
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

// ---- a wheel wedged in the classifier is evicted (no wall fight) ----------------
{
  const w = createWorld('free', 'blue', 8);
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
  const w = createWorld('free', 'blue', 21);
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
  const w = createWorld('free', 'blue', 22);
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
  const w = createWorld('free', 'blue', 23);
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

// ---- driver-side view frames ------------------------------------------------
{
  // blue driver stands at the RIGHT wall: stick-up must drive toward -x
  const wb = createWorld('free', 'blue', 7);
  wb.robots[0].pos = { x: 0, y: 0 };
  wb.robots[0].fieldCentric = true;
  run(wb, cmd({ driveY: 1 }), 1);
  check('blue field-centric stick-up drives toward -x (away from blue wall)', wb.robots[0].pos.x < -10, `x=${wb.robots[0].pos.x.toFixed(1)}`);

  // red driver stands at the LEFT wall: stick-up must drive toward +x
  const wr = createWorld('free', 'red', 7);
  wr.robots[0].pos = { x: 0, y: 0 };
  wr.robots[0].fieldCentric = true;
  run(wr, cmd({ driveY: 1 }), 1);
  check('red field-centric stick-up drives toward +x (away from red wall)', wr.robots[0].pos.x > 10, `x=${wr.robots[0].pos.x.toFixed(1)}`);
}

// ---- shooting & visible classification -------------------------------------
{
  const w = createWorld('match', 'blue', 42);
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
  const w = createWorld('match', 'blue', 99);
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
  const w = createWorld('free', 'blue', 42);
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
  const w = createWorld('free', 'blue', 6, spec);
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
  const w = createWorld('free', 'blue', 6);
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
  const w = createWorld('free', 'blue', 6, spec);
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
  const w = createWorld('free', 'blue', 6);
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
  const w = createWorld('free', 'blue', 6, spec);
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
  const w = createWorld('match', 'blue', 42);
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
  const w = createWorld('match', 'blue', 42);
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
  const w = createWorld('match', 'blue', 42);
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
  const w = createWorld('match', 'blue', 42);
  startMatch(w);
  fillBlueRail(w);
  // tap the gate, drive away — the column starts draining
  const r = w.robots[0];
  const zone = gateZone('blue');
  r.pos = { x: zone.x1 + 7, y: (zone.y0 + zone.y1) / 2 };
  r.vel = { x: 0, y: 0 };
  run(w, cmd({}), 0.3);
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
  const w = createWorld('match', 'blue', 42);
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
  const w = createWorld('match', 'blue', 11);
  startMatch(w);
  const r = w.robots[0];
  r.pos = { x: -44, y: 54 }; // right up against the blue goal face
  r.vel = { x: 0, y: 0 };
  run(w, cmd({ fire: true }), 0.5);
  run(w, cmd({}), 6);
  const g = w.goals.blue;
  check('point-blank shots all enter the goal', g.classifiedCount + g.overflowCount === 3, `entered=${g.classifiedCount + g.overflowCount}`);

  const w2 = createWorld('match', 'blue', 12);
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
  const w = createWorld('free', 'blue', 5);
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
  const w = createWorld('match', 'blue', 13);
  w.robots[0].autoFire = true;
  run(w, cmd({}), 2); // still in 'pre'
  check('auto fire holds until AUTO begins', w.robots[0].hopper.length === 3, `hopper=${w.robots[0].hopper.length}`);
  startMatch(w);
  run(w, cmd({}), 2);
  check('auto fire engages once AUTO starts', w.robots[0].hopper.length === 0, `hopper=${w.robots[0].hopper.length}`);
}

// ---- match flow ---------------------------------------------------------------
{
  const w = createWorld('match', 'blue', 9);
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

  // all four wheels inside, wide/long intake hanging out over the edge -> FULL
  const w1 = createWorld('free', 'blue', 14, spec);
  w1.robots[0].pos = { x: cx, y: -31 };
  w1.robots[0].heading = Math.PI / 2; // intake pokes out the top of the base
  assessMatchEnd(w1);
  check(
    'base FULL credit with intake overhanging (wheels all in)',
    w1.match.scores.blue.base === 10,
    `base=${w1.match.scores.blue.base}`,
  );

  // only the intake reaches into the base, wheels outside -> NO credit
  const w2 = createWorld('free', 'blue', 14, spec);
  w2.robots[0].pos = { x: cx, y: -20 };
  w2.robots[0].heading = -Math.PI / 2; // intake dips into the zone from above
  assessMatchEnd(w2);
  check(
    'intake-only overhang earns no base credit (no wheel touching)',
    w2.match.scores.blue.base === 0,
    `base=${w2.match.scores.blue.base}`,
  );

  // straddling the edge: two wheels in -> PARTIAL
  const w3 = createWorld('free', 'blue', 14, spec);
  w3.robots[0].pos = { x: cx, y: -26 };
  w3.robots[0].heading = Math.PI / 2;
  assessMatchEnd(w3);
  check(
    'two wheels in the base earn partial credit',
    w3.match.scores.blue.base === 5,
    `base=${w3.match.scores.blue.base}`,
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

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
