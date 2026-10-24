import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Alliance, Artifact, RobotCommand, World } from '../../src/types';
import { PRE_COUNTDOWN as C_PRE, SIM_DT } from '../../src/config';
import { BIOBUZZ_SIM } from '../../src/games/biobuzz/sim';
import { BB_FLOWERS, BB_POLLEN_R, BB_RAMP_DEPLOY_S } from '../../src/games/biobuzz/config';
import { bbFootprint, bbRampSettled } from '../../src/games/biobuzz/robot';
import { BIOBUZZ_AUTO_COMMANDS } from '../../src/games/biobuzz/auto';
import type { RobotSpec } from '../../src/types';
import { startMatch } from '../../src/sim/match';
import { coerceSetup, type RobotSetup } from '../../src/sim/spawn';
import { driveParams } from '../../src/sim/drivetrain';
import { localizeCommand } from '../../src/net/protocol';
import { GAME_IDS } from '../../src/games/types';
import { simModuleFor } from '../../src/games/sim';
import { autoAdapterFor, autoStartPose, createAutoSeat, type AutoSeat } from '../../src/auto/zenithAutos';
import { coerceZenithAuto, ZENITH_AUTO_MAX_BYTES } from '../../src/auto/coerce';
import type { ZenithAutoSetup } from '../../src/auto/types';
import { cmd, setup, type Check } from './harness';
import { Room, type Client } from '../../server/room';
import { CLIENT_CAPS, type ServerMsg } from '../../src/net/protocol';
import { BB_DEFAULT_SPEC } from '../../src/games/biobuzz/robotConfig';
import { DEFAULT_ASSISTS } from '../../src/sim/spawn';
import { defaultSettings, practiceSetups, switchGame } from '../../src/settings';
import { AUTO_LIBRARY_MAX, LIBRARY_FULL, autoTooLarge, type AutoLibraryEntry, type GameAutoLibrary } from '../../src/auto/library';
import {
  freeAutoName,
  hostLibraryView,
  LIBRARY_FULL_SAVE,
  leftOutSentence,
  planHostSave,
  readWaypoints,
  samePose,
  type HostLibraryView,
  type HostSaveState,
} from '../../src/auto/hostLibrary';
import { HOST_BUILD, openMessage } from '../../src/ui/zenithOpen';
import { autoHudLine, autoPreNotice } from '../../src/ui/autoHud';
import type { GameAutoStatus } from '../../src/game';
import { BB_PRESET_LIST, BB_STARTER_BOTS } from '../../src/games/biobuzz/presets';
import { nonHolonomic } from '../../src/auto/drive';
import { AutoLoadError, loadZenithAuto, parseAutoText } from '../../src/auto/load';
import { runAutoHeadless } from '../../src/auto/headless';
import { bbAimWindowS, bbShotPatienceS } from '../../src/games/biobuzz/auto';
import { dequantizeCommand, quantizeCommand, sanitizeQCommand, SEAT_ONLY_BUTTONS } from '../../src/net/protocol';
import { bbLauncherOf } from '../../src/games/biobuzz/mechs';
import { FORMAT_VERSIONS } from '@horizon36596/zenith-schema';
import zenithBiobuzzField from '@horizon36596/zenith-season-biobuzz/field/biobuzz.field.json' with { type: 'json' };

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

