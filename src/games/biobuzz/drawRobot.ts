import type { Artifact, RobotState, Vec2, World } from '../../types';
import * as C from '../../config';
import { roundRect } from '../../render/drawRobot';
import { drawChassisBody, drawChassisOutline, drawWheels } from './parts';
import {
  BB_DEFAULT_SCORE_MODE,
  BB_LAUNCH_LINE_FRAC,
  BB_LAUNCH_PLATE_GAP,
  BB_LAUNCH_PLATE_OVERHANG,
  BB_POLLEN_R,
  BB_TWIN_BARREL_OFFSET,
  bbHopperCap,
} from './config';
import {
  EDGE_ANGLE,
  bbMouthFrame,
  bbShooterEdgeOf,
  edgeGeom,
  turretLocal,
  turretRadius,
  type BbScoreMode,
} from './mounts';
import { bbFootprint, bbMouths } from './robot';

/**
 * BIOBUZZ robot sprite (top-down).
 *
 * Copied and owned from `games/chain/drawRobot.ts`, with the catalyst mechanism, the beam
 * terrain ride and the crossing shudder deleted — BIOBUZZ has no second manipulator and no
 * published terrain, so there is nothing for any of them to depict. What is left is the part
 * that matters: A BUILD READS AT A GLANCE. The mounted sweeper, the scoring archetype's
 * launcher (turret on top · chassis-wide drum · chassis-wide dumper tray), a hopper-fill bar,
 * and a heading chevron. Front = robot +x.
 *
 * ── THE INVARIANT ──────────────────────────────────────────────────────────
 * The intake is drawn by filling exactly the `bbMouths` rects — the SAME rects `interact`
 * captures POLLEN with. Not a matching shape, THE shape. In Chain Reaction the renderer and
 * the capture test each derived the intake band from the spec and drifted apart by an inch,
 * which meant POLLEN vanished from outside the visible roller. Every mechanism here reads its
 * geometry from `mounts.ts`/`robot.ts` for that reason.
 *
 * ── WHY IT IS ALUMINIUM AND RUBBER, NOT COLOURED SLABS ─────────────────────
 * Mechanisms used to be flat saturated-green slabs, with that colour carrying the
 * running/loaded state across the whole part. Two problems: green is not what any of these
 * things is made of, and a filled slab has no internal structure, so a robot read as a stack
 * of coloured blocks rather than as a machine. Structure — plates, shafts, bearings, hubs,
 * grooves — is what makes a top-down sprite legible. Colour stays where it means something:
 * the alliance on the chassis outline, and a thin accent LINE on the part that is running.
 */

const GREEN = '#22c55e';
const ALU = '#98a3b2'; // machined-edge highlight
const ALU_MID = '#5c6676';
const ALU_DK = '#39414f';
const RUBBER_LO = '#12161c'; // the shaded side of a roller
const RUBBER_HI = '#4a5464'; // its lit crown
const TAU = Math.PI * 2;

