import type { Artifact, RobotCommand, World, PathPoint, RobotState } from '../types';
import { COLORS } from '../config';
import { Camera } from './camera';
import { drawRobot } from './drawRobot';
import { gameOf } from '../games';
import { robotsEnabled } from '../sim/match';
import type { GameModule, GameScene } from '../games/module';
import { bbHeightNow } from '../games/biobuzz/config';

/**
 * The letterbox around the field follows the app theme (the FIELD itself never does).
 *
 * Read the theme off <html> rather than `getComputedStyle` of the canvas: the canvas
 * carries no themed background of its own, and going through the cascade here would
 * force a style flush on every frame of the render loop.
 */
const backdropColor = (): string =>
  typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark'
    ? COLORS.backdropDark
    : COLORS.backdrop;

/** the held list handed to a robot carrying nothing — shared, never written to */
const NO_HELD: readonly Artifact[] = [];

/**
 * How far above the top of a robot its name label floats, in field inches, when it is projected
 * through a 3D scene camera. The top is the build's own height right now (`bbHeightNow`: stowed
 * before the match, deployed after), which caps every mechanism on it.
 *
 * ⚠️ **It was a flat 30 in above the base** (owner, 2026-09-25: "WAY too high"). That number was
 * written when a build could stand 29 in; the dial now stops at 18 and the default is 14, so the
 * label hung a full robot-height over the robot and read as floating over the field.
 */
const LABEL_CLEARANCE = 3;
/** how far above the projected point the text is drawn, in CSS px — the 3D projection puts the
 * anchor at the top of the robot, and this lifts the baseline clear of it. */
const LABEL_SCREEN_LIFT = 4;

/**
 * THE DARK OUTLINE UNDER EVERY LABEL, and it is what makes the alliance colours work.
 *
 * A label follows its robot anywhere, so its ground is not one colour: the dark mat, the
 * lighter tiles, the LIGHT backdrop when a robot is pinned to the far wall, and in 3D whatever
 * the scene has behind it. No single fill reads on all of those. The stroke does — it is 9.34:1
 * on the backdrop — so the fill only has to clear AA against the DARK grounds, which is exactly
 * what `COLORS.redLabel`/`blueLabel` are picked for.
 */
/**
 * ⚠️ **OPAQUE, AND THAT IS WHAT LETS THE 3D MAT BE A REAL TILE GREY (owner, 2026-09-21).**
 *
 * It was `rgba(20,22,26,0.8)`. At 0.8 the ground showed through the halo, so the glyph's
 * effective surround was part STROKE and part MAT — which is why `contrast.mjs` had to measure
 * the fill against the LIGHTEST GROUND a label crosses and why lifting the mat one step failed
 * AA at 4.27:1. An FTC field tile is grey EVA foam (AndyMark am-2499, spec "Gray"), nowhere
 * near the near-black the mat was, and that ceiling was the only thing holding it there.
 *
 * Opaque, the halo is a KNOWN colour under every glyph whatever the ground is, so the governing
 * pair becomes fill-against-its-own-stroke — which `contrast.mjs` already measures and which
 * does not move when the field does. The stroke's own job is then to stay visible against the
 * ground, which is a pair that gets EASIER as the mat lightens.
 */
const LABEL_STROKE = 'rgb(20,22,26)';

/**
 * WHO TO PRINT OVER A ROBOT: the person driving it, else the thing they built.
 *
 * The username is the answer to the question the label is asked mid-match ("who is that"), and
 * it is why the team number is dropped with it — `12345 Kraken` is a build's identity, and
 * stacking it in front of an account name says the same thing twice in a label that has to be
 * read at a glance. The fallback is unchanged from before there were usernames, and it is what
 * every solo/bot/replay/old-server frame draws.
 */
const labelFor = (r: RobotState, driverName?: (robotId: number) => string | undefined): string => {
  const who = driverName?.(r.id);
  if (who) return who;
  return r.spec.teamNumber > 0 ? `${r.spec.teamNumber} ${r.spec.name}` : r.spec.name;
};

/** a label's fill: its robot's ALLIANCE, in the tints tuned for 12-px type on the field. */
const labelInk = (r: RobotState): string => (r.alliance === 'red' ? COLORS.redLabel : COLORS.blueLabel);

