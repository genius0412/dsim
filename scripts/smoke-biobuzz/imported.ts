import type { Check } from './harness';
import { bbCoerce, cmd, mkWorld3dPair, setup } from './harness';
import { createBiobuzzWorld } from '../../src/games/biobuzz/spawn';
import { biobuzzStep } from '../../src/games/biobuzz/step';
import { step3d } from '../../src/games/biobuzz/sim3d/step3d';
import { chassis3dReachShapes, import3dShapes } from '../../src/games/biobuzz/sim3d/bodies';
import { createLightPredictor, probeFullReconcileMs } from '../../src/games/biobuzz/sim3d/predict';
import { bbAimHeading, bbMouths, bbPlacePointLocal, bbTurretRelease, bbTurretSolution, mouthAxes } from '../../src/games/biobuzz/robot';
import { bbAimTarget, bbCellSideOf, bbDumpShotEnters, bbPretendHive, bbTurretShotEnters } from '../../src/games/biobuzz/play';
import { hiveCellTarget } from '../../src/games/biobuzz/elements';
import {
  BB_FLOWERS,
  BB_PLACE_REACH,
  BB_POLLEN_R,
  BB_SIDE_ROLLER_OUT,
  BB_SIDE_ROLLER_PROTRUDE,
  BB_SIDE_ROLLER_R,
  bbLiftPlaceLocal,
  bbSideRollerY,
  PREDICT_FULL_BUDGET_MS,
} from '../../src/games/biobuzz/config';
import { polyFeature } from '../../src/sim/imported';
import { BB_G402_CROSS_IN, bbIntrusion } from '../../src/games/biobuzz/penalties';
import { bbImportMouths, bbSideRollerOffsets } from '../../src/games/biobuzz/importMech';
import {
  SIDE_ROLLER_IMPORT,
  SIDE_ROLLER_IMPORT_BUILD,
  SIDE_ROLLER_IMPORT_CAD_WHEEL,
  SIDE_ROLLER_IMPORT_REAL_STOP_IN,
  SIDE_ROLLER_IMPORT_V7,
  SIDE_ROLLER_IMPORT_V7_BUILD,
} from './fixtures/sideRollerImport';
import { flowerDriveInTakes, pre6Scenes, stageFlowerDriveIn } from '../sideroller-pre6-scenes';
import { pre7Scenes } from '../flowerplate-pre7-scenes';
import { clipHalf } from '../../src/sim/importedMech';
import { isDeepStrictEqual } from 'node:util';
import { biobuzzZenithRobot } from '../../src/games/biobuzz/auto';
import { robotSchema } from '@horizon36596/zenith-schema';
import { SIM_DT } from '../../src/config';
import { rot } from '../../src/math';
import type { ImportedRobot, RobotSpec, RobotState, Vec2, World } from '../../src/types';

/**
 * IMPORTED ROBOTS IN BIOBUZZ — the mechanisms on a CAD hull (`importMech.ts`, `sim3d/bodies.ts`
 * `import3dShapes`; `docs/area/biobuzz.md` "Imported robots"). The sweeper takes through the
 * PLACED mouth and nowhere else, in 2D and 3D; 3D is built from the CAD height bands; the turret,
 * the dumper's lip and the Box Tube work from where they were placed. The cross-game checks
 * (reduces-to-standard, the editor API, the standard-robot digests) are in `scripts/smoke.ts`.
 */

/** an 18 × 16 robot with its front corners chamfered: a hull no box describes */
const OCT: ImportedRobot = {
  v: 1,
  id: 'a1a1a1a1a1a1a1a1',
  hull: [{ x: -8, y: -8 }, { x: 8, y: -8 }, { x: 10, y: -6 }, { x: 10, y: 6 }, { x: 8, y: 8 }, { x: -8, y: 8 }],
  heightIn: 14,
};
const SWEEP: Partial<RobotSpec> = { intakeMount: 'front', bbMech: { launcher: { kind: 'turret', mount: 'center', hoodDeg: 45 }, lift: null, intake: { kind: 'sweeper' } } };
const imported = (patch: Partial<RobotSpec>): RobotSpec => bbCoerce({ ...SWEEP, ...patch });

/** one robot facing +x, one POLLEN at `local` in its frame, every other loose element parked far */
function scene(physics: '2d' | '3d', imp: ImportedRobot, local: Vec2): { w: World; id: number } {
  const w = createBiobuzzWorld('free', 25, [setup(0, 'blue', { ...SWEEP, imported: imp })], undefined, physics);
  const r = w.robots[0];
  for (const b of w.balls) if (b.state.kind === 'held' && b.state.robot === r.id) b.state = { kind: 'ground' };
  r.hopper = [];
  const target = w.balls.find((b) => b.state.kind === 'ground')!;
  for (const b of w.balls) if (b !== target && b.state.kind === 'ground') b.pos = { x: 60, y: -60 };
  target.pos = { x: 0, y: 0 };
  target.vel = { x: 0, y: 0 };
  target.z = 0;
  target.vz = 0;
  r.heading = 0;
  r.pos = { x: -local.x, y: -local.y };
  r.vel = { x: 0, y: 0 };
  return { w, id: target.id };
}

