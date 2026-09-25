import type { Check } from './harness';
import { cmd, mkWorld, mkWorld3d, mkWorld3dPair, run, run3d, setup } from './harness';
import { step3d } from '../../src/games/biobuzz/sim3d/step3d';
import { createBiobuzzWorld } from '../../src/games/biobuzz/spawn';
import { engineFor, disposeEngineFor } from '../../src/games/biobuzz/sim3d/engineImpl';
import { cadFlowerRings, cadStatics } from '../../src/games/biobuzz/sim3d/fieldColliders';
import { ringTrimesh, flowerTubeOf, flowerAtRetrieval, flowerCageBand, cageVertexR, FLOWER_CAGE_R } from '../../src/games/biobuzz/sim3d/flowerTube';
import { flowerPlace3d, flowerRetrieve3d } from '../../src/games/biobuzz/sim3d/flower3d';
import { bbFootprint, bbMouths, bbPlacePointLocal, bbRampSettled, mouthAxes } from '../../src/games/biobuzz/robot';
import { retrieveFromFlower, bbFlowerAtIntakeMouth } from '../../src/games/biobuzz/play';
import { BB_INTAKE_KINDS, type BbIntakeKind } from '../../src/games/biobuzz/mechs';
import { PHYS_ALLOWED_ERROR, PHYS_LENGTH_UNIT } from '../../src/config';
import {
  BB3_FLOWER_NECTAR_SORT_D,
  BB3_FLOWER_CAGE_SEGMENTS,
  BB3_FLOWER_CAGE_T,
  BB3_FLOWER_RING_SEGMENTS,
  BB3_FLOWER_SCATTER_FRAC,
  BB_FLOWERS,
  BB_PRESETS,
  bbFlowerReachOf,
  BB_FLOWER_LOW_HOLE,
  BB_FLOWER_LOW_Z,
  BB_FLOWER_MID_HOLE,
  BB_FLOWER_MID_Z,
  BB_FLOWER_RETRIEVE_Z,
  BB_FLOWER_TOP_Z,
  BB_NECTAR_R,
  BB_POLLEN_R,
  BB_PLACE_REACH,
  BB_RAMP_DEPLOY_S,
  FLOWER_MOUTH,
  BB_RAMP_OUT,
  bbSideRollerY,
  FLOWER_RING_Z,
} from '../../src/games/biobuzz/config';
import { bbFlowerScatter, bbFlowerDropSlack, flowerCapacity, flowerScore, flowerScoreZ, flowerStackZ, type BbElementKind } from '../../src/games/biobuzz/flower';
import type { Artifact, RobotSpec, RobotState, World } from '../../src/types';

/**
 * A REACHING intake archetype (owner, 2026-09-20: "intaking from the flower should now only be
 * done if it is physically possible") — `siderollers`, always ready with no deploy swing to wait
 * out — for every fixture in this file whose subject is the retrieval GATE or the TUBE itself,
 * not the archetype choice. The default build coerces to `sweeper`, which never reaches
 * (`bbFlowerReachOf('sweeper', …) === null`), so a fixture that does not ask for this explicitly
 * refuses every retrieval it drives regardless of pose. `launcher: null` migrates from the flat
 * default rather than repeating it here.
 */
const REACHING: Partial<RobotSpec> = { bbMech: { launcher: null, lift: null, intake: { kind: 'siderollers' } } as unknown as RobotSpec['bbMech'] };

/**
 * ⚠️ THE `REACHING` PARK POSE NEEDS A LATERAL OFFSET NOW (owner, 2026-09-20: "situated on the
 * edges of the robot, not near the center"). Side rollers are `edgeGrip`, not a centreline band —
 * every fixture in this file that parks a `REACHING` (siderollers) build ON the flower's own
 * centreline (`pos.y = f.y`) has to add this so ONE wheel actually lines up on the opening.
 */
function sideRollerParkY(spec: RobotSpec): number {
  const m = bbMouths(spec)[0];
  return bbSideRollerY(mouthAxes(m, spec.length / 2, spec.width / 2).half);
}

/**
 * FLOWER3D — the real TUBE (Day 2 lane A, `docs/biobuzz/plan-3d.md` §9).
 *
 * The plan's lane spec: "pollen through the middle ring, nectar seats; owner and bottom bonus by
 * z equal the shared `flowerScore` over the derived stack; retrieval pops the lowest pollen;
 * G410 on entry" — plus this brief's own "a 0.25-in ring plate stops a dropped element".
 *
 * ⚠️ **ONE OF THOSE SENTENCES IS NOT WHAT THE CAD SAYS, AND THE LANE ASSERTS THE CAD.** "Pollen
 * through the middle ring, nectar seats" is the 2D pipeline's SORTER RULING (owner, 2026-09-12),
 * written before anyone had measured the plate: the real middle bore is 3.896 against a 3.6-in
 * NECTAR, so it passes, and the real LOWER bore is 3.222 against Fig 9-12's printed 2.79, so a
 * POLLEN passes that too. Both kinds end up on the tiles inside the bottom bore. The manual's
 * INTENT survives — G418's "POLLEN out of the bottom and nothing else" holds, because a nectar
 * clears neither the lower bore nor the 3.550-in retrieval opening — but the ring that delivers
 * it is the bottom one. The checks below pin the MEASURED outcome and print the divergence from
 * the model; `docs/biobuzz/field-cad-audit.md` §11 is the write-up.
 */

const F = 0; // F1, the left wall — every flower is the same geometry, point-symmetric

function drop(w: World, i: number, kind: 'pollen' | 'nectar', id: number, color?: Artifact['color']): Artifact {
  const f = BB_FLOWERS[i];
  const r = kind === 'pollen' ? BB_POLLEN_R : BB_NECTAR_R;
  const el = {
    id,
    color: color ?? (kind === 'pollen' ? 'yellow' : 'blue'),
    state: { kind: 'element', el: `flower:${i}`, slot: 0 },
    pos: { x: f.x, y: f.y },
    vel: { x: 0, y: 0 },
    z: FLOWER_RING_Z.top[0] - r,
    vz: 0,
    r,
  } as Artifact;
  w.balls.push(el);
  return el;
}

const kindOfIn = (w: World) => (id: number): BbElementKind => {
  const b = w.balls.find((x) => x.id === id);
  if (!b) return 'pollen';
  return b.color === 'red' || b.color === 'blue' ? b.color : 'pollen';
};
const realZ = (w: World, ids: readonly number[]): number[] =>
  ids.map((id) => {
    const b = w.balls.find((x) => x.id === id);
    return b ? b.z + (b.r ?? BB_POLLEN_R) : 0;
  });

