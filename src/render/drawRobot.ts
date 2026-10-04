import type { Artifact, RobotState } from '../types';
import * as C from '../config';
import { footprintExtents } from '../sim/field';
import { turretWorldPos, wheelLocals } from '../sim/robot';
import { decodeFixedLauncher } from '../sim/fixedShot';
import { rot } from '../math';
import { accentFill, clampCosmetics } from '../cosmetics';
import {
  clipToHull,
  drawAimMark,
  drawImportedBody,
  drawImportedChevron,
  drawImportedOutline,
  drawMouthState,
  ringInHull,
  traceHull,
} from './drawImported';
import { decodeImportGrabRect, decodeImportMouth, decodeImportSolids } from '../sim/importedMech';

/**
 * ROBOT COSMETICS — 2D SHARED HELPERS (`docs/cosmetics-plan.md` §3.4). Used by all three 2D
 * sprites (DECODE here, CR/BIOBUZZ import them), so the halo, the decal shapes and the accent
 * tint are drawn identically everywhere instead of drifting per game.
 *
 * `RobotSpec.accent`/`decal`/`plate` are landing on a parallel lane (`src/types.ts`); read them
 * through `clampCosmetics`, which is shape-safe on a spec that does not declare them yet (every
 * field is optional, so an object missing them entirely is already a valid `Cosmetics`) — no cast
 * needed, and no renderer here has to wait on the type before drawing the fields it names.
 */

/**
 * THE ROBOT'S EDGE LINE — NEUTRAL, NOT THE ALLIANCE'S (owner, 2026-09-21: "Remove the red/blue
 * alliance outline. For multiplayer, display people's username in the color of their alliance").
 * Every STROKE on a sprite (the chassis silhouette, the wheels, the intake members) takes this;
 * the alliance now lives on the name label over the robot (`render/renderer.ts`), the sign
 * placard and the heading chevron, which are FILLS. A machined-aluminium grey: 5.9:1 on the mat,
 * so a charcoal chassis still has an edge, and it needs no dark halo under it the way a red line
 * on a red fill did (the halo is gone with the outline it existed for).
 */
export const ROBOT_TRIM = '#9aa3ad';

/** blend `accent` into a structural `base` colour by `amt` (0..1) and an optional alpha — used to
 * tint an aluminium/rubber part (a tread bar, a roller stripe) with the cosmetic accent without
 * losing the material shading that says "this is rubber", not painting it flat. */
export function tintColor(base: string, accent: string, amt: number, alpha = 1): string {
  const b = hexToRgb(base);
  const a = hexToRgb(accent);
  if (!b || !a) return base;
  const mix = (x: number, y: number) => Math.round(x + (y - x) * amt);
  return `rgba(${mix(b.r, a.r)},${mix(b.g, a.g)},${mix(b.b, a.b)},${alpha})`;
}
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/**
 * FIVE-POINTED STAR VERTICES — the one place the shape is defined, read by `drawDecal`'s
 * `'star'` case here, the BIOBUZZ 3D decal texture (`games/biobuzz/scene/renderRobots.ts`,
 * different coordinate convention, same helper) and the builder's SVG swatch (`ui/Menu.tsx`),
 * instead of ten vertices hand-listed three times over. Standard math angle convention (0 = +x,
 * increasing counter-clockwise); `points` alternates an outer vertex and an inner notch every
 * `pi/points`, starting on an OUTER vertex at `startAngle` — so a caller that wants "forward" to
 * be the tip just passes the angle that means forward in ITS frame.
 *
 * `STAR_INNER_RATIO` is `1/phi^2` (`(3-sqrt(5))/2`, ~0.382): the ratio a regular pentagram's
 * own edges converge to if extended, not a rounder ~0.5 that reads as a five-petaled flower
 * rather than a star at decal size.
 */
export const STAR_INNER_RATIO = (3 - Math.sqrt(5)) / 2; // 1/phi^2 ~= 0.381966

