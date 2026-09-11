import type { Alliance, Artifact, RobotCommand, RobotSpec, StartPose, World } from '../../types';
import * as C from '../../config';
import type { RobotSetup } from '../../sim/spawn';
import { driveParams } from '../../sim/drivetrain';
import { BB_POLLEN_R } from './config';
import { BB_DEFAULT_SPEC } from './robotConfig';
import { createBiobuzzWorld } from './spawn';
import { biobuzzStep } from './step';
import { BB_FIELD_SCENES } from './scenesField';
import { BB_ROBOT_SCENES } from './scenesRobot';

/**
 * BIOBUZZ SCENES — the deterministic, DOM-free half of the visual feedback loop.
 *
 * A SCENE is a world plus an optional scripted driver plus the ticks worth looking at. That is
 * all. It is not a test, not a component and not a fixture: it is a repeatable situation, and
 * everything else in the loop is a different way of consuming one.
 *
 *   • `Gallery.tsx` draws each scene at each of its `stills`, through the REAL module
 *     renderers, so a picture in the gallery is a picture of the game.
 *   • `scripts/shots.cjs` screenshots those cells in both themes so Claude can look at its
 *     own output before a human spends review time on it.
 *   • `scripts/smoke-biobuzz/*` steps every scene to its last still and hashes the world, so
 *     EVERY SCENE IS ALSO A DETERMINISM CHECK, for free and without anybody writing one.
 *
 * That last point is why the type is this narrow. A scene that could reach a clock, a DOM node
 * or `Math.random` would hash differently on two machines and the check would have to be
 * switched off — so `build` and `script` are pure functions of (seed) and (world, tick), and
 * the only randomness available is the mulberry32 chain already on `world.rngState`.
 *
 * ── THIS FILE IS FROZEN AFTER PHASE 0 ──────────────────────────────────────
 * Per `docs/biobuzz-contract.md`, the registry is shared ground: Lane A adds scenes to
 * `scenesField.ts`, Lane B to `scenesRobot.ts`, and neither edits this file. What lives here is
 * the TYPE, the STEPPING (so the gallery and smoke can never step a scene differently, which
 * would make the gallery a picture of something smoke never checked), and the small builder
 * helpers both lanes need.
 *
 * ── THE IMPORT CYCLE IS DELIBERATE, AND HAS ONE RULE ───────────────────────
 * This file imports the lane files for their scene lists, and the lane files import this one
 * for the helpers. That is a genuine ES module cycle and it is the price of the layout the
 * contract asks for: ONE registry the gallery and smoke import, TWO lane files that never
 * touch each other's ground.
 *
 * It is safe because of one rule, and it stays safe only while the rule holds:
 *
 *     A LANE FILE MAY USE THIS FILE'S EXPORTS ONLY INSIDE `build` / `script` CLOSURES,
 *     NEVER AT MODULE SCOPE.
 *
 * By the time any closure runs, both modules are fully evaluated. A lane file that called
 * `bbPile(...)` at module scope — instead of inside `build` — would read a binding this module
 * has not initialised yet and crash at import with a `ReferenceError` that names the wrong
 * file. Every scene here is written as a closure for that reason, not as a style choice.
 */

/** which lane owns a scene — and therefore which smoke file asserts it. */
export type BbLane = 'field' | 'robot';

export interface Scene {
  /** stable, kebab-case, used in the URL (`/biobuzz/gallery/<id>`) and as the shot filename.
   * Renaming one orphans a human's feedback dump, so treat it as public. */
  id: string;
  /** one line, shown as the cell's heading. */
  title: string;
  lane: BbLane;
  /** build the scene's world. PURE in `seed` — no clock, no DOM, no `Math.random`. */
  build(seed: number): World;
  /**
   * The driver, per tick, keyed by robot id. Absent for a scene with nothing to drive.
   *
   * Called with the world BEFORE the step it feeds, and `tick` is the tick about to run
   * (0-based), so `tick === 0` is the first command any robot ever receives. Reading `world`
   * is allowed and is what makes "drive until you touch the wall" expressible; MUTATING it is
   * not — the step owns the world, and a script that wrote to it would put scene-only physics
   * into a picture that claims to be the game.
   */
  script?(world: World, tick: number): Record<number, RobotCommand>;
  /**
   * The ticks worth LOOKING AT, ascending. The last one is how far smoke steps.
   *
   * `0` means the built world before anything moves, which is the right still for a layout
   * scene and the wrong one for a physics scene — a pile only tells you something after the
   * robot has hit it.
   */
  stills: number[];
}

/**
 * THE SEED. One constant for every scene, so a scene id is a complete description of a
 * picture: two people quoting `pile-fast@90` are quoting the same frame. Overridable per call
 * for the physics chat, which wants to see whether a behaviour survives a different scatter.
 */
export const BB_SCENE_SEED = 20260910;

