import type { Alliance, GameMode, RobotCommand, RobotSpec, World } from '../../src/types';
import { SIM_DT } from '../../src/config';
import { DEFAULT_ASSISTS, type RobotSetup } from '../../src/sim/spawn';
import { createBiobuzzWorld } from '../../src/games/biobuzz/spawn';
import { biobuzzStep } from '../../src/games/biobuzz/step';
import { BB_DEFAULT_SPEC, bbCoerceSpec } from '../../src/games/biobuzz/robotConfig';

/**
 * The BIOBUZZ smoke harness — the `check` function and the fixtures both lane files share.
 *
 * ── WHY IT IS A SEPARATE SUITE FROM `scripts/smoke.ts` ─────────────────────
 * `smoke.ts` is 800KB of DECODE + Chain Reaction physics assertions and a RED `npm test` there
 * has one meaning: "the physics broke". A pre-Kickoff game whose numbers are all `APPROX` and
 * whose gameplay is a stub would put a second, weaker meaning on the same signal. So BIOBUZZ
 * gets its own entry point, its own pass/fail line, and its own exit code — and the lanes get
 * a file each, which is what makes two people able to add checks without touching one file.
 *
 * ── THE `check(name, ok, detail)` CONTRACT, COPIED ON PURPOSE ──────────────
 * Same shape as `smoke.ts`: it PRINTS every result, pass or fail, and counts the failures.
 * Not an assertion that throws. That is deliberate and it is the difference between "42 checks
 * ran, 1 failed, here is which" and "something threw on line 300 and the other 41 never ran" —
 * with a physics suite the second one hides regressions behind the first failure.
 *
 * `detail` carries the ACTUAL numbers, always, on failures that involve one. A containment
 * failure that says `x=73.2 > 72` is a fixed bug; one that says `false` is an afternoon.
 */
export type Check = (name: string, ok: boolean, detail?: string) => void;

/** a full `RobotCommand` from the fields a check cares about. */
export function cmd(patch: Partial<RobotCommand>): RobotCommand {
  return {
    driveX: 0,
    driveY: 0,
    rotate: 0,
    leftDrive: 0,
    rightDrive: 0,
    intake: false,
    fire: false,
    ...patch,
  };
}

/**
 * A BIOBUZZ setup with EVERY ASSIST OFF and robot-centric drive.
 *
 * `DEFAULT_ASSISTS` is field-centric, which routes a stick through
 * `viewAngleOf(alliance)` — so `driveY: 1` would drive a red robot the opposite way from a
 * blue one and the wall-containment check would test two different things per alliance. Every
 * check here wants "forward, in the robot's own frame".
 */
export function setup(
  id: number,
  alliance: Alliance,
  spec: Partial<RobotSpec> = {},
  startIndex = 0,
): RobotSetup {
  return {
    id,
    alliance,
    spec: { ...BB_DEFAULT_SPEC, ...spec },
    assists: { ...DEFAULT_ASSISTS, fieldCentric: false, aimAssist: false },
    startIndex,
  };
}

/** a BIOBUZZ world with one blue robot, the common fixture. */
export function mkWorld(mode: GameMode, seed: number, spec: Partial<RobotSpec> = {}): World {
  return createBiobuzzWorld(mode, seed, [setup(0, 'blue', spec)]);
}

/** step `seconds` of real BIOBUZZ pipeline with one command held on robot 0. */
export function run(world: World, c: RobotCommand, seconds: number): void {
  const commands = new Map([[0, c]]);
  const n = Math.round(seconds / SIM_DT);
  for (let i = 0; i < n; i++) biobuzzStep(world, SIM_DT, commands);
}

/**
 * THE FULL COERCION A BIOBUZZ SPEC ACTUALLY GETS.
 *
 * `coerceSpec(raw, base, 'biobuzz')` alone is NOT it, and naming that is the point of this
 * indirection: the shared coercer has no biobuzz arm yet (Lane B owns it, per the lane
 * contract), so for an unrecognised game it RESETS the mechanism mounts — which is correct for
 * DECODE and destroys a BIOBUZZ build. `bbCoerceSpec` is the composition every BIOBUZZ spawn
 * path runs: the shared chokepoint, the raw mounts re-armed, then this game's own arm. Its
 * header carries the full reasoning.
 *
 * When Lane B lands the real arm, `bbCoerceSpec` collapses to a single `coerceSpec` call and
 * every check written against this keeps passing unchanged — which is why the checks are
 * written against it rather than against today's plumbing.
 */
export function bbCoerce(raw: unknown): RobotSpec {
  return bbCoerceSpec(raw);
}
