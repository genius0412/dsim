import type { Artifact, RobotCommand, RobotState, Vec2, World } from '../../types';
import { rot } from '../../math';
import { simPatchAtLeast } from '../../config';
import { debouncedPress } from '../../sim/robot';
import {
  BB_BAR_DEPLOY_S,
  BB_EJECT_SPEED,
  BB_HALF_X,
  BB_HALF_Y,
  BB_POLLEN_R,
  BB_REVERSE_PERIOD_S,
  BB_SORT_DETECT_S,
  BB_SORT_IGNORE_S,
  BB_SORT_PASS_S,
  BB_SORT_REVERSE_S,
} from './config';
import { bbAutoSorts, bbIntakeKindOf, bbNectarRejectOf } from './mechs';
import { bbAwardFoul } from './penalties';
import { bbMouths, bbRampSettled, mouthAxes } from './robot';
import type { BbSortEntry } from './state';

/**
 * BIOBUZZ — RUNNING THE INTAKE BACKWARDS, AND THE OPPONENT-NECTAR SORTERS (owner, 2026-10-24).
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Until `SIM_PATCH` 10 every intake refused the opponent's NECTAR at the roller, which is a thing
 * no hardware can do: a roller does not see colour. TU06 put the real rule in writing under G408:
 * "REPEATED instances of a ROBOT CONTROLLING an opponent's NECTAR are likely to be perceived as
 * STRATEGIC, even if the ROBOT has a sorting mechanism that automatically discards opponent NECTAR
 * by returning it to approximately its original state." So a POLLEN + NECTAR intake now takes the
 * opponent's NECTAR (`bbIntakeAccepts`), `penalties.ts` bills the CONTROL, and this file is what a
 * robot can do about it (`BbNectarReject`, `mechs.ts`):
 *
 *  · REVERSE, every build, the driver's button (`RobotCommand.bbReverse`): the held elements go
 *    back out of the mouth, last in first out, one per `BB_REVERSE_PERIOD_S`, and nothing comes in
 *    while it is held.
 *  · `reverse`: the same thing, triggered by a colour sensor, for one element. Seen
 *    `BB_SORT_DETECT_S` after the capture; then the intake runs backwards for `BB_SORT_REVERSE_S`
 *    and the reject leaves first.
 *  · `passthrough`: no reverse. The reject is routed through and drops back out of the mouth it
 *    came in by `BB_SORT_PASS_S` after the capture, while the rollers keep taking the rest.
 *  · `bar`: a bar across the mouth, toggled with `bbRamp`, under which a POLLEN passes and a NECTAR
 *    does not. It is the only one of the four that keeps the opponent's NECTAR out, so the only one
 *    that never draws G408. On a `ramp` intake the deployed ramp is the bar.
 *
 * ── ONE WRITER FOR "HELD → GROUND AT THE MOUTH" ─────────────────────────────
 * `bbEject` is it, for all four. It writes a `ground` element just past the roller line with the
 * robot's velocity plus `BB_EJECT_SPEED` out along the mouth's normal. That is all either pipeline
 * needs: 2D's solve picks it up as any ground element, and 3D's `syncElement` builds it a body on
 * the next tick, the way a side roller's FLOWER release does (`sim3d/flower3d.ts`).
 *
 * ── STATE ───────────────────────────────────────────────────────────────────
 * `BiobuzzState.sorter` (the queue and the ignore list), `.sortRev` (a `reverse` sorter's backwards
 * window) and `RobotState.bbBarOut`/`bbBarAt` (the bar, which the renderers draw). Every one of them
 * is ABSENT on a robot that never sorted or never had a bar, so a match without them steps and
 * ships exactly what it did before.
 *
 * PIPELINE-BLIND: `play.ts` (2D) and `sim3d/elements3d.ts` (3D) call the same three functions at
 * the same point, right before the intake, so the two cannot disagree about what a sorter does.
 */

const isNectar = (c: string): boolean => c === 'red' || c === 'blue';

/** gap (in) left between the roller line and an ejected element's skin, so it is born clear of
 * the robot that threw it */
const EJECT_CLEAR = 0.3;

// ─────────────────────────────────────────────────────────────────────────────
// THE BAR
// ─────────────────────────────────────────────────────────────────────────────

/** is this robot's NECTAR bar down and keeping NECTAR out RIGHT NOW? A `ramp` intake's bar is its
 * ramp, deployed and settled; any other intake's is `bbBarOut`, once `BB_BAR_DEPLOY_S` has passed. */
export function bbBarDown(r: RobotState, time: number): boolean {
  if (bbNectarRejectOf(r.spec) !== 'bar') return false;
  if (bbIntakeKindOf(r.spec) === 'ramp') return bbRampSettled(r, time);
  return !!r.bbBarOut && time - (r.bbBarAt ?? -Infinity) >= BB_BAR_DEPLOY_S;
}

