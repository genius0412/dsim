import type { Alliance, World } from '../../types';
import { BB_FLOWER_UNLOCK_S, BB_TIP_POLLEN } from './config';
import { BB_TIP_SWING_S } from './hive';
import { bbNectarLocked } from './penalties';
import { bbKindIndex, bbScoreWorld, type BbAllianceScore, type BbRankPoints } from './score';

/**
 * The FIELD half of the BIOBUZZ HUD slice (`docs/biobuzz-contract.md` §5, Lane A).
 *
 * A game's HUD used to mean a per-game bag on the shared `HudSnapshot`, which is how
 * `game.ts` grows a field per season and every reader grows a branch. Instead the sim module
 * exposes ONE `hud(world, robotId)` and the shared chrome renders whatever comes back —
 * so this file is the only place that knows what BIOBUZZ shows.
 *
 * DOM-FREE, and that is a hard requirement rather than a style: the authoritative server
 * computes the same snapshot for its clients, so anything here that touched a document or a
 * clock would either crash the server or desynchronise it.
 *
 * ── WHAT A BIOBUZZ DRIVER CANNOT SEE ON THE FIELD, AND THEREFORE NEEDS HERE ─
 * The field draws STATE and never text: a CELL's contents are a row of discs, a FLOWER's stack
 * is a column of discs outside the wall, and there are no letters or digits anywhere in a
 * match (field-plan §2.5, owner ruling 2026-09-12). That ruling is what makes this slice load
 * bearing rather than decorative — everything a driver has to COUNT rather than SEE lives
 * here:
 *
 *  • `cells` — the up-CELL's contents SPLIT BY TYPE, plus `needed`: how many more POLLEN would
 *    tip it. `BB_TIP_POLLEN` is a measured table indexed by the NECTAR count (reference §4.1),
 *    so "three more pollen" is not derivable from a single total and a driver cannot compute
 *    it from the discs. It is the single most decision-changing number in the game.
 *  • `tipping` — the 4 s swing. The CELL accepts nothing while it moves (`hiveAccepts`), so a
 *    launcher holding fire at a swinging hive is wasting its hopper.
 *  • `nectarLocked` / `nectarIn` — G410. Entering a NECTAR one second early is a MAJOR 20, and
 *    the cue that unlocks it is an audio one on a real field.
 *  • `nectarStock` / `nectarDue` — what the human player still has and what they are owed.
 *  • `flowerOwners` — ownership is the alliance of the TOP-most NECTAR, which the stack shows
 *    but does not announce.
 *  • `score` / `rp` — the whole of Table 10-2 per alliance, so the score bar and the results
 *    rows read one object rather than re-deriving the table.
 *
 * BACK-COMPAT: every field is defaulted, never asserted. A snapshot from a build that predates
 * this game arrives without `world.biobuzz`, and a HUD is the last place that should throw.
 */

/** what is in one alliance's upward-facing CELL, by type, and what it would take to tip it. */
export interface BbCellHud {
  /** POLLEN in the up-CELL */
  pollen: number;
  /** NECTAR in the up-CELL, either colour — any alliance may LAUNCH into any cell */
  nectar: number;
  /** POLLEN still needed to TIP, from the measured table indexed by `nectar`. 0 ⇒ it is about
   * to go, or is already going. */
  needed: number;
  /** completed TIPS this match */
  tips: number;
  /** seconds left in the swing, 0 when settled. The CELL accepts nothing while this is > 0. */
  tipping: number;
  /** 0…1 through the swing, for a progress ring. 0 when settled. */
  tipProgress: number;
  /** which end is up — `north` is y > 0 (the rear wall), `south` is the audience side. */
  up: 'north' | 'south';
}

