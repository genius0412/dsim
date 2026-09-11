import type { Artifact, RobotCommand, RobotSpec, World } from '../../src/types';
import * as C from '../../src/config';
import { worldHash } from '../../src/net/checksum';
import { slimWorld, unslimWorld } from '../../src/net/protocol';
import { moduleFor } from '../../src/games';
import { simModuleFor } from '../../src/games/sim';
import { createChainWorld } from '../../src/games/chain/spawn';
import { chainStep } from '../../src/games/chain/step';
import { DEFAULT_ASSISTS, DEFAULT_SPEC } from '../../src/sim/spawn';
import { BB_HALF_X, BB_HALF_Y, BB_POLLEN_R, BB_POLLEN_SIM } from '../../src/games/biobuzz/config';
import { BB_WALL_COUNT, biobuzzColliders } from '../../src/games/biobuzz/colliders';
import { createBiobuzzWorld } from '../../src/games/biobuzz/spawn';
import { biobuzzStep } from '../../src/games/biobuzz/step';
import { updateBiobuzz } from '../../src/games/biobuzz/play';
import { bbFootprint } from '../../src/games/biobuzz/robot';
import { BB_IDLE, BB_SCENES, bbSceneAt, bbSceneStills, type Scene } from '../../src/games/biobuzz/scenes';
import { maxMatchTicks } from '../../src/sim/replay';
import type { ServerMsg } from '../../src/net/protocol';
import { Room, type Client } from '../../server/room';
import { BB_DEFAULT_SPEC } from '../../src/games/biobuzz/robotConfig';
import { cmd, mkWorld, run, setup, type Check } from './harness';

/**
 * LANE A's smoke: THE FIELD.
 *
 * Registry integrity, the perimeter, containment, POLLEN conservation, determinism, the wire
 * round-trip, a headless server match, and the performance budget. Everything whose subject is
 * the field or the world rather than a mechanism.
 *
 * Every check here is one that would still be TRUE AND MEANINGFUL at Kickoff. Nothing asserts a
 * score, a zone or an element count, because Sections 8-11 of the V0 manual are placeholders
 * and a check written against a guess is worse than no check: it passes, so nobody looks, and
 * then it fails on Kickoff day for a reason that has nothing to do with a regression.
 */

/** The containment slop. `solveRobots` guarantees a robot that STARTED a tick inside cannot be
 * pushed out; it does not guarantee zero penetration at rest, because a soft contact resolves
 * over a few ticks. Half an inch is a resting contact; anything more is a robot leaving the
 * field, which is the bug this is looking for. */
const WALL_EPS = 0.5;

/**
 * THE STEP-COST BUDGET, as a multiple of a 2v2 Chain Reaction step. RE-READ when the pollen
 * solver changed, and the number moved for a reason worth recording.
 *
 * The plan wrote 1.2x, against a BIOBUZZ that ran CR's own bespoke ground integrator plus a
 * spatial-hash separation pass. POLLEN now ride the SHARED artifact solve, which builds a fresh
 * Rapier world every tick with one body per ground pollen plus every robot's artifact solids -
 * real physics where there used to be arithmetic. Measured best-of-three on this machine, the
 * ratio is 1.25-1.63x (median ~1.34) where it used to sit under 1.2, and the absolute cost is
 * ~0.47 ms for a 2v2, i.e. under 3% of a 16.7 ms frame.
 *
 * 1.8 is that measurement plus room for a loaded CI box, and it is still a real budget: a
 * BIOBUZZ step that had genuinely doubled would fail. The ROOM check below deliberately keeps
 * 1.2, because a room tick also pays for the snapshot and CR's 300 particles make that side
 * much fatter - it measures 0.75x with plenty of margin.
 */
const STEP_BUDGET = 1.8;

/** the same budget for a whole SERVER room tick (`roomChecks`). See that check for why it
 * kept 1.2x where the step budget had to move. */
const ROOM_BUDGET = 1.2;

/** the robot's axis-aligned half-extents at its current heading — the same measure the
 * solver's containment invariant is stated in (footprint INCLUDING intake reach, not the bare
 * chassis), so this check cannot pass a robot whose sweeper is through the wall. */
function aabb(r: { pos: { x: number; y: number }; heading: number; spec: RobotSpec }): {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
} {
  const e = bbFootprint(r.spec);
  const c = Math.cos(r.heading);
  const s = Math.sin(r.heading);
  const hx = (e.front + e.rear) / 2;
  const cx = r.pos.x + ((e.front - e.rear) / 2) * c;
  const cy = r.pos.y + ((e.front - e.rear) / 2) * s;
  const ax = Math.abs(hx * c) + Math.abs(e.half * s);
  const ay = Math.abs(hx * s) + Math.abs(e.half * c);
  return { x0: cx - ax, x1: cx + ax, y0: cy - ay, y1: cy + ay };
}