export class Renderer {
  readonly camera = new Camera();

  /**
   * THE LIVE 3D SCENE, or null on the 2D path (`docs/biobuzz/plan-3d.md` §4.7).
   *
   * Set by whoever owns the scene (`GameController.syncScene` / `teardownScene`) — this class
   * never creates one and never renders one. It is here for exactly ONE thing: the overlay pass
   * below draws camera-space text (name labels, an auto path) over a scene it does not know the
   * camera of, and `GameScene.project` is how it asks. Null, or a scene that does not implement
   * `project`, falls back to the 2D camera exactly as before — which is what every DECODE and
   * Chain Reaction frame does, and what a BIOBUZZ 3D frame did before this existed (labels at
   * the top-down positions, i.e. nowhere near their robots).
   */
  private scene: GameScene | null = null;

  /** hand over (or clear) the live 3D scene. Idempotent and safe to call with the same scene. */
  setScene(scene: GameScene | null): void {
    this.scene = scene;
  }

  /** `GameScene.project`'s out-parameter — ONE object, rewritten per label per frame (its
   * contract is explicit that the caller owns it and it is reused). */
  private readonly projOut = { x: 0, y: 0, visible: false };

  render(
    ctx: CanvasRenderingContext2D,
    world: World,
    lastCommand: RobotCommand | null,
    localRobotId = 0,
    /**
     * BIOBUZZ 3D SEAM (Day 1, `docs/biobuzz/plan-3d.md` §4.1/§4.7): true while a live 3D
     * scene is drawing the field/robots/balls on the canvas BENEATH this one. This 2D pass
     * then stays TRANSPARENT (no backdrop fill, so the scene shows through) and skips
     * `drawField`/the robot loop/`drawBalls` — the scene owns all of that — but still draws
     * the cheap overlay below (name/team labels): it is camera-space text, not a game
     * drawing, and keeping it means a remote driver's name still reads in the 3D view.
     * False for every game/view before this seam, unchanged.
     */
    overlayOnly = false,
    /**
     * WHO IS DRIVING ROBOT `id` — `NetSession.driverName`, handed down by the GameController.
     *
     * Absent for every path that has nobody to name: solo practice, a replay, the builder
     * preview, and a match on a server that predates `matchStart.drivers`. Those all draw the
     * label they always drew. It is a FUNCTION and not a field on the world on purpose — a
     * username has no business in `World`/`RobotState`, which is deterministic JSON that ships
     * to every client 30 times a second.
     */
    driverName?: (robotId: number) => string | undefined,
  ): void {
    const canvas = ctx.canvas;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (overlayOnly) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    } else {
      ctx.fillStyle = backdropColor();
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    this.camera.apply(ctx);
    const screenUp = this.camera.screenUpWorld(); // world-space "up" for z-lift (raised beams, robot bob)
    // the active game draws its own field + overlays (DECODE: field + ramp strips)
    const mod = gameOf(world);

    if (!overlayOnly) {
      mod.drawField(ctx, world, screenUp);
      mod.drawOverlays?.(ctx, world);

      /* Held artifacts grouped in ONE pass, not re-filtered per robot. This used to be a
         `world.balls.filter(...)` inside the loop below, i.e. O(robots × balls) every frame —
         in a 2v2 Chain Reaction room that is 4 arrays and 1,200 predicate calls per frame, and
         the render loop is rAF, so on a 144 Hz display it was ~173,000 predicate calls a second
         to answer a question one pass over the balls answers. Order is preserved exactly: a
         forward pass appends in `world.balls` order, which is what `filter` returned. */
      const heldBy = new Map<number, Artifact[]>();
      for (const b of world.balls) {
        if (b.state.kind !== 'held') continue;
        const list = heldBy.get(b.state.robot);
        if (list) list.push(b);
        else heldBy.set(b.state.robot, [b]);
      }

      for (const r of world.robots) {
        // Draw auto paths if active for this robot
        if (r.autoPathActive && r.autoPath) {
          this.drawAutoPath(ctx, r);
        }

        // A DISABLED robot's intake is not running (pre-match, the auto→teleop transition, after the
        // buzzer): the sim zeroes its command and refuses every capture, so a held button or
        // auto-intake must not draw it live either.
        const intakeOn =
          robotsEnabled(world) &&
          ((r.id === localRobotId && (lastCommand?.intake ?? false)) || (r.autoIntake && r.hopper.length < 3));
        // NO_HELD is shared and never written to — every `drawRobot` treats `held` as read-only.
        const held = heldBy.get(r.id) ?? NO_HELD;
        (mod.drawRobot ?? drawRobot)(ctx, r, intakeOn, held, screenUp, world);
      }
      mod.drawBalls(ctx, world, screenUp, localRobotId);
    }

    // THE OVERLAY, THROUGH THE SCENE'S OWN CAMERA (`docs/biobuzz/plan-3d.md` §4.7). A live 3D
    // scene draws the field beneath this canvas, and the world-space pass below is laid out by
    // the TOP-DOWN camera — over a driver-station or chase shot every label lands on a part of
    // the screen that has nothing to do with its robot. `GameScene.project` is the scene's
    // answer for where a field point actually is; absent (DECODE, Chain Reaction, a scene from
    // before the hook, or a controller that has not handed the scene over) nothing changes.
    const scene = this.scene;
    if (overlayOnly && scene?.project) {
      this.drawProjectedOverlay(ctx, world, localRobotId, scene, mod, driverName);
      return;
    }

    // DRIVER labels above the OTHER robots (the local driver knows who they are). The fill is
    // the robot's ALLIANCE — since the chassis outline stopped carrying it, this label is where
    // a name and a side are read together.
    if (world.robots.length > 1) {
      for (const r of world.robots) {
        if (r.id === localRobotId) continue;
        ctx.save();
        ctx.translate(r.pos.x, r.pos.y);
        // undo the camera rotation + y-flip so the text reads upright
        ctx.rotate(-this.camera.viewAngle);
        ctx.scale(1, -1);
        ctx.font = '600 4px system-ui, sans-serif';
        ctx.textAlign = 'center';
        const label = labelFor(r, driverName);
        // a robot pinned to the far wall pushes its label off the mat onto the
        // light backdrop, so the glyphs carry a dark outline to read on both
        ctx.lineWidth = 0.7;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = LABEL_STROKE;
        ctx.strokeText(label, 0, -14);
        ctx.fillStyle = labelInk(r);
        ctx.fillText(label, 0, -14);
        ctx.restore();
      }
    }
  }

