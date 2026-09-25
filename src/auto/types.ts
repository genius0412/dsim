/**
 * ZENITH AUTOS — the shared, DOM-free shapes (docs/area/autos.md).
 *
 * A Zenith auto is a `*.auto.json` file, the same file a team's robot plays through its Zenith
 * runtime. DSIM plays it by DRIVING: `seat.ts` runs Zenith's own Pedro follower and command tree
 * (`@horizon36596/zenith-core` `createLiveRun`) against the robot's real pose, and turns the
 * follower's powers into the same `RobotCommand` a driver's sticks produce. Nothing here writes a
 * pose.
 *
 * ⚠️ THIS FILE AND `coerce.ts` ARE IN THE MAIN CHUNK; NOTHING ELSE UNDER `src/auto/` IS. Neither
 * may import `@horizon36596/zenith-*` (types excepted — they are erased): the client reaches the
 * rest through a dynamic `import()` so a player who never runs an auto never downloads Zenith.
 */
import type { Alliance, RobotCommand, RobotSpec, StartPose, World } from '../types';

/**
 * WHAT A SETUP CARRIES: the auto file's text, exactly as saved, and optionally the waypoints
 * file it references. Text rather than a parsed object so the thing that rides the wire, sits in
 * localStorage and lands in a replay is the same bytes the team's robot repository holds, and
 * so the one validator (`load.ts`) sees what the author wrote.
 */
export interface ZenithAutoSetup {
  /** the `*.auto.json` text */
  auto: string;
  /** a `waypoints.json` text, when the auto names waypoints by `ref` */
  waypoints?: string;
}

/** The buttons a running auto command holds this tick, ORed into the drive command. */
export type AutoButtons = Pick<RobotCommand, 'intake' | 'fire'>;

/**
 * A named command as a host runs it: the scheduler's life cycle, the one SolversLib and
 * `createLiveRun` both use. `initialize` once, then per tick `execute` and a look at
 * `isFinished` (which must answer the same when asked twice in one pass), then `end`.
 */
export interface AutoCommand {
  initialize(): void;
  execute(): void;
  isFinished(): boolean;
  end(interrupted: boolean): void;
}

/**
 * ONE ROBOT'S MECHANISMS, AS AN AUTO SEES THEM. A game builds one per seat
 * (`GameAutoAdapter.createHost`); the seat hands it the live world before every tick.
 */
export interface AutoHost {
  /** the world this tick; set by the seat before the run ticks */
  world: World;
  /** the game's command for `name`, or null when this game does not run it */
  command(name: string, args: Readonly<Record<string, string | number | boolean>>): AutoCommand | null;
  /** reads a condition now, or null when this game cannot see it (it then never reads true) */
  condition(name: string): boolean | null;
  /** the buttons held right now by whatever the auto started */
  buttons(): AutoButtons;
  /** the end of AUTO: let go of everything */
  release(): void;
}

/**
 * A GAME'S HALF OF THE SEAM. `src/auto/games.ts` is the registry; a game with no adapter plays
 * no Zenith autos, and `GameSimModule.zenithAutos` says so to the main chunk.
 */
export interface GameAutoAdapter {
  /** the command names this game runs; any other is done at once and listed as unsupported */
  commands: readonly string[];
  /** the condition names this game can read; any other never reads true */
  conditions: readonly string[];
  /** the Zenith `field.json` object this game is played on */
  field(): unknown;
  /** the Zenith season rules for the findings (start legality, the ledger), read from the field */
  rules?(field: import('@horizon36596/zenith-schema').Field): import('@horizon36596/zenith-core').SeasonRules;
  /** the Zenith `robot.json` object for a DSIM build: footprint, speeds, mouths, registry */
  robot(spec: RobotSpec): unknown;
  /** this robot's mechanisms, for one seat */
  createHost(world: World, robotId: number): AutoHost;
  /**
   * The CANONICAL `StartPose` (what `RobotSetup.startPose` holds) that spawns a robot of
   * `alliance` at this WORLD pose. Each game mirrors a canonical pose onto an alliance its own
   * way (`GameSimModule.startLegal`'s note), so the inverse is the game's too.
   */
  canonicalStart(pose: { x: number; y: number; heading: number }, alliance: Alliance): StartPose;
}

/** What the seat reports for the HUD and the panel. */
export interface AutoSeatStatus {
  /** 'waiting' before AUTO, 'running', 'done' once the routine ended, 'stopped' once AUTO did */
  state: 'waiting' | 'running' | 'done' | 'stopped' | 'error';
  /** the innermost step running now, by id */
  stepId: string | null;
  /** seconds since the routine started */
  timeS: number;
  /** why the auto could not run, for `state: 'error'` */
  error?: string;
}