/** the status accent — a LINE on the live part, never a fill over the whole part */
const live = (on: boolean, alpha = 0.9): string =>
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
  void world;
  const hl = r.spec.length / 2;
  const hw = r.spec.width / 2;
  const color = r.alliance === 'blue' ? C.COLORS.blue : C.COLORS.red;
  const loaded = r.hopper.length > 0;
  const mode = (r.spec.scoreMode ?? BB_DEFAULT_SCORE_MODE) as BbScoreMode;
  // The intake reads ACTIVE whenever it can still collect — on (auto or the held command) AND
  // the hopper not full. Not "nearly empty": a driver needs to know the difference between
  // "my intake is off" and "my intake is on but I am full", and those are different actions.
  const intaking = (intakeOn || r.autoIntake) && r.hopper.length < bbHopperCap(r.spec);

  ctx.save();
  ctx.translate(r.pos.x, r.pos.y);
  ctx.rotate(r.heading);

  /**
   * EVERYTHING IS DRAWN INSIDE THE COLLISION BOX.
   *
   * The body is clipped to `bbFootprint` — the same extents Rapier collides on — so no stroke
   * can imply the robot is bigger than it is. A sprite that overhangs its hitbox is the single
   * most confusing thing a driver can be shown: they aim a gap by the picture and hit
   * something with the part of the robot that is not drawn there.
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

  // The turretless launcher (chassis-fixed). Drum and dumper sit just inside the MOUNTED
  // edge: rotate the local frame to that edge and draw the same shape, so a left/right mount
  // spans the chassis LENGTH exactly as `bbLaunch` fires it. The turret is drawn LAST, in the
  // world frame, because it rotates independently of the chassis.
  if (mode === 'drum' || mode === 'dumper') {
    const edge = bbShooterEdgeOf(r.spec); // turretless: always a side, never a corner/centre
    const g = edgeGeom(r.spec, edge);
    ctx.save();
    ctx.rotate(EDGE_ANGLE[edge]);
    if (mode === 'drum') drawDrum(ctx, g.dist, g.span, loaded);
    else drawDumper(ctx, g.dist, g.span, loaded);
    ctx.restore();
  }

  drawChassisOutline(ctx, r, color); // the silhouette line, over everything that reaches it

  ctx.restore(); // ...end of the footprint clip

  drawHopperFill(ctx, r, hw);

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

  ctx.restore();

  if (mode === 'turret' || mode === 'twinturret') drawTurret(ctx, r, loaded, mode === 'twinturret');
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
 * The chassis-wide DRUM.
 *
 * ONE CYLINDER running across (almost) the whole mounted edge, on a single shaft — not a row
 * of separate wheels, which is a different machine. A drum shooter is a barrel the POLLEN are
 * pinched against, so what has to read from above is: a continuous barrel with round shading,
 * the SHAFT it turns on carried by a bearing block at each end, the traction bands wrapped
 * along its length, and the HOOD plate behind it that everything is squeezed against on the
 * way out.
 *
 * Drawn in the MOUNT's frame (the caller rotates): `dist` = distance out to that edge, `span`
 * = its half-length, so a flank mount spans the chassis LENGTH instead of its width.
 */
function drawDrum(ctx: CanvasRenderingContext2D, dist: number, span: number, loaded: boolean): void {
  const half = span * 0.9; // the barrel itself; the bearings take the last stretch
  const dia = 3.3;
  const cx = dist - dia / 2 - 0.55; // its axis, just inside the frame line

  // HOOD — the fixed plate a POLLEN is pinched against, behind the drum
  ctx.fillStyle = ALU_DK;
  roundRect(ctx, cx - dia / 2 - 1.15, -half - 0.5, 1.15, (half + 0.5) * 2, 0.35);
  ctx.fill();
  ctx.strokeStyle = 'rgba(200,214,230,0.28)';
  ctx.lineWidth = 0.16;
  ctx.stroke();

  // THE BARREL — round shading across the diameter is what says "cylinder" from above
  const g = ctx.createLinearGradient(cx - dia / 2, 0, cx + dia / 2, 0);
  g.addColorStop(0, '#161b23');
  g.addColorStop(0.38, RUBBER_HI);
  g.addColorStop(0.68, '#333b49');
  g.addColorStop(1, '#0f131a');
  ctx.fillStyle = g;
  roundRect(ctx, cx - dia / 2, -half, dia, half * 2, dia * 0.34);
  ctx.fill();

  // traction bands wrapped along the barrel — evenly spaced rings, drawn ACROSS it
  ctx.strokeStyle = 'rgba(190,205,220,0.26)';
  ctx.lineWidth = 0.16;
  const rings = Math.max(4, Math.round((half * 2) / 2.1));
  for (let i = 1; i < rings; i++) {
    const y = -half + (i * (half * 2)) / rings;
    ctx.beginPath();
    ctx.moveTo(cx - dia / 2 + 0.22, y);
    ctx.lineTo(cx + dia / 2 - 0.22, y);
    ctx.stroke();
  }
  // one highlight down the length — the cheapest possible "this is round"
  ctx.strokeStyle = 'rgba(214,228,244,0.30)';
  ctx.lineWidth = 0.2;
  ctx.beginPath();
  ctx.moveTo(cx - dia * 0.09, -half + 0.3);
  ctx.lineTo(cx - dia * 0.09, half - 0.3);
  ctx.stroke();

  // BEARING BLOCKS + shaft stubs at both ends
  for (const s of [1, -1] as const) {
    ctx.fillStyle = ALU_MID;
    roundRect(ctx, cx - 0.95, s * half - (s > 0 ? 0 : 1.5), 1.9, 1.5, 0.3);
    ctx.fill();
    ctx.fillStyle = ALU;
    ctx.beginPath();
    ctx.arc(cx, s * (half + 0.72), 0.42, 0, TAU);
    ctx.fill();
  }

  // LOADED: one thin line along the exit lip, where a POLLEN actually leaves
  ctx.strokeStyle = live(loaded, 0.6);
  ctx.lineWidth = 0.22;
  ctx.beginPath();
  ctx.moveTo(cx + dia / 2 - 0.14, -half + 0.6);
  ctx.lineTo(cx + dia / 2 - 0.14, half - 0.6);
  ctx.stroke();
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
 * Drawn in the MOUNT's frame (the caller rotates) — see `drawDrum` for `dist`/`span`.
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
  ctx.strokeStyle = live(loaded, 0.95);
  ctx.lineWidth = 0.3;
  ctx.beginPath();
  ctx.moveTo(lip + 0.4, -half + 0.2);
  ctx.lineTo(lip + 0.4, half - 0.2);
  ctx.stroke();
}

