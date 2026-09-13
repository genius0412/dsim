import type { Artifact, ArtifactColor, RobotSpec, RobotState, Vec2, World } from '../../types';
import * as C from '../../config';
import { clamp } from '../../math';
import { roundRect } from '../../render/drawRobot';
import { BB_PLACE_MARK_R, bbBoxTubeGlyph, drawChassisBody, drawChassisOutline, drawWheels } from './parts';
import {
  BB_HOOD_DEFAULT_DEG,
  BB_LAUNCH_LINE_FRAC,
  BB_LAUNCH_PLATE_GAP,
  BB_LAUNCH_PLATE_OVERHANG,
  BB_POLLEN_R,
  BB_TURRET_PITCH_MAX,
  BB_TURRET_PITCH_MIN,
  bbHopperCap,
} from './config';
import { type BbLauncherSpec, type BbLiftSpec, bbIsTurreted, bbLauncherOf, bbLiftOf } from './mechs';
import {
  EDGE_ANGLE,
  type BbMountPos,
  bbMouthFrame,
  bbShooterEdgeOf,
  edgeGeom,
  turretLocal,
  turretRadius,
} from './mounts';
import { bbFlowerInReach, bbFootprint, bbMouths, bbPlacePointLocal } from './robot';
import { ELEMENT_FILL, ELEMENT_LINE } from './draw';

/**
 * BIOBUZZ robot sprite (top-down).
 *
 * Copied and owned from `games/chain/drawRobot.ts`, with the catalyst mechanism, the beam
 * terrain ride and the crossing shudder deleted — BIOBUZZ has no second manipulator and no
 * published terrain, so there is nothing for any of them to depict. What is left is the part
 * that matters: A BUILD READS AT A GLANCE. The mounted sweeper, this build's LAUNCHER (one turret
 * on top · two individual turrets · a chassis-wide dumper tray), its BOX TUBE (a short tube at its
 * mount plus the placement-point marker), the ELEMENTS it is holding, and a heading chevron.
 * Front = robot +x.
 *
 * ── A BUILD IS A MANDATORY LAUNCHER PLUS AN OPTIONAL BOX TUBE ───────────────
 * `bbLauncherOf`/`bbLiftOf` (`mechs.ts`) are the one place that reads `RobotSpec.bbMech` and
 * migrates a spec written before the container existed. Reading `r.spec.scoreMode` directly is
 * only a mirror of that, and a double turret's second cell (`mount2`) is not in the mirror at all.
 *
 * ── THE INVARIANT ──────────────────────────────────────────────────────────
 * The intake is drawn by filling exactly the `bbMouths` rects — the SAME rects `interact`
 * captures POLLEN with. Not a matching shape, THE shape. In Chain Reaction the renderer and
 * the capture test each derived the intake band from the spec and drifted apart by an inch,
 * which meant POLLEN vanished from outside the visible roller. Every mechanism here reads its
 * geometry from `mechs.ts`/`mounts.ts`/`robot.ts`/`parts.ts` for that reason: the turrets from
 * `turretLocal` (where an element is born), the placement marker from `bbPlacePointLocal` (where
 * the sim tests FLOWER reach).
 *
 * ── WHY IT IS ALUMINIUM AND RUBBER, NOT COLOURED SLABS ─────────────────────
 * Mechanisms used to be flat saturated-green slabs, with that colour carrying the
 * running/loaded state across the whole part. Two problems: green is not what any of these
 * things is made of, and a filled slab has no internal structure, so a robot read as a stack
 * of coloured blocks rather than as a machine. Structure — plates, shafts, bearings, hubs,
 * grooves — is what makes a top-down sprite legible. Colour stays where it means something:
 * the alliance on the chassis outline and on the NECTAR turret's rim, the element colours on
 * what the robot is holding, and a thin accent LINE on the part that is running.
 */

const GREEN = '#22c55e';
const ALU = '#98a3b2'; // machined-edge highlight
const ALU_MID = '#5c6676';
const ALU_DK = '#39414f';
const RUBBER_LO = '#12161c'; // the shaded side of a roller
const RUBBER_HI = '#4a5464'; // its lit crown
const TAU = Math.PI * 2;

/** the status accent — a LINE on the live part, never a fill over the whole part */
const liveLine = (on: boolean, alpha = 0.9): string =>
  on ? `rgba(34,197,94,${alpha})` : `rgba(190,205,220,${alpha * 0.55})`;

