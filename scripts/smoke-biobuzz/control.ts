import type { Alliance, Artifact, ArtifactColor, RobotCommand, RobotSpec, World } from '../../src/types';
import { SIM_DT } from '../../src/config';
import { createBiobuzzWorld } from '../../src/games/biobuzz/spawn';
import { biobuzzStep } from '../../src/games/biobuzz/step';
import { BB_NECTAR_R, BB_POLLEN_R } from '../../src/games/biobuzz/config';
import { type BbIntakeSpec } from '../../src/games/biobuzz/mechs';
import { bbMouths } from '../../src/games/biobuzz/robot';
import { BB_CONTROL_REARM_S, BB_MOMENTARY_S, updateBiobuzzPenalties } from '../../src/games/biobuzz/penalties';
import { footprintExtents } from '../../src/sim/field';
import { type Check, cmd, setup } from './harness';

/**
 * G407 AND G408 AS MANUAL TU07 AND THE Q&A HAVE THEM (`SIM_PATCH` 13, 2026-11-01).
 *
 * The owner's brief: INCIDENTAL contact is not called, STRATEGIC control is. So every check below
 * is one of two kinds — an incidental shape that must bill NOTHING beyond what it billed before
 * (a drive-past, a poke, parking against a pile, a deflection, a sorter's immediate eject), and a
 * strategic one that must draw the card (herding the opponent's NECTAR into your own GARDEN,
 * holding it past MOMENTARY, a third momentary five). Every scene is the real pipeline, stepped,
 * and the ones that turn on the herd test run on BOTH pipelines: a placed fixture cannot fail for
 * a rule that never reaches a robot which had to drive (`g407DrivenChecks`' lesson).
 *
 * The robot is BLUE throughout, so the opponent's NECTAR is RED.
 */

const mech = (launcher: string, intake: BbIntakeSpec): Partial<RobotSpec> =>
  ({
    intakeMount: 'front',
    bbMech: { launcher: { kind: launcher, mount: launcher === 'dumper' || launcher === 'fixed' ? 'back' : 'center', hoodDeg: 75 }, lift: null, intake },
  }) as unknown as Partial<RobotSpec>;

/** a mixed-feed dumper with no sorter: takes either alliance's NECTAR and keeps it */
const MIXED = mech('dumper', { kind: 'sweeper' });

type Physics = '2d' | '3d';

/**
 * An empty TELEOP field with the robots given, every staged element and human-player box cleared,
 * so every element in a count is one the scene put there.
 */
function field(physics: Physics, robots: { id: number; alliance: Alliance; spec?: Partial<RobotSpec> }[], patch?: number): World {
  const w = createBiobuzzWorld(
    'match',
    11,
    robots.map((r, i) => setup(r.id, r.alliance, r.spec ?? {}, i)),
    undefined,
    physics,
  );
  w.match.phase = 'teleop';
  w.match.phaseTimeLeft = 110;
  if (patch !== undefined) w.simPatch = patch;
  w.balls.length = 0;
  for (const a of ['red', 'blue'] as const) w.humanPlayers[a].box = [];
  const bb = w.biobuzz;
  if (bb) {
    bb.flowers.forEach((f) => {
      f.stack = [];
    });
    bb.hives.red.contents = [];
    bb.hives.blue.contents = [];
  }
  for (const r of w.robots) {
    r.hopper = [];
    r.autoIntake = false;
    r.autoFire = false;
    r.vel = { x: 0, y: 0 };
    r.angVel = 0;
  }
  return w;
}

let nextId = 9000;
/** an element on the tiles. `z` is the CENTRE in 2D and the BOTTOM in 3D. */
function put(w: World, physics: Physics, color: ArtifactColor, x: number, y: number, vx = 0, vy = 0): Artifact {
  const r = color === 'yellow' ? BB_POLLEN_R : BB_NECTAR_R;
  const b: Artifact = { id: nextId++, color, r, state: { kind: 'ground' }, pos: { x, y }, vel: { x: vx, y: vy }, z: physics === '3d' ? 0 : r, vz: 0 };
  w.balls.push(b);
  if (w.biobuzz) w.biobuzz.nextBallId = Math.max(w.biobuzz.nextBallId, b.id + 1);
  return b;
}

