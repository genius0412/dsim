import type { Alliance, RobotState, Vec2, World } from '../../types';
import { hyp } from '../../math';
import { robotCorners } from '../../sim/physics';
import {
  BB_FLOWER_UNLOCK_S,
  BB_FOUL_SLOP,
  BB_FRAME_BAR_IN,
  BB_FRAME_BAR_OUT,
  BB_FRAME_Y,
  BB_PTS,
} from './config';
import { bbKindOf } from './score';

/**
 * BIOBUZZ penalty engine — Section 11, Table 10-4.
 *
 * ── THE EDGE TRIGGER IS THE ENGINE ──────────────────────────────────────────
 * A foul fires on the RISING EDGE of its condition and NOT again while the condition holds.
 * Get that wrong and a two-second brush bills 120 fouls, which is how a penalty engine turns
 * an incidental touch into a disqualification. It must also RE-fire when the condition clears
 * and returns, and it must forget everything outside the played periods so a condition that
 * was true at the buzzer does not fire on the first tick of the next match.
 *
 * `bb.foulEdge` IS last tick's condition set. Each tick builds a fresh `seen` map, `fire()`
 * awards only for a key that was absent from `foulEdge`, and `foulEdge = seen` at the end.
 * There are NO COOLDOWN TIMERS anywhere in this file, on purpose: a cooldown is a second,
 * weaker edge trigger that disagrees with the first one about what "again" means, and the
 * manual's own repeat clauses are counted in VIOLATIONS, not in seconds (§10.6).
 *
 * ── KEYS NAME THE INSTANCE, NOT THE RULE ────────────────────────────────────
 * `g402-<offender>-<victim>`, `g410-<element id>`, `g417-<robot>-<alliance>`. Two simultaneous
 * violations of one rule must be two keys or they collapse into one award, and a violation
 * that moves from one victim to another must re-fire.
 *
 * ── WHAT IS ENFORCED, AND WHAT IS DELIBERATELY NOT ──────────────────────────
 * HERE: **G410** (NECTAR into a FLOWER before the 1:00 cue), **G402** (AUTO interference
 * across the field's halves) and **G417** (ramming the HIVE frame).
 *
 * NOT HERE, each for a stated reason rather than an oversight:
 *  • **G407** CONTROL ≤ 4 is STRUCTURAL — `bbHopperCap` is 4, so a robot cannot hold a fifth.
 *    The manual's other half, HERDING loose elements, needs a CONTROL test the sim has no
 *    honest version of (contact plus "moving with the robot" is a guess about intent), and a
 *    fabricated foul teaches a driver a habit the real rule may not punish.
 *  • **G421** PIN needs DECODE's `isPinning` (criteria A/B/C with its pause/resume), which is
 *    `private` to `src/sim/penalties.ts`. Extracting it is shared-core work — field-plan §6
 *    request 5 — and a second, BIOBUZZ-flavoured pin detector is exactly the duplicate the
 *    request exists to avoid.
 *  • **G405 / G409 / G411 / G418 / G426 / G427** are structural (nothing leaves the field, the
 *    sim's human player obeys its own timing) or referee judgement a 2D sim cannot see.
 *
 * RUNS BEFORE gameplay (`step.ts`, stage 7), so a foul awarded this tick folds into the
 * alliance total the score pass writes at the end of the same tick.
 */

/**
 * AWARD A BIOBUZZ FOUL — the shared `awardFoul` with THIS GAME'S TARIFF.
 *
 * MINOR 5, MAJOR **20** (Table 10-4). DECODE's MAJOR is 15, and `src/sim/scoring.ts` reads
 * `C.PTS_FOUL_MAJOR`, so calling the shared function here would bill every BIOBUZZ major five
 * points light. `src/sim/**` is the repo owner's and a per-game tariff is a request, not a
 * lane edit (field-plan §6 request 4) — so this mirrors it, points come from `BB_PTS`, and the
 * day the owner lands `foulPoints` on the module this collapses back to a one-line call.
 *
 * Everything else matches the shared function exactly, because the chrome reads it: the points
 * go to the VICTIM (the alliance that did not commit it), the offender's committed-foul tally
 * bumps for the HUD, and the event text is the same shape so a toast reads identically in both
 * games. `total` is NOT recomputed here — `bbApplyScore` sets it at the end of the tick, and
 * the shared `recomputeTotal` would sum DECODE's fields (see `score.ts`).
 */
export function bbAwardFoul(
  world: World,
  offender: Alliance,
  severity: 'minor' | 'major',
  rule: string,
): void {
  const victim: Alliance = offender === 'red' ? 'blue' : 'red';
  const pts = severity === 'major' ? BB_PTS.foulMajor : BB_PTS.foulMinor;
  world.match.scores[victim].foulPoints += pts;
  const tally = world.match.fouls[offender];
  if (severity === 'major') tally.major += 1;
  else tally.minor += 1;
  world.events.push(
    `${severity === 'major' ? 'MAJOR' : 'MINOR'} FOUL - ${victim.toUpperCase()} +${pts} (${rule})`,
  );
}

