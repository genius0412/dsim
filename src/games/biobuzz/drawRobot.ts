import type { Artifact, ArtifactColor, RobotSpec, RobotState, Vec2, World } from '../../types';
import * as C from '../../config';
import { clamp } from '../../math';
import { robotsEnabled } from '../../sim/match';
import { drawDecal, ROBOT_TRIM, roundRect, tintColor } from '../../render/drawRobot';
import {
  clipToHull,
  drawAimMark,
  drawImportedBody,
  drawImportedFrontBack,
  drawImportedOutline,
  drawMouthState,
  frontArrowSpot,
} from '../../render/drawImported';
import { polyBounds, polyPointDepth } from '../../sim/imported';
import { bbDumperFrame, bbSideRollerOffsets } from './importMech';
import { accentFill, clampCosmetics } from '../../cosmetics';
import {
  BB_END_BAR_T,
  BB_FRONT_INK,
  BB_PLACE_MARK_R,
  BB_REAR_INK,
  bbBoxTubeGlyph,
  bbEndBarSegments,
  bbFrontMarks,
  drawChassisBody,
  drawChassisOutline,
  drawWheels,
} from './parts';
import {
  BB_HOOD_DEFAULT_DEG,
  BB_LAUNCH_LINE_FRAC,
  BB_LAUNCH_PLATE_GAP,
  BB_LAUNCH_PLATE_OVERHANG,
  BB_POLLEN_R,
  bbRampDeployS,
  BB_RAMP_OUT,
  BB_RAMP_PIVOT_BACK,
  BB_SIDE_ROLLER_BOSS_R,
  BB_SIDE_ROLLER_HUB_R,
  BB_SIDE_ROLLER_OUT,
  BB_SIDE_ROLLER_R,
  BB_SIDE_ROLLER_YOKE_BACK,
  BB_SIDE_ROLLER_YOKE_W,
  bbSideRollerYokeY,
  BB_TURRET_PITCH_MAX,
  BB_TURRET_PITCH_MIN,
  bbHopperCap,
  BB_BOX_TUBE_ARM_W,
  BB_BOX_TUBE_CLAW_REACH,
  BB_BOX_TUBE_JAW_L,
  BB_BOX_TUBE_JAW_OPEN,
  BB_BOX_TUBE_JAW_ROOT,
  BB_BOX_TUBE_PALM_BACK,
  BB_BOX_TUBE_SECTIONS,
  BB_BOX_TUBE_WALL,
  BB_BOX_TUBE_WRIST_E,
  BB_BOX_TUBE_WRIST_HALF,
  BB_FLOWERS,
  FLOWER_MOUTH,
  bbBoxTubePose,
  bbBoxTubeStages,
  type BbBoxTubeFrame,
} from './config';
import { type BbLauncherSpec, type BbLiftSpec, bbHasHead, bbIntakeKindOf, bbIsTurreted, bbLauncherOf, bbLiftOf } from './mechs';
import {
  EDGE_ANGLE,
  type BbMountPos,
  bbMouthFrame,
  bbShooterEdgeOf,
  turretLocal,
  turretRadius,
} from './mounts';
import { bbFixedAxisLocal, bbFixedFacing, bbFixedHood, bbFixedLocal, bbFlowerInReach, bbFootprint, bbMouths, bbPlacePointLocal, mouthAxes } from './robot';
import { BB_ALLIANCE_BLUE, ELEMENT_FILL, ELEMENT_LINE } from './draw';

