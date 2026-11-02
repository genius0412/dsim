import type { Alliance, Artifact, RobotCommand, RobotState, Vec2, World } from '../../types';
import { dcos, dsin, hyp } from '../../math';
import { PIN_END_S, PIN_ESCAPE_DIST, PIN_SECONDS, PIN_STUCK_SPEED, POSSESSION_CONFIRM, simPatchAtLeast } from '../../config';
import { driveIntent, robotCorners, robotHullWorld, robotPointVelocity } from '../../sim/physics';
import { polyFeature, polyGap, polySatGap } from '../../sim/imported';
import { foulEventText, warningEventText } from '../../sim/penaltyLog';
import { awardCard } from '../../sim/scoring';
import { type ControlGeometry, controlKeyLive, controlledArtifacts, isPinning } from '../../sim/penalties';
import { bbPinSolid } from './colliders';
import {
  BB_FLOWER_UNLOCK_S,
  BB_FOUL_SLOP,
  BB_LZ,
  BB_NECTAR_R,
  BB_POLLEN_R,
  BB_PTS,
  bbHopperCap,
} from './config';
import { bbInGarden, bbKindOf } from './score';
import { bbImportSolids } from './importMech';
import { bbIntakeAccepts } from './mechs';
import { bbSorterTakes } from './nectarReject';
import { biobuzzPhysics } from './state';

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
 * A rule gets a COOLDOWN only where its own condition flickers under the solver, and then it
 * gets ONE memory rather than two: **G402** is billed off a re-arm window (`BB_G402_REARM_S`,
 * measured) and does not use `foulEdge` at all, because two memories that disagree about what
 * "again" means is worse than one blunt one. Everything else is the plain edge — the manual's
 * repeat clauses are counted in VIOLATIONS, not in seconds (§10.6).
 *
 * ── KEYS NAME THE INSTANCE, NOT THE RULE ────────────────────────────────────
 * `g402-<offender>-<victim>`, `g410-<element id>`, `g407-<robot>`. Two simultaneous
 * violations of one rule must be two keys or they collapse into one award, and a violation
 * that moves from one victim to another must re-fire.
 *
 * ── WHAT IS ENFORCED, AND WHAT IS DELIBERATELY NOT ──────────────────────────
 * HERE: **G410** (NECTAR into a FLOWER before the 1:00 cue), **G402** (AUTO interference
 * across the field's halves — contact here, and taking an element off the opponent's half in
 * `nectarReject.ts`'s `bbOnCapture`), **G421** (PINNING), **G407** (CONTROL of more than 4 SCORING
 * ELEMENTS — a WARNING, escalating to a MAJOR when STRATEGIC per Table 10-4), **G408** (CONTROL
 * of the opponent's NECTAR — a WARNING, and a YELLOW CARD when REPEATED) and **G409** (catching a
 * spilling element — a WARNING, and 3D only; see `bbBillG409`).
 *
 * G421 IS THE ONE RULE HERE THAT IS NOT EDGE-TRIGGERED, and it is not an exception to the
 * paragraph above — it is the ONLY rule in Section 11 that carries a per-3-seconds clause
 * (manual-distilled §3.2), so it counts in SECONDS rather than in instances and owns a
 * per-ordered-pair accumulator instead of a key in `foulEdge`. See `bbUpdatePins`.
 *
 * G407'S STRATEGIC BRANCH is dated 2026-09-19 and supersedes the 2026-09-12 "warning and
 * nothing else" ruling — see the rule's own block below for the manual test it now follows.
 *
 * ⚠️ **NEITHER G402 NOR G407 IS CAPPED PER MATCH ANY MORE** (owner ruling 2026-09-22). Both
 * used to carry a per-robot latch read off Table 10-4's "per MATCH"; every distinct instance
 * now bills. See each rule's own block.
 *
 * NOT HERE, each for a stated reason rather than an oversight:
 *  • **G405 / G411 / G418 / G419 / G420 / G426 / G427** are structural (nothing leaves the
 *    field, no chassis tips another, the sim's human player obeys its own timing) or referee
 *    judgement a sim cannot see. G409 used to be on this list and is off it: the 3D spill is a
 *    real flight with a real first contact, so it is billed (as a WARNING) by `bbBillG409`,
 *    and it stays unmodelled in 2D, where the spill is handed straight to the tiles.
 *  • **G417** (meddling with the HIVE, including ramming its frame) is REMOVED entirely
 *    (owner ruling, 2026-09-19: every HIVE-ramming penalty is gone from both pipelines). A
 *    driver clipping the structure while driving under it is ordinary play in this sim.
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
 * ── AND A THIRD SEVERITY THE SHARED FUNCTION DOES NOT HAVE: `warning` ───────
 * Table 10-4's base sanction for most of Section 11 is a **VERBAL WARNING**, with the FOUL
 * reserved for the STRATEGIC case, and this game has a rule whose ONLY sanction is that
 * warning: **G409** (catching a spill), whose escalation is a card this sim does not issue.
 * **G407** starts at the same warning and can climb to a MAJOR (owner ruling 2026-09-19, see
 * the rule's own block below). A warning moves **no points** and bumps **no tally**: it is an
 * event line and nothing else, which is exactly what a referee saying "four, blue" across the
 * field is. It is modelled here rather than as a bare `world.events.push` at the call site so
 * that every sanction in this game goes through one function and reads the same way in a toast
 * and a replay.
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
  severity: 'minor' | 'major' | 'warning',
  rule: string,
): void {
  // A WARNING IS NOT A FOUL. No points, no tally — it leaves the score exactly where it was,
  // which is the whole difference between the owner's G407 ruling and the cap it replaced.
  if (severity === 'warning') {
    world.events.push(warningEventText(offender, rule));
    return;
  }
  const victim: Alliance = offender === 'red' ? 'blue' : 'red';
  const pts = severity === 'major' ? BB_PTS.foulMajor : BB_PTS.foulMinor;
  world.match.scores[victim].foulPoints += pts;
  const tally = world.match.fouls[offender];
  if (severity === 'major') tally.major += 1;
  else tally.minor += 1;
  world.events.push(foulEventText(severity, victim, pts, rule));
}

/**
 * **G409** — "ROBOTS may not catch SCORING ELEMENTS spilling from a TIPPED HIVE" (Table 10-4:
 * VERBAL WARNING; YELLOW CARD if STRATEGIC). Called by `sim3d/contacts3d.ts` on the tick a
 * spilling element's FIRST non-tray contact turns out to be a robot.
 *
 * ── A WARNING, AND ONLY A WARNING ───────────────────────────────────────────
 * The base sanction in Table 10-4 is verbal, and the escalation is a CARD rather than a FOUL —
 * and the only card BIOBUZZ issues is G408's (the shared `awardCard`, below). So there is no points
 * branch here to get wrong: a caught spill costs nothing and says so, which is exactly what a
 * referee saying "blue, don't catch that" across the field is worth.
 *
 * `offender` is the alliance whose HIVE spilled the element, and the ROBOT is what the line
 * names — a robot may perfectly well catch the OPPONENT's spill, and the rule does not care
 * whose hive it fell out of. Billed once PER ELEMENT, by construction: `contacts3d.ts` deletes
 * the tag in the same breath, and an element has exactly one first contact.
 *
 * ⚠️ 3D ONLY. The 2D pipeline hands a spill straight to the tiles (`spillPoses`), so there is no
 * flight and no first contact to catch — `penalties.ts` has always recorded G409 as "not
 * modelled (spill lands on tiles)" and that stays true for that pipeline.
 */
export function bbBillG409(world: World, spilledBy: Alliance, robotId: number): void {
  const robot = world.robots.find((r) => r.id === robotId);
  if (!robot) return;
  bbAwardFoul(world, robot.alliance, 'warning', `G409 caught ${spilledBy.toUpperCase()}'s spilling SCORING ELEMENT`);
}

/**
 * G407's OWN NUMBER: "A ROBOT may not CONTROL more than 4 SCORING ELEMENTS."
 *
 * It lives here rather than in `config.ts` because it is a RULE and this is the rules file —
 * and because `config.ts`'s `BB_STORAGE_MAX` is a different thing wearing the same digit. That
 * one is the HOPPER DIAL's ceiling, it is Lane B's, and the owner kept it at 4 (ruling
 * 2026-09-12, overriding Lane B relay 2). The rule's 4 and the dial's 4 are kept as separate
 * constants on purpose, and this is the one Section 11 is about.
 */
export const BB_CONTROL_LIMIT = 4;

/**
 * THE MANUAL'S OWN NUMBER FOR "MOMENTARY" (manual-distilled §3.1, Table 10-4's duration
 * definitions, p92, verbatim): "MOMENTARY describes durations that are fewer than
 * approximately 3 seconds." G407's STRATEGIC test (below) uses it for both of its clocks — how
 * long a CONTROL of 6+ must be sustained before it is STRATEGIC on its own, and how long a
 * CONTROL of 5+ must be sustained before it counts as an INSTANCE toward "a second time this
 * match". Not spelled `PIN_SECONDS`: that is DECODE's G421 clock, reads the same digit, and
 * means something unrelated.
 */
export const BB_MOMENTARY_S = 3;

/**
 * HOW MANY SCORING ELEMENTS THIS ROBOT IS CONTROLLING (G407) — HOPPER **PLUS HERDED**.
 *
 * `controlledArtifacts` landed as an export on `alpha` `ea2cba4` (the field-plan §6 request-5
 * sibling this function used to ask for), so the promise the old body made is kept: the body is
 * a call to it and the rule now counts what the glossary counts. CONTROL there is the real
 * judgement — a per-(robot, element) hold clock with a drain, a herding-speed gate, a carry
 * distance, a re-station rule, an intake-mouth carve-out and a transitive contact chain — and
 * duplicating any of it here would have been a second opinion about the same sentence.
 *
 * ── THE THREE DECODE CONSTANTS IT USED TO READ ARE NOW PASSED IN ────────────
 * `ControlGeometry` is the field-plan §6 request this lane filed, and all three divergences it
 * named are closed. What they were, so the sizes are on record:
 *
 *  1. **`C.BALL_RADIUS` 2.5 in against a BIOBUZZ element simulated at 1.4.** TOUCHING was
 *     2.9 in rather than 1.8 and the transitive chain 5.4 rather than 3.2 — nearly two element
 *     DIAMETERS of gap still linked two elements, which bills a robot for a pile it is not
 *     touching. The shared function now reads each artifact's OWN `r` and falls back to
 *     `radius`, so this game's two sizes (POLLEN 2.8, NECTAR 3.6) each measure against their
 *     own skin.
 *  2. **`C.HOPPER_CAPACITY` 3 against a BIOBUZZ hopper of 4**, so the intake-MOUTH carve-out
 *     was already spent at 3 and a robot carrying its legal four got none of it. `hopperCap`
 *     is `bbHopperCap`, the same function the intake and the HUD read.
 *  3. **`loadZone(r.alliance)` is DECODE's driver-side rect, not `BB_LZ`** — a 23 × 11 strip
 *     against the SIDE wall, somewhere else entirely. Both halves were wrong at once: a robot
 *     collecting its own restock was counted, and a strip of ordinary BIOBUZZ floor was
 *     excused. `carveOut` is `BB_LZ`.
 *
 * ⚠️ AND ONE CONSEQUENCE OF A SETTLED RULING: the owner ruled the 4-element hopper cap FINAL
 * (2026-09-12), so `bbHopperCap` clamps every hopper to 4 for good. The HOPPER half therefore can
 * never exceed the limit on its own in a driven match; the HERDED half can, and does, which is
 * the whole point of counting it.
 */
/**
 * HOW FAR OFF THE TILES AN ELEMENT MAY BE AND STILL BE ON THE FLOOR, for `bbLooseElement` (in,
 * measured to the element's BOTTOM, which is what `Artifact.z` is under the 3D solve).
 *
 * MEASURED, not chosen (`scratch/skitter.ts`, 3D, four seeds x three headings, every tick a
 * chassis was in contact with an element it was pushing): a PLOWED element's bottom never rose
 * above **0.92 in** (p50 0.00, p95 0.92, n=14,340), and a real SHOT passing over a chassis in
 * plan was never lower than **7.60 in** (p50 28.9, n=246). Anything in that gap separates the
 * two perfectly; 2 in sits 2.2x above the skip and 3.8x below the lowest shot, so neither
 * number has to be re-measured to the inch for this to keep holding.
 */
export const BB_CONTROL_SKITTER_Z = 2; // in

/**
 * IS THIS ELEMENT LOOSE ON THE FLOOR? — the `ControlGeometry.loose` slot, and the whole of why
 * G407 could not fire in a server room.
 *
 * ⚠️ **EVERY SERVER-CONNECTED MATCH IS 3D, AND IN 3D A PLOWED ELEMENT IS TAGGED `flight`.**
 * `derive.ts` calls an element airborne when its bottom is off the tiles by 0.05 in or its `vz`
 * exceeds 1 in/s and it has not read at rest — which is a fair description of a ball in the air
 * and ALSO of a 3-in ball being shoved across a tile seam, because a plowed ball SKIPS. Measured
 * on a driven six-element herd, the element was tagged `flight` on 14.3% of the ticks it was in
 * chassis contact, and those ticks were interleaved with the `ground` ones every few frames.
 *
 * Both halves of the rule read that tag, and both broke on it:
 *   · `controlledArtifacts` filters the field to `ground`, so a skipping element was not even a
 *     candidate to be counted;
 *   · `bbSweepControlClocks` treats a non-`ground` element as GONE and DELETES its hold, anchor
 *     and carry — so every skip reset the confirm clock to zero. Measured over six driven
 *     scenes, both phases, empty and full hopper: the per-element hold peaked at **0.000 s**
 *     against a `POSSESSION_CONFIRM` of 0.45, nothing ever latched, and the count never left
 *     the hopper. G407 was unreachable in 3D by construction — a WARNING and a MAJOR that no
 *     amount of bulldozing could earn.
 *
 * So the predicate asks the physical question the tag was standing in for: is it loose (not in
 * a cell, a tube, a hopper or the human player's box) AND is it on the floor. `ground` always
 * is. `flight` is too when its bottom is under `BB_CONTROL_SKITTER_Z` — which a skip is and a
 * shot is not.
 *
 * ⚠️ **AND IT IS GATED ON THE 3D SOLVE, WHICH IS NOT SUPERSTITION.** The 2D pipeline is
 * PERMANENT (owner rule) and byte-identical is the bar. 2D has no skip — a `ground` element
 * stays `ground` from the moment it lands — so the `flight` arm buys that pipeline nothing,
 * while a 2D arc's descending tail does pass through this band on its way down. Taking the arm
 * out of 2D is the difference between a fix and a fix plus an unrelated change nobody asked for.
 */
function bbLooseElement(world: World): (b: Artifact) => boolean {
  const is3d = biobuzzPhysics(world) === '3d';
  return (b) =>
    b.state.kind === 'ground' || (is3d && b.state.kind === 'flight' && b.z <= BB_CONTROL_SKITTER_Z);
}

function bbControlGeometry(world: World): ControlGeometry {
  return {
    // the REAL LOADING ZONE, so a robot collecting its own restock is not billed for herding it.
    carveOut: (a) => BB_LZ[a],
    // the fallback for an element that carries no `r` of its own; POLLEN is the common case.
    radius: BB_POLLEN_R,
    // the same cap the intake and the HUD read, so the carve-out closes exactly when the hopper
    // is actually full rather than one element early.
    hopperCap: (r) => bbHopperCap(r.spec),
    // ...and what counts as loose on the floor, which under the 3D solve is not the tag alone.
    loose: bbLooseElement(world),
    // ...and from `SIM_PATCH` 13, the mouth carve-out covers only what this intake will take: a
    // POLLEN-only intake refuses a NECTAR and a lowered bar refuses every NECTAR, so one pressed
    // into either mouth is being pushed, not acquired.
    ...(simPatchAtLeast(world, 13)
      ? { takes: (r: RobotState, b: Artifact) => bbIntakeAccepts(r.spec, r.alliance, b.color, simPatchAtLeast(world, 10)) && bbSorterTakes(world, r, b) }
      : {}),
  };
}

function bbControlled(
  world: World,
  r: RobotState,
  dt: number,
  intaking: boolean,
  geom: ControlGeometry,
  ids?: Set<number>,
): number {
  return controlledArtifacts(world, r, dt, intaking, geom, ids);
}

/**
 * SWEEP THE PER-(ROBOT, ELEMENT) CLOCKS `controlledArtifacts` KEEPS.
 *
 * ⚠️ **THIS IS NOT OPTIONAL BORROWED HOUSEKEEPING — IT IS HALF OF THE IMPORT.** DECODE does this
 * sweep at the top of its own `updatePossession`, immediately before calling
 * `controlledArtifacts`, and BIOBUZZ never runs a line of `src/sim/penalties.ts`’s
 * `updatePenalties` (see `step.ts` stage 7). Calling the counting half without the sweeping half
 * reproduces, in this game, exactly the two failures DECODE’s own comment records:
 *   · `ballHold` / `ballAnchor` / `ballCarry` are only ever deleted along the NOT-TOUCHING path,
 *     so an element that leaves the ground state while in contact — the ordinary way one leaves,
 *     by being intaken — keeps its clock for the rest of the match. The maps are plain JSON
 *     inside `world.penalties` and ride every 30 Hz snapshot and every stored replay.
 *   · element ids are recycled, so a stale key can rebind to a DIFFERENT physical element, which
 *     then arrives PRE-LATCHED and skips the confirm window — the one thing standing between
 *     herding and bulldozing.
 *
 * Written here rather than requested as a second export because it is bookkeeping over state the
 * caller owns, with no rule in it — the same line the `bbEscapeDir` note draws at the bottom of
 * this file. Iteration is over a snapshot of the keys, in insertion order, so it is deterministic.
 */
function bbSweepControlClocks(world: World): void {
  const pen = world.penalties;
  // ⚠️ THE SAME PREDICATE THE COUNT USES, and it has to be: a sweep that is stricter than the
  // count deletes the clock of an element the count is still looking at. That is precisely what
  // `kind === 'ground'` did here under the 3D solve — see `bbLooseElement`.
  const live = controlKeyLive(world, bbLooseElement(world));
  pen.ballCarry ??= {};
  for (const key of Object.keys(pen.ballHold)) {
    if (!live(key)) {
      delete pen.ballHold[key];
      delete pen.ballAnchor[key];
      delete pen.ballCarry[key];
    }
  }
  for (const key of Object.keys(pen.ballAnchor)) if (!live(key)) delete pen.ballAnchor[key];
  for (const key of Object.keys(pen.ballCarry)) if (!live(key)) delete pen.ballCarry[key];
}

/**
 * HOW LONG A ROBOT MUST BE OUT OF CONTROL BEFORE CONTROLLING AGAIN IS A NEW INSTANCE (s) — G407's
 * 5+ and G408's per-element instance alike, from `SIM_PATCH` 13.
 *
 * `APPROX`. The manual counts instances and gives no gap, but both rules now escalate on a count
 * (G408 on the second instance, G407 on the third), so "again" has to mean something a driver
 * can see. Without a window a drop and re-take at the mouth — an element squirting out of the
 * rollers and straight back in, or a contact chain flickering 5-4-5 across one shove — is two or
 * three instances inside a second, and the escalation is bought by the solver rather than by the
 * driver. One second is G402's `BB_G402_REARM_S` for the same reason: short enough that a robot
 * which really let go and came back is billed again, long enough to swallow the flicker.
 */
export const BB_CONTROL_REARM_S = 1; // APPROX, s

/**
 * THE G407 INSTANCE THAT IS STRATEGIC ON ITS OWN, HOWEVER SHORT (`SIM_PATCH` 13): the third this
 * match. Orange box (C) excuses an isolated MOMENTARY five, TU05 calls REPEATED instances likely
 * STRATEGIC "even if the ROBOT has a 'keep 4 and discard the rest' sorting mechanism", and QA23
 * calls ROUTINE momentary control strategic. Two is "repeated" by the glossary but still within
 * what (C) forgives twice over; three is a pattern. `APPROX` — a referee's eye, not a number the
 * manual prints.
 */
export const BB_G407_REPEAT_N = 3;

/**
 * HOW FAST AN ELEMENT MAY SLIP AGAINST A FRAME AND STILL BE RIDING IT (in/s), for `bbAboard`.
 *
 * Measured (`scratch/aboard-probe.ts`): a POLLEN resting on a parked robot's top plate jitters
 * at 2.4 in/s, and a shot crossing a chassis in plan moves at 100+ in/s against it. 12 sits
 * five times over the jitter and an order of magnitude under the slowest shot.
 */
export const BB_ABOARD_SLIP = 12; // in/s

/**
 * HOW CLOSE AN OPPONENT'S FRAME MUST BE TO HAVE SHOVED A NECTAR INTO THIS ROBOT (in), for G204:
 * one NECTAR's width between the two footprints, plus the contact slack G402 uses.
 */
export const BB_G408_SHOVE_GAP = 2 * BB_NECTAR_R + BB_FOUL_SLOP;

/**
 * HOW HARD THE SHOVER MUST BE DRIVING AT THIS ROBOT (stick, 0–1), for G204. `APPROX`: a quarter
 * stick is a deliberate drive, and keeps a stick resting just off centre from excusing anyone.
 */
export const BB_G204_SHOVE_STICK = 0.25;

/**
 * HOW MUCH THIS ROBOT MAY BE DRIVING TOWARD THE NECTAR AND STILL HAVE BEEN FORCED (stick), for
 * G204. `APPROX`: a tenth, so a driver holding still against the shove is excused and one
 * driving onto the element at any real throttle is not.
 */
export const BB_G204_OWN_STICK = 0.1;

/**
 * WHICH ELEMENTS ARE RIDING ON OR UNDER A ROBOT'S FRAME — CONTROL by the glossary's first clause,
 * "fully supported by or stuck in, on, or under the ROBOT", and QA34: "This would include
 * SCORING ELEMENTS stuck under an intake." 3D only (`SIM_PATCH` 13): the 2D solve cannot put an
 * element inside a footprint (`placeGroundArtifact` re-places one).
 *
 * ⚠️ **THE HERD TEST NEVER SAW THESE.** Measured on the 3D solve: a POLLEN dropped on a parked
 * robot comes to rest on its top plate 11.3 in up, tagged `flight` (it is off the tiles and
 * never quite still), so `bbLooseElement` does not offer it to the count at all; and one that is
 * offered never builds a hold, because a robot carrying something on its back is not PUSHING
 * it. G407's guidance names exactly this case ("guards to prevent SCORING ELEMENTS from
 * accidentally becoming stuck on top of the ROBOT").
 *
 * The test: a loose element (`ground` or `flight`), its centre inside the CHASSIS FRAME in plan
 * — the frame and not the intake's reach, so an element in the mouth stays the herd test's and
 * the mouth carve-out's — and moving WITH the robot (`BB_ABOARD_SLIP` against the frame's own
 * point velocity), for `POSSESSION_CONFIRM` running. A shot passing over is in plan for a few
 * ticks at a hundred inches a second against the frame and never accumulates.
 *
 * The clocks ride `bb.aboard` (plain JSON, rebuilt each tick, so a lapsed one is gone).
 */
function bbAboard(world: World, dt: number): Map<number, Set<number>> {
  const bb = world.biobuzz!;
  const out = new Map<number, Set<number>>();
  const next: Record<string, number> = {};
  for (const r of world.robots) {
    const c = dcos(r.heading);
    const s = dsin(r.heading);
    const chassis = r.spec.imported ? bbImportSolids(r.spec).chassis : null;
    const hl = r.spec.length / 2;
    const hw = r.spec.width / 2;
    let reach2 = hl * hl + hw * hw;
    if (chassis) for (const p of chassis) reach2 = Math.max(reach2, p.x * p.x + p.y * p.y);
    for (const b of world.balls) {
      if (b.state.kind !== 'ground' && b.state.kind !== 'flight') continue;
      const dx = b.pos.x - r.pos.x;
      const dy = b.pos.y - r.pos.y;
      if (dx * dx + dy * dy > reach2) continue;
      const loc = { x: dx * c + dy * s, y: -dx * s + dy * c };
      const inside = chassis ? polyFeature(chassis, loc).inside : Math.abs(loc.x) <= hl && Math.abs(loc.y) <= hw;
      if (!inside) continue;
      const pv = robotPointVelocity(r, b.pos);
      if (hyp(b.vel.x - pv.x, b.vel.y - pv.y) > BB_ABOARD_SLIP) continue;
      const key = `${r.id}:${b.id}`;
      const t = (bb.aboard?.[key] ?? 0) + dt;
      next[key] = t;
      if (t < POSSESSION_CONFIRM) continue;
      let set = out.get(r.id);
      if (!set) out.set(r.id, (set = new Set()));
      set.add(b.id);
    }
  }
  if (Object.keys(next).length > 0) bb.aboard = next;
  else delete bb.aboard;
  return out;
}

/**
 * DOES THIS ELEMENT SCORE FOR `a` WHERE IT IS? — G408's "gaining a competitive advantage" test.
 * An opponent's NECTAR scores for the GARDEN's colour whoever put it there, and for the HIVE it
 * sits in (`score.ts`). Not a FLOWER: only a Box Tube places in one, and a tube places its own
 * alliance's NECTAR only (`placeInFlower`).
 */
function bbScoresFor(b: Artifact, a: Alliance): boolean {
  if (b.state.kind === 'element') return b.state.el === `hive:${a}`;
  return bbInGarden(b, a);
}

/**
 * DID AN OPPONENT SHOVE THIS ROBOT'S NEW CONTROL ON IT? — G204: "Violations forced in this
 * manner will not result in an assignment of a penalty ... to the targeted ALLIANCE."
 *
 * The same INTENT test G402's `bbShovedAcross` uses, for the same reason: a NECTAR driven into a
 * robot moves exactly like one the robot drove into, so velocity cannot tell them apart and the
 * sticks can. Forced when an opposing robot within one NECTAR's width (`BB_G408_SHOVE_GAP`) is
 * driving at this one (`BB_G204_SHOVE_STICK`), AND this one is not driving toward the NECTAR
 * (`BB_G204_OWN_STICK`). A command-less fixture is never excused: something has to be pushing.
 *
 * ⚠️ **THE SECOND HALF IS ABOUT THE NECTAR, NOT THE SHOVER.** It used to read "this one is not
 * driving back at the shover", which a robot FLEEING satisfies: driving away from a defender
 * straight onto the opponent's NECTAR ahead of it was excused, held or herded. G204 asks for "a
 * deliberate act with limited or no opportunity for the team being acted on to avoid the
 * penalty", and a robot driving onto the element had every opportunity. Reading the direction to
 * the element covers both real shapes: the shover pushing its NECTAR into this robot (the
 * element is between them, and this robot is not driving at it) and the shover pushing this
 * robot onto one (the element is ahead, and this robot is not driving there — leaning back
 * against the shove included).
 *
 * WHERE THE NECTAR IS: a loose one's own position; a held one's capture point. `capturePollen`
 * leaves `pos` where the intake took it, and neither solve moves a held element (it has no body
 * in 3D), so on the tick an instance opens (penalties run before gameplay) `pos` is the mouth it
 * came in by. An element at the robot's very centre has no direction, and falls back to "not
 * driving at the shover".
 */
function bbForcedInto(world: World, r: RobotState, b: Artifact, commands: Map<number, RobotCommand>): boolean {
  const own = driveIntent(r, commands.get(r.id));
  for (const y of world.robots) {
    if (y.alliance === r.alliance || y.passive) continue;
    if (bbFootprintGap(r, y) > BB_G408_SHOVE_GAP) continue;
    const dx = r.pos.x - y.pos.x;
    const dy = r.pos.y - y.pos.y;
    const d = hyp(dx, dy);
    if (d < 1e-6) continue;
    const at = driveIntent(y, commands.get(y.id));
    // y drives at r
    if ((at.x * dx + at.y * dy) / d <= BB_G204_SHOVE_STICK) continue;
    // ...and r is not driving toward the element (or, for one at its centre, back at y)
    const ex = b.pos.x - r.pos.x;
    const ey = b.pos.y - r.pos.y;
    const de = hyp(ex, ey);
    const toward = de > 1e-6 ? (own.x * ex + own.y * ey) / de : -(own.x * dx + own.y * dy) / d;
    if (toward <= BB_G204_OWN_STICK) return true;
  }
  return false;
}

/** G408's sanctions, both through here so the card is issued once per MATCH whichever test fires. */
function bbG408Open(world: World, r: RobotState): void {
  const bb = world.biobuzz!;
  const n = ((bb.g408 ??= {})[r.id] = (bb.g408[r.id] ?? 0) + 1);
  bbAwardFoul(world, r.alliance, 'warning', `G408 CONTROL of the opponent’s NECTAR`);
  if (n >= 2) bbG408Card(world, r, 'G408 REPEATED CONTROL of the opponent’s NECTAR');
}

function bbG408Card(world: World, r: RobotState, rule: string): void {
  const latch = (world.biobuzz!.held[r.id] ??= {});
  if (latch.g408card) return;
  latch.g408card = true;
  awardCard(world, r, rule);
}

/**
 * G408 FROM `SIM_PATCH` 13 — every kind of CONTROL, and STRATEGIC as §10.6 and the Q&A read it.
 *
 * ── WHICH CONTROL ───────────────────────────────────────────────────────────
 * QA4: "If a ROBOT CONTROLS an opponent NECTAR for any amount of time, it's a violation of G408".
 * So all three of the glossary's ways count, not only HOLDING: an opponent NECTAR in the hopper,
 * one HERDED or chained (`controlledArtifacts`' own ids, so it passes the same intent gates G407
 * does — 22 in/s at the contact, 5 in carried, 0.45 s confirmed, a flat or concave face), and
 * one riding on or under the frame (`bbAboard`). What those gates leave out is exactly the
 * orange box's not-CONTROL list: bulldozing (D), a deflection (E) and a launched element (F).
 *
 * ── AN INSTANCE ─────────────────────────────────────────────────────────────
 * Per (robot, element), in `bb.g408i`. It opens with a WARNING and stays open while the robot
 * keeps control; a drop and re-take inside `BB_CONTROL_REARM_S` is the same instance.
 *
 * ── STRATEGIC: the YELLOW CARD, once per MATCH ──────────────────────────────
 *  · the SECOND instance this match (TU06's REPEATED, as before);
 *  · an instance held past MOMENTARY (`BB_MOMENTARY_S`). QA4: "A ROBOT that immediately ejects
 *    opponent NECTAR in a way that does not gain a competitive advantage would typically not be
 *    considered a STRATEGIC violation" — and keeping it three seconds is not ejecting it;
 *  · the NECTAR SCORING FOR THE CONTROLLER (its GARDEN, or a CELL of its HIVE) while controlled or
 *    within `BB_MOMENTARY_S` after: the competitive advantage §10.6 defines STRATEGIC by. Herding
 *    an opponent's NECTAR into your own GARDEN is the case.
 *
 * ── G204 ────────────────────────────────────────────────────────────────────
 * An instance that OPENS because an opponent shoved the NECTAR into this robot (`bbForcedInto`)
 * draws nothing. It stays excused while it is MOMENTARY; a robot that keeps it longer has made it
 * its own ("Accidental situations that are then deliberately used to a team's advantage will be
 * viewed as STRATEGIC", §10.6), and it bills there as an instance past MOMENTARY.
 */
function bbG408(world: World, commands: Map<number, RobotCommand>, loose: Map<number, Set<number>>): void {
  const bb = world.biobuzz!;
  const now = world.time;
  const mine = new Map<number, number[]>();
  for (const b of world.balls) {
    if (b.state.kind !== 'held' || (b.color !== 'red' && b.color !== 'blue')) continue;
    const id = b.state.robot;
    const list = mine.get(id);
    if (list) list.push(b.id);
    else mine.set(id, [b.id]);
  }
  for (const r of world.robots) {
    if (r.passive) continue;
    const opp: Alliance = r.alliance === 'red' ? 'blue' : 'red';
    const ids: number[] = [];
    for (const id of mine.get(r.id) ?? []) if (world.balls.find((b) => b.id === id)?.color === opp) ids.push(id);
    for (const id of loose.get(r.id) ?? []) if (world.balls.find((b) => b.id === id)?.color === opp) ids.push(id);
    for (const id of ids) {
      const map = (bb.g408i ??= {});
      const key = `${r.id}:${id}`;
      let inst = map[key];
      if (!inst || now - inst.last > BB_CONTROL_REARM_S) {
        inst = map[key] = { at: now, last: now };
        const b = world.balls.find((x) => x.id === id);
        if (b && bbForcedInto(world, r, b, commands)) inst.forced = true;
        else bbG408Open(world, r);
      }
      inst.last = now;
      if (now - inst.at > BB_MOMENTARY_S) {
        if (inst.forced) {
          delete inst.forced;
          bbG408Open(world, r);
        }
        bbG408Card(world, r, 'G408 CONTROL of the opponent’s NECTAR past MOMENTARY');
      }
    }
  }
  if (!bb.g408i) return;
  for (const key of Object.keys(bb.g408i)) {
    const inst = bb.g408i[key];
    if (now - inst.last > BB_MOMENTARY_S) {
      delete bb.g408i[key];
      continue;
    }
    if (inst.forced) continue;
    const at = key.indexOf(':');
    const rid = Number(key.slice(0, at));
    const bid = Number(key.slice(at + 1));
    const r = world.robots.find((x) => x.id === rid);
    const b = world.balls.find((x) => x.id === bid);
    if (!r || !b) {
      delete bb.g408i[key];
      continue;
    }
    if (!r.passive && bbScoresFor(b, r.alliance)) bbG408Card(world, r, 'G408 opponent’s NECTAR CONTROLLED to score');
  }
  if (Object.keys(bb.g408i).length === 0) delete bb.g408i;
}

/** G407's STRATEGIC sanction: the MAJOR (every instance, owner ruling 2026-09-22) and, from
 * `SIM_PATCH` 13, the YELLOW CARD once per MATCH. */
function bbG407Strategic(world: World, r: RobotState, v13: boolean, rule: string): void {
  const latch = (world.biobuzz!.held[r.id] ??= {});
  // a HUD marker, not a gate: `hud.ts` reads it for the `controlMajor` chip.
  latch.g407billed = true;
  bbAwardFoul(world, r.alliance, 'major', rule);
  if (!v13 || latch.g407card) return;
  latch.g407card = true;
  awardCard(world, r, rule);
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
 *
 * ⚠️ **FREE DRIVE IS THE ONE PHASE WHERE "LOCKED BY DEFAULT" IS THE WRONG DEFAULT**, and it is
 * the exception the paragraph above earns by being explicit. `freeplay` has no AUTO, no buzzer
 * and no clock — `phaseTimeLeft` is not counting anything — so there is no 1:00 cue to be early
 * for, and the negated form would have made every NECTAR ever placed in a FLOWER in free drive
 * a MAJOR the moment the engine started running in that phase. A rule about a moment in a match
 * cannot be enforced in a mode that has no moments.
 */
export function bbNectarLocked(world: World): boolean {
  const m = world.match;
  if (m.phase === 'freeplay') return false;
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
  /**
   * ⚠️ **FREE DRIVE COUNTS**, and this line is DECODE's own, arrived at the same way.
   *
   * `freeplay` is a LIVE phase everywhere else in this game — `robotsEnabled` says so, the human
   * player restocks in it, the shooter fires in it, the score pass runs in it — and the penalty
   * engine was the one subsystem that quietly excluded it. So the whole of Section 11 was OFF in
   * the mode people actually practise in. Measured on an identical driven eight-element herd,
   * 3D, the same robot and the same command: a MATCH drew the G407 WARNING and the STRATEGIC
   * MAJOR, and free drive drew **nothing at all** — the per-element hold clock never left 0.000,
   * because no line of this function ran.
   *
   * Free Drive is DRIVER PRACTICE, and practising without the fouls a match would give you is
   * the opposite of practice. `src/sim/penalties.ts` carries the identical paragraph for DECODE,
   * which got here first and for the same reported reason.
   *
   * The phase-specific rules stay correctly inert on their own terms rather than by a second
   * list kept here: G402 tests `isAuto`, and G410's cue is explicitly absent in a mode with no
   * clock (`bbNectarLocked`). G407 and G421 are about what a robot is doing right now, so they
   * are exactly the two that should be live in practice.
   */
  const isFree = phase === 'freeplay';
  if (!isAuto && !isTeleop && !isFree) {
    // No fouls outside the PLAYED periods (pre / transition / post), and the memory
    // is CLEARED rather than kept: a condition that was true at the buzzer must not count as
    // "already fired" when play resumes, or the first real instance of it goes unbilled.
    bb.foulEdge = {};
    /**
     * ...and G402's RE-ARM CLOCKS with it. `pen.episodes` has one user on a BIOBUZZ world (the
     * G402 window below), so the whole map goes: a crossing that was live at the AUTO buzzer
     * must not still be counted as "the same instance" if AUTO ever resumes.
     */
    world.penalties.episodes = {};
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
    // ...and the G408 instances and the ride-along clocks, for the same reason (`SIM_PATCH` 13;
    // both are absent on every older world, so this is a no-op there).
    delete bb.g408i;
    delete bb.aboard;
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
        // The OFFENDER is the alliance whose NECTAR it is. Only a Box Tube puts a NECTAR in a
        // FLOWER, and a tube places its own alliance's only (`placeInFlower`) — an opponent
        // NECTAR a POLLEN + NECTAR intake took never goes in — so its colour names who put it
        // there without the sim having to remember who carried it.
        fire(`g410-${id}`, k, 'major', 'G410 NECTAR in a FLOWER before 1:00');
      }
    }
  }

  /**
   * `SIM_PATCH` 13 — G407 and G408 as manual TU07 and the Q&A have them (2026-11-01). Every change
   * below that moves a score or a card sits behind it, so a replay recorded earlier re-simulates
   * the match it was: herded and on-robot opponent NECTAR, G408's MOMENTARY and scoring tests, the
   * G204 excuse, the 1-s re-arm, G407's YELLOW CARD and its escalation on the third instance.
   */
  const v13 = simPatchAtLeast(world, 13);

  // ── CONTROL, ONCE PER ROBOT — what G408 and G407 both read ────────────────
  /**
   * The clock sweep runs ONCE, before the per-robot loop, because it is keyed on every
   * (robot, element) pair and would otherwise redo the whole scan per robot.
   */
  bbSweepControlClocks(world);
  const pen = world.penalties;
  // one geometry for the tick — it reads only the world's physics tag and each robot at call time
  const geom = bbControlGeometry(world);
  // elements riding ON or UNDER a frame (QA34), which only the 3D solve can produce
  const aboard = v13 && biobuzzPhysics(world) === '3d' ? bbAboard(world, dt) : null;
  const counts = new Map<number, number>();
  /** the loose elements each robot CONTROLS this tick — herded, chained or aboard (`SIM_PATCH` 13) */
  const loose = new Map<number, Set<number>>();
  for (const r of world.robots) {
    /**
     * THE COUNT AND BOTH STRATEGIC CLOCKS RUN FOR EVERY ROBOT, passive included, and only the
     * SANCTIONS are skipped. `controlledArtifacts` is not a pure reader — it advances and
     * DRAINS the per-element hold clocks as a side effect — so skipping a passive robot here
     * would freeze its clocks at whatever they held when it went passive, and an element it was
     * once against would still be latched to it if it came back. DECODE's own loop has no
     * passive guard for the same reason. A passive robot is a prop; it draws no sanction, but
     * its clocks still drain like anyone else's.
     */
    const intaking = (commands.get(r.id)?.intake ?? false) || r.autoIntake;
    const ids = v13 ? new Set<number>() : undefined;
    let controlled = bbControlled(world, r, dt, intaking, geom, ids);
    // ...plus what rides on or under it and the herd test did not already count
    for (const id of aboard?.get(r.id) ?? []) {
      if (ids?.has(id)) continue;
      ids?.add(id);
      controlled++;
    }
    counts.set(r.id, controlled);
    if (ids) loose.set(r.id, ids);
  }

  // ── G408 — CONTROL of the opponent's NECTAR. WARNING, then a YELLOW CARD. ──
  /**
   * "A ROBOT may not CONTROL the opponent's NECTAR." Violation: **VERBAL WARNING. YELLOW CARD per
   * MATCH, if STRATEGIC.** (Table 10-4; QA23 quotes it with a MAJOR, and the manual wins — §1.7.1.)
   * TU06 adds: "REPEATED instances of a ROBOT CONTROLLING an opponent's NECTAR are likely to be
   * perceived as STRATEGIC, even if the ROBOT has a sorting mechanism that automatically discards
   * opponent NECTAR by returning it to approximately its original state." REPEATED is the
   * glossary's "more than once within a MATCH", so:
   *
   *  · every INSTANCE is a WARNING, keyed per (robot, element), so one held for a minute is one
   *    instance and one taken twice is two;
   *  · the SECOND instance this match is STRATEGIC, and draws the YELLOW CARD, once per MATCH
   *    (`bb.held[id].g408card`). The shared `awardCard` issues it, so a team already holding a
   *    yellow goes to red and its alliance's score is voided, which `score.ts` already honours.
   *
   * From `SIM_PATCH` 13 `bbG408` runs instead of the loop below: every kind of CONTROL counts, not
   * only a held one, and STRATEGIC has two more readings. See its header.
   *
   * No points move, as the manual says. The tally rides `bb.g408` for the HUD.
   */
  if (v13) {
    bbG408(world, commands, loose);
  } else {
    /**
     * BEFORE `SIM_PATCH` 13: HOLDING only. Herding was not counted, because the herd test was
     * tuned to count a pile for G407 and nobody had checked it against a single NECTAR.
     */
    for (const b of world.balls) {
      if (b.state.kind !== 'held') continue;
      if (b.color !== 'red' && b.color !== 'blue') continue;
      const holder = world.robots.find((x) => x.id === (b.state as { robot: number }).robot);
      if (!holder || holder.passive || b.color === holder.alliance) continue;
      const key = `g408-${holder.id}-${b.id}`;
      if (!bb.foulEdge[key]) {
        const n = ((bb.g408 ??= {})[holder.id] = (bb.g408[holder.id] ?? 0) + 1);
        bbAwardFoul(world, holder.alliance, 'warning', `G408 CONTROL of the opponent’s NECTAR`);
        const latch = (bb.held[holder.id] ??= {});
        if (n >= 2 && !latch.g408card) {
          latch.g408card = true;
          awardCard(world, holder, 'G408 REPEATED CONTROL of the opponent’s NECTAR');
        }
      }
      seen[key] = true;
    }
  }

  // ── G407 — CONTROL of more than 4 SCORING ELEMENTS. WARNING, then MAJOR. ──
  /**
   * "A ROBOT may not CONTROL more than 4 SCORING ELEMENTS." Violation: **VERBAL WARNING**;
   * MAJOR FOUL and YELLOW CARD per MATCH, if STRATEGIC (Table 10-4). Owner ruling 2026-09-19
   * supersedes the 2026-09-12 "the sim models the warning and nothing else" ruling: unlike
   * G417's, this rule's STRATEGIC test turned out to have a MEASURABLE reading, so it is now
   * modelled rather than left as a warning forever. (The hopper's 4-element cap is a separate
   * owner ruling on the hardware, in `config.ts`; it does not replace this rule.)
   *
   * ── THE MANUAL'S OWN STRATEGIC TEST (p108, verbatim examples) ─────────────
   * Likely STRATEGIC: (A) "A ROBOT that picks up and CONTROLS 6 or more SCORING ELEMENTS,
   * moving them to a scoring location"; (B) "Multiple instances of greater than MOMENTARY
   * CONTROL of 5 or more SCORING ELEMENTS by a ROBOT throughout a MATCH." Likely **not**
   * STRATEGIC: "A ROBOT MOMENTARILY CONTROLS 5 SCORING ELEMENTS which they 'reverse' quickly so
   * that at least one SCORING ELEMENT returns to approximately its original state." So the
   * sim's test is (A) CONTROL of 6+ sustained past MOMENTARY, OR (B) this robot's SECOND (or
   * later) instance this match of CONTROL of 5+ sustained past MOMENTARY — an instance
   * "reversed quickly" (ended within MOMENTARY) never counts toward (B) and never bills.
   * `BB_MOMENTARY_S` is the manual's own number for both clocks, so a one-tick contact-chain
   * blip to six is not a MAJOR — a referee could not see it either.
   *
   * ── (C) ROUTINE MOMENTARY CONTROL IS STRATEGIC TOO (`SIM_PATCH` 13) ──────
   * TU05's note: "REPEATED instances of a ROBOT CONTROLLING 5 or more SCORING ELEMENTS are likely
   * to be perceived as STRATEGIC, even if the ROBOT has a 'keep 4 and discard the rest' sorting
   * mechanism", and QA23: "a ROBOT that routinely MOMENTARILY CONTROLS more than 4 SCORING
   * ELEMENTS ... as part of the ROBOT design and/or strategy is likely to be perceived as
   * deliberately violating G407". The orange box's (C) excuses an ISOLATED momentary five, so the
   * sim excuses two and calls the THIRD instance in a match STRATEGIC on its own, however short
   * (`BB_G407_REPEAT_N`), and every one after it. Such an instance bills once: `g407rep` keeps
   * (A) and (B) from billing it a second time when it also runs long.
   *
   * ── THE YELLOW CARD (`SIM_PATCH` 13) ───────────────────────────────────────
   * Table 10-4 expands this row as "a MAJOR FOUL is assessed ... and after the MATCH, the
   * violating team is issued a YELLOW CARD". It goes through the shared `awardCard`, once per
   * MATCH (`bb.held[id].g407card`), the same way G408's does, so a robot carded for G408 as well
   * goes to red and its alliance's score is voided. Before 13 the card was left out.
   *
   * ── THE WARNING, AND ITS COUNT IS A PER-MATCH TALLY ───────────────────────
   * The key is per ROBOT, so a robot that climbs to five, drops back to four and climbs again warns
   * TWICE — two separate instances of the violation, which is what §10.6 means by "each instance".
   * Holding five for a minute is ONE warning. From `SIM_PATCH` 13 "drops back" means for longer
   * than `BB_CONTROL_REARM_S`: a pile whose chain flickers 5-4-5 inside a second is one instance,
   * because the third instance now costs a MAJOR and a flicker must not be able to buy it.
   *
   * The warning tally rides `world.penalties.controlInstances` — the SHARED `PenaltyState`,
   * already `Record<robotId, number>`, already initialised on a BIOBUZZ world and already
   * meaning exactly this in DECODE ("how many stretches of over-control this match"). The two
   * STRATEGIC clocks below reuse two more of DECODE's own fields the same way, since BIOBUZZ
   * never runs a line of `src/sim/penalties.ts` and both sit unused on a BIOBUZZ world:
   * `controlHeld` (DECODE's own clause-B 5+/MOMENTARY clock) for the 5+ streak, and
   * `possession` (DECODE's G408 leaky clock) repurposed for the 6+ streak. Same argument as the
   * pin clocks: a second copy on the state bag would be a `state.ts` edit to store what the
   * world already stores. None of the three is cleared at a phase boundary — a clock is live
   * state and a tally is history, and the HUD chip counts the match.
   *
   * ── EVERY STRATEGIC INSTANCE BILLS (owner ruling 2026-09-22) ─────────────
   * The MAJOR used to sit behind a per-robot LATCH, `bb.held[robot].g407billed`, read off "MAJOR
   * FOUL ... per MATCH" (Table 10-4), so a robot paid once however many qualifying instances it
   * racked up. The owner overruled that reading: each time 6+ is sustained past MOMENTARY, and
   * each 5+ instance from the second onward, is its own MAJOR. (The card, above, is per MATCH,
   * and whether the MAJOR should be too is still the owner's call — see HANDOFF 2026-11-01.)
   *
   * Nothing debounces it, because nothing needs to: `qualified5`/`qualified6` are the single
   * tick a streak CROSSES `BB_MOMENTARY_S`, so a held pile qualifies once and then has to drop
   * below the count and climb back to qualify again. The flag is still SET, as a HUD marker —
   * `hud.ts`'s `controlMajor` chip reads it to show the escalation — but nothing reads it here.
   */
  for (const r of world.robots) {
    const controlled = counts.get(r.id) ?? 0;

    // THE 5+ STREAK — rule (B)'s underlying instance count. One continuous stretch of
    // controlling 5+; the INSTANCE is counted the tick the stretch crosses MOMENTARY, exactly
    // DECODE's own clause-B idiom (`updatePossession`). A stretch that never reaches MOMENTARY
    // — "reversed quickly" — resets to 0 without ever incrementing the count, which is what
    // keeps it from ever billing.
    const five = controlled >= BB_CONTROL_LIMIT + 1;
    const prev5 = pen.controlHeld[r.id] ?? 0;
    const now5 = five ? prev5 + dt : 0;
    pen.controlHeld[r.id] = now5;
    const qualified5 = five && prev5 < BB_MOMENTARY_S && now5 >= BB_MOMENTARY_S;
    if (qualified5) pen.possessionBilled[r.id] = (pen.possessionBilled[r.id] ?? 0) + 1;

    // THE 6+ STREAK — rule (A). A second, independent clock: 6+ can open and close inside a
    // longer 5+ episode, and rule (A) asks about 6+ ALONE, sustained on its own past MOMENTARY.
    const six = controlled >= BB_CONTROL_LIMIT + 2;
    const prev6 = pen.possession[r.id] ?? 0;
    const now6 = six ? prev6 + dt : 0;
    pen.possession[r.id] = now6;
    const qualified6 = six && prev6 < BB_MOMENTARY_S && now6 >= BB_MOMENTARY_S;

    // THE MAJOR — (A) OR (B), once per qualifying instance, and never for a passive prop — nor
    // for an instance (C) already billed when it opened.
    const billedAtOpen = v13 && bb.held[r.id]?.g407rep === true;
    const strategic = !billedAtOpen && (qualified6 || (qualified5 && (pen.possessionBilled[r.id] ?? 0) >= 2));
    if (!r.passive && strategic) {
      bbG407Strategic(world, r, v13, `G407 STRATEGIC CONTROL of ${BB_CONTROL_LIMIT + 1}+ elements`);
    }

    if (r.passive) continue;
    if (controlled <= BB_CONTROL_LIMIT) continue;
    if (!v13) {
      const key = `g407-${r.id}`;
      if (!bb.foulEdge[key]) {
        pen.controlInstances[r.id] = (pen.controlInstances[r.id] ?? 0) + 1;
        bbAwardFoul(world, r.alliance, 'warning', `G407 CONTROL of ${BB_CONTROL_LIMIT + 1}+ elements`);
      }
      seen[key] = true;
      continue;
    }
    // `SIM_PATCH` 13: an instance re-arms only after `BB_CONTROL_REARM_S` at 4 or fewer. The clock
    // is `pen.episodes`, which G402 already keeps the same way and the phase guard already clears.
    const ek = `g407-${r.id}`;
    const last = pen.episodes[ek];
    pen.episodes[ek] = world.time;
    if (last !== undefined && world.time - last <= BB_CONTROL_REARM_S) continue;
    const n = (pen.controlInstances[r.id] = (pen.controlInstances[r.id] ?? 0) + 1);
    bbAwardFoul(world, r.alliance, 'warning', `G407 CONTROL of ${BB_CONTROL_LIMIT + 1}+ elements`);
    if (n >= BB_G407_REPEAT_N) {
      (bb.held[r.id] ??= {}).g407rep = true;
      bbG407Strategic(world, r, v13, `G407 REPEATED CONTROL of ${BB_CONTROL_LIMIT + 1}+ elements`);
    } else if (bb.held[r.id]) {
      delete bb.held[r.id].g407rep;
    }
  }

  // ── G402 — AUTO interference across the halves. MAJOR on the crosser. ─────
  // Every pair of OPPOSING robots in contact. Same-alliance pairs are skipped: no FTC contact
  // rule has ever penalised touching your own partner.
  //
  // ⚠️ THE PHASE TEST COMES FIRST. It used to sit AFTER `bbRobotsContact`, so every opposing pair
  // paid two `robotCorners` allocations and a four-axis SAT on every tick of the two-minute
  // TELEOP for an answer the next line threw away. G421 asks the same question for itself.
  for (let i = 0; isAuto && i < world.robots.length; i++) {
    for (let j = i + 1; j < world.robots.length; j++) {
      const A = world.robots[i];
      const B = world.robots[j];
      if (A.alliance === B.alliance) continue;
      // `passive` robots — free-drive dummies — draw no sanction, the same way G407 and
      // the pin accumulator skip them. Billing a MAJOR to whichever colour a dummy was spawned
      // as is a foul awarded to nobody. This loop was the one place that did not skip them.
      if (A.passive || B.passive) continue;
      if (!bbRobotsContact(A, B)) continue;
      /**
       * G402: during AUTO, red plays columns A–C (x < 0) and blue D–F (x > 0). The foul is on
       * the robot that CROSSED — reaching into the opponent's half, in contact with an opponent.
       *
       * ── ⚠️ "FULLY ACROSS, BY EVERY CORNER" WAS THE BUG, AND IT WAS A BIG ONE ──
       * This used to require EVERY corner of the crosser's footprint past the centre line
       * (`fullyCrossed`). A robot is about 21 in long with its sweepers, so that asks for the
       * REAR bumper to be 10.5 in inside the opponent's half — which, in the only situation the
       * rule is ever about, is 10.5 in the crosser does not have: it is nose-to-nose with the
       * opponent it just hit, and the only way further in is to bulldoze them there first.
       *
       * Measured headlessly, both pipelines, red driving across into a parked blue (owner
       * report 2026-09-19, "crossing half and colliding is not giving penalties a lot of the
       * times"):
       *   · victim 10 in past the line — first contact tick 36, foul tick 73. 0.6 s of shoving,
       *     and 21 in of the victim's own half given away, before the rule said anything.
       *   · victim at 0.3 throttle — contact 31, foul 137. Over a second and a half.
       *   · a 20 lb mecanum ramming a 42 lb tank that will not move — 449 ticks of continuous
       *     contact, the crosser's nose 4.1 in inside the opponent's half, **NO FOUL EVER**.
       *   · a full-speed hit that bounces off (12 ticks of contact) — **NO FOUL EVER**.
       * The last two are the ordinary case. A robot that cannot push its victim can never earn
       * a rule written as "push your victim a chassis-length".
       *
       * So the test is now DEPTH, and the offender is the one who reached FURTHER across:
       * `bbIntrusion` is how far a robot's CHASSIS FRAME is into the opponent's half (read its
       * header — the frame and not the collision footprint is what stops the VICTIM of a ram
       * being billed for its own sweeper overhang), and the robot with the greater depth is the
       * one that came over. That makes it fire on the FIRST tick of contact for a robot that
       * actually crossed, and it keeps a robot wholly on its own side — depth 0 — unbillable no
       * matter how hard it is rammed. Both crossing at once (equal depth, the head-on meeting
       * at the line) is two fouls, which is still correct: two CROSSERS are two offenders, and
       * each carries its own pair key.
       *
       * ── EVERY CROSS-AND-HIT IS BILLED (owner ruling 2026-09-22) ────────────
       * This used to sit behind a per-MATCH latch (`bb.held[x.id].g402billed`), read off Table
       * 10-4's "MAJOR FOUL per MATCH", so a robot that crossed, backed off and crossed again
       * paid 20 once. The owner overruled that reading: every distinct instance bills, and the
       * latch is gone.
       *
       * So the only question left is what ONE instance is, and that is the RE-ARM WINDOW below
       * rather than `foulEdge`: the pair key is refreshed on every qualifying tick and re-arms
       * only after `BB_G402_REARM_S` with no qualifying tick at all. A continuous shove is one
       * foul; backing off and hitting again is two; and the contact test going quiet for a few
       * ticks in the middle of one hit is still one. It is the same episode debounce DECODE's
       * own G402 runs on (`src/sim/penalties.ts`, `PENALTY_CLEAR`), and it replaces the edge
       * trigger here rather than sitting behind it — two memories of "again" that disagree is
       * worse than one that is a little blunt.
       *
       * THE CLOCK IS `world.penalties.episodes`, whose documented meaning is exactly this
       * ("last `world.time` the rule was active for that subject"). It is plain JSON, rides
       * every snapshot and reconcile, and is otherwise unused on a BIOBUZZ world — the same
       * argument that put G407's clocks on `world.penalties` rather than a second bag in
       * `state.ts`.
       */
      const depthA = bbIntrusion(A);
      const depthB = bbIntrusion(B);
      for (const [x, y, dx, dy] of [
        [A, B, depthA, depthB],
        [B, A, depthB, depthA],
      ] as const) {
        // NOT ACROSS, or not the one who came over.
        if (dx <= BB_G402_CROSS_IN || dx < dy) continue;
        /**
         * ...AND A ROBOT SHOVED ACROSS BY ITS OPPONENT HAS NOT CROSSED.
         *
         * G402's own notes say elements "deflected across the line by another object will
         * likely not be penalized", and the subject of the rule is a TEAM disrupting AUTO — a
         * robot bulldozed into the opponent's half by the opponent disrupted nothing. It is
         * asked here rather than above so the window records CROSSINGS only: an excused tick
         * must not refresh the clock, or a shove that turns into a genuine drive-in a second
         * later is swallowed by the shove.
         *
         * Measured before this: blue driving a parked, command-less red 30 in into blue's
         * own half billed RED a MAJOR at tick 51, on top of blue's own (correct) one.
         */
        if (bbShovedAcross(x, y, commands)) continue;
        const key = `g402-${x.id}-${y.id}`;
        const last = pen.episodes[key];
        if (last === undefined || world.time - last > BB_G402_REARM_S) {
          bbAwardFoul(world, x.alliance, 'major', 'G402 crossing into the opponent’s half in AUTO');
        }
        pen.episodes[key] = world.time;
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
 *      `PIN_ESCAPE_DIST` is 24 in of GAP between the two footprints (`bbFootprintGap`, not the
 *      centre distance) and `PIN_END_S` is 3;
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
 *    G402 with `bbRobotsContact`, which carries `BB_FOUL_SLOP` because two chassis are in
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
   * G407 and `bbAssess` skip them. They have no alliance in any meaningful sense, and billing
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
          bbRobotsContact(pinner, pinned),
          commands.get(pinned.id),
          commands.get(pinner.id),
          // THIS field's solids. Left to its default the test reads DECODE's goal wedges and
          // classifier channels, which on this field are open floor in two corners and say
          // nothing about the FLOWER feet and HIVE frame bars a robot is actually held
          // against — and a victim wrongly read as cornered is read as ESCAPING, so the pin
          // it is in bills nothing. See `bbPinSolid`.
          bbPinSolid,
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
      //
      // ⚠️ A IS MEASURED BETWEEN THE ROBOTS, NOT BETWEEN THEIR CENTRES. "The ROBOTS have
      // separated by at least 2 ft. from each other" is the gap between two bodies. Measured
      // centre-to-centre, two 21-in footprints in contact are already 21 in apart, so a pinner
      // that backed off three inches satisfied A and could end any pin by idling there for three
      // seconds. `bbFootprintGap` is the daylight between the two collision footprints, sweepers
      // included. B stays centre-based: "moved 2 ft. from where the PIN initiated" is a
      // displacement of one robot, and a robot's centre is what moves with it.
      const apart = bbFootprintGap(pinned, pinner) >= PIN_ESCAPE_DIST;
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
      st.at = world.time;
      // MAJOR at 3 s, and another every 3 s the situation is not corrected — Table 10-6's
      // "6 MAJOR FOULS for 15 seconds in violation", which is 18 s of pinning and `floor(18/3)`.
      // A `while` rather than an `if` because a coarse `dt` can cross two thresholds in one
      // tick, and a pin is not cheaper for having been stepped at 10 Hz.
      while (st.seconds >= PIN_SECONDS * (st.billed + 1)) {
        st.billed += 1;
        bbAwardFoul(world, pinner.alliance, 'major', 'G421 PINNING an opponent for more than 3 s');
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
 * HOW FAR THIS ROBOT'S FRAME IS INTO THE OPPONENT'S HALF (in) — 0 if no part of it is across.
 *
 * G402, Fig 9-5: red plays columns A–C (x < 0) and blue D–F (x > 0), so the OPPONENT's half is
 * the positive-x side for red and the negative-x side for blue.
 *
 * ── ⚠️ THE CHASSIS BOX, NOT THE COLLISION FOOTPRINT, AND THAT IS THE WHOLE ──
 * ── DIFFERENCE BETWEEN THIS RULE AND ONE THAT BILLS THE VICTIM ──────────────
 * `robotCorners` is `spec` PLUS the intake reach, which is what two robots collide with; every
 * other test in this file uses it and should. Crossing is a different question. A sweeper
 * hanging 3 in over the seam is a MECHANISM over the line, and a robot parked on its own side
 * with its intake across it has not gone anywhere — but it is in contact the moment an opponent
 * arrives, and it is then, by a hair, the DEEPER of the two. Measured: a 42 lb tank parked at
 * x = 8 (its own half by every part of its frame) rammed by a 20 lb mecanum was billed the
 * MAJOR, on the footprint, for 2.5 in of sweeper overhang — the victim paying for the hit.
 * On the frame its depth is 0 and it is unbillable, which is the right answer and needs no
 * tunable threshold to get there: the ROBOT is its frame.
 *
 * The support function of the rotated chassis rectangle along ±x, closed form: no corner array
 * and no allocation at all, where the `fullyCrossed` it replaces built four `Vec2`s per call.
 *
 * Exported for the rules lane, which drives the depth directly on rotated boxes as well as
 * through the foul.
 */
/**
 * HOW FAR A ROBOT'S FRAME MUST BE PAST THE CENTRE LINE TO HAVE CROSSED IT (in).
 *
 * `APPROX` — the manual draws a line and prints no tolerance, so this is the width of the
 * band in which the sim declines to have an opinion. Two reasons it cannot be zero, and both
 * are measurements rather than taste:
 *
 *  · `bbRobotsContact` calls two frames touching while they are still `BB_FOUL_SLOP` apart, so a
 *    robot can be RECORDED in contact with its own frame an inch short of the other's, and the
 *    solver's resting penetration moves the same boundary the other way;
 *  · a chassis on the diagonal reaches `hypot`-far from its centre, not half-length — 11.3 in
 *    for the default 15 × 17 build against a 7.5-in nose. In a full 3D bot match a blue robot
 *    sitting at x = 10, its own side by every square measure, presented a corner **1.3 in**
 *    over the line and was billed the MAJOR when a red robot drove up to it.
 *
 * Two inches is past both. It costs the real crosser almost nothing — measured over the driven
 * matrix, the foul lands within a handful of ticks either way — and it is what keeps the rule
 * about crossing the field rather than about grazing a line.
 */
export const BB_G402_CROSS_IN = 2; // APPROX

/**
 * HOW LONG A (CROSSER, VICTIM) PAIR MUST GO QUIET BEFORE IT CAN BE BILLED AGAIN (s).
 *
 * Owner ruling 2026-09-22 removed G402's per-MATCH cap, so a second crossing is a second
 * MAJOR — which makes "when is it a second crossing?" load-bearing. Without a window it is
 * "the tick the condition rose again", and the condition is not stable across one hit: the
 * contact test carries `BB_FOUL_SLOP`, and two chassis grinding on each other cross that
 * boundary back and forth while nothing that matters changes.
 *
 * `APPROX`, and MEASURED (a 908-duel sweep: victim depth 2–30 in, lateral offset 0–16 in,
 * approach heading −30°–45°, three mass ratios, spin, a feathered stick and a victim shoving
 * back, both pipelines). The head-on shapes the rule is really about — the five scenes of
 * `g402DrivenChecks` — flicker **not at all**. The angled and offset ones do: **9 gaps, the
 * longest 0.78 s** (3D, a 20° approach on a victim 6 in deep), and in every one of them the two
 * footprints stayed within **3.4 in**, i.e. nobody ever disengaged. 1.0 s covers the worst with
 * 28% to spare, and it is still short of a real back-off-and-re-ram: a robot that gives up a
 * hit and comes back spends over a second driving each way.
 *
 * ⚠️ IT IS A BAND, NOT A THRESHOLD, AND IT DRIFTS WITH THE CHASSIS. The flicker is the contact
 * test crossing `BB_FOUL_SLOP`, so it moves whenever the footprint does — an earlier sweep, on
 * a chassis one dimension different, put the longest gap at 1.53 s. The direction of the error
 * matters more than the number: too SHORT bills one grinding engagement twice, too LONG swallows
 * a genuine second hit, and the second is the failure the owner reported. So the window is sized
 * to the flicker rather than to the widest thing ever seen.
 */
export const BB_G402_REARM_S = 1; // APPROX, s

export function bbIntrusion(r: RobotState): number {
  const want = r.alliance === 'red' ? 1 : -1; // the sign of x that is the OPPONENT's half
  /**
   * AN IMPORT'S FRAME IS ITS HULL BEHIND THE MOUTHS (`bbImportSolids().chassis`, the polygon the
   * POLLEN solve meets), and its origin is the wheelbase centre, not the middle of that shape. So
   * the depth is its deepest vertex along the line normal. The centred `length/2 × width/2` box
   * below billed a hull wholly on its own half (a 6-in rear toward the line read 2.5 in across)
   * and let a long side cross 3 in unseen.
   */
  if (r.spec.imported) {
    const c = dcos(r.heading);
    const s = dsin(r.heading);
    let deepest = -Infinity;
    for (const p of bbImportSolids(r.spec).chassis) {
      const d = (r.pos.x + p.x * c - p.y * s) * want;
      if (d > deepest) deepest = d;
    }
    return deepest > 0 ? deepest : 0;
  }
  const reach =
    Math.abs((r.spec.length / 2) * dcos(r.heading)) + Math.abs((r.spec.width / 2) * dsin(r.heading));
  const deepest = r.pos.x * want + reach;
  return deepest > 0 ? deepest : 0;
}

/**
 * IS `x` IN THE OPPONENT'S HALF ONLY BECAUSE `y` PUT IT THERE? — G402's one exception.
 *
 * The rule's own notes exempt what is "deflected across the line by another object", and the
 * sentence it qualifies is about a TEAM disrupting AUTO: a robot driven into the opponent's
 * half by that opponent disrupted nothing and is the victim of the contact, not its author.
 *
 * The test is INTENT, not velocity, and that is the whole reason it works. A shoved robot's
 * velocity points into the opponent's half exactly like a crosser's — it is being pushed that
 * way — so a velocity test cannot tell them apart. What can is that the shoved robot is not
 * ASKING to go there while the one behind it is: `driveIntent` is the same decode of a stick
 * the drivetrain itself runs (`src/sim/physics.ts`), tank side-drives included.
 *
 * Deliberately NOT "x is not driving": a robot that drove itself across and then let go of the
 * stick is still across, and a command-less fixture — every rules check in the lane — must
 * still bill the robot it placed in the opponent's half. Something has to be actively driving
 * the pair the wrong way for the excuse to apply.
 */
function bbShovedAcross(x: RobotState, y: RobotState, commands: Map<number, RobotCommand>): boolean {
  const want = x.alliance === 'red' ? 1 : -1;
  // asking to go there itself? then it is there under its own power, whatever else is pushing.
  if (driveIntent(x, commands.get(x.id)).x * want > 0) return false;
  // ...and the opponent is driving the pair that way, i.e. deeper into the opponent's own half.
  return driveIntent(y, commands.get(y.id)).x * want > 0;
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
 *
 * Exported for the rules lane: G402's re-arm window is sized against how much this test
 * flickers during one hit, and a check that measured the flicker with its own copy of the SAT
 * would be measuring the copy.
 */
export function bbRobotsContact(A: RobotState, B: RobotState): boolean {
  // a pair with an IMPORT in it: the shared hull SAT, every edge direction of both footprints
  // (two edge normals per robot is a rectangle's assumption, and a pointed hull breaks it)
  if (A.spec.imported || B.spec.imported) return polySatGap(robotHullWorld(A), robotHullWorld(B)).gap <= BB_FOUL_SLOP;
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

/**
 * THE GAP BETWEEN TWO ROBOTS' COLLISION FOOTPRINTS (in), 0 if they overlap — G421.A's
 * "separated by at least 2 ft. from each other".
 *
 * Both footprints are the `robotCorners` OBBs, which carry `footprintExtents` and so include a
 * sweeper's reach. For two disjoint convex polygons the closest pair always includes a VERTEX
 * of one of them, so the minimum over every corner of each box to every edge of the other is
 * exact. Overlap is decided first by an EXACT separating-axis test (no `BB_FOUL_SLOP`: this is a
 * distance, not a contact test, and slack here would only shift the 24 in).
 *
 * Exported for the rules smoke, which checks it directly on rotated boxes as well as through
 * the pin accumulator.
 */
export function bbFootprintGap(A: RobotState, B: RobotState): number {
  // an IMPORT: the exact distance between the two hulls, by the same vertex-to-edge argument
  if (A.spec.imported || B.spec.imported) return polyGap(robotHullWorld(A), robotHullWorld(B));
  const ca = robotCorners(A);
  const cb = robotCorners(B);
  const axes = [edgeNormal(ca[0], ca[1]), edgeNormal(ca[1], ca[2]), edgeNormal(cb[0], cb[1]), edgeNormal(cb[1], cb[2])];
  let separated = false;
  for (const ax of axes) {
    const a = projectExtent(ca, ax);
    const b = projectExtent(cb, ax);
    if (a.max < b.min || b.max < a.min) {
      separated = true;
      break;
    }
  }
  if (!separated) return 0;
  let best = Infinity;
  for (const [pts, poly] of [
    [ca, cb],
    [cb, ca],
  ] as const) {
    for (const p of pts) {
      for (let i = 0; i < 4; i++) {
        const d = pointSegmentDist(p, poly[i], poly[(i + 1) % 4]);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

function pointSegmentDist(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  let t = len2 > 0 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return hyp(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
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
