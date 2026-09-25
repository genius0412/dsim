/**
 * RUN AN AUTO HEADLESS: a real match world, the real step, one robot and its auto seat, for one
 * AUTO period, returning Zenith's trace of it. LAZY CHUNK. Pure: the world is seeded, nothing
 * reads a clock, and a run is identical every time.
 *
 * Two callers, one function, so they cannot disagree:
 *  - Zenith's "Simulate in DSIM" (`src/ui/zenithHost.ts` answers a `run` with this trace);
 *  - `npm run zenith:sim` (`scripts/zenith-sim.ts`), the command a robot repository's
 *    `zenith.json` `sim.command` can point at, so `zenith sim` and `zenith calibrate` read DSIM.
 *
 * ── WHICH FRAME THE TRACE IS IN ───────────────────────────────────────────────────────────────
 * The auto's OWN alliance's, which is the frame the file's poses and Zenith's canvas are in. The
 * run therefore puts the robot on the file's alliance, so nothing is mirrored and the recorded
 * path lies exactly over the planned one. (A match run on the other alliance is mirrored back by
 * `traceInFileFrame` before it goes to Zenith.)
 */
import type { SimTrace } from '@horizon36596/zenith-core';
import * as C from '../config';
import { simModuleFor } from '../games/sim';
import type { GameId } from '../games/types';
import { localizeCommand } from '../net/protocol';
import { startMatch } from '../sim/match';
import { DEFAULT_ASSISTS, type RobotSetup } from '../sim/spawn';
import type { Alliance, Physics, RobotCommand, RobotSpec } from '../types';
import { autoAdapterFor } from './games';
import { autoStartPose, loadZenithAuto, parseAutoText } from './load';
import { createAutoSeat } from './seat';
import type { ZenithAutoSetup } from './types';

export interface HeadlessOptions {
  game: GameId;
  spec: RobotSpec;
  setup: ZenithAutoSetup;
  /** default: the file's own alliance (see the header) */
  alliance?: Alliance;
  /** default '2d': the faster solve, and the one every physics shares the drive model with */
  physics?: Physics;
  seed?: number;
  /** seconds; default the AUTO period */
  seconds?: number;
}

export interface HeadlessResult {
  trace: SimTrace;
  /** the pose the robot ended on, in the run's own frame */
  end: { x: number; y: number; heading: number };
  /** the auto's own state at the end ('done' when it finished inside the period) */
  state: string;
  error?: string;
}

const IDLE: RobotCommand = {
  driveX: 0,
  driveY: 0,
  rotate: 0,
  leftDrive: 0,
  rightDrive: 0,
  intake: false,
  fire: false,
};

export function runAutoHeadless(o: HeadlessOptions): HeadlessResult {
  const adapter = autoAdapterFor(o.game);
  if (!adapter) throw new Error(`${o.game} does not play Zenith autos`);
  const fileAlliance: Alliance = parseAutoText(o.setup.auto).alliance === 'RED' ? 'red' : 'blue';
  const alliance = o.alliance ?? fileAlliance;
  const mod = simModuleFor(o.game);
  const base: RobotSetup = {
    id: 0,
    alliance,
    spec: o.spec,
    // robot-centric, no assists: the auto drives, and an assist would only fight it
    assists: { ...DEFAULT_ASSISTS, fieldCentric: false, aimAssist: false, autoIntake: false, autoFire: false },
    startIndex: 0,
    zenithAuto: o.setup,
  };
  const loaded = loadZenithAuto(o.setup, alliance, o.spec, adapter);
  const s: RobotSetup = { ...base, startPose: autoStartPose(loaded, alliance, adapter) };
  const world = mod.createWorld('match', o.seed ?? 1, [s], undefined, o.physics ?? '2d');
  startMatch(world);
  const seat = createAutoSeat(world, 0, o.setup, adapter);
  const commands = new Map<number, RobotCommand>();
  const ticks = Math.round((o.seconds ?? C.AUTO_DURATION) / C.SIM_DT);
  for (let i = 0; i < ticks && world.match.phase === 'auto'; i++) {
    commands.set(0, localizeCommand(seat.step(world, IDLE)));
    world.events.length = 0;
    mod.step(world, C.SIM_DT, commands);
    if (seat.status().state === 'done') break;
  }
  const r = world.robots[0];
  const st = seat.status();
  const trace = seat.trace();
  if (!trace) throw new Error(st.error ?? 'The auto did not run.');
  return {
    trace: { ...trace, capabilities: [...trace.capabilities, 'dsim'] },
    end: { x: r.pos.x, y: r.pos.y, heading: r.heading },
    state: st.state,
    ...(st.error ? { error: st.error } : {}),
  };
}

/**
 * A trace recorded on the alliance the file was NOT written for, put back in the file's frame
 * (the point mirror, which is its own inverse), so Zenith lays it over the plan it drew.
 */
export function traceInFileFrame(trace: SimTrace, mirrored: boolean): SimTrace {
  if (!mirrored) return trace;
  const flip = (rows: readonly (readonly [number, number, number, number])[]) =>
    rows.map(([t, x, y, h]) => [t, -x, -y, Math.atan2(Math.sin(h + Math.PI), Math.cos(h + Math.PI))] as const);
  return {
    ...trace,
    poses: flip(trace.poses),
    truthPoses: flip(trace.truthPoses),
    velocities: trace.velocities.map(([t, vx, vy, w]) => [t, -vx, -vy, w] as const),
  };
}