function pose(w: World, id: number, x: number, y: number, headingDeg: number): void {
  const r = w.robots.find((q) => q.id === id)!;
  r.pos = { x, y };
  r.heading = (headingDeg * Math.PI) / 180;
  r.vel = { x: 0, y: 0 };
  r.angVel = 0;
}

function drive(w: World, cmds: Record<number, RobotCommand>, s: number): void {
  const m = new Map(Object.entries(cmds).map(([k, v]) => [Number(k), v] as const));
  for (let i = 0; i < Math.round(s / SIM_DT); i++) biobuzzStep(w, SIM_DT, m);
}

const lines = (w: World, rule: string): string[] => w.events.filter((e) => e.includes(rule));
const warns = (w: World, rule: string): number => lines(w, rule).filter((e) => e.startsWith('WARNING')).length;
const cards = (w: World, rule: string): number => lines(w, rule).filter((e) => e.startsWith('YELLOW') || e.startsWith('RED')).length;
const majors = (w: World, rule: string): number => lines(w, rule).filter((e) => e.startsWith('MAJOR')).length;
const g408n = (w: World): number => w.biobuzz?.g408?.[0] ?? 0;

export function controlChecks(check: Check): void {
  // ═══ G408 — INCIDENTAL: none of these CONTROL the NECTAR, so none bills ═══════════════════════
  for (const physics of ['2d', '3d'] as const) {
    {
      // DRIVE-PAST: a flank clips a red NECTAR in transit (orange box D, "bulldozing")
      const w = field(physics, [{ id: 0, alliance: 'blue' }]);
      pose(w, 0, -50, 40, 0);
      const e = footprintExtents(w.robots[0].spec);
      put(w, physics, 'red', -30, 40 + e.half + BB_NECTAR_R - 0.5);
      drive(w, { 0: cmd({ driveY: 1 }) }, 1.5);
      check(`G408 incidental (${physics}): a DRIVE-PAST that clips the opponent's NECTAR draws nothing`, warns(w, 'G408') === 0 && cards(w, 'G408') === 0, lines(w, 'G408').join(' | '));
    }
    {
      // POKE: nose into it and straight back out, inside the confirm window
      const w = field(physics, [{ id: 0, alliance: 'blue' }]);
      pose(w, 0, -50, 40, 0);
      const e = footprintExtents(w.robots[0].spec);
      put(w, physics, 'red', -50 + e.front + BB_NECTAR_R + 0.5, 40);
      drive(w, { 0: cmd({ driveY: 0.6 }) }, 0.25);
      drive(w, { 0: cmd({ driveY: -0.6 }) }, 0.6);
      check(`G408 incidental (${physics}): a POKE that touches and backs off draws nothing`, warns(w, 'G408') === 0, lines(w, 'G408').join(' | '));
    }
    {
      // PARK: a parked robot with a red NECTAR resting against its bumper, six seconds
      const w = field(physics, [{ id: 0, alliance: 'blue' }]);
      pose(w, 0, -50, 40, 0);
      const e = footprintExtents(w.robots[0].spec);
      put(w, physics, 'red', -50 + e.front + BB_NECTAR_R + 0.1, 40);
      put(w, physics, 'red', -50 + e.front + BB_NECTAR_R + 0.1, 40 + 2 * BB_NECTAR_R + 0.2);
      drive(w, { 0: cmd({}) }, 6);
      check(`G408 incidental (${physics}): PARKED against the opponent's NECTAR for 6 s draws nothing`, warns(w, 'G408') === 0, lines(w, 'G408').join(' | '));
    }
    {
      // DEFLECTION: a red NECTAR rolling into a parked robot bounces off it (orange box E)
      const w = field(physics, [{ id: 0, alliance: 'blue' }]);
      pose(w, 0, -50, 40, 0);
      const b = put(w, physics, 'red', -20, 40, -60, 0);
      const front = -50 + footprintExtents(w.robots[0].spec).front;
      let closest = Infinity;
      for (let i = 0; i < 120; i++) {
        drive(w, { 0: cmd({}) }, SIM_DT);
        closest = Math.min(closest, b.pos.x - BB_NECTAR_R - front);
      }
      check(
        `G408 incidental (${physics}): a NECTAR DEFLECTED off a parked robot draws nothing`,
        closest < 0.5 && warns(w, 'G408') === 0,
        `reached ${closest.toFixed(2)} in from the bumper · ${lines(w, 'G408').join(' | ')}`,
      );
    }
  }

  // ═══ G408 — STRATEGIC: herding it into your own GARDEN ════════════════════════════════════════
  for (const physics of ['2d', '3d'] as const) {
    for (const patch of [undefined, 12] as const) {
      // blue's GARDEN runs along the rear wall (y 68.1–70.7, x 47.4–70.7): push a red NECTAR into it
      const w = field(physics, [{ id: 0, alliance: 'blue' }], patch);
      // from y = 4, so the push is long enough for the herd test's carry and confirm (5 in, 0.45 s)
      pose(w, 0, 52, 4, 90);
      const e = footprintExtents(w.robots[0].spec);
      const b = put(w, physics, 'red', 52, 4 + e.front + BB_NECTAR_R + 1);
      drive(w, { 0: cmd({ driveY: 1 }) }, 2.5);
      drive(w, { 0: cmd({ driveY: -0.5 }) }, 0.5);
      const inGarden = b.pos.y + BB_NECTAR_R > 68.1;
      if (patch === undefined) {
        check(
          `G408 STRATEGIC (${physics}): HERDING the opponent's NECTAR into your own GARDEN warns and draws the YELLOW CARD`,
          inGarden && warns(w, 'G408') >= 1 && cards(w, 'G408') === 1 && w.penalties.carded[0] === 'yellow',
          `y=${b.pos.y.toFixed(1)} ${lines(w, 'G408').join(' | ')}`,
        );
        check(`G408 STRATEGIC (${physics}): ...and it is ONE instance, not one per tick`, g408n(w) === 1, `g408=${g408n(w)}`);
      } else {
        check(
          `G408 replay (${physics}): a world stamped SIM_PATCH 12 keeps the old rule — herding is not counted`,
          inGarden && warns(w, 'G408') === 0 && w.penalties.carded[0] === undefined,
          `y=${b.pos.y.toFixed(1)} ${lines(w, 'G408').join(' | ')}`,
        );
      }
    }
  }

  // ═══ G408 — HOLDING: the sorter's eject, MOMENTARY, the re-take, G204 ═════════════════════════
  /** blue at the centre facing +x with a red NECTAR in the middle of its mouth */
  const atMouth = (spec: Partial<RobotSpec>): { w: World; b: Artifact; place: () => void } => {
    const w = field('2d', [{ id: 0, alliance: 'blue', spec }]);
    pose(w, 0, 0, 40, 0);
    const m = bbMouths(w.robots[0].spec)[0];
    const b = put(w, '2d', 'red', (m.x0 + m.x1) / 2 + 0.4, 40);
    const place = (): void => {
      b.state = { kind: 'ground' };
      b.pos = { x: (m.x0 + m.x1) / 2 + 0.4, y: 40 };
      b.vel = { x: 0, y: 0 };
    };
    return { w, b, place };
  };
  {
    // an IMMEDIATE sorter eject on the first instance (QA4): a WARNING and nothing more
    const { w, b } = atMouth(mech('dumper', { kind: 'sweeper', reject: 'reverse' }));
    drive(w, { 0: cmd({ intake: true }) }, 1.2);
    check(
      'G408 incidental: an auto-reverse sorter that throws it straight back is ONE WARNING and no card (QA4)',
      b.state.kind !== 'held' && g408n(w) === 1 && cards(w, 'G408') === 0,
      `state=${b.state.kind} g408=${g408n(w)} ${lines(w, 'G408').join(' | ')}`,
    );
  }
  {
    // held past MOMENTARY on the FIRST instance: STRATEGIC (QA4: keeping it is not ejecting it)
    const { w, b } = atMouth(MIXED);
    drive(w, { 0: cmd({ intake: true }) }, 0.4);
    const heldAt = b.state.kind;
    drive(w, { 0: cmd({}) }, BB_MOMENTARY_S - 0.6);
    check('G408: held under MOMENTARY it is still a WARNING only', heldAt === 'held' && g408n(w) === 1 && cards(w, 'G408') === 0, lines(w, 'G408').join(' | '));
    drive(w, { 0: cmd({}) }, 0.6);
    check(
      'G408 STRATEGIC: the opponent’s NECTAR held past MOMENTARY draws the YELLOW CARD on the first instance',
      g408n(w) === 1 && cards(w, 'G408') === 1 && lines(w, 'past MOMENTARY').length === 1,
      lines(w, 'G408').join(' | '),
    );
    drive(w, { 0: cmd({}) }, 3);
    check('G408: ...once per MATCH, however long it is kept', cards(w, 'G408') === 1 && w.penalties.carded[0] === 'yellow', lines(w, 'G408').join(' | '));
  }
  {
    // a drop and re-take inside BB_CONTROL_REARM_S is ONE instance
    const { w, place } = atMouth(MIXED);
    drive(w, { 0: cmd({ intake: true }) }, 0.4);
    drive(w, { 0: cmd({ bbReverse: true }) }, 0.2);
    place();
    drive(w, { 0: cmd({ intake: true }) }, 0.4);
    check('G408: dropped and re-taken inside the re-arm window is ONE instance, no card', g408n(w) === 1 && cards(w, 'G408') === 0, `g408=${g408n(w)}`);
    drive(w, { 0: cmd({ bbReverse: true }) }, 0.2);
    drive(w, { 0: cmd({}) }, BB_CONTROL_REARM_S + 0.2);
    place();
    drive(w, { 0: cmd({ intake: true }) }, 0.4);
    check('G408: ...and re-taken after it, the second instance is REPEATED: the YELLOW CARD', g408n(w) === 2 && cards(w, 'G408') === 1, `g408=${g408n(w)}`);
  }
  {
    // G204: a red robot drives its own NECTAR into blue's running intake while blue sits still
    const shove = (redDrives: boolean): { w: World; taken: boolean } => {
      const w = field('2d', [
        { id: 0, alliance: 'blue', spec: MIXED },
        { id: 1, alliance: 'red' },
      ]);
      pose(w, 0, 0, 40, 0);
      const eb = footprintExtents(w.robots[0].spec);
      const er = footprintExtents(w.robots[1].spec);
      const nx = eb.front + BB_NECTAR_R + 1.5;
      const b = put(w, '2d', 'red', nx, 40);
      pose(w, 1, nx + BB_NECTAR_R + er.front + 0.3, 40, 180);
      let taken = false;
      for (let i = 0; i < 60; i++) {
        drive(w, { 0: cmd({ intake: true }), 1: cmd({ driveY: redDrives ? 0.7 : 0 }) }, SIM_DT);
        taken ||= b.state.kind === 'held';
      }
      drive(w, { 0: cmd({ bbReverse: true }), 1: cmd({}) }, 0.3);
      return { w, taken };
    };
    const forced = shove(true);
    check(
      'G408 G204: an opponent SHOVING its NECTAR into a parked robot’s running intake is not that robot’s violation',
      forced.taken && g408n(forced.w) === 0 && warns(forced.w, 'G408') === 0,
      `taken=${forced.taken} g408=${g408n(forced.w)} ${lines(forced.w, 'G408').join(' | ')}`,
    );
  }

  // ═══ G407 — the YELLOW CARD, and the third MOMENTARY five ═════════════════════════════════════
  {
    // a placed count: the hopper reads 5 for a short burst, then 4 — three times, each burst a
    // separate instance (out of control for longer than the re-arm window in between)
    const w = field('2d', [{ id: 0, alliance: 'blue' }]);
    const r = w.robots[0];
    const tick = (s: number): void => {
      for (let i = 0; i < Math.round(s / SIM_DT); i++) {
        updateBiobuzzPenalties(w, SIM_DT, new Map());
        w.time += SIM_DT;
      }
    };
    const burst = (): void => {
      r.hopper = ['yellow', 'yellow', 'yellow', 'yellow', 'yellow'];
      tick(0.5);
      r.hopper = ['yellow', 'yellow', 'yellow', 'yellow'];
      tick(BB_CONTROL_REARM_S + 0.5);
    };
    burst();
    burst();
    check('G407: two MOMENTARY fives are two WARNINGS and nothing else (orange box C)', warns(w, 'G407') === 2 && majors(w, 'G407') === 0 && cards(w, 'G407') === 0, lines(w, 'G407').join(' | '));
    burst();
    check(
      'G407 STRATEGIC: the THIRD momentary five this match is a MAJOR and a YELLOW CARD (TU05, QA23)',
      warns(w, 'G407') === 3 && majors(w, 'G407') === 1 && cards(w, 'G407') === 1 && w.match.scores.red.foulPoints === 20,
      lines(w, 'G407').join(' | '),
    );
    burst();
    check('G407: a fourth is another MAJOR (billed per instance, owner ruling 2026-09-22) and no second card', majors(w, 'G407') === 2 && cards(w, 'G407') === 1, lines(w, 'G407').join(' | '));
  }
  {
    // a count that FLICKERS 5-4-5 inside the re-arm window is ONE instance, so it cannot buy the escalation
    const w = field('2d', [{ id: 0, alliance: 'blue' }]);
    const r = w.robots[0];
    for (let k = 0; k < 6; k++) {
      r.hopper = Array.from({ length: k % 2 === 0 ? 5 : 4 }, () => 'yellow' as const);
      for (let i = 0; i < 6; i++) {
        updateBiobuzzPenalties(w, SIM_DT, new Map());
        w.time += SIM_DT;
      }
    }
    check('G407: a count flickering 5-4-5 inside the re-arm window is ONE instance', warns(w, 'G407') === 1 && majors(w, 'G407') === 0, lines(w, 'G407').join(' | '));
  }
  for (const physics of ['2d', '3d'] as const) {
    for (const patch of [undefined, 12] as const) {
      // six herded across the floor for six seconds: STRATEGIC by (A), the MAJOR — and the card
      const w = field(physics, [{ id: 0, alliance: 'blue' }], patch);
      pose(w, 0, -55, 40, 0);
      const e = footprintExtents(w.robots[0].spec);
      for (let i = 0; i < 6; i++) put(w, physics, 'yellow', -55 + e.front + BB_POLLEN_R + 1, 40 - 8 + i * 3.2);
      drive(w, { 0: cmd({ driveY: 1 }) }, 6);
      if (patch === undefined) {
        check(
          `G407 STRATEGIC (${physics}): six herded past MOMENTARY is a MAJOR and a YELLOW CARD, the card once`,
          majors(w, 'G407') >= 1 && cards(w, 'G407') === 1 && w.penalties.carded[0] === 'yellow',
          lines(w, 'G407').join(' | '),
        );
      } else {
        check(
          `G407 replay (${physics}): a world stamped SIM_PATCH 12 bills the MAJOR and no card`,
          majors(w, 'G407') >= 1 && cards(w, 'G407') === 0,
          lines(w, 'G407').join(' | '),
        );
      }
    }
  }

  // ═══ 3D — ON TOP OF THE ROBOT IS CONTROL (QA34) ═══════════════════════════════════════════════
  for (const physics of ['2d', '3d'] as const) {
    // a full hopper and a POLLEN dropped onto the robot's top plate
    const w = field(physics, [{ id: 0, alliance: 'blue' }]);
    pose(w, 0, -40, 40, 0);
    const r = w.robots[0];
    r.hopper = ['yellow', 'yellow', 'yellow', 'yellow'];
    const b = put(w, physics, 'yellow', -40, 40);
    b.state = { kind: 'flight', target: 'blue' };
    b.z = 30;
    drive(w, { 0: cmd({}) }, 2);
    if (physics === '3d') {
      check(
        'G407 (3d): a POLLEN resting ON TOP of a robot with a full hopper is its fifth CONTROLLED element (QA34)',
        b.z > 5 && Math.abs(b.pos.x - r.pos.x) < 8 && warns(w, 'G407') === 1,
        `z=${b.z.toFixed(2)} dx=${(b.pos.x - r.pos.x).toFixed(1)} ${lines(w, 'G407').join(' | ')}`,
      );
    } else {
      // 2D has no top plate: the element lands on the tiles and is pushed clear of the footprint
      check('G407 (2d): an element dropped on a parked robot is not counted (it is not on it)', warns(w, 'G407') === 0, lines(w, 'G407').join(' | '));
    }
  }
}