/**
 * A ROLLER seen from above: a cylinder lying along the local y axis, centred at local x `cx`.
 *
 * Drawn with a cross-axis GRADIENT (dark lip → lit crown → dark lip), because that shading is
 * the one cue that separates a cylinder from a rectangle in a top-down view, plus the
 * compliant FLAPS along its length and a bearing at each end. `spanHalf` is the barrel's
 * half-length, `dia` its diameter.
 */
function drawRoller(
  ctx: CanvasRenderingContext2D,
  cx: number,
  spanHalf: number,
  dia: number,
  on: boolean,
  flapEvery = 2.3,
): void {
  const rh = dia / 2;
  const g = ctx.createLinearGradient(cx - rh, 0, cx + rh, 0);
  g.addColorStop(0, RUBBER_LO);
  g.addColorStop(0.42, RUBBER_HI);
  g.addColorStop(0.75, '#2a3240');
  g.addColorStop(1, RUBBER_LO);
  ctx.fillStyle = g;
  roundRect(ctx, cx - rh, -spanHalf, dia, spanHalf * 2, rh * 0.85);
  ctx.fill();
  // compliant flaps — the angled lugs that actually drag a POLLEN in. Deliberately FAINT: at
  // 8 px/inch a bold hatch across a full-width roller turns into a barber pole and swallows
  // the shape it is meant to describe.
  ctx.strokeStyle = on ? 'rgba(34,197,94,0.34)' : 'rgba(190,205,220,0.22)';
  ctx.lineWidth = Math.min(0.18, rh * 0.22);
  const n = Math.max(3, Math.round((spanHalf * 2) / flapEvery));
  for (let i = 0; i < n; i++) {
    const y = -spanHalf + 0.45 + ((i + 0.5) * (spanHalf * 2 - 0.9)) / n;
    ctx.beginPath();
    ctx.moveTo(cx - rh * 0.6, y - 0.3);
    ctx.lineTo(cx + rh * 0.6, y + 0.3);
    ctx.stroke();
  }
  // bearings at both ends of the shaft — a roller has to be held up by something
  ctx.fillStyle = ALU;
  for (const s of [1, -1] as const) {
    ctx.beginPath();
    ctx.arc(cx, s * (spanHalf - 0.1), Math.min(0.36, rh * 0.45), 0, TAU);
    ctx.fill();
  }
}

