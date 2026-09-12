import type { Artifact, RobotState, Vec2 } from '../types';
import * as C from '../config';
import { hyp, rot } from '../math';

/**
 * WHAT ON A ROBOT IS SOLID TO A GROUND ARTIFACT — the one geometry authority.
 *
 * Both Rapier solves and the pin test read THIS, so nothing can disagree about where an
 * artifact may and may not be: the artifact solve builds its robot colliders from these
 * shapes, the robot solve builds the same shapes to meet a pinned artifact, and the test that
 * decides an artifact is pinned measures against them. The old engine had three descriptions
 * of the same surface (`ballRobotContact`, `ballWedgedInRobot`, the chassis cuboid in the ball
 * solve) and they disagreed by a roller radius, which is exactly the width of the band where
 * artifacts were frozen by one rule and released by another.
 *
 * Robot frame throughout: +x forward, +y the robot's LEFT, origin at the chassis centre.
 *
 * The shapes, per intake preset (see `INTAKE_PRESETS`):
 *
 *  · The CHASSIS box `[-hl, hl] × [-hw, hw]`, always.
 *  · A FUNNEL preset (sloped / triangle) has two solid WEDGES, one per side: the slope running
 *    from the throat at the chassis face `(hl, ±th)` out to the mouth at the roller line
 *    `(tip, ±mh)`, closed off by the flank at `|y| = hw` — except that outboard of the mouth the
 *    last roller-radius of the reach is OPEN, because there is nothing at floor level there but
 *    the roller riding above the artifacts (the "opener" block sits high in z). That is the
 *    convex pentagon `(hl, th) → (tip, mh) → (wedgeFront, mh) → (wedgeFront, hw) → (hl, hw)`.
 *  · A FLAT preset (vector) has an open notch the full width of the chassis and nothing solid
 *    forward of the face but two thin RAILS along the flanks, so a wide frame cannot be
 *    entered from the side. The rail sits just inside the notch with its outer face flush
 *    with the chassis side.
 *  · The artifacts the robot is HOLDING are circles at their storage slots — a full hopper is
 *    a physical plug in the mouth, so incoming artifacts pile up on it.
 *
 * The MOUTH itself — between the wedges or rails, forward of the chassis face — is deliberately
 * NOT here. It is open to artifacts by design (product decision #10): the rollers ride above
 * ball height and an artifact rolls in under them to the throat.
 */

export type SolidShape =
  | { kind: 'box'; cx: number; cy: number; hx: number; hy: number }
  | { kind: 'poly'; pts: Vec2[] } // convex, counter-clockwise
  | { kind: 'circle'; cx: number; cy: number; r: number };

export interface RobotSolids {
  chassis: SolidShape;
  /** intake structure: wedges or rails. Solid to every ground artifact, claimed or not. */
  structure: SolidShape[];
  /** artifacts the robot is carrying, at their storage slots. Solid to everything except the
   *  artifact a gate is expelling into the mouth (see `world.ts`). */
  held: SolidShape[];
}

/** the robot's artifact-solid geometry, in the robot frame */
export function robotSolids(r: RobotState, heldBalls: readonly Artifact[]): RobotSolids {
  const hl = r.spec.length / 2;
  const hw = r.spec.width / 2;
  const preset = C.INTAKE_PRESETS[r.spec.intake];
  const mouth = C.intakeMouth(r.spec);
  const tip = hl + preset.reach;
  const structure: SolidShape[] = [];
  if (mouth.wedge) {
    /**
     * THE FUNNEL, one convex quadrilateral per side: the SLOPE from the throat at the chassis
     * face out to the mouth, the POCKET behind it out to the flank, and the pocket's front at
     * the roller axle (`wedgeFront`) — forward of that there is only the roller and the opener
     * block, both riding above ball height, so that band is open at floor level.
     *
     * THE SLOPE RUNS A LIP PAST THE ROLLER LINE (`INTAKE_LIP`). A rigid plate ending exactly at
     * the mouth's corner deflects an artifact centred ON that corner straight ahead — it rides
     * the corner at the robot's speed and is never taken, which is what a 7in-off-centre
     * artifact did (1.3s to capture against 0.33s). The real mouth's edge is a compliant
     * roller end, and what it does to an artifact overlapping the opening is pull it in; the
     * lip is that, as geometry: the slope face reaches a little past the roller line, so an
     * artifact centred at the mouth's edge meets the FACE and is turned inward, while one a
     * radius further out meets nothing but the lip's end and is not.
     *
     * Convex by construction (throat → lip → flank-front → flank-back), so Rapier's hull is
     * exactly this shape and nothing is filled in.
     */
    const wedgeFront = C.intakeAxleX(r.spec); // the roller AXLE — one authority (config.ts)
    const mh = Math.min(mouth.mouthHalf, hw);
    const th = Math.min(mouth.throatHalf, mh);
    const slope = (mh - th) / Math.max(preset.reach, 1e-6);
    const lip = C.INTAKE_LIP;
    for (const s of [1, -1]) {
      const pts: Vec2[] = [
        { x: hl, y: s * th },
        { x: tip + lip, y: s * Math.min(mh + lip * slope, hw) },
        { x: wedgeFront, y: s * hw },
        { x: hl, y: s * hw },
      ];
      structure.push({ kind: 'poly', pts: s > 0 ? pts : pts.reverse() });
    }
  } else {
    // the rails: thin, inside the notch, outer face flush with the chassis side
    const t = Math.min(C.INTAKE_RAIL_T, hw);
    for (const s of [1, -1]) {
      structure.push({
        kind: 'box',
        cx: (hl + tip) / 2,
        cy: s * (hw - t / 2),
        hx: preset.reach / 2,
        hy: t / 2,
      });
    }
  }
  const held: SolidShape[] = [];
  for (const b of heldBalls) {
    if (b.state.kind !== 'held' || b.state.robot !== r.id) continue;
    held.push({ kind: 'circle', cx: b.state.lx, cy: b.state.ly, r: C.BALL_RADIUS });
  }
  return { chassis: { kind: 'box', cx: 0, cy: 0, hx: hl, hy: hw }, structure, held };
}

