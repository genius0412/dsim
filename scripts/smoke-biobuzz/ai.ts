/**
 * AI lane — the deterministic bot drivers (Day 3, `docs/biobuzz/plan-3d.md` §6).
 *
 * ── WHAT IS HERE AND WHAT IS IN `npm run test:ai` ──────────────────────────
 * Here: everything CHEAP and ABSOLUTE — the seam, the determinism, the read list, the
 * quantization, the height rule, and "a bot can actually score". There: the STATISTICAL claim
 * (the harder tier beats the easier one over a hundred full matches), which costs minutes and
 * therefore cannot ride `npm test`, for the same reason `contrast` and `dbtest` do not.
 *
 * ⚠️ **THE SOURCE CHECKS ARE NOT HYGIENE.** Two of them are bugs that shipped: a `process.env`
 * debug hook in `ai/policy.ts` threw on the FIRST bot decision in a browser (there is no
 * `process` there) and took the render loop down with it, and a static `sim3d/` import from
 * outside `sim3d/` is what put 225 KB of 3D physics into the main chunk once already. Both are
 * invisible in Node and fatal in a browser, which is exactly the class a grep has to catch.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIM_DT } from '../../src/config';
import type { RobotCommand, RobotSpec, World } from '../../src/types';
import { worldHash } from '../../src/net/checksum';
import { localizeCommand } from '../../src/net/protocol';
import { startMatch } from '../../src/sim/match';
import { DEFAULT_ASSISTS, type RobotSetup } from '../../src/sim/spawn';
import { simModuleFor } from '../../src/games/sim';
import type { Physics } from '../../src/games/types';
import { BIOBUZZ_SIM } from '../../src/games/biobuzz/sim';
import { BIOBUZZ_BOT, BB_AI_DEFAULT_TIER, BB_AI_TIERS, bbCoerceTier } from '../../src/games/biobuzz/ai';
import { BB_AI_TIER_SPECS } from '../../src/games/biobuzz/ai/tiers';
import {
  BB3_HEIGHT_MAX,
  BB3_STOW_MAX,
  bbDeployed,
  bbDeployedHeightIn,
  bbHeightNow,
  bbStowHeightIn,
  bbStowLegal,
} from '../../src/games/biobuzz/config';
import { coerceBiobuzzSpec, BB_DEFAULT_SPEC } from '../../src/games/biobuzz/coerce';
import { createBiobuzzWorld } from '../../src/games/biobuzz/spawn';
import { biobuzzStep } from '../../src/games/biobuzz/step';
import type { Check } from './harness';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AI_DIR = join(root, 'src', 'games', 'biobuzz', 'ai');

/** every `.ts` under `ai/`, with its source, comments stripped the crude way the other source
 * guards strip them (good enough for a grep whose false positives would be inside a comment
 * describing the very string it looks for). */
function aiSources(): { name: string; lines: string[] }[] {
  return readdirSync(AI_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({
      name: `src/games/biobuzz/ai/${f}`,
      lines: readFileSync(join(AI_DIR, f), 'utf8')
        .split(/\r?\n/)
        // a ONE-LINE `/** … */` has to go too: two of `tiers.ts`'s own doc comments name
        // `localStorage` and `window` while describing what the policy must never touch, and a
        // stripper that understood only `//` and continuation lines flagged both.
        .map((line) =>
          line
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/, '')
            .replace(/^\s*\*.*$/, '')
            .replace(/^\s*\/\*.*$/, ''),
        ),
    }));
}

function seat(id: number, alliance: 'red' | 'blue', startIndex: number, fieldCentric: boolean): RobotSetup {
  return {
    id,
    alliance,
    spec: { ...BB_DEFAULT_SPEC },
    assists: { ...DEFAULT_ASSISTS, fieldCentric, aimAssist: false },
    startIndex,
  };
}

/** one seeded run: N ticks of the real pipeline with bots on `botIds`, logging every command and
 * every world hash. The thing two runs of which must be identical. */