export function drawBiobuzzRobot(
  ctx: CanvasRenderingContext2D,
  r: RobotState,
  intakeOn: boolean,
  _held: Artifact[] = [],
  screenUp: Vec2 = { x: 0, y: 1 },
  world?: World,
): void {
  void screenUp; // nothing lifts the chassis off the tile in BIOBUZZ — no terrain is published
  const hl = r.spec.length / 2;
  const color = r.alliance === 'blue' ? C.COLORS.blue : C.COLORS.red;
  const loaded = r.hopper.length > 0;
  // THE MECHANISM LOADOUT — see the file header. The launcher is never null; the tube may be.
  const launcher = bbLauncherOf(r.spec, BB_HOOD_DEFAULT_DEG);
  const lift = bbLiftOf(r.spec);
  // The intake reads ACTIVE whenever it can still collect — on (auto or the held command) AND
  // the hopper not full. Not "nearly empty": a driver needs to know the difference between
  // "my intake is off" and "my intake is on but I am full", and those are different actions.
  const intaking = (intakeOn || r.autoIntake) && r.hopper.length < bbHopperCap(r.spec);

  ctx.save();
  ctx.translate(r.pos.x, r.pos.y);
  ctx.rotate(r.heading);

  /**
   * EVERYTHING ON THE ROBOT IS DRAWN INSIDE THE COLLISION BOX.
   *
   * The body is clipped to `bbFootprint` — the same extents Rapier collides on — so no stroke
   * can imply the robot is bigger than it is. A sprite that overhangs its hitbox is the single
   * most confusing thing a driver can be shown: they aim a gap by the picture and hit
   * something with the part of the robot that is not drawn there. The ONE thing drawn outside
   * it is the Box Tube's placement marker, after the clip is restored — that point lies past the
   * footprint by construction, and it is a marker of where the robot REACHES, not of the robot.
   */
  const fx = bbFootprint(r.spec);
  ctx.save();
  ctx.beginPath();
  ctx.rect(-fx.rear, -fx.half, fx.rear + fx.front, fx.half * 2);
  ctx.clip();

  // the SHARED body (deck, rails, structure) and the drivetrain, so a robot is recognisably
  // the same object across games
  drawChassisBody(ctx, r, C.chassisFill(r.spec.chassisColor));
  drawWheels(ctx, r, color);

  drawBiobuzzIntake(ctx, r, intaking);

  // The turretless launcher (chassis-fixed). The dumper sits just inside its MOUNTED edge: rotate
  // the local frame to that edge and draw the same shape, so a left/right mount spans the chassis
  // LENGTH exactly as `bbLaunch` fires it. Turrets are drawn LAST, in the world frame, because
  // they rotate independently of the chassis. Geometry keys off `launcher.mount`, the slot's OWN
  // resolved position, rather than `r.spec.shooterMount` read cold.
  if (launcher.kind === 'dumper') {
    const edge = bbShooterEdgeOf({ shooterMount: launcher.mount });
    const g = edgeGeom(r.spec, edge);
    ctx.save();
    ctx.rotate(EDGE_ANGLE[edge]);
    drawDumper(ctx, g.dist, g.span, loaded);
    ctx.restore();
  }

  // The BOX TUBE — bolted flat to the frame at its mount, no independent heading and no raise.
  if (lift) drawBoxTube(ctx, r.spec, lift);

  drawChassisOutline(ctx, r, color); // the silhouette line, over everything that reaches it

  ctx.restore(); // ...end of the footprint clip

  // HEADING CHEVRON, near the REAR so it does not fight the front mechanisms. A top-down
  // rectangle has no front, and on a robot whose sweeper is mounted at the BACK the
  // mechanisms actively lie about which way it faces — so the chevron is the only thing that
  // tells you which end is forward.
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-hl + 4.6, 0);
  ctx.lineTo(-hl + 1.8, 1.9);
  ctx.lineTo(-hl + 1.8, -1.9);
  ctx.closePath();
  ctx.fill();

  // WHAT IT IS HOLDING, at fixed slots on the deck — before the turrets, which sit on top.
  drawHeldElements(ctx, r, launcher, lift);

  // THE PLACEMENT MARKER — outside the clip (see above), lit while a FLOWER ring is in reach.
  if (lift) {
    const lit = world !== undefined && bbFlowerInReach(world, r) !== null;
    drawPlaceMarker(ctx, r.spec, lift, lit);
  }

  ctx.restore();

  if (bbIsTurreted(launcher)) {
    // A DOUBLE turret is TWO INDIVIDUAL turrets, each at its own cell with its own yaw and pitch:
    // turret 0 (`mount`) launches POLLEN, turret 1 (`mount2`) launches NECTAR and wears the
    // alliance colour on its rim. Each one's live accent says whether an element of ITS kind is
    // in the hopper, because that is what that turret has to fire.
    const pollen = r.hopper.some((c) => c === 'yellow');
    const nectar = r.hopper.some((c) => c === 'red' || c === 'blue');
    if (launcher.kind === 'twinturret') {
      drawTurret(ctx, r, launcher.mount, r.turretHeading, r.bbTurretPitch ?? 0, pollen, null);
      drawTurret(
        ctx,
        r,
        launcher.mount2 ?? launcher.mount,
        r.bbTurret2Heading ?? r.turretHeading,
        r.bbTurret2Pitch ?? 0,
        nectar,
        color,
      );
    } else {
      drawTurret(ctx, r, launcher.mount, r.turretHeading, r.bbTurretPitch ?? 0, loaded, null);
    }
  }
}

/**
 * The full-width SWEEPER, drawn on every mounted edge (front, back, both flanks, or both
 * ends). THE DRAWN MECHANISM IS THE GRAB AREA: it fills exactly one `bbMouths` rect, the same
 * rect the capture test uses.
 *
 * Built like the real thing rather than filled in like a paddle: two SIDE PLATES bolted to the
 * frame, an outer ROLLER on a shaft at the tip, an inner (transfer) roller at the frame line
 * when the mouth is deep enough, and the BELTS linking them along the plates. The throat
 * between the plates stays OPEN — you can see the mat through it, which is what an intake
 * looks like from above and what makes it read as a mouth rather than a wall.
 */
