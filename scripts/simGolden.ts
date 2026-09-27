/**
 * THE GOLDEN-HASH GUARD — does `step()` still produce, bit for bit, what this SIM_VERSION says?
 *
 * A replay is `{seed, setups, commands}` stamped with `SIM_VERSION` (`src/config.ts`), and the
 * viewer trusts that stamp: two builds that report the same number are assumed to re-simulate
 * the same log into the same match. Nothing enforced it. Behaviour moved under an unchanged
 * number more than once (the version block in `config.ts` lists replays mis-stamped for exactly
 * that reason), and every existing check measures a BEHAVIOUR — "the ball bounced about right"
 * — which a changed-but-still-plausible sim passes.
 *
 * So each game runs a few fixed scenes — a fixed seed, fixed setups, and a scripted command
 * stream with no dependence on the clock, the engine's `Math.sin`, or anything but integers —
 * and hashes the WHOLE world at a few checkpoints. The table in each suite pins those hashes
 * per SIM_VERSION. It has two jobs:
 *
 *  · a change meant to be BYTE-IDENTICAL (a refactor, a speed-up) proves itself: same hashes;
 *  · a change that moves output cannot land silently under an old SIM_VERSION: the check fails
 *    and says to bump the number (which retires older replays, deliberately) and add a row.
 *
 * WHAT IS HASHED: every field of the world, keys SORTED (so reordering an object literal is not
 * a change), numbers at full precision (`JSON.stringify` writes the shortest round-trip form, so
 * two doubles that differ in the last bit print differently), with ONE exclusion: `events`, the
 * human-readable log, so rewording a line of UI copy is not a sim change. Scores, fouls and cards
 * are all in the world in numeric form, so nothing the log reports goes unhashed.
 *
 * DO NOT "FIX" A FAILURE BY PASTING THE NEW HASHES UNDER THE OLD VERSION unless the change
 * genuinely is not a behaviour change (a new world field that is always its default, say) and
 * you can say why in the commit.
 */
import { createHash } from 'node:crypto';
import type { GameId, RobotCommand, World } from '../src/types';

/** every world field, sorted keys, full precision, `events` left out */
export function canonicalWorld(world: World): string {
  const walk = (v: unknown, top: boolean): string => {
    if (v === null || typeof v !== 'object') {
      // `undefined` inside an array is `null` in JSON; a property holding it is skipped below
      return v === undefined ? 'null' : JSON.stringify(v);
    }
    if (Array.isArray(v)) return `[${v.map((x) => walk(x, false)).join(',')}]`;
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined && typeof o[k] !== 'function' && !(top && k === 'events'))
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${walk(o[k], false)}`).join(',')}}`;
  };
  return walk(world, true);
}

/** 16 hex digits of SHA-256 over `canonicalWorld` — plenty to tell two sims apart */
export function goldenHash(world: World): string {
  return createHash('sha256').update(canonicalWorld(world)).digest('hex').slice(0, 16);
}

/**
 * A reproducible driver for robot `id`: a new stick every 45 ticks from an integer LCG, already
 * on the wire's 1/127 grid (so the scene is what `localizeCommand` would have produced), the
 * intake held most of the time and fire pulsed. Buttons the game does not read are harmless.
 */
export function scriptedCommand(id: number, tick: number): RobotCommand {
  const seg = Math.floor(tick / 45);
  let s = (Math.imul(seg + 1, 0x9e3779b1) ^ Math.imul(id + 7, 0x85ebca6b)) >>> 0;
  const next = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return ((s >>> 8) % 255) - 127; // -127..127
  };
  const dx = next();
  const dy = next();
  const rot = next() >> 1;
  const ld = next();
  const rd = next();
  const buttons = next() + 127; // 0..254
  return {
    driveX: dx / 127,
    driveY: dy / 127,
    rotate: rot / 127,
    leftDrive: ld / 127,
    rightDrive: rd / 127,
    intake: tick % 300 < 220,
    fire: tick % 240 >= 180,
    catalyst: (buttons & 3) === 0 && tick % 90 < 10,
    fling: (buttons & 12) === 0 && tick % 120 < 6,
    driveMode: (buttons & 48) === 0 && tick % 150 < 8,
  };
}

export interface GoldenScene {
  name: string;
  game: GameId;
  /** a fresh world, already set up (match countdown armed, any scene edits applied) */
  build: () => World;
  step: (world: World, dt: number, commands: Map<number, RobotCommand>) => void;
  ticks: number;
  /** hash every this many ticks — so a failure names roughly WHERE it diverged */
  every: number;
  /** the driver; defaults to `scriptedCommand` (a game adds its own buttons by wrapping it) */
  command?: (id: number, tick: number) => RobotCommand;
}

/** run a scene: its checkpoint hashes (the last is the tick-`ticks` world) and the final world,
 *  which the caller should test for having actually DONE something — a scene of idle robots
 *  pins nothing */
export function runGolden(scene: GoldenScene, dt: number): { hashes: string[]; world: World } {
  const w = scene.build();
  const out: string[] = [];
  for (let t = 1; t <= scene.ticks; t++) {
    const cmds = new Map<number, RobotCommand>();
    for (const r of w.robots) cmds.set(r.id, (scene.command ?? scriptedCommand)(r.id, t));
    scene.step(w, dt, cmds);
    if (t % scene.every === 0) out.push(goldenHash(w));
  }
  return { hashes: out, world: w };
}

/**
 * Compare a run against the table and explain a mismatch the way the author needs to hear it.
 * Returns [ok, detail].
 */
export function judgeGolden(
  scene: GoldenScene,
  got: string[],
  table: Record<number, Record<string, string[]>>,
  simVersion: number,
  tableFile: string,
): [boolean, string] {
  const row = table[simVersion];
  const want = row?.[scene.name];
  const paste = `${JSON.stringify(scene.name)}: ${JSON.stringify(got)}`;
  if (!want) {
    return [
      false,
      `SIM_VERSION ${simVersion} has no golden hashes for this scene. If you just bumped ` +
        `SIM_VERSION on purpose, add under ${simVersion} in ${tableFile}:  ${paste}`,
    ];
  }
  const at = got.findIndex((h, i) => h !== want[i]);
  if (at < 0 && got.length === want.length) return [true, `${got.length} checkpoints, last ${got[got.length - 1]}`];
  const tick = (at < 0 ? Math.min(got.length, want.length) : at + 1) * scene.every;
  return [
    false,
    `step() output CHANGED under SIM_VERSION ${simVersion} (first divergence by tick ${tick}). ` +
      `If this change was meant to be byte-identical, it is not: find the regression. If it is a ` +
      `real behaviour change, bump SIM_VERSION in src/config.ts (that retires older replays — ` +
      `say so in the commit) and add a new row to ${tableFile}:  ${paste}`,
  ];
}