export function starPoints(cx: number, cy: number, outerR: number, startAngle: number, points = 5): [number, number][] {
  const innerR = outerR * STAR_INNER_RATIO;
  const step = Math.PI / points; // half the angle between two outer vertices
  const out: [number, number][] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const a = startAngle + i * step;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

/** trace a closed `starPoints` polygon into the current path (no fill/stroke — the caller's
 * job, same as `roundRect`/`body` elsewhere in this file). */
function traceStar(ctx: CanvasRenderingContext2D, pts: readonly [number, number][]): void {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
}

/**
 * THE DECAL — a vector shape over the chassis fill, under the halo/outline, parametric in the
 * FOOTPRINT (fractions of length/width, never absolute inches — a decal must scale to any legal
 * chassis, the risk `docs/cosmetics-plan.md` §4 names). Called with the caller's already
 * translated+rotated, footprint-clipped context, `hl`/`hw` the chassis half-length/half-width.
 */
export function drawDecal(ctx: CanvasRenderingContext2D, hl: number, hw: number, decal: string, accent: string): void {
  if (decal === 'none') return;
  const L = hl * 2;
  const W = hw * 2;
  ctx.fillStyle = accent;
  switch (decal) {
    case 'stripe': {
      // one centre stripe, front to back, 18% of the width
      const w = W * 0.18;
      ctx.fillRect(-hl, -w / 2, L, w);
      break;
    }
    case 'racing': {
      // two parallel stripes either side of centre
      const w = W * 0.1;
      const off = W * 0.15;
      ctx.fillRect(-hl, off - w / 2, L, w);
      ctx.fillRect(-hl, -off - w / 2, L, w);
      break;
    }
    case 'chevron': {
      // a forward-pointing chevron across the deck (+x is forward)
      const d = L * 0.22;
      const half = hw * 0.82;
      const notch = d * 0.55;
      ctx.beginPath();
      ctx.moveTo(d * 0.5, 0);
      ctx.lineTo(-d * 0.5, -half);
      ctx.lineTo(-d * 0.5 + notch, -half);
      ctx.lineTo(d * 0.5 + notch, 0);
      ctx.lineTo(-d * 0.5 + notch, half);
      ctx.lineTo(-d * 0.5, half);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'hazard': {
      // diagonal bands, rear third only
      const x0 = -hl;
      const x1 = -hl + L / 3;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, -hw, x1 - x0, W);
      ctx.clip();
      const bw = W * 0.16;
      for (let o = -W; o < L / 3 + W; o += bw * 2) {
        ctx.beginPath();
        ctx.moveTo(x0 + o, -hw);
        ctx.lineTo(x0 + o + bw, -hw);
        ctx.lineTo(x0 + o + bw + W, hw);
        ctx.lineTo(x0 + o + W, hw);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      break;
    }
    case 'checker': {
      // a 4-wide checker band across the middle of the deck
      const cols = 4;
      const cw = L / cols;
      const bandH = W * 0.3;
      const rows = Math.max(1, Math.round(bandH / cw));
      const rh = bandH / rows;
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          if ((i + j) % 2 === 0) ctx.fillRect(-hl + i * cw, -bandH / 2 + j * rh, cw, rh);
        }
      }
      break;
    }
    case 'star': {
      // A REGULAR star needs the SAME radius on both axes — scaling x by `hl` and y by `hw`
      // separately (the way `chevron` does, fine for an arrow) would squash it into a
      // lopsided diamond on a chassis whose length and width differ a lot, and this sim's
      // legal chassis range does. So the radius is one number, off the SMALLER of the two
      // half-dimensions — the one that actually bounds how big a regular star fits before
      // it clips the footprint — at 0.8x, the same reach toward the edge `chevron` takes at
      // 0.82x hw. `startAngle` 0 puts the first outer vertex on +x: one point forward.
      //
      // ⚠️ THE COST OF ONE RADIUS IS THAT A LONG CHASSIS GETS A SMALLER STAR, AND THAT IS
      // FINE ONLY BECAUSE THE LEGAL RANGE IS NARROW. Measured against the intake presets in
      // `config.ts`: length 11–18, width 14.5–18, so `min(hl, hw)` lands between 5.5 and 9
      // and the star is always a real fraction of the deck. Drawn on an ILLEGAL 40x6 it
      // becomes a speck — true, and not worth designing for; a stress case outside the
      // builder's own clamps is not a chassis this ever renders.
      const r = Math.min(hl, hw) * 0.8;
      traceStar(ctx, starPoints(0, 0, r, 0));
      ctx.fill();
      break;
    }
  }
}

