import type { RobotState, World } from '../../types';
import { SIM_DT } from '../../config';
import { robotsEnabled } from '../../sim/match';
import { BB_HOOD_DEFAULT_DEG } from './config';
import { bbIsTurreted, bbLauncherOf, bbTurretFor } from './mechs';
import { bbTurretSolution } from './robot';
import { bbAimTarget, bbCellSideOf, bbDumpShotEnters, bbFixedShotEnters, bbPretendHive, bbTurretShotEnters, type BbFlightTrace } from './play';
import { biobuzzPhysics } from './state';

/**
 * THE SHOT PATH — will the local robot's next shot go in, and what does it fly through on the way
 * (owner playtest feedback 2026-09-18, items 5 and 6).
 *
 * ── ONE PREDICTOR, TWO VIEWS ────────────────────────────────────────────────────────────────
 * The 2D map (`drawShot.ts`) and the 3D scene (`scene/renderReticle.ts`) both call THIS function
 * and draw what it leaves behind. Neither works anything out for itself. It lives OUTSIDE
 * `scene/` for a mechanical reason as well as a design one: nothing outside `scene/` may import
 * from it statically (the RENDER lane asserts that), so a predictor that lived there could never
 * have had a second reader.
 *
 * ── AND IT IS THE SIM'S OWN BALLISTICS, NOT A COPY OF THEM ──────────────────────────────────
 * The release comes from the sim's own solvers (`bbTurretSolution` + `bbTurretRelease` for a
 * turret, `bbDumpSolution` for a dumper) and the flight from `play.ts`'s `bbFlightEnters`, which
 * now records the arc it flew into a caller-owned buffer (`BbFlightTrace`). This file used to be
 * `scene/renderLanding.ts` and it carried its own copy of that integrator; its own header warned
 * that a copy which drifts is invisible on screen, because a drawn arc looks equally convincing
 * wherever it goes and a driver aims by it. There is one loop now.
 *
 * ── WHAT "MADE" MEANS, EXACTLY ──────────────────────────────────────────────────────────────
 * The predicted flight enters the HIVE CELL the robot is aiming at — `hiveAccepts`, the same
 * predicate the capture pass uses: inside that cell's opening footprint, within the opening-height
 * band, descending, and travelling inboard — **ASSUMING THAT CELL IS FULLY UP** (owner ruling,
 * 2026-09-19: "we draw it in the case that we can make the shot assuming that the hive is
 * completely up on the side that we are aiming for"). That is `bbPretendHive`, the very copy
 * stage 5b's fire gate asks, so the path and the gate are now ONE verdict with no exception: a
 * path is drawn exactly when holding fire would release.
 *
 * This REVERSES two earlier readings, both on record here so nobody re-derives them: the path
 * used to ask the REAL hive (so a cell that was down drew nothing), and for one afternoon it also
 * refused outright while the hive was mid-swing (`hive.tipping > 0`). Both made the path go dark
 * for a driver lining up on the cell that is about to come up, which is precisely when they need
 * it. What the path promises is the SHOT — range, barrel, arc, aim — not the tray's timing; a
 * shot at a cell that is down or swinging is released and misses, as it would on a real field,
 * and the HUD's cell state is what tells a driver which side is live.
 *
 * Anything else — out of range, a barrel that cannot make the arc (`reachable`), a dumper off its
 * aim heading, a dump where any one element would fall short — is NOT made, and NOTHING is drawn.
 *
 * A turret's shot is the one it would take RIGHT NOW, at its CURRENT yaw and pitch (not at its
 * solution), so a turret still slewing shows nothing until it is actually on target. A dumper's
 * is the whole hopper: the chassis has to be inside `BB_AIM_TOL` of `bbAimHeading` (stage 5b's own
 * gate — a dumper turns the whole robot and will not fire until it has) and every element has to
 * land; the arc drawn is the middle one.
 *
 * ZERO ALLOCATION PER SOLVE in the buffer that matters: `shotArc` and `TRACE` are module scope
 * and rewritten in place. (The two sim solvers allocate their own small result objects — one
 * shot's worth per frame, not one per integration step.)
 */