  /**
   * THE 3D OVERLAY PASS — the same two overlays the 2D path draws (name labels, an active auto
   * path), laid out in SCREEN space through `scene.project` instead of in field inches through
   * the 2D camera.
   *
   * Screen space, not a projected world transform: a perspective camera is not an affine map, so
   * there is no `ctx.setTransform` that could draw this correctly — every point has to be
   * projected on its own. The transform is therefore reset to the plain DPR scale and every
   * coordinate below is CSS pixels.
   *
   * TEXT STAYS UPRIGHT AND ONE SIZE. The 2D pass draws labels in field inches (4 in tall) so
   * they scale with the field; here a label must not shrink because a robot drove away, or the
   * far robot's name would be unreadable at exactly the moment you need to know who it is.
   */
  private drawProjectedOverlay(
    ctx: CanvasRenderingContext2D,
    world: World,
    localRobotId: number,
    scene: GameScene,
    mod: GameModule,
    driverName?: (robotId: number) => string | undefined,
  ): void {
    const project = scene.project!;
    const out = this.projOut;
    ctx.setTransform(this.camera.dpr, 0, 0, this.camera.dpr, 0, 0);

    /**
     * THE GAME'S OWN 3D OVERLAY, FIRST — under the auto paths and the labels, because those two
     * are about a ROBOT and belong on top of anything that is about the field.
     *
     * `drawSceneOverlay`, NOT `drawOverlays`: the 2D slot is written in field inches and this
     * pass is in screen pixels — see that slot's own note for the bug the distinction exists to
     * prevent. BIOBUZZ uses it for the FLOWER contents read-out, which a top-down 3D shot cannot
     * show any other way (the flower's own top plate is between the camera and the column);
     * DECODE and Chain Reaction fill it with nothing and nothing is drawn.
     *
     * `scene.camera` and not `frame.camera`: on an interactive scene the player's own camera
     * preference wins over the host's pick, so the frame is not what is on screen.
     */
    if (mod.drawSceneOverlay) {
      ctx.save();
      mod.drawSceneOverlay(ctx, world, {
        // a scene that does not report one is assumed to be showing a DRIVER shot — the answer
        // that draws the least, because an overlay placed for the wrong camera is worse than one
        // that is missing
        camera: scene.camera ?? 'driver',
        viewAngle: this.camera.viewAngle,
        dpr: this.camera.dpr,
        project: (x, y, z, o) => project.call(scene, x, y, z, o),
      });
      ctx.restore();
      ctx.setTransform(this.camera.dpr, 0, 0, this.camera.dpr, 0, 0);
    }

    // AUTO PATHS first, so a label is never drawn under one.
    for (const r of world.robots) {
      if (!r.autoPathActive || !r.autoPath) continue;
      this.drawAutoPathProjected(ctx, r, scene);
    }

    if (world.robots.length < 2) return;
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    for (const r of world.robots) {
      if (r.id === localRobotId) continue;
      project.call(scene, r.pos.x, r.pos.y, (r.z ?? 0) + bbHeightNow(world, r.spec) + LABEL_CLEARANCE, out);
      if (!out.visible) continue;
      const label = labelFor(r, driverName);
      // the same dark outline the 2D pass gives these: a 3D scene can put any brightness behind
      // a label (a white wall, the dark floor), and the outline is what makes the alliance
      // glyphs hold on both — same reasoning as the field/backdrop case the 2D pass was
      // written for.
      ctx.strokeStyle = LABEL_STROKE;
      ctx.strokeText(label, out.x, out.y - LABEL_SCREEN_LIFT);
      ctx.fillStyle = labelInk(r);
      ctx.fillText(label, out.x, out.y - LABEL_SCREEN_LIFT);
    }
  }