/**
 * The TURRET, drawn in the WORLD frame so it rotates independently of the chassis.
 *
 * Bolted at `turretLocal` — the same point `bbLaunch` fires from — so the ring is drawn
 * exactly where a POLLEN is born. A back- or corner-mounted turret really does sit back
 * there, rather than at a fixed rear-of-centre nudge.
 */
function drawTurret(ctx: CanvasRenderingContext2D, r: RobotState, loaded: boolean, twin = false): void {
  const ring = turretRadius(r.spec);
  const local = turretLocal(r.spec);
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
  ctx.strokeStyle = 'rgba(200,214,230,0.34)';
  ctx.lineWidth = 0.22;
  ctx.stroke();
  // gear teeth around the rim: the one detail that says "this rotates"
  ctx.lineWidth = 0.24;
  const teeth = Math.max(14, Math.round(ring * 6));
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * TAU;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * (ring - 0.32), Math.sin(a) * (ring - 0.32));
    ctx.lineTo(Math.cos(a) * ring, Math.sin(a) * ring);
    ctx.stroke();
  }
  // THE FEED HOLE, dead centre: a POLLEN comes UP through the middle of the ring, which is why
  // the shooter STRADDLES the ring rather than hanging off one side of it. Drawn on the
  // (non-rotating) ring, since a hole on the axis looks the same at every heading.
  ctx.fillStyle = 'rgba(6,9,13,0.85)';
  ctx.beginPath();
  ctx.arc(0, 0, BB_POLLEN_R + 0.15, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = 'rgba(200,214,230,0.28)';
  ctx.lineWidth = 0.18;
  ctx.stroke();

  // THE HEAD — everything below turns with `turretHeading`
  ctx.rotate(r.turretHeading);

  /**
   * ONE SHOOTER = A FLYWHEEL LAUNCHER: two PARALLEL PLATES with a wheel spinning between
   * them, and nothing else.
   *
   * There is no barrel. A closed body with a channel bored through it reads as a gun and is
   * not what anyone builds — an FTC launcher is a pair of side plates cut from polycarb or
   * aluminium, standoffs between them, and a compliant wheel that pinches the game piece
   * against the far plate on its way out. The gap between the plates is left EMPTY, because
   * the empty gap is the part a top-down viewer reads as "the POLLEN goes through here".
   */
  // A TWIN's two channels are ADJACENT and SHARE a centre plate, which is exactly why its
  // muzzles sit one channel-width apart (`BB_TWIN_BARREL_OFFSET` = GAP/2) — the shared plate
  // then falls out of the de-duplicated edge list below on its own.
  const chans = twin ? [-BB_TWIN_BARREL_OFFSET, BB_TWIN_BARREL_OFFSET] : [0];
  const gap = BB_LAUNCH_PLATE_GAP; // a POLLEN has to fit down it — same for one channel or two
  const plate = 0.42;
  // CENTRED ON THE RING, because a POLLEN comes up the hole in the MIDDLE of it: the feed is on
  // the turret axis, so the plates have to straddle that axis to receive it. Each end clears
  // the rim by `BB_LAUNCH_PLATE_OVERHANG` and no more; these are a launcher, not a rifle.
  const x1 = ring + BB_LAUNCH_PLATE_OVERHANG; // muzzle, just past the rim
  const x0 = -x1; // ...and the same again behind the axis
  const wheelX = ring * 0.6; // the flywheel: past the feed hole, before the muzzle

  // THE PLATES — one per DISTINCT channel wall, so a twin draws three, not four
  const edges = [...new Set(chans.flatMap((c) => [c - gap / 2, c + gap / 2]))];
  ctx.fillStyle = ALU_MID;
  ctx.strokeStyle = 'rgba(210,224,240,0.38)';
  ctx.lineWidth = 0.16;
  for (const y of edges) {
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
    ctx.moveTo(x, Math.min(...edges));
    ctx.lineTo(x, Math.max(...edges));
    ctx.stroke();
  }

  for (const off of chans) {
    // THE FLYWHEEL, spanning the channel on its axle: the POLLEN is pinched between it and the
    // opposite plate, so it sits ON the centreline — not in a pair.
    ctx.save();
    ctx.translate(wheelX, off);
    ctx.rotate(Math.PI / 2); // drawRoller lays its barrel along local y; the axle runs across
    drawRoller(ctx, 0, gap / 2 - 0.35, 1.5, loaded, 1.2);
    ctx.restore();

    // the exit, and the only accent: a short bar across the channel at the muzzle line
    ctx.strokeStyle = live(loaded, 0.95);
    ctx.lineWidth = 0.3;
    ctx.beginPath();
    ctx.moveTo(x1 - 0.3, off - gap / 2 + 0.3);
    ctx.lineTo(x1 - 0.3, off + gap / 2 - 0.3);
    ctx.stroke();
  }

  // LOADED reads as a POLLEN sitting IN the feed hole, waiting to be fed up between the plates
  // — which is both where it actually is and a better cue than a status pip.
  if (loaded) {
    ctx.fillStyle = GREEN;
    ctx.beginPath();
    ctx.arc(0, 0, BB_POLLEN_R * 0.78, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

/** a slim hopper-fill bar (stored POLLEN ÷ capacity) near the rear of the chassis. The one
 * number that changes what a driver should do next, so it is on the robot rather than only in
 * the HUD — you read it without looking away from the field. */
function drawHopperFill(ctx: CanvasRenderingContext2D, r: RobotState, hw: number): void {
  const cap = bbHopperCap(r.spec);
  const frac = Math.max(0, Math.min(1, r.hopper.length / cap));
  const w = hw * 1.1;
  const x = -w / 2;
  const y = hw - 2.6;
  ctx.fillStyle = 'rgba(10,14,20,0.75)';
  roundRect(ctx, x, y, w, 1.15, 0.4);
  ctx.fill();
  if (frac > 0) {
    ctx.fillStyle = GREEN;
    roundRect(ctx, x + 0.16, y + 0.16, Math.max(0.5, (w - 0.32) * frac), 0.83, 0.3);
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(150,163,180,0.45)';
  ctx.lineWidth = 0.22;
  roundRect(ctx, x, y, w, 1.15, 0.4);
  ctx.stroke();
}