export function flower3dChecks(check: Check): void {
  // ---- the plates the CAD exported, and what fits through each -------------------------------
  {
    const rings = cadFlowerRings(F);
    check('the CAD exports three ring plates per FLOWER', rings.length === 3, `${rings.length}: ${rings.map((r) => r.id).join(',')}`);
    for (const ring of rings) {
      const mesh = ringTrimesh(ring);
      check(
        `ring ${ring.id}: the rectangle-minus-disc trimesh tessellates (bore ${(ring.hole * 2).toFixed(3)} at z ${ring.z[0]}..${ring.z[1]})`,
        mesh !== null && mesh.indices.length / 3 === 8 * (BB3_FLOWER_RING_SEGMENTS + 4),
        mesh ? `${mesh.vertices.length / 3} verts, ${mesh.indices.length / 3} tris` : 'NULL (the bore is not inside its own plate)',
      );
    }
    console.log(
      `[smoke-bb flower3d] bores: top ${(cadFlowerRings(F)[2].hole * 2).toFixed(3)} · mid ${BB_FLOWER_MID_HOLE} · lower ${BB_FLOWER_LOW_HOLE}; ` +
        `POLLEN 2.8, NECTAR 3.6; retrieval opening ${(BB_FLOWER_RETRIEVE_Z[1] - BB_FLOWER_RETRIEVE_Z[0]).toFixed(3)} tall (Fig 9-12 prints 3.55)`,
    );
    /**
     * THE MEASUREMENT THE WHOLE LANE TURNS ON, asserted as arithmetic rather than as behaviour so
     * a re-measured CAD breaks it here, with both numbers in the message, instead of three checks
     * further down as "the nectar ended up somewhere else".
     */
    check(
      'the CAD middle bore PASSES a NECTAR — the 2D sorter ruling is a model, not this geometry',
      BB_FLOWER_MID_HOLE > 2 * BB_NECTAR_R,
      `mid bore ${BB_FLOWER_MID_HOLE} vs a ${2 * BB_NECTAR_R}in NECTAR (clearance ${(BB_FLOWER_MID_HOLE - 2 * BB_NECTAR_R).toFixed(3)})`,
    );
    check(
      'the CAD lower bore STOPS a NECTAR and passes a POLLEN — it is the ring that sorts',
      BB_FLOWER_LOW_HOLE < 2 * BB_NECTAR_R && BB_FLOWER_LOW_HOLE > 2 * BB_POLLEN_R,
      `lower bore ${BB_FLOWER_LOW_HOLE}: NECTAR ${2 * BB_NECTAR_R} stopped, POLLEN ${2 * BB_POLLEN_R} passes`,
    );
    check(
      "the retrieval opening is Fig 9-12's 3.55 in, derived from two independently measured plates",
      Math.abs(BB_FLOWER_RETRIEVE_Z[1] - BB_FLOWER_RETRIEVE_Z[0] - 3.55) < 0.005,
      `${(BB_FLOWER_RETRIEVE_Z[1] - BB_FLOWER_RETRIEVE_Z[0]).toFixed(4)} = mid underside ${BB_FLOWER_MID_Z} − lower top ${BB_FLOWER_LOW_Z}`,
    );
  }

  // ---- what an element DOES in the tube, by kind ---------------------------------------------
  for (const kind of ['pollen', 'nectar'] as const) {
    const w = mkWorld3d('free', kind === 'pollen' ? 900 : 901);
    w.balls.length = 0;
    const el = drop(w, F, kind, 1);
    for (let t = 0; t < 400; t++) step3d(w, 1 / 60, new Map());
    const r = el.r ?? BB_POLLEN_R;
    const centre = el.z + r;
    const lateral = Math.hypot(el.pos.x - BB_FLOWERS[F].x, el.pos.y - BB_FLOWERS[F].y);
    console.log(
      `[smoke-bb flower3d] a lone ${kind} dropped at the top ring settles at centre ${centre.toFixed(3)} ` +
        `(spans ${el.z.toFixed(3)}..${(el.z + 2 * r).toFixed(3)}), ${lateral.toFixed(3)} off the axis`,
    );
    // ⚠️ A NECTAR no longer reaches the tiles (owner, 2026-09-24): the middle ring's NECTAR lip
    // (`BB3_FLOWER_NECTAR_SORT_D`) seats it with its centre `sqrt(r² − (d/2)²)` over the plate's
    // top face, clear of the retrieval opening. A POLLEN never meets the lip and still falls.
    const want =
      kind === 'pollen'
        ? r
        : FLOWER_RING_Z.mid[1] + Math.sqrt(BB_NECTAR_R * BB_NECTAR_R - (BB3_FLOWER_NECTAR_SORT_D / 2) ** 2);
    check(
      kind === 'pollen'
        ? 'a dropped pollen falls to the TILES inside the bottom bore — it clears all three plates'
        : '⚠️ a dropped nectar SEATS on the middle ring, above the retrieval opening (G418), not on the tiles',
      Math.abs(centre - want) < 0.3 && (kind === 'pollen' || el.z > BB_FLOWER_RETRIEVE_Z[1] - 0.1),
      `centre ${centre.toFixed(3)}, expected ~${want.toFixed(3)}; bottom ${el.z.toFixed(3)} vs the opening's top ${BB_FLOWER_RETRIEVE_Z[1]}`,
    );
    check(
      `a dropped ${kind} is in the FLOWER's derived stack`,
      w.biobuzz!.flowers[F].stack.length === 1 && w.biobuzz!.flowers[F].stack[0] === 1,
      `stack ${JSON.stringify(w.biobuzz!.flowers[F].stack)}`,
    );
    check(
      `flowerTubeOf agrees the ${kind} is in tube ${F}`,
      flowerTubeOf(el.pos.x, el.pos.y, centre) === F,
      `got ${flowerTubeOf(el.pos.x, el.pos.y, centre)}`,
    );
  }

  // ---- the 2D model and the 3D column, compared ON PURPOSE ----------------------------------
  //
  // `flowerScore` is the shared rule over the MODEL's heights and stays the scoring authority for
  // both pipelines ("one scoring, one HUD, two physics", plan §3.5). `flowerScoreZ` is the same
  // rule over the heights the bodies actually have. Where they agree, that is one less thing to
  // worry about; where they disagree, the disagreement is a MEASUREMENT and is printed.
  {
    const rows: { what: string; kinds: ('pollen' | 'nectar')[]; colors: Artifact['color'][] }[] = [
      { what: '4 staged POLLEN', kinds: ['pollen', 'pollen', 'pollen', 'pollen'], colors: ['yellow', 'yellow', 'yellow', 'yellow'] },
      { what: '4 POLLEN + a blue NECTAR', kinds: ['pollen', 'pollen', 'pollen', 'pollen', 'nectar'], colors: ['yellow', 'yellow', 'yellow', 'yellow', 'blue'] },
      { what: 'a lone blue NECTAR', kinds: ['nectar'], colors: ['blue'] },
    ];
    for (const [ri, row] of rows.entries()) {
      const w = mkWorld3d('free', 910 + ri);
      w.balls.length = 0;
      for (const [i, kind] of row.kinds.entries()) {
        drop(w, F, kind, i + 1, row.colors[i]);
        for (let t = 0; t < 90; t++) step3d(w, 1 / 60, new Map()); // one at a time, as a robot places them
      }
      for (let t = 0; t < 300; t++) step3d(w, 1 / 60, new Map());
      const stack = w.biobuzz!.flowers[F].stack;
      const kindOf = kindOfIn(w);
      const zs = realZ(w, stack);
      const model = flowerScore(stack, kindOf);
      const real = flowerScoreZ(stack, kindOf, zs);
      console.log(
        `[smoke-bb flower3d] ${row.what}: stack ${JSON.stringify(stack)} real z [${zs.map((z) => z.toFixed(2)).join(', ')}] · ` +
          `model owner=${model.owner} inVol=${model.inVolume} · real owner=${real.owner} inVol=${real.inVolume}`,
      );
      check(
        `${row.what}: every element that went in is in the derived stack, ordered bottom to top`,
        stack.length === row.kinds.length && zs.every((z, i) => i === 0 || z >= zs[i - 1] - 1e-6),
        `${stack.length}/${row.kinds.length}, z [${zs.map((z) => z.toFixed(2)).join(', ')}]`,
      );
      /**
       * EVERY ROW AGREES NOW, the lone NECTAR included. It used to be the one divergence, pinned
       * as a measurement: the NECTAR fell to the tiles and topped out at 3.60 against a scoring
       * floor of 3.904, where the 2D model seats it on the middle ring. The owner's ruling
       * (2026-09-24: a NECTAR at the bottom "droops too low" and a ramp could pull it out) gave
       * the 3D middle ring its NECTAR lip, so both pipelines seat it on that ring.
       */
      check(
        `${row.what}: the MODEL and the real column agree on owner, bonus and count`,
        model.owner === real.owner && model.bonusAlliance === real.bonusAlliance && model.inVolume === real.inVolume,
        `model ${model.owner}/${model.bonusAlliance}/${model.inVolume} vs real ${real.owner}/${real.bonusAlliance}/${real.inVolume}`,
      );
    }
  }

  // ---- no tunnelling: a 260 in/s shot onto the SOLID plate is stopped ------------------------
  //
  // `BB3_CCD_SPEED` turns CCD on above 60 in/s, and the plates are 0.55 to 1.35 in thick. The
  // shot is aimed 3.6 in off the axis — the ball's NEAREST point is 2.2 from the axis, outside
  // the 2.086 top bore, so every part of it is over solid plate and there is no hole to slip into.
  {
    for (const speed of [120, 260]) {
      const w = mkWorld3d('free', 920 + speed);
      w.balls.length = 0;
      const f = BB_FLOWERS[F];
      w.balls.push({
        id: 1,
        color: 'yellow',
        state: { kind: 'flight', target: 'blue' },
        pos: { x: f.x + 3.6, y: f.y },
        vel: { x: 0, y: 0 },
        z: 40,
        vz: -speed,
        r: BB_POLLEN_R,
      } as Artifact);
      for (let t = 0; t < 400; t++) step3d(w, 1 / 60, new Map());
      const b = w.balls[0];
      const lateral = Math.hypot(b.pos.x - f.x, b.pos.y - f.y);
      check(
        `no tunnelling: a ${speed} in/s POLLEN onto the solid top plate is DEFLECTED, not passed`,
        lateral > 4,
        `ended ${lateral.toFixed(1)}in from the axis at z ${(b.z + BB_POLLEN_R).toFixed(2)} (plate top ${BB_FLOWER_TOP_Z})`,
      );
    }
  }

  // ---- THE RAMP'S BAR IS SOLID TO A GROUND ELEMENT (owner report 2026-09-20) ------------------
  //
  // "The pollen should be getting intaked from the deployable ramp BECAUSE it collides with the
  // ramp... right now, it just looks like the pollen is passing through the ramp." A ground
  // POLLEN fired at the deployed crossbar's plane must bounce/stop, never cross it.
  {
    const rampSpec: Partial<RobotSpec> = {
      intakeMount: 'front',
      bbMech: { launcher: null, lift: null, intake: { kind: 'ramp' } } as unknown as RobotSpec['bbMech'],
    };
    const w = mkWorld3d('free', 940, rampSpec);
    w.balls.length = 0;
    const rob = w.robots[0];
    rob.pos = { x: 0, y: 0 };
    rob.heading = Math.PI; // front mouth faces -x
    rob.vel = { x: 0, y: 0 };
    rob.angVel = 0;
    step3d(w, 1 / 60, new Map()); // build the engine, folded
    step3d(w, 1 / 60, new Map([[0, cmd({ bbRamp: true })]])); // deploy
    const deploySteps = Math.round(BB_RAMP_DEPLOY_S / (1 / 60)) + 2;
    for (let t = 0; t < deploySteps; t++) step3d(w, 1 / 60, new Map());
    check('ramp bar probe: the ramp is deployed and settled before firing', bbRampSettled(rob, w.time), `out=${rob.bbRampOut} settled=${bbRampSettled(rob, w.time)}`);
    // a ground POLLEN, 30 in/s, straight at the deployed bar's own plane — the crossbar's centre
    // sits `uOut + BB_RAMP_OUT − 0.15` outward (`chassis3dReachShapes`'s own placement,
    // `uOut ≈ bbFootprint(...).front`), and heading π maps that outward distance to WORLD −x.
    const barX = rob.pos.x - (bbFootprint(rob.spec).front + BB_RAMP_OUT - 0.15);
    w.balls.push({ id: 501, color: 'yellow', r: BB_POLLEN_R, state: { kind: 'ground' }, pos: { x: barX - 20, y: 0 }, vel: { x: 30, y: 0 }, z: 0, vz: 0 } as Artifact);
    const ball = w.balls[w.balls.length - 1];
    let crossedPlane = false;
    for (let t = 0; t < 180; t++) {
      step3d(w, 1 / 60, new Map());
      if (ball.pos.x > barX + 0.5) crossedPlane = true;
    }
    check(
      "ramp bar probe: a ground POLLEN fired at the deployed bar's plane at 30 in/s never crosses it",
      !crossedPlane,
      `final x=${ball.pos.x.toFixed(2)} bar plane x=${barX.toFixed(2)} crossed=${crossedPlane}`,
    );
  }

  // ---- retrieval: the lowest POLLEN, and only when it is at the opening ----------------------
  {
    const w = mkWorld3d('free', 930, REACHING);
    w.balls.length = 0;
    drop(w, F, 'pollen', 1);
    for (let t = 0; t < 90; t++) step3d(w, 1 / 60, new Map());
    drop(w, F, 'pollen', 2);
    for (let t = 0; t < 300; t++) step3d(w, 1 / 60, new Map());
    const stack = [...w.biobuzz!.flowers[F].stack];
    const zs = realZ(w, stack);
    check('retrieval fixture: two POLLEN are stacked in the tube', stack.length === 2, `${stack.length}`);
    check(
      'the LOWEST element is the one at the retrieval opening',
      stack.length === 2 && flowerAtRetrieval(zs[0]) && !flowerAtRetrieval(zs[1]),
      `z [${zs.map((z) => z.toFixed(2)).join(', ')}] against the opening ${BB_FLOWER_RETRIEVE_Z[0]}..${BB_FLOWER_RETRIEVE_Z[1]}`,
    );
    // drive the real gameplay path: the same gates the 2D pipeline uses, through `flower3d.ts`
    const rob = w.robots[0];
    const ballById = new Map(w.balls.map((b) => [b.id, b] as const));
    // ⚠️ AND THE HOPPER HAS TO BE EMPTIED. `w.balls.length = 0` clears the FIELD but not the
    // robot's own `hopper` array, which G304.G stages with four preloaded POLLEN — and
    // `bbHopperCap` is 4, so the retrieval refused on "no room" while every geometric gate it is
    // actually testing passed. The colours and the balls are two mirrors of one multiset
    // (`elements.ts`), so a fixture that clears one has to clear the other.
    rob.hopper.length = 0;
    rob.lastIntakeAt = -99;
    // park the robot's chassis FRAME FACE flush on the foot: `BB_PLACE_REACH` out from the ring
    // centre, the same "chassis face flush" convention `bbFlowerAtIntake`'s own reach numbers are
    // measured from (`config.ts`'s FLOWER-opening header) — archetype-aware since 2026-09-20, so
    // `REACHING` above is what makes this pose actually bite.
    const f = BB_FLOWERS[F];
    rob.pos.x = f.x + BB_PLACE_REACH + bbFootprint(rob.spec).front;
    rob.pos.y = f.y - sideRollerParkY(rob.spec); // one wheel on the opening (edgeGrip, not a centreline band)
    rob.heading = Math.PI;
    const took = flowerRetrieve3d(w, w.biobuzz!, rob, cmd({ intake: true }), true, ballById, kindOfIn(w));
    check(
      'retrieval pops the LOWEST POLLEN off the bottom (G418.B)',
      took && w.biobuzz!.flowers[F].stack.length === 1 && w.biobuzz!.flowers[F].stack[0] === stack[1],
      `took=${took} stack ${JSON.stringify(w.biobuzz!.flowers[F].stack)} (was ${JSON.stringify(stack)})`,
    );
  }
  // ---- AND THROUGH A REAL DRIVE-IN, NOT A TELEPORT (owner, 2026-09-20: "It should be a
  // collider.") — the reach hardware is now solid (`chassis3dReachShapes`, `GROUP_POCKET`), so
  // the flush pose above has to be something a driver actually reaches under full stick, with
  // the side rollers passing UNDER the mid plate into the open space the CAD leaves there,
  // while the chassis BRACE (the frame face) still stops at the plate edge as it always did.
  {
    const w = mkWorld3d('free', 937, REACHING);
    w.balls.length = 0;
    drop(w, F, 'pollen', 1);
    for (let t = 0; t < 300; t++) step3d(w, 1 / 60, new Map());
    const rob = w.robots[0];
    rob.hopper.length = 0;
    rob.lastIntakeAt = -99;
    const f = BB_FLOWERS[F];
    const wantX = f.x + BB_PLACE_REACH + bbFootprint(rob.spec).front;
    const wantY = f.y - sideRollerParkY(rob.spec); // one wheel on the opening (edgeGrip)
    // start 20in further out, facing the foot, and DRIVE full stick — the CAD hulls (the peanut
    // supports, the plate edge) decide the standoff, not an assignment to `rob.pos`. Driven
    // straight in with no yaw command, so it has to START on the lateral line a wheel bites on.
    rob.pos.x = wantX + 20;
    rob.pos.y = wantY;
    rob.heading = Math.PI;
    rob.vel = { x: 0, y: 0 };
    rob.angVel = 0;
    run3d(w, new Map([[0, cmd({ driveY: 1, leftDrive: 1, rightDrive: 1 })]]), 3);
    const drivenX = rob.pos.x;
    console.log(
      `[smoke-bb flower3d] drive-in: started ${(wantX + 20).toFixed(2)}, driven to ${drivenX.toFixed(3)} ` +
        `(teleport convention wants ${wantX.toFixed(3)}, i.e. u ~= BB_PLACE_REACH ${BB_PLACE_REACH})`,
    );
    /**
     * ⚠️ **TOLERANCE RE-MEASURED 2026-09-21, AND THIS CHECK IS WHAT FIXED THE PROTRUSION**
     * (owner: "The side rollers are rendered as being covered and still sticking out a ton").
     * `BB_SIDE_ROLLER_OUT` 0.4 → 0.15, so the wheel's front stands 1.65 in past the tip line, not
     * 1.90. MEASURED at the new geometry: a full-stick drive settles **1.677 in** past the
     * analytic flush pose, against 1.518 at the longer wheel — a shorter wheel meets the CAD's
     * peanut-support hulls later, so the chassis carries further in before anything stops it.
     * 1.8 in covers it with the same small margin every earlier widening of this bound used.
     *
     * ⚠️ **AND THIS FIXTURE IS WHAT FIXED THE CUT AT 1.65.** A chassis driven full stick into a
     * FLOWER meets the ring plate over only ONE SIDE of its own width — the driver is offset
     * `bbSideRollerY` to put a wheel on the opening — so the normal force is a long lever and the
     * pose picks up **18–22° of yaw** before it settles, which swings the gripping wheel out.
     * Reach is what covers that yaw, and 1.90 sat exactly on this fixture's own boundary: driven
     * in with the intake OFF and asked ONCE at the settled pose, it bites at 1.90 and at NO
     * smaller value, 1.80 included. Held through the drive — the driver's own action, and what
     * every other retrieval check here does — it bites at 1.90, 1.65 and 1.60 and not at 1.50.
     * The wider population moves smoothly: over 36 real park-then-intake cases
     * (`scratch/sidesweep.ts` `SS_MODE=park`, four FLOWERS × three sticks × three offsets, drive
     * in with the intake OFF, settle, THEN hold it) **1.90 → 61.1 %, 1.65 → 58.3 %, 1.60 →
     * 44.4 %, 1.50 → 33.3 %, 1.45 and below → 0 %**, and the held-intake sweep's straight-on
     * column is 180/180 at 1.65 and 179/180 at 1.60. 1.65 is therefore the largest cut the owner
     * asked for that costs neither population anything measurable; 1.40, which the held-intake
     * sweep alone would have allowed, takes park-then-intake to ZERO.
     */
    check(
      "drive-in: a SIDE-ROLLER build driven full-stick into F1's foot stops close to the flush distance the teleport fixtures assume (u ~= BB_PLACE_REACH, within 1.8in)",
      Math.abs(drivenX - wantX) < 1.8,
      `driven to x=${drivenX.toFixed(3)}, want ${wantX.toFixed(3)} (delta ${(drivenX - wantX).toFixed(3)})`,
    );
    // ⚠️ STILL NO ANALYTIC RE-SEAT (owner, 2026-09-20: a previous pass here teleported the robot
    // back to the flush pose before testing the bite, papering over the fact that the CONTACT gate
    // no longer matched what a real drive-in lands inside once the wheel became a solid collider).
    // What DID change with the protrusion cut is that the intake is HELD through the drive, which
    // is the driver's own action and what every other retrieval check here does — see the header
    // above for the measurement that says why, and for what the last 0.25 in of reach was buying.
    const w2 = mkWorld3d('free', 937, REACHING);
    w2.balls.length = 0;
    drop(w2, F, 'pollen', 1);
    for (let t = 0; t < 300; t++) step3d(w2, 1 / 60, new Map());
    const rob2 = w2.robots[0];
    rob2.hopper.length = 0;
    rob2.lastIntakeAt = -99;
    rob2.pos.x = wantX + 20;
    rob2.pos.y = wantY;
    rob2.heading = Math.PI;
    rob2.vel = { x: 0, y: 0 };
    rob2.angVel = 0;
    run3d(w2, new Map([[0, cmd({ driveY: 1, leftDrive: 1, rightDrive: 1, intake: true })]]), 3);
    check(
      'drive-in: a REAL drive-in with the intake held (no teleport, no reseat) empties the flower through flowerRetrieve3d',
      w2.biobuzz!.flowers[F].stack.length === 0 && rob2.hopper.length > 0,
      `stack ${JSON.stringify(w2.biobuzz!.flowers[F].stack)} hopper ${rob2.hopper.length} pose x=${rob2.pos.x.toFixed(3)} y=${rob2.pos.y.toFixed(3)} heading=${rob2.heading.toFixed(3)}`,
    );
  }
  {
    // ...and a NECTAR at the bottom LOCKS the flower, which is the whole of G418's asymmetry.
    const w = mkWorld3d('free', 931, REACHING);
    w.balls.length = 0;
    drop(w, F, 'nectar', 1);
    for (let t = 0; t < 300; t++) step3d(w, 1 / 60, new Map());
    const rob = w.robots[0];
    // ⚠️ AND THE HOPPER HAS TO BE EMPTIED. `w.balls.length = 0` clears the FIELD but not the
    // robot's own `hopper` array, which G304.G stages with four preloaded POLLEN — and
    // `bbHopperCap` is 4, so the retrieval refused on "no room" while every geometric gate it is
    // actually testing passed. The colours and the balls are two mirrors of one multiset
    // (`elements.ts`), so a fixture that clears one has to clear the other.
    rob.hopper.length = 0;
    rob.lastIntakeAt = -99;
    const f = BB_FLOWERS[F];
    rob.pos.x = f.x + BB_PLACE_REACH + bbFootprint(rob.spec).front;
    rob.pos.y = f.y - sideRollerParkY(rob.spec); // one wheel on the opening (edgeGrip)
    rob.heading = Math.PI;
    const ballById = new Map(w.balls.map((b) => [b.id, b] as const));
    const took = flowerRetrieve3d(w, w.biobuzz!, rob, cmd({ intake: true }), true, ballById, kindOfIn(w));
    check(
      'a NECTAR at the bottom LOCKS the FLOWER — 3.6 in passes neither the 3.222 bore nor the 3.550 opening',
      !took && w.biobuzz!.flowers[F].stack.length === 1,
      `took=${took} stack ${JSON.stringify(w.biobuzz!.flowers[F].stack)}`,
    );
  }
  {
    // a SWEEPER in the SAME pose pulls nothing in 3D either — this is `sweeper` in every other
    // respect the default spec already is, so no `REACHING` override.
    const w = mkWorld3d('free', 933);
    w.balls.length = 0;
    drop(w, F, 'pollen', 1);
    for (let t = 0; t < 300; t++) step3d(w, 1 / 60, new Map());
    const rob = w.robots[0];
    rob.hopper.length = 0;
    rob.lastIntakeAt = -99;
    const f = BB_FLOWERS[F];
    rob.pos.x = f.x + BB_PLACE_REACH + bbFootprint(rob.spec).front;
    rob.pos.y = f.y;
    rob.heading = Math.PI;
    const ballById = new Map(w.balls.map((b) => [b.id, b] as const));
    const took = flowerRetrieve3d(w, w.biobuzz!, rob, cmd({ intake: true }), true, ballById, kindOfIn(w));
    check(
      'a SWEEPER flush on the foot pulls NOTHING in 3D — never reaches the opening, same as 2D',
      !took && w.biobuzz!.flowers[F].stack.length === 1,
      `took=${took} stack ${JSON.stringify(w.biobuzz!.flowers[F].stack)}`,
    );
  }

  // ---- A RAMP'S FLOWER POLLEN IS A GROUND ELEMENT FOR >= 1 TICK BEFORE IT IS IN THE HOPPER ------
  //
  // `flowerRetrieve3d`'s ramp branch releases (never `capturePollen`s) — MEASURED over 10 real
  // drive-ins (report), transit 8–13 ticks. This pins the CLAIM directly: at least one tick
  // between the pop (no longer in `flowers[i].stack`, tagged `ground`) and the swallow (`held`),
  // and it is never instant.
  {
    const rampSpec: Partial<RobotSpec> = {
      intakeMount: 'front',
      bbMech: { launcher: null, lift: null, intake: { kind: 'ramp' } } as unknown as RobotSpec['bbMech'],
    };
    const w = mkWorld3d('free', 941, rampSpec);
    w.balls.length = 0;
    drop(w, F, 'pollen', 1);
    for (let t = 0; t < 300; t++) step3d(w, 1 / 60, new Map());
    const rob = w.robots[0];
    rob.hopper.length = 0;
    rob.lastIntakeAt = -99;
    const f = BB_FLOWERS[F];
    rob.pos = { x: f.x + bbFootprint(rob.spec).front + 20, y: f.y };
    rob.heading = Math.PI;
    rob.vel = { x: 0, y: 0 };
    rob.angVel = 0;
    step3d(w, 1 / 60, new Map([[0, cmd({ bbRamp: true })]]));
    const deploySteps = Math.round(BB_RAMP_DEPLOY_S / (1 / 60)) + 2;
    for (let t = 0; t < deploySteps; t++) step3d(w, 1 / 60, new Map());
    const commands = new Map([[0, cmd({ driveY: 0.5, leftDrive: 0.5, rightDrive: 0.5, intake: true })]]);
    let releasedAt = -1;
    let capturedAt = -1;
    for (let t = 0; t < 240 && capturedAt < 0; t++) {
      step3d(w, 1 / 60, commands);
      const inFlower = w.biobuzz!.flowers[F].stack.includes(1);
      const ball = w.balls.find((b) => b.id === 1)!;
      if (!inFlower && releasedAt < 0) releasedAt = t;
      if (ball.state.kind === 'held') capturedAt = t;
    }
    check(
      'ramp flower transit: the bottom POLLEN is captured within the drive window',
      capturedAt >= 0,
      `releasedAt=${releasedAt} capturedAt=${capturedAt}`,
    );
    check(
      'ramp flower transit: it spends AT LEAST ONE TICK as a ground element outside the flower before capture — never an instant teleport',
      releasedAt >= 0 && capturedAt > releasedAt,
      `releasedAt=${releasedAt} capturedAt=${capturedAt} transit=${capturedAt - releasedAt}`,
    );
  }

  // ---- 2D/3D PARITY: the archetype gate agrees across both pipelines --------------------------
  /**
   * `bbFlowerAtIntake` is the ONE function both `retrieveFromFlower` (2D) and `flowerRetrieve3d`
   * (3D) call — so a divergence here would be a divergence in the Z-BITE half of the gate, which
   * each pipeline runs against a DIFFERENT bottom-element height (2D: the modelled
   * `flowerStackZ`; 3D: the real settled body). Swept over `siderollers` and a SETTLED `ramp` (the
   * two archetypes with a reach) and four standoffs the ROBOT lane's own numbers are pinned
   * against (flush, and past/within/at the side-roller tolerance), each pipeline gets a FRESH
   * single-pollen flower and a robot parked at the SAME nominal pose (`BB_PLACE_REACH + standoff`,
   * chassis face flush + standoff).
   *
   * ⚠️ **`ramp` IS EXCLUDED FROM THE ONE-CALL COMPARISON, DELIBERATELY.**
   * `flowerRetrieve3d`'s ramp branch does not answer a gate in one call: on a POLLEN that is still
   * sitting in the bore it turns the lip's ROLLER and returns `false`, and it only takes the ball
   * once the blade has physically lifted it clear (`BB_RAMP_LIFT_Z`). 2D still answers in one call
   * — it has no blade to wait on. Diffing `took2 !== took3` for `ramp` would therefore fail on
   * EVERY pose by design rather than by a gate divergence, so what is pinned instead is that the
   * 3D branch RECOGNISES the same pose 2D does: `bbFlowerAtIntakeMouth` with the ramp's own reach,
   * which is the one gate both halves share.
   */
  {
    const standoffs = [0, 0.5, 1.0, 1.5];
    let mismatches = 0;
    const detail: string[] = [];
    let rampGateMismatches = 0;
    const rampDetail: string[] = [];
    for (const kind of BB_INTAKE_KINDS) {
      for (const standoff of standoffs) {
        const archetype = { bbMech: { launcher: null, lift: null, intake: { kind } } as unknown as RobotSpec['bbMech'] };

        const w2 = mkWorld('free', 935, archetype);
        const r2 = w2.robots[0];
        r2.autoIntake = false;
        r2.hopper.length = 0;
        r2.lastIntakeAt = -10;
        if (kind === 'ramp') {
          r2.bbRampOut = true;
          r2.bbRampAt = -10; // long since settled
        }
        const f2 = BB_FLOWERS[F];
        // siderollers is edgeGrip now (owner, 2026-09-20): line ONE wheel up on the opening
        // rather than the centreline, or the pose never bites.
        const dy2 = kind === 'siderollers' ? sideRollerParkY(r2.spec) : 0;
        r2.pos = { x: f2.x + BB_PLACE_REACH + bbFootprint(r2.spec).front + standoff, y: f2.y - dy2 };
        r2.heading = Math.PI;
        const ballById2 = new Map(w2.balls.map((b) => [b.id, b] as const));
        const took2 = retrieveFromFlower(w2, w2.biobuzz!, r2, cmd({ intake: true }), true, ballById2, kindOfIn(w2));

        const w3 = mkWorld3d('free', 935, archetype);
        for (let t = 0; t < 90; t++) step3d(w3, 1 / 60, new Map()); // let the staged column settle
        const r3 = w3.robots[0];
        r3.autoIntake = false;
        r3.hopper.length = 0;
        r3.lastIntakeAt = -99;
        if (kind === 'ramp') {
          r3.bbRampOut = true;
          r3.bbRampAt = -10;
        }
        const f3 = BB_FLOWERS[F];
        const dy3 = kind === 'siderollers' ? sideRollerParkY(r3.spec) : 0;
        r3.pos = { x: f3.x + BB_PLACE_REACH + bbFootprint(r3.spec).front + standoff, y: f3.y - dy3 };
        r3.heading = Math.PI;
        const ballById3 = new Map(w3.balls.map((b) => [b.id, b] as const));
        const bottomId = w3.biobuzz!.flowers[F].stack[0];
        const took3 = flowerRetrieve3d(w3, w3.biobuzz!, r3, cmd({ intake: true }), true, ballById3, kindOfIn(w3));

        if (kind === 'ramp') {
          // the ONE-CALL comparison does not apply (see this block's own header) — instead, when
          // 2D takes it, the 3D call must at least have RECOGNISED the same pose: the stall clock
          // started on the flower's own bottom POLLEN, rather than the gate refusing outright.
          const recognised = bbFlowerAtIntakeMouth(r3, bbFlowerReachOf('ramp', true)!) !== null;
          void bottomId;
          if (took2 !== recognised) {
            rampGateMismatches++;
            rampDetail.push(`ramp@${standoff}in: 2D=${took2} 3D-recognised=${recognised}`);
          }
          continue;
        }

        if (took2 !== took3) {
          mismatches++;
          detail.push(`${kind}@${standoff}in: 2D=${took2} 3D=${took3}`);
        }
      }
    }
    check(
      "the ramp's 3D gate recognises every pose 2D would take (the stall clock starts, even though the call itself answers false)",
      rampGateMismatches === 0,
      rampGateMismatches === 0 ? '4/4 agree' : rampDetail.join(' · '),
    );
    check(
      'the 2D and 3D gate return the SAME verdict for the same 8 poses (sweeper + siderollers × 4 standoffs — ramp is checked separately above)',
      mismatches === 0,
      mismatches === 0 ? '8/8 agree' : detail.join(' · '),
    );
  }

  // ---- G410: a NECTAR entering while entry is locked is a MAJOR, per NECTAR -------------------
  //
  // The rule is a STATE predicate over `flowers[i].stack` (`penalties.ts`), so under the 3D tube
  // it fires on the tick `derive.ts` first reads the nectar as being in the tube — which IS
  // "entry into the scoring cylinder", asked of a real body rather than of a bookkeeping event.
  {
    const w = mkWorld3d('match', 940);
    w.balls.length = 0;
    // TELEOP with more than BB_FLOWER_UNLOCK_S left is exactly `bbNectarLocked` -- and it has to
    // be a LIVE phase, because `updateBiobuzzPenalties` clears its edge map and returns outside
    // one. A 'free' or pre-match world bills nothing at all, which is not the same as passing.
    w.match.phase = 'teleop';
    w.match.phaseTimeLeft = 90;
    const before = w.events.length;
    drop(w, F, 'nectar', 1);
    for (let t = 0; t < 200; t++) {
      w.match.phase = 'teleop';
      w.match.phaseTimeLeft = 90;
      step3d(w, 1 / 60, new Map());
    }
    const lines = w.events.slice(before).filter((e) => e.includes('G410'));
    check(
      'G410: a NECTAR entering a FLOWER before the 1:00 cue is billed, once, on entry',
      lines.length === 1,
      `${lines.length} lines: ${JSON.stringify(lines)}`,
    );
    check(
      'G410: the FLOWER still SCORES it — §10.5.2 says so and the penalty engine does not un-score',
      w.biobuzz!.flowers[F].stack.length === 1,
      `stack ${JSON.stringify(w.biobuzz!.flowers[F].stack)}`,
    );
  }

  // ---- placement: the Box Tube drops at the top ring, and nothing else changes -----------------
  {
    const w = mkWorld3d('free', 950);
    w.balls.length = 0;
    const rob = w.robots[0];
    // the Box Tube rides `spec.bbMech.lift`, the CONTAINER -- there is no flat `bbLift` field
    // (`mechs.ts`: "an absent container means no lift"), and setting one silently gives a robot
    // with no tube, which `placeInFlower` refuses on its first line.
    rob.spec = { ...rob.spec, bbMech: { ...rob.spec.bbMech!, lift: { kind: 'boxtube', mount: 'front' } } };
    const f = BB_FLOWERS[F];
    const local = bbPlacePointLocal(rob.spec)!;
    rob.heading = Math.PI;
    // put the PLACEMENT POINT on the ring: at heading pi the local +x offset lands at -x.
    rob.pos.x = f.x + local.x;
    rob.pos.y = f.y - local.y;
    rob.hopper = ['yellow'];
    w.balls.push({
      id: 1,
      color: 'yellow',
      state: { kind: 'held', robot: rob.id, slot: 0 },
      pos: { x: rob.pos.x, y: rob.pos.y },
      vel: { x: 0, y: 0 },
      z: 0,
      vz: 0,
      r: BB_POLLEN_R,
    } as Artifact);
    const placed = flowerPlace3d(w, w.biobuzz!, rob, false, kindOfIn(w));
    const el = w.balls[0];
    check(
      'placement drops the element AT THE TOP RING with zero velocity (plan §3.7)',
      placed && Math.abs(el.z + BB_POLLEN_R - FLOWER_RING_Z.top[0]) < 1e-6 && el.vz === 0,
      `placed=${placed} centre ${(el.z + BB_POLLEN_R).toFixed(4)} vs the top plate's underside ${FLOWER_RING_Z.top[0]}, vz ${el.vz}`,
    );
    for (let t = 0; t < 300; t++) step3d(w, 1 / 60, new Map());
    check(
      'a placed element then FALLS and seats where the bores let it — nothing parks it',
      w.biobuzz!.flowers[F].stack.length === 1 && el.z < 1,
      `stack ${JSON.stringify(w.biobuzz!.flowers[F].stack)}, z ${el.z.toFixed(3)}`,
    );

    /**
     * ⚠️ UNDER 3D, `b.z` IS THE BODY'S UNDERSIDE — INCLUDING FOR A FLOWER ELEMENT.
     *
     * `scene/renderElements.ts` draws a ball's CENTRE, and it gets it from `b.z + r` for every
     * ball a 3D world solves. It cannot be read headlessly (it poses an `InstancedMesh`), so the
     * convention is pinned here, at the data level, against the authority: the Rapier body's own
     * `translation().z`. The hazard is specifically the PARKED kinds, because the 2D pipeline
     * writes a CENTRE there (`play.ts` parks at `CELL_MID_Z`, `flowerStackZ` returns centre
     * heights) — so a renderer that branches on `state.kind` instead of on the PHYSICS draws one
     * of the two solves a radius wrong, and did: a flower element sunk 1.4–1.8 in into its stack.
     *
     * The tolerance is the READBACK's own quantum, not a fudge: `readback` writes
     * `b.z = round4(t.z - r)`, so the pair can legitimately disagree by half of 1e-4 and by
     * nothing more. A residual larger than that is a different convention, which is the failure
     * this check exists to catch.
     */
    {
      const engine = engineFor(w);
      const body = engine.elements.get(el.id);
      const t = body?.translation();
      const drawn = el.z + (el.r ?? BB_POLLEN_R);
      const resid = t ? Math.abs(drawn - t.z) : Infinity;
      check(
        'a 3D flower element: the DRAWN centre (b.z + r) is the body centre — one z convention per solve',
        !!t && resid <= 5e-5 + 1e-6,
        `drawn ${drawn.toFixed(6)} vs body ${t ? t.z.toFixed(6) : 'NO BODY'} — residual ${resid.toExponential(2)} (readback rounds to 1e-4)`,
      );
    }
  }

  // ---- THE COLUMN IS A PILE, NOT A COMPUTED STACK (owner item 9) ------------------------------
  //
  // The owner's requirement is that elements in a FLOWER "rest on whatever is below them at
  // whatever height that turns out to be, with real contact" — so these checks ask about the
  // heights the bodies ARRIVE at, not about a rule. Everything below is one tube, filled one
  // element at a time the way a Box Tube fills it, then left to settle.
  {
    const cols = (i: number, n: number, seed: number): { w: World; ids: number[]; cs: number[]; gaps: number[] } => {
      const w = mkWorld3d('free', seed);
      w.balls.length = 0;
      for (let k = 0; k < n; k++) {
        drop(w, i, 'pollen', k + 1);
        for (let t = 0; t < 90; t++) step3d(w, 1 / 60, new Map()); // one at a time, as a robot places them
      }
      for (let t = 0; t < 600; t++) step3d(w, 1 / 60, new Map());
      const ids = [...w.biobuzz!.flowers[i].stack];
      const cs = realZ(w, ids);
      return { w, ids, cs, gaps: cs.slice(1).map((z, k) => z - cs[k]) };
    };
    const PITCH = 2 * BB_POLLEN_R; // the ideal centre-to-centre of two touching POLLEN, 2.800

    {
      const { ids, cs, gaps } = cols(F, 4, 960);
      const worst = PITCH - Math.min(...gaps);
      const spread = Math.max(...gaps) - Math.min(...gaps);
      const model = flowerStackZ(ids, () => 'pollen');
      console.log(
        `[smoke-bb flower3d] 4 POLLEN settle at centres [${cs.map((z) => z.toFixed(4)).join(', ')}] · ` +
          `gaps [${gaps.map((z) => z.toFixed(4)).join(', ')}] against the ideal ${PITCH} · worst overlap ${worst.toFixed(4)}in · ` +
          `the 2D MODEL would put them at [${model.map((z) => z.toFixed(4)).join(', ')}]`,
      );
      /**
       * A PILE has UNEQUAL gaps and a computed stack has identical ones, and that is the
       * cheapest honest way to tell them apart. Penetration under a soft contact is
       * load-proportional — the bottom pair carries three balls, the top pair carries one — so
       * the gaps widen going up by construction. Measured today: 2.7355 / 2.7565 / 2.7784, a
       * spread of 0.043 in. Raising the contact stiffness shrinks the spread along with the
       * overlap (at the old shared 12 Hz the same column spread 0.270 in), so the bound is
       * deliberately small — 0.005 in, ~50x the readback's own 1e-4 rounding and well under
       * anything a further stiffening would plausibly leave. It is asking "did anything COMPUTE
       * these", not "is the solver still as soft as it was".
       */
      check(
        'a 4-POLLEN column is a PHYSICAL pile — the gaps are load-proportional, not one pitch',
        gaps.length === 3 && spread > 0.005,
        `gaps [${gaps.map((z) => z.toFixed(4)).join(', ')}], spread ${spread.toFixed(4)}in`,
      );
      check(
        'no element FLOATS: every gap is at or under the touching pitch, and the column is ordered',
        gaps.every((g) => g <= PITCH + 1e-3) && gaps.every((g) => g > 0),
        `gaps [${gaps.map((z) => z.toFixed(4)).join(', ')}] against ${PITCH}`,
      );
      /**
       * ⚠️ AND IT IS NOT THE 2D MODEL'S COLUMN. This is the check that fails the day somebody
       * re-seats a 3D flower element from `flowerStackZ` — the Day 1 behaviour the tube replaced,
       * and the one the owner's item 9 is about.
       *
       * The bound is on the BOTTOM element, because that difference is STRUCTURAL and does not
       * move with the contact stiffness: the 2D model seats its column on a 0.43-in floor
       * constant and puts the first POLLEN's centre at 1.754, while the real tube drops it
       * through the 3.222 lower bore onto the TILES at 1.389. Measured 0.365 in, at 12 Hz and at
       * 30 Hz alike. The differences higher up the column DO shrink as the contacts stiffen
       * (1.177 in at the top at 12 Hz, 0.495 at 30), which is why they are not what is asserted.
       */
      check(
        'the 3D column does NOT sit at the 2D model heights — no path re-seats it (owner item 9)',
        cs.length === model.length && Math.abs(cs[0] - model[0]) > 0.2,
        `real [${cs.map((z) => z.toFixed(3)).join(', ')}] vs model [${model.map((z) => z.toFixed(3)).join(', ')}] ` +
          `(bottom differs by ${Math.abs(cs[0] - model[0]).toFixed(4)}in: the model's 0.43 floor against the tiles)`,
      );
    }

    {
      /**
       * AT CAPACITY, because penetration is load-proportional and a 4-stack hides two thirds of
       * it. `flowerCapacity('pollen')` is the FLOWER's own POLLEN limit.
       *
       * ⚠️ **THE BOUND IS A RATCHET ON `BB3_CONTACT_FREQ`, WHICH IS WHAT FIXED THIS.** The 3D
       * world used to inherit the shared `PHYS_CONTACT_FREQ` (12 Hz) — the 2D DECODE robot
       * world's value, and far too compliant for a stacked column: an 8-high column's worst gap
       * was 1.939, i.e. 0.948 in of overlap, a THIRD of a diameter, and that is what the owner
       * was looking at. Measured sweep of that one parameter, worst overlap 4-stack / 8-stack:
       * 12 → 0.406 / 0.948; 20 → 0.146 / 0.341; 30 → 0.065 / 0.152; 45 → 0.029 / 0.068. At the
       * 30 Hz now in `config.ts` an 8-high column overlaps by less than a SIXTEENTH of a
       * diameter. The bound is set just above that, so a regression of the constant — or a
       * second solver parameter quietly undoing it — fails here with the number in the message.
       */
      const OVERLAP_MAX = 0.2;
      const cap = flowerCapacity('pollen');
      const { w, ids, cs, gaps } = cols(F, cap, 961);
      const worst = PITCH - Math.min(...gaps);
      const top = cs.length > 0 ? cs[cs.length - 1] + BB_POLLEN_R : 0;
      console.log(
        `[smoke-bb flower3d] ${cap} POLLEN (the FLOWER's POLLEN capacity) settle at gaps ` +
          `[${gaps.map((z) => z.toFixed(4)).join(', ')}] · worst overlap ${worst.toFixed(4)}in of ${PITCH} · ` +
          `column tops out at ${top.toFixed(3)} against the top plate's ${BB_FLOWER_TOP_Z}`,
      );
      check(
        `a column at CAPACITY (${cap} POLLEN) is stacked, not interpenetrating — worst overlap under ${OVERLAP_MAX}in`,
        ids.length === cap && worst < OVERLAP_MAX,
        `${ids.length}/${cap} in the stack, worst gap ${Math.min(...gaps).toFixed(4)} of ${PITCH} (overlap ${worst.toFixed(4)}in)`,
      );
      check(
        `a column at CAPACITY stays in the tube and stays ordered bottom to top`,
        ids.every((id, k) => flowerTubeOf(w.balls.find((b) => b.id === id)!.pos.x, w.balls.find((b) => b.id === id)!.pos.y, cs[k]) === F) &&
          cs.every((z, k) => k === 0 || z > cs[k - 1]),
        `centres [${cs.map((z) => z.toFixed(3)).join(', ')}]`,
      );
    }

    /**
     * THE PHYSICS HALF OF OWNER ITEM 2 — "near the flower, the pollen sometimes digs into the
     * ground". It does not: nothing here sinks and nothing is being quietly put back. The bound
     * is the solver's own resting allowance, `PHYS_ALLOWED_ERROR * PHYS_LENGTH_UNIT` = 0.1 in,
     * the same one the 2D robot world lets a resting contact sit inside. Measured today: a lone
     * POLLEN bottoms at −0.0027 in every one of the four tubes, the bottom of a 4-column at
     * −0.0109, the bottom of an 8-column at −0.0217, and `containmentFixes` is 0 throughout — so
     * the safety net is not hiding this either. The DRAWING is where the inch and a half went
     * (`scene/renderElements.ts`), and this check is what pins the physics under that fix.
     */
    {
      const FLOOR = -PHYS_ALLOWED_ERROR * PHYS_LENGTH_UNIT;
      let ok = true;
      let fixes = 0;
      const detail: string[] = [];
      for (let i = 0; i < BB_FLOWERS.length; i++) {
        const { w, ids } = cols(i, 4, 970 + i);
        fixes += engineFor(w).containmentFixes;
        for (const id of ids) {
          const b = w.balls.find((x) => x.id === id)!;
          if (b.z < FLOOR) ok = false;
        }
        detail.push(`F${i} bottom ${w.balls.find((x) => x.id === ids[0])!.z.toFixed(4)}`);
      }
      check(
        `a settled FLOWER element never goes under the tiles, in any of the four tubes (owner item 2)`,
        ok && fixes === 0,
        `${detail.join(' · ')} against a floor of ${FLOOR}; containmentFixes ${fixes}`,
      );
    }

    /**
     * G418's INTENT, asked of the real bodies: a NECTAR cannot leave through the bottom.
     *
     * ⚠️ **THE MIDDLE RING HOLDS IT, AND THE LOWER ONE NEVER HAD.** Seating a 3.6-in sphere in
     * the 3.222-in lower bore would put its centre `sqrt(1.8² − 1.611²)` = 0.803 above that
     * plate's top face (0.354), its BOTTOM at −0.643, under the tiles. So before the middle ring's
     * NECTAR lip it came to rest ON THE TILES, in the retrieval opening, where a deployed ramp's
     * blade lifted it out over a 0.354-in lip (owner, 2026-09-24). It now stays on the middle
     * ring, all of it above the opening's top (`BB_FLOWER_RETRIEVE_Z[1]`), in every tube.
     */
    {
      const seatInBore = BB_FLOWER_LOW_Z + Math.sqrt(BB_NECTAR_R * BB_NECTAR_R - (BB_FLOWER_LOW_HOLE / 2) ** 2);
      const rows: string[] = [];
      let ok = true;
      for (let i = 0; i < BB_FLOWERS.length; i++) {
        const w = mkWorld3d('free', 980 + i);
        w.balls.length = 0;
        const el = drop(w, i, 'nectar', 1);
        for (let t = 0; t < 600; t++) step3d(w, 1 / 60, new Map());
        if (!(el.z >= BB_FLOWER_RETRIEVE_Z[1] - 0.1) || w.biobuzz!.flowers[i].stack[0] !== 1) ok = false;
        rows.push(`F${i} bottom ${el.z.toFixed(3)}`);
        disposeEngineFor(w);
      }
      check(
        '⚠️ a NECTAR is held on the MIDDLE ring, above the retrieval opening, in all four tubes (G418)',
        ok,
        `${rows.join(' · ')} against the opening's top ${BB_FLOWER_RETRIEVE_Z[1]}; the lower bore alone would ` +
          `seat it at bottom ${(seatInBore - BB_NECTAR_R).toFixed(3)}, under the tiles`,
      );
    }
  }

  // ---- the STAGED column, and the one line of it that the 2D pipeline owns ---------------------
  //
  // `spawn.ts`'s `flowerStack()` seeds four POLLEN per FLOWER through `flowerStackZ`, which
  // returns CENTRE heights — the documented exception to "`b.z` is the element's BOTTOM". That is
  // correct for the 2D pipeline and it is PERMANENT, so the 2D half below is a byte-identity
  // guard, not a measurement.
  {
    const w2 = createBiobuzzWorld('free', 7, [setup(0, 'blue')]);
    const staged2 = w2.balls.filter((b) => b.state.kind === 'element' && b.state.el === `flower:${F}`);
    const model = flowerStackZ(staged2.map((b) => b.id), () => 'pollen');
    check(
      "a 2D world still seeds the staged column at exactly `flowerStackZ` — the permanent pipeline",
      staged2.length === model.length && staged2.every((b, k) => b.z === model[k]),
      `seeded [${staged2.map((b) => b.z.toFixed(4)).join(', ')}] vs flowerStackZ [${model.map((z) => z.toFixed(4)).join(', ')}]`,
    );

    const w3 = createBiobuzzWorld('free', 7, [setup(0, 'blue')], undefined, '3d');
    const born = w3.balls
      .filter((b) => b.state.kind === 'element' && b.state.el === `flower:${F}`)
      .map((b) => b.z + (b.r ?? BB_POLLEN_R));
    for (let t = 0; t < 600; t++) step3d(w3, 1 / 60, new Map());
    const ids = [...w3.biobuzz!.flowers[F].stack];
    const cs = realZ(w3, ids);
    console.log(
      `[smoke-bb flower3d] the STAGED column in 3D is BORN at centres [${born.map((z) => z.toFixed(4)).join(', ')}] ` +
        `and settles at [${cs.map((z) => z.toFixed(4)).join(', ')}] — a ${(born[0] - cs[0]).toFixed(3)}in fall over the first second ` +
        `of every 3D match, because the seed is a 2D CENTRE and \`syncElement\` builds the body at \`b.z + r\``,
    );
    /**
     * The 3D half asserts the OUTCOME rather than the seed, because the seed is `spawn.ts`'s and
     * the fix for it (a 3D-only `b.z -= r` re-seat inside `createBiobuzzWorld`'s existing
     * `physics === '3d'` gate) belongs in that file. Whatever height they are born at, the
     * staged column has to end up a settled physical pile inside the tube like any other — which
     * is what makes the birth height a cosmetic problem rather than a scoring one.
     */
    check(
      'the STAGED column settles into a physical pile inside the tube, whatever height it is born at',
      ids.length === 4 &&
        cs.every((z, k) => k === 0 || z > cs[k - 1]) &&
        w3.balls.find((b) => b.id === ids[0])!.z >= -PHYS_ALLOWED_ERROR * PHYS_LENGTH_UNIT &&
        cs.slice(1).some((z, k) => Math.abs(z - cs[k] - 2 * BB_POLLEN_R) > 0.005),
      `settled [${cs.map((z) => z.toFixed(4)).join(', ')}], bottom ${w3.balls.find((b) => b.id === ids[0])!.z.toFixed(4)}`,
    );

    /**
     * ⚠️ **AND THE 2D STAGING IS BYTE-IDENTICAL, WHICH IS THE OTHER HALF OF THE `'3d'` GATE.**
     * The check above this block already pins the staged `z` against `flowerStackZ`; this one
     * pins the x/y, because that is what the scatter touches. `world.rngState` is the scatter's
     * MIX and is never advanced, so the chain is asserted too — staging has always taken zero
     * draws and still does.
     */
    const w2b = createBiobuzzWorld('free', 7, [setup(0, 'blue')]);
    const flat = w2b.balls.filter((b) => b.state.kind === 'element' && String(b.state.el).startsWith('flower:'));
    check(
      'a 2D world stages every FLOWER element DEAD ON the bore axis, and takes no draw doing it',
      flat.length === 16 &&
        flat.every((b) => {
          const i = Number(String((b.state as { el: string }).el).slice('flower:'.length));
          return b.pos.x === BB_FLOWERS[i].x && b.pos.y === BB_FLOWERS[i].y;
        }) &&
        w2b.rngState === w2.rngState,
      `${flat.length} staged, max |dxy| ${Math.max(
        ...flat.map((b) => {
          const i = Number(String((b.state as { el: string }).el).slice('flower:'.length));
          return Math.hypot(b.pos.x - BB_FLOWERS[i].x, b.pos.y - BB_FLOWERS[i].y);
        }),
      ).toExponential(1)}; rngState ${w2b.rngState}`,
    );
  }

  flowerCageChecks(check);
  flowerScatterChecks(check);
  flowerStagedScatterChecks(check);
  flowerChassisChecks(check);
}

