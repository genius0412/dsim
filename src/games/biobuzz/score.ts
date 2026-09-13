import type { Alliance, Artifact, RobotState, World } from '../../types';
import { robotCorners, robotIntersectsRect } from '../../sim/physics';
import { START_TOUCH_TOL } from '../../config';
import {
  BB_GARDEN,
  BB_HALF_X,
  BB_HALF_Y,
  BB_LZ,
  BB_PTS,
  BB_RP,
} from './config';
import { bbElementRadius, flowerScore, type BbElementKind } from './flower';
import type { BiobuzzState } from './state';

/**
 * BIOBUZZ SCORING — Table 10-2, recomputed from the world EVERY TICK.
 *
 * ── WHY IT IS RECOMPUTED RATHER THAN ACCUMULATED ────────────────────────────
 * Chain Reaction's pattern in `src/games/chain/play.ts`: the score is a PURE FUNCTION of the
 * state, evaluated fresh, never a running total that events add to. Every achievement in
 * Table 10-2 except the TIP is a property of where things ARE at the moment you look — how
 * many elements sit in an up-CELL, what is partially in a GARDEN, who holds the top NECTAR in
 * a FLOWER. An accumulator has to be told when each of those stops being true, and every
 * "the score went up and never came back down" bug in a sim is one of those messages missing.
 *
 * A recomputed score cannot drift, cannot double-count a re-entered element, and makes the
 * whole scoring rule readable in one function. It also makes the smoke lane's job possible:
 * a check builds a state by hand and compares one number against an arithmetic it did on
 * paper, which is what `scripts/smoke-biobuzz/rules.ts` does for every line of the table.
 *
 * ── THE TWO KINDS OF LINE, AND WHY LATCHES EXIST AT ALL ─────────────────────
 * Most lines are CONTINUOUS: cell contents, flowers, gardens. They are read live and they are
 * whatever they are when the buzzer goes, which is exactly what "at rest after the match"
 * (§10.5.C/E) means for a sim that stops stepping at the buzzer.
 *
 * LEAVE and PARK are not. They are assessed at an INSTANT — the end of AUTO, and the end of
 * the MATCH (Table 10-2) — and a robot that drives back to the wall after that keeps its
 * points. So those three are LATCHED into `world.biobuzz` by `step.ts` at the phase boundary,
 * and this file reads the latch once the instant has passed. BEFORE the instant it reads the
 * live predicate instead, so a HUD shows a provisional value that moves while a driver can
 * still change it, and freezes when the rule says it freezes. `bbLeftNow` / `bbParkedNow` are
 * exported so `step.ts` latches with the same predicate this scores with — one definition, or
 * the HUD and the final score disagree by exactly the bug nobody finds until a real match.
 *
 * ── FOULS ARE NOT IN HERE ───────────────────────────────────────────────────
 * `foul` on the breakdown is READ from `world.match.scores[a].foulPoints`, which `penalties.ts`
 * writes. It is reported here so one object carries everything a results row needs, but this
 * file never awards anything: a foul is an EVENT with an edge, and an edge is the one thing a
 * recomputed function cannot express.
 *
 * PURE: reads `world`, writes nothing. `bbApplyScore` is the one function that writes, and it
 * writes only the totals the shared chrome reads.
 */

/** the two alliances, in a fixed order, so a loop over them is deterministic. */
const ALLIANCES: readonly Alliance[] = ['red', 'blue'];

/**
 * What an element IS, from its colour (§9.8): POLLEN are yellow, NECTAR carry their alliance.
 *
 * The colour is the ONLY thing on an `Artifact` that says what it is — there is no `kind`
 * field, and adding one would be a `src/types.ts` edit for a fact the colour already carries.
 * Anything that is not a recognised NECTAR colour is a POLLEN, because the alternative
 * (throwing, or returning a third kind) would make one stray artifact from another game's
 * snapshot take down a score.
 */