/** every scene, both lanes. Order is the gallery's order: field first (the field is the thing
 * a reviewer has to accept before a robot on it means anything), then robots. */
export const BB_SCENES: readonly Scene[] = [...BB_FIELD_SCENES, ...BB_ROBOT_SCENES];

/** look a scene up by id — the route (`/biobuzz/gallery/<id>`) and `--scene` both need it. */
export function bbScene(id: string): Scene | undefined {
  return BB_SCENES.find((s) => s.id === id);
}

/** every cell the gallery renders and `shots.cjs` screenshots: one per scene per still. The
 * `cell` string is the caption AND the shot filename, so it is defined once, here. */
export function bbSceneCells(): { scene: Scene; tick: number; cell: string }[] {
  return BB_SCENES.flatMap((scene) =>
    scene.stills.map((tick) => ({ scene, tick, cell: `${scene.id}@${tick}` })),
  );
}

/**
 * Step a scene from its built state to `toTick`, and return the world there.
 *
 * THE ONE STEPPING PATH. The gallery, the live route and smoke all come through here, which is
 * the point: a still the gallery draws is a still smoke hashed, at the same tick, having run
 * the same commands. When they each stepped their own way, a scene could look right in the
 * gallery and hash differently in CI, and the disagreement was the bug.
 */
export function bbSceneAt(scene: Scene, toTick: number, seed = BB_SCENE_SEED): World {
  const world = scene.build(seed);
  for (let t = 0; t < toTick; t++) tickScene(scene, world, t);
  return world;
}

/** one scene tick: ask the script for this tick's commands, key them by robot id, step. The
 * `Record<number, …>` the script returns comes back from `Object.entries` with STRING keys —
 * the command map the step takes is keyed by number, and that conversion belongs in one place
 * rather than at each call site, where getting it wrong silently drives nobody. */
function tickScene(scene: Scene, world: World, tick: number): void {
  const cmds = new Map<number, RobotCommand>();
  for (const [id, cmd] of Object.entries(scene.script?.(world, tick) ?? {})) cmds.set(Number(id), cmd);
  biobuzzStep(world, C.SIM_DT, cmds);
}

/**
 * Every still of one scene, in ONE forward run.
 *
 * Not `stills.map(t => bbSceneAt(scene, t))`: that re-simulates from tick 0 for each still, so
 * a scene with stills `[0, 60, 120, 300]` costs 480 ticks instead of 300 — and the gallery
 * renders every scene at once. Each still is a `structuredClone` of the live world, because the
 * step mutates in place and handing the same object to four canvases would draw the last state
 * four times.
 */
