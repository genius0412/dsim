import type { Alliance, Artifact, RobotCommand, RobotState, World } from '../../../types';
import { BB_HOOD_DEFAULT_DEG, BB_RAMP_DEPLOY_S, BB_RAMP_EMBED_DEPTH, bbHeightNow } from '../config';
import { capturePollen } from '../elements';
import {
  bbAimTarget,
  bbCellSideOf,
  bbDumpShotEnters,
  bbHumanPlayerTick,
  bbPassTargetOf,
  bbPretendHive,
  bbTurretShotEnters,
} from '../play';
import {
  bbIntakeAct,
  bbIntakeExtraReach,
  bbLaunch,
  bbRampReverse,
  bbRampSettled,
  bbRampStep,
  bbRampSwingProgress,
  bbSlewTurret,
  bbTurretOnTarget,
  bbTurretSolution,
  type BbShot,
} from '../robot';
import { bbIsTurreted, bbLauncherOf } from '../mechs';
import { type BiobuzzState } from '../state';
import { flowerPlace3d, flowerRetrieve3d } from './flower3d';
import { engineFor, type Engine3d } from './engineImpl';
import { rapier3d } from './engine';
import { rampSwingBlocked } from './bodies';
import { GROUP_RAMP } from './groups';
import { bbKindIndex } from '../score';

/**
 * BIOBUZZ 3D PHYSICS -- capture / aim+launch / place / human player (Day 1, docs/biobuzz/
 * plan-3d.md section 3.8). Everything here is called from step3d.ts's gameplay stage, AFTER
 * derive.ts has run, and everything here writes only PLAIN JSON on world.balls/world.biobuzz --
 * the next tick's engine.ts sync is what turns a JSON change into a body create/remove/
 * teleport. Nothing in this file touches Rapier directly except elements3dCapture reading an
 * element's CURRENT bottom height off its own JSON z (already the 2D convention; see
 * bodies.ts's header) -- there is no physics call here that 2D's own functions do not already
 * make for us via capturePollen/releasePollen.
 *
 * WHAT DID NOT CARRY OVER FROM 2D, AND WHY.
 * The 2D hive CAPTURE test (hiveAccepts: "does a flight element crossing the opening belong to
 * this alliance, right now, descending, over the correct face") has no analogue here: a shot
 * that arrives over the open face is a REAL body meeting a REAL open box, and whether it stays
 * is derive.ts's rest test on the NEXT tick it settles, not a one-tick capture predicate. Same
 * for the "opponent's cell refuses it" ruling -- physical containment does not check whose
 * alliance a body is (plan section 3.6, owner decision 5: realism, then the rulebook), so
 * whichever cell an element comes to rest in is the one it counts for. hiveDeflect's "a miss
 * bounces off the structure" is also unnecessary: the tray's own solid walls already do that.
 *
 * Aim Assist's LANDING PREDICTION (bbFlightEnters run against a pretend-up copy of the hive) was
 * NOT reproduced on Day 1: release was gated on ALIGNMENT (is the mechanism pointed at its
 * solution right now) instead, and the deviation was reported rather than silently cut.
 *
 * ⚠️ **THAT DEVIATION IS CLOSED (2026-09-19), AND IT WAS A DOTTED LINE THAT CLOSED IT.** The
 * drawn shot path (`shotPath.ts`) is the SAME forward-simulated landing check the 2D gate runs,
 * so with 3D gating on alignment the picture and the trigger were two different verdicts — the
 * owner's "the dotted lines still appear when the shot is not able to be made". The pretend hive
 * is plain JSON (`bbPretendHive`) and has exactly as much meaning here as it does in 2D. Both
 * pipelines now read `bbTurretShotEnters` / `bbDumpShotEnters` (`play.ts`), which is the one
 * predicate `shotPath.ts` draws off. What 3D still does NOT copy is the CAPTURE test: a shot that
 * arrives over the open face is a real body meeting a real open box.
 */

const ALLIANCES: readonly Alliance[] = ['red', 'blue'];

