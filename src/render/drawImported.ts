import type { ImportedRobot, RobotState, Vec2 } from '../types';
import * as C from '../config';
import { importedWheels, polyBounds, polyCentroid, polyGrow, polyPointDepth } from '../sim/imported';
import { importedTopFrame, importedTopImage, topImageTransform } from './importedAssets';
import { drawDecal, roundRect, strokeInside, tintColor } from './drawRobot';
import { clampCosmetics } from '../cosmetics';

/**
 * AN IMPORTED ROBOT, TOP-DOWN — the parts every game's 2D sprite shares (`docs/robot-import-plan.md`
 * §1 "In a match"). Each game's own `drawRobot` calls these for an imported spec and then draws
 * ITS dynamic layer (intake state, turret aim, held elements, hopper, alliance mark) from its own
 * accessors on top, so a driver reads an import's state the way they read a standard robot's.
 *
 * ── THE BODY IS THE HULL ────────────────────────────────────────────────────────────────────
 * Everything here is in the robot frame (the caller has translated and rotated) and inside a clip
 * to `ImportedRobot.hull` — the polygon the collider, the start rules and the zone fouls use. That
 * is the standard sprites' own rule ("THE SPRITE CANNOT EXCEED THE COLLISION BOX", DECODE's
 * `drawRobot`) with the box replaced by the shape the import really collides with.
 *
 * ── TWO WAYS TO DRAW IT ─────────────────────────────────────────────────────────────────────
 *  - PICTURED: this device has the import's top-down PNG (`importedTopImage`) — the owner's own
 *    robot, or any robot whose assets were lent to `importedAssets`. The picture already shows the
 *    hardware, so the caller draws STATE only on top of it (`drawMouthState`, `drawAimMark`), not a
 *    second robot.
 *  - SILHOUETTE: no picture (another player's robot before the mesh relay, the picture still
 *    decoding). The hull in the chassis colour, its frame line, the wheels at `importedWheels`; the
 *    caller then draws its game's own mechanism hardware where the accessors put it, so the build
 *    reads the way a standard robot's does.
 * Both end with the neutral silhouette line on the hull (`drawImportedOutline`), drawn last inside
 * the clip for the reason the standard sprites draw theirs last.
 */

/** trace `hull` into the current path (no fill/stroke — the caller's job) */
export function traceHull(ctx: CanvasRenderingContext2D, hull: readonly Vec2[]): void {
  ctx.beginPath();
  hull.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
}

/** clip to the hull — the caller owns the surrounding `save`/`restore` */
export function clipToHull(ctx: CanvasRenderingContext2D, imp: ImportedRobot): void {
  traceHull(ctx, imp.hull);
  ctx.clip();
}

/**
 * The import's top-down picture in the robot frame, through `importedTopFrame` — the one map from
 * its pixels to inches. `ctx.drawImage` into the frame's own `px × px` box, so a picture written at
 * a different resolution still lands on the same inches.
 */
export function drawTopImage(ctx: CanvasRenderingContext2D, imp: ImportedRobot, img: CanvasImageSource): void {
  const f = importedTopFrame(imp.hull);
  ctx.save();
  ctx.transform(...topImageTransform(f));
  ctx.drawImage(img, 0, 0, f.px, f.px);
  ctx.restore();
}

export interface ImportedBodyOptions {
  /** the chassis fill (`chassisFill(spec.chassisColor)`) */
  fill: string;
  /** the cosmetic accent the tyres take (`accentFill`) */
  accent: string;
  /** a contact shadow under the silhouette (Chain/BIOBUZZ draw one; DECODE does not) */
  shadow?: boolean;
  /** draw the silhouette even when a picture is available (the builder's "collision" view) */
  silhouette?: boolean;
}

/**
 * THE BODY — the picture when this device has one, else the silhouette. Returns whether it drew
 * the PICTURE, which is what tells the caller to draw state only on top. Call inside the hull clip.
 */
