import type { RobotSpec } from '../../types';

/**
 * BIOBUZZ MECHANISM MOUNTS — which chassis edge(s) the sweeper rollers ride on, and where the
 * launcher is bolted.
 *
 * Copied and owned from `games/chain/mounts.ts` with the catalyst / rail / swing mechanism
 * removed (BIOBUZZ has no second manipulator yet — Section 10 lands at Kickoff). Nothing here
 * imports from `chain/`: a game is its own tree, so this file diverges freely the moment the
 * real manual says something CR does not.
 *
 * This is a LEAF module — it imports only `types` — and that is deliberate. A mount decides
 * the collision FOOTPRINT, so `src/sim/field.ts` (`footprintExtents`) reads mount resolvers,
 * and a games→sim→games import of anything heavier would be a cycle.
 *
 * Robot frame throughout: +x = forward, +y = the robot's LEFT, heading 0 = +x, CCW positive.
 *
 * ONE MOUNT MOVES THREE THINGS TOGETHER — where POLLEN is captured, where the chassis
 * collides, and where a launch starts. Every one of those reads this file, so they cannot
 * drift apart.
 *
 * FIELD REUSE: the shell rides the EXISTING shared `RobotSpec` mechanism fields
 * (`intake`, `intakeMount`, `shooterMount`, `scoreMode`, `ballStorage`) rather than minting
 * `bb*` twins. Their names are already game-neutral, `coerceSpec` already clamps them, and —
 * the load-bearing reason — `footprintExtents` already grows the hitbox from `intakeMount`,
 * so a BIOBUZZ side sweeper collides exactly where it is drawn with zero shared-code change.
 * Lane B adds `bb*` fields only for mechanisms BIOBUZZ has and CR does not.
 */

/** BIOBUZZ sweeper MOUNTS — which chassis edge(s) carry rollers. */
export const BB_INTAKE_MOUNTS = ['front', 'back', 'side', 'frontback'] as const;
export type BbIntakeMount = (typeof BB_INTAKE_MOUNTS)[number];

/** TURRETLESS firing edges. A drum/dumper launches along a LINE spanning one side, so a corner
 * or the centre is not something it can be built as — the coercer folds those away. */
export const BB_SHOOTER_EDGES = ['front', 'back', 'left', 'right'] as const;

/**
 * TURRET positions. A turret aims itself, so every point on the chassis is buildable —
 * including the middle, which is where most robots actually put one.
 *
 * ORDER IS THE 3x3 CHASSIS MAP the builder renders (front row, middle row, back row), so the
 * picker reads as a top-down diagram of the robot rather than a list.
 */
export const BB_MOUNT_POSITIONS = [
  'frontleft', 'front', 'frontright',
  'left', 'center', 'right',
  'backleft', 'back', 'backright',
] as const;
export type BbMountPos = (typeof BB_MOUNT_POSITIONS)[number];

/** which chassis edge a mechanism sits on, in the robot frame */
export type BbEdge = 'front' | 'back' | 'left' | 'right';

/** BIOBUZZ scoring archetypes. Same four shapes CR shipped, because they are the four ways an
 * FTC robot has ever put a ball somewhere — which target they aim AT is Lane A's problem. */
export const BB_SCORE_MODES = ['turret', 'twinturret', 'drum', 'dumper'] as const;
export type BbScoreMode = (typeof BB_SCORE_MODES)[number];

export const BB_DEFAULT_INTAKE_MOUNT: BbIntakeMount = 'front';
/** default FIRING EDGE for a turretless launcher */
export const BB_DEFAULT_SHOOTER_MOUNT: BbMountPos = 'front';
/** default TURRET position — CENTRE, the one place a ring clears every rail. */
export const BB_DEFAULT_TURRET_POS: BbMountPos = 'center';

const EDGES: readonly string[] = ['front', 'back', 'left', 'right'];
/** is this position one of the four EDGES (as opposed to a corner or the centre)? */
export function isEdgePos(pos: string): pos is BbEdge {
  return EDGES.includes(pos);
}

/**
 * Which cells of the 3x3 chassis map a mechanism physically OCCUPIES.
 *
 * Two mechanisms cannot share a cell — there is one piece of frame there and only one of them
 * can be bolted to it. Occupancy is not always a single cell, which is the whole reason this
 * exists: an EDGE-spanning mechanism (a sweeper bar, a drum's launch line) runs the full side,
 * so it takes the edge AND both corners of that side — "the whole row".
 *
 * `center` is included for a turret bolted mid-chassis: it blocks anything else that wanted the
 * middle, and nothing else.
 */
