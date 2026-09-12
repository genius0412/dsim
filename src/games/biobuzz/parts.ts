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
 * drivetrain. The mechanisms themselves (sweeper, drum, dumper, turret, lift) are
 * `drawRobot.ts`'s (canvas) and `RobotPreview.tsx`'s (SVG) job to DRAW, which keeps a mechanism
 * change out of the chassis code. The one exception is `bbLiftMastLocal` below: it is GEOMETRY
 * (where a fixture sits), not drawing, and both of those renderers need the identical answer —
 * the same reason `mounts.ts` holds `turretLocal` rather than either renderer computing its own.
 */
import type { RobotSpec, RobotState } from '../../types';
import * as C from '../../config';
import { roundRect, strokeInside } from '../../render/drawRobot';
import { hyp } from '../../math';
import { MOUNT_DIR, mountOrigin, type BbMountPos } from './mounts';

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
export function drawWheels(ctx: CanvasRenderingContext2D, r: RobotState, color: string): void {
  const hl = r.spec.length / 2;
  const hw = r.spec.width / 2;
  const wx = Math.max(hl - C.WHEEL_INSET, 1);
  const wy = Math.max(hw - C.WHEEL_INSET, 1);
  const corners = [
    [wx, wy],
    [wx, -wy],
    [-wx, wy],
    [-wx, -wy],
  ] as const;
  /**
   * ONE WHEEL, drawn as the wheel it actually is. `kind` picks the tread, which is the only
   * thing that distinguishes these from above and is exactly what the drivetrain choice buys:
   *  • traction — a rubber tyre with tread bars ACROSS the roll direction (grip, no strafe)
   *  • mecanum  — barrel rollers at 45 degrees (see drawMecanumRollers)
   *  • omni     — barrel rollers ACROSS the tyre, in a row: rolls freely sideways
   */
  const drawWheel = (
    px: number,
    py: number,
    ang: number,
    kind: 'traction' | 'omni' | 'plain' = 'plain',
    len = 4.4,
    wid = 2.2,
    fill = '#12171e',
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
      ctx.strokeStyle = 'rgba(205,218,232,0.30)';
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
      ctx.fillStyle = 'rgba(205,218,232,0.34)';
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
    ctx.strokeStyle = 'rgba(200,214,230,0.55)';
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
      drawWheel(px, py, ang, 'traction', 4.2, 1.8, '#1b212b');
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
    // omni wheels canted 45°, opposite corners on the same diagonal → an X. Long +
    // lighter so the X clearly reads; the diagonals nearly meet at the center.
    const reach = hyp(wx, wy);
    for (const [px, py] of corners)
      drawWheel(px, py, px * py >= 0 ? Math.PI / 4 : -Math.PI / 4, 'omni', Math.min(reach * 1.15, 7.5), 2.0, '#2b333e');
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
      drawWheel(px, py, 0, tank ? 'traction' : 'plain', undefined, undefined, tank ? '#39424f' : '#12171e');
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
// LIFT MAST — the fixture position a vertical extension slide's collar sits at
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How big a LIFT's stowed collar reads at its mount, in inches. Shared by both renderers so the
 * builder's SVG preview and the in-match canvas sprite draw the identically-sized fixture.
 *
 * Deliberately its OWN constant rather than a reuse of `turretRadius` (`mounts.ts`): a vertical
 * slide's footprint at the deck is a bolted collar, not a slewing ring, and the two mechanisms
 * should not read as the same part on the sprite just because they share the nine-cell mount
 * map. APPROX — picked to sit clearly under the smallest turret ring (`turretRadius`'s floor is
 * `Math.min(spec.length, spec.width) * 0.24`, ~3.24in on the smallest legal chassis), so a
 * glance never confuses "this build has a lift" with "this build has a turret".
 */
export const BB_LIFT_MAST_R = 1.7;

/**
 * The LIFT mast's centre, in the robot frame — the ONE point both renderers draw the collar at.
 *
 * Mirrors `turretLocal` (`mounts.ts`) on purpose and for the same reason: an edge or corner
 * mount is pulled INBOARD by the mast's own radius on EACH axis the mount touches (not by the
 * radius along the mount's diagonal, which would leave a corner-mounted mast hanging off the
 * frame by `r - r/sqrt2`), so the collar sits flush just inside the rail it is bolted to. It
 * cannot simply CALL `turretLocal`, though: that function resolves a LAUNCHER slot
 * (`shooterMount`/`shooterRear`) and pulls inboard by `turretRadius`, and a lift is a distinct
 * slot on the same nine-cell map with its own resolved `BbMountPos` and its own, smaller,
 * radius — hence the parallel geometry here rather than a shared call. `center` is dead centre,
 * exactly as it is for a turret there.
 */
export function bbLiftMastLocal(
  spec: Pick<RobotSpec, 'length' | 'width'>,
  mount: BbMountPos,
): { x: number; y: number } {
  if (mount === 'center') return { x: 0, y: 0 };
  const o = mountOrigin(spec, mount);
  const d = MOUNT_DIR[mount];
  return { x: o.x - Math.sign(d.x) * BB_LIFT_MAST_R, y: o.y - Math.sign(d.y) * BB_LIFT_MAST_R };
}
