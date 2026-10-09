/**
 * BIOBUZZ robot PARTS — the chassis body and the wheels.
 *
 * COPIED AND OWNED from `games/chain/parts.ts`. Nothing is imported from `chain/`, because a
 * game is its own tree: the day BIOBUZZ wants a different frame, or Chain Reaction retunes
 * its own, neither drags the other with it.
 *
 * These live in the game module rather than in `src/render/drawRobot.ts` for the reason that
 * file explains about itself: it draws the DECODE robot, and DECODE's sprite is deliberately
 * frozen to what `main` ships. The richer chassis and the treaded/butterfly wheels are not
 * DECODE's look, and keeping them out here is what lets the DECODE renderer stay
 * byte-identical while every other game keeps evolving.
 *
 * What is drawn here is the part of a robot that is NOT a game mechanism — frame and
 * drivetrain. The mechanisms themselves (sweeper, dumper, turrets, Box Tube) are
 * `drawRobot.ts`'s (canvas) and `RobotPreview.tsx`'s (SVG) job to DRAW, which keeps a mechanism
 * change out of the chassis code. The one exception is `bbBoxTubeGlyph` below: it is GEOMETRY
 * (where a fixture sits and which way it points), not drawing, and both of those renderers need
 * the identical answer — the same reason `mounts.ts` holds `turretLocal` rather than either
 * renderer computing its own.
 */
import type { RobotSpec, RobotState } from '../../types';
import * as C from '../../config';
import { roundRect, strokeInside, tintColor } from '../../render/drawRobot';
import { wheelLocals } from '../../sim/robot';
import { bbShooterEdgeOf, edgeGeom, turretLocal, turretRadius, type BbMountPos } from './mounts';
import { bbIsTurreted, bbLauncherOf, bbLiftOf } from './mechs';
import {
  BB3_DUMPER_PIVOT_BACK,
  BB3_DUMPER_PIVOT_FRAC,
  BB3_DUMPER_SPAN_FRAC,
  BB3_NECTAR_TURRET_R,
  BB3_NECTAR_TURRET_TOP_Z,
  BB3_TURRET_R,
  BB3_TURRET_TOP_Z,
  BB_DECK_Z,
  BB_LAUNCH_Z0,
  BB_TURRET_RING_H,
  bbBoxTubeFrame,
  bbBoxTubeStages,
  bbBoxTubeStowedBoxes,
  bbLiftPlaceLocal,
  bbTowerBoxRobot,
  type BbBoxTubeFrame,
  type BbTowerBox,
} from './config';

/**
 * The CHASSIS — an FTC frame seen from above. Deliberately PLAIN: extruded aluminium rails
 * around a base plate, and nothing else. There are no bumpers in FTC (that is FRC), and a
 * painted-on control hub is set dressing that competes with the parts you actually configure.
 * Everything that should draw the eye here is a real subsystem — intake, drivetrain, turret,
 * launcher — so the frame's job is to stay out of their way and give them something to be
 * bolted to.
 *
 * The alliance stays in the OUTLINE, which is where it has always been.
 */
/**
 * The chassis SILHOUETTE line, drawn on the inside of the footprint and drawn LAST.
 *
 * Inside-stroking moved the line a half-width inboard, so anything reaching the true edge —
 * a sweeper bar, DECODE's gate-opener tabs — filled the sliver outside it and read as poking
 * through. Drawn over them it is the boundary of the whole object, which is what an outline
 * is for.
 */
export function drawChassisOutline(ctx: CanvasRenderingContext2D, r: RobotState, color: string): void {
  ctx.strokeStyle = color;
  strokeInside(
    ctx,
    () => roundRect(ctx, -r.spec.length / 2, -r.spec.width / 2, r.spec.length, r.spec.width, C.CHASSIS_CORNER),
    C.CHASSIS_OUTLINE,
  );
}

export function drawChassisBody(
  ctx: CanvasRenderingContext2D,
  r: RobotState,
  fill: string,
  /** draw the contact shadow? Always true in BIOBUZZ — there is no raised terrain a robot
   * could be lifted onto, so the chassis is always on the tile. Kept as a PARAMETER rather
   * than removed: a shadow drawn at a lifted chassis's position while another is drawn at its
   * true footprint on the mat reads as two robots, and that is the bug a future BIOBUZZ ramp
   * would reintroduce the moment someone forgets. */
  shadow = true,
): void {
  const L = r.spec.length;
  const W = r.spec.width;
  const hl = L / 2;
  const hw = W / 2;

  if (shadow) {
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.30)';
    roundRect(ctx, -hl + 0.6, -hw + 0.9, L, W, C.CHASSIS_CORNER);
    ctx.fill();
    ctx.restore();
  }

  // base plate. Its OUTLINE is not drawn here — see `drawChassisOutline`, which the caller
  // runs after the mechanisms so the silhouette line sits on top of anything reaching the edge
  ctx.fillStyle = fill;
  roundRect(ctx, -hl, -hw, L, W, C.CHASSIS_CORNER);
  ctx.fill();

  // the FRAME: an inset rail line, which is what a top-down extrusion perimeter actually
  // looks like. One thin stroke — enough to say "this is a built frame, not a tile".
  ctx.strokeStyle = 'rgba(190,205,220,0.16)';
  ctx.lineWidth = 0.32;
  roundRect(ctx, -hl + 1.15, -hw + 1.15, L - 2.3, W - 2.3, 1.0);
  ctx.stroke();
}