export function occupiedCells(pos: string, spansEdge: boolean): BbMountPos[] {
  if (pos === 'frontback') return ['front', 'frontleft', 'frontright', 'back', 'backleft', 'backright'];
  if (pos === 'side') return ['left', 'frontleft', 'backleft', 'right', 'frontright', 'backright'];
  if (spansEdge && isEdgePos(pos)) {
    if (pos === 'front') return ['front', 'frontleft', 'frontright'];
    if (pos === 'back') return ['back', 'backleft', 'backright'];
    if (pos === 'left') return ['left', 'frontleft', 'backleft'];
    return ['right', 'frontright', 'backright'];
  }
  return [pos as BbMountPos];
}

/**
 * Do two mounted mechanisms want the same piece of frame?
 *
 * NOT USED BETWEEN THE SWEEPER AND THE LAUNCHER, deliberately. In Chain Reaction this gated
 * the catalyst against the shooter, because both were ground-level manipulators competing for
 * the same rail. BIOBUZZ's two mechanisms live at different HEIGHTS: a sweeper is on the
 * floor and a drum, dumper or turret is above it. A front sweeper feeding a front-firing drum
 * is not a conflict, it is the single most common FTC layout there is — so the builder offers
 * every combination and the coercer keeps every combination. Kept because it is the shared
 * mount algebra and the moment BIOBUZZ grows a second FLOOR-LEVEL mechanism this is the test
 * it needs, and because `occupiedCells` is the piece worth having one owner of.
 */
export function mountsClash(
  a: { pos: string; spansEdge: boolean },
  b: { pos: string; spansEdge: boolean },
): boolean {
  const cells = new Set(occupiedCells(a.pos, a.spansEdge));
  return occupiedCells(b.pos, b.spansEdge).some((c) => cells.has(c));
}


/**
 * The resolved sweeper mount.
 *
 * Reads the shared `intakeMount` field, falling back to the legacy `intakeSide` boolean (older
 * saves and older peers, which drop fields they do not know) and then to the default. Pure —
 * safe to call on a RAW, un-coerced spec, which is what makes it usable from `footprintExtents`.
 */
export function bbIntakeMountOf(spec: Pick<RobotSpec, 'intakeMount' | 'intakeSide'>): BbIntakeMount {
  const m = spec.intakeMount;
  if (m && (BB_INTAKE_MOUNTS as readonly string[]).includes(m)) return m as BbIntakeMount;
  return spec.intakeSide ? 'side' : BB_DEFAULT_INTAKE_MOUNT;
}

/** the resolved launcher mount (same contract as `bbIntakeMountOf`, migrating `shooterRear`).
 * Accepts any of the nine positions — a TURRET may sit anywhere. Narrowing a turretless
 * launcher back to an edge is the coercer's job (`bbShooterEdgeOf`); this stays permissive so a
 * raw or older spec still reads. */
export function bbShooterMountOf(spec: Pick<RobotSpec, 'shooterMount' | 'shooterRear'>): BbMountPos {
  const m = spec.shooterMount;
  if (m && (BB_MOUNT_POSITIONS as readonly string[]).includes(m)) return m as BbMountPos;
  return spec.shooterRear ? 'back' : BB_DEFAULT_SHOOTER_MOUNT;
}

/** the TURRETLESS firing edge — `bbShooterMountOf` narrowed to a side. A corner falls to the
 * end it shares (a launch line spans a side, and the ends are the ones that matter for a
 * drum/dumper); the centre falls to the front. */
export function bbShooterEdgeOf(spec: Pick<RobotSpec, 'shooterMount' | 'shooterRear'>): BbEdge {
  const m = bbShooterMountOf(spec);
  if (isEdgePos(m)) return m;
  if (m === 'frontleft' || m === 'frontright') return 'front';
  if (m === 'backleft' || m === 'backright') return 'back';
  return 'front'; // center
}

/** the chassis edges a sweeper mount puts rollers on (order is stable: ends before flanks). */
export function bbIntakeEdges(mount: BbIntakeMount): BbEdge[] {
  switch (mount) {
    case 'front':
      return ['front'];
    case 'back':
      return ['back'];
    case 'frontback':
      return ['front', 'back'];
    case 'side':
      return ['left', 'right'];
  }
}

