import type { Alliance, AssistConfig, RobotSpec } from '../../../types';
import { BB_HOOD_DEFAULT_DEG, bbMassLimits, bbStorageMax } from '../config';
import type { BbMechSpec } from '../mechs';
import { bbCoerceSpec } from '../robotConfig';

/**
 * BIOBUZZ AI — THE ROBOTS THE BOTS DRIVE (2026-09-22).
 *
 * Every bot used to drive `DEFAULT_SPEC` — DECODE's chassis coerced into a centre-turret
 * mecanum — so a practice match against three bots was a match against three copies of one
 * robot, and none of them could carry a NECTAR or reach a FLOWER. These are real builds off the
 * BIOBUZZ builder's own options (drivetrain, intake archetype and mount, launcher and mount, Box
 * Tube, height, gearing, weight), each one a coercer FIXED POINT (the AI lane asserts
 * `bbCoerceSpec(build) ≡ build` and that none of them is the default build), and each one a
 * robot the policy knows how to play:
 *
 *   • a TURRET scores on the move from anywhere in its envelope and never has to face the HIVE,
 *     so it gets the collector's drivetrain and intakes on both ends;
 *   • a DOUBLE TURRET or a DUMPER can carry its own NECTAR, and the ones with a BOX TUBE work the
 *     FLOWERS in the last minute (`policy.ts`, the flower plan);
 *   • a DUMPER turns the whole robot to throw, so it gets a drivetrain that turns well and its
 *     launcher on the edge its intake is on — the rear dumper the old "Hauler" card had measured
 *     25.8 against 43.0 for the front one (`docs/area/biobuzz.md`), because every cycle ended in
 *     a reverse into range.
 *
 * Every build is 14–18 in tall, inside R102's 18-in stowed cube and well under the HIVE's lowest
 * structure (30.65 in): the policy routes UNDER the HIVE between the two foot bars, which is the
 * shortest way to the cell that just came up after every TIP.
 *
 * ── WHICH BOT GETS WHICH ────────────────────────────────────────────────────
 * `bbBotBuild` is a PURE FUNCTION of `(seed, robotId)` — the tier does not pick the robot (a weak
 * driver can have a good robot, and "Hard has the good robot" would make the tiers measure the
 * builds). Two bots of one match are handed consecutive entries of a seed-rotated roster, so the
 * three bots of a solo 2v2 practice are always three different robots.
 */

/** bots drive robot-centric: most of these builds aim or collect over an edge, and the policy
 * converts either frame exactly (`command()`), so this is a preset default, not a requirement */
const BOT_ASSISTS: AssistConfig = {
  fieldCentric: false,
  aimAssist: true,
  autoIntake: true,
  autoFire: false,
};

/** one roster entry: the build, and the pounds it carries over its own mass floor */
interface Entry {
  key: string;
  label: string;
  over: number;
  spec: Omit<RobotSpec, 'name' | 'teamName' | 'teamNumber' | 'massLb' | 'ballStorage'>;
}

const turret = (mount: 'center'): BbMechSpec['launcher'] => ({ kind: 'turret', mount, hoodDeg: BB_HOOD_DEFAULT_DEG });

/**
 * THE ROSTER. Six robots, all five drivetrains, all three launchers, two intake archetypes on
 * three mounts, and two Box Tube builds — each a different answer to the same game.
 */
