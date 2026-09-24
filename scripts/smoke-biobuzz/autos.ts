import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Alliance, Artifact, RobotCommand, World } from '../../src/types';
import { SIM_DT } from '../../src/config';
import { BIOBUZZ_SIM } from '../../src/games/biobuzz/sim';
import { BB_POLLEN_R } from '../../src/games/biobuzz/config';
import { startMatch } from '../../src/sim/match';
import { coerceSetup, type RobotSetup } from '../../src/sim/spawn';
import { driveParams } from '../../src/sim/drivetrain';
import { localizeCommand } from '../../src/net/protocol';
import { GAME_IDS } from '../../src/games/types';
import { simModuleFor } from '../../src/games/sim';
import { autoAdapterFor, autoStartPose, createAutoSeat, type AutoSeat } from '../../src/auto';
import { ZENITH_AUTO_MAX_BYTES } from '../../src/auto/coerce';
import type { ZenithAutoSetup } from '../../src/auto/types';
import { cmd, setup, type Check } from './harness';

/**
 * THE AUTO LANE — Zenith autos driven by an auto seat (docs/area/autos.md).
 *
 * The property this lane exists for is the one the old `.pp` follower broke: an auto DRIVES the
 * robot. Every tick of every run below is checked against the drivetrain's own limits, so a pose
 * or a heading written from outside the drivetrain (the heading snap the owner reported) fails
 * here by name. Around it: the robot gets where the file says, each heading mode is held, the
 * alliance rule is the robot runtime's, the commands work the mechanisms, a replay needs no
 * seat, and the seat lets go at the buzzer and in Free Drive.
 *
 * Paths stay in open field on the BLUE side (x > 30, away from the HIVE frame and the FLOWERS),
 * so what is measured is the follower and the drivetrain, not a collision.
 */

const here = dirname(fileURLToPath(import.meta.url));
const adapter = autoAdapterFor('biobuzz');

interface Pose {
  xIn: number;
  yIn: number;
  headingRad?: number;
}

/** A BLUE-side routine from the TOP · SIDE WALL anchor (63.17, 45, pi). */
function probeAuto(alliance: 'RED' | 'BLUE' = 'BLUE'): Record<string, unknown> {
  return {
    formatVersion: 3,
    name: 'lane-probe',
    alliance,
    start: { pose: { xIn: 61.6, yIn: 45, headingRad: Math.PI } },
    steps: [
      {
        id: 'line',
        kind: 'path',
        segments: [{ kind: 'line', from: 'current', to: { xIn: 40, yIn: 45 } }],
        heading: { mode: 'constant', headingRad: Math.PI },
      },
      {
        id: 'turn',
        kind: 'path',
        segments: [{ kind: 'line', from: 'current', to: { xIn: 40, yIn: 30 } }],
        heading: { mode: 'linear', fromRad: Math.PI, toRad: -Math.PI / 2 },
      },
      {
        id: 'curve',
        kind: 'path',
        segments: [
          { kind: 'bezier', from: 'current', control: [{ xIn: 40, yIn: 0 }, { xIn: 50, yIn: -10 }], to: { xIn: 50, yIn: -40 } },
        ],
        heading: { mode: 'tangent' },
      },
      {
        id: 'face',
        kind: 'path',
        segments: [{ kind: 'line', from: 'current', to: { xIn: 36, yIn: -30 } }],
        heading: { mode: 'facePoint', xIn: 12.75, yIn: 0 },
      },
      {
        id: 'back',
        kind: 'path',
        segments: [{ kind: 'line', from: 'current', to: { xIn: 50, yIn: -10 } }],
        heading: { mode: 'tangentReversed' },
      },
    ],
  };
}

const zen = (auto: Record<string, unknown>, waypoints?: string): ZenithAutoSetup => ({
  auto: JSON.stringify(auto),
  ...(waypoints ? { waypoints } : {}),
});

/** A match world with robot 0 seated where the auto starts, and its seat. */
function stage(
  z: ZenithAutoSetup,
  alliance: Alliance,
  physics: '2d' | '3d',
  extra: Partial<RobotSetup> = {},
): { world: World; seat: AutoSeat; setup: RobotSetup } {
  if (!adapter) throw new Error('BIOBUZZ has no auto adapter');
  const base = { ...setup(0, alliance, {}, 2), zenithAuto: z, ...extra };
  // seat the robot at the auto's start through the same canonical conversion the match setup uses
  const probeWorld = BIOBUZZ_SIM.createWorld('match', 7, [base], undefined, physics);
  const probe = createAutoSeat(probeWorld, 0, z, adapter);
  const s: RobotSetup = probe.loaded ? { ...base, startPose: autoStartPose(probe.loaded, alliance, adapter) } : base;
  const world = BIOBUZZ_SIM.createWorld('match', 7, [s], undefined, physics);
  return { world, seat: createAutoSeat(world, 0, z, adapter), setup: s };
}

