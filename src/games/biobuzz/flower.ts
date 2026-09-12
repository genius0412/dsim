import type { Alliance, Vec2 } from '../../types';
import { BB_FLOWER_OPEN_R, BB_FLOWER_TOP_Z, BB_NECTAR_R, BB_POLLEN_R, BB_PTS } from './config';

/**
 * FLOWER logic — the stack model (§9.7 Fig 9-12, §10.5.2 Fig 10-5), PURE.
 *
 * A FLOWER is a vertical tube on the perimeter wall. Elements enter through the 4.0-in top
 * ring and stack bottom → top; POLLEN (2.8) can be pulled out of the 3.55-in retrieval opening
 * at the bottom, NECTAR (3.6) cannot. Nothing here reads or writes `World`: every function
 * takes the stack (a list of element ids, bottom first) plus the two lookups the world owns —
 * what colour an id is and how big it is — and returns a value. `play.ts` wires it after the
 * T0+2h sync; `scripts/smoke-biobuzz/field.ts` drives it directly.
 *
 * Every number the manual prints is imported from `config.ts`. The ones it does not print are
 * module-local and marked APPROX below, so the move into `config.ts` is a one-line import change.
 */

/** what an element IS, for scoring: a POLLEN, or a NECTAR of one alliance. */
export type BbElementKind = 'pollen' | Alliance;

/** the FLOWER's runtime state — field-plan §2 shape, declared locally until `state.ts` carries it. */
export interface FlowerState {
  /** element ids, BOTTOM → TOP */
  stack: number[];
}

/** radius (in) of an element by kind, §9.8 */
export function bbElementRadius(kind: BbElementKind): number {
  return kind === 'pollen' ? BB_POLLEN_R : BB_NECTAR_R;
}

/**
 * Top face of the LOWER ring, where the bottom element rests (Fig 9-12: lower ring 0.43 tall
 * on the tiles; its 2.79-in hole passes nothing). APPROX — Fig 9-12 pixel read.
 */
export const BB_FLOWER_FLOOR_Z = 0.43; // APPROX

/**
 * The SCORING VOLUME: between the top ring and the middle ring (§10.5.2, CAD 10-4). Middle ring
 * top = retrieval opening 3.55 + lower ring 0.43. APPROX — field-plan §1 `BB_FLOWER_VOL_Z`,
 * not yet in `config.ts`.
 */
export const BB_FLOWER_VOL_Z: readonly [number, number] = [3.98, BB_FLOWER_TOP_Z]; // APPROX

/**
 * How far above the top ring a descending element may still be taken as "entering" — the
 * backstop is 1.25 in tall, and a lob arrives from above. APPROX.
 */
export const BB_FLOWER_ENTRY_MARGIN = 3.0; // APPROX

/** centre heights (in) of every element in the stack, bottom → top, resting on the one below. */
export function flowerStackZ(stack: readonly number[], kindOf: (id: number) => BbElementKind): number[] {
  const out: number[] = [];
  let top = BB_FLOWER_FLOOR_Z;
  for (const id of stack) {
    const r = bbElementRadius(kindOf(id));
    out.push(top + r);
    top += 2 * r;
  }
  return out;
}

/** is an element with centre `z` and radius `r` at least PARTIALLY inside the scoring volume? */
export function flowerInVolume(z: number, r: number): boolean {
  return z + r > BB_FLOWER_VOL_Z[0] && z - r < BB_FLOWER_VOL_Z[1];
}

/**
 * Would one more element of radius `r` FIT on this stack? Fills while the new element's centre
 * would be below `BB_FLOWER_TOP_Z + r` — i.e. while it would still be partially inside the
 * volume (field-plan §2.2; Fig 10-5 D/H — a nectar held on the backstop still counts). That
 * condition is `top + r < TOP_Z + r`, so the radius cancels: the test is whether the stack's
 * current top is below the ring. `_r` stays in the signature because a caller has it in hand
 * and a later, stricter rule (a full-diameter fit) would need it.
 */