/**
 * How far a POLLEN's SKIN is past the nearest wall plane; 0 when it is inside.
 *
 * The measure rather than a boolean, because "it left the field" and "it left the field by two
 * inches" are different reports and the second is the one worth printing.
 */
const outBy = (b: Artifact): number =>
  Math.max(Math.abs(b.pos.x) - (BB_HALF_X - BB_POLLEN_R), Math.abs(b.pos.y) - (BB_HALF_Y - BB_POLLEN_R), 0);

/** the containment tolerance. Any soft solver leaves a hair of penetration in a resting
 * contact; a quarter inch on a 1.5" pollen is that, and anything more is a pollen leaving the
 * field, which is the bug these checks are looking for. */
const WALL_SLOP = 0.25;

/** how far two RESTING pollen may sit inside one another. A tenth of an inch on a 3" diameter
 * is the solver's resting slop, and the threshold is meaningful rather than generous: the same
 * measure reads 2.13" on a row being pressed into a wall (see the settle block). */
const OVERLAP_SLOP = 0.1;

/** a copy of `scene` whose stills are EVERY tick up to its last, so `bbSceneStills` - the ONE
 * stepping path - hands back the whole run in a single forward pass. Stepping a scene by hand
 * here would make these checks a check of a different run from the one the gallery draws. */
const everyTick = (scene: Scene): Scene => ({
  ...scene,
  stills: Array.from({ length: Math.max(...scene.stills) + 1 }, (_, i) => i),
});