export function bbKindOf(ball: Artifact): BbElementKind {
  return ball.color === 'red' || ball.color === 'blue' ? ball.color : 'pollen';
}

/** id → kind for every element in the world, built once per score so the FLOWER and CELL
 * lookups are O(1) rather than a scan of `world.balls` per id. */
export function bbKindIndex(world: World): (id: number) => BbElementKind {
  const m = new Map<number, BbElementKind>();
  for (const b of world.balls) m.set(b.id, bbKindOf(b));
  // POLLEN for an id nothing in the world matches: a stack or a cell may name an element that
  // a scene replaced out of `world.balls`, and a missing element must score nothing rather
  // than crash — `inVolume` counts it either way, so the default is only ever about its size.
  return (id) => m.get(id) ?? 'pollen';
}

// ─────────────────────────────────────────────────────────────────────────────
// THE LIVE PREDICATES — one definition each, shared by the latch and the score
// ─────────────────────────────────────────────────────────────────────────────

/**
 * LEAVE (Table 10-2): the ROBOT is "no longer contacting the perimeter wall".
 *
 * Every corner of the footprint strictly inside the wall planes, by the shared
 * `START_TOUCH_TOL` of slack. The slack is the same 1.25 in the START rules use for "touching
 * the wall" (`spawn.ts`), and it is on this side of the test on purpose: a robot that has
 * pulled away by a millimetre has not LEFT in any sense a referee would recognise, and
 * without the tolerance the achievement would flicker for a robot resting against the wall as
 * the solve nudges it.
 */
export function bbLeftNow(r: RobotState): boolean {
  const lim = BB_HALF_X - START_TOUCH_TOL;
  const limY = BB_HALF_Y - START_TOUCH_TOL;
  for (const c of robotCorners(r)) {
    if (Math.abs(c.x) > lim || Math.abs(c.y) > limY) return false;
  }
  return true;
}

/**
 * PARK (Table 10-2, Fig 10-7): the ROBOT is "at least partially in the LOADING ZONE".
 *
 * ITS OWN zone. Settled by the owner on 2026-09-12 (field-plan §8) and it matches Fig 10-7:
 * the zone "belongs to" the alliance whose ALLIANCE AREA it adjoins, so parking in the
 * opponent's is not this achievement. "At least partially" is an OBB-vs-rect intersection,
 * which is what `robotIntersectsRect` computes — a corner inside the tape is enough.
 */
export function bbParkedNow(r: RobotState): boolean {
  return robotIntersectsRect(r, BB_LZ[r.alliance]);
}

/**
 * GARDEN (§10.5.3, Fig 10-6): an element "at least partially in" the 23 × 2 strip.
 *
 * A CIRCLE against an axis-aligned RECT, so the test is the distance from the centre to the
 * nearest point of the rect. Fig 10-6's whole point is that an element overhanging the tape
 * counts, which a centre-in-rect test would refuse for most of a 2-in-deep strip: the strip is
 * narrower than a POLLEN, so a centre-only rule would score almost nothing that is actually
 * in a GARDEN.
 *
 * GROUND elements only. One in a hopper, in flight, in a CELL or in a FLOWER is not on the
 * tiles, and a held element whose position tracks its robot across a garden would otherwise
 * score while it is carried.
 */