/**
 * CAPTURE: the SAME roller model the 2D pipeline runs — `bbIntakeAct` (`robot.ts`) decides,
 * for each robot in id order with its intake held/auto, which elements the rollers have hold of
 * and which have been drawn to the throat, and the ones that have are taken through the SAME
 * `capturePollen` (same kind/eligibility rules, same hopper cap, same feed cadence off
 * `r.lastIntakeAt`). The body disappears on the next sync once its state flips to `held`.
 *
 * ⚠️ THE PULL IS A VELOCITY EDIT ON THE JSON, NOT A FORCE. Gameplay runs AFTER readback (stage
 * 11), so what is written here is what next tick's `syncElement` diffs — it sees the velocity
 * change and calls `setLinvel` on the body. A force would have had to be applied per tick and
 * reset per tick (forces PERSIST in Rapier 3D — `docs/area/biobuzz.md`), and a pull that is
 * really "the roller surface is moving at this speed" is a velocity in the first place.
 *
 * `lowFlight` is TRUE here and false in 2D, and it is now the ONLY difference: in 3D a shallow
 * bounce is a real body passing through the mouth, and `BB3_INTAKE_Z` is the roller's reach above
 * the tiles. The old `BB3_CAPTURE_TICKS` consecutive-overlap dwell is gone — the transit to the
 * throat and `BB_INTAKE_CROSS_MAX` do that job now, for both backends.
 *
 * ⚠️ `seat` IS THE DEFAULT (`'chassis'`) AGAIN, because the 3D chassis collider is a COMPOUND
 * with an OPEN intake mouth (`chassis3dShapes`). While it was one `robotExtents` cuboid the mouth
 * was solid, an element could never get nearer than the roller line, and this call had to pass
 * `seat: 'footprint'` to have an arrivable throat at all. Both backends now let an element ride
 * into the pocket and seat on the frame face, so both run the same geometry.
 */
export function elements3dCapture(
  world: World,
  engine: Engine3d,
  cmds: Map<number, RobotCommand>,
  enabled: boolean,
): void {
  // `engine` is kept in the signature (and unused) because this is the stage-11 slot `step3d`
  // calls; the roller model reads the WORLD's JSON and nothing else, which is what lets 2D and
  // 3D run the same function.
  void engine;
  const robots = [...world.robots].sort((a, b) => a.id - b.id);
  for (const rob of robots) {
    if (rob.passive) continue;
    const cmd = cmds.get(rob.id);
    if (!(enabled && (rob.autoIntake || (cmd?.intake ?? false)))) continue;
    const act = bbIntakeAct(world, rob, { lowFlight: true, extraReach: bbIntakeExtraReach(rob, world.time) });
    for (const p of act.pull) p.ball.vel = p.vel;
    for (const b of act.take) capturePollen(world, rob, b);
  }
}

const ZERO_CMD3D: RobotCommand = Object.freeze({
  driveX: 0,
  driveY: 0,
  rotate: 0,
  leftDrive: 0,
  rightDrive: 0,
  intake: false,
  fire: false,
});

/**
 * ⚠️ **THE SWING GUARD, 3D'S HALF** (owner, 2026-09-20: "if it collides with the flower or any
 * non-moving solid thing as it is being deployed, it should fold back up... same with
 * un-deploying"). Runs right after `bbRampStep` every tick. `rampSwingBlocked` is the Rapier
 * query (`bodies.ts`); a hit reverses the swing (`bbRampReverse`) in place, so the next tick's
 * `bbRampSwingProgress` picks up the SAME eased curve running the other way.
 *
 * ⚠️ **A REVERSED DEPLOY IS STILL TESTED, AND A SETTLED RAMP A STATIC PRESSES VERTICALLY FOLDS**
 * (replay 1dc6eb8f, 2026-09-25: a ramp robot frozen from 1:50 to the buzzer). The driver folded
 * while driving at a wall at 45 in/s. The fold's outward overshoot hit the wall and reversed to a
 * deploy, which was not tested again because it "retraced proven-clear ground". It did not: a
 * swinging ramp has no collider, the robot kept closing, and the ramp settled 2.4 in further on,
 * inside the wall. Its colliders were built there, the thin deck's shortest way out was DOWN, and
 * the floor pushed back: the chassis sank 0.3 in and never moved again. Every later fold press
 * reversed at once, because the ramp was already in the wall.
 * - Only a reversed FOLD skips the test: it retracts and removes solid, so it cannot land inside
 *   anything. A reversed DEPLOY is tested like any swing, and a second hit folds for good.
 *   Standing still that second hit never comes — the retraced poses were clear a tick ago.
 * - A SETTLED ramp in a contact with a fixed body whose normal is mostly vertical and deeper than
 *   `BB_RAMP_EMBED_DEPTH` folds (`rampEmbedded`). That is the jam's signature and nothing in play
 *   makes it: the deck rides 0.4 in over the tiles and skips the ring plates, so a static can only
 *   push it vertically from inside or above. The same jam came from driving the blade under a hive
 *   foot bar or frame foot (measured: 7 of 400 random drives froze that way, 0 after).
 */
