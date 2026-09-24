/**
 * THE AUTO SEAT: a Zenith auto driving one robot, shaped like a `BotSeat` and called exactly
 * where the bots are (docs/area/autos.md). LAZY CHUNK.
 *
 * ── THE CONTRACT, the bots' contract ──────────────────────────────────────────────────────────
 * The caller runs `seat.step(world, driverCmd)` ONCE per tick, BEFORE the game's step, puts the
 * result into the command map the recorder is handed, and passes it through `localizeCommand`
 * like any command. So a replay of a match with an auto in it re-simulates from the recorded
 * commands with NO seat at all, and the server, a client's prediction and the LAN host all agree
 * on what the robot was told. The seat reads the world and never writes it, never touches
 * `world.rngState`, and keeps its memory (the live run) to itself.
 *
 * ── WHEN IT DRIVES ────────────────────────────────────────────────────────────────────────────
 * Only in AUTO. Before AUTO it hands the driver's command through (which `robotsEnabled` then
 * ignores in `pre`), from TELEOP on it hands it through again, so a practice driver takes over
 * at the buzzer, and in FREE DRIVE it is inert unless a trial was armed (`arm`). That last rule
 * is the one the old `.pp` path broke: it froze a Free Drive robot because its flag was set in
 * every mode.
 *
 * ── HOW IT DRIVES ─────────────────────────────────────────────────────────────────────────────
 * Each tick the robot's real pose, velocity and spin go to Zenith's `createLiveRun` — the Pedro
 * v3 ForesightV3 follower and the command tree the robot's own runtime builds — and the
 * robot-frame powers that come back become sticks (`drive.ts`). The chassis moves under DSIM's
 * drivetrain, traction and contact physics like a driven robot, so it turns at its own turn
 * rate, is shoved by a partner, and cannot pass through anything. Nothing here writes a pose or
 * a heading: the heading teleport of the old path follower has no line of code to live on.
 */
import { createLiveRun, type LiveRun, type SimTrace } from '@horizon36596/zenith-core';
import { SIM_DT } from '../config';
import type { RobotCommand, World } from '../types';
import { powersToCommand } from './drive';
import { AutoLoadError, loadZenithAuto, type LoadedAuto } from './load';
import type { AutoHost, AutoSeatStatus, GameAutoAdapter, ZenithAutoSetup } from './types';

export interface AutoSeat {
  step(world: World, driver: RobotCommand): RobotCommand;
  status(): AutoSeatStatus;
  /** the run so far as a Zenith trace (the planned-vs-driven overlay), or null before AUTO */
  trace(): SimTrace | null;
  /** the loaded auto, or null when it failed to load (`status().error` says why) */
  readonly loaded: LoadedAuto | null;
  /**
   * FREE DRIVE ONLY: play the routine once from now, as if AUTO had just begun. The caller has
   * already put the robot at the start pose (a world rebuild, as Reset does).
   */
  arm(): void;
  dispose(): void;
}

/** A trial in Free Drive stops after one AUTO period, like the real one. */
const TRIAL_S = 30;

class Seat implements AutoSeat {
  readonly loaded: LoadedAuto | null;
  private readonly error: string | null;
  private run: LiveRun | null = null;
  private host: AutoHost | null = null;
  private state: AutoSeatStatus['state'] = 'waiting';
  private trial = false;
  private trialTicks = 0;
  /** the steps running as of the last tick, outermost first */
  private active: readonly string[] = [];

  constructor(
    world: World,
    private readonly robotId: number,
    setup: ZenithAutoSetup,
    private readonly adapter: GameAutoAdapter,
  ) {
    const r = world.robots.find((x) => x.id === robotId);
    let loaded: LoadedAuto | null = null;
    let error: string | null = null;
    if (!r) error = 'There is no robot in this seat.';
    else {
      try {
        loaded = loadZenithAuto(setup, r.alliance, r.spec, adapter);
      } catch (e) {
        error = e instanceof AutoLoadError ? e.message : `The auto could not be loaded: ${String(e)}`;
      }
    }
    this.loaded = loaded;
    this.error = error;
    if (error) this.state = 'error';
  }

  private start(world: World): void {
    const loaded = this.loaded;
    if (!loaded) return;
    const host = this.adapter.createHost(world, this.robotId);
    this.host = host;
    this.run = createLiveRun(
      loaded.plan,
      loaded.robot,
      loaded.field,
      {
        command: (name, args) => host.command(name, args),
        // A condition this game cannot see never reads true, which is what Zenith's instant sim
        // does with one it cannot see: a `wait until` on it holds until the period ends.
        condition: (name) => host.condition(name) === true,
      },
      { tickS: SIM_DT },
    );
    this.state = 'running';
  }

  private stop(): void {
    if (this.run && (this.state === 'running' || this.state === 'done')) {
      this.run.cancel();
      this.host?.release();
      this.state = 'stopped';
    }
    this.trial = false;
  }

  arm(): void {
    if (!this.loaded) return;
    this.run = null;
    this.host = null;
    this.state = 'waiting';
    this.active = [];
    this.trial = true;
    this.trialTicks = 0;
  }

  step(world: World, driver: RobotCommand): RobotCommand {
    if (!this.loaded) return driver;
    const phase = world.match.phase;
    const driving = phase === 'auto' || (this.trial && phase === 'freeplay');
    if (!driving) {
      this.stop();
      return driver;
    }
    if (this.trial && ++this.trialTicks > Math.round(TRIAL_S / SIM_DT)) {
      this.stop();
      return driver;
    }
    const r = world.robots.find((x) => x.id === this.robotId);
    if (!r) return driver;
    if (this.state === 'waiting') this.start(world);
    const run = this.run;
    const host = this.host;
    if (!run || !host || this.state === 'stopped') return driver;
    host.world = world;
    const tick = run.tick({
      xIn: r.pos.x,
      yIn: r.pos.y,
      headingRad: r.heading,
      vxInPerS: r.vel.x,
      vyInPerS: r.vel.y,
      omegaRadPerS: r.angVel,
    });
    this.active = tick.activeStepIds;
    if (tick.finished && this.state === 'running') this.state = 'done';
    return powersToCommand(r, tick.powers, host.buttons());
  }

  status(): AutoSeatStatus {
    if (this.error) return { state: 'error', stepId: null, timeS: 0, error: this.error };
    const active = this.state === 'running' ? this.active : [];
    return {
      state: this.state,
      stepId: active.length ? active[active.length - 1] : null,
      timeS: this.run?.timeS ?? 0,
    };
  }

  trace(): SimTrace | null {
    return this.run?.trace() ?? null;
  }

  dispose(): void {
    this.stop();
    this.run = null;
    this.host = null;
  }
}

export function createAutoSeat(
  world: World,
  robotId: number,
  setup: ZenithAutoSetup,
  adapter: GameAutoAdapter,
): AutoSeat {
  return new Seat(world, robotId, setup, adapter);
}
