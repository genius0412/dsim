/**
 * BIOBUZZ'S HALF OF THE ZENITH AUTO SEAM (docs/area/autos.md). LAZY CHUNK: reached only through
 * `src/auto/games.ts`, never from the BIOBUZZ sim module, so Zenith stays out of the main chunk.
 *
 * ── THE COMMANDS DSIM RUNS ────────────────────────────────────────────────────────────────────
 * A robot repository registers these names with its Zenith runtime, and a file that uses them
 * plays here too. Each one does what the name says on DSIM's mechanisms:
 *
 * | name           | on the robot                                  | here                                          |
 * |----------------|-----------------------------------------------|-----------------------------------------------|
 * | `shootAll`     | spin up, launch `count`, settle 250 ms        | hold FIRE until `count` have left the hopper (or it is empty), then settle 250 ms; after the build's aim time it fires UNAIMED, like the robot (`bbAimWindowS`); it gives up only if even that launches nothing |
 * | `setIntake`    | set the roller(s), done the same loop         | FORWARD holds INTAKE on until a STOP; REVERSE is a STOP (DSIM has no outtake) |
 * | `launcherIdle` | flywheel to 0                                 | done at once: DSIM's flywheel has no idle state to leave |
 * | `relocalize`   | vision relocalisation                         | done at once: DSIM's belief is the truth       |
 * | `cancelAll`    | intakes off, latch closed, launcher idle      | lets go of INTAKE and FIRE (a ramp stays where it is) |
 * | `setRamp`      | NOT ON THE ROBOT: it has no ramp today        | presses the driver's RAMP button until the ramp is DEPLOYED / STOWED, then waits out the swing; a build without a `ramp` intake ends at once |
 * | `hopperFull`   | three column sensors read                     | `hopper.length >= bbHopperCap(spec)`           |
 * | `hopperEmpty`  | the column reads clear                        | `hopper.length === 0`                          |
 *
 * `setIntake`'s `side` is accepted and not modelled: every DSIM intake build runs as one intake.
 * `setRamp` is DSIM's own: the team's robot has no ramp mechanism, so its runtime would list it as
 * unregistered. It is here so a DSIM `ramp` build can practise pulling POLLEN out of a FLOWER.
 * A name the robot has and this list does not (a future command) is not refused — the seat runs
 * it as done-at-once and the auto panel lists it, so a file never stalls on an unknown name.
 *
 * Time is `world.time`, the sim's own clock — never a wall clock.
 */
import { loadSeason } from '@horizon36596/zenith-season-biobuzz';
import biobuzzField from '@horizon36596/zenith-season-biobuzz/field/biobuzz.field.json' with { type: 'json' };
import type { AutoButtons, AutoCommand, AutoHost, GameAutoAdapter } from '../../../auto/types';
import { driveParams } from '../../../sim/drivetrain';
import type { RobotSpec, RobotState, World } from '../../../types';
import { FLY_FEED_MIN_FRAC, FLY_RAMP_INERTIA_SLOW, FLY_RAMP_RPM_S, FLY_SHOT_DROP, SIM_DT, simPatchAtLeast } from '../../../config';
import { clamp, wrapAngle } from '../../../math';
import { bbAimHeading, bbFootprint, bbHopperCap, bbRampSwingProgress } from '../robot';
import { bbAimTarget } from '../play';
import { bbIntakeKindOf, bbIsTurreted, bbLauncherOf } from '../mechs';
import {
  BB_AIM_TOL,
  BB_DUMP_RELOAD_S,
  BB_FIRE_INTERVAL,
  BB_FIXED_FLY_DEFAULT,
  BB_HALF_X,
  BB_HALF_Y,
  BB_HOOD_DEFAULT_DEG,
  BB_RAMP_DEPLOY_S,
  BB_START_POSES,
  BB_TURRET_SLEW,
} from '../config';
import { bbImportMouths } from '../importMech';
import { polyBounds } from '../../../sim/imported';

/** The wait after the last launch, so the last piece has cleared before the robot drives off. */
const SHOT_SETTLE_S = 0.25;

/** What `bbShotPatienceS` allows on top of the build's own aim and beat. */
const SHOOT_PATIENCE_S = 1;