/**
 * BIOBUZZ robot sprite (top-down).
 *
 * Copied and owned from `games/chain/drawRobot.ts`, with the catalyst mechanism, the beam
 * terrain ride and the crossing shudder deleted — BIOBUZZ has no second manipulator and no
 * published terrain, so there is nothing for any of them to depict. What is left is the part
 * that matters: A BUILD READS AT A GLANCE. The mounted sweeper, this build's LAUNCHER (one turret
 * on top · two individual turrets · a chassis-wide dumper tray), its BOX TUBE (a short tube at its
 * mount plus the placement-point marker), the ELEMENTS it is holding, and the FRONT/BACK marks —
 * a near-white light bar at the front rail and a deck arrow pointing at it (`bbFrontMarks`,
 * `parts.ts`, carries the design). Front = robot +x.
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
  accent: string,
  flapEvery = 2.3,
): void {
  const rh = dia / 2;
  const g = ctx.createLinearGradient(cx - rh, 0, cx + rh, 0);
  g.addColorStop(0, RUBBER_LO);
  // the lit crown carries the cosmetic accent — see `games/chain/drawRobot.ts`'s twin
  g.addColorStop(0.42, tintColor(RUBBER_HI, accent, 0.5));
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
  _held: readonly Artifact[] = [],
  screenUp: Vec2 = { x: 0, y: 1 },
  world?: World,
): void {
  void screenUp; // nothing lifts the chassis off the tile in BIOBUZZ — no terrain is published
  const hl = r.spec.length / 2;
  // the BIOBUZZ blue, not the shared `C.COLORS.blue` — owner bug 12, and `draw.ts`'s
  // `ELEMENT_FILL` header carries the measurement. Red stays shared: it was never the complaint.
  const color = r.alliance === 'blue' ? BB_ALLIANCE_BLUE : C.COLORS.red;
  const loaded = r.hopper.length > 0;
  // COSMETICS: see `render/drawRobot.ts`'s header — `accent`/`decal` land on `RobotSpec` on a
  // parallel lane; `clampCosmetics` is shape-safe against a spec that does not declare them yet.
  const cosm = clampCosmetics(r.spec);
  const accent = accentFill(cosm.accent, r.spec.chassisColor);
  // THE MECHANISM LOADOUT — see the file header. The launcher is never null; the tube may be.
  const launcher = bbLauncherOf(r.spec, BB_HOOD_DEFAULT_DEG);
  const lift = bbLiftOf(r.spec);
  // The intake reads ACTIVE whenever it can still collect — on (auto or the held command) AND
  // the hopper not full. Not "nearly empty": a driver needs to know the difference between
  // "my intake is off" and "my intake is on but I am full", and those are different actions.
  // ...and only while the robots are ENABLED: auto-intake is a standing assist, so without this it
  // read as running all through the auto→teleop transition, when the sim captures nothing.
  const live = !world || robotsEnabled(world);
  const intaking = live && (intakeOn || r.autoIntake) && r.hopper.length < bbHopperCap(r.spec);

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
  // AN IMPORTED ROBOT (`render/drawImported.ts`): the clip is its HULL, the body is the hull or the
  // import's own top-down picture, and over a PICTURE only state is drawn — the mouths' grab areas,
  // the held elements, the placement marker, the turrets' aim — never a second set of hardware.
  // Every branch below is gated on `imp`, so a standard robot draws exactly what it did.
  const imp = r.spec.imported;
  let pictured = false;
  const fx = bbFootprint(r.spec);
  ctx.save();
  if (imp) {
    clipToHull(ctx, imp);
    pictured = drawImportedBody(ctx, r, { fill: C.chassisFill(r.spec.chassisColor), accent, shadow: true });
  } else {
    ctx.beginPath();
    ctx.rect(-fx.rear, -fx.half, fx.rear + fx.front, fx.half * 2);
    ctx.clip();

    // the SHARED body (deck, rails, structure) and the drivetrain, so a robot is recognisably
    // the same object across games
    drawChassisBody(ctx, r, C.chassisFill(r.spec.chassisColor));
    drawDecal(ctx, hl, r.spec.width / 2, cosm.decal, accent);
    drawWheels(ctx, r, ROBOT_TRIM, accent);
  }

  if (pictured) drawMouthState(ctx, bbMouths(r.spec), intaking);
  else drawBiobuzzIntake(ctx, r, intaking, accent);

  // The turretless launcher (chassis-fixed). The dumper sits just inside its MOUNTED edge: rotate
  // the local frame to that edge and draw the same shape, so a left/right mount spans the chassis
  // LENGTH exactly as `bbLaunch` fires it. Turrets are drawn LAST, in the world frame, because
  // they rotate independently of the chassis. Geometry keys off `launcher.mount`, the slot's OWN
  // resolved position, rather than `r.spec.shooterMount` read cold.
  if (launcher.kind === 'dumper' && !pictured) {
    const edge = bbShooterEdgeOf({ shooterMount: launcher.mount });
    const g = dumperFrame(r.spec, edge);
    ctx.save();
    ctx.rotate(EDGE_ANGLE[edge]);
    ctx.translate(0, g.lateral);
    drawDumper(ctx, g.dist, g.span, loaded, g.room);
    ctx.restore();
  }

  // The BOX TUBE's BASE — its pivot plates, pulley and spool, bolted to the deck at its mount.
  // The tower above them is drawn after the clip (`drawBoxTubeTower`): leaning out over a
  // FLOWER it passes the footprint, and it stands above everything on the deck.
  if (lift && !pictured) drawBoxTubeBase(ctx, r.spec, lift);

  // WHICH END IS THE FRONT — light bar, deck arrow, hazard bar. Drawn LAST inside the clip, over
  // every mechanism, because a cue that a sweeper can cover is not a cue. `bbFrontMarks`'
  // header (`parts.ts`) is the language and the reason it is not the alliance colour. An import
  // draws the same two marks on its hull: the bar along the edge(s) facing forward, the arrow at
  // its centroid.
  if (imp) {
    const rings = bbHasHead(launcher)
      ? [launcher.mount, ...(launcher.kind === 'twinturret' && launcher.mount2 ? [launcher.mount2] : [])].map((m) => ({
          ...turretLocal(r.spec, m),
          r: turretRadius(r.spec),
        }))
      : [];
    drawImportedFrontBack(ctx, imp, BB_FRONT_INK, BB_END_BAR_T, rings);
  }
  else drawFrontBack(ctx, r.spec);

  // the silhouette line — neutral; the alliance is the name label + the fills
  if (imp) drawImportedOutline(ctx, imp, ROBOT_TRIM);
  else drawChassisOutline(ctx, r, ROBOT_TRIM);

  ctx.restore(); // ...end of the footprint clip

  // THE INTAKE'S REACH PAST THE FRAME — siderollers/ramp only, and only out here, unclipped
  // (see the function header). Over a picture only the RAMP, whose deploy is state.
  if (!pictured || bbIntakeKindOf(r.spec) === 'ramp') drawBiobuzzIntakeReach(ctx, r, intaking, world);

  // WHAT IT IS HOLDING, at fixed slots on the deck — before the turrets, which sit on top.
  drawHeldElements(ctx, r, launcher, lift);

  // THE PLACEMENT MARKER — outside the clip (see above), lit while a FLOWER ring is in reach —
  // and the Box Tube's tower: folded, or deployed with its claw over that FLOWER's bore. Over a
  // picture the folded tower is already in it; only a DEPLOYED one is state.
  if (lift) {
    const flower = world !== undefined ? bbFlowerInReach(world, r) : null;
    drawPlaceMarker(ctx, r.spec, flower !== null);
    if (!pictured || flower !== null) drawBoxTubeTower(ctx, r, lift, flower);
  }

  ctx.restore();

  if (bbIsTurreted(launcher) && pictured) {
    // over a picture: each turret's AIM at its own cell, the NECTAR one with the alliance rim
    const pollen = r.hopper.some((c) => c === 'yellow');
    const nectar = r.hopper.some((c) => c === 'red' || c === 'blue');
    const ring = turretRadius(r.spec);
    const at = (pos: BbMountPos): Vec2 => {
      const l = turretLocal(r.spec, pos);
      return {
        x: r.pos.x + Math.cos(r.heading) * l.x - Math.sin(r.heading) * l.y,
        y: r.pos.y + Math.sin(r.heading) * l.x + Math.cos(r.heading) * l.y,
      };
    };
    const p0 = at(launcher.mount);
    if (launcher.kind === 'twinturret') {
      drawAimMark(ctx, p0.x, p0.y, r.turretHeading, ring, pollen);
      const p1 = at(launcher.mount2 ?? launcher.mount);
      drawAimMark(ctx, p1.x, p1.y, r.bbTurret2Heading ?? r.turretHeading, ring, nectar, color);
    } else {
      drawAimMark(ctx, p0.x, p0.y, r.turretHeading, ring, loaded);
    }
  } else if (launcher.kind === 'fixed' && pictured) {
    // over a picture: where the FIXED shooter is aimed, from its release
    const loc = bbFixedLocal(r.spec);
    const x = r.pos.x + Math.cos(r.heading) * loc.x - Math.sin(r.heading) * loc.y;
    const y = r.pos.y + Math.sin(r.heading) * loc.x + Math.cos(r.heading) * loc.y;
    drawAimMark(ctx, x, y, r.heading + bbFixedFacing(r.spec), turretRadius(r.spec), loaded);
  } else if (launcher.kind === 'fixed') {
    // THE FIXED SHOOTER: the turret's own head, with no ring under it, square to its edge and held
    // at the build's hood angle — the sim's release (`bbFixedLocal`) is this head's lip, an
    // import's placed lip included (`bbFixedAxisLocal`, the 3D head's own axis)
    drawTurret(ctx, r, launcher.mount, r.heading + bbFixedFacing(r.spec), bbFixedHood(r.spec), loaded, null, true, bbFixedAxisLocal(r.spec));
  } else if (bbIsTurreted(launcher)) {
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
 * THE FRONT/BACK LANGUAGE, 2D half. `bbFrontMarks` (`parts.ts`) is the geometry and the header
 * there is the design; this only fills it. In the ROBOT frame, already translated and rotated,
 * and inside the footprint clip.
 *
 * The bars are drawn with a thin dark LIP on their inboard edge. Without it a near-white bar on a
 * light cosmetic chassis (`chassisFill('white')`) has no boundary at all, and the whole point of
 * the mark is that it reads against whatever the player painted the robot.
 */