/** A build with the deployable ramp intake, everything else the default. */
const RAMP_BUILD: Partial<RobotSpec> = {
  ...BB_DEFAULT_SPEC,
  intakeMount: 'front',
  bbMech: { ...BB_DEFAULT_SPEC.bbMech, intake: { kind: 'ramp' } } as unknown as RobotSpec['bbMech'],
};

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
  // ── the field DSIM hands Zenith: positions move with DSIM's walls, sizes do not ─────────────
  {
    const field = adapter.field() as {
      sizeIn: { xIn: number };
      zones: Array<{ id: string; minXIn: number }>;
      elements: Array<{ id: string; xIn: number; radiusIn?: number }>;
    };
    const wall = -field.sizeIn.xIn / 2;
    const zone = field.zones.find((z) => z.id === 'loadingZoneRed');
    check(
      "AUTO: the handed field's red loading zone starts at DSIM's wall, not at Zenith's 72",
      zone !== undefined && Math.abs(zone.minXIn - wall) < 1e-3,
      `minXIn ${String(zone?.minXIn)}, wall ${String(wall)}`,
    );
    const pollen = field.elements.find((e) => e.id === 'gardenRed0');
    check(
      "AUTO: the handed field moves a garden pollen inside DSIM's wall and keeps its radius",
      pollen !== undefined && pollen.xIn > -70.6 && pollen.radiusIn === 1.4,
      `xIn ${String(pollen?.xIn)}, radiusIn ${String(pollen?.radiusIn)}`,
    );
  }
  {
    // EVERY POSITION MOVED, NESTED ONES INCLUDED. Walks Zenith's own file beside the handed one: a
    // number under an x key is scaled by DSIM's wall over Zenith's, one under a y key likewise, and
    // every other number (a height, a radius) is kept. Field format 3's struts carry their ends as
    // `fromIn`/`toIn` objects, which the first version of the scale skipped (the HIVE frame's legs
    // stayed at Zenith's 144 in while their foot bars moved).
    type Json = Record<string, unknown>;
    const handed = adapter.field() as Json & { sizeIn: { xIn: number; yIn: number } };
    const raw = zenithBiobuzzField as unknown as Json & { sizeIn: { xIn: number; yIn: number } };
    const kx = handed.sizeIn.xIn / raw.sizeIn.xIn;
    const ky = handed.sizeIn.yIn / raw.sizeIn.yIn;
    const bad: string[] = [];
    let moved = 0;
    const walk = (r: unknown, h: unknown, path: string, key: string): void => {
      if (typeof r === 'number') {
        const want = /^(xIn|minXIn|maxXIn)$/.test(key) ? r * kx : /^(yIn|minYIn|maxYIn)$/.test(key) ? r * ky : r;
        if (want !== r) moved++;
        if (typeof h !== 'number' || Math.abs(h - want) > 1e-3) bad.push(`${path} ${r} -> ${String(h)} (want ${want.toFixed(4)})`);
      } else if (r !== null && typeof r === 'object') {
        for (const [k, v] of Object.entries(r)) walk(v, (h as Json | undefined)?.[k], `${path}.${k}`, k);
      }
    };
    for (const list of ['obstacles', 'zones', 'elements'] as const) {
      const rs = (raw[list] ?? []) as Json[];
      const hs = (handed[list] ?? []) as Json[];
      rs.forEach((o, i) => walk(o, hs[i], `${list}.${String(o.id)}`, ''));
    }
    const struts = ((handed.obstacles ?? []) as Json[]).filter((o) => o.kind === 'strut');
    check(
      "AUTO: every plan-view position in the handed field is in DSIM's frame, struts' ends included, and every height and size is kept",
      bad.length === 0 && moved > 0 && struts.length === 4,
      bad.length ? bad.slice(0, 4).join(' | ') : `${moved} numbers moved, ${struts.length} struts`,
    );
    // ...and the legs land on DSIM's own HIVE frame (FIRST's CAD, `field-measurements.json`): each
    // foot inside 0.5 in of the A-frame leg's measured footprint, each top within 0.5 in of the
    // pivot's x. Zenith's legs are CAD numbers already, so the scale moves them 0.44 in inboard;
    // measured 2026-10-24, the feet sit inside the footprint and the tops 0.25 in off the pivot.
    const cad = JSON.parse(readFileSync(join(here, '..', '..', 'public', 'models', 'biobuzz', 'field-measurements.json'), 'utf8')) as {
      hive: { frameLegFootprints: { part: string; x: [number, number]; y: [number, number] }[]; trays: { blue: { pivot: [number, number, number] } } };
    };
    const legs = cad.hive.frameLegFootprints.filter((p) => /A-Frame Leg/.test(p.part));
    const pivotX = cad.hive.trays.blue.pivot[0];
    const TOL = 0.5;
    const off = (v: number, [a, b]: [number, number]): number => (v < a ? a - v : v > b ? v - b : 0);
    let worstFoot = 0;
    let worstTop = 0;
    for (const s of struts) {
      const from = s.fromIn as { xIn: number; yIn: number };
      const to = s.toIn as { xIn: number; yIn: number };
      const foot = Math.min(...legs.map((l) => Math.hypot(off(from.xIn, l.x), off(from.yIn, l.y))));
      worstFoot = Math.max(worstFoot, foot);
      worstTop = Math.max(worstTop, Math.abs(Math.abs(to.xIn) - pivotX));
    }
    check(
      `AUTO: the handed field's HIVE frame legs sit on DSIM's measured frame (feet within ${TOL} in of the leg footprints, tops within ${TOL} in of the pivot)`,
      legs.length === 4 && struts.length === 4 && worstFoot <= TOL && worstTop <= TOL,
      `feet ${worstFoot.toFixed(2)} in out, tops ${worstTop.toFixed(2)} in off`,
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
      // The heading bound is the looser one: a P-only heading loop (DSIM's 3 power/rad, from
      // src/games/biobuzz/auto) lags a sweep by about rate / (P * maxTurn), and a 90° linear sweep
      // over a 15 in leg hands over ~8-12° short and finishes the turn on the next leg.
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

  // ── setRamp: the driver's RAMP toggle, pressed by the auto (DSIM only; the robot has no ramp) ─
  {
    check('AUTO: setRamp is a command the BIOBUZZ adapter runs', (BIOBUZZ_AUTO_COMMANDS as readonly string[]).includes('setRamp') && adapter.commands.includes('setRamp'));
    type Cmd = { name: string; summary?: string; params?: { state?: { type: string; values?: string[] } }; requires?: string[] };
    for (const [label, spec] of [
      ['a ramp build', { ...BB_DEFAULT_SPEC, ...RAMP_BUILD }],
      ['a build without a ramp', BB_DEFAULT_SPEC],
    ] as const) {
      const file = adapter.robot(spec as RobotSpec) as { commands: Cmd[] };
      const c = file.commands.find((x) => x.name === 'setRamp');
      check(
        `AUTO: the robot file handed to Zenith lists setRamp with a DEPLOY/STOW state, for ${label}`,
        c !== undefined && c.params?.state?.type === 'enum' && c.params.state.values?.join() === 'DEPLOY,STOW' && !!c.summary && !(c.requires ?? []).includes('intake'),
        JSON.stringify(c),
      );
    }
    {
      // DSIM-9: the summary read "This build has no ramp, so it ends at once. DSIM only: the team
      // robot has no ramp." and the panel's "Not on this robot" line said it a third time
      const file = adapter.robot(BB_DEFAULT_SPEC as RobotSpec) as { commands: Cmd[] };
      const summary = file.commands.find((x) => x.name === 'setRamp')?.summary ?? '';
      const why = adapter.notOnRobot?.(BB_DEFAULT_SPEC as RobotSpec).setRamp ?? '';
      check(
        "AUTO: without a ramp, setRamp's summary says \"no ramp\" once, and the panel's reason leaves \"at once\" to the panel",
        (summary.match(/no ramp/gi) ?? []).length === 1 && /ends at once/.test(summary) && why.length > 0 && !/at once/.test(why),
        `${summary} | ${why}`,
      );
    }
    const rampAuto = {
      ...probeAuto(),
      steps: [
        { id: 'deploy', kind: 'command', name: 'setRamp', args: { state: 'DEPLOY' } },
        { id: 'hold', kind: 'wait', seconds: 0.5 },
        { id: 'stow', kind: 'command', name: 'setRamp', args: { state: 'STOW' } },
        { id: 'again', kind: 'command', name: 'setRamp', args: { state: 'STOW' } },
      ],
    };
    for (const physics of ['2d', '3d'] as const) {
      const { world, seat } = stage(zen(rampAuto), 'blue', physics, { spec: { ...BB_DEFAULT_SPEC, ...RAMP_BUILD } as RobotSpec });
      // SCHEMA is Zenith's "robot.json does not register this command" (the probe's start pose is
      // tuned for the default footprint, so its start-legality finding is not this check's business)
      const errors = seat.loaded?.findings.filter((f) => f.code === 'SCHEMA') ?? [];
      check(`AUTO ${physics}: a setRamp auto has no Zenith SCHEMA finding on a ramp build, and nothing is listed against it`, seat.loaded !== null && errors.length === 0 && seat.loaded.unsupported.length === 0 && seat.loaded.notOnRobot.length === 0, errors.map((f) => f.message).join(' | '));
      startMatch(world);
      const r = world.robots[0];
      const x0 = r.pos.x;
      const commands = new Map<number, RobotCommand>();
      let deployedAtHold: boolean | null = null;
      let pressedTicks = 0;
      let lastCmd: RobotCommand | null = null;
      for (let i = 0; i < 60 * 3 && seat.status().state !== 'done'; i++) {
        const c = localizeCommand(seat.step(world, cmd({})));
        if (c.bbRamp) pressedTicks++;
        if (deployedAtHold === null && seat.status().stepId === 'hold') deployedAtHold = bbRampSettled(r, world.time);
        commands.set(0, c);
        lastCmd = c;
        world.events.length = 0;
        BIOBUZZ_SIM.step(world, SIM_DT, commands);
      }
      const t = seat.trace()?.steps ?? [];
      const dep = t.find((s) => s.id === 'deploy');
      const again = t.find((s) => s.id === 'again');
      check(`AUTO ${physics}: setRamp DEPLOY presses the RAMP button and ends with the ramp deployed and settled`, deployedAtHold === true && pressedTicks >= 2, `settled at the wait ${String(deployedAtHold)}, pressed ${pressedTicks} ticks`);
      check(
        `AUTO ${physics}: ...taking the swing and no more (about ${BB_RAMP_DEPLOY_S} s)`,
        dep !== undefined && dep.endS - dep.startS >= BB_RAMP_DEPLOY_S - 1e-6 && dep.endS - dep.startS <= BB_RAMP_DEPLOY_S + 0.15,
        dep ? `${(dep.endS - dep.startS).toFixed(3)} s` : 'no trace step',
      );
      check(`AUTO ${physics}: setRamp STOW folds it again, and the routine finishes`, seat.status().state === 'done' && r.bbRampOut === false && bbRampSettled(r, world.time) === false, `${seat.status().state}, out ${String(r.bbRampOut)}`);
      check(`AUTO ${physics}: setRamp STOW on a stowed ramp ends at once and presses nothing`, again !== undefined && again.endS - again.startS <= SIM_DT + 1e-6 && lastCmd?.bbRamp !== true, again ? `${(again.endS - again.startS).toFixed(3)} s` : 'no trace step');
      check(`AUTO ${physics}: setRamp never moves the robot`, Math.abs(r.pos.x - x0) < 0.25, `moved ${(r.pos.x - x0).toFixed(3)} in`);
    }
    {
      // THE POINT OF IT: an auto that deploys the ramp and drives into a FLOWER pulls POLLEN out
      // (the match's own staged columns, F3 on BLUE's right wall). The path ends 1 in past flush so
      // the follower keeps pressing, the way a driver holds the stick; the same run WITHOUT the
      // deploy takes nothing, so the extraction is the command's doing and not the drive's.
      // Measured 2026-09-27 over four approaches (lateral -1.5…+1 in, speed 0.35…1.0, 14…20 in
      // out): all four took all four POLLEN in both physics, the first one 0.65…1.17 s in.
      const f = BB_FLOWERS[2];
      const spec = { ...BB_DEFAULT_SPEC, ...RAMP_BUILD } as RobotSpec;
      const foot = bbFootprint(spec).front;
      const flowerAuto = (deploy: boolean): Record<string, unknown> => ({
        formatVersion: 3,
        name: 'lane-ramp-flower',
        alliance: 'BLUE',
        start: { pose: { xIn: f.x - foot - 14, yIn: f.y + 1, headingRad: 0 } },
        steps: [
          ...(deploy ? [{ id: 'deploy', kind: 'command', name: 'setRamp', args: { state: 'DEPLOY' } }] : []),
          { id: 'on', kind: 'command', name: 'setIntake', args: { side: 'BOTH', state: 'FORWARD' } },
          {
            id: 'in',
            kind: 'path',
            speedFraction: 0.8,
            segments: [{ kind: 'line', from: 'current', to: { xIn: f.x - foot + 1, yIn: f.y + 1 } }],
            heading: { mode: 'constant', headingRad: 0 },
          },
        ],
      });
      const extract = (physics: '2d' | '3d', deploy: boolean): { got: number; out: boolean } => {
        const { world, seat } = stage(zen(flowerAuto(deploy)), 'blue', physics, { spec });
        const r = world.robots[0];
        r.hopper.length = 0; // staging, before the match: an empty hopper so the intake can take
        startMatch(world);
        drive(world, seat, 3);
        return { got: r.hopper.length, out: r.bbRampOut === true };
      };
      for (const physics of ['2d', '3d'] as const) {
        const q = extract(physics, true);
        check(`AUTO ${physics}: an auto that runs setRamp DEPLOY and drives into a FLOWER pulls POLLEN out of it`, q.got >= 1 && q.out, `hopper ${q.got}, ramp out ${q.out}`);
      }
      const none = extract('2d', false);
      check('AUTO 2d: ...and the same drive with the ramp left folded takes nothing', none.got === 0 && !none.out, `hopper ${none.got}`);
    }
    {
      // NO RAMP: done at once, the button never pressed, and the panel says why
      const { world, seat } = stage(zen(rampAuto), 'blue', '2d');
      const why = seat.loaded?.notOnRobot.find((c) => c.name === 'setRamp');
      check('AUTO: on a build without a ramp the panel lists setRamp as not on this robot, and not as unknown to DSIM', why !== undefined && /no ramp/.test(why.why) && seat.loaded?.unsupported.length === 0, JSON.stringify(seat.loaded?.notOnRobot));
      startMatch(world);
      let pressed = false;
      const log = drive(world, seat, 3);
      for (const c of log.commands) if (c.bbRamp) pressed = true;
      const dep = seat.trace()?.steps.find((s) => s.id === 'deploy');
      check(
        'AUTO: on a build without a ramp setRamp ends at once, presses nothing, and the routine carries on',
        seat.status().state === 'done' && !pressed && dep !== undefined && dep.endS - dep.startS <= SIM_DT + 1e-6 && world.robots[0].bbRampOut === undefined,
        `${seat.status().state}, pressed ${pressed}, took ${dep ? (dep.endS - dep.startS).toFixed(3) : '?'} s`,
      );
    }
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

  // ── the demo routine: a whole AUTO cycle on DSIM's field, Zenith-clean ─────────────────────
  {
    const auto = readFileSync(join(here, 'fixtures', 'zenith', 'garden-cycle.auto.json'), 'utf8');
    const { world, seat } = stage({ auto }, 'red', '2d');
    const errors = seat.loaded?.findings.filter((f) => f.severity === 'error') ?? [];
    check('AUTO: garden-cycle plans with no Zenith errors against the DSIM robot and field', seat.loaded !== null && errors.length === 0, errors.map((f) => `${f.code}: ${f.message}`).join(' | '));
    startMatch(world);
    let most = 0;
    let fired = 0;
    const commands = new Map<number, RobotCommand>();
    for (let i = 0; i < 60 * 30 && seat.status().state !== 'done'; i++) {
      const before = world.robots[0].hopper.length;
      commands.set(0, localizeCommand(seat.step(world, cmd({}))));
      world.events.length = 0;
      BIOBUZZ_SIM.step(world, SIM_DT, commands);
      const after = world.robots[0].hopper.length;
      if (after < before) fired += before - after;
      most = Math.max(most, after);
    }
    const r = world.robots[0];
    const inZone = r.pos.x < -59.101 + 9 && r.pos.y > 23.907 - 9 && r.pos.y < 46.599 + 9;
    check(
      'AUTO: garden-cycle finishes inside AUTO, fires the preload, collects in the garden and ends at the loading zone',
      seat.status().state === 'done' && fired >= 5 && inZone,
      `state ${seat.status().state}, fired ${fired}, end (${r.pos.x.toFixed(1)}, ${r.pos.y.toFixed(1)})`,
    );
  }

  // ── CUSTOM ROOMS: the server drives the robot (owner, 2026-09-25: custom only) ────────────
  {
    const mk = (id: string, alliance: Alliance, sink: ServerMsg[]): Client => ({
      id,
      send: (m) => sink.push(JSON.parse(JSON.stringify(m)) as ServerMsg),
      player: {
        clientId: id,
        name: id,
        teamName: 'Smoke',
        teamNumber: 1,
        alliance,
        startIndex: 0,
        ready: true,
        spec: { ...BB_DEFAULT_SPEC },
        assists: { ...DEFAULT_ASSISTS, fieldCentric: false, aimAssist: false },
      },
      connected: true,
      disconnectAt: 0,
      caps: CLIENT_CAPS,
    });
    const auto = readFileSync(join(here, 'fixtures', 'zenith', 'garden-cycle.auto.json'), 'utf8');
    const seen: ServerMsg[] = [];
    const room = new Room('auto-cust', () => {}, { kind: 'versus', game: 'biobuzz', physics: '2d' });
    room.add(mk('au-a', 'red', seen));
    room.onMessage('au-a', { t: 'zenithAuto', auto: { auto } });
    const roster = [...seen].reverse().find((m) => m.t === 'roster') as Extract<ServerMsg, { t: 'roster' }> | undefined;
    check('AUTO room: the roster names the auto, and carries no file', roster?.players[0]?.autoName === 'garden-cycle' && !JSON.stringify(roster).includes('"steps"'), JSON.stringify(roster?.players[0]?.autoName));
    // a BIOBUZZ room is 3D on the server whatever it asks for, so it waits for the seat's 3D chunk
    room.onMessage('au-a', { t: 'physicsReady' });
    room.onMessage('au-a', { t: 'start' });
    const start = seen.find((m) => m.t === 'matchStart') as Extract<ServerMsg, { t: 'matchStart' }> | undefined;
    const mine = start?.setups.find((x) => x.id === 0);
    check('AUTO room: the match setup carries the auto', mine?.zenithAuto?.auto === auto);
    const world = (room as unknown as { world: World }).world;
    const r = world.robots[0];
    check(
      'AUTO room: the robot is seated at the auto’s start (a RED file, a RED robot)',
      Math.hypot(r.pos.x + 34, r.pos.y + 63.17) < 1 && Math.abs(wrap(r.heading - Math.PI / 2)) < 0.02,
      `(${r.pos.x.toFixed(2)}, ${r.pos.y.toFixed(2)}, ${r.heading.toFixed(3)})`,
    );
    // no input is ever sent: the server's own seat has to drive it
    room.advanceForTest(Math.round((C_PRE + 9) / SIM_DT));
    const moved = Math.hypot(world.robots[0].pos.x + 34, world.robots[0].pos.y + 63.17);
    check('AUTO room: with no input from the client, the SERVER’s seat drives the robot through AUTO', world.match.phase === 'auto' && moved > 20 && world.robots[0].hopper.length < 4, `phase ${world.match.phase}, moved ${moved.toFixed(1)} in, hopper ${world.robots[0].hopper.length}`);
    room.advanceForTest(1);
  }
  {
    // a RECORD room refuses one, with a line that says why, and its roster names nothing
    const seen: ServerMsg[] = [];
    const rec = new Room('auto-rec', () => {}, { kind: 'record', record: 'solo', game: 'biobuzz' });
    rec.add({
      id: 'au-r',
      send: (m) => seen.push(m),
      player: { clientId: 'au-r', name: 'r', teamName: 'S', teamNumber: 1, alliance: 'blue', startIndex: 0, ready: true, spec: { ...BB_DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS } },
      connected: true,
      disconnectAt: 0,
      caps: CLIENT_CAPS,
    });
    rec.onMessage('au-r', { t: 'zenithAuto', auto: { auto: JSON.stringify(probeAuto()) } });
    const err = seen.find((m) => m.t === 'error') as Extract<ServerMsg, { t: 'error' }> | undefined;
    check('AUTO room: a RECORD room refuses an auto and says it is custom rooms only', err?.message === 'Autos run in custom rooms only.', err?.message);
    // and a malformed file is refused in the lobby, not left to stand a robot still
    const bad: ServerMsg[] = [];
    const room = new Room('auto-bad', () => {}, { kind: 'versus', game: 'biobuzz', physics: '2d' });
    room.add({
      id: 'au-b',
      send: (m) => bad.push(m),
      player: { clientId: 'au-b', name: 'b', teamName: 'S', teamNumber: 1, alliance: 'blue', startIndex: 0, ready: true, spec: { ...BB_DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS } },
      connected: true,
      disconnectAt: 0,
      caps: CLIENT_CAPS,
    });
    room.onMessage('au-b', { t: 'zenithAuto', auto: { auto: '{"formatVersion":3}' } });
    check('AUTO room: a malformed auto is refused in the lobby', bad.some((m) => m.t === 'error'));
  }

  // ── the robot file DSIM hands Zenith is DSIM's own: no number is carried over from a team ─
  {
    const robotFile = JSON.stringify(autoAdapterFor('biobuzz')!.robot({ ...BB_DEFAULT_SPEC }));
    const labels = [...robotFile.matchAll(/"provenance":"([^"]*)"/g)].map((m) => m[1]);
    const foreign = labels.filter((l) => !/^(SET FROM SIM: DSIM |SET BY HAND: )/.test(l));
    check('AUTO: every number in the robot file DSIM hands Zenith is DSIM\'s own (SET FROM SIM or SET BY HAND)', labels.length > 0 && foreign.length === 0, foreign.join(' | '));
    check('AUTO: the robot file DSIM hands Zenith names no team repository', !/Horizon-36596/i.test(robotFile));
  }

  // ── a file that names every pose by waypoint: preload-park.auto.json with its waypoints ──
  {
    const dir = join(here, 'fixtures', 'zenith');
    const auto = readFileSync(join(dir, 'preload-park.auto.json'), 'utf8');
    const waypoints = readFileSync(join(dir, 'waypoints.json'), 'utf8');
    const red = stage({ auto, waypoints }, 'red', '2d');
    const blue = stage({ auto, waypoints }, 'blue', '2d');
    check('AUTO: preload-park.auto.json loads, refs and all, with nothing it names unsupported', red.seat.loaded !== null && red.seat.loaded.unsupported.length === 0, red.seat.status().error ?? red.seat.loaded?.unsupported.join(', '));
    check('AUTO: preload-park.auto.json (RED) is mirrored for BLUE and not for RED', red.seat.loaded?.mirrored === false && blue.seat.loaded?.mirrored === true);
    startMatch(red.world);
    const before = red.world.robots[0].hopper.length;
    drive(red.world, red.seat, 8);
    const trace = red.seat.trace();
    const shots = trace?.steps.find((s) => s.id === 'preload');
    check(
      'AUTO: preload-park.auto.json drives to its shoot pose and fires the whole preload',
      shots !== undefined && shots.endS > shots.startS && red.world.robots[0].hopper.length === 0 && before === 4,
      `preload ${before}, holds ${red.world.robots[0].hopper.length}, shots ${JSON.stringify(shots)}`,
    );
  }

  // ── solo practice's glue: the partner, the match screen's words, the library's byte cap ────
  {
    // THE PARTNER TAKES THE ANCHOR AWAY FROM THE AUTO'S START, not from `settings.startIndex`.
    // A RED file starting on BOTTOM's anchor, played by BLUE with the setting still on TOP (0):
    // `practiceSetups` used to read the setting, put the partner on BOTTOM, and the two robots
    // spawned inside each other and were thrown apart before AUTO began.
    const file = zen({
      formatVersion: 3,
      name: 'bottom-start',
      alliance: 'RED',
      start: { pose: { xIn: -46, yIn: 63.17, headingRad: -Math.PI / 2 } },
      steps: [{ id: 'out', kind: 'path', segments: [{ kind: 'line', from: 'current', to: { xIn: -46, yIn: 35 } }], heading: { mode: 'constant', headingRad: -Math.PI / 2 } }],
    });
    const base = switchGame(defaultSettings(), 'biobuzz');
    const s = {
      ...base,
      alliance: 'blue' as const,
      startIndex: 0,
      practiceSeats: { ...base.practiceSeats, biobuzz: [{ kind: 'dummy' as const, tier: 'medium' }, { kind: 'none' as const, tier: 'medium' }, { kind: 'none' as const, tier: 'medium' }] as const },
    };
    const probeWorld = BIOBUZZ_SIM.createWorld('match', 11, [{ ...setup(0, 'blue', {}, 2), spec: s.spec }], undefined, '2d');
    const probe = createAutoSeat(probeWorld, 0, file, adapter);
    const start = probe.loaded ? autoStartPose(probe.loaded, 'blue', adapter) : null;
    const near = start ? adapter.defaultStartNear?.(start) : undefined;
    const seat = (index: number) => {
      const me: RobotSetup = { id: 0, alliance: 'blue', spec: s.spec, assists: s.assists, startIndex: s.startIndex, startPose: start ?? undefined, zenithAuto: file };
      const w = BIOBUZZ_SIM.createWorld('match', 11, [me, ...practiceSetups(s, 'biobuzz', 11, index).setups], undefined, '2d');
      const [a, b] = w.robots;
      return { gap: Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y), at: Math.hypot(a.pos.x - 46, a.pos.y + 63.17) };
    };
    check('AUTO solo: the adapter names BOTTOM (1) as the anchor nearest a BOTTOM start', near === 1, String(near));
    const fixed = seat(near ?? s.startIndex);
    const old = seat(s.startIndex);
    check(
      "AUTO solo: the practice partner spawns at the other end from the auto's start, and the robot sits on it",
      fixed.gap > 60 && fixed.at < 1,
      `gap ${fixed.gap.toFixed(1)} in, robot ${fixed.at.toFixed(2)} in off the start`,
    );
    check('AUTO solo: (the bug) seated from the setting, the partner lands on the auto’s start', old.gap < 25, `gap ${old.gap.toFixed(1)} in`);
  }
  {
    // THE MATCH SCREEN SAYS WHEN THE AUTO CANNOT RUN, OR WHAT ZENITH FLAGS IN IT. `problems` is
    // built the way the controller builds it (`seatAuto`: the loaded plan's ERROR findings).
    const status = (seat: AutoSeat, name: string): GameAutoStatus => ({
      ...seat.status(),
      name,
      problems: seat.loaded ? seat.loaded.findings.filter((f) => f.severity === 'error').map((f) => f.message) : [],
    });
    const broken = createAutoSeat(BIOBUZZ_SIM.createWorld('match', 3, [setup(0, 'blue', {}, 2)], undefined, '2d'), 0, { auto: '{"formatVersion":3' }, adapter);
    const off = status(broken, 'broken');
    const pre = autoPreNotice({ auto: off });
    check('AUTO hud: a file the seat cannot load reads AUTO OFF before and during AUTO', autoHudLine({ auto: off, phase: 'pre' }) === 'AUTO OFF' && autoHudLine({ auto: off, phase: 'auto' }) === 'AUTO OFF');
    check('AUTO hud: ...and not once the driver has the robot', autoHudLine({ auto: off, phase: 'teleop' }) === null);
    check('AUTO hud: the pre-match panel says why the auto is off', pre?.tone === 'err' && pre.text.startsWith('Auto off: ') && pre.text.includes(off.error ?? '(no error)'), pre?.text);
    // a RED file whose start is BLUE's anchor, played by BLUE: mirrored into RED's half
    const wrong = stage(
      zen({
        formatVersion: 3,
        name: 'wrong-half',
        alliance: 'RED',
        start: { pose: { xIn: 34, yIn: 63.17, headingRad: -Math.PI / 2 } },
        steps: [{ id: 'leg', kind: 'path', segments: [{ kind: 'line', from: 'current', to: { xIn: 34, yIn: 40 } }], heading: { mode: 'constant', headingRad: -Math.PI / 2 } }],
      }),
      'blue',
      '2d',
    );
    const flagged = status(wrong.seat, 'wrong-half');
    const note = autoPreNotice({ auto: flagged });
    check(
      'AUTO hud: a start Zenith flags (the other half) is named on the pre-match panel, and the auto still plays',
      flagged.state === 'waiting' && note?.tone === 'warn' && /own half/.test(note.text),
      note?.text,
    );
    // garden-cycle plans with no Zenith errors (checked above)
    const clean = stage({ auto: readFileSync(join(here, 'fixtures', 'zenith', 'garden-cycle.auto.json'), 'utf8') }, 'blue', '2d');
    const ok = autoPreNotice({ auto: status(clean.seat, 'garden-cycle') });
    check('AUTO hud: a clean auto is named as the one AUTO plays', ok?.tone === 'ok' && ok.text === 'garden-cycle plays in AUTO.', ok?.text);
  }
  {
    // THE LIBRARY'S BYTE CAP IS SAID, NOT APPLIED IN SILENCE: `saveAutoLibrary` drops an entry
    // `coerceZenithAuto` refuses, so Zenith's Save and the import ask `autoTooLarge` first
    const big = JSON.stringify({ ...probeAuto(), title: 'x'.repeat(ZENITH_AUTO_MAX_BYTES) });
    const fits = JSON.stringify(probeAuto());
    check(
      'AUTO library: an auto over the byte cap is refused with a sentence, exactly where the library would drop it',
      autoTooLarge(big) !== null && coerceZenithAuto({ auto: big }) === undefined && autoTooLarge(fits) === null && coerceZenithAuto({ auto: fits }) !== undefined,
      autoTooLarge(big) ?? 'accepted',
    );
  }

  // ── Zenith's host session: the one waypoints file, a clash, and where a save goes ──────────────
  {
    // `zenith-host/1` carries ONE waypoints file, so DSIM merges its library's into it. Two autos
    // with `start` at different poses cannot share it: the one not opened is left out (and said),
    // and a save never moves a pose an auto already had.
    const wp = (points: Record<string, { xIn: number; yIn: number; headingRad: number; provenance?: string }>): string =>
      JSON.stringify({ formatVersion: 1, waypoints: points });
    const autoText = (name: string, refs: string[]): string =>
      JSON.stringify({
        formatVersion: 3,
        name,
        alliance: 'BLUE',
        start: { pose: { ref: refs[0] } },
        steps: refs.slice(1).map((r, i) => ({ id: `s${i}`, kind: 'path', segments: [{ kind: 'line', from: 'current', to: { ref: r } }], heading: { mode: 'tangent' } })),
      });
    const entry = (id: string, name: string, refs: string[], waypoints?: string): AutoLibraryEntry => ({
      id,
      name,
      auto: autoText(name, refs),
      ...(waypoints ? { waypoints } : {}),
      source: 'zenith',
      savedAt: 0,
    });
    const library = (...entries: AutoLibraryEntry[]): GameAutoLibrary => ({ entries, activeId: null, enabled: false });
    const START = { xIn: 61.6, yIn: 45, headingRad: Math.PI };
    const PARK = { xIn: 40, yIn: 30, headingRad: Math.PI };
    const OTHER_START = { xIn: 34, yIn: 63.17, headingRad: -Math.PI / 2 };
    const points = (v: HostLibraryView): Record<string, unknown> => (v.waypoints?.waypoints ?? {}) as Record<string, unknown>;

    const a = entry('a', 'a-auto', ['start'], wp({ start: START }));
    const b = entry('b', 'b-auto', ['start', 'park'], wp({ start: START, park: PARK }));
    const plain = hostLibraryView(library(b, a), a);
    check(
      'AUTO host: no clash sends every auto, and the one file holds every name',
      Object.keys(plain.autos).sort().join() === 'a-auto,b-auto' &&
        Object.keys(points(plain)).sort().join() === 'park,start' &&
        plain.leftOut.length === 0 &&
        leftOutSentence(plain.leftOut) === null,
      JSON.stringify({ autos: Object.keys(plain.autos), points: Object.keys(points(plain)) }),
    );
    const noted = entry('n', 'noted', ['start'], wp({ start: { ...START, provenance: 'measured on the field' } }));
    const same = hostLibraryView(library(noted, a), a);
    check('AUTO host: the same name at the same pose is not a clash (a note may differ)', same.leftOut.length === 0 && 'noted' in same.autos);

    const c = entry('c', 'c-auto', ['start'], wp({ start: OTHER_START }));
    const clash = hostLibraryView(library(c, b, a), a);
    const sentence = leftOutSentence(clash.leftOut) ?? '';
    check(
      'AUTO host: an auto whose `start` is elsewhere is left out, and the file keeps the opened auto’s pose',
      !('c-auto' in clash.autos) && 'b-auto' in clash.autos && samePose(points(clash).start, START) && clash.leftOut[0]?.name === 'c-auto',
      JSON.stringify(clash.leftOut),
    );
    check(
      'AUTO host: ...and one sentence says which auto, which waypoint, against which auto, and how to edit it',
      !sentence.includes('. ') && sentence.includes('c-auto') && sentence.includes('"start"') && sentence.includes('a-auto') && sentence.includes('Edit in Zenith'),
      sentence,
    );
    const fromC = hostLibraryView(library(c, b, a), c);
    check(
      'AUTO host: Edit in Zenith on the left-out auto makes its file the base (the clashing ones are left out instead)',
      'c-auto' in fromC.autos && !('a-auto' in fromC.autos) && !('b-auto' in fromC.autos) && samePose(points(fromC).start, OTHER_START),
      JSON.stringify(fromC.leftOut.map((l) => l.name)),
    );

    // SAVES. The state is what the session builds from the view it sent.
    const fresh = (v: HostLibraryView): HostSaveState => ({ own: new Set(Object.keys(v.autos)), alias: new Map(), sent: v.waypoints });
    const lib = library(c, b, a);
    // b is saved now using a name only a2's file has: its own poses kept, that one name added
    const a2 = entry('a2', 'a2-auto', ['start', 'dock'], wp({ start: START, dock: { xIn: 50, yIn: 10, headingRad: 0 } }));
    const lib2 = library(c, b, a2);
    const bSave = planHostSave(lib2, fresh(hostLibraryView(lib2, a2)), 'b-auto', autoText('b-auto', ['start', 'park', 'dock']));
    const bPoints = bSave.ok ? (readWaypoints(bSave.entry.waypoints)?.waypoints ?? {}) : {};
    check(
      'AUTO host save: an auto keeps its own poses and gains only the names it now uses from the merged file',
      bSave.ok && bSave.target === 'b-auto' && bSave.entry.id === 'b' && samePose(bPoints.start, START) && samePose(bPoints.park, PARK) && 'dock' in bPoints && Object.keys(bPoints).length === 3,
      JSON.stringify(bPoints),
    );
    // a session that showed ANOTHER pose under b's names: the save still stores b's own file
    const skewed: HostSaveState = {
      own: new Set(['b-auto']),
      alias: new Map(),
      sent: { formatVersion: 1, waypoints: { start: { xIn: 0, yIn: 0, headingRad: 0 }, park: { xIn: 1, yIn: 1, headingRad: 0 } } },
    };
    const bKeep = planHostSave(lib, skewed, 'b-auto', autoText('b-auto', ['start', 'park']));
    check(
      'AUTO host save: a save never replaces a pose the auto already had, whatever the session showed',
      bKeep.ok && bKeep.entry.waypoints === b.waypoints,
      bKeep.ok ? bKeep.entry.waypoints : bKeep.error,
    );
    // a left-out auto's name (any name the session never sent) is never written over
    const stA = fresh(hostLibraryView(lib, a));
    const cSave = planHostSave(lib, stA, 'c-auto', autoText('c-auto', ['start']));
    check(
      'AUTO host save: a save under a left-out auto’s name goes to a free name, and the left-out auto is untouched',
      cSave.ok && cSave.target === 'c-auto-2' && cSave.entry.id === undefined && samePose(readWaypoints(cSave.entry.waypoints)?.waypoints?.start, START),
      cSave.ok ? `${cSave.target} ${cSave.entry.waypoints}` : cSave.error,
    );
    // a new auto (no own file) stores the names it uses, from the file Zenith showed it
    const nSave = planHostSave(lib, stA, 'new-auto', autoText('new-auto', ['start', 'park']));
    check(
      'AUTO host save: a new auto stores the waypoints it uses, from the file Zenith drew it against',
      nSave.ok && nSave.target === 'new-auto' && samePose(readWaypoints(nSave.entry.waypoints)?.waypoints?.start, START) && samePose(readWaypoints(nSave.entry.waypoints)?.waypoints?.park, PARK),
      nSave.ok ? nSave.entry.waypoints : nSave.error,
    );
    // ...and that file is one the real loader plays
    if (nSave.ok && adapter) {
      const seat = createAutoSeat(BIOBUZZ_SIM.createWorld('match', 5, [setup(0, 'blue', {}, 0)], undefined, '2d'), 0, { auto: nSave.entry.auto, waypoints: nSave.entry.waypoints }, adapter);
      check('AUTO host save: ...and the stored pair loads', seat.loaded !== null, seat.status().error);
    }
    const full = library(...Array.from({ length: AUTO_LIBRARY_MAX }, (_, i) => entry(`f${i}`, `full-${i}`, ['start'], wp({ start: START }))));
    const fullState = fresh(hostLibraryView(full, full.entries[0]));
    const refused = planHostSave(full, fullState, 'new-auto', autoText('new-auto', ['start']));
    const edited = planHostSave(full, fullState, 'full-3', autoText('full-3', ['start']));
    check(
      'AUTO host save: a NEW auto into a full library is refused with the sentence; an edit of one it holds is not',
      !refused.ok && refused.error === LIBRARY_FULL_SAVE && edited.ok && edited.entry.id === 'f3',
      !refused.ok ? refused.error : 'stored',
    );
    // NEW IN ZENITH sends the library with `newAuto`, and every `open` carries `hostBuild`
    const project = { name: 'DSIM', robot: {}, field: {}, autos: { 'a-auto': a.auto } };
    const asNew = openMessage({ project, newAuto: true, open: 'a-auto' }, true);
    const asEdit = openMessage({ project, open: 'a-auto' }, false);
    check(
      'AUTO host open: a new auto says `newAuto` and no `open`; an edit says `open`; both carry a whole `hostBuild`',
      asNew.newAuto === true && !('open' in asNew) && asEdit.open === 'a-auto' && !('newAuto' in asEdit) &&
        asNew.hostBuild === HOST_BUILD && asEdit.hostBuild === HOST_BUILD && Number.isSafeInteger(HOST_BUILD) && HOST_BUILD >= 0 &&
        asNew.protocol === 'zenith-host/1',
      JSON.stringify({ asNew: { ...asNew, project: undefined }, asEdit: { ...asEdit, project: undefined } }),
    );
    const newView = hostLibraryView(library(c, b, a), null);
    check(
      'AUTO host open: a new auto is sent the library, its base the file most autos agree with (the newer clashing one left out)',
      Object.keys(newView.autos).length === 2 && newView.leftOut.length === 1 && newView.leftOut[0].name === 'c-auto' && samePose(points(newView).start, START),
      JSON.stringify({ autos: Object.keys(newView.autos), leftOut: newView.leftOut.map((l) => l.name) }),
    );
    // Zenith's own naming (`freshAutoName` in its host backend): `new-auto`, else `new-auto-2`, …
    const zenithName = (taken: string[]): string => {
      if (!taken.includes('new-auto')) return 'new-auto';
      let i = 2;
      while (taken.includes(`new-auto-${i}`)) i += 1;
      return `new-auto-${i}`;
    };
    const withNew = library(entry('x', 'new-auto', ['start'], wp({ start: START })), a);
    const sentNew = hostLibraryView(withNew, null);
    const named = zenithName(Object.keys(sentNew.autos));
    const stNew = fresh(sentNew);
    const first = planHostSave(withNew, stNew, named, autoText(named, ['start']));
    check(
      'AUTO host save: the name Zenith gives a new auto is kept, not renamed a second time',
      named === 'new-auto-2' && first.ok && first.target === 'new-auto-2' && first.entry.id === undefined,
      first.ok ? first.target : first.error,
    );
    // ...unless it is a left-out auto's name, which Zenith could not see: renamed once
    const hidden = library(entry('y', 'new-auto', ['start'], wp({ start: OTHER_START })), a);
    const sentHidden = hostLibraryView(hidden, a);
    const hiddenName = zenithName(Object.keys(sentHidden.autos));
    const once = planHostSave(hidden, fresh(sentHidden), hiddenName, autoText(hiddenName, ['start']));
    check(
      'AUTO host save: a new auto under a left-out auto’s name is renamed once (new-auto-2), never new-auto-2-2',
      hiddenName === 'new-auto' && once.ok && once.target === 'new-auto-2',
      once.ok ? once.target : once.error,
    );
    const free = freeAutoName(library(entry('z', 'new-auto-2', ['start']), entry('w', 'new-auto-3', ['start'])), 'new-auto-2');
    check('AUTO host save: a free name counts on from the root, Zenith’s scheme (new-auto-2 taken → new-auto-4)', free === 'new-auto-4', free);
    check(
      'AUTO library: the panel’s full-library reason and the save refusal both name the cap',
      LIBRARY_FULL.includes(`(${AUTO_LIBRARY_MAX})`) && LIBRARY_FULL_SAVE.includes(`(${AUTO_LIBRARY_MAX})`),
    );
  }

  // ── a TANK drives its auto (StarterBot, the kit preset, is a 6WD tank) ───────────────────────
  // Zenith's follower is mecanum-only. The tank used to drop the follower's strafe, so a leg it
  // could not face stalled for the whole period (garden-cycle: ~96 in short, never past its first
  // leg). Now each leg is re-headed nose- or tail-first (`load.ts`) and the request is steered
  // (`drive.ts` `nonHolonomic`).
  {
    const tank = BB_STARTER_BOTS.find((x) => x.drivetrain === 'tank');
    check('AUTO tank: the kit preset is a tank', tank !== undefined);
    if (tank) {
      const behind = nonHolonomic({ forward: -0.6, strafe: 0.1, turn: 0 });
      const left = nonHolonomic({ forward: 0.4, strafe: 0.4, turn: 0 });
      const hold = nonHolonomic({ forward: 0, strafe: 0, turn: 0.3 });
      check(
        "AUTO tank: a request behind is driven in reverse, one to the left turns CCW, a hold keeps the follower's turn",
        behind.forward < 0 && left.turn > 0 && left.forward > 0 && hold.forward === 0 && hold.turn === 0.3,
        JSON.stringify({ behind, left, hold }),
      );
      const robot = adapter?.robot(tank) as { kinematics: { maxForwardVelInPerS: { value: number }; maxStrafeVelInPerS: { value: number } } };
      check(
        "AUTO tank: the robot file's sideways cap is the forward one, not a 1 in/s crawl",
        robot.kinematics.maxStrafeVelInPerS.value === robot.kinematics.maxForwardVelInPerS.value,
        `${robot.kinematics.maxStrafeVelInPerS.value} vs ${robot.kinematics.maxForwardVelInPerS.value}`,
      );
      // a tangent line, a bezier and a tangentReversed leg, in open field on the BLUE side
      const curve = zen({
        formatVersion: 3,
        name: 'tank-curve',
        alliance: 'BLUE',
        start: { pose: { xIn: 61.6, yIn: 45, headingRad: Math.PI } },
        steps: [
          { id: 'line', kind: 'path', segments: [{ kind: 'line', from: 'current', to: { xIn: 40, yIn: 45 } }], heading: { mode: 'tangent' } },
          {
            id: 'curve',
            kind: 'path',
            segments: [{ kind: 'bezier', from: 'current', control: [{ xIn: 40, yIn: 0 }, { xIn: 50, yIn: -10 }], to: { xIn: 50, yIn: -40 } }],
            heading: { mode: 'tangent' },
          },
          { id: 'back', kind: 'path', segments: [{ kind: 'line', from: 'current', to: { xIn: 50, yIn: -10 } }], heading: { mode: 'tangentReversed' } },
        ],
      });
      for (const physics of ['2d', '3d'] as const) {
        for (const alliance of ['blue', 'red'] as const) {
          const { world, seat } = stage(curve, alliance, physics, { spec: tank });
          const dp = driveParams(world.robots[0].spec);
          startMatch(world);
          const log = drive(world, seat, 12);
          const r = world.robots[0];
          const steps = seat.loaded!.plan.steps;
          const end = steps[steps.length - 1].endPose!;
          const err = Math.hypot(r.pos.x - end.xIn, r.pos.y - end.yIn);
          check(
            `AUTO tank ${physics} ${alliance}: a tank drives a line, a curve and a reversed leg to the end`,
            seat.status().state === 'done' && err < 1 && log.ticks * SIM_DT < 5,
            `${seat.status().state} at ${seat.status().stepId}, ${(log.ticks * SIM_DT).toFixed(2)} s, ${err.toFixed(2)} in off`,
          );
          check(
            `AUTO tank ${physics} ${alliance}: ...inside the drivetrain's own turn and speed limits every tick`,
            log.maxDh <= dp.maxTurn * SIM_DT * 1.05 && log.maxDp <= dp.maxSpeed * SIM_DT * 1.05,
            `max ${log.maxDh.toFixed(4)} rad/tick (limit ${(dp.maxTurn * SIM_DT).toFixed(4)}), ${log.maxDp.toFixed(3)} in/tick (limit ${(dp.maxSpeed * SIM_DT).toFixed(3)})`,
          );
        }
      }
      // garden-cycle: constant and sweeping headings a tank cannot hold, so its legs are re-headed
      const gc = readFileSync(join(here, 'fixtures', 'zenith', 'garden-cycle.auto.json'), 'utf8');
      for (const physics of ['2d', '3d'] as const) {
        const { world, seat } = stage({ auto: gc }, 'red', physics, { spec: tank });
        const l = seat.loaded!;
        startMatch(world);
        drive(world, seat, 30);
        const r = world.robots[0];
        const end = l.plan.steps[l.plan.steps.length - 1].endPose!;
        const err = Math.hypot(r.pos.x - end.xIn, r.pos.y - end.yIn);
        check(
          `AUTO tank ${physics}: garden-cycle on a tank is re-headed, estimated inside AUTO, and finishes within 2 in of its park`,
          l.reheaded.length > 0 &&
            (l.estimate.nominalS ?? 99) < 30 &&
            !l.findings.some((f) => f.code === 'TIME_BUDGET' && f.severity !== 'info') &&
            seat.status().state === 'done' &&
            err < 2,
          `reheaded ${l.reheaded.join(', ')}, estimate ${l.estimate.nominalS?.toFixed(1)} s, ${seat.status().state} at ${seat.status().stepId}, ${err.toFixed(2)} in off`,
        );
      }
      const mec = stage({ auto: gc }, 'red', '2d');
      check('AUTO tank: a holonomic build keeps the headings the file wrote', mec.seat.loaded!.reheaded.length === 0);
    }
  }
  {
    // STUCK IS SAID: a path into the wall behind the robot asks for power the wall will not let it
    // use. A wait stands still just as long and is never stuck, and neither is a shove into the
    // wall the author bounded with a `timeoutS` (garden-cycle's `sweep` on a tank does exactly that).
    const into = stage(
      zen({
        formatVersion: 3,
        name: 'into-wall',
        alliance: 'BLUE',
        start: { pose: { xIn: 61.6, yIn: 45, headingRad: Math.PI } },
        steps: [
          { id: 'rest', kind: 'wait', seconds: 3 },
          {
            id: 'shove',
            kind: 'path',
            timeoutS: 2.5,
            segments: [{ kind: 'line', from: 'current', to: { xIn: 80, yIn: 45 } }],
            heading: { mode: 'constant', headingRad: Math.PI },
          },
          { id: 'ram', kind: 'path', segments: [{ kind: 'line', from: 'current', to: { xIn: 80, yIn: 45 } }], heading: { mode: 'constant', headingRad: Math.PI } },
        ],
      }),
      'blue',
      '2d',
    );
    startMatch(into.world);
    let stuckEarly = false;
    let stuckAt = -1;
    const commands = new Map<number, RobotCommand>();
    for (let i = 0; i < Math.round(10 / SIM_DT); i++) {
      commands.set(0, localizeCommand(into.seat.step(into.world, cmd({}))));
      into.world.events.length = 0;
      BIOBUZZ_SIM.step(into.world, SIM_DT, commands);
      const st = into.seat.status();
      if (st.stepId !== 'ram' && st.stuck) stuckEarly = true;
      if (st.stepId === 'ram' && st.stuck && stuckAt < 0) stuckAt = st.timeS;
    }
    const st = into.seat.status();
    const line = autoHudLine({ auto: { ...st, name: 'into-wall', problems: [] }, phase: 'auto' });
    check('AUTO stuck: a 3 s wait, and a shove into the wall with its own timeout, never read as stuck', !stuckEarly);
    check(
      'AUTO stuck: a leg the wall blocks reads stuck within 2 s of it starting, and the HUD names it',
      stuckAt > 5.5 && stuckAt < 7.6 && st.state === 'running' && line === 'AUTO STUCK ON RAM',
      `stuck at ${stuckAt.toFixed(2)} s, ${st.state} at ${st.stepId}, ${line}`,
    );
  }

  // ── W4-D3: a shootAll from a pose the robot cannot score from FIRES, like the robot ─────────
  // Aim Assist is on for every robot, so a held FIRE leaves only when the shot would land. StarterBot
  // (a tank with a fixed launcher at the back) scores from 41 to 46 in off the cell; from 28 in its
  // shootAll held FIRE for the rest of AUTO (29.5 s). The team's robot runs its own shootAll and
  // fires anyway, so once aim assist has had the build's aim window and the aim has settled, the
  // host presses `bbFireUnaimed` (`SIM_PATCH` 9): all four leave, and miss.
  {
    const starter = BB_STARTER_BOTS[0];
    const noShot = zen({
      formatVersion: 4,
      name: 'no-shot',
      alliance: 'RED',
      start: { pose: { xIn: -13, yIn: -63, headingRad: Math.PI / 2 } },
      steps: [
        { id: 'driveOut', kind: 'path', segments: [{ kind: 'line', from: 'current', to: { xIn: -13, yIn: -42 } }], heading: { mode: 'constant', headingRad: Math.PI / 2 } },
        { id: 'shoot', kind: 'command', name: 'shootAll', args: { count: 4 } },
        { id: 'slide', kind: 'path', segments: [{ kind: 'line', from: 'current', to: { xIn: -36, yIn: -42 } }], heading: { mode: 'constant', headingRad: Math.PI / 2 } },
      ],
    });
    const window = bbAimWindowS(starter);
    const patience = bbShotPatienceS(starter);
    check(
      'AUTO shoot: StarterBot lets aim assist aim for its own aim and beat (~1.35 s) before an unaimed shot, and gives up only a second past that',
      window > 1 && window < 2 && Math.abs(patience - window - 1) < 1e-9,
      `window ${window.toFixed(2)} s, patience ${patience.toFixed(2)} s`,
    );
    for (const physics of ['2d', '3d'] as const) {
      for (const alliance of ['red', 'blue'] as const) {
        const { world, seat, setup: s } = stage(noShot, alliance, physics, { spec: starter });
        const r = world.robots[0];
        const held = r.hopper.length;
        startMatch(world);
        const commands = new Map<number, RobotCommand>();
        const recorded: RobotCommand[] = [];
        let named: string | undefined;
        let cant = false;
        let firstLaunch = -1;
        let shootStart = -1;
        let ticks = 0;
        for (; ticks < Math.round(30 / SIM_DT) && seat.status().state !== 'done'; ticks++) {
          const c = localizeCommand(seat.step(world, cmd({})));
          recorded.push(c);
          commands.set(0, c);
          world.events.length = 0;
          const before = r.hopper.length;
          BIOBUZZ_SIM.step(world, SIM_DT, commands);
          const st = seat.status();
          if (shootStart < 0 && st.stepId === 'shoot') shootStart = st.timeS;
          if (firstLaunch < 0 && r.hopper.length < before) firstLaunch = st.timeS;
          if (named === undefined && st.outOfRange !== undefined) named = st.outOfRange;
          if (st.cantShoot !== undefined) cant = true;
        }
        check(
          `AUTO shoot ${physics} ${alliance}: StarterBot from 28 in fires all four once aiming has had its window, and the routine finishes inside AUTO`,
          seat.status().state === 'done' && ticks * SIM_DT < 30 && held === 4 && r.hopper.length === 0 && firstLaunch - shootStart >= window - 1e-6,
          `${seat.status().state} at ${(ticks * SIM_DT).toFixed(2)} s, hopper ${held} -> ${r.hopper.length}, first shot ${(firstLaunch - shootStart).toFixed(2)} s into the step (window ${window.toFixed(2)})`,
        );
        check(
          `AUTO shoot ${physics} ${alliance}: ...the seat names the step as shot out of range, and never as one it could not shoot`,
          named === 'shoot' && !cant,
          `outOfRange ${String(named)}, cantShoot ${cant}`,
        );
        if (physics === '2d' && alliance === 'red') {
          // the seat still only reads: its recorded commands, replayed with no seat, give the same world
          const replay = BIOBUZZ_SIM.createWorld('match', 7, [s], undefined, '2d');
          startMatch(replay);
          const map = new Map<number, RobotCommand>();
          for (const c of recorded) {
            map.set(0, c);
            replay.events.length = 0;
            BIOBUZZ_SIM.step(replay, SIM_DT, map);
          }
          const rr = replay.robots[0];
          check(
            'AUTO shoot: a run that fired unaimed replays from its recorded commands with no seat',
            rr.pos.x === r.pos.x && rr.pos.y === r.pos.y && rr.heading === r.heading && rr.hopper.length === r.hopper.length,
          );
          // ...and a replay stamped before SIM_PATCH 9 ignores the bit: its shots stay in, as they did
          const old = BIOBUZZ_SIM.createWorld('match', 7, [s], undefined, '2d');
          old.simPatch = 7;
          startMatch(old);
          for (const c of recorded) {
            map.set(0, c);
            old.events.length = 0;
            BIOBUZZ_SIM.step(old, SIM_DT, map);
          }
          check(
            'AUTO shoot: a world stamped SIM_PATCH 7 ignores bbFireUnaimed (the same commands keep all four in)',
            recorded.some((c) => c.bbFireUnaimed === true) && old.robots[0].hopper.length === held,
            `hopper ${old.robots[0].hopper.length}`,
          );
          // the window closes: 3 s of match time after the switch the status no longer names it
          for (let i = 0; i < Math.round(3.5 / SIM_DT); i++) {
            commands.set(0, localizeCommand(seat.step(world, cmd({}))));
            world.events.length = 0;
            BIOBUZZ_SIM.step(world, SIM_DT, commands);
          }
          check('AUTO shoot: ...and the status stops naming it 3 s after', seat.status().outOfRange === undefined && seat.status().state === 'done', JSON.stringify(seat.status()));
        }
      }
    }
    // a pose it CAN score from: all four leave aimed, and nothing is named
    for (const alliance of ['red', 'blue'] as const) {
      const fromWall = zen({
        formatVersion: 4,
        name: 'wall-shot',
        alliance: 'RED',
        start: { pose: { xIn: -34, yIn: -63.17, headingRad: Math.PI / 2 } },
        steps: [{ id: 'shoot', kind: 'command', name: 'shootAll', args: { count: 4 } }],
      });
      const { world, seat } = stage(fromWall, alliance, '2d', { spec: starter });
      startMatch(world);
      let named = false;
      let unaimed = false;
      const commands = new Map<number, RobotCommand>();
      for (let i = 0; i < Math.round(10 / SIM_DT) && seat.status().state !== 'done'; i++) {
        const c = localizeCommand(seat.step(world, cmd({})));
        if (c.bbFireUnaimed) unaimed = true;
        commands.set(0, c);
        world.events.length = 0;
        BIOBUZZ_SIM.step(world, SIM_DT, commands);
        const st = seat.status();
        if (st.cantShoot !== undefined || st.outOfRange !== undefined) named = true;
      }
      check(
        `AUTO shoot 2d ${alliance}: StarterBot from a pose it scores from fires all four AIMED, and nothing is named`,
        seat.status().state === 'done' && world.robots[0].hopper.length === 0 && !named && !unaimed,
        `${seat.status().state}, hopper ${world.robots[0].hopper.length}, named ${named}, unaimed ${unaimed}`,
      );
    }
    // every preset, from a pose most of them cannot score from: the step ends with the hopper fired
    for (const spec of BB_PRESET_LIST) {
      const mid = zen({
        formatVersion: 4,
        name: 'mid-shot',
        alliance: 'RED',
        start: { pose: { xIn: -40, yIn: -10, headingRad: 0 } },
        steps: [{ id: 'shoot', kind: 'command', name: 'shootAll', args: { count: 4 } }],
      });
      const { world, seat } = stage(mid, 'red', '2d', { spec });
      startMatch(world);
      let cant = false;
      const commands = new Map<number, RobotCommand>();
      for (let i = 0; i < Math.round(10 / SIM_DT) && seat.status().state !== 'done'; i++) {
        commands.set(0, localizeCommand(seat.step(world, cmd({}))));
        world.events.length = 0;
        BIOBUZZ_SIM.step(world, SIM_DT, commands);
        if (seat.status().cantShoot !== undefined) cant = true;
      }
      const left = world.robots[0].hopper.length;
      check(
        `AUTO shoot: ${spec.name} (${bbLauncherOf(spec, 30).kind}) never holds a shootAll forever: it fires its preload, and gives up only if shots stayed in`,
        seat.status().state === 'done' && left === 0 && !cant,
        `${seat.status().state} at ${world.time.toFixed(2)} s, hopper ${left}, gave up ${cant}`,
      );
    }
    // headless: the same file ends, and its trace has the shot's real length
    const h = runAutoHeadless({ game: 'biobuzz', spec: starter, setup: noShot });
    const hs = h.trace.steps.find((x) => x.id === 'shoot');
    check(
      'AUTO headless: StarterBot’s out-of-range run finishes, and the trace times the shoot step (was 0 s, at its own start)',
      h.state === 'done' && hs !== undefined && hs.endS - hs.startS > window && hs.endS - hs.startS < window + 3,
      `${h.state}, shoot ${hs ? `${hs.startS.toFixed(2)}..${hs.endS.toFixed(2)}` : 'missing'}`,
    );
    // the wire: the bit survives the quantize round trip the seat's command takes, and no client may send it
    const seatCmd = localizeCommand({ ...cmd({ fire: true }), bbFireUnaimed: true });
    const q = quantizeCommand(seatCmd);
    const fromClient = sanitizeQCommand({ ...q });
    check(
      'AUTO shoot: bbFireUnaimed rides the quantized command (replays, snapshots, prediction) and the door clears it from every client packet',
      seatCmd.bbFireUnaimed === true &&
        (q.buttons & SEAT_ONLY_BUTTONS) !== 0 &&
        fromClient !== null &&
        (fromClient.buttons & SEAT_ONLY_BUTTONS) === 0 &&
        dequantizeCommand(fromClient).fire === true &&
        dequantizeCommand(fromClient).bbFireUnaimed === undefined &&
        !('bbFireUnaimed' in localizeCommand(cmd({ fire: true }))),
      JSON.stringify({ q: q.buttons, client: fromClient?.buttons }),
    );
    // headless: a step still running at the buzzer ends there, interrupted
    const long = runAutoHeadless({
      game: 'biobuzz',
      spec: { ...BB_DEFAULT_SPEC } as RobotSpec,
      setup: zen({ ...probeAuto(), steps: [{ id: 'long', kind: 'wait', seconds: 40 }] }),
    });
    const ls = long.trace.steps.find((x) => x.id === 'long');
    check(
      'AUTO headless: a step still running at the buzzer ends at the buzzer, interrupted (not at its own start)',
      long.state === 'running' && ls !== undefined && ls.endS > 29.9 && ls.interrupted && !long.trace.completed,
      `${long.state}, long ${ls ? `${ls.startS.toFixed(2)}..${ls.endS.toFixed(2)} interrupted ${ls.interrupted}` : 'missing'}`,
    );
  }

  // ── format 4: a transfer, an envelope on a command, a rejoinFrom after it ───────────────────
  {
    const dir = join(here, 'fixtures', 'zenith');
    const f4Text = readFileSync(join(dir, 'format4.auto.json'), 'utf8');
    const f4 = JSON.parse(f4Text) as { formatVersion: number; steps: { kind: string; envelope?: unknown; rejoinFrom?: unknown }[] };
    check(
      'AUTO format 4: the fixture is format 4 with a transfer, an envelope on a command and a path with rejoinFrom after it',
      f4.formatVersion === 4 && f4.steps.some((x) => x.kind === 'transfer') && f4.steps.some((x) => x.kind === 'command' && x.envelope) && f4.steps.some((x) => x.kind === 'path' && x.rejoinFrom),
    );
    for (const alliance of ['blue', 'red'] as const) {
      const l = loadZenithAuto({ auto: f4Text }, alliance, { ...BB_DEFAULT_SPEC } as RobotSpec, adapter);
      const errors = l.findings.filter((x) => x.severity === 'error');
      check(`AUTO format 4 ${alliance}: it loads with no error finding and nothing unsupported`, errors.length === 0 && l.unsupported.length === 0, errors.map((x) => `${x.code}: ${x.message}`).join(' | ') || l.unsupported.join(', '));
    }
    const run = (text: string, physics: '2d' | '3d', spec?: RobotSpec) => {
      const { world, seat } = stage({ auto: text }, 'blue', physics, spec ? { spec } : {});
      startMatch(world);
      const log = drive(world, seat, 30);
      return { world, seat, log, dp: driveParams(world.robots[0].spec) };
    };
    for (const physics of ['2d', '3d'] as const) {
      const { world, seat, log, dp } = run(f4Text, physics);
      const t = seat.trace()?.steps.find((x) => x.id === 'partnerScores');
      check(
        `AUTO format 4 ${physics}: it plays to done inside AUTO, shoots its two, and the transfer takes one scheduler tick at most`,
        seat.status().state === 'done' && log.ticks * SIM_DT < 30 && world.robots[0].hopper.length === 2 && t !== undefined && t.endS - t.startS <= SIM_DT + 1e-6,
        `${seat.status().state} at ${(log.ticks * SIM_DT).toFixed(2)} s, hopper ${world.robots[0].hopper.length}, transfer ${t ? (t.endS - t.startS).toFixed(3) : '?'} s`,
      );
      check(
        `AUTO format 4 ${physics}: ...inside the drivetrain's own turn and speed limits every tick`,
        log.maxDh <= dp.maxTurn * SIM_DT * 1.05 && log.maxDp <= dp.maxSpeed * SIM_DT * 1.05,
        `max ${log.maxDh.toFixed(4)} rad/tick (limit ${(dp.maxTurn * SIM_DT).toFixed(4)}), ${log.maxDp.toFixed(3)} in/tick (limit ${(dp.maxSpeed * SIM_DT).toFixed(3)})`,
      );
    }
    {
      // THE TRANSFER MOVES NOTHING: the same file with a zero-second wait in its place drives the
      // robot identically, tick for tick (the runtime runs a transfer as exactly that wait)
      const asWait = JSON.stringify({
        ...JSON.parse(f4Text),
        steps: (JSON.parse(f4Text) as { steps: { kind: string }[] }).steps.map((x) => (x.kind === 'transfer' ? { id: 'partnerScores', kind: 'wait', seconds: 0 } : x)),
      });
      const a = run(f4Text, '2d');
      const b = run(asWait, '2d');
      const same = a.log.poses.length === b.log.poses.length && a.log.poses.every((p, i) => p.x === b.log.poses[i].x && p.y === b.log.poses[i].y);
      const ra = a.world.robots[0];
      const rb = b.world.robots[0];
      check(
        'AUTO format 4: the transfer moves no robot (the run is the run with a zero-second wait in its place, tick for tick)',
        same && ra.heading === rb.heading && ra.hopper.length === rb.hopper.length,
        `${a.log.poses.length} vs ${b.log.poses.length} ticks`,
      );
    }
    {
      const tank = BB_STARTER_BOTS[0];
      const { seat, log } = run(f4Text, '2d', tank);
      check('AUTO format 4: a tank (StarterBot) loads it, re-headed, and plays it to done inside AUTO', seat.status().state === 'done' && log.ticks * SIM_DT < 30 && (seat.loaded?.reheaded.length ?? 0) > 0, `${seat.status().state} at ${seat.status().stepId}, ${(log.ticks * SIM_DT).toFixed(2)} s`);
    }
  }

  // ── W4-D1: a load error is one sentence; a newer file says so in DSIM's words ───────────────
  {
    const msg = (text: string): string => {
      try {
        parseAutoText(text);
        return '(loaded)';
      } catch (e) {
        return e instanceof AutoLoadError ? e.message : `(not an AutoLoadError) ${String(e)}`;
      }
    };
    const max = FORMAT_VERSIONS.auto;
    const newer = msg(JSON.stringify({ ...probeAuto(), formatVersion: max + 1 }));
    check(
      'AUTO load: a file from a newer Zenith says which format it is, which DSIM reads, and what to do (not "this build of Zenith")',
      newer === `This auto was saved by a newer Zenith (file format ${max + 1}), and this DSIM reads up to format ${max}. Reload DSIM; if it still says this, DSIM needs an update.`,
      newer,
    );
    const wpNewer = (() => {
      try {
        loadZenithAuto({ auto: JSON.stringify(probeAuto()), waypoints: JSON.stringify({ formatVersion: FORMAT_VERSIONS.waypoints + 1, waypoints: {} }) }, 'blue', { ...BB_DEFAULT_SPEC } as RobotSpec, adapter);
        return '(loaded)';
      } catch (e) {
        return e instanceof AutoLoadError ? e.message : String(e);
      }
    })();
    check('AUTO load: ...and so does a waypoints file from a newer Zenith', wpNewer.startsWith('This waypoints file was saved by a newer Zenith (file format ') && !/build of Zenith/.test(wpNewer), wpNewer);
    const cases: [string, string][] = [
      ['not an object', '[]'],
      ['no integer formatVersion', JSON.stringify({ ...probeAuto(), formatVersion: 3.5 })],
      ['a schema message that ends in a full stop', JSON.stringify({ ...probeAuto(), formatVersion: 4, steps: [{ id: 'w', kind: 'wait', seconds: 1, envelope: { polygon: [{ xIn: 0, yIn: 0 }, { xIn: 1, yIn: 0 }, { xIn: 0, yIn: 1 }], maxDurationS: 1, actualDurationS: 2, provenance: 'SET BY HAND: x' } }] })],
      ['a missing name', JSON.stringify({ ...probeAuto(), name: undefined })],
      ['bad JSON', '{"formatVersion": 4,'],
    ];
    const bad = cases.map(([what, text]) => [what, msg(text)] as const).filter(([, m]) => /\.\./.test(m) || !/[.?!]$/.test(m) || m.startsWith('('));
    check('AUTO load: every load error ends in one full stop, never ".."', bad.length === 0, bad.map(([w, m]) => `${w}: ${m}`).join(' | ') || cases.map(([, t]) => msg(t)).join(' | '));
  }

  // ── W4-D7: the findings are the FILE's, so a mirrored run names what Zenith names ───────────
  {
    const dir = join(here, 'fixtures', 'zenith', 'starter');
    const auto = readFileSync(join(dir, 'collect-and-score.auto.json'), 'utf8');
    const waypoints = readFileSync(join(dir, 'waypoints.json'), 'utf8');
    for (const [label, spec] of [['default', { ...BB_DEFAULT_SPEC } as RobotSpec], ['StarterBot (tank)', BB_STARTER_BOTS[0]]] as const) {
      const red = loadZenithAuto({ auto, waypoints }, 'red', spec, adapter);
      const blue = loadZenithAuto({ auto, waypoints }, 'blue', spec, adapter);
      const a = JSON.stringify(red.findings);
      const b = JSON.stringify(blue.findings);
      check(
        `AUTO findings: a RED file played as BLUE gives the findings it gives as RED, element names included (${label})`,
        blue.mirrored && !red.mirrored && a === b && /flower1Foot/.test(b),
        a === b ? `${red.findings.length} findings` : `RED ${red.findings.map((x) => x.message.slice(0, 60)).join(' | ')} // BLUE ${blue.findings.map((x) => x.message.slice(0, 60)).join(' | ')}`,
      );
      check(
        `AUTO findings: ...while the robot still drives the mirrored routine (${label})`,
        Math.hypot(red.plan.startPose.xIn + blue.plan.startPose.xIn, red.plan.startPose.yIn + blue.plan.startPose.yIn) < 1e-6 && red.reheaded.join() === blue.reheaded.join(),
      );
    }
  }

  // ── W4-D16: Zenith's starter autos show no red line for a name DSIM already lists ───────────
  // `fixtures/zenith/starter/` is Zenith's public starter example, unedited. Measured 2026-10-24 on
  // the default build: first-auto 0 errors (was 1, "score"); collect-and-score 6 (was 14: STRUCTURE
  // x2 at flower1, PERIMETER x2, CAPACITY x2); all-step-kinds 5 (was 12: PERIMETER x4, CAPACITY);
  // cycle-and-park 4 (was 11: PERIMETER x3, CAPACITY). What is left is real against DSIM's robot and
  // walls (a 4-pollen hopper, walls at 70.674 in).
  {
    const dir = join(here, 'fixtures', 'zenith', 'starter');
    const waypoints = readFileSync(join(dir, 'waypoints.json'), 'utf8');
    const RULES = new Set(['PERIMETER', 'STRUCTURE', 'CAPACITY', 'LEGAL_APPROACH', 'START_ILLEGAL', 'OPPONENT_SIDE', 'TIME_BUDGET', 'CLEARANCE', 'KEEPOUT']);
    for (const name of ['first-auto', 'collect-and-score', 'all-step-kinds', 'cycle-and-park']) {
      const auto = readFileSync(join(dir, `${name}.auto.json`), 'utf8');
      for (const alliance of ['red', 'blue'] as const) {
        const l = loadZenithAuto({ auto, waypoints }, alliance, { ...BB_DEFAULT_SPEC } as RobotSpec, adapter);
        const errors = l.findings.filter((x) => x.severity === 'error');
        const notRule = errors.filter((x) => !RULES.has(x.code) || /does not register/.test(x.message));
        const listed = /"(\w+)", which robot\.json does not register/;
        check(
          `AUTO starter ${name} ${alliance}: loads with no error but real rule problems, and what DSIM does not run is listed, not red`,
          notRule.length === 0 && !l.findings.some((x) => listed.test(x.message)) && l.unsupported.length === (name === 'first-auto' ? 1 : name === 'collect-and-score' ? 4 : 5),
          `unsupported [${l.unsupported.join(', ')}]; errors ${errors.map((x) => x.code).join(', ') || 'none'}${notRule.length ? `; NOT RULES: ${notRule.map((x) => x.message).join(' | ')}` : ''}`,
        );
      }
    }
  }
}