/**
 * THE EARLIEST `shootAll` FIRES UNAIMED, from its start and again after every launch: the build's
 * own aim and beat, so a wheel has spun up and a turret or chassis has had the time a full aim
 * takes. Read off the build, never typed: the aim (a turret's half slew; a chassis-aimed launcher's
 * half turn, doubled because the aim brakes onto the heading) plus the longest wait between two
 * launches it is ready for (a fixed wheel's feed and recovery, a turret's beat, a dumper's re-arm).
 * StarterBot's is 1.35 s.
 *
 * It is a floor, not the switch: `shootAll` goes unaimed only once aiming has also SETTLED
 * (`bbAimSettled` for `AIM_SETTLED_S`), because a chassis-aimed launcher making a big turn while
 * the follower holds its pose takes longer than its window. Measured 2026-10-24 (5 presets, 676
 * poses each, 2D): 27 of 1982 poses that score fired their first aimed shot after the window alone,
 * up to 3.37 s (StarterBot); with the settle rule, none fires unaimed before the aimed shot would.
 */
export function bbAimWindowS(spec: RobotSpec): number {
  return bbShotPatienceS(spec) - SHOOT_PATIENCE_S;
}

/** how long aiming must stay settled before `shootAll` fires unaimed */
const AIM_SETTLED_S = 0.25;
/** a chassis or turret turning slower than this (rad/s) has stopped aiming */
const AIM_SETTLED_RATE = 0.2;
/** past the window, aiming that never settles (a robot shoved while it aims) fires unaimed after this */
const AIM_SETTLE_CAP_S = 3;

/**
 * HAS AIM ASSIST FINISHED AIMING? Read off the world, written nowhere: a chassis-aimed launcher
 * (fixed, dumper) is within `BB_AIM_TOL` of the heading aim assist turns it to and has stopped
 * turning; a turret has stopped slewing (both axes, both turrets of a double) on a chassis that is
 * not turning. A settled aim whose shot still would not land is the "would miss" a robot fires
 * through anyway.
 */
export function bbAimSettled(world: World, r: RobotState): boolean {
  if (Math.abs(r.angVel) > AIM_SETTLED_RATE) return false;
  const want = bbAimHeading(r, bbAimTarget(world, r), !simPatchAtLeast(world, 4));
  if (want !== null) return Math.abs(wrapAngle(want - r.heading)) < BB_AIM_TOL;
  const still = (v: number | undefined): boolean => Math.abs(v ?? 0) <= AIM_SETTLED_RATE;
  return still(r.bbTurretYawVel) && still(r.bbTurretPitchVel) && still(r.bbTurret2YawVel) && still(r.bbTurret2PitchVel);
}

/**
 * HOW LONG AN UNAIMED `shootAll` WAITS FOR SOMETHING TO LEAVE THE HOPPER before it gives up: the aim
 * window plus `SHOOT_PATIENCE_S`, from the switch to unaimed and again after every launch. With the
 * would-land gate gone only the launcher itself can hold a shot back (a wheel that never reaches its
 * feed speed), and the auto must still not stand there for the rest of AUTO.
 */
export function bbShotPatienceS(spec: RobotSpec): number {
  const launcher = bbLauncherOf(spec, BB_HOOD_DEFAULT_DEG);
  const tune = spec.imported?.tune;
  let aimS: number;
  if (bbIsTurreted(launcher)) {
    const slew = tune?.turretSlew !== undefined ? (tune.turretSlew * Math.PI) / 180 : BB_TURRET_SLEW;
    aimS = slew > 0 ? Math.PI / slew : 0;
  } else {
    const turn = driveParams(spec, false).maxTurn;
    const rate = tune?.aimTurn !== undefined ? Math.min(turn, (tune.aimTurn * Math.PI) / 180) : turn;
    aimS = rate > 0 ? (2 * Math.PI) / rate : 0;
  }
  let beatS: number;
  if (launcher.kind === 'fixed') {
    const f = spec.flywheel;
    const feed = tune?.shotInterval ?? f?.feedS ?? BB_FIXED_FLY_DEFAULT.feedS;
    const rate = tune?.spinUp ?? FLY_RAMP_RPM_S * (1 - FLY_RAMP_INERTIA_SLOW * clamp(spec.flywheelInertia ?? 0, 0, 1));
    const rpm = Math.max(0, ...(f?.rpm ?? BB_FIXED_FLY_DEFAULT.rpm));
    // a launch takes FLY_SHOT_DROP of the wheel's speed, and the feeder waits for FLY_FEED_MIN_FRAC
    beatS = feed + (rate > 0 ? Math.max(0, rpm * (FLY_SHOT_DROP - (1 - FLY_FEED_MIN_FRAC))) / rate : 0);
  } else if (launcher.kind === 'dumper') {
    beatS = tune?.reload ?? BB_DUMP_RELOAD_S;
  } else {
    beatS = tune?.shotInterval ?? BB_FIRE_INTERVAL;
  }
  return SHOOT_PATIENCE_S + aimS + beatS;
}