function botRun(opts: {
  physics: Physics;
  ticks: number;
  seed: number;
  tiers: Record<number, string>;
  fieldCentric?: boolean;
  seats?: RobotSetup[];
}): { hashes: number[]; log: string[]; world: World } {
  const seats =
    opts.seats ??
    [seat(0, 'blue', 0, opts.fieldCentric ?? false), seat(1, 'red', 1, opts.fieldCentric ?? false)];
  const world = createBiobuzzWorld('match', opts.seed, seats, undefined, opts.physics);
  startMatch(world);
  const bots = Object.entries(opts.tiers).map(([id, tier]) => ({
    id: Number(id),
    seat: BIOBUZZ_BOT.create(world, Number(id), tier, opts.seed),
  }));
  const cmds = new Map<number, RobotCommand>();
  const hashes: number[] = [];
  const log: string[] = [];
  for (let t = 0; t < opts.ticks; t++) {
    for (const b of bots) {
      const c = b.seat.step(world);
      cmds.set(b.id, c);
      log.push(JSON.stringify(c));
    }
    biobuzzStep(world, SIM_DT, cmds);
    hashes.push(worldHash(world));
  }
  for (const b of bots) b.seat.dispose?.();
  return { hashes, log, world };
}

/** the first index at which two arrays differ, or -1. Reported instead of a bare `false`, because
 * "they diverge at tick 412" is a fixed bug and "not equal" is an afternoon. */