export function fieldChecks(check: Check): void {
  // ── REGISTRY INTEGRITY ────────────────────────────────────────────────────
  // The module has to BE in the registry and be the right one. `moduleFor` falls back to
  // DECODE for an unknown id, which is the correct back-compat rule and also the reason this
  // check exists: an unregistered BIOBUZZ silently plays DECODE, and every other check in this
  // file would pass while testing the wrong game.
  {
    const mod = moduleFor('biobuzz');
    check('registry: moduleFor("biobuzz") resolves to the BIOBUZZ module', mod.id === 'biobuzz', `id=${mod.id}`);
    check('registry: BIOBUZZ declares scored:false (never persists ELO/records)', mod.scored === false);
    check('registry: BIOBUZZ declares startLegality:false (no published G304 analogue)', mod.startLegality === false);
    check(
      'registry: bounds are the 144x144 field',
      mod.bounds.halfX === BB_HALF_X && mod.bounds.halfY === BB_HALF_Y,
      `${mod.bounds.halfX}x${mod.bounds.halfY}`,
    );
    check('registry: every UI renderer slot is filled', typeof mod.drawField === 'function' && typeof mod.drawBalls === 'function' && typeof mod.drawRobot === 'function');
  }

  // ── THE PERIMETER ─────────────────────────────────────────────────────────
  {
    check('field: exactly four perimeter walls', BB_WALL_COUNT === 4, `count=${BB_WALL_COUNT}`);
    check('field: no dynamic colliders (BIOBUZZ has no known moving geometry)', biobuzzColliders.dynamic === undefined);
    // Every wall's INNER FACE must sit exactly on the bound it is the wall for. A wall placed
    // a hair inside shrinks the field silently; a hair outside leaves a gap a pollen rests in.
    const faces = biobuzzColliders.statics.map((w) =>
      w.hx < w.hy ? Math.abs(w.tx) - w.hx : Math.abs(w.ty) - w.hy,
    );
    check(
      'field: every wall inner face sits exactly on the field bound',
      faces.every((f, i) => Math.abs(f - (i < 2 ? BB_HALF_X : BB_HALF_Y)) < 1e-9),
      faces.join(', '),
    );
  }

  // ── WALL CONTAINMENT: drive at each wall for 3 s ──────────────────────────
  // Three seconds is well past however long the drivetrain needs to reach top speed and pin,
  // so this is a check on the SOLVER's containment invariant rather than on acceleration.
  // Each heading is run in its own world: a robot that has already been slammed into one wall
  // is not a clean starting state for the next.
  for (const [name, headingDeg, at] of [
    ['+x', 0, { x: 40, y: 0 }],
    ['-x', 180, { x: -40, y: 0 }],
    ['+y', 90, { x: 0, y: 40 }],
    ['-y', 270, { x: 0, y: -40 }],
  ] as const) {
    const w = mkWorld('free', 7);
    const r = w.robots[0];
    r.pos = { ...at };
    r.heading = (headingDeg * Math.PI) / 180;
    r.vel = { x: 0, y: 0 };
    run(w, cmd({ driveY: 1 }), 3);
    const b = aabb(r);
    const ok =
      b.x0 >= -BB_HALF_X - WALL_EPS &&
      b.x1 <= BB_HALF_X + WALL_EPS &&
      b.y0 >= -BB_HALF_Y - WALL_EPS &&
      b.y1 <= BB_HALF_Y + WALL_EPS;
    check(
      `containment: driving at the ${name} wall for 3 s keeps the footprint inside bounds`,
      ok,
      `x ${b.x0.toFixed(2)}..${b.x1.toFixed(2)} · y ${b.y0.toFixed(2)}..${b.y1.toFixed(2)}`,
    );
  }

  // ── THE START ANCHORS ARE INSIDE THE FIELD ────────────────────────────────
  /**
   * A robot spawned at any anchor, in either alliance, must be fully inside `bounds` BEFORE
   * anything steps.
   *
   * The anchors are hand-placed APPROX numbers (there is no published BIOBUZZ start geometry —
   * `startLegality: false`), and an anchor an inch too far out spawns a robot intersecting the
   * wall, which Rapier then resolves by shoving it — so the match begins with four robots
   * sliding. This is the cheapest possible guard on a number a human typed, and it is checked
   * on the FOOTPRINT, so an anchor that fits a bare chassis but not its sweeper fails here.
   */
  {
    const w = createBiobuzzWorld('match', 4, [
      setup(0, 'blue', {}, 0),
      setup(1, 'blue', {}, 1),
      setup(2, 'red', {}, 0),
      setup(3, 'red', {}, 1),
    ]);
    check('anchors: BIOBUZZ spawns four robots', w.robots.length === 4);
    for (const r of w.robots) {
      const b = aabb(r);
      const slack = Math.min(BB_HALF_X - Math.max(Math.abs(b.x0), Math.abs(b.x1)), BB_HALF_Y - Math.max(Math.abs(b.y0), Math.abs(b.y1)));
      check(
        `anchors: robot ${r.id} (${r.alliance}) starts fully inside bounds`,
        slack >= 0,
        `slack=${slack.toFixed(2)}"`,
      );
    }
    // The two anchors per alliance exist so an alliance's robots cannot spawn on top of each
    // other; a mirrored pair that collapsed to one point would pass every other check here.
    const blue = w.robots.filter((r) => r.alliance === 'blue');
    check(
      'anchors: the two anchors of an alliance are distinct',
      Math.hypot(blue[0].pos.x - blue[1].pos.x, blue[0].pos.y - blue[1].pos.y) > 18,
      `apart=${Math.hypot(blue[0].pos.x - blue[1].pos.x, blue[0].pos.y - blue[1].pos.y).toFixed(1)}"`,
    );
    // RED IS THE X-MIRROR OF BLUE, applied once in `spawn.ts`. Asserted because a second
    // mirror anywhere else would cancel this one and put both alliances on the same side.
    const red = w.robots.filter((r) => r.alliance === 'red');
    check(
      'anchors: RED is the x-mirror of BLUE',
      Math.abs(blue[0].pos.x + red[0].pos.x) < 1e-9 && Math.abs(blue[0].pos.y - red[0].pos.y) < 1e-9,
      `blue=${blue[0].pos.x},${blue[0].pos.y} red=${red[0].pos.x},${red[0].pos.y}`,
    );
  }

  // -- POLLEN CONSERVATION ---------------------------------------------------
  /**
   * A POLLEN MUST NEVER VANISH - the invariant every other pollen check is judged under.
   * Deletion is the failure mode a penetration test eventually reaches on its own, and it is
   * invisible in a screenshot.
   *
   * The loop drives `updateBiobuzz` DIRECTLY and sweeps the robot KINEMATICALLY rather than
   * through the drivetrain, so the sweep speed is a number this check sets rather than a
   * consequence of the gearing. The sweep ORIGIN is captured before the pose is written,
   * exactly as `step.ts` stage 0 does it - without it the solve gets no `from`, falls back to
   * the end pose, and the chassis is spawned already overlapping whatever it drove into (the
   * "balls go on top of the robot" failure).
   *
   * It used to run TWICE, once per `BB_BALL_SOLVER` arm. There is one solver now (the shared
   * `solveArtifacts` at `BB_POLLEN_R`) and `updateBiobuzz` has no solver argument to pass.
   */
  {
    const w = createBiobuzzWorld('free', 11, []);
    const rob = createBiobuzzWorld('free', 11, [setup(0, 'blue')]).robots[0];
    w.robots.push(rob);
    rob.heading = 0;
    rob.pos = { x: -BB_HALF_X + 12, y: 0 };
    const n0 = w.balls.length;
    const cmds = new Map<number, RobotCommand>([[rob.id, cmd({ driveY: 1, intake: false })]]);
    let everOut = 0;
    for (let i = 0; i < 600; i++) {
      const from = new Map([[rob.id, { x: rob.pos.x, y: rob.pos.y, heading: rob.heading }]]);
      rob.pos = { x: rob.pos.x + 40 * C.SIM_DT, y: 0 }; // 40 in/s straight across the field
      rob.vel = { x: 40, y: 0 };
      w.tick++;
      w.time += C.SIM_DT;
      updateBiobuzz(w, C.SIM_DT, cmds, true, from);
      // EVERY tick, not just the last one: a pollen can be pushed through a wall and pulled
      // back by the containment clamp within one tick, and a check that only looked at the end
      // of the run would never see it.
      for (const b of w.balls) if (b.state.kind === 'ground') everOut = Math.max(everOut, outBy(b));
    }
    check(
      'pollen: count conserved over 600 ticks of a robot sweeping the field',
      w.balls.length === n0 && n0 === BB_POLLEN_SIM,
      `${n0} -> ${w.balls.length}`,
    );
    check(
      'pollen: never left the field on ANY of those 600 ticks',
      everOut <= WALL_SLOP,
      `worst ${everOut.toFixed(3)}" past the wall plane`,
    );
  }

  // -- THE PERIMETER IS AN INVARIANT ON EVERY TICK OF EVERY PHYSICS SCENE ----
  /**
   * `solveArtifacts` holds the perimeter to within its own resting slop and `play.ts` holds the
   * rest (`clampPollenToWalls`). THAT CLAMP IS WHAT THIS CHECK IS FOR, and it is not
   * theoretical: measured with it removed, `wall-row-sweep` put a POLLEN **2.02" past the wall
   * plane** at tick 105 and `pile-fast` 1.52", because BIOBUZZ does not run DECODE's pin/round
   * loop and so nothing stops a chassis driving through the space a wall pollen occupies.
   * Delete the clamp and this check goes red on two scenes.
   *
   * EVERY TICK, NOT THE LAST ONE. A pollen shoved through a wall and pulled back within one
   * tick is invisible at the end of a run, and the worst frame in `wall-row-sweep` is tick 105
   * of 300. Each scene is stepped ONCE and every intermediate world is read, through
   * `bbSceneStills` - the same single stepping path the gallery and the hash checks use, so
   * this cannot be checking a run the pictures never showed.
   */
  for (const id of ['pile-slow', 'pile-med', 'pile-fast', 'wall-row-sweep', 'corner-pile', 'squeeze-2robots', 'settle-60']) {
    const scene = BB_SCENES.find((sc) => sc.id === id);
    if (!scene) {
      check(`containment [${id}]: the scene is registered`, false, 'no such scene id');
      continue;
    }
    let worst = 0;
    let worstAt = -1;
    let n = -1;
    let conserved = true;
    for (const { tick, world } of bbSceneStills(everyTick(scene))) {
      if (n < 0) n = world.balls.length;
      else if (world.balls.length !== n) conserved = false;
      for (const b of world.balls) {
        if (b.state.kind !== 'ground') continue;
        const out = outBy(b);
        if (out > worst) {
          worst = out;
          worstAt = tick;
        }
      }
    }
    check(
      `containment [${id}]: every pollen inside bounds on all ${Math.max(...scene.stills) + 1} ticks`,
      worst <= WALL_SLOP,
      worst > 0 ? `worst ${worst.toFixed(3)}" out at tick ${worstAt}` : 'never outside',
    );
    check(`containment [${id}]: pollen count conserved across the whole run`, conserved, `n=${n}`);
  }

  // -- A SETTLED PILE DOES NOT REST INSIDE ITSELF ----------------------------
  /**
   * Two POLLEN at rest may not occupy the same space. A pile allowed to do it looks like fewer
   * balls than there are and explodes when something next touches it.
   *
   * Asserted on SETTLED states only, and that distinction is the whole check. While a chassis
   * is pressing a row into a wall the solve genuinely has no answer - it is being asked to fit
   * 14 pollen into less space than 14 pollen occupy - and measured, `wall-row-sweep` holds
   * 2.13" of overlap on a 3.00" diameter for as long as the robot sits there. That is written
   * up for the owner (`docs/biobuzz/feedback/000-solver-observations.md`), not asserted away
   * here. What IS asserted is that once the pushing stops and the pile comes to rest it is a
   * pile of SEPARATE balls: the untouched scatter and a pile plowed at 20 in/s then left alone
   * both reach zero overlap and zero speed.
   *
   * The AT REST half is not decoration either - it is the check that fails if the shared
   * rolling-friction pass (`stepGroundBall`) is ever dropped from `play.ts`. Without it there
   * is no floor friction anywhere in the pipeline (the solve runs in a plane with no gravity),
   * and `pile-slow`'s pile was measured still travelling at 18.98 in/s five seconds after the
   * robot stopped.
   */
  for (const [id, idle] of [['settle-60', 0], ['pile-slow', 240]] as const) {
    const scene = BB_SCENES.find((sc) => sc.id === id)!;
    const w = bbSceneAt(scene, Math.max(...scene.stills));
    const idleCmds = new Map(w.robots.map((r) => [r.id, BB_IDLE]));
    for (let t = 0; t < idle; t++) biobuzzStep(w, C.SIM_DT, idleCmds);
    const g = w.balls.filter((b) => b.state.kind === 'ground');
    let overlap = 0;
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        overlap = Math.max(overlap, 2 * BB_POLLEN_R - Math.hypot(g[i].pos.x - g[j].pos.x, g[i].pos.y - g[j].pos.y));
      }
    }
    let fastest = 0;
    for (const b of g) fastest = Math.max(fastest, Math.hypot(b.vel.x, b.vel.y));
    check(
      `settle [${id}+${idle}]: no two resting pollen overlap by more than ${OVERLAP_SLOP}"`,
      g.length > 1 && overlap <= OVERLAP_SLOP,
      `${g.length} ground, worst overlap ${overlap.toFixed(3)}" of ${(2 * BB_POLLEN_R).toFixed(2)}"`,
    );
    check(
      `settle [${id}+${idle}]: the pile is actually AT REST (the shared rolling pass ran)`,
      fastest < C.BALL_REST_SPEED,
      `fastest ${fastest.toFixed(3)} in/s`,
    );
  }

  // -- A ROBOT AT FULL THROTTLE DOES NOT PUT A POLLEN THROUGH THE WALL ------
  /**
   * `pin-wall` is one POLLEN against the wall with a robot driving into it at full throttle for
   * five seconds - the narrowest case in the set, and the one where a position authority that
   * cannot resolve the squeeze either eats the pollen or posts it through the perimeter.
   *
   * Checked on all 300 ticks, on both outcomes that would be wrong: gone, or through the wall.
   * The pollen is ALLOWED to squirt sideways and allowed to stay put, and this deliberately
   * does NOT assert that the robot stalls on it - DECODE's stall comes from the pin half of the
   * round loop, which BIOBUZZ does not run (see the owner notes).
   */
  {
    const scene = BB_SCENES.find((sc) => sc.id === 'pin-wall')!;
    let worst = 0;
    let worstAt = -1;
    let gone = false;
    for (const { tick, world } of bbSceneStills(everyTick(scene))) {
      const g = world.balls.filter((b) => b.state.kind === 'ground');
      if (g.length !== 1) gone = true;
      for (const b of g) {
        const out = outBy(b);
        if (out > worst) {
          worst = out;
          worstAt = tick;
        }
      }
    }
    check('pin-wall: the pollen is never deleted, on any tick', !gone);
    check(
      'pin-wall: a robot at full throttle never drives the pollen through the wall',
      worst <= WALL_SLOP,
      worst > 0 ? `worst ${worst.toFixed(3)}" out at tick ${worstAt}` : 'never outside',
    );
  }

  // ── DETERMINISM ───────────────────────────────────────────────────────────
  // Same seed, same setups, same commands ⇒ the same world, bit for bit as `worldHash` reads
  // it. This is THE check the multiplayer lockstep and every replay depend on, and a scatter
  // built off `world.rngState` is exactly the kind of thing that breaks it silently.
  {
    const setups = [setup(0, 'blue'), setup(1, 'red', {}, 1)];
    const a = createBiobuzzWorld('match', 12345, setups);
    const b = createBiobuzzWorld('match', 12345, setups);
    check('determinism: same seed ⇒ identical worldHash at spawn', worldHash(a) === worldHash(b), `${worldHash(a)} vs ${worldHash(b)}`);
    const c = cmd({ driveY: 1, intake: true });
    const cmds = new Map([[0, c], [1, c]]);
    for (let i = 0; i < 600; i++) {
      biobuzzStep(a, C.SIM_DT, cmds);
      biobuzzStep(b, C.SIM_DT, cmds);
    }
    check('determinism: same seed ⇒ identical worldHash after 600 ticks', worldHash(a) === worldHash(b), `${worldHash(a)} vs ${worldHash(b)}`);
    const d = createBiobuzzWorld('match', 999, setups);
    check('determinism: a DIFFERENT seed gives a different world (the scatter is really seeded)', worldHash(d) !== worldHash(a));
  }

  // ── THE WIRE ROUND-TRIP ───────────────────────────────────────────────────
  /**
   * `slimWorld` strips the balls (they ride their own delta channel) and every robot's static
   * spec, then `unslimWorld` puts both back. What must survive that is `game` and the whole
   * `biobuzz` state bag — if either is dropped, a joining client resolves the module to DECODE
   * and renders a BIOBUZZ world with DECODE's field, which is the exact failure the `game`
   * field was added for.
   */
  {
    const w = createBiobuzzWorld('match', 77, [setup(0, 'blue')]);
    w.biobuzz!.scored.blue = 3;
    w.biobuzz!.held[0] = 2;
    const slim = slimWorld(w);
    const back = unslimWorld(slim, w.balls, () => w.robots[0].spec);
    check('wire: slim/unslim preserves world.game', back.game === 'biobuzz', `game=${back.game}`);
    check('wire: slim/unslim preserves the whole world.biobuzz bag', JSON.stringify(back.biobuzz) === JSON.stringify(w.biobuzz));
    check('wire: slim/unslim preserves the pollen count', back.balls.length === w.balls.length);
    check('wire: the round-tripped world hashes the same', worldHash(back) === worldHash(w));
  }

  // ── EVERY FIELD SCENE HASHES DETERMINISTICALLY ────────────────────────────
  /**
   * A scene is a determinism check for free: step it to its last still twice and the two
   * worlds must hash the same. The value is that it covers the FULL pipeline over hundreds of
   * ticks with pollen piled in corners and robots pinned against walls — situations nobody
   * would hand-write an assertion for, and exactly where a non-deterministic tie-break
   * (iteration order in the separator, a `Math.random`, a `Date.now`) actually hides.
   */
  for (const scene of BB_SCENES.filter((s) => s.lane === 'field')) {
    const last = Math.max(...scene.stills);
    const h1 = worldHash(bbSceneAt(scene, last));
    const h2 = worldHash(bbSceneAt(scene, last));
    check(`scene [${scene.id}@${last}]: hashes deterministically`, h1 === h2, `${h1} vs ${h2}`);
  }

  // -- PERFORMANCE BUDGET ---------------------------------------------------
  /**
   * A 2v2 BIOBUZZ world must not cost more than `STEP_BUDGET` x a 2v2 Chain Reaction world per
   * step, MEASURED IN THE SAME RUN.
   *
   * Same run matters more than the threshold does: an absolute millisecond budget is a
   * statement about the machine that happened to run CI, and it either fails on a loaded laptop
   * or passes on anything. A RATIO against a game already known to hold 60 Hz on the hardware
   * people actually play on is a statement about this game.
   *
   * Both sides get a warm-up before the timed windows so the comparison is not "interpreted
   * BIOBUZZ vs JIT-compiled CR", which is a ~3x artefact and was the first version of this
   * check. Each side then takes the BEST of three windows rather than one long one: with a
   * single 1200-step window the same code measured anywhere between 1.12x and 2.30x on this
   * machine, which is a check that flakes rather than a budget. The minimum is the estimate
   * least contaminated by whatever else the machine was doing, and best-of-three brought the
   * spread to 1.25-1.63x.
   */
  {
    const bbSetups = [setup(0, 'blue'), setup(1, 'blue', {}, 1), setup(2, 'red'), setup(3, 'red', {}, 1)];
    const crSetup = (id: number, alliance: 'red' | 'blue', startIndex: number) => ({
      id,
      alliance,
      spec: { ...DEFAULT_SPEC },
      assists: { ...DEFAULT_ASSISTS },
      startIndex,
    });
    const crSetups = [crSetup(0, 'blue', 0), crSetup(1, 'blue', 1), crSetup(2, 'red', 0), crSetup(3, 'red', 1)];
    const drive = cmd({ driveY: 1, rotate: 0.3, intake: true, fire: true });
    const cmds = new Map([0, 1, 2, 3].map((id) => [id, drive] as const));

    const time = (build: () => World, step: (w: World, dt: number, c: Map<number, RobotCommand>) => void): number => {
      const warm = build();
      for (let i = 0; i < 300; i++) step(warm, C.SIM_DT, cmds as Map<number, RobotCommand>);
      let best = Infinity;
      for (let k = 0; k < 3; k++) {
        const w = build();
        const t0 = performance.now();
        const n = 600;
        for (let i = 0; i < n; i++) step(w, C.SIM_DT, cmds as Map<number, RobotCommand>);
        best = Math.min(best, (performance.now() - t0) / n);
      }
      return best;
    };
    const cr = time(() => createChainWorld('match', 5, crSetups), chainStep);
    const bb = time(() => createBiobuzzWorld('match', 5, bbSetups), biobuzzStep);
    check(
      `perf: a 2v2 BIOBUZZ step costs <= ${STEP_BUDGET}x a 2v2 Chain Reaction step`,
      bb <= cr * STEP_BUDGET,
      `bb=${bb.toFixed(3)}ms cr=${cr.toFixed(3)}ms ratio=${(bb / cr).toFixed(2)}`,
    );
  }
}