function drawBiobuzzIntake(ctx: CanvasRenderingContext2D, r: RobotState, on: boolean): void {
  for (const m of bbMouths(r.spec)) {
    const f = bbMouthFrame(m, r.spec.length / 2, r.spec.width / 2);
    const d = f.depth;
    const h = f.half;
    ctx.save();
    ctx.translate(f.ox, f.oy);
    ctx.rotate(f.rot);

    // polycarb floor — a HINT of a tray, not a slab. Only OUTSIDE the frame line: the part of
    // the mouth that reaches back inside the chassis IS the chassis, and tinting it washes out
    // the alliance band underneath. Faintly green while it can still collect, which is the
    // whole state the colour has to carry.
    ctx.fillStyle = on ? 'rgba(34,197,94,0.11)' : 'rgba(160,175,195,0.06)';
    ctx.fillRect(f.rail, -h, d - f.rail, h * 2);

    // SIDE PLATES: the two rails everything else is bolted between. They start at the frame
    // and run out to the tip, so the intake reads as bolted ON rather than floating.
    ctx.fillStyle = ALU_MID;
    ctx.strokeStyle = 'rgba(210,224,240,0.35)';
    ctx.lineWidth = 0.16;
    for (const s of [1, -1] as const) {
      const y = s > 0 ? h - 0.55 : -h;
      roundRect(ctx, f.rail - 0.6, y, d - f.rail + 0.6, 0.55, 0.2);
      ctx.fill();
      ctx.stroke();
    }

    const outer = d - 0.95; // roller axis, a shade inside the tip
    const inner = f.rail - 0.2; // transfer roller, right at the frame line
    const deep = d - f.rail > 2.2; // a shallow mouth gets ONE roller, not two crammed together

    if (deep) {
      // BELTS between the two rollers, run along the inside of each plate
      ctx.strokeStyle = 'rgba(190,205,220,0.22)';
      ctx.lineWidth = 0.18;
      for (const s of [1, -1] as const) {
        ctx.beginPath();
        ctx.moveTo(inner, s * (h - 0.78));
        ctx.lineTo(outer, s * (h - 0.78));
        ctx.stroke();
      }
      drawRoller(ctx, inner, h - 1.35, 0.8, on, 3.2);
    }
    drawRoller(ctx, outer, h - 0.75, 1.5, on);
    ctx.restore();
  }
}

/**
 * The chassis-wide DUMPER.
 *
 * A real one is a TRAY ON A PIVOT: the hopper sits in it, the whole tray rotates about a shaft
 * at the back, and the load leaves over the lip at the front. So that is what is drawn — a
 * pivot shaft with a hub at each end, two throwing arms running forward from it, a mesh tray
 * between them, and a heavy release lip. Drawn as one filled trapezoid it read as a paper
 * wedge stuck to the front of the robot, which is how CR's used to look.
 *
 * Drawn in the MOUNT's frame (the caller rotates): `dist` = distance out to that edge, `span`
 * = its half-length, so a flank mount spans the chassis LENGTH instead of its width.
 */
function drawDumper(ctx: CanvasRenderingContext2D, dist: number, span: number, loaded: boolean): void {
  const half = span * BB_LAUNCH_LINE_FRAC;
  const pivot = dist - 7.4; // the shaft it swings about, well inside the frame
  const lip = dist - 0.9; // release lip at the launcher edge

  // TRAY floor — translucent, so it reads as something the load sits IN
  ctx.fillStyle = loaded ? 'rgba(180,200,220,0.10)' : 'rgba(160,175,195,0.06)';
  ctx.beginPath();
  ctx.moveTo(pivot, -half * 0.72);
  ctx.lineTo(lip, -half);
  ctx.lineTo(lip, half);
  ctx.lineTo(pivot, half * 0.72);
  ctx.closePath();
  ctx.fill();
  // the cross-ribs of the tray
  ctx.strokeStyle = 'rgba(190,205,220,0.18)';
  ctx.lineWidth = 0.16;
  for (let i = 1; i <= 3; i++) {
    const t = i / 4;
    const x = pivot + (lip - pivot) * t;
    const hy = half * (0.72 + 0.28 * t);
    ctx.beginPath();
    ctx.moveTo(x, -hy);
    ctx.lineTo(x, hy);
    ctx.stroke();
  }

  // THROWING ARMS — one down each side, pivot to lip
  ctx.strokeStyle = ALU_MID;
  ctx.lineWidth = 0.62;
  ctx.lineCap = 'round';
  for (const s of [1, -1] as const) {
    ctx.beginPath();
    ctx.moveTo(pivot, s * half * 0.72);
    ctx.lineTo(lip, s * half);
    ctx.stroke();
  }
  ctx.lineCap = 'butt';

  // PIVOT shaft + hubs: what the whole thing rotates about
  ctx.strokeStyle = ALU_DK;
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  ctx.moveTo(pivot, -half * 0.72);
  ctx.lineTo(pivot, half * 0.72);
  ctx.stroke();
  ctx.fillStyle = ALU;
  for (const s of [1, -1] as const) {
    ctx.beginPath();
    ctx.arc(pivot, s * half * 0.72, 0.45, 0, TAU);
    ctx.fill();
  }

  // RELEASE LIP — the heavy bar the load rolls over, and the only part that takes the accent
  ctx.fillStyle = ALU_MID;
  roundRect(ctx, lip - 0.45, -half, 0.9, half * 2, 0.3);
  ctx.fill();
  ctx.strokeStyle = liveLine(loaded, 0.95);
  ctx.lineWidth = 0.3;
  ctx.beginPath();
  ctx.moveTo(lip + 0.4, -half + 0.2);
  ctx.lineTo(lip + 0.4, half - 0.2);
  ctx.stroke();
}