export function bbInGarden(ball: Artifact, a: Alliance): boolean {
  if (ball.state.kind !== 'ground') return false;
  const g = BB_GARDEN[a];
  const r = ball.r ?? bbElementRadius(bbKindOf(ball));
  const dx = Math.max(g.x0 - ball.pos.x, 0, ball.pos.x - g.x1);
  const dy = Math.max(g.y0 - ball.pos.y, 0, ball.pos.y - g.y1);
  return dx * dx + dy * dy < r * r;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE BREAKDOWN
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One alliance's score, line by line, with the COUNT beside the POINTS for every line that
 * has one.
 *
 * Both, rather than points alone, because a driver reads counts and a results screen reads
 * points, and deriving one from the other at the read site is where a multiplier change goes
 * wrong. `total` is the GAME total and excludes `foul` — fouls belong to the alliance that
 * did NOT commit them and are added once, in `bbApplyScore`, so that a breakdown can be
 * summed without asking whether fouls are already in it.
 */
export interface BbAllianceScore {
  /** robots that LEFT, and 3 each */
  leaveCount: number;
  leave: number;
  /** robots PARKED at the end of AUTO, and 5 each */
  parkAutoCount: number;
  parkAuto: number;
  /** robots PARKED at the end of the MATCH, and 5 each */
  parkTeleCount: number;
  parkTele: number;
  /** completed HIVE TIPS, and 20 each */
  tips: number;
  tipPts: number;
  /** elements in this alliance's upward-facing CELL right now — LIVE, a readout and not a
   * score. What is in a tray is on its way to being tipped out of it. */
  cellCount: number;
  /** 2 for each of those, **and 0 until the match is over** (owner ruling, 2026-09-12): Table
   * 10-2 pays for an element LEFT IN the cell, which is a state of the field at the buzzer.
   * Lands once, at `post`; never in freeplay, which has no buzzer. */
  cellPts: number;
  /** elements inside a FLOWER this alliance OWNS, and 2 each */
  ownedCount: number;
  ownedPts: number;
  /** FLOWERS whose bottom-most scoring NECTAR is this alliance's, and 5 each */
  bottomCount: number;
  bottomPts: number;
  /** elements at least partially in this alliance's GARDEN, and 1 each */
  gardenCount: number;
  gardenPts: number;
  /** points from the OPPONENT's fouls — read from `world.match`, never written here */
  foul: number;
  /** the sum of every line above EXCEPT `foul` */
  total: number;
}

/** the RANKING POINTS an alliance has earned so far (Tables 10-2/10-3). */
export interface BbRankPoints {
  /** LEAVE + PARK points ≥ 16 */
  swarm: boolean;
  /** ≥ 4 TIPS */
  pollinator1: boolean;
  /** ≥ 7 TIPS */
  pollinator2: boolean;
}

export interface BbScore {
  red: BbAllianceScore;
  blue: BbAllianceScore;
  /** who OWNS each FLOWER, in `BB_FLOWERS` order; `null` where no NECTAR is in the volume */
  flowerOwners: (Alliance | null)[];
  rp: Record<Alliance, BbRankPoints>;
}

const zero = (): BbAllianceScore => ({
  leaveCount: 0,
  leave: 0,
  parkAutoCount: 0,
  parkAuto: 0,
  parkTeleCount: 0,
  parkTele: 0,
  tips: 0,
  tipPts: 0,
  cellCount: 0,
  cellPts: 0,
  ownedCount: 0,
  ownedPts: 0,
  bottomCount: 0,
  bottomPts: 0,
  gardenCount: 0,
  gardenPts: 0,
  foul: 0,
  total: 0,
});

/**
 * THE WHOLE OF TABLE 10-2, evaluated against the world as it is right now.
 *
 * Order below follows the manual's table so the two can be read side by side. Every points
 * value comes from `BB_PTS`, never a literal, so a V2 revision is one edit in `config.ts`.
 *
 * ── THE TIP IS THE ONE ACCUMULATED LINE, AND IT IS NOT ACCUMULATED HERE ─────
 * `hives[a].tips` is a COUNTER that `play.ts` increments when a swing settles (§10.5.1: the
 * damper makes contact). It has to be a counter — a TIP is an event, and the field afterwards
 * looks the same as a field that never tipped. What this function does is multiply it, which
 * is still a pure read.
 *
 * Table 10-2 prints a TIP at 20 in AUTO and 20 in TELEOP, the SAME value, so the total needs
 * no AUTO/TELEOP split and none is stored. A results screen that wants to show the split
 * needs one more counter latched at the end of AUTO; it is not here because nothing in the
 * points depends on it, and an unused counter in the state bag is one more thing a snapshot
 * has to carry correctly. Noted in `docs/biobuzz/HANDOFF-field.md`.
 */
export function bbScoreWorld(world: World): BbScore {
  const bb = world.biobuzz;
  const out: BbScore = {
    red: zero(),
    blue: zero(),
    flowerOwners: [null, null, null, null],
    rp: {
      red: { swarm: false, pollinator1: false, pollinator2: false },
      blue: { swarm: false, pollinator1: false, pollinator2: false },
    },
  };
  if (!bb) return out;
  const kindOf = bbKindIndex(world);
  const phase = world.match.phase;

  // ── LEAVE / PARK — live while the instant is still ahead, latched once it has passed ──
  for (const r of world.robots) {
    if (r.passive) continue; // a practice dummy is not a competitor and scores nothing
    const s = out[r.alliance];
    const left = phase === 'pre' || phase === 'auto' ? bbLeftNow(r) : (bb.leave[r.id] ?? false);
    if (left) s.leaveCount++;
    const parkA = phase === 'auto' ? bbParkedNow(r) : (bb.parkAuto[r.id] ?? false);
    if (parkA) s.parkAutoCount++;
    // PARK is assessed a second time at the END OF THE MATCH, so before TELEOP there is
    // nothing provisional to show — a robot parked in AUTO has not yet earned the teleop 5.
    const parkT = phase === 'teleop' ? bbParkedNow(r) : (bb.parkTele[r.id] ?? false);
    if (parkT) s.parkTeleCount++;
  }

  // ── HIVE TIP, and the elements LEFT in the up-CELL at the END ─────────────
  /**
   * ⚠️ THE CELL LINE IS SCORED AT THE END OF THE MATCH, NOT LIVE (owner ruling, 2026-09-12).
   *
   * Table 10-2 pays 2 for an element "left in" the up-CELL, and LEFT IN is a state of the
   * field at the buzzer, not a running total: everything in a cell is on its way to being
   * TIPPED out, and the ones that tip earn the 20 and then stop being worth anything. Counting
   * them live made the score bar tick up 2 at a time while the load built and then drop by ten
   * or twelve the instant the bar swung, which reads as a penalty for doing the one thing the
   * HIVE is for.
   *
   * So `cellCount` — the driver's readout, what is in the tray right now — stays LIVE, and it
   * is the POINTS that wait. `cellPts` is 0 for the whole match and lands once at `post`.
   *
   * `cellCount` is the UP cell's by construction: `hiveStep` empties the tray as the bar passes
   * level and hands the swing over to the cell coming up, so there is never a down-cell's load
   * in here.
   *
   * FREEPLAY never reaches `post` and therefore never banks the line. That is the same answer
   * PARK already gives in freeplay (its latch is never written), and it is the honest one: a
   * practice session has no buzzer, so there is no instant at which anything was "left in".
   */
  const matchOver = phase === 'post';
  for (const a of ALLIANCES) {
    const hive = bb.hives[a];
    out[a].tips = hive.tips;
    out[a].cellCount = hive.contents.length;
  }

  // ── FLOWERS: 2 per element to the OWNER, 5 to the bottom NECTAR's alliance ─
  bb.flowers.forEach((f, i) => {
    const fs = flowerScore(f.stack, kindOf);
    out.flowerOwners[i] = fs.owner;
    if (fs.owner) {
      out[fs.owner].ownedCount += fs.inVolume;
      out[fs.owner].ownedPts += fs.ownerPts;
    }
    if (fs.bonusAlliance) {
      out[fs.bonusAlliance].bottomCount += 1;
      out[fs.bonusAlliance].bottomPts += fs.bonusPts;
    }
  });

  // ── GARDENS: 1 per element, to the GARDEN's colour whoever put it there ────
  for (const b of world.balls) {
    for (const a of ALLIANCES) {
      if (bbInGarden(b, a)) {
        out[a].gardenCount++;
        break; // the two gardens are in opposite corners and cannot both contain one element
      }
    }
  }

  // ── the arithmetic, once ──────────────────────────────────────────────────
  for (const a of ALLIANCES) {
    const s = out[a];
    s.leave = s.leaveCount * BB_PTS.leave;
    s.parkAuto = s.parkAutoCount * BB_PTS.parkAuto;
    s.parkTele = s.parkTeleCount * BB_PTS.parkTele;
    s.tipPts = s.tips * BB_PTS.tip;
    // 0 until the buzzer — see the CELL block above.
    s.cellPts = matchOver ? s.cellCount * BB_PTS.cell : 0;
    s.gardenPts = s.gardenCount * BB_PTS.garden;
    s.foul = world.match.scores[a].foulPoints;
    s.total =
      s.leave + s.parkAuto + s.parkTele + s.tipPts + s.cellPts + s.ownedPts + s.bottomPts + s.gardenPts;
    out.rp[a] = {
      // SWARM counts the LEAVE and PARK lines only — 16 is exactly both robots LEAVE and both
      // PARK in AUTO (3+3+5+5), which is why it is a threshold on those four numbers and not
      // on the match total.
      swarm: s.leave + s.parkAuto + s.parkTele >= BB_RP.swarm,
      pollinator1: s.tips >= BB_RP.pollinator1,
      pollinator2: s.tips >= BB_RP.pollinator2,
    };
  }
  return out;
}

/**
 * Write the scored world back: `bb.points`, `bb.scored`, and the shared `ScoreBreakdown` the
 * chrome reads.
 *
 * ── WHAT LANDS ON THE SHARED BREAKDOWN, AND WHY SO LITTLE ───────────────────
 * `ScoreBreakdown` is DECODE's shape (`src/types.ts`, integration-chat territory): `leave`,
 * three CLASSIFIED/OVERFLOW/PATTERN pairs, `depot`, `base`, `foulPoints`, `total`. Exactly one
 * of its fields means the same thing in both games, and that is `leave`, so that is the only
 * one filled. Mapping BIOBUZZ's CELL contents onto `autoClassified` because the slot is free
 * would put a number under a label that lies about it on every shared screen.
 *
 * `total` is therefore SET rather than recomputed: the shared `recomputeTotal` sums DECODE's
 * fields, which for this game would be `leave + foulPoints` and nothing else. The BIOBUZZ
 * breakdown lives on `HudSnapshot.gameHud` (`hud.ts`) where a game's own numbers belong.
 *
 * A RED CARD still voids the match (`voided`, §10.6.1) — the same rule the shared
 * `recomputeTotal` applies, applied here because this function is the one that sets `total`.
 *
 * `scored` is the alliance's POLLEN-and-NECTAR count in play for it — the up-CELL contents
 * plus what it owns in the FLOWERS plus its GARDEN. It is what the score bar's "SCORED" panel
 * has always shown and it is now a real number rather than a structural zero.
 */
export function bbApplyScore(world: World, s: BbScore): void {
  const bb = world.biobuzz as BiobuzzState | undefined;
  if (!bb) return;
  /**
   * PARK is the only end-of-match ROBOT state Section 10 defines, so it is the only thing
   * `endgame` can honestly say. Written HERE rather than at the assessment instant because
   * `play.ts`'s score pass rewrites `endgame` to `'none'` on every tick of stage 8 — a latch
   * set at the buzzer would survive exactly one tick. Deriving it from `parkTele` each tick
   * instead makes it immune to the write order, and the latch it reads is already frozen.
   */
  for (const r of world.robots) bb.endgame[r.id] = bb.parkTele[r.id] ? 'parked' : 'none';
  for (const a of ALLIANCES) {
    const line = s[a];
    bb.points[a] = line.total;
    bb.scored[a] = line.cellCount + line.ownedCount + line.gardenCount;
    const br = world.match.scores[a];
    br.leave = line.leave;
    br.total = br.voided ? 0 : line.total + br.foulPoints;
  }
}
