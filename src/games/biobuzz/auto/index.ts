/**
 * BIOBUZZ'S HALF OF THE ZENITH AUTO SEAM (docs/area/autos.md). LAZY CHUNK: reached only through
 * `src/auto/games.ts`, never from the BIOBUZZ sim module, so Zenith stays out of the main chunk.
 *
 * ── THE COMMANDS DSIM RUNS ────────────────────────────────────────────────────────────────────
 * A robot repository registers these names with its Zenith runtime, and a file that uses them
 * plays here too. Each one does what the name says on DSIM's mechanisms:
 *
 * | name           | here                                                                          |
 * |----------------|-------------------------------------------------------------------------------|
 * | `shootAll`     | hold FIRE until `count` have left the hopper (or it is empty), then settle 250 ms |
 * | `setIntake`    | FORWARD holds INTAKE on until a STOP; REVERSE is a STOP (DSIM has no outtake) |
 * | `launcherIdle` | done at once: DSIM's flywheel has no idle state to leave                      |
 * | `relocalize`   | done at once: DSIM's belief is the truth                                      |
 * | `cancelAll`    | lets go of INTAKE and FIRE                                                    |
 * | `hopperFull`   | `hopper.length >= bbHopperCap(spec)`                                          |
 * | `hopperEmpty`  | `hopper.length === 0`                                                         |
 *
 * `setIntake`'s `side` is accepted and not modelled: every DSIM intake build runs as one intake.
 * A name this list does not have (a future command) is not refused — the seat runs it as
 * done-at-once and the auto panel lists it, so a file never stalls on an unknown name.
 *
 * Time is `world.time`, the sim's own clock — never a wall clock.
 */
import { loadSeason } from '@horizon36596/zenith-season-biobuzz';
import biobuzzField from '@horizon36596/zenith-season-biobuzz/field/biobuzz.field.json' with { type: 'json' };
import type { AutoButtons, AutoCommand, AutoHost, GameAutoAdapter } from '../../../auto/types';
import { driveParams } from '../../../sim/drivetrain';
import type { RobotSpec, RobotState, World } from '../../../types';
import { bbFootprint, bbHopperCap } from '../robot';
import { BB_HALF_X, BB_HALF_Y } from '../config';

/** The wait after the last launch, so the last piece has cleared before the robot drives off. */
const SHOT_SETTLE_S = 0.25;

export const BIOBUZZ_AUTO_COMMANDS = ['shootAll', 'setIntake', 'launcherIdle', 'relocalize', 'cancelAll'] as const;
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
export function biobuzzZenithRobot(spec: RobotSpec): unknown {
  const dp = driveParams(spec, false);
  const tank = dp.saturation === 'tank' || dp.strafeMult === 0;
  const strafe = tank ? 1 : dp.maxSpeed * dp.strafeMult;
  const mountRaw = (spec as { intakeMount?: string }).intakeMount ?? 'front';
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
  const mouths =
    mountRaw === 'frontback'
      ? [mouth('front', 'FRONT'), mouth('back', 'BACK')]
      : mountRaw === 'back'
        ? [mouth('back', 'BACK')]
        : mountRaw === 'side'
          ? [mouth('left', 'LEFT')]
          : [mouth('front', 'FRONT')];
  const box = {
    lengthIn: Math.round((fp.front + fp.rear) * 1e4) / 1e4,
    widthIn: Math.round(2 * fp.half * 1e4) / 1e4,
    provenance: SIM('chassis plus intake reach (bbFootprint)'),
  };
  return {
    formatVersion: 1,
    name: spec.name?.trim() ? spec.name.trim().slice(0, 60) : 'DSIM robot',
    frame: { forward: '+x', left: '+y', headingZero: '+x', headingPositive: 'ccw' },
    footprint: {
      startIn: box,
      expandedIn: box,
      // the chassis centre, which is where DSIM turns, sits (rear - front) / 2 along the box
      centreOfRotationIn: { xIn: Math.round(((fp.rear - fp.front) / 2) * 1e4) / 1e4, yIn: 0, provenance: SIM('chassis centre inside the footprint') },
    },
    kinematics: {
      maxForwardVelInPerS: valued(dp.maxSpeed, SIM('top speed (driveParams.maxSpeed)')),
      maxStrafeVelInPerS: valued(strafe, tank ? SIM('tank: cannot strafe, 1 in/s stands in for zero') : SIM('strafe speed (maxSpeed x strafeMult)')),
      forwardDecelInPerS2: valued(dp.accel, SIM('drive acceleration (driveParams.accel); DSIM brakes as hard as it accelerates')),
      strafeDecelInPerS2: valued(dp.accel, SIM('drive acceleration (driveParams.accel)')),
      accelInPerS2: valued(dp.accel, SIM('drive acceleration (driveParams.accel)')),
      maxAngularVelRadPerS: valued(dp.maxTurn, SIM('turn rate (driveParams.maxTurn)')),
      defaultPathSpeedFraction: valued(0.8, 'SET BY HAND: DSIM default path speed, below full so a path has headroom to correct'),
      settleS: valued(0.25, 'SET BY HAND: Zenith planner default'),
      strafeFractionWarn: valued(0.2, 'SET BY HAND: Zenith planner default warning threshold'),
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
        });
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

  private shootAll(count: number): AutoCommand {
    let startHeld = 0;
    let want = 0;
    let settleFrom: number | null = null;
    let holding = false;
    const release = (): void => {
      if (holding) {
        holding = false;
        this.firing = Math.max(0, this.firing - 1);
      }
    };
    return {
      initialize: () => {
        startHeld = this.held();
        want = Math.max(0, Math.min(Math.round(count), startHeld));
        settleFrom = want === 0 ? this.world.time : null;
        holding = want > 0;
        if (holding) this.firing += 1;
      },
      execute: () => {
        if (settleFrom !== null) return;
        const launched = startHeld - this.held();
        if (launched >= want || this.held() === 0) {
          release();
          settleFrom = this.world.time;
        }
      },
      isFinished: () => settleFrom !== null && this.world.time - settleFrom >= SHOT_SETTLE_S - 1e-9,
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
    return { intake: this.intakeOn, fire: this.firing > 0 };
  }

  release(): void {
    this.intakeOn = false;
    this.firing = 0;
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

/** One obstacle, zone or element with its plan-view position keys moved into DSIM's frame. */
function inDsimFrame<T extends object>(item: T): T {
  const out = { ...item } as Record<string, unknown>;
  for (const key of ['xIn', 'minXIn', 'maxXIn']) if (typeof out[key] === 'number') out[key] = toDsim(out[key], TO_DSIM_X);
  for (const key of ['yIn', 'minYIn', 'maxYIn']) if (typeof out[key] === 'number') out[key] = toDsim(out[key], TO_DSIM_Y);
  if (typeof out.pivotIn === 'object' && out.pivotIn !== null) out.pivotIn = inDsimFrame(out.pivotIn);
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
  createHost: (world, robotId) => new BiobuzzAutoHost(world, robotId),
  // BIOBUZZ's canonical frame is BLUE's, and RED is its point mirror (`bbMirror`), which is its
  // own inverse: a RED world pose mirrors back to the canonical one.
  canonicalStart: (pose, alliance) => {
    const p = alliance === 'red' ? { x: -pose.x, y: -pose.y, h: pose.heading + Math.PI } : { x: pose.x, y: pose.y, h: pose.heading };
    let deg = ((p.h * 180) / Math.PI) % 360;
    if (deg < 0) deg += 360;
    return { x: p.x, y: p.y, headingDeg: deg };
  },
};