/**
 * DROP / LIFT THE BAR on the `bbRamp` button — the ramp's own toggle (`bbRampStep`), for a `bar`
 * build whose intake is not a ramp. The latch is the ramp's (`bbRampHeld`/`bbRampUpAt`): such a
 * build has no ramp, so nothing else writes it, and a second latch would be a second wire field
 * for the same button. Every other build writes nothing.
 */
export function bbBarStep(r: RobotState, cmd: RobotCommand | undefined, enabled: boolean, time: number): void {
  if (bbNectarRejectOf(r.spec) !== 'bar' || bbIntakeKindOf(r.spec) === 'ramp') return;
  const e = debouncedPress(r.bbRampHeld ?? false, r.bbRampUpAt, enabled && (cmd?.bbRamp ?? false), time);
  if (e.press) {
    r.bbBarOut = !(r.bbBarOut ?? false);
    r.bbBarAt = time;
  }
  r.bbRampHeld = e.held;
  if (e.upAt !== undefined || r.bbRampUpAt !== undefined) r.bbRampUpAt = e.upAt;
}

/**
 * THE ROBOT-STATE HALF OF "WILL THIS INTAKE TAKE `b`" — `BbIntakeOpts.takes` (`bbIntakeAct`). The
 * spec half is `bbIntakeAccepts`; this adds the bar and the sorter's ignore list.
 */
export function bbSorterTakes(world: World, r: RobotState, b: Artifact): boolean {
  if (isNectar(b.color) && bbBarDown(r, world.time)) return false;
  const q = world.biobuzz?.sorter?.[r.id];
  return !q || !q.some((e) => e.out && e.id === b.id);
}

// ─────────────────────────────────────────────────────────────────────────────
// EJECT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PUT A HELD ELEMENT BACK ON THE TILES, OUT OF MOUTH `mouth` — the one writer (see the header).
 *
 * The hopper loses one of its colour and the element becomes `ground` just past the roller line,
 * on the mouth's centre, moving at the robot's velocity plus `BB_EJECT_SPEED` outward. Kept inside
 * the walls by its own radius, so a robot reversing with its mouth on the wall drops it against
 * the wall rather than outside the field. A build with no mouth (an import fitted without one)
 * throws it off its front. Returns false, changing nothing, when `ball` is not held by `r`.
 */