export interface Penetration {
  /** how far the artifact's skin is inside the shape (negative = clear by that much) */
  pen: number;
  /** unit normal, pointing from the shape toward the artifact (robot frame) */
  nx: number;
  ny: number;
  /** true when the artifact's CENTRE is inside the shape — no honest contact normal exists
   *  and the artifact has been placed somewhere it cannot be */
  buried: boolean;
}

/** penetration of an artifact of radius `R` centred at `p` (robot frame) into one shape */
export function shapePenetration(sh: SolidShape, p: Vec2, R: number): Penetration {
  if (sh.kind === 'circle') {
    const dx = p.x - sh.cx;
    const dy = p.y - sh.cy;
    const d = hyp(dx, dy);
    if (d < 1e-9) return { pen: R + sh.r, nx: 1, ny: 0, buried: true };
    return { pen: R + sh.r - d, nx: dx / d, ny: dy / d, buried: d < sh.r };
  }
  if (sh.kind === 'box') {
    const lx = p.x - sh.cx;
    const ly = p.y - sh.cy;
    const cx = Math.max(-sh.hx, Math.min(sh.hx, lx));
    const cy = Math.max(-sh.hy, Math.min(sh.hy, ly));
    const dx = lx - cx;
    const dy = ly - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 > 1e-12) {
      const d = Math.sqrt(d2);
      return { pen: R - d, nx: dx / d, ny: dy / d, buried: false };
    }
    // centre inside: leave by the nearest face
    const ox = sh.hx - Math.abs(lx);
    const oy = sh.hy - Math.abs(ly);
    if (ox < oy) return { pen: R + ox, nx: Math.sign(lx || 1), ny: 0, buried: true };
    return { pen: R + oy, nx: 0, ny: Math.sign(ly || 1), buried: true };
  }
  // convex polygon, CCW: outward edge normals; inside ⇔ behind every edge
  const pts = sh.pts;
  const n = pts.length;
  let inside = true;
  let bestEdge = -Infinity; // the least-negative signed distance while inside
  let bnx = 1;
  let bny = 0;
  let nearest = Infinity; // distance to the boundary while outside
  let qx = 0;
  let qy = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const el = hyp(ex, ey);
    if (el < 1e-9) continue;
    const onx = ey / el; // outward normal of a CCW edge
    const ony = -ex / el;
    const sd = (p.x - a.x) * onx + (p.y - a.y) * ony;
    if (sd > 0) inside = false;
    if (sd > bestEdge) {
      bestEdge = sd;
      bnx = onx;
      bny = ony;
    }
    // closest point on this edge segment
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / (el * el)));
    const cx = a.x + ex * t;
    const cy = a.y + ey * t;
    const d = hyp(p.x - cx, p.y - cy);
    if (d < nearest) {
      nearest = d;
      qx = cx;
      qy = cy;
    }
  }
  if (inside) return { pen: R - bestEdge, nx: bnx, ny: bny, buried: true };
  if (nearest < 1e-9) return { pen: R, nx: bnx, ny: bny, buried: false };
  return { pen: R - nearest, nx: (p.x - qx) / nearest, ny: (p.y - qy) / nearest, buried: false };
}

export interface RobotPenetration extends Penetration {
  /** which part of the robot it is inside */
  part: 'chassis' | 'structure' | 'held';
}

/**
 * The deepest penetration of an artifact into anything solid on the robot, in the WORLD frame,
 * or null when it is clear of all of it. `skipChassis` is the intake CLAIM: an artifact the
 * funnel is drawing in is allowed onto the chassis face (the throat is where it is going), and
 * `skipHeld` is the gate DOORWAY: the artifact being expelled steps past the carried ones.
 */
export function robotPenetration(
  r: RobotState,
  solids: RobotSolids,
  p: Vec2,
  R: number,
  skipChassis = false,
  skipHeld = false,
  /** report shapes the artifact is CLEAR of by less than this too (negative pen), so a caller
   *  can ask 'is it still resting against the robot' — by default only real penetration */
  floor = 0,
): RobotPenetration | null {
  const local = rot({ x: p.x - r.pos.x, y: p.y - r.pos.y }, -r.heading);
  let best: RobotPenetration | null = null;
  const consider = (sh: SolidShape, part: RobotPenetration['part']) => {
    const q = shapePenetration(sh, local, R);
    if (q.pen <= floor) return;
    if (!best || q.pen > best.pen) best = { ...q, part };
  };
  if (!skipChassis) consider(solids.chassis, 'chassis');
  for (const sh of solids.structure) consider(sh, 'structure');
  if (!skipHeld) for (const sh of solids.held) consider(sh, 'held');
  if (!best) return null;
  const b = best as RobotPenetration;
  const nw = rot({ x: b.nx, y: b.ny }, r.heading);
  return { ...b, nx: nw.x, ny: nw.y };
}