/**
 * ONE TURRET, drawn in the WORLD frame so it rotates independently of the chassis.
 *
 * Bolted at `turretLocal(spec, pos)` — the same point `bbLaunch` fires that turret from — so the
 * ring is drawn exactly where an element is born. A double turret calls this twice, once per
 * cell, with that turret's own heading and pitch.
 *
 * `accent` is the NECTAR turret's alliance colour (`null` for a POLLEN-only or single turret):
 * it goes on the ring's rim and on a second, inner rim, so the two turrets of a double differ by
 * SHAPE as well as by hue — the red NECTAR turret on a red-outlined robot must not depend on the
 * reader separating two reds.
 */
function drawTurret(
  ctx: CanvasRenderingContext2D,
  r: RobotState,
  pos: BbMountPos,
  heading: number,
  pitchRad: number,
  live: boolean,
  accent: string | null,
): void {
  const ring = turretRadius(r.spec);
  const local = turretLocal(r.spec, pos);
  const cx = r.pos.x + Math.cos(r.heading) * local.x - Math.sin(r.heading) * local.y;
  const cy = r.pos.y + Math.sin(r.heading) * local.x + Math.cos(r.heading) * local.y;
  ctx.save();
  ctx.translate(cx, cy);

  // THE SLEW RING STAYS WITH THE CHASSIS. The toothed ring is bolted to the frame and the head
  // turns on it, so drawing it inside the rotation makes the whole assembly spin as one piece,
  // which is not how a turret works.
  ctx.fillStyle = ALU_DK;
  ctx.beginPath();
  ctx.arc(0, 0, ring, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = accent ?? 'rgba(200,214,230,0.34)';
  ctx.lineWidth = accent ? 0.5 : 0.22;
  ctx.stroke();
  // gear teeth around the rim: the one detail that says "this rotates"
  ctx.strokeStyle = 'rgba(200,214,230,0.34)';
  ctx.lineWidth = 0.24;
  const teeth = Math.max(14, Math.round(ring * 6));
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * TAU;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * (ring - 0.32), Math.sin(a) * (ring - 0.32));
    ctx.lineTo(Math.cos(a) * ring, Math.sin(a) * ring);
    ctx.stroke();
  }
  if (accent) {
    // the NECTAR turret's SECOND rim, inside the teeth — the shape half of the distinction
    ctx.strokeStyle = accent;
    ctx.lineWidth = 0.3;
    ctx.beginPath();
    ctx.arc(0, 0, ring - 0.75, 0, TAU);
    ctx.stroke();
  }
  // THE FEED HOLE, dead centre: an element comes UP through the middle of the ring, which is why
  // the shooter STRADDLES the ring rather than hanging off one side of it. Drawn on the
  // (non-rotating) ring, since a hole on the axis looks the same at every heading.
  ctx.fillStyle = 'rgba(6,9,13,0.85)';
  ctx.beginPath();
  ctx.arc(0, 0, BB_POLLEN_R + 0.15, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = 'rgba(200,214,230,0.28)';
  ctx.lineWidth = 0.18;
  ctx.stroke();

  // THE HEAD — everything below turns with this turret's own heading
  ctx.rotate(heading);

  /**
   * ONE SHOOTER = A FLYWHEEL LAUNCHER: two PARALLEL PLATES with a wheel spinning between
   * them, and nothing else.
   *
   * There is no barrel. A closed body with a channel bored through it reads as a gun and is
   * not what anyone builds — an FTC launcher is a pair of side plates, standoffs between them,
   * and a compliant wheel that pinches the game piece against the far plate on its way out. The
   * gap between the plates is left EMPTY, because the empty gap is the part a top-down viewer
   * reads as "the element goes through here".
   */
  const gap = BB_LAUNCH_PLATE_GAP; // an element has to fit down it
  const plate = 0.42;

  // PITCH, in RADIANS like every sim angle, absent = 0 (level). Top-down, elevating the head out
  // of the view plane foreshortens it by `cos(pitch)`, which is what makes a lob into the
  // 53.5–65.6in HIVE opening legible without reading the HUD. `BB_TURRET_PITCH_MAX` is 80°, not
  // 90°, so `cos` never reaches the degenerate zero a true vertical shot would give. Clamped
  // defensively: this sprite has no say over what the sim writes, only over drawing it sanely.
  const pitch = clamp(pitchRad, BB_TURRET_PITCH_MIN, BB_TURRET_PITCH_MAX);
  const foreshorten = Math.cos(pitch);
  // CENTRED ON THE RING, because the feed is on the turret axis. Each end clears the rim by
  // `BB_LAUNCH_PLATE_OVERHANG`; the whole head pivots about that axis, so BOTH ends foreshorten.
  const x1 = (ring + BB_LAUNCH_PLATE_OVERHANG) * foreshorten; // muzzle, just past the rim
  const x0 = -x1; // ...and the same again behind the axis
  const wheelX = ring * 0.6 * foreshorten; // the flywheel: past the feed hole, before the muzzle

  ctx.fillStyle = ALU_MID;
  ctx.strokeStyle = 'rgba(210,224,240,0.38)';
  ctx.lineWidth = 0.16;
  for (const y of [-gap / 2, gap / 2]) {
    roundRect(ctx, x0, y - plate / 2, x1 - x0, plate, 0.16);
    ctx.fill();
    ctx.stroke();
  }
  // STANDOFFS tying the plates together — the giveaway that this is plates and a gap rather
  // than one solid block
  ctx.strokeStyle = 'rgba(190,205,220,0.30)';
  ctx.lineWidth = 0.2;
  for (const f of [0.12, 0.92] as const) {
    const x = x0 + (x1 - x0) * f;
    ctx.beginPath();
    ctx.moveTo(x, -gap / 2);
    ctx.lineTo(x, gap / 2);
    ctx.stroke();
  }

  // THE FLYWHEEL, spanning the channel on its axle: the element is pinched between it and the
  // opposite plate, so it sits ON the centreline.
  ctx.save();
  ctx.translate(wheelX, 0);
  ctx.rotate(Math.PI / 2); // drawRoller lays its barrel along local y; the axle runs across
  drawRoller(ctx, 0, gap / 2 - 0.35, 1.5, live, 1.2);
  ctx.restore();

  // the exit, and the running accent: a short bar across the channel at the muzzle line
  ctx.strokeStyle = liveLine(live, 0.95);
  ctx.lineWidth = 0.3;
  ctx.beginPath();
  ctx.moveTo(x1 - 0.3, -gap / 2 + 0.3);
  ctx.lineTo(x1 - 0.3, gap / 2 - 0.3);
  ctx.stroke();
  ctx.restore();
}