export function bbEject(r: RobotState, ball: Artifact, mouth: number): boolean {
  if (ball.state.kind !== 'held' || ball.state.robot !== r.id) return false;
  const j = r.hopper.lastIndexOf(ball.color);
  if (j < 0) return false;
  r.hopper.splice(j, 1);
  const er = ball.r ?? BB_POLLEN_R;
  const mouths = bbMouths(r.spec);
  const m = mouths[mouth] ?? mouths[0];
  let local: Vec2;
  let n: Vec2;
  if (m) {
    const g = mouthAxes(m, r.spec.length / 2, r.spec.width / 2);
    n = g.n;
    const u = g.uOut + er + EJECT_CLEAR;
    local = { x: n.x * u + g.p.x * g.vc, y: n.y * u + g.p.y * g.vc };
  } else {
    n = { x: 1, y: 0 };
    local = { x: r.spec.length / 2 + er + EJECT_CLEAR, y: 0 };
  }
  const off = rot(local, r.heading);
  const out = rot(n, r.heading);
  const limX = BB_HALF_X - er;
  const limY = BB_HALF_Y - er;
  ball.pos = {
    x: Math.max(-limX, Math.min(limX, r.pos.x + off.x)),
    y: Math.max(-limY, Math.min(limY, r.pos.y + off.y)),
  };
  ball.vel = { x: r.vel.x + out.x * BB_EJECT_SPEED, y: r.vel.y + out.y * BB_EJECT_SPEED };
  ball.z = 0;
  ball.vz = 0;
  ball.state = { kind: 'ground' };
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// CAPTURE HOOK
// ─────────────────────────────────────────────────────────────────────────────

/**
 * AFTER A CAPTURE — called by both pipelines for each element `capturePollen` took, with the mouth
 * it came in by (`BbIntakeAct.mouth`). Two jobs:
 *
 *  1. **G402, TU06's first example**: "CONTROLLING SCORING ELEMENTS located on the opposing
 *     ALLIANCE'S side of the field" disrupts AUTO. During AUTO an element taken from wholly across
 *     the centre line (red plays x < 0, blue x > 0 — `bbIntrusion`'s split) is a MAJOR on the
 *     taker, once per element, like every G402 instance since the owner's 2026-09-22 ruling. An
 *     element straddling the line is not "located on" either side, so its centre has to be a full
 *     radius over. A passive dummy draws nothing, as everywhere in `penalties.ts`.
 *  2. **the sorter**: a `reverse` or `passthrough` build queues an opponent NECTAR to go back out.
 *
 * The element's `pos` is still where it was taken from: `capturePollen` changes its state and
 * leaves its position alone.
 */
export function bbOnCapture(world: World, r: RobotState, ball: Artifact, mouth: number): void {
  const bb = world.biobuzz;
  if (!bb || ball.state.kind !== 'held') return;
  if (world.match.phase === 'auto' && !r.passive && simPatchAtLeast(world, 10)) {
    const er = ball.r ?? BB_POLLEN_R;
    const across = r.alliance === 'red' ? ball.pos.x > er : ball.pos.x < -er;
    if (across) bbAwardFoul(world, r.alliance, 'major', 'G402 taking a SCORING ELEMENT from the opponent’s half in AUTO');
  }
  if (!isNectar(ball.color) || ball.color === r.alliance || !bbAutoSorts(r.spec)) return;
  const delay = bbNectarRejectOf(r.spec) === 'reverse' ? BB_SORT_DETECT_S : BB_SORT_PASS_S;
  const sorter = (bb.sorter ??= {});
  (sorter[r.id] ??= []).push({ id: ball.id, at: world.time + delay, m: mouth });
}

// ─────────────────────────────────────────────────────────────────────────────
// THE TICK
// ─────────────────────────────────────────────────────────────────────────────

/** write a robot's queue back, deleting the key (and the map) once it is empty */
function setQueue(world: World, id: number, q: BbSortEntry[]): void {
  const bb = world.biobuzz;
  if (!bb) return;
  if (q.length > 0) {
    (bb.sorter ??= {})[id] = q;
    return;
  }
  if (!bb.sorter) return;
  delete bb.sorter[id];
  if (Object.keys(bb.sorter).length === 0) delete bb.sorter;
}

/**
 * ONE ROBOT'S SORTER AND REVERSE, THIS TICK — run by both pipelines BEFORE the intake. Returns
 * whether the intake is running BACKWARDS this tick (the driver's reverse, or a `reverse` sorter's
 * window), in which case the caller runs no intake at all: rollers turning out neither pull nor
 * swallow.
 *
 * `enabled` gates it the way it gates the intake. A robot that is not enabled actuates nothing, so
 * a queued reject waits out the AUTO→TELEOP transition inside the robot and leaves after it.
 *
 * The order is deliberate: the sorter's due rejects first, so a reject whose time came on the tick
 * the driver also reversed goes out of ITS mouth through the sorter rather than being popped LIFO
 * through mouth 0.
 */
export function bbSorterTick(world: World, r: RobotState, cmd: RobotCommand | undefined, enabled: boolean): boolean {
  const bb = world.biobuzz;
  if (!bb) return false;
  const t = world.time;

  const q = bb.sorter?.[r.id];
  if (q && enabled) {
    const next: BbSortEntry[] = [];
    for (const e of q) {
      if (e.out) {
        if (t < e.at) next.push(e);
        continue;
      }
      const ball = world.balls.find((b) => b.id === e.id);
      // launched, placed or otherwise gone from this robot: nothing left to sort
      if (!ball || ball.state.kind !== 'held' || ball.state.robot !== r.id) continue;
      if (t < e.at) {
        next.push(e);
        continue;
      }
      if (!bbEject(r, ball, e.m)) continue;
      next.push({ id: e.id, at: t + BB_SORT_IGNORE_S, m: e.m, out: true });
      if (bbNectarRejectOf(r.spec) === 'reverse') (bb.sortRev ??= {})[r.id] = t + BB_SORT_REVERSE_S;
    }
    setQueue(world, r.id, next);
  }

  let sorting = false;
  const until = bb.sortRev?.[r.id];
  if (until !== undefined) {
    if (t < until) sorting = true;
    else {
      delete bb.sortRev![r.id];
      if (Object.keys(bb.sortRev!).length === 0) delete bb.sortRev;
    }
  }

  const reverse = enabled && (cmd?.bbReverse ?? false);
  if (reverse && r.hopper.length > 0 && t - r.lastIntakeAt >= BB_REVERSE_PERIOD_S) {
    // LIFO: the hopper's top colour, and the held element of it at the highest index — the same
    // pairing `takeHeld` makes for a launch, so the two never disagree about which one is on top
    const colour = r.hopper[r.hopper.length - 1];
    let ball: Artifact | undefined;
    for (let i = world.balls.length - 1; i >= 0; i--) {
      const b = world.balls[i];
      if (b.state.kind === 'held' && b.state.robot === r.id && b.color === colour) {
        ball = b;
        break;
      }
    }
    if (ball) {
      const queued = bb.sorter?.[r.id];
      const entry = queued?.find((e) => e.id === ball.id && !e.out);
      if (bbEject(r, ball, entry?.m ?? 0)) {
        r.lastIntakeAt = t; // the eject is the paced action, as a capture is
        if (queued && entry) setQueue(world, r.id, queued.filter((e) => e !== entry));
      }
    }
  }
  return reverse || sorting;
}
