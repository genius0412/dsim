import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Alliance, Artifact, ArtifactColor, RobotCommand, World } from '../../src/types';
import { SIM_DT } from '../../src/config';
import { createBiobuzzWorld } from '../../src/games/biobuzz/spawn';
import { biobuzzStep } from '../../src/games/biobuzz/step';
import {
  BB_FLOWER_UNLOCK_S,
  BB_FRAME_BAR_IN,
  BB_FRAME_BAR_OUT,
  BB_FRAME_Y,
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
import {
  BB_CONTROL_LIMIT,
  BB_FRAME_RAM_SPEED,
  bbAwardFoul,
  bbFootprintGap,
  bbNectarLocked,
  updateBiobuzzPenalties,
} from '../../src/games/biobuzz/penalties';
import { biobuzzFieldHud } from '../../src/games/biobuzz/hud';
import { bbScene, bbSceneAt } from '../../src/games/biobuzz/scenes';
import { footprintExtents } from '../../src/sim/field';
import { cmd, setup, type Check } from './harness';

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
  for (let i = 0; i < n; i++) updateBiobuzzPenalties(world, SIM_DT, held);
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
   * why G402's line carries U+2019. G407's line is a template literal (it interpolates
   * `BB_CONTROL_LIMIT`), so it cannot be grepped — it is pinned as a rendered event in the G407
   * block instead, and `foulLines` says so rather than quietly covering four of five.
   */
  {
    const src = readRepo('src/games/biobuzz/penalties.ts');
    const foulLines: [string, string][] = [
      ['G402 crossing into the opponent\u2019s half in AUTO', 'the ACT is CROSSING, not "AUTO interference"'],
      ['G410 NECTAR in a FLOWER before 1:00', 'the element, the place and the cue'],
      ['G417 STRATEGIC ramming of the HIVE frame', 'the act, and why it skipped the warning'],
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

  // ── G402: crossing into the opponent's half in AUTO — MAJOR *per MATCH* ───
  /**
   * The tariff is the interesting half. Table 10-4 reads "**MAJOR FOUL per MATCH.** MAJOR FOUL
   * and YELLOW CARD per MATCH, if STRATEGIC" (manual-distilled §3.3, p106), so a team pays 20
   * for AUTO interference ONCE however much of it there was — the same shape as G417, and the
   * reason this rule now carries G417's per-MATCH latch behind its edge trigger. It used to
   * bill per (crosser, victim) rising edge, so one crosser brushing both opponents paid 40.
   *
   * The EDGE is still checked underneath the latch, because the latch is per MATCH and the edge
   * is per tick: delete the edge and a two-second brush bills 120 before the latch is consulted
   * at all. Both are driven below.
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

    // separate, then touch again: a SECOND instance, and the manual charges for neither
    place(w, 0, -20, 0);
    const apart = bill(w, 10);
    check('G402: separating bills nothing', apart.major.red === 1);
    place(w, 0, 20, 0);
    const again = bill(w, 10);
    check('G402: re-crossing is NOT billed again — the tariff is per MATCH (Table 10-4)',
      again.major.red === 1, String(again.major.red));
    check('G402: ...so a repeat crosser still owes exactly one MAJOR',
      again.pts.blue === BB_PTS.foulMajor, String(again.pts.blue));

    // A robot on its OWN side, in contact, is not a G402 — but the one that came to it is.
    // The footprint is 21 in long (a sweeper on each end), so FULLY crossed needs the centre
    // more than 10.5 in past the line; a robot straddling it is not across at all.
    place(w, 0, -34, 0);
    place(w, 1, -14, 0);
    const own = bill(w, 10);
    check('G402: contact on the CROSSER\'s own side is not a foul', own.major.red === 1, String(own.major.red));
    check('G402: but the BLUE robot that crossed IS billed', own.major.blue === 1, String(own.major.blue));

    /**
     * ONE OFFENDER, TWO VICTIMS — the regression the per-MATCH latch exists for. Red 0 crosses
     * ONCE and ends up against both blues; that used to be two rising edges of two (crosser,
     * victim) keys and 40 points for a single act of AUTO interference. Both blues are head-on,
     * one ahead and one behind, at the same proven 12-in centre gap the check above uses — a
     * flank placement was tried first and does NOT make contact at this footprint, which would
     * have left this check passing for the wrong reason.
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
    check('G402: one crosser against TWO opponents is still ONE MAJOR (per MATCH)',
      vv.major.red === 1, String(vv.major.red));
    check('G402: ...so the victims are +20 between them, not +40',
      vv.pts.blue === BB_PTS.foulMajor, String(vv.pts.blue));

    /**
     * ...and the cap is per OFFENDER, which the latch must not over-reach into: "a TEAM may not
     * disrupt AUTO", and an FTC team is one robot. Two crossers on opposite alliances, in their
     * own corners of the field, are two teams and two MAJORs.
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
    check('G402: ...20 each way, and neither latch swallowed the other',
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
  }

  // ── G407: CONTROL of a fifth element — a WARNING, and only a warning ──────
  /**
   * Owner ruling 2026-09-12 (field-plan §4.3): G407 is a WARNING, not a cap. Table 10-4's base
   * sanction is a VERBAL WARNING, with MAJOR + YELLOW only if STRATEGIC, and the sim does not
   * guess at intent — so the tariff here is an event line, a HUD count, and zero points.
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
     * both DECODE loading-zone rects (blue’s is x ≥ 49, and it is DECODE’s that the shared
     * CONTROL test reads — see `bbControlled`) and of every wall.
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

  // ── G417: ramming the HIVE frame — STRATEGIC, so a MAJOR on the FIRST hit ─
  /**
   * The escalation condition is STRATEGIC, **not** REPEATED (manual-distilled §11 item 4).
   * "Ramming into the HIVE frame at high-speed" is example A of what is likely STRATEGIC, and
   * it is strategic on a SINGLE hit — so `BB_FRAME_RAM_SPEED` is this sim's strategic test and
   * there is no free first warning above it. REPEATED is example F, one indicator among six,
   * and reading it as the trigger is what dropped example A.
   *
   * "MAJOR FOUL and YELLOW CARD **per MATCH**" (Table 10-4), in deliberate contrast with
   * G416's "per instance" two rows above — so the tariff is paid ONCE however many times the
   * robot rams. The YELLOW CARD is not modelled; BIOBUZZ has no card machinery.
   */
  /**
   * ⚠️ POSES ARE ON THE FOOTPRINT (`footprintExtents`, sweepers included), NOT THE CHASSIS.
   * This check used to park the robot at x = 24 − 8, which with a 10.5-in footprint front is
   * BETWEEN the bars with its footprint reaching clean through the +x bar, and drove it in −x —
   * AWAY from the bar. It billed only because the old `frameRam` hard-coded "a robot on the +x
   * bar rams it by moving −x" whatever side the robot was on. Now the outside-in ram is staged
   * genuinely outside, flush on the bar's OUTER face.
   */
  const ramWorld = (x: number, y: number, vx: number, vy: number): World => {
    const q = bare([{ id: 0, alliance: 'blue' }]);
    q.match.phase = 'teleop';
    q.match.phaseTimeLeft = 60;
    place(q, 0, x, y);
    q.robots[0].vel = { x: vx, y: vy };
    return q;
  };
  const fe = footprintExtents(bare([{ id: 0, alliance: 'blue' }]).robots[0].spec);
  {
    const w = bare([{ id: 0, alliance: 'blue' }]);
    w.match.phase = 'teleop';
    w.match.phaseTimeLeft = 60;
    const r = w.robots[0];
    // OUTSIDE the +x frame bar, its rear flush on the bar's outer face (x = +25), driving INTO it
    place(w, 0, BB_FRAME_BAR_OUT + fe.rear, 0);
    r.vel = { x: -(BB_FRAME_RAM_SPEED + 10), y: 0 };
    const first = bill(w, 20);
    check('G417: the FIRST high-speed ram is STRATEGIC — a MAJOR, not a free warning',
      first.major.blue === 1, String(first.major.blue));
    check(`G417: red is +${BB_PTS.foulMajor}`, first.pts.red === BB_PTS.foulMajor, String(first.pts.red));
    check('G417: and it names itself STRATEGIC on the event feed',
      w.events.some((e) => e.includes('G417') && e.includes('STRATEGIC')),
      w.events.filter((e) => e.includes('G417')).join(' | '));

    // back off, then ram again — the tariff is PER MATCH, so it is not paid twice
    r.vel = { x: 0, y: 0 };
    bill(w, 5);
    r.vel = { x: -(BB_FRAME_RAM_SPEED + 10), y: 0 };
    const second = bill(w, 20);
    check('G417: a SECOND ram bills nothing more — the tariff is per MATCH',
      second.major.blue === 1, String(second.major.blue));
    check('G417: so red is still +20 and not +40', second.pts.red === BB_PTS.foulMajor, String(second.pts.red));

    // driving ALONG the structure at the same speed is not ramming (on the INNER face, between
    // the bars, where G409 says robots drive under the hives)
    const innerX = BB_FRAME_BAR_IN - fe.front; // front flush on the +x bar's inner face (x = +24)
    const q = ramWorld(innerX, 0, 0, BB_FRAME_RAM_SPEED + 40);
    check('G417: driving ALONG a frame bar is not ramming', bill(q, 20).major.blue === 0);
    // ...and a gentle nudge is the manual's own likely-NOT-STRATEGIC case ("accidentally
    // bumping the frame while attempting to pick up POLLEN"), so it is not a foul either
    q.robots[0].vel = { x: BB_FRAME_RAM_SPEED - 10, y: 0 };
    check('G417: contact below the ram threshold is not STRATEGIC, and not a foul',
      bill(q, 20).major.blue === 0);

    /**
     * EXAMPLE A NAMES NO FACE. A ram from BETWEEN the bars into the INNER face, and a ram along y
     * into a bar END, are the same act as the outside-in ram above — and the old closing speed
     * (`-sign * vel.x`) read the first as driving AWAY and the second as zero.
     */
    const inner = ramWorld(innerX, 0, BB_FRAME_RAM_SPEED + 10, 0);
    check('G417: a high-speed ram on the INNER face (from under the hives) bills a MAJOR',
      bill(inner, 20).major.blue === 1, String(inner.match.fouls.blue.major));
    const away = ramWorld(innerX, 0, -(BB_FRAME_RAM_SPEED + 10), 0);
    check('G417: driving fast AWAY from the inner face while touching it is not a ram',
      bill(away, 20).major.blue === 0, String(away.match.fouls.blue.major));
    // off the +y END of the +x bar, centred on the bar's width, its −y face flush on y = +BB_FRAME_Y
    const endX = (BB_FRAME_BAR_IN + BB_FRAME_BAR_OUT) / 2;
    const end = ramWorld(endX, BB_FRAME_Y + fe.half, 0, -(BB_FRAME_RAM_SPEED + 10));
    check('G417: a high-speed ram into a bar END along y bills a MAJOR',
      bill(end, 20).major.blue === 1, String(end.match.fouls.blue.major));
    const brush = ramWorld(endX, BB_FRAME_Y + fe.half, 0, -(BB_FRAME_RAM_SPEED - 10));
    check('G417: a slow brush on a bar END is not a foul',
      bill(brush, 20).major.blue === 0, String(brush.match.fouls.blue.major));
    // and the −x bar is the mirror: outside it at x < −25, driving +x
    const mirror = ramWorld(-BB_FRAME_BAR_OUT - fe.front, 0, BB_FRAME_RAM_SPEED + 10, 0);
    mirror.robots[0].heading = Math.PI; // rear toward the bar, as on the +x side
    mirror.robots[0].pos.x = -BB_FRAME_BAR_OUT - fe.rear;
    check('G417: the outside-in ram on the −x bar still bills',
      bill(mirror, 20).major.blue === 1, String(mirror.match.fouls.blue.major));
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
// G421 — PINNING, WHICH IS BILLED IN SECONDS AND NOT ON AN EDGE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ EVERY POSE BELOW IS MEASURED ON THE FOOTPRINT, 21 × 17, NOT THE 15 × 17 CHASSIS.
 * `robotExtents` adds a sweeper's reach to each end, so at heading 0 a robot reaches 10.5 in
 * along x and two of them are in contact whenever their centres are within ~21 in. Poses
 * written against the chassis put the robots a clear four inches apart and the rule simply
 * never fires — which reads exactly like a broken detector.
 *
 * The pin fixture is deliberately NOT a driven match. `isPinning` asks who is PRESSING and
 * the accumulator measures how far the victim actually got, so a hand-built world with static
 * poses is the only way to hold "pressed, going nowhere" for an exact number of seconds. What
 * a real chassis does when shoved is the physics lane's question, not this one's.
 */
function pinChecks(check: Check): void {
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
    ]);
    w.match.phase = 'teleop';
    w.match.phaseTimeLeft = 90;
    place(w, 1, 24 - 10.5, 0); // blue, flat against the +x HIVE frame bar
    place(w, 0, 24 - 10.5 - 20.5, 0); // red, pressing into it
    return w;
  };
  const press = new Map<number, RobotCommand>([[0, driveX(1)]]);

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
    ]);
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

    const off = bill(w, ticks(0.7)); // no command — the pinner stops pressing
    check('G421: easing off for 0.7 s bills nothing', off.major.red === 0, String(off.major.red));
    const paused = biobuzzFieldHud(w).pins;
    check('G421: the PIN is still on the books through the ease-off', paused.length === 1, String(paused.length));
    check('G421: and its count PAUSED rather than resetting — ~2.5 s, not 0',
      paused.length === 1 && Math.abs(paused[0].seconds - 2.5) < 0.05,
      paused.length === 1 ? paused[0].seconds.toFixed(3) : 'no pin');

    const resumed = bill(w, ticks(0.6), press); // 2.5 + 0.6 = 3.1 s of actual pinning
    check('G421: the count RESUMES — 2.5 s + 0.6 s crosses the tariff', resumed.major.red === 1, String(resumed.major.red));
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
    ]);
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
      // FOUR stills since the spill was calibrated to the owner's landing lines: the throw is
      // still crossing the field at 4 s and only comes to rest at ~4.2 s, so 8 s is the frame
      // that shows the SCATTER (`docs/biobuzz/feedback/001-spill-kinematics.md`).
      check('SCENE hive-tip: its stills are 0 · 2 s · 4 s · 8 s', s.stills.join(',') === '0,120,240,480', s.stills.join(','));
    }
  }
}

export function rulesChecks(check: Check): void {
  scoringChecks(check);
  penaltyChecks(check);
  pinChecks(check);
  cueChecks(check);
  sceneChecks(check);
}