const ROSTER: readonly Entry[] = [
  {
    // the reference collector: a swerve turret with sweepers on both ends collects driving either
    // way and never turns round at either end of a cycle
    key: 'harvester',
    label: 'Harvester',
    over: 3,
    spec: {
      length: 15, width: 17, intake: 'sloped', drivetrain: 'swerve', driveRpm: 470,
      flywheelInertia: 0, canSort: false, heightIn: 16,
      scoreMode: 'turret', intakeMount: 'frontback', shooterMount: 'center',
      bbMech: { launcher: turret('center'), lift: null, intake: { kind: 'sweeper' } },
      assists: BOT_ASSISTS,
    },
  },
  {
    // light and quick: a mecanum turret geared up, SIDE ROLLERS on the front — the lightest
    // useful build on the list
    key: 'comet',
    label: 'Comet',
    over: 1,
    spec: {
      length: 14.5, width: 16, intake: 'sloped', drivetrain: 'mecanum', driveRpm: 540,
      flywheelInertia: 0, canSort: false, heightIn: 15,
      scoreMode: 'turret', intakeMount: 'front', shooterMount: 'center',
      bbMech: { launcher: turret('center'), lift: null, intake: { kind: 'siderollers' } },
      assists: BOT_ASSISTS,
    },
  },
  {
    // the whole game: a double turret shoots POLLEN and its own NECTAR on one beat, and the Box
    // Tube on the back puts NECTAR on the FLOWERS in the last minute
    key: 'pollinator',
    label: 'Twin Pollinator',
    over: 2,
    spec: {
      length: 15, width: 16, intake: 'sloped', drivetrain: 'xdrive', driveRpm: 520,
      flywheelInertia: 0, canSort: false, heightIn: 17,
      scoreMode: 'twinturret', intakeMount: 'front', shooterMount: 'right',
      bbMech: {
        launcher: { kind: 'twinturret', mount: 'right', mount2: 'left', hoodDeg: BB_HOOD_DEFAULT_DEG },
        lift: { kind: 'vslide', mount: 'back' },
        intake: { kind: 'sweeper' },
      },
      assists: BOT_ASSISTS,
    },
  },
  {
    // a dumper that carries NECTAR and a Box Tube: both ends sweep, the throw is over the FRONT
    // edge, and the tube sits on the back for the FLOWERS
    key: 'forager',
    label: 'Forager',
    over: 2,
    spec: {
      length: 15, width: 17, intake: 'sloped', drivetrain: 'butterfly', driveRpm: 440, tankRpm: 300,
      flywheelInertia: 0, canSort: false, heightIn: 17,
      scoreMode: 'dumper', intakeMount: 'frontback', shooterMount: 'front',
      bbMech: {
        launcher: { kind: 'dumper', mount: 'front', hoodDeg: BB_HOOD_DEFAULT_DEG },
        lift: { kind: 'vslide', mount: 'back' },
        intake: { kind: 'sweeper' },
      },
      assists: BOT_ASSISTS,
    },
  },
  {
    // the kit robot's idea done properly: tank, front sweeper, front dumper, geared for pace
    key: 'bulldozer',
    label: 'Bulldozer',
    over: 3,
    spec: {
      length: 15, width: 17, intake: 'sloped', drivetrain: 'tank', driveRpm: 420,
      flywheelInertia: 0, canSort: false, heightIn: 15,
      scoreMode: 'dumper', intakeMount: 'front', shooterMount: 'front',
      bbMech: { launcher: { kind: 'dumper', mount: 'front', hoodDeg: BB_HOOD_DEFAULT_DEG }, lift: null, intake: { kind: 'sweeper' } },
      assists: BOT_ASSISTS,
    },
  },
  {
    // sweepers on both FLANKS: a mecanum turret that collects strafing along a wall or a pile
    key: 'sidewinder',
    label: 'Sidewinder',
    over: 2,
    spec: {
      length: 15, width: 15, intake: 'sloped', drivetrain: 'mecanum', driveRpm: 480,
      flywheelInertia: 0, canSort: false, heightIn: 16,
      scoreMode: 'turret', intakeMount: 'side', shooterMount: 'center',
      bbMech: { launcher: turret('center'), lift: null, intake: { kind: 'sweeper' } },
      assists: BOT_ASSISTS,
    },
  },
];

/** the roster keys, in order — what the AI lane and the bench iterate */
export const BB_BOT_BUILD_KEYS: readonly string[] = ROSTER.map((e) => e.key);

/** one roster entry as a full, coerced spec */
export function bbBotBuildByKey(key: string, tier = 'medium'): RobotSpec {
  const e = ROSTER.find((x) => x.key === key) ?? ROSTER[0];
  return finish(e, tier);
}

function finish(e: Entry, tier: string): RobotSpec {
  const raw: RobotSpec = {
    ...e.spec,
    name: `${tier} bot`,
    teamName: `AI · ${e.label}`,
    teamNumber: 0,
    massLb: 0,
    ballStorage: 0,
  } as RobotSpec;
  raw.massLb = bbMassLimits(raw).min + e.over;
  raw.ballStorage = bbStorageMax(raw);
  // the chokepoint every robot passes through anyway; a build that is a fixed point of it comes
  // back unchanged, and the AI lane asserts that every one of these is
  return bbCoerceSpec(raw);
}

/** a small integer hash of the match seed, so adjacent seeds do not pick adjacent rosters */
function mix(seed: number): number {
  let h = (seed | 0) ^ 0x5bd1e995;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

/**
 * THE ROBOT A BOT SEAT DRIVES — deterministic in `(seed, robotId)`: the roster is rotated by the
 * seed and indexed by the seat, so every peer that seats the same bot on the same robot of the
 * same match builds the same robot, and the bots of one match are all different robots (up to
 * six seats). `alliance` is accepted for the seam's signature and does not pick anything: the
 * field is point-symmetric, so a build good for one side is good for the other.
 */
export function bbBotBuild(opts: { seed: number; robotId: number; tier: string; alliance: Alliance }): RobotSpec {
  void opts.alliance;
  const n = ROSTER.length;
  const i = (mix(opts.seed) + ((opts.robotId % n) + n)) % n;
  return finish(ROSTER[i], opts.tier);
}
