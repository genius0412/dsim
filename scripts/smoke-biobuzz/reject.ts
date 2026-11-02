import type { Artifact, RobotCommand, RobotSpec, RobotState, World } from '../../src/types';
import { SIM_DT } from '../../src/config';
import { localizeCommand } from '../../src/net/protocol';
import { capturePollen } from '../../src/games/biobuzz/elements';
import {
  BB_HALF_X,
  BB_NECTAR_R,
  BB_RAMP_BAR_E,
  BB_RAMP_DEPLOY_S,
  BB_SORT_DETECT_S,
  BB_SORT_IGNORE_S,
  BB_SORT_PASS_S,
} from '../../src/games/biobuzz/config';
import { type BbIntakeSpec, bbHasNectarBar, bbHasRampBar, bbIntakeAccepts, bbNectarRejectOf } from '../../src/games/biobuzz/mechs';
import { bbMouths, bbRampPose, bbRampSettled, bbRampSwingProgress, mouthAxes } from '../../src/games/biobuzz/robot';
import { bbBarDown, bbOnCapture } from '../../src/games/biobuzz/nectarReject';
import { BB_CONTROL_REARM_S } from '../../src/games/biobuzz/penalties';
import { bbPollen } from '../../src/games/biobuzz/scenes';
import { bbSpecSheet } from '../../src/games/biobuzz/labels';
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
    /** the spec sheet as `label: value (sub)` rows, the way a leaderboard record prints it */
    const sheet = (spec: typeof s): string =>
      bbSpecSheet(spec)
        .map((r) => `${r.label}: ${r.value}${r.sub ? ` (${r.sub})` : ''}`)
        .join(' | ');
    check(
      'sorter spec: the spec sheet names the feed and the sorter, and a POLLEN-only intake has no sorter row',
      sheet(s).includes('(Front · POLLEN + NECTAR)') &&
        sheet(s).includes('Sorter: Pass-through') &&
        sheet(n).includes('Sorter: No sorter') &&
        !sheet(bbCoerce({ ...mech('dumper', { kind: 'sweeper', feed: 'pollen' }) })).includes('Sorter') &&
        sheet(bbCoerce({ ...mech('dumper', { kind: 'sweeper', feed: 'pollen' }) })).includes('POLLEN only'),
      sheet(s),
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
    // take it AGAIN: the second instance this match is REPEATED, and the card comes with it. Out
    // of control for longer than `BB_CONTROL_REARM_S` first — a re-take inside it is the same
    // instance (`SIM_PATCH` 13; checked on its own in `g408Checks`).
    run(w, cmd({}), BB_CONTROL_REARM_S + 0.2);
    red.pos = { x: (m.x0 + m.x1) / 2 + 0.4, y: 0 };
    red.vel = { x: 0, y: 0 };
    run(w, cmd({ intake: true }), 0.4);
    check(
      'G408: the second instance is REPEATED — a YELLOW CARD, once (TU06: even a sorter that throws it back)',
      g408(w) === 2 && w.penalties.carded[0] === 'yellow' && w.events.filter((e) => e.startsWith('YELLOW CARD')).length === 1,
      `g408=${g408(w)} card=${w.penalties.carded[0]}`,
    );
    run(w, cmd({ bbReverse: true }), 0.2);
    run(w, cmd({}), BB_CONTROL_REARM_S + 0.2);
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
  /** how far mouth 0's tip line (the ramp's `uOut`) stands out from the robot's centre */
  const tipLine = (r: RobotState): number => mouthAxes(bbMouths(r.spec)[0], r.spec.length / 2, r.spec.width / 2).uOut;
  const backToMouth = (r: RobotState, b: Artifact): void => {
    const m = bbMouths(r.spec)[0];
    b.state = { kind: 'ground' };
    b.pos = { x: (m.x0 + m.x1) / 2 + 0.4, y: 0 };
    b.vel = { x: 0, y: 0 };
  };
  {
    const { w, r } = staged(506, mech('dumper', { kind: 'sweeper', reject: 'bar' }));
    run(w, cmd({ bbBar: true }), SIM_DT);
    run(w, cmd({}), 0.3);
    const red = atMouth(w, r, 'red', 3);
    const blue = atMouth(w, r, 'blue', -3);
    const p = atMouth(w, r, 'yellow', 0);
    run(w, cmd({ intake: true }), 0.5);
    check('bar: down, the bar keeps EVERY NECTAR out — the robot’s own too — and a POLLEN passes under', red.state.kind === 'ground' && blue.state.kind === 'ground' && p.state.kind === 'held', `red=${red.state.kind} blue=${blue.state.kind} p=${p.state.kind}`);
    check('bar: ...so it never draws G408', g408(w) === 0, `g408=${g408(w)}`);
    check('bar: it is drawn state, on the robot, with a latch of its own', r.bbBarOut === true && r.bbRampOut === undefined && r.bbRampHeld === undefined && r.bbBarHeld === false);
    run(w, cmd({ bbBar: true }), SIM_DT);
    backToMouth(r, red);
    run(w, cmd({ intake: true }), 0.5);
    check('bar: lifted, NECTAR comes in again (the opponent’s included)', red.state.kind === 'held' || blue.state.kind === 'held', `red=${red.state.kind} blue=${blue.state.kind}`);
  }
  {
    // THE BAR HAS ITS OWN BUTTON (`SIM_PATCH` 11). Before it a `bar` sorter's bar rode the ramp's
    // button, and a replay recorded then still drops it that way.
    const drop = (patch: number | undefined, c: Partial<RobotCommand>): RobotState => {
      const { w, r } = staged(512, mech('dumper', { kind: 'sweeper', reject: 'bar' }));
      if (patch !== undefined) w.simPatch = patch;
      run(w, cmd(c), SIM_DT);
      run(w, cmd({}), 0.3);
      return r;
    };
    check('bar: the ramp button drops no bar on a build with no ramp', drop(undefined, { bbRamp: true }).bbBarOut === undefined);
    check(
      'bar: ...but a replay recorded at SIM_PATCH 10 drops it with the ramp button, and ignores the bar button',
      drop(10, { bbRamp: true }).bbBarOut === true && drop(10, { bbBar: true }).bbBarOut === undefined,
    );
  }
  {
    // A RAMP DOUBLES AS A NECTAR BAR (owner, 2026-11-01: "If someone has a flower ramp, it should be
    // able to double as a nectar bar. It may need another button for control in that case."). No
    // sorter picked: every POLLEN + NECTAR ramp has it. The bar button holds the ramp part-way; the
    // ramp button still lays it flat for a FLOWER.
    const { w, r } = staged(507, mech('dumper', { kind: 'ramp' }));
    check('ramp bar: every POLLEN + NECTAR ramp has the bar, with no sorter picked', bbHasRampBar(r.spec) && bbHasNectarBar(r.spec) && bbNectarRejectOf(r.spec) === 'none');
    run(w, cmd({ bbBar: true }), SIM_DT);
    run(w, cmd({}), 10 * SIM_DT);
    check('ramp bar: mid-swing it is no bar yet', !bbBarDown(w, r) && bbRampSwingProgress(r, w.time) !== null);
    run(w, cmd({}), 0.2);
    check(
      'ramp bar: the bar button swings the ramp to BB_RAMP_BAR_E and holds it there — not deployed, so no FLOWER reach',
      bbRampPose(r, w.time) === BB_RAMP_BAR_E && r.bbBarOut === true && !r.bbRampOut && !bbRampSettled(r, w.time) && bbBarDown(w, r),
      `pose=${bbRampPose(r, w.time)} bar=${r.bbBarOut} ramp=${r.bbRampOut}`,
    );
    const red = atMouth(w, r, 'red', 3);
    const blue = atMouth(w, r, 'blue', -3);
    const p = atMouth(w, r, 'yellow', 0);
    run(w, cmd({ intake: true }), 0.5);
    check('ramp bar: held at bar height it keeps every NECTAR out and a POLLEN passes under', red.state.kind === 'ground' && blue.state.kind === 'ground' && p.state.kind === 'held', `red=${red.state.kind} blue=${blue.state.kind} p=${p.state.kind}`);
    check('ramp bar: ...so no G408', g408(w) === 0, `g408=${g408(w)}`);

    run(w, cmd({ bbRamp: true }), SIM_DT);
    run(w, cmd({}), BB_RAMP_DEPLOY_S * (1 - BB_RAMP_BAR_E) + SIM_DT);
    check(
      'ramp bar: the ramp button deploys it from the bar, in the share of the swing left (the same servo speed)',
      r.bbRampOut === true && !r.bbBarOut && bbRampSettled(r, w.time) && bbRampPose(r, w.time) === 1,
      `pose=${bbRampPose(r, w.time)} at=${r.bbRampAt} t=${w.time}`,
    );
    backToMouth(r, red);
    run(w, cmd({ intake: true }), 0.5);
    check('ramp bar: laid flat for a FLOWER it is no bar: a NECTAR rolls up it like a POLLEN', red.state.kind === 'held', `red=${red.state.kind}`);

    run(w, cmd({ bbBar: true }), SIM_DT);
    run(w, cmd({}), 0.3);
    check('ramp bar: the bar button from deployed swings straight back to bar height', bbRampPose(r, w.time) === BB_RAMP_BAR_E && !r.bbRampOut && bbBarDown(w, r));
    run(w, cmd({ bbBar: true }), SIM_DT);
    run(w, cmd({}), 0.3);
    check('ramp bar: the bar button again folds it', bbRampPose(r, w.time) === 0 && !r.bbBarOut && !bbBarDown(w, r));
  }
  {
    // nothing new on a ramp whose bar is never used, and nothing at all on a POLLEN-only ramp
    const a = staged(514, mech('dumper', { kind: 'ramp' }));
    run(a.w, cmd({ bbRamp: true }), SIM_DT);
    run(a.w, cmd({}), 0.4);
    check(
      'ramp bar: a ramp deployed without the bar swings as it always did — no `bbRampFrom`, no bar latch',
      a.r.bbRampOut === true && a.r.bbRampFrom === undefined && a.r.bbBarOut === undefined && a.r.bbBarHeld === undefined,
    );
    const b = staged(515, mech('turret', { kind: 'ramp' }));
    run(b.w, cmd({ bbBar: true }), SIM_DT);
    run(b.w, cmd({}), 0.3);
    check(
      'ramp bar: a POLLEN-only ramp has no NECTAR to keep out, so the bar button writes nothing',
      !bbHasRampBar(b.r.spec) && b.r.bbBarOut === undefined && b.r.bbRampFrom === undefined && b.r.bbBarHeld === undefined && bbRampPose(b.r, b.w.time) === 0,
    );
  }
  {
    // A REPLAY RECORDED AT SIM_PATCH 10: a ramp intake's `bar` sorter was its DEPLOYED ramp
    const { w, r } = staged(507, mech('dumper', { kind: 'ramp', reject: 'bar' }));
    w.simPatch = 10;
    run(w, cmd({ bbRamp: true }), SIM_DT);
    run(w, cmd({}), 0.5);
    const red = atMouth(w, r, 'red');
    run(w, cmd({ intake: true }), 0.5);
    check('bar @ patch 10: on a ramp intake the deployed ramp keeps NECTAR out, and no second bar is toggled', r.bbRampOut === true && r.bbBarOut === undefined && red.state.kind === 'ground', `ramp=${r.bbRampOut} red=${red.state.kind}`);
    run(w, cmd({ bbBar: true }), SIM_DT);
    check('bar @ patch 10: ...and the bar button does nothing', r.bbBarOut === undefined && r.bbRampFrom === undefined && r.bbBarHeld === undefined);
  }
  {
    // THE SWING GUARD, 2D: held part-way the ramp stands further out (`bbRampPlanReach`, 4.8 in)
    // than it lies deployed (3.54), so a bar swing tests its own reach, not the deployed one
    const near = (seed: number): { w: World; r: RobotState } => {
      const s = staged(seed, mech('dumper', { kind: 'ramp' }));
      s.r.pos = { x: BB_HALF_X - tipLine(s.r) - 4.2, y: -20 };
      return s;
    };
    const dep = near(516);
    run(dep.w, cmd({ bbRamp: true }), SIM_DT);
    run(dep.w, cmd({}), 0.4);
    const bar = near(517);
    run(bar.w, cmd({ bbBar: true }), SIM_DT);
    run(bar.w, cmd({}), 0.4);
    check(
      'ramp bar: 4.2 in from a wall the ramp deploys flat, but a bar swing meets the wall and folds back',
      bbRampSettled(dep.r, dep.w.time) && bbRampPose(bar.r, bar.w.time) === 0 && !bar.r.bbBarOut && bar.r.bbRampBlocked === true,
      `deployed=${bbRampSettled(dep.r, dep.w.time)} barPose=${bbRampPose(bar.r, bar.w.time)} blocked=${bar.r.bbRampBlocked}`,
    );
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
  {
    const { w, r } = staged(513, mech('dumper', { kind: 'ramp' }), true);
    steps(w, cmd({ bbBar: true }), SIM_DT, true);
    steps(w, cmd({}), 0.3, true);
    const down = bbBarDown(w, r);
    const red = atMouth(w, r, 'red');
    let held = false;
    for (let i = 0; i < 40; i++) {
      steps(w, cmd({ intake: true }), SIM_DT, true);
      if (red.state.kind === 'held') held = true;
    }
    check('3D: a ramp held at bar height keeps NECTAR out in the 3D pipeline too', down && !held && g408(w) === 0, `down=${down} held=${held} g408=${g408(w)}`);
  }
  {
    // held at bar height the ramp has the FOLDED collider set (it is not solid there), so the guard
    // asks each tick whether it meets anything, and folds it if it does
    const { w, r } = staged(518, mech('dumper', { kind: 'ramp' }), true);
    r.pos = { x: BB_HALF_X - 30, y: -20 };
    steps(w, cmd({ bbBar: true }), SIM_DT, true);
    steps(w, cmd({}), 0.3, true);
    const down = bbBarDown(w, r);
    let folded = false;
    for (let i = 0; i < 150 && !folded; i++) {
      steps(w, cmd({ driveY: 0.5 }), SIM_DT, true); // forward, toward +x
      folded = !r.bbBarOut;
    }
    const gap = BB_HALF_X - (r.pos.x + tipLine(r));
    check(
      '3D: driven at a wall, a ramp held at bar height folds when it meets it, its tip line still well clear',
      down && folded && r.bbRampBlocked === true && gap > 3 && gap < 5.5,
      `down=${down} folded=${folded} blocked=${r.bbRampBlocked} gap=${gap.toFixed(2)}`,
    );
  }

  // ── THE WIRE ──────────────────────────────────────────────────────────────────────────────────
  {
    const base: RobotCommand = { driveX: 0, driveY: 0, rotate: 0, leftDrive: 0, rightDrive: 0, intake: false, fire: false };
    check('wire: REVERSE survives the quantizer, and an unpressed one adds no key', localizeCommand({ ...base, bbReverse: true }).bbReverse === true && !('bbReverse' in localizeCommand(base)));
    check('wire: the NECTAR bar survives the quantizer, and an unpressed one adds no key', localizeCommand({ ...base, bbBar: true }).bbBar === true && !('bbBar' in localizeCommand(base)));
  }
}