/**
 * IS NECTAR ENTRY INTO A FLOWER STILL LOCKED? (G410)
 *
 * "No NECTAR into a FLOWER before 1:00 left." The cue is 60 s of TELEOP remaining, so entry is
 * unlocked ONLY during teleop at or under `BB_FLOWER_UNLOCK_S`. Every earlier moment —
 * pre-match, AUTO, the transition, the first minute of TELEOP — is locked, which is why this
 * is written as "unlocked when…" and negated rather than as a list of locked phases: a phase
 * added later is locked by default, which is the safe direction for a penalty.
 *
 * Exported because the HUD chip and the smoke lane both ask the same question, and two
 * spellings of one boundary is how a cue ends up one tick away from the rule it announces.
 */
export function bbNectarLocked(world: World): boolean {
  const m = world.match;
  return !(m.phase === 'teleop' && m.phaseTimeLeft <= BB_FLOWER_UNLOCK_S);
}

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
   * `key` must identify the INSTANCE, not just the rule — or two simultaneous violations of
   * the same rule collapse into one, and a violation that moves from one victim to another
   * never re-fires.
   */
  const fire = (key: string, offender: Alliance, severity: 'minor' | 'major', rule: string): void => {
    if (!bb.foulEdge[key]) bbAwardFoul(world, offender, severity, rule);
    seen[key] = true;
  };

  // ── G410 — NECTAR into a FLOWER before the 1:00 cue. MAJOR PER NECTAR. ────
  /**
   * THE CONDITION IS "THIS NECTAR IS IN A FLOWER WHILE ENTRY IS LOCKED", not "a nectar entered
   * this tick", and that is what makes it edge-triggerable without a second event channel.
   *
   * `play.ts` owns flower entry (Lane A4a) and emits no event this file could subscribe to, so
   * the rule is written as a STATE predicate per element id. It rises on the tick the nectar
   * first appears in a stack while locked — one MAJOR, per the manual's "per NECTAR" — stays
   * true (and therefore silent) for as long as it sits there locked, and goes false forever at
   * the cue. An element pulled back out and re-entered while still locked drops the key and
   * fires again, which is the right answer: that is a second illegal entry.
   *
   * THE ELEMENT STILL SCORES. §10.5.2 says so explicitly, so nothing here touches the stack —
   * a penalty engine that also un-scored things would be enforcing a rule the manual does not
   * have.
   */
  if (bbNectarLocked(world)) {
    const kind = new Map<number, Alliance | 'pollen'>();
    for (const b of world.balls) kind.set(b.id, bbKindOf(b));
    for (const f of bb.flowers) {
      for (const id of f.stack) {
        const k = kind.get(id);
        if (k === undefined || k === 'pollen') continue;
        // The OFFENDER is the alliance whose NECTAR it is. A nectar is only ever handled by
        // its own alliance (G408 refuses the opponent's at the intake), so its colour names
        // who put it there without the sim having to remember who carried it.
        fire(`g410-${id}`, k, 'major', 'G410 NECTAR in a FLOWER before 1:00');
      }
    }
  }

  // ── G417 — meddling with the HIVE: ramming a frame bar. ───────────────────
  /**
   * "Don't ram the frame." A robot in contact with one of the two frame base bars while
   * CLOSING on it faster than `BB_FRAME_RAM_SPEED` (§5, `APPROX`).
   *
   * VERBAL FIRST, MAJOR IF REPEATED (Table 10-4's example B, field-plan §4.4). The first
   * instance is an EVENT LINE and no points — which is what a verbal warning is — and every
   * later instance by the same robot is a MAJOR. "Repeated" is per ROBOT per MATCH, so the
   * warning latch rides `bb.held[robot]`, the state bag's per-robot flag map, and survives the
   * edge trigger clearing between contacts (that map is what makes a new rule's flag a key
   * rather than a state-type edit — see `state.ts`).
   *
   * The speed test is CLOSING speed against the bar's own normal, not the robot's speed: a
   * robot driving fast ALONG the structure is not ramming it, and a slow deliberate shove
   * would fail a plain speed test while being exactly the thing the rule is about. The
   * threshold is `APPROX` and belongs on the 09-14 field-test list.
   */
  for (const r of world.robots) {
    if (r.passive) continue;
    const ram = frameRam(r);
    if (ram === null) continue;
    const key = `g417-${r.id}`;
    if (!bb.foulEdge[key]) {
      const flags = (bb.held[r.id] ??= {});
      if (flags.g417warned) {
        bbAwardFoul(world, r.alliance, 'major', 'G417 repeatedly ramming the HIVE frame');
      } else {
        flags.g417warned = true;
        world.events.push(`VERBAL - ${r.alliance.toUpperCase()} (G417 ramming the HIVE frame)`);
      }
    }
    seen[key] = true;
  }

  // ── G402 — AUTO interference across the halves. MAJOR on the crosser. ─────
  // Every pair of OPPOSING robots in contact. Same-alliance pairs are skipped: no FTC contact
  // rule has ever penalised touching your own partner.
  for (let i = 0; i < world.robots.length; i++) {
    for (let j = i + 1; j < world.robots.length; j++) {
      const A = world.robots[i];
      const B = world.robots[j];
      if (A.alliance === B.alliance) continue;
      if (!robotsContact(A, B)) continue;
      if (!isAuto) continue;
      /**
       * G402: during AUTO, red plays columns A–C (x < 0) and blue D–F (x > 0). The foul is on
       * the robot that CROSSED — fully across the centre line, in contact with an opponent.
       *
       * FULLY across, by every corner, and that is the difference between this and a foul for
       * touching the line: a robot straddling the centre with its own partner on its own side
       * has not left its columns, and Fig 9-5's split is about which THIRD of the field a
       * robot is playing in. Both crossing at once is two fouls, which is correct — each one
       * is a separate violation with its own victim.
       */
      for (const [x, y] of [
        [A, B],
        [B, A],
      ] as const) {
        if (fullyCrossed(x)) fire(`g402-${x.id}-${y.id}`, x.alliance, 'major', 'G402 AUTO interference');
      }
    }
  }

  bb.foulEdge = seen;
}

