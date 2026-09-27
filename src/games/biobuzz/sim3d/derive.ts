import type { Alliance, World } from '../../../types';
import { BB3_CELL_SEAT_DEPTH, BB3_REST_SPEED, BB3_REST_TICKS, BB_FLOWER_RETRIEVE_Z, BB_POLLEN_R, BB_RAMP_LIFT_Z } from '../config';
import { hiveTakingSide } from '../hive';
import { hiveTiltAngle, insideCell } from './hive3d';
import { flowerTubeOf } from './flowerTube';
import type { Engine3d } from './engineImpl';

/**
 * BIOBUZZ 3D PHYSICS -- DERIVE (Day 1, `docs/biobuzz/plan-3d.md` section 3.5), run every tick
 * right after `containmentPass` and right before the gameplay stage
 * (capture/launch/place/human player, `elements3d.ts`; the hive timer, `hive3d.ts`).
 *
 * This is the ONE place a ground/flight/hive-cell/FLOWER element's `BallState` is decided in the
 * 3D pipeline -- never a capture EVENT the way 2D's `park()` is, a per-tick READ of where the
 * body actually is. `held`/`stock` are untouched: they have no body to read.
 *
 * ⚠️ **FLOWERS ARE DERIVED TOO SINCE DAY 2.** A flower element used to be a FIXED body at the z
 * the 2D `flowerStackZ` model computed, and this function skipped it outright -- there was
 * nothing to derive about a body that could not move. `sim3d/flowerTube.ts` builds the three
 * real ring plates now, so a placed element FALLS and seats where the bores let it, and
 * `flowers[i].stack` is read back off the bodies BOTTOM TO TOP BY z the same way
 * `hives[a].contents` is read off the cell box. `placeInFlower`/`retrieveFromFlower` still own
 * the hopper half of the transaction (`flower3d.ts`); they no longer own the column.
 *
 * `hives[a].contents` IS DERIVED, EVERY TICK, FROM SCRATCH -- the 2D convention of appending an
 * id on capture and removing it on spill has no analogue here, because there is no capture EVENT
 * to append on. The result reads BY ID ascending rather than "arrival order": nothing that reads
 * `hives[a].contents` -- `hiveLoad` (a type count), `bbScoreWorld`'s `cellCount` (a length) --
 * is order-sensitive (unlike a FLOWER's stack, which genuinely is; see below), so an id sort is
 * exactly as correct as an arrival-order list and is the one a stateless derive can produce
 * without an extra "when did this arrive" clock. Documented as a deliberate 3D-only convention
 * change, not an oversight.
 *
 * A FLOWER's stack IS ORDER-SENSITIVE, unlike a cell's contents: §10.5.2's owner is the TOP-most
 * nectar and the bonus is the BOTTOM-most one, so the list is sorted by the bodies' own centre
 * heights (ties by id, which only a perfectly co-planar pair can produce). That is the same
 * bottom-to-top convention the 2D stack carries, derived instead of bookkept.
 *
 * A CELL's INTERIOR IS TESTED IN ITS OWN CURRENT (TILTED) FRAME, for BOTH cells of BOTH hives
 * every tick -- `hiveCellLocalBox`/`hiveTiltAngle`/`rotate2` -- so an element resting in EITHER
 * cell of an alliance's tray (the one currently up, or, rarely, one that flew into the currently-
 * down cell's still-open outer face) is TAGGED for that alliance. Only the TAKING cell's ids
 * reach `hives[a].contents`, which is a different question with three readers of its own -- see
 * the `taking` note in the function. See `bodies.ts`'s file header for the geometry and its one
 * flagged residual.
 *
 * ⚠️ **AND IT IS TESTED ON GEOMETRY ALONE -- THERE IS NO REST REQUIREMENT** (2026-09-19). A new
 * element has to be `BB3_CELL_SEAT_DEPTH` below the cell's open rim to be counted the first time,
 * which is what tells "in the cell" apart from "grazing across the top of it"; after that it is
 * counted anywhere inside the interior. See the loop below for the measurement that replaced the
 * rest gate, and `BB3_CELL_SEAT_DEPTH` for the window the constant sits in. The REST SNAP further
 * down is a different thing that happens to share `BB3_REST_TICKS`: it holds a settled element's
 * velocity at zero, and it decides nothing about membership.
 */