function bbRampSwingStep3d(world: World, r: RobotState): void {
  const e = bbRampSwingProgress(r, world.time);
  if (e === null) {
    if (bbRampSettled(r, world.time) && rampEmbedded(engineFor(world), r)) {
      bbRampReverse(r, world.time, BB_RAMP_DEPLOY_S);
    }
    return;
  }
  if (r.bbRampBlocked && !r.bbRampOut) return;
  const engine = engineFor(world);
  const heightIn = bbHeightNow(world, r.spec);
  // every OTHER robot's body, so a swing cannot be deployed through one. Not this robot's own:
  // the blade hangs off that body and would report a hit on every tick of every swing.
  const others = new Set<number>();
  for (const [id, body] of engine.robots) if (id !== r.id) others.add(body.handle);
  const hit = rampSwingBlocked(rapier3d(), engine.world3d, r.spec, heightIn, r.pos, r.z ?? 0, r.heading, e, others);
  if (hit) {
    const elapsed = world.time - (r.bbRampAt ?? world.time);
    bbRampReverse(r, world.time, elapsed);
  }
}

/** is this robot's settled ramp held VERTICALLY by a fixed body — the jam `bbRampSwingStep3d`
 * folds out of? Reads the step's own contact manifolds on the ramp's colliders (`GROUP_RAMP`). */
function rampEmbedded(engine: Engine3d, r: RobotState): boolean {
  const body = engine.robots.get(r.id);
  if (!body) return false;
  const w3 = engine.world3d;
  let hit = false;
  for (let i = 0; i < body.numColliders() && !hit; i++) {
    const col = body.collider(i);
    if (col.collisionGroups() !== GROUP_RAMP) continue;
    w3.contactPairsWith(col, (other) => {
      if (hit || !other.parent()?.isFixed()) return;
      w3.contactPair(col, other, (m) => {
        if (Math.abs(m.normal().z) <= 0.5) return;
        for (let k = 0; k < m.numContacts(); k++) if (m.contactDist(k) < -BB_RAMP_EMBED_DEPTH) hit = true;
      });
    });
  }
  return hit;
}

/**
 * AIM + LAUNCH: slew each robot's mechanism toward its own hive (`bbAimTarget`, the nearer own
 * cell, exactly as 2D picks it), gate release on the SAME forward-simulated landing check 2D
 * runs (`bbTurretShotEnters` / `bbDumpShotEnters`, `play.ts` — and see this file's header for the
 * Day 1 deviation that closed), and fire through the SAME `bbLaunch` the 2D pipeline calls --
 * `releasePollen` writes the new flight element's JSON, and the very next sync creates its body
 * at the muzzle with that velocity, CCD on once its speed clears `BB3_CCD_SPEED`.
 */