export interface BiobuzzFieldHud {
  /** elements scored per alliance — up-CELL contents + owned FLOWER elements + GARDEN. */
  scored: Record<Alliance, number>;
  /** the full Table 10-2 breakdown per alliance. */
  score: Record<Alliance, BbAllianceScore>;
  /** ranking points earned so far (SWARM, POLLINATOR 1/2). */
  rp: Record<Alliance, BbRankPoints>;
  /** each alliance's HIVE: contents by type, the tip threshold, the swing. */
  cells: Record<Alliance, BbCellHud>;
  /** who owns each FLOWER, in `BB_FLOWERS` order; `null` where no NECTAR is in the volume. */
  flowerOwners: (Alliance | null)[];
  /** elements currently in each FLOWER's stack, same order — what the stack drawing counts. */
  flowerDepth: number[];
  /** NECTAR still in the human player's hands, per alliance (§10.3.1: 5 at setup). */
  nectarStock: Record<Alliance, number>;
  /** entries EARNED by TIPS and not yet made (G426), per alliance. */
  nectarDue: Record<Alliance, number>;
  /** G410: may a NECTAR legally enter a FLOWER right now? */
  nectarLocked: boolean;
  /** seconds until the 1:00 cue, or 0 once it has passed. `null` outside TELEOP, where the
   * countdown to it is not yet running and a number would be a guess at the remaining AUTO. */
  nectarIn: number | null;
}

/** an empty slice — the shape a pre-BIOBUZZ snapshot gets, with every count at 0. */
function emptyHud(): BiobuzzFieldHud {
  const cell = (up: 'north' | 'south'): BbCellHud => ({
    pollen: 0,
    nectar: 0,
    needed: BB_TIP_POLLEN[0],
    tips: 0,
    tipping: 0,
    tipProgress: 0,
    up,
  });
  const zero: BbAllianceScore = {
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
  };
  const rp: BbRankPoints = { swarm: false, pollinator1: false, pollinator2: false };
  return {
    scored: { red: 0, blue: 0 },
    score: { red: { ...zero }, blue: { ...zero } },
    rp: { red: { ...rp }, blue: { ...rp } },
    cells: { red: cell('south'), blue: cell('north') },
    flowerOwners: [null, null, null, null],
    flowerDepth: [0, 0, 0, 0],
    nectarStock: { red: 0, blue: 0 },
    nectarDue: { red: 0, blue: 0 },
    nectarLocked: true,
    nectarIn: null,
  };
}

export function biobuzzFieldHud(world: World): BiobuzzFieldHud {
  const bb = world.biobuzz;
  if (!bb) return emptyHud();
  const s = bbScoreWorld(world);
  const kindOf = bbKindIndex(world);
  const out = emptyHud();

  for (const a of ['red', 'blue'] as Alliance[]) {
    const hive = bb.hives[a];
    let pollen = 0;
    let nectar = 0;
    for (const id of hive.contents) {
      if (kindOf(id) === 'pollen') pollen++;
      else nectar++;
    }
    // the measured table, clamped at its last row: past 5 NECTAR it is 0 POLLEN, and five
    // nectar tip a cell on their own (reference §4.1). `needed` is what is STILL required, so
    // it never goes negative — a cell over the threshold is one that is already swinging.
    const want = BB_TIP_POLLEN[Math.min(nectar, BB_TIP_POLLEN.length - 1)];
    out.cells[a] = {
      pollen,
      nectar,
      needed: Math.max(0, want - pollen),
      tips: hive.tips,
      tipping: hive.tipping,
      tipProgress: hive.tipping > 0 ? 1 - hive.tipping / BB_TIP_SWING_S : 0,
      up: hive.up,
    };
    out.scored[a] = s[a].cellCount + s[a].ownedCount + s[a].gardenCount;
    out.score[a] = s[a];
    out.rp[a] = s.rp[a];
    out.nectarStock[a] = bb.nectarStock[a];
    out.nectarDue[a] = bb.nectarDue[a];
  }
  out.flowerOwners = s.flowerOwners;
  out.flowerDepth = bb.flowers.map((f) => f.stack.length);
  out.nectarLocked = bbNectarLocked(world);
  out.nectarIn =
    world.match.phase === 'teleop' ? Math.max(0, world.match.phaseTimeLeft - BB_FLOWER_UNLOCK_S) : null;
  return out;
}