/**
 * THE SERVER SIDE: real `Room`s configured for BIOBUZZ run whole headless matches.
 *
 * Split out of `fieldChecks` because it imports `server/**`, and a lane file that pulls the
 * server in is a lane file that cannot run in a browser context.
 *
 * WHAT IT PROVES, and it is more than it looks: the authoritative server can host this game
 * at all. `Room` resolves the game through the DOM-FREE registry (`games/sim.ts`), steps it
 * with that module's `step`, slims it over the wire, and finalizes it — so anything in the
 * BIOBUZZ pipeline that only breaks WITHOUT a DOM (a stray `document`, a `window`, a
 * renderer import leaking into `sim.ts`) fails HERE and nowhere else. It is also the only
 * check that runs the whole two-minute match clock, phases and all, to `post`.
 *
 * `advanceForTest` pumps ticks synchronously with the real-time timer dropped, which is what
 * makes a two-minute match take a fraction of a second.
 */
export function roomChecks(check: Check): void {
  /** four drivers, 2v2, the roster a versus room is built for. */
  const roster = (): { id: string; alliance: 'blue' | 'red'; startIndex: number }[] => [
    { id: 'bb-b1', alliance: 'blue', startIndex: 0 },
    { id: 'bb-b2', alliance: 'blue', startIndex: 1 },
    { id: 'bb-r1', alliance: 'red', startIndex: 0 },
    { id: 'bb-r2', alliance: 'red', startIndex: 1 },
  ];

  const mkClient = (
    seat: { id: string; alliance: 'blue' | 'red'; startIndex: number },
    spec: RobotSpec,
    sink: ServerMsg[],
  ): Client => ({
    id: seat.id,
    send: (m: ServerMsg) => sink.push(m),
    player: {
      clientId: seat.id,
      name: seat.id,
      teamName: 'Smoke',
      teamNumber: 1,
      alliance: seat.alliance,
      startIndex: seat.startIndex,
      ready: true,
      spec: { ...spec },
      assists: { ...DEFAULT_ASSISTS },
    },
    connected: true,
    disconnectAt: 0,
  });

  /** a started room for `game` (2v2 unless `seats` says otherwise), plus the message log of
   *  its first seat. */
  const started = (
    code: string,
    game: 'biobuzz' | 'chain',
    spec: RobotSpec,
    onOutcome?: (game: string | undefined) => void,
    seats = roster(),
  ): { room: Room; msgs: ServerMsg[] } => {
    const msgs: ServerMsg[] = [];
    const room = new Room(code, () => {}, { kind: 'versus', game }, (o) => onOutcome?.(o.game));
    for (const seat of seats) room.add(mkClient(seat, spec, seat.id === 'bb-b1' ? msgs : []));
    room.onMessage('bb-b1', { t: 'start' });
    return { room, msgs };
  };

  // ── A FULL HEADLESS BIOBUZZ MATCH ─────────────────────────────────────────
  let outcomeGame: string | undefined = '<onResult never called>';
  let threw: unknown = null;
  let room: Room | null = null;
  let msgs: ServerMsg[] = [];
  try {
    const r = started('smoke-bb', 'biobuzz', BB_DEFAULT_SPEC, (g) => {
      outcomeGame = g;
    });
    room = r.room;
    msgs = r.msgs;
    // +5 past the cap: the last ticks are what finalize the match, and stopping exactly at
    // the cap would test everything except the transition this check is named for.
    room.advanceForTest(maxMatchTicks() + 5);
  } catch (e) {
    threw = e;
  }
  check(
    'room: a 2v2 BIOBUZZ room starts and runs a full match without throwing',
    threw === null,
    threw ? String(threw) : '',
  );
  if (threw !== null || !room) return;

  const start = msgs.find((m) => m.t === 'matchStart') as Extract<ServerMsg, { t: 'matchStart' }> | undefined;
  check('room: matchStart advertises game:"biobuzz"', start?.game === 'biobuzz', `game=${start?.game}`);
  check('room: matchStart carries all four setups', start?.setups.length === 4, `n=${start?.setups.length}`);

  // The wire snapshot has to say WHICH GAME it is, because that is the client's fallback when
  // it joined without a `matchStart` (a reconnect, a spectator) — a snapshot that forgets
  // `game` renders BIOBUZZ with the DECODE module and looks almost right.
  const snaps = msgs.filter((m) => m.t === 'snapshot') as Extract<ServerMsg, { t: 'snapshot' }>[];
  check('room: the room broadcasts snapshots', snaps.length > 0, `n=${snaps.length}`);
  check(
    'room: every snapshot is tagged game:"biobuzz"',
    snaps.length > 0 && snaps.every((m) => m.w.game === 'biobuzz'),
    `games=${[...new Set(snaps.map((m) => m.w.game))].join(',')}`,
  );

  // REACHING `post` IS THE POINT. `matchResult` is broadcast from the finalizer, so its
  // presence is the proof the match ran the clock out and ended instead of stalling.
  const res = msgs.find((m) => m.t === 'matchResult') as Extract<ServerMsg, { t: 'matchResult' }> | undefined;
  check('room: the BIOBUZZ match reaches post and broadcasts matchResult', !!res);
  check(
    'room: the finished BIOBUZZ match scored nothing (an unscored shell must stay 0-0)',
    res?.result.score.blue === 0 && res?.result.score.red === 0,
    `blue=${res?.result.score.blue} red=${res?.result.score.red}`,
  );
  // The outcome still has to be GAME-TAGGED even though nothing is written: it is what
  // `persistMatch` reads to decide to skip, and an absent `game` defaults to DECODE — which
  // would file a BIOBUZZ run onto the DECODE boards.
  check('room: the MatchOutcome carries game:"biobuzz"', outcomeGame === 'biobuzz', `game=${outcomeGame}`);
  check(
    'room: the SERVER-SAFE registry declares BIOBUZZ unscored, so persistMatch skips it',
    simModuleFor('biobuzz').scored === false,
  );

  // -- THE START-POSE DE-CONFLICT LOOP READS THIS GAME'S ANCHOR COUNT ------------
  /**
   * FOUR ROBOTS ON ONE ALLIANCE, every one of them asking for anchor 0.
   *
   * `Room` de-conflicts start poses per alliance by walking the index forward until it finds
   * an unused one, stopping after a full cycle so an over-full alliance reuses a pose rather
   * than spinning the tick loop forever. That walk used DECODE's five anchors for every game,
   * so a BIOBUZZ alliance of four was handed 0, 1, 2 and 3 against TWO anchors: indices 2 and
   * 3 do not exist in this game and resolve to whatever its spawn does with a miss. It now
   * reads `simModuleFor(this.game).startPoseCount`.
   *
   * Four on ONE alliance and all at index 0 is what makes the check bite: a 2v2 at 0/1/0/1
   * never walks the index at all, which is why the full-match check above passed throughout.
   * With the bug: 0, 1, 2, 3. Without it: 0, 1, 0, 0 (the cycle gives up and reuses).
   */
  {
    const seats = (['bb-b1', 'bb-b2', 'bb-b3', 'bb-b4'] as const).map((id) => ({
      id,
      alliance: 'blue' as const,
      startIndex: 0,
    }));
    const n = simModuleFor('biobuzz').startPoseCount;
    const { msgs: m4 } = started('smoke-bb-anchors', 'biobuzz', BB_DEFAULT_SPEC, undefined, [...seats]);
    const st = m4.find((x) => x.t === 'matchStart') as Extract<ServerMsg, { t: 'matchStart' }> | undefined;
    const idx = (st?.setups ?? []).map((x) => x.startIndex ?? 0);
    check(
      `room: a 4-robot BIOBUZZ alliance is only ever assigned anchors 0..${n - 1}`,
      idx.length === 4 && idx.every((v) => Number.isInteger(v) && v >= 0 && v < n),
      `startPoseCount=${n} assigned=[${idx.join(', ')}]`,
    );
  }


  // -- PERFORMANCE, ROOM AGAINST ROOM, IN THE SAME RUN ----------------------
  /**
   * The `ROOM_BUDGET` ratio, measured through the SERVER's whole per-tick path: input draining,
   * the step, `slimWorld`, the ball delta and the broadcast to four sockets. That is the cost
   * that actually decides whether a machine can host a room, and it is not the same shape as
   * the step cost - a game whose step is cheap but whose snapshot is fat fails here and passes
   * there.
   *
   * RE-READ after the pollen solver changed, like the step check, and it kept 1.2x where the
   * step check had to move: a room tick pays for a snapshot too, and CR's 300 particles make
   * that side much fatter than BIOBUZZ's 60 pollen, so the shared solve's extra cost
   * disappears into it. Measured 0.75x and 0.99x on two runs - which is exactly why it now
   * takes the BEST of three windows per side, like the step check: a single window put the
   * same code within noise of the threshold.
   *
   * Both rooms are built and warmed inside this block so the comparison is same-run,
   * same-process, same-JIT state, for the reason spelled out on the world-step check.
   */
  {
    const WARM = 300;
    const N = 600;
    const timeRoom = (code: string, game: 'biobuzz' | 'chain', spec: RobotSpec): number => {
      started(`${code}-warm`, game, spec).room.advanceForTest(WARM);
      let best = Infinity;
      for (let k = 0; k < 3; k++) {
        const timed = started(`${code}-${k}`, game, spec).room;
        const t0 = performance.now();
        timed.advanceForTest(N);
        best = Math.min(best, (performance.now() - t0) / N);
      }
      return best;
    };
    const cr = timeRoom('smoke-perf-cr', 'chain', DEFAULT_SPEC);
    const bb = timeRoom('smoke-perf-bb', 'biobuzz', BB_DEFAULT_SPEC);
    check(
      `perf: a 2v2 BIOBUZZ ROOM tick costs <= ${ROOM_BUDGET}x a 2v2 Chain Reaction room tick`,
      bb <= cr * ROOM_BUDGET,
      `bb=${bb.toFixed(3)}ms cr=${cr.toFixed(3)}ms ratio=${(bb / cr).toFixed(2)}`,
    );
  }
}