/**
 * `setRamp` gives up after this long without the ramp reaching the state it asked for, so a press
 * the sim never takes (a phase that ignores the driver) cannot stall the auto. A normal run takes
 * one tick to register the press plus the `BB_RAMP_DEPLOY_S` swing; a press held through the
 * toggle's debounce adds `TOGGLE_DEBOUNCE_S` at most.
 */
const RAMP_GIVE_UP_S = 1;

/**
 * The reason the autonomous panel shows when a build without a ramp runs `setRamp`. Short, and
 * without "it ends at once": the panel appends that.
 */
const NO_RAMP = 'this build has no ramp. Choose the “Deployable ramp” intake to use it.';

export const BIOBUZZ_AUTO_COMMANDS = ['shootAll', 'setIntake', 'launcherIdle', 'relocalize', 'cancelAll', 'setRamp'] as const;
export const BIOBUZZ_AUTO_CONDITIONS = ['hopperFull', 'hopperEmpty'] as const;

const SIM = (what: string): string => `SET FROM SIM: DSIM ${what}, derived from this build by src/games/biobuzz/auto`;

/** A `{ value, provenance }` number, rounded to Zenith's canonical four decimals. */
const valued = (value: number, provenance: string): { value: number; provenance: string } => ({
  value: Math.round(value * 1e4) / 1e4,
  provenance,
});

/**
 * THE ZENITH ROBOT FILE FOR A DSIM BUILD. Every number is read off the spec through the same
 * functions the sim drives with, so Zenith's estimate and its preview describe the robot DSIM
 * will actually drive, and every one says so (`SET FROM SIM`). The follower runs on Pedro v3's
 * default gains except the heading gain, which is raised to 3 for DSIM: at Pedro's 1.5 the P-only
 * heading loop lags a 90° turn by about 15°, past the AUTO smoke lane's bound, and at 3 it holds
 * with room to spare. The brake model is left to Zenith's default, stopping at the robot file's
 * deceleration, which for DSIM is the drivetrain's own `accel`.
 */
/** Can this build strafe? The spec's own drive mode (a butterfly starts in mecanum). */
export function bbHolonomic(spec: RobotSpec): boolean {
  const dp = driveParams(spec, false);
  return dp.saturation !== 'tank' && dp.strafeMult !== 0;
}