/**
 * A CHASSIS DRIVEN INTO A FLOWER STAYS ON THE TILES AND CAN ALWAYS DRIVE AWAY (`groups.ts`,
 * `GROUP_FLOWER_LOWER_RING`). The lower ring plate is a 0.354-in trimesh on the tiles; a chassis
 * that met it was lifted onto it and could be left hanging there level, wheels off the floor,
 * against the middle plate. No chassis meets the lower plate now, and the middle plate, whose
 * footprint contains it, still stops every one.
 */
function flowerChassisChecks(check: Check): void {
  const inward = (i: number): { x: number; y: number } => {
    const wall = BB_FLOWERS[i].wall;
    return wall === 'left' ? { x: 1, y: 0 } : wall === 'right' ? { x: -1, y: 0 } : wall === 'rear' ? { x: 0, y: -1 } : { x: 0, y: 1 };
  };
  /** a robot facing FLOWER `i` from 6 in clear of its plates, `lat` in along the wall, turned `angDeg` */
  const facing = (w: World, i: number, angDeg: number, lat: number): RobotState => {
    const f = BB_FLOWERS[i];
    const n = inward(i);
    const r = w.robots[0];
    const d = 2.5 + Math.max(r.spec.length, r.spec.width) / 2 + 2 + 6;
    r.pos = { x: f.x + n.x * d - n.y * lat, y: f.y + n.y * d + n.x * lat };
    r.heading = Math.atan2(-n.y, -n.x) + (angDeg * Math.PI) / 180;
    r.vel = { x: 0, y: 0 };
    r.angVel = 0;
    r.autoIntake = false;
    r.autoFire = false;
    return r;
  };

  // ---- square drive-ins with one side of the chassis over the plate's edge: never lifted -------
  // MEASURED before the fix: every one of these twelve rode up onto the lower plate, z 0.28–0.67.
  {
    let worst = 0;
    let where = '';
    let k = 0;
    for (let i = 0; i < BB_FLOWERS.length; i++) {
      for (const [ang, lat] of [
        [0, -9],
        [0, 8],
        [-10, 3],
      ]) {
        const w = mkWorld3d('free', 9300 + k++);
        w.balls.length = 0;
        const r = facing(w, i, ang, lat);
        step3d(w, 1 / 60, new Map());
        const c = new Map([[0, cmd({ driveY: 1, leftDrive: 1, rightDrive: 1 })]]);
        for (let t = 0; t < 120; t++) {
          step3d(w, 1 / 60, c);
          if ((r.z ?? 0) > worst) {
            worst = r.z ?? 0;
            where = `F${i + 1} ang ${ang} lat ${lat} t=${t}`;
          }
        }
        disposeEngineFor(w);
      }
    }
    check(
      'a chassis driven into a FLOWER is never lifted onto its lower ring plate (4 flowers x 3 approaches)',
      worst <= 0.05,
      `worst chassis z ${worst.toFixed(3)} in${where ? ` at ${where}` : ''}`,
    );
  }

  // ---- the drive that parked a Forager on the lower plate for good: it can leave --------------
  // Found by `scratch/flowersweep.ts`: a slow approach to F4 with a wiggle ended at z 0.34 beside
  // the plates, and 4 s of full drive, strafe and turn moved it 0.004 in.
  {
    const w = mkWorld3d('free', 9956, BB_PRESETS[1]);
    w.balls.length = 0;
    const r = facing(w, 3, -10, 8);
    step3d(w, 1 / 60, new Map());
    for (let t = 0; t < 180; t++) {
      const ph = t / 60;
      const ro = t > 60 ? Math.sin(ph * 9) : 0;
      const c = t > 60 ? { driveY: 0.4, driveX: Math.cos(ph * 7), rotate: ro, leftDrive: 0.4 - ro, rightDrive: 0.4 + ro } : { driveY: 0.4, leftDrive: 0.4, rightDrive: 0.4 };
      step3d(w, 1 / 60, new Map([[0, cmd(c)]]));
    }
    const parkedZ = r.z ?? 0;
    const x0 = r.pos.x;
    const y0 = r.pos.y;
    const h0 = r.heading;
    let moved = 0;
    let turned = 0;
    for (const c of [
      { driveY: -1, leftDrive: -1, rightDrive: -1 },
      { driveY: 1, leftDrive: 1, rightDrive: 1 },
      { driveX: 1 },
      { driveX: -1 },
      { rotate: 1, leftDrive: -1, rightDrive: 1 },
      { rotate: -1, leftDrive: 1, rightDrive: -1 },
    ]) {
      for (let t = 0; t < 40; t++) {
        step3d(w, 1 / 60, new Map([[0, cmd(c)]]));
        moved = Math.max(moved, Math.hypot(r.pos.x - x0, r.pos.y - y0));
        turned = Math.max(turned, Math.abs(r.heading - h0));
      }
    }
    disposeEngineFor(w);
    check(
      'a Forager driven slowly into F4 with a wiggle is not left hanging on the lower ring plate — it drives away',
      parkedZ <= 0.05 && moved > 1,
      `z ${parkedZ.toFixed(3)} after the drive-in; then moved ${moved.toFixed(2)} in, turned ${((turned * 180) / Math.PI).toFixed(1)} deg`,
    );
  }

  // ---- a robot SHOVED into a FLOWER stays on the tiles ----------------------------------------
  // A Forager at full power pins another into the plates. MEASURED before: the trimesh lifted the
  // victim onto the lower plate (z 0.35 and 0.69 here); with only the lower plate taken away the
  // middle plate's top face pushed it 1.15 in down into the tiles instead. The solid boxes do
  // neither (`scratch/shove.ts`, 1,472 legal shoves: 0 lifted, 0 sunk).
  {
    let worst = 0;
    let where = '';
    for (const [vi, i, ang, lat] of [
      [1, 0, 30, -6],
      [0, 1, 150, 8],
    ]) {
      const w = mkWorld3dPair('free', 9400 + vi, BB_PRESETS[vi], BB_PRESETS[1]);
      w.balls.length = 0;
      const f = BB_FLOWERS[i];
      const n = inward(i);
      const [a, b] = w.robots;
      const ha = Math.max(a.spec.length, a.spec.width) / 2 + 3.5;
      a.pos = { x: f.x + n.x * (2.5 + ha) - n.y * lat, y: f.y + n.y * (2.5 + ha) + n.x * lat };
      a.heading = Math.atan2(n.y, n.x) + (ang * Math.PI) / 180;
      const hb = Math.max(b.spec.length, b.spec.width) / 2 + 1;
      b.pos = { x: a.pos.x + n.x * (ha + hb + 2), y: a.pos.y + n.y * (ha + hb + 2) };
      b.heading = Math.atan2(-n.y, -n.x);
      for (const r of [a, b]) {
        r.vel = { x: 0, y: 0 };
        r.angVel = 0;
        r.autoIntake = false;
        r.autoFire = false;
      }
      step3d(w, 1 / 60, new Map());
      const c = new Map([[1, cmd({ driveY: 1, leftDrive: 1, rightDrive: 1 })]]);
      for (let t = 0; t < 180; t++) {
        step3d(w, 1 / 60, c);
        if (Math.abs(a.z ?? 0) > Math.abs(worst)) {
          worst = a.z ?? 0;
          where = `victim ${BB_PRESETS[vi].name} at F${i + 1} ang ${ang} lat ${lat} t=${t}`;
        }
      }
      disposeEngineFor(w);
    }
    check(
      'a robot shoved into a FLOWER by a Forager is neither lifted onto a plate nor pushed into the tiles',
      Math.abs(worst) <= 0.05,
      `worst victim z ${worst.toFixed(3)} in${where ? ` (${where})` : ''}`,
    );
  }
}

