import type { Artifact, RobotCommand, RobotSpec, RobotState, World } from '../../src/types';
import { SIM_DT } from '../../src/config';
import { localizeCommand } from '../../src/net/protocol';
import { capturePollen } from '../../src/games/biobuzz/elements';
import { BB_NECTAR_R, BB_SORT_DETECT_S, BB_SORT_IGNORE_S, BB_SORT_PASS_S } from '../../src/games/biobuzz/config';
import { type BbIntakeSpec, bbIntakeAccepts, bbNectarRejectOf } from '../../src/games/biobuzz/mechs';
import { bbMouths } from '../../src/games/biobuzz/robot';
import { bbOnCapture } from '../../src/games/biobuzz/nectarReject';
import { bbPollen } from '../../src/games/biobuzz/scenes';
import { bbConfigSummary } from '../../src/games/biobuzz/labels';
import { biobuzzStep } from '../../src/games/biobuzz/step';
import { step3d } from '../../src/games/biobuzz/sim3d/step3d';
import { type Check, bbCoerce, cmd, mkWorld, mkWorld3d, run } from './harness';

/**
 * THE OPPONENT'S NECTAR (2026-10-24, `SIM_PATCH` 10) — `src/games/biobuzz/nectarReject.ts` and G408.
 *
 * A POLLEN + NECTAR intake takes the opponent's NECTAR (a roller cannot see colour), holding one
 * is a G408 WARNING and a REPEATED one a YELLOW CARD (TU06), and the robot gets rid of it four
 * ways: the driver's REVERSE, an auto-reverse sorter, a pass-through sorter, or a NECTAR bar that
 * keeps it out in the first place. During AUTO, taking any element off the opponent's half is
 * G402 (TU06's first example). Every scene is the real pipeline, stepped.
 *
 * The robot is BLUE (`mkWorld`), so the opponent's NECTAR is RED throughout.
 */

const mech = (launcher: string, intake: BbIntakeSpec): Partial<RobotSpec> => ({
  intakeMount: 'front',
  bbMech: { launcher: { kind: launcher, mount: launcher === 'dumper' || launcher === 'fixed' ? 'back' : 'center', hoodDeg: 75 }, lift: null, intake },
} as unknown as Partial<RobotSpec>);

const nextId = (w: World): number => w.balls.reduce((m, b) => Math.max(m, b.id), 0) + 1;

/** a one-robot world, hopper emptied onto a far corner, robot parked at the centre facing +x */
function staged(seed: number, spec: Partial<RobotSpec>, d3 = false): { w: World; r: RobotState } {
  const w = d3 ? mkWorld3d('free', seed, spec) : mkWorld('free', seed, spec);
  const r = w.robots[0];
  let k = 0;
  for (const b of w.balls) {
    if (b.state.kind !== 'held' || b.state.robot !== r.id) continue;
    b.state = { kind: 'ground' };
    b.pos = { x: -64 + k * 3.2, y: -40 };
    b.vel = { x: 0, y: 0 };
    k++;
  }
  r.hopper.length = 0;
  r.pos = { x: 0, y: 0 };
  r.heading = 0;
  r.vel = { x: 0, y: 0 };
  r.angVel = 0;
  r.autoIntake = false;
  return { w, r };
}

/** an element of `colour` on the tiles in the middle of mouth 0, `dy` across it */
function atMouth(w: World, r: RobotState, colour: Artifact['color'], dy = 0): Artifact {
  const m = bbMouths(r.spec)[0];
  const nectar = colour === 'red' || colour === 'blue';
  const b: Artifact = { ...bbPollen(nextId(w), (m.x0 + m.x1) / 2 + (nectar ? 0.4 : 0), dy), color: colour, ...(nectar ? { r: BB_NECTAR_R } : {}) };
  w.balls.push(b);
  if (w.biobuzz) w.biobuzz.nextBallId = b.id + 1;
  return b;
}

function steps(w: World, c: RobotCommand, seconds: number, d3: boolean): void {
  const cmds = new Map([[0, c]]);
  const n = Math.round(seconds / SIM_DT);
  for (let i = 0; i < n; i++) (d3 ? step3d : biobuzzStep)(w, SIM_DT, cmds);
}

const g408 = (w: World): number => w.biobuzz?.g408?.[0] ?? 0;