interface Log {
  ticks: number;
  /** the largest per-tick heading change, rad, and the per-tick position change, in */
  maxDh: number;
  maxDp: number;
  commands: RobotCommand[];
  /** the pose at the end of each step, by step id */
  stepEnds: Map<string, { x: number; y: number; h: number }>;
  /** every pose, for the cross-track check */
  poses: { x: number; y: number; step: string | null }[];
}

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** Tick the seat into the step, the way the controller does, until done or `maxS`. */
function drive(world: World, seat: AutoSeat, maxS: number, driver: RobotCommand = cmd({})): Log {
  const commands = new Map<number, RobotCommand>();
  const log: Log = { ticks: 0, maxDh: 0, maxDp: 0, commands: [], stepEnds: new Map(), poses: [] };
  let prev = { x: world.robots[0].pos.x, y: world.robots[0].pos.y, h: world.robots[0].heading };
  let step: string | null = null;
  for (let i = 0; i < Math.round(maxS / SIM_DT); i++) {
    const c = localizeCommand(seat.step(world, driver));
    commands.set(0, c);
    log.commands.push(c);
    world.events.length = 0;
    BIOBUZZ_SIM.step(world, SIM_DT, commands);
    const r = world.robots[0];
    log.maxDh = Math.max(log.maxDh, Math.abs(wrap(r.heading - prev.h)));
    log.maxDp = Math.max(log.maxDp, Math.hypot(r.pos.x - prev.x, r.pos.y - prev.y));
    prev = { x: r.pos.x, y: r.pos.y, h: r.heading };
    const now = seat.status().stepId;
    if (step !== null && now !== step) log.stepEnds.set(step, prev);
    step = now;
    log.poses.push({ x: r.pos.x, y: r.pos.y, step: now });
    log.ticks++;
    if (seat.status().state === 'done') break;
  }
  if (step !== null) log.stepEnds.set(step, prev);
  return log;
}

function pollen(world: World, x: number, y: number): Artifact {
  const b: Artifact = {
    id: 9000 + world.balls.length,
    color: 'yellow',
    r: BB_POLLEN_R,
    state: { kind: 'ground' },
    pos: { x, y },
    vel: { x: 0, y: 0 },
    z: 0,
    vz: 0,
  };
  world.balls.push(b);
  return b;
}