/**
 * THE PRE-MATCH STAGED COLUMNS, which in a `'3d'` world are scattered too (`spawn.ts`'s
 * `flowerStack`). They are the FIRST four columns a driver sees every match, so "the balls stack
 * too perfectly" is not answered by fixing the PLACED path alone — and a staged element is not
 * dropped, it is created at a modelled height inside the tube, so the bound has to hold at that
 * height rather than only at the top ring. It is the same `bbFlowerDropSlack` either way.
 */
function flowerStagedScatterChecks(check: Check): void {
  const staged = (seed: number): World => createBiobuzzWorld('free', seed, [setup(0, 'blue', REACHING)], undefined, '3d');
  const cols = (w: World, i: number) => {
    const f = BB_FLOWERS[i];
    return w.balls
      .filter((b) => b.state.kind === 'element' && b.state.el === `flower:${i}`)
      .map((b) => ({ id: b.id, c: b.z + BB_POLLEN_R, d: Math.hypot(b.pos.x - f.x, b.pos.y - f.y) }))
      .sort((a, b) => a.c - b.c);
  };
  const dump = (w: World) =>
    JSON.stringify(
      w.balls
        .filter((b) => b.state.kind === 'element' && String(b.state.el).startsWith('flower:'))
        .map((b) => [b.id, b.pos.x, b.pos.y]),
    );

  {
    const w = staged(7);
    const bornD = [0, 1, 2, 3].flatMap((i) => cols(w, i).map((r) => r.d));
    for (let t = 0; t < 400; t++) step3d(w, 1 / 60, new Map());
    const after = [0, 1, 2, 3].map((i) => cols(w, i));
    console.log(
      `[smoke-bb flower3d] STAGED in 3D: born off-axis [${bornD.map((d) => d.toFixed(3)).join(', ')}] · ` +
        `settled ${after.map((c, i) => `F${i} ${c.length}@[${c.map((r) => r.c.toFixed(2)).join(',')}]`).join(' ')}`,
    );
    check(
      'a 3D world STAGES its FLOWER columns off the bore axis — the first four columns of a match are not perfect stacks either',
      bornD.length === 16 && bornD.every((d) => d > 0) && Math.max(...bornD) <= BB3_FLOWER_SCATTER_FRAC * bbFlowerDropSlack(BB_POLLEN_R) + 1e-9,
      `${bornD.filter((d) => d > 0).length}/16 off-axis, max ${Math.max(...bornD).toFixed(4)} of a ${(BB3_FLOWER_SCATTER_FRAC * bbFlowerDropSlack(BB_POLLEN_R)).toFixed(4)} bound`,
    );
    /**
     * ⚠️ AND NOTHING IS EJECTED. A staged element is BORN at a modelled height with its body
     * built a radius higher (`syncElement` reads `b.z + r`), so the bottom one starts inside the
     * z band the peanut supports occupy — the exact profile that threw a 0.411-in wall-side drop
     * 8–28 in clear of the flower. All sixteen have to still be in their own tube after the fall,
     * or `derive.ts` hands the HUD and §10.5.2 a short column on tick 1.
     */
    check(
      'every STAGED element is still in its own tube after the fall — membership intact from tick 1',
      after.every((c) => c.length === 4 && c.every((r, k) => k === 0 || r.c > c[k - 1].c)),
      after.map((c, i) => `F${i}:${c.length}`).join(' '),
    );
  }

  check(
    'the STAGED scatter is deterministic: one seed twice is byte-identical, and another seed is not',
    dump(staged(7)) === dump(staged(7)) && dump(staged(7)) !== dump(staged(8)),
    `same-seed identical=${dump(staged(7)) === dump(staged(7))}, cross-seed differs=${dump(staged(7)) !== dump(staged(8))}`,
  );

  // and a staged column still drains dry through the REAL retrieval
  {
    const w = staged(9);
    for (let t = 0; t < 400; t++) step3d(w, 1 / 60, new Map());
    const f0 = BB_FLOWERS[0];
    const rob = w.robots[0];
    // RE-PARKED every attempt, and moved CLEAR OF THE TUBE while it settles — see `placeDrain`'s
    // comment on why.
    const park = (): void => {
      rob.pos.x = f0.x + BB_PLACE_REACH + bbFootprint(rob.spec).front;
      rob.pos.y = f0.y - sideRollerParkY(rob.spec); // one wheel on the opening (edgeGrip)
      rob.heading = Math.PI;
      rob.vel = { x: 0, y: 0 };
      rob.angVel = 0;
    };
    const clear = (): void => {
      rob.pos = { x: -50, y: -50 };
      rob.heading = 0;
      rob.vel = { x: 0, y: 0 };
      rob.angVel = 0;
    };
    clear();
    // see `placeDrain`'s comment: 400 ticks of settle, a plain `break` on refusal.
    for (let p = 0; p < 6; p++) {
      park();
      rob.hopper.length = 0;
      rob.lastIntakeAt = -99;
      const byId = new Map(w.balls.map((b) => [b.id, b] as const));
      const took = flowerRetrieve3d(w, w.biobuzz!, rob, cmd({ intake: true }), true, byId, kindOfIn(w));
      if (took) sweepIntoHopper(w, rob);
      clear();
      if (!took) break;
      for (let t = 0; t < 400; t++) step3d(w, 1 / 60, new Map());
    }
    check(
      'a STAGED column drains dry through the real retrieval',
      w.biobuzz!.flowers[0].stack.length === 0,
      `${w.biobuzz!.flowers[0].stack.length} left at [${cols(w, 0).map((r) => r.c.toFixed(2)).join(', ')}]`,
    );
  }
}