/**
 * CLOSING SPEED against whichever HIVE frame bar this robot is touching, or `null` if it is
 * touching neither or is not closing fast enough to be a ram.
 *
 * The bars are the two vertical strips the HIVE structure stands on: 1 in thick with the inner
 * edge on the ±24 tile seam and the other edge outward (reference §2.2), running in y between
 * ±`BB_FRAME_Y`. A robot's footprint against one is an OBB-vs-rect test; the closing speed is
 * the robot's velocity along the bar's INWARD normal, so driving along the structure reads
 * zero however fast it is.
 */
function frameRam(r: RobotState): number | null {
  for (const sign of [-1, 1] as const) {
    const bar = {
      x0: sign < 0 ? -BB_FRAME_BAR_OUT : BB_FRAME_BAR_IN,
      x1: sign < 0 ? -BB_FRAME_BAR_IN : BB_FRAME_BAR_OUT,
      y0: -BB_FRAME_Y,
      y1: BB_FRAME_Y,
    };
    if (!rectTouchesRobot(r, bar)) continue;
    // the bar faces the field on its OUTWARD side, so a robot on the +x bar rams it by moving
    // in −x, and vice versa
    const closing = -sign * r.vel.x;
    if (closing >= BB_FRAME_RAM_SPEED) return closing;
  }
  return null;
}

/**
 * The closing speed at which contact with a frame bar becomes RAMMING (in/s).
 *
 * `APPROX` — the manual says "don't meddle with the HIVE" and prints no number, so this is the
 * field-plan's §4.4 guess: fast enough that brushing the structure while manoeuvring under it
 * is never a foul (G409 assumes robots drive under the hives), slow enough that a deliberate
 * run at it is. On the 09-14 field-test list.
 */
export const BB_FRAME_RAM_SPEED = 30; // APPROX

/** OBB (robot) vs axis-aligned rect, with the same bumper slack the robot-robot test uses. A
 * local copy rather than `robotIntersectsRect` because that one is exact, and a structure
 * contact wants the same slack a robot contact gets — otherwise a ram registers a tick later
 * against a bar than against a chassis. */
function rectTouchesRobot(r: RobotState, rect: { x0: number; x1: number; y0: number; y1: number }): boolean {
  const rc = robotCorners(r);
  const rectC = [
    { x: rect.x0, y: rect.y0 },
    { x: rect.x1, y: rect.y0 },
    { x: rect.x1, y: rect.y1 },
    { x: rect.x0, y: rect.y1 },
  ];
  const axes = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    edgeNormal(rc[0], rc[1]),
    edgeNormal(rc[1], rc[2]),
  ];
  for (const ax of axes) {
    const a = projectExtent(rc, ax);
    const b = projectExtent(rectC, ax);
    if (a.max + BB_FOUL_SLOP < b.min || b.max + BB_FOUL_SLOP < a.min) return false;
  }
  return true;
}

/** is EVERY corner of this robot on the opponent's side of the centre line? (G402, Fig 9-5:
 * red is columns A–C at x < 0, blue D–F at x > 0). */
function fullyCrossed(r: RobotState): boolean {
  const want = r.alliance === 'red' ? 1 : -1; // the sign of x that is the OPPONENT's half
  for (const c of robotCorners(r)) {
    if (c.x * want <= 0) return false;
  }
  return true;
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