export function autoChecks(check: Check): void {
  check('AUTO: BIOBUZZ has an auto adapter', adapter !== null);
  if (!adapter) return;

  // ── the seam: the main-chunk flag and the lazy registry agree, for every game ─────────────
  for (const g of GAME_IDS) {
    check(
      `AUTO: ${g}'s zenithAutos flag matches the auto registry`,
      (simModuleFor(g).zenithAutos === true) === (autoAdapterFor(g) !== null),
    );
  }
  const text = JSON.stringify(probeAuto());
  const kept = coerceSetup({ ...setup(0, 'blue'), zenithAuto: { auto: text } }, 'biobuzz');
  check('AUTO: coerceSetup keeps a BIOBUZZ auto byte for byte', kept.zenithAuto?.auto === text);
  const decode = coerceSetup({ ...setup(0, 'blue'), zenithAuto: { auto: text } }, 'decode');
  check('AUTO: coerceSetup drops a Zenith auto for a game that cannot play one', decode.zenithAuto === undefined);
  const huge = coerceSetup({ ...setup(0, 'blue'), zenithAuto: { auto: 'x'.repeat(ZENITH_AUTO_MAX_BYTES + 1) } }, 'biobuzz');
  check('AUTO: coerceSetup drops an auto over the byte bound', huge.zenithAuto === undefined);

  // ── a bad file drives nothing and says why ────────────────────────────────────────────────
  {
    const { world, seat } = stage({ auto: '{"formatVersion": 3, "name": "x"' }, 'blue', '2d');
    startMatch(world);
    const driver = cmd({ driveY: 0.5 });
    const out = seat.step(world, driver);
    const st = seat.status();
    check('AUTO: a malformed file reports an error and hands the driver through', st.state === 'error' && out === driver, st.error);
  }

  // ── it drives, never teleports, and gets there: both physics ──────────────────────────────
  for (const physics of ['2d', '3d'] as const) {
    const { world, seat } = stage(zen(probeAuto()), 'blue', physics);
    const dp = driveParams(world.robots[0].spec);
    const r0 = world.robots[0];
    check(
      `AUTO ${physics}: the robot is seated at the auto's start pose`,
      Math.hypot(r0.pos.x - 61.6, r0.pos.y - 45) < 0.6 && Math.abs(wrap(r0.heading - Math.PI)) < 0.01,
      `at (${r0.pos.x.toFixed(2)}, ${r0.pos.y.toFixed(2)}, ${r0.heading.toFixed(3)})`,
    );
    startMatch(world);
    const log = drive(world, seat, 12);
    const st = seat.status();
    check(`AUTO ${physics}: the routine finishes inside the AUTO period`, st.state === 'done' && log.ticks * SIM_DT < 30, `${st.state} after ${(log.ticks * SIM_DT).toFixed(2)} s`);
    // THE NO-TELEPORT PROPERTY. The drivetrain turns at most maxTurn and drives at most
    // maxSpeed; 5 % covers a contact-free Rapier solve's rounding. A heading written from
    // outside the drivetrain is a jump of whatever the snap was, and fails this at once.
    check(
      `AUTO ${physics}: the heading never moves faster than the drivetrain turns (no heading teleport)`,
      log.maxDh <= dp.maxTurn * SIM_DT * 1.05,
      `max ${log.maxDh.toFixed(4)} rad/tick, limit ${(dp.maxTurn * SIM_DT).toFixed(4)}`,
    );
    check(
      `AUTO ${physics}: the robot never moves faster than the drivetrain drives (no pose teleport)`,
      log.maxDp <= dp.maxSpeed * SIM_DT * 1.05,
      `max ${log.maxDp.toFixed(3)} in/tick, limit ${(dp.maxSpeed * SIM_DT).toFixed(3)}`,
    );
    const plan = seat.loaded!.plan;
    for (const ps of plan.steps) {
      const end = log.stepEnds.get(ps.id);
      const want = ps.endPose;
      if (!end || !want) {
        check(`AUTO ${physics}: step "${ps.id}" ran`, false);
        continue;
      }
      // Pedro hands over at t = 0.975 while still moving, so an intermediate end is judged
      // loosely; the LAST step is followed by the hold, and is judged at the end of the run.
      // The heading bound is the looser one: a P-only heading loop (the robot's measured 2.52
      // power/rad) lags a sweep by about rate / (P * maxTurn), and a 90° linear sweep over a
      // 15 in leg hands over ~11° short — on the robot too — and finishes the turn on the next leg.
      const last = ps === plan.steps[plan.steps.length - 1];
      const r = world.robots[0];
      const at = last ? { x: r.pos.x, y: r.pos.y, h: r.heading } : end;
      const dPos = Math.hypot(at.x - want.xIn, at.y - want.yIn);
      const dH = Math.abs(wrap(at.h - (want.headingRad ?? 0)));
      check(
        `AUTO ${physics}: step "${ps.id}" ends where the plan does`,
        last ? dPos < 1 && dH < 0.05 : dPos < 4 && dH < 0.25,
        `${dPos.toFixed(2)} in and ${((dH * 180) / Math.PI).toFixed(1)}° off`,
      );
    }
    // cross-track on the curve: every pose within 3 in of the planned samples
    const curve = plan.steps.find((s) => s.id === 'curve')!;
    let worst = 0;
    for (const p of log.poses) {
      if (p.step !== 'curve') continue;
      let best = Infinity;
      for (const s of curve.samples) best = Math.min(best, Math.hypot(s.pose.xIn - p.x, s.pose.yIn - p.y));
      worst = Math.max(worst, best);
    }
    check(`AUTO ${physics}: the bezier leg stays within 3 in of the planned curve`, worst < 3, `worst ${worst.toFixed(2)} in`);
  }

  // ── the alliance rule: mirror iff the robot plays the other alliance ─────────────────────
  {
    const blue = stage(zen(probeAuto('BLUE')), 'blue', '2d');
    const red = stage(zen(probeAuto('BLUE')), 'red', '2d');
    const redFile = stage(zen(probeAuto('RED')), 'red', '2d');
    check('AUTO: a BLUE file on a BLUE robot is not mirrored', blue.seat.loaded?.mirrored === false);
    check('AUTO: a BLUE file on a RED robot is mirrored', red.seat.loaded?.mirrored === true);
    check('AUTO: a RED file on a RED robot is not mirrored twice', redFile.seat.loaded?.mirrored === false);
    startMatch(blue.world);
    startMatch(red.world);
    drive(blue.world, blue.seat, 12);
    drive(red.world, red.seat, 12);
    const b = blue.world.robots[0];
    const r = red.world.robots[0];
    const dPos = Math.hypot(r.pos.x + b.pos.x, r.pos.y + b.pos.y);
    const dH = Math.abs(wrap(r.heading - (b.heading + Math.PI)));
    check(
      'AUTO: the RED run ends at the point mirror of the BLUE run, heading included',
      dPos < 0.5 && dH < 0.02,
      `${dPos.toFixed(3)} in, ${dH.toFixed(4)} rad`,
    );
  }

  // ── determinism, and a replay needs no seat ──────────────────────────────────────────────
  {
    const a = stage(zen(probeAuto()), 'blue', '2d');
    const b = stage(zen(probeAuto()), 'blue', '2d');
    startMatch(a.world);
    startMatch(b.world);
    const la = drive(a.world, a.seat, 6);
    drive(b.world, b.seat, 6);
    const ra = a.world.robots[0];
    const rb = b.world.robots[0];
    check('AUTO: two runs of one auto are identical', ra.pos.x === rb.pos.x && ra.pos.y === rb.pos.y && ra.heading === rb.heading);
    // replay: the recorded commands, stepped with no seat, give the same world
    const replay = BIOBUZZ_SIM.createWorld('match', 7, [a.setup], undefined, '2d');
    startMatch(replay);
    const map = new Map<number, RobotCommand>();
    for (const c of la.commands) {
      map.set(0, c);
      replay.events.length = 0;
      BIOBUZZ_SIM.step(replay, SIM_DT, map);
    }
    const rr = replay.robots[0];
    check(
      'AUTO: replaying the recorded commands with NO seat reproduces the run',
      rr.pos.x === ra.pos.x && rr.pos.y === ra.pos.y && rr.heading === ra.heading,
      `replay (${rr.pos.x}, ${rr.pos.y}) vs run (${ra.pos.x}, ${ra.pos.y})`,
    );
  }

  // ── commands work the mechanisms ─────────────────────────────────────────────────────────
  {
    const auto = {
      ...probeAuto(),
      steps: [
        { id: 'two', kind: 'command', name: 'shootAll', args: { count: 2 } },
        { id: 'hold', kind: 'wait', seconds: 1 },
      ],
    };
    const { world, seat } = stage(zen(auto), 'blue', '2d');
    const before = world.robots[0].hopper.length;
    startMatch(world);
    drive(world, seat, 6);
    const after = world.robots[0].hopper.length;
    check('AUTO: shootAll count:2 launches exactly two of the preload', before >= 2 && before - after === 2, `hopper ${before} -> ${after}`);
  }
  {
    // an intake leg: FORWARD at t = 0 through two pollen lying on the line, then STOP
    const auto = {
      ...probeAuto(),
      steps: [
        { id: 'empty', kind: 'command', name: 'shootAll', args: { count: 4 } },
        {
          id: 'sweep',
          kind: 'path',
          speedFraction: 0.4,
          segments: [{ kind: 'line', from: 'current', to: { xIn: 34, yIn: 45 } }],
          heading: { mode: 'constant', headingRad: Math.PI },
          markers: [{ at: { t: 0 }, command: { name: 'setIntake', args: { side: 'BOTH', state: 'FORWARD' } } }],
        },
        { id: 'stop', kind: 'command', name: 'setIntake', args: { side: 'BOTH', state: 'STOP' } },
      ],
    };
    const { world, seat } = stage(zen(auto), 'blue', '2d');
    startMatch(world);
    // empty the hopper first, then lay the pollen once the shots are gone
    let placed = false;
    const commands = new Map<number, RobotCommand>();
    let intakeHeld = false;
    for (let i = 0; i < 60 * 10; i++) {
      if (!placed && world.robots[0].hopper.length === 0 && seat.status().stepId === 'sweep') {
        pollen(world, 45, 45);
        pollen(world, 40, 45);
        placed = true;
      }
      const c = localizeCommand(seat.step(world, cmd({})));
      if (c.intake) intakeHeld = true;
      commands.set(0, c);
      world.events.length = 0;
      BIOBUZZ_SIM.step(world, SIM_DT, commands);
      if (seat.status().state === 'done') break;
    }
    const got = world.robots[0].hopper.length;
    check('AUTO: a setIntake FORWARD marker runs the intake and collects the pollen on the path', placed && intakeHeld && got >= 1, `placed ${placed}, intake ${intakeHeld}, holds ${got}`);
    const last = seat.step(world, cmd({}));
    check('AUTO: setIntake STOP lets go of the intake', last.intake === false);
  }
  {
    // an end condition the host reads: hopperEmpty is already true, so the leg ends at once
    const auto = {
      ...probeAuto(),
      steps: [
        { id: 'empty', kind: 'command', name: 'shootAll', args: { count: 4 } },
        {
          id: 'cut',
          kind: 'path',
          segments: [{ kind: 'line', from: 'current', to: { xIn: 34, yIn: 45 } }],
          heading: { mode: 'constant', headingRad: Math.PI },
          endCondition: { condition: 'hopperEmpty' },
        },
      ],
    };
    const { world, seat } = stage(zen(auto), 'blue', '2d');
    startMatch(world);
    drive(world, seat, 6);
    const cut = seat.trace()?.steps.find((s) => s.id === 'cut');
    check('AUTO: an endCondition that reads true cuts the path at once', cut?.conditionFired === true && world.robots[0].pos.x > 55, `x ${world.robots[0].pos.x.toFixed(1)}`);
  }

  // ── the buzzer and Free Drive: the seat lets go ─────────────────────────────────────────
  {
    const { world, seat } = stage(zen(probeAuto()), 'blue', '2d');
    const driver = cmd({ driveX: 0.25, driveY: -0.5, rotate: 0.1 });
    check('AUTO: before AUTO the seat hands the driver through', seat.step(world, driver) === driver);
    startMatch(world);
    check('AUTO: in AUTO the seat drives', seat.step(world, driver) !== driver);
    world.match.phase = 'teleop';
    check('AUTO: from TELEOP the driver drives again', seat.step(world, driver) === driver && seat.status().state === 'stopped');
  }
  {
    const s = { ...setup(0, 'blue', {}, 2), zenithAuto: zen(probeAuto()) };
    const world = BIOBUZZ_SIM.createWorld('free', 7, [s], undefined, '2d');
    const seat = createAutoSeat(world, 0, s.zenithAuto, adapter);
    const driver = cmd({ driveY: 0.5 });
    check('AUTO: in Free Drive an unarmed seat never drives (the old .pp freeze)', world.match.phase === 'freeplay' && seat.step(world, driver) === driver);
    seat.arm();
    check('AUTO: in Free Drive an armed seat plays the auto', seat.step(world, driver) !== driver && seat.status().state === 'running');
  }

  // ── the team's own file: biobuzz's close.auto.json with its waypoints ────────────────────
  {
    const dir = join(here, 'fixtures', 'zenith');
    const auto = readFileSync(join(dir, 'close.auto.json'), 'utf8');
    const waypoints = readFileSync(join(dir, 'waypoints.json'), 'utf8');
    const red = stage({ auto, waypoints }, 'red', '2d');
    const blue = stage({ auto, waypoints }, 'blue', '2d');
    check('AUTO: close.auto.json loads, refs and all, with nothing it names unsupported', red.seat.loaded !== null && red.seat.loaded.unsupported.length === 0, red.seat.status().error ?? red.seat.loaded?.unsupported.join(', '));
    check('AUTO: close.auto.json (RED) is mirrored for BLUE and not for RED', red.seat.loaded?.mirrored === false && blue.seat.loaded?.mirrored === true);
    startMatch(red.world);
    const before = red.world.robots[0].hopper.length;
    drive(red.world, red.seat, 8);
    const trace = red.seat.trace();
    const shots = trace?.steps.find((s) => s.id === 'Preload shots');
    check(
      'AUTO: close.auto.json drives to its shoot pose and fires the whole preload',
      shots !== undefined && shots.endS > shots.startS && red.world.robots[0].hopper.length === 0 && before === 4,
      `preload ${before}, holds ${red.world.robots[0].hopper.length}, shots ${JSON.stringify(shots)}`,
    );
  }
}