// =============================================================================================
// THE CAGE AND THE SCATTER (owner reports: "POLLEN get stuck in a flower instead of dropping"
// and "placing balls in a flower is too uniform" — one geometry fix and one placement fix,
// because the SECOND is only safe once the FIRST is in; see `flower3d.ts`'s header).
// =============================================================================================

/** the four HIPS pipes of flower `i`, as their own xy extent about the tube axis. */
function pipeReach(i: number): { inner: number; outerFace: number } {
  const f = BB_FLOWERS[i];
  let inner = Infinity;
  let outerFace = 0;
  for (const s of cadStatics()) {
    if (!s.name.startsWith(`flower_${i}_`) || !s.name.includes('hips_pipe')) continue;
    let far = 0;
    for (let k = 0; k < s.points.length; k += 3) {
      const d = Math.hypot(s.points[k] - f.x, s.points[k + 1] - f.y);
      inner = Math.min(inner, d);
      // the pipe's own outermost FACE along each axis — what a flat chassis face meets first
      far = Math.max(far, Math.abs(s.points[k] - f.x), Math.abs(s.points[k + 1] - f.y));
    }
    outerFace = outerFace === 0 ? far : Math.min(outerFace, far);
  }
  return { inner, outerFace };
}

function flowerCageChecks(check: Check): void {
  /**
   * THE MEASUREMENT THAT MADE THE CAGE NECESSARY, pinned so a future CAD revision that closes
   * the gap on its own (or opens it further) is seen rather than assumed. The pipes are round
   * posts at the four diagonals: their inner tangent circle is the only thing between the mid
   * plate and the top plate, and the four gaps between them are open air.
   */
  {
    const { inner, outerFace } = pipeReach(F);
    const rings = cadFlowerRings(F);
    const band = flowerCageBand(rings);
    console.log(
      `[smoke-bb flower3d] the HIPS pipes' inner tangent circle is ${inner.toFixed(3)} from the tube axis and their ` +
        `outermost face ${outerFace.toFixed(3)}; the cage spans z [${band ? band.map((z) => z.toFixed(3)).join(', ') : 'NONE'}] ` +
        `with its faces on r ${FLOWER_CAGE_R.toFixed(3)}, as one ${BB3_FLOWER_CAGE_SEGMENTS}-sided trimesh prism ${BB3_FLOWER_CAGE_T}in thick`,
    );
    /** the tolerance is not slack: `FLOWER_RING_Z` is the four-flower MEAN the generated dims
     * carry, and each plate's exported band is its OWN measurement — they agree to ~1e-4. */
    check(
      'the CAGE spans exactly the open run between the MID plate and the TOP plate',
      !!band && Math.abs(band[0] - FLOWER_RING_Z.mid[1]) < 0.01 && Math.abs(band[1] - FLOWER_RING_Z.top[0]) < 0.01,
      `[${band ? band.map((z) => z.toFixed(4)).join(', ') : 'NONE'}] vs the constants' [${FLOWER_RING_Z.mid[1]}, ${FLOWER_RING_Z.top[0]}]`,
    );
    /**
     * ⚠️ THE CAGE CANNOT STOP ANYTHING, and this is the check that says so rather than the
     * comment. Its radius IS the middle bore, an aperture every element above that plate has
     * already passed, so a NECTAR keeps the same 0.148 in of clearance it had coming through.
     */
    check(
      'the CAGE is the MIDDLE BORE extended upward — it is an aperture every element in the tube has already cleared',
      Math.abs(FLOWER_CAGE_R - BB_FLOWER_MID_HOLE / 2) < 1e-12 && FLOWER_CAGE_R - BB_NECTAR_R > 0.1,
      `cage r ${FLOWER_CAGE_R.toFixed(4)} = mid bore ${(BB_FLOWER_MID_HOLE / 2).toFixed(4)}; a NECTAR keeps ${(FLOWER_CAGE_R - BB_NECTAR_R).toFixed(4)}in of slack`,
    );
    /**
     * ⚠️ AND IT MUST NOT PRESENT THE FIELD A SURFACE THE PIPES DO NOT ALREADY PRESENT, or a
     * robot's reach onto a flower moves — `BB_PLACE_REACH` (a chassis flush on the foot) is the
     * number that would change. See `BB3_FLOWER_CAGE_T`'s header.
     */
    // ⚠️ THE POLYGON'S VERTEX, NOT ITS FACE. The cage is CIRCUMSCRIBED (faces on
    // `FLOWER_CAGE_R`, vertices `1/cos(π/N)` further out), so its furthest point from the axis is
    // `cageVertexR() + BB3_FLOWER_CAGE_T` — and it is the face distance, not that, which looks
    // reassuring. The fan this started as read a safe 2.198 at the face and 2.330 at the corner,
    // i.e. 0.125 in PAST the pipe a robot meets today. See `BB3_FLOWER_CAGE_T`.
    const corner = cageVertexR() + BB3_FLOWER_CAGE_T;
    let worstPipe = Infinity;
    for (let i = 0; i < BB_FLOWERS.length; i++) worstPipe = Math.min(worstPipe, pipeReach(i).outerFace);
    check(
      'the CAGE stays inside the pipes the field already meets, and inside a chassis flush on the foot',
      corner < worstPipe && corner < BB_PLACE_REACH,
      `cage vertex ${corner.toFixed(3)} (faces on ${FLOWER_CAGE_R.toFixed(3)}) vs the pipes' ${worstPipe.toFixed(3)} and BB_PLACE_REACH ${BB_PLACE_REACH.toFixed(3)}`,
    );
  }

  /**
   * THE JAM ITSELF, reproduced and then not reproduced. A settled column given a seeded lateral
   * kick used to arch on the open span: measured over 24 seeds per row, 10/24 at n = 4 and
   * 22–24/24 at n = 7 left an element hanging above an empty tube at centres 9.07 / 10.59 /
   * 12.80, with 1.52 in between the lowest pair where 2.80 is the touching pitch, and the
   * retrieval then refused for the rest of the match. With the cage it is 0/360 across
   * n ∈ {2,4,7} × kick ∈ {1,3,6,12,25} × 24 seeds (`scratch/flowerperturb.ts`); the lane runs a
   * representative corner of that sweep.
   */
  {
    const jams: string[] = [];
    for (const n of [4, 7]) {
      for (const seed of [12003]) {
        const w = mkWorld3d('free', seed + n);
        w.balls.length = 0;
        w.robots[0].pos.x = 0;
        w.robots[0].pos.y = 0;
        for (let k = 0; k < n; k++) {
          drop(w, F, 'pollen', k + 1);
          for (let t = 0; t < 60; t++) step3d(w, 1 / 60, new Map());
        }
        for (let t = 0; t < 200; t++) step3d(w, 1 / 60, new Map());
        // a seeded lateral kick on every element — the disturbance a robot driving into a flower
        // (or an element landing on the column) delivers, without needing one in the fixture.
        let st = (seed * 2654435761) | 0;
        for (const b of w.balls) {
          const a = (st = (Math.imul(st, 1103515245) + 12345) | 0);
          const ang = ((a >>> 0) / 4294967296) * 2 * Math.PI;
          b.vel.x = Math.cos(ang) * 12;
          b.vel.y = Math.sin(ang) * 12;
        }
        for (let t = 0; t < 400; t++) step3d(w, 1 / 60, new Map());
        // drain it bodilessly from the bottom — the same order `flowerRetrieve3d` pops in,
        // without a robot in the fixture to confuse the cause.
        for (let p = 0; p < n + 2; p++) {
          const stk = w.biobuzz!.flowers[F].stack;
          if (stk.length === 0) break;
          const b = w.balls.find((x) => x.id === stk[0])!;
          if (b.z + BB_POLLEN_R > BB_FLOWER_RETRIEVE_Z[1]) break; // a real retrieval refuses this
          b.state = { kind: 'stock' };
          w.biobuzz!.flowers[F].stack = stk.slice(1);
          for (let t = 0; t < 120; t++) step3d(w, 1 / 60, new Map());
        }
        const left = w.biobuzz!.flowers[F].stack.length;
        if (left > 0) jams.push(`n=${n} seed=${seed}: ${left} left at [${realZ(w, w.biobuzz!.flowers[F].stack).map((z) => z.toFixed(2)).join(', ')}]`);
      }
    }
    check(
      'a DISTURBED column still drains to the bottom — the cage is what stops a pair arching across the bore',
      jams.length === 0,
      jams.length === 0 ? '2 kicked columns, all emptied' : jams.join(' · '),
    );
  }
}