export function biobuzzZenithRobot(spec: RobotSpec): unknown {
  const dp = driveParams(spec, false);
  const tank = !bbHolonomic(spec);
  // ⚠️ A TANK IN A MECANUM-ONLY FILE. Zenith's robot schema has no drivetrain kind, so there is no
  // honest "cannot strafe" to write. It used to say 1 in/s, which priced every leg the file
  // draws sideways (a constant-heading sweep) at a crawl: StarterBot's garden-cycle estimated
  // 155 s and TIME_BUDGET fired. DSIM drives a tank's legs nose- or tail-first (`load.ts`
  // `tankHeadings`), so the sideways cap it states is the FORWARD one: a leg costs what it
  // costs nose-first. What Zenith still cannot see is the turn into each leg at a corner.
  const strafe = tank ? dp.maxSpeed : dp.maxSpeed * dp.strafeMult;
  const mountRaw = (spec as { intakeMount?: string }).intakeMount ?? 'front';
  const hasRamp = bbIntakeKindOf(spec) === 'ramp';
  // THE FOOTPRINT IS THE COLLIDER'S, intake reach included (`bbFootprint`, the same extents the
  // chassis collider, the start rules and the pollen solids read), not the bare chassis: a plan
  // against the chassis alone parks the intake bar 3 in inside a wall.
  const fp = bbFootprint(spec);
  const mouthDepth = 4;
  const mouth = (id: string, side: 'FRONT' | 'BACK' | 'LEFT' | 'RIGHT') => {
    const along = side === 'FRONT' || side === 'BACK';
    const edge = side === 'FRONT' ? fp.front : side === 'BACK' ? fp.rear : fp.half;
    const sign = side === 'FRONT' || side === 'LEFT' ? 1 : -1;
    const offset = sign * Math.max(0, edge - mouthDepth / 2);
    return {
      id,
      side,
      offsetIn: along ? { xIn: offset, yIn: 0 } : { xIn: 0, yIn: offset },
      widthIn: Math.max(1, (along ? 2 * fp.half : fp.front + fp.rear) - 2),
      depthIn: mouthDepth,
      provenance: SIM(`intake mount "${mountRaw}", the mouth inside the intake's outer edge`),
    };
  };
  const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;
  /**
   * AN IMPORTED ROBOT: the footprint is its HULL's box, where it is (the origin, which is where
   * DSIM turns, is the wheelbase centre and need not be the box's middle on either axis), and the
   * mouths are the ones the sim resolves on the hull (`bbImportMouths`: the placed span, off-centre
   * when it was placed so, out to where the hull ends) rather than the whole edge of a symmetric box.
   */
  const imp = spec.imported;
  const hb = imp ? polyBounds(imp.hull) : null;
  const mouths = imp
    ? bbImportMouths(spec).map((m) => {
        const u = m.uOut - mouthDepth / 2;
        const side = m.edge === 'front' ? 'FRONT' : m.edge === 'back' ? 'BACK' : m.edge === 'left' ? 'LEFT' : 'RIGHT';
        return {
          id: m.edge,
          side,
          offsetIn: { xIn: r4(m.n.x * u + m.p.x * m.vc), yIn: r4(m.n.y * u + m.p.y * m.vc) },
          widthIn: r4(Math.max(1, 2 * m.half)),
          depthIn: mouthDepth,
          provenance: SIM(`imported robot: the intake placed on the CAD (mount "${mountRaw}"), the mouth inside its roller line`),
        };
      })
    : mountRaw === 'frontback'
      ? [mouth('front', 'FRONT'), mouth('back', 'BACK')]
      : mountRaw === 'back'
        ? [mouth('back', 'BACK')]
        : mountRaw === 'side'
          ? [mouth('left', 'LEFT')]
          : [mouth('front', 'FRONT')];
  const box = hb
    ? { lengthIn: r4(hb.maxX - hb.minX), widthIn: r4(hb.maxY - hb.minY), provenance: SIM('imported robot: the bounding box of its CAD footprint hull') }
    : {
        lengthIn: Math.round((fp.front + fp.rear) * 1e4) / 1e4,
        widthIn: Math.round(2 * fp.half * 1e4) / 1e4,
        provenance: SIM('chassis plus intake reach (bbFootprint)'),
      };
  const rotation = hb
    ? { xIn: r4(-(hb.maxX + hb.minX) / 2), yIn: r4(-(hb.maxY + hb.minY) / 2), provenance: SIM('imported robot: its wheelbase centre inside the hull box') }
    : { xIn: Math.round(((fp.rear - fp.front) / 2) * 1e4) / 1e4, yIn: 0, provenance: SIM('chassis centre inside the footprint') };
  return {
    formatVersion: 1,
    name: spec.name?.trim() ? spec.name.trim().slice(0, 60) : 'DSIM robot',
    frame: { forward: '+x', left: '+y', headingZero: '+x', headingPositive: 'ccw' },
    footprint: {
      startIn: box,
      expandedIn: box,
      // the chassis centre, which is where DSIM turns, sits (rear - front) / 2 along the box (an
      // import's origin is wherever its wheelbase centre is inside the hull's box)
      centreOfRotationIn: rotation,
    },
    kinematics: {
      maxForwardVelInPerS: valued(dp.maxSpeed, SIM('top speed (driveParams.maxSpeed)')),
      maxStrafeVelInPerS: valued(
        strafe,
        tank
          ? SIM('tank: cannot strafe; DSIM drives every leg nose- or tail-first, so the sideways cap is the forward top speed (Zenith has no differential drivetrain)')
          : SIM('strafe speed (maxSpeed x strafeMult)'),
      ),
      forwardDecelInPerS2: valued(dp.accel, SIM('drive acceleration (driveParams.accel); DSIM brakes as hard as it accelerates')),
      strafeDecelInPerS2: valued(dp.accel, SIM('drive acceleration (driveParams.accel)')),
      accelInPerS2: valued(dp.accel, SIM('drive acceleration (driveParams.accel)')),
      maxAngularVelRadPerS: valued(dp.maxTurn, SIM('turn rate (driveParams.maxTurn)')),
      defaultPathSpeedFraction: valued(0.8, 'SET BY HAND: DSIM default path speed, below full so a path has headroom to correct'),
      settleS: valued(0.25, 'SET BY HAND: Zenith planner default'),
      // a tank never drives a leg sideways in DSIM, so the mecanum strafe-cost warning is off for it
      strafeFractionWarn: tank
        ? valued(1, SIM('tank: legs are driven nose- or tail-first, so the sideways-driving warning does not apply'))
        : valued(0.2, 'SET BY HAND: Zenith planner default warning threshold'),
      sweepSpeedFraction: valued(0.4, 'SET BY HAND: Zenith planner default for constant-heading sweep legs'),
      follower: {
        library: 'pedro',
        version: '3.0.0-20260828.185437-17',
        holdEnd: true,
        headingPowerPerRad: valued(3, SIM('heading gain, tuned in the AUTO smoke lane (Pedro v3 default 1.5 lags a 90° turn by 15°)')),
      },
    },
    mouths,
    capacity: { elementKind: 'pollen', max: bbHopperCap(spec), provenance: SIM('hopper capacity (bbHopperCap)') },
    commands: [
      {
        name: 'shootAll',
        summary: 'Shoot pollen from the hopper. count: how many (1 to 4). cadence only matters on the real robot.',
        params: {
          count: { type: 'integer', min: 1, max: 4 },
          cadence: { type: 'enum', values: ['rapid', 'precise'], default: 'precise' },
        },
        estimateS: '0.35 + count * 0.08',
        requires: ['launcher'],
        stationary: true,
        ledger: { launches: 'count' },
      },
      {
        name: 'setIntake',
        summary: 'Turn the intake on or off. state: FORWARD is on, STOP is off. side: FRONT, BACK or BOTH (DSIM runs them together).',
        params: {
          side: { type: 'enum', values: ['FRONT', 'BACK', 'BOTH'], default: 'BOTH' },
          state: { type: 'enum', values: ['STOP', 'FORWARD', 'REVERSE'], default: 'STOP' },
        },
        estimateS: '0',
        requires: ['intake'],
        stationary: false,
      },
      { name: 'launcherIdle', summary: 'Spin the shooter down. Instant in DSIM.', estimateS: '0', requires: ['launcher'], stationary: false },
      { name: 'relocalize', summary: 'Re-check the robot’s position with the camera. Instant in DSIM.', estimateS: '0', stationary: false },
      { name: 'cancelAll', summary: 'Stop everything: intake off, stop shooting.', estimateS: '0', requires: ['intake', 'launcher'], stationary: false },
      {
        // DSIM ONLY: the team's robot has no ramp. `requires` names the ramp, not the intake, so
        // Zenith's intake checks do not read DEPLOY as a roller state.
        name: 'setRamp',
        summary: hasRamp
          ? 'Deploy or stow the ramp intake, for pulling pollen out of a flower. state: DEPLOY or STOW. Ends once the ramp has swung. DSIM only: the team robot has no ramp.'
          : 'Deploy or stow the ramp intake. This build has no ramp (nor does the team robot), so it ends at once.',
        params: {
          state: { type: 'enum', values: ['DEPLOY', 'STOW'], default: 'DEPLOY' },
        },
        estimateS: hasRamp ? String(BB_RAMP_DEPLOY_S) : '0',
        requires: ['ramp'],
        stationary: false,
      },
    ],
    conditions: [
      { name: 'hopperFull', summary: 'True when the hopper is full.', ledger: 'full' },
      { name: 'hopperEmpty', summary: 'True when the hopper is empty.', ledger: 'empty' },
    ],
  };
}

