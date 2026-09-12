import type { Alliance, RobotState, Vec2, World } from '../../types';
import { hyp } from '../../math';
import { robotCorners } from '../../sim/physics';
import { awardFoul } from '../../sim/scoring';
import { BB_FOUL_SLOP } from './config';

/**
 * BIOBUZZ penalty engine — AN EMPTY ENGINE, WITH THE EDGE-TRIGGER SCAFFOLD WIRED.
 *
 * There are no rules to enforce. Section 11 (Game Rules) of the V0 pre-season manual is one
 * page reading "This section will be updated with the Kickoff Competition Manual release on
 * September 12, 2026", so every G-rule this game will ever have is unpublished. Inventing one
 * would be worse than having none: a fabricated foul teaches drivers a habit the real rule may
 * punish, and it would show up on scoreboards as a number nobody can trace to a manual.
 *
 * ── WHAT IS ACTUALLY HERE, AND WHY IT IS HERE NOW ───────────────────────────
 * The hard part of a penalty engine is not the rules, it is the EDGE TRIGGER. A foul fires on
 * the rising edge of its condition and NOT again while the condition holds; get that wrong and
 * a two-second brush against an opponent bills 120 fouls, which is how a penalty engine turns
 * an incidental touch into a disqualification. It also has to RE-fire when the robots separate
 * and touch again, and it has to forget everything outside the played periods so a condition
 * that was true when the buzzer went does not fire on the first tick of the next match.
 *
 * That machinery is here, tested, and shaped exactly as Chain Reaction's: a `seen` map built
 * fresh each tick, a `fire(key, offender, rule)` helper that awards only when the key was
 * absent last tick, and `bb.foulEdge = seen` at the end so the map IS last tick's condition
 * set. The robot-robot contact test (SAT over the two footprints, with `BB_FOUL_SLOP` of
 * bumper slack) is here too, because "these two robots are touching" is the predicate almost
 * every FTC contact rule is built on and it is geometry rather than a rule.
 *
 * So the first real BIOBUZZ foul is a PREDICATE AND A `fire` CALL. Nothing else.
 *
 * RUNS BEFORE gameplay (see `step.ts`, stage 7), so a foul awarded this tick folds into the
 * alliance total the gameplay pass writes.
 */
export function updateBiobuzzPenalties(world: World): void {
  const bb = world.biobuzz;
  if (!bb) return;
  const phase = world.match.phase;
  const isAuto = phase === 'auto';
  const isTeleop = phase === 'teleop';
  if (!isAuto && !isTeleop) {
    // No fouls outside the PLAYED periods (pre / transition / post / freeplay), and the memory
    // is CLEARED rather than kept: a condition that was true at the buzzer must not count as
    // "already fired" when play resumes, or the first real instance of it goes unbilled.
    bb.foulEdge = {};
    return;
  }

  const seen: Record<string, boolean> = {};
  /**
   * Award `rule` against `offender`, ONCE per rising edge of `key`.
   *
   * `key` must identify the INSTANCE, not just the rule — conventionally
   * `<rule>-<offender robot>-<victim robot>` — or two simultaneous violations of the same rule
   * collapse into one, and a violation that moves from one victim to another never re-fires.
   */
  const fire = (key: string, offender: Alliance, rule: string): void => {
    if (!bb.foulEdge[key]) awardFoul(world, offender, 'major', rule);
    seen[key] = true;
  };
  void fire; // no rules yet — see the header. The scaffold is live, the rulebook is not.

  // THE CONTACT LOOP, kept live and kept empty. Every pair of OPPOSING robots in contact is
  // enumerated here; a rule is one `if` inside it. Same-alliance pairs are skipped because no
  // FTC contact rule has ever penalized touching your own partner.
  for (let i = 0; i < world.robots.length; i++) {
    for (let j = i + 1; j < world.robots.length; j++) {
      const A = world.robots[i];
      const B = world.robots[j];
      if (A.alliance === B.alliance) continue;
      if (!robotsContact(A, B)) continue;
      // ── the first BIOBUZZ contact rule goes here ──────────────────────────
      // e.g. if (isAuto && protectedSomehow(B)) fire(`gxx-${A.id}-${B.id}`, A.alliance, 'GXX …');
    }
  }

  bb.foulEdge = seen;
}

/**
 * OBB–OBB contact (separating-axis test) between two robot footprints, with a little bumper
 * slack.
 *
 * SLACK, not exact touching, on purpose: two chassis in a real match are in contact well
 * before their idealised rectangles share a point (bumpers compress, and the sim's footprint
 * is the frame rather than the padding on it), and an exact test flickers on and off across a
 * tick boundary — which, through the edge trigger, is a foul awarded twice for one push.
 *
 * Four axes suffice rather than eight because a rectangle's two edge normals are perpendicular,
 * so the other two are the same lines.
 */
function robotsContact(A: RobotState, B: RobotState): boolean {
  const ca = robotCorners(A);
  const cb = robotCorners(B);
  const axes = [
    edgeNormal(ca[0], ca[1]),
    edgeNormal(ca[1], ca[2]),
    edgeNormal(cb[0], cb[1]),
    edgeNormal(cb[1], cb[2]),
  ];
  for (const ax of axes) {
    const a = projectExtent(ca, ax);
    const b = projectExtent(cb, ax);
    if (a.max + BB_FOUL_SLOP < b.min || b.max + BB_FOUL_SLOP < a.min) return false; // separating axis
  }
  return true;
}

function edgeNormal(p: Vec2, q: Vec2): Vec2 {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const l = hyp(dx, dy) || 1;
  return { x: -dy / l, y: dx / l };
}

function projectExtent(corners: Vec2[], ax: Vec2): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const c of corners) {
    const d = c.x * ax.x + c.y * ax.y;
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return { min, max };
}