/** a world whose robot's Box Tube is on flower F's ring with `n` elements in the hopper. */
function placeRig(seed: number, n: number, nectarFirst: boolean): World {
  const w = mkWorld3d('free', seed);
  w.balls.length = 0;
  const f = BB_FLOWERS[F];
  const rob = w.robots[0];
  // the Box Tube PLACES (unaffected by the intake archetype); `placeDrain` below RETRIEVES
  // through the same build's sweeper mouth, which needs a REACHING archetype since 2026-09-20.
  rob.spec = {
    ...rob.spec,
    bbMech: { ...rob.spec.bbMech!, lift: { kind: 'boxtube', mount: 'front' }, intake: { kind: 'siderollers' } },
  };
  const local = bbPlacePointLocal(rob.spec)!;
  rob.heading = Math.PI;
  rob.pos.x = f.x + local.x;
  rob.pos.y = f.y - local.y;
  rob.hopper = [];
  for (let k = 0; k < n; k++) {
    const nect = nectarFirst && k === 0;
    rob.hopper.push(nect ? 'blue' : 'yellow');
    w.balls.push({
      id: k + 1,
      color: nect ? 'blue' : 'yellow',
      state: { kind: 'held', robot: rob.id, slot: k },
      pos: { x: rob.pos.x, y: rob.pos.y },
      vel: { x: 0, y: 0 },
      z: 0,
      vz: 0,
      r: nect ? BB_NECTAR_R : BB_POLLEN_R,
    } as Artifact);
  }
  return w;
}