export function drawRobot(
  ctx: CanvasRenderingContext2D,
  r: RobotState,
  intakeOn: boolean,
  held: readonly Artifact[] = [],
  // INTERFACE PARITY ONLY, both ignored. The shared renderer calls whichever game's sprite
  // is registered and passes the raised-terrain context Chain Reaction needs; DECODE has no
  // raised terrain and its sprite is frozen to what `main` draws, so these are accepted and
  // dropped rather than changing a single pixel here.
  _screenUp?: { x: number; y: number },
  _world?: unknown,
  /**
   * PREVIEW ONLY: paint the outline this colour instead of the alliance's.
   *
   * The builder's hero used to be a hand-drawn SVG schematic, which is how it drifted
   * away from the robot you actually drive. It renders THIS sprite now, and a preview
   * has no alliance — it is your robot, not a red or blue one. Optional and unset on
   * the field, so nothing about match rendering changes.
   */
  outline?: string,
): void {
  // AN IMPORTED ROBOT draws its hull or its picture (`drawImported.ts`) — a separate function, so
  // this sprite, frozen to what `main` draws, stays byte-identical for every standard robot
  if (r.spec.imported) {
    drawImportedDecodeRobot(ctx, r, intakeOn, held, outline);
    return;
  }
  const hl = r.spec.length / 2;
  const hw = r.spec.width / 2;
  // the alliance is FILLS only now (the chevron); every stroke is the neutral `trim`.
  const color = r.alliance === 'blue' ? C.COLORS.blue : C.COLORS.red;
  const trim = outline ?? ROBOT_TRIM;
  const fill = C.chassisFill(r.spec.chassisColor);
  // COSMETICS: `accent`/`decal`/`plate` land on `RobotSpec` on a parallel lane; `clampCosmetics`
  // is shape-safe against a spec that does not declare them yet.
  const cosm = clampCosmetics(r.spec);
  const accent = accentFill(cosm.accent, r.spec.chassisColor);

  ctx.save();
  ctx.translate(r.pos.x, r.pos.y);
  ctx.rotate(r.heading);

  /**
   * THE SPRITE CANNOT EXCEED THE COLLISION BOX. Anything drawn here is clipped to it.
   *
   * Insetting the chassis outline fixed the one edge that was obvious and left every other
   * stroke on the boundary spilling half its width: the GATE OPENER tabs run out to the
   * chassis edge and were stroked at 0.8 (0.4in past it), the rollers' front face IS the
   * intake's reach and was stroked at 0.4 (0.2in past it). Reported as "the gate opener
   * outline seems to be protruding out too. check everything else."
   *
   * Checking everything else once is worth less than making it impossible, so the body is
   * drawn inside a clip at `footprintExtents` — the exact box `robotExtents` collides with.
   * Every stroke on the boundary becomes an inside stroke automatically, including ones added
   * later. Held artifacts and the turret are drawn AFTER it: an artifact halfway into the
   * mouth really is half outside the frame, and the turret is sized against the chassis in
   * the world frame.
   */
  const fx = footprintExtents(r.spec);
  ctx.save();
  ctx.beginPath();
  ctx.rect(-fx.rear, -fx.half, fx.rear + fx.front, fx.half * 2);
  ctx.clip();

  // chassis
  ctx.fillStyle = fill;
  ctx.strokeStyle = trim;
  const body = () => roundRect(ctx, -hl, -hw, r.spec.length, r.spec.width, C.CHASSIS_CORNER);
  body();
  ctx.fill();

  drawDecal(ctx, hl, hw, cosm.decal, accent);

  drawWheels(ctx, r, trim, accent);

  // intake at the front (RobotPreview.tsx draws the same). FUNNEL presets
  // (sloped/triangle) are two RIGHT TRIANGLES — one per side — whose hypotenuses
  // are the slopes that funnel balls to the compliant wheels at the throat (no
  // flat front). VECTOR is a flat plate with a full-width wheel roller.
  // NO INTAKE: no wedges, no roller, nothing out front — the chassis is the whole robot
  const none = C.noIntake(r.spec);
  const preset = C.INTAKE_PRESETS[r.spec.intake];
  const m = C.intakeMouth(r.spec); // vector's mouth spans the chassis width
  const rw = m.mouthHalf;
  // The roller's FRONT FACE is the intake's reach, so it matches `footprintExtents` exactly
  // and a bigger diameter grows BACKWARD into the mouth rather than past the collision box.
  const dia = C.intakeRollerDia(r.spec);
  const rollerTip = hl + preset.reach;
  const rollerBack = rollerTip - dia;
  const wedgeTip = C.intakeAxleX(r.spec); // wedges meet the roller at its axle — one authority
  const mouthOn = intakeOn ? 'rgba(34,197,94,0.85)' : '#2a303c';
  /**
   * The roller is DISCRETE WHEELS ON A SHAFT, not a solid bar. Drawing it as one filled
   * rectangle the width of the mouth worked while it was 1in deep, but at 72mm it covers
   * the whole reach and buries the funnel — the slopes ARE the identity of these presets.
   * Wheels with gaps let the slopes read through, which is also what the real thing looks
   * like from above.
   */
  const drawRoller = () => {
    const axis = wedgeTip; // the axle; same authority the wedges and the capture nip read
    // beam across the mouth
    ctx.fillStyle = intakeOn ? '#166534' : '#475569';
    ctx.fillRect(axis - 0.28, -rw, 0.56, rw * 2);
    // GATE OPENER: a THIN tab on each beam end out to the chassis edge. Solid to robots,
    // walls and the gate lever (footprintExtents); artifacts pass UNDER it.
    if (hw > rw + 0.05) {
      for (const sg of [1, -1] as const) {
        const y0 = sg === 1 ? rw : -hw;
        ctx.fillStyle = intakeOn ? '#14532d' : '#334155';
        ctx.fillRect(axis - C.INTAKE_OPENER_THICK / 2, y0, C.INTAKE_OPENER_THICK, hw - rw);
        ctx.strokeStyle = trim;
        ctx.lineWidth = 0.8;
        ctx.strokeRect(axis - C.INTAKE_OPENER_THICK / 2, y0, C.INTAKE_OPENER_THICK, hw - rw);
      }
    }
    // ROLLERS along the WHOLE beam, out to the openers that cap its ends. `wheelSpan` in
    // robot.ts is the SUCTION region, not the hardware — drawing to it left a few rollers
    // in the middle and bare beam either side.
    const n = Math.max(1, Math.round(rw / C.INTAKE_ROLLER_PITCH));
    const halfW = C.INTAKE_ROLLER_W / 2;
    ctx.strokeStyle = intakeOn ? '#15803d' : '#94a3b8';
    ctx.lineWidth = 0.4;
    for (let i = -n; i <= n; i++) {
      const cy = (i * rw) / (n + 0.35);
      if (Math.abs(cy) + halfW > rw + 0.01) continue; // never past the beam ends
      const center = Math.abs(i) <= Math.max(1, n / 3);
      ctx.fillStyle = center ? (intakeOn ? '#22c55e' : '#6b7280') : intakeOn ? '#15803d' : '#5b6472';
      ctx.beginPath();
      ctx.roundRect(rollerBack, cy - halfW, dia, C.INTAKE_ROLLER_W, 0.45);
      ctx.fill();
      ctx.stroke();
    }
  };
  if (none) {
    // nothing to draw
  } else if (m.wedge) {
    const th = m.throatHalf;
    // funnel mouth: opening at the (recessed) wedge line, narrowing to the throat
    // the mouth opening: wide at the roller axle, narrowing to the throat
    ctx.fillStyle = mouthOn;
    ctx.beginPath();
    ctx.moveTo(wedgeTip, -rw);
    ctx.lineTo(wedgeTip, rw);
    ctx.lineTo(hl, th);
    ctx.lineTo(hl, -th);
    ctx.closePath();
    ctx.fill();
    // two right triangles (right angle at the chassis front-outer corner; the
    // hypotenuse from the front corner in to the throat is the slope)
    ctx.fillStyle = fill;
    ctx.strokeStyle = trim;
    ctx.lineWidth = 1;
    // wedge body per side: outer edge forward to the axle, then a LONG slope from the
    // mouth edge back in to the throat. Running the slope to the mouth edge (rw) rather
    // than straight to the chassis corner is what makes it read as a funnel at all.
    for (const sg of [1, -1] as const) {
      // ...and its outline stays INSIDE it, because the wedge's outer edge IS the footprint's
      const wedge = () => {
        ctx.beginPath();
        ctx.moveTo(hl, sg * hw);
        ctx.lineTo(wedgeTip, sg * hw);
        ctx.lineTo(wedgeTip, sg * rw);
        ctx.lineTo(hl, sg * th);
        ctx.closePath();
      };
      wedge();
      ctx.fill();
      strokeInside(ctx, wedge, C.CHASSIS_OUTLINE);
    }
    drawRoller();
  } else {
    // vector: flat plate to the (barely recessed) wedge line + the roller out front
    ctx.fillStyle = mouthOn;
    ctx.fillRect(hl, -rw, wedgeTip - hl, rw * 2);
    drawRoller();
  }

  // heading chevron
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(hl - 2.4, 0);
  ctx.lineTo(hl - 5.4, 2.2);
  ctx.lineTo(hl - 5.4, -2.2);
  ctx.closePath();
  ctx.fill();

  /**
   * THE SILHOUETTE LINE GOES ON LAST, over everything that reaches the edge.
   *
   * It used to be stroked with the chassis, before the intake. Inside-stroking moved it a
   * half-width INBOARD, so anything drawn out to the true edge — the gate-opener tabs at the
   * ends of the roller beam are exactly that — filled the sliver outside it and read as
   * poking through the outline: "the gate opener outline seems to be protruding out too".
   * Drawn last it is the boundary of the whole object, which is what an outline is.
   */
  ctx.strokeStyle = trim;
  strokeInside(ctx, body, C.CHASSIS_OUTLINE);

  ctx.restore(); // ...end of the footprint clip

  // held artifacts — the actual PHYSICAL balls (they slide within the intake),
  // drawn HERE in the robot's local frame so they sit BELOW the turret/shooter.
  for (const b of held) {
    // use the STORED local offset, not `b.pos - r.pos`: for a remote robot the
    // rendered `r.pos` is INTERPOLATED but the ball's world `b.pos` comes straight
    // from the predicted sim (balls aren't interpolated), so the world round-trip
    // would misplace the ball relative to the robot body. lx/ly track it rigidly.
    const lp =
      b.state.kind === 'held'
        ? { x: b.state.lx, y: b.state.ly }
        : rot({ x: b.pos.x - r.pos.x, y: b.pos.y - r.pos.y }, -r.heading);
    ctx.fillStyle = b.color === 'purple' ? C.COLORS.purple : C.COLORS.green;
    ctx.beginPath();
    ctx.arc(lp.x, lp.y, C.BALL_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 0.4;
    ctx.stroke();
  }
  ctx.restore();

  // turret on top (world orientation) — sized so nothing pokes past the
  // chassis in ANY turret direction: max reach is the distance from the
  // turret center to the nearest chassis edge
  const tp = turretWorldPos(r);
  const off = Math.abs(r.spec.length * C.TURRET_OFFSET_FRAC);
  const reach = Math.min(hl - off, hw) - 0.5;
  const ring = Math.min(4.4, reach);
  ctx.save();
  ctx.translate(tp.x, tp.y);
  ctx.rotate(r.turretHeading);
  // a FIXED launcher (`spec.launcher`) has no slew ring: its housing is bolted square to the
  // chassis and `turretHeading` is the chassis heading plus its facing
  if (decodeFixedLauncher(r.spec)) {
    drawFixedLauncher(ctx, ring, reach, r.hopper.length > 0);
    ctx.restore();
    return;
  }
  ctx.strokeStyle = r.hopper.length > 0 ? '#22c55e' : '#6b7280';
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.arc(0, 0, ring, 0, Math.PI * 2);
  ctx.stroke();
  // turret body + barrel
  ctx.fillStyle = '#3a4150';
  ctx.beginPath();
  ctx.arc(0, 0, Math.max(ring - 1, 1.5), 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#525b6b';
  ctx.fillRect(0, -1.2, reach, 2.4);
  ctx.restore();
}

/**
 * A FIXED LAUNCHER, drawn in its own frame (+x = where it fires): a flywheel housing with the
 * wheel across it and the hood's lip out of the front, outlined in the same loaded/empty colour a
 * turret's ring uses. No ring, because nothing turns: the robot is what aims. Sized like the
 * turret (`ring`, `reach`), so it never pokes past the chassis either.
 */
function drawFixedLauncher(ctx: CanvasRenderingContext2D, ring: number, reach: number, loaded: boolean): void {
  const l = Math.max(ring * 1.3, 3);
  const w = Math.max(ring * 1.5, 3);
  ctx.fillStyle = '#3a4150';
  ctx.fillRect(-l / 2, -w / 2, l, w);
  ctx.strokeStyle = loaded ? '#22c55e' : '#6b7280';
  ctx.lineWidth = 0.9;
  ctx.strokeRect(-l / 2, -w / 2, l, w);
  // the flywheel, edge-on across the housing
  ctx.fillStyle = '#1f2329';
  ctx.fillRect(-l * 0.1, -w * 0.38, l * 0.32, w * 0.76);
  // the hood's lip: where the artifact leaves
  ctx.fillStyle = '#525b6b';
  ctx.fillRect(l / 2 - 0.2, -1.2, Math.max(reach - l / 2, 1), 2.4);
}

/**
 * Draw a robot's DRIVETRAIN wheels in the chassis-local frame (already translated +
 * rotated to the robot). Shared by DECODE's drawRobot and Chain Reaction's drawChainRobot
 * so every drivetrain reads identically across games: mecanum/tank point forward, SWERVE
 * pods steer to `moduleAngles`, X-drive omnis sit at ±45° (an X).
 */
export function drawWheels(ctx: CanvasRenderingContext2D, r: RobotState, color: string, accent: string): void {
  // [FL, FR, BL, BR] — `wheelLocals`, the list the sim steers `moduleAngles` against
  const corners = wheelLocals(r.spec).map((w) => [w.x, w.y] as const);
  // the tyre's own fill DEFAULTS to the cosmetic accent (closure over `accent`); a call site
  // only overrides it for a non-tyre part (the swerve module housing below).
  const drawWheel = (px: number, py: number, ang: number, len = 4.4, wid = 2.2, fill = accent): void => {
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(ang);
    ctx.fillStyle = fill;
    ctx.fillRect(-len / 2, -wid / 2, len, wid);
    // a light edge so the wheel's ORIENTATION reads (X-drive X, swerve steer)
    ctx.strokeStyle = 'rgba(190,205,220,0.4)';
    ctx.lineWidth = 0.35;
    ctx.strokeRect(-len / 2, -wid / 2, len, wid);
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
      drawWheel(px, py, ang, 4.2, 1.8, accent);
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
    // Omni wheels canted 45°, each one lying ACROSS its corner rather than along it, so the
    // four of them read as the four sides of a DIAMOND.
    //
    // ⚠️ NOT AN X. They were drawn radially — every wheel pointing at the centre — which is
    // the wrong machine: a wheel whose force line passes through the centre of mass has no
    // moment arm about it, so four radial omnis could translate and could never yaw. The
    // drive this sim actually models puts each wheel ACROSS its corner, which is where its
    // turning authority comes from, and that is a diamond top-down. Rotating each wheel the
    // other way (−45° on the main diagonal, +45° on the anti-diagonal) is the whole fix.
    //
    // They are drawn at the SAME size as every other drivetrain's wheels, because an omni is
    // the same size as a traction wheel. They used to be stretched to `reach * 1.15` so the
    // old X would read as an X — with the wheels turned the right way the diamond reads on
    // its own, and at that length the four of them looked like bars rather than wheels.
    for (const [px, py] of corners) drawWheel(px, py, px * py >= 0 ? -Math.PI / 4 : Math.PI / 4, 4.4, 2.2, accent);
  } else {
    for (const [px, py] of corners) drawWheel(px, py, 0);
  }
}

/**
 * Stroke a path so the line lies ENTIRELY INSIDE it.
 *
 * A canvas stroke straddles the path — half its width falls outside — so a chassis drawn at
 * its true length x width renders half a line wider on every side than the box it collides
 * with, and the outline reads as not being part of the robot. Clipping to the path and
 * stroking at double width puts the whole line inside: the drawn silhouette is exactly the
 * collision footprint, and nothing about where the wheels or mechanisms sit changes.
 */
export function strokeInside(
  ctx: CanvasRenderingContext2D,
  path: () => void,
  width: number,
): void {
  ctx.save();
  path();
  ctx.clip();
  ctx.lineWidth = width * 2;
  path();
  ctx.stroke();
  ctx.restore();
}

export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * DECODE'S SPRITE FOR AN IMPORTED ROBOT (`drawImported.ts` has the body and the rules). The body is
 * the hull or the import's own top-down picture; on top of it, DECODE's dynamic layer from DECODE's
 * own accessors:
 *  - the INTAKE at the roller axle `C.intakeAxleX` across `C.intakeMouth`'s span, its band the
 *    capture nip (`C.intakeNip`) — as roller hardware on a silhouette, as a state band over a
 *    picture;
 *  - the alliance heading CHEVRON (the alliance is a fill on this sprite, never the outline);
 *  - the HELD artifacts at their stored local offsets, exactly as on a standard robot;
 *  - the TURRET at `turretWorldPos`, sized to the hull rather than to `length`.
 */
function drawImportedDecodeRobot(
  ctx: CanvasRenderingContext2D,
  r: RobotState,
  intakeOn: boolean,
  held: readonly Artifact[],
  outline?: string,
): void {
  const imp = r.spec.imported;
  if (!imp) return;
  const color = r.alliance === 'blue' ? C.COLORS.blue : C.COLORS.red;
  const trim = outline ?? ROBOT_TRIM;
  const fill = C.chassisFill(r.spec.chassisColor);
  const accent = accentFill(clampCosmetics(r.spec).accent, r.spec.chassisColor);

  ctx.save();
  ctx.translate(r.pos.x, r.pos.y);
  ctx.rotate(r.heading);
  ctx.save();
  clipToHull(ctx, imp);
  const pictured = drawImportedBody(ctx, r, { fill, accent });

  // THE INTAKE — exactly where the sim's DECODE mouth is (`decodeImportMouth`): the hull's own
  // face and roller line, the mouth's lateral centre `yc` and width, the funnel wedges the artifact
  // solve collides with (`decodeImportSolids`), and the band the capture grabs in
  // (`decodeImportGrabRect`: the nip about the axle, across the mouth)
  // (NO INTAKE draws none: the hull is the robot)
  const d = C.noIntake(r.spec) ? null : decodeImportMouth(r.spec);
  const band = d ? decodeImportGrabRect(r.spec) : null;
  const mh = d ? d.mouth.mouthHalf : 0;
  const th = d ? d.mouth.throatHalf : 0;
  const dia = C.intakeRollerDia(r.spec);
  if (!d || !band) {
    // nothing to draw
  } else if (pictured) {
    drawMouthState(ctx, [band], intakeOn);
  } else {
    // the funnel WEDGES (sloped/triangle) or the vector's flanking rails: the sim's own solids
    for (const piece of decodeImportSolids(r.spec).structure) {
      ctx.fillStyle = fill;
      traceHull(ctx, piece);
      ctx.fill();
      ctx.strokeStyle = trim;
      strokeInside(ctx, () => traceHull(ctx, piece), C.CHASSIS_OUTLINE);
    }
    // the mouth: wide at the axle, narrowing to the throat at the face
    ctx.fillStyle = intakeOn ? 'rgba(34,197,94,0.85)' : '#2a303c';
    ctx.beginPath();
    ctx.moveTo(d.axle, d.yc - mh);
    ctx.lineTo(d.axle, d.yc + mh);
    ctx.lineTo(d.face, d.yc + th);
    ctx.lineTo(d.face, d.yc - th);
    ctx.closePath();
    ctx.fill();
    // the beam on the axle and the compliant wheels along it — the standard sprite's roller
    ctx.fillStyle = intakeOn ? '#166534' : '#475569';
    ctx.fillRect(d.axle - 0.28, d.yc - mh, 0.56, mh * 2);
    const n = Math.max(1, Math.round(mh / C.INTAKE_ROLLER_PITCH));
    const halfW = C.INTAKE_ROLLER_W / 2;
    ctx.strokeStyle = intakeOn ? '#15803d' : '#94a3b8';
    ctx.lineWidth = 0.4;
    for (let i = -n; i <= n; i++) {
      const cy = (i * mh) / (n + 0.35);
      if (Math.abs(cy) + halfW > mh + 0.01) continue;
      ctx.fillStyle = intakeOn ? '#22c55e' : '#6b7280';
      roundRect(ctx, d.axle - dia / 2, d.yc + cy - halfW, dia, C.INTAKE_ROLLER_W, 0.45);
      ctx.fill();
      ctx.stroke();
    }
  }

  drawImportedChevron(ctx, imp, color, 0.45);
  drawImportedOutline(ctx, imp, trim);
  ctx.restore(); // ...end of the hull clip

  for (const b of held) {
    const lp =
      b.state.kind === 'held'
        ? { x: b.state.lx, y: b.state.ly }
        : rot({ x: b.pos.x - r.pos.x, y: b.pos.y - r.pos.y }, -r.heading);
    ctx.fillStyle = b.color === 'purple' ? C.COLORS.purple : C.COLORS.green;
    ctx.beginPath();
    ctx.arc(lp.x, lp.y, C.BALL_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 0.4;
    ctx.stroke();
  }
  ctx.restore();

  // THE TURRET at the sim's own point, ringed to fit the hull where it stands
  const tp = turretWorldPos(r);
  const local = rot({ x: tp.x - r.pos.x, y: tp.y - r.pos.y }, -r.heading);
  const ring = ringInHull(imp, local, 1.5, 4.4);
  const loaded = r.hopper.length > 0;
  if (pictured) {
    drawAimMark(ctx, tp.x, tp.y, r.turretHeading, ring, loaded);
    return;
  }
  ctx.save();
  ctx.translate(tp.x, tp.y);
  ctx.rotate(r.turretHeading);
  if (decodeFixedLauncher(r.spec)) {
    // the FIXED launcher at the placed lip, facing `mech.shooterYawDeg`
    drawFixedLauncher(ctx, ring, ring + 0.5, loaded);
    ctx.restore();
    return;
  }
  ctx.strokeStyle = loaded ? '#22c55e' : '#6b7280';
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.arc(0, 0, ring, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#3a4150';
  ctx.beginPath();
  ctx.arc(0, 0, Math.max(ring - 1, 1.5), 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#525b6b';
  ctx.fillRect(0, -1.2, ring + 0.5, 2.4);
  ctx.restore();
}