export function bbSceneStills(scene: Scene, seed = BB_SCENE_SEED): { tick: number; world: World }[] {
  const out: { tick: number; world: World }[] = [];
  const want = [...scene.stills].sort((a, b) => a - b);
  const world = scene.build(seed);
  let t = 0;
  for (const at of want) {
    for (; t < at; t++) tickScene(scene, world, t);
    // A snapshot, not a reference. `World` is plain JSON by the determinism rule, so a
    // structural clone is complete — there is no class instance or closure in here to lose.
    out.push({ tick: at, world: structuredClone(world) });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// BUILDER HELPERS — shared by both lanes' scene files
// ─────────────────────────────────────────────────────────────────────────────

/** the neutral command: everything centred, nothing pressed. FROZEN, because it is handed out
 * by reference on most ticks and one script mutating it would rewrite every other scene's
 * driver. */
export const BB_IDLE: RobotCommand = Object.freeze({
  driveX: 0,
  driveY: 0,
  rotate: 0,
  leftDrive: 0,
  rightDrive: 0,
  intake: false,
  fire: false,
});

/** a command with only the fields a scene cares about. */
export function bbCmd(p: Partial<RobotCommand>): RobotCommand {
  return { ...BB_IDLE, ...p };
}

/**
 * EVERY ASSIST OFF, for every scene.
 *
 * Not `DEFAULT_ASSISTS` (which is field-centric) and emphatically not `PLAYER_ASSISTS`. Two
 * reasons, both about reading a picture:
 *  • ROBOT-CENTRIC — `driveY: 1` means "forward" in the robot's own frame, so a scene's script
 *    says what the robot does rather than what a camera would have made of it. Field-centric
 *    would route the stick through `viewAngleOf(alliance)`, and the same script would drive a
 *    red robot the other way.
 *  • NO AUTO-INTAKE, NO AUTO-FIRE, NO AIM ASSIST — a scene showing an intake must show the
 *    intake it COMMANDED. With the assists on, `pile-slow` would quietly collect the pile it
 *    was built to plow through, and the cell would be a picture of the assist.
 */
const SCENE_ASSISTS = Object.freeze({
  fieldCentric: false,
  aimAssist: false,
  autoIntake: false,
  autoFire: false,
});

/**
 * A scene's robot setup.
 *
 * `place` is either a FIELD-coordinate pose or one of this game's start-anchor indices. A pose
 * goes in as a custom start pose, so it runs through the same `coerceStartPose` + spawn path a
 * player's saved pose does — a scene cannot put a robot anywhere the game would not.
 */
export function bbSetup(
  id: number,
  alliance: Alliance,
  place: StartPose | number,
  spec: Partial<RobotSpec> = {},
): RobotSetup {
  return {
    id,
    alliance,
    spec: { ...BB_DEFAULT_SPEC, ...spec },
    assists: { ...SCENE_ASSISTS },
    startIndex: typeof place === 'number' ? place : 0,
    startPose: typeof place === 'number' ? undefined : place,
  };
}

/** a scene's world: the real spawn path, with the initial POLLEN scatter REPLACED.
 *
 * Every scene builds through `createBiobuzzWorld` rather than assembling a `World` literal, so
 * a scene automatically inherits whatever the real spawn does — the inert goals, the penalty
 * bag, the phase machine in `freeplay`, the coerced specs. `pollen` then swaps in the layout
 * the scene is actually about (a 12-ball pile, a wall row, nothing at all); pass `undefined`
 * to keep the real 60-POLLEN scatter, which is what the spawn and settle scenes want.
 */
export function bbWorld(seed: number, setups: RobotSetup[], pollen?: Artifact[]): World {
  const world = createBiobuzzWorld('free', seed, setups);
  if (pollen) {
    world.balls = pollen;
    // Keep the id sequence past the layout, exactly as the spawn does, so a POLLEN launched
    // during the scene cannot alias one that is already on the floor.
    if (world.biobuzz) world.biobuzz.nextBallId = pollen.reduce((m, b) => Math.max(m, b.id + 1), 1);
  }
  return world;
}

/** one POLLEN at rest on the floor. Ids are assigned by the caller and must be unique and
 * STABLE within a scene: the shared artifact solve creates one Rapier body per pollen in
 * `world.balls` order and Rapier's contact resolution depends on collider creation order, so
 * renumbering a pile changes the physics, and a scene whose ids depend on iteration order is a
 * scene that hashes differently for no visible reason. */
export function bbPollen(id: number, x: number, y: number): Artifact {
  return { id, color: 'green', state: { kind: 'ground' }, pos: { x, y }, vel: { x: 0, y: 0 }, z: 0, vz: 0 };
}

/**
 * A ROW of POLLEN, `n` of them, from `(x0,y0)` toward `(x1,y1)` inclusive.
 *
 * Spacing is not checked against the pollen diameter on purpose: `wall-row-sweep` wants them
 * just touching and a squeeze scene wants them overlapping, and watching the separator push an
 * overlapping pair apart on tick 1 is itself one of the things the gallery is for.
 */
export function bbRow(startId: number, n: number, x0: number, y0: number, x1: number, y1: number): Artifact[] {
  return Array.from({ length: n }, (_, i) => {
    const t = n === 1 ? 0 : i / (n - 1);
    return bbPollen(startId + i, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
  });
}

/**
 * A PILE: `n` POLLEN in a hex-packed blob centred on `(cx,cy)`.
 *
 * Hex-packed rather than random, and that is the whole point of the scene set — a pile you can
 * reason about. A random blob makes "did the robot scatter them or did the separator?" an
 * unanswerable question, because you cannot tell a solver artefact from the layout you started
 * with. Rows alternate a half-step so the packing is what loose balls actually settle into.
 */
export function bbPile(startId: number, n: number, cx: number, cy: number): Artifact[] {
  const d = BB_POLLEN_R * 2 + 0.05; // a hair apart, so tick 0 is a legal layout, not a fix-up
  const perRow = Math.max(1, Math.ceil(Math.sqrt(n)));
  const rows = Math.ceil(n / perRow);
  const out: Artifact[] = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / perRow);
    const c = i % perRow;
    const wide = Math.min(perRow, n - r * perRow); // the last row is short: centre it too
    out.push(
      bbPollen(
        startId + i,
        cx + (c - (wide - 1) / 2) * d,
        cy + (r - (rows - 1) / 2) * d * 0.866, // hex row pitch = d·√3/2
      ),
    );
  }
  return out;
}

/**
 * The throttle that holds a robot at `target` in/s, or full throttle when it cannot get there.
 *
 * The three `pile-*` scenes differ ONLY in impact speed, so the speed has to be a number the
 * scene sets rather than a consequence of the spec's gearing — otherwise re-tuning
 * `SPEED_PER_RPM` silently turns `pile-slow` into `pile-med` and every stored feedback dump
 * about them becomes wrong. Governing by throttle rather than by writing `vel` directly keeps
 * the robot inside the drivetrain model: it accelerates like a robot, and a collision decides
 * what happens next, which is the thing being looked at.
 */
export function bbThrottle(spec: RobotSpec, target: number): number {
  const max = driveParams(spec).maxSpeed;
  return max > 0 ? Math.min(1, target / max) : 1;
}
