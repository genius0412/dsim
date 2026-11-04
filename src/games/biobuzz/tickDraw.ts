import type { Artifact, RobotState, World } from '../../types';
import { lerpAngleShort, lerpTurret, turretPoseOf, withTurret, type TurretPose } from '../../net/turretDraw';
import { interpTrays, traySnap, type TraySnap } from './trayDraw';

/**
 * THE 3D VIEW DRAWS THE FRAME'S MOMENT, NOT THE LAST TICK (owner, 2026-11-04: "Driving in the
 * chase POV, I noticed that the turret is either jittery or it looks like it has motion blur").
 *
 * A solo match steps at 60 Hz and the 3D view draws at the display's rate. It drew `this.world`
 * as the last tick left it, so on a 144 Hz screen every robot held still for two or three frames
 * and then jumped, while the chase camera, which eases every frame, kept gliding. The turret shows
 * it worst: it holds a WORLD bearing on the hive while the chassis turns under it, so on screen it
 * slid smoothly with the camera while the chassis it sits on stepped, a sawtooth between the two
 * that reads as a double image. Measured through the real chase camera on a driving and turning
 * 3D world (RENDER lane, "turret draw:"): the turret muzzle's frame-to-frame jerk against the
 * chassis was p50 3.2 px/frame² at 1920×1080 and 144 Hz; drawn here, 0.05.
 *
 * `GameController` already hands the scene `frame.alpha`, the fixed-timestep accumulator's
 * leftover fraction, and nothing read it. This is the reader: every robot (chassis pose, z,
 * turret yaw and pitch), every loose element and both hive trays, `alpha` of the way from the
 * previous tick to the newest one. All of them, because a robot drawn a fraction of a tick away
 * from the ball it is pushing is the "same moment" bug `docs/area/netcode.md` already paid for.
 *
 * It costs up to one tick of display latency (8 ms on average), the standard price of drawing
 * between two known states rather than guessing past the newest one, which would put a robot
 * into a wall it stopped at. Drawing only: nothing here is read back by the sim, and a networked
 * match keeps its own clock (`displayWorld`).
 *
 * What it leaves on the tick: anything driven by `world.time` (wheel and roller spin, the ramp's
 * swing, the dump arm, the Box Tube's ease). Lerping the clock would put it a fraction of a tick
 * BEFORE a stamp taken on the newest tick, and `bbRampSwingProgress` reads a negative elapsed time
 * as "settled", which would flash a ramp to its far end for a frame on every toggle.
 */

interface RobotPose {
  x: number;
  y: number;
  z: number | undefined;
  heading: number;
  turret: TurretPose;
}
interface BallPose {
  x: number;
  y: number;
  z: number;
  kind: string;
}

/** the poses at the tick before the newest one. Reused across ticks: nothing is allocated per tick
 *  but the poses themselves. */
export interface TickPoses {
  world: World | null;
  tick: number;
  robots: Map<number, RobotPose>;
  balls: Map<number, BallPose>;
  hives: TraySnap | null;
}

export function newTickPoses(): TickPoses {
  return { world: null, tick: -1, robots: new Map(), balls: new Map(), hives: null };
}

/** forget the previous tick: the next draws are the newest tick as it is, until one is captured */
export function clearTickPoses(p: TickPoses): void {
  p.world = null;
  p.tick = -1;
}

/** record `w` as it stands, just before a step — the "previous tick" the next draws start from */
export function captureTick(p: TickPoses, w: World): void {
  p.world = w;
  p.tick = w.tick;
  p.robots.clear();
  for (const r of w.robots) p.robots.set(r.id, { x: r.pos.x, y: r.pos.y, z: r.z, heading: r.heading, turret: turretPoseOf(r) });
  p.balls.clear();
  for (const b of w.balls) p.balls.set(b.id, { x: b.pos.x, y: b.pos.y, z: b.z, kind: b.state.kind });
  p.hives = traySnap(w);
}

/** a robot that covered more than this between two ticks (in, rad) was placed, not driven: a reset,
 *  a restart pose, a tutorial step. It is drawn where it is. */
const TELEPORT_IN = 24;
const TELEPORT_RAD = 1;
/** carried elements (`held`, `stock`) are placed by what carries them, never lerped */
const isCarried = (kind: string): boolean => kind === 'held' || kind === 'stock';

/**
 * `w` drawn `alpha` of the way from the captured previous tick to itself. Returns `w` itself when
 * there is nothing to draw between (no previous tick for this world, a tick that is not the one
 * before `w`'s, `alpha` of 1), so a stopped clock draws exactly what the sim holds.
 */
export function drawAtAlpha(p: TickPoses, w: World, alpha: number): World {
  if (p.world !== w || p.tick !== w.tick - 1 || !(alpha < 1)) return w;
  const a = Math.max(0, alpha);
  const lerp = (x: number, y: number): number => x + (y - x) * a;
  let moved = false;
  const robots = w.robots.map((r): RobotState => {
    const q = p.robots.get(r.id);
    if (!q) return r;
    const dx = r.pos.x - q.x;
    const dy = r.pos.y - q.y;
    const dh = r.heading - q.heading;
    const t = q.turret;
    const still =
      dx === 0 && dy === 0 && dh === 0 && q.z === r.z &&
      t.yaw === r.turretHeading && t.pitch === r.bbTurretPitch && t.yaw2 === r.bbTurret2Heading && t.pitch2 === r.bbTurret2Pitch;
    if (still) return r;
    if (Math.abs(dx) + Math.abs(dy) > TELEPORT_IN || Math.abs(dh - 2 * Math.PI * Math.round(dh / (2 * Math.PI))) > TELEPORT_RAD) return r;
    moved = true;
    const drawn = withTurret(r, lerpTurret(q.turret, turretPoseOf(r), a));
    drawn.pos = { x: lerp(q.x, r.pos.x), y: lerp(q.y, r.pos.y) };
    drawn.heading = lerpAngleShort(q.heading, r.heading, a);
    if (r.z !== undefined && q.z !== undefined) drawn.z = lerp(q.z, r.z);
    return drawn;
  });
  const balls = w.balls.map((b): Artifact => {
    const q = p.balls.get(b.id);
    if (!q || isCarried(q.kind) || isCarried(b.state.kind)) return b;
    if (q.x === b.pos.x && q.y === b.pos.y && q.z === b.z) return b;
    if (Math.abs(b.pos.x - q.x) + Math.abs(b.pos.y - q.y) + Math.abs(b.z - q.z) > TELEPORT_IN) return b;
    moved = true;
    return { ...b, pos: { x: lerp(q.x, b.pos.x), y: lerp(q.y, b.pos.y) }, z: lerp(q.z, b.z) };
  });
  const biobuzz = interpTrays(w.biobuzz, p.hives, traySnap(w), a);
  if (!moved && biobuzz === w.biobuzz) return w;
  return { ...w, robots, balls, biobuzz };
}