export function rejectChecks(check: Check): void {
  // ── THE SPEC ──────────────────────────────────────────────────────────────────────────────────
  {
    const s = bbCoerce({ ...mech('turret', { kind: 'sweeper', feed: 'mixed', reject: 'passthrough' }) });
    check('sorter spec: a single turret built POLLEN + NECTAR keeps its sorter', bbNectarRejectOf(s) === 'passthrough' && s.bbMech!.intake!.reject === 'passthrough');
    const p = bbCoerce({ ...mech('turret', { kind: 'sweeper', feed: 'pollen', reject: 'bar' }) });
    check('sorter spec: a POLLEN-only intake carries no sorter (it never takes a NECTAR)', bbNectarRejectOf(p) === 'none' && p.bbMech!.intake!.reject === undefined);
    const n = bbCoerce({ ...mech('dumper', { kind: 'sweeper', reject: 'none' }) });
    check('sorter spec: `none` is never written, so an old dumper coerces to the bytes it had', n.bbMech!.intake!.reject === undefined && n.bbMech!.intake!.feed === undefined);
    check('sorter spec: a sorter is a fixed point of the coercer', JSON.stringify(bbCoerce(s)) === JSON.stringify(s));
    check(
      'sorter spec: the config line names a feed the launcher does not imply, and any sorter — and nothing for an old build',
      bbConfigSummary(s).includes('POLLEN + NECTAR · Pass-through') && !bbConfigSummary(n).includes('NECTAR') &&
        bbConfigSummary(bbCoerce({ ...mech('dumper', { kind: 'sweeper', feed: 'pollen' }) })).includes('POLLEN only'),
      bbConfigSummary(s),
    );
  }

  // ── WITH NO SORTER: TAKEN, WARNED, AND THE DRIVER REVERSES IT OUT ─────────────────────────────
  {
    const { w, r } = staged(501, mech('dumper', { kind: 'sweeper' }));
    const red = atMouth(w, r, 'red');
    run(w, cmd({ intake: true }), 0.4);
    check('no sorter: a POLLEN + NECTAR intake takes the opponent’s NECTAR', red.state.kind === 'held', `state=${red.state.kind}`);
    check('no sorter: ...and holding it is ONE G408 warning, no points', g408(w) === 1 && w.events.some((e) => e.startsWith('WARNING - BLUE (G408')) && w.match.scores.red.foulPoints === 0, `g408=${g408(w)}`);
    run(w, cmd({ intake: true }), 1);
    check('no sorter: held for a second more it is still ONE instance', g408(w) === 1, `g408=${g408(w)}`);
    run(w, cmd({ bbReverse: true }), 0.2);
    const m = bbMouths(r.spec)[0];
    check('reverse: the driver’s REVERSE spits it back out of the mouth', red.state.kind === 'ground' && red.pos.x > m.x1, `state=${red.state.kind} x=${red.pos.x.toFixed(2)} mouth=${m.x1.toFixed(2)}`);
    check('reverse: ...moving out along the mouth', red.vel.x > 10, `vx=${red.vel.x.toFixed(1)}`);
    // take it AGAIN: the second instance this match is REPEATED, and the card comes with it
    red.pos = { x: (m.x0 + m.x1) / 2 + 0.4, y: 0 };
    red.vel = { x: 0, y: 0 };
    run(w, cmd({ intake: true }), 0.4);
    check(
      'G408: the second instance is REPEATED — a YELLOW CARD, once (TU06: even a sorter that throws it back)',
      g408(w) === 2 && w.penalties.carded[0] === 'yellow' && w.events.filter((e) => e.startsWith('YELLOW CARD')).length === 1,
      `g408=${g408(w)} card=${w.penalties.carded[0]}`,
    );
    run(w, cmd({ bbReverse: true }), 0.2);
    red.pos = { x: (m.x0 + m.x1) / 2 + 0.4, y: 0 };
    red.vel = { x: 0, y: 0 };
    run(w, cmd({ intake: true }), 0.4);
    check('G408: a third instance warns again and is not a second card', g408(w) === 3 && w.penalties.carded[0] === 'yellow', `g408=${g408(w)} card=${w.penalties.carded[0]}`);
  }
  {
    // REVERSE WINS OVER INTAKE, and empties the hopper last in first out
    const { w, r } = staged(502, mech('dumper', { kind: 'sweeper' }));
    const give = (c: Artifact['color']): Artifact => {
      const b: Artifact = { ...bbPollen(nextId(w), 0, 0), color: c };
      w.balls.push(b);
      capturePollen(w, r, b);
      return b;
    };
    const a = give('yellow');
    const b = give('yellow');
    const p = atMouth(w, r, 'yellow', 3);
    // one element per BB_REVERSE_PERIOD_S off the last capture: the first leaves at 0.15 s
    run(w, cmd({ intake: true, bbReverse: true }), 0.2);
    check('reverse: LIFO — the last element in is the first out, one per period', b.state.kind === 'ground' && a.state.kind === 'held', `a=${a.state.kind} b=${b.state.kind}`);
    run(w, cmd({ intake: true, bbReverse: true }), 0.4);
    check('reverse: held with intake, it wins: the hopper empties and the POLLEN at the mouth is not taken', r.hopper.length === 0 && p.state.kind === 'ground', `hopper=${r.hopper.join(',')} p=${p.state.kind}`);
  }

  // ── AUTO-REVERSE ──────────────────────────────────────────────────────────────────────────────
  {
    const { w, r } = staged(503, mech('dumper', { kind: 'sweeper', reject: 'reverse' }));
    const red = atMouth(w, r, 'red');
    let heldAt = -1;
    let outAt = -1;
    for (let i = 0; i < 90; i++) {
      run(w, cmd({ intake: true }), SIM_DT);
      if (heldAt < 0 && red.state.kind === 'held') heldAt = w.time;
      if (heldAt >= 0 && outAt < 0 && red.state.kind === 'ground') outAt = w.time;
    }
    check(
      'auto-reverse: the sensor throws an opponent NECTAR back out on its own, BB_SORT_DETECT_S after it came in',
      heldAt >= 0 && outAt >= 0 && Math.abs(outAt - heldAt - BB_SORT_DETECT_S) < 2 * SIM_DT + 1e-9,
      `held=${heldAt.toFixed(3)} out=${outAt.toFixed(3)}`,
    );
    check('auto-reverse: ...and it still CONTROLLED it: one G408 warning', g408(w) === 1, `g408=${g408(w)}`);
    check('auto-reverse: ...and its own intake does not take it straight back (the ignore window)', red.state.kind === 'ground', `state=${red.state.kind}`);
  }
  {
    // nothing comes in while it reverses
    const { w, r } = staged(504, mech('dumper', { kind: 'sweeper', reject: 'reverse' }));
    const red = atMouth(w, r, 'red');
    for (let i = 0; i < 60 && red.state.kind !== 'held'; i++) run(w, cmd({ intake: true }), SIM_DT);
    run(w, cmd({ intake: true }), BB_SORT_DETECT_S + 2 * SIM_DT);
    const p = atMouth(w, r, 'yellow', -3);
    run(w, cmd({ intake: true }), 0.1);
    check('auto-reverse: a POLLEN at the mouth while the intake runs backwards is not taken', p.state.kind === 'ground' && (w.biobuzz?.sortRev?.[0] ?? 0) > w.time, `p=${p.state.kind}`);
    run(w, cmd({ intake: true }), 0.6);
    check('auto-reverse: ...and is taken once the window is over', p.state.kind === 'held', `p=${p.state.kind}`);
  }

  // ── PASS-THROUGH ──────────────────────────────────────────────────────────────────────────────
  {
    const { w, r } = staged(505, mech('turret', { kind: 'sweeper', feed: 'mixed', reject: 'passthrough' }));
    const red = atMouth(w, r, 'red');
    for (let i = 0; i < 60 && red.state.kind !== 'held'; i++) run(w, cmd({ intake: true }), SIM_DT);
    const inAt = w.time;
    const p = atMouth(w, r, 'yellow', 3);
    run(w, cmd({ intake: true }), 0.25);
    check('pass-through: the rollers never stop — a POLLEN is taken while the NECTAR is in transit', red.state.kind === 'held' && p.state.kind === 'held', `red=${red.state.kind} p=${p.state.kind}`);
    run(w, cmd({ intake: true }), BB_SORT_PASS_S);
    const m = bbMouths(r.spec)[0];
    check(
      'pass-through: ...and it drops back out of the mouth it came in by, with no reverse',
      red.state.kind === 'ground' && red.pos.x > m.x0 && w.biobuzz?.sortRev === undefined && w.time - inAt >= BB_SORT_PASS_S,
      `red=${red.state.kind} x=${red.pos.x.toFixed(2)}`,
    );
    run(w, cmd({ intake: true }), BB_SORT_IGNORE_S + 0.1);
    check('pass-through: the queue empties itself once the ignore window ends (nothing new on the wire)', w.biobuzz?.sorter === undefined || (w.biobuzz.sorter[0] ?? []).every((e) => !e.out || e.id !== red.id));
  }

  // ── THE NECTAR BAR ────────────────────────────────────────────────────────────────────────────
  {
    const { w, r } = staged(506, mech('dumper', { kind: 'sweeper', reject: 'bar' }));
    run(w, cmd({ bbRamp: true }), SIM_DT);
    run(w, cmd({}), 0.3);
    const red = atMouth(w, r, 'red', 3);
    const blue = atMouth(w, r, 'blue', -3);
    const p = atMouth(w, r, 'yellow', 0);
    run(w, cmd({ intake: true }), 0.5);
    check('bar: down, the bar keeps EVERY NECTAR out — the robot’s own too — and a POLLEN passes under', red.state.kind === 'ground' && blue.state.kind === 'ground' && p.state.kind === 'held', `red=${red.state.kind} blue=${blue.state.kind} p=${p.state.kind}`);
    check('bar: ...so it never draws G408', g408(w) === 0, `g408=${g408(w)}`);
    check('bar: it is drawn state, on the robot', r.bbBarOut === true && r.bbRampOut === undefined);
    run(w, cmd({ bbRamp: true }), SIM_DT);
    red.pos = { x: (bbMouths(r.spec)[0].x0 + bbMouths(r.spec)[0].x1) / 2 + 0.4, y: 0 };
    red.vel = { x: 0, y: 0 };
    run(w, cmd({ intake: true }), 0.5);
    check('bar: lifted, NECTAR comes in again (the opponent’s included)', red.state.kind === 'held' || blue.state.kind === 'held', `red=${red.state.kind} blue=${blue.state.kind}`);
  }
  {
    // ON A RAMP INTAKE THE RAMP IS THE BAR
    const { w, r } = staged(507, mech('dumper', { kind: 'ramp', reject: 'bar' }));
    run(w, cmd({ bbRamp: true }), SIM_DT);
    run(w, cmd({}), 0.5);
    const red = atMouth(w, r, 'red');
    run(w, cmd({ intake: true }), 0.5);
    check('bar: on a ramp intake the deployed ramp keeps NECTAR out, and no second bar is toggled', r.bbRampOut === true && r.bbBarOut === undefined && red.state.kind === 'ground', `ramp=${r.bbRampOut} red=${red.state.kind}`);
  }

  // ── G402, TU06's FIRST EXAMPLE: AUTO, AN ELEMENT FROM THE OPPONENT'S HALF ────────────────────
  {
    const make = (patch?: number): { w: World; r: RobotState; b: Artifact } => {
      const { w, r } = staged(508, mech('turret', { kind: 'sweeper' }));
      w.match.phase = 'auto';
      if (patch !== undefined) w.simPatch = patch;
      const b: Artifact = { ...bbPollen(nextId(w), -10, 0) };
      w.balls.push(b);
      capturePollen(w, r, b);
      bbOnCapture(w, r, b, 0);
      return { w, r, b };
    };
    const live = make();
    check('G402: in AUTO, blue taking an element from red’s half (x < 0) is a MAJOR — 20 to red', live.w.match.fouls.blue.major === 1 && live.w.match.scores.red.foulPoints === 20, `major=${live.w.match.fouls.blue.major}`);
    const old = make(9);
    check('G402: ...not in a replay recorded before SIM_PATCH 10', old.w.match.fouls.blue.major === 0);
    const { w, r } = staged(509, mech('turret', { kind: 'sweeper' }));
    w.match.phase = 'auto';
    const own: Artifact = { ...bbPollen(nextId(w), 10, 0) };
    w.balls.push(own);
    capturePollen(w, r, own);
    bbOnCapture(w, r, own, 0);
    check('G402: ...and taking one from its own half is nothing', w.match.fouls.blue.major === 0);
  }

  // ── THE PATCH GATE, THROUGH THE WORLD ─────────────────────────────────────────────────────────
  {
    const { w, r } = staged(510, mech('dumper', { kind: 'sweeper' }));
    w.simPatch = 9;
    const red = atMouth(w, r, 'red');
    run(w, cmd({ intake: true }), 0.4);
    check('patch gate: a world stamped SIM_PATCH 9 still refuses the opponent’s NECTAR at the intake', red.state.kind === 'ground' && !bbIntakeAccepts(r.spec, 'blue', 'red', false));
  }

  // ── 3D: THE SAME SORTER ───────────────────────────────────────────────────────────────────────
  {
    const { w, r } = staged(511, mech('dumper', { kind: 'sweeper', reject: 'reverse' }), true);
    const red = atMouth(w, r, 'red');
    let held = false;
    for (let i = 0; i < 90; i++) {
      steps(w, cmd({ intake: true }), SIM_DT, true);
      if (red.state.kind === 'held') held = true;
    }
    check('3D: the auto-reverse sorter takes and throws back an opponent NECTAR in the 3D pipeline too', held && red.state.kind !== 'held' && g408(w) === 1, `held=${held} state=${red.state.kind} g408=${g408(w)}`);
  }

  // ── THE WIRE ──────────────────────────────────────────────────────────────────────────────────
  {
    const base: RobotCommand = { driveX: 0, driveY: 0, rotate: 0, leftDrive: 0, rightDrive: 0, intake: false, fire: false };
    check('wire: REVERSE survives the quantizer, and an unpressed one adds no key', localizeCommand({ ...base, bbReverse: true }).bbReverse === true && !('bbReverse' in localizeCommand(base)));
  }
}
