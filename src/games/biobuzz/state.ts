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
 * SHELL STUB, and honestly so: `scoreTargets()` returns `[]` because Section 9 (ARENA) and
 * Section 10 (Game Details) of the V0 manual are Kickoff placeholders, so there is no goal,
 * basket, hive or zone to describe. The TYPE exists now because Lane B's `bbAimHeading` and
 * `bbLaunch` are written against it, and a type that arrives after its callers is a refactor
 * rather than a fill-in.
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
  };
}