const ALLIANCES: readonly Alliance[] = ['red', 'blue'];

/** an element is AIRBORNE (`flight`) when its bottom is meaningfully off the tiles or it still
 * has real vertical speed; otherwise it is resting (`ground`, absent a cell match). APPROX
 * thresholds shared with nothing else -- this is the one place they are used. */
const AIRBORNE_Z = 0.05;
const AIRBORNE_VZ = 1;

export function deriveTick(world: World, engine: Engine3d): void {
  const bb = world.biobuzz;
  if (!bb) return;

  const theta: Record<Alliance, number> = { red: hiveTiltAngle(world, 'red'), blue: hiveTiltAngle(world, 'blue') };
  /**
   * ⚠️ **`contents` IS ONE CELL'S, AND IT IS THE CELL `hiveTakingSide` NAMES** (owner report
   * 2026-09-20: "the hive tips with nothing inside sometimes ... could be when balls are shot
   * towards the hive that is actively moving upwards").
   *
   * Both cells are still TAGGED below — an element in the down cell is in the hive structure,
   * not loose on the tiles, and `el` is what says so. But `contents` is not a tag list: it is
   * the UP CELL'S LOAD, and three readers treat it as one. `hiveDetentHold` lifts the tip pin
   * off it, `hud.ts` prints "N MORE TO TIP" off it, and Table 10-2 pays 2 each for what is
   * "remaining in an upward-facing CELL" off it. Counting the DOWN cell in it made all three
   * wrong at once, and the first is the owner's bug: an element that merely CROSSES the down
   * cell's still-open outer face — a miss dropping past the structure — was one more toward the
   * up cell's tip. Measured, and the HIVE3D lane's "DOWN cell" block is the fixture: 7 POLLEN in
   * the up cell (ONE SHORT of the table) plus ONE element in the down cell lifts the pin, and the
   * freed see-saw then goes over on the seven at tick 330, where seven alone never moves at all.
   * Nothing tipped is the down cell's business: its own load holds the tray ON its stop.
   *
   * `hiveTakingSide` rather than `up` because it is the game's one answer to "which cell is
   * taking right now", and it keeps the handover at the release: a driver filling the rising
   * tray through the second half of a swing (the documented mechanic) is counted as he fires
   * rather than two ticks after it settles.
   */
  const taking: Record<Alliance, 1 | -1> = {
    red: hiveTakingSide(bb.hives.red) === 'north' ? 1 : -1,
    blue: hiveTakingSide(bb.hives.blue) === 'north' ? 1 : -1,
  };
  const hiveIds: Record<Alliance, number[]> = { red: [], blue: [] };
  // per FLOWER, the ids inside its tube with the CENTRE HEIGHT that orders them
  const flowerIds: { id: number; z: number }[][] = bb.flowers.map(() => []);

  for (const b of world.balls) {
    if (b.state.kind === 'held' || b.state.kind === 'stock') continue;

    const speed = Math.sqrt(b.vel.x * b.vel.x + b.vel.y * b.vel.y + b.vz * b.vz);
    const atRest = speed < BB3_REST_SPEED;
    const prevTicks = engine.restTicks.get(b.id) ?? 0;
    const ticks = atRest ? prevTicks + 1 : 0;
    engine.restTicks.set(b.id, ticks);
    // THE REST SNAP -- the 3D twin of the 2D artifact world's `BALL_REST_SPEED` clamp
    // (`stepGroundBall`), and it must fire EVERY tick at rest, not once. `stepGroundBall`
    // clamps sub-threshold speed to zero on EVERY tick it sees one (`if (ns <= 0 || ns <
    // BALL_REST_SPEED) { b.vel.x = 0; ... }`, unconditionally, no edge trigger) -- a one-shot
    // `ticks === BB3_REST_TICKS` fired the clamp ONCE and then left the body alone, so any
    // velocity Rapier's OWN solver re-introduced on a later tick (a persistently-touching
    // neighbor's contact bias correction, in a crowded garden line, nudges an overlapping pair
    // apart a fraction every step) was never clamped again: measured, a garden-line element
    // drifted 2.3in over 600 further ticks, sliding along a wall it was resting against, well
    // past the ~0.1in of harmless damping creep this snap was written to catch. `>=` re-snaps
    // every qualifying tick, matching `stepGroundBall`'s own continuous clamp: once an element
    // has read AT REST for `BB3_REST_TICKS`, its velocity is held at exactly zero for as long as
    // it keeps reading at rest, so the next sync teleports the body to zero velocity (position
    // untouched) the FIRST time, and every tick after that the JSON already reads zero -- but
    // if the solver hands the body a nonzero velocity again, this clamps it right back down
    // before it can accumulate into a slide.
    // ⚠️ NO `kind !== 'flight'` GATE. It used to be here, and it is exactly what made an element
    // at rest ON STRUCTURE immortal: such an element is tagged `flight` (it is off the tiles),
    // so the snap skipped it, so the damping creep it was written to catch was the one case it
    // could never reach. The BODY-side snap (`groundRoll3d`) has the same coverage, including
    // angular velocity, and refuses only an element with no contact at all — the one in mid-air.
    // ⚠️ AND NO `flowerTubeOf` GATE EITHER — MEASURED, AND IT IS THE OPPOSITE OF THE GUESS.
    // A settling FLOWER column separates at a depenetration speed well under `BB3_REST_SPEED`,
    // so this snap zeroes it every tick and `syncElement`'s diff-teleport writes that zero onto
    // the body; the obvious reading is that the snap FREEZES the column mid-separation and that
    // exempting a tube element would let it finish pushing itself apart. It does not. Measured
    // through `step3d` in flower 0 at `BB3_CONTACT_FREQ` = 30, worst pollen-pollen centre gap
    // against the ideal 2.800 (4-stack / 8-stack overlap, max dxy off the bore axis):
    //   snap on   0.065 / 0.152 in, dxy 0.000   ← today
    //   snap off  0.818 / 0.848,    dxy 1.018
    // An ORDER OF MAGNITUDE worse, because what the exemption really buys is residual solver
    // noise that nothing damps: the column walks off the axis until the upper balls rest on each
    // other's shoulders, and a shouldered pair's centres are far closer than a stacked pair's.
    // (Measured the same way before `BB3_CONTACT_FREQ` landed, at the shared 12 Hz, it was
    // 0.406 / 0.948 with the snap against 0.407 / 1.107 without — so the exemption never helped
    // at any stiffness.) The interpenetration is CONTACT COMPLIANCE and the lever on it is that
    // constant, not this clamp. Leave the snap alone: the 2.3-in garden-line creep it was
    // written for is still the reason it exists.
    if (ticks >= BB3_REST_TICKS) {
      b.vel.x = 0;
      b.vel.y = 0;
      b.vz = 0;
    }

    const r = b.r ?? BB_POLLEN_R;
    const centreZ = b.z + r;
    /**
     * THE LATCH, AND IT IS PLAIN WORLD JSON. An element already tagged into THIS alliance's tray
     * last tick keeps its place for as long as its centre is anywhere inside either of that
     * tray's cells -- the entry DEPTH below has to be earned once, not held.
     *
     * ⚠️ Read off `b.state`, which every snapshot, delta and replay already carries (`slimWorld`
     * copies the whole state object, `el` included) and which `deriveTick` itself wrote last
     * tick. NOT an engine-local map: a peer that rebuilds its Rapier world mid-match -- a
     * reconnection, a reconcile, a prediction rewind -- rebuilds bodies from this same JSON and
     * therefore agrees about the latch, where `engine.restTicks` would have started from zero and
     * silently un-counted a settled cell. That is the one determinism question this rule raises
     * and it is why the answer is a field the wire already round-trips.
     */
    const latched = b.state.kind === 'element' ? b.state.el : '';
    let tagged = false;
    for (const a of ALLIANCES) {
      /**
       * ⚠️ **MEMBERSHIP IS GEOMETRY, NOT A REST TIMER** (owner report 2026-09-19: "a lot of delay
       * registering when the balls land in the hive, which means when it needs to tip, there is a
       * significant amount of lengthened tipping time due to the registration time").
       *
       * This test used to be guarded by `ticks >= BB3_REST_TICKS` -- an element counted only once
       * it had read under `BB3_REST_SPEED` for six consecutive ticks -- and the comment defending
       * it said "'in the cell' has to mean 'landed in it', and a shot crossing the mouth is not
       * yet in it". The concern was real; the instrument was not. MEASURED over 1,500 randomized
       * arrivals, entry of the centre into the interior to `hives[a].contents`: mean **95 ticks
       * (1.59 s)**, p90 205, max 264, one in a hundred never at all. Almost all of that is the
       * element's own SETTLING (the six-tick gate itself is six ticks); a real see-saw does not
       * wait for it, because the weight is on the tray as soon as the element is.
       *
       * What separates the two populations without waiting is DEPTH. The same sweep: of 209
       * arrivals that got a centre inside the interior, 92 left again, and every single one of
       * those stayed within 2.75 in of the cell's open rim -- they are shots grazing the top, not
       * shots crossing the mouth, because a box with one opening keeps what properly enters it.
       * `BB3_CELL_SEAT_DEPTH` is the window between that 2.75 and the 4.33 at which the shallowest
       * really-landed element ever rests; at it the sweep counts 0 grazes and misses 0 landings,
       * for a mean cost of 0.2 ticks. Its header carries both bounds and how to re-measure them.
       *
       * The FLOWER branch below has needed no rest requirement since Day 2 and its reasoning is
       * the same one, arrived at first: waiting "would drop a placed element out of the stack for
       * the six ticks of its own fall and flicker the HUD and G410's trigger with it".
       */
      const depth = latched === `hive:${a}` ? 0 : BB3_CELL_SEAT_DEPTH;
      for (const sideSign of [1, -1] as const) {
        if (insideCell(b.pos.x, b.pos.y, centreZ, a, sideSign, theta[a], depth)) {
          b.state = { kind: 'element', el: `hive:${a}`, slot: 0 }; // `slot` is set below, by id order
          // the TAG is either cell's; the LOAD is the taking cell's alone — see `taking` above.
          if (sideSign === taking[a]) hiveIds[a].push(b.id);
          tagged = true;
          break;
        }
      }
      if (tagged) break;
    }

    // A FLOWER TUBE, tested SECOND. A tube has one way in and no way out but the retrieval
    // opening, so an element inside it is in it, with no entry margin at all -- unlike a cell,
    // whose open top a shot can graze across (see `BB3_CELL_SEAT_DEPTH` above).
    /**
     * ⚠️ **AN ELEMENT LIFTED CLEAR OF THE BORE IS ON THE ROBOT, NOT IN THE TUBE.**
     * `flowerTubeOf` is a bare 2.086-in radius from the flower's own axis, and a POLLEN standing
     * on a deployed `ramp`'s DECK is still well inside it — measured, dead on the axis, 0.525 in
     * up (`BB_RAMP_DECK_Z`). Without this the retrieval's own release would be undone on the very
     * next tick, invisibly, and the rollers would never get a `ground` element to draw in.
     *
     * The test is a fact about the tube, not about the robot: inside it a POLLEN rests on the
     * TILES (bottom 0) or on the element under it (bottom ≥ 2·BB_POLLEN_R), and the lower plate's
     * own 0.354 rim carries a NECTAR, which is `element`-tagged from the moment it was placed and
     * so never reaches this line. Only a `ground` element can be hovering here, and the only thing
     * it can be standing on is hardware a robot drove in through the opening. A PLACED element
     * falling down the tube is tagged `element` the tick it is dropped and stays tagged; a shot
     * arriving from outside is `flight` until it lands, and it lands on the tiles or the column.
     */
    const liftedOut = b.state.kind === 'ground' && b.z >= BB_RAMP_LIFT_Z;
    if (!tagged && !liftedOut) {
      const i = flowerTubeOf(b.pos.x, b.pos.y, centreZ);
      /**
       * ⚠️ **AN ELEMENT JOINS A FLOWER THROUGH THE TOP, NEVER THROUGH THE RETRIEVAL OPENING.**
       * §10.5.2: "Placing SCORING ELEMENTS into the top of the FLOWER is the only allowable way
       * to score." A POLLEN or NECTAR pushed across the tiles into the opening has its centre
       * inside the bore, and it used to be adopted as the stack's BOTTOM element — where
       * `flowerStackZ` seats a NECTAR on the middle ring, so a floor NECTAR paid the 5-point
       * Bottom NECTAR Bonus, could take ownership, and fired G410 during the lock.
       *
       * So the same LATCH the cells use: an element already in this flower stays in it wherever
       * it falls to, and a new one is admitted only while its centre is above the opening's top
       * (`BB_FLOWER_RETRIEVE_Z[1]`), which only an element that came down the tube can be.
       * Placed and staged elements are tagged `flower:i` before their first tick and a shot is
       * seen well above the middle ring on its way down, so neither is affected.
       */
      const entered = i !== null && (latched === `flower:${i}` || centreZ > BB_FLOWER_RETRIEVE_Z[1]);
      if (i !== null && entered && i < flowerIds.length) {
        b.state = { kind: 'element', el: `flower:${i}`, slot: 0 }; // `slot` is set below, by z
        flowerIds[i].push({ id: b.id, z: centreZ });
        tagged = true;
      }
    }

    if (!tagged) {
      /**
       * ⚠️ **`flight` MEANS MOVING THROUGH THE AIR, NOT "OFF THE TILES".** An element that has
       * read AT REST for `BB3_REST_TICKS` and is in no cell and no tube is LOOSE ON THE FIELD,
       * whatever it is resting on — the hive frame, a tray's outer face, a pile — and the honest
       * tag for that is `ground`. It used to be `flight`, forever, and that was not cosmetic:
       * `capturePollen` refuses anything that is not `ground`, and the AI's element scan reads
       * `ground` only, so an element balanced on a frame bar was permanently out of play — no
       * robot could ever intake it and no bot could ever see it. Repro: an element dropped at
       * (12.3, −5.6) comes to rest on the blue HIVE frame at z 38.96 with zero velocity and read
       * `flight` for the rest of the match. It reads `ground` now, and the settle clock, which
       * asks about MOTION rather than the tag (`settle.ts`), is unaffected either way.
       *
       * No new `BallState` kind and no new wire field: `ground` already rides the snapshot and
       * the delta codec, and `z` already travels with it, so every reader that cared about the
       * height still has it.
       */
      const airborne = (b.z > AIRBORNE_Z || Math.abs(b.vz) > AIRBORNE_VZ) && ticks < BB3_REST_TICKS;
      if (airborne) {
        // preserve `target`/`by` while a launched element stays airborne (the 2D `by` alliance
        // filter is not read in 3D -- see `elements3d.ts`'s header -- but the field is kept
        // rather than dropped, so a snapshot mid-flight still round-trips the same shape).
        b.state = b.state.kind === 'flight' ? b.state : { kind: 'flight', target: (b.color === 'red' || b.color === 'blue') ? b.color : 'red' };
      } else {
        b.state = { kind: 'ground' };
      }
    }
  }

  const byId = new Map(world.balls.map((b) => [b.id, b]));
  for (const a of ALLIANCES) {
    const ids = hiveIds[a].sort((x, y) => x - y);
    ids.forEach((id, slot) => {
      const b = byId.get(id);
      if (b && b.state.kind === 'element') b.state = { ...b.state, slot };
    });
    bb.hives[a].contents = ids;
  }

  for (let i = 0; i < flowerIds.length; i++) {
    const rows = flowerIds[i].sort((p, q) => (p.z === q.z ? p.id - q.id : p.z - q.z));
    rows.forEach((row, slot) => {
      const b = byId.get(row.id);
      if (b && b.state.kind === 'element') b.state = { ...b.state, slot };
    });
    bb.flowers[i].stack = rows.map((row) => row.id);
  }
}
