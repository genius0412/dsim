import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Alliance, Artifact, ArtifactColor, RobotCommand, RobotSpec, World } from '../../src/types';
import { BALL_REST_SPEED, PIN_WALL_SLOP, SIM_DT, START_TOUCH_TOL } from '../../src/config';
import { MATCH_SETTLE_MAX_S, newSettleClock, settleStep } from '../../src/sim/settle';
import { bbPinSolid } from '../../src/games/biobuzz/colliders';
import { createBiobuzzWorld } from '../../src/games/biobuzz/spawn';
import { biobuzzStep } from '../../src/games/biobuzz/step';
import {
  BB_FLOWER_UNLOCK_S,
  BB_GARDEN,
  BB_HALF_X,
  BB_LZ,
  BB_NECTAR_R,
  BB_POLLEN_R,
  BB_PTS,
  BB_TIP_POLLEN,
  bbLoadingZoneSpot,
} from '../../src/games/biobuzz/config';
import {
  BB_TIP_RELEASE_S,
  BB_TIP_SWING_S,
  hiveLoad,
  hiveStep,
  hiveWillTip,
} from '../../src/games/biobuzz/hive';
import { flowerScore } from '../../src/games/biobuzz/flower';
import { BIOBUZZ_BOT } from '../../src/games/biobuzz/ai';
import { bbSettled } from '../../src/games/biobuzz/settle';
import { mkWorld as bbSettleWorld } from './harness';
import {
  bbApplyScore,
  bbInGarden,
  bbKindIndex,
  bbLeftNow,
  bbWallsTouched,
  bbParkedNow,
  bbScoreWorld,
} from '../../src/games/biobuzz/score';
import {
  BB_CONTROL_LIMIT,
  BB_CONTROL_SKITTER_Z,
  BB_G402_CROSS_IN,
  BB_G402_REARM_S,
  BB_MOMENTARY_S,
  bbAwardFoul,
  bbFootprintGap,
  bbIntrusion,
  bbNectarLocked,
  bbRobotsContact,
  updateBiobuzzPenalties,
} from '../../src/games/biobuzz/penalties';
import { biobuzzFieldHud } from '../../src/games/biobuzz/hud';
import { bbScene, bbSceneAt } from '../../src/games/biobuzz/scenes';
import { footprintExtents, loadZone } from '../../src/sim/field';
import { robotIntersectsRect } from '../../src/sim/physics';
import { cmd, setup, type Check } from './harness';
import { simModuleFor } from '../../src/games/sim';

/** the repo root, for the source-text checks below — `core.ts`'s pattern. */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readRepo = (p: string): string => readFileSync(join(root, p), 'utf8');

/**
 * THE RULES LANE — Table 10-2 scoring, the Section 11 fouls, the 1:00 cue and the HUD slice.
 *
 * ── EVERY SCORING LINE IS CHECKED AGAINST ARITHMETIC DONE ON PAPER ──────────
 * Not against the function that produced it, and not against a snapshot. A scoring check that
 * says `expect(score).toEqual(scoreItAgain())` passes for every wrong table in the world. So
 * `scoringChecks` builds ONE field by hand — robots parked here, this many elements in that
 * cell, this stack in that flower — writes the sum out longhand in a comment with the manual's
 * own numbers, and asserts that one integer. If Table 10-2 is read wrong, this check is the
 * thing that says so, and it says so in points rather than in a diff of two objects.
 *
 * ── EVERY FOUL IS CHECKED FOR ITS EDGE, TWICE ───────────────────────────────
 * A penalty engine has exactly one hard part and it is not the predicate. Each rule here is
 * driven through the same three-phase script: hold the condition for several ticks (ONE foul),
 * clear it (nothing), bring it back (a SECOND foul). A rule that bills per tick fails the
 * first phase; a rule that latches forever fails the third. Both are real regressions and
 * neither shows up in a single-tick test.
 *
 * ── WHAT IS DRIVEN DIRECTLY RATHER THAN THROUGH A MATCH ─────────────────────
 * `updateBiobuzzPenalties` and `bbScoreWorld` are called on hand-built worlds. A rules check
 * should fail when a RULE is wrong, not when the drivetrain reached a wall half an inch later
 * than it used to — driving a robot into position to test G402 would make this lane's failures
 * mean two different things. The physics lane (`field.ts`) is where a robot is driven.
 */

// ─────────────────────────────────────────────────────────────────────────────
// FIXTURES
// ─────────────────────────────────────────────────────────────────────────────

/** a BIOBUZZ world with the given robots and NO elements — every check here stages its own. */
function bare(robots: { id: number; alliance: Alliance }[], spec: Partial<RobotSpec> = {}): World {
  const world = createBiobuzzWorld(
    'match',
    1234,
    robots.map((r) => setup(r.id, r.alliance, spec)),
  );
  world.balls = [];
  const bb = world.biobuzz;
  if (bb) {
    // the staged state bag names elements the line above just removed — see `bbIndexElements`
    bb.flowers.forEach((f) => {
      f.stack = [];
    });
    bb.hives.red.contents = [];
    bb.hives.blue.contents = [];
    bb.nectarStock.red = 0;
    bb.nectarStock.blue = 0;
  }
  return world;
}

/** put a robot exactly where a check wants it. Poses here are FIELD coordinates and bypass the
 * spawn anchors on purpose: a rule is about where a robot IS, not about how it got there. */
function place(world: World, id: number, x: number, y: number, headingDeg = 0): void {
  const r = world.robots.find((q) => q.id === id);
  if (!r) return;
  r.pos = { x, y };
  r.heading = (headingDeg * Math.PI) / 180;
  r.vel = { x: 0, y: 0 };
}

/**
 * TREAT WHERE THE ROBOTS ARE NOW AS WHERE THEY STARTED — the `pre`-tick bookkeeping, for a
 * fixture that teleports instead of driving.
 *
 * LEAVE is measured against the walls a ROBOT STARTED AGAINST (`BiobuzzState.startWalls`,
 * written on every `pre` tick and seeded at spawn), and a check that `place`s a robot onto a
 * wall and then runs AUTO out has skipped both. Without this the robot is judged against the
 * anchor it spawned on, which is a DIFFERENT wall, and it reads as having LEFT while sitting
 * flat against the perimeter.
 */
function markStarts(world: World): void {
  const bb = world.biobuzz;
  if (!bb) return;
  for (const r of world.robots) bb.startWalls[r.id] = bbWallsTouched(r);
}

let nextId = 500;
/** one element, in whatever state the check needs. Ids are unique across the whole lane so a
 * stale reference in one fixture can never resolve inside another. */
function el(color: ArtifactColor, state: Artifact['state'], x = 0, y = 0): Artifact {
  return {
    id: nextId++,
    color,
    r: color === 'yellow' ? BB_POLLEN_R : BB_NECTAR_R,
    state,
    pos: { x, y },
    vel: { x: 0, y: 0 },
    z: 0,
    vz: 0,
  };
}

/** push `n` elements into a FLOWER's stack, bottom → top, and into `world.balls`. */
function intoFlower(world: World, i: number, colors: ArtifactColor[]): void {
  const bb = world.biobuzz;
  if (!bb) return;
  colors.forEach((c, slot) => {
    const b = el(c, { kind: 'element', el: `flower:${i}`, slot });
    world.balls.push(b);
    bb.flowers[i].stack.push(b.id);
  });
}

