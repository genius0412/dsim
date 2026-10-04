/**
 * `npm run zenith:sim -- <auto.auto.json> [options]` — DSIM as Zenith's high-fidelity sim.
 *
 * Plays a Zenith auto file headless in DSIM (`src/auto/headless.ts`: the real match world, the
 * real step, the auto seat driving the robot through its drivetrain) and writes Zenith's trace of
 * the run. A robot repository can point `zenith.json`'s `sim` at it, from a DSIM checkout:
 *
 *   "sim": {
 *     "command": "npm --prefix ../dsim run -s zenith:sim -- {auto} --out build/sim/{auto}.trace.json",
 *     "trace": "build/sim/{auto}.trace.json"
 *   }
 *
 * and `zenith sim` then overlays DSIM's run on the plan, and `zenith calibrate` fits the estimate
 * to it. (`{auto}` is the auto's name; pass the file path the way your repository lays it out.)
 *
 * Options:
 *   --waypoints <file>        the waypoints.json the auto names by ref (default: beside the auto)
 *   --alliance red|blue       default: the file's own alliance, so the trace needs no mirror
 *   --physics 2d|3d           default 2d
 *   --spec <robot-spec.json>  a DSIM RobotSpec (Configure ▸ Robot export); default BIOBUZZ's
 *   --game <id>               default biobuzz
 *   --out <file>              default: print the trace to stdout
 * Exit 0 when the routine finished inside the period, 3 when it ran out of time, 1 on an error.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { initPhysics } from '../src/sim/physicsEngine';
import { initPhysics3d } from '../src/games/biobuzz/sim3d/engine';
import { coerceSpec } from '../src/sim/spawn';
import { BB_DEFAULT_SPEC } from '../src/games/biobuzz/robotConfig';
import { isGameId } from '../src/games/types';
import { runAutoHeadless } from '../src/auto/zenithAutos';

function die(msg: string): never {
  console.error(`zenith:sim: ${msg}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const flags = new Map<string, string>();
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) die(`${a} needs a value`);
    flags.set(a.slice(2), v);
    i++;
  } else positional.push(a);
}
const known = ['waypoints', 'alliance', 'physics', 'spec', 'game', 'out'];
for (const k of flags.keys()) if (!known.includes(k)) die(`unknown option --${k}`);
const autoPath = positional[0];
if (!autoPath || positional.length > 1) die('usage: zenith:sim <auto.auto.json> [--waypoints f] [--alliance red|blue] [--physics 2d|3d] [--spec f] [--out f]');
const file = existsSync(autoPath) ? autoPath : existsSync(`${autoPath}.auto.json`) ? `${autoPath}.auto.json` : die(`no such file ${autoPath}`);
const auto = readFileSync(file, 'utf8');
const wpFlag = flags.get('waypoints');
const wpDefault = join(dirname(resolve(file)), 'waypoints.json');
const waypoints = wpFlag ? readFileSync(wpFlag, 'utf8') : existsSync(wpDefault) ? readFileSync(wpDefault, 'utf8') : undefined;
const game = flags.get('game') ?? 'biobuzz';
if (!isGameId(game)) die(`unknown game ${game}`);
const alliance = flags.get('alliance');
if (alliance !== undefined && alliance !== 'red' && alliance !== 'blue') die('--alliance is red or blue');
const physics = flags.get('physics') ?? '2d';
if (physics !== '2d' && physics !== '3d') die('--physics is 2d or 3d');
const specRaw = flags.get('spec') ? JSON.parse(readFileSync(flags.get('spec')!, 'utf8')) : BB_DEFAULT_SPEC;
const spec = coerceSpec(specRaw, BB_DEFAULT_SPEC, game);

await initPhysics();
if (physics === '3d') await initPhysics3d();
try {
  const r = runAutoHeadless({
    game,
    spec,
    setup: { auto, ...(waypoints ? { waypoints } : {}) },
    ...(alliance ? { alliance } : {}),
    physics,
  });
  const text = `${JSON.stringify(r.trace)}\n`;
  const out = flags.get('out');
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, text);
    console.error(`zenith:sim: ${r.state} after ${r.trace.simTimeS.toFixed(2)} s; wrote ${out}`);
  } else process.stdout.write(text);
  process.exit(r.state === 'done' ? 0 : 3);
} catch (e) {
  die(e instanceof Error ? e.message : String(e));
}