/** fill flower F through the REAL `flowerPlace3d` and let it settle. */
function placeFill(seed: number, n: number, nectarFirst = false): World {
  const w = placeRig(seed, n, nectarFirst);
  const rob = w.robots[0];
  for (let k = 0; k < n; k++) {
    flowerPlace3d(w, w.biobuzz!, rob, nectarFirst && k === 0, kindOfIn(w));
    for (let t = 0; t < 60; t++) step3d(w, 1 / 60, new Map());
  }
  for (let t = 0; t < 300; t++) step3d(w, 1 / 60, new Map());
  return w;
}

/** the settled column of flower F, bottom to top, in the tube's own frame. */
function placedColumn(w: World): { id: number; c: number; d: number; x: number; y: number; r: number }[] {
  const f = BB_FLOWERS[F];
  return w.balls
    .filter((b) => b.state.kind === 'element' && b.state.el === `flower:${F}`)
    .map((b) => {
      const x = b.pos.x - f.x;
      const y = b.pos.y - f.y;
      return { id: b.id, c: b.z + (b.r ?? BB_POLLEN_R), d: Math.hypot(x, y), x, y, r: b.r ?? BB_POLLEN_R };
    })
    .sort((a, b) => a.c - b.c);
}

/** drain flower F through the REAL `flowerRetrieve3d`; returns what is left in the tube. */
function placeDrain(w: World, n: number): number {
  const f = BB_FLOWERS[F];
  const rob = w.robots[0];
  // FLUSH on the foot — `BB_PLACE_REACH` out from the ring, the chassis-face convention
  // `bbFlowerAtIntake`'s own reach numbers are measured from (`config.ts`'s FLOWER-opening
  // header) — which the Rapier robot solve does not know about: its own (wider) collision
  // footprint would rather rest ~3in further out, so it walks the chassis off this pose over a
  // settle window, and RE-PARKS it before every attempt.
  const park = (): void => {
    rob.pos.x = f.x + BB_PLACE_REACH + bbFootprint(rob.spec).front;
    rob.pos.y = f.y - sideRollerParkY(rob.spec); // one wheel on the opening (edgeGrip)
    rob.heading = Math.PI;
    rob.vel = { x: 0, y: 0 };
    rob.angVel = 0;
  };
  // ⚠️ PARKED OUT OF THE WAY WHILE THE COLUMN SETTLES, NOT FLUSH. `park()`'s pose puts the
  // chassis BOX itself inside the foot's own collision volume (a real robot cannot physically
  // occupy it — only the archetype's reach HARDWARE is allowed past the footprint, same as the
  // Box Tube's placement point, `docs/area/biobuzz.md`'s BOX TUBE note). Left there for the
  // whole settle window, the chassis being pushed back out by the solve sat squarely in the
  // falling column's path for part of it and stalled a cascading column short of the floor —
  // measured, a 5-element column stopped at 4.14in, nowhere near the ~1.4in a settled bottom
  // POLLEN rests at. Parked away instead, the column falls clear, and `park()` only puts the
  // chassis in the way for the ONE tick the gate check itself runs on (no physics step between
  // `park()` and `flowerRetrieve3d`, so nothing is ever solved against it there).
  const clear = (): void => {
    rob.pos = { x: -50, y: -50 }; // a far corner, clear of every FLOWER's foot and the HIVEs
    rob.heading = 0;
    rob.vel = { x: 0, y: 0 };
    rob.angVel = 0;
  };
  clear();
  // 400 ticks (6.67s), not 120: retrieval now carries a Z-BITE the old gate never asked, which
  // wants the bottom element genuinely AT REST — a taller column's cascade (each pop drops the
  // whole stack above it by one pitch, ~2.7in) needs real time to settle into the reach band. A
  // `break` on refusal, not a retry: retried, the extra settle time was occasionally enough for
  // jostling to reorder a NECTAR off the bottom and drain a FLOWER that G418.B locks.
  for (let p = 0; p < n + 3; p++) {
    park();
    rob.hopper.length = 0;
    rob.lastIntakeAt = -99;
    const byId = new Map(w.balls.map((b) => [b.id, b] as const));
    const took = flowerRetrieve3d(w, w.biobuzz!, rob, cmd({ intake: true }), true, byId, kindOfIn(w));
    if (took) sweepIntoHopper(w, rob);
    clear();
    if (!took) break;
    for (let t = 0; t < 400; t++) step3d(w, 1 / 60, new Map());
  }
  return w.biobuzz!.flowers[F].stack.length;
}

/**
 * SWEEP A PHYSICALLY-RELEASED FLOWER ELEMENT INTO THE HOPPER before the caller moves the robot
 * away — `flowerRetrieve3d`'s `ramp`/`siderollers` branches release a `ground` element rather
 * than `capturePollen`ing outright (owner ruling 2026-09-20, side rollers: "it should also be
 * colliding with everything" — a solid wheel cannot swallow a POLLEN where it sits), so a fixture
 * that immediately parks the robot elsewhere (as `placeDrain`'s settle window does) leaves the
 * released element sitting on the field: it never reaches the hopper, and it becomes a physical
 * obstacle a LATER release can carom off — MEASURED, a chain of un-swept releases along the same
 * approach line deflected a later one back inside `BB_FLOWER_OPEN_R` of the flower's own axis,
 * where `derive.ts` re-tagged it `element`/`flower:i` and the tube never fully drained. Holding
 * the parked pose with the intake commanded lets `bbIntakeAct`'s own extended reach
 * (`bbIntakeExtraReach`) do what a real drive-in does — the same mechanism the ramp's own
 * transit check already exercises by driving.
 */
function sweepIntoHopper(w: World, rob: RobotState): void {
  const before = rob.hopper.length;
  for (let t = 0; t < 90 && rob.hopper.length <= before; t++) {
    step3d(w, 1 / 60, new Map([[rob.id, cmd({ intake: true })]]));
  }
}