/** push `n` elements into an alliance's up-CELL. */
function intoCell(world: World, a: Alliance, colors: ArtifactColor[]): void {
  const bb = world.biobuzz;
  if (!bb) return;
  colors.forEach((c, slot) => {
    const b = el(c, { kind: 'element', el: `hive:${a}`, slot });
    world.balls.push(b);
    bb.hives[a].contents.push(b.id);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// TABLE 10-2, LINE BY LINE
// ─────────────────────────────────────────────────────────────────────────────

function scoringChecks(check: Check): void {
  // ── the achievement PREDICATES, before anything is multiplied by them ──────
  {
    const w = bare([{ id: 0, alliance: 'red' }]);
    // LEAVE is "no longer contacting the perimeter wall". A robot at the wall has not left;
    // one in open field has.
    place(w, 0, -72 + 9, 0);
    check('LEAVE: a robot against the perimeter has not LEFT', !bbLeftNow(w.robots[0]));
    place(w, 0, -40, 0);
    check('LEAVE: a robot in open field has LEFT', bbLeftNow(w.robots[0]));

    /**
     * ⚠️ THE WALL IT STARTED ON, not any of the four.
     *
     * §10.5.4 says "no longer contacting THE perimeter wall", and read as all four the
     * achievement is unreachable in ordinary play: the HIVE, the FLOWERS and both GARDENS are
     * at the perimeter, so a robot that crosses the field and ends AUTO somewhere useful is
     * still touching A wall. Measured in a solo practice match before the fix — 3 points live
     * for the whole of AUTO and 0 from the buzzer on, which is what "the LEAVE points aren't
     * given" looks like from the driver's seat.
     */
    place(w, 0, -72 + 9, 0); // flat on the RED side wall, where it started
    const startedOn = bbWallsTouched(w.robots[0]);
    check('LEAVE: the start mask names the wall it is on', startedOn !== 0, String(startedOn));
    check('LEAVE: still on its own start wall — not LEFT', !bbLeftNow(w.robots[0], startedOn));
    place(w, 0, BB_HALF_X - 9, 0); // drove the width of the field, onto the OPPOSITE wall
    check(
      'LEAVE: parked on the FAR wall has LEFT — it is clear of the wall it started on',
      bbLeftNow(w.robots[0], startedOn),
    );
    check(
      'LEAVE: ...and the all-four reading is what would refuse it',
      !bbLeftNow(w.robots[0]),
    );
    place(w, 0, -40, 0);
    check(
      'LEAVE: a robot that started clear of the perimeter has nothing to leave',
      bbLeftNow(w.robots[0], 0),
    );

    // PARK is the OWN LOADING ZONE (owner ruling, field-plan §8), "at least partially".
    const lz = BB_LZ.red;
    place(w, 0, -63, 45);
    check('PARK: deep in its OWN LOADING ZONE', bbParkedNow(w.robots[0]));
    place(w, 0, -52, 22, 45);
    check('PARK: ONE CORNER over the tape still parks (Fig 10-7)', bbParkedNow(w.robots[0]));
    place(w, 0, -42, 45);
    check('PARK: clear of the tape does NOT park', !bbParkedNow(w.robots[0]));
    // the OWN-zone ruling: the same pose, in the OPPONENT's zone, is not a PARK
    place(w, 0, (BB_LZ.blue.x0 + BB_LZ.blue.x1) / 2, (BB_LZ.blue.y0 + BB_LZ.blue.y1) / 2);
    check("PARK: a RED robot deep in BLUE's zone does NOT park", !bbParkedNow(w.robots[0]));
    check('PARK: red LZ is on the LEFT wall at y > 0 (point symmetry)', lz.x1 < 0 && lz.y0 > 0);
  }

  // ── GARDEN: partial overlap counts (Fig 10-6), and only GROUND elements ────
  {
    const g = BB_GARDEN.red; // x[-72,-49], y[-72,-70] — a 2-in strip, narrower than a POLLEN
    const mid = (g.x0 + g.x1) / 2;
    const inside = el('yellow', { kind: 'ground' }, mid, (g.y0 + g.y1) / 2);
    check('GARDEN: an element centred in the strip counts', bbInGarden(inside, 'red'));
    // centre 1 in ABOVE the strip: outside it, but a 1.4-in circle still overlaps
    const over = el('yellow', { kind: 'ground' }, mid, g.y1 + 1.0);
    check('GARDEN: partial overlap counts — centre outside, circle inside', bbInGarden(over, 'red'));
    const clear = el('yellow', { kind: 'ground' }, mid, g.y1 + 2.0);
    check('GARDEN: an element clear of the strip does not', !bbInGarden(clear, 'red'));
    const held = el('yellow', { kind: 'held', robot: 0, slot: 0, lx: 0, ly: 0, side: 0 }, mid, g.y1 + 1.0);
    check('GARDEN: a HELD element over the strip does NOT count', !bbInGarden(held, 'red'));
    check("GARDEN: red's strip is in the audience-LEFT corner", g.x1 < 0 && g.y1 < 0);
  }

  // ── FLOWER ownership and the bottom-NECTAR bonus (§10.5.2, Fig 10-5) ───────
  {
    const w = bare([]);
    intoFlower(w, 0, ['yellow', 'red', 'yellow', 'yellow']);
    const kindOf = bbKindIndex(w);
    const fs = flowerScore(w.biobuzz?.flowers[0].stack ?? [], kindOf);
    /**
     * THE STACK, RESOLVED BY HAND (`flowerStackZ`, floor 0.43, volume [3.98, 21.5]):
     *   p1 centre 1.83, top 3.23  → 3.23 < 3.98, so the BOTTOM POLLEN IS BELOW THE VOLUME
     *   n2 centre 5.03            → in
     *   p3 centre 8.23            → in
     *   p4 centre 11.03           → in
     * so 3 elements score, the only NECTAR is red, and it is both the top-most and the
     * bottom-most one in the volume.
     */
    check('FLOWER: the bottom element sits BELOW the scoring volume', fs.inVolume === 3, `inVolume=${fs.inVolume}`);
    check('FLOWER: owner is the alliance of the top-most NECTAR', fs.owner === 'red', String(fs.owner));
    check(
      `FLOWER: owner earns ${BB_PTS.owned} per scoring element — 3 × 2 = 6`,
      fs.ownerPts === 6,
      String(fs.ownerPts),
    );
    check(
      `FLOWER: bottom NECTAR bonus is ${BB_PTS.bottomNectar}`,
      fs.bonusAlliance === 'red' && fs.bonusPts === BB_PTS.bottomNectar,
      `${fs.bonusAlliance}/${fs.bonusPts}`,
    );
    const empty = flowerScore([], kindOf);
    check('FLOWER: no NECTAR ⇒ no owner and no bonus', empty.owner === null && empty.bonusPts === 0);
  }

  // ── THE TIP TABLE (§4.1) — measured rows, nothing interpolated ─────────────
  {
    check(
      'TIP TABLE: the measured rows are [8, 7, 6, 3, 1, 0]',
      BB_TIP_POLLEN.join(',') === '8,7,6,3,1,0',
      BB_TIP_POLLEN.join(','),
    );
    const load = (pollen: number, nectar: number) => ({ pollen, nectar });
    check('TIP: 3 NECTAR + 3 POLLEN tips — the STAGED row', hiveWillTip(load(3, 3)));
    check('TIP: 3 NECTAR + 2 POLLEN does not', !hiveWillTip(load(2, 3)));
    check('TIP: 5 NECTAR alone tips (row 5 is 0 POLLEN)', hiveWillTip(load(0, 5)));
    check('TIP: 4 NECTAR needs 1 POLLEN', hiveWillTip(load(1, 4)) && !hiveWillTip(load(0, 4)));
    check('TIP: an EMPTY cell needs 8 POLLEN, and 7 does not tip (Event Field Setup Guide §12.3)', hiveWillTip(load(8, 0)) && !hiveWillTip(load(7, 0)));
    check('TIP: past the table the last row holds', hiveWillTip(load(0, 9)));
    const w = bare([]);
    intoCell(w, 'red', ['red', 'red', 'red', 'yellow', 'yellow']);
    const kindOf = bbKindIndex(w);
    const l = hiveLoad(w.biobuzz?.hives.red.contents ?? [], kindOf);
    check('TIP: a mixed cell counts by TYPE, not by total', l.pollen === 2 && l.nectar === 3, `${l.pollen}p/${l.nectar}n`);
  }

  // ── THE SWING: start, release at LEVEL, settle with the points (§10.5.1) ───
  {
    const w = bare([]);
    intoCell(w, 'red', ['red', 'red', 'red', 'yellow', 'yellow', 'yellow']);
    const kindOf = bbKindIndex(w);
    const bb = w.biobuzz;
    if (!bb) return;
    let hive = bb.hives.red;
    const up0 = hive.up;
    let r = hiveStep(hive, SIM_DT, kindOf);
    check(`SWING: a loaded cell starts a ${BB_TIP_SWING_S} s swing`, r.hive.tipping === BB_TIP_SWING_S, String(r.hive.tipping));
    check('SWING: no points at the START of the swing', !r.tipped && r.spilled.length === 0);
    hive = r.hive;
    // step to just past LEVEL
    let ticks = 0;
    let spilled = 0;
    let tipped = false;
    for (let i = 0; i < 400 && !tipped; i++) {
      r = hiveStep(hive, SIM_DT, kindOf);
      hive = r.hive;
      ticks++;
      if (r.spilled.length > 0) {
        spilled = r.spilled.length;
        check(
          `SWING: the tray empties at LEVEL, ${BB_TIP_RELEASE_S} s in`,
          Math.abs(ticks * SIM_DT - BB_TIP_RELEASE_S) < 2 * SIM_DT,
          `at ${(ticks * SIM_DT).toFixed(3)} s`,
        );
      }
      if (r.tipped) tipped = true;
    }
    check('SWING: all 6 elements spilled, exactly once', spilled === 6, String(spilled));
    check(
      `SWING: it settles after ${BB_TIP_SWING_S} s`,
      Math.abs(ticks * SIM_DT - BB_TIP_SWING_S) < 2 * SIM_DT,
      `at ${(ticks * SIM_DT).toFixed(3)} s`,
    );
    check('SWING: the cells swap at the settle', hive.up !== up0, `${up0} → ${hive.up}`);
    check('SWING: the new up-CELL is empty and `tips` bumped', hive.contents.length === 0 && hive.tips === 1);
    check('SWING: `released` resets for the next swing', hive.released === false);
  }

  // ── THE WHOLE TABLE, ON ONE HAND-BUILT FIELD ──────────────────────────────
  {
    const w = bare([
      { id: 0, alliance: 'red' },
      { id: 1, alliance: 'red' },
      { id: 2, alliance: 'blue' },
      { id: 3, alliance: 'blue' },
    ]);
    const bb = w.biobuzz;
    if (!bb) return;

    // LEAVE + PARK: both RED robots left and parked in both assessments; neither BLUE did.
    for (const id of [0, 1]) {
      bb.leave[id] = true;
      bb.parkAuto[id] = true;
      bb.parkTele[id] = true;
    }
    for (const id of [2, 3]) {
      bb.leave[id] = false;
      bb.parkAuto[id] = false;
      bb.parkTele[id] = false;
    }
    bb.hives.red.tips = 2;
    bb.hives.blue.tips = 5;
    intoCell(w, 'red', ['yellow', 'yellow', 'red', 'red']); // 4 elements left in red's up-CELL
    intoFlower(w, 0, ['yellow', 'red', 'yellow', 'yellow']); // 3 score, red owns, red bottom
    intoFlower(w, 1, ['yellow', 'yellow', 'blue']); // 2 score, blue owns, blue bottom
    // GARDENS: three elements in red's strip, one in blue's
    for (const x of [-70, -65, -60]) {
      w.balls.push(el('yellow', { kind: 'ground' }, x, (BB_GARDEN.red.y0 + BB_GARDEN.red.y1) / 2));
    }
    w.balls.push(el('yellow', { kind: 'ground' }, 60, (BB_GARDEN.blue.y0 + BB_GARDEN.blue.y1) / 2));
    // POST: every assessment instant has passed, so the LATCHES are what count
    w.match.phase = 'post';

    const s = bbScoreWorld(w);

    /**
     * RED, LONGHAND, straight off Table 10-2:
     *   LEAVE           2 robots × 3   =   6
     *   PARK (auto)     2 robots × 5   =  10
     *   PARK (match)    2 robots × 5   =  10
     *   HIVE TIP        2 tips  × 20   =  40
     *   up-CELL         4 elts  × 2    =   8
     *   FLOWER owned    3 elts  × 2    =   6   (F1 — the bottom POLLEN is below the volume)
     *   bottom NECTAR   1 flower × 5   =   5   (F1)
     *   GARDEN          3 elts  × 1    =   3
     *                                    ───
     *                                     88
     */
    check(`TABLE: red LEAVE = 2 × ${BB_PTS.leave} = 6`, s.red.leave === 6, String(s.red.leave));
    check(`TABLE: red AUTO PARK = 2 × ${BB_PTS.parkAuto} = 10`, s.red.parkAuto === 10, String(s.red.parkAuto));
    check(`TABLE: red MATCH PARK = 2 × ${BB_PTS.parkTele} = 10`, s.red.parkTele === 10, String(s.red.parkTele));
    check(`TABLE: red TIPS = 2 × ${BB_PTS.tip} = 40`, s.red.tipPts === 40, String(s.red.tipPts));
    check(`TABLE: red up-CELL = 4 × ${BB_PTS.cell} = 8`, s.red.cellPts === 8, String(s.red.cellPts));
    check(`TABLE: red FLOWER owned = 3 × ${BB_PTS.owned} = 6`, s.red.ownedPts === 6, String(s.red.ownedPts));
    check(`TABLE: red bottom NECTAR = 1 × ${BB_PTS.bottomNectar} = 5`, s.red.bottomPts === 5, String(s.red.bottomPts));
    check(`TABLE: red GARDEN = 3 × ${BB_PTS.garden} = 3`, s.red.gardenPts === 3, String(s.red.gardenPts));
    check('TABLE: RED TOTAL = 6+10+10+40+8+6+5+3 = 88', s.red.total === 88, String(s.red.total));

    /**
     * BLUE, longhand:
     *   HIVE TIP        5 tips × 20    = 100
     *   FLOWER owned    2 elts × 2     =   4   (F2)
     *   bottom NECTAR   1 flower × 5   =   5   (F2)
     *   GARDEN          1 elt  × 1     =   1
     *   (no LEAVE, no PARK, nothing in its up-CELL)
     *                                    ───
     *                                    110
     */
    check('TABLE: BLUE TOTAL = 100+4+5+1 = 110', s.blue.total === 110, String(s.blue.total));
    /**
     * THE FINAL SCORE IS UNCHANGED BY THE INSTANT RULING (owner ruling, 2026-09-19).
     *
     * Every harvest — the results screen, `submitRecord`, the server's finalize — happens at or
     * after `post`, so zeroing LEAVE / PARK / GARDEN until their instants moves the RUNNING
     * total and nothing that was ever banked. This world is the whole of Table 10-2 and it is
     * at `post`: 88 and 110, the same two numbers as before, with nothing left owing. Written
     * as its own check so a review can see that at a glance rather than by diffing the block.
     */
    check(
      'ASSESS: the FINAL score is unchanged by this ruling, and nothing is left pending at post',
      s.red.total === 88 && s.blue.total === 110 && s.red.pendingPts === 0 && s.blue.pendingPts === 0,
      `${s.red.total}/${s.blue.total} pending ${s.red.pendingPts}/${s.blue.pendingPts}`,
    );
    check('TABLE: blue scored nothing it did not earn (no LEAVE, no PARK)', s.blue.leave === 0 && s.blue.parkAuto === 0);
    check('TABLE: FLOWER owners are F1 red, F2 blue, F3/F4 unowned',
      s.flowerOwners.join(',') === 'red,blue,,',
      s.flowerOwners.join(','));

    /**
     * THE CELL LINE IS BANKED AT THE BUZZER, NOT LIVE (owner ruling, 2026-09-12). Table 10-2
     * pays for an element LEFT IN the up-CELL, which is a state of the field at the end — and
     * counting it live made the score climb 2 at a time as a load built and then fall by ten
     * when the HIVE did the one thing it is for.
     *
     * The same world, re-scored at each phase. The COUNT is live throughout (it is the
     * driver's readout of the tray); the POINTS are 0 until `post`, and the total is short by
     * exactly the cell line while they are.
     */
    {
      const live = (['auto', 'teleop'] as const).map((ph) => {
        w.match.phase = ph;
        return { ph, s: bbScoreWorld(w) };
      });
      w.match.phase = 'post';
      // the total is checked against the sum of the OTHER lines rather than against 88 − 8:
      // LEAVE, both PARKs and the GARDEN are themselves phase-dependent (they are instant lines
      // too, §10.5 F/G/E), so the invariant here is that the cell line contributes nothing, not
      // that the match total is a particular number. `others()` reads the same zeroed fields the
      // total sums, so the two move together and the equality still isolates `cellPts`.
      const others = (x: (typeof live)[number]['s']['red']) =>
        x.leave + x.parkAuto + x.parkTele + x.tipPts + x.ownedPts + x.bottomPts + x.gardenPts;
      const bad = live.filter((x) => x.s.red.cellPts !== 0 || x.s.red.cellCount !== 4 || x.s.red.total !== others(x.s.red));
      check(
        'TABLE: the up-CELL line is 0 until the buzzer, and the COUNT stays live throughout',
        bad.length === 0 && s.red.cellPts === 8,
        bad.length
          ? bad.map((x) => `${x.ph}: pts=${x.s.red.cellPts} count=${x.s.red.cellCount} total=${x.s.red.total}`).join(' · ')
          : `auto ${live[0].s.red.total} / teleop ${live[1].s.red.total}, both with 0 cell points and 4 in the tray · post: ${s.red.cellPts} pts on a total of ${s.red.total}`,
      );
    }

    // RP thresholds (Table 10-2/10-3)
    check('RP: SWARM — red LEAVE+PARK 26 ≥ 16', s.rp.red.swarm, `${s.red.leave + s.red.parkAuto + s.red.parkTele}`);
    check('RP: SWARM — blue has 0, no RP', !s.rp.blue.swarm);
    check('RP: POLLINATOR 1 — blue 5 tips ≥ 4, red 2 tips does not', s.rp.blue.pollinator1 && !s.rp.red.pollinator1);
    check('RP: POLLINATOR 2 — 5 tips is short of 7', !s.rp.blue.pollinator2);

    // and the write-back the shared chrome reads
    bbApplyScore(w, s);
    check('APPLY: `bb.points` carries the game total', bb.points.red === 88 && bb.points.blue === 110);
    check(
      'APPLY: `match.scores.total` is the game total plus this alliance\'s foul points',
      w.match.scores.red.total === 88 && w.match.scores.blue.total === 110,
      `${w.match.scores.red.total}/${w.match.scores.blue.total}`,
    );
    check('APPLY: the shared `leave` field mirrors the LEAVE line', w.match.scores.red.leave === 6);

    // a RED CARD voids the match (§10.6.1) — the same rule the shared recompute applies
    w.match.scores.red.voided = true;
    bbApplyScore(w, bbScoreWorld(w));
    check('APPLY: a VOIDED alliance totals 0 however much it earned', w.match.scores.red.total === 0);
    w.match.scores.red.voided = false;

    // ── the HUD slice off the same field ────────────────────────────────────
    const hud = biobuzzFieldHud(w);
    check('HUD: the up-CELL splits by TYPE', hud.cells.red.pollen === 2 && hud.cells.red.nectar === 2,
      `${hud.cells.red.pollen}p/${hud.cells.red.nectar}n`);
    /** 2 NECTAR in the cell ⇒ `BB_TIP_POLLEN[2]` is 6, and it holds 2 POLLEN, so 4 more. */
    check('HUD: `needed` is the measured row minus what is there — 6 − 2 = 4', hud.cells.red.needed === 4,
      String(hud.cells.red.needed));
    check('HUD: tips and flower owners come through', hud.cells.blue.tips === 5 && hud.flowerOwners[1] === 'blue');
    check('HUD: flower depth is the stack length', hud.flowerDepth.join(',') === '4,3,0,0', hud.flowerDepth.join(','));
    check('HUD: the score breakdown rides the slice', hud.score.red.total === 88);
  }

  /**
   * ── THE FOUR INSTANT-ASSESSED LINES, AND THE TWO CONTINUOUS ONES ──────────
   *
   * §10.5 assesses LEAVE and AUTO PARK at the end of AUTO (F), TELEOP PARK at the end of the
   * MATCH (G), and the up-CELL contents and the GARDEN once everything has come to rest (C, E).
   * Each of those is worth ZERO until its instant has passed (owner ruling, 2026-09-19) — the
   * live predicate feeds the COUNT and `pendingPts`, and neither reaches the total.
   *
   * It shipped the other way, and the measurement is the reason these checks exist: a RED robot
   * free-placed clear of the perimeter with one POLLEN in its GARDEN put **4 points on the bar
   * before the match started** and 9 one second into AUTO, 29 s before anything on it had been
   * assessed. The FINAL score never moved — every harvest is at or after `post` — so what these
   * pin is the RUNNING total, which is the only thing that was wrong.
   *
   * The TIP (§10.5 A) and both FLOWER lines (§10.5 D, "throughout the MATCH") are CONTINUOUS
   * and are checked here too, as negative controls: they must stay live, or somebody latches
   * them by symmetry later and this bug comes back pointing the other way.
   */

  // ── LEAVE: a live COUNT before the instant, the LATCH after it, 0 points until then ───
  {
    const w = bare([{ id: 0, alliance: 'red' }]);
    const bb = w.biobuzz;
    if (!bb) return;
    place(w, 0, -40, 0); // clear of the wall, clear of the zone
    w.match.phase = 'auto';
    {
      const s = bbScoreWorld(w).red;
      check(
        'ASSESS (§10.5 F): LEAVE during AUTO is a PENDING COUNT worth 0 points',
        s.leave === 0 && s.leaveCount === 1 && s.pendingPts === BB_PTS.leave,
        `pts=${s.leave} count=${s.leaveCount} pending=${s.pendingPts}`,
      );
    }
    // the latch says otherwise, and after the instant the latch is what is read
    bb.leave[0] = false;
    w.match.phase = 'teleop';
    check('ASSESS: after the instant the LATCH is read, not the live pose', bbScoreWorld(w).red.leave === 0);
    bb.leave[0] = true;
    place(w, 0, -72 + 9, 0); // back at the wall — the achievement is kept
    check('ASSESS: a robot that returns to the wall KEEPS its LEAVE', bbScoreWorld(w).red.leave === BB_PTS.leave);
  }

  /**
   * ONE POSE THAT SATISFIES LEAVE AND PARK AT ONCE, derived from the wall rather than typed.
   *
   * Both are measured off the FOOTPRINT, which is 21 × 17 — `robotExtents` adds the sweeper's
   * reach to each end — so the near corner is 10.5 in from the centre and a pose that looks
   * clear by an inch is not. The same derivation the two-instant check in `cueChecks` uses, and
   * for the same reason it stopped being a literal there: at x = −59 the corner sits 1.17 in
   * inside the CAD wall, i.e. within `START_TOUCH_TOL`, so the robot never LEAVES.
   */
  const CLEAR_X = -BB_HALF_X + 10.5 + START_TOUCH_TOL + 2;
  const LZ_Y = (BB_LZ.red.y0 + BB_LZ.red.y1) / 2;
  /** the middle of RED's GARDEN strip, far enough off the wall that containment leaves it be. */
  const GARDEN_Y = -69;

  // ── AUTO PARK: counted live in AUTO, worth 0 until the end-of-AUTO instant (§10.5 F) ──
  {
    const w = bare([{ id: 0, alliance: 'red' }]);
    const bb = w.biobuzz;
    if (!bb) return;
    place(w, 0, CLEAR_X, LZ_Y); // clear of the perimeter AND inside its own LOADING ZONE
    markStarts(w);
    w.match.phase = 'auto';
    const during = bbScoreWorld(w).red;
    check(
      'ASSESS (§10.5 F): AUTO PARK is 0 during AUTO and lands at the instant',
      during.parkAutoCount === 1 &&
        during.parkAuto === 0 &&
        during.pendingPts === BB_PTS.leave + BB_PTS.parkAuto,
      `count=${during.parkAutoCount} pts=${during.parkAuto} pending=${during.pendingPts}`,
    );
    bb.leave[0] = true;
    bb.parkAuto[0] = true;
    w.match.phase = 'transition';
    const after = bbScoreWorld(w).red;
    check(
      'ASSESS (§10.5 F): past the instant the latched LEAVE and AUTO PARK are paid',
      after.parkAuto === BB_PTS.parkAuto && after.leave === BB_PTS.leave && after.pendingPts === 0,
      `leave=${after.leave} park=${after.parkAuto} pending=${after.pendingPts}`,
    );
  }

  // ── TELEOP PARK: counted live in TELEOP, worth 0 until the buzzer (§10.5 G) ──
  {
    const w = bare([{ id: 0, alliance: 'red' }]);
    const bb = w.biobuzz;
    if (!bb) return;
    place(w, 0, CLEAR_X, LZ_Y);
    markStarts(w);
    w.match.phase = 'teleop';
    const during = bbScoreWorld(w).red;
    check(
      'ASSESS (§10.5 G): TELEOP PARK is 0 during TELEOP and lands at post',
      during.parkTeleCount === 1 && during.parkTele === 0 && during.pendingPts === BB_PTS.parkTele,
      `count=${during.parkTeleCount} pts=${during.parkTele} pending=${during.pendingPts}`,
    );
    bb.parkTele[0] = true;
    w.match.phase = 'post';
    const after = bbScoreWorld(w).red;
    check(
      'ASSESS (§10.5 G): at post the latched TELEOP PARK is paid and nothing is left pending',
      after.parkTele === BB_PTS.parkTele && after.pendingPts === 0,
      `pts=${after.parkTele} pending=${after.pendingPts}`,
    );
  }

  // ── THE PRE-MATCH SCORE IS 0 — the regression, exactly as it was measured ──
  {
    const w = bare([{ id: 0, alliance: 'red' }]);
    const bb = w.biobuzz;
    if (!bb) return;
    // free placement is legal in this game and the editor allows a pose off the wall, which is
    // what made the bar read 4 with the field frozen: 3 for a LEAVE nothing had assessed plus 1
    // for a GARDEN pollen the match had not started to score.
    place(w, 0, -40, 0);
    markStarts(w);
    w.balls.push(el('yellow', { kind: 'ground' }, -60, GARDEN_Y));
    w.match.phase = 'pre';
    const s = bbScoreWorld(w).red;
    check(
      'ASSESS: the PRE-MATCH score is 0, even for a robot free-placed clear of the perimeter',
      s.total === 0 && s.leaveCount === 1 && s.gardenCount === 1 && s.pendingPts === BB_PTS.leave + BB_PTS.garden,
      `total=${s.total} leaveCount=${s.leaveCount} gardenCount=${s.gardenCount} pending=${s.pendingPts}`,
    );
  }

  // ── GARDEN: the twin of the up-CELL line, by §10.5 E's own words ───────────
  {
    const w = bare([{ id: 0, alliance: 'red' }]);
    if (!w.biobuzz) return;
    w.balls.push(el('yellow', { kind: 'ground' }, -60, GARDEN_Y));
    const at = (ph: World['match']['phase']) => {
      w.match.phase = ph;
      return bbScoreWorld(w).red;
    };
    const live = (['pre', 'auto', 'teleop'] as const).map((ph) => ({ ph, s: at(ph) }));
    const end = at('post');
    const bad = live.filter((x) => x.s.gardenCount !== 1 || x.s.gardenPts !== 0);
    check(
      'GARDEN (§10.5 E): the garden line is 0 until the buzzer, and the COUNT stays live',
      bad.length === 0 && end.gardenCount === 1 && end.gardenPts === BB_PTS.garden,
      bad.length
        ? bad.map((x) => `${x.ph}: count=${x.s.gardenCount} pts=${x.s.gardenPts}`).join(' · ')
        : `pre/auto/teleop: 1 in the strip, 0 points · post: ${end.gardenPts}`,
    );
  }

  // ── THE CONTINUOUS LINES MUST NOT FOLLOW — §10.5 A and D ──────────────────
  {
    const w = bare([{ id: 0, alliance: 'red' }]);
    const bb = w.biobuzz;
    if (!bb) return;
    intoFlower(w, 0, ['yellow', 'red', 'yellow', 'yellow']); // 3 in the volume, red owns, red bottom
    bb.hives.red.tips = 1;
    w.match.phase = 'teleop';
    const t = bbScoreWorld(w).red;
    check(
      "FLOWER (§10.5 D): the FLOWER lines are CONTINUOUS and stay live mid-match",
      t.ownedPts === 3 * BB_PTS.owned && t.bottomPts === BB_PTS.bottomNectar,
      `owned=${t.ownedPts} bottom=${t.bottomPts}`,
    );
    w.match.phase = 'auto';
    const a = bbScoreWorld(w).red;
    check(
      'TIP (§10.5 A): a TIP is paid the tick it completes, mid-match',
      a.tipPts === BB_PTS.tip,
      String(a.tipPts),
    );
  }

  /**
   * ── THE PHASE LADDER: the check that would have caught the bug ────────────
   *
   * A DRIVEN run through the real phase machine (`biobuzzStep`, so `bbAssess` fires at the two
   * instants it always has) on the fixture the regression was measured on — one RED robot clear
   * of the perimeter and inside its own LOADING ZONE for the whole match, one POLLEN in the red
   * GARDEN. Each phase is shortened to two ticks, the way `cueChecks` shortens them, because
   * what is under test is the boundary and not the clock.
   *
   * Sampled at every phase change, the total must read:
   *   pre 0 · auto 0 · transition 8 · teleop 8 · post 14
   * Before this ruling the same run read 4 · 9 · 9 · 14 · 14.
   *
   * ⚠️ `total + pendingPts` is 14 from TELEOP ON, and deliberately NOT before it: TELEOP PARK
   * is assessed on where a robot ends the MATCH, so during AUTO there is nothing provisional
   * about it to show and `pendingPts` does not claim it. Asserting the invariant across the
   * whole match would be asserting that a robot parked in AUTO has already earned the endgame
   * 5, which is the same class of promise this whole change exists to stop making.
   */
  {
    const w = bare([{ id: 0, alliance: 'red' }]);
    const bb = w.biobuzz;
    if (!bb) return;
    place(w, 0, CLEAR_X, LZ_Y);
    markStarts(w);
    w.balls.push(el('yellow', { kind: 'ground' }, -60, GARDEN_Y));
    const none = new Map<number, RobotCommand>();
    const rung: { phase: string; total: number; pending: number }[] = [];
    const sample = () => {
      const s = bbScoreWorld(w).red;
      rung.push({ phase: w.match.phase, total: s.total, pending: s.pendingPts });
    };
    /** two ticks of the shortened phase, which is what carries the boundary. */
    const run = () => {
      w.match.phaseTimeLeft = 2 * SIM_DT;
      biobuzzStep(w, SIM_DT, none);
      biobuzzStep(w, SIM_DT, none);
      sample();
    };
    w.match.phase = 'pre';
    sample();
    w.match.phase = 'auto';
    sample();
    run(); // AUTO ends: LEAVE and AUTO PARK are latched
    run(); // transition ends
    run(); // the MATCH ends: TELEOP PARK is latched
    const totals = rung.map((r) => r.total).join(',');
    const phases = rung.map((r) => r.phase).join(',');
    check(
      'PHASES: the running total never includes a line whose instant has not passed',
      phases === 'pre,auto,transition,teleop,post' && totals === '0,0,8,8,14',
      `${phases} → ${totals}`,
    );
    const pendings = rung.map((r) => r.pending).join(',');
    check(
      'PENDING: pendingPts is what the instants still owe, and it is never in the total',
      pendings === '9,9,1,6,0',
      `${phases} → ${pendings}`,
    );
    const late = rung.slice(3); // teleop, post
    check(
      'PENDING: from TELEOP on, total + pendingPts is the final score all the way to the buzzer',
      late.every((r) => r.total + r.pending === 14),
      late.map((r) => `${r.phase}: ${r.total}+${r.pending}`).join(' · '),
    );
  }

  // ── A TIP CAUGHT BY THE BUZZER — the swing outlasts the harvest window ─────
  /**
   * REPORTED (solo record, 2026-09-13): “sometimes when I get a tip at the end of the game it
   * deducts points from me rather than adding the points for the tip … the tip doesn't count
   * and the points get deducted”.
   *
   * Two clocks made that inevitable: the swing is `BB_TIP_SWING_S` 4.0 s and the window the
   * results screen and the server both harvested the final score on was a fixed 2.8 s (it is
   * now the field coming to rest — `src/sim/settle.ts`), so
   * a TIP triggered in the last four seconds of TELEOP could not reach `hive.tips` in time. The
   * bar passes level at `BB_TIP_RELEASE_S`, which then emptied the tray and took the cell line
   * away with it — measured on this very scene before the fix, 16 points at the buzzer and 0
   * harvested.
   *
   * §10.5 settles it, and settles both halves: (A) "Assessment of HIVE TIPS occurs throughout
   * the MATCH and continues until all SCORING ELEMENTS and ROBOTS have come to rest at the
   * conclusion of the MATCH", and (C) "Assessment of POLLEN and NECTAR remaining in the CELL
   * will occur after all SCORING ELEMENTS and ROBOTS have come to rest". The state that scores
   * is the one at REST: the swing is a TIP, and its load is not remaining in the CELL.
   *
   * The invariant checked here is the one a driver feels: THE SCORE NEVER GOES DOWN AFTER THE
   * BUZZER, and a bar that was moving when it went is paid its 20. Driven through the real
   * pipeline rather than by hand, because the bug lives in the arithmetic of those two clocks.
   */
  {
    const w = bare([{ id: 0, alliance: 'red' }]);
    const bb = w.biobuzz;
    if (!bb) return;
    place(w, 0, -40, 20); // clear of the wall and of the LOADING ZONE: no LEAVE, no PARK
    // a bare cell tips at `BB_TIP_POLLEN[0]` POLLEN, and `bare()` left it empty
    intoCell(w, 'red', Array.from({ length: BB_TIP_POLLEN[0] }, () => 'yellow' as ArtifactColor));
    const load = bb.hives.red.contents.length;
    w.match.phase = 'teleop';
    // the swing starts on the next tick, so the buzzer catches it 0.5 s in: it passes LEVEL
    // 1.5 s into `post` and settles 3.5 s in — past the fixed 2.8 s the score used to be
    // harvested at, which is the reported case exactly. The score is now harvested when the
    // SETTLE CLOCK finalizes (the one the server uses), and that has to wait for the swing.
    w.match.phaseTimeLeft = 0.5;
    const cmds = new Map<number, RobotCommand>();
    let buzzer = -1;
    let buzzerCellPts = -1;
    let lowest = Infinity;
    let harvest = -1;
    let tipsAtHarvest = -1;
    let post = 0;
    let harvestAt = -1;
    const clock = newSettleClock();
    const ticks = Math.round((0.5 + MATCH_SETTLE_MAX_S + 1) / SIM_DT);
    for (let i = 0; i < ticks && harvest < 0; i++) {
      biobuzzStep(w, SIM_DT, cmds);
      if (w.match.phase !== 'post') continue;
      const sc = bbScoreWorld(w).red;
      if (buzzer < 0) {
        buzzer = sc.total;
        buzzerCellPts = sc.cellPts;
      }
      lowest = Math.min(lowest, sc.total);
      post += SIM_DT;
      if (harvest < 0 && settleStep(clock, w, bbSettled)) {
        harvest = sc.total;
        tipsAtHarvest = sc.tipPts;
        harvestAt = post;
      }
    }
    check(
      `BUZZER TIP: the swing really was still moving when the match ended (${load} in the tray)`,
      bb.hives.red.tips === 1,
      `tips after the run: ${bb.hives.red.tips}`,
    );
    check(
      'BUZZER TIP (§10.5 A): a swing under way at the buzzer is paid its 20 right there',
      buzzer === BB_PTS.tip,
      `total at the buzzer ${buzzer}, expected ${BB_PTS.tip}`,
    );
    check(
      'BUZZER TIP (§10.5 C): its load is NOT also paid as remaining in the up-CELL',
      buzzerCellPts === 0,
      `cell points at the buzzer ${buzzerCellPts} on ${load} elements`,
    );
    check(
      'BUZZER TIP (§10.5 A): the TIP is on the board when the score is FINALIZED — the settle waits for the swing',
      tipsAtHarvest === BB_PTS.tip && harvestAt >= BB_TIP_SWING_S - 0.5,
      `tip points at finalize (+${harvestAt.toFixed(2)}s after the buzzer): ${tipsAtHarvest}`,
    );
    check(
      'BUZZER TIP: the score never goes DOWN after the buzzer — the reported deduction',
      lowest >= buzzer && harvest >= buzzer,
      `buzzer ${buzzer}, lowest ${lowest}, harvested ${harvest}`,
    );

    /* ── A TRAY OVER ITS LOAD WHEN THE MATCH IS CALLED IS A TIP ──────────────
       Reported as "last tips are not counted": the balls settle in the HIVE, the field goes
       still, the score is taken, and the 20 for the TIP that follows is not in it.

       The state this pins is the one between the two the checks above cover: the load has
       crossed `BB_TIP_POLLEN` but `hiveStep` has not yet started the swing, so `tipping` is
       still 0. `bbSettled` does hold the clock open here — but the clock has a CAP
       (`MATCH_SETTLE_MAX_S`), and the cap finalizes whatever the field looks like. Landing on
       this state used to pay NOTHING for the tip and then pay its load a SECOND time as
       elements remaining in the CELL, which is a few points against the tip's 20.

       Built by hand rather than driven, because the window is one tick wide in a driven run
       and the rule is about the STATE, not about how long it lasts. */
    {
      const q = bare([{ id: 0, alliance: 'red' }]);
      const qb = q.biobuzz;
      if (!qb) return;
      place(q, 0, -40, 20); // clear of the wall and the LOADING ZONE: no LEAVE, no PARK
      // a bare cell tips at BB_TIP_POLLEN[0]; load it to exactly that and leave it UNSWUNG
      intoCell(q, 'red', Array.from({ length: BB_TIP_POLLEN[0] }, () => 'yellow' as ArtifactColor));
      const held = qb.hives.red.contents.length;
      q.match.phase = 'post';
      const before = bbScoreWorld(q).red;
      check(
        'PENDING TIP: a tray over its calibrated load is paid its 20 when the match is called',
        before.tipPts === BB_PTS.tip,
        `tip points ${before.tipPts} on ${held} in the tray, swing not started (tipping ${qb.hives.red.tipping})`,
      );
      check(
        'PENDING TIP (§10.5 C): its load is NOT also paid as remaining in the up-CELL',
        before.cellPts === 0,
        `cell points ${before.cellPts} on ${held} elements`,
      );
      // ...and it is ONE tip, not two: mid-swing `contents` still holds the load, so the
      // pending test must not fire on top of the swinging one.
      qb.hives.red.tipping = BB_TIP_SWING_S - 0.5;
      check(
        'PENDING TIP: a swing already moving is still ONE tip, not two',
        bbScoreWorld(q).red.tipPts === BB_PTS.tip,
        `tip points ${bbScoreWorld(q).red.tipPts} while swinging with the load still aboard`,
      );
      // a tray UNDER its load is not a tip, and its contents are scored as contents
      const u = bare([{ id: 0, alliance: 'red' }]);
      const ub = u.biobuzz;
      if (!ub) return;
      place(u, 0, -40, 20);
      intoCell(u, 'red', Array.from({ length: BB_TIP_POLLEN[0] - 1 }, () => 'yellow' as ArtifactColor));
      u.match.phase = 'post';
      const under = bbScoreWorld(u).red;
      check(
        'PENDING TIP: one element short is NOT a tip, and its load still counts in the CELL',
        under.tipPts === 0 && under.cellPts > 0,
        `tip ${under.tipPts}, cell ${under.cellPts} on ${BB_TIP_POLLEN[0] - 1} elements`,
      );
    }

    // and both halves of the rule, read straight off the score on a hand-built HIVE
    const t = bare([{ id: 0, alliance: 'red' }]);
    const tb = t.biobuzz;
    if (!tb) return;
    place(t, 0, -40, 20);
    tb.hives.red.tips = 2;
    intoCell(t, 'red', ['yellow', 'yellow', 'yellow']);
    tb.hives.red.tipping = BB_TIP_SWING_S - 0.5; // moving, not yet level
    tb.hives.red.released = false;
    t.match.phase = 'teleop';
    const live = bbScoreWorld(t).red;
    check(
      'BUZZER TIP: MID-MATCH a swing pays nothing yet and the tray readout stays live',
      live.tips === 2 && live.cellCount === 3 && live.cellPts === 0,
      `tips=${live.tips} count=${live.cellCount} pts=${live.cellPts}`,
    );
    t.match.phase = 'post';
    const held = bbScoreWorld(t).red;
    check(
      'BUZZER TIP (§10.5 A+C): at the buzzer that same swing is a TIP, and its load is not in the tray',
      held.tips === 3 && held.cellCount === 0,
      `tips=${held.tips} count=${held.cellCount}`,
    );
    // past LEVEL, `contents` is the INCOMING tray's load — that one really is left in the cell
    tb.hives.red.tipping = BB_TIP_RELEASE_S - 0.5;
    tb.hives.red.released = true;
    const after = bbScoreWorld(t).red;
    check(
      'BUZZER TIP (§10.5 C): past LEVEL the tray holds the INCOMING load, which does remain in the CELL',
      after.tips === 3 && after.cellCount === 3 && after.cellPts === 3 * BB_PTS.cell,
      `tips=${after.tips} count=${after.cellCount} pts=${after.cellPts}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 11 — EVERY FOUL, ON ITS EDGE
// ─────────────────────────────────────────────────────────────────────────────

/** no commands at all — the driverless default every non-pin check runs on. */
const NO_CMD = new Map<number, RobotCommand>();

/**
 * Run the penalty engine for `n` ticks without moving anything, and report what it billed.
 *
 * `dt` is a REAL `SIM_DT` rather than a stand-in, because G421 is billed in SECONDS: a tick
 * here is a sixtieth of a second of pinning and the check arithmetic counts on it. `held` is
 * the command map — the pin detector asks whether the pinner is driving into its victim, and
 * a driverless world can never produce a pin.
 */
function bill(
  world: World,
  n = 1,
  held: Map<number, RobotCommand> = NO_CMD,
): { major: Record<Alliance, number>; minor: Record<Alliance, number>; pts: Record<Alliance, number> } {
  // ⚠️ THE CLOCK ADVANCES, because `step.ts` advances it (`world.time += dt`) and G402's
  // re-arm window is measured against it. A fixture that leaves `world.time` at 0 freezes
  // every window open, so a check that a second crossing bills again would pass or fail for
  // reasons that have nothing to do with the rule.
  for (let i = 0; i < n; i++) {
    updateBiobuzzPenalties(world, SIM_DT, held);
    world.time += SIM_DT;
  }
  return {
    major: { red: world.match.fouls.red.major, blue: world.match.fouls.blue.major },
    minor: { red: world.match.fouls.red.minor, blue: world.match.fouls.blue.minor },
    pts: { red: world.match.scores.red.foulPoints, blue: world.match.scores.blue.foulPoints },
  };
}

/** whole ticks of `s` seconds, which is the only unit the pin clock advances in. */
function ticks(s: number): number {
  return Math.round(s / SIM_DT);
}

/**
 * A command that drives a default BIOBUZZ robot along world +x (`dir` = 1) or −x (−1).
 *
 * Both the mecanum and the tank decode are filled, and they agree: `driveIntent` reads
 * `{x: driveY, y: −driveX}` rotated by the heading for a holonomic build and `(left+right)/2`
 * for a tank one, so at heading 0 either decode gives `{x: dir, y: 0}`. Writing one and not
 * the other would make this fixture depend on which drivetrain `BB_DEFAULT_SPEC` happens to
 * carry — and `attemptDir` exists precisely because a tank robot that fills neither was once
 * unable to be pinned at all.
 */
function driveX(dir: 1 | -1): RobotCommand {
  return cmd({ driveY: dir, leftDrive: dir, rightDrive: dir });
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * G402 ON A ROBOT THAT ACTUALLY DRIVES — THE SCENARIO MATRIX, BOTH PIPELINES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ **THIS BLOCK DELIBERATELY BREAKS THIS LANE'S OWN "DO NOT DRIVE" DOCTRINE**, and the bug
 * it exists for is exactly why. Every hand-placed G402 fixture above puts the crosser where
 * the rule's author imagined it — squarely inside the opponent's half, nothing in its way —
 * and eighteen of them passed green against an engine that, on a robot that had to DRIVE
 * there, billed almost nothing. Owner report 2026-09-19: "crossing half and colliding is not
 * giving penalties a lot of the times. Both 2d and 3d." Measured before the fix, red driving
 * into a parked blue:
 *
 *   · victim 10 in past the line  — first contact tick 36, foul tick 73 (0.6 s of shoving)
 *   · victim at 0.3 throttle      — contact 71, foul 137
 *   · a full-speed hit that bounces off after 12 ticks — **no foul, ever**
 *   · a 20 lb mecanum on a 42 lb tank, 449 ticks of contact — **no foul, ever**
 *
 * The cause was geometric and invisible to a placed fixture: `fullyCrossed` wanted EVERY
 * corner of a 21-in footprint past the line, i.e. the REAR bumper 10.5 in inside the opponent's
 * half — which is 10.5 in a robot nose-to-nose with its victim can only get by bulldozing them
 * there first. A rule can only be tested for that by making a robot earn its pose.
 *
 * So the runs below are SHORT (2 s or less), they assert TIMING as well as tallies, and they
 * run on BOTH physics pipelines because the owner reported both. A failure here means the
 * RULE stopped firing on a robot that drove; the placed fixtures above still say what the rule
 * means on a robot that did not.
 */
type DuelOut = {
  redMajor: number;
  blueMajor: number;
  contactAt: number;
  contactTicks: number;
  redFoulAt: number;
  blueFoulAt: number;
  /** ticks on which RED qualified as the crosser against BLUE — the engine's own predicate */
  qualTicks: number;
  /** the longest run of NON-qualifying ticks BETWEEN two qualifying ones: the chatter */
  worstGap: number;
  /** the widest the two footprints ever got during that gap (in) — proof it was one hit */
  worstGapSep: number;
};

/**
 * Drive red (id 0) against blue (id 1) on the REAL pipeline and report what was billed to whom
 * and when. `cmds` is asked per tick and may read `contactAt`, which is how the bounce scenario
 * releases the stick a fixed number of ticks after the hit the SIM found rather than after a
 * tick number hand-copied from one run of one solver.
 *
 * The foul tick is read from `world.events`, whose line names the VICTIM ("MAJOR FOUL - BLUE"
 * is a foul BY red) — the same string the HUD toast shows, so a check cannot pass by reading a
 * counter the engine also writes.
 */
function duel(opts: {
  physics: '2d' | '3d';
  phase: 'auto' | 'teleop';
  red: [number, number, number?];
  blue: [number, number, number?];
  specR?: Partial<RobotSpec>;
  specB?: Partial<RobotSpec>;
  seconds: number;
  cmds: (tick: number, contactAt: number) => Map<number, RobotCommand>;
}): DuelOut {
  const w = createBiobuzzWorld(
    'match',
    1234,
    [setup(0, 'red', opts.specR, 0), setup(1, 'blue', opts.specB, 1)],
    undefined,
    opts.physics,
  );
  w.balls = [];
  const bb = w.biobuzz;
  if (bb) {
    bb.flowers.forEach((f) => {
      f.stack = [];
    });
    bb.hives.red.contents = [];
    bb.hives.blue.contents = [];
    bb.nectarStock.red = 0;
    bb.nectarStock.blue = 0;
  }
  w.match.phase = opts.phase;
  w.match.phaseTimeLeft = opts.phase === 'auto' ? 30 : 120;
  place(w, 0, opts.red[0], opts.red[1], opts.red[2] ?? 0);
  place(w, 1, opts.blue[0], opts.blue[1], opts.blue[2] ?? 180);

  const out: DuelOut = {
    redMajor: 0,
    blueMajor: 0,
    contactAt: -1,
    contactTicks: 0,
    redFoulAt: -1,
    blueFoulAt: -1,
    qualTicks: 0,
    worstGap: 0,
    worstGapSep: 0,
  };
  /**
   * RED's side of the pair condition, read the way the engine reads it — `bbRobotsContact` and
   * `bbIntrusion` are the engine's own, so this series is the thing the re-arm window debounces
   * rather than a re-derivation of it.
   */
  const qual: boolean[] = [];
  const sep: number[] = [];
  const n = Math.round(opts.seconds / SIM_DT);
  for (let i = 0; i < n; i++) {
    const before = w.events.length;
    biobuzzStep(w, SIM_DT, opts.cmds(i, out.contactAt));
    for (let k = before; k < w.events.length; k++) {
      const e = w.events[k];
      if (!e.includes('G402')) continue;
      // the line names the VICTIM, so "- BLUE" is red's foul
      if (e.includes('- BLUE') && out.redFoulAt < 0) out.redFoulAt = i;
      if (e.includes('- RED') && out.blueFoulAt < 0) out.blueFoulAt = i;
    }
    if (w.rrContacts.length > 0) {
      out.contactTicks++;
      if (out.contactAt < 0) out.contactAt = i;
    }
    const [R, B] = w.robots;
    const dR = bbIntrusion(R);
    const dB = bbIntrusion(B);
    qual.push(bbRobotsContact(R, B) && dR > BB_G402_CROSS_IN && dR >= dB);
    sep.push(bbFootprintGap(R, B));
  }
  out.qualTicks = qual.filter(Boolean).length;
  const last = qual.lastIndexOf(true);
  for (let i = qual.indexOf(true); i >= 0 && i <= last; i++) {
    if (qual[i]) continue;
    let j = i;
    let widest = 0;
    while (j <= last && !qual[j]) widest = Math.max(widest, sep[j++]);
    if (j - i > out.worstGap) {
      out.worstGap = j - i;
      out.worstGapSep = widest;
    }
    i = j - 1;
  }
  out.redMajor = w.match.fouls.red.major;
  out.blueMajor = w.match.fouls.blue.major;
  return out;
}

/** the lane a crosser can actually use: the HIVE frame bars stand on the centre line out to
 * |y| = `BB_FRAME_Y`, so a robot driving along y = 0 is stopped by a field element and never
 * reaches the opponent at all. Every duel below runs well clear of them. */
const DUEL_Y = -40;

function g402DrivenChecks(check: Check): void {
  for (const physics of ['2d', '3d'] as const) {
    const p = physics.toUpperCase();

    // 1. THE PLAIN RAM: red drives across the line into a blue parked on its own side.
    {
      const d = duel({
        physics,
        phase: 'auto',
        red: [-40, DUEL_Y],
        blue: [10, DUEL_Y],
        seconds: 2,
        cmds: () => new Map([[0, driveX(1)]]),
      });
      check(`G402 ${p}: a driven crosser IS billed`, d.redMajor === 1, String(d.redMajor));
      check(`G402 ${p}: ...and the rammed robot on its own side is billed nothing`,
        d.blueMajor === 0, String(d.blueMajor));
      check(`G402 ${p}: ...within half a second of the hit, not after bulldozing the victim`,
        d.redFoulAt >= 0 && d.contactAt >= 0 && d.redFoulAt - d.contactAt <= ticks(0.5),
        `contact ${d.contactAt} foul ${d.redFoulAt}`);
    }

    // 2. THE BOUNCE: contact lasts a handful of ticks and the crosser backs off. This billed
    //    NOTHING before the fix — the crosser never got its rear bumper across.
    {
      const d = duel({
        physics,
        phase: 'auto',
        red: [-40, DUEL_Y],
        blue: [10, DUEL_Y],
        seconds: 2,
        // ten ticks of press, then hard reverse. Not seven: measured, the crosser's frame is
        // 1.97 in past the line at seven and 2.13 at eight, which straddles `BB_G402_CROSS_IN`
        // and would leave this check reading a threshold rather than a rule.
        cmds: (t, contactAt) =>
          new Map([[0, driveX(contactAt >= 0 && t >= contactAt + 10 ? -1 : 1)]]),
      });
      check(`G402 ${p}: a HIT-AND-BOUNCE is billed`, d.redMajor === 1, String(d.redMajor));
      check(`G402 ${p}: ...and it really was brief — well under a second of contact`,
        d.contactTicks > 0 && d.contactTicks < ticks(1), String(d.contactTicks));
      check(`G402 ${p}: ...the victim still pays nothing for being hit`, d.blueMajor === 0,
        String(d.blueMajor));
    }

    /**
     * 3. THE VICTIM THAT WILL NOT MOVE — the FALSE-POSITIVE guard, and the reason the depth is
     *    measured on the FRAME. A 20 lb mecanum leaning on a 42 lb tank parked at x = 8 cannot
     *    shift it, so nobody's chassis crosses; what DID cross, on the footprint, was the
     *    tank's own 2.5 in of sweeper overhang, which made the VICTIM the deeper of the two and
     *    billed it the MAJOR for being rammed.
     */
    {
      const d = duel({
        physics,
        phase: 'auto',
        red: [-40, DUEL_Y],
        blue: [8, DUEL_Y],
        specR: { drivetrain: 'mecanum', massLb: 20, driveRpm: 435 },
        specB: { drivetrain: 'tank', massLb: 42, driveRpm: 312 },
        seconds: 2,
        cmds: () => new Map([[0, driveX(1)]]),
      });
      check(`G402 ${p}: a robot rammed on its OWN side is never the offender`,
        d.blueMajor === 0 && d.blueFoulAt < 0, `${d.blueMajor} at ${d.blueFoulAt}`);
      check(`G402 ${p}: ...and the scene really did make contact`, d.contactTicks > ticks(1),
        String(d.contactTicks));
    }

    /**
     * 4. SHOVED ACROSS — G402's own exception ("deflected across the line by another object
     *    will likely not be penalized"). Blue drives a command-less red 30 in into blue's own
     *    half. Blue crossed and pays; red was carried and does not. Before the fix red was
     *    billed a MAJOR at tick 51 for a journey it did not make.
     */
    {
      const d = duel({
        physics,
        phase: 'auto',
        red: [-6, DUEL_Y],
        blue: [-32, DUEL_Y, 0],
        seconds: 2,
        cmds: () => new Map([[1, driveX(1)]]),
      });
      check(`G402 ${p}: the robot that drove into the opponent's half pays`, d.blueMajor === 1,
        String(d.blueMajor));
      check(`G402 ${p}: ...and the one it SHOVED across does not`, d.redMajor === 0,
        String(d.redMajor));
    }

    // 5. ...and none of it is a TELEOP rule, however hard the ram.
    {
      const d = duel({
        physics,
        phase: 'teleop',
        red: [-40, DUEL_Y],
        blue: [10, DUEL_Y],
        seconds: 2,
        cmds: () => new Map([[0, driveX(1)]]),
      });
      check(`G402 ${p}: the same ram in TELEOP bills nothing`,
        d.redMajor === 0 && d.blueMajor === 0, `${d.redMajor}/${d.blueMajor}`);
    }

    /**
     * 6. HIT, BACK OFF, HIT AGAIN — TWO MAJORs (owner ruling 2026-09-22: "right now you can
     *    only get penalized once for crossing and tapping a robot in auto"). The retreat is
     *    held past `BB_G402_REARM_S`, which is what makes this a second instance rather than
     *    the same one seen twice; scenario 1 above is the other half of the pair — a single
     *    two-second shove, billed once.
     */
    {
      const away = ticks(BB_G402_REARM_S + 0.15);
      const d = duel({
        physics,
        phase: 'auto',
        red: [-40, DUEL_Y],
        blue: [10, DUEL_Y],
        seconds: 5,
        cmds: (t, contactAt) => {
          const since = contactAt < 0 ? -1 : t - contactAt;
          const back = since >= 10 && since < 10 + away;
          return new Map([[0, driveX(back ? -1 : 1)]]);
        },
      });
      check(`G402 ${p}: hit, back off past the re-arm window, hit again — TWO MAJORs`,
        d.redMajor === 2, `${d.redMajor} major, ${d.qualTicks} qualifying ticks`);
      check(`G402 ${p}: ...and the victim still pays nothing for being hit twice`,
        d.blueMajor === 0, String(d.blueMajor));
    }

    /**
     * 7. CHATTER — ONE hit whose pair condition flickers, billed ONCE.
     *
     * The five scenes above are head-on and do not flicker at all; the angled and offset ones
     * do, because `bbRobotsContact` carries `BB_FOUL_SLOP` and two chassis grinding past each
     * other cross that boundary back and forth. Measured over 908 duels (`BB_G402_REARM_S`'s
     * own note): 9 such gaps, the longest 0.78 s, and in all of them the two footprints stayed
     * within 3.4 in — nobody disengaged.
     *
     * ⚠️ WHICH SHAPES FLICKER MOVES WITH THE CHASSIS, so this walks a list of measured ones and
     * STOPS at the first that still does. Every scene it runs is asserted to bill ONE MAJOR;
     * the last two checks then say the flicker was real and that it was one hit, which is what
     * keeps the first assertion from passing for nothing. If they ever fail together, re-measure
     * the sweep and refresh the list rather than deleting the checks.
     */
    /**
     * The 3D list was re-measured for SIM_PATCH 3 (the wall square-up inside the solve, 2026-10-02),
     * 210 duels (victim 2/4/6/12/20/30 in deep × offset 0–16 × −30°…45°): 11 flicker, the longest
     * 0.47 s but one. ⚠️ THAT ONE — victim 2 in deep, no offset, −30° — is the crosser glancing off
     * the victim into the −y wall and grinding down it: it now hugs the wall where the old square-up
     * kicked it an inch off, its corner comes back to the victim 1.17 s later with the footprints
     * never more than 3.9 in apart, and the re-arm window bills it TWICE. It was the second shape
     * here and is out of the list; whether `BB_G402_REARM_S` should cover it is an owner call.
     */
    {
      const shapes = physics === '2d'
        ? [{ bx: 2, lat: 16, deg: 35 }, { bx: 30, lat: 0, deg: 15 }, { bx: 4, lat: 12, deg: 30 },
           { bx: 12, lat: 16, deg: 30 }, { bx: 30, lat: 14, deg: 25 }]
        : [{ bx: 4, lat: 0, deg: -30 }, { bx: 2, lat: 4, deg: -30 }, { bx: 4, lat: 4, deg: -30 },
           { bx: 6, lat: 0, deg: -30 }, { bx: 2, lat: 8, deg: -15 }];
      let worst = 0;
      let worstSep = 0;
      for (const s of shapes) {
        const d = duel({
          physics,
          phase: 'auto',
          red: [-40, DUEL_Y - s.lat, s.deg],
          blue: [s.bx, DUEL_Y],
          seconds: 4,
          cmds: () => new Map([[0, driveX(1)]]),
        });
        check(`G402 ${p}: a grinding hit (victim ${s.bx}in deep, ${s.deg}deg approach) is ONE MAJOR`,
          d.redMajor === 1, `${d.redMajor} major, worst gap ${d.worstGap}t, ${d.qualTicks} qualifying ticks`);
        if (d.worstGap > worst) {
          worst = d.worstGap;
          worstSep = d.worstGapSep;
        }
        if (worst >= 2) break;
      }
      check(`G402 ${p}: ...and the chatter is REAL — the pair condition went clear mid-hit`,
        worst >= 2 && worst < ticks(BB_G402_REARM_S), `worst gap ${worst}t of ${ticks(BB_G402_REARM_S)}t`);
      check(`G402 ${p}: ...while the two chassis never separated — one hit, not two`,
        worst > 0 && worstSep <= 4, `${worstSep.toFixed(2)} in`);
    }
  }
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * G417 IS REMOVED — A HIGH-SPEED RAM OF THE HIVE BILLS NOTHING, EITHER PIPELINE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Owner ruling, 2026-09-19: every HIVE-ramming penalty is gone, in both pipelines — a driver
 * clipping the structure while driving under it is ordinary play in this sim. The rule used to
 * be 3D-only (billed from `bb.hiveRam`, which `sim3d/contacts3d.ts` wrote from the solve's own
 * contact pairs) and off in 2D by an earlier ruling; both code paths are gone with it, so what
 * is worth proving now is the NEGATIVE — that a real chassis driven full-speed into the real
 * frame, in either physics, produces no foul, no points and no event line, so the rule cannot
 * quietly come back through an untouched code path.
 */
function hiveRamRemovedChecks(check: Check): void {
  /** one robot, driven at the red HIVE frame's foot bar (x ≈ −24, |y| ≤ 19.4). */
  const ram = (physics: '2d' | '3d', x0: number, seconds: number): { major: number; pts: number; events: string[] } => {
    const w = createBiobuzzWorld('match', 7, [setup(0, 'red', {}, 0)], undefined, physics);
    w.match.phase = 'teleop';
    w.match.phaseTimeLeft = 90;
    place(w, 0, x0, 5);
    const n = Math.round(seconds / SIM_DT);
    for (let i = 0; i < n; i++) biobuzzStep(w, SIM_DT, new Map([[0, driveX(1)]]));
    return { major: w.match.fouls.red.major, pts: w.match.scores.blue.foulPoints, events: [...w.events] };
  };

  for (const physics of ['3d', '2d'] as const) {
    // a full-speed run at the frame, long enough to still be pressed against it at the end —
    // exactly the geometry the old 3D detector called a ram at 69.6 in/s.
    const hit = ram(physics, -62, 1.5);
    check(`HIVE ram (${physics}): no MAJOR`, hit.major === 0, String(hit.major));
    check(`HIVE ram (${physics}): no points move`, hit.pts === 0, String(hit.pts));
    check(`HIVE ram (${physics}): no event mentions ramming`,
      !hit.events.some((e) => /ram/i.test(e)), hit.events.join(' | '));

    // and holding the contact for several seconds — the old "per MATCH" latch's own repeat-ram
    // stress case — still bills nothing.
    const held = ram(physics, -62, 5);
    check(`HIVE ram (${physics}): a sustained press still bills nothing`,
      held.major === 0 && held.pts === 0, `major=${held.major} pts=${held.pts}`);
  }
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * G407 ON A ROBOT THAT ACTUALLY DRIVES — BOTH PIPELINES, AND FREE DRIVE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ **THIS BLOCK BREAKS THIS LANE'S "DO NOT DRIVE" DOCTRINE FOR THE SAME REASON
 * `g402DrivenChecks` DOES, AND IT IS THE SAME CLASS OF BUG A SECOND TIME.** Every G407
 * fixture above advances its pile BY HAND, which is right for asserting what the COUNT means —
 * and twenty of them passed green against an engine that, on a robot that had to DRIVE into a
 * pile, billed **nothing at all** in the physics every server-connected match runs. Owner
 * report 2026-09-21: "Overpossession penalties are not being given right now."
 *
 * MEASURED BEFORE THE FIX (`scratch/g407probe.ts`: a driven six- and eight-element herd, empty
 * and full hopper, intake on and off, AUTO and TELEOP and free drive, both pipelines):
 *
 *   pipeline / phase        peak per-element hold     count reached      G407 lines
 *   2D match  (auto+teleop)        1.27 s                  6/10          WARNING + MAJOR
 *   2D free drive                  0.00 s                  0             none
 *   3D, every phase                0.00 s                  0/4           none
 *
 * Two independent causes, one per row:
 *   · **3D** tags a PLOWED element `flight` — it skips, and `derive.ts` calls anything off the
 *     tiles by 0.05 in airborne. `controlledArtifacts` only ever looked at `ground`, and
 *     `bbSweepControlClocks` DELETED the hold of anything that was not, so every skip reset the
 *     confirm clock. `ControlGeometry.loose` / `bbLooseElement` is the fix.
 *   · **free drive** was not a played period here, where DECODE made it one long ago and wrote
 *     down why (`src/sim/penalties.ts`, "FREE DRIVE COUNTS"). Free drive is driver practice.
 *
 * So these runs DRIVE, they run on both pipelines and in all three live phases, and they assert
 * the carve-outs on a driven robot too — because a rule that fires on a bulldozer and also on
 * everyone else is not a fix. A failure here means the rule stopped reaching a robot that
 * drove; the placed fixtures above still say what the rule MEANS.
 */
function g407DrivenChecks(check: Check): void {
  /**
   * One driven scene: a blue robot at (−55, 40) nose along +x, `n` POLLEN on the floor `gap`
   * inches ahead of its own footprint and `lateral` inches off its centreline.
   *
   * y = 40 keeps the whole run clear of the HIVE frame bars (|y| ≤ `BB_FRAME_Y`), and x runs
   * −55 → 0, clear of both walls and of BOTH loading-zone rectangles — this field's `BB_LZ` and
   * DECODE's, which the shared test used to read. The field's own elements and the human
   * player's box are CLEARED so every element in the count is one this scene put there.
   */
  const scene = (
    physics: '2d' | '3d',
    phase: 'auto' | 'teleop' | 'freeplay',
    n: number,
    opts: { hopper?: number; intake?: boolean; gap?: number; lateral?: number } = {},
  ): { w: World; drive: (dir: number, s: number) => void; lines: () => string[] } => {
    const w = createBiobuzzWorld(
      phase === 'freeplay' ? 'free' : 'match',
      7,
      [setup(0, 'blue', {}, 0)],
      undefined,
      physics,
    );
    w.match.phase = phase;
    w.match.phaseTimeLeft = phase === 'teleop' ? 90 : 30;
    const r = w.robots[0];
    r.autoIntake = opts.intake ?? false;
    r.autoFire = false;
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
    place(w, 0, -55, 40);
    r.hopper = Array.from({ length: opts.hopper ?? 0 }, () => 'yellow' as const);
    const e = footprintExtents(r.spec);
    const span = (n - 1) * 3.2;
    // ⚠️ `z` IS NOT THE SAME QUANTITY IN THE TWO PIPELINES: 2D carries the element's CENTRE
    // height, 3D its BOTTOM. An element staged at the wrong one starts embedded in the tiles.
    for (let i = 0; i < n; i++) {
      w.balls.push({
        id: i + 1,
        color: 'yellow',
        r: BB_POLLEN_R,
        state: { kind: 'ground' },
        pos: { x: -55 + e.front + BB_POLLEN_R + (opts.gap ?? 1), y: 40 + (opts.lateral ?? 0) - span / 2 + i * 3.2 },
        vel: { x: 0, y: 0 },
        z: physics === '3d' ? 0 : BB_POLLEN_R,
        vz: 0,
      });
    }
    return {
      w,
      drive: (dir, s) => {
        const c = new Map([[0, cmd({ driveY: dir, intake: opts.intake ?? false })]]);
        for (let i = 0; i < ticks(s); i++) biobuzzStep(w, SIM_DT, c);
      },
      lines: () => w.events.filter((x) => x.includes('G407')),
    };
  };

  // ═══ THE RULE REACHES A ROBOT THAT DRIVES — in BOTH pipelines ═════════════
  for (const physics of ['2d', '3d'] as const) {
    {
      // SIX herded, empty hopper: every element in the count is one it shoved.
      const s = scene(physics, 'teleop', 6);
      s.drive(1, 6);
      const warn = s.lines().filter((e) => e.startsWith('WARNING'));
      const major = s.lines().filter((e) => e.includes('MAJOR'));
      check(`G407 DRIVEN (${physics}): shoving six across the floor WARNS`,
        warn.length === 1, `${warn.length} :: ${s.lines().join(' | ')}`);
      check(`G407 DRIVEN (${physics}): ...and the line names the rule and the count`,
        warn[0] === `WARNING - BLUE (G407 CONTROL of ${BB_CONTROL_LIMIT + 1}+ elements)`, warn[0] ?? '(none)');
      /**
       * ...AND IT ESCALATES. Six sustained past `BB_MOMENTARY_S` is Table 10-4's clause (A)
       * outright — "picks up and CONTROLS 6 or more SCORING ELEMENTS, moving them to a scoring
       * location" — so a six-second shove is a MAJOR on the first instance, not a second one.
       */
      check(`G407 DRIVEN (${physics}): a sustained 6+ shove escalates to the STRATEGIC MAJOR`,
        major.length === 1 && s.w.match.fouls.blue.major === 1,
        `${major.length} major, tally ${s.w.match.fouls.blue.major}`);
      check(`G407 DRIVEN (${physics}): ...and the MAJOR moves ${BB_PTS.foulMajor} points to RED`,
        s.w.match.scores.red.foulPoints === BB_PTS.foulMajor, String(s.w.match.scores.red.foulPoints));
      check(`G407 DRIVEN (${physics}): the warning tally reaches the HUD slice`,
        biobuzzFieldHud(s.w).warnings.blue === 1, String(biobuzzFieldHud(s.w).warnings.blue));
      // the per-element clock is what the 3D bug zeroed; assert the MECHANISM, not just the tally
      check(`G407 DRIVEN (${physics}): at least one element's hold clock actually latched`,
        Object.values(s.w.penalties.ballHold).some((t) => t >= 0.45),
        JSON.stringify(s.w.penalties.ballHold));
    }

    {
      // A FULL HOPPER plus a herd: the hopper is capped at 4 for good, so everything past the
      // limit here is plowed. This is the owner's own shape — driving with a full load.
      const s = scene(physics, 'teleop', 6, { hopper: BB_CONTROL_LIMIT });
      s.drive(1, 6);
      check(`G407 DRIVEN (${physics}): a FULL hopper plowing a pile is billed too`,
        s.lines().some((e) => e.startsWith('WARNING')) && s.w.match.fouls.blue.major === 1,
        s.lines().join(' | ') || '(none)');
    }

    {
      // FOUR herded is the legal number, driven exactly the same way.
      const s = scene(physics, 'teleop', 4);
      s.drive(1, 6);
      check(`G407 DRIVEN (${physics}): shoving FOUR bills nothing — that is the legal number`,
        s.lines().length === 0, s.lines().join(' | '));
    }

    // ═══ AND IT STILL DOES NOT FIRE ON ORDINARY PLAY ════════════════════════
    /**
     * The three carve-out shapes, DRIVEN. Measured over six seeds each in
     * `scratch/g407fp2.ts`: **0 G407 lines** in every one, both pipelines, clumps of six and
     * eight. They are asserted on one seed here because the lane pays for every tick it steps.
     */
    {
      // A POKE: touch the pile and reverse off it inside `POSSESSION_CONFIRM` (0.45 s).
      const s = scene(physics, 'teleop', 8);
      s.drive(1, 0.35);
      s.drive(-1, 2.5);
      check(`G407 DRIVEN (${physics}): a POKE and a retreat inside MOMENTARY bills nothing`,
        s.lines().length === 0, s.lines().join(' | '));
    }
    {
      // A DRIVE-PAST: the clump is off the centreline, so only a flank grazes it in transit.
      const s = scene(physics, 'teleop', 8, { lateral: 11 });
      s.drive(1, 4);
      check(`G407 DRIVEN (${physics}): clipping a clump while driving PAST it bills nothing`,
        s.lines().length === 0, s.lines().join(' | '));
    }
    {
      // PARKED against it, sticks neutral, for six seconds. CONTROL is not contact.
      const s = scene(physics, 'teleop', 8);
      s.drive(1, 0.42);
      s.drive(0, 6);
      check(`G407 DRIVEN (${physics}): rolling up to a clump and PARKING on it bills nothing`,
        s.lines().length === 0, s.lines().join(' | '));
    }
  }

  // ═══ FREE DRIVE IS A PLAYED PERIOD — the DECODE ruling, applied here ══════
  /**
   * ⚠️ `freeplay` used to fall through this engine's "no fouls outside the played periods"
   * guard, so the whole of Section 11 was inert in the mode people practise in. Measured on
   * the identical driven eight-element herd: a match billed the WARNING and the MAJOR and free
   * drive billed nothing, in both pipelines. `src/sim/penalties.ts` carries the same paragraph
   * for DECODE and got there first, for the same reported reason.
   */
  for (const physics of ['2d', '3d'] as const) {
    const s = scene(physics, 'freeplay', 6);
    s.drive(1, 6);
    check(`G407 FREE DRIVE (${physics}): practice bills what a match would`,
      s.lines().some((e) => e.startsWith('WARNING')) && s.w.match.fouls.blue.major === 1,
      s.lines().join(' | ') || '(none)');
    const quiet = scene(physics, 'freeplay', 8);
    quiet.drive(1, 0.35);
    quiet.drive(-1, 2.5);
    check(`G407 FREE DRIVE (${physics}): ...and the carve-outs come with it`,
      quiet.lines().length === 0, quiet.lines().join(' | '));
  }
  {
    /**
     * ...AND G410 IS THE ONE RULE THAT MUST NOT COME WITH IT. Its cue is written as "unlocked
     * WHEN teleop is inside 1:00" and negated, so every other phase is LOCKED by default —
     * which is the safe direction in a match and the wrong one in a mode that has no clock to
     * be early against. Without the carve-out, opening free drive made every NECTAR ever
     * placed in a FLOWER in practice a MAJOR.
     */
    const w = bare([{ id: 0, alliance: 'blue' }]);
    w.match.phase = 'freeplay';
    w.match.phaseTimeLeft = 0;
    check('G410: entry is NOT locked in free drive — there is no 1:00 cue to be early for',
      !bbNectarLocked(w));
    intoFlower(w, 0, ['red']);
    bill(w, 3);
    check('G410: ...so a NECTAR in a FLOWER in free drive bills nothing',
      w.match.fouls.red.major === 0 && w.events.filter((e) => e.includes('G410')).length === 0,
      w.events.join(' | '));
  }

  // ═══ WHAT `loose` COUNTS — KINEMATIC, because the TAG IS DERIVED ══════════
  /**
   * ⚠️ **THIS ONE CANNOT BE DRIVEN, AND THE REASON IS THE BUG ITSELF.** `state.kind` is not
   * authored, it is DERIVED from the element's height and motion every tick — `derive.ts` in
   * 3D, `play.ts`'s flight integrator in 2D. A driven fixture that hand-tags a row `flight`
   * has it re-tagged before the next penalty pass reads it, so the run measures the tagger and
   * not the rule. (Measured: both pipelines re-derived the row to `ground` and billed, which
   * is right behaviour and a useless check.) So the pile is advanced by hand here, exactly as
   * the placed G407 fixtures above are, and what is asserted is the PREDICATE.
   *
   * Three facts, each of which was wrong before:
   *   · under the 3D solve a `flight` element at SKITTER height is loose and counts (the bug:
   *     it was not, so a plowed pile was invisible on 14.3% of its contact ticks and its hold
   *     clock was deleted on every one of them);
   *   · in 2D it is NOT — the 2D pipeline is PERMANENT and has no skip to forgive;
   *   · and a real SHOT overhead is not, in either.
   */
  {
    const staged = (physics: '2d' | '3d', kind: 'ground' | 'flight', z: number): number => {
      const w = bare([{ id: 0, alliance: 'blue' }]);
      const bb = w.biobuzz;
      if (bb) bb.physics = physics;
      w.match.phase = 'teleop';
      w.match.phaseTimeLeft = 90;
      const r = w.robots[0];
      r.autoIntake = false;
      place(w, 0, -40, 40);
      r.hopper = [];
      const e = footprintExtents(r.spec);
      const pile: Artifact[] = [];
      for (let i = 0; i < 5; i++) {
        const b = el('yellow', kind === 'ground' ? { kind: 'ground' } : { kind: 'flight', target: 'blue' },
          r.pos.x + e.front + BB_POLLEN_R, r.pos.y - 6 + i * 3);
        b.z = z;
        w.balls.push(b);
        pile.push(b);
      }
      // robot and pile travel +x together at a herding speed, billed every tick — the same
      // hand-advance the placed G407 fixtures use.
      const v = 30;
      r.vel = { x: v, y: 0 };
      for (const b of pile) b.vel = { x: v, y: 0 };
      for (let i = 0; i < ticks(1.2); i++) {
        r.pos = { x: r.pos.x + v * SIM_DT, y: r.pos.y };
        for (const b of pile) b.pos = { x: b.pos.x + v * SIM_DT, y: b.pos.y };
        updateBiobuzzPenalties(w, SIM_DT, new Map());
      }
      return w.events.filter((x) => x.includes('G407')).length;
    };

    // the control: a plain `ground` row is counted in both, which is what makes the rest a
    // statement about the TAG rather than about the fixture.
    check('LOOSE: a `ground` row of five is counted in 2D', staged('2d', 'ground', 0) === 1, String(staged('2d', 'ground', 0)));
    check('LOOSE: a `ground` row of five is counted in 3D', staged('3d', 'ground', 0) === 1, String(staged('3d', 'ground', 0)));
    check('LOOSE (3d): a `flight` row at SKITTER height counts — a plowed element SKIPS',
      staged('3d', 'flight', 0.5) === 1, String(staged('3d', 'flight', 0.5)));
    check('LOOSE (2d): ...and in 2D it does NOT — that pipeline is permanent and has no skip',
      staged('2d', 'flight', 0.5) === 0, String(staged('2d', 'flight', 0.5)));
    check('LOOSE (3d): a `flight` row in the AIR is not controlled, whatever it passes over',
      staged('3d', 'flight', BB_CONTROL_SKITTER_Z + 6) === 0,
      String(staged('3d', 'flight', BB_CONTROL_SKITTER_Z + 6)));
    /**
     * The bound is MEASURED, not chosen (`scratch/skitter.ts`, 3D, four seeds x three headings):
     * over 14,340 ticks of chassis-on-element contact while plowing, the element's bottom never
     * rose above 0.92 in; over 246 ticks of a real shot passing over a chassis in plan, it was
     * never below 7.60 in. Anything in that gap separates them, so this asserts the GAP.
     */
    check('LOOSE: the skitter bound sits between the measured plow (0.92 in) and shot (7.60 in)',
      BB_CONTROL_SKITTER_Z > 0.92 && BB_CONTROL_SKITTER_Z < 7.6, String(BB_CONTROL_SKITTER_Z));
  }
}

function penaltyChecks(check: Check): void {
  // ── the tariff itself — MAJOR is 20 here, not DECODE's 15 ─────────────────
  check(`TARIFF: MINOR ${BB_PTS.foulMinor} / MAJOR ${BB_PTS.foulMajor} (Table 10-4)`,
    BB_PTS.foulMinor === 5 && BB_PTS.foulMajor === 20);

  /**
   * ── EVERY FOUL LINE, PINNED AS A LITERAL — the A6b UI COPY audit ──────────
   *
   * CLAUDE.md: "Foul lines name the ACT, not the place (`G424 contact in the gate zone`, not
   * `G424 gate zone`), because a driver reads them mid-match." A driver gets one toast between
   * cycles and no manual, so a bare rule id — or a rule LABEL, which is the same failure wearing
   * more words — tells them a number and not what they did. Two of the five failed the audit:
   *   · `G402 AUTO interference`  →  `G402 crossing into the opponent’s half in AUTO`
   *   · `G421 PINNING`            →  `G421 PINNING an opponent for more than 3 s`
   *
   * They are pinned by reading the ENGINE'S SOURCE for the exact bytes, not by comparing the
   * engine's output to itself — an equality against the string the code just produced passes for
   * every wrong wording in the world, which is the same argument the scoring checks make about
   * `expect(score).toEqual(scoreItAgain())`. Changing a foul line should take a deliberate edit
   * here as well as there.
   *
   * ⚠️ Typographic punctuation is part of the ruling (`’`, never `'`, measured 60:18), which is
   * why G402's line carries U+2019. BOTH G407 lines are template literals (they interpolate
   * `BB_CONTROL_LIMIT`), so neither can be grepped — both are pinned as rendered events in the
   * G407 block instead, and `foulLines` says so rather than quietly covering three of four.
   */
  {
    const src = readRepo('src/games/biobuzz/penalties.ts');
    const foulLines: [string, string][] = [
      ['G402 crossing into the opponent\u2019s half in AUTO', 'the ACT is CROSSING, not "AUTO interference"'],
      ['G410 NECTAR in a FLOWER before 1:00', 'the element, the place and the cue'],
      ['G421 PINNING an opponent for more than 3 s', 'the act AND the threshold, not a bare "PINNING"'],
    ];
    for (const [line, why] of foulLines) {
      check(`UI COPY: ${line.slice(0, 4)} names ${why}`, src.includes(`'${line}'`), line);
      check(`UI COPY: ${line.slice(0, 4)} carries no ASCII apostrophe`, !line.includes("'"), line);
    }
    // ...and the ENVELOPE around them, which is DECODE's shape so a toast reads the same in both
    // games. The WARNING branch is BIOBUZZ's own (Table 10-4's base sanction moves no points).
    const w = bare([{ id: 0, alliance: 'red' }]);
    bbAwardFoul(w, 'red', 'major', 'G410 NECTAR in a FLOWER before 1:00');
    check('UI COPY: a MAJOR names the VICTIM, the points and the rule',
      w.events[0] === `MAJOR FOUL - BLUE +${BB_PTS.foulMajor} (G410 NECTAR in a FLOWER before 1:00)`,
      w.events[0]);
    w.events.length = 0;
    bbAwardFoul(w, 'red', 'warning', 'G407 CONTROL of 5+ elements');
    check('UI COPY: a WARNING names the OFFENDER and no points, because it moves none',
      w.events[0] === 'WARNING - RED (G407 CONTROL of 5+ elements)', w.events[0]);
    w.events.length = 0;
    bbAwardFoul(w, 'red', 'major', 'G407 STRATEGIC CONTROL of 5+ elements');
    check('UI COPY: the escalated G407 MAJOR names STRATEGIC, not just the warning line',
      w.events[0] === `MAJOR FOUL - BLUE +${BB_PTS.foulMajor} (G407 STRATEGIC CONTROL of 5+ elements)`,
      w.events[0]);
  }

  // ── G410: NECTAR into a FLOWER before the 1:00 cue ─────────────────────────
  {
    const w = bare([]);
    const bb = w.biobuzz;
    if (!bb) return;
    w.match.phase = 'teleop';
    w.match.phaseTimeLeft = BB_FLOWER_UNLOCK_S + 1; // locked
    check('G410: entry is LOCKED with more than 1:00 of TELEOP left', bbNectarLocked(w));

    // a POLLEN entering early is no foul at all
    intoFlower(w, 0, ['yellow', 'yellow']);
    check('G410: POLLEN may enter a FLOWER at any time', bill(w, 5).major.red === 0);

    /**
     * ...AND THE SAME AT 2:00, WHICH IS THE OWNER'S RULING 3 WRITTEN AS A CHECK.
     *
     * G410 names NECTAR and only NECTAR, so POLLEN may enter a FLOWER at any point in the
     * match and simply earns nothing until a NECTAR gives that flower an owner (§10.5.2). The
     * line above proves it one second inside the lock; this one proves it a full minute
     * earlier, where a rule that had quietly generalised to "no SCORING ELEMENT before 1:00"
     * would be indistinguishable from a correct one.
     */
    w.match.phaseTimeLeft = 120; // 2:00 of TELEOP left — deep inside the lock
    check('G410: entry is still LOCKED at 2:00', bbNectarLocked(w));
    intoFlower(w, 2, ['yellow', 'yellow', 'yellow']);
    const pollenAt2 = bill(w, 10);
    check('G410: POLLEN entering a FLOWER at 2:00 bills NOTHING (ruling 3 — NECTAR only)',
      pollenAt2.major.red === 0 && pollenAt2.major.blue === 0 && pollenAt2.pts.blue === 0,
      `${pollenAt2.major.red}/${pollenAt2.major.blue}`);
    w.match.phaseTimeLeft = BB_FLOWER_UNLOCK_S + 1; // back to where the rest of the block runs

    // now a RED nectar, held for several ticks
    intoFlower(w, 0, ['red']);
    const one = bill(w, 10);
    check('G410: one MAJOR for one NECTAR, however long it sits there', one.major.red === 1, String(one.major.red));
    check(`G410: the points go to the OPPONENT, +${BB_PTS.foulMajor}`, one.pts.blue === BB_PTS.foulMajor, String(one.pts.blue));
    check('G410: the element still SCORES (§10.5.2) — the stack is untouched', bb.flowers[0].stack.length === 3);

    // pull it back out, hold, put it back: a SECOND illegal entry is a SECOND foul
    const id = bb.flowers[0].stack.pop() as number;
    const cleared = bill(w, 5);
    check('G410: removing it bills nothing', cleared.major.red === 1, String(cleared.major.red));
    bb.flowers[0].stack.push(id);
    const twice = bill(w, 5);
    check('G410: RE-ENTERING it fires again', twice.major.red === 2, String(twice.major.red));
    check('G410: two majors are 40 to blue', twice.pts.blue === 2 * BB_PTS.foulMajor, String(twice.pts.blue));

    // and after the cue it is simply legal
    w.match.phaseTimeLeft = BB_FLOWER_UNLOCK_S - 1;
    check('G410: entry is UNLOCKED at 1:00', !bbNectarLocked(w));
    intoFlower(w, 1, ['blue']);
    const after = bill(w, 10);
    check('G410: nothing is billed after the cue', after.major.red === 2 && after.major.blue === 0);
  }

  // ── G402: crossing into the opponent's half in AUTO — MAJOR *per instance* ─
  /**
   * The tariff is the interesting half, and it CHANGED on 2026-09-22: the owner overruled the
   * per-MATCH reading of Table 10-4 ("you can only get penalized once for crossing and tapping
   * a robot in auto. Fix that"), so the per-robot latch is gone and every distinct instance
   * bills.
   *
   * What stops a two-second shove billing 120 is now the RE-ARM WINDOW (`BB_G402_REARM_S`), not
   * an edge: the pair key is refreshed on every qualifying tick and re-arms only after the
   * window with no qualifying tick at all. So this block drives all three cases — hold it
   * (one), break it briefly and come back (still one), break it for longer than the window and
   * come back (two).
   */
  {
    const w = bare([
      { id: 0, alliance: 'red' },
      { id: 1, alliance: 'blue' },
    ]);
    w.match.phase = 'auto';
    // RED fully across the centre line (blue's columns D–F are x > 0), in contact with BLUE
    place(w, 0, 20, 0);
    place(w, 1, 32, 0);
    const held = bill(w, 30);
    check('G402: contact across the line in AUTO is ONE MAJOR on the crosser', held.major.red === 1, String(held.major.red));
    check('G402: the victim is billed nothing', held.major.blue === 0);
    check(`G402: blue is +${BB_PTS.foulMajor}`, held.pts.blue === BB_PTS.foulMajor, String(held.pts.blue));
    check('G402: the line names the ACT, not the rule label',
      w.events.some((e) => e === `MAJOR FOUL - BLUE +${BB_PTS.foulMajor} (G402 crossing into the opponent\u2019s half in AUTO)`),
      w.events.filter((e) => e.includes('G402')).join(' | '));

    // separate and come STRAIGHT back, inside the window: one hit, still one MAJOR. This is
    // the half that stops a shove that stutters across the contact slop billing twice.
    place(w, 0, -20, 0);
    const apart = bill(w, ticks(BB_G402_REARM_S / 2));
    check('G402: separating bills nothing', apart.major.red === 1);
    place(w, 0, 20, 0);
    const soon = bill(w, 10);
    check('G402: ...and re-touching INSIDE the re-arm window is the same instance, not a second',
      soon.major.red === 1, String(soon.major.red));

    // now stay away for longer than the window and cross again: a SECOND instance, and after
    // the 2026-09-22 ruling a second MAJOR. This used to be capped at one for the whole match.
    place(w, 0, -20, 0);
    bill(w, ticks(BB_G402_REARM_S) + 2);
    place(w, 0, 20, 0);
    const again = bill(w, 10);
    check('G402: re-crossing after the re-arm window IS billed again (owner ruling 2026-09-22)',
      again.major.red === 2, String(again.major.red));
    check('G402: ...so a repeat crosser owes two MAJORs, not one per MATCH',
      again.pts.blue === 2 * BB_PTS.foulMajor, String(again.pts.blue));

    // A robot on its OWN side, in contact, is not a G402 — but the one that came to it is.
    // 18 in of centre gap rather than 20: the default chassis is 15 in long with a 3-in
    // sweeper, so 20 in leaves daylight and the fixture proves nothing about contact.
    place(w, 0, -32, 0);
    place(w, 1, -14, 0);
    const own = bill(w, 10);
    check('G402: contact on the CROSSER\'s own side is not a foul', own.major.red === 2, String(own.major.red));
    check('G402: but the BLUE robot that crossed IS billed', own.major.blue === 1, String(own.major.blue));

    /**
     * ONE OFFENDER, TWO VICTIMS — TWO MAJORs, after the 2026-09-22 ruling. The key names the
     * (crosser, victim) pair, so crossing into two opponents at once is two instances of
     * interference and is billed twice; the per-MATCH latch that used to collapse them to one
     * is gone. Both blues are head-on, one ahead and one behind, at the same proven 12-in
     * centre gap the check above uses — a flank placement was tried first and does NOT make
     * contact at this footprint, which would have left this check passing for the wrong reason.
     */
    const twoVictims = bare([
      { id: 0, alliance: 'red' },
      { id: 1, alliance: 'blue' },
      { id: 2, alliance: 'blue' },
    ]);
    twoVictims.match.phase = 'auto';
    place(twoVictims, 0, 20, 0);
    place(twoVictims, 1, 32, 0);
    place(twoVictims, 2, 8, 0);
    const vv = bill(twoVictims, 30);
    check('G402: one crosser against TWO opponents is TWO MAJORs — one per victim',
      vv.major.red === 2, String(vv.major.red));
    check('G402: ...so the victims are +40 between them',
      vv.pts.blue === 2 * BB_PTS.foulMajor, String(vv.pts.blue));

    /**
     * ...and an instance belongs to ONE offender: "a TEAM may not disrupt AUTO", and an FTC
     * team is one robot. Two crossers on opposite alliances, in their own corners of the field,
     * are two teams and one MAJOR each.
     */
    const twoOffenders = bare([
      { id: 0, alliance: 'red' },
      { id: 1, alliance: 'blue' },
      { id: 2, alliance: 'blue' },
      { id: 3, alliance: 'red' },
    ]);
    twoOffenders.match.phase = 'auto';
    place(twoOffenders, 0, 20, 0); // RED, fully across into blue's columns
    place(twoOffenders, 1, 32, 0);
    place(twoOffenders, 2, -20, -50); // BLUE, fully across the other way
    place(twoOffenders, 3, -32, -50);
    const oo = bill(twoOffenders, 30);
    check('G402: two crossers are two teams and two MAJORs',
      oo.major.red === 1 && oo.major.blue === 1, `${oo.major.red}/${oo.major.blue}`);
    check('G402: ...20 each way, and neither offender window swallowed the other',
      oo.pts.red === BB_PTS.foulMajor && oo.pts.blue === BB_PTS.foulMajor,
      `${oo.pts.red}/${oo.pts.blue}`);

    // and none of it applies outside AUTO
    const t = bare([
      { id: 0, alliance: 'red' },
      { id: 1, alliance: 'blue' },
    ]);
    t.match.phase = 'teleop';
    t.match.phaseTimeLeft = 30;
    place(t, 0, 20, 0);
    place(t, 1, 32, 0);
    check('G402: crossing in TELEOP is legal', bill(t, 30).major.red === 0);

    /**
     * ── THE DEPTH TEST ITSELF, ON ITS OWN ──────────────────────────────────
     * `bbIntrusion` is how far a robot's CHASSIS FRAME is into the opponent's half, and the
     * word CHASSIS is the load-bearing one: `robotCorners` — what everything else in the file
     * measures — carries the intake reach, and a sweeper hanging over the seam is a MECHANISM
     * over the line, not a robot that has gone anywhere. Pinned here rather than only through
     * the foul, because the foul reads a DIFFERENCE of two depths and a uniform error in both
     * would cancel.
     */
    const g = bare([
      { id: 0, alliance: 'red' },
      { id: 1, alliance: 'blue' },
    ]);
    const half = g.robots[0].spec.length / 2;
    const reach = footprintExtents(g.robots[0].spec).front - half;
    check('G402 DEPTH: the fixture HAS a sweeper, or the frame/footprint split proves nothing',
      reach > 0.5, String(reach));
    place(g, 0, -40, 0);
    check('G402 DEPTH: a robot on its own side reads 0', bbIntrusion(g.robots[0]) === 0,
      String(bbIntrusion(g.robots[0])));
    place(g, 0, 3, 0);
    check('G402 DEPTH: a red robot 3 in past the line is in by 3 + its half-length',
      Math.abs(bbIntrusion(g.robots[0]) - (3 + half)) < 1e-6, String(bbIntrusion(g.robots[0])));
    // the SWEEPER over the line, the FRAME not: depth 0, where the footprint would read `reach`
    place(g, 1, half + reach / 2, 0);
    check('G402 DEPTH: a sweeper over the line is not the ROBOT over the line',
      bbIntrusion(g.robots[1]) === 0, String(bbIntrusion(g.robots[1])));
    // ...and it is the rotated box, not the axis-aligned one: at 90° the WIDTH faces the line
    place(g, 0, 0, 0, 90);
    check('G402 DEPTH: at 90° the depth is the half-WIDTH, not the half-length',
      Math.abs(bbIntrusion(g.robots[0]) - g.robots[0].spec.width / 2) < 1e-6,
      String(bbIntrusion(g.robots[0])));
  }

  g402DrivenChecks(check);
  hiveRamRemovedChecks(check);

  // ── G407: CONTROL of a fifth element — the base WARNING, held briefly ─────
  /**
   * Table 10-4's base sanction is a VERBAL WARNING, with MAJOR + YELLOW when STRATEGIC — every
   * scenario in THIS block holds 5+ only briefly (well under `BB_MOMENTARY_S`), so none of them
   * is strategic and the tariff is an event line, a HUD count, and zero points. The STRATEGIC
   * MAJOR (owner ruling 2026-09-19) has its own scenarios further down.
   *
   * The hopper is set DIRECTLY. `bbHopperCap` clamps a driven robot to 4 (`BB_STORAGE_MAX`, an
   * owner ruling that overrides Lane B relay 2), so a driven fixture could not reach five at all,
   * and a rules check should fail when the RULE is wrong, not because of another lane's dial.
   */
  {
    const w = bare([{ id: 0, alliance: 'red' }]);
    w.match.phase = 'teleop';
    w.match.phaseTimeLeft = 90;
    const r = w.robots[0];
    const warnings = () => w.events.filter((e) => e.includes('G407')).length;

    // FOUR is the legal number and never warns, however long it is held
    r.hopper = ['yellow', 'yellow', 'yellow', 'yellow'];
    const legal = bill(w, 30);
    check('G407: CONTROL of exactly 4 never warns', warnings() === 0, String(warnings()));
    check('G407: ...and a legal robot starts FULL (G304.G stages 4)', r.hopper.length === BB_CONTROL_LIMIT);

    // FIVE warns ONCE, however long it is held
    r.hopper = ['yellow', 'yellow', 'yellow', 'yellow', 'yellow'];
    const over = bill(w, 30);
    check('G407: CONTROL of 5 warns ONCE, not once per tick', warnings() === 1, String(warnings()));
    check('G407: the warning names the rule and the count',
      w.events.some((e) => e === 'WARNING - RED (G407 CONTROL of 5+ elements)'),
      w.events.filter((e) => e.includes('G407')).join(' | '));

    // ...and it is a WARNING: no points, no MAJOR, no MINOR, either way
    check('G407: no points move', over.pts.red === 0 && over.pts.blue === 0,
      `${over.pts.red}/${over.pts.blue}`);
    check('G407: no MAJOR and no MINOR — it is not a foul',
      over.major.red === 0 && over.minor.red === 0 && over.major.blue === 0 && over.minor.blue === 0);
    check('G407: and the foul tally is untouched', legal.major.red === 0 && over.major.red === 0);

    // back to 4 and up again: a SECOND instance is a SECOND warning (§10.6, per instance)
    r.hopper = ['yellow', 'yellow', 'yellow', 'yellow'];
    const back = bill(w, 10);
    check('G407: dropping back to 4 warns nothing', warnings() === 1, String(warnings()));
    r.hopper = ['yellow', 'yellow', 'yellow', 'yellow', 'yellow'];
    bill(w, 10);
    check('G407: climbing to 5 AGAIN warns again', warnings() === 2, String(warnings()));
    check('G407: still no points after two warnings', back.pts.blue === 0 && w.match.scores.blue.foulPoints === 0);

    // the HUD chip — a sanction worth no points is invisible without it
    const hud = biobuzzFieldHud(w);
    check('HUD: the G407 warning count reaches the slice', hud.warnings.red === 2, String(hud.warnings.red));
    check('HUD: and it is per ALLIANCE — blue drew none', hud.warnings.blue === 0, String(hud.warnings.blue));
  }

  // ── G407: STRATEGIC — a MAJOR for 6+ past MOMENTARY, or a second 5+ instance ─
  /**
   * Owner ruling 2026-09-19 (manual-distilled p108, verbatim examples): likely STRATEGIC is (A)
   * "A ROBOT that picks up and CONTROLS 6 or more SCORING ELEMENTS, moving them to a scoring
   * location" and (B) "Multiple instances of greater than MOMENTARY CONTROL of 5 or more
   * SCORING ELEMENTS by a ROBOT throughout a MATCH". Likely NOT strategic: "A ROBOT MOMENTARILY
   * CONTROLS 5 SCORING ELEMENTS which they 'reverse' quickly". `BB_MOMENTARY_S` is the manual's
   * own number (§10.6, "fewer than approximately 3 seconds") for both (A)'s and (B)'s clocks.
   */
  {
    const w = bare([{ id: 0, alliance: 'red' }]);
    w.match.phase = 'teleop';
    w.match.phaseTimeLeft = 90;
    const r = w.robots[0];
    const majors = () => w.match.fouls.red.major;
    const hold = (n: number, seconds: number) => {
      r.hopper = Array(n).fill('yellow');
      bill(w, ticks(seconds));
    };

    // 5, MOMENTARILY, then back to 4 — the manual's "reversed quickly" case.
    hold(5, 1);
    hold(4, 1);
    check('G407 STRATEGIC: a MOMENTARY 5 that drops back never MAJORS', majors() === 0, String(majors()));

    // 5, held PAST MOMENTARY, ONCE — the first such instance, so a warning but no MAJOR.
    hold(5, BB_MOMENTARY_S + 0.5);
    check('G407 STRATEGIC: a single >MOMENTARY 5+ instance MAJORS nothing', majors() === 0, String(majors()));

    // drop and re-raise past MOMENTARY again: the SECOND instance MAJORS the opponent.
    hold(4, 1);
    hold(5, BB_MOMENTARY_S + 0.5);
    check('G407 STRATEGIC: a second >MOMENTARY 5+ instance MAJORS the opponent',
      majors() === 1 && w.match.scores.blue.foulPoints === BB_PTS.foulMajor,
      `major=${majors()} pts=${w.match.scores.blue.foulPoints}`);

    // the HUD chip escalates from WARNED to MAJORED — same slot, `.chip.bad` in `HudSlots.tsx`.
    const hud = biobuzzFieldHud(w);
    check('HUD: controlMajor flips for the offending alliance once the MAJOR bills',
      hud.controlMajor.red === true && hud.controlMajor.blue === false,
      `red=${hud.controlMajor.red} blue=${hud.controlMajor.blue}`);

    /**
     * ...and a THIRD instance draws a THIRD MAJOR. Owner ruling 2026-09-22: the per-robot
     * `g407billed` latch is gone and every STRATEGIC instance bills. Under clause (B) the
     * second and each one after it qualifies, so three instances are two MAJORs.
     */
    hold(4, 1);
    hold(5, BB_MOMENTARY_S + 0.5);
    check('G407 STRATEGIC: a third instance draws a SECOND MAJOR — no per-MATCH cap (2026-09-22)',
      majors() === 2 && w.match.scores.blue.foulPoints === 2 * BB_PTS.foulMajor,
      `major=${majors()} pts=${w.match.scores.blue.foulPoints}`);
  }

  {
    const w = bare([{ id: 0, alliance: 'blue' }]);
    w.match.phase = 'teleop';
    w.match.phaseTimeLeft = 90;

    // 6, held PAST MOMENTARY: rule (A) MAJORS on the very FIRST instance — no second 5+
    // instance is needed.
    w.robots[0].hopper = Array(6).fill('yellow');
    const held = bill(w, ticks(BB_MOMENTARY_S + 0.5));
    check('G407 STRATEGIC: 6+ held past MOMENTARY MAJORS on the first instance',
      held.major.blue === 1 && held.pts.red === BB_PTS.foulMajor,
      `major=${held.major.blue} pts=${held.pts.red}`);

    /**
     * ...and a SECOND sustained 6+ instance is a SECOND MAJOR (owner ruling 2026-09-22). The
     * pile has to drop below six and climb back: `qualified6` is the tick the streak crosses
     * `BB_MOMENTARY_S`, so holding six for a minute stays one instance.
     */
    w.robots[0].hopper = Array(4).fill('yellow');
    bill(w, ticks(1));
    w.robots[0].hopper = Array(6).fill('yellow');
    const twice = bill(w, ticks(BB_MOMENTARY_S + 0.5));
    check('G407 STRATEGIC: a SECOND sustained 6+ instance bills a second MAJOR (2026-09-22)',
      twice.major.blue === 2 && twice.pts.red === 2 * BB_PTS.foulMajor,
      `major=${twice.major.blue} pts=${twice.pts.red}`);
    check('G407 STRATEGIC: ...and holding it there bills no third',
      bill(w, ticks(2)).major.blue === 2, String(w.match.fouls.blue.major));

    // 6, for a SINGLE tick: not sustained, so no MAJOR — "a referee could not see it".
    const w2 = bare([{ id: 0, alliance: 'blue' }]);
    w2.match.phase = 'teleop';
    w2.match.phaseTimeLeft = 90;
    w2.robots[0].hopper = Array(6).fill('yellow');
    const one = bill(w2, 1);
    check('G407 STRATEGIC: 6 for a single tick never MAJORS', one.major.blue === 0, String(one.major.blue));
  }

  {
    // a PASSIVE robot is counted (its clocks still drain) but never sanctioned.
    const w = bare([{ id: 0, alliance: 'red' }]);
    w.match.phase = 'teleop';
    w.match.phaseTimeLeft = 90;
    w.robots[0].passive = true;
    w.robots[0].hopper = Array(6).fill('yellow');
    const out = bill(w, ticks(BB_MOMENTARY_S + 1));
    check('G407 STRATEGIC: a passive robot draws no MAJOR', out.major.red === 0 && out.pts.blue === 0,
      `major=${out.major.red} pts=${out.pts.blue}`);
  }

  {
    // the two robots of ONE alliance bill INDEPENDENTLY — the clocks are per ROBOT.
    const w = bare([
      { id: 0, alliance: 'red' },
      { id: 1, alliance: 'red' },
    ]);
    w.match.phase = 'teleop';
    w.match.phaseTimeLeft = 90;
    w.robots[0].hopper = Array(6).fill('yellow');
    w.robots[1].hopper = [];
    bill(w, ticks(BB_MOMENTARY_S + 0.5));
    check('G407 STRATEGIC: robot 0 MAJORS on its own 6+ streak', w.match.fouls.red.major === 1,
      String(w.match.fouls.red.major));
    w.robots[1].hopper = Array(6).fill('yellow');
    bill(w, ticks(BB_MOMENTARY_S + 0.5));
    check('G407 STRATEGIC: robot 1 MAJORS independently of robot 0’s streak',
      w.match.fouls.red.major === 2, String(w.match.fouls.red.major));
  }

  // ── G407: a HERDED pile — the half the hopper count could never see ───────
  /**
   * `alpha` `ea2cba4` exported `controlledArtifacts`, so `bbControlled` is now the shared
   * CONTROL test and G407 finally counts what the glossary counts: an EMPTY-hoppered robot
   * shoving five loose elements across the floor is controlling five of them.
   *
   * ── THIS FIXTURE IS KINEMATIC, AND THAT IS THE LANE’S OWN RULE ────────────
   * The pile is ADVANCED BY HAND rather than driven through `biobuzzStep`, for the reason at
   * the top of this file: a rules check must fail when the RULE is wrong, not when the pollen
   * solver bounced a ball half an inch differently. What is asserted is the COUNT and its edge,
   * and the count’s inputs are poses and velocities — so those are set directly and the robot
   * and its pile travel together at a herding speed, which is what a bulldozed clump does. The
   * physics lane is where a robot is actually driven into a pile.
   *
   * `autoIntake` is turned OFF on purpose. It defaults ON, and with it on the shared function’s
   * intake-mouth carve-out excuses the element nearest the mouth for the second or so an
   * acquisition takes — real behaviour, and a timing dependence this check does not want in the
   * way of the number it is about. The carve-out gets its own check further down.
   */
  {
    const w = bare([{ id: 0, alliance: 'blue' }]);
    w.match.phase = 'teleop';
    w.match.phaseTimeLeft = 90;
    const r = w.robots[0];
    r.autoIntake = false;
    r.hopper = []; // EMPTY: every element in the count below is HERDED, none is carried
    const warnings = () => w.events.filter((e) => e.includes('G407')).length;

    /**
     * A row of `n` POLLEN pressed against the front bumper, spread across its width.
     *
     * y = 40 keeps the whole run clear of the HIVE frame bars (|y| ≤ `BB_FRAME_Y` = 19.4), so a
     * 30 in/s herd cannot also trip G417 and pollute the event list; x runs −40 → −10, clear of
     * every wall and of BOTH loading-zone rectangles — this field’s `BB_LZ` (which is what
     * carve-out C now reads, see `BB_CONTROL_GEOMETRY`) and DECODE’s, which it used to.
     */
    const stagePile = (n: number): Artifact[] => {
      w.balls = [];
      r.pos = { x: -40, y: 40 };
      r.heading = 0;
      r.vel = { x: 0, y: 0 };
      w.penalties.ballHold = {};
      w.penalties.ballAnchor = {};
      w.penalties.ballCarry = {};
      const bb = w.biobuzz;
      if (bb) bb.foulEdge = {};
      const e = footprintExtents(r.spec);
      // touching the front face by its own radius, and inside the flanks so the nearest feature
      // is the FACE rather than a convex corner — `contactPush` refuses a corner outright.
      const span = (n - 1) * 3;
      const pile: Artifact[] = [];
      for (let i = 0; i < n; i++) {
        const b = el(
          'yellow',
          { kind: 'ground' },
          r.pos.x + e.front + BB_POLLEN_R,
          r.pos.y - span / 2 + i * 3,
        );
        w.balls.push(b);
        pile.push(b);
      }
      return pile;
    };

    /** herd for `s` seconds: robot and pile travel +x together at `v`, billed every tick. */
    const herd = (pile: Artifact[], s: number, v: number): void => {
      r.vel = { x: v, y: 0 };
      for (const b of pile) b.vel = { x: v, y: 0 };
      for (let i = 0; i < ticks(s); i++) {
        r.pos = { x: r.pos.x + v * SIM_DT, y: r.pos.y };
        for (const b of pile) b.pos = { x: b.pos.x + v * SIM_DT, y: b.pos.y };
        updateBiobuzzPenalties(w, SIM_DT, NO_CMD);
      }
    };

    // FIVE, herded. The confirm window (0.45 s) only opens once the carry distance (5 in) has
    // been covered, so a second of shoving is comfortably past both gates.
    const five = stagePile(5);
    herd(five, 1, 30);
    check('G407: a HERDED pile of five warns — and the hopper is EMPTY', warnings() === 1, String(warnings()));
    check('G407: ...and the line names the COUNT, which is now hopper + herded',
      w.events.some((e) => e === 'WARNING - BLUE (G407 CONTROL of 5+ elements)'),
      w.events.filter((e) => e.includes('G407')).join(' | '));
    check('G407: ...ONCE for one continuous shove, not once per tick', warnings() === 1, String(warnings()));
    check('G407: ...and it is still only a WARNING — no points, no tally',
      w.match.scores.red.foulPoints === 0 && w.match.fouls.blue.major === 0 && w.match.fouls.blue.minor === 0);

    // FOUR, herded exactly the same way: the legal number, and silence.
    const four4 = warnings();
    const four = stagePile(4);
    herd(four, 1, 30);
    check('G407: FOUR herded is the legal number and warns nothing', warnings() === four4, String(warnings() - four4));

    // FIVE, but STANDING STILL. The detector is HERDING, not proximity — a robot parked against
    // a pile controls none of it, which is the whole reason the shared test was worth importing
    // instead of hand-rolling a "touching and moving" stand-in.
    const still = stagePile(5);
    herd(still, 1, 0);
    check('G407: five the robot is merely PARKED against warn nothing — CONTROL is not contact',
      warnings() === four4, String(warnings() - four4));

    // ...and a SECOND shove after letting go is a SECOND instance (§10.6, per instance).
    const again = stagePile(5);
    herd(again, 1, 30);
    check('G407: herding five AGAIN after letting go warns again', warnings() === four4 + 1, String(warnings() - four4));

    /**
     * THE INTAKE-MOUTH CARVE-OUT, which is on for every default robot: the element the rollers
     * already own is not a fifth element. With `autoIntake` back on the same five-pile counts
     * four while the exemption holds, so the same shove is silent for as long as an acquisition
     * plausibly takes — and then it is not, because past that window an element has had every
     * chance to be taken and whatever is happening to it, it is being pushed along.
     */
    const mouthed = warnings();
    const mouth = stagePile(5);
    r.autoIntake = true;
    herd(mouth, 0.7, 30);
    check('G407: with the intake running, the element in the MOUTH is not a fifth element',
      warnings() === mouthed, String(warnings() - mouthed));
    herd(mouth, 1.5, 30);
    check('G407: ...and the exemption AGES OUT, so a long shove warns anyway',
      warnings() === mouthed + 1, String(warnings() - mouthed));
    r.autoIntake = false;

    /**
     * THE CLOCK SWEEP (`bbSweepControlClocks`), which is half of the import rather than borrowed
     * housekeeping. BIOBUZZ never runs a line of DECODE’s `updatePenalties`, so the
     * per-(robot, element) clocks `controlledArtifacts` keeps would be swept by nothing: they
     * are plain JSON inside `world.penalties` and would ride every 30 Hz snapshot and every
     * stored replay for the rest of the match, and a recycled element id would rebind to a
     * PRE-LATCHED clock — the one thing standing between herding and bulldozing.
     */
    const swept = stagePile(5);
    herd(swept, 1, 30);
    check('SWEEP: a herd leaves per-element clocks behind', Object.keys(w.penalties.ballHold).length > 0,
      String(Object.keys(w.penalties.ballHold).length));
    for (const b of swept) b.state = { kind: 'held', robot: r.id, slot: 0 };
    updateBiobuzzPenalties(w, SIM_DT, NO_CMD);
    check('SWEEP: ...and intaking them clears every one, so the maps cannot grow all match',
      Object.keys(w.penalties.ballHold).length === 0 &&
        Object.keys(w.penalties.ballAnchor).length === 0 &&
        Object.keys(w.penalties.ballCarry ?? {}).length === 0,
      `${Object.keys(w.penalties.ballHold).length}/${Object.keys(w.penalties.ballAnchor).length}`);
  }

  // ── G407: CARVE-OUT C is THIS field's LOADING ZONE, not DECODE's ──────────
  /**
   * The shared CONTROL test carries three pieces of geometry that used to be DECODE's by
   * default, and this is the one a BIOBUZZ driver meets every restock cycle: carve-out C,
   * "inadvertent contact with a SCORING ELEMENT while attempting to acquire a SCORING ELEMENT
   * FROM THE LOADING ZONE". `controlledArtifacts` read `loadZone(a)` — DECODE's 23 x 23
   * audience corner — so on this field the exemption was granted in a corner where BIOBUZZ has
   * open tiles and withheld in the 11 x 24 strip where its own human player actually hands
   * elements in. `BB_CONTROL_GEOMETRY.carveOut` supplies `BB_LZ` instead.
   *
   * ── WHY THE SCENE IS 2 CARRIED + 3 HERDED AND NOT 5 HERDED ────────────────
   * `BB_LZ.blue` is ELEVEN inches wide. A row of five POLLEN spread across a 17 in bumper is
   * twelve, so five abreast cannot be inside the zone at all and a check that staged them
   * there would be asserting something the field cannot hold. Two in the hopper are clause A
   * (fully supported), which no carve-out touches, so the count is still five and the only
   * thing the zone can change is the three on the bumper.
   *
   * `autoIntake` stays OFF. The mouth exemption would excuse one more and has its own checks
   * above; what is under test here is the ZONE and nothing else.
   *
   * ── AND THE OPEN-FLOOR TWIN IS THE NON-VACUITY PROOF, KEPT ────────────────
   * Both scenes are the same five elements herded the same way for the same time. The only
   * difference is where on the field it happens, so a carve-out that reads the wrong rectangle
   * cannot pass both. The BLUE scene also sits clear of DECODE's blue LOADING ZONE
   * (`loadZone('blue')`, the y <= -49 corner), asserted below — with the old geometry every
   * element here is outside the excusing rectangle and the zone scene warns.
   */
  {
    const w = bare([{ id: 0, alliance: 'blue' }]);
    w.match.phase = 'teleop';
    w.match.phaseTimeLeft = 90;
    const r = w.robots[0];
    r.autoIntake = false;
    const warnings = () => w.events.filter((e) => e.includes('G407')).length;

    /**
     * TWO IN THE HOPPER, THREE ON THE FRONT BUMPER, nose pointing +y.
     *
     * The row is laid from the robot's centre TOWARD +x at one diameter's pitch rather than
     * centred on it, because the zone hugs the +x wall: a 17 in bumper centred inside an 11 in
     * strip overhangs it on both sides, and an element off the near end would sit outside the
     * rectangle, escape the carve-out, and re-enter through the transitive chain. Every element
     * still meets the FRONT FACE (the face spans the full width and the row is inset from both
     * corners), which `contactPush` requires — it refuses a convex corner outright.
     */
    const restock = (cx: number, cy: number): Artifact[] => {
      w.balls = [];
      w.events.length = 0;
      r.pos = { x: cx, y: cy };
      r.heading = Math.PI / 2;
      r.vel = { x: 0, y: 0 };
      r.hopper = ['yellow', 'yellow'];
      w.penalties.ballHold = {};
      w.penalties.ballAnchor = {};
      w.penalties.ballCarry = {};
      const bb = w.biobuzz;
      if (bb) bb.foulEdge = {};
      const e = footprintExtents(r.spec);
      const pile: Artifact[] = [];
      for (let i = 0; i < 3; i++) {
        const b = el('yellow', { kind: 'ground' }, cx + i * BB_POLLEN_R * 2, cy + e.front + BB_POLLEN_R);
        w.balls.push(b);
        pile.push(b);
      }
      return pile;
    };

    /** the `herd` above, turned 90 degrees: robot and row travel +y together at `v`. */
    const herdY = (pile: Artifact[], s: number, v: number): void => {
      r.vel = { x: 0, y: v };
      for (const b of pile) b.vel = { x: 0, y: v };
      for (let i = 0; i < ticks(s); i++) {
        r.pos = { x: r.pos.x, y: r.pos.y + v * SIM_DT };
        for (const b of pile) b.pos = { x: b.pos.x, y: b.pos.y + v * SIM_DT };
        updateBiobuzzPenalties(w, SIM_DT, NO_CMD);
      }
    };

    /**
     * 23 in/s for 0.7 s is 16.1 in of travel — over `POSSESSION_HERD_SPEED` (22), past
     * `POSSESSION_CARRY_DIST` (5 in) in the first fifth of a second and then `POSSESSION_CONFIRM`
     * (0.45 s) with room to spare. It is deliberately the SLOWEST shove that still qualifies,
     * because the zone is only 24 in deep in y and the row has to still be inside it when the
     * count lands.
     */
    const HERD_S = 0.7;
    const HERD_V = 23;

    // OPEN FLOOR: clear of both LOADING ZONES, both GARDENS and the HIVE frame bars.
    const open = restock(-50, 20);
    herdY(open, HERD_S, HERD_V);
    check('G407: two carried and three herded is five, and in open floor that warns',
      warnings() === 1, String(warnings()));

    // ...and the SAME five, the same shove, inside blue's own LOADING ZONE.
    const zone = restock(63.5, -53.9);
    herdY(zone, HERD_S, HERD_V);
    check('G407: collecting the restock inside the own LOADING ZONE is not herding',
      warnings() === 0, String(warnings()));

    // the fixture is only worth anything if it really is in the zone at the end of the shove
    const lz = BB_LZ.blue;
    const inLz = (b: Artifact): boolean =>
      b.pos.x >= lz.x0 && b.pos.x <= lz.x1 && b.pos.y >= lz.y0 && b.pos.y <= lz.y1;
    check('G407: ...and every element of it was inside BB_LZ.blue when the shove ended',
      zone.every(inLz), zone.map((b) => `${b.pos.x.toFixed(1)},${b.pos.y.toFixed(1)}`).join(' '));
    check('G407: ...while the ROBOT overlapped the zone too, which carve-out C also requires',
      robotIntersectsRect(r, { x0: lz.x0, x1: lz.x1, y0: lz.y0, y1: lz.y1 }));

    // ...and NONE of it was inside DECODE's blue LOADING ZONE, which is what the shared test
    // read before `BB_CONTROL_GEOMETRY`. So the silence above is this field's rectangle.
    const dz = loadZone('blue');
    check('G407: ...and none of it is inside DECODE’s blue LOADING ZONE, so the pass is BB_LZ’s',
      zone.every((b) => !(b.pos.x >= dz.x0 && b.pos.x <= dz.x1 && b.pos.y >= dz.y0 && b.pos.y <= dz.y1)),
      zone.map((b) => `${b.pos.x.toFixed(1)},${b.pos.y.toFixed(1)}`).join(' '));
  }

  // G417 (ramming the HIVE frame) is REMOVED entirely — see `hiveRamRemovedChecks` above, which
  // drives a real chassis into the real frame under both physics and proves nothing bills.

  // ── the edge memory is CLEARED outside the played periods ─────────────────
  {
    const w = bare([]);
    const bb = w.biobuzz;
    if (!bb) return;
    w.match.phase = 'teleop';
    w.match.phaseTimeLeft = BB_FLOWER_UNLOCK_S + 1;
    intoFlower(w, 0, ['red']);
    bill(w, 3);
    check('EDGE: a live condition is remembered', Object.keys(bb.foulEdge).length > 0);
    w.match.phase = 'post';
    bill(w, 1);
    check('EDGE: the memory is cleared outside the played periods', Object.keys(bb.foulEdge).length === 0);
    // …so the same condition bills again when play resumes, which is the point
    w.match.phase = 'teleop';
    const resumed = bill(w, 3);
    check('EDGE: the first instance after a restart is billed', resumed.major.red === 2, String(resumed.major.red));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// G421 — PINNING, WHICH IS BILLED IN SECONDS AND NOT ON AN EDGE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ EVERY POSE BELOW IS MEASURED ON THE FOOTPRINT, 21 × 17, NOT THE 15 × 17 CHASSIS.
 * `robotExtents` adds a sweeper's reach to each end, so at heading 0 a robot reaches 10.5 in
 * along x and two of them are in contact whenever their centres are within ~21 in. Poses
 * written against the chassis put the robots a clear four inches apart and the rule simply
 * never fires — which reads exactly like a broken detector.
 *
 * ⚠️ WHICH IS WHY `PIN_BUILD` IS STATED AND NOT INHERITED. 21 × 17 is a FRONT+BACK sweeper
 * build — it was the default preset's own footprint until 2026-09-22, when the default became
 * a front-only sweeper (the Pollinator) and every pose here quietly started describing a robot
 * 3 in shorter at one end, asymmetric about its own centre. Nothing failed loudly: the pairs
 * simply stopped touching and eighteen checks read as "the detector bills nothing".
 *
 * The pin fixture is deliberately NOT a driven match. `isPinning` asks who is PRESSING and
 * the accumulator measures how far the victim actually got, so a hand-built world with static
 * poses is the only way to hold "pressed, going nowhere" for an exact number of seconds. What
 * a real chassis does when shoved is the physics lane's question, not this one's.
 */
function pinChecks(check: Check): void {
  /** the build every pose in this lane is measured against — see the header. */
  const PIN_BUILD: Partial<RobotSpec> = { intakeMount: 'frontback' };

  /**
   * ONE PINNER, ONE IDLE VICTIM, HELD AGAINST THE HIVE FRAME.
   *
   * The +x frame bar's inner edge is on the x = +24 seam, so a victim flat against it sits at
   * x = 24 − 10.5 = 13.5. The pinner is 20.5 in away — overlapping by half an inch, the way
   * two robots in a shove actually are — and driving into it.
   *
   * ⚠️ THE VICTIM GIVES NO COMMAND, AND UNDER G421 THAT IS THE LITERAL RULE — not a lenient
   * reading of it. DECODE's G422 ends "...and the opponent ROBOT is attempting to move";
   * **G421 does not contain that clause** (manual-distilled §3.3, verbatim p114, and §10
   * item 13). The test is "preventing the movement of an opponent ROBOT by contact" and
   * nothing more, so a BIOBUZZ robot is PINNED whether or not it struggles.
   *
   * `isPinning`'s idle-victim branch — which its own comment marks ⚠️ as a DEVIATION, because
   * under DECODE it is — is therefore exactly right here. A detector with a struggle test
   * would bill nothing in this fixture and would under-call every real BIOBUZZ pin, which is
   * the failure this check exists for. Do not add one.
   */
  const frame = (): World => {
    const w = bare([
      { id: 0, alliance: 'red' },
      { id: 1, alliance: 'blue' },
    ], PIN_BUILD);
    w.match.phase = 'teleop';
    w.match.phaseTimeLeft = 90;
    place(w, 1, 24 - 10.5, 0); // blue, flat against the +x HIVE frame bar
    place(w, 0, 24 - 10.5 - 20.5, 0); // red, pressing into it
    return w;
  };
  const press = new Map<number, RobotCommand>([[0, driveX(1)]]);

  /**
   * THE PIN TEST READS *THIS* FIELD'S SOLIDS, AND THAT CHANGES THE VERDICT.
   *
   * `isPinning` throws out a pin whose AGGRESSOR is itself backed against something solid — a
   * robot with a wall behind it and an opponent in front is the one being HELD, and pressing
   * forward is its only way out. That test probes a point behind the aggressor, and left to
   * its default it probes DECODE's field: the perimeter, the two GOAL WEDGES and the two
   * CLASSIFIER CHANNELS.
   *
   * BIOBUZZ has OPEN FLOOR in both of those corners. So an aggressor standing where DECODE
   * keeps a goal reads as cornered, reads as escaping, and the pin it is holding bills
   * NOTHING — on a quarter of this field, silently.
   *
   * (62, 62) is the witness: inside DECODE's red goal wedge, empty tiles on this field. The
   * scene backs the aggressor up so its rear probe lands exactly there, and the check is that
   * a MAJOR is billed anyway. With the solids left at DECODE's, this is 0.
   *
   * The victim is IDLE on purpose — the aggressor-cornered test runs BEFORE the victim is ever
   * asked anything, so an idle victim isolates it.
   */
  {
    const WITNESS = { x: 62, y: 62 };
    check(
      'G421: the DECODE goal wedge that would cancel this pin is OPEN FLOOR on the BIOBUZZ field',
      bbPinSolid(WITNESS) === false,
      'if this is true the scene below proves nothing',
    );
    const w = bare([
      { id: 0, alliance: 'red' },
      { id: 1, alliance: 'blue' },
    ], PIN_BUILD);
    w.match.phase = 'teleop';
    w.match.phaseTimeLeft = 90;
    // rear probe = centre + footprint reach (10.5) + PIN_WALL_SLOP, straight away from the victim
    const aggX = WITNESS.x - 10.5 - PIN_WALL_SLOP;
    place(w, 0, aggX, WITNESS.y); // red, its BACK where DECODE keeps a goal
    place(w, 1, aggX - 20.5, WITNESS.y); // blue, idle, held in front of it
    const out = bill(w, ticks(3.3), new Map<number, RobotCommand>([[0, driveX(-1)]]));
    check(
      'G421: an aggressor standing where DECODE keeps a GOAL is not "cornered" here — the pin bills',
      out.major.red === 1,
      `${out.major.red} MAJORs (0 means the pin test is reading DECODE's field)`,
    );
  }

  {
    const w = frame();
    const under = bill(w, ticks(2.9), press);
    check('G421: under three seconds of PINNING bills nothing', under.major.red === 0, String(under.major.red));

    const first = bill(w, ticks(0.4), press); // 3.3 s
    check('G421: an IDLE victim held against the frame bills — G421 has no struggle test',
      first.major.red === 1, String(first.major.red));
    check("G421: it is a MAJOR, not DECODE's MINOR", first.minor.red === 0, String(first.minor.red));
    check(`G421: the points go to the VICTIM's alliance, +${BB_PTS.foulMajor}`,
      first.pts.blue === BB_PTS.foulMajor, String(first.pts.blue));
    check('G421: the victim is billed nothing', first.major.blue === 0 && first.pts.red === 0);

    // "...and an additional MAJOR FOUL for every 3 seconds in which the situation is not
    // corrected" (manual-distilled §3.1, Table 10-4)
    const second = bill(w, ticks(3.0), press); // 6.3 s
    check('G421: another MAJOR for every further 3 s', second.major.red === 2, String(second.major.red));
    check('G421: two majors are 40 to blue', second.pts.blue === 2 * BB_PTS.foulMajor, String(second.pts.blue));
  }

  /**
   * TABLE 10-6's OWN WORKED EXAMPLE, WHICH IS THE ONLY ARITHMETIC CHECK THAT PROVES THE LOOP.
   *
   * "Upon violation, a MAJOR FOUL is assessed against the violating ALLIANCE and the REFEREE
   * begins to count ... for each 3 seconds within that time, an additional MAJOR FOUL is
   * assessed. A ROBOT in violation of this type of rule for 15 seconds is assessed a total of
   * 6 MAJOR FOULS" (p95, manual-distilled §3.2).
   *
   * The violation OPENS at 3 s of pinning — "may not PIN for more than 3 seconds" — so 15 s of
   * being IN VIOLATION is 18 s of pinning: one MAJOR on entry plus one for each of the five
   * further intervals. **6 MAJOR = 120 points**, which is a fifth of a plausible match score
   * and worth an integer rather than a shrug. Written out longhand here because the numbers
   * are the manual's, not the implementation's: a loop that billed on entry AND at 3 s would
   * read 7 here, and one that waited for the interval to complete would read 5.
   */
  {
    const w = frame();
    const long = bill(w, ticks(18.1), press);
    check('G421: 18 s of pinning = 15 s in violation = 6 MAJOR (Table 10-6)',
      long.major.red === 6, String(long.major.red));
    check('G421: ...which is 120 points to the victim', long.pts.blue === 120, String(long.pts.blue));
    check('G421: and no CARD — G421 has no card escalation, only the running tariff',
      Object.keys(w.penalties.carded).length === 0);
  }

  /**
   * THE MUTUAL SHOVE — criterion C, and the reason a pin detector needs one.
   *
   * Two EQUAL chassis meeting head-on in open field. Both satisfy every clause of the rule
   * against the other — contact, pressing in, going nowhere — so both are "pinning", and a
   * stalemate that is nobody's fault must not bill BOTH alliances 20 points every three
   * seconds. "The PINNING ROBOT gets PINNED" ends it: the pair is thrown out entirely.
   *
   * Mid-field on purpose. `isPinning` breaks the symmetry of a shove with a SOLID at one
   * robot's back, and the middle of the field is where there is nothing to break it with.
   */
  {
    const w = bare([
      { id: 0, alliance: 'red' },
      { id: 1, alliance: 'blue' },
    ], PIN_BUILD);
    w.match.phase = 'teleop';
    w.match.phaseTimeLeft = 90;
    place(w, 0, -10, 0);
    place(w, 1, 10, 0);
    const both = new Map<number, RobotCommand>([
      [0, driveX(1)],
      [1, driveX(-1)],
    ]);
    const shove = bill(w, ticks(10), both);
    check('G421: an equal-chassis mutual shove mid-field bills NOTHING',
      shove.major.red === 0 && shove.major.blue === 0, `${shove.major.red}/${shove.major.blue}`);
    check('G421: and no points move either way', shove.pts.red === 0 && shove.pts.blue === 0);
    check('G421: a mutual hold keeps no accumulator at all',
      Object.keys(w.penalties.pins).length === 0, Object.keys(w.penalties.pins).join(','));
  }

  /**
   * THE COUNT PAUSES AND RESUMES — the clause the whole rule turns on.
   *
   * 2.5 s of pinning, then the pinner EASES OFF for 0.7 s, then 0.6 s more. The two pressing
   * stretches total 3.1 s, so the tariff lands exactly once. If a lapse RESET the count, the
   * 0.6 s stretch would bill nothing and a pinner could hold a victim all match for free by
   * blinking every three seconds. If a lapse ENDED the pin, the same thing.
   *
   * 0.7 s is well inside `PIN_END_S`, which is the point: A and B are distances held for MORE
   * THAN THREE SECONDS and nothing shorter than that ends anything.
   */
  {
    const w = frame();
    const held = bill(w, ticks(2.5), press);
    check('G421: 2.5 s of pinning is still under the tariff', held.major.red === 0, String(held.major.red));
    check('HUD: a pin that is counting reads as counting', biobuzzFieldHud(w).pins[0]?.counting === true);

    const off = bill(w, ticks(0.7)); // no command — the pinner stops pressing
    check('G421: easing off for 0.7 s bills nothing', off.major.red === 0, String(off.major.red));
    const paused = biobuzzFieldHud(w).pins;
    // (one check, not two: the next one asserts `paused.length === 1` AND the paused count, and
    // its detail already says 'no pin' when the length is wrong.)
    check('G421: and its count PAUSED rather than resetting — ~2.5 s, not 0',
      paused.length === 1 && Math.abs(paused[0].seconds - 2.5) < 0.05,
      paused.length === 1 ? paused[0].seconds.toFixed(3) : 'no pin');
    // the HUD line bug: a paused pin stays on the books, and a HUD that drew it froze its
    // countdown on screen for as long as the robots stayed within 2 ft of each other
    check('HUD: a PAUSED pin is not counting, so the PIN line goes away', paused[0]?.counting === false);

    const resumed = bill(w, ticks(0.6), press); // 2.5 + 0.6 = 3.1 s of actual pinning
    check('G421: the count RESUMES — 2.5 s + 0.6 s crosses the tariff', resumed.major.red === 1, String(resumed.major.red));
    check('HUD: and a resumed pin is counting again', biobuzzFieldHud(w).pins[0]?.counting === true);
  }

  /**
   * ...AND CRITERION A REALLY DOES END IT, which is what makes the pause above a pause rather
   * than a detector that never lets go. The victim is moved a clear 2 ft away and left there
   * for more than `PIN_END_S`; the accumulator is dropped, and a fresh press starts from zero.
   */
  {
    const w = frame();
    bill(w, ticks(2.5), press);
    place(w, 1, 24 - 10.5 + 30, 0); // 30 in away — past PIN_ESCAPE_DIST (24)
    const away = bill(w, ticks(3.5), press);
    check('G421: 2 ft of daylight for more than 3 s bills nothing', away.major.red === 0, String(away.major.red));
    check('G421: ...and ENDS the pin — the accumulator is gone',
      Object.keys(w.penalties.pins).length === 0, Object.keys(w.penalties.pins).join(','));
    place(w, 1, 24 - 10.5, 0); // back into the hold
    const restart = bill(w, ticks(2.5), press);
    check('G421: a pin that ENDED restarts from zero, not from 2.5 s', restart.major.red === 0, String(restart.major.red));
  }

  /**
   * CRITERION A IS A GAP BETWEEN THE ROBOTS, NOT A DISTANCE BETWEEN THEIR CENTRES.
   *
   * "The ROBOTS have separated by at least 2 ft. (~61 cm) from each other." It used to be read
   * centre-to-centre, and two 21-in footprints in contact are already ~21 in apart that way, so a
   * pinner that backed off a few inches and idled satisfied A and ENDED the pin three seconds
   * later — wiping a count the rule says only pauses. `bbFootprintGap` is the daylight between
   * the two collision footprints, sweepers included.
   */
  {
    const probe = bare([
      { id: 0, alliance: 'red' },
      { id: 1, alliance: 'blue' },
    ], PIN_BUILD);
    const ext = footprintExtents(probe.robots[0].spec);
    const span = { len: ext.front + ext.rear, half: ext.half }; // one footprint, along / across its heading
    const [A, B] = probe.robots;
    place(probe, 0, 0, 0);
    place(probe, 1, 30, 0);
    check('G421.A gap: two footprints 30 in apart centre-to-centre are 30 − length apart',
      Math.abs(bbFootprintGap(A, B) - (30 - span.len)) < 1e-9, bbFootprintGap(A, B).toFixed(4));
    place(probe, 1, 15, 3);
    check('G421.A gap: overlapping footprints are 0 apart', bbFootprintGap(A, B) === 0);
    place(probe, 0, 0, 0, 90);
    place(probe, 1, 30, 0, 90);
    check('G421.A gap: rotated 90°, the WIDTH faces each other — 30 − width',
      Math.abs(bbFootprintGap(A, B) - (30 - 2 * span.half)) < 1e-9, bbFootprintGap(A, B).toFixed(4));
    place(probe, 0, 0, 0);
    place(probe, 1, span.len + 3, 2 * span.half + 4);
    check('G421.A gap: corner to corner is the diagonal daylight (a 3-4-5 offset reads 5)',
      Math.abs(bbFootprintGap(A, B) - 5) < 1e-9, bbFootprintGap(A, B).toFixed(4));
    check('G421.A gap: symmetric in its arguments', Math.abs(bbFootprintGap(A, B) - bbFootprintGap(B, A)) < 1e-12);
  }
  {
    // CENTRES ≥ 24 APART, FOOTPRINTS < 24 APART: A is NOT satisfied, so the pin survives the idle
    const w = frame();
    bill(w, ticks(2.5), press);
    const victimX = 24 - 10.5;
    const pinnerX = victimX - 30; // centres 30 in apart; footprint gap 9 in; pinner moved 9.5 (B not met)
    place(w, 0, pinnerX, 0);
    const [pinner, victim] = w.robots;
    check('G421.A: fixture — centres ≥ 24 in apart but footprints < 24 in apart',
      Math.abs(victim.pos.x - pinner.pos.x) >= 24 && bbFootprintGap(pinner, victim) < 24,
      `${(victim.pos.x - pinner.pos.x).toFixed(2)} / ${bbFootprintGap(pinner, victim).toFixed(2)}`);
    bill(w, ticks(3.5));
    const st = w.penalties.pins['0-1'];
    check('G421.A: a 24-in CENTRE distance with a <24-in gap does not satisfy A (sepFor stays 0)',
      !!st && st.sepFor === 0, st ? st.sepFor.toFixed(3) : 'pin ended');
    check('G421.A: ...so 3.5 s idling there does NOT end the pin, and its 2.5 s are still on it',
      !!st && Math.abs(st.seconds - 2.5) < 0.05, st ? st.seconds.toFixed(3) : 'pin ended');
    place(w, 0, victimX - 20.5, 0); // back into the hold
    const resumed = bill(w, ticks(0.6), press);
    check('G421.A: coming back in resumes the count — 2.5 + 0.6 s bills', resumed.major.red === 1, String(resumed.major.red));
  }
  {
    // FOOTPRINTS ≥ 24 APART, EACH ROBOT < 24 FROM WHERE THE PIN BEGAN: A alone ends it
    const w = frame();
    bill(w, ticks(2.5), press);
    place(w, 0, 24 - 10.5 - 20.5 - 23, 0); // pinner back 23 in (B not met)
    place(w, 1, 24 - 10.5 + 2, 0); // victim on 2 in (B not met)
    const [pinner, victim] = w.robots;
    check('G421.A: fixture — footprints ≥ 24 in apart',
      bbFootprintGap(pinner, victim) >= 24, bbFootprintGap(pinner, victim).toFixed(2));
    bill(w, ticks(1.0));
    const st = w.penalties.pins['0-1'];
    check('G421.A: a ≥ 24-in footprint gap satisfies A — sepFor accumulates',
      !!st && st.sepFor > 0.9, st ? st.sepFor.toFixed(3) : 'pin ended early');
    bill(w, ticks(2.5));
    check('G421.A: ...and held for more than 3 s it ENDS the pin',
      Object.keys(w.penalties.pins).length === 0, Object.keys(w.penalties.pins).join(','));
  }

  /**
   * THE PIN CLOCKS ARE FORGOTTEN OUTSIDE THE PLAYED PERIODS, the same way `foulEdge` is.
   *
   * Robots are DISABLED through the transition, so a pin that was live at the AUTO buzzer is
   * not being held across the freeze — and carrying 2.9 s of it into TELEOP would bill a MAJOR
   * on the first tick of a period in which nothing had happened yet. DECODE's own engine does
   * NOT clear these; this one does, and this check is what says so out loud.
   */
  {
    const w = frame();
    bill(w, ticks(2.5), press);
    check('G421: a live pin is on the books during TELEOP', Object.keys(w.penalties.pins).length === 1);
    w.match.phase = 'transition';
    bill(w, 1, press);
    check('G421: the pin clocks are cleared outside the played periods',
      Object.keys(w.penalties.pins).length === 0, Object.keys(w.penalties.pins).join(','));
    w.match.phase = 'teleop';
    const resumed = bill(w, ticks(2.5), press);
    check('G421: so the same hold starts over when play resumes', resumed.major.red === 0, String(resumed.major.red));
  }

  /** the HUD slice — `nextIn` is the only warning either driver gets. */
  {
    const w = frame();
    check('HUD: no pins on a quiet field', biobuzzFieldHud(w).pins.length === 0);
    bill(w, ticks(1.0), press);
    const [pin] = biobuzzFieldHud(w).pins;
    check('HUD: a live PIN names the pinner and the victim', !!pin && pin.pinner === 0 && pin.pinned === 1,
      pin ? `${pin.pinner}→${pin.pinned}` : 'none');
    check('HUD: nextIn counts down to the MAJOR — ~2 s left after 1 s of pinning',
      !!pin && Math.abs(pin.nextIn - 2) < 0.05, pin ? pin.nextIn.toFixed(3) : 'none');
    check('HUD: nothing billed yet', !!pin && pin.billed === 0);
    bill(w, ticks(2.5), press); // 3.5 s total
    const [after] = biobuzzFieldHud(w).pins;
    check('HUD: after the tariff lands, billed is 1 and nextIn restarts',
      !!after && after.billed === 1 && after.nextIn > 2.4 && after.nextIn <= 3,
      after ? `${after.billed}/${after.nextIn.toFixed(3)}` : 'none');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE 1:00 CUE, AND THE ASSESSMENT INSTANTS
// ─────────────────────────────────────────────────────────────────────────────

function cueChecks(check: Check): void {
  /**
   * THE CUE FIRES ON EXACTLY ONE TICK, AND IT IS THE ONE THE CLOCK CROSSES.
   *
   * The clock starts HALF A TICK above the threshold plus 59 whole ticks, so the countdown
   * passes 60.0 in the MIDDLE of the sixtieth tick — `before > 60` and `after <= 60` bracket
   * it — and `--tick 59` (0-based) is the step that emits. Checking the tick and not just "it
   * happened eventually" is what catches a cue wired to the wrong comparison: `>=` instead of
   * `>` fires it a tick early, and a one-tick error in a rule that costs 20 points is worth a
   * check.
   *
   * ⚠️ THE HALF TICK IS LOAD-BEARING. `phaseTimeLeft` is ACCUMULATED (`-= dt` every tick), so
   * sixty subtractions of 1/60 from 61.0 do not land on 60.0 — they land a few ulps above it,
   * `after <= 60` is false, and the cue slips to the next tick. Starting at 61.0 read as a cue
   * wired to the wrong comparison when it was only float residue. Same lesson as DECODE's
   * intake cadences: an interval that lands on a tick boundary is a coin toss, so land between
   * two of them instead.
   */
  const w = createBiobuzzWorld('match', 99, [setup(0, 'blue')]);
  w.match.phase = 'teleop';
  w.match.phaseTimeLeft = BB_FLOWER_UNLOCK_S + 59.5 * SIM_DT;
  const cues = () => w.events.filter((e) => e === 'FLOWER OWNERSHIP UNLOCKED').length;
  const empty = new Map();
  for (let i = 0; i < 59; i++) biobuzzStep(w, SIM_DT, empty);
  check('CUE: nothing at tick 58 — the clock has not crossed 1:00', cues() === 0, `${w.match.phaseTimeLeft.toFixed(3)} s left`);
  biobuzzStep(w, SIM_DT, empty);
  check('CUE: FLOWER OWNERSHIP UNLOCKED on the crossing tick', cues() === 1, `${w.match.phaseTimeLeft.toFixed(3)} s left`);
  check('CUE: and the rule agrees with its own announcement', !bbNectarLocked(w));
  for (let i = 0; i < 300; i++) biobuzzStep(w, SIM_DT, empty);
  check('CUE: it fires ONCE, not once per tick', cues() === 1, String(cues()));

  // ── the two assessment instants ───────────────────────────────────────────
  {
    const m = createBiobuzzWorld('match', 7, [setup(0, 'red'), setup(1, 'blue')]);
    const bb = m.biobuzz;
    if (!bb) return;
    m.match.phase = 'auto';
    m.match.phaseTimeLeft = 2 * SIM_DT;
    // Robot 0 clear of the perimeter and in its own LOADING ZONE — it LEAVES and it PARKS.
    // Robot 1 is still flat against the far wall, so it does neither.
    //
    // ⚠️ BOTH POSES ARE MEASURED OFF THE FOOTPRINT, WHICH IS 21 × 17, NOT THE 15 × 17 CHASSIS:
    // `robotExtents` adds the sweeper's reach to each end, so robot 0's corner is 10.5 in from
    // its centre and a pose that looks clear by an inch is not.
    //
    // ⚠️ AND IT IS DERIVED FROM THE WALL, NOT TYPED. It used to be the literal x = −59, which
    // put that corner at −69.5 — a comfortable 2.5 in inside the old ±72 wall, and 1.17 in
    // inside the CAD wall at −70.674, i.e. WITHIN `START_TOUCH_TOL`. The robot therefore still
    // counted as against the wall it started on and never LEFT. `CLEAR_MARGIN` is the slack past
    // the tolerance; the pose still overlaps `BB_LZ.red` (whose inner edge is at −59.101) by
    // more than four inches, which is what PARK needs.
    const CLEAR_MARGIN = 2;
    place(m, 0, -BB_HALF_X + 10.5 + START_TOUCH_TOL + CLEAR_MARGIN, (BB_LZ.red.y0 + BB_LZ.red.y1) / 2);
    place(m, 1, BB_HALF_X - 10.5, 0);
    markStarts(m);
    const none = new Map();
    check('ASSESS: nothing is latched before the instant', Object.keys(bb.leave).length === 0);
    biobuzzStep(m, SIM_DT, none);
    biobuzzStep(m, SIM_DT, none); // AUTO ends on this tick
    check('ASSESS: AUTO ended', m.match.phase === 'transition', m.match.phase);
    check('ASSESS: LEAVE latched at the end of AUTO', bb.leave[0] === true && bb.leave[1] === false,
      `${bb.leave[0]}/${bb.leave[1]}`);
    check('ASSESS: AUTO PARK latched at the same instant', bb.parkAuto[0] === true && bb.parkAuto[1] === false);
    check('ASSESS: MATCH PARK is NOT latched yet', bb.parkTele[0] === undefined);

    // run to the end of the match
    m.match.phase = 'teleop';
    m.match.phaseTimeLeft = 2 * SIM_DT;
    place(m, 0, -42, 45); // robot 0 drives OUT of the zone before the buzzer
    biobuzzStep(m, SIM_DT, none);
    biobuzzStep(m, SIM_DT, none);
    check('ASSESS: the MATCH ended', m.match.phase === 'post', m.match.phase);
    check('ASSESS: MATCH PARK latched on where the robot ACTUALLY ended', bb.parkTele[0] === false,
      String(bb.parkTele[0]));
    check('ASSESS: the AUTO latch is untouched by the second assessment', bb.parkAuto[0] === true);
    check('ASSESS: `endgame` reports PARK, the one end-of-match state this game has',
      bb.endgame[0] === 'none', String(bb.endgame[0]));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SCENES THIS LANE OWNS
// ─────────────────────────────────────────────────────────────────────────────

function sceneChecks(check: Check): void {
  for (const id of ['hive-tip', 'park-examples', 'nectar-entry']) {
    check(`SCENE: \`${id}\` is registered`, bbScene(id) !== undefined);
  }

  // park-examples IS the Fig 10-7 table, rendered — so the cell and the rule are checked with
  // one assertion each rather than by eye.
  {
    const s = bbScene('park-examples');
    if (s) {
      const w = bbSceneAt(s, 0);
      const parked = w.robots.filter((r) => bbParkedNow(r)).map((r) => r.id);
      check('SCENE park-examples: robots 0, 1 and 3 park; robot 2 does not',
        parked.join(',') === '0,1,3', parked.join(','));
      // the scene sits in TELEOP, so the LIVE PARK predicate is what drives the COUNT — which
      // is what the picture illustrates. The POINTS wait for the end-of-match instant (§10.5 G),
      // so mid-match the line is a count of 2 worth 0, and `pendingPts` is the 10 it will pay.
      const score = bbScoreWorld(w);
      check('SCENE park-examples: two RED park, counted live in TELEOP and worth 0 until the buzzer',
        score.red.parkTeleCount === 2 &&
          score.red.parkTele === 0 &&
          score.red.pendingPts === 2 * BB_PTS.parkTele,
        `count=${score.red.parkTeleCount} pts=${score.red.parkTele} pending=${score.red.pendingPts}`);
      // ...and the 10 the label promises still lands, on the same world, once the instant has
      // passed. Robots 0 and 1 are the scene's RED pair, and both are in the parked list above.
      const bb = w.biobuzz;
      if (bb) {
        bb.parkTele[0] = true;
        bb.parkTele[1] = true;
        w.match.phase = 'post';
        check('SCENE park-examples: the two RED PARKs pay 5 each at the buzzer',
          bbScoreWorld(w).red.parkTele === 2 * BB_PTS.parkTele,
          String(bbScoreWorld(w).red.parkTele));
      }
    }
  }

  // nectar-entry starts one second before the cue, so stepping it crosses G410's boundary.
  {
    const s = bbScene('nectar-entry');
    if (s) {
      const before = bbSceneAt(s, 0);
      check('SCENE nectar-entry: NECTAR entry starts LOCKED', bbNectarLocked(before));
      const nectar = before.balls.filter((b) => b.color === 'red' || b.color === 'blue');
      check('SCENE nectar-entry: one NECTAR per alliance, at the LOADING ZONE spot',
        nectar.length === 2, String(nectar.length));
      for (const a of ['red', 'blue'] as Alliance[]) {
        const spot = bbLoadingZoneSpot(a, BB_NECTAR_R);
        const b = nectar.find((q) => q.color === a);
        check(`SCENE nectar-entry: the ${a} NECTAR enters at its OWN loading zone`,
          !!b && Math.abs(b.pos.x - spot.x) < 0.01 && Math.abs(b.pos.y - spot.y) < 0.01,
          b ? `(${b.pos.x.toFixed(2)}, ${b.pos.y.toFixed(2)})` : 'missing');
      }
      const after = bbSceneAt(s, 120);
      check('SCENE nectar-entry: the cue has fired by the second still',
        after.events.filter((e) => e === 'FLOWER OWNERSHIP UNLOCKED').length === 1 && !bbNectarLocked(after));
    }
  }

  // hive-tip is built against behaviour `play.ts` does not run yet — see the scene's header.
  {
    const s = bbScene('hive-tip');
    if (s) {
      const w = bbSceneAt(s, 0);
      const bb = w.biobuzz;
      const kindOf = bbKindIndex(w);
      const load = hiveLoad(bb?.hives.red.contents ?? [], kindOf);
      check('SCENE hive-tip: the cell holds the STAGED row, 3 NECTAR + 3 POLLEN',
        load.nectar === 3 && load.pollen === 3, `${load.pollen}p/${load.nectar}n`);
      check('SCENE hive-tip: that load tips (`BB_TIP_POLLEN[3]` is 3)', hiveWillTip(load));
      // FOUR stills since the spill was calibrated to the owner's landing lines: the throw is
      // still crossing the field at 4 s and only comes to rest at ~4.2 s, so 8 s is the frame
      // that shows the SCATTER (`docs/biobuzz/feedback/001-spill-kinematics.md`).
      check('SCENE hive-tip: its stills are 0 · 2 s · 4 s · 8 s', s.stills.join(',') === '0,120,240,480', s.stills.join(','));
    }
  }
}

/**
 * THE MATCH IS FINALIZED WHEN THE FIELD HAS SETTLED (`src/sim/settle.ts`), and BIOBUZZ decides
 * what "settled" means (`bbSettled`). §10.5 A assesses TIPS "until all SCORING ELEMENTS and
 * ROBOTS have come to rest", and §10.5 C what REMAINS in a CELL after that — so a swing, an
 * element in the air and one still rolling toward a GARDEN all hold the finalize open.
 */
function settleChecks(check: Check): void {
  const w = bbSettleWorld('match', 5);
  for (const b of w.balls) b.vel = { x: 0, y: 0 };
  const bb = w.biobuzz;
  check('SETTLE: a quiet BIOBUZZ field is settled', bbSettled(w));
  if (bb) {
    bb.hives.red.tipping = 1.5;
    check('SETTLE (§10.5 A): a HIVE still swinging is not settled — its TIP has not paid yet', !bbSettled(w));
    bb.hives.red.tipping = 0;
  }
  const g = w.balls.find((b) => b.state.kind === 'ground');
  check('SETTLE: the quiet field had a ground element to test with', !!g);
  if (g) {
    g.vel = { x: 25, y: 0 };
    check('SETTLE: a ROLLING element is not settled (a GARDEN counts where it stops)', !bbSettled(w));
    g.vel = { x: 0, y: 0 };
    const keep = g.state;
    g.state = { kind: 'flight', target: 'red', by: 'red' };
    g.vel = { x: 60, y: 0 };
    check('SETTLE: an element in FLIGHT is not settled (a CELL can still take it)', !bbSettled(w));
    g.vel = { x: 0, y: 0 };
    g.vz = -40;
    check('SETTLE: an element FALLING is not settled even with no ground speed', !bbSettled(w));
    g.vz = 0;
    g.state = keep;
  }
  w.robots[0].angVel = 1;
  check('SETTLE: a robot still turning is not settled', !bbSettled(w));
  w.robots[0].angVel = 0;

  // ── E1 (owner report 2026-09-18: "'Waiting for the field to settle' takes forever when
  //    nothing is moving"). Both halves of `bbSettled` used to answer a question that is not
  //    about motion, and under 3D physics both answered "still moving" forever. See the two
  //    warning blocks in `src/games/biobuzz/settle.ts` for the measured runs.
  {
    const f = bbSettleWorld('match', 5);
    for (const b of f.balls) {
      b.vel = { x: 0, y: 0 };
      b.vz = 0;
    }
    const shelf = f.balls.find((b) => b.state.kind === 'ground');
    if (shelf) {
      // `derive.ts` tags anything off the tiles and outside a cell/tube as `flight`, so an
      // element AT REST on the hive frame is permanently `flight`. It must not hold the clock.
      shelf.state = { kind: 'flight', target: 'red', by: 'red' };
      shelf.z = 43.9;
      check(
        'E1 SETTLE: an element at REST off the tiles (tagged `flight` by derive) is settled',
        bbSettled(f),
      );
      shelf.state = { kind: 'ground' };
      shelf.z = 0;
    }
    const bbf = f.biobuzz;
    if (bbf) {
      // THE DYNAMIC TRAY answers with its own angular speed, never with the timer's load table.
      const red = bbf.hives.red;
      const loaded = [...f.balls].slice(0, BB_TIP_POLLEN[0]).map((b) => b.id);
      bbf.hives.red = { ...red, contents: loaded, angle: 0.5236, angVel: 0 };
      check(
        'E1 SETTLE: a DYNAMIC tray resting on its stop is settled, whatever the load table says',
        bbSettled(f),
        `n=${loaded.length}`,
      );
      bbf.hives.red = { ...bbf.hives.red, angVel: 1 };
      check('E1 SETTLE: a DYNAMIC tray still swinging is not settled', !bbSettled(f));
      // ...and the TIMER tray (no `angle` — a 2D world, a 2D-era replay, a snapshot) still
      // waits for the swing the load table says is coming.
      bbf.hives.red = { up: red.up, contents: loaded, tips: red.tips, tipping: 0, released: false };
      check(
        'E1 SETTLE: a TIMER tray loaded past its threshold is still not settled (a swing is due)',
        !bbSettled(f),
      );
      bbf.hives.red = red;
    }
  }

  /* ── E2 (2026-09-19): THE MOTION TEST RUNS FOR EVERY TAG THAT HAS A POSITION ──
     The 3D half of this is the HIVE3D lane's (a ball bouncing in a CELL is tagged `element`
     since membership became geometry, and the old `flight`/`ground` gate skipped it). What is
     asserted HERE is that the 2D pipeline did not move: `park()` zeroes an element's `vel` and
     `vz` and nothing writes them again, so an `element` tag in 2D is always a dead stop and
     the widened test cannot change a 2D answer. Driven through the real pipeline with real
     bots rather than argued from `park()`'s source, because the claim is about every path that
     can produce the tag, not about one function. */
  {
    const f = bbSettleWorld('match', 5);
    const e = f.balls.find((b) => b.state.kind === 'element');
    check('E2 SETTLE: the 2D fixture had an `element`-tagged ball to test with', !!e);
    if (e) {
      e.vel = { x: 30, y: 0 };
      check(
        'E2 SETTLE: an element MOVING inside a CELL or a FLOWER is not settled (it was skipped)',
        !bbSettled(f),
        `${e.state.kind === 'element' ? e.state.el : e.state.kind} at 30 in/s`,
      );
      e.vel = { x: 0, y: 0 };
      e.vz = -30;
      check('E2 SETTLE: the same element FALLING is not settled either', !bbSettled(f));
      e.vz = 0;
      check('E2 SETTLE: and at rest it is settled again', bbSettled(f));
    }
  }
  {
    const w = createBiobuzzWorld(
      'match',
      31,
      [setup(0, 'blue', {}, 0), setup(1, 'red', {}, 1)],
      undefined,
      '2d',
    );
    w.match.preCountdown = undefined;
    w.match.phase = 'auto';
    w.match.phaseTimeLeft = 30;
    const seats = [0, 1].map((i) => BIOBUZZ_BOT.create(w, i, 'hard', 3100 + i));
    let worst = 0;
    let disagreements = 0;
    let sawElement = 0;
    const ticks = Math.round(45 / SIM_DT);
    for (let t = 0; t < ticks; t++) {
      const cmds = new Map<number, RobotCommand>();
      for (let i = 0; i < 2; i++) cmds.set(i, seats[i].step(w));
      biobuzzStep(w, SIM_DT, cmds);
      // the OLD ball loop (motion for `flight`/`ground` only) against the one that shipped.
      let oldQuiet = true;
      let newQuiet = true;
      for (const b of w.balls) {
        const moving =
          Math.hypot(b.vel.x, b.vel.y) >= BALL_REST_SPEED || Math.abs(b.vz) >= BALL_REST_SPEED;
        if (moving && (b.state.kind === 'flight' || b.state.kind === 'ground')) oldQuiet = false;
        if (moving && b.state.kind !== 'held' && b.state.kind !== 'stock') newQuiet = false;
        if (b.state.kind === 'element') {
          sawElement++;
          worst = Math.max(worst, Math.hypot(b.vel.x, b.vel.y), Math.abs(b.vz));
        }
      }
      if (oldQuiet !== newQuiet) disagreements++;
    }
    check(
      'E2 SETTLE (2D): the widened motion test answers what the old one did, on every tick of a driven match',
      disagreements === 0 && sawElement > 0,
      `${disagreements} disagreements over ${ticks} ticks, ${sawElement} \`element\` readings`,
    );
    check(
      'E2 SETTLE (2D): an `element`-tagged ball never carries velocity in the 2D pipeline',
      worst === 0,
      `worst |v| ${worst.toFixed(6)} (threshold ${BALL_REST_SPEED})`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// A COMPETITION'S MEASURES — `GameSimModule.rankFacts`, on paper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What BIOBUZZ reports for a competition's ranking points (`src/games/biobuzz/rankFacts.ts`).
 * AUTO is taken as TELEOP starts and counts only the TIPS completed by then (§10.5 B); SWARM and
 * TIPS are taken at the end and are the score's own numbers. The key set against the manual's
 * table is checked in `scripts/smoke.ts`, beside the other games'.
 */
function rankFactsChecks(check: Check): void {
  const facts = simModuleFor('biobuzz').rankFacts;
  check('RP FACTS: BIOBUZZ reports measures for a competition', !!facts);
  if (!facts) return;
  const w = bare([
    { id: 0, alliance: 'red' },
    { id: 1, alliance: 'red' },
    { id: 2, alliance: 'blue' },
  ]);
  const bb = w.biobuzz;
  if (!bb) return;
  place(w, 0, -40, 20);
  place(w, 1, -40, -20);
  place(w, 2, 40, 20);
  // the AUTO latches: both red robots LEFT, one PARKED; blue's one robot LEFT
  bb.leave[0] = true;
  bb.leave[1] = true;
  bb.parkAuto[0] = true;
  bb.parkAuto[1] = false;
  bb.leave[2] = true;
  bb.parkAuto[2] = false;
  // red has one TIP done and a second SWING still moving as TELEOP starts
  bb.hives.red.tips = 1;
  intoCell(w, 'red', ['yellow', 'yellow', 'yellow']);
  bb.hives.red.tipping = BB_TIP_SWING_S - 0.5;
  bb.hives.red.released = false;
  w.match.phase = 'teleop';
  const json = JSON.stringify(w);
  const t = facts(w, 'teleopStart');
  /**
   * RED, LONGHAND: LEAVE 2 × 3 = 6, AUTO PARK 1 × 5 = 5, TIPS 1 × 20 = 20 → 31. The swing still
   * moving completes in TELEOP and is not AUTO.
   */
  check(
    `RP FACTS: AUTO at TELEOP start = LEAVE + AUTO PARK + completed TIPS = 6 + 5 + 20, not the swing in progress`,
    t.red.auto === 2 * BB_PTS.leave + BB_PTS.parkAuto + BB_PTS.tip && t.blue.auto === BB_PTS.leave,
    JSON.stringify(t),
  );
  check('RP FACTS: only AUTO is read as TELEOP starts', Object.keys(t.red).join() === 'auto');
  check('RP FACTS: a pure read (the world is unchanged)', JSON.stringify(w) === json);
  const e = facts(w, 'autoEnd');
  check('RP FACTS: nothing is read as AUTO ends', Object.keys(e.red).length === 0 && Object.keys(e.blue).length === 0);

  // the end: robot 1 PARKED for the match; the swing caught by the buzzer is a TIP (§10.5 A)
  bb.parkTele[0] = false;
  bb.parkTele[1] = true;
  bb.parkTele[2] = false;
  w.match.phase = 'post';
  const f = facts(w, 'final');
  const s = bbScoreWorld(w);
  /** RED, LONGHAND: SWARM = LEAVE 6 + AUTO PARK 5 + TELEOP PARK 5 = 16; TIPS = 1 + the swing = 2. */
  check(
    'RP FACTS: SWARM at the end = LEAVE + AUTO PARK + TELEOP PARK = 6 + 5 + 5',
    f.red.swarm === 2 * BB_PTS.leave + BB_PTS.parkAuto + BB_PTS.parkTele && f.blue.swarm === BB_PTS.leave,
    JSON.stringify(f),
  );
  check(
    'RP FACTS: TIPS at the end are the score’s own count, the buzzer swing included',
    f.red.tips === 2 && f.red.tips === s.red.tips && f.blue.tips === s.blue.tips,
    `facts ${f.red.tips}, score ${s.red.tips}`,
  );
  check('RP FACTS: SWARM and TIPS only at the end', Object.keys(f.red).sort().join() === 'swarm,tips');
}

export function rulesChecks(check: Check): void {
  scoringChecks(check);
  penaltyChecks(check);
  g407DrivenChecks(check);
  pinChecks(check);
  cueChecks(check);
  sceneChecks(check);
  settleChecks(check);
  rankFactsChecks(check);
}