/**
 * Put a local frame on one intake MOUTH: origin at the mouth's INNER edge, +x pointing
 * OUTWARD, +y along the edge.
 *
 * Both renderers (the canvas sprite and the builder's SVG preview) draw the sweeper through
 * this, so each of them authors ONE mouth in ONE orientation instead of four sign-juggling
 * branches, and neither can drift off the capture rect the sim grabs POLLEN with.
 *
 * `rail` is where the CHASSIS EDGE falls in that frame — the mouth bites a couple of inches
 * back inside the frame (that is what lets it catch a POLLEN before the frame plows it), so
 * anything drawn across the full depth would be drawn over the chassis.
 */
export function bbMouthFrame(
  m: { edge: BbEdge; x0: number; x1: number; y0: number; y1: number },
  hl: number,
  hw: number,
): { ox: number; oy: number; rot: number; depth: number; half: number; rail: number } {
  const end = isEndEdge(m.edge);
  const depth = end ? m.x1 - m.x0 : m.y1 - m.y0;
  const half = (end ? m.y1 - m.y0 : m.x1 - m.x0) / 2;
  switch (m.edge) {
    case 'front':
      return { ox: m.x0, oy: 0, rot: 0, depth, half, rail: hl - m.x0 };
    case 'back':
      return { ox: m.x1, oy: 0, rot: Math.PI, depth, half, rail: m.x1 + hl };
    case 'left':
      return { ox: 0, oy: m.y0, rot: Math.PI / 2, depth, half, rail: hw - m.y0 };
    default: // right
      return { ox: 0, oy: m.y1, rot: -Math.PI / 2, depth, half, rail: m.y1 + hw };
  }
}

/** the robot-local angle (radians) a mechanism on `edge` points OUTWARD along: the direction a
 * launcher on that edge fires, and the outward normal of that edge's intake mouth. */
export const EDGE_ANGLE: Record<BbEdge, number> = {
  front: 0,
  back: Math.PI,
  left: Math.PI / 2,
  right: -Math.PI / 2,
};

/** the robot-local OUTWARD UNIT NORMAL of each edge, as exact integer components (the
 * `EDGE_ANGLE` direction, without a trig round-trip that would leave a ~1e-17 residue on the
 * ±π/2 flanks — which, in a deterministic sim, is a hash divergence waiting to happen).
 * `EDGE_PERP` is its left-hand perpendicular = the direction a launch line spreads across
 * that edge. */