export function importedChecks(check: Check): void {
  // ---- the sweeper takes through the placed mouth; the hull beside it is a hull ---------------
  {
    const imp: ImportedRobot = { ...OCT, mech: { intakes: [{ edge: 'front', from: -7, to: 1 }] } };
    const sp = imported({ imported: imp });
    const ax = mouthAxes(bbMouths(sp)[0], 0, 0);
    for (const physics of ['2d', '3d'] as const) {
      const go = (local: Vec2) => {
        const { w, id } = scene(physics, imp, local);
        const m = new Map([[0, cmd({ intake: true, driveY: 0.15 })]]);
        for (let t = 0; t < 90; t++) biobuzzStep(w, SIM_DT, m);
        const b = w.balls.find((x) => x.id === id)!;
        return { held: b.state.kind === 'held', b, r: w.robots[0] };
      };
      const inMouth = go({ x: ax.uOut + 1.6, y: ax.vc });
      const beside = go({ x: 10 + 1.6, y: 4.5 });
      const loc = rot({ x: beside.b.pos.x - beside.r.pos.x, y: beside.b.pos.y - beside.r.pos.y }, -beside.r.heading);
      const depth = polyFeature(sp.imported!.hull, loc).depth;
      check(
        `import ${physics}: a POLLEN on the placed (off-centre) mouth is taken; one in front of the hull beside it is pushed, never taken, never inside the hull`,
        inMouth.held && !beside.held && depth < -(BB_POLLEN_R - 0.3),
        `mouth v ${ax.vc} ± ${ax.half}; in ${inMouth.held}, beside ${beside.held} (depth ${depth.toFixed(2)})`,
      );
    }
  }

  // ---- G402: an import's depth is its frame's deepest point, not a box centred on its origin ----
  // (integration review 2026-10-02, finding 1). The origin is the wheelbase centre, so the hull
  // is off-centre: the old `length/2 × width/2` box billed a robot wholly on its own half and let
  // a long side cross unseen.
  {
    const LONG: ImportedRobot = { v: 1, id: 'b2b2b2b2b2b2b2b2', hull: [{ x: -6, y: -8 }, { x: 12, y: -8 }, { x: 12, y: 8 }, { x: -6, y: 8 }], heightIn: 14 };
    const ASYM: ImportedRobot = { v: 1, id: 'b3b3b3b3b3b3b3b3', hull: [{ x: -8, y: -4 }, { x: 8, y: -4 }, { x: 8, y: 9 }, { x: -8, y: 9 }], heightIn: 14 };
    for (const physics of ['2d', '3d'] as const) {
      // blue import facing +x, its 6-in REAR toward the line, hull min-x at 0.5 (own half); a
      // standard red robot drives into it in AUTO
      const w = createBiobuzzWorld('match', 8, [setup(0, 'blue', { ...SWEEP, imported: LONG }), setup(1, 'red', {})], undefined, physics);
      w.balls.length = 0;
      w.match.phase = 'auto';
      w.match.phaseTimeLeft = 25;
      w.match.preCountdown = undefined;
      const blue = w.robots[0];
      const red = w.robots[1];
      blue.heading = 0;
      blue.pos = { x: 6.5, y: 40 };
      red.heading = 0;
      red.pos = { x: -16, y: 40 };
      blue.vel = { x: 0, y: 0 };
      red.vel = { x: 0, y: 0 };
      const depth0 = bbIntrusion(blue);
      const ram = cmd({ driveY: 0.5, leftDrive: 0.5, rightDrive: 0.5 });
      const onBlue: string[] = [];
      const onRed: string[] = [];
      for (let t = 0; t < 90; t++) {
        w.events.length = 0;
        biobuzzStep(w, SIM_DT, new Map([[0, cmd({})], [1, ram]]));
        for (const e of w.events) {
          if (!/G402/.test(e)) continue;
          // the event names the BENEFICIARY: a foul on blue reads "RED +20"
          if (/RED \+/.test(e)) onBlue.push(`t${t}`);
          if (/BLUE \+/.test(e)) onRed.push(`t${t}`);
        }
      }
      check(
        `import ${physics}: G402 never bills an off-centre import wholly on its own half when it is rammed; the rammer that crossed is billed`,
        depth0 === 0 && onBlue.length === 0 && onRed.length > 0,
        `blue depth at rest ${depth0.toFixed(2)}, billed blue ${onBlue.join(',') || 'never'}, billed red ${onRed.join(',') || 'never'}`,
      );
    }
    // the other direction: a long FLANK toward the line. asymL turned to face +y puts its 9-in
    // left flank toward −x; at x = 6 it is 3 in over blue's line (the box said 6.5 − 6 = 0.5)
    const s = imported({ imported: ASYM });
    const r = { spec: s, alliance: 'blue', pos: { x: 6, y: 20 }, heading: Math.PI / 2 } as unknown as RobotState;
    const d = bbIntrusion(r);
    check(
      'import: G402 reads an import’s long flank across the line (depth = the deepest vertex of its frame), not a centred box',
      Math.abs(d - 3) < 1e-6 && d > BB_G402_CROSS_IN,
      `depth ${d.toFixed(4)} (cross threshold ${BB_G402_CROSS_IN})`,
    );
  }

  // ---- 3D LIGHT predictor: an import is clamped and separated by its HULL ---------------------
  // (integration review 2026-10-02, finding 4). LIGHT is the mode before the Auto probe finishes
  // and the fallback on a slow machine. It read `robotExtents`, a box with a SYMMETRIC flank, so
  // asymL (flanks 9 and 4) strafed into a wall was drawn 5 in off it, and 5.5 in off a robot it
  // pushed against. Measured against the authority, the import must do no worse than a standard
  // robot doing the same thing.
  {
    const ASYM: ImportedRobot = { v: 1, id: 'b3b3b3b3b3b3b3b3', hull: [{ x: -8, y: -4 }, { x: 8, y: -4 }, { x: 8, y: 9 }, { x: -8, y: 9 }], heightIn: 14 };
    const lightError = (imp: ImportedRobot | null, remoteAt: Vec2 | null): number => {
      const sp = imp ? { drivetrain: 'mecanum' as const, imported: imp } : { drivetrain: 'mecanum' as const, length: 16, width: 13 };
      const setups = [setup(0, 'blue', sp, 0)];
      if (remoteAt) setups.push(setup(1, 'blue', { drivetrain: 'tank', massLb: 42 }, 1));
      const w = createBiobuzzWorld('free', 3, setups, undefined, '3d');
      w.balls.length = 0;
      const r = w.robots[0];
      r.pos = remoteAt ? { x: 0, y: 0 } : { x: 0, y: -40 };
      r.heading = 0;
      r.vel = { x: 0, y: 0 };
      if (remoteAt) {
        w.robots[1].pos = { ...remoteAt };
        w.robots[1].heading = 0;
        w.robots[1].vel = { x: 0, y: 0 };
      }
      const strafe = cmd({ driveX: 1 }); // robot-centric: strafe RIGHT, toward −y
      const cmds = new Map([[0, strafe], [1, cmd({})]]);
      for (let t = 0; t < 30; t++) step3d(w, SIM_DT, cmds);
      const light = createLightPredictor(w, 0);
      light.reset(w, w.tick);
      let worst = 0;
      for (let t = 0; t < 80; t++) {
        step3d(w, SIM_DT, cmds);
        const p = light.step(strafe, new Map([[1, cmd({})]]));
        worst = Math.max(worst, Math.hypot(p.pos.x - r.pos.x, p.pos.y - r.pos.y));
      }
      return worst;
    };
    const wallImp = lightError(ASYM, null);
    const wallStd = lightError(null, null);
    check(
      'import 3D LIGHT: an asymmetric import strafed into a wall is predicted against it, within a standard robot’s error',
      wallImp <= wallStd + 0.05 && wallImp < 0.5,
      `worst error import ${wallImp.toFixed(2)} in, standard ${wallStd.toFixed(2)} in`,
    );
    const pushImp = lightError(ASYM, { x: 0, y: -24 });
    const pushStd = lightError(null, { x: 0, y: -24 });
    check(
      'import 3D LIGHT: ...and strafed into a parked robot it is separated by its hull, within a standard robot’s error',
      pushImp <= pushStd + 0.05 && pushImp < 1,
      `worst error import ${pushImp.toFixed(2)} in, standard ${pushStd.toFixed(2)} in`,
    );
  }

  // ---- the Zenith robot file: an import's hull box where it is, and its PLACED mouths ----------
  // (integration review 2026-10-02, finding 8). It wrote the hull's box with a symmetric flank
  // and the origin in its middle, and a mouth across the whole edge of that box.
  {
    const ASYM: ImportedRobot = {
      v: 1,
      id: 'b4b4b4b4b4b4b4b4',
      hull: [{ x: -8, y: -4 }, { x: 8, y: -4 }, { x: 8, y: 9 }, { x: -8, y: 9 }],
      heightIn: 14,
      mech: { intakes: [{ edge: 'front', from: -3, to: 5 }] },
    };
    const sp = imported({ imported: ASYM });
    const file = biobuzzZenithRobot(sp) as {
      footprint: { startIn: { lengthIn: number; widthIn: number }; centreOfRotationIn: { xIn: number; yIn: number } };
      mouths: { side: string; offsetIn: { xIn: number; yIn: number }; widthIn: number; depthIn: number }[];
    };
    const parsed = robotSchema.safeParse(file);
    const m = bbImportMouths(sp)[0];
    const fm = file.mouths[0];
    check(
      'import: the Zenith robot file is the HULL’s box with the origin where it sits in it (16 × 13, the wheelbase 2.5 in off the middle), and it parses',
      parsed.success && file.footprint.startIn.lengthIn === 16 && file.footprint.startIn.widthIn === 13 && file.footprint.centreOfRotationIn.xIn === 0 && file.footprint.centreOfRotationIn.yIn === -2.5,
      JSON.stringify({ box: file.footprint.startIn, cor: file.footprint.centreOfRotationIn, ok: parsed.success }),
    );
    check(
      'import: ...and its mouth is the PLACED one: on the placed span’s centre, its width, just inside the roller line',
      file.mouths.length === 1 && fm.side === 'FRONT' && Math.abs(fm.offsetIn.yIn - m.vc) < 1e-4 && Math.abs(fm.widthIn - 2 * m.half) < 1e-4 &&
        Math.abs(fm.offsetIn.xIn + fm.depthIn / 2 - m.uOut) < 1e-4 && m.vc !== 0,
      JSON.stringify({ mouth: fm, vc: m.vc, half: m.half, uOut: m.uOut }),
    );
  }

  // ---- 3D: the CAD bands are the height profile, not one prism to the top ---------------------
  {
    const low: ImportedRobot = { ...OCT, bands: [{ z0: 0, z1: 5, hull: OCT.hull }, { z0: 5, z1: 14, hull: [{ x: -8, y: -3 }, { x: -2, y: -3 }, { x: -2, y: 3 }, { x: -8, y: 3 }] }] };
    const drop = (imp: ImportedRobot) => {
      const { w, id } = scene('3d', imp, { x: -40, y: 0 });
      const r = w.robots[0];
      const b = w.balls.find((x) => x.id === id)!;
      const p = rot({ x: 5, y: 0 }, r.heading);
      b.pos = { x: r.pos.x + p.x, y: r.pos.y + p.y };
      b.state = { kind: 'flight', target: 'blue' };
      b.z = 20;
      b.vz = 0;
      const m = new Map([[0, cmd({})]]);
      let zMin = Infinity;
      for (let t = 0; t < 30; t++) {
        biobuzzStep(w, SIM_DT, m);
        zMin = Math.min(zMin, w.balls.find((x) => x.id === id)!.z);
      }
      return zMin;
    };
    const withBands = drop(low);
    const solid = drop({ ...OCT });
    check('import 3D: an element dropped over the LOW band falls past where a single 14-in prism stops it (non-vacuous)', withBands < 7 && solid > 13, `with bands lowest z ${withBands.toFixed(2)}, one prism ${solid.toFixed(2)}`);
    const shapes = import3dShapes(imported({ imported: low }), 14);
    check(
      'import 3D: the compound is prisms only (no archetype turret shape on top of the CAD), carved below the slot, a pocket filler per mouth, and the bands uncarved for the remote predictor',
      shapes.chassis.every((s) => s.shape === 'prism') && shapes.pocket.length === 1 && shapes.remote.length === 2 && shapes.chassis.length > shapes.remote.length,
      `${shapes.chassis.length} chassis, ${shapes.pocket.length} pocket, ${shapes.remote.length} remote`,
    );
  }

  importedSideRollerChecks(check);
  importedFlowerPlateChecks(check);

  // ---- launchers and the Box Tube work from where they were placed ---------------------------
  {
    const sp = bbCoerce({
      intakeMount: 'front',
      bbMech: { launcher: { kind: 'turret', mount: 'center', hoodDeg: 45 }, lift: { kind: 'vslide', mount: 'left' }, intake: { kind: 'sweeper' } },
      imported: { ...OCT, mech: { shooter: { x: -3, y: -2, z: 12.25 }, place: { x: 0, y: 5, z: 6 } } },
    });
    check('import: heightIn is the CAD height rounded up onto the dial, with no stow height', sp.heightIn === 14 && sp.stowHeightIn === undefined);
    const r = { spec: sp, pos: { x: 0, y: 0 }, heading: 0, vel: { x: 0, y: 0 }, angVel: 0, turretHeading: 0, bbTurretPitch: 0 } as unknown as RobotState;
    const rel = bbTurretRelease(r, 0, 100);
    check('import: the turret releases at the placed height at rest pitch', Math.abs(rel.z - 12.25) < 1e-9, `${rel.z}`);
    const p = bbPlacePointLocal(sp)!;
    const q = bbLiftPlaceLocal(sp)!;
    check('import: the Box Tube reaches BB_PLACE_REACH out of the hull from its placed base, the same in both copies', Math.abs(p.x) < 1e-9 && Math.abs(p.y - (8 + BB_PLACE_REACH)) < 1e-9 && p.x === q.x && p.y === q.y, JSON.stringify({ p, q }));
    const cell = hiveCellTarget('blue', 'north');
    const made = (patch: Partial<RobotSpec>) => {
      let n = 0;
      for (const [px, py] of [[cell.pos.x, cell.pos.y + 40], [cell.pos.x + 30, cell.pos.y + 30], [-40, 0], [40, 0], [0, 50]] as [number, number][]) {
        const w = createBiobuzzWorld('practice', 11, [setup(0, 'blue', { ...SWEEP, ...patch })]);
        const rr = w.robots[0];
        rr.pos = { x: px, y: py };
        rr.heading = 0.4;
        const t = bbAimTarget(w, rr);
        const sol = bbTurretSolution(rr, t, 0);
        if (!sol) continue;
        rr.turretHeading = sol.yaw;
        rr.bbTurretPitch = sol.pitch;
        if (sol.reachable && bbTurretShotEnters(bbPretendHive(w.biobuzz!.hives.blue, bbCellSideOf(t)), rr, 0, sol.speed, SIM_DT)) n++;
      }
      return n;
    };
    const std = made({});
    const imp = made({ imported: { ...OCT, mech: { shooter: { x: -3, y: -2, z: 12.25 } } } });
    check('import: a turret placed on the CAD solves and scores from the stands a standard turret does', imp === std && std >= 3, `standard ${std}/5, import ${imp}/5`);
    const dump = (patch: Partial<RobotSpec>, cluster: boolean) => {
      const w = createBiobuzzWorld('practice', 11, [setup(0, 'blue', { intakeMount: 'back', bbMech: { launcher: { kind: 'dumper', mount: 'front', hoodDeg: 50 }, lift: null, intake: { kind: 'sweeper' } }, ...patch })]);
      const rr = w.robots[0];
      rr.pos = { x: cell.pos.x, y: cell.pos.y + 32 };
      const t = bbAimTarget(w, rr);
      rr.heading = bbAimHeading(rr, t)!;
      while (rr.hopper.length < 4) rr.hopper.push('yellow');
      return bbDumpShotEnters(bbPretendHive(w.biobuzz!.hives.blue, bbCellSideOf(t)), rr, t, 4, cluster, SIM_DT);
    };
    for (const cluster of [false, true]) {
      check(
        `import: a ${cluster ? '3D catapult' : '2D'} dump from the placed lip goes in where a standard one does`,
        dump({}, cluster) && dump({ imported: { ...OCT, mech: { shooter: { x: 9.5, y: 0, z: 10 } } } }, cluster),
      );
    }
  }
}