const robotOf = (world: World, id: number): RobotState | undefined => world.robots.find((r) => r.id === id);

/** One seat's mechanisms. All state is this object's; nothing is written to the world. */
class BiobuzzAutoHost implements AutoHost {
  private intakeOn = false;
  /** shootAll commands running now (a parallel group could hold two) */
  private firing = 0;
  /** setRamp commands holding the RAMP button now */
  private rampPress = 0;
  /** shootAll commands that gave up with nothing leaving the hopper (`AutoHost.cantShootCount`) */
  private gaveUp = 0;
  /** shootAll commands firing unaimed now, and how many have switched so far (`unaimedCount`) */
  private firingUnaimed = 0;
  private wentUnaimed = 0;

  constructor(
    public world: World,
    private readonly robotId: number,
  ) {}

  private held(): number {
    return robotOf(this.world, this.robotId)?.hopper.length ?? 0;
  }

  command(name: string, args: Readonly<Record<string, string | number | boolean>>): AutoCommand | null {
    switch (name) {
      case 'shootAll':
        return this.shootAll(typeof args.count === 'number' ? args.count : 4);
      case 'setIntake': {
        const on = args.state === 'FORWARD';
        return this.instant(() => {
          this.intakeOn = on;
        });
      }
      case 'cancelAll':
        return this.instant(() => {
          this.intakeOn = false;
          this.firing = 0;
          this.firingUnaimed = 0;
          this.rampPress = 0;
        });
      case 'setRamp':
        return this.setRamp(args.state !== 'STOW');
      case 'launcherIdle':
      case 'relocalize':
        return this.instant(() => {});
      default:
        // not run here: done at once, so the file carries on (the panel lists the name)
        return this.instant(() => {});
    }
  }

