import type { Alliance, RobotCommand, RobotState, Vec2, World } from '../../types';
import { hyp } from '../../math';
import { PIN_END_S, PIN_ESCAPE_DIST, PIN_SECONDS, PIN_STUCK_SPEED } from '../../config';
import { robotCorners } from '../../sim/physics';
import { isPinning } from '../../sim/penalties';
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
 * across the field's halves), **G417** (ramming the HIVE frame) and **G421** (PINNING).
 *
 * G421 IS THE ONE RULE HERE THAT IS NOT EDGE-TRIGGERED, and it is not an exception to the
 * paragraph above — it is the ONLY rule in Section 11 that carries a per-3-seconds clause
 * (manual-distilled §3.2), so it counts in SECONDS rather than in instances and owns a
 * per-ordered-pair accumulator instead of a key in `foulEdge`. See `bbUpdatePins`.
 *
 * NOT HERE, each for a stated reason rather than an oversight:
 *  • **G407** CONTROL ≤ 4 is STRUCTURAL — `bbHopperCap` is 4, so a robot cannot hold a fifth.
 *    The manual's other half, HERDING loose elements, needs a CONTROL test the sim has no
 *    honest version of (contact plus "moving with the robot" is a guess about intent), and a
 *    fabricated foul teaches a driver a habit the real rule may not punish.
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

