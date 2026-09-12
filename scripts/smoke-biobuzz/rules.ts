import type { Alliance, Artifact, ArtifactColor, World } from '../../src/types';
import { SIM_DT } from '../../src/config';
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
import {
  bbApplyScore,
  bbInGarden,
  bbKindIndex,
  bbLeftNow,
  bbParkedNow,
  bbScoreWorld,
} from '../../src/games/biobuzz/score';
import { BB_FRAME_RAM_SPEED, bbNectarLocked, updateBiobuzzPenalties } from '../../src/games/biobuzz/penalties';
import { biobuzzFieldHud } from '../../src/games/biobuzz/hud';
import { bbScene, bbSceneAt } from '../../src/games/biobuzz/scenes';
import { setup, type Check } from './harness';

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
function bare(robots: { id: number; alliance: Alliance }[]): World {
  const world = createBiobuzzWorld(
    'match',
    1234,
    robots.map((r) => setup(r.id, r.alliance)),
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
    check('TIP: an EMPTY cell needs 8 POLLEN (APPROX row)', hiveWillTip(load(8, 0)) && !hiveWillTip(load(7, 0)));
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
    check('TABLE: blue scored nothing it did not earn (no LEAVE, no PARK)', s.blue.leave === 0 && s.blue.parkAuto === 0);
    check('TABLE: FLOWER owners are F1 red, F2 blue, F3/F4 unowned',
      s.flowerOwners.join(',') === 'red,blue,,',
      s.flowerOwners.join(','));

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

  // ── LEAVE and PARK are LIVE before their instant and LATCHED after it ──────
  {
    const w = bare([{ id: 0, alliance: 'red' }]);
    const bb = w.biobuzz;
    if (!bb) return;
    place(w, 0, -40, 0); // clear of the wall, clear of the zone
    w.match.phase = 'auto';
    check('ASSESS: LEAVE is provisional during AUTO', bbScoreWorld(w).red.leave === BB_PTS.leave);
    // the latch says otherwise, and after the instant the latch is what is read
    bb.leave[0] = false;
    w.match.phase = 'teleop';
    check('ASSESS: after the instant the LATCH is read, not the live pose', bbScoreWorld(w).red.leave === 0);
    bb.leave[0] = true;
    place(w, 0, -72 + 9, 0); // back at the wall — the achievement is kept
    check('ASSESS: a robot that returns to the wall KEEPS its LEAVE', bbScoreWorld(w).red.leave === BB_PTS.leave);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 11 — EVERY FOUL, ON ITS EDGE
// ─────────────────────────────────────────────────────────────────────────────

/** run the penalty engine for `n` ticks without moving anything, and report what it billed. */
function bill(world: World, n = 1): { major: Record<Alliance, number>; pts: Record<Alliance, number> } {
  for (let i = 0; i < n; i++) updateBiobuzzPenalties(world);
  return {
    major: { red: world.match.fouls.red.major, blue: world.match.fouls.blue.major },
    pts: { red: world.match.scores.red.foulPoints, blue: world.match.scores.blue.foulPoints },
  };
}

function penaltyChecks(check: Check): void {
  // ── the tariff itself — MAJOR is 20 here, not DECODE's 15 ─────────────────
  check(`TARIFF: MINOR ${BB_PTS.foulMinor} / MAJOR ${BB_PTS.foulMajor} (Table 10-4)`,
    BB_PTS.foulMinor === 5 && BB_PTS.foulMajor === 20);

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

  // ── G402: AUTO interference across the halves ─────────────────────────────
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

    // separate, then touch again
    place(w, 0, -20, 0);
    const apart = bill(w, 10);
    check('G402: separating bills nothing', apart.major.red === 1);
    place(w, 0, 20, 0);
    const again = bill(w, 10);
    check('G402: re-contacting fires again', again.major.red === 2, String(again.major.red));

    // A robot on its OWN side, in contact, is not a G402 — but the one that came to it is.
    // The footprint is 21 in long (a sweeper on each end), so FULLY crossed needs the centre
    // more than 10.5 in past the line; a robot straddling it is not across at all.
    place(w, 0, -34, 0);
    place(w, 1, -14, 0);
    const own = bill(w, 10);
    check('G402: contact on the CROSSER\'s own side is not a foul', own.major.red === 2, String(own.major.red));
    check('G402: but the BLUE robot that crossed IS billed', own.major.blue === 1, String(own.major.blue));

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
  }

  // ── G417: ramming the HIVE frame — VERBAL first, MAJOR if REPEATED ────────
  {
    const w = bare([{ id: 0, alliance: 'blue' }]);
    w.match.phase = 'teleop';
    w.match.phaseTimeLeft = 60;
    const r = w.robots[0];
    // against the +x frame bar (inner edge on the x = +24 seam), driving INTO it
    place(w, 0, 24 - 8, 0);
    r.vel = { x: -(BB_FRAME_RAM_SPEED + 10), y: 0 };
    const first = bill(w, 20);
    check('G417: the FIRST ram is a VERBAL — no points', first.major.blue === 0 && first.pts.red === 0);
    check('G417: the verbal is on the event feed',
      w.events.some((e) => e.includes('G417')),
      w.events.filter((e) => e.includes('G417')).join(' | '));

    // back off, then ram again
    r.vel = { x: 0, y: 0 };
    bill(w, 5);
    r.vel = { x: -(BB_FRAME_RAM_SPEED + 10), y: 0 };
    const second = bill(w, 20);
    check('G417: a REPEAT is a MAJOR', second.major.blue === 1, String(second.major.blue));
    check(`G417: red is +${BB_PTS.foulMajor}`, second.pts.red === BB_PTS.foulMajor, String(second.pts.red));

    // driving ALONG the structure at the same speed is not ramming
    const q = bare([{ id: 0, alliance: 'blue' }]);
    q.match.phase = 'teleop';
    q.match.phaseTimeLeft = 60;
    place(q, 0, 24 - 8, 0);
    q.robots[0].vel = { x: 0, y: BB_FRAME_RAM_SPEED + 40 };
    check('G417: driving ALONG a frame bar is not ramming', bill(q, 20).major.blue === 0);
    // and a gentle nudge is not either
    q.robots[0].vel = { x: -(BB_FRAME_RAM_SPEED - 10), y: 0 };
    check('G417: contact below the ram threshold is not a foul', bill(q, 20).major.blue === 0);
  }

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
    // `robotExtents` adds the sweeper's reach to each end. At x = −63 robot 0's corner is at
    // −73.5, i.e. THROUGH the wall, and a robot that is not inside the field has not left it.
    place(m, 0, -59, 45);
    place(m, 1, BB_HALF_X - 10.5, 0);
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
      const score = bbScoreWorld(w);
      check('SCENE park-examples: two RED park at 5 each, live in TELEOP',
        score.red.parkTele === 2 * BB_PTS.parkTele, String(score.red.parkTele));
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
      check('SCENE hive-tip: its stills are 0 · 2 s · 4 s', s.stills.join(',') === '0,120,240', s.stills.join(','));
    }
  }
}

export function rulesChecks(check: Check): void {
  scoringChecks(check);
  penaltyChecks(check);
  cueChecks(check);
  sceneChecks(check);
}