/**
 * Draw a robot's DRIVETRAIN wheels in the chassis-local frame (already translated +
 * rotated to the robot). BIOBUZZ's own copy — DECODE draws its own wheels inside its frozen
 * sprite. Mecanum/tank point forward, SWERVE pods steer to `moduleAngles`, X-drive omnis sit
 * at ±45° (an X), and butterfly shows the set that is currently on the floor.
 */
export function drawWheels(ctx: CanvasRenderingContext2D, r: RobotState, color: string, accent: string): void {
  // [FL, FR, BL, BR] — `wheelLocals`, the list the sim steers `moduleAngles` against
  const corners = wheelLocals(r.spec).map((w) => [w.x, w.y] as const);
  /**
   * ONE WHEEL, drawn as the wheel it actually is. `kind` picks the tread, which is the only
   * thing that distinguishes these from above and is exactly what the drivetrain choice buys:
   *  • traction — a rubber tyre with tread bars ACROSS the roll direction (grip, no strafe)
   *  • mecanum  — barrel rollers at 45 degrees (see drawMecanumRollers)
   *  • omni     — barrel rollers ACROSS the tyre, in a row: rolls freely sideways
   *
   * The tyre's own fill DEFAULTS to the cosmetic `accent` (closure); tread/barrel overlays keep
   * their own structural tone but TINTED toward the accent — see `docs/cosmetics-plan.md` §3.4.
   */
  const drawWheel = (
    px: number,
    py: number,
    ang: number,
    kind: 'traction' | 'omni' | 'plain' = 'plain',
    len = 4.4,
    wid = 2.2,
    fill = accent,
  ): void => {
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(ang);
    // tyre
    ctx.fillStyle = fill;
    roundRect(ctx, -len / 2, -wid / 2, len, wid, wid * 0.26);
    ctx.fill();
    ctx.strokeStyle = 'rgba(190,205,220,0.40)';
    ctx.lineWidth = 0.35;
    ctx.stroke();

    ctx.save();
    roundRect(ctx, -len / 2, -wid / 2, len, wid, wid * 0.26);
    ctx.clip(); // tread never bleeds past the rim
    if (kind === 'traction') {
      // tread bars across the roll direction — what gives a traction wheel its grip
      ctx.strokeStyle = tintColor('#cddae8', accent, 0.35, 0.3);
      ctx.lineWidth = 0.3;
      for (let o = -len / 2 + 0.55; o < len / 2; o += 0.9) {
        ctx.beginPath();
        ctx.moveTo(o, -wid / 2);
        ctx.lineTo(o, wid / 2);
        ctx.stroke();
      }
    } else if (kind === 'omni') {
      // the barrels: short rollers set across the tyre, which is what lets an omni slide
      // sideways at all. Drawn as discrete capsules, not a hatch — you can count them.
      ctx.fillStyle = tintColor('#cddae8', accent, 0.35, 0.34);
      for (let o = -len / 2 + 0.62; o < len / 2; o += 1.05) {
        roundRect(ctx, o - 0.26, -wid / 2 + 0.22, 0.52, wid - 0.44, 0.26);
        ctx.fill();
      }
    }
    ctx.restore();

    // hub + axle — a wheel from above is a rectangle, so without this it reads as a block,
    // and the hub gives the eye something to track when the robot spins
    ctx.fillStyle = 'rgba(190,205,220,0.34)';
    ctx.beginPath();
    ctx.arc(0, 0, Math.min(wid * 0.26, 0.62), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };
  /**
   * MECANUM ROLLERS. A mecanum wheel's rollers sit at 45 degrees to the wheel axis, and the
   * four wheels ALTERNATE by diagonal — FL and BR one way, FR and BL the other — so from above
   * the roller lines form an X. That alternation is not decoration: it is what lets the four
   * wheels' lateral force components add up instead of cancelling, i.e. what makes the drive
   * able to strafe at all. Drawing all four the same way is the classic mecanum render
   * mistake, and it depicts a robot that physically could not strafe.
   * `corners` is [FL, FR, BL, BR] with +x forward and +y left, so the sign of px*py separates
   * the two diagonals exactly (the same test the X-drive branch uses).
   */
  const drawMecanumRollers = (px: number, py: number, len = 4.4, wid = 2.2): void => {
    const s = px * py >= 0 ? 1 : -1; // FL/BR -> "/", FR/BL -> "\\"
    ctx.save();
    ctx.translate(px, py);
    ctx.beginPath();
    ctx.rect(-len / 2, -wid / 2, len, wid);
    ctx.clip(); // the hatch is the wheel's tread — never let it bleed past the rim
    ctx.strokeStyle = tintColor('#c8d6e6', accent, 0.35, 0.55);
    ctx.lineWidth = 0.34;
    const span = len + wid;
    for (let o = -span / 2; o <= span / 2; o += 1.15) {
      ctx.beginPath();
      ctx.moveTo(o - wid / 2, (-s * wid) / 2);
      ctx.lineTo(o + wid / 2, (s * wid) / 2);
      ctx.stroke();
    }
    ctx.restore();
  };

  if (r.spec.drivetrain === 'swerve') {
    // each of the four pods renders at its OWN angle — they visibly swivel + wobble
    corners.forEach(([px, py], i) => {
      const ang = r.moduleAngles[i] ?? 0;
      // steering module housing
      ctx.save();
      ctx.translate(px, py);
      ctx.fillStyle = '#0c1016';
      ctx.fillRect(-2.6, -2.6, 5.2, 5.2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 0.4;
      ctx.strokeRect(-2.6, -2.6, 5.2, 5.2);
      ctx.restore();
      drawWheel(px, py, ang, 'traction', 4.2, 1.8, accent);
      // a tick showing which way this pod points
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(ang);
      ctx.strokeStyle = color;
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(2.4, 0);
      ctx.stroke();
      ctx.restore();
    });
  } else if (r.spec.drivetrain === 'xdrive') {
    // Omni wheels canted 45°, each one lying ACROSS its corner rather than along it, so the four
    // of them read as the four sides of a DIAMOND.
    //
    // ⚠️ **THIS COPY NEVER GOT THE FIX THE OTHER TWO DID** (found 2026-09-21, doing the wheels).
    // It drew them RADIALLY — `+45°` on the main diagonal is the direction that POINTS AT THE
    // CENTRE — and stretched them to `reach * 1.15` so the resulting X would read. DECODE's
    // `src/render/drawRobot.ts` and Chain Reaction's `src/games/chain/parts.ts` both carry the
    // correction and the reason: a wheel whose force line passes through the centre of mass has
    // no moment arm about it, so four radial omnis could translate and could never yaw. That is
    // not the drive this sim models, and BIOBUZZ — the one game with a 3D view to disagree with —
    // was the one still drawing it. The 3D scene cants by `x * sy >= 0 ? −45° : +45°`; this is now
    // the same expression, and the same 4.4 × 2.2 as every other wheel here (an omni is not a
    // longer wheel; the stretch existed only to prop up the old X).
    for (const [px, py] of corners)
      drawWheel(px, py, px * py >= 0 ? -Math.PI / 4 : Math.PI / 4, 'omni', 4.4, 2.2, accent);
  } else if (r.spec.drivetrain === 'butterfly') {
    // BUTTERFLY: draw the set that is actually DOWN, and show the other one STOWED. The
    // deployed wheels are full-size and lit; the stowed set is a thin dim bar tucked just
    // inboard of them — so a glance tells you whether you have strafe or push right now.
    const tank = r.butterflyTank;
    for (const [px, py] of corners) {
      // stowed set: a slim inboard bar (lifted off the floor, so it reads as inert)
      ctx.save();
      ctx.translate(px - Math.sign(px) * 1.5, py);
      ctx.fillStyle = 'rgba(120,134,150,0.32)';
      ctx.fillRect(-1.7, -0.7, 3.4, 1.4);
      ctx.restore();
      // deployed set: traction wheels read SOLID, the mecanum set gets the real
      // alternating 45° roller hatch (same helper the mecanum drivetrain uses)
      drawWheel(px, py, 0, tank ? 'traction' : 'plain', undefined, undefined, accent);
      if (!tank) drawMecanumRollers(px, py);
    }
  } else {
    for (const [px, py] of corners) {
      // TANK runs traction wheels (tread, no strafe); mecanum's tread is its 45 degree rollers
      drawWheel(px, py, 0, r.spec.drivetrain === 'tank' ? 'traction' : 'plain');
      // MECANUM is the only remaining drivetrain with rollers; tank's traction wheels
      // stay plain, which is now a meaningful visual difference rather than an accident.
      if (r.spec.drivetrain === 'mecanum') drawMecanumRollers(px, py);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BOX TUBE — the stowed tower's plan, which both 2D renderers draw
// ─────────────────────────────────────────────────────────────────────────────

/** the placement-point marker's ring radius (in) — both renderers */
export const BB_PLACE_MARK_R = 1.0;

/**
 * THE BOX TUBE AS SEEN FROM ABOVE — the stowed tower (`config.ts`'s "THE BOX TUBE" block), as the
 * boxes the 3D meshes and the collider are built from, plus its plan bounding rectangle.
 *
 * `outer` is the mast axis, `ux`/`uy` the tower's outward axis (aimed at `toward`, the placement
 * point), and `cx`/`cy`/`len`/`w` the rectangle that holds every stowed part, `len` along u —
 * which is what the held-element layout keeps its discs off. `center` is not a tube mount; it
 * reads as the front edge.
 */
export function bbBoxTubeGlyph(
  spec: Pick<RobotSpec, 'length' | 'width'>,
  mount: BbMountPos,
  toward?: { x: number; y: number } | null,
): {
  cx: number;
  cy: number;
  ux: number;
  uy: number;
  len: number;
  w: number;
  outer: { x: number; y: number };
  frame: BbBoxTubeFrame;
  boxes: BbTowerBox[];
} {
  const frame = bbBoxTubeFrame(spec, mount, toward ?? null);
  const stages = bbBoxTubeStages(frame.placeDist);
  const boxes = bbBoxTubeStowedBoxes(frame, stages);
  const u0 = Math.min(...boxes.map((b) => b.u0));
  const u1 = Math.max(...boxes.map((b) => b.u1));
  const v0 = Math.min(...boxes.map((b) => b.v0));
  const v1 = Math.max(...boxes.map((b) => b.v1));
  const um = (u0 + u1) / 2;
  const vm = (v0 + v1) / 2;
  return {
    cx: frame.outer.x + um * frame.ux + vm * frame.vx,
    cy: frame.outer.y + um * frame.uy + vm * frame.vy,
    ux: frame.ux,
    uy: frame.uy,
    len: u1 - u0,
    w: v1 - v0,
    outer: frame.outer,
    frame,
    boxes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// WHAT STANDS ON THE CHASSIS — so the chassis dressing gives way to it
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ONE MECHANISM'S FOOTPRINT ON THE CHASSIS, in the robot frame: a disc (`r`) or an axis-aligned
 * box (`hx`, `hy`) about (`cx`, `cy`), standing over the height band [`z0`, `z1`].
 */
export interface BbKeepOut {
  what: 'turretRing' | 'turretHead' | 'dumper' | 'tube' | 'intakeArm';
  cx: number;
  cy: number;
  r?: number;
  hx?: number;
  hy?: number;
  z0: number;
  z1: number;
}

/** the dumper's two shaft posts (`renderRobots.ts`'s `buildDumper`): their side, and how far
 * under `BB_LAUNCH_Z0` the shaft they carry sits (in) */
const DUMPER_POST = 0.6;
const DUMPER_SHAFT_DROP = 2.3;

/** a DUMPER's mounted edge as a unit vector in the robot frame (no trig: the four are exact) */
const EDGE_DIR: Record<'front' | 'back' | 'left' | 'right', { x: number; y: number }> = {
  front: { x: 1, y: 0 },
  back: { x: -1, y: 0 },
  left: { x: 0, y: 1 },
  right: { x: 0, y: -1 },
};

/**
 * ⚠️ **EVERY MECHANISM'S FOOTPRINT, SO NOTHING DECORATIVE IS DRAWN THROUGH ONE** (owner,
 * 2026-09-28: "The robot itself has a lot of overlapping parts"). The end bars, the deck arrow
 * and the side plates' top caps are chassis DRESSING: none is a collider and none is hardware a
 * mechanism bolts through. Measured over 2,381 builds (every launcher on every mount × every
 * intake × every Box Tube cell), a turret on any front- or back-row cell ran its ring and head
 * through the end bar on 1,080 of them and an edge or corner ring cut the top cap on 1,297; a
 * centre turret sat on the deck arrow on 1,190. The dressing reads this list and yields.
 *
 * The numbers are the mechanisms' OWN: a turret is its fixed ring (`turretRadius`, drawn to
 * `BB_TURRET_RING_H`) and, above it, the disc its head sweeps as it aims (`BB3_TURRET_R` /
 * `BB3_NECTAR_TURRET_R`, measured off the built heads); a dumper is the box `bbMechEnvelopes` gives
 * it; a Box Tube is its stowed tower boxes. Empty for a spec that says nothing about mechanisms.
 */
export function bbChassisKeepOuts(spec: Pick<RobotSpec, 'length' | 'width'> & Partial<RobotSpec>): BbKeepOut[] {
  if (!spec.bbMech && spec.scoreMode === undefined) return [];
  const full = spec as RobotSpec;
  const out: BbKeepOut[] = [];
  const launcher = bbLauncherOf(full, 0);
  if (bbIsTurreted(launcher)) {
    const heads: [BbMountPos, number, number][] = [[launcher.mount, BB3_TURRET_R, BB3_TURRET_TOP_Z]];
    if (launcher.kind === 'twinturret' && launcher.mount2) heads.push([launcher.mount2, BB3_NECTAR_TURRET_R, BB3_NECTAR_TURRET_TOP_Z]);
    const ring = turretRadius(spec);
    for (const [mount, sweep, top] of heads) {
      const c = turretLocal(spec, mount);
      out.push({ what: 'turretRing', cx: c.x, cy: c.y, r: ring, z0: BB_DECK_Z, z1: BB_DECK_Z + BB_TURRET_RING_H });
      out.push({ what: 'turretHead', cx: c.x, cy: c.y, r: sweep, z0: BB_DECK_Z + BB_TURRET_RING_H, z1: top });
    }
  } else if (launcher.kind === 'fixed') {
    // a FIXED shooter: the turret's head on a riser where the ring would be, facing one way — its
    // keep-out is the disc a turret head at that cell would sweep, a safe over-approximation
    const c = turretLocal(spec, launcher.mount);
    out.push({ what: 'turretRing', cx: c.x, cy: c.y, r: turretRadius(spec), z0: BB_DECK_Z, z1: BB_DECK_Z + BB_TURRET_RING_H });
    out.push({ what: 'turretHead', cx: c.x, cy: c.y, r: BB3_TURRET_R, z0: BB_DECK_Z + BB_TURRET_RING_H, z1: BB3_TURRET_TOP_Z });
  } else if (launcher.kind === 'dumper') {
    // Only the dumper's two POSTS reach the deck (`buildDumper`: 0.6-in square, at the pivot, just
    // inside each end of the shaft). The bucket hangs off the shaft at `BB_LAUNCH_Z0 − 2.3` and its
    // lowest point is over 6 in up — above the caps, the arrow and the end bars.
    const edge = bbShooterEdgeOf({ shooterMount: launcher.mount });
    const { dist, span } = edgeGeom(spec, edge);
    const pivot = dist - Math.min(BB3_DUMPER_PIVOT_BACK, dist * BB3_DUMPER_PIVOT_FRAC);
    const v = span * BB3_DUMPER_SPAN_FRAC - DUMPER_POST / 2;
    const d = EDGE_DIR[edge];
    for (const s of [1, -1] as const) {
      out.push({
        what: 'dumper',
        cx: d.x * pivot - d.y * s * v,
        cy: d.y * pivot + d.x * s * v,
        hx: DUMPER_POST / 2,
        hy: DUMPER_POST / 2,
        z0: BB_DECK_Z,
        z1: BB_LAUNCH_Z0 - DUMPER_SHAFT_DROP,
      });
    }
  }
  const lift = spec.bbMech?.lift && spec.intake !== undefined ? bbLiftOf(full) : null;
  if (lift) {
    const g = bbBoxTubeGlyph(spec, lift.mount, bbLiftPlaceLocal(full));
    for (const b of g.boxes) {
      const r = bbTowerBoxRobot(g.frame, b);
      out.push({ what: 'tube', cx: (r.x0 + r.x1) / 2, cy: (r.y0 + r.y1) / 2, hx: (r.x1 - r.x0) / 2, hy: (r.y1 - r.y0) / 2, z0: r.z0, z1: r.z1 });
    }
  }
  return out;
}

/**
 * THE SPANS OF A RAIL THAT A KEEP-OUT STANDS ON, merged and sorted. The rail runs `along` one axis
 * (`'y'` for an end bar, `'x'` for a side plate's top cap), sits across the other in `band`, and
 * occupies `zBand`; a keep-out only takes a span of it when their heights overlap. Padded by `pad`
 * each side, so the two never touch face to face either.
 */
export function bbRailGaps(
  keep: readonly BbKeepOut[],
  along: 'x' | 'y',
  band: readonly [number, number],
  zBand: readonly [number, number],
  pad = 0.1,
): { a0: number; a1: number }[] {
  const gaps: { a0: number; a1: number }[] = [];
  for (const k of keep) {
    if (k.z0 >= zBand[1] || k.z1 <= zBand[0]) continue;
    const across = along === 'y' ? k.cx : k.cy;
    const at = along === 'y' ? k.cy : k.cx;
    if (k.r !== undefined) {
      const d = across < band[0] ? band[0] - across : across > band[1] ? across - band[1] : 0;
      if (d >= k.r) continue;
      const half = Math.sqrt(k.r * k.r - d * d);
      gaps.push({ a0: at - half - pad, a1: at + half + pad });
    } else {
      const hAcross = along === 'y' ? k.hx! : k.hy!;
      const hAlong = along === 'y' ? k.hy! : k.hx!;
      if (across + hAcross <= band[0] || across - hAcross >= band[1]) continue;
      gaps.push({ a0: at - hAlong - pad, a1: at + hAlong + pad });
    }
  }
  gaps.sort((p, q) => p.a0 - q.a0);
  const merged: { a0: number; a1: number }[] = [];
  for (const g of gaps) {
    const last = merged[merged.length - 1];
    if (last && g.a0 <= last.a1) last.a1 = Math.max(last.a1, g.a1);
    else merged.push({ ...g });
  }
  return merged;
}

/** what is left of a rail `[lo, hi]` once its gaps are taken out; a piece under 0.2 in is dropped */
export function bbRailSegments(lo: number, hi: number, gaps: readonly { a0: number; a1: number }[]): { a0: number; a1: number }[] {
  const out: { a0: number; a1: number }[] = [];
  let at = lo;
  for (const g of gaps) {
    if (g.a1 <= at) continue;
    if (g.a0 >= hi) break;
    if (g.a0 - at > 0.2) out.push({ a0: at, a1: g.a0 });
    at = Math.max(at, g.a1);
  }
  if (hi - at > 0.2) out.push({ a0: at, a1: hi });
  return out;
}

/** one drawn piece of an end bar: its span in y and its height above the deck */
export interface BbBarPiece {
  y0: number;
  y1: number;
  h: number;
}

/** an end bar's drawn pieces along y (`bbFrontMarks`). The 2D sprite fills their spans; 3D also
 * reads each piece's height. */
export function bbEndBarSegments(bar: { pieces: readonly BbBarPiece[] }): BbBarPiece[] {
  return [...bar.pieces];
}

/** the lowest an end bar is drawn where it runs under a mechanism rather than stopping (in) */
const BAR_LOW_MIN = 0.3;

/**
 * AN END BAR OVER `[x0, x1]`, LESS WHAT STANDS ON IT. Where a mechanism reaches down to the deck
 * (a turret's fixed ring, a Box Tube's pivot plates) the bar STOPS; where one only passes OVER it
 * (a turret's head, whose underside is `BB_TURRET_RING_H` above the deck) the bar runs on LOWER,
 * just under it — so a front turret on a narrow chassis, whose head sweeps the whole front edge,
 * still leaves a light bar across the front rather than none.
 */
export function bbEndBarPieces(keep: readonly BbKeepOut[], x0: number, x1: number, halfY: number): BbBarPiece[] {
  const band: [number, number] = [x0, x1];
  const zBand: [number, number] = [BB_DECK_Z, BB_DECK_Z + BB_END_BAR_H];
  const hard = keep.filter((k) => k.z0 < BB_DECK_Z + BAR_LOW_MIN + 0.05);
  const low = keep.filter((k) => k.z0 >= BB_DECK_Z + BAR_LOW_MIN + 0.05);
  const segs = bbRailSegments(-halfY, halfY, bbRailGaps(hard, 'y', band, zBand));
  const caps = low.flatMap((k) => bbRailGaps([k], 'y', band, zBand).map((g) => ({ ...g, h: Math.min(BB_END_BAR_H, k.z0 - BB_DECK_Z - 0.05) })));
  const out: BbBarPiece[] = [];
  for (const s of segs) {
    const cuts = [s.a0, s.a1, ...caps.flatMap((c) => [c.a0, c.a1]).filter((v) => v > s.a0 && v < s.a1)].sort((p, q) => p - q);
    for (let i = 0; i + 1 < cuts.length; i++) {
      const y0 = cuts[i];
      const y1 = cuts[i + 1];
      if (y1 - y0 < 1e-6) continue;
      const mid = (y0 + y1) / 2;
      const h = caps.reduce((m, c) => (mid > c.a0 && mid < c.a1 ? Math.min(m, c.h) : m), BB_END_BAR_H);
      const last = out[out.length - 1];
      if (last && Math.abs(last.y1 - y0) < 1e-9 && Math.abs(last.h - h) < 1e-9) last.y1 = y1;
      else out.push({ y0, y1, h });
    }
  }
  return out;
}

/**
 * THE DECK ARROW'S PLACE: the biggest arrow, nearest the rear rail and the centreline, that stands
 * clear of every mechanism's footprint at deck height (`bbChassisKeepOuts`, padded
 * `ARROW_CLEAR`). It used to be one fixed triangle tucked against the rear bar, which a centre
 * turret's ring sat on (1,190 of the 2,381 builds swept), and a back-row turret or a side dumper
 * covered outright. `null` when no size fits anywhere on the deck — the light bar is then the
 * whole front language, which it was designed to carry alone.
 */
const ARROW_CLEAR = 0.2;
function placeArrow(
  spec: Pick<RobotSpec, 'length' | 'width'>,
  keep: readonly BbKeepOut[],
  halfY: number,
): { apex: number; base: number; half: number; cy: number } | null {
  const hl = spec.length / 2;
  const deckTop = BB_DECK_Z + 0.02 + BB_FRONT_ARROW_T;
  const low = keep.filter((k) => k.z0 < deckTop);
  const xMin = -hl + BB_END_BAR_T + BB_FRONT_ARROW_GAP;
  const xMax = hl - BB_END_BAR_T - BB_FRONT_ARROW_GAP;
  const yLim = halfY;
  const clear = (px: number, py: number): boolean =>
    low.every((k) =>
      k.r !== undefined
        ? (px - k.cx) * (px - k.cx) + (py - k.cy) * (py - k.cy) >= (k.r + ARROW_CLEAR) * (k.r + ARROW_CLEAR)
        : Math.abs(px - k.cx) >= k.hx! + ARROW_CLEAR || Math.abs(py - k.cy) >= k.hy! + ARROW_CLEAR,
    );
  // the triangle, sampled: its three edges and a lattice inside it
  const fits = (base: number, len: number, half: number, cy: number): boolean => {
    if (base < xMin - 1e-9 || base + len > xMax + 1e-9 || Math.abs(cy) + half > yLim + 1e-9) return false;
    const N = 10;
    for (let i = 0; i <= N; i++) {
      const f = i / N;
      // along the two slanted edges and the base
      if (!clear(base + len * f, cy + half * (1 - f)) || !clear(base + len * f, cy - half * (1 - f)) || !clear(base, cy + half * (2 * f - 1))) return false;
      for (let j = 1; j < N - i; j++) {
        const x = base + len * f;
        const w = half * (1 - f);
        if (!clear(x, cy + w * ((2 * j) / (N - i) - 1))) return false;
      }
    }
    return true;
  };
  // ON THE CENTRELINE FIRST, shrinking in 5 % steps and then moving forward: an arrow off to one
  // side reads as an accident. Only when no centred size fits anywhere does it slide sideways.
  const sizes: [number, number][] = [];
  for (let f = 1; f >= 0.55 - 1e-9; f -= 0.05) sizes.push([BB_FRONT_ARROW_LEN * f, Math.min(BB_FRONT_ARROW_HALF * f, yLim)]);
  for (const sideways of [false, true]) {
    for (const [len, h] of sizes) {
      if (h < 0.8) continue;
      // nearest the rear rail first (then, sideways, nearest the centreline); the first fit wins
      const cands: { base: number; cy: number; score: number }[] = [];
      for (let base = xMin; base + len <= xMax + 1e-9; base += 0.25) {
        if (!sideways) {
          cands.push({ base, cy: 0, score: base - xMin });
          continue;
        }
        for (let cy = 0.25; cy <= yLim - h + 1e-9; cy += 0.25) for (const s of [1, -1]) cands.push({ base, cy: s * cy, score: base - xMin + 2 * cy });
      }
      cands.sort((p, q) => p.score - q.score || q.cy - p.cy);
      for (const c of cands) if (fits(c.base, len, h, c.cy)) return { apex: c.base + len, base: c.base, half: h, cy: c.cy };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// WHICH END IS THE FRONT — the one language, read by BOTH renderers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ **A SYMMETRIC ROBOT HAS NO FRONT, AND THE PICTURE HAS TO GIVE IT ONE** (owner, 2026-09-22:
 * "somehow make it clearer fundamentally which side is front and which is back in game. This is
 * especially confusing in a symmetric robot in 3D").
 *
 * What was there: 2D drew a small chevron at the rear in the ALLIANCE colour, and 3D drew a
 * 0.7 × 22%-width white block on the front cross member. Both fail the case that prompted this —
 * a `frontback` sweeper with a `center` turret is mirror-symmetric, so the only asymmetric thing
 * on it was a 0.7-in block that is invisible at match camera distance and behind the intake from
 * the one angle you would look for it. The 2D chevron had the second problem: it was drawn in the
 * alliance colour, so "red at that end" competed with "red team" for the same cue.
 *
 * ── THE LANGUAGE ────────────────────────────────────────────────────────────
 * The FRONT is marked and the back is not. Two marks, the same two in both renderers, neither in
 * an alliance colour:
 *  1. a **LIGHT BAR** across the FULL front edge, near-white (`BB_FRONT_INK`) — headlights, the
 *     most-read "this end goes first" signal there is, and full-width so it survives being
 *     partly occluded by whatever is mounted up front;
 *  2. a **CHEVRON** on the deck pointing forward, in the same near-white, sitting just ahead of
 *     the rear rail where no mechanism is ever drawn (the front third belongs to the intake and
 *     the turret; an arrow there is under something on half the builds).
 * The REAR takes a plain bar in the chassis' own structural dark (`BB_REAR_INK`) — a rail, not a
 * marking. It is there so the arrow has something to point away from.
 *
 * ⚠️ **NO HAZARD STRIPES** (owner, 2026-09-22: "what is this ugly ass yellow and black beams
 * rendered in 3D? It is awful and does not fit FTC"). The first pass gave the rear amber ribs on
 * near-black, on the reasoning that the back of a truck is the most-read "this is the back"
 * language there is. It is — on a truck. On an FTC robot it reads as construction tape, it is the
 * loudest thing on the field, and it competes with a POLLEN's own yellow. The front language
 * carries the whole job on its own: a bright bar at one end and structure at the other.
 *
 * Colours are CATEGORY 3 (CLAUDE.md THEMING: the ground is the canvas and the field is hardcoded
 * dark), so neither themes.
 *
 * ── IT FOLLOWS THE SIM'S FRONT, NOT THE DRIVER'S "REVERSED" ─────────────────
 * Flip-front is an INPUT transform (`GameController`); it rotates the stick, never `r.heading`,
 * and the HUD already says REVERSED. The mark stays on the sim's +x for three reasons: the sim's
 * front is what the intake, the shooter and every collider are measured from, so a mark that
 * moved would disagree with the hardware it is drawn next to; a match has four other people
 * looking at the same robot (and a replay has any number), and only one of them pressed the
 * button; and in 3D the robot is ONE group in a shared scene graph — there is no per-viewer
 * variant of a mesh. REVERSED is a property of a driver's stick, not of the machine.
 */
export const BB_FRONT_INK = '#f8fafc';
/** the rear rail's own tone — `renderRobots.ts`'s `ALU_DK`, i.e. the colour the rest of the
 *  chassis structure is already drawn in. NOT a marking colour, on purpose. */
export const BB_REAR_INK = '#39414f';
/** bar thickness along the robot's own x (in), and how far in from each rail the bars stop so
 *  they never fight `C.CHASSIS_CORNER`'s rounding. DRAWING sizes. */
export const BB_END_BAR_T = 0.9;
export const BB_END_BAR_INSET = 1.0;
/** the deck chevron (in): how far ahead of the rear bar its base sits, its length and its
 *  half-width. Sized to read at the ~8 px/in the match camera gives a 2D sprite — and kept SHORT
 *  and WIDE, tucked against the rear bar, because a `center` turret's ring covers the middle of
 *  the deck on every chassis and a longer arrow disappeared under it in the first captures. */
export const BB_FRONT_ARROW_GAP = 0.6;
export const BB_FRONT_ARROW_LEN = 2.8;
export const BB_FRONT_ARROW_HALF = 3.0;
/** 3D ONLY: how far the two end bars stand above the deck, and how thick the extruded deck arrow
 *  is (in). The bars are deliberately TALL enough to break the chassis silhouette from a chase
 *  camera — flush with the deck they were invisible from behind, which is the view a driver
 *  spends the match in. 1.8 puts the top at 6.4, clear of the 5.3 (`BB3_CHASSIS_TOP_Z`) the whole
 *  LOW BODY is drawn under, so a sweeper roller at either end cannot hide the mark on that end —
 *  measured from offscreen captures, 1.1 sat inside the roller's own envelope and a `frontback`
 *  build, which is the symmetric case the report is about, hid BOTH marks from a chase camera.
 *  Neither is a collider; see `buildFrontMarks`. */
export const BB_END_BAR_H = 1.8;
export const BB_FRONT_ARROW_T = 0.12;

/**
 * The three marks in the ROBOT frame (+x forward), as plain numbers — no canvas, no three.js.
 * ONE derivation, so the 2D sprite and the 3D chassis cannot drift apart about which end is
 * which, the same bargain `bbBoxTubeGlyph` already makes for the tube.
 *
 * `front`/`rear` are bars `[x0, x1] × [−halfY, halfY]` less their `gaps` (`bbEndBarSegments`);
 * `arrow` is the chevron — apex `(apex, cy)`, base corners `(base, cy ± half)` — or `null` when no
 * spot on the deck is clear of the mechanisms (`placeArrow`).
 *
 * CACHED per build: the 2D sprite asks every frame, and the arrow's placement is a search.
 */
export interface BbFrontMarks {
  front: { x0: number; x1: number; halfY: number; pieces: BbBarPiece[] };
  rear: { x0: number; x1: number; halfY: number; pieces: BbBarPiece[] };
  arrow: { apex: number; base: number; half: number; cy: number } | null;
}
const FRONT_MARKS_CACHE = new Map<string, BbFrontMarks>();
export function bbFrontMarks(spec: Pick<RobotSpec, 'length' | 'width'> & Partial<RobotSpec>): BbFrontMarks {
  const key = JSON.stringify([spec.length, spec.width, spec.bbMech ?? null, spec.scoreMode ?? null, spec.shooterMount ?? null, spec.shooterRear ?? null, spec.intake ?? null, spec.intakeMount ?? null]);
  const hit = FRONT_MARKS_CACHE.get(key);
  if (hit) return hit;
  const hl = spec.length / 2;
  const halfY = Math.max(0.5, spec.width / 2 - BB_END_BAR_INSET);
  const keep = bbChassisKeepOuts(spec);
  const marks: BbFrontMarks = {
    front: { x0: hl - BB_END_BAR_T, x1: hl, halfY, pieces: bbEndBarPieces(keep, hl - BB_END_BAR_T, hl, halfY) },
    rear: { x0: -hl, x1: -hl + BB_END_BAR_T, halfY, pieces: bbEndBarPieces(keep, -hl, -hl + BB_END_BAR_T, halfY) },
    arrow: placeArrow(spec, keep, halfY),
  };
  if (FRONT_MARKS_CACHE.size > 256) FRONT_MARKS_CACHE.clear();
  FRONT_MARKS_CACHE.set(key, marks);
  return marks;
}