function drawFrontBack(ctx: CanvasRenderingContext2D, spec: RobotSpec): void {
  const m = bbFrontMarks(spec);

  // 1. THE LIGHT BAR, full width at the front edge — less wherever a mechanism stands on it
  for (const sg of bbEndBarSegments(m.front)) {
    ctx.fillStyle = BB_FRONT_INK;
    ctx.fillRect(m.front.x0, sg.y0, m.front.x1 - m.front.x0, sg.y1 - sg.y0);
    ctx.fillStyle = 'rgba(17,21,27,0.55)';
    ctx.fillRect(m.front.x0, sg.y0, 0.18, sg.y1 - sg.y0);
  }

  // 2. THE REAR RAIL, full width — the chassis' own dark, no stripes (see `bbFrontMarks`)
  ctx.fillStyle = BB_REAR_INK;
  for (const sg of bbEndBarSegments(m.rear)) ctx.fillRect(m.rear.x0, sg.y0, m.rear.x1 - m.rear.x0, sg.y1 - sg.y0);

  // 3. THE DECK ARROW, pointing at the light bar and away from the plain end — where the deck is
  // clear of the mechanisms (`bbFrontMarks`), or not at all
  if (!m.arrow) return;
  const a = m.arrow;
  ctx.fillStyle = BB_FRONT_INK;
  ctx.beginPath();
  ctx.moveTo(a.apex, a.cy);
  ctx.lineTo(a.base, a.cy + a.half);
  ctx.lineTo(a.base, a.cy - a.half);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(17,21,27,0.55)';
  ctx.lineWidth = 0.22;
  ctx.stroke();
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
function drawBiobuzzIntake(ctx: CanvasRenderingContext2D, r: RobotState, on: boolean, accent: string): void {
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

    // THE FRONT BRACE, tying the two plates at the tip (owner, 2026-09-19: "add a bracing across
    // the two intake plates in the front"). The same part the 3D scene draws
    // (`robot:intake:brace:*`) and the same thing the collider's lintel + pocket filler are, so
    // the map, the 3D view and the solve all show one closed rectangular front instead of a fork.
    // From above it is simply a bar: the height it clears an element at is the side view's story.
    roundRect(ctx, d - 0.55, -h, 0.55, h * 2, 0.18);
    ctx.fill();
    ctx.stroke();

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
      drawRoller(ctx, inner, h - 1.35, 0.8, on, accent, 3.2);
    }
    drawRoller(ctx, outer, h - 0.75, 1.5, on, accent);
    ctx.restore();
  }
}