/** how many integration steps per stored arc point. The path is a hint, not a measurement; every
 * second tick is a smooth curve at every flight time a legal launch speed can produce. */
export const SHOT_ARC_EVERY = 2;

/** the path's fixed point budget — the four-second flight bound `bbFlightEnters` uses, divided by
 * `SHOT_ARC_EVERY`, plus room for the terminal point. */
export const SHOT_ARC_MAX = Math.ceil(4 / SIM_DT / SHOT_ARC_EVERY) + 2;

/** the path's points, `[x, y, z]` each, valid up to `SHOT.points`. A `Float32Array` because the
 * 3D renderer wraps it in a `THREE.BufferAttribute` ONCE and it must outlive every solve. */
export const shotArc = new Float32Array(SHOT_ARC_MAX * 3);

/** the trace handed to the sim — module scope, never reallocated. */
const TRACE: BbFlightTrace = { pts: shotArc, every: SHOT_ARC_EVERY, n: 0 };

export interface BbShotPath {
  /** false ⇒ DRAW NOTHING. There is no shot, or it would not go in. */
  made: boolean;
  /** how many of `shotArc`'s points are valid. */
  points: number;
}

/** the solved path — module scope, rewritten in place by every solve. */
export const SHOT: BbShotPath = { made: false, points: 0 };

/**
 * Solve THIS robot's current shot into `SHOT` / `shotArc`. `false` ⇒ the renderers draw nothing.
 *
 * ⚠️ **EVERY `return false` BELOW HAS ALREADY ZEROED `SHOT`** (the two lines at the top), so a
 * renderer that reads the module buffers after a refused solve reads an empty path and not the
 * last frame's. Both renderers additionally key on the RETURN plus `SHOT.points`, which is belt
 * and braces on a buffer that is rewritten in place.
 *
 * ── ⚠️ WHAT MAKES A SHOT IMPOSSIBLE, AND NOT ONLY WHAT MAKES IT MISS ────────
 * Owner, 2026-09-19: "the dotted lines still appear when the shot is not able to be made." A
 * ballistic verdict is not the whole question — a shot that would go in but cannot be TAKEN is
 * exactly as un-made as one that falls short. So the gate is `bbCanFire` first (a live phase, a
 * loaded hopper, a robot that is not a practice dummy) and the ballistics second, and both halves
 * are the ones the fire gate itself uses.
 *
 * This file used to say "NOT gated on the hopper: the question a driver is asking while they line
 * up is 'if I fired from here, would it go in'". That reading lost: a path over an empty hopper is
 * a promise about a shot that does not exist, and the hopper count being on the HUD is an
 * argument for the HUD, not for the path.
 */