export function drawImportedBody(ctx: CanvasRenderingContext2D, r: RobotState, o: ImportedBodyOptions): boolean {
  const imp = r.spec.imported;
  if (!imp) return false;
  const img = o.silhouette ? null : importedTopImage(imp.id, imp);
  if (img) {
    drawTopImage(ctx, imp, img);
    return true;
  }
  const hull = imp.hull;
  if (o.shadow) {
    ctx.save();
    ctx.translate(0.6, 0.9);
    ctx.fillStyle = 'rgba(0,0,0,0.30)';
    traceHull(ctx, hull);
    ctx.fill();
    ctx.restore();
  }
  ctx.fillStyle = o.fill;
  traceHull(ctx, hull);
  ctx.fill();
  // the DECAL, on the hull's bounding box (a decal is parametric in the footprint) — clipped to
  // the hull by the caller, like everything else on the body
  const cosm = clampCosmetics(r.spec);
  if (cosm.decal !== 'none') {
    const b = polyBounds(hull);
    ctx.save();
    ctx.translate((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
    drawDecal(ctx, (b.maxX - b.minX) / 2, (b.maxY - b.minY) / 2, cosm.decal, o.accent);
    ctx.restore();
  }
  // the FRAME: an inset rail line, the standard body's own (`drawChassisBody`)
  const inner = polyGrow(hull, -1.15);
  if (inner.length >= 3) {
    ctx.strokeStyle = 'rgba(190,205,220,0.16)';
    ctx.lineWidth = 0.32;
    traceHull(ctx, inner);
    ctx.stroke();
  }
  drawImportedWheels(ctx, r, o.accent);
  return false;
}

/** the silhouette line, NEUTRAL, inside the hull, drawn LAST inside the clip */
export function drawImportedOutline(ctx: CanvasRenderingContext2D, imp: ImportedRobot, trim: string): void {
  ctx.strokeStyle = trim;
  strokeInside(ctx, () => traceHull(ctx, imp.hull), C.CHASSIS_OUTLINE);
}

/**
 * THE WHEELS AT THE IMPORT'S OWN CONTACT POINTS (`importedWheels`, FL, FR, BL, BR — the order
 * `moduleAngles` is in). The standard sprites put them at the box corners; an import's wheelbase
 * is measured, so it is drawn where it was measured. Same reading as the standard wheels: mecanum
 * rollers alternate by diagonal (an X), X-drive omnis lie ACROSS their corner (a diamond), swerve
 * pods steer to `moduleAngles`, tank treads run across the roll direction.
 */
export function drawImportedWheels(ctx: CanvasRenderingContext2D, r: RobotState, accent: string): void {
  const imp = r.spec.imported;
  if (!imp) return;
  const pts = importedWheels(imp);
  // the diagonal a corner is on is read about the WHEELBASE centre, not the origin
  let mx = 0;
  let my = 0;
  for (const p of pts) {
    mx += p.x / pts.length;
    my += p.y / pts.length;
  }
  const dt = r.spec.drivetrain;
  pts.forEach((p, i) => {
    const diag = (p.x - mx) * (p.y - my) >= 0 ? 1 : -1; // FL/BR +1, FR/BL −1
    if (dt === 'swerve') {
      ctx.fillStyle = '#0c1016';
      ctx.fillRect(p.x - 2.6, p.y - 2.6, 5.2, 5.2);
      ctx.strokeStyle = 'rgba(154,163,173,0.9)';
      ctx.lineWidth = 0.4;
      ctx.strokeRect(p.x - 2.6, p.y - 2.6, 5.2, 5.2);
      wheel(ctx, p, r.moduleAngles[i] ?? 0, 4.2, 1.8, accent, 'traction');
      return;
    }
    if (dt === 'xdrive') {
      wheel(ctx, p, diag > 0 ? -Math.PI / 4 : Math.PI / 4, 4.4, 2.2, accent, 'omni');
      return;
    }
    if (dt === 'butterfly') {
      wheel(ctx, p, 0, 4.4, 2.2, accent, r.butterflyTank ? 'traction' : 'mecanum', diag);
      return;
    }
    wheel(ctx, p, 0, 4.4, 2.2, accent, dt === 'tank' ? 'traction' : dt === 'mecanum' ? 'mecanum' : 'plain', diag);
  });
}

function wheel(
  ctx: CanvasRenderingContext2D,
  p: Vec2,
  ang: number,
  len: number,
  wid: number,
  fill: string,
  kind: 'traction' | 'omni' | 'mecanum' | 'plain',
  diag = 1,
): void {
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(ang);
  ctx.fillStyle = fill;
  roundRect(ctx, -len / 2, -wid / 2, len, wid, wid * 0.26);
  ctx.fill();
  ctx.strokeStyle = 'rgba(190,205,220,0.40)';
  ctx.lineWidth = 0.35;
  ctx.stroke();
  ctx.save();
  roundRect(ctx, -len / 2, -wid / 2, len, wid, wid * 0.26);
  ctx.clip();
  if (kind === 'traction') {
    ctx.strokeStyle = tintColor('#cddae8', fill, 0.35, 0.3);
    ctx.lineWidth = 0.3;
    for (let o = -len / 2 + 0.55; o < len / 2; o += 0.9) {
      ctx.beginPath();
      ctx.moveTo(o, -wid / 2);
      ctx.lineTo(o, wid / 2);
      ctx.stroke();
    }
  } else if (kind === 'omni') {
    ctx.fillStyle = tintColor('#cddae8', fill, 0.35, 0.34);
    for (let o = -len / 2 + 0.62; o < len / 2; o += 1.05) {
      roundRect(ctx, o - 0.26, -wid / 2 + 0.22, 0.52, wid - 0.44, 0.26);
      ctx.fill();
    }
  } else if (kind === 'mecanum') {
    ctx.strokeStyle = tintColor('#c8d6e6', fill, 0.35, 0.55);
    ctx.lineWidth = 0.34;
    const span = len + wid;
    for (let o = -span / 2; o <= span / 2; o += 1.15) {
      ctx.beginPath();
      ctx.moveTo(o - wid / 2, (-diag * wid) / 2);
      ctx.lineTo(o + wid / 2, (diag * wid) / 2);
      ctx.stroke();
    }
  }
  ctx.restore();
  ctx.fillStyle = 'rgba(190,205,220,0.34)';
  ctx.beginPath();
  ctx.arc(0, 0, Math.min(wid * 0.26, 0.62), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** a robot-local rect on one edge — `bbMouths`' / `chainIntakeMouths`' shape */
export interface EdgeRect {
  edge: 'front' | 'back' | 'left' | 'right';
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/**
 * THE INTAKE'S STATE OVER A PICTURE: the grab area itself (the game's own mouth rects — the same
 * rects the capture test uses, so "where it grabs" is never a guess off the picture) as a faint
 * tray, and a LINE along its outer lip: green while it can collect, a light neutral while it
 * cannot. A line, never a fill over the part — the standard sprites' status rule.
 */
export function drawMouthState(ctx: CanvasRenderingContext2D, rects: readonly EdgeRect[], on: boolean): void {
  for (const m of rects) {
    ctx.fillStyle = on ? 'rgba(34,197,94,0.16)' : 'rgba(160,175,195,0.07)';
    ctx.fillRect(m.x0, m.y0, m.x1 - m.x0, m.y1 - m.y0);
    ctx.strokeStyle = on ? 'rgba(34,197,94,0.95)' : 'rgba(226,234,242,0.6)';
    ctx.lineWidth = 0.45;
    ctx.beginPath();
    const inset = 0.3;
    switch (m.edge) {
      case 'front':
        ctx.moveTo(m.x1 - inset, m.y0);
        ctx.lineTo(m.x1 - inset, m.y1);
        break;
      case 'back':
        ctx.moveTo(m.x0 + inset, m.y0);
        ctx.lineTo(m.x0 + inset, m.y1);
        break;
      case 'left':
        ctx.moveTo(m.x0, m.y1 - inset);
        ctx.lineTo(m.x1, m.y1 - inset);
        break;
      default:
        ctx.moveTo(m.x0, m.y0 + inset);
        ctx.lineTo(m.x1, m.y0 + inset);
    }
    ctx.stroke();
  }
}

/**
 * A TURRET'S AIM OVER A PICTURE — at the sim's own turret point, in whatever frame the caller has
 * set: a ring (green while it has something to fire) and a short tapered pointer along `heading`
 * to just past it. Deliberately slighter than a standard turret head, because the picture already
 * has the launcher in it; what the picture cannot show is where it is pointing NOW.
 */
export function drawAimMark(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  heading: number,
  ring: number,
  live: boolean,
  /** an alliance rim (a NECTAR turret), or null */
  rim: string | null = null,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = 'rgba(6,9,13,0.7)';
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  ctx.arc(0, 0, ring, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = rim ?? (live ? 'rgba(34,197,94,0.95)' : 'rgba(226,234,242,0.85)');
  ctx.lineWidth = rim ? 0.5 : 0.3;
  ctx.stroke();
  ctx.rotate(heading);
  const tip = ring + 1.4;
  ctx.fillStyle = 'rgba(226,234,242,0.92)';
  ctx.strokeStyle = 'rgba(6,9,13,0.75)';
  ctx.lineWidth = 0.18;
  ctx.beginPath();
  ctx.moveTo(tip, 0);
  ctx.lineTo(ring * 0.25, 0.55);
  ctx.lineTo(ring * 0.25, -0.55);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/**
 * The radius a ring centred at `p` can take and stay inside the hull with `margin` to spare,
 * clamped to [`min`, `max`] — the import's version of the standard turret's "sized so nothing
 * pokes past the chassis".
 */
export function ringInHull(imp: ImportedRobot, p: Vec2, min: number, max: number, margin = 0.5): number {
  const d = polyPointDepth(imp.hull, p) - margin;
  return Math.max(min, Math.min(max, d));
}

/**
 * THE ALLIANCE HEADING CHEVRON on an import (DECODE, Chain Reaction: the alliance is a FILL since
 * the outline went neutral). Centred `along` of the way from the hull's centroid to its front
 * (`along` > 0) or its back (< 0), pointing +x, sized to the room it has there.
 */
export function drawImportedChevron(ctx: CanvasRenderingContext2D, imp: ImportedRobot, color: string, along: number): void {
  const c = polyCentroid(imp.hull);
  const b = polyBounds(imp.hull);
  const end = along >= 0 ? b.maxX : b.minX;
  const mx = c.x + (end - c.x) * Math.abs(along);
  const room = polyPointDepth(imp.hull, { x: mx, y: c.y });
  const half = Math.max(0.8, Math.min(2.2, room * 0.6));
  const len = half * 1.36;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(mx + len / 2, c.y);
  ctx.lineTo(mx - len / 2, c.y + half);
  ctx.lineTo(mx - len / 2, c.y - half);
  ctx.closePath();
  ctx.fill();
}

/**
 * Where a hopper-fill BAR (`w` long, `h` deep, along x) fits inside the hull: centred on the
 * centroid's x, as far toward the LEFT flank as it fits with `clear` to spare — the standard Chain
 * sprite's spot (`hw − 2.6`), measured on the hull instead of the box. Shrinks the bar until it
 * fits; `null` when nothing does.
 */
export function hopperBarInHull(imp: ImportedRobot, w: number, h: number, clear = 0.4): { x: number; y: number; w: number } | null {
  const c = polyCentroid(imp.hull);
  const inside = (x: number, y: number, ww: number): boolean =>
    [
      { x: x, y },
      { x: x + ww, y },
      { x: x, y: y + h },
      { x: x + ww, y: y + h },
    ].every((p) => polyPointDepth(imp.hull, p) >= clear);
  for (let ww = w; ww >= 2; ww -= 0.5) {
    const x = c.x - ww / 2;
    for (let dy = 4; dy >= -4; dy -= 0.5) {
      const y = c.y + dy;
      if (inside(x, y, ww)) return { x, y, w: ww };
    }
  }
  return null;
}

/**
 * WHICH END IS THE FRONT, on an import — BIOBUZZ's language (`bbFrontMarks`): a near-white LIGHT
 * BAR along the hull edge(s) facing forward, and a near-white ARROW on the deck pointing at it.
 * Neither in an alliance colour. The bar runs on the INSIDE of the hull, so it is inside the clip.
 */
export function drawImportedFrontBack(
  ctx: CanvasRenderingContext2D,
  imp: ImportedRobot,
  ink: string,
  depth: number,
  /** turret rings the deck arrow must not sit under (robot frame) */
  avoid: readonly { x: number; y: number; r: number }[] = [],
): void {
  const hull = imp.hull;
  // the forward-facing edges: outward normal within 45° of +x, or the most forward one
  const edges: { a: Vec2; b: Vec2; nx: number; ny: number }[] = [];
  let best: (typeof edges)[number] | null = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const el = Math.hypot(ex, ey);
    if (el < 1e-6) continue;
    const e = { a, b, nx: ey / el, ny: -ex / el };
    if (!best || e.nx > best.nx) best = e;
    if (e.nx > Math.SQRT1_2) edges.push(e);
  }
  if (edges.length === 0 && best) edges.push(best);
  ctx.fillStyle = ink;
  for (const e of edges) {
    ctx.beginPath();
    ctx.moveTo(e.a.x, e.a.y);
    ctx.lineTo(e.b.x, e.b.y);
    ctx.lineTo(e.b.x - e.nx * depth, e.b.y - e.ny * depth);
    ctx.lineTo(e.a.x - e.nx * depth, e.a.y - e.ny * depth);
    ctx.closePath();
    ctx.fill();
  }
  // the deck ARROW, where the deck is clear of the turrets
  const a = frontArrowSpot(hull, avoid);
  ctx.beginPath();
  ctx.moveTo(a.x + a.len / 2, a.y);
  ctx.lineTo(a.x - a.len / 2, a.y + a.half);
  ctx.lineTo(a.x - a.len / 2, a.y - a.half);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(17,21,27,0.55)';
  ctx.lineWidth = 0.22;
  ctx.stroke();
}

/**
 * WHERE THE DECK ARROW GOES on an import: the hull's centroid, or — when a turret ring sits on it
 * (a centre turret is the common build) — the first spot straight ahead of it that clears every
 * ring in `avoid`, so the one mark that says which way the robot faces is never under a turret.
 * Sized to the room the hull has there. Shared by the sprites and `FootprintSvg`.
 */
export function frontArrowSpot(
  hull: readonly Vec2[],
  avoid: readonly { x: number; y: number; r: number }[] = [],
): { x: number; y: number; half: number; len: number } {
  const c = polyCentroid(hull);
  const front = polyBounds(hull).maxX;
  const size = (p: Vec2): { half: number; len: number } => {
    const half = Math.max(0.8, Math.min(1.8, polyPointDepth(hull, p) * 0.3));
    return { half, len: half * 1.6 };
  };
  for (let x = c.x; x <= front - 1; x += 0.25) {
    const p = { x, y: c.y };
    const s = size(p);
    const clear = avoid.every((o) => Math.hypot(p.x - o.x, p.y - o.y) >= o.r + s.len / 2 + 0.3);
    if (clear && polyPointDepth(hull, { x: x + s.len / 2, y: c.y }) > 0.4) return { ...p, ...s };
  }
  return { x: c.x, y: c.y, ...size(c) };
}