/**
 * How far DEPLOYED the ramp is drawn, 0 (folded) .. 1 (deployed) — the 2D twin of the 3D scene's
 * ease, off the same `bbRampAt` stamp and the same `BB_RAMP_DEPLOY_S` window, smoothstepped. A
 * caller with no `World` (the builder's static preview) has no clock to ease against, so it
 * draws the end pose `bbRampOut` alone names, the same fallback the box tube's marker would need
 * if it ever ran clockless.
 */
function bbRampEaseFrac(r: RobotState, world: World | undefined): number {
  if (!world) return r.bbRampOut ? 1 : 0;
  const t = clamp((world.time - (r.bbRampAt ?? -Infinity)) / bbRampDeployS(r.spec), 0, 1);
  const e = t * t * (3 - 2 * t); // smoothstep — matches `scene/renderRobots.ts`'s `smoothstep01`
  return r.bbRampOut ? e : 1 - e;
}

/**
 * ARCHETYPE HARDWARE THAT REACHES PAST THE FOOTPRINT (`siderollers`, `ramp`) — the `sweeper`
 * draws nothing here, and `drawBiobuzzIntake` above is unchanged for it (the RENDER lane pins
 * its pixels). Called OUTSIDE `drawBiobuzzRobot`'s footprint clip, same as the placement marker:
 * a side roller sits `BB_SIDE_ROLLER_OUT` past the tip line and a deployed ramp further still,
 * both past `bbFootprint`, so a stroke drawn inside that clip would vanish at the frame edge.
 */