export function solveShotPath(world: World, r: RobotState): boolean {
  SHOT.made = false;
  SHOT.points = 0;
  const bb = world.biobuzz;
  if (!bb || !bbCanFire(world, r)) return false;
  const launcher = bbLauncherOf(r.spec, BB_HOOD_DEFAULT_DEG);
  const target = bbAimTarget(world, r);
  // THE CELL BEING AIMED AT, ASSUMED FULLY UP — the fire gate's own copy (see the header).
  const hive = bbPretendHive(bb.hives[r.alliance], bbCellSideOf(target));

  if (bbIsTurreted(launcher)) {
    const top = r.hopper[r.hopper.length - 1];
    const which = bbTurretFor(launcher, top === 'red' || top === 'blue');
    const sol = bbTurretSolution(r, target, which);
    // an arc the barrel cannot make is fired anyway (honestly, and it misses) — there is no path
    // to promise for it
    if (!sol || !sol.reachable) return false;
    if (!bbTurretShotEnters(hive, r, which, sol.speed, SIM_DT, TRACE)) return false;
    SHOT.made = true;
    SHOT.points = TRACE.n;
    return true;
  }

  // A FIXED SHOOTER: the release it would make now, run forward — the fire gate's own predicate
  // (`bbFixedShotEnters`), so a path is drawn exactly where holding fire would release
  if (launcher.kind === 'fixed') {
    if (!bbFixedShotEnters(hive, r, SIM_DT, TRACE)) return false;
    SHOT.made = true;
    SHOT.points = TRACE.n;
    return true;
  }

  // A DUMPER: the 3D CATAPULT's one fling of its bucket, or the 2D pipeline's converging throws —
  // the same `cluster` switch `BbShot` carries, read off the world's own physics so the drawn arc
  // is the arc THIS match will actually fly. "Made" is every element of it landing, which is the
  // verdict stage 5b reaches; the arc drawn is the MIDDLE one.
  //
  // ⚠️ A DUMPER'S RE-ARM IS PART OF "CAN IT BE MADE" AND A TURRET'S BEAT IS NOT. `bbCanFire`
  // explains which and why.
  if (!bbDumpShotEnters(hive, r, target, Math.max(1, r.hopper.length), biobuzzPhysics(world) === '3d', SIM_DT, TRACE)) {
    return false;
  }
  SHOT.made = true;
  SHOT.points = TRACE.n;
  return true;
}

/**
 * ⚠️ **IS THERE A SHOT TO TAKE AT ALL THIS TICK** — the non-ballistic half of the fire gate,
 * exported so the drawn path and `bbLaunch` cannot disagree about it.
 *
 * · a PASSIVE practice dummy has no mechanisms (`play.ts` stage 5b skips it outright);
 * · nothing fires outside a live phase — `robotsEnabled` is false in `pre`, across the
 *   auto→teleop transition and after the buzzer, and `bbLaunch` is handed `enabled` from it.
 *   R102's stow is inside this: a stowed robot is a robot before the match started;
 * · an empty hopper fires nothing (`bbLaunch` returns on `r.hopper.length === 0`);
 * · ⚠️ a DUMPER'S RE-ARM counts and a TURRET'S BEAT does not. `bbLaunch` refuses a dump outright
 *   while `fireReadyAt` is ahead (`BB_DUMP_RELOAD_S`, 0.75 s — three quarters of a second in
 *   which a reloaded driver holding fire gets nothing), where a turret's `BB_FIRE_INTERVAL` is
 *   77 ms and a held fire simply goes on the next beat from essentially this pose. Gating the
 *   path on the turret's beat would strobe it at 13 Hz, which is a worse lie than the one it
 *   would fix.
 *
 * NOT gated on the fire BUTTON: the path is the instrument a driver lines a shot up with, and one
 * that only appeared once they were already shooting would have nothing to aim.
 */
export function bbCanFire(world: World, r: RobotState): boolean {
  if (r.passive || r.hopper.length === 0) return false;
  if (!robotsEnabled(world)) return false;
  const launcher = bbLauncherOf(r.spec, BB_HOOD_DEFAULT_DEG);
  // the DUMPER's re-arm only: a fixed shooter's feed beat is short like a turret's, and gating on
  // it would strobe the path the same way
  if (launcher.kind === 'dumper' && r.fireReadyAt > world.time) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// HOW IT IS DRAWN — shared by both renderers so the two views cannot drift apart
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The on-field accent, as a literal. Category 3 in `docs/area/ui.md`'s theming note — its ground
 * is the CANVAS, which is hardcoded dark and never themes — so this is the same value
 * `--ds-on-field-accent` carries in BOTH blocks of `shell.css`, and each renderer reads the token
 * once with this as its fallback for a detached or pre-layout document.
 */
export const SHOT_PATH_COLOR = '#5fb597';
/** the dash pattern, in FIELD INCHES, so the 2D map and the 3D scene dot the same path the same
 * way at the same scale. */
export const SHOT_DASH = 2.2;
export const SHOT_GAP = 2.6;