function firstDiff<T>(a: readonly T[], b: readonly T[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

export function aiChecks(check: Check): void {
  // ---- THE SEAM ----------------------------------------------------------------------------
  {
    check('BIOBUZZ registers a bot driver on the sim module', simModuleFor('biobuzz').bot !== undefined);
    check(
      'DECODE and Chain Reaction register NO bot (absent is what "this game has none" means)',
      simModuleFor('decode').bot === undefined && simModuleFor('chain').bot === undefined,
    );
    const bot = BIOBUZZ_SIM.bot!;
    check('three tiers, in difficulty order', bot.tiers.join(',') === 'easy,medium,hard', bot.tiers.join(','));
    check(
      'the default tier is one of them',
      (bot.tiers as readonly string[]).includes(bot.defaultTier),
      `${bot.defaultTier} of ${bot.tiers.join(',')}`,
    );
    check(
      'coerceTier folds an unknown / absent / non-string tier to the default',
      bot.coerceTier('nonsense') === BB_AI_DEFAULT_TIER &&
        bot.coerceTier(undefined) === BB_AI_DEFAULT_TIER &&
        bot.coerceTier(7) === BB_AI_DEFAULT_TIER &&
        bot.coerceTier('hard') === 'hard',
    );
    /**
     * `drive` IS DELIBERATELY ABSENT — a policy with hysteresis cannot answer a memoryless
     * one-shot with the behaviour `create` produces, so a server calling one while a client
     * predicted with the other would disagree about what the bot did. The check is here so that
     * an implementation added later is a deliberate act with a reason, not a convenience.
     */
    check('no memoryless `drive` — the seat is created and stepped', bot.drive === undefined);
    check(
      'every tier has a spec, and no two tiers are the same hands',
      BB_AI_TIERS.every((x) => BB_AI_TIER_SPECS[x] !== undefined) &&
        new Set(BB_AI_TIERS.map((x) => JSON.stringify(BB_AI_TIER_SPECS[x]))).size === BB_AI_TIERS.length,
    );
  }

  // ---- FREE DRIVE: an AI practice seat plays as it would in teleop ----------------------------
  //
  // The Practice card offers AI in Free drive too, where the phase is `freeplay` and there is no
  // clock. A policy that gated on `teleop` would sit there — a seat that spawns and never moves.
  for (const physics of ['2d', '3d'] as const) {
    const seed = 21;
    const world = createBiobuzzWorld('free', seed, [seat(0, 'blue', 0, false), seat(1, 'red', 1, false)], undefined, physics);
    const drv = BIOBUZZ_BOT.create(world, 1, 'medium', seed);
    const cmds = new Map<number, RobotCommand>();
    const x0 = world.robots[1].pos.x;
    const y0 = world.robots[1].pos.y;
    let live = 0;
    for (let t = 0; t < 600; t++) {
      const c = drv.step(world);
      if (c.driveX !== 0 || c.driveY !== 0 || c.rotate !== 0 || c.intake || c.fire) live++;
      cmds.set(1, c);
      biobuzzStep(world, SIM_DT, cmds);
    }
    drv.dispose?.();
    const moved = Math.hypot(world.robots[1].pos.x - x0, world.robots[1].pos.y - y0);
    check(
      `free drive (${physics}): the phase is freeplay and the AI drives in it`,
      world.match.phase === 'freeplay' && live > 60 && moved > 6,
      `phase ${world.match.phase}, ${live} live commands of 600, moved ${moved.toFixed(1)} in`,
    );
  }

  // ---- THE COMMAND IS ALREADY QUANTIZED ----------------------------------------------------
  //
  // A bot seat's command is RECORDED and BROADCAST exactly like a driver's, so it has to be a
  // value the wire can carry losslessly. `localizeCommand` is the wire round-trip and it is
  // idempotent, so "already quantized" is literally "the round-trip changes nothing".
  {
    const run = botRun({ physics: '2d', ticks: 900, seed: 5, tiers: { 0: 'hard', 1: 'easy' } });
    const bad = run.log.filter((s) => JSON.stringify(localizeCommand(JSON.parse(s) as RobotCommand)) !== s);
    check(
      'every bot command survives the wire round-trip unchanged (localizeCommand is identity)',
      bad.length === 0,
      `${bad.length} of ${run.log.length} differ — first: ${bad[0] ?? ''}`,
    );
    check('the quantization check saw real commands (else it is vacuous)', run.log.length === 1800, String(run.log.length));
  }

  // ---- DETERMINISM, BOTH PHYSICS -----------------------------------------------------------
  //
  // 3,600 ticks is a full MATCH's AUTO plus most of TELEOP — long enough for both HIVES to tip,
  // for the give-up memory to fire and for the escape behaviour to run, which are the three
  // places a bot could pick up state that is not seeded.
  for (const physics of ['2d', '3d'] as const) {
    const a = botRun({ physics, ticks: 3600, seed: 11, tiers: { 0: 'hard', 1: 'medium' } });
    const b = botRun({ physics, ticks: 3600, seed: 11, tiers: { 0: 'hard', 1: 'medium' } });
    const hd = firstDiff(a.hashes, b.hashes);
    const cd = firstDiff(a.log, b.log);
    check(
      `determinism (${physics}): two runs of 3,600 ticks produce the same world hashes`,
      hd === -1,
      hd === -1 ? '' : `first divergence at tick ${hd}: ${a.hashes[hd]} vs ${b.hashes[hd]}`,
    );
    check(
      `determinism (${physics}): two runs produce the same command log`,
      cd === -1,
      cd === -1 ? '' : `first divergence at entry ${cd}: ${a.log[cd]} vs ${b.log[cd]}`,
    );
    // …and the run has to be a run: a bot that returned the zero command for 3,600 ticks would
    // pass every equality above and prove nothing at all.
    check(
      `determinism (${physics}): the bots actually drove (more than one distinct command)`,
      new Set(a.log).size > 20,
      `${new Set(a.log).size} distinct commands over ${a.log.length}`,
    );
  }

  // ---- THE SEED AND THE SEAT BOTH MATTER ---------------------------------------------------
  //
  // Plan §6 seeds a bot `(matchSeed, seat)`. If either half did nothing the claim would be
  // decoration: two seats of one match would dither in lockstep, and two matches of one lobby
  // would be the same match.
  {
    const base = botRun({ physics: '2d', ticks: 600, seed: 21, tiers: { 0: 'medium' } });
    const other = botRun({ physics: '2d', ticks: 600, seed: 22, tiers: { 0: 'medium' } });
    check('a different match SEED gives a different command stream', firstDiff(base.log, other.log) !== -1);
    const pair = botRun({ physics: '2d', ticks: 600, seed: 21, tiers: { 0: 'medium', 1: 'medium' } });
    const seat0 = pair.log.filter((_, i) => i % 2 === 0);
    const seat1 = pair.log.filter((_, i) => i % 2 === 1);
    check('two seats of ONE match do not share a chain', firstDiff(seat0, seat1) !== -1);
  }

  // ---- THE READ LIST: `world.rngState` IS NOT ON IT ----------------------------------------
  /**
   * A `Proxy` that THROWS on the one property the policy may not touch. It is a stronger check
   * than a grep because the policy reaches the world through a dozen shared helpers
   * (`bbAimTarget`, `bbFlowerInReach`, `bbKindIndex`, …) and any one of them could read the
   * chain on its behalf.
   *
   * WHY IT MATTERS: the world's chain is CONSUMED — a draw moves every later draw in the match
   * (a spill's scatter, a human player's entry jitter). A bot drawing from it would make the
   * match depend on whether a bot was seated, so a client predicting a tick without the bot
   * would diverge from the server that ran it, and a replay would not re-simulate.
   */
  {
    const world = createBiobuzzWorld('match', 33, [seat(0, 'blue', 0, false), seat(1, 'red', 1, false)], undefined, '2d');
    startMatch(world);
    let touched = '';
    const guarded = new Proxy(world, {
      get(target, prop, recv) {
        if (prop === 'rngState') touched = 'rngState';
        return Reflect.get(target, prop, recv);
      },
      set(target, prop, value, recv) {
        if (typeof prop === 'string' && prop !== 'events') touched = touched || `set ${prop}`;
        return Reflect.set(target, prop, value, recv);
      },
    }) as World;
    const bot = BIOBUZZ_BOT.create(guarded, 0, 'hard', 33);
    const before = world.rngState;
    const cmds = new Map<number, RobotCommand>();
    for (let t = 0; t < 600; t++) {
      cmds.set(0, bot.step(guarded));
      biobuzzStep(world, SIM_DT, cmds); // the SIM steps the real world; only the bot sees the proxy
    }
    check('the policy never reads or writes world.rngState', touched === '', touched);
    check(
      'stepping the bot does not consume the world seeded chain by itself',
      typeof before === 'number' && typeof world.rngState === 'number',
    );
  }

  // ---- SOURCE: no DOM, no clock, no `process`, no heavy `sim3d/` --------------------------
  {
    const files = aiSources();
    check('the ai/ source scan sees files (else every check below is vacuous)', files.length >= 3, String(files.length));

    const hits = (rx: RegExp): string[] => {
      const out: string[] = [];
      for (const f of files) f.lines.forEach((line, i) => { if (rx.test(line)) out.push(`${f.name}:${i + 1}`); });
      return out;
    };

    const dom = hits(/\b(document|window|navigator|localStorage|sessionStorage|HTMLElement|requestAnimationFrame)\b/);
    check('ai/ touches no DOM (the authoritative server imports it)', dom.length === 0, dom.join(', '));

    const clock = hits(/\bDate\.now\s*\(|\bnew Date\s*\(|performance\.now\s*\(/);
    check('ai/ reads no wall clock (a replay must re-simulate exactly)', clock.length === 0, clock.join(', '));

    const engineMath = hits(/Math\.(sin|cos|tan|asin|acos|atan|atan2|hypot|pow|exp|log|cbrt|fround|random)\s*\(/);
    check(
      'ai/ uses NO engine-defined Math (dsin/dcos/datan2/hyp and the bot own PRNG instead)',
      engineMath.length === 0,
      engineMath.join(', '),
    );

    /**
     * ⚠️ `process` DOES NOT EXIST IN A BROWSER, and a bot decision runs inside the render loop.
     * A `process.env` debug hook in `policy.ts` threw on the first decision and unmounted the
     * game screen — green in Node, fatal on the page, which is why this is a source check and
     * not something a headless run could have found.
     */
    const node = hits(/\bprocess\s*\./);
    check('ai/ never touches `process` (it runs in a browser)', node.length === 0, node.join(', '));

    const meta = hits(/import\.meta/);
    check('ai/ never touches `import.meta` (the server and the smoke suite are not a bundle)', meta.length === 0, meta.join(', '));

    /**
     * THE LAZY-CHUNK BOUNDARY. `sim3d/` is ~1.1 MB of wasm glue behind a dynamic import; `ai/` is
     * in the MAIN chunk (a bot seat is offered in Practice setup before any physics has loaded),
     * so a static import from here would undo the whole split. `tilt.ts` is the one exception the
     * area guide allows, and the policy does not need even that.
     */
    const sim3d: string[] = [];
    for (const f of files) {
      f.lines.forEach((line, i) => {
        for (const m of line.matchAll(/(?:from|import)\s*\(?\s*['"][^'"]*sim3d\/([A-Za-z0-9_.]+)['"]/g)) {
          if (m[1] !== 'tilt') sim3d.push(`${f.name}:${i + 1} (sim3d/${m[1]})`);
        }
      });
    }
    check('ai/ imports nothing from sim3d/ but `tilt` (the physics chunk stays lazy)', sim3d.length === 0, sim3d.join(', '));

    // and the policy has to read the world THROUGH the shared helpers rather than reaching into
    // the engine: there is no other way to touch a Rapier handle from here, and a `rapier` import
    // would be the first sign someone found one.
    const rapier = hits(/from\s*['"][^'"]*rapier/i);
    check('ai/ imports no physics engine', rapier.length === 0, rapier.join(', '));
  }

  // ---- A BOT SCORES, UNDER BOTH PHYSICS ----------------------------------------------------
  //
  // 2v2 shaped: two BLUE bots against two RED robots with no driver at all, so nothing but the
  // bots moves and a score on the board is theirs. 90 seconds is the plan's own figure and it is
  // generous — a bot spawns with four POLLEN already in the hopper, so the whole task is "drive
  // to the up CELL's outboard side and put them in".
  for (const physics of ['2d', '3d'] as const) {
    const seats = [
      seat(0, 'blue', 0, false),
      seat(1, 'blue', 1, false),
      seat(2, 'red', 0, false),
      seat(3, 'red', 1, false),
    ];
    const run = botRun({
      physics,
      ticks: Math.round(90 / SIM_DT),
      seed: 41,
      tiers: { 0: 'hard', 1: 'hard' },
      seats,
    });
    const bb = run.world.biobuzz!;
    const cell = bb.hives.blue.contents.length;
    const tips = bb.hives.blue.tips;
    check(
      `a HARD bot pair scores within 90 s against idle robots (${physics})`,
      run.world.match.scores.blue.total > 0,
      `blue ${run.world.match.scores.blue.total} pts · cell ${cell} · tips ${tips}`,
    );
    check(
      `…and it did it by putting elements in its own CELL, not by collecting fouls (${physics})`,
      cell + tips > 0,
      `cell ${cell} · tips ${tips} · foulPoints ${run.world.match.scores.blue.foulPoints}`,
    );
    check(
      `the idle opponents never moved, so the score is the bots' (${physics})`,
      run.world.match.scores.red.total - run.world.match.scores.red.foulPoints <= 8,
      `red ${run.world.match.scores.red.total} (fouls ${run.world.match.scores.red.foulPoints})`,
    );
  }

  // ---- THE BOT DRIVES A FIELD-CENTRIC SEAT TOO ---------------------------------------------
  //
  // `updateRobot` interprets `driveX/driveY` through `r.fieldCentric` AND through
  // `viewAngleOf(alliance)`. A policy that assumed one frame would drive a RED seat the opposite
  // way from a BLUE one at ±90°, which is the shape of the bug `CLAUDE.md` records for the
  // driver stick itself — so both frames are exercised, not just the harness default.
  {
    const fc = botRun({ physics: '2d', ticks: 1200, seed: 51, tiers: { 0: 'hard', 1: 'hard' }, fieldCentric: true });
    const start = createBiobuzzWorld('match', 51, [seat(0, 'blue', 0, true), seat(1, 'red', 1, true)], undefined, '2d');
    const moved = fc.world.robots.map((r, i) => {
      const s = start.robots[i];
      return Math.abs(r.pos.x - s.pos.x) + Math.abs(r.pos.y - s.pos.y);
    });
    check(
      'a FIELD-CENTRIC seat is driven somewhere (both alliances)',
      moved.every((d) => d > 12),
      moved.map((d) => d.toFixed(1)).join(' / '),
    );
  }

  // ---- R102: THE STOW HEIGHT AND THE DEPLOY LATCH (plan §3.3) -------------------------------
  {
    const short = coerceBiobuzzSpec({ ...BB_DEFAULT_SPEC, heightIn: 16 });
    const tall = coerceBiobuzzSpec({ ...BB_DEFAULT_SPEC, heightIn: BB3_HEIGHT_MAX });
    check('a build inside R102 cube stows at its own height', bbStowHeightIn(short) === 16, String(bbStowHeightIn(short)));
    check(
      'a build over the cube is modelled as folding to exactly the cube',
      bbStowHeightIn(tall) === BB3_STOW_MAX && bbDeployedHeightIn(tall) === BB3_HEIGHT_MAX,
      `${bbStowHeightIn(tall)} stowed / ${bbDeployedHeightIn(tall)} deployed`,
    );
    check('both are LEGAL to start', bbStowLegal(short) && bbStowLegal(tall));

    /**
     * THE RULE IS REFUSABLE, which is the whole point of not clamping the declared value to 18 in
     * the coercer. `RobotSpec` has no `stowHeightIn` field yet (that is a `src/types.ts` edit plus
     * a carry-across in the shared `coerceSpec`), so the declaration is read structurally and this
     * is what proves the rule binds the day the field lands rather than becoming decoration.
     */
    // RAW, not coerced: the coercer caps the height at BB3_HEIGHT_MAX (18), which pulls any stow
    // under the cube, so only a spec that skipped it (a spoofed wire spec) can still be refused
    const declared = { ...BB_DEFAULT_SPEC, heightIn: 29, stowHeightIn: 22 } as never as RobotSpec;
    check(
      'a DECLARED stow over the cube is refused by R102',
      bbStowHeightIn(declared) === 22 && !bbStowLegal(declared),
      `stow ${bbStowHeightIn(declared)} vs cube ${BB3_STOW_MAX}`,
    );
    check(
      'and `GameSimModule.startLegal` refuses it, pose or no pose',
      BIOBUZZ_SIM.startLegal!(declared, 'blue', null) === false &&
        BIOBUZZ_SIM.startLegal!(tall, 'blue', null) === true,
    );
    const over = coerceBiobuzzSpec({ ...BB_DEFAULT_SPEC, heightIn: 16, stowHeightIn: 40 } as never);
    check(
      'a declared stow TALLER than the deployed height is normalized down to it',
      bbStowHeightIn(over) === 16,
      String(bbStowHeightIn(over)),
    );

    // THE LATCH IS A READ OF `world.match`, not a stored flag (plan §3.3).
    const w = createBiobuzzWorld('match', 61, [seat(0, 'blue', 0, false)], undefined, '3d');
    check('before the match a tall robot is STOWED', !bbDeployed(w) && bbHeightNow(w, tall) === BB3_STOW_MAX);
    startMatch(w);
    check('once the match begins it is DEPLOYED', bbDeployed(w) && bbHeightNow(w, tall) === BB3_HEIGHT_MAX);
    check('a short robot reads the same height either side of the edge', bbHeightNow(w, short) === 16);

    /**
     * …AND THE 3D COLLIDER FOLLOWS, WITHOUT THE ROBOT MOVING. The body's centre is `z + height/2`,
     * so a collider rebuilt at a new height with the readback still subtracting the old one makes
     * `RobotState.z` jump by the difference on the deploy tick — a robot that visibly sinks into
     * the tiles for a frame, and a `worldHash` that moves for no gameplay reason.
     */
    const dw = createBiobuzzWorld(
      'match',
      62,
      [{ ...seat(0, 'blue', 0, false), spec: tall }],
      undefined,
      '3d',
    );
    const zero = new Map<number, RobotCommand>([[0, localizeCommand({ driveX: 0, driveY: 0, rotate: 0, leftDrive: 0, rightDrive: 0, intake: false, fire: false })]]);
    for (let t = 0; t < 30; t++) biobuzzStep(dw, SIM_DT, zero);
    const zPre = dw.robots[0].z ?? 0;
    startMatch(dw);
    for (let t = 0; t < 30; t++) biobuzzStep(dw, SIM_DT, zero);
    const zPost = dw.robots[0].z ?? 0;
    check(
      'the deploy edge rebuilds the 3D chassis collider without moving the robot',
      Math.abs(zPost - zPre) < 0.25 && Math.abs(zPost) < 0.25,
      `z ${zPre.toFixed(4)} -> ${zPost.toFixed(4)}`,
    );
  }
}

/** the lane's own file list, exported so `docaudit`-style greps and a reader can see at a glance
 * that this lane owns no fixture of its own. */
export const AI_LANE_SOURCES = relative(root, AI_DIR);

/**
 * The bot-driven step budget, run in the PERF lane (`index.ts`), which `npm test` runs on its own
 * after every other shard. Run beside 17 other test processes it read p95 1.06-1.14 ms against
 * 0.50 idle and crossed 1.5 now and then, which measured the suite's load, not `step3d`.
 */
export function aiPerfChecks(check: Check): void {
  // ---- PERF: `step3d` WITH BOTS DRIVING ----------------------------------------------------
  /**
   * ⚠️ **A BOT-DRIVEN 2v2 IS A DIFFERENT MEASUREMENT FROM THE SIM3D LANE'S.** That one holds four
   * SCRIPTED commands for the whole run, so the elements end up wherever the first few seconds
   * put them and most of the match is four chassis pushing a settled field around. Bots CAPTURE,
   * LAUNCH, TIP and SPILL, which is where the contact count actually lives — measured, the same
   * 2v2 costs 0.255 ms median / 0.353 p95 on scripted commands and 0.345 / 0.498 with bots
   * driving, i.e. the cheaper number is the one that is easy to keep passing.
   *
   * `performance.now()` rather than `Date.now()`: a 0.3 ms median is BELOW the resolution of the
   * millisecond clock, so the scripted lane's own numbers are quantised to 0 or 1. A smoke script
   * is not sim code and the determinism rule does not reach it.
   *
   * ⚠️ **BOTH ASSERTIONS ARE THE PLAN'S §3.10 BUDGET (1.5 ms), NOT THE MEASUREMENT.** A tighter
   * watch was tried at the measured p95 plus a little — 0.75 ms — and it failed the first time the
   * suite ran beside anything else on the box (0.778 ms), which is a check that reports the
   * machine's load rather than the code's cost. The numbers to compare a suspicious run against
   * are in the printed line and here: on an idle dev box this scene is median 0.345 ms, p95
   * 0.498, p99 0.608, and the four bot decisions together are 0.004 ms.
   */
  {
    const seats = [
      seat(0, 'blue', 0, false),
      seat(1, 'blue', 1, false),
      seat(2, 'red', 0, false),
      seat(3, 'red', 1, false),
    ];
    const world = createBiobuzzWorld('match', 99, seats, undefined, '3d');
    startMatch(world);
    const bots = [0, 1, 2, 3].map((id) => BIOBUZZ_BOT.create(world, id, 'hard', 99));
    const cmds = new Map<number, RobotCommand>();
    const step: number[] = [];
    const think: number[] = [];
    for (let t = 0; t < 1320; t++) {
      const t0 = performance.now();
      for (let i = 0; i < 4; i++) cmds.set(i, bots[i].step(world));
      const t1 = performance.now();
      biobuzzStep(world, SIM_DT, cmds);
      const t2 = performance.now();
      if (t >= 120) {
        think.push(t1 - t0);
        step.push(t2 - t1);
      }
    }
    for (const b of bots) b.dispose?.();
    const pct = (a: number[], p: number): number => {
      const s = [...a].sort((x, y) => x - y);
      return s[Math.min(s.length - 1, Math.floor(s.length * p))];
    };
    const median = pct(step, 0.5);
    const p95 = pct(step, 0.95);
    const thinkMedian = pct(think, 0.5);
    console.log(
      `[smoke-bb ai] step3d 2v2 with bots: median ${median.toFixed(3)}ms, p95 ${p95.toFixed(3)}ms` +
        `  ·  4 bot decisions: median ${thinkMedian.toFixed(3)}ms`,
    );
    check('perf: bot-driven 2v2 step3d median <= 1.5ms (plan §3.10)', median <= 1.5, `median=${median.toFixed(3)}ms`);
    check('perf: bot-driven 2v2 step3d p95 <= 1.5ms (plan §3.10)', p95 <= 1.5, `p95=${p95.toFixed(3)}ms (${step.length} samples)`);
    /**
     * AND THE DRIVER ITSELF IS FREE. Four bots re-solving a ballistic arc is the one thing in this
     * lane that could plausibly cost a room anything, and it does not: the policy decides on a
     * 6-tick cadence and holds in between, so 59 of every 60 ticks are a map lookup. If this ever
     * approaches the step cost, the cadence is the lever, not the policy.
     */
    check(
      'perf: four bot decisions cost under a fifth of the tick they ride on',
      thinkMedian <= median * 0.2,
      `bots ${thinkMedian.toFixed(3)}ms vs step ${median.toFixed(3)}ms`,
    );
  }
}