  private instant(run: () => void): AutoCommand {
    return { initialize: run, execute() {}, isFinished: () => true, end() {} };
  }

  /**
   * FIRE held until `count` have left the hopper (or it is empty), then the settle. Aim assist
   * aims and gates the release for the build's aim window (`bbAimWindowS`, restarted by every
   * launch); past it the shot is released UNAIMED (`bbFireUnaimed`), as the team's robot would,
   * and the seat says so (`unaimedCount`). If even then nothing leaves for `bbShotPatienceS`, it
   * lets go and ends at once (`cantShootCount`): the auto must not stand there for the rest of AUTO.
   */
  private shootAll(count: number): AutoCommand {
    let startHeld = 0;
    let want = 0;
    let settleFrom: number | null = null;
    let holding = false;
    let unaimed = false;
    let quit = false;
    let lastHeld = 0;
    let waitFrom = 0;
    let aimWindow = 0;
    let patience = 0;
    /** consecutive ticks aiming has been settled (`bbAimSettled`) */
    let settledTicks = 0;
    const release = (): void => {
      if (holding) {
        holding = false;
        this.firing = Math.max(0, this.firing - 1);
      }
      if (unaimed) {
        unaimed = false;
        this.firingUnaimed = Math.max(0, this.firingUnaimed - 1);
      }
    };
    return {
      initialize: () => {
        startHeld = this.held();
        lastHeld = startHeld;
        waitFrom = this.world.time;
        const r = robotOf(this.world, this.robotId);
        aimWindow = r ? bbAimWindowS(r.spec) : 0;
        patience = r ? bbShotPatienceS(r.spec) : 0;
        want = Math.max(0, Math.min(Math.round(count), startHeld));
        settleFrom = want === 0 ? this.world.time : null;
        holding = want > 0;
        if (holding) this.firing += 1;
      },
      execute: () => {
        if (settleFrom !== null || quit) return;
        const held = this.held();
        const launched = startHeld - held;
        if (launched >= want || held === 0) {
          release();
          settleFrom = this.world.time;
          return;
        }
        // a launch restarts the wait; an intake adding one does not
        if (held < lastHeld) waitFrom = this.world.time;
        lastHeld = held;
        const waited = this.world.time - waitFrom;
        const r = robotOf(this.world, this.robotId);
        settledTicks = r && bbAimSettled(this.world, r) ? settledTicks + 1 : 0;
        const settled = settledTicks * SIM_DT >= AIM_SETTLED_S - 1e-9 || waited >= aimWindow + AIM_SETTLE_CAP_S - 1e-9;
        if (!unaimed && waited >= aimWindow - 1e-9 && settled) {
          // aim assist had its time and the shot still would not land: fire as the robot would
          unaimed = true;
          this.firingUnaimed += 1;
          this.wentUnaimed += 1;
          waitFrom = this.world.time;
        } else if (unaimed && waited >= patience - 1e-9) {
          release();
          quit = true;
          this.gaveUp += 1;
        }
      },
      isFinished: () => quit || (settleFrom !== null && this.world.time - settleFrom >= SHOT_SETTLE_S - 1e-9),
      end: () => release(),
    };
  }