  /**
   * One robot's auto path, projected. Bezier segments are FLATTENED to short line segments and
   * each sample projected on its own, for the reason above: `quadraticCurveTo` in screen space
   * would draw the curve through the wrong interior points, because a projection does not
   * preserve the control polygon.
   */
  private drawAutoPathProjected(ctx: CanvasRenderingContext2D, robot: RobotState, scene: GameScene): void {
    const path = robot.autoPath!;
    const out = this.projOut;
    const alliance = robot.alliance;
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = alliance === 'red' ? 'rgba(200, 50, 50, 0.75)' : 'rgba(50, 50, 200, 0.75)';
    ctx.beginPath();
    let started = false;
    const step = (x: number, y: number): void => {
      scene.project!(x, y, 0.5, out);
      if (!out.visible) {
        started = false; // a path that leaves the frame resumes rather than drawing a chord
        return;
      }
      if (started) ctx.lineTo(out.x, out.y);
      else ctx.moveTo(out.x, out.y);
      started = true;
    };
    /** 12 samples a segment — a smooth curve at any zoom this camera reaches, and 12 projections
     * is nothing next to a frame of scene geometry. */
    const SEG = 12;
    let cur: PathPoint = path.startPoint;
    step(cur.x, cur.y);
    for (const line of path.lines) {
      const cps = line.controlPoints ?? [];
      for (let i = 1; i <= SEG; i++) {
        const t = i / SEG;
        const u = 1 - t;
        let x: number;
        let y: number;
        if (cps.length === 1) {
          x = u * u * cur.x + 2 * u * t * cps[0].x + t * t * line.endPoint.x;
          y = u * u * cur.y + 2 * u * t * cps[0].y + t * t * line.endPoint.y;
        } else if (cps.length >= 2) {
          x = u * u * u * cur.x + 3 * u * u * t * cps[0].x + 3 * u * t * t * cps[1].x + t * t * t * line.endPoint.x;
          y = u * u * u * cur.y + 3 * u * u * t * cps[0].y + 3 * u * t * t * cps[1].y + t * t * t * line.endPoint.y;
        } else {
          x = cur.x + (line.endPoint.x - cur.x) * t;
          y = cur.y + (line.endPoint.y - cur.y) * t;
        }
        step(x, y);
      }
      cur = line.endPoint;
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawAutoPath(ctx: CanvasRenderingContext2D, robot: RobotState): void {
    const autoPath = robot.autoPath!; // We already checked for existence
    const alliance = robot.alliance;

    ctx.save();
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = alliance === 'red' ? 'rgba(200, 50, 50, 0.7)' : 'rgba(50, 50, 200, 0.7)'; // Desaturated alliance color
    ctx.fillStyle = alliance === 'red' ? 'rgba(200, 50, 50, 0.5)' : 'rgba(50, 50, 200, 0.5)'; // Desaturated alliance color

    // Draw start point
    ctx.beginPath();
    ctx.arc(autoPath.startPoint.x, autoPath.startPoint.y, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Draw path lines
    let currentPoint: PathPoint = autoPath.startPoint;
    for (const line of autoPath.lines) {
      ctx.beginPath();
      ctx.moveTo(currentPoint.x, currentPoint.y);

      if (line.controlPoints && line.controlPoints.length > 0) {
        if (line.controlPoints.length === 1) {
          // Quadratic Bezier
          ctx.quadraticCurveTo(
            line.controlPoints[0].x,
            line.controlPoints[0].y,
            line.endPoint.x,
            line.endPoint.y,
          );
        } else if (line.controlPoints.length === 2) {
          // Cubic Bezier
          ctx.bezierCurveTo(
            line.controlPoints[0].x,
            line.controlPoints[0].y,
            line.controlPoints[1].x,
            line.controlPoints[1].y,
            line.endPoint.x,
            line.endPoint.y,
          );
        }
      } else {
        // Linear
        ctx.lineTo(line.endPoint.x, line.endPoint.y);
      }
      ctx.stroke();

      // Draw control points
      if (line.controlPoints) {
        ctx.fillStyle = 'rgba(180, 180, 180, 0.7)'; // Light grey for control points
        for (const cp of line.controlPoints) {
          ctx.beginPath();
          ctx.arc(cp.x, cp.y, 1, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Draw end point of segment
      ctx.beginPath();
      ctx.arc(line.endPoint.x, line.endPoint.y, 1.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      currentPoint = line.endPoint;
    }
    ctx.restore();
  }

  // private drawRobotPathState(ctx: CanvasRenderingContext2D, robot: RobotState): void {
  //   ctx.save();
  //   ctx.lineWidth = 1;
  //   ctx.strokeStyle = 'lime'; // Green for target visuals
  //   ctx.fillStyle = 'lime';
  //
  //   // // Draw target point
  //   // if (robot.pathTargetPoint) {
  //   //   ctx.beginPath();
  //   //   ctx.arc(robot.pathTargetPoint.x, robot.pathTargetPoint.y, 3, 0, Math.PI * 2);
  //   //   ctx.fill();
  //   //   ctx.stroke();
  //   //
  //   //   // Draw line from robot to target point
  //   //   ctx.beginPath();
  //   //   ctx.moveTo(robot.pos.x, robot.pos.y);
  //   //   ctx.lineTo(robot.pathTargetPoint.x, robot.pathTargetPoint.y);
  //   //   ctx.stroke();
  //   // }
  //
  //   // // Draw target heading
  //   // if (robot.pathTargetHeading !== null) {
  //   //   const arrowLength = 10;
  //   //   const arrowX = robot.pos.x + dcos(robot.pathTargetHeading) * arrowLength;
  //   //   const arrowY = robot.pos.y + dsin(robot.pathTargetHeading) * arrowLength;
  //   //
  //   //   ctx.beginPath();
  //   //   ctx.moveTo(robot.pos.x, robot.pos.y);
  //   //   ctx.lineTo(arrowX, arrowY);
  //   //   ctx.stroke();
  //   //
  //   //   // Draw arrow head
  //   //   ctx.beginPath();
  //   //   ctx.moveTo(arrowX, arrowY);
  //   //   ctx.lineTo(arrowX - dcos(robot.pathTargetHeading - Math.PI / 6) * 3, arrowY - dsin(robot.pathTargetHeading - Math.PI / 6) * 3);
  //   //   ctx.moveTo(arrowX, arrowY);
  //   //   ctx.lineTo(arrowX - dcos(robot.pathTargetHeading + Math.PI / 6) * 3, arrowY - dsin(robot.pathTargetHeading + Math.PI / 6) * 3);
  //   //   ctx.stroke();
  //   // }
  //   ctx.restore();
  // }
}