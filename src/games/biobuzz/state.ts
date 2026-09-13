import type { Alliance, Vec2 } from '../../types';
import type { BbEdge } from './mounts';

/**
 * BIOBUZZ runtime state and field geometry.
 *
 * Everything BIOBUZZ-specific rides `world.biobuzz`, so the shared `World` type needs exactly
 * one optional field. It is PLAIN JSON — counters, per-robot records, an id cursor — with no
 * class instances, no functions and no `Map`s, because the snapshot path (`slimWorld` /
 * `unslimWorld`), the wire protocol and the replay format all round-trip it as JSON, and the
 * determinism rule ("all game state plain JSON on `world.<gameId>`") is what makes a replay
 * from a peer bit-identical to the one that produced it.
 *
 * POLLEN themselves are NOT in here. They live in `world.balls` as shared `Artifact`s, exactly
 * as CR's particles do, because the physics, the containment clamp, the snapshot diff and the
 * wire already handle that array. What rides here is everything ABOUT them that is BIOBUZZ's.
 */

// ─────────────────────────────────────────────────────────────────────────────
// GEOMETRY TYPES — the shapes the A↔B contract is written in
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One robot-local axis-aligned rectangle, in inches, in the robot frame (+x forward, +y left).
 * `x0 < x1` and `y0 < y1` always.
 *
 * This is the shape an INTAKE MOUTH is, and it is the contract's `LocalRect`. It carries the
 * `edge` it belongs to because the pad in `mouthContains` grows only the OUTWARD side, and
 * which side that is depends on the edge — so a rect without its edge is not enough to test
 * containment correctly.
 */