/**
 * SIDE ROLLERS ON A REAL IMPORT, AT A FLOWER (`SIM_PATCH` 6; owner, 2026-10-04: "side rollers cant
 * actually intake from flower because of weird footprint ... on the biobuzz 3d gobilda mecanum").
 * The fixture is the descriptor the production editor saved for a vendor's mecanum starter bot
 * (`fixtures/sideRollerImport.ts`, numbers only). Before patch 6 its lowest 3D band (tiles to 5 in,
 * front = its rollers' front) met both FLOWER plates on their edge, the wheels stood 0.85 in short
 * of the bottom POLLEN, and 0 of 540 real drive-ins took one; 2D took 13 %, only when a yawed
 * corner swung a wheel in. `docs/area/biobuzz.md`, "IMPORTED ROBOTS".
 */
function importedSideRollerChecks(check: Check): void {
  const sp = bbCoerce(SIDE_ROLLER_IMPORT_BUILD);
  const ax = mouthAxes(bbMouths(sp)[0], sp.length / 2, sp.width / 2);
  const cad = SIDE_ROLLER_IMPORT_CAD_WHEEL;
  {
    const [l, r] = bbSideRollerOffsets(sp, ax);
    const [l5] = bbSideRollerOffsets(sp, ax, true);
    const u = ax.uOut + BB_SIDE_ROLLER_OUT;
    const depth = Math.min(...[l, -r].map((v) => polyFeature(SIDE_ROLLER_IMPORT.hull, { x: u, y: ax.vc + v }).depth));
    check(
      "import side rollers: each wheel sits in the hull's own front corner, on the CAD's own roller (axis within 0.15 in), where the standard rule put it over 1 in outboard",
      Math.abs(l - cad.y) < 0.15 && Math.abs(r - cad.y) < 0.15 && Math.abs(u - cad.x) < 0.15 && depth > BB_SIDE_ROLLER_R - 0.02 && l5 - cad.y > 1,
      `left ${l.toFixed(3)} right ${r.toFixed(3)} at u ${u.toFixed(3)}, ${depth.toFixed(3)} in inside the hull; CAD (${cad.x}, ±${cad.y}); before patch 6 ${l5.toFixed(3)}`,
    );
  }
  {
    // an import with square corners is placed by the standard rule, exactly
    const box: ImportedRobot = { v: 1, id: 'd4d4d4d4d4d4d4d4', hull: [{ x: -9, y: -8.5 }, { x: 9, y: -8.5 }, { x: 9, y: 8.5 }, { x: -9, y: 8.5 }], heightIn: 14 };
    const bs = bbCoerce({ ...SIDE_ROLLER_IMPORT_BUILD, imported: box });
    const bax = mouthAxes(bbMouths(bs)[0], 0, 0);
    const [l, r] = bbSideRollerOffsets(bs, bax);
    check('import side rollers: a hull with square corners keeps the standard wheel placement exactly', l === bbSideRollerY(bax.half) && r === l, `${l} ${r} vs ${bbSideRollerY(bax.half)}`);
  }
  {
    // past the roller line, inside the span, the 3D body is the two wheels and nothing else
    const h = sp.heightIn ?? 13;
    const past = (shapes: { cx: number; cy: number; pts?: Vec2[] }[]): number => {
      let x = -Infinity;
      for (const s of shapes) for (const q of s.pts ?? []) if (Math.abs(s.cy + q.y - ax.vc) < ax.half - 1e-6) x = Math.max(x, s.cx + q.x);
      return x;
    };
    const live = import3dShapes(sp, h);
    const old = import3dShapes(sp, h, true);
    const now = Math.max(past(live.chassis), past(live.pocket), past(live.remote));
    const was = Math.max(past(old.chassis), past(old.pocket), past(old.remote));
    const wheels = chassis3dReachShapes(sp, h, false);
    const wheelFront = Math.max(...wheels.map((s) => s.cx + s.hx));
    check(
      "import side rollers 3D: inside the span nothing of the body stands past the roller line, the wheels' front is the hull's front; before patch 6 the lowest band reached 1.4+ in past it",
      now <= ax.uOut + 1e-6 && was > ax.uOut + 1.4 && wheels.length === 2 && Math.abs(wheelFront - (ax.uOut + BB_SIDE_ROLLER_PROTRUDE)) < 1e-9,
      `body ${now.toFixed(3)} against the roller line ${ax.uOut.toFixed(3)}; before ${was.toFixed(3)}; wheel front ${wheelFront.toFixed(3)}`,
    );
  }
  {
    // REAL DRIVE-INS, the CAD roller lined up on the ring axis: every FLOWER, 0.8 in either side of
    // it, square and 10° skewed each way, full stick, intake held — 36 per engine
    for (const physics of ['2d', '3d'] as const) {
      let took = 0;
      let square = 0;
      let old = 0;
      const miss: string[] = [];
      for (let fi = 0; fi < BB_FLOWERS.length; fi++) {
        for (const delta of [-0.8, 0, 0.8]) {
          for (const yaw of [0, -10, 10]) {
            const side = fi % 2 === 0 ? 1 : -1;
            const { w, column } = stageFlowerDriveIn(undefined, physics, SIDE_ROLLER_IMPORT_BUILD, cad, fi, side, yaw, delta);
            const t = flowerDriveInTakes(w, column);
            if (t !== null) {
              took++;
              if (yaw === 0) square++;
            } else miss.push(`F${fi + 1} ${delta} ${yaw}°`);
            if (yaw === 0 && delta === 0) {
              const pre = stageFlowerDriveIn(5, physics, SIDE_ROLLER_IMPORT_BUILD, cad, fi, side, 0, 0);
              if (flowerDriveInTakes(pre.w, pre.column) !== null) old++;
            }
          }
        }
      }
      check(
        `import side rollers ${physics}: real drive-ins with the CAD roller lined up take the bottom POLLEN like a standard side-roller robot (every square approach, 33 of 36 or more)`,
        took >= 33 && square === 12,
        `${took}/36, square ${square}/12; missed ${miss.join(', ') || 'none'}`,
      );
      if (physics === '3d') {
        check('import side rollers 3d: ...and a replay recorded under patch 5 keeps the old geometry, where no square, dead-on approach takes one', old === 0, `${old}/4`);
      } else {
        console.log(`[smoke-bb import] 2d under patch 5: ${old}/4 square, dead-on approaches took a POLLEN`);
      }
    }
  }
  {
    // SIM_PATCH 6: the four scenes stepped as a replay recorded under patch 5 land on the pins the
    // code before the change produced (e5c3f6a8, measured 2026-10-04), and live none does
    const PRE6: Record<string, string> = {
      bb2dFlower: 'held=1 stack=3 4137413556:71779836',
      bb3dFlower: 'held=0 stack=4 868394184:2793652222',
      bb3dFlowerSkew: 'held=0 stack=4 1221431464:2227753158',
      bb3dPush: '669942157:3738788457',
    };
    const old = pre6Scenes(5);
    const live = pre6Scenes(undefined);
    const bad = Object.keys(PRE6).filter((k) => old[k] !== PRE6[k]);
    check('SIM_PATCH 6: a replay recorded under patch 5 steps a side-roller import exactly as the code before the fix did (2D and 3D FLOWER drive-ins, a skewed one, a push into a robot)', bad.length === 0, bad.map((k) => `${k}: ${old[k]}`).join(' | '));
    check('SIM_PATCH 6: ...and live, every one of those scenes runs the new rules (none lands on its old pin)', Object.keys(PRE6).every((k) => live[k] !== PRE6[k]), JSON.stringify(live));
  }
}