export function updateBiobuzzPenalties(
  world: World,
  dt: number,
  commands: Map<number, RobotCommand>,
): void {
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
    /**
     * ...and the PIN CLOCKS go with it, which is a DELIBERATE DIVERGENCE from DECODE: its
     * `updatePenalties` returns from this same guard without touching `pen.pins`, so a pin
     * live at the AUTO buzzer resumes at the TELEOP one with 2.9 s already on it and bills a
     * MAJOR on the first tick of TELEOP for a hold that happened across the freeze. Robots are
     * DISABLED through the transition — nothing that happens in it is anybody's foul — and
     * this file's own rule is that the memory is forgotten outside the played periods. The
     * same reasoning DECODE applies to G408's clocks four lines further down, applied here.
     */
    world.penalties.pins = {};
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

  // ── G417 — meddling with the HIVE: ramming a frame bar. STRATEGIC. ────────
  /**
   * "ROBOTS may not manipulate the motion of the HIVE in any way other than by LAUNCHING
   * SCORING ELEMENTS into an upward-facing CELL." Violation: **VERBAL WARNING. MAJOR FOUL and
   * YELLOW CARD per MATCH, if STRATEGIC** (manual-distilled §11.4.4, Table 10-4, pp111–112).
   *
   * ── THE ESCALATION IS "STRATEGIC", NOT "REPEATED", AND THAT IS A REAL FIX ──
   * This rule used to read VERBAL-first / MAJOR-on-a-repeat, from `field-plan.md` §4.4. The
   * distilled manual settles it (§11 item 4): **REPEATED is not the trigger.** It is example F
   * of six listed indicators that an action is LIKELY STRATEGIC, and reading it as the
   * condition drops **example A — "ramming into the HIVE frame at high-speed" — which is
   * STRATEGIC on a single hit.** A robot that runs the frame down once, hard, was getting a
   * free warning for the one interaction the rule names first.
   *
   * So `BB_FRAME_RAM_SPEED` IS THIS SIM'S STRATEGIC TEST, and that is the honest mapping: the
   * manual's likely-NOT-STRATEGIC list is headed by "accidentally bumping the frame while
   * attempting to pick up POLLEN", which is exactly a low-speed contact. Below the threshold
   * the sim says nothing at all — a brush that could not cause or impede a TIP is not a
   * violation of the blanket sentence in the first place. At or above it, the contact is the
   * high-speed ram of example A and the STRATEGIC line applies on the FIRST instance.
   *
   * ── "PER MATCH", WHICH IS WHY THE LATCH SURVIVED THE REWRITE ──────────────
   * Table 10-4 says "MAJOR FOUL and YELLOW CARD **per MATCH**", and it says it in deliberate
   * contrast with G416 two rows above ("MAJOR FOUL **per instance**, if STRATEGIC"). So a robot
   * pays ONCE however many times it rams, and the latch that used to hold "already warned" now
   * holds "already billed". It rides `bb.held[robot]`, the state bag's per-robot flag map, so
   * it survives the edge trigger clearing between contacts — that map is what makes a new
   * rule's flag a key rather than a state-type edit (see `state.ts`).
   *
   * ⚠️ THE YELLOW CARD IS NOT MODELLED. BIOBUZZ has no card machinery at all — `bbAwardFoul`
   * awards points and nothing else, and a card carries DQ consequences through scoring and the
   * results screen that no BIOBUZZ lane has built. The FOUL is the half that changes a score,
   * so the foul is the half that is here; the card is named in the handoff as an open item.
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
      if (!flags.g417billed) {
        flags.g417billed = true;
        bbAwardFoul(world, r.alliance, 'major', 'G417 STRATEGIC ramming of the HIVE frame');
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

  // ── G421 — PINNING. Seconds, not an edge: its own accumulator, below. ─────
  bbUpdatePins(world, dt, commands);
}

/**
 * G421 — "A ROBOT may not PIN an opponent's ROBOT for more than 3 seconds." Violation: **MAJOR
 * FOUL per instance and an additional MAJOR FOUL for every 3 seconds in which the situation is
 * not corrected** (manual-distilled §3.1 Table 10-4, §3.3 / 11.4.5 p114, verbatim).
 *
 * ── THE DETECTOR IS DECODE'S, ON PURPOSE ────────────────────────────────────
 * `isPinning` is `src/sim/penalties.ts`'s, now exported (field-plan §6 request 5). The rule
 * BIOBUZZ prints is DECODE's G422 with a different tariff — same PIN, same 2-ft / 3-s release,
 * same pause-and-resume — so the criteria are CALLED rather than re-spelled here. A second,
 * BIOBUZZ-flavoured pin detector is exactly the duplicate the request existed to avoid: it
 * would drift, and then two games would disagree about what a pin is while quoting one
 * definition.
 *
 * Criteria A/B/C, quoted from p114 and every one of them the rule's own:
 *   A. "the ROBOTS have separated by at least 2 ft. ... for more than 3 seconds" —
 *      `PIN_ESCAPE_DIST` is 24 in and `PIN_END_S` is 3;
 *   B. "either ROBOT has moved 2 ft. from where the PIN initiated for more than 3 seconds";
 *   C. "the PINNING ROBOT gets PINNED" — a mutual hold is nobody's foul.
 * A and B END the pin. Anything else that merely interrupts it — the pinner easing off, the
 * victim squirming a foot — PAUSES the count and does not reset it. The manual spends two
 * whole paragraphs on that ("the PIN count pauses ... at which point the PIN count is
 * resumed", once for A and once for B), and it is the whole difference between a pin you can
 * shrug off and one you cannot: without it a pinner wipes a 2.9-second count by backing away
 * for a tenth of a second, and starts again from zero, forever, for free.
 *
 * ── ⚠️ THERE IS NO "ATTEMPTING TO MOVE" CLAUSE, AND THAT IS THE POINT ────────
 * DECODE's G422 reads "...and the opponent ROBOT is attempting to move". **G421 DOES NOT
 * CONTAIN THAT CLAUSE** (manual-distilled §3.3 and §10 item 13): the test is "preventing the
 * movement of an opponent ROBOT by contact" and nothing more, and the glossary's PIN/PINNING
 * entry on p171 is the same sentence.
 *
 * So a BIOBUZZ robot is PINNED whether or not it struggles, and `isPinning`'s idle-victim
 * branch — the one its own comment flags as ⚠️ a deviation from DECODE, kept because a driver
 * who is held stops mashing the stick — **is the LITERAL rule here.** Under DECODE it is a
 * judgement call the sim makes on a referee's behalf; under BIOBUZZ it is what the manual
 * says. Do NOT add a struggle test: it would under-call BIOBUZZ pins, and it would be reading
 * DECODE's wording into a rule that dropped it.
 *
 * ── THE TARIFF IS THE ONLY THING THAT CHANGES ───────────────────────────────
 * DECODE bills a MINOR at 3 s and a MINOR every 3 s after. BIOBUZZ bills a **MAJOR**, and a
 * MAJOR every 3 s after (Table 10-4) — so nine seconds of pinning is 60 points, not 15. It
 * goes through `bbAwardFoul` for the same reason every other rule in this file does: the
 * shared `awardFoul` reads `C.PTS_FOUL_MAJOR`, which is DECODE's 15.
 *
 * Table 10-6 (p95) prints the arithmetic and the loop below reproduces it exactly: "Upon
 * violation, a MAJOR FOUL is assessed ... and for each 3 seconds within that time, an
 * additional MAJOR FOUL ... A ROBOT in violation of this type of rule for 15 seconds is
 * assessed a total of 6 MAJOR FOULS." The violation OPENS at 3 s of pinning, so 15 s of being
 * in violation is 18 s of pinning, and `floor(18 / 3)` is 6 — one on entry plus one for each
 * of the five further intervals, 120 points. There is **no CARD escalation inside G421**
 * (§3.3), only the running tariff, so nothing here cards anybody.
 *
 * ── TWO HONEST DEVIATIONS, BOTH WORTH READING ───────────────────────────────
 * 1. **CONTACT IS THIS FILE'S OBB TEST, NOT `world.rrContacts`.** DECODE feeds `isPinning` the
 *    solver's contact record. This file already answers "are these two robots touching?" for
 *    G402 with `robotsContact`, which carries `BB_FOUL_SLOP` because two chassis are in
 *    contact well before their idealised rectangles share a point. Using both would mean one
 *    file with two disagreeing definitions of contact — and the rules smoke, which drives
 *    hand-built worlds with no solver behind them, could not reach the rule at all.
 * 2. ⚠️ **`isPinning`'s INTERNAL SOLID PROBE IS DECODE'S FIELD.** Its `pinnedAgainstWall`
 *    helper is private and hard-codes DECODE's GOAL WEDGES and CLASSIFIER CHANNELS as solids
 *    alongside the perimeter. BIOBUZZ has neither, and its own solids — the two HIVE FRAME
 *    BARS — are invisible to it. The perimeter half is right (both fields are 144 in, and
 *    `C.FIELD_HALF` equals `BB_HALF_X`), so this only bites in the four corner regions DECODE
 *    puts a goal in: a victim held there reads as "cornered against a solid, therefore
 *    escaping rather than pinning", and the pin goes UNBILLED. That is the conservative
 *    direction — it under-bills, it never invents a foul — and it is a REQUEST for the shared
 *    core rather than a lane edit: `pinnedAgainstWall` wants the game's own solid list passed
 *    in (field-plan §6, a request-5 follow-on). Until then a pin in a BIOBUZZ corner is free,
 *    and a pin against a HIVE frame bar is billed on the pinner's press alone.
 */
function bbUpdatePins(world: World, dt: number, commands: Map<number, RobotCommand>): void {
  const pen = world.penalties;

  /**
   * EVERY ORDERED OPPOSING PAIR'S VERDICT FIRST, because criterion C is about BOTH of them:
   * whether A is pinning B cannot be settled until it is known whether B is pinning A.
   *
   * `passive` robots — free-drive practice dummies — are skipped on both sides, the same way
   * G417 and `bbAssess` skip them. They have no alliance in any meaningful sense, and billing
   * a MAJOR to whichever colour a dummy happened to be spawned as is a foul awarded to nobody.
   */
  const verdict = new Map<string, boolean>();
  for (const pinner of world.robots) {
    if (pinner.passive) continue;
    for (const pinned of world.robots) {
      if (pinned.passive || pinner.id === pinned.id || pinner.alliance === pinned.alliance) continue;
      verdict.set(
        `${pinner.id}-${pinned.id}`,
        isPinning(
          pinner,
          pinned,
          robotsContact(pinner, pinned),
          commands.get(pinned.id),
          commands.get(pinner.id),
        ),
      );
    }
  }

  // A pair that no longer exists (a robot left the match) can never be visited again, so its
  // accumulator would ride every snapshot for the rest of the match. `verdict` holds every
  // LIVE ordered pair — including the ones reading `false`, which is what keeps a PAUSED pin's
  // clock alive — so anything outside it is stale by construction.
  for (const key of Object.keys(pen.pins)) if (!verdict.has(key)) delete pen.pins[key];

  for (const pinner of world.robots) {
    if (pinner.passive) continue;
    for (const pinned of world.robots) {
      if (pinned.passive || pinner.id === pinned.id || pinner.alliance === pinned.alliance) continue;
      const key = `${pinner.id}-${pinned.id}`;
      const held = verdict.get(key) === true;
      /** criterion C: "the PINNING ROBOT gets PINNED" — a mutual hold is nobody's foul */
      const mutual = held && verdict.get(`${pinned.id}-${pinner.id}`) === true;

      let st = pen.pins[key];
      if (!st) {
        if (!held || mutual) continue;
        // WHERE BOTH ROBOTS WERE WHEN THE PIN INITIATED — criterion B measures against these,
        // and `px`/`py` is last tick's victim pose, which the escape measurement differences.
        st = {
          seconds: 0,
          ox: pinned.pos.x,
          oy: pinned.pos.y,
          pox: pinner.pos.x,
          poy: pinner.pos.y,
          px: pinned.pos.x,
          py: pinned.pos.y,
          billed: 0,
          sepFor: 0,
          awayFor: 0,
        };
        pen.pins[key] = st;
      }

      if (mutual) {
        delete pen.pins[key]; // C
        continue;
      }

      // A and B, the ONLY two things that END a pin. Both are distances HELD for more than
      // three seconds; a momentary one PAUSES the count instead (see below).
      const apart = hyp(pinned.pos.x - pinner.pos.x, pinned.pos.y - pinner.pos.y) >= PIN_ESCAPE_DIST;
      const movedPinned = hyp(pinned.pos.x - st.ox, pinned.pos.y - st.oy) >= PIN_ESCAPE_DIST;
      const movedPinner = hyp(pinner.pos.x - st.pox, pinner.pos.y - st.poy) >= PIN_ESCAPE_DIST;
      st.sepFor = apart ? st.sepFor + dt : 0;
      // "...until the PIN ends or until BOTH ROBOTS move back within 2 ft"
      st.awayFor = movedPinned || movedPinner ? st.awayFor + dt : 0;
      if (st.sepFor > PIN_END_S || st.awayFor > PIN_END_S) {
        delete pen.pins[key];
        continue;
      }

      // last tick's victim pose, captured BEFORE it is overwritten. It advances on PAUSED
      // ticks too, or the first tick after a pause reads a whole pause's worth of travel as
      // one tick of escape and cancels the pin.
      const prevX = st.px;
      const prevY = st.py;
      st.px = pinned.pos.x;
      st.py = pinned.pos.y;
      if (apart || movedPinned || movedPinner || !held) continue; // PAUSED, not ended

      /**
       * "...preventing the movement..." MEASURED rather than assumed: progress away from the
       * pinner, taken from the actual post-solve position delta, so it holds whether or not a
       * blocked robot's velocity was zeroed. Along the ESCAPE direction rather than as raw
       * speed — a victim bulldozed sideways along a wall is moving quickly and is no less
       * pinned. `PIN_STUCK_SPEED` is the sim's own number; the rule leaves it to a referee.
       *
       * Penalties run at `step.ts` stage 7, AFTER the Rapier solve, so `pinned.pos` is where
       * the robot actually ended this tick — which is what makes this a measurement rather
       * than a reading of intent.
       */
      const e = bbEscapeDir(pinner, pinned);
      const escapeSpeed = e ? ((pinned.pos.x - prevX) * e.x + (pinned.pos.y - prevY) * e.y) / dt : 0;
      if (escapeSpeed >= PIN_STUCK_SPEED) continue; // getting away under its own power

      st.seconds += dt;
      // MAJOR at 3 s, and another every 3 s the situation is not corrected — Table 10-6's
      // "6 MAJOR FOULS for 15 seconds in violation", which is 18 s of pinning and `floor(18/3)`.
      // A `while` rather than an `if` because a coarse `dt` can cross two thresholds in one
      // tick, and a pin is not cheaper for having been stepped at 10 Hz.
      while (st.seconds >= PIN_SECONDS * (st.billed + 1)) {
        st.billed += 1;
        bbAwardFoul(world, pinner.alliance, 'major', 'G421 PINNING');
        pen.pinFouls[pinner.id] = (pen.pinFouls[pinner.id] ?? 0) + 1;
      }
    }
  }
}

/**
 * The ESCAPE direction for a pin: the unit vector from the pinner to the victim, i.e. the way
 * the victim would have to go to get out. Null when the two are coincident, where "away" is
 * undefined.
 *
 * A five-line local copy of `src/sim/penalties.ts`'s `escapeDir`, which is private there. It
 * is copied rather than requested because it is arithmetic with no rule in it — the same
 * vector any of three files would write — while `isPinning`, which encodes the actual
 * criteria, is imported. A duplicated JUDGEMENT is a liability; a duplicated normalisation is
 * not worth a shared-core round trip.
 */
function bbEscapeDir(pinner: RobotState, pinned: RobotState): Vec2 | null {
  const dx = pinned.pos.x - pinner.pos.x;
  const dy = pinned.pos.y - pinner.pos.y;
  const d = hyp(dx, dy);
  if (d < 1e-3) return null;
  return { x: dx / d, y: dy / d };
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