  /**
   * THE DRIVER'S RAMP BUTTON. `RobotCommand.bbRamp` is an edge-triggered TOGGLE (`bbRampStep`),
   * so this presses it only when the ramp is not already where the file wants it, holds it until
   * the sim flips `bbRampOut` (one tick, or the debounce if a previous press has only just let
   * go), lets go, and finishes once the swing has settled (`bbRampSwingProgress` null), which is
   * when the ramp's reach counts for a FLOWER. If the sim's swing guard reverses the swing (the
   * ramp would have hit a static), it ends where the sim left it rather than pressing again. A
   * build without a `ramp` intake ends at once: `bbRampStep` would ignore the button anyway, and
   * the panel lists the command as not on this robot.
   */
  private setRamp(deploy: boolean): AutoCommand {
    let done = false;
    let holding = false;
    let startedAt = 0;
    const release = (): void => {
      if (holding) {
        holding = false;
        this.rampPress = Math.max(0, this.rampPress - 1);
      }
    };
    const out = (r: RobotState): boolean => r.bbRampOut ?? false;
    return {
      initialize: () => {
        startedAt = this.world.time;
        const r = robotOf(this.world, this.robotId);
        if (!r || bbIntakeKindOf(r.spec) !== 'ramp') {
          done = true;
          return;
        }
        if (out(r) !== deploy) {
          holding = true;
          this.rampPress += 1;
        } else if (bbRampSwingProgress(r, this.world.time) === null) done = true;
      },
      execute: () => {
        if (done) return;
        const r = robotOf(this.world, this.robotId);
        if (!r || this.world.time - startedAt > RAMP_GIVE_UP_S) {
          release();
          done = true;
          return;
        }
        if (holding) {
          if (out(r) === deploy) release();
          return;
        }
        if (bbRampSwingProgress(r, this.world.time) === null) done = true;
      },
      isFinished: () => done,
      end: () => release(),
    };
  }

  condition(name: string): boolean | null {
    const r = robotOf(this.world, this.robotId);
    if (!r) return null;
    if (name === 'hopperFull') return r.hopper.length >= bbHopperCap(r.spec);
    if (name === 'hopperEmpty') return r.hopper.length === 0;
    return null;
  }

  buttons(): AutoButtons {
    return {
      intake: this.intakeOn,
      fire: this.firing > 0,
      bbRamp: this.rampPress > 0,
      ...(this.firingUnaimed > 0 ? { bbFireUnaimed: true } : {}),
    };
  }

  cantShootCount(): number {
    return this.gaveUp;
  }

  unaimedCount(): number {
    return this.wentUnaimed;
  }

  release(): void {
    this.intakeOn = false;
    this.firing = 0;
    this.firingUnaimed = 0;
    this.rampPress = 0;
  }
}

/**
 * THE FIELD ZENITH PLANS ON, WITH DSIM'S WALLS. Zenith's BIOBUZZ field file declares the manual's
 * nominal 144 in square (walls at ±72); DSIM's field is FIRST's CAD, whose inner wall faces sit at
 * ±70.674 (`BB_HALF_X`, `fieldDims.gen.ts`). Planned against 72, a footprint 1.3 in past DSIM's
 * wall reads as legal in Zenith and then wedges the robot here, so the copy DSIM hands Zenith
 * declares the walls DSIM simulates.
 *
 * The positions in it move with the walls. Zenith draws its full-bleed field picture over `sizeIn`,
 * so shrinking only `sizeIn` shrank the picture and left every obstacle, zone and element at its
 * 144 in place: the loading zones and the garden pollen sat 1.3 in outside the drawn wall and the
 * HIVE frame drifted off its art. Scaling each plan-view POSITION by DSIM's wall over Zenith's puts
 * them back on the picture and inside DSIM's walls (FIRST's CAD tiles are 23.528 in, the manual's
 * 24, the same ratio to within 0.1 in at the wall). SIZES stay as written: a flower's hole or a
 * pollen's radius is the object's, not the field's. Heights, targets and rules are untouched.
 */