/**
 * The BOX TUBE, seen from above: a short length of square tube lying along its mount direction,
 * its outer end just inside the frame rail (`bbBoxTubeGlyph`, `parts.ts` — the builder preview
 * draws the same rectangle). A box tube from above is its WALLS: a hollow rectangle with a bolt at
 * each end. It has no raise, so there is no state to show on it; the state lives on the marker.
 */
function drawBoxTube(ctx: CanvasRenderingContext2D, spec: RobotSpec, lift: BbLiftSpec): void {
  const g = bbBoxTubeGlyph(spec, lift.mount);
  ctx.save();
  ctx.translate(g.cx, g.cy);
  ctx.rotate(Math.atan2(g.uy, g.ux));
  ctx.fillStyle = ALU_MID;
  ctx.strokeStyle = 'rgba(210,224,240,0.55)';
  ctx.lineWidth = 0.18;
  ctx.fillRect(-g.len / 2, -g.w / 2, g.len, g.w);
  ctx.strokeRect(-g.len / 2, -g.w / 2, g.len, g.w);
  // the hollow — what makes it a TUBE rather than a bar
  ctx.fillStyle = ALU_DK;
  ctx.fillRect(-g.len / 2 + 0.28, -g.w / 2 + 0.28, g.len - 0.56, g.w - 0.56);
  ctx.fillStyle = ALU;
  for (const x of [-g.len / 2 + 0.55, g.len / 2 - 0.55]) {
    ctx.beginPath();
    ctx.arc(x, 0, 0.17, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * THE PLACEMENT POINT — a ring with a crosshair at `bbPlacePointLocal`, the ONE point the sim
 * tests FLOWER reach from, joined to the tube by a thin reach line. HOLLOW normally; FILLED and
 * green while `bbFlowerInReach` says a FLOWER ring is within tolerance, which is exactly the state
 * in which the place buttons do something.
 *
 * Drawn with a dark under-stroke first, because it sits on the mat outside the robot and has to
 * read against the mat, a FLOWER foot and the perimeter alike.
 */
function drawPlaceMarker(ctx: CanvasRenderingContext2D, spec: RobotSpec, lift: BbLiftSpec, lit: boolean): void {
  const p = bbPlacePointLocal(spec);
  if (!p) return;
  const g = bbBoxTubeGlyph(spec, lift.mount);
  const R = BB_PLACE_MARK_R;
  const ink = lit ? GREEN : 'rgba(226,234,242,0.92)';
  const path = (): void => {
    ctx.beginPath();
    ctx.moveTo(g.outer.x, g.outer.y);
    const d = Math.hypot(p.x - g.outer.x, p.y - g.outer.y);
    const t = d > R ? (d - R) / d : 0;
    ctx.lineTo(g.outer.x + (p.x - g.outer.x) * t, g.outer.y + (p.y - g.outer.y) * t);
    ctx.moveTo(p.x + R, p.y);
    ctx.arc(p.x, p.y, R, 0, TAU);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      ctx.moveTo(p.x + dx * (R + 0.2), p.y + dy * (R + 0.2));
      ctx.lineTo(p.x + dx * (R + 0.75), p.y + dy * (R + 0.75));
    }
  };
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(6,9,13,0.75)';
  ctx.lineWidth = 0.62;
  path();
  ctx.stroke();
  if (lit) {
    ctx.fillStyle = 'rgba(34,197,94,0.55)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, R, 0, TAU);
    ctx.fill();
  }
  ctx.strokeStyle = ink;
  ctx.lineWidth = 0.28;
  path();
  ctx.stroke();
  ctx.lineCap = 'butt';
}

// ─────────────────────────────────────────────────────────────────────────────
// HELD ELEMENTS — what the robot is carrying, as discs on the deck
// ─────────────────────────────────────────────────────────────────────────────

/** a held element's drawn radius (in). Smaller than the real 1.4/1.8 on purpose: four of them
 * have to fit on the smallest legal chassis without covering a turret ring. One size for both
 * kinds, because the COLOUR is the distinction and a size difference would make the layout
 * depend on what happens to be held. */
const HELD_R = 0.85;
/** centre-to-centre spacing of the slots (in) */
const HELD_PITCH = 1.95;

/** candidate slot arrangements, each an offset list in the robot frame about a centre. Index
 * order is hopper order: 0 is the first element in, the LAST index is the next to leave. */
const HELD_LAYOUTS: readonly (readonly Vec2[])[] = [
  // 2×2, back row first
  [
    { x: -HELD_PITCH / 2, y: HELD_PITCH / 2 },
    { x: -HELD_PITCH / 2, y: -HELD_PITCH / 2 },
    { x: HELD_PITCH / 2, y: HELD_PITCH / 2 },
    { x: HELD_PITCH / 2, y: -HELD_PITCH / 2 },
  ],
  // a line along the chassis length, rear first
  [-1.5, -0.5, 0.5, 1.5].map((k) => ({ x: k * HELD_PITCH, y: 0 })),
  // a line across the chassis
  [1.5, 0.5, -0.5, -1.5].map((k) => ({ x: 0, y: k * HELD_PITCH })),
];

const heldLayoutCache = new Map<string, Vec2[]>();

/**
 * WHERE THE HELD DISCS GO on this build — four fixed slots in the robot frame, chosen once per
 * build (cached) and never from the held balls' own positions, which the sim keeps at the chassis
 * centre.
 *
 * A single fixed spot cannot work: a turret may sit at any of nine cells (two of them, for a
 * double), a Box Tube at any of eight, and on a 13.5 in chassis there is no one place that clears
 * all of those. So this searches a small grid of centres for each arrangement in
 * `HELD_LAYOUTS` and keeps the one with the most CLEARANCE from what the discs must not cover —
 * the turret rings, the Box Tube and the heading chevron — while staying inside the
 * frame rail. Pure arithmetic over the spec, so it is deterministic and costs nothing after the
 * first frame.
 */
export function bbHeldSlots(spec: RobotSpec, launcher: BbLauncherSpec, lift: BbLiftSpec | null): Vec2[] {
  const key = [
    spec.length,
    spec.width,
    spec.drivetrain,
    launcher.kind,
    launcher.mount,
    launcher.mount2 ?? '',
    lift?.mount ?? '',
  ].join('|');
  const hit = heldLayoutCache.get(key);
  if (hit) return hit;

  const hl = spec.length / 2;
  const hw = spec.width / 2;
  const circles: { x: number; y: number; r: number }[] = [];
  if (bbIsTurreted(launcher)) {
    const ring = turretRadius(spec) + 0.3;
    circles.push({ ...turretLocal(spec, launcher.mount), r: ring });
    if (launcher.kind === 'twinturret' && launcher.mount2) circles.push({ ...turretLocal(spec, launcher.mount2), r: ring });
  }
  circles.push({ x: -hl + 3.2, y: 0, r: 1.6 }); // the heading chevron
  // NOT the wheels: on a 13.5 in chassis with a centre turret there is no spot that clears both
  // the ring and all four wheels, and a disc over a tyre still reads — a disc over a ring does not.
  const tube = lift ? bbBoxTubeGlyph(spec, lift.mount) : null;

  const clearance = (px: number, py: number): number => {
    // inside the frame rail, hard
    let c = Math.min(hl - 1.2 - HELD_R - Math.abs(px), hw - 1.2 - HELD_R - Math.abs(py)) * 4;
    for (const o of circles) c = Math.min(c, Math.hypot(px - o.x, py - o.y) - o.r - HELD_R);
    if (tube) {
      // distance to the tube's centre segment, less its half-width
      const ax = tube.cx - (tube.ux * tube.len) / 2;
      const ay = tube.cy - (tube.uy * tube.len) / 2;
      const t = clamp((px - ax) * tube.ux + (py - ay) * tube.uy, 0, tube.len);
      c = Math.min(c, Math.hypot(px - (ax + tube.ux * t), py - (ay + tube.uy * t)) - tube.w / 2 - HELD_R - 0.2);
    }
    return c;
  };

  let best: Vec2[] = HELD_LAYOUTS[0].map((o) => ({ ...o }));
  let bestScore = -Infinity;
  const step = 0.5;
  HELD_LAYOUTS.forEach((layout, li) => {
    for (let cx = -hl; cx <= hl + 1e-9; cx += step) {
      for (let cy = -hw; cy <= hw + 1e-9; cy += step) {
        let score = Infinity;
        for (const o of layout) score = Math.min(score, clearance(cx + o.x, cy + o.y));
        // prefer the compact cluster, then a spot near the chassis middle, when clearances tie
        score += (li === 0 ? 0.25 : 0) - 0.01 * Math.hypot(cx, cy);
        if (score > bestScore) {
          bestScore = score;
          best = layout.map((o) => ({ x: cx + o.x, y: cy + o.y }));
        }
      }
    }
  });
  if (heldLayoutCache.size > 256) heldLayoutCache.clear();
  heldLayoutCache.set(key, best);
  return best;
}

/**
 * WHICH ELEMENTS THE ROBOT IS HOLDING — one disc per entry of `r.hopper`, in hopper order, in the
 * colours the field draws loose elements in (`draw.ts`), with the same dark rim. G407 caps a
 * hopper at 4, so four slots are the whole range. The NEXT element to leave (the last entry —
 * the hopper is a stack) gets a light outer ring; the rest are plain.
 */
function drawHeldElements(
  ctx: CanvasRenderingContext2D,
  r: RobotState,
  launcher: BbLauncherSpec,
  lift: BbLiftSpec | null,
): void {
  const n = Math.min(r.hopper.length, HELD_LAYOUTS[0].length);
  if (n === 0) return;
  const slots = bbHeldSlots(r.spec, launcher, lift);
  for (let i = 0; i < n; i++) {
    const c = r.hopper[i] as ArtifactColor;
    const s = slots[i];
    ctx.fillStyle = ELEMENT_FILL[c] ?? ELEMENT_FILL.yellow;
    ctx.beginPath();
    ctx.arc(s.x, s.y, HELD_R, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = ELEMENT_LINE;
    ctx.lineWidth = 0.3;
    ctx.stroke();
  }
  const top = slots[n - 1];
  ctx.strokeStyle = 'rgba(236,242,248,0.9)';
  ctx.lineWidth = 0.22;
  ctx.beginPath();
  ctx.arc(top.x, top.y, HELD_R + 0.3, 0, TAU);
  ctx.stroke();
}