export const EDGE_DIR: Record<BbEdge, { x: number; y: number }> = {
  front: { x: 1, y: 0 },
  back: { x: -1, y: 0 },
  left: { x: 0, y: 1 },
  right: { x: 0, y: -1 },
};
export const EDGE_PERP: Record<BbEdge, { x: number; y: number }> = {
  front: { x: 0, y: 1 },
  back: { x: 0, y: -1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

/** true when the edge is an END (front/back — spans the chassis WIDTH) rather than a FLANK
 * (left/right — spans the chassis LENGTH). Callers use it to pick which half-extent is the
 * edge's stand-off distance and which is its span. */
export function isEndEdge(edge: BbEdge): boolean {
  return edge === 'front' || edge === 'back';
}

/** the mounting geometry of `edge` on `spec`: `dist` = how far the edge is from the robot
 * centre along its outward normal, `span` = the edge's half-length across that normal. */
export function edgeGeom(spec: Pick<RobotSpec, 'length' | 'width'>, edge: BbEdge): { dist: number; span: number } {
  const hl = spec.length / 2;
  const hw = spec.width / 2;
  return isEndEdge(edge) ? { dist: hl, span: hw } : { dist: hw, span: hl };
}

/** the ROBOT-LOCAL point a mechanism at `pos` sits at (+x forward, +y left). Edges are the
 * mid-point of that side, corners the actual corner, centre the origin. This is the ONE source
 * for "where is it bolted" — the launch origin and both renderers all read it, so a mount can
 * never be drawn somewhere it does not act from. */
export function mountOrigin(spec: Pick<RobotSpec, 'length' | 'width'>, pos: BbMountPos): { x: number; y: number } {
  const hl = spec.length / 2;
  const hw = spec.width / 2;
  switch (pos) {
    case 'center': return { x: 0, y: 0 };
    case 'front': return { x: hl, y: 0 };
    case 'back': return { x: -hl, y: 0 };
    case 'left': return { x: 0, y: hw };
    case 'right': return { x: 0, y: -hw };
    case 'frontleft': return { x: hl, y: hw };
    case 'frontright': return { x: hl, y: -hw };
    case 'backleft': return { x: -hl, y: hw };
    case 'backright': return { x: -hl, y: -hw };
    default: return { x: 0, y: 0 }; // unreachable for a coerced spec; JSON safety
  }
}

const Q = Math.PI / 4;
/** the robot-local angle a mechanism at `pos` points OUTWARD along. Corners point along the
 * DIAGONAL at a flat 45°, not at the true corner normal of a non-square chassis: the mechanism
 * is a physical assembly bolted at an angle, not something that re-aims itself with the frame,
 * and a fixed 45° keeps the four corners exact mirror images of each other. `center` has no
 * outward direction — it reports forward, and only a turret (which aims itself) is buildable
 * there. */
export const MOUNT_ANGLE: Record<BbMountPos, number> = {
  front: 0,
  back: Math.PI,
  left: Math.PI / 2,
  right: -Math.PI / 2,
  frontleft: Q,
  frontright: -Q,
  backleft: Math.PI - Q,
  backright: -(Math.PI - Q),
  center: 0,
};

const S = Math.SQRT1_2; // exact-enough diagonal unit component; a CONSTANT, not a trig call
/** the robot-local outward UNIT vector for each position — `MOUNT_ANGLE` without a trig
 * round-trip, so the axis-aligned ones stay exactly integer (see `EDGE_DIR`). */
export const MOUNT_DIR: Record<BbMountPos, { x: number; y: number }> = {
  front: { x: 1, y: 0 },
  back: { x: -1, y: 0 },
  left: { x: 0, y: 1 },
  right: { x: 0, y: -1 },
  frontleft: { x: S, y: S },
  frontright: { x: S, y: -S },
  backleft: { x: -S, y: S },
  backright: { x: -S, y: -S },
  center: { x: 1, y: 0 },
};

/** The turret ring's radius, scaled to the chassis. Shared by the sim's inboard pull
 * (`turretLocal`) and BOTH renderers, which is the point: they used to derive it separately in
 * CR and disagreed by an inch, so the sprite's ring sat where the ball did not leave from. */
export function turretRadius(spec: Pick<RobotSpec, 'length' | 'width'>): number {
  return Math.min(3.8, Math.min(spec.length, spec.width) * 0.24);
}

/**
 * The turret's CENTRE OF ROTATION in the robot frame — the ONE point the sim launches from and
 * both renderers draw at, so the sprite can never sit somewhere POLLEN does not actually leave
 * from.
 *
 * An EDGE or CORNER mount is pulled INBOARD by the ring radius: a turret bolted "at the back"
 * has its ring a few inches inside the rear rail, not hanging off it. `center` is dead centre.
 */
export function turretLocal(spec: Pick<RobotSpec, 'length' | 'width' | 'shooterMount' | 'shooterRear'>): {
  x: number;
  y: number;
} {
  const pos = bbShooterMountOf(spec);
  if (pos === 'center') return { x: 0, y: 0 };
  const o = mountOrigin(spec, pos);
  const d = MOUNT_DIR[pos];
  const r = turretRadius(spec);
  // Pull inboard by the ring radius on EACH AXIS the mount touches, NOT by r along the mount
  // direction. At a CORNER the direction is diagonal, so moving r along it clears each rail by
  // only r/sqrt2 and leaves the ring hanging ~0.29r past both — visibly off the chassis.
  // `sign` makes an edge mount degenerate to the same single-axis pull it always had.
  return { x: o.x - Math.sign(d.x) * r, y: o.y - Math.sign(d.y) * r };
}

/** is this archetype TURRETED (top-mounted, aims itself)? Turreted launchers ignore the
 * shooter EDGE entirely — the turret rotates, so there is no chassis side to pick — and they
 * must NOT be steered by the fire button the way a turretless drum/dumper is. One predicate so
 * every UI and sim site agrees, including any future turret variant. */
export function isTurreted(mode: BbScoreMode | undefined): boolean {
  return mode === undefined || mode === 'turret' || mode === 'twinturret';
}