export interface LocalRect {
  edge: BbEdge;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/**
 * A three-component vector, in inches / inches-per-second.
 *
 * The shared `Vec2` covers the field plane; POLLEN also have height, and a LAUNCH is
 * inherently 3D (a horizontal velocity plus a vertical one, which is what makes it an arc
 * rather than a slide). Defined here rather than in `src/types.ts` because BIOBUZZ is the
 * only game whose contract needs it, and `src/types.ts` belongs to the integration chat.
 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * A place POLLEN can be SCORED, in world coordinates.
 *
 * FILLED IN SINCE KICKOFF: `scoreTargets()` now lists the asking alliance's own up-CELL and
 * the four FLOWER tops. It does NOT list the opponent's CELL — an element launched by the
 * other alliance does not enter it (owner ruling 2026-09-12) — so a caller that wants every
 * opening on the FIELD rather than every opening this alliance can score in has to ask for
 * both and merge, which is what `play.ts`'s capture pass does.
 *
 * `alliance` is `null` for a NEUTRAL target. The FLOWERS are neutral at aim time even though
 * they are owned at score time: ownership is whoever holds the top-most NECTAR (10.5.2), which
 * is a fact about the stack, not about the opening.
 *
 * `id` is stable and JSON-safe (it ends up in HUD text and in events). `pos` is the point to
 * aim at; `z` is how high it sits, so a lob has an arc to solve for; `r` is the accepting
 * radius, which is what "did it go in" will be measured against.
 */
export interface ScoreTarget {
  id: string;
  alliance: Alliance | null; // null ⇒ neutral / shared target
  pos: Vec2;
  z: number;
  r: number;
  /**
   * THE WAY THE OPENING FACES — a UNIT vector in world xy, pointing OUT of the mouth.
   *
   * Every BIOBUZZ target is a hole in something solid, and `pos` alone does not say which side
   * of that something is the open one. A CELL's opening faces along the HIVE's tilt axis, away
   * from the pivot; a FLOWER's faces into the field, away from the wall it stands against. An
   * arc solved to `pos` from the wrong side arrives through the floor of the cell or through
   * the perimeter, which is a shot that scores in the sim and cannot be taken on a real field.
   *
   * OPTIONAL because it is a property of the target's GEOMETRY, and a target that is a plain
   * volume (a zone, a basket open at the top) has no such direction to report. A consumer that
   * does not care about approach side ignores it; one that does treats its absence as "no
   * constraint" rather than as a default direction — there is no sensible default, and
   * guessing one is the bug this field exists to prevent.
   */
  mouth?: Vec2;
}

/** is robot-local point (`lx`,`ly`) inside `rect`?
 *
 * `pad` (a POLLEN radius) grows ONLY the OUTWARD edge — a pollen just touching the roller tip
 * is in, but the inner and lateral bounds stay exact, so the mouth can never silently swallow
 * something through the chassis. That asymmetry is the whole reason this is a function rather
 * than an inline bounds check. */
export function rectContains(rect: LocalRect, lx: number, ly: number, pad = 0): boolean {
  const x0 = rect.edge === 'back' ? rect.x0 - pad : rect.x0;
  const x1 = rect.edge === 'front' ? rect.x1 + pad : rect.x1;
  const y0 = rect.edge === 'right' ? rect.y0 - pad : rect.y0;
  const y1 = rect.edge === 'left' ? rect.y1 + pad : rect.y1;
  return lx > x0 && lx < x1 && ly > y0 && ly < y1;
}

// ─────────────────────────────────────────────────────────────────────────────
// FIELD ELEMENT STATE — DRAFT until the T0+2h sync
//
// The shapes below are `docs/biobuzz/field-plan.md` §2, and they exist so the RENDERER and
// the smoke lane have something real to read on kickoff day. Nothing WRITES them yet: staging
// (`spawn.ts`) and the lifecycle (`hive.ts` / `flower.ts`) land in a later pass, so a fresh
// state is a correctly SHAPED empty field, not a staged one.
// ─────────────────────────────────────────────────────────────────────────────

/** which end of a HIVE is the one facing UP. `north` is y > 0 (the rear, opposite the
 * audience), `south` is y < 0. A HIVE is bi-stable, so this is a two-member union rather than
 * an angle: the tilt is only ever one of two poses, and `tipping` covers the swing between. */
export type BbCellSide = 'north' | 'south';

/**
 * One HIVE. Both CELLS belong to one alliance and only one of them faces up at a time.
 *
 * `contents` holds BALL IDS, not elements: the elements themselves stay in `world.balls` so
 * conservation is a count over ONE array (field-plan §6 request 2). `tips` is the achievement
 * counter the POLLINATOR RPs read. `tipping` is SECONDS LEFT in the swing, 0 when settled —
 * a duration rather than a boolean because the TIP is worth points at the END of the swing
 * (§10.5.1: the damper has to make contact), and a boolean cannot say how far in it is.
 */
export interface BbHiveState {
  up: BbCellSide;
  contents: number[];
  tips: number;
  tipping: number;
  /**
   * HAS THE SWING IN PROGRESS ALREADY DROPPED ITS LOAD?
   *
   * The spill and the TIP are two moments of ONE swing: the tray empties as the bar passes
   * LEVEL (`BB_TIP_RELEASE_S`) and the 20 points land two seconds later when it SETTLES
   * (§10.5.1 — the damper has to make contact). `tipping` alone cannot tell those apart,
   * because a bar with 2 s left has either just emptied or is about to, depending on nothing
   * the rest of the state records — so without this latch a re-entrant step spills the same
   * contents twice, which is a duplicate in `world.balls` and the end of the conservation
   * invariant. `false` whenever `tipping` is 0, and reset at the end of every swing.
   */
  released: boolean;
}

/**
 * One FLOWER, as a STACK bottom → top of ball ids.
 *
 * A stack rather than a set because both scoring rules are about ORDER: the owner is the
 * alliance of the TOP-most nectar and the bonus goes to the BOTTOM-most one (§10.5.2), and
 * retrieval (G418.B) pops the bottom element only. An unordered collection would make both of
 * those a search over positions the sim does not track.
 */
export interface BbFlowerState {
  stack: number[];
  /** which FLOWER this is — `BB_FLOWERS[i].id`, i.e. `F1`…`F4`.
   *
   * REDUNDANT WITH THE INDEX, AND CARRIED ANYWAY, because the state is the thing that reaches
   * the wire, a snapshot and the rules lane, and an array position is not a name. A row that
   * says which flower it is can be logged, asserted against and read in a HUD slice without
   * the reader also holding `BB_FLOWERS` in the right order. */
  id: string;
  /**
   * NO PER-FLOWER SUPPLY. The A4 state contract carried a draft `stock` / `nectarDue` pair
   * here against the possibility that a FLOWER dispenses its own NECTAR. The reference now
   * answers that: `docs/biobuzz-reference.md` §2.4 and G426 put every NECTAR into the field
   * through the HUMAN PLAYER — one per own-HIVE TIP, and all remaining stock at ≤ 60 s — and
   * nothing anywhere gives a flower a supply of its own. The two fields are deleted rather
   * than left at 0: a field the rules can read but the sim will never write is a trap, and
   * the per-ALLIANCE `nectarStock` / `nectarDue` / `nectarTimer` below are the whole supply.
   */
}

// ─────────────────────────────────────────────────────────────────────────────
// THE STATE BAG
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-robot ENDGAME status. A plain string union rather than an enum so it survives JSON, and
 * `'none'` rather than an absent key so a HUD read never has to distinguish "no endgame yet"
 * from "robot id I have not seen".
 *
 * SHELL: only `'none'` is ever set. Section 10 defines what an endgame IS for this game, and
 * the two other members are the two shapes every FTC endgame has taken — park somewhere, or
 * climb something — kept so the HUD and the results rows have a value space to render.
 */
export type BbEndgame = 'none' | 'parked' | 'climbed';

export interface BiobuzzState {
  /** POLLEN scored per alliance, as a COUNT. Separate from `points` because a count is what
   * the HUD shows and what a replay is checked against, while points fold in whatever
   * multiplier Section 10 turns out to define. */
  scored: Record<Alliance, number>;
  /** points earned from POLLEN, with any multiplier already folded in AT score time. Folding
   * at score time rather than at read time is what makes a mid-match multiplier change score
   * only what comes after it. SHELL: always 0 — `scored: false` on the sim module, so nothing
   * writes here and no match of this game reaches a leaderboard. */
  points: Record<Alliance, number>;
  /** endgame status per robot id. `BbEndgame`, widened to `string` in the contract so the two
   * lanes can add members without a shared type edit. */
  endgame: Record<number, BbEndgame>;
  /**
   * Per-robot, per-key BOOLEAN LATCHES — "this robot is currently holding X".
   *
   * The nested shape is what lets Lane A add a held-thing without touching the state type:
   * `held[robotId]['queen'] = true`. It exists in the shell because the alternative is each
   * lane inventing its own `Record<number, …>` bag at the moment it needs one, and then the
   * snapshot has two of them.
   */
  held: Record<number, Record<string, boolean>>;
  /** the next POLLEN id to hand out. Ids must be UNIQUE and MONOTONIC for the lifetime of a
   * world: the snapshot diff, the renderer's per-ball state and every event that names a
   * pollen key off it, so reusing one silently aliases two objects. Seeded past the initial
   * scatter by `createBiobuzzWorld`. */
  nextBallId: number;
  /**
   * EDGE-TRIGGER MEMORY for the penalty engine: the set of foul conditions that were TRUE at
   * the end of the previous tick.
   *
   * A foul fires on the RISING EDGE only. Without this map a condition that stays true for
   * two seconds bills 120 fouls, which is how a penalty engine turns a brush into a
   * disqualification. Keys are opaque strings the rule itself composes (offender + rule +
   * whatever makes the instance distinct), so adding a rule never changes this type.
   *
   * SHELL: always empty — `penalties.ts` has no rules, because Section 11 (Game Rules) is a
   * Kickoff placeholder. The scaffold is here and tested so the first real rule is a predicate
   * and nothing else.
   */
  foulEdge: Record<string, boolean>;
  /**
   * THE TWO HIVES, keyed by the alliance whose CELLS they are. DRAFT (field-plan §2).
   *
   * `emptyBiobuzzState` builds them in the STAGED pose — red's south CELL up, blue's north
   * (§10.3.1, Fig 10-2) — because that pose is a property of the FIELD, not of a match: an
   * unstaged hive has no legal state to be in. The three NECTAR that start in each up-cell are
   * staging, so `contents` is empty here and `spawn.ts` fills it.
   */
  hives: Record<Alliance, BbHiveState>;
  /** the four FLOWERS, in `BB_FLOWERS` order (F1…F4). A fixed-length tuple because there are
   * exactly four and the index IS the id everywhere else — a variable-length array would let
   * a bug produce a fifth flower that renders and scores. DRAFT. */
  flowers: [BbFlowerState, BbFlowerState, BbFlowerState, BbFlowerState];
  /** NECTAR still in the ALLIANCE AREA, in the human player's hands. 5 per alliance at setup
   * (§10.3.1) — written by `spawn.ts`, 0 here. Counted, not id'd: an element in a human's hand
   * is not on the field, so it is not in `world.balls` until the human enters it. DRAFT. */
  nectarStock: Record<Alliance, number>;
  /** NECTAR the alliance has EARNED the right to enter but has not entered yet — one per TIP
   * (G426). Separate from `nectarStock` because the two run out independently: an alliance can
   * be owed an entry it has no stock for, and at ≤ 60 s the remaining stock enters regardless
   * of what is due (§2.4 of the field plan). DRAFT. */
  nectarDue: Record<Alliance, number>;
  /**
   * SECONDS UNTIL THIS ALLIANCE'S HUMAN PLAYER PUTS THE NEXT NECTAR ON THE TILES.
   *
   * A human player is not instant: a TIP earns an entry (G426) and the nectar appears in the
   * LOADING ZONE a beat later, and in the ≤ 60 s dump the remaining stock arrives one at a
   * time rather than as a pile on one tile. That beat is what this counts down.
   *
   * It is STATE rather than a derived value because it is a clock, and the one clock rule this
   * repo has is that a clock lives on the world (`world.time`, this) and never in a module
   * global — a global would be shared by every world in the process, so a replay and a live
   * match in the same tab would take turns draining it. 0 means "ready now".
   */
  nectarTimer: Record<Alliance, number>;
  /** per robot id: did it LEAVE (stop contacting the perimeter) by the end of AUTO? Latched at
   * that instant and never recomputed, because the achievement is assessed once (Table 10-2)
   * and a robot that drives back to the wall in TELEOP keeps its 3. DRAFT. */
  leave: Record<number, boolean>;
  /** per robot id: PARK at end of AUTO / end of MATCH, the two separate 5-point assessments.
   * Two maps rather than one because they are two achievements that can disagree. DRAFT. */
  parkAuto: Record<number, boolean>;
  parkTele: Record<number, boolean>;
  /**
   * GALLERY-ONLY RENDER FLAG: draw the zone / flower / hive / tile-letter captions.
   *
   * It rides the state bag because `drawField(ctx, world, screenUp)` is the shared slot's
   * whole signature — the renderer has no other channel — and `scenesField.ts` is the only
   * thing that sets it, on the `field-labelled` cell. The SIM never reads or writes it, and a
   * real match leaves it undefined, which is why it is optional rather than a `false` default:
   * an absent key is the honest way to say "no scene asked for this".
   */
  labels?: boolean;
}

/**
 * A fresh, zeroed BIOBUZZ state.
 *
 * EVERY field is written explicitly rather than spread from a frozen template: the state is
 * mutated in place all match, so a shared nested object (`scored`, `held`) would be aliased
 * across every world in the process — which in practice means two smoke checks, or a client
 * and a replay in the same tab, silently sharing a score.
 */
export function emptyBiobuzzState(): BiobuzzState {
  return {
    scored: { red: 0, blue: 0 },
    points: { red: 0, blue: 0 },
    endgame: {},
    held: {},
    nextBallId: 1,
    foulEdge: {},
    // STAGED, not zeroed: a HIVE has no "no tilt" state, and the manual's staged pose puts
    // red's south CELL up and blue's north (§10.3.1, Fig 10-2). Contents stay empty — the
    // three NECTAR in each up-cell are `spawn.ts`'s to place.
    hives: {
      red: { up: 'south', contents: [], tips: 0, tipping: 0, released: false },
      blue: { up: 'north', contents: [], tips: 0, tipping: 0, released: false },
    },
    // four literals rather than a `map`, so the tuple type holds and so the four stacks are
    // four distinct arrays — a `fill()` of one object would alias every flower to one stack.
    flowers: [
      { id: 'F1', stack: [] },
      { id: 'F2', stack: [] },
      { id: 'F3', stack: [] },
      { id: 'F4', stack: [] },
    ],
    nectarStock: { red: 0, blue: 0 },
    nectarDue: { red: 0, blue: 0 },
    nectarTimer: { red: 0, blue: 0 },
    leave: {},
    parkAuto: {},
    parkTele: {},
  };
}