const TO_DSIM_X = BB_HALF_X / (biobuzzField.sizeIn.xIn / 2);
const TO_DSIM_Y = BB_HALF_Y / (biobuzzField.sizeIn.yIn / 2);
const toDsim = (v: number, k: number): number => Math.round(v * k * 1e4) / 1e4;

/**
 * The keys of an obstacle, zone or element that hold a POINT rather than a number: a HIVE's
 * `pivotIn`, and a strut's two end centres (field format 3: `fromIn`, `toIn`, each
 * `{ xIn, yIn, zIn }`). Each is moved like the item itself; its `zIn` is a height and stays, as
 * does the strut's `radiusIn`. A point key Zenith adds later and this list lacks is the bug the
 * AUTO lane's "every position moved" check exists for.
 */
const POINT_KEYS = ['pivotIn', 'fromIn', 'toIn'] as const;

/** One obstacle, zone or element with its plan-view position keys moved into DSIM's frame. */
function inDsimFrame<T extends object>(item: T): T {
  const out = { ...item } as Record<string, unknown>;
  for (const key of ['xIn', 'minXIn', 'maxXIn']) if (typeof out[key] === 'number') out[key] = toDsim(out[key], TO_DSIM_X);
  for (const key of ['yIn', 'minYIn', 'maxYIn']) if (typeof out[key] === 'number') out[key] = toDsim(out[key], TO_DSIM_Y);
  for (const key of POINT_KEYS) if (typeof out[key] === 'object' && out[key] !== null) out[key] = inDsimFrame(out[key]);
  return out as T;
}

const DSIM_FIELD = {
  ...biobuzzField,
  sizeIn: { xIn: toDsim(BB_HALF_X * 2, 1), yIn: toDsim(BB_HALF_Y * 2, 1) },
  obstacles: biobuzzField.obstacles.map(inDsimFrame),
  zones: biobuzzField.zones.map(inDsimFrame),
  elements: biobuzzField.elements.map(inDsimFrame),
};

export const BIOBUZZ_AUTO: GameAutoAdapter = {
  commands: BIOBUZZ_AUTO_COMMANDS,
  conditions: BIOBUZZ_AUTO_CONDITIONS,
  field: () => DSIM_FIELD,
  // BIOBUZZ's own rules, derived from the field DSIM hands over (so from DSIM's walls)
  rules: (field) => loadSeason(field),
  robot: biobuzzZenithRobot,
  holonomic: bbHolonomic,
  notOnRobot: (spec): Record<string, string> => (bbIntakeKindOf(spec) === 'ramp' ? {} : { setRamp: NO_RAMP }),
  createHost: (world, robotId) => new BiobuzzAutoHost(world, robotId),
  // BIOBUZZ's canonical frame is BLUE's, and RED is its point mirror (`bbMirror`), which is its
  // own inverse: a RED world pose mirrors back to the canonical one.
  canonicalStart: (pose, alliance) => {
    const p = alliance === 'red' ? { x: -pose.x, y: -pose.y, h: pose.heading + Math.PI } : { x: pose.x, y: pose.y, h: pose.heading };
    let deg = ((p.h * 180) / Math.PI) % 360;
    if (deg < 0) deg += 360;
    return { x: p.x, y: p.y, headingDeg: deg };
  },
  // anchors 0 (TOP) and 1 (BOTTOM) are the pair a 2-robot alliance spreads onto, 123 in apart;
  // both they and the pose are canonical, so no mirror is needed to compare them (squared
  // distances: `npm test` keeps engine-defined Math such as `hypot` out of game code)
  defaultStartNear: (pose) => {
    const d = (i: number): number => (BB_START_POSES[i].pos.x - pose.x) ** 2 + (BB_START_POSES[i].pos.y - pose.y) ** 2;
    return d(1) < d(0) ? 1 : 0;
  },
};