function flowerScatterChecks(check: Check): void {
  /**
   * ⚠️ **THE INTERPENETRATION IS A TRUE 3D CENTRE DISTANCE, NOT A z GAP.** For a column dead on
   * the axis the two are the same number, which is why every earlier measurement in this file is
   * written as a gap; with the scatter in they are not, and a z gap would read a scattered pair
   * as deeply overlapping when their centres are a clean 2.8 apart.
   */
  const worstOverlap = (rows: ReturnType<typeof placedColumn>): number => {
    let worst = 0;
    for (let a = 0; a < rows.length; a++) {
      for (let b = a + 1; b < rows.length; b++) {
        const d = Math.hypot(rows[a].x - rows[b].x, rows[a].y - rows[b].y, rows[a].c - rows[b].c);
        worst = Math.max(worst, rows[a].r + rows[b].r - d);
      }
    }
    return worst;
  };

  // ---- the whole owner bar in one loop: fill 1..8, measure, then drain through the real pop ---
  {
    const OVERLAP_MAX = 0.2; // the same bound the on-axis capacity check above holds itself to
    let fails = 0;
    let trials = 0;
    let worstPen = 0;
    let onAxis = 0;
    let maxSpread = 0;
    const bad: string[] = [];
    for (let n = 1; n <= 8; n++) {
      const w = placeFill(90000 + n * 137, n);
      const rows = placedColumn(w);
      worstPen = Math.max(worstPen, worstOverlap(rows));
      onAxis += rows.filter((r) => r.d < 1e-9).length;
      if (rows.length > 1) maxSpread = Math.max(maxSpread, ...rows.map((r) => Math.hypot(r.x - rows[0].x, r.y - rows[0].y)));
      const left = placeDrain(w, n);
      trials++;
      if (rows.length !== n || left > 0) {
        fails++;
        bad.push(`n=${n}: placed ${rows.length}, ${left} left at [${placedColumn(w).map((r) => r.c.toFixed(2)).join(', ')}]`);
      }
    }
    console.log(
      `[smoke-bb flower3d] SCATTER: ${trials} columns placed through the real Box Tube path and drained through the real ` +
        `retrieval · worst pollen-pollen interpenetration ${worstPen.toFixed(4)}in (3D centre distance) · widest lateral ` +
        `spread within one column ${maxSpread.toFixed(3)}in · ${onAxis} elements on the axis`,
    );
    check(
      'every FLOWER column n = 1…8 fills and then DRAINS DRY through the real retrieval (owner: POLLEN get stuck)',
      fails === 0,
      fails === 0 ? `${trials}/${trials} emptied` : bad.join(' · '),
    );
    check(
      `the SCATTER costs no interpenetration — worst pair still under ${OVERLAP_MAX}in`,
      worstPen < OVERLAP_MAX,
      `worst ${worstPen.toFixed(4)}in of a 2.800 touching pitch`,
    );
    /**
     * NON-DEGENERATE, which is the owner's actual complaint ("placing balls in a flower is too
     * uniform"): before this, every placed POLLEN settled at dxy 0.0000 and a column was a
     * mathematically perfect vertical line.
     */
    check(
      'a placed column is NOT a perfect stack — no element lands on the bore axis, and they spread (owner: too uniform)',
      onAxis === 0 && maxSpread > 0.2,
      `${onAxis} elements at dxy 0, widest spread ${maxSpread.toFixed(3)}in`,
    );
  }

  // ---- the scatter is a pure function of world JSON, so it is the same on every peer ----------
  {
    const a = JSON.stringify(placedColumn(placeFill(31337, 3)));
    const b = JSON.stringify(placedColumn(placeFill(31337, 3)));
    const c = JSON.stringify(placedColumn(placeFill(31338, 3)));
    check(
      'the SCATTER is deterministic: one seed twice is byte-identical, and another seed is not',
      a === b && a !== c,
      `same-seed identical=${a === b}, cross-seed differs=${a !== c}`,
    );
    /**
     * ⚠️ AND IT IS BOUNDED BY THE TIGHTEST BORE THE ELEMENT FITS THROUGH, not by the cage: a
     * POLLEN dropped at the cage's own 0.411 of slack arrived 0.09 in inside the peanut supports
     * (which are on the WALL side only, between the lower and middle plates, and are the one
     * thing in this tube that is not round) and was thrown 8–28 in clear of the flower. See
     * `bbFlowerDropSlack`. Nothing below asserts a number: it asserts the ORDERING that keeps the
     * fall survivable.
     */
    const pollenOff = BB3_FLOWER_SCATTER_FRAC * bbFlowerDropSlack(BB_POLLEN_R);
    const nectarOff = BB3_FLOWER_SCATTER_FRAC * bbFlowerDropSlack(BB_NECTAR_R);
    check(
      'the SCATTER radius is a fraction of the tightest BORE the element fits through, never of the cage',
      pollenOff > 0 && pollenOff < bbFlowerDropSlack(BB_POLLEN_R) && pollenOff < FLOWER_CAGE_R - BB_POLLEN_R && nectarOff > 0,
      `POLLEN ${pollenOff.toFixed(4)}in of ${bbFlowerDropSlack(BB_POLLEN_R).toFixed(4)} bore slack ` +
        `(the cage would have allowed ${(FLOWER_CAGE_R - BB_POLLEN_R).toFixed(4)}), NECTAR ${nectarOff.toFixed(4)}`,
    );
    // nothing asserts "no drop is ejected" separately: the n = 1…8 loop above already fails on a
    // column that placed fewer elements than it was handed, which is exactly that.
  }


  // ---- THE RAMP, DRIVEN IN FOR REAL — a fast slice of the 400-run sweep, worst seeds included --
  /**
   * ⚠️ **THIS IS THE ONE THAT ANSWERS "IT SHOULD WORK 100% OF THE TIME"** (owner, 2026-09-20),
   * and the full grid it is a slice of lives in `scratch/rampsweep.ts`: four FLOWERS x stick
   * 0.35/0.5/0.7/1.0 x lateral -2..+2 in x approach angle -8..+8 deg x column height 1-8 x legal
   * POLLEN/NECTAR mixes x scatter seed, **400 real drive-ins, 400 extracted**, mean 0.39 s and p95
   * 1.10 s from the ramp reaching the opening to the POLLEN being in the hopper. Forcing the
   * column height instead of drawing it: h1 400/400, h4 400/400, h8 398/400 — the two are the
   * compounding corner every archetype's sweep finds hardest (a lateral offset AND an approach
   * angle in the same rotational sense), and they are reported rather than papered over.
   *
   * What runs HERE is five drive-ins and a drain, chosen off that grid: the two hardest column
   * geometries (a LONE pollen dead on the axis, free to retreat — the case a passive lip cannot
   * take — and a full 8-column, whose bottom POLLEN settles 0.44 in toward the wall and perched on
   * the lower bore's rim), a skewed approach, a NECTAR-topped mix, and a flower on the other wall.
   * Every one is a REAL drive from 16 in out with the stick held: nothing is teleported into place.
   */
  {
    const stageColumn = (w: World, i: number, kinds: BbElementKind[], seed: number): void => {
      const f = BB_FLOWERS[i];
      let id = 6000 + i * 100;
      let z = 0;
      for (const k of kinds) {
        const r = k === 'pollen' ? BB_POLLEN_R : BB_NECTAR_R;
        const off = bbFlowerScatter(seed, id, i, bbFlowerDropSlack(r));
        w.balls.push({
          id,
          color: k === 'pollen' ? 'yellow' : 'blue',
          state: { kind: 'element', el: `flower:${i}`, slot: 0 },
          pos: { x: f.x + off.x, y: f.y + off.y },
          vel: { x: 0, y: 0 },
          z,
          vz: 0,
          r,
        } as unknown as Artifact);
        id++;
        z += 2 * r;
      }
    };
    const driveIn = (
      i: number,
      stick: number,
      lat: number,
      angDeg: number,
      kinds: BbElementKind[],
      seed: number,
      want: number,
      maxTicks: number,
    ): { taken: number; times: number[] } => {
      const w = mkWorld3d('free', 900 + seed, {
        intakeMount: 'front',
        drivetrain: 'mecanum',
        bbMech: { launcher: null, lift: null, intake: { kind: 'ramp' } } as unknown as RobotSpec['bbMech'],
      });
      w.balls.length = 0;
      stageColumn(w, i, kinds, seed);
      for (let t = 0; t < 200; t++) step3d(w, 1 / 60, new Map());
      const r = w.robots[0];
      r.hopper.length = 0;
      r.lastIntakeAt = -99;
      const f = BB_FLOWERS[i];
      const n = FLOWER_MOUTH[f.wall];
      const px = -n.y;
      const py = n.x;
      const foot = bbFootprint(r.spec).front;
      const standoff = foot + 16;
      r.pos = { x: f.x + n.x * standoff + px * lat, y: f.y + n.y * standoff + py * lat };
      r.heading = Math.atan2(-n.y, -n.x) + (angDeg * Math.PI) / 180;
      r.vel = { x: 0, y: 0 };
      r.angVel = 0;
      // deploy IN THE OPEN and settle — pressing while already flush is the swing guard's own
      // refusal case, which is a different check (see the SIM3D lane's swing-guard block).
      step3d(w, 1 / 60, new Map([[0, cmd({ bbRamp: true })]]));
      for (let t = 0; t < Math.round(BB_RAMP_DEPLOY_S * 60) + 3; t++) step3d(w, 1 / 60, new Map());
      const cmds = new Map([[0, cmd({ driveY: stick, leftDrive: stick, rightDrive: stick, intake: true })]]);
      const times: number[] = [];
      let taken = 0;
      let opened = -1;
      for (let t = 0; t < maxTicks; t++) {
        step3d(w, 1 / 60, cmds);
        const uTip = (r.pos.x - f.x) * n.x + (r.pos.y - f.y) * n.y - foot;
        if (opened < 0 && uTip < 4) opened = t;
        if (r.hopper.length > 0) {
          for (let k = 0; k < r.hopper.length; k++) times.push(t - Math.max(opened, 0));
          taken += r.hopper.length;
          if (want > 4) r.hopper.length = 0; // a DRAIN: the driver scores what he takes
          if (taken >= want) break;
        }
      }
      disposeEngineFor(w);
      return { taken, times };
    };
    const P = (n: number): BbElementKind[] => new Array(n).fill('pollen') as BbElementKind[];
    const cases: { name: string; run: () => { taken: number; times: number[] } }[] = [
      { name: 'ONE pollen, dead on the axis, straight on', run: () => driveIn(0, 0.6, 0, 0, P(1), 3, 1, 240) },
      { name: 'a full 8-column, leaning on the supports', run: () => driveIn(0, 0.6, 0, 0, P(8), 7, 1, 240) },
      { name: 'a skewed approach (2 in off, 8 deg over)', run: () => driveIn(1, 1.0, 2, 8, P(4), 11, 1, 240) },
      { name: 'a NECTAR-topped mix, slow stick', run: () => driveIn(2, 0.35, -1, -4, ['pollen', 'pollen', 'nectar'], 19, 1, 300) },
      { name: 'the far wall, full stick, one pollen', run: () => driveIn(3, 1.0, -2, 0, P(1), 23, 1, 240) },
    ];
    const rows = cases.map((c) => ({ name: c.name, ...c.run() }));
    console.log(
      `[smoke-bb flower3d] ramp drive-ins: ` + rows.map((r) => `${r.name}: ${r.taken ? `${(r.times[0] / 60).toFixed(2)}s` : 'MISSED'}`).join('  ·  '),
    );
    check(
      'ramp 3d: every representative drive-in extracts a POLLEN by physics — no timer, no teleport',
      rows.every((r) => r.taken >= 1),
      rows.map((r) => `${r.name}=${r.taken}`).join(', '),
    );
    // 150 ticks (2.5 s) is the CEILING and not the expectation: the grid's own mean is 0.40 s and
    // its p95 1.10, and four of these five land in 0.23-0.47 s. The outlier is the full 8-column
    // at 2.13 s, which is the whole column being lifted 0.435 in off the tiles by a 1/8-in blade —
    // it is the slowest thing this mechanism does and it is measured rather than budgeted.
    check(
      'ramp 3d: ...and each one inside two and a half seconds of the ramp reaching the opening',
      rows.every((r) => r.times[0] <= 150),
      rows.map((r) => `${r.name}=${r.times[0]}t`).join(', '),
    );
    /**
     * ⚠️ AND A NECTAR STAYS PUT, IN AND OUT (owner, 2026-09-24: "It is possible to use the ramp to
     * take it out, which is not allowed and does not happen in real life"). Before the middle
     * ring's NECTAR lip a NECTAR sat on the TILES in the retrieval opening; driving in lifted it
     * onto the blade (bottom 0.43) and BACKING OUT dragged it clear of the flower, re-tagged
     * `ground` 2–5 in off the axis — no hopper involved, which is why a forward drive-in counting
     * `taken` could never see it. Measured the same way here: drive in with the stick held for
     * four seconds, then reverse for two.
     *
     * DROPPED in from the top ring the way a Box Tube places one, not staged: `stageColumn` sets
     * elements on the tiles, below the lip, which is the old wrong resting place. The pollen-under
     * row is the POSITIVE half: the ramp still takes the POLLEN under a held NECTAR.
     */
    {
      const inOut = (i: number, stick: number, lat: number, angDeg: number, pollenUnder: boolean) => {
        const w = mkWorld3d('free', 950 + i, {
          intakeMount: 'front',
          drivetrain: 'mecanum',
          bbMech: { launcher: null, lift: null, intake: { kind: 'ramp' } } as unknown as RobotSpec['bbMech'],
        });
        w.balls.length = 0;
        const f = BB_FLOWERS[i];
        if (pollenUnder) drop(w, i, 'pollen', 2);
        for (let t = 0; t < 60; t++) step3d(w, 1 / 60, new Map());
        drop(w, i, 'nectar', 1);
        for (let t = 0; t < 200; t++) step3d(w, 1 / 60, new Map());
        const r = w.robots[0];
        r.hopper.length = 0;
        r.lastIntakeAt = -99;
        const n = FLOWER_MOUTH[f.wall];
        const foot = bbFootprint(r.spec).front;
        r.pos = { x: f.x + n.x * (foot + 16) - n.y * lat, y: f.y + n.y * (foot + 16) + n.x * lat };
        r.heading = Math.atan2(-n.y, -n.x) + (angDeg * Math.PI) / 180;
        r.vel = { x: 0, y: 0 };
        r.angVel = 0;
        step3d(w, 1 / 60, new Map([[0, cmd({ bbRamp: true })]]));
        for (let t = 0; t < Math.round(BB_RAMP_DEPLOY_S * 60) + 3; t++) step3d(w, 1 / 60, new Map());
        const go = (s: number) => new Map([[0, cmd({ driveY: s, leftDrive: s, rightDrive: s, intake: true })]]);
        const el = w.balls.find((b) => b.id === 1)!;
        let worstOff = 0;
        let lowest = Infinity;
        for (let t = 0; t < 360; t++) {
          step3d(w, 1 / 60, go(t < 240 ? stick : -stick));
          worstOff = Math.max(worstOff, Math.hypot(el.pos.x - f.x, el.pos.y - f.y));
          lowest = Math.min(lowest, el.z);
        }
        const res = { kind: el.state.kind, worstOff, lowest, hopper: r.hopper.length };
        disposeEngineFor(w);
        return res;
      };
      const runs = [
        inOut(0, 0.6, 0, 0, false),
        inOut(0, 1.0, 0, 0, false),
        inOut(1, 1.0, 2, 8, false),
        inOut(2, 0.35, -1, -4, false),
        inOut(3, 0.8, 1, 3, false),
      ];
      const under = inOut(2, 1.0, 1, 0, true);
      check(
        '⚠️ ramp 3d: driving in and BACKING OUT never moves a NECTAR held in a FLOWER (G418.B)',
        runs.every((q) => q.kind === 'element' && q.worstOff < 0.5 && q.lowest > BB_FLOWER_RETRIEVE_Z[1] - 0.1),
        runs.map((q, k) => `run${k}: ${q.kind}, off axis ${q.worstOff.toFixed(2)}, lowest bottom ${q.lowest.toFixed(2)}`).join(' · '),
      );
      check(
        'ramp 3d: ...while the POLLEN under a held NECTAR is still taken, and the NECTAR still stays',
        under.hopper === 1 && under.kind === 'element' && under.worstOff < 0.5,
        `hopper ${under.hopper}, NECTAR ${under.kind}, off axis ${under.worstOff.toFixed(2)}`,
      );
    }

    // THE DRAIN: one 8-POLLEN column, emptied without letting go of the stick.
    const drain = driveIn(0, 0.6, 0, 0, P(8), 7, 8, 600);
    const gaps = drain.times.map((t, k) => (k === 0 ? t : t - drain.times[k - 1]));
    console.log(`[smoke-bb flower3d] ramp drain: ${drain.taken}/8 POLLEN, gaps ${gaps.join('/')} ticks`);
    check(
      'ramp 3d: a full 8-POLLEN column DRAINS completely, one after another, on one held stick',
      drain.taken === 8,
      `${drain.taken}/8, cumulative ticks ${drain.times.join(', ')}`,
    );
    check(
      'ramp 3d: ...and every POLLEN after the first arrives in well under a second',
      gaps.slice(1).every((g) => g <= 45),
      `gaps ${gaps.join(', ')} ticks`,
    );
  }

  // ---- and a NECTAR at the bottom still LOCKS the flower (G418.B), scatter or no --------------
  {
    const w = placeFill(77001, 4, true);
    const rows = placedColumn(w);
    const left = placeDrain(w, 4);
    check(
      'a NECTAR at the bottom still LOCKS the FLOWER with the scatter on — nothing comes out (G418.B)',
      rows.length === 4 && left === 4 && rows[0].r === BB_NECTAR_R,
      `${left} of ${rows.length} left, bottom r=${rows[0]?.r} at centre ${rows[0]?.c.toFixed(3)}`,
    );
  }
}