export function elements3dAimAndLaunch(
  world: World,
  dt: number,
  cmds: Map<number, RobotCommand>,
  enabled: boolean,
): void {
  const bb = world.biobuzz;
  const shots = new Map<number, BbShot>();
  for (const rob of world.robots) {
    if (rob.passive) continue;
    // THE RAMP TOGGLE — same place the 2D pipeline steps it (`play.ts` stage 5b), alongside the
    // turret slew just below, with the same `enabled` gate driver control runs under.
    bbRampStep(rob, cmds.get(rob.id), enabled, world.time);
    // THE SWING GUARD, right after the toggle — see `bbRampSwingStep3d`'s own header.
    bbRampSwingStep3d(world, rob);
    const launcher = bbLauncherOf(rob.spec, BB_HOOD_DEFAULT_DEG);
    /**
     * ⚠️ **THE PASS IS HANDLED HERE AT ALL, WHICH IT WAS NOT.** `bbPass` shipped wired into
     * the 2D pipeline (`play.ts` stage 5b) and NOWHERE in this one — `bbPass` did not appear in
     * this file. `target` was always the hive, and `asking` read `fire` alone, so in 3D the
     * button did nothing whatsoever: no shot, no hopper change, no error.
     *
     * That is the whole feature missing where it is actually used. `docs/area/biobuzz.md`:
     * every server-connected match runs 3D, and `GameSettings.practicePhysics` defaults to
     * `'3d'` for solo too — so the one backend the pass worked under was the one almost nobody
     * plays. The owner reported it as "I'm not sure if the passing feature is working".
     *
     * It is the SAME four lines 2D runs, deliberately, so the two cannot drift again:
     */
    const passing = enabled && bbIsTurreted(launcher) && (cmds.get(rob.id)?.bbPass ?? false);
    const target = passing ? bbPassTargetOf(rob) : bbAimTarget(world, rob);
    /**
     * THE SAME LANDING GATE THE 2D PIPELINE RUNS (`play.ts` stage 5b) — see this file's header,
     * where Day 1's alignment-only deviation was reported.
     *
     * ⚠️ `pretend` IS BUILT FROM THE HIVE TARGET, NEVER FROM `target`, and that matters only
     * now that `target` can be a floor point: `bbCellSideOf` would otherwise be asked which
     * side of a patch of tiles is open. 2D states the same rule in its own comment. The
     * distinction was invisible while `target` was always the hive, which is exactly how a
     * copied line goes wrong later.
     */
    const pretend = bb ? bbPretendHive(bb.hives[rob.alliance], bbCellSideOf(bbAimTarget(world, rob))) : null;
    const asking = enabled && ((cmds.get(rob.id)?.fire ?? false) || passing) && rob.hopper.length > 0;
    if (bbIsTurreted(launcher)) {
      const speed: (number | undefined)[] = [];
      const lands: boolean[] = [];
      const exits: readonly (0 | 1)[] = launcher.kind === 'twinturret' ? [0, 1] : [0];
      for (const which of exits) {
        const sol = bbTurretSolution(rob, target, which);
        bbSlewTurret(rob, sol?.yaw ?? null, sol?.pitch ?? null, dt, which);
        speed[which] = sol?.speed;
        /* A PASS IS A DELIVERY TO A POINT, so "will it land" is `sol.reachable` plus
           `bbTurretOnTarget` and nothing more — the hive's pretend-tilt and `bbTurretShotEnters`
           are about arriving through a HOLE and mean nothing here. `bbTurretOnTarget` is not
           optional: gating on `reachable` alone releases while the turret is still slewing, and
           measured in 2D that put passes 34.8, 64.2 and 78.3 inches short. */
        lands[which] = passing
          ? asking && !!sol && sol.reachable && bbTurretOnTarget(rob, sol, which)
          : asking && !!pretend && !!sol && sol.reachable && bbTurretShotEnters(pretend, rob, which, sol.speed, dt);
      }
      shots.set(rob.id, { target, speed, lands });
    } else {
      // ⚠️ A DUMPER IS A CATAPULT: ONE FLING, THE WHOLE BUCKET (owner, 2026-09-19 — "a dumper
      // should not shoot one at a time. It holds four in a small 'hopper' and it would fling it
      // like a catapult"). `BbShot.cluster` is what picks `bbDumpCluster` over 2D's converging
      // `bbDumpSolution` at the release, and this file is its only caller.
      //
      // ⚠️ IT USED TO POUR — `perDump: 1` and a 0.3 s stagger between elements — because the
      // CONVERGING solve aims every element of a dump at the SAME cell-centre point, and four
      // real spheres converging meet in the opening (3/28 on the tutorial grid against 20/28
      // staggered). That treated the symptom with the wrong machine. A catapult's four seats
      // leave on ONE velocity and fly PARALLEL, so they arrive with the bucket's own footprint
      // and never touch each other; `BB_DUMP_BUCKET`'s header carries the geometry.
      shots.set(rob.id, {
        target,
        speed: [],
        lands: [asking && !!pretend && bbDumpShotEnters(pretend, rob, target, rob.hopper.length, true, dt)],
        cluster: true,
      });
    }
  }
  for (const rob of world.robots) {
    if (rob.passive) continue;
    bbLaunch(world, rob, cmds.get(rob.id) ?? ZERO_CMD3D, enabled, shots.get(rob.id));
  }
}