/**
 * AN IMPORT REACHES INTO A FLOWER AS FAR AS ITS CAD DOES (`SIM_PATCH` 7; owner, 2026-10-04: "For the
 * gobilda biobuzz robot, I know i can get closer into the flower but it blocks me"). The real robot,
 * swept exactly into everything the 3D robot meets at a FLOWER, stops with its front 0.38 in short of
 * the ring axis, on the middle plate (`SIDE_ROLLER_IMPORT_REAL_STOP_IN`); the sim stopped it at 0.77.
 * The descriptor the importer writes now (`SIDE_ROLLER_IMPORT_V7`) gives the plate's heights a band of
 * their own and cuts each band back to the CAD between the side rollers (`bbImportClipReach`).
 */
function importedFlowerPlateChecks(check: Check): void {
  const sp = bbCoerce(SIDE_ROLLER_IMPORT_V7_BUILD);
  const h = sp.heightIn ?? 13;
  const m = bbImportMouths(sp)[0];
  {
    // inside the mouth, at the plate band's heights, the 3D body ends at the cut, not the roller line
    const band = SIDE_ROLLER_IMPORT_V7.bands!.find((b) => b.cuts?.some((c) => c.edge === 'front' && c.from < 0 && c.to > 0))!;
    const cut = band.cuts!.find((c) => c.edge === 'front' && c.from < 0 && c.to > 0)!;
    const reach = (shapes: { cx: number; cy: number; cz: number; hz: number; pts?: Vec2[] }[]): number => {
      let x = -Infinity;
      for (const s of shapes) {
        const z0 = s.cz + h / 2 - s.hz;
        const z1 = s.cz + h / 2 + s.hz;
        if (!s.pts || z1 <= band.z0 + 0.01 || z0 >= band.z1 - 0.01) continue;
        let q = s.pts.map((p) => ({ x: s.cx + p.x, y: s.cy + p.y }));
        q = clipHalf(clipHalf(q, 0, 1, cut.to - 0.01), 0, -1, -(cut.from + 0.01));
        for (const p of q) x = Math.max(x, p.x);
      }
      return x;
    };
    const live = import3dShapes(sp, h);
    const old = import3dShapes(sp, h, false, true);
    const now = Math.max(reach(live.chassis), reach(live.pocket), reach(live.remote));
    const was = Math.max(reach(old.chassis), reach(old.pocket), reach(old.remote));
    check(
      "import FLOWER plate 3D: between the side rollers, at the plate's heights, the body ends at the CAD's own front (the band's cut), 0.38 in behind the roller line it ended at before patch 7",
      Math.abs(now - cut.at) < 1e-6 && Math.abs(was - m.uOut) < 1e-6 && m.uOut - now > 0.3,
      `now ${now.toFixed(3)}, cut ${cut.at}, before ${was.toFixed(3)}, roller line ${m.uOut.toFixed(3)}`,
    );
    const stripped = bbCoerce({ ...SIDE_ROLLER_IMPORT_V7_BUILD, imported: { ...SIDE_ROLLER_IMPORT_V7, bands: SIDE_ROLLER_IMPORT_V7.bands!.map(({ z0, z1, hull }) => ({ z0, z1, hull })) } });
    check(
      'import FLOWER plate 3D: a replay recorded under patch 6 builds the bands as if they had no cuts',
      isDeepStrictEqual(old, import3dShapes(stripped, h, false, true)) && !isDeepStrictEqual(live, old),
    );
    // the floor band (0–1 in) is wholly under the mouth slot: nothing of it an element meets stands in
    // front of the face inside the span. Before patch 7 its top 0.1 in stayed whole, a bar across the
    // mouth at the POLLEN's height that the bottom POLLEN rode up onto (F2, 0.4 in or more off line)
    const floor = SIDE_ROLLER_IMPORT_V7.bands![0];
    const inMouth = (shapes: { cx: number; cy: number; cz: number; hz: number; pts?: Vec2[] }[]): number =>
      shapes.filter((s) => {
        const z1 = s.cz + h / 2 + s.hz;
        if (!s.pts || z1 > floor.z1 + 1e-6) return false;
        let q = s.pts.map((p) => ({ x: s.cx + p.x, y: s.cy + p.y }));
        q = clipHalf(clipHalf(clipHalf(q, 0, 1, m.vc + m.half - 0.75), 0, -1, -(m.vc - m.half + 0.75)), -1, 0, -(m.face + 0.05));
        return q.length >= 3;
      }).length;
    const oldLive = import3dShapes(sp, h, false, true);
    check(
      "import FLOWER plate 3D: a band wholly under the mouth slot is carved top to bottom (no bar across the mouth in front of the face); a patch-6 replay keeps its 0.1-in top",
      floor.z1 < 3 && inMouth(live.chassis) === 0 && inMouth(oldLive.chassis) > 0,
      `now ${inMouth(live.chassis)}, before ${inMouth(oldLive.chassis)}`,
    );
  }
  {
    // driven straight at every FLOWER, the front point (9.7, 0) on the ring axis
    const stop = (spec: Partial<RobotSpec>, fi: number): number => {
      const { w } = stageFlowerDriveIn(undefined, '3d', spec, { x: 9.7, y: 0 }, fi, 1, 0, 0);
      const f = BB_FLOWERS[fi];
      const r = w.robots[0];
      const cm = new Map([[0, cmd({ driveY: 0.6, leftDrive: 0.6, rightDrive: 0.6, intake: false })]]);
      let best = Infinity;
      for (let k = 0; k < 240; k++) {
        biobuzzStep(w, SIM_DT, cm);
        const c = Math.cos(r.heading);
        const s = Math.sin(r.heading);
        best = Math.min(best, (f.x - r.pos.x - 9.7 * c) * c + (f.y - r.pos.y - 9.7 * s) * s);
      }
      return best;
    };
    const now = BB_FLOWERS.map((_, fi) => stop(SIDE_ROLLER_IMPORT_V7_BUILD, fi));
    const was = BB_FLOWERS.map((_, fi) => stop(SIDE_ROLLER_IMPORT_BUILD, fi));
    const real = SIDE_ROLLER_IMPORT_REAL_STOP_IN;
    check(
      `import FLOWER plate 3D: driven straight in, it stops within 0.1 in of where the real CAD does (${real} in short of the axis) at every FLOWER; the descriptor from before stopped 0.7+`,
      now.every((d) => Math.abs(d - real) <= 0.1) && was.every((d) => d > 0.7),
      `now ${now.map((d) => d.toFixed(2)).join(' ')}; before ${was.map((d) => d.toFixed(2)).join(' ')}`,
    );
  }
  {
    // ...and its side rollers still take the bottom POLLEN on every square approach
    const cad = SIDE_ROLLER_IMPORT_CAD_WHEEL;
    let took = 0;
    const miss: string[] = [];
    for (let fi = 0; fi < BB_FLOWERS.length; fi++) {
      for (const delta of [-0.8, 0, 0.8]) {
        const side = fi % 2 === 0 ? 1 : -1;
        const { w, column } = stageFlowerDriveIn(undefined, '3d', SIDE_ROLLER_IMPORT_V7_BUILD, cad, fi, side, 0, delta);
        if (flowerDriveInTakes(w, column) !== null) took++;
        else miss.push(`F${fi + 1} ${delta}`);
      }
    }
    check('import FLOWER plate 3D: with the new bands the side rollers take the bottom POLLEN on every square drive-in, 0.8 in either side of the line too (12 of 12)', took === 12, `${took}/12; missed ${miss.join(', ') || 'none'}`);
  }
  {
    // SIM_PATCH 7: robots driven at a FLOWER's plate corner, stepped as a replay recorded under patch
    // 6, land on the pins the code before the change produced (square plates, uncut bands), and live
    // none does
    const PRE7: Record<string, string> = {
      importCorner: '4186992891:2752920888',
      importCornerOther: '1719389586:1537790104',
      standardCorner: '1245461433:2638020036',
      standardSquare: '3200283346:3985946132',
    };
    const old = pre7Scenes(6);
    const live = pre7Scenes(undefined);
    const bad = Object.keys(PRE7).filter((k) => old[k] !== PRE7[k]);
    check('SIM_PATCH 7: a replay recorded under patch 6 meets a FLOWER exactly as the code before the change did (an import and a standard robot, at a plate corner and square)', bad.length === 0, bad.map((k) => `${k}: ${old[k]}`).join(' | '));
    check('SIM_PATCH 7: ...and live, every one of those scenes meets the measured plate outline (none lands on its old pin)', Object.keys(PRE7).every((k) => live[k] !== PRE7[k]), JSON.stringify(live));
  }
}