export function flowerFits(stack: readonly number[], kindOf: (id: number) => BbElementKind, _r: number): boolean {
  const zs = flowerStackZ(stack, kindOf);
  const top = zs.length === 0 ? BB_FLOWER_FLOOR_Z : zs[zs.length - 1] + bbElementRadius(kindOf(stack[stack.length - 1]));
  return top < BB_FLOWER_TOP_Z;
}

/** how many SAME-SIZE elements of radius `r` an empty FLOWER holds. */
export function flowerCapacity(r: number): number {
  let n = 0;
  let top = BB_FLOWER_FLOOR_Z;
  while (top < BB_FLOWER_TOP_Z) {
    n++;
    top += 2 * r;
  }
  return n;
}

/**
 * GEOMETRIC entry test — TOP entry only. A flight element whose (x, y) is within
 * `BB_FLOWER_OPEN_R` of the ring centre, whose height is at the top ring (within the entry
 * margin above, one radius below) and which is DESCENDING. Capacity is `flowerFits`, checked
 * by the caller, so a full flower rejects for a reason the HUD can name.
 */
export function flowerAccepts(flower: Vec2, pos: Vec2, z: number, vz: number, r: number = BB_POLLEN_R): boolean {
  if (vz >= 0) return false;
  const dx = pos.x - flower.x;
  const dy = pos.y - flower.y;
  if (dx * dx + dy * dy > BB_FLOWER_OPEN_R * BB_FLOWER_OPEN_R) return false;
  return z >= BB_FLOWER_TOP_Z - r && z <= BB_FLOWER_TOP_Z + BB_FLOWER_ENTRY_MARGIN;
}

/**
 * RETRIEVAL (G418.B): pop the BOTTOM element, and only if it is POLLEN — a NECTAR is 3.6 in
 * and the retrieval opening is 3.55, so a nectar at the bottom LOCKS the flower. Returns the
 * new stack and the id taken (`null` ⇒ nothing came out, stack unchanged).
 */
export function flowerRetrieve(
  stack: readonly number[],
  kindOf: (id: number) => BbElementKind,
): { stack: number[]; id: number | null } {
  if (stack.length === 0 || kindOf(stack[0]) !== 'pollen') return { stack: [...stack], id: null };
  return { stack: stack.slice(1), id: stack[0] };
}

export interface FlowerScore {
  /** alliance of the TOP-MOST NECTAR inside the scoring volume; `null` ⇒ nobody owns it */
  owner: Alliance | null;
  /** `BB_PTS.owned` per element inside the volume, to the owner; 0 when unowned */
  ownerPts: number;
  /** alliance of the BOTTOM-MOST NECTAR inside the scoring volume; `null` ⇒ no bonus */
  bonusAlliance: Alliance | null;
  /** `BB_PTS.bottomNectar` when `bonusAlliance` is set */
  bonusPts: number;
  /** elements at least partially inside the scoring volume */
  inVolume: number;
}

/**
 * §10.5.2 / Fig 10-5: elements score when at least partially inside the volume. Owner = alliance
 * of the top-most scoring NECTAR, earning 2 per scoring element whoever placed it. Bottom NECTAR
 * Bonus 5 to the alliance of the bottom-most scoring NECTAR. No nectar ⇒ no owner, no bonus.
 */
export function flowerScore(stack: readonly number[], kindOf: (id: number) => BbElementKind): FlowerScore {
  const zs = flowerStackZ(stack, kindOf);
  let inVolume = 0;
  let owner: Alliance | null = null;
  let bonusAlliance: Alliance | null = null;
  for (let i = 0; i < stack.length; i++) {
    const kind = kindOf(stack[i]);
    if (!flowerInVolume(zs[i], bbElementRadius(kind))) continue;
    inVolume++;
    if (kind === 'pollen') continue;
    if (bonusAlliance === null) bonusAlliance = kind;
    owner = kind; // last one seen in volume wins: the stack is bottom → top
  }
  return {
    owner,
    ownerPts: owner ? inVolume * BB_PTS.owned : 0,
    bonusAlliance,
    bonusPts: bonusAlliance ? BB_PTS.bottomNectar : 0,
    inVolume,
  };
}