/**
 * PLACE (the Box Tube) and RETRIEVE (off a FLOWER's bottom opening) -- both reused outright from
 * `flower3d.ts`'s thin wrappers over the 2D `play.ts` functions. Edge-triggered exactly as 2D's
 * `placeLatch` is; this reimplements that tiny latch rather than importing a `play.ts`-private
 * function, since the latch convention (`bb.held[id]['placeP'/'placeN']`, a TRUE key or none) is
 * public via `BiobuzzState.held`'s own documented shape.
 */
export function elements3dPlaceAndRetrieve(
  world: World,
  cmds: Map<number, RobotCommand>,
  enabled: boolean,
): void {
  const bb = world.biobuzz;
  if (!bb) return;
  const ballById = new Map<number, Artifact>();
  for (const b of world.balls) ballById.set(b.id, b);
  const kindOf = bbKindIndex(world);

  for (const rob of world.robots) {
    if (rob.passive) continue;
    flowerRetrieve3d(world, bb, rob, cmds.get(rob.id), enabled, ballById, kindOf);
  }

  for (const rob of world.robots) {
    if (rob.passive) continue;
    const c = cmds.get(rob.id);
    placeLatch3d(world, bb, rob, 'placeP', enabled && !!c?.bbPlace, false, kindOf);
    placeLatch3d(world, bb, rob, 'placeN', enabled && !!c?.bbPlaceNectar, true, kindOf);
  }
}

function heldFlags3d(bb: BiobuzzState, id: number): Record<string, boolean> | null {
  const f = bb.held[id] as unknown;
  return typeof f === 'object' && f !== null ? (f as Record<string, boolean>) : null;
}

function placeLatch3d(
  world: World,
  bb: BiobuzzState,
  rob: RobotState,
  key: 'placeP' | 'placeN',
  pressed: boolean,
  nectar: boolean,
  kindOf: (id: number) => Alliance | 'pollen',
): void {
  const was = heldFlags3d(bb, rob.id)?.[key] === true;
  if (pressed && !was) flowerPlace3d(world, bb, rob, nectar, kindOf);
  if (pressed) {
    let f = heldFlags3d(bb, rob.id);
    if (!f) {
      f = {};
      bb.held[rob.id] = f;
    }
    f[key] = true;
  } else {
    const f = heldFlags3d(bb, rob.id);
    if (f && key in f) delete f[key];
  }
}

/**
 * HUMAN PLAYER: the SAME bookkeeping the 2D pipeline runs (`bbHumanPlayerTick`, extracted from
 * `play.ts`'s stage 7 -- see that function's header), plus the one 3D-only adjustment its return
 * value exists for: an entered NECTAR falls from the human player's hand rather than appearing
 * already resting, so its `z` is bumped to a short drop height. The next sync creates a falling
 * body from that JSON; gravity and `derive.ts` do the rest.
 */
const NECTAR_DROP_Z = 6; // in -- plan section 3.8

export function elements3dHumanPlayer(world: World, cmds: Map<number, RobotCommand>, enabled: boolean): void {
  const bb = world.biobuzz;
  if (!bb) return;
  const entered = bbHumanPlayerTick(world, bb, cmds, enabled);
  for (const a of ALLIANCES) {
    const ball = entered[a];
    if (ball) ball.z = NECTAR_DROP_Z;
  }
}