/** a 16-vertex hull (a rounded 18 × 16), four bands and a side sweeper — the heaviest import */
function heavyImport(): Partial<RobotSpec> {
  const ring = (rx: number, ry: number, n: number, cx = 0) =>
    Array.from({ length: n }, (_, i) => {
      // a 16-gon from exact eighth-turn fractions, no trig (sin/cos of k·22.5° to 4 places)
      const T = [1, 0.9239, 0.7071, 0.3827, 0, -0.3827, -0.7071, -0.9239, -1, -0.9239, -0.7071, -0.3827, 0, 0.3827, 0.7071, 0.9239];
      const S = [0, 0.3827, 0.7071, 0.9239, 1, 0.9239, 0.7071, 0.3827, 0, -0.3827, -0.7071, -0.9239, -1, -0.9239, -0.7071, -0.3827];
      return { x: cx + rx * T[(i * 16) / n], y: ry * S[(i * 16) / n] };
    });
  return {
    intakeMount: 'side',
    bbMech: { launcher: { kind: 'turret', mount: 'center', hoodDeg: 45 }, lift: null, intake: { kind: 'sweeper' } },
    imported: {
      v: 1,
      id: 'c0ffee00c0ffee00',
      heightIn: 15,
      hull: ring(9, 8, 16),
      bands: [
        { z0: 0, z1: 1, hull: ring(7, 7, 8) },
        { z0: 1, z1: 5, hull: ring(9, 8, 8) },
        { z0: 5, z1: 10, hull: ring(6, 6, 8) },
        { z0: 10, z1: 15, hull: ring(4, 4, 8) },
      ],
      mech: { shooter: { x: 0, y: 0, z: 12 } },
    },
  };
}