export function drawBiobuzzIntakeReach(ctx: CanvasRenderingContext2D, r: RobotState, on: boolean, world: World | undefined): void {
  const kind = bbIntakeKindOf(r.spec);
  if (kind === 'sweeper') return;
  for (const m of bbMouths(r.spec)) {
    const f = bbMouthFrame(m, r.spec.length / 2, r.spec.width / 2);
    const tip = f.depth;
    ctx.save();
    ctx.translate(f.ox, f.oy);
    ctx.rotate(f.rot);

    if (kind === 'siderollers') {
      const wheelV = bbSideRollerOffsets(r.spec, mouthAxes(m, r.spec.length / 2, r.spec.width / 2));
      for (const s of [1, -1] as const) {
        // AT THE EDGE (owner, 2026-09-20), not the centreline; an IMPORT's inside its own hull
        const y = s * wheelV[s === 1 ? 0 : 1];
        const x = tip + BB_SIDE_ROLLER_OUT;
        // ⚠️ **A REAR YOKE, AND IT MAY NOT COVER THE WHEEL** (owner, 2026-09-21, rejecting the
        // housed draft this replaces: "The side rollers are rendered as being covered and still
        // sticking out a ton. It cant be covered fully because it needs to actually touch the
        // balls"). That draft capped the wheel with a plate on the WHEEL'S OWN RADIUS, which in
        // plan is the whole wheel. The yoke is the same one `scene/renderRobots.ts` builds: a
        // narrow strap from the side arm's rail to the AXLE, ending in a bearing boss, with
        // nothing drawn forward of the axle line except that boss.
        const backX = x - BB_SIDE_ROLLER_YOKE_BACK;
        const armY = s * bbSideRollerYokeY(f.half);
        // the DIAGONAL strap, rail to axle, then the bearing BOSS — the same two parts, at the
        // same places, `scene/renderRobots.ts` builds. Drawn as a plain quad rather than a
        // rounded rect because it is not axis-aligned: the rail sits further outboard than the
        // axle, and a bar parallel to the rail would never reach it.
        const nx = (y - armY) / Math.hypot(x - backX, y - armY);
        const ny = -(x - backX) / Math.hypot(x - backX, y - armY);
        const hwid = BB_SIDE_ROLLER_YOKE_W / 2;
        ctx.fillStyle = 'rgba(152,163,178,0.32)';
        ctx.strokeStyle = ALU;
        ctx.lineWidth = 0.14;
        ctx.beginPath();
        ctx.moveTo(backX + nx * hwid, armY + ny * hwid);
        ctx.lineTo(x + nx * hwid, y + ny * hwid);
        ctx.lineTo(x - nx * hwid, y - ny * hwid);
        ctx.lineTo(backX - nx * hwid, armY - ny * hwid);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, BB_SIDE_ROLLER_BOSS_R, 0, TAU);
        ctx.fill();
        ctx.stroke();
        // the wheel itself — hub and lugged tread, the same two parts the 3D wheel is built from
        // and the same rubber shading the sweeper's own roller wears. Drawn AFTER the yoke, so
        // the tread is never under it.
        ctx.fillStyle = on ? RUBBER_HI : RUBBER_LO;
        ctx.beginPath();
        ctx.arc(x, y, BB_SIDE_ROLLER_R, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = 'rgba(210,224,240,0.35)';
        ctx.lineWidth = 0.12;
        ctx.stroke();
        // the LUGS: twelve radial ticks from the hub out to the tread, the plan-view of the same
        // 12 facets the 3D tread is lugged into (`sideRollerTreadGeometry`).
        ctx.strokeStyle = on ? 'rgba(34,197,94,0.38)' : 'rgba(190,205,220,0.26)';
        ctx.lineWidth = 0.1;
        ctx.beginPath();
        for (let k = 0; k < 12; k++) {
          const a = (Math.PI / 12) * (1 + 2 * k);
          ctx.moveTo(x + Math.cos(a) * BB_SIDE_ROLLER_HUB_R, y + Math.sin(a) * BB_SIDE_ROLLER_HUB_R);
          ctx.lineTo(x + Math.cos(a) * BB_SIDE_ROLLER_R, y + Math.sin(a) * BB_SIDE_ROLLER_R);
        }
        ctx.stroke();
        ctx.fillStyle = ALU_MID;
        ctx.beginPath();
        ctx.arc(x, y, BB_SIDE_ROLLER_HUB_R, 0, TAU);
        ctx.fill();
      }
    } else {
      // 'ramp' — rails from the pivot line out to the eased reach, plus the crossbar joining
      // them at the outer end. At frac 0 the rails have no length left and the crossbar sits
      // ON the pivot line: the "folded bar across the mouth, over the roller" IS this outline's
      // own resting state, not a second drawing.
      const frac = bbRampEaseFrac(r, world);
      const railY = f.half - 0.7; // just inside the side plates (`h − 0.55` is their inner face)
      const pivotX = tip - BB_RAMP_PIVOT_BACK;
      // `BB_RAMP_OUT` is measured past the TIP line (the sim's reach box), so the crossbar's
      // travel from the pivot is the pivot's own set-back plus it: deployed, it lands at exactly
      // `tip + BB_RAMP_OUT`, where the 3D scene and the retrieval gate put it
      const outX = pivotX + (BB_RAMP_PIVOT_BACK + BB_RAMP_OUT) * frac;
      ctx.strokeStyle = on ? 'rgba(34,197,94,0.55)' : 'rgba(210,224,240,0.45)';
      ctx.lineWidth = 0.18;
      ctx.beginPath();
      for (const s of [1, -1] as const) {
        ctx.moveTo(pivotX, s * railY);
        ctx.lineTo(outX, s * railY);
      }
      ctx.moveTo(outX, -railY);
      ctx.lineTo(outX, railY);
      ctx.stroke();
    }
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
/** where the dumper is drawn — the sim's release line in its edge's frame (`bbDumperFrame`) */
export const dumperFrame = bbDumperFrame;

function drawDumper(ctx: CanvasRenderingContext2D, dist: number, span: number, loaded: boolean, room?: number): void {
  const half = span * BB_LAUNCH_LINE_FRAC;
  // the shaft it swings about, well inside the frame — on an IMPORT, no deeper than the hull behind
  // its placed lip (`bbDumperFrame`'s `room`)
  const pivot = dist - (room === undefined ? 7.4 : Math.max(2, Math.min(7.4, room - 0.5)));
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
  /** the NECTAR turret's alliance rim colour (`null` for a POLLEN-only or single turret). It is
   * the only colour this head takes: the cosmetic accent used to tint the flywheel here and no
   * longer reaches the shooter at all (owner, 2026-09-21: "keep the flywheel black"). */
  nectarAccent: string | null,
  /** a FIXED shooter: the head alone on a square riser, no slew ring, no teeth, no feed hole */
  ringless = false,
  /** the head's axis, robot-local, when it is not the cell's (`bbFixedAxisLocal`) */
  at?: { x: number; y: number },
): void {
  const ring = turretRadius(r.spec);
  const local = at ?? turretLocal(r.spec, pos);
  const cx = r.pos.x + Math.cos(r.heading) * local.x - Math.sin(r.heading) * local.y;
  const cy = r.pos.y + Math.sin(r.heading) * local.x + Math.cos(r.heading) * local.y;
  ctx.save();
  ctx.translate(cx, cy);
  if (ringless) {
    // the riser it is bolted to (`buildFixedShooter`'s, the same square), turned with the head
    const side = Math.max(1.2, ring * 1.3);
    ctx.save();
    ctx.rotate(heading);
    ctx.fillStyle = ALU_DK;
    ctx.fillRect(-side / 2, -side / 2, side, side);
    ctx.strokeStyle = 'rgba(200,214,230,0.34)';
    ctx.lineWidth = 0.22;
    ctx.strokeRect(-side / 2, -side / 2, side, side);
    ctx.restore();
  } else {

  // THE SLEW RING STAYS WITH THE CHASSIS. The toothed ring is bolted to the frame and the head
  // turns on it, so drawing it inside the rotation makes the whole assembly spin as one piece,
  // which is not how a turret works.
  ctx.fillStyle = ALU_DK;
  ctx.beginPath();
  ctx.arc(0, 0, ring, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = nectarAccent ?? 'rgba(200,214,230,0.34)';
  ctx.lineWidth = nectarAccent ? 0.5 : 0.22;
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
  if (nectarAccent) {
    // the NECTAR turret's SECOND rim, inside the teeth — the shape half of the distinction
    ctx.strokeStyle = nectarAccent;
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
  }

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
  //
  // ⚠️ `RUBBER_HI`, NOT THE ACCENT — `tintColor(RUBBER_HI, RUBBER_HI, …)` is RUBBER_HI, so this is
  // the bare crown every build had before cosmetics. The flywheel is BLACK whatever the accent
  // (owner, 2026-09-21); the intake rollers above still take it.
  ctx.save();
  ctx.translate(wheelX, 0);
  ctx.rotate(Math.PI / 2); // drawRoller lays its barrel along local y; the axle runs across
  drawRoller(ctx, 0, gap / 2 - 0.35, 1.5, live, RUBBER_HI, 1.2);
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

/** fill one tower-frame rectangle [u0,u1] × [v0,v1], drawn in the robot frame — and outline it
 * in the machined-edge light when `edge` is set, the same stroke the rest of the sprite's
 * aluminium takes, so a part on the dark deck reads from the match camera */
function towerRect(ctx: CanvasRenderingContext2D, f: BbBoxTubeFrame, u0: number, u1: number, v0: number, v1: number, edge = false): void {
  ctx.save();
  ctx.translate(f.outer.x, f.outer.y);
  ctx.rotate(Math.atan2(f.uy, f.ux));
  ctx.fillRect(u0, v0, u1 - u0, v1 - v0);
  if (edge) {
    ctx.strokeStyle = 'rgba(210,224,240,0.6)';
    ctx.lineWidth = 0.16;
    ctx.strokeRect(u0, v0, u1 - u0, v1 - v0);
  }
  ctx.restore();
}

/** the Box Tube's drive parts — the pivot pulley, the string spool, the wrist servo */
const TUBE_DRIVE = '#2b313a';

/**
 * The BOX TUBE's BASE, from above: the two pivot plates and the pulley and spool outside them —
 * the same boxes (`bbBoxTubeStowedBoxes`, `config.ts`) the 3D base and its collider are built
 * from.
 */
function drawBoxTubeBase(ctx: CanvasRenderingContext2D, spec: RobotSpec, lift: BbLiftSpec): void {
  const g = bbBoxTubeGlyph(spec, lift.mount, bbPlacePointLocal(spec));
  for (const b of g.boxes) {
    if (b.what !== 'plate' && b.what !== 'drum') continue;
    ctx.fillStyle = b.what === 'plate' ? ALU_DK : TUBE_DRIVE;
    towerRect(ctx, g.frame, b.u0, b.u1, b.v0, b.v1);
  }
}

/**
 * The BOX TUBE's TOWER, from above. FOLDED it is the mast (a hollow square: a box tube from above
 * is its walls), the wrist servo on top and the end of the folded claw beside it. DEPLOYED —
 * while `bbFlowerInReach` names a FLOWER, the predicate the 3D tower and the marker read — it is
 * the pose `bbBoxTubePose` solves: the mast drawn out to its leaning tip, and the claw arm from
 * the tip to that FLOWER's bore with the jaws open over it. 2D has no ease, so it shows the two
 * end poses the 3D tower runs between.
 */
function drawBoxTubeTower(ctx: CanvasRenderingContext2D, r: RobotState, lift: BbLiftSpec, flower: number | null): void {
  const spec = r.spec;
  const g = bbBoxTubeGlyph(spec, lift.mount, bbPlacePointLocal(spec));
  const f = g.frame;
  const w0 = BB_BOX_TUBE_SECTIONS[0];
  const wTop = BB_BOX_TUBE_SECTIONS[BB_BOX_TUBE_SECTIONS.length - 1];
  let s = 0;
  let psi = Math.atan2(f.sy, f.sx);
  let deployed = false;
  if (flower !== null) {
    const fl = BB_FLOWERS[flower];
    const n = FLOWER_MOUTH[fl.wall];
    const c = Math.cos(-r.heading);
    const sn = Math.sin(-r.heading);
    const dx = fl.x - r.pos.x;
    const dy = fl.y - r.pos.y;
    const pose = bbBoxTubePose(
      f,
      bbBoxTubeStages(f.placeDist),
      { x: dx * c - dy * sn, y: dx * sn + dy * c },
      { x: n.x * c - n.y * sn, y: n.x * sn + n.y * c },
      r.z ?? 0,
    );
    s = pose.s;
    psi = pose.psi;
    deployed = true;
  }
  // the mast: the base tube's section, drawn out to the tip when it leans
  const m0 = Math.min(0, s) - w0 / 2;
  const m1 = Math.max(0, s) + w0 / 2;
  ctx.fillStyle = 'rgba(6,9,13,0.55)';
  towerRect(ctx, f, m0 - 0.12, m1 + 0.12, -w0 / 2 - 0.12, w0 / 2 + 0.12);
  ctx.fillStyle = ALU_MID;
  towerRect(ctx, f, m0, m1, -w0 / 2, w0 / 2, true);
  // the top stage's mouth, at the tip
  ctx.fillStyle = ALU;
  towerRect(ctx, f, s - wTop / 2, s + wTop / 2, -wTop / 2, wTop / 2);
  ctx.fillStyle = ALU_DK;
  const bore = wTop / 2 - BB_BOX_TUBE_WALL;
  towerRect(ctx, f, s - bore, s + bore, -bore, bore);
  // the wrist and the claw it carries, turned to the claw's bearing at the tip
  const tx = f.outer.x + s * f.ux;
  const ty = f.outer.y + s * f.uy;
  const halfW = BB_BOX_TUBE_ARM_W / 2;
  ctx.save();
  ctx.translate(tx, ty);
  ctx.rotate(psi);
  ctx.fillStyle = TUBE_DRIVE;
  ctx.fillRect(-BB_BOX_TUBE_WRIST_HALF, -BB_BOX_TUBE_WRIST_HALF * 0.8, BB_BOX_TUBE_WRIST_HALF * 2, BB_BOX_TUBE_WRIST_HALF * 1.6);
  ctx.strokeStyle = 'rgba(210,224,240,0.45)';
  ctx.lineWidth = 0.12;
  ctx.strokeRect(-BB_BOX_TUBE_WRIST_HALF, -BB_BOX_TUBE_WRIST_HALF * 0.8, BB_BOX_TUBE_WRIST_HALF * 2, BB_BOX_TUBE_WRIST_HALF * 1.6);
  if (!deployed) {
    // folded: the claw hangs beside the mast, so from above it is the yoke's end
    ctx.fillStyle = ALU_DK;
    ctx.fillRect(BB_BOX_TUBE_WRIST_HALF - 0.25, -halfW - 0.06, BB_BOX_TUBE_WRIST_E + 0.4 - BB_BOX_TUBE_WRIST_HALF, halfW * 2 + 0.12);
  } else {
    // deployed: the arm out to the palm, and the two jaws open round the bore
    const palm = BB_BOX_TUBE_CLAW_REACH - BB_BOX_TUBE_PALM_BACK;
    ctx.fillStyle = 'rgba(6,9,13,0.75)';
    ctx.fillRect(BB_BOX_TUBE_WRIST_HALF - 0.4, -halfW - 0.15, palm - BB_BOX_TUBE_WRIST_HALF + 0.55, halfW * 2 + 0.3);
    ctx.fillStyle = ALU_DK;
    ctx.fillRect(BB_BOX_TUBE_WRIST_HALF - 0.25, -halfW, palm - BB_BOX_TUBE_WRIST_HALF + 0.25, halfW * 2);
    const tipU = palm + BB_BOX_TUBE_JAW_L * Math.cos(BB_BOX_TUBE_JAW_OPEN);
    const tipV = BB_BOX_TUBE_JAW_ROOT + BB_BOX_TUBE_JAW_L * Math.sin(BB_BOX_TUBE_JAW_OPEN);
    ctx.lineCap = 'round';
    for (const [style, width] of [['rgba(6,9,13,0.75)', 0.34], ['rgba(210,224,240,0.85)', 0.16]] as const) {
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      for (const sg of [1, -1] as const) {
        ctx.beginPath();
        ctx.moveTo(palm, sg * BB_BOX_TUBE_JAW_ROOT);
        ctx.lineTo(tipU, sg * tipV);
        ctx.stroke();
      }
    }
    ctx.lineCap = 'butt';
  }
  ctx.restore();
}

/**
 * THE PLACEMENT POINT — a plain ring at `bbPlacePointLocal`, the ONE point the sim tests FLOWER
 * reach from. HOLLOW normally; FILLED and green while `bbFlowerInReach` says a FLOWER ring is
 * within tolerance, which is exactly the state in which the place buttons do something. It is a
 * cue, not hardware: nothing of the robot reaches out to it until the tower deploys.
 */
function drawPlaceMarker(ctx: CanvasRenderingContext2D, spec: RobotSpec, lit: boolean): void {
  const p = bbPlacePointLocal(spec);
  if (!p) return;
  const R = BB_PLACE_MARK_R;
  const ink = lit ? GREEN : 'rgba(226,234,242,0.92)';
  ctx.strokeStyle = 'rgba(6,9,13,0.75)';
  ctx.lineWidth = 0.62;
  ctx.beginPath();
  ctx.arc(p.x, p.y, R, 0, TAU);
  ctx.stroke();
  if (lit) {
    ctx.fillStyle = 'rgba(34,197,94,0.55)';
    ctx.fill();
  }
  ctx.strokeStyle = ink;
  ctx.lineWidth = 0.28;
  ctx.stroke();
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
 * the turret rings, the Box Tube and the deck ARROW — while staying inside the
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
    // the tube aims at the placement point, which moves with the footprint, i.e. the sweepers
    spec.intakeMount ?? '',
  ].join('|');
  // an IMPORT's layout is searched on its HULL, so its whole descriptor is part of the key
  const imp = spec.imported;
  const fullKey = imp ? `${key}|${JSON.stringify(imp)}` : key;
  const hit = heldLayoutCache.get(fullKey);
  if (hit) return hit;

  const hl = spec.length / 2;
  const hw = spec.width / 2;
  const box = imp ? polyBounds(imp.hull) : { minX: -hl, maxX: hl, minY: -hw, maxY: hw };
  const circles: { x: number; y: number; r: number }[] = [];
  if (bbHasHead(launcher)) {
    const ring = turretRadius(spec) + 0.3;
    circles.push({ ...turretLocal(spec, launcher.mount), r: ring });
    if (launcher.kind === 'twinturret' && launcher.mount2) circles.push({ ...turretLocal(spec, launcher.mount2), r: ring });
  }
  // the DECK ARROW's own keep-out, read off `bbFrontMarks` rather than typed: the arrow grew
  // when the front/back language landed (2026-09-22) and a stale literal here would have let a
  // held disc sit on top of the one mark that says which way the robot faces. The end BARS are
  // not in this list — they are at the rails, where `hl - 1.2` already keeps a disc out. An
  // IMPORT's arrow is `frontArrowSpot`'s, clear of the same rings.
  if (imp) {
    const a = frontArrowSpot(imp.hull, circles.map((o) => ({ ...o, r: o.r - 0.3 })));
    circles.push({ x: a.x, y: a.y, r: Math.max(a.len / 2, a.half) });
  } else {
    const arrow = bbFrontMarks(spec).arrow;
    if (arrow) circles.push({ x: (arrow.apex + arrow.base) / 2, y: arrow.cy, r: Math.max((arrow.apex - arrow.base) / 2, arrow.half) });
  }
  // NOT the wheels: on a 13.5 in chassis with a centre turret there is no spot that clears both
  // the ring and all four wheels, and a disc over a tyre still reads — a disc over a ring does not.
  const tube = lift ? bbBoxTubeGlyph(spec, lift.mount, bbPlacePointLocal(spec)) : null;

  const clearance = (px: number, py: number): number => {
    // inside the frame rail, hard — an import's frame is its hull
    let c = imp
      ? (polyPointDepth(imp.hull, { x: px, y: py }) - 1.2 - HELD_R) * 4
      : Math.min(hl - 1.2 - HELD_R - Math.abs(px), hw - 1.2 - HELD_R - Math.abs(py)) * 4;
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
  const midX = imp ? (box.minX + box.maxX) / 2 : 0;
  const midY = imp ? (box.minY + box.maxY) / 2 : 0;
  HELD_LAYOUTS.forEach((layout, li) => {
    for (let cx = box.minX; cx <= box.maxX + 1e-9; cx += step) {
      for (let cy = box.minY; cy <= box.maxY + 1e-9; cy += step) {
        let score = Infinity;
        for (const o of layout) score = Math.min(score, clearance(cx + o.x, cy + o.y));
        // prefer the compact cluster, then a spot near the chassis middle, when clearances tie
        score += (li === 0 ? 0.25 : 0) - 0.01 * Math.hypot(cx - midX, cy - midY);
        if (score > bestScore) {
          bestScore = score;
          best = layout.map((o) => ({ x: cx + o.x, y: cy + o.y }));
        }
      }
    }
  });
  if (heldLayoutCache.size > 256) heldLayoutCache.clear();
  heldLayoutCache.set(fullKey, best);
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
  // an IMPORT's slots are searched on its hull (`bbHeldSlots`), not its bounding box
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