/** PERF lane (`index.ts`): what four heavy imports cost a 3D room, and a reconcile with one local */
export function importedPerfChecks(check: Check): void {
  {
    const spec = heavyImport();
    const w = createBiobuzzWorld('free', 31, [setup(0, 'blue', spec, 0), setup(1, 'blue', spec, 1), setup(2, 'red', spec, 0), setup(3, 'red', spec, 1)], undefined, '3d');
    const cmds = new Map([
      [0, cmd({ driveY: 1, intake: true })],
      [1, cmd({ rotate: 1, fire: true })],
      [2, cmd({ driveY: -1, intake: true })],
      [3, cmd({ driveX: 1, fire: true })],
    ]);
    for (let t = 0; t < 60; t++) step3d(w, SIM_DT, cmds); // warm-up, excluded
    const times: number[] = [];
    for (let t = 0; t < 600; t++) {
      const t0 = Date.now();
      step3d(w, SIM_DT, cmds);
      times.push(Date.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    check('perf: a 2v2 of four heavy imports (16-vertex hulls, 4 bands, side sweepers) keeps the standard step3d median budget, <= 1.5ms', median <= 1.5, `median=${median}ms p95=${times[Math.floor(times.length * 0.95)]}ms`);
  }
  {
    const w = mkWorld3dPair('free', 9213, heavyImport());
    w.balls.length = 0;
    const r = w.robots[0];
    r.hopper.length = 0;
    r.pos = { x: 0, y: 20 };
    r.heading = Math.PI / 2;
    let ms = Infinity;
    for (let i = 0; i < 30; i++) ms = Math.min(ms, probeFullReconcileMs(w, 0, () => performance.now()));
    check(`perf: FULL reconciles inside PREDICT_FULL_BUDGET_MS (${PREDICT_FULL_BUDGET_MS}ms) with a heavy import as the local robot`, ms <= PREDICT_FULL_BUDGET_MS, `${ms.toFixed(1)}ms (best of 30)`);
  }
}
